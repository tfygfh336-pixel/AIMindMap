/* ============================================================
 * tests/dsh-sidebar-load.test.js — 侧栏「页面加载失败」的判定分档（r12 收口批）
 * ------------------------------------------------------------
 * **为什么必须新建这个文件**（不是"顺手补一份"）：
 *   vitest 跑的 **142** 份用例里（本批之前），**没有一个** require 过 `main-dsh-sidebar.js`（只有几份把它当**文本**
 *   读来做结构断言）—— 也就是说「侧栏加载失败该怎么报」这条路径**此前完全没有门禁**。
 *   这正是定题 §3 那 4 条良性噪声能活下来的条件：旧写法 `loadURL(...).catch(log)` 让
 *   "良性 -3" 与 "真失败 -2" 在日志里**长得一模一样**，没有任何东西能区分它们，也就没有人能判红。
 *
 * 这一份测的是**分流**本身，四条判据各自成组（编号与定题 §3.5 的表对齐）：
 *   ① 该红的必须红 —— `errorCode !== -3` 立刻报错并点名（含认不出的码）；
 *   ② 该绿的必须绿 —— `-3` 且随后同一 webContents `did-finish-load` ⇒ 不报；
 *   ③ 边界 —— `-3` 之后再没有一次成功、且视图仍可见 ⇒ 必须红（还在加载时**不许**假红）；
 *   ④ 不许把日志关掉 —— 非 `-3` 的失败照样有输出（给原始报文），哪怕前面刚吸收过一串 `-3`。
 *
 * 三层都打，验的是**同一份实现**（不另写"测试用的判定"，那种第二份实现是本工程反复治过的病）：
 *   L1 `__createStatusPageLoadTracker()` —— 纯状态机（零 Electron、零定时器，时钟可注入）；
 *   L2 `attachLoadDiagnostics(wc)`       —— **真事件名 + 真参数顺序**（`ensureView()` 用的就是这个函数，
 *                                          这里拿 EventEmitter 当 webContents）；
 *   L3 `loadUrlTracked` / `settleStatusPageLoad` —— `loadURL()` 的 rejection 兜底与"唯一打印处"。
 * ============================================================ */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidebar = require('../main-dsh-sidebar.js');
const {
  __createStatusPageLoadTracker: createTracker,
  __STATUS_PAGE_ABORT_SETTLE_MS: SETTLE_MS,
  __STATUS_PAGE_ABORT_MAX_WAIT_MS: MAX_WAIT_MS,
  attachLoadDiagnostics,
  settleStatusPageLoad,
  loadUrlTracked
} = sidebar;

/** 状态页就是 `data:` 页（`PAGE_STARTING` / `errorPageHtml` 的形态，前缀也跟着它分流） */
const DATA_URL = 'data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E%3Cbody%3E%E5%90%AF%E5%8A%A8%E4%B8%AD%3C%2Fbody%3E';
/** DSH 页面本体（`loadCurrentUrl()` 载的那个） */
const PAGE_URL = 'http://127.0.0.1:6218/?token=abcdef';

/** 可注入的时钟：判定器里**没有** `Date.now()` 直连，时间必须由调用方喂（否则单测要真睡 3s） */
function fakeClock(start) {
  let t = typeof start === 'number' ? start : 1000;
  const f = () => t;
  f.advance = (ms) => { t += ms; return t; };
  return f;
}

/** 假 webContents：挂载处只要 `.on`，包装处只要 `.loadURL` —— 两个都真的被调用到了 */
function fakeWebContents(loadURLImpl) {
  const wc = new EventEmitter();
  wc.loadURL = loadURLImpl || (() => Promise.resolve());
  return wc;
}

/** 捕获模块级 `log()` 打出去的行（`loadUrlTracked` / 定时器走的是产品那个出口，不是注入的） */
function captureLog() {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  return lines;
}

