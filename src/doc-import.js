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

/* ---------- UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3；对照模块 `src/palette-rank.js`）----------
 * 修复前（2026-10-20 实测）：`fs` / `path` / `zlib` / `crypto` / `./markdown.js` / `./convert.js` /
 * `./schema.js` 全部写在模块顶层，且**没有 UMD 头**、末尾直接 `module.exports` ⇒ 浏览器端加载抛
 * `ReferenceError: require is not defined`（违反 `src/` 的双端契约 §2.1/§8.4）。
 * 本模块是**导入前端**（读文件、解 zip、起 PDF 子进程）⇒ 那半边能力在浏览器里本就不该有；
 * 合规做法是显式守卫：导出函数都在，调到就抛一句明确的话（见 nodeTrap / nodeGlobal）。
 * `process` / `__dirname` 同样由工厂注入 —— 浏览器端直接取它们会抛
 * `process is not defined` / `__dirname is not defined`（比"需要 Node 环境"难读得多）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('zlib'), require('crypto'),
      require('child_process'), require('./markdown.js'), require('./convert.js'), require('./schema.js'),
      process, __dirname);
  } else {
    root.MMDocImport = factory(nodeTrap('fs'), nodeTrap('path'), nodeTrap('zlib'), nodeTrap('crypto'),
      nodeTrap('child_process'), root.MMMarkdown, root.MMConvert, root.MMSchema || {},
      nodeGlobal('process'), nodeGlobal('__dirname'));
  }
  function nodeTrap(name) {
    const no = (prop) => function () {
      throw new Error('src/doc-import.js 的 ' + name + '.' + prop + ' 需要 Node 环境（浏览器端没有 ' + name
        + '；导入文档要读盘 / 解 zip / 起子进程，请走 CLI）');
    };
    return new Proxy({}, { get: (_t, prop) => (typeof prop === 'symbol' ? undefined : no(String(prop))) });
  }
  function nodeGlobal(name) {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        throw new Error('src/doc-import.js 需要 Node 环境（浏览器端没有 ' + name + '.' + String(prop) + '；请走 CLI）');
      }
    });
  }
})(typeof self !== 'undefined' ? self : this,
function (fs, path, zlib, crypto, childProcess, markdown, convert, schemaSpec, process, __dirname) {

// 整库导入（`import-dir`）要"文件 → 提纲 → 子树"，而**建树只有一处实现**（`markdown.js`）——
// 本文件只做目录走查与容器拼装，绝不另写一套解析/建树 ✗（依赖方向 src → src，无环 ✓）
// 绑定（R4）的**取值表与身份判据**只从 `src/schema.js` 取（那是唯一的校验处）——
// 本文件不许再写一份 'propose-only' / 800 这类字面量（第二份必然与校验漂移 ✗）。

/* 浏览器端 `schema.js` 必须**先加载**（`window.MMSchema`）。万一没加载到，工厂也给它一个空对象 ——
 * 下面五个是取值表的**引用**（不是判据本身），空对象只会让它们变成 `undefined`，而真正会用到它们的
 * 地方全都要读盘/起子进程，早被 Node 守卫挡在前面；**整份文件的加载**因此不会崩。
 * Node 侧 `schemaSpec` 恒为真的 `./schema.js` ⇒ 取值逐字节不变。 */
const BINDING_MODES = schemaSpec.BINDING_MODES;
const BINDING_MODE_DEFAULT = schemaSpec.BINDING_MODE_DEFAULT;
const BINDING_DELETIONS = schemaSpec.BINDING_DELETIONS;
const BINDING_DEBOUNCE_DEFAULT = schemaSpec.BINDING_DEBOUNCE_DEFAULT;
const BINDING_IGNORE_DEFAULT = schemaSpec.BINDING_IGNORE_DEFAULT;

/** 工程根（`src/` 的上一层）。origin.src 记的是**相对它**的路径 ⇒ 与 cwd 无关、可复现 ✓
 *  ⚠️ 浏览器端没有 `__dirname` ⇒ 先探存在性（`typeof` 对未声明的标识符是安全的），
 *  那边取到 `null`；所有真正会用到它的函数都已被 Node 守卫挡在前面。 */
const REPO_ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..') : null;

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

/* ---------------- ⓪¹ 形状 → 结论（**纯核心**，G-15 下沉 2026-10-20）----------------
 * 拆出来的理由（与 `schema.validateProject` 同一个病）：下面两个"看 stat 再拼人话"的函数
 * 本来只有**一次 `fs.statSync` 是脏的**，但探针按"函数体里有没有 fs"判 ⇒ 整份被判成需盘，
 * 于是 `tests/doc-import.test.js` 想验"目录入参怎么说"就得先 `mkdtempSync('mm-dirgate-')`。
 * 现在判据本体在这里：入参是**形状**（`{kind, readable}`），**一个字节的盘都不碰**；
 * 脏的那一步（stat / access）留在下面的薄壳里。
 *
 * 形状口径（封闭取值，别自己加第四种）：
 *   `kind`     ∈ 'dir' | 'file' | 'other'（other = 设备/命名管道/特殊节点）
 *   `readable` = 该路径读不读得了（**只对 dir / file 有意义**；由壳真探一次得到）
 * 返回 `null` = 这个源可以用；否则 `{code, message}`（message 已含出路，调用方直接 ctx.error）。
 */
function describeSourceShape(shape, filePath) {
  const p = String(filePath);
  const s = shape || {};
  if (s.kind === 'dir') return { code: 'is-dir', message: directoryMessage(p) };
  if (s.kind !== 'file') {
    return { code: 'not-regular-file', message: '这不是一个普通文件（可能是设备/命名管道/特殊节点）: ' + p
      + '；导入只接受普通文件（.md / .txt / .docx / .pdf）' };
  }
  if (s.readable === false) {
    return { code: 'denied', message: '文件存在，但没有读权限: ' + p
      + '（用 icacls / 文件属性检查权限，或复制到可读位置再导入）' };
  }
  // 空文件不是"读不了"，是"导出来会是空树"—— 交给格式识别给出更准的话（不在这里判死 ✗）
  return null;
}

/** 目录入参的形状 → 结论（**纯核心**；与 `describeSourceShape` 对称，口径各自独立不许合并）。 */
function describeDirShape(shape, dir) {
  const p = String(dir);
  const s = shape || {};
  if (s.kind === 'dir') {
    if (s.readable === false) {
      return { code: 'denied', message: '这个目录存在，但没有读权限: ' + p
        + '（用 icacls / 目录属性检查权限，或复制到可读位置再导入）' };
    }
    return null;
  }
  if (s.kind === 'file') {
    return { code: 'not-dir', message: '这是一个**文件**，不是目录: ' + p
      + '。整库导入（`import-dir`）要的是一个**目录**：它会把目录结构镜像成一棵树。'
      + '出路（二选一）：① 单个文件建新项目：node cli/mm-cli.js import-project <新项目名> "' + p + '"；'
      + '② 追加到一个已有项目：node cli/mm-cli.js import-md <项目> "' + p + '" --parent <父节点id>'
      + '（复制文件再导入也行，但那样会多出一份来源不同的指纹记录 ⇒ 同名文件会被当成两份来源）' };
  }
  return { code: 'not-regular-file', message: '这不是一个普通文件或目录（可能是设备/命名管道/特殊节点）: ' + p
    + '；整库导入只接受**普通目录**' };
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
  const kind = st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'other');
  // 只有"普通文件"才需要探可读性（目录/特殊节点在上面就是终局，与拆分前同一顺序）
  if (kind !== 'file') return describeSourceShape({ kind: kind }, p);
  // stat 成功 ≠ 能打开：Windows 的 ACL 拒绝要到 open 那一刻才报，故这里真探一次可读性
  let readable = true;
  try { fs.accessSync(p, fs.constants.R_OK); } catch (e) { readable = false; }
  return describeSourceShape({ kind: kind, readable: readable }, p);
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
 * docx 是压缩/分页格式，正文远小于此。超限**响亮拒绝**并给三条出路（不是静默截断 ✗、
 * 不是"读一半"✗）。**常量只有这一份**：CLI（import-md）与 docToOutline 各调同一个判据。
 *
 * ⚠️ **它只管"单文件"，从来不是"目录总量"的闸门**（2026-10-43 更正）。
 *   旧实现让 `import-dir` 拿同一个数去卡**整个目录的合计体量**（`describeDirOversize`），
 *   理由是"整棵树在内存里建好"—— **那个理由是错的**：占内存的是**节点对象**（与标题数成正比），
 *   源文件内容是**逐文件转换、每轮即弃**的（`buildDirImportTree` 里一个 `conv` 出了当轮就没人引用）。
 *   实测后果是"一个 167 MB 的课程目录（2 份 83 MB 的 PDF + 6 份简介）被整个拒掉"，
 *   而它其实只有 143 个可导入文件、约 150 个节点 —— 闸门量错了维度 ✗。
 *   ⇒ 目录现在**没有总量上限**；超过 `MAX_IMPORT_BATCH_MB` 只是**分批**（见下面 ⓪⁸）。
 *
 * ⚠️ **pdf 不吃这道闸**（`describeOversizeSource` 里对 `.pdf` 直接放行）：pdf 的正文
 *   根本不在本进程解析 —— 它起子进程（`scripts/pdf-outline-helper.mjs`），本进程只收
 *   一份**提纲文本**，边界是 `MAX_OUTLINE_BUF_MB`（32 MB 输出）+ `PDF_HELPER_TIMEOUT_MS`（60 s）。
 *   源文件多大，不是本进程的内存旋钮 ⇒ 拿 64 MB 去拒一份 83 MB 的 PDF 是**量错了对象**。
 *   （实测：旧实现在 `.pdf` 上还要先 `fs.readFileSync` 83 MB 只是为了嗅探格式头 —— 那才是真浪费。） */
const MAX_SOURCE_MB = 64;
const MAX_SOURCE_BYTES = MAX_SOURCE_MB * 1024 * 1024;

/* ---------------- ⓪″ 子进程输出上限（**与上面的源文件体量不是同一件事**） ----------------
 * ⚠️ 这两个常量长得像、常常被当成一个旋钮，**它们是两个维度**，没有换算关系：
 *   · `MAX_SOURCE_MB`（⓪′ 上面那一行）= **喂进来的源文件**能有多大（在 `statSync` / Buffer 长度上判，不读内容）；
 *   · `MAX_OUTLINE_BUF_MB`（本行）= **收上来的子进程 stdout** 能有多大（`spawnSync` 内存管道的 `maxBuffer`）。
 * 本子进程（`scripts/pdf-outline-helper.mjs`）回的是**一份提纲文本**（只有标题行），不是正文 ⇒
 * 「源文件多大」与「提纲文本多大」之间没有比例关系，**不构成上下游**：
 * 源文件可以几百页而提纲只有几千行。所以**改其中一个不等于另一个该改**，更不许把它们合成一个常量
 * （合成之后就变成"改 PDF 提纲上限顺手改了导入闸门"，那正是最难查的一类耦合 ✗）。
 *
 * 取值理由（同 `MAX_SOURCE_MB` 的口径：**人为约定，不是测量结论**）：远大于任何真实提纲
 * （提纲只有标题行、不含正文），又小到不会把宿主进程的内存吃掉。⚠️ 全仓另有几处**别的** `maxBuffer`
 * （GUI→CLI 的 stdout、MCP 子进程、探针…）也是**第三个维度**（别的子进程、别的量级口径），
 * 它们与本常量同样没有换算关系 —— 别把它们与本常量当成一个旋钮。
 * ⚠️ 超限报文（下面 `pdfOutlineViaHelper` 里那条）引用的就是**这一个常量**，不另写数字 ⇒ 改这里报文跟着变。 */
const MAX_OUTLINE_BUF_MB = 32;

/* ---------------- ⓪″b 子进程的**时间预算**（第三个维度：不是"能吃多大"，是"等多久算卡死"） ----------------
 * 为什么必须有这个数（实测缺陷，2026-10-29）：打包后 `process.execPath` 是 `AI MindMap.exe`，
 *   那次 `spawnSync` 若不带 `ELECTRON_RUN_AS_NODE`，Electron 会把 helper 当**整个应用**启动 ——
 *   于是子进程**不返回**（实测 45038 ms 才被外部 SIGTERM 收掉，期间界面/CLI 一直卡着、一句提示都没有）。
 *   环境变量是**功能修复**（见 `pdfOutlineViaHelper`），这个数只是**止损**：任何一条"子进程不回来"的路
 *   都必须有边，否则使用者看到的是"没反应"而不是错误 ✗。
 *
 * 取值依据（**本机实测**；0.48 s 与 1 s 差一倍是运行方式不同，不是矛盾）：
 *   · 真样本 `projects/comnet/attachments/mumuhe9jafs5.pdf`（622 KB / 30 页）：
 *     打包后 node 口径 **480 ms**（`.review/20261027-打包前置/out-packaged-helper.txt` 的 B 口径）；
 *     本机 node 口径 947 ms，同目录 `mumuhmbscjfs.pdf`（520 KB）905 ms
 *     （读数：`.review/20261029-spawn死锁/out-timing.txt`）。
 *   · 合成长文档（`tests/pdf-fixture.js` 的 `buildTextPdf`）扫页数：
 *     30 页 761 ms / 150 页 812 ms / 600 页 1009 ms / **1500 页 1447 ms**
 *     ⇒ 固定成本≈0.7 s（pdf.js 装载），边际≈0.5 ms/页。**页数不是这个旋钮的瓶颈**：
 *       真正的上限是上面的 `MAX_OUTLINE_BUF_MB`（32 MB 提纲 ≈ 516 KB/1500 页 ⇒ 约 9 万页）。
 *       读数：`.review/20261029-spawn死锁/out-scaling.txt`。
 *   ⇒ 取 **60 s**：真样本（1 s 级）的约 60 倍、1500 页合成件的约 40 倍（慢机器 / 冷启动 / 杀毒扫描的余量足够），
 *     同时把"永久卡死"变成"最多等一分钟就拿到一条说清原因的错误"。
 *     更小（如 5 s）会在慢机器上**误杀真样本**；更大（如 5 min）对使用者已等于"卡住"，止损失效 ✗。
 * ⚠️ 超时**不是**"PDF 坏了"的判据：报文必须点名"超时 + 多少毫秒"并给出路（见 `pdfOutlineViaHelper`）✗ 不许静默。
 * ⚠️ 它与 `MAX_SOURCE_MB` / `MAX_OUTLINE_BUF_MB` **同样不是同一个旋钮**（时间 vs 源文件体量 vs 子进程输出体量）。
 */
const PDF_HELPER_TIMEOUT_MS = 60 * 1000;

/** 超限时的报文：**说准原因 + 给出路**（与 ⓪ 的目录报文同一风格）。
 *  `{ code:'too-big', message, sizeMB }`；没超限/取不到大小（stat 失败由 ⓪ 负责报）⇒ null。
 *  ⚠️ `.pdf` **恒放行**：它的正文不在本进程里解析，体量旋钮不是这个数（见 ⓪′ 末两段）。
 *     判据在**扩展名**上：`.pdf` 走 `pdfOutlineViaHelper`（子进程 + 32 MB 提纲上限 + 60 s 超时）。 */
