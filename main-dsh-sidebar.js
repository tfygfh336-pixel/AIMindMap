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

const SIDEBAR_WIDTH = 420;
const MIN_WIDTH = 280;
// 上限 720 → 900：内核右栏在窄模式（view < 1024）下需要
// available = view − 56（左栏图标轨道）− 400（中间列保底）≥ 300 ⇒ **view ≥ 756px**，
// 而 720 上限连 756 都够不着 ⇒「打开侧边栏」永远只会"点一下就消失" ✗（实测 694 时 available=238 ✗）。
const MAX_WIDTH = 900;
// 右栏自动加宽的目标（view = 900 − 30 控制栏 = 870 ⇒ available = 414 ≥ 300 ✓）
const RIGHTBAR_AUTO_WIDTH = 900;
// 页面（view）达到这个宽度，内核就会给出 ≥ 300px 的右栏（见上面推导）
const RIGHTBAR_PAGE_MIN = 756;

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
  dshOnly: false,       // 仅侧边栏模式（外部 AI 迭代主界面时开启；主 renderer 隐藏）
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

function showStatusPage(html) {
  if (!state.view) return;
  state.view.webContents.loadURL(html).catch((e) => log('状态页加载失败: ' + e.message));
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
  // DSH 页面每次加载完成后重新注入窄宽适配（insertCSS 不跨导航保留）
  view.webContents.on('did-finish-load', () => {
    if (state.visible) scheduleNarrowAdaptation();
  });
  state.view = view;
  return view;
}

function loadCurrentUrl() {
  if (!state.view || !state.url) return;
  // ⚠️ 只在"当前页不是这个 URL"时才载入。原先无条件 loadURL ⇒ 每次**重开侧栏**都整页重载：
  // 插件重新初始化、settings/皮肤等配置被重读 —— 用户观察到的"减号像是带刷新机制"就是这个 ✗
  //（hide() 本身不碰服务、不重载；刷新发生在 reopen 那一侧的 show()）。
  let cur = '';
  try { cur = state.view.webContents.getURL(); } catch (e) { cur = ''; }
  if (cur === state.url) return;
  state.view.webContents.loadURL(state.url).catch((e) => {
    log('loadURL 失败: ' + e.message);
  });
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
/* 控制栏宽度：拖宽热区 + −/✕ 两个按钮都在这一条里（原先热区 6px、按钮浮在页面上 ✗） */
const RAIL_WIDTH = 30;
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
      setDshOnly(false);
    } else if (message === '[dsh-close-sidebar]') {
      if (state.dshOnly) setDshOnly(false);   // 先让主界面回来，否则关完窗口是空的 ✗
      closeSidebar();
    }
  });
  state.rail = rail;
  return rail;
}

