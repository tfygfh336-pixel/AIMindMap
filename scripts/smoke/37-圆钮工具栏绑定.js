/* ============================================================
 * scripts/smoke/37-圆钮工具栏绑定.js —— 「圆钮 / 悬浮工具栏 与 节点详情框 严格绑定」
 * ------------------------------------------------------------
 * ## 用户原话（本轮验收口令）
 *   「关联视图按钮和悬浮工具栏的显示渲染逻辑和节点详情严格绑定，甚至'大小锁'的时候也呈现一样效果，
 *     但是大小锁的时候要关闭悬浮工具栏，但是保留视图按钮。」
 *
 * ## 这个域为什么必须存在（它抓的是**上一轮全绿却坏着**的那类缺陷）
 * 圆钮 `.rel-show-btn` 原先写在详情框里、位置交回 CSS（`left:-54px`）。可框是 `overflow:hidden`
 * ⇒ 它被**框自己**裁掉：**看不见也点不到**。而当时所有断言都用 `getBoundingClientRect()` 判"可见"
 * —— 该 API **忽略裁切** ⇒ 全绿（实测：同一位图上 `elementFromPoint(圆心)` 命中普通 DIV、
 * 圆钮矩形内只有 81 个非白像素，而真的画出来时是 768。见
 * `.review/20261009-圆钮工具栏绑定/probe-clip.js` 与 `shots/probe-clip-{hidden,visible}.png`）。
 *
 * ## 因此本域立一条**判据纪律**（本轮最值得留下的资产）
 *   ★ **可见性断言不得只用 rect / 类名 / 计算样式** —— 至少要用下面两类之一（本域两类都用）：
 *     ① `document.elementFromPoint(圆心)` 命中的是它自己（或其内部）⇒ 它既**画出来了**又**点得到**；
 *     ② 真帧像素计数（`ctx.input.capture()` → `scripts/vision/frame-stats.js` 的 `scanRegion`）。
 *   rect 只能用来判**几何**（位置/尺寸/相对坐标），不能用来判"看得见" ✗。
 *
 * ## 判别力证明（工程纪律：新断言先注入一次违规、确认变红、再撤销）
 * `MM_SMOKE_INJECT=<key>`（只认本域的 key，其它一律忽略 ⇒ 默认空时完全不影响正常跑 ✓）：
 *   · `37-btn-invisible`    圆钮 `visibility:hidden`（DOM 在、类名在、rect 在，**画面没有**）⇒ ①必红
 *   · `37-btn-back-in-box`   复刻**旧缺陷**：把圆钮搬回框里 + `left:-54px` + 框 overflow:hidden ⇒ ①必红
 *   · `37-lock-keep-bar`     让判据在"大小锁"时仍返回 toolbar=true（= 上锁不隐藏工具栏）⇒ ③必红
 *   · `37-no-unlock-restore` 解锁后不恢复工具条 ⇒ ④必红
 *   · `37-bar-no-follow`     拖动/改大小期间不再同步卫星（= 停在原地）⇒ ⑤必红
 *   · `37-close-keep-bar`    关框后不收起工具条 ⇒ ⑥必红
 * 注入一律**在测试侧**（改渲染层的函数或元素状态，不动产品代码），每条断言收尾复位 ✓。
 *
 * ## 链内时序假红修复（效率批 3 · 2026-10-16：③⑤ 单跑绿、链内必红的真因与修法）
 * ③⑤ 是**时序敏感像素断言**：单跑（SMOKE_ONLY=37,39）绿、链内必红，且单跑与链内是**同一份产品代码**
 * ⇒ 定性 = **重树后的时序**，不是断言太松。机制：prep/铺场之后**延后的**画布动作
 * （`renderMind` 末尾 `setTimeout(centerOnRoot, 80)` 覆盖 jsMind 异步布局；follow 档的框挂在节点下
 * ⇒ 画布一动框就跟着挪）若落在"量基线"与"读数"之间，绝对坐标对比就假红（实测读数：圆钮 y+33px、
 * 工具栏相对坐标漂移）。修法照期 3 收口批（域 45/46）的同款，**只动时序/基线、断言语义一个字不改**：
 *   ① 基线取在**所有会改视图的交互之后**（铺场/缩框完成后才量 before）；
 *   ② 取读数前 `waitStableView`（连续三次同一签名才读；本域签名 = pan + 框矩形 + 圆钮/工具条顶点，
 *      比单看 pan 更强 —— follow 框要经下一次 `syncFdSatellites` 才跟上画布）；
 *   ③ **不许**把"整幅平移"容忍成通过 ✗ —— 相对位移 / 逐项对比口径照旧，注入证明见下方判别力清单。
 *
 * ## 边界（别以为它比实际更强 ✓）
 *   · 真输入走的是 Chromium 真实输入管线，但**不是真实硬件**：高 DPI 缩放、系统鼠标加速、
 *     多显示器、以及"人手摸起来的手感"仍只有真机复核（见交付说明的"只能真机复核"清单）。
 *   · 本域验的是渲染层行为 + 画面上真的画出来了；"好不好看"不进断言（那是主观项，只配人工清单）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const frameStats = require('../vision/frame-stats.js');
const { waitStableView } = require('./view-stability.js');

/** 截图证据目录（本域自己的，**不写进别的域**的目录；`.review/` 整目录 gitignore ⇒ 图片不进版本库 ✓） */
const SHOT_DIR = path.join(__dirname, '..', '..', '.review', '20261009-圆钮工具栏绑定', 'shots');

/** 落一张截图证据并回读数（与断言文本里的像素数**同源** ✓ 便于人工复核数字与图片是否一致）。
 *  写盘失败**不静默**：回一个 `error` 字段进断言文本 ✓ */
