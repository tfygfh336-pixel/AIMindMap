/* ============================================================
 * scripts/smoke/45-子树偏移与方向.js —— 【R2 期 1】节点/子树级手工定位 + 方向入口
 * ------------------------------------------------------------
 * 用户原话（R2 需求）：想拖**某一段子树**摆到别处，而不是"整棵顶层主题树一起走"；
 * 方向（左/右分侧）至今只能改数据文件才能设。
 * 本域钉的是**界面那一半 + 数据那一半**（`renderer/app-view.js` 的偏移键域 +
 * `renderer/app-core.js` 的两个条件写回键 + `renderer/contextmenu.js` 的**分侧入口**（拖动那四条
 * 已于 2026-10-33 批4 摘除，只剩「摆到左/右侧」这一族菜单项）+ `src/schema.js` 的 `meta.nodeOffsets` 契约）。
 *
 *  甲 **默认档逐字节不变**（本期的头号判据）：一个**没有任何偏移**的项目，
 *     `serializeTree()` 里**一个偏移键都没有**；`save()` 把**恰好这份**序列化文本写到盘上
 *     （盘上 == 界面这一份，没有第三方多写一个键）。
 *  乙 **入口 + 拖动**：右键**深层节点** ⇒ 菜单里**四条拖动入口一条都没有**（2026-10-33 批4 已按用户
 *     「移除拖动模式」摘掉入口；`setDragMode` 那套 API 一行没删 ⇒ 进模式直接从 API 走）、
 *     **没有**左右分侧项（jsMind 只认 root 直接子节点，给深层节点设方向是骗人 ⇒ 不显示）；真鼠标拖它 ⇒
 *     **只有该子树移动**（其余节点屏幕矩形**逐项相同**）、**父子关系逐字节不变**、
 *     偏移只进 `meta.nodeOffsets`（`meta.themeOffsets` 一个键都不写）、**拖动期间盘上零写入**、
 *     `isDirty()` 由 false（打开后）到 true（拖动后）；移动后的子树每个节点在**新位置**上
 *     `elementFromPoint` 命中自己；`save()` ⇒ 盘上偏移 == 屏幕位移；**重开项目**后
 *     两桶读数、DOM transform、屏幕矩形**全部还原**。
 *  丙 **方向入口**（顶层主题级语义，**不新增方向能力**）：右键顶层主题 ⇒ **四个拖动入口全不在**
 *     （拖动树 / 拖动此子树 / 拖动到同级第几位 / 挂到别的父节点下，逐个点名）而两条分侧项**仍在**；
 *     点「摆到左侧」⇒ 该支屏幕 cx < 根 cx 且
 *     盘上 `meta.layout.left` 现算包含它；点「摆到右侧」⇒ 反向成立、盘上换边；
 *     给**非顶层**节点调这个入口 ⇒ 响亮拒绝（`ok:false` + 原因，不静默）。
 *  丁 **结构断言**（设计稿 §2.3 要求）：除 `renderer/vendor/**` 外，`renderer/**.js`
 *     **剥注释后**不得出现 jsMind 的 `.move_node(` / `.insert_node_before(` /
 *     `.insert_node_after(`（它们是第二条重排语义、绕过 CLI 闸门）；
 *     判别力：同一组 needle 在 vendor 里**确实存在**（证 needle 不是空转），且扫描面文件数有下限。
 *  戊 收尾：偏移清回自动布局并落盘、进来时开着的项目开回去、确认桩复位（不给后面的域留状态）。
 *
 * 判据纪律（与 36/37/42/43 同）：可见性一律 `document.elementFromPoint`（rect 只用来定位/判几何）；
 * 动作一律**真鼠标**（`ctx.input.*` 走 Chromium 命中测试，不是 `dispatchEvent` 合成事件）；
 * 真值读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 由 main.js 在 --smoke 下指向临时副本
 * ⇒ 读到的就是本次跑动的真实盘上形态，真实 `projects/` 零写入）。
 * ⚠️ 夹具是**本域自己写进沙箱**的一个 `zz-` 项目（不碰 comnet）；写盘用 node 的 `writeFileSync`
 *    （无 BOM），内容与 CLI `init`/`add` 同形状 —— 这一段不测 CLI，测的是界面与数据契约。
 * ⚠️ 切项目的守卫（`confirmDiscardIfDirty`）在无头跑里没人回答模态 ⇒ 本域显式装一个**打桩答案**
 *    （`MMApp.setConfirmStub`，与 43 域同一招），收尾复位成 `window.confirm` 本体。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 剥注释的唯一实现（复用 S1 门禁那一份，不另写一套）：结构断言的输入必须是**代码**，不是散文
const { stripComments } = require('../../scripts/dep-direction-check.js');

/** 沙箱夹具项目：顶层主题 t1/t2；t1 下 na（含 na1/na2）、nb；t2 下 nc */
const P = 'zz-r2-offsets';
/** 本域的拖动目标：**深层节点**（不是顶层主题）—— 期 1 新扩的那一档 */
const TARGET = 'na';
const TARGET_SUB = ['na', 'na1', 'na2'];      // 目标子树的全部节点（现算对照用）
const TOP_THEME = 't1';

