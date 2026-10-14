/* ============================================================
 * scripts/smoke/46-节点级拖动.js —— 【R2 期 2 · c】拖动单个子树或节点 + 伴随修复（菜单溢出）
 * ------------------------------------------------------------
 * 用户原话（R2 需求 c）：拖动单位要能细到"**某一个子树或某一个节点**"，而不是只有
 * "整棵顶层主题树一起走"；而且**拖出去要还抓得住**、拖回来要还在手底下。
 * 本域钉的是**界面那一半**（`renderer/app-view.js` 的拖动路径 —— 偏移键域已扩到任意子树根）+ **伴随修复**
 * （`renderer/contextmenu.js` 的菜单定位），**一个字节的项目数据都没有新增**：
 * 拖动不改父子关系、不产生新契约字段，偏移只进既有 `meta.nodeOffsets` / `meta.themeOffsets`，
 * 而且**只在显式保存时**才落盘（拖动期间盘上零写入）。
 *
 *  甲 **深层子树的拖动本体（按住不放，沿途量六处：按下 / 中途 / 拖出视口 / 拖回原地 / 落到空地 / 松手）**：
 *     ① 只有目标子树按位移走（其余 8 个矩形**逐项相同**）；
 *     ② 拖动**全程**父子关系逐字节不变（`serializeTree().data` 与拖动前逐字节相同），
 *        序列化产物相对拖动前**只多 `nodeOffsets` 这一个键**（其余键与 data 逐项相同）；
 *     ③ 拖出视口 ⇒ 节点**仍在 DOM 里**、仍跟着指针走（不丢抓取）、挂载数与布局节点数都不变
 *        （不变式①「布局照算、只裁剪渲染」的读数）；拖回**原地** ⇒ 序列化文本与拖动前
 *        **逐字节相同**、`elementFromPoint` 仍命中自身（防"拖出去就掉"）；
 *     ④ 全程盘上零写入（sha256 不变、盘上**没有** `nodeOffsets` 键）—— 直到显式 `save()`
 *        之后盘上才出现 == 屏幕位移的那一项。
 *  乙 **累计偏移**：顶层主题已有手工位置（按数据那一档装进来）时再拖深层子树 ⇒
 *     依然只有目标子树动（其余 8 个矩形逐项相同）、它自己那一项 == 本次拖动位移、
 *     而屏幕上的 transform == 主题 + 自己的**累计**（jsMind 的节点是平铺兄弟元素，
 *     祖先的 transform 不会自动传给后代 —— 累计这件事必须由实现自己算）。
 *  丙 **伴随修复（菜单溢出）**：节点摆在面板下部（菜单向下展开必然越界的位置）右键 ⇒
 *     菜单**显示后再量**真实高度并上翻/夹进视口 ⇒ 每一项都能被 `document.elementFromPoint`
 *     命中（**含最后一项**），并且**真鼠标点最后一项真的生效**（「移回自动布局」把手工位置清掉、
 *     节点正好回到自动布局位置）。改前这一档实测是"最后 8 条 `elementFromPoint` 返回 null"。
 *  丁 **干净基线下的"拖动不产生脏数据"（设计稿期 2 的判据 4）**：刚打开、还没展开过任何节点的项目
 *     （`isDirty() === false`）里拖一个**顶层主题子树**：拖出去再拖回**原地** ⇒ `isDirty()` 仍是
 *     **false**、序列化文本逐字节不变（零偏移 = 不进数据）；一旦有非零位移 ⇒ 唯一多出来的键是
 *     `themeOffsets`（数据层一个字节没动）；显式保存后才落盘。
 *  戊 收尾：偏移清回自动布局并落盘、进来时开着的项目开回去、确认桩复位。
 *
 * 判据纪律（与 36/37/42/43/45 同）：可见性一律 `document.elementFromPoint`（rect 只用来判几何）；
 * 动作一律**真鼠标**（`ctx.input.*` 走 Chromium 命中测试，不是 `dispatchEvent` 合成事件）；
 * 真值读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 在 --smoke 下指向临时副本）。
 * ⚠️ 夹具是本域自己写进沙箱的 `zz-` 项目（不碰 comnet）。无头跑里没人回答模态 ⇒ 显式装打桩答案
 *    （`MMApp.setConfirmStub`），收尾复位成本体。
 * ⚠️ 每一步真输入之后**必须等一拍再量**（`ctx.input.settle`）：输入事件经主进程排队，
 *    紧接着量会把"还没落地"读成"没动"（本域第一版探针实测踩到：中途那一步量到 0 位移）。
 * ⚠️ **本域刻意不"先保存再拖"**：保存成功（`isDirty()` 为 false）时，主进程的项目目录监听会发
 *    `project:disk-changed`，渲染层的自动重读会**从盘上重渲染**（`renderMind` 默认"只展开根"）
 *    ⇒ 视图当场折回、深层目标看不见了（实测踩到：那条路上量到"目标节点本身不在屏上"）。
 *    所以本域的基线取"**展开之后、拖动之前**"那一份（展开本身是用户自己的折叠状态改动，
 *    本来就该算未保存改动），判据落在"**拖动只让序列化产物多 nodeOffsets 这一个键**"
 *    与"**拖回原地时逐字节回到那一份**"上 —— 这两条比一个布尔脏标记更强。干净基线下
 *    `isDirty()` 的读法见**丁**（不必展开深层节点的那一档）。
 * ⚠️ 写盘一律 node 的 `writeFileSync`（无 BOM），注释不要写成行内标记形态（G9 会去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 沙箱夹具项目：顶层主题 t1/t2；t1 下 na → n1 → {n1a(含 n1a1/n1a2), n1b}；t2 下 nc（共 11 个节点） */
const P = 'zz-r2-drag';
/** 拖动目标：**深层节点**（root → t1 → na → n1 → n1a，第 4 层），它自己带两个孩子 */
const TARGET = 'n1a';
const TARGET_SUB = ['n1a', 'n1a1', 'n1a2'];
const TOP_THEME = 't1';
/** 丁那一档的目标：顶层主题（打开项目就能看见，**不需要展开任何节点** ⇒ 基线是干净的） */
const SUB2 = [TOP_THEME];

/** 进来时界面开着哪个项目（收尾要交还回去） */
let PROJECT_WHEN_ENTERED = '';
/** 收尾复位用的"打过桩"标记 */
let STUB_INSTALLED = false;

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到盘上真值');
  return d;
}
const projectFile = (name) => path.join(projectsDir(), name, name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 真输入之后的等待：≥2 帧 + 一小段真实时间（输入事件经主进程排队，得给它落地的时间） */
const STEP = { delayMs: 60 };
const PAINT = { delayMs: 120 };

async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await ctx.input.settle({ delayMs: 160 });
  return ok;
}