function saveShot(img, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const png = img.toPNG();
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, png);
    return { ok: true, file: path.basename(file), bytes: png.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓） */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT === '37-' + k;

/** "非白"判据：三通道都接近 255 才算背景（**不看通道身份**，与 frame-stats.js 同一口径）。
 *  圆钮是白底 + 浅蓝虚线边 + emoji ⇒ 边界与图标一定留下非白像素 ✓ */
const nonWhite = (a, b, c) => (a < 246 || b < 246 || c < 246);

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 12); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

/* ---------------- 铺场：本域自建前置（不依赖别的域留下的状态 ✓） ---------------- */

async function prep(ctx) {
  const r = await execJson(ctx, `(function () {
    var MM = window.MM, app = window.MMApp;
    if (!MM || !app) return JSON.stringify({ ok: false, text: '渲染层没就绪（MM / MMApp 缺失）' });
    var st = app.getState();
    if (!st || !st.jm) return JSON.stringify({ ok: false, text: '没有打开的项目（jm 缺失）' });
    if (app.closeAllFloatDetail) app.closeAllFloatDetail();
    if (MM.hideNodeToolbar) MM.hideNodeToolbar();
    if (MM.clearSelection) MM.clearSelection();
    if (MM.applySelection) MM.applySelection([], [], { hideBox: true });
    if (MM.clearRelated) MM.clearRelated();
    if (MM.expandAll) MM.expandAll();
    if (MM.centerOnRoot) MM.centerOnRoot();
    return JSON.stringify({ ok: true, project: st.project && st.project.name });
  })()`);
  await new Promise((r) => setTimeout(r, 500));   // 展开/居中后等 jsMind 重排
  return r;
}

/** 挑一个"视口内、点得中"的节点（不写死 id：数据一改就失效 ✗）。
 *  ★ 除了节点自己要在面板内，还要求**它的详情框也能落进面板**：框宽 380px（随缩放 s 显示为 380·s）、
 *    水平居中于节点、顶边在节点下缘 +8 —— 否则真鼠标**抓不到框的标题栏**（实测踩过：
 *    框左缘 −26px ⇒ 把手点在 (−2,483)、elementFromPoint 返回 null ⇒ ⑤ 假红）。
 *    这不是放宽判据，而是把"能拿真鼠标操作它"这个**前提**写清楚（在视野外的框上验拖动等于没验 ✗）。
 *  找不到就依次放宽：① 面板内留 40px 余量 → ② 只要求整块在面板内 → ③ 先把视图缩到 0.6 再挑。 */
async function pickNode(ctx, skipIds) {
  const one = async (margin) => execJson(ctx, `(function () {
    var jm = window.MMApp.getState().jm, skip = ${JSON.stringify(skipIds || [])}, out = null;
    var p = window.MM.fdPanel ? window.MM.fdPanel() : null;
    var pr = p ? p.getBoundingClientRect() : null;
    if (!pr) return JSON.stringify({ ok: false, text: '没有面板' });
    var M = ${JSON.stringify(margin)};
    var S = (window.MM.getPanState ? window.MM.getPanState().s : 1) || 1;
    var halfBox = (380 * S) / 2 + 8;     // 详情框的显示宽度的一半（.float-detail 是 width:380px + 随 s 缩放）
    (function walk(n, depth) {
      if (!n || out || depth > 8) return;
      if (n.id && n.id !== 'root' && skip.indexOf(n.id) < 0) {
        var el = document.querySelector('jmnode[nodeid="' + n.id + '"]');
        if (el) {
          var r = el.getBoundingClientRect();
          var cx = r.left + r.width / 2;
          var inPanel = r.left > pr.left + M && r.right < pr.right - M
            && r.top > pr.top + Math.max(M, 40) && r.bottom < pr.bottom - M;
          // 框真的落得进来吗（否则抓不到标题栏 ⇒ ⑤ 的拖动没法做）
          var boxFits = (cx - halfBox > pr.left + 4) && (cx + halfBox < pr.right - 4)
            && (r.bottom + 8 + 24 < pr.bottom);
          if (r.width > 4 && r.height > 4 && inPanel && boxFits) { out = { id: n.id, topic: n.topic }; return; }
        }
      }
      (n.children || []).forEach(function (c) { walk(c, depth + 1); });
    })(jm.get_node('root'), 0);
    return JSON.stringify({ ok: !!out, node: out, s: S,
      text: out ? out.id : ('视口内找不到"详情框也放得下"的节点（余量 ' + M + 'px, s=' + S.toFixed(2) + '）') });
  })()`);
  let r = await one(40);
  if (r.ok) return r;
  r = await one(4);
  if (r.ok) return r;
  // ③ 缩到 0.6 再挑：视图越小，能整块容纳详情框的节点越多（确定性动作，不靠"多试几次"）
  await ctx.exec(`(function () {
    var MM = window.MM;
    if (MM.setViewScale) MM.setViewScale(0.6);
    if (MM.centerOnRoot) MM.centerOnRoot();
    return 1;
  })()`);
  await new Promise((res) => setTimeout(res, 320));
  return one(40);
}

/* ---------------- 现场读数：框 / 圆钮 / 工具条 一次读全 ---------------- */