/** L2 夹具：真 `attachLoadDiagnostics` + 记下**打出去的每一行**（不 mock 判定，只接输出） */
function harness(opts) {
  const clock = (opts && opts.clock) || fakeClock();
  const tracker = createTracker({ now: clock });
  const lines = [];
  const deferred = [];
  const wc = fakeWebContents(opts && opts.loadURL);
  attachLoadDiagnostics(wc, {
    tracker: tracker,
    log: (m) => lines.push(m),
    onDeferred: () => deferred.push(clock())
  });
  const emitFail = (code, desc, url, isMainFrame) => wc.emit('did-fail-load', {},
    code, desc, url, isMainFrame === undefined ? true : isMainFrame);
  const emitFinish = () => wc.emit('did-finish-load', {});
  return { wc, tracker, clock, lines, deferred, emitFail, emitFinish };
}

afterEach(() => { vi.restoreAllMocks(); });

/* ============================================================
 * ① 该红的必须红：`errorCode !== -3` ⇒ 立刻报错并**点名**
 * ============================================================ */
describe('① 该红的必须红：非 -3 的失败立刻报错，且码/描述/URL 都在报文里', () => {
  it('-2（加载途中被销毁）⇒ 一行错误，点名 ERR_FAILED (-2)', () => {
    const h = harness();
    h.emitFail(-2, 'ERR_FAILED', DATA_URL);
    expect(h.lines.length).toBe(1);
    expect(h.lines[0]).toContain('状态页加载失败:');
    expect(h.lines[0]).toContain('ERR_FAILED');
    expect(h.lines[0]).toContain('(-2)');
    expect(h.lines[0]).toContain(DATA_URL.slice(0, 40));
    expect(h.tracker.snapshot().reported).toBe(1);
    expect(h.tracker.snapshot().pending).toBe(0);   // 非 -3 **不挂起**，当场判
  });

  it('-102（连不上）在 DSH 页面上 ⇒ 前缀是"侧栏页面加载失败"，URL 为 http 那个（不是状态页）', () => {
    const h = harness();
    h.emitFail(-102, 'ERR_CONNECTION_REFUSED', PAGE_URL);
    expect(h.lines.length).toBe(1);
    expect(h.lines[0]).toContain('侧栏页面加载失败:');
    expect(h.lines[0]).toContain('ERR_CONNECTION_REFUSED (-102)');
    expect(h.lines[0]).toContain(PAGE_URL);
  });

  it('-105（名字解析不了）⇒ 一样响亮', () => {
    const h = harness();
    h.emitFail(-105, 'ERR_NAME_NOT_RESOLVED', 'http://dsh.invalid/');
    expect(h.lines.length).toBe(1);
    expect(h.lines[0]).toContain('(-105)');
    expect(h.tracker.snapshot().reported).toBe(1);
  });

  it('★ 认不出的码（事件里根本没给 code）⇒ **照样报**，报文写「未知码」（宁可吵，不许静默吞）', () => {
    const h = harness();
    h.emitFail(undefined, undefined, DATA_URL);
    expect(h.lines.length).toBe(1);
    expect(h.lines[0]).toContain('未知码');
    expect(h.tracker.snapshot().reported).toBe(1);
  });

  it('子框架的失败不算这个视图的加载失败（isMainFrame=false ⇒ 只计数，不打印）', () => {
    const h = harness();
    h.emitFail(-2, 'ERR_FAILED', 'http://127.0.0.1:6218/iframe', false);
    expect(h.lines.length).toBe(0);
    expect(h.tracker.snapshot().subframeIgnored).toBe(1);
    expect(h.tracker.snapshot().reported).toBe(0);
  });
});

/* ============================================================
 * ② 该绿的必须绿：`-3` + 随后 `did-finish-load` ⇒ 不报错
 *    这就是"良性"的**机械定义**：不是相信它良性，而是它后面确实跟着一次成功。
 * ============================================================ */
