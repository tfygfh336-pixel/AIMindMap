/* ============================================================
 * AI MindMap — 主进程（Electron）
 * ------------------------------------------------------------
 * 职责：
 *   1) 创建主窗口（preload.js 注入 IPC 桥）
 *   2) 应用菜单（文件/编辑/视图/帮助，含撤销重做快捷键）
 *   3) IPC 处理器：projects 列表 / 读项目 / 保存项目（写盘前校验闸门）
 *                     / 导入图片 / 导出 Markdown 等
 *   4) --smoke 模式：headless 冒烟自检（不依赖键盘鼠标）
 * ============================================================ */
'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const dshSidebar = require('./main-dsh-sidebar.js');
const dropTarget = require('./src/drop-target.js');   // P7 落点判定（纯函数 ✓ 有单测 ✓ 屏幕坐标）

const ROOT = __dirname;
const REAL_PROJECTS_DIR = path.join(ROOT, 'projects');
const CLI = path.join(ROOT, 'cli', 'mm-cli.js');

const isSmoke = process.argv.includes('--smoke');

/* ---------------- 冒烟保帧开关（**只在冒烟/离屏路径**） ----------------
 * 问题：Chromium 会后台化"不可见 / 被遮挡"的窗口并节流定时器 ⇒ 隐藏窗口可能不出帧、
 *   断言里的 setTimeout 可能被降频 ⇒ L1 帧断言与超时判定**偶发假红**，而假红的终点
 *   是有人把断言关掉（本工程已发生过门禁退化与数字漂移）。
 * 对策：照搬 Playwright 给 Chromium 的四个默认开关（清单与来源见 scripts/smoke-flags.js，
 *   **只照搬开关名，不引依赖**）。开关必须在**窗口创建之前**追加，Chromium 只认启动前的参数。
 * 边界：清单是纯函数、单测锁内容；"真的加上了"由 scripts/smoke/14-headless-window.js 断言；
 *   "正常启动不许带"由 tests/smoke-flags.test.js 的接线检查守。三者缺一都会变成"声称加了"。
 */
if (isSmoke) {
  const smokeFlags = require('./scripts/smoke-flags.js');
  for (const pair of smokeFlags.keepAliveSwitches(true)) {
    if (pair[1]) app.commandLine.appendSwitch(pair[0], pair[1]);
    else app.commandLine.appendSwitch(pair[0]);
  }
}

/* ---------------- 冒烟模式的「沙箱项目目录」 ----------------
 * 问题：冒烟断言里有会真正写盘的操作（如 undo/redo 回合断言调用 app.save() 两次）。
 * 它们在**真实项目**上执行 —— 内容虽然最终被复原，但每次 verify 都会重写用户数据，
 * 且一旦进程在中途崩溃，真实笔记会永久残留测试节点（曾实测 comnet.json 的 mtime
 * 每次冒烟都变化）。
 * 对策：冒烟模式把项目根整体重定向到临时目录并**先复制一份真实项目**进去。
 * 断言里的 openProject('comnet')、p.file 等全部经 store/IPC 获取，故无需改动断言；
 * 所有写入都落在临时副本上，真实数据零触碰。退出时删除临时目录。
 */
const SMOKE_PROJECTS_DIR = isSmoke
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mind-map-smoke-'))
  : null;
/* 「撕裂快照」诊断的**读数**：在**拷贝刚完成那一刻**采好（采样点就是下面 cpSync 的下一行），
 * 打印留在 runSmoke 里（输出位置与改前一致）。为什么采样点不能挪进 runSmoke ✗ ——
 *   副本在**模块加载期**就拷好了（那时应用还没起来），而 runSmoke 要等 did-finish-load + 500ms；
 *   这 2~3 秒的窗口里应用启动会把自己的界面状态写进**副本**（`projects/<项目>/.ui-state.json`；
 *   实测 cpSync 后约 0.8 秒就写了一次，内容里带的是**本进程 pid**）⇒ 那个"不一致"读数是副本
 *   自己的合法写入，跟撕裂快照无关。判据、证据与边界见 scripts/smoke/tear-snapshot.js 头注。 */
let SMOKE_COPY_CHECK = null;   // null = 本次没走拷贝路径
if (SMOKE_PROJECTS_DIR) {
  try {
    if (fs.existsSync(REAL_PROJECTS_DIR)) {
      fs.cpSync(REAL_PROJECTS_DIR, SMOKE_PROJECTS_DIR, { recursive: true });
      // ← 采样必须**紧跟** cpSync（这一行的位置本身就是判据的一部分，别挪到 runSmoke 里 ✗）
      try { SMOKE_COPY_CHECK = require('./scripts/smoke/tear-snapshot.js').compareTrees(REAL_PROJECTS_DIR, SMOKE_PROJECTS_DIR); }
      catch (e) { SMOKE_COPY_CHECK = { error: (e && e.message) || String(e) }; }
    }
  } catch (err) {
    console.error('[smoke] 复制项目到沙箱目录失败，改用空目录:', err && err.message);
  }
  // 暴露给断言：有些断言需要在沙箱里放**文件类**夹具（如给"PDF 预览按钮"造一份 PDF），
  // 而 runCli 只能写数据。断言跑在主进程，读这个环境变量即可；真实数据照样零触碰。
  process.env.AI_MINDMAP_PROJECTS_DIR = SMOKE_PROJECTS_DIR;
}
const PROJECTS_DIR = SMOKE_PROJECTS_DIR || REAL_PROJECTS_DIR;

/* 冒烟**启动时**清扫"上一轮留下的空壳"。
 *
 * 为什么非在**启动时**做不可（本批实测读数，别再猜机制）：退出时那份清理**清不掉自己的目录** ——
 * `fs.rmSync()` 递归删之后，顶层 rmdir 一直 `EPERM`（实测连试 6 次、每次读数都是
 * `{"code":"EPERM","left":1,"names":["comnet"]}`），也就是沙箱里那个**项目目录 `comnet` 被
 * 本进程的某个句柄占着**（内容能删、这个目录不能删）⇒ 清到最后只剩一个**空壳**。
 * 而**换一个进程就立刻能删**（实测：新进程对上一轮的壳 `rmdirSync` 一次成功）—— 所以阻塞方
 * 只活在本进程生命周期内，唯一能清掉它的时机是**下一轮的启动**。
 *
 * 三条护栏（缺一条就别做这一条）：
 *   ① 只认 `os.tmpdir()` 下的**直接子目录**且名字前缀是 `ai-mind-map-smoke-`（就是上面 mkdtemp 的命名）；
 *   ② 只调 **`rmdirSync`（非递归）** ⇒ 有内容的目录**物理上删不掉**，不可能误删"正在跑的那一轮"的数据 ✓；
 *   ③ 跳过 mtime 在最近 60 秒内的 —— 活着的沙箱只在"建好目录、还没拷项目"的**微秒窗口**里是空的，
 *      60 秒的余量把"误删别人正在用的沙箱"这条风险压到实际为零。
 * 读数照旧**打印**（清掉几个 / 还剩几个非空的没动），**不当门禁**：非空的那些是历史崩溃留下的
 * （实测有 5 条：comnet 的 assets/attachments 都在），该不该删要人看，不该由冒烟替人决定 ✗。 */
function sweepSmokeHusks() {
  const tmp = os.tmpdir();
  const mine = path.basename(SMOKE_PROJECTS_DIR || '');
  const out = { swept: 0, kept: 0, held: 0, error: '' };
  let entries = [];
  try { entries = fs.readdirSync(tmp, { withFileTypes: true }); }
  catch (err) { out.error = String((err && err.message) || err); return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === mine) continue;
    if (e.name.indexOf('ai-mind-map-smoke-') !== 0) continue;
    const p = path.join(tmp, e.name);
    let st = null;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (Date.now() - st.mtimeMs < 60 * 1000) { out.held += 1; continue; }   // 可能是在跑的那一轮：不动 ✓
    try { fs.rmdirSync(p); out.swept += 1; } catch (err) { out.kept += 1; } // 非空/被占用 ⇒ 不动 ✓（非递归）
  }
  return out;
}
if (SMOKE_PROJECTS_DIR) {
  const husks = sweepSmokeHusks();
  console.log('[smoke] 启动清扫上一轮的空壳：清掉 ' + husks.swept + ' 个 · 跳过（刚生成的）' + husks.held
    + ' 个 · 非空残留没动 ' + husks.kept + ' 个（要清得人工确认）'
    + (husks.error ? ' ｜⚠️ 列举失败：' + husks.error : ''));
}

/* 每域隔离：**默认开** ✓ —— 每个域开跑前还原沙箱副本，并让应用重载当前项目。
 * 为什么默认开：不隔离时全跑会随机炸（实测 137/167 · destroyed 30；真因是**跨域状态污染**，
 *   A/B 证据见 .review/20261008-DSH深度集成调研/scratch/移交-G5收口与续做.md），隔离后同一份
 *   代码 167/167 · destroyed 0 ✓。隔离只多花「每域一次还原+重载」（实测 G5 155s）。
 * 逃生口（**只用于 A/B 诊断/取证** ✗ 别当正常跑法）：MM_SMOKE_NO_ISOLATE=1 或 MM_SMOKE_ISOLATE=0。 */
const smokeIsolate = !!SMOKE_PROJECTS_DIR && !process.env.MM_SMOKE_NO_ISOLATE
  && process.env.MM_SMOKE_ISOLATE !== '0';

// 存取层单源：列表与读取都走 src/data-store.js，不再各自手写 readdir + JSON.parse。
// 历史问题：main.js 曾自建 listProjects() 并裸 JSON.parse 读文件 ——
//   · 与 store.list() 重复实现（两处行为可能分叉）；
//   · 不带 BOM 剥离（带 BOM 的 JSON 在此直接抛错，而 CLI 能正常读）；
//   · project:read 完全不校验（坏数据照样送进渲染层）。
const store = require('./src/data-store.js').createStore(PROJECTS_DIR);
const { writeFileAtomic, versionOf, versionOfText } = require('./src/data-store.js');
const concurrency = require('./src/concurrency.js');
/* 【W13】界面侧导入的两份读数（`import-md` 的文本回显 / `import-dir` 的 `--json` 报告 → 同一种形状）。
 * 纯函数、零 I/O ⇒ 有单测（tests/import-reading.test.js）；"界面自己数一遍"是第二份实现 ✗。
 * ⚠️ 它住在 `scripts/smoke/` 是 **G8 文档登记门禁**逼出来的落点（门禁只查 `scripts/*.js` 顶层并显式豁免
 * `scripts/smoke/`；本批不许动 `docs/ARCHITECTURE.md`）—— 本文件顶部有整段理由与先例（tear-snapshot.js）。 */
const importReading = require('./scripts/smoke/import-reading.js');
/* ---------------- 【R4】绑定工作区文件夹的**事件驱动守护**（零 token） ----------------
 * 用户原话：「绑定工作区文件夹，选择好了之后就会**定时更新**文件夹内容到思维导图」+
 *          「如果有**不消耗 token** 的定时检查或者修改文件的事件驱动就最好了」。
 *
 * ## 这一层只做三件事（判定一行都不在这里）
 *   ① `fs.watch(dir, {recursive:true})` 盯住每个**进行中**绑定的目录（Windows/macOS 原生支持递归）；
 *   ② **防抖**：一次保存会触发好几个 fs 事件 ⇒ 合并成一个批次再动手（防抖毫秒数**来自绑定记录**，
 *      缺省 `src/schema.js` 的 `BINDING_DEBOUNCE_DEFAULT`，不是这里写死的数字）；
 *   ③ 触发时**起一条 CLI**（`bind-sync <项目>`）—— 于是"同步一次"只有一处实现（`cli/commands/project.js`），
 *      版本闸门/并发重放/写盘前校验/界面脏就停**全都复用**，主进程不碰数据面一个字节 ✓。
 *      主进程**不**知道"哪些文件该转成节点"、也**不**读项目 JSON 里的 bindings 去自己判 —— 那会变成第二份实现 ✗。
 *
 * ## 为什么是"起 CLI"而不是"在主进程里直接写"
 *   `ARCHITECTURE.md` §4 的接线边界：**数据改动走 CLI**（唯一写盘出口 + 校验闸门 + 并发版本闸门）。
 *   主进程里再写一条写盘路径 ⇒ 两道闸门同时失效，且"同步"变成第三套导入实现（本批最想避免的）。
 *   代价如实说：每次批次是一次子进程（`ELECTRON_RUN_AS_NODE` 的 node）—— 事件是**低频**的
 *   （人保存一次文件才一次），换来的是"判定只有一处"。
 *
 * ## 三条纪律
 *   ① **零 token**：这条链路上没有任何 LLM 调用（CLI 里也只做字符串处理）；`ask` 那一类**绝不**在这里被调 ✓；
 *   ② **失败要看得见**：CLI 非 0 / 输出 `error:` ⇒ 记下最后一条原因并**发事件**给界面（不静默吞）——
 *      但**不弹模态**（没人应答会把调用方挂死，这是本工程踩过的坑）；
 *   ③ **应用开着才守护**：进程退出即停（用户要的"应用开着时守护"就是这条语义；"应用没开也同步"
 *      需要外部常驻进程/计划任务 —— 那是另开一项，本批不做 ✗）。
 *
 * ## 兜底巡检（`fs.watch` 会漏事件）
 *   某些磁盘/网络盘上 `fs.watch` 会漏事件（设计文档 §二 明确写着）⇒ 配一条**低频**定时器，
 *   每 `BINDING_SWEEP_MS`（10 分钟）对**同一个**目录再跑一次那次同样的 CLI。
 *   为什么是 10 分钟：它是"漏一次也还能在可接受的延迟内补上"与"不做事的时候几乎零代价"之间的取值；
 *   扫描本身按 mtime/大小**增量**（没变的文件一个字节都不读）⇒ 巡检几乎不花 CPU ✓。
 *   为什么选择"同一个入口再跑一次"而不是"另写一套巡检"：巡检若自己判"变没变"，就有了第二份增量口径 ✗。
 */
const BINDING_SWEEP_MS = 10 * 60 * 1000;       // 兜底巡检周期（设计文档 §二：低频扫 mtime，同样零 token）
const bindingWatchers = new Map();             // `${项目}::${绑定id}` → { watcher, timer, debounceMs, dir }
const bindingSweep = { timer: null, running: false };
/** 每个项目**当前挂着哪一批目录**（重挂的判据：只有指纹变了才真重挂 —— 见 bindWatchersFor） */
const recentBindFingerprint = new Map();

/** 把 CLI 的 `--json` 输出解析成对象；解析不出来 ⇒ `null`（**由调用方如实报**，不静默当成功）。
 *  为什么单独一个函数：主进程有三处要读 `bind-sync --json` 的报告（事件驱动 / 巡检 / 界面动作），
 *  "怎么把 CLI 的回显变成结构"只该有一处，否则三处会各自漂。 */
function parseCliJson(out) {
  try {
    const s = String(out || '').trim();
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

/** CLI 失败时给人看的那一句（取最后一行非空输出；与 `importDocToNewProject` 同一条口径） */
function cliErrorLine(r) {
  const out = String((r && (r.err || r.out)) || '').trim();
  return out.split('\n').filter(Boolean).pop() || ('CLI 退出码 ' + (r && r.code));
}

/** 【R4 界面侧】把界面的"导入形态"选项翻成 `bind-sync --bind` 的参数。
 *  为什么翻译只放在主进程：界面不该知道 CLI 的参数名（那是"同一件事两处表达"⇒ 必然漂）——
 *  界面只说 `{mode, include}`，翻参数这一处唯一。**取值合法性不在这里判**：CLI 自己会拒
 *  （`--mode` 只认 flat/mirror），原话回到界面 ⇒ "什么是合法取值"仍然只有 CLI/schema 一处。 */
function bindOptionArgs(opts) {
  const o = opts || {};
  const args = [];
  if (o.mode) args.push('--mode', String(o.mode));
  if (o.include) args.push('--include', String(o.include));
  return args;
}

/** 【R4 界面侧】**一次绑定同步的"前后对拍"读数**：起 CLI 之前读一次项目、回来再读一次，
 *  用 `src/concurrency.js` 的 `changedKeys`（**渲染层"外部改动预览"用的同一个函数**）算出
 *  "这次同步真的动了哪些对象"，并配 `describeKeys` 的人话名。
 *
 *  为什么主进程要算这一份（而不是让界面自己前后比）：
 *  ① **"这次"只有这里说得准**：界面的"基线"只在它自己 `project:read` 时前进，而同步之后界面走的
 *     是**只读探视**（`project:peek`，不推进基线）⇒ 拿界面基线当"同步前"会把上几轮同步的结果
 *     也算成"这次加的" ✗；
 *  ② **没有时序竞态**：`project:disk-changed` 的重读与"同步报告"是两条并发到达的事件，
 *     界面在收到报告时**可能已经**把新树读进内存了 ⇒ "同步前的树"在界面那侧已经不存在了 ✗。
 *     在主进程里"起 CLI 前后各读一次"是唯一不受这两条影响的取法。
 *  ③ 判定仍然是**同一个函数**（`src/concurrency.js`，主进程本来就 require 它）——不是第二份差异实现 ✓。
 *     ⚠️ 【W13】这份读数的**组装**抽成了 `diffTrees`（同一处实现）：界面侧导入那一路
 *     （`app:import-apply`）也要"这批文件到底加了哪些节点"，它与这里**共用同一个函数** ✓
 *
 *  @returns {Promise<{code:number,out:string,err:string,report:object|null,
 *    changedKeys:string[], addedKeys:string[], removedKeys:string[], modifiedKeys:string[],
 *    labels:Object<string,string>}>}   `labels` 是**键→人话名的映射**（配对由这里给死，见下）
 */
async function runBindSyncCli(args, project, projectsDirOverride) {
  const readTree = () => {
    try {
      const r = (projectsDirOverride ? null : store.read(project));
      return (r && r.data) ? r.data : null;
    } catch (e) { return null; }         // 读不到（首次同步前文件坏了等）⇒ 只影响"对拍"那一份，不影响同步本身
  };
  const before = readTree();
  const r = await runCliAsync(args, projectsDirOverride);
  const out = String((r && r.out) || '');
  const err = String((r && r.err) || '');
  const report = parseCliJson(out);
  const after = readTree();
  /* "这次动了哪些对象"**只有一处实现**（下面的 `diffTrees`）—— W13 起界面侧导入也用同一份读数
   * （`app:import-apply`：N 个文件各起一条 CLI，前后各读一次项目、**只算一次差异**）。
   * 这里只负责"什么时候能对拍"：两份树都读得到才比；读不到（项目本来就没有 / 文件坏了）
   * ⇒ 如实留空，不猜一个"大概是这些"出来。 */
  let d = emptyDiff();
  if (before && after) { try { d = diffTrees(before, after); } catch (e) { d = emptyDiff(); } }
  return {
    code: (r && r.code), out: out, err: err, report: report,
    changedKeys: d.keys, addedKeys: d.added, removedKeys: d.removed, modifiedKeys: d.modified,
    labels: d.labels
  };
}

/** 对拍的空档（**只读共用**：调用方只读它，不写它 —— 每次 new 一个，别共享可变对象） */
function emptyDiff() {
  return { keys: [], added: [], removed: [], modified: [], labels: {} };
}

/**
 * 「这次动了哪些对象」—— **唯一实现处**（两份项目树 → 键 + 人话名）。
 *  谁在用：① 绑定同步的前后对拍（`runBindSyncCli`）；② 【W13】界面侧导入的批量对拍
 *  （`app:import-apply`：一批文件各起一条 CLI，前后各读一次、只算一次差异）。
 *  渲染层那侧不重算：它拿这些**键**去喂 `src/concurrency.js` 的 `diffRows` 现出两边的文本
 *  （`MM.renderConcPanel` 的卡片），"哪里不一样"全工程只有这一份口径 ✓。
 *
 *  三类分开用的是**同一份指纹表**（`fingerprint` 每个节点一个键）：
 *    只在 after 里有 ⇒ 这次新出现；只在 before 里有 ⇒ 这次消失；两边都有但值不同 ⇒ 改到。
 *  为什么不用 O(键数 × 树) 的 `snapshotOf` 逐个试：那是一棵树走一遍/次（大项目会明显变慢）✗。
 *  人话名是 `{键: 名}` 的**映射**（不是数组）：三类各截前 40 个再拼成数组的话，调用方没办法把它和键
 *  对上（实测踩到：面板给"新出现的第 1 行"贴了第 2 个对象的名字 ✗）—— 配对关系由产出方给死。
 *
 *  @returns {{keys:string[], added:string[], removed:string[], modified:string[], labels:Object<string,string>}}
 */
function diffTrees(before, after) {
  const fa = concurrency.fingerprint(before);
  const fb = concurrency.fingerprint(after);
  const all = Array.from(concurrency.changedKeys(before, after)).sort();
  const added = all.filter((k) => fa[k] === undefined && fb[k] !== undefined);
  const removed = all.filter((k) => fa[k] !== undefined && fb[k] === undefined);
  const modified = all.filter((k) => fa[k] !== undefined && fb[k] !== undefined);
  const labels = {};
  // 新出现/改到的按 after 取名（它现在长这样）、消失的按 before 取（after 里已经没有了）
  const zip = (list, names) => list.slice(0, 40).forEach((k, i) => { if (names[i]) labels[k] = names[i]; });
  zip(added, concurrency.describeKeys(after, added.slice(0, 40)));
  zip(modified, concurrency.describeKeys(after, modified.slice(0, 40)));
  zip(removed, concurrency.describeKeys(before, removed.slice(0, 40)));
  return { keys: all, added: added, removed: removed, modified: modified, labels: labels };
}

/** 读一份项目树（读不动 ⇒ null；调用方据此决定"能不能对拍"，别在别处再写一遍 try/catch） */
function readProjectTree(project) {
  try {
    const r = store.read(project);
    return (r && r.data) ? r.data : null;
  } catch (e) { return null; }
}

/** 一份树里**所有节点**的键与人话名（【W13】整库导入建成**新项目**时用：
 *  那个项目本来不存在 ⇒ 它的每个节点都是"这次新出现的"，没有"之前"可比 ——
 *  键与名仍然取自同一处（`concurrency` 的 `fingerprint` / `describeKeys`），不是第二套差异算法）。 */
function allNodeKeysOf(tree) {
  const fp = concurrency.fingerprint(tree);
  const keys = Object.keys(fp).filter((k) => k.indexOf('node:') === 0).sort();
  const labels = {};
  concurrency.describeKeys(tree, keys.slice(0, 40)).forEach((name, i) => { if (name) labels[keys[i]] = name; });
  const children = Object.keys(fp).filter((k) => k.indexOf('children:') === 0).sort();
  return { keys: keys.concat(children).sort(), added: keys, labels: labels };
}

/** 一个批次的共同入口：起 CLI 同步一次，把结果如实回报（**判定全在 CLI 那一侧**）。
 *  ⚠️ 回调必须带上 `project`：一批子进程要跑几百毫秒到几秒，期间用户可能**已经切了项目** ——
 *  用"当前窗口那个项目"去解释一个旧批次的结果，会把事件发到错的页面上。
 *
 *  【R4 界面侧】这一轮加了 `--json`（**只多要一份机器可读的回显**，判定与写盘一个字节都没变）：
 *  第④步的界面要显示"本次 +N 改 M / 待确认 K"，还要能**点出这次自动加进来的节点** ——
 *  纯文本回显里没有这些数，只能靠正则去抠（那就成了第二份"格式约定"⇒ 必然漂）。
 *  于是：主进程转发 CLI 报的那一份结构，界面只负责显示（判定仍然只有 CLI 一处 ✓）。 */
function runBindSyncFor(project, why, onDone) {
  if (!project) return;
  runBindSyncCli(['bind-sync', project, '--json'], project)
    .then((r) => {
      const bad = !!r.code || /^error:/m.test(r.out) || !!(r.report && r.report.ok === false);
      if (bad) {
        const last = String(r.err || r.out || '').trim().split('\n').filter(Boolean).pop() || ('CLI 退出码 ' + r.code);
        console.error('[bind-sync] 项目 ' + project + ' 同步失败（' + why + '）：' + last);
      }
      try {
        if (typeof onDone === 'function') {
          onDone({
            ok: !bad, out: r.out, err: r.err, why: why, project: project,
            report: r.report, changedKeys: r.changedKeys, addedKeys: r.addedKeys,
            removedKeys: r.removedKeys, modifiedKeys: r.modifiedKeys, labels: r.labels
          });
        }
      } catch (e) { console.error('[bind-sync] 回调失败：' + ((e && e.message) || e)); }
    })
    .catch((e) => { console.error('[bind-sync] 起 CLI 失败：' + ((e && e.message) || e)); });
}

/** 把某个项目的绑定**全量重挂**：先全停，再按 CLI 报的"该盯哪些目录"重新挂。
 *  为什么每次都用 CLI 问一遍：绑定会被 `--bind` / `--unbind` / `--pause` 改（CLI 侧写的），
 *  主进程不该自己解析项目 JSON 去猜（那是第二份"绑定是什么"的实现 ✗）。
 *
 *  ⚠️ 【R4 界面侧】这里修了一个**会让"暂停"名存实亡**的洞（实机在界面第④步才发现）：
 *  原实现在"没有任何进行中的绑定"时**直接 return**，于是已经把 `fs.watch` 挂上的那些目录
 *  **一个都不收** ⇒ 用户按下「暂停」之后，文件一变，那个还活着的 watcher 照旧起 CLI 去同步；
 *  而 CLI 的同步**不认 paused**（`isBindingActive` 只在 `--watch-dirs` 那处过滤，见 `bind-sync` 的实现）
 *  ⇒ "暂停"在界面上显示为已暂停、数据却还在被改。这不是显示问题，是**控制失效** ✗。
 *  修法只有一条：没有进行中的绑定时，把属于这个项目的 watcher **全部关掉**（并清掉指纹记录），
 *  让"该盯哪些目录"这件事只有 CLI 一个来源、主进程只负责执行"没有就收干净"。
 *  判据：域 42 的判据 3（暂停 ⇒ 改文件**不同步**）+ 判别力证明①（把暂停短路 ⇒ 必红）。 */
function bindWatchersFor(project, onSync) {
  const prefix = (project || '') + '::';
  const mine = () => Array.from(bindingWatchers.keys()).filter((k) => k.indexOf(prefix) === 0);
  /** 关掉属于本项目的那批 watcher（**唯一**的收口：重挂与"没有进行中的绑定"两条路都走它） */
  const closeMine = () => {
    mine().forEach((k) => {
      const w = bindingWatchers.get(k);
      try { if (w && w.watcher) w.watcher.close(); } catch (e) { /* 关不掉不影响别的 */ }
      if (w && w.timer) clearTimeout(w.timer);
      bindingWatchers.delete(k);
    });
  };
  if (!project) return;
  /* 一个**便宜**的前置判据（省掉绝大多数项目的一次子进程）：这个项目的 JSON 里根本没有"进行中"的
   * 绑定时，连 CLI 都不起。⚠️ 这里**只读、只判"有没有"**：取值表/暂停语义/该盯哪个目录仍然是
   * CLI（`--watch-dirs`）说了算 —— 主进程不复制"绑定是什么"的判定（那会变成第二份实现 ✗）。 */
  let fingerprint = '';
  try {
    const pj = path.join(PROJECTS_DIR, project, project + '.json');
    const raw = JSON.parse(fs.readFileSync(pj, 'utf8').replace(/^\uFEFF/, ''));
    const list = Array.isArray(raw.bindings) ? raw.bindings : [];
    const active = list.filter((b) => b && b.dir && (b.status === undefined || b.status === 'watching'));
    // 一个"进行中"的都没有 ⇒ `fingerprint` 留空 ⇒ 走下面的"收干净"分支（**不再直接 return**）
    if (active.length) fingerprint = active.map((b) => b.id + '|' + b.dir + '|' + (b.debounceMs || '')).join('\n');
  } catch (e) { return; }                      // 读不了/没这个项目：不挂（CLI 侧另有如实报错）
  // 收起：这个项目要盯的目录**恰好是空集**（全部暂停 / 已解绑 / 从来没有）⇒ 一个都不许留着
  if (!fingerprint) {
    if (mine().length) {
      closeMine();
      if (process.env.MM_BINDINGS_DEBUG === '1') console.error('[bind-sync] 项目 ' + project + ' 没有进行中的绑定 ⇒ 已收掉监听');
    }
    recentBindFingerprint.delete(project);
    return;
  }
  /* **已经挂着同一批目录就别重挂**：`project:read` 会被反复调用（每次同步完都会让界面重读一次），
   * 每读一次就关掉再开一遍 fs.watch 是无意义的句柄churn，而且会在两次重挂的缝里漏事件。 */
  if (mine().length && recentBindFingerprint.get(project) === fingerprint) return;
  recentBindFingerprint.set(project, fingerprint);
  // 全停（换了绑定/换了目录 ⇒ 旧的必须收干净，否则一个目录会被两份 watcher 同时盯着）
  closeMine();
  let out = '';
  try {
    out = runCli(['bind-sync', project, '--watch-dirs']);
  } catch (e) {
    // 没有绑定 / 项目读不了 / 命令行不通 ⇒ 一个都不挂（**这不是错误**：绝大多数项目根本没绑定）
    if (process.env.MM_BINDINGS_DEBUG === '1') console.error('[bind-sync] 取绑定目录失败：' + ((e && e.message) || e));
    return;
  }
  const rows = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return;
  rows.forEach((line) => {
    const parts = line.split('\t');
    const id = parts[0], dir = parts[1];
    const debounceMs = Number(parts[2]) || 800;
    const mode = parts[3] || 'flat';
    const key = project + '::' + id;
    if (!dir || !fs.existsSync(dir)) return;              // 目录没了：不挂（CLI 侧会如实报 dir-missing）
    let timer = null;
    let watcher = null;
    /* ⚠️ **必须先把路径规范化**（`fs.realpathSync.native`）—— 这是本批**实机踩到的一个崩溃**：
     *   Windows 上把**8.3 短名**路径（如 `C:\Users\JUNNAN~1.TAN\…`，`os.tmpdir()` 给的就是它）
     *   交给 `fs.watch(dir, {recursive:true})`，libuv 会在 `src/win/fs-event.c:72` 抛原生断言
     *   （`!_wcsnicmp(filename, dir, dirlen)`，见 nodejs/node#46794）—— 整台 Electron 进程当场死掉，
     *   用户看到的只是"应用突然没了"。`realpathSync.native` 把短名摊成长名 ⇒ 断言不成立。
     *   npm 模块的 `require.resolve` 与临时目录都可能带 `~1`，所以这不是"只影响测试"的坑。
     *   规范化失败（权限/路径消失）⇒ 用原路径试一次（行为与从前一致，不因此不守护）。 */
    let watchDir = dir;
    try {
      const native = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
      if (native) watchDir = native;
    } catch (e) { /* 用原路径 */ }
    const fire = () => {
      timer = null;
      runBindSyncFor(project, 'fs.watch', onSync);
    };
    /* 递归优先（能报"哪个子目录变了"），**退化时如实说出来**：递归不可用时退到单层监听 ——
     * 单层监听照样能收到整棵树的事件（`fs.watch` 对子树里的文件创建/修改会报出该文件名的名字），
     * 而同步本身是**整目录重扫 + 增量**，不依赖事件带来的路径 ⇒ 功能不受影响，只是少一条诊断信息。
     * ⚠️ 不许静默退化：这条日志就是"为什么没看到子目录名"的答案。 */
    const startWatch = (recursive) => fs.watch(watchDir, { recursive: recursive, persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
    });
    try {
      watcher = startWatch(true);
    } catch (e) {
      console.error('[bind-sync] 递归监听 ' + watchDir + ' 起不来（' + ((e && e.message) || e)
        + '）—— **退化到单层监听**（同步功能不受影响：那是整目录重扫 + 增量）');
      try { watcher = startWatch(false); }
      catch (e2) { console.error('[bind-sync] 单层监听也起不来 ' + watchDir + '：' + ((e2 && e2.message) || e2)); return; }
    }
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (e) => {
        // 监听失败不致命（兜底巡检还在）：但**必须说出来** —— 静默的守护等于没有守护 ✗
        console.error('[bind-sync] 监听 ' + watchDir + ' 出错（'+ ((e && e.message) || e) + '）—— 改靠兜底巡检（每 '
          + Math.round(BINDING_SWEEP_MS / 60000) + ' 分钟一次）');
      });
    }
    bindingWatchers.set(key, { watcher: watcher, timer: null, debounceMs: debounceMs, dir: watchDir, mode: mode, project: project });
  });
  if (process.env.MM_BINDINGS_DEBUG === '1') {
    console.error('[bind-sync] 项目 ' + project + ' 挂了 ' + rows.length + ' 个目录监听');
  }
}

