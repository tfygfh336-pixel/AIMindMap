/* ============================================================
 * scripts/smoke/59-SVG内核接画布.js —— 【MS3】把 `src/diagram/` 的 SVG 内核接进画布（端到端）
 * ------------------------------------------------------------
 * 设计稿：`docs/DIAGRAM-MODES.md` §5.1（并存：树形剖面用 jsMind、图形剖面用新 SVG 渲染器）、
 *         §4.3（控件面由剖面生成）、§6.5（同一个项目能被两种模式打开）、§7.2 的 MS3 判据。
 *
 * 本域钉的是**用户能看见的那条差别**（十条）：
 *
 *  甲 **判据 1 + 6：图形剖面真的用 SVG 内核画**（不是树，也不是"自己算几个框"）。
 *     对**设计稿矩阵里 `C-F3-01` 判 ✓ 的三个剖面**各跑一次（期望值从 §3.2 的矩阵**现解析**，
 *     不从 `src/diagram/profiles.js` 取 —— 那是被测实现，拿它当期望就是恒等假绿）：
 *       · 画布里出现 `svg[data-mm="diagram"]` 且**真有几何**（宽高 > 0）；
 *       · **`text` ≥ 1**，且**每种"出现的形状"都有对应元素**（`cylinder→path`、`diamond→polygon`、其余 `→rect`）；
 *       · **jsMind 的节点一个都不可见**（`jmnode` 的 `getClientRects()` 全空）—— "换了渲染器"
 *         不是"叠了一层"；
 *       · `g[data-node]` 的个数 === 夹具里**展开可见**的节点数（现算）—— 抓"只画了根"这类假图；
 *       · **形状按 §4.2 的允许集判两面**（允许集从 §4.2 的 `C-F1-01` 那一行**现解析**）：
 *         ① 实际形状 ⊆ 该剖面允许集（收窄真的收住）；② 允许集内每种至少出现一次（收窄没砍过头）。
 *         另：`complex`（唯一全开剖面）**单独**要求"六种形状各至少一个" —— `C-F1-01` 的
 *         **内核能力**挂在这档上验，不挂到别的剖面上（见 `docShapeLimits` 的注释：这条口径订正过）；
 *       · **层带/容器按剖面矩阵开**：`C-F2-04` 判 ✗ 的剖面（逻辑链路）`g[data-z="layers"]` 里 0 条，
 *         判 ✓ 的（架构图/全开）≥ 1 条 —— 同一份数据、不同剖面看到不同东西；
 *       · **双向箭头来自数据**（第二份夹具带 `graph.edges[].arrow.start`）⇒ `polygon[data-arrow="start"]`
 *         ≥ 1 且 `end` 也 ≥ 1（两端独立）。
 *
 *  乙 **判据 2：切回树形剖面 ⇒ jsMind 回来、SVG 被移除**（不留残影）：`svg` 数 === 0、
 *     `#diagram-host` 里 `innerHTML` 为空且 `hidden`、`#mindmap-container` 没有图渲染层的类、
 *     `jmnode` 真有几何（≥ 3 个可见）。
 *
 *  丙 **判据 3：层带确实在节点之下 —— 判的是 SVG 里的**元素顺序**，不是"看起来"**：
 *     `g[data-z]` 在 `<svg>` 里的出现顺序逐字等于 `layers, containers, nodes, edges, edgeLabels,
 *     annotations`（设计稿 §7.2 的 z-order 契约），且 `layers` 的下标 **<** `nodes` 的下标。
 *     ⚠️ 判据读的是 DOM 子元素顺序，不读内核自报的 `report.zOrder`。
 *
 *  丁 **判据 4：边不穿节点框 —— 用产出几何独立复算**（不读内核的 report）：
 *     逐边读 `data-points`（理想折线），逐节点读 `data-x/y/w/h`，两端节点**豁免**（端口锚点就在边框上），
 *     其余节点做"线段 × 矩形内部"判定（Liang–Barsky，框内缩 0.5px ⇒ 贴边不算穿）。
 *     违反数必须 === 0。**防空转**：受检的 (边, 节点) 对数必须 > 0，且把一条人为平移到节点中心上的
 *     折线喂给**同一个判定函数**必须判出违反（判别力自检，每次运行都跑）。
 *
 *  戊 **判据 5：数据只有一份** —— 树↔图来回切 5 轮：`isDirty()` 仍 false、盘上 sha256 不变、
 *     序列化产物里没有 `graph` 键、顶层键集与 `meta` 键集逐项相同。**每轮都判**（不是只在末尾判）。
 *
 *  己 **判据 7：缩放/平移后几何一致**（容差 < 1px）：
 *     真鼠标点页脚的「放大」⇒ 用**节点自己的宽度比**现算缩放因子 s（不读产品的 zoom 读数），
 *     判两节点屏幕间距的缩放后值 === s × 缩放前值；
 *     真鼠标在空白处拖动 ⇒ 每个节点都按同一位移平移（两两间距逐项不变）。
 *
 *  庚 **判据 8：提示口径与事实一致**：三个图形剖面的提示里 **不出现**「尚未接界面」，
 *     且必须**点名**仍然缺的那一档导出（`PNG` 与「缺口」）；树形剖面 + 盘上带 `graph` 的项目
 *     仍然说「本剖面不显示」（§6.5 判据①），且四类计数与夹具逐项相同。
 *
 *  辛 **判据 9：jsMind 未被修改**（vendored：一个字节都不许动）：`renderer/vendor/` 下
 *     `git status --porcelain` 为空，且 `jsmind.js` / `jsmind.css` 的 sha256 与 **HEAD 里那份**逐字节相同。
 *
 *  壬 收尾：剖面回进入时那一档 / 删两个夹具（自证不存在）/ 开回进来时那个项目 / 收模态 / 复位确认桩。
 *
 * ⚠️ 判别力证明（"临时改产品代码那一轮"，每处都记 SHA-256 + 字节数并用**原始 Buffer** 逐字节还原）：
 *   ① 把 `syncCanvasRenderer` 的"切到图"那一支改成直接 `return`（= 只切剖面不换渲染器）⇒ 甲/乙红；
 *   ② 把 `capDrawsGraph` 改成恒 false ⇒ 甲红（且乙照旧绿 —— 证明判别力在"图那半边"）；
 *   ③ 把层带那一组从 `<svg>` 里挪到 `nodes` 之后（改 `Z_ORDER` 的顺序）⇒ 丙红；
 *   ④ 把 `route.routeAll` 的障碍清空（节点不当障碍）⇒ 丁红；
 *   ⑤ 在 `applyCapSurface` 里加一句 `MM.save()`（切剖面顺手写盘）⇒ 戊红；
 *   ⑥ 把 `diagramApplyTransform` 的 `scale` 去掉 ⇒ 己红；
 *   ⑦ 把提示文案改回"尚未接界面" ⇒ 庚红；
 *   ⑧ 给 `renderer/vendor/jsmind.js` 末尾加一个字节 ⇒ 辛红。
 *   读数与注入记录：`.review/20261065-MS3接界面/`。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const mm = require('../smoke-assertions.js');
/* 夹具的落盘走**产品自己的写盘出口**（`src/data-store.js` 的 `writeFileAtomic`）——
 * 理由与域 58 同一份（本域也读设计稿 ⇒ S2 的判定④ 会把它当成"可能在写受管资产"）。 */
