/* ============================================================
 * scripts/smoke/25-related-view.js — 关联节点可视化（功能 2）
 * ------------------------------------------------------------
 * 覆盖四条，都是**几何或机制**级证据（不是"看起来做了"）：
 *   1) 详情的「关联笔记」区有「展示关联节点」按钮；点它之后：关联节点被高亮、其余被轻微虚化、
 *      并且**视口缩放到刚好框住**它们（判据是屏幕几何：目标节点的矩形都落在面板内，
 *      且贴合度足够 —— 只判"都在里面"会被"缩得太小"骗过 ✗）
 *   2) 关系层**随导图同变换**：改一次视图变换后，线的端点在**屏幕坐标**上仍贴合两端节点
 *      （这正是"忘了把 SVG 挂进 fdViewEls()"会露馅的地方 ✗）
 *   3) 点线 ⇒ 打开那篇关联笔记，且位置**取决于鼠标点击位置**（大锁钉住，不跟导图跑）
 *      —— 与"从入口原位打开"是两种位置来源，这里判的是**离点击点足够近**
 *   4) 退出（Esc）⇒ 高亮/虚化类被清干净、线层清空（**不留残影**：下次展示前是干净状态）
 *
 * 数据：关联笔记没有界面创建入口（设计如此），故先用 ctx.runCli 在**冒烟沙箱副本**里造一篇，
 * 再用界面验证。ctx.runCli 已被 AI_MINDMAP_PROJECTS_DIR 指向沙箱 —— 不碰真实数据 ✓
 * ============================================================ */
'use strict';

const PROJ = 'comnet';
// ⚠️ 不能用写死的节点名，也不该自己造节点：
//   · 写死（曾用 tcp-handshake / tcp-reliable）会在**全量运行**里红 —— 前面的域会删节点
//     （实测报错 `节点不存在: comnet/tcp-reliable`），而单跑却绿 ⇒ 典型顺序依赖 ✗；
//   · 自己用 CLI 造节点则**进不了界面内存**（界面在种子之前就加载完了）⇒ 详情框还停在旧节点，
//     按钮带着旧 id，于是"高亮集"对不上（实测踩到 ✗）。
// ⇒ 正确做法：**运行时从界面自己的树里挑两个真实存在的节点**，再用 CLI 给它们建一篇关联笔记
//   （关联数据在界面里是"详情渲染时从磁盘重拉"的 ✓ 与节点不同）。
let PICK = [];   // [nodeA, nodeB]，由第 1 条断言运行时挑好
const TITLE = '冒烟探针·功能2：握手与可靠传输';

/** 造一篇关联笔记（沙箱副本内）。失败时**如实报错**（早期版本返回布尔把原因吞了，
 *  全量运行里红了却看不出为什么 —— 静默失败是本工程最忌讳的类别 ✗） */
function seed(ctx, a, b) {
  try {
    ctx.runCli(['assoc-add', PROJ, '--members', a + ',' + b, '--title', TITLE, '--note-md', '**先建连**，再在其上做可靠传输。']);
    return { ok: true, text: '' };
  } catch (e) {
    return { ok: false, text: 'seed 失败：' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300) };
  }
}

/** 轮询等待（渲染有异步 IPC） */
async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 40); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/** 在渲染层执行并解析 JSON（失败时把原文当诊断） */
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 200) }; }
}

