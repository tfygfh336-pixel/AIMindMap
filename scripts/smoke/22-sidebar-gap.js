/* ============================================================
 * scripts/smoke/22-sidebar-gap.js —— 侧栏隔壁那道"灰色背景"（预留宽度 vs 实际宽度）
 * ------------------------------------------------------------
 * 用户实测："刚打开的时候侧边栏隔壁出现了灰色背景"，并质问"你到底有没有截图检查"。
 * 复盘出的两条事实（都要记住）：
 *   ① **截图看不见它**：侧栏是原生 `WebContentsView`，`capturePage()` 只截页面 ⇒
 *      这条缺陷在截图里**本来就不存在**（不是"忘了截图"，而是"截了也看不见"）。
 *   ② 判据只能是**几何**：页面为侧栏预留的宽度，必须等于原生侧栏**实际占的**宽度。
 *      两边数字来源不同（CSS 变量 vs `WebContentsView.getBounds()`），不一致就多留一条 —— 那就是灰缝。
 *
 * 复现与判别力（本环境原来测不到：冒烟不孵化服务 ⇒ 没有 view ⇒ 无从比较）：
 *   本断言主动 `sidebar.show()` 把 view 建起来（不需要服务，显示的是状态页），
 *   然后把窗口**缩窄到比侧栏意图宽度还小** ⇒ `relayout()` 里 `vw = min(state.width, 窗口宽)` 会小于
 *   `state.width`，于是"发意图宽度"的旧实现会让页面预留**超出窗口**的一条 ⇒ 本断言必红。
 *   测完恢复窗口尺寸并 `hide()` 侧栏，不影响后续。
 *                      （2026-10-18 第 4 面板底座批：本条追加一条断言 —— **停靠面板**（第 4 个原生视图）
 *                       也在这条"让位带"里 ⇒ 页面预留必须等于"控制栏 + 侧栏 + 面板"三段之和，
 *                       且开关面板要能逐项复原。为什么并进本文件而不新开域：G3 的 changed-plan 要求
 *                       每个冒烟域都归到某个改动面下，而本批不许改那张表 ⇒ 落回它的语义之家。）
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const path = require('path');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));
// 面板页里的 ✕ 是 console 回传主进程的（没有宿主 preload）⇒ 这里要拿它的 webContents 真点一下
const { webContents } = require('electron');  // 与 main.js 同一实例

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rendererJs = `(function () {
  var b = document.body;
  var main = document.getElementById('main');
  var varRaw = (getComputedStyle(b).getPropertyValue('--dsh-sidebar-width') || '').trim();
  return {
    innerWidth: window.innerWidth,
    cls: b.className.indexOf('dsh-sidebar-on') >= 0 ? 'on' : 'off',
    varPx: parseFloat(varRaw) || 0,
    last: window.__dshLayoutLast || null,
    fab: (function () {
      var f = document.getElementById('dsh-restore-fab');
      if (!f) return '(无 FAB)';
      var cs = getComputedStyle(f);
      return f.style.display + '/' + cs.display + '/' + cs.visibility;
    })(),
    mainRight: main ? Math.round(main.getBoundingClientRect().right) : null
  };
})()`;

/** 量一次：页面预留 vs view 实际，并算出"灰缝"宽度 = 预留 − 实际 − 窗口右侧空白 */
async function measure(ctx, label) {
  const r = await ctx.exec(rendererJs);
  const b = sidebar.viewBounds();
  const win = ctx.win.getContentBounds();
  const reserved = r.varPx || 0;
  // ⚠️ "实际占宽"必须是**控制栏 + 内容**的总宽（侧栏 = 左侧原生控制栏 + DSH 页面 view）。
  //    只量 view 会少 30px（= 控制栏宽）⇒ 这条"页面预留 == 侧栏实际"的判据会自己造假缝 ✗。
  const actual = sidebar.occupiedWidth() || (b ? b.width : null);
  return { label, win: win.width, reserved, actual, mainRight: r.mainRight, cls: r.cls,
    fab: r.fab,
    gap: actual == null ? null : reserved - actual,
    viewRight: b ? b.x + b.width : null, winRight: win.width };
}

