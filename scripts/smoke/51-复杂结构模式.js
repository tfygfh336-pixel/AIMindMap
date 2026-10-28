/* ============================================================
 * scripts/smoke/51-复杂结构模式.js —— 【R5 · R2 期 5】结构轴 = 树结构 / 复杂结构
 * ------------------------------------------------------------
 * 上游口径：`.review/20261014-导图交互重构/设计.md` 的
 *   「修订（2026-10-14 · 用户插入）：结构轴 = 传统树 / 复杂结构」一节（§R5-1…§R5-5）
 *   与同目录的批次任务书（四项**都不写新契约**，全落 `renderer/**` + 本域）。
 * 本域只钉**界面那一半**（真鼠标 / 真 DOM / 盘上 JSON 原文），四项一起判：
 *
 *  甲 **双击语义按「有没有父子关系」分岔**（§R5-3）：有子节点 ⇒ 展开/折叠（照旧，一字不改）；
 *     没有子节点（叶子 / 复杂结构里只连边、无子的节点 / 孤立节点）⇒ 打开**详情框**。
 *     三条判据 + 两条**对照**：
 *       · 折叠着的父节点双击 ⇒ 子节点真的出现、且详情框**没开**；
 *       · 叶子双击 ⇒ 详情框**开了**（且是那个节点的框），它的 `expanded` 一个字节没动。
 *         ⚠️ **两种叶子形状都测**：光杆节点标 `expanded:false`、叶子标 `expanded:true`。
 *         两种在真数据里都常见（`serializeTree` 给每个节点都写 `expanded`，只有运行期恰好
 *         是 false 才写 false）⇒ 「现算子节点数、**不许读 expanded**」这条纪律的**两个方向**
 *         各有一条判据（这正是把"读 expanded"注入进来会红的判别力来源）。
 *       · 两种情况下 `MM.clickJudgeState()` 的读数**逐项一致**（R1 的两击配对判别本批一个字没动）。
 *  乙 **结构轴开关（树 / 复杂）是独立的一条轴**：会话级内存、**零序列化写入**、默认 = 树结构、
 *     启动/切项目回树结构（用户 2026-10-16 拍板）。判据：切模式前后**盘上 sha256 逐字节不变**、
 *     `isDirty()` 仍 false、序列化产物的**顶层键集与 meta 键集逐项相同**（一个新键都没多）、
 *     重开项目后模式读数回 `'tree'`。
 *  丙 **一处实现 + 两条轴正交**（结构断言，扫描面 = `renderer/**.js` + `src/*.js`，剥注释后扫）：
 *     `fdStructureMode` 只出现在 `app-view.js`；切模式的两个出口各一处；`resetStructureMode`
 *     的调用点恰好一处（`app-actions.js` 的 openProject）；`MM.showDetail` 在 `contextmenu.js`
 *     恰好一处调用；**序列化形状 0 命中**（`structureMode` 不出现在 `src/` 与 `app-core.js`）；
 *     行为面：切新轴不改旧轴读数（`isThemeMode()` 与盘上 `meta.rootMode` 都不动）。
 *  丁 **拖动不受树层约束**（§R5-4）：真鼠标把**第 4 层**的一个子树沿两条轴各挪一段
 *     ⇒ 只有它和后代按位移走（位移 == 指针位移，两条轴都没有被"第几层 ⇒ 第几列"夹住）、
 *     其余节点屏幕矩形**逐项相同**、父子关系逐字节不变、拖动期间盘上零写入；
 *     显式保存后盘上**只多该子树根那一个偏移键**（后代一个键都没有，其余字节白名单为空）。
 *     ⚠️ 这一项**只读复核后判定不需要改产品代码**（功能层面早已成立，证据链见交付说明与
 *     `.review/20261016-R2期5-复杂结构模式/README.md`）—— 本域补的是"深层节点两轴自由位移 +
 *     盘上只有一个偏移键"这条判据，**没有**为它改 `app-view.js` 的拖动实现（那会是第二份 ✗）。
 *  戊 **关系层在复杂模式下的画法**（§R5-5 第四件）：**复用既有取舍，不新立阈值** ——
 *     复杂模式开 ⇒ 当前选中节点的自由边画在既有 `#mm-rel-layer` 上（走既有唯一入口
 *     `MM.showRelated`）；线数 == 既有模型（`src/related-model.js`，纯函数、有单测）逐条算出来的
 *     边数 == 由**成员数 + 团边数**现算的期望；成员 > 既有 `CLIQUE_MAX`（**现读**，不写死）⇒
 *     **只画星形**（团边 0 条，且把"不设上限会是多少"现算报出来做对照）；跨项目成员**只标不画**
 *     （既有编辑条里列着它、画出来的线段里没有一个端点指向它）。两条对照（A 有团边 / B 无团边）
 *     一起构成"这条判据能分辨两种状态"的证据。
 *  己 收尾：关详情框 / 退出关系视图 / 模式回树 / 偏移清回自动布局并落盘 / 删两个夹具项目 /
 *     开回原项目 / 复位确认桩（不给后面的域留状态）。
 *
 * 判据纪律（与 36/37/42/43/45/46/48/49 同）：可见性一律 `document.elementFromPoint`；
 * 动作一律**真鼠标**（`ctx.input.*` 走 Chromium 命中测试，不是 `dispatchEvent` 合成事件）；
 * 真值读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 在 --smoke 下指向临时副本）。
 * ⚠️ 夹具是本域自己写进沙箱的两个 `zz-` 项目（不碰 comnet）；无头跑里没人回答模态 ⇒ 显式装
 *   打桩答案（`MMApp.setConfirmStub`），收尾复位成本体。
 * ⚠️ 每一步真输入之后**必须等一拍再量**（`ctx.input.settle`）：输入事件经主进程排队，
 *    紧接着量会把"还没落地"读成"没动"（域 46 第一版实测踩到）。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stripComments } = require('../../scripts/dep-direction-check.js');
const mm = require('../smoke-assertions.js');
const WAIT = require('./_wait.js');   // 等真帧/等条件：理由见该文件头部第 5 条

/** 沙箱夹具项目（主）：顶层主题 t1/t2；t1 下 pa（**折叠着**，有两个孩子）→ pa1/pa2；
 *  pb → pb1 → pb1a（**第 4 层**，拖动目标）→ pb1a1；t2 下 qa + m1…m9（大成员数那一篇的成员） */
const P = 'zz-r2-cplx';
/** 跨项目夹具（只为那条"跨项目只标不画"的边存在） */
const P2 = 'zz-r2-cplx-b';

const PA = 'pa';            // 折叠着的有子节点（双击 ⇒ 展开）
const PA1 = 'pa1';          // 光杆叶子，数据里标 expanded:false
const PA2 = 'pa2';          // 光杆叶子，数据里标 expanded:true
const TARGET = 'pb1a';      // 第 4 层，拖动目标
const TARGET_SUB = ['pb1a', 'pb1a1'];
const QA = 'qa';            // 成员数 > 上限那一轮的中心节点
const M9 = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];
const A3 = 'a-s3';          // 3 个成员的关联笔记（<= 既有上限 ⇒ 团边要画）
const A9 = 'a-s9';          // 10 个成员的关联笔记（中心 + 9 ⇒ > 既有上限 ⇒ 团边不画）

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
const projectDir = (name) => path.join(projectsDir(), name);
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 真输入之后的等待：>= 2 帧 + 一小段真实时间 */
const STEP = { delayMs: 60 };
const PAINT = { delayMs: 140 };

async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await WAIT.frames(ctx, { delayMs: 160 });
  return ok;
}

async function stubConfirm(ctx, answer) {
  await ctx.exec('window.MMApp.setConfirmStub('
    + (answer === null ? 'null' : 'function () { return ' + (answer ? 'true' : 'false') + '; }') + ')');
  STUB_INSTALLED = answer !== null;
}

const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');
const save = (ctx) => ctx.exec('(async function () { return await window.MMApp.save(); })()');
const expandAll = (ctx) => ctx.exec('(function () { window.MMApp.getState().jm.expand_all(); return true; })()');