async function stubConfirm(ctx, answer) {
  await ctx.exec('window.MMApp.setConfirmStub(' + (answer === null ? 'null' : 'function () { return ' + (answer ? 'true' : 'false') + '; }') + ')');
  STUB_INSTALLED = answer !== null;
}

/** 全屏雷达：所有**可见**节点的屏幕矩形 + 面板 + 窗口 + 挂载数（被 overflow 裁掉不影响 rect） */
const RADAR = `(function () {
  var app = window.MMApp;
  var out = {};
  document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;          // 折叠着（display:none）⇒ 不在对照面里
    out[el.getAttribute('nodeid')] = {
      l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2)
    };
  });
  var p = window.MM.fdPanel();
  var b = p.getBoundingClientRect();
  return {
    rects: out,
    mounted: document.querySelectorAll('jmnode[nodeid]').length,
    view: app.getPanState(),
    win: { w: window.innerWidth, h: window.innerHeight },
    panel: { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }
  };
})()`;

function cmpRects(before, after) {
  const unchanged = [], moved = [], gone = [];
  Object.keys(before).forEach((id) => {
    const a = before[id], b = after[id];
    if (!b) { gone.push(id); return; }
    const dx = b.l - a.l, dy = b.t - a.t, dw = b.w - a.w, dh = b.h - a.h;
    if (dx === 0 && dy === 0 && dw === 0 && dh === 0) unchanged.push(id);
    else moved.push({ id: id, dx: dx, dy: dy, dw: dw, dh: dh });
  });
  return { unchanged: unchanged, moved: moved, gone: gone };
}

/** 落点现算（cfg.target 的子树整体平移 (dx,dy) 后）：① 不压到任何其他可见节点
 *  ② 完整落在面板可视区内（四边各自内缩；右侧 60 是因为面板右缘 24px 内松手 = "丢给侧栏"，不能误触）
 *  ③ 松手点也留在面板里。八个方向 × 四档幅度，顺序固定 ⇒ 读数确定。
 *  找不到 ⇒ 返回 `{why}`（判红并如实说"没找到落点"，不静默跳过）。 */
function pickDelta(radar, cfg) {
  const panel = radar.panel;
  const padL = 20, padT = 30, padB = 70, padR = 60;
  const W = panel.right - panel.left, H = panel.bottom - panel.top;
  const inSub = (id) => cfg.sub.indexOf(id) >= 0;
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
  const mine = bbox(cfg.sub);
  const from = radar.rects[cfg.target];
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
  return { why: '候选全部落空（' + reasons.slice(0, 8).join('/') + '…）' };
}

