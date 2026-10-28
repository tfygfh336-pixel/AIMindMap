/* ============================================================
 * main-dsh-sidebar.js — DSH 侧边栏（主进程模块，v0.16）
 * ------------------------------------------------------------
 * 职责（唯一管理者，不依赖外部 Start-DSH.ps1）：
 *   1) 解析运行包（src/dsh-package.js：bundled / installed / active.json）
 *   2) 以捆绑 Node 孵化独立 DSH web 实例：
 *        <runtime>/node/node.exe <runtime>/app/lib/bin.js web
 *        --host 127.0.0.1 --port 0 --no-open
 *      env.DSH_HOME = <userData>/dsh-home（独立、持久，与全局实例互不可见）
 *      运行锁 dsh-runtime.lock 持有期间服务存续（与维护操作互斥）
 *   3) 从子进程 stdout 解析 loopback token URL（正则只认 127.0.0.1 + ?token=），
 *      HTTP 探活（期望 401/200，即服务真实可达）后才加载
 *   4) WebContentsView 停靠主窗口右侧；Ctrl+B / 菜单切换；resize 跟随；
 *      侧栏恒可见（v0.16.1 移除过窄自动隐藏）
 *
 * 生命周期（v0.16.6 驻留语义，README 有对外承诺）：
 *   · 孵化：detached + stdio 落文件（userData/dsh-service.log）→ 与孵化者彻底解耦；
 *   · 主界面退出：**不收割已就绪的服务**，保留 dsh-service.json，下次启动接管
 *     （「重启主界面而侧栏对话不中断」由此成立）；未就绪的服务照旧收割。
 *   · 显式停止：菜单「视图 → 停止 DSH 服务」（任务管理器之外的唯一正门）。
 *   · 运行锁 dsh-runtime.lock 的 pid 指向**服务进程**，维护互斥随服务生死。
 *
 * 两个 ✕ 的语义（本版起，README 有对外承诺）：
 *   · **导图页 ✕**（工具栏）/ 菜单「关闭思维导图页」/ CLI `sidebar-only on`
 *     ⇒ `closeMapPage()`：把导图页**从内存里卸掉**（主窗口导航到 renderer/map-closed.html
 *     占位页）；重开走 `openMapPage()`（**重新加载** + 还原停靠宽度 + 回到上次的项目）。
 *   · **侧栏 ✕** ⇒ `closeSidebar()`：收起侧栏 + **销毁**它的 WebContentsView + 停 DSH 服务；
 *     重开走 `show()`（`ensureView()` 重建视图 ⇒ 页面重新加载）。
 *   两者都是"真关"，代价都是"重开要重新加载，比挂回去慢" —— 这是用户明确选的语义 ✓。
 *
 * 安全边界：
 *   · view 的 webPreferences：contextIsolation / sandbox 开，nodeIntegration 关，
 *     无宿主 preload，独立 session partition —— 与 jsMind 渲染层零耦合。
 *   · token 只进主进程内存与 loadURL，不进渲染层 IPC、不进日志。
 *   · 子进程 env 清掉本应用注入的会话变量（AI_MINDMAP_PROJECTS_DIR 等），
 *     避免冒烟沙箱之类的影响泄漏进 DSH。
 *
 * 数据契约（.review/dsh-implementation-contract.md）：
 *   · 侧栏是纯视图容器 + 进程管理器；DSH 的 profile/插件/会话全部住在
 *     独立 DSH_HOME 里，由 DSH 自己管理（插件支持 = profile 机制原样保留）。
 *   · 更新/回滚走 scripts/dsh-maintenance.js（active.json 原子切换，
 *     运行锁持有期间维护被拒）。
 * ============================================================ */
'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const dshPackage = require('./src/dsh-package.js');
const sidebarSkill = require('./src/dsh-sidebar-skill.js');
// 第 4 面板（停靠面板）的几何**单源**：右侧让位带的三段算术只写在这一处（纯函数、零 Electron）
const panelGeometry = require('./src/panel-geometry.js');
// 第 4 面板的**页面本体**（唯一实现；本文件只把它包成 data: URL —— 理由见 dockPanelPageHtml 的注释）
const dockPanelPage = require('./src/dock-panel-page.js');
// 「拖节点 ⇒ 真 chip」的客户端插件载荷 + 纯逻辑（唯一真源；装卸/核对也在这里，见 docs/DSH-EMBEDDED.md A7）
const chipFeed = require('./src/dsh-chip-feed.js');

const SIDEBAR_WIDTH = 420;
const MIN_WIDTH = 280;
/* 控制栏宽（拖宽热区 + −/✕ 两个按钮都在这一条里；原先热区 6px、按钮浮在页面上 ✗）。
 *  声明位置 2026-10-19（单位修复批）从"左缘控制栏"那一节**上移到这里**：下面 `RIGHTBAR_MIN_BAND`
 *  要做"带宽 → 页面视口"的换算，而顶层 `const` 的初始化表达式受 **TDZ** 约束（写在后面就是
 *  ReferenceError）⇒ 一份常量只留一处声明，位置按依赖顺序摆 ✓。 */
const RAIL_WIDTH = 30;
// 上限 720 → 900：内核右栏在窄模式（view < 1024）下需要
// available = view − 56（左栏图标轨道）− 400（中间列保底）≥ 300 ⇒ **view ≥ 756px**，
// 而 720 上限连 756 都够不着 ⇒「打开侧边栏」永远只会"点一下就消失" ✗（实测 694 时 available=238 ✗）。
const MAX_WIDTH = 900;
// 右栏预算的**上界**（view = 900 − 30 控制栏 = 870 ⇒ available = 414 ≥ 300 ✓）。
// 2026-10-16（测量驱动批）起：右栏**不再**一步到位加到它 —— 按下面的预算档逐步加，
// 每一步都由实测的 overflow 决定要不要继续；到它仍溢出就**如实上报**（见 state.contentBudget）。
const RIGHTBAR_AUTO_WIDTH = 900;
// 页面（view）达到这个宽度，内核就会给出 ≥ 300px 的右栏（见上面推导）
const RIGHTBAR_PAGE_MIN = 756;
/* ⚠️ **单位**（2026-10-19「侧栏宽度单位修复」批）：上面 756 是**页面视口**（DSH 页面自己的 viewport）
 *  的门槛，**不是**侧栏这条带的宽度。内核源码（只读引用，不改运行包）——
 *  `vendor/dsh/app/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js` 的
 *  `computeColumns(viewport, sidebar, rightbar, collapsedWidth = 56)`：
 *      const available = viewport - s - 400;      // s = 左栏（视口 < 1024 时自动折叠成图标轨 56）
 *      const r = rightbar === 0 || available < 300 ? 0 : …;
 *  ⇒ 视口必须 ≥ 56 + 400 + 300 = 756；而本文件的 `state.width` 是**整条带**
 *  （控制栏 RAIL_WIDTH + DSH 页面）⇒ 页面视口 = state.width − RAIL_WIDTH
 *  ⇒ 带的**下限**必须是 756 + 30 = **786**（不是 756）。
 *  为什么单列一个常量而不是就地 +30：上一批（7df6188）把 756 直接当带宽用 ⇒ 带 756 只得到视口 726、
 *  `available = 726 − 456 = 270 < 300` ⇒ 内核照样把右栏算成 **0 宽**（"点一下就消失"那个 bug
 *  原封不动回来 ✗），而当时的门禁因为期望值也写的 756 ⇒ **是绿的**。这个 30px 的差不是数字错，
 *  是"两个量共用了一个名字" ⇒ 修法是把**两个量分成两个名字**（本常量 + 上面那条）。 */
const RIGHTBAR_MIN_BAND = RIGHTBAR_PAGE_MIN + RAIL_WIDTH;
// 内容预算的**步进**（见「内核右栏 ⇄ 侧栏自动加宽」整节）：
// 一次加多少 / 最多加几次。两者相乘必须 ≥（上界 − 下界）否则永远到不了上界、也就永远不会上报 ✗
//（144 / 54 = 2.67 ⇒ 3 步到上界 ✓；这里留 6 步的余量，到上界会被 clampWidth 卡住）。
const WIDTH_STEP_PX = 54;
const WIDTH_STEP_MAX = 6;

/** 子进程 stdout 里带 token 的地址行（实测样例）：
 *    dsh web: http://127.0.0.1:6218/?token=xxxxxxxx
 *  只认 127.0.0.1 —— 防 stdout 里混进其他地址被误加载。 */
const URL_RE = /https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]+)/;

const state = {
  win: null,            // 主窗口
  view: null,           // WebContentsView（惰性创建）
  rail: null,           // 左侧原生控制栏 view（拖宽 + − / ✕）
  proc: null,           // dsh web 子进程（本窗口孵化时才有）
  procLock: null,       // 运行锁（dsh-runtime.lock）
  url: null,            // 带 token 的地址（只在主进程内存）
  visible: true,        // 侧栏是否显示（**默认打开**，loadPrefs 再覆盖）
  width: SIDEBAR_WIDTH, // 侧栏宽度（可拖拽调节，持久化）
  status: 'idle',       // idle|starting|running|stopping|error
  lastError: null,
  stdoutBuf: '',
  logTimer: null,       // 启动日志轮询（stdio 落文件后用它抓 token URL）
  logOffset: 0,         // 本轮启动的日志读取起点（避免读到上一轮服务的旧 URL）
  startTimer: null,
  healthTimer: null,
  servicePid: null,     // 驻留服务的 pid（adopt 场景：proc 为 null 但服务活着）
  dshOnly: false,       // 仅侧边栏模式（外部 AI 迭代主界面时开启；导图页被**卸载**）
  // ── 导图页「真关」的状态（关 = 把这一页从内存里卸掉，不是把它藏起来）──────────────
  //   语义改动见 README「DSH 侧边栏的三条操作语义」；判据字段一起进 getStatus()（断言不靠猜 ✓）
  mapPageClosed: false, // 导图页是否处于"已卸载"（此时主窗口跑的是 renderer/map-closed.html 占位页）
  lastProject: null,    // 导图页最后打开的项目名（主进程存住 ⇒ 重开时能回到同一个项目）
  bootProject: null,    // 只由 openMapPage() 武装：本次页面加载该去开哪个项目（页面 boot 时问一次）
  dockWidth: null,      // 关闭前的**停靠宽度**（重开还原它；关闭期间拖宽被禁用 ⇒ 不会被改坏）
  viewEpoch: 0,         // view 被创建过几次（**判别力**：重开必须是新视图，不是把旧的又挂回来）
  lastDestroyedViewId: null, // 最近一次被销毁的 view 的 webContents id（断言"真的销毁了"用）
  // ── 测量驱动的宽度（2026-10-16「动态侧栏宽度」批）─────────────────────────────
  //   两者分工（缺一个就读不出"为什么现在这么宽"）：
  //   userTookOver —— **用户手动拖过宽度**的锁。自动档（右栏让位 / 内容预算）一律让步于它；
  //                   只在"下一次右栏会话开始"（ensureRightbarRoom 真的动手时）复位 ⇒ 每次开右栏
  //                   都给自动档一次机会，而不是"拖过一次就永远不再自动加宽" ✗。
  //   contentBudget—— **内容预算的实况**（档位 / 区间 / 每一步的实测读数 / 到位与否 / 溢出实况）。
  //                   它把"内容装不下"从只进诊断的读数变成**可回退、有读数、能上报**的状态机；
  //                   区间是 [RIGHTBAR_MIN_BAND…MAX_WIDTH]（**带宽**口径，含控制栏），步进 WIDTH_STEP_PX。
  userTookOver: false,
  contentBudget: null,
  // ── 第 4 个原生面板（停靠面板 · 2026-10-18 底座批）─────────────────────────────
  //   dock —— **意图**（开/关 + 期望宽度 + 上一次的 prev）。几何不在这里算：唯一计算处是
  //           `src/panel-geometry.js` 的 computeGeometry()，唯一应用处是 relayout()。
  //   prev —— 开/关前那一刻的 {open, width}（"关要一步回到原样"的可复核记录；关掉后**保留**，
  //           不清成 null，否则事后无法回答"它还原到哪去了"）。
  //   lastRestore —— 最近一次关闭时 **关前/关后两份几何快照**（逐项复原的取证点）。
  // ⚠️ 别与 state.dockWidth 看混：**这个是第 4 面板**；state.dockWidth 是"导图页/侧栏切换时要还原的
  //    停靠宽度"（另一个东西）。两者都叫"dock"是历史用词，改名字会动到既有的重开语义 ⇒ 这里只加注释指开。
  dock: {
    open: false,
    width: panelGeometry.DEFAULTS.panelWidth,
    prev: null,
    epoch: 0,
    restores: 0,
    lastRestore: null,
    pageErr: null,
    // ── 面板页 ⇄ 主进程的**消息桥**（第 2 批 a76bab32：「AI 改了哪些文件」清单的第一份业务内容）
    //    bridge    —— 由**业务方**（`main.js`）注册的处理函数；本文件**不认识**改动清单这回事
    //                 （它只知道"页面发来一条请求"，谁来回由业务方决定 ⇒ 面板底座与业务解耦）。
    //    pageReady —— 页面 `did-finish-load` 之后才允许 executeJavaScript 推数据。
    //    lastPush  —— 最近一次推送的读数（谁、多大、成没成）——失败**不许静默**，要有读数。
    //    rendered  —— 页面自己回传的"我一共画了几行"（页面侧真值 ⇒ 判据可与主进程读数对拍）。
    bridge: null,
    pageReady: false,
    pendingPush: null,
    lastPush: null,
    rendered: null,
    lastMessage: null
  },
  panelView: null,          // 面板的 WebContentsView（惰性创建；关闭只摘不销毁，见 destroyPanel）
  lastDestroyedPanelId: null,
  // ── 拖动虚影（甲 = 同窗口 WebContentsView；2026-10-33 批3）──────────────────────────
  //   ghost      —— 那块 view（**按窗口复用**：拖几次都只有一块 ⇒ children.length 不随拖拽增长）
  //   ghostWin   —— 它挂在哪个窗口上（窗口关 ⇒ 引用作废、下次拖拽重建）
  //   ghostText  —— 当前已经推给页面的文字（null = 页面里那份不可信，下拍重发）
  //   其余三个是**读数**（钉住"建了几块 / 推了几次文字"，失败与重复都能看出来）
  ghost: null,
  ghostWin: null,
  ghostText: null,
  ghostCreates: 0,
  ghostPushes: 0,
  ghostShown: false,
  ghostLastAt: 0,
  geometry: null,           // **最近一次应用的几何**（computeGeometry 的产物；读数/断言的单一事实）
  // ── 加载失败判定（r12 收口批 · 见 createStatusPageLoadTracker 那一节）──────────────────
  //   statusPageLoad       —— 判定器实例（懒建；判据读数从这里出，日志里不再有良性的 `-3`）
  //   statusPageSettleTimer—— `-3` 挂起后的结算定时器（一个就够，每次挂起重置）
  statusPageLoad: null,
  statusPageSettleTimer: null,
  // 测试接缝：让结算读到的"视图事实"可注入（见 setStatusPageSettleFactsForTest 的注释）。
  // 产品路径永远是 null ⇒ 读真实 state。
  statusPageSettleFactsForTest: null,
  // ── 投喂台账（2026-10-42「追加语义」批）────────────────────────────────────────
  //   feedLedger —— 已**应用过**的投喂批次：`[{seq, n, mode, route, at}]`，FIFO 上限 FEED_LEDGER_MAX。
  //     它和 `seq` 一起构成投喂幂等的**唯一**依据（旧版靠 `setDraft('')` 清空草稿 —— 那等于用
  //     "覆盖"换"幂等"，第二次投喂把第一次的块全抹掉，正是用户真机报的那个缺陷）。
  //     为什么是 FIFO 集合而不是"高水位 seq > lastSeq"：调用方给的 seq 不保证单调
  //     （控制通道 token / 重放 / 将来跨进程序号都可能更小），高水位会把一次**合法的追加**
  //     静默吞掉（用户丢了块还不报错）；集合只吞同一个 seq，永不吞别的。
  //   feedSeqNo  —— 本进程的序号发号器（只有"调用方没给 seq"时才用）。
  //   feedSeqByToken —— **命令身份 → seq** 的恒等映射（2026-10-70 收口）：
  //     控制通道的命令身份是字符串 `token`（`cmd-<pid>-<time>-<seq>-<hex>`），而 seq 的合法域
  //     是**有限正整数** ⇒ 直接拿 token 当 seq 会被判非法、退回发新号（"看起来接上了，
  //     其实一行都没生效"）。这张映射把同一 token 恒等换到同一个号：重试被台账吞掉，
  //     不同命令的号一定不同（见 `feedSeqByToken` 的注释：为什么不用哈希取模）。
  feedLedger: [],
  feedSeqByToken: new Map(),
  feedSeqNo: 0,
  shuttingDown: false
};

function log(msg) { console.log('[dsh-sidebar] ' + msg); }

/* ---------------- 路径 ---------------- */

function userDataPath() { return app.getPath('userData'); }
function dshHome() { return path.join(userDataPath(), 'dsh-home'); }
/** 服务启动/运行日志（stdio 落这个文件而不是 pipe —— 见 startService 的说明） */
function serviceLogFile() { return path.join(userDataPath(), 'dsh-service.log'); }

/** bundled 运行包根：dev = <工程>/vendor/dsh；打包后 = resources/dsh */
function bundledRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'dsh');
  return path.join(__dirname, 'vendor', 'dsh');
}

/** 工程根（dev = 本目录；打包后 = resources/app.asar 所在工程不可写，
 *  笔记真源是用户数据里的工程 —— 打包场景由 extraResources 的工程副本承载，
 *  这里统一取应用根：dev 下即 ai-mind-map/）。侧栏 AI 的会话 cwd 指向这里，
 *  使 `node cli/mm-cli.js …` 直接可用。 */
function projectRoot() {
  return __dirname;
}

/* ---------------- 侧栏 AI 的操作能力注入 ----------------
 * 设计初衷：内置 AI 一边对话一边编辑笔记。让侧栏 AI 具备操作能力只需两件事：
 *   1) 会话 cwd = 工程根（spawn 的 WorkingDirectory，DSH 会话继承主进程 cwd）
 *      → `node cli/mm-cli.js …` 直接可用；
 *   2) DSH_HOME/skills/ai-mind-map/SKILL.md —— 指针型 skill（首次启动写入一次，
 *      内容不随工程漂移：只写"真源在哪、先读什么"），侧栏 AI 的 skill 列表里
 *      就会出现本工程的操作规范（dsh-skill-filesystem 扫描 $DSH_HOME/skills）。
 * 笔记编辑走 CLI 校验闸门（validate-only，轻量）；改代码才需要全量 verify ——
 * 这条分流写死在指针 skill 与 AI-GUIDE 里。 */

const SKILL_DIR_NAME = 'ai-mind-map';

/** 生成指针 skill 内容（真源路径注入；内容生成在 src/dsh-sidebar-skill.js 可单测） */
function ensureSidebarSkill() {
  try {
    const dir = path.join(dshHome(), 'skills', SKILL_DIR_NAME);
    const file = path.join(dir, 'SKILL.md');
    const content = sidebarSkill.buildSidebarSkillContent(projectRoot()).content;
    // 幂等：已存在且内容一致就不动（真源路径变了才重写）
    let existing = null;
    try { existing = fs.readFileSync(file, 'utf8'); } catch (e) { /* 不存在 */ }
    if (existing !== content) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      log('侧栏 skill 已注入: ' + file);
    }
  } catch (e) {
    log('注入 skill 失败（不阻断启动）: ' + e.message);
  }
}

/* ---------------- 子进程孵化 ---------------- */

/** 清掉会干扰 DSH 的本应用环境变量（继承白名单之外的都删） */
function buildEnv(runtimeRoot) {
  const env = {};
  const drop = /^(AI_MINDMAP_|DSH_|ELECTRON_RUN_AS_NODE|npm_)/i;
  for (const k of Object.keys(process.env)) {
    if (!drop.test(k)) env[k] = process.env[k];
  }
  env.DSH_HOME = dshHome();
  // PATH 前置包内 bin（pnpm shim），保证 dsh plugin 命令可用
  env.PATH = path.join(runtimeRoot, 'bin') + path.delimiter + (env.PATH || '');
  return env;
}

function startService() {
  // 冒烟模式：**唯一孵化点**要拦住 —— 只在 adoptOrStart() 里拦是不够的 ✗：
  // show() 发现"没在跑"时也会直接调这里，于是冒烟仍然会孵出一个真服务（实测 status=running ✗），
  // 既拖慢 G5（40–60s、随负载抖到 172.7s ✗），又可能接管用户正在用的那个服务 ✗。
  if (state.noSpawn) {
    state.status = 'idle';
    return;
  }
  if (state.status === 'starting' || state.status === 'running') return;
  let runtime;
  try {
    runtime = dshPackage.resolveRuntime({
      bundledRoot: bundledRoot(),
      userDataPath: userDataPath(),
      verifyHashes: false // 启动快路径；导入/维护时才全量校验
    });
  } catch (e) {
    state.status = 'error';
    state.lastError = '运行包不可用: ' + e.message;
    log(state.lastError);
    // 注意：`broadcastStatus` **不是外部注入的**，就是本文件里的函数声明（定义在本文件
    // **下方**、调用点在它上面，靠**函数声明提升**成立 —— 见它的定义处那条注释）。
    // 别因为"上面看不到定义"就以为这里会 ReferenceError ✗。
    broadcastStatus();
    return;
  }
  fs.mkdirSync(dshHome(), { recursive: true });
  ensureSidebarSkill(); // 侧栏 AI 的操作能力注入（幂等）

  // 运行锁（与维护互斥）。陈旧锁（持有进程已死）自动接管。
  try {
    state.procLock = dshPackage.acquireRuntimeLock(userDataPath(), { op: 'sidebar' }, 'run');
  } catch (e) {
    // 锁被活跃持有 = 已有驻留服务在跑（比如上一个主界面还没退干净，或用户
    // 独立启动过）→ 尝试接管而不是报错（解耦的关键路径）
    log('锁被持有，尝试接管驻留服务: ' + e.message);
    if (adoptExistingService()) return;
    state.status = 'error';
    state.lastError = e.message;
    broadcastStatus();
    return;
  }

  state.status = 'starting';
  state.lastError = null;
  state.stdoutBuf = '';
  broadcastStatus();

  const args = [runtime.dsh, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'];
  // stdio 落**文件**而不是 pipe（驻留语义的前提，v0.16.6）：
  //   主界面退出后 pipe 的读端就没了，服务再往 stdout 写会 EPIPE —— 一个"退出主界面
  //   反而把侧栏弄崩"的隐性风险。文件 fd 让服务与孵化者彻底解耦（scripts/dsh-resident-e2e.js
  //   验证驻留用的就是这个配置，此前 main 里用 pipe 与之并不一致）。
  const logPath = serviceLogFile();
  let logFd = 'ignore';
  // 起点 = 当前文件长度：只读本轮新增的字节。日志是**追加**的，不从末尾开始
  // 就会读到上一轮服务留下的旧 token URL，对着一个已死的端口反复探活。
  try { state.logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0; } catch (e) { state.logOffset = 0; }
  try { logFd = fs.openSync(logPath, 'a'); } catch (e) { logFd = 'ignore'; }
  const proc = spawn(runtime.node, args, {
    env: buildEnv(runtime.root),
    cwd: projectRoot(), // 会话 cwd = 工程根：侧栏 AI 打开即可 `node cli/mm-cli.js …`
    windowsHide: true,
    detached: true, // 脱离主进程 Job Object：主界面重启/退出不连带杀服务（实测验证）
    stdio: ['ignore', logFd, logFd]
  });
  if (typeof logFd === 'number') { try { fs.closeSync(logFd); } catch (e) { /* 子进程已复制 fd */ } }
  tailServiceLog();
  proc.unref(); // 不阻止主进程退出（服务生命周期独立于本进程）
  state.proc = proc;
  state.servicePid = proc.pid;
  // 运行锁改指服务进程：孵化者（本进程）随后可能退出，而服务还活着 ——
  // 锁必须跟着**服务**的生死走，否则维护会在活服务脚下换运行包（见 dsh-package）。
  if (state.procLock) {
    const ok = dshPackage.retargetRuntimeLock(state.procLock, proc.pid);
    log('运行锁改指服务 pid=' + proc.pid + (ok ? '（成功）' : '（失败：锁已被接管，维护互斥可能失效）'));
  }
  log('spawn pid=' + proc.pid + '（dsh ' + runtime.manifest.dshVersion + '，source=' + runtime.source
    + '，cwd=' + projectRoot() + '，detached，日志=' + (logFd === 'ignore' ? '未接' : logPath) + '）');
  // 服务信息落盘（本地 userData，仅本机）：先写 pid；URL 就绪后补全
  writeServiceInfo(proc.pid);

  // 启动超时（90s 内没见到 token URL 就收割并放弃，防白屏挂死；错误页可重试）
  // 收割而不是放着：半启动的服务会占住运行锁，让下一次启动既接管不了也孵化不了。
  state.startTimer = setTimeout(() => {
    if (state.status === 'starting') {
      state.lastError = 'DSH 启动超时（90s 未见就绪地址）';
      log(state.lastError);
      stopService();
      state.status = 'error';
      if (state.visible && state.view) showStatusPage(errorPageHtml(state.lastError));
      broadcastStatus();
    }
  }, 90000);
}

/** 轮询服务日志抓 token URL（stdio 已落文件，不再有 stdout 事件）。
 *  每 300ms 读新增字节，累积到 stdoutBuf 里匹配 URL_RE；就绪或终止即停。 */
function tailServiceLog() {
  if (state.logTimer) { clearTimeout(state.logTimer); state.logTimer = null; }
  const tick = () => {
    state.logTimer = null;
    if (state.status !== 'starting') return;
    try {
      const size = fs.statSync(serviceLogFile()).size;
      if (size > state.logOffset) {
        const len = Math.min(size - state.logOffset, 65536);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(serviceLogFile(), 'r');
        try { fs.readSync(fd, buf, 0, len, state.logOffset); } finally { fs.closeSync(fd); }
        state.logOffset += len;
        state.stdoutBuf += buf.toString('utf8');
        if (state.stdoutBuf.length > 8192) state.stdoutBuf = state.stdoutBuf.slice(-8192);
        const m = URL_RE.exec(state.stdoutBuf);
        if (m) { probeThenLoad('http://127.0.0.1:' + m[1] + '/?token=' + m[2]); return; }
      }
    } catch (e) { /* 日志文件可能尚未创建 */ }
    state.logTimer = setTimeout(tick, 300);
  };
  state.logTimer = setTimeout(tick, 300);
}

/** token URL 出现后先探活：服务真实可达才 loadURL。
 *  实测（e2e 303 缺口）：带 token 首访 = 303 + Set-Cookie（会话引导）→ 200。
 *  故 200/301/302/303/401 都视为"服务在线"；唯一例外 404/5xx 才判未就绪。
 *  探活通过即置 running 并由调用方 loadURL（view 里带 token 的完整加载
 *  由 Chromium 自己跟随 303 与 Cookie —— 浏览器请求天然带 cookie jar）。 */
function probeThenLoad(url) {
  const u = new URL(url);
  http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 5000 },
    (res) => {
      const ok = [200, 301, 302, 303, 401].includes(res.statusCode);
      res.resume();
      if (!ok) return; // 未就绪：等日志轮询重试或超时
      clearTimeout(state.startTimer);
      clearInterval(state.startTimer);
      state.startTimer = null;
      if (state.logTimer) { clearTimeout(state.logTimer); state.logTimer = null; }
      state.url = url;
      state.status = 'running';
      log('服务就绪 ' + u.host);
      writeServiceInfo(state.servicePid, url); // 服务信息含 token URL（仅本地磁盘）
      if (state.visible) loadCurrentUrl();
      broadcastStatus();
      startHealthLoop();
    }).on('error', (e) => {
      log('探活失败（稍后由 stdout 重试）: ' + e.message);
    }).on('timeout', function () { this.destroy(); });
}

/* ---------------- 服务驻留与接管（主界面重启不影响侧栏） ----------------
 * 生命周期解耦：dsh web 是独立进程，它的存活不依赖任何 BrowserWindow。
 *   · 孵化方把 { pid, url } 写进 service-info（userData 本地文件）；
 *   · 新主界面启动 → adoptExistingService()：读文件 → pid 活性 + HTTP 探活
 *     → 都通过则**接管**（proc=null、servicePid=pid、直接 loadURL）——
 *     侧栏交互界面原样保留，只有导图主界面经历了重启；
 *   · 健康循环每 5s 探活：服务死了 → 状态转 error（错误页带重试）。
 * 安全边界：service-info 只落 userData 本地磁盘（127.0.0.1 + 单用户），
 * 不跨网络、不进渲染层 IPC、不写日志。 */

function serviceInfoFile() { return path.join(userDataPath(), 'dsh-service.json'); }

function writeServiceInfo(pid, url) {
  try {
    fs.writeFileSync(serviceInfoFile(), JSON.stringify({
      pid, url: url || null, since: new Date().toISOString()
    }), 'utf8');
  } catch (e) { log('service-info 写入失败: ' + e.message); }
}

function readServiceInfo() {
  try {
    const s = JSON.parse(fs.readFileSync(serviceInfoFile(), 'utf8'));
    return (s && typeof s.pid === 'number') ? s : null;
  } catch (e) { return null; }
}

