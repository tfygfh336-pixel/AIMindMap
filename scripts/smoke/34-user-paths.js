/* scripts/smoke/34-user-paths.js —— 「用户会怎么点」路径探针（用户 2026-10-08：很多问题，重新测试 ✓）
 *
 * 为什么单开一个域：现有断言多数验的是"函数被调了 / 字段是对的 / 类名在不在" ✗，而用户报的问题
 * 几乎都发生在**一串连续操作**里（打开详情 → 切到别的节点 → 再切回来 → 拖动框 → 点按钮……）。
 * 这里按"用户路径"逐步验，每步都要求**看得见的证据**（矩形 / 计算样式 / 状态栏文案），
 * 失败信息自带数字，便于我不看代码就知道坏在哪一步 ✓。
 *
 * 纪律（本域自定）：
 *   · 只用**公开接口**（MMApp / MM）驱动，动作尽量贴近用户（真鼠标事件能用的就用真鼠标 ✓）；
 *   · 每步失败都把"预期 / 实测"写进 text ✓；
 *   · 不改数据（唯一会写的是"什么都不该写"的反例 ✓）。
 */
'use strict';

// 真帧像素判据（"看得见"那半）：像素统计的唯一实现 + 阈值单源
const frameStats = require('../vision/frame-stats.js');
const VTH = frameStats.THRESHOLDS;

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓）；逗号分隔多键 ⇒ 一趟跑完多条注入 ✓ */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT.split(',').indexOf('34-' + k) >= 0;

/** 注入①：复刻**事故现场的可见性后果** —— 圆钮"在 DOM 里、rect 一切正常，却根本看不到"。
 *  用 `clip-path` 在被测元素自己身上复现（它**同时裁绘制与命中测试** ✓，而 `getBoundingClientRect`
 *  一个数都不变 ⇒ 正好证明"旧那套几何判据对裁切是盲的"）。
 *  为什么不用"把它塞回框里再 overflow:hidden"：圆钮搬进框后 `MM.fdRelShowBtnOf`（按
 *  `data-fd-box` 在**卫星浮层**里查）就**找不到它**了 ⇒ 注入会退化成"元素没了"，那不是本条的损害形态 ✗ */
const CLIP_BTN_JS = `(function () {
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
  var box = null;
  for (var i = 0; i < boxes.length; i++) {
    var q = boxes[i].getBoundingClientRect();
    if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
  }
  var b = (box && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(box) : null;
  if (!b) return JSON.stringify({ ok: false, text: '注入失败：没有圆钮' });
  b.style.clipPath = 'inset(0 100% 0 0)';
  return JSON.stringify({ ok: true, text: '已把圆钮裁光（rect / 位置 / 形状一个数都不变）' });
})()`;

/** 注入复位（只在注入开启时用；正常跑完全不调用 ✓） */
const UNDO_INJECT_JS = `(function () {
  var c = document.getElementById('mm-btn-cover-probe');
  if (c) c.parentNode.removeChild(c);
  Array.prototype.slice.call(document.querySelectorAll('.rel-show-btn')).forEach(function (x) { x.style.clipPath = ''; });
  Array.prototype.slice.call(document.querySelectorAll('.float-detail')).forEach(function (x) { x.style.overflow = ''; });
  if (window.MM.syncFdSatellites) { try { window.MM.syncFdSatellites(); } catch (e) { /* 复位尽力而为 */ } }
  return JSON.stringify({ ok: true });
})()`;

/** 圆钮矩形里的**非背景像素**（与"落盘的那张帧"同源 ⇒ 数字与图片可一起复核 ✓）
 *  这是"看得见"的另一半真判据：命中测试抓遮挡，像素抓**裁切**（被父框 overflow 裁掉时命中测试
 *  也可能落到框上、而像素一定骤降 ✓）。阈值单源在 `thresholds.paint.minHitsRoundBtn` ✓ */
async function btnPixels(ctx, sat) {
  if (!ctx.input || !sat || !sat.ok) return { ok: false, hits: 0, reason: '没有圆钮或没有真输入底座（取不到真帧 = 红）' };
  const img = await ctx.input.capture();
  const dpr = sat.dpr || 1;
  return frameStats.scanRegion(img, { x: sat.left * dpr, y: sat.top * dpr, width: sat.width * dpr, height: sat.height * dpr },
    { predicate: frameStats.nonBackgroundPredicate() });
}