/** 开始拖宽：新宽度用光标屏幕坐标对窗口右缘的**绝对距离**计算 */
function beginWidthDrag() {
  if (dragTimer || !state.win) return;
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

/* ---------------- 几何 ---------------- */

/** 侧栏几何：右侧 state.width 宽、全高，恒可见（宽度可拖拽调节）；
 *  折叠按钮钉在侧栏右上角（必须在 view 之后 addChild 才盖在上面）；
 *  dsh-only 模式下侧栏铺满全窗（主内容已隐藏）。 */
function relayout() {
  if (!state.win || !state.view) return;
  const [w, h] = state.win.getContentSize();
  state.width = clampWidth(state.width);
  const vw = state.dshOnly ? w : Math.min(state.width, w);
  const sbX = state.dshOnly ? 0 : Math.max(0, w - vw);        // 侧栏左缘
  const railW = Math.min(RAIL_WIDTH, vw);                      // 极窄时先保内容
  if (state.rail) state.rail.setBounds({ x: sbX, y: 0, width: railW, height: h });
  state.view.setBounds({ x: sbX + railW, y: 0, width: Math.max(0, vw - railW), height: h });
  // ③ 窄宽适配：宽度变了重算一次（**不清状态、不打断进行中的重试** —— 原先每次 relayout
  //    都 reset，一旦有 resize 风暴就会被无限重置，表现为"永远没注入" ✗ 实测踩过）。
  state.narrowDiag = state.narrowDiag || { relayout: 0, scheduled: 0 };
  state.narrowDiag.relayout++;
  scheduleNarrowAdaptation(false);
  notifyRenderer(state.visible);
}

function setWidth(w) {
  state.width = clampWidth(w);
  relayout();
}

/* ---------------- 内核右栏 ⇄ 侧栏自动加宽（用户要求） ----------------
 * 为什么需要：内核在窄模式（view < 1024）下，右栏要求
 *   available = view − 56 − 400 ≥ 300  ⇒  view ≥ 756px
 * 而我们的侧栏上限是 720 ⇒ 那个面板**结构性打不开** ✗（表现为"点一下就消失"）。
 * 现在的做法：检测到"用户要开右栏"就把侧栏自动加宽到 RIGHTBAR_AUTO_WIDTH ✓
 * （= 让内核有空间真的把右栏渲染出来），右栏关掉再还原到用户原来的宽度 ✓。
 * 两个信号缺一不可：
 *   · **意图**（必须）：点官方按钮或 Ctrl+Shift+B —— 宽度不够时状态属性根本不会变 ✗；
 *   · **事实**：官方 frame 的 `data-rightbar-collapsed` 属性（权威 ✓）。
 * 安全：只在我们**处于自动加宽状态**且用户没手动改过宽度时才还原 ✓。
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

/** 需要就加宽（幂等）。返回 true 表示这次真的加宽了。 */
function ensureRightbarRoom() {
  const view = Math.max(0, state.width - RAIL_WIDTH);
  if (view >= RIGHTBAR_PAGE_MIN) return false;          // 已经够宽，不用动
  if (state.autoWide) return false;                     // 已在自动加宽状态
  state.autoWide = { prev: state.width };
  setWidth(RIGHTBAR_AUTO_WIDTH);
  log('内核右栏需要空间 → 自动加宽侧栏 ' + state.autoWide.prev + ' → ' + RIGHTBAR_AUTO_WIDTH);
  broadcastStatus();
  return true;
}

/** 右栏关掉后还原（只在我们还在自动宽度、且用户没手动改过时还原 ✓）。 */
function releaseRightbarRoom() {
  const auto = state.autoWide;
  if (!auto) return false;
  state.autoWide = null;
  if (state.width === RIGHTBAR_AUTO_WIDTH) {
    setWidth(auto.prev);
    log('内核右栏关闭 → 还原侧栏宽度 ' + auto.prev);
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


/** 只关**侧栏那一半**：收起 view + 停掉 DSH 服务；主界面、应用进程、项目数据都不受影响。
 *  停服务是刻意的（用户要的"独立关掉侧栏 DSH"）—— 这样更新 DSH 那一侧时不必重启应用；
 *  想回来点主界面右缘的 🤖（show() 发现服务不在会自动重新孵化/接管 ✓）。
 *  opts.keepService=true 只收 view、不动服务（**给自动化断言用**：冒烟进程可能正接管着
 *  用户真实的服务，断言不能把它杀掉 ✗）。 */
function closeSidebar(opts) {
  const keepService = !!(opts && opts.keepService);
  hide();
  if (!keepService) stopService();
  log('侧栏已独立关闭（' + (keepService ? '服务保留（断言模式）' : 'DSH 服务已停') + '；主界面继续运行）');
  broadcastStatus();
}

/** 侧栏**总占宽** = 控制栏 + 内容 view。让位宽度必须用它：
 *  只报 view 宽度会少报 RAIL_WIDTH ⇒ 页面少让一条 ⇒ 又出现"侧栏隔壁的灰色背景" ✗。 */
function occupiedWidth() {
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
  if (state.view && state.win.contentView) {
    try { state.win.contentView.removeChildView(state.view); } catch (e) { /* ignore */ }
  }
  if (state.rail && state.win.contentView) {
    try { state.win.contentView.removeChildView(state.rail); } catch (e) { /* ignore */ }
  }
  state.visible = false;
  notifyRenderer(false);
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
    // 窄宽适配的实况（模式 + 是否横向溢出）—— 改布局要用它，不要拍脑袋
    narrow: state.narrow || null,
    // 为什么"尚未注入"——诊断要能回答它，否则只能靠猜 ✗
    narrowSkip: state.narrowSkip || null,
    // 内核右栏 ⇄ 自动加宽（用户要求）的实况
    rightbarOpen: !!state.rightbarOpen,
    autoWide: state.autoWide || null,
    rightbarWatcher: state.rightbarWatcher || null,
    // ⑩ 最近一次"把对话预填进侧栏"的结果（4b：失败也要看得见原因 ✓ 不阻断 ✗）
    lastPrefill: state.lastPrefill || null,
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
function notifyRenderer(visibleFlag) {
  if (!state.win || state.win.isDestroyed()) return;
  let width = 0;
  if (visibleFlag) {
    const total = occupiedWidth();      // 控制栏 + 内容：只报 view 会少报一条 ✗
    if (total > 0) {
      width = total;
    } else {
      try {
        const [w] = state.win.getContentSize();
        width = state.dshOnly ? w : Math.min(state.width, w);
      } catch (e) { width = state.width; }
    }
  }
  state.win.webContents.send('dsh-sidebar:layout', { visible: !!visibleFlag, width: width });
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
      + 'return {innerWidth:window.innerWidth,scrollWidth:sw,overflow:sw>window.innerWidth+1};'
      + '})()');
    // 每次成功注入都顺手装一次右栏观察器：页面**重载**会清掉页面内的标志位，
    // 所以不能"只装一次"；页面内自带 __mmRightbarWatched 去重 ✓（成本极低 ✓）。
state.narrow = { viewWidth: viewW, mode: mode, metrics: info, at: new Date().toISOString() };
    installRightbarWatcher().catch(() => {});
    state.narrowSkip = null;
    log('窄宽适配: ' + mode + '（内容宽 ' + viewW + '）'
      + (info ? '，页面 ' + info.innerWidth + ' / 内容 ' + info.scrollWidth
        + (info.overflow ? ' ⇒ **横向溢出**' : ' ⇒ 不溢出') : ''));
    return true;
  } catch (e) {
    // 注入失败不阻断主流程，但要**留下原因**（诊断里能看见，不要静默 ✗）
    state.narrow = { viewWidth: viewW, mode: mode, err: String(e && e.message) };
    state.narrowSkip = '注入失败: ' + String(e && e.message);
    return true;
  }
}

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
    // 可见性**不跨启动记忆**（用户语义：每次启动默认打开；折叠只是当次会话状态）
    state.visible = true;
  } catch (e) {
    state.visible = true; // 默认打开
  }
}

