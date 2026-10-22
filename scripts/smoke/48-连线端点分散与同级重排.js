/* ============================================================
 * scripts/smoke/48-连线端点分散与同级重排.js —— 【R2 期 3】d（连线不打架）+ e（同级重排）
 * ------------------------------------------------------------
 * 用户原话（R2 需求）：d「父子连线不打架」· e「同级重排（拖到第 k 位 ⇒ 改上下顺序）」。
 * 本域钉的是**两件**（同批交付、断言分开）：
 *
 *  甲 **d · 线端按子序分散**（`renderer/app-view.js` 的 `lineParentPoints` + `show_lines`）：
 *     真 comnet 上的现状读数（只读探针 `probe-line-endpoints.js`，2026-10-16）——
 *     135 个"扇出 ≥ 3"的父**每一个都只有 1 个不同的父端点**、766 条线的父端落在同一个点上、
 *     最大扇出 13 个孩子的父端全部重合于父矩形 `[1923,5908,2194,5946]` 的右边框中点。
 *     本域在一个自造夹具上判四件事：
 *       ① `window.__mmLineEndpoints` 与**独立重算**逐条一致（端点在不在节点边框上、
 *          是不是相邻侧、父端是不是**这条边框上的等分点**）—— 端点真源仍只有 `nodeBorderRect` 一处；
 *       ② 同侧扇出 ≥ 3 的父：**父端互不重合**（这是 d 的直接目的），且**上下序 ⇒ 名次正序**
 *          （第 i 个孩子（按 cy）拿到第 i 个等分点）—— 这条正是"顺序 = 上下序"的机械形式；
 *       ③ **交叉数不增**：现状口径（父端共用中点）与本口径各算一遍**真贝塞尔**相交对数；
 *          且**同一条判据要能红**：把口径切成"按 id 字典序分散"（`MM.setLineEndpointScheme('id')`）
 *          ⇒ 交叉数**必须 > 0**（判别力：这条判据不是恒真的）。
 *       ④ 真帧像素：在屏取样点能在**真帧**里数到连线层的墨（沿用域 05/47 已验过的像素判据，
 *          **不用 DOM 属性自证** ✗；同一张帧同时给判据与证据 ✓）。
 *
 *  乙 **e · 同级重排**（`renderer/contextmenu.js` 的入口 + `renderer/app-view.js` 的拖动与 clamp
 *     + `renderer/app-actions.js` 的写口 + `main.js` 的 IPC）：
 *       ① **拖动期间盘上零写入**（sha256 逐字节不变）+ **序列化文本逐字节不变**（这一档一个偏移桶都不写）；
 *       ② 松手 ⇒ 盘上顺序 == 期望顺序（读**盘上原文**现算，不看命令回显）；
 *       ③ **除 `children` 顺序外没有任何字节变化**（整文件 sha256 不同，但"结构形状 + meta"逐字段相同
 *          —— 差异白名单为空）；顺序那一处**逐条点名**（谁从第几位到了第几位）；
 *       ④ **父子关系不变**（每个节点的父 id 逐个相同；只少"被拖节点在自己父下换了位置"这一处）；
 *       ⑤ **clamp**：把节点拖到列表**外**（最上面那条的再上面 / 最下面那条的再下面）
 *          ⇒ k 贴到 0 / 到上界（合法范围内的整数，不是非法值）；
 *       ⑥ 渲染顺序与数据顺序一致（子节点屏幕 cy 的排序 == 盘上 `children` 下标序）。
 *       ⑦ 结构性：这一档**不写偏移桶**（重排前后 `getTreeOffsets` / `getNodeOffsets` 都为空）。
 *
 *  丙 **e · 自由边不参与同级重排**（R5 修订加的那条边界）：夹具里给一个节点挂一条 `links[]`（自由边），
 *     重排它 ⇒ **边的条数与内容逐字节不变**、且 `children` 顺序照旧按期望变（自由边不在 `children` 里，
 *     重排不该碰它）。
 *
 *  丁 收尾：退出拖动模式、清重排残留 DOM、清偏移并落盘、开回原项目、复位确认桩。
 *
 * 判据纪律（与 36/37/42/43/45/46 同）：可见性一律 `document.elementFromPoint`（rect 只用来判几何）；
 * 动作一律**真鼠标**（`ctx.input.*` 走 Chromium 命中测试，不是 `dispatchEvent` 合成事件）；
 * 真值读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 在 `--smoke` 下指向临时副本）。
 * ⚠️ 夹具是本域自己写进沙箱的 `zz-` 项目（**不碰 comnet**）；写盘用 node 的 `writeFileSync`（无 BOM）。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const frameStats = require('../vision/frame-stats.js');

/** 沙箱夹具：root → t1 → { nf（**8 个叶子**的父，专给 d 的交叉数判据用）+ n1,n2,n3,n4（4 个同级，
 *  给 e 的重排留出"拖到第 k 位"的空间）} ；t2 → m1（独子，用来判"独子 ⇒ 父端仍是侧边中点，
 *  与改动前逐字节相同"）；n2 再挂一条**自由边** `links[]`（R5：自由边不参与同级重排）。
 *  ⚠️ 为什么 nf 要有 **8** 个叶子：判别力那一条要求"换成按 **id 字典序**分散 ⇒ 交叉数 **> 0**"，
 *  而小的/对称的扇出（4 个）可能一条都不相交 ⇒ 那条判据会**看起来是恒真**（第一版实测就是这么红的：
 *  `判别力(id 序)=0`）。8 个叶子 + id 序与上下序明显不同 ⇒ 必然相交（同一次现算的读数见报文）。 */
const P = 'zz-r2-lines-reorder';
const TOP = 't1';
const SIB_PARENT = 't1';
const SIB = ['n1', 'n2', 'n3', 'n4'];
const FAN_PARENT = 'nf';
const FAN = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
/** t1 的孩子（**现状**：扇出那一支也挂在 t1 下 ⇒ t1 的扇出是 5 条线，不是 4）。
 *  ⚠️ 这个常量是**夹具的读法**：t1 的扇出宽度由它定，别在断言里手抄数字 ✗。 */
/** t1 下的**全部孩子**（夹具原样顺序）：n1..n4 + nf。
 *  ⚠️ 这个常量是**夹具的读法**：扇出宽度与重排的"第几位"都由它定，别在断言里手抄数字 ✗。 */
const T1_KIDS = ['n1', 'n2', 'n3', 'n4', FAN_PARENT];
/** 夹具的节点数（现算：root + t1 + t2 + n1..n4 + nf + f1..f8 + m1） */
const NODE_COUNT = 1 + 2 + 4 + 1 + 8 + 1;
/** 期望的**可见线端条数** = 每个非 root 节点一条线，**减去主题模式下被跳过的那两条**
 *  （父是 root 的线：`show_lines` 里 `fdHideRootLinks && t.parent.isroot ⇒ __mmSkippedLines++`）。
 *  ⚠️ 这个算式**当场复核**（断言里同时读 `__mmSkippedLines`）—— 手抄一个数字会静静过期 ✗。 */
const EDGE_COUNT = (NODE_COUNT - 1) - 2;
/** 重排目标：n1（原来在第 1 位）—— 拖到最上面 / 最下面各一次，判 clamp 的两端 */
const MOVE_ID = 'n1';
const LINKS_NODE = 'n2';           // 挂自由边的那个节点（R5 边界）
const FREE_LINK = { project: P, id: 't2', caption: '自由边：不是父子边' };

let PROJECT_WHEN_ENTERED = '';
let STUB_INSTALLED = false;

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到盘上真值');
  return d;
}
const projectFile = (name) => path.join(projectsDir(), name, name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const PAINT = { delayMs: 120 };
const SETTLE = 'new Promise(function (r) { requestAnimationFrame(function () { r(1); }); })';

async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await ctx.input.settle({ delayMs: 160 });
  return ok;
}
async function stubConfirm(ctx, answer) {
  await ctx.exec('window.MMApp.setConfirmStub(' + (answer === null ? 'null' : 'function () { return ' + (answer ? 'true' : 'false') + '; }') + ')');
  STUB_INSTALLED = answer !== null;
}
const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');
const save = (ctx) => ctx.exec('(async function () { return await window.MMApp.save(); })()');