const { writeFileAtomic } = require('../../src/data-store.js');
/* 夹具必须**合法**：`items` 是 v3 的**真源**，落盘时 `detail` 必须逐字节等于 `renderDetail(items)`
 * （契约 §2）。⚠️ 本域第一版手写了 `items: []` 却不给 `detail` ⇒ **项目 JSON 不合法**，
 * 表现是"界面上一切正常、但任何一次保存都被写盘验证拦下" —— 那让"切剖面顺手写盘"那处注入
 * **造不出任何痕迹**（判据 5 因此假绿过一回，见 `.review/20261065-MS3接界面/README.md`）。
 * ⇒ 这里用**产品自己的** `renderDetail` 现算，并在落盘前用产品自己的 `validateProject` 验一遍。 */
const itemModel = require('../../src/item-model.js');
const projectSchema = require('../../src/schema.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'DIAGRAM-MODES.md');
const VENDOR = path.join(ROOT, 'renderer', 'vendor');

const P_TREE = 'zz-ms3-tree';
const P_DATA = 'zz-ms3-data';

let ENTRY_PROJECT = '';
let ENTRY_PROFILE = '';

/* ================= 盘上真值 ================= */

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

/** 从 `docs/DIAGRAM-MODES.md` §3.2 的 `matrix:begin/end` 块里现解析列名与逐格记号。 */
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

/** 某个剖面某条能力的记号（✓ / ○ / ✗） */
function markOf(doc, profile, cap) {
  const row = doc.rows.filter((r) => r.id === cap)[0];
  if (!row) throw new Error('矩阵里没有能力 ' + cap + '（判据的前提不成立）');
  return row.marks[doc.profiles.indexOf(profile)];
}

/* ================= 取值收窄的期望值：也从**设计稿**解析（§4.2） =================
 *
 * 为什么需要它（2026-10-30 收口批的口径订正，原判据错了，记在这里防复发）：
 *   本域甲原先断言"**每个**图形剖面里六种形状各至少一个"。那条把**内核能力**（C-F1-01 真有六种几何）
 *   挂在了**某个剖面**上 —— 而 §4.2 明写 `logic` 只给 `rect/round/diamond`（其余三型不给）。
 *   ⇒ 一旦真按 §4.2 收窄，`logic` 必然缺 `cylinder/pill/row`（而且 `path` 元素也没了：
 *     六型里只有 `cylinder` 画成 `<path>`），于是**判据把"按设计收窄"判成了"能力缺失"**。
 *   ⇒ 正确口径（本域现在这一版）：
 *     · **内核能力**挂在 `complex` 上验（它是唯一全开剖面，§3.4 不变量①）⇒ 六型各至少一个；
 *     · **剖面收窄**验"形状 ⊆ 该剖面允许集，且允许集内每种至少出现一次"。
 *   允许集**从 §4.2 的 `C-F1-01` 那一行现解析**（不从 `src/diagram/profiles.js` 取 —— 那是被测实现）。
 */
const ALL_SHAPES = ['rect', 'round', 'diamond', 'pill', 'cylinder', 'row'];

function docShapeLimits() {
  const md = fs.readFileSync(DOC, 'utf8');
  const sec = md.indexOf('### 4.2');
  if (sec < 0) throw new Error('docs/DIAGRAM-MODES.md 里找不到 §4.2（取值收窄）');
  const end = md.indexOf('\n### 4.3', sec);
  const block = md.slice(sec, end > sec ? end : md.length);
  const row = block.split(/\r?\n/).filter((l) => l.indexOf('`C-F1-01`') >= 0)[0];
  if (!row) throw new Error('§4.2 里找不到 `C-F1-01`（六形状）那一行');
  const narrowed = {};
  const profs = [];
  let m;
  const reP = /`(complex|mindmap|path|logic|module)`/g;
  while ((m = reP.exec(row))) if (profs.indexOf(m[1]) < 0) profs.push(m[1]);
  const shapes = [];
  const reS = /`(rect|round|diamond|pill|cylinder|row)`/g;
  while ((m = reS.exec(row))) if (shapes.indexOf(m[1]) < 0) shapes.push(m[1]);
  if (!profs.length || !shapes.length) {
    throw new Error('§4.2 的 `C-F1-01` 行里读不出"哪个剖面被收窄到哪几型"：' + row.slice(0, 120));
  }
  profs.forEach((p) => { narrowed[p] = shapes.slice(); });     // 该行点名的剖面 = 被收窄的那几个
  return { all: ALL_SHAPES.slice(), narrowed: narrowed };
}

/** 某剖面允许的画法形状（§4.2 收窄了就用收窄集，否则六型全给） */
function shapeAllowOf(limits, profile) {
  return limits.narrowed[profile] ? limits.narrowed[profile].slice() : limits.all.slice();
}

/** 形状 → 它画出来的 SVG 元素种类（`render-svg.js` 的实现口径；判据只用来验"形状有元素"） */
const SHAPE_ELEMENT = {
  rect: 'rect', round: 'rect', pill: 'rect', row: 'rect',
  diamond: 'polygon', cylinder: 'path'
};

/** 图形剖面 = 矩阵里 `C-F3-01`（边端点 = "图"的最小单元）判 ✓ 的那些（按矩阵顺序） */
const graphProfiles = (doc) => doc.profiles.filter((p) => markOf(doc, p, 'C-F3-01') === '\u2713');

/* ================= 界面驱动的小工具 ================= */

const setProfile = (ctx, p) => ctx.exec('(function () { return window.MMApp.setCapProfile('
  + JSON.stringify(p) + '); })()');
const profileNow = (ctx) => ctx.exec('window.MMApp.capProfile()');
const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');

/** 打开一个项目。`MMApp.openProject` 是 async ⇒ `executeJavaScript` 会等它 resolve，
 *  也就是**渲染层整棵树建完**才返回（不需要再 settle —— 见 `tick` 的注释里那条实测）。 */
async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await tick(ctx, 40);
  return ok;
}

async function stubConfirm(ctx, answer) {
  await ctx.exec('window.MMApp.setConfirmStub('
    + (answer === null ? 'null' : 'function () { return ' + (answer ? 'true' : 'false') + '; }') + ')');
}

/** **便宜的"等一拍"** —— 刻意不用 `ctx.input.settle()`。
 *  实测（本域第一版）：`settle` 等的是**两个 rAF**，而离屏/隐藏窗口的 rAF 被节流到 ~0.5 fps
 *  ⇒ **单次 settle ≈ 2 s**（10 次 = 19.9 s，域耗时从 24 s 掉到 5 s 就是这一处）。
 *  这里只发一个 `setTimeout`：本域要等的都是"渲染层同步改完 DOM"这一类事（`setProfile` /
 *  `expandAll` / `click` 的处理体全是同步的），一拍够用；真需要真帧证据的地方另有像素判据（不在本域）。 */
async function tick(ctx, ms) {
  await ctx.exec('new Promise(function (res) { setTimeout(function () { res(1); }, '
    + (Number.isFinite(ms) ? ms : 40) + '); })');
}