/** 圆钮的"看得见"**必须**用命中测试判（rect 对裁切是盲的 ✗，见文件头） */
const SAT_JS = `(function () {
  var MM = window.MM;
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
  var box = null;
  for (var i = 0; i < boxes.length; i++) {
    var q = boxes[i].getBoundingClientRect();
    if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40
      && boxes[i].getAttribute('data-kind') !== 'ask') { box = boxes[i]; break; }
  }
  var p = MM.fdPanel ? MM.fdPanel() : null;
  var pr = p ? p.getBoundingClientRect() : null;
  var out = {
    boxFound: !!box,
    panel: pr ? { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) } : null,
    dpr: window.devicePixelRatio || 1,
    btn: { found: false }, bar: { visible: false }
  };
  if (box) {
    var bq = box.getBoundingClientRect();
    out.box = { boxId: box.dataset.boxId || '', left: Math.round(bq.left), top: Math.round(bq.top),
      width: Math.round(bq.width), height: Math.round(bq.height),
      lock: (MM.getFloatDetailState ? MM.getFloatDetailState().lock : null),
      title: (box.querySelector('.fd-title') || {}).textContent || '' };
    var btn = MM.fdRelShowBtnOf ? MM.fdRelShowBtnOf(box) : null;
    if (btn) {
      var br = btn.getBoundingClientRect();
      var cx = Math.round(br.left + br.width / 2), cy = Math.round(br.top + br.height / 2);
      var at = document.elementFromPoint(cx, cy);
      var cs = window.getComputedStyle(btn);
      out.btn = {
        found: true,
        display: cs.display, visibility: cs.visibility,
        place: btn.getAttribute('data-place') || '',
        nodeId: btn.getAttribute('data-rel-node') || '',
        left: Math.round(br.left), top: Math.round(br.top),
        width: Math.round(br.width), height: Math.round(br.height),
        center: { x: cx, y: cy },
        // ★ 判"看得见且点得到"的**唯一**硬判据（rect 看不出来）
        hitIsBtn: !!(at && at.closest && at.closest('.rel-show-btn') === btn),
        hitWhat: at ? ((at.className && String(at.className).slice(0, 40)) || at.tagName) : null,
        inPanel: !!pr && br.left >= pr.left - 1 && br.right <= pr.right + 1
          && br.top >= pr.top - 1 && br.bottom <= pr.bottom + 1
      };
    }
  }
  var bar = document.getElementById('mm-node-toolbar');
  var bvis = !!(bar && bar.parentElement && bar.style.display !== 'none');
  if (bar) {
    var rr = bar.getBoundingClientRect();
    // 工具条的"看得见"同样必须用**命中测试**判（rect 对裁切是盲的 ✓ 见文件头）
    var bcx = Math.round(rr.left + rr.width / 2), bcy = Math.round(rr.top + rr.height / 2);
    var bat = bvis ? document.elementFromPoint(bcx, bcy) : null;
    out.bar = {
      visible: bvis,
      hitIsBar: !!(bat && bar.contains(bat)),
      hitWhat: bat ? ((bat.className && String(bat.className).slice(0, 30)) || bat.tagName) : null,
      anchor: bar.getAttribute('data-anchor') || '',
      place: bar.getAttribute('data-place') || '',
      anchorBox: bar.getAttribute('data-anchor-box') || '',
      node: bar.getAttribute('data-node') || '',
      count: bar.getAttribute('data-count') || '',
      left: Math.round(rr.left), top: Math.round(rr.top),
      width: Math.round(rr.width), height: Math.round(rr.height),
      parent: bar.parentElement ? (bar.parentElement.id || bar.parentElement.tagName) : null
    };
  }
  return JSON.stringify(out);
})()`;

/** 真帧里数圆钮矩形内的非白像素（与"落盘的那张帧"同源 ⇒ 数字与图片可一起复核 ✓） */
async function btnPixels(ctx, sat) {
  if (!ctx.input || !sat.btn || !sat.btn.found) return { ok: false, hits: 0, reason: '没有圆钮或没有真输入底座' };
  const img = await ctx.input.capture();
  const dpr = sat.dpr || 1;
  const rect = { x: sat.btn.left * dpr, y: sat.btn.top * dpr,
    width: sat.btn.width * dpr, height: sat.btn.height * dpr };
  const scan = frameStats.scanRegion(img, rect, { predicate: nonWhite });
  scan.img = img;   // 调用方可按需落盘（**同一张帧** ⇒ 数字与图片同源 ✓）
  return scan;
}

/** 相对框的偏移（圆钮/工具条"跟着框走"的**唯一判据**：相对坐标恒定，而不是看绝对坐标 ✓） */
function relToBox(sat) {
  const b = sat.box || { left: 0, top: 0, width: 0, height: 0 };
  return {
    btn: sat.btn.found ? { dx: sat.btn.left - b.left, dy: sat.btn.top - b.top } : null,
    bar: sat.bar.visible ? { dx: sat.bar.left - b.left, dy: sat.bar.top - b.top } : null
  };
}

/** 工具条"贴框"的**唯一判据**（三档都要判得出来 ✓）：
 *  · below：条顶 == 框底 + 6（默认档）
 *  · above：条底 == 框顶 − 6（框高到下方放不下才翻上去 —— 不让它翻就"看不见"了 ✗）
 *  · clamp：上下都放不下，夹进面板（此时只要求它落在面板内、点得到）
 *  ⚠️ 不写成"只认 below"：那会把**兜底档**判成红，而兜底档本身是必要的（实测框底到 1025px、
 *     面板只有 795px ⇒ 只放下方就出面板被裁 = 看不见，与圆钮那个真 bug 同一类损害 ✗） */
function barBandOk(sat) {
  const b = sat.box, bar = sat.bar;
  if (!b || !bar || !bar.visible) return false;
  const dyBelow = bar.top - (b.top + b.height);
  const upGap = b.top - (bar.top + bar.height);
  if (bar.place === 'below') return dyBelow === 6;
  if (bar.place === 'above') return upGap === 6;
  if (bar.place === 'clamp') return bar.top >= 0 && (bar.top + bar.height) <= (sat.panel ? sat.panel.height + sat.panel.top : 1e9);
  return false;
}