/** 进来时界面开着哪个项目（收尾要交还回去） */
let PROJECT_WHEN_ENTERED = '';
/** 收尾复位用的"打过桩"标记（别把打桩口留着跨域影响后面的域） */
let STUB_INSTALLED = false;

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到盘上真值');
  return d;
}
const projectFile = (name) => path.join(projectsDir(), name, name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 等渲染稳定（≥2 帧）——只用在**真鼠标之后**（输入事件经主进程排队，得给它落地的时间）。
 *  ⚠️ 纯 DOM 改动（`expand_node` / `setDragMode`）**不等**：jsMind 的布局是同步写进
 *  `style.left/top` 的，紧接着量矩形就是最终值 —— 每个 rAF 在本机要几百毫秒（真帧渲染），
 *  白等会把 G5 拉长（本域是本批唯一新增的时间来源，预算余量要留着）。 */
const SETTLE = 'new Promise(function (r) { requestAnimationFrame(function () { r(1); }); })';
const PAINT = { delayMs: 120 };

/** 让应用打开某个沙箱项目。
 *  ⚠️ 打开之后**必须等一拍再量**：`renderMind` 末尾有一个 `setTimeout(centerOnRoot, 80)`
 *  （覆盖 jsMind 的异步布局）—— 不等的话那次居中会落在"量之前/量之后"之间，
 *  整个画布被平移一个量级几十像素的位移 ⇒ 判据"其余节点矩形逐项相同"**假红**
 *  （全量跑里实测踩到：其余节点齐刷刷 dy=+33）。 */
async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await ctx.input.settle({ delayMs: 160 });
  return ok;
}

/** 装/卸确认框的桩（无头跑里模态没人回答 ⇒ 必须打桩；收尾复位成本体） */
async function stubConfirm(ctx, answer) {
  await ctx.exec('window.MMApp.setConfirmStub(' + (answer === null ? 'null' : 'function () { return ' + (answer ? 'true' : 'false') + '; }') + ')');
  STUB_INSTALLED = answer !== null;
}

/** 渲染层读数：全部可见节点的屏幕矩形 + 面板几何 + 平移缩放（rect **只用来定位/判几何**，
 *  可见性判据单独用 `elementFromPoint`）。 */
const RADAR = `(function () {
  var app = window.MMApp;
  var out = {};
  document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;          // 折叠着（display:none）⇒ 不是本次的对照面
    out[el.getAttribute('nodeid')] = {
      l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2)
    };
  });
  var p = window.MM.fdPanel();
  var b = p.getBoundingClientRect();
  return {
    rects: out,
    view: app.getPanState(),
    panel: { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }
  };
})()`;

/** 两条读数逐节点对比：`unchanged` = 矩形逐项相同；`moved` = 变了（带四个分量差）；`gone` = 前有后无 */
function cmpRects(before, after) {
  const unchanged = [], moved = [], gone = [];
  Object.keys(before).forEach((id) => {
    const a = before[id], b = after[id];
    if (!b) { gone.push(id); return; }
    const dx = b.l - a.l, dy = b.t - a.t, dw = b.w - a.w, dh = b.h - a.h;
    if (dx === 0 && dy === 0 && dw === 0 && dh === 0) unchanged.push(id);
    else moved.push({ id, dx, dy, dw, dh });
  });
  return { unchanged, moved, gone };
}

/** 选一个**落点**：目标子树整体平移 (dx,dy) 之后，
 *  ① 不与任何**其他**可见节点相交、② 完整落在面板可视区内
 *  （四边各自内缩：上 30 / 下 70（底部消息栏那一带）/ 左 20 / 右 60（右侧 24px 内松手是"丢给侧栏"，
 *   不能误触））、③ 松手点离面板边也留出余量。
 *  候选 = **八个方向 × 四档幅度**（幅度按面板尺寸现算 ⇒ 换窗口尺寸照样能找到地方），顺序固定 ⇒ 读数确定。
 *  一个都不行 ⇒ 返回 `{why}`（判红并如实说"没找到落点"，不静默跳过）。
 *  ⚠️ 这条"落点现算"不是为了让断言好过：**位移本身**（只有目标子树移动/逐字节不变/持久化）
 *  与落点无关，只有"移动后还看得见"这条需要一块空地 —— 空地是界面的客观条件，找不着就要说。 */
function pickDelta(radar, subIds) {
  const panel = radar.panel;
  const padL = 20, padT = 30, padB = 70, padR = 60;
  const W = panel.right - panel.left, H = panel.bottom - panel.top;
  const inSub = (id) => subIds.indexOf(id) >= 0;
  const bbox = (ids) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    ids.forEach((id) => {
      const q = radar.rects[id];
      if (!q) return;
      l = Math.min(l, q.l); t = Math.min(t, q.t);
      r = Math.max(r, q.l + q.w); b = Math.max(b, q.t + q.h);
    });
    return { l: l, t: t, r: r, b: b };
  };
  const mine = bbox(subIds);
  const from = radar.rects[TARGET];
  if (!from) return { why: '目标节点本身不在屏上' };
  if (!isFinite(mine.l) || !isFinite(mine.t)) return { why: '目标子树没有可量的矩形' };
  const others = Object.keys(radar.rects).filter((id) => !inSub(id))
    .map((id) => { const q = radar.rects[id]; return { l: q.l, t: q.t, r: q.l + q.w, b: q.t + q.h }; });
  const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]];
  const FRACS = [0.35, 0.26, 0.18, 0.12];
  const reasons = [];
  for (const f of FRACS) {
    for (const d of DIRS) {
      const dx = Math.round(d[0] * W * f), dy = Math.round(d[1] * H * f);
      if (dx === 0 && dy === 0) continue;
      const m = { l: mine.l + dx, t: mine.t + dy, r: mine.r + dx, b: mine.b + dy };
      if (m.l < panel.left + padL || m.t < panel.top + padT
        || m.r > panel.right - padR || m.b > panel.bottom - padB) { reasons.push('越界'); continue; }
      if (others.some((o) => !(m.r <= o.l || m.l >= o.r || m.b <= o.t || m.t >= o.b))) { reasons.push('压到别的节点'); continue; }
      if (from.cx + dx > panel.right - 60 || from.cx + dx < panel.left + 20) { reasons.push('松手点越界'); continue; }
      if (from.cy + dy > panel.bottom - padB || from.cy + dy < panel.top + padT) { reasons.push('松手点越界'); continue; }
      return { dx: dx, dy: dy, from: { x: from.cx, y: from.cy } };
    }
  }
  return { why: '候选全部落空（' + reasons.slice(0, 6).join('/') + '…）' };
}