function describeOversizeSource(filePath) {
  const p = String(filePath);
  if (String(path.extname(p)).toLowerCase() === '.pdf') return null;   // 见 ⓪′：pdf 的边界在子进程那一侧
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
  const kind = st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'other');
  if (kind !== 'dir') return describeDirShape({ kind: kind }, p);
  // stat 成功 ≠ 能读（Windows 的 ACL 要到 readdir 那一刻才报）；这里真探一次
  let readable = true;
  try { fs.accessSync(p, fs.constants.R_OK); } catch (e) { readable = false; }
  return describeDirShape({ kind: kind, readable: readable }, p);
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
  /* ⚠️ `.pdf` 先判**扩展名**并短路（2026-10-43）：pdf 的正文不在本进程解析（起子进程收提纲），
   *   旧实现为了 `detectFormat` 嗅探格式头会 `fs.readFileSync` **整份**源文件 —— 一份 83 MB 的 PDF
   *   在本进程白占 83 MB Buffer，还顺手被 64 MB 文本闸门拒掉（量错了对象，见 ⓪′ 末两段）。
   *   现在：扩展名是 `.pdf` ⇒ 直接把路径交给子进程（边界是提纲缓冲 32 MB + 60 s 超时）。
   *   没有扩展名/扩展名说谎的文件仍走下面的"读进来嗅探"那条老路（`detectFormat` 认 `%PDF-`）。 */
  if (!o.buf && String(path.extname(String(filePath || ''))).toLowerCase() === '.pdf') {
    const rp = pdfOutlineViaHelper(filePath);
    return finishOutline('pdf', normalizeOutline(rp.md), rp.pages, { source: rp.pdfSource, notes: rp.notes });
  }
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

/** 提纲收口（md → {format, md, stats}）：两条入口（同步 / 异步）共用同一套统计口径 ✓
 *
 * ⚠️ **"这一行算不算标题"只有一处实现**：`src/markdown.js` 的 `outlineHeadingLines`
 *   （围栏状态机 `outlineLines` 的唯一消费方之一，另一个就是建树 `markdownToTree`）。
 *   改前这里是朴素正则 `/^(#{1,6})\s+\S/`，于是同一份带围栏代码块的经验笔记：
 *   `--dry-run` 自报 **216** 个标题、真建 **72** 个节点（差 144，全是围栏里的 `#` 注释）
 *   —— 预览在说谎，而调用方（AI）会照着它做决定。现已按 A1 收成单源：
 *   本函数**不含任何正则**，只做"把唯一判据的结果装进 stats"。 */
function finishOutline(format, md, pages, extra) {
  const lines = md.split('\n');
  const counted = markdown.countOutlineHeadings(md);   // ← 唯一判据（围栏感知，与建树同源）
  const out = { format: format, md: md, stats: { chars: md.length, lines: lines.length, headings: counted.headings, levelCounts: counted.levelCounts } };
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
  //    ⚠️ 上限常量**已经不在这个函数体里**了：它提到了文件顶部的常量区（`MAX_OUTLINE_BUF_MB`，
  //    与 `MAX_SOURCE_MB` 挨着放，那里写清了"两个维度不是一件事"）⇒ 本函数与报文共用那一份，别再在本地写一个数字。
  //
  // ⚠️⚠️ `env` 里那个 `ELECTRON_RUN_AS_NODE` 是**功能修复，不是止损**（`timeout` 才是止损）。缺它的实测后果：
  //    打包后 `process.execPath` = `AI MindMap.exe` ⇒ Electron 把 helper 当成**整个应用**来启动，
  //    子进程去 `[main] registerIpc ok / window created`、永不按 node 语义跑脚本：45038 ms 才被外部 SIGTERM 收掉，
  //    stdout 里连一行 JSON 都没有（读数：`.review/20261027-打包前置/out-packaged-helper.txt` A 口径）。
  //    同一个 exe 带上它 ⇒ 480 ms 返回 `{"ok":true,…}` 33205 字节（同文件 B 口径）⇒ 依赖进包 / asar 内 ESM /
  //    pdfjs 从 asar 里跑**全都是通的**，唯一缺的就是这一个环境变量。
  // ⚠️ 必须**合并** `process.env`：写成 `env: { ELECTRON_RUN_AS_NODE: '1' }` 会把 PATH / 代理 / 区域设置
  //    整份丢掉（本工程已有一次同类教训：子进程找不到命令、中文路径突然坏掉，而报错完全不提环境变量）。
  const r = childProcess.spawnSync(process.execPath, [helper, filePath],
    { encoding: 'utf8', maxBuffer: MAX_OUTLINE_BUF_MB * 1024 * 1024, timeout: PDF_HELPER_TIMEOUT_MS,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  const out = String(r.stdout || '').trim();
  const errText = String((r.error && r.error.message) || '') + ' ' + String(r.stderr || '').trim();
  // ① **超时**：判在解析**之前** —— 超时就是失败，哪怕 stdout 恰好拼出了一行完整 JSON
  //    （那也不是"子进程跑完了"，是它被杀之前吐了一口气）。这一条是"停止等"的判据，不许静默 ✗。
  if ((r.error && r.error.code === 'ETIMEDOUT') || /ETIMEDOUT/.test(errText)) {
    throw new Error('读 PDF 的子进程**超时**了：' + Math.round(PDF_HELPER_TIMEOUT_MS / 1000) + ' 秒内没有返回结果，已被强制结束。'
      + '这不是"这份 PDF 坏了"的判据（它只是没跑完），所以别急着重试或换文件。出路（三选一）：'
      + '① 先用其它工具把这份 PDF 拆成几册再逐册导入；'
      + '② 只要书签：用别的 PDF 工具导出书签为 .md/.txt 再 `import-md`；'
      + '③ 只想读其中几页：把需要的那几页另存为一个新 PDF 再导入。'
      + '（若跑的是自己打包的版本：先用命令行确认同一个 helper 能被正常调用 —— 子进程不按 Node 模式起来时，'
      + '表现正是"一直不返回"，而不是任何一条错误。）');
  }
  let parsed = null;
  try { parsed = JSON.parse(out.split('\n').pop()); } catch (e) { parsed = null; }
  if (!parsed) {
    // ② 明确是**输出超限**（不是 PDF 读不了）：原因准确 + 出路
    if ((r.error && r.error.code === 'ENOBUFS') || /maxBuffer/i.test(errText)) {
      throw new Error('这份 PDF 的提纲文本超过了读取上限（子进程输出上限 ' + MAX_OUTLINE_BUF_MB + ' MB），'
        + '所以**没有拿到结果**（这不是"PDF 坏了"）。出路（三选一）：'
        + '① 先用其它工具把这份 PDF 拆成几册再逐册导入；'
        + '② 只要书签：用别的 PDF 工具导出书签为 .md/.txt 再 `import-md`；'
        + '③ 只要其中正文：把需要的那几页另存为一个新 PDF 再导入。');
    }
    // ③ 子进程被信号/异常收掉（例如它自己先崩了）—— 把**信号**也报出来，别只说 exit
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
const IMPORT_EXT_DEFAULT = ['.md', '.txt', '.docx', '.pdf', '.m3u8'];
/** **真的导得进来**的扩展名。`--ext` 只许在这些里选 —— 否则 `.py` 会被接受、然后每个文件都落到
 *  "读/转换失败"，等于把"不支持"伪装成"这个文件坏了" ✗。
 *  = `detectFormat` 认识的那几个（`.md/.markdown/.txt/.text/.docx/.pdf`）**∪** 视频入口（`.m3u8`）。
 *  ⚠️ `.m3u8` **不走** `docToOutline`（它不是文档，是播放列表）：它在 `buildDirImportTree` 里
 *  走**视频入口**那一支（节点 + `localPath` + 一句"大概的详情"），见 ⓪⁹。 */
const IMPORTABLE_EXT = ['.md', '.markdown', '.txt', '.text', '.docx', '.pdf', '.m3u8'];
/** 一律跳过的目录名：依赖/构建缓存目录（里面几乎不可能是笔记）。
 *  隐藏目录（`.git`/`.svn`/`.obsidian`…）由"名字以 `.` 开头"那条规则统一覆盖，不在这里列 ✓ */
const SKIP_DIR_NAMES = ['node_modules', '__pycache__', 'bower_components'];
/** 整库导入的默认**文件数**上限（`--max-files` 可覆盖）。
 *  为什么除了体积还要管条数：这不是内存界（内存界由"逐文件转换 + 分批"承担，见 ⓪⁸），
 *  而是**人可核对性**的界 —— 一次导完几百个文件之后人已经很难核对结果了。取 200 ——
 *  一份个人笔记库的常见量级过得去，再多就明确要求调用方**自己说**要多少（`--max-files`），
 *  而不是我们偷偷放宽 ✗。 */
const MAX_IMPORT_FILES_DEFAULT = 200;

/* ---------------- ⓪⁸ 整库导入的**分批线**（不是拒绝线） ----------------
 * 为什么要它（2026-10-43，真实现场）：用户把一个 **7.85 GB / 14989 个文件 / 570 个目录**的视频课程目录
 *   丢进 `import-dir`，旧实现拿"单文件 64 MB"去卡**整个目录的合计体量** ⇒ 直接拒（报文说 167 MB 超限）。
 *   那个上限的理由写的是"整棵树先在内存里建好，再一次性写盘"—— **量错了维度**（见 ⓪′ 末两段：
 *   占内存的是节点对象，不是源文件内容）。
 *
 * ⇒ 目录现在**没有总量上限**。越过下面两条线只触发一件事：**分批转换**。
 *   · 一批 = 一棵**顶层子树**（顶层子目录，或根下的一组文件）；一批自己还超线就**继续往下拆**，
 *     拆到一个文件都不能再拆为止（**单个文件永远独占一批，绝不因为"太大"被丢掉** ✗）；
 *   · 每一批打完一行进度（`--dry-run` 与真导都打）⇒ 几十分钟的导入不会变成"什么都没打印"。
 *   ⇒ 取值：**64 MB / 32 个文件**。64 与单文件闸门同量级（一批本来就不该比"一份大文档"更重）；
 *     32 是"人还能一眼核对"的量级，也是"进程真挂了最多白做多少"的量级。
 *
 * ⚠️ **为什么"分批"不等于"每批写一次盘"**（这条要改前先读完，别顺手改成 N 次写）：
 *   项目数据是**一个 JSON**（`<项目>/<项目>.json`）。每写一次就要把整棵树重新读进来再序列化一次
 *   ⇒ N 批 = N 次全量读写（O(N²)），而且会把既有硬保证「**一次原子写，失败不留半个项目**」
 *   降级成"半份项目 + 用户自己判断要不要删"✗。两害相权，本工程的取舍是：
 *   **分批转换（每批的工作集出了这批就没人引用）+ 每批进度 + 一次原子写**。
 *   ⇒ 内存峰值因此**由最大的那一个文件决定，不随目录总量线性涨** —— 这一条是实测的读数，
 *     不是推断：`.review/20261043-视频目录导入/out-rss.json`（总量 160 MB / 480 MB / 1.6 GB
 *     三档，maxRSS 三档相同）。线本身**不需要**被实测校准：它量的是"批多大"，不是"内存墙在哪"。
 */
const MAX_IMPORT_BATCH_MB = 64;
const MAX_IMPORT_BATCH_BYTES = MAX_IMPORT_BATCH_MB * 1024 * 1024;
const MAX_IMPORT_BATCH_FILES = 32;

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
  'not-regular-file': '不是普通文件（设备/命名管道/特殊节点）',
  // ---- 【20261043】视频目录：**分片 / 密钥 / 索引**没有导入的意义（单独一类，不许混进"扩展名不支持"）----
  'video-part': '视频分片 / 密钥 / 索引（HLS 包里除播放列表以外的文件 —— 它们只对播放器有意义，'
    + '打开播放列表就够了；**没有导入**）',
  // ---- 【W12】`--vault` 专用的三类（**都算"没进树/没接上"** ⇒ 必须逐条点名，绝不静默 ✗）----
  'vault-dangling': 'wiki 链接没接上（目标笔记不存在 / 名字认不出 —— 正文原样保留，没有写悬空链接）',
  'vault-ambiguous': 'wiki 链接同名多篇（不猜是哪一篇 ⇒ 没有写这条边，请自己确认）',
  'vault-resource': '嵌入的附件/图片没落成项目内文件（按正文保留，内容没丢）'
};

/** 跳过原因 → 报告里的短名（表格用） */
const SKIP_SHORT = {
  hidden: '隐藏', 'skip-dir': '依赖目录', symlink: '符号链接', unreadable: '无读权限',
  'unsupported-ext': '扩展名不支持', 'empty-dir': '空目录', 'no-importable': '无可导入文件',
  'empty-file': '空文件', 'read-failed': '读/转换失败', 'not-regular-file': '非普通文件',
  'video-part': '视频分片/密钥/索引',
  'vault-dangling': 'wiki 断链', 'vault-ambiguous': 'wiki 同名多篇', 'vault-resource': '附件没落成'
};

/* ---------------- ⓪⁹ 视频目录：`.m3u8` = **入口**（导入），分片/密钥/索引 = **没有意义**（跳过） ----------------
 * 现场形状（用户的课程目录，一个课时一份）：
 *   `<课时>/学习中心.m3u8/index.m3u8`       ← **这一份才是"视频打开链接"**（HLS 播放列表）
 *   `<课时>/学习中心.m3u8/index.m3u8.bak`   ← 播放列表的备份
 *   `<课时>/学习中心.m3u8/index/N.ts`       ← 分片（14476 个 / 7.68 GB）
 *   `<课时>/学习中心.m3u8/extk0/XXXX.key`   ← AES 解密密钥（135 个 / 0 MB）
 * ⇒ 只有播放列表有导入价值：它是"打开这个视频"的入口（点节点 → `localPath` → 播放器）。
 *   分片与密钥是**播放器的中间文件**：导进来既不能读、又占 7.68 GB 的扫描账单 ⇒ 单独记 `video-part`。
 *
 * ⚠️ **`.ts` 有歧义**（TypeScript 也是 `.ts`）⇒ **禁止按扩展名一刀切**，判据必须**两侧都成立**：
 *   ① **名字像分片**：扩展名在 `VIDEO_PART_EXT` 里（`.ts` / `.m4s` / `.aac` / `.vtt`），
 *      或是 `.key`（HLS 的 AES 密钥），或是播放列表的备份（`index.m3u8.bak`）；
 *   ② **上下文是 HLS 包**：它所在目录里有 `.m3u8`，或某个祖先目录名以 `.m3u8`/`.m3u` 结尾
 *      （`<课时>/学习中心.m3u8/` 正是后者）。
 *   ⇒ 两侧都成立 ⇒ `video-part`（跳过）。
 *   ⇒ 只成立 ①（例如工程里的 `src/foo.ts`）⇒ **不碰**：按原有规则走（`unsupported-ext` / `--ext` 那套），
 *     绝不会被说成"视频分片" —— 这条是"不许吞掉真的 TypeScript 文件"的判据，两侧各有单测。
 */
const VIDEO_ENTRY_EXT = ['.m3u8', '.m3u'];
/** 只对"HLS 包"里的文件生效的分片类扩展名（见上面两侧判据 ②；单看扩展名什么都不判 ⇒ 调用方必须先判上下文） */
const VIDEO_PART_EXT = ['.ts', '.m4s', '.m4v', '.aac', '.vtt', '.key'];
/** 播放列表的备份（`index.m3u8.bak`）—— 同属分片类，同样要两侧成立 */
const RE_VIDEO_PLAYLIST_BACKUP = /\.(m3u8|m3u)\.(bak|old|tmp|orig)$/i;

/** 这个文件名是不是**视频入口**（播放列表）：扩展名 `.m3u8` / `.m3u` ⇒ 是（大小写不敏感） */
function isVideoEntryName(name) {
  return VIDEO_ENTRY_EXT.indexOf(String(path.extname(String(name || ''))).toLowerCase()) >= 0;
}

/** 这个**目录名**是不是一个 HLS 包（下载器常把包建成 `<名字>.m3u8/`）：名字以 `.m3u8`/`.m3u` 结尾 */
function isVideoBundleName(name) {
  return isVideoEntryName(name);
}

/** 判据本体（**纯函数**：只看名字 + 调用方给的上下文，不碰磁盘 ⇒ 可直接单测）。
 *  @param {string} rel  相对路径（或任何带目录的文件名：只需要它的目录段）
 *  @param {boolean} inBundle 调用方是否已判定"它在 HLS 包里"（同目录有 `.m3u8` / 祖先目录名以 `.m3u8` 结尾）
 *  @returns {'video-part'|null} */
function classifyVideoPart(rel, inBundle) {
  const name = String(rel || '').split('/').pop();
  if (!name) return null;
  if (isVideoEntryName(name)) return null;                  // 播放列表自己是入口，不是分片
  if (!inBundle) return null;                               // 判据 ② 不成立 ⇒ 一律不当分片（见上面那条 ⚠️）
  const ext = String(path.extname(name)).toLowerCase();
  if (VIDEO_PART_EXT.indexOf(ext) >= 0) return 'video-part';
  if (RE_VIDEO_PLAYLIST_BACKUP.test(name)) return 'video-part';
  return null;
}

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
    + '。**没有读它们**（这条上限管的是**人还能不能核对结果**：一次导完几百个文件之后，'
    + '谁都看不出漏了哪一份；它**不是**内存界 —— 内存由"逐文件转换 + 分批"承担，见 ⓪⁸）。出路（三选一）：'
    + '① 明确接受这个量：加 `--max-files ' + count + '`；'
    + '② 分批：按子目录分别导（`import-dir <新项目名> "<目录>\\某个子目录>"`）；'
    + '③ 缩小范围：`--ext md`（先只导文本，docx/pdf 另批处理）或把不需要的部分移出这个目录。';
}

/** **总量超过"单批线"的提示**（注意：**不是拒绝**）。
 *  旧实现这里是"目录合计体量超 64 MB ⇒ 整个拒掉"，而那个 64 MB 本来是**单文件**的闸门
 *  （理由与实测反例见 ⓪′ 末两段 / ⓪⁸）⇒ 现在同一份判据换了含义：超过就**分批**，照样导完。
 *  ⚠️ 报文必须说清"没有拒绝你"：使用者看到 MB 数大于 64 时会以为又要被拒 ✗。 */
function describeDirOversize(dir, totalBytes, limitBytes) {
  const sizeMB = Math.round(Number(totalBytes || 0) / 1048576);
  const limitMB = Math.round(Number(limitBytes || 0) / 1048576);
  return '这个目录里可导入的文件合计约 ' + sizeMB + ' MB，超过**单批** ' + limitMB + ' MB: ' + String(dir)
    + '。⇒ **不拒绝，自动分批**（每批一棵顶层子树；一批打完打一行进度；一个文件本身就超线时它独占一批）。'
    + '整库导入**没有总量上限**：剩下的只有"一次导多少个文件"（`--max-files`，管的是人能不能核对）。'
    + '若要更快看到结果，也可以按子目录分开导（`import-dir <新项目名> "目录/子目录"`）。';
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
    totals: { files: 0, bytes: 0 },
    /** 视频入口（播放列表）的读数：`entries` = 会被导入的 `.m3u8` 个数、`parts` = 因"是分片/密钥/索引"被跳过的个数 */
    video: { entries: 0, parts: 0 }
  };
  const push = (rel, reason, message) => {
    out.skipped.push({ rel: rel, reason: reason, label: SKIP_SHORT[reason] || reason, message: message || null });
    out.counts[reason] = (out.counts[reason] || 0) + 1;
    if (reason === 'video-part') out.video.parts += 1;
  };

  /** 递归走查。返回 'kept' | 'empty' | 'unreadable' | 'nothing' —— 由调用方决定怎么计数 ✓
   *  @param {boolean} inBundle 本目录是否在**HLS 包**里（见 ⓪⁹ 判定②：祖先目录名以 `.m3u8` 结尾，
   *         或本目录里直接有一个 `.m3u8`）—— 它是 `.ts`/`.key` 那条判据的**上下文一侧** */
  const walk = (absDir, relDir, node, inBundle) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (e) { return { code: 'unreadable', detail: (e && e.code) || (e && e.message) || '未说明原因' }; }
    if (!entries.length) return { code: 'empty' };
    // 排序：同输入两次产出**逐字节相同**的树（readdir 的顺序不保证稳定）✓
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // 上下文判据②：**本目录里直接有播放列表** ⇒ 这一层里的 `.ts`/`.key` 是分片（见 ⓪⁹）
    const bundleHere = inBundle || entries.some((x) => x.isFile() && isVideoEntryName(x.name));

    for (const e of entries) {
      const rel = (relDir ? relDir + '/' : '') + e.name;
      const abs = path.join(absDir, e.name);
      // 跳过判据只有一处（`entrySkipReason`）：走查与报告不会各有一套"什么该跳" ✓
      const why = entrySkipReason(e);
      if (why === 'hidden' || why === 'symlink' || why === 'not-regular-file') { push(rel, why); continue; }
      if (why === 'skip-dir') { push(rel, why); continue; }
      if (e.isDirectory()) {
        // `--vault`：`assets/` / `attachments/` 这类**附件库**目录不建容器（只装资源；附件属 P1）。
        // 判据只有这一处（`VAULT_SKIP_DIRS`），报告那一笔在函数末尾（`skippedDirs`）。
        if (o.vault && VAULT_SKIP_DIRS.indexOf(e.name.toLowerCase()) >= 0) { continue; }
        // `abs` 随目录节点一起带下去：建树时**容器节点的 `localPath`** 要用它（见 ⓪⁹ 的 U4）
        const child = { name: e.name, rel: rel, abs: abs, dirs: [], files: [] };
        const r = walk(abs, rel, child, bundleHere || isVideoBundleName(e.name));
        if (r.code === 'kept') { node.dirs.push(child); continue; }
        if (r.code === 'empty') push(rel, 'empty-dir', null);
        else if (r.code === 'unreadable') push(rel, 'unreadable', '读不了这个目录：' + r.detail);
        else if (bundleHere || isVideoBundleName(e.name)) {
          /* HLS 包里的子目录（`index/` 分片、`extk0/` 密钥）里一个可导文件都没有、全是分片 ⇒
           * 记 `video-part` 而不是 `no-importable`：后者会说成"这个目录里没有可导入的文件"，
           * 而真相是"这里只有分片"（原因必须准确，否则使用者会去找一个不存在的格式问题 ✗）。 */
          push(rel, 'video-part', null);
        }
        else push(rel, 'no-importable', null);
        continue;
      }
      if (why) { push(rel, why); continue; }
      if (!e.isFile()) { push(rel, 'not-regular-file'); continue; }
      const extName = path.extname(e.name).toLowerCase();
      /* ⓪⁹ 分片/密钥/索引：**两侧判据都成立**才跳过（只看扩展名会吞掉真的 `.ts` 源码）——
       * 位置在"扩展名白名单"**之前**：否则 `.ts` 会先被记成 `unsupported-ext`，
       * 于是"因为是视频分片而跳过"这件事在报告里根本看不出来（而它正是用户要的那条读数 ✗）。 */
      const partWhy = classifyVideoPart(rel, bundleHere);
      if (partWhy) { push(rel, partWhy, extName ? ('扩展名 ' + extName) : '播放列表的备份'); continue; }
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
      if (isVideoEntryName(e.name)) out.video.entries += 1;
    }
    return { code: (node.dirs.length || node.files.length) ? 'kept' : 'nothing' };
  };

  const r = walk(rootAbs, '', out.tree, false);
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
  /* `--vault` 时按名字跳过附件库目录（P0 边界：附件本身属 P1）—— **另记一笔**（`skippedDirs`），
   * 不计进 `counts`（否则报告里会出现一份"因为设了 --vault 才存在"的跳过数，与没设时对不上）。 */
  if (o.vault) {
    out.skippedDirs = VAULT_SKIP_DIRS.filter((name) => {
      try { return fs.statSync(path.join(rootAbs, name)).isDirectory(); } catch (e) { return false; }
    });
  }
  return out;
}