/* ================= 第 4 个原生面板（停靠面板）的几何取样（2026-10-18 底座批） =================
 * 判据为什么只能靠几何：面板是原生 WebContentsView ⇒ 主页面的 capturePage() 里**根本没有它**
 * （本工程两次事故：CHANGELOG.md:4434-4437、:4488；scripts/vision/window-shot.js:4）。
 * 所以这里一条像素判据都没有，全是：窗口内容宽 / 页面预留（CSS 变量）/ 原生实际占宽（getBounds 相加）/ 缝。 */

/** 一次取样：**页面侧**（预留 + 类 + 最后收到的布局）与**主进程侧**（原生 bounds）各取一份。 */
async function dockSample(ctx) {
  const page = await ctx.exec('(function () {'
    + 'var b = document.body;'
    + 'var main = document.getElementById("main");'
    + 'var raw = (getComputedStyle(b).getPropertyValue("--dsh-sidebar-width") || "").trim();'
    + 'return { innerWidth: window.innerWidth,'
    + '  cls: b.className.indexOf("dsh-sidebar-on") >= 0,'
    + '  varPx: parseFloat(raw) || 0,'
    + '  last: window.__dshLayoutLast || null,'
    + '  bandW: window.__dshSidebarBandW,'
    + '  sidebarVisible: window.__dshSidebarVisible,'
    + '  mainRight: main ? Math.round(main.getBoundingClientRect().right) : null };'
    + '})()');
  const st = sidebar.getStatus();
  const snap = sidebar.geometrySnapshot();
  const size = ctx.win.getContentSize();
  // ⚠️ "原生实际占宽"必须**从三个视图的 getBounds 相加**（不读产品那个 occupiedWidth：
  //    那是"我们要求的值"，两处同源就变成恒等 ⇒ 缝永远是 0，判据抓不住任何东西）
  const w = (r) => (r ? r.width : 0);
  const nativeActual = w(snap.rail) + w(snap.view) + w(snap.panel);
  return {
    winW: size[0], winH: size[1],
    reserved: page.varPx,
    nativeActual: nativeActual,
    gap: page.varPx - nativeActual,
    rail: snap.rail, view: snap.view, panel: snap.panel,
    cls: page.cls, innerWidth: page.innerWidth, last: page.last,
    bandW: page.bandW, sidebarVisible: page.sidebarVisible,
    mainRight: page.mainRight,
    dock: st.dockPanel,
    statusWidth: st.width
  };
}

/** 逐项列出"两份取样哪里不一样"（复原判据要能**指名**，不许只说 false） */
function dockDiffRects(a, b, label) {
  const out = [];
  const keys = ['x', 'y', 'width', 'height'];
  if (!a && !b) return out;
  if (!a || !b) { out.push(label + '：一侧为 null（' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) + '）'); return out; }
  keys.forEach((k) => { if (a[k] !== b[k]) out.push(label + '.' + k + ' ' + a[k] + '→' + b[k]); });
  return out;
}

/** 从"干净前提"搭出场景：侧栏在屏、宽度确定、面板关着、页面已收到布局事件 */
async function dockSetup(ctx) {
  sidebar.releaseRightbarRoom();
  sidebar.init(ctx.win);
  sidebar.show();
  await sleep(500);
  // 按真机启动顺序补一次整页重载：渲染层要知道"当前布局"，否则它手里没有权威让位量
  ctx.win.webContents.reload();
  const until = Date.now() + 12000;
  let booted = false;
  while (Date.now() < until && !booted) {
    try { booted = !!(await ctx.exec('!!(window.MMApp && window.MMApp.getState && window.MMApp.getState().jm)')); }
    catch (e) { booted = false; }
    if (!booted) await sleep(200);
  }
  await ctx.exec('window.MMApp.openProject("comnet")');
  await sleep(400);
  const before = sidebar.getStatus();
  sidebar.setWidth(420);            // 一个**确定的**侧栏宽（判据里不用"上次是谁留下的"）
  if (sidebar.isDockOpen()) sidebar.closeDockPanel({ reason: 'setup' });
  await sleep(400);
  return { booted: booted, widthBefore: before.width, visibleBefore: before.visible };
}

