/* ============================================================
 * src/panel-geometry.js — 主窗口**右侧让位带**几何的**唯一计算处**（UMD 纯函数：零 Electron、零 I/O）
 * ------------------------------------------------------------
 * ## 这一模块存在的理由（一句话）
 * 「侧栏占多宽、页面该让多少」原本是**内联在 `main-dsh-sidebar.js` 的 `relayout()` 里的三段算术**
 * —— 那份算术**没法单测**（要先起 Electron 才有 `WebContentsView`），于是它的每一条不变式都只能靠
 * 冒烟域里"起窗口、看读数"来守。加上**第 4 个原生面板**之后，那段算术从 2 个矩形变成 3 个矩形
 * （控制栏 / DSH 侧栏 / 停靠面板），再靠冒烟守就成了"每加一次业务就要改一次判据"。
 * ⇒ 把算术搬到这里（纯函数：输入数字、输出数字），`relayout()` 只负责**应用**它。
 *
 * ## 形态（2026-10-18 第 4 面板底座批拍的板）：右侧**二阶并列**
 *
 *      窗口左缘                                                    窗口右缘
 *      +---------------------------+----------------+------+-------------------+
 *      |  页面（让位预留 = 下面三段之和）  | 第 4 停靠面板 pw | 控制栏 30 |  DSH 侧栏内容 vw-30 |
 *      +---------------------------+----------------+------+-------------------+
 *                                    ^                ^      ^
 *                              面板贴住控制栏左缘   控制栏   侧栏内容（贴窗口右缘）
 *
 * 为什么是"并列在内侧"而不是另外两个候选（取舍读数见 `.review/20261018-第4面板底座/README.md`）：
 *   ① **侧栏（含控制栏）继续锚在窗口右缘** ⇒ 既有拖宽协议（`beginWidthDrag` 里
 *      `newWidth = 窗口右缘 − 光标`）**一个字节都不用改**，拖动方向/绝对定位语义不变；
 *   ② 页面让位仍是**一维的一条横带**（`--dsh-sidebar-width` = 三段之和）⇒ 既有 5 处 CSS 消费者
 *      （`#main` margin / `#toolbar` padding / `.overlay` 与 `#lightbox` 的 `right` / `.dialog-box` 的
 *      max-width）**全部不改就正确**；若改停**下缘**，让位就变成二维（横向 + 纵向两条），
 *      那 5 处得各加一条 `bottom` 预留，而浮层（`position:fixed; inset:0`）会直接盖住下缘面板；
 *   ③ 面板与侧栏**同高**（都是整窗高）⇒ 没有第二条轴，高度这条不留"半高/上下分栏"的模糊地带；
 *   ④ 面板在**内侧**（不是窗口最右）⇒ 侧栏的 ✕／−／拖宽热区仍贴着 DSH 页面，不会被面板隔开。
 *
 * ## 三条不变式（本模块输出必须恒成立的几何事实；判据在 `scripts/smoke/22-sidebar-gap.js` 独立再算一遍）
 *   1. **贴接**：`panel.x + panel.width === rail.x`（面板右缘与控制栏左缘严格相接，不许有缝/重叠）；
 *   2. **锚右**：`view.x + view.width === winWidth`（DSH 内容贴窗口右缘 —— 侧栏位置不因面板而漂移）；
 *   3. **让位守恒**：`occupiedWidth === panel.width + rail.width + view.width`，且 `pageWidth >= 0`。
 *   ⚠️ 这三条是**判据要独立复算的东西**，本模块不自己再判一遍（那会变成"两侧同源"的假绿）。
 *
 * ## 与既有常量的关系（**不许有第二份数字**）
 *   · 控制栏宽 `railWidth`：**本模块不收默认值**，由调用方传（唯一真源仍是
 *     `main-dsh-sidebar.js` 的 `RAIL_WIDTH`）—— 一份事实只写一处；
 *   · 侧栏宽 `sidebarWidth`：调用方已按 `MIN_WIDTH/MAX_WIDTH` 夹过再传进来（夹取逻辑仍只有一处）；
 *   · 面板的 min/默认/max 与页面地板：**定义在本文件的 `DEFAULTS`**，`main-dsh-sidebar.js` 引用它。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMPanelGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* —— 面板的宽度档与页面地板（**唯一真源**）——————————————
   * 取值不是拍的，是**从既有硬事实推出来**的：
   *   · 窗口最小内容宽 960（`main.js:845` 的 `minWidth: 960`）、侧栏下限 280（`MIN_WIDTH`）、
   *     面板下限 260 ⇒ 三者同时到下限时页面还剩 960 − 280 − 260 = **420**；
   *   · 页面地板取 **400**（比 420 少 20 的余量）⇒ 三档同时到下限时地板仍不被击穿
   *     —— 这条正是"面板夹取优先于把页面压没"的可机械复核形式；
   *   · 默认宽 360：与侧栏默认 420 同量级、且能放下"路径 + 行数"那种一行两列（`xx/yy.js  +47 −12`）。
   *     ⚠️ 这是**起手值**，不是"内容装不下就自动加宽"（那是另一件事，本批不做：没有业务就没有
   *     overflow 可测，凭空加一个会漂的预算档 = 又造一个"看起来在测量"的空转）。 */
  var DEFAULTS = {
    panelMinWidth: 260,
    panelWidth: 360,
    panelMaxWidth: 720,
    pageMinWidth: 400
  };

  function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  /** 一个矩形（宽高非正 ⇒ null："不在屏上"与"在屏上但 0 宽"在判据里不该混） */
  function rect(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return null;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
  }

  /**
   * 算一次几何。**输入全是数字/布尔**（不做任何 IO，也不读 Electron）⇒ 可在 node 里直测。
   *
   * @param {object} input
   *   · `winWidth` / `winHeight` —— 主窗口**内容区**尺寸（`win.getContentSize()`）
   *   · `sidebarVisible` —— 侧栏是否在屏上（`state.visible`；hide() 之后为 false）
   *   · `sidebarWidth` —— 侧栏**整条带**宽度（含控制栏；调用方已 clamp）
   *   · `railWidth` —— 控制栏宽（必填；唯一真源在 main-dsh-sidebar.js）
   *   · `dshOnly` —— 仅侧栏模式（导图页已卸载 ⇒ 侧栏铺满整窗）
   *   · `panelOpen` / `panelWidth` —— 停靠面板是否打开 / 期望宽度（已打开才用）
   *   · `panelMinWidth` / `panelMaxWidth` / `pageMinWidth` —— 缺省取 `DEFAULTS`
   * @returns {{windowWidth:number, windowHeight:number, sidebarVisible:boolean, dshOnly:boolean,
   *   rail:object|null, view:object|null, panel:object|null,
   *   sidebarBandWidth:number, panelWidth:number, occupiedWidth:number, pageWidth:number,
   *   clamped:object|null, notes:string[]}}
   */
  function computeGeometry(input) {
    var i = input || {};
    var winWidth = Math.max(0, Math.round(num(i.winWidth, 0)));
    var winHeight = Math.max(0, Math.round(num(i.winHeight, 0)));
    var railWidth = Math.max(0, Math.round(num(i.railWidth, 0)));
    var dshOnly = !!i.dshOnly;
    var sidebarVisible = !!i.sidebarVisible;
    var notes = [];

    // ── 侧栏带（**既有语义一字不改**）：整窗铺满（dshOnly）或 min(侧栏宽, 窗口宽) ──
    var sidebarBand = 0;
    if (sidebarVisible) {
      sidebarBand = dshOnly ? winWidth : Math.min(Math.max(0, num(i.sidebarWidth, 0)), winWidth);
      if (dshOnly) notes.push('dsh-only：侧栏铺满整窗（既有语义）⇒ 停靠面板没有位置');
    }
    var bandX = winWidth - sidebarBand;

    // ── 面板：先按自己的上下限夹，再让位给**页面地板**（面板是次要方，永远先让）──
    var panelMin = Math.max(0, Math.round(num(i.panelMinWidth, DEFAULTS.panelMinWidth)));
    var panelMax = Math.max(panelMin, Math.round(num(i.panelMaxWidth, DEFAULTS.panelMaxWidth)));
    var pageMin = Math.max(0, Math.round(num(i.pageMinWidth, DEFAULTS.pageMinWidth)));
    var wantPanel = i.panelOpen ? clamp(Math.round(num(i.panelWidth, DEFAULTS.panelWidth)), panelMin, panelMax) : 0;
    var roomForPanel = Math.max(0, bandX - pageMin);      // 侧栏左缘到"页面地板"之间的可用宽
    var panelEff = Math.min(wantPanel, roomForPanel);
    var clamped = null;
    if (wantPanel !== panelEff) {
      clamped = { want: wantPanel, got: panelEff, reason: roomForPanel <= 0 ? 'no-room' : 'page-floor' };
      notes.push('面板被夹到 ' + panelEff + 'px（想要 ' + wantPanel + 'px：侧栏占 ' + sidebarBand
        + 'px、页面地板 ' + pageMin + 'px ⇒ 只剩 ' + roomForPanel + 'px）');
    }
    if (panelEff > 0 && panelEff < panelMin) {
      notes.push('面板已低于它的下限 ' + panelMin + 'px（窗口太窄；仍如实给宽度，不做静默隐藏以外的动作）');
    }

    // ── 三条矩形的顺序：面板 → 控制栏 → 侧栏内容（都贴齐，中间不留缝）──
    var railEff = Math.min(railWidth, sidebarBand);
    var viewW = Math.max(0, sidebarBand - railEff);
    var panelRect = panelEff > 0 ? rect(bandX - panelEff, 0, panelEff, winHeight) : null;
    var railRect = railEff > 0 ? rect(bandX, 0, railEff, winHeight) : null;
    var viewRect = viewW > 0 ? rect(bandX + railEff, 0, viewW, winHeight) : null;

    var occupied = panelEff + railEff + viewW;
    return {
      windowWidth: winWidth,
      windowHeight: winHeight,
      sidebarVisible: sidebarVisible,
      dshOnly: dshOnly,
      rail: railRect,
      view: viewRect,
      panel: panelRect,
      sidebarBandWidth: railEff + viewW,
      panelWidth: panelEff,
      occupiedWidth: occupied,
      pageWidth: Math.max(0, winWidth - occupied),
      clamped: clamped,
      notes: notes
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    computeGeometry: computeGeometry
  };
});