describe('② 该绿的必须绿：-3 挂起，随后同一 webContents 加载成功 ⇒ 一条错都不报', () => {
  it('-3 ⇒ 挂起（不打印、标记 deferred）；did-finish-load ⇒ 吸收，结算无话可说', () => {
    const h = harness();
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    expect(h.lines.length).toBe(0);                 // ★ 不是"降级成一行"，是**一条都不打**
    expect(h.deferred.length).toBe(1);              // 但调用方知道要排结算（否则挂起就没人管了）
    expect(h.tracker.snapshot().pending).toBe(1);
    h.emitFinish();
    expect(h.lines.length).toBe(0);
    const snap = h.tracker.snapshot();
    expect(snap.aborted).toBe(1);
    expect(snap.absorbed).toBe(1);                  // 观测面在这里：它发生过，只是不吵
    expect(snap.reported).toBe(0);
    expect(snap.pending).toBe(0);
    expect(h.tracker.settle({ visible: true, hasView: true, waitedMs: SETTLE_MS, stillLoading: false }).action)
      .toBe('none');
    expect(h.lines.length).toBe(0);
  });

  it('★ 历史形态（定题 §3.4 的 4 == 5-1）：5 次重刷、前 4 次被顶掉、第 5 次成功 ⇒ 4 条全吸收、0 条报错', () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      h.tracker.navigate();
      h.emitFail(-3, 'ERR_ABORTED', DATA_URL);      // 第 i 次还没加载完就被第 i+1 次顶掉
    }
    h.tracker.navigate();                            // 第 5 次：没人顶它
    expect(h.lines.length).toBe(0);
    h.emitFinish();                                  // 第 5 次自己成功了
    const snap = h.tracker.snapshot();
    expect(snap.aborted).toBe(4);
    expect(snap.absorbed).toBe(4);
    expect(snap.reported).toBe(0);
    expect(h.lines.length).toBe(0);
  });

  it('视图销毁（用户真关）⇒ 挂起中的 -3 只报告，不判红', () => {
    const h = harness();
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.tracker.onViewDestroyed();
    expect(h.tracker.snapshot().dropped).toBe(1);
    expect(h.tracker.snapshot().pending).toBe(0);
    expect(h.tracker.settle({ visible: true, hasView: true, waitedMs: SETTLE_MS }).action).toBe('none');
  });
});

/* ============================================================
 * ③ 边界：`-3` 之后**再没有任何一次成功**且该 view 仍可见 ⇒ 必须红
 *    （"顶掉它的那一次自己也没成" —— 侧栏可能停在空白/错误页）
 * ============================================================ */
describe('③ 边界：-3 之后没有成功、侧栏仍可见 ⇒ 必须红（仍在加载时**不许**假红）', () => {
  it('到点结算 ⇒ 报错，点名 (-3) 并写明"再没有一次成功的加载"', () => {
    const h = harness();
    h.clock.advance(10);
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    expect(h.lines.length).toBe(0);                  // 挂起期间仍然安静
    h.clock.advance(SETTLE_MS);
    const r = h.tracker.settle({ visible: true, hasView: true, stillLoading: false, waitedMs: SETTLE_MS });
    expect(r.action).toBe('error');
    expect(r.message).toContain('状态页加载失败:');
    expect(r.message).toContain('(-3)');
    expect(r.message).toContain('再没有一次成功的加载');
    expect(r.message).toContain('侧栏仍可见');
    const snap = h.tracker.snapshot();
    expect(snap.reported).toBe(1);
    expect(snap.lastFailure.code).toBe(-3);
    expect(snap.lastAbort.outcome).toBe('red');      // 这一档**不是**被吸收
  });

  it('★ 那次导航**还在加载** ⇒ 不许判死（action=pending）；等满上限才判红（防 3s 假红 & 防挂死永远不红）', () => {
    const h = harness();
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    const early = h.tracker.settle({ visible: true, hasView: true, stillLoading: true, waitedMs: SETTLE_MS });
    expect(early.action).toBe('pending');            // 大页面首载要几秒 ⇒ 3s 到点不等于失败
    expect(h.lines.length).toBe(0);
    const late = h.tracker.settle({ visible: true, hasView: true, stillLoading: true, waitedMs: MAX_WAIT_MS });
    expect(late.action).toBe('error');               // 挂死了就该红（否则"永远不判"）
    expect(MAX_WAIT_MS).toBeGreaterThan(SETTLE_MS);
  });

  it('侧栏不可见 / 视图不在 ⇒ 只报告，不红（用户自己关的，不是加载失败）', () => {
    const a = harness();
    a.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    expect(a.tracker.settle({ visible: false, hasView: true, waitedMs: SETTLE_MS }).action).toBe('report');
    expect(a.lines.length).toBe(0);
    const b = harness();
    b.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    expect(b.tracker.settle({ visible: true, hasView: false, waitedMs: SETTLE_MS }).action).toBe('report');
    expect(b.lines.length).toBe(0);
  });

  it('顶上去的那一次自己按 -2 报过 ⇒ 同一次事故只留一条响亮的话（-3 不再重复红）', () => {
    const h = harness();
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.emitFail(-2, 'ERR_FAILED', DATA_URL);
    expect(h.lines.length).toBe(1);                  // 已经有一条点名 -2 的
    const r = h.tracker.settle({ visible: true, hasView: true, stillLoading: false, waitedMs: SETTLE_MS });
    expect(r.action).toBe('report');
    expect(h.lines.length).toBe(1);                  // 没有第二条
    expect(h.tracker.snapshot().reported).toBe(1);
  });
});