/** 跑一段渲染层脚本，出错时**带上是哪一步**（照域 46 的 step 先例）：Electron 的报文只有一句
 *  `Script failed to execute…`（不带位置），只报那一句等于没报 ✗ —— 断言得自己点名 ✗。 */
async function stepExec(ctx, label, js) {
  try { return await ctx.exec(js); }
  catch (err) { throw new Error('第「' + label + '」步失败：' + ((err && err.message) || err)); }
}
const reorderState = (ctx) => stepExec(ctx, '读重排现状', 'JSON.stringify(window.MMApp.reorderState())')
  .then((s) => { try { return JSON.parse(s); } catch (e) { return null; } });

/** 夹具：与 CLI `init` + `add` 同形状（直接写盘 ⇒ 确定性、不拖慢链）。
 *  全部 `expanded: true`：本域要"所有 8 个节点都在屏上"（几何判据的地基）。 */
function writeFixture() {
  const dir = path.join(projectsDir(), P);
  fs.mkdirSync(dir, { recursive: true });
  const node = (id, topic, children, links) => {
    const o = { id: id, topic: topic, expanded: true };
    if (children) o.children = children;
    if (links) o.links = links;
    return o;
  };
  const data = {
    meta: { name: P, author: '', version: '0.0.0', formatVersion: 2, rootMode: 'themes' },
    format: 'node_tree',
    data: node('root', 'R2 期 3 夹具', [
      node(TOP, '主题甲', [
        node('n1', '甲-1'),
        node(LINKS_NODE, '甲-2', null, [FREE_LINK]),
        node('n3', '甲-3'),
        node('n4', '甲-4'),
        node(FAN_PARENT, '甲-扇出', FAN.map((id, i) => node(id, '叶-' + (i + 1))))
      ]),
      node('t2', '主题乙', [node('m1', '乙-1')])
    ])
  };
  fs.writeFileSync(projectFile(P), JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

/* ---------------- 盘上真值读数（全部现算，不看命令回显） ---------------- */

/** 全树 id → 父 id（含 root 的父为 null） */
function parentsOf(raw) {
  const out = {};
  (function walk(n, pid) {
    out[n.id] = pid;
    (n.children || []).forEach((c) => walk(c, n.id));
  })(raw.data, null);
  return out;
}
function childrenIds(raw, id) {
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (n.id === id) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(raw.data);
  return hit && hit.children ? hit.children.map((c) => c.id) : null;
}
function logsOf(raw) {
  const out = {};
  (function walk(n) {
    out[n.id] = (n.links === undefined || n.links === null) ? null : n.links;
    (n.children || []).forEach(walk);
  })(raw.data);
  return out;
}

/** 自由边（`links[]`）的读数：**有边的节点**逐条列出（`{节点: [边…]}`）+
 *  "谁带边"的集合。用来判"重排只动 children 顺序、不碰自由边"。
 *  ⚠️ 只列**真有边**的节点：那一侧才是判据要看的（把一堆 null 也塞进来，
 *  报文会淹掉真差异，且"有没有边"这件事本身反而看不出）。 */
function linkEdges(raw) {
  const out = {};
  (function walk(n) {
    if (Array.isArray(n.links) && n.links.length) out[n.id] = n.links;
    (n.children || []).forEach(walk);
  })(raw.data);
  return out;
}

/** 自由边的**逐项差异**（空数组 = 逐项相同）；没有边也如实返回"有 0 个带边节点" */
function linkDiff(before, after) {
  const problems = [];
  const ka = Object.keys(before).sort();
  const kb = Object.keys(after).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) {
    problems.push('带边的节点集合变了：' + JSON.stringify(ka) + ' → ' + JSON.stringify(kb));
  }
  ka.forEach((id) => {
    if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) {
      problems.push('节点 ' + id + ' 的边变了：' + JSON.stringify(before[id]) + ' → ' + JSON.stringify(after[id]));
    }
  });
  return problems;
}

/** **结构形状**（把 id 换成占位符）：用来判"只有顺序变了、别的字段一个字节都没动"。
 *  为什么不能只用整文件 sha256 比：sha256 只能告诉你"变了"；这条判据要的是"变了**哪些**"——
 *  形状 + 逐字段值都相同、只有 children 数组顺序不同 ⇒ 白名单为空（其余字节零变化）。 */
function structuralShape(raw) {
  const scrub = (n) => {
    const o = {};
    Object.keys(n).forEach((k) => {
      if (k === 'id' || k === 'children') return;
      o[k] = n[k];
    });
    o.children = (n.children || []).map(scrub);
    return o;
  };
  const top = {};
  Object.keys(raw).forEach((k) => {
    if (k === 'data') return;
    if (k === 'meta') {
      const m = {};
      Object.keys(raw.meta).forEach((k2) => { if (k2 !== 'name') m[k2] = raw.meta[k2]; });
      top.meta = m;
      return;
    }
    top[k] = raw[k];
  });
  top.data = scrub(raw.data);
  top.data.id = '<root>';
  return top;
}

/** 找出"只有兄弟顺序不同"的那些节点，并逐条点名（谁从第几位到了第几位）。
 *  返回 `{ ok, detail, moves }`：`ok:false` ⇒ 除顺序外还有别的差异（白名单非空 ⇒ 判红）。 */
function orderOnlyDiff(before, after) {
  const moves = [];
  const problems = [];
  const cmp = (a, b, pathStr) => {
    if (!a || !b) { problems.push(pathStr + '：一侧缺失'); return; }
    const ka = Object.keys(a).filter((k) => k !== 'children').sort();
    const kb = Object.keys(b).filter((k) => k !== 'children').sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) { problems.push(pathStr + '：字段集不同 ' + JSON.stringify(ka) + ' vs ' + JSON.stringify(kb)); return; }
    ka.forEach((k) => {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(pathStr + '：字段 ' + k + ' 变了');
    });
    const ca = (a.children || []).map((c) => c.id);
    const cb = (b.children || []).map((c) => c.id);
    const setA = ca.slice().sort().join(','), setB = cb.slice().sort().join(',');
    if (setA !== setB) { problems.push(pathStr + '：孩子集合变了（' + setA + ' → ' + setB + '）'); return; }
    if (ca.join(',') !== cb.join(',')) {
      ca.forEach((id, i) => {
        const j = cb.indexOf(id);
        if (i !== j) moves.push({ at: pathStr, id: id, from: i, to: j });
      });
    }
    ca.forEach((id) => {
      const na = (a.children || []).find((c) => c.id === id);
      const nb = (b.children || []).find((c) => c.id === id);
      cmp(na, nb, pathStr + '/' + id);
    });
  };
  cmp(before.data, after.data, 'root');
  return { ok: problems.length === 0, problems: problems, moves: moves };
}

/* ---------------- 线端读数（渲染层现读数 + **独立重算**对照） ---------------- */

/** 产品读出来的端点（唯一真源 `window.__mmLineEndpoints`）+ 每个节点的边框（`MM.nodeBorderRect`） */
const ENDPOINTS_JS = `(function () {
  var jm = window.MMApp.getState().jm;
  var rects = {};
  Object.keys(jm.mind.nodes).forEach(function (id) {
    var el = document.querySelector('jmnode[nodeid="' + id + '"]');
    if (el) rects[id] = window.MM.nodeBorderRect(el, id);
  });
  var vis = {};
  document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    vis[el.getAttribute('nodeid')] = (r.width > 0 && r.height > 0) ? { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  return JSON.stringify({ eps: window.__mmLineEndpoints || [], rects: rects, vis: vis,
    skipped: window.__mmSkippedLines, unknown: window.__mmEndpointUnknown || [],
    scheme: window.MM.getLineEndpointScheme(), dpr: window.devicePixelRatio || 1 });
})()`;