function clearServiceInfo() {
  try { fs.unlinkSync(serviceInfoFile()); } catch (e) { /* ignore */ }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/** HTTP 快速探活：任何响应（含 401/303）= 端口上有活的 DSH web */
function httpAlive(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.get({ host: u.hostname, port: u.port, path: '/', timeout: timeoutMs },
        (res) => { res.resume(); resolve(true); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch (e) { resolve(false); }
  });
}

/** 尝试接管既有驻留服务。成功返回 true 并置 running。 */
async function adoptExistingService() {
  const info = readServiceInfo();
  if (!info || !info.url) return false;
  if (!pidAlive(info.pid)) { clearServiceInfo(); return false; }
  const alive = await httpAlive(info.url, 3000);
  if (!alive) { clearServiceInfo(); return false; }
  // 接管：不抢锁（原持有者还活着）、不孵化进程，只接 URL 与 pid 记录
  state.proc = null;
  state.procLock = null;
  state.servicePid = info.pid;
  state.url = info.url;
  state.status = 'running';
  state.lastError = null;
  log('已接管驻留服务 pid=' + info.pid);
  if (state.visible && state.view) loadCurrentUrl();
  broadcastStatus();
  startHealthLoop();
  return true;
}

/** init 时的入口决策：先试接管，接管不了才孵化 */
async function adoptOrStart() {
  // 冒烟模式：**既不孵化、也不接管** ✓
  //  为什么（实测教训）：22-*/23-*/24-* 那条几何断言会顺手孵化一个真的内置 DSH 服务，
  //  启动耗时 40–60s 且随机器负载剧烈波动 ⇒ 同一份代码实测 94.9s 通过、172.7s 被守卫掐掉 ✗，
  //  假红排查代价极高 ✓。而这几条断言要验的是**几何**（控制栏位置/让位宽度/按钮 DOM ✓），
  //  不需要服务 ✓。顺带还消掉一个隐患：以前冒烟会**接管用户正在用的那个服务**，收尾时把它停掉 ✗。
  if (state.noSpawn) {
    // ⚠️ 桩服务场景：`injectStubServiceForTest()` 已经装上了 `{status:'running', url}`，
    //    这里**不能**把它清成 idle —— 否则桩脚本刚接上就被本函数（`init` 里 setImmediate 调它）
    //    打回 idle ⇒ `prefillComposer` 永远停在"服务没在运行"，成功分支还是走不到 ✗
    if (state.url) {
      log('桩服务已接入：跳过服务孵化/接管（url=' + state.url + '）');
      return;
    }
    log('冒烟模式：跳过服务孵化/接管（几何断言不需要服务，避免把真实服务牵连进来）');
    state.status = 'idle';
    return;
  }
  if (await adoptExistingService()) return;
  startService();
}

/** 给冒烟用：true = 不孵化也不接管服务（默认 false，正常运行不受影响） */
function setNoSpawn(flag) {
  state.noSpawn = !!flag;
}

/* ---------------- 测试专用：把"已就绪的服务"直接接上（**给桩用，不是产品路径**） ----------------
 * 为什么需要它：`dsh-prefill` 的**成功分支**（真的把文本塞进页面输入框）在门禁里永远走不到 ——
 * 冒烟跑在 `setNoSpawn(true)` 下，`prefillComposer` 永远停在 `state.status !== 'running'` 那一句。
 * 于是"投喂成功"这半边没有任何门禁覆盖，坏了也只有真机才发现（这正是 D7 要治的）。
 *
 * 它做的只有一件事：把 `{status:'running', url:给定地址}` 装上，并让视图去加载那个地址 ——
 * **不孵化进程、不认领任何真实服务、不碰 service-info 文件**。
 * 调用方：`scripts/dsh-prefill-stub.js`（它自己起一个只回静态 HTML 的本地桩服务）。
 * ⚠️ 只应在**测试**里调用；产品路径要"接管"请走 `adoptExistingService()`（它会做 pid + HTTP 双探活）。
 * @param {string} url 桩服务地址（http://127.0.0.1:<port>/） */
function injectStubServiceForTest(url) {
  if (!url || !/^https?:\/\//.test(String(url))) return false;
  state.url = String(url);
  state.proc = null;
  state.procLock = null;
  state.servicePid = null;      // 没有 pid（桩不是本模块孵化的）⇒ 不做 pid 健康检查
  state.status = 'running';
  state.lastError = null;
  ensureView();
  loadCurrentUrl();
  broadcastStatus();
  return true;
}

/* ---------------- 测试专用：**读数接缝**（`scripts/smoke/53-sidebar-width-budget.js` 用） -------
 * 为什么需要（实测结论，2026-10-16）：本仓库冒烟/离屏窗口里 `WebContentsView.setBounds()` 不保证
 *   页面视口跟着重排（见 `measurePageOverflow` 注释：连续 6 次改宽页面视口都不动）
 *   ⇒"内容装不下 ⇒ 继续加宽 ⇒ 到上界上报"这条闭环在门禁环境里**跑不到**；
 *   判据写在那里就成了"永远不判"的空转（本工程明令禁止的那一类）✗。
 * 它只做一件事：让 `measurePageOverflow()` 用调用方给的**读数**代替真实页面读数。
 *   · **不换 `state.view`**（第一版换过，结果 `relayout()` 的 `setBounds` 打到桩上、抛
 *     `state.view.setBounds is not a function` —— 因为注入的定时器会在桩还在位时触发 relayout）；
 *   · **不注入任何判据**：换了读数之后仍然走 `runContentBudget()` 那条真实编排
 *     （同一份 `budgetTargetWidth`、同一个 `setWidth` 出口、同一份上报与读数序列）✓；
 *   · 产品路径绝不设置它（导出名带 `__`，与 `__viewForTest` 同一档）。
 * @param {null|function():{pageViewportWidth:number,innerWidth:number,scrollWidth:number,overflow:boolean}} fn */
function setMeasureProbeForTest(fn) {
  state.measureProbeForTest = typeof fn === 'function' ? fn : null;
  return true;
}

/** 测试专用：把侧栏视图交出来（桩脚本要读它页面里的 DOM 真值）。没有视图返回 null。 */
function viewForTest() { return state.view || null; }

/** 健康循环：detached 服务没有 exit 事件可听，用轮询补齐死亡感知（pid + HTTP 双探）*/
function startHealthLoop() {
  if (state.healthTimer) return;
  state.healthTimer = setInterval(async () => {
    if (state.status !== 'running') return;
    const pidOk = state.servicePid && pidAlive(state.servicePid);
    const httpOk = state.url ? await httpAlive(state.url, 2500) : false;
    if (!pidOk && !httpOk) {
      log('服务失联（pid 与 HTTP 都不可达）');
      state.status = 'error';
      state.lastError = 'DSH 服务已退出';
      state.proc = null;
      state.servicePid = null;
      state.url = null;
      clearServiceInfo();
      if (state.procLock) { try { state.procLock.release(); } catch (e) { /* ignore */ } state.procLock = null; }
      if (state.visible && state.view) showStatusPage(errorPageHtml(state.lastError));
      broadcastStatus();
    }
  }, 5000);
}

function stopService() {
  if (state.startTimer) { clearInterval(state.startTimer); clearTimeout(state.startTimer); state.startTimer = null; }
  if (state.logTimer) { clearTimeout(state.logTimer); state.logTimer = null; }
  if (state.healthTimer) { clearInterval(state.healthTimer); state.healthTimer = null; }
  // 收割目标：优先本进程孵化的 proc；**接管场景**（proc=null）也要按 servicePid 收割 ——
  // 否则菜单「重启 DSH 服务」在接管实例上只会清掉 service-info，留下一个活着但
  // 没人认领的服务占住运行锁，重启必然失败（驻留语义下"接管"是常态，必须支持）。
  const pid = state.proc ? state.proc.pid : state.servicePid;
  if (pid) {
    log('停止服务 pid=' + pid + (state.proc ? '（本进程孵化）' : '（接管）'));
    try {
      // Windows：taskkill /T 收割整棵进程树（DSH 会孵化 runner 子进程）。
      // **同步**执行：异步 spawn 的子进程会随宿主 Job 一起被终止 ——
      // "点完停止立刻退出应用"时收割根本没发生（实测 dsh:resident 阶段 4 复现：
      // 宿主退出后服务仍在）。收割必须在返回前落地。
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (e) { log('kill 异常: ' + e.message); }
  }
  state.proc = null; // exit 回调里不会再重复处理
  state.servicePid = null;
  state.url = null;
  clearServiceInfo();
  // 锁：孵化方手里有锁 → 按 token 释放；接管场景（procLock 为 null）→ 锁在盘上
  // 且 pid 指向刚被杀掉的服务，按 pid 精确清掉（否则留下一个假持有者挡维护）
  if (state.procLock) {
    try { state.procLock.release(); } catch (e) { /* ignore */ }
    state.procLock = null;
  } else if (pid) {
    dshPackage.clearRuntimeLockFor(userDataPath(), pid);
  }
  if (state.status !== 'error') state.status = 'idle';
}

/* ---------------- 状态页（启动中 / 错误） ----------------
 * 灰屏根因修复：启动期 view 是空白 WebContentsView（看起来"灰色没反应"）。
 * 现在启动中显示占位页，失败显示错误页 + 可点击重试（data: 页面经
 * console 消息回传重试意图 —— view 无 preload，这是唯一安全的反馈通道）。 */

const PAGE_STARTING = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
  + 'body{font-family:"Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;'
  + 'height:100vh;margin:0;background:#f5f6f8;color:#4e5969;flex-direction:column;gap:12px}'
  + '.spin{width:28px;height:28px;border:3px solid #d6e4ff;border-top-color:#1664ff;border-radius:50%;'
  + 'animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}'
  + '</style></head><body><div class="spin"></div><div>DSH 侧边栏启动中…（首次约需几十秒）</div></body></html>');

function errorPageHtml(msg) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'body{font-family:"Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;'
    + 'height:100vh;margin:0;background:#f5f6f8;color:#86909c;flex-direction:column;gap:12px;padding:24px;text-align:center}'
    + 'button{padding:6px 18px;border:1px solid #d5d9e0;border-radius:4px;background:#fff;cursor:pointer;font-size:13px}'
    + 'button:hover{border-color:#1664ff;color:#1664ff}'
    + '</style></head><body><div><b>DSH 侧边栏异常</b></div><div style="font-size:12px">'
    + String(msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    + '</div><button onclick="console.log(\'[dsh-retry]\')">重试启动</button></body></html>');
}

/* ============================================================
 * 加载失败判定（r12 收口批 · 2026-10-24）
 * ------------------------------------------------------------
 * 由来：`.review/20261024-未核实项/00-定题.md` §3（`r12`）—— 旧实现是这一句**无条件**的日志：
 *   `showStatusPage()` 里 `loadURL(html).catch(e => log('状态页加载失败: ' + e.message))`。
 *   而 `show()` 每次重刷状态页都会把**上一次还没加载完**的那次顶掉，被顶掉的报
 *   `ERR_ABORTED (-3)`（Chromium 的「请求被取消」）。留档的 36 份日志里那一行**全是** `-3`
 *   （能区分：真销毁是 `-2`，定题用 `show:false` 的探针实测过两种机制），机制是「顶上去的那一次自己成功了」
 *   ⇒ 良性噪声。问题不在"它是不是良性"，而在**旧写法让"良性"只能靠人记得**。
 *
 * 现在（定题 §3.5 的「做法甲」）：判定只挂 `did-fail-load`（带 `isMainFrame` + `errorCode`），
 *   按**错误码**分流 —— "这条该不该响"由构造决定，不由注释决定：
 *
 *   ① `errorCode !== -3`（`-2` 加载途中被销毁 · `-102` 连不上 · `-105` 名字解析不了 · 认不出的码）
 *      ⇒ **立刻报错并点名**（描述 + 码 + URL）。这是真失败，一条都不能少。
 *   ② `errorCode === -3` ⇒ **不立刻报**：它对不对取决于"顶上去的那一次成没成" ⇒ **挂起**，等三种收束：
 *        · 同一 webContents 随后 `did-finish-load` ⇒ 那次无关紧要 ⇒ **不报错**（只在
 *          `getStatus().statusPageLoad` 里留计数与"最近一次被吸收的 -3"—— 观测面没删，只是不吵）；
 *        · 视图被销毁 / 侧栏不可见 ⇒ **只报告**（用户自己关的，不是加载失败）；
 *        · 到点仍**没有任何一次成功加载**且侧栏**仍可见** ⇒ **报错**：侧栏可能停在空白/错误页
 *          —— 这一档是"良性"的反证，必须红（定题 §3.5 那四条「该判红的形态」的第 2 条）。
 *   ③ `isMainFrame === false`（子框架）⇒ 不算这个视图的加载失败（只计数）。
 *   ④ 同一次失败既走 `did-fail-load` 也走 `loadURL()` 的 rejection ⇒ 后者**去重**（不重复刷两条）；
 *      **认不出的码照样报**（报文写「未知码」）—— 宁可吵，不许静默吞掉一个没见过的失败。
 *
 * ⚠️ **这不是"把日志关掉"**：非 `-3` 一条不少，而且比旧写法更可用（旧写法只有 `e.message`，
 *   连码都不一定有；现在描述、码、URL 都在）。四条判据（该红 / 该绿 / 边界 / 照样响亮）在
 *   `tests/dsh-sidebar-load.test.js`；真事件载荷由 `.review/20261024-r12-收口/probe-status-load.js` 取。
 * ============================================================ */

/** Chromium `net::ERR_ABORTED`：请求被取消。在本视图里它的**唯一常见成因**是"被后一次导航顶掉"。 */
const ERR_ABORTED = -3;
/** `-3` 挂起后多久结算（ms）。被顶掉的背后**总有**另一次导航已经发出，本机数据页/本机服务的
 *  成功加载是几十毫秒级 ⇒ 3s 只用来兜"另一次永远不回来"那种（那不是良性）。 */
const STATUS_PAGE_ABORT_SETTLE_MS = 3000;
/** 挂起期间若那次导航**还在加载**（大页面首载可能要几秒），最多再等这么久才判"它也没成"。
 *  没有这一档 ⇒ 3s 一到就把"其实还在加载"误判成失败（假红）；只有这一档 ⇒ 挂死的页面永远不判红。 */
const STATUS_PAGE_ABORT_MAX_WAIT_MS = 15000;

/** 报文里 URL 的截断长度：`data:` 页把整页 HTML 塞在 URL 里，原样打一行能上千字符，
 *  而"是哪个页面"看前 160 字符就够（码与描述在它前面，永远看得见）。 */
const FAILURE_URL_MAX = 160;

/** 归一一个失败事件 → `{ code, desc, url, isMainFrame }`。
 *  两个来源共用它：`did-fail-load` 的参数（`errorCode`/`errorDescription`/`validatedURL`）与
 *  `loadURL()` 的 rejection（`errno`/`code`/`message`，报文形如 `ERR_ABORTED (-3) loading 'data:…'`）。
 *  **认不出码时 `code` 是 null** —— 调用方必须按错误报（不许因为"不认识"就当没发生）。 */
function normalizeLoadFailure(ev) {
  const e = ev || {};
  let code = null;
  let desc = null;
  if (typeof e.errorCode === 'number') code = e.errorCode;
  else if (typeof e.errno === 'number') code = e.errno;
  if (typeof e.errorDescription === 'string' && e.errorDescription) desc = e.errorDescription;
  else if (typeof e.code === 'string' && /^ERR_/.test(e.code)) desc = e.code;
  if (code === null) {
    const m = /(ERR_[A-Z0-9_]+)[ \t]*\([ \t]*(-?\d+)[ \t]*\)/.exec(String(e.message || ''));
    if (m) { if (!desc) desc = m[1]; code = Number(m[2]); }
  }
  let url = '';
  if (typeof e.validatedURL === 'string' && e.validatedURL) url = e.validatedURL;
  else if (typeof e.url === 'string' && e.url) url = e.url;
  else {
    const m2 = /loading '([^']*)'/.exec(String(e.message || ''));
    if (m2) url = m2[1];
  }
  const isMainFrame = e.isMainFrame === undefined ? true : e.isMainFrame !== false;
  return { code: code, desc: desc, url: url, isMainFrame: isMainFrame };
}

/** 失败报文的**唯一格式**：前缀 + 描述 + 码 + URL。
 *  前缀按 URL 分流：`data:` 就是状态页（历史日志里那个前缀），http(s) 是 DSH 页面本体。 */
function failureLine(f, extra) {
  const statusPage = /^data:/i.test(String((f && f.url) || ''));
  const name = (f && f.desc) ? f.desc + ' ' : '';
  const code = (f && f.code !== null && f.code !== undefined) ? f.code : '未知码';
  let url = (f && f.url) ? String(f.url) : '';
  if (url.length > FAILURE_URL_MAX) url = url.slice(0, FAILURE_URL_MAX) + '…';
  return (statusPage ? '状态页加载失败: ' : '侧栏页面加载失败: ')
    + name + '(' + code + ')' + (url ? ' ' + url : '') + (extra ? ' —— ' + extra : '');
}

/** 判定器：**纯状态机**（零 Electron、零定时器；时间与"可见 / 在不在 / 还在不加载"都由调用方喂进来）。
 *  为什么必须是纯的：这套分流的四条判据要逐条打（`tests/dsh-sidebar-load.test.js`），
 *  而真 Electron 只在探针里跑一次 —— 判据不能只活在那一次里。 */
function createStatusPageLoadTracker(opts) {
  const o = opts || {};
  const clock = typeof o.now === 'function' ? o.now : Date.now;
  const dedupeMs = typeof o.dedupeMs === 'number' ? o.dedupeMs : 1000;
  const maxWaitMs = typeof o.maxWaitMs === 'number' ? o.maxWaitMs : STATUS_PAGE_ABORT_MAX_WAIT_MS;

  const counts = { navigations: 0, finished: 0, aborted: 0, reported: 0,
    absorbed: 0, dropped: 0, subframeIgnored: 0, deduped: 0 };
  const pending = [];      // 挂起中的 -3（等"随后成功 / 视图不在 / 到点"三者之一来收束）
  /* **只**记 `did-fail-load` 那一路的事件，专供 rejection 去重（尾部留 20 条）。
   * ⚠️ 为什么不记 rejection：同一次 burst 里会有 **4 条一模一样的 `-3` rejection**
   *   （`show()` 连刷 5 次、前 4 次被顶掉，定题 §3.4 实测 4 == 5-1）。若 rejection 之间也去重，
   *   这 4 条会被并成 1 条 —— 日志确实更安静，但**读数就假了**（`aborted` 永远是 1，
   *   "4 == 5-1" 这条对账从此做不出来）。所以去重只做**跨来源**那一半：同一次物理失败
   *   会先到 `did-fail-load`、再到 rejection，后者才是重复的那一条。 */
  const seen = [];
  let lastFailure = null;  // 最近一次**判红**的失败（诊断出口）
  let lastAbort = null;    // 最近一次 -3 的收束（absorbed / dropped / red —— "它发生过"必须有出口）

  function remember(rec) { seen.push(rec); while (seen.length > 20) seen.shift(); }

  /** 发起一次导航（`showStatusPage` / `loadCurrentUrl` 的唯一入口都调它）。 */
  function navigate() { counts.navigations++; return counts.navigations; }

  function deferAbort(f) {
    counts.aborted++;
    const at = clock();
    pending.push({ at: at, code: f.code, desc: f.desc, url: f.url });
    lastAbort = { code: f.code, desc: f.desc, url: f.url, at: at, count: 1, outcome: 'pending', settledAt: null };
    return { action: 'deferred' };
  }

  function report(f) {
    counts.reported++;
    lastFailure = { code: f.code, desc: f.desc, url: f.url, at: clock() };
    return { action: 'error', message: failureLine(f) };
  }

  /** 收束挂起中的 -3（`absorbed` = 随后成功 / `dropped` = 视图不在或已报过同一事故）。 */
  function absorb(outcome, why) {
    const n = pending.length;
    if (!n) return { action: 'report', reason: why, absorbed: 0 };
    const tail = pending[n - 1];
    counts[outcome === 'dropped' ? 'dropped' : 'absorbed'] += n;
    lastAbort = { code: tail.code, desc: tail.desc, url: tail.url, at: pending[0].at,
      count: n, outcome: outcome, settledAt: clock() };
    pending.length = 0;
    return { action: 'report', reason: why, absorbed: n };
  }

  /** `did-fail-load` 的判定（**唯一判定入口**）。 */
  function onFailLoad(raw) {
    const f = normalizeLoadFailure(raw);
    remember({ source: 'did-fail-load', code: f.code, url: f.url, at: clock() });
    if (!f.isMainFrame) { counts.subframeIgnored++; return { action: 'ignored' }; }
    if (f.code === ERR_ABORTED) return deferAbort(f);
    return report(f);
  }

  /** `loadURL()` 的 rejection —— **兜底**：真失败正常路径上 `did-fail-load` 已经先一步报过同一次，
   *  这里靠 `码 + URL + 时间窗` 与**那一路**的记录去重（否则每次真失败会刷两条一模一样的行）。
   *  ⚠️ 与**别的 rejection** 之间**不去重**（理由见 `seen` 的注释：那会把 4 条真 `-3` 并成 1 条）。 */
  function onLoadRejected(raw) {
    const f = normalizeLoadFailure(raw);
    const t = clock();
    const dup = seen.some((s) => s.code === f.code && t - s.at <= dedupeMs
      && (!s.url || !f.url || s.url === f.url));
    if (dup) { counts.deduped++; return { action: 'deduped' }; }
    if (!f.isMainFrame) { counts.subframeIgnored++; return { action: 'ignored' }; }
    if (f.code === ERR_ABORTED) return deferAbort(f);
    return report(f);
  }

  /** 同一 webContents 加载成功 ⇒ 挂起中的 -3 全部被吸收。**这就是"良性"的机械定义**：
   *  不是"我们相信它是良性的"，而是"它后面确实跟着一次成功"。 */
  function onFinishLoad() {
    counts.finished++;
    if (!pending.length) return { absorbed: 0 };
    return absorb('absorbed', '随后加载成功 ⇒ 被顶掉的那次无关紧要');
  }

  /** 视图销毁（用户真关）⇒ 挂起的 -3 只报告。 */
  function onViewDestroyed() {
    if (!pending.length) return { absorbed: 0 };
    return absorb('dropped', '视图已销毁（用户真关，不是加载失败）');
  }

  /** 结算挂起中的 -3（到点由定时器调；探针/单测也显式调它，走**同一份**判定）。 */
  function settle(input) {
    const i = input || {};
    if (!pending.length) return { action: 'none' };
    if (i.hasView === false) return absorb('dropped', '视图已销毁（用户真关，不是加载失败）');
    if (i.visible === false) return absorb('dropped', '侧栏不可见（不算加载失败）');
    const waited = typeof i.waitedMs === 'number' ? i.waitedMs : (clock() - pending[0].at);
    const limit = typeof i.maxWaitMs === 'number' ? i.maxWaitMs : maxWaitMs;
    // 那次导航**还在加载** ⇒ 判决还没下来（3s 到点 ≠ 失败）；但给了 maxWait 这一档才敢判死
    if (i.stillLoading && waited < limit) return { action: 'pending', waitedMs: waited };
    // 顶上去的那一次**自己已经按非 -3 的码报过**了 ⇒ 同一次事故只留一条响亮的话，不重复刷
    if (lastFailure && lastFailure.at >= pending[0].at) {
      return absorb('dropped', '同一次失败已按非 -3 的码报过');
    }
    const n = pending.length;
    const tail = pending[n - 1];
    const f = { code: tail.code, desc: tail.desc, url: tail.url };
    counts.reported++;
    lastFailure = { code: f.code, desc: f.desc, url: f.url, at: clock() };
    lastAbort = { code: tail.code, desc: tail.desc, url: tail.url, at: pending[0].at,
      count: n, outcome: 'red', settledAt: clock() };
    pending.length = 0;
    return { action: 'error', count: n, message: failureLine(f,
      '被顶掉后再没有一次成功的加载（' + n + ' 次，已等 ' + Math.round(waited) + 'ms），侧栏仍可见'
      + ' —— 可能停在空白/错误页') };
  }

  /** 诊断读数（进 `getStatus()`；日志里不再有良性的 -3，但"它发生过"必须有出口）。 */
  function snapshot() {
    const c = counts;
    return {
      navigations: c.navigations, finished: c.finished, aborted: c.aborted,
      reported: c.reported, absorbed: c.absorbed, dropped: c.dropped,
      subframeIgnored: c.subframeIgnored, deduped: c.deduped,
      pending: pending.length, pendingSince: pending.length ? pending[0].at : null,
      lastFailure: lastFailure, lastAbort: lastAbort,
      settleMs: STATUS_PAGE_ABORT_SETTLE_MS, maxWaitMs: maxWaitMs
    };
  }

  return { navigate: navigate, onFailLoad: onFailLoad, onLoadRejected: onLoadRejected,
    onFinishLoad: onFinishLoad, onViewDestroyed: onViewDestroyed, settle: settle, snapshot: snapshot };
}

/** 进程内唯一的判定器（视图重建**不重置**计数：跨视图的"出现过几次 / 吸收过几次 / 报过几次"
 *  才是诊断读数）。懒建 ⇒ `require()` 本文件没有额外副作用（单测与探针都能直接要实例）。 */
function statusPageLoadTracker() {
  if (!state.statusPageLoad) state.statusPageLoad = createStatusPageLoadTracker();
  return state.statusPageLoad;
}

/** 把「加载失败判定」挂到一个 webContents 上 —— **唯一挂载处**（`ensureView()` 调它）。
 *  导出是给 headless Electron 探针用的：纯状态机的单测证明不了"真事件真的带 isMainFrame / errorCode"，
 *  只有真 webContents 能证明（`.review/20261024-r12-收口/probe-status-load.js`）。
 *  @param {object} webContents 真 webContents，或任何有 `.on` 的对象（单测用 EventEmitter 打它） */
function attachLoadDiagnostics(webContents, opts) {
  const o = opts || {};
  const tracker = o.tracker || statusPageLoadTracker();
  const emit = o.log || log;
  const onDeferred = o.onDeferred || function () { scheduleStatusPageSettle(); };
  webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const r = tracker.onFailLoad({ errorCode: errorCode, errorDescription: errorDescription,
      validatedURL: validatedURL, isMainFrame: isMainFrame });
    if (r.action === 'error') emit(r.message);
    else if (r.action === 'deferred') onDeferred();
  });
  webContents.on('did-finish-load', () => { tracker.onFinishLoad(); });
  return tracker;
}

/** 结算定时器（**一个就够**：每次挂起就重置它 ⇒ 从最后一次尝试算 settleMs）。 */
function scheduleStatusPageSettle(ms) {
  if (state.statusPageSettleTimer) {
    clearTimeout(state.statusPageSettleTimer);
    state.statusPageSettleTimer = null;
  }
  const wait = typeof ms === 'number' ? ms : STATUS_PAGE_ABORT_SETTLE_MS;
  const t = setTimeout(() => {
    state.statusPageSettleTimer = null;
    const r = settleStatusPageLoad();
    // 那次导航还在加载 ⇒ 再等一轮（上限由 tracker 的 maxWaitMs 兜住，不会无限等）
    if (r && r.action === 'pending') scheduleStatusPageSettle();
  }, wait);
  if (t && typeof t.unref === 'function') t.unref();   // 别为一个诊断定时器拖住进程退出
  state.statusPageSettleTimer = t;
}

/** 结算挂起中的 -3 —— **唯一结算处、也是唯一打印处**（导出给探针/单测显式驱动，走同一份判定）。
 *  入参全是**现取的事实**（可见不可见 / 视图在不在 / 那次导航还在不在加载），不是猜的。 */
function settleStatusPageLoad(deps) {
  const d = deps || {};
  const tracker = d.tracker || statusPageLoadTracker();
  const snap = tracker.snapshot();
  const nowMs = typeof d.now === 'function' ? d.now() : Date.now();
  // 事实来源的优先级：调用方显式给 > 测试接缝（探针没有产品那个 view）> 产品真实 state
  const facts = (typeof state.statusPageSettleFactsForTest === 'function')
    ? (state.statusPageSettleFactsForTest() || {}) : null;
  let stillLoading = false;
  if (d.stillLoading !== undefined) stillLoading = !!d.stillLoading;
  else if (facts && facts.stillLoading !== undefined) stillLoading = !!facts.stillLoading;
  else if (state.view && state.view.webContents) {
    try { stillLoading = !!state.view.webContents.isLoading(); } catch (e) { stillLoading = false; }
  }
  const visible = d.visible === undefined
    ? (facts && facts.visible !== undefined ? !!facts.visible : !!state.visible)
    : !!d.visible;
  const hasView = d.hasView === undefined
    ? (facts && facts.hasView !== undefined ? !!facts.hasView : !!state.view)
    : !!d.hasView;
  const r = tracker.settle({
    visible: visible,
    hasView: hasView,
    stillLoading: stillLoading,
    // 等过多久：默认按**真墙钟**算（产品路径就是这样）；探针/单测可以显式喂，免得真睡 15s
    waitedMs: typeof d.waitedMs === 'number' ? d.waitedMs
      : (snap.pendingSince ? nowMs - snap.pendingSince : 0)
  });
  if (r.action === 'error') (d.log || log)(r.message);
  return r;
}

/* ---------------- 加载失败判定的**测试接缝**（与 `__setMeasureProbeForTest` 同一档） ----------------
 * 为什么必须留这两根线：结算要判的三件事（可见 / 视图在不在 / 那次导航还在不在加载）都取自
 * **产品真实视图**；而 headless Electron 探针不孵化主界面 ⇒ 没有那个视图。不接线的话，
 * 定题 §3.5 表里「-3 之后一直没有成功且仍可见 ⇒ 该红」这一条**在探针里永远判不出来**
 * —— 那正是"判据在空转"（本工程明令禁止）。产品路径**绝不**设置它们（名字带 `__`，默认 null/false）。 */

/** 让结算读到的"视图事实"可注入：`() => ({visible, hasView, stillLoading})`；传 null 恢复真实 state */
function setStatusPageSettleFactsForTest(fn) {
  state.statusPageSettleFactsForTest = typeof fn === 'function' ? fn : null;
  return true;
}

/** 把判定器与结算定时器重置（单测要一个干净实例；产品路径不用） */
function resetStatusPageLoadTrackerForTest() {
  if (state.statusPageSettleTimer) {
    clearTimeout(state.statusPageSettleTimer);
    state.statusPageSettleTimer = null;
  }
  state.statusPageLoad = null;
  return true;
}

/** `loadURL()` 的**唯一调用包装**：导航计数 + 失败交给判定器（不再各写一句 `.catch(log)`）。
 *  返回的 promise **不 reject**（调用方都是 fire-and-forget；失败已在判定器里记过账）。 */
function loadUrlTracked(webContents, url) {
  const tracker = statusPageLoadTracker();
  tracker.navigate();
  let p;
  try { p = webContents.loadURL(url); } catch (e) { p = Promise.reject(e); }  // 同步抛也算失败，照样报
  return Promise.resolve(p).catch((e) => {
    const r = tracker.onLoadRejected(e);
    if (r.action === 'error') log(r.message);
    else if (r.action === 'deferred') scheduleStatusPageSettle();
    return null;
  });
}