/* ============================================================
 * ④ 不许把日志关掉：非 -3 的失败**照样有输出**（且前面刚吸收过一串 -3 也一样）
 * ============================================================ */
describe('④ 不许把日志关掉：非 -3 的失败照样有输出（给原始报文）', () => {
  it('★ 先吸收一串 -3，再注入一次 -102 ⇒ 那一行照样出来（证明不是"把噪声删掉"）', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.emitFinish();
    expect(h.lines.length).toBe(0);                  // 良性噪声确实消失了
    h.emitFail(-102, 'ERR_CONNECTION_REFUSED', PAGE_URL);
    expect(h.lines.length).toBe(1);                  // ★ 但真失败仍在
    expect(h.lines[0]).toBe('侧栏页面加载失败: ERR_CONNECTION_REFUSED (-102) ' + PAGE_URL);
  });

  it('同一条 webContents 上 4 条 -3 + 1 条真失败 ⇒ 输出恰 1 条（噪声按构造消掉，失败一条不少）', () => {
    const h = harness();
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.emitFail(-3, 'ERR_ABORTED', DATA_URL);
    h.emitFail(-2, 'ERR_FAILED', PAGE_URL);
    expect(h.lines.length).toBe(1);
    expect(h.lines[0]).toContain('ERR_FAILED (-2)');
  });

  it('长 URL 截断，但**码与描述永远在**（截断不会把"是哪个错误"截掉）', () => {
    const h = harness();
    const longUrl = DATA_URL + 'x'.repeat(2000);
    h.emitFail(-2, 'ERR_FAILED', longUrl);
    expect(h.lines[0]).toContain('ERR_FAILED (-2)');
    expect(h.lines[0].length).toBeLessThan(400);
    expect(h.lines[0]).toContain('…');
  });
});

/* ============================================================
 * ⑤ `loadURL()` 的 rejection 兜底：走**同一套**判定，且与 `did-fail-load` 去重
 *    （真实路径上同一次失败会同时到达两条 —— 不去重就会刷两条一模一样的行）
 * ============================================================ */
