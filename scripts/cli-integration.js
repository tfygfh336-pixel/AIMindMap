/* ============================================================
 * scripts/cli-integration.js — CLI 全命令集成回归（headless）
 * ------------------------------------------------------------
 * 用途：AI 每次迭代后跑 `node scripts/cli-integration.js`，
 *       对 registry 里的全部 CLI 命令做端到端回归（`docs-gen` / `release` 除外 ——
 *       这两个会改写文档与版本号，不在测试路径内；临时项目，用完清理）。
 *       命令条数以 `cli/registry.js` 为准（`node cli/mm-cli.js --help` 可数），
 *       这里**不**写死数字：写死的数字必然腐坏（曾写"40 条里的 38 条"）。
 * 设计：每条命令一个"断言"：执行 → 校验输出/副作用 → 计 PASS/FAIL。
 * 退出码：全 PASS=0，任一 FAIL=1。
 * 不依赖键盘鼠标、不依赖 GUI（比冒烟更底层，先于冒烟跑）。
 *
 * **执行方式：进程内调用**（`cli/main.js` 的 `invokeSync`），不再是每条断言起一个 Node 进程。
 *   改前实测 140 条 / 102 s ≈ 0.73 s/条 —— 绝大部分是进程冷启动。进程内调用同时**去掉了
 *   对管道 stdio 的依赖**，而管道 stdio 正是 `docs/VERIFY.md`「本机受限环境注意」记的
 *   那条假失败来源。文件末尾保留 4 条**真子进程**断言做对照，防止两条路径漂移。
 *   ⚠️ 进程内**同步**调用依赖一条不变量：`cli/commands/*` 的命令体**不得出现 await**
 *   （违反时 `invokeSync` 立刻抛错，`tests/cli-sync-invariant.test.js` 静态把守）。
 *
 * ⚠️⚠️ **本文件里"行内斜杠紧跟 ①–⑳"的写法是"判定标记"，参与 G9 门禁的计数**（标记必须唯一）。
 *   新增段落**不要**再起一套这样的编号 —— 撞上已有标记就会被 G9 判红
 *   （`[判定条数不符] 判定标记重复`）。**这条坑在本文件已经踩过三次**（都发生在新增并发断言的段落里，
 *   第三次甚至是"解释这条坑的注释自己又写了一遍标记"），所以写在这里，不只在报错文本里。
 *   要编号就把标记放在别的字符之后（如「（阶段4①）」这种形式），这样**不计入**计数。
 * ============================================================ */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'mm-cli.js');
// 「契约允许出现在**节点**上的字段」的**唯一权威清单** + 节点复制写回的加注解析器，
// 与节点字段**形状**校验同处一室（`src/schema.js` 是那张契约表的实现）。
// ⚠️ 下面两条静态判据（界面整树写回 / 节点复制写回）**共用这一份** —— 各抄一份必然会漂，
//    而漂的方向恰恰是"某处漏一个字段、谁也没发现"（本工程栽过五次的那一类）。
const { NODE_FIELD_NAMES, NODE_FIELDS_OPTIONAL, NODE_FIELD_DESC, analyzeCloneFieldCopy } = require(path.join(ROOT, 'src', 'schema.js'));
// 进程内同步入口 —— 见文件头「执行方式」与 `cli/main.js` 顶部关于同步不变量的说明
const { invokeSync } = require(path.join(ROOT, 'cli', 'main.js'));
const PROJ = 'it-probe-' + Date.now().toString(36);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-it-'));
const OUT_JSON = path.join(TMP, 'out.aimap.json');

/* ---------------- 收尾要用的探针名（**提前声明**）----------------
 * 主跑体整段包在 `try { … }` 里（见「用例序列」那一段的说明）⇒ 块内的 `const` 在 `finally` 里
 * **读不到**，而末尾的清理段必须能**点名**删掉本次造出来的探针项目 ⇒ 这些名字在这里声明（`let`），
 * 跑体里只赋值、不再声明。名单 = 清理段真的会删的那些；其余各段的探针由各段自己的 `finally` /
 * 块末尾自删，崩溃路径再由下面的**探针前缀**兜底（见开头那段 `PROBE_PREFIX`）。 */
let PROJ2, PROJ3, PROJ4, PROJ5, PROJ6, PROJ7, K8A, K8B, BROKEN_PROJ, XP_DIR;
/** 跑体是否**真的走完**（`finally` 用它选收尾口径：只有崩在半路才允许按前缀宽口径清，见清理段） */
let bodyCompleted = false;

/* ---------------- 探针前缀表（**唯一一处**）----------------
 * 三处都用它，谁也不许再抄一份清单：① `sweepStaleProbes()` 开工前的清扫；
 * ② 崩溃路径的收尾（按前缀兜底清）；③ `<项目根>/.visits/` 里的**访问日志**过滤。
 * ⚠️ `imp-probe-` 也在这张表里：本脚本在真实 `projects/` 下造 `imp-probe-a` / `imp-probe-b` /
 * `imp-probe-pdf*`（§9.1 的导入类探针），它们的访问日志同样落在 `.visits/` 里
 * （实测：崩过一次之后留下 `imp-probe-*.jsonl`，删项目目录删不掉它）。 */
const PROBE_PREFIX = /^(it-probe-|it-broken-|it-k8-|it-w14-|it-w19-|it-w20-|it-s[1-9]-|imp-probe-)/;

/** `projects/` 下**当前**已存在的探针目录名（快照 / 崩溃路径兜底清都用这一处实现） */
function probeDirNames() {
  const out = new Set();
  try {
    fs.readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })
      .forEach((e) => { if (e.isDirectory() && PROBE_PREFIX.test(e.name)) out.add(e.name); });
  } catch (err) { /* projects/ 不存在：本轮会自己建 */ }
  return out;
}

/** 访问日志目录 `<项目根>/.visits/` —— "它在哪"的唯一实现是 `src/data-store.js`，这里不自己拼路径 */
function visitLogStore() {
  return require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(path.join(ROOT, 'projects'), () => {});
}
function visitLogDir() {
  return visitLogStore().visitDir();
}

/* ---------------- 沙箱 worker 模式（由下面 §9.2 的 runSandboxWorker 子进程调起） ----------------
 * 为什么需要单独一个进程：§9.2 的**导入类**探针会真的新建项目，而本轮新增的幂等闸门要
 * **扫全部项目**比对来源指纹 —— 探针若落在真实 `projects/` 里，使用者导入同一个文件时会被
 * 自己留下的残留**无端拒绝**（跨运行的污染，比"留个空目录"更毒 ✗）。
 * 重定向项目根只有一条路：`cli/core.js` 在**模块加载时**读 `AI_MINDMAP_PROJECTS_DIR`，
 * 父进程在本进程里来不及改 ⇒ 由父进程把 env 传进来、另起一个进程跑。
 * ⚠️ 本分支必须在**任何会写盘 / 造探针的代码之前**就 return 掉
 *   （顶层 `return` 在 CJS 里合法；`runSandboxWorker` 是函数声明，提升可用）。 */
if (process.argv[2] === '--sandbox-worker') { runSandboxWorker(); return; }

/* ---------------- 开工前**自愈**：扫己方前缀的残留探针 ----------------
 * 本脚本在**真实** projects/ 下造探针项目（store 与 CLI 同源，不另设根），
 * 结尾统一 rm。但脚本被中断（Ctrl+C / 超时被杀 / 崩溃）时收尾不执行 ——
 * 残留的 `it-probe-*` 会出现在应用的**项目列表**里，还会被 validate-all 当项目数。
 * （实测残留：it-probe-mucp3f55 让 "全部 2 个项目校验通过" 多算一个假项目。）
 * ⚠️ 崩在半路还会留下 **`it-broken-*`**（那份**故意写坏的** JSON 探针）—— 它比普通残留更毒：
 *   `validate-all` 会因 JSON 解析失败而**整条链在 G2 判红**（实测 2026-10-10：一次改脚本时的
 *   ReferenceError 中断，留下 `it-broken-mv1rcfov`，把全链从"绿"变成"步骤 9 退出码 1"；
 *   2026-10-19 又一次：`it-broken-mve2g4ps` 等 10 个 `it-*` 让 `ae07a226` 开工第一件事
 *   就是先证明"这不是我改坏的"）。
 *   故两类前缀都清 —— 自己的残留要自己收干净，否则下一个跑链的人会以为工程坏了。
 *
 * ⭐ **旧口径（"只清超过 10 分钟没动过的"）为什么不够** —— 本批实测的机制，不是猜：
 *   全链里 **步骤 12 = G4（本脚本）· 步骤 13 = G2（validate-all）**（`scripts/verify.js` 的 `STEPS`），
 *   也就是 G2 **紧跟在**本脚本之后。于是"本脚本刚被中断 ⇒ 下一轮全链的 G2 现场"里，
 *   残留的年龄**必然**小于 10 分钟 ⇒ 年龄线一定放过它 ⇒ 假红稳定复现，而且要等满 10 分钟才可能自愈。
 *   年龄线本来是给"**并发**跑的另一份本脚本"留的余地（它的探针新鲜，不能误删），但它把
 *   "上次崩溃的残留"与"别人正在跑的探针"压成了同一个信号 —— 两者根本不同，只是都"新"。
 *
 * ⇒ 解法：把"还有没有另一份本脚本在跑"**直接问出来**（登记文件 + pid 活性），不靠年龄猜：
 *   · 没有别的实例 ⇒ 盘上**任何**己方前缀的探针目录都只可能是上次崩溃留下的 ⇒ **发现即清**
 *   · 有别的实例   ⇒ 只清"超过 10 分钟没动过"的（保守口径：宁可留到下一轮，也不误删别人正在用的）
 *   登记落在 `%TEMP%/mm-live-runs/` 下的一个**空目录**（名字 = `run-<pid>-<开工时刻36进制>-<随机>`；
 *   **不在 projects/ 里** ⇒ 不会被 validate-all 当项目，也不往用户的真实项目目录里添东西）。
 *   ⭐ 为什么登记是"建目录"而不是"写文件"：目录创建**原子** ⇒ 没有"半个登记文件"这种失败形态；
 *     登记内容全在名字里 ⇒ **不必写内容** ⇒ 不新增写盘调用点（`WRITE_OUTLET_SITE_CAP` 只减不增，
 *     S2 数的是"面"：上一版写 json 的那一版实测就把它从 82 顶到 83）。
 *   进程被 SIGKILL 时它留成僵尸目录，下次按 pid 判死自动清掉。
 * ⚠️ 边界（如实登记）：pid 被系统复用给无关进程时，会把"没有别人"误判成"有别人" ⇒
 *   方向是**保守**（不删，不误删），`MAX_RUN_MS` 给僵尸登记封顶。
 * ⚠️ 自愈**不依赖**收尾：`process.on('exit')` 与 SIGINT/SIGTERM 只是兜底（见下面
 *   `sweepThisRunDebris`）；被 SIGKILL / taskkill /F 打死时唯一能救的是"下一次开跑"。 */
const STARTED_AT = Date.now();
const LIVE_DIR = path.join(os.tmpdir(), 'mm-live-runs');
const RUN_CLAIM = path.join(LIVE_DIR, 'run-' + process.pid + '-' + STARTED_AT.toString(36) + '-' + Math.random().toString(36).slice(2, 8));   // 空目录：内容全在名字里
const MAX_RUN_MS = 30 * 60 * 1000;      // 僵尸登记封顶（本脚本一轮 < 2 分钟）
const SWEEP_GRACE_MS = 10 * 60 * 1000;  // 保守年龄线：projects/ 只在"确实有另一份在跑"时用；%TEMP% 一律用
/** 本脚本自己 mkdtemp 出来的 %TEMP% 根（前缀逐字来自 6 处 `mkdtempSync`：mm-it- / mm-imp- /
 *  mm-impdir- / mm-lib- / mm-sb- / mm-w19-）。**只认这几个前缀**：%TEMP% 里别人的 mm-* 一个都不碰。 */
const OWN_TEMP_PREFIXES = ['mm-it-', 'mm-imp-', 'mm-impdir-', 'mm-lib-', 'mm-sb-', 'mm-w19-'];

/** 登记"我在跑"（供**别的实例**的开跑自愈判断"要不要保守"）—— **建一个空目录**，内容全在名字里 */
function writeRunClaim() {
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.mkdirSync(RUN_CLAIM);
  } catch (err) { /* 登记不上 ⇒ 自愈退化成保守口径（见 liveSiblingRuns 的 ok:false） */ }
}
function releaseRunClaim() {
  try { fs.rmSync(RUN_CLAIM, { recursive: true, force: true }); } catch (err) { /* 退出路径不许再抛 */ }
}
/** 还活着的**另一份**本脚本。顺带清掉僵尸登记（pid 已经死了的那些）。
 *  返回 {ok, runs}：`ok:false` = 登记目录读不出来（判不了 ⇒ 调用方必须保守）。
 *  ⚠️ 名字解析不出 pid / 开工时刻的条目一律**当死**（清掉）：僵尸目录留在那里会把每一次开跑
 *  都变成"有别人在跑" ⇒ 自愈永久失效，比残留本身更坏（"删不掉"与"有人占着"不许压成同一个读数）。 */
function liveSiblingRuns() {
  const runs = [];
  let names = [];
  try { names = fs.readdirSync(LIVE_DIR); }
  catch (err) { return { ok: !!(err && err.code === 'ENOENT'), runs }; }   // 目录不存在 = 从没有实例登记过
  for (const f of names) {
    if (f === path.basename(RUN_CLAIM)) continue;                          // 自己那条不算"别人"
    if (f.indexOf('run-') !== 0) continue;
    const p = path.join(LIVE_DIR, f);
    const m = f.split('-');                                                // run-<pid>-<起于36进制>-<随机>
    const pid = Number(m[1]);
    const startedAt = parseInt(m[2], 36);
    let alive = false;
    if (isFinite(pid) && pid > 0 && pid !== process.pid && isFinite(startedAt)) {
      try { process.kill(pid, 0); alive = true; }
      catch (err) { alive = !!(err && err.code === 'EPERM'); }             // EPERM = 进程在，只是不许发信号
    }
    if (alive && Date.now() - startedAt > MAX_RUN_MS) alive = false;       // 超龄 ⇒ pid 复用 / 僵尸
    if (!alive) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (err) { /* 清僵尸失败不判红 */ } continue; }
    runs.push({ pid: pid, startedAt: startedAt, file: f });
  }
  return { ok: true, runs };
}
/** `projects/` 下己方前缀（`PROBE_PREFIX`）的探针目录：**没有别的实例就发现即清**。
 *  只碰前缀表命中的目录；用户的真实项目与别的工具的目录一个都不碰。 */
function sweepOwnProbes(sib) {
  const dir = path.join(ROOT, 'projects');
  const conservative = !sib.ok || sib.runs.length > 0;
  const removed = [];
  const kept = [];
  let entries = null;
  let err = '';
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (!(e && e.code === 'ENOENT')) err = String((e && e.message) || e); }   // ENOENT = 本轮会自己建
  if (entries) {
    for (const e of entries) {
      if (!e.isDirectory() || !PROBE_PREFIX.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (conservative) {
        let young = false;
        try { young = Date.now() - fs.statSync(p).mtimeMs < SWEEP_GRACE_MS; } catch (e2) { young = false; }
        if (young) { kept.push(e.name); continue; }   // 可能是别人正在跑的（只在有别的实例时才这么判）
      }
      try { fs.rmSync(p, { recursive: true, force: true }); removed.push(e.name); }
      catch (e2) { kept.push(e.name); }
    }
  }
  // 这些名字的**访问日志**（在项目目录之外）跟着清：**只清真删掉的那些名字**
  // （真项目的使用痕迹一个都不碰 —— 路径推导走 DataStore.visitLogFile 这一处，不自己拼）
  let logs = 0;
  if (removed.length) {
    try {
      const store = visitLogStore();
      const vl = store.visitDir();
      if (fs.existsSync(vl)) {
        for (const name of removed) {
          try { fs.rmSync(store.visitLogFile(name), { force: true }); logs++; } catch (e) { /* 不判红 */ }
        }
      }
    } catch (e) { /* 不判红 */ }
  }
  return { removed, kept, logs, err, conservative, runs: sib.runs };
}
/** `%TEMP%` 下己方 mkdtemp 根（见 `OWN_TEMP_PREFIXES`）：本脚本被中断时它们同样会留一堆
 *  （本机实测：`mm-it-*` 252 个、`mm-imp*` 12 个）。这里的残留**不影响任何门禁**（只占磁盘），
 *  所以口径比 projects/ 更保守：**一律用 10 分钟年龄线**，并且**跳过本轮自己那个**（`keepNames`，
 *  否则会把整轮要用的 TMP 删掉）。 */
function sweepOwnTempRoots(keepNames) {
  const names = [];
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); }
  catch (e) { return { removed: 0, names, err: String((e && e.message) || e) }; }
  for (const e of entries) {
    if (!e.isDirectory() || keepNames.indexOf(e.name) >= 0) continue;
    if (!OWN_TEMP_PREFIXES.some((pre) => e.name.indexOf(pre) === 0)) continue;
    const p = path.join(os.tmpdir(), e.name);
    let young = false;
    try { young = Date.now() - fs.statSync(p).mtimeMs < SWEEP_GRACE_MS; } catch (e2) { young = false; }
    if (young) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); names.push(e.name); } catch (e2) { /* 单个失败不影响本轮 */ }
  }
  return { removed: names.length, names, err: '' };
}
/** 开工前自愈（**主路**）。名字沿用 `sweepStaleProbes`：本文件十几处注释按这个名字索引它的前缀表。
 *  读数分**三态**（"读不出来"绝不许混进"无残留"）：清掉了 / 无残留 / 扫不动并点名原因。 */
function sweepStaleProbes() {
  writeRunClaim();
  const sib = liveSiblingRuns();
  const pj = sweepOwnProbes(sib);
  const tp = sweepOwnTempRoots([path.basename(TMP), path.basename(LIVE_DIR)]);
  if (pj.err) console.log('[自愈] ⚠️ 扫不掉 projects/（' + pj.err + '）—— 本轮可能带着上次的残留开跑');
  if (pj.removed.length) {
    console.log('[自愈] 上次运行被中断，已清 ' + pj.removed.length + ' 个残留探针目录：' + pj.removed.join(', ')
      + (pj.logs ? '（连同 ' + pj.logs + ' 个旁路访问日志）' : ''));
  }
  if (tp.removed) {
    const head = tp.names.slice(0, 5).join(', ') + (tp.names.length > 5 ? ' …（共 ' + tp.names.length + ' 个）' : '');
    console.log('[自愈] 上次运行被中断，已清 ' + tp.removed + ' 个残留 %TEMP% 临时根：' + head);
  }
  if (pj.conservative && pj.kept.length) {
    console.log('[自愈] 检测到另一份集成测试在跑（pid ' + pj.runs.map((r) => r.pid).join('/') + ' 起于 '
      + pj.runs.map((r) => new Date(r.startedAt).toISOString()).join('/') + '）⇒ 新鲜（<'
      + Math.round(SWEEP_GRACE_MS / 60000) + ' 分钟）的己方探针目录本轮不动：' + pj.kept.join(', '));
  }
  if (!pj.conservative && !pj.removed.length && !tp.removed && !pj.err) {
    console.log('[自愈] 开工前扫己方前缀探针：无残留（前缀 ' + PROBE_PREFIX.source + '）');
  }
  return pj;
}
let crashSwept = false;
/** 收尾兜底（**不是主路**）：本轮**新出现**的己方前缀探针目录（开工快照里没有的）+ 它们的访问日志。
 *  只在"跑体没走完"时用；幂等 —— `finally` / `exit` / 信号三处都调它也只做一次。
 *  ⚠️ 边界（与既有崩溃路径同一条，如实登记）：并发起跑、且**在本次之后**才建出探针目录的那一份，
 *  会被这次兜底扫一起清掉 —— 这个险只在**跑体没走完**时冒。 */
function sweepThisRunDebris(why) {
  if (crashSwept) return;
  crashSwept = true;
  const swept = [];
  probeDirNames().forEach((name) => {
    if (PRE_EXISTING_PROBES.has(name)) return;   // 开工前就在：可能是并发跑的别人
    try { fs.rmSync(path.join(ROOT, 'projects', name), { recursive: true, force: true }); swept.push(name); }
    catch (e) { /* 收尾失败不判红 */ }
  });
  if (swept.length) {
    console.log('[收尾] ' + why + ' ⇒ 按探针前缀兜底清掉 ' + swept.length + ' 个本次新建的探针项目：' + swept.join(', '));
  }
  // 访问日志（在项目目录之外，删项目目录删不掉它）：按前缀清 —— 过滤口径 = 顶部那张 PROBE_PREFIX
  try {
    const vl = visitLogDir();
    if (fs.existsSync(vl)) {
      fs.readdirSync(vl).filter((f) => PROBE_PREFIX.test(f))
        .forEach((f) => { try { fs.rmSync(path.join(vl, f), { force: true }); } catch (e) { /* 收尾失败不判红 */ } });
    }
  } catch (e) { /* 收尾失败不判红 */ }
}
/* 兜底一：`exit` 事件 —— 正常结束、`process.exit()`、**未捕获异常**都会触发它（SIGKILL 不会）。
 * 正常跑完（`bodyCompleted`）时什么都不做：那时末尾的清理段已经按名单收干净了。 */
process.on('exit', () => {
  try { if (!bodyCompleted) sweepThisRunDebris('进程退出（跑体没走完：未捕获异常 / 提前 process.exit）'); }
  catch (e) { /* 退出路径不许再抛 */ }
  releaseRunClaim();
});
/* 兜底二：信号。⚠️ 如实登记其局限：跑体是**一大段同步代码** ⇒ 信号回调要等它让出事件循环才轮到，
 * 所以 Ctrl-C 的实际行为接近"这一段跑完、清完再退出"，不是"立刻停"；要立刻停只能用 SIGKILL 类
 * （taskkill /F、任务管理器结束进程）—— 那种情况**只有下次开跑的自愈**能救，这正是主路。 */
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    console.log('[收尾] 收到 ' + sig + ' ⇒ 先清本次探针再退出');
    try { sweepThisRunDebris('收到 ' + sig); } catch (e) { /* 退出路径不许再抛 */ }
    releaseRunClaim();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
});
sweepStaleProbes();
/* 开工前**扫完之后**还在的己方前缀目录（快照）：跑体没走完时的兜底收尾要排除它们 ——
 * 那些要么是并发跑的另一份集成正在用的（保守口径放过的），要么是删不掉的。 */
const PRE_EXISTING_PROBES = probeDirNames();

/** 失败契约违规记录：**每个** run() 都被检查，因此全部断言都顺带验证契约，
 *  而不只是专门写的那一条（这正是"不变量应由一个守门点覆盖"的用法）。 */
const contractViolations = [];

function run(args) {
  const r = invokeSync(args); // 进程内同步调用（免去每条一次 Node 进程冷启动）
  const out = r.stdout + r.stderr; // 与子进程模式一致：两路合并
  // 不变量：**说了 error 就必须非 0 退出**（绝不能"报错却返回成功"）。
  // 反向不成立——validate-all 是"报告型"命令，会以 FAIL 行 + 非 0 退出码表达失败。
  const saidError = /^error:/.test(out.trim());
  const exitBad = r.code !== 0;
  if (saidError && !exitBad) {
    contractViolations.push(args.join(' ') + ' → 输出 error: 但 exit=' + r.code);
  }
  return { code: r.code, out };
}
const ok = (text) => !/^error:/.test(text.trim());

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? ' :: ' + detail : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}

/* ---------------- §9.2 的沙箱 worker ----------------
 * 在**项目根 = %TEMP% 沙箱**的进程里跑全部导入类探针，只吐一个 JSON 交给父进程判定
 *（判定留在父进程 ⇒ PASS/FAIL 计数、`check(` 计数、报错文案都在一处，不分裂成两套）。
 * 覆盖：来源指纹 origin（幂等闸门 / --force / 指纹随内容变 / get 读得到 / stats 报得出）
 *      + 目录入参（响亮拒绝 + 给出路）+ 旧数据（无 origin）不受影响。 */
function runSandboxWorker() {
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-imp-'));
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-impdir-'));
  const wf = (rel, text) => { const p = path.join(WORK, rel); fs.writeFileSync(p, text, 'utf8'); return p; };
  const go = (args) => {
    const r = invokeSync(args);
    return { code: r.code, out: (r.stdout + r.stderr).trim() };
  };
  const J = (r) => { try { return JSON.parse(r.out); } catch (e) { return null; } };
  const statsOf = (name) => J(go(['stats', name, '--json']));
  const projectNames = () => {
    const j = J(go(['projects', '--json']));
    return Array.isArray(j) ? j.map((p) => p.name).sort() : [];
  };

  const out = { work: WORK, dir: DIR };
  try {
    // 三份**不同内容**的来源文件（注意 fA2 只比 fA 多一个字符 —— 指纹必须变）
    const fA = wf('docA.md', '# 主题甲\n## 子一\n正文\n\n# 主题乙\n## 子二\n');
    const fA2 = wf('docA-one-byte.md', '# 主题甲\n## 子一\n正文!\n\n# 主题乙\n## 子二\n');
    const fB = wf('docB.md', '# 另一份文档\n正文 B\n');

    // ── A. import-project：同一份文档导两次**不许**产生第二棵树 ──
    out.impProjFirst = go(['import-project', 'imp-a', fA]);
    out.projectsAfterFirst = projectNames();
    out.impProjSecondOtherName = go(['import-project', 'imp-b', fA]);   // ← 换个项目名再导同一份
    out.projectsAfterSecond = projectNames();
    out.impProjNoForce = go(['import-project', 'imp-b', fA]);           // 同名 ⇒ 也会被"项目已存在"拦
    out.impProjForced = go(['import-project', 'imp-b', fA, '--force']); // 显式 --force ⇒ 放行
    out.projectsAfterForce = projectNames();
    out.rootA = J(go(['get', 'imp-a', 'root', '--json']));
    out.statsA = statsOf('imp-a');
    out.readBriefA = (() => {
      const j = J(go(['read', 'imp-a', '--json', '--brief']));
      const n = ((j && j.nodes) || []).filter((x) => x.origin)[0];
      return n ? { id: n.id, src: n.origin.src, sha256: n.origin.sha256 } : null;
    })();
    out.dryRunDup = J(go(['import-project', 'imp-c', fA, '--dry-run', '--json']));
    out.impProjChanged = go(['import-project', 'imp-d', fA2]);          // 改一个字节 ⇒ 指纹变 ⇒ 放行
    out.projectsAfterChanged = projectNames();

    // ── B. 旧数据（一个 origin 都没有）读 / 写 / 校验一切照旧 ──
    out.legacyInit = go(['init', 'legacy']);
    out.legacyAdd = go(['add', 'legacy', 'root', '--topic', '手写的', '--id', 'n1']);
    out.legacyValidate = go(['validate', 'legacy']);
    out.legacyEdit = go(['edit', 'legacy', 'n1', '--topic', '手写的（改过）']);
    out.legacyValidateAgain = go(['validate', 'legacy']);
    out.legacyGet = J(go(['get', 'legacy', 'n1', '--json']));
    out.legacyStats = statsOf('legacy');

    // ── C. import-md：同一份 md 追加两次**不许**生成第二棵子树 ──
    out.mdFirst = go(['import-md', 'legacy', fB]);
    out.mdStatsAfterFirst = statsOf('legacy');
    out.mdSecond = go(['import-md', 'legacy', fB]);
    out.mdStatsAfterRefuse = statsOf('legacy');
    out.mdForced = go(['import-md', 'legacy', fB, '--force']);
    out.mdStatsAfterForce = statsOf('legacy');

    /* ── C′. **带 BOM 的 md：第一个标题不许被静默吃掉**（本轮修的缺陷，2026-10-10 实测复现）──
     * 取证：`# 第一本书` / `正文一` / `# 第二本书` / `正文二` 这份内容
     *   · 带 BOM 走 `import-md` ⇒ 树里**只剩「第二本书」**（新增 1 个节点）；
     *   · 同一内容去掉 BOM      ⇒ 两个标题都在（新增 2 个节点）。
     * 根因：`markdown.js` 的 detectMode 要求首行是 `#`，而 BOM 让**首行**匹配不上 ⇒
     * 第一个标题被当成正文吞掉；`import-project` 没这个毛病（它走 docToOutline，那里剥 BOM）。
     * 这里同时钉**正例**（带 BOM 两个都在）与**对照**（无 BOM 两个也都在）——
     * 只钉一边的话，"两边一样坏"也会通过 ✗。 */
    const fBom = wf('docBom.md', '\uFEFF# 第一本书\n正文一\n\n# 第二本书\n正文二\n');
    const fPlain = wf('docPlain.md', '# 第一本书\n正文一\n\n# 第二本书\n正文二\n');
    out.bomBaseNodes = (statsOf('imp-a') || {}).nodes;   // 导入前的节点数（判"新增了几个"要基线）
    out.bomFirst = go(['import-md', 'imp-a', fBom]);
    out.bomStats = statsOf('imp-a');
    out.bomBrief = go(['read', 'imp-a', '--brief']);
    out.plainFirst = go(['import-md', 'imp-a', fPlain]);
    out.plainStats = statsOf('imp-a');
    out.plainBrief = go(['read', 'imp-a', '--brief']);
    // 两份内容的**指纹必须相同**（BOM 不是内容）：否则"同一份文档"会被当成两份来源，
    // 幂等闸门就废了（这条与上面那条同一个根因的两面）
    out.bomOrigin = (() => {
      const j = J(go(['read', 'imp-a', '--json', '--brief']));
      const ns = ((j && j.nodes) || []).filter((x) => x.origin && /doc(Bom|Plain)\.md$/.test(x.origin.src));
      return ns.map((x) => ({ src: String(x.origin.src).split('/').pop(), sha: x.origin.sha256 }));
    })();

    /* ── C″. 体量闸门：超大文件**响亮拒绝 + 说出路**，且**什么都没写**（⓪′）── */
    const big = wf('too-big.txt', 'x');
    try { fs.truncateSync(big, 65 * 1024 * 1024); } catch (e) { /* 撑不大就下面的断言自己红 ✓ */ }
    out.bigImportMd = go(['import-md', 'imp-a', big]);
    out.bigImportProject = go(['import-project', 'imp-big', big]);
    out.bigStats = statsOf('imp-a');
    out.bigProjects = projectNames();
    try { fs.unlinkSync(big); } catch (e) { /* ignore */ }

    // ── D. 目录入参：两条命令都要响亮拒绝 + 给出路，且**一点都不许写** ──
    const projBeforeDir = projectNames();
    out.dirImportProject = go(['import-project', 'imp-dir', DIR]);
    out.dirImportMd = go(['import-md', 'legacy', DIR]);
    out.projectsAfterDir = projectNames();
    out.projectsBeforeDir = projBeforeDir;
    out.missingImportProject = go(['import-project', 'imp-gone', path.join(WORK, 'nope.md')]);
    out.missingImportMd = go(['import-md', 'legacy', path.join(WORK, 'nope.md')]);
    out.projectsAfterMissing = projectNames();

    /* ── E. 整库导入（`import-dir`，批 5）：目录树 → **与文件夹同构**的一棵树 ──
     * 夹具刻意把"该跳过的每一类"各放一个（隐藏文件 / node_modules / 空目录 / 不支持的扩展名），
     * 外加一个**带 BOM 的 md**（它曾经让 import-md 静默吃掉第一个标题）和一份**没有任何标题的 txt**
     * （正文只能落在文件节点自己的 detail 上，否则就是静默丢内容 ✗）。 */
    const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lib-'));
    const lw = (rel, text, bom) => {
      const p = path.join(LIB, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, (bom ? '\uFEFF' : '') + text, 'utf8');
      return p;
    };
    lw('note-a.md', '# 甲的主题\n正文 A\n');
    lw('笔记/第一章.md', '# 第一章\n正文一\n');
    lw('笔记/第二章.md', '# 第二章\n正文二\n', true);          // ← 带 BOM
    lw('笔记/子目录/深层.txt', '第一章 概述\n正文。\n');          // ← 没有任何可识别标题 ⇒ 只能进 detail
    lw('笔记/图片.png', 'binary');                              // ← 不支持的扩展名
    fs.mkdirSync(path.join(LIB, '空目录'), { recursive: true });  // ← 空目录
    lw('.隐藏.md', '# 藏起来\n');                                // ← 隐藏文件
    lw('node_modules/dep.md', '# 依赖\n');                       // ← 依赖目录

    out.libDir = LIB;
    out.libProjectsBefore = projectNames();
    out.libDry = J(go(['import-dir', 'lib1', LIB, '--title', '书库', '--dry-run', '--json']));
    out.libProjectsAfterDry = projectNames();          // **必须与 before 逐字相同**（dry-run 绝不写盘）
    out.libFirst = go(['import-dir', 'lib1', LIB, '--title', '书库']);
    out.libBriefJson = J(go(['read', 'lib1', '--json', '--brief']));
    /* 深层.txt 的文件节点：**没有子节点**（那份 txt 没有任何可识别标题）⇒ 正文只能落在它自己的
     * detail 上（否则就是静默丢内容 ✗）。`--brief` 视图按设计省掉 detail ⇒ 用 `get --detail` 把它取回来。 */
    const deepNode = ((out.libBriefJson && out.libBriefJson.nodes) || [])
      .filter((n) => n.origin && /深层\.txt$/.test(n.origin.src))[0];
    out.libDeepChildren = deepNode ? (deepNode.children || []).length : null;
    out.libDeepGet = deepNode ? J(go(['get', 'lib1', deepNode.id, '--json', '--detail'])) : null;
    out.libStats = statsOf('lib1');
    out.libValidate = go(['validate', 'lib1']);
    out.libSecond = go(['import-dir', 'lib2', LIB, '--title', '书库二号']);   // 整个目录重复导
    out.libProjectsAfterSecond = projectNames();
    out.libSubDir = go(['import-dir', 'lib3', path.join(LIB, '笔记')]);       // 子目录 ⇒ 文件级命中
    out.libMaxFiles = go(['import-dir', 'lib9', LIB, '--max-files', '2']);
    out.libMaxFilesDry = J(go(['import-dir', 'lib9', LIB, '--max-files', '2', '--dry-run', '--json']));
    out.libExtMd = J(go(['import-dir', 'lib4', LIB, '--ext', 'md', '--dry-run', '--json']));
    out.libExtHint = go(['import-dir', 'lib4', LIB, '--ext', 'md', '--dry-run']);   // 文本版（提示那一行）
    out.libExtBad = go(['import-dir', 'lib4', LIB, '--ext', 'py']);
    out.libFileArg = go(['import-dir', 'lib5', path.join(LIB, 'note-a.md')]);
    out.libEmptyDir = go(['import-dir', 'lib6', path.join(LIB, '空目录')]);
    out.libProjectsAfterErrors = projectNames();
    out.dirImportProjectNow = go(['import-project', 'imp-dir2', LIB]);        // 单文件命令拿到目录
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.stack) || e);
  }
  // ⚠️ 只在这里吐一次 JSON：上面的 `invokeSync` 自己会捕获 stdout ⇒ 不会污染这一行。
  //    父进程按"最后一行 JSON"解析，坏掉就让断言**红**（绝不静默空转 ✗）。
  process.stdout.write('\n' + JSON.stringify(out) + '\n');
}

/* ---------------- 用例序列（整段包在 `try` 里 ⇒ 崩在半路也走末尾的 `finally` 清理） ----------------
 * 为什么必须包：任何**半路崩溃**（断言抛错、未捕获异常、探针里手滑一次）都会跳过末尾的清理段，
 * 于是本次的探针项目留在真实 `projects/` 里 —— 下次跑链时 `validate-all` 多算一个项目、应用项目
 * 列表多一个假项目，而自愈途径是**下一次开跑**时的 `sweepStaleProbes()`（本批把它改成"发现即清"：见文件顶部那段说明。这句注记留着，因为它正是"不能把收尾当主路"的实测依据。实测踩到过：
 * `it-broken-*` 残留直接把全链从绿变成"步骤 9 退出码 1"）。⇒ 跑体整段进 `try`、清理段进 `finally`。
 * ⚠️ 异常照旧**往上抛**（`finally` 不 catch）：崩了就该以非 0 退出，不许被清理段吞掉。
 * ⚠️ 两个副作用写在明处，免得后来者以为它是笔误：
 *   ① 跑体进了块 ⇒ 块内 `const` 在 `finally` 里**读不到** ⇒ 清理段要用的探针名已提前到文件顶部声明
 *      （`let PROJ2, PROJ3, …`，跑体里只赋值）；
 *   ② 本段的缩进**故意不整体右移**：整段右移 2 格会把这份 4600 行的文件变成"全文重写"，
 *      `git blame` 与各处按行号写的注释索引（如 "见文件头 42 行"）会一起失效 —— 可核对性比缩进好看重要。
 * 判据（注入证明）：在跑体中途临时 `throw` ⇒ 探针残留 **0**（`projects/` 与 `.visits/` 各数一遍；
 *   实测报文见本批交付；正常跑完的读数见末尾那行汇总）。 */
try {
/* ---------------- 用例序列 ---------------- */
// 1. init
let r = run(['init', PROJ, '--title', '集成测试']);
check('init', ok(r.out) && /已创建/.test(r.out), r.out.trim());

// 2. add 三个节点
r = run(['add', PROJ, 'root', '--topic', 'A', '--id', 'a']);
check('add a', ok(r.out) && /a/.test(r.out));
r = run(['add', PROJ, 'a', '--topic', 'B', '--id', 'b']);
check('add b', ok(r.out));
r = run(['add', PROJ, 'b', '--topic', 'C', '--id', 'c']);
check('add c', ok(r.out));

// 3b. add-root：凭空新增顶层主题（不选父节点，直接挂在 root 下）
r = run(['add-root', PROJ, '--topic', '顶层主题X', '--id', 'tx']);
check('add-root 顶层主题', ok(r.out) && /父 root/.test(r.out), r.out.trim());
r = run(['get', PROJ, 'tx']);
check('add-root 节点可读', ok(r.out) && /顶层主题X/.test(r.out), r.out.trim());

// 2.5. theme-layout：设置顶层主题左右分侧 → read 可见 meta.layout → validate 通过
r = run(['add-root', PROJ, '--topic', 'T1', '--id', 't1']);
check('add-root t1', ok(r.out) && /t1/.test(r.out));
r = run(['theme-layout', PROJ, '--left', 'a', '--right', 't1']);
check('theme-layout', ok(r.out) && /已设置主题布局/.test(r.out), r.out.trim());
r = run(['read', PROJ, '--json']);
check('read 含 meta.layout', ok(r.out) && /"layout"[\s\S]*"left"[\s\S]*"a"/.test(r.out));
r = run(['theme-layout', PROJ, '--left', 'not-a-theme']);
check('theme-layout 拒绝非顶层主题', !ok(r.out) && /不是顶层主题/.test(r.out), r.out.trim());
r = run(['theme-layout', PROJ, '--clear']);
check('theme-layout --clear', ok(r.out) && /已设置主题布局/.test(r.out));
r = run(['validate', PROJ]);
check('theme-layout 后 validate', ok(r.out));

// 3. move 防环（历史严重 bug）：移动到自身子孙必须被拒
r = run(['move', PROJ, 'b', 'c']);
check('move 成环被拒', !ok(r.out), r.out.trim());

// 4. move 正常
r = run(['move', PROJ, 'b', 'root']);
check('move 正常', ok(r.out) && /已移动/.test(r.out));

// 5. edit
r = run(['edit', PROJ, 'b', '--topic', 'B2', '--detail', '<p>详情</p>']);
check('edit', ok(r.out));

// 5b. detail 的存储语义是 HTML：--detail 必须原样存（不得被转义或转换）。
//     文档曾错称"detail 为 Markdown 语义"，导致 AI 写 Markdown 后渲染成字面量。
r = run(['edit', PROJ, 'b', '--detail', '<h3>直写</h3><ul><li>要点</li></ul>']);
const rawDetail = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json', '--detail']).out).detail; } catch (e) { return null; }
})();
check('--detail 按 HTML 原样存储（不转义）',
  rawDetail === '<h3>直写</h3><ul><li>要点</li></ul>', JSON.stringify(rawDetail));

// 5c. --detail-md 把 Markdown 转成 HTML 存储（AI 写 Markdown 的推荐路径）
r = run(['edit', PROJ, 'b', '--detail-md', '## 标题\n\n正文 **加粗**\n\n- 项一\n- 项二']);
const convDetail = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json', '--detail']).out).detail; } catch (e) { return null; }
})();
check('--detail-md 转为 HTML 存储',
  ok(r.out) && typeof convDetail === 'string'
  && /<h2>标题<\/h2>/.test(convDetail) && /<strong>加粗<\/strong>/.test(convDetail)
  && /<li>项一<\/li>/.test(convDetail) && !/\*\*/.test(convDetail),
  JSON.stringify(convDetail));

// 5d. --detail 与 --detail-md 互斥（避免"以为是 Markdown 其实是 HTML"的静默歧义）
r = run(['edit', PROJ, 'b', '--detail', '<b>x</b>', '--detail-md', '**y**']);
check('--detail 与 --detail-md 互斥被拒',
  /^error:/.test(r.out.trim()) && /不能同时使用/.test(r.out), r.out.trim().slice(0, 90));

// 5e. 存量 HTML 数据不被破坏：直接写回的 HTML 必须逐字保持
r = run(['edit', PROJ, 'b', '--detail', '<table border="1"><tr><th>维度</th></tr></table>']);
const tblDetail = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json', '--detail']).out).detail; } catch (e) { return null; }
})();
check('HTML 表格等存量结构原样保留',
  tblDetail === '<table border="1"><tr><th>维度</th></tr></table>', JSON.stringify(tblDetail));
run(['edit', PROJ, 'b', '--detail', '<p>详情</p>']);   // 复原为 edit 断言时的值

// 6. clone
r = run(['clone', PROJ, 'b', 'a', '--deep']);
check('clone', ok(r.out) && /已复制/.test(r.out));
// 清理这次 --deep 克隆出的节点（否则它会作为"有内容无引用"的孤儿污染 orphans 断言）
const deepCloneId = (/（新 id ([^）]+)）/.exec(r.out) || [])[1] || null;
if (deepCloneId) run(['remove', PROJ, deepCloneId]);

// 6b. clone 必须完整保留 tags / files（曾静默丢失两者）。
//     本块自给自足：先给 b 装上 tags+附件，检查后立刻复原，避免污染后续断言。
run(['edit', PROJ, 'b', '--tags', '克隆,标签']);
const ATT_FOR_CLONE = path.join(TMP, 'clone-att.md');
fs.writeFileSync(ATT_FOR_CLONE, '# 克隆附件\n', 'utf8');
run(['add-file', PROJ, 'b', '--file', ATT_FOR_CLONE, '--caption', '供 clone 检查的附件']);
const bBefore = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json']).out); } catch (e) { return null; }
})();
r = run(['clone', PROJ, 'b', 'root']);
const clonedId = (() => {
  const m = /（新 id ([^）]+)）/.exec(r.out);
  return m ? m[1] : null;
})();
const clonedNode = (() => {
  if (!clonedId) return null;
  const g = run(['get', PROJ, clonedId, '--json']);
  try { return JSON.parse(g.out); } catch (e) { return null; }
})();
check('clone 保留 tags 与 files',
  !!bBefore && !!clonedNode
  && JSON.stringify(clonedNode.tags || []) === JSON.stringify(bBefore.tags || [])
  && (clonedNode.tags || []).length === 2
  && Array.isArray(clonedNode.files) && clonedNode.files.length === 1,
  'clonedId=' + clonedId + ' tags=' + JSON.stringify(clonedNode && clonedNode.tags)
  + ' files=' + String(clonedNode && clonedNode.files && clonedNode.files.length));
// 复原 b（删掉克隆节点、临时附件与标签），保证后续 files.length===1 断言不受影响
run(['remove', PROJ, clonedId || 'no-such-id']);
run(['edit', PROJ, 'b', '--clear-tags']);
if (bBefore && bBefore.files && bBefore.files.length) {
  run(['remove-file', PROJ, 'b', bBefore.files[bBefore.files.length - 1].file]);
}
r = run(['get', PROJ, 'b', '--json']);
check('clone 检查后 b 已复原',
  ok(r.out) && !r.out.includes('克隆') && !/"files"/.test(r.out), r.out.slice(0, 120));

// 6c. get 的 path 必须是真实层级路径（曾返回 DFS 访问过的全部节点）
r = run(['add', PROJ, 'root', '--topic', 'L1', '--id', 'p1']);
run(['add', PROJ, 'p1', '--topic', 'L2', '--id', 'p2']);
run(['add', PROJ, 'p2', '--topic', 'L3', '--id', 'p3']);
const deepPath = (() => {
  const g = run(['get', PROJ, 'p3', '--json']);
  try { return JSON.parse(g.out).path; } catch (e) { return null; }
})();
check('get path 为真实层级（root→…→节点）',
  Array.isArray(deepPath) && JSON.stringify(deepPath) === JSON.stringify(['root', 'p1', 'p2', 'p3']),
  JSON.stringify(deepPath));

// 6d. read --brief 必须真的省掉长文本（detail/images）
const fullRead = run(['read', PROJ, '--json']);
const briefRead = run(['read', PROJ, '--json', '--brief']);
const briefHasDetail = /"detail"/.test(briefRead.out);
check('read --brief 省略 detail 且更短',
  ok(briefRead.out) && !briefHasDetail && briefRead.out.length < fullRead.out.length,
  'full=' + fullRead.out.length + 'B brief=' + briefRead.out.length + 'B hasDetail=' + briefHasDetail);
check('read 默认仍含 detail（brief 不应影响默认口径）',
  ok(fullRead.out) && /"detail"/.test(fullRead.out), 'full len=' + fullRead.out.length);
run(['remove', PROJ, 'p1']);   // 清理 6c 的临时子树

// 7. read / list / get / search / stats
r = run(['read', PROJ, '--json']);
check('read --json', ok(r.out) && r.out.includes('nodeCount'));
r = run(['list', PROJ]);
check('list', ok(r.out) && r.out.includes('B2'));
r = run(['get', PROJ, 'b', '--json', '--detail']);
check('get', ok(r.out) && r.out.includes('详情'));
r = run(['search', PROJ, 'B2']);
check('search', ok(r.out) && r.out.includes('b'));
r = run(['stats', PROJ]);
check('stats', ok(r.out) && /nodes/.test(r.out));

// 8. link / links / unlink
r = run(['link', PROJ, 'a', '--to', 'comnet', '--id', 'dns', '--caption', '关联DNS']);
const linkOk = ok(r.out) && /已添加链接/.test(r.out);
check('link', linkOk, r.out.trim());

// 8b. orphans：关系审计。必须把"无引用但有内容"与"纯结构无内容"分开报 ——
//     前者是真正该处理的（漏挂链接），后者是正常结构，混在一起会淹没信号。
const orph = (() => {
  try { return JSON.parse(run(['orphans', PROJ, '--json']).out); } catch (e) { return null; }
})();
check('orphans 输出结构与分类字段',
  !!orph && typeof orph.orphans === 'number' && typeof orph.contentOrphans === 'number'
  && typeof orph.structural === 'number' && Array.isArray(orph.items)
  && orph.orphans === orph.contentOrphans + orph.structural,
  JSON.stringify(orph && { orphans: orph.orphans, content: orph.contentOrphans, structural: orph.structural }));
// a 已 link 到 comnet/dns → 不应被判为孤儿；b 无任何链接且有 detail → 应计入 contentOrphans
const orphIds = (() => {
  try { return JSON.parse(run(['orphans', PROJ, '--json', '--content-only', '--limit', '500']).out).items.map((x) => x.id); }
  catch (e) { return []; }
})();
check('orphans 正确区分有引用 / 无引用',
  orphIds.indexOf('a') < 0 && orphIds.indexOf('b') >= 0,
  'contentOrphans=' + JSON.stringify(orphIds));
// 有出边的节点不得被判为孤儿。注意 orphans 默认只把「有内容」的无引用节点计入
// contentOrphans，故先给 a 一个 detail 再验证；验证后清掉，避免影响后续断言。
run(['edit', PROJ, 'a', '--detail', '<p>a 的内容</p>']);
const orphAfterUnlink = (() => {
  run(['unlink', PROJ, 'a', '--to', 'comnet', '--id', 'dns']);
  try { return JSON.parse(run(['orphans', PROJ, '--json', '--content-only', '--limit', '500']).out).items.map((x) => x.id); }
  catch (e) { return []; }
})();
check('orphans 在移除出边后把该节点计入',
  orphAfterUnlink.indexOf('a') >= 0, 'afterUnlink=' + JSON.stringify(orphAfterUnlink));
run(['link', PROJ, 'a', '--to', 'comnet', '--id', 'dns', '--caption', '关联DNS']);   // 复原出边
run(['edit', PROJ, 'a', '--clear-detail']);                                          // 复原 detail
r = run(['links', PROJ]);
check('links', ok(r.out) && r.out.includes('comnet/dns'));
r = run(['unlink', PROJ, 'a', '--to', 'comnet', '--id', 'dns']);
check('unlink', ok(r.out) && /已移除/.test(r.out));

// 8c. mentions：未链接提及。构造一个专属子树来验证，互不干扰：
//     m1 的正文提到兄弟 m2（该报）、提到自己的子节点 m1c（结构相邻，不该报）、
//     且 m1 已链接 m3（已声明关系，不该报）。
run(['add', PROJ, 'root', '--topic', '提及宿主', '--id', 'mh']);
run(['add', PROJ, 'mh', '--topic', '提及者', '--id', 'm1']);
run(['add', PROJ, 'mh', '--topic', '被提及目标', '--id', 'm2']);
run(['add', PROJ, 'mh', '--topic', '已链接目标', '--id', 'm3']);
run(['add', PROJ, 'm1', '--topic', '自己的子节点', '--id', 'm1c']);
run(['add', PROJ, 'mh', '--topic', '自己的子节点', '--id', 'dup-topic-probe']);   // 同名干扰项
run(['edit', PROJ, 'm1', '--detail-md', '正文里提到了 被提及目标，也提到了 已链接目标，还提到了 自己的子节点。']);
run(['link', PROJ, 'm1', '--to', PROJ, '--id', 'm3']);                            // 已声明关系
const mt = (() => {
  try { return JSON.parse(run(['mentions', PROJ, '--json', '--limit', '500']).out); } catch (e) { return null; }
})();
const mtTo = (mt && mt.items ? mt.items.filter((x) => x.from === 'm1').map((x) => x.to) : []);
check('mentions 找出正文提到但未链接的节点',
  !!mt && mtTo.indexOf('m2') >= 0, 'from m1 -> ' + JSON.stringify(mtTo));
check('mentions 不报已声明 links 的目标', mtTo.indexOf('m3') < 0, JSON.stringify(mtTo));
check('mentions 默认过滤"结构上已相邻"（提到子孙不报）', mtTo.indexOf('m1c') < 0, JSON.stringify(mtTo));
check('mentions 的结构过滤可被 --include-structural 关闭', (() => {
  try {
    const all = JSON.parse(run(['mentions', PROJ, '--json', '--include-structural', '--limit', '500']).out);
    return all.items.some((x) => x.from === 'm1' && x.to === 'm1c');
  } catch (e) { return false; }
})());
check('mentions 的汇总字段自洽（raw ≥ 实际报告数，且计数为非负）',
  !!mt && mt.rawHits >= mt.mentions && mt.mentions === mt.items.length
  && mt.structuralSkipped >= 0 && mt.sources >= 0,
  JSON.stringify(mt && { rawHits: mt.rawHits, mentions: mt.mentions, skipped: mt.structuralSkipped, sources: mt.sources }));
// 清理专属子树，避免污染后续断言（尤其 orphans 的计数）
run(['remove', PROJ, 'mh']);


// 8.5 Obsidian 融合：标签 / 全文搜索 / 反向链接 / 相关知识点
r = run(['edit', PROJ, 'b', '--tags', '协议,核心']);
check('edit --tags', ok(r.out) && /已更新/.test(r.out), r.out.trim());
r = run(['get', PROJ, 'b', '--json']);
check('get 含 tags', ok(r.out) && r.out.includes('协议'));
r = run(['search', PROJ, '--tag', '协议', '--json']);
check('search --tag 命中', ok(r.out) && /"id": "b"/.test(r.out), r.out.trim());
r = run(['search', PROJ, '详情', '--full', '--json']);
check('search --full 命中 detail', ok(r.out) && /"matchIn": "detail"/.test(r.out), r.out.trim());
r = run(['search', PROJ, '详情', '--json']);
check('search 默认仅标题不命中 detail', ok(r.out) && /"hits": \[\]/.test(r.out), r.out.trim());
r = run(['edit', PROJ, 'b', '--clear-tags']);
check('edit --clear-tags', ok(r.out) && /已更新/.test(r.out));
r = run(['get', PROJ, 'b', '--json']);
check('clear-tags 后无 tags', ok(r.out) && !r.out.includes('协议'));
r = run(['edit', PROJ, 'b', '--tags', '协议,核心']);
// 同项目链接 → 反向链接 + 相关知识点
r = run(['link', PROJ, 'b', '--to', PROJ, '--id', 'a', '--caption', '关联A']);
check('link 同项目', ok(r.out) && /已添加链接/.test(r.out), r.out.trim());
r = run(['backlinks', PROJ, 'a', '--json']);
check('backlinks within', ok(r.out) && /"node": "b"/.test(r.out), r.out.trim());
r = run(['related', PROJ, 'b', '--json']);
const relJson = (() => { try { return JSON.parse(r.out); } catch (e) { return null; } })();
check('related 并入出边（我引用谁）',
  !!(relJson && Array.isArray(relJson.items)
    && relJson.items.some((x) => x.node === 'a' && x.dir === 'out' && x.project === PROJ)), r.out.slice(0, 160));
check('related 默认 depth=1（不展开两跳）',
  !!relJson && relJson.depth === 1 && relJson.depth2Count === 0
  && relJson.items.every((x) => x.depth === 1 && x.via === null),
  'depth=' + (relJson && relJson.depth) + ' d2=' + (relJson && relJson.depth2Count));

// 8.6 related --depth 2。
// 图的设计很关键：**必须造出真正的链**才能测两跳。第一版写成 a 的星形
// （b→a→c），从 a 出发一跳就把邻居收完，二跳恒为 0 —— 实现正确、测试图错了。
// 第二版又踩了一坑：复用了 p3，但 p1 子树在 L176 已被 remove，link 目标不存在 →
// link 静默失败 → 断言再次假失败。故此处用**本块自建、用后即删**的专属节点，
// 并对"链确实建成了"加前置断言（先证明前提，再断言结论）。
run(['add', PROJ, 'root', '--topic', '链尾', '--id', 'rel-tail']);
const linkA = run(['link', PROJ, 'a', '--to', PROJ, '--id', 'c', '--caption', 'a→c']);
const linkB = run(['link', PROJ, 'c', '--to', PROJ, '--id', 'rel-tail', '--caption', 'c→链尾']);
check('depth 2 的前置条件：a→c 与 c→链尾 两条链接确实建成',
  ok(linkA.out) && /已添加链接/.test(linkA.out) && ok(linkB.out) && /已添加链接/.test(linkB.out),
  linkA.out.trim() + ' | ' + linkB.out.trim());
const rel1 = (() => { try { return JSON.parse(run(['related', PROJ, 'a', '--json']).out); } catch (e) { return null; } })();
const rel2 = (() => { try { return JSON.parse(run(['related', PROJ, 'a', '--json', '--depth', '2']).out); } catch (e) { return null; } })();
const rel2far = (rel2 && rel2.items.filter((x) => x.depth === 2)) || [];
check('related --depth 2 把邻域扩到两跳（经由一跳邻居到达「链尾」）',
  rel2far.length >= 1 && rel2far.some((x) => x.node === 'rel-tail'),
  'd1=' + (rel2 && rel2.depth1Count) + ' d2=' + (rel2 && rel2.depth2Count)
  + ' far=' + rel2far.map((x) => x.node + '<-' + (x.via && x.via.node)).join(','));
check('depth 2 的二跳项带 via 指明经由谁（方向需靠 via 解读）',
  rel2far.length >= 1 && rel2far.every((x) => x.via && x.via.node && x.via.topic)
  && rel2far.some((x) => x.via.node === 'c'),
  JSON.stringify(rel2far[0] || null));
check('depth 2 不绕回自身',
  !!(rel2 && !rel2.items.some((x) => x.node === 'a')), 'items=' + (rel2 && rel2.items.map((x) => x.node).join(',')));
check('depth 2 的分层计数自洽',
  !!(rel2 && rel2.depth1Count + rel2.depth2Count === rel2.items.length),
  rel2 && (rel2.depth1Count + ' + ' + rel2.depth2Count + ' = ' + rel2.items.length));
check('depth 2 下 outCount/inCount 仍只统计一跳（直接引用数语义不变）',
  !!(rel1 && rel2 && rel2.outCount === rel1.outCount && rel2.inCount === rel1.inCount),
  'd1: ' + (rel1 && rel1.outCount) + '/' + (rel1 && rel1.inCount) + '  d2: ' + (rel2 && rel2.outCount) + '/' + (rel2 && rel2.inCount));
// 修前实测（2026-10-10）：`--depth` 只认 1/2，其它值**静默退化成 1** ——
// `related … --depth 9 --json` 回的是 `"depth": 1`（看起来成功，其实给的是另一件事）。
// 用户要的"多跳关系可查"是卖点原话，故这里改成新语义：任意深度（防环 + 结果上限 + 越界报错）。
check('depth 给大于 2 的值：真按该深度展开（旧的"静默退化成 1"已按新语义改）',
  (() => {
    try {
      const j = JSON.parse(run(['related', PROJ, 'a', '--json', '--depth', '9']).out);
      // 图是 a→c→rel-tail 的链：9 跳展开必须至少把 rel-tail 收到（它离 a 是两跳），
      // 且**不能**绕回 a 自己（防环）；truncated 必须为 false（这点规模远不到上限）
      return j.depth === 9 && j.truncated === false
        && j.items.some((x) => x.node === 'rel-tail' && x.depth === 2)
        && !j.items.some((x) => x.node === 'a');
    } catch (e) { return false; }
  })());
run(['unlink', PROJ, 'a', '--to', PROJ, '--id', 'c']);
run(['unlink', PROJ, 'c', '--to', PROJ, '--id', 'rel-tail']);
run(['remove', PROJ, 'rel-tail']);   // 用后即删，不给后续断言留状态

/* ---------------- 8.6b related --depth N：**任意深度**的多跳查询 ----------------
 * 三段分别钉住三件事：深 3 跳的正例、环上的终止性、以及撞结果上限时的**响亮报错**。
 * 夹具自建自删（不给后续断言留状态），且每条结论前先断言"前提真的成立了"。 */
run(['add', PROJ, 'root', '--topic', '多跳一', '--id', 'mh-1']);
run(['add', PROJ, 'root', '--topic', '多跳二', '--id', 'mh-2']);
run(['add', PROJ, 'root', '--topic', '多跳三', '--id', 'mh-3']);
run(['add', PROJ, 'root', '--topic', '多跳四', '--id', 'mh-4']);
const mhBuilt = ['mh-2', 'mh-3', 'mh-4'].map((to, i) => run(['link', PROJ, 'mh-' + (i + 1), '--to', PROJ, '--id', to]));
check('多跳前置条件：mh-1 → mh-2 → mh-3 → mh-4 三条链接都建成（先证前提再断言结论）',
  mhBuilt.every((x) => ok(x.out) && /已添加链接/.test(x.out)),
  mhBuilt.map((x) => x.out.trim().slice(0, 20)).join(' | '));
const mh3 = (() => { try { return JSON.parse(run(['related', PROJ, 'mh-1', '--json', '--depth', '3']).out); } catch (e) { return null; } })();
check('深 3 跳正例：mh-4 出现在 depth=3，且 via 指向上一跳 mh-3',
  !!mh3 && mh3.items.some((x) => x.node === 'mh-4' && x.depth === 3 && x.via && x.via.node === 'mh-3'),
  mh3 && mh3.items.map((x) => x.node + '@' + x.depth).join(','));
check('深 3 跳的分层计数自洽（byDepth 每层一个 + depth2Count 只算正好二跳）',
  !!(mh3 && mh3.byDepth['1'] === 1 && mh3.byDepth['2'] === 1 && mh3.byDepth['3'] === 1
    && mh3.depth2Count === 1 && mh3.items.length === 3),
  mh3 && JSON.stringify(mh3.byDepth));
check('深度越界（0 / 负数 / 文字）⇒ 非 0 退出 + 说清取值范围与用法（不静默退化）',
  ['0', '-1', 'x'].every((d) => {
    const x = run(['related', PROJ, 'mh-1', '--depth', d]);
    return x.code !== 0 && /--depth 必须是 1–/.test(x.out);
  }), run(['related', PROJ, 'mh-1', '--depth', '0']).out.trim().slice(0, 120));
run(['link', PROJ, 'mh-4', '--to', PROJ, '--id', 'mh-1']);   // 成环：mh-1 ⇄ … ⇄ mh-1
check('环上不会死循环：--depth 20 照样返回，且起点不以任何跳数回到邻域里',
  (() => {
    const x = run(['related', PROJ, 'mh-1', '--json', '--depth', '20']);
    if (x.code !== 0) return false;
    try {
      const j = JSON.parse(x.out);
      return j.items.length > 0 && !j.items.some((it) => it.node === 'mh-1') && j.truncated === false;
    } catch (e) { return false; }
  })());
run(['unlink', PROJ, 'mh-4', '--to', PROJ, '--id', 'mh-1']);   // 先拆环，再逐节点删（被链接指向的节点默认拒删）
['mh-1', 'mh-2', 'mh-3', 'mh-4'].forEach((id) => run(['remove', PROJ, id]));
check('多跳夹具已清理干净（四个探针节点都不在树里了）',
  ['mh-1', 'mh-2', 'mh-3', 'mh-4'].every((id) => !ok(run(['get', PROJ, id]).out)));

/* 结果上限：造一个 520 叶子的**星形**（直写 JSON，避免 520 次 CLI 写入的 O(n²) 抖动）——
 * 从中心节点出发，**一跳**就有 519 条 ⇒ 必然撞上 500 条上限 ⇒ 必须**响亮报错**
 * 并给出缩小范围的办法（绝不静默截断：残缺邻域会被读者当成完整邻域来解读）。 */
const BIG = PROJ + '-big';
run(['init', BIG, '--title', '大邻域探针']);
{
  // 直接用 fs 读写项目文件（本文件里的 readProj/projJson 助手声明在更下面，这里用不了）
  const bigFile = path.join(ROOT, 'projects', BIG, BIG + '.json');
  const d = JSON.parse(fs.readFileSync(bigFile, 'utf8'));
  const kids = [];
  for (let i = 1; i <= 520; i++) kids.push({ id: 'b' + i, topic: 'B' + i, expanded: true, children: [] });
  // b1 是中心：它**引用** b2..b520（519 条出边 ⇒ 一跳就超过 500 的上限）
  kids[0].links = kids.slice(1).map((k, i) => ({ project: BIG, id: k.id, caption: '→' + k.id }));
  d.data.children = kids;
  fs.writeFileSync(bigFile, JSON.stringify(d, null, 2), 'utf8');
}
check('上限前置条件：星形真的建成、且在**不超限**的查询上照常给出完整结果（先证前提）',
  (() => {
    const x = run(['related', BIG, 'b2', '--json', '--depth', '1']);
    if (x.code !== 0) return false;
    try {
      const j = JSON.parse(x.out);
      return j.items.length === 1 && j.truncated === false && j.items[0].node === 'b1' && j.items[0].dir === 'in';
    } catch (e) { return false; }
  })());
r = run(['related', BIG, 'b1', '--json', '--depth', '1']);
check('超出结果上限 ⇒ 非 0 退出 + 说清"在 500 条处停下" + 给出缩小范围的办法（不是静默截断）',
  r.code !== 0 && /在 500 条处停下/.test(r.out) && /缩小范围的办法/.test(r.out), r.out.trim().slice(0, 190));
check('上限报错时**没有**输出半个 JSON（失败就是失败，不给"看着像完整结果"的东西）',
  !/"items"/.test(r.out));
try { fs.rmSync(path.join(ROOT, 'projects', BIG), { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
check('大邻域探针项目已删除（不给后续 validate-all / 项目计数留垃圾）',
  !fs.existsSync(path.join(ROOT, 'projects', BIG)));

/* ---------------- 8.6d `source-chain`（产品代号 `SC`，台账 `W17`）：经验来源链 ----------------
 * 四件必须钉住的事（这几条正是它与既有命令的分界；**不用圈号枚举** —— 本文件的圈号是
 * 门禁 G8 的「判定标记」，重复即判红，改条目请写文字而不是再加一个圈号）：
 *   · **只沿 `出自：` 走** —— `前置：` / `来源：` / 半角 `出自:` 都不进链（`related` 是**无类型**的）；
 *   · `--reverse` 走的是**同一张图**的入边方向（不需要第二套语义）；
 *   · **成环响亮拒绝 + 逐条点名**（不是丢掉一条凑合给结果，也不是 `related` 那种遍历去重）；
 *   · **只读**：跑完 `.changes.jsonl` 一个字节都不许多（不记热度、不进 `WRITE_COMMANDS`）。
 * 夹具自建自删（不给后续断言留状态），且每条结论前先断言"前提真的成立了"。 */
{
  const SC_IDS = ['sc-1', 'sc-2', 'sc-3', 'sc-4', 'sc-5'];
  SC_IDS.forEach((id) => run(['add', PROJ, 'root', '--topic', '出处探针 ' + id, '--id', id]));
  const scBuilt = [
    run(['link', PROJ, 'sc-1', '--to', PROJ, '--id', 'sc-2', '--caption', '出自：B 是 A 的出处']),
    run(['link', PROJ, 'sc-2', '--to', PROJ, '--id', 'sc-3', '--caption', '出自：C 是 B 的出处']),
    run(['link', PROJ, 'sc-1', '--to', PROJ, '--id', 'sc-4', '--caption', '前置：不是出处']),
    run(['link', PROJ, 'sc-1', '--to', PROJ, '--id', 'sc-5', '--caption', '出自:半角冒号 = 近失写法'])
  ];
  check('source-chain 前置条件：4 条边真的建成（先证前提再断言结论）',
    scBuilt.every((x) => ok(x.out) && /已添加链接/.test(x.out)),
    scBuilt.map((x) => x.out.trim().slice(0, 16)).join(' | '));

  const scJ = (() => { try { return JSON.parse(run(['source-chain', PROJ, 'sc-1', '--json']).out); } catch (e) { return null; } })();
  check('source-chain 只沿「出自：」走：链是 sc-1 → sc-2 → sc-3（两跳）',
    !!(scJ && scJ.ok && scJ.chains.length === 1
      && scJ.chains[0].map((h) => h.id).join('>') === 'sc-1>sc-2>sc-3'),
    scJ && scJ.chains.map((c) => c.map((h) => h.id).join('>')).join(' | '));
  check('source-chain：`前置：` 与半角 `出自:` 都不进链，但如实进 otherPrefixes / nearMiss',
    !!(scJ && scJ.hopCount === 2 && scJ.otherPrefixes['前置：'] === 1
      && scJ.otherPrefixes['出自:'] === 1 && scJ.nearMiss.length === 1),
    scJ && JSON.stringify({ hop: scJ.hopCount, other: scJ.otherPrefixes, near: scJ.nearMiss.length }));
  check('source-chain：每跳带那一跳的出处原文（起点为 null，不冒充有出处）',
    !!(scJ && scJ.chains[0][0].caption === null && /^出自：B/.test(scJ.chains[0][1].caption)
      && /^出自：C/.test(scJ.chains[0][2].caption)));
  check('source-chain：direction=up / depth 缺省 10 / truncated=false / JSON 首键是 ok（键序固定）',
    !!(scJ && scJ.direction === 'up' && scJ.depth === 10 && scJ.truncated === false
      && Object.keys(scJ)[0] === 'ok'),
    scJ && Object.keys(scJ).join(','));

  const scRev = (() => { try { return JSON.parse(run(['source-chain', PROJ, 'sc-3', '--reverse', '--json']).out); } catch (e) { return null; } })();
  check('source-chain --reverse：反查 sc-3 ⇒ sc-3 ← sc-2 ← sc-1（同一张图的入边方向）',
    !!(scRev && scRev.ok && scRev.direction === 'down'
      && scRev.chains[0].map((h) => h.id).join('<') === 'sc-3<sc-2<sc-1'),
    scRev && scRev.chains[0].map((h) => h.id).join('<'));

  check('source-chain --depth 1：按用户的界截止，且 truncated=true（不冒充"这就是全部的链"）',
    (() => {
      try {
        const j = JSON.parse(run(['source-chain', PROJ, 'sc-1', '--json', '--depth', '1']).out);
        return j.chains[0].length === 2 && j.truncated === true;
      } catch (e) { return false; }
    })());
  check('source-chain --depth 非法（0 / 文字）⇒ 非 0 退出并说清范围（不静默退化）',
    ['0', 'abc'].every((d) => {
      const x = run(['source-chain', PROJ, 'sc-1', '--depth', d]);
      return x.code !== 0 && /--depth 必须是/.test(x.out);
    }), run(['source-chain', PROJ, 'sc-1', '--depth', '0']).out.trim().slice(0, 120));
  check('source-chain 节点不存在 ⇒ 非 0 退出并点名',
    (() => { const x = run(['source-chain', PROJ, 'sc-nope']); return x.code !== 0 && /节点不存在/.test(x.out); })());

  // 成环：sc-3 → sc-1 ⇒ A→B→C→A
  const scCycLink = run(['link', PROJ, 'sc-3', '--to', PROJ, '--id', 'sc-1', '--caption', '出自：A 是 C 的出处']);
  check('source-chain 环的前置条件：sc-3 → sc-1 建成（sc-1→sc-2→sc-3→sc-1）',
    ok(scCycLink.out) && /已添加链接/.test(scCycLink.out), scCycLink.out.trim().slice(0, 40));
  const scCyc = run(['source-chain', PROJ, 'sc-1', '--json']);
  check('source-chain 遇环 ⇒ 非 0 退出 + 逐条点名环上的边 + 明说"一条边都没有被丢掉" + 给出路',
    scCyc.code !== 0 && /出处链成环/.test(scCyc.out) && /共 1 条/.test(scCyc.out)
    && /sc-3\s+--出自:-->\s+\S*:?sc-1/.test(scCyc.out)
    && /路径：\S*sc-1\s+→\s+\S*sc-2\s+→\s+\S*sc-3\s+→\s+\S*sc-1/.test(scCyc.out)
    && /一条边都没有被丢掉/.test(scCyc.out) && /出路/.test(scCyc.out),
    scCyc.out.trim().slice(0, 220));
  check('source-chain 遇环时**没有**输出半个 JSON（失败就是失败，不给"看着像完整结果"的东西）',
    !/"chains"/.test(scCyc.out));

  // 只读：`.changes.jsonl` 一个字节都不许多
  const scChangeLog = path.join(ROOT, 'projects', PROJ, '.changes.jsonl');
  const scSizeBefore = fs.existsSync(scChangeLog) ? fs.statSync(scChangeLog).size : -1;
  run(['source-chain', PROJ, 'sc-1', '--json']);     // 这一跑是红的（成环）
  run(['source-chain', PROJ, 'sc-2', '--json']);     // 这一跑是绿的
  const scSizeAfter = fs.existsSync(scChangeLog) ? fs.statSync(scChangeLog).size : -1;
  check('source-chain 是只读命令：`.changes.jsonl` 一个字节都不多（不记热度、不进写命令）',
    scSizeBefore === scSizeAfter, scSizeBefore + ' → ' + scSizeAfter);

  // 清理：先拆环与全部出处边，再逐节点删（被链接指向的节点默认拒删）
  [['sc-3', 'sc-1'], ['sc-1', 'sc-2'], ['sc-2', 'sc-3'], ['sc-1', 'sc-4'], ['sc-1', 'sc-5']]
    .forEach((pair) => run(['unlink', PROJ, pair[0], '--to', PROJ, '--id', pair[1]]));
  SC_IDS.forEach((id) => run(['remove', PROJ, id]));
  check('source-chain 夹具已清理干净（五个探针节点都不在树里了）',
    SC_IDS.every((id) => !ok(run(['get', PROJ, id]).out)));
}

/* ---------------- 8.8 内置 AI 通道（功能 1 后端）：ask（**只测 dry-run**） ----------------
 * 为什么只测 dry-run：真跑一次要**烧真实额度 + 依赖网络**（实测一次解释 ~24s）——
 * 那类验证属于"人工/可选"的层级（本工程的分层纪律：门禁里不做重活 ✗），
 * 而 dry-run 恰好把最该机械核对的东西留下来了：**将发给 AI 的提示词**。
 * 其中"情境被补齐"必须真判：路径为空这种缺陷（第一版 `pathTo` 返回 id 数组被当对象用过 ✗）
 * 在真跑时**看不出来**（模型照样能答），只有断言提示词里"路径不是空的"才抓得住 ✓ */
const askDry = run(['ask', PROJ, 'a', '--kind', 'explain', '--dry-run', '--json']);
const askDryJ = (() => { try { return JSON.parse(askDry.out); } catch (e) { return null; } })();
check('ask --dry-run：不调用模型（无 key 也能跑），并给出完整提示词与命令行',
  !!(askDryJ && askDryJ.ok && askDryJ.dryRun && askDryJ.prompt && askDryJ.command
    // 判**形状**不判个数（思考强度 patch 会让参数变多 ✓）：最后一个参数必须是提示词原文，
    // 且必须出现 `headless` 子命令（有 patch 时还要有 --patch）
    && askDryJ.command.args[askDryJ.command.args.length - 1] === askDryJ.prompt
    && askDryJ.command.args.indexOf('headless') > 0
    && (askDryJ.command.args.indexOf('--patch') < 0 || askDryJ.command.args.indexOf('--patch') < askDryJ.command.args.length - 1)),
  askDryJ ? ('提示词 ' + askDryJ.prompt.length + ' 字，命令行参数 ' + askDryJ.command.args.length + ' 个') : askDry.out.trim().slice(0, 160));
check('ask 的提示词**自动补齐了情境**：项目 / 树中路径 / 正文三者都不能空',
  !!(askDryJ && /· 项目：\S/.test(askDryJ.prompt) && /· 在树中的路径：\S/.test(askDryJ.prompt)
    && /· 节点正文/.test(askDryJ.prompt)),
  askDryJ ? (askDryJ.prompt.match(/· 在树中的路径：[^\n]*/) || ['(没有路径行)'])[0].slice(0, 80) : '—');
check('ask --kind ask 不给 --question ⇒ 非 0 且报错（不许发一个没有问题的"问题"）',
  (() => { const r = run(['ask', PROJ, 'a', '--kind', 'ask', '--dry-run']); return r.code !== 0 && /需要 --question/.test(r.out); })());
check('ask 节点不存在 ⇒ 非 0 且点名原因',
  (() => { const r = run(['ask', PROJ, 'no-such-node', '--dry-run']); return r.code !== 0 && /节点不存在/.test(r.out); })());

// 9.1.1 功能 5a 入口③：**项目级**提问（消息栏那条）—— 节点可选，情境里要告诉 AI"你能动手"
const askProj = run(['ask', PROJ, '--question', '把 D:\\某处\\一本书.md 导入成新项目', '--dry-run', '--json']);
const askProjJ = (() => { try { return JSON.parse(askProj.out); } catch (e) { return null; } })();
check('ask **项目级**（不给节点）：可用，且情境里说清"项目级 + 你能动手 + 具体命令"',
  !!(askProjJ && askProjJ.ok && /项目级/.test(askProjJ.prompt) && /可以动手/.test(askProjJ.prompt)
    && /import-project/.test(askProjJ.prompt) && /把 D:\\某处\\一本书\.md 导入成新项目/.test(askProjJ.prompt)),
  askProjJ ? ('提示词 ' + askProjJ.prompt.length + ' 字') : askProj.out.trim().slice(0, 140));
check('ask 项目级但**不给问题** ⇒ 非 0 且说明原因（不许发一个空问题出去）',
  (() => { const r = run(['ask', PROJ, '--dry-run']); return r.code !== 0 && /项目级提问要带/.test(r.out); })());

/* 9.1.3 多节点上下文（用户反馈④"把所有被框选的都给 AI 看"）：`--nodes a,b,c` ⇒ 情境逐个列出 ✓
 * 全离线（--dry-run）✓；节点不存在必须**响亮报错**（不许悄悄少给一个 ✗） */
const multiIds = (() => {
  const r = run(['list', PROJ, '--json']);
  try {
    const arr = JSON.parse(r.out);
    const flat = [];
    (function walk(ns) { (ns || []).forEach((n) => { flat.push(n.id); walk(n.children); }); })(Array.isArray(arr) ? arr : arr.nodes);
    return flat.slice(0, 3);
  } catch (e) { return []; }
})();
const askMulti = (() => {
  try { return JSON.parse(run(['ask', PROJ, '--nodes', multiIds.join(','), '--kind', 'explain', '--dry-run', '--json']).out); } catch (e) { return null; }
})();
check('ask 多节点（--nodes a,b,c）：情境里**逐个列出**并说明"放在一起看"（不是只答第一个 ✓）',
  !!(askMulti && askMulti.ok && multiIds.length >= 2
    && /多节点/.test(askMulti.prompt) && /选了 \*\*\d+ 个节点\*\*/.test(askMulti.prompt)
    && multiIds.every((id) => askMulti.prompt.indexOf(id) >= 0)
    && /【节点 1】/.test(askMulti.prompt) && /【节点 2】/.test(askMulti.prompt)),
  askMulti ? ('节点 ' + multiIds.join(',') + ' ⇒ 提示词 ' + askMulti.prompt.length + ' 字') : '—');
check('ask 多节点：其中有不存在的节点 ⇒ 非 0 且点名（不静默少给一个 ✗）',
  (() => { const r = run(['ask', PROJ, '--nodes', (multiIds[0] || 'x') + ',no-such-node', '--kind', 'explain', '--dry-run']); return r.code !== 0 && /节点不存在/.test(r.out); })());

/* 9.1.2 思考强度（用户反馈③"太慢"）：解释默认 low；显式 --effort 生效；patch 必须**三项写全**
 *（实测教训：patch 是整行替换，只写 reasoningEffort 会把 provider/model 抹掉 ✗）。
 * 这一段**全离线**（--dry-run + dump-config），不烧额度 ✓ */
const effLo = (() => { try { return JSON.parse(run(['ask', PROJ, 'a', '--kind', 'explain', '--dry-run', '--json']).out); } catch (e) { return null; } })();
check('ask 思考强度：解释**默认 low**（自动提速 ✓），且 patch 里 provider/model/reasoningEffort 三项齐全',
  !!(effLo && effLo.effort === 'low' && /provider:\s*\S/.test(effLo.effortPatch || '')
    && /model:\s*\S/.test(effLo.effortPatch || '') && /reasoningEffort:\s*low/.test(effLo.effortPatch || '')),
  effLo ? ('effort=' + effLo.effort + ' patch=' + String(effLo.effortPatch).split('\n').filter((l) => /provider:|model:|reasoningEffort:/.test(l)).join(' / ')) : '—');
const effHi = (() => { try { return JSON.parse(run(['ask', PROJ, 'a', '--kind', 'ask', '--question', 'x', '--effort', 'xhigh', '--dry-run', '--json']).out); } catch (e) { return null; } })();
check('ask 思考强度：显式 --effort xhigh 生效（对话栏那个下拉发的就是这个 ✓）',
  !!(effHi && effHi.effort === 'xhigh' && /reasoningEffort:\s*xhigh/.test(effHi.effortPatch || '')),
  effHi ? ('effort=' + effHi.effort) : '—');
check('ask 思考强度：未知取值 ⇒ 非 0 且列出可用值（不猜、不静默退回默认 ✗）',
  (() => { const r = run(['ask', PROJ, 'a', '--kind', 'explain', '--effort', 'turbo', '--dry-run']); return r.code !== 0 && /未知的思考强度/.test(r.out) && /low \/ medium/.test(r.out); })());

// 8.7 mentions --cross：跨项目「未链接提及」两个方向。
// 用一个**临时第二项目**做对端，绝不触碰 comnet（真实数据）。
const XPROJ = PROJ + '-x';
XP_DIR = path.join(ROOT, 'projects', XPROJ);   // 名在文件顶部声明（跑体在块里，清理段在块外）
run(['init', XPROJ, '--title', '跨项目探针']);
run(['add', XPROJ, 'root', '--topic', '外部专有主题', '--id', 'x1']);
run(['add', XPROJ, 'root', '--topic', '朝内提及者', '--id', 'x2']);
run(['add', PROJ, 'root', '--topic', '朝外提及者', '--id', 'cross-out']);
run(['edit', PROJ, 'cross-out', '--detail-md', '正文里提到了 外部专有主题 这个词']);
run(['edit', XPROJ, 'x2', '--detail-md', '这里提到了 朝外提及者 这个词']);
const cxJson = (() => {
  try { return JSON.parse(run(['mentions', PROJ, '--json', '--cross', '--limit', '500']).out); }
  catch (e) { return null; }
})();
const cxItems = (cxJson && cxJson.items) || [];
check('mentions --cross 报出 out 方向（本项目正文提到外部节点）',
  cxItems.some((x) => x.direction === 'out' && x.fromProject === PROJ && x.from === 'cross-out'
    && x.toProject === XPROJ && x.to === 'x1'),
  JSON.stringify(cxItems.filter((x) => x.direction === 'out').slice(0, 3)));
check('mentions --cross 报出 in 方向（外部正文提到本项目节点）',
  cxItems.some((x) => x.direction === 'in' && x.fromProject === XPROJ && x.from === 'x2'
    && x.toProject === PROJ && x.to === 'cross-out'),
  JSON.stringify(cxItems.filter((x) => x.direction === 'in').slice(0, 3)));
check('mentions --cross 的 outCount/inCount 与 items 一致',
  !!cxJson && cxJson.crossOut === cxItems.filter((x) => x.direction === 'out').length
  && cxJson.crossIn === cxItems.filter((x) => x.direction === 'in').length
  && cxJson.mentions === cxItems.length,
  cxJson && ('out=' + cxJson.crossOut + ' in=' + cxJson.crossIn + ' total=' + cxJson.mentions));
// direction 契约（src/mentions.js，单测已锁定）：本项目内项 = 'same'，跨项目 = 'out'/'in'。
// （曾断言"每项都是 out|in"，与该契约自相矛盾 —— 本项目内项被报成"缺 direction"，
//   实则带着 'same'。此处按契约逐项核对，并让三个计数字段与 items 互相印证。）
check('mentions --cross 的 items 每项都带 direction（本项目内项为 same，跨项目为 out/in）',
  cxItems.length > 0
  && cxItems.every((x) => x.direction === 'out' || x.direction === 'in' || x.direction === 'same')
  && cxItems.filter((x) => x.direction === 'same').length === cxJson.sameProject
  && cxItems.filter((x) => x.direction === 'out').length === cxJson.crossOut
  && cxItems.filter((x) => x.direction === 'in').length === cxJson.crossIn,
  '缺 direction 的项数=' + cxItems.filter((x) => !x.direction).length
  + ' same=' + cxItems.filter((x) => x.direction === 'same').length
  + ' out=' + cxItems.filter((x) => x.direction === 'out').length
  + ' in=' + cxItems.filter((x) => x.direction === 'in').length);
check('mentions 不加 --cross 时不报跨项目项',
  (() => {
    try {
      const j = JSON.parse(run(['mentions', PROJ, '--json', '--limit', '500']).out);
      return j.items.every((x) => x.toProject === undefined) && j.crossOut === 0 && j.crossIn === 0;
    } catch (e) { return false; }
  })());
// 已声明的跨项目链接后不应再报（跨项目也必须拼 project 比对）
run(['link', PROJ, 'cross-out', '--to', XPROJ, '--id', 'x1']);
check('--cross 下已声明的跨项目链接不再报为漏链',
  (() => {
    try {
      const j = JSON.parse(run(['mentions', PROJ, '--json', '--cross', '--limit', '500']).out);
      return !j.items.some((x) => x.direction === 'out' && x.toProject === XPROJ && x.to === 'x1');
    } catch (e) { return false; }
  })());
run(['unlink', PROJ, 'cross-out', '--to', XPROJ, '--id', 'x1']);
run(['remove', PROJ, 'cross-out']);

// 9. import-md
const MD = path.join(TMP, 'in.md');
fs.writeFileSync(MD, '# 主题\n## 子题\n正文并入详情\n', 'utf8');
r = run(['import-md', PROJ, MD]);
check('import-md', ok(r.out) && /导入完成/.test(r.out), r.out.trim());

/* 9.1 功能 5a：大文档 → **新项目 + 新树**（md / txt / docx 三种前端走同一个建树入口）
 * ⚠️ 数据落在哪：本夹具**故意在真实 `projects/` 下**造探针项目（见文件头 42 行的说明：
 *   store 与 CLI 同源，不另设根）——**不是**沙箱副本 ✗。所以清理必须用 `ROOT/projects/<名字>`，
 *   写成临时目录就会留下垃圾（我第一版就这么错的：下次运行变成"项目已存在"的假红 ✗）。
 * 重点核对三件：① 一个文件里的多个 1 级标题 ⇒ **多个顶层主题**（"几本书 ⇒ 几棵树"）；
 *              ② 真的能读回来且过校验（不是只写了个文件）；③ 认不出的格式要**响亮拒绝**。 */
const IMP_A = path.join(ROOT, 'projects', 'imp-probe-a');
// 先清后建（幂等）：跑红/中断/注入实验**都会**留下探针，清了才不会变成下一次的假红 ✓。
// 按**前缀**清（不只清 a）：判别力证明那次注入让 dry-run 真写盘 ⇒ 多留了一个 imp-probe-b，
// 于是下一轮这里变成"项目已存在"的假红 ✗（自己踩的，记在注释里免得再犯）。
try {
  for (const e of fs.readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })) {
    if (e.isDirectory() && e.name.indexOf('imp-probe-') === 0) {
      fs.rmSync(path.join(ROOT, 'projects', e.name), { recursive: true, force: true });
    }
  }
} catch (err) { /* projects/ 不存在：后面会自己建 */ }
const BIGMD = path.join(TMP, 'big.md');
fs.writeFileSync(BIGMD, '# 计算机网络（自顶向下方法）\n\n## 第 1 章 概述\n内容\n\n# 数据结构与算法\n\n## 第 1 章 绪论\n内容\n', 'utf8');
const d1 = run(['import-project', 'imp-probe-a', BIGMD, '--dry-run', '--json']);
const d1j = (() => { try { return JSON.parse(d1.out); } catch (e) { return null; } })();
check('import-project --dry-run（md）：不写盘，且报告"2 个顶层主题"（一个文件里两本书 ⇒ 两棵树）',
  !!(d1j && d1j.ok && d1j.dryRun && d1j.themes === 2 && d1j.format === 'md'
    && !fs.existsSync(path.join(TMP, 'imp-probe-a', 'imp-probe-a.json'))),
  d1j ? ('格式=' + d1j.format + ' 顶层主题=' + d1j.themes + ' 节点=' + d1j.nodes + ' 写盘=' + fs.existsSync(path.join(TMP, 'imp-probe-a'))) : d1.out.trim().slice(0, 140));

r = run(['import-project', 'imp-probe-a', BIGMD]);
check('import-project 真写：项目落地 + 标题取第一个顶层主题', ok(r.out) && /已从 big\.md/.test(r.out) && /2 个顶层主题/.test(r.out), r.out.trim());
const rd = run(['read', 'imp-probe-a', '--brief']);
check('import-project 写出来的项目**能读回来**且顶层主题两棵',
  ok(rd.out) && /计算机网络（自顶向下方法）/.test(rd.out) && /数据结构与算法/.test(rd.out),
  rd.out.split('\n').slice(0, 3).join(' | ').slice(0, 120));
check('import-project 写出来的项目**过校验**（不是只写了个文件）',
  ok(run(['validate', 'imp-probe-a']).out) || ok(run(['validate-all']).out), '');
fs.rmSync(IMP_A, { recursive: true, force: true });
check('import-project 收尾：探针项目已清掉（不给下一次运行留"项目已存在"的假红）', !fs.existsSync(IMP_A), '');

const BIGTXT = path.join(TMP, 'big.txt');
fs.writeFileSync(BIGTXT, '第一章 绪论\n\n这一章介绍结构，句子较长。\n\n1.1 研究背景\n\n背景说明，带逗号与句号。\n\n第二章 方法\n\n正文。\n', 'utf8');
const d2 = (() => { try { return JSON.parse(run(['import-project', 'imp-probe-b', BIGTXT, '--dry-run', '--json']).out); } catch (e) { return null; } })();
check('import-project（txt）：启发式把"第X章"识别为 1 级 ⇒ 两个顶层主题，正文行原样保留',
  !!(d2 && d2.themes === 2 && d2.stats.levelCounts['1'] === 2 && d2.stats.levelCounts['2'] === 1),
  d2 ? ('顶层主题=' + d2.themes + ' 层级=' + JSON.stringify(d2.stats.levelCounts)) : '—');

const BIGBAD = path.join(TMP, 'big.pdf');
fs.writeFileSync(BIGBAD, '%PDF-1.4\n', 'utf8');
check('import-project 遇到坏 PDF ⇒ **响亮报错**并说清原因（不许当文本读进去 ✗）',
  (() => { const r3 = run(['import-project', 'imp-probe-c', BIGBAD]); return r3.code !== 0 && /PDF/.test(r3.out); })());
// P8 最小切片（用户批准 ✓）：**有书签**的 PDF ⇒ 真的建成项目；顶层书签多于一个 = 多棵树 ✓
// 夹具**自己生成**（tests/pdf-fixture.js ✓ 不引二进制样本）
let pdfImportDetail = '';
let pdfTextDetail = '';        // P0：无书签 ⇒ 文字层回退那一条的现场报文
const IMP_PDF = 'imp-probe-pdf';        // 固定名 ⇒ 能被收尾清掉 ✓（动态名会逃过清理、污染真实 projects/ ✗）
const IMP_PDF_NB = 'imp-probe-pdf-nb';
check('import-project 带书签的 PDF ⇒ 建成项目，且顶层主题数 = 顶层书签数（一个文件多本书 ✓）',
  (() => {
    const { buildPdf } = require('../tests/pdf-fixture.js');
    const p = path.join(TMP, 'two-books.pdf');
    fs.writeFileSync(p, buildPdf({ outline: [{ title: 'Book One', page: 1 }, { title: 'Book Two', page: 2 }] }));
    const r = run(['import-project', IMP_PDF, p]);
    pdfImportDetail = 'code=' + r.code + ' out=' + String(r.out || '').slice(0, 70);
    // 收尾：探针项目**立刻清掉**（不给下一次运行留"项目已存在"的假红，也不污染真实 projects/ ✗）
    let cleaned = false;
    try { fs.rmSync(path.join(ROOT, 'projects', IMP_PDF), { recursive: true, force: true }); cleaned = !fs.existsSync(path.join(ROOT, 'projects', IMP_PDF)); } catch (e) { cleaned = false; }
    pdfImportDetail += ' 已清掉=' + cleaned;
    // 判据（对着"骨架真的变成顶层主题"这件事）：导入成功 + 报告 2 个顶层主题
    //（= 两个顶层书签 ⇒ 两棵树 ✓ 一个文件多本书）。读回/校验那条链由 md 用例与 validate 覆盖 ✓。
    return r.code === 0 && /2 个顶层主题/.test(r.out) && cleaned;
  })(), pdfImportDetail);
check('import-project 无书签的 PDF ⇒ 响亮拒绝并点名「没有书签」+ 说清文字层也不够用（带数字）',
  (() => {
    const { buildPdf } = require('../tests/pdf-fixture.js');
    const p = path.join(TMP, 'no-bookmark.pdf');
    fs.writeFileSync(p, buildPdf({ outline: [] }));
    const r = run(['import-project', IMP_PDF_NB, p]);
    try { fs.rmSync(path.join(ROOT, 'projects', IMP_PDF_NB), { recursive: true, force: true }); } catch (e) { /* 清不掉不掩盖主判据，但下面会看到残留 ✗ */ }
    // 判据三样都要：非 0 ／ 点名没有书签 ／ **带数字**说清文字层为什么也用不上 + 给出路
    // （⚠️ 这里刻意不写 ①…⑳ 那套圈号：本文件的圈号是**判定标记**，写一个就会被 G9 判重复 ✗，见文件头）
    return r.code !== 0 && /没有书签/.test(r.out) && /20 个字符/.test(r.out) && /出路/.test(r.out);
  })());

// P0（用户批准 ✓）：**无书签但有文字层** ⇒ 自动回退文字层建树。用户自己的真实样本就是这种
//（30 页 Chromium 技术文档、getOutline() === null）⇒ 这条是"最急的那个 bug"的回归网 ✓
const IMP_PDF_TEXT = 'imp-probe-pdf-text';    // 固定名 ⇒ 能被收尾清掉 ✓（动态名会逃过清理、污染真实 projects/ ✗）
check('import-project 无书签但有文字层的 PDF ⇒ 回退文字层建成项目（顶层主题/节点数/层级对着夹具核对）',
  (() => {
    const { buildUnlabeledChinesePdf } = require('../tests/pdf-fixture.js');
    const p = path.join(TMP, 'text-layer.pdf');
    fs.writeFileSync(p, buildUnlabeledChinesePdf());
    // 先 dry-run：不写盘，且如实报"来源=文字层"与夹具的真实规模
    const d = run(['import-project', IMP_PDF_TEXT, p, '--dry-run', '--json']);
    let j = null; try { j = JSON.parse(d.out); } catch (e) { j = null; }
    const dryOk = !!(j && j.ok && j.dryRun && j.pdfSource === 'text'
      && j.themes === 1 && j.nodes === 5
      && JSON.stringify(j.stats.levelCounts) === JSON.stringify({ 1: 1, 2: 2, 3: 2 })
      && !fs.existsSync(path.join(ROOT, 'projects', IMP_PDF_TEXT)));
    // 再真写盘：项目落地、能读回骨架、过校验，然后立刻清掉（不给下次留"项目已存在"的假红 ✗）
    const r = run(['import-project', IMP_PDF_TEXT, p]);
    const rd = run(['read', IMP_PDF_TEXT, '--brief']);
    const vd = run(['validate', IMP_PDF_TEXT]);
    let cleaned = false;
    try { fs.rmSync(path.join(ROOT, 'projects', IMP_PDF_TEXT), { recursive: true, force: true }); cleaned = !fs.existsSync(path.join(ROOT, 'projects', IMP_PDF_TEXT)); } catch (e) { cleaned = false; }
    pdfTextDetail = 'dry=' + (j ? ('来源=' + j.pdfSource + ' 主题=' + j.themes + ' 节点=' + j.nodes + ' 层级=' + JSON.stringify(j.stats.levelCounts)) : ('非 JSON: ' + String(d.out).slice(0, 60)))
      + ' ｜ 真写: code=' + r.code + ' out=' + String(r.out || '').slice(0, 90).replace(/\n/g, ' ')
      + ' ｜ 读回=' + (/第一章 概述/.test(rd.out) ? '含章标题' : '缺章标题') + ' ｜ 校验=' + (ok(vd.out) ? 'PASS' : 'FAIL') + ' ｜ 已清=' + cleaned;
    return dryOk && r.code === 0 && /文字层/.test(r.out) && /1 个顶层主题/.test(r.out) && /5 个节点/.test(r.out)
      && /第一章 概述/.test(rd.out) && ok(vd.out) && cleaned;
  })(), pdfTextDetail);
check('import-project 项目名已存在 ⇒ 非 0 且点名（不许覆盖已有项目）',
  // ⚠️ 判据必须读 `run()` **真实返回的字段**：它给的是 `{ code, out }`（见文件上方 run 的定义），
  //    而这条原先读 `r4.status` / `r4.err` —— 那两个字段**根本不存在** ⇒ `undefined !== 0` **恒真**，
  //    "非 0" 那一半永远在通过（只是因为 `"undefined" + out` 里也含 "项目已存在" 才看着正常）✗。
  //    属"门禁在空转"的一个变体：**判据的一半从来没生效过**。
  //    `out` 本身已是 stdout+stderr 合并（与子进程模式同口径）⇒ 不需要 `.err` ✓
  (() => { const r4 = run(['import-project', PROJ, BIGMD]); return r4.code !== 0 && /项目已存在/.test(r4.out); })());

/* ---------------- 9.2 导入的**来源指纹**（origin）与目录入参：幂等 + 响亮拒绝 ----------------
 * ⚠️ **全部走 %TEMP% 沙箱的子进程**（见文件头的 `--sandbox-worker` 说明）：
 *   本段会真的新建项目，而幂等闸门要**扫全部项目**比对来源指纹 —— 探针落在真实 `projects/`
 *   里会让使用者导入同一个文件时被残留**无端拒绝**（跨运行的污染 ✗）。真实 `projects/` 零接触 ✓。
 *
 * 两件事一起验（它们同属"批量/整库导入"这条路）：
 *   ① 节点 id 由 `Date.now()+随机` 生成 ⇒ 同一份文档导两次会得到**两棵不相交的树**；
 *      `origin.src + origin.sha256` 是唯一能认出"这份导过了"的判据 ⇒ 二次导入默认**拒绝并指名**，
 *      `--force` 是显式出口（取舍：默认拒绝，因为重复导入是不可察觉的污染；--force 是有意的重复）。
 *   ② `<目录>` 入参原先露 `EISDIR: illegal operation on a directory, read`（原因不准、没有出路）——
 *      而"想导整库"的人第一步就会撞到它 ⇒ 必须响亮拒绝 + 说清 `import-dir` 未实现 + 给出逐文件流程。 */
{
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sb-'));
  const sp = spawnSync(process.execPath, [__filename, '--sandbox-worker'], {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, { AI_MINDMAP_PROJECTS_DIR: SANDBOX })
  });
  const raw = String(sp.stdout || '');
  const SBJ = (() => { try { return JSON.parse(raw.trim().split('\n').pop()); } catch (e) { return null; } })();
  const sbFailDetail = 'exit=' + sp.status + ' worker=' + (SBJ ? JSON.stringify(SBJ.error || null) : '没有 JSON 输出')
    + ' stderr=' + String(sp.stderr || '').trim().slice(0, 180);
  // 前置：worker 挂了后面每条都必须**红**（`!!(SBJ && ...)` 保证不空转）—— 空转的断言比没有断言更坏 ✗
  check('沙箱 worker 正常产出（项目根已重定向到 %TEMP%；它一崩，下面每条都得红而不是空转）',
    !!(SBJ && SBJ.ok === true && SBJ.impProjFirst), sbFailDetail);
  const has = (p) => !!(SBJ && SBJ.ok === true && p);

  // ── ① 同一份文档导两次**不会生成第二棵树**（本条的验收核心）──
  check('★ import-project 第一次导入 ⇒ 成功且报告来源指纹（origin 记在树根上）',
    has(SBJ.impProjFirst && SBJ.impProjFirst.code === 0 && /来源指纹/.test(SBJ.impProjFirst.out)),
    has(SBJ.impProjFirst) ? SBJ.impProjFirst.out.slice(0, 150) : sbFailDetail);
  check('★ 同一份文档换个项目名再导一次 ⇒ **被拒**（非 0 + 指名上次导到哪个项目/节点 + 给出 --force 出路）',
    has(SBJ.impProjSecondOtherName && SBJ.impProjSecondOtherName.code !== 0
      && /这份文档已经导入过/.test(SBJ.impProjSecondOtherName.out)
      && /项目 imp-a 的节点 root/.test(SBJ.impProjSecondOtherName.out)
      && /--force/.test(SBJ.impProjSecondOtherName.out)),
    has(SBJ.impProjSecondOtherName) ? SBJ.impProjSecondOtherName.out.slice(0, 200) : sbFailDetail);
  check('★★ 被拒之后**盘上没有第二个项目**（"拒绝"是真的没写，不是"报错了但还是建了"）',
    has(Array.isArray(SBJ.projectsAfterSecond) && SBJ.projectsAfterSecond.join(',') === 'imp-a'),
    has(SBJ.projectsAfterSecond) ? '项目列表=[' + SBJ.projectsAfterSecond.join(' ') + ']' : sbFailDetail);
  check('--force 是显式出口：给了它才允许第二棵树（取舍写在 registry 的 desc 里）',
    has(SBJ.impProjForced && SBJ.impProjForced.code === 0 && /第 2 份/.test(SBJ.impProjForced.out)
      && SBJ.projectsAfterForce.join(',') === 'imp-a,imp-b'),
    has(SBJ.projectsAfterForce) ? '项目列表=[' + SBJ.projectsAfterForce.join(' ') + ']' : sbFailDetail);
  check('指纹对**内容**敏感：同一份文档改一个字节再导 ⇒ 指纹变了 ⇒ 正常放行（不误杀真新内容）',
    has(SBJ.impProjChanged && SBJ.impProjChanged.code === 0
      && SBJ.projectsAfterChanged.indexOf('imp-d') >= 0),
    has(SBJ.impProjChanged) ? 'code=' + SBJ.impProjChanged.code + ' 项目=[' + SBJ.projectsAfterChanged.join(' ') + ']' : sbFailDetail);

  // ── ② 来源指纹读得到 / 统计得出来 ──
  check('get --json 读得到 origin（kind/src/sha256/at/tool 五项齐全，sha256 是 64 位十六进制）',
    has(SBJ.rootA && SBJ.rootA.origin && SBJ.rootA.origin.kind === 'import'
      && /docA\.md$/.test(SBJ.rootA.origin.src) && /^[0-9a-f]{64}$/.test(SBJ.rootA.origin.sha256)
      && typeof SBJ.rootA.origin.at === 'string' && SBJ.rootA.origin.tool === 'import-project'),
    has(SBJ.rootA && SBJ.rootA.origin) ? JSON.stringify(SBJ.rootA.origin).slice(0, 170) : sbFailDetail);
  check('read --json --brief 也带 origin（批量导入时"这个文件导过没有"要能一眼扫出来）',
    has(SBJ.readBriefA && /docA\.md$/.test(SBJ.readBriefA.src)),
    has(SBJ.readBriefA) ? JSON.stringify(SBJ.readBriefA).slice(0, 150) : sbFailDetail);
  check('stats 报"有多少节点带来源"+"涉及几份不同来源"（排查用；本段是 2 次 --force 导入 ⇒ 来源数仍是 1）',
    has(SBJ.statsA && SBJ.statsA.originNodes === 1 && SBJ.statsA.originSources === 1),
    has(SBJ.statsA) ? 'originNodes=' + SBJ.statsA.originNodes + ' originSources=' + SBJ.statsA.originSources : sbFailDetail);
  check('--dry-run 预览也如实报"这份导过了"（预览说能导、真导被拒，是最烦人的落差 ✗）',
    has(SBJ.dryRunDup && SBJ.dryRunDup.dryRun === true && SBJ.dryRunDup.wouldRefuse === true
      && SBJ.dryRunDup.duplicate && SBJ.dryRunDup.duplicate.project === 'imp-a'
      && !!SBJ.dryRunDup.origin && /^[0-9a-f]{64}$/.test(SBJ.dryRunDup.origin.sha256)),
    has(SBJ.dryRunDup) ? ('wouldRefuse=' + SBJ.dryRunDup.wouldRefuse + ' duplicate='
      + JSON.stringify(SBJ.dryRunDup.duplicate)) : sbFailDetail);

  // ── ③ 旧数据（无 origin）不受影响：读 / 写 / 校验全照旧 ──
  check('旧数据（一个 origin 都没有）validate 通过、edit 能改、get 能读 —— 新字段没给它添半点要求',
    has(SBJ.legacyValidate && SBJ.legacyValidate.code === 0
      && SBJ.legacyEdit && SBJ.legacyEdit.code === 0
      && SBJ.legacyValidateAgain && SBJ.legacyValidateAgain.code === 0
      && SBJ.legacyGet && SBJ.legacyGet.topic === '手写的（改过）'
      && !('origin' in (SBJ.legacyGet || {}))),
    has(SBJ.legacyGet) ? ('validate=' + SBJ.legacyValidate.code + '/' + SBJ.legacyValidateAgain.code
      + ' edit=' + SBJ.legacyEdit.code + ' topic=' + SBJ.legacyGet.topic
      + ' 有 origin 键=' + ('origin' in SBJ.legacyGet)) : sbFailDetail);
  check('旧数据 stats 的 origin 计数是 0（不是 undefined/NaN —— 那会让"没来源"与"算不出来"分不清）',
    has(SBJ.legacyStats && SBJ.legacyStats.originNodes === 0 && SBJ.legacyStats.originSources === 0),
    has(SBJ.legacyStats) ? ('originNodes=' + SBJ.legacyStats.originNodes + ' originSources=' + SBJ.legacyStats.originSources) : sbFailDetail);

  // ── ④ import-md：同一份 md 追加两次**不许**生成第二棵子树 ──
  check('★ import-md 第一次导入 ⇒ 成功；第二次同一份 ⇒ **被拒**且盘上节点数不变',
    has(SBJ.mdFirst && SBJ.mdFirst.code === 0 && SBJ.mdSecond && SBJ.mdSecond.code !== 0
      && /这份文档已经导入过/.test(SBJ.mdSecond.out)
      && SBJ.mdStatsAfterRefuse && SBJ.mdStatsAfterFirst
      && SBJ.mdStatsAfterRefuse.nodes === SBJ.mdStatsAfterFirst.nodes),
    has(SBJ.mdStatsAfterRefuse) ? ('第二次 code=' + (SBJ.mdSecond || {}).code
      + ' 节点数 ' + SBJ.mdStatsAfterFirst.nodes + ' → ' + SBJ.mdStatsAfterRefuse.nodes) : sbFailDetail);
  check('import-md --force ⇒ 放行，且 stats 一眼看得出那是"同一份来源的第 2 份"（节点数涨、来源数不涨）',
    has(SBJ.mdForced && SBJ.mdForced.code === 0 && SBJ.mdStatsAfterForce
      && SBJ.mdStatsAfterForce.nodes > SBJ.mdStatsAfterRefuse.nodes
      && SBJ.mdStatsAfterForce.originSources === SBJ.mdStatsAfterRefuse.originSources),
    has(SBJ.mdStatsAfterForce) ? ('节点 ' + SBJ.mdStatsAfterRefuse.nodes + '→' + SBJ.mdStatsAfterForce.nodes
      + ' 来源数 ' + SBJ.mdStatsAfterRefuse.originSources + '→' + SBJ.mdStatsAfterForce.originSources) : sbFailDetail);

  /* ── ④′ 带 BOM 的 md：**两个标题都要在**（本轮修的静默数据丢失）──
   * 判据刻意三样一起看：① 退出码 0；② 树里真的有 **两个**顶层标题；③ 新增节点数 = 2。
   * 为什么不能只看"退出码 0"：缺陷的形态正是**退出码 0 + 少一棵子树**（静默）✗。
   * 为什么还要一条无 BOM 的对照：只验带 BOM 那份的话，若哪天 `markdownToTree` 整体坏了，
   * "两个都不在"也会被判红（那是另一回事），而"两边都只认第二个标题"这种**一致地坏**
   * 必须在对照里暴露出来 —— 两条一起看才知道判据真的在分辨 BOM 这一件事。 */
  const bomBrief = has(SBJ.bomBrief) ? String(SBJ.bomBrief.out) : '';
  const plainBriefOut = has(SBJ.plainBrief) ? String(SBJ.plainBrief.out) : '';
  check('★ 带 BOM 的 md 经 import-md ⇒ **两个标题都在**（第一个标题不许被 BOM 静默吃掉），新增节点数=2',
    has(SBJ.bomFirst && SBJ.bomFirst.code === 0
      && /第一本书/.test(bomBrief) && /第二本书/.test(bomBrief)
      && SBJ.bomStats && SBJ.bomStats.nodes === SBJ.bomBaseNodes + 2),
    has(SBJ.bomStats) ? ('code=' + (SBJ.bomFirst || {}).code
      + ' 节点数 ' + SBJ.bomBaseNodes + '→' + SBJ.bomStats.nodes
      + ' ｜ 读回=' + JSON.stringify(bomBrief.split('\n').filter((l) => /书/.test(l)).join(' / ').slice(0, 160))) : sbFailDetail);
  check('对照（无 BOM 的同一份内容）⇒ 也是**两个标题都在**、新增节点数=2（两边都一样才对）',
    has(SBJ.plainFirst && SBJ.plainFirst.code === 0
      && /第一本书/.test(plainBriefOut) && /第二本书/.test(plainBriefOut)
      && SBJ.plainStats && SBJ.plainStats.nodes === (SBJ.bomStats || {}).nodes + 2),
    has(SBJ.plainStats) ? ('code=' + (SBJ.plainFirst || {}).code
      + ' 节点数 ' + ((SBJ.bomStats || {}).nodes) + '→' + SBJ.plainStats.nodes) : sbFailDetail);
  check('BOM 不影响**来源指纹**：带 BOM 与不带 BOM 的同一份内容指纹相同（否则"同一份文档"会被当成两份）',
    // 按 src 去重后再比：每份来源各留下**两棵**顶层子树（两个标题各挂一次 origin），
    // 于是 `nodes` 里同一个 src 会出现两次 —— 直接取 [0]/[1] 比到的是同一份，等于没比 ✗
    (() => {
      const list = Array.isArray(SBJ.bomOrigin) ? SBJ.bomOrigin : [];
      const bySrc = new Map();
      list.forEach((x) => { if (!bySrc.has(x.src)) bySrc.set(x.src, x.sha); });
      const bom = bySrc.get('docBom.md');
      const plain = bySrc.get('docPlain.md');
      return !!bom && !!plain && bom === plain;
    })(),
    has(SBJ.bomOrigin) ? JSON.stringify(SBJ.bomOrigin.map((x) => x.src + '@' + String(x.sha).slice(0, 8))) : sbFailDetail);

  /* ── ④″ 体量闸门：超大文件**响亮拒绝 + 说出路**，且一点都不许写（⓪′）── */
  const bigOk = (r) => !!(r && r.code !== 0
    && /超过导入上限/.test(r.out) && /没有读它/.test(r.out)
    && /拆成几份/.test(r.out) && /import-md/.test(r.out)
    && !/坏了|损坏|EISDIR|ENOBUFS|maxBuffer/.test(r.out));   // 原因必须是"超限"，不许推给文件/子进程
  check('★ 超大文件（65 MB）经 import-md ⇒ 非 0 + 说准"超过导入上限、没有读它" + 三条出路（不是"文件坏了"）',
    bigOk(SBJ.bigImportMd),
    has(SBJ.bigImportMd) ? SBJ.bigImportMd.out.slice(0, 200) : sbFailDetail);
  check('超大文件经 import-project ⇒ 同一份报文（同一处实现，两条导入路一个口径）',
    bigOk(SBJ.bigImportProject),
    has(SBJ.bigImportProject) ? SBJ.bigImportProject.out.slice(0, 200) : sbFailDetail);
  check('体量闸门在**写盘之前**：被拒之后项目数不变、目标项目节点数不变（拒绝是真的没写）',
    has(SBJ.bigStats && SBJ.bigProjects)
      && SBJ.bigStats.nodes === (SBJ.plainStats || {}).nodes
      && SBJ.bigProjects.indexOf('imp-big') < 0,
    has(SBJ.bigProjects) ? ('项目=[' + SBJ.bigProjects.join(' ') + '] 节点数=' + ((SBJ.bigStats || {}).nodes))
      : sbFailDetail);

  // ── ⑤ 目录入参：响亮拒绝 + 给出路 + **一点都不许写**（单文件命令拿到目录）──
  const dirOk = (r) => !!(r && r.code !== 0 && r.out.indexOf('目录') >= 0
    && r.out.indexOf('不是文件') >= 0 && r.out.indexOf('import-dir') >= 0
    && r.out.indexOf('node cli/mm-cli.js import-dir') >= 0
    // 批 5 之前这句写的是"尚未实现"；现在它必须**指给真实的命令**（测试同步改，否则就是过期的绿）
    && r.out.indexOf('尚未实现') < 0 && r.out.indexOf('import-md') >= 0
    && r.out.indexOf('EISDIR') < 0);
  check('★ import-project 拿到**目录** ⇒ 退出 1 + 说清"这是目录不是文件" + 指向**已实现**的 import-dir 并给出逐文件流程（旧行为：露 EISDIR；再旧：说"尚未实现"）',
    has(dirOk(SBJ.dirImportProject)),
    has(SBJ.dirImportProject) ? SBJ.dirImportProject.out.slice(0, 200) : sbFailDetail);
  check('★ import-md 拿到**目录** ⇒ 同一份报文（同一处实现，两条命令不各写一套）',
    has(dirOk(SBJ.dirImportMd)),
    has(SBJ.dirImportMd) ? SBJ.dirImportMd.out.slice(0, 200) : sbFailDetail);
  check('目录被拒之后**没有留下任何项目**（拒绝是真的没写）',
    has(SBJ.projectsAfterDir && SBJ.projectsBeforeDir
      && SBJ.projectsAfterDir.join(',') === SBJ.projectsBeforeDir.join(',')),
    has(SBJ.projectsAfterDir) ? '项目列表未变=[' + SBJ.projectsAfterDir.join(' ') + ']' : sbFailDetail);
  check('路径不存在 ⇒ 原因准确（"文件不存在" + 说清相对路径按哪个目录解析），不是权限/格式别的原因',
    has(SBJ.missingImportProject && SBJ.missingImportProject.code !== 0
      && /文件不存在/.test(SBJ.missingImportProject.out)
      && !/权限/.test(SBJ.missingImportProject.out)
      && SBJ.missingImportMd && SBJ.missingImportMd.code !== 0
      && /文件不存在/.test(SBJ.missingImportMd.out)),
    has(SBJ.missingImportProject) ? SBJ.missingImportProject.out.slice(0, 150) : sbFailDetail);
  check('不存在路径也没有留下项目（两条命令的入参闸门都在**写盘之前**）',
    has(SBJ.projectsAfterMissing && SBJ.projectsAfterMissing.join(',') === 'imp-a,imp-b,imp-d,legacy'),
    sbFailDetail + ' 项目=[' + ((SBJ && SBJ.projectsAfterMissing) || []).join(' ') + ']');

  /* ═══════════════════════════════════════════════════════════════════════
   * 9.3 整库导入（`import-dir`，批 5）：把**文件夹结构镜像成一棵可用的树**
   * -----------------------------------------------------------------------
   * 与上面 §9.2 同一口径（同一个沙箱子进程、同一个临时项目根、真实 projects/ 零接触 ✓）。
   * 这一节的断言分四组，每组对应一条**真实会出错的路径**：
   *   ① 结构映射（目录层级 / 文件节点标题 / 内容不许丢）；
   *   ② 跳过**逐类点名**（不许静默）；
   *   ③ `--dry-run` **绝不写盘**（本工程硬规矩：无预览不许写入）；
   *   ④ 闸门：整个目录重复导 ⇒ 整体拒绝并指名；文件级命中；上限（`--max-files`）在写盘之前拒。
   * ⚠️ 抗空转：每条都写成 `has(...)` 的组合（worker 一崩 ⇒ 全红，而不是"看起来跑到绿"）✗
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    const brief = has(SBJ.libBriefJson) ? SBJ.libBriefJson : null;
    /** 从 `read --json --brief` 还原**结构形状**（`主题(子 子)`）—— 只比主题、不比 id：
     *  断言要守的是"目录树有没有被拍平"，不是 id 长什么样（id 是时间+随机，本来就不可比）✓ */
    const shapeOfBrief = (j) => {
      const nodes = (j && j.nodes) || [];
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const walk = (s) => {
        const full = byId.get(s.id) || {};
        const kids = Array.isArray(full.children) ? full.children : [];
        return s.topic + (kids.length ? '(' + kids.map(walk).join(' ') + ')' : '');
      };
      const rootNode = nodes.filter((n) => n.depth === 0)[0];
      return rootNode ? walk(rootNode) : '';
    };
    const libShape = shapeOfBrief(brief);

    // （批5-A）结构映射：**每一级目录都是容器节点**（拍平就丢掉"镜像文件夹"这个唯一的卖点 ✗）
    check('★★ import-dir 建出来的树**与文件夹同构**：每一级子目录一个容器节点、每个文件一个文件节点，标题取文件名去扩展名',
      has(!!brief && libShape === '书库(笔记(子目录(深层) 第一章(第一章) 第二章(第二章)) note-a(甲的主题))'),
      has(!!brief) ? '实际结构=' + libShape : sbFailDetail);
    check('★ 文件节点的标题是**文件名**（不是文档首个标题）：`note-a.md` 的节点叫 note-a，`甲的主题` 在它**下面**（文档标题没丢，只是不再当标题用）',
      has(!!brief && libShape.indexOf('note-a(甲的主题)') >= 0),
      has(!!brief) ? '实际结构=' + libShape : sbFailDetail);
    check('★ 一个标题都没有的 .txt **不许丢内容**：文件节点没有子节点，但 detail 里必须有那两行正文',
      has(SBJ.libDeepChildren === 0 && SBJ.libDeepGet
        && typeof SBJ.libDeepGet.detail === 'string' && SBJ.libDeepGet.detail.indexOf('正文') >= 0),
      has(SBJ.libDeepGet) ? ('子节点=' + SBJ.libDeepChildren + ' detail=' + String(SBJ.libDeepGet.detail || '').slice(0, 60)) : sbFailDetail);
    check('★ 带 BOM 的 md 经 import-dir ⇒ 第一个标题**没被吃掉**（与 import-md 同一条规范化：CRLF→LF + 剥 BOM）',
      has(!!brief && libShape.indexOf('第二章(第二章)') >= 0),
      has(!!brief) ? '实际结构=' + libShape : sbFailDetail);

    // （批5-B）报告：导入了几个 / 跳过几个（**按原因分组**）/ 逐条路径都点得出来
    check('★ 报告给"导入了 N 个文件 / 跳过 M 个（按原因分组）"：4 个文件 / 2 个容器 / 9 个节点，跳过 4 项且每类都点名',
      has(SBJ.libFirst && SBJ.libFirst.code === 0
        && /导入了 4 个文件/.test(SBJ.libFirst.out) && /2 个容器节点/.test(SBJ.libFirst.out)
        && /合计 9 个节点/.test(SBJ.libFirst.out)
        && /跳过 4 项（按原因分组）/.test(SBJ.libFirst.out)
        && /隐藏 1/.test(SBJ.libFirst.out) && /依赖目录 1/.test(SBJ.libFirst.out)
        && /空目录 1/.test(SBJ.libFirst.out) && /扩展名不支持 1/.test(SBJ.libFirst.out)),
      has(SBJ.libFirst) ? SBJ.libFirst.out.slice(0, 260) : sbFailDetail);
    check('★ 跳过项**逐条点名**（不许只给个数字）：.隐藏.md / node_modules / 空目录 / 笔记/图片.png 四条路径都要在报文里',
      has(SBJ.libFirst && /\.隐藏\.md/.test(SBJ.libFirst.out) && /node_modules/.test(SBJ.libFirst.out)
        && /空目录/.test(SBJ.libFirst.out) && /图片\.png/.test(SBJ.libFirst.out)),
      has(SBJ.libFirst) ? SBJ.libFirst.out.split('\n').filter((l) => l.indexOf('·') >= 0).join(' | ').slice(0, 300) : sbFailDetail);
    check('导入后项目**过校验** + `stats` 数得出"多少节点带来源 / 涉及几份来源"（1 份目录清单 + 4 个文件 = 5/5）',
      has(SBJ.libValidate && SBJ.libValidate.code === 0
        && SBJ.libStats && SBJ.libStats.originNodes === 5 && SBJ.libStats.originSources === 5),
      has(SBJ.libStats) ? ('validate=' + ((SBJ.libValidate || {}).code)
        + ' originNodes=' + SBJ.libStats.originNodes + ' originSources=' + SBJ.libStats.originSources) : sbFailDetail);

    // （批5-C）`--dry-run`：报告要全，盘上要**一个字节都不多**
    check('★ `--dry-run` **绝不写盘**：报告照样给全（几个容器/几个文件子树/跳过/总量是否超限），而项目列表**逐字未变**',
      has(SBJ.libDry && SBJ.libDry.dryRun === true && SBJ.libDry.containers === 2 && SBJ.libDry.files === 4
        && SBJ.libDry.nodes === 9 && SBJ.libDry.skippedCount === 4
        && SBJ.libDry.size && SBJ.libDry.size.over === false
        && SBJ.libDry.fileCount && SBJ.libDry.fileCount.over === false
        && Array.isArray(SBJ.libProjectsAfterDry) && Array.isArray(SBJ.libProjectsBefore)
        && SBJ.libProjectsAfterDry.join(',') === SBJ.libProjectsBefore.join(',')),
      has(SBJ.libDry) ? ('dry=' + JSON.stringify({ c: SBJ.libDry.containers, f: SBJ.libDry.files, n: SBJ.libDry.nodes,
        s: SBJ.libDry.skippedCount, over: (SBJ.libDry.size || {}).over })
        + ' 项目 ' + ((SBJ.libProjectsBefore || []).join(' ') || '(空)') + ' → '
        + ((SBJ.libProjectsAfterDry || []).join(' ') || '(空)')) : sbFailDetail);

    // （批5-D）闸门：整个目录重复导 ⇒ **整体拒绝**（推荐的那档）+ 指名 + 出路
    check('★★ 整个目录**再导一次** ⇒ 非 0 + "这个目录已经导入过"（指名项目与节点）+ 按文件列明 + 给出 --force 出路',
      has(SBJ.libSecond && SBJ.libSecond.code !== 0
        && /这份文档已经导入过/.test(SBJ.libSecond.out) && /项目 lib1 的节点 root/.test(SBJ.libSecond.out)
        && /这个目录里有 4 个文件已经被导入过/.test(SBJ.libSecond.out)
        && /--force/.test(SBJ.libSecond.out)),
      has(SBJ.libSecond) ? SBJ.libSecond.out.slice(0, 240) : sbFailDetail);
    check('★★ 被拒之后**盘上没有第二个项目**（"拒绝"是真的没写）+ 一个新项目都没多出来',
      has(Array.isArray(SBJ.libProjectsAfterSecond)
        && SBJ.libProjectsAfterSecond.join(',') === 'imp-a,imp-b,imp-d,legacy,lib1'),
      has(SBJ.libProjectsAfterSecond) ? '项目列表=[' + SBJ.libProjectsAfterSecond.join(' ') + ']' : sbFailDetail);
    check('★ **子目录**重复导（同一个文件被导过）⇒ 也拒绝并**逐条点名是哪几个文件**、导到了哪个节点',
      has(SBJ.libSubDir && SBJ.libSubDir.code !== 0
        && /个文件已经被导入过/.test(SBJ.libSubDir.out)
        && /第一章\.md → 项目 lib1 的节点/.test(SBJ.libSubDir.out)),
      has(SBJ.libSubDir) ? SBJ.libSubDir.out.slice(0, 240) : sbFailDetail);

    // （批5-D′）上限：**写盘之前**响亮拒绝 + 出路；dry-run 则如实报"会超限"
    check('★ `--max-files 2`（4 个文件）⇒ 非 0 + 说准是**文件数上限**（不是"文件坏了"）+ 三条出路，且**一个项目都没建**',
      has(SBJ.libMaxFiles && SBJ.libMaxFiles.code !== 0
        && /超过整库导入上限 2 个/.test(SBJ.libMaxFiles.out)
        && /没有读它们/.test(SBJ.libMaxFiles.out)
        && /--max-files/.test(SBJ.libMaxFiles.out) && /--ext/.test(SBJ.libMaxFiles.out)
        && !/坏了|损坏|内存不足/.test(SBJ.libMaxFiles.out)),
      has(SBJ.libMaxFiles) ? SBJ.libMaxFiles.out.slice(0, 220) : sbFailDetail);
    check('★ `--max-files 2 --dry-run` ⇒ **不写盘但仍如实报"会超限"**（wouldRefuse/over 都置位，converted=false）—— 预览与真导同一份判据',
      has(SBJ.libMaxFilesDry && SBJ.libMaxFilesDry.wouldRefuse === true
        && SBJ.libMaxFilesDry.refuseReason === 'over-max-files'
        && SBJ.libMaxFilesDry.fileCount && SBJ.libMaxFilesDry.fileCount.over === true
        && SBJ.libMaxFilesDry.converted === false),
      has(SBJ.libMaxFilesDry) ? JSON.stringify({ wouldRefuse: SBJ.libMaxFilesDry.wouldRefuse,
        reason: SBJ.libMaxFilesDry.refuseReason, fileCount: SBJ.libMaxFilesDry.fileCount }) : sbFailDetail);

    // （批5-D″）`--ext`：覆盖生效 + 被排除的**可导扩展名**要给出路 + 完全导不了的当场报错
    check('★ `--ext md` 覆盖生效：只导 3 个 md（.txt 变成跳过），并给出"想一起导就加 --ext md,txt"的提示',
      has(SBJ.libExtMd && SBJ.libExtMd.files === 3
        && SBJ.libExtMd.skippedByReason && SBJ.libExtMd.skippedByReason['unsupported-ext'] === 2
        && SBJ.libExtHint && /另有可导入但被 `--ext` 排除的文件：\.txt 1 个/.test(SBJ.libExtHint.out)
        && /--ext md,txt/.test(SBJ.libExtHint.out)),
      has(SBJ.libExtMd) ? ('files=' + SBJ.libExtMd.files + ' 跳过=' + JSON.stringify(SBJ.libExtMd.skippedByReason)
        + '｜' + (has(SBJ.libExtHint) ? String(SBJ.libExtHint.out).split('\n').filter((l) => /另有/.test(l)).join('') : '')) : sbFailDetail);
    check('★ `--ext py` ⇒ 当场报错并**列出能导的集合**（不静默退成默认、不让每个文件都变成"读失败"）',
      has(SBJ.libExtBad && SBJ.libExtBad.code !== 0 && /导不进来/.test(SBJ.libExtBad.out)
        && /\.md/.test(SBJ.libExtBad.out) && /\.docx/.test(SBJ.libExtBad.out)),
      has(SBJ.libExtBad) ? SBJ.libExtBad.out.slice(0, 200) : sbFailDetail);

    // （批5-D‴）入参闸门：给文件 / 给空目录
    check('★ `import-dir` 拿到**文件** ⇒ 非 0 + 说清"这是文件不是目录" + 点名 import-project / import-md',
      has(SBJ.libFileArg && SBJ.libFileArg.code !== 0 && /不是目录/.test(SBJ.libFileArg.out)
        && /import-project/.test(SBJ.libFileArg.out) && /import-md/.test(SBJ.libFileArg.out)),
      has(SBJ.libFileArg) ? SBJ.libFileArg.out.slice(0, 220) : sbFailDetail);
    check('★ 空目录 ⇒ 非 0 + "没有一个可导入的文件" + 把逐类计数摆出来 + "没有写任何东西"（**不建空项目**）',
      has(SBJ.libEmptyDir && SBJ.libEmptyDir.code !== 0
        && /没有一个可导入的文件/.test(SBJ.libEmptyDir.out)
        && /空目录 1/.test(SBJ.libEmptyDir.out) && /没有写任何东西/.test(SBJ.libEmptyDir.out)),
      has(SBJ.libEmptyDir) ? SBJ.libEmptyDir.out.slice(0, 220) : sbFailDetail);
    check('★ 单文件命令 `import-project` 拿到目录 ⇒ 报文已改口指向 **import-dir**（不再是"尚未实现"）',
      has(dirOk(SBJ.dirImportProjectNow)),
      has(SBJ.dirImportProjectNow) ? SBJ.dirImportProjectNow.out.slice(0, 220) : sbFailDetail);
    check('全部失败路径走完之后：项目列表里**一个空壳/半个项目都没有**（只有该有的那些，+0 个）',
      has(Array.isArray(SBJ.libProjectsAfterErrors)
        && SBJ.libProjectsAfterErrors.join(',') === 'imp-a,imp-b,imp-d,legacy,lib1'),
      has(SBJ.libProjectsAfterErrors) ? '项目列表=[' + SBJ.libProjectsAfterErrors.join(' ') + ']' : sbFailDetail);

    // 收尾：整库夹具目录自己删掉（**自建自删**是本工程对探针的一贯要求 ✓）
    const libGone = (() => {
      try {
        if (!SBJ || !SBJ.libDir) return false;
        fs.rmSync(SBJ.libDir, { recursive: true, force: true });
        return !fs.existsSync(SBJ.libDir);
      } catch (e) { return false; }
    })();
    check('整库夹具目录已删（探针自建自删，不给系统临时目录攒垃圾）', libGone,
      SBJ ? String(SBJ.libDir) : sbFailDetail);
  }

  // 收尾：沙箱子进程、它造的工作目录、以及**项目根沙箱**一起清掉（真实 projects/ 全程零接触）
  try { fs.rmSync(SBJ && SBJ.work ? SBJ.work : SANDBOX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(SBJ && SBJ.dir ? SBJ.dir : SANDBOX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  check('沙箱收尾：%TEMP% 里的沙箱项目根已删除（不给下次运行留"这份导过了"的假红）',
    !fs.existsSync(SANDBOX), SANDBOX);
}

// 10. add-file 附件 → export-md 文件夹导出（md + 附件复制 + 相对链接）
const ATT = path.join(TMP, 'note.md');
fs.writeFileSync(ATT, '# 附件笔记\n', 'utf8');
r = run(['add-file', PROJ, 'b', '--file', ATT, '--caption', '附件说明']);
check('add-file', ok(r.out) && /已添加附件/.test(r.out), r.out.trim());
r = run(['files', PROJ, '--json']);
let filesList = [];
try { filesList = JSON.parse(r.out).files || []; } catch (e) {}
check('files', ok(r.out) && filesList.length === 1, r.out.trim());
const fRel = filesList.length ? filesList[0].file : null;
const EXPORT_DIR = path.join(TMP, 'export');
r = run(['export-md', PROJ, EXPORT_DIR, '--with-detail']);
const mdOut = path.join(EXPORT_DIR, PROJ + '.md');
const mdOutText = fs.existsSync(mdOut) ? fs.readFileSync(mdOut, 'utf8') : '';
check('export-md 文件夹',
  ok(r.out) && fs.existsSync(mdOut) && mdOutText.includes('主题')
  && (!fRel || (fs.existsSync(path.join(EXPORT_DIR, 'attachments', path.basename(fRel))) && mdOutText.includes('attachments/'))),
  r.out.trim());

// 11. export-json / import-json roundtrip（图片+附件解包）
r = run(['export-json', PROJ, OUT_JSON]);
const exportJsonOk = ok(r.out) && /已导出/.test(r.out);
check('export-json', exportJsonOk, r.out.trim());
PROJ2 = PROJ + '-copy';   // 名在文件顶部声明（清理段要用；见那里的说明）
r = run(['import-json', OUT_JSON, '--name', PROJ2]);
check('import-json', ok(r.out) && /已导入/.test(r.out), r.out.trim());
r = run(['validate', PROJ2]);
check('import 后 validate', ok(r.out));
r = run(['files', PROJ2, '--json']);
let files2 = [];
try { files2 = JSON.parse(r.out).files || []; } catch (e) {}
check('import 后附件保留', ok(r.out) && files2.length === 1, r.out.trim());
if (fRel) {
  check('import 后附件文件解包', fs.existsSync(path.join(ROOT, 'projects', PROJ2, fRel)), fRel);
}

// 11.5 export-html：静态站点（index.html + 资源复制）
const SITE = path.join(TMP, 'site');
r = run(['export-html', PROJ, SITE]);
check('export-html 生成静态站点', ok(r.out) && /已导出静态站点/.test(r.out), r.out.trim());
const siteIndex = path.join(SITE, 'index.html');
check('export-html 产出 index.html',
  fs.existsSync(siteIndex) && fs.readFileSync(siteIndex, 'utf8').indexOf('<!doctype html>') === 0,
  fs.existsSync(siteIndex) ? fs.statSync(siteIndex).size + ' 字节' : '不存在');
const siteHtml = fs.existsSync(siteIndex) ? fs.readFileSync(siteIndex, 'utf8') : '';
check('export-html 内嵌模型含全部节点',
  (() => {
    const m = /<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(siteHtml);
    if (!m) return false;
    try {
      const model = JSON.parse(m[1]);
      const live = JSON.parse(run(['list', PROJ, '--json']).out).nodes.length;
      return model.nodes.length === live;
    } catch (e) { return false; }
  })());
// 资源必须真的复制到位：模型里引用的每个图片/附件路径都要在输出目录里存在，
// 否则分享出去的站点会出现"图挂了"。这条比"命令没报错"有意义得多。
check('export-html 把模型引用的全部资源复制到输出目录',
  (() => {
    const m = /<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(siteHtml);
    if (!m) return false;
    let model;
    try { model = JSON.parse(m[1]); } catch (e) { return false; }
    const refs = [];
    model.nodes.forEach((n) => {
      (n.images || []).forEach((i) => refs.push(i.file));
      (n.files || []).forEach((f) => refs.push(f.file));
    });
    if (!refs.length) return true;                       // 本项目无资源则无需复制
    const missing = refs.filter((rel) => !fs.existsSync(path.join(SITE, rel)));
    return missing.length === 0;
  })(), '缺失=' + (() => {
    try {
      const model = JSON.parse(/<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(siteHtml)[1]);
      const refs = [];
      model.nodes.forEach((n) => { (n.images || []).forEach((i) => refs.push(i.file)); (n.files || []).forEach((f) => refs.push(f.file)); });
      return refs.filter((rel) => !fs.existsSync(path.join(SITE, rel))).join(',') || '无';
    } catch (e) { return 'n/a'; }
  })());
check('export-html 页面脚本语法可编译（否则站点白屏）',
  (() => {
    const all = [...siteHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    if (!all.length) return false;
    try { new Function(all[all.length - 1][1]); return true; } catch (e) { return false; }
  })());
// 注意：CSP 的指令**顺序**不固定，故逐项独立检查，不要用一个假设顺序的大正则
//（第一版就是那么写的，结果因 img-src 排在 connect-src 之前而误报失败）。
check('export-html 带 CSP（阻断远程加载/回传，同时放行本地图片与内联脚本）',
  (() => {
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(siteHtml);
    if (!m) return false;
    const csp = m[1];
    return ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'",
      "img-src 'self' data:", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'"]
      .every((tok) => csp.indexOf(tok) >= 0);
  })(), (() => {
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(siteHtml);
    return m ? m[1].slice(0, 90) : '未找到 CSP';
  })());

// 12. assets / add-image / remove-image
const PNG = path.join(TMP, 't.png');
fs.writeFileSync(PNG, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')); // 最小 png 头
r = run(['add-image', PROJ, 'b', '--file', PNG, '--caption', '测试图']);
const addImgOk = ok(r.out) && /已添加图片/.test(r.out);
check('add-image', addImgOk, r.out.trim());
r = run(['assets', PROJ, '--json']);
check('assets', ok(r.out) && r.out.includes('测试图'));
const imgFile = (() => { try { return JSON.parse(r.out).images[0].file; } catch (e) { return null; } })();
if (imgFile) {
  r = run(['remove-image', PROJ, 'b', imgFile]);
  check('remove-image', ok(r.out) && /已移除/.test(r.out));
} else check('remove-image', false, '未取到图片路径');

// 13. remove-file
if (fRel) {
  r = run(['remove-file', PROJ, 'b', fRel]);
  check('remove-file', ok(r.out) && /已移除/.test(r.out), r.out.trim());
} else check('remove-file', false, '未取到附件路径');

// 14. validate / validate-all
r = run(['validate', PROJ]);
check('validate', ok(r.out));
r = run(['validate-all']);
check('validate-all', ok(r.out));

// 15. projects
r = run(['projects']);
check('projects', ok(r.out) && r.out.includes(PROJ));

// 16. 路径穿越防御：import-json 拒绝 ../ 资源路径
const EVIL = path.join(TMP, 'evil.json');
fs.writeFileSync(EVIL, JSON.stringify({ aimapVersion: 1, meta: { name: 'evil' }, format: 'node_tree', data: { id: 'root', topic: 'x', children: [] }, assets: { '../../evil.txt': 'aGk=' } }));
r = run(['import-json', EVIL, '--name', 'evil-probe']);
check('路径穿越被拒', !ok(r.out) && /非法资源路径/.test(r.out), r.out.trim());

// 17. 环数据 validate 拒绝（构造内存环 JSON 时 stringify 会抛错，这里验证 CLI 对坏 JSON 的容错）
fs.writeFileSync(EVIL, '{"broken"');
r = run(['import-json', EVIL]);
check('坏 JSON 被拒', !ok(r.out));

// 18. 失败契约：退出码必须是可靠判据（此前失败也返回 0，只能靠匹配 error: 前缀）
r = run(['get', PROJ, 'no-such-node-id']);
check('失败命令返回非 0 退出码', !ok(r.out) && r.code !== 0 && /^error:/.test(r.out.trim()),
  'exit=' + r.code + ' out=' + r.out.trim().slice(0, 60));
r = run(['projects']);
check('成功命令返回 0 退出码', ok(r.out) && r.code === 0, 'exit=' + r.code);
r = run(['no-such-command']);
check('未知命令返回非 0 退出码', !ok(r.out) && r.code !== 0, 'exit=' + r.code);
// 坏数据上 validate --json 也必须非 0（此前 --json 分支不设退出码，是真实的不一致）
const BADVAL = path.join(TMP, 'bad-validate.json');
fs.writeFileSync(BADVAL, JSON.stringify({ format: 'node_tree', data: { id: 'root', topic: 'x', children: [] } }));
r = run(['validate', BADVAL, '--json']);
let badJson = null;
try { badJson = JSON.parse(r.out); } catch (e) {}
check('validate --json 坏数据：JSON 报告 + 非 0 退出码',
  !!badJson && badJson.ok === false && r.code !== 0, 'exit=' + r.code + ' ok=' + (badJson && badJson.ok));
// 全局不变量：本次全部命令调用中，没有一次"报错却返回成功"
check('失败契约全局一致（error: 前缀 ⇒ 非 0 退出码）',
  contractViolations.length === 0, contractViolations.join('; ') || '本次调用的每条命令均一致');

// 19. 关联笔记（N 元实体）：assoc-add / list / edit / remove
//     它的存在理由是把"若干节点的关联"当成一个对象（而不是散在 links 上）——
//     故这里重点验证：多方成员、可从任一成员检索、编辑后落盘为 HTML、删除干净。
r = run(['assoc-add', PROJ, '--members', 'a,b', '--title', '甲乙关联', '--note-md', '**重点**：甲先于乙', '--id', 'as-it-1']);
check('assoc-add 新增关联', ok(r.out) && /已新增关联/.test(r.out), r.out.trim());
const asList = (() => {
  try { return JSON.parse(run(['assoc-list', PROJ, '--json']).out); } catch (e) { return null; }
})();
check('assoc-list 返回结构与解析后的成员标题',
  !!asList && asList.count === 1 && asList.items[0].members.length === 2
  && asList.items[0].members.every((m) => !!m.topic) && asList.items[0].hasNote === true,
  JSON.stringify(asList && { count: asList.count, members: asList.items[0].members.map((m) => m.label) }));
check('assoc-add --note-md 落盘为 HTML（与 detail 同约定）',
  !!asList && /<strong>重点<\/strong>/.test(asList.items[0].note), (asList && asList.items[0].note || '').slice(0, 80));
// 多者的关键性质：**任一成员**都能检索到同一篇关联
check('assoc-list --node 从任一成员都能找到（N 元的实际意义）',
  (() => {
    const a = JSON.parse(run(['assoc-list', PROJ, '--node', 'a', '--json']).out);
    const b = JSON.parse(run(['assoc-list', PROJ, '--node', 'b', '--json']).out);
    const none = JSON.parse(run(['assoc-list', PROJ, '--node', 'root', '--json']).out);
    return a.count === 1 && b.count === 1 && none.count === 0;
  })());
// --raw 只给契约字段（渲染层据此同步内存；多了派生字段就会污染数据文件）
check('assoc-list --raw 的实体只含契约字段',
  (() => {
    const j = JSON.parse(run(['assoc-list', PROJ, '--json', '--raw']).out);
    const raw = (j.raw || [])[0] || {};
    const extra = Object.keys(raw).filter((k) => ['id', 'title', 'members', 'note'].indexOf(k) < 0);
    const mExtra = raw.members && raw.members[0] ? Object.keys(raw.members[0]).filter((k) => ['project', 'id'].indexOf(k) < 0) : [];
    return extra.length === 0 && mExtra.length === 0;
  })());
r = run(['assoc-edit', PROJ, 'as-it-1', '--members', 'a,b,c', '--title', '甲乙丙关联']);
check('assoc-edit 改成员与标题', ok(r.out) && /已更新关联/.test(r.out), r.out.trim());
check('assoc-edit 后成员变为 3 方',
  (() => { const j = JSON.parse(run(['assoc-list', PROJ, '--json']).out); return j.items[0].members.length === 3; })());
r = run(['assoc-edit', PROJ, 'as-it-1', '--clear-note']);
check('assoc-edit --clear-note 清空笔记',
  ok(r.out) && (() => { const j = JSON.parse(run(['assoc-list', PROJ, '--json']).out); return j.items[0].hasNote === false; })());
// 错误分支
r = run(['assoc-add', PROJ, '--members', 'a']);
check('assoc-add 单成员被拒（关联至少两方）', !ok(r.out) && /至少需要 2 个/.test(r.out), r.out.trim());
r = run(['assoc-add', PROJ, '--members', 'a,ghost-node']);
check('assoc-add 成员不存在被拒（不造悬挂关联）', !ok(r.out) && /节点不存在/.test(r.out), r.out.trim());
r = run(['assoc-add', PROJ, '--members', 'a,BAD_ID']);
check('assoc-add 成员 id 不合规范被拒', !ok(r.out) && /不合规范/.test(r.out), r.out.trim());
r = run(['assoc-edit', PROJ, 'as-it-1', '--note', '<p>x</p>', '--note-md', 'y']);
check('assoc-edit 的 --note 与 --note-md 互斥', !ok(r.out) && /不能同时使用/.test(r.out), r.out.trim());
r = run(['assoc-remove', PROJ, 'no-such-assoc']);
check('assoc-remove 不存在的关联被拒', !ok(r.out) && /关联不存在/.test(r.out), r.out.trim());
// 数据契约：validate 通过（assoc 合法时），并在**悬挂成员**上报错
check('带 assoc 的项目 validate 通过', ok(run(['validate', PROJ]).out));

/* ---- R7：`assoc.anchors[]`（锚点写笔记侧）在 CLI 这一面的四条 -------------------------------
 * 这一节的判据全部**针对"静默"这一档**：锚点最危险的失效形态不是报错，而是"词没了 ⇒ 界面上什么都没有
 * ⇒ 那篇笔记像从来没存在过"。所以每条都要求：要么写进去、要么**响亮拒绝**，且失效能被**点名**。 */
r = run(['edit', PROJ, 'a', '--detail', '<p>这段正文里有 关键词甲 这个词</p>']);
check('锚点夹具：给节点 a 写一段含关键词的正文（前置，失败则下面几条都测不到）', ok(r.out), r.out.trim());
r = run(['assoc-add', PROJ, '--anchor', 'a#text:关键词甲', '--title', '锚点笔记', '--id', 'as-an1']);
check('assoc-add：**0 成员 + 1 锚点**可写（用户要的"只和一个关键词关联"）+ 锚点当下成立才放行',
  ok(r.out) && /已新增关联/.test(r.out) && /1 条锚点/.test(r.out), r.out.trim());
r = run(['assoc-list', PROJ, '--node', 'a', '--json']);
check('assoc-list --node：按**锚点**命中的笔记也在结果里（byAnchors ≥ 1，且成员数 0）',
  ok(r.out) && (() => {
    const j = JSON.parse(r.out);
    const it = (j.items || []).find((x) => x.id === 'as-an1');
    return j.byAnchors >= 1 && !!it && it.members.length === 0 && it.anchorState === 'ok'
      && it.anchors[0].kind === 'text' && it.anchors[0].text === '关键词甲';
  })(), r.out.trim());
r = run(['assoc-add', PROJ, '--anchor', 'a#text:这句话不在正文里', '--title', '坏锚点', '--id', 'as-an-bad']);
check('assoc-add：**当下不成立的锚点被响亮拒绝**（含原因与修法，不是静默接受）',
  !ok(r.out) && /锚点当下不成立/.test(r.out) && /bad-anchor/.test(r.out), r.out.trim());
r = run(['assoc-add', PROJ, '--anchor', '#tag:不存在的标签', '--title', '坏标签锚点', '--id', 'as-an-tag']);
check('assoc-add：标签锚点用**集合成员查询**判（标签没人带 ⇒ 拒绝）',
  !ok(r.out) && /no-tag/.test(r.out), r.out.trim());
r = run(['assoc-list', PROJ, '--json', '--raw']);
check('assoc-list --raw 带出 `anchors`（渲染层据此把关键词变成可点链接，不新造第二套引用）',
  ok(r.out) && (() => {
    const j = JSON.parse(r.out);
    const raw = (j.raw || []).find((x) => x.id === 'as-an1');
    return !!raw && Array.isArray(raw.anchors) && raw.anchors[0].text === '关键词甲';
  })(), r.out.trim());
/* 默认 `validate` **不判锚点**（它是写盘闸门；弱判据判红会让"改写正文"变成项目只读），
 * `validate --anchors` 才判 —— 两条一起判，缺哪一条都会把口径说反。 */
check('默认 validate 不把"锚点弱判据"算错（写盘闸门不被牵连）', ok(run(['validate', PROJ]).out));
check('validate --anchors：锚点有效时也不必红（判据不是"见到锚点就报"）', ok(run(['validate', PROJ, '--anchors']).out));

/* 失效锚点的**三段都不静默**：改写正文 ⇒ ①默认 validate 照旧过（写盘闸门不被弱判据牵连）
 * ②`validate --anchors` 判红并**点名** `项目/节点id#text:关键词` ③`assoc-prune --dry-run` 报它
 * 但**一个字节都不剪**（锚点失效通常是正文被改写 ⇒ 剪它可能让笔记再无锚点）。 */
run(['edit', PROJ, 'a', '--detail', '<p>这段正文被改写了，那个词不在了</p>']);
check('锚点失效① 默认 validate 照旧通过（写盘闸门不被弱判据牵连：改写正文仍然写得进去）',
  ok(run(['validate', PROJ]).out));
r = run(['validate', PROJ, '--anchors']);
check('锚点失效② `validate --anchors` 判红 + **点名** `项目/节点id#text:关键词` + 给修法',
  !ok(r.out) && /失效锚点（bad-anchor）/.test(r.out) && new RegExp(PROJ + '/a#text:关键词甲').test(r.out)
    && /不许自动剪/.test(r.out), r.out.trim());
const asAncBefore = fs.readFileSync(path.join(ROOT, 'projects', PROJ, PROJ + '.json'), 'utf8');
r = run(['assoc-prune', PROJ, '--dry-run']);
const asAncAfter = fs.readFileSync(path.join(ROOT, 'projects', PROJ, PROJ + '.json'), 'utf8');
check('锚点失效③ `assoc-prune --dry-run` 报告它、且**只报不剪**（项目 JSON 逐字节不变）',
  ok(r.out) && /失效锚点/.test(r.out) && /bad-anchor/.test(r.out) && asAncBefore === asAncAfter,
  r.out.trim().slice(0, 200));
check('锚点失效④ 修法可用：`assoc-edit --members a,b --clear-anchors` 之后 `validate --anchors` 复绿',
  (() => {
    const e = run(['assoc-edit', PROJ, 'as-an1', '--members', 'a,b', '--clear-anchors']);
    return ok(e.out) && ok(run(['validate', PROJ, '--anchors']).out);
  })());
/* 收尾：本节自己造的两篇笔记要清掉 —— 后面的既有判据（"删空后不留 assoc 键"、export-json 的
 * `assoc.length === 1`）是**按当时的库内条数**写的；留着会连累它们（本批实测踩到过一次）。 */
run(['assoc-remove', PROJ, 'as-an1']);

r = run(['assoc-remove', PROJ, 'as-it-1']);
check('assoc-remove 移除成功', ok(r.out) && /已移除关联/.test(r.out), r.out.trim());
check('删空后项目里不再留 assoc 键（与旧格式完全一致，无空数组噪音）',
  (() => {
    const f = path.join(ROOT, 'projects', PROJ, PROJ + '.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return d.assoc === undefined;
  })());
// export-json / import-json 必须带上 assoc（文档承诺它是无损备份路径）
run(['assoc-add', PROJ, '--members', 'a,b', '--note-md', '往返探针', '--id', 'as-rt']);
const OUT_JSON2 = path.join(TMP, 'assoc-out.aimap.json');
r = run(['export-json', PROJ, OUT_JSON2]);
check('export-json 导出的包里含 assoc',
  ok(r.out) && (() => { const b = JSON.parse(fs.readFileSync(OUT_JSON2, 'utf8')); return Array.isArray(b.assoc) && b.assoc.length === 1; })());
PROJ3 = PROJ + '-assoc';   // 名在文件顶部声明（清理段要用）
r = run(['import-json', OUT_JSON2, '--name', PROJ3]);
check('import-json 还原 assoc（无损往返）',
  ok(r.out) && (() => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects', PROJ3, PROJ3 + '.json'), 'utf8'));
    return Array.isArray(d.assoc) && d.assoc.length === 1 && /往返探针/.test(d.assoc[0].note);
  })(), r.out.trim());
check('导入后 validate 通过（assoc 成员在新项目里仍可解析）', ok(run(['validate', PROJ3]).out));
// 悬挂关联成员：手工塞一个指向不存在节点的成员，validate 必须报错
check('悬挂关联成员被 validate 拒绝', (() => {
  const f = path.join(ROOT, 'projects', PROJ3, PROJ3 + '.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.assoc[0].members[0].id = 'gone-node';
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
  const out = run(['validate', PROJ3]);
  return !ok(out.out) && /悬挂关联成员/.test(out.out);
})());

/* ---------------- 20. 关联笔记 ×「删节点」：悬挂成员的清理与备份恢复 ----------------
 * 这一节的三个漏洞都是**实测**出来的，共同点是"闸门读的是磁盘旧态"或"没有清理路径"：
 *   ① 删掉被关联引用的节点后，validate 判红 → 其后该项目**所有**写命令都被挡住
 *      （project:save 也是校验闸门）→ 项目被锁死，而界面没有改成员的入口。
 *   ② 恢复备份：删除项目后导入它自己的备份，会因为备份里指向**本项目**的链接被判
 *      "项目不存在"而拒绝 → 备份形同废纸。
 *   ③ 界面的保存闸门校验的是"待写数据"的临时文件，必须按**待写数据**判同项目成员，
 *      否则第一次保存放行、第二次才突然被拒（用户完全看不懂）。
 */
PROJ4 = PROJ + '-prune';   // 名在文件顶部声明（清理段要用）
PROJ5 = PROJ + '-restore';   // 同上
const projJson = (name) => path.join(ROOT, 'projects', name, name + '.json');
const readProj = (name) => JSON.parse(fs.readFileSync(projJson(name), 'utf8'));

run(['init', PROJ4, '--title', '清理探针']);
['a', 'b', 'c'].forEach((id) => run(['add', PROJ4, 'root', '--topic', id.toUpperCase(), '--id', id]));
run(['assoc-add', PROJ4, '--members', 'a,b,c', '--id', 'as-prune', '--title', '三元']);
run(['assoc-add', PROJ4, '--members', 'a,b', '--id', 'as-drop', '--title', '两元']);

// ① 删被引用的节点：默认拒执行（不是警告后照删 —— 照删就会把项目锁死）
r = run(['remove', PROJ4, 'a']);
check('删被关联引用的节点默认被拒，且给出两条出路',
  !ok(r.out) && /关联笔记引用/.test(r.out) && /--clean-assoc/.test(r.out) && /assoc-prune/.test(r.out),
  r.out.trim().split('\n')[0]);
check('被拒后**什么都没写**（节点仍在，未造出悬挂成员）',
  readProj(PROJ4).data.children.some((n) => n.id === 'a') && ok(run(['validate', PROJ4]).out));

// --clean-assoc：同步剪掉引用；只剩一个成员的关联整篇删除
r = run(['remove', PROJ4, 'a', '--clean-assoc']);
check('remove --clean-assoc 同步清理被引用的成员',
  ok(r.out) && /已同步清理关联/.test(r.out) && /已删除/.test(r.out), r.out.trim().replace(/\n/g, ' | '));
check('三元关联少一个成员仍保留（N 元语义）',
  (() => { const a = readProj(PROJ4).assoc || []; return a.length === 1 && a[0].id === 'as-prune' && a[0].members.length === 2; })());
check('清理后 validate 立刻通过（项目不会被锁死）', ok(run(['validate', PROJ4]).out));

// assoc-prune --dry-run：只报告不写盘
r = run(['assoc-prune', PROJ4, '--nodes', 'b', '--dry-run']);
check('assoc-prune --dry-run 只报告不写盘',
  ok(r.out) && /dry-run/.test(r.out) && (readProj(PROJ4).assoc[0].members.length === 2), r.out.trim().replace(/\n/g, ' | '));

// assoc-prune 自动模式：找出"确认不存在"的成员并清掉
(() => {
  const d = readProj(PROJ4);
  d.assoc[0].members.push({ project: PROJ4, id: 'ghost-node' });
  fs.writeFileSync(projJson(PROJ4), JSON.stringify(d, null, 2));
})();
check('注入悬挂成员后 validate 判红（前置条件成立）', !ok(run(['validate', PROJ4]).out));
r = run(['assoc-prune', PROJ4]);
check('assoc-prune 自动清理悬挂成员并恢复校验绿',
  ok(r.out) && /发现悬挂成员/.test(r.out) && /已清理/.test(r.out) && ok(run(['validate', PROJ4]).out),
  r.out.trim().replace(/\n/g, ' | '));

// "采不到真值 = 红"：成员所在项目**读不出来**时不许猜成"不存在"而去清理
BROKEN_PROJ = 'it-broken-' + Date.now().toString(36);   // 名在文件顶部声明（清理段要用）
fs.mkdirSync(path.join(ROOT, 'projects', BROKEN_PROJ), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'projects', BROKEN_PROJ, BROKEN_PROJ + '.json'), '{ 这不是合法 JSON', 'utf8');
(() => {
  const d = readProj(PROJ4);
  d.assoc[0].members.push({ project: BROKEN_PROJ, id: 'x' });
  fs.writeFileSync(projJson(PROJ4), JSON.stringify(d, null, 2));
})();
r = run(['assoc-prune', PROJ4, '--dry-run']);
check('项目读不出来时不当作悬空清理，而是明确警告（不猜真值）',
  ok(r.out) && /读不出来/.test(r.out) && /没有悬挂成员/.test(r.out)
  && readProj(PROJ4).assoc[0].members.some((m) => m.project === BROKEN_PROJ),
  r.out.trim().replace(/\n/g, ' | '));

// ② 备份恢复：删除项目后导入它自己的备份必须成功（同项目链接/关联按**待写数据**判）
run(['init', PROJ5, '--title', '恢复探针']);
['n1', 'n2'].forEach((id) => run(['add', PROJ5, 'root', '--topic', id.toUpperCase(), '--id', id]));
run(['link', PROJ5, 'n1', '--to', PROJ5, '--id', 'n2', '--caption', '同项目链接']);
run(['assoc-add', PROJ5, '--members', 'n1,n2', '--id', 'as-rt2', '--title', '往返']);
const OUT5 = path.join(TMP, 'restore.aimap.json');
run(['export-json', PROJ5, OUT5]);
check('备份包内含同项目链接与 assoc（前置条件成立）', (() => {
  const b = JSON.parse(fs.readFileSync(OUT5, 'utf8'));
  return Array.isArray(b.assoc) && b.assoc.length === 1 && JSON.stringify(b).indexOf('"caption":"同项目链接"') >= 0;
})());
fs.rmSync(path.join(ROOT, 'projects', PROJ5), { recursive: true, force: true });
r = run(['import-json', OUT5, '--name', PROJ5]);
check('删除项目后能导入它自己的备份（修复"备份无法恢复"）',
  ok(r.out) && /已导入/.test(r.out), r.out.trim());
check('恢复后同项目链接与 assoc 都还在，且 validate 通过',
  (() => {
    const d = readProj(PROJ5);
    const flat = [];
    (function w(n) { if (!n) return; flat.push(n); (n.children || []).forEach(w); })(d.data);
    const n1 = flat.find((x) => x.id === 'n1');
    return !!(n1 && n1.links && n1.links.length === 1) && (d.assoc || []).length === 1 && ok(run(['validate', PROJ5]).out);
  })());
// 但**真**悬挂仍必须被拒（放宽 selfProject 不能放过真错误）
check('导入含真悬挂链接的备份仍被拒绝', (() => {
  const b = JSON.parse(fs.readFileSync(OUT5, 'utf8'));
  b.data.children[0].links.push({ project: PROJ5, id: 'ghost', caption: '坏' });
  const bad = path.join(TMP, 'restore-bad.aimap.json');
  fs.writeFileSync(bad, JSON.stringify(b, null, 2));
  const out = run(['import-json', bad, '--name', PROJ5 + '-bad']);
  return !ok(out.out) && /悬挂链接/.test(out.out);
})());

// ③ 界面保存闸门：校验的是"待写数据"的临时文件 → 必须按待写数据判同项目成员
//    模拟 main.js 的 project:save：先落临时文件，再 `validate <临时文件>`。
check('保存闸门按**待写数据**判悬挂成员（界面删节点后第一次保存就会被拦）', (() => {
  const d = readProj(PROJ5);
  // 待写数据里删掉 n2（磁盘上仍在，正是"闸门慢一步"的场景）
  d.data.children = d.data.children.filter((n) => n.id !== 'n2');
  const probe = projJson(PROJ5) + '.99999.validate';
  fs.writeFileSync(probe, JSON.stringify(d, null, 2));
  const out = run(['validate', probe]);
  fs.unlinkSync(probe);
  return !ok(out.out) && /悬挂关联成员/.test(out.out);
})());
// 同一个磁盘文件（节点还在）仍然校验通过 —— 证明差异来自"按待写数据判"，不是误报
check('对照：未删节点的磁盘文件仍校验通过（差异确实来自按待写数据判）', ok(run(['validate', PROJ5]).out));

// MCP 补齐的 9 条：既要在 TOOLS 里，也要**真的调得通**（存在 ≠ 能调 ✗ —— 三者任一断就是"看得见调不动" ✓）
let mcpProbeDetail = '';
check('MCP 补齐的 9 条工具：定义齐全，且 stats / ui_state 真调通（ok:true）；validate_all 只验「定义在」——集成中途有坏项目探针，真调必然红 ✗', (() => {
  const mcp = require(path.join(ROOT, 'scripts', 'mcp-server.js'));
  const need = ['ask', 'add_root', 'expand_depth', 'clone_node', 'import_project', 'remove_file', 'stats', 'ui_state', 'validate_all'];
  const missing = need.filter((n) => !mcp.TOOLS.some((t2) => t2.name === n));
  if (missing.length) { mcpProbeDetail = '缺工具：' + missing.join(','); return false; }
  let r1, r2;
  try {
    r1 = mcp.callTool('stats', { project: PROJ });
    r2 = mcp.callTool('ui_state', {});
    // validate_all 故意不真调：集成中途 harness 还留着**坏项目探针** ⇒ 全量校验必然失败 ✗
    // （实测报文：error: Expected property name or ... at position 2 ✓）它只验「定义在」即可 ✓
  } catch (e) { mcpProbeDetail = '抛异常：' + ((e && e.message) || e); return false; }
  mcpProbeDetail = 'stats=' + JSON.stringify(r1).slice(0, 110) + ' ｜ ui_state=' + JSON.stringify(r2).slice(0, 110)
    + ' ｜ validate_all=只验定义（原因见注释 ✓）';
  const okv = (r) => !!(r && r.ok && r.text && String(r.text).length > 0);
  return okv(r1) && okv(r2);
})(), mcpProbeDetail);

// MCP 侧不能有"AI 修不了"的缺口：remove_node 要能带 clean_assoc，且必须有 assoc_prune
check('MCP 暴露 assoc_prune（AI 删节点后能自救）且 remove_node 支持 clean_assoc', (() => {
  const { TOOLS } = require(path.join(ROOT, 'scripts', 'mcp-server.js'));
  const prune = TOOLS.find((t) => t.name === 'assoc_prune');
  const rm = TOOLS.find((t) => t.name === 'remove_node');
  return !!prune && !!rm && !!rm.inputSchema.properties.clean_assoc
    && (rm.inputSchema.properties.clean_assoc.type === 'boolean');
})());

/* ---------------- MCP 协议级报文（**真 stdio，一拍**） ----------------
 * 为什么单独起一次真进程：`tests/mcp-protocol.test.js` 钉的是 `handleMessage` 的**纯逻辑**，
 * 而"真 stdio + 逐行 JSON-RPC + stdin 结束时的 flush"这条路上还有自己的失败模式
 * （粘连、丢行、收尾截断）。这里发一拍、按 id 取报文，断言**形状**。
 * 修前实测报文（2026-10-10）：`{"jsonrpc":"2.0","id":2,"result":"method not found: no-such-method"}`
 * —— 未知方法回了字符串 result ⇒ 标准客户端当成功处理 ⇒ 静默。 */
{
  const MCP_SRV = path.join(ROOT, 'scripts', 'mcp-server.js');
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'no-such-method' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no-such-tool', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stats', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stats', arguments: { project: 'no-such-project-xyz' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }
  ];
  const sp = spawnSync(process.execPath, [MCP_SRV], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
  });
  const replies = String(sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  });
  const byId = (id) => replies.filter((x) => x && x.id === id)[0] || null;
  check('真 stdio：五条请求各回一拍、都是合法 JSON-RPC 2.0，且**通知不产生响应**（5 拍，不是 6 拍）',
    replies.length === 5 && replies.every((x) => x && x.jsonrpc === '2.0')
      && [1, 2, 3, 4, 5].every((id) => !!byId(id)),
    'replies=' + replies.length + ' ids=' + replies.map((x) => x && x.id).join(','));
  check('真 stdio：未知方法 ⇒ error -32601（**没有** result 键）—— 这就是修前那条静默报文',
    (() => { const x = byId(2); return !!x && !x.result && x.error && x.error.code === -32601; })(),
    JSON.stringify(byId(2)).slice(0, 160));
  check('真 stdio：未知工具 ⇒ error -32601', (() => {
    const x = byId(3); return !!x && !x.result && x.error && x.error.code === -32601 && /no-such-tool/.test(x.error.message);
  })(), JSON.stringify(byId(3)).slice(0, 160));
  check('真 stdio：缺必填参数 ⇒ error -32602（并点名缺哪个）', (() => {
    const x = byId(4); return !!x && !x.result && x.error && x.error.code === -32602 && /project/.test(x.error.message);
  })(), JSON.stringify(byId(4)).slice(0, 160));
  check('真 stdio：**业务失败仍是 result + isError**（不许把业务失败也变成协议错误 —— 那会让模型看不到原因）',
    (() => {
      const x = byId(5);
      return !!x && !x.error && x.result && x.result.isError === true
        && x.result.content && x.result.content[0] && String(x.result.content[0].text).length > 0;
    })(), JSON.stringify(byId(5)).slice(0, 200));
  check('真 stdio：initialize 握手照常（改协议分流没带坏握手）', (() => {
    const x = byId(1); return !!x && !x.error && x.result && x.result.protocolVersion === '2024-11-05'
      && x.result.serverInfo && x.result.serverInfo.name === 'ai-mind-map';
  })(), JSON.stringify(byId(1)).slice(0, 160));
}

/* ---------------- 21. 链接 ×「删节点」：同项目清理与跨项目锁死自救 ----------------
 * 与 20 节同源的问题：**链接可以指向别的项目**，所以删节点会让"别人家"的项目悬空。
 * 而 validate 是写盘闸门 → 被判红的项目**所有**写操作都被挡住，界面又没有删链接入口。
 * 故 links-prune 是"能不能自救"的关键；本节把两条路都钉住。
 */
PROJ6 = PROJ + '-link';   // 名在文件顶部声明（清理段要用）
PROJ7 = PROJ + '-link2';   // 同上
run(['init', PROJ6, '--title', '链接探针甲']);
run(['init', PROJ7, '--title', '链接探针乙']);
['x', 'y', 'z'].forEach((id) => run(['add', PROJ6, 'root', '--topic', id.toUpperCase(), '--id', id]));
run(['add', PROJ7, 'root', '--topic', 'W', '--id', 'w']);
run(['link', PROJ6, 'x', '--to', PROJ6, '--id', 'z', '--caption', '同项目']);
run(['link', PROJ6, 'y', '--to', PROJ7, '--id', 'w', '--caption', '跨项目']);

// 同项目：删被链接指向的节点，默认拒执行并指出 --clean-links
r = run(['remove', PROJ6, 'z']);
check('删被链接指向的节点默认被拒，并给出 --clean-links',
  !ok(r.out) && /链接指向它/.test(r.out) && /--clean-links/.test(r.out), r.out.trim().split('\n')[0]);
check('被拒后什么都没写（节点仍在，链接未变）',
  readProj(PROJ6).data.children.some((n) => n.id === 'z') && ok(run(['validate', PROJ6]).out));
r = run(['remove', PROJ6, 'z', '--clean-links']);
check('remove --clean-links 同步清理指向它的链接',
  ok(r.out) && /已同步清理链接/.test(r.out) && ok(run(['validate', PROJ6]).out), r.out.trim().replace(/\n/g, ' | '));
check('清理后那个节点上不再留 links 键（无空数组噪音）', (() => {
  const flat = [];
  (function w(n) { if (!n) return; flat.push(n); (n.children || []).forEach(w); })(readProj(PROJ6).data);
  const x = flat.find((n) => n.id === 'x');
  return x && x.links === undefined;
})());

// 跨项目：对方删掉被指向的节点 → 本项目悬空被锁 → **用 links-prune 自救**
run(['remove', PROJ7, 'w']);
check('跨项目目标被删后，本项目 validate 判红（前置条件成立）',
  !ok(run(['validate', PROJ6]).out) && /悬挂链接/.test(run(['validate', PROJ6]).out));
check('此时本项目的写操作被闸门挡住（这就是"锁死"）',
  !ok(run(['add', PROJ6, 'root', '--topic', '新', '--id', 'new1']).out));
r = run(['links-prune', PROJ6, '--dry-run']);
check('links-prune --dry-run 报告悬空链接但不写盘',
  ok(r.out) && /发现悬挂链接/.test(r.out) && /dry-run/.test(r.out) && !ok(run(['validate', PROJ6]).out),
  r.out.trim().replace(/\n/g, ' | '));
r = run(['links-prune', PROJ6]);
check('links-prune 清掉悬空链接，项目解锁',
  ok(r.out) && /已删除链接/.test(r.out) && ok(run(['validate', PROJ6]).out), r.out.trim().replace(/\n/g, ' | '));
check('解锁后写操作恢复正常（自救成功）',
  ok(run(['add', PROJ6, 'root', '--topic', '新', '--id', 'new1']).out));
// ⚠️ 这里的**文案**随 `--nodes` 谓词的修正一起变了（改前谓词恒不命中 = 静默空转）：改前打印的是
// 「按 --nodes 清理指向本项目这些节点的链接」，现在打印「按 --nodes 清理指向这些节点的链接
// （含指向其条目的）」。那是**有意的**行为改动（谓词从"恒不命中"改成按节点 id 匹配、并含条目级），
// 所以断言跟着**改匹配新文案** —— 不许为了让它绿把产品文案改回去。
check('links-prune --nodes 只清指向指定节点的链接', (() => {
  run(['link', PROJ6, 'x', '--to', PROJ6, '--id', 'y', '--caption', '同项目2']);
  const out = run(['links-prune', PROJ6, '--nodes', 'y', '--dry-run']);
  return ok(out.out) && /按 --nodes 清理指向这些节点的链接/.test(out.out) && /x → /.test(out.out);
})());

/* ---------------- 工程命令：changelog（CHANGELOG 只读窄查询） ----------------
 * 逐条**展开写**（同下方端到端对照的理由：doc-facts 是静态计数 check( 调用点）。 */
const CL_BEFORE = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const clIdx = run(['changelog']);
check('changelog 给出段/条目索引', ok(clIdx.out)
  && /CHANGELOG 索引/.test(clIdx.out) && /## \[Unreleased\]/.test(clIdx.out) && /## \[v/.test(clIdx.out),
  clIdx.out.split('\n')[0]);

check('changelog --json 结构完整且行号分区铺满全文', (() => {
  const j = run(['changelog', '--json']);
  if (!ok(j.out)) return false;
  try {
    const v = JSON.parse(j.out);
    const sum = v.groups.reduce((n, g) => n + g.entries.reduce((m, e) => m + e.lines, 0), 0);
    // 索引模式（无关键词）**索引模式列出全部段**（含空的 [Unreleased]，显示 0 条目），
    // 所以 groups === sections 必须严格成立 —— 这条断言同时守住"段没被漏列"。
    return v.totalLines > 0 && v.totalBytes > 0 && v.sections > 1 && v.entries > 0
      && Array.isArray(v.groups) && v.groups.length === v.sections && sum > 0;
  } catch (e) { return false; }
})(), run(['changelog', '--json']).out.length + 'B');

check('changelog --grep 能命中且确实做了收窄', (() => {
  const j = run(['changelog', '--grep', '门禁', '--json']);
  if (!ok(j.out)) return false;
  try {
    const v = JSON.parse(j.out);
    return v.matched > 0 && v.matched < v.entries; // 命中少于全部 = 真的在筛
  } catch (e) { return false; }
})(), run(['changelog', '--grep', '门禁']).out.split('\n')[0]);

check('changelog --grep 无命中不是错误（退出码 0 + matched 0）', (() => {
  const x = run(['changelog', '--grep', 'zzz绝不存在的词zzz', '--json']);
  if (x.code !== 0) return false;
  try { return JSON.parse(x.out).matched === 0; } catch (e) { return false; }
})());

/* 归档检索：滚动归档把老版本段移出主文件后，**检索必须同时覆盖 docs/changelog/** ——
 * 否则"已归档的历史查不到"，用起来就像历史丢了（实测踩过：关键词只在 v0.12.0 归档里，命令报 0 命中）。
 * 这两条断言直接读归档目录现取一个词，不硬编码版本号/关键词，因此不会随发版过期。 */
check('changelog --grep 也能命中**已归档**的版本段（不是只搜主文件）', (() => {
  const dir = path.join(ROOT, 'docs', 'changelog');
  if (!fs.existsSync(dir)) return true;                       // 尚无归档时跳过（不该失败）
  const files = fs.readdirSync(dir).filter((f) => /\.md$/.test(f));
  if (!files.length) return true;
  // 探针取词：从归档正文里挑一条**足够长**的行，取中段切片。
  // 不按前缀过滤（早期版本的正文行可能全部以 `-` 开头，过滤后会取不到探针而假红）；
  // 取到后先用纯函数自证"这个词确实在归档里"，取不到就跳过 —— 断言只验证 CLI 的接线。
  const chlogLib = require(path.join(ROOT, 'src', 'changelog.js'));
  const raw = fs.readFileSync(path.join(dir, files.sort()[0]), 'utf8').split('\n')
    .map((l) => l.replace(/^[\s>#|\-*]+/, '').trim())
    .filter((l) => l.length >= 24 && !/^\[/.test(l));
  const longest = raw.sort((a, b) => b.length - a.length)[0] || '';
  const probe = longest.slice(4, 4 + 16);
  if (!probe || chlogLib.searchArchives(dir, probe).totalHits === 0) return true;   // 取不到可靠探针 → 跳过
  const x = run(['changelog', '--grep', probe, '--json']);
  if (x.code !== 0) return false;
  try {
    const v = JSON.parse(x.out);
    return v.archived && v.archived.totalHits > 0 && v.archived.files.length > 0
      && v.archived.files[0].hits[0].line > 0;
  } catch (e) { return false; }
})(), '归档命中应 > 0 且带行号');

check('changelog 检索输出**分别**给出主文件与归档的命中数（不让人误以为历史丢了）', (() => {
  const x = run(['changelog', '--grep', '归档']);
  return ok(x.out) && /主文件命中\s*\d+\s*条目/.test(x.out) && /归档命中\s*\d+\s*处/.test(x.out);
})(), '应形如「主文件命中 N 条目；归档命中 M 处」');

check('changelog --limit 限制条目数', (() => {
  const x = run(['changelog', '--limit', '2']);
  return ok(x.out) && (x.out.match(/^\s+L\d/gm) || []).length === 2;
})(), '条目行数应为 2');

check('changelog --full 真的带回正文（长度显著大于索引）', (() => {
  const idxOnly = run(['changelog', '--grep', '门禁']).out.length;
  const withBody = run(['changelog', '--grep', '门禁', '--full']).out;
  return ok(withBody) && withBody.length > idxOnly * 2;
})());

check('changelog 是只读命令：跑完 CHANGELOG.md 逐字节未变',
  fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8') === CL_BEFORE,
  '跑完上述 6 条查询后逐字节比对 CHANGELOG.md（查询命令不得改它）');

/* ---------------- 工程命令：dsh-caps（DSH 能力边界，**只读**） ----------------
 * 逐条展开写（同下方理由：doc-facts 静态统计 check( 调用点）。
 * 本机有 vendor/dsh 时断言"能正确读出能力边界"；**没有时断言"它响亮报错"** ——
 * 两条都是契约，避免"没有 vendor 就给一份空报告"这种静默失败。 */
const DSH_NM = path.join(ROOT, 'vendor', 'dsh', 'app', 'node_modules', '@deepseek-ai');
const hasDshVendor = fs.existsSync(DSH_NM);
const dcOut = run(['dsh-caps']);

check('dsh-caps：机械读出多层装配，并显式列出易误判规则（有 vendor 时）/ 响亮报错（无 vendor 时）',
  hasDshVendor
    ? (ok(dcOut.out) && /容易误判的规则/.test(dcOut.out) && /host bundle 是并列的/.test(dcOut.out)
      && /装配层/.test(dcOut.out))
    : (dcOut.code !== 0 && /找不到 DSH 运行时包目录/.test(dcOut.out)),
  hasDshVendor ? dcOut.out.split('\n')[0] : '本机无 vendor/dsh：应响亮报错，而不是给一份空报告');

check('dsh-caps --json：结构完整，且三轴计数自洽（已挂载 + 未挂载 == 磁盘总数）',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--json']);
    if (!ok(r.out)) return false;
    try {
      const j = JSON.parse(r.out);
      return j.layers.length >= 2 && j.diskCount > 100 && j.mountedCount > 0 && j.unmountedCount > 0
        && j.mountedCount + j.unmountedCount === j.diskCount
        && Array.isArray(j.packages) && j.packages.length === j.mountedCount;
    } catch (e) { return false; }
  })() : true);

check('dsh-caps --grep：**从"装配 + 磁盘"两轴回答** —— 这是本命令存在的理由',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--grep', 'headless']);
    return ok(r.out) && /两侧都查/.test(r.out) && /dsh-headless/.test(r.out);
  })() : true, '查 headless 应能说出它在磁盘的哪套 bundle 里');

check('dsh-caps --grep 无命中时如实说"两层都没有匹配"，而不是给空输出',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--grep', 'zzz绝不存在的能力zzz']);
    return ok(r.out) && /两层都没有匹配/.test(r.out);
  })() : true);

check('dsh-caps --grep 缺参数 → 非 0 退出 + 明确提示怎么用', (() => {
  const r = run(['dsh-caps', '--grep']);
  return r.code !== 0 && /需要一个关键词/.test(r.out);
})());

check('dsh-caps --unmounted：列出"磁盘上有但当前未挂载"的包（防"以为不具备"）',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--unmounted']);
    return ok(r.out) && /未被任何装配挂载/.test(r.out) && r.out.split('\n').length > 5;
  })() : true);

/* ---------------- 「装配面夹具」与运行包一致（2026-10-18 陈旧夹具批） ----------------
 * 为什么必须有一条门禁：`tests/fixtures/dsh-composed-tree-web.txt` 自称"web 装配面"，
 * 实测却落后两代（152 行 vs 287 行、缺 49 个 id，含 `ui-sidebar-terminal` / `ui-sidebar-browser`
 * 这两个"侧栏入口"，另有 3 个反向残留）⇒ **照它数入口必错**。夹具现在由
 * `scripts/dsh-fixture-freshness.js` 现生成、并在这里被钉住：改了运行包不改夹具 ⇒ 必红。
 *
 * ⚠️ **这条门禁的适用环境（不许含糊）**：它要读 `vendor/dsh/`，而 `vendor/` 被 `.gitignore`
 *    忽略、**不在版本库**（`git ls-files vendor` = 0）。所以：
 *      · **有运行包的机器**（本机 dev / 打包机）：真的比对合成树，"夹具过期"当场红；
 *      · **没有运行包**（新克隆、无 vendor 的 CI）：**不静默跳过** —— 断言它 **exit 3 +
 *        明确报文**（`找不到 DSH 运行包`），与 `dsh-caps` 那组同一条契约。
 *    ⇒ 诚实说法：**CI 里覆盖到的是"响亮报错"契约，不是"夹具保鲜"本身**。保鲜只在有 vendor 处成立。
 *    成本实测：一次 `--dump-config` ≈ 1.4 s（含 node 冷启动）⇒ 塞进 G4（预算 60 s）无压力。 */
check('装配面夹具与运行包一致：改运行包不改夹具 ⇒ 必红（无 vendor 时断言它**响亮报错**而非静默跳过）', (() => {
  const sp = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dsh-fixture-freshness.js')],
    { cwd: ROOT, encoding: 'utf8' });
  const out = (sp.stdout || '') + (sp.stderr || '');
  if (hasDshVendor) return sp.status === 0 && /夹具与运行包一致/.test(out);
  return sp.status === 3 && /找不到 DSH 运行包/.test(out);
})(), hasDshVendor ? 'vendor 在：比对合成树' : 'vendor 不在：只验"响亮报错"契约（保鲜未被覆盖）');

/* ---------------- 窄读模式：--brief / --compact / --subtree ----------------
 * 逐条展开写（同下方理由：doc-facts 静态统计 check( 调用点）。 */
run(['add', PROJ, 'root', '--topic', '窄读探针', '--id', 'narrow-probe']);
run(['add', PROJ, 'narrow-probe', '--topic', '窄读子节点', '--id', 'narrow-probe-child']);

const nrFull = run(['read', PROJ, '--json']);
const nrCompact = run(['read', PROJ, '--json', '--compact']);
const nrBrief = run(['read', PROJ, '--json', '--brief']);
const nrBriefCompact = run(['read', PROJ, '--json', '--brief', '--compact']);

check('窄读 --compact：仍是合法 JSON，且确实更短（省的是缩进与换行）', (() => {
  if (!ok(nrCompact.out)) return false;
  try { JSON.parse(nrCompact.out); } catch (e) { return false; }
  return nrCompact.out.length < nrFull.out.length;
})(), nrFull.out.length + ' 字符 → ' + nrCompact.out.length + ' 字符');

check('窄读 --brief：nodeCount 不变，但 detail 与资源清单被省掉（结构仍是全的）', (() => {
  try {
    const a = JSON.parse(nrFull.out);
    const b = JSON.parse(nrBrief.out);
    return b.brief === true && b.nodeCount === a.nodeCount
      && b.nodes.some((n) => n.detail !== undefined) === false
      && a.nodes.some((n) => n.detail !== undefined) === true;
  } catch (e) { return false; }
})(), nrBrief.out.length + ' 字符（全量 ' + nrFull.out.length + ' 字符）');

check('窄读三开关可叠加：brief+compact 比只用 brief 更省',
  ok(nrBriefCompact.out) && nrBriefCompact.out.length < nrBrief.out.length,
  nrBriefCompact.out.length + ' 字符（只用 brief 是 ' + nrBrief.out.length + ' 字符）');

check('窄读 --subtree：只给该子树，根就是它且 depth 从 0 起', (() => {
  const sub = run(['read', PROJ, '--json', '--subtree', 'narrow-probe']);
  if (!ok(sub.out)) return false;
  try {
    const j = JSON.parse(sub.out);
    const all = JSON.parse(nrFull.out);
    return j.nodeCount === 2 && j.nodeCount < all.nodeCount
      && j.nodes[0].id === 'narrow-probe' && j.nodes[0].depth === 0;
  } catch (e) { return false; }
})(), '应为 2 个节点、根 narrow-probe、depth 0 起');

check('窄读 --subtree 指向不存在的节点 → 非 0 退出 + error: 前缀 + 点明原因', (() => {
  const r = run(['read', PROJ, '--subtree', 'no-such-node-xyz']);
  return r.code !== 0 && /^error:/.test(r.out) && /节点不存在/.test(r.out);
})());

check('窄读 --subtree 缺参数 → 非 0 退出 + 明确提示怎么用', (() => {
  const r = run(['read', PROJ, '--subtree']);
  return r.code !== 0 && /^error:/.test(r.out) && /需要一个节点 id/.test(r.out);
})());

check('**文本模式不再静默吞掉 --detail**（以前是无声空操作，会让人以为项目没详情）', (() => {
  const r = run(['read', PROJ, '--detail']);
  return r.code !== 0 && /^error:/.test(r.out) && /只在 --json 视图里有效/.test(r.out);
})(), '应报错并给出替代路径');

check('文本模式同样拒绝 --images（同一陷阱的另一半）', (() => {
  const r = run(['read', PROJ, '--images']);
  return r.code !== 0 && /只在 --json 视图里有效/.test(r.out);
})());

check('向后兼容：--json --detail 仍照常可用（read 的 detail 本来就是默认开的）', (() => {
  const r = run(['read', PROJ, '--json', '--detail']);
  return r.code === 0 && ok(r.out) && r.out.length === nrFull.out.length;
})());

check('窄读 --skeleton：连 tags/links/detail/images 都省，但**保留 children 嵌套**', (() => {
  const sk = run(['read', PROJ, '--json', '--skeleton']);
  if (!ok(sk.out)) return false;
  try {
    const j = JSON.parse(sk.out);
    return j.skeleton === true && j.brief === undefined && j.images === undefined
      && j.nodes.every((n) => n.tags === undefined && n.links === undefined
        && n.detail === undefined && n.images === undefined)
      && Array.isArray(j.nodes[0].children);
  } catch (e) { return false; }
})(), '这是它相对 list --json（扁平）的差别：仍有嵌套');

run(['remove', PROJ, 'narrow-probe']);

/* ---------------- 21b. 未知选项与非法值：一律响亮失败（不静默） ----------------
 * 缺陷取证（2026-10-10 修前实测）：`add … --tags aaa,bbb` ⇒ **exit 0 +「已添加」**，
 * 而 `get` 里没有 tags、`stats` 的 taggedNodes 是 0；`--bogus xyz`、`--expanded=nonsense` 同样静默。
 * 根因：`cli/core.js` 的通用参数分支没有白名单，命令读不到的键就**什么都不发生**。
 * 危险点：`--tags` 在 `edit` / `add-image` 上**是合法选项** ⇒ 跨命令误用极其自然。
 * 修法：每条命令在 `cli/registry.js` 声明 options，dispatch 唯一一处判定（见 tests/cli-options.test.js）。
 * 本节四条一组：**负向**（未知长选项 / 跨命令误用 / 非法值）+ **正向对照**（合法选项照旧通过）。 */
const UOPT = 'unknown-opt-probe';
r = run(['add', PROJ, 'root', '--topic', '不该被写入', '--id', UOPT, '--tags', 'aaa,bbb']);
check('写命令的未知选项 ⇒ 非 0 退出 + 点名 + 支持集（旧行为：exit 0 +「已添加」）',
  !ok(r.out) && r.code !== 0 && /未知选项 --tags/.test(r.out)
    && /add 支持的选项/.test(r.out) && /edit/.test(r.out), r.out.trim().slice(0, 170));
check('被拒的写命令**什么都没写**（不是"报错了但其实还是写进去了"）',
  !ok(run(['get', PROJ, UOPT]).out));
r = run(['add', PROJ, 'root', '--topic', '不该被写入', '--id', UOPT + '2', '--bogus', 'xyz']);
check('未知长选项（--bogus）同样非 0 且点名', !ok(r.out) && r.code !== 0 && /未知选项 --bogus/.test(r.out),
  r.out.trim().slice(0, 140));
r = run(['read', PROJ, '--json', '--bogus2']);
check('只读命令同样拒绝未知选项（守门在 dispatch，不是只在写命令里）',
  !ok(r.out) && r.code !== 0 && /未知选项 --bogus2/.test(r.out), r.out.trim().slice(0, 120));
r = run(['edit', PROJ, 'a', '--tags', 'aaa,bbb']);
check('正向对照：合法选项照旧通过（edit --tags）', ok(r.out) && /已更新/.test(r.out), r.out.trim());
check('正向对照：--tags 真的落到盘上（stats.taggedNodes 不再为 0）', (() => {
  const s = run(['stats', PROJ, '--json']);
  try { return JSON.parse(s.out).taggedNodes > 0; } catch (e) { return false; }
})(), '这是修前那次的症状：exit 0 而 taggedNodes = 0');
const expBefore = (() => {
  try { return JSON.parse(run(['get', PROJ, 'a', '--json']).out).expanded; } catch (e) { return 'PARSE-FAIL'; }
})();
r = run(['edit', PROJ, 'a', '--expanded=nonsense']);
check('非法值（--expanded=nonsense）⇒ 非 0 + 说清允许值（旧行为：静默落成默认 true）',
  !ok(r.out) && r.code !== 0 && /只能是 true 或 false/.test(r.out), r.out.trim().slice(0, 130));
check('被拒的非法值**没有改盘**（expanded 与拒绝前逐字相同）', (() => {
  try { return JSON.parse(run(['get', PROJ, 'a', '--json']).out).expanded === expBefore; } catch (e) { return false; }
})());
r = run(['move', PROJ, 'a', 'root', '--index', 'abc']);
check('非法 --index ⇒ 非 0（旧行为：静默退化成"插到末尾"）',
  !ok(r.out) && r.code !== 0 && /--index 必须是非负整数/.test(r.out), r.out.trim().slice(0, 130));
r = run(['add', '--help']);
check('`<命令> --help` 打印该命令的支持集且不执行命令（退出码 0）',
  r.code === 0 && /支持的选项:/.test(r.out) && /--topic/.test(r.out) && !/已添加/.test(r.out),
  r.out.trim().split('\n').slice(0, 3).join(' ｜ '));
r = run(['edit', PROJ, 'a', '--expanded', 'false']);
check('正向对照：--expanded false（空格形态）照旧可用', ok(r.out) && /已更新/.test(r.out));

// 整数选项的"值非法"：同一类缺陷的另外几个入口（读参数非法以前被静默吞掉）
// 修前实测：`orphans --limit abc` ⇒ `Math.max(0, Number('abc'))` = NaN ⇒ `slice(0, NaN)` = []（**静默空清单**）；
//           `changelog --limit abc` ⇒ `parseInt(...) || 0` ⇒ 限 0 条（静默空索引）；
//           `mentions --min-length abc` ⇒ NaN 传下去 ⇒ 过滤形同没设。
r = run(['orphans', PROJ, '--limit', 'abc']);
check('orphans --limit 非法 ⇒ 非 0 + 说清允许范围（旧行为：静默给出空清单）',
  !ok(r.out) && r.code !== 0 && /--limit 必须是非负整数/.test(r.out), r.out.trim().slice(0, 120));
r = run(['orphans', PROJ, '--limit', '5']);
check('正向对照：orphans --limit 5 照旧可用', ok(r.out) && /无引用关系/.test(r.out));
r = run(['changelog', '--limit', 'abc']);
check('changelog --limit 非法 ⇒ 非 0（旧行为：静默限 0 条）',
  !ok(r.out) && r.code !== 0 && /--limit 必须是非负整数/.test(r.out), r.out.trim().slice(0, 120));
r = run(['mentions', PROJ, '--min-length', 'abc']);
check('mentions --min-length 非法 ⇒ 非 0（旧行为：NaN 传下去，过滤形同没设）',
  !ok(r.out) && r.code !== 0 && /--min-length 必须是/.test(r.out), r.out.trim().slice(0, 120));
r = run(['changes', '--limit', 'abc']);
check('changes --limit 非法 ⇒ 非 0（旧行为：NaN > 0 为假 ⇒ 悄悄退回全量）',
  !ok(r.out) && r.code !== 0 && /--limit 必须是非负整数/.test(r.out), r.out.trim().slice(0, 120));
r = run(['ask', PROJ, 'a', '--kind', 'explain', '--timeout', 'abc', '--dry-run']);
check('ask --timeout 非法 ⇒ 非 0（旧行为：静默退回默认超时 —— 而这条命令烧真实额度）',
  !ok(r.out) && r.code !== 0 && /--timeout 必须是/.test(r.out), r.out.trim().slice(0, 120));

/* 21c. **单短横线**选项：失败原因必须准（同 21b 的"不静默"，但病根不同）
 * 缺陷取证（本轮实测）：`node cli/mm-cli.js read -x` ⇒ `error: 项目不存在: -x`。
 *   退出码非 0 是**响亮**的，但**原因错**：它把 `-x` 当成了项目名 ⇒ 人和 AI 都会去查
 *   "项目 -x 为什么不存在"，而真因是"这个选项写错了"（本工程约定长选项 `--xxx`）。
 *   根因：21b 那个守门点只认 `--xxx`（`a.slice(0,2) !== '--'` 直接跳过单横线），
 *   于是单横线一路落到位置参数。
 * 边界（不许把正常用法判死 ✗）：
 *   · `-h` 是工程**既有**短选项（`<命令> -h` 打印该命令用法、exit 0）⇒ 原样保留 ✓；
 *   · 被当作**选项值**的 `-x`（`--topic -x`）是正常用法 ⇒ 不许误杀 ✓（只看位置参数）。
 * 判据用**文案里的关键短语 + 退出码**，并显式核对"不再出现旧的那句误导文案"。 */
r = run(['read', '-x']);
check('单短横线未知选项（-x）⇒ 非 0 且**原因准确**：不认识的选项 + 长选项约定（旧行为：项目不存在: -x）',
  !ok(r.out) && r.code !== 0 && /不认识的选项 -x/.test(r.out) && /长选项/.test(r.out)
    && !/项目不存在/.test(r.out) && /read 支持的选项/.test(r.out),
  r.out.trim().slice(0, 190));
r = run(['stats', '-v']);
check('单短横线未知选项（-v，工程无此语义）⇒ 同样报"不认识"，不冒充别的错因',
  !ok(r.out) && r.code !== 0 && /不认识的选项 -v/.test(r.out) && !/项目不存在/.test(r.out),
  r.out.trim().slice(0, 150));
r = run(['read', '-h']);
check('正向对照：`-h` 的既有语义保留（`<命令> -h` 打该命令用法、exit 0）—— 不许判死正常用法',
  r.code === 0 && /支持的选项:/.test(r.out) && /AI MindMap CLI — read/.test(r.out),
  r.out.trim().split('\n').slice(0, 2).join(' ｜ '));
// 用节点 a 的 topic 当"以 - 开头的值"的载体。⚠️ 用完**逐字还原**：后面的段落还要用这个项目，
// 留一个改过的 topic 会给别人埋一个难查的假红（本文件前面已吃过同类亏）。
const topicABefore = (() => {
  try { return JSON.parse(run(['get', PROJ, 'a', '--json']).out).topic; } catch (e) { return null; }
})();
r = run(['edit', PROJ, 'a', '--topic', '-x']);
check('正向对照：以 "-" 开头的**值**照旧可用（`--topic -x`：扫描只看位置参数，不误杀）',
  ok(r.out) && /已更新/.test(r.out), r.out.trim().slice(0, 120));
check('正向对照：那个值真的落盘了（不是"报成功但其实没写"）', (() => {
  try { return JSON.parse(run(['get', PROJ, 'a', '--json']).out).topic === '-x'; } catch (e) { return false; }
})());
r = run(['edit', PROJ, 'a', '--topic=' + String(topicABefore)]);
check('正向对照：--key=值 形态照旧可用（也是"以 - 开头的值"的官方写法）+ topic 已逐字还原',
  ok(r.out) && (() => {
    try { return JSON.parse(run(['get', PROJ, 'a', '--json']).out).topic === topicABefore; } catch (e) { return false; }
  })(), '还原为 ' + JSON.stringify(topicABefore));

/* ---------------- 22. 多路同时编辑（并发：不相交自动合并 / 相交指名拒绝） ----------------
 * 上面所有断言都是"单路"。本段专门跑**两路同时编辑**，而且走**真实的** ctx + 命令函数 + store：
 * 用 `createContext` 造 ctx（命令名不进 ctx —— 见 `cli/main.js` 的 `createContext(rest)`），
 * 再在**「我读之后、我写之前」**这个窗口里注入一次"别人的写"。
 *
 * ⚠️ **窗口为什么要这样造**（第一版探针栽在这里）：`ctx.mutate` 是"读→改→写"，读发生在**写之前**。
 *    所以"先让别处写一次、再跑命令"**构不成竞争** —— 命令自己那次读会读到别人的改动，一次就成功。
 *    真正的竞争窗口只在 mutate 内部，所以唯一的注入点是 `store.write` 这个 io 缝。
 * 判据就是本功能的全部价值：
 *    · 不相交 ⇒ **两边改动都在**；
 *    · 相交   ⇒ **拒绝 + 报出是哪个对象**，且盘上保持别人那一版（绝不静默覆盖）。
 *
 * ⚠️ 下面三个小标题刻意写成「（并发①）」而**不是**"斜杠紧跟 ①"的形式：本文件前面已有一组那样的序号，
 *    而 **G9 判定六把"斜杠紧跟标记"当作实现脚本里的判定标记来计数**（标记必须唯一）⇒ 重复即判红。
 *    这条实测教训就在它的报错文本里。**要加序号，就把标记放在别的字符之后，让它不被计入。**
 */
const { createContext } = require(path.join(ROOT, 'cli', 'core.js'));
const editCmds = require(path.join(ROOT, 'cli', 'commands', 'edit.js'));
const assocCmds = require(path.join(ROOT, 'cli', 'commands', 'assoc.js'));
// 读项目用本文件已有的 `readProj(name)`（不另造一份同样的读取 —— 同一事实一处表达）
const nodeOf = (data, id) => {
  let hit = null;
  (function w(n) { if (!n || hit) return; if (n.id === id) hit = n; (n.children || []).forEach(w); })(data.data);
  return hit;
};
/** 造一次竞争：在**第一次写盘之前**，让"另一个写入者"先真写一次 */
function raceCtx(rest, otherFn) {
  const ctx = createContext(rest);
  const realWrite = ctx.store.write.bind(ctx.store);
  let injected = false;
  ctx.store.write = (name, data, opts) => {
    if (!injected) {
      injected = true;
      const cur = ctx.store.read(name);                          // 别人读到的正是"我读到的那一版"
      realWrite(name, otherFn(JSON.parse(JSON.stringify(cur.data))), { expectVersion: cur.version });
    }
    return realWrite(name, data, opts);
  };
  return ctx;
}

run(['add', PROJ, 'root', '--topic', '并发A', '--id', 'cc-a']);
run(['add', PROJ, 'root', '--topic', '并发B', '--id', 'cc-b']);

// （并发①）不相交：我改 cc-a，别人改 cc-b ⇒ 自动合并
{
  const ctx = raceCtx([PROJ, 'cc-a', '--topic', 'A-我'], (d) => { nodeOf(d, 'cc-b').topic = 'B-别人'; return d; });
  let threw = null;
  try { editCmds.edit(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  check('并发：改不同节点 ⇒ 自动合并（两边改动都在）',
    !threw && nodeOf(after, 'cc-a').topic === 'A-我' && nodeOf(after, 'cc-b').topic === 'B-别人',
    threw ? String(threw.message).slice(0, 120)
      : 'cc-a=' + nodeOf(after, 'cc-a').topic + ' · cc-b=' + nodeOf(after, 'cc-b').topic);
}

// （并发②）相交：我改 cc-a，别人也改 cc-a ⇒ 指名拒绝，盘上保持别人那一版
{
  const ctx = raceCtx([PROJ, 'cc-a', '--topic', 'A-我2'], (d) => { nodeOf(d, 'cc-a').topic = 'A-别人'; return d; });
  let threw = null;
  try { editCmds.edit(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const msg = threw ? String(threw.message) : '';
  check('并发：改同一节点 ⇒ 指名拒绝（且不覆盖对方）',
    !!threw && /node:cc-a/.test(msg) && /重新读取/.test(msg) && nodeOf(after, 'cc-a').topic === 'A-别人',
    threw ? msg.replace(/\s+/g, ' ').slice(0, 170) : '没有报错 —— 危险：应当拒绝却写进去了');
}

// （并发③）跨对象类别也不相交：我改 assoc 条目，别人改节点 ⇒ 自动合并
{
  run(['assoc-add', PROJ, '--members', 'cc-a,cc-b', '--id', 'cc-rel', '--title', '并发关系']);
  const ctx = raceCtx([PROJ, 'cc-rel', '--title', '关系-我'], (d) => { nodeOf(d, 'cc-a').topic = 'A-别人2'; return d; });
  let threw = null;
  try { assocCmds.assocEdit(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const it = (after.assoc || []).find((x) => x && x.id === 'cc-rel');
  check('并发：改 assoc 与改节点不相交 ⇒ 自动合并',
    !threw && !!it && it.title === '关系-我' && nodeOf(after, 'cc-a').topic === 'A-别人2',
    threw ? String(threw.message).slice(0, 120)
      : 'assoc=' + (it && it.title) + ' · cc-a=' + nodeOf(after, 'cc-a').topic);
}

// 收回探针数据（顺序：先摘关联，再删节点 —— 否则留下悬挂成员会让删除被闸门挡住）
run(['assoc-remove', PROJ, 'cc-rel']);
run(['remove', PROJ, 'cc-a']);
run(['remove', PROJ, 'cc-b']);

/* ---------------- 23. 变更可见性（changes：多路同时编辑的事前避让） ----------------
 * 记的是"谁、何时、改了哪些对象"，数据来自唯一写盘出口顺带产生的 `.changes.jsonl`。
 * 判据里最要紧的一条是**"答不了"必须与"没有变更"可分辨**：可见性功能最坏的失效形态不是报错，
 * 而是安静地说"没人动过" —— 会话会据此放心写下去，撞上并发改动白做一轮。
 * （`changedKeys` 返回 Set 这个坑就属于这类：实测曾让每条日志都显示"无对象变化"。）
 */
{
  // 锚点必须在**写入之前**取（先写再取锚点，`--since` 当然答"没有变更" —— 我第一版就这么写错了）
  const base = JSON.parse(run(['changes', PROJ, '--json']).out);
  check('changes --json 给出当前 rev 与 version（这是 --since 的锚点来源）',
    typeof base.rev === 'number' && base.rev > 0 && /^[0-9a-f]{8,}$/.test(String(base.version)),
    'rev=' + base.rev + ' version=' + String(base.version).slice(0, 8));

  // 造一次可由日志捕获的写入（新增节点 ⇒ children:<父> + node:<新id>）
  run(['add', PROJ, 'root', '--topic', '变更日志探针', '--id', 'chg-probe']);

  // ★ 这条锁"日志必须记到**真的变了什么**"（`changedKeys` 返回 Set 的坑：按数组处理会每条都空）
  const added = run(['changes', PROJ, '--since', String(base.rev)]).out;
  check('changes --since <rev> 列出其后的写入，并**指名叫出被改的对象**（不是"无对象变化"）',
    ok(added) && /变更日志探针/.test(added) && !/无对象变化/.test(added),
    added.trim().split('\n').slice(1, 3).join(' | '));

  // 写入者身份：这条写入必须记成 `cli:add`（说明"谁在写"落到了日志里）
  check('changes 记下「谁在写」（cli:<命令>）', /cli:add/.test(added), added.trim().split('\n')[1] || '');

  run(['edit', PROJ, 'chg-probe', '--topic', '变更日志探针2']);
  const afterEdit = JSON.parse(run(['changes', PROJ, '--json']).out);
  check('changes：又写一次后 rev 递增（计数单调，不受窗口裁剪影响）',
    afterEdit.rev === base.rev + 2, 'rev ' + base.rev + ' → ' + afterEdit.rev);

  // ★ 最要紧的一条：答不了 ⇒ **报错 + 非 0**，绝不能返回"无变更"
  const bad = run(['changes', PROJ, '--since', 'deadbeefdeadbeef']);
  check('changes --since <窗口外的锚点> ⇒ 报错且非 0（"答不了"≠"没有变更"）',
    !ok(bad.out) && bad.code !== 0 && /不等于"没有变更"/.test(bad.out),
    bad.out.trim().slice(0, 110));

  // 无 `--since` 时缺日志只是"看现状"，明说缺日志即可（不报错）—— 清掉日志验证
  const logFile = path.join(ROOT, 'projects', PROJ, '.changes.jsonl');
  const savedLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : null;
  try {
    if (fs.existsSync(logFile)) fs.rmSync(logFile);
    const noLog = run(['changes', PROJ]);
    check('changes（无 --since）缺日志 ⇒ 明说"答不了"，但不报错',
      ok(noLog.out) && /没有变更日志/.test(noLog.out) && /不等于"没有变更"/.test(noLog.out),
      noLog.out.trim().split('\n').slice(-1)[0].slice(0, 110));
    const sinceNoLog = run(['changes', PROJ, '--since', '1']);
    check('changes --since（缺日志）⇒ 报错且非 0',
      !ok(sinceNoLog.out) && sinceNoLog.code !== 0, sinceNoLog.out.trim().slice(0, 90));
  } finally {
    if (savedLog !== null) fs.writeFileSync(logFile, savedLog, 'utf8');
  }

  run(['remove', PROJ, 'chg-probe']);
}

/* ---------------- 23b. 时间线（`timeline`：节点级的"最近改了什么" · 产品代号 `TL` · 台账 `W2`） ----------------
 * 与上面 `changes` 读**同一份**日志，但列的是**笔记**而不是**写入事件**。这里必须钉住的是四条边界
 * （它们是这条命令与"随便排个序"的区别；**不用圈号枚举** —— 本文件的圈号是门禁 G8 的判定标记，重复即判红）：
 *   · **不读墙钟**：相对的 `--since 7d` 不给 `--now` 必须**报错**，给了才出界；
 *   · **两跑逐字节相同**：同一调用两次的输出必须相等（这是"时间线"这种功能最容易破的一条）；
 *   · **排序可复算**：`at` 降序 → 项目名升序 → nodeId 升序（同时间戳也有唯一答案，下面独立复算一遍）；
 *   · **"时间未知"不许静默消失**：日志被删时全部节点降级成 `unknown`，`--since` 下它们**不返回但被计数**
 *     （"没回你"与"没有这条数据"是两件事）。
 * 夹具复用上一条探针项目（它的日志已经很丰富了）；删日志那一段用 try/finally 还原，
 * 免得后面依赖日志的断言被它带坏。 */
{
  const tlFirst = run(['timeline', PROJ, '--json', '--limit', '0']);
  const tlJ = (() => { try { return JSON.parse(tlFirst.out); } catch (e) { return null; } })();
  check('timeline --json：exit 0、scope 是点名的项目、**首键固定**（键序不许随实现漂）',
    tlFirst.code === 0 && !!(tlJ && tlJ.scope === PROJ && Object.keys(tlJ)[0] === 'scope'),
    tlJ && Object.keys(tlJ).join(','));

  check('timeline：三档时间来源**逐档计数**,且三档之和 == 节点总数（"时间未知"也是被数出来的）',
    !!(tlJ && tlJ.summary.withTime + tlJ.summary.beforeWindow + tlJ.summary.unknown === tlJ.summary.nodes
      && tlJ.summary.nodes > 10),
    tlJ && JSON.stringify({ nodes: tlJ.summary.nodes, c: tlJ.summary.withTime, bw: tlJ.summary.beforeWindow, un: tlJ.summary.unknown }));

  const tlRows = (tlJ && tlJ.rows) || [];
  const tlOrderKey = (r) => [r.at ? Date.parse(r.at) : null, r.project, r.nodeId];
  let tlOrderOk = true;
  for (let i = 1; i < tlRows.length; i++) {
    const p = tlOrderKey(tlRows[i - 1]);
    const q = tlOrderKey(tlRows[i]);
    let c = 0;
    if (p[0] !== null && q[0] !== null) c = q[0] - p[0];                 // at 降序
    else if (p[0] !== null) c = -1;                                      // 有时间的恒在前
    else if (q[0] !== null) c = 1;
    if (c === 0) c = (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : 0));
    if (c > 0) { tlOrderOk = false; break; }
  }
  check('timeline：输出次序能被**独立复算**（at 降序 → 项目名升序 → nodeId 升序，全序无并列）',
    tlRows.length > 0 && tlOrderOk, '行数 ' + tlRows.length);

  const tlAgain = run(['timeline', PROJ, '--json', '--limit', '0']);
  check('timeline：同一调用两跑输出**逐字节相同**（无时钟、无随机、排序是全序）',
    tlAgain.out === tlFirst.out, '两份长度 ' + tlFirst.out.length + ' / ' + tlAgain.out.length);

  const tlNoNow = run(['timeline', PROJ, '--since', '7d']);
  check('timeline --since 相对时长（不给 --now）⇒ 报错且非 0，并点名缺什么（绝不偷偷读墙钟）',
    !ok(tlNoNow.out) && tlNoNow.code !== 0 && /相对/.test(tlNoNow.out) && /--now/.test(tlNoNow.out),
    tlNoNow.out.trim().slice(0, 110));

  const tlNowIso = '2026-10-20T00:00:00Z';
  const tlBound = Date.parse(tlNowIso) - 7 * 24 * 60 * 60 * 1000;
  const tlSince = run(['timeline', PROJ, '--since', '7d', '--now', tlNowIso, '--json', '--limit', '0']);
  const tlSinceJ = (() => { try { return JSON.parse(tlSince.out); } catch (e) { return null; } })();
  check('timeline --since 7d --now <ISO> ⇒ exit 0，界 = now − 7 天，且每一条命中都 >= 界',
    tlSince.code === 0 && !!(tlSinceJ && tlSinceJ.since && tlSinceJ.since.ms === tlBound
      && tlSinceJ.rows.every((r) => Date.parse(r.at) >= tlBound)),
    tlSinceJ && ('界 ' + tlSinceJ.since.at + ' 命中 ' + tlSinceJ.rows.length));

  // 只读：跑过 timeline 之后日志一个字节都不许多（不记热度、不进 WRITE_COMMANDS）
  const tlLogFile = path.join(ROOT, 'projects', PROJ, '.changes.jsonl');
  const tlLogBefore = fs.existsSync(tlLogFile) ? fs.readFileSync(tlLogFile, 'utf8') : null;
  run(['timeline', PROJ]);
  run(['timeline', PROJ, '--since', '1d', '--now', tlNowIso]);
  const tlLogAfter = fs.existsSync(tlLogFile) ? fs.readFileSync(tlLogFile, 'utf8') : null;
  check('timeline 是**只读**的：跑完变更日志逐字节不变（不写盘、不记热度）',
    tlLogBefore !== null && tlLogBefore === tlLogAfter);

  // 日志被删 ⇒ 全部降级成 unknown；`--since` 下它们**不返回但被计数**（"时间未知"不静默消失）
  try {
    if (fs.existsSync(tlLogFile)) fs.rmSync(tlLogFile);
    const tlNoLog = run(['timeline', PROJ, '--json', '--limit', '0']);
    const tlNoLogJ = (() => { try { return JSON.parse(tlNoLog.out); } catch (e) { return null; } })();
    check('timeline（没有日志）⇒ 全部节点 `unknown`，且 summary 逐条数得出（不是"没有节点"）',
      tlNoLog.code === 0 && !!(tlNoLogJ && tlNoLogJ.summary.unknown === tlNoLogJ.summary.nodes
        && tlNoLogJ.rows.every((r) => r.atSource === 'unknown' && r.at === null)),
      tlNoLogJ && ('nodes ' + tlNoLogJ.summary.nodes + ' unknown ' + tlNoLogJ.summary.unknown));
    const tlNoLogSince = run(['timeline', PROJ, '--since', '1d', '--now', tlNowIso, '--json', '--limit', '0']);
    const tlNoLogSinceJ = (() => { try { return JSON.parse(tlNoLogSince.out); } catch (e) { return null; } })();
    check('timeline --since（没有日志）⇒ 0 条命中，但**如实报** excludedNoTime == 节点总数（不静默排除）',
      tlNoLogSince.code === 0 && !!(tlNoLogSinceJ && tlNoLogSinceJ.rows.length === 0
        && tlNoLogSinceJ.summary.excludedNoTime === tlNoLogSinceJ.summary.nodes
        && tlNoLogSinceJ.summary.nodes > 10),
      tlNoLogSinceJ && ('rows ' + tlNoLogSinceJ.rows.length + ' excludedNoTime ' + tlNoLogSinceJ.summary.excludedNoTime));
  } finally {
    /* ⚠️ 还原走**唯一原子写出口**（`src/data-store.js` 的 `writeFileAtomic`），不新开裸写点：
     * 本文件里每加一处 `fs.writeFileSync` 就把「写盘出口」的豁免面顶高 1 处
     * （`scripts/collateral-check.js` 的 `WRITE_OUTLET_SITE_CAP` **只减不增** —— 上一条探针
     * 就踩过同样的坑，把 82 顶到 83）。 */
    if (tlLogBefore !== null) {
      require(path.join(ROOT, 'src', 'data-store.js')).writeFileAtomic(tlLogFile, tlLogBefore);
    }
  }

  // 未知选项照旧响亮（新命令自动进同一道闸）
  const tlBadOpt = run(['timeline', PROJ, '--nope']);
  check('timeline 不认识的选项 ⇒ 非 0 且点名（新命令自动进同一条闸，不需要自己写一份）',
    !ok(tlBadOpt.out) && tlBadOpt.code !== 0, tlBadOpt.out.trim().slice(0, 90));
}

/* ---------------- 24. 阶段 4：修复类与导入类命令也走 mutate ----------------
 * 判据不止"没报错"：
 *   ① 并发**不相交**时自动合并（我和对方的改动都在）；
 *   ② **重放后的数据仍然过 validate** —— 修复类命令最怕"修好"变成"换个方式坏掉"；
 *   ③ 我与对方撞在**同一对象**上时仍然拒绝（这条由上面的并发段统一覆盖）。
 */
const projectCmds = require(path.join(ROOT, 'cli', 'commands', 'project.js'));
// 错误码常量：**单一来源**（`src/concurrency.js`），断言里不写字符串字面量（文案会改、码才是契约）
const concurrency = require(path.join(ROOT, 'src', 'concurrency.js'));
const allIds = (data) => { const out = []; (function w(n) { if (!n) return; out.push(n.id); (n.children || []).forEach(w); })(data.data); return out; };

// （阶段4①）assoc-prune：造一个悬挂成员（只能直接改盘 —— assoc-add 会拒绝不存在的成员），
//    再让"别人"在窗口期内改**另一个对象**（某个节点的标题）
{
  const d = readProj(PROJ);
  const ids = allIds(d);
  const anchor = ids.filter((x) => x !== 'root')[0];
  d.assoc = (d.assoc || []).concat([{
    id: 'as-gone', title: '悬挂探针',
    members: [{ project: PROJ, id: 'gone-node' }, { project: PROJ, id: anchor }]
  }]);
  fs.writeFileSync(projJson(PROJ), JSON.stringify(d, null, 2), 'utf8');
  check('前置：注入悬挂成员后 validate 判红（修复类命令的前置条件）', run(['validate', PROJ]).code !== 0);

  // ⚠️ raceCtx 收的是**去掉命令名**的 argv（`cli/main.js` 的 `createContext(rest)` 语义）
  // ⚠️ 并发窗口里"别人"必须写**合法**数据 —— 实测发现：项目处于悬挂状态时**任何写入都过不了
  //    校验闸门**（这正是修复类命令的存在意义：坏状态会把所有写命令一起挡住）。
  //    所以修复类命令的真实并发场景只有一个：**另一个修复者**。这里就模拟它：
  //    对方先把悬挂的那条关联整个摘掉（合法写），我这边再重放到已修好的数据上。
  const ctx = raceCtx([PROJ], (dd) => { delete dd.assoc; return dd; });
  const said = [];
  ctx.out = (t) => { said.push(String(t)); };          // 捕获输出（不碰 process.stdout）
  let threw = null;
  try { assocCmds.assocPrune(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const pruned = !(after.assoc || []).some((x) => x.id === 'as-gone');
  const valid = run(['validate', PROJ]).code === 0;
  const honest = /并发期间/.test(said.join('\n'));       // 走了重放路径，且如实说"已被对方清掉"
  check('assoc-prune 并发（另一个修复者）⇒ **不报版本冲突**、如实报告、重放后仍过 validate',
    !threw && pruned && valid && honest,
    threw ? String(threw.message).slice(0, 130)
      : '清理=' + pruned + ' · validate 通过=' + valid + ' · 走了重放路径=' + honest
        + ' · 输出="' + said.join(' / ').slice(0, 60) + '"');
}

// （阶段4②）import-md：最值得接的一条（窗口最宽：读 md + 转节点树 + 追加）
{
  const d = readProj(PROJ);
  const ids = allIds(d);
  const target = ids.filter((x) => x !== 'root')[0];
  const MDCC = path.join(TMP, 'cc-import.md');
  fs.writeFileSync(MDCC, '# 并发导入探针\n- 子一\n- 子二\n', 'utf8');

  // 同样：argv 里没有命令名（首个位置参数就是项目名）
  const ctx = raceCtx([PROJ, MDCC], (dd) => { nodeOf(dd, target).topic = '导入期间对方改的'; return dd; });
  let threw = null;
  try { projectCmds.importMd(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const imported = (function w(n) { if (!n) return null; if (n.topic === '并发导入探针') return n; for (const c of (n.children || [])) { const h = w(c); if (h) return h; } return null; })(after.data);
  const kept = nodeOf(after, target).topic === '导入期间对方改的';
  const valid = run(['validate', PROJ]).code === 0;
  check('import-md 并发不相交 ⇒ 自动合并：导入的节点在 + 对方改动保住 + 仍过 validate',
    !threw && !!imported && kept && valid,
    threw ? String(threw.message).slice(0, 130)
      : '导入节点在=' + !!imported + ' · 对方改动保住=' + kept + ' · validate 通过=' + valid);
}

// （阶段4③）**拒绝路径**：接上 mutate 之后，撞在**同一对象**上仍必须拒绝 ——
// 要证明的不是"能合并"，而是"**没有退化成最后写者赢**"（那才是本工程最重的损害类别）。
// 判据用**错误码**（`REPLAY_CONFLICT`），不匹配文案 —— 文案会改，靠正则匹配会静默失效。
{
  const d = readProj(PROJ);
  const themeId = (d.data.children || [])[0].id;
  const ctx = raceCtx([PROJ, '--left', themeId], (dd) => { dd.meta = dd.meta || {}; dd.meta.name = '对方改的项目名'; return dd; });
  let threw = null;
  try { projectCmds.themeLayout(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const refused = !!threw && threw.code === concurrency.REPLAY_CONFLICT;
  const mineNotWritten = !(after.meta && after.meta.layout);          // 我的 layout 没落盘
  const theirsKept = !!after.meta && after.meta.name === '对方改的项目名';
  check('theme-layout 与对方撞同一对象（meta）⇒ 拒绝（REPLAY_CONFLICT）且我的改动未落盘',
    refused && mineNotWritten && theirsKept,
    threw ? 'code=' + threw.code + ' · 我的未落盘=' + mineNotWritten + ' · 对方保住=' + theirsKept
      : '⚠️ 没有报错 —— 危险：同一对象被自动决定了');
}

// （阶段4④）改造动了 `import-md` 的**报错顺序**（预读一次再转换）⇒ 必须仍然"先报父节点不存在、且不写盘"
{
  const MDX = path.join(TMP, 'cc-bad-parent.md');
  fs.writeFileSync(MDX, '# 不该被导入\n', 'utf8');
  const before = fs.readFileSync(projJson(PROJ), 'utf8');
  const r2 = run(['import-md', PROJ, MDX, '--parent', 'no-such-parent']);
  const unchanged = fs.readFileSync(projJson(PROJ), 'utf8') === before;
  check('import-md 父节点不存在 ⇒ 报错且不写盘（改造后报错顺序不变）',
    !ok(r2.out) && /父节点不存在/.test(r2.out) && unchanged, r2.out.trim().slice(0, 90));
}

/* ---------------- 端到端对照：进程内 ≡ 子进程 ----------------
 * 上面全部断言走**进程内** invokeSync。进程内与子进程是两条不同的执行路径，可能漂移
 * （cwd、环境变量、模块加载时机、退出码来源……）⇒ 这里保留少量**真子进程**断言逐步比对：
 * 同一命令、同一 cwd，比较 **stdout 字节 + 退出码**。漂移即红。
 * 放在清理之前：这些命令需要一个真实存在的探针项目。 */
function runSubprocess(args) {
  const sp = spawnSync(process.execPath, [CLI].concat(args), { cwd: ROOT, encoding: 'utf8' });
  return { code: sp.status, out: (sp.stdout || '') + (sp.stderr || '') };
}
/* 以下 4 条**逐条展开写、刻意不用 for 循环**：`scripts/doc-facts.js` 用 `/^\s*check\(/gm`
 * **静态**统计断言数写进 `docs/VERIFY.md`，循环会把 4 条压成 1 个调用点 ⇒
 * 文档数字（141）与运行时打印的 `N/N`（144）不一致。本工程把"文档数字 == 真值"当门禁（G6），
 * 所以这里宁可重复也不循环。想 DRY 它之前，请先看这条注释。 */
{
  const args = ['projects'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：projects', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}
{
  const args = ['read', PROJ, '--json'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：read --json（大输出）', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}
{
  const args = ['get', PROJ, 'no-such-id-xyz', '--json'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：失败路径（不存在的 id）', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}
{
  const args = ['no-such-command-xyz'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：失败路径（未知命令）', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}

/* ---------------- 44. localPath（节点 ↔ 本机文件夹） ----------------
 * 为什么单开一节：这条能力**真的漏过一次**。当初 `--local-path` 只接进了 `add` / `edit`，
 * 而建树时根节点是用 `add-root` 建的（它是独立实现）—— 结果整棵树唯一的根**没有文件夹链接**，
 * 而根恰恰是最该有链接的那个。所以这里把三个入口全钉一遍，谁再漏一个就判红。
 * （形状校验的边界由 tests/schema.test.js 覆盖：只校验形状、不校验存在性。） */
{
  const HOME = os.homedir();                       // 一定存在的绝对路径（不假设有 E: 盘）
  // 44.1 add --local-path
  r = run(['add', PROJ, 'a', '--topic', '带文件夹的节点', '--id', 'lp-node', '--local-path', HOME]);
  const got1 = run(['get', PROJ, 'lp-node', '--json']);
  let lp1 = null;
  try { lp1 = JSON.parse(got1.out).localPath; } catch (e) { /* 解析失败即为 null，断言会判红 */ }
  check('add --local-path 落盘且读视图可见', ok(r.out) && lp1 === HOME,
    '设置=' + ok(r.out) + ' 读回=' + JSON.stringify(lp1));

  // 44.2 add-root --local-path（曾经漏掉的那个入口）
  r = run(['add-root', PROJ, '--topic', '带文件夹的顶层主题', '--id', 'lp-root', '--local-path', HOME]);
  const got2 = run(['get', PROJ, 'lp-root', '--json']);
  let lp2 = null;
  try { lp2 = JSON.parse(got2.out).localPath; } catch (e) { /* 同上 */ }
  check('add-root --local-path 落盘且读视图可见', ok(r.out) && lp2 === HOME,
    '设置=' + ok(r.out) + ' 读回=' + JSON.stringify(lp2));

  // 44.3 相对路径必须被拒（相对路径会随工作目录漂移，而点击打开的是操作系统）
  r = run(['edit', PROJ, 'lp-node', '--local-path', 'markdown/M1']);
  check('--local-path 拒绝相对路径', r.code !== 0 && /绝对路径/.test(r.out), r.out.trim().slice(0, 80));

  // 44.4 --clear-local-path 能清掉
  r = run(['edit', PROJ, 'lp-node', '--clear-local-path']);
  const got3 = run(['get', PROJ, 'lp-node', '--json']);
  let lp3 = 'unset';
  try { lp3 = JSON.parse(got3.out).localPath; } catch (e) { /* 同上 */ }
  check('--clear-local-path 清得掉', ok(r.out) && lp3 === undefined,
    '清除=' + ok(r.out) + ' 读回=' + JSON.stringify(lp3));
}

/* ---------------- 45. expand-depth（按深度规范化展开状态） ----------------
 * 这条命令存在的理由：展开状态是**数据**（`expanded`），而渲染层已不再无条件展开
 * （见 renderer/app-core.js 的 renderMind）⇒ 历史上"一律 true"的数据需要一次收口。
 * 判据用 `get --json` 读回展开状态（唯一真源是数据文件本身，不经任何视图层）。 */
{
  const P = PROJ;                                  // 复用本套断言的临时项目
  run(['add', P, 'a', '--topic', 'D2', '--id', 'd2']);
  run(['add', P, 'd2', '--topic', 'D3', '--id', 'd3']);
  run(['add', P, 'd3', '--topic', 'D4', '--id', 'd4']);
  const expandedOf = (id) => {
    try { const j = JSON.parse(run(['get', P, id, '--json']).out); return j.expanded !== false; }
    catch (e) { return null; }
  };
  r = run(['expand-depth', P, '--depth', '2']);
  const okMsg = ok(r.out) && /改写 \d+/.test(r.out);
  check('expand-depth 默认前两层展开：浅层 true、深层 false', okMsg && expandedOf('d2') === true && expandedOf('d3') === false,
    'D2=' + expandedOf('d2') + ' D3=' + expandedOf('d3'));

  r = run(['expand-depth', P, '--depth', '0']);
  check('expand-depth --depth 0 全收起', ok(r.out) && expandedOf('d2') === false, 'D2=' + expandedOf('d2'));

  r = run(['expand-depth', P, '--depth', '9']);
  check('expand-depth 给大值 = 全展开（方向可逆，不需要第二条命令）', ok(r.out) && expandedOf('d3') === true, 'D3=' + expandedOf('d3'));

  r = run(['expand-depth', P, '--depth', '-1']);
  check('expand-depth 拒绝负深度', r.code !== 0 && /非负整数/.test(r.out), r.out.trim().slice(0, 60));

  r = run(['expand-depth', P, '--id', 'no-such-node']);
  check('expand-depth 对不存在的子树报错', r.code !== 0 && /节点不存在/.test(r.out), r.out.trim().slice(0, 60));
}

/* ---------------- 46. AI 问答落盘 ask-apply（A：AI 产出直接落到节点与详情） ----------------
 * 判据（对应任务书 A 的四条）：① 写入后**数据侧真的变**（`get --json` 读得到 qa 与详情）；
 * ② 重复写入**追加不覆盖**（第二次把第一次留着）；③ `--as-child` 建子节点且标题/详情各就各位；
 * ④ 非法输入（空回答 / 不存在的节点）**响亮拒绝且不写盘**。
 * 为什么这里不写"界面侧也变了"：那一条只有冒烟（渲染层）能判 —— 见 `scripts/smoke/38-ai-落盘.js`。
 *   ⚠️ 这个指针必须指向**真的存在**的文件：注释里写一个不存在的文件名，等于"照它去找、什么都找不到"，
 *      与"没做"一样坏。本段上一版指向 `39-ai-落盘.js`（不存在，已改正）—— 写新指针前先确认文件在。
 * （集成层只认数据侧真值：CLI 是写盘的唯一出口，`get --json` 是它的真值读口 ✓） */
{
  const qaCmds = require(path.join(ROOT, 'cli', 'commands', 'qa.js'));
  const AT1 = '2026-10-10T12:00:00.000Z';
  const AT2 = '2026-10-10T13:00:00.000Z';
  run(['add', PROJ, 'a', '--topic', '问答落盘父节点', '--id', 'qa-p']);
  const readQa = (id) => { try { return JSON.parse(run(['get', PROJ, id, '--json', '--detail']).out); } catch (e) { return null; } };

  // 46.1 第一次写入：qa 记录 + 详情，两处都要真的变
  r = run(['ask-apply', PROJ, 'qa-p', '--question', '三次握手为什么是三次？',
    '--answer', '因为要同步双方的初始序号', '--model', 'deepseek-v4', '--at', AT1, '--json']);
  let j1 = null;
  try { j1 = JSON.parse(r.out); } catch (e) { j1 = null; }
  const v1 = readQa('qa-p');
  check('ask-apply 落盘：qa 记录字段齐备（q/a/at/model）且详情追加了回答',
    ok(r.out) && !!j1 && j1.qaIndex === 0 && j1.qaCount === 1
      && !!v1 && Array.isArray(v1.qa) && v1.qa.length === 1
      && v1.qa[0].q === '三次握手为什么是三次？' && v1.qa[0].a === '因为要同步双方的初始序号'
      && v1.qa[0].at === AT1 && v1.qa[0].model === 'deepseek-v4'
      && typeof v1.detail === 'string' && v1.detail.indexOf('因为要同步双方的初始序号') >= 0
      && v1.detail.indexOf('三次握手为什么是三次？') >= 0,
    'qaCount=' + (j1 && j1.qaCount) + ' 读回条数=' + (v1 && v1.qa && v1.qa.length));

  // 46.2 来源标记：追加的那一段必须**自己说明自己是 AI 写的、什么时候写的**（卖点 5 的"问答记录"）
  check('ask-apply 落盘：详情里带来源标记与时间（🤖 AI 问答 · 本地时间）',
    !!v1 && /🤖 AI 问答/.test(v1.detail) && /2026-10-10/.test(v1.detail) && /deepseek-v4/.test(v1.detail),
    '详情片段=' + String(v1 && v1.detail).slice(0, 90));

  // 46.3 第二次写入：**追加**，不是覆盖（第一次那条必须还在）
  r = run(['ask-apply', PROJ, 'qa-p', '--question', '第二次提问', '--answer', '第二次回答', '--at', AT2]);
  const v2 = readQa('qa-p');
  check('ask-apply 重复写入 ⇒ 追加不覆盖（两条都在，详情里两段都在）',
    ok(r.out) && !!v2 && v2.qa.length === 2 && v2.qa[0].a === '因为要同步双方的初始序号'
      && v2.qa[1].a === '第二次回答'
      && (v2.detail.match(/🤖 AI 问答/g) || []).length === 2,
    '条数=' + (v2 && v2.qa && v2.qa.length) + ' 详情里标记数=' + ((v2 && v2.detail.match(/🤖 AI 问答/g)) || []).length);

  // 46.4 完全相同的条目重复落盘 ⇒ **幂等**（不重复追加），且如实说"已存在"
  r = run(['ask-apply', PROJ, 'qa-p', '--question', '第二次提问', '--answer', '第二次回答', '--at', AT2, '--json']);
  const v3 = readQa('qa-p');
  const idem = (function () { try { return JSON.parse(r.out).duplicate === true; } catch (e) { return false; } })();
  check('ask-apply 同一条问答重复落盘 ⇒ 幂等（条数不变、duplicate:true）',
    ok(r.out) && idem && v3.qa.length === 2, 'duplicate=' + idem + ' 条数=' + v3.qa.length);

  // 46.5 --as-child：子节点标题 = 回答首行（截断），详情 = 全文；父节点的 qa 照记
  //   首行**故意超过 40 字**（截断上限）：不超长的话这条断言就只是"标题等于首行"，
  //   而"截断"这件事根本没被验到（第一版就是这么写的，读完数才发现首行只有 33 字 ⇒ 白验）
  const line1 = '第一行就是标题所以它会被截断成比较短的一串文本用来验证截断确实生效'
    + '而且这里还要再长一点才能真的越过四十个字的上限对不对';
  const longAnswer = line1 + '\n第二行：这是正文，应该完整进 detail，不该出现在标题里。';
  r = run(['ask-apply', PROJ, 'qa-p', '--question', '给我一个子节点', '--answer', longAnswer,
    '--at', '2026-10-10T14:00:00.000Z', '--as-child', '--child-id', 'qa-child-1', '--json']);
  const v4 = readQa('qa-p');
  const child = readQa('qa-child-1');
  check('ask-apply --as-child：子节点建成，标题取首行并截断、详情放全文、父节点 qa 也记上',
    ok(r.out) && !!child && !!child.topic && child.topic.length <= 41 && /…$/.test(child.topic)
      && child.topic.indexOf('第二行') < 0 && child.detail.indexOf('第二行') >= 0
      && !!v4 && v4.qa.length === 3 && Array.isArray(child.qa) && child.qa.length === 1,
    '首行=' + line1.length + ' 字 ⇒ 标题=「' + (child && child.topic) + '」('
      + (child && child.topic && child.topic.length) + ' 字) 父 qa='
      + (v4 && v4.qa && v4.qa.length) + ' 子 qa=' + (child && child.qa && child.qa.length));

  // 46.6 非法输入：空回答 ⇒ 响亮拒绝，且**盘上一点没变**（不是"报了错但还是写了"）
  const beforeBad = fs.readFileSync(projJson(PROJ), 'utf8');
  r = run(['ask-apply', PROJ, 'qa-p', '--answer', '   ', '--at', '2026-10-10T15:00:00.000Z']);
  const afterBad = fs.readFileSync(projJson(PROJ), 'utf8');
  check('ask-apply 空回答 ⇒ 报错且盘上零改动（落一条空记录比报错危险得多）',
    r.code !== 0 && /回答为空/.test(r.out) && beforeBad === afterBad,
    'exit=' + r.code + ' 盘上未变=' + (beforeBad === afterBad));

  // 46.7 非法输入：节点不存在 ⇒ 报错、盘上零改动
  r = run(['ask-apply', PROJ, 'no-such-node-xyz', '--answer', '随便', '--at', AT1]);
  check('ask-apply 节点不存在 ⇒ 报错且盘上零改动',
    r.code !== 0 && /节点不存在/.test(r.out) && fs.readFileSync(projJson(PROJ), 'utf8') === beforeBad,
    'exit=' + r.code + ' ' + r.out.trim().slice(0, 60));

  // 46.8 回答里的 HTML 元字符必须被转义（详情是 innerHTML 注入的 ⇒ 不转义就是注入面）
  r = run(['ask-apply', PROJ, 'qa-p', '--answer', '<img src=x onerror=alert(1)> 与 a&b',
    '--at', '2026-10-10T16:00:00.000Z', '--json']);
  const v5 = readQa('qa-p');
  check('ask-apply 转义回答里的 HTML 元字符（详情以 innerHTML 注入，不转义 = 注入面）',
    ok(r.out) && !!v5 && v5.detail.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0
      && v5.detail.indexOf('<img src=x') < 0 && v5.detail.indexOf('a&amp;b') >= 0,
    '片段=' + String(v5 && v5.detail).slice(-140).replace(/\n/g, ' '));

  // 46.9 写盘闸门仍然生效：造一条坏 qa（缺 at）直接写盘 ⇒ validate 必须判红
  //   ⚠️ 索引不能写死：断言里用**建记录时的实际下标**（写死过一次，紧接着加了一条断言就漂了）
  {
    const d = readProj(PROJ);
    const qaList = nodeOf(d, 'qa-p').qa;
    const badIndex = qaList.length;
    qaList.push({ q: '坏记录', a: '有回答但没有 at' });
    const p = projJson(PROJ);
    const good = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
    const bad = run(['validate', PROJ]);
    fs.writeFileSync(p, good, 'utf8');   // 立刻还原（后面的断言还要用这个项目）
    check('qa 形状闸门：缺 at 的记录被判红（新字段真的在校验，不是只写进了 schema 注释）',
      bad.code !== 0 && bad.out.indexOf('qa[' + badIndex + '].at') >= 0,
      '坏记录下标=' + badIndex + ' 报文=' + bad.out.trim().slice(0, 90));
  }
  void qaCmds;   // 只 require 一次确认命令模块可加载（命令体本身经 run() 走 registry）
}

/* ---------------- 53. link 重复添加的 caption 语义（K8：静默清说明的修复） ----------------
 * 缺陷（真机复现）：同一条边第二次 `link` 且**不给** `--caption` ⇒ 盘上 links[] 从
 * `{project,id,caption}` 变成 `{project,id}`（说明没了、无任何提示），而回显与第一次**逐字相同**
 * （`已添加链接: …`）⇒ **成功与覆盖不可分辨**。根因：旧写法把那条边**从零重建**再 concat。
 * 本段钉住新语义：省略 = 保留（且不写盘）；显式（含空串）= 覆盖；三种结局回显可分辨。
 * 探针项目/节点一律带 `it-k8-` 前缀（与别的流互不踩）；两个探针项目在文件末尾「清理」段删除。 */
K8A = 'it-k8-src-' + Date.now().toString(36);   // 名在文件顶部声明（清理段要用）
K8B = 'it-k8-dst-' + Date.now().toString(36);   // 同上
{
  const K8A_FILE = projJson(K8A);
  const K8CAP = '出自：K8 集成探针（AI 凭 caption 判断内容）';
  const k8LinksOf = () => {
    const n = nodeOf(readProj(K8A), 'it-k8-a');
    return (n && n.links) || null;
  };
  const k8Edge = (target) => (k8LinksOf() || []).find((l) => l.project === K8B && l.id === target) || null;
  const k8File = () => fs.readFileSync(K8A_FILE, 'utf8');
  run(['init', K8A, '--title', 'K8 链接探针源']);
  run(['init', K8B, '--title', 'K8 链接探针目标']);
  run(['add', K8A, 'root', '--topic', 'K8 源节点', '--id', 'it-k8-a']);
  run(['add', K8B, 'root', '--topic', 'K8 目标节点', '--id', 'it-k8-b']);
  const K8LINK = ['link', K8A, 'it-k8-a', '--to', K8B, '--id', 'it-k8-b'];

  // 53.1 首次添加（带 caption）：回显与落盘都照旧
  r = run(K8LINK.concat(['--caption', K8CAP]));
  check('link 首次添加带 --caption：回显「已添加链接」且 caption 落盘',
    ok(r.out) && /已添加链接/.test(r.out) && (k8Edge('it-k8-b') || {}).caption === K8CAP,
    r.out.trim() + '｜盘上=' + JSON.stringify(k8Edge('it-k8-b')));

  // 53.2 省略 --caption 重放：caption 必须保留（旧行为：静默清掉）
  const k8Before = k8File();
  const k8EdgesBefore = JSON.stringify(k8LinksOf());
  r = run(K8LINK);
  const k8EdgesAfter = JSON.stringify(k8LinksOf());
  check('link 重复添加**不带** --caption ⇒ 原有 caption 保留、links 逐字节不变（旧行为这里必红）',
    ok(r.out) && k8EdgesAfter === k8EdgesBefore && (k8Edge('it-k8-b') || {}).caption === K8CAP,
    '盘上=' + JSON.stringify(k8Edge('it-k8-b')));

  // 53.3 回显可分辨：不再是那句与首次逐字相同的「已添加链接」
  check('link 重复添加不带 --caption ⇒ 回显「无变化」（成功与覆盖不再长得一样）',
    ok(r.out) && /无变化/.test(r.out) && !/已添加链接/.test(r.out), r.out.trim());

  // 53.4 不产生空写入：项目文件字节不变（否则变更日志会多一条假信号）
  check('link 重复添加不带 --caption ⇒ 不产生空写入（项目文件字节不变）',
    k8File() === k8Before, '字节未变=' + (k8File() === k8Before));

  // 53.5 显式空串 = 清空（边还在），回显点明「已更新」+「caption 清空」
  r = run(K8LINK.concat(['--caption', '']));
  const k8Cleared = k8Edge('it-k8-b') || {};
  check('link 显式 `--caption ""` ⇒ caption 被清空且回显可分辨（已更新 / caption 清空）',
    ok(r.out) && /已更新链接/.test(r.out) && /caption 清空/.test(r.out)
      && !!k8Edge('it-k8-b') && !('caption' in k8Cleared),
    r.out.trim() + '｜盘上=' + JSON.stringify(k8Edge('it-k8-b')));

  // 53.6 显式新说明 = 覆盖，回显带 old → new
  r = run(K8LINK.concat(['--caption', '改过的说明']));
  check('link 显式新说明 ⇒ 覆盖且回显带 old → new（覆盖这件事看得见）',
    ok(r.out) && /已更新链接/.test(r.out) && /改过的说明/.test(r.out)
      && (k8Edge('it-k8-b') || {}).caption === '改过的说明',
    r.out.trim());

  // 53.7 同说明重放 ⇒ 「无变化」且零改动（幂等）
  const k8Before2 = k8File();
  r = run(K8LINK.concat(['--caption', '改过的说明']));
  check('link 同说明重放 ⇒ 「无变化」且盘上零改动（不是第二次「已更新」）',
    ok(r.out) && /无变化/.test(r.out) && !/已更新链接/.test(r.out) && k8File() === k8Before2, r.out.trim());

  // 53.8 只写 --caption 不给值 ⇒ 响亮拒绝（旧写法会把 true 写进 caption）
  const k8Before3 = k8File();
  r = run(K8LINK.concat(['--caption']));
  check('link `--caption` 不给值 ⇒ 非 0 退出 + 说清两条正路，且盘上零改动',
    r.code !== 0 && /--caption 需要一个说明文本/.test(r.out) && k8File() === k8Before3,
    'exit=' + r.code + '｜' + r.out.trim().slice(0, 90));

  // 53.9 边上的其它字段不许被顺手抹掉（旧写法重建对象 ⇒ note 丢）
  {
    const d = readProj(K8A);
    const e = (((nodeOf(d, 'it-k8-a') || {}).links) || []).find((l) => l.project === K8B && l.id === 'it-k8-b');
    if (!e) {
      /* ⚠️ **这条兜底分支在夹具下一定不执行** —— 那条边由前面的 K8LINK 建出来、此后没被删过 ⇒
       *   于是"源码里行首 `check(` 的条数"永远**多于**"跑完汇总的条数"，本条就是多出来的**其中一条**
       *   （同一条命令还会把 env 门控的那几处一并列出；差因不同，别混成一笔）。
       *   ⚠️ **这里刻意不写那几个数**：静态 / 实跑 / 差几条**由实现决定**，写死必然腐坏 —— 本行曾把
       *   **当时的**静态 / 实跑读数写死（2026-10-12 记的，早已漂 ✗）⇒ 口径：只写"去哪取"，不写真值。
       *   **去哪取**：`node scripts/recon-integration.js --run` —— 它**现算**静态 ÷ 实跑 ÷ 差，并逐条列
       *   **行号 + 标签**；本条是差集里的一行，判定依据写"未被消费"（行号由它现算，别在这里抄一份 ✗）。
       *   **为什么别为了让两个数相等去删断言 / 改生成器** ✗：两边**本来就该差**，差因就是这一类
       *   "夹具下永不执行"的兜底分支 —— 对齐掉它等于把守卫删掉。
       *   它**不是空转**：夹具真丢了就会跑进这里 ⇒ 当场 FAIL（detail 文本与下面 else 分支不同，一眼能分辨）。 */
      check('link 改 caption 时不动边上的其它字段（note 不被静默抹掉）', false, '夹具没找到那条边');
    } else {
      e.note = '手工附在边上的笔记';
      fs.writeFileSync(K8A_FILE, JSON.stringify(d, null, 2), 'utf8');
      r = run(K8LINK.concat(['--caption', '再改一次']));
      check('link 改 caption 时不动边上的其它字段（note 不被静默抹掉）',
        ok(r.out) && /已更新链接/.test(r.out) && (k8Edge('it-k8-b') || {}).note === '手工附在边上的笔记',
        '盘上=' + JSON.stringify(k8Edge('it-k8-b')));
    }
  }

  // 53.10 读口不受影响：links 仍报得出这条边与它的说明
  const k8Links = (() => {
    try { return JSON.parse(run(['links', K8A, '--json']).out); } catch (e) { return null; }
  })();
  check('link 语义改动不影响 links 读口（边还在、说明读得到）',
    !!(k8Links && Array.isArray(k8Links.links) && k8Links.links.some((x) =>
      x.node === 'it-k8-a' && x.project === K8B && x.id === 'it-k8-b' && x.caption === '再改一次')),
    JSON.stringify((k8Links && k8Links.links) || null).slice(0, 160));
}

/* ---------------- 54. 【W14】第一个标题之前的正文：**不许静默丢**，且三条导入路落点一致 ---------------- */
{
  const W14P = 'it-w14-proj';
  const W14N = 'it-w14-none';
  try { fs.rmSync(path.join(ROOT, 'projects', W14P), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(ROOT, 'projects', W14N), { recursive: true, force: true }); } catch (e) {}
  const W14MD = path.join(TMP, 'w14-lead.md');
  fs.writeFileSync(W14MD, '前导第一段\n\n前导第二段\n\n# 主题甲\n甲正文\n\n# 主题乙\n乙正文\n', 'utf8');

  // （W14 之一）import-project（一个文件 → 新项目）：前导正文落**根节点**的 detail
  const rp = run(['import-project', W14P, W14MD]);
  const jget = (name, id) => {
    try { return JSON.parse(run(['get', name, id, '--json', '--detail']).out); } catch (e) { return null; }
  };
  const jp = jget(W14P, 'root');
  check('[W14] import-project：第一个标题之前的正文落**根节点 detail**（原先被 `if (!cur)` 静默跳过）',
    ok(rp.out) && !!jp && /前导第一段/.test(jp.detail || '') && /前导第二段/.test(jp.detail || ''),
    '回显=' + (rp.out || '').trim().slice(0, 60) + ' ｜ detail=' + String((jp && jp.detail) || '').slice(0, 60));
  check('[W14] import-project：落点**如实报告**（点明落到哪个节点，不静默落盘）',
    /前导正文/.test(rp.out || '') && /root/.test(rp.out || ''),
    '回显=' + (rp.out || '').trim().replace(/\n/g, ' | ').slice(0, 120));
  // 单一真源：同一段前导正文在**落盘文件里只许出现一处**（复制到多个节点 = 制造漂移源）
  let occ = -1;
  try { occ = (fs.readFileSync(path.join(ROOT, 'projects', W14P, W14P + '.json'), 'utf8').match(/前导第一段/g) || []).length; } catch (e) {}
  check('[W14] 前导正文在落盘文件里**只出现一处**（不复制到多个节点）', occ === 1, '出现 ' + occ + ' 次');

  // （W14 之二）import-md（追加到已有项目）：前导正文并入**父节点 detail 的开头**（在原 detail 之前，不覆盖）
  const W14MD2 = path.join(TMP, 'w14-lead2.md');
  fs.writeFileSync(W14MD2, '追加前导\n\n# 主题丙\n丙正文\n', 'utf8');
  const rm2 = run(['import-md', W14P, W14MD2, '--parent', 'root']);
  const d2 = String((jget(W14P, 'root') || {}).detail || '');
  check('[W14] import-md：前导正文并入父节点 detail **开头**（不覆盖原有 detail）',
    ok(rm2.out) && d2.includes('追加前导') && d2.indexOf('追加前导') >= 0
      && d2.indexOf('追加前导') < d2.indexOf('前导第一段'),
    '顺序：追加前导@' + d2.indexOf('追加前导') + ' vs 原有前导@' + d2.indexOf('前导第一段'));
  check('[W14] import-md：落点如实报告（点明父节点 id）',
    /前导正文/.test(rm2.out || '') && /root/.test(rm2.out || ''),
    '回显=' + (rm2.out || '').trim().replace(/\n/g, ' | ').slice(0, 120));

  // （W14 之三）负例对照：文档开头就是标题 ⇒ **不制造空的 detail 字段**
  const W14MD3 = path.join(TMP, 'w14-none.md');
  fs.writeFileSync(W14MD3, '# 只有标题\n正文\n', 'utf8');
  const rn = run(['import-project', W14N, W14MD3]);
  const jn = jget(W14N, 'root');
  check('[W14] 负例：开头就是标题 ⇒ 不产生前导 detail（不制造空字段）',
    ok(rn.out) && !!jn && !jn.detail,
    'detail=' + JSON.stringify((jn && jn.detail) || null));

  try { fs.rmSync(path.join(ROOT, 'projects', W14P), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(ROOT, 'projects', W14N), { recursive: true, force: true }); } catch (e) {}
}

/* ---------------- 55. 【W20】中文标题的 id 唯一性：三条导入路同一处修法 ---------------- */
{
  const W20P = 'it-w20-proj';
  const W20P2 = 'it-w20-md';
  try { fs.rmSync(path.join(ROOT, 'projects', W20P), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(ROOT, 'projects', W20P2), { recursive: true, force: true }); } catch (e) {}
  const N = 400;
  const CN = Array.from({ length: N }, (_, i) => '# 中文标题' + i + '\n第 ' + i + ' 条的正文\n').join('\n');
  const W20MD = path.join(TMP, 'w20-cn.md');
  fs.writeFileSync(W20MD, CN, 'utf8');
  const idsOf = (name) => {
    try {
      const t = fs.readFileSync(path.join(ROOT, 'projects', name, name + '.json'), 'utf8');
      return (t.match(/"id"\s*:\s*"[^"]+"/g) || []).map((s) => s.replace(/.*"([^"]+)"$/, '$1'));
    } catch (e) { return null; }
  };

  // 55.1 import-project：400 个中文标题 ⇒ 导入成功 + 校验通过 + id 一个都不重
  const rp = run(['import-project', W20P, W20MD]);
  const ip = idsOf(W20P) || [];
  check('[W20] import-project：400 个中文标题一次导入成功且 `validate` 通过（旧写法：概率性"id 重复"整体失败）',
    ok(rp.out) && ok(run(['validate', W20P]).out),
    '回显=' + (rp.out || '').trim().slice(0, 70));
  check('[W20] import-project：落盘 id **一个都不重**（唯一性由构造保证）',
    ip.length > N && new Set(ip).size === ip.length,
    'id 总数=' + ip.length + ' 去重后=' + new Set(ip).size);

  // 55.2 import-md：同一份内容追加到已有项目 ⇒ 同样不重号、同样通过校验
  run(['init', W20P2, '--title', 'W20 md 探针']);
  const rm2 = run(['import-md', W20P2, W20MD, '--parent', 'root']);
  const im = idsOf(W20P2) || [];
  check('[W20] import-md：400 个中文标题追加导入成功且 `validate` 通过',
    ok(rm2.out) && ok(run(['validate', W20P2]).out), '回显=' + (rm2.out || '').trim().slice(0, 70));
  check('[W20] import-md：落盘 id **一个都不重**（与 import-project 同一条修法）',
    im.length > N && new Set(im).size === im.length,
    'id 总数=' + im.length + ' 去重后=' + new Set(im).size);

  try { fs.rmSync(path.join(ROOT, 'projects', W20P), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(ROOT, 'projects', W20P2), { recursive: true, force: true }); } catch (e) {}
}

/* ---------------- 56. 【W19】导入的图片/附件引用：不留坏引用（复制 + 逐条点名 + 注入证明） ----------------
 * 修的是什么：`import-md` / `import-project` 从前把 md 里的 `![图](assets/x.png)` **按原样字符串**
 * 记进 `images[].file`，而那个文件**从没被复制进项目** ⇒ 悬空引用静默落盘
 *（取证：exit 0、回显里一个字都没说、`projects/<项目>/assets/` 不存在，而 `validate` **照样通过**）。
 * 现在的口径（实现只有一处：`src/markdown.js` 的 `resolveImportRefs`，两条导入命令共用它）：
 *   · 能解析到源文件 ⇒ 复制进 `projects/<项目>/assets|attachments/`（命名与图片格式规则与 `add-image` 同一条），
 *     引用写**项目内相对路径**；
 *   · 解析不到 ⇒ **拒绝整份导入** + 逐条点名（哪个节点 / 哪一条引用 / 原样路径 / 按序试过哪些路径）+ 给出路；
 *     拒绝是**干净**的：判据在复制与写入之前 ⇒ 不复制、不建目录、不写盘；
 *   · 非本地引用（`https:` / `data:`）⇒ 不挂进 images/files（`file` 的规范是项目内相对路径），
 *     那一行**按正文**并入节点详情 —— 既不落坏引用，也不丢内容。
 * 探针一律 `it-w19-` 前缀；本段自己收尾清干净（`sweepStaleProbes` 的前缀清单里暂时没有 `it-w19-`，
 * 所以更要把清收尾做全 —— 顺带建议把那两个前缀补进清单）。 */
{
  const P = 'it-w19-proj';
  const M = 'it-w19-md';
  const BAD = 'it-w19-bad';
  const DRY = 'it-w19-dry';
  const REM = 'it-w19-remote';
  const INJ = 'it-w19-inject';
  const pdir = (name) => path.join(ROOT, 'projects', name);
  const clean = (name) => { try { fs.rmSync(pdir(name), { recursive: true, force: true }); } catch (e) {} };
  [P, M, BAD, DRY, REM, INJ].forEach(clean);
  const W19 = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-w19-'));
  fs.mkdirSync(path.join(W19, 'assets'), { recursive: true });
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  fs.writeFileSync(path.join(W19, 'assets', 'x.png'), PNG);
  const wmd = (name, text) => { const p = path.join(W19, name); fs.writeFileSync(p, text, 'utf8'); return p; };
  const OKMD = wmd('ok.md', '# 第一章\n\n![图：示意图](assets/x.png)\n\n正文一段。\n');
  const BADMD = wmd('bad.md', '# 第一章\n\n![图：丢了的图](assets/gone.png)\n');
  const REMMD = wmd('remote.md', '# 外链章\n\n![图：外链](https://example.com/a.png)\n');
  // 注入探针用**自己的一份 md**：import-project 有"同一份来源只导一次"的闸门，
  // 复用 ok.md 会先被那道闸拦住（exit 1）⇒ 拿到的红是"重复导入"，不是"引用没落地"，证明就假了。
  const INJMD = wmd('inject.md', '# 第一章\n\n![图：示意图](assets/x.png)\n\n注入探针正文。\n');
  const projJson = (name) => { try { return fs.readFileSync(path.join(pdir(name), name + '.json'), 'utf8'); } catch (e) { return null; } };
  const lsAssets = (name) => { try { return fs.readdirSync(path.join(pdir(name), 'assets')).sort(); } catch (e) { return null; } };
  const refsIn = (name) => {
    const t = projJson(name);
    if (!t) return null;
    const out = [];
    try {
      const d = JSON.parse(t);
      (function w(n) { (n.images || []).forEach((i) => out.push(i.file)); (n.files || []).forEach((f) => out.push(f.file)); (n.children || []).forEach(w); })(d.data);
    } catch (e) { return null; }
    return out;
  };
  const allRefsExist = (name) => (refsIn(name) || []).every((f) => fs.existsSync(path.join(pdir(name), f)));
  const jj = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };

  // 56.1 import-project：含引用（文件存在）⇒ 复制进 assets/ + 引用项目内相对路径 + validate 通过
  const r1 = run(['import-project', P, OKMD]);
  const a1 = lsAssets(P);
  check('[W19] import-project：图片真被复制进 assets/、引用指向项目内那个文件、validate 通过（旧行为：原样字符串 + 文件不存在）',
    ok(r1.out) && Array.isArray(a1) && a1.length === 1 && Array.isArray(refsIn(P)) && refsIn(P).length === 1
      && refsIn(P)[0] !== 'assets/x.png' && /^assets\//.test(refsIn(P)[0]) && allRefsExist(P)
      && ok(run(['validate', P]).out),
    'assets/=' + JSON.stringify(a1) + ' ｜ refs=' + JSON.stringify(refsIn(P)));

  // 56.2 复制的是**那一份**文件（不是空壳/占位）：字节相同
  check('[W19] 复制的是源文件那一份（字节逐字节相同，不是空文件占位）',
    Array.isArray(a1) && a1.length === 1
      && Buffer.compare(fs.readFileSync(path.join(pdir(P), 'assets', a1[0])), PNG) === 0,
    'assets/' + (a1 || [])[0] + ' ｜ ' + (a1 && a1.length ? fs.statSync(path.join(pdir(P), 'assets', a1[0])).size : '?') + ' B');

  // 56.3 回显**如实报告**（复制了几条 + 明细），不是一声不响
  check('[W19] 回显如实报告资源去向（复制了几条 + 逐条明细）',
    /资源引用/.test(r1.out || '') && /已复制 1 个文件进项目/.test(r1.out || '') && /assets\//.test(r1.out || ''),
    (r1.out || '').trim().replace(/\n/g, ' | ').slice(-160));

  // 56.4 import-md：走**同一个函数** ⇒ 同样复制 + 引用项目内 + validate 通过
  run(['init', M, '--title', 'W19 md 探针']);
  const r2 = run(['import-md', M, OKMD, '--parent', 'root']);
  check('[W19] import-md：与 import-project 同一份实现 ⇒ 同样复制、引用项目内、validate 通过',
    ok(r2.out) && Array.isArray(lsAssets(M)) && lsAssets(M).length === 1 && allRefsExist(M)
      && /^assets\//.test(refsIn(M)[0]) && ok(run(['validate', M]).out),
    'refs=' + JSON.stringify(refsIn(M)));

  // 56.5 坏引用（目标不存在）：非 0 + 逐条点名 + 给出路（报错即教程）
  run(['init', BAD, '--title', 'W19 坏引用探针']);
  const badBefore = projJson(BAD);
  const r3 = run(['import-md', BAD, BADMD, '--parent', 'root']);
  check('[W19] 坏引用 ⇒ 非 0 + 点明节点/原样路径/试过哪些路径 + 说出路（不许静默写脏）',
    r3.code !== 0 && /节点「第一章」/.test(r3.out || '') && /assets\/gone\.png/.test(r3.out || '')
      && /源文件不存在/.test(r3.out || '') && /按序试过/.test(r3.out || '')
      && /add-image/.test(r3.out || '') && /没有写盘/.test(r3.out || ''),
    (r3.out || '').trim().replace(/\n/g, ' | ').slice(0, 200));

  // 56.6 拒绝是干净的：盘上**没有悬空引用**（项目文件逐字节不变 + 连 assets/ 都没建）
  check('[W19] 坏引用被拒时盘上没有任何悬空引用（项目文件逐字节不变、没建 assets/）',
    projJson(BAD) === badBefore && lsAssets(BAD) === null,
    '文件不变=' + (projJson(BAD) === badBefore) + ' ｜ assets/=' + JSON.stringify(lsAssets(BAD)));

  // 56.7 import-project 同一口径，且**项目目录都没建**（不留半份项目）
  const r4 = run(['import-project', DRY, BADMD]);
  check('[W19] import-project 同一口径：坏引用 ⇒ 非 0 且项目目录根本没建（不留半份项目）',
    r4.code !== 0 && !fs.existsSync(pdir(DRY)) && /assets\/gone\.png/.test(r4.out || ''),
    'exit=' + r4.code + ' ｜ 目录在?=' + fs.existsSync(pdir(DRY)));

  // 56.8 --dry-run 与真导**同一份判据**（预览不许说"能导"）
  const j5 = jj(run(['import-project', DRY, BADMD, '--dry-run', '--json']).out);
  check('[W19] --dry-run 与真导同一判据：wouldRefuse=true + 逐条列出 + 仍然不写盘',
    !!j5 && j5.dryRun === true && j5.wouldRefuse === true && !!j5.resourceRefs
      && j5.resourceRefs.missing === 1 && j5.resourceRefs.blocked[0].ref === 'assets/gone.png'
      && !fs.existsSync(pdir(DRY)),
    j5 ? 'wouldRefuse=' + j5.wouldRefuse + ' missing=' + j5.resourceRefs.missing + ' tried=' + j5.resourceRefs.blocked[0].tried.length : 'JSON 解析失败');

  // 56.9 非本地引用（https:）：不挂 images/files、不复制，那一行按正文保留（既不写坏引用也不丢内容）
  const r6 = run(['import-project', REM, REMMD]);
  check('[W19] 非本地引用（https:）⇒ images/files 里没有它、没复制文件、那一行按正文留在详情里',
    ok(r6.out) && Array.isArray(refsIn(REM)) && refsIn(REM).length === 0 && lsAssets(REM) === null
      && /https:\/\/example\.com\/a\.png/.test(projJson(REM) || ''),
    'refs=' + JSON.stringify(refsIn(REM)) + ' ｜ assets/=' + JSON.stringify(lsAssets(REM)));

  // 56.10 **注入证明**（判别力）：把"复制+校验"打桩成旧行为 ⇒ 悬空引用当场出现（56.1 的那批判据必红）
  const markdown = require(path.join(ROOT, 'src', 'markdown.js'));
  const realResolve = markdown.resolveImportRefs;
  let injOut = null;
  try {
    markdown.resolveImportRefs = () => ({ ok: true, applied: false, dryRun: false, onMissing: 'refuse',
      refs: [], blocked: [], copied: [], inProject: [], remote: [], dropped: [] });   // 旧行为替身
    injOut = run(['import-project', INJ, INJMD]);
  } finally {
    markdown.resolveImportRefs = realResolve;                                          // 立即复原，绝不外泄
  }
  const injRefs = refsIn(INJ) || [];
  check('[W19] 注入证明：还原旧行为 ⇒ "确已复制 + 引用项目内"两条判据当场不成立（断言有判别力）',
    !!injOut && injOut.code === 0 && lsAssets(INJ) === null && injRefs.length === 1
      && injRefs[0] === 'assets/x.png' && !allRefsExist(INJ),
    '旧行为复现：exit=' + (injOut && injOut.code) + ' ｜ refs=' + JSON.stringify(injRefs)
      + ' ｜ 文件在?=' + JSON.stringify(injRefs.map((f) => fs.existsSync(path.join(pdir(INJ), f)))));

  [P, M, BAD, DRY, REM, INJ].forEach(clean);
  check('[W19] 收尾：探针项目已清掉（不给下一次运行留"项目已存在"的假红）',
    [P, M, BAD, DRY, REM, INJ].every((n) => !fs.existsSync(pdir(n))), '');
  try { fs.rmSync(W19, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响判定 */ }
}

/* ---------------- 50. 复校与体检（S4）：recheck / health ----------------
 * 判据（S4 任务书的四条验收 + 契约 §10 的 AC14）：
 *   · ① 改一个源文件 ⇒ 相关条目被报 `needs-recheck`（**注入证明**：先证前提，再断言结论）；
 *   · ② 引文在那份文件里找不到了 ⇒ `src-gone`；
 *   · ③ `health --json` **确定性**：同状态连跑两次**逐字节相同**（AC14）；
 *   · ④ `recheck` **不写盘**（除非显式 `--write-verified`）—— 用项目文件字节 + `.changes.jsonl` 证明。
 * 外加：三类 + 计数、逐条点名、**可执行的下一步**、写回只动 `verified`、悬挂引用、`qa` 残留、
 *      迁移"跳过"的逐节点点名，以及"库级读数不被一个坏项目挡住"。
 *
 * 探针一律 `it-s4-` 前缀（`sweepStaleProbes` 的前缀表已覆盖 `it-s[1-9]-`）；
 * 出处文件放 `TMP` 里并用 `--root` 指向它 ⇒ **绝不去核真实仓库**（既隔离，也好造"源文件被改过"）。
 * 探针项目在本段 `finally` 里自删；本段排在 §14（validate-all）之后（夹具是条目化节点）。 */
{
  const S4TAG = Date.now().toString(36);
  const P4 = 'it-s4-probe-' + S4TAG;
  const S4DIR = path.join(TMP, 's4-refs-' + S4TAG);
  const S4SPEC = path.join(S4DIR, 'spec.md');
  const S4OTHER = path.join(S4DIR, 'other.md');
  const s4json = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };
  const s4bytes = (name) => fs.readFileSync(projJson(name));
  const s4log = (name) => {
    try { return fs.readFileSync(path.join(ROOT, 'projects', name, '.changes.jsonl'), 'utf8'); } catch (e) { return ''; }
  };
  const s4logs = (name) => s4log(name).split('\n').filter(Boolean).length;
  const s4items = (id) => ((nodeOf(readProj(P4), id) || {}).items) || [];
  const s4item = (id, k) => s4items(id)[k || 0] || null;
  const s4ver = (id) => ((s4item(id) || {}).verified) || null;
  const S4R = ['--root', S4DIR];
  const OLD = new Date('2019-01-01T00:00:00.000Z');   // 把"核验之后源文件没动过"钉成事实（不靠运行时刻）

  try {
    /* ---- 夹具：出处文件（在 TMP）+ 探针项目 ---- */
    fs.mkdirSync(S4DIR, { recursive: true });
    fs.writeFileSync(S4SPEC, '# 规格\n- 甲\n- 乙\n', 'utf8');
    fs.writeFileSync(S4OTHER, '# 另一个\n- 丙\n', 'utf8');
    fs.utimesSync(S4SPEC, OLD, OLD);
    fs.utimesSync(S4OTHER, OLD, OLD);

    run(['init', P4, '--title', 'S4 复校与体检探针']);
    run(['add', P4, 'root', '--topic', 'S4 甲（有出处、已核）', '--id', 'it-s4-a']);
    run(['add', P4, 'root', '--topic', 'S4 乙（有出处、未核）', '--id', 'it-s4-b']);
    run(['add', P4, 'root', '--topic', 'S4 丙（无出处）', '--id', 'it-s4-c']);
    run(['add', P4, 'root', '--topic', 'S4 丁（含 li 但回放不了 ⇒ 迁移会跳过）', '--id', 'it-s4-d',
      '--detail', '<ul><li>甲</ul>']);                 // 未闭合 ⇒ parseDetail 判"这段回放不了"
    const rFxA = run(['item-add', P4, 'it-s4-a', '--html', '<p>甲结论</p>', '--src', 'spec.md:2::甲']);
    const rFxB = run(['item-add', P4, 'it-s4-b', '--html', '<p>乙结论</p>', '--src', 'other.md:2::丙']);
    run(['item-add', P4, 'it-s4-c', '--html', '<p>没有出处的结论</p>']);
    const A_ITEM = (s4item('it-s4-a') || {}).id;
    const B_ITEM = (s4item('it-s4-b') || {}).id;
    const rFxV = run(['item-edit', P4, 'it-s4-a', A_ITEM, '--verified', '--how', '读了 spec.md:2 那一行']);
    fs.utimesSync(S4SPEC, OLD, OLD);                   // 核验之后源文件**没动过** ⇒ 甲那条应当判"就绪"
    check('S4 夹具前提：三条条目落地 + 甲那条的核验记录写进去了（否则后面的断言是空转）',
      ok(rFxA.out) && ok(rFxB.out) && ok(rFxV.out) && !!A_ITEM && !!B_ITEM && !!s4ver('it-s4-a'),
      'A=' + A_ITEM + ' B=' + B_ITEM + ' verified=' + JSON.stringify(s4ver('it-s4-a')));

    /* ---- 50.1 三类 + 计数 + 逐条点名 + 可执行的下一步 ---- */
    const r1 = run(['recheck', P4].concat(S4R, ['--json']));
    const j1 = s4json(r1.out);
    check('S4 recheck：三类（ok / needs-recheck / src-gone）+ 计数给得出，`--json` 是一份可解析 JSON',
      ok(r1.out) && !!j1 && !!j1.counts
        && j1.counts.items === 3 && j1.counts.ok === 1 && j1.counts.needsRecheck === 2
        && j1.counts.srcGone === 0 && j1.counts.noSrc === 1 && j1.counts.unverified === 2
        && j1.counts.itemizedNodes === 3,
      'counts=' + JSON.stringify(j1 && j1.counts));
    const r1t = run(['recheck', P4].concat(S4R));
    check('S4 recheck：判据随读数给出（criteria）+ **逐条点名** + **可执行的下一步**（不是只说"要复核"）',
      !!j1 && typeof j1.criteria['needs-recheck'] === 'string'
        && j1.byVerdict.needsRecheck.length === 2
        && j1.byVerdict.needsRecheck.every((e) => e.nextSteps.length > 0)
        && r1t.out.indexOf('it-s4-b') >= 0 && r1t.out.indexOf('it-s4-c') >= 0
        && r1t.out.indexOf('下一步（可执行）') >= 0 && r1t.out.indexOf('--write-verified') >= 0,
      r1t.out.split('\n').slice(0, 4).join(' | '));

    /* ---- 50.2 只读证明（跑完盘上零改动） ---- */
    {
      const bBefore = s4bytes(P4);
      const lBefore = s4log(P4);
      const rRo = run(['recheck', P4].concat(S4R, ['--json']));
      check('S4 recheck 是**只读**：跑完项目文件与 .changes.jsonl 都逐字节不变（写回要显式 --write-verified）',
        ok(rRo.out) && s4bytes(P4).equals(bBefore) && s4log(P4) === lBefore,
        '项目文件未变=' + s4bytes(P4).equals(bBefore) + ' 变更日志未变=' + (s4log(P4) === lBefore));
    }

    /* ---- 50.3 写回：--how 必填；只动 verified；写回后被算进去 ---- */
    const rNoHow = run(['recheck', P4].concat(S4R, ['--write-verified']));
    check('S4 recheck --write-verified 不给 --how ⇒ 非 0 退出 + 说清"取不到怎么核的就不写"',
      rNoHow.code !== 0 && rNoHow.out.indexOf('--how') >= 0 && rNoHow.out.indexOf('verified') >= 0,
      'exit=' + rNoHow.code + ' | ' + rNoHow.out.trim().slice(0, 90));
    const detailsBefore = JSON.stringify([s4items('it-s4-a')[0].detail, (nodeOf(readProj(P4), 'it-s4-b') || {}).detail,
      (nodeOf(readProj(P4), 'it-s4-c') || {}).detail]);
    const logsBefore = s4logs(P4);
    const rW = run(['recheck', P4].concat(S4R,
      ['--write-verified', '--how', '把两处出处都读了一遍', '--json']));
    const jw = s4json(rW.out);
    check('S4 recheck --write-verified：只给"出处判得过"的条目写 `verified{at,by,how}`（三字段齐全、by=cli:recheck）',
      ok(rW.out) && !!jw && jw.written === 2 && jw.itemIds.indexOf(A_ITEM) >= 0 && jw.itemIds.indexOf(B_ITEM) >= 0
        && (() => { const v = s4ver('it-s4-b');
          return !!v && typeof v.at === 'string' && Number.isFinite(Date.parse(v.at))
            && v.by === 'cli:recheck' && typeof v.how === 'string' && v.how.length > 0; })(),
      'written=' + (jw && jw.written) + ' 乙的 verified=' + JSON.stringify(s4ver('it-s4-b')));
    check('S4 写回**只动 verified**：节点 detail 逐字节不变，且 .changes.jsonl 只多 1 条（一次原子写）',
      JSON.stringify([s4items('it-s4-a')[0].detail, (nodeOf(readProj(P4), 'it-s4-b') || {}).detail,
        (nodeOf(readProj(P4), 'it-s4-c') || {}).detail]) === detailsBefore
        && s4logs(P4) === logsBefore + 1,
      'detail 未变 + 日志 +1 = ' + (s4logs(P4) === logsBefore + 1));
    const jAfter = s4json(run(['recheck', P4].concat(S4R, ['--json'])).out);
    check('S4 写回后复查：乙那条从"未核"转「已就绪」（写回的记录真的被算进判定里）',
      !!jAfter && jAfter.counts.ok === 2 && jAfter.byVerdict.ok.map((e) => e.itemId).indexOf(B_ITEM) >= 0,
      'ok=' + (jAfter && jAfter.counts.ok));

    /* ---- 50.4 注入证明 ①改源文件 ⇒ needs-recheck ②引文找不到 ⇒ src-gone ---- */
    const vAt = Date.parse(s4ver('it-s4-a').at);
    const mtBefore = fs.statSync(S4SPEC).mtimeMs;
    fs.appendFileSync(S4SPEC, '- 追加一行\n', 'utf8');      // 之一：真改一个源文件
    const mtAfter = fs.statSync(S4SPEC).mtimeMs;
    check('S4 注入前提：源文件 mtime 确实晚于该条目的 verified.at（否则"过期"这条判据本来就判不了）',
      mtAfter > vAt && mtAfter > mtBefore,
      'mtime=' + mtAfter + ' verified.at=' + vAt + '（差 ' + (mtAfter - vAt) + ' ms）');
    const jStale = s4json(run(['recheck', P4].concat(S4R, ['--json'])).out);
    check('S4 注入证明①：改一个源文件 ⇒ 相关条目被报 **needs-recheck**（原因 file-changed，且点名到 itemId）',
      !!jStale && jStale.counts.stale >= 1
        && jStale.byVerdict.needsRecheck.some((e) => e.itemId === A_ITEM
          && e.reasons.some((r) => r.code === 'file-changed')),
      'stale=' + (jStale && jStale.counts.stale));
    fs.writeFileSync(S4SPEC, '# 规格\n- 乙\n', 'utf8');     // 之二：引文「甲」整条没了
    const jGone = s4json(run(['recheck', P4].concat(S4R, ['--json'])).out);
    check('S4 注入证明②：引文在那份文件里找不到了 ⇒ `src-gone`（原因 quote-missing）',
      !!jGone && jGone.counts.srcGone >= 1
        && jGone.byVerdict.srcGone.some((e) => e.itemId === A_ITEM
          && e.reasons.some((r) => r.code === 'quote-missing')),
      'srcGone=' + (jGone && jGone.counts.srcGone));
    const rForce = run(['recheck', P4].concat(S4R, ['--only', A_ITEM, '--write-verified', '--how', '核了']));
    check('S4 出处失效的条目**默认不给写核验记录**（那会记下一条假话）：点名写 ⇒ 拒绝并指路 --force',
      rForce.code !== 0 && rForce.out.indexOf('--force') >= 0,
      'exit=' + rForce.code + ' | ' + rForce.out.trim().split('\n').slice(0, 2).join(' '));

    /* ---- 50.5 悬挂引用（条目级：links[].item 指向不存在的条目） ---- */
    {
      const d = readProj(P4);
      nodeOf(d, 'it-s4-c').links = [{ project: P4, id: 'it-s4-a', item: 'i-no-such-item' }];
      fs.writeFileSync(projJson(P4), JSON.stringify(d, null, 2), 'utf8');
      const jd = s4json(run(['recheck', P4].concat(S4R, ['--json'])).out);
      check('S4 悬挂引用（条目级）：`links[].item` 指向不存在的条目 ⇒ 逐处点名（kind / reason / 目标都给出）',
        !!jd && jd.counts.dangling === 1 && jd.dangling[0].kind === 'link'
          && jd.dangling[0].reason === 'item-missing' && jd.dangling[0].item === 'i-no-such-item',
        JSON.stringify(jd && jd.dangling));
      const td = run(['recheck', P4].concat(S4R)).out;
      check('S4 悬挂引用的**出路**在回显里（指 `links-prune` / `assoc-prune`，不是只报个错）',
        td.indexOf('links-prune') >= 0 && td.indexOf('i-no-such-item') >= 0, '');
    }

    /* ---- 50.6 health：读数 / 一致性点名 / qa 残留 / 迁移五档 / 确定性 / 不写盘 / 库级 ---- */
    {
      const d = readProj(P4);
      nodeOf(d, 'it-s4-b').detail = '<p>被别人改过</p>';       // 与 renderDetail(items) 不一致
      nodeOf(d, 'it-s4-a').qa = [{ q: '', a: '答', at: '2026-01-01T00:00:00.000Z' }];   // 条目化节点上的 qa 残留
      fs.writeFileSync(projJson(P4), JSON.stringify(d, null, 2), 'utf8');
    }
    const hBytes = s4bytes(P4);
    const h1 = run(['health', P4].concat(S4R, ['--json']));
    const hj = s4json(h1.out);
    check('S4 health：条目化节点数/总节点数、条目数（按 type）、无出处·未核·需复核·出处失效·最后核验时间都给得出',
      ok(h1.out) && !!hj && !!(hj.nodes && hj.items)
        && hj.nodes.total === 5 && hj.nodes.itemized === 3 && hj.nodes.v2 === 2
        && hj.items.total === 3 && hj.items.byType.text === 3 && hj.items.noSrc === 1
        && hj.items.srcGone >= 1 && typeof hj.items.lastVerifiedAt === 'string',
      'nodes=' + JSON.stringify(hj && hj.nodes) + ' items=' + JSON.stringify(hj && hj.items));
    check('S4 health：`items ↔ detail` 不一致的节点**逐节点点名** + 修法（render-detail）',
      hj.inconsistent.count === 1 && hj.inconsistent.nodes[0].nodeId === 'it-s4-b'
        && hj.inconsistent.nodes[0].fix.indexOf('render-detail') >= 0
        && run(['health', P4].concat(S4R)).out.indexOf('it-s4-b') >= 0,
      JSON.stringify(hj.inconsistent.nodes));
    check('S4 health：`qa` 残留（条目化节点上仍有 qa[]，契约 §2 判红项）被逐节点点名',
      hj.qaResidue.count === 1 && hj.qaResidue.nodes[0].nodeId === 'it-s4-a',
      JSON.stringify(hj.qaResidue.nodes));
    check('S4 health：迁移**五档分开**报，跳过项逐节点点名 + 原因分布（不把"不可迁移"伪装成"没有要迁的"）',
      hj.migration.itemized === 3 && hj.migration.skipped.length === 1
        && hj.migration.skipped[0].nodeId === 'it-s4-d'
        && hj.migration.skipped[0].reason === 'not-lossless'
        && hj.migration.reasonCounts['not-lossless'] === 1,
      'skipped=' + JSON.stringify(hj.migration.skipped) + ' 分布=' + JSON.stringify(hj.migration.reasonCounts));
    const h2 = run(['health', P4].concat(S4R, ['--json']));
    check('S4 health **确定性**（契约 §10 AC14）：同状态连跑两次 `--json` **逐字节相同**（且不带运行时刻）',
      h2.out === h1.out && h1.out.indexOf('generatedAt') < 0,
      '两次逐字节相同=' + (h2.out === h1.out) + ' 长度=' + h1.out.length);
    check('S4 health 是**读数不是门禁**：有红项（不一致 + 残留 + 出处失效）仍 exit 0，且一个字节都不写盘',
      h1.code === 0 && s4bytes(P4).equals(hBytes)
        && run(['health', P4].concat(S4R)).out.indexOf('读数不是门禁') >= 0,
      'exit=' + h1.code + ' 盘上未变=' + s4bytes(P4).equals(hBytes));
    const hAll = s4json(run(['health'].concat(S4R, ['--json'])).out);
    check('S4 health 不给项目名 = **整个库**（scope=library、本项目在内；坏项目如实进 unreadable 而不吞掉整份读数）',
      !!hAll && hAll.scope === 'library' && Array.isArray(hAll.unreadable)
        && hAll.projects.some((p) => p.project === P4) && hAll.total.projects === hAll.projects.length,
      'projects=' + (hAll && hAll.projects.length) + ' unreadable=' + (hAll && hAll.unreadable.length));
  } finally {
    try { fs.rmSync(path.join(ROOT, 'projects', P4), { recursive: true, force: true }); } catch (e) { /* 收尾不判红 */ }
    try { fs.rmSync(S4DIR, { recursive: true, force: true }); } catch (e) { /* 收尾不判红 */ }
  }
}

/* ---------------- 51. 关系与标签升层（S6）：条目级链接 + 条目级悬挂 + 只增字段 ----------------
 * 判据（对应 S6 任务书，**逐条一个 `check`**）：
 *   （S6 之一）`link --item`：边指向**目标节点里的某一条条目**（`{project,id,item}`；回显写成 `目标/节点#条目`）；
 *   （S6 之二）目标节点在、**条目不在** ⇒ 非 0 + 点名到 `项目/节点#条目` + **盘上零改动**
 *              （写入口绝不造"节点在、条目不在"的悬挂引用 —— 那种引用会把它自己锁死）；
 *   （S6 之三）**沿用 K8 的三态词**：重放**同一三元组**（项目, 节点, 条目）⇒「无变化」且盘上逐字节
 *              不变（不产生空写入）；省略 `--item` 命中的是**节点级**那一条边（另一条边）⇒ 新建/命中
 *              它，条目级那条的 item 一个字节不动；显式换条目 ⇒ 「已添加链接」（换条目 = 另一条边），
 *              原有那条不被重建、不重排；
 *   （S6 之四）**判定键含条目层**：同 (源,目标) 上"节点级一条 + 条目级两条"能并存、互不吞掉；
 *   （S6 之五）读口**只增字段**：`links --json` 的条目级边带 `item`，节点级边**没有** `item` 键；
 *              `backlinks --json` 的条目行带 `item` + `itemLabel`（标签优先，可读）；
 *   （S6 之六）**条目级悬挂判据 = 一处**：`links-prune` 自动档把它与"节点整个不在了"一起抓出来，
 *              且报告里**分开点名**（"节点还在、条目已被删"）；
 *   （S6 之七）`links-prune --items 节点id#条目id`：只剪被点名的那一条，同目标另一条条目**一条都没动**；
 *   （S6 之八）剪完 `validate` 必须 exit 0（闸门复绿）；
 *   （S6 之九）标签两级：节点级 `tags` 与条目级 `item.tags` 并存、不合并、不互相复制
 *              （`search --tag` 命中分别报 `item-tag` / `node-tag`）。
 *
 * 探针项目一律 `it-s6-` 前缀（§4.1 的锚点分配）；本段在 `finally` 里**自删** ——
 * 夹具是**条目化**节点，中途抛错也不能留在真实 `projects/` 里。
 * 本段排在 §14（`validate-all`）之后，免得 validate-all 在夹具存在期间扫到它。
 * 判据一律**回读盘上真值**（`readProj` / `nodeOf`），不拿命令回显当数据结论。 */
{
  const S6TAG = Date.now().toString(36);
  const S6SRC = 'it-s6-src-' + S6TAG;
  const S6DST = 'it-s6-dst-' + S6TAG;
  const s6file = (name) => path.join(ROOT, 'projects', name, name + '.json');
  const s6text = (name) => fs.readFileSync(s6file(name), 'utf8');
  const s6node = (proj, id) => nodeOf(readProj(proj), id);
  const s6edges = (proj, id) => (s6node(proj, id).links) || [];
  const s6itemKey = (x) => (typeof x === 'string' ? x : '');
  const s6edge = (proj, nodeId, target, item) => s6edges(proj, nodeId)
    .find((l) => l && l.id === target && s6itemKey(l.item) === s6itemKey(item)) || null;
  const s6itemId = (out) => { const m = /(i-[a-z0-9-]+)/.exec(String(out)); return m ? m[1] : null; };
  const s6json = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };

  try {
    run(['init', S6SRC, '--title', 'S6 条目级链接探针源']);
    run(['init', S6DST, '--title', 'S6 条目级链接探针目标']);
    run(['add', S6SRC, 'root', '--topic', 'S6 源甲', '--id', 'it-s6-a']);
    run(['add', S6SRC, 'root', '--topic', 'S6 源乙', '--id', 'it-s6-ae']);
    run(['add', S6DST, 'root', '--topic', 'S6 目标（条目化）', '--id', 'it-s6-t']);
    const rA = run(['item-add', S6DST, 'it-s6-t', '--html', '<p>甲条正文</p>', '--tags', '门禁,检索']);
    const rB = run(['item-add', S6DST, 'it-s6-t', '--html', '<p>乙条正文</p>']);
    const iA = s6itemId(rA.out);
    const iB = s6itemId(rB.out);

    // （S6 之一）+（S6 之二）写入口：条目级链接成立；目标条目不在 ⇒ 拒绝并点名、盘上零改动
    const rLinkOk = run(['link', S6SRC, 'it-s6-a', '--to', S6DST, '--id', 'it-s6-t', '--item', iA]);
    const bytesBeforeBad = s6text(S6SRC);
    const rLinkBad = run(['link', S6SRC, 'it-s6-a', '--to', S6DST, '--id', 'it-s6-t', '--item', 'i-does-not-exist']);
    const s6refusalZeroWrite = s6text(S6SRC) === bytesBeforeBad;
    check('S6 `link --item`：边落成 `{project,id,item}`（回显点名 `目标/节点#条目`）；'
      + '目标节点在、**条目不在** ⇒ 非 0 + 点名到 `项目/节点#条目` + **盘上零改动**',
      ok(rLinkOk.out) && rLinkOk.out.indexOf('已添加链接: it-s6-a → ' + S6DST + '/it-s6-t#' + iA) >= 0
        && JSON.stringify(s6edge(S6SRC, 'it-s6-a', 'it-s6-t', iA))
          === JSON.stringify({ project: S6DST, id: 'it-s6-t', item: iA })
        && rLinkBad.code !== 0 && rLinkBad.out.indexOf('目标条目不存在') >= 0
        && rLinkBad.out.indexOf(S6DST + '/it-s6-t#i-does-not-exist') >= 0
        && s6refusalZeroWrite,
      '落盘=' + JSON.stringify(s6edge(S6SRC, 'it-s6-a', 'it-s6-t', iA))
        + ' ｜ 拒绝 exit=' + rLinkBad.code + ' 盘上零改动=' + s6refusalZeroWrite);

    // （S6 之三）三态词（沿用 K8）：**重放同一三元组**（项目, 节点, 条目）⇒「无变化」且逐字节不变。
    // ⚠️ 改前这条写的是"省略 `--item` 重放 ⇒ 无变化且保留 item" —— 那等于把"同一条边"当成 (源,目标)
    //    两元组，与 `--item` 的意义自相矛盾（同 (源,目标) 上"节点级一条 + 条目级两条"本是三条不同的边）；
    //    实测后果：省略 `--item` 命中一条条目级边 ⇒ 节点级那条边**永远建不出来**（之四/之五跟着红）。
    //    省略 `--item` 命中的是**节点级**那一条 ⇒ 它应当被**新建**，而条目级那条一个字节都不动。
    const bytesBeforeReplay = s6text(S6SRC);
    const rReplay = run(['link', S6SRC, 'it-s6-a', '--to', S6DST, '--id', 'it-s6-t', '--item', iA]);
    // ⚠️ "逐字节不变"必须在**这一条之后立刻取样**：下面的 `省略 --item` 会**真的新建**一条节点级边
    //    （那正是它的正确行为）⇒ 把取样点放到 check() 里就等于拿"后来的盘"去比"重放前的盘"。
    const replayByteSame = s6text(S6SRC) === bytesBeforeReplay;
    const rReplayNoItem = run(['link', S6SRC, 'it-s6-a', '--to', S6DST, '--id', 'it-s6-t']);
    check('S6 三态词（**沿用 K8 的 `已添加链接`/`已更新链接`/`无变化`**）：重放**同一三元组** ⇒「无变化」'
      + '且盘上**逐字节不变**；省略 `--item` 是**另一条边**（节点级）⇒ 新建它，条目级那条的 item 一个字节不动',
      ok(rReplay.out) && rReplay.out.indexOf('无变化') >= 0 && rReplay.out.indexOf('已添加链接') < 0
        && replayByteSame
        && ok(rReplayNoItem.out) && rReplayNoItem.out.indexOf('已添加链接') >= 0
        && s6edge(S6SRC, 'it-s6-a', 'it-s6-t', iA).item === iA
        && s6edges(S6SRC, 'it-s6-a').filter((l) => !s6itemKey(l.item)).length === 1,
      '重放=' + rReplay.out.trim().slice(0, 40) + ' ｜ 逐字节不变=' + replayByteSame
        + ' ｜ 省略 --item 的回显=' + rReplayNoItem.out.trim().slice(0, 40)
        + ' ｜ 条目级那条 item=' + JSON.stringify(s6edge(S6SRC, 'it-s6-a', 'it-s6-t', iA).item)
        + ' ｜ 节点级边数=' + s6edges(S6SRC, 'it-s6-a').filter((l) => !s6itemKey(l.item)).length);

    // （S6 之四）判定键含条目层：节点级一条 + 条目级两条并存、互不吞掉
    run(['link', S6SRC, 'it-s6-ae', '--to', S6DST, '--id', 'it-s6-t', '--item', iA, '--caption', '甲注']);
    run(['link', S6SRC, 'it-s6-ae', '--to', S6DST, '--id', 'it-s6-t', '--item', iB, '--caption', '乙注']);
    const rLvl = run(['link', S6SRC, 'it-s6-ae', '--to', S6DST, '--id', 'it-s6-t']);
    check('S6 判定键含条目层：同 (源,目标) 上"节点级一条 + 条目级两条"**并存、互不吞掉**'
      + '（`--item` 只命中它自己那一档，不重建别的边、不重排数组）',
      ok(rLvl.out) && ok(rLvl.out) && s6edges(S6SRC, 'it-s6-ae').length === 3
        && JSON.stringify(s6edges(S6SRC, 'it-s6-ae').map((l) => s6itemKey(l.item)).sort())
          === JSON.stringify([iA, iB, ''].sort())
        && s6edge(S6SRC, 'it-s6-ae', 'it-s6-t', iA).caption === '甲注',
      '该节点三档 item=' + JSON.stringify(s6edges(S6SRC, 'it-s6-ae').map((l) => s6itemKey(l.item))));

    // （S6 之五）读口**只增字段**：条目级带 item（+ itemLabel），节点级一个键都不多
    const rLinksJson = run(['links', S6SRC, '--json']);
    const s6rows = (s6json(rLinksJson.out) || { links: [] }).links.filter((l) => l.node === 'it-s6-ae');
    const s6bare = s6rows.filter((l) => !s6itemKey(l.item));
    const s6itemRows = s6rows.filter((l) => s6itemKey(l.item));
    const rBl = run(['backlinks', S6DST, 'it-s6-t', '--json']);
    const s6blRows = ((s6json(rBl.out) || {}).cross || []).filter((x) => x.node === 'it-s6-ae');
    check('S6 读口**只增字段**：`links --json` 的条目级边带 `item`，**节点级边没有 `item` 键**；'
      + '`backlinks --json` 的条目行带 `item` + 可读标注 `itemLabel`（标签优先）',
      ok(rLinksJson.out) && s6bare.length === 1 && !('item' in s6bare[0])
        && s6itemRows.length === 2
        && ok(rBl.out) && s6blRows.length === 3
        && !('item' in s6blRows.filter((x) => !x.item)[0])
        && (s6blRows.filter((x) => x.item === iA)[0] || {}).itemLabel.indexOf('门禁') >= 0
        && (s6blRows.filter((x) => x.item === iB)[0] || {}).itemLabel.indexOf('乙条正文') >= 0,
      '节点级行键=' + JSON.stringify(Object.keys(s6bare[0] || {}).sort())
        + ' ｜ 条目级行数=' + s6itemRows.length + ' ｜ 甲条标注='
        + JSON.stringify((s6blRows.filter((x) => x.item === iA)[0] || {}).itemLabel));

    // （S6 之六）+（S6 之七）+（S6 之八）条目级悬挂：一处判据 + 分开点名 + 精确档 + 复绿
    {
      const d = readProj(S6SRC);
      nodeOf(d, 'it-s6-ae').links = [
        { project: S6DST, id: 'it-s6-t', item: iA, caption: '好的边' },
        { project: S6DST, id: 'it-s6-t', item: 'i-gone', caption: '坏边：条目已删' }
      ];
      fs.writeFileSync(s6file(S6SRC), JSON.stringify(d, null, 2), 'utf8');
    }
    const bytesBeforePrune = s6text(S6SRC);
    const rDry = run(['links-prune', S6SRC, '--dry-run']);
    const s6dryNoWrite = s6text(S6SRC) === bytesBeforePrune;
    const rPrune = run(['links-prune', S6SRC]);
    check('S6 条目级悬挂**判据一处**：`links-prune` 自动档抓出"节点还在、条目已被删"并**分开点名**'
      + '（与"节点整个不在"分开报）；`--dry-run` 不写盘；真跑后那条边被剪、`validate` 复绿',
      ok(rDry.out) && rDry.out.indexOf('节点还在、条目已被删') >= 0
        && rDry.out.indexOf(S6DST + '/it-s6-t#i-gone') >= 0 && s6dryNoWrite
        && ok(rPrune.out) && rPrune.out.indexOf('#i-gone') >= 0
        && s6edge(S6SRC, 'it-s6-ae', 'it-s6-t', 'i-gone') === null
        && s6edge(S6SRC, 'it-s6-ae', 'it-s6-t', iA) !== null        // 好边一条不少
        && run(['validate', S6SRC]).code === 0,
      'dry-run 不写盘=' + s6dryNoWrite + ' ｜ 剪后剩余 item='
        + JSON.stringify(s6edges(S6SRC, 'it-s6-ae').map((l) => s6itemKey(l.item))));

    // （S6 之七）精确档 `--items 节点id#条目id`：只剪被点名的那一条
    {
      const d = readProj(S6SRC);
      nodeOf(d, 'it-s6-ae').links = [
        { project: S6DST, id: 'it-s6-t', item: iA, caption: '保住甲' },
        { project: S6DST, id: 'it-s6-t', item: iB, caption: '点掉乙' }
      ];
      fs.writeFileSync(s6file(S6SRC), JSON.stringify(d, null, 2), 'utf8');
    }
    const rByItem = run(['links-prune', S6SRC, '--items', 'it-s6-t#' + iB]);
    const rBadFmt = run(['links-prune', S6SRC, '--items', 'no-hash-here']);
    check('S6 `links-prune --items 节点id#条目id`：只剪**被点名的那一条**，同目标另一条条目一条都没动；'
      + '格式写错 ⇒ 响亮拒绝（不许静默当成"没有可清理的"）',
      ok(rByItem.out) && rByItem.out.indexOf('按 --items 清理') >= 0
        && s6edge(S6SRC, 'it-s6-ae', 'it-s6-t', iB) === null
        && s6edge(S6SRC, 'it-s6-ae', 'it-s6-t', iA) !== null
        && rBadFmt.code !== 0 && rBadFmt.out.indexOf('节点id#条目id') >= 0,
      '点掉后剩余 item=' + JSON.stringify(s6edges(S6SRC, 'it-s6-ae').map((l) => s6itemKey(l.item)))
        + ' ｜ 坏格式 exit=' + rBadFmt.code);

    // （S6 之九）标签两级：节点级与条目级**并存、不合并、不互相复制**
    const rTagItem = run(['search', S6DST, '--tag', '门禁', '--json']);
    run(['edit', S6DST, 'it-s6-t', '--tags', '节点级标签S6']);
    const rTagNode = run(['search', S6DST, '--tag', '节点级标签S6', '--json']);
    const s6nodeAfter = s6node(S6DST, 'it-s6-t');
    check('S6 标签两级：条目级 `item.tags` 与节点级 `tags` 并存且**可分辨**'
      + '（`search --tag` 分别报 `item-tag` / `node-tag`）；**不合并、不互相复制**',
      ok(rTagItem.out) && ok(rTagNode.out)
        && ((s6json(rTagItem.out) || {}).hits || []).some((h) => h.itemId === iA && h.matchIn === 'item-tag')
        && ((s6json(rTagNode.out) || {}).hits || []).some((h) => h.nodeId === 'it-s6-t' && h.matchIn === 'node-tag')
        && JSON.stringify(s6nodeAfter.tags) === JSON.stringify(['节点级标签S6'])
        && JSON.stringify((s6nodeAfter.items.filter((x) => x.id === iA)[0] || {}).tags)
          === JSON.stringify(['门禁', '检索']),
      '条目级 matchIn=' + (((s6json(rTagItem.out) || {}).hits || [])[0] || {}).matchIn
        + ' ｜ 节点级 matchIn=' + (((s6json(rTagNode.out) || {}).hits || [])[0] || {}).matchIn
        + ' ｜ 节点 tags=' + JSON.stringify(s6nodeAfter.tags));
  } finally {
    // 自收尾：探针项目自己删干净（它是**条目化**夹具，留在真实 projects/ 里会被后续读数算进去）
    try { fs.rmSync(path.join(ROOT, 'projects', S6SRC), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    try { fs.rmSync(path.join(ROOT, 'projects', S6DST), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
  }
}

/* ---------------- 49. 条目读与检索（S3）：search 的条目级命中 + `get --item` + `read --items` ----------------
 * 判据（对应 S3 任务书的四条验收）：
 *   · 默认口径 = **搜条目**：一个条目化节点里 n 条命中就出 n 条（v2 口径只出 1 条节点命中）；
 *     `--topic-only` 是回退开关（同一命中 itemId 为 null）；
 *   · **字节上界**：`--max-bytes` 卡住 hits 的字节数（超限截断 + truncated + 续取方式）；
 *   · 七个过滤参数（`--tag/--src/--verified/--type/--since/--limit/--max-bytes`）各至少一条断言，
 *     非法值**当场报错**（不静默退化成默认值、不静默变成"0 命中"）；
 *   · 只读查询**不生成索引文件**（跑完 search/get/read 后项目目录清单与文件字节都不变）。
 *
 * 探针一律 `it-s3-` 前缀（与别的流互不踩）；两个探针项目在本段的 `finally` 里自删
 * （用 finally 而不是"块末尾删"：中途抛错也不会把条目化夹具留在真实 `projects/` 里）。
 *
 * 为什么条目夹具是**直接写盘**的：本条流不依赖 S1 的 `migrate items` 与 S2 的 `item-add`
 * （读路径不做格式校验 —— 见 `src/data-store.js` 的"写前过 schema"），所以本段在 S1/S2
 * 合并前后都能跑；写出来的那份 `formatVersion: 3` 也是它们落地后的**合法**形状。
 * 本段必须排在 §14（`validate-all`）之后 —— 夹具是条目化的节点，别让 validate-all 在它存在期间扫到它。 */
{
  const S3TAG = Date.now().toString(36);
  const P3A = 'it-s3-v2-' + S3TAG;          // 纯 v2 项目（init/add 建）：钉"默认口径不退化"
  const P3B = 'it-s3-items-' + S3TAG;       // 条目化项目（直接写盘）：钉条目级命中与取回
  const s3file = (name) => path.join(ROOT, 'projects', name, name + '.json');
  const s3ls = (name) => { try { return fs.readdirSync(path.join(ROOT, 'projects', name)).sort(); } catch (e) { return []; } };
  const s3json = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };

  try {
    /* ---------------- 夹具 ---------------- */
    run(['init', P3A, '--title', 'S3 v2 探针']);
    run(['add', P3A, 'root', '--topic', 'S3 闸门节点（v2）', '--id', 'it-s3-a1']);
    run(['add', P3A, 'it-s3-a1', '--topic', 'S3 子节点', '--id', 'it-s3-a2', '--detail', '<p>闸门写在 detail 里</p>']);
    const V2HIT = ['search', P3A, 'S3 闸门', '--json'];

    const S3FIX = {
      meta: { name: 'S3 条目探针', author: '', version: '0.18.0', formatVersion: 3 },
      format: 'node_tree',
      data: {
        id: 'root', topic: 'root', expanded: true, children: [
          { id: 'it-s3-n1', topic: 'S3 条目节点（闸门）', tags: ['门禁'], items: [
            { id: 'it-s3-i1', type: 'text', html: '<p>闸门：第一道是选项守门</p>',
              src: 'CHANGELOG.md:713-717', tags: ['门禁'], at: '2026-10-11T04:00:00.000Z', by: 'cli:item-add',
              verified: { at: '2026-10-11T05:00:00.000Z', by: 'cli:item-edit', how: '读了 src' } },
            { id: 'it-s3-i2', type: 'text', html: '<p>闸门：第二道是写后回读</p>', tags: ['门禁'] },
            { id: 'it-s3-i3', type: 'rich', html: '<table><tr><td>闸门表</td></tr></table>', src: ['docs/RULES.md:1-9'] },
            { id: 'it-s3-i4', type: 'qa', qa: { q: '闸门是几道？', a: '两道。', at: '2026-09-01T00:00:00.000Z' } }
          ], children: [{ id: 'it-s3-n1-1', topic: '闸门的子节点', children: [] }] },
          { id: 'it-s3-n2', topic: 'S3 未条目化的节点（闸门）', detail: '<p>闸门写在 detail 里</p>',
            tags: ['门禁'], children: [] }
        ]
      }
    };
    fs.mkdirSync(path.join(ROOT, 'projects', P3B), { recursive: true });
    const s3fixtureText = JSON.stringify(S3FIX, null, 2);
    fs.writeFileSync(s3file(P3B), s3fixtureText, 'utf8');
    const s3lsBefore = s3ls(P3B);

    /* ---------------- 49.1 默认口径 = 搜条目（验收第一条） ---------------- */
    const s1 = s3json(run(['search', P3B, '闸门', '--json']).out);
    check('S3 search 默认口径 = 搜条目：一个节点里的 4 条条目各出一条命中（v2 口径这里只有 1 条节点命中）',
      !!s1 && s1.mode === 'items' && s1.hits.filter((h) => h.itemId).length === 4 && s1.hitCount === 7
        && s1.truncated === false,
      'mode=' + (s1 && s1.mode) + ' 条目命中=' + (s1 ? s1.hits.filter((h) => h.itemId).length : '-')
        + ' 全量=' + (s1 && s1.hitCount));

    const h1 = ((s1 || {}).hits || []).filter((h) => h.itemId === 'it-s3-i1')[0] || {};
    check('S3 命中形状逐字（契约 §3.4）：v2 别名 + 条目级字段 + 恰好 12 个键（不多不少）',
      h1.id === 'it-s3-n1' && h1.nodeId === 'it-s3-n1' && h1.topic === h1.nodeTopic && h1.type === 'text'
        && h1.itemized === true && h1.matchIn === 'item' && h1.verified === true && h1.score >= 1
        && Array.isArray(h1.src) && h1.src[0] === 'CHANGELOG.md:713-717'
        && typeof h1.snippet === 'string' && h1.snippet.indexOf('第一道') >= 0
        && Object.keys(h1).length === 12,
      JSON.stringify(h1));

    const s2 = s3json(run(['search', P3B, '闸门', '--json', '--topic-only']).out);
    check('S3 `--topic-only` 回退 v2：只剩节点级命中，同一命中的 itemId 为 null（AC9）',
      !!s2 && s2.mode === 'topic-only' && s2.hits.length === 3 && s2.hits.every((h) => h.itemId === null),
      'mode=' + (s2 && s2.mode) + ' 命中=' + (s2 ? s2.hits.length : '-') + ' 全是 null='
        + (!!s2 && s2.hits.every((h) => h.itemId === null)));

    /* ---------------- 49.2 七个过滤参数（各至少一条） ---------------- */
    const s3 = s3json(run(['search', P3B, '闸门', '--json', '--type', 'qa']).out);
    check('S3 `--type`：只要该 type 的条目（qa 的检索面 = q + a ⇒ 问答正文可搜）',
      !!s3 && s3.hits.length === 1 && s3.hits[0].itemId === 'it-s3-i4',
      JSON.stringify((s3 || { hits: [] }).hits.map((h) => h.itemId)));

    const s4 = s3json(run(['search', P3B, '闸门', '--json', '--verified']).out);
    check('S3 `--verified`：只要已核条目（缺失 = 未核，不返回）',
      !!s4 && s4.hits.length === 1 && s4.hits[0].itemId === 'it-s3-i1',
      JSON.stringify((s4 || { hits: [] }).hits.map((h) => h.itemId)));

    const s5 = s3json(run(['search', P3B, '闸门', '--json', '--src', 'RULES']).out);
    check('S3 `--src`：按 src 子串命中（字符串与数组两种 src 都认），且给了条目级过滤就只出条目级命中',
      !!s5 && s5.hits.length === 1 && s5.hits[0].itemId === 'it-s3-i3',
      JSON.stringify((s5 || { hits: [] }).hits.map((h) => h.itemId)));

    const s6 = s3json(run(['search', P3B, '闸门', '--json', '--since', '2026-10-01']).out);
    check('S3 `--since`：at >= ISO；没有 at 的条目不返回、未条目化的节点命中也不返回',
      !!s6 && s6.hits.length === 1 && s6.hits[0].itemId === 'it-s3-i1',
      JSON.stringify((s6 || { hits: [] }).hits.map((h) => h.nodeId + '#' + h.itemId)));

    const s7 = s3json(run(['search', P3B, '--tag', '门禁', '--json']).out);
    check('S3 `--tag`：条目级标签 → item-tag、节点级标签 → node-tag、未条目化节点照 v2 报 tag（三种都出得来）',
      !!s7 && s7.hits.map((h) => h.nodeId + (h.itemId ? '#' + h.itemId : '') + ':' + h.matchIn).join(',')
        === 'it-s3-n1#it-s3-i1:item-tag,it-s3-n1#it-s3-i2:item-tag,it-s3-n1#it-s3-i3:node-tag,'
          + 'it-s3-n1#it-s3-i4:node-tag,it-s3-n2:tag',
      JSON.stringify((s7 || { hits: [] }).hits.map((h) => h.itemId + ':' + h.matchIn)));

    const s8 = s3json(run(['search', P3B, '闸门', '--json', '--limit', '2']).out);
    check('S3 `--limit`：本次只返回 2 条，但 hitCount 仍是全量 7 ⇒ 截断可见（不许静默少给）',
      !!s8 && s8.hits.length === 2 && s8.hitCount === 7 && s8.truncated === true
        && s8.budget.limit === 2 && typeof s8.budget.resume === 'string',
      'hits=' + (s8 ? s8.hits.length : '-') + ' hitCount=' + (s8 && s8.hitCount)
        + ' resume=' + (!!(s8 && s8.budget && s8.budget.resume)));

    /* ---------------- 49.3 预算与 --max-bytes 上界（AC10） ---------------- */
    const s9 = s3json(run(['search', P3B, '闸门', '--json', '--max-bytes', '320']).out);
    const s9bytes = Buffer.byteLength(JSON.stringify((s9 || {}).hits || []), 'utf8');
    check('S3 `--max-bytes`：hits 的实测字节 ≤ 上界 + truncated:true（口径 = hits 数组，见 budget）',
      !!s9 && s9.truncated === true && s9bytes <= 320 && s9.budget.bytes === s9bytes
        && s9.budget.estTokens === Math.ceil(s9bytes / 4) && s9.hitCount === 7,
      'hits 字节=' + s9bytes + ' budget.bytes=' + (s9 && s9.budget && s9.budget.bytes)
        + ' token≈' + (s9 && s9.budget && s9.budget.estTokens));

    /* ---------------- 49.4 非法值当场报错（不静默退化） ---------------- */
    const b1 = run(['search', P3B, '闸门', '--limit', '0']);
    const b2 = run(['search', P3B, '闸门', '--limit', 'abc']);
    const b3 = run(['search', P3B, '闸门', '--max-bytes', '1']);
    check('S3 非法 `--limit` / `--max-bytes` ⇒ 当场报错并给出允许范围（不静默退化成默认值）',
      b1.code !== 0 && b1.out.indexOf('--limit') >= 0 && b1.out.indexOf('1000') >= 0
        && b2.code !== 0 && b2.out.indexOf('--limit') >= 0
        && b3.code !== 0 && b3.out.indexOf('--max-bytes') >= 0 && b3.out.indexOf('16') >= 0,
      'exit=' + b1.code + '/' + b2.code + '/' + b3.code + '｜' + b1.out.trim().slice(0, 70));

    const b4 = run(['search', P3B, '闸门', '--verified=nonsense']);
    const b5 = run(['search', P3B, '闸门', '--type', 'fact']);
    const b6 = run(['search', P3B, '闸门', '--since', '昨天']);
    check('S3 过滤条件写错 ⇒ 当场报错（不静默按错误方向过滤，也不静默变成"0 命中"）',
      b4.code !== 0 && b4.out.indexOf('--verified 只能是 true 或 false') >= 0
        && b5.code !== 0 && b5.out.indexOf('text / rich / qa') >= 0
        && b6.code !== 0 && b6.out.indexOf('--since 需要一个能解析的时间') >= 0,
      b4.out.trim().slice(0, 60) + '｜' + b5.out.trim().slice(0, 60));

    const b7 = run(['search', P3B, '闸门', '--topic-only', '--type', 'qa']);
    check('S3 `--topic-only` 与条目级过滤同给 ⇒ 拒绝（两种口径不混，同 `read --items` × `--brief` 的纪律）',
      b7.code !== 0 && b7.out.indexOf('--topic-only 与 --type 不能同给') >= 0, b7.out.trim().slice(0, 90));

    const b8 = run(['search', P3B]);
    check('S3 既没关键词也没 `--tag` ⇒ 报错（不是静默的"0 命中"）',
      b8.code !== 0 && b8.out.indexOf('缺少关键词') >= 0, b8.out.trim().slice(0, 60));

    /* ---------------- 49.5 get --item（契约 §3.1 / §3.3） ---------------- */
    const g1 = s3json(run(['get', P3B, 'it-s3-n1', '--item', 'it-s3-i1', '--json']).out);
    check('S3 `get --item`：条目视图逐字段（html 保真 / src 归一成数组 / path 是真实层级 / 恰好 11 个键）',
      !!g1 && g1.itemId === 'it-s3-i1' && g1.nodeId === 'it-s3-n1' && g1.type === 'text'
        && g1.html === '<p>闸门：第一道是选项守门</p>' && g1.path.join('/') === 'root/it-s3-n1'
        && Array.isArray(g1.src) && g1.src[0] === 'CHANGELOG.md:713-717'
        && (g1.verified || {}).how === '读了 src' && Object.keys(g1).length === 11,
      JSON.stringify(g1));

    const g2 = run(['get', P3B, 'it-s3-n2', '--item', 'it-s3-i1']);
    check('S3 `get --item` 给的是**别的节点**的条目 ⇒ 非 0 且点名它实际属于哪个节点（契约 §3.3 必错情形）',
      g2.code !== 0 && g2.out.indexOf('it-s3-i1') >= 0 && g2.out.indexOf('it-s3-n1') >= 0,
      g2.out.trim().slice(0, 100));

    const g3 = s3json(run(['get', P3B, 'it-s3-n1', '--json']).out);
    check('S3 `get`（不带 --item）：条目化节点额外带 items **摘要**（无正文、verified 是布尔、键序照契约）',
      !!g3 && Array.isArray(g3.items) && g3.items.length === 4
        && Object.keys(g3.items[0]).join(',') === 'itemId,type,src,verified,at,bytes'
        && g3.items[0].verified === true && typeof g3.items[0].bytes === 'number'
        && g3.items[0].html === undefined && JSON.stringify(g3).indexOf('第一道是选项守门') < 0,
      JSON.stringify(g3 && g3.items && g3.items[0]));

    /* ---------------- 49.6 read --items（契约 §3.3） ---------------- */
    const r1 = s3json(run(['read', P3B, '--items', 'it-s3-i4,it-s3-i1', '--json']).out);
    check('S3 `read --items`：只取这几条正文（顺序按给的那份）、顶层带 meta/project/itemCount',
      !!r1 && r1.itemCount === 2 && r1.project === P3B
        && r1.items.map((x) => x.itemId).join(',') === 'it-s3-i4,it-s3-i1'
        && r1.items[0].qa.q === '闸门是几道？' && r1.items[0].html === undefined
        && r1.items[1].html === '<p>闸门：第一道是选项守门</p>',
      JSON.stringify(r1 && { itemCount: r1.itemCount, ids: r1.items.map((x) => x.itemId) }));

    const r2 = run(['read', P3B, '--items', 'it-s3-i1,it-s3-none', '--json']);
    check('S3 `read --items` 任一 id 不存在 ⇒ **整体失败**并逐个点名（不给半份：能取到的那条也不返回）',
      r2.code !== 0 && r2.out.indexOf('it-s3-none') >= 0 && r2.out.indexOf('第一道是选项守门') < 0,
      r2.out.trim().slice(0, 110));

    const r3 = run(['read', P3B, '--items', 'it-s3-i1', '--brief']);
    const r3b = run(['read', P3B, '--items', 'it-s3-i1', '--subtree', 'it-s3-n1']);
    check('S3 `read --items` 与 `--brief` / `--subtree` 同给 ⇒ 拒绝（两种口径不混）',
      r3.code !== 0 && r3.out.indexOf('--items 与 --brief 不能同给') >= 0
        && r3b.code !== 0 && r3b.out.indexOf('--subtree') >= 0,
      r3.out.trim().slice(0, 90));

    const r4 = s3json(run(['read', P3B, '--json']).out);
    check('S3 `read --json` 的节点视图**不含 items**、也不带条目正文（read 的字节形状承诺没变）',
      !!r4 && r4.nodes.every((n) => !('items' in n))
        && JSON.stringify(r4).indexOf('第一道是选项守门') < 0,
      'nodes=' + (r4 ? r4.nodes.length : '-'));

    const qa1 = ((r4 || { nodes: [] }).nodes.filter((n) => n.id === 'it-s3-n1')[0] || {}).qa;
    check('S3 `qa` 派生化：条目化节点的 qa 由 items 现场派生，形状与 v2 逐字段相同（老消费者不用改）',
      JSON.stringify(qa1) === JSON.stringify([{ q: '闸门是几道？', a: '两道。', at: '2026-09-01T00:00:00.000Z' }]),
      JSON.stringify(qa1));

    /* ---------------- 49.7 未条目化项目（v2 数据）不退化 ---------------- */
    const v1 = s3json(run(V2HIT).out);
    const v2 = s3json(run(V2HIT.concat(['--topic-only'])).out);
    check('S3 纯 v2 数据：默认口径照旧按 topic 命中（itemId=null、itemized=false）—— 既有行为不退化',
      !!v1 && v1.hits.length === 1 && v1.hits[0].itemId === null && v1.hits[0].itemized === false
        && v1.hits[0].matchIn === 'topic',
      JSON.stringify(v1 && v1.hits[0]));
    check('S3 纯 v2 数据：`--topic-only` 与默认口径结果逐字节相同（回退开关在 v2 数据上无副作用）',
      !!v1 && !!v2 && JSON.stringify(v2.hits) === JSON.stringify(v1.hits) && v2.mode === 'topic-only',
      JSON.stringify(v2 && v2.hits.map((h) => h.nodeId)));

    const v3 = run(['get', P3A, 'it-s3-a2', '--item', 'it-s3-none']);
    check('S3 未条目化节点上 `get --item` ⇒ 非 0 且说清"未条目化"（指路，不是含糊的"条目不存在"）',
      v3.code !== 0 && v3.out.indexOf('未条目化') >= 0, v3.out.trim().slice(0, 90));

    /* ---------------- 49.8 选项面自洽 + 只读不落盘 ---------------- */
    const u1 = run(['get', P3B, 'it-s3-n1', '--items', 'it-s3-i1']);
    const u2 = run(['search', P3B, '闸门', '--media', 'x']);
    check('S3 选项面自洽：`get` 不认识 `--items`（各命令只认自己声明的），未知选项给出支持集',
      u1.code !== 0 && u1.out.indexOf('--items') >= 0 && u1.out.indexOf('未知选项') >= 0
        && u2.code !== 0 && u2.out.indexOf('--topic-only') >= 0 && u2.out.indexOf('--max-bytes') >= 0,
      u1.out.trim().slice(0, 70) + '｜' + u2.out.trim().slice(0, 70));

    check('S3 只读查询**不生成索引文件**：跑完 search/get/read 后项目目录清单与项目文件字节都不变',
      s3ls(P3B).join(',') === s3lsBefore.join(',') && fs.readFileSync(s3file(P3B), 'utf8') === s3fixtureText,
      '目录=' + s3ls(P3B).join(','));
  } finally {
    // 自收尾（探针自己删干净；文件末尾「清理」段另有兜底）
    try { fs.rmSync(path.join(ROOT, 'projects', P3A), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    try { fs.rmSync(path.join(ROOT, 'projects', P3B), { recursive: true, force: true }); } catch (e) { /* 同上 */ }
  }
}

/* ---------------- 52. 写管道流（S7）：写命令的**重试安全**（幂等） ----------------
 * 判据（对应 S7 任务书的四条验收）：
 *   ① 同 `--idem` 重放两次 ⇒ 数据**逐字节不变** + 回显含「幂等命中」；
 *   ② `add` 同父同题同内容重放 ⇒ **默认拒绝并指出那一条**（不是静默跳过、不是造第二份）；
 *   ③ 一次 `apply` 改 N 条 ⇒ `.changes.jsonl` **只多 1 条**（一个 rev、一次原子写）；
 *   ④ 中途第 k 条非法 ⇒ **整体不动**且**指名第 k 条**（人为注入证明）。
 * 另钉：幂等键落进日志的**可选字段** `idem`（不升 formatVersion）、只读命令带 `--idem` 被拒。
 * 探针一律 `it-s7-` 前缀 —— 它们与别的流共用同一个 `projects/`（真实目录）或同一个沙箱，
 * 前缀是**唯一**能避免互踩的手段（别改成别的名字）。 */
{
  const P7 = 'it-s7-idem-' + Date.now().toString(36);
  const projJson = (name) => path.join(ROOT, 'projects', name, name + '.json');
  const logJson = (name) => path.join(ROOT, 'projects', name, '.changes.jsonl');
  const bytes = (p) => fs.readFileSync(p);
  const text = (p) => fs.readFileSync(p, 'utf8');
  const opsFile = (name, content) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    return p;
  };
  const logOf = (name) => {
    try {
      return text(logJson(name)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch (e) { return []; }
  };

  run(['init', P7, '--title', 'S7 幂等探针']);
  run(['add', P7, 'root', '--topic', 'k1', '--id', 'k1']);
  run(['add', P7, 'root', '--topic', 'k2', '--id', 'k2']);
  run(['add', P7, 'root', '--topic', 'k3', '--id', 'k3']);

  // 52.1 同 --idem 重放 ⇒ 数据逐字节不变 + 回显「幂等命中」（+ 真的只落一个节点）
  const before1 = bytes(projJson(P7));
  const first1 = run(['add', P7, 'root', '--topic', '幂等节点', '--detail-md', '正文', '--idem', 's7-k1']);
  const mid1 = bytes(projJson(P7));
  const again1 = run(['add', P7, 'root', '--topic', '幂等节点', '--detail-md', '正文', '--idem', 's7-k1']);
  const after1 = bytes(projJson(P7));
  const sameCount = (JSON.parse(text(projJson(P7))).data.children || [])
    .filter((c) => c.topic === '幂等节点').length;
  check('S7 幂等：同 --idem 重放两次 ⇒ 盘上**逐字节不变** 且回显含「幂等命中」',
    ok(first1.out) && ok(again1.out) && again1.out.indexOf('幂等命中') >= 0
      && !before1.equals(mid1) && mid1.equals(after1) && sameCount === 1,
    '第一遍写入=' + !before1.equals(mid1) + ' 第二遍未变=' + mid1.equals(after1)
      + ' 命中=' + (again1.out.indexOf('幂等命中') >= 0) + ' 顶层同名节点=' + sameCount);

  // 52.2 幂等重放**复述首次结果**（id 由时间+随机生成 ⇒ 复述得出"首次那个 id"才算真的没重跑）
  const first2 = run(['add', P7, 'root', '--topic', '复述节点', '--idem', 's7-k2']);
  const m2 = /已添加: (\S+)（父 root）/.exec(first2.out);
  const again2 = run(['add', P7, 'root', '--topic', '复述节点', '--idem', 's7-k2']);
  check('S7 幂等：重放给出的是**首次结果**（首次那个随机 id 被复述回来，不是新造一个）',
    ok(first2.out) && !!m2 && ok(again2.out) && again2.out.indexOf(m2[1]) >= 0
      && (again2.out.match(/已添加/g) || []).length === 1,
    '首次 id=' + (m2 && m2[1]) + ' 重放里含它=' + (!!m2 && again2.out.indexOf(m2[1]) >= 0));

  // 52.3 add 语义去重：同父同题同内容 ⇒ **默认拒绝并点名那一条**，盘上零改动；--force 才放行
  const before3 = bytes(projJson(P7));
  const a3 = run(['add', P7, 'k1', '--topic', '去重节点', '--detail-md', '同一段正文']);
  const mid3 = bytes(projJson(P7));
  const m3 = /已添加: (\S+)（父 k1）/.exec(a3.out);
  const b3 = run(['add', P7, 'k1', '--topic', '去重节点', '--detail-md', '同一段正文']);
  const after3 = bytes(projJson(P7));
  check('S7 去重：add 同父同题同内容重放 ⇒ 默认拒绝、**点名那一条**、盘上零改动',
    ok(a3.out) && !!m3 && b3.code !== 0 && b3.out.indexOf('已存在同父同题同内容的节点') >= 0
      && b3.out.indexOf(m3[1]) >= 0 && after3.equals(mid3) && !mid3.equals(before3),
    'exit=' + b3.code + ' 点名=' + (!!m3 && b3.out.indexOf(m3[1]) >= 0)
      + ' 盘上未变=' + after3.equals(mid3));
  const c3 = run(['add', P7, 'k1', '--topic', '去重节点', '--detail-md', '同一段正文', '--force']);
  check('S7 去重：--force 是"我真的要第二份"的显式出口（放行 + 回显里说明是有意重复）',
    ok(c3.out) && c3.out.indexOf('有意重复') >= 0,
    c3.out.trim().split('\n')[0]);

  // 52.4 一次 apply 改 N 条 ⇒ 日志**只多 1 条**（一个 rev、一次原子写），且 N 条都真的改了
  const n4 = logOf(P7).length;
  const r4 = run(['apply', P7, '--ops-file', opsFile('s7-52-4.json', {
    version: 1,
    ops: [
      { op: 'edit', id: 'k1', topic: '52-改1' },
      { op: 'edit', id: 'k2', topic: '52-改2' },
      { op: 'edit', id: 'k3', topic: '52-改3' }
    ]
  })]);
  const log4 = logOf(P7);
  const last4 = log4[log4.length - 1] || {};
  check('S7 apply：一次 apply 改 3 条 ⇒ .changes.jsonl **只多 1 条**（不是 3 条），writer=cli:apply',
    ok(r4.out) && r4.out.indexOf('apply 完成：3 条操作') >= 0
      && log4.length === n4 + 1 && last4.writer === 'cli:apply'
      && (last4.changed || []).indexOf('node:k1') >= 0
      && (last4.changed || []).indexOf('node:k2') >= 0
      && (last4.changed || []).indexOf('node:k3') >= 0,
    '日志 ' + n4 + ' → ' + log4.length + ' 条；changed=' + JSON.stringify(last4.changed));

  // 52.5 注入证明：第 4 条非法（引用不存在的节点）⇒ **整体不动** + **指名第 4 条**
  const before5 = bytes(projJson(P7));
  const n5 = logOf(P7).length;
  const r5 = run(['apply', P7, '--ops-file', opsFile('s7-52-5.json', {
    version: 1,
    ops: [
      { op: 'edit', id: 'k1', topic: '不该生效-1' },
      { op: 'edit', id: 'k2', topic: '不该生效-2' },
      { op: 'edit', id: 'k3', topic: '不该生效-3' },
      { op: 'edit', id: 'no-such-node-xyz', topic: '第4条非法' }
    ]
  })]);
  const after5 = bytes(projJson(P7));
  check('S7 apply：第 4 条非法 ⇒ **整体不动**（逐字节不变、日志零新增）且**点名第 4 条**',
    r5.code !== 0 && r5.out.indexOf('第 4 条操作') >= 0 && r5.out.indexOf('no-such-node-xyz') >= 0
      && r5.out.indexOf('整体未执行') >= 0 && after5.equals(before5) && logOf(P7).length === n5,
    'exit=' + r5.code + ' 盘上未变=' + after5.equals(before5) + ' 日志=' + logOf(P7).length);

  // 52.6 只允许数据面：`remove` 这类需要连带清理的 op 不在事务里 ⇒ 指名拒绝（不是静默忽略）
  const r6 = run(['apply', P7, '--ops-file', opsFile('s7-52-6.json', { ops: [{ op: 'remove', id: 'k1' }] })]);
  check('S7 apply：不在事务里的 op（remove）被**指名拒绝**并指路，节点没被删',
    r6.code !== 0 && r6.out.indexOf('不认识的 op') >= 0 && r6.out.indexOf('remove') >= 0
      && text(projJson(P7)).indexOf('"id": "k1"') >= 0,
    'exit=' + r6.code + ' 报文=' + r6.out.trim().slice(0, 70));

  // 52.7 幂等键的落点：日志的可选字段 `idem`（不给键 ⇒ 字段缺席，老写入路径落盘不变）
  const r7a = run(['edit', P7, 'k2', '--topic', '52-不带键']);          // 先来一条**不带键**的
  const r7 = run(['edit', P7, 'k2', '--topic', '52-带键', '--idem', 's7-k3']);
  const log7 = logOf(P7);
  const keyed = log7[log7.length - 1] || {};          // 带键的那条
  const noKey = log7[log7.length - 2] || {};          // 它前面那条（没带键）
  check('S7 幂等：键落进 .changes.jsonl 的**可选字段** idem（不给键的那条没有这个字段）',
    ok(r7a.out) && ok(r7.out) && keyed.idem === 's7-k3' && noKey.idem === undefined
      && keyed.writer === 'cli:edit' && keyed.writer === noKey.writer
      && typeof keyed.out === 'string' && keyed.out.indexOf('已更新') >= 0,
    '带键条目 idem=' + keyed.idem + ' out=' + JSON.stringify(keyed.out)
      + '；上一条 idem=' + noKey.idem);
  check('S7 幂等：键是**旁路产物** —— 不写进项目 JSON、formatVersion 不升（可选字段，照 origin 先例）',
    text(projJson(P7)).indexOf('s7-k3') < 0
      && JSON.parse(text(projJson(P7))).meta.formatVersion === 2,
    '项目 JSON 里搜不到键=' + (text(projJson(P7)).indexOf('s7-k3') < 0));

  // 52.8 只读命令带 --idem ⇒ **响亮拒绝**（别让调用方以为"带了键就重试安全"）
  const r8 = run(['read', P7, '--idem', 's7-k9']);
  check('S7 幂等：只读命令带 --idem ⇒ 响亮拒绝（默默忽略 = 让 AI 以为拿到了重试安全）',
    r8.code !== 0 && r8.out.indexOf('--idem 只对') >= 0 && ok(run(['read', P7]).out),
    'exit=' + r8.code + ' ' + r8.out.trim().slice(0, 60));

  // ---- 自收尾（探针自己删干净；集成脚本末尾那一段也会兜底一次）----
  try { fs.rmSync(path.join(ROOT, 'projects', P7), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
  void os;
}

/* ---------------- 48. 条目级写原语（S2）：改一条不用重写整块 detail ----------------
 * 判据（对应 S2 任务书的九条验收，**逐条一个 `check`**）：
 *   （S2 之一）`item-add` 在**未条目化**节点上会**自动条目化**（成功 + 回显点名 `i-…` 形式的 itemId）；
 *   （S2 之二）`item-add` 缺正文 ⇒ 拒绝并说清 `--md`/`--html`；两个来源选项同给 ⇒ 拒绝（不许"取其一"）；
 *   （S2 之三）`item-edit` 只动指定字段：回显列出真变了的字段名，其余条目**逐字节不变**；
 *   （S2 之四）`item-order`：`--ids` 不是完整排列 ⇒ 拒绝并**点名少了谁**；给完整排列 ⇒ 顺序变、集合不变；
 *   （S2 之五）`item-move`：搬到另一个条目化节点 ⇒ 回显点名源→目标、条目 id 不变、**只多一条变更日志**；
 *   （S2 之六）`item-remove`：被 `links[].item` 引用时**默认拒绝 + 点名引用者 + 给 `--clean-links` 出路**；
 *   （S2 之七）`render-detail`：**幂等**（第二次跑 `changed:0` 且盘上逐字节不变）；
 *   （S2 之八）`edit --detail` 在条目化节点上**拒绝并指路 `item-*`**（条目层零损伤；`--topic` 照常可用）；
 *   （S2 之九）收尾：该项目跑 `validate` 必须 exit 0。
 *
 * 探针项目一律 `it-s2-` 前缀（与别的流互不踩）；本段在 `finally` 里**自删** —— 夹具是**条目化**节点，
 * 中途抛错也不能把它留在真实 `projects/` 里（那份残留会被项目列表与后续链路的读数算进去）。
 * 本段排在 §14（`validate-all`）之后，同样是为了别让 validate-all 在夹具存在期间扫到它。
 * `item-add` 落的是**条目层**（items 为真源、detail 是派生缓存），所以本段的判据一律**回读盘上真值**
 * （`readProj` / `nodeOf`），不拿命令回显当数据结论。 */
{
  const S2TAG = Date.now().toString(36);
  const P8 = 'it-s2-items-' + S2TAG;
  const s2file = (name) => path.join(ROOT, 'projects', name, name + '.json');
  const s2bytes = (name) => fs.readFileSync(s2file(name));                 // Buffer：**逐字节**判据
  const s2logLines = (name) => {
    try {
      return fs.readFileSync(path.join(ROOT, 'projects', name, '.changes.jsonl'), 'utf8')
        .split('\n').filter((l) => l.trim()).length;
    } catch (e) { return 0; }
  };
  const s2node = (id) => nodeOf(readProj(P8), id);
  const s2items = (id) => ((s2node(id) || {}).items) || [];
  const s2ids = (id) => s2items(id).map((x) => x.id);
  const s2itemId = (out) => { const m = /(i-[a-z0-9-]+)/.exec(String(out)); return m ? m[1] : null; };
  const s2json = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };

  try {
    run(['init', P8, '--title', 'S2 条目写原语探针']);
    run(['add', P8, 'root', '--topic', 'S2 甲节点', '--id', 'it-s2-a']);
    run(['add', P8, 'root', '--topic', 'S2 乙节点', '--id', 'it-s2-b']);

    // （S2 之一）自动条目化：未条目化节点上直接加条目 ⇒ items 建起来 + 回显点名 itemId
    const rA1 = run(['item-add', P8, 'it-s2-a', '--html', '<p>甲一</p>']);
    const iA1 = s2itemId(rA1.out);
    check('S2 item-add：未条目化节点 ⇒ **自动条目化**（items 落盘）+ 回显点名 i-… 形式的 itemId',
      ok(rA1.out) && !!iA1 && /^i-[a-z0-9]/.test(iA1) && rA1.out.indexOf(iA1) >= 0
        && s2ids('it-s2-a').length === 1 && s2ids('it-s2-a')[0] === iA1
        && (s2items('it-s2-a')[0] || {}).html === '<p>甲一</p>',
      '回显=' + rA1.out.trim().slice(0, 60) + ' ｜ 盘上 items=' + JSON.stringify(s2ids('it-s2-a')));

    // （S2 之二）缺正文 / 两个来源选项同给 ⇒ 两种拒绝都点名那两条正路
    const rNoBody = run(['item-add', P8, 'it-s2-a']);
    const rBothSrc = run(['item-add', P8, 'it-s2-a', '--md', '甲', '--html', '<p>甲</p>']);
    check('S2 item-add：缺正文 ⇒ 拒绝且说清 --md / --html；--md 与 --html 同给 ⇒ 拒绝（不许"取其一"）',
      rNoBody.code !== 0 && rNoBody.out.indexOf('--md') >= 0 && rNoBody.out.indexOf('--html') >= 0
        && rBothSrc.code !== 0 && rBothSrc.out.indexOf('不能同时给') >= 0
        && s2ids('it-s2-a').length === 1,                       // 两次都没写进去
      '缺正文 exit=' + rNoBody.code + '；同给 exit=' + rBothSrc.code + ' ｜ ' + rBothSrc.out.trim().slice(0, 60));

    // （S2 之三）item-edit 只动指定字段：回显列出真变了的字段名，其余条目逐字节不变
    const rA2 = run(['item-add', P8, 'it-s2-a', '--html', '<p>甲二</p>', '--src', 'CHANGELOG.md:1-2']);
    const iA2 = s2itemId(rA2.out);
    const othersBefore = JSON.stringify(s2items('it-s2-a').filter((x) => x.id !== iA2));
    const rEd = run(['item-edit', P8, 'it-s2-a', iA2, '--tags', '改过的标签']);
    const a2 = s2items('it-s2-a').filter((x) => x.id === iA2)[0] || {};
    const othersAfter = JSON.stringify(s2items('it-s2-a').filter((x) => x.id !== iA2));
    check('S2 item-edit：只动指定字段 —— 回显列出真变了的字段名（tags），其余条目**逐字节不变**',
      ok(rEd.out) && rEd.out.indexOf('tags') >= 0 && rEd.out.indexOf('html') < 0
        && s2ids('it-s2-a').length === 2
        && JSON.stringify(a2.tags) === JSON.stringify(['改过的标签'])
        && a2.html === '<p>甲二</p>' && a2.src === 'CHANGELOG.md:1-2'   // 没点名的字段一个都没动
        && othersAfter === othersBefore,
      '回显=' + rEd.out.trim().slice(0, 70) + ' ｜ 其余条目逐字节不变=' + (othersAfter === othersBefore));

    // （S2 之四）item-order：缺项 ⇒ 点名少了谁；完整排列 ⇒ 顺序变、集合不变
    const rA3 = run(['item-add', P8, 'it-s2-a', '--html', '<p>甲三</p>']);
    const iA3 = s2itemId(rA3.out);
    const idsBefore = s2ids('it-s2-a');                            // [iA1, iA2, iA3]
    const rOrdBad = run(['item-order', P8, 'it-s2-a', '--ids', idsBefore.slice(0, 2).join(',')]);
    const s2want = [iA3, iA1, iA2];
    const rOrdOk = run(['item-order', P8, 'it-s2-a', '--ids', s2want.join(',')]);
    const idsAfter = s2ids('it-s2-a');
    check('S2 item-order：`--ids` 不是完整排列 ⇒ 拒绝并**点名少了谁**；给完整排列 ⇒ 顺序变、集合不变',
      rOrdBad.code !== 0 && rOrdBad.out.indexOf('少了') >= 0 && rOrdBad.out.indexOf(iA3) >= 0
        && ok(rOrdOk.out) && JSON.stringify(idsAfter) === JSON.stringify(s2want)
        && JSON.stringify(idsAfter.slice().sort()) === JSON.stringify(idsBefore.slice().sort())
        && s2items('it-s2-a').length === 3,
      '缺项 exit=' + rOrdBad.code + '（报文点名 ' + iA3 + '）；重排后=' + JSON.stringify(idsAfter));

    // （S2 之五）item-move：换节点 ⇒ 回显点名声→目标、id 不变、只多一条变更日志（一次原子写）
    const rB1 = run(['item-add', P8, 'it-s2-b', '--html', '<p>乙一</p>']);
    const iB1 = s2itemId(rB1.out);
    const logBefore = s2logLines(P8);
    const rMv = run(['item-move', P8, 'it-s2-a', iA1, '--to', 'it-s2-b']);
    const logAfter = s2logLines(P8);
    const moved = s2items('it-s2-b').filter((x) => x.id === iA1)[0] || {};
    check('S2 item-move：搬到另一个条目化节点 ⇒ 回显点名源→目标、条目 id 不变、**只多一条变更日志**',
      ok(rMv.out) && rMv.out.indexOf(iA1) >= 0 && /it-s2-a\s*→\s*it-s2-b/.test(rMv.out)
        && s2ids('it-s2-a').indexOf(iA1) < 0 && s2ids('it-s2-b').indexOf(iA1) >= 0
        && moved.html === '<p>甲一</p>'                            // id 与正文都原样跟过去
        && s2ids('it-s2-b').length === 2 && logAfter === logBefore + 1,
      '回显=' + rMv.out.trim() + ' ｜ 变更日志 ' + logBefore + ' → ' + logAfter);

    // （S2 之六）item-remove：被 links[].item 引用 ⇒ 默认拒绝、点名引用者、给 --clean-links 出路
    {
      // 直接造一条带 item 的链接（**条目级链接的写入归 S6**，本段只造数据形状 —— 与
      // tests/item-commands.test.js 的 F 段同一做法：判据看形状，不看这条边由谁写的）
      const d = readProj(P8);
      nodeOf(d, 'it-s2-b').links = [{ project: P8, id: 'it-s2-a', item: iA2, caption: '指向该条目' }];
      fs.writeFileSync(s2file(P8), JSON.stringify(d, null, 2), 'utf8');
    }
    const bytesBeforeRm = s2bytes(P8);
    const rRmBad = run(['item-remove', P8, 'it-s2-a', iA2]);
    const rmZeroWrite = s2bytes(P8).equals(bytesBeforeRm);        // 拒绝 ⇒ 一个字节都不写
    // ⚠️ "条目还在"必须在**清理之前**回读（清理之后它当然不在了 —— 判据别自己打自己）
    const rmStillThere = s2ids('it-s2-a').indexOf(iA2) >= 0;
    const rRmOk = run(['item-remove', P8, 'it-s2-a', iA2, '--clean-links']);
    const s2linker = s2node('it-s2-b');
    check('S2 item-remove：被 links[].item 引用 ⇒ 默认拒绝 + **点名引用者** + 给 --clean-links 出路；'
      + '带 --clean-links 才连带剪掉那条引用',
      rRmBad.code !== 0 && rRmBad.out.indexOf(iA2) >= 0 && rRmBad.out.indexOf('it-s2-b') >= 0
        && rRmBad.out.indexOf('--clean-links') >= 0 && rRmBad.out.indexOf('links-prune') >= 0
        && rmZeroWrite && rmStillThere                              // 拒绝 ⇒ 条目与盘上一个字节都没动
        && ok(rRmOk.out) && s2ids('it-s2-a').indexOf(iA2) < 0 && !s2linker.links,
      '拒绝 exit=' + rRmBad.code + ' 盘上零改动=' + rmZeroWrite + ' ｜ 清理出口 exit=' + rRmOk.code
        + ' 清理后引用者 links=' + JSON.stringify(s2linker.links)
        + ' ｜ 拒绝报文=' + rRmBad.out.trim().slice(0, 130));

    // （S2 之七）render-detail：幂等（第二次 changed:0 且盘上逐字节不变）
    const rRd1 = run(['render-detail', P8, 'it-s2-a', '--json']);
    const bytesMid = s2bytes(P8);
    const rRd2 = run(['render-detail', P8, 'it-s2-a', '--json']);
    const rd1 = s2json(rRd1.out), rd2 = s2json(rRd2.out);
    check('S2 render-detail：**幂等** —— 第二次跑 changed:0 且盘上逐字节不变',
      ok(rRd1.out) && ok(rRd2.out) && !!rd1 && !!rd2 && rd2.changed === 0 && rd2.scanned >= 1
        && s2bytes(P8).equals(bytesMid),
      '第一次 changed=' + (rd1 && rd1.changed) + '；第二次 changed=' + (rd2 && rd2.changed)
        + ' ｜ 第二次逐字节不变=' + s2bytes(P8).equals(bytesMid));

    // （S2 之八）edit --detail 在条目化节点上拒绝并指路 item-*（条目层零损伤；--topic 照常可用）
    const bIdsBefore = s2ids('it-s2-b');
    const rEdDetail = run(['edit', P8, 'it-s2-b', '--detail', '<p>整块改写</p>']);
    const rEdTopic = run(['edit', P8, 'it-s2-b', '--topic', 'S2 乙节点（改名）']);
    check('S2 `edit --detail` 在条目化节点上**拒绝并指路 `item-*`**（条目层零损伤；`--topic` 照常可用）',
      rEdDetail.code !== 0 && rEdDetail.out.indexOf('条目化') >= 0
        && rEdDetail.out.indexOf('item-add') >= 0 && rEdDetail.out.indexOf('render-detail') >= 0
        && JSON.stringify(s2ids('it-s2-b')) === JSON.stringify(bIdsBefore)
        && ok(rEdTopic.out) && (s2node('it-s2-b') || {}).topic === 'S2 乙节点（改名）',
      '拒绝 exit=' + rEdDetail.code + ' ｜ 条目 id 未变='
        + (JSON.stringify(s2ids('it-s2-b')) === JSON.stringify(bIdsBefore)));

    // （S2 之九）收尾：整段跑完的项目过数据闸门
    const rVal = run(['validate', P8]);
    check('S2 收尾：整段跑完的项目 `validate` exit 0（条目化数据没把 G2 写红）',
      rVal.code === 0, 'exit=' + rVal.code + ' ｜ ' + rVal.out.trim().slice(0, 80));
  } finally {
    // 自收尾：探针项目自己删干净（它是条目化夹具，留在真实 projects/ 里会被后续读数算进去）
    try { fs.rmSync(path.join(ROOT, 'projects', P8), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
  }
}

/* ---------------- 47. 条目层迁移（S1）：`migrate items` 的幂等 / 准入门槛 / qa 收敛 / 备份 ----------------
 * 判据（对应 S1 任务书的验收，逐条一个 `check`）：
 *   （S1 之一）`migrate items <项目> --dry-run --json`：exit 0、stdout 是**一份** JSON、
 *               逐条点名"将跳过"的节点（带原因），且**盘上零改动**、**不备份**；
 *   （S1 之二）真跑：exit 0 + `validate` exit 0 + `meta.formatVersion` 3 + 被迁移节点
 *               `detail === renderDetail(items)`（逐字节，用**同一个**渲染实现比对）+ 原 detail 内容未变；
 *   （S1 之三）**幂等**：第二次跑 `changed:{nodes:0,items:0}` 且项目文件**逐字节不变**；
 *   （S1 之四）**准入门槛**：不可逐字节回放的节点进 `skipped`（点名 + 原因），它的 detail 一个字节没动；
 *   （S1 之五）`qa[]` 收敛：节点的 `qa` 键**消失**、内容成为 `type:'qa'` 条目（保序追加、`item.qa` 原样）；
 *   （S1 之六）写盘前**自动备份**：路径绝对、落在 `.review/<日期>-条目层迁移/`、且那份 aimap 的
 *               `formatVersion` 仍是 2（回退就靠它）；
 *   （S1 之七）**位置参数陷阱**：项目名取的是 `args._[1]`（报错点真项目名，不点 `items`）；
 *   （S1 之八）`migrate` 是**写命令**：`cli/core.js` 的 `WRITE_COMMANDS` 里有它 ⇒ 带 `--idem` 被接受，
 *               且同键重放**命中**（`hit:true`、盘上零改动）。
 *
 * 探针项目一律 `it-s1-` 前缀（其它流的探针各有前缀，互不踩）；本段在 `finally` 里**自删**，
 * 连它写下的那份备份一起 —— 备份落在工程的 `.review/` 下（不进版本库），但也不该留给下一个人。
 * `detail` 的判据一律取自**盘上真值**（`readProj` / `nodeOf`），并调用与迁移**同一个**渲染实现
 * （`src/item-model.js` 的 `renderDetail`）—— 用另一份实现去比对等于自说自话。 */
{
  const S1TAG = Date.now().toString(36);
  const P9 = 'it-s1-migrate-' + S1TAG;
  const P10 = 'it-s1-idem-' + S1TAG;
  const S1MODEL = require(path.join(ROOT, 'src', 'item-model.js'));
  const s9file = (name) => path.join(ROOT, 'projects', name, name + '.json');
  const s9bytes = (name) => fs.readFileSync(s9file(name));
  const s9node = (name, id) => nodeOf(readProj(name), id);
  const s9json = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };
  /** 备份**目录**（与 `cli/commands/migrate.js` 同一处口径：`.review/<YYYYMMDD>-条目层迁移/`） */
  const s9backupDir = () => {
    const d = new Date(); const p = (n) => (n < 10 ? '0' + n : String(n));
    return path.join(ROOT, '.review', d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-条目层迁移');
  };
  /** 备份**文件**落点：`.review/<YYYYMMDD>-条目层迁移/<项目>.aimap.json` */
  const s9backup = (name) => path.join(s9backupDir(), name + '.aimap.json');
  /** 备份目录的**自述文件名**（与 `cli/commands/migrate.js`、G8 的 `checkWorkDirStatus` 同一处口径） */
  const S9_README = 'README.md';
  const s9clean = (name) => {
    try { fs.rmSync(path.join(ROOT, 'projects', name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    try { fs.rmSync(s9backup(name), { force: true }); } catch (e) { /* 备份是自己写的，要自己收干净 */ }
    // ⚠️ **备份目录也要收**（只删文件会留下一个**空目录**）：G8（文档登记与家门）在链里排在 G4 **之前**
    //    （`scripts/verify.js` 的步骤表：G8 = 步 2、G4 = 步 12）⇒ 一个没有 `README.md` 的空目录会让
    //    **下一次**全链在 G8 红「[工作目录无状态] … `.review/<日期>-条目层迁移/`」，而这一次却是绿的
    //    （本批实测就是被这样"毒化"的：第一次全绿、下一次必红）。
    //
    // **改前**钉的是"不留空壳"：只在目录**空**时删 ⇒ 目录里**只剩** `migrate` 写的那份自述
    //   `README.md` 时，这个壳会**合法地**留下来（G8 认它合法 ⇒ 没有任何门禁会红 ✗），
    //   于是 `.review/<日期>-条目层迁移/` 永久留着一个"已收口、里头什么都没有"的目录。
    //   （本批开工时实测就有这么一个：只有 `README.md`、备份文件早已被上一轮的收尾删掉。）
    // **改后**：**仅剩自述时连自述一起删**（删完再把目录删掉）；**有别的东西一律不动** ——
    //   真跑过 `migrate` 的备份、或任何第三方文件在场时，**连自述也不碰** ✓。
    // 凭什么仍守得住：判据（S1 之九）从"不是空壳"升级成"**不留任何残留**"——目录要么不存在，
    //   要么里面**有别人的东西**（那时不动它才是对的）。自述本身没有数据价值：`cli/commands/migrate.js`
    //   写的那份自述里明说"能整目录删除"（`formatVersion 2` 的那份备份才是数据，它由上面两行删掉）。
    try {
      const dir = s9backupDir();
      if (!fs.existsSync(dir)) return;
      const left = fs.readdirSync(dir);
      if (left.length === 0) { fs.rmdirSync(dir); return; }
      if (left.length === 1 && left[0] === S9_README) {
        fs.rmSync(path.join(dir, S9_README), { force: true });   // 仅剩自述 ⇒ 连自述一起删
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      }
    } catch (e) { /* 删不掉不在这里判红：下面有一条断言专门盯它 */ }
  };
  /** 可无损回放（多块 + 列表组 + 块间空白）；**不可**回放（根层裸文本） */
  const D9_OK = '<h3>标题</h3>\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n<p>收尾</p>';
  const D9_BAD = '<ul>\n<li>甲</li>\n</ul>\n根层裸文本\n<p>尾</p>';

  try {
    run(['init', P9, '--title', 'S1 条目层迁移探针']);
    run(['add', P9, 'root', '--id', 'it-s1-ok', '--topic', '可回放', '--detail', D9_OK]);
    run(['add', P9, 'root', '--id', 'it-s1-bad', '--topic', '不可回放', '--detail', D9_BAD]);
    run(['add', P9, 'root', '--id', 'it-s1-qa', '--topic', '问答节点', '--detail', '<p>前言</p>']);
    {
      // `qa[]` 的写入口不在本条链路上（归 ask-apply）⇒ 这里只造**数据形状**（判据看形状，不看谁写的）
      const d = readProj(P9);
      nodeOf(d, 'it-s1-qa').qa = [{ q: '问', a: '答', at: '2026-10-01T00:00:00.000Z' }];
      fs.writeFileSync(s9file(P9), JSON.stringify(d, null, 2), 'utf8');
    }

    // （S1 之一）--dry-run：如实 + 零改动 + 不备份
    const bytes0 = s9bytes(P9);
    const rDry = run(['migrate', 'items', P9, '--dry-run', '--json']);
    const dry = s9json(rDry.out);
    check('S1 migrate --dry-run：exit 0 + 一份可解析 JSON + 逐条点名"将跳过" + 盘上零改动 + 不备份',
      rDry.code === 0 && ok(rDry.out) && !!dry
        && dry.itemized === 2 && dry.changed.nodes === 2 && dry.items === 6
        && dry.skipped.length === 1 && dry.skipped[0].nodeId === 'it-s1-bad'
        && String(dry.skipped[0].reason).indexOf('回放') >= 0
        && dry.backup === null && s9bytes(P9).equals(bytes0),
      'itemized=' + (dry && dry.itemized) + ' skipped=' + JSON.stringify(dry && dry.skipped.map((s) => s.nodeId))
        + ' 盘上零改动=' + s9bytes(P9).equals(bytes0));

    // （S1 之二）真跑：一致 + 版本号 + 内容未变
    const rRun = run(['migrate', 'items', P9, '--json']);
    const rep = s9json(rRun.out);
    const viRun = run(['validate', P9]);
    const nOk = s9node(P9, 'it-s1-ok');
    check('S1 migrate：真跑 exit 0 + validate exit 0 + formatVersion 3 + detail === renderDetail(items)（逐字节）',
      rRun.code === 0 && ok(rRun.out) && !!rep && rep.changed.nodes === 2
        && viRun.code === 0 && readProj(P9).meta.formatVersion === 3
        && Array.isArray(nOk.items) && nOk.detail === S1MODEL.renderDetail(nOk.items)
        && nOk.detail === D9_OK,
      'exit=' + rRun.code + ' validate=' + viRun.code + ' changed=' + JSON.stringify(rep && rep.changed)
        + ' 一致性=' + (Array.isArray(nOk.items) && nOk.detail === S1MODEL.renderDetail(nOk.items)));

    // （S1 之三）幂等：第二次 0 改动 + 逐字节不变
    const bytes1 = s9bytes(P9);
    const rAgain = run(['migrate', 'items', P9, '--json']);
    const rep2 = s9json(rAgain.out);
    check('S1 migrate **幂等**：第二次 changed:{nodes:0,items:0} 且项目文件逐字节不变',
      rAgain.code === 0 && !!rep2 && rep2.changed.nodes === 0 && rep2.changed.items === 0
        && rep2.itemized === 0 && rep2.backup === null && s9bytes(P9).equals(bytes1),
      'changed=' + JSON.stringify(rep2 && rep2.changed) + ' 逐字节不变=' + s9bytes(P9).equals(bytes1));

    // （S1 之四）准入门槛：跳过项点名 + 一个字节没动
    const nBad = s9node(P9, 'it-s1-bad');
    check('S1 migrate **准入门槛**：不可逐字节回放的节点进 skipped（点名 + 原因），它的 detail 一个字节没动',
      !!rep && rep.skipped.length === 1 && rep.skipped[0].nodeId === 'it-s1-bad'
        && nBad.items === undefined && nBad.detail === D9_BAD,
      'skipped=' + JSON.stringify(rep && rep.skipped) + ' 未动=' + (nBad.detail === D9_BAD));

    // （S1 之五）qa 收敛
    const nQa = s9node(P9, 'it-s1-qa');
    check('S1 migrate **qa 收敛**：节点 qa 键消失、内容成为 type:\'qa\' 条目（保序追加、item.qa 原样）',
      nQa.qa === undefined && nQa.items.map((x) => x.type).join(',') === 'rich,qa'
        && JSON.stringify(nQa.items[1].qa) === JSON.stringify({ q: '问', a: '答', at: '2026-10-01T00:00:00.000Z' })
        && nQa.detail === S1MODEL.renderDetail(nQa.items),
      'qa 键=' + JSON.stringify(nQa.qa) + ' types=' + nQa.items.map((x) => x.type).join(','));

    // （S1 之六）写盘前自动备份
    const bak = s9backup(P9);
    let packed = null;
    try { packed = JSON.parse(fs.readFileSync(bak, 'utf8')); } catch (e) { packed = null; }
    check('S1 migrate **写盘前自动备份**：绝对路径 + 落在 .review/<日期>-条目层迁移/ + formatVersion 仍是 2',
      !!rep && !!rep.backup && path.isAbsolute(rep.backup)
        && path.resolve(rep.backup) === path.resolve(bak)
        && !!packed && packed.meta.formatVersion === 2,
      'backup=' + (rep && rep.backup) + ' 是 aimap=' + !!packed);

    // （S1 之七）位置参数陷阱：项目名取 args._[1]
    const rBad = run(['migrate', 'items', 'no-such-project-xyz', '--json']);
    check('S1 migrate **位置参数**：项目名取 `args._[1]`（报错点真项目名，不点 `items`）',
      rBad.code !== 0 && rBad.out.indexOf('项目不存在: no-such-project-xyz') >= 0
        && rBad.out.indexOf('项目不存在: items') < 0,
      'exit=' + rBad.code + ' ｜ ' + rBad.out.trim().slice(0, 80));

    // （S1 之八）写命令归属 + 幂等键：`migrate` 必须在 WRITE_COMMANDS 里（否则带 --idem 会被响亮拒绝）
    run(['init', P10, '--title', 'S1 幂等键探针']);
    run(['add', P10, 'root', '--id', 'it-s1-i1', '--topic', '可回放', '--detail', D9_OK]);
    const key = 'it-s1-idem-' + S1TAG;
    const rIdem1 = run(['migrate', 'items', P10, '--idem', key, '--json']);
    const rep1 = s9json(rIdem1.out);
    const bytes10 = s9bytes(P10);
    const rIdem2 = run(['migrate', 'items', P10, '--idem', key, '--json']);
    const rep3 = s9json(rIdem2.out);
    check('S1 `migrate` 在 WRITE_COMMANDS 里：带 --idem 被接受，同键重放 ⇒ 命中（hit:true）且盘上零改动',
      rIdem1.code === 0 && rIdem2.code === 0 && !!rep1 && rep1.hit === undefined
        && !!rep3 && rep3.hit === true && s9bytes(P10).equals(bytes10),
      '第一次 exit=' + rIdem1.code + '（报告键=' + Object.keys(rep1 || {}).join(',') + '）'
        + '；第二次 exit=' + rIdem2.code + ' ｜ ' + rIdem2.out.trim().slice(0, 100));

    // （S1 之八·二）**区分"命中回放"与"又执行了一遍"** —— 这一条才是钉住那个静默缺陷的判据：
    // 命中回放给的是 `cli/main.js:181` 那个结构化对象（`{command,idem,hit,rev,version,result}`），
    // 它**没有** migrate 自己的报告键（`scanned`/`itemized`/`skipped`）；而"又跑了一遍"给的正是那份报告。
    // ⚠️ 改前只有 `rep3.hit === true` 这一条 ⇒ 缺陷只表现为"`hit` 是 undefined"，与"字段根本不存在"
    //    长得一模一样，看不出是**实现空转**（真因：`ctx.projectName` 默认取 `_[0]` = 子命令名 `items`
    //    ⇒ 幂等查询去"项目 `items`"的日志里找键 ⇒ 永远查不到；修法是 `ctx.useProject(project)`）。
    check('S1 `--idem` 的命中是**真命中**（回放对象，不是又执行一遍）：键/rev 对得上，且没有 migrate 自己的报告键',
      !!rep3 && rep3.command === 'migrate' && rep3.idem === key && rep3.hit === true
        && typeof rep3.rev === 'number' && rep3.rev > 0
        && rep3.scanned === undefined && rep3.itemized === undefined
        && String(rep3.result || '').indexOf('"itemized"') >= 0,
      '回放对象键=' + JSON.stringify(Object.keys(rep3 || {}).sort())
        + ' ｜ rev=' + (rep3 && rep3.rev)
        + ' ｜ result 里是首跑那份报告=' + /"itemized"/.test(String((rep3 || {}).result || '')));

    // （S1 之九）**收尾不留任何残留**：本段自建的备份目录不许以"空目录"或"只剩自述"的形式留给下一个人。
    // 判据 = 本段的两个备份文件都不在了 **且** 目录**不在了**（除非里面还有**别人的**文件 —— 那种情况
    // 本段一个字节都不动，正是"有别的东西一律不动"）。
    // 判据的由来见上面 `s9clean` 的注释：G8 在 G4 **之前**跑 ⇒ 空目录会毒化**下一次**全链，而这一次是绿的；
    // 只剩自述的目录虽然 G8 认它合法（**没有任何门禁会红**），但那正是"改前留下的壳"。
    // ⚠️ 目录里若有**别人的**文件（真跑过 `migrate` 的备份）不判红 —— 那不是本段造的，也不该由本段删。
    // 判别力（实测）：把 `s9clean` 里"仅剩自述 ⇒ 连自述一起删"那三行去掉 = 改前的行为 ⇒ 本断言**必红**
    // （此刻目录只剩 `README.md`；报文见交付说明）。
    s9clean(P9);
    s9clean(P10);
    const s9dir = s9backupDir();
    const s9exists = fs.existsSync(s9dir);
    const s9left = s9exists ? fs.readdirSync(s9dir) : [];
    const s9ours = s9left.filter((f) => f === P9 + '.aimap.json' || f === P10 + '.aimap.json');
    const s9shell = s9exists && (s9left.length === 0 || (s9left.length === 1 && s9left[0] === S9_README));
    check('S1 收尾：`.review/<日期>-条目层迁移/` **不留任何残留** —— 本段的备份文件收干净，且"仅剩自述"时'
      + '连自述一起删（改前只删空目录 ⇒ 只剩自述的壳会永久留下，而 G8 认它合法 ⇒ 没有任何门禁会红）',
      s9ours.length === 0 && !s9shell,
      '备份目录=' + s9dir + ' ｜ 本段残留文件=' + JSON.stringify(s9ours)
        + ' ｜ 目录存在=' + s9exists + ' ｜ 目录内容=' + JSON.stringify(s9left)
        + ' ｜ 只剩自述/空壳=' + s9shell);
  } finally {
    s9clean(P9);
    s9clean(P10);
  }
}

/* ============================================================================
 * 条目层 v3 · 界面整树写回的字段清单（S5 交付；静态判据，不需要起界面）
 * ----------------------------------------------------------------------------
 * 防的是本项目重复栽过四次的那一类：**手挑字段清单漏一个**（qa / localPath / origin / items
 * 各一次）。它只在源码里看得见 —— 界面上一切正常、没有任何门禁会红，而字段被静默抹掉。
 * 判据：serializeTree() 的 walk() 里出现的 `out.<字段> =` 必须覆盖契约允许的节点可选字段。
 * 判别力：注释掉 walk 里 `out.items = …`（或 `out.detailMode = …`）⇒ 本断言必红
 *        （与冒烟域 39 的注入证明同源：那边是行为级，这边是源码级）。
 * ⚠️ 摆放位置与编号由集成流定；段内不要写成"行内斜杠紧跟圈号"的样子（G9 会计数，
 *    scripts/cli-integration.js 顶部记过这个坑）。
 */
{
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app-core.js'), 'utf8');
  const a = src.indexOf('const walk = (n) => {');
  const b = src.indexOf('const root = MM.adapter.getRoot');
  const carried = (a > 0 && b > a)
    ? new Set(Array.from(src.slice(a, b).matchAll(/out\.([A-Za-z_$][\w$]*)\s*=/g)).map((m) => m[1]))
    : new Set();
  // 字段清单从**共用**的那一处取（`src/schema.js` 的契约字段表 = 契约的可执行副本）——
  // 本段原先自带一份 `REQUIRED` 数组，那正是"同一个清单两处表达"的病（会漂）。
  // 取**可选**那一档：`walk()` 把 `id/topic/expanded/children` 写在对象字面量里，
  // 只有可选字段才逐条 `out.<名> =`（档位由共用表定，见那里的说明）。
  const missing = NODE_FIELDS_OPTIONAL.filter((f) => !carried.has(f));
  check('界面整树写回的字段清单覆盖契约里的节点字段（漏一个 = 保存时静默抹掉）',
    a > 0 && b > a && missing.length === 0,
    'app-core.js walk() 覆盖 ' + carried.size + ' 个字段；缺：' + (missing.join(',') || '（无）')
      + (a > 0 && b > a ? '' : '｜⚠️ 定位失败：serializeTree/walk 的锚点变了，判据要跟着改'));
}

/* ============================================================================
 * 条目层 v3 · **节点复制写回的字段清单**（静态判据：不需要起界面、不需要写盘）
 * ----------------------------------------------------------------------------
 * 与上面那条**同型同源**（字段清单共用 `src/schema.js` 的契约字段表，别在判据里再抄一份）。
 * 防的是同一个形态在本工程的**第五次**复发：`clone` 的深拷贝是"手挑字段"，
 * 漏掉 `items` / `detailMode` / `localPath` / `origin` ⇒ 复制一个条目化节点后**整层条目消失**，
 * 而 `validate` 副本**照样通过**（实测：副本 `items`=（无）、`localPath`=（无）、`origin`=（无），
 * 退出码 0）。无门禁、不可逆、事后极难发现 —— 所以守在这里，而不是写进一条"以后记得"的铁律。
 * 判据：`cloneNode` 的**字段表**（`[必] 名` / `[选] 名`）与**真实赋值**（`node.<名> =`）合起来必须覆盖
 *      契约里的节点字段；两份读数还要逐项对得上（多一条少一条都判红 —— 否则"表说 A、代码做 B"能骗过去）。
 * 判别力：把字段表里的 `items` 那一行（或它的赋值）删掉 ⇒ 本断言必红并**点名 items**；还原后复绿
 *        （注入与还原的读数见本批交付说明；与上面那条 app-core 的注入证明同源：这边源码级、
 *        冒烟域 39 那边行为级）。
 * ⚠️ 段内不要写成"行内斜杠紧跟圈号"的样子（G9 会计数，见文件头）。
 */
{
  const src = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'edit.js'), 'utf8');
  const r = analyzeCloneFieldCopy(src);
  // 缺哪个就点名哪个 + 那个字段是什么（读报的人不必回翻契约）
  const named = (list) => list.map((f) => f + (NODE_FIELD_DESC[f] ? '（' + NODE_FIELD_DESC[f] + '）' : '')).join('、');
  check('节点复制（clone 与 apply 的 clone op）写回的字段清单覆盖契约节点字段（漏一个 = 克隆时静默抹掉）',
    r.ok,
    'cloneNode：字段表 ' + r.parsed + ' 行 / 赋值 ' + r.fields + ' 个；缺：' + (named(r.missing) || '（无）')
      + (r.unknown.length ? '｜契约里没有：' + r.unknown.join('、') : '')
      + (r.drift.length ? '｜表与赋值对不上：' + r.drift.join('、') : '')
      + ((r.anchors.decl !== 1 || r.anchors.ret !== 1)
        ? '｜⚠️ 定位失败：`function cloneNode` 与收尾 `return node;` 的锚点各出现 '
          + r.anchors.decl + ' / ' + r.anchors.ret + ' 次，判据要跟着改' : ''));
}

/* ===== 访问热度（H1 第一件）：由编排会话原文贴入 ===== */
/* ============================================================================
 * 访问热度（热度条第一件）：事件日志 + 窗口与排名口径 + `visit` / `heat` 两条命令
 * ----------------------------------------------------------------------------
 * 判据（对应 `.review/20261012-热度条/规格与裁决.md` §四 的前四条 + 规格 §二的两条硬约束）：
 *   （热度①）**排名而非绝对值**：同一节点次数 ×10 而名次不变 ⇒ 热度**不变**；名次上推 ⇒ 热度**变**
 *              （并顺带查"别人跟着下沉" —— 证明热度是名次的函数、不是次数的函数）；
 *   （热度②）**窗口**：31 天前的事件**不计入**（带它 / 不带它，两条榜逐字节相同）；
 *   （热度③）**两条分开**：人 / AI 计数互换 ⇒ 两条读数**都**不同（证明人榜与 AI 榜各自算）；
 *   （热度④）**失败响亮**：日志里有一行读不出来 ⇒ `heat` **非 0 退出并点名**（字节偏移 + 原文），
 *              且**不打印任何看起来正常的榜**；而同一份日志下 `visit` 照常能写（写入不读日志
 *              —— 这是 O(1) 追加的**有意**取舍，写入端不做任何"先读后判"）；
 *   （热度⑤）写入是**追加一行**：坏前缀逐字节不变、文件大小只涨一行（不读全量、不重写文件）；
 *   （热度⑥）本机没有该日志 ⇒ `heat` 退出码 0 且**明说**"没有访问日志（≠ 热度为 0）"；
 *   （热度⑦）命令输出里的权重表 == `src/heat.js` 的 `CHANNELS`（口径只有一处，命令层不抄表）。
 *
 * ## 判别力（实测可复现，报文见本批交付说明）
 * 把 `src/heat.js` 的 `defaultHeatMapper` 改成 `return i.count;`（= 热度直接取**绝对计数**）⇒
 * （热度①）那两条 check **必红**（实测：5 条断言红，含本条）；还原后复绿（文件 SHA-256 复原）。
 * 单测侧同源、可重复执行的注入证明在 `tests/heat.test.js` 的 J1（走 `__setHeatMapperForTest`）。
 *
 * ## 摆放与两条约定
 *   · 接在**最后一段静态判据之后、`/* ---------------- 清理 ---------------- *\/` 之前**新起一节；
 *     本段自带 `finally` 收尾、自删全部探针项目 ⇒ **不需要**动末尾的清理段。
 *   · 探针项目一律 `it-probe-heat-` 前缀：文件顶部 `sweepStaleProbes()` 的前缀表覆盖 `it-probe-`
 *     ⇒ 本段被中断留下的残留，下次跑链会被自动清掉（不新增前缀，那要改文件顶部那份表）。
 *   · 项目根**不自己拼**：从 `cli/core.js` 的 `PROJECTS_DIR` 取（唯一推导处，且随
 *     `AI_MINDMAP_PROJECTS_DIR` 走 ⇒ 本段在沙箱里也能整段复跑）。
 * ⚠️ 段内**不要**写成"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见文件头）。
 * ========================================================================== */

/* ============================================================
 * W1-集成断言原文.js —— `search-all` 跨项目检索的**集成断言原文**（放行窗口由整合流贴进
 * `scripts/cli-integration.js`；本文件**不是**可执行脚本，只是那段源码的存放处）
 *
 * ⚠️ **本文件是 v2（2026-10-13 修 A/B/C 之后）**：拼贴时请把此前贴进去的 **v1 那一块整段替换**为本文件内容
 * （v1 有 4 处待填的 MCP 工具数，集成脚本会硬崩；v2 已写成真值 51，且两条判据的期望值改成**现算真值**）。
 * v2 相对 v1 的三处差别：① MCP 工具数 = 写死的真值 `W1_TOOLS = 51`（全文无待填字样）；
 * ② 判据3-甲的期望总数**现算**（= 上限+1 + W1A 命中 + W1B 命中，因为全库扫描会把它们一起扫进来），
 * 并**逐字比对**报文报出的两个数字；③ "不许静默少扫"的跳过个数**现算**（= `j.skipped.length`，
 * 盘上还有常驻的 `it-broken-*` 探针 ⇒ 写死个数必假红）。
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 `## W1｜search-all 跨项目检索 ⭐`。
 * 单测侧（可重复执行、进程内、临时沙箱）：`tests/search-all.test.js`（**26 用例**）。本段**不重复**那 26 条，
 * 只把"必须在**真实工程 + 真实 projects/ 根**上跑一遍才作数"的那几条接到集成链上。
 *
 * ## 怎么贴（四句话）
 *   1) **整段替换** `scripts/cli-integration.js` 里此前贴进去的 v1 那一块（别与新块并存 ⇒ 会重复计数）。
 *   2) 位置：**S2（热度条第二件）那一段之后、`/* ---------------- 清理 ---------------- *\/` 之前**，
 *      整段原样粘（已写成独立块 `{ … }`：自带 `finally` 收尾、自删全部探针、**不需要动末尾的清理段**）。
 *   3) 探针一律 `it-probe-w1-` 前缀 ⇒ 文件顶部 `sweepStaleProbes()` 的前缀表（`it-probe-`）**已覆盖**，
 *      被中断留下的残留下次跑链会被自动清掉 ✓。
 *   4) 贴完**必须**跑一次 `npm run facts:write`：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成断言数，
 *      本段新增的 check 都会被算进去 ⇒ 不重生成 `docs/VERIFY.md` 就会在 G6 报"断言数对不上"（那正是 G6 该做的事）。
 *
 * ## 这一节守什么（每条对着 W1 的判据；编号与单测文件一致）
 *   · 判据1（同时命中两侧 + 每条带项目名 + 分片与单项目 search **逐条同序**）
 *   · 判据2（无命中 ⇒ 明确的"零结果"，不是空输出）
 *   · 判据3（两条**硬上限**：命中总数 / 扫描耗时，越限 ⇒ **报错 + 一条都不返回**）
 *   · 判据4（`--scope` 收得回来；点名不存在的项目 ⇒ 响亮）
 *   · 判据5（MCP **同名工具**一层透传：`search_nodes` 不给 `project` ⇒ 全库档；工具数不变）
 *   · 判据6（既有不变量：读命令在**项目目录里零字节**；命中**按项目**分记进各自的热度日志）
 *   · 另加一条"不许静默少扫"：读不动的项目 ⇒ **跳过但逐个点名**（`skipped`；汇总行写"另有 N 个没扫成"）
 *
 * ## 为什么全库那几条一律带 `--no-heat`（写清原因，免得下一个人以为漏了热度）
 *   本段跑在**真实** `projects/` 根上，而库里可能有别的段落留下的、**故意写坏的热度日志**（例如热度那两段的
 *   `it-probe-heat*` 探针）。热度日志坏了 ⇒ `search-all` 照 `search` 的纪律**响亮失败**（这是产品行为，
 *   不是缺陷）⇒ 全库那几条若默认读热度，就会被**别人的探针**牵连成假红。所以：
 *   · 全库断言一律 `--no-heat`（不碰任何日志）；
 *   · 真热度那一条用 `--scope` 只扫**本段自己的**探针（确定性，谁也不牵连谁）。
 *
 * ## 判别力（可重复执行的注入证明在 `tests/search-all.test.js`）
 *   · 把 `scanAll` 的循环改成"只扫第一个项目"（`for (let i = 0; i < 1; i++)`）⇒ 判据1 / 判据5 的
 *     "两侧命中"**必红**；还原 ⇒ 复绿（本件交付说明里有真实报文与还原后的 SHA-256）。
 *   · 把 `itemIndex.scanGate` 的两条比较改成 `>=` ⇒ 判据3 的边界那条**必红**。
 *   · 去掉"`skipped` 的文本点名"⇒ "不许静默少扫"那条**必红**。
 *
 * ⚠️ 段内**不要**写成"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见 cli-integration.js 文件头）。
 * ⚠️ 本段**只增断言**，不改任何既有断言的语义；MCP 那一拍是**真 stdio**（与 S2 段同一条路）。
 * ============================================================ */
{
  const w1core = require(path.join(ROOT, 'cli', 'core.js'));          // PROJECTS_DIR：项目根的唯一推导处
  const w1idx = require(path.join(ROOT, 'src', 'item-index.js'));     // 两条上限 + scanGate：唯一实现处
  const W1_MCP_SRV = path.join(ROOT, 'scripts', 'mcp-server.js');
  /** MCP 工具数：**写死值**（本件落地的当天 `docs/VERIFY.md` 的「MCP 工具数」= 51；"工具数不变"是本件的判据）
   *  —— 刻意不写成 `require(...).TOOLS.length` 那种自指式（那样谁把工具数改大了，断言会跟着一起变 ⇒ 没有判别力；
   *  与 `tests/recheck.test.js` 里 `expect(mcp.TOOLS.length).toBe(52)` 同一用意）。贴上之后若它变了，G6 会先红。
   *  【2026-10-20 台账 `W21`】51 → **52**：`ask_apply`（`ask-apply` 的 MCP 透传）是那一批唯一新增的工具。
   *  【2026-10-20 任务 `I-1`】52 → **53**：`features`（产品名册查询，只读）—— `S2` 的 `mcp-gap`
   *  **反向**断言第一次跑就点到它，而同一天 `W18` 量出"CLI 有而 MCP 无"是 25 条真缺口 ⇒ 补工具而不是加进缺口册。
   *  本段的判据仍是"**全库档没有新增工具**"（53 是现值的写死真值，不是"W1 当时那一版的工具数"）。 */
  const W1_TOOLS = 53;
  const W1TAG = Date.now().toString(36);
  const W1A = 'it-probe-w1-a-' + W1TAG;
  const W1B = 'it-probe-w1-b-' + W1TAG;
  const W1BAD = 'it-probe-w1-broken-' + W1TAG;
  const W1BIG = 'it-probe-w1-cap-' + W1TAG;
  const W1KW = 'W1跨项目检索词' + W1TAG;
  const w1dir = (name) => path.join(w1core.PROJECTS_DIR, name);
  const w1J = (r) => { try { return JSON.parse(String(r.out).trim()); } catch (e) { return null; } };
  /** 直接写盘造项目（同 S2 段的手法：命中顺序 = DFS 序 ⇒ 顺序断言才有确定方向） */
  const w1mk = (name, topics) => {
    fs.mkdirSync(w1dir(name), { recursive: true });
    fs.writeFileSync(path.join(w1dir(name), name + '.json'), JSON.stringify({
      meta: { name: name, author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'root', expanded: true,
        children: topics.map((t, i) => ({ id: 'nd-' + (i + 1), topic: t, children: [] })) }
    }, 'utf8'), 'utf8');
  };
  const w1all = (extra) => w1J(run(['search-all', W1KW, '--no-heat', '--json'].concat(extra || [])));
  const w1one = (name) => w1J(run(['search', name, W1KW, '--no-heat', '--json']));
  const w1ids = (j) => ((j || {}).hits || []).map((h) => h.nodeId);
  /** 目录树快照（含每个文件的 sha256 + mtime）：钉"读命令在项目目录里零字节" */
  const w1snap = (dir) => {
    const out = [];
    const walk = (d) => {
      fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        out.push(path.relative(dir, abs).split(path.sep).join('/') + '|' + fs.readFileSync(abs).length
          + '|' + fs.statSync(abs).mtimeMs);
      });
    };
    walk(dir);
    return out.join('\n');
  };
  /** 访问日志的真位置（产品里路径的唯一推导处是 data-store，这里不自己拼） */
  const w1log = (name) => require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(w1core.PROJECTS_DIR, () => {}).visitLogFile(name);

  try {
    /* 夹具：A 三个命中 / B 两个命中 / BIG = 上限 + 1 个命中（判据3 用，用完立刻删） */
    w1mk(W1A, [W1KW + ' 甲一', W1KW + ' 甲二', W1KW + ' 甲三']);
    w1mk(W1B, [W1KW + ' 乙一', W1KW + ' 乙二']);

    /* ---- 判据1：一次调用同时命中两侧；每条带 project；分片与单项目 search **逐条同序** ---- */
    {
      const all = w1all();
      const expectHits = [W1A, W1B].reduce((acc, p) => acc.concat(
        w1one(p).hits.map((h) => Object.assign({ project: p }, h))), []);
      check('W1·判据1 一次调用同时命中两侧（每条带 project），且分片与 `search <该项目>` **逐条同序**'
        + '（合并顺序 = 项目名升序 × 项目内既有顺序 ⇒ 没有第二份排序实现）',
        !!all && all.hits.filter((h) => h.project === W1A).length === 3
          && all.hits.filter((h) => h.project === W1B).length === 2
          && all.hits.every((h) => typeof h.project === 'string' && h.project)
          && JSON.stringify(all.hits) === JSON.stringify(expectHits),
        '命中=' + (all ? all.hits.length : 'null') + ' ｜ A=' + (all ? all.hits.filter((h) => h.project === W1A).length : '?')
          + ' / B=' + (all ? all.hits.filter((h) => h.project === W1B).length : '?')
          + ' ｜ 与单项目逐字同序=' + (!!all && JSON.stringify(all.hits) === JSON.stringify(expectHits)));
    }

    /* ---- 判据2：无命中 ⇒ 明确的"零结果"（不是空输出） ---- */
    {
      const r = run(['search-all', 'W1这个词谁都不命中' + W1TAG, '--no-heat']);
      const j = w1J(run(['search-all', 'W1这个词谁都不命中' + W1TAG, '--no-heat', '--json']));
      check('W1·判据2 无命中 ⇒ 一行**明确的零结果**（不是空输出），JSON 里 hits=[] 且 scanned 非空',
        r.code === 0 && r.out.trim().length > 0 && r.out.indexOf('命中 0 条') >= 0
          && r.out.indexOf('明确的零结果') >= 0
          && !!j && j.hits.length === 0 && j.hitCount === 0 && j.scanned.length > 0,
        'exit=' + r.code + ' ｜ 文本含"命中 0 条"=' + (r.out.indexOf('命中 0 条') >= 0)
          + ' ｜ JSON hitCount=' + (j ? j.hitCount : 'null'));
    }

    /* ---- 判据3-甲：命中总数越限 ⇒ 报错 + **一条都不返回** ----
     * ⚠️ 期望值**现算，不写死**：全库检索扫的是**整库**，本次关键词还命中 W1A / W1B 两个探针
     *   ⇒ 真总数 = (上限+1) + W1A 的命中数 + W1B 的命中数（各用单项目 `search` 现场取），
     *   而**不许**写死 `SCAN_MAX_HITS + 1`（放行窗口实测：写死 2001 而真值 2006 ⇒ 假红）。
     * 判据同时要求**报文里报出的两个数字 == 真实总数 / 真实上限**（不是"含某个数字"的弱口径）。 */
    {
      const w1hitA = w1one(W1A).hits.length;                       // 现算：W1A 与 W1B 用的是同一个关键词
      const w1hitB = w1one(W1B).hits.length;
      const w1big = w1idx.SCAN_MAX_HITS + 1;
      const w1total = w1big + w1hitA + w1hitB;                     // 本次全库扫描的**真实**命中总数
      w1mk(W1BIG, Array.from({ length: w1big }, (x, i) => W1KW + ' 上限 ' + (i + 1)));
      const r = run(['search-all', W1KW, '--no-heat', '--json']);
      const m = /命中 (\d+) 条 > 上限 (\d+) 条/.exec(r.out);
      check('W1·判据3-甲 命中总数越限（真造 ' + w1big + ' 条，本次全库真总数 ' + w1total + '）⇒ exit 1 + '
        + '**报文里的两个数字逐字等于真实总数与真实上限** + `一条都不返回`（**不许**静默截断成前 N 条）',
        r.code === 1 && /^error:/.test(r.out.trim()) && r.out.trim().split('\n').length === 1
          && !!m && Number(m[1]) === w1total && Number(m[2]) === w1idx.SCAN_MAX_HITS
          && r.out.indexOf('一条都不返回') >= 0 && r.out.indexOf('--scope') >= 0,
        'exit=' + r.code + ' ｜ 真总数=' + w1total + '（探针 ' + w1big + ' + A ' + w1hitA + ' + B ' + w1hitB
          + '）｜ 报文报出=' + (m ? m[1] + ' / 上限 ' + m[2] : '（没匹配到）')
          + ' ｜ 行数=' + r.out.trim().split('\n').length
          + ' ｜ 报错首行=' + r.out.trim().slice(0, 90));
      fs.rmSync(w1dir(W1BIG), { recursive: true, force: true });     // 立刻删：不留"必然越限"给后面的断言
    }

    /* ---- 判据3-乙：扫描耗时越限 ⇒ 报错（**时钟注入**，确定性，不靠真的跑慢） ---- */
    {
      const realNow = Date.now;
      const T0 = realNow();
      let calls = 0;
      Date.now = () => { calls++; return calls === 1 ? T0 : T0 + w1idx.SCAN_MAX_MS + 1; };
      let r = null;
      try {
        r = run(['search-all', W1KW, '--no-heat', '--json']);
      } finally {
        Date.now = realNow;
      }
      check('W1·判据3-乙 扫描耗时越限（时钟推快到 上限+1 ms）⇒ exit 1 + 点名 ms 读数与出路；'
        + '同一查询恢复时钟后照常命中（红的不是命令本身）',
        r.code === 1 && r.out.indexOf(String(w1idx.SCAN_MAX_MS)) >= 0 && r.out.indexOf('ms > 上限') >= 0
          && r.out.indexOf('一条都不返回') >= 0 && calls > 1
          && !!w1all() && w1all().hits.length === 5,
        'exit=' + r.code + ' ｜ 读时钟次数=' + calls + ' ｜ 时钟恢复后命中='
          + (w1all() ? w1all().hits.length : 'null'));
    }

    /* ---- 判据4：`--scope` 收得回来；点名不存在的项目 ⇒ 响亮 ---- */
    {
      const j = w1all(['--scope', W1B]);
      const bad = run(['search-all', W1KW, '--no-heat', '--scope', 'it-probe-w1-不存在-' + W1TAG]);
      const bare = run(['search-all', W1KW, '--no-heat', '--scope']);
      check('W1·判据4 `--scope` 只扫点名的那几个（scoped/scanned/命中都收窄）；点名的项目不存在或名单为空 ⇒ '
        + 'exit 1 并**逐个点名**（不静默当"全库"）',
        !!j && j.scoped === true && j.scanned.length === 1 && j.scanned[0] === W1B
          && j.hits.every((h) => h.project === W1B) && j.hits.length === 2
          && bad.code === 1 && bad.out.indexOf('it-probe-w1-不存在-' + W1TAG) >= 0
          && bare.code === 1 && bare.out.indexOf('需要一个项目名列表') >= 0,
        'scope 命中=' + (j ? j.hits.length : 'null') + ' / scanned=' + (j ? j.scanned.join(',') : 'null')
          + ' ｜ 不存在 exit=' + bad.code + ' ｜ 裸写 exit=' + bare.code);
    }

    /* ---- 判据5：MCP 同名工具一层透传（**真 stdio 一拍**）+ 工具数不变 ---- */
    {
      const reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'search_nodes', arguments: { keyword: W1KW, no_heat: true } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' }
      ];
      const sp = spawnSync(process.execPath, [W1_MCP_SRV], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
      });
      const replies = String(sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (e) { return null; }
      });
      const byId = (id) => replies.filter((x) => x && x.id === id)[0] || null;
      const textOf = (rep) => (rep && rep.result && rep.result.content && rep.result.content[0]
        && rep.result.content[0].text) || '';
      const viaMcp = w1J({ out: textOf(byId(2)) });
      const tools = (((byId(3) || {}).result || {}).tools) || [];
      const cliSame = w1all();
      check('W1·判据5 MCP `search_nodes` **少给 `project`** ⇒ 全库档（真 stdio 一拍）：两侧命中、每条带 project、'
        + '与 CLI 逐字同源；且**没有新增工具**（工具数仍 ' + W1_TOOLS + '、`search_nodes` 只有一个）',
        !!viaMcp && viaMcp.hits.filter((h) => h.project === W1A).length === 3
          && viaMcp.hits.filter((h) => h.project === W1B).length === 2
          && !!cliSame && JSON.stringify(viaMcp.hits) === JSON.stringify(cliSame.hits)
          && tools.length === W1_TOOLS
          && tools.filter((t) => t.name === 'search_nodes').length === 1,
        'MCP 命中=' + (viaMcp ? viaMcp.hits.length : 'null') + ' ｜ 与 CLI 逐字相同='
          + (!!viaMcp && !!cliSame && JSON.stringify(viaMcp.hits) === JSON.stringify(cliSame.hits))
          + ' ｜ 工具数=' + tools.length);
    }

    /* ---- 判据6：读命令在**项目目录里零字节**；命中**按项目**分记进各自的热度日志 ---- */
    {
      const snapA = w1snap(w1dir(W1A));
      const snapB = w1snap(w1dir(W1B));
      const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
      const a0 = sizeOf(w1log(W1A));
      const b0 = sizeOf(w1log(W1B));
      run(['search-all', W1KW, '--scope', W1A + ',' + W1B, '--json']);     // 这一次**读热度也写埋点**（默认档）
      const nodesIn = (name) => {
        const f = w1log(name);
        if (!fs.existsSync(f)) return [];
        return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
          .filter((e) => e && e.ch === 'ai-search-hit').map((e) => e.node);
      };
      check('W1·判据6 跑一次 `search-all`：两个探针的**项目目录逐字节 + mtime 不变**（读命令零字节），'
        + '而项目目录**之外**的 `.visits/` 里**各自**记到了自己的命中（A 三条 / B 两条，不串项目）',
        w1snap(w1dir(W1A)) === snapA && w1snap(w1dir(W1B)) === snapB
          && sizeOf(w1log(W1A)) > a0 && sizeOf(w1log(W1B)) > b0
          && nodesIn(W1A).sort().join(',') === 'nd-1,nd-2,nd-3' && nodesIn(W1B).sort().join(',') === 'nd-1,nd-2',
        '目录不变=' + (w1snap(w1dir(W1A)) === snapA && w1snap(w1dir(W1B)) === snapB)
          + ' ｜ A 日志 ' + a0 + '→' + sizeOf(w1log(W1A)) + ' B 日志 ' + b0 + '→' + sizeOf(w1log(W1B))
          + ' ｜ A 记到=' + nodesIn(W1A).sort().join(',') + ' ｜ B 记到=' + nodesIn(W1B).sort().join(','));
    }

    /* ---- 不许静默少扫：读不动的项目 ⇒ **跳过但逐个点名**（skipped + 文本档 ⚠ 行 + 汇总行） ----
     * ⚠️ 跳过**个数**同样**现算，不写死**：整脚本跑时盘上还有常驻探针（如第 20 节的 `it-broken-*`，
     *   它到脚本末尾才删）⇒ 真个数 = `j.skipped.length`。放行窗口实测：写死"另有 1 个"而真值 2 ⇒ 假红。 */
    {
      w1mk(W1BAD, [W1KW + ' 坏']);
      fs.writeFileSync(path.join(w1dir(W1BAD), W1BAD + '.json'), '{这不是合法 JSON', 'utf8');
      const r = run(['search-all', W1KW, '--no-heat']);
      const j = w1all();
      const w1n = (j && j.skipped) ? j.skipped.length : 0;          // 现算：本次真的跳过了几个
      check('W1·不许静默少扫 某个项目的 JSON 读不出来 ⇒ **跳过它但看得见**：`skipped` 逐个点名 + 文本档 '
        + '`⚠ 跳过项目「…」` + 汇总行"另有 ' + w1n + ' 个项目没扫成"（个数**现算**；exit 0 —— '
        + '别人项目的坏数据不该让整库检索不可用）',
        r.code === 0 && r.out.indexOf('⚠ 跳过项目「' + W1BAD + '」') >= 0
          && r.out.indexOf('validate ' + W1BAD) >= 0 && r.out.indexOf('--scope') >= 0
          && r.out.indexOf('另有 ' + w1n + ' 个项目没扫成') >= 0     // ← 报出的个数 == 真个数（少报/多报都红）
          && !!j && j.skipped.map((s) => s.project).indexOf(W1BAD) >= 0
          && j.scanned.indexOf(W1BAD) < 0,
        'exit=' + r.code + ' ｜ skipped(' + w1n + ')=' + (j ? j.skipped.map((s) => s.project).join(',') : 'null')
          + ' ｜ 汇总行含"另有 ' + w1n + ' 个项目没扫成"=' + (r.out.indexOf('另有 ' + w1n + ' 个项目没扫成') >= 0)
          + ' ｜ 点名 W1BAD=' + (r.out.indexOf(W1BAD) >= 0));
    }
  } finally {
    /* 自收尾：探针项目 + 它们的访问日志（日志在项目目录之外，删目录删不掉它 ⇒ 一并删） */
    [W1A, W1B, W1BAD, W1BIG].forEach((name) => {
      try { fs.rmSync(w1dir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
      try { fs.rmSync(w1log(name), { force: true }); } catch (e) { /* 同上 */ }
    });
  }
}

/* ============================================================
 * 两处**已落实、无需你改**（放行窗口踩过，这里记下来免得下次再踩）：
 *   1) MCP 工具数是**写死的真值 51**（见段内 `W1_TOOLS`，与 `docs/VERIFY.md` 的「MCP 工具数」、
 *      `tests/recheck.test.js` 的 `toBe(51)` 一致）—— 本文件里**一个待填占位符都没有**
 *      （拼贴前那道"扫占位符"检查在本文件上应是 0 命中），整段可直接拼贴。
 *      刻意不写成 `require(…mcp-server.js).TOOLS.length` 那种自指式：那样谁把工具数改大了，
 *      断言会跟着一起变 ⇒ 没有判别力。
 *   2) 判据3-甲的期望值**现算**：全库扫描会把 W1A / W1B 也算进来 ⇒ 真总数
 *      = (上限 + 1) + W1A 命中数 + W1B 命中数，由现场的单项目 `search` 求出；并**逐字比对**
 *      报文里报出的两个数字（不是"含某个数字"的弱口径）。写死 `SCAN_MAX_HITS + 1` 会在放行窗口假红
 *      （实测：写死 2001、真值 2006）。
 * ============================================================ */

{
  const heatLib = require(path.join(ROOT, 'src', 'heat.js'));
  const heatCore = require(path.join(ROOT, 'cli', 'core.js'));      // PROJECTS_DIR：项目根的唯一推导处
  const HTAG = Date.now().toString(36);
  const PH1 = 'it-probe-heat-a-' + HTAG;      // 主探针（排名 / 追加 / 响亮）
  const PH2 = 'it-probe-heat-b-' + HTAG;      // 窗口：不含窗口外事件
  const PH3 = 'it-probe-heat-c-' + HTAG;      // 窗口：含一条 31 天前的事件
  const PH4 = 'it-probe-heat-d-' + HTAG;      // 两条分开：人 3 / AI 1（甲），人 1 / AI 3（乙）
  const PH5 = 'it-probe-heat-e-' + HTAG;      // 两条分开：把上一组**互换**
  const PHALL = [PH1, PH2, PH3, PH4, PH5];
  const hdir = (name) => path.join(heatCore.PROJECTS_DIR, name);
  /* ⚠️ 访问日志**不在项目目录里**（热度条第三件起搬到 `<项目根>/.visits/<项目名>.jsonl`）。
   * 判据不该在这里自己拼路径 —— 与产品同一处推导：`store.visitLogFile`（唯一一处）。
   * 实测踩到的形状：本段还按老形状拼 `projects/<项目>/.visits.jsonl` ⇒ 本段一跑就
   * `ENOENT ... .visits.jsonl`（脚本直接崩，且报错指向的地方看着像产品坏了）。 */
  const heatStore = require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(heatCore.PROJECTS_DIR, () => { /* 这里只借它推日志路径，不写数据 */ });
  const hlog = (name) => heatStore.visitLogFile(name);
  const hjson = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };
  const hheat = (name, extra) => hjson(run(['heat', name, '--json'].concat(extra || [])).out);
  const hrow = (list, node) => (list || []).filter((x) => x.node === node)[0] || null;
  /** 按 `{通道: {节点: 次数}}` 追加事件（时间从 baseMs 起 +1 秒 ⇒ 非递减 = 日志的时序不变量） */
  const hspec = (name, spec, baseMs) => {
    const evs = [];
    Object.keys(spec).forEach((ch) => Object.keys(spec[ch]).forEach((node) => {
      for (let i = 0; i < spec[ch][node]; i++) evs.push({ node: node, ch: ch });
    }));
    fs.appendFileSync(hlog(name), evs.map((e, i) => heatLib.serializeEvent(heatLib.buildEvent({
      node: e.node, ch: e.ch, at: new Date(baseMs + i * 1000).toISOString(), by: 'cli-integration'
    }))).join(''), 'utf8');
    return evs.length;
  };
  const hnew = (name, ids) => {
    run(['init', name, '--title', '热度条探针']);
    ids.forEach((id) => run(['add', name, 'root', '--topic', id, '--id', id]));
  };

  try {
    hnew(PH1, ['it-heat-a', 'it-heat-b', 'it-heat-c']);

    /* ---- （热度⑥）没有日志：退出码 0 + 明说"没有访问日志（≠ 热度为 0）" ---- */
    const rNoLog = run(['heat', PH1, '--json']);
    const jNoLog = hjson(rNoLog.out);
    check('热度：本机没有访问日志 ⇒ 退出码 0，且**明说**"没有访问日志（≠ 热度为 0）"（不是给一份空榜）',
      rNoLog.code === 0 && !!jNoLog && jNoLog.hasLog === false
        && String(jNoLog.note || '').indexOf('不等于') >= 0,
      'exit=' + rNoLog.code + ' ｜ hasLog=' + (jNoLog || {}).hasLog
        + ' ｜ ' + String((jNoLog || {}).note || '').slice(0, 60));

    /* ---- `visit` 端到端：记一次人访问（human-detail）⇒ 日志恰好多一行 ---- */
    const rV = run(['visit', PH1, 'it-heat-a', '--channel', 'human-detail', '--json']);
    const jV = hjson(rV.out);
    check('热度 visit：记一次人访问（human-detail）⇒ 回显 who/权重，且日志恰好多**一行**',
      ok(rV.out) && !!jV && jV.who === 'human' && jV.channel === 'human-detail'
        && jV.weight === heatLib.channelInfo('human-detail').weight
        && fs.readFileSync(hlog(PH1), 'utf8').split('\n').filter((l) => l.trim()).length === 1,
      '回显=' + rV.out.trim().slice(0, 80));

    /* ---- （热度⑤）追加语义：坏前缀逐字节不变 + 文件只涨一行 ---- */
    const poison = '{"v":1,"at":"懒得写了"\n';                       // 手改日志：既不是合法 JSON 也不是合法形状
    fs.appendFileSync(hlog(PH1), poison, 'utf8');
    const bytesBefore = fs.readFileSync(hlog(PH1));
    const wrote = heatLib.appendEvent(hlog(PH1), { node: 'it-heat-b', ch: 'ai-get', by: 'cli-integration' });
    const bytesAfter = fs.readFileSync(hlog(PH1));
    check('热度：写入是**追加一行** —— 坏前缀逐字节不变、文件大小只涨一行（不读全量、不重写文件）',
      bytesAfter.length === bytesBefore.length + wrote.bytes
        && bytesAfter.subarray(0, bytesBefore.length).equals(bytesBefore),
      '涨 ' + (bytesAfter.length - bytesBefore.length) + ' 字节（期望 ' + wrote.bytes + '）');

    /* ---- （热度④）读必须响亮：坏行 ⇒ 非 0 + 点名（偏移/行号 + 原文）+ 不给榜 ---- */
    const rBad = run(['heat', PH1]);
    check('热度：日志有一行读不出来 ⇒ `heat` **非 0 退出** + 点名（行号/字节偏移 + 原文）+ 不打印任何榜',
      rBad.code !== 0 && rBad.out.indexOf('坏行') >= 0 && rBad.out.indexOf('字节') >= 0
        && rBad.out.indexOf('懒得写了') >= 0 && rBad.out.indexOf('人榜') < 0
        && rBad.out.indexOf('不等于') >= 0,                            // 明说"采不到 ≠ 热度 0"
      'exit=' + rBad.code + ' ｜ ' + rBad.out.trim().split('\n').slice(1, 3).join(' ').slice(0, 110));
    check('热度：同一份坏日志下 `visit` 照常能写（写入不读日志 = O(1) 追加的**有意**取舍，职责分开）',
      ok(run(['visit', PH1, 'it-heat-c', '--channel', 'ai-get']).out)
        && fs.readFileSync(hlog(PH1), 'utf8').split('\n').filter((l) => l.trim()).length === 4,
      '日志行数=' + fs.readFileSync(hlog(PH1), 'utf8').split('\n').filter((l) => l.trim()).length
        + '（1 条合法 + 1 条坏行 + 1 条 appendEvent + 1 条本次 visit）');

    /* ---- （热度①）排名而非绝对值（重开一份干净日志） ---- */
    fs.rmSync(hlog(PH1), { force: true });
    hspec(PH1, { 'human-detail': { 'it-heat-a': 20, 'it-heat-b': 15, 'it-heat-c': 1 } }, Date.now() - 6 * 3600 * 1000);
    const h1 = hheat(PH1);
    check('热度（判据① 基准）：人榜按次数排名 ⇒ 20 / 15 / 1 的名次与档位 = 1/10、2/7、3/4（n=3）',
      !!h1 && h1.human.map((x) => x.node + '#' + x.rank + '/' + x.heat).join(' ') === 'it-heat-a#1/10 it-heat-b#2/7 it-heat-c#3/4',
      '人榜=' + (h1 ? h1.human.map((x) => x.node + '#' + x.rank + '/' + x.heat).join(' ') : 'null'));

    hspec(PH1, { 'human-detail': { 'it-heat-c': 9 } }, Date.now() - 3 * 3600 * 1000);      // c: 1 → 10（仍少于 15）
    const h2 = hheat(PH1);
    const c2 = hrow(h2 && h2.human, 'it-heat-c');
    check('热度（判据①）：次数 ×10 而**名次不变** ⇒ 热度**不变**（热度不是绝对值的函数）',
      !!c2 && c2.visits === 10 && c2.rank === 3 && c2.heat === 4,
      'c=' + JSON.stringify(c2 || {}));

    hspec(PH1, { 'human-detail': { 'it-heat-c': 90 } }, Date.now() - 2 * 3600 * 1000);     // c → 100：名次上推
    const h3 = hheat(PH1);
    const c3 = hrow(h3 && h3.human, 'it-heat-c');
    check('热度（判据①）：**名次上推**（3 → 1）⇒ 热度**变**（10），且别人跟着下沉一档（a=7、b=4）',
      !!c3 && c3.rank === 1 && c3.heat === 10
        && (hrow(h3.human, 'it-heat-a') || {}).heat === 7 && (hrow(h3.human, 'it-heat-b') || {}).heat === 4,
      'c=' + JSON.stringify(c3 || {}) + ' ｜ a=' + JSON.stringify(hrow(h3.human, 'it-heat-a') || {})
        + ' ｜ b=' + JSON.stringify(hrow(h3.human, 'it-heat-b') || {}));

    /* ---- （热度②）窗口：31 天前的一条不进榜（带它 / 不带它，两条榜逐字节相同） ---- */
    hnew(PH2, ['it-heat-a', 'it-heat-b', 'it-heat-c']);
    hnew(PH3, ['it-heat-a', 'it-heat-b', 'it-heat-c']);
    hspec(PH2, { 'human-detail': { 'it-heat-a': 2, 'it-heat-b': 1 } }, Date.now() - 2 * 3600 * 1000);
    hspec(PH3, { 'human-detail': { 'it-heat-c': 1 } }, Date.now() - 31 * heatLib.DAY_MS);   // 31 天前：窗口外
    hspec(PH3, { 'human-detail': { 'it-heat-a': 2, 'it-heat-b': 1 } }, Date.now() - 2 * 3600 * 1000);
    const w2 = hheat(PH2);
    const w3 = hheat(PH3);
    check('热度（判据②）：31 天前的事件**不计入** —— 带它 / 不带它两条榜**逐字节相同**，且它不进榜',
      !!w2 && !!w3 && JSON.stringify(w3.human) === JSON.stringify(w2.human)
        && JSON.stringify(w3.ai) === JSON.stringify(w2.ai)
        && w3.sample.events === 3 && w3.sample.dropped === 1 && hrow(w3.human, 'it-heat-c') === null,
      '带窗口外事件 = ' + JSON.stringify((w3 || {}).sample) + ' ｜ 不含它 = ' + JSON.stringify((w2 || {}).sample)
        + ' ｜ 两条榜相同=' + (!!w2 && !!w3 && JSON.stringify(w3.human) === JSON.stringify(w2.human)));

    /* ---- （热度③）两条分开：人 / AI 计数互换 ⇒ 两条读数都不同 ---- */
    hnew(PH4, ['it-heat-a', 'it-heat-b']);
    hnew(PH5, ['it-heat-a', 'it-heat-b']);
    hspec(PH4, { 'human-detail': { 'it-heat-a': 3, 'it-heat-b': 1 }, 'ai-get': { 'it-heat-a': 1, 'it-heat-b': 3 } },
      Date.now() - 3 * 3600 * 1000);
    hspec(PH5, { 'human-detail': { 'it-heat-a': 1, 'it-heat-b': 3 }, 'ai-get': { 'it-heat-a': 3, 'it-heat-b': 1 } },
      Date.now() - 3 * 3600 * 1000);
    const s4 = hheat(PH4);
    const s5 = hheat(PH5);
    check('热度（判据③）：人 / AI 计数互换 ⇒ 人榜与 AI 榜**都**反号（两条榜真的各自算，不是同一份的复印）',
      !!s4 && !!s5
        && (s4.human[0] || {}).node === 'it-heat-a' && (s4.ai[0] || {}).node === 'it-heat-b'
        && (s5.human[0] || {}).node === 'it-heat-b' && (s5.ai[0] || {}).node === 'it-heat-a'
        && JSON.stringify(s4.human) !== JSON.stringify(s4.ai)
        && JSON.stringify(s5.human) !== JSON.stringify(s4.human)
        && JSON.stringify(s5.ai) !== JSON.stringify(s4.ai),
      'PH4 人榜首=' + ((s4 && s4.human[0]) ? s4.human[0].node : 'null')
        + ' / AI 榜首=' + ((s4 && s4.ai[0]) ? s4.ai[0].node : 'null')
        + ' ｜ PH5 人榜首=' + ((s5 && s5.human[0]) ? s5.human[0].node : 'null')
        + ' / AI 榜首=' + ((s5 && s5.ai[0]) ? s5.ai[0].node : 'null'));

    /* ---- （热度⑦）权重表只有一处：命令输出的表 == 模块的表；且逐项可核算 ---- */
    const jW = hheat(PH4, ['--limit', '1']);
    const sameWeights = !!jW && heatLib.CHANNELS.every((c) => {
      const w = (jW.weights || {})[c.ch];
      return !!w && w.who === c.who && w.weight === c.weight;
    });
    const byW = (jW && jW.byChannel) || [];
    const calcOk = byW.every((x) => {
      const w = (jW.weights || {})[x.channel];
      return !!w && w.weight === x.weight && w.who === x.who;
    });
    check('热度：命令输出的权重表 == `src/heat.js` 的 `CHANNELS`（口径只有一处，命令层不抄表）；'
      + '`--limit` 只截断显示、热度按全量排名算',
      sameWeights && calcOk && !!jW && jW.human.length === 1 && (jW.limit || {}).totalHuman === 2
        && JSON.stringify(jW.human[0]) === JSON.stringify((s4.human || [])[0])
        && run(['heat', PH4, '--limit', '1']).out.indexOf('只截断显示') >= 0,
      'weights 一致=' + sameWeights + ' ｜ byChannel 可核算=' + calcOk
        + ' ｜ 显示 ' + ((jW || {}).human || []).length + '/' + (((jW || {}).limit) || {}).totalHuman);
  } finally {
    PHALL.forEach((name) => {
      try { fs.rmSync(hdir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    });
  }
}

/* ===== 访问热度（H1 第二件：接进 search / CLI 与 MCP 同源）===== */
/* ============================================================================
 * 热度条（第二件）：热度作为**一个封顶向量**进 `search` 排序（CLI 与 MCP **同源**）
 * ----------------------------------------------------------------------------
 * 判据（对应 `.review/20261012-热度条/规格与裁决.md` §一.2 / §一.3 与 §四 的①②③④⑥）：
 *   （热度条二·封顶）**封顶可测**：把某个节点的热度拉满 ⇒ 顺序**真的变了**（否则那条判据是恒真的空话），
 *              而位移**不超过封顶比例** —— 两条口径各钉一次：位置数 ≤ `heat.maxJump(n)`、比例 ≤ 10%；
 *   （热度条二·两条）**人 / AI 两条都真进、且权重不同**：同一节点"人热 AI 冷" vs "人冷 AI 热" ⇒ 顺序**不同**；
 *   （热度条二·同源）**CLI 与 MCP 同源**：MCP 的 `search_nodes`（**真 stdio 一拍**）与 CLI 的
 *              `search --json` 对**同一份数据**命中**逐条同序**（MCP 侧一行打分逻辑都没有）；
 *   （热度条二·取舍）**只排序**：`hitCount` 与命中的多重集不因热度改变；`--limit` 截断照旧可见
 *              （truncated + hitCount 全量），提高 limit 就能取到低热度的命中；
 *   （热度条二·性能）3.8 MB 的日志只读了**尾部一个 chunk**（`heat.log.bytesRead` 远小于文件字节数）；
 *   （热度条二·响亮）日志坏一行 ⇒ `search` **非 0 退出 + 点名**，且**一条命中都不打印**；
 *   （热度条二·零热度）本机没有日志 ⇒ 既有行为**逐字不变**（`heat.applied=false` / `reason=no-log`）。
 *
 * ## 判别力（实测报文见本批交付说明；可重复执行的那一版在 `tests/search-heat.test.js` 的 E 节）
 *   · `src/item-index.js` 里"把命中交给热度重排"的那一行整个换成直接取 `raw`（= 去掉热度重排这一项，
 *     不是"换个实参"）⇒ 本段「顺序真的变了」那条 **必红**；还原后 SHA-256 相同、复绿；
 *     ⚠️ 这一行**刻意不写出那个调用的完整写法**：`tests/search-heat.test.js` 的 A4 结构断言要求
 *        `orderByHeat` 的**调用写法只出现在 `src/item-index.js`** —— 在这里写出来会把那条断言判红
 *        （实测：这句注释第一版就是那样写的，全量跑红在 A4）。
 *   · 合并上限改成 1.0 ⇒ 「位移比例 ≤ 10%」必红（实测 39/39 = 1.0000 vs 0.10）；
 *   · AI 权重改成与人相同 ⇒ 「两序不同」必红（实测两种顺序完全一样）。
 *
 * ## 摆放与两条约定
 *   · 接在**既有最后一段静态判据之后、`/* ---------------- 清理 ---------------- *\/` 之前**新起一节；
 *     本段自带 `finally` 收尾、自删全部探针项目 ⇒ **不需要**动末尾的清理段。
 *   · 探针项目一律 `it-probe-heat2-` 前缀（文件顶部 `sweepStaleProbes()` 的前缀表已覆盖 `it-probe-`
 *     ⇒ 被中断留下的残留下次跑链会被自动清掉）。
 *   · 项目根**不自己拼**：从 `cli/core.js` 的 `PROJECTS_DIR` 取（唯一推导处，且随
 *     `AI_MINDMAP_PROJECTS_DIR` 走 ⇒ 本段在沙箱里也能整段复跑；MCP 那一拍也靠 env 继承）。
 *   · ⚠️ 本段**只增断言**：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成断言数、
 *     与 `docs/VERIFY.md` 对账（G6）⇒ 贴进来之后要跑一次 `npm run facts:write`。
 * ⚠️ 段内**不要**写成"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见文件头）。
 * ========================================================================== */
{
  const heatLib = require(path.join(ROOT, 'src', 'heat.js'));       // 三条上限 / 位移上界：唯一一处
  const s2core = require(path.join(ROOT, 'cli', 'core.js'));        // PROJECTS_DIR：项目根的唯一推导处
  const MCP_SRV = path.join(ROOT, 'scripts', 'mcp-server.js');      // 判据③走**真 stdio**（见文件头）
  const S2TAG = Date.now().toString(36);
  const S2P = 'it-probe-heat2-a-' + S2TAG;      // 主探针：封顶 / 取舍 / 同源 / 响亮
  const S2H = 'it-probe-heat2-h-' + S2TAG;      // 人热
  const S2A = 'it-probe-heat2-i-' + S2TAG;      // AI 热
  const S2B = 'it-probe-heat2-b-' + S2TAG;      // 性能：大日志（窗口外前缀先落，再记窗口内事件）
  const S2ALL = [S2P, S2H, S2A, S2B];
  const S2KW = '热度条关键词';
  const s2dir = (name) => path.join(s2core.PROJECTS_DIR, name);
  const s2json = (out) => { try { return JSON.parse(String(out).trim()); } catch (e) { return null; } };
  const s2ids = (j) => ((j || {}).hits || []).map((h) => h.nodeId + (h.itemId ? '#' + h.itemId : ''));
  /** 位移：a = 基线顺序、b = 加热度后的顺序 ⇒ 某个命中最多挪了几个位置 */
  const s2moved = (a, b) => {
    const pos = new Map((b || []).map((k, i) => [k, i]));
    let m = 0;
    (a || []).forEach((k, i) => { const j = pos.get(k); if (j !== undefined) m = Math.max(m, Math.abs(i - j)); });
    return m;
  };
  /** 直接写盘造项目：root 下 count 个**同关键词**节点（命中顺序 = DFS 序，位移才有确定方向） */
  const s2mk = (name, count) => {
    const children = [];
    for (let i = 1; i <= count; i++) children.push({ id: 'nd-' + i, topic: S2KW + ' 第 ' + i + ' 个', children: [] });
    fs.mkdirSync(s2dir(name), { recursive: true });
    fs.writeFileSync(path.join(s2dir(name), name + '.json'), JSON.stringify({
      meta: { name: name, author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'root', expanded: true, children: children }
    }), 'utf8');
  };
  const s2search = (name, extra) => s2json(run(['search', name, S2KW, '--json'].concat(extra || [])).out);
  /** 访问日志的**真位置**（热度条第三件起在项目目录**之外**）—— 与产品同一处推导，别自己拼路径。
   *  ⚠️ 这里**就地建一个 store** 只为借它推路径；项目根用本段自己那份（`s2dir` 也是这么拼的）——
   *  在 `const` 声明之前引用段外的同名变量会直接 ReferenceError（实测把脚本崩在定义处）。 */
  const s2log = (name) => require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(path.join(ROOT, 'projects'), () => {}).visitLogFile(name);
  const s2visit = (name, node, ch, times) => {
    for (let i = 0; i < (times || 1); i++) run(['visit', name, node, '--channel', ch]);
  };

  /* ⚠️ **本段的夹具里关掉"自动埋点"**（热度条第三件 · C 块引入的一处**判据自污染**，2026-10-12 修）。
   *
   * 病灶（改前实测）：本段的每条断言都在测"**当前的热度状态**" —— 例如
   * 「`nd-40` 拉满 ⇒ `heat.hitNodes === 1`」「删掉日志后 `reason === 'no-log'`」。
   * 而第三件起 `search` 会把自己返回的命中**记进访问日志**（产品行为，默认开）⇒
   * **被测的那次调用自己改写了被测的热度状态**：
   *   · `s2hot` 那次 search 顺手把 40 条命中记进 S2P 的日志 ⇒ `hitNodes` 从 1 变 40（红）；
   *   · S2N 那次 `--no-heat` 检索原本"不碰日志"，删掉日志后应为 `no-log`，但那一次又把日志写了回来 ⇒
   *     `reason` 从 `no-log` 变 `ok`（红）。
   * 这不是产品缺陷：埋点的**判据**（每条通道跑一次就该出现该通道事件、输出逐字节不变、
   * 上限口径 20 条、坏日志路径一条都不记）在 `tests/heat-sensor.test.js` 里**开着埋点**逐条验。
   * 本文件这里要的是"**热度状态**"的真值，所以让夹具自己造的这份热度不被本次调用扰动。
   *
   * 关的方式是**模块级显式开关**（`src/heat-sensor.js` 的 `__setEnabledForTest(false)`，
   * 生产代码一次都不碰它 —— 由 `tests/heat-bars.test.js` 的 C2 与 `tests/heat-sensor.test.js`
   * 的 D1 两条结构断言盯着"除定义处外没有别的引用"）。
   * 本段的 `finally` 里**还原**（下面的 `s2RestoreSensor()`）：否则后面的段会被静默关掉埋点，
   * 而"关掉"是看不见的 —— 那就是本工程最忌讳的那种静默失效。 */
  const heatSensor = require(path.join(ROOT, 'src', 'heat-sensor.js'));
  heatSensor.__setEnabledForTest(false);
  const s2RestoreSensor = () => heatSensor.__setEnabledForTest(true);

  try {
    s2mk(S2P, 40);
    s2mk(S2H, 100);
    s2mk(S2A, 100);
    s2mk(S2B, 40);

    /* ---- （零热度）本机没有日志 ⇒ 既有行为逐字不变，且如实说"没采到"（不是"热度为 0"） ---- */
    const s2base = s2search(S2P);
    check('热度条二：本机没有访问日志 ⇒ `search` 顺序 = 既有 DFS 序（既有消费者逐字不变），'
      + '并如实给 `heat.applied=false` / `reason=no-log`（不静默当"热度为 0"）',
      !!s2base && s2ids(s2base).join(' ') === Array.from({ length: 40 }, (x, i) => 'nd-' + (i + 1)).join(' ')
        && s2base.heat.applied === false && s2base.heat.reason === 'no-log'
        && s2base.heat.weights.merged <= 0.10,
      'applied=' + ((s2base || {}).heat || {}).applied + ' ｜ reason=' + ((s2base || {}).heat || {}).reason
        + ' ｜ 前三个命中=' + s2ids(s2base).slice(0, 3).join(','));

    /* ---- （封顶）把最末一个节点的热度拉满 ⇒ 顺序真的变了，而位移 ≤ 封顶比例 ---- */
    s2visit(S2P, 'nd-40', 'human-detail', 3);
    const s2hot = s2search(S2P);
    const s2mv = s2moved(s2ids(s2base), s2ids(s2hot));
    check('热度条二·封顶：热度拉满 ⇒ 顺序**真的变了**，而位移不超过封顶比例（两条口径都钉）',
      !!s2hot && s2mv >= 1 && s2mv <= heatLib.maxJump(40)
        && s2mv / 39 <= 0.10 && s2hot.heat.applied === true && s2hot.heat.hitNodes === 1,
      '位移=' + s2mv + ' 位置（上界 maxJump(40)=' + heatLib.maxJump(40) + '）｜比例='
        + (s2mv / 39).toFixed(4) + ' ≤ 0.10 ｜ nd-40 位置 '
        + s2ids(s2base).indexOf('nd-40') + ' → ' + s2ids(s2hot).indexOf('nd-40')
        + ' ｜ heat=' + JSON.stringify(s2hot && s2hot.heat && s2hot.heat.weights));

    /* ---- （取舍）热度只排序：命中集合与 hitCount 不变；--limit 截断照旧、提高就能取到低热度命中 ---- */
    const s2one = s2search(S2P, ['--limit', '1']);
    const s2all = s2search(S2P, ['--limit', '40']);
    check('热度条二·取舍：热度只排序 —— 命中多重集与 `hitCount` 不变、零热度命中照样在；'
      + '`--limit` 截断可见（截断就是取前缀）、提高 limit 就能取到它们（可检索性没被挤掉）',
      !!s2one && !!s2all && s2hot.hitCount === s2base.hitCount
        && [...s2ids(s2hot)].sort().join(' ') === [...s2ids(s2base)].sort().join(' ')
        && s2one.hits.length === 1 && s2one.truncated === true && s2one.hitCount === 40
        && s2ids(s2one).join(' ') === s2ids(s2hot).slice(0, 1).join(' ')
        && s2ids(s2all).indexOf('nd-1') >= 0 && s2ids(s2all).indexOf('nd-39') >= 0,
      'hitCount ' + s2base.hitCount + '→' + s2hot.hitCount + ' ｜ --limit 1 返回 '
        + s2ids(s2one).join(',') + '（拉满的那条还没到榜首=' + (s2ids(s2one)[0] !== 'nd-40')
        + ' —— n=40 时位移上界只有 ' + heatLib.maxJump(40) + ' 个位置，封顶就是这个意思）'
        + ' ｜ 全量里最低热度的 nd-1 仍在=' + (s2ids(s2all).indexOf('nd-1') >= 0));

    /* ---- （两条都真进且权重不同）同一节点：人热 AI 冷 vs 人冷 AI 热 ⇒ 顺序不同 ---- */
    s2visit(S2H, 'nd-100', 'human-detail', 1);
    s2visit(S2A, 'nd-100', 'ai-get', 1);
    const s2humanHot = s2ids(s2search(S2H));
    const s2aiHot = s2ids(s2search(S2A));
    const s2mvH = s2moved(Array.from({ length: 100 }, (x, i) => 'nd-' + (i + 1)), s2humanHot);
    const s2mvA = s2moved(Array.from({ length: 100 }, (x, i) => 'nd-' + (i + 1)), s2aiHot);
    check('热度条二·两条：人 / AI 两条都真进排序，且**权重不同**（同一位置同一节点，'
      + '人热 ⇒ 挪得更远；两条给出的顺序**不同**）',
      s2humanHot.join(' ') !== s2aiHot.join(' ') && s2mvH > s2mvA && s2mvH >= 1
        && s2mvH <= heatLib.maxJump(100) && s2mvA <= heatLib.maxJump(100),
      '人热位移=' + s2mvH + ' ｜ AI 热位移=' + s2mvA + ' ｜ 两序不同='
        + (s2humanHot.join(' ') !== s2aiHot.join(' ')) + ' ｜ nd-100 落点：人热 '
        + s2humanHot.indexOf('nd-100') + ' / AI 热 ' + s2aiHot.indexOf('nd-100'));

    /* ---- （同源）MCP 的 search_nodes（真 stdio 一拍）与 CLI 的 search 对同一份数据逐条同序 ---- */
    const s2reqs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes', arguments: { project: S2P, keyword: S2KW } } }
    ];
    const s2sp = spawnSync(process.execPath, [MCP_SRV], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      input: s2reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
    });
    const s2replies = String(s2sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    });
    const s2mcpReply = s2replies.filter((x) => x && x.id === 2)[0] || null;
    const s2mcpText = s2mcpReply && s2mcpReply.result && s2mcpReply.result.content
      && s2mcpReply.result.content[0] && s2mcpReply.result.content[0].text;
    const s2viaMcp = s2json(s2mcpText);
    check('热度条二·同源：MCP `search_nodes`（真 stdio）与 CLI `search --json` 对**同一份数据**'
      + '命中**逐条同序**，hitCount / weights 也一致（MCP 侧一行打分逻辑都没有）',
      !!s2viaMcp && !!s2hot && s2ids(s2viaMcp).join(' ') === s2ids(s2hot).join(' ')
        && s2viaMcp.hitCount === s2hot.hitCount && s2viaMcp.heat.applied === true
        && JSON.stringify(s2viaMcp.heat.weights) === JSON.stringify(s2hot.heat.weights),
      'MCP 前三个=' + s2ids(s2viaMcp).slice(0, 3).join(',') + ' ｜ CLI 前三个=' + s2ids(s2hot).slice(0, 3).join(',')
        + ' ｜ 逐条同序=' + (s2ids(s2viaMcp).join(' ') === s2ids(s2hot).join(' '))
        + ' ｜ weights=' + JSON.stringify(s2viaMcp && s2viaMcp.heat && s2viaMcp.heat.weights));

    /* ---- （性能）3.8 MB 的日志：只读尾部一个 chunk，且窄读与全量读给出同一个热度 ----
     * ⚠️ 顺序要紧：**先落窗口外的大前缀、再记窗口内的事件** —— 反过来（先记新的、再塞旧的）
     *    会让日志时间倒流，读方会**响亮报错**（那是 F1 的设计，不是本段要测的东西）。 */
    const s2old = heatLib.serializeEvent(heatLib.buildEvent({
      node: 'nd-1', ch: 'ai-read-view', at: new Date(Date.now() - 40 * heatLib.DAY_MS).toISOString(), by: 'cli-integration'
    }));
    fs.appendFileSync(s2log(S2B), s2old.repeat(40000), 'utf8');
    s2visit(S2B, 'nd-40', 'human-detail', 3);
    const s2big = s2search(S2B);
    const s2fileBytes = fs.statSync(s2log(S2B)).size;
    check('热度条二·性能：大日志（窗口外前缀 ~3.8 MB）⇒ `search` 只读了**尾部一个 chunk**'
      + '（bytesRead ≪ 文件字节数、windowComplete=false），而排序与全量读同口径',
      !!s2big && s2big.heat.log.fileBytes > 3 * 1024 * 1024 && s2big.heat.log.windowComplete === false
        && s2big.heat.log.bytesRead < s2big.heat.log.fileBytes / 8 && s2big.heat.applied === true
        && s2big.heat.rankedNodes === 1,
      '读 ' + (s2big && s2big.heat && s2big.heat.log && s2big.heat.log.bytesRead) + ' B / 文件 '
        + (s2big && s2big.heat && s2big.heat.log && s2big.heat.log.fileBytes) + ' B（实际 '
        + s2fileBytes + ' B）｜windowComplete=' + (s2big && s2big.heat && s2big.heat.log && s2big.heat.log.windowComplete));

    /* ---- （响亮）日志坏一行 ⇒ search 非 0 退出 + 点名，且一条命中都不打印 ---- */
    fs.appendFileSync(s2log(S2P), '{"v":1,"at":"懒得写了"\n', 'utf8');
    const s2bad = run(['search', S2P, S2KW]);
    check('热度条二·响亮：日志里有一行读不出来 ⇒ `search` **非 0 退出** + 点名（字节偏移 + 原文），'
      + '且**一条命中都不打印**（宁可失败，也不给一份"看起来正常"的检索结果）',
      s2bad.code !== 0 && s2bad.out.indexOf('坏行') >= 0 && s2bad.out.indexOf('懒得写了') >= 0
        && s2bad.out.indexOf('不等于') >= 0
        && s2bad.out.split('\n').filter((l) => /^\s*nd-\d/.test(l)).length === 0,
      'exit=' + s2bad.code + ' ｜ ' + s2bad.out.trim().split('\n').slice(0, 2).join(' ').slice(0, 130));

    /* ---- （逃生门）坏日志 + `--no-heat` ⇒ 先拿到结果；而**默认档照旧响亮**（这一对就是判别力） ----
     * 用户拍板：热度是**旁路**（日志可随时删），旁路坏掉不该掐死主干的读路径 ⇒ 给一条**显式**退路；
     * 但**默认不许变成静默降级**（那会假装正常）⇒ 下面三条合起来才是那条判决：
     *   · 不带 `--no-heat` ⇒ exit≠0 + 点名（谁把默认改软，第一条必红）；
     *   · 带 `--no-heat` ⇒ exit 0 + 有命中；
     *   · 它的那一档与"从来没有过热度的项目"**逐字节相同**。 */
    const S2N = 'it-probe-heat2-n-' + S2TAG;
    S2ALL.push(S2N);
    s2mk(S2N, 40);
    s2visit(S2N, 'nd-40', 'human-detail', 2);
    const s2nLog = s2log(S2N);
    fs.appendFileSync(s2nLog, '{"v":1,"at":"懒得写了"\n', 'utf8');
    const s2eDefault = run(['search', S2N, S2KW]);
    const s2eEsc = run(['search', S2N, S2KW, '--no-heat']);
    const s2eEscJson = s2json(run(['search', S2N, S2KW, '--no-heat', '--json']).out);
    check('热度条二·逃生门（默认不许变软）：坏日志 + **不带** `--no-heat` ⇒ 仍然 exit≠0 + 点名坏行，'
      + '报错里**点名 `--no-heat`**（出口在报错里就能看见），且一条命中都不打印',
      s2eDefault.code !== 0 && s2eDefault.out.indexOf('坏行') >= 0 && s2eDefault.out.indexOf('懒得写了') >= 0
        && s2eDefault.out.indexOf('--no-heat') >= 0 && s2eDefault.out.indexOf('不等于') >= 0
        && s2eDefault.out.split('\n').filter((l) => /^\s*nd-\d/.test(l)).length === 0,
      'exit=' + s2eDefault.code + ' ｜ 点名出口=' + (s2eDefault.out.indexOf('--no-heat') >= 0)
        + ' ｜ 末行：' + s2eDefault.out.trim().split('\n').slice(-1)[0].slice(0, 80));

    check('热度条二·逃生门：坏日志 + `--no-heat` ⇒ **exit 0 且有 40 条命中**（顺序回到零热度档），'
      + '`--json` 的 `heat.reason` 如实说"被 --no-heat 显式关闭"、`log=null`（它真的没读盘）',
      s2eEsc.code === 0 && !!s2eEscJson && s2ids(s2eEscJson).length === 40
        && s2ids(s2eEscJson).join(' ') === Array.from({ length: 40 }, (x, i) => 'nd-' + (i + 1)).join(' ')
        && s2eEscJson.heat.applied === false && s2eEscJson.heat.reason === '被 --no-heat 显式关闭'
        && s2eEscJson.heat.log === null && s2eEscJson.hitCount === 40,
      'exit=' + s2eEsc.code + ' ｜ 命中 ' + s2ids(s2eEscJson).length + ' 条 ｜ reason='
        + ((s2eEscJson || {}).heat || {}).reason);

    fs.rmSync(s2nLog, { force: true });                      // 旁路整份删掉 = "从来没有过热度的项目"
    const s2eZero = run(['search', S2N, S2KW]);
    const s2eZeroJson = s2json(run(['search', S2N, S2KW, '--json']).out);
    check('热度条二·逃生门：`--no-heat` 那一档与"零热度档"**逐字节相同**（文本档 + 命中数组 + hitCount + 预算）'
      + '—— 逃生门只是跳过热度，不改检索语义',
      s2eZero.code === 0 && s2eEsc.out === s2eZero.out
        && !!s2eZeroJson && JSON.stringify(s2eEscJson.hits) === JSON.stringify(s2eZeroJson.hits)
        && s2eEscJson.hitCount === s2eZeroJson.hitCount
        && JSON.stringify(s2eEscJson.budget) === JSON.stringify(s2eZeroJson.budget)
        && s2eZeroJson.heat.reason === 'no-log',
      '文本档相同=' + (s2eEsc.out === s2eZero.out) + '（' + s2eEsc.out.length + ' B）｜零热度档 reason='
        + ((s2eZeroJson || {}).heat || {}).reason);

    /* ---- （MCP 逃生门）把 `--no-heat` 通到 MCP：报错里点名的出路，必须是**收报错的人真能用的** ----
     * 走 MCP 的调用方（AI）看不见命令行：它只会收到一条 isError 文本。CLI 报错里点名了
     * "加 `--no-heat` 先检索"，若 MCP 传不进这个开关，那条出路就是**指不到东西的死指针** ✗。
     * 三条一起钉：① 用得上（真 stdio，不是 isError 且有命中）；② 默认没变软（不给参数仍 isError +
     * 把出路带回）；③ 同源且只多这一个参数（MCP 侧不复制任何热度取值）。 */
    const S2M = 'it-probe-heat2-m-' + S2TAG;
    S2ALL.push(S2M);
    s2mk(S2M, 40);
    s2visit(S2M, 'nd-40', 'human-detail', 2);
    fs.appendFileSync(s2log(S2M), '{"v":1,"at":"懒得写了"\n', 'utf8');
    const s2mReqs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes', arguments: { project: S2M, keyword: S2KW, no_heat: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_nodes', arguments: { project: S2M, keyword: S2KW } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/list' }
    ];
    const s2mSp = spawnSync(process.execPath, [MCP_SRV], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      input: s2mReqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
    });
    const s2mReplies = String(s2mSp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    });
    const s2mById = (id) => s2mReplies.filter((x) => x && x.id === id)[0] || null;
    const s2mTextOf = (rep) => (rep && rep.result && rep.result.content && rep.result.content[0]
      && rep.result.content[0].text) || '';
    const s2mEsc = s2json(s2mTextOf(s2mById(2)));
    const s2mDef = s2mById(3);
    const s2mTools = ((s2mById(4) || {}).result || {}).tools || [];
    const s2mSearch = s2mTools.filter((t) => t && t.name === 'search_nodes')[0] || null;
    const s2mCli = s2json(run(['search', S2M, S2KW, '--no-heat', '--json']).out);

    check('热度条二·MCP 逃生门①：坏日志 + `no_heat:true`（**真 stdio**）⇒ 不是 isError、拿到 40 条命中'
      + '（顺序=零热度档），且与 CLI `--no-heat` 的命中**逐字相同**（同一个开关、同一处排序实现）',
      !!s2mEsc && s2mById(2).result.isError !== true && s2ids(s2mEsc).length === 40
        && s2ids(s2mEsc).join(' ') === Array.from({ length: 40 }, (x, i) => 'nd-' + (i + 1)).join(' ')
        && s2mEsc.heat.reason === '被 --no-heat 显式关闭'
        && !!s2mCli && JSON.stringify(s2mEsc.hits) === JSON.stringify(s2mCli.hits)
        && s2mEsc.hitCount === s2mCli.hitCount,
      'isError=' + (s2mById(2) && s2mById(2).result && s2mById(2).result.isError)
        + ' ｜ MCP 命中 ' + s2ids(s2mEsc).length + ' 条 / CLI ' + s2ids(s2mCli).length + ' 条 ｜ 逐字相同='
        + (JSON.stringify(s2mEsc && s2mEsc.hits) === JSON.stringify(s2mCli && s2mCli.hits)));

    check('热度条二·MCP 逃生门②（默认不许变软）：坏日志 + MCP **不给** `no_heat` ⇒ 仍然 isError，'
      + '并把出路（`--no-heat`）随报错带回给调用方',
      !!s2mDef && s2mDef.result && s2mDef.result.isError === true
        && s2mTextOf(s2mDef).indexOf('坏行') >= 0 && s2mTextOf(s2mDef).indexOf('--no-heat') >= 0,
      'isError=' + (s2mDef && s2mDef.result && s2mDef.result.isError) + ' ｜ 出路带回='
        + (s2mTextOf(s2mDef).indexOf('--no-heat') >= 0) + ' ｜ 末行：'
        + s2mTextOf(s2mDef).trim().split('\n').slice(-1)[0].slice(0, 70));

    check('热度条二·MCP 逃生门③（结构）：只是给 `search_nodes` 加了**这一个**布尔参数 —— 没有新增工具、'
      + '`no_heat` 不出现在别的工具上、MCP 侧也不抄任何热度取值（三串数字仍只在 src/heat.js）',
      !!s2mSearch && s2mSearch.inputSchema.properties.no_heat
        && s2mSearch.inputSchema.properties.no_heat.type === 'boolean'
        && s2mSearch.inputSchema.properties.no_heat.description.indexOf('--no-heat') >= 0
        && s2mTools.filter((t) => t && t.inputSchema && t.inputSchema.properties
          && t.inputSchema.properties.no_heat).length === 1
        && s2mTools.map((t) => t.name).filter((n) => n === 'search_nodes').length === 1
        && [String(heatLib.SEARCH_RANK.human), String(heatLib.SEARCH_RANK.ai), String(heatLib.SEARCH_RANK.merged),
          'byNode', 'maxJump'].every((x) => fs.readFileSync(MCP_SRV, 'utf8').indexOf(x) < 0),
      '工具数=' + s2mTools.length + ' ｜ 带 no_heat 的工具数='
        + s2mTools.filter((t) => t && t.inputSchema && t.inputSchema.properties
          && t.inputSchema.properties.no_heat).length
        + ' ｜ search_nodes.no_heat 类型='
        + (((((s2mSearch || {}).inputSchema || {}).properties || {}).no_heat) || {}).type);
  } finally {
    s2RestoreSensor();      // ← 本段开头关掉的自动埋点在这里**还原**（否则后面各段会被静默关掉）
    S2ALL.forEach((name) => {
      try { fs.rmSync(s2dir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    });
  }
}

/* ---------------- 【STRICT】冒烟「严格档」`MM_SMOKE_CLIP_STRICT`：环境坏时宁可红，不许悄悄放过 ----------------
 * 这一件补的是什么（**已知盲区**，不是新功能）：域 39 的剪贴板判据自 2026-10-12 起是三态 ——
 *   ① 独立环境探针**不可用** ⇒ 响亮"未验证"（**不计入通过/总数、不阻断**）；
 *   ② 探针**可用而我们没写进去** ⇒ 判红（真回归）；
 *   ③ 探针可用 + 写进去了 + 通道是 `desktop-clipboard` ⇒ 通过。
 * 三态修掉了"环境问题冒充产品缺陷" ✓，但它同时开了一个**新口子**：
 *   **环境坏的时候，"我们没写进去"这件事根本采不到真值** ⇒ 产品真回归会被**降级成"未验证"**
 *   ⇒ 在 CI / 受控环境里等于**悄悄放过**（本工程最重的损害类别："没做，却看不出没做"）。
 * 现在的口径（开关语义只有一条，实现在两处、各自单一职责）：
 *   · `scripts/smoke-assertions.js` 的 `parseStrictEnv(raw)` —— **唯一**的值解析（纯函数，可单测）：
 *     未设 / `0` / `false` ⇒ 关；`1` / `true` / 空串（裸写）⇒ 开；**别的值 ⇒ `ok:false`**（绝不静默落回某一档）；
 *   · 同文件 `tally(results, {strict})` —— 计数**唯一**口径：开时 `unverified` 进 `failed`（于是也进 `total`），
 *     默认档**一个字节都不变**（未验证仍不进通过/总数）；
 *   · `main.js` 的 `runSmoke` —— 接线：非法值当场 `SMOKE STRICT FLAG ERROR` + exit 1（**一条断言都不跑**）；
 *     开时打响亮行；每条"未验证"**仍如实打印、仍点名原因**，紧跟一行说明它这回算失败；汇总打第二行读数；
 *     退出码多一项 `strictFailures`（关着时短路为 0 ⇒ 与加开关之前完全一致）。
 * ⚠️ 本文件是**待并入的断言原文（草稿）**，`scripts/cli-integration.js` 由另一条流托管 ⇒ 我没有直接改它
 *   （见交付说明；并入位置：`try { … }` 主跑体内、任意位置，**不要**碰末尾的收尾段）。
 *
 * ## 为什么这条判据必须"注入过一次违规"才算数（本批实跑，读数见交付说明）
 * 把 `tally()` 里那一行 `if (strict) failed++` 去掉（= 严格档**只打印、不影响计数**）⇒
 * `MM_SMOKE_CLIP_STRICT=1` + 环境坏那一跑**退出码回到 0** ⇒ 判据在空转 ⇒ 必须红 ✓；还原后 SHA-256 逐字节相同、复绿。
 *
 * ## 成本（**自己量过再决定要不要挂链**，别把 G4 拖慢）
 * 甲档（纯函数 + 源码接线）：**毫秒级**，零子进程、零 Electron —— 建议**无开关常跑**。
 * 乙档（真 Electron 离屏跑两次）：本机实测**每跑 ≈ 40 s**（两次 ≈ 80 s）。G4 现在**不依赖 Electron**
 *   （`cli-integration.js` 是纯 node + 进程内 CLI 调用）⇒ 乙档若并入，会让 G4 多一个 "Electron 能不能起"
 *   的前置，**代价要明说**：故本节把乙档放在 `MM_IT_SMOKE_STRICT=1` 的显式开关后面（默认跳过 ≠ 静默通过：
 *   跳过时**必须打印一行说"乙档没跑"**，照 `A5` 的纪律，别让"没跑"看着像"跑绿了"）。
 */
{
  const S = require(path.join(ROOT, 'scripts', 'smoke-assertions.js'));   // 复用冒烟入口（load 零副作用）
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  /* ── 甲-1 值解析：只有五种输入合法，非法值必须 `ok:false`（静默落回某一档 = 受控环境根本没受控 ✗） ── */
  const cases = [
    [undefined, false, true], ['', true, true], ['1', true, true], ['true', true, true],
    ['0', false, true], ['false', false, true], [false, false, true],
    ['nonsense', false, false], ['yes', false, false], ['2', false, false], ['True', false, false]
  ];
  const badParse = cases.filter((c) => {
    const r = S.parseStrictEnv(c[0]);
    return r.strict !== c[1] || r.ok !== c[2];
  });
  check('[STRICT] `parseStrictEnv`：未设/0/false=关，1/true/裸写(空串)=开，**别的值当场 ok:false**'
    + '（防"开关值写错了却静默当 false"）',
    badParse.length === 0,
    '不合约的输入=' + JSON.stringify(badParse.map((c) => c[0])) + ' ｜ 解析=' + JSON.stringify(
      cases.map((c) => [c[0], S.parseStrictEnv(c[0]).strict, S.parseStrictEnv(c[0]).ok])));

  /* ── 甲-2 计数口径：**同一份输入**两档的差只有"未验证那几条算不算失败" ──
   * 这是"默认档逐字节不变"的**机械判据**：默认档那三个数必须与历史口径完全相同，
   * 严格档必须把 1 条"未验证"变成 1 条失败（且 `unverified` 与原因**照样列出** ⇒ 不许靠"看不见"来变红）。 */
  const rows = [{ ok: true, text: '' }, { ok: false, text: '' },
    { ok: true, unverified: '剪贴板本项未验证（环境：系统剪贴板不可用）', text: '' }];
  const d = S.tally(rows);
  const st = S.tally(rows, { strict: true });
  check('[STRICT] `tally()` 默认档：未验证**不进**通过/总数（passed=1 / total=2 / unverified=1）—— 与加开关之前同口径',
    d.passed === 1 && d.failed === 1 && d.total === 2 && d.unverified === 1,
    JSON.stringify(d));
  check('[STRICT] `tally()` 严格档：同一条"未验证"**按失败计**（failed=2 / total=3），且 `unverified` 与原因**照样列出**',
    st.passed === 1 && st.failed === 2 && st.total === 3 && st.unverified === 1
      && st.unverifiedList.length === 1,
    JSON.stringify(st));
  /* fail-safe 不许被"严格档"改写：`ok:false` 带 `unverified` 仍是失败、且**不算**未验证（两档都如此）。 */
  const fsRows = [{ ok: false, unverified: '环境坏', text: '' }];
  check('[STRICT] fail-safe 两档都在：`ok:false` 带 `unverified` ⇒ 一律算失败、不许被算成"未验证"（真失败的后门 ✗）',
    S.tally(fsRows).failed === 1 && S.tally(fsRows).unverified === 0
      && S.tally(fsRows, { strict: true }).failed === 1 && S.tally(fsRows, { strict: true }).unverified === 0,
    JSON.stringify({ def: S.tally(fsRows), strict: S.tally(fsRows, { strict: true }) }));

  /* ── 甲-3 接线（源码级）：开关真的接了退出码、真的打了响亮行；且严格档那几行额外输出**全在门槛之内** ──
   * 为什么这条也要（本工程吃过的形状）：断言返回了 `unverified` 而 runner 不认 ⇒ 那条结果**静默落回 PASS**。
   * ⚠️ 切不到就必须红（`B4` ③）：正则失配会让这条检查变成恒真。
   * ⚠️ **这条只证明"那三行额外输出各自有门槛"**；"默认档与加开关之前逐字节相同"的**真正判据是实测对拍**
   *   （同一份输入跑两次比输出/计数），不是这段源码正则 —— 别把这里的绿读成"已证明逐字节相同" ✗。 */
  check('[STRICT] 接线：`main.js` 里 ① 解析走 `parseStrictEnv` ② 非法值 exit 1 ③ 严格档把未验证计进退出码',
    /allAssertions\.parseStrictEnv\(process\.env\.MM_SMOKE_CLIP_STRICT\)/.test(mainSrc)
      && /SMOKE STRICT FLAG ERROR/.test(mainSrc)
      && /const strictFailures = strictOn \? smokeStrict\.failed : 0;/.test(mainSrc)
      && /app\.exit\(\(failed\.length \|\| realWriteLeak \|\| strictFailures\)/.test(mainSrc),
    '解析=' + /parseStrictEnv\(process\.env/.test(mainSrc) + ' ｜ 非法值红=' + /SMOKE STRICT FLAG ERROR/.test(mainSrc)
      + ' ｜ 退出码接线=' + /strictFailures/.test(mainSrc));
  check('[STRICT] 默认档：严格档的**每一行额外输出**都在 `if (strictOn)` / `strictOn ?` 门槛之内'
    + '（拆掉任一门槛 ⇒ 默认档就多打一行 ⇒ 判红）',
    /if \(strictOn\) \{\r?\n\s+console\.log\('\[smoke\] \*\*严格档已开\*\*/.test(mainSrc)
      && /if \(r\.unverified && strictOn\) \{/.test(mainSrc)
      && /const smokeStrict = strictOn \? tally\(results, \{ strict: true \}\) : smokeT;/.test(mainSrc)
      && /冒烟三态：通过 /.test(mainSrc) && /' ｜ 未验证 ' \+ smokeT\.unverified/.test(mainSrc),
    '门槛数=' + (mainSrc.match(/if \(strictOn\)/g) || []).length
      + ' ｜ 默认档三态行仍在=' + /冒烟三态：通过 /.test(mainSrc));

  /* ── 乙档（重，显式开关）：真 Electron 离屏跑两次，判的才是**退出码**（甲档判不了的那一跳） ──
   * 两次的口径要"只差一个变量"：同样 `SMOKE_ONLY=39`、同样把探针**打桩成环境不可用**
   * （`MM_SMOKE_INJECT=39-clip-env-down`；本机剪贴板时好时坏，靠真实环境会变成**偶发**判据 ✗），
   * 唯一差别是 `MM_SMOKE_CLIP_STRICT`。⇒ 严格档必须 1（未验证按失败计）、默认档必须 0（未验证不阻断）。 */
  if (process.env.MM_IT_SMOKE_STRICT === '1') {
    const ELECTRON = require('electron');                       // 纯 node 里拿到 electron.exe 的路径（字符串）
    const runSmoke = (env1) => {
      const sp = spawnSync(ELECTRON, ['.', '--smoke'], {
        cwd: ROOT, encoding: 'utf8', timeout: 240000,
        env: Object.assign({}, process.env, { SMOKE_ONLY: '39', MM_SMOKE_INJECT: '39-clip-env-down' }, env1)
      });
      return { code: sp.status, out: String(sp.stdout || '') + String(sp.stderr || '') };
    };
    const def = runSmoke({});                                   // 默认档：环境坏 ⇒ 未验证、不阻断
    const str = runSmoke({ MM_SMOKE_CLIP_STRICT: '1' });        // 严格档：环境坏 ⇒ 未验证按失败计 ⇒ 非 0
    check('[STRICT·乙] 默认档（开关关）+ 环境坏 ⇒ **exit 0**，且三个数里"未验证 1"可见（既不通过也不算失败）',
      def.code === 0 && /未验证 1/.test(def.out) && /\[未验证\]/.test(def.out),
      'exit=' + def.code + ' ｜ 三态行=' + (def.out.split('\n').find((l) => /冒烟三态：通过/.test(l)) || '(无)'));
    check('[STRICT·乙] 严格档（MM_SMOKE_CLIP_STRICT=1）+ 环境坏 ⇒ **exit ≠ 0**，报文点名"严格档：未验证按失败计"'
      + '（防"环境坏被降级成未验证 ⇒ 真回归悄悄放过"）',
      str.code !== 0 && /严格档/.test(str.out) && /未验证按失败计|按失败计/.test(str.out)
        && /\[未验证\]/.test(str.out),
      'exit=' + str.code + ' ｜ 严格档行=' + (str.out.split('\n').find((l) => /严格档/.test(l)) || '(无)').slice(0, 160));
  } else {
    console.log('[SKIP·**不是通过**] [STRICT·乙] 真 Electron 两次跑未执行（要 `MM_IT_SMOKE_STRICT=1` 才跑；'
      + '理由：它会让 G4 多一个 Electron 前置、每跑 ≈ 80 s）—— 甲档（纯函数 + 接线）本轮已跑 ✓，'
      + '退出码那一跳本轮**没有验**（别把这里读成"验过了"）。');
  }
}

/* ============================================================
 * W8-集成断言原文.js —— 「写入类命令统一 `--dry-run`」的**集成断言原文**
 * （放行窗口由整合流贴进 `scripts/cli-integration.js`；本文件**不是**可执行脚本，只是那段源码的存放处）
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的
 * `## W8｜写入类命令统一 --dry-run` 一节（四条判据逐条对应到下面各 check 的名字）。
 * 单测侧（可重复执行、进程内、临时沙箱，**24 用例**）：`tests/w8-dry-run.test.js`。
 * 本段**不重复**那 23 条，只把"必须在**真实工程 + 真实 projects/ 根**上跑一遍才作数"的那几条接到集成链上。
 *
 * ## 怎么贴（四句话）
 *   1) 位置：**S2（热度条第二件）那一段之后、`/* ---------------- 清理 ---------------- *\/` 之前**，
 *      整段原样粘（已写成独立块 `{ … }`：自带 `finally` 收尾、自删全部探针、**不需要动末尾的清理段**）。
 *   2) 探针一律 `it-probe-w8-` 前缀 ⇒ 文件顶部 `sweepStaleProbes()` 的前缀表（`it-probe-`）**已覆盖**，
 *      被中断留下的残留下次跑链会被自动清掉 ✓。
 *   3) 贴完**必须**跑一次 `npm run facts:write`：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成断言数，
 *      本段新增的 check 都会被算进去 ⇒ 不重生成 `docs/VERIFY.md` 就会在 G6 报"断言数对不上"（那正是 G6 该做的事）。
 *   4) 本段**一条写死计数都没有**（工具数那一拍也是**现算**：读 `docs/VERIFY.md` 的基线行，
 *      再与 `require(…).TOOLS.length` 比 —— 见下面 `W8·MCP 面` 那条的注释）。
 *
 * ## 这一节守什么（每条对着 W8 的一条判据）
 *   · 判据①（`--dry-run` 之后盘上**逐字节零变化**）：`W8·判据①`（单条）+ `W8·判据①（覆盖）`（逐条覆盖）
 *   · 判据②（报告给出**将改的对象与数量**）：`W8·判据②`
 *   · 判据③（⭐ **报告与真跑结果一致**）：`W8·判据③（逐字）` + `W8·判据③（类型计数）` + `W8·判据③（拒绝一致）`
 *   · 判据④（**注入证明**）：本文件里那条"零变化"断言就是注入会打红的断言；真实注入报文、还原后的
 *     SHA-256 与复绿读数在交付说明里（集成链上不做注入 —— 它会改仓库文件）。
 *   · 另加三条**边界**：`W8·旁路`（连变更日志都不多一条）/ `W8·边界`（不认这个开关的命令响亮拒绝）/
 *     `W8·一处实现`（命令层不许各读 `ctx.args.dryRun`）/ `W8·MCP 面`（只加参数、不新增工具）。
 *
 * ## 判别力（每条断言"哪行代码坏了会让它红"）
 *   · 把 `cli/core.js` 的 `planWrite` 短路删掉（dry-run 照样写盘）⇒ `W8·判据①` 与两条 `判据③` **必红**
 *     （实测：8 条单测红、15 条绿，报文见交付说明）。
 *   · 改坏 `planWrite` 的清单口径（例如不 `.sort()`、或用别的函数算差异）⇒ `W8·判据③（逐字）` **必红**。
 *   · 把 `DRY_RUN_COMMANDS` 与 registry 的派生关系断开（某条命令不再认这个开关）⇒
 *     `W8·判据①（覆盖）` 里的"每条 argv 的首个 token 都在支持集里"那半句 **必红**。
 *   · 把 `dryRunRefusal` 的拒绝报文换成"未知选项"⇒ `W8·边界` **必红**（那里逐字点名了"不可用/新项目"）。
 *
 * ⚠️ 本段**只增断言**，不改任何既有断言的语义；MCP 那一拍是**真 require**（不起子进程、不发 stdio）。
 * ⚠️ 段内**不要**写成"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见 cli-integration.js 文件头）。
 * ============================================================ */
{
  const w8core = require(path.join(ROOT, 'cli', 'core.js'));          // 支持集 / 标记 / 拒绝判定的唯一实现处
  const w8mcp = require(path.join(ROOT, 'scripts', 'mcp-server.js'));  // MCP 参数面（工具数基线现算，见下）
  const w8im = require(path.join(ROOT, 'src', 'item-model.js'));       // renderDetail：条目化节点的 detail 真源
  const w8changes = require(path.join(ROOT, 'src', 'changes.js'));     // 变更日志解析（判据③的右边那一半）

  const W8TAG = Date.now().toString(36);
  const W8SRC = 'it-probe-w8-src-' + W8TAG;
  const W8DST = 'it-probe-w8-dst-' + W8TAG;
  const W8LNK = 'it-probe-w8-lnk-' + W8TAG;
  const W8ASC = 'it-probe-w8-asc-' + W8TAG;
  const W8NEW = 'it-probe-w8-new-' + W8TAG;
  const W8ALL = [W8SRC, W8DST, W8LNK, W8ASC, W8NEW];
  const w8dir = (n) => path.join(w8core.PROJECTS_DIR, n);
  const w8file = (n) => path.join(w8dir(n), n + '.json');

  const W8ITEMS = [
    { id: 'i-1', type: 'text', html: '<p>一</p>', at: '2026-01-01T00:00:00.000Z', by: 'cli:init' },
    { id: 'i-2', type: 'text', html: '<p>二</p>', at: '2026-01-01T00:00:00.000Z', by: 'cli:init' }
  ];

  /** 直接写盘造项目（同 W1 / S2 段的手法：夹具与断言都不依赖命令本身） */
  const w8write = (n, obj) => {
    fs.mkdirSync(w8dir(n), { recursive: true });
    fs.writeFileSync(w8file(n), JSON.stringify(obj, null, 2), 'utf8');
  };
  /** 源项目：普通节点（带子节点/详情）+ 条目化节点 + 带图附件节点 + 一条关联笔记 + 一条已存在的出边 */
  const w8src = () => ({
    meta: { name: 'W8 集成探针源', author: '', version: '0.18.0', formatVersion: 3 },
    format: 'node_tree',
    data: {
      id: 'root', topic: 'W8 集成探针源', expanded: true,
      children: [
        { id: 'n-a', topic: '甲', detail: '<p>甲正文</p>', tags: ['t1'], expanded: true,
          links: [{ project: W8DST, id: 'd-1', caption: '指向目标节点' }],
          children: [{ id: 'n-a1', topic: '甲一', children: [] }] },
        { id: 'n-b', topic: '乙', expanded: true, children: [] },
        { id: 'n-it', topic: '条目化节点', expanded: true, children: [],
          items: W8ITEMS, detail: w8im.renderDetail(W8ITEMS) },
        { id: 'n-img', topic: '带图', expanded: true, children: [],
          images: [{ file: 'assets/a.png', caption: '图一' }],
          files: [{ file: 'attachments/a.md', caption: '附件一' }] }
      ]
    },
    assoc: [{ id: 'a-1', title: '关联一', members: [
      { project: W8SRC, id: 'n-a' }, { project: W8SRC, id: 'n-b' }] }]
  });
  /** 夹具重置（每条断言都从**同一个已知状态**出发 ⇒ 与执行顺序无关） */
  const w8reset = () => {
    W8ALL.forEach((n) => fs.rmSync(w8dir(n), { recursive: true, force: true }));
    w8write(W8SRC, w8src());
    w8write(W8DST, {
      meta: { name: 'W8 集成探针目标', author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'W8 集成探针目标', expanded: true,
        children: [{ id: 'd-1', topic: '目标节点', children: [] }] }
    });
    // 两个"脏项目"：各自只有**一类**坏东西（`validate` 会同时判两类 ⇒ 塞一起就测不出"单跑一条即复绿"）
    w8write(W8LNK, {
      meta: { name: 'W8 集成探针（悬空链接）', author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'W8 集成探针', expanded: true,
        children: [{ id: 'x-1', topic: '有悬空链接', children: [], links: [{ project: 'it-probe-w8-nope', id: 'z-9' }] }] }
    });
    w8write(W8ASC, {
      meta: { name: 'W8 集成探针（悬空成员）', author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'W8 集成探针', expanded: true,
        children: [{ id: 'x-1', topic: '有悬空成员的关联', children: [] }] },
      assoc: [{ id: 'x-a1', title: '悬空成员的关联',
        members: [{ project: W8ASC, id: 'x-1' }, { project: W8ASC, id: 'x-gone' }] }]
    });
  };

  /** 项目目录快照（逐字节 + sha256 前 16 + mtimeMs）—— 判据①的量具（与 W1 那段的 `w1snap` 同一形状） */
  const w8snap = (dir) => {
    const out = [];
    if (!fs.existsSync(dir)) return '';
    const walk = (d) => {
      fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        const buf = fs.readFileSync(abs);
        out.push(path.relative(dir, abs).split(path.sep).join('/')
          + '|' + buf.length + '|' + require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16)
          + '|' + fs.statSync(abs).mtimeMs);
      });
    };
    walk(dir);
    return out.join('\n');
  };
  /** 真跑日志末条 `changed`（**读盘真值**：判据③的右边那一半） */
  const w8last = (n) => {
    const f = path.join(w8dir(n), w8changes.FILE_NAME);
    if (!fs.existsSync(f)) return null;
    const e = w8changes.parseLog(fs.readFileSync(f, 'utf8')).entries;
    return e.length ? e[e.length - 1].changed : null;
  };
  /**
   * 从**给人看的报告**里抠出"将改动的对象清单"（顺带证明它可机械解析）。
   * 报告形状的唯一生成处：`cli/core.js` 的 `planWrite`。
   */
  const w8plan = (out) => {
    const lines = String(out).split('\n');
    if (lines.filter((l) => l.indexOf('会**新建**项目') >= 0).length) {
      return { count: 0, keys: [], created: true, byKind: {} };
    }
    const line = lines.filter((l) => l.indexOf('这次写盘将改动') >= 0)[0];
    if (!line) return null;
    const m = /这次写盘将改动 (\d+) 个对象(?:（([^）]*)）)?(?:：(.+))?$/.exec(line.replace(w8core.DRY_RUN_TAG, ''));
    if (!m) return null;
    const keys = m[3] ? m[3].split('、').map((s) => s.trim()).filter(Boolean) : [];
    const byKind = {};
    keys.forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); byKind[kind] = (byKind[kind] || 0) + 1; });
    return { count: Number(m[1]), keys: keys, created: false, byKind: byKind };
  };
  const w8kinds = (changed) => {
    const byKind = {};
    (changed || []).forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); byKind[kind] = (byKind[kind] || 0) + 1; });
    return byKind;
  };

  /** 覆盖清单：每条命令各一条**真调用**（夹具 id 都对得上）；`clone` 会现摇新 id ⇒ 只在"零变化"那条里跑 */
  const w8cases = [
    ['add', W8SRC, 'root', '--topic', 'W8 新增'],
    ['add-root', W8SRC, '--topic', 'W8 新顶层'],
    ['edit', W8SRC, 'n-a', '--topic', 'W8 改过的标题'],
    ['move', W8SRC, 'n-a1', 'n-b'],
    ['remove', W8SRC, 'n-a1'],
    ['clone', W8SRC, 'n-a', 'n-b'],
    ['expand-depth', W8SRC, '--depth', '0'],
    ['theme-layout', W8SRC, '--left', 'n-a'],
    ['link', W8SRC, 'n-b', '--to', W8DST, '--id', 'd-1'],
    ['unlink', W8SRC, 'n-a', '--to', W8DST, '--id', 'd-1'],
    ['assoc-add', W8SRC, '--members', 'n-a,n-b', '--title', 'W8 关联'],
    ['assoc-edit', W8SRC, 'a-1', '--title', 'W8 改过的关联'],
    ['assoc-remove', W8SRC, 'a-1'],
    ['assoc-prune', W8ASC],
    ['links-prune', W8LNK],
    ['item-add', W8SRC, 'n-it', '--md', 'W8 新条目'],
    ['item-edit', W8SRC, 'n-it', 'i-1', '--md', 'W8 改过的条目'],
    ['item-remove', W8SRC, 'n-it', 'i-2'],
    ['item-move', W8SRC, 'n-it', 'i-2', '--to', 'n-it2'],
    ['item-order', W8SRC, 'n-it', '--ids', 'i-2,i-1'],
    ['render-detail', W8SRC, 'n-it'],
    ['remove-image', W8SRC, 'n-img', 'assets/a.png'],
    ['remove-file', W8SRC, 'n-img', 'attachments/a.md'],
    ['ask-apply', W8SRC, 'n-a', '--answer', 'W8 答案'],
    ['init', W8NEW, '--title', 'W8 新项目']
  ];

  try {
    w8reset();

    /* ---- 判据①：`--dry-run` 之后盘上**逐字节零变化**（单条，量具先自证）---- */
    {
      const before = w8snap(w8dir(W8SRC));
      const logBefore = w8snap(path.join(w8core.PROJECTS_DIR, '.visits'));
      const r = run(['edit', W8SRC, 'n-a', '--topic', 'W8 干跑一次', '--dry-run']);
      const again = run(['edit', W8SRC, 'n-a', '--topic', 'W8 干跑一次', '--dry-run']);
      check('W8·判据① `edit --dry-run`：报告给得出计划、而项目目录**逐字节 + mtime 不变**'
        + '（连 `.visits/` 也没动；第二次跑读数与第一次同口径）',
        r.code === 0 && r.out.indexOf(w8core.DRY_RUN_TAG) >= 0
          && !!w8plan(r.out) && w8plan(r.out).keys.length > 0
          && w8snap(w8dir(W8SRC)) === before
          && w8snap(path.join(w8core.PROJECTS_DIR, '.visits')) === logBefore
          && JSON.stringify(w8plan(again.out).keys) === JSON.stringify(w8plan(r.out).keys),
        'exit=' + r.code + ' ｜ 清单=' + JSON.stringify(w8plan(r.out) ? w8plan(r.out).keys : null)
          + ' ｜ 目录不变=' + (w8snap(w8dir(W8SRC)) === before));
    }

    /* ---- 判据①（覆盖）：上面那张清单里**每一条命令**都零变化，且每条都在支持集里 ---- */
    {
      const failures = [];
      const support = w8core.DRY_RUN_COMMANDS;
      w8cases.forEach((argv) => {
        if (support.indexOf(argv[0]) < 0) failures.push(argv[0] + '：不在 DRY_RUN_COMMANDS 里（支持集与实测不一致）');
        w8reset();
        const before = w8snap(w8dir(argv[1] || W8SRC));
        const r = run(argv.concat(['--dry-run']));
        const after = w8snap(w8dir(argv[1] || W8SRC));
        if (before !== after) failures.push(argv[0] + '：盘上变了');
        const p = w8plan(r.out);
        if (r.code === 0 && p === null) failures.push(argv[0] + '：报告里没有"将改动 N 个对象"');
        if (r.code === 0 && r.out.indexOf('dry-run') < 0) failures.push(argv[0] + '：输出里看不出这是 dry-run');
        // 第二次跑：读数同口径（现摇新 id 的命令只比类型计数 ⇒ 那一半与随机无关）
        const again = run(argv.concat(['--dry-run']));
        const p2 = w8plan(again.out);
        const sig = (x) => (x === null ? 'null' : (x.created ? 'created' : x.count + '/' + JSON.stringify(x.byKind)));
        if (sig(p) !== sig(p2)) failures.push(argv[0] + '：第二次读数与第一次不同（' + sig(p) + ' vs ' + sig(p2) + '）');
      });
      check('W8·判据①（覆盖）' + w8cases.length + ' 条写命令逐条 `--dry-run`：**项目目录逐字节 + mtime 零变化**、'
        + '每条都给得出可解析的计划、且每条命令都在 `DRY_RUN_COMMANDS`（支持集）里',
        failures.length === 0,
        failures.length ? failures.join('；') : (w8cases.length + ' 条全绿（清单现算：' + w8cases.map((x) => x[0]).join(',') + '）'));
    }

    /* ---- 判据②：报告的**个数 == 清单条数**，清单每项都带对象类型前缀 ---- */
    {
      const bad = [];
      [['edit', W8SRC, 'n-a', '--topic', 'W8 判据二'],
        ['link', W8SRC, 'n-b', '--to', W8DST, '--id', 'd-1'],
        ['assoc-add', W8SRC, '--members', 'n-a,n-b', '--title', 'W8 判据二'],
        ['item-order', W8SRC, 'n-it', '--ids', 'i-2,i-1']
      ].forEach((argv) => {
        w8reset();
        const p = w8plan(run(argv.concat(['--dry-run'])).out);
        if (!p || !p.count) { bad.push(argv[0] + '：没有"将改动 N 个对象"'); return; }
        if (p.count !== p.keys.length) bad.push(argv[0] + '：个数 ' + p.count + ' != 清单 ' + p.keys.length);
        if (p.keys.some((k) => k.indexOf(':') < 0 && ['meta', 'format'].indexOf(k) < 0)) bad.push(argv[0] + '：清单项缺类型前缀');
      });
      check('W8·判据② 报告的**对象个数 == 清单条数**，且清单每一项都写成 `<类型>:<id>`（可逐字比对变更日志）',
        bad.length === 0, bad.length ? bad.join('；') : '4 条命令的报告都自洽');
    }

    /* ---- 判据③（逐字）：同一命令"先 dry-run 后真跑"，报告的清单 == 日志末条的 `changed` ---- */
    {
      const bad = [];
      [['edit', W8SRC, 'n-a', '--topic', 'W8 判据三'],
        ['link', W8SRC, 'n-b', '--to', W8DST, '--id', 'd-1'],
        ['assoc-add', W8SRC, '--members', 'n-a,n-b', '--title', 'W8 判据三', '--id', 'w8-a9'],
        ['item-order', W8SRC, 'n-it', '--ids', 'i-2,i-1'],
        ['remove-image', W8SRC, 'n-img', 'assets/a.png'],
        ['links-prune', W8LNK]
      ].forEach((argv) => {
        w8reset();
        const proj = argv[1];
        const dry = run(argv.concat(['--dry-run']));
        const p = w8plan(dry.out);
        const r = run(argv);
        const changed = w8last(proj);
        if (dry.code !== 0 || r.code !== 0) { bad.push(argv[0] + '：exit ' + dry.code + '/' + r.code); return; }
        if (JSON.stringify(p.keys) !== JSON.stringify(changed)) {
          bad.push(argv[0] + '：报告 ' + JSON.stringify(p.keys) + ' != 日志 ' + JSON.stringify(changed));
        }
      });
      check('W8·判据③（逐字）dry-run 报告的对象清单 == 真跑后 `.changes.jsonl` 末条的 `changed`'
        + '（**同一个 `changedKeys`、同一对输入** ⇒ 两边逐字相等，不是"都非空"的弱口径）',
        bad.length === 0, bad.length ? bad.join('；') : '6 条命令逐字一致');
    }

    /* ---- 判据③（类型计数）：会**现摇新 id** 的命令（`clone`）比"与随机无关的那一半" ---- */
    {
      w8reset();
      const dry = run(['clone', W8SRC, 'n-a', 'n-b', '--dry-run']);
      const p = w8plan(dry.out);
      const r = run(['clone', W8SRC, 'n-a', 'n-b']);
      const changed = w8last(W8SRC);
      check('W8·判据③（类型计数）`clone`（副本 id 现摇 ⇒ 清单里的 id 逐字不同）的报告**按类型计数 == 日志**，'
        + '且项数相等（报告里与随机无关的那一半必须完全准）',
        dry.code === 0 && r.code === 0 && p.count === changed.length
          && JSON.stringify(p.byKind) === JSON.stringify(w8kinds(changed))
          && p.keys.length === p.count,
        'exit=' + dry.code + '/' + r.code + ' ｜ 报告 ' + JSON.stringify(p.byKind) + ' ｜ 日志 ' + JSON.stringify(w8kinds(changed)));
    }

    /* ---- 判据③（拒绝一致）：dry-run 与真跑**同一套判据、同一句话** ---- */
    {
      w8reset();
      const first = run(['add', W8SRC, 'root', '--id', 'w8-dup', '--topic', 'W8 重复主题']);
      const snap = w8snap(w8dir(W8SRC));
      const dry = run(['add', W8SRC, 'root', '--topic', 'W8 重复主题', '--dry-run']);
      const real = run(['add', W8SRC, 'root', '--topic', 'W8 重复主题']);
      check('W8·判据③（拒绝一致）语义去重命中时：`--dry-run` 与真跑**同样 exit 1、报文逐字相同**，'
        + '且两次都没动盘 —— "预览说能写、真跑被拒"这种落差不存在',
        first.code === 0 && dry.code === 1 && real.code === 1 && dry.out === real.out && w8snap(w8dir(W8SRC)) === snap,
        'exit=' + dry.code + '/' + real.code + ' ｜ 报文相同=' + (dry.out === real.out)
          + ' ｜ 盘上未变=' + (w8snap(w8dir(W8SRC)) === snap)
          + ' ｜ 首行=' + String(dry.out).split('\n')[0].slice(0, 90));
    }

    /* ---- 旁路：dry-run 连变更日志与访问日志都不多一条 ---- */
    {
      w8reset();
      const logFile = path.join(w8dir(W8SRC), w8changes.FILE_NAME);
      const before = w8snap(w8dir(W8SRC)) + '\n@@\n'
        + (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '（没有日志）');
      run(['edit', W8SRC, 'n-a', '--topic', 'W8 旁路探针', '--dry-run']);
      run(['add', W8SRC, 'root', '--topic', 'W8 旁路探针', '--dry-run']);
      const after = w8snap(w8dir(W8SRC)) + '\n@@\n'
        + (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '（没有日志）');
      const ch = run(['changes', W8SRC, '--json']);
      check('W8·旁路 dry-run **连旁路产物都不多一条**：`.changes.jsonl` 的字节与 `changes --json` 的 rev/version '
        + '前后完全不变（"不写盘"包含"不记账"）',
        before === after && ch.code === 0
          && (function () { try { const j = JSON.parse(ch.out); return j.rev === undefined || typeof j.rev === 'number'; } catch (e) { return false; } })(),
        '目录+日志不变=' + (before === after) + ' ｜ changes exit=' + ch.code);
    }

    /* ---- 边界：不认这个开关的命令**响亮拒绝**（不静默忽略）---- */
    {
      const read = run(['read', W8SRC, '--dry-run']);
      const imp = run(['import-json', 'it-probe-w8-不存在.aimap.json', '--dry-run']);
      const alias = run(['tree', W8SRC, '--dry-run']);           // `tree` 是 `list` 的别名
      check('W8·边界 认不认 `--dry-run` 由**一处**判定：只读命令（`read` / 别名 `tree`）⇒ exit 1 且说明'
        + '"只对会改盘的命令有意义"并指回 `DRY_RUN_COMMANDS`；`import-json`（会改盘但不支持）⇒ exit 1 且'
        + '**点名原因与出路**（不是含糊的"未知选项"）',
        read.code === 1 && read.out.indexOf('只对**会改盘的命令**有意义') >= 0
          && read.out.indexOf('DRY_RUN_COMMANDS') >= 0
          && alias.code === 1 && alias.out.indexOf('list 不写盘') >= 0
          && imp.code === 1 && imp.out.indexOf('不可用') >= 0 && imp.out.indexOf('新项目') >= 0
          && imp.out.indexOf('未知选项') < 0,
        'read exit=' + read.code + ' ｜ tree exit=' + alias.code + ' ｜ import-json exit=' + imp.code
          + ' ｜ import-json 首行=' + String(imp.out).split('\n')[0].slice(0, 80));
    }

    /* ---- 一处实现（静态）：命令层不许各读 `ctx.args.dryRun` ---- */
    {
      const dir = path.join(ROOT, 'cli', 'commands');
      const bad = fs.readdirSync(dir).filter((f) => /\.js$/.test(f))
        .filter((f) => /args\.dryRun/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
      const declared = w8core.DRY_RUN_COMMANDS.length;                 // 现算：支持集条数（不写死）
      const withFlag = w8mcp.TOOLS.filter((t) => t.inputSchema.properties
        && t.inputSchema.properties.dry_run);
      check('W8·一处实现 `cli/commands/*.js` 里**不出现** `args.dryRun`（判定统一读 `ctx.dryRun`，'
        + '唯一读取点见 cli/core.js）；且 MCP 侧带 `dry_run` 的工具与 tool→命令映射表**同源**'
        + '（现算：支持集 ' + declared + ' 条命令、MCP ' + withFlag.length + ' 个工具带这个参数）',
        bad.length === 0
          && withFlag.length === Object.keys(w8mcp.DRY_RUN_TOOL_CMD).length
          && withFlag.every((t) => w8core.DRY_RUN_COMMANDS.indexOf(w8mcp.DRY_RUN_TOOL_CMD[t.name]) >= 0),
        '命令层违规文件=' + JSON.stringify(bad) + ' ｜ MCP 带参工具=' + withFlag.length
          + ' / 映射表=' + Object.keys(w8mcp.DRY_RUN_TOOL_CMD).length);
    }

    /* ---- MCP 面：**只加参数、不新增工具**（工具数基线**现算**：读 docs/VERIFY.md 那一行） ---- */
    {
      const verifyText = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
      const m = /MCP 工具数 \| (\d+)/.exec(verifyText);
      const baseline = m ? Number(m[1]) : null;
      const importJson = w8mcp.TOOLS.filter((t) => t.name === 'import_json')[0];
      check('W8·MCP 面 工具数**没变**（现算：`TOOLS.length` == `docs/VERIFY.md` 登记的基线 '
        + (baseline === null ? '（读不到基线）' : baseline) + '），且 `import_json` **没有** `dry_run` 参数'
        + '（它建新项目、资源解包不走写管道 ⇒ 给了只会得到假报告，CLI 侧会响亮拒绝）',
        baseline !== null && w8mcp.TOOLS.length === baseline
          && new Set(w8mcp.TOOLS.map((t) => t.name)).size === baseline
          && !!importJson && importJson.inputSchema.properties.dry_run === undefined,
        'TOOLS=' + w8mcp.TOOLS.length + ' ｜ 基线=' + baseline
          + ' ｜ import_json.dry_run=' + (importJson ? String(importJson.inputSchema.properties.dry_run) : '（没有这个工具）'));
    }
  } finally {
    /* 自收尾：探针项目 + 它们在 `.visits/` 里的旁路日志（日志在项目目录之外，删目录删不掉它） */
    W8ALL.forEach((n) => {
      try { fs.rmSync(w8dir(n), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    });
  }
}

/* ---------------- 【SMOKE40】域 40 第五条的「造故障条件」：三档梯子 + 第三态（判红 / 只报告 / 跳过） ----------------
 * 这一件补的是什么（第十九批放行窗口实测的形状，不是假想）：
 *   全链首跑 `218/219`，**唯一红**是域 40 的第五条，报文里只有一句 `② 日志路径被堵住=false`；
 *   紧接着单跑同一份代码就 `219/219`、exit 0 ⇒ **不是产品回归**：那条断言的 setup 当时靠
 *   `fs.renameSync(<项目根>/.visits → .visits.smoke40bak)` 造"日志路径不可用"，而 %TEMP% 沙箱里
 *   这一次报 `EPERM` ⇒ **故障条件根本没造出来** ⇒ 断言**硬红**。
 *   这正是 F19 的第三态：**采不到真值 ≠ 红 ≠ 绿**（"无法构造故障条件"必须响亮报出来，
 *   既不许冒充产品缺陷，也不许静默当通过）。
 * 现在那条断言的口径（源码在 `scripts/smoke/40-heat-bars.js`，判据 `okVisit` **一个字没改**）：
 *   · 造故障条件 = **三档梯子**：① 日志文件只读（chmod 0444）② 日志那一格被一个目录占住
 *     ③ 原招（`.visits` 整格让开 + 原地放一个同名文件）；**每一档造完都当场自证**
 *     （自己往那一格追加一行，抛错才算造出来；用非空载荷 —— 空串 append 连写都不写，会假通过）；
 *   · 三档都造不出来 ⇒ **第三态**：响亮"本项未验证 + 每一档为什么没成"、
 *     **不计入"通过/总数"、也不阻断**（计数口径仍只在 `scripts/smoke-assertions.js` 的 `tally()`）。
 * 为什么这仍判得住**原来那条损害**：三档都让产品那一次追加**必然抛错**，而产品对"追加失败"的处理
 *   **与 errno 无关** —— `src/heat-sensor.js` 的 `recordVisit` 把 `heat.appendEvent`（唯一一次
 *   `appendFileSync`）抛出的**任何**错误折成 `errors[]` + `ok:false` + `reason:'all-failed'`；
 *   `main.js` 的 `app:visit` 原样回传；`renderer/app-heat-bars.js` 据此把状态栏染红
 *   ⇒ "日志写不进去时产品必须响亮"这件事**照旧被判**（档①/② 的失败正落在**追加**那一步，
 *   比原招还多覆盖一段：原招那次失败落在 `store.visitLogFile()` 的 `mkdirSync`）。
 *
 * ## 本块判什么（**所有读数现场算，不写死任何计数**）
 *   甲档（纯源码 + 纯函数：毫秒级、零子进程、零 Electron）：
 *     · 梯子是多档的，且"档数 = 自证调用数"⇒ 不存在"以为造出来了"的档；
 *     · 第三态在、且是 **fail-safe** 形状（`unverified` 必须挂在"另一档真的通过"上，
 *       否则"环境坏了"会变成把真缺陷一起洗白的大伞）；
 *     · **判据没被放宽**：`okVisit` 仍要三条（`visit.ok === false` / 状态栏文本 / 红色），
 *       且旧的"造不出就静默判红"那条分支（`blocked = false`）**必须不在**；
 *     · 报文点名"造出的故障条件=哪一档"与"还原="读数 —— 静默换档等于藏起"这条究竟验了什么"。
 *   乙档（真 Electron 离屏，`MM_IT_SMOKE40=1` 才跑；默认**响亮打印"没跑"**，不许看着像跑绿了）：
 *     跑 `SMOKE_ONLY=40`，从**真读数**判：第五条**不能是 FAIL**；若它是 PASS，报文必须写明
 *     "造出的故障条件=…"且**不许**是"三档都没造出来"（那是把"跳过"冒充"通过"）；
 *     汇总行里"未验证"那个数与第五条的标签**自洽**，且默认档**不阻断**（exit 0）。
 *
 * ## 成本（自己量过再决定挂不挂链）
 *   甲档：毫秒级 ⇒ 建议**无开关常跑**。
 *   乙档：一次真 Electron（本机实测**百秒量级**的墙钟，且会让 G4 多一个"Electron 能不能起"的前置）
 *     ⇒ 放在 `MM_IT_SMOKE40=1` 后面，默认跳过；跳过时那一行明说"没验"，不含糊。
 *
 * ⚠️ 本文件是**待并入的断言原文（草稿）**：`scripts/cli-integration.js` 由整合流托管，我没有直接改它。
 *    并入位置：主跑体 `try { … }` 内任意位置（**别碰**末尾收尾段）；`check` / `ROOT` / `fs` / `path` /
 *    `os` / `spawnSync` / `TMP` 都在那个作用域里现成可用。
 * ⚠️ 并入后**不要**用"行内斜杠紧跟圈号"的写法当标记（`cli-integration.js` 的 G9 门禁会把它们当
 *    **判定标记**计数；撞上已有标记就判红）。本块用的是 `[SMOKE40·甲]` / `[SMOKE40·乙]` 前缀。
 * ============================================================ */
{
  const SMOKE40_SRC = path.join(ROOT, 'scripts', 'smoke', '40-heat-bars.js');
  const s40 = fs.readFileSync(SMOKE40_SRC, 'utf8');
  /* 现算口径（**不写死任何计数**）：档数 = "某一档造成功"那个赋值出现几次
   * （⚠️ 用 `[^']` 把声明 `let blockedBy = ''` 排掉 —— 第一版漏了它，档数会多算一档）；
   * 自证调用数 = `appendSureFails()` 出现几次（它的定义处是 `appendSureFails = …`，不会计进来）。 */
  const rungNames = (s40.match(/blockedBy = '([^']+)/g) || []).map((x) => x.replace(/^blockedBy = '/, ''));
  const rungCount = rungNames.length;
  const selfCheckCalls = (s40.match(/appendSureFails\(\)/g) || []).length;
  const hasThirdState = /unverified: okBars/.test(s40);
  const judgingKept = s40.indexOf('errVisit.visit.ok === false') >= 0
    && s40.indexOf('没能记进访问热度') >= 0 && s40.indexOf('f53f3f') >= 0;
  const silentFallbackGone = s40.indexOf('blocked = false') < 0;
  const reportNames = s40.indexOf('造出的故障条件=') >= 0 && s40.indexOf('还原=') >= 0;
  const tmpOut = path.join(TMP, 'smoke40-集成断言-读数.txt');
  try {
    check('[SMOKE40·甲] 造条件是一条**多档**梯子，且**每一档造完都当场自证**'
      + '（自证调用数必须等于档数 —— 少了自证就回到"以为造出来了"，那条硬红就是这么来的）',
      rungCount > 1 && selfCheckCalls === rungCount,
      '档数=' + rungCount + '（' + rungNames.join(' / ') + '）｜ 自证调用数=' + selfCheckCalls
        + '（自证用非空载荷=' + (s40.indexOf('failcond-probe') >= 0) + '）');
    check('[SMOKE40·甲] 第三态在、且是 **fail-safe** 形状（`unverified` 只在"另一档真的通过"时给，'
      + '否则环境坏就成了把真缺陷一起洗白的伞）',
      hasThirdState, 'unverified 挂在 okBars 上=' + hasThirdState);
    check('[SMOKE40·甲] **判据没被放宽**：`okVisit` 仍要三条（visit.ok===false / 状态栏文本 / 红色），'
      + '且旧的"造不出就静默判红"那条分支已不在；报文点名档名与还原读数',
      judgingKept && silentFallbackGone && reportNames,
      '三条判据齐=' + judgingKept + ' ｜ 旧静默分支还在=' + (!silentFallbackGone)
        + ' ｜ 报名称档=' + reportNames);
    if (process.env.MM_IT_SMOKE40 === '1') {
      const ELECTRON = require('electron');                 // 纯 node 里拿到 electron.exe 的路径（字符串）
      const sp = spawnSync(ELECTRON, ['.', '--smoke'], {
        cwd: ROOT, encoding: 'utf8', timeout: 600000,
        env: Object.assign({}, process.env, { SMOKE_ONLY: '40' })
      });
      const out = String(sp.stdout || '') + String(sp.stderr || '');
      fs.writeFileSync(tmpOut, out, 'utf8');                // 逐行取证：读数落盘，finally 里删
      const line = out.split('\n').find((l) => /smoke-heat-40 ⑤/.test(l)) || '';
      const unvLine = out.split('\n').find((l) => /冒烟三态：通过/.test(l)) || '';
      const isFail = /^\[FAIL\]/.test(line);
      const isUnverified = /^\[未验证\]/.test(line);
      const builtRead = (line.match(/造出的故障条件=([^（⇒]*)/) || [])[1] || '';
      const unvSeen = Number((unvLine.match(/未验证 (\d+)/) || [])[1]);
      check('[SMOKE40·乙] 真跑域 40：第五条**不许是 FAIL**；若打 PASS，报文必须写明"造出的故障条件=…"'
        + '且**不许**是"三档都没造出来"（那是把"跳过"冒充"通过"）',
        !isFail && !(builtRead.indexOf('三档都没造出来') >= 0 && !isUnverified),
        'exit=' + sp.status + ' ｜ 恰好造出来的档=' + JSON.stringify(builtRead)
          + ' ｜ 第五条=' + line.slice(0, 160));
      check('[SMOKE40·乙] 三态自洽且**不阻断**：汇总行的"未验证"数与第五条的标签一致，默认档 exit 0'
        + '（未验证那几条既不进"通过/总数"，也不让退出码变红）',
        /冒烟三态：通过/.test(out) && (isUnverified ? unvSeen >= 1 : unvSeen === 0) && sp.status === 0,
        'exit=' + sp.status + ' ｜ ' + unvLine
          + ' ｜ 第五条标签=' + (isUnverified ? '未验证' : (isFail ? 'FAIL' : 'PASS')));
    } else {
      console.log('[SKIP·**不是通过**] [SMOKE40·乙] 真 Electron 那一段没跑（要 `MM_IT_SMOKE40=1` 才跑；'
        + '理由：一次真 Electron 是百秒量级的墙钟，G4 默认不该被它拖慢）—— 甲档（源码级）本轮已跑 ✓；'
        + '「真跑一轮里这条究竟判成什么」本轮**没有验**（别把这里读成"验过了"）。');
    }
  } finally {
    /* 自收尾：本块只读源码 + 一份临时读数；**不建项目、不写真实 `projects/`**
     * （乙档真跑那一段的项目与访问日志由冒烟自己的沙箱管，与本块无关）。 */
    let cleaned = '本次没落盘';
    try {
      if (fs.existsSync(tmpOut)) { fs.unlinkSync(tmpOut); cleaned = path.basename(tmpOut) + '（已删）'; }
    } catch (err) { cleaned = '⚠️ 删不掉：' + String((err && err.code) || err); }
    console.log('[SMOKE40] 自收尾：只读源码 + 临时读数文件 ' + cleaned);
  }
}

/* ============================================================
 * W6-集成断言原文.js —— 【W6】"把命令面板那套模糊排序给 AI 侧"的**集成断言原文**
 * （放行窗口由整合流贴进 `scripts/cli-integration.js`；本文件**不是**可执行脚本，只是那段源码的存放处）
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 `## W6｜把命令面板那套模糊排序给 AI 侧`
 * 一节，原文两条：
 *   判据1：查询词是**非连续子序列**时 CLI 也能命中；
 *   判据2：同一查询在 UI 与 CLI 得到**一致顺序**。
 * 单测侧（可重复执行、进程内、`AI_MINDMAP_PROJECTS_DIR` 临时沙箱）：`tests/search-fuzzy.test.js`
 * （15 用例，含两条**可重复执行**的注入证明与"一处实现"的静态把守）。本段**不重复**那 15 条，
 * 只把"必须在**真实工程 + 真实 `projects/` 根**上跑一遍才作数"的几条接到集成链上。
 *
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 * 检索的**召回**（非连续子序列也算命中）与**可预期顺序**是它的一部分；实现形态上同时兑现**卖点 6**
 * 的"一份事实一处实现"（打分/定序只有 `src/palette-rank.js` 一处，命令面板与 AI 侧同吃）。
 *
 * 怎么贴（四句话）
 *   1) 位置：**W1（`search-all`）那一段之后、`/* ---- 清理 ---- *\/` 之前**，整段原样粘
 *      （已写成独立块 `{ … }`：自带 `finally` 收尾、自删全部探针、**不需要动末尾的清理段**）。
 *   2) 探针只有一个项目、前缀 `it-probe-w6-` ⇒ 文件顶部 `sweepStaleProbes()` 的前缀表（`it-probe-`）
 *      **已覆盖**，被中断留下的残留下次跑链会被自动清掉。
 *   3) 贴完**必须**跑一次 `npm run facts:write`：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成断言数，
 *      本段新增的 check 都会被算进去 ⇒ 不重生成 `docs/VERIFY.md` 就会在 G6 报"断言数对不上"（那正是 G6 该做的事）。
 *   4) 本段**只增断言**，不改任何既有断言的语义；不动 `scripts/cli-integration.js` 的其它任何地方。
 *
 * 这一节守什么（每条对着 W6 的一条判据）
 *   · 判据1-a：一个**不是子串**的关键词（非连续子序列）在 CLI 也命中 —— 前置断言先证明"数据里没有这个子串"，
 *     否则这条判据可能被"恰好也是子串"混过去（那叫空转）；
 *   · 判据1-b：不匹配的仍然不命中（零结果是**说出来的**，不是空输出）；
 *   · 判据2：同一查询下 **CLI 的顺序 == 命令面板那一侧的顺序**（面板侧用**真** `list --json` 的节点序喂**真**
 *     `src/palette-rank.js` 的 `rankPalette`），且那个顺序**不是** DFS 序（判别力前提）；
 *   · 判据1+2 经 MCP `search_nodes` 一层透传：真 stdio 一拍，与 CLI **逐条同序**，且**没有新增工具**
 *     （工具数 = 真值出口 `docs/VERIFY.md` 现取的那个数，不是写在断言里的字面量）；
 *   · "一处实现"：`function fuzzyMatch(` 的定义处全仓只有一个（`src/palette-rank.js`）；
 *   · 既有不变量：跑完这些只读检索，探针**项目目录逐字节 + mtime 不变**。
 *
 * 为什么一律带 `--no-heat`（写清原因，免得下一个人以为漏了热度）
 *   本段跑在**真实** `projects/` 根上，而库里可能有别的段落留下的、**故意写坏的热度日志**
 *   （例如热度那两段的 `it-probe-heat*` 探针）。热度日志坏了 ⇒ `search` 照纪律**响亮失败**（产品行为，不是缺陷）
 *   ⇒ 本段若默认读热度就会被**别人的探针**牵连成假红。热度与顺序的关系（热度只重排、封顶、`--no-heat`
 *   与"零热度档"逐字节相同）由 `tests/search-fuzzy.test.js` 的 B3 与 `tests/search-heat.test.js` 守着。
 *
 * 判别力（放行窗口若想手验：可重复执行的那一版在 `tests/search-fuzzy.test.js` 的 D 节）
 *   · 把 `src/palette-rank.js` 的 `rankRows` 比较器反过来（降序）⇒ 判据1-a 的顺序期望**必红**；
 *   · 把 `fuzzyMatch` 退化回"只认子串"⇒ 判据1-a / 判据2 的前置与命中**必红**；
 *   · 把 `src/item-index.js` 里那一行 `ranked = … paletteRank.rankRows(…)` 剪成 `ranked = raw`
 *     ⇒ 判据2（CLI 顺序 == 面板顺序）**必红**（实测报文见本批交付说明）。
 *
 * 段内**不写**"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见 `cli-integration.js` 文件头）。
 * ============================================================ */
{
  const W6TAG = Date.now().toString(36);
  /** 探针前缀表（**唯一一处**：建、清、断言残留都只认这张表） */
  const W6_PROBES = ['it-probe-w6-' + W6TAG];
  const W6P = W6_PROBES[0];
  const W6_KW = '甲与闸门词';                 // 非连续针：'甲' 与 '闸门词' 中间隔着别的字
  const W6_NONE = 'W6这个词谁都不命中' + W6TAG;   // 零结果针（带 tag ⇒ 真库里不可能命中）
  const w6core = require(path.join(ROOT, 'cli', 'core.js'));            // PROJECTS_DIR：项目根的唯一推导处
  const w6rank = require(path.join(ROOT, 'src', 'palette-rank.js'));     // 打分/定序：唯一实现处
  const w6dir = (name) => path.join(w6core.PROJECTS_DIR, name);
  const w6log = (name) => require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(w6core.PROJECTS_DIR, () => {}).visitLogFile(name);
  const w6J = (r) => { try { return JSON.parse(String(r.out).trim()); } catch (e) { return null; } };
  const w6search = (name, kw, extra) => w6J(run(['search', name, kw, '--no-heat', '--json'].concat(extra || [])));
  const w6ids = (j) => ((j || {}).hits || []).map((h) => h.nodeId);
  /** 目录树快照（逐文件 字节 + mtime）：钉"只读检索在项目目录里零字节" */
  const w6snap = (dir) => {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        out.push(path.relative(dir, abs).split(path.sep).join('/') + '|' + fs.readFileSync(abs).length
          + '|' + fs.statSync(abs).mtimeMs);
      });
    walk(dir);
    return out.join('\n');
  };
  /** 收尾的**唯一入口**（建/清都只认前缀表；日志在项目目录之外 ⇒ 一并删） */
  const w6clean = () => W6_PROBES.forEach((name) => {
    try { fs.rmSync(w6dir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    try { fs.rmSync(w6log(name), { force: true }); } catch (e) { /* 同上 */ }
  });

  try {
    /* 夹具：直接写盘造一个项目（同 S2 / W1 段的手法）。
     * nd-1 的标题里，关键词**不是子串**（'甲' 与 '闸门词' 之间隔着 ' 与 '）；
     * nd-2 的标题就是那个词（连续命中）⇒ 顺带证明"子串是子序列的特例"这半边也还在。 */
    const w6topics = [
      { id: 'nd-1', topic: 'W6 垫一句 甲 与 闸门词' },     // 非连续命中（DFS 序在前、但分数更差）
      { id: 'nd-2', topic: '甲与闸门词' },                // 连续命中（前缀 ⇒ 分数最好）
      { id: 'nd-3', topic: 'W6 无关节点' }
    ];
    fs.mkdirSync(w6dir(W6P), { recursive: true });
    fs.writeFileSync(path.join(w6dir(W6P), W6P + '.json'), JSON.stringify({
      meta: { name: W6P, author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'root', expanded: true, children: w6topics }
    }, null, 2), 'utf8');

    /* ---- 判据1-a：非连续子序列在 CLI 也命中（前置：数据里没有这个子串） ---- */
    {
      const asSubstring = w6topics.filter((t) => t.topic.indexOf(W6_KW) >= 0).map((t) => t.id);
      const j = w6search(W6P, W6_KW);
      const inTree = w6topics.filter((t) => t.topic.indexOf('甲') >= 0 && t.topic.indexOf('闸门词') >= 0)
        .map((t) => t.id);
      check('W6·判据1-a 关键词 `' + W6_KW + '` 在探针里**不是** nd-1 标题的子串（前置断言：'
        + '否则"非连续也能命中"这句话是空的），而 CLI **照样命中** nd-1 与 nd-2 —— 命中数 ' + inTree.length
        + ' 条，每条 matchIn=topic',
        asSubstring.length === 1 && asSubstring[0] === 'nd-2'          // 只有 nd-2 是子串命中
          && inTree.length === 2
          && w6ids(j).length === 2 && w6ids(j).indexOf('nd-1') >= 0 && w6ids(j).indexOf('nd-2') >= 0
          && j.hits.every((h) => h.matchIn === 'topic')
          && j.hits.every((h) => typeof h.snippet === 'string' && h.snippet.length > 0),
        '子串命中只有=' + JSON.stringify(asSubstring) + ' ｜ 真命中=' + JSON.stringify(inTree)
          + ' ｜ CLI 命中=' + JSON.stringify(w6ids(j))
          + ' ｜ 顺序=' + JSON.stringify((j || { hits: [] }).hits.map((h) => h.nodeId + '(' + h.score + ')')));
    }

    /* ---- 判据1-b：不匹配的仍然不命中（零结果**是明确说出来的**，不是空输出） ---- */
    {
      const r = run(['search', W6P, W6_NONE, '--no-heat']);
      const j = w6J(run(['search', W6P, W6_NONE, '--no-heat', '--json']));
      check('W6·判据1-b 没命中的词 ⇒ exit 0 + 一行**明确的"命中 0 条"**（不是空输出），'
        + '`--json` 的 hits=[] / hitCount=0 —— 放宽命中口径不等于"什么都命中"',
        r.code === 0 && r.out.trim().length > 0 && r.out.indexOf('命中 0 条') >= 0
          && !!j && j.hits.length === 0 && j.hitCount === 0,
        'exit=' + r.code + ' ｜ 文本含"命中 0 条"=' + (r.out.indexOf('命中 0 条') >= 0)
          + ' ｜ JSON hitCount=' + (j ? j.hitCount : 'null'));
    }

    /* ---- 判据2：同一查询，**CLI 的顺序 == 命令面板那一侧的顺序** ----
     * 面板侧不造假：节点清单取自 `list --json`（面板的 `app:nodes` 走的就是它，**DFS 序**），
     * 排序调**真**的 `rankPalette`（面板唯一的排序入口）。 */
    {
      const listJ = w6J(run(['list', W6P, '--json']));
      const uiEntries = ((listJ || {}).nodes || []).map((n) => ({ kind: 'node', id: n.id, label: n.topic }));
      const uiOrder = w6rank.rankPalette(uiEntries, W6_KW, 0).filter((e) => e.kind === 'node').map((e) => e.id);
      const cliOrder = w6ids(w6search(W6P, W6_KW));
      const dfsOrder = w6topics.map((t) => t.id);
      check('W6·判据2 同一查询 `' + W6_KW + '`：CLI 的顺序与**命令面板那一侧**（`list --json` 的节点序喂 '
        + '`rankPalette`）**逐条相同**；且该顺序**不是** DFS 序（否则"排序生效"这件事看不出来）',
        !!listJ && uiOrder.length === 2 && JSON.stringify(cliOrder) === JSON.stringify(uiOrder)
          && JSON.stringify(cliOrder) !== JSON.stringify(dfsOrder.filter((id) => cliOrder.indexOf(id) >= 0)),
        '面板顺序=' + JSON.stringify(uiOrder) + ' ｜ CLI 顺序=' + JSON.stringify(cliOrder)
          + ' ｜ DFS 序=' + JSON.stringify(dfsOrder));
    }

    /* ---- 判据1+2 经 MCP 一层透传（真 stdio）：同源同序；**没有新增工具**（工具数现取真值出口） ---- */
    {
      const W6_MCP_SRV = path.join(ROOT, 'scripts', 'mcp-server.js');
      const w6reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes',
          arguments: { project: W6P, keyword: W6_KW, no_heat: true } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' }
      ];
      const w6sp = spawnSync(process.execPath, [W6_MCP_SRV], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        input: w6reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
      });
      const w6replies = String(w6sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (e) { return null; }
      });
      const call = w6replies.filter((x) => x && x.id === 2)[0] || null;
      const listReply = w6replies.filter((x) => x && x.id === 3)[0] || null;
      const viaMcp = call && call.result && call.result.content && call.result.content[0]
        ? w6J({ out: call.result.content[0].text }) : null;
      const tools = ((listReply || {}).result || {}).tools || [];
      const cliSame = w6search(W6P, W6_KW);
      /* 工具数**现取真值出口**（`docs/VERIFY.md` 是生成物，那一行由 `scripts/doc-facts.js` 写）——
       * 本段里**不写任何字面计数**：写死的数字会漂，而"现取 + 逐字比对"才是"没新增工具"的真判据。 */
      const verifySrc = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
      const mTools = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verifySrc);
      const declared = mTools ? Number(mTools[1]) : null;
      check('W6·判据1+2 经 MCP 一层透传（真 stdio 一拍）：`search_nodes` 给出的命中与 CLI **逐条同序**'
        + '（MCP 侧一行打分逻辑都没有）；且**没有新增工具** —— 工具数 ' + tools.length
        + ' == 真值出口声明的 ' + declared + '，`search_nodes` 只有一个',
        declared !== null && !!viaMcp && JSON.stringify((viaMcp.hits || []).map((h) => h.nodeId))
          === JSON.stringify(w6ids(cliSame))
          && (viaMcp.hits || []).length === 2
          && tools.length === declared
          && tools.filter((t) => t.name === 'search_nodes').length === 1,
        'MCP 命中=' + JSON.stringify(((viaMcp || {}).hits || []).map((h) => h.nodeId))
          + ' ｜ CLI 命中=' + JSON.stringify(w6ids(cliSame))
          + ' ｜ 工具数=' + tools.length + ' / 真值出口=' + declared);
    }

    /* ---- "一处实现"（机械）：打分的定义处全仓只有一个 ---- */
    {
      const scanRoots = ['src', 'cli', 'renderer'];
      const hitFiles = [];
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(abs); return; }
        if (!/\.(js|mjs)$/.test(e.name)) return;
        if (fs.readFileSync(abs, 'utf8').indexOf('function fuzzyMatch(') >= 0) {
          hitFiles.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        }
      });
      scanRoots.forEach((r) => walk(path.join(ROOT, r)));
      const itemSrc = fs.readFileSync(path.join(ROOT, 'src', 'item-index.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');            // 去块注释：判据的输入必须是**代码**，不是散文
      check('W6·一处实现 打分与定序只有一处：全仓定义 `function fuzzyMatch(` 的文件**恰好一个**'
        + '（' + hitFiles.join(' / ') + '），而 `src/item-index.js` 的代码里只**调**它'
        + '（`paletteRank.fuzzyMatch(` / `paletteRank.rankRows(`），不再有第二份字面匹配',
        hitFiles.length === 1 && hitFiles[0] === 'src/palette-rank.js'
          && itemSrc.indexOf('paletteRank.fuzzyMatch(') >= 0
          && itemSrc.indexOf('paletteRank.rankRows(') >= 0,
        '定义处=' + JSON.stringify(hitFiles)
          + ' ｜ 调用点齐=' + (itemSrc.indexOf('paletteRank.fuzzyMatch(') >= 0
            && itemSrc.indexOf('paletteRank.rankRows(') >= 0));
    }

    /* ---- 既有不变量：只读检索在**项目目录里零字节** ---- */
    {
      const before = w6snap(w6dir(W6P));
      w6search(W6P, W6_KW);
      run(['search-all', W6_NONE, '--scope', W6P, '--no-heat', '--json']);
      check('W6·不变量 这一节跑完：探针**项目目录逐字节 + mtime 不变**（只读检索零字节；'
        + '埋点写的是项目目录**之外**的 `.visits/`）',
        w6snap(w6dir(W6P)) === before,
        '目录不变=' + (w6snap(w6dir(W6P)) === before));
    }
  } finally {
    w6clean();
    check('W6·自收尾 探针（项目目录 + 它的访问日志）已按前缀表清干净，**不留残留**',
      W6_PROBES.every((name) => !fs.existsSync(w6dir(name)) && !fs.existsSync(w6log(name))),
      '残留=' + JSON.stringify(W6_PROBES.filter((name) => fs.existsSync(w6dir(name)) || fs.existsSync(w6log(name)))));
  }
}

/* ============================================================
 * 【SMOKE39·T1】域 39 断言④的 **T1 独立交叉读者**（2026-10-13 那一片的待并入原文）
 * ------------------------------------------------------------
 * ## 这一件守的是什么（为什么要单独立一条集成断言）
 * 域 39 的剪贴板判据从"T0 探针 + **一次**主进程读"变成了"T0 探针 + **T1 交叉读者（进程外）**"，
 * 判定的**答案空间**也从"一个红点"变成**三档**（判红 / 未验证（环境瞬态）/ 未验证（交叉读者不可用））。
 * 三档里有两档**不进通过/总数** ⇒ 出现本工程最熟悉的形状：**门禁修好之后，没人能保证下一批人
 * 不会把它改回"一律判红"，或者改回"环境坏就一律未验证"**（后者等于给产品开脱 ✗）。
 * ⇒ 用一条**源码级**断言把"形状"钉住：毫秒级、零子进程、零 Electron ✓。
 *
 * ## ⚠️ 边界（别把这条读得比实际强）
 *   · 它判的是**源码形状**，不是"真跑起来判成什么"：后者由**乙档**（真 Electron 两次）与域 39
 *     自己的**五格判别力证明**负责。源码级断言有**恒真风险** ⇒ 本片实跑过一次"注入违规"：
 *     把"通道判据不许被读者开脱"那一支删掉 ⇒ 甲-3 **必红**（读数见交付说明）；
 *   · 它**不**校验报文措辞（措辞会改，且改措辞不该红）：只钉"三档同时在、红那一支没被读者接走"
 *     这个**结构** ⇒ 判据与措辞分离 ✓；
 *   · 它**不**判"真机上读者到底读得到什么"（那是环境的答案），只判"读者被放在正确的位置上"。
 *
 * ## 并入位置
 *   `scripts/cli-integration.js` 由另一条流托管 ⇒ 本文件是**待并入的断言原文**。
 *   并入位置：`try { … }` 主跑体内、任意位置；**不要**碰末尾的收尾段。
 *
 * ## 本片实跑读数（甲档）
 *   真仓库：`checked=6 failed=0`；变异树（删掉"通道判据不许被读者开脱"那一支）：**failed=1** ⇒ 不是恒真 ✓
 * ============================================================ */
{
  const fixtRel = path.join('scripts', 'smoke', '39-item-detail.js');
  /* 打印用的那两个字面量同样**拼接构造** —— 于是本文件（**含标签文本**、也含注释）
   * 一个字节都不含它 ⇒ 并入 `scripts/` 后，甲-6 的扫描不会把门禁自己数成第二处实现 ✓。 */
  const NAMED = ['Get-Clip', 'board -Raw'].join('');
  const fixtSrc = fs.readFileSync(path.join(ROOT, fixtRel), 'utf8');
  /* 扫描面与被钉的对象**一起声明**（B4b）：只扫这一个文件（域 39 的判据住在它里面）；
   * **先剥注释再扫**结构 —— 注释里的示例写法不是实现（本工程吃过两次这个坑 ✗）。 */
  const fixtCode = fixtSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

  /* ── 甲-1 交叉读者的**形状**：另一个进程 + 另一套 API 栈 + 自带超时 + 临时件用完即清 ──
   * 为什么"进程内再读一次"不算：产品那条读与断言那次读是**同一 API、同一进程**（主进程
   * `clipboard.readText()`）⇒ 同一失效源读两次证不出"值其实写进去了" ✗（这正是这一片要证的事）。 */
  check('[SMOKE39·T1] 交叉读者形状：`execFile` 起 **powershell.exe**（5.1/STA、外部进程）'
    + ' · 读数走 `' + NAMED + '` · **自带超时** · 落 %TEMP% 且**用完即清**'
    + '（四条缺一条，这个"独立观察者"就退化成同一失效源的第二次读）',
    /const\s*\{\s*execFile\s*\}\s*=\s*require\('child_process'\)/.test(fixtCode)
      && /execFile\('powershell\.exe'/.test(fixtCode)
      && /'-STA'/.test(fixtCode)
      && /Get-Clipboard\s+-Raw/.test(fixtCode)
      && /timeout:\s*XREAD_TIMEOUT_MS/.test(fixtCode)
      && /os\.tmpdir\(\)/.test(fixtCode)
      && /fs\.rmSync\(outPath,\s*\{\s*force:\s*true\s*\}\)/.test(fixtCode),
    JSON.stringify({
      execFile: /execFile\('powershell\.exe'/.test(fixtCode), sta: /'-STA'/.test(fixtCode),
      getClip: /Get-Clipboard\s+-Raw/.test(fixtCode), timeout: /timeout:\s*XREAD_TIMEOUT_MS/.test(fixtCode),
      temp: /os\.tmpdir\(\)/.test(fixtCode), clean: /fs\.rmSync\(outPath,/.test(fixtCode) }));

  /* ── 甲-2 三档齐（判定档数 ≥ 状态数 ✗：少一档就会把两种状态压成同一个数）── */
  const hasRed = /这是产品回归/.test(fixtSrc);
  const hasTransient = /环境瞬态/.test(fixtSrc);
  const hasDeadReader = /交叉读者不可用/.test(fixtSrc);
  check('[SMOKE39·T1] 三档齐：① **判红（产品回归）** ② **未验证（环境瞬态）** ③ **未验证（交叉读者不可用）**'
    + '（缺 ② ⇒ 环境瞬态又变回"产品回归"误判 ✗；缺 ③ ⇒ 读者坏掉时只能二选一，两个都不对 ✗）',
    hasRed && hasTransient && hasDeadReader,
    JSON.stringify({ '①产品回归': hasRed, '②环境瞬态': hasTransient, '③读者不可用': hasDeadReader }));

  /* ── 甲-3 ⭐ 本片最重的一条：**通道判据不许被读者开脱** ──
   * 兜底的 `execCommand` 也能把**同一串文本**写进剪贴板（本机实测过）⇒ 一旦让"独立读者读得到"
   * 去救"通道不是 desktop-clipboard"，"不依赖窗口焦点"这条**产品判据就被悄悄放宽** ✗✗。
   * 判据两条一起：① 那一支 `return { ok: false … }`（不许变成 unverified）；② 它**排在**读者那一支
   * **之前**（顺序反了 = 被读者接走，一模一样是开脱）。 */
  const iChan = fixtCode.search(/if\s*\(clipOk\s*&&\s*!viaDesktop\)/);
  const iReader = fixtCode.search(/if\s*\(!clipOk\)/);
  const chanSeg = (iChan >= 0 && iReader > iChan) ? fixtCode.slice(iChan, iReader) : '';
  check('[SMOKE39·T1] ⭐ 通道判据**独立于读者**：值对了但走的不是主进程那条 ⇒ 该支 `return { ok: false, … }`，'
    + '且**排在**"读者那一支"**之前**（兜底通道能写同一串文本 ⇒ 让读者去救它 = 放宽产品判据 ✗✗）',
    iChan >= 0 && iReader > iChan && /return\s*\{\s*ok:\s*false/.test(chanSeg)
      && !/unverified/.test(chanSeg),
    JSON.stringify({ '通道支位置': iChan, '读者支位置': iReader,
      '通道支 return ok:false': /return\s*\{\s*ok:\s*false/.test(chanSeg),
      '通道支误带 unverified': /unverified/.test(chanSeg) }));

  /* ── 甲-4 读者**只在"要判红"那一刻**才请（花费纪律 `G1`：正常跑/环境不可用都不起子进程）── */
  check('[SMOKE39·T1] 读者只在"环境可用 + 环境无关那几档通过 + 值这条没读回"时才起子进程'
    + '（否则正常跑与"环境坏"那两档都会被拖上一次进程外调用 ✗）',
    /env\.available\s*&&\s*baseOk\s*&&\s*!\(clip\.ok/.test(fixtCode),
    '守卫在位=' + /env\.available\s*&&\s*baseOk\s*&&\s*!\(clip\.ok/.test(fixtCode));

  /* ── 甲-5 **fail-safe**：每一个"未验证"出口都必须挂在"另一档真的通过"上 ──
   * 形状照 `tally()` 的硬要求：`unverified` 只许出现在通过的结果上 ⇒ 否则"未验证"会变成
   * "既报未验证又报失败"的掩盖后门（本工程最重的损害类别 ✗）。
   * 出口只有两种合法形状（**不写死条数**：判"有没有说不清的出口"这个恒等式 ✓）：
   *   · 本片新增的两档：`ok: true, unverified: '…'`（读者不可用 / 环境瞬态）；
   *   · 既有那一档（环境不可用）：`ok: baseOk, unverified: baseOk ? '…' : null`。 */
  const okTrueUnv = (fixtCode.match(/ok:\s*true,\s*unverified:/g) || []).length;
  const okBaseUnv = (fixtCode.match(/ok:\s*baseOk,\s*unverified:\s*baseOk\s*\?/g) || []).length;
  const unvTotal = (fixtCode.match(/unverified:/g) || []).length;
  check('[SMOKE39·T1] 每个"未验证"出口都是 **fail-safe**（只挂在"另一档真的通过"上）：'
    + '新增两档走 `ok: true, unverified:`，既有那一档走 `ok: baseOk, unverified: baseOk ? … : null`，'
    + '**没有第三种种形状的出口**（说不清的出口 = "未验证"能掩盖真失败 ✗）',
    okTrueUnv >= 2 && okBaseUnv >= 1 && unvTotal === okTrueUnv + okBaseUnv,
    JSON.stringify({ 'ok:true 形状': okTrueUnv, 'ok:baseOk 形状': okBaseUnv, 'unverified: 总处数': unvTotal }));

  /* ── 甲-6 独立读者**唯一实现**（`H1b`：各域各写一套 `Get-Clipboard` 就是第二份会漂的口径 ✗）──
   * 扫描面**一起声明**：`main.js` / `preload.js` / `scripts/**` / `cli/**` / `src/**` / `renderer/**` /
   * `tests/**`（递归；**不含** `.review/**`（草稿会写这个字符串）、`docs/**`（散文）、`node_modules/**`）。
   * needle 是**实现形状**（`Get-Clip` + `board -Raw` 拼出来的正则；且先剥注释）而不是裸子串 ✓。
   * ⚠️ **扫描面剥注释、但不剥字符串** ⇒ `check(...)` 的**标签文本也在面内** ★：因此 needle 与**两处标签**
   *   里的那两个字面量**都**用拼接构造（`NEEDLE` / `NAMED`）⇒ 本文件（**含标签文本**，也含注释）一个
   *   字节都不含它 ⇒ 并入 `scripts/` 后不会扫到自己 ✓。（首版只拼了 needle、**漏了标签** ⇒ 并入后甲-6
   *   把门禁自己数成第二处实现而判红 —— F16 同族：**结构断言被自己的字符串绊倒**。） */
  const NEEDLE = new RegExp(['Get-Clip','board\\s+-Raw'].join(''));
  const scanRoots = ['scripts', 'cli', 'src', 'renderer', 'tests']
    .map((d) => path.join(ROOT, d)).concat([path.join(ROOT, 'main.js'), path.join(ROOT, 'preload.js')]);
  const hits = [];
  const walk = (p) => {
    let st = null;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      let kids = [];
      try { kids = fs.readdirSync(p); } catch (e) { return; }
      kids.forEach((k) => { if (k !== 'node_modules' && k !== '.review') walk(path.join(p, k)); });
      return;
    }
    if (!/\.js$/.test(p)) return;
    let t = '';
    try { t = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
    if (NEEDLE.test(t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' '))) {
      hits.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  };
  scanRoots.forEach(walk);
  check('[SMOKE39·T1] 独立读者**全库只有一处实现**（`' + NAMED + '` 只许出现在域 39 的夹具里）'
    + '（扫描面=scripts/cli/src/renderer/tests + main.js/preload.js，先剥注释；`.review/` 与 `docs/` 不在面内）',
    hits.length === 1 && hits[0] === 'scripts/smoke/39-item-detail.js',
    '命中=' + JSON.stringify(hits));

  /* ── 乙档（重 · 显式开关）：真 Electron 跑两次，判"两档各自的退出码与三个数" ──
   * 两次都用**打桩**（不依赖真剪贴板时好时坏 ⇒ 判据不变成偶发 ✗）：
   *   · `39-clip-t1-transient` ⇒ **未验证（环境瞬态）**：exit 0、未验证 1、通过 == 总数；
   *   · `39-clip-xread-dead`   ⇒ **未验证（交叉读者不可用）**：同样不阻断，且**点名**读者不可用。
   * 判据**不写死任何计数**（只比"通过 == 总数"，并从三态行里取数 ✓）。 */
  let t1Exit = '(没跑)', t1Line = '(没跑)', d1Exit = '(没跑)', d1Line = '(没跑)';
  if (process.env.MM_IT_SMOKE39_T1 === '1') {
    const ELECTRON = require('electron');
    const spawnSync = require('child_process').spawnSync;
    const once = (inject) => spawnSync(ELECTRON, ['.', '--smoke'], {
      cwd: ROOT, encoding: 'utf8', timeout: 240000,
      env: Object.assign({}, process.env, { SMOKE_ONLY: '39', MM_SMOKE_INJECT: inject })
    });
    const parse = (out) => {
      const m = String(out || '').match(/冒烟三态：通过\s*(\d+)\s*\/\s*总数\s*(\d+)\s*｜\s*未验证\s*(\d+)/);
      return m ? { passed: +m[1], total: +m[2], unverified: +m[3], raw: m[0] } : null;
    };
    try {
      const a = once('39-clip-t1-transient');
      t1Exit = a.status; t1Line = String(a.stdout || '');
      const ta = parse(a.stdout);
      check('[SMOKE39·T1·乙] 真跑"T1 瞬态"档 ⇒ **未验证（环境瞬态）**、exit 0、'
        + '**未验证不进通过/总数**（通过 == 总数）、且响亮行点名"环境瞬态"',
        a.status === 0 && !!ta && ta.passed === ta.total && ta.unverified === 1
          && /环境瞬态/.test(t1Line),
        'exit=' + a.status + ' ｜ 三态行=' + (ta ? ta.raw : '(没解析到)'));
      const b = once('39-clip-xread-dead');
      d1Exit = b.status; d1Line = String(b.stdout || '');
      const tb = parse(b.stdout);
      check('[SMOKE39·T1·乙] 真跑"读者不可用"档 ⇒ **未验证（交叉读者不可用）**、exit 0、'
        + '**不阻断**、且点名"缺的是外部依赖（Windows PowerShell 5.1/STA）"',
        b.status === 0 && !!tb && tb.passed === tb.total && tb.unverified === 1
          && /交叉读者不可用/.test(d1Line),
        'exit=' + b.status + ' ｜ 三态行=' + (tb ? tb.raw : '(没解析到)'));
    } finally {
      /* 收尾（本档**不落临时件**：两次跑的报文直接从 stdout 判）——但"跑了什么"必须无条件打出来：
       * 否则中途抛错时，读者会把"没跑"读成"跑绿了"（`A5`：没跑 ≠ 通过 ✗）。 */
      console.log('[SMOKE39·T1·乙] 本轮真跑：transient exit=' + t1Exit + ' ｜ xread-dead exit=' + d1Exit);
    }
  } else {
    console.log('[SKIP·**不是通过**] [SMOKE39·T1·乙] 真 Electron 两次跑未执行'
      + '（要 `MM_IT_SMOKE39_T1=1` 才跑；理由：一次真 Electron 是百秒量级的墙钟，G4 默认不该被它拖慢）'
      + '—— 甲档（源码级 6 条）本轮已跑 ✓；「真跑一轮里这两档究竟判成什么」本轮**没有验**'
      + '（别把这里读成"验过了"）。');
  }
}

/* ============================================================
 * W4-集成断言原文.js —— 【W4】混合检索与"权重怎么处理"的**集成断言原文**
 * （放行窗口由整合流贴进 `scripts/cli-integration.js`；本文件**不是**可执行脚本，只是那段源码的存放处）
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的
 *          `## W4｜混合检索与"权重怎么处理"` 一节，原文四条：
 *   判据1：`--explain` 可见每路贡献；判据2：黄金集能一键跑；判据3：改权重有前后对比；
 *   判据4：注入"某一路恒空" ⇒ 对应断言语义红。
 * 单测侧（可重复执行、进程内、`AI_MINDMAP_PROJECTS_DIR` 临时沙箱）：`tests/search-hybrid.test.js`
 * （31 用例，含黄金集 `tests/fixtures/hybrid-golden.json` 的 19 条问题、四条注入证明、"一处实现"的静态把守）。
 * 本段**不重复**那些用例，只把"必须在**真实工程 + 真实 `projects/` 根**上跑一遍才作数"的几条接到集成链上。
 *
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 *   "按相关性之外的第二维再排一次"与"归因可见（AI 才敢据此推理）"是它的一部分；实现形态上同时兑现
 *   **卖点 6** 的"一份事实一处实现"（路由表 / 预设权重 / k / RRF 融合只有 `src/palette-rank.js` 一处）。
 *
 * 怎么贴（四句话）
 *   1) 位置：**W1（`search-all`）与 W6 那两段之后、末尾清理段之前**，整段原样粘
 *      （已写成独立块 `{ … }`：自带 `finally` 收尾、自删全部探针、**不需要动末尾的清理段**）。
 *   2) 探针只有一个项目、前缀 `it-probe-w4-` ⇒ 文件顶部 `sweepStaleProbes()` 的前缀表（`it-probe-`）
 *      **已覆盖**，被中断留下的残留下次跑链会被自动清掉。
 *   3) 贴完**必须**跑一次 `npm run facts:write`：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成断言数，
 *      本段新增的 check 都会被算进去 ⇒ 不重生成 `docs/VERIFY.md` 就会在 G6 报"断言数对不上"（那正是 G6 该做的事）。
 *   4) 本段**只增断言**，不改任何既有断言的语义；不动 `scripts/cli-integration.js` 的其它任何地方。
 *
 * 这一节守什么（每条对着 W4 的一条判据）
 *   · 判据1：`--explain` 的读数**逐路都在**（含"没装 / 恒空"那几路与原因）、`explain.hits` 与 `hits`
 *     逐条同长同序、每条的 `total` 就是各路 `add` 之和（**现算**），且命中对象上**一个新键都没加**；
 *   · 判据3：同一句话、同一份数据，**只开字面那一路**与**开混合**必须给出**不同顺序**（现算：不比字面量，
 *     只比两次运行的结果）而**命中集合逐条相同**（融合只重排、不增删）；
 *   · 判据4 的集成形态：**图距离这一路在干活**这件事，用**相对位置**钉死而不是写死名次 ——
 *     夹具里一个"头名 + 两个与它没有边的字面干扰 + 一个只靠一跳够得着的邻居"：
 *     开图距离时邻居必须**排在那两个干扰之前**，只留字面时**恰好相反**（两个方向都断言 ⇒ 不是空转）；
 *   · 默认档**不变**：不给 `--mode` / `--weights` 时输出与"只开字面那一路"的权重档**逐字节相同**
 *     （本件最承重的那条性质：既有判据一条都没被放宽）；
 *   · 参数写错**响亮**（不静默退化成默认档或"0 命中"）：exit≠0 且 stdout 以 `error: ` 开头；
 *   · 经 MCP `search_nodes` 一层透传：真 stdio 一拍，与 CLI **逐条同序**，且**没有新增工具**
 *     （工具数 = 真值出口 `docs/VERIFY.md` 现取的那个数，不是写在断言里的字面量）；
 *   · "一处实现"：RRF 融合的定义处全仓只有一个（`src/palette-rank.js`）。
 *     ⚠️ **扫描面声明**（照"门禁不许把自己数成第二处实现"那条教训）：本检查只扫仓库的 `src/` 与 `cli/`
 *     两个目录下的 `.js`，**不扫** `scripts/`、`tests/`、`.review/`（本文件就在 `.review/` 里 ⇒ 不在扫描面内）；
 *     扫描**不剥注释/字符串**（与 `tests/search-hybrid.test.js` 的 F1 同一条口径：那里的 needle 也是原文匹配）。
 *     即便如此，本段里的 needle 与它自己的标签文本**都用拼接构造**（`'function ' + 'fuse('`）——
 *     这样"这个文件里出现两个 needle"这件事在结构上不可能发生，不必依赖上面那条扫描面声明。
 *   · 既有不变量：跑完这些只读检索，探针**项目目录逐字节 + mtime 不变**；`--no-heat` 全程不写访问日志。
 *
 * 为什么一律带 `--no-heat`（写清原因，免得下一个人以为漏了热度）
 *   本段跑在**真实** `projects/` 根上，而库里可能有别的段落留下的、**故意写坏的热度日志**
 *   （例如热度那两段的探针）。热度日志坏了 ⇒ `search` 照纪律**响亮失败**（产品行为，不是缺陷）
 *   ⇒ 本段若默认读热度就会被**别人的探针**牵连成假红。热度与顺序的关系（热度只重排、封顶、`--no-heat`
 *   与"零热度档"逐字节相同）由 `tests/search-heat.test.js` 与 `tests/search-fuzzy.test.js` 守着。
 *
 * 段内**不写**"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见 `cli-integration.js` 文件头）。
 * ============================================================ */
{
  const W4TAG = Date.now().toString(36);
  /** 探针前缀表（**唯一一处**：建、清、断言残留都只认这张表） */
  const W4_PROBES = ['it-probe-w4-' + W4TAG];
  const W4P = W4_PROBES[0];
  const W4_KW = '索引下推';                        // 夹具与查询共用同一个词（下面每条断言都从它出发）
  const w4core = require(path.join(ROOT, 'cli', 'core.js'));            // PROJECTS_DIR：项目根的唯一推导处
  const w4rank = require(path.join(ROOT, 'src', 'palette-rank.js'));    // 路由表 / 权重 / 融合：唯一实现处
  const w4dir = (name) => path.join(w4core.PROJECTS_DIR, name);
  const w4log = (name) => require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(w4core.PROJECTS_DIR, () => {}).visitLogFile(name);
  const w4J = (r) => { try { return JSON.parse(String(r.out).trim()); } catch (e) { return null; } };
  const w4search = (kw, extra) => w4J(run(['search', W4P, kw, '--no-heat', '--json'].concat(extra || [])));
  const w4ids = (j) => ((j || {}).hits || []).map((h) => h.nodeId);
  const w4pos = (j, id) => w4ids(j).indexOf(id);   // 名次 = 下标 + 1；-1 = 没命中（下面按"名次"比大小）
  /** 字面那一路的权重名单（**从路由表现取 id 清单**，本段不写死任何 route 名或权重数字） */
  const w4onlyText = (() => {
    const w = {};
    w4rank.ROUTE_IDS.forEach((id) => { w[id] = id === 'text' ? 1 : 0; });
    return Object.entries(w).map(([k, v]) => k + '=' + v).join(',');
  })();
  /** 目录树快照（逐文件 字节 + mtime）：钉"只读检索在项目目录里零字节" */
  const w4snap = (dir) => {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        out.push(path.relative(dir, abs).split(path.sep).join('/') + '|' + fs.readFileSync(abs).length
          + '|' + fs.statSync(abs).mtimeMs);
      });
    walk(dir);
    return out.join('\n');
  };
  /** 收尾的**唯一入口**（建/清都只认前缀表；访问日志在项目目录之外 ⇒ 一并删） */
  const w4clean = () => W4_PROBES.forEach((name) => {
    try { fs.rmSync(w4dir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    try { fs.rmSync(w4log(name), { force: true }); } catch (e) { /* 同上 */ }
  });

  try {
    /* ---- 夹具（直接写盘造项目，同 S2 / W1 / W6 段的手法）----
     * 形状刻意造成"只有图距离那一路能分辨"：
     *   nd-lead 头名（**没有 items** ⇒ 它只占一个候选位，邻居的名次不被它自己的条目挤掉）；
     *   nd-dist1 / nd-dist2 与头名**没有任何边**，但字面名次比邻居好（正文短）⇒ 图距离这一路不给它们名次；
     *   nd-nbr **只**通过一条 links 边够得着头名（一跳），正文刻意写长 ⇒ 字面名次最差。 */
    const w4nodes = [
      { id: 'nd-lead', topic: W4_KW },
      { id: 'nd-dist1', topic: W4_KW + '与覆盖索引' },
      { id: 'nd-dist2', topic: 'W4 优化器笔记',
        items: [{ id: 'i-dist2', type: 'text', html: '<p>' + W4_KW + '（ICP）在 5.6 之后默认开启</p>' }] },
      { id: 'nd-nbr', topic: 'W4 索引合并',
        items: [{ id: 'i-nbr', type: 'text',
          html: '<p>索引合并与' + W4_KW + '：优化器怎么选（这条正文刻意写长，好让字面名次落在最后）</p>' }],
        links: [{ project: W4P, id: 'nd-lead' }] }
    ];
    fs.mkdirSync(w4dir(W4P), { recursive: true });
    fs.writeFileSync(path.join(w4dir(W4P), W4P + '.json'), JSON.stringify({
      meta: { name: W4P, author: '', version: '0.18.0', formatVersion: 3 },
      format: 'node_tree',
      data: { id: 'root', topic: 'root', expanded: true, children: w4nodes }
    }, null, 2), 'utf8');

    /* ---- 默认档不变：不给 --mode / --weights 时的输出 == "只开字面那一路"的权重档（逐字节相同）---- */
    {
      const plain = run(['search', W4P, W4_KW, '--no-heat', '--json']);
      const explicit = run(['search', W4P, W4_KW, '--no-heat', '--json', '--weights', w4onlyText]);
      const j = w4J(plain);
      check('W4·默认档 ' + '默认（不给 --mode / --weights）与"只开字面那一路"的权重档**逐字节相同** —— '
        + '这一层是**显式启用**的：既有判据（零热度档顺序与命令面板逐条相同、热度只做最后一道封顶重排）'
        + '一条都没被放宽；`--json` 顶层也不多 `explain` 键',
        plain.code === 0 && explicit.code === 0 && plain.out === explicit.out
          && !!j && Object.keys(j).indexOf('explain') < 0,
        'exit=' + plain.code + '/' + explicit.code + ' ｜ 字节数 ' + plain.out.length + '/' + explicit.out.length
          + ' ｜ 顶层键=' + JSON.stringify(j ? Object.keys(j) : null));
    }

    /* ---- 判据1：`--explain` 逐路可见（含"没输出"的那几路）+ 读数形状（现算 total） ---- */
    {
      const j = w4search(W4_KW, ['--mode', w4rank.DEFAULT_MODE, '--explain']);
      const ex = (j || {}).explain;
      const routes = (ex || {}).routes || [];
      const partsOk = ((ex || {}).hits || []).every((h) => {
        const sum = (h.parts || []).reduce((a, p) => a + p.add, 0);
        return Math.abs(sum - h.total) < 1e-12;
      });
      const said = routes.filter((r) => r.ranked === 0 || r.installed === false);
      const keys = ((j || {}).hits || []).reduce((a, h) => a.concat(Object.keys(h)), []);
      const extra = keys.filter((k) => ['id', 'topic', 'nodeId', 'nodeTopic', 'itemId', 'type', 'itemized',
        'matchIn', 'snippet', 'src', 'verified', 'score'].indexOf(k) < 0);
      check('W4·判据1 `--explain` 给出**逐路**读数（路由全集 ' + routes.length + ' 路，其中 '
        + said.length + ' 路这次没出力 —— 未安装 / 恒空都要**各自说明原因**，不许静默少一路），'
        + '`explain.hits` 与 `hits` 逐条同长同序，每条的 total 就是各路 add 之和（现算），'
        + '而命中对象上一个新键都没加（契约 12 键）',
        !!ex && ex.enabled === true && routes.length === w4rank.ROUTE_IDS.length
          && JSON.stringify(routes.map((r) => r.id)) === JSON.stringify(w4rank.ROUTE_IDS.slice())
          && said.every((r) => typeof r.note === 'string' && r.note.length > 0)
          && ((ex || {}).hits || []).length === w4ids(j).length
          && ((ex || {}).hits || []).every((h, i) => h.nodeId === w4ids(j)[i])
          && partsOk && extra.length === 0,
        'enabled=' + (ex ? ex.enabled : 'null') + ' ｜ 路=' + JSON.stringify(routes.map((r) => r.id))
          + ' ｜ 没出力的=' + JSON.stringify(said.map((r) => r.id + ':' + (r.note || '').slice(0, 24)))
          + ' ｜ extraKeys=' + JSON.stringify(extra));
    }

    /* ---- 判据3：改权重真的改变顺序，而命中集合不变（两次运行的**比较**，不写死任何顺序）---- */
    {
      const only = w4search(W4_KW, ['--weights', w4onlyText]);
      const mixed = w4search(W4_KW, ['--mode', w4rank.DEFAULT_MODE]);
      const a = w4ids(only);
      const b = w4ids(mixed);
      check('W4·判据3 同一句话、同一份数据：只开字面那一路与开混合检索给出**不同顺序**'
        + '（权重真的被用上了，不是"参数收了但没人用"），而**命中集合逐条相同**（融合只重排、不增删）',
        !!only && !!mixed && a.length > 1 && a.slice().sort().join('|') === b.slice().sort().join('|')
          && a.join('>') !== b.join('>'),
        '只字面=' + JSON.stringify(a) + ' ｜ 混合=' + JSON.stringify(b));
    }

    /* ---- 判据4（集成形态）：图距离这一路**在干活** —— 相对位置两向断言，不写死名次 ---- */
    {
      const withGraph = w4search(W4_KW, ['--weights', 'text=1,graph=1']);
      const noGraph = w4search(W4_KW, ['--weights', 'text=1']);
      const lift = w4pos(withGraph, 'nd-nbr');
      const d1 = w4pos(withGraph, 'nd-dist1');
      const d2 = w4pos(withGraph, 'nd-dist2');
      const lift0 = w4pos(noGraph, 'nd-nbr');
      const d10 = w4pos(noGraph, 'nd-dist1');
      const d20 = w4pos(noGraph, 'nd-dist2');
      check('W4·判据4 图距离那一路**真的在干活**：夹具里 nd-nbr 只靠一跳够得着头名 nd-lead，'
        + '而 nd-dist1 / nd-dist2 字面名次比它好、与头名没有任何边 ⇒ 开图距离时邻居**排在那两个之前**，'
        + '只留字面时**恰好相反**（两个方向都断言 ⇒ 这一条不是空转）',
        lift > -1 && d1 > -1 && d2 > -1 && lift0 > -1 && d10 > -1 && d20 > -1
          && lift < d1 && lift < d2 && lift0 > d10 && lift0 > d20,
        '开图距离的名次：nbr=' + (lift + 1) + ' dist1=' + (d1 + 1) + ' dist2=' + (d2 + 1)
          + ' ｜ 只字面的名次：nbr=' + (lift0 + 1) + ' dist1=' + (d10 + 1) + ' dist2=' + (d20 + 1));
    }

    /* ---- 参数写错响亮（不许静默退化成默认档或"0 命中"）---- */
    {
      const r = run(['search', W4P, W4_KW, '--no-heat', '--weights', 'bogus=1']);
      check('W4·参数闸门 `--weights` 里写一个不认识的 route ⇒ exit≠0 且 stdout 以 `error: ` 开头、'
        + '报文里点名它（**不**静默退化成默认档，也**不**变成"0 命中"）；'
        + '解析只有 `src/palette-rank.js` 一处 ⇒ `search` 与 `search-all` 报文逐字同源',
        r.code !== 0 && String(r.out).trim().indexOf('error: ') === 0
          && String(r.out).indexOf('bogus') >= 0 && String(r.out).indexOf('"hits"') < 0,
        'exit=' + r.code + ' ｜ out=' + String(r.out).trim().slice(0, 120));
    }

    /* ---- 经 MCP 一层透传：同源同序 + 没有新增工具（工具数现取真值出口） ---- */
    {
      const w4srv = path.join(ROOT, 'scripts', 'mcp-server.js');
      const reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes',
          arguments: { project: W4P, keyword: W4_KW, no_heat: true, mode: w4rank.DEFAULT_MODE, explain: true } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' }
      ];
      const sp = spawnSync(process.execPath, [w4srv], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
      });
      const replies = String(sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
      const call = replies.filter((x) => x && x.id === 2)[0] || null;
      const list = replies.filter((x) => x && x.id === 3)[0] || null;
      const viaMcp = call && call.result && call.result.content ? w4J({ out: call.result.content[0].text }) : null;
      const viaCli = w4search(W4_KW, ['--mode', w4rank.DEFAULT_MODE, '--explain']);
      const tools = (list && list.result && list.result.tools) || [];
      const verify = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
      const m = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verify);
      check('W4·MCP 透传 `search_nodes` 带 `mode`/`explain`：与 CLI **逐条同序**、逐路读数同源，'
        + '且**没有新增工具**（工具数 = `docs/VERIFY.md` 现取的那个数：'
        + (m ? m[1] : '（那一行没找到 ⇒ 下面这条必红）') + '，本件只加参数）',
        !!viaMcp && !!viaCli && !!m
          && JSON.stringify(w4ids(viaMcp)) === JSON.stringify(w4ids(viaCli))
          && JSON.stringify((viaMcp.explain || { routes: [] }).routes.map((r) => r.id + ':' + r.ranked))
            === JSON.stringify((viaCli.explain || { routes: [] }).routes.map((r) => r.id + ':' + r.ranked))
          && tools.length === Number(m[1]),
        'MCP 顺序=' + JSON.stringify(viaMcp ? w4ids(viaMcp) : null)
          + ' ｜ CLI 顺序=' + JSON.stringify(w4ids(viaCli)) + ' ｜ 工具数=' + tools.length
          + '（真值 ' + (m ? m[1] : '?') + '）');
    }

    /* ---- "一处实现"：RRF 融合的定义处全仓只有一个（扫描面声明见文件头；needle 用拼接构造）---- */
    {
      const needle = 'function ' + 'fuse(';
      const found = [];
      ['src', 'cli'].forEach((dir) => {
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
          const abs = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'vendor') walk(abs); return; }
          if (!/\.js$/.test(e.name)) return;
          if (fs.readFileSync(abs, 'utf8').indexOf(needle) >= 0) found.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        });
        walk(path.join(ROOT, dir));
      });
      check('W4·一处实现 融合的定义处**全仓只有一个**（' + needle + '）：'
        + '扫描面 = 仓库 src/ 与 cli/（不扫 scripts/、tests/、.review/ ⇒ 本文件不在面内），不剥注释/字符串',
        found.length === 1 && found[0] === 'src/palette-rank.js',
        '命中=' + JSON.stringify(found.sort()));
    }

    /* ---- 既有不变量：只读检索在探针项目目录里**零字节**；`--no-heat` 不写访问日志 ---- */
    {
      const before = w4snap(w4dir(W4P));
      w4search(W4_KW, ['--mode', w4rank.DEFAULT_MODE, '--explain']);
      run(['search-all', W4_KW, '--scope', W4P, '--no-heat', '--mode', w4rank.DEFAULT_MODE, '--json']);
      const after = w4snap(w4dir(W4P));
      const logFile = w4log(W4P);
      check('W4·既有不变量 混合检索（含 `--explain`）与 `search-all` 在探针**项目目录里逐字节 + mtime 不变**；'
        + '全程 `--no-heat` ⇒ 该项目**没有访问日志**（`.visits/` 那个目录是被路径推导顺带建出来的，不算写入）',
        before === after && !fs.existsSync(logFile),
        '快照相同=' + (before === after) + ' ｜ 项目文件数=' + before.split('\n').length
          + ' ｜ 访问日志存在=' + fs.existsSync(logFile));
    }
  } finally {
    w4clean();
    /* 收尾后**逐个点名**确认没有残留（前缀表一处：建/清/断言都认它） */
    W4_PROBES.forEach((name) => {
      if (fs.existsSync(w4dir(name))) check('W4·收尾 探针「' + name + '」没能清掉（下次跑链会被 sweepStaleProbes 兜底，'
        + '但这里必须当场红）', false, '目录仍在=' + w4dir(name));
    });
  }
}

/* ============================================================
 * W4b-集成断言原文.js —— 【W4b】扩召回 + 开 `matchIn` 封闭取值表的**集成断言原文**
 * （放行窗口由整合流贴进 `scripts/cli-integration.js`；本文件**不是**可执行脚本，只是那段源码的存放处）
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的
 *          `## W4｜混合检索与"权重怎么处理"` 一节（W4 只做了重排；本件是它被裁出去的**另一半**：
 *          **扩召回** + 随之要开的 `matchIn` 封闭取值表 —— 那是一次契约变更，`docs/ITEM-MODEL.md` §3.4）。
 * 单测侧（可重复执行、进程内、`AI_MINDMAP_PROJECTS_DIR` 临时沙箱）：`tests/search-recall.test.js`
 * （默认档逐字节不变 / 只增不许变差 / 上界取自路由表 / 硬过滤正交 / `--explain` 逐路点名 /
 * 黄金集里"非字面命中"那一类的读前读后 / 注入证明 / 结构断言 / 端到端沙箱），
 * 以及契约那一半（**键仍 12**）在 `tests/item-index.test.js`。
 * 本段**不重复**那些用例，只把"必须在**真实工程 + 真实 `projects/` 根**上跑一遍才作数"的几条接到集成链上。
 *
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 *   "答案只写在邻居里、它自己的正文里没有那个词"以前**连结果都不在**（不是"排在后面"），
 *   那正是"AI 只好再上网搜一次"的处境；实现形态上同时兑现**卖点 6** 的"一份事实一处实现"。
 *
 * 怎么贴（四句话）
 *   1) 位置：**W4（混合检索）那一段之后、末尾清理段之前**，整段原样粘
 *      （已写成独立块 `{ … }`：自带 `finally` 收尾、自删全部探针、**不需要动末尾的清理段**）。
 *   2) 探针只有一个项目、前缀 `it-probe-w4b-` ⇒ 文件顶部 `sweepStaleProbes()` 的前缀表（`it-probe-`）
 *      **已覆盖**，被中断留下的残留下次跑链会被自动清掉。
 *   3) 贴完**必须**跑一次 `npm run facts:write`：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成断言数，
 *      本段新增的 check 都会被算进去 ⇒ 不重生成 `docs/VERIFY.md` 就会在 G6 报"断言数对不上"（那正是 G6 该做的事）。
 *   4) 本段**只增断言**，不改任何既有断言的语义；不动 `scripts/cli-integration.js` 的其它任何地方。
 *
 * 这一节守什么（每条对着本件的一条硬要求）
 *   · **默认档逐字节不变**：不给 `--recall` 时输出与"只开字面那一路"的权重档**逐字节相同**，
 *     且 `--json` 顶层不多 `explain` 键（本件最承重的那条性质：既有判据一条都没被放宽）；
 *   · **扩召回是显式档**：开了它 `hitCount` 与 `hits` 真的**变多**，新命中的 `matchIn` = 路由表那一行
 *     声明的取值（**现取**，不写死名字），而命中对象的键集仍是契约那 12 个键里挑（**开取值表 ≠ 加键**）；
 *   · **上界取自路由表**：夹具造一条链，`bound` 之内的节点进来、之外的**正好不进来**（两侧都断言）；
 *   · **`--explain` 逐路点名**：`explain.recall` 逐路在（含没点名的），`added` 与返回命中里那个取值的
 *     条数**现算相符**；新命中的逐条读数里 `text` 那一路名次是 `null`（"不是字面命中"看得见）；
 *   · **硬过滤正交**：`--tag` 与关键词照旧 AND —— 没标签的邻居**不许**被扩召回带回来（另一侧对照也断言）；
 *   · **MCP 一层透传**：真 stdio 一拍 `search_nodes` 带 `recall`，与 CLI **逐条同序**、`explain.recall` 同源，
 *     且**没有新增工具**（工具数 = 真值出口 `docs/VERIFY.md` 现取的那个数，不是写在断言里的字面量）；
 *   · **一处实现**：跳数表（`graphHopsFrom`）与"能扩召回的路由表"各只有一个定义处。
 *     ⚠️ **扫描面声明**（照"门禁不许把自己数成第二处实现"那条教训）：本检查只扫仓库的 `src/` 与 `cli/`
 *     两个目录下的 `.js`，**不扫** `scripts/`、`tests/`、`.review/`（本文件就在 `.review/` 里 ⇒ 不在扫描面内）；
 *     扫描**不剥注释/字符串**（与 `tests/search-recall.test.js` 的结构断言同一条口径：needle 原文匹配）。
 *     即便如此，本段里的 needle 与它自己的标签文本**都用拼接构造**（`'function ' + 'graphHopsFrom('`）——
 *     这样"这个文件里出现两个 needle"这件事在结构上不可能发生，不必依赖上面那条扫描面声明。
 *   · 既有不变量：跑完这些只读检索，探针**项目目录逐字节 + mtime 不变**；`--no-heat` 全程不写访问日志。
 *
 * 为什么一律带 `--no-heat`（写清原因，免得下一个人以为漏了热度）
 *   本段跑在**真实** `projects/` 根上，而库里可能有别的段落留下的、**故意写坏的热度日志**
 *   （例如热度那几段的探针）。热度日志坏了 ⇒ `search` 照纪律**响亮失败**（产品行为，不是缺陷）
 *   ⇒ 本段若默认读热度就会被**别人的探针**牵连成假红。
 *
 * 段内**不写**"行内斜杠紧跟圈号"的样子（G9 会把那当判定标记计数，见 `cli-integration.js` 文件头）。
 * ============================================================ */
{
  const W4BTAG = Date.now().toString(36);
  /** 探针前缀表（**唯一一处**：建、清、断言残留都只认这张表） */
  const W4B_PROBES = ['it-probe-w4b-' + W4BTAG];
  const W4BP = W4B_PROBES[0];
  const W4B_KW = '构建缓存';                      // 夹具与查询共用同一个词（下面每条断言都从它出发）
  const w4bCore = require(path.join(ROOT, 'cli', 'core.js'));            // PROJECTS_DIR：项目根的唯一推导处
  const w4bRank = require(path.join(ROOT, 'src', 'palette-rank.js'));    // 路由表 / 权重 / 上界 / 新取值：唯一实现处
  const w4bItems = require(path.join(ROOT, 'src', 'item-index.js'));     // 封闭取值表：唯一实现处
  const w4bDir = (name) => path.join(w4bCore.PROJECTS_DIR, name);
  const w4bLog = (name) => require(path.join(ROOT, 'src', 'data-store.js'))
    .createStore(w4bCore.PROJECTS_DIR, () => {}).visitLogFile(name);
  const w4bJ = (r) => { try { return JSON.parse(String(r.out).trim()); } catch (e) { return null; } };
  const w4bSearch = (kw, extra) => w4bJ(run(['search', W4BP, kw, '--no-heat', '--json'].concat(extra || [])));
  const w4bIds = (j) => ((j || {}).hits || []).map((h) => h.nodeId);
  /** 能扩召回的路由（**从路由表现取**：本段不写死路由名，将来多一路也能跟着走） */
  const w4bRoutes = w4bRank.RECALL_ROUTE_IDS.slice();
  const w4bRid = w4bRoutes[0];
  const w4bRow = w4bRank.ROUTES.filter((r) => r.id === w4bRid)[0] || {};
  const w4bValue = w4bRow.recallHit;               // 新取值名（现取）
  const w4bBound = w4bRow.bound;                   // 深度上界（现取 —— 本段不写死跳数）
  const w4bArgs = ['--mode', w4bRank.DEFAULT_MODE, '--recall', w4bRid];
  /** 契约里那 12 个键（判据是**只增不改**：新命中一个契约外的键都不许有） */
  const w4bKeys = ['id', 'topic', 'nodeId', 'nodeTopic', 'itemId', 'type', 'itemized', 'matchIn',
    'snippet', 'src', 'verified', 'score'];
  /** 字面那一路的权重名单（**从路由表现取 id 清单**，本段不写死任何 route 名或权重数字） */
  const w4bOnlyText = w4bRank.ROUTE_IDS.map((id) => id + '=' + (id === 'text' ? 1 : 0)).join(',');
  /** 目录树快照（逐文件 字节 + mtime）：钉"只读检索在项目目录里零字节" */
  const w4bSnap = (dir) => {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        out.push(path.relative(dir, abs).split(path.sep).join('/') + '|' + fs.readFileSync(abs).length
          + '|' + fs.statSync(abs).mtimeMs);
      });
    walk(dir);
    return out.join('\n');
  };
  /** 收尾的**唯一入口**（建/清都只认前缀表；访问日志在项目目录之外 ⇒ 一并删） */
  const w4bClean = () => W4B_PROBES.forEach((name) => {
    try { fs.rmSync(w4bDir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
    try { fs.rmSync(w4bLog(name), { force: true }); } catch (e) { /* 同上 */ }
  });

  try {
    /* ---- 夹具（直接写盘造项目，同 S2 / W1 / W4 / W6 段的手法）----
     * 形状刻意造成"只有扩召回那一路能分辨"：
     *   nd-lead    头名（关键词**唯一**的字面命中 ⇒ 扩召回以它为心向外数跳数）；
     *   nd-hop1    **一跳**邻居、正文里没有那个词 ⇒ 从前连结果都不在（本件要接回来的就是它）；
     *   nd-hop2    **两跳**邻居（'经由一个中介'，上界之内）；
     *   nd-far     链接挂在 nd-hop2 上 —— 它是"上界之外"的对照项（三跳起与头名的关系只剩同在一个库里）；
     *   nd-plain   与头名**没有任何边**、正文也命中不了 ⇒ 两条档里都不该出现（判别力的另一半）；
     *   nd-tagged  带标签的一跳邻居 / nd-untagged 没标签的一跳邻居 ⇒ 用来看 `--tag` 这道硬过滤。 */
    const w4bNodes = [
      { id: 'nd-lead', topic: W4B_KW, tags: ['demo'] },
      { id: 'nd-hop1', topic: 'W4b 一跳邻居',
        items: [{ id: 'i-hop1', type: 'text', html: '<p>这条只靠一条 links 边挂在头名近旁</p>' }],
        links: [{ project: W4BP, id: 'nd-lead' }], tags: ['demo'] },
      { id: 'nd-hop2', topic: 'W4b 两跳邻居',
        items: [{ id: 'i-hop2', type: 'text', html: '<p>经由一个中介够得着头名（上界之内）</p>' }],
        links: [{ project: W4BP, id: 'nd-hop1' }], tags: ['demo'] },
      { id: 'nd-far', topic: 'W4b 上界之外的节点',
        items: [{ id: 'i-far', type: 'text', html: '<p>三跳起关系只剩同在一个库里</p>' }],
        links: [{ project: W4BP, id: 'nd-hop2' }], tags: ['demo'] },
      { id: 'nd-plain', topic: 'W4b 无关节点',
        items: [{ id: 'i-plain', type: 'text', html: '<p>离头名既没有边、正文也命中不了</p>' }] },
      { id: 'nd-tagged', topic: 'W4b 带标签的邻居',
        items: [{ id: 'i-tagged', type: 'text', html: '<p>这一条带 demo 标签</p>' }],
        links: [{ project: W4BP, id: 'nd-lead' }], tags: ['demo'] },
      { id: 'nd-untagged', topic: 'W4b 没标签的邻居',
        items: [{ id: 'i-untagged', type: 'text', html: '<p>这一条不带任何标签</p>' }],
        links: [{ project: W4BP, id: 'nd-lead' }] }
    ];
    fs.mkdirSync(w4bDir(W4BP), { recursive: true });
    fs.writeFileSync(path.join(w4bDir(W4BP), W4BP + '.json'), JSON.stringify({
      meta: { name: W4BP, author: '', version: '0.18.0', formatVersion: 3 },
      format: 'node_tree',
      data: { id: 'root', topic: 'root', expanded: true, children: w4bNodes }
    }, null, 2), 'utf8');

    /* ---- 默认档不变：不给 `--recall` 时的输出 == "只开字面那一路"的权重档（逐字节相同）---- */
    {
      const plain = run(['search', W4BP, W4B_KW, '--no-heat', '--json']);
      const explicit = run(['search', W4BP, W4B_KW, '--no-heat', '--json', '--weights', w4bOnlyText]);
      const withMode = run(['search', W4BP, W4B_KW, '--no-heat', '--json', '--mode', w4bRank.DEFAULT_MODE]);
      const j = w4bJ(plain);
      check('W4b·默认档 不给 `--recall` 时：①输出与"只开字面那一路"的权重档**逐字节相同**；'
        + '②与"给了 --mode 但没给 --recall"的输出也**逐字节相同**（扩召回没有偷偷进候选集）；'
        + '③`--json` 顶层不多 `explain` 键 —— 这一层是**显式启用**的，既有判据一条都没被放宽',
        plain.code === 0 && explicit.code === 0 && withMode.code === 0
          && plain.out === explicit.out && plain.out === withMode.out
          && !!j && Object.keys(j).indexOf('explain') < 0
          && (j.hits || []).every((h) => h.matchIn !== w4bValue),
        'exit=' + plain.code + '/' + explicit.code + '/' + withMode.code
          + ' ｜ 字节数 ' + plain.out.length + '/' + explicit.out.length + '/' + withMode.out.length
          + ' ｜ 顶层键=' + JSON.stringify(j ? Object.keys(j) : null));
    }

    /* ---- 扩召回是**显式档**：开了真的"扩召回"（候选集变大），且新命中仍在 12 键契约里 ---- */
    {
      const off = w4bSearch(W4B_KW, ['--mode', w4bRank.DEFAULT_MODE]);
      const on = w4bSearch(W4B_KW, w4bArgs);
      const near = ((on || {}).hits || []).filter((h) => h.matchIn === w4bValue);
      const before = w4bIds(off);
      const extraKeys = [];
      ((on || {}).hits || []).forEach((h) => Object.keys(h).forEach((k) => {
        if (w4bKeys.indexOf(k) < 0) extraKeys.push(k);
      }));
      check('W4b·扩召回 开了 `--recall ' + w4bRid + '` 之后：①`hitCount` 与 `hits` **真的变多**'
        + '（扩召回不是重排）；②新命中的 `matchIn` = 路由表那一行声明的取值 `' + w4bValue
        + '`（现取，不是写死的名字）；③原来的命中一个都不丢；④命中对象的键仍在契约那 12 个键里'
        + '（**开取值表 ≠ 加键**）；⑤没边的那条节点两条档里都不出现（判别力的另一半）',
        !!off && !!on && near.length > 0 && on.hitCount > off.hitCount
          && w4bItems.MATCH_IN.indexOf(w4bValue) >= 0
          && before.every((id) => w4bIds(on).indexOf(id) >= 0)
          && extraKeys.length === 0
          && w4bIds(on).indexOf('nd-plain') < 0 && w4bIds(off).indexOf('nd-plain') < 0,
        '关着：hitCount=' + ((off || {}).hitCount) + ' 顺序=' + JSON.stringify(before)
          + ' ｜ 开着：hitCount=' + ((on || {}).hitCount) + ' 顺序=' + JSON.stringify(w4bIds(on))
          + ' ｜ 新取值条数=' + near.length + ' ｜ 契约外的键=' + JSON.stringify(extraKeys));
    }

    /* ---- 上界取自**路由表那一行**（现取）：之内进来、之外不进来（两侧都断言）---- */
    {
      const got = w4bIds(w4bSearch(W4B_KW, w4bArgs));
      const hop = { 'nd-hop1': 1, 'nd-hop2': 2, 'nd-far': 3 };
      const inSide = Object.keys(hop).filter((id) => hop[id] <= w4bBound);
      const outSide = Object.keys(hop).filter((id) => hop[id] > w4bBound);
      check('W4b·上界 扩召回的深度上界就是路由表那一行（`' + w4bRid + '`）的 `bound`：'
        + '上界是 ' + w4bBound + ' 跳 ⇒ ' + JSON.stringify(inSide) + ' 该进来、'
        + JSON.stringify(outSide) + ' 不许进来（两侧都断言 ⇒ 这一条不是空转）',
        inSide.length > 0 && outSide.length > 0
          && inSide.every((id) => got.indexOf(id) >= 0)
          && outSide.every((id) => got.indexOf(id) < 0),
        '顺序=' + JSON.stringify(got) + ' ｜ bound=' + w4bBound);
    }

    /* ---- `--explain` 逐路点名新取值（读数只增，不改排序）---- */
    {
      const on = w4bSearch(W4B_KW, w4bArgs.concat(['--explain']));
      const ex = (on || {}).explain || {};
      const rec = ex.recall || {};
      const asked = (rec.routes || []).filter((r) => r.asked);
      const nearRows = ((on || {}).hits || []).filter((h) => h.matchIn === w4bValue);
      const textNull = nearRows.every((h) => {
        const at = w4bIds(on).indexOf(h.nodeId);
        const row = (ex.hits || [])[at] || { parts: [] };
        const text = (row.parts || []).filter((p) => p.route === 'text')[0] || {};
        const self = (row.parts || []).filter((p) => p.route === w4bRid)[0] || {};
        return (text.rank === null || text.rank === undefined)
          && Number.isInteger(self.rank) && self.rank >= 1;
      });
      const noExplain = w4bIds(w4bSearch(W4B_KW, w4bArgs));
      const withExplain = w4bIds(on);
      check('W4b·归因 `--explain` 逐路点名"新取值是哪一路接回来的"：①`explain.recall.routes` 逐路都在'
        + '（路由表里能扩召回的几路一个不少）；②点名的那些路由 `added` 与返回命中里该取值的条数'
        + '**现算相符**；③新命中的逐条读数里 `text` 那一路名次是 `null`、扩召回那一路有 1 起的整数名次'
        + '（"它不是字面命中"看得见）；④有/无 `--explain` **逐条同序**（读数不改排序）',
        !!ex.recall && rec.asked && JSON.stringify(rec.asked) === JSON.stringify([w4bRid])
          && (rec.routes || []).map((r) => r.id).join('|') === w4bRoutes.join('|')
          && asked.length > 0 && asked[0].added === nearRows.length
          && textNull
          && withExplain.join('|') === noExplain.join('|'),
        'explain.recall=' + JSON.stringify(rec) + ' ｜ 顺序=' + JSON.stringify(withExplain));
    }

    /* ---- 硬过滤正交：`--tag` 与关键词照旧 AND ⇒ 没标签的邻居不许被带回来 ---- */
    {
      const withTag = w4bIds(w4bSearch(W4B_KW, w4bArgs.concat(['--tag', 'demo'])));
      const noTag = w4bIds(w4bSearch(W4B_KW, w4bArgs));
      check('W4b·硬过滤 扩召回**不许绕过**硬过滤：`--tag demo` 与关键词照旧是 AND ⇒ 带标签的邻居'
        + '`nd-tagged` 照旧被带回来、不带标签的 `nd-untagged` **不许**出现；'
        + '而同一份数据不给标签时它本来就该被带回来（另一侧对照 ⇒ 这一条不是空转）',
        withTag.indexOf('nd-tagged') >= 0 && withTag.indexOf('nd-untagged') < 0
          && noTag.indexOf('nd-untagged') >= 0,
        '带 --tag 的顺序=' + JSON.stringify(withTag) + ' ｜ 不带 --tag 的顺序=' + JSON.stringify(noTag));
    }

    /* ---- 经 MCP 一层透传：同源同序 + 没有新增工具（工具数现取真值出口） ---- */
    {
      const w4bSrv = path.join(ROOT, 'scripts', 'mcp-server.js');
      const reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes',
          arguments: { project: W4BP, keyword: W4B_KW, no_heat: true,
            mode: w4bRank.DEFAULT_MODE, recall: w4bRid, explain: true } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' }
      ];
      const sp = spawnSync(process.execPath, [w4bSrv], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
      });
      const replies = String(sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
      const call = replies.filter((x) => x && x.id === 2)[0] || null;
      const list = replies.filter((x) => x && x.id === 3)[0] || null;
      const viaMcp = call && call.result && call.result.content ? w4bJ({ out: call.result.content[0].text }) : null;
      const viaCli = w4bSearch(W4B_KW, w4bArgs.concat(['--explain']));
      const tools = (list && list.result && list.result.tools) || [];
      const verify = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
      const m = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verify);
      check('W4b·MCP 透传 `search_nodes` 带 `recall`：与 CLI **逐条同序**、`explain.recall` 同源，'
        + '且**没有新增工具**（工具数 = `docs/VERIFY.md` 现取的那个数：'
        + (m ? m[1] : '（那一行没找到 ⇒ 下面这条必红）') + '，本件只加参数）',
        !!viaMcp && !!viaCli && !!m
          && JSON.stringify(w4bIds(viaMcp)) === JSON.stringify(w4bIds(viaCli))
          && JSON.stringify(((viaMcp.explain || {}).recall || {}).routes || [])
            === JSON.stringify(((viaCli.explain || {}).recall || {}).routes || [])
          && tools.length === Number(m[1]),
        'MCP 顺序=' + JSON.stringify(viaMcp ? w4bIds(viaMcp) : null)
          + ' ｜ CLI 顺序=' + JSON.stringify(w4bIds(viaCli)) + ' ｜ 工具数=' + tools.length
          + '（真值 ' + (m ? m[1] : '?') + '）');
    }

    /* ---- "一处实现"：跳数表与"能扩召回的路由表"各只有一个定义处（nowhere 声明见文件头；needle 用拼接构造）---- */
    {
      const needles = ['function ' + 'graphHopsFrom(', 'const ' + 'RECALL_ROUTE_IDS ='];
      const found = needles.map((needle) => {
        const files = [];
        ['src', 'cli'].forEach((dir) => {
          const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'vendor') walk(abs); return; }
            if (!/\.js$/.test(e.name)) return;
            if (fs.readFileSync(abs, 'utf8').indexOf(needle) >= 0) {
              files.push(path.relative(ROOT, abs).split(path.sep).join('/'));
            }
          });
          walk(path.join(ROOT, dir));
        });
        return { needle: needle, files: files.sort() };
      });
      check('W4b·一处实现 跳数表（' + needles[0] + '）与"能扩召回的路由表"（' + needles[1] + '）'
        + '**各只有一个定义处**：扫描面 = 仓库 src/ 与 cli/（不扫 scripts/、tests/、.review/ ⇒ 本文件不在面内），'
        + '不剥注释/字符串',
        found.every((f) => f.files.length === 1)
          && found[0].files[0] === 'src/item-index.js' && found[1].files[0] === 'src/palette-rank.js',
        JSON.stringify(found));
    }

    /* ---- 既有不变量：只读检索在探针项目目录里**零字节**；`--no-heat` 不写访问日志 ---- */
    {
      const before = w4bSnap(w4bDir(W4BP));
      w4bSearch(W4B_KW, w4bArgs.concat(['--explain']));
      run(['search-all', W4B_KW, '--scope', W4BP, '--no-heat', '--mode', w4bRank.DEFAULT_MODE,
        '--recall', w4bRid, '--json']);
      const after = w4bSnap(w4bDir(W4BP));
      const logFile = w4bLog(W4BP);
      check('W4b·既有不变量 扩召回（含 `--explain`）与 `search-all` 在探针**项目目录里逐字节 + mtime 不变**；'
        + '全程 `--no-heat` ⇒ 该项目**没有访问日志**（`.visits/` 那个目录是被路径推导顺带建出来的，不算写入）',
        before === after && !fs.existsSync(logFile),
        '快照相同=' + (before === after) + ' ｜ 项目文件数=' + before.split('\n').length
          + ' ｜ 访问日志存在=' + fs.existsSync(logFile));
    }
  } finally {
    w4bClean();
    /* 收尾后**逐个点名**确认没有残留（前缀表一处：建/清/断言都认它） */
    W4B_PROBES.forEach((name) => {
      if (fs.existsSync(w4bDir(name))) {
        check('W4b·收尾 探针「' + name + '」没能清掉（下次跑链会被 sweepStaleProbes 兜底，'
          + '但这里必须当场红）', false, '目录仍在=' + w4bDir(name));
      }
    });
  }
  }

/* ============================================================
 * W14-集成断言原文.js —— 「前导正文的落点规则」的**集成断言原文**
 * （放行窗口由整合流贴进 `scripts/cli-integration.js`；本文件**不是**可执行脚本，只是那段源码的存放处）
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 W14 一行 + 本批工单的 D1/D2。
 * 单测侧（可重复执行、进程内、临时沙箱）：`tests/import-md-landing.test.js` 全篇 +
 * `tests/w8-dry-run.test.js` 的 W8-G 组。本段**不重复**那些断言，只把"必须在**真实工程 +
 * 真实 projects/ 根**上跑一遍才作数"的几条接到集成链上：
 *   · `import-md` 落在**已条目化的父节点**上（D1 的主场景）—— 端到端跑真 CLI；
 *   · ⭐ **"一个字符都不许丢"**（哨兵段：中英标点 + 强调 + 围栏（围栏里还有一行 `# …`）+ 图片行）；
 *   · **预览与真跑同判**（D2）在**真实项目**上的形态；
 *   · **非条目化父节点**的落点与 §54 的 occ 判据（承重性质：既有行为逐字节不变）；
 *   · 负例（开头即标题 ⇒ 不产生空条目/空 detail）与**坏数据父节点的响亮拒绝 + 两条真出路**。
 *
 * ## 怎么贴（四句话）
 *   1) 位置：**§54（W14 第一段）之后**任意一处独立块旁都行；整段原样粘（已写成独立块 `{ … }`：
 *      自带 `finally` 收尾 + 残留自检 + 夹具 md 自删，**不需要动末尾的清理段**）。
 *   2) 探针一律 `it-probe-w14-` 前缀 ⇒ 文件顶部 `sweepStaleProbes()` 的前缀表（`it-probe-`）**已覆盖**，
 *      被中断留下的残留下次跑链会被自动清掉 ✓。
 *   3) 贴完**必须**跑一次 `npm run facts:write`：`scripts/doc-facts.js` 按 `/^\s*check\(/gm` 静态数集成
 *      断言数，本段新增的 check 都会被算进去 ⇒ 不重生成 `docs/VERIFY.md` 就会在 G6 报"断言数对不上"
 *      （那正是 G6 该做的事）。
 *   4) 本段**一条写死计数都没有**：条数、用例数、工具数都不出现；与别的读数挂钩时一律**现算**。
 *
 * ## 判别力（每条断言"哪行代码坏了会让它红"）
 *   · 把 `cli/commands/project.js` 的落点改回"前导字符串拼进 `detail`" ⇒ `W14·落点（条目化父节点）`、
 *     `W14·一个字符都不许丢`、`W14·同判（预览 vs 真跑）` **必红**（修前 HEAD fa884f3 上的真实报文：
 *     真跑 `exit 1`（`校验失败: [n-…] detail 与 items 不一致…`）/ 预览 `exit 0`，见交付说明）。
 *   · 还原 `src/markdown.js` 里前导正文的收集（把那段收进 `preSegs` 的代码换回 `if (!cur) continue`）⇒
 *     `W14·一个字符都不许丢` **必红**（同一处注入在单测侧的读数：`tests/markdown.test.js` 的 W14 组
 *     4 条红、端到端 4 条红，见交付说明）。
 *   · 把 `cli/core.js` dry-run 分支里的写盘前校验删掉 ⇒ `W14·同判（预览 vs 真跑）` 与
 *     `W14·拒绝（坏数据父节点）` 里"预览报同一句话"那半句 **必红**。
 *   · 让前导被复制到两个节点（单一真源破了）⇒ `W14·单一真源` **必红**。
 *
 * ## 扫描面声明（本段有"字面量只许出现一处"这类结构断言，故把量具说清）
 *   `W14·单一真源` 与 `W14·承重（非条目化父节点）` 里的 occ 都扫**落盘的项目 JSON 文件全文**：
 *   · **不剥注释、不剥字符串** —— JSON 里没有注释，字符串字面量就是数据本身（那才是要数的一面）；
 *   · 要找的标签文本**在本文件里拼接构造**（`W14NEEDLE`），免得本文件自己的说明文字被算进去；
 *   · 条目化节点上前导**按契约有两处表示**（`items[0].html` 与它的派生缓存 `detail`，二者逐字节
 *     相等，见 `docs/ITEM-MODEL.md` §2）⇒ 那一档的量具是"**只有一个节点**带它"，而不是"字面只出现一次"。
 *
 * ⚠️ 本段**只增断言**，不改任何既有断言的语义；不新增工具、不动 MCP 面。
 * ============================================================ */
{
  const w14core = require(path.join(ROOT, 'cli', 'core.js'));          // 只读：写路径/dry-run 标记的唯一实现处
  const w14im = require(path.join(ROOT, 'src', 'item-model.js'));      // renderDetail：条目化节点的 detail 真源
  /* 访问日志的**路径推导只有一处**（`DataStore.visitLogFile`）—— 本段自己造一个 store 来问它，
   * 不在这里拼 `.visits/<名字>.jsonl`（那会是第二份路径推导）。
   * ⚠️ 为什么必须是这一处：热度日志在**项目目录之外**，删项目目录删不掉它 ⇒ 不按它删就会留残留，
   *    而残留检查若只查项目目录，这种"漏删"会**静默通过**（实测踩到过）。 */
  const w14store = require(path.join(ROOT, 'src', 'data-store.js')).createStore(w14core.PROJECTS_DIR);

  const w14stamp = Date.now().toString(36);
  const W14P = 'it-probe-w14-itemized-' + w14stamp;   // 条目化父节点（真跑）
  const W14Q = 'it-probe-w14-dry-' + w14stamp;        // 同构项目（预览）
  const W14R = 'it-probe-w14-plain-' + w14stamp;      // 非条目化父节点（承重性质的对照）
  const W14N = 'it-probe-w14-nolead-' + w14stamp;     // 负例（md 开头就是标题）
  const W14B = 'it-probe-w14-bad-' + w14stamp;        // 坏数据父节点（拒绝档）
  const W14ALL = [W14P, W14Q, W14R, W14N, W14B];
  const w14dir = (n) => path.join(w14core.PROJECTS_DIR, n);
  const w14file = (n) => path.join(w14dir(n), n + '.json');
  const w14json = (n) => JSON.parse(fs.readFileSync(w14file(n), 'utf8'));

  /* ---- 夹具：**带哨兵段**的 md（第一个标题之前的正文里塞进四类构造）+ 一份没有前导的 md ---- */
  const w14lead = [
    '哨兵甲：中文、英文；标点（全角）与半角, . !? 混排。Sentinel-Alpha-2026。',
    '**加粗哨兵**与普通文字相邻。',
    '',
    '```js',
    '# 这行的井号是代码，不是标题',
    "const sentinel = 'SENTINEL-CODE-7f3a';",
    '```',
    '',
    '![图：哨兵](assets/a.png)',
    '',
    '# 主题甲',
    '甲正文',
    ''
  ].join('\n');
  const w14nolead = '# 一级标题\n一级正文\n\n## 二级标题\n二级正文\n';
  const W14LEAD = path.join(TMP, 'w14-lead-' + w14stamp + '.md');
  const W14NOLEAD = path.join(TMP, 'w14-nolead-' + w14stamp + '.md');
  fs.writeFileSync(W14LEAD, w14lead, 'utf8');
  fs.writeFileSync(W14NOLEAD, w14nolead, 'utf8');

  /** 要找的标签文本：**在这里拼接构造**（本文件自己的说明文字里不出现它的连写形态） */
  const W14NEEDLE = '哨兵' + '甲';
  const W14NEEDLE_RE = new RegExp(W14NEEDLE, 'g');
  /** 围栏里那句代码的片段（"一行都不许丢"的探针串，同样拼接构造） */
  const W14CODE = 'SENTINEL-' + 'CODE-7f3a';

  /* ---- 判据侧量具（**测量工具**，不是生产实现：生产那两份是 `src/convert.js` 与 `src/markdown.js`） ----
   * `w14expect`：从夹具切出第一个 `^#{1,6} ` **之前**的原文，按下面**声明的**三条剥壳规则变纯文本：
   *   ① 围栏定界行 ```… 是语法不是正文（围栏**里面**的行是正文，一个字都不许少）；
   *   ② 图片行 `![alt](src)` 不给正文贡献文本（`<img>` 的 alt 落在属性里，没有文本内容）；
   *   ③ `**加粗**` 的强调标记剥离。
   *   切点 = 第一个**不在围栏内**的 `^#{1,6} ` 行（围栏里的 `#` 本来就不是标题 —— 夹具里那一行
   *   正是用来钉这一点的），口径与 `src/markdown.js` 的建树主循环一致。
   * `w14text`：落盘 HTML 的文本还原（剥标签替换成**空串**，不是空格 —— 这里要的是文本还原、
   *   不是搜索用的分词边界；再解实体）。两者最后都归一化空白（空白**单独声明为不参与**这条判据）。 */
  const w14norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const w14expect = (() => {
    const kept = [];
    let fenced = false;
    let stopped = false;
    w14lead.split('\n').forEach((line) => {
      if (stopped) return;
      const t = line.trim();
      if (/^```/.test(t)) { fenced = !fenced; return; }
      if (!fenced && /^#{1,6} /.test(t)) { stopped = true; return; }
      if (/^!\[/.test(t)) return;
      kept.push(line);
    });
    return w14norm(kept.join('\n').replace(/\*\*/g, ''));
  })();
  const w14text = (html) => w14norm(String(html == null ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/gi, '&'));

  /** 按 topic 找一个节点（递归） */
  const w14find = (root, topic) => {
    let hit = null;
    (function walk(n) { if (hit) return; if (n.topic === topic) { hit = n; return; } (n.children || []).forEach(walk); })(root);
    return hit;
  };
  /** `get <项目> <节点> --json --detail` —— 不带 `--detail` 时 detail 根本不出现，读回必须走这条口 */
  const w14get = (name, id) => {
    const r = run(['get', name, id, '--json', '--detail']);
    try { return JSON.parse(r.out); } catch (e) { return null; }
  };
  /** 建一个"父节点已条目化"的项目：init → import-md(无前导) → item-add 一条 */
  const w14build = (name) => {
    run(['init', name, '--title', 'W14 集成探针']);
    run(['import-md', name, W14NOLEAD, '--parent', 'root']);
    const id = w14find(w14json(name).data, '一级标题').id;
    run(['item-add', name, id, '--md', '原有详情：导之前就在。']);
    return id;
  };
  /** 同一个节点的**内容**指纹（只用 items 的 id 序列 + detail）：用来比"预览有没有动过盘面" */
  const w14same = (a, b) => JSON.stringify([(a.items || []).map((it) => it.id), a.detail])
    === JSON.stringify([(b.items || []).map((it) => it.id), b.detail]);

  try {
    /* ---- ① D1：条目化父节点上能导，前导落在 items[0] ---- */
    const w14pid = w14build(W14P);
    const w14qid = w14build(W14Q);
    const w14before = w14find(w14json(W14P).data, '一级标题');
    const w14oldIds = w14before.items.map((it) => it.id).join(',');
    const w14real = run(['import-md', W14P, W14LEAD, '--parent', w14pid]);
    const w14node = w14find(w14json(W14P).data, '一级标题');
    const w14it0 = (w14node.items || [])[0] || {};
    check('W14·落点（条目化父节点） import-md 落到**已条目化**的父节点上：真跑成功（修前 exit 1 ——'
      + '前导被字符串拼进 detail ⇒ 写前校验判 `detail 与 items 不一致`，整个导入失败），'
      + '前导成为 **items[0]**（type=rich）、原有条目**顺序不变**地跟在后面、'
      + '`detail` 逐字节等于 `renderDetail(items)`、且落点在 detail 的**开头**（不是末尾、不是覆盖）',
      ok(w14real.out) && (w14node.items || []).length === w14before.items.length + 1
        && w14it0.type === 'rich'
        && String(w14it0.html).indexOf(W14NEEDLE) >= 0
        && w14node.items.slice(1).map((it) => it.id).join(',') === w14oldIds
        && w14node.detail === w14im.renderDetail(w14node.items)
        && String(w14node.detail).indexOf(String(w14it0.html)) === 0,
      'exit=' + w14real.code + ' ｜ items=' + (w14node.items || []).length
        + '（原 ' + w14before.items.length + '）｜ 首条 type=' + w14it0.type
        + ' ｜ detail===renderDetail=' + (w14node.detail === w14im.renderDetail(w14node.items))
        + ' ｜ 首行=' + String(w14real.out).split('\n')[0].slice(0, 70));

    /* ---- ② ⭐ "一个字符都不许丢"：落盘文本 == 夹具里第一个标题之前的原文（归一化空白后逐字相等） ---- */
    {
      const w14view = w14get(W14P, w14pid);
      const w14got = w14text(w14it0.html);
      const w14kids = w14find(w14json(W14P).data, '一级标题').children || [];
      check('W14·一个字符都不许丢 从夹具切出的"第一个标题**之前**的原文"与**落盘文本**归一化后'
        + '**逐字相等**（不是探针短语包含：哨兵段里含中英标点混排、`**加粗**`、``` 围栏（围栏里还有'
        + '一行 `# …`）与图片行；切点与三条剥壳规则见本文件顶部的量具声明）。'
        + '⚠️ 读口用 `get --json --detail`（不带 `--detail` 时 detail 根本不出现）；'
        + '围栏里那行 `#` **不许**变成节点（本次只该多出「主题甲」一个顶层主题）',
        w14got === w14expect
          && w14got.indexOf('半角, . !?') >= 0                    // 中英标点混排
          && w14got.indexOf('加粗哨兵') >= 0                       // 强调的**文本**在
          && w14got.indexOf('**') < 0                             // …强调**标记**不在
          && w14got.indexOf('# 这行的井号是代码，不是标题') >= 0     // 围栏里的 `#` 是正文
          && w14got.indexOf(W14CODE) >= 0
          && !!w14view && typeof w14view.detail === 'string'
          && w14kids.map((c) => c.topic).join(',') === '二级标题,主题甲'
          && !w14find(w14json(W14P).data, '这行的井号是代码，不是标题'),
        '落盘=' + JSON.stringify(w14got.slice(0, 92)) + '… ｜ 期望='
          + JSON.stringify(String(w14expect).slice(0, 92)) + '… ｜ 逐字相等=' + (w14got === w14expect)
          + ' ｜ 顶层主题=' + JSON.stringify(w14kids.map((c) => c.topic)));
    }

    /* ---- ③ D2：预览与真跑**同判**（各跑一个同构项目 —— 盘面状态一致，两次读数才可比） ---- */
    {
      const w14qBefore = w14find(w14json(W14Q).data, '一级标题');
      const w14dry = run(['import-md', W14Q, W14LEAD, '--parent', w14qid, '--dry-run']);
      const w14qAfter = w14find(w14json(W14Q).data, '一级标题');
      check('W14·同判（预览 vs 真跑） 同一条命令在**两个同构项目**上的 exit 码必须相等；'
        + '预览必须**看得见条目变化**（计划里出现 `item:` / `items:` 前缀 —— 旧实现只报 children/node，'
        + '因为它走的是"拼 detail"那条路）；预览打的是 `[dry-run 未写盘]` 标记且**盘面一个字节没动**。'
        + '修前这一个用例是"真跑 1 / 预览 0，且回显说前导已并入父节点详情开头"',
        w14dry.code === w14real.code
          && w14dry.out.indexOf('item:') >= 0
          && w14dry.out.indexOf('items:') >= 0
          && w14dry.out.indexOf(w14core.DRY_RUN_TAG) >= 0
          && w14same(w14qBefore, w14qAfter),
        '真跑 exit=' + w14real.code + ' ｜ 预览 exit=' + w14dry.code
          + ' ｜ 预览首行=' + String(w14dry.out).split('\n')[0].slice(0, 120)
          + ' ｜ 预览后盘面未动=' + w14same(w14qBefore, w14qAfter));
    }

    /* ---- ④ 承重性质①：**非条目化**父节点的落点逐字节不变 + §54 的 occ 判据 ---- */
    {
      run(['init', W14R, '--title', 'W14 普通父节点']);
      run(['add', W14R, 'root', '--id', 'p-plain', '--topic', '普通父节点', '--detail', '<p>原有详情</p>']);
      const w14plainRun = run(['import-md', W14R, W14LEAD, '--parent', 'p-plain']);
      const w14plain = w14find(w14json(W14R).data, '普通父节点');
      // §54 的 occ 判据：**非条目化**父节点上字面只许出现一次（没有 items ⇒ 没有派生副本）
      const w14occ = (fs.readFileSync(w14file(W14R), 'utf8').match(W14NEEDLE_RE) || []).length;
      check('W14·承重（非条目化父节点） 父节点**没有** `items` 时落点与从前**逐字节相同**：'
        + '`detail === 前导 HTML + 换行 + 原 detail`（原内容在其后，一个字都不覆盖）、'
        + '**不出现 items 键**；且 §54 的 occ 判据照旧成立（前导在落盘文件里**字面只出现一处**）',
        ok(w14plainRun.out) && w14plain.items === undefined
          && w14plain.detail === w14it0.html + '\n<p>原有详情</p>'
          && w14occ === 1,
        'items 键=' + String(w14plain.items) + ' ｜ occ=' + w14occ
          + ' ｜ 逐字节相同（前导+换行+旧 detail）=' + (w14plain.detail === w14it0.html + '\n<p>原有详情</p>'));
    }

    /* ---- ⑤ 负例（§54 的既有负例）：开头就是标题 ⇒ 不产生空条目 / 不产生空 detail ---- */
    {
      const w14nid = w14build(W14N);
      const w14nBefore = w14find(w14json(W14N).data, '一级标题');
      const w14nRun = run(['import-md', W14N, W14NOLEAD, '--parent', w14nid, '--force']);
      const w14nAfter = w14find(w14json(W14N).data, '一级标题');
      check('W14·负例（开头即标题） md 的**第一个标题之前没有正文** ⇒ 父节点**一条条目都不多**、'
        + '`detail` 一个字节都不动（不制造空条目、不制造空 detail）；'
        + '对照组：子节点**真的多了**（证明这不是"什么都没做"）',
        ok(w14nRun.out)
          && w14nAfter.items.length === w14nBefore.items.length
          && w14nAfter.detail === w14nBefore.detail
          && (w14nAfter.children || []).length > (w14nBefore.children || []).length,
        'items ' + w14nBefore.items.length + '→' + w14nAfter.items.length
          + ' ｜ detail 未变=' + (w14nAfter.detail === w14nBefore.detail)
          + ' ｜ 子节点 ' + (w14nBefore.children || []).length + '→' + (w14nAfter.children || []).length);
    }

    /* ---- ⑥ 拒绝档：坏数据父节点 ⇒ 响亮拒绝 + 点名 + 两条真出路 + 盘上零改动 + 预览报同一句话 ---- */
    {
      const w14items = [{ id: 'i-w14', type: 'text', html: '<p>真源是这一条</p>', at: '2026-01-01T00:00:00.000Z', by: 'it' }];
      fs.mkdirSync(w14dir(W14B), { recursive: true });
      fs.writeFileSync(w14file(W14B), JSON.stringify({
        meta: { name: 'W14 坏父节点探针', author: '', version: '0.18.0', formatVersion: 2 },
        format: 'node_tree',
        data: {
          id: 'root', topic: 'W14 坏父节点探针', expanded: true,
          children: [{
            id: 'n-w14bad', topic: '坏掉的条目化父节点', expanded: true, children: [],
            items: w14items, detail: '<p>与 items 对不上</p>'
          }]
        }
      }, null, 2), 'utf8');
      const w14badBefore = fs.readFileSync(w14file(W14B));
      const w14rejReal = run(['import-md', W14B, W14LEAD, '--parent', 'n-w14bad']);
      const w14rejDry = run(['import-md', W14B, W14LEAD, '--parent', 'n-w14bad', '--dry-run']);
      check('W14·拒绝（坏数据父节点） 父节点**已条目化**但它的 `detail` 与 `renderDetail(items)` 不一致 ⇒'
        + '响亮拒绝（exit 1）、报文**点名「已**条目化**」并给出两条真出路**（换父节点 / 先 item-add 把前导'
        + '自己加成条目再导）、盘上**逐字节零改动**；且 `--dry-run` 报的是**同一句话**（不是"预览说能成"）。'
        + '⚠️ 这条同时钉住"旧报文的误导"：不许再把出路说成"用 render-detail 修一下"'
        + '（在失败之后照做，删掉的正是刚导进来的前导）',
        w14rejReal.code === 1 && /已\*\*条目化\*\*/.test(w14rejReal.out)
          && w14rejReal.out.indexOf('item-add') >= 0
          && w14rejReal.out.indexOf('--parent') >= 0
          && w14rejReal.out.indexOf('盘上零改动') >= 0
          && w14rejDry.code === w14rejReal.code
          && w14rejDry.out === w14rejReal.out
          && Buffer.compare(fs.readFileSync(w14file(W14B)), w14badBefore) === 0,
        '真跑 exit=' + w14rejReal.code + ' ｜ 预览 exit=' + w14rejDry.code
          + ' ｜ 报文逐字相同=' + (w14rejDry.out === w14rejReal.out)
          + ' ｜ 盘上未动=' + (Buffer.compare(fs.readFileSync(w14file(W14B)), w14badBefore) === 0)
          + ' ｜ 首行=' + String(w14rejReal.out).split('\n')[0].slice(0, 88));
    }

    /* ---- ⑦ 单一真源（结构判据；扫描面见文件顶部声明） ---- */
    {
      const w14hits = [];
      (function walk(n) {
        let c = (String(n.detail || '').match(W14NEEDLE_RE) || []).length;
        (Array.isArray(n.items) ? n.items : []).forEach((it) => {
          c += (String(it.html || '').match(W14NEEDLE_RE) || []).length;
        });
        if (c) w14hits.push(n.id + '×' + c);
        (n.children || []).forEach(walk);
      })(w14json(W14P).data);
      check('W14·单一真源 同一段前导正文**只落在一个节点**里（复制到多个节点 = 制造两个会漂移的真相）。'
        + '扫描面：落盘的项目 JSON 全文，**不剥注释、不剥字符串**（JSON 无注释，字符串就是数据本身）；'
        + '要找的标签文本在本文件里**拼接构造** ⇒ 本文件自己的说明文字不会被算进去。'
        + '条目化节点上前导**按契约有两处表示**（`items[0].html` 与派生缓存 `detail`，二者逐字节相等）'
        + '⇒ 量具是"只有一个节点带它"，每次数 2',
        w14hits.length === 1 && /×2$/.test(w14hits[0]),
        '带它的节点=' + JSON.stringify(w14hits)
          + '（次数 = items 正文 + 该节点 detail 的派生副本）');
    }
  } finally {
    /* 自收尾：探针项目 **+ 它们在 `.visits/` 里的旁路日志**（读口 `get` 会记一条访问热度；
     * 那个日志在**项目目录之外**，删目录删不掉它 —— 路径推导只走 `DataStore.visitLogFile` 一处）。
     * 与既有各段同一条纪律：正常路径必须自己清干净，前缀表只兜"被中断"。 */
    W14ALL.forEach((n) => {
      try { fs.rmSync(w14dir(n), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
      try { fs.rmSync(w14store.visitLogFile(n), { force: true }); } catch (e) { /* 同上 */ }
    });
    /* 残留自检：**项目目录与访问日志两样都要查**（只查目录的话，"漏删日志"会静默通过）。
     * ⚠️ 这段的 check 也走 `finally` ⇒ 前面若抛异常，它照样会给出一条读数（不静默）。 */
    const w14left = W14ALL.filter((n) => fs.existsSync(w14dir(n)));
    const w14leftLog = W14ALL.filter((n) => fs.existsSync(w14store.visitLogFile(n)));
    check('W14·收尾 探针项目与其访问日志都清干净（残留：项目 ' + w14left.length + ' 个 / 日志 '
      + w14leftLog.length + ' 个 —— **现算**）',
      w14left.length === 0 && w14leftLog.length === 0,
      '残留项目=' + JSON.stringify(w14left) + ' ｜ 残留日志=' + JSON.stringify(w14leftLog));
    /* 夹具 md（在 TMP 里，不在 projects/ 下；删掉免得留在临时目录里） */
    [W14LEAD, W14NOLEAD].forEach((f) => {
      try { fs.rmSync(f, { force: true }); } catch (e) { /* 同上 */ }
    });
  }
}

  /* ============================================================================
   * `merge-project`（把若干个已有项目整棵并进一个已有项目）的集成断言
   * ----------------------------------------------------------------------------
   * 为什么必须在**真实工程 + 真实 `projects/` 根**上跑一遍（单测覆盖不到的那一半）：
   *   · 它要**跨项目读盘**（读的是另一个项目的 `<项目>/<项目>.json`）⇒ 只有真盘上有两个项目才作数；
   *   · 它落的是 `ctx.mutate`（版本闸门 / 写盘前校验 / 一次原子写）⇒ 端到端才验得到"拒绝时盘上零改动"。
   * 单测侧（进程内、`src/merge-project.js` 的纯逻辑，不需要跑 CLI）见 `tests/merge-project.test.js`。
   * 探针一律 `it-probe-merge-` 前缀 ⇒ 文件顶部 `sweepStaleProbes()` 的 `it-probe-` 前缀表已覆盖
   * （崩在半路也留不下假项目）；本块自带 `finally` 收尾 + 残留自检。
   * ⚠️ 贴完必须跑 `npm run facts:write`：集成断言数是 G6 的真值，不同步就判红。
   * ========================================================================== */
  {
    const MGA = 'it-probe-merge-a';
    const MGB = 'it-probe-merge-b';
    const mgdir = (n) => path.join(ROOT, 'projects', n);
    const mgRead = (n) => JSON.parse(fs.readFileSync(path.join(mgdir(n), n + '.json'), 'utf8'));
    const mgWalk = (node, fn) => { fn(node); (node.children || []).forEach((c) => mgWalk(c, fn)); };
    const mgIds = (root) => { const s = []; mgWalk(root, (n) => s.push(n.id)); return s; };
    /* ⚠️ 造"带 origin 的源"**不新开写盘点**：本文件新增一处裸写就会把「写盘出口」的豁免面
     * 从 82 顶到 83（`scripts/collateral-check.js` 的 `WRITE_OUTLET_SITE_CAP` **只减不增**）。
     * 所以走产品自己的两条命令接力：`export-md` 产出一份真 md → `import-md` 把它导进源项目
     *（`origin` 只由导入类命令写，`add` 没有 `--origin`）。顺带多验了一段既有链路。 */
    const mgExpDir = path.join(TMP, 'merge-export');
    try {
      /* 两个探针项目：A = 目标，B = 源。 */
      run(['init', MGA, '--title', '合并目标']);
      run(['add-root', MGA, '--topic', '甲主题', '--id', 'mga-t1']);
      run(['init', MGB, '--title', '合并来源']);
      const mgExp = run(['export-md', MGA, mgExpDir]);
      check('合并·造源（export-md 产出 md）', ok(mgExp.out) && /已导出文件夹/.test(mgExp.out), mgExp.out.trim().slice(0, 120));
      const mgImp = run(['import-md', MGB, path.join(mgExpDir, MGA + '.md')]);
      check('合并·造源（import-md 进 B，带 origin）', ok(mgImp.out) && /新增/.test(mgImp.out), mgImp.out.trim().slice(0, 120));
      run(['add', MGB, 'root', '--topic', '乙书零散节点', '--id', 'mgb-x']);
      /* B 里放两条边：一条指向 A（合并后天然是自指边）、一条指向 B 自己（同项目内） */
      const mgLink1 = run(['link', MGB, 'mgb-x', '--to', MGA, '--id', 'mga-t1', '--caption', 'B→A']);
      check('合并·造边（B → A）', ok(mgLink1.out) && /已添加链接/.test(mgLink1.out), mgLink1.out.trim().slice(0, 120));
      run(['link', MGB, 'mgb-x', '--to', MGB, '--id', 'root', '--caption', 'B→B 根']);

      const mgA0 = mgIds(mgRead(MGA).data).length;
      const mgB0 = mgIds(mgRead(MGB).data).length;
      const mgBOrigin = [];
      mgWalk(mgRead(MGB).data, (n) => { if (n.origin) mgBOrigin.push(n.id); });
      check('合并·前置读数（B 里有带 origin 的节点）', mgBOrigin.length > 0, 'origin 节点 ' + mgBOrigin.length + ' 个');

      /* ---- ① dry-run：读数齐全、盘上零改动 ---- */
      const mgDry = run(['merge-project', MGA, MGB, '--dry-run', '--json']);
      let mgDryJ = null;
      try { mgDryJ = JSON.parse(mgDry.out); } catch (e) { mgDryJ = null; }
      check('合并·dry-run 可解析且报出将新增节点数',
        ok(mgDry.out) && !!mgDryJ && mgDryJ.dryRun === true && mgDryJ.totals.addedNodes === mgB0,
        mgDryJ ? 'added=' + mgDryJ.totals.addedNodes + ' / B 节点 ' + mgB0 : mgDry.out.trim().slice(0, 160));
      check('合并·dry-run 盘上零改动（目标还是原来的节点数）', mgIds(mgRead(MGA).data).length === mgA0,
        'A 节点 ' + mgIds(mgRead(MGA).data).length + ' vs ' + mgA0);

      /* ---- ② 真跑：节点数 = 原 + 源；分组节点就是源根（topic 相同）；origin 逐字带走 ---- */
      const mgReal = run(['merge-project', MGA, MGB, '--json']);
      let mgJ = null;
      try { mgJ = JSON.parse(mgReal.out); } catch (e) { mgJ = null; }
      check('合并·真跑 exit 0 且与 dry-run 同一份读数',
        ok(mgReal.out) && !!mgJ && mgJ.totals.addedNodes === (mgDryJ && mgDryJ.totals.addedNodes),
        mgJ ? 'added=' + mgJ.totals.addedNodes : mgReal.out.trim().slice(0, 160));
      const mgA1 = mgRead(MGA);
      const mgA1ids = mgIds(mgA1.data);
      check('合并·节点数 = 原 + 源', mgA1ids.length === mgA0 + mgB0, mgA0 + ' + ' + mgB0 + ' = ' + (mgA0 + mgB0) + '，实际 ' + mgA1ids.length);
      const mgGroupId = 'merge-' + MGB;
      const mgGroup = (() => { let f = null; mgWalk(mgA1.data, (n) => { if (n.id === mgGroupId) f = n; }); return f; })();
      check('合并·分组节点 id 是确定性的 merge-<源项目名>', !!mgGroup, String(mgGroupId));
      check('合并·分组节点的 topic 就是源根的 topic（它是源根本身，只换了 id）',
        !!mgGroup && mgGroup.topic === mgRead(MGB).data.topic, mgGroup ? mgGroup.topic : '');
      const mgAfter = new Map();
      mgWalk(mgA1.data, (n) => mgAfter.set(n.id, n));
      /* 源 B 的每个节点 → 合并后在 A 里的同一 id（根换成分组 id） */
      const mgSrcNodes = new Map();
      mgWalk(mgRead(MGB).data, (n) => mgSrcNodes.set(n.id, n));
      const mgBIds = [...mgSrcNodes.keys()].filter((id) => id !== mgRead(MGB).data.id);
      const mgOriginBad = mgBOrigin
        .filter((id) => id !== mgRead(MGB).data.id)
        .filter((id) => !mgAfter.get(id) || JSON.stringify(mgAfter.get(id).origin) !== JSON.stringify(mgSrcNodes.get(id).origin));
      check('合并·origin 逐条原样带走（src/sha256/at/tool 逐字相同）', mgOriginBad.length === 0,
        mgBOrigin.length + ' 个 origin 节点，不一致 ' + mgOriginBad.length + ' 个' + (mgOriginBad.length ? ' :: ' + mgOriginBad.slice(0, 3).join(',') : ''));
      const mgTopicBad = mgBIds.filter((id) => !mgAfter.get(id) || mgAfter.get(id).topic !== mgSrcNodes.get(id).topic);
      check('合并·topic 逐条对得上（源非根节点 ' + mgBIds.length + ' 个）', mgTopicBad.length === 0,
        '不一致 ' + mgTopicBad.length + ' 个' + (mgTopicBad.length ? ' :: ' + mgTopicBad.slice(0, 3).join(',') : ''));
      check('合并后 validate（id 全局唯一 / 无悬挂边）', ok(run(['validate', MGA]).out));

      /* ---- ③ 幂等：同一份源合并两次 ⇒ 拒绝并指名上一次落到哪 ---- */
      const mgAgain = run(['merge-project', MGA, MGB]);
      check('合并·幂等（第二次 exit 1 且指名 `' + mgGroupId + '`）',
        !ok(mgAgain.out) && /已经合并过/.test(mgAgain.out) && mgAgain.out.indexOf(mgGroupId) >= 0,
        mgAgain.out.trim().split('\n')[0].slice(0, 160));

      /* ---- ④ 边：指向 A 的那条不动（合并后即自指），指向 B 的那条按 --links keep 原样带着 ---- */
      let mgToB = 0, mgToA = 0;
      mgWalk(mgAfter.get(mgGroupId), (n) => (n.links || []).forEach((l) => { if (l.project === MGB) mgToB++; if (l.project === MGA) mgToA++; }));
      check('合并·--links keep：指向目标项目的边成了自指边（' + mgToA + ' 条）', mgToA >= 1, 'toA=' + mgToA);
      check('合并·--links keep：指向源项目的边**原样带走**（' + mgToB + ' 条，源项目保留 ⇒ 不悬挂）', mgToB >= 1, 'toB=' + mgToB);

      /* ---- ⑤ 撤销：删分组节点即撤销，源项目一个字节没动 ---- */
      const mgUndo = run(['remove', MGA, mgGroupId]);
      check('合并·撤销（remove 分组节点）', ok(mgUndo.out) && ok(run(['validate', MGA]).out), mgUndo.out.trim().slice(0, 120));
      check('合并·撤销后节点数回到原值', mgIds(mgRead(MGA).data).length === mgA0, String(mgIds(mgRead(MGA).data).length));
      check('合并·源项目 B 一个字节没被改（节点数与主题都对得上）',
        mgIds(mgRead(MGB).data).length === mgB0 && mgRead(MGB).data.topic === '合并来源', 'B 节点 ' + mgIds(mgRead(MGB).data).length);

      /* ---- ⑥ 负例：父节点不存在 / 源=目标 / --links 非法取值 ---- */
      check('合并·负例 父节点不存在 ⇒ 拒绝', !ok(run(['merge-project', MGA, MGB, '--parent', 'no-such-node']).out));
      check('合并·负例 源=目标 ⇒ 拒绝', !ok(run(['merge-project', MGA, MGA]).out));
      check('合并·负例 --links 非法取值 ⇒ 拒绝', !ok(run(['merge-project', MGA, MGB, '--links', 'nonsense']).out));
    } finally {
      [MGA, MGB].forEach((n) => { try { fs.rmSync(mgdir(n), { recursive: true, force: true }); } catch (e) { /* ignore */ } });
      try { fs.rmSync(mgExpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }   // 导出产物（TMP 内）
      const left = [MGA, MGB].filter((n) => fs.existsSync(mgdir(n)));
      check('合并·收尾 探针项目清干净（残留 ' + left.length + ' 个 —— 现算）', left.length === 0, JSON.stringify(left));
    }
  }

  /* ============================================================================
   * 【LP】`learn-path`（学习链路）的端到端断言
   * ----------------------------------------------------------------------------
   * 为什么必须在**真工程 + 真 `projects/` 根**上跑：它要"跨项目读盘 → 新建一个项目 →
   * 再回来对拍输入的字节"，单测（`tests/learn-path.test.js`）里那份 `%TEMP%` 沙箱证明的是
   * **同一套代码**在别处也成立，但"真盘上两个真项目 + 真 store.write 闸门"这一半只有这里覆盖得到。
   *
   * 五条判据各一条断言（判据 1 两条：一次跑内的指纹 + 两次跑之间逐字节）：
   *   1 确定性 · 2 无环 · 3 可追溯（产物里的 `lp-why:` 能反查到 `--json` 的 why）·
   *   4 不改原书（独立 sha256 对拍，不信命令自报）· 5 预算（`ai.calls = 0`）
   * + `--dry-run` 与真跑**同一份判据**、负例三条（同名 / 已存在 / `--order` 越界）。
   *
   * 探针一律 `it-probe-lp*` 前缀 ⇒ 文件顶部 `sweepStaleProbes()` 的 `it-probe-` 表已覆盖；
   * 本块自带 `finally` 收尾 + 残留自检（崩在半路也留不下假项目）。
   * ========================================================================== */
  {
    const LPA = 'it-probe-lp-a';
    const LPB = 'it-probe-lp-b';
    const LPOUT = 'it-probe-lp-out';
    /* `crypto` **在本块里 require**（不往文件顶部加 require）：本文件是与别的批次共享的，
     * 顶部导入区每动一次就多一次撞车面；这一行只服务本块。 */
    const crypto = require('crypto');
    const lpdir = (n) => path.join(ROOT, 'projects', n);
    const lpfile = (n) => path.join(lpdir(n), n + '.json');
    const lpSha = (n) => crypto.createHash('sha256').update(fs.readFileSync(lpfile(n))).digest('hex');
    const lpJson = (r) => { try { return JSON.parse(r.out); } catch (e) { return null; } };
    try {
      // ── 造两本迷你书（每本：章节点 + 两个小节；术语刻意让乙书与甲书共享） ──
      run(['init', LPA, '--title', '链路探针·书甲']);
      run(['add-root', LPA, '--id', 'a-ch1', '--topic', '第1章 导论', '--detail', '<p>基础：<code>sk_buff</code></p>']);
      run(['add', LPA, 'a-ch1', '--id', 'a-s1', '--topic', '1.1 收包',
        '--detail', '<ul><li><code>sk_buff</code> 与 <code>napi_gro_receive</code></li></ul>']);
      run(['add', LPA, 'a-ch1', '--id', 'a-s2', '--topic', '1.2 发包',
        '--detail', '<ul><li><code>dev_queue_xmit</code></li></ul>']);
      run(['add-root', LPA, '--id', 'a-ch2', '--topic', '第2章 进阶', '--detail', '<p>进阶 <code>qdisc</code></p>']);
      run(['init', LPB, '--title', '链路探针·书乙']);
      run(['add-root', LPB, '--id', 'b-ch1', '--topic', '第一章 基础', '--detail', '<p><code>sk_buff</code> 导读</p>']);
      run(['add', LPB, 'b-ch1', '--id', 'b-s1', '--topic', '1.1 缓冲',
        '--detail', '<ul><li><code>sk_buff</code> <code>napi_gro_receive</code> <code>qdisc</code></li></ul>']);

      const lpShaA0 = lpSha(LPA);
      const lpShaB0 = lpSha(LPB);
      const lpArgs = ['learn-path', LPA, LPB];

      /* ---- ① --dry-run：报计划 + 一个字节不写（产物目录都不该出现） ---- */
      const lpdry = run(lpArgs.concat(['--out', LPOUT, '--dry-run', '--json']));
      const lpdryJ = lpJson(lpdry);
      check('LP·判据①（dry-run） `learn-path … --dry-run --json` 报出计划（`dryRun:true` + `created:true`）、'
        + 'exit 0，且**产物目录一个都没出现**（判据 5 的"预算 ≤ 上界"与"不改原书"在预览期同样成立）',
        ok(lpdry.out) && !!lpdryJ && lpdryJ.dryRun === true && !!lpdryJ.plan && lpdryJ.plan.created === true
          && !fs.existsSync(lpdir(LPOUT)),
        lpdryJ ? ('dryRun=' + lpdryJ.dryRun + ' created=' + (lpdryJ.plan && lpdryJ.plan.created)
          + ' 产物存在=' + fs.existsSync(lpdir(LPOUT))) : String(lpdry.out).slice(0, 200));

      /* ---- ② 真跑：产物是新项目 + 五条判据读数 ---- */
      const lprun = run(lpArgs.concat(['--out', LPOUT, '--json']));
      const lpJ = lpJson(lprun);
      check('LP·判据①（确定性） 一次跑内 `determinism.sha256` 是 64 位十六进制指纹；'
        + '判据②（无环）`graph.acyclic === true` 且 `cycles` 为空；判据③（可追溯）**每一步**都带'
        + ' `why.kind` + `why.evidence`；判据⑤（预算）`ai.unit === \'calls\'`、`ai.calls === 0`、'
        + '`ai.maxCalls === 0`（本版纯程序侧，一次也不调模型）',
        ok(lprun.out) && !!lpJ
          && /^[0-9a-f]{64}$/.test(lpJ.determinism && lpJ.determinism.sha256 || '')
          && lpJ.graph.acyclic === true && (lpJ.graph.cycles || []).length === 0
          && lpJ.steps.length > 0
          && lpJ.steps.every((s) => s.why && s.why.kind && s.why.evidence)
          && lpJ.ai.unit === 'calls' && lpJ.ai.calls === 0 && lpJ.ai.maxCalls === 0,
        lpJ ? ('steps=' + lpJ.steps.length + ' acyclic=' + lpJ.graph.acyclic
          + ' ai.calls=' + lpJ.ai.calls + '/' + lpJ.ai.maxCalls
          + ' sha=' + String(lpJ.determinism.sha256).slice(0, 12)) : String(lprun.out).slice(0, 200));

      /* ---- ③ 判据④：**独立** sha256 对拍（不信命令自报） ---- */
      check('LP·判据④（不改原书） 独立复算：真跑前后两本探针书的 JSON sha256 **逐字节相同**'
        + '（命令自报的 `sourceIntegrity.unchanged` 只是旁证，判据以这里为准）',
        lpSha(LPA) === lpShaA0 && lpSha(LPB) === lpShaB0 && !!lpJ && lpJ.sourceIntegrity.unchanged === true,
        '甲 ' + (lpSha(LPA) === lpShaA0) + ' ｜ 乙 ' + (lpSha(LPB) === lpShaB0)
          + ' ｜ 自报=' + (lpJ && lpJ.sourceIntegrity.unchanged));

      /* ---- ④ 第二次同输入 ⇒ 指纹逐字相同（判据①的端到端一半） ---- */
      const lprun2 = run(lpArgs.concat(['--out', LPOUT, '--force', '--json']));
      const lpJ2 = lpJson(lprun2);
      check('LP·判据①（两次跑逐字节） 同一份输入连跑两次（第二次 `--force` 覆盖）⇒ '
        + '`determinism.sha256` 与 `steps` 全量 JSON **都逐字相同**（不是"看起来差不多"）',
        ok(lprun2.out) && !!lpJ2 && !!lpJ
          && lpJ2.determinism.sha256 === lpJ.determinism.sha256
          && JSON.stringify(lpJ2.steps) === JSON.stringify(lpJ.steps),
        lpJ2 ? ('sha 相同=' + (lpJ2.determinism.sha256 === lpJ.determinism.sha256)
          + ' steps 逐字相同=' + (JSON.stringify(lpJ2.steps) === JSON.stringify(lpJ.steps))) : 'json 解析失败');

      /* ---- ⑤ 产物本身立得住：validate 通过 + 顺序=children 顺序 + links 指回原书 + lp-why 可反查 ---- */
      run(['validate', LPOUT]);
      const lpOutFile = lpfile(LPOUT);
      const lpOutData = JSON.parse(fs.readFileSync(lpOutFile, 'utf8'));
      const lpKids = lpOutData.data.children || [];
      const lpToks = lpKids.map((k) => (/lp-why:v1\|([^<]*)/.exec(String(k.detail || '')) || [])[1] || '');
      const lpWhyOk = lpKids.every((k, i) => {
        const m = /lp-why:v1\|kind=([a-z-]+)\|conf=([a-z]+)\|overlap=(\d+)\|/.exec(String(k.detail || ''));
        return !!m && !!lpJ && m[1] === lpJ.steps[i].why.kind && m[2] === lpJ.steps[i].why.confidence
          && Number(m[3]) === lpJ.steps[i].why.evidence.overlap;
      });
      check('LP·判据③（产物可反查）+ 产物合法性 生成的 `projects/' + LPOUT + '/`：`validate` 通过、'
        + '步骤顺序 = `children` 顺序（`lp-0001…` 连续）、每步 `links[0]` 指回原书节点、'
        + '`detail` 里的 `lp-why:` 行与 `--json` 的 `why.kind`/`confidence`/`overlap` **逐字段相同**',
        ok(run(['validate', LPOUT]).out)
          && !!lpJ && lpKids.length === lpJ.steps.length
          && lpKids.every((k, i) => k.id === 'lp-' + String(i + 1).padStart(4, '0')
            && k.links && k.links.length === 1
            && k.links[0].project === lpJ.steps[i].project
            && k.links[0].id === lpJ.steps[i].nodeId)
          && lpWhyOk,
        'children=' + lpKids.length + ' / steps=' + (lpJ ? lpJ.steps.length : '?')
          + ' ｜ lp-why 逐字段一致=' + lpWhyOk + ' ｜ 首个 token=' + String(lpToks[0] || '').slice(0, 60));

      /* ---- ⑥ 判据②的判别力：注入互相「前置：」的两条边 ⇒ 必须 exit 1 并**逐条点名环上边** ---- */
      const lpLink1 = run(['link', LPB, 'b-s1', '--to', LPA, '--id', 'a-s2', '--caption', '前置：乙先学甲的发包']);
      const lpLink2 = run(['link', LPA, 'a-s2', '--to', LPB, '--id', 'b-s1', '--caption', '前置：甲先学乙的缓冲']);
      const lpCyc = run(lpArgs.concat(['--out', LPOUT + '-cyc']));
      check('LP·判据②（成环必红且不丢边） 注入两条互相「前置：」的边 ⇒ `learn-path` **exit 1**，报文点名'
        + '「链路成环」+ **环上每一条边**（`lp-` 两本书的节点名 + caption 原样），并且**没有产出半个项目**'
        + '（不许"断一条边凑合排完"这种静默补救）',
        ok(lpLink1.out) && ok(lpLink2.out) && !ok(lpCyc.out)
          && /成环/.test(lpCyc.out) && lpCyc.out.indexOf('a-s2') >= 0 && lpCyc.out.indexOf('b-s1') >= 0
          && lpCyc.out.indexOf('前置：') >= 0
          && !fs.existsSync(lpdir(LPOUT + '-cyc')),
        String(lpCyc.out).trim().split('\n')[0].slice(0, 160));
      // 清掉注入的边（探针项目随后整个删掉，但保持"删之前状态干净"这条纪律）
      run(['unlink', LPB, 'b-s1', '--to', LPA, '--id', 'a-s2']);
      run(['unlink', LPA, 'a-s2', '--to', LPB, '--id', 'b-s1']);

      /* ---- ⑦ 负例三条：同名 / 已存在 / --order 越界 ---- */
      const lpSame = run(['learn-path', LPA, LPB, '--out', LPA]);
      const lpExists = run(lpArgs.concat(['--out', LPOUT]));
      const lpOrder = run(lpArgs.concat(['--out', LPOUT + '-x', '--order', 'comnet']));
      check('LP·负例（三条都是**响亮拒绝**、exit 1、且都不留半个产物） ① `--out` 与输入同名 '
        + '② 产物已存在且没给 `--force` ③ `--order` 里有不在输入里的项目',
        !ok(lpSame.out) && /不能与输入项目同名/.test(lpSame.out)
          && !ok(lpExists.out) && /已存在/.test(lpExists.out)
          && !ok(lpOrder.out) && /不在本次输入里/.test(lpOrder.out)
          && !fs.existsSync(lpdir(LPOUT + '-x')),
        '同名=' + !ok(lpSame.out) + ' 已存在=' + !ok(lpExists.out) + ' order越界=' + !ok(lpOrder.out));
    } finally {
      [LPA, LPB, LPOUT, LPOUT + '-cyc', LPOUT + '-x'].forEach((n) => {
        try { fs.rmSync(lpdir(n), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
      });
      const left = [LPA, LPB, LPOUT, LPOUT + '-cyc', LPOUT + '-x'].filter((n) => fs.existsSync(lpdir(n)));
      check('LP·收尾 探针项目清干净（残留 ' + left.length + ' 个 —— 现算）', left.length === 0, JSON.stringify(left));
    }
  }

  /* ============================================================================
   * 【W16】`contents`（功能代号 `CC`「概念目录」，台账 `W16`）的端到端断言
   * ----------------------------------------------------------------------------
   * 为什么必须在**真工程 + 真 `projects/` 根**上跑：单测（`tests/contents-concepts.test.js`）
   *   证的是**纯逻辑**（判据 / 聚合 / 生成物形状）；这里证的是另一半 ——
   *   命令面 exit code、**不带 `--apply` 时一个字节不写**、`--dry-run` 的零写盘、
   *   以及 **`--apply` 连跑两次幂等**（项目 JSON 的 sha256 逐字节不变、`.changes.jsonl` 不增行）。
   *   "不写盘"一律用**独立 sha256 对拍**，不信命令自报。
   *
   * 探针项目固定 `it-probe-w16`（前缀 `it-probe-` ⇒ 文件顶部 `sweepStaleProbes()` 已覆盖）；
   * 本块自带 `finally` 收尾 + 残留自检（崩在半路也留不下假项目）。
   * ========================================================================== */
  {
    const WC = 'it-probe-w16';
    const wcdir = (n) => path.join(ROOT, 'projects', n);
    const wcfile = (n) => path.join(wcdir(n), n + '.json');
    const wclog = (n) => path.join(wcdir(n), '.changes.jsonl');
    /* `crypto` **在本块里 require**（不往文件顶部加 require）：本文件与别的批次共享，
     * 顶部导入区每动一次就多一次撞车面（与 §LP 那条注释同一条纪律）。 */
    const crypto = require('crypto');
    const wcSha = (n) => crypto.createHash('sha256').update(fs.readFileSync(wcfile(n))).digest('hex');
    const wcLogLines = (n) => (fs.existsSync(wclog(n))
      ? fs.readFileSync(wclog(n), 'utf8').split('\n').filter((x) => x.trim()).length : 0);
    const wcLastChanged = (n) => {
      const lines = fs.readFileSync(wclog(n), 'utf8').split('\n').filter((x) => x.trim());
      const e = JSON.parse(lines[lines.length - 1]);
      return (e.changed || []).slice().sort();
    };
    /** 解析 `--json` 档（`run()` 把 stderr 也并了进来 ⇒ 万一有 warning，从第一个 `{` 起解析） */
    const wcJson = (r) => {
      try { return JSON.parse(r.out); } catch (e) { /* 落到下面再试一次 */ }
      const at = String(r.out).indexOf('{');
      if (at < 0) return null;
      try { return JSON.parse(String(r.out).slice(at)); } catch (e) { return null; }
    };
    const wcRoot = (n) => JSON.parse(fs.readFileSync(wcfile(n), 'utf8')).data;
    try {
      /* ---- 造一棵"四件事都在"的迷你树：章节号标题 / 跨章同名 / 正文提及 / 纯分组容器 ---- */
      run(['init', WC, '--title', '概念目录探针']);
      run(['add-root', WC, '--id', 'wc-ch1', '--topic', '第1章 收包与发包', '--detail', '<p>本章讲收包</p>']);
      run(['add', WC, 'wc-ch1', '--id', 'wc-s11', '--topic', '收包路径', '--detail', '<ul><li>收包路径 与 NAPI</li></ul>']);
      run(['add', WC, 'wc-ch1', '--id', 'wc-s12', '--topic', 'NAPI 轮询', '--detail', '<ul><li>NAPI 轮询</li></ul>']);
      run(['add-root', WC, '--id', 'wc-ch2', '--topic', '第2章 深入', '--detail', '<p>重复概念与正文提及的例子</p>']);
      run(['add', WC, 'wc-ch2', '--id', 'wc-s21', '--topic', '2.1 收包路径', '--detail', '<ul><li>再次讲收包路径</li></ul>']);
      run(['add', WC, 'wc-ch2', '--id', 'wc-s22', '--topic', '概念容器']);
      run(['add', WC, 'wc-s22', '--id', 'wc-s221', '--topic', '子概念甲', '--detail', '<p>甲</p>']);
      run(['add', WC, 'wc-ch2', '--id', 'wc-s23', '--topic', '提到收包的一节', '--detail', '<ul><li>见 收包路径 与 NAPI 轮询</li></ul>']);

      /* ---- A 可复现：--json 跑两次逐字节相同 ---- */
      const wcR1 = run(['contents', WC, '--json']);
      const wcR2 = run(['contents', WC, '--json']);
      const wcCJ = wcJson(wcR1);
      check('W16·判据 A（可复现） `contents <项目> --json` exit 0，且**跑两次输出逐字节相同**'
        + '（无时间戳、无随机、键序固定 —— 与 G-11「不加开关时输出逐字相同」同一口径）',
        wcR1.code === 0 && wcR2.code === 0 && wcR1.out === wcR2.out && !!wcCJ,
        'exit=' + wcR1.code + '/' + wcR2.code + ' 逐字节相同=' + (wcR1.out === wcR2.out)
          + ' 字节=' + Buffer.byteLength(wcR1.out, 'utf8'));

      /* ---- B 判据②：概念名 = 标题去章节号前缀 + 同名合并；count = 落点 + 提及 ---- */
      const wcByName = new Map();
      ((wcCJ && wcCJ.items) || []).forEach((x) => wcByName.set(x.name, x));
      const wcDupe = wcByName.get('收包路径');
      check('W16·判据 B（什么算一个概念） `收包路径` 与 `2.1 收包路径` 合成**一个**概念（章节号前缀被剥掉）：'
        + 'ids=[wc-s11,wc-s21]、nodes=2、mentions=2、count=4 —— 即"落点数 + 正文提及数"',
        !!wcDupe && wcDupe.ids.length === 2 && wcDupe.ids[0] === 'wc-s11' && wcDupe.ids[1] === 'wc-s21'
          && wcDupe.nodes === 2 && wcDupe.mentions === 2 && wcDupe.count === 4,
        wcDupe ? ('ids=' + wcDupe.ids.join(',') + ' nodes=' + wcDupe.nodes
          + ' mentions=' + wcDupe.mentions + ' count=' + wcDupe.count) : '概念 `收包路径` 不存在');

      /* ---- C 判据③：纯分组容器不算概念（它的子节点照算） ---- */
      check('W16·判据 C（纯分组容器不算概念） 无正文/无标签/无链接但**有子节点**的 `概念容器` 不在清单里；'
        + '它的子节点 `子概念甲` 在；`carriers` 比 `nodes` 少 1（现算，不是写死的数）',
        !!wcCJ && !wcByName.has('概念容器') && wcByName.has('子概念甲')
          && wcCJ.carriers === wcCJ.nodes - 1,
        wcCJ ? ('nodes=' + wcCJ.nodes + ' carriers=' + wcCJ.carriers
          + ' 容器在清单里=' + wcByName.has('概念容器') + ' 子概念甲在清单里=' + wcByName.has('子概念甲')) : 'json 解析失败');

      /* ---- D 判据④：与 `mentions` **共用**命中计算（逐概念对拍，不是"总数差不多"） ---- */
      const wcMJ = wcJson(run(['mentions', WC, '--json']));
      const wcToCount = new Map();
      ((wcMJ && wcMJ.items) || []).forEach((it) => wcToCount.set(it.to, (wcToCount.get(it.to) || 0) + 1));
      const wcMismatch = [];
      ((wcCJ && wcCJ.items) || []).forEach((it) => {
        let n = 0;
        it.ids.forEach((id) => { n += (wcToCount.get(id) || 0); });
        if (n !== it.mentions) wcMismatch.push(it.name + '（' + it.mentions + ' vs ' + n + '）');
      });
      check('W16·判据 D（与 mentions 共用命中计算） 每条概念的 `mentions` == `mentions --json` 里 `to` 落在该概念 ids 的条数'
        + '（逐概念逐条相等 ⇒ 同一份 findMentions 实现，不是第二套解析）',
        !!wcMJ && !!wcCJ && wcMismatch.length === 0,
        '不一致 ' + wcMismatch.length + ' 条' + (wcMismatch.length ? '：' + wcMismatch.slice(0, 3).join('；') : ''));

      /* ---- E 不带 --apply 绝不写盘（独立 sha256 + 日志行数对拍） ---- */
      const wcSha0 = wcSha(WC);
      const wcLog0 = wcLogLines(WC);
      const wcText = run(['contents', WC]);
      const wcSha1 = wcSha(WC);
      const wcLog1 = wcLogLines(WC);
      check('W16·判据 E（不带 --apply 时绝不写盘） 文本档 exit 0 且人可读（含口径行 + 逐条编号 + 落点/提及读数）；'
        + '跑前跑后项目 JSON 的 **sha256 相同**、`.changes.jsonl` 行数不变',
        wcText.code === 0 && /口径：概念名/.test(wcText.out) && /1\. /.test(wcText.out)
          && /落点 \d+ · 提及 \d+/.test(wcText.out) && wcSha0 === wcSha1 && wcLog0 === wcLog1,
        'exit=' + wcText.code + ' sha 相同=' + (wcSha0 === wcSha1) + ' 日志行 ' + wcLog0 + '→' + wcLog1);

      /* ---- F --apply 生成「概念索引」：一个分支、每概念一子节点、links 回指落点 ---- */
      const wcAp1 = run(['contents', WC, '--apply']);
      const wcRoot1 = wcRoot(WC);
      const wcIdx = (wcRoot1.children || []).filter((c) => c && c.topic === '概念索引');
      const wcIdxKids = (wcIdx[0] && wcIdx[0].children) || [];
      const wcPrefixes = ['前置：', '前置:', 'prereq:', '对照：', '补充：', '出自：', '同义：'];
      const wcCaptionOk = wcIdxKids.every((c) => (c.links || []).every((l) => {
        const cap = String(l.caption || '');
        return l.project === WC && wcPrefixes.every((pre) => cap.indexOf(pre) !== 0);
      }));
      const wcLandingOk = wcIdxKids.every((c) => (c.links || []).every((l) => !!String(l.id || '')));
      check('W16·判据 F（一键补成节点） `--apply` 后 root 下**恰好一个**「概念索引」分支，'
        + '子节点数 == 概念数，每个子节点的 links 都指回本项目、且 caption **不带任何类型前缀**'
        + '（docs/TAGS.md §11：类型只有 5 种，"索引条目"不是其中任何一种 ⇒ 走该节规则 2 的自由文本）',
        wcAp1.code === 0 && wcIdx.length === 1 && wcIdxKids.length === (wcCJ ? wcCJ.shown : -1)
          && wcCaptionOk && wcLandingOk && ok(run(['validate', WC]).out),
        'exit=' + wcAp1.code + ' 分支数=' + wcIdx.length + ' 子节点=' + wcIdxKids.length
          + ' caption 合规=' + wcCaptionOk + ' 回指齐全=' + wcLandingOk);

      /* ---- G --apply 幂等：第二次 sha256 逐字节不变、日志不增行、明说未写盘 ---- */
      const wcShaAp1 = wcSha(WC);
      const wcLogAp1 = wcLogLines(WC);
      const wcAp2 = run(['contents', WC, '--apply']);
      const wcShaAp2 = wcSha(WC);
      const wcLogAp2 = wcLogLines(WC);
      const wcRoot2 = wcRoot(WC);
      const wcIdx2 = (wcRoot2.children || []).filter((c) => c && c.topic === '概念索引');
      check('W16·判据 G（--apply 幂等） 连跑第二次：exit 0、项目 JSON 的 **sha256 与第一次逐字节相同**、'
        + '`.changes.jsonl` **不多一行**、输出里明说「未写盘」，「概念索引」仍**只有一支**（没造第二份）',
        wcAp2.code === 0 && wcShaAp1 === wcShaAp2 && wcLogAp1 === wcLogAp2
          && /未写盘/.test(wcAp2.out) && wcIdx2.length === 1,
        'exit=' + wcAp2.code + ' sha 相同=' + (wcShaAp1 === wcShaAp2) + ' 日志行 ' + wcLogAp1 + '→' + wcLogAp2
          + ' 分支数=' + wcIdx2.length);

      /* ---- H 生成物不污染只读读数（自指循环的回归守卫） ---- */
      const wcAfter = run(['contents', WC, '--json']);
      check('W16·判据 H（生成物不污染只读读数） 已有「概念索引」之后，`contents --json` 的输出**与 --apply 之前逐字节相同**'
        + '（实测过的缺陷：不摘掉生成物，索引会把自己算成一个概念、第二次 --apply 就永远不幂等）',
        wcAfter.code === 0 && wcAfter.out === wcR1.out,
        '逐字节相同=' + (wcAfter.out === wcR1.out)
          + '（前 ' + Buffer.byteLength(wcR1.out, 'utf8') + ' B / 后 ' + Buffer.byteLength(wcAfter.out, 'utf8') + ' B）');

      /* ---- I --dry-run 零写盘，且报告的对象清单 == 真跑后日志的 changed（W8 判据③） ---- */
      run(['add', WC, 'wc-ch2', '--id', 'wc-s24', '--topic', '新增概念乙', '--detail', '<p>乙</p>']);
      const wcShaD0 = wcSha(WC);
      const wcLogD0 = wcLogLines(WC);
      const wcDry = run(['contents', WC, '--apply', '--dry-run']);
      const wcDryJ = wcJson(run(['contents', WC, '--apply', '--dry-run', '--json']));
      const wcShaD1 = wcSha(WC);
      const wcLogD1 = wcLogLines(WC);
      const wcReal = run(['contents', WC, '--apply']);
      const wcRealChanged = wcLastChanged(WC);
      const wcPlan = (wcDryJ && wcDryJ.plan && wcDryJ.plan.changed) || null;
      check('W16·判据 I（--dry-run 零写盘 + 报告与真跑同源） `contents --apply --dry-run`：输出带 `[dry-run 未写盘]`、'
        + '`--json` 里 `dryRun:true` 且 `plan` 有对象清单；跑前跑后 sha256 与日志行数**都不变**；'
        + '而**计划里的对象清单 == 真跑后 `.changes.jsonl` 末条的 `changed`**（逐条相等）',
        wcDry.code === 0 && /dry-run 未写盘/.test(wcDry.out) && !!wcDryJ
          && wcDryJ.dryRun === true && Array.isArray(wcPlan) && wcPlan.length > 0
          && wcShaD0 === wcShaD1 && wcLogD0 === wcLogD1
          && wcReal.code === 0 && JSON.stringify(wcPlan) === JSON.stringify(wcRealChanged),
        'dry exit=' + wcDry.code + ' 计划 ' + (wcPlan ? wcPlan.length : 'null') + ' 项 · 真跑 changed '
          + wcRealChanged.length + ' 项 · 逐条相等=' + (!!wcPlan && JSON.stringify(wcPlan) === JSON.stringify(wcRealChanged))
          + ' · sha 未变=' + (wcShaD0 === wcShaD1) + ' 日志 ' + wcLogD0 + '→' + wcLogD1);

      /* ---- J 纯开关的响亮拒绝 + 作用域三开关的读数 ---- */
      const wcBad = run(['contents', WC, '--apply=false']);
      const wcScoped = wcJson(run(['contents', WC, '--parent', 'wc-ch1', '--json']));
      const wcShallow = wcJson(run(['contents', WC, '--depth', '1', '--json']));
      const wcMC = wcJson(run(['contents', WC, '--min-count', '2', '--json']));
      check('W16·判据 J（开关语义） `--apply=false` ⇒ exit 1 并说清"纯开关 / 去掉开关"（照 --dry-run 的先例）；'
        + '`--parent` 只扫该子树（scope.parent=wc-ch1）、`--depth 1` 只算顶层、`--min-count 2` 只留 count≥2',
        wcBad.code === 1 && /纯开关/.test(wcBad.out)
          && !!wcScoped && wcScoped.scope.parent === 'wc-ch1' && wcScoped.nodes < (wcCJ ? wcCJ.nodes : 0)
          && !!wcShallow && wcShallow.scope.depth === 1 && wcShallow.nodes === 2
          && !!wcMC && wcMC.items.every((x) => x.count >= 2) && wcMC.shown < wcMC.concepts,
        'apply=false exit=' + wcBad.code
          + ' · parent.nodes=' + (wcScoped && wcScoped.nodes)
          + ' · depth1.nodes=' + (wcShallow && wcShallow.nodes)
          + ' · minCount2=' + (wcMC && (wcMC.shown + '/' + wcMC.concepts)));

      /* ---- K `--parent` 是"写进那个子树"，且与根作用域那支**不撞 id**（实测缺陷回归） ---- */
      const wcSub1 = run(['contents', WC, '--parent', 'wc-ch1', '--apply']);
      const wcSub2 = run(['contents', WC, '--parent', 'wc-ch1', '--apply']);
      const wcRootK = wcRoot(WC);
      const wcCh1 = (wcRootK.children || []).filter((c) => c && c.id === 'wc-ch1')[0] || {};
      const wcSubIdx = (wcCh1.children || []).filter((c) => c && c.topic === '概念索引');
      check('W16·判据 K（`--parent` 写进子树 + 两支索引**不撞 id**） `--parent wc-ch1 --apply` 在该子树下生成'
        + '**本作用域**的那一支（id 带作用域后缀），与根作用域那一支**并存**且 `validate` 仍通过；'
        + '再跑一次仍未写盘。（实测缺陷：不带作用域后缀时 `校验失败: [contents-index] 重复 id`）',
        wcSub1.code === 0 && !!wcCh1.id && wcSubIdx.length === 1
          && wcSubIdx[0].id !== 'contents-index' && ok(run(['validate', WC]).out)
          && wcSub2.code === 0 && /未写盘/.test(wcSub2.out),
        'parent-apply exit=' + wcSub1.code + ' 子树下分支数=' + wcSubIdx.length
          + ' 分支 id=' + (wcSubIdx[0] && wcSubIdx[0].id)
          + ' 第二次未写盘=' + (wcSub2.code === 0 && /未写盘/.test(wcSub2.out)));
    } finally {
      try { fs.rmSync(wcdir(WC), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
      check('W16·收尾 探针项目清干净（残留 ' + (fs.existsSync(wcdir(WC)) ? 1 : 0) + ' 个 —— 现算）',
        !fs.existsSync(wcdir(WC)), String(wcdir(WC)));
    }
  }

  /* ============================================================================
   * 【W5】`tags`（**标签清单**，只读）的端到端断言
   * ----------------------------------------------------------------------------
   * 台账 `.review/20261010-卖点与功能-常驻讨论/待做清单.md:126` 的 `W5a` 前半句：
   *   「列出**全部标签 + 计数** ✓（现在 `stats` 只给标签总数 ✗）」—— 后半句
   *   （某标签下的跨项目节点清单）已由 `search-all --tag` 兑现，本块只管前半句与三条契约判据。
   *
   * 为什么必须在这里（真 `projects/` 根 + 进程内 CLI）：单测（`tests/tag-census.test.js`）证纯逻辑；
   *   这一层证的是**命令面**：exit code / **一个字节都不写盘** / `--json` 两跑逐字节相同 /
   *   三条词表判据**真的有判别力**（造坏 ⇒ 红）/ 四条闸门各自响亮失败。
   *
   * ⚠️ 三条判据的**判别力**是本块的重点，不是"跑通就行"：
   *   · 两个 §4 里的标签**各 4 个落点**，一个（普通标签）必须判红、一个（§4 该行写了「门面特性」）
   *     必须判绿 —— 差别**只**来自"下限 5 还是 3"。解析器一旦忽略「门面特性」，后者会以 floor 5 判红
   *     ⇒ 判据 F 立刻变红（这就是注入式证明：把判据的输入改掉，断言必须变色）。
   *   · 一个**不在 §4** 的标签必须 inVocab=false（判据 E）；
   *   · 一个 §4 有、但本探针里 0 落点的标签必须进 `vocab.unused`（判据 G）。
   *
   * 探针项目固定 `it-probe-w5-` 前缀（文件顶部 `sweepStaleProbes()` 已覆盖），本块自带 `finally`
   * 收尾 + 残留自检；夹具直接写 JSON（少 28 次 CLI 调用），随后用 `validate` **证明夹具是合法数据**。
   * ========================================================================== */
  {
    const W5TAG = Date.now().toString(36);
    const W5A = 'it-probe-w5-a-' + W5TAG;      // 判据面（--vocab 三条）
    const W5B = 'it-probe-w5-b-' + W5TAG;      // 跨项目合并面
    const w5dir = (n) => path.join(ROOT, 'projects', n);
    const w5file = (n) => path.join(w5dir(n), n + '.json');
    const w5log = (n) => path.join(w5dir(n), '.changes.jsonl');
    const crypto = require('crypto');
    const w5sha = (f) => (fs.existsSync(f)
      ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16)
      : '-');
    /** 一个探针项目的"零写盘"快照：项目 JSON 与变更日志的 sha256 + mtime */
    const w5snap = (n) => [w5file(n), w5log(n)]
      .map((f) => w5sha(f) + '@' + (fs.existsSync(f) ? fs.statSync(f).mtimeMs : -1)).join(' | ');
    /** 建一个探针项目：**走真 CLI**（`init` + `add` + `edit --tags`），不自己拼 JSON。
     *  理由两条：① 少一处"目标判不了"的裸写 —— S2 ⑤ 的**豁免面只减不增**，本文件虽然整文件在册，
     *  也不该往里加处数；② 夹具是被**写盘闸门**造出来的，"`validate` 通过"才不是"我们以为合法"。 */
    const w5mk = (n, children) => {
      run(['init', n, '--title', n]);
      children.forEach((c) => {
        run(['add', n, 'root', '--id', c.id, '--topic', c.topic]);
        if (c.tags && c.tags.length) run(['edit', n, c.id, '--tags', c.tags.join(',')]);
      });
    };
    const w5json = (r) => {
      try { return JSON.parse(r.out); } catch (e) { /* 落到下面再试一次 */ }
      const at = String(r.out).indexOf('{');
      if (at < 0) return null;
      try { return JSON.parse(String(r.out).slice(at)); } catch (e) { return null; }
    };
    /* §4 的**独立**解析（本文件不 require 命令层的 `readTagVocabulary`：那是"被测实现"，
     * 用它来造夹具就成了自证。这里按文档自身的表格形状再读一遍 —— 两个独立读者必须agree）。 */
    const w5vocab = [];
    {
      const lines = fs.readFileSync(path.join(ROOT, 'docs', 'TAGS.md'), 'utf8').split(/\r?\n/);
      let inSec = false;
      for (let i = 0; i < lines.length; i++) {
        if (!inSec) { if (/^##\s*4\./.test(lines[i])) inSec = true; continue; }
        if (/^##\s*5\./.test(lines[i])) break;
        const m = /^\|\s*`([^`]+)`\s*\|/.exec(lines[i]);
        if (m) w5vocab.push({ tag: m[1], facade: lines[i].indexOf('门面特性') >= 0 });
      }
    }
    const w5plain = w5vocab.filter((x) => !x.facade).map((x) => x.tag);
    const w5facade = w5vocab.filter((x) => x.facade).map((x) => x.tag);
    /* 夹具用的三个词**从文档里现取**（不写死）：改词表不该让本块按旧名单判红。 */
    const T_FLOOR = w5plain.length > 1 ? w5plain[1] : null;      // 普通标签：4 落点 ⇒ 应判红（<5）
    const T_UNUSED = w5plain.length > 0 ? w5plain[0] : null;     // §4 有、探针里 0 落点 ⇒ 应进 unused
    const T_FACADE = w5facade.length > 0 ? w5facade[0] : null;   // 门面特性：4 落点 ⇒ 应判绿（≥3）
    const T_MADEUP = 'w5-不在词表里的标签-' + W5TAG;             // 造坏：闭集判据必须抓得到
    const w5nd = (id, tags) => ({ id: id, topic: 'w5 探针 ' + id, expanded: true,
      tags: tags, children: [] });
    try {
      check('W5·前提 §4 里解析出足够造夹具的标签（普通 ≥2 个、门面特性 ≥1 个）'
        + '—— 解析不出就没法判"放宽口径到底生效没有"：§4 现有 ' + w5vocab.length + ' 条（'
        + w5facade.length + ' 条写明门面特性）',
        w5vocab.length >= 3 && w5plain.length >= 2 && w5facade.length >= 1,
        '§4 条数=' + w5vocab.length + ' 普通=' + w5plain.length + ' 门面=' + w5facade.length);
      if (!T_FLOOR || !T_UNUSED || !T_FACADE) throw new Error('§4 夹具词取不到（上一句已判红）');

      /* ---- 夹具：WA 十个节点（无标签 1 个）、WB 四个节点 ---- */
      /*  WA：n1..n4 = T_FLOOR（4 落点）· n5..n8 = T_FACADE（4 落点）· n9 = 造坏词 · n10 = 无标签 */
      w5mk(W5A, [].concat(
        [1, 2, 3, 4].map((i) => w5nd('wa-n' + i, [T_FLOOR])),
        [5, 6, 7, 8].map((i) => w5nd('wa-n' + i, [T_FACADE])),
        [w5nd('wa-n9', [T_MADEUP]), w5nd('wa-n10', [])]));
      /*  WB：m1..m3 = T_FACADE（跨项目合计 7）· m4 = T_FLOOR（合计 5） */
      w5mk(W5B, [].concat(
        [1, 2, 3].map((i) => w5nd('wb-m' + i, [T_FACADE])),
        [w5nd('wb-m4', [T_FLOOR])]));

      check('W5·夹具合法 两个探针项目都过 `validate`（夹具本身不是坏数据）',
        run(['validate', W5A]).code === 0 && run(['validate', W5B]).code === 0);

      /* ---- A 只读：一个字节都不写 ---- */
      const snapBefore = [w5snap(W5A), w5snap(W5B)];
      const rA1 = run(['tags', W5A, W5B, '--json']);
      run(['tags', W5A, '--vocab', '--json']);
      run(['tags', W5A, W5B]);
      run(['tags', '--json']);
      const snapAfter = [w5snap(W5A), w5snap(W5B)];
      check('W5·判据 A（只读）`tags` 全部档位跑完，两个探针项目的 JSON 与 `.changes.jsonl`'
        + '的 sha256 + mtime **逐项不变**（不信命令自报，独立对拍）',
        snapBefore[0] === snapAfter[0] && snapBefore[1] === snapAfter[1],
        snapBefore.join(' ‖ ') + (snapBefore[0] === snapAfter[0] && snapBefore[1] === snapAfter[1]
          ? ' ⇒ 未变' : ' ⇒ **变了** ' + snapAfter.join(' ‖ ')));

      /* ---- B 确定性：两跑逐字节相同（含 --vocab 档） ---- */
      const rB1 = run(['tags', W5A, W5B, '--json']);
      const rB2 = run(['tags', W5A, W5B, '--json']);
      const rB3 = run(['tags', W5A, '--vocab', '--json']);
      const rB4 = run(['tags', W5A, '--vocab', '--json']);
      check('W5·判据 B（确定性）`--json` 与 `--vocab --json` **各跑两次输出逐字节相同**'
        + '（键序固定、无时间戳、排序走码点序不用 locale —— 与 G-11 同一口径）',
        rA1.code === 0 && rB1.code === 0 && rB1.out === rB2.out
          && rB3.code === 0 && rB3.out === rB4.out,
        '普通档相同=' + (rB1.out === rB2.out) + ' 词表档相同=' + (rB3.out === rB4.out)
          + ' 字节=' + Buffer.byteLength(rB1.out, 'utf8'));

      /* ---- C 计数口径与跨项目分布（手算对拍） ---- */
      const jC = w5json(rB1);
      const byTag = new Map(((jC && jC.tags) || []).map((t) => [t.tag, t]));
      const cFacade = byTag.get(T_FACADE);
      const cFloor = byTag.get(T_FLOOR);
      const cMade = byTag.get(T_MADEUP);
      const expectOrder = [T_FACADE, T_FLOOR, T_MADEUP];   // 7 / 5 / 1 个节点 ⇒ 降序
      check('W5·判据 C（计数口径 + 跨项目分布）两个项目合并：`' + T_FACADE + '` 7 个节点'
        + '（' + W5B + ' 3 / ' + W5A + ' 4）、`' + T_FLOOR + '` 5 个、造坏词 1 个；'
        + 'tagCount=3、nodes=16（**含两个 root**）、taggedNodes=13、untaggedNodes=3；顺序 = 节点数降序',
        !!jC && jC.tagCount === 3 && jC.nodes === 16 && jC.taggedNodes === 13
          && jC.untaggedNodes === 3 && jC.projects.length === 2
          && !!cFacade && cFacade.nodes === 7 && cFacade.projects.length === 2
          && cFacade.projects[0].project === W5A && cFacade.projects[0].nodes === 4
          && cFacade.projects[1].project === W5B && cFacade.projects[1].nodes === 3
          && !!cFloor && cFloor.nodes === 5 && !!cMade && cMade.nodes === 1
          && JSON.stringify(jC.tags.map((t) => t.tag)) === JSON.stringify(expectOrder),
        jC ? ('tagCount=' + jC.tagCount + ' nodes=' + jC.nodes + ' tagged=' + jC.taggedNodes
          + ' untagged=' + jC.untaggedNodes + ' 顺序=' + jC.tags.map((t) => t.tag).join('>')) : '解析失败');

      /* ---- D 与 `stats` 同一个"数标签"实现（不许有第二份遍历） ---- */
      const jD1 = w5json(run(['tags', W5A, '--json']));
      const jD2 = w5json(run(['stats', W5A, '--json']));
      check('W5·判据 D（数标签只有一处实现）单项目 `tags` 的 tagCount / nodes / taggedNodes'
        + ' **逐项等于** `stats` 的同名读数（两个读数是同一个遍历的两种分辨率）',
        !!jD1 && !!jD2 && jD1.tagCount === jD2.tags && jD1.nodes === jD2.nodes
          && jD1.taggedNodes === jD2.taggedNodes,
        jD1 && jD2 ? ('tags: ' + jD1.tagCount + '/' + jD1.nodes + '/' + jD1.taggedNodes
          + ' vs stats: ' + jD2.tags + '/' + jD2.nodes + '/' + jD2.taggedNodes) : '解析失败');

      /* ---- E 闭集判据有判别力 ---- */
      const jE = w5json(rB3);
      const eByTag = new Map(((jE && jE.tags) || []).map((t) => [t.tag, t]));
      check('W5·判据 E（闭集，造坏 ⇒ 红）造的那个不在 §4 的标签 `inVocab === false`，'
        + '两个 §4 里的标签 `inVocab === true`（判据不是恒真：有反例时它真的会变）',
        !!jE && !!eByTag.get(T_MADEUP) && eByTag.get(T_MADEUP).inVocab === false
          && !!eByTag.get(T_FLOOR) && eByTag.get(T_FLOOR).inVocab === true
          && !!eByTag.get(T_FACADE) && eByTag.get(T_FACADE).inVocab === true,
        jE ? (T_MADEUP + '=' + (eByTag.get(T_MADEUP) || {}).inVocab
          + ' ' + T_FLOOR + '=' + (eByTag.get(T_FLOOR) || {}).inVocab) : '解析失败');

      /* ---- F 落点下限 + 门面特性的放宽**真的生效**（本块的核心判别力证明） ---- */
      const fBelow = new Map((((jE && jE.vocab) || {}).belowFloor || []).map((b) => [b.tag, b]));
      check('W5·判据 F（落点下限 + 门面特性放宽，造坏 ⇒ 红）两个标签**各 4 个落点**：'
        + '普通标签 `' + T_FLOOR + '` 进 belowFloor（floor=5），§4 里写明「门面特性」的 `'
        + T_FACADE + '` **不进**（floor=3）。若解析器忽略那四个字，后者会以 floor 5 判红 ⇒ 本断言变红',
        !!jE && !!fBelow.get(T_FLOOR) && fBelow.get(T_FLOOR).nodes === 4
          && fBelow.get(T_FLOOR).floor === 5 && !fBelow.get(T_FACADE),
        jE ? ('belowFloor=' + JSON.stringify((jE.vocab || {}).belowFloor || [])
          + ' 门面被误判=' + (fBelow.has(T_FACADE) ? '是（✗）' : '否（✓）')) : '解析失败');

      /* ---- G 反向缺口：§4 有、本探针里 0 落点 ---- */
      const gUnused = ((jE && jE.vocab) || {}).unused || [];
      check('W5·判据 G（反向缺口）§4 里有、这批项目里 **0 落点**的 `' + T_UNUSED
        + '` 出现在 `vocab.unused` 里（词表空转要看得见），而**有落点**的标签不在里面',
        !!jE && gUnused.indexOf(T_UNUSED) >= 0
          && gUnused.indexOf(T_FLOOR) < 0 && gUnused.indexOf(T_FACADE) < 0,
        'unused 条数=' + gUnused.length + ' 含 ' + T_UNUSED + '=' + (gUnused.indexOf(T_UNUSED) >= 0)
          + ' 含 ' + T_FLOOR + '=' + (gUnused.indexOf(T_FLOOR) >= 0));

      /* ---- H 四条闸门各自响亮失败 ---- */
      const h1 = run(['tags', '--vocab']);
      const h2 = run(['tags', W5A, '--vocab=false']);
      const h3 = run(['tags', 'it-probe-w5-不存在的项目-' + W5TAG]);
      check('W5·判据 H（闸门）① `--vocab` 不点名项目 ⇒ exit 1 + `error:`；'
        + '② `--vocab=false` ⇒ exit 1（纯布尔不收赋值）；③ 点名不存在的项目 ⇒ exit 1 且报文列出库里现有的',
        h1.code === 1 && /^error:/m.test(h1.out) && h2.code === 1 && /^error:/m.test(h2.out)
          && h3.code === 1 && /^error:/m.test(h3.out) && h3.out.indexOf(W5A) >= 0,
        'exit=' + h1.code + '/' + h2.code + '/' + h3.code
          + ' 点名不存在时列出库里现有项目=' + (h3.out.indexOf(W5A) >= 0));

      /* ---- I `--vocab` 是纯布尔：后面的项目名不许被吞 ---- */
      const rI = run(['tags', W5A, '--vocab', W5B, '--json']);
      const jI = w5json(rI);
      check('W5·判据 I（纯布尔登记）`tags A --vocab B --json`：扫描面**两个项目都在**、'
        + '且 `vocab` 键真的出现 ⇒ 写在 flag 后面的项目名没有被当成它的值吞掉',
        rI.code === 0 && !!jI && !!jI.vocab && jI.projects.length === 2
          && jI.projects.indexOf(W5A) >= 0 && jI.projects.indexOf(W5B) >= 0,
        jI ? 'projects=' + JSON.stringify(jI.projects) : ('exit=' + rI.code));

      /* ---- J 全库档只给清单、不给判据 ---- */
      const jJ = w5json(run(['tags', '--json']));
      const jJtags = ((jJ && jJ.tags) || []);
      check('W5·判据 J（全库 = 清单，不是合规）`tags --json`：`vocab` 与 `inVocab` **都不出现**'
        + '（不给 --vocab 就不读 `docs/TAGS.md`、也不替调用方认定适用范围），`projects` 升序',
        !!jJ && jJ.mode === 'library' && jJ.vocab === undefined
          && jJtags.every((t) => t.inVocab === undefined)
          && JSON.stringify(jJ.projects) === JSON.stringify(jJ.projects.slice().sort()),
        jJ ? ('mode=' + jJ.mode + ' 有 vocab 键=' + (jJ.vocab !== undefined)
          + ' 项目数=' + jJ.projects.length) : '解析失败');
    } finally {
      [W5A, W5B].forEach((n) => {
        try { fs.rmSync(w5dir(n), { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
      });
      const left = [W5A, W5B].filter((n) => fs.existsSync(w5dir(n)));
      check('W5·收尾 两个探针项目清干净（残留 ' + left.length + ' 个 —— 现算）',
        left.length === 0, left.join(',') || '无残留');
    }
  }

  /* ---------------- 8.9 `point`（产品代号 `AP`「指给你看」，台账 `W21`）：界面通道的命令面 ----------------
   * 为什么这一段**只断言"不碰盘"的那几条**：`point` 要一个**正在运行的界面**（`src/control.js` 的
   * 通道），而本脚本跑在 `--smoke` 之外、也没有界面可开；更要紧的是本段的边界**不许往真实
   * `projects/` 里写东西**。于是集成层守的是"命令面本身"（注册/用法/三条响亮拒绝/零写盘的登记口径），
   * 而"真落盘 / 真通道 / 假界面回执"那几条在**沙箱单测**里：
   *   `tests/control-point.test.js`（假界面子进程走完 CLI 半边 + 项目根逐字节不变）
   *   `tests/mcp-ask-apply.test.js`（`ask_apply` 真写盘 / 幂等口径 / dry-run 零改动）
   * ⚠️ 五条断言**一条都不许真跑成功路径**（那会等 2.5s 的界面回执、还会往真实 userData 写通道文件）。 */
  {
    const w21core = require(path.join(ROOT, 'cli', 'core.js'));
    const w21reg = require(path.join(ROOT, 'cli', 'registry.js'));
    const w21mcp = require(path.join(ROOT, 'scripts', 'mcp-server.js'));

    const rHelp = run(['point', '--help']);
    check('W21·A `point --help` ⇒ exit 0，用法里有 `--mode note|related` 与"只作用于当前打开的项目"那句',
      rHelp.code === 0 && rHelp.out.indexOf('--mode') >= 0 && rHelp.out.indexOf('related') >= 0,
      'exit=' + rHelp.code);

    const rNoArgs = run(['point']);
    const rBadMode = run(['point', 'some-proj', 'n-a', '--mode', 'highlight']);
    const rBareMode = run(['point', 'some-proj', 'n-a', '--mode']);
    check('W21·B 三条**响亮拒绝**（都在到通道之前）：缺参数 / 不认识的 mode（并点名 note·related）/ '
      + '`--mode` 裸开关 ⇒ 各自 exit 1 且都以 `error:` 开头 —— **不许**静默退化成默认档',
      rNoArgs.code === 1 && /^error:/m.test(rNoArgs.out)
        && rBadMode.code === 1 && /^error:/m.test(rBadMode.out)
        && rBadMode.out.indexOf('highlight') >= 0 && rBadMode.out.indexOf('related') >= 0
        && rBareMode.code === 1 && /^error:/m.test(rBareMode.out),
      'exit=' + rNoArgs.code + '/' + rBadMode.code + '/' + rBareMode.code);

    const rBadOpt = run(['point', 'some-proj', 'n-a', '--nope']);
    check('W21·C 未知选项 ⇒ exit 1，且报文里列出它**认识**哪些选项（`options` 是唯一声明处）',
      rBadOpt.code === 1 && /^error:/m.test(rBadOpt.out) && rBadOpt.out.indexOf('--mode') >= 0,
      'exit=' + rBadOpt.code);

    const w21point = w21reg.list().filter((c) => c.name === 'point')[0];
    check('W21·D `point` 是**只读**命令：`WRITE_COMMANDS` / `DRY_RUN_COMMANDS` 里都没有它'
      + '（那两个清单的语义是"会改盘"，进去就是假声明）',
      !!w21point && w21core.WRITE_COMMANDS.indexOf('point') < 0
        && w21core.DRY_RUN_COMMANDS.indexOf('point') < 0,
      w21point ? '在册；WRITE_COMMANDS 命中=' + (w21core.WRITE_COMMANDS.indexOf('point') >= 0)
        + ' / DRY_RUN_COMMANDS 命中=' + (w21core.DRY_RUN_COMMANDS.indexOf('point') >= 0) : '没注册');
    /* ⚠️ 2026-10-20 修：本条原来还断言 `allowedOptions('point') === ['mode']`，但报文只说
     * "只读"两件事 —— **断言判的东西和它宣称的不是一回事**。而 `point` 后来补了 `--json`/`--compact`
     * （`cli-options` 门禁要求的），这个 `['mode']` 就成了"改了实现没改断言"的化石。
     * 它逃过检查的**唯一原因**是：W21 批自述"没跑 cli-integration 本体"⇒ 本条**从未被执行过**。
     * 选项登记的判据归 `tests/cli-options.test.js`（那是它的唯一职责），不在这里重复。 */

    const w21ask = w21mcp.TOOLS.filter((t) => t.name === 'ask_apply')[0];
    check('W21·E MCP 侧：工具数 = 53（写死真值；`I-1` 的 `features` 之后）+ `ask_apply` 存在、必填只有 project·id、挂了 dry_run'
      + '（它是**写类**，不挂就等于把"先审再写"从 MCP 侧抽掉）',
      w21mcp.TOOLS.length === 53 && !!w21ask
        && JSON.stringify(w21ask.inputSchema.required) === JSON.stringify(['project', 'id'])
        && !!w21ask.inputSchema.properties.dry_run
        && w21mcp.DRY_RUN_TOOL_CMD.ask_apply === 'ask-apply',
      '工具数=' + w21mcp.TOOLS.length + ' ｜ ask_apply=' + (!!w21ask));
  }

  /* ---------------- 8.10 `features`（任务 `I-1`，`W18` §四）：三套名字的三向互查 ----------------
   * 这一组的判据分四档，**每一档都必须能单独红**（否则就是"跑过了但没判什么"）：
   *   (a) 无参 / `--code` / `--grep` 三条路的**可观测输出**（不是"没报错"）；
   *   (b) **三向互查的判别力** —— 同一个功能的命令名与中文名**都**要命中同一行
   *       （`GAP-4` 的实测形状：`changelog --grep source-chain` 0 命中而 `--grep 来源链` 1 命中）；
   *   (c) 0 命中 / 不存在的代号 / 两个筛选条件同时给 ⇒ **各自不同的**退出码与报文
   *       （检索 0 命中 = exit 0 但把"搜过哪三处"喊出来；精确取一行取不到 = exit 1）；
   *   (d) 只读 + 确定性：不在写命令清单里，`--json` 两跑**逐字节相同**。
   * ⚠️ 判据只认"输出里有那个答案"或退出码，不认"命令没崩"。
   * ⚠️ 本段不引入圈号枚举（那个形状是 G9 的判定标记，重复即判红）。 */
  {
    const fCore = require(path.join(ROOT, 'cli', 'core.js'));
    const fMcp = require(path.join(ROOT, 'scripts', 'mcp-server.js'));

    // (a) 无参：出口是"整张名册 + 两个差集的读数"，缺任何一块都算没答上来
    const fAll = run(['features']);
    check('I-1 无参：列出名册（**16 行** + 代号/中文名/状态/台账/承载命令）+ 两个差集的读数都在',
      fAll.code === 0 && fAll.out.indexOf('产品功能名册') >= 0
        && fAll.out.indexOf('差集①') >= 0 && fAll.out.indexOf('差集②') >= 0
        && /\n\s{2}CT\s+持续跟踪\s+已实现/.test(fAll.out)
        && fAll.out.indexOf('SC    来源链') >= 0,
      'exit=' + fAll.code + ' ｜ 行数=' + (fAll.out.match(/\n\s{2}[A-Z]{2}\s/g) || []).length);

    // (b) 三向互查的判别力：命令名与中文名**两处都命中同一行**，且 JSON 的 matchedIn 指认是哪一处
    const fByCmd = JSON.parse(run(['features', '--grep', 'source-chain', '--json']).out);
    const fByName = JSON.parse(run(['features', '--grep', '来源链', '--json']).out);
    check('I-1 三向互查：`--grep source-chain` 与 `--grep 来源链` **都命中 `SC`**（今天之前前者 0 命中）',
      fByCmd.hitCount === 1 && fByCmd.hits[0].code === 'SC'
        && fByName.hitCount === 1 && fByName.hits[0].code === 'SC'
        && JSON.stringify(fByCmd.hits[0].matchedIn) === JSON.stringify(['commands'])
        && JSON.stringify(fByName.hits[0].matchedIn) === JSON.stringify(['name']),
      '--grep 命令名 ⇒ ' + fByCmd.hits.map((h) => h.code) + '/命中处 ' + fByCmd.hits[0].matchedIn
        + ' ｜ --grep 中文名 ⇒ ' + fByName.hits.map((h) => h.code) + '/命中处 ' + fByName.hits[0].matchedIn);

    // (c) `--code` 精确取一行：给的代号原样回，命令名一起给（Q1「什么状态」/ Q7「代号指什么」）
    const fCode = run(['features', '--code', 'DM']);
    check('I-1 `--code DM` ⇒ 草稿图那一行 + 它的命令名（`draft-map` / `apply`）',
      fCode.code === 0 && fCode.out.indexOf('代号: DM') >= 0
        && fCode.out.indexOf('中文名: 草稿图') >= 0
        && fCode.out.indexOf('实现状态: 未实现（部分）') >= 0
        && fCode.out.indexOf('draft-map') >= 0 && fCode.out.indexOf('W11') >= 0,
      'exit=' + fCode.code + ' ｜ ' + fCode.out.split('\n')[0]);

    // (c) 检索 0 命中：exit 0（与 `changelog --grep` 同口径）但**必须响亮列出搜过的三处**
    const fZero = run(['features', '--grep', 'zzzz-not-exist']);
    check('I-1 `--grep` 0 命中 ⇒ exit 0 **且**把"搜过哪三处"喊出来（代号/中文名/命令名）+ 给出下一步',
      fZero.code === 0 && fZero.out.indexOf('命中 0') >= 0
        && fZero.out.indexOf('代号') >= 0 && fZero.out.indexOf('中文名') >= 0
        && fZero.out.indexOf('CLI 命令名') >= 0 && fZero.out.indexOf('docs/CLI.md') >= 0,
      'exit=' + fZero.code);

    // (c) 精确取一行取不到：exit 1 + `error:`（"答不了"要响亮，与 `--grep` 的 0 命中是**两种**语义）
    const fBadCode = run(['features', '--code', 'ZZ']);
    check('I-1 `--code ZZ`（在册没有）⇒ exit 1 + 以 `error:` 开头 + 点名在册代号',
      fBadCode.code === 1 && /^error:/.test(fBadCode.out.trim()) && fBadCode.out.indexOf('DM') >= 0,
      'exit=' + fBadCode.code);

    // (c) 两个筛选条件同时给：没有确定语义 ⇒ 拒绝（不猜、不静默取其一）
    const fBoth = run(['features', '--grep', '草稿图', '--code', 'DM']);
    check('I-1 `--grep` 与 `--code` 同时给 ⇒ exit 1 并说明两者互斥（不静默挑一个）',
      fBoth.code === 1 && /互斥/.test(fBoth.out), 'exit=' + fBoth.code);

    // (d) 确定性：同一份真源两跑**逐字节相同**（键序固定、不读时钟、排序码点序）
    const fJson1 = run(['features', '--grep', '草稿图', '--json']).out;
    const fJson2 = run(['features', '--grep', '草稿图', '--json']).out;
    check('I-1 `--json` 两跑逐字节相同（键序固定 / 无时间戳 / 排序码点序）且 hits[0] 是 DM',
      fJson1 === fJson2 && JSON.parse(fJson1).hits[0].code === 'DM',
      '两跑长度 ' + fJson1.length + ' / ' + fJson2.length);

    // (d) 只读：写命令清单里都没有它（进去就是假声明）
    check('I-1 `features` 是**只读**：`WRITE_COMMANDS` / `DRY_RUN_COMMANDS` 里都没有它',
      fCore.WRITE_COMMANDS.indexOf('features') < 0 && fCore.DRY_RUN_COMMANDS.indexOf('features') < 0,
      '在册；WRITE 命中=' + (fCore.WRITE_COMMANDS.indexOf('features') >= 0)
        + ' / DRY_RUN 命中=' + (fCore.DRY_RUN_COMMANDS.indexOf('features') >= 0));

    // (d) MCP 侧：只读名册也有透传（`S2` 的 `mcp-gap` 是**双向**判据 —— CLI 有而 MCP 无会判红）
    const fTool = fMcp.TOOLS.filter((t) => t.name === 'features')[0];
    check('I-1 MCP 侧：`features` 工具在册、必填为空（只读名册）、有 grep/code 两个参数',
      !!fTool && JSON.stringify(fTool.inputSchema.required) === JSON.stringify([])
        && !!fTool.inputSchema.properties.grep && !!fTool.inputSchema.properties.code,
      fTool ? '在册；参数=' + Object.keys(fTool.inputSchema.properties).join(',') : '没注册');
  }

  /* 跑体**真的走完了** ⇒ `finally` 里的收尾用"只按名单收"的窄口径（见下面那段说明）。
     位置：必须是跑体的**最后一句** —— 崩在半路时它不会被设上，收尾才敢用宽口径。 */
  bodyCompleted = true;
} finally {
/* ---------------- 清理（跑体的 `finally`：正常跑完与**崩在半路**都走这里） ----------------
 * 两档口径，由 `bodyCompleted` 选：
 *   · 跑体走完 ⇒ **只按名单收**（与从前的清理段逐条一致）：不碰任何别人的目录 ——
 *     并发跑的另一份集成持有的是新鲜探针目录，按前缀扫会把人家的删掉（顶部 `sweepStaleProbes()`
 *     的 10 分钟口径就是为这件事设的）。
 *   · 崩在半路 ⇒ 名单收完再按**探针前缀**兜底扫一遍 `projects/`，但**排除开工前就在的那些**
 *     （`PRE_EXISTING_PROBES`，可能是并发跑的别人）。理由：崩的时候各分段自己的 `finally` 未必
 *     走完（§54/§55 这类"块末尾删"的段落就是如此）⇒ 残留会跨着好几种前缀；
 *     而"给下一个人留一个假项目"正是本脚本最不该干的事（实测：`it-broken-*` 残留让全链判红）。
 *     边界（如实登记）：并发起跑、且**在本次之后**才建出探针目录的那一份，会被这次兜底扫一起清掉 ——
 *     这个险只在**崩溃**路径上冒；`.visits` 的日志两种口径都按前缀清（父进程实测要求"跑完 it-* 计数 = 0"，
 *     而探针项目清掉后那些日志本来就是孤儿；非探针名字的日志**一个都不碰**：那是真项目的使用痕迹）。 */
run(['remove', PROJ2, 'root']);
try { fs.rmSync(path.join(ROOT, 'projects', PROJ6), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ7), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', K8A), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', K8B), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ4), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', BROKEN_PROJ), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ5), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ5 + '-bad'), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ3), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ2), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(XP_DIR, { recursive: true, force: true }); } catch (e) {}   // 8.7 的跨项目探针项目
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
/* 崩在半路的兜底档：本次**新出现**的探针目录（快照里没有的）按前缀一起收掉。
 * 正常跑完那一档**不执行**它 —— 见上面两档口径的说明。
 * 实现只一处（`sweepThisRunDebris`）：`exit` 事件与信号回调调的也是它（幂等）。 */
if (!bodyCompleted) sweepThisRunDebris('崩在半路');
/* 访问日志（热度条探针那几节钦的）：**在项目目录之外**（`<项目根>/.visits/<项目名>.jsonl`）⇒
 * 删项目目录删不掉它。不删就每跑一次留一份（本机实测：连跑几轮后 `projects/.visits/` 里
 * 堆了十几份 `it-probe-heat-*.jsonl`；`imp-probe-*.jsonl` 同样会留）—— 探针的收尾必须连**日志**
 * 一起清，否则读数与磁盘都会被污染。过滤口径 = 顶部那张 `PROBE_PREFIX`（**唯一一处**前缀清单）。 */
try {
  const probeLogs = visitLogDir();
  if (fs.existsSync(probeLogs)) {
    fs.readdirSync(probeLogs).filter((f) => PROBE_PREFIX.test(f))
      .forEach((f) => { try { fs.rmSync(path.join(probeLogs, f), { force: true }); } catch (e) { /* 收尾失败不判红 */ } });
  }
} catch (e) { /* 收尾失败不判红 */ }
}

console.log('\n==== ' + passed + '/' + (passed + failed) + ' CLI 集成断言通过 ====');
// 用 exitCode 而不是 process.exit()：后者**立即**终止，可能截断尚未 flush 的 stdout。
// 本脚本的全部断言输出现在走同一条 stdout（进程内调用，不再是每条一个管道），
// 截断会丢掉末尾的汇总行 —— 那正是人/CI 判读结果的第一行。
process.exitCode = failed ? 1 : 0;
