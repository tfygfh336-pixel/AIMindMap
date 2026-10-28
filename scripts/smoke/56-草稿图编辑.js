/* ============================================================
 * scripts/smoke/56-草稿图编辑.js — 草稿图窗口的**编辑**（`W11 a–e` 的 `b「允许完整编辑」`）
 * ------------------------------------------------------------
 * 本域钉住六件事，每一件都同时取**两个来源**的读数（页面自报 vs 主进程权威副本 / 主进程导出）：
 *   1) **能改标题**：真 UI 路径（点工具栏「编辑节点」→ 改标题 → 点「保存」）⇒
 *      页面树变了 **且** 主进程内存里那份权威副本的根标题也变了（后者才是「并入」会用的那份）；
 *      顺带判 **能力的显式分层**在 DOM 上真的发生了（草稿窗的编辑框里**没有**标签/展开两格）；
 *   2) **能改正文**：改 detail ⇒ 主进程那条**导出路径**写出的 json 里有这段正文（不读页面自报）；
 *   3) **能加节点**：点「＋子节点」⇒ 页面节点数 +1、主进程 `nodes` +1（两个来源都变）；
 *   4) **能删节点**：点「删除」⇒ 两边的节点数都回到加之前，**并且状态栏文案是
 *      「已删除：<删前的真标题>」**（读页面状态栏元素的 `textContent`；2026-10-22 之前这里
 *      写着"本条不判文案：那是既存缺陷 `已删除：undefined`、按原样保留"—— 那正是它活下来的原因）；
 *   5) **能移动**：① 同级 ↓ 交换顺序（页面读数与主进程导出 json 的顺序都变）
 *      ② 「移到…」改挂父（导出 json 里父子关系真的变了，且根下面不再有它）；
 *   6) **草稿仍然不落盘**：整段编辑期间项目 JSON 的 sha256 与项目目录文件清单**一个字节都没变**，
 *      且草稿的决定性 id 前缀在盘上零命中。
 *
 * ⚠️ 为什么非要"两个来源"：只看页面自报的话，"界面改了、主进程那份没改"这种缺陷**完全看不见** ——
 *    而那正是最坏的形态（人改了半天，点「并入」进去的还是旧树）。
 * ⚠️ 为什么必须判**能力的 DOM 形状**：能力位写着 `editTags:false`、框里却还有那一格 = 骗人
 *    （改完一并入就被 `normalize` 丢掉）。这条用 `#edit-tags` 那一格是否隐藏来判。
 * ⚠️ 样本为什么要"有名字"：两个都叫「新节点」的兄弟判不出"顺序"也判不出"谁挂谁下面"
 *    （`W9` 栽过的"样本让判据永不触发"）。所以本域先给子节点起名「甲」「乙」再移动。
 * ⚠️ V1 要求：凡名字里声称"可见/显示"的判据必须有 `elementFromPoint` 或 rect 真判据 ——
 *    本域对五处用了真命中测试（工具栏「编辑节点」/ 编辑框 / 新节点 / 「↓」按钮 / 「确认移动」按钮）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJ = 'book-wifi7';      // 小样本（域 54/55 同款）：内容不会被屏幕工作区夹住
let ENTRY_PROJECT = '';
let SNAP0 = null;
let FP = '';                    // 草稿窗指纹（**编辑会改内容 ⇒ 指纹会变**，每次现问主进程要）
let BASE_NODES = 0;             // 开窗时主进程那份的节点数
let BASE_TOPIC = '';
/** 真键盘打进草稿窗正文的那串字（纯 ASCII 字母数字：`char` 事件对 `<` `>` 依赖键盘布局，
 *  用它们会把"判据坏"与"输入法/布局不一样"混在一起） */
const TOKEN56 = 'draftRealDetailQ7';

/** 草稿窗那个 **BrowserWindow**（真输入要它：`ctx.input` 绑的是主窗）。
 *  `ctx.draft` 只给读数/执行口，不给窗口句柄 ⇒ 从 `BrowserWindow.getAllWindows()` 里认；
 *  认不出来就返回 null，由调用方**响亮判红**（不许静默退化成"设 value"）。 */
function draftWindowOf(ctx) {
  let BrowserWindow = null;
  try { BrowserWindow = require('electron').BrowserWindow; } catch (e) { return null; }
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return null;
  const others = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed() && w !== ctx.win);
  const titled = others.filter((w) => {
    try { return /草稿图/.test(String(w.getTitle() || '')); } catch (e) { return false; }
  });
  return titled[0] || others[0] || null;
}

/** 用**同一个** `scripts/smoke-input.js` 给草稿窗造一个真输入驱动（不新写第二套实现）。
 *  `isSmoke` 从主窗那个驱动**继承**（不硬编码 true）：非冒烟路径下这里必须抛。 */
function draftInputDriver(ctx) {
  const win = draftWindowOf(ctx);
  if (!win) return { ok: false, text: '拿不到草稿窗的 BrowserWindow（ctx.draft.list() 有 '
    + ctx.draft.list().length + ' 张）⇒ 真输入无从发起，判红' };
  try {
    const driver = require('../smoke-input.js').createDriver({
      isSmoke: !!(ctx.input && ctx.input.isSmoke === true),
      win: win
    });
    return { ok: true, driver: driver };
  } catch (e) {
    return { ok: false, text: '造草稿窗真输入驱动失败：' + ((e && e.message) || e) };
  }
}

/** 两段文本的**插入段**（最长公共前缀 + 最长公共后缀夹出来的那一段）。
 *  真键盘插在**光标处**（点格子中心 ⇒ 常在正文中间），"末尾多了什么"不是这次的改动。 */
function draftDiffInserted(a, b) {
  const A = String(a == null ? '' : a), B = String(b == null ? '' : b);
  let p = 0;
  while (p < A.length && p < B.length && A.charAt(p) === B.charAt(p)) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p
    && A.charAt(A.length - 1 - s) === B.charAt(B.length - 1 - s)) s++;
  return B.slice(p, B.length - s);
}

function execJson(ctx, js) {
  return ctx.exec(js).then((raw) => {
    try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
  });
}

/** 在**草稿窗**里跑一段 JS。⚠️ 指纹会被编辑改掉 ⇒ 每次现问主进程要当前那张窗的 fp。 */
function currentFp(ctx) {
  const list = ctx.draft.list();
  if (!list.length) return '';
  return list[list.length - 1].fp;
}

function draftExec(ctx, js) {
  const fp = currentFp(ctx);
  if (!fp) return Promise.reject(new Error('没有草稿窗'));
  return ctx.draft.exec(fp, js);
}

function draftJson(ctx, js) {
  return draftExec(ctx, js).then((raw) => {
    try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
  });
}

async function waitDraft(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 60); i++) {
    try { last = await draftExec(ctx, js); } catch (e) { return { ok: false, text: 'err:' + ((e && e.message) || e) }; }
    try { if (JSON.parse(last).ok) return JSON.parse(last); } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  try { return JSON.parse(last); } catch (e) { return { ok: false, text: String(last).slice(0, 300) }; }
}

function sha256File(p) {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return '?(读不到: ' + ((e && e.code) || e) + ')'; }
}

function listFiles(dir, base, out) {
  const acc = out || [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) listFiles(path.join(dir, e.name), rel, acc);
    else acc.push(rel);
  }
  return acc;
}

function snapProject(proj) {
  const base = path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', proj);
  const dataFile = path.join(base, proj + '.json');
  const files = listFiles(base, '', []).filter((f) => f !== '.ui-state.json').sort();
  return { base: base, dataFile: dataFile, files: files, sha: sha256File(dataFile) };
}

async function openProject(ctx, name) {
  const r = await ctx.exec(`(async function () {
    try {
      var MM = window.MM;
      if (MM && MM.setConfirmStub) MM.setConfirmStub(function () { return true; });
      await Promise.race([
        Promise.resolve(window.MMApp.openProject(${JSON.stringify(name)})).then(function () { return 'opened'; },
          function (e) { return 'rejected:' + ((e && e.message) || e); }),
        new Promise(function (res) { setTimeout(function () { res('timeout'); }, 15000); })
      ]);
      if (MM && MM.setConfirmStub) MM.setConfirmStub(null);
      var now = window.MMApp.getState().project;
      return JSON.stringify({ ok: !!now && now.name === ${JSON.stringify(name)} });
    } catch (e) { return JSON.stringify({ ok: false, text: 'err:' + ((e && e.message) || e) }); }
  })()`);
  await new Promise((res) => setTimeout(res, 400));
  try { return JSON.parse(r); } catch (e) { return { ok: false, text: String(r).slice(0, 200) }; }
}