/** 兜底巡检（**同一个入口再跑一次**，不另写一套判定）：每 BINDING_SWEEP_MS 把有绑定的项目各同步一次 */
function startBindingSweep(onSync) {
  if (bindingSweep.timer) return;
  bindingSweep.timer = setInterval(() => {
    if (bindingSweep.running) return;                 // 上一轮还没跑完 ⇒ 这一拍跳过（不排队堆积）
    /* 【R4 界面侧】动手之前**先按当前状态重挂一次**（`bindWatchersFor` 只读项目 JSON + CLI，零写盘）：
     * 绑定可能被**外部 CLI** 暂停/解绑（不是经界面按的），那种情况下上面的 watcher 集合是旧的 ——
     * 而 CLI 的同步不认 paused ⇒ 巡检会替一个"人已经按了暂停"的绑定去同步（又是"暂停名存实亡"）✗。
     * 重挂一次就自动收干净（见 `bindWatchersFor` 的"收起"分支），这一轮只对**仍然该守护**的项目动手。 */
    Array.from(new Set(Array.from(bindingWatchers.keys()).map((k) => k.split('::')[0]))).forEach((p) => {
      try { bindWatchersFor(p, onSync); } catch (e) { /* 重挂失败不阻断本轮：下面按现有集合继续 */ }
    });
    const projects = Array.from(new Set(Array.from(bindingWatchers.keys()).map((k) => k.split('::')[0])));
    if (!projects.length) return;
    bindingSweep.running = true;
    Promise.all(projects.map((p) => runBindSyncCli(['bind-sync', p, '--json'], p)))
      .then((rs) => {
        rs.forEach((r, i) => {
          const out = String((r && r.out) || '');
          const report = r && r.report;
          const ok = r && r.code === 0 && !/^error:/m.test(out) && !(report && report.ok === false);
          if (!ok) {
            console.error('[bind-sync] 兜底巡检失败（项目 ' + projects[i] + '）：'
              + String((r && (r.err || r.out)) || ''));
            return;
          }
          // 巡检也是"自动同步"⇒ 同样要把报告交出去（第④步的变更播报与状态区都吃它）
          if (typeof onSync === 'function') {
            onSync({
              ok: true, out: out, err: '', why: 'sweep', project: projects[i],
              report: report, changedKeys: r.changedKeys, labels: r.labels
            });
          }
        });
      })
      .catch((e) => console.error('[bind-sync] 兜底巡检异常：' + ((e && e.message) || e)))
      .then(() => { bindingSweep.running = false; });
  }, BINDING_SWEEP_MS);
  // 定时器不该拖住进程退出（应用关了就不守护 —— 这是本批明确的边界）
  if (bindingSweep.timer && typeof bindingSweep.timer.unref === 'function') bindingSweep.timer.unref();
}

/** 收尾：进程退出前把监听与定时器全关掉（不留孤儿句柄） */
function stopBindingWatchers() {
  Array.from(bindingWatchers.values()).forEach((w) => {
    try { if (w && w.watcher) w.watcher.close(); } catch (e) { /* ignore */ }
    if (w && w.timer) clearTimeout(w.timer);
  });
  bindingWatchers.clear();
  recentBindFingerprint.clear();
  if (bindingSweep.timer) { clearInterval(bindingSweep.timer); bindingSweep.timer = null; }
}

/*
 * 每个项目「渲染层手里那份数据是从哪个版本读来的」。
 *
 * 为什么记在**主进程**而不是渲染层：渲染层不需要知道版本的存在，也就不会漏传。
 * 为什么这样够用（实测核过）：渲染层**所有**读路径都走 `project:read`
 * （openProject / switchProject / CLI 介导写之后的回读，见 renderer/editor.js:93-95
 * 与 app-actions.js:350/391），因此这里的记录自动跟得上；只有**外部写入者**
 * （AI / 别的 CLI 进程）写盘时它才不会更新 —— 那正是要抓的情况。
 */
const versionAtRead = new Map();

/**
 * 「渲染层这一份是从**什么内容**读来的」—— 三方合并要用的基线。
 *
 * `versionAtRead` 只记版本指纹，够用来**发现**冲突；但阶段 2 要**合并**，就必须知道
 * "界面相对当初读到的样子改了哪些对象"。故在同一个地方把那份数据也留下（项目 JSON 百 KB 级，
 * 一份内存拷贝的代价可接受）。
 * 与 `versionAtRead` **同生共死**：`project:read` 时一起写，保存成功后一起推进。
 */
const baseAtRead = new Map();

/** 读某项目的版本；项目名非法 / 文件不存在 → null（不抛，供探测用） */
function versionOfSafe(name) {
  try {
    const f = store.projectFile(name);
    return fs.existsSync(f) ? versionOf(f) : null;
  } catch (err) { return null; }
}

/**
 * 「**代渲染层写盘**」成功之后，推进版本记录。
 *
 * 为什么需要它：有些写操作是渲染层**请求主进程经 CLI 完成**的（例如 `assoc-edit`）。
 * 那条路径不会走 `project:read`，于是版本记录会停在旧值 —— 渲染层随后保存时会被
 * 闸门**误判为冲突**（实测：`scripts/smoke/11-dsh-sidebar.js` 的两条断言因此变红）。
 * 渲染层自身在那种路径上是**同步了内存**的（见 `renderer/app-assoc.js` 的
 * "磁盘已由 CLI 写好，内存必须跟上"），所以推进是正确的。
 *
 * **只在「写入前盘上版本 == 渲染层手里那一版」时才推进** —— 这条前置条件正是它安全的原因：
 *   · 成立 ⇒ 这次 CLI 写入是**叠加在渲染层那版之上**的 ⇒ 推进正确；
 *   · 不成立 ⇒ 外部（AI/别的 CLI）早已写过更新的版本、渲染层手里是旧的 ⇒
 *     **绝不能推进**，否则它随后保存那份旧树会把外部改动抹掉（真冲突被掩盖）。
 * 读命令不改盘（after == before）⇒ 不推进。
 *
 * 这个判据不需要维护"哪些命令会写盘"的白名单，因此不存在漏登记的漂移风险。
 */
function refreshVersionIfOwnWrite(name, before) {
  if (!name || before === null) return;
  if (versionAtRead.get(name) !== before) return; // 别处已写过 ⇒ 保持旧记录，让冲突暴露出来
  const after = versionOfSafe(name);
  if (after !== null && after !== before) {
    versionAtRead.set(name, after);
    // 基线也跟着推进：渲染层内存已同步到这次写入的结果（见上方"渲染层自身在那种路径上是同步了内存的"），
    // 于是"我的改动"应当从这一版起算 —— 否则下次保存会把这次 CLI 写入算成界面的改动。
    try { baseAtRead.set(name, store.read(name).data); } catch (e) { baseAtRead.delete(name); }
  }
}

const uiState = require('./src/ui-state.js');
// 热度条（第三件·A）：界面那次"人打开详情框"的采样 —— 用的是与 CLI 埋点**同一个**记录实现
// （上限/去重/失败口径只有一处：src/heat-sensor.js），不另起一套写盘逻辑。
const heatSensor = require('./src/heat-sensor.js');

// --export-image <项目> <输出.png>：离屏渲染整树并截图导出（headless 可测）
const exportImageArgs = (() => {
  const i = process.argv.indexOf('--export-image');
  if (i >= 0) return { project: process.argv[i + 1], out: process.argv[i + 2] };
  return null;
})();

// --export-window <输出.png>：整窗截图（主页面 + **原生侧栏 view** 合成），尺寸取窗口实际大小。
// 为什么需要：侧栏是原生 WebContentsView，主页面 capturePage() 里没有它 ✗ —— 想"看到侧栏"
// 只能分别截图再合成（scripts/vision/window-shot.js）。本模式会**接管驻留服务**（不孵化、不收割）。
const exportWindowArgs = (() => {
  const i = process.argv.indexOf('--export-window');
  if (i >= 0) return { out: process.argv[i + 1] };
  return null;
})();

// 截图导出模式禁用 GPU 硬件加速：规避偶发 UnknownVizError（合成器崩溃导致截图失败）。
// 注意：仅 export-image 模式禁用——冒烟等其他模式保持默认（实测禁用后冒烟进程崩溃）。
if (exportImageArgs) app.disableHardwareAcceleration();

// 真退出放行标志：✕ = 藏到后台（侧栏保活），只有「文件 → 退出 / Ctrl+Q」会置位它并真的退出。
let quitting = false;
app.on('before-quit', () => { quitting = true; });

// ── 单实例 + "把窗口调回来" ──────────────────────────────────────────────
// 为什么必须有：✕ 改成"藏到后台"之后就**没有回去的路**了 —— 实测发现（藏起来后既没有托盘、
// 也没有任何调用 restoreWindow 的地方，而再启动一次会开出**第二个**实例 ✗）。
// 现在的语义：重复启动 = 把已经在跑的那个（可能藏在后台的）主界面调回前台，本次进程自己退出。
// ⚠️ 只在**真实交互模式**里用单实例锁：冒烟/导出图是独立的一次性进程，与用户正在跑的实例共存是正常的 ——
// 加锁会把它们挡掉。实测后果：G5 从 ~90s 掉到 **2.2s**，**冒烟根本没跑却判"通过"** ✗（假绿）。
const headlessMode = !!(isSmoke || exportImageArgs || exportWindowArgs);
const gotSingleLock = headlessMode ? true : app.requestSingleInstanceLock();
if (!gotSingleLock) {
  console.log('[main] 已有实例在运行：本次启动只负责把它调回前台，然后退出');
  app.quit();
}
app.on('second-instance', () => {
  console.log('[main] 收到第二次启动请求：把主界面调回前台');
  dshSidebar.restoreWindow();
});

/* 冒烟结束（含 app.exit 与异常退出）都要清掉临时项目目录，避免在系统 temp 里堆积。
 *
 * ⚠️ **历史现象（本批实测）**：每个冒烟进程结束都会在 `%TEMP%` 留下一个**空**目录
 *   （开工时实测 529 个，内容清掉了、**顶层目录**还在）。根因不是"没清"，而是三件事：
 *   ① 顶层目录在本进程里**清不掉**：实测连试 6 次、每次读数都是
 *      `{"code":"EPERM","left":1,"names":["comnet"]}` —— 沙箱里那个项目目录被本进程的某个句柄
 *      占着（子内容能删、这个目录不能删），阻塞方随进程死亡才释放；
 *   ② 一次 `rmSync` 失败就被 `catch` 吞掉 ⇒ 留下空壳，且**没有任何读数**；
 *   ③ `app.exit()` **不触发 `will-quit`** ⇒ 只剩 `process.on('exit')` 这一次机会，没有第二次尝试。
 * 对策（**分工要分清**，别指望其中任何一条单独修好它）：
 *   · **重试 + 读数**（这一处）：自己写重试循环 + **同步**小睡（退出钩子没有 `await` 的机会 ⇒
 *     `Atomics.wait`，Node 允许在主线程用它；不允的宿主退回忙等）。读数 = `{ ok, attempts, left, code, trace }`
 *     —— 清掉了吗 / 第几次成功 / 还剩几条 / 每次尝试的错误码。⚠️ **实测：重试并不能清掉它**
 *     （6 次全 EPERM），所以这里的作用是"**让现象可见**"，不是"修好"。
 *   · **真正的修法在下一轮启动**：见下面 `sweepSmokeHusks()`（换进程就能删，实测一次成功）。
 *   · 静默的泄漏与"没有泄漏"长得一样 ⇒ 两次读数都要打印（见 runSmoke 收尾那一行）✗。
 * 边界：本次**不**把清理结果并进冒烟 exit code（那会给"杀毒/索引/另一个冒烟进程占着目录"造一个新的
 *   假红源），判据只到"读数可见"这一档；要不要升级成门禁，等有跨机器读数再定。 */
let cleanupSmokeTemp = () => ({ ok: true, attempts: 0, left: 0, code: '' });   // 非冒烟模式：空实现
if (SMOKE_PROJECTS_DIR) {
  /** 同步小睡（只在**同步**上下文里用：will-quit / process.exit 里没有 await 的机会） */
  const sleepSync = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (e) { const until = Date.now() + ms; while (Date.now() < until) { /* 兜底忙等（极少数宿主不允许 Atomics.wait） */ } }
  };
  cleanupSmokeTemp = () => {
    const MAX = 6;
    let code = '';
    const trace = [];        // 每次尝试的读数（只在失败时被打印：它回答"到底卡在哪一条"）
    for (let attempts = 1; attempts <= MAX; attempts++) {
      code = '';
      try {
        fs.rmSync(SMOKE_PROJECTS_DIR, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
      } catch (err) { code = (err && err.code) || String((err && err.message) || err); }
      if (!fs.existsSync(SMOKE_PROJECTS_DIR)) return { ok: true, attempts: attempts, left: 0, code: '', trace: trace };
      let names = [];
      try { names = fs.readdirSync(SMOKE_PROJECTS_DIR).slice(0, 6); } catch (err) { names = ['(目录读不到: ' + ((err && err.code) || err) + ')']; }
      trace.push({ n: attempts, code: code, left: names.length, names: names });
      if (attempts < MAX) sleepSync(60 * attempts);   // 让占用方（子进程 / 杀毒 / 索引）松手
    }
    const last = trace[trace.length - 1] || { code: code, left: -1 };
    return { ok: false, attempts: MAX, left: (last.left === undefined ? -1 : last.left), code: code, names: last.names || [], trace: trace };
  };
  app.on('will-quit', () => { cleanupSmokeTemp(); });
  process.on('exit', () => { cleanupSmokeTemp(); });
}

/* ---------------- 工具函数 ---------------- */
function runCli(args) {
  // 写前版本快照：runCli 成功后代渲染层写盘的情况要推进版本记录（见 refreshVersionIfOwnWrite）。
  // 多数命令的 args[1] 就是项目名；不是的（如 import-json 的输入文件路径）取到 null ⇒ 不参与。
  const projName = (args.length > 1 && typeof args[1] === 'string') ? args[1] : null;
  const versionBefore = projName ? versionOfSafe(projName) : null;

  const res = spawnSync(process.execPath, [CLI].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, {
      // 关键：让 electron.exe 以 Node 模式运行 CLI 脚本（否则会当新 Electron 应用启动而卡死）
      ELECTRON_RUN_AS_NODE: '1',
      // 关键：把**项目根目录**一并传给子进程。CLI 在自己的进程里算 projects/ 路径，
      // 不传的话它指向**真实目录** —— 于是"渲染层随便写、反正写的是副本"的假设
      // 在经 CLI 的写操作上不成立，冒烟会真的改动用户数据
      // （曾实际发生：关系审计断言调用 link，把一条链接写进了真实项目）。
      AI_MINDMAP_PROJECTS_DIR: PROJECTS_DIR,
      // 变更日志的"谁在写"：经 CLI 的写操作是**界面代渲染层发起的**（如 assoc-edit），
      // 记成 `gui-cli:<命令>` 而不是 `cli:<命令>` —— 否则事后看日志会以为是外部 AI 干的
      MM_WRITER: 'gui-cli'
    })
  });
  // 注意：不能把 stderr 拼进返回文本——Electron 模式下子进程 stderr 常带 crashpad 噪音，
  // 会污染 JSON 解析。失败判据用退出码 + stdout 的 "error:" 前缀（mm-cli 两者一致）。
  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  if (res.status !== 0 || /^error:/.test(out)) {
    throw new Error(err || out || 'mm-cli exited ' + res.status);
  }
  refreshVersionIfOwnWrite(projName, versionBefore);
  return out;
}

// 列表统一走 store.list()（含 BOM 剥离与 meta 容错）；保留函数名以兼容既有调用点。
function listProjects() {
  return store.list();
}

/* ---------------- 功能 5a：大文件 → 新项目（菜单与拖拽**共用这一段**） ----------------
 * 为什么共用：两条入口若是各写一份，行为迟早分叉（一个会去重项目名、另一个不会 ✗）。
 * 为什么**异步**跑 CLI：大文件（几十 MB 的 txt/md）解析要几秒，spawnSync 会把界面卡住 ✗。 */
/**
 * @param {string[]} args CLI 参数
 * @param {string} [projectsDirOverride] 只给【R4 绑定前预览】用：把子进程的 `AI_MINDMAP_PROJECTS_DIR`
 *   指到一份**演练副本**上（`app:bind-preview` 的解释见那里）。不给 ⇒ 与从前逐字节相同（走真实沙箱根）。
 */
async function runCliAsync(args, projectsDirOverride) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CLI].concat(args), {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          ELECTRON_RUN_AS_NODE: '1',
          AI_MINDMAP_PROJECTS_DIR: projectsDirOverride || PROJECTS_DIR,
          MM_WRITER: 'gui-cli'
        })
      });
    } catch (err) { resolve({ code: -1, out: '', err: String((err && err.message) || err) }); return; }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out: out, err: err + String((e && e.message) || e) }));
    child.on('close', (code) => resolve({ code: code, out: out, err: err }));
  });
}

/** 项目名清洗：只留字母/数字/汉字/下划线/连字符（其余换 `-`），并压掉连续连字符 */
function sanitizeProjectName(s) {
  let t = String(s || '').normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-');
  t = t.replace(/^[-_]+|[-_]+$/g, '').slice(0, 40);
  return t || 'imported';
}

/**
 * 【W13】**演练副本**：搭一份"看起来像真 store"的临时 projects 根 —— 导入预览就跑在它上面。
 * 为什么不能只拷目标项目那一个 JSON（第一版那样写，实测会造出**预览与真跑不一致**的落差 ✗）：
 *   · `import-dir` 的"这份文件是不是已经导过了"是**跨项目**查的（它扫全部项目）⇒ 副本里只有当前项目、
 *     别的项目一律看不见 ⇒ 预览说"能导"、真跑被"已经导过了"拒掉 ✗；
 *   · md 里的图片/附件引用可能只认**项目自己的** `assets/` / `attachments/` ⇒ 副本里没有它们，
 *     预览会把"能导"报成"引用有问题" ✗。
 * ⇒ 副本 = **全部项目的 JSON** + 目标项目的 `assets/`、`attachments/`（不带别的东西：副本越小越好，
 *   而且写也只可能写进副本 —— CLI 那一侧还套着 `--dry-run` 的中央短路，用户项目那一路一个字节都没动）。
 * 拷不动的那几份**如实少带**（返回值就是清单）：预览会更悲观，但绝不假装"带上了"。
 *
 * @param {string} root 已经建好的临时根
 * @param {string} [projectName] 目标项目（目录导入那一路没有"当前项目"，此时只带全部 JSON）
 * @returns {{root:string, projects:number, resDirs:string[]}}
 */
function makeRehearsalRoot(root, projectName) {
  let all = [];
  try { all = store.list().map((p) => p.name); } catch (e) { all = []; }
  let copied = 0;
  all.forEach((n) => {
    const json = path.join(PROJECTS_DIR, n, n + '.json');
    if (!fs.existsSync(json)) return;
    try {
      fs.mkdirSync(path.join(root, n), { recursive: true });
      fs.copyFileSync(json, path.join(root, n, n + '.json'));
      copied += 1;
    } catch (e) { /* 少带一个项目 ⇒ 预览可能更悲观；不静默当"有" */ }
  });
  const resDirs = [];
  if (projectName) {
    ['assets', 'attachments'].forEach((sub) => {
      const from = path.join(PROJECTS_DIR, projectName, sub);
      if (!fs.existsSync(from)) return;
      try { fs.cpSync(from, path.join(root, projectName, sub), { recursive: true }); resDirs.push(sub + '/'); }
      catch (e) { /* 同上 */ }
    });
  }
  return { root: root, projects: copied, resDirs: resDirs };
}

/** 从文件导入成新项目：名字取文件名（重名自动加 -2/-3）；返回 {ok, name, out, error} */
async function importDocToNewProject(filePath) {
  const ext = path.extname(filePath || '');
  const base = sanitizeProjectName(path.basename(filePath || '').replace(/\.[^.]+$/, ''));
  let name = base, n = 1;
  while (fs.existsSync(path.join(PROJECTS_DIR, name))) { n += 1; name = base + '-' + n; if (n > 99) break; }
  const r = await runCliAsync(['import-project', name, filePath]);
  if (r.code !== 0) {
    const msg = (r.err || r.out || '').trim().split('\n').filter(Boolean).pop() || ('CLI 退出码 ' + r.code);
    return { ok: false, name: name, error: msg.replace(/^error:\s*/, '') };
  }
  return { ok: true, name: name, ext: ext, out: (r.out || '').trim() };
}

/** 导入成功后统一收尾：刷新项目列表 + 打开新项目 + 提示（两条入口共用，行为一致 ✓）
 *  ⚠️ 收尾要发给**发起那一侧的 webContents**，不能用模块级的 `win` ——
 *  `win` 在 main.js 里只是各处的参数/局部变量，IPC handler 里根本没有它
 *  （实测：写成 `win.webContents.send` ⇒ `ReferenceError: win is not defined` 整条导入链失败 ✗）。 */
function afterDocImported(res, targetWebContents) {
  const wc = targetWebContents;
  if (!wc) return;
  wc.send('menu:project-changed');
  wc.send('menu:open-project', res.name);
  wc.send('app:toast', '已从文件创建项目「' + res.name + '」并打开'
    + ((res.out && res.out.split('\n')[0]) ? '——' + res.out.split('\n')[0] : ''));
}

