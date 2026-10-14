/* ============================================================
 * src/doc-import.js —— 大文档 → 新项目树的**转换前端**（功能 5a）
 * ------------------------------------------------------------
 * 设计：**一个建树入口，三种前端**。md / txt / docx 都先变成"带 `#` 的 Markdown 提纲"，
 * 再统一交给 `src/markdown.js` 的 `markdownToTree` 建树 —— 只有一套树构建逻辑，
 * 不会出现"txt 导入的树和 md 导入的树结构规则不一样"这种漂移 ✓
 *
 * ⚠️ **本文件不许出现异步 API**：它挂在 CLI 命令的依赖闭包里，而
 * `tests/cli-sync-invariant.test.js` 要求 CLI 命令同步完成（`cli/main.js` 的 invokeSync 依赖它）。
 *
 * docx 为什么自己解（不引依赖）：本工程**零必需运行时依赖**（唯一例外：PDF 解析用的 `pdfjs-dist`）
 * 是硬约束（见 RULES / 08 的 D1）。
 * docx 就是一个 zip + 一份 `word/document.xml`：zip 的 deflate 用 node 自带的 zlib 就能解 ✓
 * ⇒ 大约 100 行换掉一个依赖，划算；且**边界要写明**（见 §docx 注释）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
// 整库导入（`import-dir`）要"文件 → 提纲 → 子树"，而**建树只有一处实现**（`markdown.js`）——
// 本文件只做目录走查与容器拼装，绝不另写一套解析/建树 ✗（依赖方向 src → src，无环 ✓）
const markdown = require('./markdown.js');
const convert = require('./convert.js');
// 绑定（R4）的**取值表与身份判据**只从 `src/schema.js` 取（那是唯一的校验处）——
// 本文件不许再写一份 'propose-only' / 800 这类字面量（第二份必然与校验漂移 ✗）。
const schemaSpec = require('./schema.js');
const BINDING_MODES = schemaSpec.BINDING_MODES;
const BINDING_MODE_DEFAULT = schemaSpec.BINDING_MODE_DEFAULT;
const BINDING_DELETIONS = schemaSpec.BINDING_DELETIONS;
const BINDING_DEBOUNCE_DEFAULT = schemaSpec.BINDING_DEBOUNCE_DEFAULT;
const BINDING_IGNORE_DEFAULT = schemaSpec.BINDING_IGNORE_DEFAULT;

/** 工程根（`src/` 的上一层）。origin.src 记的是**相对它**的路径 ⇒ 与 cwd 无关、可复现 ✓ */
const REPO_ROOT = path.resolve(__dirname, '..');

/* ================= ⓪ 导入源闸门：把"为什么读不了"说准，并**每条都给出去路** =================
 * 缺陷取证（实测 2026-10-10）：`import-project <项目> <目录>` 与 `import-md <项目> <目录>` 都露出
 *   `error: EISDIR: illegal operation on a directory, read`
 * —— 那是 Node 的原始 errno 文本：既没点明"这是**目录**，不是文件"，也没给任何出路。
 * 而"把一个文件夹喂进来"恰恰是**最自然**的误用：想导一整个库的人，第一反应就是给目录。
 *
 * 所以这里统一成"原因准确 + 带出路"的报文，两条命令共用同一份实现
 * （各写一套必然漂移 —— 本工程反复治的就是"同一件事两处表达"）。
 * `import-dir`（整库导入）**已实现**（批 5）⇒ 目录报文现在指的就是它 ✓（不再是"尚未实现"）。
 *
 * 返回 `null` = 这个源可以用；否则返回 `{ code, message }`（message 已含出路，调用方直接 ctx.error） */
/** `statSync` 失败的**归类**（纯函数：只把 errno 翻成"原因准确 + 带出路"的一句话）。
 *  `noun` 只影响"不存在"那一条（'文件不存在' / '目录不存在'）—— 其余几条本来就是路径级的原因。 */
function classifyStatFailure(p, e, noun) {
  const c = e && e.code;
  if (c === 'ENOENT') {
    return { code: 'missing', message: (noun || '文件') + '不存在: ' + p
      + '（相对路径按**当前工作目录**解析，不是按工程根；也可以用绝对路径）' };
  }
  if (c === 'EACCES' || c === 'EPERM') {
    return { code: 'denied', message: '没有权限读取这个路径: ' + p
      + '（路径本身存在，是访问被拒 —— 检查文件权限，或换一个可读的位置再试）' };
  }
  if (c === 'ENOTDIR') {
    return { code: 'notdir', message: '路径中间有一段不是目录: ' + p
      + '（路经里某个"目录"其实是个文件 —— 逐段核对）' };
  }
  if (c === 'ELOOP') {
    return { code: 'loop', message: '路径里的符号链接成环，读不了: ' + p
      + '（换一个没有自引用链接的路径）' };
  }
  return { code: 'stat-failed', message: '读不了这个路径（' + (c || (e && e.message) || '未说明原因') + '）: ' + p };
}

function describeImportSourceProblem(filePath) {
  const p = String(filePath);
  let st = null;
  try {
    st = fs.statSync(p);
  } catch (e) {
    // 每条都**分开说清**：`ENOENT` 是"没这个路径"，别让它和"没权限"共用一个含糊的文案。
    // ⚠️ 归类只有这一处实现：`import-dir` 的目录入参闸门（describeImportDirProblem）走同一个函数，
    //   只把名词换掉（'文件' / '目录'）—— 两条路各写一份 errno 映射必然漂移 ✗
    return classifyStatFailure(p, e, '文件');
  }

  if (st.isDirectory()) return { code: 'is-dir', message: directoryMessage(p) };
  if (!st.isFile()) {
    return { code: 'not-regular-file', message: '这不是一个普通文件（可能是设备/命名管道/特殊节点）: ' + p
      + '；导入只接受普通文件（.md / .txt / .docx / .pdf）' };
  }
  // stat 成功 ≠ 能打开：Windows 的 ACL 拒绝要到 open 那一刻才报，故这里真探一次可读性
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch (e) {
    return { code: 'denied', message: '文件存在，但没有读权限: ' + p
      + '（用 icacls / 文件属性检查权限，或复制到可读位置再导入）' };
  }
  // 空文件不是"读不了"，是"导出来会是空树"—— 交给格式识别给出更准的话（不在这里判死 ✗）
  return null;
}

/* ---------------- ⓪′ 体量闸门：几百 MB 的 txt/docx 不许整份读进内存 ----------------
 * 为什么必须有：两条导入路都**先把整个文件读进内存**（`docToOutline` 的 `fs.readFileSync(filePath)`、
 * `import-md` 的 `fs.readFileSync(file,'utf8')`），而一次导入的峰值内存约等于 2–3 倍文件体积
 * （Buffer + utf8 字符串 + 提纲/节点树）。几百 MB 的 txt 足以让 CLI 在这个进程里吃光内存、
 * 被系统杀掉 —— 而**被系统杀掉的进程不会打印任何原因**：使用者看到的是"命令没反应/窗口一闪"，
 * 正是本工程最忌讳的那种"看不出发生了什么" ✗。
 *
 * 上限口径（不是性能目标，是"诚实边界"）：**这个数要足够大到正常文档全都过得去**，
 * 又要小到"读进来不会把机器拖垮"。取 **64 MB**：一份纯文本 md/txt 到这个量级已是几千页；
 * docx/pdf 是压缩/分页格式，正文远小于此。超限**响亮拒绝**并给三条出路（不是静默截断 ✗、
 * 不是"读一半"✗）。**常量只有这一份**：CLI（import-md）与 docToOutline 各调同一个判据。 */
const MAX_SOURCE_MB = 64;
const MAX_SOURCE_BYTES = MAX_SOURCE_MB * 1024 * 1024;

/** 超限时的报文：**说准原因 + 给出路**（与 ⓪ 的目录报文同一风格）。
 *  `{ code:'too-big', message, sizeMB }`；没超限/取不到大小（stat 失败由 ⓪ 负责报）⇒ null。 */
function describeOversizeSource(filePath) {
  const p = String(filePath);
  let st = null;
  try { st = fs.statSync(p); } catch (e) { return null; }   // 不存在/没权限的报错归 ⓪，别在这里双重报
  if (!st.isFile() || st.size <= MAX_SOURCE_BYTES) return null;
  return describeOversizeSize(st.size, p);
}

/** 从内存里拿到的 Buffer 做同一判断（`docToOutline` 若被调用方喂进 `opts.buf` 时用；同一个常量、同一段组文） */
function describeOversizeBuffer(buf, filePath) {
  const n = buf && buf.length ? buf.length : 0;
  if (n <= MAX_SOURCE_BYTES) return null;
  return describeOversizeSize(n, filePath);
}

/** 共用组文（**纯函数**，便于单测；口径与上面两个判据完全一致 ⇒ 报文只有一份，不会漂移） */
function describeOversizeSize(sizeBytes, filePath) {
  const sizeMB = Math.round(Number(sizeBytes || 0) / 1048576);
  return {
    code: 'too-big',
    sizeMB: sizeMB,
    message: '这个文件 ' + sizeMB + ' MB，超过导入上限 ' + MAX_SOURCE_MB + ' MB: ' + String(filePath)
      + '。**没有读它**（整份读进内存会把这一进程拖垮，那正是"命令莫名退出、什么都没打印"的成因 ✗）。'
      + '出路（三选一）：'
      + '① 拆成几份（按章/按册切）再逐份导入 —— 见 `import-md <项目> <文件> --parent <节点>`；'
      + '② 先转成体量小得多的格式：docx/pdf 是压缩/分页的，纯 txt 转 docx 常能小一个量级；'
      + '③ 只要其中一段：用 head/tail（或 PowerShell 的 `Get-Content -TotalCount`）切出需要的部分再导入。'
  };
}

/** 目录入参的报文（`import-project` / `import-md` 这两条**单文件**命令拿到目录时）：
 *  点明"这是目录不是文件" + **指出真正要做这件事的命令**（`import-dir`，批 5 已实现 ✓）
 *  + 给出现在就能走的逐文件流程。 */
function directoryMessage(p) {
  return '这是一个**目录**，不是文件: ' + p
    + '。**单文件**导入（一个文件 → 一棵树）用 `import-project` / `import-md`；'
    + '要把**整个文件夹的结构**镜像成一棵树，用**整库导入** `import-dir` ✓。'
    + '出路（三选一）：'
    + '① 整库导入（推荐，先预览再导）：node cli/mm-cli.js import-dir <新项目名> "' + p + '" --dry-run；'
    + '② 合成一个项目（逐文件追加）：node cli/mm-cli.js import-md <项目> "<目录>\\某文件.md" --parent <父节点id>；'
    + '③ 一个文件一个项目：node cli/mm-cli.js import-project <新项目名> "<目录>\\某文件.md"'
    + '（重复导入会被来源指纹挡住 ⇒ 逐文件跑可以随时中断、再跑不会导重 ✓）';
}

/** `import-dir` 的目录入参闸门：**必须是目录**（文件 ⇒ 指出单文件导入的那两条命令 + 给出路）。
 *  与 `describeImportSourceProblem` 共用 stat 归类（见 `classifyStatFailure`），
 *  区别只有两处口径：这里拒绝的是"不是目录"，那边拒绝的是"是目录"。 */
function describeImportDirProblem(dir) {
  const p = String(dir);
  let st = null;
  try { st = fs.statSync(p); } catch (e) { return classifyStatFailure(p, e, '目录'); }
  if (st.isDirectory()) {
    // stat 成功 ≠ 能读（Windows 的 ACL 要到 readdir 那一刻才报）；这里真探一次
    try { fs.accessSync(p, fs.constants.R_OK); }
    catch (e) {
      return { code: 'denied', message: '这个目录存在，但没有读权限: ' + p
        + '（用 icacls / 目录属性检查权限，或复制到可读位置再导入）' };
    }
    return null;
  }
  if (st.isFile()) {
    return { code: 'not-dir', message: '这是一个**文件**，不是目录: ' + p
      + '。整库导入（`import-dir`）要的是一个**目录**：它会把目录结构镜像成一棵树。'
      + '出路（二选一）：① 单个文件建新项目：node cli/mm-cli.js import-project <新项目名> "' + p + '"；'
      + '② 追加到一个已有项目：node cli/mm-cli.js import-md <项目> "' + p + '" --parent <父节点id>'
      + '（复制文件再导入也行，但那样会多出一份来源不同的指纹记录 ⇒ 同名文件会被当成两份来源）' };
  }
  return { code: 'not-regular-file', message: '这不是一个普通文件或目录（可能是设备/命名管道/特殊节点）: ' + p
    + '；整库导入只接受**普通目录**' };
}

/* ================= ⓪′ 来源指纹 origin：批量导入**幂等**的前提 =================
 * 为什么必须有它（本工程实测的缺陷）：节点 id 由 `Date.now()` + 随机数生成
 * （见 `src/markdown.js` 的 idGen）⇒ **同一份文档导入两次会得到两棵不相交的树**：
 * 内容一样，id 与每个节点的实例都不一样 ⇒ 事后无法回答"这份文件我导过没有"。
 * 于是任何批量/整库导入都做不到幂等：再跑一遍只会又长一棵树 ✗。
 *
 * 记法：`origin: { kind, src, sha256, at, tool }` —— **可选字段，不升 formatVersion**
 *（无则兼容：旧数据没有它照样读、照样写、照样过校验），详见 `docs/DATA-FORMAT.md` §2.8。
 * 指纹算的是**规范化后的提纲文本**（不是原始文件字节）：这样同一份内容存成 CRLF/BOM 不同
 * 也不会被当成两份来源 ✓，而**改一个字节就变** ✓。
 *
 * ⚠️ 规范化与指纹**只有这一处实现**：写入方（cli/commands/project.js）不许自己拼 origin。 */

/** 规范化：CRLF/CR → LF，剥 BOM。**导入正文与指纹共用同一份规范化**（否则指纹与正文会各按一套算） */
function normalizeOutline(text) {
  let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // Windows 上编出来的 md/txt 极常带 BOM（详见 docToOutline）
  return s;
}

/** 内容指纹：规范化提纲的 sha256（64 位小写十六进制）。对**内容**敏感、对换行/BOM 不敏感 ✓ */
function outlineSha256(text) {
  return crypto.createHash('sha256').update(normalizeOutline(text), 'utf8').digest('hex');
}