function showStatusPage(html) {
  if (!state.view) return;
  loadUrlTracked(state.view.webContents, html);
}

/* ---------------- WebContentsView ---------------- */

function ensureView() {
  if (state.view) return state.view;
  const { WebContentsView } = require('electron');
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: require('electron').session.fromPartition('persist:dsh-sidebar')
    }
  });
  // 外链交给系统浏览器（DSH 页面内的 github 链接等）
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  // 错误页的"重试"按钮经 console 消息回传（无 preload 的安全反馈通道）
  view.webContents.on('console-message', (_e, _level, message) => {
    if (message === '[dsh-retry]') {
      log('错误页重试请求');
      startService();
      showStatusPage(PAGE_STARTING);
    } else if (message === '[dsh-rightbar-request]') {
      // 用户点了「打开侧边栏」：若右栏**此时是开着的**，这一下就是"关" ⇒ 还原；否则加宽 ✓
      if (state.rightbarOpen) releaseRightbarRoom();
      else ensureRightbarRoom();
    } else if (message === '[dsh-rightbar-open]') {
      state.rightbarOpen = true;
      ensureRightbarRoom();                     // 事实信号：确保空间够（幂等）
    } else if (message === '[dsh-rightbar-closed]') {
      state.rightbarOpen = false;
      releaseRightbarRoom();
    }
  });
  /* 加载失败的判定**只挂这一处**（r12 收口批）：`did-fail-load` 才带 `isMainFrame` + `errorCode`，
   * 按码分流（`-3` 挂起结算、其余立刻点名）见 createStatusPageLoadTracker 那一节。
   * 旧写法挂在 `loadURL().catch()` 上 ⇒ 良性的 `-3` 与真失败**长得一模一样**，只能靠人记得。 */
  attachLoadDiagnostics(view.webContents);
  // DSH 页面每次加载完成后重新注入窄宽适配（insertCSS 不跨导航保留）
  view.webContents.on('did-finish-load', () => {
    if (state.visible) scheduleNarrowAdaptation();
  });
  state.view = view;
  state.viewEpoch++;   // 每次**新建**都计数：重开侧栏后 `viewEpoch` 必须增 1（断言"是新视图"而不是"旧的又挂回来"）
  state.lastDestroyedViewId = null;
  log('DSH 页面视图已创建（第 ' + state.viewEpoch + ' 次，webContents id=' + viewIdOf(view) + '）');
  return view;
}

/** view 的 webContents id（取不到就 null）—— 诊断与断言都用它认对象 */
function viewIdOf(v) {
  try { return v && v.webContents ? v.webContents.id : null; } catch (e) { return null; }
}

/** **真正销毁**侧栏那个 WebContentsView（用户语义："关了就真的不在了，别只是摘下来"）。
 *
 *  旧实现（v0.16 系列）只 `removeChildView` —— 视图被摘下来挂在内存里，DSH 页面的渲染层进程
 *  连同整个 JS 堆都还活着（用户要的是"内存里真的不留页面"✗）。现在：摘下来 + 销毁 webContents
 *  ⇒ 页面、它的 DOM/JS 堆一起消失（实测 exit：`webContents.fromId(旧 id)` 变成 undefined ✓）。
 *  代价（**如实说明**）：重开要重新加载整页 —— 比"把旧的挂回去"慢，这是"真关"的应有之义。
 *  判据字段：`getStatus().hasView === false` / `viewId === null` / `lastDestroyedViewId === 旧 id` ✓ */
function destroyView(reason) {
  const v = state.view;
  if (!v) return false;
  if (state.win && !state.win.isDestroyed() && state.win.contentView) {
    try { state.win.contentView.removeChildView(v); } catch (e) { /* 本来就不在树上 */ }
  }
  const id = viewIdOf(v);
  try {
    if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
  } catch (e) {
    log('销毁 view 失败（不静默吞掉原因）: ' + ((e && e.message) || e));
  }
  state.view = null;
  state.lastDestroyedViewId = id;
  state.narrow = null;
  state.narrowSkip = '视图已销毁（重开侧栏会重建并重新加载页面）';
  if (state.rightbarWatcher) state.rightbarWatcher = null;
  // 挂起中的 `-3` 随视图一起失效（定题 §3.5：视图真关 ⇒ 只报告，不判红）；
  // 结算定时器也一并撤掉，免得它对着一个已经不存在的视图结算。
  if (state.statusPageLoad) state.statusPageLoad.onViewDestroyed();
  if (state.statusPageSettleTimer) {
    clearTimeout(state.statusPageSettleTimer);
    state.statusPageSettleTimer = null;
  }
  log('DSH 页面视图已销毁（' + reason + '，webContents id=' + id
    + '）—— 内存里不再留这个页面；重开=重新加载（比"挂回来"慢 ✓）');
  return true;
}

function loadCurrentUrl() {
  if (!state.view || !state.url) return;
  // ⚠️ 只在"当前页不是这个 URL"时才载入。原先无条件 loadURL ⇒ 每次**重开侧栏**都整页重载：
  // 插件重新初始化、settings/皮肤等配置被重读 —— 用户观察到的"减号像是带刷新机制"就是这个 ✗
  //（hide() 本身不碰服务、不重载；刷新发生在 reopen 那一侧的 show()）。
  let cur = '';
  try { cur = state.view.webContents.getURL(); } catch (e) { cur = ''; }
  if (cur === state.url) return;
  // 失败走**同一套**判定（r12 收口批）：真实 DSH 页面加载失败同样要响亮，良性的 `-3` 同样不吵。
  loadUrlTracked(state.view.webContents, state.url);
}

/* ---------------- 拖宽分隔条（类似 Windows 窗口边框的拖拽体验） ----------------
 * 分隔条是主进程拥有的独立 WebContentsView（6px 热区，hover 高亮），盖在侧栏左缘。
 * 拖拽协议（全部在分隔条页面内闭环，主进程只做几何）：
 *   · 页面 mousedown → console '[dsh-drag-start]' → 主进程 beginWidthDrag()
 *   · 拖动中主进程 16ms 轮询光标，**新宽度 = 窗口右缘(screenX) - 光标(screenX)**
 *     （绝对定位：向左拖=加宽、向右拖=变窄，天然跟随鼠标方向，无符号/漂移问题）
 *   · 分隔条每帧跟随光标 → 光标始终在分隔条上 → 页面 mouseup 必然触发
 *     → '[dsh-drag-end]' → 主进程 endWidthDrag()（"松手即停"）
 *   · 兜底：页面 mousemove 检测 e.buttons===0（丢 mouseup 的场景）也结束；
 *     主渲染层 mouseup / Escape 同样结束（拖拽起点在渲染层边缘热区时） */
/* RAIL_WIDTH 的声明在文件顶部常量区（「控制栏宽」那条）—— 顶层 const 有 TDZ，
 * `RIGHTBAR_MIN_BAND` 在常量区就要用它做带宽→视口的换算。这里只剩拖动计时器。 */
let dragTimer = null;

/* ---------------- 左侧原生控制栏（把三个浮层并成一条） ----------------
 * 由来（用户实测 + 设计分析）：原先 −/✕ 是**浮在 DSH 页面上方**的两个小热区，
 * 而页面右上角正是 DSH 自己的头部与插件入口所在 ⇒ 必然互相遮挡（− 压住头部 UI，
 * 以后装新 UI 插件还会再撞）✗。"把按钮往下挪"只是把冲突挪开，不能消除。
 * 现在：拖宽热区与两个按钮合并为侧栏左缘一条 RAIL_WIDTH 宽的原生控制栏，
 * DSH 页面从它右边开始排 ⇒ 与页面**零重叠** ✓。
 * 代价：内容可视宽度少 RAIL_WIDTH（MIN_WIDTH 已相应上调）。 */
function railPageHtml() {
  // 按钮含义随模式变（仅侧栏模式下「−」= 恢复思维导图页 —— 那是唯一的回去的路）
  const only = !!state.dshOnly;
  const glyph = only ? '⤢' : '—';
  const title = only ? '恢复思维导图页（关掉侧栏）' : '折叠侧边栏（Ctrl+B 可再展开）';
  const msg = only ? '[dsh-restore]' : '[dsh-collapse]';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;height:100%;background:rgba(245,246,248,.92);overflow:hidden;'
    + 'user-select:none;-webkit-app-region:no-drag;cursor:col-resize}'
    + '#rail{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center}'
    + '#bar{position:absolute;top:0;bottom:0;right:0;width:2px;background:#e4e7ec}'
    + 'html:hover #bar,html.dragging #bar{background:#1664ff}'
    + 'button{width:24px;height:22px;margin-top:8px;border:none;border-radius:6px;'
    + 'background:transparent;cursor:pointer;font-size:13px;line-height:1;color:#4e5969}'
    + 'button:hover{background:#e8eefc;color:#1664ff}'
    + '#close:hover{background:#fdecec;color:#d93026}'
    + '</style></head><body><div id="bar"></div><div id="rail">'
    + '<button id="collapse" title="' + title + '">' + glyph + '</button>'
    + '<button id="close" title="关闭 DSH 侧栏（连服务一起停，思维导图继续用）">✕</button>'
    + '</div><script>'
    + 'var dragging=false;'
    // 按钮上的 mousedown 不能触发拖宽
    + 'function stop(e){e.stopPropagation();}'
    + 'document.getElementById("collapse").addEventListener("mousedown",stop);'
    + 'document.getElementById("close").addEventListener("mousedown",stop);'
    + 'document.getElementById("collapse").addEventListener("click",function(){console.log("' + msg + '");});'
    + 'document.getElementById("close").addEventListener("click",function(){console.log("[dsh-close-sidebar]");});'
    + 'document.addEventListener("mousedown",function(e){'
    + '  if(e.button!==0)return;dragging=true;document.documentElement.classList.add("dragging");'
    + '  e.preventDefault();console.log("[dsh-drag-start]");});'
    + 'function end(){if(!dragging)return;dragging=false;'
    + '  document.documentElement.classList.remove("dragging");console.log("[dsh-drag-end]");}'
    + 'document.addEventListener("mouseup",end);'
    + 'document.addEventListener("mouseleave",function(){if(dragging&&event.buttons===0)end();});'
    + 'document.addEventListener("mousemove",function(e){if(dragging&&e.buttons===0)end();});'
    + 'document.addEventListener("keydown",function(e){if(e.key==="Escape")end();});'
    + 'document.addEventListener("contextmenu",function(e){e.preventDefault();end();});'
    + '</script></body></html>');
}

/** 模式切换后刷新控制栏（─ 的字形/语义随模式变） */
function refreshRail() {
  if (!state.rail || !state.rail.webContents) return;
  try { state.rail.webContents.loadURL(railPageHtml()).catch(() => {}); } catch (e) { /* ignore */ }
}

function ensureRail() {
  if (state.rail) return state.rail;
  const { WebContentsView } = require('electron');
  const rail = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  rail.setBackgroundColor('#00000000');
  rail.webContents.loadURL(railPageHtml()).catch(() => { /* ignore */ });
  rail.webContents.on('console-message', (_e, _level, message) => {
    if (message === '[dsh-drag-start]') beginWidthDrag();
    else if (message === '[dsh-drag-end]') endWidthDrag();
    else if (message === '[dsh-collapse]') {
      if (state.dshOnly) {
        // 仅侧栏模式（主界面迭代中）：「—」= 最小化到任务栏（服务驻留不动）
        if (state.win && !state.win.isDestroyed()) state.win.minimize();
        return;
      }
      log('折叠按钮点击 → 隐藏侧栏');
      hide();
    } else if (message === '[dsh-restore]') {
      // ⚠️ 原先这个分支**不存在** ⇒ 仅侧栏模式下的「⤢ 恢复导图页」是和 ✕ 一样的死键 ✗
      // 现在语义变了：导图页是被**卸载**的（不是藏起来）⇒「⤢」= 重新加载这一页 ✓
      openMapPage().catch((e) => log('恢复导图页失败: ' + ((e && e.message) || e)));
    } else if (message === '[dsh-close-sidebar]') {
      // 先让导图页回来，否则关完窗口是空的 ✗
      if (state.dshOnly) openMapPage().catch((e) => log('恢复导图页失败: ' + ((e && e.message) || e)));
      closeSidebar();
    }
  });
  state.rail = rail;
  return rail;
}

/** 开始拖宽：新宽度用光标屏幕坐标对窗口右缘的**绝对距离**计算。
 *  ⚠️ 仅侧栏模式（导图页已卸载）下**禁用**：那时侧栏铺满整窗，拖出来的"宽度"既看不出效果、
 *  又会把 `state.width`（= 重开时要还原的**停靠宽度**）改坏 ⇒ 重开后宽度回不到原样 ✗。
 *  这是"重开还原停靠宽度"这条承诺能成立的前提，所以宁可在这里明确不响应（并记日志 ✓ 不静默）。 */
function beginWidthDrag() {
  if (dragTimer || !state.win) return;
  if (state.dshOnly) {
    log('仅侧栏模式（导图页已卸载）：忽略拖宽（拖宽只调"停靠宽度"，会破坏重开时的还原值）');
    return;
  }
  // **用户手动改宽度** = 自动档从此让位（右栏让位与内容预算都不再自动改宽/还原）。
  // 写入点只有这一处（`endWidthDrag` 也走同一次拖拽，不必写两遍）。
  // ⚠️ 放在**两个早退之后**（实测踩到）：原先写在最前面 ⇒ 仅侧栏模式下"根本没开始拖"也会把
  // 自动档永久关掉（那条早退是 return，不是拖拽）。同一个坑在门禁里表现为跨域污染：
  // 模拟一次拖宽之后，后面的「右栏自动加宽」整条红（加宽=false/694）—— 两个域各自都是对的 ✗。
  state.userTookOver = true;
  if (state.contentBudget) state.contentBudget.tier = 'user-takeover-pending';
  const { screen } = require('electron');
  log('开始拖宽（起始 ' + state.width + 'px）');
  dragTimer = setInterval(() => {
    if (!state.win || state.win.isDestroyed()) { endWidthDrag(); return; }
    const cursor = screen.getCursorScreenPoint();
    const bounds = state.win.getContentBounds(); // {x,y,width,height} 屏幕坐标（DIP）
    const right = bounds.x + bounds.width;
    setWidth(clampWidth(right - cursor.x)); // 向左拖=加宽，向右拖=变窄，绝对跟随
  }, 16);
}

function endWidthDrag() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  savePrefs();
  log('拖宽结束（当前 ' + state.width + 'px）');
}

function clampWidth(w) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
}

/* 拖动虚影（甲 = 同窗口 WebContentsView，2026-10-33 批3）的实现**不在本文件**：
 *  它在 `main.js` 的「拖动虚影」整节。理由只有一条、且是硬的：本文件有一条结构判据
 *  （`tests/panel-geometry.test.js`）——`setBounds(` 只许出现在 `relayout()` 的函数体里
 *  （"侧栏/面板的几何只有一个出口"）；虚影那块 view 的 bounds 不属于这条几何，但判据分不出
 *  谁是谁 ⇒ 代码放它该在的地方（虚影属于拖拽，不属于侧栏几何）。
 *   本文件只对"侧栏被收起/被销毁"这件事发一条通知（`onHide`），由 main.js 去把虚影收掉。 */

/** 侧栏被收起/销毁时的**外部钩子**（虚影要跟着收起；main.js 注册一处）。
 *  为什么是钩子而不是在这里直接调虚影函数：本文件只知道"我自己被收起了"，
 *  "有没有活动拖拽 / 虚影在哪"只有 main.js 的 selDrag 段知道 ⇒ 一个方向的事件通知，
 *  不构成第二份判断（同一件事仍然只有一个地方表达）。 */
const hideHooks = [];
function onHide(fn) { if (typeof fn === 'function') hideHooks.push(fn); }
function fireHide(why) {
  hideHooks.forEach((f) => { try { f(why); } catch (e) { /* 钩子自己炸不许影响收起 */ } });
}

/* ---------------- 第 4 个原生面板（停靠面板 · 2026-10-18 底座批） ----------------
 * 形态：右侧**二阶并列** —— [页面][面板][控制栏][DSH 侧栏]。
 *   · 几何算术的**唯一计算处** = src/panel-geometry.js（纯函数，零 Electron ⇒ 有 node 单测）；
 *   · 三个候选形态（并列 / 互斥 / 下缘）的取舍读数见那个模块的文件头与本批证据 README；
 *   · 本批**只造底座**：能开能关、几何正确、判据齐备的空面板 + 一个占位页，**不含任何业务内容**
 *     （浏览器 / 改动清单属第 2 批 a76bab32）。
 *
 * 三条分工（改代码前先读这三行，别混）：
 *   ① 几何：relayout() 只调 computeGeometry() 再 setBounds —— **本文件没有第二段几何算术**；
 *   ② 开/关：openDockPanel()/closeDockPanel() 只改**意图**（state.dock），然后走**同一条**
 *      setGeometry() → relayout()（A1：唯一改几何出口，不新造第二套设置函数）；
 *   ③ 让位：页面预留仍只有**一条** CSS 变量（--dsh-sidebar-width = 控制栏 + 侧栏 + 面板 之和），
 *      发射点仍只有 notifyRenderer() 一处 ⇒ 渲染层不为这块新面板多学一个字。
 *
 * 安全面（Electron 清单 §13/§14/§15 —— **照抄既有侧栏 view 的取值，不自己发明**）：
 *   contextIsolation:true / nodeIntegration:false / sandbox:true（与 ensureView 逐字相同），
 *   外加**独立 session partition**（与 DSH 页面零共享 cookie/localStorage/缓存）与外链交系统浏览器。
 * ⚠️ 判据**不许**用 capturePage()：主页面截图里没有原生视图（本工程两次事故：
 *   `scripts/vision/window-shot.js:4`（原文：「侧栏是原生 `WebContentsView`，`capturePage()` 只截**页面** ⇒ 截图里永远没有侧栏」；⚠️ 原先此处指 `CHANGELOG.md` 的行号，2026-10-20 实测那些行号已指向无关内容，**行号型证据指针会漂，别再写**））⇒ 本面板的判据一律
 *   getBounds() 对拍页面让位读数（`scripts/smoke/22-sidebar-gap.js` 的第 2 条断言）。
 *   ⚠️ 订正（2026-10-18，第 2 批）：这里原先指向 `scripts/smoke/54-dock-panel-geometry.js`，
 *      而那个文件**在底座批收口时就没有了**（那条判据并进了域 22，理由见域 22 的注释）——
 *      留着一个不存在的路径就是死指针（RULES F1）。
 */

/** 面板页（第 2 批 a76bab32：第一份业务内容 =「AI 改了哪些文件」清单）。
 *  ⚠️ 页面本体**不在本文件**：唯一实现是 `src/dock-panel-page.js`。搬出去的唯一理由是
 *    那段页面 JS **只有真起视图才会被解析**（写完不跑冒烟 ⇒ 一句语法错的表现只是"面板一片空白"，
 *    没有任何判据会红）；搬进 src/ 之后 node 单测能直接 `new Function(scriptOf())` 解析它
 *    （`tests/dock-panel-page.test.js`）。本文件只负责"把它包成 data: URL 交给视图"，
 *    一行业务文本都没有 —— 面板底座与业务内容彻底分开。 */
function dockPanelPageHtml() { return dockPanelPage.dataUrl(); }

/* ---------------- 面板页 ⇄ 主进程的消息桥（第 2 批 a76bab32） ----------------
 * 面板**没有宿主 preload**（与侧栏 view 同一条安全口径：contextIsolation + sandbox + 零 preload），
 * 所以页面唯一能说话的地方就是 `console.log` —— 这不是本批发明的，错误页的「重试」按钮与
 * 占位页的 ✕ 用的都是这条通道（见本文件里另外两个 `console-message` 订阅）。
 *
 * 三条分工（改这里之前先读）：
 *   ① **本文件不认识"改动清单"这回事** —— 它只把「页面发来了一条请求」交给注册进来的处理函数。
 *      业务在 `main.js`（谁来回、回什么由业务方决定）⇒ 面板底座与业务内容解耦。
 *   ② 页面标记的唯一真源是 `src/dock-panel-page.js` 的 `MARKERS`（页面自己按它们发）；
 *      这里只按它们分派 —— 两边各写一份字符串就会在某次改名后**静默失联**（页面在请求、没人接）。
 *   ③ 推数据只走 `pushDockPanelScript()`：`did-finish-load` 之前 executeJavaScript 会抛，
 *      而"页面还没好"不是错误 —— 它有 `[mm-changelog:req]` 会再来一次（页面加载完自己请求）。 */

/** 注册/清空面板页的消息处理（`main.js` 在 init 之后调一次；测试也可传 null 清掉） */
function setDockPanelBridge(handlers) {
  state.dock.bridge = handlers || null;
  return true;
}

/** 往面板页里执行一段脚本（**唯一**的主→页面通道；失败不静默，记进 lastPush）。
 *
 * ⚠️ **页面还没加载完时不许丢数据**（本批实测踩到）：页面的请求是在 `DOMContentLoaded` 发的，
 * 那个时刻 `did-finish-load` 还没来 ⇒ 第一次推送必然撞上"页面未就绪"。
 * 第一版把这次推送记成 err 就扔了，结果是**面板第一次打开永远停在"读取中…"**
 * （直到用户手动点刷新或拖一下窗口）。现在改成**排队 + pageReady 立刻补发**：
 * 数据晚到几百毫秒是可以接受的，丢了它不行。 */
function pushDockPanelScript(code, label) {
  const v = state.panelView;
  const rec = { label: label || 'push', at: Date.now(), bytes: String(code || '').length, ok: false, err: null, queued: false };
  if (!v || !v.webContents || v.webContents.isDestroyed()) {
    rec.err = '面板视图不在（可能还没建或已销毁）';
    state.dock.lastPush = rec;
    return rec;
  }
  if (!state.dock.pageReady) {
    state.dock.pendingPush = { code: String(code || ''), label: rec.label, at: rec.at };
    rec.queued = true;
    rec.err = '页面还没加载完 ⇒ 已排队，pageReady 之后立刻补发';
    state.dock.lastPush = rec;
    return rec;
  }
  try {
    const p = v.webContents.executeJavaScript(String(code || ''));
    if (p && typeof p.catch === 'function') {
      p.then(() => { rec.ok = true; }).catch((e) => {
        rec.err = String((e && e.message) || e);
        log('面板页 executeJavaScript 失败（' + rec.label + '）：' + rec.err);
      });
    } else { rec.ok = true; }
  } catch (e) {
    rec.err = String((e && e.message) || e);
    log('面板页 executeJavaScript 抛错（' + rec.label + '）：' + rec.err);
  }
  state.dock.lastPush = rec;
  return rec;
}

/** 惰性创建面板视图（与 ensureView 同形：三个安全开关逐字相同 + 独立 partition）。 */
function ensurePanel() {
  if (state.panelView) return state.panelView;
  const { WebContentsView, session, shell } = require('electron');
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: session.fromPartition('persist:mm-dock-panel')
    }
  });
  view.setBackgroundColor('#ffffff');
  // 外链交系统浏览器（面板将来放浏览器/预览时的同一条规矩，照抄侧栏 view 的处理）
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 页面经 console 回传（面板没有宿主 preload —— 与错误页重试按钮同一条安全通道）
  const M = dockPanelPage.MARKERS;
  view.webContents.on('console-message', (_e, _level, message) => {
    const msg = String(message === undefined || message === null ? '' : message);
    state.dock.lastMessage = { at: Date.now(), message: msg.slice(0, 200) };
    if (msg === M.close) {
      log('停靠面板页面里的 ✕ 被点击 → 关闭面板');
      closeDockPanel({ reason: 'panel-page-close' });
      return;
    }
    if (msg === M.req || msg === M.reqForce) {
      const force = msg === M.reqForce;
      const b = state.dock.bridge;
      if (!b || typeof b.onRequest !== 'function') {
        // 没注册处理函数 ≠ 没事发生：**记下来**（页面在请求、没人接 = 面板会一直停在"读取中"）
        log('面板页请求读数，但主进程没注册处理函数（setDockPanelBridge 没调？）');
        return;
      }
      try {
        const r = b.onRequest({ force: force, at: Date.now() });
        if (r && typeof r.catch === 'function') {
          r.catch((e) => { log('面板页请求处理失败：' + ((e && e.message) || e)); });
        }
      } catch (e) {
        log('面板页请求处理抛错：' + ((e && e.message) || e));
      }
      return;
    }
    if (msg.indexOf(M.rendered) === 0) {
      // 页面自己报"我这一轮画了几行" —— 页面侧真值（判据拿它和主进程读数对拍，不靠猜）
      const n = Number(msg.slice(M.rendered.length).trim());
      state.dock.rendered = isFinite(n) ? n : null;
      return;
    }
  });
  view.webContents.on('did-finish-load', () => {
    state.dock.pageReady = true;
    log('停靠面板页面已加载完（pageReady=true）');
    // 页面在加载完**之前**发的请求不该白跑：把排队的那一次立刻补发（见 pushDockPanelScript 的注释）
    const pending = state.dock.pendingPush;
    state.dock.pendingPush = null;
    if (pending) {
      log('补发页面加载期间排队的推送（' + pending.label + '，' + String(pending.code || '').length + ' 字节）');
      pushDockPanelScript(pending.code, (pending.label || 'push') + ':flush');
    }
  });
  view.webContents.loadURL(dockPanelPageHtml())
    .catch((e) => { state.dock.pageErr = String((e && e.message) || e); log('停靠面板页面加载失败: ' + state.dock.pageErr); });
  state.panelView = view;
  state.dock.pageReady = false;
  state.dock.rendered = null;        // 新视图的"我画了几行"要从零起算（旧页面的计数没有意义）
  state.dock.pendingPush = null;
  state.dock.epoch++;
  state.lastDestroyedPanelId = null;
  log('停靠面板视图已创建（第 ' + state.dock.epoch + ' 次，webContents id=' + viewIdOf(view) + '）');
  return view;
}

/** **真销毁**面板视图（与 destroyView 同形）：关面板默认只摘不销毁（见 closeDockPanel 的取舍），
 *  需要真的回收内存时走这里（应用退出 / 调用方显式要）。 */
function destroyPanel(reason) {
  const v = state.panelView;
  if (!v) return false;
  if (state.win && !state.win.isDestroyed() && state.win.contentView) {
    try { state.win.contentView.removeChildView(v); } catch (e) { /* 本来就不在树上 */ }
  }
  const id = viewIdOf(v);
  try {
    if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
  } catch (e) {
    log('销毁停靠面板视图失败（不静默吞原因）: ' + ((e && e.message) || e));
  }
  state.panelView = null;
  state.lastDestroyedPanelId = id;
  log('停靠面板视图已销毁（' + reason + '，webContents id=' + id + '）');
  return true;
}

/** 面板的宽度夹取（唯一一处）：上下限的真源是 src/panel-geometry.js 的 DEFAULTS。
 *  ⚠️ 这里只夹"用户/调用方能给的档"，**不动**页面地板的夹取（那一条在 computeGeometry 里） */
function clampDockWidth(w) {
  const d = panelGeometry.DEFAULTS;
  return Math.max(d.panelMinWidth, Math.min(d.panelMaxWidth, Math.round(Number(w) || 0)));
}

/** **打开**停靠面板。opts.force 允许"已经开着再开一次"（幂等重放，例如菜单连点）。 */
function openDockPanel(opts) {
  const o = opts || {};
  if (!state.win || state.win.isDestroyed()) return { ok: false, reason: '主窗口不可用' };
  if (state.dock.open && !o.force) return { ok: true, already: true, width: state.dock.width };
  ensurePanel();
  // 先挂后算：relayout() 只在视图存在时才会给它 setBounds
  if (state.win.contentView) {
    try { state.win.contentView.addChildView(state.panelView); } catch (e) { /* 已在树上 */ }
  }
  // prev 里连**开之前那份几何快照**一起记 —— "关回原样"的比对基准是**开之前**，不是"关那一刻"
  //（后者本来就含面板，比出来必然不同 ⇒ 那条读数会永远 false，等于没记。实测踩到过）
  state.dock.prev = {
    open: state.dock.open, width: state.dock.width, at: Date.now(),
    geometry: geometrySnapshot()
  };
  setGeometry({ dockOpen: true, dockWidth: typeof o.width === 'number' ? o.width : state.dock.width });
  savePrefs();
  broadcastStatus();
  log('停靠面板已打开（宽 ' + state.dock.width + 'px；prev=' + JSON.stringify(state.dock.prev) + '）');
  return { ok: true, opened: true, width: state.dock.width, geometry: state.geometry };
}

/** **关闭**停靠面板（默认只摘不销毁：面板是将来业务内容的容器，开关一次不该把它的状态丢掉；
 *  要回收内存走 destroyPanel() / closeDockPanel({destroy:true})）。
 *  ⚠️ 这里**必须重算几何**（setGeometry）：删掉那一步就是"关掉不还原"——面板还在屏上、
 *     页面还让着位。这条正是 `scripts/smoke/22-sidebar-gap.js` 第 2 条断言的注入点（删它 ⇒ 必红）。 */
function closeDockPanel(opts) {
  const o = opts || {};
  if (!state.dock.open) return { ok: true, already: true };
  const before = geometrySnapshot();
  const prev = state.dock.prev;
  setGeometry({ dockOpen: false, dockWidth: (prev && typeof prev.width === 'number') ? prev.width : state.dock.width });
  if (state.panelView && state.win && !state.win.isDestroyed() && state.win.contentView) {
    try { state.win.contentView.removeChildView(state.panelView); } catch (e) { /* ignore */ }
  }
  if (o.destroy) destroyPanel('关闭（destroy 档）');
  const after = geometrySnapshot();
  state.dock.restores++;
  // 读数（**不是判据**）：判据在冒烟域里拿原始读数独立再算一遍，免得"两侧同源"变恒等
  state.dock.lastRestore = {
    reason: o.reason || null, at: Date.now(),
    // opened = 开之前那份快照（落在 prev.geometry）；before = 关那一刻；after = 关之后。
    // same = (opened == after)：这才是"关回原样"这句话的可复核形式。
    opened: (prev && prev.geometry) || null, before: before, after: after,
    same: sameGeometryReading((prev && prev.geometry) || null, after)
  };
  savePrefs();
  broadcastStatus();
  log('停靠面板已关闭（' + (o.reason || '未注明') + '；让位宽 ' + before.reserve + ' → ' + after.reserve
    + '，逐项复原=' + state.dock.lastRestore.same + '）');
  return { ok: true, closed: true, restore: state.dock.lastRestore };
}

