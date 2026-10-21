/* ============================================================
 * scripts/smoke/03-edit-search.js —— 冒烟断言分域 03：编辑入口与检索
 * （右键菜单→编辑对话框 / 双击节点编辑 / 标签 chip / 相关知识点 IPC /
 *   反查 IPC 兼容 / 全文搜索面板）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= R1 双击防误触：判据的实现（真输入 + 真读数 + 命中测试） =================
 * 现象（用户 2026-10-13 亲报）：双击节点展开/折叠**照样发生**，但**单击的两个副作用也照跑** ——
 *   ① 被记一次"访问"（热度）✗ ② 详情框被打开、遮挡视野 ✗。
 * 根因（读代码定位，不猜）：浏览器里"真双击"就是三条事件 `click(detail=1) → click(detail=2) → dblclick`，
 *   而导图容器那条 click 处理器**一拍都不等**就跑了 `showDetail`（它同时是"记访问"的**唯一采样点**，
 *   见 `renderer/app-detail.js` 的 `recordHumanOpen`）⇒ 双击必然先把单击副作用跑一遍。
 *
 * 这三条断言**全部走真输入**（`ctx.input.*` = `webContents.sendInputEvent`，进 Chromium 真实输入管线：
 * 命中测试、指针捕获、**真双击计数**都走浏览器自己的那一套）—— 不是手搓事件顺序 ✗。
 *
 * 判据纪律（写在这里，免得被后人改松）：
 *   · 访问条数**现算**（读沙箱里 `<项目根>/.visits/<项目>.jsonl` 的行数）⇒ 不写死数字 ✓；
 *   · "详情框没被打开"用 **`document.elementFromPoint` 命中测试**判（浏览器回答"这一点上是哪个元素"
 *     ⇒ 抓得住遮挡），**不用** `style.display` / 类名 / `getBoundingClientRect` 自证
 *     —— rect 在这里**只用来定位候选点**（V1 门禁点名的盲判据就是"rect 全对、画面里什么都没有"✗）；
 *     再加一条**真帧像素**旁证：框会出现的那块区域，动手前后非背景像素数必须逐字不变 ✓；
 *   · **正向对照**（防"功能整个死了"的假绿）：同一块区域内，**单击必须真的冒出一个框**
 *     （命中测试说 1 + 像素数变多）—— 两条一起才证明判别力在，而不是什么都没发生 ✓。 */

const fs = require('fs');
const path = require('path');
const frameStats = require('../vision/frame-stats.js');

/** 冒烟的项目（域 01 起就用它）与访问日志的**真位置**
 *  （`<项目根>/.visits/<项目名>.jsonl`，在项目目录**之外**；路径推导与产品同口径：
 *   `store.visitLogFile`。冒烟跑在沙箱副本上 ⇒ 读的就是沙箱那一份 ✓） */