/** 来源引用：相对**工程根**的 POSIX 路径（与 cwd 无关 ⇒ 同一份文档在哪儿导入都是同一个 src ✓）。
 *  跨盘（Windows 的 `D:` ↔ `C:`）时 `path.relative` 只会给回绝对路径 —— 那种情况如实写绝对路径：
 *  它是**追溯字段**（"这份树是从哪个文件来的"），不参与任何路径安全判定（见 docs/DATA-FORMAT.md §2.8）。 */
function sourceRef(file) {
  const abs = path.resolve(String(file));
  const rel = path.relative(REPO_ROOT, abs);
  const s = (rel && !path.isAbsolute(rel)) ? rel : abs;
  return s.split(path.sep).join('/');
}

/**
 * 造一个 origin（唯一实现，写入方只许调它）。
 * @param {{file:string, md:string, tool:string, at?:string}} o `md` 是**导入用的那份提纲文本**
 * @returns {{kind:string, src:string, sha256:string, at:string, tool:string}}
 */
function makeOrigin(o) {
  const src = (o && o.file) ? sourceRef(o.file) : '';
  return {
    kind: 'import',
    src: src,
    sha256: outlineSha256(o && o.md),
    at: (o && o.at) || new Date().toISOString(),
    tool: (o && o.tool) || 'import'
  };
}

/** 两个 origin 是否**指向同一份来源**：`src` 与 `sha256` **都要**相同。
 *  只比 sha256：两份内容相同但确实不同的文件会被误判成"导过了"（那是另一份来源 ✗）；
 *  只比 src：文件被改过就判不出来（正是最该拦住的那种重复 ✗）。故两个一起比。
 *  实现只用 `originKey`（下面那个）—— 判据**只有这一处**，索引与逐个比对不会漂移 ✓ */
function originMatches(a, b) {
  const k = originKey(a);
  return k !== '' && k === originKey(b);
}

/** origin → **可当 Map 键**的字符串（`src` + NUL + `sha256`）。口径与 `originMatches` 完全一致：
 *  缺 sha256 / src 不是字符串 ⇒ 返回 `''`（**永远不匹配**，与逐条比对的结论一样）。
 *  为什么要有它：整库导入要按**文件粒度**逐个查全库（几百个文件 × 全部节点），
 *  每个文件各扫一遍全库是 O(文件数 × 全库规模) ⇒ 先把全库收敛成一张索引表，一次扫盘 ✓ */
function originKey(o) {
  if (!o || typeof o !== 'object') return '';
  if (typeof o.sha256 !== 'string' || !o.sha256) return '';
  if (typeof o.src !== 'string') return '';
  return o.src + '\u0000' + o.sha256;
}

/** **目录级** origin（整库导入的项目根用）：`src` = 目录的来源引用，`sha256` = **目录清单指纹**
 *  （哪些文件、每个内容是什么，见 `dirManifestSha256`）。与 `makeOrigin` 同一个形状、同一份规范 ✓
 *  —— 写入方（CLI）不许自己拼 origin，所以这里给一个专门的入口，而不是让它去改 makeOrigin 的字段。 */
function makeDirOrigin(o) {
  return {
    kind: 'import',
    src: (o && o.dir) ? sourceRef(o.dir) : '',
    sha256: dirManifestSha256((o && o.entries) || []),
    at: (o && o.at) || new Date().toISOString(),
    tool: (o && o.tool) || 'import-dir'
  };
}

/** 一句人话（报错与 --dry-run 都用它，不各写一套） */
function describeOrigin(o) {
  if (!o || typeof o !== 'object') return '（无来源记录）';
  return '来源 ' + o.src + ' ｜ 指纹 ' + String(o.sha256 || '').slice(0, 12) + '… ｜ ' + o.at + ' ｜ ' + o.tool;
}

/* ================= ① 格式识别 ================= */
/** **认识但不支持**的格式：必须响亮拒绝，绝不落到"当 txt 读"的兜底里 ✗
 *（否则二进制的原文会被当正文导进树 —— 看着"导入成功"、内容全是乱码，
 *  正是本工程最忌讳的"静默给出错误结果"。.doc/.epub 等的真支持要新增解析器，仍未批准 ✗） */
const UNSUPPORTED = ['.doc', '.epub', '.rtf', '.odt', '.xlsx', '.xls', '.pptx', '.ppt', '.html', '.htm'];

/** 按扩展名 + 内容眉眼识别（返回 'md' | 'txt' | 'docx' | null；**不认识就 null**，由调用方响亮报错 ✓） */
function detectFormat(filePath, buf) {
  const ext = String(path.extname(filePath || '')).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';   // PDF：有书签走书签、无书签走文字层（见 §④）✓
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt' || ext === '.text') return 'txt';
  if (UNSUPPORTED.indexOf(ext) >= 0) return null;      // 认识但不管 ⇒ null（调用方按扩展名给出更准的提示）
  // 没有/不认识扩展名：看内容（zip 魔数 PK\x03\x04 ⇒ docx；`#` 开头 ⇒ md；其余当 txt）
  const b = buf || Buffer.alloc(0);
  if (b.length > 4 && b.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';   // 没扩展名也认得出来 ✓
  if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'docx';
  if (/^\s*#{1,6}\s+\S/m.test(b.toString('utf8', 0, Math.min(b.length, 4096)))) return 'md';
  if (b.length) return 'txt';
  return null;
}

/* ================= ② txt → 提纲（启发式，边界写在这里） =================
 * 判据（全部满足才算标题）：短（≤40 字）、**前后是空行**（或文件开头）、不以句末标点结尾、
 * 不像列表项/网址、且**不带逗号**（一句话里带逗号的通常是正文 ✗）。
 * 层级来自编号样式：`第一章`/`1.`/`一、` ⇒ 1 级；`1.1`/`（一）` ⇒ 2 级；`1.1.1` ⇒ 3 级；其余 2 级。
 * ⚠️ 这是**尽力而为**的启发式：认不出的标题就是正文（不会丢内容，只会少一层结构）。
 *    使用者不满意可以直接改树，或者用"或者你可以直接向我描述要导入什么"那条路让 AI 重新组织 ✓
 */
const RE_HEAD_CN_CHAPTER = /^(第\s*[0-9一二三四五六七八九十百]+\s*[章篇部卷节])/;
const RE_NUM_DOTTED = /^(\d+(?:\.\d+){0,3})[.、）)]?\s+\S/;
const RE_CN_NUM = /^([一二三四五六七八九十]+)[、.）)]\s*\S/;
const RE_PAREN_NUM = /^[（(]\s*(\d+|[一二三四五六七八九十]+)\s*[）)]\s*\S/;
const RE_LIST_OR_URL = /^(\s*[-*+•]\s|https?:\/\/|\|)/;

function looksLikeHeading(line, prevBlank, nextBlank, atStart) {
  const t = String(line || '').trim();
  if (!t || t.length > 40) return false;
  if (!(prevBlank || atStart) || !nextBlank) return false;
  if (/[。！？!?；;：:,，]$/.test(t)) return false;      // 句末标点/逗号 ⇒ 正文
  if (RE_LIST_OR_URL.test(t)) return false;
  // 必须有"标题相"：编号、或很短（≤ 24 字）且不带句读
  if (RE_HEAD_CN_CHAPTER.test(t) || RE_NUM_DOTTED.test(t) || RE_CN_NUM.test(t) || RE_PAREN_NUM.test(t)) return true;
  return t.length <= 24 && !/[，。；：]/.test(t);
}

function headingLevelOf(line) {
  const t = String(line || '').trim();
  const m1 = t.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*[章篇部卷]/);
  if (m1) return 1;
  const m2 = t.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*节/);
  if (m2) return 2;
  const m3 = t.match(RE_NUM_DOTTED);
  if (m3) return Math.min(4, m3[1].split('.').length + (t.indexOf('.') > 0 ? 0 : 0));   // 1 → 1 级；1.1 → 2 级
  if (RE_CN_NUM.test(t)) return 1;
  if (RE_PAREN_NUM.test(t)) return 2;
  return 2;
}

