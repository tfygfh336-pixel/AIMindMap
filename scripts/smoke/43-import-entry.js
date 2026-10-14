/* ============================================================
 * scripts/smoke/43-import-entry.js —— 【W13】界面侧导入入口（选文件 / 选目录 → 预览 → 真导入 → 播报）
 * ------------------------------------------------------------
 * 用户原话（待做清单 W13）：「现在只能走 CLI，界面里点不进来」—— 想导整库的人第一反应就是拖目录 / 翻菜单。
 * 本域钉的是**界面那一半**（`renderer/app-import.js` + 主进程那三条入口），六条判据：
 *
 *   甲 入口与预览：原生菜单两条都在（导图页在 ⇒ 启用）+ **真鼠标**走命令面板那一行 ⇒ 预览层出现；
 *      三个数（新增 / 更新 / 未转换）与逐条点名**全部来自 CLI 既有的 `--dry-run` 读数**，
 *      而它跑在**演练副本**上 ⇒ 此刻用户项目**逐字节不变**（判据②）。
 *   乙 真导入：**真鼠标**点「确认导入」⇒ 节点出现在盘上；**对拍**：预览说的新增 N = 主进程现算的
 *      "这次多了哪些节点" = 从两份项目 JSON 现算的差集（判据①，逐节点现算，**不写死任何数**）；
 *      落点（父节点）除 `children` 外逐字节未变、新子树一律折叠（判据③的文件那一半）。
 *   丙 坏文件混在里面（一个目录冒充 .md）⇒ 好的照进、坏的**逐条点名**（判据④：部分成功）。
 *   丁 变更播报：banner 亮（elementFromPoint）⇒ 真鼠标点「看这次加了哪些」⇒ 只读面板逐条列出这次新增的
 *      节点 ⇒ 真鼠标点一行 ⇒ **真的跳到那个节点**（判据⑤：选中 + 展开祖先链 + 命中测试看得见）。
 *   戊 选目录 ⇒ 整库导入**新建一个项目**：新项目里除根外**每个节点都是折叠**的、根那一档没被改；
 *      预览期间盘上零写入（那个项目还没出现）；预览数 = 现算数（判据③的目录那一半 + 判据②）。
 *   己 默认档：浮层全 `display:none`、命中测试落不到、**工具栏里一个 import 元素都没有**、
 *      `#main` 顶边 = 工具栏底边（没在导入时这一批不许让界面多出一个像素）。
 *   庚 【账①】切项目守卫（`confirmDiscardIfDirty`）走**同一个打桩口**（`MM.setConfirmStub`）：
 *      桩说"取消" ⇒ 守卫按取消处理（留在原项目、改动还在）；桩说"确定" ⇒ 按确定处理（真的切过去）；
 *      桩复位 ⇒ 守卫仍落到 `window.confirm` 本体（真机路径未变）。三步都必须**取得到读数**——
 *      之前这条守卫直接用 `window.confirm` 本体，无头跑里"界面脏 + 切项目"会把渲染层 JS 线程整个卡住 ✗。
 *
 * 判据纪律（与 36/37/42 同）：可见性一律 `document.elementFromPoint`（`rect` 只用来定位）；
 * 动作一律**真鼠标**（`ctx.input.click` 走 Chromium 命中测试），不是 dispatchEvent 合成事件；
 * 真值读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 由 main.js 在 --smoke 下指向临时副本
 * ⇒ 读到的就是本次跑动的真实盘上形态，且真实 `projects/**` 零写入）。
 * ⚠️ 两条"选文件 / 选目录"的跳在 `--smoke` 下是**脚本化答案**（`<沙箱>/import-pick-files.txt` /
 *    `import-pick-dir.txt`）：无头跑点不动原生模态，弹出来只会把整条链挂死（冒烟守卫会强杀 ⇒ 假红）。
 *    界面把 `stub:true` 如实显示出来 —— 其余每一跳（预览 / 确认 / 两条既有 CLI / 播报 / 跳转）都是产品真路径。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** 两条源目录（**不属于 projects/ 真实数据**；本域收尾时删干净） */
const SRC = path.join(os.tmpdir(), 'zz-imp-src');
const LIB = path.join(os.tmpdir(), 'zz-imp-lib');
const P = 'zz-imp-entry';            // 文件那一路的目标项目
const P_DIR = 'zz-imp-lib';          // 目录那一路会**新建**的项目（名字 = 目录名清洗后的结果）
/** 庚 用：切过去的那一个**沙箱**项目（切项目的守卫要有"另一个项目"才走得到；真项目一个都不碰） */
const P_OTHER = 'zz-imp-switch';
const STAMP = String(Date.now());
const PARENT_ID = 'p-imp-parent';
const PARENT_TOPIC = '导入落点 ' + STAMP;

const A_MD = '# 甲主题 ' + STAMP + '\n甲正文\n## 甲子题 ' + STAMP + '\n甲子题正文\n';
const B_MD = '# 乙主题 ' + STAMP + '\n乙正文\n';
const C_MD = '# 丙主题 ' + STAMP + '\n丙正文\n## 丙子题 ' + STAMP + '\n';
const D_MD = '# 丁主题 ' + STAMP + '\n';
const L1_MD = '# 一主题 ' + STAMP + '\n一正文\n';
const L2_MD = '# 二主题 ' + STAMP + '\n二正文\n';
const L3_MD = '# 三主题 ' + STAMP + '\n三正文\n';
/** 坏文件：一个**目录**冒充 .md（`import-md` 会响亮拒它 —— 实测报文"这是一个目录，不是文件"） */
const BAD_REL = 'bad.md';