/**
 * **分批计划**（纯函数：只吃 `scanImportDir` 的清单，不碰磁盘）—— 整库导入用它把
 * "一次全导"切成若干批。
 *
 * 为什么要切成批（而不是干脆不限量一路导下去）：见 ⓪⁸。一句话 —— 目录没有总量上限了，
 * 但**几十分钟的导入不能一声不响**：批是**进度单位**（每批打完打一行）。
 *
 * ⚠️ **批的粒度只能是"顶层条目"**（顶层子目录 / 根下的一组文件），**不许往里钻** ——
 *   这是结构正确性，不是偷懒：钻进去就得把祖先容器（比如「01-AGIC超级个体必修课」）复制到
 *   每一批里，于是同一个目录会在树里出现**多个同名容器节点**；要修就得在拼装时按 rel 合并，
 *   那是给"镜像文件夹"这个唯一卖点加一层易错逻辑。⇒ 取舍：**一批 = 一棵完整顶层子树**；
 *   单个顶层子树很大（比如用户那份 7.8 GB 的课程目录：6 个顶层课程，最大 2.4 GB）⇒ 它自己就是一批，
 *   内部**不再拆**，改由逐文件进度（`buildDirImportTree` 的 `onFile`）保证"看得见它在动"。
 *   ⚠️ 所以 `MAX_IMPORT_BATCH_MB` / `MAX_IMPORT_BATCH_FILES` 是**"批应该在多大"的说明性线**：
 *   超过它只会在报告里标一句 `over`，**既不拆批也不拒绝**（拒绝线只有 `--max-files` 那条）。
 *
 * 三条硬性质（单测逐条钉住）：
 *   ① **配平**：每个可导入文件**恰好**落在一批里（既不丢、也不重复）；
 *   ② **可复现**：同一份 scan ⇒ 同一份批计划（目录在前、文件在后，各自按名字码位排序，
 *      与 `scanImportDir` 的排序同一口径）；
 *   ③ **顺序即树的顺序**：按批拼装出来的 `children` 与"不分批一次建完"**逐字节同序**。
 * @param {object} scan `scanImportDir` 的结果
 * @param {{maxBytes?:number, maxFiles?:number}} [opts] 缺省 = `MAX_IMPORT_BATCH_BYTES` / `MAX_IMPORT_BATCH_FILES`
 * @returns {Array<{rel:string, name:string, bytes:number, files:number, over:boolean,
 *                  dirs:Array, fileList:Array, roots:Array}>}
 *   `dirs` / `fileList` = 这一批要建树的**子树切片**（交给 `buildDirImportTree` 的那一份 `scan.tree`）；
 *   `roots` = 这一批在最终树里的顶层主题名（回显用，不含 id）；`over` = 超过说明性线（只用于报告）。
 */
function planImportBatches(scan, opts) {
  const o = opts || {};
  const maxBytes = (typeof o.maxBytes === 'number' && o.maxBytes > 0) ? o.maxBytes : MAX_IMPORT_BATCH_BYTES;
  const maxFiles = (typeof o.maxFiles === 'number' && o.maxFiles > 0) ? o.maxFiles : MAX_IMPORT_BATCH_FILES;
  const tree = (scan && scan.tree) || { dirs: [], files: [] };
  const bytesOf = (f) => (f && f.size) || 0;
  /** 一个子树（含所有后代）的合计 */
  const sumOf = (node) => {
    let bytes = 0, files = 0;
    const walk2 = (n) => {
      n.files.forEach((f) => { bytes += bytesOf(f); files += 1; });
      n.dirs.forEach(walk2);
    };
    walk2(node);
    return { bytes: bytes, files: files };
  };
  /** 收成一批（`dirs` / `fileList` 就是 `buildDirImportTree` 认的那份切片） */
  const asBatch = (rel, name, dirs, fileList) => {
    let bytes = 0, files = 0;
    fileList.forEach((f) => { bytes += bytesOf(f); files += 1; });
    dirs.forEach((d) => { const s = sumOf(d); bytes += s.bytes; files += s.files; });
    return {
      rel: rel, name: name, bytes: bytes, files: files,
      over: (bytes > maxBytes || files > maxFiles),          // **只是标记**（不拆批、不拒绝）
      dirs: dirs, fileList: fileList,
      roots: dirs.map((d) => d.name).concat(fileList.map((f) => f.name.replace(/\.[^.]+$/, '')))
    };
  };
  const out = [];
  // ① 每个**顶层子目录**一批（完整子树，绝不往里钻 —— 理由见上面 ⚠️）
  tree.dirs.forEach((d) => {
    const b = asBatch(d.rel || d.name, d.name, [d], []);
    if (b.files) out.push(b);            // 没有可导入文件的子树在 scan 里本来就已经被剔掉了（防空批）
  });
  // ② **根下的文件**合成一批（它们本来就是树的最后一段，顺序与"不分批"一致）
  if (tree.files.length) out.push(asBatch('', '', [], tree.files));
  return out;
}

/** 一批 → 交给 `buildDirImportTree` 的那份 **scan 形状**（只换树，别的一律沿用：ext / root / 计数基线）。
 *  为什么要有这个薄包装：`buildDirImportTree` 的唯一入口是"吃 scan、吐子树"，
 *  批切片必须还是那个形状 ⇒ 不新造第二条建树路（见 ⓪‴ 的"建树唯一入口"）。 */
