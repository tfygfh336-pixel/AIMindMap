/* ============================================================
 * scripts/smoke/47-detail-html-links.js —— `R7-0` 三件的**真机判据**（真帧 / 真鼠标 / 真像素）
 * ------------------------------------------------------------
 * 本域是 `tests/detail-html-contract.test.js`（**结构断言**）的配对那一半：那边守"源码形状"，
 * 这里守"画面上到底画成了什么"。三件事，五条断言：
 *
 *  ① **HTML 夹具不被砸**（守 `docs/DATA-FORMAT.md` §2.4.1 的"HTML 优先"契约）
 *     造一个 `detail` 是 HTML 的夹具 ⇒ 打开详情框：
 *       · 结构：`<h3>` 元素在（不是被转义后的文字）；
 *       · 文字：正文可见文本里**一个字面标签都不许有**（`<h3` / `</p` 这类串），
 *         且它**逐字等于**把 `detail` 的标签剥掉后的文本；
 *       · 真帧：`<h3>` 的位置 `elementFromPoint` 命中它自己 **且** 该矩形内真帧像素有墨。
 *     判别力：把注入那一跳改成"转义后再注入"（= 走 `markdownToHtml` 的后果）⇒ 本断言**必红**
 *     （实测报文见交付说明；逐字节还原 + SHA-256 也在那里）。
 *
 *  ② **同项目链接真鼠标点得动**（修既有死链：`comnet` 47 条同项目链接全是死链）
 *     夹具：`s47-src` 有一条**同项目** `links[]` 指向 `s47-far`，而 `s47-far` 在一条深链末端
 *     ⇒ 打开项目（根居中）时它在**视野外**（这条是**前置**，前置不成立就如实报红，不当通过 ✗）。
 *       · 真鼠标点「相关知识点」里那一行（`ctx.input.click`，走 Chromium 命中测试）；
 *       · 点完：目标节点**被选中** + 真帧里 `elementFromPoint(它的中心)` 命中它自己
 *         ⇒ 两件事同时成立才叫"跳到了"（只选中不滚过去，用户看到的就是"点了没反应"）。
 *     判别力：把同项目那一支改回 `switchProject(p, id)`（历史事故的形状）⇒ 本断言**必红**。
 *     跨项目那半用"同一个真实现被委派"来判：把 `MM.switchProject` 换成记录器 ⇒
 *     同项目跳转**一次都不许调它**、跨项目跳转**必须**按 (项目, 节点) 调它（调完恢复）。
 *
 *  ③ **笔记链接 ≠ 蓝**（`docs/DATA-FORMAT.md` §2.4.2 的两条约定）
 *     同一帧里两行同样字数的链接：`.fd-notelink`（约定色）与普通 `<a>`（浏览器默认）。
 *       · 真帧像素：约定色那一行**有**约定色像素、**没有** UA 蓝像素；普通链接那一行**反过来**；
 *       · 约定色取自**产品文件** `renderer/style.css` 的 `--note-link-ink`（读不到 = 采不到真值 = 判红）；
 *       · 下划线：约定色那行**没有**整行连续的同色横段，普通链接那行**有**
 *         （同一判据、同一帧里的**正反两例** ⇒ 这条读数自己就有判别力）。
 *     判别力：删掉 `.fd-notelink` 的 `text-decoration: none` ⇒ 本断言**必红**。
 *     ⚠️ 判据是**通道序无关**的（照 `scripts/vision/frame-stats.js` 的纪律：`toBitmap()` 的格式
 *     是平台相关的，依赖通道身份本身就是设计缺陷）：用 `d=255−p` 的两个**比例**认颜色 ——
 *     它同时**与抗锯齿的透明度无关**（白底上 α·C+(1−α)·255 ⇒ d 的比例只由 C 决定）✓。
 *
 *  ④ **默认档不变**：没有笔记链接、也没有同项目链接的那个夹具节点 ⇒
 *     正文 `innerHTML` 与 CLI 的 `detail` **逐字节相同**（本批只改了那一行上方的注释），
 *     且打开详情框**不动视野**（平移/缩放读数逐字节相同）、框内笔记链接计数为 0。
 *
 *  ⑤ **Electron 隔离面**（只读探针，`R7` 的前置取证）：页面侧读 `typeof require` / `typeof process` /
 *     `window.desktop` 的实际可达面，主进程侧**现读** `main.js` 的 `BrowserWindow` 配置并给出**行号**
 *     （两处读数一起判 ⇒ 谁把 `nodeIntegration` 打开、或把桥收掉，这条都会红）。
 *     ⚠️ 它**只读**：本域不改任何配置、不注入任何脚本 ✓。
 *
 * 收尾：关掉全部详情框、切回 `comnet`、删掉夹具项目（自证不存在）—— 与域 39 同一套纪律。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const frameStats = require('../vision/frame-stats.js');
const convert = require('../../src/convert.js');
const mm = require('../smoke-assertions.js');

const ROOT = path.resolve(__dirname, '..', '..');

/* ---------------- 夹具（自建自删，全部落在冒烟沙箱副本里 ✓） ---------------- */