/** 真鼠标点一个元素（先量屏幕矩形；量不到 ⇒ 抛，不静默当成"点过了"） */
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
  await tick(ctx, 60);
  return pt;
}

/** 打开夹具后把整棵树展开。为什么必须做：
 *  "打开项目只展开根"是产品的**视图归一**（域 41 的契约）⇒ 顶层主题被收起 ⇒ `serializeTree()` 里
 *  它们是 `expanded:false` ⇒ **派生规则①**（折叠节点的后代不进图）一算，10 个节点只画得出 3 个。
 *  ⚠️ 展开会让 `isDirty()` 变 true（`expanded` 是要落盘的数据）⇒ **判据 5 那一档不许调它**
 *  （那一档要的就是"打开就干净、切剖面也不脏"）。 */
async function expandAll(ctx) {
  await clickEl(ctx, '#btn-expand', '工具栏「展开」');
}

/* ================= 画布读数（**只读 DOM 与 SVG 属性**，不读产品的内部状态） ================= */

const CANVAS = `(function () {
  var cont = document.getElementById('mindmap-container');
  var host = document.getElementById('diagram-host');
  var svg = host ? host.querySelector('svg') : null;
  var out = {
    svgCount: document.querySelectorAll('svg[data-mm="diagram"]').length,
    hostHidden: !host || host.hasAttribute('hidden') || host.getClientRects().length === 0,
    hostEmpty: !host || host.innerHTML === '',
    diagramClass: !!(cont && cont.classList.contains('mm-diagram-on')),
    jmnodes: document.querySelectorAll('jmnode[nodeid]').length,
    jmnodesVisible: (function () {
      var n = 0;
      document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
        if (el.getClientRects().length > 0) n++;
      });
      return n;
    })()
  };
  if (!svg) { out.svg = false; return out; }
  out.svg = true;
  out.w = svg.width && svg.width.baseVal ? svg.width.baseVal.value : 0;
  out.h = svg.height && svg.height.baseVal ? svg.height.baseVal.value : 0;
  out.kinds = {};
  ['path', 'rect', 'text', 'polygon', 'line'].forEach(function (k) {
    out.kinds[k] = svg.querySelectorAll(k).length;
  });
  out.zOrder = [];
  Array.prototype.forEach.call(svg.children, function (el) {
    if (el.getAttribute && el.getAttribute('data-z')) out.zOrder.push(el.getAttribute('data-z'));
  });
  out.layerBands = svg.querySelectorAll('g[data-z="layers"] g[data-layer]').length;
  out.containers = svg.querySelectorAll('g[data-container]').length;
  out.arrows = {
    start: svg.querySelectorAll('polygon[data-arrow="start"]').length,
    end: svg.querySelectorAll('polygon[data-arrow="end"]').length
  };
  out.nodes = [];
  Array.prototype.forEach.call(svg.querySelectorAll('g[data-node]'), function (g) {
    out.nodes.push({
      id: g.getAttribute('data-node'),
      treeId: g.getAttribute('data-tree-id'),
      shape: g.getAttribute('data-shape'),
      x: parseFloat(g.getAttribute('data-x')), y: parseFloat(g.getAttribute('data-y')),
      w: parseFloat(g.getAttribute('data-w')), h: parseFloat(g.getAttribute('data-h'))
    });
  });
  out.edges = [];
  Array.prototype.forEach.call(svg.querySelectorAll('g[data-edge]'), function (g) {
    var pts = String(g.getAttribute('data-points') || '').split(' ').filter(Boolean).map(function (s) {
      var p = s.split(',');
      return [parseFloat(p[0]), parseFloat(p[1])];
    });
    out.edges.push({
      id: g.getAttribute('data-edge'), from: g.getAttribute('data-from'),
      to: g.getAttribute('data-to'), points: pts
    });
  });
  return out;
})()`;

/** 屏幕矩形（真帧几何用 getBoundingClientRect；画布坐标用 SVG 的 data-x/y） */
const nodeRects = (ids) => `(function () {
  var out = {};
  var ids = ${JSON.stringify(ids)};
  ids.forEach(function (id) {
    var el = document.querySelector('#diagram-host g[data-node][data-tree-id="' + id + '"]');
    if (!el) { out[id] = null; return; }
    var b = el.getBoundingClientRect();
    out[id] = { left: b.left, top: b.top, w: b.width, h: b.height,
      cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  });
  return out;
})()`;

/* ================= 丁 的判定本体（纯函数：线段 × 矩形内部） ================= */

/** Liang–Barsky：线段是否穿过矩形的**内部**（矩形先内缩 `shrink`，贴边不算穿）。 */
function segHitsRect(a, b, r, shrink) {
  const s = shrink === undefined ? 0.5 : shrink;
  const x0 = r.x + s, y0 = r.y + s;
  const x1 = r.x + r.w - s, y1 = r.y + r.h - s;
  if (x1 <= x0 || y1 <= y0) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - x0, x1 - a[0], a[1] - y0, y1 - a[1]];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return (t1 - t0) > 1e-6;
}

/**
 * 逐边 × 逐节点判"穿框"（**独立复算**：只吃 SVG 上的几何属性）。
 * @returns {{violations:Array, tested:number}}
 */
function edgeBoxViolations(canvas) {
  const violations = [];
  let tested = 0;
  const byId = {};
  canvas.nodes.forEach((n) => { byId[n.id] = n; });
  canvas.edges.forEach((e) => {
    const pts = e.points || [];
    if (pts.length < 2) return;
    canvas.nodes.forEach((n) => {
      if (n.id === e.from || n.id === e.to) return;      // 端口锚点就在边框上 ⇒ 两端豁免
      tested++;
      for (let i = 0; i + 1 < pts.length; i++) {
        if (segHitsRect(pts[i], pts[i + 1], n)) {
          violations.push({ edge: e.id, node: n.id, seg: i });
          break;
        }
      }
    });
  });
  return { violations: violations, tested: tested };
}

/* ================= 夹具 ================= */

function node(id, topic, expanded, kids, extra) {
  const n = { id: id, topic: topic, expanded: expanded };
  if (kids && kids.length) n.children = kids;
  return Object.assign(n, extra || {});
}

/** 夹具 1（**纯树**：没有 `graph` ⇒ 走派生那一路）。
 *  节点布局刻意让**六种形状**各出现一次：
 *   `cylinder` = 根 · `pill` = 带 tags · `row` = 带条目层（`items` + 派生出来的 `detail`）·
 *   `diamond` = 带 qa · `round` = 有子节点 · `rect` = 叶子。
 *  ⚠️ `items` / `qa` 两条都必须**按契约**写全（items 要 `type`、`detail` 要等于 `renderDetail(items)`；
 *  qa 要 `at` ISO 时间）—— 否则项目 JSON 不合法，而"不合法"在这套链路里的表现是
 *  **保存被静默拦下**（界面上看不出来），本域会跟着假绿。 */
