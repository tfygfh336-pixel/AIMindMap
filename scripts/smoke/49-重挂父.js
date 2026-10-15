/* ============================================================
 * scripts/smoke/49-重挂父.js —— 【R2 期 4】f（重挂父：把 a 的子树挂到 b 下）
 * ------------------------------------------------------------
 * 用户原话（R2 需求 f）：**重挂父 —— 把 a 的子节点树变成 b 的**。
 * 本域钉的是"三道闸 + 五条判据"（设计稿 §3 期 4 / §7-P2 的定版形状）：
 *
 *  甲 **f · 真鼠标全链**（`renderer/contextmenu.js` 的入口 + `renderer/app-view.js` 的
 *     'reparent' 拖动档 + `renderer/app-actions.js` 的写口 + `main.js` 的两道 IPC）：
 *       ① 入口在右键菜单里、真鼠标点得到、进入的是 reparent 档（不是 move/reorder）；
 *       ② **落位预览（演练副本法）**：拖到位 ⇒ 预览在**演练副本**上跑既有 `apply --dry-run`
 *          （W13 的 makeRehearsalRoot 同一套）⇒ 桩捕获到的确认框文案里带着 CLI 的预检回执
 *          （"将要 移动 a → b"）⇒ 预览真的跑过且**用户项目零写入**；这一步选"取消" ⇒
 *          **盘上 sha256 逐字节不变**（第一道闸的硬证据）；
 *       ③ 再来一次并**确认** ⇒ 盘上结构现算：a 不在旧父的 children、新父的 children 末尾是 a，
 *          且**被移子树内部逐字节不变**（子树 JSON 文本前后逐字节相同）；
 *       ④ **零损失**：被移子树里带 payload 的节点（qa / links / localPath / origin / tags /
 *          items+detail）逐字段不变 —— "整树写回会把字段静默抹掉"在本工程有过四次先例；
 *       ⑤ **三级 assoc 不参与**（重排判据只对树边）：项目级 `assoc[]`（成员引用被移子树里的
 *          节点 + 外面的节点）逐字节不变、无悬挂（CLI validate 退出码 0）——
 *          ⚠️ 如实记边界：R7 设计的 `assoc.anchors[]` **尚未实现**（src/assoc.js 没有这个字段），
 *          本域钉的是**现存的**三级中的 assoc 这一级；anchors 那半等它落地再补；
 *       ⑥ **回读重建**：写完的界面父子关系 == 盘上（渲染层读 a.parent.id === 'b'，
 *          且渲染顺序 == 数据顺序）；
 *       ⑦ 默认档检查：打开夹具不碰新入口 ⇒ serializeTree 的结构 == 盘上那份（键序无关的全等）。
 *
 *  乙 **成环被拒 + 非法父**（`MMApp.reparentNodeRaw` —— **唯一的 raw 注入点**，跳过预览/确认、
 *     直通写通道；里面仍有 main.js 的第二道闸 `--dry-run` 预检）：
 *       ① 把 a 挂到**它自己的子孙**（a1）下 ⇒ ok:false + 报文带 **CLI 的具体理由**
 *          （"移到自身子树"——唯一实现 `tree.moveNode` 的防环判定）+ **盘上 sha256 不变**；
 *       ② 挂到**不存在的父** ⇒ ok:false（预检 needNode 拒绝）+ 盘上 sha256 不变；
 *       ③ **判别力**：同一条写通道、同一道预检，**合法对（a → c1）成功**并回读
 *          ⇒ 拒绝不是"永远拒绝"的空转；且合法档真的改了盘上父子关系。
 *
 *  丙 **预览与确认在渲染层这两道（对照）**：桩返回 false 的那次取消 ⇒ 确认框文案已捕获
 *     （预览跑过）+ 盘上零写入 + 状态栏说清"没有写入任何数据"（UI 反馈不静默）；
 *     `__reparentCalls` 留痕与真发出去的对一致。
 *
 *  丁 **结构断言 + 收尾**：写路径唯一性 —— 剥注释后 `renderer/**.js` 里
 *     `app.moveNodeParent(` **恰好 2 处且都在 app-actions.js**（确认版 + raw 版，别处 0）、
 *     `app.reparentPreview(` 恰好 1 处；jsMind 的 `.move_node(` 一族在 vendor 外 **0 命中**
 *     （与域 45 丁同一条纪律；判别力 = vendor 里确实有这些 needle）；收尾清拖动残留、
 *     删夹具项目、开回原项目、复位确认桩。
 *
 * 判据纪律（与 36/37/42/43/45/46/48 同）：可见性一律 `document.elementFromPoint`（rect 只判几何）；
 * 动作一律**真鼠标**（`ctx.input.*` 走 Chromium 命中测试）；真值读**沙箱里的项目 JSON 原文**
 * （`AI_MINDMAP_PROJECTS_DIR` 在 `--smoke` 下指向临时副本）。
 * ⚠️ 夹具是本域自己写进沙箱的 `zz-` 项目（**不碰 comnet**）；条目化那一步走既有 `item-add`
 *    （CLI 保持 items↔detail 一致，本域不手写派生缓存）。写盘用 node 的 `writeFileSync`（无 BOM）。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stripComments } = require('../../scripts/dep-direction-check.js');

/* ---------------- 夹具 ---------------- */
const P = 'zz-r2-reparent';
const T1 = 't1';
const A = 'a';                       // 被移动子树的根
const A_PAYLOAD = 'a1';              // 带 payload 的节点（qa/links/localPath/origin/tags）
const A_ITEMIZED = 'a2';             // 条目化节点（items + detail，经 item-add 造）
const B = 'b';                       // 目标父（甲的落点）
const C = 'c1';                      // 对照目标父（乙 ③ 的合法落点）
const N1 = 'n1';                     // t1 的另一个孩子（"只有 a 这一支动了"的对照）
const T2 = 't2';
const CYCLE_TARGET = 'a1';           // 成环判据：把 a 挂到它自己的子孙 a1 下
const NO_SUCH = 'zz-no-such-node';   // 非法父判据：不存在的 id
const ASSOC_ID = 'a-49-mix';
const ORIGIN_SHA = 'a'.repeat(64);   // origin.sha256：64 位小写十六进制（schema 的形状要求）

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