/** txt → 提纲 Markdown（标题前加 `#`，正文原样保留在标题下） */
function textToOutline(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const prevBlank = i === 0 ? true : raw[i - 1].trim() === '';
    const nextBlank = i === raw.length - 1 ? true : raw[i + 1].trim() === '';
    if (looksLikeHeading(line, prevBlank, nextBlank, i === 0)) {
      const lv = Math.max(1, Math.min(6, headingLevelOf(line)));
      out.push('#'.repeat(lv) + ' ' + line.trim());
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/* ================= ③ docx → 提纲 =================
 * 最小 zip 读取器：只支持**无加密、非 ZIP64** 的条目（Word 产出的小文件都在此列），
 * 支持 stored(0) 与 deflate(8) 两种压缩。遇 ZIP64/加密 ⇒ **响亮抛错**（不猜、不静默给空 ✓）。
 */
const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

function zipFindEntry(buf, wantName) {
  if (!buf || buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error('这个 docx 用了 ZIP64（本工程的最小 zip 读取器不支持）⇒ 请另存为普通 docx');
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wantName) {
      if (buf.readUInt16LE(off + 8) & 0x1) throw new Error('这个 docx 的条目是加密的（读不了）');
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOC) throw new Error('docx 的 zip 结构不对（本地头找不到）');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('docx 里用了不支持的压缩方法: ' + method);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

function decodeEnt(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** document.xml → [{text, level}]（level=0 表示正文段） */
function docxParagraphs(xml) {
  const out = [];
  const paras = String(xml).split(/<w:p[ >]/).slice(1);
  for (const p of paras) {
    const styleM = p.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    let level = 0;
    if (styleM) {
      const v = styleM[1];
      const hm = v.match(/^(?:Heading|heading|\u6807\u9898)\s*([1-9])$/);
      if (hm) level = Math.min(6, Number(hm[1]));
      else if (/^(?:Heading|heading)/.test(v)) level = 1;
    }
    let text = '';
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(p))) text += decodeEnt(m[1]);
    text = text.replace(/\s+$/, '');
    if (text.trim() || level) out.push({ text: text, level: level });
  }
  return out;
}

/** docx 段落 → 提纲 Markdown */
function docxToOutline(paras) {
  const out = [];
  for (const p of paras) {
    const t = p.text.trim();
    if (!t) { out.push(''); continue; }
    out.push(p.level ? ('#'.repeat(p.level) + ' ' + t) : t);
  }
  return out.join('\n');
}

/* ================= ④ 统一入口：文件 → 提纲 + 统计 ================= */
/**
 * @returns {{format:string, md:string, stats:{chars:number, lines:number, headings:number, levelCounts:object}}}
 */
function docToOutline(filePath, opts) {
  const o = opts || {};
  // 体量闸门（见 ⓪′）：在**读之前**判大小 ⇒ 几百 MB 的文件不会被整份读进内存。
  // 被喂了 `opts.buf` 时同样判（调用方可能已经读完了，但那也不能让它继续往下走）。
  const tooBig = o.buf ? describeOversizeBuffer(o.buf, filePath) : describeOversizeSource(filePath);
  if (tooBig) throw new Error(tooBig.message);
  const buf = o.buf || fs.readFileSync(filePath);
  const format = detectFormat(filePath, buf);
  if (!format) {
    const ext = String(path.extname(filePath || '')).toLowerCase();
    if (UNSUPPORTED.indexOf(ext) >= 0) {
      throw new Error('暂不支持 ' + ext + '：现在支持 .md / .txt / .docx / .pdf'
        + '（PDF 有书签走书签、**无书签走文字层**；目录页页码树 / 多书自动判定 / OCR 仍未做）'
        + '；也可以先把文件转成 .md/.txt 再导入，或把内容贴给内置 AI 让它整理后导入');
    }
    throw new Error('认不出这个文件的格式（支持 .md / .txt / .docx / .pdf）：' + filePath
      + '；PDF 有书签走书签、**无书签走文字层**（.pdf 里的目录页页码树 / 多书自动判定 / OCR 仍未做）');
  }
  let md;
  let pdfInfo = null, pdfPages = null;
  if (format === 'md') md = buf.toString('utf8');
  else if (format === 'pdf') {
    const r = pdfOutlineViaHelper(filePath);
    md = r.md;
    // 如实标注这份 PDF 走的是哪条路（书签 / 文字层）+ 沿途的如实报告（疑似扫描页、剔掉的页眉页脚…）——
    // 使用者必须能看见"这份树是从哪来的" ✓ 不许静默 ✗
    pdfInfo = { source: r.pdfSource, notes: r.notes };
    pdfPages = r.pages;
  }
  else if (format === 'txt') md = textToOutline(buf.toString('utf8'));
  else {
    const xml = zipFindEntry(buf, 'word/document.xml');
    if (!xml) throw new Error('这个 docx 里没有 word/document.xml（不是 Word 文档？）');
    md = docxToOutline(docxParagraphs(xml.toString('utf8')));
  }
  // ⚠️ **规范化（CRLF → LF + 剥 BOM）**：Windows 上编出来的 md/txt 极常带 BOM，而它会让
  //    **首行的 `#` 匹配不上** ⇒ 第一个标题被当成正文吞掉、整棵树少一层（实测踩到：一个带 BOM
  //    的 md 导入后顶层主题变成合成的「（层级2）」✗）。用户导入的文件不在我们的编码门禁范围内，
  //    所以这里必须自己容错 ✓。
  //    同时它也是 `outlineSha256` 的规范化 —— **同一处实现**，否则指纹与正文会各按一套算。
  md = normalizeOutline(md);
  return finishOutline(format, md, pdfPages, pdfInfo);
}

/** 提纲收口（md → {format, md, stats}）：两条入口（同步 / 异步）共用同一套统计口径 ✓ */
function finishOutline(format, md, pages, extra) {
  const lines = md.split('\n');
  const levelCounts = {};
  let headings = 0;
  for (const l of lines) {
    const m = l.match(/^(#{1,6})\s+\S/);
    if (m) { headings++; levelCounts[m[1].length] = (levelCounts[m[1].length] || 0) + 1; }
  }
  const out = { format: format, md: md, stats: { chars: md.length, lines: lines.length, headings: headings, levelCounts: levelCounts } };
  if (Array.isArray(pages)) out.pages = pages;
  // PDF 专有：来源（书签 / 文字层）与如实报告，交给命令层打印（不静默 ✗）
  if (extra && extra.source) for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

/* ================= ④ PDF → 提纲（P8 书签 ✓ / P0 文字层 ✓） =================
 * 两条路，**先书签后文字层**（都在同一个小进程里做，见下）：
 *   ① `getOutline()` 有书签 ⇒ 书签树 → `#` 标题提纲（P8 ✓；顶层书签多于一个 = 一个文件多棵树 ✓）；
 *   ② 没有书签 ⇒ 回退到**文字层**（P0 ✓）：`src/pdf-text.js` 把 TextItem 变成行/段/标题层级，
 *      再拼成同一份 `#` 提纲 ⇒ 建树仍然只有一处（`src/markdown.js`）✓。
 * 明确不做（仍未批准 ✗）：目录页 → 页码树 / 页码 ↔ 物理页偏移（P2）、多书自动判定（P3）、OCR（P4）。
 * 两样都拿不到 ⇒ **响亮拒绝**（带数字 + 出路），绝不静默给半棵树 ✗。

/** 同步读 PDF 提纲：**起一个小进程**（scripts/pdf-outline-helper.mjs）去 await ✓ ——
 *  为什么不在本进程里 await：`cli/commands/*` 有硬不变量"命令体必须同步完成"（见 cli/main.js 的守卫与
 *  tests/cli-sync-invariant.test.js），而 pdf.js 的 API 是异步的 ✗。小进程把异步收在它自己那边 ✓。
 *  失败一律**响亮**（把子进程给出的原因原样抛出 ✓ 不静默、不返回半棵树 ✗）。 */
function pdfOutlineViaHelper(filePath) {
  const helper = path.join(__dirname, '..', 'scripts', 'pdf-outline-helper.mjs');
  // ⚠️ maxBuffer 的语义（本轮修的是**报文**，不是上限本身）：`spawnSync` 收集 stdout/stderr 走的是
  //    **内存管道**，超限时它会把子进程杀掉、并把 `error.code` 置为 `ENOBUFS` / 报 "stdout maxBuffer
  //    length exceeded" —— 而旧报文只说"读 PDF 的子进程没有给出结果"，**没说是被上限掐掉的**。
  //    那是最难查的一类报文：使用者会以为"这份 PDF 坏了"，于是反复重试、换文件，方向全错 ✗。
  //    这里把"超限"独立成分支说清 + 给出去路（同一件事还有第二种表现：子进程自己先抛了错）。
  const MAXBUF_MB = 32;   // 与下面的 32 * 1024 * 1024 同一份口径（改一处必须改两处：这里只有一份常量 ✓）
  const r = require('child_process').spawnSync(process.execPath, [helper, filePath],
    { encoding: 'utf8', maxBuffer: MAXBUF_MB * 1024 * 1024 });
  const out = String(r.stdout || '').trim();
  const errText = String((r.error && r.error.message) || '') + ' ' + String(r.stderr || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out.split('\n').pop()); } catch (e) { parsed = null; }
  if (!parsed) {
    // ① 明确是**输出超限**（不是 PDF 读不了）：原因准确 + 出路
    if ((r.error && r.error.code === 'ENOBUFS') || /maxBuffer/i.test(errText)) {
      throw new Error('这份 PDF 的提纲文本超过了读取上限（子进程输出上限 ' + MAXBUF_MB + ' MB），'
        + '所以**没有拿到结果**（这不是"PDF 坏了"）。出路（三选一）：'
        + '① 先用其它工具把这份 PDF 拆成几册再逐册导入；'
        + '② 只要书签：用别的 PDF 工具导出书签为 .md/.txt 再 `import-md`；'
        + '③ 只要其中正文：把需要的那几页另存为一个新 PDF 再导入。');
    }
    // ② 子进程被信号/异常收掉（例如它自己先崩了）—— 把**信号**也报出来，别只说 exit
    const how = r.signal ? ('被信号 ' + r.signal + ' 结束') : ('exit=' + r.status);
    throw new Error('读 PDF 的子进程没有给出结果（' + how + '）：'
      + (out || errText || '（子进程没有任何输出）').slice(0, 200));
  }
  if (!parsed.ok) throw new Error(parsed.error || '读 PDF 失败（未说明原因）');
  return { md: parsed.md, pages: parsed.pages, pdfSource: parsed.source === 'text' ? 'text' : 'outline', notes: parsed.notes || [] };
}
/* ================= ⓪‴ 整库导入（`import-dir`）：目录 → 一棵容器树 =================
 * 目标：把**文件夹结构**镜像成一个项目 —— **每一级子目录 = 一个容器节点**，每个文件 = 该容器下的一个子树。
 * 三条取舍（都写在这里，改的人不必去翻提交信息）：
 *   ① **每一级目录都建容器节点**（不是"只取第一层"）：镜像的语义就是"树与文件夹同构"；
 *      只取一层的话，嵌套目录要么被拍平（结构信息丢失）、要么整条丢掉，两种都与"镜像"相反。
 *   ② **文件节点标题取文件名（去扩展名）**，不取文档首个标题：文件名本身是文件夹结构的一部分
 *      （两个目录下的 `第1章.md` 取首个标题会得到两个同名节点，而"这是哪个文件"没人答得出来），
 *      且它与 `origin.src` 同构 ⇒ "这棵树是从哪个文件来的"一眼可对。文档自己的标题**不丢**：
 *      它照样是文件节点的第一层子节点（正文走同一条 `markdownToTree` 入口）。
 *   ③ **文件节点自己带 `origin`**（文件级幂等：同一个文件被别的命令导过也认得出），
 *      项目根再带一份**目录清单指纹**（整库级幂等：整个目录重复导 ⇒ 整体拒绝并指名）。
 *
 * ⚠️ 复用**唯一入口**，本段**不做任何格式解析**：文件 → 提纲一律 `docToOutline`，
 *    提纲 → 子树一律 `markdown.markdownToTree`。本段只做"目录走查 + 跳过分类 + 容器拼装"。
 */

/* ================= ⓪⁗ 整库导入的资源引用：为什么整库选 `detail`、单文件选**拒绝** =================
 * ⚠️ **契约句（改这条口径前先读完本段）** —— 三条导入命令共用**同一处**解析/复制实现，
 *    差的只有 `onMissing` 一个入参；"用哪个口径"是有理由的取舍，不是一个可以随手改的开关。
 *
 *  · **单文件导入**（`import-md` / `import-project`）⇒ `onMissing:'refuse'`：**一份文档坏了就不导**。
 *    只有一份文档，坏引用无非两种：源文件放错位置（本该能修好）、或那几行本来就不该引用文件。
 *    两者都该由人**当场**决定，而不是让命令替它猜。拒绝是**干净**的：判据在"复制 + 写盘"之前就停，
 *    盘上不留半份项目、不多一个资源文件（见 `cli/commands/project.js` 的 `refBlockedError`）。
 *    它因此换来一条硬保证：**只要 exit 0，这份 md 里的引用就全都落了地**（没有"半份"）。
 *  · **整库导入**（`import-dir`）⇒ `onMissing:'detail'`：**整库不该为一条坏引用全灭**。
 *    一次导入几百份文档，其中任何一份里的一行旧引用（图早删了、附件挪过位置）都不该让使用者
 *    "一个文件都导不进来" —— 那等于用最坏的那一份惩罚其余全部 ✗。
 *    代价必须**如实摆进报告**：坏引用**逐条点名**（哪个文件 / 哪个节点 / 原样路径 / 按序试过哪些
 *    路径 / 为什么没解析到），并从 `images/files` 里摘掉、**按正文并入该节点的 detail**
 *    （内容不丢，也绝不落一条指向不存在文件的**悬空引用** ✗）。"放过"不等于"不说"。
 *
 *  · 两条口径**不是两套代码**：解析（相对谁、试哪些候选路径、什么算远程引用）、图片格式白名单、
 *    复制命名（与 `add-image` 同一条：时间36进制 + 4 位随机 + 扩展名）、引用改写成项目内相对路径、
 *    降级成正文 —— **全部只有一处实现**：`src/markdown.js` 的 **`resolveImportRefs(roots, opts)`**。
 *    本文件（`doc-import.js`）**不解析、不复制、不改名、不改写任何引用**：它只把"每个文件节点 +
 *    该文件的基准目录"交出去（`buildDirImportTree` 的 `refTargets`，见下），
 *    由命令层**逐文件**调那**唯一一处**实现（`cli/commands/project.js` 的 `resolveDirImportRefs`）
 *    —— 与单文件那两条命令调的是同一个函数、同一份 `refResolveOpts`，三条路不会漂移 ✓。
 *    ⚠️ 谁要是想在下面这几十行里"顺手写个复制"：那正是本工程反复治的第二种表达，别做 ✗。
 */

/** 默认导入的扩展名。**只有这一份**：CLI 的默认值、`--ext` 的校验集、扫描判据都从这里取 */
const IMPORT_EXT_DEFAULT = ['.md', '.txt', '.docx', '.pdf'];
/** **真的导得进来**的扩展名（= `detectFormat` 认识的那几个）。`--ext` 只许在这些里选 ——
 *  否则 `.py` 会被接受、然后每个文件都落到"读/转换失败"，等于把"不支持"伪装成"这个文件坏了" ✗ */
const IMPORTABLE_EXT = ['.md', '.markdown', '.txt', '.text', '.docx', '.pdf'];
/** 一律跳过的目录名：依赖/构建缓存目录（里面几乎不可能是笔记）。
 *  隐藏目录（`.git`/`.svn`/`.obsidian`…）由"名字以 `.` 开头"那条规则统一覆盖，不在这里列 ✓ */
const SKIP_DIR_NAMES = ['node_modules', '__pycache__', 'bower_components'];
/** 整库导入的默认**文件数**上限（`--max-files` 可覆盖）。
 *  为什么除了体积还要管条数：整库导入是**一次原子写**（整棵树先在内存里建好再落盘），
 *  而且导完 200 个文件之后人已经很难核对结果了。取 200 —— 一份个人笔记库的常见量级过得去，
 *  再多就明确要求调用方**自己说**要多少（`--max-files`），而不是我们偷偷放宽 ✗。 */
const MAX_IMPORT_FILES_DEFAULT = 200;

/** 跳过原因 → 一句人话（报告按它分组打印；**每一类都必须能说出"为什么"**，不许静默 ✗） */
const SKIP_LABEL = {
  hidden: '隐藏（名字以 . 开头：.git / .obsidian / .DS_Store 这类）',
  'skip-dir': '依赖或缓存目录（node_modules 这类，不是笔记）',
  symlink: '符号链接（**不跟随** ⇒ 指成的环不可能造成死循环；要这份内容请导它指向的真实目录）',
  unreadable: '没有读权限（或读目录/文件时报错）',
  'unsupported-ext': '扩展名不在本次导入范围内（用 --ext 放开）',
  'empty-dir': '空目录（一个条目都没有）',
  'no-importable': '目录里（含所有子目录）没有一个可导入的文件',
  'empty-file': '空文件（0 字节或没有任何可导入的内容）',
  'read-failed': '读/转换失败（原因见条目）',
  'not-regular-file': '不是普通文件（设备/命名管道/特殊节点）'
};

/** 跳过原因 → 报告里的短名（表格用） */
const SKIP_SHORT = {
  hidden: '隐藏', 'skip-dir': '依赖目录', symlink: '符号链接', unreadable: '无读权限',
  'unsupported-ext': '扩展名不支持', 'empty-dir': '空目录', 'no-importable': '无可导入文件',
  'empty-file': '空文件', 'read-failed': '读/转换失败', 'not-regular-file': '非普通文件'
};

/** **一个目录项要不要跳过**（纯函数：只看名字与形态，不碰磁盘）—— 返回 `null` = 收下它继续走。
 *  跳过判据**只有这一处**：目录走查、报告分组、单测都调它 ⇒ 不会出现"走查跳过一类、报告说另一类"。
 *  @param {{name:string, isDirectory?:Function, isFile?:Function, isSymbolicLink?:Function}} e
 *         形如 `fs.Dirent`（给它普通对象也能判 —— 所以判据本身可单测 ✓） */
function entrySkipReason(e) {
  const name = String((e && e.name) || '');
  if (!name) return 'unreadable';
  if (name.charAt(0) === '.') return 'hidden';                       // .git / .obsidian / .DS_Store …
  if (e.isSymbolicLink && e.isSymbolicLink()) return 'symlink';      // **不跟随** ⇒ 环不可能存在
  if (e.isDirectory && e.isDirectory()) {
    return SKIP_DIR_NAMES.indexOf(name.toLowerCase()) >= 0 ? 'skip-dir' : null;
  }
  if (e.isFile && e.isFile()) return null;
  return 'not-regular-file';
}

/** `--ext` 的解析与校验（纯函数）：每项带不带点都行；不认识/不支持的**当场报错**并列出能导的集合 */
function normalizeExtList(raw) {
  const parts = String(raw === undefined || raw === null ? '' : raw)
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) {
    return { ok: false, reason: '需要一个逗号分隔的扩展名列表（如 `--ext md,txt`），收到 '
      + JSON.stringify(raw) + '。能导的扩展名：' + IMPORTABLE_EXT.join(' / ') };
  }
  const out = [], bad = [];
  parts.forEach((p) => {
    const e = (p.charAt(0) === '.' ? p : '.' + p).toLowerCase();
    if (IMPORTABLE_EXT.indexOf(e) < 0) { bad.push(p); return; }
    if (out.indexOf(e) < 0) out.push(e);
  });
  if (bad.length) {
    // 原因准确 + 给出路：把"导不了"与"这个文件坏了"分开（`.py` 不是坏文件，是格式不在支持集里）
    return { ok: false, reason: '这些扩展名现在**导不进来**：' + bad.join(' / ')
      + '。能导的只有 ' + IMPORTABLE_EXT.join(' / ')
      + '（`.doc/.epub/.rtf/.html` 这类要先转成 md/txt，或把内容贴给内置 AI 让它整理后导入）' };
  }
  return { ok: true, ext: out };
}

/** 文件数超限的报文：说准原因 + 给出路（**在写盘之前**；与体量闸门同一形状） */
function describeTooManyFiles(count, maxFiles, dir) {
  return '这个目录里有 ' + count + ' 个可导入文件，超过整库导入上限 ' + maxFiles + ' 个: ' + String(dir)
    + '。**没有读它们**（整库导入要把整棵树先建在内存里、再一次性原子写 ⇒ 一次导入必须有上界；'
    + '而且一次导这么多之后人已经很难核对结果了 ✗）。出路（三选一）：'
    + '① 明确接受这个量：加 `--max-files ' + count + '`；'
    + '② 分批：按子目录分别导（`import-dir <新项目名> "<目录>\\某个子目录>"`）；'
    + '③ 缩小范围：`--ext md`（先只导文本，docx/pdf 另批处理）或把不需要的部分移出这个目录。';
}

/** 目录总量超限的报文（同一份 `MAX_SOURCE_MB`：与单文件闸门共用一处常量 ✓） */
function describeDirOversize(dir, totalBytes, limitBytes) {
  const sizeMB = Math.round(Number(totalBytes || 0) / 1048576);
  const limitMB = Math.round(Number(limitBytes || 0) / 1048576);
  return '这个目录里的可导入文件合计约 ' + sizeMB + ' MB，超过整库导入上限 ' + limitMB + ' MB: ' + String(dir)
    + '。**没有读它们**（整库导入要先把整棵树建在内存里再一次性写盘 ⇒ 总有一个瞬间它全在内存里；'
    + '硬读进来正是"命令莫名退出、什么都没打印"的成因 ✗）。出路（三选一）：'
    + '① 分批：按子目录分别导（`import-dir <新项目名> "<目录>\\某个子目录>"`）；'
    + '② 缩小范围：`--ext md`（先只导文本，docx/pdf 这类大文件另批处理）；'
    + '③ 先转成体量小得多的格式（docx/pdf 是压缩/分页的），或把不需要的部分移出这个目录。';
}

/**
 * 扫一个目录（**只读**：不转换、不写盘、不建树）⇒ 清单 + 逐类跳过计数。
 * 为什么先把"扫"和"建"分开：体量/条数闸门与 `--dry-run` 的预览都只需要这份清单，
 * 而"读全部文件、真的去解析"是另一件更贵、且可能在闸门处被拒掉的事 ✓
 *
 * @param {string} dir 源目录
 * @param {{ext?:string[]}} [opts] `ext` 是要导入的扩展名集合（元素形如 `.md`）
 * @returns {{root, ext, tree, files, containers, skipped, counts, otherImportableExt, totals}}
 */
function scanImportDir(dir, opts) {
  const o = opts || {};
  const ext = (Array.isArray(o.ext) && o.ext.length) ? o.ext.slice() : IMPORT_EXT_DEFAULT.slice();
  const rootAbs = path.resolve(String(dir));
  const out = {
    root: rootAbs,
    ext: ext,
    // 保留的层级（只含"最终真的有文件"的目录）；`tree` 本身是**合成的根**、不建节点
    tree: { name: path.basename(rootAbs) || rootAbs, rel: '', dirs: [], files: [] },
    files: [],
    containers: 0,
    skipped: [],
    counts: {},
    // 被 `--ext` 排除、但**本来是能导的**扩展名计数（报告里给一句"想一起导就加 --ext …"）
    otherImportableExt: {},
    totals: { files: 0, bytes: 0 }
  };
  const push = (rel, reason, message) => {
    out.skipped.push({ rel: rel, reason: reason, label: SKIP_SHORT[reason] || reason, message: message || null });
    out.counts[reason] = (out.counts[reason] || 0) + 1;
  };

  /** 递归走查。返回 'kept' | 'empty' | 'unreadable' | 'nothing' —— 由调用方决定怎么计数 ✓ */
  const walk = (absDir, relDir, node) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (e) { return { code: 'unreadable', detail: (e && e.code) || (e && e.message) || '未说明原因' }; }
    if (!entries.length) return { code: 'empty' };
    // 排序：同输入两次产出**逐字节相同**的树（readdir 的顺序不保证稳定）✓
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const e of entries) {
      const rel = (relDir ? relDir + '/' : '') + e.name;
      const abs = path.join(absDir, e.name);
      // 跳过判据只有一处（`entrySkipReason`）：走查与报告不会各有一套"什么该跳" ✓
      const why = entrySkipReason(e);
      if (why === 'hidden' || why === 'symlink' || why === 'not-regular-file') { push(rel, why); continue; }
      if (why === 'skip-dir') { push(rel, why); continue; }
      if (e.isDirectory()) {
        const child = { name: e.name, rel: rel, dirs: [], files: [] };
        const r = walk(abs, rel, child);
        if (r.code === 'kept') { node.dirs.push(child); continue; }
        if (r.code === 'empty') push(rel, 'empty-dir', null);
        else if (r.code === 'unreadable') push(rel, 'unreadable', '读不了这个目录：' + r.detail);
        else push(rel, 'no-importable', null);
        continue;
      }
      if (why) { push(rel, why); continue; }
      if (!e.isFile()) { push(rel, 'not-regular-file'); continue; }
      const extName = path.extname(e.name).toLowerCase();
      if (ext.indexOf(extName) < 0) {
        push(rel, 'unsupported-ext', extName ? ('扩展名 ' + extName) : '没有扩展名');
        // 可导但被本次 `--ext` 排除 ⇒ 单独记一笔（报告里告诉它怎么放开）
        if (IMPORTABLE_EXT.indexOf(extName) >= 0) {
          out.otherImportableExt[extName] = (out.otherImportableExt[extName] || 0) + 1;
        }
        continue;
      }
      let st = null;
      try { st = fs.statSync(abs); } catch (err) { push(rel, 'unreadable', '取不到大小：' + ((err && err.code) || '')); continue; }
      // stat 成功 ≠ 能打开（Windows 的 ACL 要到 open 那一刻才报）⇒ 真探一次可读性
      try { fs.accessSync(abs, fs.constants.R_OK); }
      catch (err) { push(rel, 'unreadable', '没有读权限'); continue; }
      /* `mtimeMs` 随文件一起交出去（R4 的绑定同步按它 + `size` 做**增量**判定）。
       * ⚠️ 它**用不上**"逐字节可复现"那类判据（那是 `tree`/`entries` 的事）⇒ 不再 stat 第二次：
       *    这里已经是同一个 `statSync` 的结果，多问一次只会多一个不一致的来源。 */
      node.files.push({ name: e.name, rel: rel, abs: abs, ext: extName, size: st.size, mtimeMs: st.mtimeMs });
    }
    return { code: (node.dirs.length || node.files.length) ? 'kept' : 'nothing' };
  };

  const r = walk(rootAbs, '', out.tree);
  /* 根目录自己要不要计一笔？**只计"真的读不了/真的空"这两种**：
   *   · `nothing`（有条目但一个都没导成）时**不再补一笔** —— 那些条目已经各计一笔了，
   *     再补一笔根目录等于同一次跳过数两遍（`counts` 是"逐条路径的跳过原因"，不是"原因种类"）✗；
   *   · `empty`（根里一个条目都没有）与 `unreadable` 则必须计 —— 否则报告会说"跳过 0 项"而
   *     真实情况是"这个目录读不了"（那正是本工程最忌的"看不出来"✗）。 */
  if (r.code === 'empty') push('.', 'empty-dir', null);
  else if (r.code === 'unreadable') push('.', 'unreadable', '读不了这个目录：' + r.detail);

  // 扁平成一份清单（体量/条数闸门、清单指纹、报告都用它）+ 数容器节点
  const flatten = (node) => {
    out.containers += node.dirs.length;
    node.files.forEach((f) => { out.files.push(f); out.totals.files++; out.totals.bytes += (f.size || 0); });
    node.dirs.forEach(flatten);
  };
  flatten(out.tree);
  return out;
}

/** **目录清单指纹**：把"这个目录里导了哪些文件、每个内容是什么"收敛成一个 sha256。
 *  算法（要求**确定**：同输入必得同一个值）：按相对路径排序，取 `相对路径 sha256` 每行一条，
 *  交给 `outlineSha256` 算 —— **不另写一套哈希**（规范化/哈希只有那一处实现 ✓）。
 *  ⚠️ 用的是**相对源目录**的路径而不是 `origin.src`（后者含绝对位置）：指纹要回答的是
 *  "这份目录内容变没变"，位置由 origin.src 自己承担 ✓ */
function dirManifestSha256(entries) {
  const lines = (entries || [])
    .map((e) => String(e.rel) + ' ' + String(e.sha256))
    .sort();
  return outlineSha256(lines.join('\n'));
}

/** **不重号**的 id 生成器（`markdown.idGen` 的薄包装，不另立一套 id 方案 ✓）。
 *  为什么整库导入必须有它：`idGen` 是 `base + 时间 + 4 位随机`，而它把**非 ASCII 的主题**整段
 *  压成 `n`（`[^a-z0-9]+` 全抹掉）⇒ 中文笔记里成百上千个节点都会落到同一个 `base`，
 *  只剩时间与 4 位随机在区分。同一毫秒里生成的节点一多就有生日碰撞，而 schema **判"全树 id 唯一"**
 *  ⇒ 一次整库导入会以"id 重复"整体失败（而人完全看不出为什么）。这里加一个"见过就再摇一次"的
 *  兜底，比事后让使用者面对一个校验错更划算。 */
function uniqueIdGen() {
  const seen = new Set();
  return function (seed) {
    let id = markdown.idGen(seed);
    while (seen.has(id)) id = markdown.idGen(seed);
    seen.add(id);
    return id;
  };
}

/**
 * 目录 → 容器树（**建树唯一入口**：每个文件都走 `docToOutline`，每棵子树都由 `markdownToTree` 建）。
 * 整棵树在**内存里**建好再交给调用方一次性落盘 ⇒ 中途失败不会留下半个项目 ✓
 *
 * @param {object} scan `scanImportDir` 的结果
 * @param {{genId?:Function, at?:string, tool?:string}} [opts]
 * @returns {{children:Array, nodes:number, containers:number, files:number, entries:Array, skipped:Array,
 *            refTargets:Array}}
 *   `entries` 每项 = `{rel, name, id, topic, sha256, origin, format}`（清单指纹与报告都用它）；
 *   `skipped` = **转换阶段**新产生的跳过（`read-failed` / `empty-file`），调用方与扫描阶段的合并计数；
 *   `refTargets` 每项 = `{rel, baseDir, node}` —— **该到哪去解析这个文件的图片/附件引用**
 *   （`node` 是那个文件节点本身，`baseDir` 是它所在目录：引用是相对 md 文件解析的）。
 *   ⚠️ 本函数**只交出落点**，解析与复制由调用方逐条调 `markdown.resolveImportRefs` 完成 ——
 *   理由见上面 ⓪⁗ 的契约句（唯一实现，不许在这里另起一套 ✗）。
 */
function buildDirImportTree(scan, opts) {
  const o = opts || {};
  const genId = o.genId || uniqueIdGen();
  const at = o.at || new Date().toISOString();
  const tool = o.tool || 'import-dir';
  /* **只转换哪些文件**（R4 的绑定同步用它做**增量**）：给了它就只处理 `rel` 命中的文件。
   * 为什么在**转换**这一层过滤、而不是在扫描那一层：闸门（体量/条数）与报告必须看**全量**，
   * 只有"读文件、建子树"这一段才是贵的 ✓。不给它 ⇒ 行为与从前**逐字节相同**（默认全量）✗。 */
  const only = (o.only && typeof o.only.has === 'function') ? o.only : null;
  const wanted = (f) => (!only || only.has(f.rel));
  const built = {
    children: [], nodes: 0, containers: 0, files: 0, entries: [], skipped: [], preambles: 0,
    refTargets: [],
    /* **这一趟真的读/转换了几个文件**（`only` 之外的那些不算）—— 判据用它量"增量"：
     * 增量性**只看树是判不出来的**（全量重建之后树的最终状态一个字都不差，差别只在"读了几个文件"），
     * 所以读数必须交出去；绑定的同步计划把它转成 `plan.readFiles`（见那里的注释与 B2/B2b 两条判据）。 */
    readFiles: 0
  };

  const walk = (node, depth) => {
    const children = [];
    // 目录在前、文件在后（与资源管理器同序），两层各自按名字排 ⇒ 结构稳定可复现 ✓
    node.dirs.forEach((sub) => {
      // 【折叠默认】容器节点是新节点 ⇒ 显式 `expanded:false`（原来 `depth+1<=2` = 前两层展开）。
      // 规则的落点说明见 `src/markdown.js` 的 openNode：只有"根"保持展开，而根是**调用方那棵树**
      // 的根（`cli/commands/project.js` 建项目时写的），本函数造出来的一律折叠 ✓
      const container = { id: genId(sub.name), topic: sub.name, expanded: false, children: [] };
      container.children = walk(sub, depth + 1);
      // 子目录里所有文件都在转换阶段失败了 ⇒ **不画空容器**（那些失败已逐条计入 read-failed ✓）
      if (!container.children.length) return;
      built.nodes++; built.containers++;
      children.push(container);
    });
    node.files.forEach((f) => {
      if (!wanted(f)) return;                       // 增量：不在本次范围内的文件不读取、不建子树
      built.readFiles++;                            // 读数：这一趟真读的文件（增量判据的唯一依据）
      let conv = null;
      try { conv = docToOutline(f.abs); }
      catch (e) {
        built.skipped.push({ rel: f.rel, reason: 'read-failed', label: SKIP_SHORT['read-failed'],
          message: String((e && e.message) || e) });
        return;
      }
      const md = normalizeOutline(conv.md);   // docToOutline 已经规范化过；这里再过一次是**同一份**函数（幂等）
      const topic = f.name.replace(/\.[^.]+$/, '');
      const fileNode = {
        // 【折叠默认】文件节点同理：新节点显式 `expanded:false`（原来 `depth+1<=2`）
        id: genId(topic), topic: topic, expanded: false, children: [],
        // 每个文件节点都带来源指纹：这样"这份文件导过没有"在**文件**一级也答得出来
        //（别的命令把同一个文件导到别处时，闸门也认得出）
        origin: makeOrigin({ file: f.abs, md: md, at: at, tool: tool })
      };
      const sub = markdown.markdownToTree(md, fileNode.id, genId);
      fileNode.children = (sub.data && sub.data.children) || [];
      /* ⚠️ 兜底：**没有一个标题**的提纲（纯 .txt 笔记最常见）产出 0 个子节点（`markdownToTree` 里没有任何
       * 标题就等于没有任何节点）。把这份文件丢掉 = **静默的数据丢失** ✗。所以退一步：把整份正文放进
       * **文件节点自己的 detail**（HTML 用 `convert.markdownToHtml` 转 —— 与 `markdownToTree` 内部**同一个**转换，
       * 不另写解析 ✓）。真的什么都没有（0 字节/纯空白）才计成"空文件"跳过。 */
      if (!fileNode.children.length) {
        const html = convert.markdownToHtml(md);
        if (!html) {
          built.skipped.push({ rel: f.rel, reason: 'empty-file', label: SKIP_SHORT['empty-file'], message: null });
          return;
        }
        fileNode.detail = html;
      } else if (sub.preamble) {
        /* 【W14】有标题时，**第一个标题之前**的正文同样不许丢：落到**文件节点自己的 detail** ——
         * 与上面"无标题"那条**同一个落点规则**（都是"这个文件在这棵树里的代表节点"）✓
         * 与上面那条互斥（无标题 ⇒ 走上面，整份正文已含前导）⇒ 同一段内容不会被写两遍。 */
        fileNode.detail = sub.preamble;
        built.preambles += 1;
      }
      built.nodes += 1 + (sub.addedCount || 0);
      built.files++;
      built.entries.push({
        rel: f.rel, name: f.name, id: fileNode.id, topic: topic,
        sha256: fileNode.origin.sha256, origin: fileNode.origin, format: conv.format
      });
      /* 【批6】把这个文件节点的**引用落点**交出去（节点 + 基准目录 = 它所在的那个目录）：
       * 图片/附件引用是**相对该 md 文件**解析的 ⇒ 每个文件各有一个基准，不能全库共用一个。
       * 落地（解析 → 复制 → 改写引用 / 坏引用降级成正文）由命令层逐条调
       * `markdown.resolveImportRefs`（唯一实现）完成 —— **本文件一行复制都不写** ✗（见 ⓪⁗ 契约句）。 */
      built.refTargets.push({ rel: f.rel, baseDir: path.dirname(f.abs), node: fileNode });
      children.push(fileNode);
    });
    return children;
  };

  built.children = walk(scan.tree, 0);
  return built;
}

/** "这个目录里没有可导入的文件"（空目录 / 全被跳过 / `--ext` 把可导的都排除了）——
 *  响亮拒绝 + **把逐类计数摆出来** + 给出路。绝不建一个空项目 ✗ */
function describeNoImportableFiles(dir, scan) {
  const parts = Object.keys(scan.counts).sort()
    .map((k) => (SKIP_SHORT[k] || k) + ' ' + scan.counts[k]);
  const more = Object.keys(scan.otherImportableExt).sort()
    .map((e) => e + ' ' + scan.otherImportableExt[e] + ' 个');
  return '这个目录里没有一个可导入的文件: ' + String(dir)
    + '（本次范围：' + scan.ext.join(' / ') + '）。'
    + (skippedTotal(scan) ? '跳过 ' + skippedTotal(scan) + ' 项' : '（目录里一个条目都没有）')
    + (parts.length ? '：' + parts.join(' / ') : '')
    + (more.length ? '。⚠️ 有可导入的扩展名被 `--ext` 排除了：' + more.join(' / ')
      + ' ⇒ 想一起导就加上，如 `--ext ' + scan.ext.concat(Object.keys(scan.otherImportableExt))
        .map((e) => e.replace(/^\./, '')).join(',') + '`' : '')
    + '。**没有写任何东西**。出路：① 换一个目录；② 用 `--ext` 放开被排除的扩展名；'
    + '③ 单个文件建项目用 `import-project <新项目名> <文件>`。';
}

/** 跳过项总数（扫描阶段 + 转换阶段合并后也算得出来；只有一处口径 ✓） */
function skippedTotal(scan) {
  return Object.keys(scan.counts || {}).reduce((n, k) => n + scan.counts[k], 0);
}

/** 把跳过项按原因分组（报告与 `--json` 共用；**每一组都要能打印出来**，不许只给个总数 ✗） */
function groupSkips(skipped) {
  const byReason = {};
  (skipped || []).forEach((s) => { byReason[s.reason] = (byReason[s.reason] || 0) + 1; });
  return byReason;
}

/* ================= ⓪⁵ 绑定工作区文件夹（R4）：**增量**同步的纯逻辑 =================
 * 用户原话：「**绑定工作区文件夹**，选择好了之后就会**定时更新**文件夹内容到思维导图」
 * （并补一句：「如果有不消耗 token 的定时检查或者修改文件的事件驱动就最好了」）。
 *
 * ## 一处实现（本工程铁律）
 * 本段**一行格式解析都不写**：要建的每棵子树仍然由 `buildDirImportTree` 造（它内部再调
 * `docToOutline` + `markdown.markdownToTree`）；本段只做三件事 ——
 *   ① **列出**要盯的文件（走同一个 `scanImportDir`，于是"哪些该跳过"与 `import-dir` 完全一致）；
 *   ② **比**（mtime + 大小 ⇒ 只把变化过的文件交给上一步转换，这是"增量"的全部含义）；
 *   ③ **套**（把新子树插进树 / 就地换掉那个文件的旧子树）。
 * ⇒ 也就是：**同步 = 定时去调那条既有导入链**（不是第二条导入链 ✗）。
 *
 * ## 三条硬口径（改之前先读完这段）
 *   ① **删除/改名只产出提议，绝不自动删**（契约 `deletions:'propose-only'`）：
 *      盘上的文件没了 ⇒ 树里那个节点**一个都不动**，只记一条"待确认"提议（改名 = 新增 + 提议删旧）
 *      —— 工程铁律是"不许删除"，删节点只能在界面上由人做 ✓。
 *   ② **转不了的不许静默跳过**（铁律②）：读不了/空文件逐条进"未转换"清单并**点名**（哪个文件、为什么），
 *      它们**不进**快照的 `files` ⇒ 下一次同步会再试一次（不是"试过就永远不管"✓）。
 *   ③ **快照放旁路文件**（`<项目目录>/.bindings.json`，与 `.ui-state.json` 同族）：
 *      它随每次巡检变化 ⇒ **绝不进项目数据**，否则守护进程每扫一次就把用户数据搅脏一次 ✗。
 *      但它也**不是**唯一真源：`bindingSnapshotOf(项目数据, 目录)` 能从树里现算那份"哪个文件对应哪个节点"
 *      （按 `origin.src`）—— 旁路文件丢了/被删了，同步照样不重复建节点 ✓（这是它敢放旁路的前提）。
 *      ⚠️ 这句话的**落点**在 `planBindingSync` 里那段 `knownNodeOf`（"先问一句树里已经有它的节点了吗"）：
 *      快照没了 ⇒ 每个文件都会被算成"新增"，**认回来**这一步把它们改成"就地更新" ✓。
 *      少了那一段，这句话就只是文档里的愿望（实测过：删掉快照那一轮节点 5→9 ✗）。
 *
 * ## 事件驱动（零 token）
 * 本段**不认识** `fs.watch` / 定时器 / 网络 / 子进程：它是一组纯函数（同样的输入必得同样的输出）⇒
 * 主进程拿它当"事件到了该做什么"的判定，测试拿它当"判定对不对"的判据。
 * 同步链路上**没有任何 LLM 调用**：文件 → 提纲 → 子树全部是本地字符串处理 ✓。
 */

/** 快照文件的**状态版本**（结构变了就 +1；读方按它判"这份快照能不能用"） */
const BINDING_STATE_VERSION = 1;

/** 快照文件名：与 `.ui-state.json` 同族的**旁路**文件（点文件 ⇒ 不进列举、不进导出、不进扫描） */
const BINDING_STATE_FILE = '.bindings.json';

/** 绑定自动导入的默认扩展名范围（= `import-dir` 的默认，**同一份常量**，不另写一份） */
const BINDING_EXT_DEFAULT = IMPORT_EXT_DEFAULT;

/** 默认忽略：本工程给的那三条（`node_modules` / `.git` / `.review`）—— 取值单源在 `src/schema.js`。
 *  ⚠️ 其中 `.git` / `.review` **本来就**会被 `entrySkipReason` 的"名字以 `.` 开头 ⇒ 跳过"规则挡掉，
 *     这里仍然写出来是为了让"默认忽略什么"**在一处可读**（而不是散落在"恰好以点开头"这个巧合里）。 */
const BINDING_IGNORE_DEFAULTS = BINDING_IGNORE_DEFAULT;

/** 目录名 → 它在**快照/节点 id** 里的写法：统一用 `/`（跨平台可复现，与 `import-dir` 的 `rel` 同口径） */
function toRelSlash(p) {
  return String(p === undefined || p === null ? '' : p).split(/[\\/]+/).filter(Boolean).join('/');
}

/** 目录名（最后一段）——不许用 `path.basename`：Windows 上斜杠混用时它只认 `\` */
function relBaseName(rel) {
  const s = toRelSlash(rel);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/** `include` 匹配：`*.md`（按扩展名）/ `assets/*`（按前缀）/ `note.md`（按路径或文件名，大小写不敏感）。
 *  **空/缺省 include = 全收**（与 `import-dir` 的"默认导 .md/.txt/.docx/.pdf"配合）。 */
function bindingIncludeHit(rel, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return true;
  const r = toRelSlash(rel).toLowerCase();
  const base = relBaseName(r);
  return patterns.some((p) => {
    const pat = String(p || '').trim().toLowerCase();
    if (!pat) return false;
    if (pat.charAt(0) === '*' && pat.indexOf('*', 1) < 0) return base.endsWith(pat.slice(1));
    if (pat.slice(-1) === '*') return r.indexOf(pat.slice(0, -1)) === 0;
    return r === pat || base === pat;
  });
}

/** `ignore` 匹配（同上，但**默认值是那三条**；给了 `ignore` 就是**完整名单**，不做"在默认上偷偷叠加"）。
 *  深浅匹配：`node_modules` 既挡**根下**那个，也挡 `a/b/node_modules` 里那个 —— 与 `import-dir` 的
 *  `SKIP_DIR_NAMES` 口径一致（那边也是按段名挡，不是只挡根下）。 */
function bindingIgnoreHit(rel, patterns) {
  const list = (Array.isArray(patterns) && patterns.length) ? patterns : BINDING_IGNORE_DEFAULTS;
  const segs = toRelSlash(rel).toLowerCase().split('/').filter(Boolean);
  const base = relBaseName(rel).toLowerCase();
  return list.some((p) => {
    const pat = String(p || '').trim().toLowerCase();
    if (!pat) return false;
    if (segs.indexOf(pat) >= 0) return true;
    if (pat.charAt(0) === '*' && pat.indexOf('*', 1) < 0) return base.endsWith(pat.slice(1));
    if (pat.slice(-1) === '*') return toRelSlash(rel).toLowerCase().indexOf(pat.slice(0, -1)) === 0;
    return base === pat;
  });
}

/**
 * **盯哪些文件**（只读：走查 + 可读性探测，不读内容）。
 *
 * ⚠️ 走查用**同一个** `scanImportDir` ⇒「什么该跳过」（隐藏项 / `node_modules` / 符号链接 /
 *    空目录 / 无读权限 / 非普通文件）与 `import-dir` **逐类一致**，报告的分类名也是同一张表 ✓。
 *    `include` / `ignore` 是本功能**新增**的两层过滤（`import-dir` 没有这两个开关）：
 *    它们只看**相对路径**，不看内容 ⇒ 仍然只读。
 *
 * @param {string} dir 绑定目录（绝对路径）
 * @param {{ext?:string[], include?:string[], ignore?:string[]}} [opts]
 * @returns {{dir:string, files:Array<{rel,name,abs,size,mtimeMs,include:boolean,ignore:boolean}>,
 *            kept:string[], skipped:Array, counts:object}}
 */
function listBindingFiles(dir, opts) {
  const o = opts || {};
  const scan = scanImportDir(dir, { ext: (o.ext && o.ext.length) ? o.ext : BINDING_EXT_DEFAULT.slice() });
  const files = scan.files
    .map((f) => ({
      rel: toRelSlash(f.rel), name: f.name, abs: f.abs, size: f.size, mtimeMs: f.mtimeMs,
      include: bindingIncludeHit(f.rel, o.include), ignore: bindingIgnoreHit(f.rel, o.ignore)
    }))
    // 排序：同输入两次产出**逐字节相同**的顺序（readdir 的顺序不保证稳定）—— 这也是"确定性产物"的硬前提
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    dir: path.resolve(String(dir)),
    files: files,
    kept: files.filter((f) => f.include && !f.ignore).map((f) => f.rel),
    skipped: scan.skipped,
    counts: scan.counts
  };
}

/** 空快照（还没同步过：`files` 空 ⇒ 第一次同步会把**全部**当新增，这正是"绑定后同步一次"该做的事）。
 *  ⚠️ "当新增"之后还会过一道"**树里已经有它的节点了吗**"（`planBindingSync` 的 `knownNodeOf`）：
 *  真正的新文件照旧建节点，而树里已经认得出的那些（`origin.src` 对得上）会**就地更新**那个节点。 */
function emptyBindingSnapshot(bindingId, dir) {
  return {
    schemaVersion: BINDING_STATE_VERSION,
    binding: String(bindingId || ''),
    dir: dir ? toRelSlash(path.resolve(String(dir))) : '',
    lastSyncAt: null,
    files: {},
    unconverted: [],
    pendingDeletions: []
  };
}

/** 环境给的那份快照能不能用（坏/旧版本/不是对象 ⇒ empty）——**响亮的前提是"能看出它坏"**：
 *  调用方拿 `rebuilt:false` 就知道"这次的判定可能是全量"，回显里会说清。 */
function normalizeBindingSnapshot(raw, bindingId, dir) {
  const bad = (why) => ({ snap: emptyBindingSnapshot(bindingId, dir), rebuilt: false, why: why });
  if (raw === undefined || raw === null) {
    return bad('还没有快照（第一次同步 ⇒ 每个文件都按新增重新判定；树里已经有它的节点时会接回原节点）');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('快照不是对象');
  if (raw.schemaVersion !== BINDING_STATE_VERSION) {
    return bad('快照的 schemaVersion 是 ' + JSON.stringify(raw.schemaVersion)
      + '，本版只认 ' + BINDING_STATE_VERSION + '（结构变过 ⇒ 按"没有快照"重来一遍）');
  }
  const snap = emptyBindingSnapshot(bindingId, dir);
  snap.lastSyncAt = (typeof raw.lastSyncAt === 'string') ? raw.lastSyncAt : null;
  snap.dir = raw.dir ? toRelSlash(raw.dir) : snap.dir;
  if (raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files)) snap.files = raw.files;
  ['unconverted', 'pendingDeletions'].forEach((k) => {
    if (Array.isArray(raw[k])) snap[k] = raw[k];
  });
  return { snap: snap, rebuilt: true, why: '' };
}

/**
 * 用**项目数据本身**补出"哪个文件对应哪个节点"（快照丢了也能补的依据）。
 *
 * 判据是 `origin`：`import-dir` 早就给每个**文件节点**写了 `origin:{src,sha256,…}`（§2.8），
 * 而 `origin.src` = 相对**工程根**的路径（`sourceRef`）⇒ 把"这个目录下某个文件的 src 长什么样"
 * 现算成前缀，就能在树里按一次遍历认出它对应的节点。**同名只认第一个**（`--force` 造的重复子树
 * 是少数，且"先到先得"至少是**确定**的）。
 *
 * ⚠️ 为什么这条函数必须存在：旁路快照**可以被人删掉**（它是工作产物）。没有它 ⇒ 删掉快照之后
 *    下一次同步会**再建一整棵树**（同一份文件两个节点），而那正是本工程最忌讳的"静默重复"。
 *
 * **两个读者**（两处都是"树里现成的那一份记账"，不是第二份实现）：
 *   ① `planBindingSync` 的 mirror 容器查找（目录 → 容器节点）；
 *   ② `planBindingSync` 的 `knownNodeOf`（文件 → 节点 ⇒ 决定"新增"还是"就地更新"）。
 * @returns {Map<string, {nodeId:string, sha256:string, topic:string}>} 相对路径 → 该文件的节点
 */
function bindingSnapshotOf(projectData, dir) {
  const out = new Map();
  const prefix = sourceRef(path.resolve(String(dir))) + '/';
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const o = node.origin;
    const src = (o && typeof o.src === 'string') ? o.src : '';
    if (src && src.indexOf(prefix) === 0 && o.sha256) {
      const rel = toRelSlash(src.slice(prefix.length));
      if (rel && !out.has(rel)) out.set(rel, { nodeId: node.id, sha256: o.sha256, topic: node.topic || null });
    }
    (node.children || []).forEach(walk);
  })(projectData && projectData.data ? projectData.data : null);
  return out;
}