const PROJ = 'smoke-detail-47';
const HOME_PROJECT = 'comnet';          // 跑完切回它（后续域/取景按"当前项目"取景）
const NODE_HTML = 's47-html';           // HTML 夹具（含 <h3>/<b>）
const NODE_INK = 's47-ink';             // 两行链接：约定色 vs 浏览器默认
const NODE_SRC = 's47-src';             // 同项目链接的**源**（links[] → s47-far）
const NODE_FAR = 's47-far';             // 深链末端的目标（打开项目时在视野外）
const CHAIN = 16;                       // 深链长度（决定"目标在视野外"这件事成不成立）

const DETAIL_HTML = '<h3>标题甲</h3><p>正文 <b>粗体</b></p>';
const LINK_TEXT = '笔记链接一';          // 与下面那行**字数相同**（两行的几何才可比）
const PLAIN_TEXT = '普通链接二';
const DETAIL_INK = '<p>约定色判据：<a class="fd-notelink" href="#">' + LINK_TEXT
  + '</a> 与 <a href="https://example.invalid/">' + PLAIN_TEXT + '</a></p>';
const DETAIL_SRC = '<p>源节点（本条有同项目链接）</p>';

/** Chromium 的 UA 默认链接色（`#0000ee`）—— 设计稿 §⑪-0 的 N6 是这一条的实测出处
 *  （"正文里的 `<a>` 全工程没有任何工程样式 ⇒ 用户看到的蓝 = UA 默认"）。
 *  它**不是**本工程的常量，所以这里是"引用一个已实测的浏览器事实"，不是第二份产品事实 ✓ */
const UA_LINK_BLUE = '#0000ee';

/* ---------------- 小工具（与域 39 / 36 同一手法） ---------------- */

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
  try { return JSON.parse(r.out); } catch (e) { return null; }
}
const SETTLE = 'new Promise(function (res) { setTimeout(res, 250); })';

function probeDir() { return path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', PROJ); }
function probeExists() { try { return fs.existsSync(probeDir()); } catch (e) { return false; } }
/** 自建自删：删不掉如实返回 false（绝不静默当成功） */
function removeProbe() {
  try { fs.rmSync(probeDir(), { recursive: true, force: true }); return !probeExists(); }
  catch (e) { return false; }
}

/** 铺场（幂等：本域第一条断言建一次，后面几条复用） */
let fixture = null;
function ensureFixture(ctx) {
  if (!fixture) fixture = buildFixture(ctx);
  return fixture;
}
function buildFixture(ctx) {
  const steps = [];
  steps.push('清理旧夹具=' + removeProbe());
  steps.push(cli(ctx, ['init', PROJ, '--title', 'R7-0 判据夹具']).out.trim());
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '47·根', '--id', 's47-root']).out.trim());
  steps.push(cli(ctx, ['add', PROJ, 's47-root', '--topic', '47·HTML 夹具',
    '--id', NODE_HTML, '--detail', DETAIL_HTML]).out.trim());
  steps.push(cli(ctx, ['add', PROJ, 's47-root', '--topic', '47·两行链接',
    '--id', NODE_INK, '--detail', DETAIL_INK]).out.trim());
  steps.push(cli(ctx, ['add', PROJ, 's47-root', '--topic', '47·链接源',
    '--id', NODE_SRC, '--detail', DETAIL_SRC]).out.trim());
  // 深链：把 NODE_FAR 顶到视野外（"点了要滚到目标"这件事才**有东西可判**）
  let parent = 's47-root';
  for (let i = 1; i <= CHAIN; i++) {
    const id = 's47-c' + i;
    cli(ctx, ['add', PROJ, parent, '--topic', '47·深' + i, '--id', id]);
    parent = id;
  }
  steps.push(cli(ctx, ['add', PROJ, parent, '--topic', '47·远端目标', '--id', NODE_FAR]).out.trim());
  const link = cli(ctx, ['link', PROJ, NODE_SRC, '--to', PROJ, '--id', NODE_FAR, '--caption', '同项目']);
  steps.push(link.out.trim() || '（link 无输出）');
  const broken = [];
  if (!probeExists()) broken.push('夹具项目目录没建起来');
  else {
    const view = cliJson(ctx, ['get', PROJ, NODE_SRC, '--json']);
    if (!view || !Array.isArray(view.links) || !view.links.length) broken.push('同项目 links[] 没写进去');
    const far = cliJson(ctx, ['get', PROJ, NODE_FAR, '--json']);
    if (!far) broken.push('目标节点 ' + NODE_FAR + ' 不在树里');
  }
  return { steps: steps, broken: broken.join('；'), linkOut: link.out };
}
function fixtureFail(fx) {
  return (fx && fx.broken) ? { ok: false, text: '前置失败：' + fx.broken } : null;
}