function scanSliceOf(scan, batch) {
  const b = batch || {};
  return Object.assign({}, scan, {
    tree: { name: (scan && scan.tree && scan.tree.name) || '', rel: '', dirs: b.dirs || [], files: b.fileList || [] }
  });
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

/* ---------------- ⓪⁹b 视频节点："通过链接指向文件"，不内嵌、不拷贝 ----------------
 * 节点只做三件事：① 标题（这一节课的视频叫什么）② `localPath` = 本机 `.m3u8` 的绝对路径
 * （点它就用系统播放器打开 —— `localPath` 本来就是本格式里**唯一**的绝对路径字段，
 * 见 `docs/DATA-FORMAT.md` §2.5；**不新造字段**：新造一个就是同一件事的第二种表达 ✗）
 * ③ 一句"大概的详情"（**不是正文**：.m3u8 本身是播放器脚本，粘进详情没有意义）。
 *
 * `localPath` 的长度上限与 `src/path-chain.js` / `src/schema.js` 同一口径（500）；超长就不挂
 * （挂上去会让**整次写盘**被 schema 拒掉 ⇒ 一份超长路径会毁掉整个导入，那是把小概率变成全灭 ✗），
 * 并计一笔 `localPathSkipped` 如实报出来。
 */
const LOCAL_PATH_MAX = 500;

/** 播放列表里**便宜读得到**的事实（纯函数）：分片数 / 时长（按 `#EXTINF` 累加）/ 是否加密 */
function videoPlaylistFacts(text) {
  const s = String(text || '');
  const segs = s.match(/#EXTINF\s*:\s*([0-9.]+)/g) || [];
  let seconds = 0;
  segs.forEach((m) => {
    const v = parseFloat(m.replace(/#EXTINF\s*:\s*/, ''));
    if (isFinite(v) && v > 0) seconds += v;
  });
  const keyLine = /#EXT-X-KEY\s*:\s*(.+)/.exec(s);
  return {
    segments: segs.length,
    seconds: Math.round(seconds),
    encrypted: !!(keyLine && !/METHOD\s*=\s*NONE/i.test(keyLine[1]))
  };
}

/** 秒 → `mm:ss` / `h:mm:ss` */
function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  const pad = (x) => (x < 10 ? '0' + x : String(x));
  return (h ? (h + ':' + pad(m)) : String(m)) + ':' + pad(s);
}

/** 视频节点的"大概的详情"（Markdown 片段；由调用方交给**同一个** `markdownToHtml` 转换） */
function videoDetailMd(facts, fileLabel) {
  const f = facts || { segments: 0, seconds: 0, encrypted: false };
  const lines = [];
  lines.push('**视频（HLS 播放列表）**：`' + String(fileLabel || '.m3u8') + '`。'
    + '它不是文档 ⇒ 树里只放"打开它的入口"（节点字段 `localPath` 指向本机的这一份）。');
  if (f.segments > 0) {
    lines.push('分片 ' + f.segments + ' 个（合计时长约 **' + formatDuration(f.seconds) + '**，按播放列表的 `#EXTINF` 累加）。');
  } else {
    lines.push('没读到 `#EXTINF` ⇒ 可能不是标准 HLS 播放列表，或这份下载没下完（**文件本身在，点开仍由播放器判断**）。');
  }
  if (f.encrypted) lines.push('这份播放列表带 `EXT-X-KEY`（AES 加密）：密钥文件按"没有意义"跳过了，播放器会自己按播放列表去取。');
  lines.push('同类文件里的**分片 / 密钥 / 索引**（`index/` 下的 `.ts`、`extk0/` 下的 `.key`）**没有导入**：'
    + '它们只对播放器有意义（见报告里的 `视频分片/密钥/索引` 计数）。');
  lines.push('打开：右键节点「打开文件夹」，或用详情里的本机路径链接（交给系统默认程序）。');
  return lines.join('\n\n');
}

/**
 * 目录 → 容器树（**建树唯一入口**：每个文件都走 `docToOutline`，每棵子树都由 `markdownToTree` 建）。
 * 整棵树在**内存里**建好再交给调用方一次性落盘 ⇒ 中途失败不会留下半个项目 ✓
 * ⚠️ **分批**在调用方（`cli/commands/project.js` 的 `importDir` 按 `planImportBatches` 逐批调本函数、
 *    再把子树拼起来）—— 本函数永远只看"给它的那一份 scan"，所以一份 scan 切片 = 一批 ✓
 *
 * @param {object} scan `scanImportDir` 的结果
 * @param {{genId?:Function, at?:string, tool?:string,
 *          only?:Set<string>, transform?:Function, collect?:Function}} [opts]
 *   · `only`      = 增量（R4 绑定同步用）：只处理 `rel` 命中的文件（缺省全量，行为与从前逐字节相同）
 *   · `transform` = **建树之前**对正文的一道转换（**只有 ⓪⁶ 的 Obsidian 直进在用**：
 *     `transform(fileInfo, 原文) → 新的正文`）。为什么要有这个口子：wiki 语法必须在
 *     `markdownToTree` **之前**消化掉（`[[页]]` 要变成能承载落点的 Markdown 链接），而"文件 → 提纲"
 *     这一段就发生在本函数里；把它挪出去会让调用方自己再走一遍 **同一个 `docToOutline`**（读两遍盘）。
 *     缺省不给 ⇒ `docToOutline` 的输出**原样**交给建树（默认档一个字节都不变 ✓）。
 *   · `collect`   = **逐条**收集建树过程中被造出来的节点（报告要"逐条点名"时用；缺省不收集）
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
  /* 正文的一道转换（**只有 Obsidian 直进在用**，见 `applyVault`）：不给 ⇒ 下面一行就是
   * `const md = normalizeOutline(conv.md)`，与从前**逐字节相同**。 */
  const transform = (typeof o.transform === 'function') ? o.transform : null;
  const built = {
    children: [], nodes: 0, containers: 0, files: 0, entries: [], skipped: [], preambles: 0,
    refTargets: [],
    /** 视频入口节点数（`.m3u8`：节点 + `localPath`，**不走** docToOutline） */
    videos: 0,
    /** 因为路径超过 `LOCAL_PATH_MAX` 而**没有挂** `localPath` 的节点数（如实报，不静默丢 ✗） */
    localPathSkipped: 0,
    /* **这一趟真的读/转换了几个文件**（`only` 之外的那些不算）—— 判据用它量"增量"：
     * 增量性**只看树是判不出来的**（全量重建之后树的最终状态一个字都不差，差别只在"读了几个文件"），
     * 所以读数必须交出去；绑定的同步计划把它转成 `plan.readFiles`（见那里的注释与 B2/B2b 两条判据）。 */
    readFiles: 0
  };

  /** 给节点挂**本机路径**（U4："通过链接指向文件"，不内嵌不拷贝）—— 见 ⓪⁹b 的长度口径 */
  const setLocalPath = (node, p) => {
    const s = String(p || '');
    if (!s) return false;
    if (s.length > LOCAL_PATH_MAX) { built.localPathSkipped += 1; return false; }
    node.localPath = s;
    return true;
  };

  /** **视频入口**（`.m3u8`）→ 节点 + 目录项。⚠️ 它**不走** `docToOutline`（播放列表不是文档）：
   *  节点 = 标题 + `localPath`（本机文件）+ 一句"大概的详情"。 */
  const buildVideoNode = (f, topicWanted) => {
    built.readFiles++;
    // 逐文件进度（命令层用它防"长时间一声不响"；**不进落盘数据**）
    if (typeof o.onFile === 'function') o.onFile({ rel: f.rel, index: built.readFiles, format: 'video' });
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); }
    catch (e) {
      built.skipped.push({ rel: f.rel, reason: 'read-failed', label: SKIP_SHORT['read-failed'],
        message: String((e && e.message) || e) });
      return null;
    }
    const topic = String(topicWanted || f.name.replace(/\.[^.]+$/, ''));
    const node = {
      id: genId(topic), topic: topic, expanded: false, children: [],
      detail: convert.markdownToHtml(videoDetailMd(videoPlaylistFacts(text), f.name)),
      /* 来源指纹：与文档节点**同一个**入口（`src` + 内容 sha256）⇒ "这份播放列表导过没有"
       * 在**文件**一级同样答得出来，重复导入照样被闸门拦住 ✓ */
      origin: makeOrigin({ file: f.abs, md: text, at: at, tool: tool })
    };
    setLocalPath(node, f.abs);
    built.nodes++; built.files++; built.videos++;
    built.entries.push({
      rel: f.rel, name: f.name, id: node.id, topic: topic,
      sha256: node.origin.sha256, origin: node.origin, format: 'video',
      abs: f.abs, node: node
    });
    if (typeof o.collect === 'function') o.collect({ rel: f.rel, node: node, format: 'video' });
    return node;
  };

  const walk = (node, depth) => {
    const children = [];
    // 目录在前、文件在后（与资源管理器同序），两层各自按名字排 ⇒ 结构稳定可复现 ✓
    node.dirs.forEach((sub) => {
      /* ⓪⁹ **视频包折叠**：下载器把一节课建成了一个名叫 `<名字>.m3u8/` 的目录，
       * 里面只有一个播放列表（`index.m3u8`），其余全是分片/密钥（扫描阶段已跳成 video-part）。
       * ⇒ 不为它单画一层容器（否则树上会出现 `学习中心(学习中心)` 这种同名的两层），
       * 直接把它做成父节点下的**一个视频节点**，标题取目录名去掉 `.m3u8`。
       * 判据：目录名是视频包 + 里面**恰好一个**可导入的播放列表 + 没有别的子目录
       * （多播放列表 / 还有别的子目录 ⇒ 不折叠，照常建容器，宁可不漂亮也不丢东西 ✗）。 */
      if (isVideoBundleName(sub.name)) {
        const playlists = sub.files.filter((x) => wanted(x) && isVideoEntryName(x.name));
        if (playlists.length === 1 && !sub.dirs.length) {
          const vn = buildVideoNode(playlists[0], sub.name.replace(/\.[^.]+$/, ''));
          if (vn) children.push(vn);
          return;
        }
      }
      // 【折叠默认】容器节点是新节点 ⇒ 显式 `expanded:false`（原来 `depth+1<=2` = 前两层展开）。
      // 规则的落点说明见 `src/markdown.js` 的 openNode：只有"根"保持展开，而根是**调用方那棵树**
      // 的根（`cli/commands/project.js` 建项目时写的），本函数造出来的一律折叠 ✓
      const container = { id: genId(sub.name), topic: sub.name, expanded: false, children: [] };
      // U4：容器节点也指向**真实目录**（点开就是资源管理器里的那个文件夹）——
      // 这正是 `docs/DATA-FORMAT.md` §2.5 给 `localPath` 写的那个用处（示例就是一个目录）✓
      setLocalPath(container, sub.abs);
      container.children = walk(sub, depth + 1);
      // 子目录里所有文件都在转换阶段失败了 ⇒ **不画空容器**（那些失败已逐条计入 read-failed ✓）
      if (!container.children.length) return;
      built.nodes++; built.containers++;
      children.push(container);
    });
    node.files.forEach((f) => {
      if (!wanted(f)) return;                       // 增量：不在本次范围内的文件不读取、不建子树
      // ⓪⁹ 视频入口：节点 + localPath（**不解析正文**）—— 放在 docToOutline 之前，别让它去当文档读
      if (isVideoEntryName(f.name)) {
        const vnode = buildVideoNode(f, null);
        if (vnode) children.push(vnode);
        return;
      }
      built.readFiles++;                            // 读数：这一趟真读的文件（增量判据的唯一依据）
      if (typeof o.onFile === 'function') o.onFile({ rel: f.rel, index: built.readFiles, format: null });
      let conv = null;
      try { conv = docToOutline(f.abs); }
      catch (e) {
        built.skipped.push({ rel: f.rel, reason: 'read-failed', label: SKIP_SHORT['read-failed'],
          message: String((e && e.message) || e) });
        return;
      }
      const md = normalizeOutline(transform ? transform(f, conv.md) : conv.md);   // docToOutline 已经规范化过；这里再过一次是**同一份**函数（幂等）
      const topic = f.name.replace(/\.[^.]+$/, '');
      const fileNode = {
        // 【折叠默认】文件节点同理：新节点显式 `expanded:false`（原来 `depth+1<=2`）
        id: genId(topic), topic: topic, expanded: false, children: [],
        // 每个文件节点都带来源指纹：这样"这份文件导过没有"在**文件**一级也答得出来
        //（别的命令把同一个文件导到别处时，闸门也认得出）
        origin: makeOrigin({ file: f.abs, md: md, at: at, tool: tool })
      };
      /* U4：**文档节点也指向真实文件**（"通过链接指向文件即可"）—— 内容照样进了树（正文/详情），
       * `localPath` 只是"这一份是哪台机器上的哪个文件"的入口，不是替代品。 */
      setLocalPath(fileNode, f.abs);
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
        sha256: fileNode.origin.sha256, origin: fileNode.origin, format: conv.format,
        /* ⚠️ 下面两个是**给程序看的**（`applyVault` 的解析与报告要用节点本身 + 这个文件的绝对路径），
         * **不进任何落盘数据、也不进 `--json` 报告**（CLI 自己映射报告字段时只取白名单里的那几个键）。
         * 放在这里而不是让调用方再走一遍树：那就是"同一件事两处算"的源头 ✗ */
        abs: f.abs, node: fileNode
      });
      if (typeof o.collect === 'function') o.collect({ rel: f.rel, node: fileNode, format: conv.format });
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

/**
 * **分批建树**（整库导入的正式入口）：按 `planImportBatches` 逐批调 `buildDirImportTree`，
 * 再把各批的子树 / 目录项 / 跳过 / 引用落点**按批序拼起来**。
 *
 * 为什么要有它（而不是让命令层自己 for 循环）：拼装有**四条不变量**，每条都能安静地弄坏结果 ——
 *   ① **id 生成器跨批共用**（每批各摇一个 ⇒ 批与批之间可能撞 id，而 schema 判"全树 id 唯一" ⇒ 整次导入失败）；
 *   ② **`at` 共用一份**（同一次导入的来源时间应该一致；每批各取一次 `now` 会让同一棵树里出现几十个不同时刻）；
 *   ③ **顺序 = 不分批时的顺序**（目录在前、文件在后；批按 `planImportBatches` 的稳定序）；
 *   ④ **计数要累加而不是覆盖**（`nodes` / `containers` / `files` / `readFiles` / `videos` / `preambles` …）。
 * ⇒ 这四条写在这里一次，命令层只负责打印与写盘（它要是自己拼，就变成"同一件事两处算" ✗）。
 *
 * @param {object} scan `scanImportDir` 的结果
 * @param {object} [opts] 透传给 `buildDirImportTree`（`tool` / `transform` / `collect` / `only` …）
 *   · `plan`     = 复用一份已算好的批计划（命令层要拿它做预览，免得算两遍）
 *   · `onBatch`  = `(info, index, total)` 每批结束回调（进度行用它；**不进落盘数据**）
 *   · `onFile`   = `(info)` 透传给 `buildDirImportTree` 的逐文件进度
 *   · `builder`  = **只给判据用的缝**：缺省就是 `buildDirImportTree`。存在的唯一理由是把
 *     "**每批一次**建树、且每批只拿到自己那批文件"这条性质变成**可断言**的东西
 *     （模块内部的函数调用骗不过 `vi.spyOn`，只能靠注入；没有这条缝，这条性质就只能靠读代码）。
 *     生产路径**不传**它 ⇒ 走的就是默认那个函数 ✓
 * @returns 与 `buildDirImportTree` **同形状**的对象，另加 `batches: Array<{name,files,bytes,nodes,containers,over,ms}>`
 */
function buildDirImportTreeBatched(scan, opts) {
  const o = opts || {};
  const plan = (Array.isArray(o.plan) && o.plan.length) ? o.plan : planImportBatches(scan, o);
  const genId = o.genId || uniqueIdGen();                 // ① 跨批共用（见上）
  const at = o.at || new Date().toISOString();            // ② 共用一份（见上）
  const builder = (typeof o.builder === 'function') ? o.builder : buildDirImportTree;   // 见 `builder` 那条说明
  const merged = {
    children: [], nodes: 0, containers: 0, files: 0, entries: [], skipped: [], preambles: 0,
    refTargets: [], videos: 0, localPathSkipped: 0, readFiles: 0, batches: []
  };
  plan.forEach((b, i) => {
    const t0 = Date.now();
    const one = builder(scanSliceOf(scan, b), Object.assign({}, o, { genId: genId, at: at, builder: undefined }));
    // ③ 顺序：按批序 concat（plan 的序已是"目录在前、文件在后"，与不分批同一口径）
    merged.children = merged.children.concat(one.children);
    merged.entries = merged.entries.concat(one.entries);
    merged.skipped = merged.skipped.concat(one.skipped);
    merged.refTargets = merged.refTargets.concat(one.refTargets);
    // ④ 计数累加
    merged.nodes += one.nodes; merged.containers += one.containers; merged.files += one.files;
    merged.preambles += one.preambles; merged.videos += one.videos;
    merged.localPathSkipped += one.localPathSkipped; merged.readFiles += one.readFiles;
    const info = {
      name: b.name || '（根下的文件）', files: one.files, nodes: one.nodes,
      bytes: b.bytes, containers: one.containers, over: !!b.over, ms: Date.now() - t0
    };
    merged.batches.push(info);
    if (typeof o.onBatch === 'function') o.onBatch(info, i, plan.length);
  });
  return merged;
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

/* ================= ⓪⁶ Obsidian 库直进（W12 P0）：目录 → 树 + `[[wikilink]]` → **既有** links/assoc =================
 * 目标（待做清单 W12 一节，P0）：把「一个 Obsidian 库（vault）」直接变成导图内容 ——
 *   ① **目录结构**：走**既有** `scanImportDir` + `buildDirImportTree`（本段不另写目录遍历/建树 ✗）；
 *   ② **wiki 语法**：`[[页]]` / `[[页|别名]]` / `[[页#标题]]` 解析成**节点与关联**，`![[嵌入]]` 同样识别；
 *   ③ **frontmatter**：`tags` / `aliases` / 其它键（按**既有**标签机制落 `node.tags`）；
 *   ④ **同一次导入内的链接接成"关联"**：**复用既有 `links[]`**（`link` 命令写的同一种字段），
 *      不新造关系类型、不动 schema ✗；
 *   ⑤ **转不了/断链的逐条点名**（铁律②）：一条坏链接不拖垮整批，但**绝不静默丢** ✗。
 *
 * ## 落点契约（W12 一节没写死"落到哪个字段" ⇒ 契约句写在这里，并登记进 `docs/DATA-FORMAT.md`）
 *   · 链接**发源** = 那个 `.md` 文件的**文件节点**（`buildDirImportTree` 造的那个 —— 一个文件在这棵
 *     树里的代表节点）。理由：wiki 链接是**整篇笔记**的属性，而文件节点正是"这篇笔记"。
 *   · 链接**目标** = 同一个 vault 里另一篇笔记的**文件节点**；带 `#标题` 片段时 = 那篇笔记里**对应标题的
 *     子节点**（段落形态的片段按层级路径逐层降级匹配）。
 *   · 落 **`links[]`**：`{ project: <本次导入的项目名>, id: <目标节点 id>, caption: '<源节点标题>：[[原样写法]]' }`
 *     —— `project` 指向**本项目**（`src/schema.js` 的 `validateProject(data, root, selfProject)`
 *     明确支持同项目 `(project, id)`：同项目成员以"即将落盘的那份 data"为真值判存在 ⇒ 刚建的节点当轮就认）。
 *   · **绝不留悬空**：目标不在本次导入范围内 ⇒ **一条链接都不写**，只进报告的 `dangling[]`（逐条点名）。
 *     这份选择是硬的：写一条指向不存在节点的 `links` 会让**整个项目所有写命令**被校验闸门挡住
 *     （`docs/DATA-FORMAT.md` §2.5/§2.6 的悬挂检查），那才是真的"导入即坏库" ✗。
 *   · 别名（`[[页|别名]]`、frontmatter `aliases`）**不能**替目标节点的标题（改标题是另一件事）：
 *     它进**报告**（`links[].alias`）与链接的 `caption`，并在**解析时**当目标候选名之一。
 *   · 附件/图片 `![[…]]` ⇒ 走**既有资源管线**（`markdown.resolveImportRefs`，与 `add-image` 同一处命名/格式
 *     闸门）：能落成项目内文件就落 `files[]`（附件），落不了就**按正文保留 + 逐条点名**（口径同整库导入）。
 *   · 笔记嵌入 `![[另一篇笔记]]` ⇒ 本段**不做 transclusion**（W12 明确不做"嵌入"那一档）：
 *     按"链接"处理（同上面的落点）+ 报告里标成 `embed-note`，**原文一字不动**。
 *
 * ## 三件不做（P0 边界，与 W12 一节逐条对齐）
 *   ① **不做** transclusion（笔记嵌入的正文合并）；② **不做**反向同步（本工程 → Obsidian）；
 *   ③ **不做** daily notes / 插件语法（Dataview / Templater 之类）。
 *   `#^块引用` / `[[页#^anchor]]` 这类**认得出但转不了**的 ⇒ 走"逐条点名"那一档（不是静默丢）。
 *
 * ## 入口：为什么挂在**既有** `import-dir` 上（不许另起一条导入链 ✗）
 *   vault 就是"一个目录"，而"目录 → 树"那条链（扫描/闸门/容器/文件节点/来源指纹/资源引用/一次原子写）
 *   已经全部存在。另写一条 `import-vault` 会让上面每一条都出现**第二份表达** —— 本工程反复治的就是这个。
 *   ⇒ 加一个 `--vault` 开关（缺省关 ⇒ 与从前**逐字节相同**），它只多两件事：这一段的解析 + 报告。
 */

/** frontmatter 里认得的**标签键**（Obsidian 两种都常见）。其余键一律**不落盘**，只在报告里列出来。 */
const VAULT_TAG_KEYS = ['tags', 'tag'];
/** Obsidian 每个库根上的配置目录 —— **`--vault` 的识别判据**（缺省档一个字节都不看它）。 */
const VAULT_CONFIG_DIR = '.obsidian';
/** 这个目录是不是一个 Obsidian 库（识别只有这一处实现：CLI 的 `--vault`、界面选目录、单测都问它）。 */
function isVaultDir(dir) {
  try { return fs.statSync(path.join(String(dir), VAULT_CONFIG_DIR)).isDirectory(); }
  catch (e) { return false; }
}/** 认得的**别名键**（`[[别名]]` 能解析到这篇笔记）。 */
const VAULT_ALIAS_KEYS = ['aliases', 'alias'];
/** `--vault` 时**不建容器**的目录名（附件库、Obsidian 自己建的导出目录）：它们只装资源（P1 才进树）。
 *  只认这几个**众所周知**的名字 —— 不在这里开一个可配置的忽略表（那是 `--ignore` 的活，本批不做）。 */
const VAULT_SKIP_DIRS = ['assets', 'attachments'];
/** 段落形态的标题片段（`#一 段 落`）最多按几层匹配：再多就不猜了（进"认不出"那一档，逐条点名） */
const VAULT_MAX_HEADING_DEPTH = 6;

/* ---- ① frontmatter：解析（**不改写正文**：原样返回正文，调用方决定要不要截断） ---- */
/**
 * 解析 md 开头的 YAML frontmatter（**最小子集**：`key: value` / 块级 `- item` 列表）。
 * @returns {{has:boolean, fields:object, warns:string[], body:string}}
 *   `body` = **去掉 frontmatter 之后**的正文（没有 frontmatter ⇒ 与入参**逐字节相同**）。
 *   `warns` = 认得出但没照字面读的项（**逐条点名**，不许静默 ✗）。
 * 边界（写在这里，别让后来人猜）：只认 `---` 起、`---` 止的**首行块**；嵌套映射/多行块标量/锚点
 * 一律按"认不出的行"处理（跳过 + 进 `warns`），**绝不猜**（猜错的代价是把别人的值写进标签 ✗）。
 */
function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blank = { has: false, fields: {}, warns: [], body: src };
  if (!lines.length || lines[0].trim() !== '---') return blank;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) { blank.warns.push('开头是 `---` 但没找到收尾的 `---`（按"没有 frontmatter"处理）'); return blank; }
  const fields = {};
  const warns = [];
  /** 当前 key 的块级列表（`key:` 换行后跟 `- item`） */
  let listKey = null;
  /** 上一行 key 的**缩进宽度**：用来判"这一行是不是嵌套映射"（更深的缩进一律不当新键） */
  let keyIndent = 0;
  const pushItem = (k, v) => {
    if (!Array.isArray(fields[k])) fields[k] = fields[k] === undefined ? [] : [fields[k]];
    fields[k].push(v);
  };
  const unquote = (s) => {
    if (s.length >= 2 && s.charAt(0) === s.charAt(s.length - 1) && (s.charAt(0) === '"' || s.charAt(0) === "'")) {
      return s.slice(1, -1);
    }
    return s;
  };
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.charAt(0) === '#') continue;
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    if (t.charAt(0) === '-') {                       // 块级列表项
      if (!listKey) { warns.push('第 ' + (i + 1) + ' 行是列表项，但它上面没有 key（已跳过）'); continue; }
      pushItem(listKey, unquote(t.replace(/^-\s*/, '').trim()));
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(t);
    /* ⚠️ 缩进更深的一行**不当新键**：`nested:\n  a: 1\n` 里的 `a: 1` 是**嵌套映射的内容**，
     * 照字面收下会把 `a` 变成 frontmatter 的一个键（实测：那份值会被人当成"这篇的元数据"读走 ✗）。
     * 最小子集**不认嵌套** ⇒ 跳过 + 逐条点名（**不猜**：猜错的代价是把别人的值写进标签）。 */
    if (m && indent > keyIndent && i > 1) {
      warns.push('第 ' + (i + 1) + ' 行缩进更深（' + m[1] + '）—— 嵌套映射本子集不认，已跳过');
      continue;
    }
    if (!m) { warns.push('第 ' + (i + 1) + ' 行认不出（既不是 key: value 也不是列表项）：' + t.slice(0, 40)); continue; }
    const key = m[1], val = m[2].trim();
    listKey = null;
    keyIndent = indent;
    if (val === '') { listKey = key; fields[key] = []; continue; }   // 空值 ⇒ 可能是块级列表的开头
    if (val.charAt(0) === '[' && val.charAt(val.length - 1) === ']') {   // 行内列表 `[a, b]`
      const items = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      if (fields[key] !== undefined) { warns.push('键 ' + key + ' 重复出现 ⇒ 用行内列表覆盖了前一个值'); }
      fields[key] = items;
      continue;
    }
    if (fields[key] !== undefined) { warns.push('键 ' + key + ' 重复出现 ⇒ 用后一个值覆盖了前一个'); }
    fields[key] = unquote(val);
  }
  const body = lines.slice(end + 1).join('\n');
  return { has: true, fields: fields, warns: warns, body: body };
}