/** 进来时界面开着哪个项目（本域收尾要交还回去 —— 与域 42 同一条纪律） */
let PROJECT_WHEN_ENTERED = '';

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到沙箱真值');
  return d;
}
const pickFilesStub = () => path.join(projectsDir(), 'import-pick-files.txt');
const pickDirStub = () => path.join(projectsDir(), 'import-pick-dir.txt');
const projectFile = (name) => path.join(projectsDir(), name, name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const readProject = (name) => JSON.parse(readRaw(name));
const hasProject = (name) => fs.existsSync(projectFile(name));
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();

/** 沙箱里现有哪些项目（升序；用来判"预览期间不许冒出任何新项目"） */
function projectNames() {
  return fs.readdirSync(projectsDir())
    .filter((n) => n.charAt(0) !== '.' && fs.statSync(path.join(projectsDir(), n)).isDirectory())
    .sort();
}
function allNodes(name) {
  const out = [];
  (function walk(n) { if (!n) return; out.push(n); (n.children || []).forEach(walk); })(readProject(name).data);
  return out;
}
function nodeById(name, id) { return allNodes(name).filter((n) => n.id === id)[0] || null; }
/** 节点本体（**不含 children**）的逐字节形态 —— 用来判"父节点除 children 外一个字节都没变" */
function nodeBodyRaw(name, id) {
  const n = nodeById(name, id);
  if (!n) return null;
  const rest = {};
  Object.keys(n).forEach((k) => { if (k !== 'children') rest[k] = n[k]; });
  return JSON.stringify(rest);
}
/** 两份项目 JSON 之间**新增的节点 id**（**现算**：只按 id 集合取差 —— 不看标题、不写死任何数） */
function addedIdsBetween(beforeRaw, afterRaw) {
  const idsOf = (raw) => {
    const set = new Set();
    (function walk(n) { if (!n) return; if (n.id) set.add(n.id); (n.children || []).forEach(walk); })(JSON.parse(raw).data);
    return set;
  };
  const a = idsOf(beforeRaw), b = idsOf(afterRaw);
  const out = [];
  b.forEach((id) => { if (!a.has(id)) out.push(id); });
  return out.sort();
}
function seedFiles(files) {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  Object.keys(files).forEach((rel) => {
    const abs = path.join(SRC, rel);
    if (files[rel] === null) { fs.mkdirSync(abs, { recursive: true }); return; }   // null = 造一个**目录**
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel], 'utf8');
  });
}
function seedLib() {
  fs.rmSync(LIB, { recursive: true, force: true });
  fs.mkdirSync(path.join(LIB, '甲'), { recursive: true });
  fs.mkdirSync(path.join(LIB, '乙'), { recursive: true });
  fs.mkdirSync(path.join(LIB, '空目录'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '甲', '一.md'), L1_MD, 'utf8');
  fs.writeFileSync(path.join(LIB, '甲', '二.md'), L2_MD, 'utf8');
  fs.writeFileSync(path.join(LIB, '乙', '三.md'), L3_MD, 'utf8');
}
function writeStub(file, lines) { fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8'); }
/** 跑一条 CLI 并拿**退出码**：`ctx.runCli` 失败是**抛错**（不是返回 `{code}`）⇒ 这里翻成显式的 code，
 *  绝不把"没跑成"读成"通过了"（`v.code === undefined` 与 `0` 必须分得开）。 */
function cliCode(ctx, args) {
  try { return { code: 0, out: String(ctx.runCli(args) || '') }; }
  catch (e) { return { code: 1, error: (e && e.message) || String(e) }; }
}
function cleanupSandbox() {
  try { fs.rmSync(SRC, { recursive: true, force: true }); } catch (e) { /* 收尾失败不掩盖主判据 */ }
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
  try { fs.rmSync(pickFilesStub(), { force: true }); } catch (e) { /* 同上 */ }
  try { fs.rmSync(pickDirStub(), { force: true }); } catch (e) { /* 同上 */ }
}

/* ---------------- 真帧/命中测试三件套（**判据纪律**：可见性只由 elementFromPoint 回答） ----------------
 * 几何（rect）只用来**定位**要点的位置；"看不看得见"一律由浏览器自己回答"这一点上是哪个元素"。
 * 名字里带 `elementFromPoint` 是**有意的**：门禁 V1 按名字声称的可见性去查断言体里有没有真判据。 */
const hitTestElementFromPoint = (sel) => `(function () {
  var e = document.querySelector(` + JSON.stringify(sel) + `);
  if (!e) return { err: ` + JSON.stringify('找不到 ' + sel) + ` };
  var r = e.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { err: '几何为 0（w=' + r.width + ' h=' + r.height + '）' };
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  var at = document.elementFromPoint(cx, cy);
  return { cx: cx, cy: cy, w: r.width, h: r.height, top: r.top,
    self: !!(at && (at === e || e.contains(at))),
    at: at ? { tag: at.tagName, id: at.id || '', cls: String(at.className || '').slice(0, 60) } : null };
})()`;
async function hitSel(ctx, sel) { return await ctx.exec(hitTestElementFromPoint(sel)); }
/** 真鼠标点一个元素：先 elementFromPoint 确认"点得到"，再发真鼠标事件（走 Chromium 命中测试） */
async function clickSel(ctx, sel) {
  const h = await hitSel(ctx, sel);
  if (!h || h.err) return { ok: false, err: (h && h.err) || '命中测试没有结果', hit: h };
  if (!h.self) return { ok: false, err: '命中的不是它（命中 ' + JSON.stringify(h.at) + '）', hit: h };
  if (!ctx.input) return { ok: false, err: '没有真输入底座（ctx.input 缺失）', hit: h };
  await ctx.input.click({ x: Math.round(h.cx), y: Math.round(h.cy) });
  await ctx.input.settle();
  return { ok: true, hit: h };
}
/** 真鼠标点画布上的一个节点（先确认这一点上命中的就是它自己） */
async function clickNodeById(ctx, id) {
  await ctx.exec('(function () { try { if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail(); } catch (e) {} return 1; })()');
  const sel = 'jmnode[nodeid=' + JSON.stringify(id) + ']';
  return await clickSel(ctx, sel);
}
/** 真帧命中：某个节点在画布上到底看得见吗（先关掉浮动详情框 —— 详情框会盖住节点本身） */
async function nodeVisibleByElementFromPoint(ctx, nodeId) {
  await ctx.exec('(function () { try { if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail(); } catch (e) {} return 1; })()');
  await ctx.exec('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); })');
  const sel = 'jmnode[nodeid=' + JSON.stringify(nodeId) + ']';
  return await ctx.exec(`(function () {
    var el = document.querySelector(` + JSON.stringify(sel) + `);
    if (!el) return { err: '画布上没有这个节点元素' };
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { err: '节点几何为 0' };
    var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    var hitNode = (at && at.closest) ? at.closest('jmnode[nodeid]') : null;
    return { hit: hitNode ? hitNode.getAttribute('nodeid') : null, self: hitNode === el,
      at: at ? (at.tagName + '#' + (at.id || '')) : '' };
  })()`);
}
async function waitUntil(fn, ms, stepMs) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 >= ms) return { ok: false, ms: Date.now() - t0 };
    await sleep(stepMs || 250);
  }
}
/** 界面那一侧的全部读数（`MM.importState()` 是**只读**快照，与域 42 的 bindState 同款） */
const impStateJs = '(function () { return JSON.stringify(window.MM.importState ? window.MM.importState() : null); })()';
async function impState(ctx) {
  try { return JSON.parse(await ctx.exec(impStateJs)); } catch (e) { return null; }
}
/** 「界面有没有未保存改动」—— 这条读数用来判"导入完界面是否莫名变脏"（readonly 探针 ✓） */
async function dirtyOf(ctx) {
  return await ctx.exec('(function () { try { return !!(window.MMApp.isDirty && window.MMApp.isDirty()); }'
    + ' catch (e) { return "err:" + ((e && e.message) || e); } })()');
}
/** 自动化用：把「放弃未保存改动吗」这类**同步确认框**打桩 —— 走产品自己的那**一个**打桩口
 *  （`MM.setConfirmStub`；它的缺省实现就是 `window.confirm`）。
 *  ⚠️ 2026-10-14 之前这里覆盖 `window.confirm` **本体**，因为当时那是唯一管用的路：切项目的守卫
 *  （`confirmDiscardIfDirty`）**直接调 `window.confirm`**、`setConfirmStub` 管不到它 ⇒ 无头跑里
 *  "界面脏 + 切项目"把**渲染层的 JS 线程整个卡住**（实测：`executeJavaScript` 永不返回、
 *  整轮冒烟连守卫到期前的输出都没有 ✗✗）。**账① 把那一处接上了同一个打桩口** ⇒ 这里改回
 *  产品那条路（覆盖 `window.confirm` 不再必要），并由 庚 那一条把这三种口径钉住。 */
