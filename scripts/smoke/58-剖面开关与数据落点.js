/* ============================================================
 * scripts/smoke/58-剖面开关与数据落点.js —— 【MS4】剖面开关 + 控件面 + 数据落点（端到端）
 * ------------------------------------------------------------
 * 设计稿：`docs/DIAGRAM-MODES.md` §4.3（控件面的判据）、§6.5（三档"同一个项目能被两种模式打开"）、
 *         §7.2 的 MS4 判据。本域只钉**界面那一半**（真 DOM / 真鼠标 / 盘上字节），六条：
 *
 *  甲 **控件面由剖面生成，且五个剖面双向相等**（§4.3 第 3 条的可判形式）：
 *     对矩阵里的五个剖面各跑一次 —— `document.querySelectorAll('[data-cap]')` 的**能力集合**逐条等于
 *     "该剖面支持的集合（✓∪○）∩ 控件面声明的那几条能力"，**可交互子集**（`data-cap-on="1"`）逐条等于
 *     "✓ 的集合 ∩ 声明集"。多一个、少一个都判红。
 *     ⚠️ **期望值不从 `src/diagram/profiles.js` 取**（那是被测实现的一部分：拿它当期望 =
 *     "实现改了、期望跟着改"的恒等假绿）。期望从**设计稿 `docs/DIAGRAM-MODES.md` §3.2 的矩阵现解析**
 *     （文档是权威、`profiles.js` 是它的抄本 ⇒ 抄歪了这一条就红）。
 *     ⚠️ 还要判"看得见"：每个在面上的控件都必须有真实几何、且**中心点 `elementFromPoint` 命中它自己**
 *     （只判属性集合的话，"属性都在、元素被裁掉/藏起来"照样绿 —— 本工程踩过一次：圆钮被框的
 *     overflow 裁掉，`rect` 说在框外、断言全绿，真帧 0 像素）。反过来，被判 ✗ 的控件必须**真的不渲染**。
 *     ⚠️ 还要判"不空转"：① 每个剖面至少有一个控件（空的相等不是相等）；
 *     ② 声明的那些能力里**至少有一格是 ✗**（否则"控件集合随剖面变化"这件事根本没发生）；
 *     ③ 五个剖面的面**至少三种互不相同**（否则"每档都摆全部控件"也能过）。
 *
 *  乙 **一处实现、剖面名不进判断**（§4.3 第 2 条的可判形式）：
 *     剖面轴的代码只有两处（`renderer/app-core.js` 机制 + `renderer/app.js` 接线），
 *     这两份 + `renderer/index.html` 里**五个剖面名作为字符串字面量出现次数 === 0**
 *     （⇒ 结构上不可能存在"按剖面名分支"）；`= P.controlsFor(` 的调用点**恰好 1 处**
 *     （唯一过滤点：想手写一份"恰好相等"的名单，只能再加一个过滤点 ⇒ 必红）；
 *     `index.html` 里 `data-cap` 出现次数 === 0（控件不是手写在骨架里的）。
 *     判别力：`MM_SMOKE_INJECT=58-name` 会把"故意写了按剖面名分支 + 第二个手写过滤点"的假源码
 *     喂给**同一个判定函数**（只在注入档生效，生产路径一次都不进）⇒ 该条必须当场红。
 *
 *  丙 **窄剖面打开带 `graph` 的项目**（§6.5 判据①）：画树、不画图、**看得见地说清**"本项目带图附加层
 *     且本剖面不显示"、给一个切到全开剖面的入口，然后**真鼠标点一次保存** ⇒
 *     盘上 `graph` 子树（键序 + 值）**逐字节不变**。
 *     ⚠️ "保存成功"本身也要判（状态栏出现「已保存」+ `isDirty()` 回 false）：否则"保存被拦下、
 *     盘上没动"会被读成"graph 没被抹掉" —— 那是把**没做**读成**做对了**。
 *
 *  丁 **全开剖面打开纯树项目**（§6.5 判据②）：派生布局在（节点都有非零矩形）、盘上 sha256 不变、
 *     `isDirty()` 仍 false、序列化产物里**没有** `graph` 键（派生布局不写盘）；
 *     剖面来回切也不写盘、不新增键（顶层键集与 `meta` 键集逐项相同）。
 *
 *  戊 **两剖面交替打开同一个项目**（§6.5 判据③）：`meta.nodeOffsets` 是**共用的** ——
 *     窄剖面里写一条偏移并落盘 ⇒ 切到全开剖面（不重开）再量、重开项目再量，
 *     那个节点相对根的位移**逐项相同**，偏移桶仍只有一项、盘上不多出第二个坐标键。
 *     ⚠️ 量的是**相对根的位移**（平移不变量），不是绝对坐标：切剖面会改工具栏内容的宽度，
 *     极端窗口宽度下工具栏可能多/少一行 ⇒ 画布整体会挪，绝对坐标会假红（域 37 的老坑）。
 *
 *  己 收尾：剖面回全开 / 清偏移 / 开回进来时那个项目 / 删两个夹具（自证不存在）/ 收模态 / 复位确认桩。
 *
 * ⚠️ **【MS3 接上内核之后本域被改了两条判据（丁/戊），一条断言都没删】**：
 *   MS3 起"全开剖面"用的是 **SVG 渲染器**（`renderer/app-core.js` 的图渲染层），而本域 丁/戊 原来是
 *   照 `jmnode` 量的 ⇒ 那一刻 jmnode 是 `display:none`（几何全 0），原判据会把"画得好好的"判成红。
 *   改法是**把判据变成渲染器无关**（不是放宽）：
 *     · 丁 的"可见节点"改成**两套渲染器取大者**，并**新加**一条"两套不同时可见"（双渲染器最怕的坏结果）；
 *     · 戊 从"两套渲染器里量同一个绝对坐标"改成"**同一份 `meta.nodeOffsets` 在两套里各自位移都恰好
 *       等于偏移值**"（清掉/加回各重画一次对比）—— 比原来那版**更强**：它证明的是"同一份数据驱动
 *       两个渲染器"，而原来那版只证明了"两个读数相等"。
 *
 * 判别力证明（"临时改产品代码那一轮"，每次都记 SHA-256 + 字节数并用**原始 Buffer** 逐字节还原）：
 *   ① 把 `applyCapSurface` 的 `controlsFor(...)` 换成一份**手写的 shown 名单** ⇒ 甲 必红；
 *   ② 在 `app-core.js` 里写一句"剖面变量 === 某个剖面名"的分支 ⇒ 乙 必红；
 *   ③ 删掉 `hideCapTarget` 里的 `removeAttribute('data-cap')`（藏起来但属性还在）⇒ 甲 必红；
 *   ④ 让 `serializeTree` 顺带写 `graph`（= 界面开始管图附加层了）⇒ 丙/丁 必红。
 * 读数与注入记录：`.review/20261064-MS4剖面开关/`。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const mm = require('../smoke-assertions.js');
/* 夹具的落盘走**产品自己的写盘出口**（`src/data-store.js` 的 `writeFileAtomic`），不用裸 `fs.writeFileSync`。
 * 两个理由，都不是"为了过门禁"：
 *   ① 写盘出口全工程只有一处（tmp → fsync → rename）—— 夹具也是"往盘上落一份 JSON"，
 *      没有理由为了"这是测试"再造一个更弱的写法；
 *   ② 本域**必须**读设计稿 `docs/DIAGRAM-MODES.md`（期望值不能从被测实现取，见文件头 甲），
 *      而 S2 的判定 ④ 是"文件提到受管资产名 + 有判不了目标的裸写 ⇒ 当作可能在写受管资产"。
 *      改走出口后这一处不再是裸写，判定④ 的前提自然不成立（不是把它登记成欠账 —— 那要抬 cap）。 */
