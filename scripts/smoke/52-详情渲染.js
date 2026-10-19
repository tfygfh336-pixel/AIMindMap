/* ============================================================
 * scripts/smoke/52-详情渲染.js —— `R7` 主体的**真机判据**（真帧 / 真鼠标 / 真像素 / 真鼠标坐标）
 * ------------------------------------------------------------
 * 本域守四件事（每条判据都照设计稿 **§⑫-3 改过的形态**写，不照 §⑨ 原稿）；
 * 另有 ①b/①c 两条是 `2026-10-18` 修两个真 bug 时**补上的判据**（见下面 ① 之后那两段）。
 *
 *  ① **消毒真的在跑**（§⑨-5 的换形态版）
 *     注入六类**踩在 CSP 真空档上**的东西：`<style>`（`style-src 'unsafe-inline'` 放行）、
 *     `<iframe src="data:text/html,…">`（未声明 `frame-src` ⇒ 回落 `default-src … data:`）、
 *     `<meta http-equiv=refresh>` 与 `<base href>`（**CSP 管不到**）、`<svg onload>`、`<form action>`；
 *     另加 `<p style=…>`、`<a href="javascript:…">`、远程图。
 *     断言：容器里这些**元素一个都不存在**、`on*`/`style` 属性一个都没有、
 *     详情框内任一元素的 `getComputedStyle().position !== 'fixed'`、远程图变成**可见占位**、
 *     `location.href` 前后相同（没被 meta refresh 导航走）。
 *     ⚠️ **反向前置**（§⑫-3.3）：先断言"被禁的标签**确实没成为元素**"且
 *     `MM.Sanitize.state()` 的**运行计数与 dropped 计数都 > 0** —— 证明这一档不是"因为没跑所以绿"。
 *     **判别力证明**见 `.review/20261016-R7实现/README.md`（去掉消毒那一步 ⇒ 本断言必红）。
 *
 *  ①b **隔离判据**（`2026-10-18` 补，修 bug① 时加的）：上面那一条把 http 图和**一整串必删项**塞进
 *     同一个 detail ⇒ `changed` 被别的改动置真 ⇒ "被拦图片少了一行 `mutated = true`"也照样绿
 *     （**这就是它漏过的原因**）。⇒ 另起一个**只含一张被拦图**的夹具：`changed` 必须为 true
 *     **且**占位真在 DOM 里。回退那一行 ⇒ 本断言必红（读数见 `.review/20261016-sanitize两bug/README.md`）。
 *  ①c **连续判据**（同批）：bug② 的触发条件是"**进入这次调用时** `state.urlsBlocked` 已为真值"，
 *     而全仓语料的被拦 URL = 0 ⇒ `D_EVIL` 之后再没有第二次被拦图片 ⇒ 那个 `TypeError` 从没被跑到。
 *     ⇒ 本条在**同一页面连续 inject** 三次（1 张 · 1 张 · 一次 2 张），再打开"两张连排"夹具。
 *
 *  ② **`<details>` 真能展开**（§⑨-1 + 反向前置）
 *     真鼠标点 `<summary>` 的屏幕坐标 ⇒ `open` 变了、`summary` 的 `clientHeight` 变化 > 0、
 *     展开后新出现的块用 `elementFromPoint(中心)` **命中它自己**，且真帧那一块有墨。
 *
 *  ③ **Mermaid 懒加载链**（§⑨-2 + 反向前置）
 *     前置：域名开始时页面上**没有** mermaid 的 `<script>`、`window.mermaid` 不存在（"懒"这件事被证明）；
 *     真渲染：合法图源 ⇒ `[data-mm-mermaid="ok"]` 且 `svg` 宽高 > 0 且真帧该矩形 `unique ≥ 2`；
 *     降级：非法图源 ⇒ **可见的** `.fd-mermaid-fail`（`elementFromPoint` 命中它）且文本含"未渲染" + 原因，
 *     图源代码块**一个字不丢**。
 *
 *  ④ **三类链接 + 笔记锚点**
 *     · 常规路径：正文 `<a href="assets/…">` 真鼠标点 ⇒ 走**既有出口** `app:open-file`（用记录器拦下，
 *       断言它与 `src/path-chain.js` 的 `decide({kind:'inline'})` 算出的是**同一个绝对路径**）；
 *       `..` 逃逸链接 ⇒ **不许调出口** + 状态栏可见报错；本机绝对路径 ⇒ 走 `localPath` 档。
 *     · 站内链接：`aimm://<项目>/<节点id>` 真鼠标点 ⇒ 目标被选中 **且** 真帧里命中它自己。
 *     · 独立笔记：关键词（`assoc.anchors[{text}]`）在正文里成为 `.fd-notelink`，
 *       真鼠标点它 ⇒ **新浮窗**且 `dataset.boxId` 落在 `createFdBox()` 的递增序列上、标题含那篇笔记的标题；
 *       同时正文 `detail` **逐字节不变**（sha256）。
 *     · 失效锚点：正文改写掉关键词后 ⇒ 那篇笔记**仍在**「本页笔记」区且带坏引用态（不静默消失），
 *       `validate --anchors` **判红并点名**。
 *
 *  ⑤ **既有语料不被砸**（§⑨-7 的规模版）：拿 `scripts/detail-census.js` 的**现算**真值当分母，
 *     把全仓 detail（分批传进页面）逐个消毒后比"浏览器 `textContent`" vs "`stripHtml`（我们的实现）"
 *     —— 判据 = 消毒没动过字节的那些必须逐字相同 + 消毒改过的那些原有文字一个不少。
 *     ⚠️ 覆盖面这一项**2026-10-19 复核批改成三档**（实测假红驱动）：原来分母取**真实**目录、
 *     字节取**沙箱副本**（两个快照）⇒ 同机有别的批在写语料时 `items===total` 恒假 ⇒ **每次都红**。
 *     现在 = 真漏读快照里的条目 ⇒ 判红；只有"真实 vs 快照"不同 ⇒ **只报告**并打印 Δ + 真实侧指纹证据。
 *     口径依据与三条读数见 `.review/20261019-域52真渲染复核/复核读数.md`。
 *  ⑥ **渲染不进数据**（§⑨-9）：渲染前后项目 JSON 的 sha256 逐字节相同；无链接节点的 `innerHTML`
 *     与 CLI 的 `detail` 逐字节相同（默认档不变）。
 *
 * 收尾：关掉全部详情框、切回 `comnet`、删掉夹具项目（自证不存在）—— 与域 47 同一套纪律。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const frameStats = require('../vision/frame-stats.js');
const convert = require('../../src/convert.js');
const census = require('../detail-census.js');
const mm = require('../smoke-assertions.js');
/* 唯一写盘出口（`src/data-store.js` 的 `writeFileAtomic`）：本域有两处写盘（夹具 assets/probe.txt 与真帧 PNG），
 * 一律走它 —— 裸 `fs.writeFileSync` 会被 S2 的 [write-outlet] 判定抓（本批实测抓到过，见那两处的注释）。 */
const DATA_STORE = require('../../src/data-store.js');

const ROOT = path.resolve(__dirname, '..', '..');

/* ---------------- 夹具（自建自删，全部落在冒烟沙箱副本里 ✓） ---------------- */

const PROJ = 'smoke-detail-52';
const HOME_PROJECT = 'comnet';
const N_DETAILS = 's52-details';     // <details> 夹具
const N_EVIL = 's52-evil';           // 六类注入夹具
const N_MD_OK = 's52-md-ok';         // 合法 mermaid 图源
const N_MD_BAD = 's52-md-bad';       // 非法 mermaid 图源（必经降级）
const N_PATH = 's52-path';           // 三类路径链接
const N_AIM = 's52-aim';             // 站内链接的源
const N_AIM_FAR = 's52-far';         // 深链末端（打开项目时在视野外）
const N_NOTE = 's52-note';           // 笔记锚点所在节点
const N_PLAIN = 's52-plain';         // 默认档（无链接、无图源、无锚点）
const N_IMG_ONE = 's52-img-one';     // **隔离**夹具：detail 里**只有一张被拦图**（bug① 的红线）
const N_IMG_TWO = 's52-img-two';     // **连排**夹具：一次两张被拦图（bug② 的触发条件）
const CHAIN = 16;

const NOTE_ID = 'a-s52-note';
const NOTE_TITLE = 'S52 锚点笔记';
const ANCHOR_TEXT = '三次握手';

const D_DETAILS = '<p>前置段落</p><details><summary>折叠标题甲</summary>'
  + '<p>折叠正文甲（展开才看得见）</p></details>';
const D_EVIL = '<style>#mm-canvas{position:fixed;inset:0;z-index:99999}</style>'
  + '<iframe src="data:text/html,<script>window.__pwned=1</script>"></iframe>'
  + '<meta http-equiv="refresh" content="0;url=https://example.invalid/">'
  + '<base href="https://example.invalid/">'
  + '<svg onload="window.__pwned=2"><circle r="4"></circle></svg>'
  + '<form action="https://example.invalid/"><input name="x"></form>'
  + '<p style="position:fixed;top:0">带 style 属性的段落</p>'
  + '<a href="javascript:window.__pwned=3">javascript 链接</a>'
  + '<img src="https://example.invalid/remote.png" alt="远程图">'
  + '<img src="http://example.invalid/plain.png" alt="明文图">'
  + '<img src="x" onerror="window.__pwned=4">'
  + '<p>这段文字必须留下</p>';
/* ⭐ **隔离**夹具（bug① 的红线）：detail 里**只有一张明文 http 图** —— 没有 style/iframe/meta/base/
 * svg/form/属性/链接任何一项别的必删项 ⇒ 这一次消毒的 `changed` **只可能**由"图片被拦"置真。
 * `D_EVIL` 那种"塞满一锅"的形态**测不到**这件事（changed 被别的改动置真、占位照样出现）。 */
const D_IMG_ONE = '<img src="http://example.invalid/only.png" alt="唯一一张">';
/* ⭐ **连排**夹具（bug② 的触发条件）：一次渲染里连着两张被拦图。 */
const D_IMG_TWO = '<p>两张被拦图</p><img src="http://example.invalid/a.png">'
  + '<img src="http://example.invalid/b.png">';
const D_IMG_SECOND = '<img src="http://example.invalid/second.png">';
const D_MD_OK = '<p>下面是一张图</p><pre><code>graph TD; A[甲]--&gt;B[乙];</code></pre>';
const D_MD_BAD = '<p>下面是一张坏图</p><pre><code>graph TD; A[unclosed</code></pre>';
/* 外链夹具的两个地址（**下方判据现算**用同一对常量，不写两处） */
const URL_HTTP = 'https://example.invalid/s52-http';
const URL_MAILTO = 'mailto:s52@example.invalid';
const D_PATH = '<p>路径三例：'
  + '<a href="assets/probe.txt">本地相对</a> '
  + '<a href="../../../escape.txt">逃逸</a> '
  + '<a href="E:\\r7\\probe.txt">本机绝对</a></p>'
  /* 【外部链接出口批】外链两例：一个**合法 http(s)**（应走 `kind:'externalUrl'` 那一档 → 唯一出口）、
   * 一个 `mailto:`（**白名单外**：判据同一档 reject ⇒ 不许调出口、且状态栏点名该档 reason）。
   * 为什么用 `mailto:` 而不是 `javascript:` 当反例：`javascript:` 在**消毒期**就被 HTML 白名单拦成
   * `.fd-link-blocked`、根本走不到"点击 → 判据"这一层 ⇒ 拿它测不到本批的分支（那是 R7 原来就有的路）。 */
  + '<p>外链两例：'
  + '<a href="' + URL_HTTP + '">外部网址</a> '
  + '<a href="' + URL_MAILTO + '">邮件</a></p>';
const D_AIM = '<p>站内：<a href="aimm://' + PROJ + '/' + N_AIM_FAR + '">跳到远端目标</a></p>';
const D_NOTE = '<p>正文里有' + ANCHOR_TEXT + '这个词</p>';
const D_PLAIN = '<h3>标题甲</h3><p>正文 <b>粗体</b></p>';

const SETTLE = 'new Promise(function (res) { setTimeout(res, 250); })';

/** 「被禁的整棵子树」的正则**源串**（在 Node 侧造好、`JSON.stringify` 进页面 —— 见用它的那段注释） */
const DROP_RE_SRC = '<(script|style|title|noscript)\\b[^>]*>[\\s\\S]*?<\\/\\1>';

function probeDir() { return path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', PROJ); }
function probeExists() { try { return fs.existsSync(probeDir()); } catch (e) { return false; } }
function removeProbe() {
  try { fs.rmSync(probeDir(), { recursive: true, force: true }); return !probeExists(); }
  catch (e) { return false; }
}
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: '渲染层返回值不是 JSON：' + String(raw).slice(0, 200) }; }
}
function cli(ctx, args) {
  try { return { ok: true, out: String(ctx.runCli(args)) }; }
  catch (e) { return { ok: false, out: String((e && e.message) || e) }; }
}
function cliJson(ctx, args) {
  const r = cli(ctx, args);
  const i = r.out.indexOf('{');
  try { return JSON.parse(i >= 0 ? r.out.slice(i) : r.out); } catch (e) { return null; }
}
function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return 'ERR:' + ((e && e.message) || e); }
}

/** 铺场（幂等；第一条断言建一次，后面几条复用）。**锚点在铺场时就写进去** —— 它要求"当下成立"。 */
let fixture = null;
function ensureFixture(ctx) {
  if (!fixture) fixture = buildFixture(ctx);
  return fixture;
}
function buildFixture(ctx) {
  const steps = [];
  steps.push('清理旧夹具=' + removeProbe());
  steps.push(cli(ctx, ['init', PROJ, '--title', 'R7 判据夹具']).out.trim());
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '52·根', '--id', 's52-root']).out.trim());
  const add = (parent, topic, id, detail) => steps.push(
    cli(ctx, ['add', PROJ, parent, '--topic', topic, '--id', id, '--detail', detail]).out.trim());
  add('s52-root', '52·折叠夹具', N_DETAILS, D_DETAILS);
  add('s52-root', '52·注入夹具', N_EVIL, D_EVIL);
  add('s52-root', '52·单图隔离夹具', N_IMG_ONE, D_IMG_ONE);
  add('s52-root', '52·双图连排夹具', N_IMG_TWO, D_IMG_TWO);
  add('s52-root', '52·Mermaid 好图', N_MD_OK, D_MD_OK);
  add('s52-root', '52·Mermaid 坏图', N_MD_BAD, D_MD_BAD);
  add('s52-root', '52·路径链接', N_PATH, D_PATH);
  add('s52-root', '52·站内链接源', N_AIM, D_AIM);
  add('s52-root', '52·锚点节点', N_NOTE, D_NOTE);
  add('s52-root', '52·默认档', N_PLAIN, D_PLAIN);
  // 深链：把 N_AIM_FAR 顶到视野外（"点了要滚到目标"这件事才**有东西可判**）
  let parent = 's52-root';
  for (let i = 1; i <= CHAIN; i++) {
    const id = 's52-c' + i;
    cli(ctx, ['add', PROJ, parent, '--topic', '52·深' + i, '--id', id]);
    parent = id;
  }
  add(parent, '52·远端目标', N_AIM_FAR, '<p>远端</p>');
  // 本机相对路径的目标文件（点开时 headless 会 statSync 它 ⇒ 必须真的存在）
  try {
    const adir = path.join(probeDir(), 'assets');
    fs.mkdirSync(adir, { recursive: true });
    /* 走**唯一写盘出口**（`docs/RULES.md` §1「新增写盘路径一律复用 writeFileAtomic，禁止裸 writeFileSync」）。
     * 这一处原来是裸写：本域本来没提"受管资产名"所以 S2 的兜底判定一直没扫到它，
     * 本批新增的分层代码提到 `projects` 之后 S2 立刻判红（`[write-outlet] … 2 处判不了目标的裸写`）
     * —— 门禁抓得对：本文件确实有两处判不了目标的裸写，改成走出口比登记欠账干净。 */
    DATA_STORE.writeFileAtomic(path.join(adir, 'probe.txt'), 'R7 夹具：本机相对路径的目标文件\n');
    steps.push('assets/probe.txt 已铺');
  } catch (e) { steps.push('assets 铺失败：' + ((e && e.message) || e)); }
  // 笔记锚点：成员 ≥2 + 一条 text 锚点（铺场时关键词**就在正文里**，否则写不进去 —— 这是产品口径）
  steps.push(cli(ctx, ['assoc-add', PROJ, '--members', 's52-root,' + N_NOTE, '--id', NOTE_ID,
    '--title', NOTE_TITLE, '--note-md', '这篇笔记由锚点进入。',
    '--anchor', PROJ + '/' + N_NOTE + '#text:' + ANCHOR_TEXT]).out.trim());
  steps.push(cli(ctx, ['link', PROJ, N_AIM, '--to', PROJ, '--id', N_AIM_FAR, '--caption', '同项目']).out.trim());

  const broken = [];
  if (!probeExists()) broken.push('夹具项目目录没建起来');
  else {
    const note = cliJson(ctx, ['get', PROJ, N_NOTE, '--json', '--detail']);
    if (!note || String(note.detail || '').indexOf(ANCHOR_TEXT) < 0) broken.push('锚点节点的正文里没有关键词');
    const list = cliJson(ctx, ['assoc-list', PROJ, '--node', N_NOTE, '--json']);
    if (!list || !(list.count > 0)) broken.push('锚点笔记没写进项目（assoc-list --node 看不到它）');
    const far = cliJson(ctx, ['get', PROJ, N_AIM_FAR, '--json']);
    if (!far) broken.push('远端目标 ' + N_AIM_FAR + ' 不在树里');
    if (!fs.existsSync(path.join(probeDir(), 'assets', 'probe.txt'))) broken.push('assets/probe.txt 不在');
  }
  return { steps: steps, broken: broken.join('；') };
}
function fixtureFail(fx) {
  return (fx && fx.broken) ? { ok: false, text: '前置失败：' + fx.broken } : null;
}

