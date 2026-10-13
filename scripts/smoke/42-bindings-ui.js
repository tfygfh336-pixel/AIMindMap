/* ============================================================
 * scripts/smoke/42-bindings-ui.js —— 绑定工作区文件夹（R4 · 第④步「界面（最小可用）」）
 * ------------------------------------------------------------
 * 用户原话：「绑定工作区文件夹，选择好了之后就会定时更新文件夹内容到思维导图」。
 * 引擎（第①②③步，提交 45e642e）已在：项目数据的 `bindings` 契约 + 主进程 `fs.watch` 守护 + CLI `bind-sync`。
 * 本域钉的是**界面那一半**（`renderer/app-bindings.js` + 主进程那几条入口）：
 *
 *   甲 入口与预览：真鼠标点「📁 绑定文件夹」⇒ 选完目录**先看"将要做什么"**（数字来自既有 `--dry-run` 读法，
 *      在一份**演练副本**上算 ⇒ 此刻用户项目零写入）⇒ 确认之后节点才出现在盘上/画布上；
 *      状态区显示"守护中 · 已收录 N 个文件 · 上次同步"。
 *   乙 删除只提议：盘上删掉一个文件 ⇒ 状态区出现"待确认删 1"，而**树里节点一个都不少**、
 *      项目 JSON 甚至一个字节都没变（提议只活在引擎的旁路快照/报告里）；等几秒再看，仍然一个都不少。
 *   丙 暂停/立即同步/继续：暂停后改文件**不同步**（等过防抖 4 秒，项目 JSON 逐字节不变）；
 *      人点「立即同步」⇒ 手动那一跳仍然生效（且**不会**把暂停变成继续）；点「继续」⇒ 自动同步恢复。
 *   丁 变更播报：自动同步后 banner 亮、点开面板**逐条列出这次新增的节点**，点一行真的跳到那个节点。
 *   戊 解绑：状态条收起（那一带不占布局、不进命中测试）而**已导入的节点全部保留**；解绑后改文件不再同步。
 *   己 未绑定时的默认档：状态条/播报/预览面板全不出现、**不占布局**（#main 顶边=工具栏底边），
 *      项目 JSON 里连 `bindings` 键都没有。
 *
 * 判据纪律（本文件自己遵守的两条）：
 *   · **可见性一律 `document.elementFromPoint`**（几何读数只用来定位，从不用来判"看不看得见"）；
 *   · **动作一律真鼠标**（`ctx.input.click` 走 Chromium 命中测试），不是 `dispatchEvent` 合成事件。
 * 真值口径：一律读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 由 main.js 在 `--smoke` 下指向
 * 临时副本 ⇒ 读到的就是本次跑动的真实盘上形态，且**零真实数据风险**）+ CLI 自己的 `--json` 报告对拍。
 *
 * ⚠️ 选目录那一跳在 `--smoke` 下是**脚本化答案**（`<沙箱>/bind-pick.txt`）：无头跑点不动原生模态，
 *    弹出来只会把整条链挂死。界面把 `stub:true` 如实显示出来（"这一跳是冒烟脚本化的答案"）——
 *    其余每一跳（预览 / 确认绑定 / 三个按钮 / 自动同步 / 播报）走的都是产品真路径。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** 沙箱源目录（**不属于 projects/ 真实数据**；本域收尾时删干净） */
const SRC_DIR = path.join(os.tmpdir(), 'zz-bind-ui-src');
const P = 'zz-bind-ui';
const P_NONE = 'zz-bind-ui-none';
const STAMP = String(Date.now());

const A_MD = '# 甲文件 ' + STAMP + '\n甲正文\n';
const B_MD = '# 乙文件 ' + STAMP + '\n乙正文\n';
const C_MD = '# 丙文件 ' + STAMP + '\n丙正文\n';
const A_APPEND = '\n\n## 甲附注 ' + STAMP + '\n甲附注正文\n';
const MARK_A_APPEND = '甲附注 ' + STAMP;

