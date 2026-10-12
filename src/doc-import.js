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
      node.files.push({ name: e.name, rel: rel, abs: abs, ext: extName, size: st.size });
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
 * @returns {{children:Array, nodes:number, containers:number, files:number, entries:Array, skipped:Array}}
 *   `entries` 每项 = `{rel, name, id, topic, sha256, origin, format}`（清单指纹与报告都用它）；
 *   `skipped` = **转换阶段**新产生的跳过（`read-failed` / `empty-file`），调用方与扫描阶段的合并计数。
 */
function buildDirImportTree(scan, opts) {
  const o = opts || {};
  const genId = o.genId || uniqueIdGen();
  const at = o.at || new Date().toISOString();
  const tool = o.tool || 'import-dir';
  const built = { children: [], nodes: 0, containers: 0, files: 0, entries: [], skipped: [], preambles: 0 };

  const walk = (node, depth) => {
    const children = [];
    // 目录在前、文件在后（与资源管理器同序），两层各自按名字排 ⇒ 结构稳定可复现 ✓
    node.dirs.forEach((sub) => {
      const container = { id: genId(sub.name), topic: sub.name, expanded: depth + 1 <= 2, children: [] };
      container.children = walk(sub, depth + 1);
      // 子目录里所有文件都在转换阶段失败了 ⇒ **不画空容器**（那些失败已逐条计入 read-failed ✓）
      if (!container.children.length) return;
      built.nodes++; built.containers++;
      children.push(container);
    });
    node.files.forEach((f) => {
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
        id: genId(topic), topic: topic, expanded: depth + 1 <= 2, children: [],
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
  normalizeOutline, outlineSha256, sourceRef, makeOrigin, originMatches, describeOrigin
};