/**
 * **比**：当前盘上的文件 vs 上次的快照 ⇒ 三类变化（这是"增量"的全部判定，别在别处再判一遍）。
 *
 * 口径：
 *   · `added`    —— 快照里没有、现在有；
 *   · `modified` —— 快照里有、现在**mtime 或大小变了**（mtime 是**文件系统**给的，比较**只比数字**：
 *                   两边都来自 `statSync().mtimeMs`，不经过任何字符串化 ⇒ 不会因为精度/格式漂移）；
 *   · `deleted`  —— 快照里有、现在没有了 **且当前仍在 include/ignore 范围内**。
 *     为什么要有最后那半句：把一个文件**移出** include（或加进 ignore）是人明确的动作 ⇒
 *     那不该被报成"文件被删了，要不要删节点"（那是两种意图混成一条提议 ✗）。
 *     被排除掉的文件**留在快照里**（`stillIncluded` 交出去）⇒ 它重新被纳入时判成 `modified`，
 *     不会因为"离开过视野"而多建一个节点 ✓。
 * @returns {{added:string[], modified:string[], deleted:string[], stillIncluded:string[], unchanged:number}}
 */
function bindingFileDiff(snapshot, list) {
  const snapFiles = (snapshot && snapshot.files && typeof snapshot.files === 'object') ? snapshot.files : {};
  const cur = new Map((list && list.files ? list.files : []).map((f) => [f.rel, f]));
  const added = [], modified = [], deleted = [], stillIncluded = [];
  let unchanged = 0;
  Object.keys(snapFiles).forEach((rel) => {
    const curF = cur.get(rel);
    const inScope = !!(curF && curF.include && !curF.ignore);
    const known = snapFiles[rel] || {};
    if (!curF || !inScope) { stillIncluded.push(rel); return; }       // 看不见了/被排除了 ⇒ 不算删除
    if (known.mtimeMs !== curF.mtimeMs || known.size !== curF.size) modified.push(rel);
    else unchanged++;
  });
  cur.forEach((f) => {
    if (!f.include || f.ignore) return;
    if (Object.prototype.hasOwnProperty.call(snapFiles, f.rel)) return;
    added.push(f.rel);
  });
  /* 提议"删旧"的那一类：曾经同步过、现在**盘上没有了**（且没被 include/ignore 排除）。
   * 已经提过的不再重复（去重靠快照里的 `pendingDeletions`）—— 提案是**清单**不是流水。 */
  const pending = Array.isArray(snapshot && snapshot.pendingDeletions) ? snapshot.pendingDeletions : [];
  const pendingSet = new Set(pending.map((p) => (p && p.rel) || ''));
  Object.keys(snapFiles).forEach((rel) => {
    if (cur.has(rel)) return;                       // 还在（含"被 include 排除"的那种：上面已归 stillIncluded）
    if (pendingSet.has(rel)) return;                // 已经提过一次，别重复
    deleted.push(rel);
  });
  return {
    added: added.sort(), modified: modified.sort(), deleted: deleted.sort(),
    stillIncluded: stillIncluded.sort(), unchanged: unchanged
  };
}