/** 进来时界面开着哪个项目（本域收尾要交还回去；见"己"末尾的说明） */
let PROJECT_WHEN_ENTERED = '';

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到沙箱真值');
  return d;
}
const pickStubFile = () => path.join(projectsDir(), 'bind-pick.txt');
const projectFile = (name) => path.join(projectsDir(), name, name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const readProject = (name) => JSON.parse(readRaw(name));
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function allNodes(name) {
  const out = [];
  (function walk(n) { if (!n) return; out.push(n); (n.children || []).forEach(walk); })(readProject(name).data);
  return out;
}
/** 树里"这个绑定目录导进来的文件节点"（一律按 `origin` 逐条点名，不靠标题猜） */
function fileNodes(name) {
  return allNodes(name).filter((n) => {
    const o = n && n.origin;
    return !!(o && o.tool === 'bind-sync' && o.src && norm(o.src).indexOf(norm(SRC_DIR)) === 0);
  });
}
function bindingRows(name) {
  const j = readProject(name);
  return Array.isArray(j.bindings) ? j.bindings : null;
}
function seedSource(files) {
  fs.rmSync(SRC_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_DIR, { recursive: true });
  Object.keys(files).forEach((f) => fs.writeFileSync(path.join(SRC_DIR, f), files[f], 'utf8'));
}
function cleanupSandboxArtifacts() {
  try { fs.rmSync(SRC_DIR, { recursive: true, force: true }); } catch (e) { /* 收尾失败不掩盖主判据 */ }
  try { fs.rmSync(pickStubFile(), { force: true }); } catch (e) { /* 同上 */ }
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
const bindStateJs = '(function () { return JSON.stringify(window.MMApp.bindState()); })()';
async function bindState(ctx) {
  try { return JSON.parse(await ctx.exec(bindStateJs)); } catch (e) { return null; }
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
/** 预览说"新增 N 个文件"，真同步就必须长出 N 个文件节点（两个来源对拍 ⇒ 预览不是装饰） */
function previewAddedMatchesTruth(plan, nodes) {
  if (!plan || !Array.isArray(nodes)) return false;
  return plan.added === nodes.length;
}

/** 入口：**真的用鼠标走「命令面板 → 绑定工作区文件夹…」**。
 *  ⚠️ 工具栏上**没有**这个按钮（本批实机撤回）：这一段工具栏在"侧栏开着"时可用宽度只剩 ~1000px，
 *  再加一个按钮就会把它挤成**两行**（实测 +33px 高）⇒ 所有"跨状态比绝对坐标"的判据随之漂移，
 *  域 37 的圆钮/悬浮工具条几何（用户原话逐字验收的那两条）当场变红 ✗✗。
 *  ⇒ 入口改放：**原生菜单**「文件 → 绑定工作区文件夹…」（唯一入口，见 menuItemProbe）+
 *  **命令面板**里的同一条命令（同一实现 `MM.bindWorkspace()`，本函数走的就是它）。 */
async function openBindEntryByPalette(ctx) {
  const open = await clickSel(ctx, '#btn-palette');
  if (!open.ok) return { ok: false, err: '打开命令面板失败：' + open.err };
  const row = await ctx.exec(`(function () {
    var list = document.getElementById('palette-list');
    if (!list) return { err: '没有命令面板列表' };
    list.scrollTop = list.scrollHeight;      // 列表可滚动：把目标行滚进可视区再点（"看得见"才点）
    var items = Array.prototype.slice.call(list.querySelectorAll('.palette-item'));
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].textContent || '').indexOf('绑定工作区文件夹') >= 0) {
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
    return { err: '命令面板里没有「绑定工作区文件夹」这一行', total: items.length };
  })()`);
  if (!row || row.err) return { ok: false, err: (row && row.err) || '没找到那一行', row: row };
  if (!row.self) return { ok: false, err: '那一行在这一点上看不见（命中 ' + row.at + '）', row: row };
  if (!ctx.input) return { ok: false, err: '没有真输入底座（ctx.input 缺失）', row: row };
  await ctx.input.click({ x: row.cx, y: row.cy });
  await ctx.input.settle();
  return { ok: true, row: row };
}
/** 原生菜单里那**唯一**的入口（主进程侧读；导图页在 ⇒ 启用、不在 ⇒ 置灰，由既有机制统一管） */
function menuItemProbe() {
  try {
    const electron = require('electron');
    const m = electron.Menu.getApplicationMenu();
    const it = m ? m.getMenuItemById('map-menu-bind-workspace') : null;
    if (!it) return { found: false };
    return { found: true, label: it.label, enabled: it.enabled === true, hasClick: typeof it.click === 'function' };
  } catch (e) { return { found: false, error: (e && e.message) || String(e) }; }
}

const assertions = [
  {
    name: '甲 绑定前预览的读数来自 CLI 既有 --dry-run 读法（演练副本上算 ⇒ 此刻用户项目逐字节不变）+ 真鼠标点「确认绑定」后两个文件节点出现在盘上且画布上命中它自己 + 状态区显示守护中与上次同步（判定依据：预览数字与真同步对拍、项目 JSON SHA-256、elementFromPoint）',
    run: async (ctx) => {
      const mm = require('../smoke-assertions.js');
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var st = window.MMApp.getState();'
        + ' return (st && st.project && st.project.name) || ""; })()');
      ctx.runCli(['init', P]);
      ctx.runCli(['init', P_NONE]);
      seedSource({ 'a.md': A_MD, 'b.md': B_MD });
      fs.writeFileSync(pickStubFile(), SRC_DIR, 'utf8');          // 冒烟脚本化的"选目录"答案

      await ctx.exec('window.MMApp.openProject(' + JSON.stringify(P) + ')');
      await sleep(350);
      await ctx.exec('(function () { if (window.MMApp.resetView) window.MMApp.resetView(); return 1; })()');

      const shaBefore = sha256(readRaw(P));                        // 预览之前：项目文件逐字节
      const menuItem = menuItemProbe();                            // 入口之一：原生菜单项在不在
      const entryHit = await hitSel(ctx, '#btn-palette');          // 命令面板那个按钮（真鼠标走它）
      const entryClick = await openBindEntryByPalette(ctx);        // 真鼠标：面板 → 那一行
      const opened = await waitUntil(async () => {
        const st = await bindState(ctx);
        return !!(st && st.preview && st.preview.shown && st.preview.plan);
      }, 15000);
      const st1 = await bindState(ctx);
      const plan = (st1 && st1.preview && st1.preview.plan) || null;
      const planText = await ctx.exec('(function () { var b = document.getElementById("bind-preview-plan");'
        + ' return b ? String(b.textContent || "") : ""; })()');
      const okBtnHit = await hitSel(ctx, '#bind-preview-ok');      // 「确认绑定」看得见吗
      const previewZeroWrite = shaBefore === sha256(readRaw(P));   // 预览之后：逐字节（**必须相同**）

      const confirmClick = await clickSel(ctx, '#bind-preview-ok');  // 真鼠标确认
      const appeared = await waitUntil(() => fileNodes(P).length === 2, 25000);
      await sleep(400);
      const nodes = fileNodes(P).map((n) => ({ id: n.id, topic: n.topic, src: n.origin.src }));
      const st2 = await bindState(ctx);
      const barHit = await hitSel(ctx, '#bind-bar');               // 状态条看得见吗
      const rows = bindingRows(P) || [];
      const vis = [];
      for (const n of nodes) vis.push({ topic: n.topic, hit: await nodeVisibleByElementFromPoint(ctx, n.id) });
      const barText = (st2 && st2.barText) || '';
      const lastSyncAt = (st2 && st2.barAttrs && st2.barAttrs.lastSyncAt) || '';

      const ok = !!entryHit && entryHit.self === true
        && entryClick.ok === true
        && menuItem.found === true && menuItem.enabled === true && menuItem.hasClick === true
        && opened.ok === true && !!plan
        && plan.added === 2 && plan.modified === 0 && plan.unconverted === 0
        && /新增 2 个文件/.test(String(planText))
        && previewZeroWrite === true
        && !!okBtnHit && okBtnHit.self === true
        && confirmClick.ok === true
        && appeared.ok === true
        && nodes.length === 2
        && nodes.filter((n) => n.topic === 'a').length === 1
        && nodes.filter((n) => n.topic === 'b').length === 1
        && previewAddedMatchesTruth(plan, nodes) === true
        && !!barHit && barHit.self === true
        && /守护中/.test(barText) && /已收录 2 个文件/.test(barText) && /上次同步/.test(barText)
        && lastSyncAt.length > 0
        && rows.length === 1 && (rows[0].status === undefined || rows[0].status === 'watching')
        && vis.every((v) => v.hit && v.hit.self === true);
      const closed = await mm.closeDialogs(ctx);                   // 收干净（本段开了预览模态）
      return {
        ok: ok === true,
        text: '入口：原生菜单项=' + JSON.stringify(menuItem) + ' ｜ 命令面板按钮命中=' + (entryHit && entryHit.self)
          + ' ｜ 面板里那一行=' + JSON.stringify(entryClick.row ? { idx: entryClick.row.idx, total: entryClick.row.total, text: entryClick.row.text, 命中它自己: entryClick.row.self } : entryClick.err)
          + ' · 预览框打开=' + opened.ok + '（' + opened.ms + 'ms）'
          + ' · 预览读数（CLI --dry-run 行）：新增=' + (plan && plan.added) + ' 更新=' + (plan && plan.modified)
          + ' 未转换=' + (plan && plan.unconverted) + ' 范围内=' + (plan && plan.scanned)
          + ' · 预览框里的原话：「' + String(planText).slice(0, 90) + '…」'
          + ' · 预览期间项目 JSON 逐字节不变=' + previewZeroWrite
          + ' · 「确认绑定」命中=' + (okBtnHit && okBtnHit.self) + ' 点击=' + confirmClick.ok
          + ' · 节点出现=' + appeared.ok + '（' + appeared.ms + 'ms）'
          + ' · 盘上文件节点=' + nodes.map((n) => n.topic + ':' + n.id).join(' ')
          + ' · 预览与真同步对拍（2 vs ' + nodes.length + '）=' + previewAddedMatchesTruth(plan, nodes)
          + ' · 状态条命中=' + (barHit && barHit.self) + ' 文案「' + barText + '」'
          + ' · 画布上逐节点命中它自己：' + vis.map((v) => v.topic + '=' + (v.hit && v.hit.self)).join(' ')
          + ' · 收尾：closeDialogs 关掉 ' + closed.n + ' 个' + (closed.n ? '（' + closed.names.join('、') + '）' : '')
      };
    }
  },

  {
    name: '乙 盘上删掉一个文件 ⇒ 状态区出现"待确认删 1"、而**树里节点一个都不少**且项目 JSON 一个字节都没变（提议不写进用户数据）；等几秒再查仍然一个都不少（判定依据：项目 JSON 里 origin 逐条点名 + 状态区读数与 CLI 报告 pendingList 对拍）',
    run: async (ctx) => {
      const before = readRaw(P);
      const beforeNodes = fileNodes(P).map((n) => n.id + ':' + n.topic).sort();
      fs.rmSync(path.join(SRC_DIR, 'b.md'));                       // 盘上删掉一个（真删，不是改名）
      const seen = await waitUntil(async () => {
        const st = await bindState(ctx);
        return !!(st && st.barAttrs && st.barAttrs.pending === '1');
      }, 25000);
      const st = await bindState(ctx);
      const barText = (st && st.barText) || '';
      const probe = JSON.parse(ctx.runCli(['bind-sync', P, '--dry-run', '--json']));
      const probePending = (probe.bindings && probe.bindings[0] && probe.bindings[0].pending) || 0;
      const probeList = (probe.sync && probe.sync[0] && probe.sync[0].pendingList) || [];
      const afterNodes = fileNodes(P).map((n) => n.id + ':' + n.topic).sort();
      const after = readRaw(P);
      await sleep(4000);                                           // 等过防抖 + 一轮自动同步的时间
      const laterNodes = fileNodes(P).map((n) => n.id + ':' + n.topic).sort();
      const laterRaw = readRaw(P);
      const delBtns = await ctx.exec('(function () { var bar = document.getElementById("bind-bar");'
        + ' if (!bar) return []; return Array.prototype.slice.call(bar.querySelectorAll("button"))'
        + '.map(function (b) { return String(b.textContent || ""); }); })()');
      const hasDeleteBtn = (delBtns || []).some((t) => /删|确认/.test(String(t)));

      return {
        ok: seen.ok === true
          && /待确认删 1/.test(barText) && st.barAttrs.pending === '1' && st.barAttrs.state === 'watching'
          && probePending === 1 && probeList.length === 1 && /b\.md$/.test(String(probeList[0].rel))
          && afterNodes.join(' ') === beforeNodes.join(' ') && afterNodes.length === 2
          && /b\.md$/.test(String((fileNodes(P).filter((n) => n.topic === 'b')[0] || {}).origin.src || ''))
          && after === before && laterRaw === before                    // 连项目 JSON 都没被搅动
          && laterNodes.join(' ') === beforeNodes.join(' ')             // 4 秒后仍然一个都不少
          && hasDeleteBtn === false,
        text: '状态区读数=' + JSON.stringify(st.barAttrs) + ' 文案「' + barText + '」'
          + ' · CLI 对拍：pending=' + probePending + ' 点名=' + JSON.stringify(probeList.map((p) => p.rel))
          + ' · 盘上文件节点（删前/删后/4 秒后）=' + beforeNodes.length + '/' + afterNodes.length + '/' + laterNodes.length
          + '：' + afterNodes.join(' ')
          + ' · 被删文件的节点还在（topic=b）=' + /b\.md$/.test(String((fileNodes(P).filter((n) => n.topic === 'b')[0] || {}).origin.src || ''))
          + ' · 项目 JSON 逐字节不变（删前=删后=' + (after === before) + '，4 秒后仍相同=' + (laterRaw === before) + '）'
          + ' · 状态区里有没有删除/确认按钮=' + hasDeleteBtn + '（必须 false：确认流是设计排期的第⑥步）'
      };
    }
  },

  {
    name: '丙 暂停 ⇒ 改文件**不同步**（等过防抖 4 秒后项目 JSON 逐字节不变）；「立即同步」⇒ 人点的那一跳仍生效且不改变暂停状态；「继续」⇒ 自动同步恢复（判定依据：SHA-256 逐字节 + 项目 JSON 里现算标记 + CLI --watch-dirs 的 active 对拍）',
    run: async (ctx) => {
      const pauseClick = await clickSel(ctx, '#bind-btn-toggle');
      const paused = await waitUntil(async () => {
        const st = await bindState(ctx);
        return !!(st && st.barAttrs && st.barAttrs.active === '0');
      }, 15000);
      const stPaused = await bindState(ctx);
      const sp = (stPaused && stPaused.barAttrs) || {};
      const spText = (stPaused && stPaused.barText) || '';
      const wdPaused = JSON.parse(ctx.runCli(['bind-sync', P, '--watch-dirs', '--json']));

      const shaBeforeEdit = sha256(readRaw(P));
      fs.appendFileSync(path.join(SRC_DIR, 'a.md'), A_APPEND, 'utf8');
      await sleep(4000);                                            // 等过防抖（800ms）+ 一轮自动同步的成本
      const shaAfterEdit = sha256(readRaw(P));
      const pausedNoSync = shaBeforeEdit === shaAfterEdit && readRaw(P).indexOf(MARK_A_APPEND) < 0;

      const syncBtnClick = await clickSel(ctx, '#bind-btn-sync');
      const landed = await waitUntil(() => readRaw(P).indexOf(MARK_A_APPEND) >= 0, 25000);
      const stAfterSync = await bindState(ctx);
      const sas = (stAfterSync && stAfterSync.barAttrs) || {};
      const syncHits = (stAfterSync && stAfterSync.lastSync) || null;

      const resumeBtnClick = await clickSel(ctx, '#bind-btn-toggle');
      const resumed = await waitUntil(async () => {
        const st = await bindState(ctx);
        return !!(st && st.barAttrs && st.barAttrs.active === '1');
      }, 15000);
      const stResumed = await bindState(ctx);
      const sr = (stResumed && stResumed.barAttrs) || {};
      const wdResumed = JSON.parse(ctx.runCli(['bind-sync', P, '--watch-dirs', '--json']));
      /* 自动同步恢复：再改一次文件，这次**不点任何按钮**，靠守护自己同步进来。
       * ⚠️ 改的是 a.md（**不碰被删的 b.md**）：引擎对"提议删过的文件又出现"按【新增】处理
       * （快照里那条已被摘掉）⇒ 会多出一个同名节点 —— 那是引擎既定语义，不该混进"界面暂停/继续"的判据里。
       * 这条边界本域如实记在这里（见报文与未做/未核实那段），不假装它不存在。 */
      const mark2 = '甲自动同步 ' + STAMP;
      fs.appendFileSync(path.join(SRC_DIR, 'a.md'), '\n\n## ' + mark2 + '\n正文\n', 'utf8');
      const autoBack = await waitUntil(() => readRaw(P).indexOf(mark2) >= 0, 25000);

      return {
        ok: pauseClick.ok === true && paused.ok === true
          && sp.state === 'paused' && /已暂停/.test(spText)
          && wdPaused.active === 0 && wdPaused.total === 1
          && pausedNoSync === true
          && syncBtnClick.ok === true && landed.ok === true
          && sas.active === '0'
          && resumeBtnClick.ok === true && resumed.ok === true
          && wdResumed.active === 1
          && autoBack.ok === true
          && fileNodes(P).length === 2,
        text: '暂停：点击=' + pauseClick.ok + ' 读数=' + JSON.stringify(sp)
          + ' CLI --watch-dirs active=' + wdPaused.active + '/' + wdPaused.total
          + ' · 暂停中改文件后项目 JSON 逐字节不变=' + pausedNoSync
          + '（SHA ' + shaBeforeEdit.slice(0, 12) + ' → ' + shaAfterEdit.slice(0, 12)
          + '，附注标记是否落盘=' + (readRaw(P).indexOf(MARK_A_APPEND) >= 0) + '）'
          + ' · 「立即同步」点击=' + syncBtnClick.ok + ' 落地=' + landed.ok + '（' + landed.ms + 'ms）'
          + ' 本次读数=' + JSON.stringify(syncHits) + ' 状态仍=已暂停(' + (sas.active === '0') + ')'
          + ' · 「继续」点击=' + resumeBtnClick.ok + ' 读数=' + JSON.stringify(sr)
          + ' CLI active=' + wdResumed.active
          + ' · 继续后**不点按钮**改文件 ⇒ 自动同步=' + autoBack.ok + '（' + autoBack.ms + 'ms）'
      };
    }
  },

  {
    name: '丁 变更播报：自动同步后 banner 亮且按钮点得到，点开的面板里**逐条列出这次新增的节点**（键与 CLI 报告的 +1 对拍），点一行真的跳到那个节点且它在画布上命中它自己（判定依据：报告数字 vs 面板数据键 + elementFromPoint）',
    run: async (ctx) => {
      await ctx.exec('(function () { try { if (window.MMApp.bindCloseBanner) window.MMApp.bindCloseBanner(); }'
        + ' catch (e) {} if (window.MMApp.resetView) window.MMApp.resetView(); return 1; })()');
      const beforeIds = fileNodes(P).map((n) => n.id).sort();
      fs.writeFileSync(path.join(SRC_DIR, 'c.md'), C_MD, 'utf8');   // 新增一个文件 ⇒ 等**自动**同步（不点按钮）
      const synced = await waitUntil(() => fileNodes(P).some((n) => n.topic === 'c'), 30000);
      const cNode = fileNodes(P).filter((n) => n.topic === 'c')[0] || null;
      const bannerShown = await waitUntil(async () => {
        const st = await bindState(ctx);
        return !!(st && st.banner && st.banner.shown);
      }, 12000);
      const st = await bindState(ctx);
      const bannerHit = await hitSel(ctx, '#bind-banner-open');
      const openClick = await clickSel(ctx, '#bind-banner-open');
      const panelOpen = await waitUntil(async () => !!(await ctx.exec('(function () { return !!(window.MMApp.concPanelOpen && window.MMApp.concPanelOpen()); })()')), 8000);
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
      const wantKey = cNode ? ('node:' + cNode.id) : null;
      const cRow = ((addedGroup && addedGroup.rows) || []).filter((r) => r.key === wantKey)[0] || null;
      const rowSel = '.conc-row[data-key=' + JSON.stringify(wantKey || '') + ']';
      const rowClick = await clickSel(ctx, rowSel);
      const selected = await ctx.exec('(function () { var jm = window.MMApp.getState().jm;'
        + ' var s = jm && jm.get_selected_node ? jm.get_selected_node() : null; return s ? s.id : null; })()');
      await ctx.exec('(function () { try { if (window.MMApp.closeConcPanel) window.MMApp.closeConcPanel(); } catch (e) {} return 1; })()');
      const visible = cNode ? await nodeVisibleByElementFromPoint(ctx, cNode.id) : { err: '没有新节点' };
      const addedIds = fileNodes(P).map((n) => n.id).sort().filter((id) => beforeIds.indexOf(id) < 0);

      return {
        ok: synced.ok === true && !!cNode
          && bannerShown.ok === true
          && /新增 1 个文件/.test(String(st.banner.text || ''))
          && !!bannerHit && bannerHit.self === true
          && openClick.ok === true && panelOpen.ok === true
          && !!addedGroup && addedGroup.rows.length > 0
          && !!cRow && cRow.clickable === true && cRow.label.indexOf('节点「c」') >= 0
          && addedIds.length === 1 && addedIds[0] === cNode.id
          && rowClick.ok === true && selected === cNode.id
          && !!visible && visible.self === true && visible.hit === cNode.id,
        text: '自动同步新增文件=' + synced.ok + '（' + synced.ms + 'ms）· 新节点=' + (cNode && (cNode.id + ':' + cNode.topic))
          + ' · 直接新增的文件节点（按 origin 现算）=' + JSON.stringify(addedIds)
          + ' · banner=' + bannerShown.ok + ' 文案「' + (st.banner.text || '') + '」'
          + ' · banner 按钮命中它自己=' + (bannerHit && bannerHit.self) + ' 点击=' + openClick.ok
          + ' · 面板打开=' + panelOpen.ok + ' 标题「' + (panel && panel.title) + '」'
          + ' · 「新出现」组 ' + ((addedGroup && addedGroup.rows.length) || -1) + ' 行 = '
          + JSON.stringify(((addedGroup && addedGroup.rows) || []).map((r) => r.key))
          + '（新节点那一行在不在=' + !!cRow + '，可点=' + (cRow && cRow.clickable) + '，行首「' + (cRow && cRow.label) + '」）'
          + ' · 点那一行：命中它自己=' + rowClick.ok + ' · 选中的节点=' + selected
          + '（应为 ' + (cNode && cNode.id) + '）'
          + ' · 跳过去之后画布上命中=' + (visible && visible.hit) + '（是它自己=' + (visible && visible.self) + '）'
      };
    }
  },

  {
    name: '戊 解绑 ⇒ 绑定从项目里消失（状态条收起，那一带不占布局、命中测试落不到任何绑定元素上）而**已导入的节点全部保留**；解绑后改文件不再同步（判定依据：项目 JSON 里 bindings 为空 + 节点按 origin 逐条点名 + SHA-256 不变 + elementFromPoint）',
    run: async (ctx) => {
      const nodesBefore = fileNodes(P).map((n) => n.id + ':' + n.topic).sort();
      const unbindClick = await clickSel(ctx, '#bind-btn-unbind');
      const gone = await waitUntil(async () => {
        const st = await bindState(ctx);
        return !!(st && st.barAttrs && st.barAttrs.showing === '0');
      }, 15000);
      const st = await bindState(ctx);
      const rows = bindingRows(P);
      const nodesAfter = fileNodes(P).map((n) => n.id + ':' + n.topic).sort();
      const wd = JSON.parse(ctx.runCli(['bind-sync', P, '--watch-dirs', '--json']));
      const probeHit = await ctx.exec(`(function () {
        var m = document.getElementById('main').getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(m.left + 60), Math.round(m.top + 6));
        var inBind = !!(at && at.closest && at.closest('#bind-bar,#bind-banner,#bind-preview'));
        var bar = document.getElementById('bind-bar');
        var br = bar.getBoundingClientRect();
        return { w: br.width, h: br.height, at: at ? (at.tagName + '#' + (at.id || '')) : '', inBind: inBind };
      })()`);
      const sha0 = sha256(readRaw(P));
      const mark3 = '解绑后不该同步 ' + STAMP;
      fs.appendFileSync(path.join(SRC_DIR, 'a.md'), '\n\n## ' + mark3 + '\n正文\n', 'utf8');
      await sleep(4000);
      const noSyncAfterUnbind = sha256(readRaw(P)) === sha0 && readRaw(P).indexOf(mark3) < 0;

      return {
        ok: unbindClick.ok === true && gone.ok === true
          && st.barAttrs.showing === '0' && st.barShown === false
          && Array.isArray(rows) && rows.length === 0
          && nodesAfter.join(' ') === nodesBefore.join(' ') && nodesAfter.length === 3
          && wd.active === 0 && wd.total === 0
          && probeHit.h === 0 && probeHit.inBind === false
          && noSyncAfterUnbind === true,
        text: '解绑点击=' + unbindClick.ok + ' 状态条收起=' + gone.ok + '（' + gone.ms + 'ms，showing='
          + st.barAttrs.showing + '）· 项目里 bindings=' + JSON.stringify(rows)
          + ' · 已导入节点（解绑前/后）=' + nodesBefore.length + '/' + nodesAfter.length + '：' + nodesAfter.join(' ')
          + ' · CLI --watch-dirs active=' + wd.active + '/' + wd.total
          + ' · 状态条那一带的几何 ' + probeHit.w + 'x' + probeHit.h + '，命中=' + probeHit.at
          + '（落进任何绑定元素里=' + probeHit.inBind + '）'
          + ' · 解绑后改文件仍逐字节不变=' + noSyncAfterUnbind
      };
    }
  },

  {
    name: '己 未绑定时的默认档：状态条/播报/预览面板全不出现、**不占布局**（#main 顶边 = 工具栏底边、画布上方那一点命中的不是绑定元素），项目 JSON 里连 bindings 键都没有（判定依据：elementFromPoint + 几何相等 + 项目 JSON 原文）',
    run: async (ctx) => {
      const mm = require('../smoke-assertions.js');
      const cleaned = await mm.closeDialogs(ctx);
      await ctx.exec('window.MMApp.openProject(' + JSON.stringify(P_NONE) + ')');
      await sleep(400);
      const layout = await ctx.exec(`(function () {
        var tb = document.getElementById('toolbar').getBoundingClientRect();
        var main = document.getElementById('main').getBoundingClientRect();
        var bar = document.getElementById('bind-bar');
        var banner = document.getElementById('bind-banner');
        var prev = document.getElementById('bind-preview');
        var br = bar.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(tb.left + 40), Math.round(main.top + 6));
        var hitBind = !!(at && at.closest && at.closest('#bind-bar,#bind-banner,#bind-preview'));
        return {
          toolbarBottom: tb.bottom, mainTop: main.top, mainHeight: main.height,
          barDisplay: getComputedStyle(bar).display, barW: br.width, barH: br.height,
          bannerDisplay: getComputedStyle(banner).display,
          previewDisplay: getComputedStyle(prev).display,
          hitTag: at ? (at.tagName + '#' + (at.id || '')) : '', hitBind: hitBind
        };
      })()`);
      const hasBindingsKey = Object.prototype.hasOwnProperty.call(readProject(P_NONE), 'bindings');
      const st = await bindState(ctx);
      /* "未绑定时界面不多出噪声"的最强形式：**工具栏一个像素都不多** ——
       * 断言工具栏里没有任何绑定元素（域 37 的绝对坐标判据就是被"多一个按钮挤成两行"挤红的 ✗），
       * 入口那一处则落在原生菜单 + 命令面板里（两者都是零布局开销）。 */
      const chrome = await ctx.exec(`(function () {
        var tb = document.getElementById('toolbar');
        var bindInToolbar = tb ? tb.querySelectorAll('[id^=bind]').length : -1;
        var pal = document.getElementById('palette-list');
        var palRows = pal ? Array.prototype.slice.call(pal.querySelectorAll('.palette-item')) : [];
        var bindRows = palRows.filter(function (r) { return String(r.textContent || '').indexOf('绑定工作区文件夹') >= 0; }).length;
        return { toolbarBindEls: bindInToolbar, paletteRows: palRows.length, paletteBindRows: bindRows };
      })()`);
      const menuItem = menuItemProbe();
      /* 把界面**交还成我进来时的样子**（本域是最后一个域：不留一个"当前项目"是我造出来的状态）。
       * 顺带一个实测结论：主进程对"当前项目目录"挂着 `project:watch`，而 Windows 上删除一个
       * **正被 fs.watch 盯着的目录**会 EPERM ⇒ 冒烟收尾清沙箱时会剩下"最后打开的那个项目"一条
       * （如实打印、不当 PASS/FAIL）。把最后的项目换回进来的那一个，这个残留的名字就不因本域而改变 ✓ */
      if (PROJECT_WHEN_ENTERED) {
        await ctx.exec('window.MMApp.openProject(' + JSON.stringify(PROJECT_WHEN_ENTERED) + ')');
        await sleep(300);
      }
      cleanupSandboxArtifacts();                                    // 收尾：临时源目录 + 选目录桩文件
      const L = layout || {};
      const num = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v));
      return {
        ok: !!cleaned && !!layout && Math.abs(L.mainTop - L.toolbarBottom) <= 1
          && L.barH === 0 && L.barW === 0
          && L.barDisplay === 'none' && L.bannerDisplay === 'none' && L.previewDisplay === 'none'
          && L.hitBind === false
          && hasBindingsKey === false
          && !!st && st.barShown === false && st.barAttrs && st.barAttrs.showing === '0'
          && chrome.toolbarBindEls === 0 && chrome.paletteBindRows === 1
          && menuItem.found === true && menuItem.hasClick === true,
        text: '未绑定项目的几何：工具栏底=' + num(L.toolbarBottom) + ' #main 顶=' + num(L.mainTop)
          + '（差=' + num(Math.abs(L.mainTop - L.toolbarBottom)) + 'px ⇒ 中间**没有**多出一条）'
          + ' · 状态条 display=' + L.barDisplay + ' 几何=' + L.barW + 'x' + L.barH
          + ' · 播报 display=' + L.bannerDisplay + ' · 预览 display=' + L.previewDisplay
          + ' · 画布顶部那一点命中=' + L.hitTag + '（落进绑定元素里=' + L.hitBind + '）'
          + ' · 项目 JSON 里有 bindings 键=' + hasBindingsKey
          + ' · 界面侧读数 showing=' + (st && st.barAttrs && st.barAttrs.showing)
          + ' · 工具栏里的绑定元素=' + chrome.toolbarBindEls + '（必须 0：多一个按钮会把工具栏挤成两行 ✗）'
          + ' · 命令面板里的绑定命令行=' + chrome.paletteBindRows + '/' + chrome.paletteRows
          + ' · 原生菜单入口=' + JSON.stringify(menuItem)
          + ' · 收尾：closeDialogs 关掉 ' + (cleaned && cleaned.n) + ' 个' + closedNames(cleaned)
          + ' + 临时源目录与选目录桩文件已删'
      };
    }
  }
];

function closedNames(cleaned) {
  return (cleaned && cleaned.n && cleaned.names && cleaned.names.length)
    ? '（' + cleaned.names.join('、') + '）' : '';
}

module.exports = assertions;