function toggleDockPanel() {
  return state.dock.open ? closeDockPanel({ reason: 'toggle' }) : openDockPanel({ reason: 'toggle' });
}

function setDockWidth(w) {
  setGeometry({ dockWidth: w });
  if (state.dock.open) savePrefs();
  return { ok: true, width: state.dock.width };
}

function isDockOpen() { return !!state.dock.open; }

/** 面板**实际** bounds（读原生视图；关闭期间是 0×0 —— "不在屏上"就说 0，不留旧值） */
function panelBounds() {
  try {
    const r = state.panelView ? state.panelView.getBounds() : null;
    return (r && r.width > 0) ? r : null;
  } catch (e) { return null; }
}

/** 面板占位页地址（面板里真的加载了东西的取证点；不含 token/凭据） */
function panelPageUrl() {
  try { return state.panelView && state.panelView.webContents ? state.panelView.webContents.getURL() : null; }
  catch (e) { return null; }
}

/** **一次几何快照**（关/开前后逐项对比用的读数）。
 *  矩形只在宽度 > 0 时报 —— 否则"关着"与"开着但被夹成 0"会混成一个样子。 */
function geometrySnapshot() {
  const r = (v) => {
    try {
      const b = v ? v.getBounds() : null;
      return (b && b.width > 0 && b.height > 0)
        ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
    } catch (e) { return null; }
  };
  let win = null;
  try {
    const s = (state.win && !state.win.isDestroyed()) ? state.win.getContentSize() : null;
    if (s) win = { width: s[0], height: s[1] };
  } catch (e) { win = null; }
  return {
    win: win,
    rail: r(state.rail),
    view: r(state.view),
    panel: r(state.panelView),
    reserve: occupiedWidth(),
    sidebarWidth: sidebarBandWidth(),
    dockOpen: !!state.dock.open,
    dockWidth: state.dock.width,
    applied: state.geometry ? {
      occupiedWidth: state.geometry.occupiedWidth,
      pageWidth: state.geometry.pageWidth,
      panel: state.geometry.panel,
      clamped: state.geometry.clamped
    } : null
  };
}

/** 两份快照是否逐项相同（**读数**，给 lastRestore 记一笔；判据由冒烟域独立再算） */
function sameGeometryReading(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  return eq(a.win, b.win) && eq(a.rail, b.rail) && eq(a.view, b.view)
    && eq(a.panel, b.panel) && a.reserve === b.reserve && a.dockOpen === b.dockOpen;
}

/* ---------------- 几何（**唯一应用处**） ---------------- */

/** 把当前**意图**算成几何并应用到三个原生视图上 —— **唯一改几何处**。
 *  既有语义一字不改（侧栏带 = min(侧栏宽, 窗宽) / 极窄时先保内容 / dsh-only 铺满整窗），
 *  只是这三条现在由 src/panel-geometry.js 的纯函数表达（可单测），这里只负责 setBounds。
 *  ⚠️ 早退条件从 `!state.view` 放宽成 `!state.win`：**停靠面板不依赖侧栏视图存在** ——
 *     侧栏没开（或已收起）时面板照样要能停在窗口右缘，否则"面板独立"这条就只是句话。 */
const GEOM_ZERO = { x: 0, y: 0, width: 0, height: 0 };
function relayout() {
  if (!state.win || state.win.isDestroyed()) return;
  const [w, h] = state.win.getContentSize();
  state.width = clampWidth(state.width);
  const g = panelGeometry.computeGeometry({
    winWidth: w,
    winHeight: h,
    sidebarVisible: state.visible,
    sidebarWidth: state.width,
    railWidth: RAIL_WIDTH,
    dshOnly: state.dshOnly,
    panelOpen: state.dock.open,
    panelWidth: state.dock.width
  });
  state.geometry = g;
  // 三个矩形都来自同一份几何（顺序即"面板 → 控制栏 → 侧栏内容"，它们互不重叠）
  if (state.rail) state.rail.setBounds(g.rail || GEOM_ZERO);
  if (state.view) state.view.setBounds(g.view || GEOM_ZERO);
  if (state.panelView) state.panelView.setBounds(g.panel || GEOM_ZERO);
  // ③ 窄宽适配：宽度变了重算一次（**不清状态、不打断进行中的重试** —— 原先每次 relayout
  //    都 reset，一旦有 resize 风暴就会被无限重置，表现为"永远没注入" ✗ 实测踩过）。
  state.narrowDiag = state.narrowDiag || { relayout: 0, scheduled: 0 };
  state.narrowDiag.relayout++;
  if (state.view) scheduleNarrowAdaptation(false);
  notifyRenderer();
}

/** **唯一改几何的入口**：意图 → 几何。
 *  A1 纪律：不许在别处再写一段"设宽度 + relayout"（那就是第二套几何设置函数）；
 *  setWidth/setDockWidth/openDockPanel/closeDockPanel 全部只是它的薄壳。
 *  @param {{width?:number, dockWidth?:number, dockOpen?:boolean}} patch */
function setGeometry(patch) {
  const p = patch || {};
  if (typeof p.width === 'number') state.width = clampWidth(p.width);
  if (typeof p.dockWidth === 'number') state.dock.width = clampDockWidth(p.dockWidth);
  if (typeof p.dockOpen === 'boolean') state.dock.open = p.dockOpen;
  relayout();
  return state.geometry;
}

function setWidth(w) {
  return setGeometry({ width: w });
}

/* ---------------- 内核右栏 ⇄ 侧栏自动加宽（用户要求） ----------------
 * 为什么需要：内核在窄模式（view < 1024）下，右栏要求
 *   available = view − 56 − 400 ≥ 300  ⇒  view ≥ 756px
 * 而我们的侧栏上限是 720 ⇒ 那个面板**结构性打不开** ✗（表现为"点一下就消失"）。
 * 现在的做法：检测到"用户要开右栏"就自动加宽侧栏 ✓
 * （= 让内核有空间真的把右栏渲染出来），右栏关掉再还原到用户原来的宽度 ✓。
 * 两个信号缺一不可：
 *   · **意图**（必须）：点官方按钮或 Ctrl+Shift+B —— 宽度不够时状态属性根本不会变 ✗；
 *   · **事实**：官方 frame 的 `data-rightbar-collapsed` 属性（权威 ✓）。
 * 安全：只在我们**处于自动加宽状态**且用户没手动改过宽度时才还原 ✓。
 *
 * ── 2026-10-16（测量驱动批）：从"一步到 900"改成"**预算档 + 实测闭环**" ─────────────
 * 改之前的缺口（只读取证确认过，不是推测）：`scheduleNarrowAdaptation()` 每次都实测并落下
 * `state.narrow.metrics.overflow`（= 内容是否装不下），但它**只进 dsh-status 诊断**，
 * 全文件没有一处拿它调宽度 ⇒ 自动加宽只有"整侧栏一步加到 900"这一条布尔路径。
 * 现在：
 *   · 右栏档起手 = `RIGHTBAR_MIN_BAND`（= 内核硬下限 **756 页面视口** + 控制栏 30 = **786 带宽**）。
 *     ⚠️ 2026-10-19 修：上一版写的是 `RIGHTBAR_PAGE_MIN` **本身**（把"视口门槛"当成了"带宽"）
 *     ⇒ 带 756 只得到视口 726、available 270 ⇒ 右栏照样打不开，而门禁是绿的。
 *     不再一步到 `RIGHTBAR_AUTO_WIDTH`；上界仍是 900（= MAX_WIDTH，拖宽的上界）。
 *   · **扳机是读数**：每次测量后看 `metrics.overflow` —— 清零就停（不继续加）；
 *     仍溢出且没到上界 ⇒ `WIDTH_STEP_PX` 一步；到上界仍溢出 ⇒ **如实上报**（见下）。
 *   · 去抖：步进**只发生在测量回调里**（`applyNarrowAdaptation` 末尾 → `reviseWidthBudget()`），
 *     **绝不**在 `relayout()` 里无脑重试 —— relayout 在"加宽自己"和"拖宽每一帧"上都会触发，
 *     在它里面重试就是"加宽 ⇒ 重排 ⇒ 又溢出 ⇒ 再加宽"的自激环 ✗。
 *   · 回退：每次自动加宽都记 `prev`（`state.autoWide`；批内再加 `contentBudget.prev`），
 *     右栏关掉且用户没手动改过 ⇒ 还原 `prev`；用户拖过 ⇒ 自动档让位（既有语义，复用 ✓）。
 *   · 唯一改宽出口：仍然只有 `setWidth()` 一处（本节的每一步都经它 ✓）。
 *   · 装不下要**看得见**：到上界仍溢出 ⇒ `contentBudget.overflowAtCeiling + note`，并经
 *     `dsh-status` 的 `contentBudget` 字段说出去 —— 免得人"明明拖宽了它还是显示不全"却没线索。
 * 为什么自动档可以用 `metrics.overflow` 当扳机而**不看 tab 名**：终端/文档/浏览器这些名字是
 *   内核私有 DOM，会**静默失效**（台账 R6 那一类）；`scrollWidth > innerWidth` 是页面自己量的
 *   事实。粗档只认"右栏开/关"，细档只认这一个读数 —— 名字只进日志与报告，不进判据 ✓。
 * 文档：docs/ARCHITECTURE.md、README「DSH 侧边栏」条、CHANGELOG。 */

/** 注入到 DSH 页面里的观察器（每页只装一次，用页面上的标志位去重）。
 *  只做两件事：报告"用户要开右栏"（意图）与"右栏真的开/关了"（事实）。
 *  为什么要意图信号：内核在宽度不足时把右栏宽度算成 0，属性仍是"关" ✗。 */
const RIGHTBAR_WATCHER_JS = `(function () {
  if (window.__mmRightbarWatched) return 'already';
  window.__mmRightbarWatched = true;
  function report(tag) { try { console.log(tag); } catch (e) {} }
  function frame() { var o = document.querySelector('[data-shell-overlay]'); return o ? o.parentElement : null; }
  function state() { var f = frame(); return f ? !f.hasAttribute("data-rightbar-collapsed") : null; }
  var seen = null;
  function tick() {
    var s = state();
    if (s === null || s === seen) return;
    seen = s;
    report(s ? '[dsh-rightbar-open]' : '[dsh-rightbar-closed]');
  }
  function watch(el) { try { new MutationObserver(tick).observe(el, { attributes: true, attributeFilter: ["data-rightbar-collapsed"] }); } catch (e) {} }
  var f = frame();
  if (f) watch(f);
  else new MutationObserver(function () { var g = frame(); if (g) { watch(g); tick(); } }).observe(document.documentElement, { childList: true, subtree: true });
  tick();
  // 意图信号一：点官方「打开侧边栏」（title / aria-label 两种语言都认）
  var LABEL = /打开侧边栏|Open sidebar/i;
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      var t = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || '')) || '';
      if (LABEL.test(t)) { report('[dsh-rightbar-request]'); break; }
      el = el.parentElement;
    }
  }, true);
  // 意图信号二：官方 tooltip 里写着的快捷键 Ctrl+Shift+B
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) report('[dsh-rightbar-request]');
  }, true);
  return 'installed';
})()`;

async function installRightbarWatcher() {
  if (!state.view || !state.view.webContents) return false;
  try {
    // ⚠️ 必须带超时：真机踩到过 —— 注入时机恰好撞上页面自身的加载/导航时，
    // `executeJavaScript` 会**一直不返回**（既不成功也不报错 ✗）⇒ state.rightbarWatcher
    // 停在 null ⇒ 观察器永远装不上 ⇒「打开侧边栏」永远不会触发自动加宽 ✗✓。
    // 这正是 dsh-status 的 rightbarWatcher 字段照出来的（显示"未装"而 narrow 却是 wide ✓）。
    // 有超时后：超时只记状态，下一轮注入会再试 ✓（注入本身在 relayout / did-finish-load 上会重跑 ✓）。
    const r = await Promise.race([
      state.view.webContents.executeJavaScript(RIGHTBAR_WATCHER_JS),
      new Promise((res) => setTimeout(() => res('__timeout__'), 3000))
    ]);
    if (r === '__timeout__') {
      state.rightbarWatcher = 'timeout（下一轮注入重试）';
      return false;
    }
    state.rightbarWatcher = r === 'installed' ? 'on' : 'already';
    return true;
  } catch (e) {
    state.rightbarWatcher = 'error: ' + String(e && e.message);
    return false;
  }
}

/* ---------------- 测量驱动的宽度预算（右栏让位 ⟶ 内容装不下 ⟶ 继续加） ----------------
 * 一处实现：**所有**"该多宽"的判断都在 `budgetTargetWidth()` 里（纯函数：宽度 + 右栏状态 → 目标宽）。
 * 两个调用点，各司其职、互不重复：
 *   · `ensureRightbarRoom()` —— 粗档（右栏开/关，权威信号）起手时算一次；
 *   · `reviseWidthBudget()`  —— 细档：每次**实测**到 `metrics.overflow` 之后再看要不要继续走。
 * 两条都不自己改宽：出口只有 `setWidth()` 一处 ✓。 */

/** 右栏开、但侧栏窄于内核下限时，**够用就好**的目标宽 = 内核下限**换算成带宽**（786，不是一步到上界）。
 *  为什么要 `Math.min(MAX_WIDTH, ...)`：`Math.max` 的结果超过上界时会被 `setWidth` 截住，
 *  那样"以为加到了、其实没加"就变成静默空转 ✗ ⇒ 这里自己先夹住，调用方看到的就是真值。
 *  ⚠️ 这里**不再额外加一个步进**（第一版写成 `max(下限, 当前 + 步进)`，实测让"垫到下限"落到
 *  下限 **+54** —— 多垫一步没有读数依据，而且让"起手 = 内核下限"这条可判据的承诺失真 ✗）。
 *  @param {number} cur 当前侧栏宽度（含控制栏；这里只用于兜底取大）
 *  @returns {number} 目标宽（含控制栏） */
function rightbarRoomTarget(cur) {
  // ⚠️ 这里算的是**带宽** ⇒ 地板必须用 RIGHTBAR_MIN_BAND（= 视口门槛 + 控制栏），
  //    用 RIGHTBAR_PAGE_MIN 就是本批修的那个 30px 错（带 756 ⇒ 视口 726 ⇒ 内核仍算 0 宽）。
  return Math.min(MAX_WIDTH, Math.max(RIGHTBAR_MIN_BAND, cur));
}

/** 取一次页面的真实读数。**判据只有一条边：页面自己报的那条**（`documentElement.offsetWidth`）。
 *  为什么不用 `view.getBounds().width` 当判据（实测踩出来的，2026-10-16）：
 *    `WebContentsView.setBounds()` **不保证**页面视口跟着变 —— 实测（本仓库、离屏窗口）里
 *    `getBounds()` 报 726、页面 `offsetWidth/innerWidth` 一直停在 390：连续 6 次改宽全是旧值，
 *    连"窗口显示 + 重挂视图 + 主窗口 setContentSize"都不动，而同一次运行里对**裸** WebContentsView
 *    直调 `setBounds()` 却能同步 ⇒ 这是**环境**事实（离屏窗口里这条链不重排），不是本模块的 bug。
 *    结论用一句话记住：bounds 是"我们**要求**的边"，页面视口才是"用户**看到**的边"。
 *      · 宽度控制的判据 = 页面视口（用户看到的）；bounds 只作对照读数（`boundsWidth`）；
 *      · 三条读数（页面视口 / innerWidth / 要求的边）对不上 ⇒ **一致**才算数，
 *        否则调用方走 `rejectStaleMeasurement()`：不做决定、如实记 `note`、补排一次测量。
 *  @returns {Promise<{viewWidth:number, boundsWidth:number, pageViewportWidth:number,
 *                     innerWidth:number, scrollWidth:number, overflow:boolean, consistent:boolean}>} */
async function measurePageOverflow() {
  const wc = state.view && state.view.webContents;
  if (!wc) throw new Error('no-view');
  const boundsW = state.view.getBounds().width;
  // 测试专用接缝（产品路径永远不设置它）：见 `setMeasureProbeForTest` 的注释。
  // 它只**替换读数**，不替换视图 —— 视图仍是真的，所以 `relayout()` 的 `setBounds` 照旧生效 ✓
  if (typeof state.measureProbeForTest === 'function') {
    const p = state.measureProbeForTest();
    return { viewWidth: p.pageViewportWidth, boundsWidth: boundsW,
      pageViewportWidth: p.pageViewportWidth, innerWidth: p.innerWidth,
      scrollWidth: p.scrollWidth, overflow: !!p.overflow,
      consistent: Math.abs(p.pageViewportWidth - p.innerWidth) <= 2 };
  }
  const info = await wc.executeJavaScript(
    '(function(){var d=document.documentElement;'
    + 'var sw=Math.max(d.scrollWidth,document.body?document.body.scrollWidth:0);'
    + 'return {pageViewportWidth:d.offsetWidth,innerWidth:window.innerWidth,scrollWidth:sw,'
    + 'overflow:sw>d.offsetWidth+1};'
    + '})()');
  return { viewWidth: info.pageViewportWidth, boundsWidth: boundsW,
    pageViewportWidth: info.pageViewportWidth, innerWidth: info.innerWidth,
    scrollWidth: info.scrollWidth, overflow: !!info.overflow,
    consistent: Math.abs(info.pageViewportWidth - info.innerWidth) <= 2 };
}

/** 把一次读数记进预算的**读数序列**（给人与断言看的证据；只留最近 12 条防长跑爆内存）。
 *  `dir` 是这一步的来由，不是推断：'below-floor' 右栏下限没够 / 'stepped' 因溢出加了一步 /
 *  'at-ceiling' 到上界 / 其余是普通测量。 */
function budgetRecord(b, m, dir) {
  b.readings.push({ width: state.width, viewWidth: m.viewWidth, boundsWidth: m.boundsWidth,
    innerWidth: m.innerWidth, scrollWidth: m.scrollWidth, overflow: m.overflow, dir: dir });
  if (b.readings.length > 12) b.readings.splice(0, b.readings.length - 12);
  b.width = state.width;
  b.viewWidth = m.viewWidth;
  b.boundsWidth = m.boundsWidth;
  b.lastOverflow = m.overflow;
  b.stepUps = (b.stepUps || 0) + (dir === 'stepped' ? 1 : 0);
  b.pending = null;
  b.tier = 'measured';
}

/** 开一次**内容预算会话**：只在"右栏开"这条粗档上武装（别的路径不许动宽度 ✓）。
 *  为什么不看 tab 名：那是内核私有 DOM，会静默失效（见本节大注释）。 */
function openContentBudget(reason) {
  const b = {
    active: true, reason: reason,
    min: RIGHTBAR_MIN_BAND,            // **带宽**口径（含控制栏）—— 与 width/prev 同一坐标系
    max: MAX_WIDTH, step: WIDTH_STEP_PX,
    prev: state.autoWide ? state.autoWide.prev : state.width,   // 回退点（与 autoWide 同一个真值）
    tier: 'opened',            // opened → awaiting-measure → measured → settled | unsupported
    settled: false, unresolved: false, overflowAtCeiling: false,
    stepUps: 0, readings: [], width: state.width, viewWidth: null,
    lastOverflow: null, pending: null, note: null, at: new Date().toISOString()
  };
  state.contentBudget = b;
  return b;
}

/** 预算的**目标宽度**（纯函数 —— 唯一的"该多宽"判断，别在别处再写一份 ✗）。
 *  @param {number} cur 当前宽度（`state.width`，含控制栏）
 *  @param {{lastOverflow:(boolean|null)}} b 内容预算（只读 `lastOverflow` 这一个读数）
 *  @param {boolean} rightbarOpen 粗档：右栏是否开着（既有**事实**信号）
 *  @returns {{width:number, dir:string}} 目标宽 + 这一步的来由 */
function budgetTargetWidth(cur, b, rightbarOpen) {
  // ① 粗档：右栏开着、侧栏还没到内核下限、**而垫到下限确实能把宽度推上去** ⇒ 垫到下限本身。
  //   ⚠️ 最后那个 `target > cur` 不能省（实测踩到）：宽度已经是 756（下限）而 view = 726 < 756 时，
  //   `rightbarRoomTarget(786)` 夹回来还是 786 ⇒ 若这一支照样 return，就会回一个"什么都没做"
  //   却标着 `below-floor` 的结论，**把本该发生的"因溢出加一步"整支吞掉** —— 表现为
  //   "内容一直溢出、宽度一直不动"（读数序列只剩第一条）。这条条件是它的判别力所在。
  if (rightbarOpen) {
    const target = rightbarRoomTarget(cur);
    // 判据与目标必须在**同一坐标系**里比：`cur` 是带宽、`RIGHTBAR_MIN_BAND` 也是带宽。
    // （上一版拿 `cur - RAIL` 去比 RIGHTBAR_PAGE_MIN，却回一个 756 的**带宽**目标 ⇒ 差 30px。）
    if (cur < RIGHTBAR_MIN_BAND && target > cur) {
      return { width: target, dir: 'below-floor' };
    }
  }
  // ② 细档：**唯一的扳机 = 实测读数**。内容不溢出 ⇒ 到此为止，不再加（这就是"测量驱动"）
  if (b.lastOverflow !== true) return { width: cur, dir: 'fits' };
  // ③ 溢出且还没到上界 ⇒ 加一步；到上界 ⇒ 不动（由调用方如实上报）
  if (cur < MAX_WIDTH) {
    return { width: Math.min(MAX_WIDTH, cur + WIDTH_STEP_PX), dir: 'stepped' };
  }
  return { width: cur, dir: 'at-ceiling' };
}

/** 加宽之后**必须再测一次**（闭环的另一半：不重测就不知道加宽有没有把内容装下）。
 *  ⚠️ 重测**只在这一处**发生，而且用"量出来真的还是这条边"当判据 —— 而不是在 `relayout()` 里
 *  重试（那会自激 ✗）。量到的那条边不对（窗口挤的 / 布局还没落 / 环境不重排）就**不判**，
 *  把它交给 `rejectStaleMeasurement()` 的那条路（下一次注入会重来一遍）✓。
 *  @param {object} b 内容预算（`b.pending.expectedView` = 这次加宽**之后**期望的 view 宽）
 *  @returns {Promise<{done:boolean, reason:string, m?:object}>} */
function scheduleBudgetMeasurement(b) {
  if (!b || !b.active || b.settled) return Promise.resolve({ done: false, reason: 'inactive' });
  const expectedView = b.pending ? b.pending.expectedView : null;
  return measurePageOverflow().then((m) => {
    if (expectedView !== null && Math.abs(m.viewWidth - expectedView) > 2) {
      return { done: false, reason: 'pending-width（量到 ' + m.viewWidth + '，期望 ' + expectedView + '）' };
    }
    budgetRecord(b, m, 'remeasure');
    b.tier = 'measured';
    log('内容预算复查：页面视口 ' + m.viewWidth + '，内容 ' + m.scrollWidth
      + (m.overflow ? ' ⇒ **仍横向溢出**' : ' ⇒ 内容已装下 ✓') + '（档位 ' + b.tier + '）');
    return { done: true, reason: m.overflow ? 'still-overflow' : 'fits', m: m };
  }).catch((e) => {
    b.tier = 'unsupported';
    b.note = '复查失败（读数取不到）: ' + String((e && e.message) || e);
    return { done: false, reason: 'measure-failed: ' + b.note };
  });
}

/** 预算编排：算目标宽 → 走**唯一出口** setWidth → 重测 → 到位就停 / 仍溢出且没到上界就再来一步 /
 *  到上界仍溢出就**如实上报**（`overflowAtCeiling + note`，并 broadcastStatus ⇒ dsh-status 看得见 ✓）。
 *
 *  为什么是递归+上限而不是 while 循环：每一步都要**等一次真实重排与重测**（闭环），
 *  上限由 `WIDTH_STEP_MAX` 与 `MAX_WIDTH` 双重夹住 ⇒ 不可能自激，也不需要"视情况"档。
 *  @param {string} reason 这次的来由（进读数序列，便于事后回答"它为什么变宽了"）
 *  @returns {Promise<{started:boolean, reason?:string, changed?:boolean, from?:number,
 *                     to?:number, dir?:string, overflow?:(boolean|null), tier?:string,
 *                     reported?:boolean, done?:boolean}>} */
async function runContentBudget(reason) {
  const b = state.contentBudget;
  if (!b || !b.active || b.settled) return { started: false, reason: 'no-budget' };
  if (!state.view || !state.view.webContents) return { started: false, reason: 'no-view' };
  if (state.userTookOver) {                     // 用户手动拖过 ⇒ **自动档让位**（既有语义，复用 ✓）
    b.settled = true; b.tier = 'user-takeover';
    b.note = '用户手动改过宽度 ⇒ 自动档让位（不再自动加宽，也不还原）';
    return { started: false, reason: 'user-takeover' };
  }
  let m = null;
  try { m = await measurePageOverflow(); }
  catch (e) {
    b.tier = 'unsupported';
    b.note = '读数取不到（不猜、也不改宽度）: ' + String((e && e.message) || e);
    return { started: false, reason: 'measure-failed: ' + b.note };
  }
  /* ⚠️ **同源判据**（本函数唯一的进入条件，实测踩出来的）：
   *   判据必须是"用户真的看到的那条边"= 页面视口（`measurePageOverflow` 已把 viewWidth 定义成它）。
   *   还有两种让它失效的情形，都必须**不做决定**（宁可留 `note` 说清，也不猜 ✓）：
   *     ① 页面视口与页面 innerWidth 对不上 ⇒ 这条读数自相矛盾；
   *     ② 页面视口与"我们要求的边"（`state.width − RAIL_WIDTH`）对不上 ⇒ 改宽**没有落到页面上**：
   *        离屏/无头窗口里实测到过 `getBounds()` 一直是新值、页面视口却纹丝不动（连续 6 次改宽全是
   *        旧值）⇒ 这时任何"溢出/不溢出"的结论都是在讨论**上一轮**的布局，据此加宽就是凭空多垫 ✗。
   *   两种都走 `rejectStaleMeasurement()`：补排一次测量（只补这一次）并**如实记进 note** ——
   *   让"没测成"永远是**可见**的状态，而不是一个看起来成功的静默空转 ✓。 */
  const want = Math.max(0, state.width - RAIL_WIDTH);
  if (!m.consistent) {
    rejectStaleMeasurement(b, '页面视口 ' + m.pageViewportWidth + ' ≠ innerWidth ' + m.innerWidth);
    return { started: false, reason: 'stale-measurement' };
  }
  if (Math.abs(m.viewWidth - want) > 2) {
    rejectStaleMeasurement(b, '页面视口 ' + m.viewWidth + ' ≠ 要求的边 ' + want
      + '（bounds 报 ' + m.boundsWidth + ' ⇒ 改宽没落到页面上）');
    return { started: false, reason: 'viewport-not-applied' };
  }
  const from = state.width;
  /* ⚠️ 首次测量（`lastOverflow` 还是 null = 还没有任何读数）时要**用这一条的读数**定方向，
   *  否则会出现最难看的一种形态：这条明明读到"溢出"，结论却是 `fits`、还把它标记成"到此为止"
   *  ⇒ 该加宽的没加（实测踩到：闭环只留下第一条读数就不动了 ✗）。
   *  只看**这一条**的读数、不看历史：这就是"测量驱动"的字面意思 ✓。 */
  const effective = Object.assign({}, b,
    { lastOverflow: b.lastOverflow === null ? m.overflow : b.lastOverflow });
  const t = budgetTargetWidth(from, effective, !!state.rightbarOpen);
  if (t.dir === 'fits') b.settled = true;       // 内容装得下 ⇒ 闭环到此为止
  budgetRecord(b, m, t.dir);
  if (t.width === from) {
    // 不加宽。若"到上界仍溢出"，这里就是**上报**：不许静默挤（那是本批要修的困惑来源 ✗）
    if (t.dir === 'at-ceiling') {
      b.unresolved = true; b.overflowAtCeiling = true;
      b.note = '内容仍然装不下：已到宽度上限 ' + MAX_WIDTH + '（页面 ' + b.viewWidth
        + '：内容 ' + m.scrollWidth + ' > 可视 ' + m.innerWidth + '）';
      log('⚠ ' + b.note + ' —— 不再加宽（到上界），如实上报而不是静默挤');
    } else if (t.dir === 'fits') {
      b.note = null;
    }
    broadcastStatus();
    return { started: true, done: true, changed: false, from: from, to: from, dir: t.dir,
      overflow: m.overflow, tier: b.tier, reported: t.dir === 'at-ceiling' };
  }
  setWidth(t.width);                            // ★ 唯一改宽出口
  const expectedView = Math.max(0, state.width - RAIL_WIDTH);
  b.pending = { expected: t.width, expectedView: expectedView };
  log('测量驱动加宽：' + from + ' → ' + state.width + '（' + t.dir + '；再测一次确认内容装下）');
  broadcastStatus();
  if (b.stepUps >= WIDTH_STEP_MAX) {            // 只可能在 54×6 ≥ 144 时到（上界先拦住）—— 留作兜底
    b.tier = 'step-limit';
    b.note = '步进次数到上限（' + WIDTH_STEP_MAX + ' 次）⇒ 停止加宽并如实上报';
    b.unresolved = true; b.settled = true;
    broadcastStatus();
    return { started: true, done: true, changed: true, from: from, to: state.width, dir: t.dir,
      overflow: m.overflow, tier: b.tier, reported: true };
  }
  /* 加宽之后**必须再测一次**（闭环的另一半）：不重测就不知道加宽有没有把内容装下。
   * 不 await：这次加宽自己已经排了下一次注入（`relayout` → `scheduleNarrowAdaptation`），
   * 重测与它**同源**地来自那次注入 ⇒ 不需要在本函数里再压一条 await 链（省一次往返）。 */
  scheduleBudgetMeasurement(b, expectedView).catch(() => {});
  return { started: true, done: false, changed: true, from: from, to: state.width, dir: t.dir,
    overflow: m.overflow, tier: b.tier, reported: false };
}