/** 判据①：线端与**独立重算**逐条一致 —— 端点在不在边框上、是不是相邻侧、
 *  父端是不是"这条侧边的等分点"这一族（独子 ⇒ 中点）。
 *  ⚠️ 这里**不重算** `lineParentPoints`（那是被验对象），只按"等分点"这一个**独立**定义核对。 */
function checkEndpoints(reading) {
  const { eps, rects } = reading;
  const bad = [];
  eps.forEach((L) => {
    const pb = rects[L.parent], cb = rects[L.child];
    if (!pb || !cb) { bad.push(L.child + '：取不到边框'); return; }
    const isLeft = cb.cx < pb.cx;
    const wantPx = isLeft ? pb.left : pb.right;
    const wantCx = isLeft ? cb.right : cb.left;
    if (Math.abs(L.p.x - wantPx) > 0.01) { bad.push(L.child + '：父端 x ' + L.p.x + ' ≠ 相邻侧 ' + wantPx); return; }
    if (Math.abs(L.c.x - wantCx) > 0.01) { bad.push(L.child + '：子端 x ' + L.c.x + ' ≠ 相邻侧 ' + wantCx); return; }
    if (L.p.y < pb.top - 0.01 || L.p.y > pb.bottom + 0.01) { bad.push(L.child + '：父端 y 出了父边框'); return; }
    if (L.c.y < cb.top - 0.01 || L.c.y > cb.bottom + 0.01) { bad.push(L.child + '：子端 y 出了子边框'); return; }
    if (Math.abs(L.c.y - cb.cy) > 0.01) { bad.push(L.child + '：子端不是子节点侧边中点'); }
  });
  // 父端落点族：同侧扇出 n 个孩子 ⇒ 父端 y 必须等于 top + h*(rank+1)/(n+1) 里的某一个
  const byParent = {};
  eps.forEach((L) => { (byParent[L.parent] = byParent[L.parent] || []).push(L); });
  const fans = [];
  Object.keys(byParent).forEach((pid) => {
    const list = byParent[pid];
    if (list.length < 2) return;
    const pb = rects[pid];
    if (!pb) return;
    const ys = list.map((L) => L.p.y).sort((a, b) => a - b);
    const n = list.length;
    const want = [];
    for (let i = 1; i <= n; i++) want.push(pb.top + (pb.bottom - pb.top) * i / (n + 1));
    const onLattice = ys.every((y) => want.some((w) => Math.abs(y - w) < 0.02));
    const distinct = new Set(list.map((L) => L.p.y.toFixed(2))).size;
    // 名次正序：按子 cy 排序后的第 i 个，父端 y 必须是第 (i+1) 个等分点
    const order = list.slice().sort((a, b) => (a.p.y - b.p.y));
    const byChildCy = list.slice().sort((a, b) => {
      const ca = rects[a.child], cb2 = rects[b.child];
      return (ca.cy - cb2.cy);
    });
    const rankOk = byChildCy.every((L, i) => Math.abs(L.p.y - want[i]) < 0.02);
    fans.push({ parent: pid, n: n, distinct: distinct, onLattice: onLattice, rankOk: rankOk });
  });
  return { bad: bad, fans: fans, count: eps.length };
}

/** 交叉数（**纯几何**，真贝塞尔相交对数）：与产品实现无关的一份独立计算。
 *  共父子端点的两条线**不算**打架（它们本来就接着同一个节点）。 */
function bez(p0, p1) {
  const dx = p1.x - p0.x;
  return [{ x: p0.x, y: p0.y }, { x: p0.x + dx * 2 / 3, y: p0.y },
    { x: p1.x - dx * 2 / 3, y: p1.y }, { x: p1.x, y: p1.y }];
}
function at(c, t) {
  const u = 1 - t;
  return { x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y };
}
function bbox(c) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const p = at(c, i / 40);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function split(c) {
  const p01 = mid(c[0], c[1]), p12 = mid(c[1], c[2]), p23 = mid(c[2], c[3]);
  const p012 = mid(p01, p12), p123 = mid(p12, p23), m = mid(p012, p123);
  return [[c[0], p01, p012, m], [m, p123, p23, c[3]]];
}
function segInt(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function bezHit(c1, c2, depth, b1, b2) {
  const d = depth || 0;
  const A = b1 || bbox(c1), B = b2 || bbox(c2);
  if (A.x1 < B.x0 - 1e-9 || B.x1 < A.x0 - 1e-9 || A.y1 < B.y0 - 1e-9 || B.y1 < A.y0 - 1e-9) return false;
  const sz = Math.max(Math.max(A.x1 - A.x0, A.y1 - A.y0), Math.max(B.x1 - B.x0, B.y1 - B.y0));
  if (d >= 16 || sz < 0.8) return segInt(at(c1, 0.25), at(c1, 0.75), at(c2, 0.25), at(c2, 0.75));
  const [a1, a2] = split(c1), [b1s, b2s] = split(c2);
  return bezHit(a1, b1s, d + 1, bbox(a1), bbox(b1s)) || bezHit(a2, b1s, d + 1, bbox(a2), bbox(b1s))
    || bezHit(a1, b2s, d + 1, bbox(a1), bbox(b2s)) || bezHit(a2, b2s, d + 1, bbox(a2), bbox(b2s));
}
/** 独立重算交叉数；`mode` = 'cur'（现状口径：父端 = 父的侧边中点）/ 'endpoints'（产品读数） */
function countCrossings(eps, rects, mode) {
  const segs = eps.map((L) => {
    const pb = rects[L.parent], cb = rects[L.child];
    const p = (mode === 'cur') ? { x: (cb.cx < pb.cx ? pb.left : pb.right), y: pb.cy } : { x: L.p.x, y: L.p.y };
    return { parent: L.parent, child: L.child, p: p, c: { x: L.c.x, y: L.c.y } };
  });
  let n = 0;
  const who = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i], B = segs[j];
      if (A.p.x === B.p.x && A.p.y === B.p.y && A.parent === B.parent) continue;   // 共父端点：不叫打架
      if (bezHit(bez(A.p, A.c), bez(B.p, B.c), 0)) { n++; if (who.length < 5) who.push(A.child + '×' + B.child); }
    }
  }
  return { n: n, who: who };
}

/** CSS 像素矩形 → 设备像素（截图是设备像素；与 `scripts/vision/roi-assertions.js` 同一口径 ✓） */
function toDev(rect, dpr) {
  return { x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) };
}

/** 某个节点中心的屏幕坐标（真鼠标要用它） */
const pointOf = (ctx, id) => ctx.exec('(function () { var el = document.querySelector(\'jmnode[nodeid="' + id + '"]\');'
  + ' if (!el) return null; var r = el.getBoundingClientRect();'
  + ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),'
  + ' l: Math.round(r.left), t: Math.round(r.top), rr: Math.round(r.right), b: Math.round(r.bottom) }; })()');

/** 渲染顺序读数：每个可见节点的屏幕 cy（用来判"渲染顺序 == 数据顺序"） */
const ORDER_JS = (ids) => `(function () {
  var out = {};
  ${JSON.stringify(ids)}.forEach(function (id) {
    var el = document.querySelector('jmnode[nodeid="' + id + '"]');
    if (!el) { out[id] = null; return; }
    var r = el.getBoundingClientRect();
    out[id] = (r.width > 0) ? Math.round(r.top + r.height / 2) : null;
  });
  return JSON.stringify(out);
})()`;