/**
 * **建计划**：把"变了哪些文件"变成"要往树里写什么"。
 *
 * 严格分两段，因为中间那一步**很贵**（要真的读文件、转换、建子树）而它必须在**写盘之前**完成：
 *   · `planBindingSync()`（本函数）—— 只算 + 转换，**不碰盘、不改项目数据**（纯函数）；
 *   · `applyBindingPlan()` —— 只把结果**搬进**树（不改树以外的东西、不读时钟、不摇新 id ⇒ 可安全重放）。
 * 这正是 `cli/core.js` 的 `ctx.mutate(fn)` 要求的分工：`fn` 里只许有第一个函数的产物。
 *
 * ## 落到哪里（三种情况，别混）
 *   · **flat**（默认）：所有文件都挂在 `parent` 下 —— 用户绑一个"存放笔记的文件夹"时，
 *     他要的是"文件都变成节点的子节点"，而不是先长一层同名目录节点；
 *   · **mirror**：按子目录建容器节点（与 `import-dir` 同构）。容器 id 由**目录相对路径**确定性推出
 *     （`idGen(dir:子/路径)`）⇒ 同一目录在任何一次同步里都得到同一个 id ⇒ **不会每同步一次就多一层**；
 *   · **.md 等根下文件**：两种模式下都直接挂在 `parent` 下（没有中间层可建）。
 *
 * ## 「这个文件在树里已经有节点了吗」—— 判"新增"之前先问这一句（**一处实现**，三条后果）
 *   证据有两处（`knownNodeOf`，见那里的说明）：① 快照的 `pendingDeletions` 点过名的 `nodeId`
 *   （删过又回来的那种）；② `bindingSnapshotOf` 从树里 `origin` **现算**的"文件 → 节点"
 *   （旁路快照丢了/读不出来时唯一剩下的那份记账）。认得出 ⇒ 走**就地更新**（与 `modified`
 *   同一条路），认不出才当 `added`。三条后果，每条都对着一次实测：
 *     · **旁路快照丢了不会重复建节点**（`docs/DATA-FORMAT.md` §1.5 那句话的落点；HEAD 上是
 *       "快照读不出来 ⇒ 全部文件当新增 ⇒ 节点 5→9 ✗"）；
 *     · **提议删过的文件又回来 ⇒ 接回原节点**、那条提议随之作废（不再"同一个文件两个节点"）；
 *     · 一个文件在树里**最多一个节点**（这条不变量由本段与 `applyBindingPlan` 的"修改"段共同保证）。
 *
 * @param {object} args `{ projectData, binding, snapshot, scan, list, genId, parent, at }`
 *   `scan` = **全量**的 `scanImportDir` 结果（报告与闸门看它）；`list` = `listBindingFiles` 的结果
 * @returns {{binding,mode,dir,parent,at,scanned,kept,added,modified,deleted,
 *            unconverted,containers,pending,reconnected,entries,refTargets,nodes,preambles,unchanged,skipped}}
 *   `added` 每项 = `{rel, subtree, parent}`；`modified` 每项 = `{rel, subtree, nodeId}`
 *   （`nodeId` 是那个文件**当前**在树里对应的节点 —— 就地替换要用它）；
 *   `reconnected` 每项 = `{rel, nodeId, from:'pending'|'origin', proposalWithdrawn}`
 *   —— "认回来的那些"逐条点名（回显/界面据此说清"没有新建同名节点"）
 */
