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
 * docx 为什么自己解（不引依赖）：本工程**零运行时依赖**是硬约束（见 RULES / 08 的 D1）。
 * docx 就是一个 zip + 一份 `word/document.xml`：zip 的 deflate 用 node 自带的 zlib 就能解 ✓
 * ⇒ 大约 100 行换掉一个依赖，划算；且**边界要写明**（见 §docx 注释）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

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
 * ⚠️ 本文件**不实现** `import-dir`（整库导入是另一件事，尚未批准 ✗）：只如实说"尚未实现" + 给出
 *    现在就能走的逐文件流程。把"没做"说成"做了"比不做更坏。
 *
 * 返回 `null` = 这个源可以用；否则返回 `{ code, message }`（message 已含出路，调用方直接 ctx.error） */
function describeImportSourceProblem(filePath) {
  const p = String(filePath);
  let st = null;
  try {
    st = fs.statSync(p);
  } catch (e) {
    const c = e && e.code;
    // 每条都**分开说清**：`ENOENT` 是"没这个路径"，别让它和"没权限"共用一个含糊的文案
    if (c === 'ENOENT') {
      return { code: 'missing', message: '文件不存在: ' + p
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

/** 目录入参的报文：点明"这是目录不是文件" + 如实说 `import-dir` 未实现 + 给出**现在就能走**的逐文件流程 */
function directoryMessage(p) {
  return '这是一个**目录**，不是文件: ' + p
    + '。当前只支持**单文件**导入（.md / .txt / .docx / .pdf）；整库导入（`import-dir`）**尚未实现** ✗。'
    + '出路（现在就能做，逐文件导入）：'
    + '① 合成一个项目：node cli/mm-cli.js import-md <项目> "<目录>\\某文件.md" --parent <父节点id>；'
    + '② 一个文件一个项目：node cli/mm-cli.js import-project <新项目名> "<目录>\\某文件.md"；'
    + '③ PowerShell 批量（先列一遍再逐个导）：Get-ChildItem "<目录>" -Filter *.md | ForEach-Object '
    + '{ node cli/mm-cli.js import-md <项目> $_.FullName --parent root }'
    + '（重复导入会被来源指纹挡住 ⇒ 逐文件跑可以随时中断、再跑不会导重 ✓）';
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
 *  只比 src：文件被改过就判不出来（正是最该拦住的那种重复 ✗）。故两个一起比。 */
function originMatches(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (typeof a.sha256 !== 'string' || !a.sha256) return false;
  return a.sha256 === b.sha256 && typeof a.src === 'string' && a.src === b.src;
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
module.exports = {
  detectFormat, textToOutline, looksLikeHeading, headingLevelOf,
  zipFindEntry, docxParagraphs, docxToOutline, docToOutline, finishOutline,
  // 导入源闸门（把"为什么读不了"说准 + 给出路）与来源指纹 origin（幂等的前提，唯一实现）
  describeImportSourceProblem, directoryMessage,
  // 体量闸门（⓪′）：上限常量只有这一份，两条导入路共用同一个判据
  MAX_SOURCE_MB, MAX_SOURCE_BYTES, describeOversizeSource, describeOversizeBuffer, describeOversizeSize,
  normalizeOutline, outlineSha256, sourceRef, makeOrigin, originMatches, describeOrigin
};
