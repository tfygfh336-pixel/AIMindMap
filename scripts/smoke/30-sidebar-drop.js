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
    name: 'G5-c 虚影文字四档（用户 2026-10-31 逐字规格）+「文字真变了才发」：页面自报 #t 逐字相等、pushes 不随拍增长',
    run: async (ctx) => {
      if (!ctx.selDrag || !ctx.selDrag.pageText) return { ok: false, text: '没有 ctx.selDrag.pageText ⇒ 文字没有可判的读者 ✗' };
      if (!sidebarWasVisible()) { try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ } g5ShowedSidebar = true; }
      await sleep(900);
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
        if (ok.length < 2) return JSON.stringify({ ok: false, text: '找不到两个可点的可见非根节点' });
        return JSON.stringify({ ok: true, a: ok[0], b: ok[1] });
      })()`);
      if (!prep.ok) return { ok: false, text: prep.text };
      let vr = null;
      try { vr = sidebar.viewBounds(); } catch (e) { vr = null; }
      const rows = [];
      let ok = true;
      /** 真鼠标按下+拖动（核实 armed）→ 注入确定指针 → 读**页面自报**的文字 → 用真 mouseUp 干净收尾。
       *  `ptScreen` = 要注入的**屏幕**坐标（不给就取窗口左侧一个确定点）。
       *  ⚠️ 带一次重试：注入式输入会把 mousedown/mousemove **迟到**投递（本批实测），一次没把
       *  "虚影显示中"这个前提摆好，读到的就是上一格残留的文字 ⇒ 那会变成假红。
       *  两次都摆不好 ⇒ 这一格判红（不静默）。 */
      const textOf = async (label, sel, ptScreen) => {
        let out = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          await settleInput(ctx);
          const hit = await selectAndHit(ctx, sel);
          if (!hit.ok) { out = { text: '<按不中:' + hit.text + '>', armed: false, visible: false, pushes: 0, stable: true }; await settleInput(ctx); continue; }
          const to = { x: hit.x + 40, y: hit.y + 40 };
          const pg = await pressDrag(ctx, { x: hit.x, y: hit.y }, to, 2);
          const r = ctx.selDrag.read();
          const wb = r.winBox;
          const pt = ptScreen || (wb ? { x: wb.x + 260, y: wb.y + 220 } : { x: 300, y: 300 });
          ctx.selDrag.inject(pt);
          const p1 = await ctx.selDrag.pageText();
          const pushes1 = ctx.selDrag.read().ghost.pushes;
          // "变了才发"：同一个点再推 3 拍 ⇒ 文字没变 ⇒ 推送次数不许再涨
          for (let i = 0; i < 3; i++) ctx.selDrag.inject(pt);
          const pushes2 = ctx.selDrag.read().ghost.pushes;
          const visible = !!(p1 && p1.visible === true);   // 隐藏的虚影看不出文字新旧 ⇒ 必须显示中才算数
          mouse(ctx, 'mouseUp', to);        // 真松手（两边都干净收尾，不给下一格留活动拖拽）
          await sleep(200);
          out = {
            text: p1 && p1.ok ? String(p1.text) : ('<读不到:' + JSON.stringify(p1) + '>'),
            pushes: pushes1, stable: pushes1 === pushes2, visible: visible,
            armed: !!(pg && pg.armed), subject: r.subject, pt: pt, attempt: attempt
          };
          if (out.stable && visible && out.armed) break;
        }
        if (!out || !out.visible || !out.armed || !out.stable) ok = false;   // 前提没摆好 / 推送次数在涨 ⇒ 红
        return out;
      };
      // ① 单一节点 ⇒ 「移动「标题」」
      const t1 = await textOf('single', [prep.a.id], null);
      const want1 = '移动「' + prep.a.topic + '」';
      if (t1.text !== want1) ok = false;
      rows.push('单一节点 ⇒ 页面文字=' + JSON.stringify(t1.text) + '（应 ' + JSON.stringify(want1) + '）' + (t1.text === want1 ? '✓' : '✗')
        + ' ｜ 虚影显示中=' + t1.visible + ' armed=' + t1.armed
        + ' ｜ subject=' + JSON.stringify(t1.subject && { k: t1.subject.kind, n: t1.subject.count })
        + ' 推送次数=' + t1.pushes + '（同点再推 3 拍不变=' + t1.stable + '）');
      // ② 多选：指针在导图页 ⇒ 「多选只能拖到 DSH」；指针在 DSH 上 ⇒ 「送给 DSH（N 个节点）」
      await settleInput(ctx);
      const t2 = await textOf('multi-map', [prep.a.id, prep.b.id], null);
      if (t2.text !== '多选只能拖到 DSH') ok = false;
      let wbForDsh = null;
      try { wbForDsh = ctx.win.getContentBounds(); } catch (e) { wbForDsh = null; }   // 客户区原点（注入点要屏幕坐标）
      const dshScreen = (vr && vr.width > 40 && wbForDsh)
        ? toScreen(wbForDsh, { x: Math.round(vr.x + vr.width / 2), y: Math.round(vr.y + Math.round(vr.height / 3)) })
        : null;
      await settleInput(ctx);
      const t3 = dshScreen ? await textOf('multi-dsh', [prep.a.id, prep.b.id], dshScreen) : { text: '<侧栏没开>' };
      const want3 = '送给 DSH（2 个节点）';
      if (t3.text !== want3) ok = false;
      rows.push('多选(导图页上) ⇒ ' + JSON.stringify(t2.text) + '（应 "多选只能拖到 DSH"）' + (t2.text === '多选只能拖到 DSH' ? '✓' : '✗')
        + ' ｜ 多选(指针在 DSH 上 ⇒ 注入屏幕点 ' + JSON.stringify(dshScreen) + ') ⇒ ' + JSON.stringify(t3.text)
        + '（应 ' + JSON.stringify(want3) + '）' + (t3.text === want3 ? '✓' : '✗') + ' 显示中=' + t3.visible);
      // ③ 大虚线框 ⇒ 「移动 N 个节点」（同一父的两个兄弟 ⇒ 框起来后框内那批 = 2 个）
      await ensureSiblingsExpanded(ctx);
      const sib = await pickSiblings(ctx, 2);
      if (!sib.ok) { ok = false; rows.push('大虚线框 ⇒ ' + sib.text); }
      else {
        const box = await pickOutlinePoint(ctx, sib.ids);
        if (!box.ok) { ok = false; rows.push('大虚线框 ⇒ ' + box.text); }
        else {
          const pg3 = await pressDrag(ctx, { x: box.x, y: box.y }, { x: box.x + 40, y: box.y + 40 }, 2);
          const r = ctx.selDrag.read();
          const wb = r.winBox;
          ctx.selDrag.inject(wb ? { x: wb.x + 260, y: wb.y + 220 } : { x: 300, y: 300 });
          const p3 = await ctx.selDrag.pageText();
          const got3 = p3 && p3.ok ? String(p3.text) : ('<读不到:' + JSON.stringify(p3) + '>');
          const want3b = '移动 2 个节点';
          // `armed` 只打印不进判据（瞬态标志，见 G5-b 那段说明）；这格的判据是：文字逐字相等 + 虚影显示中
          if (got3 !== want3b || !(p3 && p3.visible === true)) ok = false;
          rows.push('大虚线框 ⇒ 页面文字=' + JSON.stringify(got3) + '（应 ' + JSON.stringify(want3b) + '）' + (got3 === want3b ? '✓' : '✗')
            + ' ｜ subject=' + JSON.stringify(r.subject && { k: r.subject.kind, n: r.subject.count, toDsh: r.subject.toDsh })
            + ' 渲染层 armed=' + (pg3 && pg3.armed) + ' kind=' + (pg3 && pg3.kind));
          mouse(ctx, 'mouseUp', { x: box.x + 40, y: box.y + 40 });   // 真松手（两边都干净收尾）
          await sleep(250);
        }
      }
      if (g5ShowedSidebar) { try { sidebar.hide(); } catch (e) { /* ignore */ } g5ShowedSidebar = false; }
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
  }
];