const R1_PROJECT = 'comnet';
const r1VisitLog = () => path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', '.visits', R1_PROJECT + '.jsonl');
/** 访问日志条数（**现算**；读不到 = 0 —— 日志是只追加的，第一次写才出现 ✓ 不写死数字 ✗） */
function r1VisitLines() {
  try {
    return fs.readFileSync(r1VisitLog(), 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch (e) { return 0; }
}
/** 等访问条数变成 `want`（IPC 是异步的：真点击 → 判别窗口 → showDetail → `app:visit` → 追加一行）。
 *  等不到就把**当时的真读数**返回给调用方判红 —— 不在这里吞掉 ✗ */
async function r1WaitVisitLines(want, ms) {
  const end = Date.now() + (ms || 2500);
  let n = r1VisitLines();
  while (n !== want && Date.now() < end) {
    await sleep(100);
    n = r1VisitLines();
  }
  return n;
}

/** 渲染层：**真的被打开了**的浮动详情框（判据 = 命中测试，不是 DOM 自证 ✗）。
 *  · `getBoundingClientRect` **只用于定位候选点**（框中心）；
 *  · 结论由浏览器回答：`document.elementFromPoint(框中心)` 必须是框自己或它的后代
 *    ⇒ "被裁掉 / 被别的浮层盖住 / 根本没画出来"一律不算"被打开" ✓；
 *  · 面积 < 40×40 的框直接跳过（`display:none` 的框 rect 全 0 ⇒ 用几何**定位**时就必须排掉它）。 */
const R1_OPEN_BOXES_JS = `(function () {
  var out = [];
  var boxes = document.querySelectorAll('.float-detail');
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    var r = b.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (cx < 1 || cy < 1 || cx > window.innerWidth - 1 || cy > window.innerHeight - 1) continue;
    var at = document.elementFromPoint(cx, cy);
    if (!(at && b.contains(at))) continue;
    var t = b.querySelector('.fd-title');
    out.push({ title: t ? t.textContent : '', x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
})()`;

/** 关掉所有浮动详情框（产品自己的关闭口）+ 清选区 —— 每条断言自己收尾，别指望后面的域擦桌子 ✓ */
async function r1CloseBoxes(ctx) {
  await ctx.exec(`(function () {
    var MM = window.MM;
    if (window.MMApp && window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    if (MM.applySelection) MM.applySelection([], [], { hideBox: true });
    if (MM.clearSelection) MM.clearSelection();
    if (MM.paintRawSelection) MM.paintRawSelection();
    return 1;
  })()`);
  await ctx.input.settle({ delayMs: 220 });
}

/** 渲染层：把"第一个符合 kind 的节点"摆到面板里**点得中**的位置：
 *  · 水平居中于面板；
 *  · 竖直放在面板 **28% 高度**处（不是正中）—— 叶子那条判据要在节点**下方**留出
 *    "浮详情框会出现的那块"（`positionFloatDetail` 的契约 = 节点框下面 +8px）⇒ 放正中时
 *    框出现的位置会被面板下缘切掉，像素差分就判不了 ✗；
 *  · `kind='leaf'` 时先 **`expandAncestors`**（产品自己的入口，见 app-actions.js）把祖先链展开
 *    —— 收成两层之后叶子大多在屏幕外（实测：rect 全 0x0），不展开祖先链就一个叶子都点不到 ✗。
 *  `setViewTransform` 的语义是"屏幕坐标 = 逻辑坐标 × s + (x,y)" ⇒ 直接把 (x,y) 加上这个差值 ✓。 */
const r1CenterTargetJs = (kind) => `(function () {
  var wantKids = ${JSON.stringify(kind)} === 'with-kids';
  var jm = window.MMApp.getState().jm;
  if (!jm) return JSON.stringify({ ok: false, text: '没有打开的导图（jm 缺失）' });
  var root = jm.get_root ? jm.get_root() : jm.get_node('root');
  var target = null;
  (function walk(n) {
    if (!n || target) return;
    var k = (n.children || []).length;
    if (n.id && !n.isroot && (wantKids ? k > 0 : k === 0)) { target = n.id; return; }
    (n.children || []).forEach(walk);
  })(root);
  if (!target) return JSON.stringify({ ok: false, text: '树里找不到符合 kind 的' + (wantKids ? '有子节点' : '叶子') + '节点' });
  function elOf(id) { return document.querySelector('jmnode[nodeid="' + id + '"]'); }
  function shown(el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  var expandedAncestors = 0;
  if (!shown(elOf(target))) {
    // 叶子大多在屏幕外（实测：收成两层后它们的 rect 全 0x0）⇒ 用**产品自己的入口**展开祖先链。
    // ⚠️ 名字必须是 MM.expandAncestors（MMApp 上**没有**这个入口 —— 写错了它会**静默不展开** ✗，
    //    第一版就是这么踩的：叶子一直 0x0、断言以"找不到候选"的错形状红掉）。
    var ex = window.MM && window.MM.expandAncestors;
    if (typeof ex !== 'function') {
      return JSON.stringify({ ok: false, text: '目标节点 ' + target + ' 不可见，而渲染层拿不到 MM.expandAncestors'
        + '（采不到可见的真值 ⇒ 判红，不许静默跳过 ✗）' });
    }
    ex(jm, target);
    expandedAncestors = 1;
    if (!shown(elOf(target))) {
      return JSON.stringify({ ok: false, text: '展开祖先链之后 ' + target + ' 仍然不可见（rect 全 0）⇒ 判红 ✗' });
    }
  }
  var el = elOf(target);
  var r = el.getBoundingClientRect();
  var p = window.MM.fdPanel().getBoundingClientRect();
  var pan = window.MM.getPanState();
  var dx = Math.round((p.left + p.width / 2) - (r.left + r.width / 2));
  var dy = Math.round((p.top + p.height * 0.28) - (r.top + r.height / 2));
  window.MM.setViewTransform({ s: pan.s, x: pan.x + dx, y: pan.y + dy });
  return JSON.stringify({ ok: true, id: target, dx: dx, dy: dy, s: pan.s, expandedAncestors: expandedAncestors });
})()`;

/** 渲染层：挑一个**视口内、点得中**的节点（**不写死 id** —— id 属易腐事实）+ 给真输入坐标与几何。
 *  kind='with-kids' ⇒ 有子节点（判"展开态翻转"）；'leaf' ⇒ 叶子（判"详情框没被打开"：
 *  叶子双击不改布局 ⇒ 它下方那块的真帧差分是**可判的** ✓）。
 *  "点得中" = `document.elementFromPoint(候选点)` 真的落在它自己身上（抓遮挡/裁切 ✓）。 */
const r1PickNodeJs = (kind) => `(function () {
  var wantKids = ${JSON.stringify(kind)} === 'with-kids';
  var jm = window.MMApp.getState().jm;
  if (!jm) return JSON.stringify({ ok: false, text: '没有打开的导图（jm 缺失）' });
  var panel = window.MM.fdPanel ? window.MM.fdPanel() : null;
  if (!panel) return JSON.stringify({ ok: false, text: '没有导图面板（MM.fdPanel 缺失）' });
  var pr = panel.getBoundingClientRect();
  function hitPoint(el) {
    var r = el.getBoundingClientRect();
    var cands = [
      { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + Math.round(r.height / 2)) },
      { x: Math.round(r.left + 8), y: Math.round(r.top + Math.round(r.height / 2)) },
      { x: Math.round(r.right - 8), y: Math.round(r.top + Math.round(r.height / 2)) }
    ];
    for (var k = 0; k < cands.length; k++) {
      var p = cands[k];
      if (p.x < 2 || p.y < 2 || p.x > window.innerWidth - 2 || p.y > window.innerHeight - 2) continue;
      var at = document.elementFromPoint(p.x, p.y);
      if (at && at.closest && at.closest('jmnode[nodeid]') === el) return p;
    }
    return null;
  }
  var root = jm.get_root ? jm.get_root() : jm.get_node('root');
  var found = null, off = [];
  (function walk(n) {
    if (!n || found) return;
    var k = (n.children || []).length;
    if (n.id && !n.isroot && (wantKids ? k > 0 : k === 0)) {
      var el = document.querySelector('jmnode[nodeid="' + n.id + '"]');
      if (el) {
        var r = el.getBoundingClientRect();
        var inside = r.left > pr.left + 1 && r.top > pr.top + 1 && r.right < pr.right - 1 && r.bottom < pr.bottom - 1;
        // 叶子那条判据还要"节点下方留得下框会出现的那块"（面板里放不下 ⇒ 像素差分判不了 ✗）
        var room = !wantKids ? (pr.bottom - r.bottom) >= 260 : true;
        var pt = (inside && room && r.width > 20 && r.height > 12) ? hitPoint(el) : null;
        if (pt) {
          found = { id: n.id, topic: n.topic, kids: k, expanded: n.expanded !== false, pt: pt,
            rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
        } else if (off.length < 4) {
          off.push(n.id + ' inside=' + inside + ' room=' + room + ' ' + Math.round(r.left) + ',' + Math.round(r.top)
            + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
      }
    }
    (n.children || []).forEach(walk);
  })(root);
  return JSON.stringify({ ok: !!found,
    text: found ? '' : '没有"点得中"的候选节点（离屏样本：' + off.join(' | ') + '）',
    node: found, panel: { x: pr.left, y: pr.top, width: pr.width, height: pr.height },
    dpr: window.devicePixelRatio || 1, pan: window.MM.getPanState ? window.MM.getPanState() : null });
})()`;

async function r1ExecJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** 没有真输入底座 ⇒ **红**（不是"跳过"）：这三条判据全靠真输入，底座缺了就等于一条都没验过 ✗ */
const r1NoInput = () => ({ ok: false, text: '没有真输入底座（ctx.input 缺失：非 --smoke 路径 / createDriver 构造失败）'
  + '—— 真双击/真单击一条都没被验过，判红而不是跳过 ✗' });

/** 铺场（每条断言**自建前置**，不依赖别的断言留下的画面）：
 *  ① 关浮框、清选区；② 收成**紧凑的两层**（`collapse_all` + `expand_to_depth(2)`，域 36 的同款配方：
 *  不这么收，样本项目全展开时一屏只剩 1 个节点，"点得中"的候选根本不存在 ✗）；
 *  ③ 把目标节点摆到面板中心 + 复核命中。 */
async function r1Prep(ctx, kind) {
  const prep = await r1ExecJson(ctx, `(function () {
    var MM = window.MM, app = window.MMApp;
    var st = app.getState();
    if (!st || !st.jm) return JSON.stringify({ ok: false, text: '没有打开的项目（jm 缺失）' });
    if (app.closeAllFloatDetail) app.closeAllFloatDetail();
    if (MM.collapseAll) MM.collapseAll();
    if (st.jm.collapse_all) st.jm.collapse_all();
    if (st.jm.expand_to_depth) st.jm.expand_to_depth(2);
    if (MM.clearSelection) MM.clearSelection();
    if (MM.paintRawSelection) MM.paintRawSelection();
    return JSON.stringify({ ok: true, text: '铺场：收成两层 + 关浮框 + 清选区' });
  })()`);
  if (!prep.ok) return prep;
  await ctx.input.settle({ delayMs: 320 });          // jsMind 重排要留几百 ms（域 36 实测）
  const center = await r1ExecJson(ctx, r1CenterTargetJs(kind));
  if (!center.ok) return { ok: false, text: '居中目标节点失败：' + center.text };
  await ctx.input.settle({ delayMs: 320 });
  return { ok: true, text: prep.text + '；居中 ' + center.id + ' Δ(' + center.dx + ',' + center.dy + ') s=' + center.s };
}

async function r1PickHittable(ctx, kind) {
  for (let i = 0; i < 3; i++) {
    const r = await r1ExecJson(ctx, r1PickNodeJs(kind));
    if (r.ok) return r;
    if (i < 2) { await ctx.input.settle({ delayMs: 260 }); }
    else return { ok: false, text: '三次都没找到"点得中"的候选：' + (r.text || '') };
  }
  return { ok: false, text: '三次都没找到"点得中"的候选' };
}

/** 把鼠标**先**移到目标点上（只发一条 mouseMove）。
 *  为什么要单独拆出来：像素判据要"动手前 / 动手后"各截一帧 ⇒ hover 态必须在**动手前**就已经落定，
 *  否则"hover 引起的变化"会被算成"框冒出来了" ✗（假红的方向，但它会让人误判判据的实现）。 */
async function r1Hover(ctx, pt) {
  await ctx.input.sendList([{ type: 'mouseMove', x: pt.x, y: pt.y, modifiers: [] }], 0);
  await ctx.input.settle({ delayMs: 320 });
}

/** 一次**真双击**（不含 mouseMove —— 见 `r1Hover`）：两条 down/up，第二条带 `clickCount: 2`。
 *  为什么不能连点两次 `ctx.input.click()`：那两击都写死 `clickCount: 1`
 *  ⇒ 浏览器**不会**产生 `dblclick`（测的就成了"两次单击"，不是双击 ✗）。
 *  两次之间留 90ms（真人双击的典型量级 ✓）。 */
async function r1DoubleClick(ctx, pt) {
  await ctx.input.sendList([
    { type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers: [] },
    { type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers: [] },
    { type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 2, modifiers: [] },
    { type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 2, modifiers: [] }
  ], 90);
}

/* ================= `r9`：编辑框「开没开」的**唯一读法** + 上界窗口（判据，不是措辞） =================
 * 要治的形状（定题 §3.3 实测）：这条断言原来是**否定式 + 只读一拍** ——
 *   ① 上界读数（t0 与 t+400ms **都** false）证明"今天不是假通过"；
 *   ② 但把开框挪到 `setTimeout(…, 0)` 之后，产品原判据**仍判绿**而框真的开着 ⇒ **形状已复现**；
 *   ③ 根因是**代码结构**（`renderer/contextmenu.js` 的 `onDblClick` 根本没有开框路径，
 *      `renderer/editor.js` 的 `openEditDialog` 全同步）⇒ "真没弹"是结构顺便保证的，**不是断言证明的**。
 * ⇒ 判据必须自己证明三件事：**读是活的**（反向注入自检）、**读到确定的上界**（三拍）、
 *   **场景保真**（真双击，不是只发一个 `dblclick`）。
 *
 * ⚠️ 三处**共用同一个读表达式**（`R9_READ_EDIT_DIALOG`）：一处实现、三处使用。
 *   把任何一处改成恒 `false` 都会让另外两处同时哑掉 —— 这正是判别力证明（恒 false ⇒ A 与 B 同红）
 *   能成立的原因。**不许**在别处再手写一份 `style.display === 'flex'` 的判断。
 *
 * 上界为什么是 **300 ms**：**不新造数字** —— 本工程对"双击的单击副作用"用的就是这条判别窗口
 *   （`renderer/app-detail-content.js` 的 `DBL_WINDOW_MS = 300`，原文"两击间隔实测 ~90ms ⇒ 300ms 有 3 倍余量"）。
 *   三拍取 0 / 150 / 300，覆盖整个窗口；任何一拍读到 `flex` 都算红，并在报文里点名是哪一拍。 */
const R9_READ_EDIT_DIALOG = `(function () {
  var d = document.getElementById('edit-dialog');
  return { dlg: d ? d.style.display === 'flex' : null,
    at: (window.performance && performance.now) ? Math.round(performance.now()) : 0 };
})()`;
const R9_UPPER_MS = 300;
const R9_STEP_MS = 150;

/** 读一拍（读表达式**只有一份**，见上面注释）；读不到结构就返回 `{dlg:null, err}` ⇒ 调用方判红 */
async function r9ReadDialog(ctx) {
  const r = await ctx.exec(R9_READ_EDIT_DIALOG);
  const o = (r && typeof r === 'object') ? r : null;
  if (!o || !('dlg' in o)) return { dlg: null, at: 0, err: '读不到 #edit-dialog 的显示态：' + String(r).slice(0, 160) };
  return o;
}

/** 某节点当前的展开态（`true` / `false` / `null` = 节点没了） */
async function r9ExpandedOf(ctx, id) {
  return await ctx.exec(`(function () {
    var jm = window.MMApp.getState().jm;
    var n = jm ? jm.get_node(${JSON.stringify(id)}) : null;
    return n ? (n.expanded !== false) : null;
  })()`);
}

/** 点击事件探针：证明"真双击"真的产生了浏览器自己的 `click(1) → click(2) → dblclick`
 *  （否则我们可能只发了两次单击 ⇒ 判据看着红/绿都不算数 ✗）。捕获阶段，记类型+detail，
 *  并单独记**每个事件的命中目标**（`tag/nodeid`）—— 出红时报文能直接回答"双击到底打在了谁身上" ✓ */
const R1_PROBE_ON = `(function () {
  window.__r1Probe = [];
  window.__r1ProbeT = [];
  window.__r1ProbeH = function (e) {
    window.__r1Probe.push(e.type + ':' + e.detail);
    var t = e.target, tag = (t && t.tagName || '').toLowerCase();
    var nd = (t && t.closest) ? t.closest('jmnode[nodeid]') : null;
    window.__r1ProbeT.push(e.type + '→' + tag + (nd ? '/' + nd.getAttribute('nodeid') : ''));
  };
  ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
    document.addEventListener(t, window.__r1ProbeH, true);
  });
  return 1;
})()`;
const R1_PROBE_OFF = `(function () {
  if (window.__r1ProbeH) {
    ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
      document.removeEventListener(t, window.__r1ProbeH, true);
    });
  }
  window.__r1ProbeH = null;
  var seq = window.__r1Probe || [], tgt = window.__r1ProbeT || [];
  window.__r1Probe = []; window.__r1ProbeT = [];
  return JSON.stringify({ seq: seq, targets: tgt });
})()`;

/** 节点**下方那块**（浮详情框出现的位置；`positionFloatDetail` 的契约 = "节点框下面 +8px、水平居中"）
 *  ⇒ 框真冒出来时必然占到这里。**裁到面板里**：状态栏/消息栏那些无关重绘不许污染像素读数
 *  （本工程吃过"判据读到的是别层底色"的亏 ✗）。返回 CSS 像素矩形。 */
function r1RoiBelow(nodeRect, panel) {
  const cx = nodeRect.x + nodeRect.width / 2;
  let x = Math.max(panel.x + 2, cx - 180);
  let y = Math.max(panel.y + 2, nodeRect.y + nodeRect.height + 10);
  let right = Math.min(panel.x + panel.width - 2, cx + 180);
  let bottom = Math.min(panel.y + panel.height - 2, y + 240);
  if (bottom - y < 40 || right - x < 40) return null;   // 面板里放不下 ⇒ 判不了（调用方响亮报错 ✓）
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
}
/** 复核 / 重取"**此刻**真的点得中该节点"的坐标。
 *  为什么必须在双击**前**重取：节点上的浮层（详情框、悬浮工具条、圆钮）会在**第一次点击之后**冒出来，
 *  把原来那个点盖住 —— 实测（第一版真双击）：第二击 打在了 `button` 上、状态栏变成"详情框：已上大锁"
 *  ⇒ 展开态没翻转（判据红得有道理，但那红的是**判据自己的取点**而不是产品 ✗）。
 *  候选点**优先取节点上部**（工具条/圆钮都贴在节点下缘或框口一带），逐个过 `elementFromPoint` ✓。 */
async function r1HitPointNow(ctx, id) {
  return r1ExecJson(ctx, `(function () {
    var el = document.querySelector('jmnode[nodeid="' + ${JSON.stringify(id)} + '"]');
    if (!el) return JSON.stringify({ ok: false, text: '节点元素不见了：' + ${JSON.stringify(id)} });
    var r = el.getBoundingClientRect();
    var cx = Math.round(r.left + r.width / 2);
    var cy = Math.round(r.top + r.height / 2);
    var cands = [
      { x: cx, y: Math.round(r.top + 4) },
      { x: Math.round(r.left + 8), y: Math.round(r.top + 4) },
      { x: cx, y: cy },
      { x: Math.round(r.left + 8), y: cy },
      { x: Math.round(r.right - 8), y: cy },
      { x: cx, y: Math.round(r.bottom - 4) }
    ];
    var rej = [];
    for (var i = 0; i < cands.length; i++) {
      var p = cands[i];
      if (p.x < 2 || p.y < 2 || p.x > window.innerWidth - 2 || p.y > window.innerHeight - 2) continue;
      var at = document.elementFromPoint(p.x, p.y);
      var t = ((at && at.tagName) || '').toLowerCase();
      if (at && at.closest && at.closest('jmnode[nodeid]') === el) {
        return JSON.stringify({ ok: true, pt: p, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
      }
      rej.push('(' + p.x + ',' + p.y + ')→' + t);
    }
    return JSON.stringify({ ok: false,
      text: '节点 ' + ${JSON.stringify(id)} + ' 上一个"点得中"的坐标都没有了（被浮层盖住？）：' + rej.join(' ') });
  })()`);
}

/** 等到访问条数**连续两次读数相同**（IPC 异步：写完了才稳定、之后不再变）—— 不预设条数 ✓。
 *  为什么不能"等它变成 base+N"：那等于把 N **写死**（N 正是要测的东西 ✗）。
 *  ⚠️ **先等过一个下限（默认 900ms）再判稳定**：单击副作用现在要等过产品的判别窗口（300ms）
 *  才会写盘 —— 少了这个下限，"连续两次相同"会在窗口还没过时成立，读到的永远是"没记上" ✗
 *  （第一版就是这么假的红了一次：基线=读数，判据看起来像"产品没记访问"）。 */
async function r1VisitSettled(ms, floorMs) {
  await sleep(Number.isFinite(floorMs) ? floorMs : 900);
  const end = Date.now() + (ms || 2400);
  let last = r1VisitLines(), stable = 0;
  while (Date.now() < end) {
    await sleep(150);
    const n = r1VisitLines();
    if (n === last) { stable++; if (stable >= 2) return n; } else { stable = 0; last = n; }
  }
  return last;
}

/** 测试侧计数（**不改产品**）：这段窗口里 `MM.showDetail` 与 `desktop.app.visit` 各被调了几次。
 *  为什么判据要连着它：只看日志条数，分不清"根本没人调 showDetail"与"调了但没写盘"；
 *  把**调用次数**一并报出来，红的时候一眼看出是哪一层变了 ✓（"不许把单击改坏"要的正是这个）。
 *  ⚠️ 只包 `MM.showDetail`（各模块都是调用时取属性，如 `MM.showDetail(node)`）；
 *    产品内部**直接调自己那个函数**的路径（如 `showDetailItem`）不在此列 —— 如实标注 ✓。 */
const R1_COUNT_ON = `(function () {
  window.__r1Count = { showDetail: [], visit: [], record: [] };
  var MM = window.MM;
  if (MM && MM.showDetail && !window.__r1OrigShow) {
    window.__r1OrigShow = MM.showDetail;
    MM.showDetail = function (n) {
      window.__r1Count.showDetail.push((n && n.id) || '');
      return window.__r1OrigShow.apply(this, arguments);
    };
  }
  // 「记访问」那条链的渲染层入口（app-heat-bars.js 的 recordHumanOpen）：调几次 ⇒ 就该有几条日志
  if (MM && MM.heatBarsRecordHumanOpen && !window.__r1OrigRec) {
    window.__r1OrigRec = MM.heatBarsRecordHumanOpen;
    MM.heatBarsRecordHumanOpen = function (n) {
      window.__r1Count.record.push((n && n.id) || '');
      return window.__r1OrigRec.apply(this, arguments);
    };
  }
  var api = window.desktop && window.desktop.app;
  if (api && api.visit && !window.__r1OrigVisit) {
    window.__r1OrigVisit = api.visit;
    api.visit = function (p, id, ch) {
      window.__r1Count.visit.push(id + '/' + ch);
      return window.__r1OrigVisit.apply(this, arguments);
    };
  }
  return 1;
})()`;
const R1_COUNT_OFF = `(function () {
  var MM = window.MM;
  if (window.__r1OrigShow) { MM.showDetail = window.__r1OrigShow; window.__r1OrigShow = null; }
  if (window.__r1OrigRec) { MM.heatBarsRecordHumanOpen = window.__r1OrigRec; window.__r1OrigRec = null; }
  var api = window.desktop && window.desktop.app;
  if (api && window.__r1OrigVisit) { api.visit = window.__r1OrigVisit; window.__r1OrigVisit = null; }
  var c = window.__r1Count || { showDetail: [], visit: [], record: [] };
  window.__r1Count = null;
  return JSON.stringify(c);
})()`;
const r1Counts = (raw) => {
  try { return JSON.parse(String(raw)); } catch (e) { return { showDetail: [], visit: [], record: [] }; }
};
/** 访问日志最后 n 行的**原文**（红的时候要能看出"多出来的是哪几条" —— 只报条数会让人猜 ✗） */
function r1VisitTail(n) {
  try {
    const all = fs.readFileSync(r1VisitLog(), 'utf8').split('\n').filter((l) => l.trim());
    return all.slice(-(n || 3));
  } catch (e) { return []; }
}

/** CSS 像素矩形 → 设备像素（截图是设备像素；与 `scripts/vision/roi-assertions.js` 同口径 ✓） */
const r1ToDev = (rect, dpr) => ({ x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
  width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) });

/** 数这块区域里的**非背景像素**（"有东西画在这里"的真帧读数 ✓） */
const r1Scan = (img, dev) => frameStats.scanRegion(img, dev, {});

const assertions = [
  {
    name: 'context menu (node right-click → edit dialog)',
    run: async (ctx) => {
      // 右键节点 → 菜单出现 → 点「编辑」→ 编辑对话框打开；右键背景 → 背景菜单
      const chk = await ctx.exec(
        `(function () {
          try {
            var nodeEl = document.querySelector('jmnode[nodeid="tcp-handshake"]');
            if (!nodeEl) return { ok: false, text: 'no jmnode el' };
            var ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 });
            nodeEl.dispatchEvent(ev);
            var menu = document.getElementById('ctx-menu');
            var nodeMenuShown = menu && menu.style.display !== 'none';
            var items = menu ? menu.querySelectorAll('.ctx-item').length : 0;
            var hasEdit = menu && Array.from(menu.querySelectorAll('.ctx-item')).some(function (x) { return x.textContent.indexOf('编辑') >= 0; });
            var editItem = menu && Array.from(menu.querySelectorAll('.ctx-item')).find(function (x) { return x.textContent.indexOf('编辑') >= 0; });
            if (editItem) editItem.click();
            var dlgOpen = document.getElementById('edit-dialog').style.display === 'flex';
            document.getElementById('edit-cancel').click();
            // 背景右键
            var bgEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 });
            document.getElementById('mindmap-container').dispatchEvent(bgEv);
            var bgMenuShown = menu.style.display !== 'none';
            // v0.16：背景菜单移除导入/导出 MD（只保留文件菜单入口）
            var bgHasMd = Array.from(menu.querySelectorAll('.ctx-item')).some(function (x) { return x.textContent.indexOf('导入') >= 0 || x.textContent.indexOf('导出') >= 0; });
            menu.style.display = 'none';
            return {
              ok: nodeMenuShown && items >= 4 && hasEdit && dlgOpen && bgMenuShown && !bgHasMd,
              text: 'nodeMenu=' + nodeMenuShown + ' items=' + items + ' editDialog=' + dlgOpen + ' bgMenu=' + bgMenuShown
            };
          } catch (e) { return { ok: false, text: 'err:' + e.message }; }
        })()`
      );
      return chk;
    }
  },
  {
    name: '双击节点 = **展开 / 收起**（用户定 ✓ 不再弹编辑框 ✗）；编辑在右键菜单里（判定依据：`#edit-dialog` 显示态四拍 t_sync / t+0 / t+150 / t+300 **都**必须 false + **反向注入自检**先证明同一读法能读到 true + `ctx.input` 真双击再复核三拍；上界 300ms 取自 `renderer/app-detail-content.js` 的 `DBL_WINDOW_MS`，不新造数字）',
    run: async (ctx) => {
      const mm = require('../smoke-assertions.js');
      /* ---------- ⓪ 自建前置：挑一个**真的有子节点**的可见节点（✓ 不写死 id）---------- */
      const pick = await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        if (!jm) return { ok: false, text: '没有打开的导图（jm 缺失）' };
        var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
        for (var i = 0; i < all.length; i++) {
          var cand = all[i].getAttribute('nodeid');
          var nn = jm.get_node(cand);
          if (nn && !nn.isroot && nn.children && nn.children.length) {
            return { ok: true, id: cand, expanded: nn.expanded !== false };
          }
        }
        return { ok: false, text: '找不到有子节点的可见节点（采不到候选 ⇒ 判红，不许静默跳过 ✗）' };
      })()`);
      if (!pick || pick.ok !== true) {
        return { ok: false, text: '挑候选失败：' + ((pick && pick.text) || '没有读数') };
      }
      const id = pick.id;
      const editApi = await ctx.exec('(function () { return typeof window.MMApp.editNode === "function"; })()');

      /* ---------- ① B：反向注入自检 —— **先证明"读"是活的** ----------
       * 用产品自己的入口 `MM.editNode`（`renderer/app-actions.js` 的 `MM.editNode = editNode`）开一次框，
       * 再用**同一个读表达式**读：读不到 `flex` ⇒ 这条断言对"开没开"是**盲的** ⇒ **判红**。
       * ⚠️ 不许静默跳过、也不许报成"未验证"（同工程既有口径：采不到真值 ⇒ 判红）。 */
      const opened = await ctx.exec(`(function () {
        var ok = false, err = '';
        try { ok = !!window.MM.editNode(${JSON.stringify(id)}); } catch (e) { err = (e && e.message) || String(e); }
        return { opened: ok, err: err };
      })()`);
      const readOpened = await r9ReadDialog(ctx);
      await ctx.exec(`(function () { var c = document.getElementById('edit-cancel'); if (c) c.click(); return 1; })()`);
      const readClosed = await r9ReadDialog(ctx);
      /* B 的判据（**不早退**：早退会让"A 与 B 同时红"这条判别力证明看不出来）。
       * 三项都成立才算"读是活的"：产品入口真的开了框 + 同一读法读到 flex + 关掉后读到 false。 */
      const bOk = !!(opened && opened.opened === true)
        && readOpened.dlg === true
        && readClosed.dlg === false;
      const bText = 'editNode 开了=' + (opened && opened.opened)
        + ' ⇒ 同一读法读到 flex=' + readOpened.dlg + '；点取消后读到 ' + JSON.stringify(readClosed.dlg)
        + (bOk ? '' : ' ⇒ **读是死的**（这条断言对"开没开"是盲的 ⇒ 判红，不静默跳过 ✗）');

      /* ---------- ② A：上界读数（t_sync / t+0 / t+150 / t+300 **都**必须 false）----------
       * `dlgSync` = 旧判据那个"同一拍同步读一眼"的位置（保留它，免得把原有的判别力丢掉）。
       * 为什么要跨拍：由 `setTimeout(…, 0)` / Promise / IPC 往返 / 动画帧开出来的框，在**同一拍**
       * 读到的是"还没弹" ⇒ 旧判据恒绿（定题 §3.3 的 ④ 已实测复现这个形状）。 */
      const fire = await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        var n = jm.get_node(${JSON.stringify(id)});
        if (!n) return { ok: false, text: '目标节点没了' };
        var before = n.expanded !== false;
        var el = document.querySelector(${JSON.stringify('jmnode[nodeid="' + id + '"]')});
        if (!el) return { ok: false, text: 'no jmnode el' };
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 }));
        var d = document.getElementById('edit-dialog');
        return { ok: true, before: before, after: (jm.get_node(${JSON.stringify(id)}).expanded !== false),
          dlgSync: d ? d.style.display === 'flex' : null };
      })()`);
      if (!fire || fire.ok !== true) return { ok: false, text: '发 dblclick 失败：' + ((fire && fire.text) || '没有读数') };
      const a0 = await r9ReadDialog(ctx);
      await sleep(R9_STEP_MS);
      const a1 = await r9ReadDialog(ctx);
      await sleep(R9_STEP_MS);
      const a2 = await r9ReadDialog(ctx);
      const upperClean = fire.dlgSync === false && a0.dlg === false && a1.dlg === false && a2.dlg === false;
      const upperText = 'sync=' + fire.dlgSync + '/t+0=' + a0.dlg + '/t+150=' + a1.dlg + '/t+300=' + a2.dlg;
      /* A **以 B 为前提**：读没被证明是活的，A 的三拍读数就说明不了任何事 ⇒ A 也判红。
       * 这不是"读不到就跳过"，而是"证明不了就不许报绿"（判别力证明要的正是"A 与 B 同时红"）。 */
      const aOk = bOk === true && upperClean === true && fire.after !== fire.before;
      // 还原展开态：不给后续断言留一个被改动过的状态 ✓
      await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        var n = jm.get_node(${JSON.stringify(id)});
        var before = ${JSON.stringify(fire.before)};
        if (n && (n.expanded !== false) !== before) { if (before) jm.expand_node(${JSON.stringify(id)}); else jm.collapse_node(${JSON.stringify(id)}); }
        return 1;
      })()`);

      /* ---------- ③ C：真双击（`ctx.input`；click(1) → click(2) → dblclick 三拍）----------
       * 为什么还要这一条：只发一个 `dblclick` 事件对"**第一击**就开框"这种回归是**结构上盲**的
       * （真双击是三条事件，见本文件头）。前置照 `:120-131` 记的那个坑：目标必须先在面板里**点得中**，
       * 否则会以"rect 全 0 / 找不到候选"的错形状红掉（那是判据坏了，不是它通过）。 */
      if (!ctx.input) {
        return { ok: false, text: r1NoInput().text + '（C 那一半一条都没被验过 ⇒ 判红）' };
      }
      const prep = await r1Prep(ctx, 'with-kids');
      if (!prep.ok) return { ok: false, text: 'C 前置铺场失败：' + prep.text };
      const picked = await r1PickHittable(ctx, 'with-kids');
      if (!picked.ok) return { ok: false, text: 'C 挑"点得中"的候选失败：' + (picked.text || '') };
      const cid = picked.node.id;
      await r1Hover(ctx, picked.node.pt);
      const cBefore = await r9ExpandedOf(ctx, cid);
      await r1DoubleClick(ctx, picked.node.pt);
      const c0 = await r9ReadDialog(ctx);
      await sleep(R9_STEP_MS);
      const c1 = await r9ReadDialog(ctx);
      await sleep(R9_STEP_MS);
      const c2 = await r9ReadDialog(ctx);
      const cAfter = await r9ExpandedOf(ctx, cid);
      const cUpperClean = c0.dlg === false && c1.dlg === false && c2.dlg === false;
      const cUpperText = 't+0=' + c0.dlg + '/t+150=' + c1.dlg + '/t+300=' + c2.dlg;
      /* C 同样**以 B 为前提**（同一个读法；读死了它的"没弹"也一样说明不了任何事） */
      const cOk = bOk === true && cUpperClean === true && cAfter !== cBefore;
      if (cAfter !== cBefore) {
        await ctx.exec(`(function () {
          var jm = window.MMApp.getState().jm;
          var id = ${JSON.stringify(cid)};
          if (${JSON.stringify(cBefore)}) jm.expand_node(id); else jm.collapse_node(id);
          return 1;
        })()`);
      }
      await mm.closeDialogs(ctx);

      return {
        ok: bOk === true && aOk === true && cOk === true && editApi === true,
        text: '节点=' + id
          + ' ｜ ⓑ 读活自检（' + (bOk ? '成立' : '**不成立**') + '）：' + bText
          + ' ｜ ⓐ 上界四拍 ' + upperText + '（都必须 false ✓ ⇒ ' + (upperClean ? '成立' : '**不成立**') + '）'
          + '，展开态 ' + fire.before + ' → ' + fire.after
          + '（A 合计=' + (aOk ? '绿' : '**红**') + '，它以 B 为前提）'
          + ' ｜ ⓒ 真双击：节点=' + cid + ' 三拍 ' + cUpperText
          + '（都必须 false ✓ ⇒ ' + (cUpperClean ? '成立' : '**不成立**') + '）'
          + '，展开态 ' + cBefore + ' → ' + cAfter
          + '（C 合计=' + (cOk ? '绿' : '**红**') + '）'
          + ' ｜ 编辑入口仍在=' + editApi
          + '（上界窗口 ' + R9_UPPER_MS + 'ms = `app-detail-content.js` 的 `DBL_WINDOW_MS`，不新造数字）'
      };
    }
  },
  {
    name: 'tags chips in float detail',
    run: async (ctx) => {
      // 节点 data.tags → 浮动详情出现可点击标签 chip（测完还原，不留痕）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          var n = jm.get_node('tcp-handshake');
          if (!n) return 'no node';
          n.data = n.data || {};
          var had = n.data.tags;
          n.data.tags = ['测试标签'];
          app.showDetail(n);
          var chips = document.querySelectorAll('.float-detail .fd-tags .tag-chip');
          var has = chips.length >= 1 && chips[0].textContent.indexOf('测试标签') >= 0;
          if (had === undefined) delete n.data.tags; else n.data.tags = had;
          return 'chips=' + chips.length + ' has=' + has;
        })()`
      );
      return { ok: /has=true/.test(chk), text: chk };
    }
  },
  {
    name: 'related panel renders via IPC (out + in merged)',
    run: async (ctx) => {
      // 选中节点 → 浮动详情异步经 IPC 取「相关知识点」（出边+入边合并）→ 列表出现（非加载中）
      // 注意：只触发一次 showDetail，之后只读轮询，否则每次重置"加载中"永远读不到结果
      await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          var n = jm.get_node('tcp-handshake');
          if (n) app.showDetail(n);
          return 1;
        })()`
      );
      let ok = false, text = '';
      for (let i = 0; i < 40; i++) {
        const chk = await ctx.exec(
          `(function () {
            var el = document.querySelector('.float-detail .fd-related');
            if (!el) return 'no el';
            var items = el.querySelectorAll('.bl-item[data-node]');
            return JSON.stringify({
              n: items.length,
              dir: el.querySelectorAll('.bl-dir').length,
              html: el.innerHTML.slice(0, 120)
            });
          })()`
        );
        text = chk;
        try {
          const o = JSON.parse(chk);
          if (o.n > 0 && o.dir === o.n) { ok = true; break; }
        } catch (e) { /* 仍可能是 'no el' 字符串 */ }
        if (chk.indexOf('查询失败') >= 0) break;
        await sleep(200);
      }
      return { ok, text: text.slice(0, 200) };
    }
  },
  {
    // 这是能抓到「🔗 跳转到」那类缺陷的**关键断言**：光断言"列表渲染出来了"不够，
    // 必须断言**点下去真的跳到位**。原先图片区的链接正是"渲染正常、点了没反应"
    // （同项目链接被 switchProject 的早退吞掉），而没有任何断言覆盖点击效果。
    name: '相关知识点：点击**同项目**条目真的选中该节点并打开详情',
    run: async (ctx) => {
      // 先拿到一个同项目的关系条目（含其目标 id），再点击并验证选中变化
      const pick = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           app.showDetail(jm.get_node('tcp-handshake'));
           return 1;
         })()`
      );
      void pick;
      let target = null;
      for (let i = 0; i < 40; i++) {
        const chk = await ctx.exec(
          `(function () {
             var el = document.querySelector('.float-detail .fd-related');
             if (!el) return 'no el';
             var it = el.querySelector('.bl-item[data-node]');
             if (!it) return 'no item';
             return JSON.stringify({ node: it.getAttribute('data-node'), project: it.getAttribute('data-project') });
           })()`
        );
        try { target = JSON.parse(chk); break; } catch (e) { /* 继续轮询 */ }
        await sleep(200);
      }
      if (!target) return { ok: false, text: '未能取到关系条目' };
      // 清掉当前选中，确保"跳转生效"不是因为本来就选着它
      const r = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           var it = document.querySelector('.float-detail .fd-related .bl-item[data-node="' + ${JSON.stringify(target.node)} + '"]');
           if (!it) return JSON.stringify({ ok: false, text: '条目消失' });
           it.click();
           var sel = jm.get_selected_node();
           // 注意：详情框**支持多框并存**，故不能用 querySelector('.float-detail')
           // 取第一个（那可能是隐藏的旧框，我第一版就因此误判失败）。
           // 正确做法是遍历所有框，问"是否存在一个**可见**且 nodeId==目标的框"。
           var st = app.getFloatDetailState();
           var n = st.boxes || 0;
           var shown = false, detail = [];
           for (var i = 0; i < n; i++) {
             var b = app.getFloatDetailState(i);
             detail.push(i + ':' + b.nodeId + (b.visible ? '(可见)' : '(隐藏)'));
             if (b.nodeId === ${JSON.stringify(target.node)} && b.visible) shown = true;
           }
           return JSON.stringify({
             ok: !!sel && sel.id === ${JSON.stringify(target.node)} && shown,
             text: '目标=' + ${JSON.stringify(target.node)} + ' 选中=' + (sel && sel.id)
                 + ' 有可见详情框=' + shown + ' 框=[' + detail.join(' ') + ']'
           });
         })()`
      );
      let ok = false, detail = r;
      try { const o = JSON.parse(r); ok = o.ok; detail = o.text; } catch (e) { detail = r; }
      return { ok, text: detail };
    }
  },
  {
    name: 'backlinks IPC still works (compat: 单向反查未被相关知识点取代)',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          return window.desktop.app.backlinks('comnet', 'tcp-handshake').then(function (r) {
            return JSON.stringify({
              hasWithin: !!(r && Array.isArray(r.within)),
              hasCross: !!(r && Array.isArray(r.cross))
            });
          });
        })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.hasWithin && o.hasCross; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'full-text search panel (detail hit)',
    run: async (ctx) => {
      // 搜索框全文搜索：detail 中"三次握手"应命中 tcp-handshake 并弹出结果面板
      const chk = await ctx.exec(
        `(function () {
          return window.MMApp.runSearch('三次握手').then(function () {
            var el = document.getElementById('search-results');
            var shown = el && el.style.display === 'block';
            var html = el ? el.innerHTML : '';
            return JSON.stringify({ shown: shown, hasHit: html.indexOf('tcp-handshake') >= 0 });
          });
        })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.shown && o.hasHit; } catch (e) { detail = chk; }
      await ctx.exec(`(function(){ var el = document.getElementById('search-results'); if (el) el.style.display = 'none'; return 1; })()`);
      return { ok, text: detail };
    }
  },
  {
    /* ── R1 判据①②（用户原话：双击展开/折叠照旧，但**不该**再被记一次访问）──
     * 判据三条：① 展开态**翻转** ✓ ② 访问日志条数**不变** ✓ ③（正向对照）同一节点单击时必须**恰好 +1**
     * —— ③ 是为了防"这条链整个死了"的假绿：不先证明"点节点真的会记访问"，②的"没变"就不算判据 ✗。 */
    name: 'R1 双击①（真输入 click×2）⇒ 展开态**翻转** 且 访问日志条数**不变**（同节点单击作正向对照：访问必须增长 ✓）',
    run: async (ctx) => {
      if (!ctx.input) return r1NoInput();
      const prep = await r1Prep(ctx, 'with-kids');
      if (!prep.ok) return { ok: false, text: prep.text };
      const pick = await r1PickHittable(ctx, 'with-kids');
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id;
      const stateJs = `(function () { var jm = window.MMApp.getState().jm; var n = jm.get_node(${JSON.stringify(id)});`
        + ' return JSON.stringify({ expanded: n ? n.expanded !== false : null }); })()';

      /* ① 正向对照：同一节点**单击**一次 ⇒ 访问条数**确实增长**（先证明这条链是活的 ✓） */
      const base = r1VisitLines();
      const clickPt = await r1HitPointNow(ctx, id);
      if (!clickPt.ok) return { ok: false, text: '单击前取不到点得中的坐标：' + clickPt.text };
      await ctx.exec(R1_COUNT_ON);
      await ctx.input.click(clickPt.pt);
      const afterSingle = await r1VisitSettled(2500);
      const singleCounts = r1Counts(await ctx.exec(R1_COUNT_OFF));
      const controlOk = afterSingle > base;
      await r1CloseBoxes(ctx);

      /* ② 真双击（同一节点）：展开态必须翻转，而**单击的两个副作用一个都不许跑**：
       *   `showDetail` 调用次数必须是 **0**（访问记录与详情框都挂在它里面 ⇒ 一次调用就够判两条），
       *   访问日志条数也必须**一字不变** ✓（沙箱里现算，不写死数字 ✓）。 */
      const before = await r1ExecJson(ctx, stateJs);
      await ctx.exec(R1_PROBE_ON);                       // 事件探针：证明真双击真的产生了 dblclick
      await ctx.exec(R1_COUNT_ON);
      const fresh = await r1HitPointNow(ctx, id);        // 双击前**重取**坐标（浮层会盖住旧点 ✗）
      if (!fresh.ok) return { ok: false, text: '双击前取不到点得中的坐标：' + fresh.text };
      await r1Hover(ctx, fresh.pt);
      await r1DoubleClick(ctx, fresh.pt);
      await ctx.input.settle({ delayMs: 150 });
      const afterT1 = await r1ExecJson(ctx, stateJs);     // 双击刚落下（判别窗口还没过）的读数
      await ctx.input.settle({ delayMs: 550 });
      const probeStr = await ctx.exec(R1_PROBE_OFF);
      const dblCounts = r1Counts(await ctx.exec(R1_COUNT_OFF));
      const after = await r1ExecJson(ctx, stateJs);
      const afterDouble = await r1VisitSettled(1200);
      const statusText = await ctx.exec(`(function () {
        var el = document.querySelector('#status-text');
        return el ? String(el.textContent) : '';
      })()`);

      const flipped = !!(before && after && before.expanded !== null && after.expanded !== null
        && before.expanded !== after.expanded);
      const visitOk = afterDouble === afterSingle;
      const noSideOk = dblCounts.showDetail.length === 0 && dblCounts.record.length === 0;
      // ↑ 双击期间"打开详情框"（showDetail）与"记访问"（recordHumanOpen）**各 0 次** ✓
      let probe = null;
      try { probe = JSON.parse(String(probeStr)); } catch (e) { /* 探针读不回来 ⇒ probeOk 判红 ✓ */ }
      const seq = (probe && probe.seq) || [];
      const tgts = (probe && probe.targets) || [];
      const probeOk = seq.indexOf('dblclick:2') >= 0
        && seq.filter((s) => s === 'click:1' || s === 'click:2').length >= 2;

      // 还原展开态（不给后面的断言/域留一棵被改动过的树 ✓）
      await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm, id = ${JSON.stringify(id)}, n = jm.get_node(id);
        if (!n) return 1;
        var want = ${JSON.stringify(!!(before && before.expanded))};
        if (want && !n.expanded) jm.expand_node(id);
        if (!want && n.expanded) jm.collapse_node(id);
        return 1;
      })()`);
      await r1CloseBoxes(ctx);

      return { ok: flipped && visitOk && controlOk && probeOk && noSideOk,
        text: '节点=' + id + '（子节点 ' + pick.node.kids + ' 个）｜展开态 ' + (before && before.expanded)
          + ' →（双击后 150ms）' + (afterT1 && afterT1.expanded) + ' →（700ms）' + (after && after.expanded)
          + '（必须翻转 ✓）｜访问条数：单击后 ' + afterSingle + '（基线 ' + base + '，须增长 ✓）→ 双击后 '
          + afterDouble + '（必须不变 ✓）'
          + '｜双击期间 showDetail 调用=' + JSON.stringify(dblCounts.showDetail) + '（必须 0 次 ✓）'
          + '／recordHumanOpen 调用=' + JSON.stringify(dblCounts.record) + '（必须 0 次 ✓）'
          + '（单击那次是 showDetail=' + JSON.stringify(singleCounts.showDetail) + ' record='
          + JSON.stringify(singleCounts.record) + '）'
          + '｜真事件 ' + JSON.stringify(seq) + ' 打在 ' + JSON.stringify(tgts)
          + '（取点 ' + JSON.stringify(fresh.pt) + '）'
          + '｜状态栏=' + JSON.stringify(String(statusText).slice(0, 40))
          + '｜' + prep.text };
    }
  },
  {
    /* ── R1 判据③（用户原话：双击还会打开节点详情、遮挡视野 ✗）—— ⚠️ **2026-10-16（R5-3）口径反转** ──
     * 打**叶子**上：叶子双击不改布局 ⇒ 它下方那块（浮详情框出现的位置）的**真帧差分**才是可判的
     * （打在会展开的节点上时，子树增删会把整块画面改掉 ⇒ 像素判据分不清"框冒出来了"与"树展开了"✗）。
     * ⚠️ **为什么反转**：R5-3 明确定下「**无父子关系的节点**双击 ⇒ **打开详情框**」（有意语义，
     *   见设计稿 §R5-3 的语义表与 `renderer/contextmenu.js` 的 onDblClick）。本断言写于"双击叶子
     *   什么都不做"的年代，守的是**旧事实** —— 事实变了、替旧事实站岗的判据必须**同批反转** ✗
     *   （skill B4 成因④）。反转**没有放宽** R1：**恰恰判得更严** ——
     *   修前实测 `showDetail` 调 **2** 次、访问日志 **+2**（单击那一对副作用各跑了一遍）；
     *   现在必须是**恰好 1 次 / 恰好 +1**（只来自 `dblclick` 那一拍）⇒ **2 次就是 R1 回归**，照红 ✓。
     *   （父节点那一档仍必须是 **0 次 / +0**，见本文件上面的 R1 双击① —— 那条一个字没动 ✓。）
     * 五条判据 + 一条正向对照：
     *   · 框**恰好 1 个**，且它是**这个叶子自己的**节点详情框（`elementFromPoint` 命中它自己）；
     *   · 双击期间 `showDetail` 恰好 1 次、`recordHumanOpen`（记访问）恰好 1 次，且点名是这个节点；
     *   · 访问日志条数恰好 **+1**（沙箱里现算，不写死数字）；
     *   · 那块 ROI 的真帧像素**确实变了**（框不透明、盖住下面 ⇒ 像素变了；"没变"才是缺陷）；
     *   · 对照：同一块 ROI 上**单击必须真的冒出框**（命中测试说 1 + 像素变了）⇒ 上面几条不是空转 ✓。 */
    name: 'R1 双击②（真输入 click×2 打在叶子上）⇒ 只开**一个**框（就是这个叶子自己的详情框，来自 dblclick 那一拍）：showDetail / 记访问各**恰好 1 次**、访问日志的增量与"对照单击"逐字相等（都 = 一次打开的代价）、ROI 像素确实变了 —— 修前的形态是"showDetail 2 次"，那就是 R1 回归；R5-3 起"双击叶子 = 开详情"是有意语义',
    run: async (ctx) => {
      if (!ctx.input) return r1NoInput();
      const prep = await r1Prep(ctx, 'leaf');
      if (!prep.ok) return { ok: false, text: prep.text };
      const pick = await r1PickHittable(ctx, 'leaf');
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id;
      const topic = String(pick.node.topic || '');
      const roiOf = (rect) => r1RoiBelow(rect, pick.panel);
      let roi = roiOf(pick.node.rect);
      if (!roi) {
        return { ok: false, text: '面板里放不下"框会出现的那块"ROI（节点 '
          + JSON.stringify(pick.node.rect) + ' 面板 ' + JSON.stringify(pick.panel) + '）'
          + '—— 判不了就判红，不许静默放过 ✗' };
      }
      await r1CloseBoxes(ctx);
      const fresh = await r1HitPointNow(ctx, id);       // 双击前**重取**坐标（浮层会盖住旧点 ✗）
      if (!fresh.ok) return { ok: false, text: '双击前取不到点得中的坐标：' + fresh.text };
      if (fresh.rect) { const roi2 = roiOf(fresh.rect); if (roi2) roi = roi2; }
      const dev = r1ToDev(roi, pick.dpr);
      await r1Hover(ctx, fresh.pt);                     // hover 态先落定（免得被算成"框冒出来"）
      const scan0 = r1Scan(await ctx.input.capture(), dev);
      if (!scan0 || scan0.ok !== true) {
        return { ok: false, text: '动手前的真帧读数采不到（scanRegion 失败）：' + JSON.stringify(scan0) + '—— 采不到真值 = 红 ✗' };
      }

      const visitBefore = r1VisitLines();               // 双击前的访问条数（+1 那条判据的基线）
      await ctx.exec(R1_PROBE_ON);
      await ctx.exec(R1_COUNT_ON);                      // 数 showDetail / recordHumanOpen（只包测试侧，不改产品）
      await r1DoubleClick(ctx, fresh.pt);
      await ctx.input.settle({ delayMs: 700 });
      const probeStr = await ctx.exec(R1_PROBE_OFF);
      const dblCounts = r1Counts(await ctx.exec(R1_COUNT_OFF));
      const openAfterDbl = await ctx.exec(R1_OPEN_BOXES_JS);
      const scanDbl = r1Scan(await ctx.input.capture(), dev);
      const afterDouble = await r1VisitSettled(2500);

      /* 正向对照：同一块 ROI 上单击 ⇒ 必须真的冒出一个框（否则上面几条可能是"这块永远不动"的假绿 ✗）。
       * ⚠️ 方向**不许写死"像素变多"**：框是不透明面板，它**盖住**下面那棵树时非背景像素反而会**变少**
       *   （实测：动手前 23443 → 框打开后 1569）⇒ 判据写"变多"会把**功能正常**判红 ✗。
       *   所以对照只要求"这块画面**确实变了**（≠）" + 命中测试说"确实有 1 个框" ✓。
       * ⚠️ 这一跳**顺带当"一次打开的成本"的标尺**：访问日志的增量里除 `human-detail` 还带一条
       *   `ai-related-hop`（打开详情时那次 AI 读相关知识点）⇒ 一次打开 = **2 行**（实测，别写死）。
       *   双击的增量必须与这次单击的增量**逐字相等** ⇒ 等价于"双击只付了一次打开的代价" ✓。 */
      const beforeClick = r1VisitLines();
      await ctx.input.click(fresh.pt);
      let openAfterClick = [], scanClick = scanDbl, controlOk = false;
      for (let i = 0; i < 4; i++) {
        await ctx.input.settle({ delayMs: 420 });
        openAfterClick = await ctx.exec(R1_OPEN_BOXES_JS);
        scanClick = r1Scan(await ctx.input.capture(), dev);
        if (Array.isArray(openAfterClick) && openAfterClick.length === 1
            && scanClick && scanClick.ok === true && scanClick.hits !== scan0.hits) { controlOk = true; break; }
      }
      const clickTitle = (Array.isArray(openAfterClick) && openAfterClick[0]) ? String(openAfterClick[0].title) : '';
      const afterClick = await r1VisitSettled(2500);
      await r1CloseBoxes(ctx);

      const dblTitle = (Array.isArray(openAfterDbl) && openAfterDbl[0]) ? String(openAfterDbl[0].title) : '';
      const boxOk = Array.isArray(openAfterDbl) && openAfterDbl.length === 1
        && topic && dblTitle.indexOf(topic) >= 0;                 // 恰好一个框，且是这个叶子自己的
      const countOk = dblCounts.showDetail.length === 1 && dblCounts.showDetail[0] === id
        && dblCounts.record.length === 1 && dblCounts.record[0] === id;   // 恰好一次（2 次 = R1 回归）
      const deltaDbl = afterDouble - visitBefore;                 // 双击的访问增量
      const deltaClick = afterClick - beforeClick;                // 单击（= 一次打开）的访问增量
      const visitOk = deltaDbl === deltaClick && deltaDbl > 0;    // 两者逐字相等 ⇒ 只付了一次代价
      const pixelOk = !!(scanDbl && scanDbl.ok === true && scanDbl.hits !== scan0.hits);
      const probeOk = /"dblclick:2"/.test(String(probeStr));
      return { ok: boxOk && countOk && visitOk && pixelOk && controlOk && probeOk,
        text: '叶子=' + pick.node.id + '（' + topic + '）ROI=' + JSON.stringify(roi) + '（CSS px，已裁到面板内）'
          + '｜双击后打开的框=' + JSON.stringify(openAfterDbl) + '（必须恰好 1 个且是这个叶子自己的 ✓）'
          + '｜双击期间 showDetail=' + JSON.stringify(dblCounts.showDetail) + '（必须恰好 1 次且是这个 id ✓）'
          + '／recordHumanOpen=' + JSON.stringify(dblCounts.record) + '（同上 ✓）'
          + '／visit 调用=' + JSON.stringify(dblCounts.visit)
          + '｜访问条数：双击前 ' + visitBefore + ' → ' + afterDouble + '（增量 ' + deltaDbl + '）'
          + '；对照单击 ' + beforeClick + ' → ' + afterClick + '（增量 ' + deltaClick + '）'
          + '（两个增量**必须逐字相等**且 > 0 ✓）'
          + '｜ROI 非背景像素：动手前=' + scan0.hits + ' → 双击后=' + (scanDbl && scanDbl.hits) + '（必须**变了** ✓）'
          + '｜真事件探针含 dblclick:2=' + probeOk
          + '｜正向对照：单击后打开的框=' + JSON.stringify(openAfterClick) + '（标题=' + clickTitle + '）'
          + ' ROI 像素=' + (scanClick && scanClick.hits) + '（必须 1 个框且这块画面确实变了 ✓）｜' + prep.text };
    }
  },
  {
    /* ── R1 判据④（**不许**为了防误触把单击改坏 ✗）：单击的既有语义 = 选中 + 记访问 + 开详情框 ── */
    name: 'R1 单击（真输入 click×1）⇒ 与从前一致：选中 + 访问日志**照旧增长** + 详情框真的打开（同一套命中测试命中框内）',
    run: async (ctx) => {
      if (!ctx.input) return r1NoInput();
      const prep = await r1Prep(ctx, 'with-kids');
      if (!prep.ok) return { ok: false, text: prep.text };
      const pick = await r1PickHittable(ctx, 'with-kids');
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id;
      const topic = String(pick.node.topic || '');
      const stateJs = `(function () { var jm = window.MMApp.getState().jm; var sel = jm.get_selected_node ? jm.get_selected_node() : null;`
        + ` var n = jm.get_node(${JSON.stringify(id)});`
        + ' return JSON.stringify({ sel: sel ? sel.id : null, expanded: n ? n.expanded !== false : null }); })()';

      const base = r1VisitLines();
      const before = await r1ExecJson(ctx, stateJs);
      const clickPt = await r1HitPointNow(ctx, id);           // 点前复核命中（浮层可能盖住旧点 ✗）
      if (!clickPt.ok) return { ok: false, text: '单击前取不到点得中的坐标：' + clickPt.text };
      await ctx.exec(R1_PROBE_ON);
      await ctx.exec(R1_COUNT_ON);
      await ctx.input.click(clickPt.pt);
      const afterCount = await r1VisitSettled(2500);
      const counts = r1Counts(await ctx.exec(R1_COUNT_OFF));
      const probeStr = await ctx.exec(R1_PROBE_OFF);
      let open = [], after = before;
      for (let i = 0; i < 4; i++) {
        await ctx.input.settle({ delayMs: 420 });
        open = await ctx.exec(R1_OPEN_BOXES_JS);
        after = await r1ExecJson(ctx, stateJs);
        if (Array.isArray(open) && open.length >= 1 && after && after.sel === id) break;
      }
      const title = (Array.isArray(open) && open[0]) ? String(open[0].title) : '';
      /* 判据按**实测的现状语义**写，不按"应该"写 ✓：
       *  · 单击**必须**记访问（条数增长，> 0 —— 准确条数如实报出，见 CHANGELOG 的"未做/未核实"）；
       *  · "打开详情框"这个动作按产品的唯一入口口径 = `showDetail` **恰好被调 1 次** ✓。 */
      const delta = afterCount - base;
      const visitOk = delta > 0;
      const callOk = counts.showDetail.length === 1;
      const selOk = !!(after && after.sel === id);
      const boxOk = Array.isArray(open) && open.length === 1;
      const titleOk = boxOk && topic && title.indexOf(topic) >= 0;      // 这个框确实是**这个节点**的
      const keepOk = !!(before && after && before.expanded === after.expanded);   // 单击不许顺手改展开态
      let probe = null;
      try { probe = JSON.parse(String(probeStr)); } catch (e) { /* 判红 ✓ */ }
      const pseq = (probe && probe.seq) || [];
      await r1CloseBoxes(ctx);
      return { ok: visitOk && callOk && selOk && boxOk && titleOk && keepOk,
        text: '节点=' + id + '（' + topic + '）｜选中=' + (after && after.sel) + '（必须=' + id + ' ✓）'
          + '｜访问条数 ' + base + ' → ' + afterCount + '（Δ=' + delta + '，必须 > 0 ✓；'
          + 'recordHumanOpen 调用=' + JSON.stringify(counts.record) + '）'
          + '｜日志尾 ' + JSON.stringify(r1VisitTail(2))
          + '｜"打开详情框"调用=' + JSON.stringify(counts.showDetail) + '（必须恰好 1 次 ✓）'
          + '｜"真的被打开的框"=' + JSON.stringify(open) + '（必须恰好 1 个、标题含本节点 ✓：' + title + '）'
          + '｜真事件 ' + JSON.stringify(pseq)
          + '｜展开态 ' + (before && before.expanded) + ' → ' + (after && after.expanded) + '（单击不许动 ✓）｜'
          + prep.text };
    }
  }
];

module.exports = assertions;