/* ---------------- 打开夹具项目 / 摆框（与域 47 同一套自愈） ---------------- */

async function openFixture(ctx) {
  const r = await execJson(ctx, `(async function () {
    var app = window.MMApp, want = ${JSON.stringify(PROJ)};
    if (!app) return JSON.stringify({ ok: false, text: '没有 MMApp' });
    var st = app.getState();
    if (!(st.project && st.project.name === want)) {
      if (app.isDirty && app.isDirty()) { await app.save(); }
      await app.openProject(want);
    }
    var now = (app.getState().project || {}).name;
    return JSON.stringify({ ok: now === want, text: '当前项目=' + now });
  })()`);
  await ctx.exec(SETTLE);
  if (!r.ok) return r;
  const inView = await execJson(ctx, `(function () {
    var st = window.MMApp.getState();
    return JSON.stringify({ ok: !!(st.jm && window.MM.adapter.getNode(st.jm, ${JSON.stringify(N_NOTE)})) });
  })()`);
  if (inView.ok) return r;
  try { ctx.win.webContents.reload(); } catch (e) { /* 下面轮询判 */ }
  for (let i = 0; i < 60; i++) {
    await ctx.exec('new Promise(function (r) { setTimeout(r, 100); })');
    try {
      const back = await execJson(ctx, `(async function () {
        var app = window.MMApp, want = ${JSON.stringify(PROJ)};
        if (!(app && app.getState && app.getState().jm)) return JSON.stringify({ ok: false });
        await app.openProject(want);
        return JSON.stringify({ ok: (app.getState().project || {}).name === want });
      })()`);
      if (back && back.ok) return { ok: true, text: 'reload 后重新打开：' + PROJ };
    } catch (e) { /* reload 中 */ }
  }
  return { ok: false, text: 'reload 后仍然打不开夹具项目' };
}

/** 把一个节点的详情框摆到确定位置（取景准备，不是被判的行为） */
async function pinDetailBox(ctx, nodeId) {
  const r = await execJson(ctx, `(function () {
    var MM = window.MM, app = window.MMApp;
    var st = app.getState();
    if (!st.jm) return JSON.stringify({ ok: false, text: '没有打开的导图' });
    if (app.closeAllFloatDetail) app.closeAllFloatDetail();
    var n = MM.adapter.getNode(st.jm, ${JSON.stringify(nodeId)});
    if (!n) return JSON.stringify({ ok: false, text: '节点不在视图：' + ${JSON.stringify(nodeId)} });
    MM.showDetail(n);
    var box = MM.fdPrimaryNodeBox();
    if (!box) return JSON.stringify({ ok: false, text: '详情框没开起来' });
    if (MM.setFdBoxLock && MM.FD_LOCK) MM.setFdBoxLock(box, MM.FD_LOCK.SCREEN);
    box.el.style.left = '12px';
    box.el.style.top = '12px';
    var bc = box.el.getBoundingClientRect();
    return JSON.stringify({ ok: true, boxId: box.el.dataset.boxId || '',
      rect: { x: bc.left, y: bc.top, width: bc.width, height: bc.height } });
  })()`);
  await ctx.exec(SETTLE);
  return r;
}

/* ---------------- 真帧读数（与域 47 同一套：判据与证据是同一张图） ---------------- */

const SHOT_DIR = path.join(ROOT, '.review', '20261016-R7实现', 'shots');
function saveShot(name, img) {
  const png = img.toPNG();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name);
  /* 同 `buildFixture` 那一处：走唯一写盘出口（S2 的 [write-outlet] 判定按**文件**兜底，裸写会连带判红） */
  DATA_STORE.writeFileAtomic(file, png);
  const size = typeof img.getSize === 'function' ? img.getSize() : { width: 0, height: 0 };
  return { file: file, bytes: png.length, width: size.width, height: size.height,
    sha256: crypto.createHash('sha256').update(png).digest('hex').slice(0, 16) };
}
function toDev(rect, dpr) {
  return { x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) };
}
async function captureUntil(ctx, expr, judge, tries) {
  const n = tries || 3;
  let last = null;
  for (let i = 0; i < n; i++) {
    const before = await execJson(ctx, expr);
    if (!before || !before.ok) return { ok: false, attempts: i + 1, text: '读数失败：' + (before && before.text) };
    const img = await ctx.input.capture();
    const after = await execJson(ctx, expr);
    if (!after || !after.ok || JSON.stringify(after.rects) !== JSON.stringify(before.rects)) {
      await ctx.input.settle({ delayMs: 200 });
      last = { ok: false, attempts: i + 1, text: '取景不稳（同一读数的两次几何不一致）' };
      continue;
    }
    const judged = judge(before, img);
    last = { ok: true, rects: before, img: img, judged: judged, attempts: i + 1 };
    if (judged && judged.pass) return last;
    await ctx.input.settle({ delayMs: 260 });
  }
  return last;
}
/** 在一个元素矩形里找一个 `elementFromPoint` 真能命中它的点（真鼠标只截这个点） */
const hitPointExpr = `function hitPt(el) {
  var r = el.getBoundingClientRect();
  var cands = [
    { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) },
    { x: Math.round(r.right - 6), y: Math.round(r.top + Math.round(r.height / 2)) },
    { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 3) }
  ];
  for (var i = 0; i < cands.length; i++) {
    var q = cands[i];
    var at = document.elementFromPoint(q.x, q.y);
    if (at && (at === el || el.contains(at))) return q;
  }
  return null;
}
function rc(el) { var r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height }; }`;

/* ============================================================
 * 真实语料**真渲染**：分层抽样（纯函数，可复现；N 与分档阈值**现算不写死**）
 * ------------------------------------------------------------
 * 这一段的**全部理由**（缺口就在这里，别把它读成"再加一条断言"）：
 *   · 第 ⑧ 条（下面那个"既有 detail 语料不被砸"）已经把全仓 detail 送进页面**逐个消毒**，
 *     比的文字是 `textContent` vs `stripHtml` —— 但它注入的是**一个临时 `div`**，不是详情框；
 *     ⇒ 它证明的是"**消毒**没砸字"，**不证明"详情框渲染出来是对的"**。
 *   · 真帧那一半当时只有 **1 个夹具节点**（`D_DETAILS` / `D_EVIL` / …）覆盖
 *     ⇒ "真实语料渲染出来是对的"这句话**没有任何读数**（R7 实现批报告 §六-4 的如实偏差）。
 *
 * 本段补的就是那一半，三条判据都对着**产品唯一的渲染入口**取：
 *   ① 渲染**不抛错**；
 *   ② 渲染后**可见文字**与 `stripHtml(detail)` 逐字相同（沿用 ⑧ 的既有范式：空白一律折掉再比）；
 *   ③ **该层该有的结构真的出现**（表格是真 `<table>`、details 真是 `<details>`、图片是 `<img>`
 *     且**非零几何**、纯文本**不进元素**、其它层**元素标签全在白名单内**）。
 *
 * ⚠️ **抽样就是抽样**：本段只给出"抽了 N 条、过了"这个读数，**不许**读成"全量都对"。
 *    覆盖面（分母 / 抽样数 / 每层多少 / 哪些层**没有样本**）由断言报文**逐项打印**。
 * ============================================================ */

/** 层定义：**顺序即判定优先级** —— 一条 detail 只归一层（否则同一条会被数进两层，分母就虚了） */
const RENDER_LAYERS = [
  { key: 'table', label: '含表格', re: /<table\b/i },
  { key: 'details', label: '含 details', re: /<details\b/i },
  { key: 'img', label: '含图片', re: /<img\b/i },
  { key: 'tags', label: '其它白名单标签', re: null },
  { key: 'plain', label: '纯文本（无白名单标签）', re: null }
];

/** 每层取多少条：`clamp(ceil(√n), N_MIN, N_MAX)` —— **n 是该层的现算条数**，不是写死的 N。
 *  为什么是 √n：层越大越该多抽（覆盖率随 √n 走），但线性抽样会把 93% 的那一层抽炸。
 *  为什么有上下限：下限 2 保证"层再小也有两条可判"；上限 24 是**成本护栏**
 *  （渲染逐个走真详情框，实测见 `.review/20261016-域52真渲染/读数.md` 的耗时分布）。 */
const RENDER_N_MIN = 2;
const RENDER_N_MAX = 24;

/** 本判据愿意花在"逐个真渲染"上的**墙钟上限**（毫秒）。
 *  它不是性能目标，是**对 G5 的增量上限**：抽样循环每跑一条现算一次成本，超预算就停下并**如实报还差几条**
 *  （照本工程"预算即止涨线"的既有口径；实测读数与 G5 余量见 `.review/20261016-域52真渲染/读数.md`）。 */
const RENDER_TOTAL_BUDGET_MS = 5000;

/** 结构判据要点名的"关键标签"（只判**白名单里的**：白名单外的是 `unwrapEl` 拆壳留字，
 *  数它们会把**设计意图**判成缺陷 —— `src/html-whitelist.js` 是这张表的唯一一份） */
const RENDER_KEY_TAGS = ['pre', 'code', 'ul', 'ol', 'li', 'p', 'h1', 'h2', 'h3', 'h4',
  'strong', 'b', 'em', 'blockquote', 'a', 'dl', 'dt', 'dd', 'hr', 'br'];

/** 一条 detail 落在哪一层（**纯函数**，口径与 `RENDER_LAYERS` 同序） */
function renderLayerOf(d, tagRe) {
  for (const L of RENDER_LAYERS) if (L.re && L.re.test(d)) return L.key;
  return tagRe.test(d) ? 'tags' : 'plain';
}

/** 去重后的白名单标签**名**个数（`data-census` 的 `TAG_RE` 是全局正则 ⇒ 每次都新建一份，别复用） */
function tagCountOf(d, tagReSrc) {
  const set = new Set();
  const re = new RegExp(tagReSrc, 'gi');
  let m;
  while ((m = re.exec(d))) {
    const tok = String(m[0] || '');
    const name = tok.replace(/[<>\/\s]/g, '').toLowerCase();
    if (name) set.add(name);
  }
  return set.size;
}

/** 等距抽样（**确定性、可复现**：不掷随机数，排序键固定 ⇒ 同一份语料必抽到同一批） */
function sampleEvenly(sorted, k) {
  const n = sorted.length;
  if (k >= n) return sorted.slice();
  const out = [];
  const stride = n / k;
  for (let i = 0; i < k; i++) {
    const idx = Math.min(n - 1, Math.floor(i * stride + stride / 2));
    out.push(sorted[idx]);
  }
  return out;
}

/** 现算"含白名单标签数"的分档阈值（分位点，**从这一份语料现算**；不用固定 1/2-3/4-7 这类写死的边界） */
function tagCountCuts(values, parts) {
  const v = values.slice().sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < parts; i++) {
    const idx = Math.min(v.length - 1, Math.floor((i / parts) * v.length));
    cuts.push(v[idx]);
  }
  return cuts;
}

/**
 * 从**冒烟沙箱副本**（`AI_MINDMAP_PROJECTS_DIR`，与"被渲染的那些字节"同一快照）现算分母 + 分层抽样。
 *
 * 为什么分母取副本而不是真实 `projects/`：⑧ 那条拿真实目录当分母、再从副本读 detail，
 * 两者是**两个快照**（并发会话正在写 `comnet.json` 时会有差）。
 * 那在这种批里会变成**假红**（别人写入 ⇒ 我们判红）⇒ 本段的分母与被渲染的字节**必须同一快照**。
 * 真实目录的现算值只作**参照**打印（不参与判定）。
 * @returns {{ok:boolean, text?:string, strata?:object[], items?:object[], sampled?:object[]}}
 */
function buildRenderPlan() {
  const dir = process.env.AI_MINDMAP_PROJECTS_DIR || '';
  if (!dir) return { ok: false, text: '没有 AI_MINDMAP_PROJECTS_DIR（冒烟沙箱副本）⇒ 采不到真值' };
  const tagReSrc = census.TAG_RE.source;
  const items = [];
  const unreadable = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { ok: false, text: '沙箱副本读不出来：' + ((e && e.message) || e) }; }
  /* ⭐ 只认"**真实 `projects/` 目录里也有的**项目名"。
   * 为什么（实测，两处都踩过）：
   *   ① 冒烟沙箱副本里会**长出别的域的夹具项目**（`smoke-*` / `zz-*` / `si39-*` …），它们带着自己的 detail
   *      ⇒ 混进分母会把"真实语料"的读数污染掉（全链实测：分母 1327 → **1358**，且分位点边界跟着漂
   *      `tags:1-3=582` 变成 `tags:1-2=335 · tags:3-4=792`）；
   *   ② 域 52 自己的夹具（`smoke-detail-52`）更糟：它有 `D_EVIL` / `D_IMG_TWO` 这种**故意**含被拦构造的节点，
   *      混进来会凭空造出"图片层有样本"，并让 ②③ 判红（= 拿夹具判夹具）。
   * ⇒ 用**真实目录的名字**当白名单过滤（目录名只读一次，不会读到半截文件；内容仍取副本，副本不会被并发写坏）。
   * 被排除的项目会**逐个点名 + 报它们各自有多少条 detail**（不许悄悄抹掉）。 */
  let realNames = null;
  try {
    realNames = new Set(fs.readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })
      .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
      .map((x) => x.name));
  } catch (e) { realNames = null; }
  if (!realNames) {
    return { ok: false, text: '读不到真实 projects/ 的目录名 ⇒ 无法把"真实项目"与"冒烟夹具"分开，'
      + '分母会混进夹具数据 ⇒ **采不到真值不是通过**' };
  }
  const excluded = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;          // `.visits` / `.writers`：非项目（与 detail-census.js 同一套跳过规则）
    if (e.name === PROJ || !realNames.has(e.name)) {
      let n0 = 0;
      try {
        const j0 = JSON.parse(fs.readFileSync(path.join(dir, e.name, e.name + '.json'), 'utf8').replace(/^\uFEFF/, ''));
        n0 = census.collectNodes(j0.data).filter((n) => n && typeof n.detail === 'string' && n.detail.trim()).length;
      } catch (e2) { n0 = -1; }
      excluded.push({ project: e.name, withDetail: n0 });
      continue;
    }
    const f = path.join(dir, e.name, e.name + '.json');
    if (!fs.existsSync(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
    catch (err) { unreadable.push(e.name + '(' + ((err && err.message) || err) + ')'); continue; }
    /* 递归口径**直接借** `scripts/detail-census.js` 的 `collectNodes` —— 不在这里写第二份 */
    for (const n of census.collectNodes(j.data)) {
      const d = n && n.detail;
      if (typeof d !== 'string' || !d.trim()) continue;
      items.push({ project: e.name, id: String(n.id), d: d, layer: renderLayerOf(d, census.TAG_RE) });
    }
  }
  if (!items.length) {
    return { ok: false, text: '沙箱副本里一条含 detail 的节点都没有 ⇒ **采不到真值不是通过**'
      + (unreadable.length ? '（读不出来的项目：' + unreadable.join(' · ') + '）' : '') };
  }
  /* 排序键固定（项目 + 节点 id）⇒ 等距抽样可复现 */
  items.sort((a, b) => (a.project + '/' + a.id < b.project + '/' + b.id ? -1 : 1));

  const strata = [];
  for (const L of RENDER_LAYERS) {
    const list = items.filter((x) => x.layer === L.key);
    if (!list.length) { strata.push({ key: L.key, label: L.label, n: 0, sampleN: 0, picked: [] }); continue; }
    if (L.key !== 'tags') {
      const sampleN = Math.max(RENDER_N_MIN, Math.min(RENDER_N_MAX, Math.ceil(Math.sqrt(list.length))));
      strata.push({ key: L.key, label: L.label, n: list.length, sampleN: sampleN, picked: sampleEvenly(list, sampleN) });
      continue;
    }
    /* `tags`（含白名单标签、但不含 table/details/img）占语料 93% ⇒ **再按"含白名单标签数"切一刀**，
     * 边界用**本份语料的分位点现算**（打印实际数值，别处不许抄）。 */
    const withCount = list.map((x) => Object.assign({}, x, { tagCount: tagCountOf(x.d, tagReSrc) }));
    const cuts = tagCountCuts(withCount.map((x) => x.tagCount), 4);
    const buckets = [[], [], [], []];
    for (const x of withCount) {
      let bi = 0;
      while (bi < cuts.length && x.tagCount > cuts[bi]) bi++;
      buckets[bi].push(x);
    }
    const seen = new Set();
    buckets.forEach((bk) => {
      if (!bk.length) return;
      const lo = Math.min.apply(null, bk.map((x) => x.tagCount));
      const hi = Math.max.apply(null, bk.map((x) => x.tagCount));
      const key = 'tags:' + lo + '-' + hi;
      if (seen.has(key)) return;
      seen.add(key);
      const sampleN = Math.max(RENDER_N_MIN, Math.min(RENDER_N_MAX, Math.ceil(Math.sqrt(bk.length))));
      strata.push({ key: key, label: '白名单标签数 ' + lo + '~' + hi, n: bk.length,
        sampleN: sampleN, picked: sampleEvenly(bk, sampleN) });
    });
  }
  /* ⭐ 抽样顺序 = **各层轮流取一条**（round-robin），不是"一层跑完再跑下一层"。
   * 为什么（实测驱动）：本判据的渲染有**墙钟预算**（`RENDER_TOTAL_BUDGET_MS`），跑不完就要提前停；
   * 若是"层顺序铺开"，预算一停后面的层**一条都没渲染** ⇒ 分层设计当场退化成一两层。
   * 轮流取 ⇒ 无论停在哪，**每层都已被覆盖过**（这一点在报文里能看出来：每层都 ≥1）。 */
  const sampled = [];
  const queues = strata.map((s) => s.picked.slice());
  let more = true;
  while (more) {
    more = false;
    for (let i = 0; i < queues.length; i++) {
      if (!queues[i].length) continue;
      const x = queues[i].shift();
      sampled.push({ k: strata[i].key + '|' + x.project + '/' + x.id, layer: strata[i].key,
        project: x.project, id: x.id, d: x.d });
      more = true;
    }
  }
  return { ok: true, strata: strata, items: items, sampled: sampled, excluded: excluded,
    unreadable: unreadable, denominator: items.length };
}