function planBindingSync(args) {
  const a = args || {};
  const binding = a.binding || {};
  const bindingId = String(binding.id || '');
  const dir = path.resolve(String(binding.dir || ''));
  const mode = (BINDING_MODES.indexOf(binding.mode) >= 0) ? binding.mode : BINDING_MODE_DEFAULT;
  const parent = String(a.parent || 'root');
  const at = a.at || new Date().toISOString();
  const genId = a.genId || uniqueIdGen();
  const snap = a.snapshot || emptyBindingSnapshot(bindingId, dir);
  const list = a.list || listBindingFiles(dir, binding);
  const diff = bindingFileDiff(snap, list);
  // 目录 → 它现有容器节点的 id（mirror 的就地追加要用；**不新建**，认不出就交给"新增"那条路去建）
  const bounds = a.projectData ? bindingSnapshotOf(a.projectData, dir) : new Map();
  /* 「认回来」的唯一入口（三条后果见函数头那段）：先问"树里已经有它的节点了吗"，**再**决定
   * 归到 `added` 还是 `modified` —— 判定只写在这里一处，别在下面两个循环里各判一遍。
   * 两处证据各管一段：① 提议点过名（文件删过又回来）；② 树里 `origin` 现算（旁路快照丢了）。
   * 两条都要求"那个节点此刻真的还在树里"：认一个**已经不存在的 id** 会让 `applyBindingPlan`
   * 的"修改"段抛"快照与数据对不上"而整轮中止 —— 那不是我们要的（那种文件本来就该当新增）。 */
  const root = (a.projectData && a.projectData.data && typeof a.projectData.data === 'object')
    ? a.projectData.data : null;
  const pendingByRel = new Map();
  (snap.pendingDeletions || []).forEach((p) => {
    if (p && p.rel) pendingByRel.set(toRelSlash(p.rel), p);
  });
  const knownNodeOf = (rel) => {
    if (!root) return null;
    const key = toRelSlash(rel);
    const p = pendingByRel.get(key);
    if (p && p.nodeId && findNodeForBinding(root, p.nodeId)) return { nodeId: p.nodeId, from: 'pending' };
    const b = bounds.get(key);
    if (b && b.nodeId && findNodeForBinding(root, b.nodeId)) return { nodeId: b.nodeId, from: 'origin' };
    return null;
  };

  const plan = {
    binding: bindingId, mode: mode, dir: dir, parent: parent, at: at,
    // 全量读数（报告与"要不要写盘"都用它；**与"这次转换了几个"分开**，两者都要说得出来）
    scanned: (list.files || []).length,
    kept: (list.kept || []).length,
    added: [], modified: [], deleted: [], unconverted: [],
    containers: [], pending: [], entries: [], refTargets: [],
    /* 「认回来」的那些文件（判据见 `knownNodeOf`）：逐条点名 + 是不是带作废了一条旧提议。
     * 它与 `added` 是**互斥**的（认出来的走 `modified`，不会同时算一次新增）。 */
    reconnected: [],
    /* 快照里**已经记过**的那些提议点了名的节点（上一轮记下的，本轮不会再被提议一次）。
     * 它只用于一件事：给"人确认之后摘节点"那道闸提供**提议来源**（见 `applyBindingPlan` 的第 0 段）——
     * 少了它，确认之后永远摘不掉（实测踩到）。 */
    proposedNodeIds: ((snap.pendingDeletions || []).map((p) => p && p.nodeId).filter(Boolean)),
    /* 「待确认的删除提议」的**唯一一份并集**：本轮新提议 ∪ 快照里已存的旧提议（**减去**作废的，
     * 见下面 `pendingAll` 的组装）。为什么必须是**一个字段**（而不是让每个读者自己拼）：
     * 四个地方读它 ——
     *   · 界面/回显的"待确认删 K"与**逐条点名**（K 与清单必须出自同一份数据，否则数得出来却看不到是哪些）；
     *   · `bindingProposedNodeIds`（"这道闸认不认这个 id"，`applyBindingPlan` 第 0 段用）；
     *   · `bindingPlanChangesTree`（**只有确认、没有别的变化**的那一轮也必须被当成"会改树"，
     *     否则命令会在摘节点之前就 return ⇒ 人点了确认却什么都没发生 ✗）；
     *   · `snapshotAfterBindingPlan`（被确认的那几条要从提议里划掉 ⇒ K 才回得到 0）。
     * 各拼一份的后果是本批实测到的一条**真缺陷**：快照里那条已存在的提议在"本轮 `plan.pending` 为空"
     * 的轮次里会从读数里整个消失 ⇒ 界面显示"待确认删 0"而引擎里提议还在（域 42 的"
     * 提议读不到"判别力证明就是改坏这一处）。 */
    pendingAll: [],
    nodes: 0, preambles: 0, unchanged: diff.unchanged,
    /* **这一轮真的读了几个文件**（增量性**唯一可机器判定的读数**）。
     * 为什么要它：只比"树变了没有"是**判不出增量**的 —— 把 `only` 去掉（每次都全量重建）之后
     * 树的最终状态**一个字都不差**，差别只在"读了几个文件、花了多少 CPU"。
     * 所以判据必须落在**读数**上：没有变化的那一轮，这个数必须是 **0** ✓。 */
    readFiles: 0,
    // 扫描阶段就跳掉的那些（隐藏项 / node_modules / 符号链接 / 无读权限 / 不支持的扩展名）——
    // **照旧逐类计数**（它们是"这个目录里的什么没进来"的完整答案）
    skipped: (list.skipped || []).slice(),
    stats: {}
  };
  (list.files || []).forEach((f) => { plan.stats[f.rel] = { mtimeMs: f.mtimeMs, size: f.size }; });

  /* ---- 1) 删除/改名：**只提议**（一个节点都不删）---- */
  diff.deleted.forEach((rel) => {
    const known = (snap.files && snap.files[rel]) || {};
    plan.pending.push({ rel: rel, nodeId: known.nodeId || null, topic: known.topic || null, at: at });
  });

  /* ---- 2) 新增 / 修改：文件 → 提纲 → 子树（**只有这一段读文件**）---- */
  const changedRel = diff.added.concat(diff.modified).sort();
  let built = null;
  if (changedRel.length) {
    const changedSet = new Set(changedRel);
    /* 走 `buildDirImportTree`（唯一入口）是刻意的：转换规则、文件节点标题、前导正文落点、`origin`
     * 全都由它决定 ⇒ 与 `import-dir` 永远一致 ✓。这里只做两件它不做的事：
     *   · 用 `only` 把它**限制在变化的文件**上（增量 —— 没变的文件一个字节都不读）；
     *   · 把"要落到哪个位置"记下来（新增 ⇒ 追加；修改 ⇒ 就地换掉旧子树）。 */
    built = buildDirImportTree(a.scan, { genId: genId, at: at, tool: 'bind-sync', only: changedSet });
    // 增量读数：取**转换器自己的**读数（不是 `changedSet.size`）—— 这样"过滤有没有真生效"是可测的
    plan.readFiles = built.readFiles || 0;
    (built.skipped || []).forEach((s) => {
      plan.unconverted.push({ rel: toRelSlash(s.rel), reason: s.reason, label: s.label, message: s.message || null });
    });
    plan.entries = (built.entries || []).slice();
    plan.refTargets = (built.refTargets || []).slice();
    plan.nodes = built.nodes || 0;
    plan.preambles = built.preambles || 0;

    /* `built.entries` 每项 = `{rel, id, topic, sha256, origin, format}` —— **它就是**"哪个文件对应哪个
     * 节点"的索引（`import-dir` 早就交给调用方的那个面）⇒ 本函数不必再去树里按标题猜节点 ✓ */
    const entryOf = new Map();
    plan.entries.forEach((e) => entryOf.set(toRelSlash(e.rel), e));
    const subtreeOf = (rel) => {
      const e = entryOf.get(toRelSlash(rel));
      return e ? findNodeForBinding({ children: built.children }, e.id) : null;
    };

    const containerIds = new Map();                 // 目录相对路径 → 容器 id（**确定性**：同一目录恒同 id）
    /** 为某个目录（含祖先）备好容器 id；**只登记、不建节点** —— 建节点是 `applyBindingPlan` 的事 */
    const newContainer = (relDir) => {
      let cur = '';
      String(relDir).split('/').filter(Boolean).forEach((name) => {
        cur = cur ? cur + '/' + name : name;
        if (!containerIds.has(cur)) {
          containerIds.set(cur, genId('dir:' + cur));
          plan.containers.push({ key: cur, id: containerIds.get(cur), topic: name });
        }
      });
      return containerIds.get(String(relDir));
    };
    /** 这个新增文件该挂到谁下面（flat ⇒ 绑定父节点；mirror ⇒ 目录的容器节点，没有就现备一个） */
    const hostFor = (rel) => {
      if (mode !== 'mirror') return parent;
      const segs = toRelSlash(rel).split('/');
      segs.pop();
      const relDir = segs.join('/');
      if (!relDir) return parent;
      if (containerIds.has(relDir)) return containerIds.get(relDir);
      // 树里**已经**有覆盖这个目录的节点？有就复用它（不能每同步一次就多一层容器 ✗）
      const known = bounds.get(relDir);
      if (known) { containerIds.set(relDir, known.nodeId); return known.nodeId; }
      return newContainer(relDir);
    };

    diff.added.forEach((rel) => {
      const subtree = subtreeOf(rel);
      if (!subtree) return;                         // 转换失败的文件已在 `unconverted` 里点名
      /* ⭐ 认回来（判据只有 `knownNodeOf` 一处）⇒ **就地更新**，与 `modified` 完全同一条路：
       * 不追加新节点、不改位置、不产生第二个同名节点。快照丢了/文件删过又回来这两种情形都走这里。 */
      const known = knownNodeOf(rel);
      if (known) {
        plan.modified.push({ rel: rel, subtree: subtree, nodeId: known.nodeId, reconnected: known.from });
        plan.reconnected.push({
          rel: toRelSlash(rel), nodeId: known.nodeId, from: known.from,
          // 文件回来了 ⇒ 快照里那条"盘上没了"的提议不再成立 ⇒ 随后作废它（见 `snapshotAfterBindingPlan`）
          proposalWithdrawn: pendingByRel.has(toRelSlash(rel))
        });
        return;
      }
      plan.added.push({ rel: rel, subtree: subtree, parent: hostFor(rel) });
    });
    diff.modified.forEach((rel) => {
      const subtree = subtreeOf(rel);
      if (!subtree) return;
      const known = (snap.files && snap.files[rel]) || {};
      plan.modified.push({ rel: rel, subtree: subtree, nodeId: known.nodeId || null });
    });
  }

  /* ---- 3) 提议的并集（`pendingAll`）：见 plan 字面量里那段说明 —— 读者只有它一份，谁也不再自己拼。
   *   · 同一份文件不会同时既是"旧提议"又是"本轮新提议"（旧提议记下时已经把它从 `files` 里移走了），
   *     真出现了（手写/坏快照）也只留一条：**清单不是流水**，同一条提议报两次是最难看的一种坏法；
   *   · **作废的（`reconnected` 里带 `proposalWithdrawn`）不进并集**：那个文件已经回来了、
   *     并且已经接回它原来那个节点 ⇒ "要不要删它"这个问题本身没有了（旧行为是留着这条提议、
   *     再给同一个文件建第二个节点，等确认之后才回到一个 ✗）；
   *   · `revived`：这个文件**又回来了**、但这次**接不回**原来的节点（转不了 / 那个节点已经不在了）
   *     ⇒ 提议照旧留着等人判断，如实标出来（`revived` 的语义就此收窄成"接不回来的那种"）。 */
  const withdrawnRels = new Set((plan.reconnected || [])
    .filter((r) => r.proposalWithdrawn).map((r) => r.rel));
  const onDiskNow = new Set((list.files || []).map((f) => toRelSlash(f.rel)));
  const unionByRel = new Map();
  (snap.pendingDeletions || []).forEach((p) => {
    if (!p || !p.rel) return;
    const rel = toRelSlash(p.rel);
    if (withdrawnRels.has(rel)) return;             // 作废：文件回来了且接回了原节点
    unionByRel.set(rel, {
      rel: rel, nodeId: p.nodeId || null, topic: p.topic || null, at: p.at || null,
      revived: onDiskNow.has(rel)
    });
  });
  plan.pending.forEach((d) => {
    const rel = toRelSlash(d.rel);
    if (unionByRel.has(rel)) return;
    unionByRel.set(rel, { rel: rel, nodeId: d.nodeId || null, topic: d.topic || null, at: d.at || null, revived: false });
  });
  // 按 rel 排序 ⇒ 同一份提议在任何一轮里的**字节形态相同**（回显/断言可逐字节比）
  plan.pendingAll = Array.from(unionByRel.values()).sort((x, y) => (x.rel < y.rel ? -1 : (x.rel > y.rel ? 1 : 0)));
  return plan;
}