/** 在主图里选中一棵小子树（域 55 同款：深度 ≥ 2、避开与顶层主题重名） */
function pickSubtreeJs(lo, hi) {
  return `(function () {
    var st = window.MMApp.getState();
    var ad = window.MM.adapter;
    var root = ad.getRoot(st.jm);
    function count(n) { var k = 1; (n.children || []).forEach(function (c) { k += count(c); }); return k; }
    var rootTopics = {};
    (root.children || []).forEach(function (c) { rootTopics[String(c.topic)] = 1; });
    var best = null;
    (function walk(n, d) {
      if (!n) return;
      if (d >= 2 && String(n.id) !== 'root' && !rootTopics[String(n.topic)]) {
        var k = count(n);
        if (k >= ${lo} && k <= ${hi}) {
          if (!best || d < best.depth) best = { id: String(n.id), topic: String(n.topic || n.id), size: k, depth: d };
        }
      }
      (n.children || []).forEach(function (c) { walk(c, d + 1); });
    })(root, 1);
    if (!best) return JSON.stringify({ ok: false, text: '没有尺寸落在 [${lo},${hi}] 的子树' });
    if (window.MM && window.MM.expandAncestors) { try { window.MM.expandAncestors(st.jm, best.id); } catch (e) {} }
    ad.selectNode(st.jm, best.id);
    var sel = ad.getSelected(st.jm);
    return JSON.stringify({ ok: true, id: best.id, topic: best.topic, size: best.size,
      selOk: !!(sel && String(sel.id) === best.id) });
  })()`;
}

function clickNewDraftMenu() {
  let Menu = null;
  try { Menu = require('electron').Menu; } catch (e) { Menu = null; }
  if (!Menu || !Menu.getApplicationMenu) return { ok: false, text: '拿不到 Menu' };
  const item = Menu.getApplicationMenu().getMenuItemById('menu-new-draft');
  if (!item) return { ok: false, text: '菜单里没有 menu-new-draft' };
  if (item.enabled === false) return { ok: false, text: 'menu-new-draft 是灰的' };
  item.click();
  return { ok: true, text: '已点「' + item.label + '」' };
}

async function waitDraftCount(ctx, want, tries) {
  let last = [];
  for (let i = 0; i < (tries || 60); i++) {
    last = ctx.draft.list();
    if (last.length === want) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

/** 主进程内存里那份权威副本的读数（`list()` 现算，**不读页面**） */
function authoritative(ctx) {
  const list = ctx.draft.list();
  if (!list.length) return { ok: false };
  const w = list[list.length - 1];
  return { ok: true, fp: w.fp, nodes: w.nodes, depth: w.depth, rootTopic: w.rootTopic };
}

/** 走**主进程那条导出路径**把当前草稿写成 json（= 「并入」会用的那份内容），解析回来给断言用 */
function exportJson(ctx) {
  const fp = currentFp(ctx);
  const out = path.join(os.tmpdir(), 'mm-smoke56-' + Date.now() + '.json');
  const r = ctx.draft.exportTo(fp, 'json', out);
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); } catch (e) { text = ''; }
  try { fs.unlinkSync(out); } catch (e) { /* 清不掉不影响结论 */ }
  if (!r || r.ok === false) return { ok: false, text: '导出失败：' + JSON.stringify(r).slice(0, 200) };
  try { return { ok: true, tree: JSON.parse(text), raw: text }; }
  catch (e) { return { ok: false, text: '导出的 json 解析不了：' + ((e && e.message) || e) }; }
}

function findInTree(tree, topic) {
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (String(n.topic) === String(topic)) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(tree);
  return hit;
}

function countNodes(tree) {
  let n = 0;
  (function walk(x) { n += 1; (x.children || []).forEach(walk); })(tree);
  return n;
}

/** 把页面里的编辑框 / 移动面板收干净（残留模态会跨断言存活 —— 本工程的既有纪律） */
async function closeDialogs(ctx) {
  try {
    await draftExec(ctx, '(function () { var d = document.getElementById("edit-dialog");'
      + ' if (d && d.style.display === "flex") document.getElementById("edit-cancel").click();'
      + ' var m = document.getElementById("move"); if (m) m.classList.remove("on"); return 1; })()');
  } catch (e) { /* 窗没了也无所谓 */ }
}

/** 页面现算读数（含能力位 / 对话框状态 / 节点扁平清单） */
function pageRead(ctx) {
  return draftJson(ctx, '(function () { var r = window.MM.draftEditor();'
    + ' return JSON.stringify({ ok: !!r, r: r }); })()');
}

