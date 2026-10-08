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

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const dshSidebar = require('./main-dsh-sidebar.js');

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
if (SMOKE_PROJECTS_DIR) {
  try {
    if (fs.existsSync(REAL_PROJECTS_DIR)) {
      fs.cpSync(REAL_PROJECTS_DIR, SMOKE_PROJECTS_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[smoke] 复制项目到沙箱目录失败，改用空目录:', err && err.message);
  }
  // 暴露给断言：有些断言需要在沙箱里放**文件类**夹具（如给"PDF 预览按钮"造一份 PDF），
  // 而 runCli 只能写数据。断言跑在主进程，读这个环境变量即可；真实数据照样零触碰。
  process.env.AI_MINDMAP_PROJECTS_DIR = SMOKE_PROJECTS_DIR;
}
const PROJECTS_DIR = SMOKE_PROJECTS_DIR || REAL_PROJECTS_DIR;

// 存取层单源：列表与读取都走 src/data-store.js，不再各自手写 readdir + JSON.parse。
// 历史问题：main.js 曾自建 listProjects() 并裸 JSON.parse 读文件 ——
//   · 与 store.list() 重复实现（两处行为可能分叉）；
//   · 不带 BOM 剥离（带 BOM 的 JSON 在此直接抛错，而 CLI 能正常读）；
//   · project:read 完全不校验（坏数据照样送进渲染层）。
const store = require('./src/data-store.js').createStore(PROJECTS_DIR);
const { writeFileAtomic, versionOf, versionOfText } = require('./src/data-store.js');
const concurrency = require('./src/concurrency.js');
/**
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

// 冒烟结束（含 app.exit 与异常退出）都要清掉临时项目目录，避免在系统 temp 里堆积。
if (SMOKE_PROJECTS_DIR) {
  const cleanup = () => {
    try { fs.rmSync(SMOKE_PROJECTS_DIR, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  };
  app.on('will-quit', cleanup);
  process.on('exit', cleanup);
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

/* ---------------- 窗口 ---------------- */
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

/* ---------------- 菜单 ---------------- */
function buildMenu(win) {
  const send = (channel, ...args) => { if (!win.isDestroyed()) win.webContents.send(channel, ...args); };
  const template = [
    { label: '文件', submenu: [
      { label: '导入 Markdown…', accelerator: 'CmdOrCtrl+I',
        click: () => send('menu:import-md') },
      { label: '导出 Markdown…', accelerator: 'CmdOrCtrl+E',
        click: () => send('menu:export-md') },
      { type: 'separator' },
      { label: '导入 JSON 打包…', click: () => importJsonDialog(win) },
      { label: '导出 JSON 打包…', click: () => exportJsonDialog(win) },
      { label: '导出当前导图为 PNG…', click: () => exportImageDialog(win) }
    ]},
    { label: '编辑', submenu: [
      // 保存：此前**菜单里没有这一项**，界面也无按钮 —— 人的编辑无从落盘。
      { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
      { type: 'separator' },
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
      { label: '重做', accelerator: 'CmdOrCtrl+Y', click: () => send('menu:redo') },
      { type: 'separator' },
      { label: '新建节点', accelerator: 'CmdOrCtrl+N', click: () => send('menu:add-node') },
      { label: '编辑节点', accelerator: 'F2', click: () => send('menu:edit-node') },
      { label: '删除节点', accelerator: 'Delete', click: () => send('menu:delete-node') },
      { type: 'separator' },
      { label: '展开全部', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu:expand-all') },
      { label: '收起全部', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:collapse-all') },
      { type: 'separator' },
      // 命令面板与关系审计放在菜单里：菜单快捷键比渲染层 keydown 更可靠
      // （不受输入框焦点影响），渲染层仍保留 keydown 兜底。
      { label: '命令面板…', accelerator: 'CmdOrCtrl+P', click: () => send('menu:palette') },
      { label: '关系审计…', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu:audit') }
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
      // 仅侧边栏模式：外部 AI 迭代主界面时用（✕ 隐藏窗口、「—」最小化，DSH 驻留不动）
      { label: '仅 DSH 侧边栏（主界面迭代中用）', type: 'checkbox', checked: false,
        click: (mi) => {
          dshSidebar.setDshOnly(mi.checked);
          win.webContents.send('app:toast',
            mi.checked ? '已进入仅侧边栏模式：✕ 隐藏窗口、「—」最小化到任务栏，DSH 服务驻留不受影响'
              : '已恢复主界面');
        } }
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
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('project:list', () => listProjects());

  /* 项目文件监听（v0.16.1「边聊边编辑」）：
   * 侧栏 AI 经 CLI 改盘上 JSON 后，界面要实时感知。渲染层订阅本通道，
   * 在自身无未保存改动时自动重读（有脏改动则只提示，绝不覆盖人的编辑）。
   * fs.watch 对一次原子写（tmp+rename）可能触发多次 → 300ms 防抖 + 消重。 */
  const projectWatchers = new Map(); // absDir → fs.FSWatcher
  function watchProjectDir(win, absDir) {
    const prev = projectWatchers.get('current');
    if (prev) { try { prev.close(); } catch (err) { /* ignore */ } projectWatchers.delete('current'); }
    if (!absDir || !fs.existsSync(absDir)) return;
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
    versionAtRead.set(name, r.version);
    // 同时记下**内容基线**：并发时要做三方合并（阶段 2），只有指纹是不够的
    baseAtRead.set(name, r.data);
    return r;
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
        return {
          ok: false, code: 'MERGE_CONFLICT', conflicts: mr.conflicts, detail: mr.detail,
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
      return { ok: true, merged: merged };
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
      return Promise.resolve({
        ok: true, stub: true, kind, ms: 0,
        text: '（冒烟桩：未调用模型）' + (kind === 'explain' ? '这是对该节点的解释占位。' : '这是回答占位。') + echo
      });
    }
    const args = ['ask', projectName, nodeId, '--json', '--kind', kind];
    if (o.question) args.push('--question', String(o.question));
    if (o.timeoutSec) args.push('--timeout', String(o.timeoutSec));
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [CLI].concat(args), {
          cwd: ROOT,
          env: Object.assign({}, process.env, {
            ELECTRON_RUN_AS_NODE: '1',
            AI_MINDMAP_PROJECTS_DIR: PROJECTS_DIR,   // 数据隔离：子进程也必须指向同一个副本 ✓
            MM_WRITER: 'gui-cli'
          })
        });
      } catch (err) {
        resolve({ ok: false, kind, error: '拉起 CLI 失败：' + ((err && err.message) || err) });
        return;
      }
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (er) => resolve({ ok: false, kind, error: '子进程错误：' + ((er && er.message) || er) }));
      child.on('close', (code) => {
        try { resolve(JSON.parse(out)); }
        catch (parseErr) {
          // 解析不了就把**原文**带回去（红色要能自己解释自己 ✓，不要只丢一个 "failed"）
          resolve({ ok: false, kind, code: code,
            error: (err.trim() || out.trim() || ('CLI 退出码 ' + code)).slice(0, 400) });
        }
      });
    });
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

  ipcMain.handle('app:version', () => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
    catch (err) { return '0.0.0'; }
  });

  /* DSH 侧边栏状态（渲染层只拿状态与几何，绝不拿 token/url） */
  ipcMain.handle('dsh-sidebar:status', () => dshSidebar.getStatus());
  /* 拖宽分隔条：渲染层在交界处 mousedown 时触发（坐标 hit-test 在渲染层做，
   * 主进程用 screen.getCursorScreenPoint 轮询接管拖拽 —— Electron 惯例） */
  ipcMain.on('dsh-sidebar:drag-start', () => dshSidebar.beginWidthDrag());
  ipcMain.on('dsh-sidebar:drag-end', () => dshSidebar.endWidthDrag());
  /* 折叠后的重展开圆钮（渲染层 fab）→ toggle（与菜单 Ctrl+B 同一入口） */
  ipcMain.on('dsh-sidebar:toggle', () => dshSidebar.toggle());
  /* 仅侧边栏模式查询（渲染层/外部 AI 可读状态） */
  ipcMain.handle('dsh-sidebar:dsh-only', () => dshSidebar.isDshOnly());
  /* 导图页右上角那个独立 ✕ 走这里：只关左边导图页（仅侧栏模式），人类点按钮即可 */
  ipcMain.handle('dsh-sidebar:sidebar-only', (_e, on) => {
    dshSidebar.setDshOnly(!!on);
    return dshSidebar.isDshOnly();
  });

  /* ---- 界面状态落盘（v0.16.6「写前协调」的可执行版本） ----
   * 渲染层在脏标记变化时推 app:ui-state → 这里写 projects/<项目>/.ui-state.json。
   * 侧栏 AI 用 `node cli/mm-cli.js ui-state --json` 读它 —— 这是它能真正够到的
   * 通道（旧 IPC dsh-sidebar:ui-dirty 无任何调用方，已删除，见 src/ui-state.js 顶部）。
   * 写失败不致命：读方把"没有文件"当作"界面未运行"，不影响编辑。 */
  function writeUiStateFile(project, dirty) {
    if (!project) return;
    try {
      writeFileAtomic(
        uiState.statePath(path, PROJECTS_DIR, project),
        uiState.serializeState({ project, dirty, uiPid: process.pid }));
    } catch (err) { /* 非致命：读方把"没有文件"当作"界面未运行" */ }
  }
  ipcMain.on('app:ui-state', (e, payload) => {
    const p = payload || {};
    writeUiStateFile(String(p.project || ''), !!p.dirty);
  });
  // 应用退出：界面不再持有任何未保存编辑（否则崩溃/退出前的 dirty=true 会永久吓住 AI）
  app.on('will-quit', () => {
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
  } catch (err) {
    console.log('SMOKE LOAD ERROR — 冒烟断言清单加载失败（很可能是某个 scripts/smoke/*.js 在 require 期抛错）：');
    console.log('  ' + ((err && err.stack) || err));
    app.exit(1);
    return;
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
  const results = [];
  const exec = (js) => win.webContents.executeJavaScript(js);
  // 把 CLI 运行器也交给断言：某些断言需要**先造数据**（如"关联笔记"没有界面创建入口，
  // 只能由 AI/CLI 写入）。`runCli` 在冒烟模式下已把项目根指向临时副本
  // （AI_MINDMAP_PROJECTS_DIR），所以断言用它是安全的 —— 绝不碰真实数据。
  const ctx = { exec, win, runCli: (args) => runCli(args) };
  // 兜底：整个冒烟最长 **140 秒**，防止断言挂起导致进程不退出。
  // ⚠️ 取值要**略小于**验证体系给本步的预算（`docs/VERIFY.md` 里 G5 现在是 150s）：
  //   · 守卫 > 预算时，**挂起**会被报表成"超出预算"（看着像性能问题 ✗，实测踩过）；
  //   · 守卫远小于预算时，真实耗时逼近预算的正常运行会被守卫先掐掉 ⇒ 同一份代码有时
  //     通过、有时判红（历史上 90s 守卫就这么坑过我）。二者留 ~10s 余量最合适。
  // 实测（2026-09-30）：侧栏三条断言原先会顺手孵化一个真服务（40–60s，且随负载抖到 172.7s ✗），
  // 改成 `setNoSpawn(true)` 后它们只要 11.5s ✓ —— 冒烟耗时的大头与抖动源都消失了。
  const guard = setTimeout(() => {
    console.log('SMOKE GUARD TIMEOUT — force exit');
    app.exit(1);
  }, 140000);
  for (const a of assertions) {
    try {
      const r = await a.run(ctx);
      results.push({ name: a.name, ok: !!r.ok, text: String(r.text || '') });
    } catch (err) {
      results.push({ name: a.name, ok: false, text: 'THREW: ' + (err && err.message) });
    }
  }
  // 冒烟断言的条数**到此为止** —— 后面追加的"取景记录/视觉断言"不是冒烟断言，
  // 不能混进这个数字（否则 `docs/VERIFY.md` 的冒烟真值会与运行输出对不上）。
  const smokeCount = results.length;
  let visionStart = -1;   // 视觉断言在 results 里的起始下标（-1 = 没跑）
  // 截图（工程根 smoke-shot.png）+ 落一份**旁路取景记录** smoke-frame.json。
  // 顺序不可交换：先做取景准备（展开全树/禁过渡/清状态栏/等 ≥2 帧），再截图 —— 见 prepareCapture。
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
  const failed = results.filter((r) => !r.ok);
  // 输出**显式给出构成**：冒烟断言 / 视觉断言 / 取景记录 分开报。
  // 为什么必须分开：`docs/VERIFY.md` 的"冒烟断言"真值就是 `scripts/smoke-assertions.js` 的条数，
  // 若把视觉断言混进总数，运行输出会与文档真值对不上（这条数字对不上正是 G6 要防的）。
  const part = (from, to) => {
    const seg = results.slice(from, to);
    return (seg.filter((r) => r.ok).length) + '/' + seg.length;
  };
  const visionFrom = visionStart < 0 ? results.length : visionStart;
  console.log('\n==== SMOKE RESULTS ====');
  results.forEach((r) => console.log('[' + (r.ok ? 'PASS' : 'FAIL') + '] ' + r.name + ' :: ' + r.text));
  const head = filtered ? '==== 过滤运行 ' : '==== ';
  console.log(head + part(0, smokeCount) + ' passed ====');
  console.log('==== 视觉断言（L2 关键区域）: ' + part(visionFrom, results.length) + ' passed ====');
  if (results.length > smokeCount) {
    console.log('==== 另有 ' + (results.length - smokeCount) + ' 条非冒烟结果（取景记录 + 视觉断言），不计入冒烟断言数 ====');
  }
  app.exit(failed.length ? 1 : 0);
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
 * 协议与取舍见 src/control.js：文件 + 轮询（本机受限环境禁命名管道、网络要走代理，
 * 文件是唯一到处都成立的通道）。命令执行**一次**，回执留给调用方读 —— CLI 靠它判"真生效"。
 */
function startControlChannel() {
  const control = require('./src/control.js');
  let dir;
  try { dir = app.getPath('userData'); } catch (err) { return; }
  setInterval(() => {
    const cmd = control.readCommand(dir);
    if (!cmd) return;
    // 三个命令（前两个是"各关一半"的对称能力，第三个是**只读**诊断）：
    //   dsh-only    —— 关左边思维导图页、只留侧栏（改主界面代码时用）
    //   dsh-sidebar —— 保留主界面、关掉侧栏 DSH（改 DSH 那一侧时用；把服务一起停）
    //   dsh-status  —— 只读：读侧栏实况（可见性/总占宽/窄宽模式/是否横向溢出）
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
          rightbarWatcher: s.rightbarWatcher || null
        };
      } catch (err) {
        detail = String((err && err.message) || err);
      }
      try {
        control.writeResult(dir, {
          cmd: 'dsh-status', ok: !!st, status: st, err: detail, at: new Date().toISOString()
        });
      } catch (err2) { /* 回执写不进去：调用方超时 ⇒ 判"没生效" */ }
      control.clearCommand(dir);
      return;
    }
    if (cmd.cmd !== 'dsh-only' && cmd.cmd !== 'dsh-sidebar') return;
    let ok = false;
    let detail = '';
    try {
      if (cmd.cmd === 'dsh-only') dshSidebar.setDshOnly(!!cmd.on);
      else if (cmd.on) dshSidebar.show();
      else dshSidebar.closeSidebar();
      ok = true;
    } catch (err) {
      detail = String((err && err.message) || err);
    }
    try {
      control.writeResult(dir, {
        cmd: cmd.cmd, ok: ok,
        state: ok ? (cmd.cmd === 'dsh-only' ? dshSidebar.isDshOnly() : dshSidebar.isVisible()) : null,
        err: detail, at: new Date().toISOString()
      });
    } catch (err2) { /* 回执写不进去：调用方会超时 → 判"没生效"，不会静默成功 */ }
    control.clearCommand(dir);
  }, 400);
}

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
    // 只关左边导图页、留侧栏走**导图页右上角那个独立 ✕**（renderer/app.js 里动态插入的
    // `#btn-close-map` ⇒ `dsh-sidebar:sidebar-only` ⇒ setDshOnly(true)）。
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