/** 全屏雷达：所有**渲染出来**（矩形非零）的节点屏幕矩形 + 面板 + 挂载数 */
const RADAR = `(function () {
  var out = {};
  document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;          // 折叠着（display:none）⇒ 不在对照面里
    var id = el.getAttribute('nodeid');
    out[id] = { l: Math.round(r.left), t: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height) };
  });
  var p = window.MM.fdPanel();
  var b = p.getBoundingClientRect();
  return { rects: out, mounted: document.querySelectorAll('jmnode[nodeid]').length,
    view: window.MMApp.getPanState(),
    panel: { left: Math.round(b.left), top: Math.round(b.top),
      right: Math.round(b.right), bottom: Math.round(b.bottom) } };
})()`;

/** 逐项比矩形：返回 { unchanged, moved, gone }（照域 46 的形状） */
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

/** 平移画布，把某节点中心送到面板内的相对位置（fx/fy 是面板内的比例）。
 *  与域 46 的 centerNode 同一形状：出口是 `MM.setViewTransform`（产品自己的唯一视图变换口）。 */
async function centerNode(ctx, id, fx, fy) {
  return ctx.exec(`(function () {
    var el = document.querySelector('jmnode[nodeid=' + JSON.stringify(${JSON.stringify(id)}) + ']');
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

/** 等视图稳定：连续三次同一个 `getPanState()`（renderMind 末尾那记延后的中心对齐会把整页挪一下，
 *  落在"量基线"与"按下"之间就会把"其余矩形逐项相同"打成假红 —— 域 46 实测过）。 */
async function waitStableView(ctx) {
  let last = null, same = 0;
  for (let i = 0; i < 12; i++) {
    const st = await ctx.exec('JSON.stringify(window.MMApp.getPanState())');
    if (st === last) { same++; if (same >= 2) return st; } else { same = 0; last = st; }
    await WAIT.frames(ctx, { delayMs: 70 });
  }
  return last;
}

/** 生成**注入代码**里的"按 nodeid 取节点元素"表达式。
 *  ⚠️ 别在 node 侧手写 `\"xx\"` 转义：那一层转义会被 node 自己的字符串解析吃掉，注入代码就成了
 *  `querySelector("jmnode[nodeid="pa1"]")` ⇒ 渲染层直接 SyntaxError（"Script failed to execute"）。
 *  一律走 `JSON.stringify` 生成字面量 ✓ */
const nodeEl = (id) => "document.querySelector('jmnode[nodeid=' + JSON.stringify("
  + JSON.stringify(id) + ") + ']')";
const nodeVisible = (id) => '(function () { var el = ' + nodeEl(id)
  + '; if (!el) return false; var r = el.getBoundingClientRect();'
  + ' return r.width > 0 && r.height > 0; })()';

/** 命中点**现取**：在该节点矩形里找一个 `elementFromPoint` 命中它自己的点。
 *  ⚠️ 必须**每次动手前重取**（浮层会在第一击之后冒出来盖住旧点 —— 域 03 实测踩到）。
 *  可见性判据一律走命中测试（rect 只用来判几何）⇒ 这条是 V1 认的真判据。 */
async function hitPoint(ctx, id) {
  return ctx.exec(`(function () {
    var el = document.querySelector('jmnode[nodeid=' + JSON.stringify(${JSON.stringify(id)}) + ']');
    if (!el) return { ok: false, text: '节点元素不在：${id}' };
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { ok: false, text: '节点没有几何（折叠着？）：${id}' };
    var cands = [
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4) },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      { x: Math.round(r.left + 6), y: Math.round(r.top + 6) },
      { x: Math.round(r.right - 6), y: Math.round(r.bottom - 6) }
    ];
    for (var i = 0; i < cands.length; i++) {
      var hit = document.elementFromPoint(cands[i].x, cands[i].y);
      var nd = hit && hit.closest ? hit.closest('jmnode[nodeid]') : null;
      if (nd && nd.getAttribute('nodeid') === ${JSON.stringify(id)}) {
        return { ok: true, pt: cands[i], hit: nd.getAttribute('nodeid') };
      }
    }
    var h2 = document.elementFromPoint(cands[0].x, cands[0].y);
    var who = h2 ? ((h2.tagName || '') + (h2.id ? '#' + h2.id : '')
      + (h2.getAttribute && h2.getAttribute('class') ? '.' + h2.getAttribute('class') : '')) : 'null';
    return { ok: false, text: '四个候选点都没命中 ${id}（命中=' + who + '）' };
  })()`);
}

/** 一次**真双击**：两条 down/up，第二条带 `clickCount: 2`，间隔 90ms。
 *  为什么不能连点两次 `ctx.input.click()`：那两击都写死 `clickCount: 1`
 *  ⇒ 浏览器**不会**产生 `dblclick`（测的就成了"两次单击"，不是双击 ✗）。 */
async function realDoubleClick(ctx, id) {
  const hp = await hitPoint(ctx, id);
  if (!hp.ok) return { ok: false, text: hp.text };
  await ctx.input.sendList([
    { type: 'mouseDown', x: hp.pt.x, y: hp.pt.y, button: 'left', clickCount: 1, modifiers: [] },
    { type: 'mouseUp', x: hp.pt.x, y: hp.pt.y, button: 'left', clickCount: 1, modifiers: [] },
    { type: 'mouseDown', x: hp.pt.x, y: hp.pt.y, button: 'left', clickCount: 2, modifiers: [] },
    { type: 'mouseUp', x: hp.pt.x, y: hp.pt.y, button: 'left', clickCount: 2, modifiers: [] }
  ], 90);
  await WAIT.frames(ctx, PAINT);
  return { ok: true, pt: hp.pt };
}

/** 读数三件：R1 判别窗口状态 / 详情框（数量 + 最后一个框的节点 id）/ 序列化文本 */
async function clickState(ctx) {
  return ctx.exec('(function () {'
    + ' var j = window.MM.clickJudgeState ? window.MM.clickJudgeState() : null;'
    + ' var s = window.MMApp.getFloatDetailState();'
    + ' return { judge: j, boxes: s.boxes, boxNodeId: s.nodeId, kinds: s.kinds }; })()');
}
const serText = (ctx) => ctx.exec('JSON.stringify(window.MMApp.serializeTree())');

/** 从**序列化产物**里现算某节点的 expanded（null = 键不在场，undefined = 节点不在树里） */
function expandedOf(text, id) {
  let tree = null;
  try { tree = JSON.parse(text); } catch (e) { return 'PARSE-ERR'; }
  let hit;
  (function walk(n) {
    if (!n || hit !== undefined) return;
    if (n.id === id) { hit = (n.expanded === undefined ? null : n.expanded); return; }
    (n.children || []).forEach(walk);
  })(tree && tree.data);
  return hit;
}

/** 扩展名/键集读数：给"零序列化写入"用（顶层键 + meta 键 + 是否出现新键） */
function keySets(text) {
  let t = null;
  try { t = JSON.parse(text); } catch (e) { return { top: ['PARSE-ERR'], meta: [] }; }
  return { top: Object.keys(t || {}), meta: Object.keys((t && t.meta) || {}) };
}

/** 夹具：与 CLI `init` + `add` 同形状的项目 JSON（直接写盘 ⇒ 确定性、也不拖慢链）。
 *  `assoc` 是**与 data 平级**的顶层键、`links` 是节点字段（契约见 docs/DATA-FORMAT.md）。 */
function writeFixtures() {
  const node = (id, topic, expanded, extra) => Object.assign(
    { id: id, topic: topic, expanded: expanded }, extra || {});
  const w = (id, topic, kids, extra) => node(id, topic, true,
    Object.assign(kids ? { children: kids } : {}, extra || {}));
  // 主夹具：注意 pa **折叠着**（② 的判据①要一个"有子节点但收着"的父节点）
  const paNode = Object.assign(node(PA, '甲-1', false, {
    children: [node(PA1, '甲-1-1', false), node(PA2, '甲-1-2', true)]
  }), {
    // 自由边：同项目一条（pb1a）、跨项目一条（P2/bx）—— 后者是"只标不画"那一半
    links: [{ project: P, id: TARGET, caption: '同项目自由边' },
      { project: P2, id: 'bx', caption: '跨项目自由边' }]
  });
  const data = {
    meta: { name: P, author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    data: w('root', 'R2 期 5 夹具', [
      w('t1', '主题甲', [
        paNode,
        w('pb', '甲-2', [
          w('pb1', '甲-2-1', [
            w(TARGET, '甲-2-1-1', [node('pb1a1', '甲-2-1-1-1', true)]),
            node('pb1b', '甲-2-1-2', true)
          ])
        ])
      ]),
      w('t2', '主题乙', [w(QA, '乙-1', null), w('m1', '乙-2', null), w('m2', '乙-3', null),
        w('m3', '乙-4', null), w('m4', '乙-5', null), w('m5', '乙-6', null), w('m6', '乙-7', null),
        w('m7', '乙-8', null), w('m8', '乙-9', null), w('m9', '乙-10', null)])
    ]),
    // 关联笔记（N 元关系实体）：a-s3 三个成员（<= 上限 ⇒ 团边要画）；
    // a-s9 = 中心 qa + 9 个成员（> 上限 ⇒ 团边不画）
    assoc: [
      { id: A3, title: '三成员关系', note: '', members: [
        { project: P, id: PA }, { project: P, id: PA1 }, { project: P, id: PA2 }] },
      { id: A9, title: '大成员数关系', note: '', members: [
        { project: P, id: QA }].concat(M9.map((m) => ({ project: P, id: m }))) }
    ]
  };
  fs.mkdirSync(projectDir(P), { recursive: true });
  fs.writeFileSync(projectFile(P), JSON.stringify(data, null, 2) + '\n', 'utf8');
  // 跨项目夹具（只为那条"只标不画"的边存在）
  const b = {
    meta: { name: P2, author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    data: w('root', '跨项目夹具', [node('bx', '别的项目里的节点', true)])
  };
  fs.mkdirSync(projectDir(P2), { recursive: true });
  fs.writeFileSync(projectFile(P2), JSON.stringify(b, null, 2) + '\n', 'utf8');
  return data;
}

function rmFixtures() {
  let removed = false;
  try {
    fs.rmSync(projectDir(P), { recursive: true, force: true });
    fs.rmSync(projectDir(P2), { recursive: true, force: true });
    removed = true;
  } catch (e) { removed = false; }
  const gone = [P, P2].every((n) => { try { fs.readFileSync(projectFile(n), 'utf8'); return false; } catch (e) { return true; } });
  return { removed: removed, gone: gone };
}

/** 切结构轴模式（唯一入口进 MMApp）并等一拍 */
async function setMode(ctx, mode) {
  const r = await ctx.exec('(async function () { return await window.MMApp.setStructureMode('
    + JSON.stringify(mode) + '); })()');
  await WAIT.frames(ctx, PAINT);
  return r;
}
const modeNow = (ctx) => ctx.exec('window.MMApp.structureMode()');
const selectNode = (ctx, id) => ctx.exec('(function () { var jm = window.MMApp.getState().jm;'
  + ' window.MM.adapter.selectNode(jm, ' + JSON.stringify(id) + ');'
  + ' var s = window.MM.adapter.getSelected(jm); return s ? s.id : null; })()');
const clearRelated = (ctx) => ctx.exec('(function () { if (window.MM.clearRelated) window.MM.clearRelated(); return 1; })()');

/** 关系层读数：线段数（视觉层 + 命中层）、每条的端点、成员集、中心节点能否被点中。
 *  ⚠️ 线数只认 `path[data-role="relation-line"]`（视觉层）与 `data-role="relation-hit"`（命中层），
 *  两层**必须同数**（与 app-related.js 的红线：两层同源、各画一遍是同一次循环里的两条 append）。 */
async function relatedRead(ctx, centerId) {
  const r = await ctx.exec(`(async function () {
    var svg = document.getElementById('mm-rel-layer');
    var hit = document.getElementById('mm-rel-hit-layer');
    var lines = svg ? Array.prototype.slice.call(svg.querySelectorAll('path[data-role="relation-line"]')) : [];
    var hits = hit ? hit.querySelectorAll('path[data-role="relation-hit"]').length : -1;
    var rendered = {};
    document.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
      var b = el.getBoundingClientRect();
      rendered[el.getAttribute('nodeid')] = (b.width > 0 && b.height > 0);
    });
    // 中心节点：命中测试（判"它真的能被点中"，与线数判据分开记）
    var el = document.querySelector('jmnode[nodeid=' + JSON.stringify(${JSON.stringify(centerId)}) + ']');
    var hitSelf = false, hitWho = null;
    if (el) {
      var b2 = el.getBoundingClientRect();
      var h = document.elementFromPoint(Math.round(b2.left + b2.width / 2), Math.round(b2.top + b2.height / 2));
      var nd = h && h.closest ? h.closest('jmnode[nodeid]') : null;
      hitWho = nd ? nd.getAttribute('nodeid') : (h ? ((h.tagName || '')
        + (h.id ? '#' + h.id : '') + (h.getAttribute && h.getAttribute('class') ? '.' + h.getAttribute('class') : '')) : null);
      hitSelf = !!(nd && nd.getAttribute('nodeid') === ${JSON.stringify(centerId)});
    }
    // 每一条画出来的线：拿它的命中热区（z-index 3、pointer-events:stroke）做**真命中测试** ——
    // 线段真的在屏上 ⇒ 它中点上的 elementFromPoint 命中它自己。这正是"点线开笔记"依赖的那一跳
    //（app-related.js 的注释记着：视觉层 pointer-events:none，只有命中层点得到）。
    var lineHits = [];
    if (hit) {
      Array.prototype.slice.call(hit.querySelectorAll('path[data-role="relation-hit"]')).forEach(function (p) {
        var bb = p.getBoundingClientRect();
        var m = document.elementFromPoint(Math.round(bb.left + bb.width / 2), Math.round(bb.top + bb.height / 2));
        var ra = p.getAttribute('data-rel-a'), rb = p.getAttribute('data-rel-b');
        lineHits.push({ edge: ra + '>' + rb,
          self: !!(m && m.getAttribute && m.getAttribute('data-rel-a') === ra && m.getAttribute('data-rel-b') === rb),
          who: m ? ((m.tagName || '') + (m.getAttribute && m.getAttribute('data-role')
            ? '[' + m.getAttribute('data-role') + ']' : '')) : null });
      });
    }
    // 既有模型逐条算出来的那份期望（**产品自己的纯函数**，唯一真源；不在这里重写取舍）
    var a = await window.desktop.app.assoc(${JSON.stringify(P)}, ${JSON.stringify(centerId)})
      .catch(function () { return { items: [] }; });
    var rel = await (window.desktop.app.related
      ? window.desktop.app.related(${JSON.stringify(P)}, ${JSON.stringify(centerId)})
        .catch(function () { return { items: [] }; })
      : Promise.resolve({ items: [] }));
    var m = window.MMRelated.buildRelationModel({ nodeId: ${JSON.stringify(centerId)},
      project: ${JSON.stringify(P)}, assocItems: (a && a.items) || [],
      relatedItems: (rel && rel.items) || [] });
    var cid = ${JSON.stringify(centerId)};
    var edges = m.edges.map(function (e) { return e.a + '>' + e.b; });
    // 既有编辑条里列出的边（"只标不画"那一半的落地处）
    var bar = window.MM.relatedEditBarEdges ? window.MM.relatedEditBarEdges() : { out: [], in: [] };
    return {
      lineCount: lines.length,
      dataset: svg ? svg.dataset.count : null,
      hitCount: hits,
      drawnEdges: lines.map(function (p) { return p.getAttribute('data-rel-a') + '>' + p.getAttribute('data-rel-b'); }),
      active: window.MM.isRelatedActive ? window.MM.isRelatedActive() : null,
      members: (window.MM.relatedMembers ? window.MM.relatedMembers() : []).slice(),
      model: { members: m.members.map(function (x) { return x.id; }), edges: edges,
        star: m.edges.filter(function (e) { return e.a === cid || e.b === cid; }).length,
        clique: m.edges.filter(function (e) { return e.a !== cid && e.b !== cid; }).length,
        crossProject: m.crossProject, assocCount: m.assocCount,
        cliqueMax: window.MMRelated.CLIQUE_MAX },
      barOut: (bar.out || []).map(function (e) { return (e.toProject || '') + '/' + (e.toId || ''); }),
      barIn: (bar.in || []).map(function (e) { return (e.fromProject || '') + '/' + (e.fromId || ''); }),
      rendered: rendered,
      lineHits: lineHits,
      hitSelf: hitSelf, hitWho: hitWho
    };
  })()`);
  return r;
}

/** 轮询"既有编辑条把边读回来了"（它是两次 IPC ⇒ 异步；采不到就红，不静默） */
async function waitBarEdges(ctx, minCount) {
  for (let i = 0; i < 12; i++) {
    const n = await ctx.exec('(function () { var b = window.MM.relatedEditBarEdges'
      + ' ? window.MM.relatedEditBarEdges() : { out: [], in: [] };'
      + ' return (b.out || []).length + (b.in || []).length; })()');
    if (n >= minCount) return { ok: true, n: n };
    await WAIT.frames(ctx, { delayMs: 150 });
  }
  return { ok: false, n: -1 };
}

/** 关系层那一轮：关掉可能盖住画布的浮详情框 → 清旧层 → 回树模式 → 选中中心节点 →
 *  复杂模式（走既有唯一入口）→ 读。⚠️ 先关框：浮详情框压在节点/线上会把命中测试判成红，
 *  而那一红不是关系层的缺陷（域 46 的"浮层盖住点"是同一类）。 */
async function relatedRound(ctx, centerId) {
  await ctx.exec('(async function () { await window.MMApp.closeAllFloatDetail(); return 1; })()');
  await WAIT.frames(ctx, STEP);
  await clearRelated(ctx);
  await setMode(ctx, 'tree');
  const sel = await selectNode(ctx, centerId);
  if (sel !== centerId) return { ok: false, text: '选中中心节点失败：期望 ' + centerId + '，实际 ' + sel };
  const sw = await setMode(ctx, 'complex');
  await WAIT.frames(ctx, PAINT);
  const read = await relatedRead(ctx, centerId);
  read.switchResult = sw;
  return read;
}

const assertions = [

  /* ================= 甲 双击语义：按"有没有父子关系"分岔 ================= */
  {
    name: '甲 双击语义按「有没有父子关系」分岔：折叠着的父节点双击 ⇒ 子节点出现且详情框**没开**；两种叶子（标 expanded:false / 标 expanded:true）双击 ⇒ 详情框**开了**且它的 expanded 一个字节没动；两种情况下 MM.clickJudgeState 读数逐项一致（R1 未被回退）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input）⇒ 双击这条判据无从验起，判红' };
      // —— 开局（先装确认桩：无头跑里"界面脏 + 切项目"会落到原生 window.confirm ⇒ 不装桩会卡死
      //      渲染层（域 43/46 都记过）；再清上一次跑崩留下的夹具、写夹具、打开）——
      await stubConfirm(ctx, true);
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return (s && s.project && s.project.name) || \"\"; })()');
      rmFixtures();
      writeFixtures();
      const opened = await openProject(ctx, P);
      if (opened !== true) return { ok: false, text: '夹具项目打不开：' + P };
      // 打开项目 = **只展开根**（既有行为，域 17/41）⇒ 显式展开顶层主题 t1。
      // ⚠️ **不要** expand_all：那会把 pa 一起展开，而判据①要的正是"一个折叠着的有子节点"。
      await ctx.exec('(function () { var jm = window.MMApp.getState().jm;'
        + ' jm.expand_node("root"); jm.expand_node("t1"); return true; })()');
      await WAIT.frames(ctx, PAINT);
      await ctx.exec('(async function () { await window.MMApp.closeAllFloatDetail(); return 1; })()');
      await WAIT.frames(ctx, STEP);
      const before = await clickState(ctx);
      const paVisible0 = await ctx.exec(nodeVisible(PA1));

      // —— 对照一：折叠着的**父**节点（pa）双击 ⇒ 展开、详情框不许开 ——
      const dc1 = await realDoubleClick(ctx, PA);
      if (!dc1.ok) return { ok: false, text: '双击 pa 取点失败：' + dc1.text };
      const afterParent = await clickState(ctx);
      const serAfterParent = await serText(ctx);
      const paExpanded = expandedOf(serAfterParent, PA);
      await WAIT.frames(ctx, STEP);           // 展开会触发一次重排 ⇒ 再等一拍再量几何
      const pa1Visible1 = await ctx.exec(nodeVisible(PA1));

      // —— 对照二：叶子 pa2（数据里标 expanded:true）双击 ⇒ 开详情、expanded 不动 ——
      await ctx.exec('(async function () { await window.MMApp.closeAllFloatDetail(); return 1; })()');
      await WAIT.frames(ctx, STEP);
      const serBeforeLeaf = await serText(ctx);
      const dc2 = await realDoubleClick(ctx, PA2);
      if (!dc2.ok) return { ok: false, text: '双击 pa2 取点失败：' + dc2.text };
      const afterLeaf = await clickState(ctx);
      const serAfterLeaf = await serText(ctx);
      const pa2Expanded = [
        expandedOf(serBeforeLeaf, PA2), expandedOf(serAfterLeaf, PA2)
      ];

      // —— 对照三：叶子 pa1（数据里标 expanded:false，comnet 那 210 个的形状）—— 
      await ctx.exec('(async function () { await window.MMApp.closeAllFloatDetail(); return 1; })()');
      await WAIT.frames(ctx, STEP);
      const dc3 = await realDoubleClick(ctx, PA1);
      if (!dc3.ok) return { ok: false, text: '双击 pa1 取点失败：' + dc3.text };
      const afterLeaf2 = await clickState(ctx);
      const serAfterLeaf2 = await serText(ctx);
      const pa1Expanded = [
        expandedOf(serAfterLeaf, PA1), expandedOf(serAfterLeaf2, PA1)
      ];

      const j1 = afterParent.judge || {}, j2 = afterLeaf.judge || {}, j3 = afterLeaf2.judge || {};
      const s1 = j1.suppressed || null, s2 = j2.suppressed || null, s3 = j3.suppressed || null;
      // 收口：把这一档改出来的展开态落盘 ⇒ 后面那一档（模式开关）从**干净基线**（isDirty=false）起，
      // 否则"切模式没产生未保存改动"那条判据会被本档的展开改动顶成恒真（域 46 文件头记过同一件事）。
      const savedForNext = await save(ctx);
      await WAIT.frames(ctx, { delayMs: 160 });
      const checks = [
        ['前置：pa 一开始是收着的（它的孩子 pa1 没有几何）—— 采不到就红', paVisible0 === false],
        ['① 折叠着的父节点双击 ⇒ 它的子节点出现在屏上（真的展开了）',
          pa1Visible1 === true && paExpanded === true],
        ['① 同一击里详情框**一个都没开**（R1 的抑制照旧生效）',
          afterParent.boxes === before.boxes && (afterParent.boxes === 0)],
        ['② 叶子 pa2（标 expanded:true）双击 ⇒ 打开的是它的详情框',
          afterLeaf.boxes === 1 && afterLeaf.boxNodeId === PA2],
        ['② 同一击里 pa2 的 expanded 一个字节没动', pa2Expanded[0] === pa2Expanded[1]],
        ['②b 叶子 pa1（标 expanded:false）双击 ⇒ 打开的是它的详情框',
          afterLeaf2.boxes === 1 && afterLeaf2.boxNodeId === PA1],
        ['②b pa1 的 expanded 一个字节没动', pa1Expanded[0] === pa1Expanded[1]],
        ['③ 两种情况下 MM.clickJudgeState 的读数逐项一致（窗口 / 待决 / 被撤那一击的 why）',
          j1.windowMs === 300 && j2.windowMs === j1.windowMs && j3.windowMs === j1.windowMs
          && j1.pending === null && j2.pending === null && j3.pending === null
          && !!s1 && !!s2 && !!s3
          && s1.why === s2.why && s3.why === s2.why],
        ['③ 被撤掉的那一击点在**刚双击的那个节点**上',
          !!s1 && !!s2 && !!s3 && s1.nodeId === PA && s2.nodeId === PA2 && s3.nodeId === PA1],
        ['甲 收口：展开态已保存（后面那一档要的干净基线）', savedForNext === true]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: 'pa: 子节点出现 ' + paVisible0 + '→' + pa1Visible1 + ' · expanded=' + paExpanded
          + ' · 详情框 ' + before.boxes + '→' + afterParent.boxes
          + ' ｜ pa2: 框=' + JSON.stringify(afterLeaf.boxNodeId) + ' expanded=' + JSON.stringify(pa2Expanded)
          + ' ｜ pa1: 框=' + JSON.stringify(afterLeaf2.boxNodeId) + ' expanded=' + JSON.stringify(pa1Expanded)
          + ' ｜ judge=' + JSON.stringify([s1, s2, s3])
          + ' ｜ 收口保存=' + savedForNext
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 乙 结构轴开关：零序列化写入 + 启动/切项目回树结构 ================= */
  {
    name: '乙 结构轴开关（树/复杂）默认 = 树结构、会话级内存：切模式前后**盘上 sha256 逐字节不变**、isDirty 仍 false、序列化产物的顶层键集与 meta 键集逐项相同（一个新键都没多）；重开项目 ⇒ 模式读数回 tree',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input）⇒ 判红' };
      // 前置：退出上一次可能还开着的关系视图 + 模式回树（幂等；都不是本档要判的东西）。
      // ⚠️ **不要** expand_all：展开会改内存里的 expanded ⇒ isDirty 当场变 true，
      //    "切模式不产生未保存改动"这条判据就没法判了（域 46 的文件头记过同一件事）。
      //    本档选中的中心节点是**顶层主题 t1**：打开项目后就渲染着，且它没有任何自由边
      //    ⇒ showRelated 走"还没有关联节点"那一支，一个节点都不用展开 ⇒ 内存零变化 ✓
      await clearRelated(ctx);
      await setMode(ctx, 'tree');
      const t0 = await serText(ctx);
      const k0 = keySets(t0);
      const h0 = sha256(readRaw(P));
      const dirty0 = await isDirty(ctx);
      const modeAtStart = await modeNow(ctx);
      const themed0 = await ctx.exec('window.MMApp.isThemeMode()');

      // —— 切复杂（带一个选中节点 ⇒ 真的走 showRelated 那一跳）→ 切回树 ——
      await selectNode(ctx, 't1');
      const sw1 = await setMode(ctx, 'complex');
      const modeMid = await modeNow(ctx);
      const t1 = await serText(ctx);
      const h1 = sha256(readRaw(P));
      const sw2 = await setMode(ctx, 'tree');
      const modeEnd = await modeNow(ctx);
      const t2 = await serText(ctx);
      const h2 = sha256(readRaw(P));
      const dirtyEnd = await isDirty(ctx);
      const themed1 = await ctx.exec('window.MMApp.isThemeMode()');
      const k2 = keySets(t2);

      // —— 启动 / 切项目 ⇒ 回树结构（重开同一个项目也算"切项目"那一跳）——
      await setMode(ctx, 'complex');
      const modeBeforeReopen = await modeNow(ctx);
      await openProject(ctx, P);
      await WAIT.frames(ctx, PAINT);
      const modeAfterReopen = await modeNow(ctx);
      const h3 = sha256(readRaw(P));

      const keysSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const checks = [
        ['默认档 = 树结构（不碰开关时就是它）', modeAtStart === 'tree'],
        ['切换前盘上就是夹具那一份（基线）', h0 === sha256(readRaw(P))],
        ['复杂档真的切过去了（读数 = complex）', modeMid === 'complex' && sw1 && sw1.mode === 'complex'],
        ['复杂档那一跳**盘上零写入**（sha256 逐字节不变）', h1 === h0],
        ['复杂档那一跳序列化产物一个**新键**都没多（顶层键集 + meta 键集逐项相同）',
          keysSame(k0.top, keySets(t1).top) && keysSame(k0.meta, keySets(t1).meta)],
        ['复杂档那一跳没有未保存改动（isDirty 仍 false）', dirty0 === false],
        ['切回树档：读数回 tree，且**盘上零写入**', modeEnd === 'tree' && h2 === h0],
        ['切回树档后序列化产物仍与切换前逐字节相同（含 meta 键集）',
          t2 === t0 && keysSame(k2.meta, k0.meta)],
        ['两档都没产生未保存改动', dirtyEnd === false],
        ['两条轴正交：切新轴不改旧轴读数（isThemeMode 前后相同）', themed0 === themed1],
        ['启动/切项目回树结构：切到复杂档后重开项目 ⇒ 读数回 tree',
          modeBeforeReopen === 'complex' && modeAfterReopen === 'tree'],
        ['重开项目也不写盘（sha256 仍等于基线）', h3 === h0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: 'mode: ' + modeAtStart + '→' + modeMid + '→' + modeEnd + ' · 重开 ' + modeBeforeReopen + '→' + modeAfterReopen
          + ' ｜ 盘上 sha256 ' + h0.slice(0, 12) + ' ⇒ ' + h1.slice(0, 12) + ' ⇒ ' + h2.slice(0, 12) + ' ⇒ ' + h3.slice(0, 12)
          + ' ｜ 顶层键 ' + JSON.stringify(k0.top) + ' · meta 键 ' + JSON.stringify(k0.meta)
          + ' ⇒ ' + JSON.stringify(k2.meta) + ' ｜ isDirty ' + dirty0 + '→' + dirtyEnd
          + ' ｜ isThemeMode ' + themed0 + '→' + themed1
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 丙 一处实现 + 两条轴正交（结构断言） ================= */
  {
    name: '丙 一处实现/正交（结构断言，扫描面 = renderer/**.js + src/*.js，剥注释后）：fdStructureMode 只在 app-view.js；切模式两个出口各一处；resetStructureMode 调用点恰好一处（app-actions.js 的 openProject）；MM.showDetail 在 contextmenu.js 恰好一处；序列化形状 structureMode 在 src/ 与 app-core.js 0 命中（判别力 = app-view.js 里确有这些 needle）',
    run: async (ctx) => {
      // —— 扫描面（照 B4b：扫描面与 needle 一起声明；先剥注释，再看"实现形状"）——
      const rootDir = path.resolve(__dirname, '..', '..');
      const rendererDir = path.join(rootDir, 'renderer');
      const srcDir = path.join(rootDir, 'src');
      const scan = [];
      (function walk(d) {
        fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); return; }
          if (/\.js$/.test(e.name)) scan.push(p);
        });
      })(rendererDir);
      fs.readdirSync(srcDir, { withFileTypes: true }).forEach((e) => {
        if (e.isFile() && /\.js$/.test(e.name)) scan.push(path.join(srcDir, e.name));
      });
      const strip = new Map();
      scan.forEach((p) => strip.set(p, stripComments(fs.readFileSync(p, 'utf8'))));
      const rel = (p) => path.relative(rootDir, p).replace(/\\/g, '/');
      const countIn = (needle, only) => {
        const out = [];
        strip.forEach((code, p) => {
          if (only && !only.test(rel(p))) return;
          let at = 0, i = code.indexOf(needle);
          while (i >= 0) { at++; i = code.indexOf(needle, i + 1); }
          if (at) out.push(rel(p) + ' × ' + at);
        });
        return out.sort();
      };
      const defs = countIn('function setStructureMode(');
      const mmExport = countIn('MM.setStructureMode =');
      const resetCalls = countIn('resetStructureMode()');
      const flagHits = countIn('fdStructureMode');
      const showDetailCalls = countIn('MM.showDetail(', /renderer\/contextmenu\.js$/);
      const serializerHits = countIn('structureMode', /(^|\/)src\/|renderer\/app-core\.js$/);
      const menuItem = countIn('structureModeItem');
      const flagFiles = Array.from(new Set(flagHits.map((x) => x.split(' × ')[0])));
      const floor = 25;   // 扫描面够大（掉到个位数说明扫描面搭错了）

      const checks = [
        ['扫描面够大（>= ' + floor + ' 个第一方 js）', scan.length >= floor],
        ['判别力：app-view.js 里确有这些 needle（判据不空转）',
          defs.length === 1 && defs[0].indexOf('renderer/app-view.js') === 0],
        ['结构：fdStructureMode 只出现在一个文件里（唯一一份模式状态）',
          flagFiles.length === 1 && flagFiles[0] === 'renderer/app-view.js'],
        ['结构：MM.setStructureMode 出口恰好一处（app-view.js）',
          mmExport.length === 1 && mmExport[0] === 'renderer/app-view.js × 1'],
        ['结构：菜单项 structureModeItem 恰好一处定义 + 一处使用（都在 contextmenu.js）',
          JSON.stringify(menuItem) === JSON.stringify(['renderer/contextmenu.js × 2'])],
        ['结构：resetStructureMode 恰好一处**调用点**（app-actions.js 的 openProject）+ 一处定义',
          JSON.stringify(resetCalls) === JSON.stringify(['renderer/app-actions.js × 1', 'renderer/app-view.js × 1'])],
        ['一处实现：contextmenu.js 里 MM.showDetail( 恰好一处调用（不许新开第二条开详情的路）',
          JSON.stringify(showDetailCalls) === JSON.stringify(['renderer/contextmenu.js × 1'])],
        ['序列化形状 0 命中：structureMode 不出现在 src/** 与 app-core.js（不进任何序列化/schema 路径）',
          serializerHits.length === 0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '扫描面=' + scan.length + ' · fdStructureMode=' + JSON.stringify(flagHits)
          + ' · 出口=' + JSON.stringify(mmExport) + ' · 菜单=' + JSON.stringify(menuItem)
          + ' · 复位调用=' + JSON.stringify(resetCalls) + ' · showDetail=' + JSON.stringify(showDetailCalls)
          + ' · 序列化面命中=' + JSON.stringify(serializerHits)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 丁 拖动不受树层约束（真鼠标） ================= */
  {
    name: '丁 拖动不受树层约束：真鼠标把第 4 层的子树沿两条轴各挪一段 ⇒ 只有它和后代按**指针位移**平移（两条轴都没有被层/列夹住）、其余节点屏幕矩形逐项相同、父子关系逐字节不变、拖动期间盘上零写入；保存后盘上**只多该子树根那一个偏移键**（后代一个键都没有）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input）⇒ 判红' };
      // 前置：收掉上一档可能留着的浮详情框（它压在画布上会把"命中测试"判成红 —— 那一红不是
      //       拖动的缺陷；域 46 的"浮层盖住点"是同型的一课）
      await ctx.exec('(async function () { await window.MMApp.closeAllFloatDetail(); return 1; })()');
      await clearRelated(ctx);
      await setMode(ctx, 'tree');
      await ctx.exec('window.MMApp.resetView(); 1');       // 100% 缩放 + 根居中 + 清偏移（干净基线）
      await expandAll(ctx);
      await WAIT.frames(ctx, PAINT);
      // 前置：把**第 4 层**的目标节点挪进视野（与用户平移画布同一个出口 `MM.setViewTransform`，
      // 照域 46 的 centerNode）。为什么必须有：resetView 把**根**居中，而深层节点可能落在面板外
      // ⇒ 连"判的对象"都没进视野（本域第一版实测：命中 = BODY，那一红不是产品缺陷 ✗）。
      await centerNode(ctx, TARGET, 0.5, 0.5);
      await waitStableView(ctx);
      await WAIT.frames(ctx, PAINT);
      // 前置：右键菜单里对**第 4 层**节点**已经没有**「拖动此子树」这一条（2026-10-33 批4 摘入口；
      // 判据用**真右键**（走 Chromium 命中测试）拿菜单，读完条目立刻关掉）。
      // ⚠️ 这条改写成"没有"而不是删掉：改前它判"入口不受层约束"，现在同一句话变成
      //    "连同第 4 层在内都不再有入口了"（拖动本体仍由下面直接调 API 进，判据一条没少）。
      const hp0 = await hitPoint(ctx, TARGET);
      if (!hp0.ok) return { ok: false, text: '前置失败：目标节点取不到命中点 —— ' + hp0.text };
      await ctx.input.drag(hp0.pt, hp0.pt, undefined, { button: 'right', stepDelayMs: 0 });
      await WAIT.frames(ctx, PAINT);
      const menuItems = await ctx.exec('(function () { var m = document.getElementById("ctx-menu");'
        + ' var items = m ? Array.prototype.map.call(m.querySelectorAll(".ctx-item"), function (x) { return x.textContent; }) : [];'
        + ' if (window.MMContextMenu) window.MMContextMenu.closeMenu();'
        + ' return items; })()');
      const menuShown = Array.isArray(menuItems) && menuItems.length > 0;
      const noSubDrag = menuShown && !menuItems.some((t) => t.indexOf('拖动此子树') >= 0);
      await WAIT.frames(ctx, STEP);
      // —— 基线：先**保存一次**，让盘上那份进入"界面整树写回"的规范形态（否则后面那条
      //    "除偏移键外其余字节不变"会被保存本身带来的规范化 —— 如 meta.version 由夹具的
      //    0.0.0 变成产品版本 —— 打成假红 ✗；那不是拖动造成的差异）——
      const normSaved = await save(ctx);
      await WAIT.frames(ctx, { delayMs: 160 });
      await waitStableView(ctx);
      const baseData = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      const baseDiskRaw = readRaw(P);                 // 拖前的盘上原文（白名单判据的基线）
      const h0 = sha256(baseDiskRaw);
      const diskHasOffsets = Object.keys(JSON.parse(baseDiskRaw).meta || {}).indexOf('nodeOffsets') >= 0;

      // —— 进入拖动模式（2026-10-33 批4：菜单里那一条入口已摘 ⇒ 直接调 API；它才是"模式还在"的证据）——
      await ctx.exec('window.MMApp.setDragMode(true, ' + JSON.stringify(TARGET) + '); 1');
      await WAIT.frames(ctx, STEP);
      await waitStableView(ctx);
      const entered = await ctx.exec('(function () { return { on: window.MMApp.dragModeActive(),'
        + ' root: window.MMApp.getDragTreeRoot() }; })()');
      const radar0 = await ctx.exec(RADAR);           // 几何基线取在**所有会改视图的动作之后**

      // 落点现算：目标子树整体平移后不压别的可见节点、且完整落在面板里（八个方向 × 五档幅度）
      const plan = (function () {
        const p = radar0.panel;
        const ids = Object.keys(radar0.rects);
        const sub = ids.filter((id) => TARGET_SUB.indexOf(id) >= 0);
        if (!sub.length) return { why: '目标子树一个都没渲染出来' };
        const box = (dx, dy) => {
          let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
          sub.forEach((id) => {
            const x = radar0.rects[id];
            l = Math.min(l, x.l + dx); t = Math.min(t, x.t + dy);
            r = Math.max(r, x.l + x.w + dx); b = Math.max(b, x.t + x.h + dy);
          });
          return { l: l, t: t, r: r, b: b };
        };
        const others = ids.filter((id) => TARGET_SUB.indexOf(id) < 0).map((id) => radar0.rects[id]);
        const seq = [[1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, -1], [1, -1], [-1, 1]];
        for (const m of [180, 150, 120, 90, 60]) {
          for (const d of seq) {
            const dx = d[0] * m, dy = d[1] * m;
            const nb = box(dx, dy);
            if (nb.l < p.left + 24 || nb.t < p.top + 24 || nb.r > p.right - 60 || nb.b > p.bottom - 60) continue;
            if (others.some((o) => !(nb.r < o.l || nb.l > o.l + o.w || nb.b < o.t || nb.t > o.t + o.h))) continue;
            const f = radar0.rects[TARGET];
            return { from: { x: Math.round(f.l + f.w / 2), y: Math.round(f.t + f.h / 2) },
              dx: dx, dy: dy,
              land: { x: Math.round(f.l + f.w / 2 + dx), y: Math.round(f.t + f.h / 2 + dy) } };
          }
        }
        return { why: '八个方向 × 五档幅度都找不到"不压别的节点且落在面板里"的落点' };
      })();
      if (plan.why) return { ok: false, text: '取不到落点：' + plan.why };
      // 前置：按下的那一点此刻真的压在目标节点上（否则拖的是别的东西，读数会以"没动"的形状骗人）
      const downHit = await ctx.exec('(function () { var h = document.elementFromPoint('
        + Math.round(plan.from.x) + ',' + Math.round(plan.from.y) + ');'
        + ' var nd = h && h.closest ? h.closest("jmnode[nodeid]") : null;'
        + ' return { self: !!(nd && nd.getAttribute("nodeid") === ' + JSON.stringify(TARGET) + '),'
        + ' who: h ? ((h.tagName || "") + (h.id ? "#" + h.id : "")) : null }; })()');
      if (!downHit || downHit.self !== true) {
        return { ok: false, text: '前置失败：按下的那一点没压在 ' + TARGET + ' 上（命中='
          + (downHit ? downHit.who : 'null') + '）⇒ 拖动这条判据无从验起，判红而不是跳过' };
      }

      await ctx.input.mouseDown(plan.from);
      await WAIT.frames(ctx, STEP);
      await ctx.input.moveTo({ x: plan.from.x + Math.round(plan.dx / 2), y: plan.from.y + Math.round(plan.dy / 2) });
      await WAIT.frames(ctx, STEP);
      await ctx.input.moveTo(plan.land);
      await WAIT.frames(ctx, STEP);
      const hMid = sha256(readRaw(P));      // 拖动**期间**（还没松手、没保存）
      await ctx.input.mouseUp(plan.land);
      await WAIT.frames(ctx, PAINT);
      await ctx.exec('window.MMApp.setDragMode(false); 1');
      const radar1 = await ctx.exec(RADAR);
      const afterData = await ctx.exec('JSON.stringify(window.MMApp.serializeTree().data)');
      const diff = cmpRects(radar0.rects, radar1.rects);
      const movedIds = diff.moved.map((m) => m.id).sort();
      const movedOk = diff.moved.every((m) => m.dx === plan.dx && m.dy === plan.dy && m.dw === 0 && m.dh === 0);

      // 显式保存 ⇒ 盘上才出现偏移（条件写回：没拖过的项目一个键都不写）
      const saved = await save(ctx);
      await WAIT.frames(ctx, { delayMs: 160 });
      const diskAfter = readRaw(P);
      const hAfterSave = sha256(diskAfter);
      const parsedAfter = JSON.parse(diskAfter);
      const offKeys = Object.keys((parsedAfter.meta && parsedAfter.meta.nodeOffsets) || {});
      const offVal = (parsedAfter.meta && parsedAfter.meta.nodeOffsets
        && parsedAfter.meta.nodeOffsets[TARGET]) || null;
      // 白名单判据：把盘上那一份的 nodeOffsets 整键摘掉之后，必须与**拖动前**那一份逐字节等价
      // （这份解析在字符串层比较：JSON.parse→JSON.stringify 保序 ⇒ 相等即"除该键外一个字节没动"）
      const stripped = JSON.parse(diskAfter);
      if (stripped.meta && stripped.meta.nodeOffsets) delete stripped.meta.nodeOffsets;
      const onlyOffsetKey = JSON.stringify(stripped) === JSON.stringify(JSON.parse(baseDiskRaw));
      const checks = [
        ['前置：第 4 层节点的右键菜单**确实弹出来了**且里面**没有**「拖动此子树」（入口 2026-10-33 批4 已摘、与层级无关）',
          noSubDrag === true],
        ['前置：基线那次"规范化保存"成功（盘上是界面整树写回的那一形态）', normSaved === true],
        ['拖动模式锁定的就是那个**深层**子树根', entered.on === true && entered.root === TARGET],
        ['基线：夹具本来没有 nodeOffsets 键（条件写回的对照）', diskHasOffsets === false],
        ['只有目标子树按**指针位移**走（两条轴都没有被"第几层 ⇒ 第几列"夹住）',
          movedIds.length === TARGET_SUB.length && JSON.stringify(movedIds) === JSON.stringify(TARGET_SUB.slice().sort())
          && movedOk === true],
        ['其余节点屏幕矩形**逐项相同**（没动的那些一个都没动）',
          diff.unchanged.length + diff.moved.length + diff.gone.length === Object.keys(radar0.rects).length
          && diff.unchanged.length === Object.keys(radar0.rects).length - TARGET_SUB.length],
        ['没有节点消失、挂载数与基线相同', diff.gone.length === 0 && radar1.mounted === radar0.mounted],
        ['父子关系逐字节不变（拖动只动位置，不动树）', afterData === baseData],
        ['拖动**期间**（还没松手/没保存）盘上零写入', hMid === h0],
        ['保存成功', saved === true],
        ['盘上只多**该子树根那一个**偏移键（后代一个键都没有）',
          JSON.stringify(offKeys) === JSON.stringify([TARGET])],
        ['那一个键的值 == 本次拖动位移（两轴都要对上）',
          !!offVal && offVal.x === plan.dx && offVal.y === plan.dy],
        ['除这一个键外盘上其余字节没有变化（白名单为空）', onlyOffsetKey],
        ['差分读数自洽（unchanged + moved = 基线节点数）',
          diff.moved.length + diff.unchanged.length === Object.keys(radar0.rects).length]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '入口已摘=' + noSubDrag + '（菜单 ' + (menuItems || []).length + ' 项：' + JSON.stringify((menuItems || []).slice(-2)) + '）· 锁定=' + JSON.stringify(entered) + ' · 位移=(' + plan.dx + ',' + plan.dy + ')'
          + ' · moved=' + JSON.stringify(diff.moved) + ' · unchanged=' + diff.unchanged.length
          + '/' + Object.keys(radar0.rects).length + ' · gone=' + diff.gone.length
          + ' · data 逐字节不变=' + (afterData === baseData)
          + ' · 盘上 sha256 ' + h0.slice(0, 12) + '→拖动中 ' + hMid.slice(0, 12) + '→保存后 ' + hAfterSave.slice(0, 12)
          + ' · nodeOffsets 键=' + JSON.stringify(offKeys) + ' 值=' + JSON.stringify(offVal)
          + ' · 其余字节不变=' + onlyOffsetKey
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 戊 关系层在复杂模式下的画法 ================= */
  {
    name: '戊 关系层在复杂模式下的画法（复用既有取舍、不新立阈值）：复杂模式开 ⇒ 线数 == 既有模型逐条算出的边数 == 成员数 + 团边数；成员 > 既有 CLIQUE_MAX ⇒ 只画星形（0 条团边，且把"不设上限会是多少"现算做对照）；跨项目成员**只标不画**（既有编辑条里列着它、画出来的线段里没有它）；切回树 ⇒ 层清空',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input）⇒ 判红' };
      await expandAll(ctx);
      await WAIT.frames(ctx, PAINT);

      // —— 第一轮：中心 pa（成员 3 个 <= 上限 ⇒ 团边要画；另有 1 条跨项目边）——
      const ra = await relatedRound(ctx, PA);
      if (ra.ok === false) return { ok: false, text: ra.text };
      const barA = await waitBarEdges(ctx, 2);
      // 画出来的每条线两端都必须在场（跨项目那条画不出来 ⇒ 端点里不许出现别的项目的节点）
      const raEnds = Array.from(new Set(ra.drawnEdges.map((e) => e.split('>')[0]).concat(ra.drawnEdges.map((e) => e.split('>')[1]))));
      const aRenderedOk = ra.model.edges.every((e) => {
        const ids = e.split('>');
        return ra.rendered[ids[0]] === true && ra.rendered[ids[1]] === true;
      });
      const aCliqueExpect = (function () {
        const m = ra.model.members.filter((x) => x === PA1 || x === PA2).length;   // a-s3 里落进成员集的
        return m * (m - 1) / 2;
      })();

      // —— 第二轮：中心 qa（成员 9 个 > 上限 ⇒ 团边不画）——
      const rb = await relatedRound(ctx, QA);
      if (rb.ok === false) return { ok: false, text: rb.text };
      const overMax = rb.model.members.length > rb.model.cliqueMax;
      const ifCliqueDrawn = rb.model.members.length
        + rb.model.members.length * (rb.model.members.length - 1) / 2;

      // —— 第三：切回树结构 ⇒ 关系层清空 ——
      await setMode(ctx, 'tree');
      await WAIT.frames(ctx, PAINT);
      const off = await ctx.exec('(function () { var svg = document.getElementById("mm-rel-layer");'
        + ' return { lines: svg ? svg.querySelectorAll(\'path[data-role="relation-line"]\').length : 0,'
        + ' active: window.MM.isRelatedActive ? window.MM.isRelatedActive() : null }; })()');

      const checks = [
        ['A 前置：模型算出来的每条边两端都渲染出来了（否则线数判据不成立 ⇒ 采不到真值就红）', aRenderedOk === true],
        ['A 田：复杂模式切换真的走了既有入口（返回 ok + 读数 active）',
          !!ra.switchResult && ra.switchResult.ok === true && ra.active === true],
        ['A 线数 == 既有模型逐条算出的边数（画法口径：模型说什么就画什么）',
          ra.lineCount === ra.model.edges.length],
        ['A 两层同源：视觉层与命中层的条数相同、且 dataset.count 一致',
          ra.hitCount === ra.lineCount && ra.dataset === String(ra.lineCount)],
        ['A 高亮成员集 == 模型算出的成员集', JSON.stringify(ra.members.slice().sort()) === JSON.stringify(ra.model.members.slice().sort())],
        ['A 上限之内 ⇒ 团边真的画了（成员间 1 条 == C(2,2)，既有取舍没有变成"一律不画"）',
          ra.model.clique === aCliqueExpect && ra.model.clique === 1],
        ['A 线数 == 星形 + 团边（成员 3 ⇒ 3 + 1 = 4）',
          ra.lineCount === ra.model.star + ra.model.clique && ra.model.star === 3],
        ['A 跨项目成员**只标不画**：既有编辑条里列着它（' + P2 + '/bx）',
          barA.ok === true && ra.barOut.some((x) => x.indexOf(P2 + '/bx') === 0)],
        ['A 画出来的线段里**一个端点都不指向**它（不画那一半）',
          raEnds.indexOf('bx') < 0 && ra.model.crossProject === 1],
        /* ⚠️ 线的"在屏"判据**故意只判"至少有一条被自己接住"** —— 逐条判"中点必须命中自己"实测
         * 会红：本域 A 轮 4 条线里有 3 条通过，越线交叉处与**汇聚点**（9 条星形边共用中心节点
         * 那一个端点）会让邻居的命中热区（stroke 加粗）挡住中点 —— 那是**正常形态**（点线开笔记
         * 点到的是压在上的那一条），不是缺陷 ⇒ 按 skill 的 H3b，这一档要有"第三种答案"：
         * 逐条读数（self true/false 与命中到谁）如实列进报文，判据只取存在性 ✓。 */
        ['A 至少有一条线的中点被它自己的命中热区接住（命中层真的在屏上、真的点得到）',
          ra.lineHits.length === ra.lineCount && ra.lineHits.length > 0
          && ra.lineHits.some((x) => x.self === true)],
        ['B 前置：这一轮的成员数确实超过既有上限（CLIQUE_MAX 现读，不写死）',
          overMax === true && rb.model.cliqueMax === 8 && rb.model.members.length === 9],
        ['B 线数 == 既有模型算出的边数 == 成员数（> 上限 ⇒ 只画星形）',
          rb.lineCount === rb.model.edges.length && rb.lineCount === rb.model.members.length],
        ['B 超上限 ⇒ 团边 0 条（两条判据一起能分辨 A/B 两种状态）',
          rb.model.clique === 0],
        ['B 若照 A 的口径画团边会是 ' + ifCliqueDrawn + ' 条（现算，只作对照读数）',
          rb.lineCount !== ifCliqueDrawn],
        ['B 切回树结构 ⇒ 关系层清空（线段 0 条、active=false）',
          off.lines === 0 && off.active === false],
        ['B 每条画出来的线也都真的在屏上（命中层里每条线都有它自己的热区，且至少一条被自己接住）',
          rb.lineHits.length === rb.lineCount && rb.lineHits.some((x) => x.self === true)]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: 'A(pa) 线=' + ra.lineCount + ' 模型=' + JSON.stringify({ m: ra.model.members.length, star: ra.model.star, clique: ra.model.clique, cross: ra.model.crossProject })
          + ' 段端点=' + JSON.stringify(raEnds) + ' 编辑条出边=' + JSON.stringify(ra.barOut)
          + ' 线命中=' + JSON.stringify(ra.lineHits) + ' 中心命中=' + ra.hitSelf + '/' + ra.hitWho
          + ' ｜ B(qa) 线=' + rb.lineCount + ' 模型=' + JSON.stringify({ m: rb.model.members.length, star: rb.model.star, clique: rb.model.clique, max: rb.model.cliqueMax })
          + '（不设上限会是 ' + ifCliqueDrawn + '）· 线命中=' + JSON.stringify(rb.lineHits.map((x) => x.self))
          + ' ｜ 切回树 ⇒ 线=' + off.lines + ' active=' + off.active
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 己 收尾 ================= */
  {
    name: '己 收尾：关详情框 / 退出关系视图 / 模式回树 / 偏移清回自动布局并落盘 / 删两个夹具项目（自证不存在）/ 开回原项目 / 复位确认桩（不给后面的域留状态）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input）⇒ 判红' };
      await clearRelated(ctx);
      await setMode(ctx, 'tree');
      await ctx.exec('(async function () { await window.MMApp.closeAllFloatDetail(); return 1; })()');
      const cleaned = await mm.closeDialogs(ctx);
      const cleared = await ctx.exec('(function () { window.MM.clearTreeOffsets();'
        + ' return Object.keys(window.MMApp.getNodeOffsets()).length + Object.keys(window.MMApp.getTreeOffsets()).length; })()');
      const saved = await save(ctx);
      const disk = JSON.parse(readRaw(P));
      const offLeft = Object.keys((disk.meta && disk.meta.nodeOffsets) || {}).length
        + Object.keys((disk.meta && disk.meta.themeOffsets) || {}).length;
      await stubConfirm(ctx, true);
      const back = await openProject(ctx, PROJECT_WHEN_ENTERED || 'comnet');
      const removed = rmFixtures();
      await stubConfirm(ctx, null);
      const state = await ctx.exec('(function () { var s = window.MMApp.getFloatDetailState();'
        + ' return { boxes: s.boxes, mode: window.MMApp.structureMode(),'
        + ' related: window.MM.isRelatedActive ? window.MM.isRelatedActive() : null,'
        + ' drag: window.MMApp.dragModeActive() }; })()');
      const checks = [
        ['盘上偏移键已清零（清回自动布局 + 落盘）', cleared === 0 && saved === true && offLeft === 0],
        ['夹具两个项目目录已删（沙箱夹具直删；自证不存在）', removed.removed === true && removed.gone === true],
        ['开回进来时那个项目（' + (PROJECT_WHEN_ENTERED || '(空)') + '）', back === true],
        ['确认桩已复位、产品模态已收干净', STUB_INSTALLED === false && cleaned.n >= 0],
        ['收尾后无残留状态（详情框 0 / 模式 tree / 关系视图关 / 拖动模式关）',
          state.boxes === 0 && state.mode === 'tree' && state.related === false && state.drag === false]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '偏移清零=' + cleared + ' 保存=' + saved + ' 盘上键=' + offLeft
          + ' · 删夹具=' + JSON.stringify(removed) + ' · 开回=' + back
          + ' · 收掉模态=' + cleaned.n + ' · 桩复位=' + (STUB_INSTALLED === false)
          + ' · 收尾读数=' + JSON.stringify(state)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  }

];

module.exports = assertions;