/** 取某个键的字符串列表（**两种写法都认**：数组 / 逗号或顿号分隔的串）。
 *  ⚠️ 这里用的是**全工程既有**那一套写法（与 `cli/commands/edit.js` 的 `--tags "a,b"` 同一份口径：
 *     先按 `,` / `，` 切、再 trim、再剔空）——不另立第二套"标签分隔符"规矩。 */
function fieldList(fields, keys) {
  for (const k of keys) {
    const v = (fields || {})[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const out = [];
      v.forEach((x) => { String(x).split(/[,，]/).forEach((s) => { const t = s.trim(); if (t) out.push(t); }); });
      return dedupe(out);
    }
    const out = [];
    String(v).split(/[,，]/).forEach((s) => { const t = s.trim(); if (t) out.push(t); });
    return dedupe(out);
  }
  return [];
}

/** 去重但**保序**（报告与落盘都要能复现：同输入必得同一份顺序） */
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  (arr || []).forEach((x) => { const s = String(x); if (s && !seen.has(s)) { seen.add(s); out.push(s); } });
  return out;
}

/** 标签名规范化：Obsidian 的 `#工具` 与 `tags: [工具]` 是**同一件事** ⇒ 统一去掉前导 `#`。 */
function normalizeVaultTags(list) {
  const out = [];
  (list || []).forEach((raw) => {
    const s = String(raw).trim().replace(/^#+/, '').trim();
    if (s) out.push(s);
  });
  return dedupe(out);
}

/** 给节点加标签（**既有字段** `node.tags`）：该节点原有标签**保留**（并集、保序），
 *  与入参无交集时**一个字节都不写**（默认档与"没有标签的笔记"都不受影响 ✓）。 */
function addNodeTags(node, tags) {
  if (!node || !tags || !tags.length) return false;
  const have = Array.isArray(node.tags) ? node.tags.slice() : [];
  const add = tags.filter((t) => have.indexOf(t) < 0);
  if (!add.length) return false;
  node.tags = have.concat(add);
  return true;
}

/* ---- ② wiki 语法识别（一处实现：识别、解析、找落点都在本段） ---- */
const WIKI_SCHEME = 'mm-obsidian:';    // 链接 href 的标记（**不是文件路径** ⇒ 解析期一眼分得出）
const WIKI_FENCE_RE = /^\s*(```|~~~)/; // 围栏代码块的行首标记

/**
 * 把正文里的 wiki 语法**解析成两样东西**（纯函数，不读盘、不建树）：
 *   · `md`     = 转换后的正文（`[[…]]` → 标准 Markdown 链接，`![[…]]` → 既有资源行或链接）
 *   · `tokens` = **逐条**的原始写法与解析结果（报告、落点解析、逐条点名都用它）
 * 围栏代码块里的内容**一律不动**（sibling 显式声明：代码块里出现 `[[…]]` 是**代码**，不是链接）。
 * @returns {{md:string, tokens:Array}}
 */
function convertWikiSyntax(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const tokens = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (WIKI_FENCE_RE.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence || line.indexOf('[[') < 0) { out.push(line); continue; }   // 快速跳过：绝大多数行没有 wiki 语法
    let res = '';
    let i = 0;
    while (i < line.length) {
      const open = line.indexOf('[[', i);
      if (open < 0) { res += line.slice(i); break; }
      const close = line.indexOf(']]', open + 2);
      if (close < 0) { res += line.slice(i); break; }
      const isEmbed = open > 0 && line.charAt(open - 1) === '!';
      const inner = line.slice(open + 2, close).trim();
      const shown = parseWikiInner(inner);
      // `[[   ]]` 完全空 ⇒ 原样；只给片段（`[[#标题]]`）**要认**（目标是空的、片段就是落点线索）
      if (!shown.target && !shown.heading) { res += line.slice(i, close + 2); i = close + 2; continue; }
      res += line.slice(i, isEmbed ? open - 1 : open);   // 嵌入时把那个 `!` 也吃掉（它就是语法的一部分）
      const tok = {
        raw: (isEmbed ? '![[' : '[[') + inner + ']]',
        embed: isEmbed,
        target: shown.target,
        heading: shown.heading,
        display: shown.display
      };
      if (isEmbed && looksLikeResourceRef(shown.target)) {
        /* 附件/图片：**走既有资源行语法** ⇒ 由 `markdown.resolveImportRefs`（唯一实现）落地
         * （解析路径、格式闸门、复制命名、坏引用降级成正文，全部与 add-image / 整库导入同一处）。
         * ⚠️ 这一行的**写法**也必须是那一处：`markdown.resourceLine` 是"资源行语法"的唯一权威
         * （导入/导出成对）⇒ 这里**不手抄**那份语法（抄一份必然与它漂移 ✗）。 */
        tok.kind = 'resource';
        res += markdown.resourceLine('file', toPosixPath(shown.target),
          oneLine(shown.display || shown.target, shown.target));
      } else {
        tok.kind = isEmbed ? 'embed-note' : 'link';       // 笔记嵌入不展开（P0 边界）⇒ 按链接处理
        res += wikiMdLink(shown);
      }
      tokens.push(tok);
      i = close + 2;
    }
    out.push(res);
  }
  return { md: out.join('\n'), tokens: tokens };
}

/** `[[…]]` 内部的解析：`页` / `页|别名` / `页#标题` / `页#标题|别名`（四种都认）。
 *  ⚠️ 只有**第一个** `|` 之前是目标（别名里再出现 `|` 属于别名内容，不再切）；
 *     目标里的 `#` 是**第一个** —— `[[页#标题#更多]]` 的片段就是 `标题#更多`（原文照收，不猜层级）。 */
function parseWikiInner(inner) {
  let s = String(inner == null ? '' : inner).trim();
  if (!s) return { target: '', heading: '', display: '' };
  let display = '';
  const pipe = s.indexOf('|');
  if (pipe >= 0) { display = s.slice(pipe + 1).trim(); s = s.slice(0, pipe).trim(); }
  let heading = '';
  const hash = s.indexOf('#');
  if (hash >= 0) { heading = s.slice(hash + 1).trim(); s = s.slice(0, hash).trim(); }
  return { target: s, heading: heading, display: display };
}

/** `[[…]]` → 标准 Markdown 链接：**可见文字保留**（别名优先，其次原目标名）。
 *  href 用 `mm-obsidian:` 标记（不是文件路径）⇒ 解析期一眼分得出；对**非 wiki** 的渲染路径
 *  它与普通链接一样（`convert.markdownToHtml` 只做 `[文字](href)` → `<a href>`）。 */
function wikiMdLink(shown) {
  const label = oneLine(shown.display || shown.target || shown.heading, shown.target || shown.heading);
  const dest = shown.heading ? (shown.target || '本节') + '#' + shown.heading : shown.target;
  return '[' + label + '](' + WIKI_SCHEME + encodeURIComponent(dest) + ')';
}

/** 一眼看上去是不是"资源"（图片/附件）：有扩展名、且不是 `.md` / `.markdown`（`.md` 明显是笔记）。
 *  没有扩展名的 `![[页]]` 按**笔记嵌入**处理（Obsidian 里 `![[页]]` 就是嵌入那篇笔记）。 */
function looksLikeResourceRef(target) {
  const ext = path.extname(String(target || '')).toLowerCase();
  if (!ext) return false;
  return ext !== '.md' && ext !== '.markdown';
}

/** 一行化（报告与 Markdown 语法都不许被换行/竖线/方括号打破）：`|` 会截断表格、`[`/`]` 会截断链接。 */
function oneLine(s, fallback) {
  const t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜')
    .replace(/[\[\]]/g, '').trim();
  return t || String(fallback == null ? '' : fallback).trim();
}

function toPosixPath(p) { return String(p).split('\\').join('/'); }

/* ---- ③ vault 索引与目标解析 ---- */
/**
 * 目标 → `{kind:'file'|'heading', entry, chain}`；认不出/歧义 ⇒ `null`（调用方按"逐条点名"处理）。
 *
 * 解析顺序（每一档都写得出理由，**不猜**）：
 *   ① `[[子目录/页]]`：先当**相对本文所在目录**的路径，再当**相对 vault 根**的路径；
 *   ② `[[页]]`：按**文件名**（不带扩展名）匹配全库（Obsidian 的短链接就是这个名字）；
 *   ③ frontmatter `aliases` / `[[页|别名]]` 里的**别名**（两处同一个 `aliases` 表）；
 *   ④ 带 `#片段`：在**目标笔记自己的标题树**里按层级路径逐层降级匹配；
 *      省略目标（`[[#本节标题]]`）⇒ 就在**本文**里找。
 *   ⚠️ 同名多篇 ⇒ `ambiguous`：**不挑一个**（挑错比不接更坏），逐条点名让人自己看。
 */
function resolveWikiTarget(idx, ref) {
  const t = String((ref && ref.target) || '').trim();
  const heading = String((ref && ref.heading) || '').trim();
  const baseDir = toPosixPath(path.posix.dirname(String(ref && ref.fromRel ? ref.fromRel : '')));
  const rel = (baseDir === '.' || baseDir === '') ? t : baseDir + '/' + t;
  const exts = path.extname(t) ? [''] : ['', '.md', '.markdown'];   // 先原样（别名/无扩展名的页），再补 .md
  const findExact = (name) => {
    for (const e of exts) { const k = normalizeVaultKey(name + e); if (idx.exact.has(k)) return idx.exact.get(k); }
    return null;
  };
  const findByName = (name) => {
    for (const e of exts) {
      const hit = idx.byName.get((name + e).toLowerCase());
      if (!hit) continue;
      if (hit.length === 1) return hit[0];
      return { ambiguous: hit.slice() };               // 同名多篇：交给调用方点名
    }
    return null;
  };
  let hit = null;
  if (t) hit = findExact(rel) || findExact(t) || findByName(path.posix.basename(t)) || null;
  if (!hit) {
    for (const e of exts) {
      const a = idx.alias.get((t + e).toLowerCase());
      if (a) { hit = a.length === 1 ? a[0] : { ambiguous: a.slice() }; break; }
    }
  }
  if (!t) hit = null;                                  // 只给了片段：在本文里找（下面按 fromRel 处理）
  if (hit && hit.ambiguous) return { kind: 'ambiguous', hits: hit.ambiguous };
  if (!t) {
    if (!heading) return null;
    const self = idx.exact.get(normalizeVaultKey(String(ref && ref.fromRel ? ref.fromRel : '')));
    if (!self) return null;
    const h = findHeadingIn(self.node, heading, idx.forcedTopics);
    return h ? { kind: 'heading', entry: self, chain: h } : null;
  }
  if (!hit) {
    // 目标不在本次导入范围内（`--only` 之类）⇒ 如实分档（调用方据此说"vault 里有、这批没导"）
    const scanned = idx.scannedLookup(t, rel);
    return scanned ? { kind: 'not-in-batch', entry: scanned } : null;
  }
  if (!heading) return { kind: 'file', entry: hit };
  const h = findHeadingIn(hit.node, heading, idx.forcedTopics);
  if (!h) return { kind: 'file-no-heading', entry: hit };   // 笔记在、那个标题不在 ⇒ 落文件节点（点名）
  return { kind: 'heading', entry: hit, chain: h };
}

/** 索引键的规范化：`/` 结尾、`./` 前缀、大小写（Windows 上 Obsidian 用户写 `Page` 与 `page` 都当同一篇）。 */
function normalizeVaultKey(p) {
  return toPosixPath(p).replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/** 在目标笔记的标题树里找片段：先按层级路径（逐层降级），再按**最后一段**匹配任意一层标题。
 *  ⚠️ 回来的是**从根到该标题的节点链**（报告与 caption 要写出"落到哪一层"）。 */
function findHeadingIn(node, heading, forcedTopics) {
  if (!node || !heading) return null;
  if (Array.isArray(forcedTopics)) return forcedTopics.length ? forcedTopics : null;   // 打桩口（判别力证明用）
  const parts = String(heading).replace(/^#+/, '').split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > VAULT_MAX_HEADING_DEPTH) return null;
  /** 深度优先收集"从根到当前节点"的链，找 topic 等于 want 的 */
  const search = (n, chain, want) => {
    for (const c of (n.children || [])) {
      const next = chain.concat([c]);
      if (String(c.topic) === want) return next;
      const deep = search(c, next, want);
      if (deep) return deep;
    }
    return null;
  };
  /* 逐层降级：`A/B/C` 先整条试，再 `B/C`，最后只用 `C` —— 每一步都**只认完全相等的标题**
   * （不做模糊/前缀匹配：猜错落的节点比不落更坏）。 */
  for (let k = 1; k <= parts.length; k++) {
    const hit = search(node, [], parts.slice(k - 1).join(' / '));
    if (hit) return hit;
  }
  return null;
}

/** caption（边的说明）：**人话 + 原样写法** —— `源节点标题：[[原样]]（#标题）`。
 *  为什么要它：`docs/DATA-FORMAT.md` 说"链接必须有 caption，AI 凭它判断内容"；
 *  而 wiki 的**原样写法**正是这条边在源笔记里的依据（别名与片段都在里面）。 */
function wikiCaption(fromTopic, tok, chainNote) {
  return oneLine(String(fromTopic || ''), '笔记') + '：' + oneLine(tok.raw, '[[链接]]')
    + (chainNote ? '（落到「' + oneLine(chainNote, '') + '」）' : '');
}

function vaultReportOf(sum, links, frontmatter, resources, extras) {
  const x = extras || {};
  const unresolved = (x.unresolved || []);
  const out = {
    enabled: true,
    files: sum.files,
    linkTotal: sum.linkTotal,
    linked: sum.linked,
    headingLinks: sum.headingLinks,
    aliasLinks: sum.aliasLinks,
    embedLinks: sum.embedLinks,
    /* "没接上"那一档的总数 = `unresolved` 的**条数**（`unresolved` 自己就是那个清单 ⇒ 两处必然一致）。
     * ⚠️ 曾经写成 `sum.dangling.length` 而那个数组从没被填过 ⇒ 报告永远说"断链 0 条"，
     *    而盘面上明明有没接上的链接（同一个数在两处各算一份的典型后果 ✗）。 */
    danglingTotal: unresolved.length,
    dangling: unresolved.slice(0, 200),
    resourceTotal: sum.resourceTotal,
    resources: resources || [],
    frontmatterFiles: (frontmatter || []).filter((f) => f.has).length,
    taggedFiles: (frontmatter || []).filter((f) => f.tags && f.tags.length).length,
    tags: dedupe([].concat(...(frontmatter || []).map((f) => f.tags || []))),
    aliases: dedupe([].concat(...(frontmatter || []).map((f) => f.aliases || []))),
    frontmatter: (frontmatter || []).slice(0, 200),
    ambiguous: (x.ambiguous || []).slice(0, 200),
    embedNotes: (x.embedNotes || []).slice(0, 200),
    resourceUnresolved: (x.resourceUnresolved || []).slice(0, 200),
    links: (links || []).slice(0, 200),
    skippedDirs: x.skippedDirs || [],
    notes: extraNotes(x)
  };
  return out;
}

/** 报告里必须**当面说清**的几件事（都不静默） */
function extraNotes(x) {
  const notes = [];
  if (x.embedNotes && x.embedNotes.length) {
    notes.push('笔记嵌入（`![[笔记]]`）本批**不展开**（P0 边界，W12 一节）：已按链接接上并逐条列出。');
  }
  if (x.resourceUnresolved && x.resourceUnresolved.length) {
    notes.push('有 ' + x.resourceUnresolved.length + ' 条附件/图片引用在盘上找不到 ⇒ 按**正文原样保留**'
      + '（内容没丢、也不落一条指向不存在文件的坏引用），逐条列在上面。');
  }
  if (x.unresolved && x.unresolved.length) {
    notes.push('有 ' + x.unresolved.length + ' 条 wiki 链接**没能接成关联**（目标不存在 / 认不出）'
      + ' ⇒ 正文按原样保留、**一条悬空链接都没写**，逐条列在上面。');
  }
  if (x.skippedDirs && x.skippedDirs.length) {
    notes.push('附件目录（' + x.skippedDirs.join(' / ') + '）按 P0 边界**没有导入**（附件本身属 P1）。');
  }
  return notes;
}

/* ---- ④ 入口：`import-dir --vault` 走的**唯一**一处（转换 + 建树 + 解析 + 落点） ---- */
/** 建 vault 索引（文件名 / 别名 / 标题树）+ 扫描清单查表（判"vault 里有、这批没导"）。
 *  ⚠️ **别名表要分两步填**：别名来自 frontmatter，而 frontmatter 是在逐个笔记的循环里才解析的
 *  ⇒ 循环里解析出 `e.aliases` 之后必须调 `idx.rebuildAliases()`（见 `applyVault` 的最后一步）
 *  —— 少这一步的后果实测过：`[[别名]]` 一条都解析不到（而报告里还写着"认得的别名有几个"✗）。 */
function vaultIndexOf(scan, built) {
  const idx = {
    exact: new Map(), byName: new Map(), alias: new Map(),
    scannedLookup: (t, rel) => {
      /* 这个文件在库里、但**没进本次的树**（`--only` / `--ext` 把它排除了）⇒ 给它的 `rel`，
       * 让报文能点名"库里**有**它"（与"根本不存在"分开报：修法不同）。
       * ⚠️ 键要带上扩展名一起比（`[[甲]]` 的字面是 `甲`，而盘上的文件是 `甲.md`）——
       * 不补这一步就会把"库里明明有"报成"不存在"（实测踩到）。 */
      const want = [t, rel, normalizeVaultKey(t), normalizeVaultKey(rel)]
        .concat(t ? [normalizeVaultKey(t + '.md'), t.toLowerCase() + '.md'] : []);
      const hit = (scan.files || []).find((f) => {
        const keys = [normalizeVaultKey(f.rel), normalizeVaultKey(path.posix.basename(f.rel)), f.rel.toLowerCase()];
        return keys.some((k) => want.indexOf(k) >= 0);
      });
      return hit ? { rel: hit.rel } : null;
    },
    forcedTopics: null,
    rebuildAliases: () => {
      idx.alias.clear();          // ⚠️ 必须 **clear()** 而不是重新赋值：`resolveWikiTarget` 闭包里抓的是
                                  // `idx.alias` 这个引用 —— 换成新 Map 它仍旧查旧的（实测症状：别名一条都解析不到）
      (built.entries || []).forEach((e) => {
        if (!e || !e.node) return;              // 只收**真进了树**的那些（候选名指向不存在的节点是坏链接）
        (e.aliases || []).forEach((a) => {
          const k = String(a).toLowerCase();
          if (!idx.alias.has(k)) idx.alias.set(k, []);
          idx.alias.get(k).push(e);
        });
      });
    }
  };
  (built.entries || []).forEach((e) => {
    if (!e || !e.node) return;
    const keys = [normalizeVaultKey(e.rel)];
    if (!path.extname(e.rel)) keys.push(normalizeVaultKey(e.rel + '.md'));
    keys.forEach((k) => { if (!idx.exact.has(k)) idx.exact.set(k, e); });
    const bn = path.posix.basename(e.rel).toLowerCase();
    if (!idx.byName.has(bn)) idx.byName.set(bn, []);
    idx.byName.get(bn).push(e);
    const stem = bn.replace(/\.md$/, '');
    if (stem !== bn) {
      if (!idx.byName.has(stem)) idx.byName.set(stem, []);
      idx.byName.get(stem).push(e);
    }
  });
  return idx;
}

/**
 * **Obsidian 库直进**：`import-dir --vault` 的转换 + 建树 + wiki 解析 + 落点，**一处实现**。
 * 建树仍然只有一条链（`docToOutline` → `markdownToTree`，由 `buildDirImportTree` 调），
 * 本函数只做三件事：① 把 `[[…]]` / `![[…]]` / frontmatter 在**建树之前**消化成 Markdown；
 * ② 建完树之后按索引把链接落到**既有** `links[]`；③ 把"接不上的"逐条点名。
 *
 * @param {{project:string, root?:string, tool?:string, at?:string, genId?:Function,
 *          only?:Set<string>, readDoc?:Function, resolveRefs?:Function, baseDirOf?:Function}} opts
 *   · `project`（必填）= 目标项目目录名 ⇒ `links[].project` 用它（同项目引用，schema 支持）
 *   · `resolveRefs(baseDir, node, vaultSources)` = **既有**资源落地那一处（CLI 传
 *     `resolveDirImportRefs` 的同款调用）；缺省 = 不落地（只有真跑命令时那一层才存在）——
 *     缺省时附件引用**原样留在节点上**，由调用方后面统一处理（**不静默丢**：报告里照旧逐条列出来）
 *   · `baseDirOf(entry)` = 这个文件所在目录（相对引用的基准；缺省取 scan.root）
 * @returns {{built:object, vault:object, sources:Map, refs:Map}}
 */
function applyVault(scan, opts) {
  const o = opts || {};
  const project = String(o.project || '');
  const at = o.at || new Date().toISOString();
  const tool = o.tool || 'import-dir';
  const genId = o.genId || uniqueIdGen();
  if (!project) throw new Error('applyVault 需要 project（links[].project 用它；缺了就会写出无处可指的链接）');

  const vaultSources = new Map();     // rel → 转换后的正文（**建树读它** ⇒ 每个文件只读一次）
  const tokensOf = new Map();         // rel → 该文件的 wiki 语法条目（报告与解析用）
  const fmOf = new Map();             // rel → frontmatter 解析结果
  // 先建索引需要**文件级事实**（rel / id）；建树时才知道 ⇒ 索引在树建好后再建（见下）
  const built = buildDirImportTree(scan, {
    genId: genId, at: at, tool: tool, only: o.only,
    transform: (f, md) => {
      /* 交给 `buildDirImportTree` 的**只是正文本身**（frontmatter 剥掉、wiki 语法消化成 Markdown）；
       * 规范化（CRLF→LF + 剥 BOM）仍由它那**一处**统一做（与从前同一步、同一份函数）⇒ 指纹与建树
       * 用的都是同一份规范化后的正文 ✓（本函数**不碰** origin：`makeOrigin` 是唯一一处）。 */
      const fm = parseFrontmatter(md);
      const conv = convertWikiSyntax(fm.body);
      vaultSources.set(f.rel, normalizeOutline(conv.md));
      tokensOf.set(f.rel, conv.tokens);
      fmOf.set(f.rel, fm);
      return conv.md;
    }
  });
  (built.entries || []).forEach((e) => { if (vaultSources.has(e.rel)) e.md = vaultSources.get(e.rel); });

  const idx = vaultIndexOf(scan, built);
  const unresolved = [];       // 认不出 / 目标不存在（逐条点名）
  const ambiguous = [];        // 同名多篇（不挑一个，逐条点名）
  const embedNotes = [];       // `![[笔记]]`：本批不展开，如实列出
  const resourceUnresolved = [];// 附件引用找不到（按正文保留）
  const links = [];            // 真的写下去的边（报告用）
  const frontmatter = [];
  const resources = [];
  const resOfRel = new Map();  // rel → 资源落地读数（第②遍要用）

  const sum = { files: 0, linkTotal: 0, linked: 0, headingLinks: 0, aliasLinks: 0, embedLinks: 0,
    dangling: [], resourceTotal: 0 };

  /* ---------- 第①遍：frontmatter（标签 / 别名）+ 附件引用的落点 ----------
   * ⚠️ **必须先跑完这一遍再解析链接**：`[[别名]]` 的目标候选名来自 frontmatter，而别名可能写在
   * **任何一篇**笔记里（后面的那篇也算）；第①遍就把全库的候选名收齐 ⇒ 第②遍的索引才是完整的。
   * （这是实测踩出来的：一边解析一边收集 ⇒ 第 3 篇写的别名对第 1 篇的链接永远无效。） */
  (built.entries || []).forEach((e) => {
    if (!e || !e.node) return;
    const node = e.node;
    sum.files += 1;
    const fm = fmOf.get(e.rel) || { has: false, fields: {}, warns: [] };
    const tags = normalizeVaultTags(fieldList(fm.fields, VAULT_TAG_KEYS));
    const aliases = dedupe(fieldList(fm.fields, VAULT_ALIAS_KEYS))
      .map((s) => String(s).replace(/^#+/, '').trim()).filter(Boolean);
    e.aliases = aliases;
    const tagged = addNodeTags(node, tags);
    if (fm.has) {
      frontmatter.push({
        rel: e.rel, nodeId: node.id, tags: tags, tagsApplied: tagged, aliases: aliases,
        keys: Object.keys(fm.fields).sort(),
        other: Object.keys(fm.fields).filter((k) => VAULT_TAG_KEYS.indexOf(k) < 0 && VAULT_ALIAS_KEYS.indexOf(k) < 0)
          .sort(),
        warns: fm.warns.slice()
      });
    }
    /* 附件/图片：先按**既有资源行**挂到节点上（`![[图]]` 在转换期已写成资源行）⇒ 交给既有
     * `markdown.resolveImportRefs`（唯一实现）落地；坏引用 ⇒ 摘下来 + 按正文保留 + 逐条点名。 */
    if (typeof o.resolveRefs === 'function') {
      const rep = o.resolveRefs(o.baseDirOf ? o.baseDirOf(e) : '', node, vaultSources);
      if (rep) {
        resOfRel.set(e.rel, rep);
        /* 逐条点名：坏引用由既有那一处（`resolveImportRefs` 的 `dropped`/`blocked`/`remote`）
         * 如实给出 —— 本段只把它转成报告条目，**不自己再判一次**（第二处判据必然漂移 ✗）。
         * ⚠️ `dropped` 与 `blocked` 在"本地文件不存在"这一档上装的是**同一个对象**
         *    （`blocked` 是 `refs` 的过滤视图、`dropped` 是落地时那一档的桶）⇒ 直接 concat 会把
         *    同一件事列两遍（实测：1 条坏引用报成 2 条）。这里按**对象身份**去重。 */
        const issues = [];
        const seenRes = new Set();
        [].concat(rep.dropped || [], rep.blocked || [], rep.remote || []).forEach((r) => {
          if (!r || seenRes.has(r)) return;
          seenRes.add(r);
          issues.push(r);
        });
        issues.forEach((r) => {
          resourceUnresolved.push({
            file: e.rel, node: node.id, raw: r.raw, status: r.status, reason: r.reason || '',
            candidates: (r.candidates || []).length
          });
        });
      }
    }
  });

  /* ---------- 第②遍：wiki 链接 → 既有 `links[]`（此刻索引/别名表已经完整） ---------- */
  idx.rebuildAliases();   // 别名表按引用原地刷新（见它的注释：换成新 Map 的话解析侧仍查旧的）
  (built.entries || []).forEach((e) => {
    if (!e || !e.node) return;
    const node = e.node;
    const tokens = tokensOf.get(e.rel) || [];
    sum.linkTotal += tokens.filter((t) => t.kind === 'link' || t.kind === 'embed-note').length;
    sum.resourceTotal += tokens.filter((t) => t.kind === 'resource').length;
    const ctx = {
      file: e.rel, node: node, sum: sum,
      unresolved: unresolved, ambiguous: ambiguous, embedNotes: embedNotes,
      links: links, project: project
    };
    tokens.forEach((tok) => {
      if (tok.kind === 'resource') {                                 // 附件：报告里逐条给落点
        resources.push({ file: e.rel, raw: tok.raw, target: tok.target, baseDir: o.baseDirOf ? o.baseDirOf(e) : '' });
        return;
      }
      linkWikiToken(idx, e, node, tok, ctx);
    });
  });

  sum.unresolvedTotal = unresolved.length;
  sum.ambiguousTotal = ambiguous.length;
  const vault = vaultReportOf(sum, links, frontmatter, resources, {
    unresolved: unresolved, ambiguous: ambiguous, embedNotes: embedNotes,
    resourceUnresolved: resourceUnresolved,
    skippedDirs: (scan.skippedDirs || [])
  });
  return { built: built, vault: vault, sources: vaultSources, refs: resOfRel };
}

/** 一条 wiki 语法 → 落点（**唯一一处**：判定顺序、报告分档、写下去的那条边都在这里）。
 *  ctx 里是这一次导入的累加器（逐条点名的三个清单 + 真写下去的 links + 汇总计数 `sum`）。 */
function linkWikiToken(idx, e, node, tok, ctx) {
  const sum = ctx.sum;
  if (tok.kind === 'embed-note') {
    ctx.embedNotes.push({ file: e.rel, raw: tok.raw, target: tok.target, note: '笔记嵌入不展开（P0 边界）' });
    sum.embedLinks += 1;
  }
  const hit = resolveWikiTarget(idx, { target: tok.target, heading: tok.heading, fromRel: e.rel });
  if (!hit) {
    ctx.unresolved.push({
      file: e.rel, node: node.id, raw: tok.raw, target: tok.target, heading: tok.heading,
      embed: !!tok.embed, why: tok.target ? '目标没有对应的笔记（或认不出这个名字）' : '只给了片段、本文里也没有那个标题'
    });
    return;
  }
  if (hit.kind === 'ambiguous') {
    ctx.ambiguous.push({
      file: e.rel, raw: tok.raw, target: tok.target,
      hits: hit.hits.map((h) => h.rel)
    });
    return;
  }
  if (hit.kind === 'not-in-batch') {
    ctx.unresolved.push({
      file: e.rel, node: node.id, raw: tok.raw, target: tok.target, heading: tok.heading, embed: !!tok.embed,
      why: 'vault 里**有**这篇笔记（' + hit.entry.rel + '），但本次导入的范围内没有它'
        + '（`--only` / `--ext` 把它排除了）⇒ 没有写这条边'
    });
    return;
  }
  const dest = hit.kind === 'heading' && hit.chain && hit.chain.length
    ? hit.chain[hit.chain.length - 1] : hit.entry.node;
  if (!dest || !dest.id) {
    ctx.unresolved.push({ file: e.rel, node: node.id, raw: tok.raw, target: tok.target, embed: !!tok.embed,
      why: '目标节点还没有 id（转换没成功？）' });
    return;
  }
  if (dest.id === node.id) {         // 指向自己：不是关联（自环），如实说出来
    ctx.unresolved.push({ file: e.rel, node: node.id, raw: tok.raw, target: tok.target, embed: !!tok.embed,
      why: '这一条指向笔记自己（自环）⇒ 按"不写自环"处理' });
    return;
  }
  sum.linked += 1;
  if (hit.kind === 'heading') sum.headingLinks += 1;
  if (tok.display) sum.aliasLinks += 1;
  const chainNote = (hit.kind === 'heading' && hit.chain)
    ? hit.chain.map((n) => n.topic).join(' / ') : '';
  const caption = wikiCaption(node.topic, tok, chainNote);
  const link = { project: ctx.project, id: dest.id };
  if (caption) link.caption = caption;
  const dup = (node.links || []).some((l) => l && l.project === link.project && l.id === link.id
    && l.caption === link.caption);
  if (!dup) {
    (node.links = node.links || []).push(link);
    ctx.links.push({ file: e.rel, node: node.id, to: ctx.project + '/' + dest.id, toTopic: dest.topic,
      raw: tok.raw, target: tok.target, heading: tok.heading, alias: tok.display || '', kind: hit.kind,
      chain: chainNote, caption: caption });
  }
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
 * **内容指纹**：判"内容有没有变"的唯一依据（唯一实现）。
 *
 * 算的是**建树真正吃进去的那份文本**：与 `normalizeOutline` 同一份规范化（CRLF/CR → LF、剥 BOM）
 * ⇒ "换行风格 / 带不带 BOM"不算内容变化（建出来的树**逐节点相同**），而"改一个字节就变" ✓。
 * 非文本（UTF-8 解码**有损**的：docx/zip/pdf 那些字节）⇒ 退回**原始字节**的 sha256 ——
 *   否则两个不同的二进制文件可能解码成同一串替换字符（U+FFFD）而得同一个指纹 ⇒ 假"没变" ✗。
 * @param {string} abs 绝对路径
 * @returns {string} 64 位小写十六进制；读不了/算不了 ⇒ `''`（调用方按"证明不了没变"处理）
 */
function bindingContentDigest(abs) {
  let buf = null;
  try { buf = fs.readFileSync(String(abs)); } catch (e) { return ''; }     // 不传 encoding ⇒ Buffer
  try {
    const text = buf.toString('utf8');
    /* 逐字节回写一致 ⇒ 这次 utf8 解码是**无损**的（有损时替换字符会顶掉原字节）。 */
    if (Buffer.from(text, 'utf8').equals(buf)) {
      return crypto.createHash('sha256').update(normalizeOutline(text), 'utf8').digest('hex');
    }
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (e) { return ''; }                                              // 浏览器端 / 算不了 ⇒ 交给调用方保守处理
}

/**
 * **比**：当前盘上的文件 vs 上次的快照 ⇒ 三类变化（这是"增量"的全部判定，别在别处再判一遍）。
 *
 * ## 判据链（【20261059】修：mtime 只是"快速否定"，**不是**"肯定"）
 *   · `added`    —— 快照里没有、现在有；
 *   · `modified` —— 快照里有、且**内容真的变了**（或"证明不了没变"，见下）；
 *   · `deleted`  —— 快照里有、现在没有了 **且当前仍在 include/ignore 范围内**。
 *     为什么要有最后那半句：把一个文件**移出** include（或加进 ignore）是人明确的动作 ⇒
 *     那不该被报成"文件被删了，要不要删节点"（那是两种意图混成一条提议 ✗）。
 *     被排除掉的文件**留在快照里**（`stillIncluded` 交出去）⇒ 它重新被纳入时判成 `modified`，
 *     不会因为"离开过视野"而多建一个节点 ✓。
 *
 * ## 为什么不能只比 `mtimeMs` / `size`（本批实测的缺陷，代价不是"多跑一次"）
 *   同内容**再写一次**（mtime 变、size 不变）⇒ 旧实现判成 `modified` ⇒ 整轮真跑：读文件、重跑转换、
 *   **把那棵子树的节点 id 全换掉**（`applyBindingPlan` 是"就地替换" ⇒ 新子树是新 id）⇒ 指向它内部节点
 *   的跨项目链接/选中态一起断，而绑定记录的 `lastSyncAt` 也被白推一格。实测读数见
 *   `.review/20261059-mtime与lastSync/probe-两个缺陷.log`（第 1 轮 id 与第 2 轮 id 逐项不同）。
 *   而且 mtime 精度**不可依赖**：NTFS 是 100 ns，FAT / 网络盘 / 整秒取整的文件系统上不同内容可以
 *   得到同一个 `mtimeMs` ⇒ "两个数相等"永远不能单独用来证明"没变"。
 *
 * ## 成本取舍（**不许**把内容比对做成"每次都读全文"）
 *   ① 两个 stat 数**都没变** ⇒ 直接判"没变"，**一个字节都不读**（绝大多数文件每一轮都走这条）；
 *   ② stat 变了 ⇒ **候选**，才读一次算内容指纹：与快照里的 `contentSha` 相同 ⇒ 内容没变 ⇒
 *      不算 modified，只把快照里的 stat 刷新（`refreshed`），下一轮回到 ①；
 *   ③ 指纹不同 / 快照里没有基线（老版本快照、读不了、非文本）⇒ 保守判 `modified`（一次）。
 *   ⇒ 读盘成本 = **"这一轮被碰过的文件"**，不是"这个文件夹"。新增/修改的文件本来就要被转换读一遍，
 *     这里多读的那一遍通常命中页缓存（同一轮、同一个文件、刚被读过）。
 *   ⚠️ 基线只在**新增/修改/核对过**这三种情形下写（`contentSha`），所以老快照升级后的**第一次**
 *     "只改 mtime"仍会保守判成 modified 一次 —— 之后就有基线了；不这样做就得"每次全读"。
 *   ⚠️ 还有一条**实测代价**（`.review/20261059-mtime与lastSync/probe-修好之后.log` 第②段）：刷新的 stat
 *     只有**写快照**才记得住，而"这一轮没有任何真改动"时命令层**不写快照**（`bindingPlanChangesTree` 为
 *     false ⇒ 连项目文件都不动）⇒ 那个被反复重写同内容的文件，每一轮都要再核对一次内容（**按文件数**算，
 *     不是按目录）。同一轮里只要还有任何别的真改动，快照会被写一次 ⇒ 这些 stat 一起记住 ⇒ 之后回到 0 读。
 *     （要彻底消掉这一档，得让"零改动轮"也写旁路快照 —— 那要动命令层，本批改动面不含 `cli/`，如实登记。）
 *
 * @param {object} snapshot 旁路快照（`files[rel]` = `{mtimeMs,size,contentSha,…}`）
 * @param {{files:Array<{rel,abs,size,mtimeMs,include,ignore}>}} list `listBindingFiles` 的结果
 * @returns {{added:string[], modified:string[], deleted:string[], stillIncluded:string[],
 *            refreshed:string[], unchanged:number, contentSha:Object<string,(string|null)>}}
 *   `refreshed` = 内容没变但 stat 变了的那几个（快照要刷新它们的 `mtimeMs`/`size`，树一个字节都不动）；
 *   `contentSha` = 本轮**真读过**的那些文件的新基线（`null` = 这一轮证明不了，别把旧值带过去）。
 */
function bindingFileDiff(snapshot, list) {
  const snapFiles = (snapshot && snapshot.files && typeof snapshot.files === 'object') ? snapshot.files : {};
  const cur = new Map((list && list.files ? list.files : []).map((f) => [f.rel, f]));
  const added = [], modified = [], deleted = [], stillIncluded = [], refreshed = [];
  const contentSha = {};
  let unchanged = 0;
  Object.keys(snapFiles).forEach((rel) => {
    const curF = cur.get(rel);
    const inScope = !!(curF && curF.include && !curF.ignore);
    const known = snapFiles[rel] || {};
    if (!curF || !inScope) { stillIncluded.push(rel); return; }       // 看不见了/被排除了 ⇒ 不算删除
    /* ① 快速否定（零读取）：两个数都没变 ⇒ 肯定没变。只在这个方向成立（注释见函数头）。 */
    if (known.mtimeMs === curF.mtimeMs && known.size === curF.size) { unchanged++; return; }
    /* ② 慢路径：stat 变了只是**候选**，要内容才能定。 */
    const now = bindingContentDigest(curF.abs);
    if (now && known.contentSha && known.contentSha === now) {
      unchanged++;
      refreshed.push(rel);                                          // 内容没变：只刷新快照的 stat
      contentSha[rel] = now;
      return;
    }
    /* ③ 内容变了 / 没有可比基线 ⇒ 保守判 modified；基线**跟着换成新值**（换不了就置 null，
     *    绝不把上一份内容的旧指纹留给下一轮 —— 那会让"下次只改 mtime"假判成没变 ✗）。 */
    modified.push(rel);
    contentSha[rel] = now || null;
  });
  cur.forEach((f) => {
    if (!f.include || f.ignore) return;
    if (Object.prototype.hasOwnProperty.call(snapFiles, f.rel)) return;
    added.push(f.rel);
    /* 新增文件**当场建基线**：不建的话它下一次"只改 mtime"就没有可比的东西 ⇒ 又回到"改了就重写"。
     * 代价 = 这个文件多读一遍（同一轮里转换紧接着读它，通常命中页缓存）；换来的是"每个进过快照的
     * 文件都有一条内容基线"这条不变量 —— 少了它 ① 那条快速否定在第二轮就不成立。 */
    contentSha[f.rel] = bindingContentDigest(f.abs) || null;
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
    stillIncluded: stillIncluded.sort(), refreshed: refreshed.sort(), unchanged: unchanged,
    contentSha: contentSha
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
    /* 【20261059】"内容没变、只是 stat 变了"的那几个文件（`bindingFileDiff` 的读数，判据全在那里）：
     * 它们**不进** added/modified（子树一个字节都不动），只让 `snapshotAfterBindingPlan` 把快照里的
     * `mtimeMs`/`size` 刷新成扫描那一刻的读数 —— 少了这一步，同一个文件每一轮都会被重新读一遍去核对内容
     * （功能没错，只是白花读盘；见 `bindingFileDiff` 的"成本取舍"）。 */
    refreshed: diff.refreshed,
    /* 【20261059】本轮**真读过**的那些文件的内容基线（新增/修改/核对过没变）——
     * `snapshotAfterBindingPlan` 只认它，不许自己在别处再算一份指纹。 */
    contentSha: diff.contentSha,
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
 *      其中【20261059】"内容没变、只是 stat 变了"的那几个（`plan.refreshed`）**只刷 stat**、不碰树；
 *   ②′ 每个进过快照的文件都带一条**内容基线** `contentSha`（`plan.contentSha`，判据在 `bindingFileDiff`）
 *      —— 没有它，下一轮"只改了 mtime"的同一个文件就没有可比的东西，只能保守判 modified；
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
  /* 【20261059】内容基线：**只认 `bindingFileDiff` 交上来的那一份**（`plan.contentSha`），
   * 这里不重算、也不在别处另判一次"内容变了没有"。`null` 是**有意义的读数**（"这一轮证明不了"），
   * 所以判"有没有这个键"用 `hasOwnProperty`，不能用真值判断。 */
  const digests = (plan && plan.contentSha) || {};
  const digestOf = (rel, prev) => (Object.prototype.hasOwnProperty.call(digests, rel)
    ? digests[rel] : ((prev && prev.contentSha) || null));
  const files = {};
  /* ② 本轮没变的：旧条目带过去（否则下一轮会被判成全量新增）。
   *    ⚠️ 【20261059】其中"内容没变、只是 stat 变了"的那几个（`plan.refreshed`）要**把 stat 换掉**：
   *    留着旧 mtime ⇒ 下一轮又得读一遍文件去核对内容（功能对、纯白花读盘）。只刷 `refreshed` 这一档
   *    —— 被 include/ignore 排除掉的（`stillIncluded`）**不许**刷：它们的内容这一轮**没核对过**，
   *    刷了就等于"没看过却记下了一个新的 stat" ⇒ 它回到范围内时会被误判成没变 ✗。 */
  const refreshedSet = new Set((plan && plan.refreshed) || []);
  (keep || []).forEach((rel) => {
    const old = (base.files || {})[rel];
    if (!old) return;
    const next = Object.assign({}, old);
    if (refreshedSet.has(rel)) {
      const st = stats[toRelSlash(rel)] || {};
      if (typeof st.mtimeMs === 'number') next.mtimeMs = st.mtimeMs;
      if (typeof st.size === 'number') next.size = st.size;
    }
    if (Object.prototype.hasOwnProperty.call(digests, rel)) next.contentSha = digests[rel];
    files[rel] = next;
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
      topic: topic || (prev && prev.topic) || null,
      contentSha: digestOf(rel, prev)                                        // 【20261059】
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
      /* 【20261059】内容基线（"建树吃进去的那份文本"的指纹，见 `bindingContentDigest`）：
       * 它是 `bindingFileDiff` 判"内容有没有变"的唯一依据 ⇒ 必须落进快照，否则每一轮都得重算/保守判 modified。 */
      contentSha: f.contentSha === undefined ? null : f.contentSha,
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

return {
  detectFormat, textToOutline, looksLikeHeading, headingLevelOf,
  zipFindEntry, docxParagraphs, docxToOutline, docToOutline, finishOutline,
  // 导入源闸门（把"为什么读不了"说准 + 给出路）与来源指纹 origin（幂等的前提，唯一实现）
  describeImportSourceProblem, directoryMessage, describeImportDirProblem, classifyStatFailure,
  // G-15 下沉：上面两个「看 stat 再拼人话」的**纯核心**（入参是形状 `{kind, readable}`，不碰盘）
  describeSourceShape, describeDirShape,
  // 整库导入（import-dir）：目录走查 + 跳过分类 + 容器拼装（**建树仍只有 markdown.js 一处**）
  IMPORT_EXT_DEFAULT, IMPORTABLE_EXT, SKIP_DIR_NAMES, MAX_IMPORT_FILES_DEFAULT,
  SKIP_LABEL, SKIP_SHORT, entrySkipReason, normalizeExtList, scanImportDir, buildDirImportTree, uniqueIdGen,
  dirManifestSha256, makeDirOrigin, describeTooManyFiles, describeDirOversize, describeNoImportableFiles,
  skippedTotal, groupSkips, originKey,
  // ⓪⁸ 分批线（**不是拒绝线**）+ 分批计划：整库导入按它逐批建树（进度与内存都挂在这条上）
  MAX_IMPORT_BATCH_MB, MAX_IMPORT_BATCH_BYTES, MAX_IMPORT_BATCH_FILES, planImportBatches, scanSliceOf,
  buildDirImportTreeBatched,
  // ⓪⁹ 视频目录：`.m3u8` 是入口（导入），分片/密钥/索引跳过（**两侧判据**，不许按扩展名一刀切）
  VIDEO_ENTRY_EXT, VIDEO_PART_EXT, isVideoEntryName, isVideoBundleName, classifyVideoPart,
  videoPlaylistFacts, videoDetailMd, LOCAL_PATH_MAX,
  // ⓪⁹c 【20261048】秒 → `mm:ss` 的**唯一实现**（播放列表时长与字幕时间戳同一种写法）：
  //   `src/video-summary.js` 的 `formatStamp` 是它的薄包装 —— 别在摘要那一侧再写第二份格式化 ✗
  formatDuration,
  // ⓪⁶ Obsidian 直进（W12 P0）：**识别 + 解析 + 落点 + 逐条点名**一处实现（目录/建树/资源/写盘仍全走既有那些）
  VAULT_TAG_KEYS, VAULT_ALIAS_KEYS, VAULT_SKIP_DIRS, normalizeVaultTags,
  parseFrontmatter, fieldList, dedupe, convertWikiSyntax, parseWikiInner, isVaultDir, applyVault,
  // 体量闸门（⓪′）：上限常量只有这一份，两条导入路共用同一个判据
  MAX_SOURCE_MB, MAX_SOURCE_BYTES, describeOversizeSource, describeOversizeBuffer, describeOversizeSize,
  // 子进程输出上限（⓪″）：**与上面那个不是同一个维度**（源文件体量 vs 子进程 stdout），导出是为了让判据能读它
  MAX_OUTLINE_BUF_MB,
  // 子进程时间预算（⓪″b）：第三个维度，导出同上（判据要能核对"调用点用的就是这一份"）
  PDF_HELPER_TIMEOUT_MS,
  normalizeOutline, outlineSha256, sourceRef, makeOrigin, originMatches, describeOrigin,
  // ⓪⁵ 绑定工作区文件夹（R4）：盯哪些文件 / 比 / 建计划 / 套 / 快照（**转换一律走上一条链**，本段不解析格式）
  BINDING_STATE_VERSION, BINDING_STATE_FILE, BINDING_EXT_DEFAULT, BINDING_IGNORE_DEFAULTS,
  toRelSlash, relBaseName, bindingIncludeHit, bindingIgnoreHit, listBindingFiles,
  emptyBindingSnapshot, normalizeBindingSnapshot, bindingSnapshotOf, bindingFileDiff,
  // 【20261059】内容基线（"建树吃进去的那份文本"的指纹）：判"内容有没有变"的唯一实现，判据要能直接核它
  bindingContentDigest,
  planBindingSync, bindingPlanChangesTree, applyBindingPlan, snapshotAfterBindingPlan,
  bindingStatusOf, serializeBindingSnapshot, parseBindingSnapshot
};
});