/**
 * **提议的并集里点了名的那些节点 id** —— "确认过的删除认不认这个 id"的**唯一判据**（一处实现）。
 *
 * 为什么单独一个函数：`applyBindingPlan` 用它决定"摘不摘"，`bindingPlanChangesTree` 用它决定
 * "这轮要不要真动手"，`snapshotAfterBindingPlan` 用它决定"哪几条提议算清了"。三处各写一遍的后果是
 * **只确认、没别的变化**的那一轮被判成 `no-change` ⇒ 在摘节点之前就 return（人点了确认，什么都没发生 ✗）。
 * @param {object} plan 计划（`pendingAll` 是本模块算的；两个老字段留给**手工构造**的计划字面量，
 *   例如单元测试里不带 `pendingAll` 的情况 —— 但它同样只能来自提议，调用方**塞不进**一个没被提议过的 id）
 */
function bindingProposedNodeIds(plan) {
  if (!plan) return new Set();
  const src = Array.isArray(plan.pendingAll)
    ? plan.pendingAll
    : (Array.isArray(plan.pending) ? plan.pending : [])
      .concat((Array.isArray(plan.proposedNodeIds) ? plan.proposedNodeIds : []).map((id) => ({ nodeId: id })));
  return new Set(src.map((p) => p && p.nodeId).filter(Boolean));
}

/** 这一轮**真的会摘掉**的节点 id = `plan.confirmedNodeIds` ∩ 提议的并集（其余一律不认） */
function bindingConfirmedDrops(plan) {
  if (!plan) return [];
  const confirmed = Array.isArray(plan.confirmedNodeIds) ? plan.confirmedNodeIds : [];
  if (!confirmed.length) return [];
  const proposed = bindingProposedNodeIds(plan);
  return confirmed.filter((id) => proposed.has(id));
}

/** 计划里会不会改到项目数据（`false` ⇒ 命令**一次盘都不写**，连原子写都不做）。
 *  ⚠️ "被人确认过的删除"也是改树（要摘节点）⇒ 只看 added/modified/containers 会让
 *  "只确认、没别的变化"的那一轮在写盘之前就 return（确认点了没反应 ✗）。 */
function bindingPlanChangesTree(plan) {
  if (!plan) return false;
  return !!(plan.added.length || plan.modified.length || plan.containers.length
    || bindingConfirmedDrops(plan).length);
}

/**
 * **套**：把计划搬进树（纯函数：`data` 是调用方给的拷贝；不读时钟、不摇新 id、不做 I/O ⇒ 可安全重放）。
 *
 * 四个动作，各自为什么这么写：
 *   · **建容器**（只在 mirror 模式、且那个目录在树里还不存在时）⇒ 按**段的深度**从小到大建，
 *     保证父容器先于子容器存在；已经存在的（`findNodeForBinding` 找得到）一律跳过 ——
 *     "每同步一次就多长一层同名目录"是这条路上最难看的一种坏法，这里用 id 确定性 + 存在性检查堵死它 ✓。
 *   · **新增** ⇒ 追加到宿主节点的 `children` **末尾**（与 `import-md` 的"追加到父节点"同一条语义）。
 *   · **修改** ⇒ 就地把那个文件的子树**换掉**（`nodeId` 从快照来），并保住它在父节点里的**位置**
 *     （顺序是用户看得见的东西，不该因为一次同步就跳位置）。查不到那个节点 ⇒ **响亮抛出**，
 *     绝不静默新建一个 —— 那会让"改了一个文件"变成"多了一个节点"，用户看到的是"东西变多了" ✗。
 *   · **同步戳** ⇒ 在绑定记录上写 `lastSyncAt` 并把 `status` 复位（上一轮"被挡住"不该永远贴着它）。
 * @returns {{data:object, added:number, modified:number, created:number, missing:Array<string>}}
 */
function applyBindingPlan(data, plan) {
  const out = { data: data, added: 0, modified: 0, created: 0, missing: [], dropped: [] };
  if (!data || !plan) return out;
  const root = data.data;
  if (!root || typeof root !== 'object') throw new Error('项目缺少 data（根节点）—— 绑定同步中止');
  const changed = !!(plan.added.length || plan.modified.length || plan.containers.length);

  /* ---- 0) 「删除的提议里已经点过名的那几个节点」⇒ 从树里摘掉。
   * ⚠️⚠️ **谁都不许在这里加"自动删盘上文件对应的节点"**（工程铁律：不许删除；删除的认定必须由人做）✗。
   *  这里的三个前提缺一不可，缺了任何一条它就从"服从人的决定"变成"守护进程自作主张"：
   *    ① `plan.confirmedNodeIds` **不是**计划自己算出来的 —— 它由命令层从**提议的并集**读出来
   *       （`bind-sync --confirm-deletions`：那些提议是**在界面上被人逐条看过、并且他按了确认**的那种）；
   *       ⚠️ 本批核实的现状：这个入参在此之前**一个调用方都没有**（引擎里这条出口是通的，但没人喂它
   *       ⇒ 界面上根本没有确认流）。补上入口的命令层**只喂它**，没有第二条删除路 ✓。
   *    ② 每个 id 都必须出现在**提议的并集**里（`bindingProposedNodeIds`：本轮新提议 ∪ 快照里的旧提议，
   *       唯一一处判据）。两者都不是的 id 一律不认 ⇒ 手写一个 id 进来删不掉东西；
   *       ⚠️ 只用"本轮新提议"**不够**：同一个文件不会在第二轮里再被提议一次（提案是**清单**不是流水，
   *       第一轮就记下了）⇒ 人确认那一刻"本轮提议"很可能已经是空的（实测踩到：闸门写成
   *       "必须在本轮提议里" ⇒ 确认之后**永远摘不掉**，等于这条纪律没有出口 ✗）。
   *    ③ 只删**节点**，绝不碰盘上的任何文件。
   *  这样"删除只提议"这条纪律的可观察后果就是：**盘上少了一个文件 ⇒ 树里节点一个不少**；
   *  而人确认之后，那个文件**真的从盘上消失**（`pendingDeletions` 只在"文件确实不在"时才保留）⇒
   *  它的旧提议与本轮的并集命中，节点才被摘掉 ✓。
   *  判别力：把 `bindingConfirmedDrops` 改成恒返回全部 confirmed（跳过并集那道闸）⇒ 域 42 的
   *  "确认前一个节点都不许少"与单测的"手写 id 删不掉东西"必红。 */
  const confirmed = bindingConfirmedDrops(plan);
  if (confirmed.length) {
    confirmed.forEach((id) => {
      const parent = findParentOfBinding(root, id);
      if (!parent) return;
      const before = parent.children.length;
      parent.children = parent.children.filter((c) => !(c && c.id === id));
      if (parent.children.length !== before) out.dropped.push(id);
    });
  }

  /* ---- 1) 容器（目录节点）：没有才建，有就复用 ---- */
  (plan.containers || []).slice().sort((x, y) => x.key.length - y.key.length || (x.key < y.key ? -1 : 1))
    .forEach((c) => {
      if (findNodeForBinding(root, c.id)) return;                 // 已经在树里 ⇒ 复用
      const segs = c.key.split('/');
      const parentKey = segs.slice(0, -1).join('/');
      let parentId = plan.parent;
      if (parentKey) {
        const p = (plan.containers || []).filter((x) => x.key === parentKey)[0];
        if (p) parentId = p.id;
      }
      const host = findNodeForBinding(root, parentId) || findNodeForBinding(root, plan.parent);
      if (!host) throw new Error('绑定同步中止：父节点不存在: ' + plan.parent);
      host.children = (host.children || []).concat([
        { id: c.id, topic: c.topic, expanded: false, children: [] }
      ]);
      out.created++;
    });

  /* ---- 2) 新增：追加到宿主节点末尾 ---- */
  (plan.added || []).forEach((item) => {
    if (!item || !item.subtree) return;
    const host = findNodeForBinding(root, item.parent || plan.parent);
    if (!host) throw new Error('绑定同步中止：宿主节点不存在: ' + (item.parent || plan.parent)
      + '（绑定 ' + plan.binding + ' · ' + item.rel + '）—— 盘上零改动');
    host.children = (host.children || []).concat([item.subtree]);
    out.added++;
  });

  /* ---- 3) 修改：就地替换（认不出旧节点 ⇒ 响亮抛出，不新建）---- */
  let missingMsg = null;
  (plan.modified || []).forEach((item) => {
    if (!item || !item.subtree) return;
    const hit = item.nodeId ? findNodeForBinding(root, item.nodeId) : null;
    if (!hit) { out.missing.push(item.rel); return; }
    const parent = findParentOfBinding(root, item.nodeId);
    const idx = parent ? parent.children.indexOf(hit) : -1;
    if (idx < 0) { out.missing.push(item.rel); return; }
    parent.children[idx] = item.subtree;
    out.modified++;
  });
  if (out.missing.length) {
    missingMsg = '绑定同步中止：这些文件**上一次同步到的那两个节点**在盘上已经不存在了 —— '
      + out.missing.join('、') + '（快照里记着 `nodeId`，而树里找不到它）。'
      + '**盘上零改动**（这条判定在写盘之前停住）。两条出路：'
      + '① 在界面上确认那些节点是不是被人删了/改名了 —— 如果是有意的，就用「解绑再重新绑定」把它当新文件导一次；'
      + '② 如果只是快照与数据对不上，用 `bind-sync <项目> --forget-snapshot` 把快照丢掉重来'
      + '（⚠️ 那会重读一遍全部文件、按树里的 `origin` 把各文件的节点接回来 —— 接不回的才当新增；'
      + '**代价是**丢掉了快照里那些"待确认的删除提议"（K 会归 0），所以不自动做 ✗）。';
    throw new Error(missingMsg);
  }

  /* ---- 4) 同步戳（只有真的改了树才写）---- */
  if (changed) {
    const list = Array.isArray(data.bindings) ? data.bindings : null;
    if (!list) throw new Error('绑定同步中止：项目缺少 bindings 数组（数据已坏，先 `bind-sync <项目> --list` 看）');
    const bi = list.findIndex((b) => b && b.id === plan.binding);
    if (bi < 0) throw new Error('绑定同步中止：绑定 ' + plan.binding + ' 不在项目里（并发改动把它解绑了？）');
    const next = Object.assign({}, list[bi]);
    next.lastSyncAt = plan.at || null;
    // 这一轮真的跑通了 ⇒ 把上一轮贴上的 `blocked` 复位成缺省（守护中）；`paused` 不动（那是人按的）
    if (next.status === 'blocked') delete next.status;
    if (next.note !== undefined && next.status === undefined) delete next.note;
    const arr = list.slice();
    arr[bi] = next;
    data.bindings = arr;
  }
  return out;
}

