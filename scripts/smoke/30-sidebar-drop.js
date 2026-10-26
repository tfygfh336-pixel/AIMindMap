/* ============================================================
 * scripts/smoke/30-sidebar-drop.js — ⑨「拖到 DSH 侧栏 = 丢给侧栏」的手势
 * ------------------------------------------------------------
 * 契约（用户反馈⑨「应该可以拖动进隔壁 dsh 侧边栏」）：
 *   **多选（>1）** 一批节点拖到 DSH 侧栏上松手 ⇒ 把**那些**节点送进侧栏输入框 ✓；
 *   送不出去必须**如实说出原因** ✗（冒烟里没有真侧栏服务 ⇒ 预期是"如实报错"）。
 *   ⚠️ 2026-10-33 批4 **改写**（`renderer/app-view.js` 那条"拖动模式 + 面板右缘 24px"的旧兜底
 *   随拖动模式入口一起退出用户面）：⑨ 现在走的是用户 2026-10-31 拍板的规格 —— 只有**多选**能拖给
 *   DSH（单选/大虚线框松在 DSH = 取消），判定由主进程按**侧栏视图矩形**算（真鼠标、不注入回执）。
 *
 * 为什么不是"渲染层自己判有没有松在侧栏上"：侧栏是主进程的**原生 WebContentsView**，指针进去后
 * 渲染层连 mouseup 都收不到 ✗ ⇒ 跨视图松手必须主进程参与（`main.js` 的 `sel-drag-end`）。
 *
 * 本域用**真鼠标事件**（sendInputEvent ⇒ 走 Chromium 命中测试 ✓，不用 DOM 派发 —— 那是老假绿根因 ✗）。
 * ============================================================ */
'use strict';

const path = require('path');
/* 本域 ①-A/①-B（2026-10-33 批2）要用到**主进程侧**的东西：侧栏 view 的 webContents
 * （往它的页面里投真输入）与它的几何（判据的独立复算）。写法照 22-sidebar-gap.js ✓ */
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));
const { webContents } = require('electron');   // 与 main.js 同一实例

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 200) }; }
}

async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 40); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