const assertions = [
  {
    name: '草稿窗能改标题：点「编辑节点」→ 改标题 → 保存 ⇒ 页面标题变、主进程权威副本的根标题也变；且编辑框里没有标签/展开两格',
    run: async (ctx) => {
      if (!ctx.draft) return { ok: false, text: 'ctx.draft 不可用' };
      const cur = await execJson(ctx, '(function(){var p=window.MMApp.getState().project;return JSON.stringify({name:p?p.name:""});})()');
      ENTRY_PROJECT = cur.name || '';
      if (cur.name !== PROJ) {
        const o = await openProject(ctx, PROJ);
        if (!o.ok) return { ok: false, text: '切不到 ' + PROJ + '：' + JSON.stringify(o) };
      }
      SNAP0 = snapProject(PROJ);            // ★ 第 6 条的比对基准：开任何草稿窗之前
      const picked = await execJson(ctx, pickSubtreeJs(1, 3));
      if (!picked.ok) return { ok: false, text: '挑不到 ≤3 节点的子树：' + JSON.stringify(picked) };
      if (!picked.selOk) return { ok: false, text: '选中没生效（期望 ' + picked.id + '）' };
      const clicked = clickNewDraftMenu();
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const list = await waitDraftCount(ctx, 1);
      if (list.length !== 1) return { ok: false, text: '草稿窗数量=' + list.length };
      FP = list[0].fp;
      const ready = await waitDraft(ctx, '(function () { var s = window.MM.draftEditor ? window.MM.draftEditor() : null;'
        + ' return JSON.stringify({ ok: !!(s && s.dialog), caps: s ? s.capabilities : null }); })()', 60);
      if (!ready.ok) return { ok: false, text: '草稿页没有 draftEditor 读数口：' + JSON.stringify(ready).slice(0, 200) };

      const auth0 = authoritative(ctx);
      BASE_NODES = auth0.nodes;
      BASE_TOPIC = auth0.rootTopic;

      // ---- 真判据①：工具栏那个按钮真的点在它自己身上（不是被盖住） ----
      const hitBtn = await draftJson(ctx, `(function () {
        var b = document.getElementById('btn-edit');
        var r = b.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return JSON.stringify({ ok: !!(at && at.closest && at.closest('button') === b), w: Math.round(r.width), h: Math.round(r.height) });
      })()`);
      if (!hitBtn.ok) return { ok: false, text: '「编辑节点」按钮中心点命不中它自己：' + JSON.stringify(hitBtn).slice(0, 200) };

      // ---- 选中根节点（页面自己的选中记账）⇒ 点「编辑节点」 ----
      const opened = await draftJson(ctx, `(function () {
        var rid = window.MM.draftEditor().rootId;
        var root = document.querySelector('jmnode[nodeid="' + rid + '"]');
        if (!root) return JSON.stringify({ ok: false, text: '页面上找不到根节点 ' + rid });
        root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('btn-edit').click();
        var s = window.MM.draftEditor().dialog;
        return JSON.stringify({ open: s.open, fields: s.visibleFields, topic: s.topic, caps: s.capabilities });
      })()`);
      if (!opened.open) return { ok: false, text: '点了「编辑节点」但框没开：' + JSON.stringify(opened).slice(0, 240) };

      // ---- 真判据②：编辑框**真的**在屏上（中心点命中的是框里的东西） ----
      const hitBox = await draftJson(ctx, `(function () {
        var box = document.querySelector('#edit-dialog .mm-ed-box');
        if (!box) return JSON.stringify({ ok: false, text: '没有 .mm-ed-box' });
        var r = box.getBoundingClientRect();
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var at = document.elementFromPoint(cx, cy);
        return JSON.stringify({ ok: !!(at && box.contains(at)), w: Math.round(r.width), h: Math.round(r.height),
          at: at ? at.tagName : 'null' });
      })()`);

      // ---- 能力分层的 **DOM 形状**：草稿窗的框里没有标签/展开两格 ----
      const fields = (opened.fields || []).slice().sort().join(',');
      const fieldsOk = fields === 'detail,topic';
      if (!opened.caps || opened.caps.assets !== false || opened.caps.save !== false) {
        return { ok: false, text: '能力位不对（草稿窗不该有 assets/save）：' + JSON.stringify(opened.caps) };
      }

      // ---- 改标题 + 保存 ----
      const newTopic = String(auth0.rootTopic) + '·改';
      await draftJson(ctx, `(function () {
        document.getElementById('edit-topic').value = ${JSON.stringify(newTopic)};
        document.getElementById('edit-ok').click();
        return JSON.stringify({ ok: true });
      })()`);
      const after = await waitDraft(ctx, `(function () { var s = window.MM.draftPageState();`
        + ` return JSON.stringify({ ok: s.rootTopic === ${JSON.stringify(newTopic)} && s.status.indexOf('已回滚') < 0, rootTopic: s.rootTopic, status: s.status }); })()`, 60);
      const auth1 = authoritative(ctx);
      const pageSays = after.rootTopic === newTopic;
      const mainSays = auth1.rootTopic === newTopic;
      const fpChanged = auth1.fp !== auth0.fp;
      return {
        ok: hitBtn.ok && opened.open && hitBox.ok && fieldsOk && pageSays && mainSays && fpChanged && auth1.nodes === BASE_NODES,
        text: '按钮命中=' + hitBtn.ok + '（' + hitBtn.w + '×' + hitBtn.h + '）框开=' + opened.open
          + ' 框命中自身=' + hitBox.ok + '（' + hitBox.w + '×' + hitBox.h + ' 命中=' + hitBox.at + '）'
          + ' ｜ 框里可见字段=' + (fields || '（无）') + '（期望 detail,topic ⇒ ' + fieldsOk + '）'
          + ' ｜ 能力位 assets/save=false ⇒ ' + (opened.caps.assets === false && opened.caps.save === false)
          + ' ｜ 改后标题 页面=' + JSON.stringify(after.rootTopic) + ' 主进程=' + JSON.stringify(auth1.rootTopic)
          + ' ⇒ 页面对=' + pageSays + ' 主进程对=' + mainSays + ' 指纹变了=' + fpChanged
          + '（' + String(auth0.fp).slice(0, 8) + '→' + String(auth1.fp).slice(0, 8) + '）'
          + ' 节点数 ' + BASE_NODES + '→' + auth1.nodes
      };
    }
  },
  {
    name: '草稿窗能改正文：**真键盘**逐字打进「详情」格（不是设 value）⇒ 焦点在格子上、.value 真的变、'
      + 'Enter 是**换行**不是关框 ⇒ 保存后主进程那条导出路径写出的 json 里有这段正文（不读页面自报）',
    run: async (ctx) => {
      if (!FP) return { ok: false, text: '上一条没开出草稿窗（顺序依赖）' };
      await closeDialogs(ctx);
      /* ⚠️ 本条是 2026-10-26 改的，改的是**判据本身**，理由在用户原话里：
       *   「编辑节点详情功能有问题，不能输入，**你的测试形同虚设**」。
       * 改前这里是 `document.getElementById('edit-detail').value = X` 一次性设值、再读回来比 ——
       * 那种写法**整条绕过** Chromium 的输入管线（命中测试 / 焦点 / 键盘 / 输入法）：
       *   格子是 readOnly、被别的层盖住、在屏幕外、`input` 事件根本没接，断言**照样绿**。
       * 实测证据（本批注入实验）：给 `#edit-detail` 加 `readonly` 之后，
       *   · `focus()` **仍然成功**、`elementFromPoint` **仍然命中它自己**、
       *   · 只有"真键盘打字"会让 `.value` 不动 ⇒ `value = X` 那套判据**永远发现不了**。
       * ⇒ 现在走 `webContents.sendInputEvent`（真鼠标 / 真键盘），并额外钉住 **Enter 的语义**：
       *   正文格里的 Enter 必须是换行（改前它会把整个框关掉并保存 ⇒ 多行正文永远打不出来，
       *   中文输入法"选词上屏"那一下也是 Enter ⇒ 用户看到的"不能输入"）。
       * ⚠️ 草稿窗是**另一个 BrowserWindow**，`ctx.input` 绑的是主窗 ⇒ 这里用
       *   `BrowserWindow.getAllWindows()` 找到它，再用**同一个** `scripts/smoke-input.js`
       *   造一个驱动（不新写第二套真输入实现）。 */
      // 选一个非根节点（更像真人操作；根也能改，但不该只测根）⇒ 点「编辑节点」开框
      const sel = await draftJson(ctx, `(function () {
        var flat = window.MM.draftEditor().nodesFlat;
        var rid = window.MM.draftEditor().rootId;
        var other = null;
        for (var i = 0; i < flat.length; i++) if (flat[i].id !== rid) { other = flat[i]; break; }
        if (!other) return JSON.stringify({ ok: false, text: '这棵草稿只有一个节点' });
        var el = document.querySelector('jmnode[nodeid="' + other.id + '"]');
        if (!el) return JSON.stringify({ ok: false, text: '那个节点没有 jmnode' });
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('btn-edit').click();
        return JSON.stringify({ ok: document.getElementById('edit-dialog').style.display === 'flex',
          id: other.id, topic: other.topic });
      })()`);
      if (!sel.ok) return { ok: false, text: '打不开第二个节点的编辑框：' + JSON.stringify(sel).slice(0, 200) };
      if (!ctx.input) return { ok: false, text: 'ctx.input 不可用（真输入底座没起来 ⇒ 采不到真值，判红）' };
      const drv = draftInputDriver(ctx);
      if (!drv.ok) return { ok: false, text: drv.text };
      // ── 格子的几何 + 命中（真点之前先证明"这个点此刻压的就是它"）──
      /* 【2026-10-28 本批：这一处 `scrollIntoView` 降级也删了 —— 与「保存」那一跳同一条纪律】
       * 原来量之前先 `ta.scrollIntoView({ block: 'center' })` 把正文格滚进可见区，当时的理由是
       * 「小窗里正文格本来就在折叠线以下，真人也要先滚」。现在动作行改成**固定底栏**
       * （`.mm-ed-box` 是 flex 列：h3 固定 + `.mm-ed-body` 滚 + 动作行固定）之后，这个理由不成立了：
       *
       *   实测（本批 SMOKE_ONLY=56 的两次读数，同一份代码只差这一行）：
       *     · 滚过：中心 {379,129} —— `elementFromPoint` 命中 `TEXTAREA#edit-detail`
       *     · 不滚：中心 {395,171} —— **同样命中**（视口 805×257，格子 625×95 ⇒ 打开时就整块在视口内）
       *   ⇒ 那次滚动买到的东西是 **0**，而它让判据量的是"滚过之后的某个状态"而不是
       *     "打开编辑框之后的自然状态"。删掉之后判据更直接，一个字都没少：
       *     必须命中格子自己、必须真点、真键盘逐字、Enter 必须是换行。
       * （同一条纪律见「保存」那一跳：**用断言证明它在视口内，而不是先滚一滚再断言**。） */
      const taGeom = await draftJson(ctx, `(function () {
        var ta = document.getElementById('edit-detail');
        var body = document.querySelector('#edit-dialog .mm-ed-body');
        if (!ta) return JSON.stringify({ ok: false, text: '没有 #edit-detail' });
        var r = ta.getBoundingClientRect();
        return JSON.stringify({ ok: true, scroller: body ? Math.round(body.clientHeight) : null,
          top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight });
      })()`);
      const g = await draftJson(ctx, `(function () {
        var ta = document.getElementById('edit-detail');
        if (!ta) return JSON.stringify({ ok: false, text: '没有 #edit-detail' });
        var r = ta.getBoundingClientRect();
        var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        var at = document.elementFromPoint(x, y);
        return JSON.stringify({ ok: true, x: x, y: y, w: Math.round(r.width), h: Math.round(r.height),
          at: at ? (at.tagName + (at.id ? '#' + at.id : '')) : 'null', hit: !!(at && at.id === 'edit-detail'),
          readOnly: !!ta.readOnly, before: String(ta.value == null ? '' : ta.value) });
      })()`);
      if (!g.ok) return { ok: false, text: g.text || JSON.stringify(g).slice(0, 200) };
      if (!g.hit) {
        return { ok: false, text: '正文格中心命中=' + g.at + '（不是格子自己 ⇒ 被别的层盖住 / 不在屏上）'
          + ' ｜ 未滚动时的 rect=' + JSON.stringify({ top: taGeom.top, bottom: taGeom.bottom })
          + ' 视口高=' + taGeom.vh + ' 正文区高=' + taGeom.scroller };
      }
      // ── 真鼠标点进格子 + 真键盘逐字 ──
      await drv.driver.click({ x: g.x, y: g.y });
      await drv.driver.settle();
      const focused = await draftJson(ctx, '(function () { var a = document.activeElement;'
        + ' return JSON.stringify({ ok: true, active: a ? (a.id || a.tagName) : "none" }); })()');
      await drv.driver.typeText(TOKEN56);
      await drv.driver.settle({ delayMs: 120 });
      const typed = await draftJson(ctx, '(function () { var ta = document.getElementById("edit-detail");'
        + ' return JSON.stringify({ ok: true, value: String(ta.value == null ? "" : ta.value) }); })()');
      // ── 真的按一下 Enter（三段：keyDown + char + keyUp，缺一段字符层什么都不插）──
      await drv.driver.sendList([
        { type: 'keyDown', keyCode: 'Return', modifiers: [] },
        { type: 'char', keyCode: '\r' },
        { type: 'keyUp', keyCode: 'Return', modifiers: [] }
      ], 0);
      await drv.driver.settle({ delayMs: 150 });
      const afterEnter = await draftJson(ctx, '(function () {'
        + ' var d = document.getElementById("edit-dialog"); var ta = document.getElementById("edit-detail");'
        + ' return JSON.stringify({ ok: true, open: !!(d && d.style.display === "flex"),'
        + ' value: String(ta.value == null ? "" : ta.value),'
        + ' active: (document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none") }); })()');
      // ── 点「保存」：**先证明它在视口内**，再真点（滚动兜底已删 —— 见下面这段）──
      /* 【ROADMAP 第 73 行的落点 · 2026-10-28 本批】
       * UI 批已把草稿窗的动作行改成**始终在视口内**（`.mm-ed-box` 现在是 flex 列：
       * h3 固定 + `.mm-ed-body` 滚 + 动作行固定；`renderer/draft-map.html` 里那条注释为证）——
       * 所以冒烟里那次「点不中就 `scrollIntoView` 把按钮**滚进视口**再点」的**降级必须删掉**：
       * 留着它，"碰巧还在"与"保证了在"在断言上**分不出来**，而那正是 ROADMAP 那一条要治的东西。
       *
       * 现在这一跳的判据是**直接断言几何**，两条都要（缺一条都不算合格）：
       *   ① `edit-ok` 的矩形**完全落在视口矩形内**（left/top ≥ 0 且 right/bottom ≤ 视口宽高）；
       *   ② 真点之前仍然对按钮中心做命中测试（H2：rect 对"被裁掉 / 被压住"是盲的）。
       * ⚠️ 依据（改前的实测，不是猜）：草稿窗按内容定尺寸，视口只有 **805×251** 量级，
       *    按钮矩形曾落在 t=290 ⇒ **视口外**。删掉兜底后这里若判红，**不是判据太严，
       *    是草稿窗布局真的没修好**（`renderer/draft-map.html` 不在本批边界 ⇒ 只如实报告）。 */
      const saveBtnPoint = () => draftJson(ctx, '(function () { var b = document.getElementById("edit-ok");'
        + ' if (!b) return JSON.stringify({ err: "没有 #edit-ok" });'
        + ' var r = b.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;'
        + ' var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);'
        + ' var at = document.elementFromPoint(x, y);'
        + ' var inView = r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;'
        + ' return JSON.stringify({ x: x, y: y, inView: inView,'
        + '   hit: !!(at && (at === b || (at.closest && at.closest("button") === b))),'
        + '   at: at ? (at.tagName + (at.id ? "#" + at.id : "") + (at.className ? "." + at.className : "")) : "null",'
        + '   rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },'
        + '   vw: vw, vh: vh }); })()');
      const okPt = await saveBtnPoint();
      /* 真鼠标只在**几何与命中都成立**时发：几何不成立时那个坐标可能压着别的控件，
       * 盲点下去会制造与判据无关的副作用（甚至误触别的按钮）。 */
      const realClick = !!(okPt && okPt.inView && okPt.hit);
      if (realClick) { await drv.driver.click({ x: okPt.x, y: okPt.y }); await drv.driver.settle(); }
      /* 兜底只剩**一条**，而且它不是"点的兜底"：真点没成立时用 `el.click()` 把这一跳走完，
       * 好让后面的判据（页面树 / 导出 / 权威副本）仍然跑出读数 —— 报文里写清"真点没成立"，
       * `realClick` 在最终 `ok` 的合取里 ⇒ 这一条照样红。
       * 为什么**不留**滚动兜底：那等于把"保证在视口内"换成"滚一滚总能点到"，契约就没了 ✗。 */
      if (!realClick) await draftExec(ctx, '(function () { document.getElementById("edit-ok").click(); return 1; })()');
      const page = await waitDraft(ctx, `(function () {
        var t = window.MM.draftPageTree();
        var hit = null;
        (function walk(n) { if (!n || hit) return; if (String(n.topic) === ${JSON.stringify(sel.topic)}) { hit = n; return; } (n.children || []).forEach(walk); })(t);
        return JSON.stringify({ ok: !!(hit && String(hit.detail || '').indexOf(${JSON.stringify(TOKEN56)}) >= 0),
          detail: hit ? String(hit.detail || '') : '(没找到那个节点)' });
      })()`, 60);
      const ex = exportJson(ctx);
      if (!ex.ok) return { ok: false, text: ex.text };
      const node = findInTree(ex.tree, sel.topic);
      const inExport = !!(node && String(node.detail || '').indexOf(TOKEN56) >= 0);
      const auth = authoritative(ctx);
      const nodesMatch = auth.nodes === BASE_NODES;
      const focusOk = focused.active === 'edit-detail';
      const valueChanged = typed.value !== g.before;
      const hasToken = typed.value.indexOf(TOKEN56) >= 0;
      const ins = draftDiffInserted(typed.value, afterEnter.value);
      const newlineOk = ins === '\n' || ins === '\r' || ins === '\r\n';
      const stillOpen = afterEnter.open === true;
      return {
        ok: focusOk && valueChanged && hasToken && stillOpen && newlineOk && realClick && page.ok && inExport && nodesMatch,
        text: '真点中心 {' + g.x + ',' + g.y + '}（' + g.w + '×' + g.h + '，命中=' + g.at + '）⇒ 焦点=' + focused.active
          + '（期望 edit-detail ⇒ ' + focusOk + '）'
          + ' ｜ 真键盘 ' + JSON.stringify(TOKEN56) + '（' + TOKEN56.length + ' 个 char）⇒ .value '
          + g.before.length + ' → ' + typed.value.length + ' 字（变了=' + valueChanged + '、含那串字=' + hasToken + '）'
          + ' ｜ 再按 Enter ⇒ 框还开着=' + stillOpen + '、插进的是换行=' + newlineOk + '（插入段=' + JSON.stringify(ins) + '）'
          + ' ｜ 点「保存」在视口内=' + okPt.inView + '、真点中=' + realClick
          + '（点=' + JSON.stringify({ x: okPt.x, y: okPt.y })
          + ' 命中=' + okPt.at + ' 按钮矩形=' + JSON.stringify(okPt.rect) + ' 视口=' + okPt.vw + '×' + okPt.vh + '）'
          + ' ｜ 页面树认出正文=' + page.ok + '（' + String(page.detail).slice(0, 40) + '…）'
          + ' ｜ 主进程导出 json 里有那串字=' + inExport + ' ｜ 不增删节点=' + nodesMatch
          + '（旧判据是 `value = X` 再读回来比 —— 那种写法在 `readonly` 下照样绿，见本条的注释）'
      };
    }
  },
  {
    name: '草稿窗能加节点：点「＋子节点」⇒ 页面节点数 +1 且主进程权威副本 nodes +1（两个来源同时变，且新节点在屏上可点）',
    run: async (ctx) => {
      if (!FP) return { ok: false, text: '上一条没开出草稿窗（顺序依赖）' };
      await closeDialogs(ctx);
      const before = authoritative(ctx);
      const pb = await pageRead(ctx);
      const pageBefore = pb.r.pageNodes;
      const added = await draftJson(ctx, `(function () {
        var rid = window.MM.draftEditor().rootId;
        var root = document.querySelector('jmnode[nodeid="' + rid + '"]');
        if (!root) return JSON.stringify({ ok: false, text: '找不到根节点' });
        root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('btn-add-child').click();
        var s = window.MM.draftEditor();
        return JSON.stringify({ ok: s.dialog.open, topic: s.dialog.topic, pageNodes: s.pageNodes });
      })()`);
      await closeDialogs(ctx);       // addChild 顺手开编辑框（与主窗同一个语义）⇒ 关掉
      const now = await waitDraft(ctx, `(function () {
        var s = window.MM.draftEditor();
        return JSON.stringify({ ok: s.pageNodes === ${pageBefore + 1}, pageNodes: s.pageNodes });
      })()`, 60);
      const after = authoritative(ctx);
      const nodesOk = after.nodes === before.nodes + 1;
      const topicOk = added.topic === '新节点';
      // 真判据③：新节点在屏上真的是一块可点的矩形
      const hitNew = await draftJson(ctx, `(function () {
        var els = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
        for (var i = 0; i < els.length; i++) {
          if (els[i].textContent === '新节点') {
            var r = els[i].getBoundingClientRect();
            if (!r.width || !r.height) return JSON.stringify({ ok: false, text: '新节点没有几何（0 尺寸）' });
            var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return JSON.stringify({ ok: !!(at && at.closest && at.closest('jmnode[nodeid]') === els[i]),
              w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
        return JSON.stringify({ ok: false, text: '页面里找不到标题为「新节点」的 jmnode' });
      })()`);
      return {
        ok: added.ok && nodesOk && !!now.ok && topicOk && hitNew.ok,
        text: '加子节点：编辑框开=' + added.ok + '（新节点标题=' + JSON.stringify(added.topic) + '）'
          + ' ｜ 页面节点 ' + pageBefore + '→' + now.pageNodes + ' ⇒ ' + !!now.ok
          + ' ｜ 主进程 nodes ' + before.nodes + '→' + after.nodes + ' ⇒ ' + nodesOk
          + ' ｜ 新节点在屏上可点=' + hitNew.ok + '（' + (hitNew.w || '?') + '×' + (hitNew.h || '?') + '）'
      };
    }
  },
  {
    name: '草稿窗能删节点：点「删除」⇒ 两边节点数回到加之前，且**状态栏文案**是「已删除：<删前的真标题>」（不是「已删除：undefined」）',
    run: async (ctx) => {
      if (!FP) return { ok: false, text: '上一条没开出草稿窗（顺序依赖）' };
      await closeDialogs(ctx);
      const before = authoritative(ctx);
      const pb = await pageRead(ctx);
      const pageBefore = pb.r.pageNodes;
      /* 期望值的来源：**点击之前**从页面上读到的真标题（不是代码里的常量，也不是本文件写死的字符串）。
       * 这样"把标题写死成某个字面量"与"标题读错对象"两种错法都判得出来。 */
      const del = await draftJson(ctx, `(function () {
        var els = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
        var target = null;
        for (var i = 0; i < els.length; i++) { if (els[i].textContent === '新节点') { target = els[i]; break; } }
        if (!target) return JSON.stringify({ ok: false, text: '找不到刚加的那个节点' });
        var title = String(target.textContent);
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        var id = target.getAttribute('nodeid');
        var btn = document.getElementById('btn-del');
        var r = btn.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        var pointOk = !!(at && at.closest && at.closest('button') === btn);
        btn.click();
        return JSON.stringify({ ok: pointOk, pointOk: pointOk, id: id, title: title });
      })()`);
      if (!del.ok) return { ok: false, text: '「删除」按钮没点在它自己身上 / 找不到目标：' + JSON.stringify(del).slice(0, 200) };
      const gone = await waitDraft(ctx, `(function () {
        var s = window.MM.draftEditor();
        var els = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
        var still = false;
        for (var i = 0; i < els.length; i++) if (els[i].getAttribute('nodeid') === ${JSON.stringify(del.id)}) still = true;
        return JSON.stringify({ ok: !still && s.pageNodes === ${pageBefore - 1}, pageNodes: s.pageNodes, still: still });
      })()`, 60);
      const after = authoritative(ctx);
      const nodesOk = after.nodes === before.nodes - 1;
      /* ★ 本条**真的判文案**（本批之前这里写着"本条不判文案：那是既存缺陷、按原样保留"）：
       *   `MM.draftPageState().status` 读的是草稿页状态栏元素自己的 `textContent`
       *   （`renderer/draft-map.js` 的 `draftPageState` → `$('status').textContent`），
       *   即**页面上的真实文本**，不是代码里的常量。
       *   判据是**严格相等**：`已删除：<点击前从页面上读到的那串标题>`。
       *   为什么要它：`renderer/editor.js` 的 `deleteNode` 曾经在 `removeNode` **之后**才读
       *   `node.topic`，而 jsMind 的 `remove_node` 会把节点对象的自有字段逐个 `delete`
       *   ⇒ 文案是 `已删除：undefined`，而这个域**当时只把它打印出来、不判** ⇒ 它一直没人管
       *   （它比 `W26` 那次重构更早；`W26` 只是把它记进台账、刻意没修）。
       *   ⚠️ 草稿窗没有项目 ⇒ 没有预检 ⇒ 文案永远**不带**"（并清理 …）"后缀 ⇒ 这里可以用严格相等。 */
      const status = await draftJson(ctx, '(function () { var s = window.MM.draftPageState(); return JSON.stringify({ ok: true, text: s && s.status }); })()');
      const statusText = String(status.text === undefined ? '' : status.text);
      const wantStatus = '已删除：' + String(del.title === undefined ? '' : del.title);
      const statusOk = statusText === wantStatus;
      return {
        ok: gone.ok && nodesOk && statusOk,
        text: '删节点：页面节点 ' + pageBefore + '→' + gone.pageNodes + '（被删的 id 还在 DOM 里=' + gone.still + '）⇒ ' + gone.ok
          + ' ｜ 主进程 nodes ' + before.nodes + '→' + after.nodes + ' ⇒ ' + nodesOk
          + ' ｜ 状态栏=' + JSON.stringify(statusText)
          + '（期望 ' + JSON.stringify(wantStatus) + ' ⇒ ' + statusOk
          + '；不含 undefined=' + (statusText.indexOf('undefined') < 0) + '）'
      };
    }
  },
  {
    name: '草稿窗能移动：① 同级 ↓ 交换顺序（页面与主进程导出 json 的顺序都变）② 「移到…」改挂父（导出 json 的父子关系变了）',
    run: async (ctx) => {
      if (!FP) return { ok: false, text: '上一条没开出草稿窗（顺序依赖）' };
      await closeDialogs(ctx);

      /** 加一个**有名字**的子节点（两个都叫「新节点」判不出顺序与父子 —— 样本必须可区分） */
      const addTitled = (title) => draftJson(ctx, `(function () {
        var rid = window.MM.draftEditor().rootId;
        var root = document.querySelector('jmnode[nodeid="' + rid + '"]');
        if (!root) return JSON.stringify({ ok: false, text: '找不到根节点 ' + rid });
        root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('btn-add-child').click();
        if (document.getElementById('edit-dialog').style.display !== 'flex') return JSON.stringify({ ok: false, text: '「＋子节点」没有开编辑框' });
        document.getElementById('edit-topic').value = ${JSON.stringify('')} || ${JSON.stringify('')};
        document.getElementById('edit-topic').value = ${JSON.stringify(title)};
        document.getElementById('edit-ok').click();
        var flat = window.MM.draftEditor().nodesFlat;
        var hit = null;
        for (var i = 0; i < flat.length; i++) if (flat[i].topic === ${JSON.stringify(title)}) hit = flat[i];
        return JSON.stringify({ ok: !!hit, id: hit ? hit.id : '', topic: hit ? hit.topic : '' });
      })()`);

      /** 等主进程权威副本的节点数追上（两次 push 是串行的，这里等它落定再继续） */
      const waitAuthNodes = async (want) => {
        for (let i = 0; i < 60; i++) {
          const a = authoritative(ctx);
          if (a.ok && a.nodes === want) return a;
          await new Promise((r) => setTimeout(r, 150));
        }
        return authoritative(ctx);
      };

      const a = await addTitled('甲');
      if (!a.ok) return { ok: false, text: '加「甲」失败：' + JSON.stringify(a).slice(0, 200) };
      await waitAuthNodes(BASE_NODES + 1);
      const b = await addTitled('乙');
      if (!b.ok) return { ok: false, text: '加「乙」失败：' + JSON.stringify(b).slice(0, 200) };
      const auth1 = await waitAuthNodes(BASE_NODES + 2);
      if (auth1.nodes !== BASE_NODES + 2) return { ok: false, text: '两个子节点没落到主进程：' + JSON.stringify(auth1) };

      /** 页面现算读数里"根的孩子"的标题序列（**数据顺序**，不是 DOM 顺序） */
      const kidTopics = (r) => (r.nodesFlat || []).filter((n) => n.parent && n.parent === (r.rootId || '')).map((n) => n.topic);
      const p0 = await pageRead(ctx);
      const orderBefore = kidTopics(p0.r || {});

      // ① 同级 ↓：选中「甲」，点「↓」（真命中测试：按钮中心点必须是它自己）
      const swapped = await draftJson(ctx, `(function () {
        var flat = window.MM.draftEditor().nodesFlat;
        var me = null;
        for (var i = 0; i < flat.length; i++) if (flat[i].topic === '甲') me = flat[i];
        if (!me) return JSON.stringify({ ok: false, text: '页面里找不到「甲」' });
        var el = document.querySelector('jmnode[nodeid="' + me.id + '"]');
        if (!el) return JSON.stringify({ ok: false, text: '「甲」没有对应的 jmnode' });
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        var btn = document.getElementById('btn-down');
        var r = btn.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        var pointOk = !!(at && at.closest && at.closest('button') === btn);
        btn.click();
        return JSON.stringify({ ok: pointOk, pointOk: pointOk, id: me.id });
      })()`);
      if (!swapped.ok) return { ok: false, text: '「↓」按钮没点在它自己身上：' + JSON.stringify(swapped).slice(0, 200) };
      const afterDown = await waitDraft(ctx, `(function () {
        var s = window.MM.draftPageState();
        return JSON.stringify({ ok: s.status.indexOf('已移动') >= 0 || s.status.indexOf('没有移动') >= 0, text: s.status });
      })()`, 80);
      const p1 = await pageRead(ctx);
      const orderAfter = kidTopics(p1.r || {});
      const orderChanged = orderAfter.slice(-2).join('|') === '乙|甲';
      // 交叉来源：主进程那份的**导出 json** 里，根的孩子们顺序也必须是换过之后的
      const ex1 = exportJson(ctx);
      if (!ex1.ok) return { ok: false, text: ex1.text };
      const exRootKids = (ex1.tree.children || []).map((c) => String(c.topic));
      const exportOrderOk = exRootKids.slice(-2).join('|') === '乙|甲';

      // ② 改挂：把「甲」移到「乙」下面
      const rep = await draftJson(ctx, `(function () {
        var flat = window.MM.draftEditor().nodesFlat;
        var me = null;
        for (var i = 0; i < flat.length; i++) if (flat[i].topic === '甲') me = flat[i];
        if (!me) return JSON.stringify({ ok: false, text: '页面里找不到「甲」' });
        var el = document.querySelector('jmnode[nodeid="' + me.id + '"]');
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('btn-move').click();
        if (!document.getElementById('move').classList.contains('on')) return JSON.stringify({ ok: false, text: '「移到…」面板没出来' });
        var sel = document.getElementById('move-parent');
        var target = '';
        for (var j = 0; j < sel.options.length; j++) {
          if (String(sel.options[j].textContent).replace(/^[\\s\\u3000]+/, '') === '乙') { target = sel.options[j].value; break; }
        }
        if (!target) return JSON.stringify({ ok: false, text: '候选里没有「乙」：'
          + Array.prototype.map.call(sel.options, function (o) { return o.textContent; }).join(',') });
        sel.value = target;
        var ok = document.getElementById('move-ok');
        var r = ok.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        var pointOk = !!(at && at.closest && at.closest('button') === ok);
        ok.click();
        return JSON.stringify({ ok: pointOk, pointOk: pointOk, target: target, options: sel.options.length });
      })()`);
      if (!rep.ok) return { ok: false, text: '「移到…」那条路没走通：' + JSON.stringify(rep).slice(0, 260) };
      const moved = await waitDraft(ctx, `(function () {
        var s = window.MM.draftPageState();
        return JSON.stringify({ ok: s.status.indexOf('已移动') >= 0 || s.status.indexOf('没有移动') >= 0, text: s.status });
      })()`, 80);
      const ex2 = exportJson(ctx);
      if (!ex2.ok) return { ok: false, text: ex2.text };
      const exNodes = countNodes(ex2.tree);
      const auth = authoritative(ctx);
      const countOk = exNodes === auth.nodes;
      // 改挂的判据（全在**导出树**里现算，不读页面自报）：乙 有孩子 甲；根的孩子里没有 甲
      const yi = findInTree(ex2.tree, '乙');
      const nested = !!(yi && (yi.children || []).some((c) => String(c.topic) === '甲'));
      const rootKids = (ex2.tree.children || []).map((c) => String(c.topic));
      const leftRoot = rootKids.indexOf('甲') < 0;
      return {
        ok: swapped.pointOk && orderChanged && exportOrderOk && moved.ok && nested && leftRoot && countOk,
        text: '① 同级↓：按钮命中=' + swapped.pointOk + ' 回执=' + JSON.stringify(String(afterDown.text).slice(0, 32))
          + ' 根的孩子 ' + JSON.stringify(orderBefore.slice(-2)) + '→' + JSON.stringify(orderAfter.slice(-2))
          + '（期望 乙|甲 ⇒ ' + orderChanged + '）导出 json ' + JSON.stringify(exRootKids.slice(-2)) + ' ⇒ ' + exportOrderOk
          + ' ｜ ② 移到…：按钮命中=' + rep.pointOk + '（候选 ' + rep.options + ' 项）回执=' + JSON.stringify(String(moved.text).slice(0, 32))
          + ' ⇒ 导出树里「乙」下面有「甲」=' + nested + '、根下面没有「甲」=' + leftRoot
          + ' ｜ 节点数 导出=' + exNodes + ' 主进程=' + auth.nodes + ' ⇒ ' + countOk
      };
    }
  },
  {
    name: '草稿窗的能力分层是**显式**的：没有的能力被拒绝时要点名理由，对应的框根本不存在（不是藏起来）',
    run: async (ctx) => {
      if (!FP) return { ok: false, text: '上一条没开出草稿窗（顺序依赖）' };
      await closeDialogs(ctx);
      const r = await draftJson(ctx, `(function () {
        var e = window.MM.draftEditor();
        var statusEl = document.getElementById('status');
        // 1) 图片/附件：能力位 false ⇒ 页面上**根本没有**那个入口，框也**没造**
        var noImg = !document.getElementById('image-dialog');
        var noFile = !document.getElementById('file-dialog');
        // 2) 编辑框里标签 / 展开两格：能力位 false 的**DOM 形状**（连行都隐藏）
        var tags = document.querySelector('#edit-dialog [data-field="tags"]');
        var exp = document.querySelector('#edit-dialog [data-field="expanded"]');
        var hiddenTags = !tags || tags.style.display === 'none';
        var hiddenExp = !exp || exp.style.display === 'none';
        // 3) Ctrl+S / Ctrl+Z 在草稿窗里要**明说没有这件事**，不许静默（设个哨兵先清空状态栏）
        statusEl.textContent = '';
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
        var saveNote = statusEl.textContent;
        statusEl.textContent = '';
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        var undoNote = statusEl.textContent;
        return JSON.stringify({ ok: true, noImg: noImg, noFile: noFile, hiddenTags: hiddenTags, hiddenExp: hiddenExp,
          saveNote: saveNote, undoNote: undoNote, caps: e.capabilities, fields: e.dialog.visibleFields });
      })()`);
      if (!r.ok) return { ok: false, text: '读不到能力读数' };
      const saveNamed = String(r.saveNote || '').indexOf('草稿不落盘') >= 0;
      const undoNamed = String(r.undoNote || '').indexOf('撤销') >= 0;
      const capsOk = r.caps && r.caps.assets === false && r.caps.markdown === false
        && r.caps.undoRedo === false && r.caps.save === false && r.caps.editTags === false
        && r.caps.editExpanded === false && r.caps.addChild === true && r.caps.deleteNode === true
        && r.caps.moveNode === true && r.caps.editTopic === true && r.caps.editDetail === true;
      return {
        ok: r.noImg && r.noFile && r.hiddenTags && r.hiddenExp && saveNamed && undoNamed && !!capsOk,
        text: '图片框/附件框根本不存在=' + r.noImg + '/' + r.noFile
          + ' ｜ 编辑框里标签格隐藏=' + r.hiddenTags + ' 展开格隐藏=' + r.hiddenExp
          + ' ｜ 框里可见字段=' + JSON.stringify(r.fields)
          + ' ｜ Ctrl+S ⇒ ' + JSON.stringify(String(r.saveNote).slice(0, 44)) + '（点名"草稿不落盘"=' + saveNamed + '）'
          + ' ｜ Ctrl+Z ⇒ ' + JSON.stringify(String(r.undoNote).slice(0, 44)) + '（点名"撤销"=' + undoNamed + '）'
          + ' ｜ 能力位=' + JSON.stringify(r.caps)
      };
    }
  },
  {
    name: '编辑之后草稿仍然不落盘：项目 JSON 的 sha256 与项目目录文件清单逐项相同，且草稿 id 前缀盘上零命中',
    run: async (ctx) => {
      if (!SNAP0) return { ok: false, text: '上一条没记下基线（顺序依赖）' };
      const now = snapProject(PROJ);
      const filesSame = JSON.stringify(now.files) === JSON.stringify(SNAP0.files);
      const shaSame = now.sha === SNAP0.sha;
      let residue = '?';
      try {
        const flat = JSON.parse(ctx.runCli(['read', PROJ, '--json', '--subtree', 'root']));
        const nodes = Array.isArray(flat.nodes) ? flat.nodes : [];
        const mine = nodes.filter((n) => /^dm[0-9a-f]{8}-/.test(String(n.id)));
        residue = mine.length === 0 ? '0' : ('还有 ' + mine.length + ' 个：' + mine.slice(0, 3).join(','));
      } catch (e) { residue = '读盘失败：' + String((e && e.message) || e).slice(0, 80); }
      // 收尾：关掉草稿窗；还原项目（本域开头切过来的那个）
      ctx.draft.closeAll();
      await new Promise((r) => setTimeout(r, 300));
      const left = ctx.draft.list().length;
      let restored = '（本来就是 ' + PROJ + '）';
      if (ENTRY_PROJECT && ENTRY_PROJECT !== PROJ) {
        const back = await openProject(ctx, ENTRY_PROJECT);
        restored = (back.ok ? '已切回 ' : '切回失败 ') + ENTRY_PROJECT;
      }
      return {
        ok: filesSame && shaSame && residue === '0' && left === 0,
        text: '数据文件 sha256 相同=' + shaSame + '（' + String(SNAP0.sha).slice(0, 12) + '）'
          + ' ｜ 文件清单相同=' + filesSame + '（' + SNAP0.files.length + ' 个文件）'
          + ' ｜ 草稿痕迹在盘上残留=' + residue
          + ' ｜ 关窗后剩 ' + left + ' 张（期望 0）'
          + ' ｜ 还原项目=' + restored
          + (filesSame ? '' : ' ｜ 清单差异：' + JSON.stringify({ before: SNAP0.files, after: now.files }).slice(0, 240))
      };
    }
  },

  /* ==========================================================================================
   * 【2026-10-27 UI 优化 · 草稿窗的「保存」必须始终在视口内】
   * ------------------------------------------------------------------------------------------
   * ## 治的病（实测，不是猜）
   *   草稿窗是按内容定大小的（`main-dsh-sidebar.js` 那边的 `setContentSize`），实测出现过
   *   **805×251** 的视口；而编辑框 `.mm-ed-box` 是 `max-height:88vh; overflow:auto`
   *   ⇒ 88vh = 221px，比内容矮 ⇒ 动作行（含「保存」）被滚出视口，只能靠 `editor.js` 的
   *   `scrollIntoView` 兜着 —— 那是"碰巧还在"，不是"保证了在"。
   *
   * ## 那个兜底**已经删掉**（2026-10-28 本批，ROADMAP 第 73 行的收口）
   *   动作行改成固定底栏之后（`.mm-ed-box` = flex 列：h3 固定 + 正文滚 + 动作行固定），
   *   冒烟里那次「点不中就 `scrollIntoView` 把「保存」滚进视口再点」的降级按 ROADMAP 的要求
   *   **删掉**了（不是留着）：现在那一跳的判据是**直接断言几何**
   *   —— `edit-ok` 矩形完全落在视口矩形内 + 中心命中它自己，两条都成立才发真鼠标。
   *   实测（本批 SMOKE_ONLY=56）：滚到顶与滚到底，按钮 rect 都是 `{"top":206,"bottom":238}`、
   *   视口 805×257 ⇒ 两种滚动位置都在视口内且都命中自己 ✓。
   *   ⚠️ 留在这里的这条断言**就是**那个契约的唯一守卫：删掉兜底之后若它红，说明布局又退回去了。
   *
   * ## 判据（与域 04 同一口径，两个页面各一份样式各判一次）
   *   把「详情」格撑到 900px 人为制造溢出 ⇒ 在 **scrollTop=0** 和 **scrollTop=max** 各量一次：
   *   「保存」矩形必须同时 ① 在**对话框可见区**内 ② 在**视口**内。
   *   没有 `position: sticky` 时，scrollTop=0 那一次读到的是 y≈900（视口外）⇒ 必红。
   *
   * ## 为什么本域先开一张草稿窗
   *   草稿窗的尺寸依赖主窗状态；单独跑 `SMOKE_ONLY=56` 时前面域没跑 ⇒ 这条自己铺场
   *   （照本域既有的"自建前置"写法：切项目 → 挑子树 → 菜单新建草稿窗）。
   * ========================================================================================== */
  {
    name: '【UI 优化】草稿窗编辑框的「保存」始终在可见区内：把正文撑到 900px 制造溢出后，'
      + '滚到顶 / 滚到底都不许出框（粘底动作行；视口可能只有 251px 高）',
    run: async (ctx) => {
      if (!ctx.draft) return { ok: false, text: 'ctx.draft 不可用' };
      let opened = false;
      try {
        const cur = await execJson(ctx, '(function(){var p=window.MMApp.getState().project;return JSON.stringify({name:p?p.name:""});})()');
        if ((cur.name || '') !== PROJ) {
          const o = await openProject(ctx, PROJ);
          if (!o.ok) return { ok: false, text: '切不到 ' + PROJ + '：' + JSON.stringify(o) };
        }
        const picked = await execJson(ctx, pickSubtreeJs(1, 3));
        if (!picked.ok || !picked.selOk) return { ok: false, text: '挑不到 ≤3 节点的子树：' + JSON.stringify(picked) };
        const clicked = clickNewDraftMenu();
        if (!clicked.ok) return { ok: false, text: clicked.text };
        const list = await waitDraftCount(ctx, 1);
        if (!list.length) return { ok: false, text: '草稿窗一个都没开出来（现有 ' + ctx.draft.list().length + ' 张）' };
        opened = true;
        const ready = await waitDraft(ctx, '(function () { var s = window.MM.draftEditor ? window.MM.draftEditor() : null;'
          + ' return JSON.stringify({ ok: !!(s && s.dialog) }); })()', 60);
        if (!ready.ok) return { ok: false, text: '草稿页没有 draftEditor 读数口：' + JSON.stringify(ready).slice(0, 160) };

        // 开编辑框（与"草稿窗能改标题"那条同一条路径：选中根 → 点「编辑节点」）
        const openDlg = await draftJson(ctx, `(function () {
          var rid = window.MM.draftEditor().rootId;
          var root = document.querySelector('jmnode[nodeid="' + rid + '"]');
          if (!root) return JSON.stringify({ ok: false, text: '页面上找不到根节点 ' + rid });
          root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          document.getElementById('btn-edit').click();
          return JSON.stringify({ ok: !!window.MM.draftEditor().dialog.open });
        })()`);
        if (!openDlg.ok) return { ok: false, text: '点了「编辑节点」但框没开' };

        const made = await draftJson(ctx, `(function () {
          var ta = document.getElementById('edit-detail');
          var box = document.querySelector('#edit-dialog .mm-ed-box');
          var body = document.querySelector('#edit-dialog .mm-ed-body');
          if (!ta || !box || !body) return JSON.stringify({ ok: false, why: '缺 #edit-detail / .mm-ed-box / .mm-ed-body' });
          ta.style.height = '900px';
          body.scrollTop = 0;
          return JSON.stringify({ ok: true, overflow: body.scrollHeight > body.clientHeight + 8,
            scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
            vh: window.innerHeight, vw: window.innerWidth });
        })()`);
        const measure = `(function () {
          var btn = document.getElementById('edit-ok');
          var box = document.querySelector('#edit-dialog .mm-ed-box');
          var body = document.querySelector('#edit-dialog .mm-ed-body');
          if (!btn || !box) return JSON.stringify({ ok: false, why: '缺 #edit-ok 或 .mm-ed-box' });
          var b = btn.getBoundingClientRect(), q = box.getBoundingClientRect();
          var vh = window.innerHeight, vw = window.innerWidth;
          /* 真判据（不是几何）：对按钮**中心**做命中测试。被裁掉 / 被压住时 rect 读数与正常显示
           * 一样，只有命中测试能分辨（门禁 V1 就是为此存在的）。 */
          var cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
          var at = document.elementFromPoint(cx, cy);
          var hit = !!(at && (at === btn || (at.closest && at.closest('button') === btn)));
          return JSON.stringify({ ok: true,
            btn: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
            inBox: b.top >= q.top - 1 && b.bottom <= q.bottom + 1,
            inView: b.top >= -1 && b.bottom <= vh + 1 && b.left >= -1 && b.right <= vw + 1,
            center: { x: cx, y: cy }, at: at ? (at.tagName + (at.id ? '#' + at.id : '')) : 'null', hit: hit,
            scrollTop: Math.round((body || box).scrollTop) });
        })()`;
        const top = JSON.parse(await draftExec(ctx, measure));
        await draftExec(ctx, '(function () { var body = document.querySelector("#edit-dialog .mm-ed-body");'
          + ' if (body) body.scrollTop = body.scrollHeight; return 1; })()');
        const bottom = JSON.parse(await draftExec(ctx, measure));
        // 收尾：还原格子高度并关框（别把草稿窗留在模态里影响后面的域）
        await draftExec(ctx, '(function () { var ta = document.getElementById("edit-detail");'
          + ' if (ta) ta.style.height = ""; var b = document.getElementById("edit-cancel"); if (b) b.click(); return 1; })()');
        opened = false;
        const ok = !!(made && made.ok && made.overflow && top && top.ok && bottom && bottom.ok
          && top.inBox && top.inView && top.hit && bottom.inBox && bottom.inView && bottom.hit);
        return {
          ok,
          text: '草稿窗视口 ' + (made && made.vw) + '×' + (made && made.vh)
            + ' ｜ 正文撑到 900px ⇒ 溢出=' + (made && made.overflow)
            + '（scrollHeight ' + (made && made.scrollHeight) + ' > clientHeight ' + (made && made.clientHeight) + '）'
            + ' ｜ 滚到顶 scrollTop=' + (top && top.scrollTop) + ' ⇒ 「保存」rect=' + JSON.stringify(top && top.btn)
            + ' 在框内=' + (top && top.inBox) + ' 在视口内=' + (top && top.inView)
            + ' 中心命中自己=' + (top && top.hit) + '（命中=' + (top && top.at) + '）'
            + ' ｜ 滚到底 scrollTop=' + (bottom && bottom.scrollTop) + ' ⇒ rect=' + JSON.stringify(bottom && bottom.btn)
            + ' 在框内=' + (bottom && bottom.inBox) + ' 在视口内=' + (bottom && bottom.inView)
            + ' 中心命中自己=' + (bottom && bottom.hit) + '（命中=' + (bottom && bottom.at) + '）'
        };
      } finally {
        try {
          await draftExec(ctx, '(function () { var ta = document.getElementById("edit-detail");'
            + ' if (ta) ta.style.height = ""; var b = document.getElementById("edit-cancel"); if (b) b.click(); return 1; })()');
        } catch (e) { /* 窗口没了：不影响判定 */ }
        try { await closeDialogs(ctx); } catch (e) { /* 同上 */ }
        if (opened) { try { ctx.draft.closeAll(); } catch (e) { /* 同上 */ } }
        /* 还原入口项目：本域末尾的沙箱清理（%TEMP% 那份副本）与后面的域都指望它。
         * 不还就会读到「临时项目目录收尾 EPERM / 剩余 1 条 book-wifi7」⇒ 整跑 exit 1
         * （产品侧没问题：是探针把项目切走了又没切回来）。 */
        if (ENTRY_PROJECT && ENTRY_PROJECT !== PROJ) { try { await openProject(ctx, ENTRY_PROJECT); } catch (e) { /* 同上 */ } }
      }
    }
  },

  /* ==========================================================================================
   * 【2026-10-27 UI 优化 · 草稿窗的报错也不许被下一句灰字盖掉】
   * 与主窗域 16 同一口径（那里有完整的长注释）。本页 `#status` 是**一行 + ellipsis**，
   * 而窗口只有 251px 高 ⇒ 报错更容易连看都看不清。
   * 判据：制造一句真报错（点「编辑节点」但没选中节点 = 产品自己的分支）
   *       → 再写一句灰色例行提示 → 等 250ms ⇒ `#err-toast` 仍在且仍是报错原文。
   * ========================================================================================== */
  {
    name: '【UI 优化】草稿窗：报错 200ms 后仍在屏幕上（写一句灰色例行提示后 `#err-toast` 仍留着原文）',
    run: async (ctx) => {
      if (!ctx.draft) return { ok: false, text: 'ctx.draft 不可用' };
      let opened = false;
      try {
        const cur = await execJson(ctx, '(function(){var p=window.MMApp.getState().project;return JSON.stringify({name:p?p.name:""});})()');
        if ((cur.name || '') !== PROJ) {
          const o = await openProject(ctx, PROJ);
          if (!o.ok) return { ok: false, text: '切不到 ' + PROJ + '：' + JSON.stringify(o) };
        }
        const picked = await execJson(ctx, pickSubtreeJs(1, 3));
        if (!picked.ok || !picked.selOk) return { ok: false, text: '挑不到 ≤3 节点的子树：' + JSON.stringify(picked) };
        const clicked = clickNewDraftMenu();
        if (!clicked.ok) return { ok: false, text: clicked.text };
        const list = await waitDraftCount(ctx, 1);
        if (!list.length) return { ok: false, text: '草稿窗一个都没开出来' };
        opened = true;
        await waitDraft(ctx, '(function () { var s = window.MM.draftEditor ? window.MM.draftEditor() : null;'
          + ' return JSON.stringify({ ok: !!(s && s.dialog) }); })()', 60);

        const readToast = `(function () {
          var b = document.getElementById('err-toast');
          var t = document.getElementById('err-toast-text');
          var s = document.getElementById('status');
          return JSON.stringify({ hidden: !b || b.hidden, toast: t ? String(t.textContent) : '',
            status: s ? String(s.textContent) : '' });
        })()`;
        /* 制造报错，两档（**先用产品自己的分支**，用不上才退回页面自己的状态口）：
         *   档① 刚开出来的草稿窗 `selectedId` 是空的（`draft-map.js:45`）⇒ 点「编辑节点」会走
         *        `withSelection` 的"没选中"分支，写一条 `isErr=true` 的报错 = 真产品路径；
         *   档② 万一那时已经有选中（上一个域留下的），就调 `MM.draftSetStatus(msg, true)` ——
         *        那是本页**自己的**状态口（`draft-map.js` 里转发给同一个 setStatus），
         *        判据要验的是"载体"（写进去之后留不留得住），不是"哪一条产品分支先触发"。
         * 两档都在报文里如实说用了哪一档。 */
        const errMade = await draftJson(ctx, `(function () {
          document.getElementById('btn-edit').click();
          var s = document.getElementById('status');
          var t = String(s ? s.textContent : '');
          var how = 'product';
          if (t.indexOf('请先在图上点一个节点') < 0) {
            how = 'draftSetStatus';
            try { window.MM.draftSetStatus('请先在图上点一个节点（探针直调状态口）', true); } catch (e) {}
            t = String((document.getElementById('status') || {}).textContent || '');
          }
          return JSON.stringify({ status: t, how: how });
        })()`);
        const first = JSON.parse(await draftExec(ctx, readToast));
        await draftExec(ctx, '(function () { window.MM.draftSetStatus'
          + " ? window.MM.draftSetStatus('例行提示：本句来自 UI 优化批的探针', false) : 0; return 1; })()");
        await draftExec(ctx, 'new Promise(function (res) { setTimeout(res, 250); })');
        const after = JSON.parse(await draftExec(ctx, readToast));
        const errWentToStatus = String(errMade.status || '').indexOf('请先在图上点一个节点') >= 0;
        const toastHadErr = first.hidden === false && String(first.toast).indexOf('请先在图上点一个节点') >= 0;
        const stillThere = after.hidden === false && String(after.toast) === String(first.toast)
          && String(after.toast).indexOf('请先在图上点一个节点') >= 0;
        const statusMoved = String(after.status).indexOf('例行提示') >= 0;
        return {
          ok: errWentToStatus && toastHadErr && stillThere && statusMoved,
          text: '报错来源=' + (errMade.how || '?') + '（状态栏=' + JSON.stringify(String(errMade.status).slice(0, 34)) + '）'
            + ' ⇒ 报出了=' + errWentToStatus
            + ' ｜ 错误条出现并含原文=' + toastHadErr + '（隐藏=' + first.hidden + '）'
            + ' ｜ 再写灰字 + 等 250ms ⇒ 错误条仍在且原文未变=' + stillThere
            + '（隐藏=' + after.hidden + ' 原文=' + JSON.stringify(String(after.toast).slice(0, 34)) + '）'
            + ' ｜ 状态栏已变成那句灰字=' + statusMoved
            + '（' + JSON.stringify(String(after.status).slice(0, 28)) + '）'
        };
      } finally {
        try { await draftExec(ctx, '(function () { if (window.MM.draftHideErrToast) window.MM.draftHideErrToast();'
          + ' var b = document.getElementById("err-toast"); if (b) b.hidden = true; return 1; })()'); } catch (e) { /* 窗口没了 */ }
        try { await closeDialogs(ctx); } catch (e) { /* 同上 */ }
        if (opened) { try { ctx.draft.closeAll(); } catch (e) { /* 同上 */ } }
        /* 还原入口项目（同上一条的理由）：不还 ⇒ 沙箱清理 EPERM ⇒ 整跑 exit 1。 */
        if (ENTRY_PROJECT && ENTRY_PROJECT !== PROJ) { try { await openProject(ctx, ENTRY_PROJECT); } catch (e) { /* 同上 */ } }
      }
    }
  }
];

module.exports = assertions;