function treeFixture() {
  const items = [{ id: 'i1', type: 'text', html: '<p>端口转发 8080→80</p>' }];
  return {
    meta: { name: P_TREE, author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    data: node('root', 'MS3 派生夹具（netfilter 三链）', true, [
      node('t1', '接入层', true, [
        node('a1', '防火墙规则', true, [node('a1x', '允许已建立连接', true, [])], { tags: ['netfilter'] }),
        node('a2', 'DNAT 表', true, [node('a2x', '端口转发 8080→80', true, [])],
          { items: items, detail: itemModel.renderDetail(items) })
      ]),
      node('t2', '转发层', true, [
        node('b1', '路由决策', true, [node('b1x', '查 FIB', true, [])],
          { qa: [{ q: '走哪条路？', a: '查 FIB', at: '2026-10-29T00:00:00.000Z' }] }),
        node('b2', 'FORWARD 链', true, [])
      ])
    ])
  };
}
const TREE_NODE_IDS = ['root', 't1', 'a1', 'a1x', 'a2', 'a2x', 't2', 'b1', 'b1x', 'b2'];

/** 夹具 2（**数据里的 graph**：导入/显式编辑那一档 ⇒ 双向箭头 / 数据层带 / 数据容器都从盘上来） */
function dataFixture() {
  return {
    meta: { name: P_DATA, author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    data: node('root', 'MS3 数据图层夹具', true, [
      node('x1', '甲', true, []), node('x2', '乙', true, []), node('x3', '丙', true, [])
    ]),
    graph: {
      version: 1, profile: 'complex', direction: 'LR', grid: 8,
      layers: [{ id: 'l-one', label: '数据层带', rect: [0, 0, 640, 120] }],
      containers: [{ id: 'k-one', label: '数据容器', rect: [0, 150, 320, 90], layout: 'free', children: ['x1', 'x2'] }],
      edges: [
        { id: 'e-ab', from: { node: 'x1', port: 'e' }, to: { node: 'x2', port: 'w' }, route: 'orthogonal',
          arrow: { start: true, end: true } },
        { id: 'e-bc', from: { node: 'x2' }, to: { node: 'x3' }, route: 'orthogonal', label: '主路径' }
      ]
    }
  };
}

function writeFixtures() {
  const t = treeFixture();
  const d = dataFixture();
  /* **夹具必须过产品自己的数据闸门**：不合法的话，"保存被拦下"会让"切剖面写盘"那一类判据
   * **什么都看不见**（本域第一版正是这么假绿过一回）。→ 现算 + 现验，一步都不许糊过去。 */
  [[P_TREE, t], [P_DATA, d]].forEach(function (pair) {
    const v = projectSchema.validateProject(pair[1]);
    if (!v.ok) throw new Error('夹具 ' + pair[0] + ' 不合法（' + v.errors.length + ' 条）：'
      + v.errors.slice(0, 4).join('；'));
  });
  fs.mkdirSync(projectDir(P_TREE), { recursive: true });
  writeFileAtomic(projectFile(P_TREE), JSON.stringify(t, null, 2) + '\n');
  fs.mkdirSync(projectDir(P_DATA), { recursive: true });
  writeFileAtomic(projectFile(P_DATA), JSON.stringify(d, null, 2) + '\n');
}

function rmFixtures() {
  let removed = false;
  try {
    fs.rmSync(projectDir(P_TREE), { recursive: true, force: true });
    fs.rmSync(projectDir(P_DATA), { recursive: true, force: true });
    removed = true;
  } catch (e) { removed = false; }
  const gone = [P_TREE, P_DATA].every((n) => {
    try { fs.readFileSync(projectFile(n), 'utf8'); return false; } catch (e) { return true; }
  });
  return { removed: removed, gone: gone };
}

/* ================= 断言 ================= */
const assertions = [

  {
    name: '甲 判据 1+6：矩阵里 C-F3-01 判 ✓ 的三个剖面**真的用 SVG 内核**（svg 有几何、'
      + 'text/需要的形状元素齐全、jsMind 节点一个都不可见、g[data-node] 数 === 夹具可见节点数、'
      + '形状 ⊆ §4.2 该剖面允许集且允许集内每种至少出现一次（`complex` 单独保住"六种各至少一个"＝内核能力）、'
      + '层带/容器按矩阵 ✗/✓ 开关）＋ 数据里的 graph 优先（双向箭头两端都有）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）⇒ 真鼠标判据跑不了' };
      ENTRY_PROJECT = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return s && s.project ? s.project.name : ""; })()') || '';
      ENTRY_PROFILE = await profileNow(ctx);
      await stubConfirm(ctx, true);
      const doc = docMatrix();
      const limits = docShapeLimits();
      const graphs = graphProfiles(doc);
      if (graphs.length !== 3) {
        return { ok: false, text: '矩阵里 C-F3-01 判 ✓ 的剖面有 ' + graphs.length + ' 个（应为 3：全开/逻辑/架构）'
          + ' ⇒ 判据的前提不成立：' + JSON.stringify(graphs) };
      }
      writeFixtures();
      await setProfile(ctx, graphs[0]);
      const opened = await openProject(ctx, P_TREE);
      await expandAll(ctx);          // 夹具要**整棵**进图（见 expandAll 的注释）
      const fails = [];
      const rows = [];
      {
        for (const p of graphs) {
          const set = await setProfile(ctx, p);
          if (!set || !set.ok) { fails.push(p + ' 切剖面失败：' + ((set && set.reason) || '未知')); continue; }
          const cv = await ctx.exec(CANVAS);
          if (!cv || !cv.svg || cv.svgCount !== 1) {
            fails.push(p + ' 画布里没有 svg[data-mm="diagram"]（svg 数=' + (cv && cv.svgCount) + '）'
              + ' ⇒ 这一档**没有换渲染器**');
            continue;
          }
          const kinds = cv.kinds || {};
          // `text` 恒需要（每个节点都有标题）；其余元素种类由"该剖面允许的形状"推出来
          if (!(kinds.text > 0)) fails.push(p + ' 的 SVG 里没有 text（元素种类不齐）');
          if (!(cv.w > 0 && cv.h > 0)) fails.push(p + ' 的 svg 没有几何（w/h=' + cv.w + '/' + cv.h + '）');
          if (cv.jmnodesVisible !== 0) {
            fails.push(p + ' 下 jsMind 还有 ' + cv.jmnodesVisible + ' 个节点**可见** ⇒ 那是"叠了一层"，不是换渲染器');
          }
          const nodeCount = (cv.nodes || []).length;
          if (nodeCount !== TREE_NODE_IDS.length) {
            fails.push(p + ' 的 g[data-node] 数 = ' + nodeCount + '（夹具里有 '
              + TREE_NODE_IDS.length + ' 个展开可见的节点）⇒ 图没画全/画多了');
          }
          /* 形状：**按 §4.2 的允许集**判两件事（缺一条就红）：
           *   ① 子集：实际出现的形状 ⊆ 该剖面允许集（收窄必须真的收住 —— 不许再出现 `cylinder/pill/row` 在 `logic` 里）；
           *   ② 覆盖：允许集里**每一种**至少出现一次（收窄不许顺手把该留的也砍掉 —— 这正是上一版把域打红的那类错）；
           * 另外 `complex` **单独**保住"六种各至少一个"：它是唯一全开剖面（§3.4 不变量①），
           *   `C-F1-01`（内核真有六种几何）这条**能力**挂在这一档上验，不挂在别的剖面上。
           * 元素种类由"出现的形状"推出来（只有 `cylinder` 画 `<path>`、`diamond` 画 `<polygon>`）——
           * 不再无脑要求 `path/polygon` 齐全：那等于要求每个剖面都画柱体和菱形，与 §4.2 冲突。 */
          const shapes = Array.from(new Set((cv.nodes || []).map((n) => n.shape))).sort();
          const allowed = shapeAllowOf(limits, p);
          const outside = shapes.filter((s) => allowed.indexOf(s) < 0);
          if (outside.length) {
            fails.push(p + ' 出现了 §4.2 **不允许**的形状：' + JSON.stringify(outside)
              + '（允许 ' + JSON.stringify(allowed) + '，实际 ' + JSON.stringify(shapes) + '）');
          }
          const missing = allowed.filter((s) => shapes.indexOf(s) < 0);
          if (missing.length) {
            fails.push(p + ' 的允许集里有形状**一个都没画**：' + JSON.stringify(missing)
              + '（允许 ' + JSON.stringify(allowed) + '，实际 ' + JSON.stringify(shapes) + '）');
          }
          shapes.forEach((s) => {
            const el = SHAPE_ELEMENT[s];
            if (el && !(kinds[el] > 0)) {
              fails.push(p + ' 画了 ' + s + ' 却连一个 <' + el + '> 都没有（形状与元素对不上）');
            }
          });
          if (p === 'complex') {
            const miss6 = limits.all.filter((s) => shapes.indexOf(s) < 0);
            if (miss6.length) {
              fails.push('complex（全开剖面）缺这几种形状：' + JSON.stringify(miss6)
                + '（实际 ' + JSON.stringify(shapes) + '）⇒ `C-F1-01` 六种几何的内核能力这条挂了');
            }
          }
          // 层带/容器：**按矩阵**（判 ✗ 的那条一条都不许进 doc）
          const wantLayers = markOf(doc, p, 'C-F2-04') === '\u2713';
          if (wantLayers && !(cv.layerBands > 0)) fails.push(p + ' 矩阵判 ✓ 层带（C-F2-04），但 SVG 里 0 条');
          if (!wantLayers && cv.layerBands !== 0) {
            fails.push(p + ' 矩阵判 ✗ 层带（C-F2-04），SVG 里却有 ' + cv.layerBands + ' 条 ⇒ 剖面没管住能力');
          }
          const wantContainers = markOf(doc, p, 'C-F2-01') === '\u2713';
          if (wantContainers && !(cv.containers > 0)) fails.push(p + ' 矩阵判 ✓ 容器（C-F2-01），但 SVG 里 0 个');
          if (!wantContainers && cv.containers !== 0) {
            fails.push(p + ' 容器在该剖面不是 ✓，SVG 里却有 ' + cv.containers + ' 个');
          }
          rows.push(p + ': 节点=' + nodeCount + ' 形状=' + shapes.join('/') + ' 层带=' + cv.layerBands
            + ' 容器=' + cv.containers + ' path=' + kinds.path + ' polygon=' + kinds.polygon
            + ' jsMind可见=' + cv.jmnodesVisible);
        }
      }
      /* 第二份夹具：盘上带 `graph`（导入/显式编辑那一路）⇒ 双向箭头 / 数据层带 / 数据容器都从数据来 */
      await setProfile(ctx, graphs[0]);
      const opened2 = await openProject(ctx, P_DATA);
      const cv2 = await ctx.exec(CANVAS);
      const dataOk = !!cv2 && cv2.svg === true && cv2.arrows.start >= 1 && cv2.arrows.end >= 1
        && cv2.layerBands >= 1 && cv2.containers >= 1;
      if (!dataOk) {
        fails.push('数据里的 graph 没被优先采用：' + JSON.stringify({
          svg: cv2 && cv2.svg, arrows: cv2 && cv2.arrows, layers: cv2 && cv2.layerBands,
          containers: cv2 && cv2.containers
        }) + '（期望：两端箭头各 ≥1、数据层带 ≥1、数据容器 ≥1）');
      }
      return {
        ok: !!opened && !!opened2 && fails.length === 0,
        text: (fails.length ? '✗ ' + fails.join(' ｜ ') + ' ｜ ' : '')
          + '三剖面读数：' + rows.join(' · ')
          + ' ｜ 数据图夹具：两端箭头 ' + (cv2 && cv2.arrows ? cv2.arrows.start + '/' + cv2.arrows.end : '?')
          + '、层带 ' + (cv2 && cv2.layerBands) + '、容器 ' + (cv2 && cv2.containers)
          + ' ｜ 期望值来源=docs/DIAGRAM-MODES.md §3.2 现解析（C-F3-01 / C-F2-04 / C-F2-01）'
      };
    }
  },

  {
    name: '乙 判据 2：切回树形剖面 ⇒ **jsMind 回来、SVG 被移除**（svg 数 === 0、#diagram-host 清空且 hidden、'
      + '图渲染层的类被摘掉、jmnode 真有几何 ≥3）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      const trees = doc.profiles.filter((p) => markOf(doc, p, 'C-F3-01') === '\u2717');
      const tree = trees[0];
      await setProfile(ctx, ENTRY_PROFILE || doc.profiles[0]);
      await openProject(ctx, P_TREE);
      // 先确认"现在真的是图"（否则下面的"消失了"是空转）
      await setProfile(ctx, graphProfiles(doc)[0]);
      const before = await ctx.exec(CANVAS);
      await setProfile(ctx, tree);
      const after = await ctx.exec(CANVAS);
      const okBefore = !!before && before.svg === true && before.svgCount === 1;
      return {
        ok: okBefore && after.svgCount === 0 && after.svg === false && after.hostEmpty === true
          && after.hostHidden === true && after.diagramClass === false && after.jmnodesVisible >= 3,
        text: '切前：svg=' + (before && before.svgCount) + ' jsMind 可见=' + (before && before.jmnodesVisible)
          + '（图那半边成立=' + okBefore + '）'
          + ' ｜ 切到树形剖面 ' + tree + ' 后：svg=' + after.svgCount + ' host 空=' + after.hostEmpty
          + ' host 隐藏=' + after.hostHidden + ' 图类=' + after.diagramClass
          + ' jsMind 可见=' + after.jmnodesVisible + '（判据：0 / 空 / 隐藏 / false / ≥3）'
      };
    }
  },

  {
    name: '丙 判据 3：**层带确实在节点之下** —— 判 SVG 里 g[data-z] 的**元素顺序**逐字等于 '
      + 'layers,containers,nodes,edges,edgeLabels,annotations，且 layers 的下标 < nodes 的下标（不读内核自报的 report）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      await setProfile(ctx, graphProfiles(doc)[0]);
      const cv = await ctx.exec(CANVAS);
      if (!cv || cv.svg !== true) return { ok: false, text: '画布里没有 SVG ⇒ 没有可判的顺序' };
      const want = ['layers', 'containers', 'nodes', 'edges', 'edgeLabels', 'annotations'];
      const got = cv.zOrder || [];
      const same = got.length === want.length && got.every((z, i) => z === want[i]);
      const iLayers = got.indexOf('layers');
      const iNodes = got.indexOf('nodes');
      const orderOk = iLayers >= 0 && iNodes >= 0 && iLayers < iNodes;
      return {
        ok: same && orderOk,
        text: 'g[data-z] 顺序=' + JSON.stringify(got) + '（期望 ' + JSON.stringify(want) + '）'
          + ' · layers 下标=' + iLayers + ' < nodes 下标=' + iNodes + ' ⇒ ' + orderOk
          + ' · 逐字相同=' + same
      };
    }
  },

  {
    name: '丁 判据 4：**边不穿无关节点框** —— 只吃 SVG 上的 data-points 与 data-x/y/w/h 独立复算'
      + '（Liang–Barsky，两端节点豁免），违反数 === 0；且受检对数 > 0 并**自检判别力**'
      + '（把一条折线人为挪进节点中心 ⇒ 同一个判定函数必须报出违反）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      await setProfile(ctx, graphProfiles(doc)[0]);
      const cv = await ctx.exec(CANVAS);
      if (!cv || cv.svg !== true) return { ok: false, text: '画布里没有 SVG ⇒ 没有可判的几何' };
      if (!cv.edges || !cv.edges.length) return { ok: false, text: '图里一条边都没有 ⇒ 这条判据会空转' };
      const real = edgeBoxViolations(cv);
      /* **判别力自检**（每次运行都跑）：把第一条边的折线平移到某个**无关节点**的中心上
       * ⇒ 同一个判定函数必须报出违反。不这么做的话，"0 违反"可能只是"没测到"。 */
      const probeNodes = cv.nodes.filter((n) => n.id !== cv.edges[0].from && n.id !== cv.edges[0].to);
      let selfCheck = { violations: [], tested: 0 };
      if (probeNodes.length) {
        const target = probeNodes[0];
        const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
        const fake = JSON.parse(JSON.stringify(cv));
        const p0 = fake.edges[0].points[0];
        fake.edges[0].points = fake.edges[0].points.map((pt) => [pt[0] - p0[0] + cx, pt[1] - p0[1] + cy]);
        fake.edges = [fake.edges[0]];
        selfCheck = edgeBoxViolations(fake);
      }
      return {
        ok: real.violations.length === 0 && real.tested > 0 && selfCheck.violations.length > 0,
        text: '边 ' + cv.edges.length + ' 条 × 节点 ' + cv.nodes.length + ' 个 ⇒ 受检 '
          + real.tested + ' 对（两端豁免）· 穿框违反 ' + real.violations.length + ' 处'
          + (real.violations.length ? '：' + JSON.stringify(real.violations.slice(0, 5)) : '')
          + ' · 判别力自检：把一条边挪进节点中心后报出 ' + selfCheck.violations.length + ' 处（必须 > 0）'
      };
    }
  },

  {
    name: '戊 判据 5：**数据只有一份** —— 树↔图来回切 5 轮，**每轮**判 isDirty() 仍 false、盘上 sha256 不变；'
      + '序列化产物里没有 graph 键、顶层键集与 meta 键集逐项相同',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      const graphs = graphProfiles(doc);
      const tree = doc.profiles.filter((p) => markOf(doc, p, 'C-F3-01') === '\u2717')[0];
      await setProfile(ctx, tree);
      await openProject(ctx, P_TREE);
      const before = sha256(readRaw(P_TREE));
      /* ⚠️ **为什么还要 mtime**（本域第一版漏了这一步，被注入抓了个正着）：
       * "切剖面顺手保存"**写回去的字节完全一样**（数据没变）⇒ `sha256` 与 `isDirty()` 都看不出写盘 ✗
       * （实测：`save-on-profile-switch` 那处注入下 戊 照旧绿）。文件系统不撒谎：写一次 mtime 就变
       * ⇒ 判据里必须有它。这就是本工程那句"丙抓不到界面开始写 graph，由丁抓"的同型教训。 */
      const mtimeOf = () => fs.statSync(projectFile(P_TREE)).mtimeMs;
      const mtimeBefore = mtimeOf();
      const keysOf = (t) => { const o = JSON.parse(t); return { top: Object.keys(o).sort(), meta: Object.keys(o.meta || {}).sort() }; };
      const keysBefore = keysOf(readRaw(P_TREE));
      const rounds = [];
      const t = { switchToGraph: 0, switchToTree: 0, settle: 0, exec: 0 };
      let bad = null;
      let switchedToGraph = 0;
      for (let i = 0; i < 5; i++) {
        const p = graphs[i % graphs.length];
        let tA = Date.now();
        await setProfile(ctx, p);
        t.switchToGraph += Date.now() - tA;
        tA = Date.now();
        t.settle += Date.now() - tA;
        tA = Date.now();
        const cv = await ctx.exec(CANVAS);
        t.exec += Date.now() - tA;
        if (cv && cv.svg === true) switchedToGraph++;
        const d1 = await isDirty(ctx);
        tA = Date.now();
        await setProfile(ctx, tree);
        t.switchToTree += Date.now() - tA;
        tA = Date.now();
        t.settle += Date.now() - tA;
        const d2 = await isDirty(ctx);
        const now = sha256(readRaw(P_TREE));
        const mtimeNow = mtimeOf();
        rounds.push(i + 1 + ':' + p + '/dirty=' + d1 + ',' + d2 + '/sha=' + now.slice(0, 8)
          + '/mtime=' + (mtimeNow === mtimeBefore ? '未变' : '**变了**'));
        if (d1 !== false || d2 !== false || now !== before || mtimeNow !== mtimeBefore) {
          bad = '第 ' + (i + 1) + ' 轮（' + p + '）：dirty=' + d1 + '/' + d2
            + ' sha ' + before.slice(0, 8) + '→' + now.slice(0, 8)
            + ' mtime ' + mtimeBefore + '→' + mtimeNow + '（写盘了）';
          break;
        }
      }
      const ser = await ctx.exec('(function () { var s = window.MMApp.serializeTree();'
        + ' return { hasGraph: Object.prototype.hasOwnProperty.call(s, "graph"),'
        + '   top: Object.keys(s).sort(), meta: Object.keys(s.meta || {}).sort(), dirty: window.MMApp.isDirty() }; })()');
      const keysAfter = keysOf(readRaw(P_TREE));
      const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      return {
        ok: !bad && switchedToGraph === 5 && ser.hasGraph === false && ser.dirty === false
          && mtimeOf() === mtimeBefore
          && sameList(keysBefore.top, keysAfter.top) && sameList(keysBefore.meta, keysAfter.meta)
          && sameList(ser.top, keysBefore.top),
        text: (bad ? '✗ ' + bad + ' ｜ ' : '') + '5 轮读数：' + rounds.join(' ')
          + ' ｜ 切到图渲染器的轮数=' + switchedToGraph + '（5 = 每轮真的换了渲染器，判据不空转）'
          + ' ｜ 耗时分解：切到图 ' + t.switchToGraph + 'ms · 切回树 ' + t.switchToTree
          + 'ms · settle ' + t.settle + 'ms · 读 DOM ' + t.exec + 'ms'
          + ' ｜ 盘上 mtime ' + (mtimeOf() === mtimeBefore ? '全程未变（= 一次都没写）' : '**变了**（写盘了）')
          + ' ｜ 序列化产物有 graph 键=' + ser.hasGraph + '（必须 false）'
          + ' ｜ 顶层键 ' + JSON.stringify(keysBefore.top) + ' / meta 键 ' + JSON.stringify(keysBefore.meta)
          + '（切完逐项相同=' + (sameList(keysBefore.top, keysAfter.top) && sameList(keysBefore.meta, keysAfter.meta)) + '）'
      };
    }
  },

  {
    name: '己 判据 7：缩放/平移后**几何一致**（容差 < 1px）—— 真鼠标点「放大」后用**节点自己的宽度比**'
      + '现算缩放因子 s，判两节点屏幕间距 === s × 缩放前间距；再在空白处真拖动 ⇒ 每个节点按同一位移平移',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      await setProfile(ctx, graphProfiles(doc)[0]);
      await openProject(ctx, P_TREE);
      await expandAll(ctx);                        // 10 个节点都要进图（见 expandAll 的注释）
      const A = 'root', B = 'b1';
      const before = await ctx.exec(nodeRects([A, B]));
      if (!before || !before[A] || !before[B] || !before[A].w) {
        return { ok: false, text: '量不到两个节点的屏幕矩形（A=' + JSON.stringify(before) + '）⇒ 判据会空转' };
      }
      await clickEl(ctx, '#cap-bar [data-cap-ctl="zoom-in"]', '页脚的「放大」按钮');
      const after = await ctx.exec(nodeRects([A, B]));
      if (!after || !after[A] || !after[B] || !after[A].w) return { ok: false, text: '放大后量不到矩形' };
      const s = after[A].w / before[A].w;               // ← 缩放因子**现算**（不读产品的 zoom 读数）
      const d0x = before[B].cx - before[A].cx, d0y = before[B].cy - before[A].cy;
      const d1x = after[B].cx - after[A].cx, d1y = after[B].cy - after[A].cy;
      const errX = Math.abs(d1x - s * d0x), errY = Math.abs(d1y - s * d0y);
      const zoomOk = s > 1.01 && errX <= 1 && errY <= 1;
      /* ---- 平移：在**空白处**按下拖动（坐标由 elementFromPoint 现查，避开节点/框） ---- */
      const blank = await ctx.exec('(function () {'
        + ' var host = document.getElementById("diagram-host");'
        + ' if (!host) return null;'
        + ' var b = host.getBoundingClientRect();'
        + ' var cands = [[b.left + 12, b.top + 12], [b.left + 12, b.bottom - 12], [b.right - 12, b.bottom - 12]];'
        + ' for (var i = 0; i < cands.length; i++) {'
        + '   var el = document.elementFromPoint(cands[i][0], cands[i][1]);'
        + '   if (!el) continue;'
        + '   if (el.closest && el.closest("g[data-node]")) continue;'
        + '   if (!host.contains(el)) continue;'
        + '   return { x: Math.round(cands[i][0]), y: Math.round(cands[i][1]) };'
        + ' }'
        + ' return null; })()');
      let panOk = false;
      let panText = '找不到空白点（跳过拖动那一半）';
      if (blank) {
        const ids = TREE_NODE_IDS;
        const pre = await ctx.exec(nodeRects(ids));
        await ctx.input.drag(blank, { x: blank.x + 60, y: blank.y + 40 });
        await tick(ctx, 80);
        const post = await ctx.exec(nodeRects(ids));
        const deltas = ids.filter((id) => pre[id] && post[id])
          .map((id) => [post[id].cx - pre[id].cx, post[id].cy - pre[id].cy]);
        const dx0 = deltas.length ? deltas[0][0] : 0;
        const dy0 = deltas.length ? deltas[0][1] : 0;
        const spread = deltas.reduce((m, d) => Math.max(m, Math.abs(d[0] - dx0), Math.abs(d[1] - dy0)), 0);
        panOk = deltas.length >= 3 && Math.abs(dx0) >= 20 && Math.abs(dy0) >= 10 && spread <= 1;
        panText = '拖动 (' + blank.x + ',' + blank.y + ')→(+60,+40)：位移 ' + JSON.stringify([dx0, dy0])
          + ' 各节点最大偏差 ' + Math.round(spread * 100) / 100 + 'px（≤1）· 量到 ' + deltas.length + ' 个节点';
      }
      return {
        ok: zoomOk && panOk,
        text: '缩放：s=' + (Math.round(s * 10000) / 10000) + ' 间距 ' + JSON.stringify([Math.round(d0x), Math.round(d0y)])
          + '→' + JSON.stringify([Math.round(d1x), Math.round(d1y)]) + ' 误差 ' + Math.round(errX * 100) / 100
          + '/' + Math.round(errY * 100) / 100 + 'px（≤1）· ' + panText
      };
    }
  },

  {
    name: '庚 判据 8：提示口径与事实一致 —— 三个图形剖面里**不出现**「尚未接界面」且**点名**仍缺的导出'
      + '（「PNG」+「缺口」）；树形剖面 + 盘上带 graph 仍说「本剖面不显示」且四类计数与夹具逐项相同',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      const doc = docMatrix();
      const graphs = graphProfiles(doc);
      const tree = doc.profiles.filter((p) => markOf(doc, p, 'C-F3-01') === '\u2717')[0];
      const noteOf = () => ctx.exec('(function () { var el = document.getElementById("profile-note-text");'
        + ' return el ? el.textContent : null; })()');
      const fails = [];
      const rows = [];
      await setProfile(ctx, graphs[0]);
      await openProject(ctx, P_TREE);
      await expandAll(ctx);                        // 让派生读数里有层带/容器（不是 3 个光杆节点）
      for (const p of graphs) {
        await setProfile(ctx, p);
        const note = String(await noteOf() || '');
        if (note.indexOf('尚未接界面') >= 0) fails.push(p + ' 的提示里还有「尚未接界面」（MS3 之后这是假话）');
        if (note.indexOf('PNG') < 0) fails.push(p + ' 的提示没有点名 PNG 导出这一档缺口');
        if (note.indexOf('缺口') < 0) fails.push(p + ' 的提示没有把 PNG 说成"缺口"（含糊 = 假）');
        if (!note) fails.push(p + ' 的提示是空的 ⇒ 这一档没说自己画了什么');
        rows.push(p + '="' + note.slice(0, 56) + '…"');
      }
      const data = dataFixture();
      await setProfile(ctx, tree);
      await openProject(ctx, P_DATA);
      const treeNote = String(await noteOf() || '');
      const countsOk = treeNote.indexOf((data.graph.layers || []).length + ' 条层带') >= 0
        && treeNote.indexOf((data.graph.edges || []).length + ' 条边') >= 0
        && treeNote.indexOf('本剖面不显示') >= 0;
      if (!countsOk) fails.push('树形剖面 + 带 graph 的项目：提示缺计数或「本剖面不显示」⇒ "' + treeNote + '"');
      await openProject(ctx, P_TREE);
      /* 默认档（进域时那一档）如果本来就是树形，它打开**无 graph** 的项目时提示必须是空的（零噪声） */
      return {
        ok: fails.length === 0,
        text: (fails.length ? '✗ ' + fails.join(' ｜ ') + ' ｜ ' : '')
          + '三剖面提示：' + rows.join(' ')
          + ' ｜ 树形剖面（' + tree + '）+ 带 graph 的项目：计数与"本剖面不显示"=' + countsOk
          + ' ⇒ "' + treeNote.slice(0, 72) + '…"'
      };
    }
  },

  {
    name: '辛 判据 9：**jsMind 未被修改**（vendored）—— 两个第三方 bundle 的 sha256 与**登记基线**逐字节相同、'
      + '`renderer/vendor/` 的 git status 为空、库内那份 `JSMIND-INTERNALS.md` 与 HEAD 相同',
    run: async (ctx) => {
      /* ⚠️ **为什么这里有两条真值，而"与 HEAD 一致"只对得上其中一条**（父批前提订正，已核 .gitignore）：
       * `renderer/vendor/` 是**整体 gitignore** 的（`.gitignore` 里写着"两个第三方 bundle 维持不进库的现状"）
       * ⇒ `git show HEAD:renderer/vendor/jsmind.js` 报 `exists on disk, but not in HEAD`（实测），
       * 所以"sha256 与 HEAD 一致"对 **bundle 本体**根本无从判。替身是**登记基线**（下面的常量）：
       * 它是这条判据的真值，**升级 vendored jsMind 时必须同批改这两个常量**（并照
       * `renderer/vendor/JSMIND-INTERNALS.md` 人工回归）—— 改它会在 diff 里露出来，不会静默漂。
       * 库内那份 `JSMIND-INTERNALS.md` **是**跟踪文件 ⇒ 它照"与 HEAD 一致"判（那条一个字都没松）。 */
      const BASELINE = {
        'jsmind.js': 'e4be9e9b2b345c8746e7740de07b271cea64c1c83d26b16fb864a240814af1b8',
        'jsmind.css': '2e3f1396b31ccf4a47b04bac4a8dcab75aea62ffeb466afc36a8075218b73f64'
      };
      const git = (args) => execFileSync('git', ['-C', ROOT].concat(args), { maxBuffer: 64 * 1024 * 1024 });
      let status = '';
      try {
        status = git(['status', '--porcelain', '--', 'renderer/vendor']).toString('utf8').trim();
      } catch (e) {
        return { ok: false, text: 'git 取不到真值（' + ((e && e.message) || e) + '）⇒ 按打红处理（采不到真值 = 红）' };
      }
      const rows = [];
      const fails = [];
      Object.keys(BASELINE).forEach((f) => {
        const disk = fs.readFileSync(path.join(VENDOR, f));
        const dd = crypto.createHash('sha256').update(disk).digest('hex');
        rows.push(f + ' ' + dd.slice(0, 10));
        if (dd !== BASELINE[f]) {
          fails.push(f + ' 与登记基线不同（' + BASELINE[f].slice(0, 10) + ' → ' + dd.slice(0, 10)
            + '）⇒ vendored 库被改过（升级它就同批改这里的常量）');
        }
      });
      /* 跟踪文件（INTERNALS.md）照"与 HEAD 逐字节相同"判 —— 这一条是能用 git 判的那一半 */
      let tracked = '';
      try {
        const head = git(['show', 'HEAD:renderer/vendor/JSMIND-INTERNALS.md']);
        const disk = fs.readFileSync(path.join(VENDOR, 'JSMIND-INTERNALS.md'));
        const hh = crypto.createHash('sha256').update(head).digest('hex');
        const dd = crypto.createHash('sha256').update(disk).digest('hex');
        tracked = 'JSMIND-INTERNALS.md ' + dd.slice(0, 10) + (hh === dd ? ' = HEAD' : ' ≠ HEAD');
        if (hh !== dd) fails.push('JSMIND-INTERNALS.md 与 HEAD 不同（' + hh.slice(0, 10) + ' → ' + dd.slice(0, 10) + '）');
      } catch (e) {
        fails.push('JSMIND-INTERNALS.md：HEAD 里取不到（' + ((e && e.message) || e) + '）');
      }
      if (status) fails.push('renderer/vendor 有改动：' + status.split(/\r?\n/).slice(0, 4).join(' / '));
      return {
        ok: fails.length === 0,
        text: (fails.length ? '✗ ' + fails.join(' ｜ ') + ' ｜ ' : '')
          + 'sha256：' + rows.join(' · ') + '（= 登记基线）· ' + tracked
          + ' ｜ git status（renderer/vendor）=' + (status ? JSON.stringify(status.slice(0, 80)) : '空')
          + ' ｜ 口径：bundle 本体不在版本库里（.gitignore 明写）⇒ 用登记基线；跟踪文件用 HEAD'
      };
    }
  },

  {
    name: '壬 收尾：剖面回进入时那一档 / 开回进来时那个项目 / 删两个夹具（自证不存在）/ 收模态 / 复位确认桩',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有 ctx.input（不是 --smoke 路径）' };
      if (ENTRY_PROFILE) await setProfile(ctx, ENTRY_PROFILE);
      const cleaned = await mm.closeDialogs(ctx);
      // 先开回进来时那个项目（此刻可能还是脏的 ⇒ 确认桩已允许"丢弃改动"），再删夹具：
      // 反序会让"删一个正被 fs.watch 盯着的目录"在 Windows 上 EPERM（域 42 记过）。
      let restored = null;
      if (ENTRY_PROJECT) restored = await openProject(ctx, ENTRY_PROJECT);
      const removed = rmFixtures();
      await stubConfirm(ctx, null);
      const profile = await profileNow(ctx);
      const cv = await ctx.exec(CANVAS);
      /* "图渲染层已退"的**正确口径**：不是"一定退掉"，而是**与剖面一致** ——
       * 收尾把剖面还原成"进域时那一档"，如果那一档本来就是图形剖面（真跑全量时域 58 会把它留在
       * 全开剖面），那图渲染层**就该在**。判"必须退"是把缺省假设当前提（本域第一版就这么红过一次）。 */
      const wantDiagram = await ctx.exec('(function () { return !!window.MM.capDrawsGraph(window.MMApp.capProfile()); })()');
      const layerMatches = (cv.diagramClass === true) === (wantDiagram === true);
      return {
        ok: removed.gone && removed.removed && cleaned.n >= 0
          && (!ENTRY_PROFILE || profile === ENTRY_PROFILE)
          && (ENTRY_PROJECT ? restored === true : true)
          && layerMatches,
        text: '剖面=' + profile + '（进入时 ' + (ENTRY_PROFILE || '未读') + '）· 夹具删除=' + removed.removed
          + '（自证不存在=' + removed.gone + '）· 收模态 ' + cleaned.n + ' 个 · 开回项目='
          + JSON.stringify(ENTRY_PROJECT) + '（' + restored + '）· 图渲染层在=' + (cv.diagramClass === true)
          + '（该档要图吗=' + (wantDiagram === true) + ' ⇒ 一致=' + layerMatches + '）'
      };
    }
  }
];

/* 每条断言的实际耗时打进报文（**读数，不参与判定**；G5 的逐域台账只到"域"这一层，
 * 域内谁最贵以前没有读数 —— 本域是真起两套渲染器的，值得知道）。 */
assertions.forEach((a) => {
  const raw = a.run;
  a.run = async (ctx) => {
    const t0 = Date.now();
    const res = await raw(ctx);
    const ms = Date.now() - t0;
    if (res && typeof res.text === 'string') res.text += ' · 本断言 ' + (Math.round(ms / 100) / 10) + 's';
    return res;
  };
});

module.exports = assertions;