/* ---------------- 打开夹具项目 / 取框（与域 39 同一套自愈） ---------------- */

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
  // 自愈：节点不在视图里就 reload 一次再来（域 39 的实测教训：前置域会留下别的视图状态）
  const inView = await execJson(ctx, `(function () {
    var st = window.MMApp.getState();
    return JSON.stringify({ ok: !!(st.jm && window.MM.adapter.getNode(st.jm, ${JSON.stringify(NODE_HTML)})) });
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

/**
 * 把某个节点的详情框摆到**确定的可点位置**（取景准备，不是被判的行为）：
 *   ① 先关掉所有详情框（否则会复用上一条留下的、位置未知的框）；
 *   ② `MM.showDetail(n)` 走产品路径开框；
 *   ③ 上**大锁**（屏幕锁：位置与大小都冻结）⇒ 之后导图平移**不会**把框带走；
 *   ④ 置到面板左上角 (12,12) —— 让出中间与右下，目标节点滚进视野时才不会被框压住。
 * @returns {{ok:boolean, text:string, boxId?:string}}
 */
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
    return JSON.stringify({ ok: true, boxId: box.el.dataset.boxId || '', lock: box.lock,
      rect: { x: bc.left, y: bc.top, width: bc.width, height: bc.height } });
  })()`);
  await ctx.exec(SETTLE);
  return r;
}

/* ---------------- 真帧读数：取一帧 + 同时取几何（两张同源，判据与证据是一张图 ✓） ---------------- */

/** 截图目录：**本批自己的** `.review/` 目录（`.review/` 整目录 gitignore ⇒ 不进版本库 ✓）。
 *  为什么不用 `ctx.input.shot()`：它固定落另一个批次的 shots/ 目录 ⇒ 会把本批证据混进别人的工作区。 */
const SHOT_DIR = path.join(ROOT, '.review', '20261014-节点详情Markdown渲染', 'shots');
function saveShot(name, img) {
  const png = img.toPNG();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, png);
  const size = typeof img.getSize === 'function' ? img.getSize() : { width: 0, height: 0 };
  return { file: file, bytes: png.length, width: size.width, height: size.height,
    sha256: crypto.createHash('sha256').update(png).digest('hex').slice(0, 16) };
}

/** CSS 像素矩形 → 设备像素（截图是设备像素；与 `scripts/vision/roi-assertions.js` 同一口径 ✓） */
function toDev(rect, dpr) {
  return { x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) };
}

/**
 * 截一帧并按几何 + 判据读一次，直到判据通过（或试完次数）。
 * **为什么允许重拍**：隐藏窗口的 `capturePage()` 会给旧帧（`17-ui-polish.js` 实测记录），
 * 那时"东西还没画出来"是**假红**；而真的没画出来时怎么拍都读不到 ⇒ 判红 ✓。
 * ⚠️ 每次重拍都**重新读几何并要求两次读数一致**（取景不稳 ⇒ 这一帧不参与判定）。
 */
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

/* ---------------- 颜色判据（通道序无关 + 抗锯齿无关） ---------------- */

/** 从**产品文件**读约定色（唯一副本在 `renderer/style.css` 的 `--note-link-ink`）——
 *  读不到 ⇒ 采不到真值 ⇒ 判红（不许拿一个猜出来的颜色当好颜色 ✗）。 */