const assertions = [

  {    name: '甲 d·线端按子序分散：产品读数与**独立重算**逐条一致（端点在节点边框上、在相邻侧、父端是这条边框的等分点、子端是子节点侧边中点）；同侧扇出 ≥ 3 的父**父端互不重合**且**上下序 ⇒ 名次正序**；交叉数（真贝塞尔）现状口径 0 → 本口径 0（不增）；判别力：切成按 id 字典序分散 ⇒ 交叉数必须 > 0；真帧像素里数得到连线层的墨',
    run: async (ctx) => {
      await stubConfirm(ctx, true);
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return (s && s.project && s.project.name) || ""; })()');
      const data = writeFixture();
      const h0 = sha256(readRaw(P));
      const opened = await openProject(ctx, P);
      if (opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**（不是通过）' };
      const jm = 'window.MMApp.getState().jm';
      await ctx.exec('(function () { ' + jm + '.expand_all(); ' + jm + '.view.show_lines(); return true; })()');
      await ctx.input.settle(SETTLE);
      // —— ① 端点逐条一致（产品读数 vs 独立重算）——
      const r1raw = await ctx.exec(ENDPOINTS_JS);
      const r1 = JSON.parse(r1raw);
      const chk = checkEndpoints(r1);
      const byParentN = {};
      r1.eps.forEach((L) => { (byParentN[L.parent] = byParentN[L.parent] || []).push(L.child); });
      const fanT1 = r1.eps.filter((L) => L.parent === SIB_PARENT).map((L) => L.child);
      const distinctT1 = new Set(r1.eps.filter((L) => L.parent === SIB_PARENT).map((L) => L.p.y.toFixed(2))).size;
      const t1Rect = r1.rects[SIB_PARENT];
      // 独子那一档（t2 → m1）：父端必须仍是**侧边中点**（与改动前逐字节相同）
      const m1 = r1.eps.filter((L) => L.child === 'm1')[0] || null;
      const m1MidOk = !!m1 && !!r1.rects.m1 && !!r1.rects.t2
        && Math.abs(m1.p.y - r1.rects.t2.cy) < 0.01;
      // 现状口径（父端共用中点）—— 用来判"交叉数不增"
      const curCross = countCrossings(r1.eps, r1.rects, 'cur');
      const newCross = countCrossings(r1.eps, r1.rects, 'endpoints');
      // —— ② 判别力：把名次**反过来**（`reverse`）⇒ 判据必须能红 ——
      const switched = await ctx.exec('window.MM.setLineEndpointScheme("reverse")');
      await ctx.exec('(function () { ' + jm + '.view.show_lines(); return true; })()');
      const r2 = JSON.parse(await ctx.exec(ENDPOINTS_JS));
      const idCross = countCrossings(r2.eps, r2.rects, 'endpoints');
      const idDistinctT1 = new Set(r2.eps.filter((L) => L.parent === SIB_PARENT).map((L) => L.p.y.toFixed(2))).size;
      const idChk = checkEndpoints(r2);     // 注入之后**仍然落在边框上**（只是名次被倒过来）
      const back = await ctx.exec('window.MM.setLineEndpointScheme("order")');
      await ctx.exec('(function () { ' + jm + '.view.show_lines(); return true; })()');
      const r3 = JSON.parse(await ctx.exec(ENDPOINTS_JS));
      const backCross = countCrossings(r3.eps, r3.rects, 'endpoints');
      // —— ③ 真帧：在屏取样点能数到墨（同一张帧同时给判据与证据）——
      const ptT1 = await pointOf(ctx, SIB_PARENT);
      const ptN4 = await pointOf(ctx, 'n4');
      let inkRead = null, frame = null;
      if (ptT1 && ptN4) {
        // 取样带：父的右边框往右 60px、纵向覆盖 4 个子节点的 cy 区间（连线一定穿过这一带）
        const cyTop = Math.min(ptT1.y, ptN4.y);
        const cyBot = Math.max(ptT1.y, ptN4.y);
        const band = { x: ptT1.rr - 2, y: cyTop, width: 62, height: Math.max(40, cyBot - cyTop) };
        const img = await ctx.input.capture();
        const size = img.getSize();
        inkRead = frameStats.scanRegion(img, toDev(band, r1.dpr), { predicate: frameStats.nonBackgroundPredicate() });
        frame = { w: size.width, h: size.height, bytes: img.toPNG().length, band: band,
          sha256: crypto.createHash('sha256').update(img.toPNG()).digest('hex').slice(0, 16) };
      }
      const h1 = sha256(readRaw(P));   // 只读这一档不许动盘（连 show_lines 都不写数据）
      const fanEps = r1.eps.filter((L) => L.parent === FAN_PARENT);
      const checks = [
        ['夹具打开成功（' + NODE_COUNT + ' 个节点）', opened === true],
        ['线端条数 == 非 root 节点数 − 主题模式跳过的那两条（现场复核跳过读数）',
          r1.eps.length === EDGE_COUNT && r1.skipped === 2],
        ['取不到边框的孩子数 = 0（采不到真值要如实报，不许当 0 条）', (r1.unknown || []).length === 0],
        ['端点逐条在边框上 / 在相邻侧 / 子端是侧边中点（独立重算）', chk.bad.length === 0],
        ['父端都落在"这条侧边的等分点"这一族里', chk.fans.every((f) => f.onLattice === true)],
        ['上下序 ⇒ 名次正序（第 i 个孩子拿第 i 个等分点）', chk.fans.every((f) => f.rankOk === true)],
        ['同侧扇出 ' + T1_KIDS.length + ' 个的父（t1）：父端互不重合（' + T1_KIDS.length + ' 个不同点）',
          fanT1.length === T1_KIDS.length && distinctT1 === T1_KIDS.length],
        ['同侧扇出 8 个的父（nf）：父端互不重合（8 个不同点）', fanEps.length === 8
          && new Set(fanEps.map((L) => L.p.y.toFixed(2))).size === 8],
        ['独子那一档父端仍是侧边中点（默认档逐字节不变的那一档）', m1MidOk === true],
        ['交叉数不增：现状口径 ' + curCross.n + ' → 本口径 ' + newCross.n, newCross.n <= curCross.n],
        ['判别力：把名次整个反过来（注入 `reverse`）⇒ 交叉数 > 0（这条判据不是恒真）',
          switched === 'reverse' && idCross.n > 0],
        ['判别力对照组：注入之后父端**仍然**都在边框上（倒过来的是名次，不是真源）',
          idChk.bad.length === 0 && idDistinctT1 === T1_KIDS.length],
        ['切回默认口径后交叉数回到 0（复绿）', back === 'order' && backCross.n === 0],
        ['真帧里数得到连线层的墨（同一张帧给判据与证据）', !!inkRead && inkRead.ok === true && inkRead.hits > 200],
        ['只读这一档盘上零写入', h1 === h0],
        ['夹具确实是 ' + NODE_COUNT + ' 个节点', (function () { let n = 0; (function w(x) { n++; (x.children || []).forEach(w); })(data.data); return n; })() === NODE_COUNT]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '线端 ' + r1.eps.length + ' 条 · 逐条核对不通过 ' + chk.bad.length + ' 条'
          + (chk.bad.length ? ' ✗ ' + chk.bad.slice(0, 4).join(' / ') : '')
          + ' · 扇出表=' + JSON.stringify(chk.fans)
          + ' · t1 父端 y（4 个孩子的）=' + JSON.stringify(r1.eps.filter((L) => L.parent === SIB_PARENT).map((L) => Math.round(L.p.y * 100) / 100))
          + ' t1 边框 y=[' + Math.round(t1Rect.top) + ',' + Math.round(t1Rect.bottom) + ']（等分点应为 '
          + JSON.stringify([1, 2, 3, 4].map((i) => Math.round((t1Rect.top + (t1Rect.bottom - t1Rect.top) * i / 5) * 100) / 100)) + '）'
          + ' · 独子 m1 父端 y=' + (m1 ? Math.round(m1.p.y) : 'null') + '（父中点 y=' + (r1.rects.t2 ? Math.round(r1.rects.t2.cy) : 'null') + '）'
          + ' · 交叉数 现状口径=' + curCross.n + ' 本口径=' + newCross.n + ' 判别力(reverse)=' + idCross.n
          + (idCross.who.length ? '（例 ' + idCross.who.join('/') + '）' : '') + ' 切回后=' + backCross.n
          + ' · 扇出 8 条的父端 y=' + JSON.stringify(fanEps.map((L) => Math.round(L.p.y * 10) / 10))
          + ' · 真帧 ' + JSON.stringify(frame) + ' 墨=' + JSON.stringify(inkRead)
          + ' · 盘上零写入=' + (h1 === h0) + ' · scheme 三态=' + [r1.scheme, r2.scheme, r3.scheme].join('→')
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '乙 e·同级重排（真鼠标）：拖动期间盘上零写入 + 序列化逐字节不变（不写偏移桶）；松手 ⇒ 盘上顺序 == 期望顺序；除 children 顺序外**没有任何字节变化**（结构形状 + meta 逐字段相同、顺序那一处逐条点名）；父子关系不变；clamp 两端；渲染顺序 == 数据顺序',
    run: async (ctx) => {
      // ⚠️ **夹具复位**：乙 会真的改盘上顺序，丙 却要求"起点 == 夹具原样" ⇒ 每段开始都重写一次
      // 夹具（来源只有一处 = `writeFixture`），否则第二段跑在上一段的残留上（且是**静默**的）。
      writeFixture();
      const opened = await stepExec(ctx, '打开夹具', 'window.MMApp.openProject(' + JSON.stringify(P) + ')');
      if (opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**（不是通过）' };
      await stepExec(ctx, '展开全部', '(function () { window.MMApp.getState().jm.expand_all(); return true; })()');
      await ctx.input.settle(PAINT);
      const rawBefore = JSON.parse(readRaw(P));
      const h0 = sha256(readRaw(P));
      const orderBefore = childrenIds(rawBefore, SIB_PARENT);
      const parentsBefore = parentsOf(rawBefore);
      const linksBefore = linkEdges(rawBefore);
      const textBefore = await stepExec(ctx, '读序列化文本', 'JSON.stringify(window.MMApp.serializeTree(), null, 2)');
      const bucketsBefore = await stepExec(ctx, '读偏移两桶', '(function () { return JSON.stringify({ t: window.MMApp.getTreeOffsets(), n: window.MMApp.getNodeOffsets() }); })()');
      // —— 入口：右键目标节点 ⇒ 菜单里有「拖动到同级第几位」⇒ 真鼠标点它 ——
      // ⚠️ 先把目标**摆进面板中部再右键**（两条都是既有经验，不是本域的特殊要求）：
      //   · 右键菜单是**向下展开**的；节点贴在面板上缘时菜单会向上翻到视口外 ⇒ `elementFromPoint`
      //     直接返回 null（域 46 丙记录的正是这一族）；摆到中部就不必依赖上翻；
      //   · 「命中测试」先过一遍：真鼠标按在**面板裁切之外**的点上，节点收不到事件（域 37/46 同理）。
      const centered = await stepExec(ctx, '把目标摆进面板中部', '(function () {'
        + ' var el = document.querySelector(\'jmnode[nodeid="' + MOVE_ID + '"]\');'
        + ' if (!el) return null;'
        + ' var p = window.MM.fdPanel().getBoundingClientRect();'
        + ' var r = el.getBoundingClientRect();'
        + ' var wantX = p.left + (p.right - p.left) * 0.35, wantY = p.top + (p.bottom - p.top) * 0.3;'
        + ' var pan = window.MMApp.getPanState();'
        + ' window.MM.setViewTransform({ x: pan.x + (wantX - (r.left + r.width / 2)),'
        + '   y: pan.y + (wantY - (r.top + r.height / 2)), s: pan.s });'
        + ' return true; })()');
      await ctx.input.settle(PAINT);
      const pt = await pointOf(ctx, MOVE_ID);
      if (!pt) return { ok: false, text: '目标节点不在屏上（' + MOVE_ID + '）⇒ **未验证**：面板/展开状态不对' };
      const hittable = await stepExec(ctx, '目标中心命中测试',
        '(function () { var el = document.querySelector(\'jmnode[nodeid="' + MOVE_ID + '"]\');'
        + ' var r = el.getBoundingClientRect();'
        + ' var top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));'
        + ' return JSON.stringify({ self: !!top && (top === el || el.contains(top)), at: !!top,'
        + '   rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }); })()');
      await ctx.input.drag(pt, pt, undefined, { button: 'right', stepDelayMs: 0 });
      await ctx.input.settle(PAINT);
      const menu = await stepExec(ctx, '读右键菜单', '(function () { var m = document.getElementById("ctx-menu");'
        + ' if (!m || m.style.display === "none") return { items: [], why: "菜单没弹出来" };'
        + ' return { items: Array.prototype.slice.call(m.querySelectorAll(".ctx-item")).map(function (e) { return e.textContent; }) }; })()');
      const entryGone = !(menu.items || []).some((t) => t.indexOf('拖动到同级第几位') >= 0);
      /* ⚠️ 读完菜单**必须关掉它**：改前是点击菜单项顺手关掉的（openMenu 的 click 处理器里有 closeMenu），
       * 现在改成直接调 API ⇒ 没人关它了 ⇒ 菜单会一直挡在画布上（域 46 甲实测踩到同一件事）。 */
      await stepExec(ctx, '关掉右键菜单', '(function () { if (window.MMContextMenu) window.MMContextMenu.closeMenu(); return 1; })()');
      /* 2026-10-33 批4：右键菜单里那四条拖动入口已按用户 2026-10-31「移除拖动模式」摘除
       * ⇒ 进重排档直接从 API 走（`setDragMode` 那一族**一行没删**）。改前那两跳是
       * "量菜单项命中 + 真鼠标点它"；现在换成"读一遍菜单**证明那一条不在**（entryGone）+ 直接调 API"，
       * 两者合起来比改前更强：改前只能证明"点得到"，证明不了"入口有没有别处还开着"。 */
      await stepExec(ctx, '直接调 API 进重排档',
        'window.MMApp.setDragMode(true, ' + JSON.stringify(MOVE_ID) + ', { mode: "reorder" }); 1');
      await ctx.input.settle(PAINT);
      // —— 拖动：从 n1 往列表外面拖（clamp 的两端各一次；落点见下面那段 ⚠️）——
      const ptN1 = await pointOf(ctx, MOVE_ID);
      if (!ptN1) return { ok: false, text: '目标节点不在屏上（' + MOVE_ID + '）⇒ **未验证**：面板/展开状态不对' };
      const entered = await reorderState(ctx);
      /* ⚠️ **落点必须在"按下之后"现量**（本域踩过的两个坑，都是同一件事的两面）：
       *   · 第一版拿**按下之前**量到的 `ptN1.y` 加减常数 ⇒ 按下那一刻 jsMind 重排一次
       *     （父的纵向居中）+ 本工程的「重排锚点保持」补偿一次画布平移 ⇒ 兄弟的屏幕 cy
       *     在按下前后**整体挪掉几百像素**，落点根本不在列表上方（实测 `drop.index` 与期望不符）；
       *   · 第二版改成"按下之前量兄弟 cy" ⇒ 仍然错，因为**面板本身**也会在选中之后重新定位
       *     （浮层重排）⇒ 同一批节点的 cy 又变了一次。
       *  ⇒ 唯一稳的顺序：**先按下 → 等一拍 → 再量 cy → 由它算落点 → moveTo → 量读数 → 松手**。
       *  （这不是"迁就测试"：用户看到的也正是"按下去那一刻整屏会重新落位"，落点当然按**那一刻**的
       *    位置算 ✓） */
      await ctx.input.mouseDown(ptN1);
      await ctx.input.settle(PAINT);
      const sibCyBefore = JSON.parse(await stepExec(ctx, '读兄弟屏幕位置（按下之后）', ORDER_JS(T1_KIDS)));
      const cys = Object.keys(sibCyBefore).map((k) => sibCyBefore[k]).filter((v) => typeof v === 'number');
      const ptTop = (ptN1 && cys.length) ? { x: ptN1.x, y: Math.min.apply(null, cys) - 120 } : null;
      const ptBottom = (ptN1 && cys.length) ? { x: ptN1.x, y: Math.max.apply(null, cys) + 160 } : null;
      let dragState = null, ghostShown = null, clampDown = null;
      let rawMid = null, orderMid = null;
      if (ptN1 && ptBottom) {
        // ① 拖到**最下面那条之下** ⇒ k == 上界（贴到最后）
        await ctx.input.moveTo(ptBottom);
        await ctx.input.settle(PAINT);
        dragState = await reorderState(ctx);
        const sibCyMid = await stepExec(ctx, '读兄弟屏幕位置（拖动中）', ORDER_JS(T1_KIDS));
        dragState = Object.assign({}, dragState, { pointerY: ptBottom.y, sibCy: JSON.parse(sibCyMid) });
        ghostShown = await stepExec(ctx, '读预览元素', '(function () { var g = document.getElementById("tree-reorder-ghost");'
          + ' var mk = document.getElementById("tree-reorder-mark");'
          + ' return { ghost: !!g, ghostTf: g ? String(g.style.transform) : null,'
          + '   mark: !!mk && mk.style.display !== "none", markTop: mk ? String(mk.style.top) : null }; })()');
        // —— 拖动期间：盘上零写入 + 序列化逐字节不变 + 偏移桶一个都没写 ——
        const hDrag = sha256(readRaw(P));
        const textDrag = await stepExec(ctx, '读拖动中的序列化文本', 'JSON.stringify(window.MMApp.serializeTree(), null, 2)');
        const bucketsDrag = await stepExec(ctx, '读拖动中的偏移两桶', '(function () { return JSON.stringify({ t: window.MMApp.getTreeOffsets(), n: window.MMApp.getNodeOffsets() }); })()');
        dragState = Object.assign({}, dragState, { diskSame: hDrag === h0, textSame: textDrag === textBefore,
          bucketsSame: bucketsDrag === bucketsBefore });
        await ctx.input.mouseUp(ptBottom);
        await ctx.input.settle(PAINT);
        await ctx.input.settle({ delayMs: 900 });     // 等 IPC → CLI 写盘 → 回读重建落定
        // 第一次重排**真的落了盘**的那一份（白名单/点名/渲染顺序都对着它判 —— 见下面那一段说明）
        rawMid = JSON.parse(readRaw(P));
        orderMid = childrenIds(rawMid, SIB_PARENT);
        // ② 换一端：**先重新进重排档**（写盘之后的整树重建会把界面带回普通态 —— 这也是用户的真实路径：
        //    "再拖一次"就得再点一次那一条菜单项），再把它摆回面板中部，落点按按下前现量的兄弟 cy 算。
        await stepExec(ctx, '第二次拖动前·重新进重排档',
          'window.MMApp.setDragMode(true, ' + JSON.stringify(MOVE_ID) + ', { mode: "reorder" })');
        await ctx.input.settle(PAINT);
        await stepExec(ctx, '把目标重新摆进面板中部', '(function () {'
          + ' var el = document.querySelector(\'jmnode[nodeid="' + MOVE_ID + '"]\');'
          + ' if (!el) return false;'
          + ' var p = window.MM.fdPanel().getBoundingClientRect();'
          + ' var r = el.getBoundingClientRect();'
          + ' var wantX = p.left + (p.right - p.left) * 0.35, wantY = p.top + (p.bottom - p.top) * 0.3;'
          + ' var pan = window.MMApp.getPanState();'
          + ' window.MM.setViewTransform({ x: pan.x + (wantX - (r.left + r.width / 2)),'
          + '   y: pan.y + (wantY - (r.top + r.height / 2)), s: pan.s });'
          + ' return true; })()');
        await ctx.input.settle(PAINT);
        const ptN1c = await pointOf(ctx, MOVE_ID);
        const sibCy2 = JSON.parse(await stepExec(ctx, '读兄弟屏幕位置（第二次拖动前）', ORDER_JS(T1_KIDS)));
        const cys2 = Object.keys(sibCy2).map((k) => sibCy2[k]).filter((v) => typeof v === 'number');
        const panel2 = await stepExec(ctx, '读面板矩形（第二次拖动前）',
          '(function () { var b = window.MM.fdPanel().getBoundingClientRect();'
          + ' return JSON.stringify([Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]); })()');
        const hit0 = await stepExec(ctx, '第二次拖动前·面板内任意点命中',
          '(function () { var b = window.MM.fdPanel().getBoundingClientRect();'
          + ' var x = Math.round((b.left + b.right) / 2), y = Math.round((b.top + b.bottom) / 2);'
          + ' var t = document.elementFromPoint(x, y);'
          + ' return t ? (t.tagName + (t.id ? "#" + t.id : "")) : "(null)"; })()');
        const hit2 = await stepExec(ctx, '第二次拖动前·目标中心命中测试',
          '(function () { var el = document.querySelector(\'jmnode[nodeid="' + MOVE_ID + '"]\');'
          + ' if (!el) return "no-el"; var r = el.getBoundingClientRect();'
          + ' var top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));'
          + ' return (!!top && (top === el || el.contains(top))) ? "hit" : "miss"; })()');
        if (ptN1c && cys2.length) {
          const top2 = { x: ptN1c.x, y: Math.min.apply(null, cys2) - 120 };
          await ctx.input.mouseDown(ptN1c);
          await ctx.input.settle(PAINT);
          const sibCy3 = JSON.parse(await stepExec(ctx, '读兄弟屏幕位置（第二次按下之后）', ORDER_JS(T1_KIDS)));
          const cys3 = Object.keys(sibCy3).map((k) => sibCy3[k]).filter((v) => typeof v === 'number');
          const top2b = { x: ptN1c.x, y: (cys3.length ? Math.min.apply(null, cys3) : top2.y) - 120 };
          await ctx.input.moveTo(top2b);
          await ctx.input.settle(PAINT);
          clampDown = await reorderState(ctx);
          clampDown = Object.assign({}, clampDown, { selfHit: hit2, panelHit: hit0, panel: panel2,
            pointerY: top2b.y, sibCy: sibCy3, pt: ptN1c });
          await ctx.input.mouseUp(top2b);
          await ctx.input.settle({ delayMs: 900 });
        }
      }
      const hAfter = sha256(readRaw(P));
      const rawAfter = JSON.parse(readRaw(P));
      const calls = JSON.parse(await stepExec(ctx, '读重排调用历史',
        'JSON.stringify(window.MM.__reorderCalls || [])'));
      const orderAfter = childrenIds(rawAfter, SIB_PARENT);
      const expectAfter = ['n2', 'n3', 'n4', FAN_PARENT, MOVE_ID];   // ① 拖到"最下面那条之下"⇒ 落到最后
      const expectOrder = expectAfter;
      const expectFinal = T1_KIDS.slice();   // ② 再拖到"最上面那条之上"⇒ 回到夹具原样（k=0 不是 no-op：它真的把 n1 挪回第 1 位）
      /* 两份对照（**为什么要两份**）：① 第一次重排之后那一份（`rawMid`）与夹具原样**真的不同**
       * ⇒ 白名单/逐条点名/渲染顺序都对着它判，判据才有东西可判；② 最后一次重排之后那一份
       * 应当回到夹具原样（第 ② 次拖动把 n1 挪回最前）—— 它同时是"两次重排都只动了顺序、
       * 且合起来等价于原地复位"的证据。只看最后一份会让"顺序没变"看起来像判据空转 ✗。 */
      const diffMid = orderOnlyDiff(rawBefore, rawMid || rawBefore);
      const diff = orderOnlyDiff(rawBefore, rawAfter);
      const parentsMid = parentsOf(rawMid || rawBefore);
      const parentsAfter = parentsOf(rawAfter);
      const linksAfter = linkEdges(rawAfter);
      const linkProblems = linkDiff(linksBefore, linksAfter);
      const linksSame = linkProblems.length === 0;
      const cy = JSON.parse(await stepExec(ctx, '读渲染顺序', ORDER_JS(SIB)));
      const renderOrder = Object.keys(cy).filter((k) => cy[k] !== null).sort((a, b) => cy[a] - cy[b]);
      const parentsSame = JSON.stringify(Object.keys(parentsBefore).sort().map((k) => [k, parentsBefore[k]]))
        === JSON.stringify(Object.keys(parentsAfter).sort().map((k) => [k, parentsAfter[k]]));
      const rawFinal = JSON.parse(readRaw(P));
      const orderFinal = childrenIds(rawFinal, SIB_PARENT);
      const checks = [
        ['夹具打开成功', opened === true],
        ['目标被摆进面板中部且**中心命中它自己**（真鼠标的地基，用 elementFromPoint 判）',
          centered === true && !!hittable && JSON.parse(hittable).self === true],
        ['拖动前顺序 == 夹具原样（' + T1_KIDS.join(',') + '）',
          JSON.stringify(orderBefore) === JSON.stringify(T1_KIDS)],
        ['菜单里**没有**「拖动到同级第几位」（入口 2026-10-33 批4 已摘）', entryGone === true],
        ['直接调 API 进了重排档（kind=reorder 且锁定目标节点）', !!entered && entered.active === true
          && entered.kind === 'reorder' && entered.id === MOVE_ID],
        ['拖动中算出了落位：k == 上界（拖到最下面那条之下 ⇒ 贴到最后）',
          !!dragState && !!dragState.drop && dragState.drop.index === SIB.length
          && dragState.drop.parent === SIB_PARENT && dragState.drop.upper === SIB.length],
        ['落位预览真的在屏上（副本 + 落位线；副本是另一个元素，源节点没被拽走）',
          !!ghostShown && ghostShown.ghost === true && ghostShown.mark === true],
        ['拖动期间盘上零写入（sha256 逐字节不变）', !!dragState && dragState.diskSame === true],
        ['拖动期间序列化文本逐字节不变（这一档一个偏移桶都不写）',
          !!dragState && dragState.textSame === true && dragState.bucketsSame === true],
        ['松手后盘上顺序 == 期望（第一次重排：n1 从第 1 位到最后一位）',
          JSON.stringify(orderMid) === JSON.stringify(expectAfter)],
        ['盘上文件真的变了（对照组：证明上面那条不是恒真）', hAfter !== h0 && rawMid !== null],
        ['除 children 顺序外**没有任何字节变化**（结构形状 + meta 逐字段相同 ⇒ 差异白名单为空）',
          diffMid.ok === true],
        ['顺序差异**逐条点名**（谁从第几位到了第几位）',
          diffMid.moves.length === T1_KIDS.length && diffMid.moves.every((m) => m.at === 'root/t1')],
        ['父子关系不变（每个节点的父 id 逐个相同，第一次重排之后那一份仍是）',
          parentsSame === true && JSON.stringify(Object.keys(parentsMid).sort().map((k) => [k, parentsMid[k]]))
            === JSON.stringify(Object.keys(parentsBefore).sort().map((k) => [k, parentsBefore[k]]))],
        ['自由边（links[]）逐字节不变（R5：自由边不参与同级重排）', linksSame === true],
        ['第二次拖动真的把 n1 挪回最前 ⇒ 盘上顺序回到夹具原样（k=0 不是 no-op）',
          JSON.stringify(orderAfter) === JSON.stringify(expectFinal)
          && JSON.stringify(orderFinal) === JSON.stringify(expectFinal)],
        ['两次重排调用的下标就是两次落位预览算出来的那一个（4 与 0，**不是**另算一套）',
          calls.length === 2 && calls[0].index === SIB.length && calls[0].parent === SIB_PARENT
          && calls[1].index === 0 && calls[1].parent === SIB_PARENT
          && calls.every((c) => c.ok === true)],
        ['渲染顺序 == 数据顺序（n1..n4 的屏幕 cy 排序与盘上它们那一截的下标序一致）',
          JSON.stringify(renderOrder) === JSON.stringify(SIB)],
        ['clamp 另一端：再拖到最上面那条之上 ⇒ k == 0（合法值，不是负数/NaN）',
          !!clampDown && !!clampDown.drop && clampDown.drop.index === 0
          && clampDown.drop.upper === SIB.length && clampDown.selfHit === 'hit'],
        ['两次重排之后盘上顺序与夹具原样逐字节相同（净效果 = 原地复位，且**只有顺序**被碰过）',
          orderOnlyDiff(rawBefore, rawFinal).ok === true
          && JSON.stringify(orderOnlyDiff(rawBefore, rawFinal).moves) === JSON.stringify([])]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '菜单项=' + JSON.stringify((menu.items || []).slice(-3)) + ' · 入口已摘=' + entryGone
          + ' · 进档读数=' + JSON.stringify(entered) + ' · 拖动中读数=' + JSON.stringify(dragState)
          + ' · 预览元素=' + JSON.stringify(ghostShown)
          + ' · 盘上顺序 前=' + JSON.stringify(orderBefore) + ' 后=' + JSON.stringify(orderAfter)
          + ' 末=' + JSON.stringify(orderFinal) + '（期望 ' + JSON.stringify(expectOrder) + '）'
          + ' · 渲染顺序=' + JSON.stringify(renderOrder) + ' cy=' + JSON.stringify(cy)
          + ' · 首次重排后的顺序=' + JSON.stringify(orderMid) + '（期望 ' + JSON.stringify(expectAfter) + '）'
          + ' · 最终顺序=' + JSON.stringify(orderFinal) + '（期望 ' + JSON.stringify(expectFinal) + '）'
          + ' · 重排调用历史=' + JSON.stringify(calls)
          + ' · 差异（只该是顺序）=' + JSON.stringify({ ok: diffMid.ok, problems: diffMid.problems, moves: diffMid.moves })
          + ' · 父子关系逐项相同=' + parentsSame + ' · 自由边差异=' + JSON.stringify(linkProblems)
          + ' · clamp 另一端=' + JSON.stringify(clampDown)
          + ' · sha256 前/拖动中/后=' + [h0.slice(0, 12), (dragState && dragState.diskSame ? h0.slice(0, 12) : '?'), hAfter.slice(0, 12)].join('/')
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '丙 e·越界与非法档：渲染层 clamp 保证"拖出列表"这一档永远发出合法值；而**绕过 clamp** 直接走写通道发一个越界 k（`MMApp.reorderNodeChildRaw`，唯一的注入点）⇒ CLI 的上界校验响亮拒绝 + 盘上零改动 + 顺序不动；合法档（k = 上界）成功并回读；取消（reorderCancel）不写盘',
    run: async (ctx) => {
      // 夹具复位（同乙的说明）：丙 要求"起点 == 夹具原样"，而上一段真的改过盘上顺序。
      writeFixture();
      const opened = await openProject(ctx, P);
      if (opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**（不是通过）' };
      const orderBefore = childrenIds(JSON.parse(readRaw(P)), SIB_PARENT);
      const h0 = sha256(readRaw(P));
      const UPPER = SIB.length;                         // = 目标父移除该节点之后的子节点数（合法上界）
      const BEFORE = T1_KIDS;                           // 夹具原样：n1..n4 在前、nf 在后
      const AFTER = ['n2', 'n3', 'n4', MOVE_ID, FAN_PARENT];   // k = 3 ⇒ 挪到第 4 位
      // ① **绕过界面 clamp** 发一个越界 k：CLI 的上界校验必须响亮拒绝、盘上零改动
      const bad = await ctx.exec('(async function () { var r = await window.MMApp.reorderNodeChildRaw('
        + JSON.stringify(MOVE_ID) + ',' + JSON.stringify(SIB_PARENT) + ', 99);'
        + ' return JSON.stringify({ ok: r.ok, text: r.text }); })()');
      const badR = (function () { try { return JSON.parse(bad); } catch (e) { return null; } })();
      const hBad = sha256(readRaw(P));
      const orderAfterBad = childrenIds(JSON.parse(readRaw(P)), SIB_PARENT);
      // ② 合法档（k = 上界 = 贴到末尾）必须成功，并且**真的改了盘上顺序**
      const good = await ctx.exec('(async function () { var r = await window.MMApp.reorderNodeChild('
        + JSON.stringify(MOVE_ID) + ',' + JSON.stringify(SIB_PARENT) + ', 3);'
        + ' return JSON.stringify({ ok: r.ok, order: r.order, text: String(r.text || "").slice(0, 60) }); })()');
      const goodR = (function () { try { return JSON.parse(good); } catch (e) { return null; } })();
      await ctx.input.settle({ delayMs: 500 });
      const rawAfter = JSON.parse(readRaw(P));
      const orderAfter = childrenIds(rawAfter, SIB_PARENT);
      // ③ 渲染层 clamp 的**拖动那一半**：把进度条拖到列表上方 4000px ⇒ k 必须是 [0, 上界] 里的整数
      await ctx.exec('(function () { window.MMApp.getState().jm.expand_all(); return true; })()');
      await ctx.input.settle(PAINT);
      const pp = await pointOf(ctx, MOVE_ID);
      let st = null, ghostAtFar = null, hCancel = null, afterCancelOrder = null;
      if (pp) {
        await ctx.exec('window.MMApp.setDragMode(true, ' + JSON.stringify(MOVE_ID) + ', { mode: "reorder" }); 1');
        await ctx.input.settle(PAINT);
        const far = { x: pp.x, y: Math.max(4, pp.y - 4000) };
        await ctx.input.mouseDown(pp);
        await ctx.input.settle(PAINT);
        await ctx.input.moveTo(far);
        await ctx.input.settle(PAINT);
        st = await reorderState(ctx);
        ghostAtFar = await ctx.exec('(function () { var g = document.getElementById("tree-reorder-ghost");'
          + ' if (!g) return null; var r = g.getBoundingClientRect();'
          + ' return { top: Math.round(r.top), height: Math.round(r.height) }; })()');
        await ctx.exec('window.MMApp.reorderCancel(); window.MMApp.setDragMode(false); 1');   // 取消（不写盘）
        await ctx.input.mouseUp(far);
        await ctx.input.settle(PAINT);
        hCancel = sha256(readRaw(P));
        afterCancelOrder = childrenIds(JSON.parse(readRaw(P)), SIB_PARENT);
      }
      const hAfterGood = sha256(readRaw(P));
      const checks = [
        ['夹具打开成功', opened === true],
        ['绕过 clamp 发越界 k=99 ⇒ 响亮拒绝（ok:false 且有原因）',
          !!badR && badR.ok === false && typeof badR.text === 'string' && badR.text.length > 10],
        // ⚠️ 2026-10-16 修：这条原先把 `/越界/` **写了两遍** ⇒ 标题声称的两件事只判了一件，
        //   对"报文有没有说清**合法范围**"是**盲的**（独立只读审计抓到，属 B4 空转成因③同族：
        //   判据读的字段与它声称的不是一回事）。第二半必须真的去匹配那个范围 —— 而且用**上界
        //   现算值 UPPER** 去匹配，不是写死数字（写死就成了第二份会漂的口径 ✗）。
        ['拒绝报文点到"越界"与合法范围（照着能改，不是一句"操作失败"）', !!badR && /越界/.test(badR.text)
          && new RegExp('合法范围\\s*0\\s*[–—−-]\\s*' + UPPER + '(?![0-9])').test(badR.text)],
        ['越界时盘上零改动（sha256 逐字节不变）', hBad === h0],
        ['越界时顺序也没动', JSON.stringify(orderAfterBad) === JSON.stringify(BEFORE)],
        ['合法档 k=3 成功并回读新顺序（n1 从第 1 位到第 4 位）',
          !!goodR && goodR.ok === true && JSON.stringify(goodR.order) === JSON.stringify(AFTER)],
        ['合法档真的改了盘上顺序（对照组：证明上一条不是恒真）',
          JSON.stringify(orderAfter) === JSON.stringify(AFTER) && hAfterGood !== h0],
        ['拖出列表（指针在列表上方 4000px）⇒ k 被 clamp 成 0（合法值，不是 NaN/负数）',
          !!st && !!st.drop && st.drop.index === 0 && st.drop.parent === SIB_PARENT
          && st.drop.upper === UPPER],
        ['拖出列表时副本仍跟到指针那里（看得见"正在拖"）',
          !!ghostAtFar && ghostAtFar.height > 0 && !!pp && ghostAtFar.top < pp.y],
        ['取消（reorderCancel）之后盘上零写入、顺序不变',
          !!hCancel && hCancel === hAfterGood
          && JSON.stringify(afterCancelOrder) === JSON.stringify(orderAfter)],
        ['这一档（两次重排 + 一次取消）之后偏移两桶仍为空',
          await ctx.exec('(function () { return Object.keys(window.MMApp.getTreeOffsets()).length + Object.keys(window.MMApp.getNodeOffsets()).length; })()') === 0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '越界 k=99（绕过 clamp）⇒ ' + JSON.stringify(badR && { ok: badR.ok, text: String(badR.text || '').slice(0, 110) })
          + ' · 越界后盘上 sha256 不变=' + (hBad === h0)
          + ' · 合法 k=3 ⇒ ' + JSON.stringify(goodR)
          + ' · 盘上顺序 ' + JSON.stringify(orderBefore) + ' → ' + JSON.stringify(orderAfter)
          + ' → （取消后）' + JSON.stringify(afterCancelOrder)
          + ' · 拖出列表的落位读数=' + JSON.stringify(st) + ' · 副本位置=' + JSON.stringify(ghostAtFar)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  {
    name: '丁 收尾：退出拖动模式、清掉重排残留 DOM、偏移清回自动布局并落盘、进来时开着的项目开回去、确认桩复位（不给后面的域留状态）',
    run: async (ctx) => {
      const cleaned = await ctx.exec('(function () {'
        + ' if (window.MM.reorderCancel) window.MM.reorderCancel();'
        + ' window.MMApp.setDragMode(false);'
        + ' if (window.MM.clearTreeOffsets) window.MM.clearTreeOffsets();'
        + ' var g = document.getElementById("tree-reorder-ghost"); var m = document.getElementById("tree-reorder-mark");'
        + ' var dimmed = document.querySelectorAll("jmnode[data-mm-dimmed]").length;'
        + ' return JSON.stringify({ ghost: !!g, mark: !!m, dimmed: dimmed,'
        + '   mode: window.MMApp.dragModeActive(), buckets: Object.keys(window.MMApp.getTreeOffsets()).length'
        + '     + Object.keys(window.MMApp.getNodeOffsets()).length }); })()');
      const c = JSON.parse(cleaned);
      const saved = await save(ctx);
      const disk = JSON.parse(readRaw(P));
      const offLeft = Object.keys((disk.meta && disk.meta.nodeOffsets) || {}).length
        + Object.keys((disk.meta && disk.meta.themeOffsets) || {}).length;
      const back = await openProject(ctx, PROJECT_WHEN_ENTERED);
      await stubConfirm(ctx, null);
      const leftover = await ctx.exec('(function () { return JSON.stringify({'
        + ' ghost: !!document.getElementById("tree-reorder-ghost"),'
        + ' mark: !!document.getElementById("tree-reorder-mark"),'
        + ' dimmed: document.querySelectorAll("jmnode[data-mm-dimmed]").length,'
        + ' mode: window.MMApp.dragModeActive() }); })()');
      const lo = JSON.parse(leftover);
      return {
        ok: c.ghost === false && c.mark === false && c.dimmed === 0 && c.mode === false && c.buckets === 0
          && saved === true && offLeft === 0 && back === true && STUB_INSTALLED === false
          && lo.ghost === false && lo.mark === false && lo.dimmed === 0 && lo.mode === false,
        text: '清后=' + cleaned + ' · 保存=' + saved + ' · 盘上偏移键数=' + offLeft
          + ' · 开回原项目（' + (PROJECT_WHEN_ENTERED || '(空)') + '）=' + back
          + ' · 确认桩已复位=' + (STUB_INSTALLED === false) + ' · 收尾后残留=' + leftover
      };
    }
  }

];

module.exports = assertions;