/** 夹具（直接写盘 ⇒ 确定性、不拖慢链）。payload 节点带 qa/links/localPath/origin/tags；
 *  assoc 的成员一个在被移子树里（a1）、一个在外面（c1）。 */
function writeFixture() {
  const dir = path.join(projectsDir(), P);
  fs.mkdirSync(dir, { recursive: true });
  const node = (id, topic, children, extra) => {
    const o = { id: id, topic: topic, expanded: true };
    if (children) o.children = children;
    if (extra) Object.keys(extra).forEach((k) => { o[k] = extra[k]; });
    return o;
  };
  const data = {
    meta: { name: P, author: '', version: '0.0.0', formatVersion: 2, rootMode: 'themes' },
    format: 'node_tree',
    assoc: [{ id: ASSOC_ID, title: '跨支关联（域 49 夹具）',
      members: [{ project: P, id: A_PAYLOAD }, { project: P, id: C }] }],
    data: node('root', 'R2 期 4 夹具', [
      node(T1, '主题甲', [
        node(A, '移动我', [
          node(A_PAYLOAD, '带家当的孩子', [node('a1x', '孙')], {
            qa: [{ q: '夹具问题', a: '夹具回答', at: '2026-10-16T00:00:00.000Z', model: 'stub' }],
            links: [{ project: P, id: C, caption: '夹具内的同项目边' }],
            localPath: 'C:\\夹具\\a1',
            origin: { kind: 'import', src: 'probe://fixture/a1', sha256: ORIGIN_SHA, at: '2026-10-16T00:00:00.000Z' },
            tags: ['夹具']
          }),
          node(A_ITEMIZED, '条目化的孩子')
        ]),
        node(B, '目标父', [node('b1', '乙-1')]),
        node(N1, '对照兄弟')
      ]),
      node(T2, '主题乙', [node(C, '对照目标父')])
    ])
  };
  fs.writeFileSync(projectFile(P), JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

/* ---------------- 盘上真值读数（全部现算，不看命令回显） ---------------- */

function parentsOf(raw) {
  const out = {};
  (function walk(n, pid) { out[n.id] = pid; (n.children || []).forEach((c) => walk(c, n.id)); })(raw.data, null);
  return out;
}
function childrenIds(raw, id) {
  let hit = null;
  (function walk(n) { if (!n || hit) return; if (n.id === id) { hit = n; return; } (n.children || []).forEach(walk); })(raw.data);
  return hit && hit.children ? hit.children.map((c) => c.id) : null;
}
function nodeOf(raw, id) {
  let hit = null;
  (function walk(n) { if (!n || hit) return; if (n.id === id) { hit = n; return; } (n.children || []).forEach(walk); })(raw.data);
  return hit;
}
/** 子树文本（该节点对象的原样 JSON）：判"被移子树内部逐字节不变"。
 *  node_tree 是嵌套形状、没有 parent 指针 ⇒ 子树序列化天然不含父引用，挂到哪都不变。 */
function subtreeText(raw, id) {
  const n = nodeOf(raw, id);
  return n ? JSON.stringify(n) : null;
}
/** 关键字段读数（判"零损失"）：只收**真存在**的字段，报文里才看得清。 */
function payloadOf(raw, id) {
  const n = nodeOf(raw, id);
  if (!n) return null;
  const out = {};
  ['items', 'detail', 'qa', 'links', 'localPath', 'origin', 'tags'].forEach((k) => {
    if (n[k] !== undefined) out[k] = n[k];
  });
  return out;
}
/** 键序无关的结构全等（默认档检查用：serializeTree 的键序与 CLI 落盘不保证一致）。 */
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') {
    const o = {};
    Object.keys(x).sort().forEach((k) => { o[k] = canonical(x[k]); });
    return o;
  }
  return x;
}

/** 键序无关的结构全等（默认档检查用）。⚠️ **展开态（expanded）不比**：serializeTree 对展开态的
 *  写法与 CLI 落盘**不同形**（"缺键等于展开" ⇒ 视图里的 true 落盘时是缺键、夹具里显式写了 true）
 *  —— 那是两种合法的落盘形态，不是数据差异；本判据比的是结构与内容字段。 */
function canonicalNoExpanded(x) {
  if (Array.isArray(x)) return x.map(canonicalNoExpanded);
  if (x && typeof x === 'object') {
    const o = {};
    Object.keys(x).sort().forEach((k) => { if (k !== 'expanded') o[k] = canonicalNoExpanded(x[k]); });
    return o;
  }
  return x;
}

/* ---------------- 渲染层工具 ---------------- */

async function stepExec(ctx, label, js) {
  try { return await ctx.exec(js); }
  catch (err) { throw new Error('第「' + label + '」步失败：' + ((err && err.message) || err)); }
}
/** ctx.exec 的返回**两种形状都有**（页里 JSON.stringify 过 ⇒ 字符串；页里返回对象字面量 ⇒
 *  Electron 原样带回对象）。第一版这里对每个读数都 JSON.parse ⇒ 对象那一路报
 *  "读数不是 JSON：[object Object]"（甲/丙的入口前置就是这么红的）。归一只有这一处。 */
function parseExec(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}
async function openProject(ctx, name) {
  const ok = await ctx.exec('window.MMApp.openProject(' + JSON.stringify(name) + ')');
  await ctx.input.settle({ delayMs: 160 });
  return ok;
}
/** 打开项目后**展开全部**（openProject 的视图归一 = 只展开根 ⇒ 深层节点 display:none、
 *  矩形 [0,0,0,0] —— 实测踩到：右键前命中预检全是 DIV#toolbar）。本域的拖拽要在
 *  真实布局上做 ⇒ 与域 48 同一步骤。展开态是视图操作（数据不动、盘上零写入）。 */