module.exports = [
  {
    name: '关联节点：详情按钮「展示关联节点」⇒ 高亮关联节点 + 虚化其余 + 缩放到刚好框住（屏幕几何判定）',
    run: async (ctx) => {
      // ① 运行时挑两个**真实存在**的节点（理由见文件头：写死会顺序依赖、自造进不了界面内存）
      const pick = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, out = [];
        (function walk(n) {
          if (!n) return;
          if (n.id && n.id !== 'root' && out.length < 2 && out.indexOf(n.id) < 0) out.push(n.id);
          (n.children || []).forEach(walk);
        })(jm.get_node('root'));
        return JSON.stringify({ ok: out.length === 2, text: out.join(',') });
      })()`);
      if (!pick.ok) return { ok: false, text: '挑不到两个节点：' + pick.text };
      PICK = pick.text.split(',');
      const s = seed(ctx, PICK[0], PICK[1]);
      if (!s.ok) return { ok: false, text: s.text };
      // ② 打开第一个节点的详情（会从磁盘重拉关联笔记并同步进内存 ✓）
      await ctx.exec(`(function () {
        var app = window.MMApp, jm = app.getState().jm, n = jm.get_node(${JSON.stringify(PICK[0])});
        if (n) app.showDetail(n);
        return 1;
      })()`);
      // 等按钮出现（详情内容是异步拉的）
      const btn = await waitFor(ctx, `(function () {
        var b = document.querySelector('.float-detail .rel-show-btn');
        if (!b) return JSON.stringify({ ok: false, text: '还没有 .rel-show-btn' });
        // ★ 用户 2026-10-08「关联视图去哪里了？」⇒ 只验存在不够 ✗：必须真的**看得见** ✓
        //   （有面积 + 落在面板内 —— 同型的坑刚在 ① 上踩过：类名在、样式不生效 ✓）
        var r = b.getBoundingClientRect();
        var p = (window.MM.fdPanel ? window.MM.fdPanel() : null);
        var pr = p ? p.getBoundingClientRect() : null;
        var area = r.width > 8 && r.height > 8;
        var inside = !!pr && r.left >= pr.left - 2 && r.right <= pr.right + 2 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2;
        var vis = !!b.offsetParent || (r.width > 0 && r.height > 0);
        // ★ 圆形判定（用户 2026-10-08 第二批："变成一个圆形按钮浮在节点详情左边" ✓）
        var cs = window.getComputedStyle(b);
        // ★ 不遮挡节点详情框（用户 2026-10-08 第二批 ✗）：圆钮必须在框的**横向之外** ✓
        var bx = b.closest ? b.closest('.float-detail') : null;
        var bq = bx ? bx.getBoundingClientRect() : null;
        var outsideBox = !!bq && (r.right <= bq.left + 1 || r.left >= bq.right - 1);
        var radius = cs.borderTopLeftRadius || '';
        var round = (radius === '50%' || parseFloat(radius) >= Math.min(r.width, r.height) / 2 - 1);
        return JSON.stringify({ ok: !!area && !!inside && !!vis && round && outsideBox,
          text: '按钮=' + (b.textContent || '').trim() + ' 面积=' + Math.round(r.width) + 'x' + Math.round(r.height)
            + ' 在面板内=' + inside + ' 可见=' + vis + ' 圆形=' + round + ' 圆角=' + radius + ' 在框外(不遮挡)=' + outsideBox });
      })()`);
      let o = JSON.parse(btn);
      if (!o.ok) return { ok: false, text: o.text };
      // 点它
      await ctx.exec(`document.querySelector('.float-detail .rel-show-btn').click(); 1`);
      const res = await waitFor(ctx, `(function () {
        var MM = window.MM;
        var panel = MM.fdPanel ? MM.fdPanel() : null;   // 权威口径：视图层自己的面板（不猜选择器）
        var p = panel ? panel.getBoundingClientRect() : null;
        var hits = Array.prototype.slice.call(document.querySelectorAll('jmnode.mm-rel-hit'));
        var dims = document.querySelectorAll('jmnode.mm-rel-dim');
        var svg = document.querySelector('#mm-rel-layer');
        if (!hits.length) return JSON.stringify({ ok: false, text: '还没有 .mm-rel-hit（高亮没生效）' });
        if (!p) return JSON.stringify({ ok: false, text: 'MM.fdPanel() 拿不到面板' });
        // ① 每个高亮节点都应在面板内（"刚好展示"的必要条件）
        var out = 0, L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
        hits.forEach(function (el) {
          var r = el.getBoundingClientRect();
          L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom);
          if (r.left < p.left - 2 || r.right > p.right + 2 || r.top < p.top - 2 || r.bottom > p.bottom + 2) out++;
        });
        // ② 贴合度：并集应占据面板的相当一部分（否则就是"缩得太小"，看着像框住了其实没利用空间）
        var span = Math.max((R - L) / p.width, (B - T) / p.height);
        var st = MM.getPanState();
        var fitOk = (out === 0) && (span >= 0.55 || st.s >= 3.9);
        return JSON.stringify({
          ok: fitOk && dims.length > 0 && !!svg && Number(svg.dataset.count) > 0,
          text: '高亮=' + hits.length + ' 虚化=' + dims.length + ' 线=' + (svg ? svg.dataset.count : '无')
            + ' 越界=' + out + ' 占比=' + span.toFixed(2) + ' s=' + st.s.toFixed(2)
            // 尺寸一并记（排查"线/节点跑到视口外"时必须先知道这两个数谁大）
            + ' 面板=' + Math.round(p.width) + 'x' + Math.round(p.height)
            + ' 窗口=' + window.innerWidth + 'x' + window.innerHeight
            + ' 面板位置=(' + Math.round(p.left) + ',' + Math.round(p.top) + ')'
        });
      })()`);
      o = JSON.parse(res);
      // 再补一条：高亮集合必须等于模型成员 **∪ 当前节点**（当前节点也高亮，它是星形中心）。
      // 注意不能只比成员集 —— 实测第一版就是漏了当前节点而被判红（断言自己写错，不是功能错）
      const setChk = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, MM = window.MM;
        var want = MM.relatedMembers().concat([${JSON.stringify(PICK[0])}]).sort().join(',');
        var got = Array.prototype.slice.call(document.querySelectorAll('jmnode.mm-rel-hit'))
          .map(function (el) { return el.getAttribute('nodeid'); }).sort().join(',');
        var hasB = got.indexOf(${JSON.stringify(PICK[1])}) >= 0;
        return JSON.stringify({ ok: want === got && hasB, text: '高亮集=' + got + '（应为 ' + want + '）含第二个节点=' + hasB });
      })()`);
      return { ok: !!o.ok && !!setChk.ok, text: o.text + ' ｜ ' + setChk.text };
    }
  },
  {
    name: '关联节点：关系线随导图变换（缩放/平移后，线的端点在**屏幕坐标**上仍贴合两端节点）',
    run: async (ctx) => {
      // 先把视图改到一个"随便但不规则"的变换：线若没挂进 fdViewEls()，端点必然错位 ox*(1-s)
      await ctx.exec(`window.MM.setViewTransform({ s: 0.8, x: 60, y: 40 }); 1`);
      await ctx.exec(`window.MM.redrawRelatedLines(); 1`);
      const res = await execJson(ctx, `(function () {
        var svg = document.querySelector('#mm-rel-layer');
        if (!svg) return JSON.stringify({ ok: false, text: '没有 #mm-rel-layer' });
        var lines = svg.querySelectorAll('path.mm-rel-line');
        if (!lines.length) return JSON.stringify({ ok: false, text: '关系层里没有线' });
        // 线自身的"逻辑坐标"取自 d 属性；用 getScreenCTM 换算到屏幕，与节点自身的屏幕矩形比
        var bad = [], maxErr = 0;
        for (var i = 0; i < lines.length; i++) {
          var p = lines[i], d = p.getAttribute('d');
          var m = d.match(/^M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)$/);
          if (!m) { bad.push('d格式=' + d); break; }
          var a = document.querySelector('jmnode[nodeid="' + p.getAttribute('data-rel-a') + '"]');
          var b = document.querySelector('jmnode[nodeid="' + p.getAttribute('data-rel-b') + '"]');
          if (!a || !b) { bad.push('端点节点找不到'); break; }
          var ctm = p.getScreenCTM();
          function toScreen(x, y) {
            var q = svg.createSVGPoint(); q.x = Number(x); q.y = Number(y);
            var s = q.matrixTransform(ctm); return { x: s.x, y: s.y };
          }
          var s1 = toScreen(m[1], m[2]), s2 = toScreen(m[3], m[4]);
          var r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect();
          var e1 = Math.hypot(s1.x - (r1.left + r1.width / 2), s1.y - (r1.top + r1.height / 2));
          var e2 = Math.hypot(s2.x - (r2.left + r2.width / 2), s2.y - (r2.top + r2.height / 2));
          maxErr = Math.max(maxErr, e1, e2);
          if (e1 > 6 || e2 > 6) bad.push('第' + i + '条误差 ' + Math.max(e1, e2).toFixed(1) + 'px');
        }
        return JSON.stringify({ ok: bad.length === 0, text: '线=' + lines.length + ' 最大端点误差=' + maxErr.toFixed(1) + 'px'
          + (bad.length ? ' ✗ ' + bad.slice(0, 2).join('；') : '') });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '关联节点：点线 ⇒ 按**鼠标点击位置**打开那篇关联笔记（大锁钉住，不跟导图跑）',
    run: async (ctx) => {
      // 前置：**重新进入展示态**。上一条断言为了验"线跟变换"把视图改成了 s=0.8/平移，
      // 关联节点可能因此散到视口外（实测就这样：整条线的采样点全在视口外 ✗）——
      // 本断言自己建前置条件，不依赖上一条留下的视图（真人点线时也正看着那次 fit ✓）
      await ctx.exec(`window.MM.showRelated(${JSON.stringify(PICK[0])}); 1`);
      await waitFor(ctx, `(function () {
        var svg = document.querySelector('#mm-rel-layer');
        return JSON.stringify({ ok: !!svg && Number(svg.dataset.count) > 0,
          text: '线=' + (svg ? svg.dataset.count : '无') });
      })()`);
      // 找一条**带关联笔记**的线（data-assoc 非空）在视口内的一个点。
      // · 为什么挑"带 assoc"：链接关系的线本身没有关联笔记（点它只应给说明，不该硬开一篇）；
      // · 为什么沿整条线采样：线常常很长、中点跑到视口外，而真人只会点看得见的那一段 ✓
      const hitPt = await execJson(ctx, `(function () {
        var svg = document.querySelector('#mm-rel-hit-layer');
        if (!svg) return JSON.stringify({ ok: false, text: '没有命中层 #mm-rel-hit-layer' });
        var hits = Array.prototype.slice.call(svg.querySelectorAll('path.mm-rel-hitpath'));
        var withAssoc = hits.filter(function (h) { return (h.getAttribute('data-assoc') || '').length > 0; });
        function ptAt(h, t) {
          var d = h.getAttribute('d').match(/^M([-\\d.]+),([-\\d.]+) L([-\\d.]+),([-\\d.]+)$/);
          if (!d) return null;
          var ctm = h.getScreenCTM();
          var q = svg.createSVGPoint();
          q.x = Number(d[1]) + (Number(d[3]) - Number(d[1])) * t;
          q.y = Number(d[2]) + (Number(d[4]) - Number(d[2])) * t;
          return q.matrixTransform(ctm);
        }
        var T = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
        for (var i = 0; i < withAssoc.length; i++) {
          for (var k = 0; k < T.length; k++) {
            var m = ptAt(withAssoc[i], T[k]);
            if (m && m.x > 12 && m.y > 12 && m.x < window.innerWidth - 12 && m.y < window.innerHeight - 12) {
              window.__relClick = { x: m.x, y: m.y, assoc: withAssoc[i].getAttribute('data-assoc'), inViewport: true };
              return JSON.stringify({ ok: true, x: Math.round(m.x), y: Math.round(m.y), assoc: withAssoc[i].getAttribute('data-assoc') });
            }
          }
        }
        return JSON.stringify({ ok: false, text: '命中层里没有视口内的可点线（热区 ' + hits.length + ' 条）' });
      })()`);
      if (!hitPt.ok) return { ok: false, text: '找不到可点位置：' + (hitPt.text || JSON.stringify(hitPt)) };
      // ★ 用**真鼠标事件**点它（不是 DOM 派发！）—— 这是本功能最早的假绿根因：
      //   视觉线在节点层**下面**，真事件永远落在节点层上；而 `dispatchEvent` 直接派到 path 上会
      //   **绕过命中测试** ⇒ 断言绿、功能坏 ✗。sendInputEvent 走 Chromium 的真实命中测试 ✓
      ctx.win.webContents.sendInputEvent({ type: 'mouseMove', x: hitPt.x, y: hitPt.y });
      ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: hitPt.x, y: hitPt.y, button: 'left', clickCount: 1 });
      ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: hitPt.x, y: hitPt.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));
      const chk = await waitFor(ctx, `(function () {
        var c = window.__relClick;
        var st = window.MM.getFloatDetailState ? window.MM.getFloatDetailState() : null;
        if (!st) return JSON.stringify({ ok: false, text: '拿不到详情框状态（MM.getFloatDetailState）' });
        if (st.kind !== 'assoc') return JSON.stringify({ ok: false, text: '最后打开的框不是关联页：kind=' + st.kind });
        var lockOk = st.lock === 'screen';
        var idOk = st.assocId === c.assoc;
        var dx = Math.abs(st.left - c.x), dy = Math.abs(st.top - c.y);
        // 位置判据（无魔数版）：**框的矩形要覆盖住点击点**（±40 容差），纵向用框的**真实高**
        //（框可比视口还高 ⇒ "左上角落在点击点"与"被夹回视口"都等价于覆盖住那个点 ✓）
        var covers = c.x >= st.left - 40 && c.x <= st.left + st.width + 40
          && c.y >= st.top - 40 && c.y <= st.top + st.height + 40;
        var inVp = (c.x > 0 && c.y > 0 && c.x < window.innerWidth && c.y < window.innerHeight);
        var posOk = inVp
          ? (covers && dx < 120)
          : (st.left >= 0 && st.top >= 0 && st.left < window.innerWidth && st.top < window.innerHeight);
        return JSON.stringify({
          ok: lockOk && idOk && posOk,
          text: '打开 assocId=' + st.assocId + '（点的线带 ' + c.assoc + '）大锁=' + lockOk
            + ' 框位置=(' + Math.round(st.left) + ',' + Math.round(st.top) + ') 点击点=('
            + Math.round(c.x) + ',' + Math.round(c.y) + ') 偏差=(' + Math.round(dx) + ',' + Math.round(dy) + ')'
            + ' 盖住点击点=' + covers + ' 点在视口内=' + inVp
            + ' 框尺寸=' + st.width + 'x' + st.height
        });
      })()`);
      const o = JSON.parse(chk);
      return { ok: !!o.ok, text: '真鼠标点击 (' + hitPt.x + ',' + hitPt.y + ') 落在带 assoc=' + hitPt.assoc + ' 的线上 ｜ ' + o.text };
    }
  },
  {
    name: '关联节点：Esc 退出 ⇒ 高亮/虚化/线全清（不留残影），视图与框复位（不给后续断言留脏状态）',
    run: async (ctx) => {
      await ctx.exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
      const res = await execJson(ctx, `(function () {
        var hits = document.querySelectorAll('jmnode.mm-rel-hit').length;
        var dims = document.querySelectorAll('jmnode.mm-rel-dim').length;
        var svg = document.querySelector('#mm-rel-layer');
        var lines = svg ? svg.querySelectorAll('path.mm-rel-line').length : -1;
        var cnt = svg ? Number(svg.dataset.count) : -1;
        return JSON.stringify({ ok: hits === 0 && dims === 0 && lines === 0 && cnt === 0,
          text: '高亮=' + hits + ' 虚化=' + dims + ' 线=' + lines + ' data-count=' + cnt });
      })()`);
      // 收尾：关掉本域打开的框 + 复位视图（本域改了 s/x/y，别留给后面的域）
      await ctx.exec(`(function () {
        if (window.MMApp && window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
        if (window.MM && window.MM.resetView) window.MM.resetView();
        return 1;
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '⑦c 性能：连续重绘**不重复刷类**（拖动时的卡顿主因），且高亮不丢',
    run: async (ctx) => {
      await ctx.exec(`window.MM.showRelated(${JSON.stringify(PICK[0])}); 1`);
      const waited = await waitFor(ctx, `(function () {
        var svg = document.querySelector('#mm-rel-layer');
        return JSON.stringify({ ok: !!svg && Number(svg.dataset.count) > 0, text: '线=' + (svg ? svg.dataset.count : 无) });
      })()`);
      const res = await execJson(ctx, `(async function () {
        // 数"写了多少次高亮类"（DOMTokenList.toggle 是唯一的写入口 ✓）—— 与机器快慢无关的确定性判据 ✓
        var orig = DOMTokenList.prototype.toggle, writes = 0;
        DOMTokenList.prototype.toggle = function (t, f) {
          if (t === 'mm-rel-hit' || t === 'mm-rel-dim') writes++;
          return orig.apply(this, arguments);
        };
        function raf() { return new Promise(function (r) { requestAnimationFrame(function () { r(1); }); }); }
        var nodes = document.querySelectorAll('jmnode[nodeid]').length;
        MM.scheduleRelatedRedraw(); await raf();          // 第 1 帧：把账建起来（这一帧该写全量 ✓）
        var firstFrame = writes;
        for (var i = 0; i < 12; i++) { MM.scheduleRelatedRedraw(); await raf(); }   // 之后 12 帧
        var total = writes;
        DOMTokenList.prototype.toggle = orig;
        var hit = document.querySelectorAll('jmnode.mm-rel-hit').length;
        var dim = document.querySelectorAll('jmnode.mm-rel-dim').length;
        return JSON.stringify({
          firstFrame: firstFrame, total: total, nodes: nodes, hit: hit, dim: dim,
          ok: firstFrame <= nodes * 2 && total <= nodes * 2 + 4 && hit > 0 && (hit + dim) >= nodes - 2,
          text: '节点=' + nodes + ' 第 1 帧写=' + firstFrame + ' 共 13 帧写=' + total
            + '（上限 ' + (nodes * 2 + 4) + '）｜ 高亮=' + hit + ' 虚化=' + dim + '（合计应≈节点数 ✓ 高亮没丢）'
        });
      })()`);
      return { ok: !!res.ok, text: '线=' + JSON.parse(waited).text + ' ｜ ' + res.text };
    }
  }
];