function stubConfirmJs(counterName) {
  return '(function () { window.' + counterName + ' = 0;'
    + ' if (!window.MMApp || !window.MMApp.setConfirmStub) return "no-stub-api";'
    + ' window.MMApp.setConfirmStub(function (m) { window.' + counterName + ' += 1; return true; });'
    + ' return 1; })()';
}
function restoreConfirmJs() {
  return '(function () { if (window.MMApp && window.MMApp.setConfirmStub) window.MMApp.setConfirmStub(null); return 1; })()';
}
function confirmCallsJs(counterName) {
  return '(function () { return window.' + counterName + ' || 0; })()';
}
function textOf(ctx, sel) {
  return ctx.exec('(function () { var e = document.querySelector(' + JSON.stringify(sel) + ');'
    + ' return e ? String(e.textContent || "") : ""; })()');
}
/** 原生菜单里那两条入口（主进程侧读；导图页在 ⇒ 启用、不在 ⇒ 置灰，由既有机制统一管） */
function menuItemProbe(id) {
  try {
    const electron = require('electron');
    const m = electron.Menu.getApplicationMenu();
    const it = m ? m.getMenuItemById(id) : null;
    if (!it) return { found: false };
    return { found: true, label: it.label, enabled: it.enabled === true, hasClick: typeof it.click === 'function' };
  } catch (e) { return { found: false, error: (e && e.message) || String(e) }; }
}
/** 入口之三/四：**真鼠标**走「命令面板 → 那一行」（与菜单那两条同一个实现：`MM.importIntoMap`） */
async function openPaletteRow(ctx, contains) {
  const open = await clickSel(ctx, '#btn-palette');
  if (!open.ok) return { ok: false, err: '打开命令面板失败：' + open.err };
  const row = await ctx.exec(`(function () {
    var list = document.getElementById('palette-list');
    if (!list) return { err: '没有命令面板列表' };
    list.scrollTop = list.scrollHeight;
    var items = Array.prototype.slice.call(list.querySelectorAll('.palette-item'));
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].textContent || '').indexOf(` + JSON.stringify(contains) + `) >= 0) {
        var r = items[i].getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { err: '那一行几何为 0' };
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var at = document.elementFromPoint(cx, cy);
        return { cx: cx, cy: cy, idx: i, total: items.length,
          self: !!(at && (at === items[i] || items[i].contains(at))),
          at: at ? (at.tagName + '#' + (at.id || '')) : '',
          text: String(items[i].textContent || '').slice(0, 90) };
      }
    }
    return { err: '命令面板里没有这一行：' + ` + JSON.stringify(contains) + `, total: items.length };
  })()`);
  if (!row || row.err) return { ok: false, err: (row && row.err) || '没找到那一行', row: row };
  if (!row.self) return { ok: false, err: '那一行在这一点上看不见（命中 ' + row.at + '）', row: row };
  if (!ctx.input) return { ok: false, err: '没有真输入底座（ctx.input 缺失）', row: row };
  await ctx.input.click({ x: row.cx, y: row.cy });
  await ctx.input.settle();
  return { ok: true, row: row };
}