/** 需要就加宽（幂等）。返回 true 表示这次真的加宽了。
 *  ⚠️ 这里**只是预算的第一步**（右栏下限档）—— 加了不一定就够，够不够由随后的**实测**说了算
 *  （`reviseWidthBudget()` 拿到 overflow 才会继续加；到上界仍溢出就上报）。
 *  `state.autoWide` 存在也**不早退**：实测驱动意味着"没到下限就垫到下限"这件事在任何时刻都成立
 *  （例如用户把它拖窄了、或窗口变化后重来的那一次）—— 只在**用户手动拖过**时让位 ✓。
 *  ⚠️ `userTookOver` 的复位**只能在这里**（实测踩到）：原先只写在 `releaseRightbarRoom()` 里，
 *  而那条在 `autoWide` 已为 null 时会提前 return ⇒ 漏掉复位 ⇒ **一次拖宽把自动档永久关掉**
 *  （门禁里表现为"后面的域整条红"，真机里表现为"从此右栏再也不会自动加宽，除非重启应用"✗）。
 *  语义：让位只持续**一次右栏会话**；用户重开右栏 = 自动档重新获得一次机会 ✓。 */
function ensureRightbarRoom() {
  const view = Math.max(0, state.width - RAIL_WIDTH);
  if (view >= RIGHTBAR_PAGE_MIN) return false;          // 已经够宽（view = 页面视口，口径 ✓），不用动
  if (state.userTookOver) return false;                 // 用户手动改过 ⇒ 自动档让位（既有语义 ✓）
  if (!state.autoWide) {
    state.userTookOver = false;                         // 新一次会话：复位（复位点只有这一处 ✓）
    state.autoWide = { prev: state.width };
    const b0 = openContentBudget('rightbar-open');
    b0.tier = 'awaiting-measure';
  }
  const to = rightbarRoomTarget(state.width);
  if (to === state.width) return false;                 // 到上界也还是不够（极窄窗口）⇒ 不动、不报
  setWidth(to);                                         // ★ 同一条出口（右栏档 = 内核下限，不再一步到 900）
  log('内核右栏需要空间 → 自动加宽侧栏 ' + state.autoWide.prev + ' → ' + state.width
    + '（预算档 ' + RIGHTBAR_MIN_BAND + '…' + MAX_WIDTH + '：够用即止，装不下才继续加）');
  broadcastStatus();
  return true;
}

/** 实测回调：每个测量点都问一次"当前宽度还合不合适"（唯一的细档扳机在这里）。
 *  只在**右栏开**时动宽度 —— 右栏关着时一律不碰（把宽度留给用户与既有语义 ✓）。
 *  读数与刚刚量到的那条边对不上（右栏让位/拖宽在两次 await 之间改过宽度）⇒ 不判、
 *  **补排一次测量**（`rejectStaleMeasurement`）✓。
 *  @returns {Promise<null|object>} 动了就返回 runContentBudget 的结果；没动返回 null */
function reviseWidthBudget(reason, measured) {
  if (!state.rightbarOpen) return Promise.resolve(null);
  const b = state.contentBudget;
  if (!b || !b.active || b.settled) return Promise.resolve(null);
  if (measured && (Math.abs(measured.pageViewportWidth - measured.innerWidth) > 2
    || Math.abs(measured.pageViewportWidth - measured.wantView) > 2)) {
    rejectStaleMeasurement(b, '页面视口 ' + measured.pageViewportWidth
      + ' ≠ innerWidth ' + measured.innerWidth + ' / 要求的边 ' + measured.wantView);
    return Promise.resolve(null);
  }
  return runContentBudget(reason || 'revisit').catch((e) => {
    b.tier = 'error';
    b.note = '预算编排异常（如实记下、不改宽度）: ' + String((e && e.message) || e);
    return null;
  });
}

/** 读数与那条边不是同一次取样 ⇒ **不做决定**，补排一次测量（只补这一次，不是无限重试）。
 *  为什么必须补一次：右栏让位与内容加宽都发生在注入的那两次 `await` 之间，那条新的边
 *  **需要一次属于它自己的测量**才判得了；不补的话只能等用户下一次交互，表现为"点开右栏
 *  要拖一下才生效"——那正是本工程早就修过的那个 bug 的形状，不能再造一个 ✗。
 *  重排走既有的 `scheduleNarrowAdaptation`（重试次数与上限都由它管）；只在"右栏开着
 *  且预算还在跑"时补，别把普通测量也变成循环 ✓。 */
function rejectStaleMeasurement(b, why) {
  b.staleSkips = (b.staleSkips || 0) + 1;
  b.tier = 'stale-skip';
  b.note = '读数与当前宽度不是同一次取样 ⇒ 本次不判、补排一次测量（' + why + '）';
  // 状态出口要**当场**能看见"这次没判"（计数 + 原因）—— 否则诊断只能说"还在等测量"，
  // 而人真正要问的是"它为什么没动"（这与本模块 narrowSkip 那条纪律同形 ✓）
  broadcastStatus();
  if (state.rightbarOpen && b.active && !b.settled) {
    if (narrowTimer) { clearTimeout(narrowTimer); narrowTimer = null; }
    scheduleNarrowAdaptation(false);
  }
  return b.staleSkips;
}

/** 右栏关掉后还原（只在我们还在自动宽度、且用户没手动改过时还原 ✓）。
 *
 *  "用户手动改过"的判据**只有一条**：`state.userTookOver`（唯一的写入点是拖宽 `beginWidthDrag()`）。
 *  为什么不沿用旧写法 `state.width === RIGHTBAR_AUTO_WIDTH`：本批起自动档根本**不一定会到 900**
 *  （够用即止 ⇒ 常见落在 756…900 之间的某一档），拿"等不等于上界"当"用户改过没有"的判据
 *  会在**没人动过宽度**时判成"被手动改动过 ⇒ 不还原"✗ —— 那就是"用户拖宽过"这条保护
 *  反向失效。语义没变（还是"手动改过就不还原"），换的是**能分辨这件事的那条读数**。 */
function releaseRightbarRoom() {
  const auto = state.autoWide;
  const budget = state.contentBudget;
  if (budget) {                        // 预算会话结束：读数序列留着（诊断要能回答"刚才为什么那么宽"✓）
    budget.active = false;
    budget.settled = true;
    budget.tier = 'released';
  }
  const tookOver = state.userTookOver;
  const prev = auto ? auto.prev : (budget ? budget.prev : null);
  state.userTookOver = false;          // 自动档复位（下一次右栏会话重新获得机会 ✓）
  if (!auto) return false;
  state.autoWide = null;
  if (!tookOver && typeof prev === 'number' && state.width !== prev) {
    setWidth(prev);
    log('内核右栏关闭 → 还原侧栏宽度 ' + prev
      + '（右栏会话期间自动加宽到过 ' + (budget ? budget.width : '?') + '）');
    broadcastStatus();
    return true;
  }
  log('内核右栏关闭：宽度已被手动改动（' + state.width + '），不还原');
  return false;
}

/* ---------------- 对外 API（main.js 调用） ---------------- */

/** init：接窗口 + 恢复上次可见性/宽度 + 尝试接管驻留服务。默认打开（用户要求）。 */
function init(win) {
  state.win = win;
  win.on('resize', relayout);
  win.on('closed', () => { state.win = null; });
  loadPrefs();
  // 页面**加载完成后**补发一次布局：init 期间那次发送早于渲染层订阅，消息会丢
  //（症状：刚打开时工具栏被侧栏盖住，拖一下侧栏才恢复 —— 见 notifyAfterLoad 注释）
  notifyAfterLoad();
  // 服务启动 + 默认打开（异步不阻塞窗口创建）
  setImmediate(async () => {
    await adoptOrStart();
    if (state.visible) show();
  });
}

/** 主界面重启场景：新窗口接入既有 view（服务不重启，交互不中断） */
function reattach(win) {
  state.win = win;
  win.on('resize', relayout);
  win.on('closed', () => { state.win = null; });
  if (state.view && state.visible && win.contentView) {
    try { win.contentView.addChildView(state.view); } catch (e) { /* ignore */ }
    if (state.rail && win.contentView) {
      try { win.contentView.addChildView(state.rail); } catch (e) { /* ignore */ }
    }
    relayout();
  }
}

function show() {
  if (!state.win) return;
  ensureView();
  ensureRail();
  if (state.win.contentView) {
    // 顺序即 z 序：两个按钮最后挂 → 盖在 DSH 页面上（右上角恒可点）
    // 顺序即 z 序：控制栏最后挂（它本来就不与页面重叠，这一层只是保险）
    state.win.contentView.addChildView(state.view);
    state.win.contentView.addChildView(state.rail);
  }
  state.visible = true;
  /* 新一轮会话的**清理**（实测踩到，两处都是"状态比产品语义活得更久"）：
   *   · 自动档的"用户改过宽度"锁只在**一次会话**内有效 ⇒ 每次 show() 复位。原先它只在
   *     `releaseRightbarRoom()` 里复位，而那条在 `autoWide` 已为 null 时提前 return ⇒
   *     一次拖宽把自动档**永久**关掉（真机：右栏从此不再自动加宽，除非重启应用 ✗；
   *     门禁：域 53 模拟拖宽 ⇒ 后面的「右栏自动加宽」整条红）。
   *   · 上一轮的 autoWide 也要清：不重新挂的话，`ensureRightbarRoom()` 会认为"已在自动加宽"
   *     而算出的 prev 是上一轮的旧值 ⇒ 关右栏时还原到错的地方。 */
  state.userTookOver = false;
  state.autoWide = null;
  // 新一轮会话：窄宽适配重来一遍（服务可能换了端口/token ⇒ URL 变了 ⇒ 需要重新注入）
  scheduleNarrowAdaptation(true);
  relayout();
  if (state.status === 'running' && state.url) loadCurrentUrl();
  else if (state.status === 'starting') showStatusPage(PAGE_STARTING);
  else if (state.status === 'error') showStatusPage(errorPageHtml(state.lastError || '未知错误'));
  else {
    showStatusPage(PAGE_STARTING);
    startService();
  }
  savePrefs();
}


/** 只关**侧栏那一半**：收起 view（并**真正销毁**它 —— 内存里不留这个页面）+ 停掉 DSH 服务；
 *  主界面、应用进程、项目数据都不受影响。
 *  停服务是刻意的（用户要的"独立关掉侧栏 DSH"）—— 这样更新 DSH 那一侧时不必重启应用；
 *  想回来点主界面右缘的 🤖（show() 发现服务不在会自动重新孵化/接管 ✓，view 也会重建 ✓）。
 *  opts.keepService=true 只收 view、不动服务（**给自动化断言用**：冒烟进程可能正接管着
 *  用户真实的服务，断言不能把它杀掉 ✗）。 */
function closeSidebar(opts) {
  const keepService = !!(opts && opts.keepService);
  hide();
  destroyView('侧栏独立关闭（✕）');
  if (!keepService) stopService();
  log('侧栏已独立关闭（' + (keepService ? '服务保留（断言模式）' : 'DSH 服务已停')
    + '；主界面继续运行；视图已销毁，重开会重新加载页面）');
  broadcastStatus();
}

/** **页面要预留的总宽** = 控制栏 + 侧栏内容 + 停靠面板（第 4 面板批起含面板）。
 *  只报 view 宽度会少报 RAIL_WIDTH ⇒ 页面少让一条 ⇒ 又出现"侧栏隔壁的灰色背景" ✗；
 *  第 4 面板批再补一条：**只报侧栏**会少报面板宽 ⇒ 面板会盖住页面右缘（同一种病）。
 *  ⚠️ 次序很重要：**先认几何**（唯一计算处，它才是"我们现在要求画成什么样"），
 *     bounds 求和只是启动早期（还没 relayout 过）的兼容回退 —— 反过来会让"侧栏已收起、
 *     面板开着"这一档报出侧栏的旧 bounds（面板就白让了位）。 */
function occupiedWidth() {
  if (state.geometry) return state.geometry.occupiedWidth;
  let w = 0;
  try { if (state.rail) w += state.rail.getBounds().width; } catch (e) { /* ignore */ }
  try { if (state.view) w += state.view.getBounds().width; } catch (e) { /* ignore */ }
  try { if (state.panelView) w += state.panelView.getBounds().width; } catch (e) { /* ignore */ }
  return w;
}

/** 侧栏**那条带**的宽（控制栏 + 内容，**不含**停靠面板）。
 *  为什么单开一个读数：occupiedWidth() 现在是"页面让位总量"，而渲染层的**拖宽热区**
 *  （侧栏左缘 ±8px）必须用侧栏自己的左缘 —— 拿总量当它有面板时就偏了整整一个面板宽，
 *  表现为"在面板左边拖动，改的却是侧栏宽度"✗。 */
function sidebarBandWidth() {
  if (state.geometry) return state.geometry.sidebarBandWidth;
  let w = 0;
  try { if (state.rail) w += state.rail.getBounds().width; } catch (e) { /* ignore */ }
  try { if (state.view) w += state.view.getBounds().width; } catch (e) { /* ignore */ }
  return w;
}

/** 控制栏里两个按钮的几何（**屏幕坐标**，已把控制栏偏移算进去）+ 控制栏自身 bounds —— 断言用。
 *  语义与旧版一致：✕ 必须在 − 下面、不重叠、且整体落在侧栏内（用总占宽比，不能用 view 宽度比 ✗）。 */
async function buttonBounds() {
  let rail = null;
  try { rail = state.rail ? state.rail.getBounds() : null; } catch (e) { rail = null; }
  let rects = null;
  if (state.rail && state.rail.webContents) {
    try {
      rects = await state.rail.webContents.executeJavaScript(
        `(function(){var q=function(id){var el=document.getElementById(id);if(!el)return null;`
        + `var r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),`
        + `width:Math.round(r.width),height:Math.round(r.height)};};`
        + `return {collapse:q("collapse"),close:q("close")};})()`);
    } catch (e) { rects = null; }
  }
  const abs = (r) => ((r && rail)
    ? { x: rail.x + r.x, y: rail.y + r.y, width: r.width, height: r.height } : null);
  return {
    rail: rail,
    collapse: abs(rects && rects.collapse),
    close: abs(rects && rects.close),
    occupiedWidth: occupiedWidth()
  };
}

/** 两个按钮的**真实 DOM 事实**（给断言用）。
 *  为什么必须查 DOM 而不是查字符串：页面是 data: URL，属性写坏一个引号就会让整个
 *  `<button>` 被吞进属性值里 —— 页面照样有底色、照样加载成功，但**没有按钮、点了没反应**
 *  （真机上 ✕ 就是这么坏的 ✗）。只有问 DOM 才能把这种错钉死。 */
async function buttonProbe() {
  const probe = async (id) => {
    if (!state.rail || !state.rail.webContents) return null;
    try {
      return await state.rail.webContents.executeJavaScript(
        `(function(){var el=document.getElementById(` + JSON.stringify(id) + `);`
        + `return {hasEl:!!el,buttons:document.querySelectorAll("button").length,`
        + `text:el?(el.textContent||"").trim():"",title:el?(el.getAttribute("title")||""):""};})()`);
    } catch (e) { return { hasEl: false, err: String(e && e.message) }; }
  };
  return { collapse: await probe('collapse'), close: await probe('close') };
}

/** 点一下控制栏里的按钮（断言用：按钮"存在"≠"点了有用"，这两个 bug 都真出现过 ✗） */
async function clickButton(id) {
  if (!state.rail || !state.rail.webContents) return false;
  try {
    await state.rail.webContents.executeJavaScript(
      `(function(){var el=document.getElementById(` + JSON.stringify(id) + `);`
      + `if(el){el.click();return true;}return false;})()`);
    return true;
  } catch (e) { return false; }
}

function hide() {
  if (!state.win) return;
  /* 虚影**不受"侧栏是否显示"支配**，但它挂在同一个窗口的客户区上 ⇒ 侧栏一显一收会重排子视图序、
   * 也可能把虚影留在屏上（拖拽还没结束时的边界情形）。这里强制收一次 —— 下一拍若拖拽仍在，
   * 驱动侧会把它重新挂到最上层（`updateGhost` 每拍都重挂）。防孤儿的第三道闸就落在这一处。 */
  fireHide('sidebar-hide');
  if (state.view && state.win.contentView) {
    try { state.win.contentView.removeChildView(state.view); } catch (e) { /* ignore */ }
  }
  if (state.rail && state.win.contentView) {
    try { state.win.contentView.removeChildView(state.rail); } catch (e) { /* ignore */ }
  }
  state.visible = false;
  // 收起侧栏 ⇒ 让位带只剩**停靠面板**（若它开着），面板从"侧栏内缘"贴到窗口右缘。
  // 原先这里只发一条 notifyRenderer(false)：那会把仍在屏上的面板也报成 0（页面立刻被面板盖住 ✗）。
  relayout();
  savePrefs();
}

function toggle() {
  state.visible ? hide() : show();
}

function isVisible() { return state.visible; }
function getStatus() {
  const b = viewBounds();
  return {
    status: state.status, visible: state.visible, error: state.lastError,
    width: state.width,
    // **实际占宽**（view 的真实 bounds）。渲染层让位必须用这个而不是 width：
    // width 是"意图/偏好"，页面按它预留而侧栏按 bounds 绘制 —— 两者不一致时页面就多留一条，
    // 用户看到的是"侧栏隔壁的灰色背景"（实测 420 vs 308 ⇒ 112px 的缝，和用户截图一致）。
    actualWidth: occupiedWidth() || null,
    // 侧栏**那条带**自己的宽（actualWidth 现在含停靠面板；渲染层的拖宽热区要用这个）
    sidebarWidth: sidebarBandWidth(),
    // 窄宽适配的实况（模式 + 是否横向溢出）—— 改布局要用它，不要拍脑袋
    narrow: state.narrow || null,
    // 测量驱动的**内容预算**实况：档位 / 区间 / 每一步的实测读数 / 到上界仍溢出与否。
    // 为什么必须进状态出口：到上界仍装不下时要**看得见**（否则用户只看到"拖宽了还是不显示"✗）
    contentBudget: state.contentBudget ? {
      active: state.contentBudget.active, settled: state.contentBudget.settled === true,
      tier: state.contentBudget.tier,
      reason: state.contentBudget.reason, min: state.contentBudget.min,
      max: state.contentBudget.max, step: state.contentBudget.step,
      prev: state.contentBudget.prev, width: state.contentBudget.width,
      stepUps: state.contentBudget.stepUps, lastOverflow: state.contentBudget.lastOverflow,
      overflowAtCeiling: state.contentBudget.overflowAtCeiling, unresolved: state.contentBudget.unresolved,
      note: state.contentBudget.note, at: state.contentBudget.at,
      staleSkips: state.contentBudget.staleSkips || 0,
      readings: state.contentBudget.readings
    } : null,
    // 为什么"尚未注入"——诊断要能回答它，否则只能靠猜 ✗
    narrowSkip: state.narrowSkip || null,
    // 内核右栏 ⇄ 自动加宽（用户要求）的实况
    rightbarOpen: !!state.rightbarOpen,
    autoWide: state.autoWide || null,
    rightbarWatcher: state.rightbarWatcher || null,
    // ⑩ 最近一次"把对话预填进侧栏"的结果（4b：失败也要看得见原因 ✓ 不阻断 ✗）
    lastPrefill: state.lastPrefill || null,
    // ⑩-b 「拖节点 ⇒ 真 chip」的**在位读数**（2026-10-41）：载荷装没装（内容级核对）+ 最近一次投喂
    //   走的是哪条路（`chipMode: 'plugin' | 'text'`）。**降级必须可见** —— 静默退回文字是本批禁止的失败形态。
    //   ⚠️ `installed/payloadOk` 只说明"载荷在盘上且没漂移"，**不说明**"这次真的插出了 chip"；
    //      后者看 `mode === 'plugin'`（每次投喂的现场读数），而"页面里真的是 N 个块"只有真机看得见。
    chipFeed: chipFeedStatus(),
    // 状态页/侧栏页**加载失败**的判定读数（r12 收口批）：`aborted` 出现过几次 `-3`、
    //   `absorbed` 其中几次被"随后加载成功"证明无害、`reported` 报过几条真失败、`lastFailure` 是哪一条。
    //   为什么必须进状态出口：日志里不再有良性的 `-3`，但"它发生过"这件事**不能没有出口**
    //   （否则等于把观测面删掉 —— 那正是本批最反对的方向）。
    statusPageLoad: statusPageLoadTracker().snapshot(),
    // **视图在不在**（判据字段：侧栏 ✕ 是"真关"⇒ 这里必须变成 false，断言不必去猜 ✓）
    hasView: !!state.view,
    viewId: viewIdOf(state.view),                 // 当前 view 的 webContents id（没有 = null）
    viewEpoch: state.viewEpoch,                   // 建过几次（重开必须 +1 ⇒ 是新视图，不是旧的挂回来）
    lastDestroyedViewId: state.lastDestroyedViewId, // 最近销毁的 view id（"真的销毁了"的取证点）
    // ── 第 4 个原生面板（停靠面板）实况 —— 判据字段（冒烟域 54 直接读它，不猜）──────────
    //   每个字段都回答一个**会让断言红**的问题：
    //     open/width/prev      —— 开没开、意图多宽、上一次记下了什么（"关要回到原样"的依据）
    //     applied/panelWidth   —— **要求**画成什么（几何单源的产物）
    //     bounds               —— **实际**画成什么（原生 getBounds；capturePage 看不见它 ✗）
    //     clamped/notes        —— 被夹到多少、为什么（不许静默挤）
    //     restores/lastRestore —— 关过几次、最近一次关前/关后两份快照与逐项比对
    dockPanel: {
      open: !!state.dock.open,
      width: state.dock.width,
      prev: state.dock.prev,
      epoch: state.dock.epoch,
      hasView: !!state.panelView,
      viewId: viewIdOf(state.panelView),
      lastDestroyedViewId: state.lastDestroyedPanelId,
      pageUrl: panelPageUrl(),
      pageErr: state.dock.pageErr,
      bounds: panelBounds(),
      applied: state.geometry ? state.geometry.panel : null,
      panelWidth: state.geometry ? state.geometry.panelWidth : 0,
      clamped: state.geometry ? state.geometry.clamped : null,
      notes: state.geometry ? state.geometry.notes : [],
      restores: state.dock.restores,
      lastRestore: state.dock.lastRestore,
      // ── 页面桥的读数（第 2 批 a76bab32）—— 每一条都回答"面板真的收到了吗"：
      //    pageReady     —— 页面加载完没有（false 时推数据必然失败，别把失败当"没有数据"）
      //    rendered      —— **页面自己报的**"我画了几行"（页面侧真值；判据拿它与主进程读数对拍）
      //    lastPush      —— 最近一次推送 {label, bytes, ok, err}（推失败**不许静默**）
      //    lastMessage   —— 最近一条页面 console 消息（截断 200 字；排查"页面在说话没人听"）
      pageReady: !!state.dock.pageReady,
      rendered: state.dock.rendered,
      pendingPush: state.dock.pendingPush ? { label: state.dock.pendingPush.label, at: state.dock.pendingPush.at } : null,
      lastPush: state.dock.lastPush,
      lastMessage: state.dock.lastMessage,
      bridgeRegistered: !!(state.dock.bridge && typeof state.dock.bridge.onRequest === 'function')
    },
    // 导图页的"真关"状态（关 = 页面被卸载；重开 = 重新加载 + 还原宽度/项目）
    mapPageClosed: state.mapPageClosed,
    lastProject: state.lastProject,
    bootProject: state.bootProject,
    servicePid: state.proc ? state.proc.pid : state.servicePid || null,
    // 本窗口是否**孵化**了这个服务（false = 接管来的驻留服务）；驻留语义下
    // 这不影响可用性，只用于排查"谁该负责收割"
    ownedByThisWindow: !!state.proc,
    resident: state.status === 'running' && !!state.servicePid
  };
}

/** 渲染层只需要知道「侧栏占多宽」来让位 —— 不给 url/token。
 *
 * ⚠️ 必须发**实际占宽**，不是"意图宽度" `state.width`：
 *   `relayout()` 里 view 的实际宽度是 `min(state.width, 窗口内容宽)`，两者可能不同；
 *   一旦不同，页面就会多留（或少留）一条 —— 用户看到的就是"侧栏隔壁的灰色背景"。
 *   有 view 时读 `getBounds().width`（真值）；还没有 view（服务正在启动）时按同一公式回退，
 *   否则会发 0 ⇒ 页面完全不让位 ⇒ 工具栏被盖住（那就是上一个 bug 的症状）。 */
function notifyRenderer() {
  if (!state.win || state.win.isDestroyed()) return;
  // width = **页面要让出的总量**（控制栏 + 侧栏 + 停靠面板）。它的别名就是 CSS 变量
  // --dsh-sidebar-width：渲染层那 5 处消费者（#main margin / #toolbar padding / .overlay 与
  // #lightbox 的 right / .dialog-box 的 max-width）为一个数，所以面板一开它们**自动**正确。
  let width = occupiedWidth();
  if (!state.geometry && state.visible) {
    // 还没算过几何（服务启动早期）：按同一公式回退，别发 0（发 0 = 页面一点都不让 ⇒ 工具栏被盖住）
    try {
      const [w] = state.win.getContentSize();
      width = state.dshOnly ? w : Math.min(state.width, w);
    } catch (e) { width = state.width; }
  }
  state.win.webContents.send('dsh-sidebar:layout', {
    visible: !!state.visible,
    width: width,
    // 侧栏那条带自己的宽（渲染层的拖宽热区用它；用总量会把热区推到面板左缘 ✗）
    sidebarWidth: sidebarBandWidth()
  });
}

/** 页面加载完成后再补发一次布局。
 *
 * 为什么需要：`init(win)` 里那次 `notifyRenderer()` 发生在**页面还没加载完**的时候 ——
 * 渲染层的 `dsh-sidebar:layout` 订阅那时还不存在，消息直接丢掉。后果是渲染层不知道侧栏宽度：
 * `body` 上既没有 `dsh-sidebar-on` 类也没有 CSS 变量 ⇒ `calc(var(--dsh-sidebar-width) + 8px)`
 * 整条失效 ⇒ **工具栏右侧被原生侧栏盖住**，直到用户拖一下侧栏（拖宽才会再发一次事件）才恢复。
 * 用户实测症状正是"刚打开被遮住、稍微拖一下就好"。 */
function notifyAfterLoad() {
  if (!state.win || state.win.isDestroyed() || !state.win.webContents) return;
  state.win.webContents.on('did-finish-load', () => notifyRenderer(state.visible));
}

/** 原生侧栏 view 的**实际**几何（DIP）。诊断/断言用：
 *  "页面预留宽度 == 实际占宽"这条判据只靠 `status().width` 不够 —— width 是**意图**，
 *  bounds 才是真的画出来的东西；两者一旦不一致，页面就会多留（或少留）一条，
 *  用户看到的就是"侧栏隔壁的灰色背景"（实测就是这么发现的）。 */
function viewBounds() {
  try { return state.view ? state.view.getBounds() : null; } catch (e) { return null; }
}

/* ---------------- ③ 应用侧窄宽适配（不 fork DSH 本体） ----------------
 * 为什么在应用侧做：`vendor/dsh` 是**整体替换**的（升级即换包）⇒ 任何改本体的补丁都会丢 ✗；
 * 而 DSH Web UI 是按桌面宽度设计的，在 280–460px 的停靠宽度下会横向溢出。
 * 做法：给页面加 .dsh-narrow / .dsh-narrow-xs 两个类 + 注入**通用且安全**的规则
 * （允许收缩、防横向溢出），并把可视宽度写成 CSS 变量供 DSH/插件读取；
 * 全部挂在窄宽类下 ⇒ 宽屏时零影响 ✓；注入失败只记状态、不影响主流程 ✓。
 * 同时**量出是否真的溢出**并记在 status 里 —— 下一步改布局要靠这些数字，不能拍脑袋。 */
const NARROW_CSS = [
  "/* 应用侧窄宽适配（③）：允许收缩 + 防横向溢出；宽屏不生效 */",
  "html.dsh-narrow body{overflow-x:hidden}",
  "html.dsh-narrow *{min-width:0}",
  "html.dsh-narrow [class*=\"sidebar\"],html.dsh-narrow [class*=\"panel\"],html.dsh-narrow [class*=\"drawer\"]{max-width:100%}",
  "html.dsh-narrow-xs [class*=\"sidebar\"],html.dsh-narrow-xs [class*=\"drawer\"]{display:none!important}"
].join("\n");

let narrowTimer = null;
let narrowAttempt = 0;

/** 安排一次窄宽适配。**带有限重试**：
 *  真机实测踩到的坑 —— 一次性调用时页面往往还没到目标 URL（`getURL()` 还是空/状态页），
 *  函数直接早退，而状态里只留个 null，诊断只能说"尚未注入"、看不出卡在哪 ✗。
 *  现在：早退会记下**原因**（state.narrowSkip），并最多重试 12 次（每次 400ms）。 */
function scheduleNarrowAdaptation(reset) {
  if (reset) { narrowAttempt = 0; state.narrow = null; state.narrowSkip = null; }
  state.narrowDiag = state.narrowDiag || { relayout: 0, scheduled: 0 };
  state.narrowDiag.scheduled++;
  if (narrowTimer) clearTimeout(narrowTimer);
  narrowTimer = setTimeout(async () => {
    state.narrowDiag.ran = (state.narrowDiag.ran || 0) + 1;
    const done = await applyNarrowAdaptation().catch(() => 'threw');
    if (done !== true && narrowAttempt < 12) {
      narrowAttempt++;
      scheduleNarrowAdaptation(false);
    }
  }, narrowAttempt === 0 ? 150 : 400);
}