/* ---------------- 等视图落定（链内时序假红修复：读数前必等，见文件头） ---------------- */

/** 视图稳定性的**本域签名**：画布 pan + 框矩形 + 圆钮顶点 + 工具条顶点/可见。
 *  比单看 pan 更强：follow 档的框要经下一次 `syncFdSatellites` 才跟上画布 ⇒ 把框/卫星一起等。
 *  签名只用于"等稳定"，**不是**判据 —— 判据仍是 SAT_JS 的现量 + 相对位移口径 ✗ 不容忍平移。 */
const STAB_JS = `(function () {
  var MM = window.MM;
  var box = null;
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
  for (var i = 0; i < boxes.length; i++) {
    var q = boxes[i].getBoundingClientRect();
    if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40
      && boxes[i].getAttribute('data-kind') !== 'ask') { box = boxes[i]; break; }
  }
  var pan = window.MMApp.getPanState();
  if (!box) return JSON.stringify({ pan: pan, box: null });
  var b = box.getBoundingClientRect();
  var btn = MM.fdRelShowBtnOf ? MM.fdRelShowBtnOf(box) : null;
  var br = btn ? btn.getBoundingClientRect() : null;
  var bar = document.getElementById('mm-node-toolbar');
  var barVis = !!(bar && bar.parentElement && bar.style.display !== 'none');
  var barr = barVis ? bar.getBoundingClientRect() : null;
  return JSON.stringify({ pan: pan,
    box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
    btn: br ? [Math.round(br.left), Math.round(br.top)] : null,
    bar: barr ? [Math.round(barr.left), Math.round(barr.top)] : (barVis ? 'no-rect' : 'hidden') });
})()`;

/** 等"pan + 框 + 卫星"连续三次同一再取读数（条件等待，不是固定睡眠 ✗；共用实现见 view-stability.js） */
async function waitStableSat(ctx) {
  return waitStableView(ctx, STAB_JS);
}

/* ---------------- 注入工具（测试侧；收尾一律复位） ---------------- */

async function inject(ctx, key, js) {
  if (!MY_KEY(key)) return false;
  await ctx.exec(js);
  return true;
}