/** 圆钮的现场读数（存在 / 尺寸 / **真可见** / 在框外 / 贴哪边）——多处复用 ✓
 *
 *  ⚠️【可见性判据迁移（2026-10-09）】这里曾是**事故现场**：`visible` 只看
 *  `r.width > 8 && r.height > 8 && !!b.offsetParent` —— 纯几何，圆钮被详情框 `overflow:hidden`
 *  裁掉时四个 round 全绿 ✗（用户两轮报"看不见"，而断言一直绿）。
 *  现在 `visible` 仍是几何那一半（保留原语义），但**断言必须同时**要求：
 *    ① `hitIsBtn` —— `document.elementFromPoint(圆心)` 命中圆钮自身（抓遮挡，浏览器自己回答）；
 *    ② `btnPixels()` 的非背景像素 ≥ 阈值（抓裁切/没画出来）。
 *  两样缺一不可：命中测试答不了"画面上没有"，像素答不了"被盖在顶上" ✓ */
const BTN_JS = `(function () {
  // 只认**可见的那个**详情框（域与域之间会留下隐藏的旧框 ✗ 实测量到过 121x121、负坐标的僵尸框 ✓）
  var allBoxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
  var box = null;
  for (var bi = 0; bi < allBoxes.length; bi++) {
    var bq0 = allBoxes[bi].getBoundingClientRect();
    if (allBoxes[bi].style.display !== 'none' && bq0.width > 40 && bq0.height > 40) { box = allBoxes[bi]; break; }
  }
  var b = (box && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(box) : null;
  if (!b) return JSON.stringify({ ok: false, text: '没有圆钮（.rel-show-btn）' });
  var r = b.getBoundingClientRect();
  var bq = box.getBoundingClientRect();
  var cs = window.getComputedStyle(b);
  var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  var at = document.elementFromPoint(cx, cy);
  return JSON.stringify({
    ok: true,
    w: Math.round(r.width), h: Math.round(r.height),
    left: r.left, top: r.top, width: r.width, height: r.height,
    center: { x: cx, y: cy }, dpr: window.devicePixelRatio || 1,
    // ★ 真判据①：命中测试（rect 对裁切与遮挡是盲的）
    hitIsBtn: !!(at && at.closest && at.closest('.rel-show-btn') === b),
    hitWhat: at ? ((at.className && String(at.className).slice(0, 40)) || at.tagName) : null,
    visible: (r.width > 8 && r.height > 8) && (!!b.offsetParent || r.width > 0),
    outsideBox: (r.right <= bq.left + 1 || r.left >= bq.right - 1),
    right: b.classList.contains('is-right'), on: b.classList.contains('is-on'),
    radius: cs.borderTopLeftRadius, nodeId: b.getAttribute('data-rel-node'),
    boxLeft: Math.round(bq.left), boxRight: Math.round(bq.right), btnLeft: Math.round(r.left)
  });
})()`;

/** 选两个"不同层"的真实节点：一个**有子节点**的 p，和它的第一个子 c（父子对 ⇒ 专打 trimSelection 那条路 ✓）
 *  return {ok, p, c} —— 找不到就如实报 ✗ */
const PICK_PC_JS = `(function () {
  var jm = window.MMApp.getState().jm;
  var all = window.MMApp.getState().jm.get_root();
  var found = null;
  (function walk(n) {
    if (found || !n) return;
    var kids = n.children || [];
    if (n.id && n.id !== 'root' && kids.length && kids[0] && kids[0].id) {
      found = { p: n.id, c: kids[0].id }; return;
    }
    kids.forEach(walk);
  })(all);
  return JSON.stringify(found ? { ok: true, p: found.p, c: found.c } : { ok: false, text: '找不到有子节点的节点' });
})()`;