function mouse(ctx, type, p) {
  ctx.win.webContents.sendInputEvent({ type: type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

/* ---------------- ①-A / ①-B 用的小工具（本批新增，不改既有断言） ---------------- */

/** 渲染层的**投喂计数**（`MM.selDropStats`，给冒烟断言用；只读，不参与判定）。 */
async function selStats(ctx) {
  const raw = await ctx.exec('(function () { var s = (window.MM && window.MM.selDropStats) ? window.MM.selDropStats() : null;'
    + ' return JSON.stringify(s); })()');
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 侧栏视图自己的 webContents（`getStatus().viewId` 是精确同一性判据，不靠 URL/token）。 */
function sidebarWc() {
  let id = null;
  try { id = (sidebar.getStatus() || {}).viewId; } catch (e) { id = null; }
  if (id === null || id === undefined) return null;
  const wc = webContents.fromId(id);
  return (wc && !wc.isDestroyed()) ? wc : null;
}

function sidebarWasVisible() {
  try { return !!sidebar.isVisible(); } catch (e) { return false; }
}

/* ①-A/①-B 块自己摆的前提（侧栏要开着才谈得上"进侧栏松手"）由**本块自己复原**：
 * 记下"是不是我打开的" ⇒ 只关我开的那个，不碰别的域留下的状态。
 * 为什么用模块级变量：每条断言是一个独立 run(ctx)，没有共享作用域，而"复原"这件事跨断言。 */
let selBlockShowedSidebar = false;
/** 批3 的 G5/G6 自己开/关侧栏时用它记账（同一纪律：只关"自己开的那个"）。 */
let g5ShowedSidebar = false;
/** ⑨（2026-10-33 批4 改写版）自己开/关侧栏时用它记账 —— 同一条纪律。 */
let ninthShowedSidebar = false;

/** 往**侧栏页面**投一条真输入（sendInputEvent 走 Chromium 真实命中测试 ⇒ 与 OS 点击同一条管线 ✓）。 */
function sendToSidebarPage(wc, type, pt) {
  wc.sendInputEvent({ type: type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
}

/** 一次"要回执"的最短闭环：start(ids) → 等 80ms → end(at) ⇒ 回执原样返回。 */
async function verdictAt(ctx, at) {
  const raw = await ctx.exec('(async function () {'
    + ' window.desktop.dsh.selDragStart(["smoke-geo-a", "smoke-geo-b"]);'
    + ' await new Promise(function (r) { setTimeout(r, 80); });'
    + ' return JSON.stringify(await window.desktop.dsh.selDragEnd(' + (at ? JSON.stringify(at) : 'undefined') + '));'
    + '})()');
  try { return JSON.parse(raw); } catch (e) { return { ok: false, reason: 'parse:' + String(raw).slice(0, 120) }; }
}

/* ================= 批3（2026-10-33）：拖动虚影 + 鼠标直接拖 的小工具 =================
 * 为什么这一批的判据全是**原生读数**：虚影是主进程的 `WebContentsView` ——
 *   · 它**不在页面帧里** ⇒ `win.webContents.capturePage()` 拍不到（上一批 U4 的实测）；
 *   · DOM 里也看不见它（它不是渲染层的元素）。
 * ⇒ 能读到的只有：`ghost.getVisible() / getBounds()`、`win.contentView.children` 的构成、
 *   虚影页面**自己**报的 `#t.textContent`、以及渲染层自报的偏移两桶。
 * ⚠️ 冒烟里**没有真光标**（`screen.getCursorScreenPoint()` = 测试者鼠标当时停的地方）⇒ 指针一律由
 *   `ctx.selDrag.inject()`（--smoke 专用）设成确定值。 */

/** 页面自报的偏移两桶（内存里的**唯一真源**：MMApp.getTreeOffsets / getNodeOffsets）。 */
async function offsets(ctx) {
  const raw = await ctx.exec('(function () { if (!window.MMApp) return "null";'
    + ' return JSON.stringify({ t: window.MMApp.getTreeOffsets(), n: window.MMApp.getNodeOffsets() }); })()');
  try { return JSON.parse(raw); } catch (e) { return null; }
}
/** 某个节点的偏移（两个桶合起来看：顶层主题进 t，更深的进 n）。 */
function offsetOf(o, id) {
  if (!o) return null;
  return ((o.t || {})[id]) || ((o.n || {})[id]) || null;
}
const offJson = (o, id) => JSON.stringify(offsetOf(o, id));

/** 主窗口子视图列表（G3 判"没有孤儿"：拖几次之后长度不许继续涨）。 */
function kidsOf(ctx) {
  try { return (ctx.win.contentView.children || []).slice(); } catch (e) { return []; }
}
/** 侧栏视图在子视图里的下标 —— **独立复算**（按 bounds 与 viewBounds() 逐字段相等找，
 *  故意不调 main.js 的 `selSidebarView`：判据必须能独立于被测实现复算）。 */
function sidebarIndexIn(ctx) {
  let vb = null;
  try { vb = sidebar.viewBounds(); } catch (e) { vb = null; }
  if (!vb || !(vb.width > 0 && vb.height > 0)) return { index: -1, vb: vb, why: 'sidebar-closed' };
  const kids = kidsOf(ctx);
  for (let i = 0; i < kids.length; i++) {
    let b = null;
    try { b = kids[i].getBounds(); } catch (e) { b = null; }
    if (b && b.x === vb.x && b.y === vb.y && b.width === vb.width && b.height === vb.height) {
      return { index: i, vb: vb, why: 'bounds-match', children: kids.length };
    }
  }
  return { index: -1, vb: vb, why: 'not-found', children: kids.length };
}

/** 起一次**单参**（legacy）拖拽：不依赖真鼠标 —— 这一批的虚影几何由注入的确定指针驱动。 */
async function startDrag(ctx, ids, subject) {
  const js = '(function () { if (!window.desktop || !desktop.dsh || !desktop.dsh.selDragStart) return "no-api";'
    + ' desktop.dsh.selDragStart(' + JSON.stringify(ids) + ', '
    + (subject === undefined ? 'undefined' : JSON.stringify(subject)) + '); return "sent"; })()';
  const raw = await ctx.exec(js);
  await sleep(160);
  return raw === 'sent';
}
async function endDrag(ctx) {
  const raw = await ctx.exec('(async function () { return JSON.stringify(await window.desktop.dsh.selDragEnd()); })()');
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 渲染层"直接拖"的现状读数（`MM.selDragState`，只读）。没有它就只能猜"按下去了却什么都没发生"是哪一段断的。 */
async function selDragStateOf(ctx) {
  const raw = await ctx.exec('(function () { return JSON.stringify(window.MM.selDragState ? window.MM.selDragState() : "no-api"); })()');
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 真鼠标：按下 → 分步移动（**不松手**），并**核实渲染层真的收下了这些移动**。
 *
 *  为什么要核实（本批实测踩到）：注入的 mousemove 偶尔**没有到达页面**（同一条断言里
 *  第 1、2 格 `at` 一直等于按下点、`armed=false`，第 3 格又正常）⇒ 判据会读成"产品拖不动"的假红。
 *  这不是产品行为，是"无真光标 + 注入式输入"这条测试通道自己的抖动 ⇒ 这里补送到**渲染层自报 armed** 为止
 *  （补送只重复同一个手势，不改变被测语义；仍收不到就让读数红，绝不静默放过）。 */
async function pressDrag(ctx, from, to, steps) {
  const n = Math.max(1, steps || 3);
  mouse(ctx, 'mouseMove', from);
  mouse(ctx, 'mouseDown', from);
  let st = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      /* 补送：**只在渲染层压根没建起这次拖拽时**才重发 mousedown（实测 mousedown 也会丢）。
       * 已有 fdSelDrag 就只补 mousemove —— 重发 mousedown 会把它换成一个新对象，
       * 把 `armed`/`snap` 一起丢掉（第 9 轮就是这样把格子全判红的）。 */
      if (!st) { mouse(ctx, 'mouseMove', from); mouse(ctx, 'mouseDown', from); await sleep(30); }
    }
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const jx = attempt === 1 ? 0 : (i === n ? attempt : 0);   // 补送时落点微移，避免"同点移动被合并掉"
      mouse(ctx, 'mouseMove', {
        x: Math.round(from.x + (to.x - from.x) * t) + jx,
        y: Math.round(from.y + (to.y - from.y) * t) + jx
      });
      await sleep(25);
    }
    await sleep(60);
    st = await selDragStateOf(ctx);
    if (st && st.armed) {
      /* ⚠️ **再补一拍再返回**：产品是"起势那一拍只置 armed、不移动位置"（第一拍就跟着走会因为
       * 阈值附近的手指抖动而抖一下）⇒ 只 armed 不补拍时，"偏移有没有变"那条判据会读到没动，
       * 变成假红（本批实测踩到一次）。补的这一拍带 2px 微移，保证至少发生一次真正的偏移推进。 */
      mouse(ctx, 'mouseMove', { x: to.x + 2, y: to.y + 2 });
      await sleep(40);
      return st;
    }
    await sleep(100);   // 让渲染层把队列里的输入跑完，再补一次
  }
  if (st && st.armed) return st;
  return st;            // 没 armed ⇒ 调用方按读数判红（不静默）
}

/** 从页面上读侧栏**客户区**坐标 → **屏幕**坐标（`inject` 用的是屏幕坐标；`viewBounds()` 是客户区）。
 *  两个基准的换算只许在**产品**里做一次（①-B），但断言侧的注入点必须自己换 —— 这里照
 *  `wb`（客户区原点）加一次，与产品那条路同基准。 */
function toScreen(wb, p) { return { x: Math.round(wb.x + p.x), y: Math.round(wb.y + p.y) }; }

/** 把输入状态清干净再进下一格：真 mouseUp + 光标挪到窗口角落 + 等**主进程与渲染层两边都没有活动拖拽**。
 *
 *  为什么必须（本批实测，代价最贵的一次）：注入的 mouseUp 会**迟到**——它落在下一格的 mousedown 之后，
 *  于是渲染层把"新按下但还没起势"的那次直接拖当成松手收掉：`armed=false` ⇒ `pendingClear` 生效
 *  ⇒ **选区被清空、大虚线框当场消失**（现场快照里 `raw=[] disp=none`）⇒ 那两格永远判红。
 *  ⇒ 清场必须**两边都读到空**才算清干净（只读主进程不够：渲染层的 `fdSelDrag` 是另一份状态）。 */
async function settleInput(ctx) {
  let wb = null;
  try { wb = ctx.win.getContentBounds(); } catch (e) { wb = null; }
  const corner = wb ? { x: wb.x + 2, y: wb.y + 2 } : { x: 2, y: 2 };
  for (let round = 1; round <= 6; round++) {
    mouse(ctx, 'mouseUp', corner);
    mouse(ctx, 'mouseMove', corner);
    await sleep(90);
    const page = await selDragStateOf(ctx);
    const main = ctx.selDrag.read();
    if (!page && !main.active) return true;
    if (!page && !main.active) return true;
  }
  // 还清不掉 ⇒ 显式收掉主进程那条（渲染层那份由它自己的 mouseup 收；收不掉会让下一格读成"拖不动"）
  await ctx.exec('(async function () { try { return JSON.stringify(await window.desktop.dsh.selDragEnd()); } catch (e) { return "err"; } })()');
  await sleep(150);
  const page2 = await selDragStateOf(ctx);
  return !ctx.selDrag.read().active && !page2;
}

/** 挑 n 个"真的能按下"的可见非根节点（**顺带关掉浮层**：详情框盖住节点时 elementFromPoint 不是节点
 *  ⇒ 后续按下会静默落空，表现成"拖不动"的假红 —— 本批实测踩到）。
 *  每个节点试 5 个候选点（中心 + 四向），任一命中即取 —— 按钮/圆钮压在中心时也能挑到。 */
async function pickNodes(ctx, n) {
  return await execJson(ctx, `(function () {
    if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
    var out = [];
    for (var i = 0; i < all.length && out.length < ${n}; i++) {
      var el = all[i], id = el.getAttribute('nodeid');
      if (id === 'root') continue;
      var r = el.getBoundingClientRect();
      if (!(r.width > 20 && r.height > 10)) continue;
      if (!(r.left > 4 && r.top > 40 && r.right < window.innerWidth - 200 && r.bottom < window.innerHeight - 60)) continue;
      var cands = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
      for (var c = 0; c < cands.length; c++) {
        var x = Math.round(r.left + r.width * cands[c][0]), y = Math.round(r.top + r.height * cands[c][1]);
        var at = document.elementFromPoint(x, y);
        if (at && at.closest && at.closest('jmnode[nodeid]') === el) {
          var jm = window.MMApp.getState().jm;
          var nd = jm && jm.get_node ? jm.get_node(id) : null;
          out.push({ id: id, x: x, y: y, topic: String((nd || {}).topic || ''), parent: (nd && nd.parent) ? nd.parent.id : null });
          break;
        }
      }
    }
    if (out.length < ${n}) return JSON.stringify({ ok: false, text: '只找到 ' + out.length + '/' + ${n} + ' 个可点的可见非根节点' });
    return JSON.stringify({ ok: true, nodes: out });
  })()`);
}

/** 挑"同一父下的 n 个可见兄弟"（框选格里给"大虚线框"用：同一父 ⇒ trimSelection 不会裁掉）。
 *  ⚠️ 必须**排除父是 root** 的那一组（= 顶层主题之间）：它们各属**不同的树**，而"拖大虚线框"用的
 *  是 `dragSelection` 的同一条判据（跨树不让拖）⇒ 拿两个顶层主题当"兄弟"，按下时产品（正确地）
 *  不接管，这一格就永远判红。本批实测踩到的正是这一条（读数 raw=["comp-net","wlan-book"]）。
 *  最后再兜一层：挑出来的 ids 必须都由产品自己的 `treeRootOf` 指到**同一棵树**。 */
async function pickSiblings(ctx, n) {
  return await execJson(ctx, `(function () {
    if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    var jm = window.MMApp.getState().jm;
    var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
    var byParent = {}, vis = {};
    all.forEach(function (el) {
      var id = el.getAttribute('nodeid');
      if (id === 'root') return;
      var r = el.getBoundingClientRect();
      if (!(r.width > 20 && r.height > 10)) return;
      if (!(r.left > 4 && r.top > 40 && r.right < window.innerWidth - 200 && r.bottom < window.innerHeight - 60)) return;
      var nd = jm.get_node ? jm.get_node(id) : null;
      if (!nd || !nd.parent || nd.parent.id === 'root') return;   // ★ 顶层主题不算"兄弟"（各自成一棵树）
      var cands = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
      for (var c = 0; c < cands.length; c++) {
        var x = Math.round(r.left + r.width * cands[c][0]), y = Math.round(r.top + r.height * cands[c][1]);
        var at = document.elementFromPoint(x, y);
        if (at && at.closest && at.closest('jmnode[nodeid]') === el) {
          vis[id] = { x: x, y: y };
          (byParent[nd.parent.id] = byParent[nd.parent.id] || []).push(id);
          break;
        }
      }
    });
    var keys = Object.keys(byParent);
    for (var k = 0; k < keys.length; k++) {
      var g = byParent[keys[k]];
      if (g.length < ${n}) continue;
      var pick = g.slice(0, ${n});
      var trees = pick.map(function (id) { return window.MM.treeRootOf ? window.MM.treeRootOf(id) : null; });
      var same = trees.length > 0 && trees.every(function (t) { return t && t === trees[0]; });
      if (!same) continue;
      return JSON.stringify({ ok: true, ids: pick, tree: trees[0],
        pts: pick.map(function (id) { return vis[id]; }) });
    }
    return JSON.stringify({ ok: false, text: '找不到"同一父 + 同一棵树"的 ' + ${n} + ' 个可见兄弟节点' });
  })()`);
}

/** 展开第一个"有子节点"的顶层主题（一次一层）—— 只为了让"同一父的两个可见兄弟"真的存在。
 *  为什么需要：冒烟默认是折叠态，画面上只有 root 的直接子节点（顶层主题）⇒ **没有任何一对
 *  "非顶层主题的兄弟"**可见；而"拖大虚线框"必须拖**同一棵树内**的一组（跨树那条产品不让拖）。 */
async function ensureSiblingsExpanded(ctx) {
  const r = await execJson(ctx, `(function () {
    var jm = window.MMApp.getState().jm;
    if (!jm || !jm.get_node) return JSON.stringify({ ok: false, text: '没有 jm' });
    var root = jm.get_node('root');
    var themes = (root && root.children) || [];
    for (var i = 0; i < themes.length; i++) {
      var t = themes[i];
      if (t.children && t.children.length) {
        try { window.MM.adapter.expandNode(jm, t.id); } catch (e) { return JSON.stringify({ ok: false, text: '展开失败：' + ((e && e.message) || e) }); }
        return JSON.stringify({ ok: true, theme: t.id, kids: t.children.length, firstKid: t.children[0].id });
      }
    }
    return JSON.stringify({ ok: false, text: '没有"有子节点的顶层主题"可展开' });
  })()`);
  await sleep(400);
  if (r.ok && r.firstKid) {
    /* 展开之后那批子节点可能落在视口外（实测 y=1591，面板只有 81..735）⇒ 把它们**摆进视口**
     * （否则"框内找不到非节点的可按点"那条判据永远红，与产品无关）。 */
    await execJson(ctx, '(function () { if (!window.MM.centerOnNode) return JSON.stringify({ ok: false });'
      + ' var ok = window.MM.centerOnNode(' + JSON.stringify(r.firstKid) + ', { always: true });'
      + ' return JSON.stringify({ ok: !!ok }); })()');
    await sleep(250);
  }
  return r;
}

/** 按在大虚线框里（非节点上）的那个点：现场量框、扫描"落在画布上"的位置。 */
async function pickOutlinePoint(ctx, ids) {
  return await execJson(ctx, `(function () {
    if (window.MM.clearSelection) window.MM.clearSelection();
    window.MM.applySelection(${JSON.stringify(ids)}, ${JSON.stringify(ids)});
    var el = document.getElementById('dsh-selection-outline');
    if (!el || el.style.display === 'none') return JSON.stringify({ ok: false, text: '大虚线框没出现（选区为空？）' });
    var r = el.getBoundingClientRect();
    for (var dy = 8; dy < r.height - 8; dy += 6) {
      for (var dx = 8; dx < r.width - 8; dx += 6) {
        var x = Math.round(r.left + dx), y = Math.round(r.top + dy);
        if (x < 8 || y < 46 || x > window.innerWidth - 8 || y > window.innerHeight - 8) continue;
        var at = document.elementFromPoint(x, y);
        if (!at) continue;
        if (at.closest && at.closest('jmnode[nodeid]')) continue;
        if (!(at.tagName === 'JMNODES' || at.tagName === 'CANVAS' || (at.closest && at.closest('jmnodes, canvas.jsmind')))) continue;
        var ht = !!(window.MM.selectionHitTest && window.MM.selectionHitTest(x, y));
        var sel = window.MM.getSelection ? window.MM.getSelection().count : -1;
        return JSON.stringify({ ok: true, x: x, y: y, hitTest: ht, sel: sel,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          at: String(at.tagName) });
      }
    }
    return JSON.stringify({ ok: false, text: '框内找不到"不在节点上"的可按点 ｜ 框=' + JSON.stringify([r.left, r.top, r.width, r.height]) });
  })()`);
}

/** 把选区摆成 sel，并**现场量**那个要被按下的节点（顺带验 elementFromPoint 真的命中它）。
 *  为什么必须现场量：侧栏一开一收会让渲染层让位、jsMind 重排 ⇒ 先前量的坐标会失效，
 *  表现为"按下去了却什么都没发生"（假红）。这就是本批踩到的那次。
 *  返回 { ok, x, y, raw }；`ok=false` 时**不许**硬着头皮按（那会产出一条假的"拖不动"）。 */
async function selectAndHit(ctx, sel) {
  const js = '(function () {'
    + ' if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();'
    + ' if (window.MM.clearSelection) window.MM.clearSelection();'
    + sel.map((id) => ' window.MM.toggleNodeSelection(' + JSON.stringify(id) + ');').join('')
    + ' var el = document.querySelector(' + JSON.stringify('jmnode[nodeid="' + sel[0] + '"]') + ');'
    + ' if (!el) return JSON.stringify({ ok: false, text: "节点不在了：" + ' + JSON.stringify(sel[0]) + ' });'
    + ' var r = el.getBoundingClientRect();'
    + ' var cands = [[r.width * 0.5, r.height * 0.5], [r.width * 0.25, r.height * 0.5],'
    + '   [r.width * 0.75, r.height * 0.5], [r.width * 0.5, r.height * 0.25], [r.width * 0.5, r.height * 0.75]];'
    + ' for (var i = 0; i < cands.length; i++) {'
    + '   var x = Math.round(r.left + cands[i][0]), y = Math.round(r.top + cands[i][1]);'
    + '   var at = document.elementFromPoint(x, y);'
    + '   if (at && at.closest && at.closest("jmnode[nodeid]") === el) {'
    + '     return JSON.stringify({ ok: true, x: x, y: y, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],'
    + '       raw: window.MM.getSelectionRaw() });'
    + '   }'
    + ' }'
    + ' return JSON.stringify({ ok: false, text: "节点矩形里没有一个点能命中它（被浮层盖住？）",'
    + '   rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });'
    + '})()';
  return await execJson(ctx, js);
}

/* ================= ⑨（2026-10-33 批4 改写）的两个夹具 =================
 * 为什么改写：改前 ⑨ 走的是"拖动模式 + 面板右缘 24px"那条**只有拖动模式能走**的路
 * （`renderer/app-view.js:1696`，送的是单个 `[fdDragTreeRoot]`）；拖动模式的菜单入口已按用户
 * 2026-10-31「移除拖动模式」摘掉 ⇒ 那条路再没有用户入口。现存的跨视图手势是批 3 那条
 * （多选 >1 才能拖给 DSH，判定由主进程按侧栏视图矩形算）。
 *
 * 两个夹具都是**只读包装**：`MM.sendNodesToSidebar` 是投喂的**唯一出口**（`renderer/app-ask.js`），
 * 包一层只为了记"投喂了哪几个 id"——判据要的是 ids，`selStats().feeds` 的计数只是旁证。
 * 收尾必须把包装撤掉（不给后面的断言留一个假出口 ✗），见 `ninthCleanup`。 */

/** 装投喂记录器（幂等：已经装过就不重装，`__mmFeeds` 会被清空 ⇒ 每个回合只记自己那一段）。 */
async function ninthArmFeeder(ctx, statusText) {
  await ctx.exec(`(function () {
    window.MM.setStatus(${JSON.stringify(statusText)});
    if (!window.__mmFeedOrig && window.MM.sendNodesToSidebar) {
      window.__mmFeedOrig = window.MM.sendNodesToSidebar;
      window.MM.sendNodesToSidebar = function (ids) {
        try { window.__mmFeeds.push([].slice.call(ids || [])); } catch (e) {}
        return window.__mmFeedOrig.apply(window.MM, arguments);
      };
    }
    window.__mmFeeds = [];
    return 1;
  })()`);
}

/** 读这一刻记下的投喂入参（数组的数组）。 */
async function ninthFeeds(ctx) {
  const raw = await ctx.exec('JSON.stringify(window.__mmFeeds || [])');
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/** ⑨ 两条断言共用的收尾：撤掉投喂包装、清选区、把**自己开的**侧栏收回去。
 *  ⚠️ 只关"自己开的那个"（`ninthShowedSidebar`）—— 别的域留下的状态不碰（照 G5 的纪律）。 */
async function ninthCleanup(ctx) {
  await ctx.exec('(function () {'
    + ' try { if (window.__mmFeedOrig) { window.MM.sendNodesToSidebar = window.__mmFeedOrig;'
    + '   window.__mmFeedOrig = null; } } catch (e) {}'
    + ' if (window.MM.clearSelection) window.MM.clearSelection();'
    + ' return 1; })()');
  if (ninthShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } ninthShowedSidebar = false; }
  await sleep(300);
}

/* ================= 对话输入框的**假现场**（N3 三格 + ⑦ 幂等 + ⑧ 形态共用这一份）=================
 * 为什么抽到模块级：上一批这三格是在断言体里现拼的（`mk` / `wcExec` / `runPrefill`），
 * 本批要再加两格（幂等、形态）—— 再抄一遍就是**第二份假现场**（现场一漂，判据就互相打脸 ✗）。
 * ⇒ 造现场 / 拆现场 / 跑产品那份 `COMPOSER_PREFILL_JS` / 读回现场，各自只此一处。
 * ⚠️ 全部跑在**侧栏页**的 webContents 上（`ctx.exec` 跑的是导图页 —— 上一批踩过这个假红）。 */

/** 在侧栏页里执行一段代码并把 JSON 回执解析出来（失败也返回结构，不抛）。 */
async function composerExec(wc, code) {
  try { return JSON.parse(await wc.executeJavaScript(code, true)); }
  catch (e) { return { ok: false, text: '侧栏页执行失败：' + ((e && e.message) || e) }; }
}

/** 跑**产品的那一份** `COMPOSER_PREFILL_JS`（不是复制品 —— 复制品会让本域变成自证 ✓）。 */
async function composerPrefill(wc, jsSource, text) {
  try { return JSON.parse(await wc.executeJavaScript('(' + jsSource + ')(' + JSON.stringify(text) + ')', true)); }
  catch (e) { return { ok: false, bucket: 'threw', reason: '执行抛错：' + ((e && e.message) || e) }; }
}

/** 造现场。三种 kind：
 *   · `target`     —— **照真机截图造的富文本对话框**（占位文字照抄、fixed ⇒ offsetParent=null、584×120 比例≈4.9）；
 *   · `plain`      —— 一个无关的窄 textarea（判"会不会挑错框"用）；
 *   · `controlled` —— **受控编辑器模型**（本批新增）：框里**已经有** `seed` 那段（= 上一次投喂留下的），
 *                     并且**直接赋 textContent 不生效**（真机 Lexical 是模型驱动：DOM 赋值下一帧就被它自己
 *                     的模型渲染覆盖回去）⇒ 这一格才能分辨"替换"与"追加"，plain div 分不出来
 *                     （plain div 上那条 `textContent = text` 兜底会把追加伪装成 1 份 ✗ 假绿）。 */
async function composerMock(wc, kind, seed) {
  return composerExec(wc, '(function (kind, seed) {'
    + ' function rm(id) { var e = document.getElementById(id); if (e && e.parentNode) e.parentNode.removeChild(e); }'
    + ' var host = document.getElementById("__mm_mock_host");'
    + ' if (!host) { host = document.createElement("div"); host.id = "__mm_mock_host";'
    + '   host.style.cssText = "position:fixed;left:0;bottom:0;width:100%;height:180px;z-index:2147483647;background:#f5f5f5";'
    + '   document.body.appendChild(host); }'
    + ' if (kind === "target" || kind === "controlled") {'
    + '   rm("__mm_mock_composer");'
    + '   var ed = document.createElement("div"); ed.id = "__mm_mock_composer";'
    + '   ed.setAttribute("contenteditable", "true");'
    + '   ed.setAttribute("role", "textbox");'
    + '   ed.setAttribute("data-placeholder", "描述你想要构建的内容，/ 调用指令，@ 文件或对话");'
    + '   ed.setAttribute("aria-label", "描述你想要构建的内容，/ 调用指令，@ 文件或对话");'
    + '   ed.style.cssText = "position:fixed;left:4%;bottom:44px;width:88%;height:120px;box-sizing:border-box;'
    + 'border:1px solid #ccc;border-radius:14px;background:#fff;padding:10px;overflow:auto;white-space:pre-wrap;color:#111";'
    + '   host.appendChild(ed);'
    + '   var btn = document.createElement("button"); btn.id = "__mm_mock_send"; btn.textContent = "\\u2191";'
    + '   btn.style.cssText = "position:fixed;right:5%;bottom:50px;width:34px;height:34px;border-radius:50%";'
    + '   host.appendChild(btn);'
    + '   var swallowed = 0;'
    + '   if (kind === "controlled") {'
    + '     if (seed) ed.appendChild(document.createTextNode(seed));'
    /* ★ 受控：把实例上的 textContent 换成"吞掉写"的访问器（真机那一步的等价物）。
     *   ⚠️ 这是**模型化**，不是抄产品实现：真机 Lexical 的模型不被 DOM 赋值驱动，
     *      所以"赋值 → 下一帧被覆盖回去"与"赋值被忽略"对判据等价（回读那一刻看到的是它自己的模型）。 */
    + '     var desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");'
    + '     try {'
    + '       Object.defineProperty(ed, "textContent", { configurable: true,'
    + '         get: function () { return desc.get.call(ed); },'
    + '         set: function () { swallowed++; ed.__mmSwallowed = swallowed; } });'
    + '     } catch (e) { return JSON.stringify({ ok: false, text: "造不出受控编辑器：" + ((e && e.message) || e) }); }'
    + '   }'
    + '   var r = ed.getBoundingClientRect();'
    + '   return JSON.stringify({ ok: true, tag: ed.tagName, rich: ed.isContentEditable === true,'
    + '     w: Math.round(r.width), h: Math.round(r.height), ratio: Math.round(r.width / r.height * 10) / 10,'
    + '     offsetParentNull: ed.offsetParent === null, seed: String(seed || ""),'
    + '     text: String(ed.innerText || "") });'
    + ' }'
    + ' rm("__mm_mock_plain");'
    + ' var ta = document.createElement("textarea"); ta.id = "__mm_mock_plain";'
    + ' ta.style.cssText = "position:fixed;left:2px;top:2px;width:180px;height:24px";'
    + ' host.appendChild(ta);'
    + ' return JSON.stringify({ ok: true, tag: "TEXTAREA", value: String(ta.value || "") });'
    + ' })(' + JSON.stringify(kind) + ', ' + JSON.stringify(seed == null ? '' : String(seed)) + ')');
}

/** 造"**多段 + 末尾空段**"的富文本现场（= 真人用回车分段之后 DOM 的样子），光标放进末尾空段。
 *  为什么需要这一种（2026-10-40 实测踩出来的）：只有光标处在一个**段落的开头**时，"追加"才会产生
 *  "完整的一份又一份"；用 `selectNodeContents+collapse(false)` 得到的元素边界点，Chrome 会把插入
 *  落到别处（实测写成 `甲\n乙甲\n\n乙`）⇒ `copies` 数不出 2 来，红侧就失去了判别力 ✗。
 *  ⚠️ 它仍然只是**假现场**：能不能数出两份靠的是 DOM 语义，不是真 Lexical 的模型语义。 */
async function composerMockParas(wc, lines) {
  return composerExec(wc, '(function (lines) {'
    + ' var host = document.getElementById("__mm_mock_host");'
    + ' if (!host) { host = document.createElement("div"); host.id = "__mm_mock_host";'
    + '   host.style.cssText = "position:fixed;left:0;bottom:0;width:100%;height:180px;z-index:2147483647;background:#f5f5f5";'
    + '   document.body.appendChild(host); }'
    + ' var old = document.getElementById("__mm_mock_composer"); if (old && old.parentNode) old.parentNode.removeChild(old);'
    + ' var ed = document.createElement("div"); ed.id = "__mm_mock_composer";'
    + ' ed.setAttribute("contenteditable", "true"); ed.setAttribute("role", "textbox");'
    + ' ed.setAttribute("data-placeholder", "描述你想要构建的内容，/ 调用指令，@ 文件或对话");'
    + ' ed.setAttribute("aria-label", "描述你想要构建的内容，/ 调用指令，@ 文件或对话");'
    + ' ed.style.cssText = "position:fixed;left:4%;bottom:44px;width:88%;height:120px;box-sizing:border-box;'
    + 'border:1px solid #ccc;border-radius:14px;background:#fff;padding:10px;overflow:auto;white-space:pre-wrap;color:#111";'
    + ' for (var i = 0; i < lines.length; i++) { var d = document.createElement("div"); d.textContent = lines[i]; ed.appendChild(d); }'
    + ' var tail = document.createElement("div"); tail.appendChild(document.createElement("br")); ed.appendChild(tail);'
    + ' host.appendChild(ed);'
    + ' ed.focus();'
    + ' var rg = document.createRange(); rg.selectNodeContents(tail); rg.collapse(true);'
    + ' var s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);'
    + ' var r = ed.getBoundingClientRect();'
    + ' return JSON.stringify({ ok: true, tag: ed.tagName, rich: ed.isContentEditable === true,'
    + '   w: Math.round(r.width), h: Math.round(r.height), ratio: Math.round(r.width / r.height * 10) / 10,'
    + '   text: String(ed.innerText || "") });'
    + ' })(' + JSON.stringify((lines || []).map((v) => String(v))) + ')');
}

/** 读回现场（假对话框的 innerText / 无关 textarea 的 value / 受控编辑器吞了几次赋值）。 */async function composerState(wc) {
  return composerExec(wc, '(function () {'
    + ' var ed = document.getElementById("__mm_mock_composer");'
    + ' var ta = document.getElementById("__mm_mock_plain");'
    + ' return JSON.stringify({ ok: true,'
    + '   edText: ed ? String(ed.innerText || "") : "<没了>",'
    + '   taValue: ta ? String(ta.value || "") : "<没了>",'
    + '   swallowed: ed ? (Number(ed.__mmSwallowed) || 0) : null }); })()');
}

/** 拆掉整个假现场（不许给后面的域留一张假页面 ✗）。 */
async function composerTeardown(wc) {
  return composerExec(wc, '(function () { var h = document.getElementById("__mm_mock_host");'
    + ' if (h && h.parentNode) h.parentNode.removeChild(h); return JSON.stringify({ ok: true }); })()');
}

/** 一段文本在另一段里出现了**几份**（判据侧**独立**数一遍，不信回执的 copies）。 */
function countCopies(hay, needle) {
  const h = String(hay == null ? '' : hay), n = String(needle == null ? '' : needle);
  if (!n) return 0;
  let c = 0, i = 0;
  while ((i = h.indexOf(n, i)) >= 0) { c++; i += n.length; }
  return c;
}


module.exports = [
  {
    name: '⑨ 多选 + 拖到 DSH 侧栏 ⇒ 把**那两个**节点交给侧栏（投喂的 ids 逐个对得上；送不出去要如实说原因）',
    run: async (ctx) => {
      /* 【2026-10-33 批4 **改写**，不是删】改前这条测的是"进拖动模式 → 拖一棵树 → 在**面板右缘 24px 内**
       * 松手 ⇒ 渲染层把 `[fdDragTreeRoot]`（**单个 id**）交给侧栏"（`renderer/app-view.js:1696` 那条兜底）。
       * 那条路**只有拖动模式能走**，而拖动模式的菜单入口已按用户 2026-10-31「移除拖动模式」摘掉
       * ⇒ 用户再也走不到它。现存的手势是批 3 按用户 2026-10-31 逐字规格做的那一条：
       *   **多选（>1）** 拖到 **DSH 侧栏**才投喂；判定由主进程按侧栏视图矩形算（真鼠标、不注入回执）。
       * 判据因此换成（比改前强：改前只判"状态栏出现了送栏结论"，现在判"投喂的就是那两个 id"）：
       *   加选出两个**同一个父、同一棵树**的可见节点 ⇒ 真鼠标拖到**侧栏视图矩形内**松手
       *   ⇒ 投喂**正好 1 次**、且投喂的 ids 就是那两个；状态栏照旧必须给出结论（送不出去要说原因）。
       * 对照组（下一条）保留同一套夹具：同一个多选、在**离右缘 80px（导图页上）**松手 ⇒ 一次都不投喂。
       * ⚠️ 侧栏是主进程的**原生 WebContentsView** ⇒ 指针进去后渲染层收不到事件，所以"要不要投"
       *    只能由主进程判（`sel-drag-end` 把渲染层上报的松手点换算到客户区再比 `viewBounds()`）。 */
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } ninthShowedSidebar = true; }
      await sleep(900);
      await ensureSiblingsExpanded(ctx);
      const prep = await pickSiblings(ctx, 2);
      if (!prep.ok) { await ninthCleanup(ctx); return { ok: false, text: prep.text }; }
      let vr = null;
      try { vr = sidebar.viewBounds(); } catch (e) { vr = null; }
      if (!vr || !(vr.width > 40 && vr.height > 40)) {
        await ninthCleanup(ctx);
        return { ok: false, text: '侧栏视图没建起来（viewBounds=' + JSON.stringify(vr) + '）⇒ 这条判据无从成立，按红处理 ✗' };
      }
      await settleInput(ctx);
      const hitPt = await selectAndHit(ctx, prep.ids);
      if (!hitPt.ok) { await ninthCleanup(ctx); return { ok: false, text: '多选夹不起来：' + hitPt.text }; }
      await ninthArmFeeder(ctx, '（⑨ 起点干净）');
      const s0 = await selStats(ctx);
      const dshPt = { x: Math.round(vr.x + vr.width / 2), y: Math.round(vr.y + Math.round(vr.height / 3)) };
      await pressDrag(ctx, { x: hitPt.x, y: hitPt.y }, dshPt, 3);
      mouse(ctx, 'mouseUp', dshPt);
      await settleInput(ctx);
      const s1 = await selStats(ctx);
      const feeds = await ninthFeeds(ctx);
      const status = String(await ctx.exec("(document.querySelector('#status-text') || {}).textContent || ''"));
      const fedIds = (feeds.length === 1 && Array.isArray(feeds[0])) ? feeds[0].slice().sort() : null;
      const wantIds = prep.ids.slice().sort();
      const idsOk = !!fedIds && JSON.stringify(fedIds) === JSON.stringify(wantIds);
      const statusOk = /已把 \d+ 个节点送进侧栏输入框|没送进侧边栏：|正在送进侧栏/.test(status);
      const dFeeds = (s0 && s1) ? (s1.feeds - s0.feeds) : null;
      await ninthCleanup(ctx);
      return {
        ok: idsOk && dFeeds === 1 && statusOk,
        text: '夹具=多选 [' + prep.ids.join(',') + ']（同父=' + prep.tree + '）· 按下=' + JSON.stringify({ x: hitPt.x, y: hitPt.y })
          + ' · 落点(客户区)=' + JSON.stringify(dshPt) + ' 侧栏矩形=' + JSON.stringify(vr)
          + ' ｜ 投喂 ' + feeds.length + ' 次 ids=' + JSON.stringify(feeds) + '（应 1 次、且就是那两个）'
          + ' · 渲染层 feedsΔ=' + dFeeds + '（应 1）'
          + ' ｜ 状态栏=' + JSON.stringify(status.slice(0, 80))
          + (idsOk && dFeeds === 1 && statusOk ? ' ✓' : ' ✗')
      };
    }
  },

  {
    /* 判别力证明（**常驻对照组**，比一次性注入更有价值 ✓）：
     * 同一个多选夹具，但**在离右缘 80px 处（导图页上）松手** ⇒ 不落在侧栏视图矩形里 ⇒
     * 一次都不许投喂、状态栏里也**不允许**出现任何"送进侧栏"的结论 ✓。
     * 这一条与上一条成对 ⇒ 上一条一旦变成"永远绿"（例如判定写成恒真），本组立刻红 ✓
     * （2026-10-33 批4 改写：夹具与上一条**同一套**（多选 + 同父兄弟），
     *  这样两条之间唯一的变量就是"落点在侧栏里 / 不在侧栏里"）。 */
    name: '⑨ 对照组：同一个多选、在离右缘 80px（导图页上）松手 ⇒ 一个节点都不该被送出去（落点判定必须真的在生效）',
    run: async (ctx) => {
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } ninthShowedSidebar = true; }
      await sleep(900);
      await ensureSiblingsExpanded(ctx);
      const prep = await pickSiblings(ctx, 2);
      if (!prep.ok) { await ninthCleanup(ctx); return { ok: false, text: prep.text }; }
      await settleInput(ctx);
      const hitPt = await selectAndHit(ctx, prep.ids);
      if (!hitPt.ok) { await ninthCleanup(ctx); return { ok: false, text: '多选夹不起来：' + hitPt.text }; }
      await ninthArmFeeder(ctx, '（⑨ 对照组起点）');
      const pr = await execJson(ctx, '(function () { var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();'
        + ' return JSON.stringify({ ok: true, left: Math.round(r.left), right: Math.round(r.right) }); })()');
      const edge = { x: Math.round(pr.right - 80), y: hitPt.y };   // 离右缘 80px ⇒ 仍在导图页里 ⇒ 不该投喂
      const s0 = await selStats(ctx);
      await pressDrag(ctx, { x: hitPt.x, y: hitPt.y }, edge, 3);
      mouse(ctx, 'mouseUp', edge);
      await settleInput(ctx);
      const s1 = await selStats(ctx);
      const feeds = await ninthFeeds(ctx);
      const status = String(await ctx.exec("(document.querySelector('#status-text') || {}).textContent || ''"));
      const delivered = /已把 \d+ 个节点送进侧栏输入框|没送进侧边栏：|正在送进侧栏/.test(status);
      const dFeeds = (s0 && s1) ? (s1.feeds - s0.feeds) : null;
      await ninthCleanup(ctx);
      return {
        ok: feeds.length === 0 && dFeeds === 0 && delivered === false,
        text: '夹具=多选 [' + prep.ids.join(',') + '] · 按下=' + JSON.stringify({ x: hitPt.x, y: hitPt.y })
          + ' · 落点(导图页)=' + JSON.stringify(edge) + '（面板 ' + pr.left + '..' + pr.right + '，离右缘 80px）'
          + ' ｜ 投喂 ' + feeds.length + ' 次 ids=' + JSON.stringify(feeds) + '（应 0 次）'
          + ' · 渲染层 feedsΔ=' + dFeeds + '（应 0）'
          + ' ｜ 状态栏=' + JSON.stringify(status.slice(0, 60)) + '（不该出现送栏结论 ✓）'
          + (feeds.length === 0 && dFeeds === 0 && delivered === false ? ' ✓' : ' ✗')
      };
    }
  }
  ,
  {
    name: 'P7 跨视图拖放：preload 暴露 selDragStart/selDragEnd，且与「拖宽」那套分开 ✓',
    run: async (ctx) => {
      const r = await ctx.exec(`(function () {
        var d = window.desktop && window.desktop.dsh;
        if (!d) return JSON.stringify({ ok: false, text: '没有 desktop.dsh' });
        return JSON.stringify({ ok: typeof d.selDragStart === 'function' && typeof d.selDragEnd === 'function'
          && typeof d.beginDrag === 'function' && typeof d.endDrag === 'function',
          text: 'selDragStart=' + typeof d.selDragStart + ' selDragEnd=' + typeof d.selDragEnd
            + ' ｜ 拖宽那套 beginDrag=' + typeof d.beginDrag + ' endDrag=' + typeof d.endDrag + '（两套都在 ✓ 不混用 ✗）' });
      })()`);
      const o = JSON.parse(r);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: 'P7 跨视图拖放：起点/终点上报有结构化回执，且「命中才投喂」这条不变量成立 ✓',
    run: async (ctx) => {
      // ① 没有活动拖拽 ⇒ 必须**明说** no-active-drag（不静默 ✗）
      // ⚠️ executeJavaScript 是**脚本**不是模块 ⇒ 里面不许有 top-level await ✗（踩过：Script failed to execute）
      const idle = JSON.parse(await ctx.exec('(async function () { return JSON.stringify(await window.desktop.dsh.selDragEnd()); })()'));
      // ② 一次完整循环：start(ids) → end() ⇒ 回执必须带 hit(bool) + pt + ids，未命中时带 reason
      const cycle = JSON.parse(await ctx.exec(`(async function () {
        window.desktop.dsh.selDragStart(['smoke-p7-a', 'smoke-p7-b']);
        await new Promise(function (r) { setTimeout(r, 150); });
        return JSON.stringify(await window.desktop.dsh.selDragEnd());
      })()`));
      // ③ 不变量（成对 ✓）：把状态栏擦干净后再来一轮，然后判「回执说没命中 ⇒ 状态栏不许出现送栏结论」
      await ctx.exec("window.MM.setStatus('（P7 对照组起点）'); 1");
      const again = JSON.parse(await ctx.exec(`(async function () {
        window.desktop.dsh.selDragStart(['smoke-p7-a']);
        await new Promise(function (r) { setTimeout(r, 150); });
        return JSON.stringify(await window.desktop.dsh.selDragEnd());
      })()`));
      const status = await ctx.exec("(document.querySelector('#status-text') || {}).textContent || ''");
      const delivered = /没送进侧边栏：|已把 \d+ 个节点送进侧栏输入框/.test(String(status));
      const structureOk = idle.ok === false && idle.reason === 'no-active-drag'
        && cycle.ok === true && typeof cycle.hit === 'boolean' && !!cycle.pt && Array.isArray(cycle.ids)
        && (cycle.hit === true || (typeof cycle.reason === 'string' && cycle.reason.length > 0))
        && again.ok === true;
      // ④ 几何独立复算（这条才是判别力的所在 ✓）：回执里的 hit 必须等于"ptWin 是否落在 viewRect 内"。
      //    把 src/drop-target.js 注入成恒真 ⇒ hit=true 而这里是 false ⇒ **必红** ✓（B4 判别力证明）
      const vr = again.viewRect, pw = again.ptWin;
      const expectHit = !!(vr && pw && pw.x >= vr.x && pw.x < vr.x + vr.width
        && pw.y >= vr.y && pw.y < vr.y + vr.height);
      const geometryOk = (expectHit === again.hit);
      // 命中却投喂失败是允许的（冒烟里侧栏服务没在跑 ✓）；没命中却投喂过 = 真缺陷 ⇒ 必红 ✓
      const invariantOk = (again.hit === true) ? true : (delivered === false);
      return { ok: structureOk && invariantOk && geometryOk,
        text: '空闲回执=' + JSON.stringify(idle) + ' ｜ 循环回执=' + JSON.stringify(cycle)
          + ' ｜ 第二次 hit=' + again.hit + ' 状态栏=' + JSON.stringify(String(status).slice(0, 60))
          + ' ｜ 不变量（hit=false ⇒ 不投喂）=' + invariantOk
          + ' ｜ 几何复算 hit应=' + expectHit + ' 实=' + again.hit + ' ⇒ ' + geometryOk
          + ' ｜ viewRect=' + JSON.stringify(vr) + ' ptWin=' + JSON.stringify(pw) };
    }
  }
  ,
  /* ================= ①-A / ①-B（2026-10-33 批2）=================
   * 这两条 bug 的共同点：**结论只能从主进程侧的读数看出来**，渲染层的 DOM 上看不见。
   *   ①-B：落点判定被喂了两种窗口矩形基准 ⇒ 侧栏**底部 57px / 右侧 8px** 判不中（盲带），
   *         侧栏**上缘之上 57px / 左缘之外 8px** 判中（假命中带）。⚠️ 方向别记反：Δy=−57 ⇒ 矩形上移。
   *         判据钉在 **P3（内部最下 1px）/ P6（内部距右缘 4px）** 上 —— 顶部那条在新旧口径下都是 true，
   *         拿它当判据 = 假绿。
   *   ①-A：指针进原生侧栏视图后渲染层收不到 mouseup ⇒ 终点由主进程接"侧栏页自己的 mouseup"。
   *         判据靠 `MM.selDropStats()` 的**投放计数**（只读，给冒烟断言用）：进侧栏松手恰好 1 次、
   *         重复上报仍 1 次、导图页松手 0 次、没 start 直接 release 0 次。
   * 断言顺序有讲究：本块排在「P7 起点/终点上报」之后（那条要一个干净的 no-active-drag），
   * 排在「P7 渲染层接线」之前（那条会留下一个**没有结束**的拖拽 ⇒ 会污染本块的第 1 条）。 */
  {
    name: '①-A 没有 sel-drag-start 直接 release ⇒ **0 次**投喂（不许把上一次拖拽的状态泄漏过来）',
    run: async (ctx) => {
      const before = await selStats(ctx);
      if (!before) return { ok: false, text: '渲染层没有 MM.selDropStats ⇒ 投喂计数不可观测（本批判据全靠它 ✗）' };
      const v = await execJson(ctx, '(async function () { return JSON.stringify(await window.desktop.dsh.selDragEnd()); })()');
      await sleep(300);
      const after = await selStats(ctx);
      const d = (after ? after.feeds : NaN) - before.feeds;
      const reasonOk = v && (v.reason === 'no-active-drag' || v.reason === 'already-ended');
      const ok = d === 0 && v && v.ok === false && reasonOk;
      return { ok: !!ok, text: 'feeds=' + before.feeds + '→' + (after ? after.feeds : '?') + '（Δ=' + d + '，应 0）'
        + ' ｜ 回执=' + JSON.stringify({ ok: v && v.ok, reason: v && v.reason })
        + ' ｜ verdicts=' + before.verdicts + '→' + (after ? after.verdicts : '?') };
    }
  },

  {
    name: '①-A 导图页里松手 ⇒ **不投喂**（0 次）+ 回执明说 point-not-over-sidebar（"该不投"那侧）',
    run: async (ctx) => {
      const pt = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: !!r, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`);
      if (!pt.ok) return { ok: false, text: '量不到面板内一点：' + JSON.stringify(pt) };
      const before = await selStats(ctx);
      const v = await execJson(ctx, '(async function () {'
        + ' window.desktop.dsh.selDragStart(["smoke-a1", "smoke-a2"]);'
        + ' await new Promise(function (x) { setTimeout(x, 120); });'
        + ' return JSON.stringify(await window.desktop.dsh.selDragEnd({ x: ' + pt.x + ', y: ' + pt.y + ' }));'
        + '})()');
      await sleep(300);
      const after = await selStats(ctx);
      const d = (after ? after.feeds : NaN) - before.feeds;
      const ok = d === 0 && v && v.hit === false && v.reason === 'point-not-over-sidebar';
      return { ok: !!ok, text: '松手点（面板内）=' + JSON.stringify({ x: pt.x, y: pt.y })
        + ' ｜ feeds=' + before.feeds + '→' + (after ? after.feeds : '?') + '（Δ=' + d + '，应 0）'
        + ' ｜ 回执=' + JSON.stringify({ ok: v && v.ok, hit: v && v.hit, reason: v && v.reason, ptWin: v && v.ptWin, viewRect: v && v.viewRect }) };
    }
  },

  {
    name: '①-A 进侧栏松手 ⇒ **恰好 1 次**投喂（主进程接"侧栏页自己的 mouseup" = 唯一权威终点）',
    run: async (ctx) => {
      // 前置（本域自己摆，末条断言复原）：侧栏必须**真的建起视图**，否则没有"侧栏页"可投真输入
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红，不静默 */ } selBlockShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      let vb = null;
      try { vb = sidebar.viewBounds(); } catch (e) { vb = null; }
      if (!wc || !vb || !(vb.width > 40 && vb.height > 40)) {
        return { ok: false, text: '侧栏视图没建起来（hasWc=' + !!wc + ' viewBounds=' + JSON.stringify(vb)
          + ' visible=' + (function () { try { return sidebar.isVisible(); } catch (e) { return '?'; } })()
          + '）⇒ 无"侧栏页"可投真输入，这条判据无从成立 ✗' };
      }
      const at = { x: Math.round(vb.width / 2), y: Math.round(vb.height / 4) };   // 页内坐标（不取正中：状态页的按钮在正中）
      const before = await selStats(ctx);
      await ctx.exec('window.desktop.dsh.selDragStart(["smoke-s1", "smoke-s2"]); 1');
      await sleep(350);   // 等主进程"找视图 → 订 console-message → 注入监听器"
      let installed = null;
      try { installed = await wc.executeJavaScript('window.__mmSelReleaseInstalled === true', true); } catch (e) { installed = 'err:' + ((e && e.message) || e); }
      sendToSidebarPage(wc, 'mouseMove', at);
      sendToSidebarPage(wc, 'mouseDown', at);
      sendToSidebarPage(wc, 'mouseUp', at);
      await sleep(450);
      const after = await selStats(ctx);
      const d = (after ? after.feeds : NaN) - before.feeds;
      // 交叉证据（不是替代）：这条拖拽在主进程那边**已经结束**了 ⇒ 再要一次回执必须是 already-ended
      const v2 = await execJson(ctx, '(async function () { return JSON.stringify(await window.desktop.dsh.selDragEnd()); })()');
      const endOk = v2 && v2.ok === false && v2.reason === 'already-ended';
      const ok = installed === true && d === 1 && endOk;
      return { ok: !!ok, text: '侧栏页注入标记=' + JSON.stringify(installed) + ' viewBounds=' + JSON.stringify(vb)
        + ' 输入点(页内)=' + JSON.stringify(at)
        + ' ｜ feeds=' + before.feeds + '→' + (after ? after.feeds : '?') + '（Δ=' + d + '，应 **1**）'
        + ' ｜ 再要一次回执=' + JSON.stringify({ ok: v2 && v2.ok, reason: v2 && v2.reason }) + '（应 already-ended）' };
    }
  },

  {
    name: '①-A 同一次松手重复上报 ⇒ 仍然 **1 次**（st.ended 闸；重复上报不许再投）',
    run: async (ctx) => {
      const wc = sidebarWc();
      let vb = null;
      try { vb = sidebar.viewBounds(); } catch (e) { vb = null; }
      if (!wc || !vb || !(vb.width > 40 && vb.height > 40)) {
        return { ok: false, text: '侧栏视图不在（上一条应已建起）⇒ 无法复现重复上报 ｜ viewBounds=' + JSON.stringify(vb) };
      }
      const at = { x: Math.round(vb.width / 2), y: Math.round(vb.height / 4) };
      const s0 = await selStats(ctx);
      await ctx.exec('window.desktop.dsh.selDragStart(["smoke-r1"]); 1');
      await sleep(350);
      sendToSidebarPage(wc, 'mouseMove', at);
      sendToSidebarPage(wc, 'mouseDown', at);
      sendToSidebarPage(wc, 'mouseUp', at);
      await sleep(450);
      const s1 = await selStats(ctx);          // 第 1 次上报后
      // 同一次松手**再报一遍**（OS 重复上报 / 页面重放的最坏形态：同一坐标再来一次）
      sendToSidebarPage(wc, 'mouseUp', at);
      await sleep(350);
      const s2 = await selStats(ctx);
      // 渲染层那条路也再来一遍（它就等价于"乐观提前结束"晚到）
      const v = await execJson(ctx, '(async function () { return JSON.stringify(await window.desktop.dsh.selDragEnd()); })()');
      await sleep(250);
      const s3 = await selStats(ctx);
      const d1 = s1.feeds - s0.feeds, d2 = s2.feeds - s1.feeds, d3 = s3.feeds - s2.feeds;
      const ok = d1 === 1 && d2 === 0 && d3 === 0 && v && v.reason === 'already-ended';
      return { ok: !!ok, text: 'feeds 三段：' + s0.feeds + '→' + s1.feeds + '→' + s2.feeds + '→' + s3.feeds
        + '（应 +1 / +0 / +0，实 Δ=' + d1 + '/' + d2 + '/' + d3 + '）'
        + ' ｜ 重复上报后回执=' + JSON.stringify({ ok: v && v.ok, reason: v && v.reason }) };
    }
  },

  {
    name: '①-B 判定基准：给窗口喂"外层≠客户区"的受控矩形（Δ 取真机实测 (-8,-57,16,65)）—— 基准一错就翻转',
    run: async (ctx) => {
      /* ⚠️ 为什么必须用**受控矩形**（这条是实测逼出来的，不是讲究）：
       * 本机**冒烟窗口**的两个矩形实测相等（下面 `真实Δ` 那条读数就是它）⇒ 拿真实窗口喂，
       * "外层矩形"与"客户区矩形"给出同一个值，这条判据对 ①-B **毫无判别力**（假绿）。
       * 真机上两者不等：主窗口有框架 + 菜单栏，实测 Δ = 外层 − 客户区 = (-8,-57,16,65)
       * （`.review/20261033-U验证/log-u3.txt` 的 U3 读数，权威）⇒ 判定矩形上移 57px、左移 8px。
       * 所以这里把**窗口的两个矩形按那个 Δ 分开**（只替换读数来源，产品代码一个字节不改），
       * 再由同一条产品判定路径去判四点 ⇒ 基准选错就会翻转。
       * 注入判别力证明见 `.review/20261033-批2-AB修复/`：把 main.js 的 `wb` 改回外层矩形 ⇒ 本断言必红。 */
      const win = ctx.win;
      let outer = null, cont = null;
      try { outer = win.getBounds(); cont = win.getContentBounds(); } catch (e) { /* 下面判红 */ }
      if (!cont || !(cont.width > 40 && cont.height > 40)) return { ok: false, text: '取不到窗口客户区矩形：' + JSON.stringify({ outer, cont }) };
      const realDelta = outer ? { x: cont.x - outer.x, y: cont.y - outer.y, w: cont.width - outer.width, h: cont.height - outer.height } : null;
      const realZero = !!realDelta && realDelta.x === 0 && realDelta.y === 0 && realDelta.w === 0 && realDelta.h === 0;
      // 真机实测的 Δ（U3）：只作为"把两个矩形分开"的受控输入，不参与任何断言的计算
      const DW = { x: -8, y: -57, w: 16, h: 65 };
      const origOuter = win.getBounds, origCont = win.getContentBounds;
      const rows = [];
      let ok = true, vr = null;
      try {
        // —— 受控前先读一条"真实窗口"的读数（证明路径通；它对 ①-B 无判别力，故不作为判据）——
        const realP3 = await verdictAt(ctx, null);   // 拿真实 viewRect（顺带证明真实窗口下路径不炸）
        vr = realP3 && realP3.viewRect;
        if (!vr || !(vr.width > 40 && vr.height > 40)) {
          return { ok: false, text: '回执里没有可用的 viewRect（侧栏没开？）⇒ 无法独立复算 ｜ 回执=' + JSON.stringify(realP3) };
        }
        win.getContentBounds = function () { return { x: cont.x, y: cont.y, width: cont.width, height: cont.height }; };
        win.getBounds = function () { return { x: cont.x + DW.x, y: cont.y + DW.y, width: cont.width + DW.w, height: cont.height + DW.h }; };

        const mx = Math.round(vr.x + vr.width / 2);
        const my = Math.round(vr.y + vr.height / 2);
        const cases = [
          // ① 盲带侧：真在侧栏**内部**。基准错时 Δy=−57 ⇒ 底部 57px 判不中；Δx=−8 ⇒ 右侧 8px 判不中
          { id: 'P3 内部最下 1px', at: { x: mx, y: vr.y + vr.height - 1 }, want: true },
          { id: 'P6 内部距右缘 4px', at: { x: vr.x + vr.width - 4, y: my }, want: true },
          // ② 对照侧：导图页那一侧（离左缘 40px > 控制栏 30px ⇒ 确实在侧栏视图矩形之外）⇒ 判据不许恒真
          { id: '对照 左缘之外 40px', at: { x: vr.x - 40, y: my }, want: false }
        ];
        // ③ 假命中带：优先"上缘之上 30px"（基准错时 Δy=−57 会把它判成命中）。client 坐标不能为负 ⇒ 为负换左侧那条
        if (vr.y - 30 >= 0) cases.push({ id: '假命中带 上缘之上 30px', at: { x: mx, y: vr.y - 30 }, want: false, note: '基准错时 Δy=−57 ⇒ 上缘之上 57px 会判中' });
        else cases.push({ id: '假命中带 左缘之外 4px', at: { x: vr.x - 4, y: my }, want: false, note: '上缘之上 30px = client y=' + (vr.y - 30) + ' 为负（渲染层不可能上报）⇒ 换 Δx=−8 造出的左侧 8px 那条；它同样落在侧栏视图矩形之外' });
        for (const c of cases) {
          const v = await verdictAt(ctx, c.at);
          const hitOk = v.hit === c.want;
          const dd = v.ptWin ? { x: v.ptWin.x - c.at.x, y: v.ptWin.y - c.at.y } : null;
          // 换算与判定用了**同一个**窗口矩形 ⇒ ptWin 必须等于传入点；用外层矩形则差值恒 = Δ = (8,57)
          const basisOk = !!dd && Math.abs(dd.x) <= 1 && Math.abs(dd.y) <= 1;
          const reasonOk = c.want ? (v.reason === '' || v.reason === undefined) : (v.reason === 'point-not-over-sidebar');
          if (!hitOk || !basisOk || !reasonOk) ok = false;
          rows.push(c.id + ' at=' + JSON.stringify(c.at) + ' hit=' + v.hit + '(应' + c.want + (hitOk ? '✓' : '✗') + ')'
            + ' ptWin−at=' + JSON.stringify(dd) + (basisOk ? '✓' : '✗') + ' reason=' + (v.reason || '—') + (reasonOk ? '✓' : '✗')
            + (c.note ? '（' + c.note + '）' : ''));
        }
      } finally {
        win.getBounds = origOuter;                     // 受控读数必须还原：不给后续断言留假窗口 ✗
        win.getContentBounds = origCont;
      }
      // 还原的读数（泄漏 = 后面所有域都在用假矩形 ⇒ 必须判据化）
      const restored = win.getBounds === origOuter && win.getContentBounds === origCont;
      if (!restored) ok = false;
      // 复原本块自己摆的前提：只关"本块自己打开的"侧栏
      if (selBlockShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } selBlockShowedSidebar = false; }
      return { ok: ok && restored,
        text: '真实Δ(客户区−外层)=' + JSON.stringify(realDelta) + '（' + (realZero
          ? '本机冒烟窗口两矩形相等 ⇒ 真实窗口对 ①-B 无判别力，判据因此走受控矩形'
          : '非零 ⇒ 真实窗口本身就有带，受控矩形的 Δ 与它同向')
        + '） ｜ 受控Δ(外层−客户区)=' + JSON.stringify(DW) + ' ｜ viewRect=' + JSON.stringify(vr)
        + ' ｜ ' + rows.join(' ｜ ') + ' ｜ 受控读数已还原=' + restored };
    }
  },

  {
    name: 'P7 渲染层接线：回执说命中 ⇒ 真的投喂；回执说没命中 ⇒ 不许投喂（成对 ✓ 用桩判接线，不依赖真实光标 ✗）',
    run: async (ctx) => {
      /* 用户 2026-10-31 规格把这条的**前置**改了：只有**多选（>1）**才允许拖给 DSH
       * ⇒ 本条的夹具必须是两个节点的选区（原先用单个节点 ⇒ 在新规格下必红，那是**规格变了**不是缺陷）。
       * 另加第 3 回合做**对照**：单选落在"回执说命中"上时**必须不投喂**（同一套接线，两个结论）。 */
      const prep = await execJson(ctx, `(function () {
        var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
        var ok = [];
        for (var i = 0; i < all.length && ok.length < 2; i++) {
          var el = all[i], id = el.getAttribute('nodeid');
          if (id === 'root') continue;
          var r = el.getBoundingClientRect();
          if (!(r.width > 20 && r.height > 10)) continue;
          if (!(r.left > 4 && r.top > 40 && r.right < window.innerWidth - 200 && r.bottom < window.innerHeight - 60)) continue;
          var p = { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + Math.round(r.height / 2)) };
          var at = document.elementFromPoint(p.x, p.y);
          if (!(at && at.closest && at.closest('jmnode[nodeid]') === el)) continue;
          ok.push({ id: id, x: p.x, y: p.y, topic: String((window.MMApp.getState().jm.get_node(id) || {}).topic || '') });
        }
        if (ok.length < 2) return JSON.stringify({ ok: false, text: '找不到两个可点的可见非根节点（本需 2 个做多选夹具）' });
        return JSON.stringify({ ok: true, a: ok[0], b: ok[1] });
      })()`);
      if (!prep.ok) return { ok: false, text: prep.text };
      const drop = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.right - 100), y: ${prep.a.y} });   // 离右缘 100px ⇒ 不触发 24px 兜底 ✓
      })()`);
      const deliverRe = "没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框|正在送进侧栏";
      const statusOf = async () => {
        const r = await execJson(ctx, `(function () {
          var s = (document.querySelector('#status-text') || {}).textContent || '';
          return JSON.stringify({ ok: new RegExp(${JSON.stringify(deliverRe)}).test(s), text: s.slice(0, 70) });
        })()`);
        return r;
      };
      /* 多选夹具 + 桩回执。`stubHit` = 主进程回执要说"命中"还是"没命中"。 */
      const setup = async (stubHit) => {
        await ctx.exec(`(function () {
          if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
          if (window.MM.clearSelection) window.MM.clearSelection();
          window.MM.toggleNodeSelection(${JSON.stringify(prep.a.id)});
          window.MM.toggleNodeSelection(${JSON.stringify(prep.b.id)});
          window.__mmOrigVerdict = window.__mmOrigVerdict || window.MM.requestSelDropVerdict;
          window.MM.requestSelDropVerdict = function () { return { ok: true, hit: ${stubHit ? 'true' : 'false'} }; };
          window.MM.setStatus('（P7 渲染层起点）');
          return 1;
        })()`);
      };
      // —— 第一回合：**多选** + 桩回执 hit=true ⇒ 必须投喂
      const s0 = await selStats(ctx);
      await setup(true);
      await pressDrag(ctx, { x: prep.a.x, y: prep.a.y }, drop, 3);
      mouse(ctx, 'mouseUp', drop);
      await sleep(500);
      const hitRes = await statusOf();
      const s1 = await selStats(ctx);
      // —— 第二回合（对照组）：同一个手势 + 桩回执 hit=false ⇒ 同一个多选**不许**投喂
      await setup(false);
      await pressDrag(ctx, { x: prep.a.x, y: prep.a.y }, drop, 3);
      mouse(ctx, 'mouseUp', drop);
      await sleep(500);
      const missRes = await statusOf();
      const s2 = await selStats(ctx);
      // —— 第三回合（新规格对照）：**单选** + 桩回执 hit=true ⇒ 必须**不**投喂（不是多选就没有拖给 DSH 这回事）
      await ctx.exec(`(function () {
        if (window.MM.clearSelection) window.MM.clearSelection();
        window.MM.toggleNodeSelection(${JSON.stringify(prep.a.id)});
        window.MM.requestSelDropVerdict = function () { return { ok: true, hit: true }; };
        window.MM.setStatus('（P7 单选对照起点）');
        return 1;
      })()`);
      await pressDrag(ctx, { x: prep.a.x, y: prep.a.y }, drop, 3);
      mouse(ctx, 'mouseUp', drop);
      await sleep(500);
      const singleRes = await statusOf();
      const s3 = await selStats(ctx);
      // 收尾：把桩撤掉（不给后续断言留假回执 ✗）
      await ctx.exec('(function () { if (window.__mmOrigVerdict) window.MM.requestSelDropVerdict = window.__mmOrigVerdict; if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      const d1 = s1.feeds - s0.feeds, d2 = s2.feeds - s1.feeds, d3 = s3.feeds - s2.feeds;
      /* `statusOf().ok` 的语义 = "状态栏出现了送栏结论"。所以：
       *   命中那轮要 **true**、未命中那轮与单选那轮都要 **false**（成对判据 ✓）。 */
      const ok = !!hitRes.ok && missRes.ok === false && singleRes.ok === false && d1 === 1 && d2 === 0 && d3 === 0;
      return { ok: ok, text: '多选命中 ⇒ ' + hitRes.text + '（feeds +' + d1 + '，应 1）'
        + ' ｜ 多选未命中 ⇒ ' + missRes.text + '（feeds +' + d2 + '，应 0）'
        + ' ｜ **单选**命中 ⇒ ' + singleRes.text + '（feeds +' + d3 + '，应 0 —— 用户 2026-10-31 规格）'
        + ' ｜ 夹具=多选 [' + prep.a.id + ',' + prep.b.id + ']'
        + ' ｜ 四条判据：hit=' + hitRes.ok + ' miss=' + missRes.ok + ' singleNoFeed=' + (singleRes.ok === false)
        + ' Δ=' + [d1, d2, d3].join('/') };
    }
  },

  /* ================= G1–G6：拖动虚影（甲）+ 直接拖的判定表（2026-10-33 批3）=================
   * 判据口径（为什么只能是这些）：虚影是 `WebContentsView` ⇒ 截不到、DOM 里没有；
   * 能读的只有 getVisible / getBounds / children / 虚影页面自报的 #t，加渲染层自报的偏移两桶。
   * 指针：`ctx.selDrag.inject()`（--smoke 专用；生产路径恒 null ⇒ 读真光标）。 */
  {
    name: 'G1 拖动虚影「在」且「跟手」：注 3 个确定点 ⇒ getVisible()=true、getBounds()==pt+偏移（每轴 ≤2px）、三拍随 pt 平移',
    run: async (ctx) => {
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ⇒ 本批判据无从成立 ✗' };
      if (!(await startDrag(ctx, ['smoke-g1-a', 'smoke-g1-b']))) return { ok: false, text: '起点上报失败（desktop.dsh.selDragStart 没接上）' };
      const r0 = ctx.selDrag.read();
      if (!r0.active) return { ok: false, text: '拖拽没起来 ⇒ 虚影无从判 ｜ read=' + JSON.stringify(r0).slice(0, 300) };
      const wb = r0.winBox, off = r0.offset;
      if (!wb) return { ok: false, text: '读不到窗口客户区矩形 ⇒ 无法把指针换算成客户区坐标 ｜ read=' + JSON.stringify(r0).slice(0, 200) };
      const pts = [
        { x: wb.x + 200, y: wb.y + 150 },
        { x: wb.x + 520, y: wb.y + 330 },
        { x: wb.x + 300, y: wb.y + 430 }
      ];
      const rows = [], got = [];
      let ok = true;
      for (let i = 0; i < pts.length; i++) {
        const inj = ctx.selDrag.inject(pts[i]);
        const g = inj && inj.read && inj.read.ghost;
        if (!g || g.visible !== true || !g.bounds) { ok = false; rows.push('第' + (i + 1) + '拍 visible=' + (g && g.visible) + ' bounds=' + JSON.stringify(g && g.bounds)); continue; }
        // 期望位置 = 指针（客户区） + 产品的偏移（偏移由产品报，两条轴距的**合规性**在 G2 里判）
        const exp = { x: pts[i].x - wb.x + off.dx, y: pts[i].y - wb.y + off.dy };
        const d = { x: g.bounds.x - exp.x, y: g.bounds.y - exp.y };
        const near = Math.abs(d.x) <= 2 && Math.abs(d.y) <= 2;
        if (!near) ok = false;
        got.push(g.bounds);
        rows.push('第' + (i + 1) + '拍 pt=' + JSON.stringify(pts[i]) + ' ⇒ bounds=' + JSON.stringify(g.bounds)
          + ' 期望=' + JSON.stringify(exp) + ' Δ=' + JSON.stringify(d) + (near ? '✓' : '✗'));
      }
      // "跟手"的另一半：位移必须**等于**指针位移（位置写死成常量 ⇒ 这里必红）
      let follow = got.length === 3;
      const followRows = [];
      for (let i = 1; i < got.length; i++) {
        const db = { x: got[i].x - got[i - 1].x, y: got[i].y - got[i - 1].y };
        const dp = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
        const same = Math.abs(db.x - dp.x) <= 2 && Math.abs(db.y - dp.y) <= 2;
        if (!same) follow = false;
        followRows.push('Δbounds=' + JSON.stringify(db) + ' Δpt=' + JSON.stringify(dp) + (same ? '✓' : '✗'));
      }
      const end = await endDrag(ctx);
      const after = ctx.selDrag.read();
      return { ok: ok && follow && !!end && end.ok === true,
        text: rows.join(' ｜ ') + ' ｜ 跟手：' + followRows.join(' ') + ' ⇒ ' + follow
          + ' ｜ 偏移(读自产品)=' + JSON.stringify(off) + ' 尺寸=' + JSON.stringify(r0.ghost && r0.ghost.size)
          + ' ｜ 收尾：回执 ok=' + (end && end.ok) + ' ghost.visible=' + (after.ghost && after.ghost.visible) };
    }
  },

  {
    name: 'G2 ★ 指针永不落入虚影矩形：连采 3 拍 contains=false 且两轴距离 ≥12px（并自检这套谓词不是恒绿）',
    run: async (ctx) => {
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ⇒ 本批判据无从成立 ✗' };
      if (!(await startDrag(ctx, ['smoke-g2-a', 'smoke-g2-b']))) return { ok: false, text: '起点上报失败' };
      const r0 = ctx.selDrag.read();
      if (!r0.active || !r0.winBox) return { ok: false, text: '拖拽没起来 / 没有客户区矩形 ｜ read=' + JSON.stringify(r0).slice(0, 240) };
      const wb = r0.winBox, gap = r0.minGap;
      /** 断言侧的**独立复算**（故意不调产品的 ghostGapOk）：两轴距离 + 是否包含指针。 */
      const measure = (rect, ptC) => {
        const xGap = (ptC.x < rect.x) ? (rect.x - ptC.x) : ((ptC.x > rect.x + rect.width) ? (ptC.x - rect.x - rect.width) : -1);
        const yGap = (ptC.y < rect.y) ? (rect.y - ptC.y) : ((ptC.y > rect.y + rect.height) ? (ptC.y - rect.y - rect.height) : -1);
        const contains = ptC.x >= rect.x && ptC.x <= rect.x + rect.width && ptC.y >= rect.y && ptC.y <= rect.y + rect.height;
        return { xGap: xGap, yGap: yGap, contains: contains, ok: !contains && xGap >= gap && yGap >= gap };
      };
      // 三个点里有一个故意贴着窗口右下角（逼出"翻到另一侧"的夹取分支）
      const pts = [
        { x: wb.x + 240, y: wb.y + 200 },
        { x: wb.x + wb.width - 30, y: wb.y + 180 },
        { x: wb.x + wb.width - 40, y: wb.y + wb.height - 30 }
      ];
      const rows = [];
      let ok = true, containsFalse = 0, minAxis = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const inj = ctx.selDrag.inject(pts[i]);
        const g = inj && inj.read && inj.read.ghost;
        if (!g || g.visible !== true || !g.bounds) { ok = false; rows.push('第' + (i + 1) + '拍虚影不在（visible=' + (g && g.visible) + '）✗'); continue; }
        const ptC = { x: pts[i].x - wb.x, y: pts[i].y - wb.y };
        const m = measure(g.bounds, ptC);
        if (m.contains === false) containsFalse++;
        minAxis = Math.min(minAxis, m.xGap, m.yGap);
        if (!m.ok) ok = false;
        rows.push('第' + (i + 1) + '拍 pt(客户区)=' + JSON.stringify(ptC) + ' bounds=' + JSON.stringify(g.bounds)
          + ' contains=' + m.contains + ' 轴距=(' + m.xGap + ',' + m.yGap + ')' + (m.ok ? '✓' : '✗'));
      }
      // ★ 判别力自检：同一套谓词喂一个"指针落在矩形左上角"的假矩形 ⇒ 必须判 false（否则本谓词恒绿、这条断言空转）
      const badRect = { x: pts[0].x - wb.x, y: pts[0].y - wb.y, width: 240, height: 40 };
      const badM = measure(badRect, { x: pts[0].x - wb.x, y: pts[0].y - wb.y });
      const predicateLive = badM.ok === false && badM.contains === true;
      if (!predicateLive) ok = false;
      const end = await endDrag(ctx);
      return { ok: ok && predicateLive && containsFalse === 3,
        text: rows.join(' ｜ ') + ' ｜ contains=false 次数=' + containsFalse + '/3 ｜ 最小轴距=' + minAxis + 'px（下限 gap=' + gap + '）'
          + ' ｜ 谓词自检（假矩形=指针在左上角）⇒ contains=' + badM.contains + ' ok=' + badM.ok + ' ⇒ 判别力=' + predicateLive
          + ' ｜ 收尾回执 ok=' + (end && end.ok) };
    }
  },

  {
    name: 'G3 终点收起：三条终点路走同一个 selDragFinish ⇒ getVisible()=false；children 计数第 2/3 轮不再增长（复用，不建新视图）',
    run: async (ctx) => {
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ✗' };
      const w0 = ctx.selDrag.read();
      const n0 = kidsOf(ctx).length;
      const rows = [];
      let ok = true;
      const counts = [];
      for (let round = 1; round <= 3; round++) {
        if (!(await startDrag(ctx, ['smoke-g3-' + round + 'a', 'smoke-g3-' + round + 'b']))) { ok = false; rows.push('第' + round + '轮起点上报失败'); break; }
        const r0 = ctx.selDrag.read();
        if (!r0.active || !r0.winBox) { ok = false; rows.push('第' + round + '轮拖拽没起来'); break; }
        const wb = r0.winBox;
        const inj = ctx.selDrag.inject({ x: wb.x + 300, y: wb.y + 260 });
        const g = inj && inj.read && inj.read.ghost;
        const nMid = kidsOf(ctx).length;
        // 显示中：虚影必须在，且必须是**最后一个**子视图（"重挂即置顶"是它盖在侧栏之上唯一的保证）
        const topIdx = g && g.childIndex;
        const isTop = topIdx === nMid - 1;
        if (!(g && g.visible === true && isTop)) ok = false;
        const end = await endDrag(ctx);
        const after = ctx.selDrag.read();
        const nEnd = kidsOf(ctx).length;
        if (!(after.ghost && after.ghost.visible === false && after.active === false)) ok = false;
        if (nEnd !== nMid) ok = false;      // 收起只 setVisible(false)，**不摘视图** ⇒ 计数不变
        counts.push({ round: round, before: round === 1 ? n0 : counts[counts.length - 1].after, mid: nMid, after: nEnd });
        rows.push('第' + round + '轮 children=' + (round === 1 ? n0 : counts[counts.length - 1].before) + '→(显示中)' + nMid + '→(收起后)' + nEnd
          + ' ｜ 显示中 visible=' + (g && g.visible) + ' childIndex=' + topIdx + '/' + (nMid - 1) + '(须为末尾)'
          + ' ｜ 收起后 visible=' + (after.ghost && after.ghost.visible) + ' 回执 ok=' + (end && end.ok));
      }
      // 第二次及以后**不许再长**（第一次允许 +1：那是创建虚影）
      const grew = counts.length > 1 && (counts[counts.length - 1].mid !== counts[0].mid);
      if (grew) ok = false;
      return { ok: ok && !grew && counts.length === 3,
        text: '首轮前 children=' + n0 + ' ｜ ' + rows.join(' ｜ ')
          + ' ｜ creates=' + (ctx.selDrag.read().ghost.creates) + '（应 1：三重复用同一块）'
          + ' ｜ 第 2/3 轮计数不再增长=' + (!grew) };
    }
  },

  {
    name: 'G4 30s 兜底（用注短的 t0，**不改 SEL_DRAG_MAX_MS**）⇒ 虚影也收起，且再要回执回 no-active-drag',
    run: async (ctx) => {
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ✗' };
      if (!(await startDrag(ctx, ['smoke-g4-a']))) return { ok: false, text: '起点上报失败' };
      const r0 = ctx.selDrag.read();
      if (!r0.active || !r0.winBox) return { ok: false, text: '拖拽没起来 ｜ read=' + JSON.stringify(r0).slice(0, 200) };
      const wb = r0.winBox;
      const shown = ctx.selDrag.inject({ x: wb.x + 300, y: wb.y + 260 }).read.ghost;
      // 把 t0 往前挪 31s ⇒ **下一次轮询**（≤40ms）就会撞上 30s 兜底（常量仍是 30000，没有"缩短超时"的开关）
      ctx.selDrag.inject({ x: wb.x + 300, y: wb.y + 260, backdateMs: 31000 });
      await sleep(220);
      const after = ctx.selDrag.read();
      const v = await endDrag(ctx);
      const ok = shown && shown.visible === true
        && after.active === false && after.ghost && after.ghost.visible === false
        && after.ended && after.ended.by === 'timeout'
        && v && v.ok === false && v.reason === 'no-active-drag';
      return { ok: !!ok, text: '兜底前 visible=' + (shown && shown.visible) + ' ｜ 兜底后 active=' + after.active
        + ' ghost.visible=' + (after.ghost && after.ghost.visible) + ' 终点 by=' + (after.ended && after.ended.by) + '（应 timeout）'
        + ' ｜ 再要一次回执=' + JSON.stringify({ ok: v && v.ok, reason: v && v.reason }) + '（应 no-active-drag）'
        + ' ｜ SEL_DRAG_MAX_MS 仍是 30000（本断言只把 st.t0 往前挪）' };
    }
  },

  {
    name: 'G5-a 判定表（单/多 × 两种落点）：single→导图页 偏移变；single→DSH 偏移不变且 feedsΔ=0；multi→导图页 偏移不变且 Δ=0',
    run: async (ctx) => {
      // 前置：侧栏要开着（"松在 DSH"这一格需要一个真实的落点矩形）
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const prep = await pickNodes(ctx, 2);
      if (!prep.ok) return { ok: false, text: prep.text };
      const a = prep.nodes[0], b = prep.nodes[1];
      /* 落点：面板里**离按下点最远**的那个角 —— 不能用"面板中心"：宽节点（如根主题）的中心
       * 就压在面板中心上 ⇒ 位移 < 4px ⇒ 这一拖连阈值都过不了（本批实测踩到，产出一条假红）。 */
      const panelRect = await execJson(ctx, `(function () { var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }); })()`);
      const farCorner = (from) => ({
        x: (from.x < (panelRect.left + panelRect.right) / 2) ? panelRect.right - 80 : panelRect.left + 40,
        y: (from.y < (panelRect.top + panelRect.bottom) / 2) ? panelRect.bottom - 60 : panelRect.top + 60
      });
      const mapPt = farCorner(a);
      let vr = null;
      try { vr = sidebar.viewBounds(); } catch (e) { vr = null; }
      if (!vr || !(vr.width > 40 && vr.height > 40)) return { ok: false, text: '侧栏视图没建起来 ⇒ 没有"松在 DSH"的落点 ｜ viewBounds=' + JSON.stringify(vr) };
      const dshPt = { x: Math.round(vr.x + vr.width / 2), y: Math.round(vr.y + Math.round(vr.height / 3)) };
      const rows = [];
      let ok = true;
      const cell = async (label, sel, where, wantOffsetChange, wantFeeds) => {
        let done = false;
        for (let attempt = 1; attempt <= 2 && !done; attempt++) {
          await settleInput(ctx);
          const hit = await selectAndHit(ctx, sel);          // 现场量（并验"真能按下"）
          if (!hit.ok) { ok = false; rows.push(label + '：⚠️ ' + hit.text + ' ｜ rect=' + JSON.stringify(hit.rect)); return; }
          const to = where === 'dsh' ? dshPt : farCorner({ x: hit.x, y: hit.y });
          const o0 = await offsets(ctx);
          const s0 = await selStats(ctx);
          const pageDrag = await pressDrag(ctx, { x: hit.x, y: hit.y }, to, 3);
          const mid = ctx.selDrag.read();
          const midOff = await offsets(ctx);            // 拖动中（松手前）的偏移：判"实时移动"真的发生过
          mouse(ctx, 'mouseUp', to);
          await settleInput(ctx);
          const o1 = await offsets(ctx);
          const s1 = await selStats(ctx);
          const dOff = offJson(o0, sel[0]) !== offJson(o1, sel[0]);
          const dFeeds = s1.feeds - s0.feeds;
          const cellOk = (dOff === wantOffsetChange) && (dFeeds === wantFeeds) && !!(pageDrag && pageDrag.armed);
          done = cellOk;
          /* 只有"两次都没成"才判这一格红 —— 单次不成是注入式输入的抖动（读数照实打印，
           * 抖动率本身也是可见的），不是产品行为。 */
          if (!done && attempt === 2) ok = false;
          rows.push(label + (attempt > 1 ? '（第' + attempt + '次）' : '')
            + '：按下=' + JSON.stringify({ x: hit.x, y: hit.y }) + ' 落点=' + JSON.stringify(to)
            + ' 拖动中偏移=' + offJson(midOff, sel[0]) + ' 松手后=' + offJson(o1, sel[0])
            + '（起始=' + offJson(o0, sel[0]) + ' Δ变=' + dOff + '，应 ' + wantOffsetChange + '）feedsΔ=' + dFeeds + '（应 ' + wantFeeds + '）' + (cellOk ? '✓' : '✗')
            + ' ｜ 渲染层 selDragState=' + JSON.stringify(pageDrag)
            + ' ｜ 主进程 active=' + mid.active + ' subject=' + JSON.stringify(mid.subject)
            + ' ghostVisible=' + (mid.ghost && mid.ghost.visible) + ' ended=' + JSON.stringify(mid.ended) + ' raw=' + JSON.stringify(hit.raw));
        }
      };
      await cell('single→导图页', [a.id], 'map', true, 0);
      await cell('single→DSH', [a.id], 'dsh', false, 0);
      await cell('multi→导图页', [a.id, b.id], 'map', false, 0);
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: rows.join(' ｜ ') + ' ｜ 面板=' + JSON.stringify(panelRect) + ' DSH(客户区)=' + JSON.stringify(dshPt)
        + ' viewRect=' + JSON.stringify(vr) };
    }
  },

  {
    name: 'G5-b 判定表：multi→DSH ⇒ feedsΔ=1 且偏移不变（多选不实时移动）；outline（大虚线框）→导图页 ⇒ 偏移变',
    run: async (ctx) => {
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      await ensureSiblingsExpanded(ctx);
      const prep = await pickSiblings(ctx, 2);
      if (!prep.ok) return { ok: false, text: prep.text };
      let vr = null;
      try { vr = sidebar.viewBounds(); } catch (e) { vr = null; }
      if (!vr || !(vr.width > 40 && vr.height > 40)) return { ok: false, text: '侧栏视图没建起来 ｜ viewBounds=' + JSON.stringify(vr) };
      const dshPt = { x: Math.round(vr.x + vr.width / 2), y: Math.round(vr.y + Math.round(vr.height / 3)) };
      const rows = [];
      let ok = true;
      let o0 = null, o1 = null, s0 = null, s1 = null;
      // ── 格 4：multi → DSH（多选不实时移动；投喂恰好 1 次）
      await settleInput(ctx);
      const hitMulti = await selectAndHit(ctx, prep.ids);
      if (!hitMulti.ok) { ok = false; rows.push('multi→DSH：⚠️ ' + hitMulti.text); }
      else {
        o0 = await offsets(ctx);
        s0 = await selStats(ctx);
        const pgMulti = await pressDrag(ctx, { x: hitMulti.x, y: hitMulti.y }, dshPt, 3);
        const midMulti = ctx.selDrag.read();
        mouse(ctx, 'mouseUp', dshPt);
        await settleInput(ctx);
        o1 = await offsets(ctx);
        s1 = await selStats(ctx);
        const mMultiChange = offJson(o0, prep.ids[0]) !== offJson(o1, prep.ids[0]) || offJson(o0, prep.ids[1]) !== offJson(o1, prep.ids[1]);
        const mFeeds = s1.feeds - s0.feeds;
        if (mMultiChange || mFeeds !== 1) ok = false;
        if (!(midMulti.subject && midMulti.subject.kind === 'multi' && midMulti.subject.toDsh === true)) ok = false;
        /* `armed` 只当读数打印、**不进判据**：它是渲染层的**瞬态**标志（松手那一刻就清掉，
         * 而注入式输入还会让上一格的迟到 mouseup 提前把它吃掉）⇒ 拿它判"这次拖起来没有"会间歇假红。
         * 这一格真正的判据是"起点 subject=multi + 偏移没变 + feedsΔ=1"——三条都是产品侧事实。 */
        rows.push('multi→DSH：按下=' + JSON.stringify({ x: hitMulti.x, y: hitMulti.y }) + ' 落点(客户区)=' + JSON.stringify(dshPt)
          + ' 偏移变=' + mMultiChange + '（应 false） feedsΔ=' + mFeeds + '（应 1）'
          + ' ｜ 起点 subject=' + JSON.stringify(midMulti.subject) + ' 渲染层 armed=' + (pgMulti && pgMulti.armed)
          + (mMultiChange || mFeeds !== 1 ? ' ✗' : ' ✓'));
      }
      // ── 格 5：outline（大虚线框）→ 导图页（框内那批同一父 ⇒ 拖的是**它们的顶层树**）
      await settleInput(ctx);
      const box = await pickOutlinePoint(ctx, prep.ids);
      if (!box.ok) { ok = false; rows.push('outline：' + box.text); }
      else {
        /* 按下**之前**再读一次同一组读数：这一格一直红在"按下时产品说不在框里"，
         * 而按下前它是真的在框里吗？这两次读数之差就是答案（框被动过？选区被清过？）。 */
        const pre = await execJson(ctx, `(function () {
          var el = document.getElementById('dsh-selection-outline');
          var r = el ? el.getBoundingClientRect() : null;
          return JSON.stringify({
            hasSel: !!(window.MM.hasSelection && window.MM.hasSelection()),
            selCount: (window.MM.getSelection ? window.MM.getSelection().count : -1),
            raw: (window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : null),
            hitTest: (window.MM.selectionHitTest ? window.MM.selectionHitTest(${box.x}, ${box.y}) : null),
            disp: el ? el.style.display : 'no-el',
            rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
            state: (window.MM.selDragState ? (window.MM.selDragState() ? 'has' : 'null') : 'no-api')
          });
        })()`);
        const treeIds = JSON.parse(await ctx.exec('(function () { return JSON.stringify([' + prep.ids.map((id) => JSON.stringify(id)).join(',') + '].map(function (id) { return window.MM.treeRootOf(id); })); })()'));
        const rootId = treeIds && treeIds[0];
        o0 = await offsets(ctx);
        s0 = await selStats(ctx);
        // 落点必须仍在**导图页**里（钻到侧栏矩形上就把这一格判成"松在 DSH"了）
        const prB = await execJson(ctx, `(function () { var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
          return JSON.stringify({ right: Math.round(r.right) }); })()`);
        const to = { x: Math.min(box.x + 160, prB.right - 60), y: box.y + 40 };
        const pgOutline = await pressDrag(ctx, { x: box.x, y: box.y }, to, 3);
        const midOutline = ctx.selDrag.read();
        /* 按下之后立刻拍一张页面快照：这一格失败过（`selDragState` 是 null = 渲染层压根没建拖拽），
         * 而"为什么没建"只能从这几个读数里看出来（拖动模式？选区空？框已经不在了？）。 */
        const od = await execJson(ctx, `(function () {
          var el = document.getElementById('dsh-selection-outline');
          var r = el ? el.getBoundingClientRect() : null;
          return JSON.stringify({
            dragMode: !!(window.MM.dragModeActive && window.MM.dragModeActive()),
            raw: (window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : null),
            selCount: (window.MM.getSelection ? window.MM.getSelection().count : -1),
            hitTest: (window.MM.selectionHitTest ? window.MM.selectionHitTest(${box.x}, ${box.y}) : null),
            disp: el ? el.style.display : 'no-el',
            rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
            state: (window.MM.selDragState ? (window.MM.selDragState() ? 'has' : 'null') : 'no-api')
          });
        })()`);
        mouse(ctx, 'mouseUp', to);
        await settleInput(ctx);
        o1 = await offsets(ctx);
        s1 = await selStats(ctx);
        const oChange = offJson(o0, rootId) !== offJson(o1, rootId);
        const oFeeds = s1.feeds - s0.feeds;
        const subjOk = !!(midOutline.subject && midOutline.subject.kind === 'outline' && midOutline.subject.toDsh === false);
        // 同上：`armed` 只打印不进判据（真正的判据是 kind=outline + 偏移变了 + 没投喂）
        if (!oChange || oFeeds !== 0 || !subjOk) ok = false;
        rows.push('outline→导图页：按下点=' + JSON.stringify({ x: box.x, y: box.y }) + ' 框=' + JSON.stringify(box.rect)
          + ' 命中测试(产品)=' + box.hitTest + ' 选区数=' + box.sel + ' 按到的元素=' + box.at
          + ' 偏移根=' + rootId + ' 偏移 ' + offJson(o0, rootId) + '→' + offJson(o1, rootId) + '（Δ变=' + oChange + '，应 true）'
          + ' feedsΔ=' + oFeeds + '（应 0） 起点 subject=' + JSON.stringify(midOutline.subject && { k: midOutline.subject.kind, n: midOutline.subject.count, toDsh: midOutline.subject.toDsh })
          + ' 渲染层 armed=' + (pgOutline && pgOutline.armed) + ' kind=' + (pgOutline && pgOutline.kind)
          + ' 现场快照=' + JSON.stringify(od) + ' 按下前=' + JSON.stringify(pre)
          + (oChange && oFeeds === 0 && subjOk ? ' ✓' : ' ✗'));
      }
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: rows.join(' ｜ ') };
    }
  },

  {
    name: 'D2 虚影外观 == 被拖节点本身，只多一层虚化：虚影页面自报的文字逐字 == 节点文字、卡片宽高 == 节点矩形（±2px）、宽高比一致（≤3%）、底色 == 节点底色、且 filter 里有 blur(>0)；主进程 setBounds 那一侧也必须是同一个尺寸',
    run: async (ctx) => {
      /* ── 这条**取代**了原来的「虚影文字四档」（旧 G5-c）─────────────────────────────────
       * 2026-10-31 那版虚影是一张**自造文案**的卡片（「移动「标题」」/「多选只能拖到 DSH」/
       * 「移动 N 个节点」/「送给 DSH（N 个节点）」）。用户 2026-10-38 在真机上看到后明确否掉：
       * 「我要的效果是外观和节点一模一样，除了有虚化效果」⇒ 文案四档这条规格**被用户新指令取代**
       * （不是被删掉：判据从"四档文案"换成"镜像那个节点"，条数不减）。
       *
       * 判据为什么必须两侧都取：
       *   · **要求边** = 主进程 `ghost.getBounds()`（便宜，但 `setBounds` 之后页面视口不跟着变
       *     是本工程踩过的坑，见 SPEC §3.5）⇒ 单看它会假绿；
       *   · **看到的边** = 虚影页面自己报的 `#card` 矩形（这才是用户看到的）；
       *   ⇒ 两边都对上同一个节点尺寸才算绿。
       * ⚠️ 节点那一侧的外观由断言**自己**在页面里读（不调产品的取样式函数）：
       *    拿被测实现验被测实现是恒等假绿。 */
      if (!ctx.selDrag || !ctx.selDrag.pageText) return { ok: false, text: '没有 ctx.selDrag.pageText ⇒ 虚影外观没有可判的读者 ✗' };
      if (!ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag.inject ⇒ 摆不出确定的虚影位置 ✗' };
      const prep = await pickNodes(ctx, 1);
      if (!prep.ok) return { ok: false, text: prep.text };
      const id = prep.nodes[0].id;
      /** 页面里**独立**读节点外观（文字 / 矩形 / 底色），与虚影页面自报的那份对拍。 */
      const readNode = async () => execJson(ctx, `(function () {
        var el = document.querySelector(${JSON.stringify('jmnode[nodeid="' + id + '"]')});
        if (!el) return JSON.stringify({ ok: false, text: '节点不在 DOM 里' });
        var r = el.getBoundingClientRect(), cs = window.getComputedStyle(el);
        return JSON.stringify({ ok: true, text: String(el.textContent || '').trim(),
          w: Math.round(r.width), h: Math.round(r.height),
          bg: String(cs.backgroundColor), color: String(cs.color) });
      })()`);
      /** 同一套比较只写一份：下面那条**判别力自检**要把一个"改坏的副本"喂进来，证明它真能红。 */
      const cmp = (got, want) => {
        const t = String(got.text) === String(want.text);
        const dW = Math.abs(Number(got.w) - Number(want.w));
        const dH = Math.abs(Number(got.h) - Number(want.h));
        const size = dW <= 2 && dH <= 2;
        const ratio = (Number(want.w) > 0 && Number(want.h) > 0 && Number(got.w) > 0 && Number(got.h) > 0)
          ? Math.abs((got.w / got.h) - (want.w / want.h)) / (want.w / want.h) : 1;
        const ratioOk = ratio <= 0.03;
        const bg = String(got.bg) === String(want.bg);
        const m = /blur\(\s*([0-9.]+)px/.exec(String(got.filter || ''));
        const blur = !!m && Number(m[1]) > 0;
        return { t: t, size: size, ratioOk: ratioOk, bg: bg, blur: blur,
          dW: dW, dH: dH, ratio: ratio, ok: t && size && ratioOk && bg && blur };
      };
      let rows = [];
      let ok = true;
      let got = null, want = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await settleInput(ctx);
        const hit = await selectAndHit(ctx, [id]);
        if (!hit.ok) { ok = false; rows.push('⚠️ ' + hit.text); break; }
        const to = { x: hit.x + 60, y: hit.y + 40 };
        const pg = await pressDrag(ctx, { x: hit.x, y: hit.y }, to, 2);
        /* 节点外观必须在**起势之后**读：jsMind 在 mousedown 时就会给节点上 `.selected`
         * （底色变蓝），虚影也是那一刻取的样 ⇒ 早读会拿"没选中"的样式去比"选中"的虚影，必然误红。 */
        want = await readNode();
        const r0 = ctx.selDrag.read();
        const wb = r0.winBox;
        const pt = wb ? { x: wb.x + 260, y: wb.y + 220 } : { x: 300, y: 300 };
        ctx.selDrag.inject(pt);
        const page = await ctx.selDrag.pageText();
        const ghost = ctx.selDrag.read().ghost;
        const pushes1 = ghost.pushes;
        for (let i = 0; i < 3; i++) ctx.selDrag.inject(pt);      // 同一位置再推 3 拍：外观没变 ⇒ 不许重推
        const pushes2 = ctx.selDrag.read().ghost.pushes;
        mouse(ctx, 'mouseUp', to);
        await sleep(180);
        const card = (page && page.card) || {};
        got = { text: page && page.text, w: Number(card.width) || 0, h: Number(card.height) || 0,
          bg: page && page.bg, filter: page && page.filter };
        const bounds = (ghost && ghost.bounds) || {};
        rows.push('第' + attempt + '次：虚影页自报 文字=' + JSON.stringify(got.text) + ' 卡片=' + JSON.stringify({ w: got.w, h: got.h })
          + ' 底色=' + JSON.stringify(got.bg) + ' filter=' + JSON.stringify(got.filter)
          + ' ｜ 节点 ' + JSON.stringify({ text: want && want.text, w: want && want.w, h: want && want.h, bg: want && want.bg })
          + ' ｜ setBounds=' + JSON.stringify(bounds) + ' 虚影显示中=' + (page && page.visible)
          + ' ｜ 推送 ' + pushes1 + '→' + pushes2 + '（同点 3 拍不许涨）');
        if (!(want && want.ok) || !(page && page.ok)) { ok = false; rows.push('前提没摆好（节点或虚影页面读数不可用）⇒ 本格判红'); continue; }
        const c = cmp(got, want);
        const sizeFromBounds = Math.abs(Number(bounds.width) - want.w) <= 2 && Math.abs(Number(bounds.height) - want.h) <= 2;
        /* ★ 判别力自检：把一个"文字换掉 + 尺寸不成比例"的副本喂进同一套比较 ⇒ 必须判 false。
         *   否则这套比较就是个恒绿的摆设（本工程最反对的那种）。 */
        const bad = cmp({ text: String(got.text) + '（假）', w: (got.h > 0 ? got.h * 2.5 : 999), h: got.h,
          bg: 'rgb(1, 2, 3)', filter: 'none' }, want);
        const live = bad.ok === false && bad.t === false && bad.size === false && bad.blur === false;
        const cellOk = c.ok && sizeFromBounds && page.visible === true && pushes1 === pushes2 && live;
        if (!cellOk) ok = false;
        rows.push('判定：文字逐字=' + c.t + ' 尺寸(Δ=' + c.dW + '/' + c.dH + ')=' + c.size
          + ' 比例(偏差=' + (c.ratio * 100).toFixed(2) + '%)=' + c.ratioOk + ' 底色=' + c.bg + ' 虚化=' + c.blur
          + ' ｜ setBounds 尺寸一致=' + sizeFromBounds + ' ｜ 判别力自检=' + live + (cellOk ? ' ✓' : ' ✗'));
        if (cellOk) break;
      }
      return { ok: ok, text: rows.join(' ｜ ') };
    }
  },

  {
    name: 'G6 虚影出现后 ①-A 仍认对侧栏视图（selSidebarView 不许抓到虚影）：进侧栏松手仍**恰好 1 次**',
    run: async (ctx) => {
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      let vb = null;
      try { vb = sidebar.viewBounds(); } catch (e) { vb = null; }
      if (!wc || !vb || !(vb.width > 40 && vb.height > 40)) {
        return { ok: false, text: '侧栏视图没建起来（hasWc=' + !!wc + ' viewBounds=' + JSON.stringify(vb) + '）⇒ 本格无从成立 ✗' };
      }
      // ① 先把虚影**显示出来**（这一格要判的正是"它出现之后"）
      if (!(await startDrag(ctx, ['smoke-g6-a', 'smoke-g6-b']))) return { ok: false, text: '起点上报失败' };
      const r0 = ctx.selDrag.read();
      if (!r0.active || !r0.winBox) return { ok: false, text: '拖拽没起来' };
      const wb = r0.winBox;
      const g = ctx.selDrag.inject({ x: wb.x + 300, y: wb.y + 240 }).read.ghost;
      if (!(g && g.visible === true)) return { ok: false, text: '虚影没显示 ⇒ 本格前提不成立 ｜ ghost=' + JSON.stringify(g) };
      // ② 独立复算"侧栏视图还在、且不是虚影那一块"
      const found = sidebarIndexIn(ctx);
      const kids = kidsOf(ctx);
      const ghostIdx = g.childIndex;
      const viewIsNotGhost = found.index >= 0 && found.index !== ghostIdx;
      const viewStillThere = found.index >= 0 && kids[found.index] && kids[found.index].webContents
        && kids[found.index].webContents.id === wc.id;
      // ③ 走 ①-A 的注入式终点：往**侧栏页**投 mouseup ⇒ 必须恰好投 1 次
      const at = { x: Math.round(vb.width / 2), y: Math.round(vb.height / 4) };
      const s0 = await selStats(ctx);
      sendToSidebarPage(wc, 'mouseMove', at);
      sendToSidebarPage(wc, 'mouseDown', at);
      sendToSidebarPage(wc, 'mouseUp', at);
      await sleep(450);
      const s1 = await selStats(ctx);
      const after = ctx.selDrag.read();
      const d = s1.feeds - s0.feeds;
      const ok = viewIsNotGhost && viewStillThere && d === 1
        && after.ghost && after.ghost.visible === false && after.active === false;
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: !!ok, text: '虚影显示中：children=' + kids.length + ' ghostIdx=' + ghostIdx
        + ' 侧栏视图 idx=' + found.index + '（依据=' + found.why + '）且 webContents.id 与 viewId 相同=' + viewStillThere
        + ' ⇒ 认到的不是虚影=' + viewIsNotGhost
        + ' ｜ 往侧栏页投 mouseup ⇒ feeds ' + s0.feeds + '→' + s1.feeds + '（Δ=' + d + '，应 1）'
        + ' ｜ 终点后 ghost.visible=' + (after.ghost && after.ghost.visible) + ' active=' + after.active };
    }
  },

  {
    name: 'G3-b 防孤儿第 4 道闸：**侧栏关** / **项目重建** 两条路都要把虚影强制收起（各一次原生读数）',
    run: async (ctx) => {
      /* 为什么单列一条：G3 只验了"四条终点路（renderer / sidebar-page / dwell / timeout）都收敛到
       * selDragFinish"，而"窗口关 / 侧栏关 / 项目重建"是**另外三条**路 —— 它们不产生终点信号，
       * 靠的是各自的钩子。没有这条判据，那三条路写没写、写对没写对，谁也看不见 ✗。
       * （窗口关那条不在这里验：窗口一关就再没有 contentView 可读，只能靠 `win.once('closed')`
       *   的代码存在性 —— 见 tests/sel-drag-ghost.test.js 的"收起点"那条判据。） */
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ✗' };
      const rows = [];
      let ok = true;
      /** 起一次拖 + 让虚影显示出来 ⇒ 读数 */
      const showGhost = async (ids) => {
        if (!(await startDrag(ctx, ids))) return { start: false };
        const r = ctx.selDrag.read();
        if (!r.active || !r.winBox) return { start: false, read: r };
        const g = ctx.selDrag.inject({ x: r.winBox.x + 300, y: r.winBox.y + 260 }).read.ghost;
        return { start: true, visible: !!(g && g.visible === true), bounds: g && g.bounds };
      };
      // ── 路 1：侧栏关（`onHide` 钩子 → 连拖拽一起结束 → 虚影收起）
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const s1 = await showGhost(['smoke-g3b-a', 'smoke-g3b-b']);
      if (!s1.start || !s1.visible) { ok = false; rows.push('侧栏关：虚影没显示 ⇒ 前提不成立 ｜ start=' + s1.start + ' visible=' + s1.visible); }
      try { sidebar.hide(); } catch (e) { /* 下面靠读数红 */ }
      g5ShowedSidebar = false;
      await sleep(260);
      const r1 = ctx.selDrag.read();
      const ok1 = !!(r1.ghost && r1.ghost.visible === false) && r1.active === false
        && !!r1.ended && r1.ended.by === 'sidebar-hide';
      if (!ok1) ok = false;
      rows.push('侧栏关 ⇒ ghost.visible=' + (r1.ghost && r1.ghost.visible) + ' active=' + r1.active
        + ' 终点 by=' + (r1.ended && r1.ended.by) + '（应 sidebar-hide）' + (ok1 ? '✓' : '✗'));
      // ── 路 2：项目重建（渲染层 renderMind → clearTreeOffsets → abortSelDrag → 主进程 finish）
      //    必须用**真鼠标**起这一拖：`abortSelDrag` 只对渲染层自己那份 `fdSelDrag` 生效
      //    （纯 IPC 起拖时渲染层根本没有那份状态 ⇒ 这条路走不到）。
      const picked = await pickNodes(ctx, 1);
      const hit = picked.ok ? await selectAndHit(ctx, [picked.nodes[0].id]) : { ok: false, text: picked.text };
      if (!hit.ok) { ok = false; rows.push('项目重建：' + (hit.text || '按不中节点')); }
      else {
        const to = { x: hit.x + 120, y: hit.y + 60 };
        await pressDrag(ctx, { x: hit.x, y: hit.y }, to, 2);
        const rMid = ctx.selDrag.read();
        const gMid = (rMid.active && rMid.winBox)
          ? ctx.selDrag.inject({ x: rMid.winBox.x + 300, y: rMid.winBox.y + 260 }).read.ghost : null;
        const visibleMid = !!(gMid && gMid.visible === true);
        if (!visibleMid) { ok = false; rows.push('项目重建：虚影没显示 ⇒ 前提不成立 ｜ active=' + rMid.active + ' visible=' + (gMid && gMid.visible)); }
        const rebuilt = await ctx.exec('(function () { if (!window.MM.clearTreeOffsets) return "no-api";'
          + ' window.MM.clearTreeOffsets(); return "cleared"; })()');
        await sleep(320);
        const r2 = ctx.selDrag.read();
        const ok2 = rebuilt === 'cleared' && visibleMid && !!(r2.ghost && r2.ghost.visible === false) && r2.active === false;
        if (!ok2) ok = false;
        rows.push('项目重建（渲染层 ' + rebuilt + '）⇒ ghost.visible=' + (r2.ghost && r2.ghost.visible)
          + ' active=' + r2.active + ' 终点 by=' + (r2.ended && r2.ended.by) + (ok2 ? '✓' : '✗'));
        mouse(ctx, 'mouseUp', to);          // 收尾：这一拖已被中止，这次松手是空操作（不留输入状态）
        await sleep(150);
      }
      return { ok: ok, text: rows.join(' ｜ ') };
    }
  },
  {
    name: 'D3-a 虚影盖在内置 DSH 上：指针在侧栏矩形内时「虚影 ∩ 侧栏」交叠面积 > 0、整段 visible=true 且处在子视图末尾（指针在导图页时交叠必须 = 0 作对照）—— 几何算错 / z 序错 / 被提前收起 三种病各有一条读数',
    run: async (ctx) => {
      /* 为什么这条要单独立（用户 2026-10-38 真机："没有虚影显示在内置 dsh 上面"）：
       * 上一批只证了**结构语义**（`addChildView` 文档 + `children` 读数 + `childIndex` 末尾），
       * 没证"虚影矩形与侧栏矩形到底有没有交叠"。三种病的修法完全不同：
       *   · 交叠 = 0 ⇒ **几何算错**（`setBounds` 的矩形换算）；
       *   · 交叠 > 0 但不在末尾 ⇒ **z 序错**（换承载物）；
       *   · 交叠 > 0 且末尾、中途却 visible=false ⇒ **被提前收起**（终点路把拖拽结束了）。
       * 本文把三种读数一次全打出来 —— 只打一个数就判，等于把三条病因混成一条。
       * ⚠️ 交叠面积由断言**自己**算（不调产品的任何几何函数）；`ghost.getBounds()` 与
       *    `sidebar.viewBounds()` 都是**客户区**坐标（同一基准，①-B 已收口）⇒ 可以直接相乘。 */
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ⇒ 虚影几何无从判 ✗' };
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      let vb = null;
      try { vb = sidebar.viewBounds(); } catch (e) { vb = null; }
      if (!vb || !(vb.width > 40 && vb.height > 40)) return { ok: false, text: '侧栏视图没建起来 ⇒ 本格前提不成立 ✗ ｜ viewBounds=' + JSON.stringify(vb) };
      const railW = Number(sidebar.RAIL_WIDTH) || 0;
      const rail = railW > 0 ? { x: vb.x - railW, y: vb.y, width: railW, height: vb.height } : null;
      /** 两个矩形的**交叠面积**（独立复算；负宽/负高按 0 计） */
      const overlap = (a, b) => {
        if (!a || !b) return 0;
        const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        return w * h;
      };
      /* 用**不可投**的 subject（single/toDsh=false）：这样"被提前收起"只会体现在虚影上，
       * 不会被一次投喂（多选）掩盖掉 —— 两个症状必须能被分开看见。 */
      if (!(await startDrag(ctx, ['smoke-d3a-a'], { kind: 'single', count: 1, label: 'D3-a', toDsh: false }))) {
        return { ok: false, text: '起点上报失败（desktop.dsh.selDragStart 没接上）' };
      }
      const r0 = ctx.selDrag.read();
      if (!r0.active || !r0.winBox) return { ok: false, text: '拖拽没起来 ⇒ 虚影无从判 ｜ read=' + JSON.stringify(r0).slice(0, 240) };
      const wb = r0.winBox;
      const rows = [];
      let ok = true;
      // ① 对照：指针在**导图页**（面板中部）⇒ 交叠必须 = 0（占位：这条证明"交叠"这个读数不是恒 > 0）
      const mapPt = toScreen(wb, { x: 200, y: 200 });
      ctx.selDrag.inject(mapPt);
      await sleep(120);
      const gm = ctx.selDrag.read().ghost;
      const mapOverlap = overlap(gm && gm.bounds, vb);
      const mapOk = !!(gm && gm.visible === true) && mapOverlap === 0;
      if (!mapOk) ok = false;
      rows.push('导图页 pt=' + JSON.stringify(mapPt) + ' ⇒ bounds=' + JSON.stringify(gm && gm.bounds)
        + ' 交叠=' + mapOverlap + '（应 0）visible=' + (gm && gm.visible) + (mapOk ? '✓' : '✗'));
      // ② 指针进侧栏：连采 5 拍（≈0.65s），每一拍都要「在、可见、在末尾、交叠 > 0」
      const dshPt = toScreen(wb, { x: Math.round(vb.x + vb.width / 2), y: Math.round(vb.y + vb.height / 2) });
      let minOverlap = Infinity, visibleAll = 0, topAll = 0, endedBy = null;
      for (let i = 1; i <= 5; i++) {
        ctx.selDrag.inject(dshPt);
        await sleep(130);
        const rd = ctx.selDrag.read();
        const g = rd.ghost;
        const ov = overlap(g && g.bounds, vb);
        const ovRail = overlap(g && g.bounds, rail);
        const isTop = !!(g && g.childIndex === g.children - 1);
        if (g && g.visible === true) visibleAll++;
        if (isTop) topAll++;
        minOverlap = Math.min(minOverlap, ov);
        if (rd.ended) endedBy = rd.ended.by;
        if (!(g && g.visible === true && isTop && ov > 0)) ok = false;
        rows.push('侧栏第' + i + '拍 bounds=' + JSON.stringify(g && g.bounds) + ' 交叠=' + ov
          + '（其中控制栏 ' + ovRail + '）visible=' + (g && g.visible)
          + ' 末尾=' + isTop + '（' + (g && g.childIndex) + '/' + (g && g.children ? g.children - 1 : '?') + '）'
          + (rd.ended ? ' 终点=' + rd.ended.by : ''));
      }
      const end = await endDrag(ctx);
      if (!(visibleAll === 5)) ok = false;
      if (!(topAll === 5)) ok = false;
      if (!(minOverlap > 0)) ok = false;
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: '侧栏矩形=' + JSON.stringify(vb) + ' 控制栏=' + JSON.stringify(rail) + ' ｜ ' + rows.join(' ｜ ')
        + ' ｜ 汇总：可见 ' + visibleAll + '/5 · 末尾 ' + topAll + '/5 · 最小交叠 ' + (minOverlap === Infinity ? '-' : minOverlap)
        + '（必须 > 0）· 中途被结束于 ' + (endedBy || '—')
        + ' ｜ 收尾回执=' + JSON.stringify({ ok: end && end.ok, reason: end && end.reason }) };
    }
  },

  {
    name: 'D3-b 终点只能是**被观测到的松手**：指针停进 DSH 按住不放 1.2s ⇒ 零投喂（悬停不是松手）；随后在侧栏页真松手 ⇒ 恰好 1 次投喂；single 松在 DSH ⇒ 零投喂且实时偏移被还原（"松在内置 dsh 就相当于不修改位置"）',
    run: async (ctx) => {
      /* 用户 2026-10-38 真机："拖动到 dsh 失败"。两条子判据必须分开：
       *   ① **悬停**不许产生 drop（改前 `main.js` 的 dwell 兜底把"悬了 400ms"当成"已经松手"）；
       *   ② **松手**必须恰好产生一次 drop。
       * 改前 ① 是红的：dwell 会在手还按着的时候把拖拽结束掉并把这一批投喂出去 ——
       * 于是 ② 永远没有机会发生（那次松手被当成"没有活动拖拽"丢弃）。
       * 这两条合起来才解释得清"拖动到 dsh 失败"：**终点不是松手**。
       * ⚠️ 松手这一拍只投**侧栏页**（`sendToSidebarPage`）：真机上指针一进原生视图，渲染层
       *    就收不到 mouseup ⇒ 往 `ctx.win` 投 mouseUp 是**假绿通道**（那种注入走的是
       *    sendInputEvent 的直投，不经过 Chromium 命中测试）。 */
      if (!ctx.selDrag || !ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag 注入通道 ✗' };
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      let vb = null;
      try { vb = sidebar.viewBounds(); } catch (e) { vb = null; }
      if (!wc || !vb || !(vb.width > 40 && vb.height > 40)) {
        return { ok: false, text: '侧栏视图没建起来（hasWc=' + !!wc + ' viewBounds=' + JSON.stringify(vb) + '）⇒ 本格无从成立 ✗' };
      }
      const rows = [];
      let ok = true;
      const pagePt = { x: Math.round(vb.width / 2), y: Math.round(vb.height / 4) };   // 侧栏**页内**坐标
      // ── 格 1：多选 + 指针停进侧栏 + **不松手** 1.2s ─────────────────────────────────
      if (!(await startDrag(ctx, ['smoke-d3b-a', 'smoke-d3b-b'], { kind: 'multi', count: 2, label: '', toDsh: true }))) {
        return { ok: false, text: '起点上报失败' };
      }
      const wb = ctx.selDrag.read().winBox;
      if (!wb) return { ok: false, text: '读不到窗口客户区矩形 ⇒ 无从注入确定指针' };
      const dshPt = toScreen(wb, { x: Math.round(vb.x + vb.width / 2), y: Math.round(vb.y + Math.round(vb.height / 3)) });
      const s0 = await selStats(ctx);
      let holdVisible = 0, holdEndedBy = null;
      for (let i = 1; i <= 6; i++) {
        ctx.selDrag.inject(dshPt);
        await sleep(200);
        const rd = ctx.selDrag.read();
        if (rd.ghost && rd.ghost.visible === true) holdVisible++;
        if (rd.ended) holdEndedBy = rd.ended.by;
        if (!rd.active) break;      // 已经被提前结束了 ⇒ 不必再等
      }
      const sHold = await selStats(ctx);
      const holdFeed = sHold.feeds - s0.feeds;
      const holdOk = holdFeed === 0 && holdVisible === 6;
      if (!holdOk) ok = false;
      rows.push('按住不动 1.2s ⇒ 投喂Δ=' + holdFeed + '（应 **0**：悬停不是松手）· 虚影可见拍数=' + holdVisible + '/6（应 6）'
        + ' · 中途被结束于=' + (holdEndedBy || '—') + (holdOk ? ' ✓' : ' ✗'));
      // ── 格 2：真松手（投在侧栏页上：真机唯一收得到 mouseup 的那张页）─────────────────
      sendToSidebarPage(wc, 'mouseMove', pagePt);
      sendToSidebarPage(wc, 'mouseDown', pagePt);
      sendToSidebarPage(wc, 'mouseUp', pagePt);
      await sleep(450);
      const s2 = await selStats(ctx);
      const relFeed = s2.feeds - sHold.feeds;
      const after2 = ctx.selDrag.read();
      const relOk = relFeed === 1 && after2.active === false && !!(after2.ghost && after2.ghost.visible === false);
      if (!relOk) ok = false;
      rows.push('侧栏页真松手 ⇒ 投喂Δ=' + relFeed + '（应 **1**）· active=' + after2.active
        + ' · ghost.visible=' + (after2.ghost && after2.ghost.visible) + (relOk ? ' ✓' : ' ✗'));
      // ── 格 3：single 松在 DSH ⇒ 按用户规格 = 取消，且**位置必须被还原** ────────────────
      /* 这一格必须用**真鼠标起势**（只有真拖才会实时期改内存里的偏移），而松手只能发生在
       * 侧栏页上 ⇒ 渲染层没有机会自己还原 ⇒ 还原只能由主进程回一条"没投喂"的通知来驱动。 */
      await settleInput(ctx);
      const pick = await pickNodes(ctx, 1);
      if (!pick.ok) { ok = false; rows.push('single→DSH：' + pick.text); }
      else {
        const sid = pick.nodes[0].id;
        const hitS = await selectAndHit(ctx, [sid]);
        if (!hitS.ok) { ok = false; rows.push('single→DSH：⚠️ ' + hitS.text); }
        else {
          const from3 = { x: hitS.x, y: hitS.y };
          const toMap = { x: 200, y: 200 };                                  // 导图页里一个固定的远点
          const to3 = { x: Math.round(dshPt.x - wb.x), y: Math.round(dshPt.y - wb.y) };
          const root3 = sid;
          /* ── 3a **前提**：同一手势先松在**导图页** ⇒ 偏移必须变 ────────────────────────
           * 为什么要有这一半：中间那一刻的偏移在本 harness 里**读不可靠**（注入的 mousemove 与
           * `executeJavaScript` 的派发顺序不保证 —— 实测同一段读数里 `armed=true` 却读不到偏移）。
           * ⇒ 判据不能写"拖动中偏移变过"，改成用**同一手势的另一条收尾**立前提：
           *   松在导图页 ⇒ 偏移变了（这一拖真的会移动节点）；松在 DSH ⇒ 偏移**回到原值**。
           * 两条同一手势、同一落点区域，只差"松在哪张页上"—— 那正是被测语义。 */
          const o0 = await offsets(ctx);
          const pgA = await pressDrag(ctx, from3, toMap, 3);
          mouse(ctx, 'mouseUp', toMap);
          await sleep(350);
          const oA = await offsets(ctx);
          const moved = offJson(o0, root3) !== offJson(oA, root3);
          await settleInput(ctx);
          /* ── 3b：同一手势，但松手发生在**侧栏页**上（真机上渲染层收不到这一拍）────────── */
          const hitB = await selectAndHit(ctx, [sid]);
          const s3a = await selStats(ctx);
          let st6 = hitB.ok ? await pressDrag(ctx, { x: hitB.x, y: hitB.y }, to3, 3) : null;
          /* 前提②：**起势之后确实推过偏移**（否则"还原"是空转的 —— 本来就没变，谈何还原）。
           * 做法：先等 `armed` 读得到（注入式输入的派发有延迟），再补两拍**大位移**，逐拍记读数。
           * 为什么必须补：起势那一拍照产品语义**不移动**位置（`selDragArm` 里 return）。 */
          const trace = [];
          for (let k = 0; k < 8 && !(st6 && st6.armed); k++) {
            mouse(ctx, 'mouseMove', { x: Math.round(hitB.x + 30 + k * 12), y: Math.round(hitB.y + 20 + k * 9) });
            await sleep(60);
            st6 = await selDragStateOf(ctx);
            trace.push('arm' + k + '=' + (st6 && st6.armed));
          }
          trace.push('armed时 kind=' + (st6 && st6.kind) + ' count=' + (st6 && st6.count)
            + ' root=' + (st6 && st6.offsetRoot) + ' at=' + JSON.stringify(st6 && st6.at));
          let oMid = await offsets(ctx);
          /* ⚠️ 每拍之间要**等够**（250ms）：注入的 mousemove 会被 Chromium 合并、并按帧派发到页面，
           * 只等 50–70ms 时读到的是"上一拍还没派发"的状态 ⇒ 偏移看着永远没变（第一轮踩了 3 次）。
           * 判"推过了"只看**偏移真的变了**，不猜派发时刻。 */
          for (let k = 0; k < 5 && offJson(oMid, root3) === offJson(oA, root3); k++) {
            mouse(ctx, 'mouseMove', { x: Math.round(to3.x + (k % 2 ? 70 : -70)), y: Math.round(to3.y - (k % 2 ? 40 : -40)) });
            await sleep(250);
            oMid = await offsets(ctx);
            const stNow = await selDragStateOf(ctx);
            trace.push('推' + k + '=' + offJson(oMid, root3) + ' at=' + JSON.stringify(stNow && stNow.at));
          }
          const pushed = offJson(oMid, root3) !== offJson(oA, root3);
          sendToSidebarPage(wc, 'mouseMove', pagePt);
          sendToSidebarPage(wc, 'mouseDown', pagePt);
          sendToSidebarPage(wc, 'mouseUp', pagePt);
          await sleep(450);
          const o1 = await offsets(ctx);
          const s3b = await selStats(ctx);
          const feedS = s3b.feeds - s3a.feeds;
          const restored = offJson(oA, root3) === offJson(o1, root3);
          const cellOk = moved && pushed && restored && feedS === 0;
          if (!cellOk) ok = false;
          rows.push('single→DSH：偏移根=' + root3
            + ' ｜ 3a 松在导图页：按下=' + JSON.stringify(from3) + ' 落点=' + JSON.stringify(toMap)
            + ' armed=' + (pgA && pgA.armed) + ' 偏移 ' + offJson(o0, root3) + '→' + offJson(oA, root3)
            + '（应**变了**=' + moved + '）'
            + ' ｜ 3b 松在侧栏页：从=' + JSON.stringify(hitB.ok ? { x: hitB.x, y: hitB.y } : null)
            + ' 落点(客户区)=' + JSON.stringify(to3) + ' armed(读)=' + (st6 && st6.armed)
            + ' 拖动中偏移=' + offJson(oMid, root3) + '（应**推过**=' + pushed + '）'
            + ' 松手后=' + offJson(o1, root3) + '（应**回到**=' + offJson(oA, root3) + ' ⇒ ' + restored + '）'
            + ' ｜ 逐拍读数=' + JSON.stringify(trace)
            + ' ｜ 投喂Δ=' + feedS + '（应 0）' + (cellOk ? ' ✓' : ' ✗'));
          await settleInput(ctx);
          await ctx.exec('(function () { if (window.MM.clearTreeOffsets) window.MM.clearTreeOffsets(); return 1; })()');
          await sleep(150);
        }
      }
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: '侧栏矩形=' + JSON.stringify(vb) + ' 注入屏幕点=' + JSON.stringify(dshPt) + ' ｜ ' + rows.join(' ｜ ') };
    }
  },

  {
    name: 'D4 拖拽结束不许改变详情面板的开合（用户 2026-10-38 真机："松开会自动打开节点详情，这个是 bug"）：三种收尾（移动成功 / 多选失败 / 松在 DSH 取消）之后详情框数与「待决单击」都必须与拖拽前一致；对照组 = 不拖动而单击 ⇒ 详情照常打开（原有行为不许被这条修法误伤）',
    run: async (ctx) => {
      /* 病根（读代码定位，不猜）：拖拽本身不产生 click，**浏览器会为同一次手势补发一次 click**
       * （mousedown 与 mouseup 落在同一个节点上时，target 就是那个节点）。而"点击 → 开详情"的
       * 唯一入口是 `renderer/app-detail-content.js` 的容器 click 处理器 → `noteNodeClick`
       * → 300ms 后 `MM.showDetail` ⇒ 拖完一松手，详情框就自己弹出来。
       * ⇒ 判据要盯的正是"**谁还认为这是一次点击**"：`MM.clickJudgeState().pending` 必须为 null，
       *    且详情框数不变。只判"详情框没开"是不够的（可能是它开了又被关掉）。
       * ⚠️ 对照组不能省：把 click 一律吞掉的修法会同时弄死"点一下节点就看详情"这条原有行为。 */
      if (!ctx.selDrag) return { ok: false, text: '没有 ctx.selDrag 通道 ⇒ 主进程侧终点无从判 ✗' };
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      let vr = null;
      try { vr = sidebar.viewBounds(); } catch (e) { vr = null; }
      /** 详情面板 + 单击判别的现场读数（一次读全：boxes / visible / 待决的那一击 / 被吞掉的补发 click） */
      const fdState = async () => execJson(ctx, '(function () {'
        + ' var d = null;'
        + ' try { d = (window.MM && window.MM.getFloatDetailState) ? window.MM.getFloatDetailState() : null; } catch (e) { d = null; }'
        + ' if (!d && window.MMApp && window.MMApp.getFloatDetailState) d = window.MMApp.getFloatDetailState();'
        + ' var c = (window.MM && window.MM.clickJudgeState) ? window.MM.clickJudgeState() : null;'
        + ' var k = (window.MM && window.MM.selDragClickState) ? window.MM.selDragClickState() : null;'
        + ' var hits = (window.__mmShowDetailHits || []).slice(-3);'
        + ' return JSON.stringify({ boxes: d ? d.boxes : -1, visible: d ? d.visible : null, nodeId: d ? d.nodeId : null,'
        + ' pending: c ? c.pending : "no-api", swallowed: k ? k.swallowed : null,'
        + ' clickArmed: k ? k.armed : null, opened: hits }); })()');
      /* ★ "谁还认为这是一次点击" 的**现场取证口**：`MM.showDetail` 是"打开详情框"的唯一入口
       * （`app-detail.js` 的注释与 `app-heat-bars.js` 的说明都写明这一点），把这个调用记下来并**留栈**
       * ⇒ 详情框到底被哪条路打开，一行都不用猜。只读包装（不改语义，收尾必须撤掉）。 */
      const resetOpened = async () => {
        await ctx.exec('(function () {'
          + ' if (!window.__mmShowDetailOrig && window.MM && window.MM.showDetail) {'
          + '   window.__mmShowDetailOrig = window.MM.showDetail;'
          + '   window.MM.showDetail = function (n) {'
          + '     try { (window.__mmShowDetailHits = window.__mmShowDetailHits || []).push({ id: (n && n.id) || null,'
          + '       stack: String((new Error()).stack || "").split("\\n").slice(1, 4).join(" ← ") }); } catch (e) {}'
          + '     return window.__mmShowDetailOrig.apply(window.MM, arguments);'
          + '   };'
          + ' }'
          + ' window.__mmShowDetailHits = []; return 1; })()');
      };
      const dropOpenedRecorder = async () => {
        await ctx.exec('(function () { if (window.__mmShowDetailOrig) { window.MM.showDetail = window.__mmShowDetailOrig;'
          + ' window.__mmShowDetailOrig = null; } return 1; })()');
      };
      const closeAll = async () => {
        await ctx.exec('(function () { if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();'
          + ' if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
        await sleep(150);
      };
      const rows = [];
      let ok = true;
      /** 一格：先清场 ⇒ 记拖拽前的开合 ⇒ 真鼠标拖一次 ⇒ 松手 ⇒ 等过判别窗口 ⇒ 再记一次。
       *  ⚠️ 前提怎么判（这是第一轮实测踩出来的关键一条）：
       *   `pressDrag` 读到的 `armed` **不可靠**（注入的 mousemove 与 `executeJavaScript` 的派发顺序
       *   不保证 ⇒ 会读到"还没 armed"，而产品其实已经按 armed 拖拽走完了）。
       *   ⇒ 前提改用**产品侧事实**：`MM.selDragClickState().armed` 在 `selDragDrop` 里 +1
       *     （= 这一次松手确实被产品当成"拖拽结束"，不是"单击"）。它比渲染层那个瞬态标志强。
       *   ⇒ 重试只在**前提没造出来**时发生；前提一成立就按判据说话（不再重试 —— 重试会把真缺陷洗掉）。 */
      const cell = async (label, ids, pickTo) => {
        let row = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          await settleInput(ctx);
          await closeAll();
          await resetOpened();                  // 每一格清一次"打开详情"的取证账
          const before = await fdState();
          const hit = await selectAndHit(ctx, ids);
          if (!hit.ok) { row = label + '：⚠️ ' + hit.text; continue; }
          const to = pickTo(hit);
          const pg = await pressDrag(ctx, { x: hit.x, y: hit.y }, to, 3);
          mouse(ctx, 'mouseUp', to);
          await sleep(700);          // > 300ms 的单击/双击判别窗口（+ 一次 setTimeout）
          const after = await fdState();
          const armedDelta = (Number(after.clickArmed) || 0) - (Number(before.clickArmed) || 0);
          const armedOk = armedDelta === 1;
          const same = after.boxes === before.boxes && after.pending === null;
          row = label + (attempt > 1 ? '（第' + attempt + '次）' : '')
            + '：起势 armed=' + (pg && pg.armed) + '/' + '产品侧 armedΔ=' + armedDelta
            + ' 按下=' + JSON.stringify({ x: hit.x, y: hit.y }) + ' 松手=' + JSON.stringify(to)
            + ' · 详情框 ' + before.boxes + '→' + after.boxes + '（应不变）· 待决单击='
            + JSON.stringify(after.pending) + '（应 null）· 补发 click 被吞=' + after.swallowed
            + ' ｜ 这一格"打开详情"的调用者=' + JSON.stringify(after.opened || [])
            + (armedOk && same ? ' ✓' : ' ✗') + (armedOk ? '' : '〔前提未成立 ⇒ 重试〕');
          if (armedOk) break;                  // 前提成立 ⇒ 判据说话，不再重试
        }
        const last = row || '';
        if (last.indexOf('✓') < 0 || last.indexOf('✗') >= 0) ok = false;
        rows.push(last);
      };
      const prep = await pickNodes(ctx, 2);
      if (!prep.ok) return { ok: false, text: prep.text };
      const a = prep.nodes[0], b = prep.nodes[1];
      const panelRect = await execJson(ctx, '(function () { var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();'
        + ' return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }); })()');
      /* 松手点：**必须保证离按下点足够远**（≥ 60px），否则连 4px 的起势阈值都过不了 ⇒
       * 那一次就成了"单击"（单击本来就该开详情）⇒ 判据会读成假红。第一轮实测就踩在这：
       * 侧栏开着时面板只有 729 宽，`min(hit.x+140, right-80)` 把落点夹回到按下点附近（Δ=2px）。 */
      const mapTo = (dx, dy) => (hit) => {
        const left = panelRect.left + 40, right = panelRect.right - 80;
        const top = panelRect.top + 40, bottom = panelRect.bottom - 60;
        let x = hit.x + dx;
        if (x > right) x = hit.x - dx;
        if (x < left || Math.abs(x - hit.x) < 60) x = (hit.x > (left + right) / 2) ? left : right;
        let y = hit.y + dy;
        if (y > bottom) y = hit.y - dy;
        if (y < top || Math.abs(y - hit.y) < 30) y = (hit.y > (top + bottom) / 2) ? top : bottom;
        return { x: Math.round(x), y: Math.round(y) };
      };
      // ── 收尾一：**移动成功**（single 松在导图页；节点会跟着指针走 ⇒ 松手那一刻指针仍在节点上）
      await cell('收尾一·移动成功(single→导图页)', [a.id], mapTo(120, 80));
      // ── 收尾二：**什么都不发生**（multi 松在导图页）
      await cell('收尾二·无效果(multi→导图页)', [a.id, b.id], mapTo(140, 90));
      // ── 收尾三：**取消**（single 松在 DSH）
      if (vr && vr.width > 40) {
        const wbNow = (() => { try { return ctx.win.getContentBounds(); } catch (e) { return null; } })();
        const dshC = wbNow
          ? { x: Math.round(vr.x + vr.width / 2), y: Math.round(vr.y + Math.round(vr.height / 3)) }
          : null;
        if (dshC) await cell('收尾三·取消(single→DSH)', [a.id], () => dshC);
      } else {
        ok = false;
        rows.push('收尾三·取消：侧栏视图没建起来 ⇒ 这一格无从成立 ✗');
      }
      // ── 对照组：**不拖动**而单击 ⇒ 详情必须照常打开（原有行为不许被误伤）
      await settleInput(ctx);
      await closeAll();
      const c0 = await fdState();
      const hitC = await selectAndHit(ctx, [a.id]);
      if (!hitC.ok) { ok = false; rows.push('对照组：⚠️ ' + hitC.text); }
      else {
        mouse(ctx, 'mouseDown', { x: hitC.x, y: hitC.y });
        mouse(ctx, 'mouseUp', { x: hitC.x, y: hitC.y });
        await sleep(700);
        const c1 = await fdState();
        const ctrlOk = c1.boxes === c0.boxes + 1 && c1.visible === true && c1.nodeId === a.id;
        if (!ctrlOk) ok = false;
        rows.push('对照组·单击不拖动 ⇒ 详情框 ' + c0.boxes + '→' + c1.boxes + '（应 +1）· visible=' + c1.visible
          + ' · nodeId=' + c1.nodeId + (ctrlOk ? ' ✓' : ' ✗'));
      }
      await ctx.exec('(function () { if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();'
        + ' if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      await settleInput(ctx);
      await dropOpenedRecorder();     // 撤掉取证包装（不给后面的断言留一个假入口 ✗）
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: rows.join(' ｜ ') };
    }
  },
  {
    name: 'N3-⑤⑥ 侧栏**对话输入框**的定位与写入（用户 2026-10-38 第三轮：「我说的是送进这个对话栏哦」——目标是带 / 指令与 @ 提及的富文本框，不是 plain textarea）：A 只有目标 ⇒ 找到并写入、回读一致；B 目标 + 无关 textarea ⇒ 必须挑目标（挑走就红）；C 只有无关 textarea ⇒ 必须 not-found 且**一个字都不写**',
    run: async (ctx) => {
      /* 为什么这样判（三轮真机反馈叠出来的）：
       *   第一轮：「拖到内置 dsh 失败」⇒ 终点判定（已修，域 30 D3-b / 域 33）。
       *   第二轮：「不管是单选还是多选，都不能拖动到内置dsh的对话栏里，内置dsh的显示信息没有任何变化」
       *          ⇒ 第五环（选择器）＋第六环（写入）。
       *   第三轮：用户给了**目标截图** —— 占位文字「描述你想要构建的内容，/ 调用指令，@ 文件或对话」、
       *          圆角浅灰大框、宽高比 ≈ 738:129 ≈ 5.7:1、带「+」「全盘可写」与发送按钮
       *          ⇒ 「我说的是送进这个对话栏哦」= **上一版送的不是这个地方**。
       *          ⇒ 带 `/` 指令与 `@` 提及的输入框**几乎必然是 contenteditable 富文本**，而上一版
       *            "优先取面积最大的 textarea"抓到的正是另一个东西（普查里那个 584×120 的 TEXTAREA）。
       * ⇒ 判据三格，一格只判一件事（缺任何一格都会退化成"抓到一个能抓的就算成功"）：
       *   A 只有目标 ⇒ 必须按**特征**认出来（placeholder 含 / 与 @、宽扁、contenteditable）并写入、回读一致；
       *   B 目标 + 无关 plain textarea（DOM 排前面）⇒ 必须挑**目标**，且无关那个框**一个字符都没被写**；
       *   C 只有无关 plain textarea ⇒ 必须 `ok:false / bucket='not-found'`，且那个框**一个字符都没被写**
       *     —— 这一格是"选择器不是'抓第一个能抓的'"的判别力证明。
       * ⚠️ 假现场的形态**照截图造**（fixed 定位 ⇒ `offsetParent === null`，占位文字照抄那一句）。
       * ⚠️ 边界（如实）：本条跑的是**产品的同一份 `COMPOSER_PREFILL_JS`**，但宿主页是冒烟里的侧栏页
       *   （没有真 DSH 服务）；`prefillComposer` 的 `state.status !== 'running'` 那道闸不在本条里，
       *   它由 CLI 的 `dsh-prefill` 与 `scripts/dsh-prefill-stub.js` 覆盖。 */
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      if (!wc) return { ok: false, text: '侧栏视图的 webContents 拿不到 ⇒ 第五环无从判 ✗' };
      const js = sidebar.COMPOSER_PREFILL_JS;
      if (typeof js !== 'string' || js.indexOf('function (text)') < 0) {
        return { ok: false, text: '产品没导出 COMPOSER_PREFILL_JS（或形态变了）⇒ 本条判不了，按红处理 ✗' };
      }
      /** 造现场 / 跑产品那份注入串 / 读回现场 —— **都在模块级**（`composerMock` 等）；
       *  本批把上一批现拼的那三小段提成共用的，理由见模块级注释（现场只许有一份）。 */
      const wcExec = (code) => composerExec(wc, code);
      const runPrefill = (mark) => composerPrefill(wc, js, mark);
      const mk = (kind) => composerMock(wc, kind, '');
      const rows = [];
      let ok = true;
      const MARK_A = '【六环·A】' + Date.now().toString(36);
      const MARK_B = '【六环·B】' + Date.now().toString(36);
      const MARK_C = '【六环·C】' + Date.now().toString(36);
      // ── A：只有目标（富文本对话框；fixed ⇒ offsetParent=null）
      const mkA = await mk('target');
      if (!mkA || !mkA.ok) return { ok: false, text: '造不出"富文本对话框"这个现场 ⇒ 前提不成立 ✗ ｜ ' + JSON.stringify(mkA) };
      const A = await runPrefill(MARK_A);
      const aState = await wcExec('(function () { var ed = document.getElementById("__mm_mock_composer");'
        + ' return JSON.stringify({ ok: true, text: ed ? String(ed.innerText || "") : "<没了>",'
        + '   offsetParentNull: ed ? ed.offsetParent === null : null }); })()');
      const aOk = !!(A && A.ok === true && A.rich === true && A.bucket === 'ok'
        && String(A.readBack || '') === MARK_A && String(aState.text || '') === MARK_A
        /* 2026-10-40：行数也是判据（1 行文本 ⇒ 回读必须 **1 行**；换行有没有成分段靠这个读数）
         * 且回执里必须能看见"真的逐行 insertText 了"（`steps` 是调用序列） */
        && A.lines === 1 && A.wantLines === 1
        && String(A.steps || '').indexOf('insertText:true') >= 0);
      if (!aOk) ok = false;
      rows.push('A·只有目标（' + mkA.w + '×' + mkA.h + ' 比例=' + mkA.ratio + '，offsetParent=null=' + mkA.offsetParentNull
        + '）⇒ 回执=' + JSON.stringify({ ok: A && A.ok, bucket: A && A.bucket, mode: A && A.mode, tag: A && A.tag, rich: A && A.rich, score: A && A.score })
        + ' · 回读一致=' + (String(A && A.readBack) === MARK_A)
        + ' · 行数=' + (A && A.lines) + '/' + (A && A.wantLines) + '（应 1/1）'
        + ' · 调用序列=' + JSON.stringify((A && A.steps) || [])
        + ' · 现场 innerText 一致=' + (String(aState.text) === MARK_A) + (aOk ? ' ✓' : ' ✗'));
      // ── B：目标 + 无关 plain textarea（DOM 里排前面；挑走它就红）
      const mkB = await mk('plain');
      if (!mkB || !mkB.ok) { ok = false; rows.push('B：造不出无关 textarea ✗'); }
      else {
        const B1 = await runPrefill(MARK_B);
        const bState = await wcExec('(function () { var ta = document.getElementById("__mm_mock_plain");'
          + ' var ed = document.getElementById("__mm_mock_composer");'
          + ' return JSON.stringify({ ok: true, taValue: ta ? String(ta.value || "") : "<没了>",'
          + '   edText: ed ? String(ed.innerText || "") : "<没了>" }); })()');
        const bOk = !!(B1 && B1.ok === true && B1.tag !== 'TEXTAREA' && String(B1.readBack || '') === MARK_B
          && String(bState.taValue || '') === '' && String(bState.edText || '') === MARK_B);
        if (!bOk) ok = false;
        rows.push('B·目标 + 无关 textarea（DOM 排前面）⇒ 挑中=' + (B1 && B1.tag) + '（不许是 TEXTAREA）· 回执 ok=' + (B1 && B1.ok)
          + ' · 无关框里=' + JSON.stringify(bState.taValue) + '（应 ""）· 目标里一致=' + (String(bState.edText) === MARK_B)
          + (bOk ? ' ✓' : ' ✗'));
      }
      // ── C：只剩无关 plain textarea ⇒ 必须 not-found，且一个字都不写
      await wcExec('(function () { var e = document.getElementById("__mm_mock_composer");'
        + ' if (e && e.parentNode) e.parentNode.removeChild(e);'
        + ' var b = document.getElementById("__mm_mock_send"); if (b && b.parentNode) b.parentNode.removeChild(b);'
        + ' var ta = document.getElementById("__mm_mock_plain"); if (ta) ta.value = "";'
        + ' return JSON.stringify({ ok: true }); })()');
      const C = await runPrefill(MARK_C);
      const cState = await wcExec('(function () { var ta = document.getElementById("__mm_mock_plain");'
        + ' return JSON.stringify({ ok: true, taValue: ta ? String(ta.value || "") : "<没了>" }); })()');
      const cOk = !!(C && C.ok === false && C.bucket === 'not-found' && String(cState.taValue || '') === '');
      if (!cOk) ok = false;
      rows.push('C·只剩无关 textarea ⇒ ok=' + (C && C.ok) + '（应 false）· bucket=' + (C && C.bucket) + '（应 not-found）'
        + ' · 文案=' + JSON.stringify((C && C.reason) || '').slice(0, 140)
        + ' · 无关框里=' + JSON.stringify(cState.taValue) + '（应 "" —— 一个字都不许写进去）' + (cOk ? ' ✓' : ' ✗'));
      /* 收尾：假现场整个拆掉（不许给后面的域留一张假页面 ✗） */
      await wcExec('(function () { var h = document.getElementById("__mm_mock_host");'
        + ' if (h && h.parentNode) h.parentNode.removeChild(h); return JSON.stringify({ ok: true }); })()');
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: rows.join(' ｜ ') };
    }
  },
  {
    name: 'N1 多选时虚影必须是**整组**（用户 2026-10-38 第二轮真机："多选的时候只显示其中之一的虚影，这不对，要显示全部被选中节点的"）：虚影页面里的卡片数 == 被拖节点数，且每张卡的文本逐个对得上；单选仍是 1 张（对照组）',
    run: async (ctx) => {
      /* 判据口径：数**虚影页面自己报的卡片数**（`__mmGhostRead().cards`），不读主进程的"我推了几张"
       * （那只能证明"我们推了"，不能证明"页面里真的有这几张"）。
       * 两侧：多选 2 个 ⇒ 2 张且文本逐个相等；单选 ⇒ 1 张（改前就是这个形状，不许被这条改坏）。 */
      if (!ctx.selDrag || !ctx.selDrag.pageText) return { ok: false, text: '没有 ctx.selDrag.pageText ⇒ N1 无从判 ✗' };
      if (!ctx.selDrag.inject) return { ok: false, text: '没有 ctx.selDrag.inject ⇒ 摆不出确定的虚影 ✗' };
      const rows = [];
      let ok = true;
      /** 起一次拖（真鼠标 ⇒ 走产品真实路径）→ 注入确定指针 → 读虚影页自报的卡片 */
      const probe = async (label, ids, wantN) => {
        const want = wantN;
        for (let attempt = 1; attempt <= 2; attempt++) {
        await settleInput(ctx);
        const hit = await selectAndHit(ctx, ids);
        if (!hit.ok) { ok = false; rows.push(label + '：⚠️ ' + hit.text); return; }
        await pressDrag(ctx, { x: hit.x, y: hit.y }, { x: hit.x + 60, y: hit.y + 40 }, 2);
        const st = await selDragStateOf(ctx);
        const r0 = ctx.selDrag.read();
        const wb = r0.winBox;
        const pt = wb ? { x: wb.x + 260, y: wb.y + 220 } : { x: 300, y: 300 };
        ctx.selDrag.inject(pt);
        const page = await ctx.selDrag.pageText();
        const ghost = ctx.selDrag.read().ghost;
        mouse(ctx, 'mouseUp', { x: hit.x + 60, y: hit.y + 40 });
        await sleep(180);
        const texts = (page && page.texts) || [];
        const n = texts.length;
        /* 期望文本 = 这些节点在页面里的 textContent（断言**独立**读，不调产品那份取样式函数） */
        const wantTexts = await execJson(ctx, '(function () { return JSON.stringify('
          + JSON.stringify(ids.slice(0, 8)) + '.map(function (id) {'
          + ' var el = document.querySelector("jmnode[nodeid=\\"" + id + "\\"]");'
          + ' return el ? String(el.textContent || "").trim() : "<没了>"; })); })()');
        const textOk = Array.isArray(wantTexts) && n === want && wantTexts.every((t, i) => String(texts[i]) === String(t));
        const cellOk = n === want && textOk && !!(page && page.visible === true) && !!(st && st.look);
        const premised = !!(st && st.look);
        if (premised) { if (!cellOk) ok = false; } else if (attempt >= 2) ok = false;
        rows.push(label + (attempt > 1 ? '（第' + attempt + '次）' : '') + '：被拖 ' + ids.length + ' 个 ⇒ 虚影页卡片数=' + n + '（应 ' + want + '）'
          + ' 文本=' + JSON.stringify(texts) + '（应 ' + JSON.stringify(wantTexts) + '）'
          + ' 逐字相等=' + textOk + ' · 虚影尺寸=' + JSON.stringify(ghost && ghost.size)
          + ' · 渲染层 look=' + JSON.stringify(st && st.look)
          + (premised ? (cellOk ? ' ✓' : ' ✗') : ' ✗〔前提未成立：这一拖没上报外观 ⇒ 重试〕'));
        if (premised) break;         // 前提成立 ⇒ 判据说话，不再重试
        }
      };
      const prep1 = await pickNodes(ctx, 1);
      if (!prep1.ok) return { ok: false, text: prep1.text };
      await probe('单选（对照）', [prep1.nodes[0].id], 1);
      await settleInput(ctx);
      const prep2 = await pickNodes(ctx, 2);
      if (!prep2.ok) { ok = false; rows.push('多选：' + prep2.text); }
      else await probe('多选（整组）', [prep2.nodes[0].id, prep2.nodes[1].id], 2);
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      return { ok: ok, text: rows.join(' ｜ ') };
    }
  },
  {
    name: 'N3-⑦ 幂等：**一次投喂 ⇒ 输入框里恰好 1 份**（受控编辑器 + 框里已有同一段 ⇒ 写一次必须只剩 1 份；份数 >1 必须判红，且回执要点名份数）',
    run: async (ctx) => {
      /* 判据口径（为什么必须用"受控编辑器"这个现场）：
       *   用户 2026-10-39 看到「同一段在输入框里出现了多次」。写侧的老写法是
       *   **insertText 在光标处插入** ⇒ 空框 1 份、已有内容就追加 ⇒ 天然不幂等。
       *   但"追加"在**普通 contenteditable** 上抓不到：那条 `el.textContent = text` 兜底会把
       *   追加**伪装成 1 份**（假绿 ✗）。真机上那一步是**无效**的（编辑器由模型驱动，
       *   DOM 赋值下一帧就被自己的渲染覆盖）⇒ 现场必须把这个事实建出来，否则这条断言是空转。
       * 两侧：
       *   · 该绿：现场里已有 SEED（= 同一段），跑一次产品那份注入串 ⇒
       *     回执 `ok:true` + `copies:1` + 现场 innerText **恰好等于** SEED（断言侧再独立数一遍份数）；
       *   · 该红：把"全选"那一步去掉（注入档）⇒ 变成追加 ⇒ 回执 `ok:false / bucket:'duplicated'
       *     / copies:2`，且现场确实是 2 份 —— 证明这条断言分得清"替换"与"追加"，不是恒真。 */
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      if (!wc) return { ok: false, text: '侧栏视图的 webContents 拿不到 ⇒ 幂等无从判 ✗' };
      const js = sidebar.COMPOSER_PREFILL_JS;
      if (typeof js !== 'string' || js.indexOf('function (text)') < 0) {
        return { ok: false, text: '产品没导出 COMPOSER_PREFILL_JS（或形态变了）⇒ 本条判不了，按红处理 ✗' };
      }
      /* 2026-10-40：SEED 去掉 `@`（那是 composer 的引用触发符，真机上会把前缀改写/重复）。
       * ⚠️ 本条只钉"替换 ⇒ 恰好 1 份 + 行数对"；**"去掉清空会变成 2 份"那一侧**在下一条 N3-⑨
       * 用变异体证明（那里 seed 带尾随换行，才数得出"追加了一份"）。 */
      const SEED = 'sb-幂等/甲\nsb-幂等/乙';
      const mkR = await composerMock(wc, 'controlled', SEED);
      if (!mkR || !mkR.ok) {
        if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
        return { ok: false, text: '造不出"受控编辑器 + 已有同一段"这个现场 ⇒ 前提不成立 ✗ ｜ ' + JSON.stringify(mkR) };
      }
      const before = await composerState(wc);
      const r = await composerPrefill(wc, js, SEED);
      const after = await composerState(wc);
      const copiesReceipt = Number(r && r.copies);
      const copiesBrake = countCopies(after.edText, SEED);       // ★ 判据侧**独立**数一遍
      const wantLinesR = SEED.split('\n').length;
      const linesBrake = String(after.edText || '').split('\n').length;   // ★ 行数也独立数一遍
      const ok = !!(r && r.ok === true && r.bucket === 'ok' && copiesReceipt === 1 && copiesBrake === 1
        && String(after.edText || '') === SEED && r.selMode !== 'none'
        && Number(r.lines) === wantLinesR && linesBrake === wantLinesR
        && String(r.cleared || '').indexOf('deleted') === 0);
      await composerTeardown(wc);
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: '受控编辑器（写前已有同一段 ' + JSON.stringify(before.edText) + '，赋值被吞 '
        + before.swallowed + '→' + after.swallowed + ' 次）⇒ 回执=' + JSON.stringify({ ok: r && r.ok, bucket: r && r.bucket, mode: r && r.mode, selMode: r && r.selMode, copies: r && r.copies, cleared: r && r.cleared })
        + ' · 写后内容=' + JSON.stringify(after.edText) + '（应恰好 == 原文）'
        + ' · 份数：回执=' + copiesReceipt + ' / 断言侧独立数=' + copiesBrake + '（都应 1）'
        + ' · 行数：回执=' + (r && r.lines) + ' / 断言侧独立数=' + linesBrake + '（都应 ' + wantLinesR + '）'
        + ' · 清空读数=' + JSON.stringify(r && r.cleared) + '（应 deleted:*）'
        + (ok ? ' ✓' : ' ✗') + (r && r.bucket === 'duplicated' ? '〔写成追加了 ⇒ 清空那一步没生效〕' : '') };
    }
  },
  {
    name: 'N3-⑧ 投喂形态（用户 2026-10-39：「不可以直接在对话栏里显示两个"节点链接"吗」）：2 个节点 ⇒ 输入框里就是**2 个引用单位**（每行一个 `@项目/标题`），且**不含**旧模板那句「这些是我这边的上下文」',
    run: async (ctx) => {
      /* 为什么两侧都要：
       *   ① 形态（绿）：文案只许是 N 行 `@项目/标题`（N == 节点数），多一行 = 又啰嗦了；
       *   ② 反向（红）：**输入框里不许出现旧模板句** —— 这条是给"以后有人把旧模板加回来"准备的；
       *   ③ 端到端：文案由**产品的纯函数**（`MMSidebarContext.buildSidebarText`）算，再交给**产品的
       *      注入串**写进现场 ⇒ 两侧接的是同一份实现，不是断言里手抄的期望串。
       * ⚠️ 它是**纯文本不是 chip**：DSH 的真 chip 只能由已注册的 `inputTriggers` source 经
       *    `slash/input-insert-reference` 插入（页面侧没有口子）⇒ 这条断言**不许**写成"是引用节点"。 */
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      if (!wc) return { ok: false, text: '侧栏视图的 webContents 拿不到 ⇒ 形态无从判 ✗' };
      const js = sidebar.COMPOSER_PREFILL_JS;
      if (typeof js !== 'string') return { ok: false, text: '产品没导出 COMPOSER_PREFILL_JS ⇒ 本条判不了 ✗' };
      const prep = await pickNodes(ctx, 2);
      if (!prep.ok) return { ok: false, text: prep.text };
      const nodes = prep.nodes.slice(0, 2);
      const project = await execJson(ctx, '(function () {'
        + ' var st = (window.MMApp && window.MMApp.getState) ? window.MMApp.getState() : null;'
        + ' return JSON.stringify({ ok: true, name: String((st && st.project && st.project.name) || "") }); })()');
      /* ★ 文案走**产品那一份**纯函数（不在这里手抄期望串） */
      const built = await execJson(ctx, '(function () {'
        + ' var nodes = ' + JSON.stringify(nodes.map((n) => ({ topic: n.topic }))) + ';'
        + ' var api = window.MMSidebarContext;'
        + ' if (!api || !api.buildSidebarText) return JSON.stringify({ ok: false, text: "页面上没有 MMSidebarContext" });'
        + ' return JSON.stringify({ ok: true, text: api.buildSidebarText(' + JSON.stringify(project.name || '') + ', nodes) }); })()');
      if (!built.ok) {
        if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
        return { ok: false, text: '文案算不出来 ⇒ 前提不成立 ✗ ｜ ' + JSON.stringify(built) };
      }
      const wantText = String(built.text || '');
      const lines = wantText.split('\n');
      /* 形状：行数 == 节点数，且**每行 == `<项目>/<标题>`**（独立按规格算，不抄产品实现）。
       * ⚠️ 2026-10-40：前缀**不再是 `@`** —— `@名字/` 正好命中 composer 的 FOLDER_REF_RE
       *   （`vendor/dsh` 只读源码 `…/ui-conversation/lib/client.js:12633`），真机上会被改写成
       *   引用实体 ⇒ 前缀重复 + 标题粘连 + 叠三份。这一格的期望值改的是**规格**，不是"迁就实现"。 */
      const wantLines = nodes.map((n) => (project.name ? (project.name + '/') : '')
        + String(n.topic || '').replace(/\s+/g, ' ').replace(/@/g, '').trim());
      const shapeOk = lines.length === nodes.length && lines.every((ln, i) => ln === wantLines[i]);
      /* 文案侧的护栏（本条的一半判别力在这）：一个 `@` 都不许有、行首不许是 `/` 或 `@` */
      const noAtInText = wantText.indexOf('@') < 0;
      const noTriggerLead = lines.every((ln) => !/^[@/]/.test(ln));
      const mkR2 = await composerMock(wc, 'target', '');
      if (!mkR2 || !mkR2.ok) {
        if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
        return { ok: false, text: '造不出目标框现场 ✗ ｜ ' + JSON.stringify(mkR2) };
      }
      const r = await composerPrefill(wc, js, wantText);
      const st = await composerState(wc);
      const inBox = String(st.edText || '');
      const boxLines = inBox.split('\n');
      const noTemplate = inBox.indexOf('这些是我这边的上下文') < 0
        && inBox.indexOf('【来自 AI MindMap') < 0 && inBox.indexOf('你按需回答即可') < 0;
      const boxOk = inBox === wantText && boxLines.length === nodes.length
        && boxLines.every((ln) => !/^[@/]/.test(ln) && ln.trim() !== '')
        && inBox.indexOf('@') < 0;
      /* ── 红侧（**护栏的判别力证明**）：把 `@` 加回去 ⇒ 产品必须**拒绝**（mangled + 一个字都不写）。
       * 为什么放在这里：用户 2026-10-40 的真机缺陷就是"`@` 被 composer 改写"，而文案侧修好之后
       * 下一个人完全可能又把它加回来（上一版就是这么写的）⇒ 这一格让"加回来"当场红。 */
      await composerMock(wc, 'target', '');
      const atBack = await composerPrefill(wc, js, '@' + wantText);
      const stAt = await composerState(wc);
      const atRefused = !!(atBack && atBack.ok === false && atBack.bucket === 'mangled'
        && String(stAt.edText || '') === '');
      const ok = !!(shapeOk && noAtInText && noTriggerLead && boxOk && noTemplate
        && r && r.ok === true && r.copies === 1 && Number(r.lines) === nodes.length
        && atRefused);
      await composerTeardown(wc);
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: '项目=' + JSON.stringify(project.name) + ' 节点=' + JSON.stringify(nodes.map((n) => n.topic))
        + ' ⇒ 文案=' + JSON.stringify(wantText) + '（应 ' + nodes.length + ' 行、**每行不含 @、不以 / 开头**）'
        + ' · 行数=' + lines.length + '/' + nodes.length + ' 形状对=' + shapeOk
        + ' · 文案无 @=' + noAtInText + '（应 true）· 行首无触发符=' + noTriggerLead + '（应 true）'
        + ' · 写进输入框后=' + JSON.stringify(inBox)
        + ' · 输入框行数=' + boxLines.length + '（应 ' + nodes.length + '）· 与文案逐字相等=' + (inBox === wantText)
        + ' · **不含旧模板句**=' + noTemplate + '（判的是「这些是我这边的上下文」等三句）'
        + ' · 红侧（把 @ 加回去）⇒ 回执=' + JSON.stringify({ ok: atBack && atBack.ok, bucket: atBack && atBack.bucket })
        + ' · 框里=' + JSON.stringify(String(stAt.edText || '')) + '（应 "" —— 一个字都不许写）· 拒绝对=' + atRefused
        + (ok ? ' ✓' : ' ✗') };
    }
  },
  {
    name: 'N3-⑨ 换行与幂等的**判别力**（把产品注入串做两个变异体：去掉清空 ⇒ 必须复现"叠一份"；去掉行间换行 ⇒ 必须复现"标题粘连"，且两样都判红）',
    run: async (ctx) => {
      /* 为什么要有这一条（本批最容易做假的地方）：
       *   上一批 `copies===1` 在**假 composer** 上是绿的，真机上却叠了三遍 ⇒ 绿必须能**证伪**。
       *   本条不新造一套写入逻辑，而是把**产品那一份注入串**做**源码级变异**再跑一遍：
       *     变异 A：`cleared = await clearDraft();` 换成常量（= **只去掉清空**，逐行写入原样保留）
       *             ＋ 光标放到框末（模拟"框里已有内容"）⇒ 这次写入必然变成**追加**
       *             ⇒ 判据必须给出 `ok:false / bucket:'duplicated' / copies===2`；
       *     变异 B：删掉行间 `paraBreak()`（= 换行没成分段）⇒ 两行粘成一行
       *             ⇒ 判据必须给出 `ok:false / bucket:'mangled' / lines===1`。
       *   两个变异体都先**验证变异真的落地了**（字符串没变 ⇒ 本格直接红，绝不静默）。
       * ⚠️ 边界（如实）：这仍是**假现场**（plain/受控 contenteditable），它能证明"判据不是恒真"，
       *   但**不能**证明"真 Lexical 会怎么吃 @ 与 \n" —— 那一条只能由用户真机拖一次
       *   （见 .review/20261040-@触发与换行/ 的报告：哪条验了、哪条没验）。 */
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
      const wc = sidebarWc();
      if (!wc) return { ok: false, text: '侧栏视图的 webContents 拿不到 ⇒ 判别力无从判 ✗' };
      const js = sidebar.COMPOSER_PREFILL_JS;
      if (typeof js !== 'string') return { ok: false, text: '产品没导出 COMPOSER_PREFILL_JS ⇒ 本条判不了 ✗' };
      /* 两行文案 + **末尾留一个空段**（= 真人回车分段后的 DOM 形状）：
       * 只在"光标处在一个段落的开头"时，追加才会产生"完整的一份又一份" ⇒ `copies` 数得出 2。
       * 用 `selectNodeContents+collapse(false)` 那种元素边界点，Chrome 会把插入落到别处
       * （实测写成 `甲\n乙甲\n\n乙`），`copies` 仍是 1 ⇒ 红侧就失去判别力 ✗。 */
      const L1 = 'sb-变异/甲';
      const L2 = 'sb-变异/乙';
      const NEEDLE = L1 + '\n' + L2;
      const seedParas = () => composerMockParas(wc, [L1, L2]);
      /* ── 变异 A：**只去掉清空**（其余一字不动 —— 最小变异，改得越少越能说明"就是这一步在起作用"） ──
       * ⚠️ 为什么不顺带改成"一次 insertText 灌整段"：那样一来红侧的成因就有两个（没有清空 **且**
       *   换行不成分段），判据分不清是谁在起作用；"一次灌整段"被禁这件事由
       *   `tests/composer-prefill-contract.test.js` 的负判据守着（那里是纯字符串，不需要现场）。 */
      const mutA = js.replace(/cleared = await clearDraft\(\);/, "cleared = 'mutant:no-clear';");
      const mutALanded = mutA !== js && mutA.indexOf('mutant:no-clear') >= 0
        && mutA.indexOf('wantLines[li]') >= 0;      // 逐行循环必须还在 ⇒ 只变异了"清空"这一步
      /* ── 变异 B：删掉行间换行 ── */
      const mutB = js.replace('{ paraBreak(); await frame(); }', '{ await frame(); }');
      const mutBLanded = mutB !== js && mutB.indexOf('paraBreak(); await frame();') < 0;
      const rows = [];
      let ok = true;
      if (!mutALanded || !mutBLanded) {
        await composerTeardown(wc);
        if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
        return { ok: false, text: '变异没落地（A=' + mutALanded + ' B=' + mutBLanded + '）⇒ 本条判不了，按红处理 ✗'
          + '（产品注入串的锚点变了就要同步改本条，不许让它静默变绿）' };
      }
      /* ── 绿侧：同一份"多段 + 末尾空段"现场，跑**未变异**的产品 ⇒ 必须 ok 且恰好 1 份 ── */
      const mk0 = await seedParas();
      if (!mk0 || !mk0.ok) {
        await composerTeardown(wc);
        if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
        return { ok: false, text: '造不出"多段 + 末尾空段"现场 ⇒ 前提不成立 ✗ ｜ ' + JSON.stringify(mk0) };
      }
      const r0 = await composerPrefill(wc, js, NEEDLE);
      const st0 = await composerState(wc);
      const copies0 = countCopies(String(st0.edText || '').replace(/\s+$/, ''), NEEDLE);
      const greenOk = !!(r0 && r0.ok === true && r0.bucket === 'ok' && copies0 === 1
        && String(st0.edText || '').replace(/\s+$/, '') === NEEDLE);
      if (!greenOk) ok = false;
      rows.push('绿侧·未变异 ⇒ 回执=' + JSON.stringify({ ok: r0 && r0.ok, bucket: r0 && r0.bucket, copies: r0 && r0.copies, lines: r0 && r0.lines })
        + ' · 框里=' + JSON.stringify(String(st0.edText || '')) + ' · 独立数份数=' + copies0 + '（应 1）' + (greenOk ? ' ✓' : ' ✗'));
      /* ── 红侧 A：去掉清空 ⇒ 必须复现"叠一份"（框里原有那份 + 又追加一份） ── */
      const mkA = await seedParas();
      if (!mkA || !mkA.ok) {
        ok = false;
        rows.push('红侧A：造不出现场 ✗ ｜ ' + JSON.stringify(mkA));
      } else {
        const rA = await composerPrefill(wc, mutA, NEEDLE);
        const stA = await composerState(wc);
        const copiesA = countCopies(String(stA.edText || '').replace(/\s+$/, ''), NEEDLE);
        const redAOk = !!(rA && rA.ok === false && rA.bucket === 'duplicated'
          && Number(rA.copies) === 2 && copiesA === 2);
        if (!redAOk) ok = false;
        rows.push('红侧A·去掉清空 ⇒ 回执=' + JSON.stringify({ ok: rA && rA.ok, bucket: rA && rA.bucket, copies: rA && rA.copies })
          + ' · 框里=' + JSON.stringify(String(stA.edText || '')) + ' · 独立数份数=' + copiesA
          + '（应 duplicated / 2 / 2）' + (redAOk ? ' ✓' : ' ✗'));
      }
      /* ── 红侧 B：去掉行间换行 ⇒ 必须复现"标题粘连" ── */
      await composerMock(wc, 'target', '');
      const rB = await composerPrefill(wc, mutB, NEEDLE);
      const stB = await composerState(wc);
      const linesB = String(stB.edText || '').split('\n').length;
      const redBOk = !!(rB && rB.ok === false && rB.bucket === 'mangled'
        && Number(rB.lines) === 1 && linesB === 1 && String(stB.edText || '').indexOf('\n') < 0);
      if (!redBOk) ok = false;
      rows.push('红侧B·去掉行间换行 ⇒ 回执=' + JSON.stringify({ ok: rB && rB.ok, bucket: rB && rB.bucket, lines: rB && rB.lines, reason: (rB && rB.reason || '').slice(0, 60) })
        + ' · 框里=' + JSON.stringify(String(stB.edText || '')) + ' · 独立数行数=' + linesB
        + '（应 mangled / 1 / 1，即两标题粘成一行）' + (redBOk ? ' ✓' : ' ✗'));
      await composerTeardown(wc);
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
      return { ok: ok, text: '变异落地：A=' + mutALanded + ' B=' + mutBLanded + ' ｜ ' + rows.join(' ｜ ') };
    }
  }
];