async function expandAllForDrag(ctx) {
  await stepExec(ctx, '展开全部', '(function () { window.MMApp.getState().jm.expand_all(); return true; })()');
  await ctx.input.settle(PAINT);
}
/** 确认桩：记录每一次确认框的文案（= 落位预览带回来的 CLI 回执），按 answer 应答。 */
async function stubConfirm(ctx, answer) {
  const body = answer === null
    ? 'null'
    : ('function (m) { window.__mmConfirmMsgs = window.__mmConfirmMsgs || [];'
      + ' window.__mmConfirmMsgs.push(String(m)); return ' + (answer ? 'true' : 'false') + '; }');
  await ctx.exec('window.MMApp.setConfirmStub(' + body + ')');
  STUB_INSTALLED = answer !== null;
}
const isDirty = (ctx) => ctx.exec('window.MMApp.isDirty()');
/** 轮询状态栏直到匹配（重挂链 = 预览 + 预检 + 真写三次 CLI 子进程，机器慢时 >4.5s；
 *  成功/失败文案都在重建**之后**才写 ⇒ 状态栏到位 = 全链落定）。超时返回最后一次读数。 */
async function waitForStatus(ctx, re, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = String(await ctx.exec('(function () { var el = document.getElementById("status-text"); return el ? el.textContent : ""; })()'));
    if (re.test(text)) return text;
    await ctx.input.settle({ delayMs: 300 });
  }
  return text;
}
/** 某个节点中心的屏幕坐标（真鼠标要用它） */
const pointOf = (ctx, id) => ctx.exec('(function () { var el = document.querySelector(\'jmnode[nodeid="' + id + '"]\');'
  + ' if (!el) return null; var r = el.getBoundingClientRect();'
  + ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
/** 渲染顺序读数：每个可见节点的屏幕 cy（判"渲染顺序 == 数据顺序"） */
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
/** 右键节点 → 在菜单里找一条 → 返回它的中心坐标（点得到才有点击可言）。
 *  ⚠️ **带重试**：右键菜单的弹出对帧时序敏感（renderMind 的 80ms 二次居中、浮层重排都可能
 *  把节点从指针底下挪走 —— 实测同一份代码上一轮弹出、下一轮"菜单没弹出来"）。
 *  每次尝试先 re-center + 命中预检（elementFromPoint 命中节点自己才右键），共试 3 次。 */
async function menuItemOf(ctx, nodeId, labelPart) {
  let last = { miss: '没试过' };
  for (let attempt = 0; attempt < 3; attempt++) {
    await centerNode(ctx, nodeId);
    const pt = await pointOf(ctx, nodeId);
    if (!pt) { last = { miss: '节点不在屏上：' + nodeId }; continue; }
    const hitTest = parseExec(await stepExec(ctx, '右键前命中预检', '(function () {'
      + ' var el = document.querySelector(\'jmnode[nodeid="' + nodeId + '"]\');'
      + ' var r = el.getBoundingClientRect();'
      + ' var top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));'
      + ' return JSON.stringify({ self: !!top && (top === el || el.contains(top)), at: top ? top.tagName : "(null)",'
      + '   id: top && top.id ? top.id : "", cls: top && top.className ? String(top.className).slice(0, 60) : "",'
      + '   rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }); })()'));
    if (!hitTest || hitTest.self !== true) {
      last = { miss: '右键前命中预检不过（压着 ' + (hitTest && (hitTest.at + (hitTest.id ? '#' + hitTest.id : '') + (hitTest.cls ? '.' + String(hitTest.cls).split(' ')[0] : ''))) + ' · 节点矩形=' + JSON.stringify(hitTest && hitTest.rect) + ')' };
      await ctx.input.settle({ delayMs: 250 });
      continue;
    }
    await ctx.input.drag(pt, pt, undefined, { button: 'right', stepDelayMs: 0 });
    await ctx.input.settle({ delayMs: 220 });
    const hit = parseExec(await stepExec(ctx, '量菜单项命中', '(function () { var m = document.getElementById("ctx-menu");'
      + ' if (!m || m.style.display === "none") return { miss: "菜单没弹出来" }; var t = null;'
      + ' Array.prototype.slice.call(m.querySelectorAll(".ctx-item")).forEach(function (e) {'
      + '   if (!t && e.textContent.indexOf(' + JSON.stringify(labelPart) + ') >= 0) t = e; });'
      + ' if (!t) return { miss: "菜单里没有那一条", items: Array.prototype.slice.call(m.querySelectorAll(".ctx-item")).map(function (e) { return e.textContent; }) };'
      + ' var b = t.getBoundingClientRect(); var x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);'
      + ' var top = document.elementFromPoint(x, y);'
      + ' return { x: x, y: y, self: !!top && (top === t || t.contains(top)), label: t.textContent }; })()'));
    last = hit;
    if (!hit.miss) return hit;
    await ctx.exec('(function () { if (window.MMContextMenu) window.MMContextMenu.closeMenu(); return 1; })()');
    await ctx.input.settle({ delayMs: 250 });
  }
  return last;
}
/** 把节点摆进面板中部（右键菜单向下展开；贴边会翻出视口 ⇒ 命中返回 null —— 域 46 丙的教训）。 */
async function centerNode(ctx, id) {
  await stepExec(ctx, '把目标摆进面板中部', '(function () {'
    + ' var el = document.querySelector(\'jmnode[nodeid="' + id + '"]\');'
    + ' if (!el) return null;'
    + ' var p = window.MM.fdPanel().getBoundingClientRect();'
    + ' var r = el.getBoundingClientRect();'
    + ' var wantX = p.left + (p.right - p.left) * 0.4, wantY = p.top + (p.bottom - p.top) * 0.35;'
    + ' var pan = window.MMApp.getPanState();'
    + ' window.MM.setViewTransform({ x: pan.x + (wantX - (r.left + r.width / 2)),'
    + '   y: pan.y + (wantY - (r.top + r.height / 2)), s: pan.s });'
    + ' return true; })()');
  await ctx.input.settle(PAINT);
}

const assertions = [

  /* ================= 甲 f·真鼠标全链 ================= */
  {
    name: '甲 f·重挂父（真鼠标）：入口在菜单里且进的是 reparent 档；拖动期间盘上零写入+序列化逐字节不变；落位预览（演练副本）跑过且取消零写入；确认 ⇒ 盘上父子关系 == 期望 + 被移子树内部逐字节不变 + payload 零损失 + assoc 逐字节不变 + 回读重建（界面 == 盘上）',
    run: async (ctx) => {
      writeFixture();
      // 条目化 a2 走既有 item-add（CLI 保持 items↔detail 一致 —— 本域不手写派生缓存）
      const itemAdded = ctx.runCli(['item-add', P, A_ITEMIZED, '--md', '夹具条目一（域 49）。正文一句。']);
      PROJECT_WHEN_ENTERED = await ctx.exec('(function () { var s = window.MMApp.getState();'
        + ' return (s && s.project && s.project.name) || ""; })()');
      const raw0 = JSON.parse(readRaw(P));
      const itemized = payloadOf(raw0, A_ITEMIZED);
      if (!itemized || !Array.isArray(itemized.items) || itemized.items.length !== 1) {
        return { ok: false, text: '前置失败：item-add 没把 ' + A_ITEMIZED + ' 条目化（' + String(itemAdded).slice(0, 80) + '）⇒ 后面的判据都不成立' };
      }
      const opened = await openProject(ctx, P);
      if (opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**（不是通过）' };
      // 默认档检查的读数：抓在 expand_all **之前**（视图归一后的那一版）
      const serViewAtOpen = parseExec(await stepExec(ctx, '读 serializeTree（打开后）', 'JSON.stringify(window.MMApp.serializeTree())'));
      await expandAllForDrag(ctx);
      await stubConfirm(ctx, null);
      const h0 = sha256(readRaw(P));
      // 拖动期间逐字节对照的基准：抓在 expand_all **之后**（否则 expand 自己的展开态变化会冒充"拖动写了"）
      const textBefore = await stepExec(ctx, '读序列化文本（展开后）', 'JSON.stringify(window.MMApp.serializeTree())');
      // —— 右键入口：菜单里真有那一条、点得到、进的是 reparent 档 ——
      await centerNode(ctx, A);
      const entry = await menuItemOf(ctx, A, '挂到别的父节点下');
      if (entry.miss) return { ok: false, text: '入口前置失败：' + entry.miss + (entry.items ? '；菜单=' + JSON.stringify(entry.items) : '') + ' ⇒ **未验证**' };
      let clicked = false;
      if (entry.self === true) { await ctx.input.click({ x: entry.x, y: entry.y }); clicked = true; }
      await ctx.input.settle(PAINT);
      const kind = await stepExec(ctx, '读拖动档位', 'window.MMApp.dragModeKind()');
      // —— 第一次拖放：桩返回 false（取消）—— 预览跑过（文案被捕获）但零写入 ——
      await ctx.exec('window.__mmConfirmMsgs = []; 1');
      const ptA = await pointOf(ctx, A);
      const ptB = await pointOf(ctx, B);
      if (!ptA || !ptB) return { ok: false, text: 'a 或 b 不在屏上 ⇒ **未验证**：面板/展开状态不对' };
      const hittable = await stepExec(ctx, '落点中心命中测试（b）', '(function () {'
        + ' var el = document.querySelector(\'jmnode[nodeid="' + B + '"]\');'
        + ' var r = el.getBoundingClientRect();'
        + ' var top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));'
        + ' return JSON.stringify({ self: !!top && (top === el || el.contains(top)) }); })()');
      await stubConfirm(ctx, false);
      const ghostDuring = await (async () => {
        await ctx.input.mouseDown(ptA);
        await ctx.input.settle(PAINT);
        await ctx.input.moveTo(ptB);
        await ctx.input.settle(PAINT);
        const g = await stepExec(ctx, '读拖动现状', 'JSON.stringify({ st: window.MMApp.reparentState(), ghost: !!document.getElementById("tree-reorder-ghost") })');
        // 拖动期间：盘上零写入 + 序列化逐字节不变（构造性：这一档一个偏移桶都不写）
        const hDrag = sha256(readRaw(P));
        const textDrag = await stepExec(ctx, '读拖动中的序列化文本', 'JSON.stringify(window.MMApp.serializeTree())');
        const bucketsDrag = await stepExec(ctx, '读拖动中的偏移两桶', '(function () { return JSON.stringify({ t: window.MMApp.getTreeOffsets(), n: window.MMApp.getNodeOffsets() }); })()');
        await ctx.input.mouseUp(ptB);
        await ctx.input.settle(PAINT);
        const statusCancel = await waitForStatus(ctx, /取消|没生效|没有写入/, 12000);   // 预览是 CLI 子进程（约 0.6s）+ 取消收尾
        return { reading: parseExec(g), hDrag: hDrag, textDrag: textDrag, bucketsDrag: bucketsDrag, statusCancel: statusCancel };
      })();
      const hCancel = sha256(readRaw(P));
      const msgs = parseExec(await stepExec(ctx, '读确认框文案捕获', 'JSON.stringify(window.__mmConfirmMsgs || [])'));
      const statusAfterCancel = ghostDuring.statusCancel;
      // —— 第二次拖放：桩返回 true（确认）—— 真写 ——
      writeFixture();                    // 复位到夹具原样（取消那一段没写盘，但复位让读数干净）
      ctx.runCli(['item-add', P, A_ITEMIZED, '--md', '夹具条目一（域 49）。正文一句。']);
      await openProject(ctx, P);
      await expandAllForDrag(ctx);
      await stubConfirm(ctx, true);
      // "before" 读数取**这一份**夹具（item 的 id 每次生成 ⇒ 必须与 after 同源，否则
      // "items 相同"会比到两批不同的 id 上 —— 第一跑实测踩到）
      const raw0b = JSON.parse(readRaw(P));
      const dirtyBefore = await isDirty(ctx);
      // setStatus 记录器（**只读包装**：各模块都是调用期查 MM.setStatus ⇒ 包装拦得到全部写状态栏的调用）。
      // 为什么需要：成功文案写上后，会被 own-write 的"外部变更通知"在几百毫秒内顶掉
      // （实测读数）—— 判最后一屏是观测竞态；判"有没有报过成功"要看记录。
      await ctx.exec('(function () {'
        + ' window.__mmStatusLog = [];'
        + ' if (!window.__mmStatusOrig && window.MM && window.MM.setStatus) {'
        + '   window.__mmStatusOrig = window.MM.setStatus;'
        + '   window.MM.setStatus = function (t, e) { try { window.__mmStatusLog.push(String(t)); } catch (x) {}'
        + '     return window.__mmStatusOrig(t, e); };'
        + ' } return 1; })()');
      await centerNode(ctx, A);
      const entry2 = await menuItemOf(ctx, A, '挂到别的父节点下');
      if (entry2.miss || entry2.self !== true) return { ok: false, text: '第二次入口失败：' + JSON.stringify(entry2).slice(0, 120) + ' ⇒ **未验证**' };
      await ctx.input.click({ x: entry2.x, y: entry2.y });
      await ctx.input.settle(PAINT);
      const ptA2 = await pointOf(ctx, A);
      const ptB2 = await pointOf(ctx, B);
      await ctx.input.mouseDown(ptA2);
      await ctx.input.settle(PAINT);
      await ctx.input.moveTo(ptB2);
      await ctx.input.settle(PAINT);
      await ctx.input.mouseUp(ptB2);
      await ctx.input.settle(PAINT);
      // 等写通道真的回来（留痕在写完那一刻记账 ⇒ 轮询它，比猜总时长稳）；再给重建+状态栏一拍
      const callsDeadline = Date.now() + 25000;
      let callsLen = 0;
      while (Date.now() < callsDeadline) {
        callsLen = parseExec(await stepExec(ctx, '读留痕长度', 'JSON.stringify((window.MM.__reparentCalls || []).length)'));
        if (callsLen >= 1) break;
        await ctx.input.settle({ delayMs: 300 });
      }
      await ctx.input.settle({ delayMs: 2000 });
      const hAfter = sha256(readRaw(P));
      const rawAfter = JSON.parse(readRaw(P));
      const calls = parseExec(await stepExec(ctx, '读重挂调用留痕', 'JSON.stringify(window.MM.__reparentCalls || [])'));
      const statusLog = parseExec(await stepExec(ctx, '读状态栏记录', 'JSON.stringify(window.__mmStatusLog || [])'));
      const statusAfter = String(await ctx.exec('(function () { var el = document.getElementById("status-text"); return el ? el.textContent : ""; })()'));
      const dirtyAfter = await isDirty(ctx);
      // 记录器用完即卸（不留到乙丙丁）
      await ctx.exec('(function () { if (window.__mmStatusOrig) { window.MM.setStatus = window.__mmStatusOrig; window.__mmStatusOrig = null; } return 1; })()');
      // —— 盘上结构现算（before 一律取**这一份**夹具 raw0b）——
      const t1Kids = childrenIds(rawAfter, T1);
      const bKids = childrenIds(rawAfter, B);
      const parents = parentsOf(rawAfter);
      const subBefore = subtreeText(raw0b, A);
      const subAfter = subtreeText(rawAfter, A);
      const payloadBefore = payloadOf(raw0b, A_PAYLOAD);
      const payloadAfter = payloadOf(rawAfter, A_PAYLOAD);
      const itemBefore = payloadOf(raw0b, A_ITEMIZED);
      const itemAfter = payloadOf(rawAfter, A_ITEMIZED);
      const assocBefore = canonical(raw0b.assoc || null);
      const assocAfter = canonical(rawAfter.assoc || null);
      const n1Text = subtreeText(rawAfter, N1);
      const n1Text0 = subtreeText(raw0b, N1);
      // —— 界面 == 盘上（回读重建的读数）——
      const ui = parseExec(await stepExec(ctx, '读界面父子与渲染顺序', '(function () {'
        + ' var jm = window.MMApp.getState().jm;'
        + ' var a = window.MM.adapter.getNode(jm, ' + JSON.stringify(A) + ');'
        + ' var b = window.MM.adapter.getNode(jm, ' + JSON.stringify(B) + ');'
        + ' return JSON.stringify({ aParent: a && a.parent ? a.parent.id : null,'
        + '   bKidsData: b ? (b.children || []).map(function (c) { return c.id; }) : null }); })()'));
      const cy = parseExec(await stepExec(ctx, '读渲染顺序', ORDER_JS(['b1', A])));
      const renderOrder = Object.keys(cy).filter((k) => cy[k] !== null).sort((x, y) => cy[x] - cy[y]);
      let validateOk = false;
      let validateText = '';
      try { validateText = String(ctx.runCli(['validate', P])).trim(); validateOk = true; }
      catch (e) { validateText = String((e && e.message) || e); }
      const dataSameAtOpen = JSON.stringify(canonicalNoExpanded(serViewAtOpen.data))
        === JSON.stringify(canonicalNoExpanded(raw0.data));
      const checks = [
        ['前置：夹具打开成功且条目化成功', opened === true && !!itemized],
        ['默认档检查：打开夹具不碰新入口 ⇒ serializeTree 的**数据树**与盘上同构（键序无关；展开态不比 —— serializeTree 的展开态与 CLI 落盘不同形：缺键=展开）', dataSameAtOpen],
        ['菜单里真有「挂到别的父节点下」且真鼠标点得到', entry.self === true && clicked === true],
        ['进入的是 reparent 档（不是 move/reorder）', kind === 'reparent'],
        ['拖动中副本在屏上、落点读数 = b（压着的节点）',
          !!ghostDuring && ghostDuring.reading.ghost === true && !!ghostDuring.reading.st
          && ghostDuring.reading.st.active === true && !!ghostDuring.reading.st.drop
          && ghostDuring.reading.st.drop.parent === B],
        ['拖动期间盘上零写入（sha256 逐字节不变）', ghostDuring.hDrag === h0],
        ['拖动期间序列化文本逐字节不变（这一档一个偏移桶都不写）',
          ghostDuring.textDrag === textBefore && ghostDuring.bucketsDrag === JSON.stringify({ t: {}, n: {} })],
        ['落点 b 的中心命中它自己（elementFromPoint；真鼠标的地基）',
          !!hittable && parseExec(hittable).self === true],
        ['取消（桩返回 false）之后盘上 sha256 逐字节不变 —— 落位预览跑在演练副本上，用户项目零写入', hCancel === h0],
        ['确认框文案带着 CLI 的预检回执（证明预览真的跑过既有 --dry-run）',
          msgs.length === 1 && /将要\s*移动\s/.test(msgs[0]) && msgs[0].indexOf('--dry-run') >= 0
          && msgs[0].indexOf(A) >= 0 && msgs[0].indexOf(B) >= 0],
        ['取消后状态栏说清"没有写入任何数据"（UI 反馈不静默）', /没有写入|未写盘|取消/.test(statusAfterCancel)],
        ['确认后盘上：a 不在旧父 t1 的 children、b 的 children 末尾是 a（结构现算）',
          JSON.stringify(t1Kids) === JSON.stringify([B, N1]) && JSON.stringify(bKids) === JSON.stringify(['b1', A])],
        ['确认后 a 的父 == b（parent 现算）', parents[A] === B && parents[A_PAYLOAD] === A],
        ['被移子树内部逐字节不变（子树 JSON 文本前后相同）', subBefore === subAfter && subBefore !== null],
        ['没被移动的对照节点（n1 支）也逐字节不变', n1Text === n1Text0 && n1Text !== null],
        ['零损失：a1 的 qa/links/localPath/origin/tags 逐字段不变',
          JSON.stringify(payloadBefore) === JSON.stringify(payloadAfter) && payloadBefore !== null
          && payloadBefore.qa !== undefined && payloadBefore.links !== undefined
          && payloadBefore.localPath !== undefined && payloadBefore.origin !== undefined],
        ['零损失：a2 的 items+detail 逐字节不变（条目层跟着子树走）',
          JSON.stringify(itemBefore) === JSON.stringify(itemAfter) && itemBefore !== null],
        ['三级 assoc 不参与（成员在被移子树里的那篇逐字节不变）',
          JSON.stringify(assocBefore) === JSON.stringify(assocAfter) && assocAfter !== null],
        ['盘上文件真的变了（对照组：证明上面"写了"不是恒真）', hAfter !== h0],
        ['写盘闸门仍绿（CLI validate 退出码 0 —— 没造出悬挂/坏数据）', validateOk === true],
        ['回读重建：界面 a.parent == b 且数据序 == 渲染序（b1 在前、a 在后）',
          ui.aParent === B && JSON.stringify(ui.bKidsData) === JSON.stringify(['b1', A])
          && JSON.stringify(renderOrder) === JSON.stringify(['b1', A])],
        ['重挂路径自己**没有新增**脏标记（写前 == 写后同一档；expand_all 的视图归一那点脏是既有的，不是重挂加的）', dirtyAfter === dirtyBefore],
        ['状态栏报了成功（setStatus 记录里有成功文案 —— 最后一屏会被 own-write 通知顶掉，故看记录不看最后一屏）',
          Array.isArray(statusLog) && statusLog.some((t) => /已把.*挂到新的父节点下/.test(String(t)))],
        ['留痕：确认放行的 (id, 目标父) 就是真发出去的那一对',
          calls.length === 1 && calls[0].id === A && calls[0].parent === B && calls[0].ok === true]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '入口=' + JSON.stringify({ label: entry.label, self: entry.self }) + ' · 档位=' + kind
          + ' · 拖动中=' + JSON.stringify(ghostDuring.reading.st)
          + ' · 确认框文案=' + JSON.stringify((msgs[0] || '').slice(0, 90))
          + ' · 盘上 t1=' + JSON.stringify(t1Kids) + ' b=' + JSON.stringify(bKids)
          + ' · 子树文本相同=' + (subBefore === subAfter) + ' · payload 相同=' + (JSON.stringify(payloadBefore) === JSON.stringify(payloadAfter))
          + ' · items 相同=' + (JSON.stringify(itemBefore) === JSON.stringify(itemAfter))
          + ' · assoc 相同=' + (JSON.stringify(assocBefore) === JSON.stringify(assocAfter))
          + ' · 界面读数=' + JSON.stringify(ui) + ' · 渲染序=' + JSON.stringify(renderOrder)
          + ' · validate=' + (validateOk ? 'ok' : validateText.slice(0, 80))
          + ' · sha256 前/拖动中/取消后/确认后=' + [h0.slice(0, 12), ghostDuring.hDrag.slice(0, 12), hCancel.slice(0, 12), hAfter.slice(0, 12)].join('/')
          + ' · 状态栏=' + JSON.stringify(String(statusAfter).slice(0, 120)) + ' · 脏 前=' + dirtyBefore + ' 后=' + dirtyAfter
          + ' · 状态栏记录=' + JSON.stringify(Array.isArray(statusLog) ? statusLog.slice(-6) : statusLog)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 乙 成环被拒 + 非法父 + 判别力 ================= */
  {
    name: '乙 f·拒绝档（raw 注入点直通写通道，里面仍有 --dry-run 预检）：成环（a 挂到自己的子孙 a1 下）⇒ ok:false + CLI 具体理由（移到自身子树）+ 盘上 sha256 不变；父不存在 ⇒ ok:false + 盘上零改动；判别力：同一条通道同一道预检，合法对（a → c1）成功并真的改了盘上父子关系',
    run: async (ctx) => {
      writeFixture();
      ctx.runCli(['item-add', P, A_ITEMIZED, '--md', '夹具条目一（域 49）。正文一句。']);
      const opened = await openProject(ctx, P);
      if (opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**（不是通过）' };
      await expandAllForDrag(ctx);
      const h0 = sha256(readRaw(P));
      const raw0 = JSON.parse(readRaw(P));
      // ① 成环：把 a 挂到它自己的子孙 a1 下（绕过预览/确认 —— 写通道自己的预检必须拦住）
      const cycle = await ctx.exec('(async function () { var r = await window.MMApp.reparentNodeRaw('
        + JSON.stringify(A) + ',' + JSON.stringify(CYCLE_TARGET) + ');'
        + ' return JSON.stringify({ ok: r.ok, text: r.text }); })()');
      const cycleR = (function () { try { return parseExec(cycle); } catch (e) { return null; } })();
      const hCycle = sha256(readRaw(P));
      const parentsCycle = parentsOf(JSON.parse(readRaw(P)));
      // ② 父不存在
      const badp = await ctx.exec('(async function () { var r = await window.MMApp.reparentNodeRaw('
        + JSON.stringify(A) + ',' + JSON.stringify(NO_SUCH) + ');'
        + ' return JSON.stringify({ ok: r.ok, text: r.text }); })()');
      const badpR = (function () { try { return parseExec(badp); } catch (e) { return null; } })();
      const hBadp = sha256(readRaw(P));
      // ③ 判别力：同一条通道、同一道预检 —— 合法对成功
      const good = await ctx.exec('(async function () { var r = await window.MMApp.reparentNodeRaw('
        + JSON.stringify(A) + ',' + JSON.stringify(C) + ');'
        + ' return JSON.stringify({ ok: r.ok, parent: r.parent, text: String(r.text || "").slice(0, 60) }); })()');
      const goodR = (function () { try { return parseExec(good); } catch (e) { return null; } })();
      await ctx.input.settle({ delayMs: 500 });
      const hGood = sha256(readRaw(P));
      const rawGood = JSON.parse(readRaw(P));
      const parentsGood = parentsOf(rawGood);
      const c1Kids = childrenIds(rawGood, C);      // 合法落点是 **c1** ⇒ a 应是 c1 的孩子（t2 不变）
      const t2Kids = childrenIds(rawGood, T2);
      const subGood = subtreeText(rawGood, A);
      const sub0 = subtreeText(raw0, A);
      const checks = [
        ['夹具打开成功', opened === true],
        ['成环被拒（ok:false 且有原因）', !!cycleR && cycleR.ok === false && typeof cycleR.text === 'string' && cycleR.text.length > 10],
        ['成环报文给**具体理由**（点到"移到自身子树"，不是一句"操作失败"）',
          !!cycleR && /移到自身子树/.test(cycleR.text)],
        ['成环时盘上 sha256 逐字节不变（一条都没写）', hCycle === h0],
        ['成环时父子关系也没动（a 的父还是 t1）', parentsCycle[A] === T1],
        ['父不存在被拒（ok:false）', !!badpR && badpR.ok === false],
        ['拒绝来自**写前预检这道闸**（报文带"写前预检没有通过…未写盘"的闸形状 —— 这一道在渲染层与 CLI 之外；删了它这条必红）',
          !!badpR && /写前预检没有通过/.test(badpR.text) && /未写盘/.test(badpR.text)],
        ['父不存在时报文点名那个 id（照着能改）', !!badpR && badpR.text.indexOf(NO_SUCH) >= 0],
        ['父不存在时盘上 sha256 逐字节不变', hBadp === h0],
        ['判别力：同一条写通道同一道预检，合法对（a → c1）成功 —— 拒绝不是"永远拒绝"',
          !!goodR && goodR.ok === true && goodR.parent === C],
        ['合法档真的改了盘上父子关系（a 的父 == c1、c1 的 children == [a]、t2 仍 == [c1]）—— 对照组',
          parentsGood[A] === C && JSON.stringify(c1Kids) === JSON.stringify([A])
          && JSON.stringify(t2Kids) === JSON.stringify([C]) && hGood !== h0],
        ['合法档同样零损失（被移子树内部逐字节不变）', subGood === sub0 && subGood !== null]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '成环 ⇒ ' + JSON.stringify(cycleR && { ok: cycleR.ok, text: String(cycleR.text || '').slice(0, 130) })
          + ' · 盘上不变=' + (hCycle === h0)
          + ' · 父不存在 ⇒ ' + JSON.stringify(badpR && { ok: badpR.ok, text: String(badpR.text || '').slice(0, 100) })
          + ' · 合法档 ⇒ ' + JSON.stringify(goodR)
          + ' · 盘上 a 的父：前=' + parentsCycle[A] + ' 后=' + parentsGood[A]
          + ' · c1=' + JSON.stringify(c1Kids) + ' · t2=' + JSON.stringify(t2Kids)
          + ' · sha256 前/成环/坏父/合法后=' + [h0.slice(0, 12), hCycle.slice(0, 12), hBadp.slice(0, 12), hGood.slice(0, 12)].join('/')
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 丙 预览·确认 · 渲染层两道的对照 ================= */
  {
    name: '丙 f·预览与确认（渲染层两道闸的对照）：raw 之外走**正常 UI 流**，桩捕获的确认文案 = 预检回执原话；__reparentCalls 只在"真的发出去了"那一拍记账（取消不记）；确认框说清落点与规模（含 N 个节点）',
    run: async (ctx) => {
      writeFixture();
      ctx.runCli(['item-add', P, A_ITEMIZED, '--md', '夹具条目一（域 49）。正文一句。']);
      const opened = await openProject(ctx, P);
      if (opened !== true) return { ok: false, text: '打不开夹具项目 ⇒ **未验证**（不是通过）' };
      await expandAllForDrag(ctx);
      const h0 = sha256(readRaw(P));
      await ctx.exec('window.__mmConfirmMsgs = []; window.MM.__reparentCalls = []; 1');
      await stubConfirm(ctx, false);                       // 这次取消
      await centerNode(ctx, A);
      const entry = await menuItemOf(ctx, A, '挂到别的父节点下');
      if (entry.miss || entry.self !== true) return { ok: false, text: '入口前置失败：' + JSON.stringify(entry).slice(0, 120) + ' ⇒ **未验证**' };
      await ctx.input.click({ x: entry.x, y: entry.y });
      await ctx.input.settle(PAINT);
      const ptA = await pointOf(ctx, A);
      const ptB = await pointOf(ctx, B);
      await ctx.input.mouseDown(ptA);
      await ctx.input.settle(PAINT);
      await ctx.input.moveTo(ptB);
      await ctx.input.settle(PAINT);
      await ctx.input.mouseUp(ptB);
      await ctx.input.settle({ delayMs: 3500 });
      const hCancel = sha256(readRaw(P));
      const msgs = parseExec(await stepExec(ctx, '读确认框文案捕获', 'JSON.stringify(window.__mmConfirmMsgs || [])'));
      const calls = parseExec(await stepExec(ctx, '读重挂调用留痕', 'JSON.stringify(window.MM.__reparentCalls || [])'));
      const rawCancel = JSON.parse(readRaw(P));
      const parentsCancel = parentsOf(rawCancel);
      const checks = [
        ['夹具打开成功', opened === true],
        ['确认框文案说清**落点**（两个 id 都在文案里）',
          msgs.length === 1 && msgs[0].indexOf(A) >= 0 && msgs[0].indexOf(B) >= 0],
        ['确认框文案说清**规模**（含 N 个节点 —— 现算，不是写死）', msgs.length === 1 && /含\s*\d+\s*个节点/.test(msgs[0])],
        ['取消后盘上 sha256 逐字节不变', hCancel === h0],
        ['取消后父子关系没动（a 的父还是 t1）', parentsCancel[A] === T1],
        ['取消**不记**调用留痕（留痕 = "真的发出去了"那一拍，不是"点过按钮"）', calls.length === 0]
      ];
      const fails = checks.filter((c) => !c[1]).map((c) => c[0]);
      return {
        ok: fails.length === 0,
        text: '确认文案=' + JSON.stringify((msgs[0] || '').slice(0, 120)) + ' · 留痕=' + JSON.stringify(calls)
          + ' · 盘上不变=' + (hCancel === h0) + ' · a 的父=' + parentsCancel[A]
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  },

  /* ================= 丁 结构断言 + 收尾 ================= */
  {
    name: '丁 结构断言：写路径唯一 —— 剥注释后 renderer/**.js 里 app.moveNodeParent( 恰好 2 处且都在 app-actions.js（确认版 + 取证版）、app.reparentPreview( 恰好 1 处；jsMind 的 .move_node( 一族 vendor 外 0 命中（判别力 = vendor 里确实有这些 needle）；收尾：清拖动残留、删夹具项目、开回原项目、复位确认桩',
    run: async (ctx) => {
      // —— 结构断言（扫描面 + 剥注释 + needle 是"实现形状"，照域 45 丁的规矩）——
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
      const writeHits = [];
      const previewHits = [];
      scan.forEach((p) => {
        const code = stripComments(fs.readFileSync(p, 'utf8'));
        needles.forEach((n) => { if (code.indexOf(n) >= 0) hits.push(path.relative(rootDir, p) + ' ⇒ ' + n); });
        const rel = path.relative(rootDir, p);
        let at = 0; let idx = code.indexOf('app.moveNodeParent(');
        while (idx >= 0) { at++; idx = code.indexOf('app.moveNodeParent(', idx + 1); }
        if (at) writeHits.push(rel + ' × ' + at);
        if (code.indexOf('app.reparentPreview(') >= 0) previewHits.push(rel);
      });
      const vendor = fs.readFileSync(path.join(rootDir, 'vendor', 'jsmind.js'), 'utf8');
      const vendorHits = needles.filter((n) => vendor.indexOf(n) >= 0);
      const floor = 8;
      const expectedWriter = ['app-actions.js × 2'];
      const expectedPreview = ['app-actions.js'];
      // —— 收尾 ——
      const cleaned = await ctx.exec('(function () {'
        + ' if (window.MM.reparentCancel) window.MM.reparentCancel();'
        + ' if (window.MM.reorderCancel) window.MM.reorderCancel();'
        + ' window.MMApp.setDragMode(false);'
        + ' var g = document.getElementById("tree-reorder-ghost");'
        + ' var dimmed = document.querySelectorAll("jmnode[data-mm-dimmed]").length;'
        + ' return JSON.stringify({ ghost: !!g, dimmed: dimmed, mode: window.MMApp.dragModeActive() }); })()');
      const c = parseExec(cleaned);
      // 收尾顺序：**先切回原项目、再删夹具目录**（切回时若上一段的视图归一留了脏，
      // 桩答"是"= 放弃 —— 夹具马上就删；上一跑实测：带着脏 + false 桩切回 ⇒ openProject 被
      // confirmDiscardIfDirty 拦成 false）。
      await stubConfirm(ctx, true);
      const back = await openProject(ctx, PROJECT_WHEN_ENTERED || 'comnet');
      // 删夹具项目（沙箱夹具目录直接删 —— 与 39/40/47 同一套收尾；自证不存在）
      let removed = false;
      try { fs.rmSync(path.join(projectsDir(), P), { recursive: true, force: true }); removed = true; }
      catch (e) { removed = false; }
      let gone = false;
      try { fs.readFileSync(projectFile(P), 'utf8'); } catch (e) { gone = true; }
      await stubConfirm(ctx, null);
      const leftover = await ctx.exec('(function () { return JSON.stringify({'
        + ' ghost: !!document.getElementById("tree-reorder-ghost"),'
        + ' dimmed: document.querySelectorAll("jmnode[data-mm-dimmed]").length,'
        + ' mode: window.MMApp.dragModeActive() }); })()');
      const lo = parseExec(leftover);
      const checks = [
        ['扫描面够大（≥ ' + floor + ' 个第一方 js）—— 掉到个位数说明扫描面搭错了', scan.length >= floor],
        ['jsMind 的 .move_node( 一族在 vendor 外 **0 命中**（渲染层没有第二份 move 实现）', hits.length === 0],
        ['判别力：vendor 里命中 ' + vendorHits.length + '/' + needles.length + ' 个 needle（证 needle 是真的，判据不空转）', vendorHits.length === needles.length],
        ['写通道 moveNodeParent 恰好 2 处且都在 app-actions.js（确认版 + 取证版；别处没有第二条写路径）',
          JSON.stringify(writeHits) === JSON.stringify(expectedWriter)],
        ['预览口 reparentPreview 恰好 1 处（app-actions.js；UI 只有一条预览路径）',
          JSON.stringify(previewHits) === JSON.stringify(expectedPreview)],
        ['清掉拖动残留（ghost / dimmed / 模式）', c.ghost === false && c.dimmed === 0 && c.mode === false],
        ['夹具项目目录已删（沙箱夹具直删；自证不存在）', removed === true && gone === true],
        ['开回原项目 + 确认桩已复位', back === true && STUB_INSTALLED === false],
        ['收尾后无残留', lo.ghost === false && lo.dimmed === 0 && lo.mode === false]
      ];
      const fails = checks.filter((ch) => !ch[1]).map((ch) => ch[0]);
      return {
        ok: fails.length === 0,
        text: '扫描面=' + scan.length + ' · move_node 命中=' + hits.length
          + ' · vendor needle=' + vendorHits.length + '/' + needles.length
          + ' · 写通道=' + JSON.stringify(writeHits) + ' · 预览口=' + JSON.stringify(previewHits)
          + ' · 删夹具=' + removed + '/' + gone + ' · 开回=' + back + ' · 桩复位=' + (STUB_INSTALLED === false)
          + (fails.length ? ' ✗ 不成立：' + fails.join(' / ') : ' · 判据全成立')
      };
    }
  }

];

module.exports = assertions;