function savePrefs() {
  try {
    // 只存宽度；visible 是会话状态，不持久化（启动永远默认打开）
    fs.writeFileSync(prefsFile(), JSON.stringify({
      width: state.width
    }), 'utf8');
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

/* ---------------- 仅侧边栏模式（v0.16.5） ----------------
 * 用途：外部 AI 迭代主界面代码时，导图页面先下线、DSH 侧边栏继续可用。
 *  · 进入：主 renderer 隐藏（body.dsh-only），侧栏占满全窗；
 *    此时侧栏「—」= 窗口最小化到任务栏（任务栏图标可复原）；
 *  · 关窗语义：dsh-only 下点 ✕ 不退出应用 —— 隐藏到托盘式后台
 *    （窗口保留、服务驻留），任务栏图标可复原；再次进入 dsh-only 关窗同前；
 *  · 退出：恢复主 renderer 显示（正常窗口）。
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
    // 侧栏铺满：dsh-only 下让位宽度 = 全窗（渲染层 body.dsh-only 隐藏主内容）
    notifyRenderer(state.visible);
    relayout();
  }
  refreshRail();   // 控制栏里「—」的字形/语义换成"恢复思维导图页"
  log('dsh-only 模式: ' + state.dshOnly);
}

function isDshOnly() { return state.dshOnly; }

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

/** ⑩「在侧边栏打开」：把一段文本**预填**进侧栏的输入框（不代替用户发送 ✗ —— 谁按发送谁负责 ✓）。
 *  内核事实（易腐，复核命令见 docs/DSH-EMBEDDED.md 的注入一节）：DSH 页面的输入框是
 *  `textarea` 或 `[contenteditable]`，用**内容特征 + 弱选择器**定位（4a ✓），不绑会被改名的类名 ✓。
 *  ⚠️ 与 installRightbarWatcher 同一个坑：`executeJavaScript` 可能**永不返回** ⇒ 必须超时 + 如实报错 ✓ */
const COMPOSER_PREFILL_JS = `(function (text) {
  var cands = Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"]'))
    .filter(function (el) { return el.offsetParent !== null && el.offsetWidth > 120 && el.offsetHeight > 16; });
  if (!cands.length) return JSON.stringify({ ok: false, reason: '页面上找不到可见的输入框（textarea / contenteditable）' });
  // 取面积最大的那个（主输入框最大 ✓ 弱选择器 ✓）
  cands.sort(function (a, b) { return b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight; });
  var el = cands[0];
  el.focus();
  if (el.tagName === 'TEXTAREA') el.value = text;
  else el.textContent = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, tag: el.tagName, w: el.offsetWidth, h: el.offsetHeight,
    textLen: String(text || '').length });
})`;

function prefillComposer(text) {
  const body = String(text == null ? '' : text);
  if (!body.trim()) return Promise.resolve({ ok: false, reason: '没有要送过去的内容' });
  if (!state.view) return Promise.resolve({ ok: false, reason: '侧栏还没创建（先打开侧边栏）' });
  if (state.status !== 'running') {
    return Promise.resolve({ ok: false, reason: '侧栏服务没在运行（状态 ' + state.status + '）' });
  }
  // 超时保护：内核页面加载中时 executeJavaScript 可能永不返回 ✗（本模块踩过同一个坑 ✓）
  let done = false;
  const timeout = new Promise((r) => setTimeout(() => { if (!done) r({ ok: false, reason: '执行超时（6s）—— 页面可能没加载完' }); }, 6000));
  const run = state.view.webContents.executeJavaScript('(' + COMPOSER_PREFILL_JS + ')('
    + JSON.stringify(body) + ')', true).then((raw) => {
    done = true;
    try { return JSON.parse(raw); } catch (e) { return { ok: false, reason: '返回无法解析：' + String(raw).slice(0, 80) }; }
  }).catch((e) => { done = true; return { ok: false, reason: (e && e.message) || String(e) }; });
  return Promise.race([run, timeout]).then((r) => {
    // 4b：失败只记状态、不阻断，但**必须留原因** ✓（自检/状态里看得见 ✓）
    state.lastPrefill = { ok: !!r.ok, reason: r.reason || null, at: Date.now(), len: body.length };
    return r;
  });
}

module.exports = {
  init, reattach, toggle, show, hide, isVisible, getStatus,
  viewBounds,
  destroy, startService, stopService, restartService,
  // adoptOrStart 是对外生命周期入口（先接管后孵化）—— 导出供 headless 驻留测试
  // scripts/dsh-resident-host.js 使用：没有窗口时也要能驱动同一套服务生命周期。
  adoptOrStart,
  beginWidthDrag, endWidthDrag, setWidth,
  setDshOnly, isDshOnly, hideWindowToBackground, hideToBackground, captureView, restoreWindow,
  // 只关一侧的两种能力（对外/给 AI 用；人类用界面上的两个 ✕）
  closeSidebar, buttonBounds, buttonProbe, clickButton, occupiedWidth,
  NARROW_CSS, RIGHTBAR_WATCHER_JS, RIGHTBAR_AUTO_WIDTH, RIGHTBAR_PAGE_MIN,
  ensureRightbarRoom, releaseRightbarRoom, setNoSpawn, installRightbarWatcher,
  // ⑩ 把对话预填进侧栏输入框（不代替用户发送）
  prefillComposer, COMPOSER_PREFILL_JS,
  SIDEBAR_WIDTH, MIN_WIDTH, MAX_WIDTH
};