const { writeFileAtomic } = require('../../src/data-store.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'DIAGRAM-MODES.md');

/* ================= 夹具（沙箱项目；收尾删干净） =================
 * 两个夹具分工：一个**带 graph**（丙），一个**纯树 + 深处有个可偏移的节点**（丁/戊）。
 * 名字用 `zz-` 前缀：一眼看出是夹具、且不会与真实项目撞名。 */
const P_GRAPH = 'zz-ms4-graph';
const P_TREE = 'zz-ms4-tree';
/** 纯树夹具里那个"更深的子树根"（`meta.nodeOffsets` 的键域：不是 root 的直接子节点） */
const DEEP = 'd1';
/** 带 graph 夹具的分支节点（图的端点点名它们 ⇒ `validateGraphRefs` 要能在树上找到） */
const GA = 'a';
const GB = 'b';

/** 图附加层的四类计数（丙 的提示文案要按它现算，不许界面自己编） */
const GRAPH_FACTS = { layers: 2, containers: 1, edges: 2, annotations: 1 };

let PROJECT_WHEN_ENTERED = '';

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到盘上真值');
  return d;
}
const projectDir = (name) => path.join(projectsDir(), name);
const projectFile = (name) => path.join(projectDir(name), name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/* ================= 期望值来源：**设计稿**（不是 profiles.js） ================= */

/** 从 `docs/DIAGRAM-MODES.md` §3.2 的 `matrix:begin/end` 块里现解析列名与逐格记号。
 *  **不复用 `src/diagram/profiles.js`**：那是被测实现，拿它当期望就是恒等假绿（见文件头 甲）。 */
function docMatrix() {
  const md = fs.readFileSync(DOC, 'utf8');
  const b = md.indexOf('<!-- matrix:begin');
  const e = md.indexOf('<!-- matrix:end -->');
  if (b < 0 || e <= b) throw new Error('docs/DIAGRAM-MODES.md 里找不到 matrix:begin / matrix:end 标记');
  const lines = md.slice(b, e).split(/\r?\n/);
  let profiles = null;
  const rows = [];
  lines.forEach((line) => {
    if (!profiles) {
      const h = /^\|\s*编号\s*\|\s*能力\s*\|(.*)\|\s*$/.exec(line);
      if (h) {
        profiles = h[1].split('|').map((s) => s.trim().replace(/`/g, '')).filter(Boolean);
        return;
      }
    }
    const m = /^\|\s*`(C-[A-Z0-9]+-\d{2})`\s*\|\s*([^|]+?)\s*\|(.*)$/.exec(line);
    if (!m) return;
    const cells = m[3].split('|').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s/g, ''));
    if (cells.length !== (profiles || []).length) return;
    rows.push({ id: m[1], marks: cells.join('') });
  });
  if (!profiles || profiles.length !== 5) {
    throw new Error('矩阵表头读不出 5 个剖面列（读到 ' + JSON.stringify(profiles) + '）');
  }
  if (rows.length < 50) throw new Error('矩阵行数太少（' + rows.length + '）⇒ 解析很可能坏了');
  const byProfile = {};
  profiles.forEach((p, i) => {
    const all = [], enabled = [], rejected = [];
    rows.forEach((r) => {
      const mark = r.marks[i];
      if (mark === '\u2713' || mark === '\u25cb') all.push(r.id);
      if (mark === '\u2713') enabled.push(r.id);
      if (mark === '\u2717') rejected.push(r.id);
    });
    byProfile[p] = { all: all, enabled: enabled, rejected: rejected };
  });
  return { profiles: profiles, rows: rows, byProfile: byProfile };
}

/** 全开剖面 = 零 ✗ 的那一个（D1 的定义；按性质找，不写死名字） */
const fullProfileOf = (doc) => doc.profiles.filter((p) => doc.byProfile[p].rejected.length === 0)[0];
/** 窄剖面 = 拒绝集非空的那些（取第一个，用于"窄剖面"那三条判据） */
const narrowProfileOf = (doc) => doc.profiles.filter((p) => doc.byProfile[p].rejected.length > 0)[0];

/* ================= 界面驱动的小工具 ================= */

const PAINT = { delayMs: 160 };

async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await ctx.input.settle(PAINT);
  return ok;
}

/** 真鼠标点一个元素（先量它的屏幕矩形；量不到 ⇒ 抛，不静默当成"点过了"） */
async function clickEl(ctx, sel, why) {
  const pt = await ctx.exec('(function () {'
    + ' var el = document.querySelector(' + JSON.stringify(sel) + ');'
    + ' if (!el) return null;'
    + ' var b = el.getBoundingClientRect();'
    + ' if (!b.width || !b.height) return null;'
    + ' return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };'
    + '})()');
  if (!pt) throw new Error('点不到 ' + sel + '（' + (why || '') + '）：元素不在或没有几何');
  await ctx.input.click(pt);
  await ctx.input.settle(PAINT);
  return pt;
}

const setProfile = (ctx, p) => ctx.exec('(function () { return window.MMApp.setCapProfile('
  + JSON.stringify(p) + '); })()');
const profileNow = (ctx) => ctx.exec('window.MMApp.capProfile()');
const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');
const statusText = (ctx) => ctx.exec('(function () { var el = document.getElementById("status-text");'
  + ' return el ? el.textContent : null; })()');

/** 控件面读数：**只读 DOM**（`[data-cap]` / `[data-cap-off]`），不读产品自己的 getter */
const SURFACE = `(function () {
  var shown = [], off = [];
  document.querySelectorAll('[data-cap]').forEach(function (el) {
    var b = el.getBoundingClientRect();
    var rendered = el.getClientRects().length > 0 && b.width > 0 && b.height > 0;
    var hitSelf = false, hitTag = null;
    if (rendered) {
      var h = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
      hitTag = h ? (h.tagName + (h.id ? '#' + h.id : '')) : null;
      hitSelf = !!(h && (h === el || el.contains(h)));
    }
    shown.push({
      cap: el.getAttribute('data-cap'), on: el.getAttribute('data-cap-on') === '1',
      id: el.id || el.getAttribute('data-cap-ctl') || '', rendered: rendered, hitSelf: hitSelf, hitTag: hitTag
    });
  });
  document.querySelectorAll('[data-cap-off]').forEach(function (el) {
    off.push({ id: el.id || el.getAttribute('data-cap-ctl') || '',
      rendered: el.getClientRects().length > 0 });
  });
  return { shown: shown, off: off };
})()`;

/** 控件面声明（只读引用：`[{id, cap}]`）—— 判据用它对齐"哪条能力由一个控件承载"，
 *  **但"出不出"一律由设计稿矩阵的决定来判**（声明里写不出"哪个剖面"）。 */
const MANIFEST = '(window.MM.CAP_CONTROLS || []).map(function (c) {'
  + ' return { id: c.id, cap: c.cap }; })';

const uniqSorted = (arr) => Array.from(new Set(arr)).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const inter = (a, b) => uniqSorted(a.filter((x) => b.indexOf(x) >= 0));

/** 相对根的位移（平移不变量：切剖面可能改工具栏行数 ⇒ 画布整体会挪，绝对坐标会假红）。
 *  ⚠️ 同时回**该节点自己的矩形尺寸**：折叠着的 jmnode `getBoundingClientRect()` 全是 0，
 *  拿它跟根相比会得到一个"两边一样"的常数 ⇒ 判据会**空转**（本域第一版实测踩到这条路：
 *  `d1` 在折叠的子树里，位移前后都是同一个数）。尺寸为 0 ⇒ 调用方必须判红，不许当成"没挪"。 */
function relToRoot(ctx, id) {
  return ctx.exec('(function () {'
    + ' var n = document.querySelector(\'jmnode[nodeid="' + id + '"]\');'
    + ' var r = document.querySelector(\'jmnode[nodeid="root"]\');'
    + ' if (!n || !r) return null;'
    + ' var a = n.getBoundingClientRect(), b = r.getBoundingClientRect();'
    + ' return { dx: Math.round(a.left - b.left), dy: Math.round(a.top - b.top),'
    + '   w: Math.round(a.width), h: Math.round(a.height) };'
    + '})()');
}

/** 图渲染器里某节点的**画布坐标**（读 SVG 的 `data-x`/`data-y`：用户单位，与缩放/平移无关）。
 *  相对根取位移 ⇒ 平移不变量（与 `relToRoot` 同一口径，只是换了一套渲染器）。
 *  ⚠️ 拿不到 ⇒ 回 null，调用方必须判红 —— 不许当成"没挪"（本域第一版就在这上面空转过一次）。 */
function svgRelToRoot(ctx, id, rootId) {
  return ctx.exec('(function () {'
    + ' var h = document.getElementById("diagram-host");'
    + ' if (!h) return null;'
    + ' var a = h.querySelector(\'g[data-node][data-tree-id="' + id + '"]\');'
    + ' if (!a) return null;'
    + ' var r = h.querySelector(\'g[data-node][data-tree-id="' + rootId + '"]\');'
    + ' var ax = parseFloat(a.getAttribute("data-x")), ay = parseFloat(a.getAttribute("data-y"));'
    + ' var rx = r ? parseFloat(r.getAttribute("data-x")) : 0;'
    + ' var ry = r ? parseFloat(r.getAttribute("data-y")) : 0;'
    + ' return { dx: Math.round(ax - rx), dy: Math.round(ay - ry),'
    + '   w: parseFloat(a.getAttribute("data-w")), h: parseFloat(a.getAttribute("data-h")) };'
    + '})()');
}

/** 画布上一共有几个节点**真有几何**（**两套渲染器取大者** —— MS3 之后"全开剖面"用的是
 *  SVG 渲染器，jmnode 那一刻是 `display:none`（几何全 0），只数 jmnode 会把"画得好好的"判成红。
 *  同时回"哪一套在画"：两套渲染器**不许同时在画**（同屏两棵树 = 双渲染器最常见的坏结果）。 */
const NODE_GEOM = `(function () {
  var svgNodes = document.querySelectorAll('#diagram-host svg[data-mm="diagram"] g[data-node]');
  var jm = document.querySelectorAll('jmnode[nodeid]');
  var svgDrawn = 0, jmDrawn = 0;
  svgNodes.forEach(function (el) { var b = el.getBoundingClientRect(); if (b.width > 0 && b.height > 0) svgDrawn++; });
  jm.forEach(function (el) { var b = el.getBoundingClientRect(); if (b.width > 0 && b.height > 0) jmDrawn++; });
  return { jmCount: jm.length, svgCount: svgNodes.length, svgDrawn: svgDrawn, jmDrawn: jmDrawn,
    drawn: Math.max(svgDrawn, jmDrawn),
    renderer: svgNodes.length ? 'diagram' : 'tree',
    bothVisible: svgDrawn > 0 && jmDrawn > 0 };
})()`;

/** 把整棵树展开（偏移要落在**渲染出来的**节点上量，否则量到的是 0 —— 见 relToRoot 的说明） */
async function expandAll(ctx) {
  await ctx.exec('(function () { var jm = window.MMApp.getState().jm; if (jm) jm.expand_all(); return true; })()');
  await ctx.exec('(function () { if (window.MM.refreshDiagram) window.MM.refreshDiagram(); return true; })()');
  await ctx.input.settle(PAINT);
}

/* ================= 夹具的写 / 删 ================= */

function node(id, topic, expanded, kids, extra) {
  const n = { id: id, topic: topic, expanded: expanded };
  if (kids && kids.length) n.children = kids;
  return Object.assign(n, extra || {});
}

/** 带 `graph` 的夹具：树本身很普通（丙 要判"画的是树"），图附加层四类各留几条 */
function graphFixture() {
  return {
    meta: { name: P_GRAPH, author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    data: node('root', 'MS4 带图夹具', true, [
      node('t1', '主题甲', true, [node(GA, '甲-1', true, []), node(GB, '甲-2', true, [])]),
      node('t2', '主题乙', true, [node('c', '乙-1', true, [])])
    ]),
    graph: {
      version: 1,
      profile: 'complex',
      direction: 'LR',
      grid: 8,
      layers: [
        { id: 'l-a', label: '接入层', rect: [0, 0, 480, 200] },
        { id: 'l-b', label: '转发层', rect: [0, 240, 480, 200] }
      ],
      containers: [
        { id: 'k-a', label: '同机三条链', rect: [0, 0, 320, 160], layout: 'stack', children: [GA, GB] }
      ],
      edges: [
        { id: 'e-a', from: { node: GA }, to: { node: GB }, route: 'orthogonal', label: '主路径' },
        { id: 'e-b', from: { node: GB }, to: { node: 'c' }, style: 'dashed' }
      ],
      annotations: [{ id: 'n-a', text: '看这里', at: [16, 32] }]
    }
  };
}

/** 纯树夹具：没有 `graph`（丁 要判"全开剖面打开纯树项目不写盘"），深处留一个可偏移的子树根 */
function treeFixture() {
  return {
    meta: { name: P_TREE, author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    data: node('root', 'MS4 纯树夹具', true, [
      node('t1', '主题甲', true, [
        node('p1', '甲-1', true, [node(DEEP, '甲-1-1', true, [node('d1a', '甲-1-1-1', true, [])])])
      ]),
      node('t2', '主题乙', true, [node('q1', '乙-1', true, [])])
    ])
  };
}

function writeFixtures() {
  const g = graphFixture();
  const t = treeFixture();
  fs.mkdirSync(projectDir(P_GRAPH), { recursive: true });
  writeFileAtomic(projectFile(P_GRAPH), JSON.stringify(g, null, 2) + '\n');
  fs.mkdirSync(projectDir(P_TREE), { recursive: true });
  writeFileAtomic(projectFile(P_TREE), JSON.stringify(t, null, 2) + '\n');
  return { g: g, t: t };
}

function rmFixtures() {
  let removed = false;
  try {
    fs.rmSync(projectDir(P_GRAPH), { recursive: true, force: true });
    fs.rmSync(projectDir(P_TREE), { recursive: true, force: true });
    removed = true;
  } catch (e) { removed = false; }
  const gone = [P_GRAPH, P_TREE].every((n) => {
    try { fs.readFileSync(projectFile(n), 'utf8'); return false; } catch (e) { return true; }
  });
  return { removed: removed, gone: gone };
}

/** 盘上那份的 `graph` 子树，按**键序 + 值**序列化成一行（逐字节比较用；只差缩进不算差异） */
function graphSubtree(text) {
  const o = JSON.parse(text);
  if (!Object.prototype.hasOwnProperty.call(o, 'graph')) return null;
  return JSON.stringify(o.graph);
}

/* ================= 乙 的静态扫描（纯函数，注入档也走它） ================= */

/** 数"某个名字作为字符串字面量"出现几次（**扫原文**：本工程的注释剥除器对 app-core.js
 *  会与真实字符串状态失步，靠它反而会把注释里的示例也搅进来 —— 那不是判据） */
function countLiterals(src, names) {
  const out = {};
  names.forEach((n) => {
    const re = new RegExp('[\'"`]' + n + '[\'"`]', 'g');
    out[n] = (src.match(re) || []).length;
  });
  return out;
}

/** 剖面轴的三处扫描面（声明在这里、报错时点名 —— 不自由发挥） */
const PROFILE_AXIS_FILES = ['renderer/app-core.js', 'renderer/app.js', 'renderer/index.html'];

/**
 * 乙 的判定本体（纯函数，输入是"文件相对路径 → 源码文本"，便于注入档喂假源码）。
 * @returns {{ok:boolean, problems:string[], readings:object}}
 */
function judgeStructure(sources, names) {
  const problems = [];
  const readings = {};
  PROFILE_AXIS_FILES.forEach((rel) => {
    const src = sources[rel];
    if (typeof src !== 'string') { problems.push(rel + ' 读不到（扫描面必须完整，缺一份就判不了）'); return; }
    const c = countLiterals(src, names);
    const total = names.reduce((n, k) => n + c[k], 0);
    readings[rel] = { literalTotal: total, detail: c };
    if (total > 0) {
      const hit = names.filter((n) => c[n] > 0).map((n) => n + '×' + c[n]).join(' ');
      problems.push(rel + ' 里出现了 ' + total + ' 处剖面名字面量（' + hit + '）—— '
        + '剖面轴的代码里一个都不许有：一出现就说明"按剖面名分支"这条路被打开了');
    }
  });
  // 唯一过滤点：`= P.controlsFor(` 只能有一处（多一处 = 第二个手写名单的入口）
  const core = sources['renderer/app-core.js'] || '';
  const callSites = (core.match(/=\s*P\.controlsFor\(/g) || []).length;
  readings.controlsForCallSites = callSites;
  if (callSites !== 1) {
    problems.push('renderer/app-core.js 里 `= P.controlsFor(` 的调用点 = ' + callSites + '（必须恰好 1 处）—— '
      + '"控件集合由剖面生成"的唯一过滤点只许有一个');
  }
  // 骨架里不许手写 data-cap（手写清单最常见的形态就是把属性抄进 HTML）
  const html = sources['renderer/index.html'] || '';
  const htmlCaps = (html.match(/data-cap/g) || []).length;
  readings.htmlDataCap = htmlCaps;
  if (htmlCaps !== 0) {
    problems.push('renderer/index.html 里出现 ' + htmlCaps + ' 处 `data-cap` —— '
      + '控件是**生成**的，骨架里一个都不该有（有就是手写名单的第一行）');
  }
  return { ok: problems.length === 0, problems: problems, readings: readings };
}

/** 判别力注入（`MM_SMOKE_INJECT=58-name`）：喂一份**故意违规**的假源码，判定函数必须报出来。
 *  只在注入档生效；默认路径一次都不进（注入不改文件 —— 本工程已有 5 次"判据在空转"的教训）。 */
function injectedStructureSources(names) {
  if (String(process.env.MM_SMOKE_INJECT || '').trim() !== '58-name') return null;
  const sources = {};
  PROFILE_AXIS_FILES.forEach((rel) => { sources[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8'); });
  // 在被禁的那两处各塞一条：① 按剖面名分支 ② 第二个手写过滤点
  sources['renderer/app.js'] += '\nvar __injected = 0;\nif (capProfileName === '
    + JSON.stringify(names[3]) + ') { __injected = 1; }\n';
  sources['renderer/app-core.js'] += '\nvar __injected2 = P.controlsFor('
    + JSON.stringify(names[1]) + ', []);\n';
  return sources;
}

/* ================= 确认桩（无头跑里没人回答模态 ⇒ 必须显式装桩，域 43/51 同款） ================= */

async function stubConfirm(ctx, answer) {
  await ctx.exec('window.MMApp.setConfirmStub('
    + (answer === null ? 'null' : 'function () { return ' + (answer ? 'true' : 'false') + '; }') + ')');
}

/* ================= 断言 ================= */
const assertions = [

  {
    name: '甲 控件面由剖面生成：五剖面各跑一次，DOM 的 [data-cap] 集合**双向等于**设计稿矩阵'
      + '（该剖面 ✓∪○ ∩ 控件面声明集）、可交互子集等于 ✓ 集；每个在面上的控件真有几何且中心命中它自己、'
      + '每个 data-cap-off 的控件真的不渲染；且"至少一格 ✗、五面至少三种互不相同"（防空转）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）⇒ 真输入判据跑不了' };
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return s && s.project ? s.project.name : ""; })()') || '';
      await stubConfirm(ctx, true);            // 收尾切项目时"有脏改动"不许把无头跑卡死
      const doc = docMatrix();
      const manifest = await ctx.exec(MANIFEST);
      if (!Array.isArray(manifest) || !manifest.length) {
        return { ok: false, text: '控件面声明读不到（window.MM.CAP_CONTROLS 空/缺）⇒ 没有可判的对象' };
      }
      const declaredCaps = uniqSorted(manifest.map((c) => c.cap));
      // 防空转 ②：声明的能力里必须至少有一格在某个剖面是 ✗
      const rejectedPairs = doc.rows.filter((r) => declaredCaps.indexOf(r.id) >= 0)
        .reduce((n, r) => n + (r.marks.indexOf('\u2717') >= 0 ? 1 : 0), 0);
      const rows = [];
      const signatures = new Set();
      const fails = [];
      if (rejectedPairs < 1) fails.push('控件面声明的那几条能力在所有剖面里都是"支持" ⇒ 控件集合不可能随剖面变化（判据空转）');
      for (const p of doc.profiles) {
        const set = await setProfile(ctx, p);
        await ctx.input.settle({ delayMs: 60 });
        if (!set || !set.ok) { fails.push(p + ' 切剖面失败：' + ((set && set.reason) || '未知')); continue; }
        const surf = await ctx.exec(SURFACE);
        const shownCaps = uniqSorted(surf.shown.map((s) => s.cap));
        const onCaps = uniqSorted(surf.shown.filter((s) => s.on).map((s) => s.cap));
        const expectedAll = inter(declaredCaps, doc.byProfile[p].all);
        const expectedOn = inter(declaredCaps, doc.byProfile[p].enabled);
        signatures.add(shownCaps.join(',') + '|' + onCaps.join(','));
        if (!same(shownCaps, expectedAll)) {
          fails.push(p + ' 的 [data-cap] 集合与矩阵不符：多='
            + JSON.stringify(shownCaps.filter((c) => expectedAll.indexOf(c) < 0))
            + ' 少=' + JSON.stringify(expectedAll.filter((c) => shownCaps.indexOf(c) < 0)));
        }
        if (!same(onCaps, expectedOn)) {
          fails.push(p + ' 的可交互子集与矩阵的 ✓ 不符：实际=' + JSON.stringify(onCaps)
            + ' 期望=' + JSON.stringify(expectedOn));
        }
        if (surf.shown.length === 0) fails.push(p + ' 一个控件都没有 ⇒ 这一档的相等是**空的相等**（判据空转）');
        const notRendered = surf.shown.filter((s) => !s.rendered);
        if (notRendered.length) fails.push(p + ' 有在面上却没有几何的控件：' + JSON.stringify(notRendered));
        const notHit = surf.shown.filter((s) => !s.hitSelf);
        if (notHit.length) fails.push(p + ' 有中心点命中的不是它自己的控件：' + JSON.stringify(notHit));
        const stillShown = surf.off.filter((s) => s.rendered);
        if (stillShown.length) fails.push(p + ' 有 data-cap-off 的控件却仍在渲染：' + JSON.stringify(stillShown));
        rows.push(p + ': 面=' + shownCaps.length + '（' + shownCaps.join('/') + '）可交互=' + onCaps.length
          + ' 判 ✗ 而藏起=' + surf.off.length);
      }
      if (signatures.size < 3) {
        fails.push('五个剖面的面只有 ' + signatures.size + ' 种互不相同的形态（要 ≥3）—— '
          + '"控件集合随剖面变化"这件事没有真的发生');
      }
      await setProfile(ctx, fullProfileOf(doc));
      await ctx.input.settle({ delayMs: 60 });
      return {
        ok: fails.length === 0,
        text: (fails.length ? '✗ ' + fails.join(' ｜ ') + ' ｜ ' : '') + '五剖面读数：' + rows.join(' · ')
          + ' ｜ 声明承载的能力=' + declaredCaps.join('/') + '（其中 ' + rejectedPairs + ' 条在某剖面是 ✗）'
          + ' ｜ 互不相同的面=' + signatures.size + '（≥3）｜ 期望值来源=docs/DIAGRAM-MODES.md §3.2 现解析'
      };
    }
  },

  {
    name: '乙 一处实现 · 剖面名不进判断：剖面轴三处（app-core.js / app.js / index.html）里五个剖面名的'
      + '字面量**=== 0**；`= P.controlsFor(` 调用点 === 1（唯一过滤点）；index.html 里 `data-cap` === 0（不是手写）'
      + '。判别力：`MM_SMOKE_INJECT=58-name` 喂违规源码 ⇒ 同一判定函数必须判红',
    run: async (ctx) => {
      const names = docMatrix().profiles;
      const sources = {};
      PROFILE_AXIS_FILES.forEach((rel) => { sources[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8'); });
      const real = judgeStructure(sources, names);
      const detail = Object.keys(real.readings)
        .map((k) => k + '=' + JSON.stringify(real.readings[k])).join(' ');
      const inj = injectedStructureSources(names);
      let injLine = '未开注入档（默认路径，一次都不进）';
      let injOk = true;
      if (inj) {
        const r = judgeStructure(inj, names);
        injOk = r.ok === false && r.problems.length >= 2;
        injLine = '注入档 ' + (injOk
          ? '✓ 同一判定函数报出 ' + r.problems.length + ' 条违规（判据会咬）：' + r.problems.map((s) => s.slice(0, 32)).join(' ／ ')
          : '✗ 注入后仍判绿 ⇒ 判据在空转：' + JSON.stringify(r.problems));
      }
      return {
        ok: real.ok && injOk,
        text: (real.ok ? '' : '✗ ' + real.problems.join(' ｜ ') + ' ｜ ') + '读数：' + detail + ' ｜ ' + injLine
      };
    }
  },

  {
    name: '丙 窄剖面打开**带 graph** 的项目：画树、不画图、"带图附加层·本剖面不显示"看得见、切回全开的入口真能点；'
      + '真鼠标点一次保存（状态栏「已保存」+ isDirty 回 false）⇒ 盘上 graph 子树（键序+值）**逐字节不变**',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）⇒ 真鼠标判据跑不了' };
      writeFixtures();
      const doc = docMatrix();
      const narrow = narrowProfileOf(doc);
      const full = fullProfileOf(doc);
      await setProfile(ctx, narrow);
      await ctx.input.settle({ delayMs: 60 });
      const opened = await openProject(ctx, P_GRAPH);
      const view = await ctx.exec('(function () {'
        + ' var nodes = document.querySelectorAll(\'jmnode[nodeid]\');'
        + ' var drawn = 0;'
        + ' nodes.forEach(function (el) { var b = el.getBoundingClientRect(); if (b.width > 0 && b.height > 0) drawn++; });'
        + ' var note = document.getElementById("profile-note-text");'
        + ' var btn = document.getElementById("profile-switch-full");'
        + ' var bb = btn ? btn.getBoundingClientRect() : null;'
        /* "入口看得见"的判据**必须是命中测试**，不是 rect：被父元素裁掉时 rect 读数与正常显示完全相同
         * 而真帧 0 像素（本工程实测过的坑，见 scripts/smoke-assertions.js 的 ★ 判据纪律）。
         * 这里判 `elementFromPoint(中心)` 命中它自己（遮挡/裁切都会让它落到别人身上）。 */
        + ' var hitSelf = false, hitTag = null;'
        + ' if (btn && bb && bb.width > 0 && bb.height > 0) {'
        + '   var h = document.elementFromPoint(Math.round(bb.left + bb.width / 2), Math.round(bb.top + bb.height / 2));'
        + '   hitTag = h ? (h.tagName + (h.id ? "#" + h.id : "")) : null;'
        + '   hitSelf = !!(h && (h === btn || btn.contains(h)));'
        + ' }'
        + ' return { jmnodes: nodes.length, drawn: drawn,'
        + '   note: note ? note.textContent : null,'
        + '   btnShown: !!(btn && btn.style.display !== "none" && bb && bb.width > 0 && bb.height > 0),'
        + '   btnHitSelf: hitSelf, btnHitTag: hitTag,'
        + '   graphRenders: document.querySelectorAll("[data-graph-layer], .mm-graph-layer, svg[data-graph]").length,'
        + '   profile: window.MMApp.capProfile() };'
        + '})()');
      // 提示文案：四类计数 + "本剖面不显示"（口径见 docs/DIAGRAM-MODES.md §6.5 判据①）
      const noteOk = !!view.note
        && view.note.indexOf(GRAPH_FACTS.layers + ' 条层带') >= 0
        && view.note.indexOf(GRAPH_FACTS.edges + ' 条边') >= 0
        && view.note.indexOf('本剖面不显示') >= 0;
      // 真鼠标点「切到全开剖面」⇒ 剖面真的变了（入口不是装饰）
      await clickEl(ctx, '#profile-switch-full', '窄剖面里的「切到全开剖面」入口');
      const afterSwitch = await profileNow(ctx);
      const switchWorks = afterSwitch === full;
      // 切回窄剖面，再**真的改点东西**（展开全部 ⇒ 序列化产物变 ⇒ 保存必须真写盘）
      await setProfile(ctx, narrow);
      await ctx.input.settle({ delayMs: 60 });
      await ctx.exec('(function () { var jm = window.MMApp.getState().jm; if (jm) jm.expand_all(); return true; })()');
      await ctx.input.settle({ delayMs: 80 });
      const dirtyBefore = await isDirty(ctx);
      await clickEl(ctx, '#btn-save', '工具栏「保存」');
      await ctx.input.settle({ delayMs: 300 });
      const st = await statusText(ctx);
      const dirtyAfter = await isDirty(ctx);
      const savedOk = /^已保存/.test(String(st || '')) && dirtyAfter === false;
      const afterText = readRaw(P_GRAPH);
      const gBefore = JSON.stringify(graphFixture().graph);
      const gAfter = graphSubtree(afterText);
      const graphSame = gAfter === gBefore;
      const treeKept = view.jmnodes >= 6;
      return {
        ok: !!opened && noteOk && view.btnShown && view.btnHitSelf && switchWorks
          && treeKept && view.drawn >= 3 && view.graphRenders === 0
          && dirtyBefore === true && savedOk && graphSame,
        text: '剖面=' + view.profile + ' · 树节点=' + view.jmnodes + '（可见的 ' + view.drawn + ' 个：打开只展开根）'
          + ' · 图渲染层=' + view.graphRenders + '（0 = 本轮的画布只画树）'
          + ' · 提示="' + String(view.note || '').slice(0, 90) + '"（计数对=' + noteOk + '）'
          + ' · 切回入口：可见=' + view.btnShown + ' 中心命中的是自己=' + view.btnHitSelf
          + '（命中=' + view.btnHitTag + '）'
          + ' · 点入口后剖面=' + afterSwitch + '（=全开 ' + switchWorks + '）'
          + ' · 保存前 dirty=' + dirtyBefore + ' 保存后 dirty=' + dirtyAfter + ' 状态栏="' + String(st || '').slice(0, 24) + '"'
          + ' · graph 子树逐字节不变=' + graphSame
      };
    }
  },

  {
    name: '丁 全开剖面打开**纯树**项目：派生布局在（画布上真有非零几何的节点 ≥3，**渲染器无关** —— '
      + 'MS3 起全开剖面用的是 SVG 渲染器，只数 jmnode 会把"画得好好的"判成红）、两套渲染器**不同时可见**、'
      + '盘上 sha256 不变、isDirty 仍 false、序列化产物里**没有** graph 键；剖面来回切也不写盘、不新增键',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      const full = fullProfileOf(doc);
      const narrow = narrowProfileOf(doc);
      await setProfile(ctx, full);
      await ctx.input.settle({ delayMs: 60 });
      const beforeText = readRaw(P_TREE);
      const beforeSha = sha256(beforeText);
      const keySets = (t) => { const o = JSON.parse(t); return { top: Object.keys(o).sort(), meta: Object.keys(o.meta || {}).sort() }; };
      const keysBefore = keySets(beforeText);
      const opened = await openProject(ctx, P_TREE);
      const geom = await ctx.exec(NODE_GEOM + ';');
      const ser = await ctx.exec('(function () { var s = window.MMApp.serializeTree();'
        + ' return { hasGraphKey: Object.prototype.hasOwnProperty.call(s, "graph"),'
        + '   dirty: window.MMApp.isDirty(),'
        + '   topKeys: Object.keys(s).sort(), metaKeys: Object.keys(s.meta || {}).sort() }; })()');
      // 剖面来回切（窄 → 全）：切剖面是**视图选择**，不许改数据
      await setProfile(ctx, narrow);
      await ctx.input.settle({ delayMs: 60 });
      await setProfile(ctx, full);
      await ctx.input.settle({ delayMs: 60 });
      const afterSha = sha256(readRaw(P_TREE));
      const keysAfter = keySets(readRaw(P_TREE));
      const expectTop = keysBefore.top.filter((k) => k !== 'graph');
      /* "派生布局在"的判据：**画面上真渲染出来的那些节点**都有非零矩形（布局给了每一下坐标），
       * 且节点全套（含折叠着的）都在 DOM 里 —— ⚠️ **不能**要求"每个节点都有矩形"：
       * 折叠着的节点本来就没有几何（`display:none`），那是正确状态，把它判红就是假红。
       * （第一版就是那么写的，实测：打开只展开根 ⇒ 7 个节点里只有 3 个有矩形。）
       * ⚠️ MS3 起"全开剖面"用 SVG 渲染器 ⇒ 几何**取两套渲染器的大者**（jmnode 那一刻是隐藏的），
       * 并另判"两套不同时可见"——那是双渲染器最容易出的坏结果。 */
      return {
        ok: !!opened && geom.jmCount >= 7 && geom.drawn >= 3 && geom.bothVisible === false
          && ser.hasGraphKey === false && ser.dirty === false
          && beforeSha === afterSha
          && same(keysBefore.top, keysAfter.top) && same(keysBefore.meta, keysAfter.meta)
          && same(ser.topKeys, expectTop) && same(ser.metaKeys, keysBefore.meta),
        text: '剖面=' + full + ' · 树里的节点=' + geom.jmCount + ' · 当前在画的是 **' + geom.renderer
          + '** 渲染器，可见节点 ' + geom.drawn + ' 个（jmnode ' + geom.jmDrawn + ' / SVG ' + geom.svgDrawn
          + '；其余是折叠着的，本来就没有几何）· 两套同时可见=' + geom.bothVisible + '（必须 false）'
          + ' · 序列化产物有 graph 键=' + ser.hasGraphKey + '（必须 false：渲染层不管图附加层）'
          + ' · isDirty=' + ser.dirty
          + ' · 盘上 sha256 ' + beforeSha.slice(0, 8) + '→' + afterSha.slice(0, 8) + '（不变=' + (beforeSha === afterSha) + '）'
          + ' · 顶层键 ' + JSON.stringify(keysBefore.top) + ' / meta 键 ' + JSON.stringify(keysBefore.meta)
          + '（切剖面后逐项相同=' + (same(keysBefore.top, keysAfter.top) && same(keysBefore.meta, keysAfter.meta)) + '）'
      };
    }
  },

  {
    name: '戊 两剖面交替打开同一项目：`meta.nodeOffsets` 是**共用的** —— 树渲染器里写一条偏移（落盘）⇒'
      + '切到全开剖面（**图渲染器**，不重开）后，同一个节点在**画布坐标**里的位移 === 偏移值'
      + '（清掉偏移/加回偏移各重画一次对比）；重开项目后仍在；偏移桶只有一项、盘上不冒出第二个坐标键',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）⇒ 真鼠标判据跑不了' };
      const doc = docMatrix();
      const full = fullProfileOf(doc);
      const narrow = narrowProfileOf(doc);
      const OFFSET = { x: 24, y: 32 };
      const applyOffsets = () => ctx.exec('(function () { return window.MMApp.setTreeOffsets(null, '
        + JSON.stringify({ [DEEP]: OFFSET }) + '); })()');
      const clearOffsets = () => ctx.exec('(function () { if (window.MM.clearTreeOffsets) window.MM.clearTreeOffsets();'
        + ' return true; })()');
      writeFixtures();                         // 丙 之后可能已被删（幂等重写）
      await setProfile(ctx, narrow);
      await ctx.input.settle({ delayMs: 60 });
      await openProject(ctx, P_TREE);
      /* 先展开整棵树再量：`d1` 在 t1 → p1 下面，而"打开只展开根"的归一让整棵子树收起
       * ⇒ 折叠着的 jmnode 没有几何，位移前后都会量到同一个常数（判据空转，实测踩过）。 */
      await expandAll(ctx);
      const base = await relToRoot(ctx, DEEP);
      if (!base) return { ok: false, text: '量不到 ' + DEEP + ' 相对根的位置（节点没渲染出来 ⇒ 后面的比较没有对象）' };
      if (!base.w || !base.h) {
        return { ok: false, text: DEEP + ' 没有几何（w=' + base.w + ' h=' + base.h + '）⇒ '
          + '它的"位移"量不到，本判据会空转 —— 必须先让它渲染出来（展开那棵子树）' };
      }
      const applied = await applyOffsets();
      await ctx.input.settle(PAINT);
      const offsetRect = await relToRoot(ctx, DEEP);
      /* ---- ① 树渲染器里的位移 === 偏移值（不是"至少挪了 8px"，是**逐轴相等**） ---- */
      const treeShift = { dx: offsetRect.dx - base.dx, dy: offsetRect.dy - base.dy };
      const treeOk = treeShift.dx === OFFSET.x && treeShift.dy === OFFSET.y;
      /* ---- 落盘（真鼠标点保存）：盘上只有一个偏移桶 ---- */
      await clickEl(ctx, '#btn-save', '工具栏「保存」');
      await ctx.input.settle({ delayMs: 300 });
      const stAfterSave = await statusText(ctx);
      const disk1 = readRaw(P_TREE);
      const o1 = JSON.parse(disk1);
      const offs1 = (o1.meta && o1.meta.nodeOffsets) || null;
      /* ---- ② 切到全开剖面（**图渲染器**，不重开）⇒ 同一份偏移在 SVG 画布坐标里也生效 ---- */
      await setProfile(ctx, full);
      await ctx.input.settle(PAINT);
      const svgWith = await svgRelToRoot(ctx, DEEP, 'root');
      await clearOffsets();
      await setProfile(ctx, narrow);            // 回树再进图 = 一次重画（剖面切换就是"数据变了"的入口）
      await ctx.input.settle({ delayMs: 60 });
      await setProfile(ctx, full);
      await ctx.input.settle(PAINT);
      const svgWithout = await svgRelToRoot(ctx, DEEP, 'root');
      const svgShift = (svgWith && svgWithout)
        ? { dx: svgWith.dx - svgWithout.dx, dy: svgWith.dy - svgWithout.dy } : null;
      const svgOk = !!svgShift && svgShift.dx === OFFSET.x && svgShift.dy === OFFSET.y;
      await applyOffsets();                     // 把内存里的偏移加回去（盘上那份一直没动过）
      /* ---- ③ 重开项目（全开剖面）⇒ 偏移仍在（内存 + 画布坐标逐项相同） ---- */
      await openProject(ctx, P_TREE);
      await expandAll(ctx);                     // 重开又收起了 ⇒ 再展开一次才量得到（同 base 那条理由）
      const rectReopened = await svgRelToRoot(ctx, DEEP, 'root');
      const offsetsAfterReopen = await ctx.exec('window.MMApp.getNodeOffsets()');
      const disk2 = readRaw(P_TREE);
      const o2 = JSON.parse(disk2);
      const hasGeom = (r) => !!r && r.w > 0 && r.h > 0;
      const sameAfterReopen = hasGeom(svgWith) && hasGeom(rectReopened)
        && rectReopened.dx === svgWith.dx && rectReopened.dy === svgWith.dy;
      const oneBucket = !!offs1 && Object.keys(offs1).length === 1
        && !!offs1[DEEP] && offs1[DEEP].x === OFFSET.x && offs1[DEEP].y === OFFSET.y;
      const keptInMemory = !!offsetsAfterReopen && !!offsetsAfterReopen[DEEP]
        && offsetsAfterReopen[DEEP].x === OFFSET.x && offsetsAfterReopen[DEEP].y === OFFSET.y;
      const noSecondStore = (o2.graph === undefined)
        && same(Object.keys(o2.meta || {}).sort(), Object.keys(o1.meta || {}).sort())
        && sha256(disk1) === sha256(disk2);
      return {
        ok: !!applied && hasGeom(offsetRect) && treeOk && oneBucket && svgOk && sameAfterReopen
          && keptInMemory && noSecondStore && /^已保存/.test(String(stAfterSave || '')),
        text: '剖面 ' + narrow + '→' + full + ' · **树渲染器**里位移=' + JSON.stringify(treeShift)
          + '（应 === ' + JSON.stringify(OFFSET) + ' ⇒ ' + treeOk + '；落盘 ' + applied + ' 条）'
          + ' · **图渲染器**画布坐标：带偏移=' + JSON.stringify(svgWith) + ' 清掉后=' + JSON.stringify(svgWithout)
          + ' ⇒ 位移=' + JSON.stringify(svgShift) + '（应 === ' + JSON.stringify(OFFSET) + ' ⇒ ' + svgOk + '）'
          + ' · 重开后=' + JSON.stringify(rectReopened) + '（与带偏移那次逐项相同=' + sameAfterReopen + '）'
          + ' · 盘上 meta.nodeOffsets=' + JSON.stringify(offs1) + '（只有一项=' + oneBucket + '）'
          + ' · 重开后内存里仍有它=' + keptInMemory
          + ' · 盘上没有第二个坐标键=' + noSecondStore + ' · 保存后状态栏="' + String(stAfterSave || '').slice(0, 16) + '"'
      };
    }
  },

  {
    name: '己 收尾：剖面回全开 / 清偏移 / 开回进来时那个项目 / 删两个夹具（自证不存在）/ 收模态 / 复位确认桩',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      const full = fullProfileOf(doc);
      await setProfile(ctx, full);
      await ctx.input.settle({ delayMs: 60 });
      await ctx.exec('(function () { if (window.MM.clearTreeOffsets) window.MM.clearTreeOffsets(); return true; })()');
      const cleaned = await mm.closeDialogs(ctx);
      const profile = await profileNow(ctx);
      // 先开回进来时那个项目（此时可能还是脏的 ⇒ 确认桩已经允许"丢弃改动"），再删夹具：
      // 反序会让"删一个正被 fs.watch 盯着的目录"在 Windows 上 EPERM（域 42 记过这一条）。
      let restored = null;
      if (PROJECT_WHEN_ENTERED) restored = await openProject(ctx, PROJECT_WHEN_ENTERED);
      const removed = rmFixtures();
      await stubConfirm(ctx, null);            // 复位成 window.confirm 本体
      const noteAfter = await ctx.exec('(function () { var el = document.getElementById("profile-note-text");'
        + ' return el ? el.textContent : null; })()');
      return {
        ok: profile === full && removed.gone && removed.removed && cleaned.n >= 0
          && (PROJECT_WHEN_ENTERED ? restored === true : true),
        text: '剖面=' + profile + '（=全开）· 夹具删除=' + removed.removed + '（自证不存在=' + removed.gone + '）'
          + ' · 收模态 ' + cleaned.n + ' 个 · 开回项目=' + JSON.stringify(PROJECT_WHEN_ENTERED)
          + '（' + restored + '）· 收尾后提示="' + String(noteAfter || '').slice(0, 60) + '"'
          + '（全开剖面会说"这一档在画图 + PNG 导出仍是缺口"；没有 graph 的**树形**剖面才是空的）'
      };
    }
  }
];

module.exports = assertions;