function readNoteLinkInk() {
  let css;
  try { css = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8'); }
  catch (e) { return { ok: false, text: '读不到 renderer/style.css：' + ((e && e.message) || e) }; }
  const m = css.match(/--note-link-ink\s*:\s*(#[0-9a-fA-F]{6})\s*;/);
  if (!m) return { ok: false, text: 'renderer/style.css 里找不到 `--note-link-ink: #rrggbb;`（约定色的唯一副本）' };
  return { ok: true, ink: m[1].toLowerCase() };
}

/** 一个颜色 → `d=255−p` 的两个比例（最小/最大、中间/最大）。**与深浅（α）无关、与通道排列无关** ✓ */
function colorRatio(hex) {
  const d = [1, 3, 5].map((i) => 255 - parseInt(hex.slice(i, i + 2), 16)).sort((a, b) => a - b);
  return { lo: d[0] / d[2], mid: d[1] / d[2], d: d };
}
/**
 * 认色 predicate：某像素的 `d` 比例落在目标颜色的比例±容差内，且"离白"足够远（d 最大 ≥ minD，
 * 否则白/近白（d≈0）会把比例算成噪声）。
 * @param {string} hex 目标色
 * @param {number} tol 比例容差（0.10 已能容纳子像素抗锯齿的偏移，又不会把灰字（比例≈1.0）误判进来）
 * @param {number} minD "离白"下限
 */
function colorPredicate(hex, tol, minD) {
  const r = colorRatio(hex);
  return (a, b, c) => {
    const d = [255 - a, 255 - b, 255 - c].sort((x, y) => x - y);
    if (d[2] < minD) return false;
    return Math.abs(d[0] / d[2] - r.lo) <= tol && Math.abs(d[1] / d[2] - r.mid) <= tol;
  };
}

/* ============================================================
 * 断言
 * ============================================================ */
const assertions = [

  /* ----------------------------------------------------------------------
   * ① HTML 夹具不被砸：结构 + 文字 + 真帧三重
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-47 HTML 的 detail 夹具不被砸：<h3> 当真元素渲染、正文可见文字里**零字面标签**、'
      + '并在真帧里命中它自己且有墨（守 docs/DATA-FORMAT.md §2.4.1 的 HTML 优先契约）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真帧，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, NODE_HTML);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      const detail = (cliJson(ctx, ['get', PROJ, NODE_HTML, '--json', '--detail']) || {}).detail;
      if (typeof detail !== 'string' || !detail) return { ok: false, text: '前置失败：CLI 读不到夹具的 detail' };

      const expr = `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
        var dc = box.el.querySelector('.fd-detail-content');
        if (!dc) return JSON.stringify({ ok: false, text: '没有正文容器' });
        var h3 = dc.querySelector('h3');
        var panel = window.MM.fdPanel ? window.MM.fdPanel() : null;
        function rc(el) { var r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height }; }
        var hr = h3 ? rc(h3) : null;
        var hit = null;
        if (hr) {
          var p = { x: Math.round(hr.x + hr.width / 2), y: Math.round(hr.y + Math.round(hr.height / 2)) };
          var at = document.elementFromPoint(p.x, p.y);
          hit = !!(at && h3 && (at === h3 || h3.contains(at)));
        }
        var text = dc.textContent || '';
        var lit = ['<h3', '</h3', '<p>', '</p', '<b>', '</b'].filter(function (t) { return text.indexOf(t) >= 0; });
        // 更泛的一档：可见文字里**任何**"像标签"的串都不该有（上面那个固定表是给人看的证据）。
        // ⚠️ 用 RegExp 构造而不是字面量正则：这一段是在**模板字符串**里拼给渲染层的，
        //    字面量正则里的反斜杠加斜杠会被模板字符串吃掉反斜杠 ⇒ 拼成一个行注释 ⇒
        //    整段脚本语法错（本文件实测踩到两次：一次是拼坏正则、一次是反引号把模板串提前截断）。
        var tagLike = new RegExp('[<]/?[a-z][a-z0-9]*(\\\\s[^>]*)?>', 'i').test(text);
        return JSON.stringify({
          ok: true, dpr: window.devicePixelRatio || 1, text: text,
          hasH3: !!h3, h3: hr, h3Hit: hit, literal: lit, tagLike: tagLike,
          innerHTML: dc.innerHTML,
          panel: panel ? rc(panel) : null
        });
      })()`;
      const cap = await captureUntil(ctx, expr, (r0, img) => {
        const scan = r0.h3 ? frameStats.scanRegion(img, toDev(r0.h3, r0.dpr), {}) : null;
        // 重拍条件：这一块矩形里必须真有非背景像素（`nonBackground`：真帧里"画了没有"）
        const ink = r0.h3 ? frameStats.scanRegion(img, toDev(r0.h3, r0.dpr),
          { predicate: frameStats.nonBackgroundPredicate() }) : null;
        return { pass: !!(ink && ink.ok && ink.hits > 0), ink: ink, plain: scan };
      }, 3);
      if (!cap.ok) return { ok: false, text: '读数/取景失败：' + cap.text };
      const r0 = cap.rects;
      // 与判据同源的那一帧：连同读数一起落盘（证据可复核 ✓）
      const shot = saveShot('47-1-html-detail.png', cap.img);
      const ink = cap.judged && cap.judged.ink ? cap.judged.ink : { ok: false, hits: 0 };
      // 期望文字 = 用**工程自己那份**"剥 HTML 标签"（`src/convert.js` 的 stripHtml，唯一实现）算出来。
      // ⚠️ 它把标签换成**空格**（避免"交换机协议"粘成词），而浏览器 `textContent` 不插空格
      //    ⇒ 两边都**去掉所有空白**再比（差一个空格不是判据要抓的东西，标签被画成文字才是）。
      const expected = convert.stripHtml(detail);
      const squeeze = (s) => String(s).replace(/\s+/g, '');
      const textSame = squeeze(expected) === squeeze(r0.text);
      const ok = r0.hasH3 === true && r0.h3Hit === true && r0.literal.length === 0 && r0.tagLike === false
        && textSame && ink.ok === true && ink.hits > 0 && r0.innerHTML === detail;
      return {
        ok: ok,
        text: '夹具 detail=' + JSON.stringify(detail) + ' ⇒ <h3> 元素在=' + r0.hasH3
          + ' · 命中它自己=' + r0.h3Hit + ' · 真帧墨像素=' + (ink.hits || 0)
          + ' · 可见文字里的字面标签=' + JSON.stringify(r0.literal) + '（应 []）· 像标签的串=' + r0.tagLike
          + ' · 可见文字 == 剥标签后的 detail=' + textSame + '（' + JSON.stringify(r0.text)
          + ' vs ' + JSON.stringify(expected) + '，比对时两边去空白）'
          + ' · innerHTML 逐字节==CLI detail=' + (r0.innerHTML === detail)
          + ' · 帧=' + path.basename(shot.file) + ' sha256:' + shot.sha256
          + ' ｜ 重拍 ' + cap.attempts + ' 次'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ② 同项目链接：真鼠标点 ⇒ 目标被选中 + 真帧里命中它
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-47 同项目链接**真鼠标**点得动：目标节点被选中 + 滚到它并在真帧里命中它自己'
      + '（修 comnet 47 条同项目死链那类行为；跨项目仍委派既有 switchProject）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真鼠标，判红 ✗' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, NODE_SRC);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };

      /* 前置：目标必须**在视野外**（否则"滚到目标"那一半根本没被测到 ⇒ 不许当通过 ✗） */
      const pre = await execJson(ctx, `(function () {
        var MM = window.MM, st = window.MMApp.getState();
        var panel = MM.fdPanel ? MM.fdPanel() : null;
        var el = document.querySelector('#jsmind_container jmnode[nodeid="${NODE_FAR}"]');
        function rc(e) { var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
        var pr = panel ? rc(panel) : null, nr = el ? rc(el) : null;
        var inside = !!(pr && nr && nr.width > 2 && nr.height > 2
          && nr.x >= pr.x && nr.y >= pr.y && nr.x + nr.width <= pr.x + pr.width
          && nr.y + nr.height <= pr.y + pr.height);
        return JSON.stringify({ ok: true, hasEl: !!el, panel: pr, target: nr, inside: inside,
          box: (function () { var b = MM.fdPrimaryNodeBox(); return b ? rc(b.el) : null; })() });
      })()`);
      if (pre.inside) {
        return { ok: false, text: '前置不成立：目标 ' + NODE_FAR + ' 打开项目后就落在面板里'
          + '（深链 ' + CHAIN + ' 层没把它顶出视野）⇒ 这条判据测不到"滚到目标"那一半 ⇒ 如实报红，不当通过' };
      }

      /* 取「相关知识点」里那一行的**可点坐标**（候选点里挑一个 elementFromPoint 命中该行的） */
      const rowHit = await execJson(ctx, `(function () {
        var MM = window.MM;
        var box = MM.fdPrimaryNodeBox();
        if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
        var row = box.el.querySelector('.fd-related .bl-item[data-node="${NODE_FAR}"]');
        if (!row) return JSON.stringify({ ok: false, text: '相关知识点区里没有指向 ' + '${NODE_FAR}' + ' 的那一行',
          html: (box.el.querySelector('.fd-related') || {}).innerHTML || '' });
        if (row.scrollIntoView) { try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
        var rr = row.getBoundingClientRect();
        var cands = [
          { x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2) },
          { x: Math.round(rr.left + 8), y: Math.round(rr.top + rr.height / 2) },
          { x: Math.round(rr.right - 8), y: Math.round(rr.top + Math.round(rr.height / 2)) }
        ];
        var pt = null;
        for (var i = 0; i < cands.length; i++) {
          var q = cands[i];
          var at = document.elementFromPoint(q.x, q.y);
          if (at && (at === row || row.contains(at))) { pt = q; break; }
        }
        return JSON.stringify({ ok: !!pt, pt: pt, rect: { x: rr.left, y: rr.top, width: rr.width, height: rr.height },
          text: row.textContent || '' });
      })()`);
      if (!rowHit.ok) return { ok: false, text: '前置失败：' + rowHit.text + '（' + String(rowHit.html || '').slice(0, 160) + '）' };

      await ctx.input.click(rowHit.pt, []);
      await ctx.input.settle({ delayMs: 320 });

      const after = await execJson(ctx, `(function () {
        var MM = window.MM, st = window.MMApp.getState();
        var sel = MM.adapter.getSelected(st.jm);
        var proj = (st.project || {}).name || '';
        if (MM.closeAllFloatDetail) MM.closeAllFloatDetail();   // 关掉框再判命中：别让框自己压住目标
        var panel = MM.fdPanel ? MM.fdPanel() : null;
        var el = document.querySelector('#jsmind_container jmnode[nodeid="${NODE_FAR}"]');
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
        return JSON.stringify({ ok: true, selected: sel ? sel.id : null, project: proj,
          panel: pr, target: nr, inside: inside, hit: hit, hasEl: !!el,
          boxes: document.querySelectorAll('.float-detail').length });
      })()`);
      await ctx.input.settle({ delayMs: 150 });
      // 真帧证据（框已关掉 ⇒ 判据与证据是同一张图 ✓）
      const cap = await captureUntil(ctx, `(function () {
        var panel = window.MM.fdPanel ? window.MM.fdPanel() : null;
        var el = document.querySelector('#jsmind_container jmnode[nodeid="${NODE_FAR}"]');
        function rc(e) { var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
        return JSON.stringify({ ok: !!el, rects: { dpr: window.devicePixelRatio || 1,
          panel: panel ? rc(panel) : null, target: el ? rc(el) : null } });
      })()`, (r0, img) => {
        const ink = r0.rects.target ? frameStats.scanRegion(img, toDev(r0.rects.target, r0.rects.dpr),
          { predicate: frameStats.nonBackgroundPredicate() }) : null;
        return { pass: !!(ink && ink.ok && ink.hits > 0), ink: ink };
      }, 3);
      const shot = cap.ok ? saveShot('47-2-same-project-jump.png', cap.img) : null;
      const ink = (cap.ok && cap.judged && cap.judged.ink) ? cap.judged.ink : { ok: false, hits: 0 };

      /* 跨项目那半：同一处真实现必须**被委派**（同项目一次都不许调它） */
      const delegation = await execJson(ctx, `(function () {
        var MM = window.MM;
        var orig = MM.switchProject, calls = [];
        MM.switchProject = function (project, id) { calls.push([project, id]); return true; };
        var sameBefore = (MM.adapter.getSelected(window.MMApp.getState().jm) || {}).id;
        MM.followNodeRef(${JSON.stringify(PROJ)}, ${JSON.stringify(NODE_FAR)});
        var callsSame = calls.slice();
        MM.followNodeRef('__other-project__', 'x-node');
        var callsCross = calls.slice();
        MM.switchProject = orig;                       // 恢复（判据自己检查恢复成功）
        var restored = MM.switchProject === orig;
        var selAfter = (MM.adapter.getSelected(window.MMApp.getState().jm) || {}).id;
        return JSON.stringify({ ok: true, callsSame: callsSame, callsCross: callsCross, restored: restored,
          sameBefore: sameBefore, selAfter: selAfter });
      })()`);

      const ok = after.selected === NODE_FAR && after.inside === true && after.hit === true
        && after.hasEl === true && cap.ok === true && ink.ok === true && ink.hits > 0
        && delegation.ok === true && delegation.restored === true
        && delegation.callsSame.length === 0 && delegation.callsCross.length === 1
        && delegation.callsCross[0][0] === '__other-project__' && delegation.callsCross[0][1] === 'x-node';
      return {
        ok: ok,
        text: '点前：目标在视野外=' + (pre.inside === false) + '（应在视野外）· 点后：选中=' + after.selected
          + '（应 ' + NODE_FAR + '）· 目标落进面板=' + after.inside + ' · 命中它自己=' + after.hit
          + ' · 真帧墨像素=' + (ink.hits || 0) + ' · 当前项目=' + after.project
          + ' · 同项目跳转调 switchProject 次数=' + delegation.callsSame.length + '（应 0）'
          + ' · 跨项目跳转委派=' + JSON.stringify(delegation.callsCross) + '（应恰好一次）'
          + ' · 真鼠标事件=' + ctx.input.sentCount() + ' 条 · 点击点=' + JSON.stringify(rowHit.pt)
          + (shot ? (' · 帧=' + path.basename(shot.file) + ' sha256:' + shot.sha256) : ' · ⚠️ 帧没拿到')
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ③ 笔记链接配色：约定色 ≠ UA 蓝（同一帧里的正反两例）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-47 笔记链接配色约定：真帧像素里 `.fd-notelink` 是约定色且**无下划线**、'
      + '普通链接仍是浏览器默认蓝且**有**下划线（同一帧里两者可分）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不在（ctx.input 为空）⇒ 采不到真帧，判红 ✗' };
      const inkSrc = readNoteLinkInk();
      if (!inkSrc.ok) return { ok: false, text: '采不到真值（约定色）：' + inkSrc.text + ' ⇒ 判红' };
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const pinned = await pinDetailBox(ctx, NODE_INK);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };

      const expr = `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
        var dc = box.el.querySelector('.fd-detail-content');
        if (!dc) return JSON.stringify({ ok: false, text: '没有正文容器' });
        var note = dc.querySelector('a.fd-notelink');
        var plain = null;
        var all = dc.querySelectorAll('a');
        for (var i = 0; i < all.length; i++) { if (!all[i].classList.contains('fd-notelink')) { plain = all[i]; break; } }
        if (!note || !plain) return JSON.stringify({ ok: false, text: '两行链接不齐：'
          + 'note=' + !!note + ' plain=' + !!plain });
        // 取"命中它自己"的可点坐标（真帧判据之外的第二次命中测试：这一行确实在框里可点）
        function hitPt(el) {
          var r = el.getBoundingClientRect();
          var cands = [
            { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.round(r.height / 2)) },
            { x: Math.round(r.left + 4), y: Math.round(r.top + Math.round(r.height / 2)) },
            { x: Math.round(r.right - 4), y: Math.round(r.top + Math.round(r.height / 2)) }
          ];
          for (var k = 0; k < cands.length; k++) {
            var at = document.elementFromPoint(cands[k].x, cands[k].y);
            if (at && (at === el || el.contains(at))) return cands[k];
          }
          return null;
        }
        function rc(el) { var r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height }; }
        return JSON.stringify({ ok: true,
          rects: { dpr: window.devicePixelRatio || 1, note: rc(note), plain: rc(plain) },
          notePt: hitPt(note), plainPt: hitPt(plain),
          noteText: note.textContent, plainText: plain.textContent,
          noteColor: getComputedStyle(note).color, plainColor: getComputedStyle(plain).color,
          noteDecoration: getComputedStyle(note).textDecorationLine,
          noteHref: note.getAttribute('href') || '' });
      })()`;

      const inkHex = inkSrc.ink;
      const amberPred = colorPredicate(inkHex, 0.10, 60);
      const bluePred = colorPredicate(UA_LINK_BLUE, 0.10, 60);
      const cap = await captureUntil(ctx, expr, (r0, img) => {
        const R = r0.rects;
        const nA = frameStats.scanRegion(img, toDev(R.note, R.dpr), { predicate: amberPred });
        const nB = frameStats.scanRegion(img, toDev(R.note, R.dpr), { predicate: bluePred });
        const pA = frameStats.scanRegion(img, toDev(R.plain, R.dpr), { predicate: amberPred });
        const pB = frameStats.scanRegion(img, toDev(R.plain, R.dpr), { predicate: bluePred });
        const pass = nA.ok && nA.hits > 0 && nB.ok && nB.hits === 0
          && pB.ok && pB.hits > 0 && pA.ok && pA.hits === 0;
        return { pass: pass, nA: nA, nB: nB, pA: pA, pB: pB };
      }, 3);
      if (!cap.ok) return { ok: false, text: '读数/取景失败：' + cap.text };
      const r0 = cap.rects;
      const j = cap.judged;
      const shot = saveShot('47-3-note-link-ink.png', cap.img);
      const dpr = r0.rects.dpr;
      const noteW = Math.round(r0.rects.note.width * dpr);
      const plainW = Math.round(r0.rects.plain.width * dpr);
      // 下划线判据：**同一帧里的正反两例** —— 约定色那行不许出现"接近整行宽"的连续同色横段，
      // 普通链接那行**必须**有（后者是这条判据自己的对照：证明它真的测得到下划线）
      const noteNoUnderline = j.nA.longestRun <= Math.max(4, Math.ceil(0.5 * noteW));
      const plainHasUnderline = j.pB.longestRun >= Math.ceil(0.6 * plainW);
      const colorsOk = r0.noteColor === 'rgb(138, 106, 0)' && r0.plainColor === 'rgb(0, 0, 238)';
      const ok = j.nA.hits > 0 && j.nB.hits === 0 && j.pB.hits > 0 && j.pA.hits === 0
        && noteNoUnderline && plainHasUnderline && colorsOk
        && r0.notePt && r0.plainPt
        && r0.noteDecoration === 'none';
      return {
        ok: ok,
        text: '约定色（取自 renderer/style.css）=' + inkHex + ' · 读到的计算色：笔记链接=' + r0.noteColor
          + ' / 普通链接=' + r0.plainColor + '（应 rgb(0, 0, 238) = UA 默认 ' + UA_LINK_BLUE + '）'
          + ' · 真帧：笔记链接行 约定色像素=' + j.nA.hits + ' / UA 蓝像素=' + j.nB.hits + '（应 >0 / =0）'
          + ' · 普通链接行 约定色像素=' + j.pA.hits + ' / UA 蓝像素=' + j.pB.hits + '（应 =0 / >0）'
          + ' · 无下划线：笔记链接最长同色横段=' + j.nA.longestRun + 'px ≤ ' + Math.max(4, Math.ceil(0.5 * noteW))
          + '（行宽 ' + noteW + 'px）=' + noteNoUnderline
          + ' · 对照·普通链接 ' + j.pB.longestRun + 'px ≥ ' + Math.ceil(0.6 * plainW) + 'px =' + plainHasUnderline
          + ' · text-decoration=' + r0.noteDecoration
          + ' · 两行都可点=' + (!!r0.notePt && !!r0.plainPt)
          + ' · 帧=' + path.basename(shot.file) + ' sha256:' + shot.sha256
          + ' ｜ 重拍 ' + cap.attempts + ' 次'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ④ 默认档不变（没有笔记链接 / 没有同项目链接时，读数与本批之前逐字节相同）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-47 默认档不变：无笔记链接、无站内链接的节点 ⇒ 正文 innerHTML 与 CLI detail '
      + '**逐字节相同**、打开详情框不动视野、框内笔记链接计数 0（本批只改了那一行上方的注释）',
    run: async (ctx) => {
      const fx = ensureFixture(ctx);
      const bad = fixtureFail(fx);
      if (bad) return bad;
      const opened = await openFixture(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const detail = (cliJson(ctx, ['get', PROJ, NODE_HTML, '--json', '--detail']) || {}).detail;
      const panBefore = await execJson(ctx, `(function () {
        var p = window.MM.getPanState ? window.MM.getPanState() : null;
        return JSON.stringify({ ok: !!p, pan: p });
      })()`);
      const pinned = await pinDetailBox(ctx, NODE_HTML);
      if (!pinned.ok) return { ok: false, text: '前置失败：' + pinned.text };
      const after = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var p = window.MM.getPanState ? window.MM.getPanState() : null;
        return JSON.stringify({ ok: true, innerHTML: dc.innerHTML, text: dc.textContent,
          notelinks: dc.querySelectorAll('a.fd-notelink').length,
          anchors: dc.querySelectorAll('a').length,
          pan: p });
      })()`);
      const panSame = JSON.stringify(panBefore.pan) === JSON.stringify(after.pan);
      const ok = after.innerHTML === detail && after.notelinks === 0 && after.anchors === 0 && panSame;
      return {
        ok: ok,
        text: '正文 innerHTML 逐字节==CLI detail=' + (after.innerHTML === detail)
          + '（' + String(detail).length + ' 字节）· 框内 .fd-notelink 计数=' + after.notelinks
          + ' · 普通 <a> 计数=' + after.anchors + ' · 打开详情框前后平移/缩放读数逐字节相同=' + panSame
          + '（before=' + JSON.stringify(panBefore.pan) + ' after=' + JSON.stringify(after.pan) + '）'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑤ 隔离面（只读探针）：页面侧可达面 + 主进程配置现读（含行号）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-47 Electron 隔离面只读探针：页面里没有 require/process（nodeIntegration=off），'
      + '但 contextBridge 的 window.desktop 全量可达 —— 主进程配置与页面读数一起判',
    run: async (ctx) => {
      const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split(/\r?\n/);
      const lineOf = (re) => {
        for (let i = 0; i < mainSrc.length; i++) if (re.test(mainSrc[i])) return i + 1;
        return 0;
      };
      const cfg = {
        contextIsolation: lineOf(/^\s*contextIsolation:\s*true\s*,/),
        nodeIntegration: lineOf(/^\s*nodeIntegration:\s*false\s*,/),
        sandboxFalse: lineOf(/^\s*sandbox:\s*false\s*,/),
        preload: lineOf(/^\s*preload:\s*path\.join\(ROOT, 'preload\.js'\)\s*,/)
      };
      const page = await execJson(ctx, `(function () {
        var d = window.desktop || null;
        var api = [];
        try { api = Object.keys(d || {}); } catch (e) { api = []; }
        return JSON.stringify({ ok: true,
          requireType: typeof require, processType: typeof process,
          hasDesktop: !!d, apiKeys: api,
          writeReachable: !!(d && d.project && typeof d.project.save === 'function'),
          openFileReachable: !!(d && d.app && typeof d.app.openFile === 'function'),
          readFileReachable: !!(d && d.app && typeof d.app.readFile === 'function')
        });
      })()`);
      const ok = page.ok === true && page.requireType === 'undefined' && page.processType === 'undefined'
        && page.hasDesktop === true && cfg.contextIsolation > 0 && cfg.nodeIntegration > 0
        && cfg.sandboxFalse > 0 && cfg.preload > 0 && page.writeReachable === true
        && page.openFileReachable === true;
      return {
        ok: ok,
        text: '页面侧：typeof require=' + page.requireType + ' · typeof process=' + page.processType
          + ' · window.desktop 在=' + page.hasDesktop + '（键 ' + (page.apiKeys || []).length + ' 个：'
          + (page.apiKeys || []).join(',') + '）'
          + ' · 可达面：project.save=' + page.writeReachable + ' app.openFile=' + page.openFileReachable
          + ' app.readFile=' + page.readFileReachable
          + ' ｜ main.js 现读（行号）：contextIsolation:true:' + cfg.contextIsolation
          + ' nodeIntegration:false:' + cfg.nodeIntegration + ' sandbox:false:' + cfg.sandboxFalse
          + ' preload:' + cfg.preload
          + ' ｜ 结论：注入面 = **页面世界的脚本能力（= 应用自己的全部 IPC 能力）**，不是 Node RCE'
      };
    }
  },

  /* ----------------------------------------------------------------------
   * ⑥ 自收尾（域不留脏状态：关框 + 切回原项目 + 删夹具项目）
   * -------------------------------------------------------------------- */
  {
    name: 'smoke-47 自收尾：详情框关掉、切回原项目、夹具项目自己删掉（不留脏状态给后续域）',
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