/** 菜单入口：选文件 → 导入（拖拽那条走 IPC，见下面的 app:import-doc） */
async function importDocDialog(w) {
  const res0 = await dialog.showOpenDialog(w, {
    title: '选一个大文件（.md / .txt / .docx）生成新项目',
    properties: ['openFile'],
    filters: [
      { name: '可导入的文档', extensions: ['md', 'markdown', 'txt', 'text', 'docx'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (res0.canceled || !res0.filePaths || !res0.filePaths.length) return;
  const res = await importDocToNewProject(res0.filePaths[0]);
  if (!res.ok) {
    win.webContents.send('app:toast', '导入失败：' + res.error);
    dialog.showMessageBox(win, { type: 'error', title: '导入失败', message: '没能从文件生成项目',
      detail: res.error + '\n\n支持 .md / .txt / .docx / 带书签的 .pdf；无书签的 PDF 与多书自动判定尚未批准（5b 的其余部分）。' });
    return;
  }
  afterDocImported(res, win.webContents);
}

/** 窗口 ---------------- */
function createWindow(opts) {
  // headless（--smoke / --export-image）：窗口离屏，不显示、不进任务栏、不抢焦点。
  const headless = !!(opts && opts.show === false);
  const win = new BrowserWindow({
    width: (opts && opts.width) || 1440,
    height: (opts && opts.height) || 900,
    minWidth: 960,
    minHeight: 600,
    title: 'AI MindMap',
    show: (opts && opts.show) !== false,
    // 构造期直接声明不进任务栏：对从未显示过的隐藏窗口，事后 setSkipTaskbar
    // 的 Windows 样式不生效（14 号断言实测 isSkipTaskbar=false），必须走构造选项。
    skipTaskbar: headless,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关键：隐藏窗口若被后台节流，定时器降频、rAF 暂停，冒烟断言与截图会拿到旧帧/黑屏。
      backgroundThrottling: !headless,
      // 关键：保证 show:false 的窗口在首次显示前也进行绘制（capturePage 才能读到真实帧）。
      paintWhenInitiallyHidden: true
    }
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  return win;
}

/* ---------------- 工具：取当前项目名 / 发提示 ---------------- */
function getCurrentProjectName(win) {
  return win.webContents.executeJavaScript(
    'window.MMApp && window.MMApp.getState && window.MMApp.getState().project ? window.MMApp.getState().project.name : ""'
  );
}
function toast(win, text, isErr) {
  if (!win.isDestroyed()) win.webContents.send('app:toast', text, !!isErr);
}

/* capturePage 偶发 UnknownVizError（GPU 合成器环境问题），失败自动重试 */
async function captureRetry(win, tries) {
  const n = tries || 3;
  for (let i = 0; i < n; i++) {
    try { return await win.webContents.capturePage(); }
    catch (err) {
      if (i === n - 1) throw err;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

/* 冒烟窗口的**固定尺寸**（取景确定性 · 阶段 2）
 * 为什么必须显式传：原先 smoke 只传 `{show:false}`，走的是 BrowserWindow 的**默认尺寸** ——
 * 而默认值会随 Electron 版本变。本工程的落地案例记过这次误判（见 `docs/ARCHITECTURE.md` §4b ADR「静默验证分层（L0–L4）与工程偏离」的记录）：
 * 「旧版写『固定窗口尺寸已落地』—— 实测不成立…**别再把默认值当固定值**」。
 * 1440×900 就是**当前默认值**（实测客户区 1424×835）⇒ 抽出它**不改变任何现有截图的尺寸**，
 * 只是把"隐式依赖默认值"改成"显式声明"。 */
const SMOKE_VIEW = { width: 1440, height: 900 };

/* 截图前的**取景准备**（阶段 2 的核心）：把已知的非确定性来源逐个消掉，再截图。
 * 每一条都对应一个实测到或文档已记录的非确定性来源：
 *   ① 复位缩放/平移  `window.MMApp.resetView`（API 名是查出来的，不是猜的，见下方注释）
 *   ② 展开全树       与 export-image 同款；保证画面涵盖全部内容，L2 ROI 才有意义
 *   ③ 禁过渡动画     `renderer/style.css` 的 `.float-detail { transition: opacity .12s }`；
 *                    截图若落在过渡中间，帧内容随机
 *   ④ 清状态栏       **唯一被实测证明的硬阻碍**：`save()` 会写
 *                    `'已保存 ' + new Date().toLocaleTimeString()`（`renderer/app-actions.js`），
 *                    而冒烟末尾的断言就调它 ⇒ 每次运行的截图内容必然不同、哈希必不相等
 *   ⑤ 等 ≥2 帧       原先只有固定的 `setTimeout(500)`，那不是"等渲染稳定"
 *
 * **① 是后来补的**（原先写着"未做，需要先确认 API 名，未验证前不猜"；查到后补上）：
 * API 名 = `window.MMApp.resetView`（`renderer/app.js:163` 导出，`renderer/app-view.js:969` 实现 ——
 * 100% 缩放 + 根节点居中 + 清空拖动造成的树偏移）。
 * **为什么它必须做**：只要**任何一条**冒烟断言改过缩放或平移，截图就不再是"同一取景" ⇒ 哈希会变、
 * 取景确定性名存实亡。补上之前，这一条只靠"没人改过"侥幸成立。 */
async function prepareCapture(win) {
  // ⚠️ **顺序是有讲究的，而且是被实测抓出来的**：
  //   第一版我把"复位缩放/平移"放在最前、"禁过渡动画"放在其后 —— 结果两次运行的哈希**不再一致**
  //   （`unique` 462 vs 468）：因为 `resetView()` 会改变视图，若它伴随 CSS 过渡，
  //   而过渡还没被禁掉，截图就会**捕捉到动画的中间帧**。
  //   ⇒ **先禁过渡，再做任何会改变视图的动作。**
  await win.webContents.executeJavaScript(`(async () => {
    // ① 最先：禁过渡/动画 —— 它是后面所有"改变视图"动作的前提（否则会截到过渡中间帧）
    const st = document.createElement('style');
    st.id = '__smoke_determinism__';
    st.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(st);
    // ② 复位缩放/平移（API 名是查出来的：window.MMApp.resetView，见上方注释）
    if (window.MMApp && window.MMApp.resetView) window.MMApp.resetView();
    // ③ 展开全树
    const jm = window.MMApp && window.MMApp.getState && window.MMApp.getState().jm;
    if (jm && jm.expand_to_depth) jm.expand_to_depth(999);
    // ④ 清状态栏（resetView 自己也会写状态栏文案，故它必须在复位之后清）
    const s = document.querySelector('#status-text');
    if (s) s.textContent = '';
    // ⑤ 等字体就绪 + ≥2 帧
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

/* ---------------- 导入导出对话框（文件菜单） ---------------- */
async function exportJsonDialog(win) {
  const project = await getCurrentProjectName(win);
  if (!project) { toast(win, '请先打开一个项目', true); return; }
  const res = await dialog.showSaveDialog(win, {
    title: '导出 JSON 打包（aimap 单文件，图片内嵌）',
    defaultPath: project + '.aimap.json',
    filters: [{ name: 'AI MindMap 打包', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return;
  try { toast(win, runCli(['export-json', project, res.filePath])); }
  catch (e) { toast(win, '导出失败: ' + e.message, true); }
}

async function importJsonDialog(win) {
  const res = await dialog.showOpenDialog(win, {
    title: '导入 JSON 打包（aimap 单文件）',
    properties: ['openFile'],
    filters: [{ name: 'AI MindMap 打包', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths.length) return;
  try {
    toast(win, runCli(['import-json', res.filePaths[0]]));
    if (!win.isDestroyed()) win.webContents.send('menu:project-changed');
  } catch (e) { toast(win, '导入失败: ' + e.message, true); }
}

async function exportImageDialog(win) {
  const project = await getCurrentProjectName(win);
  if (!project) { toast(win, '请先打开一个项目', true); return; }
  const res = await dialog.showSaveDialog(win, {
    title: '导出当前导图为 PNG 图片',
    defaultPath: project + '.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });
  if (res.canceled || !res.filePath) return;
  try {
    // 展开全树并等渲染稳定（约 1.5s），再截取整窗
    await win.webContents.executeJavaScript(
      `(async () => {
        const jm = window.MMApp && window.MMApp.getState() && window.MMApp.getState().jm;
        if (jm) jm.expand_to_depth(999);
        await new Promise(r => setTimeout(r, 1500));
      })()`
    );
    const img = await captureRetry(win);
    fs.writeFileSync(res.filePath, img.toPNG());
    toast(win, '图片已导出: ' + res.filePath);
  } catch (e) { toast(win, '导出失败: ' + e.message, true); }
}

/* ---------------- 菜单 ----------------
 * ⚠️ 导图页可以被**真关**（卸载这一页，见 main-dsh-sidebar.js 的 closeMapPage）。卸载期间，
 * 下面这些菜单项点下去只会"发进一个空页" ⇒ 用户看到的是**毫无反应** ✗ —— 那正是本轮要
 * 消灭的那类缺陷。所以：所有"要么发给导图页渲染层、要么必须靠导图页才能成立"的项都打上 id，
 * 关闭时统一**置灰**、重开时恢复 ✓（`setMapPageMenuEnabled`）。
 * 判据由冒烟钉住：关闭期间菜单里禁用的项数 ≥ 本清单长度，重开后回到 0（见 smoke/23-*）。 */
const MAP_PAGE_MENU_IDS = [
  // 文件：全部要靠导图页（导出要用它的树；导入的结果也要它来显示，否则 toast 也发进空页 ✗）
  'map-menu-import-md', 'map-menu-import-doc', 'map-menu-export-md',
  'map-menu-import-json', 'map-menu-export-json', 'map-menu-export-png',
  // 【W13】界面侧导入入口的两条（同上面几条：要拿"当前项目 + 选中的节点"去导 ⇒ 导图页不在时点了没意义）
  'map-menu-import-files', 'map-menu-import-dir',
  // 【R4】绑定工作区文件夹：入口就在文件菜单里（它要拿"当前项目"去绑 ⇒ 导图页不在时点了没意义）
  'map-menu-bind-workspace',
  // 编辑：整族都是 menu:* ⇒ 发给导图页渲染层
  'map-menu-save', 'map-menu-undo', 'map-menu-redo',
  'map-menu-add-node', 'map-menu-edit-node', 'map-menu-delete-node',
  'map-menu-expand-all', 'map-menu-collapse-all',
  // 工具（在导图页里开面板）
  'map-menu-palette', 'map-menu-audit'
];
const MAP_PAGE_ITEM_IDS = { close: 'map-menu-close-page', open: 'map-menu-open-page' };

/** 导图页在/不在 ⇒ 菜单项启用/置灰（幂等；返回改动了几项，便于日志与断言） */
function setMapPageMenuEnabled(enabled) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return 0;
  let n = 0;
  for (const id of MAP_PAGE_MENU_IDS) {
    const it = menu.getMenuItemById(id);
    if (it && it.enabled !== enabled) { it.enabled = enabled; n++; }
  }
  const closeIt = menu.getMenuItemById(MAP_PAGE_ITEM_IDS.close);
  const openIt = menu.getMenuItemById(MAP_PAGE_ITEM_IDS.open);
  if (closeIt && closeIt.enabled !== enabled) { closeIt.enabled = enabled; n++; }
  if (openIt && openIt.enabled !== !enabled) { openIt.enabled = !enabled; n++; }
  if (n) console.log('[menu] 导图页菜单项已' + (enabled ? '恢复' : '置灰') + ' ' + n + ' 项'
    + (enabled ? '' : '（导图页已卸载：这些项发往的是渲染层，点下去不会有任何反应 ✗）'));
  return n;
}

function buildMenu(win) {
  const send = (channel, ...args) => { if (!win.isDestroyed()) win.webContents.send(channel, ...args); };
  const template = [
    { label: '文件', submenu: [
      { id: 'map-menu-import-md', label: '导入 Markdown…', accelerator: 'CmdOrCtrl+I',
        click: () => send('menu:import-md') },
      // 功能 5a：大文件（md/txt/docx）⇒ **新项目 + 新树**。与上面那条的区别：这个是"建新项目"，
      // 上面那条是"往当前项目里追加"。也可以直接把文件**拖进窗口**（两条入口同一个实现 ✓）。
      { id: 'map-menu-import-doc', label: '导入大文件生成新项目…', accelerator: 'CmdOrCtrl+Shift+I',
        click: () => importDocDialog(win) },
      { id: 'map-menu-export-md', label: '导出 Markdown…', accelerator: 'CmdOrCtrl+E',
        click: () => send('menu:export-md') },
      { type: 'separator' },
      { id: 'map-menu-import-json', label: '导入 JSON 打包…', click: () => importJsonDialog(win) },
      { id: 'map-menu-export-json', label: '导出 JSON 打包…', click: () => exportJsonDialog(win) },
      { id: 'map-menu-export-png', label: '导出当前导图为 PNG…', click: () => exportImageDialog(win) },
      { type: 'separator' },
      /* 【R4】绑定工作区文件夹的**入口**（设计 §五：设置/菜单一处；命令面板里也有一条同一个实现 ✓）。
       * ⚠️ 为什么**不**做成工具栏按钮（本批实机踩到并撤回）：这一段工具栏在"侧栏开着"时可用宽度只剩
       *   ~1000px，**再加一个按钮就会把整条工具栏挤成两行**（实测 +33px 高）⇒ 所有"跨状态比绝对坐标"的
       *   判据随之漂移 —— 域 37（圆钮/悬浮工具条的几何，用户原话逐字验收的那两条）当场变红 ✗✗。
       *   "未绑定时界面不多出任何噪声"这条纪律，在这里的最强形式就是**工具栏一个像素都不动** ✓。 */
      { id: 'map-menu-bind-workspace', label: '绑定工作区文件夹…',
        click: () => send('menu:bind-workspace') },
      { type: 'separator' },
      /* 【W13】界面侧导入入口：**两条菜单项 = 一个实现**（`MM.importIntoMap({kind})`，
       *  命令面板里有同样两条 ⇒ 四条入口都调那一个函数）。
       *   · 选文件…：一个或多个 md/txt/docx ⇒ 既有 `import-md`，导到**当前选中的节点**下（预览里说清落点）；
       *   · 选文件夹…：整库 ⇒ 既有 `import-dir`，**新建一个项目**（建完按既有路径打开它）。
       *  与上面「导入 Markdown…」的分工（那条是功能 5a 之前的老路：一个文件、没有预览）：
       *  这两条**都先预览再导**（预览跑在演练副本上 ⇒ 此刻你的项目零写入）；
       *  从前"想导整个文件夹"的人在界面里根本够不到 —— 那是 W13 要补的断点 ✓。
       *  ⚠️ 它们**不进工具栏**：那一段在侧栏开着时只剩 ~1000px，多一个按钮就挤成两行，
       *    所有"跨状态比绝对坐标"的判据随之漂移（域 37 实机踩到并撤回，见上面 bind-workspace 那条）。 */
      { id: 'map-menu-import-files', label: '导入 Markdown 文件…（可多选，导到当前节点下）',
        click: () => send('menu:import-files') },
      { id: 'map-menu-import-dir', label: '导入文件夹成新项目…（整库，先看预览）',
        click: () => send('menu:import-dir') }
    ]},
    { label: '编辑', submenu: [
      // 保存：此前**菜单里没有这一项**，界面也无按钮 —— 人的编辑无从落盘。
      { id: 'map-menu-save', label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
      { type: 'separator' },
      { id: 'map-menu-undo', label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
      { id: 'map-menu-redo', label: '重做', accelerator: 'CmdOrCtrl+Y', click: () => send('menu:redo') },
      { type: 'separator' },
      { id: 'map-menu-add-node', label: '新建节点', accelerator: 'CmdOrCtrl+N', click: () => send('menu:add-node') },
      { id: 'map-menu-edit-node', label: '编辑节点', accelerator: 'F2', click: () => send('menu:edit-node') },
      { id: 'map-menu-delete-node', label: '删除节点', accelerator: 'Delete', click: () => send('menu:delete-node') },
      { type: 'separator' },
      { id: 'map-menu-expand-all', label: '展开全部', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu:expand-all') },
      { id: 'map-menu-collapse-all', label: '收起全部', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:collapse-all') },
      { type: 'separator' },
      // 命令面板与关系审计放在菜单里：菜单快捷键比渲染层 keydown 更可靠
      // （不受输入框焦点影响），渲染层仍保留 keydown 兜底。
      { id: 'map-menu-palette', label: '命令面板…', accelerator: 'CmdOrCtrl+P', click: () => send('menu:palette') },
      { id: 'map-menu-audit', label: '关系审计…', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu:audit') }
    ]},
    { label: '视图', submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      // DSH 侧边栏：孵化独立实例（vendor 运行包 + 独立 DSH_HOME），与全局 3080 实例互不可见
      { label: '切换 DSH 侧边栏', accelerator: 'CmdOrCtrl+B', click: () => dshSidebar.toggle() },
      { label: '重启 DSH 服务', click: () => dshSidebar.restartService() },
      // 驻留语义的必要正门：正常退出**不**收割服务，用户需要能主动停掉它（否则只能靠任务管理器）
      { label: '停止 DSH 服务', click: () => {
          const st = dshSidebar.getStatus();
          dshSidebar.stopService();
          win.webContents.send('app:toast', st.servicePid
            ? ('已停止 DSH 服务（pid=' + st.servicePid + '），下次切换侧边栏会重新启动')
            : 'DSH 服务当前未在运行');
        } },
      { label: '打开 DSH 数据目录', click: () => {
          shell.openPath(require('path').join(app.getPath('userData'), 'dsh-home'));
      } },
      { type: 'separator' },
      // 导图页的**真关**（本版语义：把这一页从内存里卸掉，不是隐藏 —— 藏起来内存还在 ✗）。
      // 两个入口按状态互斥启用：关掉了就只剩「重新加载思维导图页」（回去的唯一正门之一，
      // 另外两个是占位页上的按钮与侧栏控制栏里的「⤢」）。
      // ⚠️ 关闭**必须**走渲染层：未保存编辑只在那儿知道（它会先弹「保存后关闭 / 取消」，
      //    复用既有保存路径与冲突保护）⇒ 这里只发一条事件，不自己动手卸载。
      { id: MAP_PAGE_ITEM_IDS.close, label: '关闭思维导图页（只留 DSH 侧栏）',
        click: () => send('menu:close-map-page') },
      { id: MAP_PAGE_ITEM_IDS.open, label: '重新加载思维导图页', enabled: false,
        click: () => dshSidebar.openMapPage().catch((e) => {
          console.log('[dsh-sidebar] openMapPage 失败: ' + ((e && e.message) || e));
        }) }
    ]},
    { label: '帮助', submenu: [
      { label: '关于 AI MindMap', click: () => {
          dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: 'AI MindMap',
            detail: '面向 AI 与人协作的智能笔记工具（思维导图式）\n人用界面 + AI 用 CLI/MCP，数据为 projects/ 下 JSON 节点树。'
          });
      }}
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // 导图页"真关"状态的**唯一订阅者**：卸载/重开时统一改菜单项（见 setMapPageMenuEnabled）。
  // 放在这里而不是各个入口：关闭入口有四个（工具栏 ✕ / 菜单 / 侧栏「⤢」/ CLI），分散去调必然漏一处。
  dshSidebar.setMapPageListener((closed) => setMapPageMenuEnabled(!closed));
  setMapPageMenuEnabled(!dshSidebar.getStatus().mapPageClosed);
}

/* ---------------- IPC ---------------- */
// ⑩「在侧边栏打开」：把对话预填进侧栏输入框（**不代替用户发送** ✗ —— 谁按发送谁负责 ✓；
//   发出去之后那段对话自然就成了侧栏那个会话的工作区历史 ✓）。失败也返回结构化的原因 ✓ 不静默 ✗
/* 真机反馈③：投喂前先把侧栏开起来 ✓ —— 以前这里直接转发给 prefillComposer，而它要求
 * 「视图已建 + 服务 running」，自己不会开侧栏 ✗；而侧栏 ✕ 关闭会 hide()+stopService() ⇒ status=idle
 * ⇒ 之后所有「送进侧栏」都被拒（用户看到顶部一句提示、输入框永远空 ✓）。show() 自己会 ensureView +
 * 接管/启动服务 ✓，所以「先 show、等到 running、再投喂」就够了。
 * ⚠️ 冒烟（isSmoke）不这么做：冒烟跑在 setNoSpawn 下，起真服务会把 G5 从 11s 拖回 170s ✗。
 * 也不静默：show 失败/超时都照样去 prefill，让 prefillComposer 给出它自己的原因 ✓。 */
async function prefillAfterEnsureOpen(text) {
  if (!isSmoke) {
    try {
      const st0 = dshSidebar.getStatus() || {};
      if (st0.status !== 'running') {
        console.log('[dsh-sidebar] 投喂前先把侧栏开起来（当前状态 ' + st0.status + '）…');
        try { dshSidebar.show(); } catch (e1) { console.log('[dsh-sidebar] show() 失败：' + ((e1 && e1.message) || e1)); }
        for (let i = 0; i < 60; i++) {          // ≤6s：服务冷启动实测几秒 ✓
          const st = dshSidebar.getStatus() || {};
          if (st.status === 'running') break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch (e2) { /* 起不来也照样试一次 ✓ 让 prefillComposer 报它自己的原因 */ }
  }
  // 2026-10-09 真机反馈：侧栏处于**窄模式（xs）**时页面里没有可见输入框 ⇒ 投喂必然失败 ✗
  //   实测：dsh-status 报 narrow.mode='xs' / viewWidth=0，而服务是 running ✓
  //   ⇒ 投递前先确认够宽：不够就加宽（用现成的 setWidth ✓ 与"内核右栏要空间"同一条路 ✓）
  if (!isSmoke) {
    try {
      const st1 = dshSidebar.getStatus() || {};
      const vw = (st1.narrow && typeof st1.narrow.viewWidth === 'number') ? st1.narrow.viewWidth : null;
      const w0 = typeof st1.width === 'number' ? st1.width : 0;
      if ((vw !== null && vw < 640) || (vw === null && w0 < 720)) {
        console.log('[dsh-sidebar] 侧栏太窄（view=' + vw + ' width=' + w0 + '）⇒ 加宽到 900 再投喂 ✓');
        dshSidebar.setWidth(900);
        await new Promise((r) => setTimeout(r, 400));   // 等布局重排（窄→宽实测要一点时间 ✓）
      }
    } catch (e3) { /* 加宽失败也照样试投喂 ✓ 让它给出自己的原因 ✗ */ }
  }

  return dshSidebar.prefillComposer(text);
}

function registerIpc() {
  ipcMain.handle('project:list', () => listProjects());

  /* 项目文件监听（v0.16.1「边聊边编辑」）：
   * 侧栏 AI 经 CLI 改盘上 JSON 后，界面要实时感知。渲染层订阅本通道，
   * 在自身无未保存改动时自动重读（有脏改动则只提示，绝不覆盖人的编辑）。
   * fs.watch 对一次原子写（tmp+rename）可能触发多次 → 300ms 防抖 + 消重。 */
  const projectWatchers = new Map(); // absDir → fs.FSWatcher
  /* 焦点探针（v0.20）：「窗口重新获得焦点时**只读**比一次盘上指纹，落后就复用既有通道通知」。
   *
   * 为什么需要它（用户原话："AI 编辑的我看不到"✗）：`fs.watch` 只在**写盘那一刻**触发，
   * 而那一刻界面可能正脏/正忙；等人**回到窗口**再比一次，才覆盖"人真的看没看到"这个时机。
   * 三条纪律（缺一条就会变成新机制而不是复用）：
   *   · **只读**：`versionOf` 只读文件 —— 不推进 `versionAtRead`/`baseAtRead`、不写盘、不碰渲染层内存；
   *   · **复用既有事件**（`project:disk-changed`）⇒ 渲染层侧仍然只有一套判定
   *     （无脏 ⇒ 静默重读；有脏 ⇒ 只提示并亮出「外部改动预览」）；
   *   · **只在盘上版本 ≠ 界面读到的那一版时才发**（相等还发 ⇒ 每次切回窗口都白重读一遍）。 */
  let watchedFile = null;
  let watchedWin = null;
  /* 【R4】绑定守护的接线：**同步真的写过盘**时才发既有的 `project:disk-changed`
   * —— 渲染层对这条事件已经有一整套判定（无脏 ⇒ 静默重读；有脏 ⇒ 只提示 + 外部改动预览），
   * 所以"自动同步进来的节点出现在界面上"这件事**不需要新事件、也不需要 preload 加通道** ✓
   * （第④步的界面只做"选目录/状态/暂停"这些**入口**，不该为了显示去复制一套同步逻辑）。
   * 判据"有没有写过盘"取自 CLI 的回显（`synced` 那一行）—— 不猜、不另算一份。 */
  const onBindingsSynced = (r) => {
    if (!r || !r.ok) return;
    /* "有没有写过盘"：优先看 CLI 报告里那一行的 `status`（同一个判定的机器可读形态），
     * 没有报告时回落到回显里的 `synced` 字样 —— 两条都是**CLI 自己说的**，主进程不猜、不另算一份。 */
    const rows = (r.report && Array.isArray(r.report.sync)) ? r.report.sync : [];
    const wrote = rows.length ? rows.some((x) => x && x.status === 'synced') : /\bsynced\b/.test(String(r.out || ''));
    /* 【R4 界面侧】**没写过盘也要发报告**的那一类：这一轮有"人必须看见"的读数 ——
     *   · `pending > 0`（盘上文件没了 ⇒ 引擎只记了"待确认删"，树**一个节点都没动**，
     *     而这条提议**不会写盘**：项目文件因此一个字节都不变 ⇒ 界面上那条"待确认 N"没有别的来源，
     *     只能靠这份报告（`bindings[].pending`）说出来。少了它，用户永远看不到"有文件被删了"✗）；
     *   · `unconverted > 0`（转不了的文件逐条点名，同上：不该只躺在 CLI 的 stdout 里）；
     *   · `blocked-dirty` / `dir-missing`（引擎停住了，必须说出来）。 */
    const hasNews = rows.some((x) => x && ((x.pending || 0) > 0 || (x.unconverted || 0) > 0
      || x.status === 'blocked-dirty' || x.status === 'dir-missing'));
    if (!wrote && !hasNews) return;                          // 没事可说 ⇒ 不发（避免无意义的重读/刷新）
    const target = (watchedWin && !watchedWin.isDestroyed())
      ? watchedWin
      : BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())[0];
    if (!target) return;
    // ① 既有的"盘上变了"通道：渲染层对它已有一整套判定（无脏 ⇒ 静默重读；有脏 ⇒ 只提示 + 外部改动预览）
    //    ⚠️ 只在**真的写过盘**时发：没写盘却让界面重读一遍是无意义的（还可能把一个正在编辑的人打扰一次）
    if (wrote) target.webContents.send('project:disk-changed', String(r.project || '') + '.json');
    /* ② 【R4 界面侧】把**这次同步的报告**一并交出去（同一个事件源，不新开一条判定）：
     *    第④步的"变更播报"要能点出"这次自动加进来的节点"，而 added/modified/pending/unconverted
     *    是 **CLI 算出来的**读数（界面只显示，不自己再数一遍 ✓）。
     *    ⚠️ 用**这次批次自己的项目名**（同 ① 的理由：期间用户可能已经切了项目）。 */
    target.webContents.send('app:bind-synced', {
      project: String(r.project || ''), why: String(r.why || ''), report: r.report || null,
      // "这次同步动了哪些对象"的键（主进程在起 CLI 前后各读一次算的，见 runBindSyncCli）——
      // 界面据此**点得出**这次自动加进来的节点；键→人话名也一并给（describeKeys）
      changedKeys: Array.isArray(r.changedKeys) ? r.changedKeys : [],
      addedKeys: Array.isArray(r.addedKeys) ? r.addedKeys : [],
      removedKeys: Array.isArray(r.removedKeys) ? r.removedKeys : [],
      modifiedKeys: Array.isArray(r.modifiedKeys) ? r.modifiedKeys : [],
      labels: Array.isArray(r.labels) ? r.labels : []
    });
  };
  const focusProbed = new WeakSet();
  function onWatcherFocus() {
    if (!watchedFile || !watchedWin || watchedWin.isDestroyed()) return;
    const projName = path.basename(path.dirname(watchedFile));
    const onDisk = versionOf(watchedFile);
    const known = versionAtRead.get(projName);
    if (onDisk === null || known === undefined || onDisk === known) return;
    watchedWin.webContents.send('project:disk-changed', path.basename(watchedFile));
  }
  function watchProjectDir(win, absDir) {
    const prev = projectWatchers.get('current');
    if (prev) { try { prev.close(); } catch (err) { /* ignore */ } projectWatchers.delete('current'); }
    if (!absDir || !fs.existsSync(absDir)) return;
    watchedFile = absDir;
    watchedWin = win;
    // 只听一次（同一个窗口会被反复 watch：切项目/重开导图页都会走到这里）
    if (win && !focusProbed.has(win)) { focusProbed.add(win); win.on('focus', onWatcherFocus); }
    let timer = null;
    try {
      const w = fs.watch(absDir, { persistent: false }, (_event, filename) => {
        if (!filename || !String(filename).endsWith('.json')) return;
        // 点文件（.ui-state.json 及其原子写临时文件）= 界面自己的状态信号，不是笔记变更：
        // 不排掉的话每次"脏标记变化"都会绕一圈回来触发一次无意义的重读判定。
        if (String(filename).charAt(0) === '.') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!win.isDestroyed()) win.webContents.send('project:disk-changed', String(filename));
        }, 300);
      });
      w.on('error', () => { try { w.close(); } catch (err) { /* ignore */ } });
      projectWatchers.set('current', w);
    } catch (err) { /* 监听失败不致命：手动刷新仍可用 */ }
  }
  ipcMain.handle('project:watch', (e, absDir) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    watchProjectDir(win, absDir);
    return { ok: true };
  });

  ipcMain.handle('project:read', (e, name) => {
    // 走 store.read()：BOM 容错 + 路径校验 + 项目不存在时给出明确错误
    const r = store.read(name);
    // 记下渲染层这一份是从哪个版本读来的 —— project:save 的并发闸门要用它
    // ⚠️ 因此这条通道**有副作用**：用它的前提是"渲染层读完就采纳这一版"。渲染层里那条
    // **可能读了却不采纳**的路（自动重读：读盘期间切了项目 / 期间又变脏 ⇒ 拒绝采纳，见
    // renderer/app-actions.js 的 onProjectDiskChange）**必须**走没有副作用的 `project:peek` ——
    // 拿 read 去走那条路，基线就被记成"界面见过盘上这一版"，而 project:save 的闸门正是拿它比
    // 版本号的 ⇒ 下一次保存按"没有外部改动"把内存里那份旧树直接写下去，把盘上（AI/CLI 刚写的）
    // 那份**静默抹掉**（本工程最重的损害类别 ✗）。
    versionAtRead.set(name, r.version);
    // 同时记下**内容基线**：并发时要做三方合并（阶段 2），只有指纹是不够的
    baseAtRead.set(name, r.data);
    /* 【R4】顺手重挂这个项目的**绑定守护**：打开/切换项目走的就是这条通道（渲染层所有读路径都经它）
     * ⇒ "守护跟着项目走"不需要新通道、也不需要渲染层配合（第④步的界面只补入口与状态显示）。
     * 判定与写盘全在 CLI 那一侧（`bind-sync`），这里只挂/收 `fs.watch` + 一个低频兜底巡检。 */
    try {
      bindWatchersFor(name, onBindingsSynced);
      startBindingSweep(onBindingsSynced);
    } catch (err) { /* 守护起不来不影响项目打开：如实打一条，别静默（F1） */ console.error('[bind-sync] 重挂失败：' + ((err && err.message) || err)); }
    // 导图页的"上次项目"由**主进程**存住：导图页被卸载后重开时，页面自己不知道原来开的是哪个
    // （页面 boot 时只会默认开 projects[0] ⇒ 重开后项目会跑掉）⇒ 在这里记，重开时还回去 ✓
    try { dshSidebar.setCurrentProject(name); } catch (err) { /* 记不住不阻断读项目 */ }
    return r;
  });

  /* 只读探视（v0.20「让 AI 的编辑看得见」）——
   * 渲染层在**有未保存编辑**时也要能"看看盘上现在是什么样"，好在界面上亮出差异；
   * 而这件事**不能**用 `project:read` 去做：它有副作用 —— 会把 `versionAtRead` / `baseAtRead`
   * 推进到盘上这一版（那正是保存闸门"我读到哪一版"的依据）。若拿它探视，界面随后保存会被
   * 判成"没有外部改动" ⇒ **静默覆盖 AI 刚写的内容**（本工程最重的损害类别 ✗）。
   * ⇒ 这条通道**只读**：不推进任何记录、不写盘、不碰渲染层内存。
   * 返回里那两份版本也**取自主进程自己那份记录**（`baseAtRead` 与闸门用的 `versionAtRead`），
   * 于是"差异预览"与"保存闸门/三方合并"**用同一份基线** —— 不会出现"预览说没事、保存却冲突"。 */
  ipcMain.handle('project:peek', (e, name) => {
    let r;
    try { r = store.read(name); } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    const projName = path.basename(path.dirname(r.file));
    return {
      ok: true, file: r.file, data: r.data, version: r.version,
      base: baseAtRead.get(projName) || null,          // 界面读到的那一份（合并基线的唯一来源）
      baseVersion: versionAtRead.get(projName) || null // **闸门下次要比的那一版**（= .ui-state 的 baseVersion）
    };
  });

  ipcMain.handle('project:save', (e, file, data, opts) => {
    // 数据安全闸门：写盘前必须通过 CLI validate（防坏数据写坏笔记）。
    // 校验只能针对文件路径，故先落一个校验用临时文件；校验通过后再走
    // writeFileAtomic 原子覆盖（临时文件 + fsync + rename），保证中断不会产生半截文件。
    // 历史问题：原实现直接 rename 校验临时文件，未 fsync，且临时文件以固定 ".tmp" 结尾，
    // 并发保存会互相覆盖。
    // —— 关联笔记（assoc）的归属说明 ——
    // 节点树由渲染层拥有，但 assoc **只由 AI/CLI 写**：界面的标题/正文编辑走 `assoc-edit`、
    // 删节点时的清剪走 `assoc-prune`/`links-prune`，**渲染层从不在本地改 assoc**。
    // 因此渲染层内存里那份只是「上次读到的一份拷贝」，磁盘永远不比它旧；
    // 反过来（内存比磁盘旧）会**静默丢数据**，两条实测路径：
    //   ① 内存里存的是**某节点的子集**时写回 → 删掉其他所有笔记（曾实测 7 篇 → 5 篇）；
    //   ② AI/CLI 在界面打开期间新写的笔记，渲染层根本没见过 → 写回时被抹掉。
    // 故规则是：**磁盘有 assoc 就一律以磁盘为准**（不是"只有载荷没带时才取回"）；
    // 仅当磁盘没有 assoc 时才用载荷那份作兜底（例如磁盘尚未有过笔记）。
    let payload = data;
    if (data && file && fs.existsSync(file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (Array.isArray(cur.assoc) && cur.assoc.length) {
          payload = Object.assign({}, data, { assoc: cur.assoc });
        }
      } catch (err) { /* 读不回来就按原样保存（不要因为这点失败挡住保存） */ }
    }

    // ---- 并发处理（阶段 2）：能合就合，合不了才拦 ----
    // 渲染层手里是**整棵树的一份内存拷贝**，保存时整份写回。若它读盘之后别处（AI/CLI）
    // 写过，这次写回会把那次改动**静默抹掉** —— 本 handler 上方注释记的两条实测路径正是这一类。
    //
    // 旧行为：盘上版本 ≠ 渲染层读到的那一版 ⇒ **一律拒绝**，用户只能"重开（丢改动）或 Ctrl+Z"。
    // 新行为：拿三方做**逐节点合并**，判据与 CLI 侧的重放同源（都在 `src/concurrency.js`）：
    //   · base   = 渲染层读到的那一版（`baseAtRead` 记的就是它）
    //   · mine   = 界面内存这份载荷
    //   · theirs = 盘上最新
    //   两边改的对象**不相交** ⇒ **自动合并**（双方改动都保留），保存成功；
    //   相交 ⇒ **拒绝**并把冲突对象回报给渲染层，由它给用户两个选择
    //   （用磁盘上的版本 —— **只用在这些对象上**；或保留自己的改动、本次不保存）。
    // assoc：`serializeTree()` 不产这个键（界面从不改它，上面已按"磁盘优先"取回）⇒
    //   把 base 的 assoc 也钉到盘上那份，免得"别人改了 assoc"被算成与界面冲突。
    const projName = path.basename(path.dirname(file));
    let expectVersion = versionAtRead.get(projName);
    let merged = false;
    // 最多两轮：合并结果是在"盘上那一版"之上做的，若随后（校验期间）又被插队，再合一次
    for (let attempt = 0; attempt < 2 && expectVersion !== undefined; attempt++) {
      const actualVersion = versionOf(file);
      if (actualVersion === expectVersion) break;
      const base = baseAtRead.get(projName);
      if (!base || actualVersion === null) {
        // 没有基线（记录被清 / 刚起进程）或盘上文件没了 ⇒ 退回旧的拒绝行为（安全，但要求用户重开）
        throw new Error('并发写入冲突：项目「' + projName + '」在你打开或上次保存之后，已被其他写入者'
          + '（很可能是 AI/CLI）修改（界面读到 ' + String(expectVersion).slice(0, 8)
          + '，盘上 ' + (actualVersion === null ? '已不存在' : String(actualVersion).slice(0, 8)) + '）。'
          + '保存已中止，以免静默覆盖对方刚写的内容。'
          + '处理办法：重新打开该项目（会丢弃界面里未保存的改动），或按 Ctrl+Z 撤销本次改动后再保存。');
      }
      const cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const baseForMerge = Object.assign({}, base, { assoc: cur.assoc });
      const mr = concurrency.mergeTrees(baseForMerge, payload, cur,
        { onConflict: (opts && opts.onConflict) || 'refuse' });
      if (!mr.ok) {
        // **拒绝，但给结构化信息**：渲染层据此报出对象名并让用户二选一 —— 不再"一律丢整个界面的改动"
        // v0.20：除对象名外还给**三份只读快照**（base / mine / theirs），渲染层据此在冲突面板里
        //   显示"两边内容差异"（用户原话："就算打架也要可以预览冲突内容"）。
        //   ⚠️ `conflictSnapshots` 只取 `mr.conflicts` 点名的那些对象 —— **不塞整棵树**。
        return {
          ok: false, code: 'MERGE_CONFLICT', conflicts: mr.conflicts, detail: mr.detail,
          snapshots: concurrency.conflictSnapshots(baseForMerge, payload, cur, mr.conflicts),
          // headless（冒烟/自动化）下渲染层**不能弹模态确认框**：没人回答会把整轮卡死（实测踩过）
          headless: isSmoke,
          message: '这些对象在磁盘上已被其他写入者改过：' + mr.detail.join('、')
        };
      }
      payload = mr.data;
      merged = true;
      expectVersion = actualVersion;       // 合并结果建立在"盘上这一版"之上
    }
    if (expectVersion !== undefined && versionOf(file) !== expectVersion) {
      // 合并完又被人插队（罕见）⇒ **不盲写**，让用户再点一次保存（盘上内容一点没动）
      return { ok: false, code: 'RACE_RETRY', headless: isSmoke,
        message: '保存期间又有别的写入者改动了这个项目，本次未写入（盘上内容未变）。请再点一次保存。' };
    }

    const probe = file + '.' + process.pid + '.' + Date.now() + '.validate';
    fs.writeFileSync(probe, JSON.stringify(payload, null, 2), 'utf8');
    try {
      const res = spawnSync(process.execPath, [CLI, 'validate', probe], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
      });
      const ok = res.status === 0 && !/^error:/.test((res.stdout || ''));
      if (!ok) {
        // 剥掉 mm-cli 的 "error: " 前缀，避免错误信息出现 "failed: error: 校验失败" 这样的双前缀
        const detail = ((res.stdout || '') + (res.stderr || '')).replace(/^error:\s*/, '').trim();
        throw new Error('validation failed: ' + detail.slice(0, 300));
      }
      const json = JSON.stringify(payload, null, 2);
      // 变更日志要"改了什么"，得先拿到**写入之前**盘上的内容（读失败按"盘上没有"处理）
      let oldText = null;
      try { oldText = fs.readFileSync(file, 'utf8'); } catch (e) { oldText = null; }
      writeFileAtomic(file, json);
      const writtenVersion = versionOfText(json);
      // 自己写下的这一份就是最新版：**版本与基线都要推进**，免得下一次保存误报冲突
      versionAtRead.set(projName, writtenVersion);
      baseAtRead.set(projName, JSON.parse(json));
      // 变更日志（阶段 3）：GUI 保存**不走 `store.write`**，所以这里显式记一条 ——
      // 实现只有 `store.recordChange` 一份（别在本地再写一套"改了什么"的定义，会漂移）。
      // 它是辅助产物：失败**不能让保存失败**，但**绝不静默**（打 stderr）。
      try {
        store.recordChange(projName, { oldText: oldText, data: payload, version: writtenVersion, writer: 'gui' });
      } catch (err) {
        console.error('warning: 变更日志写入失败（本次数据已写入，日志缺一条）：'
          + ((err && err.message) || err));
      }
      return { ok: true, merged: merged, version: writtenVersion, file: file };
    } finally {
      try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch (err) { /* ignore */ }
    }
  });

  ipcMain.handle('asset:import', (e, projectName, nodeId, srcPath, caption, source, tags) => {
    const out = runCli(['add-image', projectName, nodeId, '--file', srcPath, '--caption', caption]
      .concat(source ? ['--source', source] : [])
      .concat(Array.isArray(tags) && tags.length ? ['--tags', tags.join(',')] : []));
    return { ok: true, out };
  });

  ipcMain.handle('asset:import-file', (e, projectName, nodeId, srcPath, caption, source) => {
    const out = runCli(['add-file', projectName, nodeId, '--file', srcPath, '--caption', caption]
      .concat(source ? ['--source', source] : []));
    return { ok: true, out };
  });

  // 读附件文本（md 预览用；fetch(file://) 被 Chromium 禁止，必须走主进程）
  ipcMain.handle('app:read-file', async (e, absPath) => {
    try {
      const text = fs.readFileSync(absPath, 'utf8');
      return { ok: true, text };
    } catch (err) { return { ok: false, err: err.message }; }
  });

  // 系统默认应用打开附件（非 md/pdf 类型，XMind 附件交互模式）；
  // 也用于打开节点对应的**本机文件夹**（节点字段 localPath —— 对目录 shell.openPath 会开文件管理器）。
  ipcMain.handle('app:open-file', async (e, absPath) => {
    // ⚠️ headless（--smoke / 导出图）下**绝不真的打开**：那会在跑验证的机器上弹出文件管理器/默认应用，
    // 每跑一次 verify 弹一次窗。但**判据照走**（路径可访问性），并把 headless 明确回报 ——
    // 这不是"静默降级"：调用方拿到 headless:true 就知道"校验过了、只是没开"。
    if (isSmoke) {
      try {
        const st = fs.statSync(absPath);
        return { ok: true, headless: true, kind: st.isDirectory() ? 'dir' : 'file' };
      } catch (err) {
        return { ok: false, headless: true, err: '路径不可访问：' + err.message };
      }
    }
    try {
      const r = await shell.openPath(absPath);
      return { ok: !r, err: r || null };
    } catch (err) { return { ok: false, err: err.message }; }
  });

  ipcMain.handle('app:export-md', (e, projectName, outFile) => {
    return { ok: true, out: runCli(['export-md', projectName, outFile]) };
  });

  // UI 导出 Markdown：主进程弹目录选择（v0.16 起导出为文件夹：md + assets/ + attachments/）
  ipcMain.handle('app:export-md-dialog', async (e, projectName) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: '导出 Markdown 到文件夹（含图片与附件）',
      buttonLabel: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
    const dir = path.join(res.filePaths[0], projectName + '-export');
    try { return { ok: true, file: dir, out: runCli(['export-md', projectName, dir]) }; }
    catch (err) { return { ok: false, err: err.message }; }
  });

  ipcMain.handle('app:import-md', (e, projectName, srcFile, parent) => {
    const args = ['import-md', projectName, srcFile];
    if (parent && parent !== 'root') args.push('--parent', parent);
    return { ok: true, out: runCli(args) };
  });

  // Obsidian 融合：全文搜索 / 反向链接 / 相关知识点（渲染层只读调用，逻辑全在 CLI）
  ipcMain.handle('app:search', (e, projectName, keyword) => {
    const text = runCli(['search', projectName, keyword, '--full', '--json']);
    try { return JSON.parse(text); }
    catch (err) { return { keyword, hits: [], error: text }; }
  });

  ipcMain.handle('app:backlinks', (e, projectName, nodeId) => {
    const text = runCli(['backlinks', projectName, nodeId, '--json']);
    try { return JSON.parse(text); }
    catch (err) { return { error: text }; }
  });

  ipcMain.handle('app:related', (e, projectName, nodeId) => {
    const text = runCli(['related', projectName, nodeId, '--json']);
    try { return JSON.parse(text); }
    catch (err) { return { error: text }; }
  });

  /* ---- 热度条（第三件 · A）：界面的两条热度条 + 那次人类访问的采样 ----
   * 两条通道都**只做展示/记录**，与"正文只有一份"（`dc.innerHTML = detail`）那条铁律**无关**：
   *   · 读：结果来自 `heat --json`（**同一处口径**，界面绝不自己算分位/名次 ✗）；
   *   · 写：只是往**访问日志**追加一行（旁路产物，不是项目数据）——
   *     所以它**不触发** `project:save`、不产生脏标记、用户看不到"有未保存改动"。
   * ⚠️ 两者都用 `runCliAsync`（不在主进程里同步跑）：打开详情框绝不能被一次 CLI 调用拖住。
   */
  ipcMain.handle('app:heat', (e, projectName, nodeId) => {
    if (!projectName) return { ok: false, error: '缺少项目名' };
    // 一次 CLI 拿"整份热度"（窗口 + 样本量 + 两条榜），**并把当前节点那一行一起端出来**
    // （`--node <id>`：档位映射只有一处 —— `src/heat.js` 的 `heatProfile()`；界面不折算任何数）。
    // 为什么不让界面在 `human`/`ai` 数组里自己找：那两个数组是**被 --limit 截断过的显示**，
    // 被访问过的节点可能恰好不在里面 —— 那样界面就得自己算分位，等于第二份会漂移的口径 ✗。
    const args = ['heat', projectName, '--json'];
    if (nodeId) args.push('--node', String(nodeId));
    return runCliAsync(args).then((r) => {
      let j = null;
      try { j = JSON.parse(r.out); } catch (err) { j = null; }
      if (r.code !== 0 || !j) {
        return { ok: false, error: ((r.err || r.out || '').trim() || ('CLI 退出码 ' + r.code)).slice(0, 400) };
      }
      return { ok: true, payload: j, nodeId: nodeId || null };
    });
  });

  /* 记一次**人类访问**（裁决一：人只算"打开详情框"）。
   * · 落点是 `store.visitLogFile()`（`<项目根>/.visits/<项目名>.jsonl`）——**项目目录之外**，
   *   所以它不会在项目目录里留下任何字节（那是"只读路径零副作用"这条不变量的要求）；
   * · 走 `src/heat-sensor.js` 的**同一个** `recordVisit`（上限/去重/失败口径只有那一处），
   *   不另起一套写盘逻辑；通道固定 `human-detail`（唯一的人类通道）；
   * · 返回 `{ ok, recorded, errors }`：失败**如实回报**（渲染层据此显示可见提示，见 app-heat-bars.js），
   *   绝不静默吞掉 —— "没记上"与"记上了"必须可分辨。 */
  ipcMain.handle('app:visit', (e, projectName, nodeId, channel) => {
    const ch = channel || 'human-detail';
    if (!projectName || !nodeId) return { ok: false, error: '缺少项目名或节点 id' };
    try {
      const r = heatSensor.recordVisit(store.visitLogFile(projectName), ch, [nodeId],
        { by: 'gui-cli:' + ch });
      return { ok: r.ok, recorded: r.recorded, reason: r.reason, errors: r.errors, channel: r.channel };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* 功能 1：向内嵌 AI 问一个**节点**（界面「解释」/「问问AI」两个按钮的后端）。
   * · 为什么**异步**：一次解释实测 ~24s（`src/dsh-ask.js` 文件头有实测数据），而 runCli 是 spawnSync
   *   ⇒ 会把主进程整段卡住（界面假死 + 别的 IPC 排队）✗。这里自己 spawn 并把结果包成 Promise。
   * · 为什么复用 `cli ask`（而不是在主进程里再拼一次提示词）：**"AI 收到什么"只能有一处定义** ✓
   *   （提示词/情境补齐/失败口径都在 CLI 与 src/dsh-ask.js，且已有单测与集成断言）。
   * · 冒烟/离线（`--smoke` 或 `MM_ASK_STUB=1`）返回**桩**：真调用要烧额度 + 依赖网络 + 24s
   *   —— 门禁里不做重活（分层纪律）。要验的是"点按钮 ⇒ 出框 ⇒ 显示答案 ⇒ 能发问题"这条链路。
   *   桩**必须**带 `stub:true`，断言与人都能一眼分辨"这不是真答案" ✗ 不许冒充。 */
  ipcMain.handle('app:ask', (e, projectName, nodeId, opts) => {
    const o = opts || {};
    const kind = o.kind === 'explain' ? 'explain' : 'ask';
    if (isSmoke || process.env.MM_ASK_STUB === '1') {
      const echo = o.question ? ('｜你问：' + String(o.question).slice(0, 80)) : '';
      const many = Array.isArray(o.nodes) ? o.nodes.length : 0;
      return Promise.resolve({
        ok: true, stub: true, kind, ms: 0, effort: o.effort || null, nodes: many || null,
        // 桩答案**故意带 Markdown**（加粗/列表）：这样冒烟能顺带验"答案里的粗体真的渲染出来了" ✓
        text: '（冒烟桩：未调用模型）**' + (kind === 'explain' ? '这是对该节点的解释占位' : '这是回答占位') + '。**'
          + '\n\n- 第一点\n- 第二点' + echo + (o.effort ? ('｜思考强度：' + o.effort) : '')
          + (many ? ('｜收到节点数：' + many) : '')
      });
    }
    const args = ['ask', projectName];
    if (nodeId) args.push(String(nodeId));      // 节点可选：消息栏那条入口是**项目级**提问 ✓
    args.push('--json', '--kind', kind);
    if (o.effort) args.push('--effort', String(o.effort));   // 界面上的"思考强度"下拉 ✓（用户反馈③）
    // ④ 多节点：整批交给 AI（`--nodes a,b,c` ⇒ 情境里逐个列出 ✓）
    if (Array.isArray(o.nodes) && o.nodes.length) args.push('--nodes', o.nodes.map(String).join(','));
    if (o.question) args.push('--question', String(o.question));
    if (o.timeoutSec) args.push('--timeout', String(o.timeoutSec));
    // 复用 runCliAsync（唯一的异步 CLI 出口）：一次解释 20+ 秒，spawnSync 会把界面卡住 ✗
    return runCliAsync(args).then((r) => {
      try { return JSON.parse(r.out); }
      catch (parseErr) {
        // 解析不了就把**原文**带回去（红色要能自己解释自己 ✓，不要只丢一个 "failed"）
        return { ok: false, kind, code: r.code,
          error: ((r.err || r.out || '').trim() || ('CLI 退出码 ' + r.code)).slice(0, 400) };
      }
    });
  });

  /* 功能 1 的**下半截**（A）：把一次 AI 问答**落到节点上** —— 界面「写入本节点详情 / 新建子节点」
   * 两个按钮的唯一出口。写操作只经 CLI（`ask-apply`）：闸门校验 + 原子写 + 并发版本闸门都在那里，
   * 渲染层不直接改盘（本工程硬约束）✓。
   *
   * 为什么这一条**同步**（runCli 而非 runCliAsync）：它不调模型（模型那一步已经在上面的 app:ask 里
   * 完成了，这里只是把结果落盘），实测毫秒级 ⇒ 用异步反而让"写完了没有"变难判定。
   * 与 ask 的 20+ 秒完全不是一类活。
   *
   * **写后回读**（本工程规约：采不到真值就不许声称成功）：回读该节点的 qa 与 detail 长度，
   * 交给渲染层同步内存 —— 少了这一步，下一次界面保存会拿旧内存把刚写的问答抹掉
   * （与 app:assoc-edit / app:unlink-nodes 同一条纪律：**不是**可选装饰）。
   * 回读失败 ⇒ `qa:null` + `ok:false`：调用方不许假装同步成功（"采不到真值"与"采到了"必须可区分）。
   *
   * `--at` 由**渲染层**给：界面上显示的那个时间就是落盘时间（同一件事一个时间 ✗ 不要两个）。 */
  ipcMain.handle('app:ask-apply', (e, projectName, nodeId, payload) => {
    const p = payload || {};
    const project = String(projectName || '');
    const node = String(nodeId || '');
    if (!project || !node) return { ok: false, error: '缺少项目名或节点 id' };
    const answer = String(p.answer == null ? '' : p.answer);
    if (!answer.trim()) {
      // 与本命令的 CLI 口径一致：空回答响亮拒绝（界面侧先拦一道，省一次子进程；判定仍以 CLI 为准）
      return { ok: false, error: '回答为空，没有可落盘的内容' };
    }
    // 子节点 id 由**主进程**生成（与 `add`/`clone` 同一套 idGen ⇒ 同一 id 规范、同一防撞号逻辑）。
    // 渲染层不许自己造 id：那是"两处实现"的开端。
    let childId = null;
    if (p.asChild) {
      try { childId = require('./src/markdown.js').idGen(String(p.topicSeed || answer.slice(0, 40))); }
      catch (err) { childId = null; }   // 生成不了就交给 CLI 自己生成（不静默改语义 ✓）
    }
    const args = ['ask-apply', project, node, '--answer', answer, '--at', String(p.at || new Date().toISOString())];
    if (p.question) args.push('--question', String(p.question));
    if (p.model) args.push('--model', String(p.model));
    if (p.asChild) {
      args.push('--as-child');
      if (childId) args.push('--child-id', childId);
    }
    let text;
    try { text = runCli(args); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    // 写后回读：节点实况（qa + detail）交给渲染层同步内存
    let back = null;
    try { back = JSON.parse(runCli(['get', project, node, '--json', '--detail'])); }
    catch (err) { /* 回读失败：back=null ⇒ 渲染层如实报告"已写入，但没能同步内存" */ }
    if (!back) {
      return { ok: false, error: '已写入，但写后回读失败（拿不到真值就不许声称已同步）',
        text: String(text).trim(), qa: null, detail: null, child: null };
    }
    // 通知渲染层**立刻**按磁盘重读一次（复用既有的 onProjectDiskChange：脏则拒绝覆盖、世代校验都在那儿）。
    // 为什么不由 fs.watch 兜底就够：那条路有 300ms 防抖，界面上要"晚一拍"才看见新子节点 ——
    // 而这一步的验收判据恰恰是"界面侧也变了"。
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) w.webContents.send('app:project-reread');
    } catch (err) { /* 通知失败只影响"立刻"，不影响"已落盘"这个事实（fs.watch 还会兜一次） */ }
    return {
      ok: true, text: String(text).trim(),
      child: childId ? { id: childId } : null,
      qa: Array.isArray(back.qa) ? back.qa : [],
      detail: typeof back.detail === 'string' ? back.detail : '',
      node: node, project: project
    };
  });

  /* 功能 5a：拖拽进来的文件（渲染层拿到路径后走这里）—— 与菜单**同一个实现** ✓ */
  ipcMain.handle('app:import-doc', async (e, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: '没有拿到文件路径' };
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
    const res = await importDocToNewProject(filePath);
    if (res.ok) afterDocImported(res, e.sender);
    return res;
  });

  /* 关系审计面板：orphans（无引用但有内容）+ mentions（正文提到却没建链接）。
   * 两个命令都走 CLI —— 渲染层不复制任何判定逻辑（分层铁律）。
   * 任一命令失败只让对应字段为 null，另一部分仍可用（面板不至于整体打不开）。 */
  ipcMain.handle('app:audit', (e, projectName) => {
    const parse = (args) => {
      const text = runCli(args);
      try { return JSON.parse(text); } catch (err) { return null; }
    };
    return {
      project: projectName,
      orphans: parse(['orphans', projectName, '--json', '--content-only', '--limit', '200']),
      mentions: parse(['mentions', projectName, '--json', '--limit', '200'])
    };
  });

  /* 从审计面板「补链接」：写操作一律走 CLI（校验闸门 + 原子写都在 CLI 侧）。 */
  ipcMain.handle('app:link-nodes', (e, projectName, fromId, toProject, toId, caption) => {
    const args = ['link', projectName, fromId, '--to', toProject, '--id', toId];
    if (caption) args.push('--caption', caption);
    const text = runCli(args);
    const ok = !/^error:/.test(String(text).trim());
    return { ok, text: String(text).trim() };
  });

  /* 关联视图里**摘掉一条链接**（用户需求「进入关联视图后能人工编辑关联信息」里"删链接"那一半）：
   * 与 `app:link-nodes` 成对 —— 那条加边、这条摘边，两条都**只经 CLI**（校验闸门 + 原子写 + 并发重放）。
   *
   * 参数就是 CLI 的签名本身（`unlink <项目> <id> --to <项目> --id <id>`），**不做任何翻译**：
   *   出边（我引用谁）   ⇒ projectName = 当前项目，   fromId = 中心节点，toProject/toId = 目标
   *   入边（谁引用了我） ⇒ projectName = **来源节点所在的项目**（那条边写在它的文件里），
   *                       fromId = 来源节点，toProject/toId = 当前项目/中心节点
   * 入边之所以要支持跨项目：反查天然会跨（`backlinks` 的 cross），而"看到一条边却删不掉"正是本次要修的缺口。
   *
   * **写完回读**：把该节点在**它自己项目里**剩下的出边取回来，裁成**契约形状**（只留 project/id/caption）。
   * 为什么要裁：渲染层会拿这份回读去**同步内存树**，而内存树在下一次保存时会整树写回磁盘 ——
   * 若把 CLI 视图里的派生字段（node/topic）一起存回去，契约就被污染（`app:assoc-edit` 用 `--raw` 是同一回事）。
   * 回读失败 ⇒ links 为 null，调用方**不许假装同步成功**（"采不到真值"与"采到了"必须可区分）。 */
  ipcMain.handle('app:unlink-nodes', (e, projectName, fromId, toProject, toId) => {
    const args = ['unlink', projectName, fromId, '--to', toProject, '--id', toId];
    let text;
    try { text = runCli(args); }
    catch (err) { return { ok: false, text: (err && err.message) || String(err) }; }
    let links = null;
    try {
      const back = JSON.parse(runCli(['links', projectName, '--json']));
      links = (back.links || [])
        .filter((l) => l && l.node === fromId)
        .map((l) => (l.caption ? { project: l.project, id: l.id, caption: l.caption } : { project: l.project, id: l.id }));
    } catch (err) { /* 回读失败不影响"已移除"这个事实；links=null 会让渲染层如实报告 */ }
    return { ok: true, text: String(text).trim(), project: projectName, node: fromId, links: links };
  });

  /* 关联视图里**新建**一篇关联笔记（此前界面**没有创建入口**，只能改 AI 已写好的那篇）。
   * 写操作只经 CLI `assoc-add`：成员数（≥2）、成员存在性、id 规范全在 CLI 侧判定 —— 渲染层不复制规则。
   *
   * 写完回读两件事：① 该项目全部关联的**原始实体**（`--raw`）⇒ 渲染层据此把 `state.assoc`
   * 整份对齐磁盘（少了这一步，下一次界面保存会拿旧内存把刚写的笔记抹掉 —— 与 assoc-edit 同一条纪律）；
   * ② **认出新增的那一篇**：写前先回读一次 id 集合，写后取差集。
   * 为什么不解析 stdout：`assoc-add` 的输出是给人读的中文句子，改一个字就坏 —— 本工程不用"猜输出"当契约。
   * 写前回读失败 ⇒ **直接判失败**（拿不到真值就不猜、不写），与本工程"采不到真值就等于红"同规约。 */
  ipcMain.handle('app:assoc-add', (e, projectName, members, title, noteMd) => {
    const list = (Array.isArray(members) ? members : []).map((s) => String(s === undefined || s === null ? '' : s).trim()).filter(Boolean);
    const readRaw = () => {
      const back = JSON.parse(runCli(['assoc-list', projectName, '--json', '--raw']));
      return Array.isArray(back.raw) ? back.raw : [];
    };
    let before;
    try { before = readRaw(); }
    catch (err) {
      return { ok: false, text: '写前回读关联清单失败，未写入（拿不到真值就不猜）：' + ((err && err.message) || String(err)) };
    }
    const args = ['assoc-add', projectName, '--members', list.join(',')];
    if (title !== undefined && title !== null && String(title).trim() !== '') args.push('--title', String(title));
    if (noteMd !== undefined && noteMd !== null && String(noteMd).trim() !== '') args.push('--note-md', String(noteMd));
    let text;
    try { text = runCli(args); }
    catch (err) { return { ok: false, text: (err && err.message) || String(err) }; }
    const known = new Set(before.map((a) => a && a.id));
    let raw = null;
    let created = null;
    try {
      raw = readRaw();
      created = raw.find((a) => a && !known.has(a.id)) || null;
    } catch (err) { /* 回读失败：raw=null ⇒ 渲染层只报"已写入"，不假装界面已同步 */ }
    return { ok: true, text: String(text).trim(), raw: raw, created: created };
  });

  /* 命令面板用的节点清单（扁平淡信息，供模糊搜索）。走 CLI list --json。 */
  ipcMain.handle('app:nodes', (e, projectName) => {
    const text = runCli(['list', projectName, '--json']);
    try { return JSON.parse(text); }
    catch (err) { return { error: text }; }
  });

  /* 「关联笔记」（N 元关联实体）：节点详情里的入口 + 二级页面读取。
   * nodeId 给定时只回该节点所属的关联（CLI 侧过滤，渲染层不做判定）。 */
  ipcMain.handle('app:assoc', (e, projectName, nodeId) => {
    // --raw：一并返回原始实体，供渲染层把内存与磁盘对齐（见 cli/commands/assoc.js 注释）
    const args = ['assoc-list', projectName, '--json', '--raw'];
    if (nodeId) args.push('--node', nodeId);
    const text = runCli(args);
    try { return JSON.parse(text); }
    catch (err) { return { error: text }; }
  });

  /* 保存关联笔记（写操作）：只经 CLI → 校验闸门 + 原子写。
   * 写完回读一次，把**落盘后的真实数据**返回给渲染层 —— 渲染层据此同步内存，
   * 避免"内存与磁盘不一致，下一次界面保存又把笔记覆盖回去"。 */
  ipcMain.handle('app:assoc-edit', (e, projectName, assocId, title, noteMd) => {
    const args = ['assoc-edit', projectName, assocId];
    if (title !== undefined && title !== null) args.push('--title', String(title));
    // 空字符串表示"清空笔记"（用户把内容删光了）；非空才走 Markdown 转换
    if (noteMd !== undefined && noteMd !== null) {
      if (String(noteMd).trim() === '') args.push('--clear-note');
      else args.push('--note-md', String(noteMd));
    }
    let text;
    try { text = runCli(args); }
    catch (err) { return { ok: false, text: (err && err.message) || String(err) }; }
    // 回读该关联的最新形态。**必须用 --raw 取原始实体**：
    // 渲染层会把它存回内存，而界面保存时内存里的 assoc 会被写回磁盘 ——
    // 若回读的是"视图"（含 effectiveTitle/hasNote、成员带 topic/label 等派生字段），
    // 这些字段就会被写进数据文件，污染契约。
    let assoc = null;
    try {
      const back = JSON.parse(runCli(['assoc-list', projectName, '--json', '--raw']));
      assoc = ((back.raw || [])).find((a) => a && a.id === assocId) || null;
    } catch (err) { /* 回读失败不影响"已写入成功"这个事实 */ }
    return { ok: true, text: String(text).trim(), assoc: assoc };
  });

  /* 删节点前的"关系清理"：**写操作只经 CLI**（与 assoc-edit 同规约）。
   *
   * 为什么不让渲染层在内存里剪、再随保存一起写回：
   *   `assoc` 的作者是 AI/CLI、节点树归渲染层，而 `project:save` 在渲染层没带 `assoc` 时
   *   会**从磁盘取回**（防止 AI 刚写的笔记被一次界面保存抹掉）。于是渲染层的
   *   "我把 assoc 清空了"与"我没见过 assoc"在载荷上**无法区分** —— 实测：
   *   界面删掉被引用的节点后在内存里剪掉成员，保存时磁盘那份又被取回，
   *   悬挂成员原地复活，保存被校验闸门拒绝（用户彻底卡死）。
   *   故改为先在磁盘上剪干净（CLI 校验闸门 + 原子写），再让保存去写节点树。
   *
   * 两类引用都要清，否则都会把项目锁死（validate 是写盘闸门）：
   *   · 关联成员：assoc-prune（关联笔记把若干节点的关联当成一个对象）
   *   · 链接目标：links-prune（同项目里指向被删节点的有向边）
   * 顺序上先清链接再清关联，两者都是"只做减法"的幂等操作，失败时报出可复制的修复命令。 */
  ipcMain.handle('app:pre-delete-cleanup', (e, projectName, ids) => {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) return { ok: false, text: '没有要清理的节点 id' };
    const nodes = list.join(',');
    const texts = [];
    for (const args of [['links-prune', projectName, '--nodes', nodes], ['assoc-prune', projectName, '--nodes', nodes]]) {
      try { texts.push(String(runCli(args)).trim()); }
      catch (err) {
        return { ok: false, text: '清理失败（' + args[0] + '）：' + ((err && err.message) || String(err))
          + '\n可手动执行：' + args.join(' ') };
      }
    }
    // 回读原始实体现状供渲染层同步内存（--raw = 只含契约字段，见 cli/commands/assoc.js）
    let raw = null;
    try {
      const back = JSON.parse(runCli(['assoc-list', projectName, '--json', '--raw']));
      raw = back.raw || [];
    } catch (err) { /* 回读失败不影响"已清理成功"这个事实 */ }
    return { ok: true, text: texts.join('\n'), raw: raw };
  });

  /* 【R2 期 3 · e】**同级重排**：把"拖到第 k 位"这条界面手势接到**既有** CLI `move --index` 上。
   *
   * 为什么必须是这个形状（不变式②：重排/重挂只经既有 move 语义）：
   *   · 渲染层**不许直接写项目 JSON** ✗ —— 这里的写口只有 `runCli(['move', …])`；
   *   · **不许造第二份 move 实现** ✗ —— `move --index` 的语义唯一实现在 `src/tree-utils.js` 的
   *     `moveNode`，而它的**上界校验**（P3）唯一实现在 `cli/commands/edit.js` 的
   *     `moveIndexUpperBound`（`move` 与 `apply` 的 move op 共用那一处）。本 handler
   *     **不复制**那条判定：渲染层发来的 k 越界时，CLI 自己会响亮拒绝（盘上零改动），
   *     回执里带着合法范围 —— 这里只把它的报文原样交回界面。
   *   · 为什么不是"渲染层改内存树 + project:save 整树写回"：那条路绕过写盘闸门（校验 + 原子写 +
   *     并发重放），而且会把"其余字段逐字节不变"这条判据变成"靠记得别漏字段"（本工程有四次先例）。
   *
   * **写完回读**（照 `app:unlink-nodes` / `app:assoc-edit` 的手法）：回读的**只有父节点新的
   *   `children` 顺序**（`f.id`，等于契约形状），渲染层拿它重建并把新顺序显示出来。
   *   回读失败 ⇒ `children: null`，界面**不许假装同步成功**（"采不到真值"与"采到了"必须可分辨）。
   *
   * 参数校验（形状层，不是业务判定）：`index` 必须是非负整数 —— 这不是第二份上界校验，
   *   而是**接口形状**：CLI 的 `--index` 本身就只收非负整数（收 `"abc"` 会报错）。
   *   `parent` 省略 ⇒ 与 CLI 同义（`move` 要求显式给新父；这里**不给默认值**，避免两处口径）。 */
  ipcMain.handle('app:move-node-sibling', (_e, projectName, nodeId, parentId, index) => {
    if (!projectName || !nodeId || !parentId) {
      return { ok: false, text: '缺少项目名 / 节点 id / 父节点 id（本入口不做默认值 —— 与 CLI 同签名）' };
    }
    const k = Number(index);
    if (!Number.isInteger(k) || k < 0) {
      return { ok: false, text: '第几位必须是非负整数（收到 ' + JSON.stringify(index) + '）' };
    }
    let text;
    try { text = runCli(['move', String(projectName), String(nodeId), String(parentId), '--index', String(k)]); }
    catch (err) { return { ok: false, text: (err && err.message) || String(err) }; }
    let children = null;
    let data = null;
    try {
      const back = store.read(String(projectName));
      data = back.data;                       // 回读的**整份项目数据**（渲染层按它重建，见 app-actions）
      let found = null;
      (function walk(n) {
        if (!n || found) return;
        if (n.id === String(parentId)) { found = n; return; }
        (n.children || []).forEach(walk);
      })(data && data.data);
      children = found ? (found.children || []).map((c) => c.id) : null;
    } catch (err) { /* 回读失败不影响"已写入"这个事实；data=null 会让渲染层如实报告 ✗ */ }
    return { ok: true, text: String(text).trim(), project: String(projectName),
      node: String(nodeId), parent: String(parentId), index: k, children: children, data: data };
  });

  /* 【R2 期 4 · f】**重挂父**：把 a 的子树挂到 b 下 —— 三道闸里的**第一道（落位预览）**。
   *
   * 预览跑在**演练副本**上（照 W13 导入预览的同一套做法，复用同一个 `makeRehearsalRoot`）：
   *   `fs.mkdtempSync` ⇒ 副本（全部项目的 JSON + 目标项目的 assets/attachments）⇒ 在副本上跑
   *   既有 `apply --dry-run`（`AI_MINDMAP_PROJECTS_DIR` 指到副本 ⇒ CLI 的写路径整体被重定向）
   *   ⇒ **无论成败都删掉副本**（finally）。⇒ 用户项目此刻一个字节都没动（盘上判据由冒烟域 49
   *   用 SHA-256 钉着），"成环 / 父不存在 / 越界"这些拒绝在预览里就带着 CLI 的**具体理由**回来。
   *
   * 为什么预检用的命令与真写是同一条（`apply` 的 move op）：预览说的 = 真跑做的（同一份判据），
   *   不许两边各算一套 ✗。move op 的语义唯一实现仍是 `src/tree-utils.js` 的 `moveNode`（防环内建）。
   *
   * 失败判定（dry-run 的既有行为：逐条预演、失败行打 `✗` 且**退出码仍是 0**）：
   *   `code !== 0`（命令本身没跑成）/ `^error:`（mm-cli 的报错前缀）/ 输出里有 `✗`（某条 op 会失败）
   *   三者任一 ⇒ `ok:false`。理由行**取带 `✗` 的那一行**（具体理由在那里；dry-run 的**最后一行**
   *   是汇总句 —— 照抄 `cliErrorLine` 的"取最后一行"会把理由吞掉，实测域 49 的判据抓的就是它）。
   *   **读不出"将会成功"就不说成功**（三态纪律）。 */
  ipcMain.handle('app:reparent-preview', async (_e, projectName, nodeId, newParentId) => {
    if (!projectName || !nodeId || !newParentId) {
      return { ok: false, error: '缺少项目名 / 节点 id / 目标父 id（重挂预览三个都要）' };
    }
    let tmpRoot = '';
    try { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reparent-preview-')); }
    catch (err) { return { ok: false, error: '建不了演练副本目录：' + ((err && err.message) || err) }; }
    try {
      const ops = JSON.stringify({ version: 1, ops: [{ op: 'move', id: String(nodeId), parent: String(newParentId) }] });
      const copy = makeRehearsalRoot(tmpRoot, String(projectName));
      const r = await runCliAsync(['apply', String(projectName), '--ops-file', ops, '--dry-run'], tmpRoot);
      const out = String(r.out || '');
      const refused = r.code !== 0 || /^error:/m.test(out) || out.indexOf('✗') >= 0;
      const failLine = out.split('\n').filter((l) => l.indexOf('✗') >= 0).pop();
      return { ok: !refused, dryRun: true, project: String(projectName), node: String(nodeId),
        parent: String(newParentId), copy: copy, text: out.trim(),
        error: refused ? ((failLine || cliErrorLine(r)).trim()) : '' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      // 演练副本必须收干净（E2，与 app:import-preview 同一条 finally）：清不掉只影响临时目录
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* 收尾失败不掩盖主结果 */ }
    }
  });

  /* 【R2 期 4 · f】**重挂父的写通道** —— 三道闸里的**第二道（写前 `--dry-run` 预检）与第三道（回读重建）**。
   *
   * 与 `app:move-node-sibling`（期 3 · e）同族、同形状，差异只有两点：
   *   ① 写入走 `apply` 的 **move op**（与裸 `move` 共用 `tree.moveNode` ⇒ 仍是一处实现；
   *      设计稿 §2.3 的定版形状）——于是**预检与真写是同一条 ops**；
   *   ② 真写之前先在**真实项目**上跑一次 `apply --dry-run`（W8 的中央短路 ⇒ 它本身零写入）：
   *      预检不过 ⇒ **一条都不写**（这里返回 `ok:false`，`phase:'dry-run'` + CLI 原话）。
   *      渲染层的"落位预览+确认"是体验闸；这道预检是**契约闸** —— 就算调用方绕过预览
   *      （冒烟域 49 的 raw 注入点）直接进本通道，成环 / 父不存在也在这里被拦下。
   *
   * **写完回读**（照 app:move-node-sibling 的手法）：回读**整份项目数据** + 新父的 `children` 顺序；
   *   回读失败 ⇒ `data:null`，渲染层如实说"盘上已写、界面未同步"，不静默重载也不假装成功。 */
  ipcMain.handle('app:move-node-parent', async (_e, projectName, nodeId, newParentId) => {
    if (!projectName || !nodeId || !newParentId) {
      return { ok: false, text: '缺少项目名 / 节点 id / 目标父 id（本入口不做默认值 —— 与 CLI 同签名）' };
    }
    const ops = JSON.stringify({ version: 1, ops: [{ op: 'move', id: String(nodeId), parent: String(newParentId) }] });
    // ---- 第二道闸：写前 `--dry-run` 预检（真实项目；--dry-run 本身零写入 ✓）----
    const dry = await runCliAsync(['apply', String(projectName), '--ops-file', ops, '--dry-run']);
    const dryOut = String(dry.out || '');
    if (dry.code !== 0 || /^error:/m.test(dryOut) || dryOut.indexOf('✗') >= 0) {
      // 理由取带 `✗` 的那一行（具体理由在那里；最后一行是汇总句 —— 与 app:reparent-preview 同一条规矩）
      const failLine = dryOut.split('\n').filter((l) => l.indexOf('✗') >= 0).pop();
      return { ok: false, phase: 'dry-run',
        text: '写前预检没有通过（apply --dry-run，**未写盘**）：' + ((failLine || cliErrorLine(dry)).trim()) };
    }
    // ---- 真写（唯一实现：apply 的 move op → src/tree-utils.js 的 moveNode）----
    let text;
    try { text = runCli(['apply', String(projectName), '--ops-file', ops]); }
    catch (err) { return { ok: false, text: (err && err.message) || String(err) }; }
    // ---- 第三道闸：回读整份项目数据（渲染层按它重建 ⇒ 界面 ≡ 盘上是构造性的）----
    let children = null;
    let data = null;
    try {
      const back = store.read(String(projectName));
      data = back.data;
      let found = null;
      (function walk(n) {
        if (!n || found) return;
        if (n.id === String(newParentId)) { found = n; return; }
        (n.children || []).forEach(walk);
      })(data && data.data);
      children = found ? (found.children || []).map((c) => c.id) : null;
    } catch (err) { /* 回读失败不影响"已写入"这个事实；data=null 会让渲染层如实报告 ✗ */ }
    return { ok: true, text: String(text).trim(), project: String(projectName),
      node: String(nodeId), parent: String(newParentId), children: children, data: data };
  });

  /* 系统剪贴板（**复制只有走这条路才不依赖窗口焦点**）。
   * 为什么必须由主进程代写：渲染层的两条浏览器通道在**无焦点的隐藏窗口**里都不可靠 ——
   * 实测（冒烟窗口按纪律隐藏且不抢焦点）`navigator.clipboard.writeText` 直接抛
   * "Document is not focused"，而 `execCommand('copy')` **自报成功**却可能什么都没写进系统剪贴板
   * ⇒ 复制的可靠性一度被绑在"窗口此刻有没有焦点"上（域 39 的判据因此只能降级成行为级）。
   * 主进程的 `clipboard` 是**进程级**的 OS 剪贴板 API，与窗口焦点无关 ✓。
   * 写后**回读**（与 assoc-edit 同一手法）：回给渲染层的是"真的写进去了"的读数，不是自报 ✓；
   * ⚠️ Electron 44 的 `clipboard.readText()` 返回 Promise（实测：直接 String() 得到 "[object Promise]"）
   * ⇒ 两种形状都接住。返回 `{ ok, value, readback, matched }`，**失败不静默** ✗。 */
  ipcMain.handle('app:clipboard-write', async (_e, text) => {
    const value = (typeof text === 'string') ? text : (text == null ? '' : String(text));
    try {
      clipboard.writeText(value);
    } catch (err) {
      return { ok: false, value: value, error: '写系统剪贴板失败：' + ((err && err.message) || String(err)) };
    }
    let back = null;
    try {
      const v = clipboard.readText();
      back = (v && typeof v.then === 'function') ? await v : v;
    } catch (err) { back = null; }   // 读不回来 ⇒ 如实报 null（不许冒充"写成功了"✓）
    return {
      ok: true, value: value,
      readback: (back === null || back === undefined) ? null : String(back),
      matched: back !== null && back !== undefined && String(back) === value
    };
  });

  /* ============ 【R4 界面侧】绑定工作区文件夹：三条入口（**判定与写盘全在 CLI**） ============
   * 这一批是"2/2 界面"：界面只做【入口 + 状态 + 播报】三件事 ——
   *   · 选目录（原生对话框）；
   *   · 绑定前预览（复用既有 `--dry-run` 读法，见下面 app:bind-preview 的说明）；
   *   · 暂停 / 继续 / 立即同步 / 解绑（四个动作各打在 `bind-sync` 的一个**既有**开关上）。
   * 界面侧**没有**任何"哪些文件要导进来""该不该写盘"的判断 —— 那全在 CLI（`bind-sync`）那一侧；
   * 连"绑定是什么"（取值表、暂停语义）也没有第二份：主进程只做"重挂/收掉 fs.watch"与转发读数。 */

  /** 选目录。正常路径是**原生对话框**（`dialog.showOpenDialog({properties:['openDirectory']})`）。
   *  ⚠️ `--smoke` 下改读一个**脚本化答案**文件（`<沙箱 projects>/bind-pick.txt`，内容 = 要返回的目录）：
   *  无头跑里原生模态**点不动**，弹出来只会把整条链挂死（冒烟守卫会强杀 ⇒ 变成一条假红）。
   *  它**只在 --smoke 跑动里生效**（正常启动连这个文件都不看）—— 照 `MM_ASK_STUB` 的先例：
   *  测试专用后门不许出现在产品路径上；返回里带 `stub:true`，如实告诉调用方"这一跳是桩"。 */
  ipcMain.handle('app:bind-pick-dir', async (e) => {
    if (SMOKE_PROJECTS_DIR) {
      const f = path.join(SMOKE_PROJECTS_DIR, 'bind-pick.txt');
      let dir = '';
      try { dir = String(fs.readFileSync(f, 'utf8')).trim(); } catch (err) { dir = ''; }
      if (!dir) return { ok: false, canceled: false, stub: true, error: '冒烟里没有脚本化目录：先写 ' + f };
      return { ok: true, stub: true, dir: dir };
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: '绑定工作区文件夹：选一个目录（它里面的内容会同步进这个项目）',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true, stub: false };
    return { ok: true, stub: false, dir: res.filePaths[0] };
  });

  /* **绑定前预览**：复用既有 `--dry-run` 读法，但**不写用户的项目**。
   * 为什么"直接对真项目 `--bind --dry-run`"不够（实测过）：`--bind` 那一轮**不算计划**
   *   （它只写绑定记录 ⇒ 报出来的 added/modified 恒为 0）⇒ 三个数（新增 N / 更新 M / 未转换 K）拿不到。
   * 为什么也不能"先绑上、再 dry-run 预览、再让用户确认"：那样**用户还没确认，绑定记录就已经进项目数据**，
   *   主进程的守护会照它挂 `fs.watch` ⇒ 确认之前就可能真同步一次 ⇒ "确认才绑定"就成了假话 ✗。
   * 做法：把项目 JSON **拷一份**进临时目录，把那份**演练副本**当 projects 根，跑
   *   `bind-sync <项目> --bind --dir … --json`（写的是副本）⇒ 再 `--dry-run --json`（一个字节都不写）
   *   ⇒ 把 CLI 自己报的那一行计划原样转交界面；最后删掉副本。
   *   用户的项目在这一步**一个字节都没动**（域 42 的判据 1 里对项目文件前后 SHA-256 有断言）。
   * 算法仍然**全在 CLI**（主进程不数"该导几个"），这里只是"换一份 projects 根 + 转交读数"。 */
  ipcMain.handle('app:bind-preview', async (_e, name, dir, opts) => {
    if (!name || !dir) return { ok: false, error: '预览需要一个项目和目录' };
    const mode = (opts && opts.mode) || 'flat';
    const src = path.join(PROJECTS_DIR, name, name + '.json');
    if (!fs.existsSync(src)) return { ok: false, error: '项目文件不存在：' + src };
    let tmpRoot = '';
    try { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bind-preview-')); }
    catch (err) { return { ok: false, error: '建不了演练副本目录：' + ((err && err.message) || err) }; }
    try {
      fs.mkdirSync(path.join(tmpRoot, name), { recursive: true });
      fs.copyFileSync(src, path.join(tmpRoot, name, name + '.json'));
      const b = await runCliAsync(['bind-sync', name, '--bind', '--dir', dir]
        .concat(bindOptionArgs(opts), ['--json']), tmpRoot);
      if (b.code !== 0) return { ok: false, error: cliErrorLine(b) };
      const p = await runCliAsync(['bind-sync', name, '--dry-run', '--json'], tmpRoot);
      if (p.code !== 0) return { ok: false, error: cliErrorLine(p) };
      const report = parseCliJson(p.out);
      if (!report) return { ok: false, error: '预览没有拿到 CLI 的报告（`--json` 解析失败）' };
      const row = (report.sync || [])[0] || null;
      if (!row) return { ok: false, error: '预览没有算出计划（CLI 报告里没有 sync 行）' };
      return { ok: true, dryRun: report.dryRun === true, dir: dir, mode: mode, plan: row };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      // 演练副本必须收干净（E2）：清不掉也只影响临时目录，用户数据这一路根本没被碰过
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* 收尾失败不掩盖主结果 */ }
    }
  });

  /* **确认绑定**：先写绑定记录（CLI `--bind`，**不动树**），再**立刻同步一次**。
   * 为什么是两次调用：引擎刻意把"绑上"与"同步"分开（`--bind` 那一轮不算计划，见 `bind-sync` 的实现），
   *   而"立刻同步"那条既有入口就是 `--resume`（它同时把状态复位回"守护中" —— 与用户刚点的确认同义）。
   * 打完**重挂守护**：新绑定要马上开始被盯（不重挂就要等到下一次 `project:read`）。 */
  ipcMain.handle('app:bind-apply', async (_e, name, dir, opts) => {
    if (!name || !dir) return { ok: false, error: '绑定需要一个项目和目录' };
    const o = opts || {};
    const b = await runCliAsync(['bind-sync', name, '--bind', '--dir', dir]
      .concat(bindOptionArgs(o)), undefined);
    if (b.code !== 0) return { ok: false, error: cliErrorLine(b) };
    const s = await runBindSyncCli(['bind-sync', name, '--resume', '--json'], name);
    try { bindWatchersFor(name, onBindingsSynced); } catch (err) { /* 守护起不来不阻断绑定本身 */ }
    if (s.code !== 0) return { ok: false, error: cliErrorLine(s), report: s.report };
    return { ok: true, report: s.report, changedKeys: s.changedKeys, addedKeys: s.addedKeys,
      removedKeys: s.removedKeys, modifiedKeys: s.modifiedKeys, labels: s.labels };
  });

  /* **控制动作**：暂停 / 继续 / 立即同步 / 解绑 / **确认删除提议** —— 一个动作一个**既有**开关
   * （没有第五条路：确认流打的也是同一门 `bind-sync`、同一条既有出口 `plan.confirmedNodeIds`）。
   * ⚠️ 打完**必须重挂守护**：暂停与解绑都要让 `fs.watch` 立刻收掉 —— 否则"文件一变照旧同步"
   *   （CLI 的同步不认 paused），"暂停"就只剩界面上好看 ✗（`bindWatchersFor` 的"收起"分支）。 */
  ipcMain.handle('app:bind-cmd', async (_e, name, action) => {
    const flags = { pause: ['--pause'], resume: ['--resume'], unbind: ['--unbind'], sync: [],
      confirmDeletions: ['--confirm-deletions'] };
    if (!Object.prototype.hasOwnProperty.call(flags, action) || !name) {
      return { ok: false, error: '不认识的绑定动作：' + JSON.stringify(String(action)) };
    }
    const r = await runBindSyncCli(['bind-sync', name].concat(flags[action], ['--json']), name);
    try { bindWatchersFor(name, onBindingsSynced); } catch (err) { /* 同上 */ }
    if (r.code !== 0) return { ok: false, error: cliErrorLine(r), report: r.report };
    return { ok: true, report: r.report, changedKeys: r.changedKeys, addedKeys: r.addedKeys,
      removedKeys: r.removedKeys, modifiedKeys: r.modifiedKeys, labels: r.labels };
  });

  /* **只读状态探针**：界面显示"守护中/已暂停 · 上次同步 · 待确认删 K · 未转换 K"要一份**当前的**
   * 读数，而引擎里唯一"只报告、不写盘"的读法就是 `--dry-run`（W8 的中央短路：`ctx.mutate` 不落盘、
   * 旁路快照也在 dry-run 下不写 —— 实测项目文件 SHA-256 前后相同）。
   * ⚠️ **不许**拿 `bind-sync --list` 当"只看状态"用：它其实**会同步**（PLAN 把 `--list` 只当"不算计划"，
   *   targets 仍然是全部绑定）⇒ 拿它刷新状态会在用户按了暂停之后**照旧改数据** ✗。
   * 返回的就是 CLI 的整份报告（`dryRun:true`），界面**只显示**，一个数都不自己算 ✓。 */
  ipcMain.handle('app:bind-probe', async (_e, name) => {
    if (!name) return { ok: false, error: '状态探针需要一个项目' };
    const r = await runCliAsync(['bind-sync', name, '--dry-run', '--json']);
    const report = parseCliJson(r.out);
    if (r.code !== 0 || !report) return { ok: false, error: cliErrorLine(r) };
    return { ok: true, report: report };
  });

  /* ============ 【W13】界面侧导入入口：选文件 / 选目录 → 预览 → 真导入 → 播报 ============
   * 用户原话（待做清单 W13）：「现在只能走 CLI，界面里点不进来」—— 想导整库的人第一反应就是
   * 拖目录 / 翻菜单，而界面从前只有「导入 Markdown…」（一个文件、导进当前项目）。
   *
   * 这一批只补**入口 + 预览 + 播报**三件事，判定与写盘**全在 CLI**（`import-md` / `import-dir`
   * 两条**既有**命令）：
   *   · 主进程不解析 md、不建树、不数"该导几个" —— 它只做三件机械事：弹原生对话框、换一份
   *     projects 根跑既有命令、把 CLI 自己的读数原样转交（读数形状的归一在 scripts/import-reading.js，
   *     界面**不认识** CLI 的字段名）。
   *   · **预览跑在演练副本上**（照 `app:bind-preview` 的做法）：把项目 JSON 拷进临时目录、把那份
   *     副本当 projects 根跑 `import-md … --dry-run`（写的是副本、且 dry-run 本身一个字都不写），
   *     最后删掉副本 ⇒ 用户的项目在这一步**一个字节都没动**（域 43 判据 ② 对项目 JSON 前后 SHA-256 有断言）。
   *   · **真导入**：文件走 `import-md`（**一个文件一条命令** ⇒ 一个坏文件拖不垮整批，逐条点名）；
   *     目录走 `import-dir`（整库镜像成**新项目**，然后按既有 `menu:open-project` 打开它）。
   *   · 界面脏（有未保存编辑）时**不导入**：那一条判定在渲染层（只有它知道脏不脏，见
   *     `renderer/app-import.js` 的 `importIntoMap`）—— 与绑定同步"界面脏就不写"同一条纪律，
   *     导入之后走**既有**重读/冲突路径（`MM.requestReread`），绝不静默覆盖人的编辑 ✗。
   *
   * 入口只有两条（原生菜单两项 + 命令面板里的同两条，见 `MPORT_MENU`），**工具栏一个像素都不动**：
   *  本工程踩过 —— 这段工具栏在侧栏开着时只剩 ~1000px，再加一个按钮就挤成两行，域 37 的圆钮几何
   *  当场变红 ✗✗（见 app-bindings.js 同一条注释）。 */

  /** 冒烟里的"脚本化答案"（`<沙箱>/import-pick-files.txt` 一行一个路径 / `import-pick-dir.txt` 一行）。
   *  为什么需要：无头跑里原生模态**点不动**，弹出来只会把整条链挂死（冒烟守卫会强杀 ⇒ 变成一条假红）
   *  —— 照 `app:bind-pick-dir` 的先例。⚠️ 它**只在 --smoke 跑动里生效**（正常启动连这两个文件都不看），
   *  返回里带 `stub:true` 如实告诉调用方"这一跳是桩"（测试专用后门不许出现在产品路径上）。 */
  const readImportPickStub = (kind) => {
    const f = path.join(SMOKE_PROJECTS_DIR, kind === 'dir' ? 'import-pick-dir.txt' : 'import-pick-files.txt');
    let text = '';
    try { text = String(fs.readFileSync(f, 'utf8')); } catch (err) { text = ''; }
    return { paths: text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), file: f };
  };

  /* 【W12】Obsidian 库的**界面侧识别**（只有一处）：选目录之后看一眼 `.obsidian/` 在不在。
   *  ⚠️ 判据本身（"什么算一个库"）与 CLI 那一侧是**同一条**：`src/doc-import.js` 的 `isVaultDir`
   *  用的就是这个目录名；主进程**不 require `src/`**（那会破依赖方向），所以这里按同一条规则
   *  用 `fs` 现看一眼 —— 两处都只回答"根上有 `.obsidian/` 吗"这一件事，规则没有第二种解释。
   *  识别到就**显式**给 CLI 加 `--vault`：真导与预览加的是同一个参数（预览 == 真跑的判据）✓ */
  const importDirIsVault = (dir) => {
    try { return fs.statSync(path.join(String(dir), '.obsidian')).isDirectory(); }
    catch (err) { return false; }
  };

  /** 选文件 / 选目录（**原生对话框**）。`opts.where` = 落点那一句人话（写进对话框标题 ⇒
   *  "导到哪"在选择器里就说得清，不用等预览）。 */
  ipcMain.handle('app:import-pick', async (e, kind, opts) => {
    const k = kind === 'dir' ? 'dir' : 'files';
    const where = String((opts && opts.where) || '').slice(0, 120);
    if (SMOKE_PROJECTS_DIR) {
      const s = readImportPickStub(k);
      const paths = (k === 'dir') ? s.paths.slice(0, 1) : s.paths;
      if (!paths.length) return { ok: false, canceled: false, stub: true, error: '冒烟里没有脚本化答案：先写 ' + s.file };
      return { ok: true, stub: true, kind: k, paths: paths };
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, k === 'dir' ? {
      title: '选一个文件夹：整库导入会**新建一个项目**' + where,
      properties: ['openDirectory']
    } : {
      title: '选一个或多个 Markdown 文件' + where,
      buttonLabel: '导入这些文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: '可导入的文档', extensions: ['md', 'markdown', 'txt', 'text', 'docx', 'pdf'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true, stub: false };
    return { ok: true, stub: false, kind: k, paths: res.filePaths };
  });

  /** **导入前预览**：复用既有 `--dry-run` 读法，跑在**演练副本**上（用户项目零写入）。
   *  文件那一路：每个文件一次 `import-md … --dry-run`（新增条数由 CLI 自己的那一行给 —— 这条命令
   *    没有 `--json` 报告，读法在 scripts/import-reading.js，且有单测）；失败的**逐条**带原因回来。
   *  目录那一路：`import-dir <新项目名> <目录> --dry-run --json`（这条**本来就有**结构报告：
   *    报告里就写着"会不会被拒"与"哪些没进树"）。 */
  ipcMain.handle('app:import-preview', async (_e, name, plan) => {
    const p = plan || {};
    const kind = p.kind === 'dir' ? 'dir' : 'files';
    let tmpRoot = '';
    try { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-preview-')); }
    catch (err) { return { ok: false, error: '建不了演练副本目录：' + ((err && err.message) || err) }; }
    try {
      if (kind === 'files') {
        if (!name) return { ok: false, error: '预览需要一个当前项目' };
        const files = Array.isArray(p.files) ? p.files : [];
        if (!files.length) return { ok: false, error: '预览没有拿到文件清单' };
        const parent = p.parent || 'root';
        if (!fs.existsSync(path.join(PROJECTS_DIR, name, name + '.json'))) {
          return { ok: false, error: '项目文件不存在：' + path.join(PROJECTS_DIR, name, name + '.json') };
        }
        const copy = makeRehearsalRoot(tmpRoot, name);
        const items = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const r = await runCliAsync(['import-md', name, f, '--parent', parent, '--dry-run'], tmpRoot);
          const bad = r.code !== 0 || /^error:/m.test(String(r.out || ''));
          const reading = importReading.readImportMdDryRun(r.out);
          items.push({ file: f, ok: !bad, added: bad ? 0 : reading.added,
            unreadable: bad ? '' : reading.unreadable, error: bad ? cliErrorLine(r) : '' });
        }
        const preview = importReading.mergeFilePreviews(items);
        return { ok: true, dryRun: true, kind: kind, project: name, parent: parent,
          items: items, preview: preview, copy: copy };
      }
      if (!p.dir) return { ok: false, error: '预览需要一个目录' };
      const newName = p.name || sanitizeProjectName(path.basename(p.dir));
      /* 【W12】库识别与真导**用同一个判据、同一个参数**：显式 `--vault`（不看自动识别那条路，
       * 免得"预览按自动识别跑、真导按参数跑"出现两条判据）⇒ 预览说的就是真跑会做的 ✓ */
      const isVault = importDirIsVault(p.dir);
      const copy = makeRehearsalRoot(tmpRoot, name);
      const dirArgs = ['import-dir', newName, p.dir, '--title', p.title || newName, '--dry-run', '--json'];
      if (isVault) dirArgs.push('--vault');
      const r = await runCliAsync(dirArgs, tmpRoot);
      const report = parseCliJson(r.out);
      if (r.code !== 0 || !report) return { ok: false, error: cliErrorLine(r) };
      return { ok: true, dryRun: report.dryRun === true, kind: kind, project: newName, dir: p.dir,
        vault: isVault, report: report, preview: importReading.dirPreviewOf(report), copy: copy };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      // 演练副本必须收干净（E2）：清不掉也只影响临时目录，用户数据那一路根本没被碰过
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* 收尾失败不掩盖主结果 */ }
    }
  });

  /** **真导入**：只调既有 CLI（`import-md` 逐文件 / `import-dir` 整库）。
   *  · 文件那一路**不因为一个文件失败就整批中止**（部分成功是硬要求：好的照进、坏的逐条点名）；
   *  · 结束时用**同一处差异实现**（`diffTrees`）现算"这批到底加了哪些节点"，配人话名一起给界面
   *    —— 播报面板点一行能跳到它、且这两个数与预览那个数是**独立来源**（域 43 判据 ① 拿它们对拍）。 */
  ipcMain.handle('app:import-apply', async (e, name, plan) => {
    const p = plan || {};
    const parent = p.parent || 'root';
    if (p.kind === 'dir') {
      if (!p.dir) return { ok: false, error: '真导入需要一个目录' };
      const newName = p.name || sanitizeProjectName(path.basename(p.dir));
      /* 【W12】`--vault` 与预览用**同一个判据**（`importDirIsVault`）⇒ 预览说的方向就是真跑做的方向 ✓ */
      const isVault = importDirIsVault(p.dir);
      const applyArgs = ['import-dir', newName, p.dir, '--title', p.title || newName];
      if (isVault) applyArgs.push('--vault');
      const r = await runCliAsync(applyArgs);
      if (r.code !== 0) return { ok: false, error: cliErrorLine(r) };
      const tree = readProjectTree(newName);
      const d = tree ? allNodeKeysOf(tree) : emptyDiff();
      /* 新项目要**打开**它（否则用户看到的是"什么都没发生"）：走既有两条事件
       * （`menu:project-changed` 刷新列表 + `menu:open-project` 换过去，与 `afterDocImported` 同一套） */
      try {
        const wc = e.sender;
        if (wc && !wc.isDestroyed()) {
          wc.send('menu:project-changed');
          wc.send('menu:open-project', newName);
        }
      } catch (err) { /* 打不开新项目不影响"导入成功"这个事实：回执里带着项目名，界面照实说 */ }
      return { ok: true, kind: 'dir', createdProject: newName, project: newName,
        vault: isVault, addedKeys: d.added, modifiedKeys: d.modified, labels: d.labels, out: String(r.out || '').trim() };
    }
    if (!name) return { ok: false, error: '真导入需要一个当前项目' };
    const files = Array.isArray(p.files) ? p.files : [];
    if (!files.length) return { ok: false, error: '真导入没有拿到文件清单' };
    const before = readProjectTree(name);
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = await runCliAsync(['import-md', name, f, '--parent', parent]);
      const bad = r.code !== 0 || /^error:/m.test(String(r.out || ''));
      const reading = importReading.readImportMdDryRun(r.out);
      items.push({ file: f, ok: !bad, added: bad ? 0 : reading.added,
        unreadable: bad ? '' : reading.unreadable, error: bad ? cliErrorLine(r) : '' });
    }
    const after = readProjectTree(name);
    let d = emptyDiff();
    if (before && after) { try { d = diffTrees(before, after); } catch (err) { d = emptyDiff(); } }
    const okCount = items.filter((it) => it.ok).length;
    return { ok: okCount > 0, kind: 'files', project: name, parent: parent, items: items,
      succeeded: okCount, failed: items.length - okCount, preview: importReading.mergeFilePreviews(items),
      addedKeys: d.added, modifiedKeys: d.modified, labels: d.labels };
  });

  ipcMain.handle('app:version', () => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
    catch (err) { return '0.0.0'; }
  });

  /* DSH 侧边栏状态（渲染层只拿状态与几何，绝不拿 token/url） */
  ipcMain.handle('dsh-sidebar:status', () => dshSidebar.getStatus());
  ipcMain.handle('dsh-sidebar:prefill', (_e, text) => prefillAfterEnsureOpen(text));
  /* 拖宽分隔条：渲染层在交界处 mousedown 时触发（坐标 hit-test 在渲染层做，
   * 主进程用 screen.getCursorScreenPoint 轮询接管拖拽 —— Electron 惯例） */
  ipcMain.on('dsh-sidebar:drag-start', () => dshSidebar.beginWidthDrag());
  ipcMain.on('dsh-sidebar:drag-end', () => dshSidebar.endWidthDrag());

  /* ---- P7 真·跨视图拖放：选区拖到**原生侧栏视图**上松手也要生效 ✓ ----
   * 起点/终点各一次（渲染层上报 ✓），中间由主进程 40ms 轮询光标屏幕坐标（无需权限 ✓）。
   * 投喂仍走渲染层的 MM.sendNodesToSidebar（文本只有那一处实现 ✓）；这里只回判定回执 ✓。
   * 兜底：结束信号**永远不来**时（指针停在原生视图上 ✗）30s 自动清理并留日志 —— 不静默泄漏 ✗。 */
  let selDrag = null;
  const SEL_DRAG_MAX_MS = 30000;
  const SEL_DWELL_MS = 400;   // 光标在侧栏视图上停这么久 ⇒ 判为"在这儿松的手"（跨视图那条路的唯一近似 ✓）
  ipcMain.on('dsh-sidebar:sel-drag-start', (e, ids) => {
    if (selDrag && selDrag.timer) clearInterval(selDrag.timer);
    const list = Array.isArray(ids) ? ids.filter((x) => typeof x === "string").slice(0, 50) : [];
    selDrag = null;
    if (!list.length) { console.log("[dsh-sidebar] 选区拖拽：没有选区 ⇒ 不跟踪"); return; }
    let win = null;
    try { win = BrowserWindow.fromWebContents(e.sender); } catch (err) { win = null; }
    const st = { ids: list, pt: null, timer: null, t0: Date.now(), win: win, overSince: null, fired: false };
    st.timer = setInterval(() => {
      try { const p = screen.getCursorScreenPoint(); st.pt = { x: p.x, y: p.y }; } catch (err) { /* 取不到就保留上一次 ✓ */ }
      // ③ 跨视图兜底：渲染层收不到 mouseup ⇒ 终点永远不会上报 ✗ ⇒ 这里按"悬停时长"判 ✓
      // ⚠️ **只在真实使用里生效**：冒烟没有真光标概念 ⇒ 兜底是否触发会取决于测试者鼠标当时停在哪
      //    （实测：它让 P7 对照组随机变红 ✗）⇒ 冒烟里关掉 ✓（判定逻辑本身由 drop-target 的单测钉住 ✓）
      if (!isSmoke && !st.fired && st.pt) {
        try {
          const cb0 = (st.win && !st.win.isDestroyed() && st.win.getContentBounds) ? st.win.getContentBounds() : null;
          const vb0 = dshSidebar.viewBounds();
          const over = !!(cb0 && dropTarget.isPointInSidebar(st.pt, cb0, vb0));
          if (!over) st.overSince = null;
          else if (!st.overSince) st.overSince = Date.now();
          if (over && dropTarget.shouldDropByDwell(st.pt, cb0, vb0, st.overSince, Date.now(), SEL_DWELL_MS)) {
            st.fired = true;
            clearInterval(st.timer);
            if (selDrag === st) selDrag = null;
            console.log("[dsh-sidebar] 选区拖拽：光标在侧栏上停留 ≥" + SEL_DWELL_MS + "ms ⇒ 判为在此松手，交给渲染层投喂 ✓");
            try { st.win.webContents.send("dsh-sidebar:sel-drop", st.ids); } catch (err2) { console.log("[dsh-sidebar] 投喂通知失败：" + ((err2 && err2.message) || err2)); }
          }
        } catch (err3) { /* 判定失败不影响 30s 兜底清理 ✓ */ }
      }
      if (Date.now() - st.t0 > SEL_DRAG_MAX_MS) {
        clearInterval(st.timer); if (selDrag === st) selDrag = null;
        console.log("[dsh-sidebar] 选区拖拽：30s 没收到结束信号 ⇒ 已清理（指针可能停在原生侧栏视图上 ✗）");
      }
    }, 40);
    if (st.timer.unref) st.timer.unref();
    selDrag = st;
  });
  ipcMain.handle('dsh-sidebar:sel-drag-end', (_e, atPoint) => {
    const st = selDrag; selDrag = null;
    if (st && st.timer) clearInterval(st.timer);
    if (!st) return { ok: false, reason: "no-active-drag", hit: false };
    let pt = st.pt, hit = false, reason = "", ptWin = null, viewRect = null;
    try {
      const wb = (st.win && !st.win.isDestroyed()) ? st.win.getBounds() : null;
      // 渲染层真收到 mouseup ⇒ 它的 clientX/Y 才是**这次松手**的位置 ✓（换算到屏幕坐标）；
      // 只有它没报（跨视图：指针停在原生侧栏视图上，渲染层收不到事件 ✗）才回退到轮询到的光标点 ✓。
      const cb = (st.win && !st.win.isDestroyed() && st.win.getContentBounds) ? st.win.getContentBounds() : null;
      if (atPoint && cb && typeof atPoint.x === 'number' && typeof atPoint.y === 'number') {
        pt = { x: cb.x + atPoint.x, y: cb.y + atPoint.y };
      } else if (!pt) { const p = screen.getCursorScreenPoint(); pt = { x: p.x, y: p.y }; }
      const vb = dshSidebar.viewBounds();
      viewRect = vb ? { x: vb.x, y: vb.y, width: vb.width, height: vb.height } : null;
      if (wb) ptWin = { x: pt.x - wb.x, y: pt.y - wb.y };   // 与 viewRect 同框 ⇒ 断言可独立复算 ✓
      hit = !!(wb && dropTarget.isPointInSidebar(pt, wb, vb));
      if (!vb) reason = "sidebar-closed";
      else if (!wb) reason = "no-window";
      else if (!hit) reason = "point-not-over-sidebar";
    } catch (err) { reason = "judge-error:" + ((err && err.message) || err); }
    console.log("[dsh-sidebar] 选区拖拽结束：point=" + JSON.stringify(pt) + " hit=" + hit + (reason ? (" reason=" + reason) : ""));
    return { ok: true, hit: hit, ids: st.ids, reason: reason, pt: pt, ptWin: ptWin, viewRect: viewRect };
  });
  /* 折叠后的重展开圆钮（渲染层 fab）→ toggle（与菜单 Ctrl+B 同一入口） */
  ipcMain.on('dsh-sidebar:toggle', () => dshSidebar.toggle());
  /* 仅侧边栏模式查询（渲染层/外部 AI 可读状态） */
  ipcMain.handle('dsh-sidebar:dsh-only', () => dshSidebar.isDshOnly());
  /* 导图页右上角那个独立 ✕ 走这里：**真关 = 把这一页从内存里卸掉**（v0.19 语义）。
   * ⚠️ `confirmed:true` 是渲染层的承诺：它已经拦过未保存编辑（「保存后关闭 / 取消」），
   *    必要时保存成功后才发这条 —— 主进程不重复问（问也问不出人话，它只看得见脏标记）。
   * 返回结构化结果（ok/reason），**失败不静默** ✗ */
  ipcMain.handle('dsh-sidebar:close-map-page', () => dshSidebar.closeMapPage({ confirmed: true }));
  /* 重开（占位页上的按钮 / 菜单 / 侧栏「⤢」都走它）：重新加载这一页 + 还原停靠宽度 + 回上次项目 */
  ipcMain.handle('dsh-sidebar:open-map-page', () => dshSidebar.openMapPage());
  /* 页面 boot 时问一次"我该打开哪个项目"：只有"重开"会武装它 ⇒ 正常启动仍按原样开 projects[0] ✓ */
  ipcMain.handle('dsh-sidebar:boot-project', () => ({ project: dshSidebar.bootProject() }));

  /* ---- 界面状态落盘（v0.16.6「写前协调」的可执行版本） ----
   * 渲染层在脏标记变化时推 app:ui-state → 这里写 projects/<项目>/.ui-state.json。
   * 侧栏 AI 用 `node cli/mm-cli.js ui-state --json` 读它 —— 这是它能真正够到的
   * 通道（旧 IPC dsh-sidebar:ui-dirty 无任何调用方，已删除，见 src/ui-state.js 顶部）。
   * 写失败不致命：读方把"没有文件"当作"界面未运行"，不影响编辑。 */
  function writeUiStateFile(project, dirty, seenVersion) {
    if (!project) return;
    try {
      /* v0.20 增的两个版本字段（读方据此判「界面所见落后盘上多少」，语义只有一处：
       * `src/ui-state.js` 的 buildState 注释）：
       *   · `seenVersion` = 界面**所见内容**的盘上版本 —— 渲染层上报。
       *     `undefined` 表示"本次调用没带"（退出时那种调用就属于这一档）⇒ **沿用盘上已有值**，
       *     绝不把它抹成空串（那会把"界面看到过哪一版"这条事实丢掉 ✗）。
       *   · `baseVersion` = **闸门基线**（`versionAtRead`）—— 只由主进程填，渲染层报什么都不采信。
       */
      let seen = seenVersion;
      if (seen === undefined) {
        try {
          const prev = uiState.parseState(
            fs.readFileSync(uiState.statePath(path, PROJECTS_DIR, project), 'utf8'));
          seen = prev.ok ? prev.state.seenVersion : '';
        } catch (err) { seen = ''; }   // 文件不在/读不动 ⇒ 空串（读方按"未上报"处理，不阻塞）
      }
      writeFileAtomic(
        uiState.statePath(path, PROJECTS_DIR, project),
        uiState.serializeState({
          project, dirty, uiPid: process.pid,
          seenVersion: seen,
          baseVersion: versionAtRead.get(project) || ''
        }));
    } catch (err) { /* 非致命：读方把"没有文件"当作"界面未运行" */ }
  }
  ipcMain.on('app:ui-state', (e, payload) => {
    const p = payload || {};
    writeUiStateFile(String(p.project || ''), !!p.dirty,
      typeof p.seenVersion === 'string' ? p.seenVersion : undefined);
  });
  // 应用退出：界面不再持有任何未保存编辑（否则崩溃/退出前的 dirty=true 会永久吓住 AI）
  app.on('will-quit', () => {
    // 【R4】绑定守护也要收干净：监听句柄与兜底定时器都是进程级的（留着会拖住退出/留孤儿）
    try { stopBindingWatchers(); } catch (err) { /* 收尾失败不阻断退出 */ }
    try {
      const names = [];
      fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).forEach((d) => {
        if (d.isDirectory() && fs.existsSync(path.join(PROJECTS_DIR, d.name, uiState.FILE_NAME))) names.push(d.name);
      });
      names.forEach((n) => writeUiStateFile(n, false));
    } catch (err) { /* 非致命 */ }
  });
}

/* ---------------- 冒烟自检（--smoke） ----------------
 * headless：加载页面 → 逐条执行 smoke-assertions → 截图 → 汇总退出。
 * 不依赖键盘/鼠标，供 CI 与 AI 迭代验证使用。
 */
async function runSmoke(win) {
  // ⚠️ 断言清单的**加载**必须响亮失败：某个 `scripts/smoke/NN-*.js` 在 require 期抛错时，
  // 旧行为是抛成 UnhandledPromiseRejection ⇒ 整轮**静默挂住**、只能等守卫超时，
  // 输出里连一条断言都没有（这个坑真实踩过两次：一次是探针文件，一次是 require 路径写错）。
  let allAssertions;
  try {
    allAssertions = require('./scripts/smoke-assertions.js');
  // 给每条断言打上**所属域**（冒烟文件 ✓）：隔离要按域做，不能按断言 ✗
  //  —— 有些域是"先写盘、再由后续断言检查刚才写的东西"（如"外部新写的笔记不被保存抹掉"），
  //     按断言隔离会把被测行为本身擦掉 ⇒ 上轮我实测到 5 条 assoc 假红 ✗。
  try { for (const grp of (allAssertions.groups || [])) for (const a of grp.assertions) a.__domain = grp.file; }
  catch (e) { console.log('[smoke] 域标记失败（隔离将退化为按断言）：' + ((e && e.message) || e)); }
  } catch (err) {
    console.log('SMOKE LOAD ERROR — 冒烟断言清单加载失败（很可能是某个 scripts/smoke/*.js 在 require 期抛错）：');
    console.log('  ' + ((err && err.stack) || err));
    app.exit(1);
    return;
  }
  // ── 严格档开关（`MM_SMOKE_CLIP_STRICT`，**默认关**；解析只有一处 = 上面那个模块的 `parseStrictEnv`）──
  /* 为什么要有它（补的是三态判据的已知盲区）：第三态"未验证"让环境问题不再冒充产品缺陷 ✓，
   * 但它同时开了一个口子 —— **环境坏的时候，产品真回归也会被降级成"未验证"**（探针说不可用 ⇒
   * 我们连"值对不对"都无从判）⇒ 在 CI / 受控环境里我们想要"**宁可红，不许悄悄放过**"。
   * 语义（开关打开时）：`unverified` 那几条**如实打印、仍点名原因**，但**按失败计**
   * （进失败计数、进总数、并让退出码 ≠ 0）；关着时与加它之前**逐字节相同**（三个数、报文、退出码都不动 ✓）。
   * ⚠️ 值非法必须**当场红**：静默落回某一档等于"你以为在受控环境里跑，其实没有" ✗
   *   （照 `SMOKE SELECTION ERROR` / `SMOKE ENV ERROR` 先例：不打任何断言、exit 1 ✓）。 */
  const strictFlag = allAssertions.parseStrictEnv(process.env.MM_SMOKE_CLIP_STRICT);
  if (!strictFlag.ok) {
    console.log('SMOKE STRICT FLAG ERROR — MM_SMOKE_CLIP_STRICT 的值非法：' + strictFlag.reason);
    console.log('（本轮**没有**跑任何断言，绝不能算通过；开关语义见 scripts/smoke-assertions.js 的 `parseStrictEnv`）');
    app.exit(1);
    return;
  }
  const strictOn = strictFlag.strict;
  if (strictOn) {
    console.log('[smoke] **严格档已开**（MM_SMOKE_CLIP_STRICT='
      + JSON.stringify(process.env.MM_SMOKE_CLIP_STRICT) + '）：任何"未验证"一律**按失败计**'
      + '（进失败计数、进总数、并让退出码 ≠ 0）—— 环境坏时宁可红，不许悄悄放过 ✓');
  }
  // ── 环境守卫：跑不了就必须**响亮失败** ──────────────────────────────────────
  // 教训（本轮真的发生了）：单实例锁一度把冒烟那个实例挡在门外，冒烟**一条断言都没跑**，
  // 而 G5 只用 2.2s 就被判"通过" ✗ —— 门禁静默空转比报错危险得多。
  {
    const envProblems = [];
    if (!win || win.isDestroyed()) envProblems.push('窗口不可用（被单实例锁挡掉？）');
    if (!allAssertions.files || !allAssertions.files.length) envProblems.push('没发现任何 scripts/smoke/NN-*.js');
    if (envProblems.length) {
      console.log('SMOKE ENV ERROR — 冒烟无法运行：' + envProblems.join('、'));
      console.log('（本轮**没有**跑任何断言，绝不能算通过）');
      app.exit(1);
      return;
    }
  }
  // ── 单跑（只跑选中的断言文件）──────────────────────────────────────────────
  // 用法：SMOKE_ONLY=20,21 npm run smoke   ／  electron . --smoke-only=20,21
  // 为什么：全链一轮约 100–120 s，改一条断言就得等整轮，而且每轮真启动 Electron、真占内存
  //（实测反复跑把整机提交内存推到 80%，连带把同机其它界面拖卡/拖崩）。选择规则与"筛错名字必须响亮失败"
  // 的细节见 scripts/smoke-select.js；过滤运行**不是全量真值**，故跳过截图/视觉断言/取景记录并显著标记。
  const select = require('./scripts/smoke-select.js');
  const specArg = process.argv.find((a) => a.indexOf('--smoke-only=') === 0);
  const spec = specArg ? specArg.slice('--smoke-only='.length) : (process.env.SMOKE_ONLY || '');
  let pickedFiles;
  try {
    pickedFiles = select.selectFiles(allAssertions.files || [], spec);
  } catch (err) {
    console.log('SMOKE SELECTION ERROR — ' + ((err && err.message) || err));
    app.exit(1);
    return;
  }
  const filtered = pickedFiles.length !== (allAssertions.files || []).length;
  const byFile = {};
  (allAssertions.groups || []).forEach((g) => { byFile[g.file] = g.assertions; });
  const assertions = filtered
    ? [].concat(...pickedFiles.map((f) => byFile[f] || []))
    : allAssertions;
  if (filtered) {
    console.log('==== 过滤运行（**不是全量真值**）：仅跑 ' + pickedFiles.join(', '));
    console.log('==== 计数只对本轮选中的 ' + assertions.length + ' 条负责；全量真值见 docs/VERIFY.md ====');
  }
  /* 真实数据**零写入**（E1/E2）：冒烟跑在沙箱副本上 ⇒ 真实 projects/ 必须逐字节不变。
   * 为什么需要它：本项目真出过一次"经 CLI 的写操作落到真实目录"（见 runCli 的注释 ✗）。
   * ⚠️ 上一版把"副本与真实不一致"直接当泄漏 ✗ —— 那多半是**应用在跑动中更新了自己那份副本**
   *（`comnet/.ui-state.json` 每次交互都会变 ✓）：实测三次跑，**真实侧** hash 完全相同、副本侧每次都不同
   * ⇒ 变的只是副本 ✓。现在改成"开跑记真实侧指纹 → 跑完复核"，只有**真实侧**变了才算 ✗。
   * ⚠️⚠️ 上一版**还有一档**是错的（本批改）：真实侧变了就一律判红 —— 而**同机有人正开着这个应用**
   * 是最普通的情形，那个实例会一直写自己的 `.ui-state.json` ⇒ **必然假红**（假红的下场是连真红也不看）。
   * 现在按 skill §G 第 4 条分**三档**（判据与四条正证据写在 `scripts/smoke/real-write-guard.js` 一处）：
   *   ① 本次自己写的（或没有任何"别人写的"证据）⇒ 🚨 判红；② 有"不是本次写的"正证据 ⇒ 响亮**本次没验**
   *   （不计数、不阻断、不计产品缺陷）；③ 真值采不到 ⇒ 判红。
   * 环境准入（**独立探针**，不问产品要结论）：扫真实 `projects/<项目>/.ui-state.json` 的 `uiPid`，看有没有
   * **另一个活着的界面实例** —— 它在写真实目录，那就是本条假红的来源。
   * 【效率批 3 增补 · ⓓ 在册批】CLI/代理**批写者没有界面实例可归因** ⇒ "并行书批每写一次全链就红一次" ✗。
   *   修法 = **登记式归因**（不放宽 ✗）：写者按「先登记后写」把自报登记（pid + 批名 + 时间窗）落进
   *   `projects/.writers/<批id>.json`（登记口 `scripts/register-batch-writer.js`）；复核读登记表，
   *   **窗口内 + 非本进程** ⇒ 归给该批（响亮"本次没验（在册批：<id>）"）；窗口外自动失效 ⇒ 无永久豁免；
   *   pid = 本进程的登记不给免责（自己写 ⇒ 仍红 ✗）；未登记的陌生人写 ⇒ 照旧判红 ✓。 */
  const realWriteGuard = require('./scripts/smoke/real-write-guard.js');
  const REAL_SNAP = new Map();
  const REAL_SNAP_AT = Date.now();          // 复核时间窗的左端（右端在复核那一刻现取）
  let realWriteLeak = null;
  let realWriteUnverified = null;
  let REAL_PROBE = { writers: [], foreignAlive: [], errors: [] };
  const sha12 = (p) => { try { return require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch (e) { return '?'; } };
  /* 批登记目录（效率批 3）：CLI/代理批写者的「先登记后写」台账，是**门禁侧**的豁免账本 ⇒
   * 不算项目数据：不进真实数据指纹（下面 listRealFiles 显式跳过）、gitignore ✗；
   * 登记条目过期自动失效（窗口），判据与四条正证据在 real-write-guard.js 一处 ✓ */
  const WRITERS_DIR = path.join(REAL_PROJECTS_DIR, realWriteGuard.WRITERS_DIR);
  /** 读登记表（IO 在这一处；目录不存在 = 没有在册批，是常态 ✓）。坏文件 text=null ⇒ 守卫记读数不给豁免 */
  const listWriterFiles = () => {
    let names = [];
    try { names = fs.readdirSync(WRITERS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.json$/.test(e.name)).map((e) => e.name); }
    catch (e) { return []; }
    return names.map((n) => ({ id: n.slice(0, -5), text: (() => {
      try { return fs.readFileSync(path.join(WRITERS_DIR, n), 'utf8'); } catch (e2) { return null; }
    })() }));
  };
  const listRealFiles = (dir, base, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); const rel = base ? base + "/" + e.name : e.name;
      // 批登记目录是门禁自己的豁免台账（上面 WRITERS_DIR 的注释）⇒ 不进被检面（只跳根下这一处）
      if (!base && e.isDirectory() && e.name === realWriteGuard.WRITERS_DIR) continue;
      if (e.isDirectory()) listRealFiles(p, rel, out); else out.push(rel);
    }
    return out;
  };
  /** 真实目录里某个文件的界面状态（读得到就解析，读不到 ⇒ null；**解析只有一处** = src/ui-state.js） */
  const realUiState = (rel) => {
    const r = uiState.parseState((() => {
      try { return fs.readFileSync(path.join(REAL_PROJECTS_DIR, rel), 'utf8'); } catch (e) { return null; }
    })());
    return r.ok ? r.state : null;
  };
  try {
    if (fs.existsSync(REAL_PROJECTS_DIR)) {
      for (const rel of listRealFiles(REAL_PROJECTS_DIR, '', [])) REAL_SNAP.set(rel, sha12(path.join(REAL_PROJECTS_DIR, rel)));
      console.log('[smoke] 真实数据基线：' + REAL_SNAP.size + ' 个文件已记指纹（跑完复核；变了就是泄漏 ✗）');
      /* 环境准入探针（**独立于产品链路**）：谁在这份真实目录里写界面状态、他还活着吗 */
      const probeEntries = [];
      REAL_SNAP.forEach((v, rel) => {
        if (rel.slice(-uiState.FILE_NAME.length) !== uiState.FILE_NAME) return;
        let text = null;
        try { text = fs.readFileSync(path.join(REAL_PROJECTS_DIR, rel), 'utf8'); } catch (e) { text = null; }
        probeEntries.push({ project: rel.split('/')[0], stateText: text });
      });
      REAL_PROBE = realWriteGuard.probeForeignWriters(probeEntries,
        { ourPid: process.pid, isAlive: uiState.pidAlive });
      console.log('[smoke] 环境探针：真实目录里的界面状态 ' + REAL_PROBE.writers.length + ' 份'
        + (REAL_PROBE.writers.length
          ? '（' + REAL_PROBE.writers.map((w) => w.project + '→pid ' + w.uiPid + (w.alive ? ' 活着' : ' 已退出')
            + (w.foreign ? ' 非本进程' : ' 本进程')).join(' · ') + '）'
          : '（看不出有人在用）')
        + (REAL_PROBE.foreignAlive.length
          ? ' ⇒ ⚠️ **有 ' + REAL_PROBE.foreignAlive.length + ' 个别的实例正活着**（pid='
            + REAL_PROBE.foreignAlive.join(',') + '）：它在写真实目录 ⇒ 本条只能给"本次没验"'
          : ''));
      REAL_PROBE.errors.forEach((x) => console.log('[smoke] 环境探针：' + x));
      /* 在册批（基线侧读数）：有谁按「先登记后写」登记了批写入窗 ⇒ 复核时窗口内的写入归给它。
       * 复核侧会**再读一次**（批可能在本次运行中途才登记 —— 那是"先登记后写"的正常次序 ✓）。 */
      const REG_AT_START = realWriteGuard.parseWriterRegistry(listWriterFiles(),
        { ourPid: process.pid, isAlive: uiState.pidAlive });
      console.log('[smoke] 批登记（projects/' + realWriteGuard.WRITERS_DIR + '/）：'
        + REG_AT_START.batches.length + ' 个在册批'
        + (REG_AT_START.batches.length
          ? '（' + REG_AT_START.batches.map((b) => b.id + ' pid=' + b.pid + (b.expired ? ' 已过期' : '')).join(' · ') + '）'
          : '')
        + (REG_AT_START.errors.length ? '；坏条目 ' + REG_AT_START.errors.length + ' 个（按无效处理 ⇒ 不给豁免）' : ''));
      if (process.env.MM_SMOKE_LEAK_INJECT === '1') {
        // 判别力证明用（只在显式开关下生效 ✓）：故意往**真实**目录写一个文件 ⇒
        // 跑完复核必须打印 ✗ 并让退出码非 0 ✓。它是**本进程**写的（无写入者 pid、时间戳在窗口内）
        // ⇒ 按"本次算"那一档判红，正是这条判据想抓的形状。
        fs.writeFileSync(path.join(REAL_PROJECTS_DIR, '_leak-inject-probe.json'), 'inject');
        console.log('[smoke] （注入）已往真实目录写 _leak-inject-probe.json，用于验证复核确实能红 ✓');
      }
    }
  } catch (e) { console.log('[smoke] 真实数据基线记账失败（不阻断）：' + ((e && e.message) || e)); }
  const results = [];
  const exec = (js) => win.webContents.executeJavaScript(js);
  // 把 CLI 运行器也交给断言：某些断言需要**先造数据**（如"关联笔记"没有界面创建入口，
  // 只能由 AI/CLI 写入）。`runCli` 在冒烟模式下已把项目根指向临时副本
  // （AI_MINDMAP_PROJECTS_DIR），所以断言用它是安全的 —— 绝不碰真实数据。
  const ctx = { exec, win, runCli: (args) => runCli(args) };
  /* 真输入 + 截图证据（`scripts/smoke-input.js` 是唯一实现）：
   * `sendInputEvent` / `capturePage` 都是**主进程** API，而冒烟断言就跑在主进程里
   * （`ctx.exec` 只是主→渲染的桥）⇒ 直接挂在 ctx 上即可，**不需要 IPC 通道**
   * （理由与"非冒烟模式三重不可用"的保证写在该模块文件头 ✓）。
   * 构造失败**不能静默**：真输入域的断言会因缺底座判红（"没跑却看着像通过"是本工程最重的损害类别 ✗）。 */
  try {
    ctx.input = require('./scripts/smoke-input.js').createDriver({
      win: win, exec: exec, isSmoke: isSmoke, root: ROOT, capture: () => captureRetry(win)
    });
    console.log('[smoke] 真输入底座就绪（isSmoke=' + isSmoke + '）：截图落 ' + ctx.input.shotDir);
  } catch (err) {
    ctx.input = null;
    console.log('SMOKE INPUT ERROR — 真输入底座构造失败（真输入域的断言会全红，不许当通过 ✗）：'
      + ((err && err.message) || err));
  }
  /* 兜底守卫（只拦「**真挂死**」）：断言挂起 / 事件循环卡住时进程仍要退得出来 ——
   * 否则整条验证链会永远停在这一步（那时唯一的路只有强杀）。
   *
   * ───────── 不变量：**守卫必须 > 本步预算** ─────────
   * 两者职责不同，不能互相顶替：
   *   · **预算**判「**太慢**」：它是止涨线（唯一定义在 `scripts/verify.js` 的 `STEPS`；G5 现为 450s），
   *     判红时打印读数与差额，指向"哪一步涨了" ⇒ 让人去查根因；
   *   · **守卫**只拦「**真挂死**」：挂死时没有读数、没有报文，只能强杀。
   * 所以守卫**绝不能先于预算触发**：一旦守卫先掐，一次"**其实跑完了、判据全绿、只是机器慢**"的运行
   * 会被报成崩溃，报文里只留 `SMOKE GUARD TIMEOUT — force exit` ✗（看着像渲染层坏了）。
   * 实测（2026-10-13 两次）：G5 用 **304.6s** 跑完、报文里**没有断言失败**（无 FAIL/THREW），
   * 却在 **300s** 被守卫掐红；真因是**全机同时慢 20–30%**（同两次读数：G3 30.8→38.9s、G4 23.8→26.5s）。
   * 反过来的代价是：真挂死会**先被预算报成"太慢"**再被杀 —— 报文用词不够准，但**不会把绿色结果判红**。
   * 两者代价不对等（重跑一整条链 ~6 分钟 vs 报文用词不够准）⇒ 取「守卫 > 预算」。
   * 取值：**G5 预算 540s × 1.22 = 660s**（2026-10-14 由 540s 上调，与 `scripts/verify.js` 的 G5 预算
   * 450s→540s **同批**：R4 界面批新增的域 42 给 G5 净增 ≈40s，而最近 10 条成功链的 G5 是 342–421s
   * ⇒ 旧 450s 预算会在慢日越线；两个数一起调，本不变量（守卫 > 预算）继续成立 ✓）。
   * 【W13 批 · 2026-10-14】**660s→720s**（= 新 G5 预算 600s × 1.2 ⇒ 不变量①继续成立 ✓）：
   *   域 43（界面侧导入入口）给 G5 净增 **36.5s**（上一批 400866ms → 本批 437380ms），
   *   `scripts/verify.js` 的 G5 预算同批 540s→600s（那里的注释有完整实测依据）。两个数必须**同批**动：
   *   只抬预算不抬守卫 ⇒ 守卫会在"预算还没来得及发声"时先强杀（正是当年那两次假红 ✗）。
   * 留 120s 给"预算判定 → 打印 → 退出"这一段 ⇒ 先由预算发声。
   * 不隔离档（逃生口 `MM_SMOKE_NO_ISOLATE=1` / `MM_SMOKE_ISOLATE=0`，**只用于诊断** ✗）**同口径、同值**：
   * 两档共用一个预算（不隔离同样受同一份负载影响），而旧值 140s 连"不隔离跑一次全量"的正常耗时
   * 都容不下 ⇒ 那不是"更快发现挂死"，只是换个姿势误红 ✗。
   * 想验"守卫还活着"（判别力证明，别只信注释）：把下面那个数字临时改成 `5000` 跑一次 `npm run smoke`
   * ⇒ 必须看到 `SMOKE GUARD TIMEOUT — force exit` 且退出码非 0 ✓；改回来再跑必须复绿。
   * 【热度条改版批 · 2026-10-16】**720s→840s**（= 新 G5 预算 700s × 1.2 ⇒ 不变量①继续成立 ✓）：
   *   该批给 G5 净增约 **106s**（439583ms → **545609ms**；含域 40 新增 7 条真鼠标/真帧判据与
   *   同期在飞的域 45），`scripts/verify.js` 的 G5 预算同批 600s→700s（那里的注释有完整实测依据，
   *   并给出余量守卫的读数 600000/545609 = 1.0997 ✗ ⇒ 必须同批抬）。两个数**必须同批**动 ✓。
   * 【R2 期 2 批 · 2026-10-14】**840s→900s**（= 新 G5 预算 750s × 1.2 ⇒ 不变量①继续成立 ✓）：
   *   该批新增冒烟域 46（拖动单个子树/节点 + 菜单溢出修复，5 条断言、内含 3 次真鼠标拖动与
   *   6 次现量），**本批实测** 全链 G5 = **573.4s**（上一版 511.6s ⇒ 净增约 62s），
   *   `scripts/verify.js` 的 G5 预算同批 700s→750s（700000/573400 = **1.22 ✗** ⇒ 必须同批抬；
   *   750000/573400 = **1.308** ✓）。两个数**必须同批**动 ✓。
   * 【保存视图修复批 · 2026-10-14】**900s→960s**（= 新 G5 预算 800s × 1.2 ⇒ 不变量①继续成立 ✓）：
   *   该批给域 46 加了三条断言（己/庚/辛：真鼠标拖动一次 + 两次"等过 `project:disk-changed` 一拍"
   *   + 一次自动合并保存 + 一次经主进程 CLI 的写入），并顺带修掉域 45 乙在全链负载下的假红。
   *   **本批实测**（两轮全量冒烟墙钟 = G5 同一条命令）：**635667ms / 639170ms**
   *   ⇒ `scripts/verify.js` 的 G5 预算同批 750s→800s（750000/639170 = **1.173 ✗** ⇒ 必须同批抬；
   *   800000/639170 = **1.252** ✓）。
   *   ⚠️ 同批还有一条读数，正是本节开头那次假崩的形状：把渲染层临时换回 HEAD 跑全量冒烟
   *   ⇒ **被本守卫在 900s 强杀**，报文只剩 `SMOKE GUARD TIMEOUT — force exit`、**一条判据读数都没留下**
   *   （那次是真跑得慢，不是挂死）⇒ 守卫与预算**必须同批**抬。两个数**必须同批**动 ✓。
   *   ⚠️ 同批第二次现算（依据换成**全链里的真读数**）：该批第一次全链的 G5 = **645600ms**
   *   ⇒ `scripts/verify.js` 的 G5 预算 800s→**820s**（800000/645600 = **1.239 ✗**；
   *   820000/645600 = **1.270** ✓）⇒ 本守卫 **960s→985s**（= 820 × 1.2 ✓）；
   *   合计预算 1100s 不动（各步预算之和 1055s ⇒ 1100/1055 = 1.043 ✓）。
   *   ⚠️ 2026-10-16（**验证成本批 1**）：G5 预算 820s→**830s**（依据本批全链真读数 G5 = **656100ms**
   *   ⇒ 旧值 820000/656100 = **1.2498 < 1.25 ✗** ⇒ 按余量守卫现算到 830s，比值 **1.265** ✓）
   *   ⇒ 本守卫 985s→**996s**（= 830 × 1.2 ⇒ 不变量①「守卫 > 预算」继续成立 ✓）。
   *   ⚠️ 本批**没有加任何冒烟断言**（改的是验证侧：`--for` 选步 / 临时目录唯一化 / 真实数据三档）
   *   ⇒ 那 +15.7s 是**同档负载波动**，不是工作量增长；但余量守卫是机械的 ⇒ 同批现算重算 ✓（判据一条不砍）。
   *   ⚠️ 2026-10-16（**R2 期 4 批**）：G5 预算 960s→**1020s**（依据本批全链真读数 G5 = **816.0s**
   *   ⇒ 旧值 960000/816000 = **1.176 < 1.25 ✗** ⇒ 按余量守卫现算到 1020s，比值 **1.25** ✓；
   *   本批新增冒烟域 49 的 4 条 + 域 46 菜单多一项，816s 里含同机负载成分 ⇒ 就高不就低）
   *   ⇒ 本守卫 996s→**1080s**（= 1020 × 1.059 ⇒ 不变量①「守卫 > 预算」继续成立 ✓）。 */
  const SMOKE_GUARD_MS = 1080000;
  const guard = setTimeout(() => {
    console.log('SMOKE GUARD TIMEOUT — force exit');
    app.exit(1);
  }, SMOKE_GUARD_MS);
  // P1 崩溃仪器：渲染进程一死就**留下遗言**（死因 + 死前正在跑哪条断言）✓
  // 为什么需要它：本机出现过**间歇**的 `THREW: Object has been destroyed` 连锁（含截图失败），
  // 但重跑不复现 ⇒ 只能靠现场留证 ✗（M 轮实测：三次跑都没复现，没有仪器就只能干等 ✓）
  const smokeState = { last: '(尚未开始)' };
  /* 撕裂快照诊断（G5 卡死追查 ✓）——**读数在拷贝那一刻就采好了**，见文件顶部 SMOKE_COPY_CHECK。
   * 目的不变：冒烟用的是真实 projects/ 的**拷贝**；若拷贝**发生在另一个进程正在写该文件时**，
   * 副本就可能拷到半截（assoc 引用 data 里不存在的节点 ⇒ 任何保存都被闸门拒 ⇒ 冒烟卡死 ✗）。
   * 改的只是**采样点**（原来在这里才两侧一起比 ⇒ 那时副本早已被应用自己改过 ✗，实测假红：
   * comnet/.ui-state.json 真实=ed52d1bed2d2 副本=0534b5d67a1a，而真实侧自 10-11 起一个字节没变）。
   * 现在两侧指纹都在 cpSync 返回的同一刻采 ⇒ 报到"不一致"时只可能是**源在拷贝期间被写过**。
   * 判据实现在 scripts/smoke/tear-snapshot.js（纯函数 + 单测，含"这条判据真的会红"的判别力证明）。*/
  if (!SMOKE_COPY_CHECK) {
    console.log('[smoke] 没有沙箱副本目录（本次没走拷贝路径 ✓）');
  } else if (SMOKE_COPY_CHECK.error) {
    // A5 纪律：**采不到真值 = 响亮** —— 这一分支既不算"一致"也不算"不一致"，
    // 措辞必须让人一眼看出"本项未验证"，别被读成"快照没问题" ✗（它只是诊断 ⇒ 不阻断冒烟）。
    console.log('[smoke] ⚠ 快照指纹**未采到**（error: ' + SMOKE_COPY_CHECK.error + '）⇒ 快照一致性'
      + ' **本项未验证**（没有"一致 N / 不一致 M"可报；别把它读成"快照没问题" ✗）');
  } else {
    SMOKE_COPY_CHECK.diffs.forEach((d) => console.log('[smoke] ⚠ 拷贝与真实文件不一致（采样点=拷贝完成那一刻）：'
      + d.rel + ' 真实=' + d.real + ' 副本=' + d.copy));
    console.log('[smoke] 快照一致性（采样点=拷贝完成那一刻）：一致 ' + SMOKE_COPY_CHECK.same
      + ' / 不一致 ' + SMOKE_COPY_CHECK.diff + ' / 真实缺失 ' + SMOKE_COPY_CHECK.only);
  }
  try {
    win.webContents.on('render-process-gone', (_e, d) => {
      console.log('[smoke] ✗ 渲染进程死亡 reason=' + (d && d.reason) + ' exitCode=' + (d && d.exitCode)
        + ' ｜ 死前断言=' + smokeState.last);
    });
    win.webContents.on('unresponsive', () => {
      console.log('[smoke] ⚠ 渲染进程无响应 ｜ 当前断言=' + smokeState.last);
    });
  } catch (e) { console.log('[smoke] 崩溃仪器挂不上：' + ((e && e.message) || e)); }
  // P1 内存探针（默认关闭 ✓）：MM_SMOKE_MEM=1 ⇒ 每个域打印渲染内存增量，用于看漏没漏 ✓
  const memOn = !!process.env.MM_SMOKE_MEM;
  const readMem = async () => {
    if (!memOn) return null;
    try {
      const s = await win.webContents.executeJavaScript('JSON.stringify((performance.memory && {u: performance.memory.usedJSHeapSize, t: performance.memory.totalJSHeapSize}) || {})');
      const o = JSON.parse(s);
      return o && o.u ? Math.round(o.u / 1048576) : null;
    } catch (e) { return null; }
  };
  /* 每域隔离（**默认开** ✓，见文件头 smokeIsolate）：快照**沙箱副本**；每个域开跑前恢复 + 让应用重载项目。
   * 实测结论（2026-10-08，全量跑）：隔离开 = 167/167 · destroyed 0 ✓；隔离关 = 137/167 · destroyed 30 ✗。
   * 上一版把"改默认"的风险写反了：当年担心的"已有断言依赖跨域状态"是真的，但那是**断言的缺陷**——
   * 四条这样的断言已改成"自建前置"（06/09/29/30 域 ✓）⇒ 隔离才能成为默认（正确语义）✓。
   * 用"跑前恢复"而不是"跑后恢复"：后者的插入点在 catch 之后 ✓ 锚点不稳（曾写成把 catch 改 finally ✗ 会吞掉错误记录 ✗✗）。 */
  const isolateOn = smokeIsolate;
  if (!isolateOn && SMOKE_PROJECTS_DIR) console.log('[smoke] 每域隔离：关（逃生口 MM_SMOKE_NO_ISOLATE / MM_SMOKE_ISOLATE=0）—— 跨域状态会互相污染，只在诊断时用 ✗');
  const sandboxSnap = new Map();
  const walkFiles = (dir, base, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); const rel = base ? base + "/" + e.name : e.name;
      if (e.isDirectory()) walkFiles(p, rel, out); else out.push(rel);
    }
    return out;
  };
  if (isolateOn) {
    try {
      for (const rel of walkFiles(SMOKE_PROJECTS_DIR, "", [])) {
        if (rel.endsWith(".ui-state.json")) continue;   // 界面状态旁挂 ⇒ 每域都变 ⇒ 纳入就必然拖慢（实测 36 次还原 ✗）
        sandboxSnap.set(rel, fs.readFileSync(path.join(SMOKE_PROJECTS_DIR, rel)));
      }
      console.log("[smoke] 每域隔离已开启：快照沙箱文件 " + sandboxSnap.size + " 个");
    } catch (e) { console.log("[smoke] 隔离快照失败：" + ((e && e.message) || e)); }
  }
  const smokeIsolateState = { lastDomain: null };
  /** 每个**留下过模态**的域（name → 它开了哪几个）：谁制造的、谁才是要修的那个域 ✓
   *  为什么不在"发现残留时"就报当前域：真正闯祸的是**上一个域**（它自己跑绿了），
   *  当前域只是踩到的人。只报当前域 ⇒ 下一轮又从头找一遍（本工程吃过这个亏：
   *  域 08 把审计面板开着留给域 25，域 25 的报文里看不出跟 08 有关 ✗）。 */
  const modalCulprit = new Map();
  /** 域开始的**干净前置**（`MMApp.closeAllDialogs`，见 app-actions.js 的说明）：
   *  ① 把上一个域留下的模态/浮层收干净（走产品自己的关闭路径 ✓ 不新发明一套）；
   *  ② **把"本来开着哪些"返回给调用方** ⇒ 残留不是被静默抹掉，而是被点名叫出来 ✓；
   *  ③ 收不回来不算异常：**采不到真值 = 红**，由调用方处理（这里只保证"尽力收干净"）。 */
  const resetDomainDialogs = async () => {
    try {
      const shown = await exec('(function () { return (window.MMApp && window.MMApp.closeAllDialogs)'
        + ' ? window.MMApp.closeAllDialogs() : []; })()');
      return Array.isArray(shown) ? shown : [];
    } catch (e) {
      return null;   // 渲染层没起来 / 窗口没了 ⇒ 调用方按"采不到"处理（不假装干净 ✓）
    }
  };
  const isolateDomain = async () => {
    if (!isolateOn || !sandboxSnap.size) return;
    let n = 0;
    for (const [rel, buf] of sandboxSnap) {
      try {
        const p = path.join(SMOKE_PROJECTS_DIR, rel);
        let cur = null; try { cur = fs.readFileSync(p); } catch (e2) { cur = null; }
        if (!cur || !cur.equals(buf)) { fs.writeFileSync(p, buf); n++; }
      } catch (e2) { /* 单个文件失败不阻断 ✓ */ }
    }
    // 光恢复磁盘不够 ✗：应用内存里那份还是旧的 ⇒ 让它自己重新加载当前项目 ✓
    try {
      if (!n) return;   // 项目数据没动过 ⇒ 不用重载 ✓
      const reloadP = win.webContents.executeJavaScript('(async function () { try { var st = window.MMApp && window.MMApp.getState && window.MMApp.getState(); var name = st && st.project && st.project.name; if (!name) return "noproj"; if (window.MMApp.openProject) { await window.MMApp.openProject(name); return "ok"; } if (window.MMApp.switchProject) { await window.MMApp.switchProject(name); return "ok2"; } return "noapi"; } catch (e) { return "err:" + ((e && e.message) || e); } })()');
      // 超时兜底：上一版直接 await 这个 Promise ⇒ 整条链卡在某个域 ✗（守卫生效时强杀 ✓）
      // 守卫的取值**只写在上面冒烟守卫那一处**（`SMOKE_GUARD_MS`），这里不抄数字。
      const raced = await Promise.race([
        reloadP.then(() => 'done').catch(() => 'err'),
        new Promise((res) => setTimeout(() => res('timeout'), 1500))
      ]);
      if (raced === 'timeout') console.log('[smoke] 隔离：重载超时（照常继续，不阻塞链 ✓）');
    } catch (e) { /* 窗口没了就跳过 ✓ 别让隔离本身变成新的失败源 ✗ */ }
    if (n) console.log("[smoke] 隔离：已还原 " + n + " 个沙箱文件");
  };
  for (const a of assertions) {
    smokeState.last = a.name;
    /* 域边界 = 干净前置。**过滤运行照样要做** —— 每域隔离（isolateDomain）在过滤运行下
     * 是关的（隔离关 = 跨域状态会互相污染，正是 MM_SMOKE_NO_ISOLATE 记的那件事），
     * 而 DOM 模态本来就不在"还原沙箱文件"的范围内 ⇒ 只靠隔离收不掉它 ✗。 */
    if (a.__domain !== smokeIsolateState.lastDomain) {
      await isolateDomain();   // **域变了才隔离**（域内顺序不受影响 ✓）
      const leftOpen = await resetDomainDialogs();
      if (leftOpen && leftOpen.length) {
        // 记住"是谁留的"：若有域已经留过**同样名字**的模态，锅记在它身上更准（本轮实测过两次）
        const prior = smokeIsolateState.lastDomain && modalCulprit.get(smokeIsolateState.lastDomain);
        const names = leftOpen.map((d) => d.name).filter(Boolean);
        const culprit = (prior && names.some((n) => prior.indexOf(n) >= 0))
          ? smokeIsolateState.lastDomain
          : (smokeIsolateState.lastDomain || '（上一个域）');
        if (!modalCulprit.has(culprit)) modalCulprit.set(culprit, []);
        names.forEach((n) => { if (modalCulprit.get(culprit).indexOf(n) < 0) modalCulprit.get(culprit).push(n); });
        console.log('[smoke] ⚠ 域开始的干净前置：收掉了 ' + JSON.stringify(names)
          + ' —— 这是域 ' + culprit + ' 留下的残留模态（它自己跑绿了 ✗）');
        // **框架级判据**：域开始时有残留模态 ⇒ 该域直接红，并**点名是哪个域留下的** ✓。
        // 为什么是红而不是"收干净就算"：残留会**掩盖真实缺陷**（真输入域会整片假红、
        // 而判据被骗成绿的域更危险：它看着通过、实际什么都没验 ✗）。
        // 为什么这条判据只在这里、不用注入：残留本身就是**真缺陷**，不需要人工注入才会出现
        // （实测：域 16 的 addNode 留下的编辑框让域 36/37 连锁红 11 条）。
        results.push({
          name: '域开始的干净前置：域 ' + a.__domain + ' 开始时**没有**残留模态/浮层'
            + '（残留 = 上位域没收拾干净 ⇒ 本域判红并点名，不替别人擦桌子）',
          ok: false,
          text: '残留=' + JSON.stringify(leftOpen) + ' ← **由 ' + culprit + ' 留下**；'
            + '本域先做干净前置再跑断言（否则本域的命中测试/真输入会打到残留浮层上 ⇒ 假红一片 ✗）。'
            + '修法：让留下它的那个域**自己收尾**（或让它调 `window.MMApp.closeAllDialogs()`）'
        });
      }
      smokeIsolateState.lastDomain = a.__domain;
    }
    const memBefore = await readMem();
    // 仪器自检开关（只为证明"仪器确实能留下遗言" ✓ 不影响正常跑）：
    //   MM_SMOKE_CRASH=<第几条> ⇒ 跑到那一条之前**人为把渲染进程打掉** ⇒ 日志必须出现
    //   `[smoke] ✗ 渲染进程死亡 reason=… ｜ 死前断言=<名字>` ✓（判别力证明：这条仪器不是摆设 ✓）
    if (process.env.MM_SMOKE_CRASH && results.length === Number(process.env.MM_SMOKE_CRASH)) {
      console.log('[smoke] （自检）人为杀掉渲染进程，用于验证崩溃仪器');
      try { win.webContents.forcefullyCrashRenderer(); } catch (e) { /* 忽略 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    try {
      const r = await a.run(ctx);
      /* 三态（2026-10-12 加，见 `scripts/smoke-assertions.js` 的 `tally()` 与域 39 的剪贴板判据）：
       * `unverified` 是**可选的第三态** —— "环境坏了、真值采不到"时由断言自己给出原因串。
       * ⚠️ **fail-safe**：它只许出现在 `ok:true` 的结果上；一条结果既报"未验证"又报失败时**按失败计**，
       * 并把矛盾**响亮**打出来 —— 否则"未验证"就成了掩盖真失败的后门（本工程最重的损害类别 ✗）。 */
      let unv = (r && typeof r === 'object' && typeof r.unverified === 'string' && r.unverified)
        ? r.unverified : null;
      if (unv && !r.ok) {
        console.log('[smoke] ⚠ 断言同时报"未验证"与"失败" ⇒ **按失败计**（未验证不许掩盖真失败）：'
          + a.name + ' ｜ ' + unv);
        unv = null;
      }
      results.push({ name: a.name, ok: !!r.ok, text: String(r.text || ''), unverified: unv });
      if (memOn) {
        const memAfter = await readMem();
        if (memBefore !== null || memAfter !== null) {
          console.log('[mem] ' + a.name.slice(0, 34) + ' ｜ 域前=' + memBefore + 'MB 域后=' + memAfter + 'MB ｜ 增量=' + ((memAfter !== null && memBefore !== null) ? (memAfter - memBefore) : '?') + 'MB');
        }
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 这条**必须**带上"是哪条断言"：窗口一死，后面的断言会连锁报 destroyed，
      // 只看消息分不清"谁先死"✗（实测就是靠这一点才定位到域 29 ✓）
      results.push({ name: a.name, ok: false,
        text: 'THREW: ' + msg + (/destroyed/.test(msg) ? '（渲染进程/窗口已销毁 ⇒ 见 [smoke] 死亡行）' : '') });
    }
  }
  // 冒烟断言的条数**到此为止** —— 后面追加的"取景记录/视觉断言"不是冒烟断言，
  // 不能混进这个数字（否则 `docs/VERIFY.md` 的冒烟真值会与运行输出对不上）。
  const smokeCount = results.length;
  /* 三态读数（**通过 / 总数 / 未验证**）：`total` **不含**未验证 ⇒ 环境坏掉的那条"从总条数里分出去"。
   * ⚠️ `smokeCount`（跑过的断言**槽位数**）与 `smokeT.total`（这一轮**真的判过**的条数）的差别是
   * **有意的**：前者与 `docs/VERIFY.md` 的冒烟真值（`scripts/smoke-assertions.js` 的 `.length`）同口径，
   * 后者才是"这一轮验了多少条"。两个数都打印，别拿一个替代另一个（`B1`：计数口径一处定义 = `tally()`）。 */
  const tally = allAssertions.tally;
  const smokeT = tally(results);
  /* 严格档读数：**同一个 `tally()`**，只是换一档口径（开关关着时直接复用上面那份，不再算一遍）——
   * 未验证在这一档进 `failed`，于是也进 `total`：默认档那个"两个数都不进"的口子在严格档里被关掉 ✓。
   * 两档都由 `tally()` 算（`B1` 计数口径一处定义），这里**不许**自己再数一份 ✗。 */
  const smokeStrict = strictOn ? tally(results, { strict: true }) : smokeT;
  let visionStart = -1;   // 视觉断言在 results 里的起始下标（-1 = 没跑）
  // 截图（工程根 smoke-shot.png）+ 落一份**旁路取景记录** smoke-frame.json。
  // 顺序不可交换：先做取景准备（展开全树/禁过渡/清状态栏/等 ≥2 帧），再截图 —— 见 prepareCapture。
  //
  // ⚠️ **非确定性产物**（生成器就是这一段）：`smoke-shot.png` 与 `smoke-frame.json` 是**本次运行的
  //    取景证据**（分辨率 / 字节 / sha256 / 像素统计）—— **不得当真值**读：换一次运行像素统计就变，
  //    差异来源属于「渲染取景」那一类（逐类的"为什么可以不确定"见 `scripts/determinism-check.js --list`）。
  //    它**能**当真值用的那一半是"这份读图结论绑的是哪一张帧"（`scripts/vision/record.js` 用 sha256 绑，
  //    不一致就拒绝写）—— 而"同一状态连续两帧逐字节相同"这条判定**目前不存在**，在门禁 **S3** 的
  //    欠账册里：`node scripts/determinism-check.js --debt`。
  // 过滤运行时**不做**这段：截图（prepareCapture + capturePage）、取景记录、视觉断言（L2）
  // —— 它们只对"全量运行"有意义（真值口径见 docs/VERIFY.md），跳过还能省掉一次 GPU 合成。
  if (filtered) console.log('==== 过滤运行：跳过截图 / 取景记录 / 视觉断言 ====');
  if (!filtered) try {
    await prepareCapture(win);
    const img = await captureRetry(win);
    const png = img.toPNG();
    fs.writeFileSync(path.join(ROOT, 'smoke-shot.png'), png);
    // 取景记录：分辨率 / 字节 / sha256 / 像素统计。
    // 分辨率与 sha256 是判定阶梯 L0 要的两项；统计量是 L1 的输入（阶梯见 docs/ARCHITECTURE.md §4b）。
    // 记不下来必须**响亮入结果**（纪律：采不到真值不能静默放过）。
    try {
      const crypto = require('crypto');
      const vision = require('./scripts/vision/frame-stats.js');
      const size = img.getSize();
      const frame = {
        width: size.width, height: size.height, bytes: png.length,
        sha256: crypto.createHash('sha256').update(png).digest('hex'),
        stats: vision.analyzeFrame(img),
        // 断言计数也落进来：读图留痕（阶段 4）要引用"这次是哪些断言跑出来的画面"，
        // 而这两个数字**机器可读**地留在这里，读图记录就不必手写任何数字（"易腐事实不手写"）。
        smokeAssertions: smokeCount,
        // 「未验证」的条数（三态里的第三档，口径见 `scripts/smoke-assertions.js` 的 `tally()`）：
        // 它落进取景记录是为了**机器可读地**说清"这 219 个槽位里有多少条这一轮没判"，
        // 免得下游把槽位数误读成"都验过了"（同理见 `docs/VERIFY.md` 的冒烟真值口径）。
        smokeUnverified: smokeT.unverified,
        // 视觉断言用 `ROIS.length`（**计划数 ≡ 实际数**：`roi.run()` 的返回条数恒等于清单长度，
        // 这是该模块的契约 —— 所以这里不需要等它跑完，也不存在"计划与实跑不符"的窗口）。
        visionAssertions: require('./scripts/vision/roi-assertions.js').ROIS.length
      };
      fs.writeFileSync(path.join(ROOT, 'smoke-frame.json'), JSON.stringify(frame, null, 2) + '\n');
    } catch (e2) {
      results.push({ name: '取景记录 smoke-frame.json', ok: false, text: 'frame record failed: ' + e2.message });
    }
    // L2 关键区域断言（视觉断言）：**复用本次已截好的帧**，不再截第二次。
    // 这样既满足「先行为、后画面」的顺序要求，又**不新增 Electron 启动、零额外墙钟**
    // —— 冒烟已占全链约 80%，再加一次启动不可接受。条数由 ROI 清单决定（见该模块）。
    try {
      const roi = require('./scripts/vision/roi-assertions.js');
      const rs = await roi.run({ exec, img });
      visionStart = results.length;
      for (const r of rs) results.push(r);
    } catch (e3) {
      results.push({ name: '视觉断言 L2（关键区域）', ok: false, text: 'THREW: ' + (e3 && e3.message) });
    }
  } catch (err) {
    results.push({ name: 'screenshot', ok: false, text: 'capture failed: ' + err.message });
  }
  clearTimeout(guard);
  /* 真实数据零写入：跑完复核真实侧，**按三档归因**（判据在 scripts/smoke/real-write-guard.js 一处）。
   * 逐文件的正证据：写入者 pid（`.ui-state.json` 的 `uiPid`）/ 时间戳落在本次运行窗口之外 /
   * 在册批的时间窗（projects/.writers/，效率批 3 增补 ⓓ）。
   * 采不到真值（复核自己失败）⇒ 判红 ✓（不许把"没验"报成"通过"）。 */
  try {
    if (fs.existsSync(REAL_PROJECTS_DIR)) {
      const now = listRealFiles(REAL_PROJECTS_DIR, '', []);
      const changes = [];
      const seen = new Set();
      for (const rel of now) {
        seen.add(rel);
        const h = sha12(path.join(REAL_PROJECTS_DIR, rel));
        if (!REAL_SNAP.has(rel)) changes.push({ rel, kind: 'added' });
        else if (REAL_SNAP.get(rel) !== h) changes.push({ rel, kind: 'changed' });
      }
      for (const rel of REAL_SNAP.keys()) if (!seen.has(rel)) changes.push({ rel, kind: 'removed' });
      // 逐文件补正证据（只在真的变了的时候才去读，省掉 45 份文件的无谓读取）
      for (const c of changes) {
        let st = null;
        try { st = fs.statSync(path.join(REAL_PROJECTS_DIR, c.rel)); } catch (e) { st = null; }
        c.mtimeMs = st ? st.mtimeMs : null;
        if (c.rel.slice(-uiState.FILE_NAME.length) === uiState.FILE_NAME) {
          const s = realUiState(c.rel);
          if (s) {
            c.writerPid = s.uiPid;
            c.stampMs = Date.parse(s.updatedAt) || null;   // 写者自己记的时刻（比 mtime 更准）
          }
        }
      }
      // 在册批（复核侧**再读一次**：批可能在本次运行中途才登记 —— 先登记后写的正常次序 ✓）
      const registry = realWriteGuard.parseWriterRegistry(listWriterFiles(),
        { ourPid: process.pid, isAlive: uiState.pidAlive });
      const verdict = realWriteGuard.classifyRealWrites(changes, {
        ourPid: process.pid,
        windowStartMs: REAL_SNAP_AT,
        windowEndMs: Date.now(),
        othersAlive: REAL_PROBE.foreignAlive,
        registeredBatches: registry.batches,
        probeError: null
      });
      for (const line of realWriteGuard.summaryLines(verdict, { probe: REAL_PROBE, registry: registry })) {
        console.log('[smoke] ' + line);
      }
      if (verdict.verdict === 'leak') {
        realWriteLeak = { changes: verdict.items.filter((i) => i.verdict === 'leak').map((i) => i.rel) };
        console.log('[smoke] ✗ 真实数据被动过（冒烟必须零写入！）：'
          + realWriteLeak.changes.join(',') + ' ⇒ 退出码非 0 ✓');
      } else if (verdict.verdict === 'unverified') {
        // **第三档**：环境有他人写入 ⇒ 不判红、不计数、不阻断；但必须响亮（"没验"不许读成"通过"）
        realWriteUnverified = verdict;
      }
    }
  } catch (e) {
    realWriteLeak = { error: String((e && e.message) || e) };
    console.log('[smoke] ✗ 真实数据复核失败（采不到真值 ⇒ 不能自称已校验 ✗）：' + realWriteLeak.error);
  }
  const failed = results.filter((r) => !r.ok);   // 未验证那几条是 ok:true ⇒ 不进这里（口径见 tally() 的 fail-safe）
  // 输出**显式给出构成**：冒烟断言 / 视觉断言 / 取景记录 分开报。
  // 为什么必须分开：`docs/VERIFY.md` 的"冒烟断言"真值就是 `scripts/smoke-assertions.js` 的条数，
  // 若把视觉断言混进总数，运行输出会与文档真值对不上（这条数字对不上正是 G6 要防的）。
  const part = (from, to) => {
    // 计数口径**只有一处**：`tally()`（未验证不进分子分母 —— 它既不通过也不算失败）
    const seg = tally(results.slice(from, to));
    return seg.passed + '/' + seg.total;
  };
  const visionFrom = visionStart < 0 ? results.length : visionStart;
  console.log('\n==== SMOKE RESULTS ====');
  results.forEach((r) => {
    console.log('[' + (r.unverified ? '未验证' : (r.ok ? 'PASS' : 'FAIL')) + '] ' + r.name + ' :: ' + r.text);
    // 「未验证」**必须响亮**：形状照第八批"快照指纹没采到"那一档 —— 既不打 PASS 也不打 FAIL，
    // 单独一行说清"本项未验证 + 为什么"，免得被读成"这条没问题"（比不打更危险的是**打错**）。
    if (r.unverified) console.log('[smoke] ' + r.unverified);
    /* 严格档：上面那句"不计入通过/失败计数、不阻断"是**默认档**的口径 ⇒ 这里必须当场改口，
     * 否则报文会自相矛盾（读的人会以为这条真的没进失败）。**如实打印与点名原因一个字都不少** ✓，
     * 变的只是"它算不算失败"（这条判据的存在意义就是这个）。 */
    if (r.unverified && strictOn) {
      console.log('[smoke] ⚠ **严格档**（MM_SMOKE_CLIP_STRICT 已开）：上面这条"未验证"**按失败计**'
        + '（进失败计数、进总数、并让 exit code ≠ 0）；上一行那句"不计入总数、不阻断"是**默认档**的口径。'
        + '环境坏时宁可红，不许悄悄放过 ✓');
    }
  });
  const head = filtered ? '==== 过滤运行 ' : '==== ';
  console.log(head + part(0, smokeCount) + ' passed ====');
  /* 三态**同时在汇总行里可见**（通过 / 总数 / 未验证，三个数都贴）——
   * 只报"通过/总数"时，"环境坏了没判"会被读成"少了点东西"甚至"都通过了" ✗。
   * ⚠️ `total` **不含**未验证（= 通过 + 失败）；它与 `smokeCount`（跑过的**槽位数**，与
   * `docs/VERIFY.md` 的冒烟真值同口径）是两个不同的读数，别互相替代（口径一处 = `tally()`）。 */
  console.log('==== 冒烟三态：通过 ' + smokeT.passed + ' / 总数 ' + smokeT.total
    + ' ｜ 未验证 ' + smokeT.unverified + '（'
    + (smokeT.unverified
      ? '不计入前两个数、也不阻断（exit code 不看它）；理由见上面的 `[smoke]` 行'
      : '一条也没有')
    + '）====');
  /* 严格档的**第二行读数**（开关关着时一行都不打 ⇒ 与加它之前逐字节相同 ✓）：
   * 它把"未验证"从"既不算通过也不算失败"改成"算失败"，所以两个数都会变 —— 必须**同批打出来**，
   * 否则读的人会拿默认档的"通过/总数"去解释一个非 0 的退出码（那是同一份输出的两种说法 ✗）。 */
  if (strictOn) {
    console.log('==== 严格档（MM_SMOKE_CLIP_STRICT 开）：未验证按失败计 ⇒ 通过 ' + smokeStrict.passed
      + ' / 总数 ' + smokeStrict.total + '（总数**含**那 ' + smokeStrict.unverified + ' 条未验证）'
      + (smokeStrict.unverified
        ? ' ｜ 本轮"未验证"不再享受默认档的豁免 ⇒ exit code = 1 ✓'
        : ' ｜ 本轮没有"未验证"项 ⇒ 与默认档读数一致 ✓')
      + ' ====');
  }
  console.log('==== 视觉断言（L2 关键区域）: ' + part(visionFrom, results.length) + ' passed ====');
  if (results.length > smokeCount) {
    console.log('==== 另有 ' + (results.length - smokeCount) + ' 条非冒烟结果（取景记录 + 视觉断言），不计入冒烟断言数 ====');
  }
  /* 收尾读数：临时项目目录清掉了几个 / 还剩几个（见文件头 cleanupSmokeTemp 的说明）。
   * 为什么**在这里显式跑一次**而不是只挂退出钩子：`app.exit()` 不触发 `will-quit`，而这一行是
   * "读数可见"的唯一机会 —— 退出钩子里再清一次是**兜底**（它没法回报读数）。
   * ⚠️ 实测：这一档**清不掉**（EPERM，见上面的读数）⇒ 残留的那个空壳由**下一轮启动的
   * `sweepSmokeHusks()`** 收掉；本读数的作用是把"每跑留一个空壳"从静默变成看得见 ✓。
   * ⚠️ 本读数**不并入 exit code**：清不掉多半是外部占用（杀毒/索引/另一个冒烟进程），
   * 并进去等于给环境造一个新的假红源；但它**必须响亮**，否则还是没人看得见 ✗。 */
  const tempSweep = cleanupSmokeTemp();
  console.log('[smoke] 临时项目目录收尾：' + (tempSweep.ok
    ? '已清掉 ' + (SMOKE_PROJECTS_DIR ? '1 个（第 ' + tempSweep.attempts + ' 次尝试时成功）' : '0 个（非冒烟模式）')
      + ' · 剩余 0'
    : '⚠️ **没清干净**：剩余 ' + tempSweep.left + ' 条 ' + JSON.stringify(tempSweep.names || [])
      + '（' + (tempSweep.code ? '最后错误=' + tempSweep.code : '无异常，但目录还在')
      + '）｜ 每次尝试的读数=' + JSON.stringify(tempSweep.trace || [])
      + ' ｜ ' + SMOKE_PROJECTS_DIR
      + ' ⇒ 这就是"每跑一次在 %TEMP% 留一个空壳"的现象；读数已如实打印（既不当 PASS 也不当 FAIL）'));
  /* 「真实数据零写入」那一档的**汇总行**（三态要同时可见：通过 / 未验证 / 真缺陷 ——
   * 只打印"跑了什么"时，"没验"会被读成"过了" ✗）。第二档**不进退出码**：红的是环境不是产品，
   * 长期挂红会让读者连真红也不看（skill §G 第 4 条）；但它必须响亮 ✓。 */
  if (realWriteUnverified) {
    const regIds = realWriteUnverified.registryIds || [];
    console.log('[smoke] ⚠️ 真实数据零写入：**本次没验'
      + (regIds.length ? '（在册批：' + regIds.join('、') + '）' : '（环境有他人写入）')
      + '** —— 不参与计数、不阻断退出码、也不计成产品缺陷；要它变绿：'
      + (regIds.length
        ? '等在册批过期/结束、且同机没有界面实例在写，再跑一次 ✓'
        : '先关掉同机正在使用本应用的实例，再跑一次 ✓'));
  }
  /* 退出码 = 三样：真失败的断言 · 真实数据被动过 · **严格档下被计成失败的"未验证"**。
   * ⚠️ 开关关着时这一项恒为 0（短路）⇒ 退出码与加它之前完全一致 ✓；数量由 `tally()` 的严格档读数给，
   * 这里不自己数（`B1`）。 */
  const strictFailures = strictOn ? smokeStrict.failed : 0;
  app.exit((failed.length || realWriteLeak || strictFailures) ? 1 : 0);   // 真实数据被动过 ⇒ 即便断言全绿也判红 ✓
}

/* ---------------- 离屏导出 PNG（--export-image <项目> <输出.png>） ----------------
 * 加载 → 打开项目 → 展开全树 → 等渲染稳定 → capturePage → 保存 → 退出。
 * headless 可测（AI 迭代验证用），也是 UI「导出 PNG」的 CLI 形态。
 */
async function runExportImage(win, { project, out }) {
  const guard = setTimeout(() => { console.log('EXPORT-IMAGE GUARD TIMEOUT'); app.exit(1); }, 90000);
  try {
    await win.webContents.executeJavaScript(
      `(async () => {
        const ok = await window.MMApp.openProject(${JSON.stringify(project)});
        if (!ok) throw new Error('openProject failed: ' + ${JSON.stringify(project)});
        const jm = window.MMApp.getState().jm;
        if (jm) jm.expand_to_depth(999);
        await new Promise(r => setTimeout(r, 1500));
      })()`
    );
    const img = await captureRetry(win);
    fs.writeFileSync(out, img.toPNG());
    clearTimeout(guard);
    console.log('已导出图片: ' + out);
    app.exit(0);
  } catch (err) {
    clearTimeout(guard);
    console.log('EXPORT-IMAGE FAILED: ' + ((err && err.stack) || err));
    app.exit(1);
  }
}

/* ---------------- 整窗截图（--export-window <输出.png>） ----------------
 * 分别截「主页面」与「原生侧栏 view」，再按侧栏真实 bounds 贴回去 —— 尺寸取**窗口内容实际大小**
 * （自适应，不写死分辨率）。侧栏不在主页面的 capturePage 里，这是唯一能看到它的离线方式。
 */
async function runExportWindow(win, { out }) {
  const guard = setTimeout(() => { console.log('EXPORT-WINDOW GUARD TIMEOUT'); app.exit(1); }, 90000);
  try {
    // 侧栏可能还在启动：**重试到真正截到图**为止（只等 bounds 不够 —— view 建出来时页面还没画完，
    // capturePage 会拿到空图/抛错，于是合出来还是没有侧栏）。拿不到就只出主页面，不算失败。
    let b = null;
    let sbImg = null;
    for (let i = 0; i < 40; i++) {
      b = dshSidebar.viewBounds();
      sbImg = await dshSidebar.captureView();
      if (b && b.width > 0 && sbImg && sbImg.getSize().width > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 800));   // 让侧栏页面自己也画一帧
    const { nativeImage } = require('electron');
    const { composeWindowShot } = require('./scripts/vision/window-shot.js');
    const pageImg = await win.webContents.capturePage();
    const size = pageImg.getSize();
    const base = { width: size.width, height: size.height, pixels: pageImg.getBitmap() };
    let composed = base;
    if (sbImg && b && b.width > 0) {
      const sbSize = sbImg.getSize();
      // 位图可能按 devicePixelRatio 放大 ⇒ 用"位图宽 ÷ 窗口内容宽"还原比例（自适应）
      const scale = size.width / win.getContentBounds().width;
      composed = composeWindowShot(base, { width: sbSize.width, height: sbSize.height, pixels: sbImg.getBitmap() },
        { x: Math.round(b.x * scale), y: Math.round(b.y * scale) });
    }
    fs.writeFileSync(out, nativeImage.createFromBitmap(Buffer.from(composed.pixels), {
      width: composed.width, height: composed.height
    }).toPNG());
    console.log('[export-window] 已写出 ' + out + '  ' + composed.width + '×' + composed.height
      + '（侧栏 ' + (sbImg ? (b.width + '×' + b.height + ' @x=' + b.x) : '未进来') + '）');
  } catch (err) {
    console.log('[export-window] 失败: ' + ((err && err.stack) || err));
  }
  clearTimeout(guard);
  app.exit(0);   // 用 exit 而不是 quit：**不触发收割**，驻留服务与侧栏对话保持存活
}

/* ---------------- 界面控制通道（给外部 AI / 内置 DSH） ----------------
 * 协议与取舍见 `src/control.js`（文件 + 轮询：本机受限环境禁命名管道、网络要走代理，
 * 文件是唯一到处都成立的通道；**多槽 + 序号** = 并发的两条命令各有各的回执）。
 * 执行**一次**：`pollOnce` 先 `claim()`（rename 只有一个赢家）再执行 ⇒ 同一条命令不会因为
 * "异步还没干完"被 400ms 轮询**重复派发**（批 1 报告 ⑦-2 的另一半）。
 *
 * ⚠️ 事实核对（写进这里的理由：导图页**能被卸载**之后，"轮询在谁身上"变成了关键问题）：
 *   这个 400ms 的轮询跑在**主进程**（本函数在 app.whenReady 里被调用），**不在渲染层** ⇒
 *   导图页被卸载（主窗口只剩占位页）期间，通道**照常工作**：`dsh-status`（只读诊断）、
 *   `sidebar-only on/off`、`dsh-sidebar on/off` 都不受影响 ✓。受影响的是"发给导图页渲染层"
 *   的东西（菜单 `menu:*` 那一批）⇒ 那个由菜单项的启用状态挡住（见 setMapPageMenuEnabled）。
 *   （README 那句"界面每 400ms 轮询一次"说的就是本函数 —— "界面"= 应用主进程，不是渲染层 ✓）
 */
function startControlChannel() {
  const control = require('./src/control.js');
  const { createControlPoller } = require('./src/control-poll.js');
  let dir;
  try { dir = app.getPath('userData'); } catch (err) { return; }

  /** 一条命令的处理（**不许在这里 throw 出去**：poller 会把同步异常翻成失败回执，
   *  但那样调用方拿到的是"命令执行异常"而不是这条命令**自己**的原因） */
  const handle = (claim, reply) => {
    const cmd = claim;
    // 五个命令（前两个是"各关一半"的对称能力，第三个是**只读**诊断）：
    //   dsh-only    —— 关左边思维导图页（**真卸载这一页**：主窗口改为占位页）、只留侧栏
    //                  （改主界面代码时用；重开 = 重新加载 ⇒ sidebar-only on/off 成对）
    //   dsh-sidebar —— 保留主界面、关掉侧栏 DSH（改 DSH 那一侧时用；把服务一起停 + 销毁侧栏视图）
    //   dsh-status  —— 只读：读侧栏实况（可见性/总占宽/窄宽模式/是否横向溢出/视图在不在）
    //   dsh-prefill —— 把文本送进侧栏输入框（⑩；**不代替用户发送** ✗）
    if (cmd.cmd === 'dsh-prefill') {
      return prefillAfterEnsureOpen(cmd.text || '').then((r) => {
        reply({ cmd: 'dsh-prefill', ok: !!r.ok, result: r, err: r.reason || null });
      });
    }
    if (cmd.cmd === 'dsh-status') {
      let st = null;
      let detail = '';
      try {
        const s = dshSidebar.getStatus();
        // ⚠️ 白名单输出：**绝不带 url/token**（那是只在主进程内存里的东西 ✗）
        st = {
          status: s.status, visible: s.visible, error: s.error || null,
          width: s.width, actualWidth: s.actualWidth, narrow: s.narrow || null,
          narrowSkip: s.narrowSkip || null,
          // 内核右栏 ⇄ 侧栏自动加宽（用户要求）的实况
          rightbarOpen: !!s.rightbarOpen, autoWide: s.autoWide || null,
          rightbarWatcher: s.rightbarWatcher || null,
          // 「真关」的判据（v0.19）：**视图在不在**、导图页是不是已被卸载 —— 断言/诊断别靠猜 ✓
          hasView: !!s.hasView, viewId: (typeof s.viewId === 'number' ? s.viewId : null),
          viewEpoch: s.viewEpoch || 0,
          mapPageClosed: !!s.mapPageClosed, lastProject: s.lastProject || null
        };
      } catch (err) {
        detail = String((err && err.message) || err);
      }
      reply({ cmd: 'dsh-status', ok: !!st, status: st, err: detail });
      return;
    }
    // dsh-only：**关导图页 = 真卸载这一页**（v0.19；旧语义只是给它加个类名、页面还在内存里 ✗）
    //   `confirmed:false` ⇒ 主进程自己查一次渲染层的脏标记：脏就**如实拒绝**（AI 这条路上
    //   不弹模态框 —— 没人保证有人在看，弹窗会把调用方挂死 ✗）。
    // dsh-sidebar：保留主界面、关掉侧栏 DSH（语义不变）。
    if (cmd.cmd === 'dsh-only') {
      const done = cmd.on
        ? dshSidebar.closeMapPage({ confirmed: false, by: 'cli' })
        : dshSidebar.openMapPage();
      Promise.resolve(done).then((r) => {
        reply({
          cmd: 'dsh-only', ok: !!(r && r.ok),
          state: (r && r.ok) ? dshSidebar.isDshOnly() : null,
          err: (r && r.reason) || null
        });
      }).catch((err) => {
        reply({ cmd: 'dsh-only', ok: false, state: null, err: String((err && err.message) || err) });
      });
      return;
    }
    if (cmd.cmd !== 'dsh-sidebar') {
      // 未知命令：当场给回执（否则调用方会白等满窗口，拿到的是"界面没响应"这种**假原因**）
      reply({ cmd: cmd.cmd, ok: false, err: '界面不认识这条命令: ' + String(cmd.cmd) });
      return;
    }
    let ok = false;
    let detail = '';
    try {
      if (cmd.on) dshSidebar.show();
      else dshSidebar.closeSidebar();
      ok = true;
    } catch (err) {
      detail = String((err && err.message) || err);
    }
    reply({ cmd: cmd.cmd, ok: ok, state: ok ? dshSidebar.isVisible() : null, err: detail });
  };

  controlPoller = createControlPoller({
    dir: dir,
    handle: handle,
    log: (m) => console.log('[control] ' + m)
  });
  controlPoller.start(400);
}
/** 控制通道的轮询器（唯一实例；菜单/诊断要读它的派发历史时用得上） */
let controlPoller = null;

/* ---------------- 启动 ---------------- */
app.whenReady().then(() => {
  try {
    if (!gotSingleLock) return;   // 已有实例：本次进程只负责把它调回前台（见上面的单实例说明）
    registerIpc();
    console.log('[main] registerIpc ok');
    if (exportImageArgs) {
      const win = createWindow({ width: 1680, height: 1050, show: false });
      console.log('[main] export-image window created');
      win.webContents.once('did-finish-load', () => runExportImage(win, exportImageArgs));
      return;
    }
    if (exportWindowArgs) {
      // 整窗截图：窗口**离屏**但不退出侧栏 —— 要的就是把原生侧栏 view 一起拍进来
      const win = createWindow({ width: 1680, height: 1050, show: false });
      console.log('[main] export-window window created');
      dshSidebar.init(win);        // ⚠️ 必须 init，否则 state.win 为 null ⇒ 侧栏 view 永远建不出来
      win.webContents.once('did-finish-load', () => runExportWindow(win, exportWindowArgs));
      return;
    }
    const win = createWindow(isSmoke
      ? { show: false, width: SMOKE_VIEW.width, height: SMOKE_VIEW.height }
      : undefined);
    console.log('[main] window created');
    buildMenu(win);
    console.log('[main] menu ok');
    // DSH 侧边栏：默认打开 + 偏好恢复 + 驻留服务接管（--smoke / --export-image 不孵化）
    if (!isSmoke && !exportImageArgs) {
      dshSidebar.init(win);
      startControlChannel();     // 外部 AI / 内置 DSH 的界面控制接口（协议见 src/control.js）
    } else if (isSmoke) {
      // 冒烟：侧栏 view 照建（几何断言要它），但**不碰服务** —— 既不孵化也不接管：
      //   · 免得把用户**正在用**的那个内置服务牵连进来（以前冒烟会接管、收尾还把它停掉 ✗）
      //   · 免得 40–60s 的服务启动把 G5 拖成假红（实测同代码 94.9s ↔ 172.7s ✗）
      dshSidebar.setNoSpawn(true);
      dshSidebar.init(win);
    }
    win.webContents.once('did-finish-load', () => {
      console.log('[main] did-finish-load, isSmoke=' + isSmoke);
      if (isSmoke) setTimeout(() => runSmoke(win), 500);
    });
    // 关窗语义（用户定的分工，最终版）：**窗口 ✕ = 关整个应用**（连同侧栏）。
    // 关掉左边导图页走**导图页右上角那个独立 ✕**（renderer/app.js 里动态插入的
    // `#btn-close-map` ⇒ `MM.closeMapPage()`：先拦未保存编辑 ⇒ 保存成功才
    // ⇒ `dsh-sidebar:close-map-page` ⇒ **卸载这一页**，主窗口改为占位页）。
    // 菜单里的「退出」已按用户要求删除 —— 退出就用窗口 ✕。
    // DSH 服务按驻留语义处理：退出**不收割已就绪的服务** ⇒ 下次打开对话还在。
    win.on('closed', () => { /* 窗口已关；服务驻留 */ });
    win.on('closed', () => { /* 窗口关闭；DSH 服务独立驻留（见 will-quit） */ });
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => dshSidebar.destroy());
  } catch (err) {
    console.log('[main] FATAL:', (err && err.stack) || err);
    app.exit(1);
  }
});