/** 右键点某个节点（真鼠标）→ 返回菜单文本数组（菜单没弹出来也如实说） */
async function openNodeMenu(ctx, id) {
  const pt = await ctx.exec(`(function () { var el = document.querySelector('jmnode[nodeid=${JSON.stringify(id)}]');`
    + ' if (!el) return null; var r = el.getBoundingClientRect();'
    + ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
  if (!pt) return { items: [], why: '找不到节点元素 ' + id };
  await ctx.input.drag(pt, pt, undefined, { button: 'right', stepDelayMs: 0 });   // 真右键（down+moves+up 同点）
  await ctx.input.settle(PAINT);
  return ctx.exec(`(function () { var m = document.getElementById('ctx-menu');`
    + ' if (!m || m.style.display === "none") return { items: [], why: "菜单没弹出来" };'
    + ' return { items: Array.prototype.slice.call(m.querySelectorAll(".ctx-item"))'
    + '.map(function (e) { return e.textContent; }) }; })()');
}

/** 点菜单里第一项文本含 needle 的那一条（真鼠标）。
 *  ⚠️ 与"可见性"同一条纪律：**先 `elementFromPoint` 确认那一点真的能点到这条菜单项**
 *  （菜单可能被自家浮层盖住 —— 实测：右键选中节点后弹出的浮动详情框会盖在菜单上，
 *   于是"点了"但动作没跑 ✗）。点到别的东西 ⇒ 如实回报 `top`，不假装点着了。 */
async function clickMenuItem(ctx, needle) {
  const r = await ctx.exec(`(function () { var m = document.getElementById('ctx-menu');`
    + ' if (!m) return null; var hit = null;'
    + ' Array.prototype.slice.call(m.querySelectorAll(".ctx-item")).forEach(function (e) {'
    + '   if (!hit && e.textContent.indexOf(' + JSON.stringify(needle) + ') >= 0) hit = e; });'
    + ' if (!hit) return { miss: true };'
    + ' var b = hit.getBoundingClientRect();'
    + ' var x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);'
    + ' var top = document.elementFromPoint(x, y);'
    + ' return { x: x, y: y, self: !!top && (top === hit || hit.contains(top)),'
    + '   top: top ? (top.tagName + (top.id ? "#" + top.id : "") + (top.className ? "." + String(top.className).split(" ")[0] : "")) : "(null)" }; })()');
  if (!r || r.miss === true || r.self !== true) {
    return { ok: false, why: r && r.miss ? ('菜单里没有含「' + needle + '」的项') : ('那一点被别的东西占着：' + JSON.stringify(r)) };
  }
  await ctx.input.click({ x: r.x, y: r.y });
  await ctx.input.settle(PAINT);
  return { ok: true, at: r.x + ',' + r.y };
}

async function closeMenu(ctx) { await ctx.exec('if (window.MMContextMenu) window.MMContextMenu.closeMenu(); 1'); }

/** 把某个节点先"抬"到面板上部再右键。**为什么需要**：菜单是向下展开的，而 `openMenu` 的视口夹取
 *  用 `offsetHeight || 40` 估高度（此刻菜单还没显示 ⇒ 高度恒按 40 估）⇒ **高菜单**（节点菜单十几条）
 *  开在靠下的位置时，最后几条会落到窗口可视区之外 —— `elementFromPoint` 直接返回 null（点不到）。
 *  这是既有实现的性质，**本域不改它**（不在本期范围，已如实登记）；测试里做的是用户也会做的动作：
 *  把画布往上挪一下再点 ✓。 */
async function liftNode(ctx, id) {
  return ctx.exec(`(function () {
    var el = document.querySelector('jmnode[nodeid=${JSON.stringify(id)}]');
    if (!el) return null;
    var p = window.MM.fdPanel().getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var want = p.top + 120;
    var dy = Math.round(want - (r.top + r.height / 2));
    var pan = window.MMApp.getPanState();
    window.MM.setViewTransform({ x: pan.x, y: pan.y + dy, s: pan.s });
    var r2 = el.getBoundingClientRect();
    return { movedBy: dy, cy: Math.round(r2.top + r2.height / 2), cx: Math.round(r2.left + r2.width / 2),
      viewTop: Math.round(window.MMApp.getPanState().y) };
  })()`);
}
const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');
const buckets = (ctx) => ctx.exec('(function () { return { themes: window.MMApp.getTreeOffsets(),'
  + ' nodes: window.MMApp.getNodeOffsets() }; })()');
const save = (ctx) => ctx.exec('(async function () { return await window.MMApp.save(); })()');

/** 等**画布稳定**再量基线（连续三次同一个 `getPanState()` 才认）。
 *
 *  为什么必须有（**已知模式**，域 46 甲同一个坑、同一套等法）：右键会先**选中**那个节点 ⇒ jsMind 重排
 *  一次 ⇒ 本工程的「重排锚点保持」（`renderer/app-view.js` 的 `wrapLayoutAnchor`）为了让"被操作的
 *  节点原地不动"补偿一次画布平移 —— 实测那次补偿是 **`[0,33]`**。它**不是**右键那一刻同步发生的：
 *  落在随后几拍里（全链负载下更晚）⇒ 基线若取在它前面，"其余节点矩形逐项相同"在**基线那一侧**
 *  就已经不成立（本域实测读数：5 个非目标节点**同一个 `dy=33`**、而目标子树按真实位移走）。
 *  ⚠️ 判据只能是"连续两次读到同一个画布变换"——**不许**把"整幅画布平移"容忍成通过 ✗
 *  （那正是"整棵树一起动"这条真缺陷的形状）。
 *  📌 这是**同一段等待逻辑的第二份拷贝**（第一份在 `scripts/smoke/46-节点级拖动.js` 的 `waitStableView`）：
 *  第三次再撞上就该把它提到共用处（`scripts/smoke-assertions.js`），本批**不开新抽象** ✗。 */
async function waitStableView(ctx) {
  let last = null, same = 0;
  for (let i = 0; i < 12; i++) {
    const st = await ctx.exec('JSON.stringify(window.MMApp.getPanState())');
    if (st === last) { same++; if (same >= 2) return st; } else { same = 0; last = st; }
    await ctx.input.settle({ delayMs: 70 });
  }
  return last;
}

/** 把整棵树展开到屏上（夹具的新节点默认折叠）——`expand_all()` 一次搞定，比逐节点 expand 少几次重排。
 *  返回 `{ radar }`；目标**还不在**屏上 ⇒ `diag` 里有诊断（调用方判红并打出来，不静默跳过）。 */
async function ensureTargetVisible(ctx) {
  await ctx.exec('(function () { window.MMApp.getState().jm.expand_all(); return true; })()');
  const radar = await ctx.exec(RADAR);
  let diag = null;
  if (!radar.rects[TARGET]) {
    diag = await ctx.exec('(function () { var jm = window.MMApp.getState().jm; var out = {};'
      + ' ' + JSON.stringify(TARGET_SUB) + '.forEach(function (id) {'
      + '   var n = jm.get_node(id); var el = document.querySelector(\'jmnode[nodeid="\' + id + \'"]\');'
      + '   var r = el ? el.getBoundingClientRect() : null;'
      + '   out[id] = { node: !!n, expanded: n ? n.expanded : null, el: !!el,'
      + '     rect: r ? [Math.round(r.width), Math.round(r.height)] : null }; });'
      + ' return { project: (window.MMApp.getState().project || {}).name, nodes: out }; })()');
  }
  return { radar: radar, diag: diag };
}

/** 目标不在屏上时统一给出的判红读数（**不静默跳过**：采不到真值 = 红） */
function notVisible(d) {
  return { ok: false, text: '目标子树不在屏上 ⇒ **未验证**（不是通过）：见诊断 ' + JSON.stringify(d.diag) };
}

/** 夹具：与 CLI `init` + `add` 同形状的项目 JSON（直接写盘 ⇒ 确定性、也不拖慢链） */
function writeFixture(ctx) {
  const dir = path.join(projectsDir(), P);
  fs.mkdirSync(dir, { recursive: true });
  const node = (id, topic, expanded, children) => Object.assign(
    { id: id, topic: topic, expanded: expanded }, children ? { children: children } : {});
  const data = {
    meta: { name: P, author: '', version: '0.0.0', formatVersion: 2, rootMode: 'themes' },
    format: 'node_tree',
    data: node('root', 'R2 期 1 夹具', true, [
      node('t1', '主题甲', false, [
        node('na', '甲-1', false, [node('na1', '甲-1-1', true), node('na2', '甲-1-2', true)]),
        node('nb', '甲-2', true)
      ]),
      node('t2', '主题乙', false, [node('nc', '乙-1', true)])
    ])
  };
  fs.writeFileSync(projectFile(P), JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

const assertions = [

  {
    name: '甲 默认档逐字节不变：无偏移项目的 serializeTree 里**一个偏移键都没有**、save 把恰好这份文本写到盘上、isDirty 全程 false',
    run: async (ctx) => {
      await stubConfirm(ctx, true);
      // 进来时开着哪个项目：**必须在这里记**（本域第一段就 openProject ⇒ 之后问不出来）
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return (s && s.project && s.project.name) || ""; })()');
      const data = writeFixture(ctx);                       // 盘上真值：本域自己写的无偏移夹具
      const h0 = sha256(readRaw(P));
      const opened = await openProject(ctx, P);
      // 载入后立刻（没做任何编辑）：序列化文本里不许出现任何一个偏移键
      const r = await ctx.exec(`(function () {
        var app = window.MMApp;
        var text = JSON.stringify(app.serializeTree(), null, 2);
        return {
          text: text,
          hasKey: (text.indexOf('"nodeOffsets"') >= 0) || (text.indexOf('"themeOffsets"') >= 0),
          dirty0: app.isDirty(),
          themes: Object.keys(app.getTreeOffsets()).length,
          nodes: Object.keys(app.getNodeOffsets()).length
        };
      })()`);
      const saved = await save(ctx);
      const raw1 = readRaw(P);
      const savedIsText = (raw1 === r.text) || (raw1 === r.text + '\n');
      const dirty1 = await isDirty(ctx);
      const checks = [
        ['进来时开着项目（收尾要交还）', !!PROJECT_WHEN_ENTERED],
        ['夹具是 8 个节点', 8 === (function () {
          let n = 0;
          (function walk(x) { n++; (x.children || []).forEach(walk); })(data.data);
          return n;
        })()],
        ['openProject 成功', opened === true],
        ['序列化文本里没有偏移键', r.hasKey === false],
        ['打开后 isDirty=false', r.dirty0 === false],
        ['两桶读数都是 0', r.themes === 0 && r.nodes === 0],
        ['save 成功', saved === true],
        ['盘上 == 序列化文本（没多写键）', savedIsText],
        ['保存后 isDirty=false', dirty1 === false]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '序列化文本里有偏移键=' + r.hasKey + ' · 两桶=' + r.themes + '/' + r.nodes
          + ' · isDirty 打开后/保存后=' + r.dirty0 + '/' + dirty1
          + ' · 盘上 == 序列化文本=' + savedIsText + '（' + r.text.length + ' vs ' + raw1.length + ' 字符）'
          + ' · 夹具 sha256=' + h0.slice(0, 12) + ' · 进来时开着=' + PROJECT_WHEN_ENTERED
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '乙 入口与真鼠标拖动（深层子树）：只有它移动（其余节点矩形逐项相同）、父子关系逐字节不变、偏移只进 nodeOffsets、拖动期间盘上零写入、isDirty false→true、移动后 elementFromPoint 命中自己、save 后盘上 == 位移、重开项目全部还原',
    run: async (ctx) => {
      const opened = await openProject(ctx, P);
      const dirtyAfterOpen = await isDirty(ctx);
      const h0 = sha256(readRaw(P));
      const vis = await ensureTargetVisible(ctx);
      if (!vis.radar.rects[TARGET]) return notVisible(vis);
      const before = vis.radar;
      const plan = pickDelta(before, TARGET_SUB);
      if (!plan || !plan.from) {
        return { ok: false, text: '没找到落点 ⇒ **未验证**拖动（不是通过）：' + JSON.stringify(plan)
          + ' ｜ 面板=' + JSON.stringify(before.panel) + ' 矩形=' + JSON.stringify(before.rects) };
      }
      const dataBefore = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      // ① 入口（真鼠标右键深层节点）：菜单里**四个拖动入口一条都没有**（2026-10-33 批4 已摘），
      //    且**不许**出现分侧项；进模式直接从 API 走（`setDragMode` 那一族一行没删 ⇒ 拖动本体照旧判）。
      const deepMenu = await openNodeMenu(ctx, TARGET);
      const has = (list, s) => list.some((t) => t.indexOf(s) >= 0);
      const GONE = ['拖动树', '拖动此子树', '拖动到同级第几位', '挂到别的父节点下'];
      const entryOk = GONE.every((k) => !has(deepMenu.items, k))
        && !has(deepMenu.items, '摆到左侧') && !has(deepMenu.items, '摆到右侧');
      await closeMenu(ctx);      // 读完就关：改前是点菜单项顺手关的，现在没人关它（会挡在画布上 ✗）
      await ctx.exec('window.MMApp.setDragMode(true, ' + JSON.stringify(TARGET) + '); 1');
      await ctx.input.settle(PAINT);
      const entered = await ctx.exec('(function () { return { on: window.MMApp.dragModeActive(),'
        + ' root: window.MMApp.getDragTreeRoot() }; })()');
      /* ⚠️ 几何基线**必须取在"按下"之后**（本行以下用的都是 `base2`）—— 这是改前那条假红的真因：
       * 真鼠标**按下**到节点上会**选中**它 ⇒ jsMind 重排一次 ⇒ 本工程的「重排锚点保持」
       * （`renderer/app-view.js` 的 `wrapLayoutAnchor`）为了让"被操作的节点原地不动"补偿一次画布平移
       * —— 实测那次补偿是 `[0,33]`：全链里 5 个非目标节点拿到**同一个 `dy=33`**，而目标子树按真实位移走
       * ⇒"其余节点矩形逐项相同"与"目标子树按位移移动"两条一起红（单独跑（01+45）时负载轻、
       * 补偿没发生 ⇒ 绿 ⇒ 典型的"**链内红、单独跑绿**"）。
       * 关键读数（别把基线又挪回右键之后）：**右键那一拍画布是稳的**（transform 前后一字不差），
       * 补偿发生在**按下**那一拍 ⇒ 只等右键是抓不住的。改法与域 46 甲逐字同源（那里是
       * 右键即选中，所以基线落在右键之后就够了）：基线挪到**所有会改视图的交互之后**，
       * 落点按新基线重算，位移一律按**指针位移**算（子树跟随指针 1:1，与补偿无关）——
       * **不是**放宽判据 ✗（"拖动中其余节点一个都不许动"照旧判，只是从按下之后开始比）。 */
      const pressR = await ctx.exec(RADAR);
      const from0 = (pressR.rects && pressR.rects[TARGET])
        ? { x: pressR.rects[TARGET].cx, y: pressR.rects[TARGET].cy } : plan.from;
      await ctx.input.mouseDown(from0);
      await ctx.input.settle(PAINT);
      await waitStableView(ctx);      // 等"按下即选中"引起的那次画布补偿落定（见 waitStableView 的说明）
      const base2 = await ctx.exec(RADAR);
      const baseRects = (base2 && base2.rects && Object.keys(base2.rects).length) ? base2.rects : before.rects;
      const plan2 = (base2.rects && base2.rects[TARGET]) ? pickDelta(base2, TARGET_SUB) : null;
      const planUse = (plan2 && plan2.from) ? plan2 : plan;
      // ② 真鼠标拖动：按住不放 → 移到"按下点 + 位移"→ 松手（位移 = 指针位移 ✓）
      const land = { x: from0.x + planUse.dx, y: from0.y + planUse.dy };
      await ctx.input.moveTo(land);
      await ctx.input.settle(PAINT);
      await ctx.input.mouseUp(land);
      await ctx.input.settle(PAINT);
      const after = await ctx.exec(RADAR);
      const dirtyAfterDrag = await isDirty(ctx);
      const dataAfter = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      const h1 = sha256(readRaw(P));                        // 拖动**不写盘**（纯视图操作）
      const bk = await buckets(ctx);
      // ③ 可见性：移动后的每个节点在**它的新位置**上被自己（或自己的后代）命中（不是 rect 自证）
      const hit = await ctx.exec(`(function () {
        var out = {};
        ${JSON.stringify(TARGET_SUB)}.forEach(function (id) {
          var el = document.querySelector('jmnode[nodeid="' + id + '"]');
          if (!el) { out[id] = '没有元素'; return; }
          var r = el.getBoundingClientRect();
          var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          var top = document.elementFromPoint(x, y);
          out[id] = (!!top && (top === el || el.contains(top))) ? 'hit'
            : ('miss→' + (top ? (top.tagName + (top.className ? '.' + String(top.className).split(' ')[0] : '')) : '(null)'));
        });
        return out;
      })()`);
      await ctx.exec('window.MMApp.setDragMode(false); 1');
      // ④ 持久化：save ⇒ 盘上偏移现算 == 屏幕位移；再「重开项目」⇒ 读数/transform/矩形全部还原
      const saved = await save(ctx);
      const dirtyAfterSave = await isDirty(ctx);
      const disk = JSON.parse(readRaw(P));
      const diskOff = (disk.meta && disk.meta.nodeOffsets) || {};
      const diskThemes = (disk.meta && disk.meta.themeOffsets) || {};
      const key = diskOff[TARGET] || null;
      const d = cmpRects(baseRects, after.rects);
      const others = Object.keys(baseRects).filter((id) => TARGET_SUB.indexOf(id) < 0);
      const stray = d.moved.filter((m) => TARGET_SUB.indexOf(m.id) < 0);
      const sub = d.moved.filter((m) => TARGET_SUB.indexOf(m.id) >= 0);
      await openProject(ctx, P);                            // 「重开项目」⇒ 从盘上重建
      const vis2 = await ensureTargetVisible(ctx);          // 重开后视图是"只展开根"，要再展开到同一状态才可比
      const back = vis2.radar;
      const backBuckets = await buckets(ctx);
      const tf = await ctx.exec('(function () { var el = document.querySelector(\'jmnode[nodeid="' + TARGET + '"]\');'
        + ' return el ? String(el.style.transform || "") : "(没有元素)"; })()');
      const d2 = cmpRects(baseRects, back.rects);
      const backSub = d2.moved.filter((m) => TARGET_SUB.indexOf(m.id) >= 0);
      const backStray = d2.moved.filter((m) => TARGET_SUB.indexOf(m.id) < 0);
      /* ⚠️ 重开这一档**必须按相对位移判**：`openProject` 会把视图复位并按盘重建，而"重开后重新展开"
       * （`ensureTargetVisible`）会**再触发一次**「重排锚点保持」的画布补偿 —— 实测 `[0,33]`：
       * 于是**每一个非目标节点都整体平移同一个量**，绝对位移与"拖动前那份基线"不可比 ✗
       * （改前实测读数：目标子树 `dy=197` 而盘上偏移是 `230`，差的正是那 33 ⇒ 两条判据一起红）。
       * 判法：非目标节点的位移必须是**同一个值**（不统一 ⇒ 谁单独乱走了 ⇒ 判红），
       * 目标子树的位移**减去这个整体平移**后必须 == 拖动位移 ±1px。**这不是放宽**：
       * "其余节点只能整体一起走"与"目标相对其余节点走满位移"两条都照旧判 ✓
       * （真回归的形状 —— 偏移没复现 ⇒ 相对位移变成 0、或某个节点单独乱走 —— 两条都仍然必红）。 */
      const backStrayUniform = backStray.length
        ? backStray.every((m) => m.dx === backStray[0].dx && m.dy === backStray[0].dy) : true;
      const panShift = backStray.length ? { dx: backStray[0].dx, dy: backStray[0].dy } : { dx: 0, dy: 0 };
      const backRel = backSub.map((m) => ({ id: m.id, dx: m.dx - panShift.dx, dy: m.dy - panShift.dy }));
      const checks = [
        ['openProject 成功', opened === true],
        ['打开后 isDirty=false', dirtyAfterOpen === false],
        ['菜单里四个拖动入口一条都没有、且无分侧项', entryOk],
        ['直接调 API 进了拖动模式且目标==目标节点', entered.on === true && entered.root === TARGET],
        ['nodeOffsets 只有目标一项且 == 位移',
          Math.abs(Object.keys(bk.nodes).length - 1) === 0 && !!bk.nodes[TARGET]
          && Math.abs(bk.nodes[TARGET].x - planUse.dx) <= 1 && Math.abs(bk.nodes[TARGET].y - planUse.dy) <= 1],
        ['themeOffsets 一个键都没写', Object.keys(bk.themes).length === 0],
        ['目标子树 3 个节点都按位移移动',
          sub.length === TARGET_SUB.length && sub.every((m) => Math.abs(m.dx - planUse.dx) <= 1
            && Math.abs(m.dy - planUse.dy) <= 1 && m.dw === 0 && m.dh === 0)],
        ['其余节点矩形逐项相同', others.length > 0 && d.unchanged.length === others.length && stray.length === 0],
        ['没有节点消失', d.gone.length === 0],
        ['拖动不改父子关系（data 子树逐字节相同）', dataAfter === dataBefore],
        ['拖动期间盘上零写入', h1 === h0],
        ['isDirty 拖动后=true', dirtyAfterDrag === true],
        ['移动后每个节点都命中自己', Object.keys(hit).every((id) => hit[id] === 'hit')],
        ['save 成功', saved === true],
        ['保存后 isDirty=false', dirtyAfterSave === false],
        ['盘上 nodeOffsets == 屏幕位移',
          !!key && Math.abs(key.x - planUse.dx) <= 1 && Math.abs(key.y - planUse.dy) <= 1
          && Object.keys(diskOff).length === 1 && Object.keys(diskThemes).length === 0],
        ['重开后桶里有目标且 == 盘上',
          !!backBuckets.nodes[TARGET] && !!key
          && Math.abs(backBuckets.nodes[TARGET].x - key.x) <= 1
          && Math.abs(backBuckets.nodes[TARGET].y - key.y) <= 1
          && Object.keys(backBuckets.themes).length === 0],
        ['重开后目标相对"其余节点的整体平移"仍走满拖动位移（画布补偿已扣除）',
          backSub.length === TARGET_SUB.length
          && backRel.every((m) => Math.abs(m.dx - planUse.dx) <= 1 && Math.abs(m.dy - planUse.dy) <= 1)],
        ['重开后其余节点只发生了**同一个**整体平移（没有谁单独乱走）且无丢失',
          backStrayUniform === true && d2.gone.length === 0],
        ['重开后 DOM transform 是 translate', tf.indexOf('translate') === 0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '位移=' + planUse.dx + ',' + planUse.dy
          + '（画布 transform 基线前后=' + JSON.stringify(before.view) + ' → ' + JSON.stringify(base2 && base2.view) + '）'
          + ' · 菜单项=' + JSON.stringify(deepMenu.items.slice(-3))
          + ' · 目标子树 ' + sub.length + '/' + TARGET_SUB.length + ' 个按位移移动'
          + ' · 其余 ' + others.length + ' 个矩形逐项相同=' + (d.unchanged.length === others.length)
            + (stray.length ? ' ✗多动：' + JSON.stringify(stray) : '')
          + ' · nodeOffsets=' + JSON.stringify(bk.nodes) + ' · themeOffsets 键数=' + Object.keys(bk.themes).length
          + ' · data 子树逐字节相同=' + (dataAfter === dataBefore)
          + ' · 盘上零写入=' + (h1 === h0) + ' · isDirty 打开后/拖动后/保存后='
            + dirtyAfterOpen + '/' + dirtyAfterDrag + '/' + dirtyAfterSave
          + ' · 命中=' + JSON.stringify(hit)
          + ' · 盘上偏移=' + JSON.stringify(diskOff) + ' · 重开后 桶=' + JSON.stringify(backBuckets.nodes)
            + ' 位移(绝对)=' + JSON.stringify(backSub) + ' 其余节点整体平移=' + JSON.stringify(panShift)
            + ' 位移(相对)=' + JSON.stringify(backRel) + ' transform=' + tf
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 20 条判据全成立')
      };
    }
  },

  {
    name: '丙 方向入口（顶层主题级）：右键顶层主题**四个拖动入口一个都不在**（逐个点名）而两条分侧项仍在；摆到左侧 ⇒ 该支屏幕 cx < 根 cx 且盘上 meta.layout.left 含它；摆回右侧 ⇒ 反向成立且盘上换边；非顶层节点被响亮拒绝',
    run: async (ctx) => {
      // 用当前状态（上一段已把 t1/na 展开在屏上），不重开项目 —— 方向入口只对顶层主题开放
      const lifted1 = await liftNode(ctx, TOP_THEME);
      const topMenu = await openNodeMenu(ctx, TOP_THEME);
      const has = (list, s) => list.some((t) => t.indexOf(s) >= 0);
      /* 2026-10-33 批4：四条拖动入口已从菜单摘除 ⇒ 这条菜单文案断言**改写成新现实**（不是删掉）：
       * 四个入口逐个点名都**不在**，而两条分侧项**仍在**（后者证明只摘了拖动那四条、没顺手掏空菜单）。 */
      const GONE = ['拖动树', '拖动此子树', '拖动到同级第几位', '挂到别的父节点下'];
      const menuOk = GONE.every((k) => !has(topMenu.items, k))
        && has(topMenu.items, '摆到左侧') && has(topMenu.items, '摆到右侧');
      const cx = (id) => ctx.exec('(function () { var el = document.querySelector(\'jmnode[nodeid="' + id + '"]\');'
        + ' if (!el) return null; var r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2); })()');
      const clickedLeft = await clickMenuItem(ctx, '摆到左侧');
      await ctx.input.settle({ delayMs: 900 });             // 等它 rebuild + save 落地
      const rootCx = await cx('root');
      const t1CxLeft = await cx(TOP_THEME);
      const sideLeft = await ctx.exec('window.MMApp.themeSideOf("' + TOP_THEME + '")');
      const diskLeft = ((JSON.parse(readRaw(P)).meta || {}).layout || {}).left || [];
      // 反向：再右键一次 → 点「摆到右侧」（正向对照：证明这条入口真的能改，不是恒真）
      const lifted2 = await liftNode(ctx, TOP_THEME);      // 摆侧会重建视图 ⇒ 再抬一次
      const topMenu2 = await openNodeMenu(ctx, TOP_THEME);
      const clickedRight = await clickMenuItem(ctx, '摆到右侧');
      await ctx.input.settle({ delayMs: 900 });
      const conflict = await ctx.exec('window.MMApp.hasPendingConflict()');
      const sideRight = await ctx.exec('window.MMApp.themeSideOf("' + TOP_THEME + '")');
      const inMemLayout = await ctx.exec('JSON.stringify((window.MMApp.serializeTree().meta || {}).layout || null)');
      const dirNow = await ctx.exec('(function () { var n = window.MMApp.getState().jm.get_node("' + TOP_THEME + '");'
        + ' return n ? String(n.direction) : "(没有节点)"; })()');
      const rootCx2 = await cx('root');
      const t1CxRight = await cx(TOP_THEME);
      const layoutRight = ((JSON.parse(readRaw(P)).meta || {}).layout || {});
      const deepRefused = await ctx.exec('window.MMApp.setThemeSide("' + TARGET + '", "left")');
      const checks = [
        ['顶层主题菜单：四个拖动入口全不在（逐个点名）+ 两条分侧仍在', menuOk],
        ['点「摆到左侧」真触发（含命中测试）', clickedLeft.ok === true],
        ['左侧几何：该支 cx < 根 cx', typeof t1CxLeft === 'number' && typeof rootCx === 'number' && t1CxLeft < rootCx],
        ['内存读数 themeSideOf=left', sideLeft === 'left'],
        ['盘上 meta.layout.left 含它', diskLeft.indexOf(TOP_THEME) >= 0],
        ['第二次右键仍有两条分侧项', has(topMenu2.items, '摆到右侧')],
        ['点「摆到右侧」真触发（含命中测试）', clickedRight.ok === true],
        ['内存读数 themeSideOf=right', sideRight === 'right'],
        ['右侧几何：该支 cx > 根 cx', typeof t1CxRight === 'number' && typeof rootCx2 === 'number' && t1CxRight > rootCx2],
        ['盘上换边（right 含它、left 不含）', (layoutRight.right || []).indexOf(TOP_THEME) >= 0
          && (layoutRight.left || []).indexOf(TOP_THEME) < 0],
        ['非顶层节点被响亮拒绝', !!deepRefused && deepRefused.ok === false
          && typeof deepRefused.reason === 'string' && deepRefused.reason.length > 0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '顶层主题菜单=' + JSON.stringify(topMenu.items.slice(-4))
          + ' · 抬到上部=' + JSON.stringify(lifted1) + '/' + JSON.stringify(lifted2)
          + ' · 根 cx=' + rootCx + '/' + rootCx2 + ' · 主题 cx 左=' + t1CxLeft + ' 右=' + t1CxRight
          + ' · themeSideOf 左后/右后=' + sideLeft + '/' + sideRight
          + ' · 内存 layout=' + inMemLayout + ' t1.direction=' + dirNow
          + ' · 盘上 layout 左后=' + JSON.stringify(diskLeft) + ' 右后=' + JSON.stringify(layoutRight)
          + ' · 未决冲突=' + conflict
          + ' · 点菜单 左=' + JSON.stringify(clickedLeft) + ' 右=' + JSON.stringify(clickedRight)
          + ' · 非顶层节点=' + JSON.stringify(deepRefused)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '丁 结构断言：renderer/**.js（vendor 外、剥注释后）不得出现 jsMind 的 .move_node(/.insert_node_before(/.insert_node_after(（第二条重排语义）；判别力=vendor 里确实有这些 needle',
    run: async () => {
      const rootDir = path.resolve(__dirname, '..', '..', 'renderer');
      const needles = ['.move_node(', '.insert_node_before(', '.insert_node_after('];
      const scan = [];
      (function walk(d) {
        fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); return; }
          if (!/\.js$/.test(e.name)) return;
          scan.push(p);
        });
      })(rootDir);
      const hits = [];
      scan.forEach((p) => {
        const code = stripComments(fs.readFileSync(p, 'utf8'));
        needles.forEach((n) => { if (code.indexOf(n) >= 0) hits.push(path.relative(rootDir, p) + ' ⇒ ' + n); });
      });
      // 判别力：同一组 needle 在**vendor**（第三方 bundle）里真实存在 ⇒ 这条判据不是空转的
      const vendor = fs.readFileSync(path.join(rootDir, 'vendor', 'jsmind.js'), 'utf8');
      const vendorHits = needles.filter((n) => vendor.indexOf(n) >= 0);
      const floor = 8;                                      // 扫描面下限：掉到个位数说明扫描面搭错了
      return {
        ok: hits.length === 0 && vendorHits.length === needles.length && scan.length >= floor,
        text: '扫描面=' + scan.length + ' 个第一方 js（≥' + floor + '）· 命中=' + hits.length
          + (hits.length ? ' ✗ ' + hits.join(' / ') : '')
          + ' · 判别力：vendor 里命中 ' + vendorHits.length + '/' + needles.length + ' 个 needle'
          + (vendorHits.length === needles.length ? '（证 needle 是真的）' : ' ✗ needle 空转')
      };
    }
  },

  {
    name: '戊 收尾：偏移清回自动布局并落盘、进来时开着的项目开回去、确认桩复位（不给后面的域留状态）',
    run: async (ctx) => {
      const cleared = await ctx.exec('(function () { window.MM.clearTreeOffsets();'
        + ' return Object.keys(window.MMApp.getNodeOffsets()).length + Object.keys(window.MMApp.getTreeOffsets()).length; })()');
      const saved = await save(ctx);
      const disk = JSON.parse(readRaw(P));
      const offLeft = Object.keys((disk.meta && disk.meta.nodeOffsets) || {}).length
        + Object.keys((disk.meta && disk.meta.themeOffsets) || {}).length;
      const back = await openProject(ctx, PROJECT_WHEN_ENTERED);
      await stubConfirm(ctx, null);                          // 复位打桩口（留给后面的域的是本体）
      return {
        ok: cleared === 0 && saved === true && offLeft === 0 && back === true && STUB_INSTALLED === false,
        text: '清后两桶=' + cleared + ' · 保存=' + saved + ' · 盘上偏移键数=' + offLeft
          + ' · 开回原项目（' + (PROJECT_WHEN_ENTERED || '(空)') + '）=' + back
          + ' · 确认桩已复位=' + (STUB_INSTALLED === false)
      };
    }
  },

];

module.exports = assertions;