/** 右键点某个节点（真鼠标）→ 菜单读数：每条菜单项的几何 + 它自己的中心能不能点到自己 */
async function openNodeMenu(ctx, id) {
  const pt = await ctx.exec(`(function () {
    var el = document.querySelector('jmnode[nodeid=${JSON.stringify(id)}]');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!pt) return { items: [], why: '找不到节点元素 ' + id };
  await ctx.input.drag(pt, pt, undefined, { button: 'right', stepDelayMs: 0 });
  await ctx.input.settle(PAINT);
  return ctx.exec(`(function () {
    var m = document.getElementById('ctx-menu');
    if (!m || m.style.display === 'none') return { items: [], why: '菜单没弹出来' };
    var b = m.getBoundingClientRect();
    var items = Array.prototype.slice.call(m.querySelectorAll('.ctx-item'));
    var hits = items.map(function (e) {
      var c = e.getBoundingClientRect();
      var x = Math.round(c.left + c.width / 2), y = Math.round(c.top + c.height / 2);
      var top = document.elementFromPoint(x, y);
      return { label: e.textContent, top: Math.round(c.top), bottom: Math.round(c.bottom),
        hit: !!top && (top === e || e.contains(top)),
        at: top ? (top.tagName + (top.id ? '#' + top.id : '')) : '(null)' };
    });
    return { items: items.map(function (e) { return e.textContent; }), hits: hits,
      menu: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
      vw: window.innerWidth, vh: window.innerHeight };
  })()`);
}

async function closeMenu(ctx) { await ctx.exec('if (window.MMContextMenu) window.MMContextMenu.closeMenu(); 1'); }

/** 点菜单里第一项文本含 needle 的那一条（真鼠标）。
 *  ⚠️ 先 `elementFromPoint` 确认那一点真的能点到这条菜单项；点到别的东西 ⇒ 如实回报，不假装点着了。 */
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
    + '   top: top ? (top.tagName + (top.id ? "#" + top.id : "")) : "(null)" }; })()');
  if (!r || r.miss === true || r.self !== true) {
    return { ok: false, why: r && r.miss ? ('菜单里没有含「' + needle + '」的项') : ('那一点被别的东西占着：' + JSON.stringify(r)) };
  }
  await ctx.input.click({ x: r.x, y: r.y });
  await ctx.input.settle(PAINT);
  return { ok: true, at: r.x + ',' + r.y };
}

/** 等**视图变换稳定**再量基线。
 *  为什么必须有：`renderMind` 末尾挂了一个**延后的**中心对齐（`setTimeout(centerOnRoot, 80)`，
 *  覆盖 jsMind 的异步布局）—— 它若落在"量基线"与"按下"之间，就会把**全部节点一起平移**，
 *  于是"只有目标子树动/其余矩形逐项相同"当场假红（实测：全链跑（整机负载高）时必现，
 *  报文里 `unchanged:0 stray:8`、八个节点同一个位移 = 视图被整体挪了）。
 *  判据是**连续三次同一个** `getPanState()`（每次之间隔 2 帧 + 70ms）⇒ 这段时间里没人动过画布。
 *  ⚠️ 不许把"整体平移"容忍成通过：那正是"整棵树一起动"这条真缺陷的形状（注入① 就是它）。 */
async function waitStableView(ctx) {
  let last = null, same = 0;
  for (let i = 0; i < 12; i++) {
    const st = await ctx.exec('JSON.stringify(window.MMApp.getPanState())');
    if (st === last) { same++; if (same >= 2) return st; } else { same = 0; last = st; }
    await ctx.input.settle({ delayMs: 70 });
  }
  return last;
}

/** 平移画布，把某节点中心送到面板内的相对位置（fx/fy 是面板内的比例） */
async function centerNode(ctx, id, fx, fy) {
  return ctx.exec(`(function () {
    var el = document.querySelector('jmnode[nodeid=${JSON.stringify(id)}]');
    if (!el) return null;
    var p = window.MM.fdPanel().getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var wantX = p.left + (p.right - p.left) * ${fx};
    var wantY = p.top + (p.bottom - p.top) * ${fy};
    var pan = window.MMApp.getPanState();
    window.MM.setViewTransform({ x: pan.x + (wantX - (r.left + r.width / 2)),
      y: pan.y + (wantY - (r.top + r.height / 2)), s: pan.s });
    var r2 = el.getBoundingClientRect();
    return { cx: Math.round(r2.left + r2.width / 2), cy: Math.round(r2.top + r2.height / 2) };
  })()`);
}

const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');
const save = (ctx) => ctx.exec('(async function () { return await window.MMApp.save(); })()');

/** 一处读数：几何（与给定基线逐项对比）+ 结构 + 偏移桶 + 脏标记 + 拖动"起没起来" + 盘上 */
async function snap(ctx, tag, cfg, radarBefore, h0) {
  const r = await ctx.exec(`(function () {
    var app = window.MMApp;
    var tg = ${JSON.stringify(cfg.target)};
    var rects = {};
    document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
      var q = el.getBoundingClientRect();
      if (q.width === 0 && q.height === 0) return;
      rects[el.getAttribute('nodeid')] = { l: Math.round(q.left), t: Math.round(q.top),
        w: Math.round(q.width), h: Math.round(q.height),
        cx: Math.round(q.left + q.width / 2), cy: Math.round(q.top + q.height / 2) };
    });
    var el2 = document.querySelector('jmnode[nodeid="' + tg + '"]');
    var b2 = el2 ? el2.getBoundingClientRect() : null;
    var p = window.MM.fdPanel();
    var pb = p.getBoundingClientRect();
    var t2 = b2 ? document.elementFromPoint(Math.round(b2.left + b2.width / 2), Math.round(b2.top + b2.height / 2)) : null;
    return {
      rects: rects,
      mounted: document.querySelectorAll('jmnode[nodeid]').length,
      jmNodes: (function () { var n = 0; (function w(x) { n++; (x.children || []).forEach(w); })(app.getState().jm.get_node('root')); return n; })(),
      data: JSON.stringify(app.serializeTree().data),
      text: JSON.stringify(app.serializeTree(), null, 2),
      themeBucket: app.getTreeOffsets(),
      nodeBucket: app.getNodeOffsets(),
      dirty: app.isDirty(),
      dragRoot: app.getDragTreeRoot(),
      bodyDragging: document.body.classList.contains('mm-dragging'),
      tf: el2 ? String(el2.style.transform || '') : '(no el)',
      targetRect: b2 ? [Math.round(b2.left), Math.round(b2.top), Math.round(b2.width), Math.round(b2.height)] : null,
      targetHit: t2 ? (t2.tagName + (t2.getAttribute && t2.getAttribute('nodeid') ? '#' + t2.getAttribute('nodeid') : '')) : '(null)',
      panel: [Math.round(pb.left), Math.round(pb.top), Math.round(pb.right), Math.round(pb.bottom)],
      s: app.getPanState().s
    };
  })()`);
  const disk = readRaw(P);
  r.tag = tag;
  r.diskSame = sha256(disk) === h0;
  r.diskHasOffsetKey = disk.indexOf('nodeOffsets') >= 0;
  const d = cmpRects(radarBefore, r.rects);
  r.unchanged = d.unchanged;
  r.movedSub = d.moved.filter((m) => cfg.sub.indexOf(m.id) >= 0);
  r.movedStray = d.moved.filter((m) => cfg.sub.indexOf(m.id) < 0);
  r.gone = d.gone;
  r.others = Object.keys(radarBefore).filter((id) => cfg.sub.indexOf(id) < 0);
  r.selfHit = r.targetHit === 'JMNODE#' + cfg.target;
  // 目标子树是否**整体**落在面板之外（"拖出视口"这件事的机械判据；被 overflow 裁掉不影响 rect）
  const b = r.targetRect;
  r.targetOutsidePanel = !!b && (b[0] >= r.panel[2] || b[0] + b[2] <= r.panel[0]
    || b[1] >= r.panel[3] || b[1] + b[3] <= r.panel[1]);
  return r;
}

/** 序列化产物 vs 基线：**只该多 `key` 这一个键**（其余 meta 键与整棵 data 逐项相同） */
async function serializeVsBaseline(ctx, baselineText, key) {
  return ctx.exec(`(function () {
    var now = window.MMApp.serializeTree();
    var base = JSON.parse(${JSON.stringify(baselineText)});
    var kb = Object.keys(base.meta || {}), kn = Object.keys(now.meta || {});
    var topB = Object.keys(base).filter(function (k) { return k !== 'meta'; });
    var topN = Object.keys(now).filter(function (k) { return k !== 'meta'; });
    return {
      addedKeys: kn.filter(function (k) { return kb.indexOf(k) < 0; }),
      removedKeys: kb.filter(function (k) { return kn.indexOf(k) < 0; }),
      changedKeys: kb.filter(function (k) {
        return kn.indexOf(k) >= 0 && JSON.stringify(base.meta[k]) !== JSON.stringify(now.meta[k]); }),
      dataSame: JSON.stringify(base.data) === JSON.stringify(now.data),
      topSame: JSON.stringify(topB.map(function (k) { return [k, base[k]]; }))
        === JSON.stringify(topN.map(function (k) { return [k, now[k]]; })),
      expectKey: ${JSON.stringify(key)}
    };
  })()`);
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
    data: node('root', 'R2 期 2 夹具', true, [
      node('t1', '主题甲', true, [
        node('na', '甲-1', true, [
          node('n1', '甲-1-1', true, [
            node('n1a', '甲-1-1-1', true, [node('n1a1', '甲-1-1-1-1', true), node('n1a2', '甲-1-1-1-2', true)]),
            node('n1b', '甲-1-1-2', true)
          ])
        ]),
        node('nb', '甲-2', true)
      ]),
      node('t2', '主题乙', true, [node('nc', '乙-1', true)])
    ])
  };
  fs.writeFileSync(projectFile(P), JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

/** 开局：写夹具 → 打开 → （可选）展开全部。**不保存**（见文件头"刻意不先保存"那段）。
 *  返回 `{opened, dirtyAfterOpen, text, dirty, h0, visible}`：
 *  `text` = 这一档的**拖动前基线**（判"拖动只多一个键"与"拖回原地逐字节还原"都对着它比）。 */
async function openFixture(ctx, opts) {
  const o = opts || {};
  writeFixture(ctx);
  const opened = await openProject(ctx, P);
  if (opened !== true) return { opened: false };
  const dirtyAfterOpen = await isDirty(ctx);
  if (o.expand) {
    await ctx.exec('(function () { window.MMApp.getState().jm.expand_all(); return true; })()');
    await ctx.input.settle(STEP);
    // 展开后目标必须在屏上（采不到真值 = 红，不静默跳过）
    const vis = await ctx.exec(`(function () {
      var el = document.querySelector('jmnode[nodeid=${JSON.stringify(o.target)}]');
      if (!el) return 0;
      var r = el.getBoundingClientRect();
      return (r.width > 0 && r.height > 0) ? 1 : 0;
    })()`);
    if (vis !== 1) {
      await ctx.exec('(function () { window.MMApp.getState().jm.expand_all(); return true; })()');
      await ctx.input.settle(STEP);
    }
  }
  const h0 = sha256(readRaw(P));
  const text = await ctx.exec('JSON.stringify(window.MMApp.serializeTree(), null, 2)');
  const dirty = await isDirty(ctx);
  return { opened: opened, dirtyAfterOpen: dirtyAfterOpen, text: text, dirty: dirty, h0: h0 };
}

const assertions = [

  {
    name: '甲 深层子树的真鼠标拖动（按下/中途/拖出视口/拖回原地/落到空地/松手 六处现量）：只有目标子树按位移走（其余 8 个矩形逐项相同）、父子关系全程逐字节不变且序列化只多 nodeOffsets 一个键、拖出视口仍挂载且布局节点数不变、拖回原地逐字节还原且仍命中自身、全程盘上零写入（直到显式 save）',
    run: async (ctx) => {
      await stubConfirm(ctx, true);
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return (s && s.project && s.project.name) || ""; })()');
      const cfg = { target: TARGET, sub: TARGET_SUB };
      const base = await openFixture(ctx, { expand: true, target: TARGET });
      if (base.opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**：' + JSON.stringify(base) };
      const baseData = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      await centerNode(ctx, TARGET, 0.42, 0.45);            // 目标落到能往外拖的地方
      await waitStableView(ctx);
      const menu = await openNodeMenu(ctx, TARGET);
      const has = (list, str) => list.some((t) => t.indexOf(str) >= 0);
      const clicked = await clickMenuItem(ctx, '拖动此子树');
      const entered = await ctx.exec('(function () { return { on: window.MMApp.dragModeActive(), root: window.MMApp.getDragTreeRoot() }; })()');
      /* ⚠️ 几何基线取在**所有会改视图的交互之后**：右键选中节点会让 jsMind 重排一次，而本工程
       * 的「重排锚点保持」（app-view.js 的 wrapLayoutAnchor）会为了"被操作的节点原地不动"
       * 补偿一次画布平移 —— 实测那次补偿是 `[0,33]`（`window.__anchorLog` 有留痕），
       * 于是"其余矩形逐项相同"会在基线那一侧就已经不成立（全链负载下必现）。 */
      await waitStableView(ctx);
      const radar1 = await ctx.exec(RADAR);
      const plan = pickDelta(radar1, cfg);
      if (!plan || !plan.from) {
        return { ok: false, text: '没找到落点 ⇒ **未验证**拖动（不是通过）：' + JSON.stringify(plan)
          + ' ｜ 面板=' + JSON.stringify(radar1.panel) + ' 矩形=' + JSON.stringify(radar1.rects) };
      }
      const s = radar1.view.s || 1;
      const h0 = base.h0;
      // 拖出视口的点：面板**外侧**但仍在窗口内（右侧先试；窗口比面板宽时必然成立）
      const pl = radar1.panel, win = radar1.win;
      const outCands = [
        { x: Math.round(pl.right + 90), y: Math.round((pl.top + pl.bottom) / 2) },
        { x: Math.round((pl.left + pl.right) / 2), y: Math.round(pl.bottom + 50) },
        { x: Math.max(6, Math.round(pl.left - 90)), y: Math.round((pl.top + pl.bottom) / 2) }
      ].filter((c) => c.x > 2 && c.x < win.w - 2 && c.y > 2 && c.y < win.h - 2);
      const outPt = outCands[0] || null;
      // —— 真鼠标：按住不放，沿途量六处 ——
      await ctx.input.mouseDown(plan.from);
      await ctx.input.settle(STEP);
      const stDown = await snap(ctx, 'down', cfg, radar1.rects, h0);
      const mid = { x: plan.from.x + Math.round(plan.dx * 0.35), y: plan.from.y + Math.round(plan.dy * 0.35) };
      await ctx.input.moveTo(mid);
      await ctx.input.settle(STEP);
      const stMid = await snap(ctx, 'mid', cfg, radar1.rects, h0);
      const serMid = await serializeVsBaseline(ctx, base.text, 'nodeOffsets');
      let stOut = null;
      if (outPt) {
        await ctx.input.moveTo(outPt);
        await ctx.input.settle(STEP);
        stOut = await snap(ctx, 'out', cfg, radar1.rects, h0);
      }
      await ctx.input.moveTo(plan.from);                     // 拖回**原地**（净位移 0）
      await ctx.input.settle(STEP);
      const stHome = await snap(ctx, 'home', cfg, radar1.rects, h0);
      const land = { x: plan.from.x + plan.dx, y: plan.from.y + plan.dy };
      await ctx.input.moveTo(land);
      await ctx.input.settle(STEP);
      const stLand = await snap(ctx, 'land', cfg, radar1.rects, h0);
      await ctx.input.mouseUp(land);
      await ctx.input.settle(PAINT);
      const stUp = await snap(ctx, 'up', cfg, radar1.rects, h0);
      await ctx.exec('window.MMApp.setDragMode(false); 1');
      // 显式保存 ⇒ 盘上才出现 nodeOffsets（== 屏幕位移）
      const saved = await save(ctx);
      const dirtyAfterSave = await isDirty(ctx);
      const disk = JSON.parse(readRaw(P));
      const diskOff = (disk.meta && disk.meta.nodeOffsets) || {};
      const diskThemes = (disk.meta && disk.meta.themeOffsets) || {};
      const key = diskOff[TARGET] || null;
      const movedBy = (st) => st.movedSub.length === cfg.sub.length
        && st.movedSub.every((m) => m.dw === 0 && m.dh === 0);
      const checks = [
        ['打开夹具成功、且**打开后** isDirty=false（默认档基线干净）', base.opened === true && base.dirtyAfterOpen === false],
        ['不拖时序列化里没有偏移键（默认档逐字节不变那一档）',
          base.text.indexOf('"nodeOffsets"') < 0 && base.text.indexOf('"themeOffsets"') < 0],
        ['拖动前：展开深层节点这一步本身是未保存改动（既有语义，如实记）', base.dirty === true],
        ['菜单里有「拖动此子树」', has(menu.items, '拖动此子树')],
        ['点菜单真进拖动模式且目标 == 目标节点', clicked.ok === true && entered.on === true && entered.root === TARGET],
        ['按下就把抓取拿到手（body 有拖动态）', stDown.bodyDragging === true && stDown.dragRoot === TARGET],
        ['按下（还没移动）时偏移桶为空、transform 空、isDirty 与拖动前一样',
          Object.keys(stDown.nodeBucket).length === 0 && stDown.tf === '' && stDown.dirty === base.dirty],
        ['按下时 11 个矩形全部不动', Object.keys(radar1.rects).length === 11
          && stDown.unchanged.length === 11 && stDown.movedSub.length === 0],
        ['中途：目标子树 3 个各按已移动的位移走', movedBy(stMid)],
        ['中途：其余 8 个矩形逐项相同', stMid.others.length === 8 && stMid.unchanged.length === 8
          && stMid.movedStray.length === 0],
        ['中途：序列化只多 nodeOffsets 一个键（data 与其余键逐项相同）',
          JSON.stringify(serMid.addedKeys) === JSON.stringify(['nodeOffsets'])
          && serMid.removedKeys.length === 0 && serMid.changedKeys.length === 0
          && serMid.dataSame === true && serMid.topSame === true],
        ['中途：盘上零写入且还没落 nodeOffsets 键', stMid.diskSame === true && stMid.diskHasOffsetKey === false],
        ['拖出视口：目标子树整体在面板之外（真的拖出去了）', !!stOut && stOut.targetOutsidePanel === true],
        ['拖出视口：仍在 DOM 里、挂载数 == 布局节点数（不变式①：不许裁剪掉/懒布局）',
          !!stOut && stOut.mounted === 11 && stOut.jmNodes === 11 && stOut.mounted === stOut.jmNodes],
        ['拖出视口：仍跟着指针走（偏移 == 指针位移 / 缩放）',
          !!stOut && !!stOut.nodeBucket[TARGET]
          && Math.abs(stOut.nodeBucket[TARGET].x - Math.round((outPt.x - plan.from.x) / s)) <= 1
          && Math.abs(stOut.nodeBucket[TARGET].y - Math.round((outPt.y - plan.from.y) / s)) <= 1
          && stOut.bodyDragging === true],
        ['拖出视口：其他 8 个矩形仍逐项相同', !!stOut && stOut.unchanged.length === 8
          && stOut.movedStray.length === 0 && stOut.gone.length === 0],
        ['拖回原地：序列化文本与拖动前**逐字节相同**、isDirty 回到拖动前的值（零偏移 = 一个字节的痕迹都不留）',
          stHome.text === base.text && stHome.tf === '' && Object.keys(stHome.nodeBucket).length === 0
          && stHome.dirty === base.dirty],
        ['拖回原地：elementFromPoint 仍命中自身（防"拖出去就掉"）', stHome.selfHit === true],
        ['拖回原地：11 个矩形全部回到原位', stHome.unchanged.length === 11 && stHome.movedStray.length === 0],
        ['落到空地：目标子树 3 个按落点位移走、其余 8 个不动、命中自身',
          movedBy(stLand) && Math.abs(stLand.movedSub[0].dx - plan.dx) <= 1
          && Math.abs(stLand.movedSub[0].dy - plan.dy) <= 1
          && stLand.unchanged.length === 8 && stLand.movedStray.length === 0 && stLand.selfHit === true],
        ['松手：结构逐字节不变（本期不写父子）',
          stUp.data === baseData && stLand.data === baseData && stHome.data === baseData
          && stMid.data === baseData && stDown.data === baseData && (!!stOut ? stOut.data === baseData : true)],
        ['松手：偏移还在（待保存）、盘上零写入、仍无 nodeOffsets 键',
          stUp.dirty === true && stUp.diskSame === true && stUp.diskHasOffsetKey === false
          && !!stUp.nodeBucket[TARGET]
          && Math.abs(stUp.nodeBucket[TARGET].x - plan.dx) <= 1 && Math.abs(stUp.nodeBucket[TARGET].y - plan.dy) <= 1],
        ['全程盘上逐字节零写入（六处同一个 sha256）', stDown.diskSame && stMid.diskSame && stHome.diskSame
          && stLand.diskSame && stUp.diskSame && (!!stOut ? stOut.diskSame : true)],
        ['松手后退出了"正在拖"的状态、目标仍是它', stUp.bodyDragging === false && stUp.dragRoot === TARGET],
        ['显式 save 后：盘上 nodeOffsets == 屏幕位移、themeOffsets 一个键都没写、isDirty=false',
          saved === true && dirtyAfterSave === false && !!key
          && Math.abs(key.x - plan.dx) <= 1 && Math.abs(key.y - plan.dy) <= 1
          && Object.keys(diskOff).length === 1 && Object.keys(diskThemes).length === 0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      const strayUniform = (st) => {
        const s = st.movedStray;
        return s.length >= 2 && s.every((m) => m.dx === s[0].dx && m.dy === s[0].dy);
      };
      const stage = (st) => (st ? { t: st.tag, dirty: st.dirty, off: st.nodeBucket, self: st.selfHit,
        movedSub: st.movedSub.length, unchanged: st.unchanged.length, stray: st.movedStray.length,
        mounted: st.mounted, jm: st.jmNodes, disk: st.diskSame, tf: st.tf, hit: st.targetHit,
        textEqBase: st.text === base.text } : null);
      return {
        ok: fails.length === 0,
        text: '位移=' + plan.dx + ',' + plan.dy + ' 缩放=' + s
          + ' · 面板=' + JSON.stringify(pl) + ' 拖出点=' + JSON.stringify(outPt)
          + ' · 六处读数=' + JSON.stringify([stage(stDown), stage(stMid), stage(stOut), stage(stHome), stage(stLand), stage(stUp)])
          + ' · 中途序列化对比=' + JSON.stringify(serMid)
          + ' · 盘上偏移=' + JSON.stringify(diskOff) + ' 盘上主题偏移键数=' + Object.keys(diskThemes).length
          + ' · isDirty 打开后/拖动前/按下/中途/原地/松手/保存='
            + [base.dirtyAfterOpen, base.dirty, stDown.dirty, stMid.dirty, stHome.dirty, stUp.dirty, dirtyAfterSave].join('/')
          + ' · 基线文本 sha=' + sha256(base.text).slice(0, 12) + ' 拖回原地文本 sha=' + sha256(stHome.text).slice(0, 12)
          + ' · 盘上 sha 基线/松手时/保存后=' + [h0.slice(0, 12), sha256(readRaw(P)).slice(0, 12)].join('/')
          + (strayUniform(stDown)
            ? ' ⚠ 疑似**视图被整体平移**（按下那一档的 ' + stDown.movedStray.length + ' 个"其余节点"'
              + '位移完全相同 ' + JSON.stringify([stDown.movedStray[0].dx, stDown.movedStray[0].dy])
              + '）—— 检查 `waitStableView` 是否真的等到画布不再动；'
              + '锚点补偿留痕（`window.__anchorLog`：dx,dy,缩放,fdView.x,fdView.y）='
              + await ctx.exec('JSON.stringify(window.__anchorLog || null)') : '')
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '乙 累计偏移：顶层主题已有手工位置（按数据那一档装进来）时再真鼠标拖深层子树 ⇒ 仍只有目标子树动（其余 8 个矩形逐项相同）、它自己那一项 == 本次位移、屏幕 transform == 主题 + 自己的累计、拖动期间盘上零写入',
    run: async (ctx) => {
      const cfg = { target: TARGET, sub: TARGET_SUB };
      const base = await openFixture(ctx, { expand: true, target: TARGET });
      if (base.opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**：' + JSON.stringify(base) };
      const baseData = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      // 顶层主题的手工位置：走**打开项目时那条恢复路径**（setTreeOffsets = renderMind 里同一处实现）
      const back = await ctx.exec('window.MMApp.setTreeOffsets({ ' + JSON.stringify(TOP_THEME) + ': { x: -140, y: -60 } }, null)');
      await ctx.input.settle(STEP);
      await centerNode(ctx, TARGET, 0.42, 0.42);
      await ctx.exec('window.MMApp.setDragMode(true, ' + JSON.stringify(TARGET) + ')');
      await waitStableView(ctx);          // 基线取在所有会改视图的交互之后（见甲的说明）
      const radar1 = await ctx.exec(RADAR);
      const plan = pickDelta(radar1, cfg);
      if (!plan || !plan.from) {
        return { ok: false, text: '没找到落点 ⇒ **未验证**拖动（不是通过）：' + JSON.stringify(plan)
          + ' ｜ 面板=' + JSON.stringify(radar1.panel) + ' 矩形=' + JSON.stringify(radar1.rects) };
      }
      const before = await ctx.exec(`(function () {
        var g = function (id) { var el = document.querySelector('jmnode[nodeid="' + id + '"]'); return el ? String(el.style.transform || '') : '(no el)'; };
        return { tf: g(${JSON.stringify(TARGET)}), tfTop: g(${JSON.stringify(TOP_THEME)}),
          buckets: { themes: window.MMApp.getTreeOffsets(), nodes: window.MMApp.getNodeOffsets() } };
      })()`);
      const entered = await ctx.exec('(function () { return window.MMApp.dragModeActive()'
        + ' && window.MMApp.getDragTreeRoot() === ' + JSON.stringify(TARGET) + '; })()');
      await ctx.input.mouseDown(plan.from);
      await ctx.input.settle(STEP);
      await ctx.input.moveTo({ x: plan.from.x + plan.dx, y: plan.from.y + plan.dy });
      await ctx.input.settle(STEP);
      const st = await snap(ctx, 'land', cfg, radar1.rects, base.h0);
      await ctx.input.mouseUp({ x: plan.from.x + plan.dx, y: plan.from.y + plan.dy });
      await ctx.input.settle(PAINT);
      await ctx.exec('window.MMApp.setDragMode(false); 1');
      const num = (tf) => {
        const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(String(tf));
        return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
      };
      const tfNum = num(st.tf);
      const core = [
        ['setTreeOffsets 落下一项顶层主题偏移', back === 1],
        ['进拖动模式且目标 == 目标节点', entered === true && st.dragRoot === TARGET],
        ['装进来时：主题 transform = translate(-140px, -60px)（累计的底）',
          JSON.stringify(num(before.tfTop)) === JSON.stringify({ x: -140, y: -60 })],
        ['装进来时：目标 transform == 主题那一份（它自己还没有偏移）',
          JSON.stringify(num(before.tf)) === JSON.stringify({ x: -140, y: -60 })],
        ['拖动后：只有目标子树 3 个动、其余 8 个矩形逐项相同',
          st.movedSub.length === 3 && st.unchanged.length === 8 && st.movedStray.length === 0 && st.gone.length === 0],
        ['位移与落点一致（3 个节点逐项 == 落点位移）',
          st.movedSub.every((m) => Math.abs(m.dx - plan.dx) <= 1 && Math.abs(m.dy - plan.dy) <= 1
            && m.dw === 0 && m.dh === 0)],
        ['它自己那一项 == 本次拖动位移（不含主题那一份）',
          !!st.nodeBucket[TARGET] && Math.abs(st.nodeBucket[TARGET].x - plan.dx) <= 1
          && Math.abs(st.nodeBucket[TARGET].y - plan.dy) <= 1
          && Object.keys(st.nodeBucket).length === 1],
        ['屏幕 transform == 主题 + 自己的累计',
          !!tfNum && Math.abs(tfNum.x - (-140 + plan.dx)) <= 1 && Math.abs(tfNum.y - (-60 + plan.dy)) <= 1],
        ['主题桶仍在（两桶各管各的）', Object.keys(st.themeBucket).length === 1 && !!st.themeBucket[TOP_THEME]],
        ['拖动期间结构逐字节不变', st.data === baseData],
        ['拖动期间盘上零写入', st.diskSame === true && st.diskHasOffsetKey === false],
        ['落到空地命中自身', st.selfHit === true]
      ];
      const fails = core.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '位移=' + plan.dx + ',' + plan.dy
          + ' · 装进来后 主题tf=' + before.tfTop + ' 目标tf=' + before.tf
          + ' · 拖动后 目标tf=' + st.tf + '（期望 translate(' + (-140 + plan.dx) + 'px, ' + (-60 + plan.dy) + 'px)）'
          + ' · 桶=' + JSON.stringify(st.nodeBucket) + ' / 主题桶=' + JSON.stringify(st.themeBucket)
          + ' · 动的节点=' + JSON.stringify(st.movedSub.map((m) => m.id + ':' + m.dx + ',' + m.dy))
          + ' · 其余 ' + st.unchanged.length + '/8 逐项相同=' + (st.unchanged.length === 8)
          + (st.movedStray.length ? ' ✗多动=' + JSON.stringify(st.movedStray) : '')
          + ' · 盘上零写入=' + st.diskSame + ' 盘上有偏移键=' + st.diskHasOffsetKey
          + ' · 命中自己被=' + st.selfHit
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '丙 伴随修复·菜单溢出：节点摆在面板下部（菜单向下展开必然越界的位置）右键 ⇒ 菜单显示后再量真实高度并上翻/夹进视口，每一项都能被 elementFromPoint 命中（含最后一项）、菜单矩形完整落在视口内，且真鼠标点最后一项（移回自动布局）真的生效',
    run: async (ctx) => {
      // 给目标装上一项手工位置：菜单最后一项（「移回自动布局」）只在它**自己有偏移**时才出现。
      // 偏移取**横向**的（-240, 0）：这样"挪到面板下部"那一步不会把它推到面板外去（纵向下移会）。
      const cfg = { target: TARGET, sub: TARGET_SUB };
      const base = await openFixture(ctx, { expand: true, target: TARGET });
      if (base.opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**：' + JSON.stringify(base) };
      const OFF = { x: -240, y: 0 };
      const put = await ctx.exec('window.MMApp.setTreeOffsets(null, { ' + JSON.stringify(TARGET)
        + ': { x: ' + OFF.x + ', y: ' + OFF.y + ' } })');
      await ctx.input.settle(STEP);
      // 挪到面板下部（0.86 高）：这一档正是改前"最后几条点不到"的位置
      await centerNode(ctx, TARGET, 0.5, 0.86);
      await waitStableView(ctx);
      const lowInfo = await ctx.exec(`(function () {
        var el = document.querySelector('jmnode[nodeid=${JSON.stringify(TARGET)}]');
        var r = el.getBoundingClientRect();
        var p = window.MM.fdPanel().getBoundingClientRect();
        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          panelBottom: Math.round(p.bottom), vh: window.innerHeight, vw: window.innerWidth,
          hasOwn: window.MMApp.hasOwnOffset(${JSON.stringify(TARGET)}) };
      })()`);
      const menu = await openNodeMenu(ctx, TARGET);
      const last = menu.hits && menu.hits.length ? menu.hits[menu.hits.length - 1] : null;
      const hitCount = (menu.hits || []).filter((h) => h.hit).length;
      const menuFits = !!menu.menu && menu.menu[0] >= 0 && menu.menu[1] >= 0
        && menu.menu[2] <= menu.vw && menu.menu[3] <= menu.vh;
      const offsetsBeforeClick = await ctx.exec('JSON.stringify(window.MMApp.getNodeOffsets())');
      const dirtyBeforeClick = await isDirty(ctx);
      const clicked = await clickMenuItem(ctx, '移回自动布局');
      const afterClick = await ctx.exec(`(function () {
        var el = document.querySelector('jmnode[nodeid=${JSON.stringify(TARGET)}]');
        var r = el.getBoundingClientRect();
        return { buckets: { themes: window.MMApp.getTreeOffsets(), nodes: window.MMApp.getNodeOffsets() },
          hasOwn: window.MMApp.hasOwnOffset(${JSON.stringify(TARGET)}),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          tf: String(el.style.transform || '') };
      })()`);
      const dirtyAfterClick = await isDirty(ctx);
      const dxBack = afterClick.rect[0] - lowInfo.rect[0];
      const dyBack = afterClick.rect[1] - lowInfo.rect[1];
      const checks = [
        ['夹具打开成功', base.opened === true],
        ['目标被装上一项手工位置（菜单最后一项才有出现条件）', put === 1 && lowInfo.hasOwn === true],
        ['目标落在面板下部（菜单向下展开会越界的位置）',
          lowInfo.cy > lowInfo.vh / 2 && lowInfo.panelBottom - lowInfo.cy < 120],
        ['菜单每一项都在（12 条）', (menu.items || []).length === 12],
        ['最后一项是「移回自动布局」（本条的点击目标）', !!last && last.label.indexOf('移回自动布局') >= 0],
        ['每一项都被 elementFromPoint 命中（含最后一项）',
          hitCount === (menu.items || []).length && !!last && last.hit === true],
        ['菜单矩形完整落在视口内', menuFits === true],
        ['菜单没有越过视口下缘（最后一项的 bottom <= 视口高）', !!last && last.bottom <= menu.vh],
        ['点之前目标确实有偏移（对照组：证明"清掉"确实改了东西）',
          offsetsBeforeClick.indexOf(TARGET) >= 0],
        ['真鼠标点最后一项真的生效（点得到）', clicked.ok === true],
        ['点之后手工位置被清掉（两桶都空、hasOwnOffset=false）',
          Object.keys(afterClick.buckets.nodes).length === 0 && Object.keys(afterClick.buckets.themes).length === 0
          && afterClick.hasOwn === false],
        ['点之后 transform 清空、节点矩形正好回到自动布局位置（位移 == 清掉的那一项的相反数）',
          afterClick.tf === '' && dxBack === -OFF.x && dyBack === -OFF.y
          && afterClick.rect[2] === lowInfo.rect[2] && afterClick.rect[3] === lowInfo.rect[3]],
        ['清掉仍是一次未保存改动（isDirty 仍 true，不静默）', dirtyAfterClick === true]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '目标中心=' + lowInfo.cx + ',' + lowInfo.cy + '（面板底=' + lowInfo.panelBottom + ' 视口=' + lowInfo.vw + 'x' + lowInfo.vh + '）'
          + ' · 菜单矩形=' + JSON.stringify(menu.menu) + ' · 命中 ' + hitCount + '/' + (menu.items || []).length
          + ' · 最后一项=' + JSON.stringify(last)
          + ' · 未命中的项=' + JSON.stringify((menu.hits || []).filter((h) => !h.hit).map((h) => h.label + '@' + h.top + '→' + h.at))
          + ' · 点最后一项=' + JSON.stringify(clicked)
          + ' · 点后 桶=' + JSON.stringify(afterClick.buckets) + ' 矩形=' + JSON.stringify(afterClick.rect)
          + '（点前=' + JSON.stringify(lowInfo.rect) + ' ⇒ 回到自动布局的位移=' + dxBack + ',' + dyBack + '，偏移是 ' + OFF.x + ',' + OFF.y + '）'
          + ' · isDirty 点前/点后=' + dirtyBeforeClick + '/' + dirtyAfterClick
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '丁 干净基线下的"拖动不产生脏数据"：刚打开（isDirty=false、只展开根）时拖一个顶层主题子树 ⇒ 途中唯一多出来的键是 themeOffsets、数据层一个字节没动；拖出视口再拖回原地 ⇒ isDirty 回到 false、序列化文本逐字节不变；显式保存后盘上才有 themeOffsets == 位移',
    run: async (ctx) => {
      const cfg = { target: TOP_THEME, sub: SUB2 };
      const base = await openFixture(ctx, { expand: false, target: TOP_THEME });
      if (base.opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**：' + JSON.stringify(base) };
      const baseData = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      const entered = await ctx.exec('window.MMApp.setDragMode(true, ' + JSON.stringify(TOP_THEME) + ')');
      await waitStableView(ctx);          // 基线取在所有会改视图的交互之后（见甲的说明）
      const radar1 = await ctx.exec(RADAR);
      const plan = pickDelta(radar1, cfg);
      if (!plan || !plan.from) {
        return { ok: false, text: '没找到落点 ⇒ **未验证**拖动（不是通过）：' + JSON.stringify(plan)
          + ' ｜ 面板=' + JSON.stringify(radar1.panel) + ' 矩形=' + JSON.stringify(radar1.rects) };
      }
      const pl = radar1.panel, win = radar1.win;
      const outPt = [
        { x: Math.round(pl.right + 90), y: Math.round((pl.top + pl.bottom) / 2) },
        { x: Math.round((pl.left + pl.right) / 2), y: Math.round(pl.bottom + 50) },
        { x: Math.max(6, Math.round(pl.left - 90)), y: Math.round((pl.top + pl.bottom) / 2) }
      ].filter((c) => c.x > 2 && c.x < win.w - 2 && c.y > 2 && c.y < win.h - 2)[0] || null;
      await ctx.input.mouseDown(plan.from);
      await ctx.input.settle(STEP);
      const stDown = await snap(ctx, 'down', cfg, radar1.rects, base.h0);
      let stOut = null;
      if (outPt) {
        await ctx.input.moveTo(outPt);
        await ctx.input.settle(STEP);
        stOut = await snap(ctx, 'out', cfg, radar1.rects, base.h0);
        stOut.serOut = await serializeVsBaseline(ctx, base.text, 'themeOffsets');
      }
      await ctx.input.moveTo(plan.from);                     // 拖回**原地**
      await ctx.input.settle(STEP);
      const stHome = await snap(ctx, 'home', cfg, radar1.rects, base.h0);
      const serHome = await serializeVsBaseline(ctx, base.text, null);
      await ctx.input.moveTo({ x: plan.from.x + plan.dx, y: plan.from.y + plan.dy });
      await ctx.input.settle(STEP);
      const stLand = await snap(ctx, 'land', cfg, radar1.rects, base.h0);
      const serLand = await serializeVsBaseline(ctx, base.text, 'themeOffsets');
      await ctx.input.mouseUp({ x: plan.from.x + plan.dx, y: plan.from.y + plan.dy });
      await ctx.input.settle(PAINT);
      const stUp = await snap(ctx, 'up', cfg, radar1.rects, base.h0);
      await ctx.exec('window.MMApp.setDragMode(false); 1');
      const saved = await save(ctx);
      const dirtyAfterSave = await isDirty(ctx);
      const disk = JSON.parse(readRaw(P));
      const diskThemes = (disk.meta && disk.meta.themeOffsets) || {};
      const diskNodes = (disk.meta && disk.meta.nodeOffsets) || {};
      const key = diskThemes[TOP_THEME] || null;
      const checks = [
        ['打开后 isDirty=false（**干净基线**：这一档不需要展开任何节点）', base.dirtyAfterOpen === false && base.dirty === false],
        ['不拖时序列化里没有偏移键', base.text.indexOf('"nodeOffsets"') < 0 && base.text.indexOf('"themeOffsets"') < 0],
        ['按下（还没移动）时 isDirty 仍 false、偏移桶空、transform 空',
          stDown.dirty === false && Object.keys(stDown.themeBucket).length === 0 && stDown.tf === ''],
        ['按下时 3 个可见矩形全部不动', stDown.unchanged.length === 3 && stDown.movedSub.length === 0],
        ['拖出视口：还在 DOM 里、仍跟着指针走、isDirty 变 true',
          !!stOut && stOut.mounted === stOut.jmNodes && !!stOut.themeBucket[TOP_THEME] && stOut.dirty === true
          && stOut.bodyDragging === true],
        ['拖出视口：只有目标子树动（其余 2 个矩形逐项相同）',
          !!stOut && stOut.movedSub.length === 1 && stOut.unchanged.length === 2 && stOut.movedStray.length === 0],
        ['拖出视口：序列化只多 themeOffsets 一个键、数据层逐字节不变',
          !!stOut && JSON.stringify(stOut.serOut.addedKeys) === JSON.stringify(['themeOffsets'])
          && stOut.serOut.changedKeys.length === 0 && stOut.serOut.dataSame === true],
        ['拖回原地：isDirty **回到 false**（零偏移不进数据）、序列化文本逐字节还原',
          stHome.dirty === false && stHome.text === base.text && stHome.tf === ''
          && Object.keys(stHome.themeBucket).length === 0],
        ['拖回原地：序列化产物与拖动前完全一样（一个键都不多）',
          JSON.stringify(serHome.addedKeys) === JSON.stringify([]) && serHome.dataSame === true
          && serHome.topSame === true],
        ['拖回原地：elementFromPoint 命中自身', stHome.selfHit === true],
        ['落到空地：只有目标子树按位移走、其余 2 个不动、命中自身、isDirty=true',
          stLand.movedSub.length === 1 && Math.abs(stLand.movedSub[0].dx - plan.dx) <= 1
          && Math.abs(stLand.movedSub[0].dy - plan.dy) <= 1
          && stLand.unchanged.length === 2 && stLand.movedStray.length === 0
          && stLand.selfHit === true && stLand.dirty === true],
        ['落到空地：序列化只多 themeOffsets 一个键',
          JSON.stringify(serLand.addedKeys) === JSON.stringify(['themeOffsets']) && serLand.dataSame === true],
        ['拖动期间结构逐字节不变、盘上零写入',
          stUp.data === baseData && stLand.data === baseData && stHome.data === baseData && stDown.data === baseData
          && stDown.diskSame && stHome.diskSame && stLand.diskSame && stUp.diskSame
          && stUp.diskHasOffsetKey === false],
        ['显式 save 后：盘上 themeOffsets == 屏幕位移、nodeOffsets 一个键都没写、isDirty=false',
          saved === true && dirtyAfterSave === false && !!key
          && Math.abs(key.x - plan.dx) <= 1 && Math.abs(key.y - plan.dy) <= 1
          && Object.keys(diskThemes).length === 1 && Object.keys(diskNodes).length === 0],
        ['进过拖动模式且目标是这个顶层主题', entered === true && stUp.dragRoot === TOP_THEME]
      ];
      // `serOut` 由快照里现取（避免多一次 exec）：snapshot 阶段把对比结果挂在 stage 上
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '位移=' + plan.dx + ',' + plan.dy + ' · 打开后 isDirty=' + base.dirtyAfterOpen
          + ' · 可见节点=' + Object.keys(radar1.rects).length + ' 拖出点=' + JSON.stringify(outPt)
          + ' · isDirty 按下/出视口/原地/落地/松手/保存='
            + [stDown.dirty, stOut && stOut.dirty, stHome.dirty, stLand.dirty, stUp.dirty, dirtyAfterSave].join('/')
          + ' · 文本 vs 基线（原地）=' + (stHome.text === base.text)
          + ' · 中途键级对比=' + JSON.stringify(stOut ? stOut.serOut : null)
          + ' · 落地键级对比=' + JSON.stringify(serLand) + ' 原地键级对比=' + JSON.stringify(serHome)
          + ' · 盘上 themeOffsets=' + JSON.stringify(diskThemes) + ' nodeOffsets=' + JSON.stringify(diskNodes)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
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
      await stubConfirm(ctx, null);
      return {
        ok: cleared === 0 && saved === true && offLeft === 0 && back === true && STUB_INSTALLED === false,
        text: '清后两桶=' + cleared + ' · 保存=' + saved + ' · 盘上偏移键数=' + offLeft
          + ' · 开回原项目（' + (PROJECT_WHEN_ENTERED || '(空)') + '）=' + back
          + ' · 确认桩已复位=' + (STUB_INSTALLED === false)
      };
    }
  }

];

module.exports = assertions;