describe('⑤ loadURL 的 rejection：同一套判定 + 与 did-fail-load 去重（不刷两条）', () => {
  const readout = () => sidebar.getStatus().statusPageLoad;

  it('rejection 里认得出 errno=-2 ⇒ 照样报错并点名（不因为"不是 did-fail-load"就吞掉）', async () => {
    const lines = captureLog();
    const wc = fakeWebContents(() => Promise.reject(Object.assign(
      new Error('ERR_FAILED (-2) loading \'' + DATA_URL + '\''),
      { errno: -2, code: 'ERR_FAILED', url: DATA_URL })));
    const before = readout().reported;
    await loadUrlTracked(wc, DATA_URL);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('状态页加载失败: ERR_FAILED (-2)');
    expect(readout().reported).toBe(before + 1);
  });

  it('★ 同一次 -3 既到 did-fail-load 又到 rejection ⇒ **不打印**，且只记一次（挂起不叠加）', async () => {
    const lines = captureLog();
    const wc = fakeWebContents(() => Promise.reject(Object.assign(
      new Error('ERR_ABORTED (-3) loading \'' + DATA_URL + '\''),
      { errno: -3, code: 'ERR_ABORTED', url: DATA_URL })));
    // 挂载处与包装处都用产品那个判定器（默认 tracker），去重才可能发生
    attachLoadDiagnostics(wc, { log: (m) => lines.push(m) });
    const before = readout();
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', DATA_URL, true);
    await loadUrlTracked(wc, DATA_URL);              // rejection 是同一个物理失败的第二次通报
    expect(lines.length).toBe(0);
    const after = readout();
    expect(after.aborted - before.aborted).toBe(1);  // 只挂起一次
    expect(after.deduped - before.deduped).toBe(1);  // 第二条被去重
  });

  it('loadURL **同步抛**也算失败，照样报（旧写法在这里会漏）', async () => {
    const lines = captureLog();
    const wc = fakeWebContents(() => { throw Object.assign(new Error('bad url'), { errno: -300, code: 'ERR_INVALID_URL' }); });
    await loadUrlTracked(wc, 'nonsense:');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('(-300)');
  });

  it('loadUrlTracked **不把 rejection 抛回去**（调用方都是 fire-and-forget，抛回去就是未捕获异常）', async () => {
    captureLog();
    const wc = fakeWebContents(() => Promise.reject(Object.assign(new Error('x'), { errno: -2, code: 'ERR_FAILED' })));
    await expect(loadUrlTracked(wc, DATA_URL)).resolves.toBeNull();
  });

  it('★ 4 条 -3 rejection **不许互相去重**（否则 aborted 永远是 1，"4 == 5-1" 那条对账就假了）', async () => {
    const lines = captureLog();
    sidebar.__resetStatusPageLoadTrackerForTest();
    const wc = rejectsAborted();
    attachLoadDiagnostics(wc, { log: (m) => lines.push(m) });
    for (let i = 0; i < 4; i++) await loadUrlTracked(wc, DATA_URL);   // 4 次真 -3（每次都是一次独立导航）
    const mid = readout();
    expect(mid.aborted).toBe(4);          // ← 这条就是"读数不许被去重吃掉"
    expect(mid.deduped).toBe(0);
    expect(mid.pending).toBe(4);
    expect(lines.length).toBe(0);
    wc.emit('did-finish-load', {});       // 第 5 次自己成功了（定题 §3.4 的形态）
    expect(readout().absorbed).toBe(4);
    expect(readout().pending).toBe(0);
    expect(lines.length).toBe(0);
    sidebar.__resetStatusPageLoadTrackerForTest();
  });
});

/** 一条"被顶掉的导航"：`loadURL` 以 `ERR_ABORTED (-3)` 拒绝（真机上 -3 只从这条路来） */
function rejectsAborted() {
  return fakeWebContents(() => Promise.reject(Object.assign(
    new Error('ERR_ABORTED (-3) loading \'' + DATA_URL + '\''),
    { errno: -3, code: 'ERR_ABORTED', url: DATA_URL })));
}

/* ============================================================
 * ⑥ 结构：失败判定**不在** `showStatusPage` 里（它只委派），唯一挂载处是 `did-fail-load`
 *    这一组是**回归闸**，不是主判据（判据是 ①–⑤ 的行为读数，见文件头 `RULES.md` §4 第 21 条）。
 * ============================================================ */