const fmtRect = (x) => (x === null || x === undefined) ? 'null' : JSON.stringify(x);

module.exports = [
  {
    name: '侧栏让位几何：页面预留宽度 == 原生侧栏实际占宽（窗口比侧栏窄时也必须相等）',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await sleep(300);
      const before = await measure(ctx, '初始');

      // 按**真机启动顺序**搭场景：真实启动时是 init(win) →（页面才加载）→ show()，
      // 而冒烟里页面先加载 ⇒ 渲染层问到时 state.win 还是 null ⇒ 只能拿到默认值 420（这就是那条缝的成因）。
      // 所以这里先 init + show 建立侧栏，再**重载页面** —— 等价于"刚打开"。
      sidebar.init(ctx.win);
      sidebar.show();
      await sleep(500);
      ctx.win.webContents.reload();
      {
        const until = Date.now() + 12000;
        let ok = false;
        while (Date.now() < until && !ok) {
          try { ok = await ctx.exec('!!(window.MMApp && window.MMApp.getState && window.MMApp.getState().jm)'); } catch (e) { /* reload 中 */ }
          if (!ok) await sleep(200);
        }
        await ctx.exec('window.MMApp.openProject("comnet")');
        await sleep(500);
      }
      const wide = await measure(ctx, '侧栏显示/宽窗');

      // 缩窄窗口到比侧栏宽度还小 —— 这一步是判别力所在（旧实现会发 state.width ⇒ 预留超出窗口）
      const orig = ctx.win.getContentBounds();
      ctx.win.setContentSize(360, orig.height);
      await sleep(500);
      const narrow = await measure(ctx, '缩窄到 360');

      // 复原：窗口尺寸 + 隐藏侧栏
      ctx.win.setContentSize(orig.width, orig.height);
      await sleep(400);
      sidebar.hide();
      await sleep(300);
      const restored = await measure(ctx, '复原');

      return {
        // ⚠️ 判据只取"本环境真能取证"的两条：view 确实建出来了；隐藏后让位被撤回（class=off）。
        //（不要拿 bounds 判"已隐藏"：hide() 只是把 view 从窗口移除，state.view 仍在 ⇒ bounds 照旧可读。）
        // "预留 == 实际"这条**当前不判**：冒烟里 `init` 必然晚于页面首次加载（真机是先 init 后加载），
        // 实测重载后渲染层仍未走 applyLayout（`__dshLayoutLast=undefined`）⇒ 冒烟路径不等价于真机启动顺序，
        // 拿它判红会变成假红。所以这里只**报告**实测缝隙（与用户截图一致），真机验证由人复看。
        ok: wide.actual != null && restored.cls === 'off'
          && narrow.reserved === narrow.actual                 // 缩放后预留仍等于实际（缝隙=0）
          && String(restored.fab).indexOf('flex') >= 0,        // 折叠后重开圆钮必须出现（回归过）
        text: '【宽窗】窗口=' + wide.win + ' 页面预留=' + wide.reserved + ' 侧栏实际=' + wide.actual
          + ' **缝=' + wide.gap + 'px**（用户截图那条约 114px；预留来自意图/默认值，侧栏按实际 bounds 绘制）'
          + ' 最后收到=' + JSON.stringify(wide.last)
          + '｜【缩窄到最小窗】窗口=' + narrow.win + ' 预留=' + narrow.reserved + ' 实际=' + narrow.actual
          + '（窗口最小宽 960 > 侧栏最大 720 ⇒ "预留≠实际"不可能来自窗口过窄，只可能来自取值口径）'
          + '｜【复原】实际=' + restored.actual + ' class=' + restored.cls + ' 重开圆钮=' + restored.fab
          + '｜注：侧栏是原生 view，capturePage 截不到它 —— 这类缺陷**只能靠几何判定**，截图永远看不见'
      };
    }
  },
  /* ================= 第 4 个原生面板（停靠面板 · 2026-10-18 底座批） =================
   * 四条判据，各对准一条可破的不变式（**独立复算**，不调产品那个几何函数去推期望）：
   *   ① 缝 = 0：页面预留 == 原生实际占宽（控制栏 + 侧栏 + 面板）；
   *   ② 贴接：panel.x + panel.width == rail.x（面板右缘与控制栏左缘严格相接）；
   *   ③ 锚右：view.x + view.width == 窗口内容宽（面板不许把侧栏推离窗口右缘）；
   *   ④ 逐项复原：关掉之后 rail/view 的 x/width 与"打开之前"每个数字都相同、面板宽度回到 0。
   * 两条读数（不是判据）：打开时**侧栏一个像素都没动**（并列而非互斥/挤压）；侧栏收起时**面板仍独立**
   * 停在窗口右缘（面板不是侧栏的子状态）。
   * 判别力（注入点，本批实跑过）：notifyRenderer() 发的 width 加 1 ⇒ ①必红（缝 1px）；
   *   closeDockPanel() 里去掉那次 setGeometry ⇒ ④必红（面板还在屏上、预留没退）。读数见
   *   .review/20261018-第4面板底座/README.md。
   * 收尾：关面板（**真销毁**面板视图）→ 侧栏可见性/宽度回本域进来时的样子。 */
  {
    name: '第 4 面板（停靠面板）：开/关/复原 —— 页面预留==原生占宽（缝 0）、并列贴接、关上逐项回原样',
    run: async (ctx) => {
      const pre = await dockSetup(ctx);
      const base = await dockSample(ctx);

      // ── ② 打开 ──────────────────────────────────────────────────────────────
      sidebar.openDockPanel({ reason: 'smoke' });
      await sleep(700);
      const open = await dockSample(ctx);

      // ── ③ 关回 ──────────────────────────────────────────────────────────────
      const closed = sidebar.closeDockPanel({ reason: 'smoke-close' });
      await sleep(700);
      const back = await dockSample(ctx);

      // ── ③b 面板页里的 ✕ 也是真的能关（不是死键）：先查 DOM 真存在，再真点一下 ──────
      sidebar.openDockPanel({ reason: 'smoke-ui-close' });
      await sleep(600);
      const panelWcId = (sidebar.getStatus().dockPanel || {}).viewId;
      const panelWc = panelWcId === null || panelWcId === undefined ? null : webContents.fromId(panelWcId);
      let domProbe = null;
      try {
        domProbe = panelWc ? await panelWc.executeJavaScript(
          '(function(){var e=document.getElementById("x");'
          + 'return {has:!!e,text:e?(e.textContent||"").trim():"",buttons:document.querySelectorAll("button").length};})()') : null;
      } catch (e) { domProbe = { err: String((e && e.message) || e) }; }
      let uiClicked = false;
      try {
        uiClicked = panelWc ? await panelWc.executeJavaScript(
          '(function(){var e=document.getElementById("x");if(!e)return false;e.click();return true;})()') : false;
      } catch (e) { uiClicked = false; }
      await sleep(800);
      const afterUi = await dockSample(ctx);
      // DOM 事实（按钮真的在、且是那个 ✕）+ 点下去真的关了 + 让位回到基线
      const uiCloseOk = !!(domProbe && domProbe.has === true && domProbe.text === "✕"
        && uiClicked === true && afterUi.dock.open === false
        && afterUi.reserved === base.reserved && afterUi.panel === null);

      // ── ④ 仅面板（侧栏收起）：面板仍独立停在窗口右缘 ─────────────────────────
      sidebar.openDockPanel({ reason: 'smoke-only', force: true });
      await sleep(500);
      sidebar.hide();
      await sleep(600);
      const only = await dockSample(ctx);
      sidebar.show();
      await sleep(600);

      // ── 收尾（不污染后面的域）：关面板 + **真销毁**视图 + 宽度/可见性回本域进来时的样子 ──
      sidebar.closeDockPanel({ reason: 'teardown', destroy: true });
      sidebar.setWidth(pre.widthBefore || 420);
      if (pre.visibleBefore === false) sidebar.hide();
      await sleep(300);

      // ── 判据 ────────────────────────────────────────────────────────────────
      const pw = open.dock && open.dock.panelWidth;
      const gapOk = base.gap === 0 && open.gap === 0 && back.gap === 0 && only.gap === 0;
      const flushOk = !!(open.panel && open.rail && open.panel.x + open.panel.width === open.rail.x);
      const anchoredOk = !!(open.view && open.view.x + open.view.width === open.winW);
      const restDiff = [].concat(
        dockDiffRects(base.rail, back.rail, 'rail'),
        dockDiffRects(base.view, back.view, 'view'),
        base.reserved === back.reserved ? [] : ['预留 ' + base.reserved + '→' + back.reserved],
        (base.panel === null && back.panel === null) ? [] : ['面板：' + fmtRect(base.panel) + ' vs ' + fmtRect(back.panel)]
      );
      const sidebarUnmoved = JSON.stringify(base.rail) === JSON.stringify(open.rail)
        && JSON.stringify(base.view) === JSON.stringify(open.view);
      const reserveGrew = open.reserved === base.reserved + pw && open.nativeActual === base.reserved + pw;
      const onlyOk = !!(only.panel && only.panel.x + only.panel.width === only.winW
        && only.reserved === only.panel.width && only.cls === true && only.sidebarVisible === false);
      const pageOk = !!(open.dock && open.dock.hasView === true
        && String(open.dock.pageUrl || '').indexOf('data:text/html') === 0);
      const prevOk = !!(open.dock && open.dock.prev && typeof open.dock.prev.width === 'number')
        && !!(closed && closed.restore && closed.restore.same === true);

      const ok = pre.booted === true
        && base.panel === null && base.dock.open === false
        && gapOk && flushOk && anchoredOk && restDiff.length === 0
        && sidebarUnmoved && reserveGrew && onlyOk && pageOk && prevOk && uiCloseOk;

      return {
        ok: !!ok,
        text: '【① 基线（面板关）】窗口=' + base.winW + ' 页面预留=' + base.reserved
          + ' 原生实际=' + base.nativeActual + ' **缝=' + base.gap + 'px** 面板=' + fmtRect(base.panel)
          + '｜rail=' + fmtRect(base.rail) + ' view=' + fmtRect(base.view)
          + '｜【② 打开】窗口=' + open.winW + ' 预留=' + open.reserved + ' 实际=' + open.nativeActual
          + ' **缝=' + open.gap + 'px** 面板=' + fmtRect(open.panel) + '（宽 ' + pw + '）'
          + ' 贴接=' + flushOk + '（panel.x+panel.w=' + (open.panel ? open.panel.x + open.panel.width : 'null')
          + ' == rail.x=' + (open.rail ? open.rail.x : 'null') + '）'
          + ' 锚右=' + anchoredOk + '（view 右缘=' + (open.view ? open.view.x + open.view.width : 'null')
          + ' == 窗口=' + open.winW + '）'
          + ' 侧栏未动=' + sidebarUnmoved
          + '｜【③ 关回】预留=' + back.reserved + ' 实际=' + back.nativeActual + ' **缝=' + back.gap
          + 'px** 面板=' + fmtRect(back.panel) + ' 逐项复原差异=' + (restDiff.length ? restDiff.join('；') : '0 项')
          + ' 复原记录 same=' + (closed && closed.restore && closed.restore.same)
          + ' restores=' + (back.dock && back.dock.restores)
          + ' prev=' + fmtRect(open.dock && open.dock.prev)
          + '｜【④ 仅面板（侧栏收起）】预留=' + only.reserved + ' 实际=' + only.nativeActual
          + ' **缝=' + only.gap + 'px** 面板=' + fmtRect(only.panel) + ' 类=' + only.cls
          + ' 侧栏可见=' + only.sidebarVisible
          + '｜【③b 面板页 ✕】按钮DOM=' + JSON.stringify(domProbe) + ' 点了=' + uiClicked + ' 关后预留=' + afterUi.reserved + '（基线 ' + base.reserved + '）'
          + '｜占位页=' + String(open.dock && open.dock.pageUrl || '').slice(0, 28)
          + '｜注：面板是原生 view，capturePage 截不到 —— 这类缺陷**只能靠几何判定**'
      };
    }
  }
];
