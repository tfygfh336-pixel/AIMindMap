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
/** 入口前置的读数（本域要"界面里开着的就是 comnet"才成立 ⇒ 见第 1 条断言里的自建前置） */
let ENTRY = '';
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
      /* 入口前置（**自建前置**，不是放宽判据）：本域假定"界面里开着的那棵树就是 comnet" ——
       * 关联笔记是用 CLI 建在 comnet 上的，而节点是从**界面当前的树**里挑的（见文件头 ⚠️）。
       * 全量运行里到这一步开着的确实是 comnet（`01-*` 预热打开的），但**过滤运行**
       * （`SMOKE_ONLY` / `verify --changed` / `verify --for <改动面>`）里上一条断言可能留下别的项目
       * ⇒ 实测：`verify --for renderer` 在域 20 之后进本域时树里只有 2 个节点、⑦c 读到"线=0 高亮=0"，
       * 而**单跑本域**是 889 个节点全绿 ⇒ 定性是**顺序/状态依赖**，处置就是这一条前置 ✓。
       * 已经在 comnet 上 ⇒ 直接返回 `already`，**全量链的行为一个字节都不动** ✓。
       * 切项目会撞"界面脏"那道确认框，而 headless 里没人应答会**挂死**（域 43 记过同款坑 ✗）
       * ⇒ 按产品自己的打桩口 `MM.setConfirmStub` 回答"放弃改动"，用完复位。 */
      ENTRY = await ctx.exec(`(async function () {
        try {
          var st = window.MMApp.getState();
          if (st && st.project && st.project.name === ${JSON.stringify(PROJ)}) return 'already';
          var MM = window.MM;
          if (MM && MM.setConfirmStub) MM.setConfirmStub(function () { return true; });
          var r = await Promise.race([
            Promise.resolve(window.MMApp.openProject(${JSON.stringify(PROJ)})).then(function () { return 'opened'; },
              function (e) { return 'rejected:' + ((e && e.message) || e); }),
            new Promise(function (res) { setTimeout(function () { res('timeout'); }, 12000); })
          ]);
          if (MM && MM.setConfirmStub) MM.setConfirmStub(null);
          return r;
        } catch (e) { return 'err:' + ((e && e.message) || e); }
      })()`);
      await new Promise((r) => setTimeout(r, 350));
      if (ENTRY !== 'already' && ENTRY !== 'opened') {
        return { ok: false, text: '入口前置失败（取不到 comnet 这棵树 ⇒ 本域后面的判据都不成立）：' + ENTRY };
      }
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
        // 只认**可见那个**框（域与域之间会留下隐藏的旧框 —— 34-域记过同款坑 ✓）
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var boxEl0 = null;
        for (var bi = 0; bi < boxes.length; bi++) {
          var q0 = boxes[bi].getBoundingClientRect();
          if (boxes[bi].style.display !== 'none' && q0.width > 40 && q0.height > 40) { boxEl0 = boxes[bi]; break; }
        }
        var b = (boxEl0 && MM.fdRelShowBtnOf) ? MM.fdRelShowBtnOf(boxEl0) : document.querySelector('.rel-show-btn');
        if (!b) return JSON.stringify({ ok: false, text: '还没有 .rel-show-btn' });
        // ★ 用户 2026-10-08「关联视图去哪里了？」⇒ 只验存在不够 ✗：必须真的**看得见** ✓
        //   （有面积 + 落在面板内 —— 同型的坑刚在 ① 上踩过：类名在、样式不生效 ✓）
        var r = b.getBoundingClientRect();
        var p = (window.MM.fdPanel ? window.MM.fdPanel() : null);
        var pr = p ? p.getBoundingClientRect() : null;
        var area = r.width > 8 && r.height > 8;
        var inside = !!pr && r.left >= pr.left - 2 && r.right <= pr.right + 2 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2;
        // ★ 命中测试：rect 对 overflow 裁切是**盲的**（本工程实测：被裁掉的圆钮 rect 看着"在框外、在面板内"，
        //   而 elementFromPoint 点不到、真帧 0 像素）⇒ 可见性必须叠加这一条 ✓
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var at = document.elementFromPoint(cx, cy);
        var hitSelf = !!(at && at.closest && at.closest('.rel-show-btn') === b);
        // ★ 圆形判定（用户 2026-10-08 第二批："变成一个圆形按钮浮在节点详情左边" ✓）
        var cs = window.getComputedStyle(b);
        // ★ 不遮挡节点详情框（用户 2026-10-08 第二批 ✗）：圆钮必须在框的**横向之外** ✓
        //   ⚠️ 圆钮已搬进**卫星浮层**（与框同级）⇒ \`b.closest('.float-detail')\` 永远为 null ✗，
        //   必须用「框 ↔ 圆钮」的映射反查它**自己**那个框（MM.fdBoxOfSatellite ✓）
        var bx = MM.fdBoxOfSatellite ? MM.fdBoxOfSatellite(b) : null;
        var bq = bx ? bx.getBoundingClientRect() : null;
        var outsideBox = !!bq && (r.right <= bq.left + 1 || r.left >= bq.right - 1);
        var radius = cs.borderTopLeftRadius || '';
        var round = (radius === '50%' || parseFloat(radius) >= Math.min(r.width, r.height) / 2 - 1);
        return JSON.stringify({ ok: !!area && !!inside && hitSelf && round && outsideBox,
          text: '按钮=' + (b.textContent || '').trim() + ' 面积=' + Math.round(r.width) + 'x' + Math.round(r.height)
            + ' 在面板内=' + inside + ' 命中圆钮=' + hitSelf + ' 圆形=' + round + ' 圆角=' + radius
            + ' 在框外(不遮挡)=' + outsideBox + ' 档=' + (b.getAttribute('data-place') || '') });
      })()`);
      let o = JSON.parse(btn);
      if (!o.ok) return { ok: false, text: o.text };
      // 点它
      await ctx.exec(`(function () { var b = document.querySelector('.rel-show-btn'); if (b) b.click(); return 1; })()`);
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
      return { ok: !!o.ok && !!setChk.ok, text: '入口前置=' + ENTRY + ' ｜ ' + o.text + ' ｜ ' + setChk.text };
    }
  },
  {
    name: '关联节点：关系线随导图变换（缩放/平移后，线的端点**落在两端节点矩形边界上**，到矩形 ≤ 6px 且在框内）',
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
          /* 端点该落在**节点矩形的边界上**（2026-10-30 收口批的口径订正 —— 原判据把旧行为写死了）：
           *   关系线端点已统一成内核的端点规则（`MMDiagram.relationsOf` = `route.autoPorts` +
           *   `route.portPoint`，与图里每条直连边同一个函数）⇒ 落在节点框**边界**上，**不是**中心。
           * 原来判"端点 ≈ 节点中心（≤6px）"：真实项目 24 对实测，改前 48/48 个端点离边界 32–56px，
           * 改后 0/48（到矩形距离 0.00px）⇒ 那条判据钉的是旧的错误行为，不是"端点该在哪"。
           * ⇒ 现在判两件：① 端点到**节点矩形**的距离 ≤ 6px；② 端点落在该矩形内/边界上（±1px）。
           * 判别力**没变松**：线没挂进 `fdViewEls()` 时端点整体错位 `ox*(1-s)`、张冠李戴时端点在别的节点旁
           * ⇒ ①和②都爆炸（本域收尾注释里给了"把 s 换成 1 必须红"的白盒自证）。 */
          function toRectDist(p, r) {
            var dx = Math.max(r.left - p.x, p.x - r.right, 0);
            var dy = Math.max(r.top - p.y, p.y - r.bottom, 0);
            return Math.hypot(dx, dy);
          }
          function inRect(p, r) {
            return p.x >= r.left - 1 && p.x <= r.right + 1 && p.y >= r.top - 1 && p.y <= r.bottom + 1;
          }
          var e1 = toRectDist(s1, r1), e2 = toRectDist(s2, r2);
          var o1 = inRect(s1, r1), o2 = inRect(s2, r2);
          maxErr = Math.max(maxErr, e1, e2);
          if (e1 > 6 || e2 > 6 || !o1 || !o2) {
            bad.push('第' + i + '条：到节点矩形距离 ' + Math.max(e1, e2).toFixed(1) + 'px'
              + ((!o1 || !o2) ? '，且端点落在节点矩形**外**' : ''));
          }
        }
        return JSON.stringify({ ok: bad.length === 0, text: '线=' + lines.length + ' 最大"端点到节点矩形"误差='
          + maxErr.toFixed(1) + 'px'
          + (bad.length ? ' ✗ ' + bad.slice(0, 2).join('；') : '') });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '关联节点：点线 ⇒ 按**鼠标点击位置**打开那篇关联笔记（大锁钉住，不跟导图跑）',
    run: async (ctx) => {
      // 前置①：**把上一条断言留下的详情框收掉**。详情框浮在关系线之上，会挡掉真鼠标事件
      //   （真人同样点不穿它）—— 本断言判的是"点线 ⇒ 按点击位置开笔记"，
      //   不该被一个与线无关的框搅进来（实测：编辑条让视口上移后，采到的点正好压在框上，
      //   点击打到框里的关联条目 ⇒ 打开的是**另一篇**且没有大锁，看着像功能坏了）。
      await ctx.exec(`(function () {
        if (window.MMApp && window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
        return 1;
      })()`);
      // 前置②：**重新进入展示态**。上一条断言为了验"线跟变换"把视图改成了 s=0.8/平移，
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
        var T = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9, 0.05, 0.15, 0.25, 0.45, 0.55, 0.75, 0.95];
        var diag = [];
        var desc = function (el) {
          if (!el) return 'null';
          var chain = [], cur = el, n = 0;
          while (cur && n < 4 && cur.tagName !== 'BODY') {
            chain.push((cur.tagName || '?') + (cur.id ? '#' + cur.id : '') + (cur.getAttribute && cur.getAttribute('class') ? '.' + String(cur.getAttribute('class')).split(' ').slice(0, 2).join('.') : ''));
            cur = cur.parentElement; n++;
          }
          return chain.join(' < ');
        };
        for (var i = 0; i < withAssoc.length; i++) {
          for (var k = 0; k < T.length; k++) {
            var m = ptAt(withAssoc[i], T[k]);
            if (!m) continue;
            var inVp = m.x > 12 && m.y > 12 && m.x < window.innerWidth - 12 && m.y < window.innerHeight - 12;
            // ★ 只挑**真的在最上面**的点：视口内还不够 —— 详情框/编辑条压在线上时，
            //   真鼠标事件落到的是那个框（真人同样点不穿它）⇒ 必须用 elementFromPoint 判一次。
            var top = document.elementFromPoint(m.x, m.y);
            var onTop = top === withAssoc[i];
            if (diag.length < 3) diag.push('t=' + T[k] + ' (' + Math.round(m.x) + ',' + Math.round(m.y) + ') 视口内=' + inVp + ' 最上层=' + desc(top));
            if (!inVp || !onTop) continue;
            window.__relClick = { x: m.x, y: m.y, assoc: withAssoc[i].getAttribute('data-assoc'), inViewport: true };
            return JSON.stringify({ ok: true, x: Math.round(m.x), y: Math.round(m.y), assoc: withAssoc[i].getAttribute('data-assoc'), onTop: true });
          }
        }
        return JSON.stringify({ ok: false, text: '命中层里没有可点的线（热区 ' + hits.length + ' 条 / 带 assoc ' + withAssoc.length + ' 条）'
          + '；首几个采样点：' + diag.join(' ｜ ') });
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
      // 收尾：**退出关联视图**。本域最后一条又调了一次 showRelated（它自己要前置），不退的话
      // 高亮/虚化/**关联信息编辑条**会一直挂到后面的域去 —— 实测代价：编辑条占着面板顶部，
      // 域 33「从已选中节点拖到右缘」挑中的节点中心正好落在条上 ⇒ 真鼠标按下打到条上、拖拽根本没启动，
      // 状态栏停在选区提示上（红得莫名其妙 ✗，与 08 域那次是同一类"跨域状态泄漏"）。
      await ctx.exec(`(function () {
        if (window.MM && window.MM.clearRelated) window.MM.clearRelated();
        if (window.MMApp && window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
        return 1;
      })()`);
      return { ok: !!res.ok, text: '线=' + JSON.parse(waited).text + ' ｜ ' + res.text };
    }
  }
];