const assertions = [
  {
    name: '甲 入口与预览：原生菜单两条都在且启用 + 真鼠标走命令面板那一行 ⇒ 预览层出现；三个数（新增/更新/未转换）与逐条点名都来自 CLI 既有 --dry-run 读数，且**此刻用户项目逐字节不变**（判定依据：菜单项探测 + elementFromPoint 点得着 + 项目 JSON SHA-256 前后相同 + 预览文案里点明落点）',
    run: async (ctx) => {
      const mm = require('../smoke-assertions.js');
      await mm.closeDialogs(ctx);
      /* 确认框打桩要在**任何可能弹它的动作之前**装上（原因见上面 `stubConfirmJs` 的注释） */
      await ctx.exec(stubConfirmJs('__mm43Confirm'));
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var st = window.MMApp.getState();'
        + ' return (st && st.project && st.project.name) || ""; })()');
      const dirtyAtStart = await dirtyOf(ctx);
      ctx.runCli(['init', P]);
      ctx.runCli(['add', P, 'root', '--topic', PARENT_TOPIC, '--id', PARENT_ID]);
      seedFiles({ 'a.md': A_MD, 'b.md': B_MD });
      writeStub(pickFilesStub(), [path.join(SRC, 'a.md'), path.join(SRC, 'b.md')]);

      await ctx.exec('window.MMApp.openProject(' + JSON.stringify(P) + ')');
      await sleep(400);
      await ctx.exec('(function () { if (window.MMApp.resetView) window.MMApp.resetView(); return 1; })()');

      // 落点 = 图上点中的那个节点（真鼠标点它）⇒ 落点在选择器/预览里都得说清
      const parentClick = await clickNodeById(ctx, PARENT_ID);
      const selected = await ctx.exec('(function () { var n = window.MM.adapter.getSelected(window.MMApp.getState().jm);'
        + ' return n ? n.id : ""; })()');

      const rawBefore = readRaw(P);
      const shaBefore = sha256(rawBefore);
      const idsBefore = allNodes(P).map((n) => n.id).sort().join(' ');
      const parentBefore = nodeBodyRaw(P, PARENT_ID);
      const menuFiles = menuItemProbe('map-menu-import-files');
      const menuDir = menuItemProbe('map-menu-import-dir');

      const entry = await openPaletteRow(ctx, '导入 Markdown 文件');
      const shown = await waitUntil(async () => {
        const s = await impState(ctx);
        return !!(s && s.previewShown && s.previewData && s.previewData.preview);
      }, 20000);
      const st = await impState(ctx);
      const planText = await textOf(ctx, '#import-preview-plan');
      const whatText = await textOf(ctx, '#import-what');
      const okHit = await hitSel(ctx, '#import-preview-ok');
      // 判据②：预览跑在**演练副本**上 ⇒ 这段期间用户项目逐字节不变、盘上一个节点都不多
      const zeroWrite = sha256(readRaw(P)) === shaBefore
        && allNodes(P).map((n) => n.id).sort().join(' ') === idsBefore;
      const pv = (st && st.previewData && st.previewData.preview) || null;
      const data = (st && st.previewData) || null;

      return {
        ok: menuFiles.found === true && menuFiles.enabled === true && menuFiles.hasClick === true
          && menuDir.found === true && menuDir.enabled === true
          && entry.ok === true
          && shown.ok === true && !!(st && st.previewShown)
          && parentClick.ok === true && selected === PARENT_ID
          && !!pv && pv.added > 0 && pv.updated === 0 && pv.unconverted === 0
          && /将新增/.test(planText) && /更新/.test(planText) && /未转换/.test(planText)
          /* 落点必须**在界面上说清**（不只是数据里对）：预览文案里点出父节点标题 */
          && whatText.indexOf(PARENT_TOPIC) >= 0 && /个文件/.test(whatText)
          && okHit && okHit.self === true
          && zeroWrite === true
          && !!(data && data.copy && data.copy.projects > 0),
        text: '菜单：files=' + JSON.stringify(menuFiles) + ' dir=' + JSON.stringify(menuDir)
          + ' · 命令面板那一行=' + JSON.stringify(entry.row ? { idx: entry.row.idx, total: entry.row.total, text: entry.row.text } : entry.err)
          + ' · 预览出现=' + shown.ok + '（' + shown.ms + 'ms）'
          + ' · 落点：选中=' + selected + ' 点中=' + parentClick.ok
          + ' · 预览读数=' + JSON.stringify(pv)
          + ' · 演练副本=' + JSON.stringify(data && data.copy)
          + ' · 预览文案=「' + String(planText).slice(0, 200) + '」'
          + ' · 落点那行=「' + String(whatText).slice(0, 120) + '」'
          + ' · 确认按钮可点=' + !!(okHit && okHit.self)
          + ' · 判据②：项目 JSON 逐字节不变=' + zeroWrite + '（SHA ' + shaBefore.slice(0, 12) + '）'
          + ' · 父节点未变（预览期间）=' + (nodeBodyRaw(P, PARENT_ID) === parentBefore)
      };
    }
  },

  {
    name: '乙 真导入（真鼠标确认）：预览说的新增 N = 主进程现算的新增节点数 = 从两份项目 JSON 现算的差集（**对拍**，逐节点现算不写死）+ 落点父节点除 children 外逐字节未变 + 新子树一律折叠（判定依据：项目 JSON 原文 + SHA-256 + 盘上节点集合现算）',
    run: async (ctx) => {
      const rawBefore = readRaw(P);
      const idsBefore = allNodes(P).map((n) => n.id).sort();
      const parentBefore = nodeBodyRaw(P, PARENT_ID);
      const stPreview = await impState(ctx);
      const previewAdded = (stPreview && stPreview.previewData && stPreview.previewData.preview
        && stPreview.previewData.preview.added) || null;

      const confirm = await clickSel(ctx, '#import-preview-ok');
      const grew = await waitUntil(() => !hasProject(P) || allNodes(P).length > idsBefore.length, 25000);
      await sleep(400);
      const stAfter = await impState(ctx);
      const last = (stAfter && stAfter.last) || null;
      const idsAfter = allNodes(P).map((n) => n.id).sort();
      const added = addedIdsBetween(rawBefore, readRaw(P));
      const fromMain = ((last && last.addedKeys) || []).filter((k) => k.indexOf('node:') === 0).length;
      const newNodes = added.map((id) => nodeById(P, id)).filter(Boolean);
      const allCollapsed = newNodes.length > 0 && newNodes.every((n) => n.expanded === false);
      const parentAfter = nodeBodyRaw(P, PARENT_ID);
      const kept = nodeById(P, PARENT_ID) !== null;
      const previewClosed = !(stAfter && stAfter.previewShown);
      const bannerOn = !!(stAfter && stAfter.bannerShown);
      const dirtyAfter = await dirtyOf(ctx);

      return {
        ok: confirm.ok === true
          && grew.ok === true
          && added.length > 0
          && previewAdded === added.length          /* 判据①：预览数与真导入现算数**对拍** */
          && fromMain === added.length              /* 两个来源（CLI 读数 / 主进程差异）都指同一个数 */
          && allCollapsed === true                  /* 判据③：新子树默认折叠（键显式存在且为 false） */
          && parentAfter === parentBefore           /* 判据③：父节点除 children 外逐字节未变 */
          && kept === true                          /* 落点那个节点没被导入顺手删掉/改名 */
          && previewClosed === true && bannerOn === true,
        text: '真鼠标确认=' + confirm.ok + ' · 节点数 ' + idsBefore.length + '→' + idsAfter.length
          + '（等 ' + grew.ms + 'ms）· 现算新增=' + added.length + ' 个：' + added.slice(0, 6).join(' ')
          + ' · 预览说的新增=' + previewAdded + ' · 主进程读数（node: 键）=' + fromMain
          + ' · 新节点全部折叠=' + allCollapsed + '（' + newNodes.map((n) => n.expanded).join(',') + '）'
          + ' · 父节点除 children 外逐字节未变=' + (parentAfter === parentBefore)
          + ' · 预览层已收起=' + previewClosed + ' · 播报 banner 已亮=' + bannerOn
          + ' · 导入后界面脏=' + dirtyAfter + '（**走到既有重读路径** ⇒ 应当不脏：脏了就意味着"用户没编辑却要应付放弃改动的确认框"）'
      };
    }
  },

  {
    name: '丙 坏文件混在里面：一个**目录**冒充 .md ⇒ 好的两个照进、坏的**逐条点名**（部分成功：一个坏文件不拖垮整批）；批次结束仍然过 validate（判定依据：CLI 报告逐条原文 + 盘上节点现算 + validate 退出码）',
    run: async (ctx) => {
      seedFiles({ 'bad.md': null, 'c.md': C_MD, 'd.md': D_MD });     // 注意：bad.md 是**目录**
      writeStub(pickFilesStub(), [
        path.join(SRC, 'c.md'), path.join(SRC, BAD_REL), path.join(SRC, 'd.md')   // 坏的在中间 ⇒ 后面那个也必须照进
      ]);
      const rawBefore = readRaw(P);
      const idsBefore = allNodes(P).map((n) => n.id).sort();

      const entry = await openPaletteRow(ctx, '导入 Markdown 文件');
      const shown = await waitUntil(async () => {
        const s = await impState(ctx);
        return !!(s && s.previewShown && s.previewData && s.previewData.preview);
      }, 20000);
      const stPrev = await impState(ctx);
      const pv = (stPrev && stPrev.previewData && stPrev.previewData.preview) || null;
      const planText = await textOf(ctx, '#import-preview-plan');
      const confirm = await clickSel(ctx, '#import-preview-ok');
      const done = await waitUntil(async () => {
        const s = await impState(ctx);
        return !!(s && s.last && s.last.preview && s.last.preview.unconverted === 1);
      }, 25000);
      await sleep(300);
      const st = await impState(ctx);
      const last = (st && st.last) || null;
      const added = addedIdsBetween(rawBefore, readRaw(P));
      const bad = ((last && last.preview && last.preview.unconvertedList) || [])[0] || null;
      const good = added.map((id) => nodeById(P, id)).filter(Boolean).map((n) => n.topic);
      const v = cliCode(ctx, ['validate', P]);
      const dirtyAfter = await dirtyOf(ctx);

      return {
        ok: entry.ok === true && shown.ok === true && confirm.ok === true && done.ok === true
          /* 预览就把坏的那个点出来了（不是等真导才知道） */
          && !!pv && pv.unconverted === 1
          && /bad\.md/.test(planText)
          /* 部分成功：好的两个进了，坏的那个没拖垮它们 */
          && added.length > 0
          && good.length === added.length
          && last.succeeded === 2 && last.failed === 1
          && !!(bad && /bad\.md/.test(bad.name || '') && /目录/.test(bad.reason || ''))
          && v.code === 0,
        text: '入口=' + entry.ok + ' 预览=' + (shown.ok ? (shown.ms + 'ms') : 'FAIL') + ' 确认=' + confirm.ok
          + ' · 预览读数=' + JSON.stringify(pv)
          + ' · 预览里点名=「' + (String(planText).match(/·[^\n]{0,160}/) || ['（没有逐条点名）'])[0] + '」'
          + ' · 真导入：成功 ' + (last && last.succeeded) + ' / 失败 ' + (last && last.failed)
          + ' · 现算新增 ' + added.length + ' 个节点：' + good.slice(0, 6).join(' / ')
          + ' · 坏的那条逐条点名=' + JSON.stringify(bad)
          + ' · validate 退出码=' + v.code + ' · 导入后界面脏=' + dirtyAfter
      };
    }
  },

  {
    name: '丁 变更播报：banner 亮（elementFromPoint 命中它自己）⇒ 真鼠标点「看这次加了哪些」⇒ 只读面板逐条列出这次新增的节点（含"没导进来"那一条）⇒ 真鼠标点一行 ⇒ 真的跳到那个节点（判定依据：面板行的 data-key = 主进程现算的键 + 跳转后选中且画布上命中它自己）',
    run: async (ctx) => {
      const st0 = await impState(ctx);
      const last = (st0 && st0.last) || null;
      const addedIds = ((last && last.addedKeys) || [])
        .filter((k) => k.indexOf('node:') === 0).map((k) => k.slice('node:'.length)).sort();
      const badCount = (last && last.preview && last.preview.unconverted) || 0;
      const target = addedIds[0] || '';
      const wantKey = target ? ('node:' + target) : '';

      await ctx.exec('(function () { if (window.MMApp.resetView) window.MMApp.resetView(); return 1; })()');
      const bannerHit = await hitSel(ctx, '#import-banner-open');
      const openPanel = await clickSel(ctx, '#import-banner-open');
      const panelOn = await waitUntil(async () => {
        const d = await ctx.exec('(function () { var p = document.getElementById("conc-panel");'
          + ' return !!p && getComputedStyle(p).display !== "none"; })()');
        return d === true;
      }, 10000);
      const panel = await ctx.exec(`(function () {
        var p = document.getElementById('conc-panel');
        if (!p || p.style.display === 'none') return null;
        var groups = Array.prototype.slice.call(p.querySelectorAll('.conc-group')).map(function (g) {
          var h = g.querySelector('h3');
          return { title: (h && h.textContent) || '',
            rows: Array.prototype.slice.call(g.querySelectorAll('.conc-row')).map(function (r) {
              var head = r.querySelector('.conc-row-head');
              return { key: r.getAttribute('data-key'), label: (head && head.textContent) || '',
                clickable: r.classList.contains('clickable') };
            }) };
        });
        return { title: (document.getElementById('conc-title') || {}).textContent || '', groups: groups };
      })()`);
      const addedGroup = ((panel && panel.groups) || []).filter((g) => /新出现/.test(g.title))[0] || null;
      const allRows = [];
      ((panel && panel.groups) || []).forEach((g) => { (g.rows || []).forEach((r) => allRows.push(r)); });
      const nodeRows = allRows.filter((r) => String(r.key || '').indexOf('node:') === 0)
        .map((r) => String(r.key).slice('node:'.length)).sort();
      const wantRow = ((addedGroup && addedGroup.rows) || []).filter((r) => r.key === wantKey)[0] || null;
      const rowSel = '.conc-row[data-key=' + JSON.stringify(wantKey) + ']';
      const rowClick = target ? await clickSel(ctx, rowSel) : { ok: false, err: '没有新增节点可点' };
      const selected = await ctx.exec('(function () { var jm = window.MMApp.getState().jm;'
        + ' var s = jm && jm.get_selected_node ? jm.get_selected_node() : null; return s ? s.id : null; })()');
      await ctx.exec('(function () { try { if (window.MMApp.closeConcPanel) window.MMApp.closeConcPanel(); } catch (e) {} return 1; })()');
      /* 判"看得见"之前做两件**正当**的准备（都不是豁免判据）：
       *   · 收掉**这一批自己的**播报条 + 用产品自己的「还原视图」把视图摆回初始位置（跳转语义里不含平移）；
       *   · 目标若落在画布视口外（这一批的落点在第二层，冒烟窗口的画布只有 ~730px 宽）⇒ **用真滚轮缩小**
       *     把它带进视野 —— 那是用户真会做的动作，也让"命中测试"这条判据真的成立（而不是被跳过 ✗）。 */
      await ctx.exec('(function () { try { MM.importCloseBanner(); } catch (e) {}'
        + ' try { if (window.MMApp.resetView) window.MMApp.resetView(); } catch (e) {} return 1; })()');
      await sleep(400);
      const geoOf = async () => (target ? await ctx.exec('(function () {'
        + ' var el = document.querySelector(' + JSON.stringify('jmnode[nodeid=' + JSON.stringify(target) + ']') + ');'
        + ' var c = document.getElementById("main").getBoundingClientRect();'
        + ' if (!el) return null;'
        + ' var r = el.getBoundingClientRect();'
        + ' return { node: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },'
        + '   canvas: { l: Math.round(c.left), t: Math.round(c.top), w: Math.round(c.width), h: Math.round(c.height) },'
        + '   inView: r.left >= c.left && r.top >= c.top && r.right <= c.right && r.bottom <= c.bottom }; })()') : null);
      let geo = await geoOf();
      const geoBeforeZoom = geo;
      let wheelTicks = 0;
      if (target && ctx.input) {
        const rawC = await ctx.exec('(function () { var c = document.getElementById("main").getBoundingClientRect();'
          + ' return JSON.stringify({ x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) }); })()');
        const cc = (function () { try { return JSON.parse(rawC); } catch (e) { return { x: 200, y: 300 }; } })();
        while (geo && geo.inView !== true && wheelTicks < 8) {
          await ctx.input.wheel({ x: cc.x, y: cc.y }, -120, 0);
          wheelTicks += 1;
          await sleep(260);
          geo = await geoOf();
        }
      }
      const vis = target ? await nodeVisibleByElementFromPoint(ctx, target) : { err: '没有新增节点' };
      const bannerText = (st0 && st0.bannerText) || '';

      return {
        ok: bannerHit && bannerHit.self === true
          && openPanel.ok === true && panelOn.ok === true
          && !!addedGroup && addedGroup.rows.length > 0
          && nodeRows.length === addedIds.length
          && nodeRows.join(' ') === addedIds.join(' ')        /* 面板里的行 = 主进程现算的那些键 */
          && allRows.length === addedIds.length + badCount    /* 外加"没导进来"的那一条 */
          && !!wantRow && wantRow.clickable === true
          && rowClick.ok === true && target !== '' && selected === target
          && !!vis && vis.self === true && vis.hit === target
          && /导入完成/.test(bannerText),
        text: 'banner 按钮命中它自己=' + !!(bannerHit && bannerHit.self) + '（几何 ' + (bannerHit && bannerHit.w) + 'x'
          + (bannerHit && bannerHit.h) + '，命中 ' + JSON.stringify(bannerHit && bannerHit.at) + '）'
          + ' · 点开面板=' + openPanel.ok + '/' + panelOn.ok + ' 标题「' + (panel && panel.title) + '」'
          + ' · 面板里的节点行=' + nodeRows.length + ' 个（主进程现算 ' + addedIds.length + ' 个）：'
          + nodeRows.slice(0, 6).join(' ')
          + ' · 面板行合计=' + allRows.length + '（+ 没导进来 ' + badCount + ' 条）'
          + ' · 目标行=' + JSON.stringify(wantRow) + ' ⇒ 真鼠标点它：命中它自己=' + rowClick.ok
          + ' · 跳转后选中=' + selected + '（应为 ' + target + '）'
          + ' · 跳过去之后画布上命中=' + (vis && vis.hit) + '（是它自己=' + (vis && vis.self) + '，命中元素 '
          + JSON.stringify(vis && vis.at) + '）'
          + ' · 几何：复位后=' + JSON.stringify(geoBeforeZoom) + ' ⇒ 真滚轮缩小 ' + wheelTicks
          + ' 格后=' + JSON.stringify(geo)
          + ' · banner 文案=「' + String(bannerText).slice(0, 160) + '」'
      };
    }
  },

  {
    name: '戊 选目录 ⇒ 整库导入新建一个项目：预览期间盘上零写入（那个项目还没出现、项目数不变）⇒ 确认后新项目里除根外**每个节点都折叠**、根那一档没被改，且预览说的新增数 = 现算数（判定依据：项目 JSON 原文 + 目录列举现算 + elementFromPoint 点得着）',
    run: async (ctx) => {
      seedLib();
      writeStub(pickDirStub(), [LIB]);
      const namesBefore = projectNames();
      const existedBefore = hasProject(P_DIR);

      /* ⓪ **先钉"界面脏就不导"这条闸门**（这一批声明"走既有保存闸门"的可判据形式）：
       *  上一条（丁）跳到一个新节点时会 `expandAncestors` —— 展开是**写进数据**的视图状态
       *  ⇒ 界面此刻被判成"有未保存改动"（这是工程既有口径，不是本批引入）。
       *  ① 此刻发起导入 ⇒ 必须**拒绝**（一个字节都不写、连选择器都不弹）；
       *  ② 然后走**产品自己的路径**把基线归零（重开当前项目）⇒ 再导。
       *  ⚠️ 这一步同时是一条**真实闸门**的判据：脏的时候导入不许动盘（否则用户随后一保存就撞冲突）。 */
      const dirtyBefore = await dirtyOf(ctx);
      const rawBefore0 = readRaw(P);
      const refused = await ctx.exec('(async function () {'
        + ' var r = await window.MM.importIntoMap({ kind: "dir" });'
        + ' var s = document.getElementById("status-text");'
        + ' return JSON.stringify({ ok: !!(r && r.ok), error: (r && r.error) || "",'
        + '   status: s ? String(s.textContent || "") : "" }); })()');
      const refusedObj = (function () { try { return JSON.parse(refused); } catch (e) { return { ok: null, error: '', status: '' }; } })();
      const zeroWriteOnRefuse = readRaw(P) === rawBefore0 && !hasProject(P_DIR)
        && projectNames().join(' ') === namesBefore.join(' ');
      /* ② 基线归零：按产品自己的路径重开当前项目（同名 ⇒ 不走"切换项目"那道确认；读盘 ⇒ 与盘上一版对齐） */
      const aligned = await ctx.exec('(async function () { var st = window.MMApp.getState();'
        + ' if (!st || !st.project) return "noproj";'
        + ' var r = await window.MMApp.openProject(st.project.name); return "ok:" + !!r; })()');
      await sleep(400);
      const dirtyAfterAlign = await dirtyOf(ctx);

      const entry = await openPaletteRow(ctx, '导入文件夹成新项目');
      /* ⚠️ 等的是**这一路**的预览（`kind==='dir'`）：只等 `preview` 非空会被**上一批（文件那一路）**
       * 留在状态里的旧读数当场满足 ⇒ 变成一条"什么都没跑却绿"的空转判据（第一版就是这样，实测抓到 ✗）。 */
      const shown = await waitUntil(async () => {
        const s = await impState(ctx);
        return !!(s && s.previewShown && s.previewData && s.previewData.kind === 'dir'
          && s.previewData.preview && s.previewData.preview.kind === 'dir');
      }, 30000);
      const stPrev = await impState(ctx);
      const pv = (stPrev && stPrev.previewData && stPrev.previewData.preview) || null;
      const name = (stPrev && stPrev.previewData && stPrev.previewData.name) || '';
      const planText = await textOf(ctx, '#import-preview-plan');
      /* 判据②（目录那一半）：预览期间**盘上零写入** —— 那个项目一个字节都没出现 */
      const zeroWrite = hasProject(P_DIR) === existedBefore
        && projectNames().join(' ') === namesBefore.join(' ');
      const confirm = await clickSel(ctx, '#import-preview-ok');
      const created = await waitUntil(() => hasProject(name || P_DIR), 40000);
      await sleep(400);
      const proj = name || P_DIR;
      const tree = hasProject(proj) ? readProject(proj) : null;
      const nodes = hasProject(proj) ? allNodes(proj) : [];
      const nonRoot = nodes.filter((n) => n.id !== (tree && tree.data && tree.data.id));
      const allCollapsed = nonRoot.length > 0 && nonRoot.every((n) => n.expanded === false);
      const rootRow = (tree && tree.data) || {};
      const containers = nonRoot.filter((n) => (n.children || []).length > 0).length;
      const st = await impState(ctx);
      const v = hasProject(proj) ? cliCode(ctx, ['validate', proj]) : { code: -1 };
      const dirtyAfter = await dirtyOf(ctx);

      return {
        ok: entry.ok === true && shown.ok === true
          /* ⓪ 闸门那一半：脏时拒绝 + 盘上零改动 + 状态栏说原话；归零之后才允许导 */
          && dirtyBefore === true && refusedObj.ok === false
          && /未保存改动/.test(String(refusedObj.error)) && /未保存改动/.test(String(refusedObj.status))
          && zeroWriteOnRefuse === true && dirtyAfterAlign === false
          && !!pv && pv.kind === 'dir' && pv.added > 0
          && /将新增/.test(planText)
          && zeroWrite === true
          && confirm.ok === true && created.ok === true
          /* 判据③（目录那一半）：除根外全折叠；根那一档 = 新建项目的同一档（没被这次导入改过） */
          && allCollapsed === true
          && rootRow.expanded === true
          && nonRoot.length === pv.added                     /* 对拍：预览说的新增 = 盘上实际多出来的节点数 */
          && containers > 0                                  /* 子目录成了容器节点（整库镜像是真的） */
          && v.code === 0,
        text: '入口=' + entry.ok + ' 预览=' + (shown.ok ? (shown.ms + 'ms') : 'FAIL')
          + ' · ⓪ 闸门：发起前脏=' + dirtyBefore + ' ⇒ 拒绝=' + JSON.stringify(refusedObj)
          + '，盘上零改动=' + zeroWriteOnRefuse
          + ' · 归零（重开当前项目）=' + aligned + ' ⇒ 脏=' + dirtyAfterAlign
          + ' · 预览读数=' + JSON.stringify(pv) + ' · 会新建的项目名=' + name
          + ' · 判据②：预览期间项目数 ' + namesBefore.length + '→' + projectNames().length
          + '、目标项目已存在=' + existedBefore + '⇒盘上零写入=' + zeroWrite
          + ' · 确认=' + confirm.ok + ' 新项目出现=' + created.ok + '（' + created.ms + 'ms）'
          + ' · 新项目节点数=' + nodes.length + '（非根 ' + nonRoot.length + '，其中容器 ' + containers + ' 个）'
          + ' · 非根全部折叠=' + allCollapsed + ' · 根 expanded=' + rootRow.expanded
          + ' · 对拍：预览 ' + (pv && pv.added) + ' = 现算 ' + nonRoot.length
          + ' · validate 退出码=' + v.code + ' · 导入后界面脏=' + dirtyAfter
      };
    }
  },

  /* 【账①】切项目守卫接上**同一个打桩口** —— 这条断言的三步就是那条账的三个判据。
   * 为什么必须在这里也有一条：无头跑里"界面脏 + 切项目"曾经把**渲染层的 JS 线程整个卡住**
   * （那条守卫直接调 `window.confirm` 本体，而 `setConfirmStub` 只换掉了另一个调用点）⇒
   * 实测只能强杀，整轮冒烟连守卫到期前的输出都拿不到。现在三步都必须**取得到读数**。 */
  {
    name: '庚 切项目守卫走**同一个打桩口**（`MM.setConfirmStub`）：桩说"取消" ⇒ 守卫按取消处理（留在原项目、改动还在）；桩说"确定" ⇒ 按确定处理（真的切过去）；桩复位 ⇒ 守卫仍落到 `window.confirm` 本体（真机路径未变）。三步都要取得到读数（无头下渲染层不再卡死）（判定依据：真 openProject 往返 + 三条读数 + 事后仍有响应；带 12 秒上限，超时按红计）',
    run: async (ctx) => {
      const mm = require('../smoke-assertions.js');
      const cleaned = await mm.closeDialogs(ctx);
      ctx.runCli(['init', P_OTHER]);
      /* 先把界面放回本域的沙箱项目 P（前一条断言可能停在"整库导入新建的那个项目"上）：
       * 用产品路径切回去，此刻的桩是域 43 平时的那个（返回 true ⇒ 不会弹模态）。 */
      await ctx.exec('(function () { return window.MMApp.openProject(' + JSON.stringify(P) + '); })()');
      await sleep(300);

      /* ⚠️ **带上限**：这三步在"打桩口没接上"时会卡住渲染层（超时唯一能说话的人）⇒
       *   超时**按红计**（`timeout: true` 进 ok 判定），而不是把整条链挂死等冒烟守卫来杀。 */
      const t0 = Date.now();
      const raced = await Promise.race([
        ctx.exec(`(async function () {
          var app = window.MMApp;
          var other = ${JSON.stringify(P_OTHER)};
          var cur = function () { var st = app.getState(); return (st && st.project && st.project.name) || ''; };
          var has = function (id) { var st = app.getState(); return !!(st && st.jm && st.jm.mind && st.jm.mind.nodes[id]); };
          var out = { start: cur() };
          // 造脏（与域 09 同源：内存里加一个节点 —— 不开模态、可原样撤回）
          var jm = app.getState().jm;
          if (!has('geng-probe-1')) jm.add_node('root', 'geng-probe-1', '脏项目探针', { detail: '' });
          out.dirtyBefore = !!app.isDirty();

          // ① 桩说「取消」⇒ 守卫按取消处理（留在原项目、改动还在）+ 渲染层仍有响应
          var calls = 0, msg = '';
          app.setConfirmStub(function (m) { calls += 1; msg = String(m); return false; });
          var okCancel = await app.openProject(other);
          out.cancel = { ok: okCancel, calls: calls, msg: msg, cur: cur(),
            dirty: !!app.isDirty(), probeAlive: has('geng-probe-1'), alive: (1 + 1) === 2, ms: 0 };

          // ② 桩说「确定」⇒ 按确定处理（真的切过去；改动按"人确认放弃"的语义丢掉）
          calls = 0;
          app.setConfirmStub(function (m) { calls += 1; msg = String(m); return true; });
          var okGo = await app.openProject(other);
          out.go = { ok: okGo, calls: calls, cur: cur(), dirty: !!app.isDirty(), alive: (1 + 1) === 2 };

          // ③ 桩**复位** ⇒ 守卫仍然落到 window.confirm 本体（真机路径未变；这里用**替身**接住，
          //    免得无头下真弹模态 —— 替身被调到，就是"确实走了原生那一条"的证据）
          app.setConfirmStub(null);
          var jm2 = app.getState().jm;
          if (!has('geng-probe-2')) jm2.add_node('root', 'geng-probe-2', '脏项目探针2', { detail: '' });
          out.dirtyForReal = !!app.isDirty();
          var realCalls = 0, realMsg = '';
          var origConfirm = window.confirm;
          window.confirm = function (m) { realCalls += 1; realMsg = String(m); return false; };
          var okBack = null;
          try { okBack = await app.openProject(${JSON.stringify(P)}); }
          finally { window.confirm = origConfirm; }
          out.real = { ok: okBack, calls: realCalls, msg: realMsg, cur: cur(),
            dirty: !!app.isDirty(), alive: (1 + 1) === 2 };

          // 收尾：把当前这个沙箱项目恢复干净（撤掉探针 + 保存）⇒ 己 那一条交还项目时不会再碰守卫
          var jm3 = app.getState().jm;
          if (has('geng-probe-2')) jm3.remove_node('geng-probe-2');
          out.savedClean = await app.save();
          out.dirtyEnd = !!app.isDirty();
          out.curEnd = cur();
          return out;
        })()`),
        new Promise((res) => setTimeout(() => res({ timeout: true }), 12000))
      ]);
      const ms = Date.now() - t0;
      await ctx.exec(stubConfirmJs('__mm43Confirm'));      // 交还给己：域 43 平时的那个桩（返回 true）
      const R = raced && raced.timeout ? {} : (raced || {});
      const C = R.cancel || {}, G = R.go || {}, RE = R.real || {};
      return {
        ok: !raced.timeout
          && R.dirtyBefore === true
          && C.ok === false && C.calls === 1 && C.cur === P && C.dirty === true
          && C.probeAlive === true && C.alive === true
          && /切换项目/.test(String(C.msg)) && /未保存/.test(String(C.msg))
          && G.ok === true && G.calls === 1 && G.cur === P_OTHER && G.alive === true
          && R.dirtyForReal === true
          && RE.ok === false && RE.calls === 1 && RE.cur === P_OTHER && RE.alive === true
          && /切换项目/.test(String(RE.msg)) && /未保存/.test(String(RE.msg))
          && R.savedClean === true && R.dirtyEnd === false
          && ms < 12000,
        text: '起点=' + R.start + ' 造脏=' + R.dirtyBefore
          + ' ｜ ① 桩=取消：openProject 返回=' + C.ok + ' 桩被调=' + C.calls + ' 次'
          + ' 现在开着=「' + C.cur + '」（应留在 ' + P + '）仍脏=' + C.dirty + ' 探针节点还在=' + C.probeAlive
          + ' 事后读数可取=' + C.alive
          + ' ｜ 桩收到的原话「' + String(C.msg).slice(0, 60) + '…」'
          + ' ｜ ② 桩=确定：openProject 返回=' + G.ok + ' 桩被调=' + G.calls + ' 次 现在开着=「' + G.cur + '」'
          + ' ｜ ③ 桩复位：window.confirm 替身被调=' + RE.calls + ' 次、openProject 返回=' + RE.ok
          + ' 仍留在=「' + RE.cur + '」 事后读数可取=' + RE.alive
          + ' ｜ 收尾：撤探针并保存=' + R.savedClean + ' 脏=' + R.dirtyEnd + ' 现在开着=「' + R.curEnd + '」'
          + ' ｜ 三步总耗时=' + ms + 'ms' + (raced.timeout ? '（**超时 ⇒ 按红计**：渲染层没有回来）' : '')
          + ' ｜ 收干净的产品模态=' + cleaned.n + ' 个'
      };
    }
  },

  {
    name: '己 默认档：两处新浮层 + 既有三处绑定浮层全是 display:none 且命中测试落不到、**工具栏里一个 import 元素都没有**、#main 顶边 = 工具栏底边（没在导入时这一批不许让界面多出一个像素；判定依据：elementFromPoint + 计算样式 + 工具栏子元素现算）',
    run: async (ctx) => {
      const mm = require('../smoke-assertions.js');
      const cleaned = await mm.closeDialogs(ctx);
      await sleep(300);
      const layout = await ctx.exec(`(function () {
        var tb = document.getElementById('toolbar').getBoundingClientRect();
        var main = document.getElementById('main').getBoundingClientRect();
        var ids = ['import-preview', 'import-banner', 'bind-bar', 'bind-banner', 'bind-preview', 'conc-banner', 'conc-panel'];
        var out = {};
        ids.forEach(function (id) {
          var e = document.getElementById(id);
          if (!e) { out[id] = { present: false }; return; }
          var r = e.getBoundingClientRect();
          out[id] = { present: true, display: getComputedStyle(e).display, w: r.width, h: r.height };
        });
        var tbEl = document.getElementById('toolbar');
        var at = document.elementFromPoint(Math.round(tb.left + 40), Math.round(main.top + 6));
        var hitImport = !!(at && at.closest && at.closest('#import-preview,#import-banner,#import-bar'));
        return JSON.stringify({
          toolbarBottom: tb.bottom, mainTop: main.top, mainHeight: main.height,
          toolbarChildren: tbEl.children.length,
          importInToolbar: tbEl.querySelectorAll('[id^=import]').length,
          toolbarImportText: Array.prototype.slice.call(tbEl.querySelectorAll('button,select,input'))
            .filter(function (b) { return String(b.textContent || b.id || '').indexOf('导入') >= 0; }).length,
          fl: out,
          hitTag: at ? (at.tagName + '#' + (at.id || '')) : '', hitImport: hitImport
        });
      })()`);
      const L = JSON.parse(layout);
      const st = await impState(ctx);
      const pal = await ctx.exec(`(function () {
        var p = document.getElementById('palette');
        if (!p || getComputedStyle(p).display === 'none') return JSON.stringify({ open: false });
        var rows = Array.prototype.slice.call(document.querySelectorAll('#palette-list .palette-item'));
        return JSON.stringify({ open: true, rows: rows.length,
          imp: rows.filter(function (r) { return String(r.textContent || '').indexOf('导入') >= 0; }).length });
      })()`);
      /* 交还给进来时的样子（本域是最后一个域：不留一个"当前项目"是我造出来的状态） */
      cleanupSandbox();
      /* 交还给进来时的样子（本域是最后一个域：不留一个"当前项目"是我造出来的状态）。
       * ⚠️ 两条**实测踩到才加的**护栏（都在这一步上）：
       *   ① **确认框必须打桩**：`MM.openProject` 在"当前项目有未保存改动"时会走 `confirmFn`
       *      （默认就是 `window.confirm`）—— 而 headless 里**没人回答模态** ⇒ **渲染层整个卡住**
       *      （实测：`executeJavaScript` 永不返回，整轮冒烟连守卫到期前的输出都没有 ✗）。
       *      这正是 `MM.setConfirmStub` 存在的理由（域 23 的先例），本域照办，并把"被问过几次"记下来。
       *   ② **promise 必须带上限**：`Promise.race` + 超时 ⇒ 交还只是收尾，不许它有能力挂住整条链。 */
      const pre = await ctx.exec('(function () { var st = window.MMApp.getState(); return JSON.stringify({'
        + ' cur: (st && st.project && st.project.name) || "",'
        + ' dirty: (window.MMApp.isDirty ? !!window.MMApp.isDirty() : null) }); })()');
      const preObj = (function () { try { return JSON.parse(pre); } catch (e) { return { cur: '', dirty: null }; } })();
      let handback = { ok: false, reason: '没有要交还的项目（进来时就没开项目）' };
      if (PROJECT_WHEN_ENTERED) {
        const raw = await ctx.exec('(async function () {'
          + ' var r = await Promise.race(['
          + '  Promise.resolve(window.MMApp.openProject(' + JSON.stringify(PROJECT_WHEN_ENTERED) + '))'
          + '    .then(function () { return "resolved"; }, function (e) { return "rejected:" + ((e && e.message) || e); }),'
          + '  new Promise(function (res) { setTimeout(function () { res("timeout"); }, 5000); })'
          + ' ]); return r; })()');
        handback = { ok: raw === 'resolved', reason: String(raw) };
        await sleep(300);
      }
      const curProj = await ctx.exec('(function () { var st = window.MMApp.getState();'
        + ' return (st && st.project && st.project.name) || ""; })()');
      const confirms = await ctx.exec(confirmCallsJs('__mm43Confirm'));
      await ctx.exec(restoreConfirmJs());
      return {
        ok: L.importInToolbar === 0 && L.toolbarImportText === 0
          && L.fl['import-preview'] && L.fl['import-preview'].display === 'none' && L.fl['import-preview'].w === 0 && L.fl['import-preview'].h === 0
          && L.fl['import-banner'] && L.fl['import-banner'].display === 'none'
          && L.fl['bind-bar'] && L.fl['bind-bar'].display === 'none'
          && L.fl['bind-banner'] && L.fl['bind-banner'].display === 'none'
          && L.fl['bind-preview'] && L.fl['bind-preview'].display === 'none'
          && L.hitImport === false
          && Math.abs(L.mainTop - L.toolbarBottom) < 1
          && !!(st && st.previewShown === false && st.bannerShown === false && st.toolbarImportEls === 0),
        text: '工具栏子元素=' + L.toolbarChildren + ' 其中 import 元素=' + L.importInToolbar
          + '、含"导入"字样的控件=' + L.toolbarImportText
          + ' · 浮层：' + JSON.stringify(L.fl)
          + ' · 画布上缘那一点命中=' + L.hitTag + '（落进 import 浮层=' + L.hitImport + '）'
          + ' · #main 顶边 ' + L.mainTop + ' vs 工具栏底边 ' + L.toolbarBottom
          + ' · 界面读数：' + JSON.stringify({ previewShown: st && st.previewShown, bannerShown: st && st.bannerShown, toolbarImportEls: st && st.toolbarImportEls })
          + ' · 收干净的产品模态=' + cleaned.n + ' 个' + (cleaned.names.length ? '（' + cleaned.names.join(',') + '）' : '')
          + ' · 命令面板=' + pal
          + ' · 交还给进来时的项目（带上限、确认框已打桩）=' + JSON.stringify(handback)
          + '，现在开着=「' + curProj + '」，交还前脏=' + preObj.dirty + '，确认框问了 ' + confirms + ' 次'
      };
    }
  }
];

module.exports = assertions;