// ⚠️ 曾被撤下的探针（2026-10-08 第二轮真机反馈后）：
//   原"⑥ 把详情框拖到面板最左缘 ⇒ 圆钮仍在、仍在框外"**手法不成立** —— 详情框位置由它自己的
//   定位机制（fdBoxes + transform）摆 ✓，探针直接改 box.style.left 会让它落到奇怪位置，量出
//   伪读数（实测圆钮 rect=[-256,-135]、w=121x121 ✗）。这条需求目前由：
//     ① MM.placeRelShowBtn 的实测矩形判定 + MutationObserver 重判（代码层 ✓）
//     ② 域 25 的"就地可见 + 在框外"断言（静态几何 ✓）
//     ③ 用户真机拖动复核（唯一能覆盖动态路径的 ✓）
//   三层守着；要补自动覆盖，应用**真鼠标拖动**来写（参考域 05 的拖法 ✓）。
module.exports = [
  {
    name: '用户路径①：详情框**反复开关/切节点**，圆钮每次都在、都在框外、都是圆形（治"出现一次就消失"）'
      + '【可见那半=elementFromPoint 命中圆心 + 真帧像素】',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 取不到真帧 = 红' };
      const pick = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, out = [];
        (function walk(n) { if (!n) return; if (n.id && n.id !== 'root' && out.length < 2) out.push(n.id); (n.children || []).forEach(walk); })(jm.get_node('root'));
        return JSON.stringify({ ok: out.length === 2, a: out[0], b: out[1] });
      })()`);
      if (!pick.ok) return { ok: false, text: '挑不到两个节点' };
      const seq = [pick.a, pick.b, pick.a, pick.b];   // 切四次 ⇒ 覆盖"每次渲染都要有" ✓
      const injectClip = MY_KEY('clip-btn');
      const rounds = [];
      for (let i = 0; i < seq.length; i++) {
        await ctx.exec(`(function () { var n = window.MMApp.getState().jm.get_node(${JSON.stringify(seq[i])}); if (n) window.MMApp.showDetail(n); return 1; })()`);
        await ctx.input.settle({ delayMs: 140 });     // ≥2 帧 + 覆盖过渡 ⇒ 抓到的帧才是"现在的画面" ✓
        // —— 判别力证明（`MM_SMOKE_INJECT=34-clip-btn`）：注入①（复刻事故现场，见 CLIP_BTN_JS）——
        //    注入后 `visible`/`outsideBox`/`radius` 三个几何读数**全都还是好的**，只有
        //    命中测试与真帧像素判得出来 ⇒ 这正是本次迁移要保住的那条纪律 ✓
        if (injectClip) await execJson(ctx, CLIP_BTN_JS);
        const s = await execJson(ctx, BTN_JS);
        const pix = await btnPixels(ctx, s);
        const geometryOk = !!(s.ok && s.visible && s.outsideBox && s.radius === '50%');
        const ok = geometryOk && s.hitIsBtn === true && pix.ok === true && pix.hits >= VTH.paint.minHitsRoundBtn;
        rounds.push({ node: seq[i], ok: ok,
          text: s.text || ('w=' + s.w + ' 在框外=' + s.outsideBox + ' 圆角=' + s.radius + ' 几何可见=' + s.visible
            + ' 命中测试命中圆钮=' + s.hitIsBtn + '（命中=' + s.hitWhat + '）'
            + ' 真帧非背景像素=' + (pix.ok ? pix.hits : ('扫描失败:' + pix.reason))
            + '（阈值 ≥' + VTH.paint.minHitsRoundBtn + '）') });
      }
      if (injectClip) await execJson(ctx, UNDO_INJECT_JS);   // 注入收尾一律复位 ✓
      const bad = rounds.filter((r) => !r.ok);
      return { ok: bad.length === 0, text: '四轮=' + JSON.stringify(rounds) };
    }
  },
  {
    name: '用户路径②：圆钮**不依赖关联数据**（打开详情后同一 tick 就得在，不等 IPC ✓），且无关联节点也有',
    run: async (ctx) => {
      // ① 同一 tick 检查：showDetail（同步渲染）后立刻查 —— 若圆钮要靠 assoc 查询回调才建，这里必红 ✓
      const now = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, id = null;
        (function walk(n) { if (id || !n) return; if (n.id && n.id !== 'root') { id = n.id; return; } (n.children || []).forEach(walk); })(jm.get_node('root'));
        if (!id) return JSON.stringify({ ok: false, text: '挑不到节点' });
        window.MM.clearSelection && window.MM.clearSelection();
        var n = jm.get_node(id);
        window.MMApp.showDetail(n);            // 同步：renderFdBox → renderDetail 同一 tick
        var boxEl0 = document.querySelector('.float-detail');
        var b = (boxEl0 && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(boxEl0) : null;
        return JSON.stringify({ ok: !!b, id: id, text: '同 tick 有圆钮=' + !!b + '（节点 ' + id + '）' });
      })()`);
      if (!now.ok) return { ok: false, text: '同 tick 检查失败：' + now.text };
      // ② 找一个**真的没有关联**的节点（related 返回 0 条），确认它也有圆钮 ✓
      const proj = await execJson(ctx, `(function () { var p = window.MMApp.getState().project; return JSON.stringify({ ok: !!p, name: p && p.name }); })()`);
      if (!proj.ok) return { ok: false, text: '拿不到项目名' };
      const empty = await execJson(ctx, `(async function () {
        var jm = window.MMApp.getState().jm, ids = [];
        (function walk(n) { if (!n) return; if (n.id && n.id !== 'root' && ids.length < 60) ids.push(n.id); (n.children || []).forEach(walk); })(jm.get_node('root'));
        for (var i = 0; i < ids.length; i++) {
          try {
            var r = await window.desktop.app.related(${JSON.stringify(proj.name)}, ids[i]);
            var n = (r && r.items) ? r.items.length : -1;
            if (n === 0) return JSON.stringify({ ok: true, id: ids[i] });
          } catch (e) { /* 查不了就继续找 ✓ */ }
        }
        return JSON.stringify({ ok: false, text: '这批节点里找不到"零关联"的（可能都被链过）' });
      })()`);
      if (!empty.ok) return { ok: false, text: empty.text };
      const st = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, n = jm.get_node(${JSON.stringify(empty.id)});
        if (!n) return JSON.stringify({ ok: false, text: '节点没了' });
        window.MMApp.showDetail(n);
        var boxEl1 = document.querySelector('.float-detail');
        var b = (boxEl1 && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(boxEl1) : null;
        return JSON.stringify({ ok: !!b, text: '零关联节点 ' + ${JSON.stringify(empty.id)} + ' 有圆钮=' + !!b });
      })()`);
      return { ok: !!st.ok, text: now.text + ' ｜ ' + st.text };
    }
  },
  {
    name: '用户路径③：Ctrl 加选**父子两个都描边**（专打 trimSelection 那条路 ✗）且**没有大虚线框**',
    run: async (ctx) => {
      const pc = await execJson(ctx, PICK_PC_JS);
      if (!pc.ok) return { ok: false, text: pc.text };
      const r = await execJson(ctx, `(function () {
        var MM = window.MM;
        if (MM.clearSelection) MM.clearSelection();
        MM.toggleNodeSelection(${JSON.stringify(pc.p)});
        MM.toggleNodeSelection(${JSON.stringify(pc.c)});      // 子节点 —— 旧版会被"剔父冗余"踢出选区/描边 ✗
        var raw = MM.getSelectionRaw ? MM.getSelectionRaw() : [];
        var cls = (MM.rawSelectionClass && MM.rawSelectionClass()) || 'mm-sel-raw';
        var painted = [${JSON.stringify(pc.p)}, ${JSON.stringify(pc.c)}].map(function (id) {
          var el = document.querySelector('jmnode[nodeid="' + id + '"]');
          var cs = el ? window.getComputedStyle(el) : null;
          return { id: id, cls: !!(el && el.classList.contains(cls)),
            dashed: !!(cs && cs.outlineStyle === 'dashed' && parseFloat(cs.outlineWidth) >= 1.5) };
        });
        var box = document.getElementById('dsh-selection-outline');
        var boxVisible = !!box && box.style.display !== 'none';
        return JSON.stringify({
          ok: raw.length === 2 && raw.indexOf(${JSON.stringify(pc.p)}) >= 0 && raw.indexOf(${JSON.stringify(pc.c)}) >= 0
            && painted.every(function (x) { return x.cls && x.dashed; }) && !boxVisible,
          text: 'raw=' + raw.join(',') + ' ｜ 描边=' + JSON.stringify(painted)
            + ' ｜ 大虚线框可见=' + boxVisible + '（必须 false ✓）'
        });
      })()`);
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); if (window.MM.paintRawSelection) window.MM.paintRawSelection(); return 1; })()');
      return { ok: !!r.ok, text: r.text };
    }
  },
  {
    name: '用户路径④：双击**叶子节点**⇒ 打开**它自己的**详情框（R5-3 新语义：无父子关系 ⇒ 开详情）、不弹编辑框、不报错（边界）',
    run: async (ctx) => {
      const r = await execJson(ctx, `(async function () {
        var jm = window.MMApp.getState().jm, id = null;
        (function walk(n) { if (id || !n) return; var k = n.children || []; if (n.id && n.id !== 'root' && k.length === 0) { id = n.id; return; } k.forEach(walk); })(jm.get_node('root'));
        if (!id) return JSON.stringify({ ok: false, text: '找不到叶子节点' });
        /* 从"一个框都没有"起（否则"框在"这个读数没有分辨力 —— 旧版开头先 showDetail 一次，
         * 那样"双击后仍有一个框"在双击**什么也没做**时照样成立 ✗）。 */
        await window.MMApp.closeAllFloatDetail();
        window.MM.setStatus('（探针起点）');
        var el = document.querySelector('jmnode[nodeid="' + id + '"]');
        if (!el) return JSON.stringify({ ok: false, text: '叶子不可见：' + id });
        var before = window.MMApp.getFloatDetailState().boxes;
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        var after = window.MMApp.getFloatDetailState();
        var dlg = document.getElementById('edit-dialog').style.display === 'flex';
        if (dlg) document.getElementById('edit-cancel').click();
        /* 期望（R5-3 起）：双击叶子 ⇒ **它自己的**详情框被打开（旧口径"只给状态说明"已被 R5-3 取代，
         * 见 renderer/contextmenu.js 的 onDblClick）；编辑框仍不得弹出 ✓；不报错 ✓ */
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        var ok = before === 0 && after.boxes === 1 && after.nodeId === id && !dlg;
        return JSON.stringify({ ok: ok, id: id, text: '叶子=' + id + ' 框数 ' + before + '→' + after.boxes
          + '（属主=' + JSON.stringify(after.nodeId) + '，应为 ' + JSON.stringify(id) + '） 编辑框=' + dlg
          + ' 状态栏=' + JSON.stringify(String(status).slice(0, 60)) });
      })()`);
      return { ok: !!r.ok, text: r.text };
    }
  },
  {
    name: '用户路径⑤：零关联节点点圆钮 ⇒ 不报错、确实进入关联视图、再点退出（不炸不静默）',
    run: async (ctx) => {
      const r = await execJson(ctx, `(async function () {
        var jm = window.MMApp.getState().jm, ids = [];
        (function walk(n) { if (!n) return; if (n.id && n.id !== 'root' && ids.length < 40) ids.push(n.id); (n.children || []).forEach(walk); })(jm.get_node('root'));
        var target = null, pn = (window.MMApp.getState().project || {}).name;
        for (var i = 0; i < ids.length && !target; i++) {
          try { var q = await window.desktop.app.related(pn, ids[i]); if (q && q.items && q.items.length === 0) target = ids[i]; } catch (e) { /* 跳过 */ }
        }
        if (!target) return JSON.stringify({ ok: false, text: '找不到零关联节点' });
        // 前置：先把关联视图**关掉**（域 25 可能留它开着 ⇒ 否则这里一点就变成"退出" ✗ 假红 ✓）
        if (window.MM.clearRelated) window.MM.clearRelated();
        window.MMApp.showDetail(jm.get_node(target));
        // 只点**可见那个框**里的圆钮（陈旧的隐藏框里也有一颗 ⇒ 点到它 = 什么都没发生 ✗ 假红 ✓）
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var vbox = null;
        for (var bi = 0; bi < boxes.length; bi++) {
          var bq = boxes[bi].getBoundingClientRect();
          if (boxes[bi].style.display !== 'none' && bq.width > 40 && bq.height > 40) { vbox = boxes[bi]; break; }
        }
        var btn = (vbox && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(vbox) : null;
        if (!btn) return JSON.stringify({ ok: false, text: '可见框里没有圆钮（可见框数=' + (vbox ? 1 : 0) + '）' });
        var before = { active: !!(window.MM.isRelatedActive && window.MM.isRelatedActive()) };
        var err = null;
        try { btn.click(); } catch (e1) { err = String((e1 && e1.message) || e1); }
        var hasApi = typeof window.MM.showRelated;
        // ⚠️ showRelated 内部有两次 IPC（assoc + related）⇒ **必须等**（实测踩到：点完立刻读 ⇒ 假红 ✗）
        var afterOn = false;
        var waited = 0;
        while (waited < 2000) {
          afterOn = !!(window.MM.isRelatedActive && window.MM.isRelatedActive());
          if (afterOn) break;
          await new Promise(function (res) { setTimeout(res, 100); });
          waited += 100;
        }
        var status1 = (document.querySelector('#status-text') || {}).textContent || '';
        if (window.MM.clearRelated) window.MM.clearRelated();
        var afterOff = !!(window.MM.isRelatedActive && window.MM.isRelatedActive());
        return JSON.stringify({ ok: !before.active && afterOn && !afterOff, node: target, err: err, hasApi: hasApi,
          text: '零关联节点=' + target + ' 点前=' + before.active + ' 点后=' + afterOn + ' 退出后=' + afterOff
            + ' 异常=' + JSON.stringify(err) + ' typeof MM.showRelated=' + hasApi
            + ' 等待=' + waited + 'ms 状态栏=' + JSON.stringify(status1.slice(0, 50)) });
      })()`);
      return { ok: !!r.ok, text: r.text };
    }
   },
  {
    /* 【可见性判据迁移（2026-10-09）】原判据 = 一句纯 rect 包含判断（`r.left >= pr.left && r.right <= pr.right`）
     *  —— **事故现场**：面板自己 `overflow:hidden` 把圆钮裁掉时，rect 依然"落在框内" ⇒ 断言恒绿 ✗。
     *  迁到真判据：① `elementFromPoint(圆心)` 命中圆钮自身（抓遮挡）；
     *  ② 真帧里数圆钮矩形内的非背景像素（**被裁则像素骤降** —— 这才是"完整"的判据）；
     *  `insidePanel` 那句 rect 保留原样，只作为几何旁证（不再是"看得见"的依据）✓ */
    name: '关联视图：三个入口都在（圆钮 ✓ 右键菜单 ✓ 命令面板 ✓），且圆钮**完整落在面板内**（看不见=没有 ✗）'
      + '【判据=elementFromPoint 命中 + 真帧像素】',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 取不到真帧 = 红' };
      const pick = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, id = null;
        (function walk(n) { if (id || !n) return; if (n.id && n.id !== 'root') { id = n.id; return; } (n.children || []).forEach(walk); })(jm.get_node('root'));
        if (!id) return JSON.stringify({ ok: false, text: '挑不到节点' });
        window.MMApp.showDetail(jm.get_node(id));
        return JSON.stringify({ ok: true, id: id });
      })()`);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.input.settle({ delayMs: 200 });
      // —— 判别力证明（`MM_SMOKE_INJECT=34-btn-covered`）：把浮层盖在圆钮上 ——
      //    `insidePanel` / rect **全都还是 true**（旧判据完全看不见这件事），只有命中测试判得出来 ✓
      const injectCover = MY_KEY('btn-covered');
      if (injectCover) {
        const inj = await execJson(ctx, `(function () {
          var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
          var box = null;
          for (var i = 0; i < boxes.length; i++) {
            var q = boxes[i].getBoundingClientRect();
            if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
          }
          var b = (box && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(box) : null;
          if (!b) return JSON.stringify({ ok: false, text: '注入失败：没有圆钮' });
          var r = b.getBoundingClientRect();
          var cov = document.createElement('div');
          cov.id = 'mm-btn-cover-probe';
          cov.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width
            + 'px;height:' + r.height + 'px;background:#ffe58f;z-index:99999;';
          document.body.appendChild(cov);
          return JSON.stringify({ ok: true, text: '已盖上浮层（rect 不变）' });
        })()`);
        if (!inj.ok) return { ok: false, text: inj.text };
      }
      // ① 圆钮真的看得见（被 overflow:hidden 裁掉 ⇒ 用户就是"看不到" ✓）
      const circle = await execJson(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { box = boxes[i]; break; }
        }
        var b = (box && window.MM.fdRelShowBtnOf) ? window.MM.fdRelShowBtnOf(box) : null;
        if (!b) return JSON.stringify({ ok: false, text: '没有圆钮' });
        var p = window.MM.fdPanel ? window.MM.fdPanel() : null;
        var pr = p ? p.getBoundingClientRect() : null;
        var r = b.getBoundingClientRect();
        var insidePanel = !!pr && r.left >= pr.left - 1 && r.right <= pr.right + 1;
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var at = document.elementFromPoint(cx, cy);
        return JSON.stringify({ ok: insidePanel, insidePanel: insidePanel,
          hitIsBtn: !!(at && at.closest && at.closest('.rel-show-btn') === b),
          hitWhat: at ? ((at.className && String(at.className).slice(0, 40)) || at.tagName) : null,
          left: r.left, top: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1,
          text: '圆钮=[' + Math.round(r.left) + ',' + Math.round(r.right) + '] 面板=[' + Math.round(pr.left) + ',' + Math.round(pr.right) + '] 完整在内=' + insidePanel + ' 档=' + (b.getAttribute('data-place') || (b.classList.contains('is-right') ? 'right' : 'left')) });
      })()`);
      const cpix = await btnPixels(ctx, circle);
      const circleOk = !!(circle.ok && circle.insidePanel && circle.hitIsBtn === true
        && cpix.ok === true && cpix.hits >= VTH.paint.minHitsRoundBtn);
      // ② 右键菜单里有入口（真派发一次 contextmenu 事件，读菜单文本 ✓）
      const menu = await execJson(ctx, `(function () {
        var el = document.querySelector('jmnode[nodeid="' + ${JSON.stringify(pick.id)} + '"]');
        if (!el) return JSON.stringify({ ok: false, text: '节点不可见' });
        var r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
        var m = document.getElementById('ctx-menu');
        var txt = m ? (m.textContent || '') : '';
        var has = txt.indexOf('关联节点') >= 0;
        if (window.MMContextMenu && window.MMContextMenu.closeMenu) window.MMContextMenu.closeMenu();
        return JSON.stringify({ ok: has, text: '菜单含「关联节点」=' + has + ' 菜单长度=' + txt.replace(/\\s+/g, ' ').trim().length });
      })()`);
      // ③ 命令面板里有入口（打开面板 → 搜「关联节点视图」→ 命中 ✓）
      await ctx.exec('(function () { document.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'p\', ctrlKey: true, bubbles: true })); return 1; })()');
      await new Promise((r) => setTimeout(r, 300));
      let pal = null;
      for (let i = 0; i < 20; i++) {
        const r2 = await execJson(ctx, `(function () {
          var i2 = document.getElementById('palette-input');
          if (!i2) return JSON.stringify({ ok: false, text: '没打开面板' });
          i2.value = '关联节点视图';
          i2.dispatchEvent(new Event('input', { bubbles: true }));
          var items = document.querySelectorAll('#palette .palette-item');
          var labels = [].map.call(items, function (x) { return (x.querySelector('.palette-label') || {}).textContent || ''; });
          var hit = labels.some(function (L) { return L.indexOf('关联节点视图') >= 0; });
          return JSON.stringify({ ok: hit, n: items.length, labels: labels.slice(0, 3) });
        })()`);
        pal = r2;
        if (pal.ok) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      await ctx.exec('(function () { document.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'Escape\', bubbles: true })); return 1; })()');
      if (injectCover) await execJson(ctx, UNDO_INJECT_JS);   // 注入收尾一律复位 ✓
      return {
        ok: !!(circleOk && menu.ok && pal && pal.ok),
        text: circle.text
          + ' 命中测试命中圆钮=' + circle.hitIsBtn + '（命中=' + circle.hitWhat + '）'
          + ' 真帧非背景像素=' + (cpix.ok ? cpix.hits : ('扫描失败:' + cpix.reason))
          + '（阈值 ≥' + VTH.paint.minHitsRoundBtn + '）'
          + ' ｜ ' + menu.text + ' ｜ 命令面板命中=' + (pal ? pal.ok : false) + ' 项=' + (pal ? pal.n : '-')
      };
    }
  }
];