describe('⑥ 结构：判定不散落在调用点，挂载处唯一', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main-dsh-sidebar.js'), 'utf8');

  it('`showStatusPage` 只委派 `loadUrlTracked`，体内没有 catch（旧写法就是那句无条件 log）', () => {
    const m = /function showStatusPage\(html\) \{([\s\S]*?)\n\}/.exec(src);
    expect(m).toBeTruthy();
    const body = m[1];
    expect(body).toContain('loadUrlTracked(');
    expect(body).not.toContain('.catch(');
    expect(body).not.toContain('log(');
  });

  it('`did-fail-load` 只挂一处，侧栏视图的 `loadURL` 全部经唯一包装（两个调用点）', () => {
    const mounts = src.split("on('did-fail-load'").length - 1;
    expect(mounts).toBe(1);
    // 侧栏视图**再也没有**裸 loadURL 的调用点（旧写法就长在那里）；rail / 面板是另外两个视图，
    // 各有自己的兜底，不在这条判定里 —— 所以只钉 `state.view.webContents.loadURL(`
    const bare = src.split('state.view.webContents.loadURL(').length - 1;
    expect(bare).toBe(0);
    const wrapped = src.split('loadUrlTracked(state.view.webContents').length - 1;
    expect(wrapped).toBe(2);                             // showStatusPage + loadCurrentUrl
    expect(src).toContain('try { p = webContents.loadURL(url); }');
  });

  it('读数进了状态出口：`getStatus().statusPageLoad` 有计数与"最近一次 -3 的收束"', () => {
    const s = sidebar.getStatus().statusPageLoad;
    expect(typeof s.aborted).toBe('number');
    expect(typeof s.absorbed).toBe('number');
    expect(typeof s.reported).toBe('number');
    expect(s.settleMs).toBe(SETTLE_MS);
    expect('lastAbort' in s).toBe(true);
    expect('lastFailure' in s).toBe(true);
  });
});

/* ============================================================
 * ⑦ **定时器闭环**（真 setTimeout，假时钟推进；不手动调结算）
 *   这是探针里那条边界（真 -3 + 真在加载 ⇒ 3s 不红、15s 才红）在门禁里的等价物：
 *   没有它，那条判据就只活在一次 Electron 冷启动里，CI 天天跑不到 ⇒ 会腐坏没人知道。
 * ============================================================ */
describe('⑦ 定时器闭环：3s 先挂回（不假红），过了上限由定时器自己判红', () => {
  afterEach(() => {
    sidebar.__setStatusPageSettleFactsForTest(null);
    sidebar.__resetStatusPageLoadTrackerForTest();
    vi.useRealTimers();
  });

  it('★ 那次导航一直"还在加载"：3s 时零输出且仍挂起；15s 到上限后自己打出一行红', async () => {
    vi.useFakeTimers();
    sidebar.__resetStatusPageLoadTrackerForTest();
    const lines = captureLog();
    sidebar.__setStatusPageSettleFactsForTest(() => ({ visible: true, hasView: true, stillLoading: true }));
    await loadUrlTracked(rejectsAborted(), DATA_URL);
    expect(sidebar.getStatus().statusPageLoad.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 200);
    expect(lines.length).toBe(0);                    // 第一轮：判不了就挂回
    expect(sidebar.getStatus().statusPageLoad.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - SETTLE_MS + 1500);
    expect(lines.length).toBe(1);                    // 第二轮：等够了 ⇒ 必须红
    expect(lines[0]).toContain('(-3)');
    expect(lines[0]).toContain('再没有一次成功的加载');
    expect(sidebar.getStatus().statusPageLoad.pending).toBe(0);
    expect(sidebar.getStatus().statusPageLoad.lastAbort.outcome).toBe('red');
  });

  it('那次导航**不在**加载（isLoading=false）⇒ 第一轮（3s）就该红，不必等到上限', async () => {
    vi.useFakeTimers();
    sidebar.__resetStatusPageLoadTrackerForTest();
    const lines = captureLog();
    sidebar.__setStatusPageSettleFactsForTest(() => ({ visible: true, hasView: true, stillLoading: false }));
    await loadUrlTracked(rejectsAborted(), DATA_URL);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 200);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('(-3)');
  });

  it('视图已经不在了 ⇒ 定时器只报告、不打印（用户真关掉的不算加载失败）', async () => {
    vi.useFakeTimers();
    sidebar.__resetStatusPageLoadTrackerForTest();
    const lines = captureLog();
    sidebar.__setStatusPageSettleFactsForTest(() => ({ visible: false, hasView: false, stillLoading: false }));
    await loadUrlTracked(rejectsAborted(), DATA_URL);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 200);
    expect(lines.length).toBe(0);
    expect(sidebar.getStatus().statusPageLoad.pending).toBe(0);
    expect(sidebar.getStatus().statusPageLoad.dropped).toBe(1);
  });
});