/** 复位：把注入时替换掉的 MM 函数**逐个还原**（存/取都在 `MM.__satSaved` 里，见各注入块） */
async function resetInject(ctx) {
  if (!INJECT || INJECT.indexOf('37-') !== 0) return;
  await ctx.exec(`(function () {
    var MM = window.MM;
    var saved = MM.__satSaved;
    if (saved) {
      Object.keys(saved).forEach(function (k) { MM[k] = saved[k]; });
      MM.__satSaved = null;
    }
    Array.prototype.slice.call(document.querySelectorAll('.rel-show-btn')).forEach(function (b) {
      b.style.visibility = ''; b.style.opacity = '';
    });
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 120));
}

/** 注入的**接缝纪律**（本轮踩过并修正的真实教训 ✗→✓）：
 *  注入必须替换**代码真正经过的那一跳**。第一版把 `MM.fdSatellitePlan` 换掉，可 `syncFdSatellites`
 *  当时是按**局部函数名**调的 ⇒ 注入完全无效、三条断言"绿着通过" —— 那正是「门禁在空转」
 *  （skills/testing-for-ai B4）。修法两头都做了：① 产品侧改成走 `MM.fdSatellitePlan`（真接缝）；
 *  ② 本域所有注入都改到真接缝上（`layoutRelShowBtn` / `layoutNodeToolbar` 本来就是 `MM.x` 调用 ✓）。 */

module.exports = [
  /* ============================================================ ① */
  {
    name: '① 开详情框 ⇒ **圆钮真的看得见、点得到**（同 tick 建 + elementFromPoint 命中 + 真帧像素；被框裁掉会红）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 采不到真值 = 红' };
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const pick = await pickNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      // ① 同 tick：showDetail 是同步渲染 ⇒ 立刻（不等 IPC）就该有圆钮
      const sameTick = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm;
        window.MMApp.showDetail(jm.get_node(${JSON.stringify(pick.node.id)}));
        var box = document.querySelector('.rel-show-btn');
        return JSON.stringify({ ok: !!box, text: '同 tick 有圆钮=' + !!box });
      })()`);
      await ctx.input.settle({ delayMs: 260 });
      // ② 注入（判别力证明）：分别演"DOM 在、画面没有"与"旧缺陷（圆钮在框里被裁）"
      const injA = await inject(ctx, 'btn-invisible', `(function () {
        var b = document.querySelector('.rel-show-btn'); if (b) b.style.visibility = 'hidden'; return 1;
      })()`);
      const injB = await inject(ctx, 'btn-back-in-box', `(function () {
        var MM = window.MM;
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
        }
        if (!box) return 0;
        var b = MM.fdRelShowBtnOf ? MM.fdRelShowBtnOf(box) : null;
        if (!b) return 0;
        box.style.overflow = 'hidden';
        b.style.transform = 'none'; b.style.width = '44px'; b.style.height = '44px';
        b.style.left = '-54px'; b.style.top = '14px';
        box.appendChild(b);            // ← 复刻旧缺陷：圆钮又变成框的子元素
        return 1;
      })()`);
      const sat = await execJson(ctx, SAT_JS);
      const pix = await btnPixels(ctx, sat);
      const shot = pix.img ? saveShot(pix.img, '37-a1-开框（圆钮+工具条）.png') : { ok: false, error: '没有帧' };
      const ok = !!sat.boxFound && !!sat.btn.found && sat.btn.display !== 'none'
        && sat.btn.hitIsBtn === true && pix.ok === true && pix.hits >= 30 && sat.btn.inPanel === true;
      const text = '节点=' + pick.node.id + ' ｜ ' + sameTick.text
        + ' ｜ 圆钮=' + (sat.btn.found ? ('rect=' + sat.btn.left + ',' + sat.btn.top + ' ' + sat.btn.width + 'x' + sat.btn.height
          + ' 档=' + sat.btn.place + ' 在面板内=' + sat.btn.inPanel) : '无')
        + ' ｜ 命中测试命中圆钮=' + sat.btn.hitIsBtn + '（命中=' + sat.btn.hitWhat + '）'
        + ' ｜ 真帧非白像素=' + (pix.ok ? pix.hits : ('扫描失败:' + pix.reason))
        + ' ｜ 截图=' + (shot.ok ? (shot.file + '(' + shot.bytes + 'B)') : ('失败:' + shot.error))
        + (injA ? ' ｜【注入 btn-invisible】' : '') + (injB ? ' ｜【注入 btn-back-in-box】' : '');
      await resetInject(ctx);
      return { ok: ok, text: text };
    }
  },
  /* ============================================================ ② */
  {
    name: '② 开详情框 ⇒ 悬浮工具栏**认框当锚**（贴在框下缘外侧、水平居中于框），不再是"贴节点"',
    run: async (ctx) => {
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const pick = await pickNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`(function () {
        window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(pick.node.id)})); return 1;
      })()`);
      // 等工具条出现（真输入/异步渲染有帧延迟 ⇒ 用轮询等**状态**，不等画面）
      let sat = null;
      for (let i = 0; i < 12; i++) {
        sat = await execJson(ctx, SAT_JS);
        if (sat && sat.bar && sat.bar.visible && sat.box) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      if (!sat || !sat.box || !sat.box.boxId) return { ok: false, text: '前置失败：没有可见的节点详情框' };
      const barCx = sat.bar.left + sat.bar.width / 2;
      const boxCx = sat.box.left + sat.box.width / 2;
      const dxCenter = Math.round(barCx - boxCx);
      const dyBelow = Math.round(sat.bar.top - (sat.box.top + sat.box.height));
      const ok = !!sat.bar.visible && sat.bar.anchor === 'box' && sat.bar.anchorBox === (sat.box.boxId || '')
        && Math.abs(dxCenter) <= 2 && barBandOk(sat) && sat.bar.hitIsBar === true
        && sat.bar.parent === 'fd-satellite-layer';
      return {
        ok: ok,
        text: '节点=' + pick.node.id + ' ｜ 锚=' + sat.bar.anchor + '（应 box）锚定框=' + sat.bar.anchorBox + ' 框=' + sat.box.boxId
          + ' ｜ 档=' + sat.bar.place + ' 条中心−框中心=' + dxCenter + 'px（应 ≈0）｜ 条顶−框底=' + dyBelow + 'px'
          + ' ｜ 贴框判据通过=' + barBandOk(sat) + ' 命中工具条=' + sat.bar.hitIsBar + '（命中=' + sat.bar.hitWhat + '）'
          + ' ｜ 父容器=' + sat.bar.parent + '（应 fd-satellite-layer）'
          + ' ｜ 圆钮档=' + sat.btn.place
      };
    }
  },
  /* ============================================================ ③ */
  {
    name: '③ 【大小锁】上锁 ⇒ **工具栏消失、圆钮保留且几何/可点性逐项不变**（用户原话逐字验收）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 采不到真值 = 红' };
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const pick = await pickNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`(function () {
        window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(pick.node.id)})); return 1;
      })()`);
      await ctx.input.settle({ delayMs: 320 });
      await waitStableSat(ctx);   // 基线取在所有会改视图的交互之后（链内时序假红修复，见文件头）
      const before = await execJson(ctx, SAT_JS);
      if (!before.boxFound || !before.btn.found) return { ok: false, text: '前置失败：没有框或没有圆钮' };
      if (!before.bar.visible) return { ok: false, text: '前置失败：工具栏没出现（②应当先红）' };
      // 真鼠标点 🖥（大锁）——走真实输入与真实接线（不直接调 setFdBoxLock，免得漏掉"按钮接线坏了"这类缺陷）
      const lockPt = await execJson(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
        }
        var b = box ? box.querySelector('.fd-lock-screen') : null;
        if (!b) return JSON.stringify({ ok: false, text: '框上没有 🖥 按钮' });
        var r = b.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`);
      if (!lockPt.ok) return { ok: false, text: lockPt.text };
      const inj = await inject(ctx, 'lock-keep-bar', `(function () {
        var MM = window.MM;
        MM.__satSaved = MM.__satSaved || {};
        MM.__satSaved.fdSatellitePlan = MM.fdSatellitePlan;
        MM.fdSatellitePlan = function (box) {
          var p = MM.__satSaved.fdSatellitePlan(box);
          p.toolbar = p.visible && box.kind === 'node';   // ← 违规：大小锁时**不**关工具栏
          return p;
        };
        return 1;
      })()`);
      await ctx.input.click({ x: lockPt.x, y: lockPt.y });
      await ctx.input.settle({ delayMs: 320 });
      await waitStableSat(ctx);   // 读数前等"pan+框+卫星"落定（判据不改：锁后几何逐项对比照旧 ✗ 不容忍平移）
      const after = await execJson(ctx, SAT_JS);
      const same = (a, b) => a && b && Math.abs(a - b) <= 1;
      const btnSame = !!after.btn.found && after.btn.display !== 'none'
        && same(before.btn.left, after.btn.left) && same(before.btn.top, after.btn.top)
        && same(before.btn.width, after.btn.width) && same(before.btn.height, after.btn.height)
        && before.btn.place === after.btn.place
        && after.btn.hitIsBtn === true;
      const pix = await btnPixels(ctx, after);
      const shot = pix.img ? saveShot(pix.img, '37-a3-大小锁（工具条收起·圆钮不变）.png') : { ok: false, error: '没有帧' };
      const ok = after.box && after.box.lock === 'screen'
        && after.bar.visible === false
        && btnSame && pix.ok === true && pix.hits >= 30;
      const text = '锁=' + (after.box ? after.box.lock : '?') + '（应 screen）'
        + ' ｜ 工具栏可见=' + after.bar.visible + '（应 false；anchor=' + after.bar.anchor + '）'
        + ' ｜ 圆钮锁前=(' + before.btn.left + ',' + before.btn.top + ' ' + before.btn.width + 'x' + before.btn.height + ' 档=' + before.btn.place + ')'
        + ' 锁后=(' + after.btn.left + ',' + after.btn.top + ' ' + after.btn.width + 'x' + after.btn.height + ' 档=' + after.btn.place + ')'
        + ' 逐项相同=' + btnSame + ' 命中圆钮=' + after.btn.hitIsBtn + ' 真帧非白像素=' + (pix.ok ? pix.hits : '失败')
        + ' ｜ 截图=' + (shot.ok ? shot.file : ('失败:' + shot.error))
        + (inj ? ' ｜【注入 lock-keep-bar：上锁不隐藏工具栏】' : '');
      await resetInject(ctx);
      return { ok: ok, text: text };
    }
  },
  /* ============================================================ ④ */
  {
    name: '④ 【大小锁】解锁 ⇒ 工具栏回来，且仍贴在框下缘外侧（几何与上锁前一致）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 采不到真值 = 红' };
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const pick = await pickNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`(function () {
        var MM = window.MM, box = window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(pick.node.id)}));
        MM.setFdBoxLock(box, MM.FD_LOCK.SCREEN);   // 先上锁（走唯一入口 ⇒ 与点按钮同一条路）
        return 1;
      })()`);
      await ctx.input.settle({ delayMs: 300 });
      const locked = await execJson(ctx, SAT_JS);
      const inj = await inject(ctx, 'no-unlock-restore', `(function () {
        var MM = window.MM;
        MM.__satSaved = MM.__satSaved || {};
        MM.__satSaved.fdSatellitePlan = MM.fdSatellitePlan;
        MM.fdSatellitePlan = function (box) {
          var p = MM.__satSaved.fdSatellitePlan(box);
          p.toolbar = false;                            // ← 违规：解锁后也永远不恢复工具栏
          return p;
        };
        return 1;
      })()`);
      await ctx.exec(`(function () {
        var MM = window.MM;
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
        }
        if (box) box.querySelector('.fd-lock-screen').click();     // 再点一次 = 解除（既有交互 ✓）
        return 1;
      })()`);
      await ctx.input.settle({ delayMs: 320 });
      const after = await execJson(ctx, SAT_JS);
      const dxCenter = after.bar.visible ? Math.round((after.bar.left + after.bar.width / 2) - (after.box.left + after.box.width / 2)) : null;
      const ok = locked.bar.visible === false && after.box && after.box.lock === 'follow'
        && after.bar.visible === true && after.bar.anchor === 'box'
        && Math.abs(dxCenter) <= 2 && barBandOk(after) && after.bar.hitIsBar === true;
      const text = '上锁时工具栏可见=' + locked.bar.visible + '（应 false）｜ 解锁后 lock=' + (after.box ? after.box.lock : '?')
        + ' 工具栏可见=' + after.bar.visible + ' 锚=' + after.bar.anchor + ' 档=' + after.bar.place
        + ' 条中心−框中心=' + dxCenter + 'px 贴框判据通过=' + barBandOk(after) + ' 命中工具条=' + after.bar.hitIsBar
        + (inj ? ' ｜【注入 no-unlock-restore：解锁不恢复】' : '');
      await resetInject(ctx);
      return { ok: ok, text: text };
    }
  },
  /* ============================================================ ⑤ */
  {
    name: '⑤ 【真鼠标拖动框】圆钮与工具栏**同时跟随**（相对框的坐标恒定 ≤1px；拖动未生效也要红）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 采不到真值 = 红' };
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const pick = await pickNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`(function () {
        window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(pick.node.id)})); return 1;
      })()`);
      await ctx.input.settle({ delayMs: 260 });
      // 铺场：把框**缩到一个小尺寸**（与改大小把手同一套写入：解开 maxHeight/maxWidth + 定宽高 ✓）——
      // 本断言判的是"框能完整放下时，两颗卫星相对框的坐标恒定"，用一个确定的小框才有判别力 ✓
      await ctx.exec(`(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
        }
        if (!box) return 0;
        box.style.maxWidth = 'none'; box.style.maxHeight = 'none';
        box.style.width = '320px'; box.style.height = '200px';
        if (window.MM.syncFdSatellites) window.MM.syncFdSatellites();
        return 1;
      })()`);
      await ctx.input.settle({ delayMs: 300 });
      await waitStableSat(ctx);   // 基线取在铺场（缩框）之后、拖动之前（链内时序假红修复，见文件头）
      const before = await execJson(ctx, SAT_JS);
      if (!before.btn.found || !before.bar.visible) return { ok: false, text: '前置失败：圆钮或工具栏没出现' };
      // 本断言验的是"框**完整放得下**时两颗卫星相对框的坐标恒定" ⇒ 确认走的是默认档（below）。
      // 框高到放不下时走的是**兜底档**（below→above→clamp）—— 那条路径由 26-域与真机复核管，
      // 这里如实判红并说明原因（不静默通过 ✓）
      if (before.bar.place !== 'below') {
        return { ok: false, text: '前置不成立：缩到 320x200 后仍走兜底档（档=' + before.bar.place
          + '，框 y=' + before.box.top + ' h=' + before.box.height + '）—— 相对坐标恒定只在默认档下可判 ✓' };
      }
      const head = await execJson(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
        }
        var h = box ? box.querySelector('.fd-head') : null;
        if (!h) return JSON.stringify({ ok: false, text: '没有标题栏（拖动把手）' });
        var r = h.getBoundingClientRect();
        // 抓标题栏**左侧**（避开右侧的锁/关闭按钮 ✓，否则一按就点了按钮）
        var x = Math.round(r.left + 24), y = Math.round(r.top + r.height / 2);
        // ★ 诊断：那个点**真的**落在框的标题栏里吗？（真输入走命中测试 ⇒ 必须先确认没人盖住它）
        var at = document.elementFromPoint(x, y);
        var inHead = !!(at && h.contains(at));
        // 拖动方向**按窗口边界选**：往内拖（否则指针越界会被 fdEndDrag 提前收尾 ⇒ 假红）
        var dx = (x + 70 < window.innerWidth - 24) ? 70 : -70;
        var dy = (y + 46 < window.innerHeight - 24) ? 46 : -46;
        return JSON.stringify({ ok: inHead, x: x, y: y, dx: dx, dy: dy,
          hit: at ? ((at.className && String(at.className).slice(0, 30)) || at.tagName) : null,
          text: '把手点=(' + x + ',' + y + ') 命中=' + (at ? (at.className || at.tagName) + ' 在标题栏内=' + inHead : '空') });
      })()`);
      if (!head.ok) return { ok: false, text: head.text + ' ⇒ 真鼠标按不到标题栏（有东西盖住它？）' };
      const inj = await inject(ctx, 'bar-no-follow', `(function () {
        var MM = window.MM;
        MM.__satSaved = MM.__satSaved || {};
        // 改到**真接缝**上：这两颗卫星的落位都是经 MM.x 调的（syncFdSatellites 里那两跳 ✓）
        // ⇒ 同时停掉它们 = "拖动/改大小期间卫星不动"（正是用户报过的那条缺陷）
        MM.__satSaved.layoutRelShowBtn = MM.layoutRelShowBtn;
        MM.__satSaved.layoutNodeToolbar = MM.layoutNodeToolbar;
        MM.layoutRelShowBtn = function () { return null; };
        MM.layoutNodeToolbar = function () { return null; };
        return 1;
      })()`);
      const DX = head.dx, DY = head.dy;
      await ctx.input.drag({ x: head.x, y: head.y }, { x: head.x + DX, y: head.y + DY }, null, { steps: 4, stepDelayMs: 60 });
      await ctx.input.settle({ delayMs: 320 });
      await waitStableSat(ctx);   // 读数前等视图落定（相对位移口径照旧 ✗ 不把整幅平移容忍成通过）
      const after = await execJson(ctx, SAT_JS);
      const r0 = relToBox(before), r1 = relToBox(after);
      const boxMoved = { dx: after.box.left - before.box.left, dy: after.box.top - before.box.top };
      const dBtn = (r0.btn && r1.btn) ? { dx: r1.btn.dx - r0.btn.dx, dy: r1.btn.dy - r0.btn.dy } : null;
      const dBar = (r0.bar && r1.bar) ? { dx: r1.bar.dx - r0.bar.dx, dy: r1.bar.dy - r0.bar.dy } : null;
      // ① 拖动**真的生效**了（否则"相对坐标恒定"是空判据 ⇒ 假绿 ✗）
      const movedOk = Math.abs(boxMoved.dx - DX) <= 8 && Math.abs(boxMoved.dy - DY) <= 8;
      // ② 两者的相对坐标都没漂
      const btnOk = !!dBtn && Math.abs(dBtn.dx) <= 1 && Math.abs(dBtn.dy) <= 1;
      const barOk = !!dBar && Math.abs(dBar.dx) <= 1 && Math.abs(dBar.dy) <= 1;
      const ok = movedOk && btnOk && barOk && after.btn.hitIsBtn === true;
      const text = '把手点=(' + head.x + ',' + head.y + ')／' + head.hit + ' ｜ 拖动=(' + DX + ',' + DY + ')'
        + ' 框实际位移=(' + boxMoved.dx + ',' + boxMoved.dy + ') 拖动生效=' + movedOk
        + '（拖前锁=' + (before.box || {}).lock + ' 拖后锁=' + (after.box || {}).lock + '，拖过会自动上小锁 ✓）'
        + ' 档=' + before.bar.place + '→' + after.bar.place
        + ' ｜ 圆钮相对坐标漂移=(' + (dBtn ? dBtn.dx + ',' + dBtn.dy : '—') + ')px 恒定=' + btnOk
        + ' ｜ 工具栏相对坐标漂移=(' + (dBar ? dBar.dx + ',' + dBar.dy : '—') + ')px 恒定=' + barOk
        + ' ｜ 拖后圆钮命中=' + after.btn.hitIsBtn
        + (inj ? ' ｜【注入 bar-no-follow：拖动期间不同步卫星】' : '');
      await resetInject(ctx);
      return { ok: ok, text: text };
    }
  },
  /* ============================================================ ⑥ */
  {
    name: '⑥ 切节点 ⇒ 两者一起换到新框；关框 ⇒ 两者**一起收干净**（不留残影；工具条不残留）',
    run: async (ctx) => {
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const first = await pickNode(ctx);
      if (!first.ok) return { ok: false, text: first.text };
      const second = await pickNode(ctx, [first.node.id]);
      if (!second.ok) return { ok: false, text: '挑不到第二个节点：' + second.text };
      await ctx.exec(`(function () {
        window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(first.node.id)})); return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 260));
      const s1 = await execJson(ctx, SAT_JS);
      await ctx.exec(`(function () {
        window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(second.node.id)})); return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 260));
      const s2 = await execJson(ctx, SAT_JS);
      const switched = s2.btn.found && s2.btn.nodeId === second.node.id && s2.bar.visible
        && s2.bar.node === second.node.id && s2.box.boxId === s2.bar.anchorBox;
      // 关框（注入：让"收起工具条"这条失效 ⇒ 必须红）
      const inj = await inject(ctx, 'close-keep-bar', `(function () {
        var MM = window.MM;
        MM.__satSaved = MM.__satSaved || {};
        // 真接缝：工具条的落位/显隐都由它一处实现（syncFdSatellites 里那一跳 ✓）
        // 停掉它 ⇒ 框关掉之后工具条**停在最后那次的位置**不动 = "关框不收起工具条" ✗
        MM.__satSaved.layoutNodeToolbar = MM.layoutNodeToolbar;
        MM.layoutNodeToolbar = function () { return null; };
        return 1;
      })()`);
      await ctx.exec(`(function () { window.MMApp.closeAllFloatDetail(); return 1; })()`);
      await new Promise((r) => setTimeout(r, 300));
      const gone = await execJson(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var vis = 0;
        boxes.forEach(function (b) { var r = b.getBoundingClientRect(); if (b.style.display !== 'none' && r.width > 40 && r.height > 40) vis++; });
        var btns = Array.prototype.slice.call(document.querySelectorAll('.rel-show-btn'));
        var btnVis = 0;
        btns.forEach(function (b) { var r = b.getBoundingClientRect(); if (window.getComputedStyle(b).display !== 'none' && r.width > 8) btnVis++; });
        var bar = document.getElementById('mm-node-toolbar');
        var barVis = !!(bar && bar.parentElement && bar.style.display !== 'none');
        return JSON.stringify({ ok: vis === 0 && btnVis === 0 && !barVis,
          text: '框=' + vis + ' 可见圆钮=' + btnVis + ' 工具栏可见=' + barVis });
      })()`);
      const ok = switched && s1.btn.found && gone.ok === true;
      const text = '切节点：圆钮绑到=' + s2.btn.nodeId + '（应 ' + second.node.id + '）工具条作用=' + s2.bar.node
        + ' 两者同框=' + (s2.box.boxId === s2.bar.anchorBox) + ' ｜ 关框后 ' + gone.text
        + (inj ? ' ｜【注入 close-keep-bar：关框不收起工具条】' : '');
      await resetInject(ctx);
      return { ok: ok, text: text };
    }
  },
  /* ============================================================ ⑦ */
  {
    name: '⑦ 真鼠标点圆钮 ⇒ 详情框**不被关掉**、关联视图起来（卫星是框的 UI，不算"点空白"）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 采不到真值 = 红' };
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: pre.text };
      const pick = await pickNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`(function () {
        window.MMApp.showDetail(window.MMApp.getState().jm.get_node(${JSON.stringify(pick.node.id)})); return 1;
      })()`);
      await ctx.input.settle({ delayMs: 320 });
      const before = await execJson(ctx, SAT_JS);
      if (!before.btn.found || !before.btn.inPanel) return { ok: false, text: '前置失败：圆钮不在面板内' };
      // 注入（判别力）：把"卫星是不是框的 UI"这条判据**打假** ⇒ 圆钮被当成"点空白" ⇒ 框被关掉 ⇒ 必红
      const inj = await inject(ctx, 'btn-as-blank', `(function () {
        var MM = window.MM;
        MM.__satSaved = MM.__satSaved || {};
        // 真接缝：所有"这一击算不算点空白"的守卫**只经它**（app-detail-content.js 的 composedPath
        // 循环与兜底、app-ask.js 的点别处、app-view.js 的三处守卫都用同一个判据 ✓）
        MM.__satSaved.fdIsSatelliteTarget = MM.fdIsSatelliteTarget;
        MM.fdIsSatelliteTarget = function () { return false; };   // ← 违规：卫星不算框的 UI
        return 1;
      })()`);
      await ctx.input.click({ x: before.btn.center.x, y: before.btn.center.y });
      await ctx.input.settle({ delayMs: 400 });
      const after = await execJson(ctx, SAT_JS);
      const related = await execJson(ctx, `(function () {
        return JSON.stringify({ ok: true, on: !!(window.MM.isRelatedActive && window.MM.isRelatedActive()) });
      })()`);
      const ok = after.boxFound === true && (after.box || {}).boxId === (before.box || {}).boxId
        && related.on === true;
      await ctx.exec(`(function () { if (window.MM.clearRelated) window.MM.clearRelated(); return 1; })()`);
      const text = '点前框=' + (before.box || {}).boxId + ' ｜ 点后框=' + (after.boxFound ? (after.box || {}).boxId : '**没了**')
        + ' 关联视图已起=' + related.on
        + (inj ? ' ｜【注入 btn-as-blank：把卫星当成点空白】' : '');
      await resetInject(ctx);
      return { ok: ok, text: text };
    }
  }
];