/** 树里按 id 找节点（`src/tree-utils.js` 的 `find` 是同一件事 —— 但那里是另一个模块的公开面；
 *  本模块的判据只比 id，几十字节的遍历不值得多一条依赖边） */
function findNodeForBinding(root, id) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.id === id) return n;
    (n.children || []).forEach((c) => stack.push(c));
  }
  return null;
}

/** 父节点（`children` 里含目标 id 的那个）——就地替换时要靠它保住**位置** */
function findParentOfBinding(root, id) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if ((n.children || []).some((c) => c && c.id === id)) return n;
    (n.children || []).forEach((c) => stack.push(c));
  }
  return null;
}

/**
 * 这一轮跑完之后，**新的快照**长什么样（纯函数：只读 `plan` 与旧快照 + 本次扫描的读数）。
 *
 * 五条：
 *   ① 成功转换的文件 ⇒ 写进 `files`（`mtimeMs`/`size` 取**扫描那一刻**的读数 —— 与 `bindingFileDiff`
 *      比的是同一对数字 ⇒ 下一次不会被判成"又变了"，不会每轮重建 ✓；`sha256`/`nodeId` 取自**转换产物**，
 *      与树里那份 `origin` 同源同值 ✓）；
 *   ② 本轮**没变**的文件 ⇒ 沿用旧条目（`keep` 传的就是它们）。**少了这一步会让每次同步都全量重建** —
 *      因为 `files` 会被清空 ⇒ 下一轮所有文件都是"新增"✗（这条是实现里最容易漏、后果最重的一处）；
 *   ③ 转不了的 ⇒ 进 `unconverted`（**点名**）且**不进 `files`** ⇒ 下一次还会再试；
 *   ④ 这次提议删的 ⇒ 进 `pendingDeletions`（去重），并从 `files` 里移走 ——
 *      移走是关键：不移走它下一次还会被算成"盘上没有了"⇒ 每轮都重复报同一条提议。
 *      ⚠️ 移走 **不等于**"删了"：树里的节点**一个都没动**（`applyBindingPlan` 里没有"自动删"的分支）✓。
 *   ⑤ **被人确认过的那几条提议 ⇒ 从这里划掉**（`bindingConfirmedDrops`）—— 不划掉的后果是
 *      "待确认删 K"永远回不到 0（提议会被下一轮重新提出来）。划掉提议 ≠ 删节点：节点在
 *      `applyBindingPlan` 第 0 段被摘（那里是唯一出口）✓。
 *   ⑤′ **那个文件又回来了、并且已经接回原节点的那几条提议 ⇒ 同样划掉**（`plan.reconnected` 里
 *      `proposalWithdrawn` 的那些）：提议的前提是"盘上没了"，文件回来了这条前提就不成立 ——
 *      不划掉的后果是清单上一直挂着一条"要不要删掉 X"的提议，而 X 正是刚接回来的那个节点。
 *      划掉提议 ≠ 删节点（同 ⑤），而且这里连"删"这件事都没发生过：节点原地被更新了内容 ✓。
 * @param {object} snapshot 旧快照（可为空）
 * @param {object} plan `planBindingSync` 的产物
 * @param {string} at 同步时刻（ISO）
 * @param {string[]} keep 本轮**没变**的文件相对路径（它们的旧条目要带过去）
 */
function snapshotAfterBindingPlan(snapshot, plan, at, keep) {
  const base = snapshot || emptyBindingSnapshot(plan && plan.binding, plan && plan.dir);
  const stats = (plan && plan.stats) || {};
  const files = {};
  // ② 本轮没变的：旧条目原样带过去（否则下一轮会被判成全量新增）
  (keep || []).forEach((rel) => {
    const old = (base.files || {})[rel];
    if (old) files[rel] = Object.assign({}, old);
  });
  const entryOf = new Map();
  ((plan && plan.entries) || []).forEach((e) => entryOf.set(toRelSlash(e.rel), e));
  const withStats = (rel, prev, nodeId, topic) => {
    const e = entryOf.get(toRelSlash(rel));
    const st = stats[toRelSlash(rel)] || {};
    return Object.assign({}, prev, {
      mtimeMs: (typeof st.mtimeMs === 'number') ? st.mtimeMs : (prev && prev.mtimeMs !== undefined ? prev.mtimeMs : null),
      size: (typeof st.size === 'number') ? st.size : (prev && prev.size !== undefined ? prev.size : null),
      sha256: (e && e.sha256) || (prev && prev.sha256) || null,
      format: (e && e.format) || (prev && prev.format) || null,
      nodeId: nodeId || (e && e.id) || (prev && prev.nodeId) || null,
      topic: topic || (prev && prev.topic) || null
    });
  };
  ((plan && plan.added) || []).forEach((it) => {
    files[it.rel] = withStats(it.rel, files[it.rel], (it.subtree && it.subtree.id) || null,
      (it.subtree && it.subtree.topic) || null);
  });
  ((plan && plan.modified) || []).forEach((it) => {
    files[it.rel] = withStats(it.rel, files[it.rel], (it.subtree && it.subtree.id) || it.nodeId || null,
      (it.subtree && it.subtree.topic) || null);
  });
  ((plan && plan.unconverted) || []).forEach((u) => { delete files[u.rel]; });   // ③
  /* ⑤ 本轮**被人确认过**的那几条提议 ⇒ 从提议里**划掉**（`bindingConfirmedDrops`：确认 ∩ 并集）。
   *   少了这一步的后果实测过：文件确实从盘上没了 ⇒ 这条提议下一轮会被**重新提出**（`files` 里已
   *   没有它，但提议清单还留着）⇒ 界面上"待确认删 K"**永远回不到 0**，人每次点确认都在确认同一条 ✗。
   *   ⚠️ 划掉提议**不等于删节点**：节点是 `applyBindingPlan` 第 0 段摘的（那边才是唯一出口）； */
  const confirmedSet = new Set(bindingConfirmedDrops(plan));
  /* ⑤′ 文件回来了、节点已经接回它 ⇒ 那条提议作废（判据来自 `plan.reconnected`，**不是**在这里
   * 重新判一次"盘上有没有这个文件" —— 认回来这件事只有 `planBindingSync` 那一处说了算）。 */
  const withdrawnRels = new Set(((plan && plan.reconnected) || [])
    .filter((r) => r && r.proposalWithdrawn).map((r) => toRelSlash(r.rel)));
  const pending = (base.pendingDeletions || []).filter((p) => !(p && confirmedSet.has(p.nodeId))
    && !(p && withdrawnRels.has(toRelSlash(p.rel))));
  ((plan && plan.pending) || []).forEach((d) => {                               // ④
    delete files[d.rel];
    if (confirmedSet.has(d.nodeId)) return;                                      // ⑤ 已确认 ⇒ 不再回到提议里
    if (!pending.some((p) => p && p.rel === d.rel)) {
      pending.push({ rel: d.rel, nodeId: d.nodeId || null, topic: d.topic || null, at: (plan && plan.at) || null });
    }
  });
  const snap = emptyBindingSnapshot(plan && plan.binding, (plan && plan.dir) || base.dir);
  snap.lastSyncAt = at || base.lastSyncAt || null;
  snap.files = files;
  snap.unconverted = ((plan && plan.unconverted) || []).map((u) => ({
    rel: u.rel, reason: u.reason, label: u.label, message: u.message || null
  }));
  snap.pendingDeletions = pending;
  return snap;
}

/**
 * 这一轮跑完之后，**新的快照**长什么样（纯函数：只读 `plan` 与旧快照）。
 *
 * 三条：
 *   ① 成功转换的文件 ⇒ 写进 `files`（`mtimeMs`/`size` 取**扫描那一刻**的读数；
 *      `sha256`/`nodeId` 取自**转换产物** —— 与树里那份 `origin` 同源同值 ✓）；
 *   ② 转不了的 ⇒ 进 `unconverted`（**点名**）且**不进 `files`** ⇒ 下一次还会再试；
 *   ③ 这次提议删的 ⇒ 进 `pendingDeletions`（去重），并从 `files` 里移走 ——
 *      移走是关键：不移走它下一次还会被算成"盘上没有了"⇒ 每轮都报同一条提议。
 *      ⚠️ 移走不等于"删了"：树里的节点**一个都没动**（`applyBindingPlan` 里根本没有删的分支）✓。
 */
/** 快照 → 一个绑定的运行状态（回显/界面用；**判定不在这里**，这里只把三个数搬出来） */
function bindingStatusOf(snapshot, binding) {
  const snap = snapshot || emptyBindingSnapshot(binding && binding.id, binding && binding.dir);
  return {
    binding: String((binding && binding.id) || snap.binding || ''),
    dir: toRelSlash(snap.dir || (binding && binding.dir) || ''),
    files: Object.keys(snap.files || {}).length,
    pending: (snap.pendingDeletions || []).length,
    unconverted: (snap.unconverted || []).length,
    lastSyncAt: snap.lastSyncAt || null
  };
}

/** 序列化（**逐字节确定**：键序固定 ⇒ 同样的状态必得同样的文件内容；`null` 也照写） */
function serializeBindingSnapshot(snapshot) {
  const snap = snapshot || {};
  const files = {};
  Object.keys(snap.files || {}).sort().forEach((rel) => {
    const f = snap.files[rel] || {};
    files[rel] = {
      mtimeMs: f.mtimeMs === undefined ? null : f.mtimeMs,
      size: f.size === undefined ? null : f.size,
      sha256: f.sha256 === undefined ? null : f.sha256,
      format: f.format === undefined ? null : f.format,
      nodeId: f.nodeId === undefined ? null : f.nodeId,
      topic: f.topic === undefined ? null : f.topic
    };
  });
  const out = {
    schemaVersion: BINDING_STATE_VERSION,
    binding: String(snap.binding || ''),
    dir: snap.dir ? toRelSlash(snap.dir) : '',
    lastSyncAt: snap.lastSyncAt || null,
    files: files,
    unconverted: (snap.unconverted || []).map((u) => ({
      rel: u.rel, reason: u.reason || null, label: u.label || null, message: u.message || null
    })),
    pendingDeletions: (snap.pendingDeletions || []).map((p) => ({
      rel: p.rel, nodeId: p.nodeId || null, topic: p.topic || null, at: p.at || null
    }))
  };
  return JSON.stringify(out, null, 2);
}

/** 反序列化（坏 JSON / 坏形状 ⇒ `null`，由调用方按"没有快照"处理 —— 不抛，因为"快照没了"是**可再生**的状态） */
function parseBindingSnapshot(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let raw = null;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { return null; }
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
}

module.exports = {
  detectFormat, textToOutline, looksLikeHeading, headingLevelOf,
  zipFindEntry, docxParagraphs, docxToOutline, docToOutline, finishOutline,
  // 导入源闸门（把"为什么读不了"说准 + 给出路）与来源指纹 origin（幂等的前提，唯一实现）
  describeImportSourceProblem, directoryMessage, describeImportDirProblem, classifyStatFailure,
  // 整库导入（import-dir）：目录走查 + 跳过分类 + 容器拼装（**建树仍只有 markdown.js 一处**）
  IMPORT_EXT_DEFAULT, IMPORTABLE_EXT, SKIP_DIR_NAMES, MAX_IMPORT_FILES_DEFAULT,
  SKIP_LABEL, SKIP_SHORT, entrySkipReason, normalizeExtList, scanImportDir, buildDirImportTree, uniqueIdGen,
  dirManifestSha256, makeDirOrigin, describeTooManyFiles, describeDirOversize, describeNoImportableFiles,
  skippedTotal, groupSkips, originKey,
  // 体量闸门（⓪′）：上限常量只有这一份，两条导入路共用同一个判据
  MAX_SOURCE_MB, MAX_SOURCE_BYTES, describeOversizeSource, describeOversizeBuffer, describeOversizeSize,
  normalizeOutline, outlineSha256, sourceRef, makeOrigin, originMatches, describeOrigin,
  // ⓪⁵ 绑定工作区文件夹（R4）：盯哪些文件 / 比 / 建计划 / 套 / 快照（**转换一律走上一条链**，本段不解析格式）
  BINDING_STATE_VERSION, BINDING_STATE_FILE, BINDING_EXT_DEFAULT, BINDING_IGNORE_DEFAULTS,
  toRelSlash, relBaseName, bindingIncludeHit, bindingIgnoreHit, listBindingFiles,
  emptyBindingSnapshot, normalizeBindingSnapshot, bindingSnapshotOf, bindingFileDiff,
  planBindingSync, bindingPlanChangesTree, applyBindingPlan, snapshotAfterBindingPlan,
  bindingStatusOf, serializeBindingSnapshot, parseBindingSnapshot
};