/** @returns {true} 已注入；否则返回"还要不要重试"（字符串原因写进 state.narrowSkip） */
async function applyNarrowAdaptation() {
  if (!state.view || !state.view.webContents) { state.narrowSkip = 'no-view'; return false; }
  if (!state.url) { state.narrowSkip = 'no-url（服务还没就绪）'; return false; }
  const wc = state.view.webContents;
  let cur = '';
  try { cur = wc.getURL(); } catch (e) { cur = ''; }
  // ⚠️ 只比 **origin + path**，不比 query：DSH 页面加载后会把地址栏里的 `?token=…` 抹掉
  //    （安全惯例），原先的"全等比较"因此永远判它不是目标页 ⇒ 注入一次都没跑过 ✗
  //    —— 真机就是靠 dsh-status 的"原因"字段一刀定位到这条的 ✓。
  const samePage = (a, b) => {
    if (!a || !b) return false;
    try {
      const ua = new URL(a); const ub = new URL(b);
      return ua.origin === ub.origin && ua.pathname === ub.pathname;
    } catch (e) { return a === b; }
  };
  if (!samePage(cur, state.url)) {
    // 诊断要能回答"差在哪"——把两边的 origin+path 都记下来（**不含 token** ✓）
    const brief = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return String(u || '空'); } };
    state.narrowSkip = '页面还不是目标 URL（当前 ' + brief(cur) + ' ≠ 目标 ' + brief(state.url) + '）';
    return false;
  }
  let viewW = 0;
  try { viewW = state.view.getBounds().width; } catch (e) { state.narrowSkip = 'getBounds 失败'; return false; }
  const mode = viewW < 340 ? 'xs' : (viewW < 460 ? 'narrow' : 'wide');
  try {
    await wc.insertCSS(NARROW_CSS);
    const info = await wc.executeJavaScript(
      '(function(){var d=document.documentElement;'
      + 'd.classList.toggle("dsh-narrow",' + (mode !== 'wide') + ');'
      + 'd.classList.toggle("dsh-narrow-xs",' + (mode === 'xs') + ');'
      + 'd.style.setProperty("--dsh-viewport-width","' + viewW + 'px");'
      + 'var sw=Math.max(d.scrollWidth,document.body?document.body.scrollWidth:0);'
      + 'return {pageViewportWidth:d.offsetWidth,innerWidth:window.innerWidth,scrollWidth:sw,'
      + 'overflow:sw>d.offsetWidth+1};'
      + '})()');
    /* ⚠️ 判据必须是**页面自己报的那条边**（`documentElement.offsetWidth`），不是 `getBounds()`：
     *   实测（2026-10-16）在离屏窗口里 `WebContentsView.setBounds()` 更新了 bounds、页面视口却
     *   纹丝不动（连续 6 次改宽全停在同一个旧值），而同一次运行里直调 `setBounds` 又能同步 ⇒
     *   "我们要求的边"与"用户看到的边"**不是一回事**。用户看到的是页面视口 ⇒ 宽度控制的判据用它，
     *   bounds 只作对照读数（`boundsWidth`）。两条边对不上就不做决定、如实记进 `note`
     *   （`rejectStaleMeasurement`）—— 绝不拿"要求的边"冒充"看到的边"去造一个看起来成功的空转 ✗。 */
    const pageNow = info ? info.pageViewportWidth : viewW;
    const mismatch = Math.abs(pageNow - viewW) > 2;
    state.narrow = { viewWidth: pageNow, boundsWidth: viewW, mode: mode, metrics: info,
      at: new Date().toISOString(), stale: mismatch };
    installRightbarWatcher().catch(() => {});
    state.narrowSkip = null;
    log('窄宽适配: ' + mode + '（页面视口 ' + pageNow + '（要求 ' + viewW + '）'
      + (mismatch ? ' ⚠ 不一致' : '') + '）'
      + (info ? '，内容 ' + info.scrollWidth
        + (info.overflow ? ' ⇒ **横向溢出**' : ' ⇒ 不溢出') : ''));
    /* ★ 实测 → 宽度 这条闭环的**唯一接缝**（测量驱动的细档）：
     *   上面那个 `overflow` 是本模块早就采到、却一直只进诊断的读数；从本批起它**接回宽度控制**
     *   —— 右栏开着时由 `reviseWidthBudget()` 按它决定是否继续加宽，到上界仍溢出就上报
     *   （`contentBudget.overflowAtCeiling`）。
     * ⚠️ 为什么放在这里而不是 `relayout()`：relayout 在"加宽自己"与"拖宽每一帧"上都会触发，
     *   在那里重试就是自激环（加宽 ⇒ 重排 ⇒ 又溢出 ⇒ 再加宽 ✗）。测量回调天然只在**测完之后**跑。
     * 不 await：这一步不该拖住注入本身（失败只记状态、不阻断主流程 ✓ 见本函数上方纪律）。 */
    reviseWidthBudget(info && info.overflow ? 'narrow-overflow' : 'narrow-fits',
      info ? { pageViewportWidth: pageNow, innerWidth: info.innerWidth, wantView: viewW }
        : { pageViewportWidth: -1, innerWidth: -1, wantView: viewW });
    return true;
  } catch (e) {
    // 注入失败不阻断主流程，但要**留下原因**（诊断里能看见，不要静默 ✗）
    state.narrow = { viewWidth: viewW, mode: mode, err: String(e && e.message) };
    state.narrowSkip = '注入失败: ' + String(e && e.message);
    return true;
  }
}

/* 把「侧栏状态」推给渲染层（`renderer/app-core.js` 的 `dsh-sidebar:status` 订阅）。
 *
 * ⚠️ **它是本文件内的函数声明，不是外部注入的**（本轮核实项，结论：**不是 bug**）——
 *   定义就在下面（`main-dsh-sidebar.js:1220` 一带），而调用点**在它上面**（从 188 起共 14 处）。
 *   这靠的是**函数声明提升**（function declaration hoisting）：同一模块作用域内的
 *   `function foo(){}` 在进入模块时就已绑定，故上面的调用点照样能调到 ✓。
 *   之所以值得写这一行：`grep -n 'function broadcastStatus'` 的输出一旦被截断
 *   （前十几行全是调用点，定义在 1200 行开外），非常容易得出"它没有定义"的错误结论，
 *   然后去查一个**不存在**的 `ReferenceError`。调用链上的运行时证据见
 *   `scripts/smoke/11-dsh-sidebar.js` 的「状态广播真能送达渲染层」一条。
 *
 * 副作用恒定（不抛异常）也是刻意的：`state.win` 还没接上（init 之前）时是**空操作**，
 * 不是错误 —— 启动早期有多条路径会走到这里，为此报错会把启动打断 ✗ */
function broadcastStatus() {
  if (state.win && !state.win.isDestroyed()) {
    state.win.webContents.send('dsh-sidebar:status', getStatus());
  }
}

/* ---------------- 偏好持久化（可见性 + 宽度，跨重启恢复） ---------------- */

function prefsFile() { return path.join(userDataPath(), 'dsh-sidebar-prefs.json'); }

function loadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    if (typeof p.width === 'number') state.width = clampWidth(p.width);
    // 导图页最后打开的项目（关页时记下、重开时回到同一个；没记过就是 null ⇒ 按默认第一个 ✓）
    if (typeof p.lastProject === 'string' && p.lastProject) state.lastProject = p.lastProject;
    // 可见性**不跨启动记忆**（用户语义：每次启动默认打开；折叠只是当次会话状态）
    state.visible = true;
  } catch (e) {
    state.visible = true; // 默认打开
  }
}

function savePrefs() {
  try {
    // 只存宽度与"导图页上次的项目"；visible 是会话状态，不持久化（启动永远默认打开）。
    // ⚠️ 导图页**关闭**这个状态也**不**持久化：重启应用后导图页照常在（与从前一致 ✓，
    //    用户要的是"关掉之后内存里不留"，不是"关掉之后永远不要"）。
    fs.writeFileSync(prefsFile(), JSON.stringify({
      width: state.width,
      lastProject: state.lastProject || null
    }, null, 2) + '\n', 'utf8');
  } catch (e) { /* 非致命 */ }
}

/** 应用退出（v0.16.6 驻留语义）：**不收割已就绪的服务**。
 *
 *  契约（README「服务驻留独立于主界面」）：重启/升级主界面时侧栏对话不中断 ——
 *  要实现它，退出路径就不能杀掉服务：
 *   · 服务 detached + stdio 落文件（无 EPIPE）→ 主界面退出后继续活着；
 *   · `dsh-service.json` 保留 → 下次启动 adoptExistingService() 直接接管（无需冷启动）；
 *   · 运行锁 pid 已改指服务（retargetRuntimeLock）→ 锁随服务生死，维护互斥仍成立。
 *
 *  唯一例外：服务**尚未就绪**（还在启动 / 启动超时）时退出 —— 此时没有对话可保，
 *  且半启动进程会占住运行锁让下次启动既接管不了也孵化不了，故照旧收割。
 *
 *  想彻底停掉驻留进程：菜单「视图 → 停止 DSH 服务」。 */
function destroy() {
  state.shuttingDown = true;
  endWidthDrag();
  fireHide('app-destroy');   // 防孤儿：应用退出前一定收掉（它挂在窗口客户区上，窗口没了就是残留引用）
  if (state.panelView) destroyPanel('应用退出');
  if (state.logTimer) { clearTimeout(state.logTimer); state.logTimer = null; }
  if (state.healthTimer) { clearInterval(state.healthTimer); state.healthTimer = null; }
  if (state.startTimer) { clearInterval(state.startTimer); clearTimeout(state.startTimer); state.startTimer = null; }
  const resident = state.status === 'running' && !!state.url && !!state.servicePid;
  if (resident) {
    // 凭据已在盘上（probeThenLoad 写过）；这里再写一次保证 pid/url 成对且最新
    writeServiceInfo(state.servicePid, state.url);
    log('主界面退出：服务驻留 pid=' + state.servicePid + '（不收割，下次启动接管；'
      + '如需彻底停止用菜单「停止 DSH 服务」）');
    state.proc = null;      // 断开本进程引用，但**不** taskkill
    state.procLock = null;  // 锁留给服务（pid=服务 pid），不 release
  } else if (state.proc) {
    log('主界面退出：服务尚未就绪 → 收割，避免半启动进程占住运行锁');
    stopService();
  } else if (state.procLock) {
    try { state.procLock.release(); } catch (e) { /* ignore */ }
    state.procLock = null;
  }
}

/** 重启服务（菜单入口）：无论孵化还是接管，都完整收割旧服务并重新孵化。
 *  驻留语义下"重启"是显式动作 —— 用户主动要求才杀服务。 */
function restartService() {
  log('菜单请求：重启 DSH 服务');
  stopService();
  state.shuttingDown = false; // stopService 不改它，这里显式复位
  startService();
  if (state.visible && state.view) showStatusPage(PAGE_STARTING);
}

/* ---------------- 仅侧边栏模式（v0.16.5；本版语义升级为**真卸载**） ----------------
 * 用途：外部 AI 迭代主界面代码时，导图页面先下线、DSH 侧边栏继续可用。
 *  · 进入（`closeMapPage()`）：导图页**被卸载**（主窗口导航到占位页）+ 侧栏占满全窗；
 *    弃用的旧语义是"给 body 加 dsh-only ⇒ `#main` 仍 display:none 地活着" ✗（内存没释放）；
 *    此时侧栏「—」= 窗口最小化到任务栏（任务栏图标可复原）；
 *  · 关窗语义：dsh-only 下点 ✕ 不退出应用 —— 隐藏到托盘式后台
 *    （窗口保留、服务驻留），任务栏图标可复原；再次进入 dsh-only 关窗同前；
 *  · 退出（`openMapPage()`）：**重新加载**导图页 + 还原停靠宽度 + 回到上次的项目。
 * 服务生命周期在本模式下完全不变（驻留语义照旧）。 */

function setDshOnly(on) {
  state.dshOnly = !!on;
  if (state.win && !state.win.isDestroyed()) {
    // 仅侧栏模式下**连菜单栏一起隐掉**（用户要求："原本的 aimindmap 菜单栏也一并关闭"）；
    // 恢复时再装回来 —— 否则菜单栏会一直空着一条横条。
    try {
      state.win.setMenuBarVisibility(!state.dshOnly);
      state.win.setAutoHideMenuBar(state.dshOnly);
    } catch (e) { /* ignore */ }
    state.win.webContents.send('dsh-sidebar:dsh-only', state.dshOnly);
    // 侧栏铺满：dsh-only 下让位宽度 = 全窗
    notifyRenderer(state.visible);
    relayout();
  }
  refreshRail();   // 控制栏里「—」的字形/语义换成"恢复思维导图页"
  log('dsh-only 模式: ' + state.dshOnly);
  broadcastStatus();
}

function isDshOnly() { return state.dshOnly; }

/* ---------------- 导图页「真关」（关 = 从内存里卸掉，不是藏起来） ----------------
 * 用户语义（README「只改一边，不用全部重启」）：导图页右上角那个 ✕ 要**真的把这一页关掉**。
 * 关键认知：导图页**不是独立窗口**，它就是主窗口的渲染层 ⇒「真关」只有一条路：
 *   把这一页从内存里卸掉（主窗口导航到占位页 renderer/map-closed.html）
 *   —— 旧实现只给它加 `body.dsh-only`（`#main` 仍 `display:none` 地活着）✗，DOM/JS 堆全在。
 *
 * 两条入口，**语义必须一致**（都是"卸载导图页"）：
 *   · 人类：工具栏 ✕ / 菜单「关闭思维导图页」⇒ 渲染层先拦未保存编辑（弹「保存后关闭 / 取消」，
 *     复用既有脏标记与保存路径与冲突保护 ✓）⇒ 保存成功才调 `closeMapPage({confirmed:true})`；
 *   · AI：`node cli/mm-cli.js sidebar-only on` ⇒ 走控制通道直接到这里 ⇒ 这里自己查一次脏
 *     （**不弹模态框**：AI 调用时没人保证有人在看，弹窗会把 CLI 挂死 ✗），脏就**如实拒绝** ✓。
 *   ⚠️ 控制通道的轮询在**主进程**（main.js 的 startControlChannel）⇒ 导图页卸载期间它照样在跑 ✓
 *      （`dsh-status` / `dsh-prefill` / `dsh-sidebar` 都不受影响 —— 它们要的是侧栏，不是导图页）。
 *      唯一受影响的是"发往导图页渲染层"的东西：菜单里那批 `menu:*` 项会**置灰**（main.js 负责）✓
 *      —— 否则点下去就是发进空页、毫无反应 ✗（正是这一轮要消灭的那类"没反应"）。 */

/** 导图页被卸载期间，主窗口显示的那一页（占位页；写清"已关闭 + 怎么回来"，别留一片白 ✗） */
function mapClosedPage() { return path.join(__dirname, 'renderer', 'map-closed.html'); }

/** 问渲染层"有没有未保存编辑"。三态：true / false / null（**取不到**）。
 *  取不到一律当"不知道" ⇒ 调用方必须拒绝卸载：**采不到真值 ≠ 通过**（本工程最忌静默）。 */
async function rendererDirty() {
  if (!state.win || state.win.isDestroyed() || !state.win.webContents) return null;
  try {
    const r = await Promise.race([
      state.win.webContents.executeJavaScript(
        '(function(){try{return (window.MMApp&&window.MMApp.isDirty)?!!window.MMApp.isDirty():null;}catch(e){return null;}})()'),
      new Promise((res) => setTimeout(() => res('__timeout__'), 3000))
    ]);
    if (r === true || r === false) return r;
    return null;   // 超时 / 没有 MMApp（占位页、页面没加载完）⇒ 如实报"不知道"
  } catch (e) { return null; }
}

/** 关导图页（**真卸载**）。opts.confirmed=true 表示渲染层已经问过用户、（必要时）保存完了。
 *  @returns {{ok:boolean, closed?:boolean, already?:boolean, reason?:string, project?:string|null, dockWidth?:number}} */
async function closeMapPage(opts) {
  const o = opts || {};
  if (state.mapPageClosed) return { ok: true, already: true, project: state.lastProject };
  if (!state.win || state.win.isDestroyed()) return { ok: false, reason: '主窗口不可用，无法卸载导图页' };
  if (!o.confirmed) {
    const dirty = await rendererDirty();
    if (dirty === true) {
      return { ok: false,
        reason: '导图页有未保存的编辑 ⇒ 拒绝卸载（AI 这条路不弹模态框，避免把调用方挂死）。'
          + '请先保存，或让用户点导图页右上角的 ✕ —— 那条路会先弹「保存后关闭 / 取消」' };
    }
    if (dirty === null) {
      return { ok: false,
        reason: '取不到导图页的未保存状态（页面没加载完 / 没有 MMApp）⇒ 拒绝卸载'
          + '（不能在"不知情"的情况下把可能带脏改动的一页卸掉）' };
    }
  }
  state.dockWidth = state.width;         // 重开要还原的停靠宽度
  state.mapPageClosed = true;
  savePrefs();                           // 落盘：停靠宽度 + 上次项目（崩溃后也查得到）
  setDshOnly(true);
  try {
    await state.win.loadFile(mapClosedPage());
  } catch (e) {
    // 连占位页都加载不出来 ⇒ **回滚**成"导图页还在"，绝不把窗口留在空白页上 ✗
    state.mapPageClosed = false;
    setDshOnly(false);
    try { await state.win.loadFile(path.join(__dirname, 'renderer', 'index.html')); } catch (e2) { /* 已尽力 */ }
    return { ok: false, reason: '占位页加载失败（已回滚成导图页）：' + ((e && e.message) || e) };
  }
  log('导图页已**卸载**（真关）：主窗口现在是占位页；停靠宽度记下 ' + state.dockWidth + 'px、项目记下 '
    + (state.lastProject || '（未知）') + ' —— 重开时按这两项还原 ✓');
  notifyMapPageChanged();
  broadcastStatus();
  return { ok: true, closed: true, project: state.lastProject, dockWidth: state.dockWidth };
}

/** 重开导图页（**重新加载**这一页，不是把隐藏的恢复显示）。
 *  三件事一起做：还原停靠宽度（`dockWidth`）· 回到上次的项目（`bootProject` ⇒ 页面 boot 时问一次）
 *  · 退出仅侧栏模式（菜单栏装回来）。@returns {{ok:boolean, reopened?:boolean, reason?:string}} */
async function openMapPage() {
  if (!state.mapPageClosed) return { ok: true, already: true };
  if (!state.win || state.win.isDestroyed()) return { ok: false, reason: '主窗口不可用，无法重新加载导图页' };
  state.mapPageClosed = false;
  state.bootProject = state.lastProject || null;   // 一次性：本次页面加载该开哪个项目
  setDshOnly(false);
  if (typeof state.dockWidth === 'number') setWidth(state.dockWidth);   // 还原停靠宽度
  try {
    await state.win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  } catch (e) {
    return { ok: false, reason: '导图页加载失败：' + ((e && e.message) || e) };
  }
  log('导图页已重新加载（项目 ' + (state.bootProject || '（未记 ⇒ 按默认第一个）')
    + '，停靠宽度 ' + state.width + 'px）');
  notifyMapPageChanged();
  broadcastStatus();
  return { ok: true, reopened: true, project: state.bootProject, dockWidth: state.width };
}

/** 导图页当前打开的项目名（main.js 的 project:read 里调 ⇒ 关页/重开都靠它回到同一个项目）。
 *  `null` 也是合法值（还没打开任何项目）—— 不静默编一个默认值 ✗ */
function setCurrentProject(name) {
  const n = (typeof name === 'string' && name) ? name : null;
  if (n === state.lastProject) return;
  state.lastProject = n;
  savePrefs();
}

/** 页面 boot 时问一次"我该打开哪个项目"（只有 openMapPage() 会武装它 ⇒ 正常启动返回 null，
 *  启动行为与从前一致：仍然开 projects[0] ✓） */
function bootProject() { return state.bootProject; }

/* 「导图页在/不在」的变更通知（唯一订阅者：main.js 用它把发往渲染层的菜单项置灰/恢复）。
 * 为什么用回调而不是让 main.js 自己到处调：关闭入口有三个（工具栏 ✕ / 菜单 / 侧栏控制栏「⤢」）
 * 加一条 CLI —— 分散去调必然漏一处，而漏一处的症状正是"点了没反应" ✗（本模块自己发通知最稳）。*/
let mapPageListener = null;
function setMapPageListener(fn) { mapPageListener = (typeof fn === 'function') ? fn : null; }
function notifyMapPageChanged() {
  try { if (mapPageListener) mapPageListener(!!state.mapPageClosed); }
  catch (e) { log('导图页状态通知失败: ' + ((e && e.message) || e)); }
}

/** dsh-only 下主窗口被要求关闭 → 隐藏到后台（不退出应用、服务不动）。 */
function hideWindowToBackground() {
  if (!state.dshOnly) return false; // 非本模式不做拦截（正常退出）
  if (state.win && !state.win.isDestroyed()) state.win.hide();
  return true;
}

/** 关主窗口 = **藏到后台**（不动侧栏 view、不动 DSH 服务）：侧栏对话保活是产品语义。
 *  真正的退出走「文件 → 退出 / Ctrl+Q」（main.js 用 `quitting` 标志放行 close）。 */
function hideToBackground() {
  if (state.win && !state.win.isDestroyed()) state.win.hide();
  return true;
}

/** 侧栏 view **自身**的截图（整窗合成用）。
 *  为什么需要：侧栏是原生 `WebContentsView`，主页面 `capturePage()` 里根本没有它 ✗，
 *  想得到"能看到侧栏的图"只能单独截它、再按 `viewBounds()` 贴回主图（见 scripts/vision/window-shot.js）。 */
async function captureView() {
  if (!state.view || !state.view.webContents) return null;
  try { return await state.view.webContents.capturePage(); } catch (e) { return null; }
}