/* ============================================================
 * 断言
 * ============================================================ */
const assertions = [

  /* ----------------------------------------------------------------------
   * ① 消毒：六类注入全部被拦（含反向前置）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 HTML 消毒生效（§⑨-5 换形态版）：<style>/<iframe data:>/<meta refresh>/<base>/<svg onload>/'
      + '<form> **一个都不成为元素**，on*/style 属性清零，框内无 position:fixed，且 location 没被导航走；'
      + '图片两档按**用户 2026-10-16 裁决**判：`https:` 图**照常是 <img> 且地址不被改**（只做安全收敛、'
      + '不做联网收敛），明文 `http:` 图**才**变成可见占位 —— 反向前置：消毒的运行计数与 dropped 计数都 > 0',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, N_EVIL);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      const hrefBefore = await execJson(ctx, `JSON.stringify({ ok: true, href: String(location.href) })`);

      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var all = [dc].concat(Array.prototype.slice.call(dc.querySelectorAll('*')));
        var banned = ['style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'meta', 'base', 'link',
          'script', 'svg', 'math', 'form', 'input', 'button', 'template', 'title'];
        var present = banned.filter(function (t) { return dc.querySelector(t); });
        var onAttrs = 0, styleAttrs = 0, fixed = 0, fixedOn = '';
        all.forEach(function (el) {
          Array.prototype.slice.call(el.attributes || []).forEach(function (a) {
            if (/^on/i.test(a.name)) onAttrs += 1;
            if (String(a.name).toLowerCase() === 'style') styleAttrs += 1;
          });
          var cs = window.getComputedStyle(el);
          if (cs && cs.position === 'fixed') { fixed += 1; fixedOn = el.tagName + '.' + (el.className || ''); }
        });
        var imgs = Array.prototype.slice.call(dc.querySelectorAll('img'));
        var httpsImgs = imgs.filter(function (i) { return /^https:/.test(i.getAttribute('src') || ''); });
        return JSON.stringify({ ok: true,
          present: present,
          onAttrs: onAttrs, styleAttrs: styleAttrs, fixed: fixed, fixedOn: fixedOn,
          imgCount: imgs.length,
          httpsImgs: httpsImgs.length,
          httpsSrc: httpsImgs.length ? httpsImgs[0].getAttribute('src') : '',
          blockedImgs: dc.querySelectorAll('.fd-img-blocked').length,
          blockedText: (dc.querySelector('.fd-img-blocked') || {}).textContent || '',
          blockedTitle: (dc.querySelector('.fd-img-blocked') || {}).getAttribute
            ? dc.querySelector('.fd-img-blocked').getAttribute('title') : '',
          jsLinks: dc.querySelectorAll('a.fd-link-blocked').length,
          jsLinksWithHref: dc.querySelectorAll('a.fd-link-blocked[href]').length,
          text: dc.textContent || '',
          sanitize: (window.MM.Sanitize && window.MM.Sanitize.state()) || null,
          refreshMetas: document.querySelectorAll('meta[http-equiv="refresh"]').length,
          baseTags: document.querySelectorAll('base').length,
          frames: box.el.querySelectorAll('iframe, frame, frameset, object, embed, portal').length
        });
      })()`);
      const hrefAfter = await execJson(ctx, `JSON.stringify({ ok: true, href: String(location.href) })`);
      const st = r.sanitize || {};
      const droppedKeys = Object.keys(st.droppedByTag || {});
      const preflight = st.runs > 0 && droppedKeys.length > 0 && (st.remoteImgs || 0) >= 1;
      const ok = r.present.length === 0 && r.onAttrs === 0 && r.styleAttrs === 0 && r.fixed === 0
        && r.httpsImgs === 1 && /^https:\/\/example\.invalid\/remote\.png$/.test(r.httpsSrc)
        && r.blockedImgs === 1 && /拦下/.test(r.blockedText) && /拦下/.test(String(r.blockedTitle))
        && r.jsLinks === 1 && r.jsLinksWithHref === 0
        && r.refreshMetas === 0 && r.baseTags === 0 && r.frames === 0
        && hrefBefore.href === hrefAfter.href
        && preflight
        && r.text.indexOf('这段文字必须留下') >= 0;
      return {
        ok: ok,
        text: '容器内被禁标签元素=' + JSON.stringify(r.present) + '（应 []）· on* 属性=' + r.onAttrs
          + ' · style 属性=' + r.styleAttrs + ' · position:fixed 的元素=' + r.fixed + (r.fixedOn ? '（' + r.fixedOn + '）' : '')
          + ' · 图片共 ' + r.imgCount + ' 张：https 图保留=' + r.httpsImgs + '（src=' + JSON.stringify(r.httpsSrc) + '，'
          + '应原样 = 用户裁决允许）· 被拦下的可见占位=' + r.blockedImgs + '（' + JSON.stringify(r.blockedText)
          + '，title=' + JSON.stringify(String(r.blockedTitle).slice(0, 60)) + '，应只有**明文 http** 那一张）'
          + ' · javascript 链接被摘 href=' + (r.jsLinks === 1 && r.jsLinksWithHref === 0) + '（' + r.jsLinks + ' 个）'
          + ' · 页面上 meta refresh=' + r.refreshMetas + ' · base=' + r.baseTags + ' · 详情框内框架类元素=' + r.frames
          + ' · location 前后相同=' + (hrefBefore.href === hrefAfter.href)
          + ' ｜ 反向前置：消毒 runs=' + st.runs + ' dropped 键=' + JSON.stringify(droppedKeys)
          + ' 被拦图片计数=' + st.remoteImgs + ' ⇒ ' + preflight
          + ' ｜ 文字保留"这段文字必须留下"=' + (r.text.indexOf('这段文字必须留下') >= 0)
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ①b **隔离判据**：detail 里只有一张被拦图 ⇒ changed 必须为 true 且占位真进 DOM（bug①）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 隔离判据（bug①：可见占位必须真的到用户眼前）：detail 里**只有一张被拦图**、'
      + '没有任何别的必删项 ⇒ 那一次消毒的 `changed` 必须为 true，且占位 `.fd-img-blocked` **真在 DOM 里**'
      + '（文本含"拦下"、原文留在 data-blocked-src、框里没有活的 http 图）；'
      + '反向前置：本条先 `resetState()` 再取**自己的增量**（`D_EVIL` 那种"塞满一锅"的形态会把 changed 置真，测不到这件事）',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      /* 前置：夹具节点的 detail **真的只有那一张图**（写歪了这条断言就没有意义） */
      const raw = (cliJson(ctx, ['get', PROJ, N_IMG_ONE, '--json', '--detail']) || {}).detail;
      if (String(raw).indexOf('http://example.invalid/only.png') < 0) {
        return { ok: false, text: '前置失败：夹具 detail 里没有那张被拦图（' + JSON.stringify(String(raw).slice(0, 100)) + '）' };
      }
      const before = await execJson(ctx, `(function () {
        window.MM.Sanitize.resetState();
        return JSON.stringify({ ok: true, s: JSON.parse(JSON.stringify(window.MM.Sanitize.state())) });
      })()`);
      if (!before.ok) return { ok: false, text: '前置失败：消毒模块不在（' + before.text + '）' };
      const pinned = await pinDetailBox(ctx, N_IMG_ONE);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      await ctx.exec(SETTLE);
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var ph = dc.querySelectorAll('.fd-img-blocked');
        var imgs = Array.prototype.slice.call(dc.querySelectorAll('img'));
        var liveHttp = imgs.filter(function (i) { return /^http:/i.test(i.getAttribute('src') || ''); });
        return JSON.stringify({ ok: true,
          placeholders: ph.length,
          phText: ph.length ? String(ph[0].textContent || '') : '',
          phSrc: ph.length ? String(ph[0].getAttribute('data-blocked-src') || '') : '',
          phTitle: ph.length ? String(ph[0].getAttribute('title') || '') : '',
          imgs: imgs.length,
          liveHttp: liveHttp.length,
          inner: String(dc.innerHTML || ''),
          text: String(dc.textContent || ''),
          /* ⚠️ 必须**深拷贝**：state() 是浅拷贝，嵌套桶是同一个对象的引用（增量会自己追平） */
          s: JSON.parse(JSON.stringify(window.MM.Sanitize.state())) });
      })()`);
      if (!r.ok) return { ok: false, text: '取读数失败：' + r.text };
      const st = r.s || {};
      const b = before.s || {};
      const dRuns = (st.runs || 0) - (b.runs || 0);
      const dChanged = (st.changed || 0) - (b.changed || 0);
      const dImgs = (st.remoteImgs || 0) - (b.remoteImgs || 0);
      const bucket = (st.urlsBlockedByTag && st.urlsBlockedByTag['img-blocked']) || 0;
      const ok = dRuns >= 1 && dChanged >= 1 && dImgs >= 1
        && r.placeholders === 1 && r.imgs === 0 && r.liveHttp === 0
        && /拦下/.test(r.phText) && /only\.png$/.test(r.phSrc) && /拦下/.test(r.phTitle)
        && r.inner.indexOf('fd-img-blocked') >= 0
        && bucket >= 1 && typeof st.urlsBlocked === 'number' && st.urlsBlocked >= 1 && st.urlsBlocked === bucket;
      /* 为什么增量用 `>= 1` 而 DOM 计数用 `=== 1`：增量会被"这条断言窗口里渲染了几次"影响
       * （产品侧异步刷新可能多渲染一次），而 **DOM 里只能有 1 个占位** 这件事与渲染次数无关。
       * 判别力不受影响：bug① 形态下 changed 增量是 **0**、占位是 **0**、活图是 **1**。 */
      return {
        ok: ok,
        text: '夹具 detail=' + JSON.stringify(String(raw).slice(0, 70)) + '（**只有一张被拦图**）'
          + ' ｜ 消毒增量：runs +' + dRuns + ' · changed +' + dChanged + '（**这条是红线**：'
          + '漏了 `mutated = true` 它就停在 0 ⇒ 调用方注入原始字节 ⇒ 占位被丢弃）· 被拦图片 +' + dImgs
          + ' ｜ 框内：占位=' + r.placeholders + '（应 1）· 活 <img>=' + r.imgs + '（应 0）· 活的 http 图=' + r.liveHttp
          + ' · 占位文本=' + JSON.stringify(r.phText.slice(0, 60)) + ' · 原文=' + JSON.stringify(r.phSrc)
          + ' ｜ 计数器 urlsBlocked=' + JSON.stringify(st.urlsBlocked) + '（应数字 1）'
          + ' · 明细桶 urlsBlockedByTag["img-blocked"]=' + bucket + '（应 1）'
          + ' ｜ innerHTML 里含 `.fd-img-blocked`=' + (r.inner.indexOf('fd-img-blocked') >= 0)
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ①c **连续判据**：连续两次被拦图不许抛（bug② 的触发条件）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 连续判据（bug②：第二张被拦图起不许 TypeError）：**连续两次**送进被拦图'
      + '（"进入这次调用时 `state.urlsBlocked` 已为真值"正是那个 TypeError 的触发条件）⇒ 一次都不抛、'
      + '计数仍是数字、明细桶记满；再打开"两张连排"的夹具 ⇒ 两张都是占位（不丢第二张、也不抛）',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      /* 第一步：**同一页面上连续调 inject**（隔离地复现"上一次已经拦过图"这个前置状态） */
      const seq = await execJson(ctx, `(function () {
        try {
          window.MM.Sanitize.resetState();
          var mk = function () { return document.createElement('div'); };
          var d1 = mk(), d2 = mk(), d3 = mk();
          var r1 = window.MM.Sanitize.inject(d1, ${JSON.stringify(D_IMG_ONE)});
          var r2 = window.MM.Sanitize.inject(d2, ${JSON.stringify(D_IMG_SECOND)});
          var r3 = window.MM.Sanitize.inject(d3, ${JSON.stringify(D_IMG_TWO)});
          return JSON.stringify({ ok: true,
            chg: [r1.changed, r2.changed, r3.changed],
            ph: [d1.querySelectorAll('.fd-img-blocked').length,
                 d2.querySelectorAll('.fd-img-blocked').length,
                 d3.querySelectorAll('.fd-img-blocked').length],
            s: JSON.parse(JSON.stringify(window.MM.Sanitize.state())) });
        } catch (e) {
          return JSON.stringify({ ok: false, text: String((e && e.message) || e) });
        }
      })()`);
      if (!seq.ok) {
        return { ok: false, text: '连续两次被拦图**抛错了**（bug② 的触发条件命中）：' + seq.text };
      }
      const s1 = seq.s || {};
      const beforeOpen = await execJson(ctx, `JSON.stringify({ ok: true, s: JSON.parse(JSON.stringify(window.MM.Sanitize.state())) })`);
      const pinned = await pinDetailBox(ctx, N_IMG_TWO);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      await ctx.exec(SETTLE);
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var ph = dc.querySelectorAll('.fd-img-blocked');
        return JSON.stringify({ ok: true,
          placeholders: ph.length,
          texts: Array.prototype.slice.call(ph).map(function (x) { return String(x.textContent || ''); }),
          srcs: Array.prototype.slice.call(ph).map(function (x) { return String(x.getAttribute('data-blocked-src') || ''); }),
          text: String(dc.textContent || ''),
          s: JSON.parse(JSON.stringify(window.MM.Sanitize.state())) });
      })()`);
      if (!r.ok) return { ok: false, text: '取读数失败：' + r.text };
      const b2 = beforeOpen.s || {};
      const dBucket = ((r.s.urlsBlockedByTag || {})['img-blocked'] || 0) - ((b2.urlsBlockedByTag || {})['img-blocked'] || 0);
      const dCounter = (r.s.urlsBlocked || 0) - (b2.urlsBlocked || 0);
      const ok = seq.chg.join(',') === 'true,true,true'
        && seq.ph.join(',') === '1,1,2'
        && (s1.urlsBlockedByTag || {})['img-blocked'] === 4
        && typeof s1.urlsBlocked === 'number' && s1.urlsBlocked === 4
        && r.placeholders === 2 && dBucket >= 2 && dCounter >= 2
        && /两张被拦图/.test(r.text);
      return {
        ok: ok,
        text: '连续三次 inject（1 张 · 1 张 · **一次 2 张**）：changed=' + JSON.stringify(seq.chg)
          + ' · 占位=' + JSON.stringify(seq.ph) + '（应 [1,1,2]）'
          + ' · 明细桶 urlsBlockedByTag["img-blocked"]=' + JSON.stringify((s1.urlsBlockedByTag || {})['img-blocked'])
          + '（应 4）· 计数器 urlsBlocked=' + JSON.stringify(s1.urlsBlocked)
          + '（**必须是数字**；bug 形态下它会变成 "[object Object]1" 这种字符串）'
          + ' ｜ 再打开"两张连排"夹具：占位=' + r.placeholders + '（应 2）'
          + ' · 明细桶增量 +' + dBucket + ' · 计数器增量 +' + dCounter + '（应各 ≥ +2）'
          + ' · 占位原文=' + JSON.stringify(r.srcs) + ' · 别的文字还在=' + /两张被拦图/.test(r.text)
      };
    }
  },


  /* ----------------------------------------------------------------------
   * ② <details> 真能展开（真鼠标 + 真帧命中）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 <details> **真能展开**：真鼠标点 <summary> 的屏幕坐标 ⇒ open 变了、'
      + 'summary 高度变化 > 0、展开后新出现的块被 elementFromPoint 命中它自己且真帧有墨',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真鼠标，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, N_DETAILS);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };

      // 前置（也是本条的反向前置）：`details` **是**元素（白名单放行），它**初始折叠** ⇒
      // 折叠时 `<details>` 里那个块**不参与渲染**（`clientHeight === 0`、`elementFromPoint` 命中不到它）。
      // ⚠️ 判据**不能取 summary 的高度**（实测：summary 的高度开关前后都是 22px —— 展开是"下面多出一个块"，
      //    不是"summary 变高"；设计稿 §⑨-1 原文那句"summary 的 clientHeight 变化 > 0"**打不出来**，如实改掉）。
      const pre = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var d = dc.querySelector('details'), s = dc.querySelector('summary'), p = dc.querySelector('details p');
        ${hitPointExpr}
        if (!d || !s || !p) return JSON.stringify({ ok: false, text: '正文里没有 details/summary/内部块' });
        return JSON.stringify({ ok: true, open: d.open, sumH: s.clientHeight,
          paraH: p.clientHeight, paraHit: !!hitPt(p),
          bodyText: p.textContent || '', pt: hitPt(s),
          rects: { dpr: window.devicePixelRatio || 1, sum: rc(s) } });
      })()`);
      if (!pre.ok) return { ok: false, text: '前置失败：' + pre.text };
      /* ⚠️ 前置只认 **`open === false` + 命中测试 false**：实测**折叠状态下内部块的 `clientHeight` 仍是 22px**
       *   （Chromium 用 `content-visibility` 一族实现 details 的折叠 ⇒ **布局还在、像素不在**）——
       *   只用高度/矩形判"折没折"对这种情况是**盲的**（V1 门禁点名的那个形状：可见性不许靠 rect 判 ✗）。
       *   `elementFromPoint` 才是能分开这两态的尺子（折叠时命中不到它）。 */
      if (pre.open !== false || pre.paraHit !== false) {
        return { ok: false, text: '前置不成立：details 一开始就是展开的（open=' + pre.open
          + ' 内部块被命中=' + pre.paraHit + ' 高=' + pre.paraH + 'px）⇒ 测不到"展开"这件事，不许当通过' };
      }

      // 真鼠标点 summary（命中测试取到的屏幕坐标）
      if (!pre.pt) return { ok: false, text: '前置失败：summary 上找不到一个 elementFromPoint 能命中它的点' };
      await ctx.exec(`(function(){ var s = window.MM.fdPrimaryNodeBox().el.querySelector('.fd-detail-content summary');
        if (s && s.scrollIntoView) { try { s.scrollIntoView({ block: 'nearest' }); } catch (e) {} } return 1; })()`);
      await ctx.input.settle({ delayMs: 120 });
      const pt2 = await execJson(ctx, `(function () {
        var s = window.MM.fdPrimaryNodeBox().el.querySelector('.fd-detail-content summary');
        ${hitPointExpr}
        return JSON.stringify({ ok: !!s, pt: s ? hitPt(s) : null });
      })()`);
      if (!pt2.pt) return { ok: false, text: '前置失败：滚动后 summary 上没有可点坐标' };
      await ctx.input.click(pt2.pt, []);
      await ctx.input.settle({ delayMs: 320 });

      const expr = `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var d = dc.querySelector('details'), s = dc.querySelector('summary'), p = dc.querySelector('details p');
        ${hitPointExpr}
        var hit = false, pt = null;
        if (p) { pt = hitPt(p); hit = !!pt; }
        return JSON.stringify({ ok: true, open: !!d.open, sumH: s.clientHeight, paraH: p ? p.clientHeight : 0,
          hit: hit, pt: pt, paraText: p ? p.textContent : '',
          rects: { dpr: window.devicePixelRatio || 1, para: p ? rc(p) : null } });
      })()`;
      const cap = await captureUntil(ctx, expr, (r0, img) => {
        const ink = r0.rects.para ? frameStats.scanRegion(img, toDev(r0.rects.para, r0.rects.dpr),
          { predicate: frameStats.nonBackgroundPredicate() }) : null;
        return { pass: !!(ink && ink.ok && ink.hits > 0 && r0.hit === true), ink: ink };
      }, 3);
      if (!cap.ok) return { ok: false, text: '读数/取景失败：' + cap.text };
      const r0 = cap.rects;
      const shot = saveShot('52-1-details-open.png', cap.img);
      const ink = (cap.judged && cap.judged.ink) ? cap.judged.ink : { ok: false, hits: 0 };
      const ok = r0.open === true && r0.paraH > 0 && r0.hit === true
        && ink.ok === true && ink.hits > 0 && /折叠正文甲/.test(r0.paraText);
      return {
        ok: ok,
        text: '点之前：open=' + pre.open + ' · 内部块被 elementFromPoint 命中=' + pre.paraHit + '（应 false）'
          + ' · 内部块 clientHeight=' + pre.paraH + 'px（**不作判据**：折叠时它照样是 22px，见这段的注释）'
          + ' · summary 高=' + pre.sumH + 'px（读数，不作判据）'
          + ' ⇒ 点之后：open=' + r0.open + ' · 内部块**被命中**=' + r0.hit + '（点在 ' + JSON.stringify(r0.pt) + '）'
          + ' · 内部块高=' + r0.paraH + 'px · summary 高=' + r0.sumH + 'px'
          + ' · 真帧该块墨像素=' + (ink.hits || 0) + ' · 文本=' + JSON.stringify(r0.paraText)
          + ' · 帧=' + path.basename(shot.file) + ' sha256:' + shot.sha256
          + ' ｜ 重拍 ' + cap.attempts + ' 次'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ③ Mermaid 懒加载链：没图不加载 / 有图真渲染 / 坏图必降级
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 Mermaid 懒加载链：打开**没有图源**的节点时页面上没有 mermaid 的 script 与全局对象（懒）；'
      + '打开合法图源 ⇒ 真渲染出 svg（矩形 > 0 且真帧 ≥2 色）；打开非法图源 ⇒ **可见降级条**含"未渲染"与原因、'
      + '图源代码块一个字不丢（§⑨-2 的反向前置：两档都要出现，否则"接了没接"读数一样）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真帧，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      // ① 懒：先开一个**没有图源**的节点，此时页面里不该有 mermaid 的 script / 全局对象
      const pinned0 = await pinDetailBox(ctx, N_PLAIN);
      if (!pinned0.ok) return { ok: false, text: '前置失败：' + pinned0.text };
      await ctx.exec(SETTLE);
      const lazy = await execJson(ctx, `(function () {
        var scripts = Array.prototype.slice.call(document.querySelectorAll('script[src]'))
          .map(function (s) { return s.getAttribute('src'); })
          .filter(function (s) { return /mermaid/.test(s); });
        return JSON.stringify({ ok: true, scripts: scripts, globalMermaid: typeof window.mermaid,
          stats: window.MM.mdMermaidStats() });
      })()`);

      // ② 真渲染：合法图源
      const pinned1 = await pinDetailBox(ctx, N_MD_OK);
      if (!pinned1.ok) return { ok: false, text: '前置失败：' + pinned1.text };
      const waitOk = await (async () => {
        for (let i = 0; i < 60; i++) {
          const r = await execJson(ctx, `(function () {
            var box = window.MM.fdPrimaryNodeBox();
            var dc = box.el.querySelector('.fd-detail-content');
            var host = dc.querySelector('[data-mm-mermaid]');
            return JSON.stringify({ ok: true, state: host ? host.getAttribute('data-mm-mermaid') : null,
              fail: (dc.querySelector('.fd-mermaid-fail') || {}).textContent || '',
              scripts: Array.prototype.slice.call(document.querySelectorAll('script[src*="mermaid"]')).length,
              globalMermaid: typeof window.mermaid });
          })()`);
          if (r.state === 'ok') return r;
          if (r.fail) return r;
          await ctx.exec('new Promise(function (r) { setTimeout(r, 200); })');
        }
        return { state: null, fail: '', text: '等不到 mermaid 渲染结果（既没 ok 也没 fail）' };
      })();
      const expr = `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var host = dc.querySelector('[data-mm-mermaid]');
        var svg = dc.querySelector('.fd-mermaid svg');
        ${hitPointExpr}
        return JSON.stringify({ ok: true, state: host ? host.getAttribute('data-mm-mermaid') : null,
          hasSvg: !!svg, svgHit: svg ? !!hitPt(svg) : false,
          rects: { dpr: window.devicePixelRatio || 1, svg: svg ? rc(svg) : null } });
      })()`;
      let cap = null;
      if (waitOk.state === 'ok') {
        cap = await captureUntil(ctx, expr, (r0, img) => {
          const st = r0.rects.svg ? frameStats.analyzeRegion(img, toDev(r0.rects.svg, r0.rects.dpr)) : null;
          return { pass: !!(st && st.px > 0 && st.unique >= 2), stats: st };
        }, 3);
      }
      const mdOkShot = (cap && cap.ok) ? saveShot('52-2-mermaid-render.png', cap.img) : null;
      const okRect = (cap && cap.ok && cap.rects.rects.svg)
        ? { w: Math.round(cap.rects.rects.svg.width), h: Math.round(cap.rects.rects.svg.height) } : { w: 0, h: 0 };
      const okUniq = (cap && cap.judged && cap.judged.stats) ? cap.judged.stats.unique : 0;
      const renderPass = waitOk.state === 'ok' && okRect.w > 0 && okRect.h > 0 && okUniq >= 2;

      // ③ 必降级：非法图源
      const pinned2 = await pinDetailBox(ctx, N_MD_BAD);
      if (!pinned2.ok) return { ok: false, text: '前置失败：' + pinned2.text };
      const mdBad = await (async () => {
        for (let i = 0; i < 60; i++) {
          const r = await execJson(ctx, `(function () {
            var box = window.MM.fdPrimaryNodeBox();
            var dc = box.el.querySelector('.fd-detail-content');
            var f = dc.querySelector('.fd-mermaid-fail');
            var code = dc.querySelector('pre code');
            var pre = dc.querySelector('pre');
            ${hitPointExpr}
            return JSON.stringify({ ok: true, hasFail: !!f, failText: f ? f.textContent : '',
              failTitle: f ? f.getAttribute('title') : '', failHit: f ? !!hitPt(f) : false,
              codeText: code ? code.textContent : '', codeVisible: pre ? pre.clientHeight > 0 : false });
          })()`);
          if (r.hasFail) return r;
          await ctx.exec('new Promise(function (r) { setTimeout(r, 200); })');
        }
        return { hasFail: false, failText: '', text: '等不到降级条' };
      })();
      const badPass = mdBad.hasFail === true && /未渲染/.test(mdBad.failText)
        && String(mdBad.failText).length > 8 && /graph TD/.test(mdBad.codeText) && mdBad.codeVisible === true;
      if (mdBad.hasFail) {
        const capBad = await captureUntil(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          var f = box.el.querySelector('.fd-detail-content .fd-mermaid-fail');
          ${hitPointExpr}
          return JSON.stringify({ ok: !!f, rects: { dpr: window.devicePixelRatio || 1, f: f ? rc(f) : null } });
        })()`, (r0, img) => {
          const ink = r0.rects.f ? frameStats.scanRegion(img, toDev(r0.rects.f, r0.rects.dpr),
            { predicate: frameStats.nonBackgroundPredicate() }) : null;
          return { pass: !!(ink && ink.ok && ink.hits > 0), ink: ink };
        }, 3);
        if (capBad && capBad.ok) saveShot('52-3-mermaid-degrade.png', capBad.img);
      }

      const lazyPass = lazy.scripts.length === 0 && lazy.globalMermaid === 'undefined'
        && (lazy.stats.loaderSrc === '' || lazy.stats.loaderSrc === null || lazy.stats.loaderSrc === undefined);
      const ok = lazyPass && renderPass && badPass;
      return {
        ok: ok,
        text: '【懒】打开无图源节点时页面上 mermaid 的 script=' + JSON.stringify(lazy.scripts)
          + '（应 []）· typeof window.mermaid=' + lazy.globalMermaid + '（应 undefined）· loaderSrc='
          + JSON.stringify(lazy.stats && lazy.stats.loaderSrc)
          + ' ⇒ ' + lazyPass
          + ' ｜ 【真渲染】图区状态=' + waitOk.state + ' · svg 矩形=' + okRect.w + '×' + okRect.h
          + 'px（应都 > 0）· 真帧该矩形不同色数=' + okUniq + '（应 ≥ 2）'
          + ' · 加载后 script 数=' + waitOk.scripts + ' · typeof window.mermaid=' + waitOk.globalMermaid
          + ' ⇒ ' + renderPass + (mdOkShot ? ' · 帧=' + path.basename(mdOkShot.file) + ' sha256:' + mdOkShot.sha256 : '')
          + ' ｜ 【必降级】可见降级条=' + mdBad.hasFail + ' · 命中它自己=' + mdBad.failHit
          + ' · 文本=' + JSON.stringify(String(mdBad.failText).slice(0, 120))
          + ' · 图源代码块仍在（可见=' + mdBad.codeVisible + '）=' + JSON.stringify(String(mdBad.codeText).slice(0, 40))
          + ' ⇒ ' + badPass
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ④ 三类链接：常规路径（inline 档被真正消费 + 逃逸必拒）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 常规路径链接走**唯一判据**（src/path-chain.js 的 kind:inline）+ **唯一出口**（app:open-file）：'
      + '真鼠标点工程内相对路径 ⇒ 出口收到的绝对路径与 decide({kind:"inline"}) 逐字相同；'
      + '点 `..` 逃逸链接 ⇒ 出口**一次都不许被调**且状态栏可见报错；点本机绝对路径 ⇒ 走 localPath 档；'
      + '【外部链接出口批】点 `http(s)` 链接 ⇒ 走 **kind:externalUrl** 那一档，出口调用账里出现一条'
      + '`kind:"externalUrl"` 且 `abs` == decide({kind:"externalUrl"}).abs（= `new URL().href`）；'
      + '点白名单外的 `mailto:` ⇒ **出口仍只被调过那几次**（判据在出口之前就拒了）且状态栏点名该档 reason',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真鼠标，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, N_PATH);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };

      // 期望值取自**产品文件**（src/path-chain.js）现算，不在判据里再写一遍算式
      const pathChain = require('../../src/path-chain.js');
      const projFile = path.join(probeDir(), PROJ + '.json');
      const project = { file: projFile, name: PROJ };
      const expRel = pathChain.decide({ kind: 'inline', raw: 'assets/probe.txt', project: project });
      const expEsc = pathChain.decide({ kind: 'inline', raw: '../../../escape.txt', project: project });
      if (!expRel.ok || expEsc.ok) {
        return { ok: false, text: '前置失败：判据本身没给出预期（inline 相对=' + JSON.stringify(expRel)
          + ' · 逃逸=' + JSON.stringify(expEsc) + '）' };
      }
      const absDrive = 'E:\\r7\\probe.txt';
      const expAbs = pathChain.decide({ kind: 'localPath', raw: absDrive, project: project });

      // 出口那一跳在**主进程侧**记账（`ctx.openFileLog`）：渲染层的 `window.desktop.app` 是
      // contextBridge 冻结对象，断言**装不上记录器**（实测）⇒ 只能从主进程这一侧看。
      if (!ctx.openFileLog || !ctx.openFileLogClear) {
        return { ok: false, text: '采不到真值：冒烟底座没有提供出口调用账（ctx.openFileLog）⇒ 判红，不当通过' };
      }
      const led = () => ctx.openFileLog();
      ctx.openFileLogClear();

      const clickLink = async (text) => {
        const pt = await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          var dc = box.el.querySelector('.fd-detail-content');
          ${hitPointExpr}
          var links = Array.prototype.slice.call(dc.querySelectorAll('a'));
          var hit = null;
          for (var i = 0; i < links.length; i++) {
            if (String(links[i].textContent).indexOf(${JSON.stringify(text)}) >= 0) { hit = links[i]; break; }
          }
          if (!hit) return JSON.stringify({ ok: false, text: '找不到链接：' + ${JSON.stringify(text)},
            all: links.map(function (a) { return a.textContent; }) });
          var p = hitPt(hit);
          return JSON.stringify({ ok: !!p, pt: p, href: hit.getAttribute('href'), cls: hit.className });
        })()`);
        if (!pt.ok || !pt.pt) return pt;
        await ctx.input.click(pt.pt, []);
        await ctx.input.settle({ delayMs: 260 });
        return pt;
      };

      const c1 = await clickLink('本地相对');
      const r1 = { calls: led(), status: '' };
      void c1;
      const r1s = await execJson(ctx, `JSON.stringify({ ok: true, status: (document.querySelector('#status-text') || {}).textContent || '' })`);
      r1.status = r1s.status;
      const c2 = await clickLink('逃逸');
      const r2 = { calls: led(), status: '' };
      void c2;
      const r2s = await execJson(ctx, `JSON.stringify({ ok: true, status: (document.querySelector('#status-text') || {}).textContent || '' })`);
      r2.status = r2s.status;
      const c3 = await clickLink('本机绝对');
      const r3 = { calls: led(), status: '' };
      void c3;
      const r3s = await execJson(ctx, `JSON.stringify({ ok: true, status: (document.querySelector('#status-text') || {}).textContent || '' })`);
      r3.status = r3s.status;
      /* ---- 【外部链接出口批】④ 合法 http(s)：必须走 externalUrl 那一档 + 唯一出口 ---- */
      const c4 = await clickLink('外部网址');
      const r4 = { calls: led(), status: '' };
      void c4;
      const r4s = await execJson(ctx, `JSON.stringify({ ok: true, status: (document.querySelector('#status-text') || {}).textContent || '' })`);
      r4.status = r4s.status;
      /* ---- 【外部链接出口批】⑤ 白名单外的 mailto：判据在**出口之前**就拒 ⇒ 账本不许再长 ---- */
      const c5 = await clickLink('邮件');
      const r5 = { calls: led(), status: '' };
      void c5;
      const r5s = await execJson(ctx, `JSON.stringify({ ok: true, status: (document.querySelector('#status-text') || {}).textContent || '' })`);
      r5.status = r5s.status;

      const relOk = r1.calls.length === 1 && r1.calls[0].ok === true && r1.calls[0].abs === expRel.abs;
      const escOk = r2.calls.length === 1 && /打不开/.test(r2.status) && r2.status.indexOf('逃出') >= 0;
      const absOk = r3.calls.length === 2 && r3.calls[1].abs === expAbs.abs;
      // ④⑤ 的期望值同样**现算**自产品判据（不在这里再写一遍白名单/规范化算式）
      const expUrl = pathChain.decide({ kind: 'externalUrl', raw: URL_HTTP });
      const expMail = pathChain.decide({ kind: 'externalUrl', raw: URL_MAILTO });
      const urlOk = expUrl.ok === true && expUrl.action === 'external'
        && r4.calls.length === 3 && r4.calls[2].ok === true
        && r4.calls[2].kind === 'externalUrl' && r4.calls[2].abs === expUrl.abs
        // headless 的"没有真的交出去"必须**看得见**（不静默）
        && r4.status.indexOf('系统浏览器') >= 0;
      const mailOk = expMail.ok === false && expMail.code === 'path-url-scheme'
        && r5.calls.length === 3                       // **没有**新增第 4 条：出口在判据之后，压根没被调
        && /打不开/.test(r5.status) && r5.status.indexOf(expMail.reason) >= 0;
      const ok = relOk && escOk && absOk && urlOk && mailOk && expAbs.ok === true;
      return {
        ok: ok,
        text: '判据现算（src/path-chain.js）：inline 相对 ⇒ ' + JSON.stringify(expRel.abs)
          + '（action=' + expRel.action + '）；逃逸 ⇒ reject/' + expEsc.code + '；localPath ⇒ ' + JSON.stringify(expAbs.abs)
          + '；externalUrl ⇒ action=' + expUrl.action + '/' + JSON.stringify(expUrl.abs)
          + '；mailto ⇒ reject/' + expMail.code
          + ' ｜ 真鼠标点①本地相对：出口调用账=' + JSON.stringify(r1.calls) + ' ⇒ ' + relOk
          + ' ｜ 点②逃逸：调用账=' + JSON.stringify(r2.calls) + '（应仍只有第①次那一条 = 出口**没被调**）· 状态栏='
          + JSON.stringify(r2.status) + ' ⇒ ' + escOk
          + ' ｜ 点③本机绝对：调用账=' + JSON.stringify(r3.calls) + ' ⇒ ' + absOk
          + ' ｜ 点④外部网址：调用账=' + JSON.stringify(r4.calls) + ' ⇒ kind='
          + JSON.stringify((r4.calls[2] || {}).kind) + ' · 状态栏=' + JSON.stringify(r4.status) + ' ⇒ ' + urlOk
          + '（headless 下**不真开浏览器**，但判据照走、且如实回报"没有真的交出去"）'
          + ' ｜ 点⑤邮件：调用账=' + JSON.stringify(r5.calls) + '（**必须仍是 3 条** = 判据在出口之前就拒）· 状态栏='
          + JSON.stringify(r5.status) + ' ⇒ ' + mailOk
          + ' ｜ 账本来自**主进程**（渲染层的 window.desktop.app 是冻结对象，装不上记录器）'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑤ 站内链接：真鼠标点 ⇒ 目标被选中 + 滚到（真帧命中它自己）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 站内链接（`aimm://项目/节点id`）**真鼠标**点得动：目标节点被选中 + 被带进视野 + '
      + '真帧里命中它自己（复用 R7-0 的唯一实现 MM.followNodeRef，不切项目）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真鼠标，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, N_AIM);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };

      /* 前置：目标必须**在视野外**（否则"滚到目标"那一半没被测到 ⇒ 不许当通过 ✗） */
      const pre = await execJson(ctx, `(function () {
        var MM = window.MM;
        var panel = MM.fdPanel ? MM.fdPanel() : null;
        var el = document.querySelector('#jsmind_container jmnode[nodeid="${N_AIM_FAR}"]');
        function rc(e) { var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
        var pr = panel ? rc(panel) : null, nr = el ? rc(el) : null;
        var inside = !!(pr && nr && nr.width > 2 && nr.height > 2
          && nr.x >= pr.x && nr.y >= pr.y && nr.x + nr.width <= pr.x + pr.width
          && nr.y + nr.height <= pr.y + pr.height);
        return JSON.stringify({ ok: true, hasEl: !!el, inside: inside });
      })()`);
      if (pre.inside) {
        return { ok: false, text: '前置不成立：目标 ' + N_AIM_FAR + ' 打开项目后就落在面板里'
          + '（深链 ' + CHAIN + ' 层没把它顶出视野）⇒ 这条判据测不到"滚到目标"那一半 ⇒ 如实报红，不当通过' };
      }

      const pt = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var a = box.el.querySelector('.fd-detail-content a[href^="aimm://"]');
        ${hitPointExpr}
        if (!a) return JSON.stringify({ ok: false, text: '正文里没有 aimm:// 链接' });
        return JSON.stringify({ ok: true, pt: hitPt(a), href: a.getAttribute('href'), text: a.textContent,
          dangling: a.classList.contains('is-dangling'), title: a.getAttribute('title') });
      })()`);
      if (!pt.ok || !pt.pt) return { ok: false, text: '前置失败：站内链接不可点（' + (pt.text || '无坐标') + '）' };

      await ctx.input.click(pt.pt, []);
      await ctx.input.settle({ delayMs: 360 });

      const after = await execJson(ctx, `(function () {
        var MM = window.MM, st = window.MMApp.getState();
        var sel = MM.adapter.getSelected(st.jm);
        var proj = (st.project || {}).name || '';
        if (MM.closeAllFloatDetail) MM.closeAllFloatDetail();
        return JSON.stringify({ ok: true, selected: sel ? sel.id : null, project: proj,
          boxes: document.querySelectorAll('.float-detail').length });
      })()`);
      const cap = await captureUntil(ctx, `(function () {
        var MM = window.MM;
        var panel = MM.fdPanel ? MM.fdPanel() : null;
        var el = document.querySelector('#jsmind_container jmnode[nodeid="${N_AIM_FAR}"]');
        function rc(e) { var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
        var pr = panel ? rc(panel) : null, nr = el ? rc(el) : null;
        var inside = !!(pr && nr && nr.width > 2 && nr.height > 2
          && nr.x >= pr.x && nr.y >= pr.y && nr.x + nr.width <= pr.x + pr.width
          && nr.y + nr.height <= pr.y + pr.height);
        var hit = false;
        if (nr) {
          var p = { x: Math.round(nr.x + nr.width / 2), y: Math.round(nr.y + Math.round(nr.height / 2)) };
          var at = document.elementFromPoint(p.x, p.y);
          hit = !!(at && el && (at === el || el.contains(at)));
        }
        return JSON.stringify({ ok: !!el, inside: inside, hit: hit, hasEl: !!el,
          rects: { dpr: window.devicePixelRatio || 1, target: nr, panel: pr } });
      })()`, (r0, img) => {
        const ink = r0.rects.target ? frameStats.scanRegion(img, toDev(r0.rects.target, r0.rects.dpr),
          { predicate: frameStats.nonBackgroundPredicate() }) : null;
        return { pass: !!(ink && ink.ok && ink.hits > 0 && r0.hit && r0.inside), ink: ink };
      }, 3);
      const shot = cap.ok ? saveShot('52-4-aimm-jump.png', cap.img) : null;
      const r0 = cap.ok ? cap.rects : { inside: false, hit: false, hasEl: false };
      const ink = (cap.ok && cap.judged && cap.judged.ink) ? cap.judged.ink : { ok: false, hits: 0 };
      const ok = after.selected === N_AIM_FAR && after.project === PROJ
        && r0.inside === true && r0.hit === true && ink.ok === true && ink.hits > 0
        && pt.dangling === false;
      return {
        ok: ok,
        text: '链接=' + JSON.stringify(pt.href) + '（文案 ' + JSON.stringify(pt.text) + '，坏引用态='
          + pt.dangling + '）⇒ 点后选中=' + JSON.stringify(after.selected) + '（应 ' + N_AIM_FAR + '）· 当前项目='
          + after.project + ' · 目标在面板内=' + r0.inside + ' · 真帧命中它自己=' + r0.hit
          + ' · 墨像素=' + (ink.hits || 0)
          + (shot ? ' · 帧=' + path.basename(shot.file) + ' sha256:' + shot.sha256 : '') + ' ｜ 重拍 ' + (cap.attempts || 0) + ' 次'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑥ 笔记锚点：关键词成链接 ⇒ 真鼠标点开那篇笔记（且正文逐字节不变）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 笔记锚点（assoc.anchors[{text}]）：正文里的关键词成为 `.fd-notelink`、'
      + '真鼠标点它 ⇒ 新浮窗（dataset.boxId 落在 createFdBox 的递增序列上）且标题含那篇笔记的标题；'
      + '同时正文 detail **逐字节不变**（锚点声明在笔记侧）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真鼠标，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const detailBefore = (cliJson(ctx, ['get', PROJ, N_NOTE, '--json', '--detail']) || {}).detail;
      const shaBefore = crypto.createHash('sha256').update(String(detailBefore), 'utf8').digest('hex');

      const pinned = await pinDetailBox(ctx, N_NOTE);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      // 锚点链接是**异步**出现的（详情框先出文字、拿到 assoc 视图后再标记关键词）⇒ 等它出现
      let stk = null;
      for (let i = 0; i < 40; i++) {
        stk = await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          var dc = box.el.querySelector('.fd-detail-content');
          var a = dc.querySelector('a.fd-notelink');
          ${hitPointExpr}
          var maxId = 0;
          Array.prototype.slice.call(document.querySelectorAll('.float-detail')).forEach(function (b) {
            var m = /^fd(\\d+)$/.exec(b.dataset.boxId || ''); if (m) maxId = Math.max(maxId, Number(m[1]));
          });
          return JSON.stringify({ ok: true, has: !!a, text: a ? a.textContent : '',
            href: a ? a.getAttribute('href') : '', dangling: a ? a.classList.contains('is-dangling') : null,
            title: a ? a.getAttribute('title') : '', pt: a ? hitPt(a) : null,
            color: a ? getComputedStyle(a).color : '', deco: a ? getComputedStyle(a).textDecorationLine : '',
            boxId: box.el.dataset.boxId, maxId: maxId,
            entries: dc.querySelectorAll('a.fd-notelink').length,
            anchorState: window.MM.mdAnchorState ? window.MM.mdAnchorState() : null,
            assocEntries: box.el.querySelectorAll('.fd-assoc .assoc-entry').length });
        })()`);
        if (stk.has && stk.pt) break;
        await ctx.exec('new Promise(function (r) { setTimeout(r, 200); })');
      }
      if (!stk || !stk.has) {
        return { ok: false, text: '前置失败：正文里没有出现 `.fd-notelink`（锚点没被消费）· 读数='
          + JSON.stringify(stk) + ' · 锚点标记读数(MM.mdAnchorState)=' + JSON.stringify(stk && stk.anchorState) };
      }
      if (!stk.pt) return { ok: false, text: '前置失败：锚点链接上没有可点坐标：' + JSON.stringify(stk) };

      await ctx.input.click(stk.pt, []);
      await ctx.input.settle({ delayMs: 420 });

      const after = await execJson(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var assoc = boxes.filter(function (b) { return /^fd(\\d+)$/.test(b.dataset.boxId || '')
          && b.querySelector('.fd-title') && /关联笔记/.test(b.querySelector('.fd-title').textContent); });
        var top = assoc.length ? assoc[assoc.length - 1] : null;
        return JSON.stringify({ ok: true, boxes: boxes.length,
          boxIds: boxes.map(function (b) { return b.dataset.boxId; }),
          assocIds: assoc.map(function (b) { return b.dataset.boxId; }),
          assocTitle: top ? top.querySelector('.fd-title').textContent : '',
          assocNote: top ? (top.querySelector('.assoc-note') || {}).textContent || '' : '' });
      })()`);
      const newId = after.assocIds.length ? Number(/^fd(\d+)$/.exec(after.assocIds[after.assocIds.length - 1])[1]) : 0;
      const seqOk = after.assocIds.length === 1 && newId > stk.maxId;
      const detailAfter = (cliJson(ctx, ['get', PROJ, N_NOTE, '--json', '--detail']) || {}).detail;
      const shaAfter = crypto.createHash('sha256').update(String(detailAfter), 'utf8').digest('hex');
      const bytesSame = shaBefore === shaAfter && String(detailBefore) === String(detailAfter);
      const ok = stk.text === ANCHOR_TEXT && stk.dangling === false && seqOk
        && /S52 锚点笔记/.test(after.assocTitle) && after.assocNote.length > 0
        && bytesSame && stk.color === 'rgb(138, 106, 0)' && stk.deco === 'none';
      return {
        ok: ok,
        text: '正文里的锚点链接=' + JSON.stringify(stk.text) + '（应 ' + JSON.stringify(ANCHOR_TEXT) + '）· 坏引用态='
          + stk.dangling + ' · 计算色=' + stk.color + ' · text-decoration=' + stk.deco
          + ' · 点前最大 boxId=fd' + stk.maxId + ' ⇒ 点后浮窗=' + JSON.stringify(after.boxIds) + '（关联页 '
          + JSON.stringify(after.assocIds) + '，应恰好 1 个且序号更大=' + seqOk + '）'
          + ' · 关联页标题=' + JSON.stringify(after.assocTitle) + ' · 笔记正文=' + JSON.stringify(after.assocNote.slice(0, 40))
          + ' ｜ 正文逐字节不变=' + bytesSame + '（sha256 ' + shaBefore.slice(0, 12) + ' → ' + shaAfter.slice(0, 12)
          + '，' + String(detailBefore).length + ' 字符）'
          + ' ｜ 本页笔记入口数=' + stk.assocEntries
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑦ 失效锚点响亮（不静默消失）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 锚点失效**响亮**（不静默死链）：把正文里的关键词改掉之后 ⇒ 那篇笔记**仍在**'
      + '「本页笔记」区（可见 + 带原因），且 `validate --anchors` **判红并点名** `项目/节点id#text:关键词`；'
      + '默认 `validate` 照旧通过（写盘闸门不受弱判据牵连）',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      // 改写正文（关键词消失）——这一跳**必须成功**（否则"锚点失效"这条路径根本走不到）
      const editOut = cli(ctx, ['edit', PROJ, N_NOTE, '--detail', '<p>正文里那句话被改写了</p>']).out;
      const detailNow = (cliJson(ctx, ['get', PROJ, N_NOTE, '--json', '--detail']) || {}).detail;
      if (String(detailNow).indexOf(ANCHOR_TEXT) >= 0) {
        return { ok: false, text: '前置失败：改写没生效（正文里还有关键词）· CLI=' + editOut.trim() };
      }
      /* ⚠️ 必须**让渲染层重新读盘**：CLI 改的是沙箱里的文件，而界面里的树是**内存**那份
       *   ⇒ 不重开会话地直接 `pinDetailBox` 读到的还是改写之前的正文（本批实测：`.fd-notelink` 仍是 1，
       *   看着像"失效锚点没生效"，其实是判据在量一份陈旧数据）。 */
      try { ctx.win.webContents.reload(); } catch (e) { /* 下面按轮询判 */ }
      let reopened = { ok: false };
      for (let i = 0; i < 60; i++) {
        await ctx.exec('new Promise(function (r) { setTimeout(r, 100); })');
        reopened = await openFixture(ctx);
        if (reopened.ok) break;
      }
      if (!reopened.ok) return { ok: false, text: '前置失败：改写后重开项目失败 —— ' + reopened.text };
      const vDefault = cli(ctx, ['validate', PROJ]);
      const vAnchors = cli(ctx, ['validate', PROJ, '--anchors']);

      const pinned = await pinDetailBox(ctx, N_NOTE);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      let see = null;
      for (let i = 0; i < 40; i++) {
        see = await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          var dc = box.el.querySelector('.fd-detail-content');
          var rows = Array.prototype.slice.call(box.el.querySelectorAll('.fd-assoc .assoc-entry'));
          var ids = rows.map(function (r) { return r.getAttribute('data-i'); });
          ${hitPointExpr}
          var hitRow = rows.length ? rows[0] : null;
          return JSON.stringify({ ok: true, rows: rows.length, ids: ids,
            titles: rows.map(function (r) { return r.textContent; }),
            hasNotelink: dc.querySelectorAll('a.fd-notelink').length,
            rowPt: hitRow ? hitPt(hitRow) : null,
            rowClass: hitRow ? hitRow.className : '',
            rowTitle: hitRow ? hitRow.getAttribute('title') : '' });
        })()`);
        if (see.rows > 0) break;
        await ctx.exec('new Promise(function (r) { setTimeout(r, 200); })');
      }
      const named = /a-s52-note#text:/.test(vAnchors.out) || /#text:三次握手/.test(vAnchors.out);
      const ok = see.rows === 1 && see.hasNotelink === 0
        && /S52 锚点笔记/.test(String(see.titles.join('|')))
        && /未写|尚未|锚点|失效/.test(String(see.titles.join('|')))
        && vAnchors.ok === false && named && vDefault.ok === true;
      return {
        ok: ok,
        text: '改写后正文=' + JSON.stringify(String(detailNow).slice(0, 40)) + '（关键词已不在）'
          + ' ｜ 默认 validate：' + JSON.stringify(String(vDefault.out).trim().slice(0, 60)) + ' ⇒ exit0=' + vDefault.ok
          + ' ｜ validate --anchors：' + JSON.stringify(String(vAnchors.out).trim().slice(0, 200)) + ' ⇒ exit0=' + vAnchors.ok
          + '（应 false 且点名 #text:三次握手=' + named + '）'
          + ' ｜ 界面「本页笔记」行数=' + see.rows + '（应仍为 1）· 行文案=' + JSON.stringify(String(see.titles.join('|')).slice(0, 120))
          + ' · 正文里 .fd-notelink 数=' + see.hasNotelink + '（应 0：词没了就不该有链接）'
          + ' · 行 title=' + JSON.stringify(String(see.rowTitle).slice(0, 120))
          + ' ｜ 修法已给（assoc-edit --anchor / --clear-anchors；**assoc-prune 只报不剪**）'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑧ 既有语料不被砸（规模现算 + 全量分批）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 既有 detail 语料不被砸（§⑨-7 的规模版）：把**现算**出来的全仓 detail 分批送进页面逐个消毒，'
      + '断言①"消毒没动过字节的那些"里浏览器 `textContent` 与 `src/convert.js` 的 `stripHtml` **逐字相同**；'
      + '②"消毒改过的那些"里**原有可见文字一个不少**（子序列判定——补上"消毒删字"那条溜过①的路）；'
      + '③覆盖面**三档**：真漏读快照里的条目 ⇒ **判红**；"真实目录现算"与"本轮快照"不同（有人在并发写语料）⇒ '
      + '**只报告**并打印 Δ + 真实侧指纹证据（**不判红**，见本条开头那段实测依据）。'
      + '分母一律来自 scripts/detail-census.js 的现算，**不写死任何语料数字**',
    run: async (ctx) => {
      const cen = census.censusAll();
      if (cen.error) return { ok: false, text: '采不到真值：' + cen.error };
      const total = census.total(cen.rows).withDetail;
      if (!(total > 0)) {
        return { ok: false, text: '现算真值 = 0 个含 detail 的节点 ⇒ **采不到真值不是通过**（项目被清空？读错目录？）' };
      }
      /* ⭐ 【2026-10-19 复核批】把"覆盖面"改成**三档**，理由是一条实测假红：
       *   本条原来拿 `census.censusAll()`（**真实** `projects/`，断言运行那一刻）当分母，却从**沙箱副本**
       *   （进程启动那一刻拷的）读 detail 字节 —— **两个快照**。只要同机有别的批在写语料，两者必然不等
       *   ⇒ `items.length === total` 恒假 ⇒ **每次都红**，而红的是"别人在写"，不是产品缺陷。
       *   实测（本批）：`SMOKE_ONLY=52` 一次运行里 真实=1507 / 副本=1457（Δ=50），同一秒
       *   `book-linux-src-fun.json` 的 sha1 在 14:49:49 变过一次（真实=c406fdb56040 → 现值 cf495caefa94）。
       *   ⚠️ 同域的 ⑧b（真实语料**真渲染**）**早就**是这个口径（分母取副本、真实目录只作参照打印）——
       *   本条是与它对齐，不是新发明一种口径。
       * ⇒ 现在的判定分三档（答案空间要 ≥ 状态数，见 B4b；三档都要能说出"它凭什么是这个档"）：
       *   ① **覆盖一致**：`items.length === copyTotal === total` ⇒ 通过（覆盖 100% 且与真实现算相同）；
       *   ② **只报告（不判红）**：`items.length === copyTotal` 而 `total !== copyTotal`
       *      ⇒ 我们**没漏副本里的任何一条**，只是"真实目录"与"本轮快照"不同；打印 Δ + 真实侧文件指纹读数
       *      + 放行理由。**这一档不是豁免、也不是放宽**：真漏读会落到 ③；
       *   ③ **判红**：副本里读不出/缺项目（`copyBad`/`copyMissing`）或 `items.length < copyTotal`
       *      ⇒ 我们**漏读了快照里的 N 条**（真缺陷 / 采不到真值）。
       * 免责边界（如实写）：副本被"撕成半截但还能解析"这种退化，本条**判不了** —— 那是
       * `scripts/smoke/tear-snapshot.js` 的诊断（它只报告、不判红），别以为本条的 ② 覆盖了它。 */
      const copyDir = process.env.AI_MINDMAP_PROJECTS_DIR || '';
      /** 真实侧 `.json` 的指纹（**独立于被渲染的字节**：判"两个快照不同"这件事的正证据） */
      const realFp = (() => {
        const out = {};
        for (const row of cen.rows) {
          try {
            out[row.project] = crypto.createHash('sha1')
              .update(fs.readFileSync(path.join(ROOT, 'projects', row.project, row.project + '.json')))
              .digest('hex').slice(0, 12);
          } catch (e) { out[row.project] = 'ERR'; }
        }
        return out;
      })();
      /* 副本口径的**现算**分母：**复用** `census.censusProjectFile`（不在本文件写第二份数法），
       * 且**独立于** `items` 的收集路径（items 读不出来的文件在这里会显式记成 bad/missing ⇒ 判红）。 */
      const copyStats = { total: 0, bad: [], missing: [] };
      for (const row of cen.rows) {
        const f = path.join(copyDir, row.project, row.project + '.json');
        if (!copyDir || !fs.existsSync(f)) { copyStats.missing.push(row.project); continue; }
        try { copyStats.total += census.censusProjectFile(f, row.project).withDetail; }
        catch (e) { copyStats.bad.push(row.project + '：' + ((e && e.message) || e)); }
      }
      // 收集语料（读的是冒烟沙箱副本，绝不碰真实数据）
      const items = [];
      cen.rows.forEach((row) => {
        const f = path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', row.project, row.project + '.json');
        let j;
        try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return; }
        census.collectNodes(j.data).forEach((n) => {
          const d = n && n.detail;
          if (typeof d === 'string' && d.trim()) items.push({ id: row.project + '/' + n.id, d: d });
        });
      });
      // 分批（每批 ≤ 120 KB，避免把一条巨大的 executeJavaScript 参数传过去）
      const batches = [];
      let cur = [], size = 0;
      items.forEach((it) => {
        const n = it.d.length + 16;
        if (size + n > 120 * 1024 && cur.length) { batches.push(cur); cur = []; size = 0; }
        cur.push(it); size += n;
      });
      if (cur.length) batches.push(cur);

      let checked = 0, unchangedMismatch = 0, changed = 0, thrown = 0, textLoss = 0;
      const samples = [];
      const errSamples = [];
      const lossSamples = [];
      for (const b of batches) {
        const r = await execJson(ctx, `(function () {
          try {
            var arr = ${JSON.stringify(b)};
            var host = document.createElement('div');
            var mism = [], chg = 0, errs = [], textLoss = [];
            /* ⚠️ 这个正则**必须用构造式**（new RegExp(...) + 从主进程 JSON.stringify 传进来的源串）：
             * 字面量正则写在**模板字符串**里时，短横线斜杠加反斜杠 1 那一串会被模板字符串解析成**八进制转义**
             * ⇒ 整个文件在**加载期**就抛 Octal escape sequences are not allowed in template strings
             * （实测：冒烟断言入口一 require 全部域就崩，G4 集成段因此整段挂掉）。
             * ⚠️ 同理：这段注释里**不许出现反引号**（模板字符串会被它提前截断 —— 同一坑的另一种死法，
             * 域 47 的文件头也记过同一条）。 */
            var DROP_RE = new RegExp(${JSON.stringify(DROP_RE_SRC)}, 'gi');
            /* 子序列判定：消毒**改过**的样本（属性被删、占位被换、被禁子树被删）里，
             * 改造之前的可见文字必须**一个不少**地还在（顺序不变、允许中间插进占位文字）。
             * 为什么加这一档：只比"没改过的那些"会留一个洞 —— 消毒若**删掉正文里的字**，
             * 它必然把这条样本标成 changed，于是从"逐字相同"那一档里溜出去 ✗（本批自己发现了这个洞）。 */
            var isSubseq = function (needle, hay) {
              var i = 0;
              for (var j = 0; j < hay.length && i < needle.length; j++) { if (hay.charAt(j) === needle.charAt(i)) i++; }
              return i === needle.length;
            };
            for (var i = 0; i < arr.length; i++) {
              try {
                var res = window.MM.Sanitize.sanitize(arr[i].d, { project: null });
                host.innerHTML = res.changed ? res.html : arr[i].d;
                var sq = function (s) { return String(s).replace(/\\s+/g, ''); };
                var got = sq(host.textContent || '');
                if (res.changed) {
                  chg += 1;
                  var base = window.MMConvert.stripHtml(String(arr[i].d).replace(DROP_RE, ' '));
                  if (!isSubseq(sq(base), got) && textLoss.length < 3) {
                    textLoss.push({ id: arr[i].id, expected: sq(base).slice(0, 50), got: got.slice(0, 50) });
                  }
                  continue;
                }
                var expected = window.MMConvert.stripHtml(arr[i].d);
                if (sq(expected) !== got) {
                  if (mism.length < 3) mism.push({ id: arr[i].id, expected: sq(expected).slice(0, 60), got: got.slice(0, 60) });
                }
              } catch (e) {
                // 单条抛错**不许打断整批**（否则 1327 条里的一条怪数据会让判据没有读数）；
                // 点名是哪一条 + 前 60 字，判据侧照样按"有抛错"判红。
                if (errs.length < 3) errs.push({ id: arr[i].id, msg: String((e && e.message) || e).slice(0, 160),
                  stack: String((e && e.stack) || '').slice(0, 300), len: String(arr[i].d).length,
                  snip: String(arr[i].d).slice(0, 300) });
              }
            }
            return JSON.stringify({ ok: true, n: arr.length, chg: chg, mism: mism, errs: errs, textLoss: textLoss });
          } catch (e) {
            return JSON.stringify({ ok: false, text: '页面侧抛错：' + String((e && e.message) || e)
              + '（本批 ' + ${JSON.stringify(b.length)} + ' 条，首条 id=' + ${JSON.stringify(String(b[0] && b[0].id))} + '）' });
          }
        })()`);
        if (!r.ok) return { ok: false, text: '取语料读数失败：' + r.text };
        checked += r.n;
        changed += r.chg;
        unchangedMismatch += r.mism.length;
        if (r.mism.length && samples.length < 3) samples.push(r.mism[0]);
        if (r.errs && r.errs.length) {
          thrown += r.errs.length;
          if (errSamples.length < 3) errSamples.push(r.errs[0]);
        }
        if (r.textLoss && r.textLoss.length) {
          textLoss += r.textLoss.length;
          if (lossSamples.length < 3) lossSamples.push(r.textLoss[0]);
        }
      }
      const cover = items.length ? (checked / items.length) : 0;
      /* ---- 三档判定（口径见本条开头那段注释） ---- */
      const snapshotDelta = total - copyStats.total;          // 真实 − 副本（**只报告**）
      const readShort = copyStats.total - items.length;       // 副本里我们**没读到的条数**（>0 ⇒ 判红）
      const copyBroken = copyStats.missing.concat(copyStats.bad);
      const tier = (copyBroken.length || readShort > 0) ? '判红'
        : (snapshotDelta !== 0 ? '只报告' : '覆盖一致');
      /* 真实侧指纹在断言窗口里变没变（证据；只打印，不参与判定 —— 真实侧的任何变化都**不是**本次写的，
       * 本次只写沙箱副本；"真实数据零写入"那条由 main.js 的守卫单独判）。 */
      const realFpAfter = {};
      for (const row of cen.rows) {
        try {
          realFpAfter[row.project] = crypto.createHash('sha1')
            .update(fs.readFileSync(path.join(ROOT, 'projects', row.project, row.project + '.json')))
            .digest('hex').slice(0, 12);
        } catch (e) { realFpAfter[row.project] = 'ERR'; }
      }
      const realMoved = Object.keys(realFp).filter((k) => realFp[k] !== realFpAfter[k])
        .map((k) => k + '(' + realFp[k] + '→' + realFpAfter[k] + ')');
      const ok = unchangedMismatch === 0 && thrown === 0 && textLoss === 0
        && tier !== '判红';
      return {
        ok: ok,
        text: '现算（scripts/detail-census.js）：' + cen.rows.length + ' 个项目'
          + ' · **真实** projects/ 里含 detail 的节点 = ' + total + '（**参照读数**：这个数会随并发写入变）'
          + ' · **本轮快照**（沙箱副本，与被渲染的字节同一份）里含 detail 的节点 = ' + copyStats.total
          + '（缺项目 ' + copyStats.missing.length + ' / 读不出 ' + copyStats.bad.length + '）'
          + ' ⇒ 覆盖面判定档 = **' + tier + '**'
          + (tier === '只报告'
            ? '（**放行理由**：我们**没有漏副本里的任何一条**（items ' + items.length + ' == 副本现算 ' + copyStats.total
              + '），只是"真实目录现算 ' + total + '" 与"本轮快照 ' + copyStats.total + '" 差 Δ=' + snapshotDelta
              + ' 条 —— 两个快照不同，不是缺陷；真实侧文件指纹在本断言窗口内的变化：'
              + (realMoved.length ? realMoved.join(' · ') : '**无**（变化发生在副本拍下之后、断言开始之前）')
              + '。⚠️ 这一档**不**等于"覆盖了全仓"：本节只对**快照里的 ' + copyStats.total + ' 条**负责）'
            : '')
          + (tier === '判红'
            ? '（**判红依据**：' + (copyBroken.length ? '副本里读不出/缺项目 ' + JSON.stringify(copyBroken) : '')
              + (readShort > 0 ? '我们漏读了快照里的 ' + readShort + ' 条（items ' + items.length
                + ' < 副本现算 ' + copyStats.total + '）' : '') + '）'
            : '')
          + ' · 送进页面逐个消毒=' + checked + '（占本轮语料 ' + (cover * 100).toFixed(1) + '%）'
          + ' · 消毒**没动过字节**的那些里文字不一致=' + unchangedMismatch + '（应 0）'
          + ' · 消毒**改过**的那些里"原有可见文字被删"=' + textLoss + '（应 0：允许新增占位文字，不允许丢字）'
          + (lossSamples.length ? ' · 丢字样本=' + JSON.stringify(lossSamples) : '')
          + ' · 消毒抛错=' + thrown + '（应 0）' + (errSamples.length ? ' · 抛错样本=' + JSON.stringify(errSamples) : '')
          + ' · 被消毒改动过的=' + changed + ' 个（**不判红**：含被禁构造的样本，消毒改它们正是设计意图 ——'
          + '逐条成因见 .review/20261019-域52真渲染复核/复核读数.md）'
          + (samples.length ? ' · 不一致样本=' + JSON.stringify(samples) : '')
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑧b 真实语料**真渲染**（分层抽样 · 现算分母 · 现算 N）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 真实语料**真渲染**（分层抽样）：从**现算分母**里按"含表格 / 含 details / 含图片 / 含白名单标签数（分位点现算）/ 纯文本"分层抽样，'
      + '每条**逐个真渲染**（走产品唯一入口 MM.showDetail → renderFdBox → Sanitize.inject，落进真详情框的 .fd-detail-content），判①不抛错 '
      + '②可见文字 == stripHtml(detail)（既有范式，逐字）③该层该有的结构真的出现（表格真 <table>／details 真 <details>／图片真 <img> 且**非零几何**／'
      + '纯文本不进元素／其它层元素标签全在白名单内）；再对抽样里**最大那条**取一张**真帧**并用 elementFromPoint 命中它自己。'
      + '⚠️ 抽样是抽样：报文逐项打印"分母 / 抽了几条 / 每层几条 / 哪些层没有样本"，**不许**读成"全量都对"',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真帧/截图底座不在（ctx.input 为空）⇒ 采不到真帧，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      /* ---------- 1) 现算分母 + 分层抽样（全在 Node 侧，纯函数、可复现） ---------- */
      const plan = buildRenderPlan();
      if (!plan.ok) return { ok: false, text: plan.text };
      if (!plan.sampled.length) return { ok: false, text: '抽样结果是 0 条 ⇒ 没测就"通过"是最坏的假绿，判红 ✗' };
      /* 参照读数（**只打印、不判**）：真实目录的现算分母。
       * 为什么不当判据：真实目录正被别的会话写（`comnet.json`），把它和副本对齐会让**别人的写入**变成我们的红。 */
      let realTotal = null;
      try { realTotal = census.total(census.censusAll().rows).withDetail; } catch (e) { realTotal = 'ERR:' + ((e && e.message) || e); }

      /* ---------- 2) 摆好证据底座：把**旁路异步口**临时摘掉（正文渲染路径一字未改） ----------
       * 实测依据（这一批踩出来的，不是想当然）：`showDetail` / `renderFdBox` 一次渲染会打**四个**
       * 旁路 IPC（热度条两条 +「相关知识点」+「关联笔记」），**每一条都在主进程 spawn 一个 node 子进程**。
       * 71 条 × 2~4 个子进程 ⇒ 这一步的墙钟从 ~0.4s 涨到 **21902ms**（本域单跑 43.5s→70.5s），
       * 而**单条真渲染本身的中位数只有 3ms**（见报文）。
       * 摘掉的是**旁路采样**：它们写的是 `.fd-heat` / `.fd-assoc` / `.fd-related` 三个**别的容器**，
       * 与 `.fd-detail-content` 里被判的字节无关；`showDetail → renderFdBox → Sanitize.inject` 照原样跑。
       * 摘完**立刻还原并复核**（还原失败 ⇒ 判红），且**真帧那一张走完整入口**（含这四个旁路口）。 */
      const prep = await execJson(ctx, `(function () {
        var out = { ok: true, mmStub: false, deskStub: false, frozen: null };
        var MM = window.MM;
        if (!MM) return JSON.stringify({ ok: false, text: '没有 MM' });
        if (MM.closeAllFloatDetail) MM.closeAllFloatDetail();
        var o = window.__s52orig || (window.__s52orig = {});
        o.record = MM.heatBarsRecordHumanOpen || null;
        o.refresh = MM.heatBarsRefresh || null;
        o.desk = window.desktop || null;
        if (o.record) MM.heatBarsRecordHumanOpen = function () {};
        if (o.refresh) MM.heatBarsRefresh = function () {};
        out.mmStub = !!(o.record || o.refresh);
        var desk = o.desk, app = desk && desk.app;
        out.frozen = desk ? { desk: Object.isFrozen(desk), app: app ? Object.isFrozen(app) : null } : null;
        if (desk && app) {
          /* 换掉 assoc / related 两档（其余通道原样保留：markRefStates 还要用 nodes）。
           * 三种写法逐级退让（contextBridge 暴露的对象可能是冻结/不可写的，实测见报文）：
           *   ① 直接给 desktop.app 的两个属性赋值；
           *   ② Object.defineProperty(window, 'desktop', …) 换整个对象；
           *   ③ 直接 defineProperty 覆盖 app.assoc / app.related。 */
          var stubFn = function (name) {
            if (name === 'assoc') return function () { return Promise.resolve({ ok: true, rows: [], count: 0 }); };
            return function () { return Promise.resolve({ ok: true, items: [], count: 0 }); };
          };
          /* ① 属性赋值 */
          try {
            var a0 = app.assoc, r0 = app.related;
            app.assoc = stubFn('assoc'); app.related = stubFn('related');
            if (app.assoc !== a0 && app.related !== r0) { o.prop = true; o.a0 = a0; o.r0 = r0; out.deskStub = true; out.how = '属性赋值'; }
            else { app.assoc = a0; app.related = r0; }
          } catch (e5) { out.e5 = String((e5 && e5.message) || e5).slice(0, 80); }
          if (!out.deskStub) {
            /* ② 换整个 window.desktop（浅拷贝，其余键原样带上） */
            try {
              var fake = {};
              for (var k in app) { try { fake[k] = app[k]; } catch (e1) {} }
              fake.assoc = stubFn('assoc'); fake.related = stubFn('related');
              var nd = {};
              for (var k2 in desk) { try { nd[k2] = desk[k2]; } catch (e2) {} }
              nd.app = fake;
              try { window.desktop = nd; } catch (e3) {}
              if (window.desktop !== nd) {
                Object.defineProperty(window, 'desktop', { value: nd, configurable: true, writable: true });
              }
              if (window.desktop === nd) { o.fakeDesk = nd; out.deskStub = true; out.how = '换 window.desktop'; }
            } catch (e4) { out.e4 = String((e4 && e4.message) || e4).slice(0, 80); }
          }
          if (!out.deskStub) {
            /* ③ 对 app 上那两个键 redefine */
            try {
              o.a0 = app.assoc; o.r0 = app.related;
              Object.defineProperty(app, 'assoc', { value: stubFn('assoc'), configurable: true, writable: true });
              Object.defineProperty(app, 'related', { value: stubFn('related'), configurable: true, writable: true });
              if (String(app.assoc).indexOf('Promise.resolve') >= 0) { o.prop = true; out.deskStub = true; out.how = 'redefineProperty'; }
            } catch (e6) { out.e6 = String((e6 && e6.message) || e6).slice(0, 80); }
          }
        }
        return JSON.stringify(out);
      })()`);
      if (!prep.ok) return { ok: false, text: '证据底座没摆好：' + prep.text };

      /* ---------- 3) 逐个**真渲染**（一条样本一次 exec；**N 受现算预算约束**，不是写死的总数） ----------
       * 为什么一条一次：单条成本**现算**（含旁路 IPC 的排队时间），跑到预算就停 ⇒ 本判据对 G5 的
       * 增量有上限（`RENDER_TOTAL_BUDGET_MS`），不会因为它悄悄把冒烟推长。 */
      const oneSampleExpr = (s) => `(function () {
        try {
          var MM = window.MM;
          if (!MM) return JSON.stringify({ ok: false, text: '没有 MM' });
          var ALLOW = ${JSON.stringify(census.WHITELIST_TAGS)};
          var ALLOW_SET = {};
          for (var a = 0; a < ALLOW.length; a++) ALLOW_SET[ALLOW[a]] = true;
          var KEY_TAGS = ${JSON.stringify(RENDER_KEY_TAGS)};
          /* 数"源里这个标签的开标签有几个"：**用 indexOf 不用正则** ——
           * 本文件在模板字符串里写正则已经翻过两次车（八进制转义 / 反引号截断），这里干脆不写正则。 */
          function countOpen(low, tag) {
            var needle = '<' + tag, n = 0, i = 0, L = needle.length;
            while ((i = low.indexOf(needle, i)) >= 0) {
              var ch = low.charAt(i + L);
              if (ch === '' || ch === '>' || ch === '/' || ch === ' ' || ch === '\\n' || ch === '\\r' || ch === '\\t') n += 1;
              i += L;
            }
            return n;
          }
          /* 折掉空白再比（沿用第 ⑧ 条同一口径）。判空白用 char.trim() === ''（等价于 \\s），同样不写正则。 */
          function sq(s) {
            s = String(s === undefined || s === null ? '' : s);
            var o = '';
            for (var i = 0; i < s.length; i++) { var c = s.charAt(i); if (c.trim() === '') continue; o += c; }
            return o;
          }
          var d = ${JSON.stringify(s.d)}, low = String(d).toLowerCase();
          /* ⭐ **产品唯一入口**：showDetail → renderFdBox → MM.Sanitize.inject ⇒ 落进真详情框的正文容器。
           * 节点对象是**内存里造的**（不写盘、不进项目数据）—— 本段测的是"渲染路径吃真实语料字节"，
           * "从磁盘读节点"那一跳由 ⑧ 与其它域覆盖；这条边界也写在报文里。 */
          MM.showDetail({ id: 's52-corpus', topic: '语料样本', detail: d });
          var box = MM.fdPrimaryNodeBox ? MM.fdPrimaryNodeBox() : null;
          if (!box || !box.el) return JSON.stringify({ ok: false, err: '详情框没开起来' });
          box.el.style.left = '12px'; box.el.style.top = '12px';   // 取景确定（真帧那张也是同一个位置拍的）
          var dc = box.el.querySelector('.fd-detail-content');
          if (!dc) return JSON.stringify({ ok: false, err: '没有 .fd-detail-content' });
          var rec = { ok: true };
          /* ② 可见文字 vs stripHtml(detail)（既有范式） */
          var exp = sq(window.MMConvert.stripHtml(d));
          var got = sq(dc.textContent || '');
          rec.textOk = (exp === got);
          if (!rec.textOk) rec.textDiff = { expLen: exp.length, gotLen: got.length,
            exp: exp.slice(0, 48), got: got.slice(0, 48) };
          /* 结构：渲染出来的元素标签必须**全在白名单内**（白名单外的是 unwrapEl 拆壳 ⇒ 数它 = 判设计意图为缺陷） */
          var els = dc.querySelectorAll('*'), badTags = [], dom = {};
          for (var j = 0; j < els.length; j++) {
            var tg = String(els[j].tagName || '').toLowerCase();
            dom[tg] = (dom[tg] || 0) + 1;
            if (!ALLOW_SET[tg] && badTags.length < 6) badTags.push(tg);
          }
          rec.elements = els.length;
          rec.badTags = badTags;
          var layer = ${JSON.stringify(s.layer)};
          if (layer === 'table' || layer === 'details') {
            var one = (layer === 'table') ? 'table' : 'details';
            var want = countOpen(low, one), have = dom[one] || 0;
            rec.struct = one + '：源 ' + want + ' / 渲染 ' + have;
            rec.structOk = want > 0 && have === want && !badTags.length
              && (one !== 'table' || !!dc.querySelector('table tr'));
          } else if (layer === 'img') {
            var wantI = countOpen(low, 'img'), imgs = dc.querySelectorAll('img'), geo = [], zero = 0;
            for (var k2 = 0; k2 < imgs.length; k2++) {
              var b2 = imgs[k2].getBoundingClientRect();
              geo.push(Math.round(b2.width) + 'x' + Math.round(b2.height));
              if (!(b2.width > 0 && b2.height > 0)) zero += 1;
            }
            rec.struct = 'img：源 ' + wantI + ' / 渲染 ' + imgs.length + ' / 几何 ' + geo.join(',') + ' / 零几何 ' + zero;
            rec.structOk = wantI > 0 && imgs.length === wantI && zero === 0 && !badTags.length;
          } else if (layer === 'plain') {
            rec.struct = '纯文本：渲染出元素 ' + els.length + ' 个';
            rec.structOk = els.length === 0 && !badTags.length && got.length > 0;
          } else {
            var mism = [];
            for (var m2 = 0; m2 < KEY_TAGS.length; m2++) {
              var kt = KEY_TAGS[m2], w2 = countOpen(low, kt);
              if (!w2) continue;
              var h2 = dom[kt] || 0;
              if (h2 !== w2 && mism.length < 6) mism.push(kt + ' 源' + w2 + '/渲染' + h2);
            }
            rec.struct = '元素 ' + els.length + ' 个' + (mism.length ? ' · 不符：' + mism.join(' · ') : '');
            rec.structOk = els.length > 0 && mism.length === 0 && !badTags.length;
          }
          return JSON.stringify(rec);
        } catch (e) {
          /* ① 渲染抛错：**单条不打断整批**（否则一条怪数据就让本判据没有读数），判据侧照样判红 */
          return JSON.stringify({ ok: false, err: String((e && e.message) || e).slice(0, 200) });
        }
      })()`;
      const recs = [];
      let budgetUsed = 0;
      let stoppedByBudget = 0;
      for (const s of plan.sampled) {
        if (budgetUsed > RENDER_TOTAL_BUDGET_MS) { stoppedByBudget = plan.sampled.length - recs.length; break; }
        const t1 = Date.now();
        const one = await execJson(ctx, oneSampleExpr(s));
        const ms = Date.now() - t1;
        budgetUsed += ms;
        recs.push({ k: s.k, layer: s.layer, id: s.project + '/' + s.id, len: s.d.length, ms: ms,
          ok: one.ok === true, err: one.err, textOk: one.textOk, textDiff: one.textDiff,
          struct: one.struct, structOk: one.structOk, badTags: one.badTags, elements: one.elements });
      }

      /* ---------- 4) 立刻还原旁路口（**不许**把产品留在被改过的状态） ---------- */
      const clean = await execJson(ctx, `(function () {
        var MM = window.MM, o = window.__s52orig || {};
        if (MM) {
          if (o.record) MM.heatBarsRecordHumanOpen = o.record;
          if (o.refresh) MM.heatBarsRefresh = o.refresh;
        }
        var restored = true;
        if (MM && o.record && MM.heatBarsRecordHumanOpen !== o.record) restored = false;
        if (MM && o.refresh && MM.heatBarsRefresh !== o.refresh) restored = false;
        if (o.fakeDesk && o.desk && window.desktop === o.fakeDesk) window.desktop = o.desk;
        if (o.desk && window.desktop !== o.desk) restored = false;
        if (o.prop && o.desk && o.desk.app) {
          try { o.desk.app.assoc = o.a0; o.desk.app.related = o.r0; } catch (e1) { restored = false; }
          if (o.desk.app.assoc !== o.a0 || o.desk.app.related !== o.r0) restored = false;
        }
        try { delete window.__s52orig; } catch (e) {}
        return JSON.stringify({ ok: true, restored: restored, deskBack: !o.desk || window.desktop === o.desk });
      })()`);

      const thrown = recs.filter((x) => x.ok !== true);
      const textBad = recs.filter((x) => x.ok === true && x.textOk !== true);
      const structBad = recs.filter((x) => x.ok === true && x.structOk !== true);

      /* ---------- 5) 真帧：**真渲染过的那批里**最大的一条，走**完整入口**重渲染 + elementFromPoint 命中它自己 ----------
       * 为什么取"真渲染过的那批"而不是"计划抽的那批"：预算可能提前停 ⇒ 计划里最大的那条也许没被渲染过，
       * 拿它取帧就会让"真帧"与上面那批读数**不是同一批样本**（照 E3：判据与证据要同源）。两个数都打印。 */
      const planBiggest = plan.sampled.slice().sort((a, b) => b.d.length - a.d.length)[0];
      const byKey = {};
      plan.sampled.forEach((x) => { byKey[x.k] = x; });
      const renderedBiggest = recs.map((r2) => byKey[r2.k]).filter(Boolean)
        .sort((a, b) => b.d.length - a.d.length)[0] || null;
      const biggest = renderedBiggest || planBiggest;
      const pinned = await execJson(ctx, `(function () {
        var MM = window.MM;
        if (MM.closeAllFloatDetail) MM.closeAllFloatDetail();
        try {
          MM.showDetail({ id: 's52-corpus-frame', topic: '语料真帧', detail: ${JSON.stringify(biggest.d)} });
        } catch (e) { return JSON.stringify({ ok: false, text: '重渲染抛错：' + String((e && e.message) || e) }); }
        var box = MM.fdPrimaryNodeBox ? MM.fdPrimaryNodeBox() : null;
        if (!box || !box.el) return JSON.stringify({ ok: false, text: '详情框没开起来' });
        if (MM.setFdBoxLock && MM.FD_LOCK) MM.setFdBoxLock(box, MM.FD_LOCK.SCREEN);
        box.el.style.left = '12px'; box.el.style.top = '12px';
        return JSON.stringify({ ok: true });
      })()`);
      if (!pinned.ok) return {
        ok: false,
        text: '循环读数（先给证据，再报失败）：①渲染抛错=' + thrown.length + ' / ②可见文字≠stripHtml=' + textBad.length
          + ' / ③结构不符=' + structBad.length + '（本批真渲染 ' + recs.length + ' 条）'
          + (thrown.length ? ' · 抛错点名：' + JSON.stringify(thrown.slice(0, 3)) : '')
          + ' ｜ 真帧前置失败：' + pinned.text
      };
      await ctx.input.settle({ delayMs: 220 });
      const frameExpr = `(function () {
        ${hitPointExpr}
        var box = window.MM.fdPrimaryNodeBox ? window.MM.fdPrimaryNodeBox() : null;
        if (!box || !box.el) return JSON.stringify({ ok: false, text: '没有详情框' });
        var dc = box.el.querySelector('.fd-detail-content');
        if (!dc) return JSON.stringify({ ok: false, text: '没有 .fd-detail-content' });
        var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
        var els = dc.querySelectorAll('*'), cands = [];
        for (var i = 0; i < els.length; i++) {
          var b = els[i].getBoundingClientRect();
          if (!(b.width > 0 && b.height > 0)) continue;
          cands.push({ el: els[i], area: b.width * b.height });
        }
        cands.sort(function (p, q) { return q.area - p.area; });
        /* 目标块 = 正文里**面积最大、且中心点落在视口内能被 elementFromPoint 命中**的元素。
         * 为什么要这道筛选（如实说）：最大那条语料的正文比视口高，面积最大的块可能整体滚出视口 ——
         * 那时 elementFromPoint 取不到点是**正常**的（不是缺陷）；硬判它红就是拿尺子量不到当尺子坏了。 */
        var target = null, pt = null, rank = -1;
        for (var j = 0; j < cands.length && j < 60; j++) {
          var p2 = hitPt(cands[j].el);
          if (p2 && p2.x >= 0 && p2.y >= 0 && p2.x < vw && p2.y < vh) { target = cands[j].el; pt = p2; rank = j; break; }
        }
        if (!target) { target = dc; pt = hitPt(dc); rank = -1; }
        if (!target || !pt) {
          return JSON.stringify({ ok: false, text: '正文里没有任何元素被 elementFromPoint 命中（视口 ' + vw + 'x' + vh
            + ' · 元素 ' + els.length + ' 个）' });
        }
        var br = target.getBoundingClientRect();
        function cl(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
        var x0 = cl(br.left, 0, vw), y0 = cl(br.top, 0, vh);
        var x1 = cl(br.right, 0, vw), y1 = cl(br.bottom, 0, vh);
        if (!(x1 > x0 && y1 > y0)) return JSON.stringify({ ok: false, text: '目标块在视口外的部分取不到真帧证据' });
        return JSON.stringify({ ok: true, tag: String(target.tagName || '').toLowerCase(), rank: rank,
          cands: cands.length, pt: pt, text: String(target.textContent || '').slice(0, 48),
          rects: { dpr: window.devicePixelRatio || 1, target: rc(target),
            scan: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } } });
      })()`;
      const cap = await captureUntil(ctx, frameExpr, (r0, img) => {
        const ink = frameStats.scanRegion(img, toDev(r0.rects.scan, r0.rects.dpr),
          { predicate: frameStats.nonBackgroundPredicate() });
        return { pass: !!(ink && ink.ok && ink.hits > 0), ink: ink };
      }, 3);
      if (!cap.ok) {
        await execJson(ctx, '(function(){ if (window.MM && window.MM.closeAllFloatDetail) window.MM.closeAllFloatDetail(); return JSON.stringify({ok:true}); })()');
        return { ok: false, text: '真帧读数/取景失败（第 ' + (cap.attempts || 0) + ' 次）：' + (cap.text || '') };
      }
      const fr = cap.rects;
      const ink = (cap.judged && cap.judged.ink) ? cap.judged.ink : { ok: false, hits: 0 };
      const shot = saveShot('52-corpus-real-frame.png', cap.img);
      await execJson(ctx, '(function(){ if (window.MM && window.MM.closeAllFloatDetail) window.MM.closeAllFloatDetail(); return JSON.stringify({ok:true}); })()');

      /* ---------- 6) 耗时分布 + 超时项（**阈值现算**：4 × 本批中位数；只报告、不判红） ---------- */
      const msArr = recs.map((x) => x.ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
      const med = msArr.length ? msArr[Math.floor(msArr.length / 2)] : 0;
      const p90 = msArr.length ? msArr[Math.min(msArr.length - 1, Math.floor(msArr.length * 0.9))] : 0;
      const msMax = msArr.length ? msArr[msArr.length - 1] : 0;
      const slowCut = Math.max(50, med * 4);
      const slow = recs.filter((x) => x.ms > slowCut)
        .sort((a, b) => b.ms - a.ms)
        .map((x) => x.layer + '|' + x.id + ' (' + x.len + 'B / ' + x.ms + 'ms)');

      /* ---------- 7) 覆盖面 + 未覆盖项（**必须逐项打印**，不许让"抽样过了"被读成"全量对了"） ---------- */
      const strataTxt = plan.strata.map((s) => s.key + '=' + s.n + (s.n ? '→' + s.sampleN : '（**本层无样本**）')).join(' · ');
      const emptyLayers = plan.strata.filter((s) => !s.n).map((s) => s.label + '（' + s.key + '）');
      const unsampled = plan.denominator - recs.length;
      const cover = plan.denominator ? (recs.length / plan.denominator * 100) : 0;

      const ok = thrown.length === 0 && textBad.length === 0 && structBad.length === 0
        && clean.restored === true
        && ink.ok === true && ink.hits > 0 && fr.pt;
      return {
        ok: ok,
        text: '现算分母（**冒烟沙箱副本的内容 + 真实 `projects/` 的目录名**；与被渲染的字节同一快照）= '
          + plan.denominator + ' 条含 detail 的节点'
          + '（真实目录参照读数 = ' + realTotal + '，**只作参照不参与判定**：并发写入时两者本来就会不同）'
          + ' · 排除的非真实项目（冒烟夹具）' + plan.excluded.length + ' 个'
          + (plan.excluded.length ? '：' + plan.excluded.map((x) => x.project + '(' + x.withDetail + '条)').join(' · ') : '')
          + ' ｜ 分层与抽样（每层 N = clamp(ceil(√n), ' + RENDER_N_MIN + ', ' + RENDER_N_MAX + ') **现算**）：' + strataTxt
          + ' ⇒ 计划抽 **' + plan.sampled.length + '** 条 · **真渲染了 ' + recs.length + '** 条'
          + (stoppedByBudget ? '（**预算到顶，少跑了 ' + stoppedByBudget + ' 条**：RENDER_TOTAL_BUDGET_MS='
            + RENDER_TOTAL_BUDGET_MS + 'ms，已用 ' + budgetUsed + 'ms）' : '')
          + ' · 覆盖率 **' + cover.toFixed(1) + '%**'
          + ' ｜ ①渲染抛错=' + thrown.length + '（应 0）' + (thrown.length ? ' 点名：' + JSON.stringify(thrown.slice(0, 3)) : '')
          + ' · ②可见文字≠stripHtml=' + textBad.length + '（应 0）' + (textBad.length ? ' 样本：' + JSON.stringify(textBad.slice(0, 3).map((x) => ({ k: x.k, d: x.textDiff }))) : '')
          + ' · ③该层结构不符=' + structBad.length + '（应 0）' + (structBad.length ? ' 样本：' + JSON.stringify(structBad.slice(0, 3).map((x) => ({ k: x.k, s: x.struct, bad: x.badTags }))) : '')
          + ' ｜ **耗时**（单条：一次真渲染的端到端墙钟，ms）：min=' + msArr[0] + ' 中位=' + med + ' p90=' + p90 + ' max=' + msMax
          + ' · 超时阈值（现算 4×中位，下限 50ms）=' + slowCut + 'ms ⇒ 超时项 ' + slow.length + ' 条'
          + (slow.length ? '：' + slow.slice(0, 8).join(' · ') + (slow.length > 8 ? ' …' : '') : '（一条也没有）')
          + ' · 循环期摘掉的旁路口：热度条=' + (prep.mmStub ? '摘了' : '没摘')
          + ' / 相关知识点+关联笔记=' + (prep.deskStub ? '摘了（' + prep.how + '）' : '**摘不掉**（desktop 冻结形态='
            + JSON.stringify(prep.frozen) + '）⇒ 每条多两次 CLI 子进程')
          + ' · 还原=' + clean.restored + '（应 true）'
          + ' ｜ **本批没覆盖什么**（如实）：①' + (emptyLayers.length
            ? '层 ' + emptyLayers.join(' / ') + ' **今天全仓 0 条样本** ⇒ 这两层的真实语料渲染**没有任何读数**（结构判据只剩夹具那条）'
            : '五层都有样本')
          + '；②还有 **' + unsampled + '** 条没被抽中（抽样 ≠ 全量；只证明"抽到的这些渲染是对的"）；'
          + '③只判"可见文字 + 元素结构 + 一处真帧命中"，**不判**视觉排版/样式/颜色；'
          + '④循环期热度条/相关知识点/关联笔记这三块**没加载**（旁路口摘掉了，见上），它们各有自己的域'
          + ' ｜ **真帧**（真渲染过的那批里最大的一条 ' + biggest.d.length + 'B，' + biggest.project + '/' + biggest.id
          + (renderedBiggest ? '' : '（⚠️ 本批一条都没渲染成 ⇒ 退用计划里最大那条）')
          + '；计划里最大 = ' + planBiggest.d.length + 'B ' + planBiggest.project + '/' + planBiggest.id
          + '；走**完整入口**含四个旁路口）：'
          + '目标块=<' + fr.tag + '>（按面积排第 ' + (fr.rank + 1) + ' / 共 ' + fr.cands + ' 个可判块）'
          + ' · elementFromPoint 命中它自己=真（点 ' + JSON.stringify(fr.pt) + '）'
          + ' · 该块真帧墨像素=' + (ink.hits || 0) + ' · 文本=' + JSON.stringify(fr.text)
          + ' · 帧=' + path.basename(shot.file) + '（' + shot.width + 'x' + shot.height + ' · ' + shot.bytes + 'B · sha256:' + shot.sha256 + '）'
          + ' · 重拍 ' + cap.attempts + ' 次'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑨ 渲染不进数据 + 默认档逐字节不变
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 渲染不进数据：打开详情框前后**项目 JSON 逐字节相同**（sha256）；'
      + '且无链接、无图源、无锚点的节点其正文 `innerHTML` 与 CLI 的 `detail` **逐字节相同**（默认档不变）',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const files = fs.existsSync(probeDir())
        ? fs.readdirSync(probeDir()).filter((f) => f.endsWith('.json')).map((f) => path.join(probeDir(), f)) : [];
      const before = files.map((f) => ({ f: f, sha: sha256File(f), bytes: fs.statSync(f).size }));
      const detail = (cliJson(ctx, ['get', PROJ, N_PLAIN, '--json', '--detail']) || {}).detail;
      // 消毒的累计计数在**本条之前**已经被前几条用过了（注入夹具那一条必然 changed=1）⇒
      // 判据比的是**本条自己的增量**（打开这个"干净节点"不许让 changed 增加），不是历史总量。
      const stBefore = await execJson(ctx, `JSON.stringify({ ok: true, s: (window.MM.Sanitize && window.MM.Sanitize.state()) || null })`);
      const pinned = await pinDetailBox(ctx, N_PLAIN);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      await ctx.exec(SETTLE);
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        return JSON.stringify({ ok: true, innerHTML: dc.innerHTML, links: dc.querySelectorAll('a').length,
          svgs: dc.querySelectorAll('svg').length, mm: dc.querySelectorAll('[data-mm-mermaid]').length,
          sanitize: window.MM.Sanitize && window.MM.Sanitize.state() });
      })()`);
      const after = files.map((f) => ({ f: f, sha: sha256File(f), bytes: fs.statSync(f).size }));
      const same = JSON.stringify(before) === JSON.stringify(after);
      const byteSame = r.innerHTML === detail;
      const changedDelta = (r.sanitize.changed || 0) - ((stBefore.s && stBefore.s.changed) || 0);
      const ok = same && byteSame && r.links === 0 && r.svgs === 0 && r.mm === 0
        && r.sanitize && changedDelta === 0;
      return {
        ok: ok,
        text: '项目 JSON（' + files.length + ' 个文件）sha256 前后相同=' + same
          + '（' + before.map((b) => path.basename(b.f) + ':' + b.sha.slice(0, 10) + '/' + b.bytes + 'B').join(' ') + '）'
          + ' ｜ 正文 innerHTML 逐字节==CLI detail=' + byteSame + '（' + String(detail).length + ' 字符）'
          + ' · 框内 <a>=' + r.links + ' · <svg>=' + r.svgs + ' · mermaid 容器=' + r.mm
          + ' ｜ 消毒累计：runs=' + r.sanitize.runs + ' changed=' + r.sanitize.changed
          + '（本条自身的增量=' + changedDelta + '，要求 0 ⇒ 打开一个干净节点**一个字节都不被改**）'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑩ 自收尾
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-52 自收尾：详情框关掉、切回原项目、夹具项目自己删掉（不留脏状态给后续域）',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const r = await execJson(ctx, `(async function () {
        var app = window.MMApp;
        if (app.closeAllFloatDetail) app.closeAllFloatDetail();
        var home = ${JSON.stringify(HOME_PROJECT)};
        var st = app.getState();
        if (st.project && st.project.name !== home) {
          if (app.isDirty && app.isDirty()) { await app.save(); }
          await app.openProject(home);
        }
        var now = (app.getState().project || {}).name;
        return JSON.stringify({ ok: true, boxes: document.querySelectorAll('.float-detail').length,
          cur: now, back: now === home, hasJm: !!app.getState().jm });
      })()`);
      await ctx.exec(SETTLE);
      const removed = removeProbe();
      const closed = await mm.closeDialogs(ctx);
      const gone = !probeExists();
      return {
        ok: r.hasJm === true && r.back === true && r.boxes === 0 && removed === true && gone === true,
        text: '收尾前当前项目=' + JSON.stringify(r.cur) + '（应 ' + HOME_PROJECT + '）· 详情框残留=' + r.boxes
          + ' · 夹具项目已删=' + removed + '（复核不存在=' + gone + '）· 关掉的模态=' + closed.n
      };
    }
  }
];

module.exports = assertions;