/** 从后台恢复窗口（任务栏/再次启动时调）。 */
function restoreWindow() {
  if (!state.win || state.win.isDestroyed()) return;
  if (state.win.isMinimized()) state.win.restore();
  state.win.show();
  state.win.focus();
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 「拖节点 ⇒ 一块（真 chip）」的**唯一一条通道**（2026-10-41 批）
 * ──────────────────────────────────────────────────────────────────────────────
 * 用户第三轮原话（逐字）：「现在虽然不重复但是没有像我想的 cursor 那样是一"块"东西。
 *   包括一次复制很多文本进对话框，cursor 的处理也是一块东西，能不能给内置 dsh 也加上这个」
 *
 * ── 为什么这件事**只能**由客户端插件做（不是我们不肯写）────────────────────────
 *   真 chip 是 Lexical 的 `ReferenceChipNode`（原子 decorator，`{source,ref,label,appearance,clipboardText}`）。
 *   它只能由**已注册的 inputTriggers source** 的插入通道创建，而插入动词（`insertReference` /
 *   `addFiles` / `setDraft`）长在 `SessionInput` 上，`SessionInput` 只能从 **session 作用域的 cordis ctx** 取：
 *       const actx = ctx.sessions.scope(sessionId);        // ISessions.scope（公开面）
 *       const input = ctx.conversation.input.for(actx);    // SessionInputResolver.for（契约面）
 *   页面侧 `executeJavaScript` **拿不到**那个 ctx（web boot 只把 `__DSH_BOOT__` / `__ModuleLoader__` /
 *   `__DSH_TRANSPORT__` 放 global）⇒ 必须给内置实例投一个**客户端 cordis 插件**。
 *   §一 的逐行取证见 `.review/20261041-真chip/收口报告.md`（读完剩下的就是这一条结论）。
 *
 * ── 通道形态：**一个页面全局句柄**（不做轮询、不做 ack 协议）────────────────────
 *   插件在 `apply()` 里把 `globalThis.__AIMM_CHIP_INSERT__` 装成一个函数（载荷见 src/dsh-chip-feed.js）。
 *   主进程这一侧只做一件事：`executeJavaScript` 去**调它**。
 *   ⇒ 「插件在不在位」= 那个全局是不是函数 ⇒ **一次同步判定**，没有"等多久算超时"的猜测。
 *   ⇒ 插件不在位 ⇒ 立刻退回**纯文本**路径（`COMPOSER_PREFILL_JS`，一行没改）并让 `chipMode:'text'` 可见。
 *      **降级必须可见**：静默什么都不做是本批明令禁止的失败形态。
 *
 * ── ⚠️ 死 chip 红线（载荷里也写了一遍，`src/dsh-chip-feed.js` 与单测都钉着）────────
 *   提交时每个 chip 走 `serializeReference(source, ref)`；source 未注册/无 codec ⇒ **reject**，
 *   而失败分支 = **整条发送被拒**（不会退化成文本）⇒ 编一个 source 名 = 用户按发送才炸的死 chip。
 *   **只许用内置 `reference`**（它的 codec 是恒等函数 ⇒ 模型收到的就是 ref 本身）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 页面侧那一小段：取句柄 → 调它 → 把结果**序列化成 JSON 字符串**回来。
 *  为什么要序列化：`executeJavaScript` 的返回值要跨进程复制，字符串最不容易出岔子；
 *  并且"抛异常"也要变成一个**结构化失败**（不许变成静默的 undefined）。
 *  ⚠️ 句柄名**从这里插进去**（`${chipFeed.HANDLE}`）—— 不在第二个地方再写一遍字符串
 *     （"同一件事两处表达"正是本工程反复治过的病：改一处漏一处，插件与注入悄悄对不上）。 */
const CHIP_INSERT_JS = `(function (payloadJson) {
  var g = (typeof globalThis !== 'undefined') ? globalThis : null;
  var h = g ? g.${chipFeed.HANDLE} : null;
  if (typeof h !== 'function') return JSON.stringify({ ok: false, reason: 'plugin-absent' });
  var payload;
  try { payload = JSON.parse(String(payloadJson)); }
  catch (e) { return JSON.stringify({ ok: false, reason: 'bad-payload' }); }
  var done = function (r) {
    try { return JSON.stringify(r || { ok: false, reason: 'empty-result' }); }
    catch (e2) { return JSON.stringify({ ok: false, reason: 'unserializable-result' }); }
  };
  try {
    var out = h(payload);
    if (out && typeof out.then === 'function') {
      return out.then(done, function (e) { return JSON.stringify({ ok: false, reason: 'threw: ' + ((e && e.message) || e) }); });
    }
    return done(out);
  } catch (e3) {
    return JSON.stringify({ ok: false, reason: 'threw: ' + ((e3 && e3.message) || e3) });
  }
})`;

/* ── 投喂台账：`seq` 幂等的**唯一**依据（本文件里只有这一份实现）─────────────────────
 * 用户真机 2026-10-42（逐字）：「是块了，但是我先拉了两个过去，然后又选了两个过去，就会覆盖掉
 *   第一次的两个」⇒ 要的是**追加**；而"同一次投喂被重试"又不许变成两遍（= 幂等）。
 * ⇒ 幂等的正确含义是"同一 seq 只生效一次"，**不是**"清空重来"（上一版就是拿 `setDraft('')`
 *   换幂等 —— 那正是覆盖的病根：两件事被混成了一件）。
 * 两个入口都要过这一道：`prefillComposer` 在**碰页面之前**短路（重试连 chip 都不试）；
 *   `prefillComposerTextPath` 是兜底入口（冒烟与桩脚本会直接调它）⇒ 它自己也得判一次，
 *   否则"重试"就变成两次追加。
 * 上界 FIFO 淘汰：为什么不用"高水位 seq > lastSeq"见 state.feedLedger 的注释（seq 不保证单调）。 */
const FEED_LEDGER_MAX = 64;
function feedSeqNext() { state.feedSeqNo += 1; return state.feedSeqNo; }
/* ── 2026-10-70 收口：调用方给的**身份**必须能落成 seq ────────────────────────────────
 * 缺陷（代码可证，不是猜）：台账幂等早就实现了，而这里的注释写着"只有调用方没给 seq 时才发号"，
 *   可**调用方从来没给过**（`main.js` 的两个入口都是 `prefillComposer(text)`）⇒ 每次重试都由
 *   本模块发新号 ⇒ 同一条命令被派发两次就插两遍。
 * 陷阱（本文件实测口径）：控制通道那条命令的身份是**字符串 token**，而 seq 的合法域是
 *   有限正整数（`feedLedgerGet` 按 `===` 认）⇒ 把 token 直接当 seq 传会被判非法、**静默退回
 *   发新号**：接线看起来接上了，去重一次都没生效。
 * 所以 seq 的换算收成这一处（三档优先级），token 走一张**恒等映射**：
 *   · 同一个 token ⇒ 永远同一个号（重试被台账吞掉）；
 *   · 不同 token ⇒ 一定不同号（两条命令各追加一次，不会被"永远只认第一个"）。
 * 为什么不用"哈希取模"把 token 折成数字：哈希会碰撞，而碰撞的表现是**一条合法投喂被静默吞掉**
 *   —— 那正是 `state.feedLedger` 注释里点名不许发生的事（集合只许吞同一个 seq，永不吞别的）。
 */
const FEED_SEQ_TOKENS_MAX = 64;
function feedSeqByToken(token) {
  const tok = String(token);
  if (!(state.feedSeqByToken instanceof Map)) state.feedSeqByToken = new Map();
  const known = state.feedSeqByToken.get(tok);
  if (known) return known;
  const fresh = feedSeqNext();
  state.feedSeqByToken.set(tok, fresh);
  // FIFO 上界：与台账同一个量级（老的 token 早有回执了，留着只会长内存）
  while (state.feedSeqByToken.size > FEED_SEQ_TOKENS_MAX) {
    state.feedSeqByToken.delete(state.feedSeqByToken.keys().next().value);
  }
  return fresh;
}
/** 取这次投喂的 seq。三档，优先级从高到低：
 *  ① `opts.seq` —— 调用方自己给的有限正整数（最明确的身份；重试/重放**沿用同一个**）；
 *  ② `opts.token` —— 命令身份（字符串）⇒ 经恒等映射换成同一个号（见上面那张映射的说明）；
 *  ③ 都没有 ⇒ 本模块发新号（界面点一次 = 一次新意图）。
 *  ⚠️ 三档都只返回**有限正整数**：`feedLedgerGet` 是按 `===` 认的，类型一旦漂了就永远不命中。 */
function feedSeqFor(opts) {
  const s = Number(opts && opts.seq);
  if (Number.isFinite(s) && s > 0) return Math.floor(s);
  const tok = (opts && typeof opts.token === 'string') ? opts.token : '';
  if (tok) return feedSeqByToken(tok);
  return feedSeqNext();
}
function feedLedgerGet(seq) {
  const l = Array.isArray(state.feedLedger) ? state.feedLedger : [];
  for (const e of l) if (e.seq === seq) return e;
  return null;
}
/** 记账：`n` = 这一批**真的落了**几个块（失败但落了几个也要记 —— 否则重试会再插一遍）。 */
function feedLedgerMark(seq, n, mode, route) {
  if (!Array.isArray(state.feedLedger)) state.feedLedger = [];
  if (feedLedgerGet(seq)) return state.feedLedger;
  state.feedLedger.push({ seq: seq, n: Number(n) || 0, mode: mode || null, route: route || null, at: Date.now() });
  while (state.feedLedger.length > FEED_LEDGER_MAX) state.feedLedger.shift();
  return state.feedLedger;
}
/** 已应用批次的**累计节点数**（判据侧的独立读数：页面上的块数不该比它少）。 */
function feedLedgerTotal() {
  const l = Array.isArray(state.feedLedger) ? state.feedLedger : [];
  return l.reduce((s, e) => s + (Number(e.n) || 0), 0);
}
function feedLedgerView() {
  const l = Array.isArray(state.feedLedger) ? state.feedLedger : [];
  return { seqs: l.map((e) => e.seq), total: feedLedgerTotal(), max: FEED_LEDGER_MAX };
}

/** 这段文案该不该走 chip（判定在 `src/dsh-chip-feed.js` 的纯函数里，那是**唯一一份**规则）。
 *  ⚠️ **插入前**的第一道死 chip 闸：`chipFeed.SOURCE` 必须仍是内置 `reference`。
 *     为什么把这条放在"发请求之前"而不是等回执：一旦有人把常量改成假 source，
 *     插进去的 chip 在提交时才会被 `serializeReference` 拒（整条发送被拒、不会退化成文本）
 *     ⇒ 那种 chip 一旦落进输入框就是**用户按发送才炸**的死 chip。宁可**连试都不试**，
 *     直接走纯文本（纯文本至少发得出去）。这一条有单测与冒烟两侧钉着。
 *  ⚠️ `seq` 是**必填**（2026-10-42）：没有它就没有"同一次投喂只生效一次"的依据 ⇒ 不许走 chip
 *     （返回 null 让调用方降级成纯文本，并把原因 `no-seq` 记进 lastPrefill —— 降级必须可见）。 */
function chipPayloadFor(text, seq) {
  if (chipFeed.SOURCE !== 'reference') return null;   // 死 chip 红线：常量被改成假 source ⇒ 不许进输入框
  const s = Number(seq);
  if (!Number.isFinite(s) || s <= 0) return null;     // 没有 seq ⇒ 幂等无从成立 ⇒ 不走 chip
  const units = chipFeed.chipUnitsFromText(text);
  if (!units) return null;
  return { v: 2, seq: Math.floor(s), items: units.items };
}

/**
 * 试一次 chip 通道。**任何**不成立（插件不在位 / 插件报失败 / 回执形状不对 / 超时 / 页面没就绪）
 * 都只是 `{ok:false, reason}` —— 由调用方降级成纯文本，绝不阻断投喂。
 * @param {string} body 要投喂的整段文案
 * @param {number} seq 这次投喂的序号（幂等依据）
 * @returns {Promise<{ok:boolean, reason:(string|null), occurrences:number, route:(string|null),
 *                    items:number, pluginPresent:boolean, already:boolean, added:number, seq:number}>}
 */
function tryChipInsert(body, seq) {
  const s = Number(seq);
  const miss = (reason, extra) => Object.assign({
    ok: false, reason: reason, occurrences: 0, route: null, items: 0,
    pluginPresent: reason !== 'plugin-absent', already: false, added: 0,
    seq: (Number.isFinite(s) && s > 0) ? Math.floor(s) : null
  }, extra || {});
  if (!Number.isFinite(s) || s <= 0) return Promise.resolve(miss('no-seq'));
  const payload = chipPayloadFor(body, s);
  if (!payload) return Promise.resolve(miss('not-chip-shaped'));
  if (!state.view || !state.view.webContents) return Promise.resolve(miss('no-view', { items: payload.items.length }));
  if (state.view.isDestroyed && state.view.isDestroyed()) return Promise.resolve(miss('view-destroyed', { items: payload.items.length }));
  if (state.view.webContents.isDestroyed && state.view.webContents.isDestroyed()) {
    return Promise.resolve(miss('view-destroyed', { items: payload.items.length }));
  }
  const payloadJson = JSON.stringify(payload);
  const code = '(' + CHIP_INSERT_JS + ')(' + JSON.stringify(payloadJson) + ')';
  /* 超时保护与文本路径同源（内核页面加载中时 executeJavaScript 可能永不返回 ✗ —— 本模块踩过两次）。
   * 这里给 4s：chip 通道是**增强**，不该让"投喂"多等太久；等不到就当插件不在位、走文本。
   * ⚠️ 超时**不代表没插进去**（页面可能只是回执慢）⇒ 那一档下面用 `probeChipApplied` 再问一句，
   *    确认落过就**绝不**降级写文本（否则同一批投喂变两遍）。 */
  let settled = false;
  const timeout = new Promise((resolve) => setTimeout(() => {
    if (!settled) resolve({ ok: false, reason: 'chip-timeout' });
  }, 4000));
  const run = Promise.resolve()
    .then(() => state.view.webContents.executeJavaScript(code, true))
    .then((raw) => {
      settled = true;
      try { return JSON.parse(String(raw)); }
      catch (e) { return { ok: false, reason: 'unparsable: ' + String(raw).slice(0, 80) }; }
    })
    .catch((e) => { settled = true; return { ok: false, reason: 'threw: ' + ((e && e.message) || String(e)) }; });
  return Promise.race([run, timeout]).then((r) => {
    /* `minBefore` = 台账里已经投喂过的累计块数：一条**单向**硬闸（页面比台账少 ⇒ 之前的块被清掉了）。 */
    const judged = chipFeed.judgeInsertResult(r, payload.items, { minBefore: feedLedgerTotal() });
    const out = {
      ok: judged.ok === true,
      reason: judged.ok ? null : judged.reason,
      occurrences: Array.isArray(judged.occurrences) ? judged.occurrences.length : 0,
      route: (r && typeof r.route === 'string' && r.route) ? r.route : null,
      items: payload.items.length,
      pluginPresent: !(r && r.reason === 'plugin-absent'),
      already: judged.already === true,
      added: Number(judged.added) || 0,
      landed: judged.ok === true ? payload.items.length : (Number(judged.added) || 0),
      recovered: null,
      seq: payload.seq,
      caret: (r && typeof r.caret === 'string') ? r.caret : null
    };
    if (out.ok) return out;
    /* ── 超时 / 抛错 / 回执不可解析 ⇒ **先问一句"到底落没落"**，再决定要不要写文本 ──────────
     * 这是"同一批投喂绝不变两遍"的关键一步：`executeJavaScript` 超时**不代表**页面没执行
     * （内核页面加载时会迟迟不回）。落过 ⇒ 当成功（already），绝不降级写文本；没落 ⇒ 照常降级。 */
    const ambiguous = ['chip-timeout', 'threw', 'unparsable'].some((k) => String(out.reason || '').indexOf(k) === 0);
    if (!ambiguous) return out;
    return probeChipApplied(payload.seq).then((p) => {
      if (p && p.applied === true) {
        return Object.assign({}, out, {
          ok: true, already: true, reason: null, recovered: 'probe-applied',
          landed: payload.items.length, occurrences: p.occurrences, route: 'probe'
        });
      }
      return Object.assign({}, out, { recovered: 'probe-not-applied' });
    });
  });
}

/** 只读探针：问插件"这个 seq 应用过没有"（**一个字都不写**）。
 *  用在 chip 通道超时/抛错之后 —— 那一档分不清"页面没执行"与"执行了但回执慢"，
 *  而两种处置完全相反（后者若再写文本 = 同一批投喂两遍）。
 *  @param {number} seq
 *  @returns {Promise<{applied:boolean, occurrences:number}>} 探不到一律 `applied:false`（保守：宁可信没落）
 *     —— 但**不**静默：探针自身的失败原因会随 `recovered:'probe-…'` 一起进回执。 */
function probeChipApplied(seq) {
  const s = Number(seq);
  if (!Number.isFinite(s) || s <= 0) return Promise.resolve({ applied: false, occurrences: 0, reason: 'no-seq' });
  if (!state.view || !state.view.webContents
      || (state.view.webContents.isDestroyed && state.view.webContents.isDestroyed())) {
    return Promise.resolve({ applied: false, occurrences: 0, reason: 'no-view' });
  }
  const payload = { v: 2, seq: Math.floor(s), probe: true, items: [] };
  const code = '(' + CHIP_INSERT_JS + ')(' + JSON.stringify(JSON.stringify(payload)) + ')';
  let settled = false;
  const timeout = new Promise((resolve) => setTimeout(() => {
    if (!settled) resolve({ applied: false, occurrences: 0, reason: 'probe-timeout' });
  }, 1200));
  const run = Promise.resolve()
    .then(() => state.view.webContents.executeJavaScript(code, true))
    .then((raw) => {
      settled = true;
      let r = null;
      try { r = JSON.parse(String(raw)); } catch (e) { return { applied: false, occurrences: 0, reason: 'probe-unparsable' }; }
      const occ = Array.isArray(r && r.occurrences)
        ? r.occurrences.filter((o) => o && o.source === chipFeed.SOURCE).length : 0;
      return { applied: !!(r && r.ok === true && r.already === true), occurrences: occ, reason: null };
    })
    .catch((e) => { settled = true; return { applied: false, occurrences: 0, reason: 'probe-threw: ' + ((e && e.message) || String(e)) }; });
  return Promise.race([run, timeout]);
}

/** 插件载荷的**静态**在位读数（内容级，不读页面）。给 `dsh-status` 用；5s 缓存避免状态广播里反复读盘。 */
function chipFeedStatus() {
  const now = Date.now();
  if (state.chipFeedCache && (now - state.chipFeedCache.at) < 5000) return state.chipFeedCache.value;
  let v;
  try {
    const r = chipFeed.verify(dshHome());
    v = {
      plugin: chipFeed.PLUGIN_NAME, rowId: chipFeed.ROW_ID, source: chipFeed.SOURCE,
      installed: r.installed, payloadOk: r.payloadOk, bundlesEntry: r.bundlesEntry,
      drift: r.drift, missing: r.missing,
      // 「装了」≠「这次真的用上了」—— 后者看 lastPrefill.chipMode（每次投喂的现场读数）
      mode: (state.lastPrefill && state.lastPrefill.chipMode) || null
    };
  } catch (e) {
    v = { plugin: chipFeed.PLUGIN_NAME, rowId: chipFeed.ROW_ID, source: chipFeed.SOURCE,
      installed: false, payloadOk: false, bundlesEntry: false,
      drift: [], missing: [], mode: null, error: (e && e.message) || String(e) };
  }
  state.chipFeedCache = { at: now, value: v };
  return v;
}

/** ⑩「在侧边栏打开」：把一段文本**预填**进侧栏的输入框（不代替用户发送 ✗ —— 谁按发送谁负责 ✓）。
 *  内核事实（易腐，复核命令见 docs/DSH-EMBEDDED.md 的注入一节）：DSH 页面的输入框是
 *  `textarea` 或 `[contenteditable]`，用**内容特征 + 弱选择器**定位（4a ✓），不绑会被改名的类名 ✓。
 *  ⚠️ 与 installRightbarWatcher 同一个坑：`executeJavaScript` 可能**永不返回** ⇒ 必须超时 + 如实报错 ✓
 *
 *  ── 2026-10-38 第二轮真机反馈（逐字）：「不管是单选还是多选，都不能拖动到内置dsh的对话栏里，
 *     内置dsh的显示信息没有任何变化」⇒ 逐环查下来，前四环（渲染层 mouseup / droppable 闸 /
 *     24px 几何 / 主进程终点）都已被域 30 与域 33 的判据证明是通的，**断在第五、六环**（本函数）。
 *     两处**都会让"页面上什么都没发生"**，而且都不会报错给别人看：
 *       ① `offsetParent !== null` 这条"可见性"过滤是**错的**：`position:fixed` 的容器里
 *          `offsetParent` 恒为 `null`，而那种元素在屏幕上是**看得见**的 ⇒ 候选被全滤掉
 *          ⇒ 回「页面上找不到可见的输入框」。DSH 的对话栏正住在 fixed/absolute 的布局里。
 *       ② `el.value = text` 对 **React 受控组件**无效：React 在元素实例上挂了 value tracker，
 *          直接赋值会让它认定"值没变过"⇒ 随后的 `input` 事件被去重 ⇒ 组件状态没变
 *          ⇒ 看着有字、一起手就丢（或干脆不显示）。必须走**原型上的原生 setter**再派发 input。
 *     现在：可见性只认 `getBoundingClientRect()` + computed style（不认 offsetParent）；
 *     写法走原生 setter + `beforeinput/input/change`；**并且回读**（`ok` 只在回读等于原文时为真）
 *     + 回执里带**候选普查**（tag/尺寸），下次真机再出问题一行读数就能定位。
 *
 *  ── 2026-10-38 第三轮真机（用户给了**目标截图**）：「我说的是送进这个对话栏哦」───────
 *     截图里的目标是 **DSH Web 的对话输入框**：占位文字「描述你想要构建的内容，/ 调用指令，
 *     @ 文件或对话」，圆角浅灰大框，宽高比 ≈ 738:129 ≈ **5.7:1**，带「+」「全盘可写」与发送按钮。
 *     **带 `/` 指令与 `@` 提及的输入框是富文本编辑器**（几乎必然是 `contenteditable`），
 *     而我上一版"优先取面积最大的 textarea"抓到的**不是它**（普查里那个 584×120 的 TEXTAREA）。
 *     ⇒ 现在**按特征认，不按 tag 猜**（打分制，阈值 40）：
 *        · 必须**可见**（rect + computed style，不认 offsetParent）+ 必须是编辑面
 *          （`contenteditable` / `textarea` / `role=textbox`）—— 这是门槛，不是加分项；
 *        · `+60` 占位/`aria-label`/`data-placeholder`/`title` 里**同时**有 `/` 与 `@`（截图那一句就有）；
 *        · `+25` 文案里含 描述/构建/指令/提及/输入/提问/ask/describe/message/prompt；
 *        · `+20` 宽高比落在 3~12（"宽而扁"，截图 5.7）；
 *        · `+20` 是 `contenteditable`（富文本 ⇒ `/` 指令与 `@` 提及的宿主）；
 *        · `-25` 是 plain `textarea`（有富文本编辑器时让它让位）；`-20` 宽度 < 160；
 *        · `-100` 不可见 / 不是编辑面。
 *     写入**先 focus 再回读**，失败一律**分档**（`not-found` / `focus-failed` / `duplicated` /
 *     `readback-mismatch` / `rejected`），每档一句**可直接复制的中文原话**（用户能把状态栏那句贴回来）。
 *     **找不到目标就绝不退回去硬写别的框**（那正是上一版"送错了地方"的成因）。
 *     判据：`scripts/smoke/30-sidebar-drop.js` 的 N3-⑤⑥ 三格（A 只有目标 ⇒ 绿；B 目标 + 无关 textarea
 *     ⇒ 必须挑目标；C 只有无关 textarea ⇒ 必须 `not-found` 且一个字都不写进去）。
 *
 *  ── 2026-10-39 第四轮（**幂等**）：一次投喂恒等于一份 ─────────────────────────────
 *     用户真机看到「同一段模板在输入框里出现了多次」。可能有两种来源：**拖了多次**（每次追加）
 *     或**一次拖拽被写进多遍**。无论哪一种，产品这一侧能给出的最强保证是**替换语义**：
 *       · 旧写法是 insertText **在光标处插入** —— 空框 = 1 份，已有内容 = 追加 ⇒ 天然不幂等；
 *       · 现在写入前**先把选区铺满整个编辑器**（DOM Range，失败退 `execCommand('selectAll')`），
 *         再 insertText ⇒ 不管框里原来有几份，**写完只剩 1 份**；
 *       · 回读判据从"相等"再收紧成 **整段相等 且 份数 == 1**；多份单独一档 `duplicated`
 *         （原因里点名份数，**不静默**）；
 *       · 回执新增两个读数：`copies`（回读里有几份）、`selMode`（全选是 range / cmd / none 铺的）
 *         —— 真机再出问题，一行读数就能分"写歪了"与"插了多份"。
 *     判据：同文件的 N3-⑦（受控编辑器 + 框里已有同一段 ⇒ 写一次必须恰好剩 1 份）。
 *
 * ── 2026-10-40 第五轮（**@ 是触发符 · 换行要分段 · 幂等要真成立**）────────────────────
 *     用户真机截图（逐字）：2 个节点拖进去，框里变成 ——
 *       @book-80211-guide/@book-80211-guide/ 全书概览与使用说明
 *       @book-80211-guide/ 第一章 无线网络导论 @book-80211-guide/全书概览与使用说明
 *       @book-80211-guide/ 第一章 无线网络导论全书概览与使用说明 @book-80211-guide/第一章 无线网络导论
 *     = 前缀重复 + 两标题粘成一行（换行丢了）+ 整段叠三遍。而上一版在这里是**绿**的
 *     —— 因为假现场（plain contenteditable）验不出真 Lexical 怎么吃 `@` 与 `\n`。
 *     本轮三件事，各有判据（实现见下方 COMPOSER_PREFILL_JS 的文件头；
 *     取证与"哪些只能用户真机验"见 `.review/20261040-@触发与换行/`）：
 *       ① 文案里**一个 @ 都不留**（真源在 `src/sidebar-context.js`；本文件那条拒绝是第二道闸）；
 *       ② 写入改成**逐行 insertText + 行间 insertParagraph**；判据 = 回读行数 == 文案行数；
 *       ③ 清空改成 全选 → **等一帧**（Lexical 的模型选区是异步同步的）→ delete；
 *          判据 = `copies === 1` 且行数对，任何一项不成立一律 `ok:false`
 *          （新增一档 `mangled`：回读里冒出 @ / 行数不符 = 标题粘连）。 */
const COMPOSER_PREFILL_JS = `(async function (text) {
  /* ── 本注入串的契约（**2026-10-42 改成追加**；上一版是"替换"）───────────────────
   * 往 **Lexical 富文本 composer** 里**追加**"N 行纯文本"（原来框里有什么，一个字都不许动）。
   * 判据四句话（任何一条不成立 ⇒ ok:false + 分档 + 原因，**绝不静默成功**）：
   *   ① **前缀不许被动**：写前读到的内容必须原样是写后内容的**前缀**（prefixKept）
   *      —— 这一条就是"谁把全选+delete 加回来，判据当场红"的那一格（分档 clobbered）；
   *   ② **末尾恰好多了这一批**：写后内容减掉前缀（去掉分隔空白）= 这次的文案，逐字相等（addedOk）
   *      且**行数 == 文案行数**（addedLines；标题不许粘在一起）；
   *   ③ **同一批只应用一次**：全文里这份文案的出现次数 == 写前次数 **+ 1**（copiesBefore/copiesAfter）
   *      —— 这才是"幂等"的真身（旧口径 copies === 1 在追加语义下必然假红）；
   *   ④ 回读里没有冒出 @（出现了 = 被 composer 改写成引用实体）。
   *
   * ── 为什么"逐行 insertText + 行间 insertParagraph"，而不是一次 insertText ─────────
   *   Lexical 的 RangeSelection.insertText 把整串**原样塞进一个 TextNode**
   *   （vendor 只读源码：vendor/dsh/app/node_modules/@deepseek-ai/dsh-client-ui-conversation
   *     /lib/client.js 第 7042-7089 行；全程没有按换行分段。对照第 13236 setDraft 与第
   *     13382 restoreDraft 都是**显式** split ⇒ 分段只发生在显式 split 的地方）
   *   ⇒ 一次 insertText 里带换行 **不等于**分段：模型里仍是 1 段，回读行数对不上。
   *   而 inputType=insertParagraph 在 Lexical 里映到 INSERT_PARAGRAPH_COMMAND（第 5517 行）；
   *   inputType=insertText 且 data 恰为单个换行则映到 INSERT_LINE_BREAK（第 5492 行）
   *   ⇒ 后者是这个编辑器自带的兜底换行，两条都留着（insertParagraph 优先）。
   *
   * ── 为什么写入前要**把光标移到末尾**再写 ──────────────────────────────────────
   *   insertText 落在**光标处**。上一版拿"全选 + delete"换幂等（先清空再写）—— 那让第二次投喂
   *   把第一次的块全抹掉（用户真机：「先拉了两个过去，然后又选了两个过去，就会覆盖掉第一次的
   *   两个」）。现在**不清空**，改成"把光标折叠到末尾再逐行写"⇒ 天然追加。
   *   ⚠️ 光标必须在**写入之前**移好并**等一帧**：Lexical 的模型选区是从 DOM 选区经
   *   document 的 selectionchange **异步**同步的（第 5339 行注册 selectionchange 监听）
   *   ⇒ 同一 tick 里移光标再写，写到的还是旧光标处（上一版"叠三份"的同一个病因）。
   *
   * ── 为什么追加到**非空**框时要先补一个分段 ────────────────────────────────────
   *   不补就会把两批粘成一行（甲/乙丙/丁）—— 那在模型看来就是一个标题，用户看到的"4 个块"
   *   会变成 3 行。补一个空段只影响**文本路径**（chip 路径由内核补空格，见 src/dsh-chip-feed.js）。
   *
   * ── 为什么文案里一个 @ 都不许有 ────────────────────────────────────────────────
   *   @名字/ 在"行首或空白之后"命中 vendor 第 12633 行的 FOLDER_REF_RE
   *   （第 12632 TEXT_REF_RE 同理处理 /名字）⇒ 会被 registerTextRefDecoration（第 12749）
   *   改造成 TextRefNode 实体（第 12688）⇒ 真机上就是"前缀重复 / 神隐改写"的来源。
   *   ⇒ 本串对含 @ 的文案**就地拒绝**（mangled，一个字都不写），护栏在 src/sidebar-context.js。
   *   ⚠️ 这道闸**与本批的追加改动无关，必须留着**（去掉它 = 把用户 2026-10-40 报的那个缺陷放回来）。
   * ======================================================================= */
  function txt(v) { return String(v == null ? '' : v); }
  var ALL = txt(text);
  var steps = [];
  var wantLines = ALL.split('\\n');
  var wantN = wantLines.length;
  if (ALL.indexOf('@') >= 0) {
    return JSON.stringify({ ok: false, bucket: 'mangled',
      reason: '文案里有 @（这个输入框里 @ 是引用触发符，composer 会把它改写成引用实体，'
        + '导致前缀重复/标题粘连）—— 一个字都没写。回读前 80 字（此处是文案本身）：' + ALL.slice(0, 80),
      copiesBefore: 0, copiesAfter: 0, lines: 0, wantLines: wantLines.length, mode: 'refused',
      caret: 'refused', beforeLen: 0, textLen: ALL.length, readBack: '', steps: ['refused:at-char'], census: [] });
  }
  var SEL = 'textarea, input, [contenteditable], [contenteditable=""], [contenteditable="true"],'
    + ' [contenteditable="plaintext-only"], [role="textbox"], [data-composer-input]';
  var all = [];
  try { all = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { all = []; }
  function rectOf(el) { try { var r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return { w: 0, h: 0 }; } }
  function visible(el) {
    var r = rectOf(el);
    if (!(r.w > 40 && r.h > 16)) return false;
    try {
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (Number(cs.opacity) === 0) return false;
    } catch (e) { /* 取不到样式就按可见处理（宁可试一次，也不静默放弃） */ }
    return true;
  }
  function attr(el, k) { try { return el.getAttribute ? txt(el.getAttribute(k)) : ''; } catch (e) { return ''; } }
  /** 占位/标签线索：**把所有可能的来源都读一遍**（富文本编辑器的 placeholder 常在 data-placeholder
   *  或父元素的 data-placeholder 上；DSH 的 composer 就是自己带 data-placeholder + aria-label，
   *  vendor 第 16547-16548 行 ⇒ 今天这条仍在，但不依赖它） */
  function hintOf(el) {
    var parts = [];
    ['placeholder', 'aria-label', 'aria-placeholder', 'data-placeholder', 'title', 'name', 'id'].forEach(function (k) {
      var v = attr(el, k); if (v) parts.push(v);
    });
    try { if (el.parentElement) { var pv = attr(el.parentElement, 'data-placeholder'); if (pv) parts.push(pv); } } catch (e) {}
    try { var it = txt(el.innerText || el.textContent); if (it && it.length < 160) parts.push(it); } catch (e) {}
    return parts.join(' ');
  }
  function isEditable(el) {
    var ce = attr(el, 'contenteditable');
    var rich = false;
    try { rich = (el.isContentEditable === true); } catch (e) {}
    if (!rich) rich = (ce === '' || ce === 'true' || ce === 'plaintext-only');
    var role = attr(el, 'role');
    var tag = txt(el.tagName);
    var box = /^TEXTAREA$/i.test(tag) || /^INPUT$/i.test(tag) || /textbox/i.test(role);
    return { rich: !!rich, box: !!box, role: role,
      editorish: !!rich || !!box, isArea: /^TEXTAREA$/i.test(tag), isInput: /^INPUT$/i.test(tag) };
  }
  var census = [];
  var scored = [];
  for (var i = 0; i < all.length; i++) {
    var el0 = all[i];
    var r = rectOf(el0);
    var vis = visible(el0);
    var ed = isEditable(el0);
    var hint = hintOf(el0);
    var ratio = r.h > 0 ? (r.w / r.h) : 0;
    var s = 0;
    if (!vis) s -= 100;
    if (!ed.editorish) s -= 100;
    var slash = hint.indexOf('/') >= 0, at = hint.indexOf('@') >= 0;
    if (slash && at) s += 60;
    else if (slash || at) s += 12;
    if (/描述|构建|指令|提及|输入|提问|询问|对话|ask|describe|message|prompt/i.test(hint)) s += 25;
    if (ratio >= 3 && ratio <= 12) s += 20;      // 宽而扁（截图 738:129 ≈ 5.7）
    if (ed.rich) s += 20;                        // 富文本编辑器优先（/ 指令 + @ 提及几乎必然是它）
    /* +15：vendor 的 composer 自己带 data-composer-input / data-lexical-editor 这类**语义**属性
     * （第 16494 / 9278 行）—— 它们比类名稳，但**只是加分项**：身份仍由上面的特征门槛决定，
     * 不把"抓到某个属性"当成"抓对了框"（上一版假绿的教训）。 */
    if (attr(el0, 'data-composer-input') !== '' || attr(el0, 'data-lexical-editor') === 'true') s += 15;
    if (ed.isArea) s -= 25;                      // plain textarea 让位
    if (r.w < 160) s -= 20;
    census.push({ tag: txt(el0.tagName), role: ed.role, rich: ed.rich, w: r.w, h: r.h,
      ratio: Math.round(ratio * 10) / 10, visible: vis, score: s,
      placeholder: attr(el0, 'placeholder'), ariaLabel: attr(el0, 'aria-label'),
      fixed: (function () { try { return el0.offsetParent === null; } catch (e) { return null; } })() });
    if (vis && ed.editorish) scored.push({ el: el0, s: s, r: r, ed: ed });
  }
  var THRESHOLD = 40;
  scored.sort(function (a, b) {
    if (b.s !== a.s) return b.s - a.s;
    return (b.r.w * b.r.h) - (a.r.w * a.r.h);
  });
  var best = scored.length ? scored[0] : null;
  var pick = (best && best.s >= THRESHOLD) ? best : null;
  if (!pick) {
    return JSON.stringify({ ok: false, bucket: 'not-found',
      reason: '没找到对话输入框（普查 ' + all.length + ' 个候选，最高分 ' + (best ? best.s : 0)
        + '，门槛 ' + THRESHOLD + '）—— 不退回、不硬写别的框',
      copies: 0, lines: 0, wantLines: wantLines.length, steps: steps, textLen: ALL.length,
      census: census.slice(0, 10) });
  }
  var el = pick.el;
  var focused = false;
  try { el.focus(); } catch (e) {}
  try { focused = (document.activeElement === el) || !!(el.contains && document.activeElement && el.contains(document.activeElement)); } catch (e) {}
  if (!focused) {
    return JSON.stringify({ ok: false, bucket: 'focus-failed',
      reason: '找到对话输入框了（' + txt(el.tagName) + '）但焦点进不去',
      copies: 0, lines: 0, wantLines: wantLines.length, steps: steps, textLen: ALL.length,
      tag: txt(el.tagName), score: pick.s, census: census.slice(0, 10) });
  }
  function readBack() {
    try { return pick.ed.rich ? txt(el.innerText || el.textContent) : txt(el.value); } catch (e) { return ''; }
  }
  /** 归一化：只剪**尾随**空白，并清掉编辑器自己塞的零宽/不换行空格（否则回读永远差一两个字符） */
  function norm(v) {
    return txt(v)
      .replace(/\\u200b/g, '').replace(/\\ufeff/g, '')
      .replace(/\\u00a0/g, ' ')
      .replace(/[\\s\\u00a0]+$/, '');
  }
  function same(a, b) { return norm(a) === norm(b); }
  /** 回读里这段文本出现了**几份**（幂等判据：一次投喂必须恰好 1 份）。
   *  为什么要有这个读数：用户 2026-10-39 的真机现象就是"同一段出现了多次"，
   *  而"回读 == 原文"只能说明**整段相等**，说不出"到底几份" ⇒ 把份数当成回执字段报出来，
   *  下一次真机出问题，一行读数就能分辨"插了多份"与"写掉了/写歪了"✓。 */
  function copiesOf(hay, needle) {
    var h = txt(hay), n = txt(needle), c = 0, at2 = 0;
    if (!n) return 0;
    while ((at2 = h.indexOf(n, at2)) >= 0) { c++; at2 = at2 + n.length; }
    return c;
  }
  /** 回读的**行数**（判"换行有没有真的成分段"的唯一读数） */
  function lineCountOf(v) {
    var t = norm(v);
    if (!t) return 0;
    return t.split('\\n').length;
  }
  /** 等一帧：Lexical 的 DOM 选区 → 模型选区 的同步是异步的（vendor 第 5339 行）。
   *  两条腿（rAF + 定时器）取先到的 —— 窗口被遮挡时 rAF 可能不跑，定时器兜住。 */
  function frame() {
    return new Promise(function (done) {
      var fin = false;
      function go() { if (!fin) { fin = true; done(1); } }
      try {
        if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(go); setTimeout(go, 32); }
        else setTimeout(go, 4);
      } catch (e) { setTimeout(go, 4); }
    });
  }
  /** 把光标**折叠到编辑器末尾**（返回走的是哪条腿：dom-range / textarea / live）。
   *  为什么必须先移末尾：insertText 落在**光标处**；上一版靠"全选 + delete"清空来保幂等，
   *  而那正是"第二次投喂把第一批抹掉"的病根（2026-10-42 用户真机）。现在不清空，
   *  改成"把光标放到末尾再逐行写" ⇒ 天然追加。 */
  function caretToEnd() {
    var mode = 'live';
    try { el.focus(); } catch (e0) {}
    try {
      if (!pick.ed.rich && (pick.ed.isArea || pick.ed.isInput)) {
        var n = txt(el.value).length;
        if (typeof el.setSelectionRange === 'function') { el.setSelectionRange(n, n); mode = 'textarea'; }
      } else {
        var sel = window.getSelection ? window.getSelection() : null;
        if (sel && document.createRange) {
          var rg = document.createRange();
          rg.selectNodeContents(el);
          rg.collapse(false);          /* 折叠到内容**末尾**（不是元素边界点：那会让插入落偏） */
          sel.removeAllRanges();
          sel.addRange(rg);
          mode = 'dom-range';
        }
      }
    } catch (e1) { mode = 'live'; }
    steps.push('caretToEnd:' + mode);
    return mode;
  }
  function insertLine(line) {
    var done = false;
    try { done = !!(document.execCommand && document.execCommand('insertText', false, line)); } catch (e) { done = false; }
    steps.push('insertText:' + done);
    return done;
  }
  /** 行间换行：insertParagraph 优先；不被认就用编辑器自带的"单个换行"（Lexical: INSERT_LINE_BREAK） */
  function paraBreak() {
    var done = false;
    try { done = !!(document.execCommand && document.execCommand('insertParagraph', false, null)); } catch (e) { done = false; }
    if (done) { steps.push('insertParagraph:true'); return true; }
    var fb = false;
    try { fb = !!(document.execCommand && document.execCommand('insertText', false, '\\n')); } catch (e2) { fb = false; }
    steps.push('lineBreak-fallback:' + fb);
    return fb;
  }
  /* 写入前的真值：**判"追加"的基线**（前缀不许被动 / 份数只许 +1 全靠它）。
   * ⚠️ 必须在 focus + 移光标**之后**读（focus 可能让编辑器补一个空段）。 */
  var beforeN = '';
  var caret = 'skipped';
  var mode = 'none';
  var sep = 'none';
  if (pick.ed.rich) {
    caret = caretToEnd();
    await frame();                       /* 等模型选区跟上（selectionchange 是异步的） */
    beforeN = norm(readBack());
    mode = 'lines:append';
    /* 追加到**非空**框：先补一个分段，否则两批会粘成一行（用户看到的"4 块"变成 3 行） */
    if (beforeN !== '') { sep = 'para:' + paraBreak(); await frame(); }
    for (var li = 0; li < wantLines.length; li++) {
      insertLine(wantLines[li]);
      await frame();
      if (li < wantLines.length - 1) { paraBreak(); await frame(); }
    }
  } else {
    beforeN = norm(readBack());
    caret = caretToEnd();
  }
  /* ③ 兜底：编辑器一个字都没吃（不是 Lexical、也不是任何认 execCommand 的编辑器）⇒
   *   退回"直接赋值 + 派发输入事件"。**只在"写前 == 写后"时用** —— 否则会和上面的写入叠加成多份 ✗ */
  if (norm(readBack()) === beforeN) {
    try {
      if (pick.ed.rich) {
        mode = (mode === 'none') ? 'input-event' : (mode + '+input-event');
        el.textContent = beforeN === '' ? ALL : (beforeN + '\\n' + ALL);
        try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ALL })); } catch (e2) {}
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ALL })); }
        catch (e3) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e4) {} }
      } else {
        mode = 'native-setter';
        var proto = pick.ed.isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        var next = beforeN === '' ? ALL : (beforeN + '\\n' + ALL);
        if (desc && desc.set) desc.set.call(el, next); else el.value = next;
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ALL })); }
        catch (e5) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e6) {} }
      }
    } catch (e7) { mode = mode + '+threw'; }
  }
  try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e8) {}
  var got = readBack();
  /* verbatim 留着当**诊断读数**（整段回读 == 本次文案；只对空框成立），判据不再用它。 */
  var verbatim = same(readBack(), text);
  var afterN = norm(got);
  /* ① 前缀不许被动：写前那份必须原样是写后的前缀 */
  var prefixKept = afterN.indexOf(beforeN) === 0;
  /* 写前那份**还在不在**（在所有位置找）：用来把两种红灯分开 ——
   *   beforeStillThere === false ⇒ 真的被清空/被替换了（clobbered，本批要抓的那个病）；
   *   beforeStillThere === true  ⇒ 旧内容还在，只是**新内容插到了中间**（misplaced：光标没到末尾）。
   *   为什么必须分开：两种成因的修法完全不同（一个是"别清空"，一个是"光标没移对"），
   *   合成一个"覆盖了"的红灯会把下一个人带偏（本工程治过很多次的"原因指错方向"）。 */
  var beforeStillThere = (beforeN === '') || (afterN.indexOf(beforeN) >= 0);
  /* ② 末尾恰好多了这一批：减掉前缀 + 去掉分隔空白，剩下的必须逐字就是这次的文案 */
  var added = prefixKept ? afterN.slice(beforeN.length).replace(/^[\\s\\u00a0]+/, '') : '';
  var addedOk = prefixKept && (norm(added) === norm(ALL));
  var addedLines = lineCountOf(added);
  /* ③ 同一批只应用一次：出现次数必须恰好 +1（旧口径 copies === 1 在追加下必然假红） */
  var copiesBefore = copiesOf(beforeN, ALL);
  var copiesAfter = copiesOf(afterN, ALL);
  var copiesOk = (copiesAfter === copiesBefore + 1);
  var noAt = afterN.indexOf('@') < 0;
  /* ── 判据（2026-10-42 追加语义；**旧的三句全部重写，不是删掉**）──────────────────
   *  绿 = 前缀没被动 ∧ 末尾恰好多了这一批（逐字 + 行数对）∧ 这批只多了 1 份 ∧ 没冒出 @。
   *  ⚠️ 旧口径 copies === 1 在追加下**必然假红**（框里本来就有上一批）⇒ 换成"份数恰好 +1"。 */
  var ok = prefixKept && addedOk && (addedLines === wantN) && copiesOk && noAt;
  /* 分档的**先后**是有讲究的（否则原因会指错方向）：
   *   旧内容没了（clobbered）⇒ 旧内容还在但新内容插偏了（misplaced）⇒ 一个字都没写（rejected）
   *   ⇒ 多份（duplicated）⇒ 形状（粘连/@）⇒ 内容不符。 */
  var bucket = ok ? 'ok'
    : (!prefixKept ? (beforeStillThere ? 'misplaced' : 'clobbered')
      : (added === '' ? 'rejected'
        : (copiesAfter > copiesBefore + 1 ? 'duplicated'
          : ((addedLines !== wantN || !noAt) ? 'mangled' : 'readback-mismatch'))));
  var reason = ok ? null
    : (bucket === 'clobbered'
      ? '把输入框里原有的内容弄丢了（写前 ' + beforeN.length + ' 字，写后**找不到**它了）——'
        + ' 投喂必须是**追加**（清空/全选+delete 那一步不许回来）。写后前 80 字：' + afterN.slice(0, 80)
      : (bucket === 'misplaced'
        ? '旧内容还在，但新内容**插到了中间**（写后不再以写前那份开头）—— 光标没有移到末尾。'
          + '回读前 80 字：' + afterN.slice(0, 80)
        : (bucket === 'duplicated'
          ? '这一批在框里出现了 ' + copiesAfter + ' 份（写前 ' + copiesBefore + ' 份，应恰好 +1）——'
            + ' 同一批投喂被应用了不止一次。回读前 80 字：' + afterN.slice(0, 80)
          : (bucket === 'mangled'
            ? '写进去了但形状被改（新增这段行数 ' + addedLines + '，应 ' + wantN
              + (noAt ? '' : '；回读里又冒出 @') + '）'
              + ' —— 标题可能粘在一起，或 @ 被改写成引用实体。回读前 80 字：' + afterN.slice(0, 80)
            : (bucket === 'readback-mismatch'
              ? '写进去了但回读不一致（回读前 60 字：' + afterN.slice(0, 60) + '）'
              : '编辑器不接受 execCommand，且 InputEvent 也无效（读到空）')))));
  return JSON.stringify({ ok: ok, bucket: bucket, reason: reason, mode: mode,
    caret: caret, sep: sep, prefixKept: prefixKept, beforeStillThere: beforeStillThere,
    added: added, addedLines: addedLines,
    copiesBefore: copiesBefore, copiesAfter: copiesAfter,
    lines: addedLines, wantLines: wantN, verbatim: verbatim, steps: steps,
    tag: txt(el.tagName), rich: pick.ed.rich, score: pick.s,
    w: pick.r.w, h: pick.r.h, textLen: txt(text).length, beforeLen: beforeN.length,
    readBack: afterN.slice(0, 80), census: census.slice(0, 10) });
})`;

/** 纯文本路径（兜底）：把 N 行文本**追加**进 composer。
 *
 *  ── 2026-10-42 改语义（**追加**，不再是"替换"）────────────────────────────────
 *    上一版是"全选 → 等一帧 → delete → 逐行插入"，为的是幂等（"一次投喂恒等于一份"）。
 *    ⇒ 那让第二次投喂把第一次的内容全抹掉（用户真机：「先拉了两个过去，然后又选了两个过去，
 *      就会覆盖掉第一次的两个」）。现在**去掉全选/delete**，改成"光标移末尾 → 逐行插入"；
 *    幂等改由 `seq` 去重保证（主进程台账 `feedLedger` 判，**不在页面侧猜**）。
 *    ⇒ 两个入口（本函数与 `prefillComposer`）都过同一道台账检查（同一份实现，见 feedLedgerGet）。
 *
 *  @param {string} body 整段文案
 *  @param {object|null} chip 刚才 chip 通道的读数（只为把"为什么没用 chip"记进状态）
 *  @param {number|{seq?:number, token?:string}} [seqOrOpts] 这次投喂的**身份**：
 *         数字 = 直接给的序号（老调用方逐字不变）；对象 = `{seq}` 或 `{token}`（命令身份，
 *         见 `feedSeqFor` 的三档）；都不给就发一个新的（调用方不该依赖"不给"）。
 *  @returns {Promise<object>} 页面回执 + chip* 字段 + `{seq, already, appliedTotal}`
 */
function prefillComposerTextPath(body, chip, seqOrOpts) {
  const s = feedSeqFor((seqOrOpts && typeof seqOrOpts === 'object') ? seqOrOpts : { seq: seqOrOpts });
  const chipInfo = {
    chipMode: 'text',
    chipReason: (chip && chip.reason) || 'not-attempted',
    chipRoute: null,
    occurrences: 0
  };
  /* 幂等（文本路径这一半）：同一个 seq 已经应用过 ⇒ **一个字都不写**。
   * 这就是"同一次投喂被重试两次不许变成两遍"在兜底路径上的落地（主进程侧判，页面不参与）。 */
  const done = feedLedgerGet(s);
  if (done) {
    state.lastPrefill = Object.assign({
      ok: true, already: true, reason: null, at: Date.now(), len: body.length,
      seq: s, appliedTotal: feedLedgerTotal()
    }, chipInfo, { chipReason: null });
    return Promise.resolve(Object.assign({
      ok: true, already: true, reason: null, textLen: body.length, seq: s,
      appliedTotal: feedLedgerTotal(), landed: 0
    }, chipInfo, { chipReason: null }));
  }
  if (!state.view || !state.view.webContents) {
    return Promise.resolve(Object.assign({ ok: false, reason: '侧栏视图不可用（重开侧栏再试）', seq: s }, chipInfo));
  }
  // 超时保护：内核页面加载中时 executeJavaScript 可能永不返回 ✗（本模块踩过同一个坑 ✓）
  let finished = false;
  const timeout = new Promise((r) => setTimeout(() => {
    if (!finished) r({ ok: false, reason: '执行超时（6s）—— 页面可能没加载完' });
  }, 6000));
  const run = state.view.webContents.executeJavaScript('(' + COMPOSER_PREFILL_JS + ')('
    + JSON.stringify(body) + ')', true).then((raw) => {
    finished = true;
    try { return JSON.parse(raw); } catch (e) { return { ok: false, reason: '返回无法解析：' + String(raw).slice(0, 80) }; }
  }).catch((e) => { finished = true; return { ok: false, reason: (e && e.message) || String(e) }; });
  return Promise.race([run, timeout]).then((r) => {
    const ok = !!(r && r.ok === true);
    const lines = Array.isArray(body.split('\n')) ? body.split('\n').length : 0;
    /* 只有**真的写进去了**才记账（失败不记 ⇒ 重试才有机会成功）。 */
    if (ok) feedLedgerMark(s, lines, 'text', 'composer-prefill');
    // 4b：失败只记状态、不阻断，但**必须留原因** ✓（自检/状态里看得见 ✓）
    state.lastPrefill = Object.assign({
      ok: ok, reason: (r && r.reason) || null, at: Date.now(), len: body.length,
      seq: s, appliedTotal: feedLedgerTotal(), landed: ok ? lines : 0
    }, chipInfo);
    return Object.assign({}, r, chipInfo, {
      seq: s, already: false, appliedTotal: feedLedgerTotal(), landed: ok ? lines : 0
    });
  });
}

/**
 * ⑩ 唯一出口：把一段文本投喂进侧栏输入框（**不代替用户发送** ✗）。
 *
 * 两个形态，**先增强后兜底**：
 *   ① **chip**（插件在位时）：调页面全局 `__AIMM_CHIP_INSERT__` ⇒ 里面**追加** N 个"块"
 *      （光标先移到末尾 → `addFiles` / `insertReference`；**不再清空草稿**）；
 *   ② **纯文本**（插件不在位 / 插件报失败 / 不是 chip 形状 / 超时）：走 `COMPOSER_PREFILL_JS`
 *      （同样是**追加**）。
 * 两者的**模型输入逐行相同**（chip 的 ref 就是那行字）；差别只在输入框里的样子，
 * 以及连接符（文本用 `\n`；chip 由内核补空格 —— 见 src/dsh-chip-feed.js 文件头）。
 *
 * ── 幂等（2026-10-42）：`seq` 去重，**不是**清空 ─────────────────────────────────
 *   · `seq` 默认由本模块发号（`feedSeqNext`）；调用方**重试同一次投喂时必须传同一个 seq**
 *     （`opts.seq`）—— 那是"同一次投喂只生效一次"的唯一依据；
 *   · 台账里已有这个 seq ⇒ 直接回 `{ok:true, already:true}`（**一个块都不插、一个字都不写**）；
 *   · 台账 FIFO 上限 64（`FEED_LEDGER_MAX`）：为什么不用"高水位 seq"见 state.feedLedger 注释。
 *
 * ── 半途落地时**不再降级写文本** ────────────────────────────────────────────────
 *   若 chip 通道落了几个块却形状不全（`chip.landed > 0`），这里**不**走文本兜底 ——
 *   再写一遍就是同一批投喂变两遍（本批要治的正是这个）。失败原因照样可见。
 *
 * ⚠️ **降级必须可见**：不管走哪条，`lastPrefill.chipMode` 都写 'plugin' 或 'text'，
 *    失败原因写 `chipReason`。**绝不允许"静默什么都没做"**（那是本批最反对的失败形态）。
 * @param {string} text
 * @param {{seq?:number, token?:string}} [opts] 这次投喂的**身份**（重试时必须沿用同一个）：
 *   `seq` = 直接给的有限正整数；`token` = 命令身份（字符串，控制通道那条路用它 ——
 *   经 `feedSeqFor` 的恒等映射换成 seq）。两个都不给 = 本模块发新号（= 一次新意图）。
 * @returns {Promise<{ok:boolean, reason:(string|null), textLen:number, chipMode:('plugin'|'text'),
 *                    chipRoute:(string|null), occurrences:number, seq:number,
 *                    already:boolean, appliedTotal:number}>}
 */
function prefillComposer(text, opts) {
  const body = String(text == null ? '' : text);
  const seq = feedSeqFor(opts);
  if (!body.trim()) return Promise.resolve({ ok: false, reason: '没有要送过去的内容', seq: seq });
  if (!state.view) return Promise.resolve({ ok: false, reason: '侧栏还没创建（先打开侧边栏）', seq: seq });
  // ⚠️ 已销毁的 view **必须在这里挡住** ✗ —— 本机事故：冒烟链内 G5 三次红、9 条断言同时
  //    `THREW: Object has been destroyed`、视觉断言 0/0（窗口中途死掉）。机制：对已销毁的
  //    webContents 调 executeJavaScript 会**同步抛**，而 `.then/.catch` 接不到同步异常 ⇒
  //    异常冒到主进程调用点（控制通道那句 `prefillComposer(...).then(…)`）⇒ 未捕获异常 ✓。
  //    这里先判销毁并返回**结构化失败** ⇒ 无论它是不是那次的真凶，函数边界都不再放异常出去 ✓
  if ((state.view.isDestroyed && state.view.isDestroyed()) || !state.view.webContents
      || (state.view.webContents.isDestroyed && state.view.webContents.isDestroyed())) {
    const why = '侧栏视图已销毁或不可用（重开侧栏再试）';
    state.lastPrefill = { ok: false, reason: why, at: Date.now(), len: body.length, seq: seq,
      chipMode: 'text', chipReason: 'view-destroyed', chipRoute: null, occurrences: 0, appliedTotal: feedLedgerTotal() };
    return Promise.resolve({ ok: false, reason: why, chipMode: 'text', chipReason: 'view-destroyed', seq: seq });
  }
  if (state.status !== 'running') {
    state.lastPrefill = { ok: false, reason: '侧栏服务没在运行（状态 ' + state.status + '）', at: Date.now(),
      len: body.length, seq: seq, chipMode: 'text', chipReason: 'no-service', chipRoute: null,
      occurrences: 0, appliedTotal: feedLedgerTotal() };
    return Promise.resolve({ ok: false, reason: '侧栏服务没在运行（状态 ' + state.status + '）',
      chipMode: 'text', chipReason: 'no-service', seq: seq });
  }
  /* ⓪ 幂等（**在碰页面之前**短路）：同一个 seq 已经应用过 ⇒ 连 chip 都不试、一个字都不写。
   *    这正是"同一次投喂被重试两遍"与"用户又拖了一批"的分界线：seq 相同 = 同一次。 */
  const seen = feedLedgerGet(seq);
  if (seen) {
    const info = {
      ok: true, already: true, reason: null, textLen: body.length, seq: seq,
      chipMode: seen.mode || 'text', chipRoute: seen.route || null, occurrences: 0,
      items: 0, landed: 0, appliedTotal: feedLedgerTotal()
    };
    state.lastPrefill = Object.assign({ at: Date.now(), len: body.length, chipReason: null }, info);
    return Promise.resolve(info);
  }
  return tryChipInsert(body, seq).then((chip) => {
    if (chip.ok) {
      /* 记账：`already` 也记（页面说这批早在框里了 ⇒ 它占的块数照样算已投喂）。 */
      feedLedgerMark(seq, chip.items, 'plugin', chip.route);
      state.lastPrefill = {
        ok: true, already: chip.already === true, reason: null, at: Date.now(), len: body.length,
        seq: seq, chipMode: 'plugin', chipReason: null, chipRoute: chip.route,
        occurrences: chip.occurrences, appliedTotal: feedLedgerTotal()
      };
      /* 回执形状：保留旧的 textLen（渲染层用它报"送进去几个字"），新增 chip 三读数 + seq 读数。
       * ⚠️ 这里**不报**"已发送" —— 本工程铁律：谁按发送谁负责（我们不代替用户发送）。 */
      return {
        ok: true, already: chip.already === true, reason: null, textLen: body.length, seq: seq,
        chipMode: 'plugin', chipRoute: chip.route, occurrences: chip.occurrences, items: chip.items,
        landed: chip.items, appliedTotal: feedLedgerTotal()
      };
    }
    /* ⚠️ **落了块就不许再写文本**：再写一遍 = 同一批投喂变两遍（本批要治的就是这个）。
     *    失败仍然**可见**（ok:false + reason），绝不静默。 */
    if (chip.landed > 0) {
      feedLedgerMark(seq, chip.landed, 'plugin', chip.route);
      const info = {
        ok: false, already: false, reason: chip.reason, textLen: body.length, seq: seq,
        chipMode: 'plugin', chipReason: chip.reason, chipRoute: chip.route,
        occurrences: chip.occurrences, items: chip.items, landed: chip.landed,
        appliedTotal: feedLedgerTotal()
      };
      state.lastPrefill = Object.assign({ at: Date.now(), len: body.length }, info);
      return info;
    }
    return prefillComposerTextPath(body, chip, seq);
  });
}

/* ── 投喂台账的**测试接缝**（2026-10-70）────────────────────────────────────────────
 * 为什么需要：`prefillComposer` 在 `!state.view` / `status !== 'running'` 时**先于台账**短路
 *   ⇒ "同一条命令派发两次只追加一次"这条判据在单测里根本走不到台账那一行（会退化成空转）。
 * 生产路径永不调用这两个：产品的 view 只来自 `ensureView()`，status 只来自服务生命周期。
 * `__resetFeedStateForTest` 连 seq 映射一起清 —— 否则上一条用例的 token 会串到下一条（判据假绿）。
 */
function __setFeedViewForTest(view, status) {
  state.view = view || null;
  if (status) state.status = status;
  return state.status;
}
function __resetFeedStateForTest() {
  state.feedLedger = [];
  state.feedSeqByToken = new Map();
  state.feedSeqNo = 0;
  state.lastPrefill = null;
  return true;
}

module.exports = {
  init, reattach, toggle, show, hide, isVisible, getStatus,
  // 工程根（= 侧栏 AI 会话的 cwd）。**导出给 main.js 采样「AI 改了哪些文件」用** ——
  // 被采样的目录必须与 AI 真正干活的目录是同一个，所以这一处路径只在这里推导一次。
  projectRoot,
  viewBounds,
  destroy, startService, stopService, restartService,
  // adoptOrStart 是对外生命周期入口（先接管后孵化）—— 导出供 headless 驻留测试
  // scripts/dsh-resident-host.js 使用：没有窗口时也要能驱动同一套服务生命周期。
  adoptOrStart,
  beginWidthDrag, endWidthDrag, setWidth,
  // 拖动虚影（甲 · 同窗口 WebContentsView；2026-10-33 批3）的实现**在 main.js**（理由见本文件
  // 里那句 `/* 拖动虚影…` 的指向注释）。这里只导出一条**单向事件通知**：
  //   onHide(fn) —— 侧栏被收起/被销毁时通知外部（main.js 借它把虚影收掉）
  onHide,
  setDshOnly, isDshOnly, hideWindowToBackground, hideToBackground, captureView, restoreWindow,
  // 只关一侧的两种能力（对外/给 AI 用；人类用界面上的两个 ✕）
  closeSidebar, buttonBounds, buttonProbe, clickButton, occupiedWidth,
  // 「真关」两个入口 + 判据（closeMapPage/openMapPage 也供 main.js 的菜单、控制通道与冒烟断言调用）
  //   · closeMapPage({confirmed}) —— 卸载导图页（confirmed=false 时自己查脏，脏就拒绝 ✓）
  //   · openMapPage()            —— 重新加载导图页 + 还原停靠宽度 + 回到上次的项目
  closeMapPage, openMapPage, destroyView, mapClosedPage, rendererDirty,
  setCurrentProject, bootProject, setMapPageListener,
  // 第 4 个原生面板（停靠面板 · 2026-10-18 底座批）：开/关/退化 + 两条几何读数
  //   —— 导出的都是**产品路径**（菜单与冒烟域都调它们，不另写一条通道）
  openDockPanel, closeDockPanel, toggleDockPanel, setDockWidth, isDockOpen,
  panelBounds, geometrySnapshot, destroyPanel, ensurePanel, dockPanelPageHtml,
  // 面板页 ⇄ 主进程的消息桥（第 2 批 a76bab32）：业务方注册处理函数 + 唯一的推送出口
  setDockPanelBridge, pushDockPanelScript,
  DOCK_DEFAULTS: panelGeometry.DEFAULTS,
  setGeometry,
  NARROW_CSS, RIGHTBAR_WATCHER_JS, RIGHTBAR_AUTO_WIDTH, RIGHTBAR_PAGE_MIN, RIGHTBAR_MIN_BAND, RAIL_WIDTH,
  // 默认宽度（`SIDEBAR_WIDTH`）导出给**冒烟断言的前置复位**用：域 17 的"文件预览 ≥60% 视口"隐含
  // "页面没被侧栏让位吃掉宽度"这个前提，而抽样档里上游域（11/12/22）不在 ⇒ 它得自己把前提摆好。
  // 导出而不是在断言里手抄 420 —— 默认宽只许有一处（改这里不用改断言）。
  SIDEBAR_WIDTH,
  WIDTH_STEP_PX, WIDTH_STEP_MAX,
  ensureRightbarRoom, releaseRightbarRoom, setNoSpawn, installRightbarWatcher,
  // 测量驱动的宽度预算（2026-10-16 批）：编排 + **纯函数目标宽度**（唯一一份"该多宽"的判断）
  // —— 导出是给冒烟域直接驱动它用的；域 53 走"真 WebContentsView 页面读数 + 测量接缝"两条路。
  runContentBudget, budgetTargetWidth, rightbarRoomTarget, reviseWidthBudget,
  // 测试专用（读数接缝：见 setMeasureProbeForTest 的注释 —— 冒烟环境页面视口不重排，
  // 不换读数这条闭环在门禁里跑不到 ⇒ 会变成"永远不判"的空转 ✗）
  __setMeasureProbeForTest: setMeasureProbeForTest,
  // ⑩ 把对话预填进侧栏输入框（不代替用户发送）。`prefillComposer(text, {seq})` ——
  //   `seq` 是**这次投喂的身份**（重试时沿用同一个才能"只生效一次"），不给就发一个新的。
  prefillComposer, COMPOSER_PREFILL_JS,
  // ⑩-b 「拖节点 ⇒ 真 chip」（2026-10-41，2026-10-42 改**追加 + seq 去重**）：这些导出给**冒烟域 30**
  //   与自检读 —— 断言验的是**同一份实现**（不另写"测试用的第二条通道"）：
  //     · CHIP_INSERT_JS   —— 页面侧那一小段（取全局句柄 → 调 → 回 JSON 字符串）
  //     · chipPayloadFor   —— 文案 + seq ⇒ chip 载荷（纯逻辑在 src/dsh-chip-feed.js，这里只是壳）
  //     · tryChipInsert    —— 一次 chip 尝试（失败只返回结构化原因，绝不阻断）
  //     · chipFeedStatus   —— 载荷在位读数（内容级；5s 缓存）
  //     · feedLedgerView   —— 投喂台账读数（seq 列表 + 累计块数；幂等的**唯一**依据，只读）
  CHIP_INSERT_JS, chipPayloadFor, tryChipInsert, chipFeedStatus,
  feedLedgerView, feedLedgerTotal, FEED_LEDGER_MAX,
  // 台账的"身份 → seq"换算（2026-10-70 收口）：`feedSeqFor` 是**唯一**实现（三档优先级），
  //   `feedSeqByToken` 是 token 那一档的恒等映射。导出给单测直接打这两条 ——
  //   判据要能分别证明"同一条命令派发两次只追加一次"与"两条不同命令各追加一次"，
  //   两条都读同一份实现（不另写"测试用的第二套去重"）。
  feedSeqFor, feedSeqByToken, feedLedgerGet,
  __setFeedViewForTest, __resetFeedStateForTest,
  // 兜底路径也导出：冒烟域 30 要证明"chip 不成立时**真的把文本追加进去了**且 chipMode='text' 可见"
  //   —— 那一格不许另写一份文本写入（复制品会把断言变成自证）。
  prefillComposerTextPath,
  // 加载失败判定（r12 收口批）—— 三样都是**产品路径本体**，导出只为让门禁与探针走同一份实现
  //   （不另写一条"测试用的判定"，那种第二份实现正是本工程反复治过的病）：
  //   · attachLoadDiagnostics —— `ensureView()` 用的**唯一挂载处**（单测拿 EventEmitter 打它、
  //     探针拿真 webContents 打它 —— 两条路验的是同一个函数）；
  //   · settleStatusPageLoad  —— 唯一的结算/打印处（`-3` 到点结算走它）；
  //   · loadUrlTracked        —— 唯一的 `loadURL()` 调用包装（导航计数 + 失败交给判定器）。
  //   另有 `__` 开头的测试接缝与常量（干净实例 / 可注入的视图事实 / 重置 / 两个时限）：
  //   单测要逐条打分档，探针要没有产品视图也能验"到点判红"，靠的就是它们（产品路径不用）。
  attachLoadDiagnostics, settleStatusPageLoad, loadUrlTracked,
  __createStatusPageLoadTracker: createStatusPageLoadTracker,
  __setStatusPageSettleFactsForTest: setStatusPageSettleFactsForTest,
  __resetStatusPageLoadTrackerForTest: resetStatusPageLoadTrackerForTest,
  __STATUS_PAGE_ABORT_SETTLE_MS: STATUS_PAGE_ABORT_SETTLE_MS,
  __STATUS_PAGE_ABORT_MAX_WAIT_MS: STATUS_PAGE_ABORT_MAX_WAIT_MS,
  // 测试专用（见函数注释）：桩服务接上 / 交出视图。产品路径不要用这两个。
  __injectStubServiceForTest: injectStubServiceForTest, __viewForTest: viewForTest,
  SIDEBAR_WIDTH, MIN_WIDTH, MAX_WIDTH
};
