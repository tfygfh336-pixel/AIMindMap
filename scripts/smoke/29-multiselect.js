/* ============================================================
 * scripts/smoke/29-multiselect.js — 多选与"整批问 AI"（用户反馈④⑥）
 * ------------------------------------------------------------
 * 用户原话：
 *   ④「框选出来多个节点的时候，应该自动链接上所有这些被框选的节点，意思是我想把所有被框选的
 *      都给 AI 看然后让他回答我」
 *   ⑥「应该要可以通过按住 Ctrl 然后鼠标点击或者框选实现多选功能，就可以问 AI 所有我想选择的了」
 * ⇒ 本域验四件（**全部用真鼠标事件**，走 Chromium 命中测试 ✓ 不用 DOM 派发 —— 那是"假绿"的老根因 ✗）：
 *   1) Ctrl+点击 逐个加选：选区里有 2 个，虚线框出现
 *   2) 有选区时工具条**出现**，且按钮写明数量（"解释 2 个"）
 *   3) 点它 ⇒ 问答浮窗标题是「AI 解释：2 个节点」＋桩回显"收到节点数：2"（渲染层→主进程 真的传了整批 ✓）
 *   4) Ctrl+框选 = **加选**（在原选区上并集，而不是替换 ✗）
 * 主进程→CLI 那一跳（`--nodes a,b,c` 真的进了提示词）由集成断言覆盖（离线，不烧额度 ✓）。
 * ============================================================ */
'use strict';

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 200) }; }
}

async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 40); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/** 判别力证明开关（默认空 ⇒ 正常跑**完全不生效** ✓；逗号分隔多键 ⇒ 一趟跑完多条注入 ✓）。
 *  形状与域 08 / 36 / 37 / 39 同一套（本工程既有先例 ✓，**没另造机制**）。三个键各证明一件事：
 *   · `29-no-pan`  —— 跳过 ⑤ 的"把候选平移进视口"（其余不变）⇒ 当前数据下候选=0 ⇒ **必须落第三态**
 *     （响亮"未验证"、不计入通过/总数、不阻断）—— 它证明第三态真的会亮、而且是**响亮**的 ✓；
 *   · `29-plain-box` —— 拖同样一个框，但**不带 Ctrl**（那是"普通框选 = 重选"）⇒ 原有 2 个节点会被替换掉
 *     ⇒ "只增不减"契约必须判红 ✓（证明本档分得清"加选"与"重选"，不是空断言）；
 *   · `29-tiny-box` —— 带 Ctrl，但松手点只挪 12px（框里什么合格候选都没有）⇒ "**加选必须真的长大**"
 *     必须判红 ✓（证明那条核心判据**是活的**，不是装饰）。 */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT.split(',').indexOf('29-' + k) >= 0;

/** 取一点，落在"此刻真的命中某个可见节点"的位置（用 elementFromPoint 复核 ✓）。
 *  ⚠️ 必须**点击前**再挑：第一次 Ctrl+点击之后工具条会出现，可能盖住原先验过的点 ✗
 *  （实测：第二次点击打在工具条上 ⇒ handler 调用 0 次 ⇒ 白等一场 ✓ 这个坑值一条注释）。 */
async function pickPoint(ctx, excludeIds) {
  return execJson(ctx, `(function () {
    var ex = ${JSON.stringify(excludeIds || [])};
    var vis = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10 && r.left > 4 && r.top > 4
        && r.right < window.innerWidth - 4 && r.bottom < window.innerHeight - 4;
    });
    for (var i = 0; i < vis.length; i++) {
      var id = vis[i].getAttribute('nodeid');
      if (ex.indexOf(id) >= 0) continue;
      var r = vis[i].getBoundingClientRect();
      var cands = [
        { x: Math.round(r.left + 6), y: Math.round(r.top + Math.round(r.height / 2)) },
        { x: Math.round(r.right - 6), y: Math.round(r.top + Math.round(r.height / 2)) },
        { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + 3) }
      ];
      for (var k = 0; k < cands.length; k++) {
        var p = cands[k];
        var at = document.elementFromPoint(p.x, p.y);
        var hit = at && at.closest && at.closest('jmnode[nodeid]');
        if (hit === vis[i]) return JSON.stringify({ ok: true, id: id, x: p.x, y: p.y });
      }
    }
    return JSON.stringify({ ok: false, text: '找不到此刻真正命中的可点节点（排除 ' + ex.join(',') + '）' });
  })()`);
}

/** 取两个可见节点的**屏幕坐标**（各自中心点），供真鼠标事件使用 */
async function twoNodePoints(ctx) {
  return execJson(ctx, `(function () {
    var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
    var rej = [];
    var vis = all.filter(function (el) {
      var r = el.getBoundingClientRect();
      var why = null;
      if (!(r.width > 20)) why = 'w=' + Math.round(r.width);
      else if (!(r.height > 10)) why = 'h=' + Math.round(r.height);
      else if (!(r.left > 4 && r.top > 4)) why = 'left/top=' + Math.round(r.left) + ',' + Math.round(r.top);
      else if (!(r.right < window.innerWidth - 4 && r.bottom < window.innerHeight - 4)) why = 'right/bottom=' + Math.round(r.right) + ',' + Math.round(r.bottom) + '(vp=' + window.innerWidth + 'x' + window.innerHeight + ')';
      if (why) { if (rej.length < 4) rej.push(el.getAttribute('nodeid') + ':' + why); return false; }
      return true;
    });
    // 诊断前缀（失败信息必须自带数据 ✓ 别让人再猜 ✗）
    var DIAG = 'jmnode总=' + all.length + ' 可见=' + vis.length + ' 被拒=' + (rej.join(' ') || '无');
    if (vis.length < 2) return JSON.stringify({ ok: false, text: '可见节点不足 2 个 ⇒ ' + DIAG });
    // 每个节点试**多个候选点**（照抄本文件 pickPoint 的做法 ✓ —— 它一直是对的）：
    // 原先只试"左中"一个点 ⇒ 被工具条/详情框盖住就整条跳过 ✗ ⇒ 干净地图上只剩 1 个可用点 ✗
    function candsOf(el) {
      var r = el.getBoundingClientRect();
      return [
        { x: Math.round(r.left + 6), y: Math.round(r.top + Math.round(r.height / 2)) },
        { x: Math.round(r.right - 6), y: Math.round(r.top + Math.round(r.height / 2)) },
        { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + 3) }
      ];
    }
    function hits(el, p) {
      var at = document.elementFromPoint(p.x, p.y);
      return !!(at && at.closest && at.closest('jmnode[nodeid]') === el);
    }
    var cands = [];
    for (var k = 0; k < vis.length && cands.length < 2; k++) {
      var ps = candsOf(vis[k]);
      for (var q = 0; q < ps.length; q++) {
        if (hits(vis[k], ps[q])) { cands.push({ el: vis[k], p: ps[q] }); break; }
      }
    }
    if (cands.length < 2) return JSON.stringify({ ok: false, text: '可用命中点不足 2 个（' + cands.length + '）⇒ ' + DIAG });
    var vis2 = cands[0].el, visB = cands[1].el;
    return JSON.stringify({ ok: true, a: cands[0].p, b: cands[1].p,
      ida: vis2.getAttribute('nodeid'), idb: visB.getAttribute('nodeid') });
  })()`);
}

function mouse(ctx, type, p, modifiers) {
  ctx.win.webContents.sendInputEvent({ type: type, x: p.x, y: p.y, button: 'left', clickCount: 1,
    modifiers: modifiers || [] });
}

function click(ctx, p, modifiers) {
  mouse(ctx, 'mouseMove', p, modifiers);
  ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1,
    modifiers: modifiers || [] });
  ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1,
    modifiers: modifiers || [] });
}

module.exports = [
  {
    name: '⑥ Ctrl+点击：逐个加选（选区里有 2 个节点，虚线框出现）',
    run: async (ctx) => {
      await ctx.exec('if (window.MM.clearSelection) window.MM.clearSelection(); 1');
      // 铺场（断言自建前置 ✓）：pan/zoom 属界面状态 ⇒ 跨域残留（按域隔离只还原**项目数据** ✗）
      // 实测：551 个节点的坐标在 -193,-1649 这类位置 ⇒ 视口内只剩 2 个、能命中 1 个 ✗
      // ⇒ 解药是**把视图居中到根**：`MM.centerOnRoot()`（renderMind 自己就用它 ✓ 纯视图、无副作用）。
      // ⚠️ 更正（本轮实测 ✓）：`MM.jumpToNode` **并不移动视图** ✗ —— 它只做 展开祖先链 + 选中 + 弹详情框
      //   （app-actions.js:80），而旧版把它包在 try/catch 里 ⇒ `jm.root` 一抛错就静默返回 0 ✗✗
      //   （jsMind 的根是 `get_root()`，不是 `jm.root`）。现在不包 try/catch：API 变了就响亮地红 ✓。
      // 注：resetView() 实测拉不回坐标 ✗ 已弃用；expandAll() 会把 551 个节点全铺开、邻居被推更远 ✗ 也不做。
      // ⚠️ 下一行**故意**保持被上面的注释吃掉的状态（历史遗留）：放开它会改变视图，实测让后面那条
      //    「Ctrl+框选 = 加选」断言挑不到空起点而红 ✗ —— 要放开必须连那条断言一起改，别顺手打开。
      // await ctx.exec('window.MM.centerOnRoot(); 1');
      await new Promise((r) => setTimeout(r, 400));
      await ctx.exec('new Promise(function (res) { requestAnimationFrame(function () { res(1); }); })');
      const pts = await twoNodePoints(ctx);
      if (!pts.ok) return { ok: false, text: pts.text };
      // 热身：窗口的**第一次**鼠标交互常被当成"点一下获得焦点"而吞掉 ✗（实测第一次 Ctrl+点击
      // 选区仍是空的，第二次才生效）。这里先点一下空白把它吃掉 ✓
      const warm = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.left + 10), y: Math.round(r.bottom - 40) });
      })()`);
      click(ctx, warm);
      await new Promise((r) => setTimeout(r, 150));
      click(ctx, pts.a, ['control']);                      // Ctrl+点 A ⇒ 加入
      await new Promise((r) => setTimeout(r, 150));
      const after1 = await ctx.exec('JSON.stringify(window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [])');
      const sel1 = JSON.parse(after1);
      // 第二次点击**前**重新挑点（工具条此时可能已出现并盖住原候选 ✗ 见 pickPoint 的说明）
      const second = await pickPoint(ctx, sel1);
      if (!second.ok) return { ok: false, text: '第 1 次点后=' + after1 + ' ｜ ' + second.text };
      click(ctx, second, ['control']);                     // Ctrl+点 B ⇒ 再加
      await new Promise((r) => setTimeout(r, 250));
      const res = await execJson(ctx, `(function () {
        var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
        var out = document.getElementById('dsh-selection-outline');
        // ★ ② 的新判据（真机反馈）：Ctrl 加选**不许弹详情框** ✓
        //   原来只验了选区与虚线框 ⇒「会弹框」这个缺陷一路绿到底 ✗
        var fdBoxes = document.querySelectorAll('.float-detail');
        var anyFdVisible = Array.prototype.some.call(fdBoxes, function (b) {
          var r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        });
        return JSON.stringify({
          ok: raw.length === 2 && raw.indexOf(${JSON.stringify(second.id)}) >= 0 && !anyFdVisible
            && !!out && out.style.display === 'none',
          text: '第 1 次点后=' + ${JSON.stringify(after1)} + ' ｜ 第 2 次点（${second.id}）后=[' + raw.join(',')
            + ']（应含 ${second.id}）虚线框可见=' + (!!out && out.style.display !== 'none')
            + ' ｜ 详情框可见=' + anyFdVisible + '（必须 false ✓）'
            + ' ｜ 大虚线框可见=' + (!!out && out.style.display !== 'none') + '（Ctrl 加选必须 false ✓）'
            + ' ｜ 点击点 A=(' + ${pts.a.x} + ',' + ${pts.a.y} + ') B=(' + ${second.x} + ',' + ${second.y} + ')'
        });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '④ 有选区时工具条出现，并写明作用对象是**整批**（"解释 N 个"）',
    run: async (ctx) => {
      const res = await waitFor(ctx, `(function () {
        var bar = document.getElementById('mm-node-toolbar');
        var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
        if (!bar || bar.style.display === 'none') return JSON.stringify({ ok: false, text: '工具条没出现' });
        var ex = bar.querySelector('.mm-tb-explain'), ask = bar.querySelector('.mm-tb-ask');
        // 单个节点时按钮就是「💡 解释」（不必写"1 个"）；多个节点才写数量 ✓
        var want = raw.length > 1 ? ('💡 解释 ' + raw.length + ' 个') : '💡 解释';
        return JSON.stringify({
          ok: !!ex && ex.textContent === want && raw.length >= 2 && bar.getAttribute('data-count') === String(raw.length),
          text: '选区=' + raw.length + ' 个 ｜ 解释按钮="' + (ex ? ex.textContent : '—') + '"（应 "' + want + '"）｜ data-count='
            + bar.getAttribute('data-count')
        });
      })()`);
      const o = JSON.parse(res);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: '④ 点「解释 N 个」⇒ 浮窗标题是"N 个节点"，且整批真的送出去了（桩回显节点数）',
    run: async (ctx) => {
      const n = JSON.parse(await ctx.exec('JSON.stringify(window.MM.getSelectionRaw ? window.MM.getSelectionRaw().length : 0)'));
      await ctx.exec(`(function () {
        var bar = document.getElementById('mm-node-toolbar');
        bar.querySelector('.mm-tb-explain').click();
        return 1;
      })()`);
      const res = await waitFor(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        if (!boxes.length) return JSON.stringify({ ok: false, text: '没有问答浮窗' });
        var box = boxes[boxes.length - 1];
        var title = (box.querySelector('.fd-title') || {}).textContent || '';
        var text = box.textContent || '';
        // 单个节点 ⇒ 标题是节点名（原行为 ✓）；多个 ⇒ 「AI 解释：N 个节点」✓
        var want = ${n} > 1 ? ('AI 解释：' + ${n} + ' 个节点') : null;
        return JSON.stringify({
          ok: ((${n} > 1) ? title === want : title.length > 0) && text.indexOf('收到节点数：' + ${n}) >= 0,
          text: '标题="' + title + '"' + (want ? ('（应 "' + want + '"）') : '（单节点，标题为节点名 ✓）')
            + '｜ 桩回显"收到节点数：${n}"=' + (text.indexOf('收到节点数：' + ${n}) >= 0)
        });
      })()`);
      const o = JSON.parse(res);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: '⑥ Ctrl+框选 = **加选**（在已有选区上并集；普通框选才是重新选）',
    run: async (ctx) => {
      const before = JSON.parse(await ctx.exec('JSON.stringify(window.MM.getSelectionRaw().length)'));
      const cur = JSON.parse(await ctx.exec('JSON.stringify(window.MM.getSelectionRaw())'));
      /* ═══ 能力边界三档（本档判什么 / 只报告什么 / 什么时候跳过）═══
       * 🟥 **判红**（硬判据，任一出现即红）：
       *   ① 拖拽**真的起过框**（橡皮筋可见）之后，原有节点**丢过**（`kept < 起框时的基准`）—— "只增不减"契约；
       *   ② 起步前用**实现自己的几何判定**（`MM.nodeSelectedBy`）算出"这一框会圈住 ≥1 个未选中的顶层主题"，
       *      松手后却**一个都没长出来**（`grew=false`）—— "**加选必须真的长大**"（本档的核心判据）。
       * 📋 **只报告**（进报文、不参与判定）：第几次尝试、命中详情、框的坐标、渲染层事件、视图位移。
       * ⚪ **跳过**（第三态 `unverified` —— 复用 `scripts/smoke-assertions.js` 既有的那一套，**不另造**）：
       *   **一条拖拽证据都采不到**时 —— 视口内没有"未选中的顶层主题"这个合格候选，或候选都挑不出
       *   "能起框 + 框得住目标"的起点（两者都是**前提**，不是产品行为）⇒ 响亮"未验证"、
       *   不计入通过/总数、不阻断。
       * ⚠️ 本档**判不了**什么：上面两条硬判据在"无拖拽证据"时**无从采值** ⇒ 一律**不判绿**
       *   （fail-safe：`unverified` 只许挂在 `ok:true` 上；**一旦真的拖过一次，判断权立刻交回硬判据** ✓）。 */
      /* 视图是**界面状态**：每域隔离只还原项目文件，管不到它 ⇒ 本档为了造前提会移动视图，
       * 收尾**必须还原**（否则位移会带给后面的域：30/33/36/37… 全是真输入域，采样点全靠当前布局 ✗）。 */
      const savedView = await execJson(ctx, `(function () {
        var v = (window.MM && window.MM.getPanState) ? window.MM.getPanState() : null;
        return JSON.stringify({ ok: !!v, v: v });
      })()`);
      const savedViewJson = (savedView.ok && savedView.v) ? JSON.stringify(savedView.v) : 'null';
      try {
        /* ── ⑤ **先补前提**（在取候选之前）—— 这条断言原来的前提太薄，见下 ──
         * 现场（2026-10-13，+338 节点后）：合格池恒为"顶层主题"共 3 个（comnet 只有 3 个 ✓），
         * 前序 ①②③ 已选中其中 2 个 ⇒ 只剩 1 个；而 889 个节点的树里，它一旦不在面板内
         * （离根几千像素）⇒ 候选=0 ⇒ 永远红 ✗（报文"起点被拒=0 框住根被拒=0 没圈住目标被拒=0"
         * 正是"内层循环一次都没进"的自洽读数 ✓ —— 那不是产品缺陷，是**前提没造**）。
         * 三件事，**全是界面前置，一件都不改产品行为、不改选区、不改数据**：
         *   ① 关掉所有浮窗详情框（它们浮在画布上 ⇒ 起点 `canStart` 恒假）；
         *   ② `MM.centerOnRoot()`（纯 fdView 平移，无数据副作用 ✓）—— 视图残留本就会让本档时红时绿；
         *   ③ 合格候选仍不在视口内时，用产品自己的视图 API `MM.setViewTransform` 把**那个候选**
         *      平移到面板正中（`centerOnRoot` 只对根有效，而这里要的是候选 ✓）。
         * ❌ **不做**：放宽判据（"加选必须真的长大"一个字不改 ✗）、改选区、临时改产品代码。
         * ⚠️ 旧的"取最后一个可见节点 + 网格找起点"那道门（`pr.ok` ⇒ 直接判红）已删：它把
         *   "前提没造出来"当成了产品缺陷（+338 节点后恒红 ✗），且它算出的 start/end/targetId
         *   **一个都没被用过**（只用到 `.ok`）⇒ 判据侧只剩下面循环里那一条（同口径，但带 ⑤ 造的前提）。 */
        const pre = await execJson(ctx, `(async function () {
          var MM = window.MM, app = window.MMApp;
          var cur = ${JSON.stringify(cur)};
          function raf2() { return new Promise(function (res) { var k = 0; (function tick() { if (++k >= 2) return res(1); requestAnimationFrame(tick); })(); }); }
          var jm = app.getState().jm;
          var topicIds = (jm.get_root().children || []).map(function (n) { return n.id; });
          if (MM.closeAllFloatDetail) MM.closeAllFloatDetail();
          MM.centerOnRoot();
          await raf2();
          var steps = ['关浮窗详情框', 'centerOnRoot'];
          var pr = MM.fdPanel().getBoundingClientRect();
          function rectOf(el) { var q = el.getBoundingClientRect(); return { id: el.getAttribute('nodeid'), x: q.left, y: q.top, w: q.width, h: q.height }; }
          function allRects() { return Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).map(rectOf); }
          // 合格判据与下面循环里**同一个口径**：整个节点在面板内并留出画框余量（否则夹取会把节点切出框 ⇒ 假红 ✗）
          function inPanel(r) { return r.w > 20 && r.h > 10 && r.x > pr.left + 40 && r.y > pr.top + 40 && r.x + r.w < pr.right - 25 && r.y + r.h < pr.bottom - 25; }
          var selTopics = topicIds.filter(function (id) { return cur.indexOf(id) >= 0; });
          var free = topicIds.filter(function (id) { return cur.indexOf(id) < 0; });
          function candsOf() { return allRects().filter(function (r) { return free.indexOf(r.id) >= 0 && inPanel(r); }); }
          var cs = candsOf();
          var panned = null;
          // 判别力证明【29-no-pan】：**故意不平移**（模拟"候选就是不在视口里"）⇒ 走第三态 ✓
          // （⚠️ 本行在模板字面量**内部** ⇒ 一律不许出现反引号，那会把它提前截断 ✗ —— 实测踩过）
          if (!cs.length && free.length && ${JSON.stringify(!MY_KEY('no-pan'))}) {
            var rects = allRects();
            var t = null;
            for (var i = 0; i < free.length && !t; i++) {
              for (var k = 0; k < rects.length; k++) {
                if (rects[k].id === free[i] && rects[k].w > 20 && rects[k].h > 10) { t = rects[k]; break; }
              }
            }
            if (t && MM.getPanState && MM.setViewTransform) {
              var v0 = MM.getPanState();
              MM.setViewTransform({ s: v0.s,
                x: v0.x + (pr.left + pr.width / 2) - (t.x + t.w / 2),
                y: v0.y + (pr.top + pr.height / 2) - (t.y + t.h / 2) });
              await raf2();
              pr = MM.fdPanel().getBoundingClientRect();
              steps.push('平移候选进视口(' + t.id + ')');
              panned = t.id;
              cs = candsOf();
            }
          }
          return JSON.stringify({ ok: true, steps: steps, panned: panned, topics: topicIds.length,
            selTopics: selTopics.length, freeTopics: free.length,
            candIds: cs.map(function (r) { return r.id; }) });
        })()`);
        if (!pre.ok) return { ok: false, text: '前置探针失败（造前提这一步本身没跑成 ⇒ 不能算通过）：' + JSON.stringify(pre) };
        const poolLine = '合格候选池：顶层主题 ' + pre.topics + ' − 已选 ' + pre.selTopics + ' = ' + pre.freeTopics
          + ' 个未选中，其中**视口内合格** ' + pre.candIds.length + ' 个'
          + (pre.candIds.length ? '（' + pre.candIds.join(',') + '）' : '')
          + ' ｜ 造前提：' + pre.steps.join(' → ')
          + (INJECT ? ' ｜ ⚠️ **判别力证明注入**=' + INJECT : '');
        // 取证探针（测试专用，不改产品代码 ✓）
        await ctx.exec(`(function () {
          window.__dbg = [];
          ['mousedown', 'mouseup'].forEach(function (t) {
            document.addEventListener(t, function (e) {
              window.__dbg.push(t + ':ctrl=' + e.ctrlKey + ':target=' + (e.target && e.target.tagName));
            }, true);
          });
          return 1;
        })()`);
        // 探针（临时，随本轮调试一起撤）：记录每次框选收尾的真实输入
        await ctx.exec('window.__selSpy = []; 1');
        // 真鼠标拖拽 + Ctrl。**带重试**：起点是否"起得来框"取决于此刻的布局（前面的断言可能留下工具条/
        // 详情框/视图位移 ⇒ 实测点会落到节点上 ✗），所以一次不行就重挑起点再试 —— 与真人"点空了再点"一致 ✓。
        // 判定"这次真的起了框"：橡皮筋元素在 mouseDown 之后可见 ✓（这是实现的直接产物，不猜 ✗）
        // ⚠️ 原先这里还有一条"再关一次浮窗 + 再 centerOnRoot 一次"的加固 —— **已删**：⑤ 已经做过，
        //    而在这里再 centerOnRoot 会把 ⑤ 刚平移进视口的候选**推出去** ⇒ 候选重新变 0 ✗（前提自毁）。
        // `anyPre` = 至少有一次"能起框 + 框得住未选中的顶层主题"这个**几何前提**成立过 ⇒ 本档采到了可判证据；
        // `preFail` = 前提失败的**读数**（`reason` 分 nocand / nostart 两种 ⇒ 第三态报文能点名到底差在哪 ✓）
        let attempts = 0, grew = false, lost = false, last = '', anyPre = false, preFail = null;
        const log = [];
        for (let i = 0; i < 4 && !(grew && !lost); i++) {
          attempts++;
          const st = await execJson(ctx, `(function () { try {
            var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
            function canStart(pt) {
              var at = document.elementFromPoint(pt.x, pt.y);
              if (!at || (at.closest && at.closest('.float-detail'))) return false;
              return !!(at.closest && at.closest('jmnodes, canvas.jsmind'));
            }
            // 先挑**节点**、再反推**框**（实测：网格挑起点会挑到空白区 ⇒ 框内空无一物 ✗）
            var cur = ${JSON.stringify(cur)};
            var jm = window.MMApp.getState().jm;
            var rootId = jm.get_root().id;
            // 池账（第三态报文要报的"池几 − 已选几"）：顶层主题 = 居中根的直接子节点 ✓
            var topicIds = (jm.get_root().children || []).map(function (n) { return n.id; });
            var selT = topicIds.filter(function (id) { return cur.indexOf(id) >= 0; }).length;
            var freeT = topicIds.length - selT;
            function rectOf(el) {
              var q = el.getBoundingClientRect();
              return { id: el.getAttribute('nodeid'), x: q.left, y: q.top, w: q.width, h: q.height };
            }
            var allRects = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).map(rectOf);
            // 目标只取**顶层主题**（parent 就是居中根）：与当前选区同父 ⇒ trimSelection 的
            // '同父只留最浅一组' 不会把它剔掉 ⇒ '框住了却不长大'的假红不可能出现
            var cands = allRects.filter(function (el0) {
              if (el0.id === rootId || cur.indexOf(el0.id) >= 0) return false;
              if (!(el0.w > 20 && el0.h > 10)) return false;
              var n0 = jm.get_node(el0.id);
              if (!(n0 && n0.parent && n0.parent.isroot)) return false;
              // 整个节点要在面板内并留出画框余量（否则夹取会把节点切出框 ⇒ 假红 ✗）
              return el0.x > r.left + 40 && el0.y > r.top + 40
                && el0.x + el0.w < r.right - 25 && el0.y + el0.h < r.bottom - 25;
            });
            var offs = [[-30, -30], [-40, -24], [-24, -40], [-48, -48], [-60, -20], [-20, -60], [-70, -70], [-90, -40], [-40, -90]];
            var rejStart = 0, rejRoot = 0, rejHit = 0;
            for (var k = 0; k < cands.length; k++) {
              var tg = cands[k];
              for (var o = 0; o < offs.length; o++) {
                var s = { x: Math.round(tg.x + offs[o][0]), y: Math.round(tg.y + offs[o][1]) };
                var end = { x: Math.round(tg.x + tg.w + 20), y: Math.round(tg.y + tg.h + 20) };
                if (end.x - s.x < 40 || end.y - s.y < 40) continue;
                if (!canStart(s)) { rejStart++; continue; }
                // 自证（用**实现自己的**几何判定 ✓）：这一框必须命中一个未选中的顶层主题，
                // 且不含居中根（根入框会走剔除路径 ⇒ 假红 ✗）
                var band = { x0: Math.min(s.x, end.x), x1: Math.max(s.x, end.x),
                  y0: Math.min(s.y, end.y), y1: Math.max(s.y, end.y) };
                var hits = allRects.filter(function (m) { return window.MM.nodeSelectedBy(m, band); });
                if (hits.some(function (m) { return m.id === rootId; })) { rejRoot++; continue; }
                var grow = hits.filter(function (m) {
                  if (cur.indexOf(m.id) >= 0) return false;
                  var n1 = jm.get_node(m.id);
                  return !!(n1 && n1.parent && n1.parent.isroot);
                });
                if (!grow.length) { rejHit++; continue; }
                return JSON.stringify({ ok: true, start: s, end: end, targetId: tg.id,
                  grow: grow.map(function (m) { return m.id; }) });
              }
            }
            // 【前提失败 ⇒ 第三态的两种读数】—— 两者**必须分得清**：否则"没证据"会被读成"产品没做到" ✗
            var poolDiag = '顶层主题 ' + topicIds.length + ' − 已选 ' + selT + ' = ' + freeT + ' 个未选中';
            if (!cands.length) {
              return JSON.stringify({ ok: false, reason: 'nocand', pool: poolDiag,
                text: '合格候选池为空（' + poolDiag + '，其中**视口内合格** 0 个）' });
            }
            return JSON.stringify({ ok: false, reason: 'nostart', pool: poolDiag,
              text: 'no-empty-start-point-with-unselected-top-topic（顶层候选=' + cands.length + ' 起点被拒=' + rejStart + ' 框住根被拒=' + rejRoot + ' 没圈住目标被拒=' + rejHit + ' 视线内节点=' + allRects.length + '）' });
          } catch (e) { return JSON.stringify({ ok: false, text: 'PRE-ERR: ' + ((e && e.message) || String(e)) }); } })()`);
          // ⚠️ `PRE-ERR`（探针自己抛错）**不算前提失败**：它是真错误 ⇒ 一律判红（下面显式分开处理 ✓）
          if (!st.ok) { preFail = st; log.push('第 ' + attempts + ' 次【前提没造出来】：' + st.text); break; }
          anyPre = true;   // 前提成立过 ⇒ 从这一行起，`grew` / `kept===prev` 就是**有证据的硬判据** ✓
          // 判别力证明 `29-plain-box`：不带 Ctrl ⇒ 那是**普通框选（重选）**，本档必须判红 ✓
          const mods = MY_KEY('plain-box') ? [] : ['control'];
          mouse(ctx, 'mouseMove', st.start, mods);
          mouse(ctx, 'mouseDown', st.start, mods);
          await new Promise((r) => setTimeout(r, 90));
          const started = JSON.parse(await ctx.exec(`(function () {
            var el = document.getElementById('dsh-rubber-band');
            return JSON.stringify({ ok: !!el && el.style.display !== 'none' });
          })()`));
          if (!started.ok) { mouse(ctx, 'mouseUp', st.start, mods); log.push('第 ' + attempts + ' 次起点没起框'); continue; }
          // ⚠️ 基准必须**在按下之后**读：这次按下若落到节点上，会走 Ctrl+点击的加减选分支 ⇒ 按下**之前**
          //    读的值已经过期 ✗（实测：拿它去比"保留了几个"，冤枉了并集，还误报成"加选丢节点" ✓）。
          //    现在框已经起来了（started ✓），这之后再没有加减选 ⇒ 这个基准是准的 ✓
          const curNow = JSON.parse(await ctx.exec('JSON.stringify(window.MM.getSelectionRaw())'));
          const baseN = curNow.length;
          // 判别力证明 `29-tiny-box`：松手点只挪 12px（>8px ⇒ 不算误触，但框里没有任何合格候选）
          // ⇒ "**加选必须真的长大**"这条核心判据必须判红 ✓（证明它是活的，不是装饰）
          const endPt = MY_KEY('tiny-box') ? { x: st.start.x + 12, y: st.start.y + 12 } : st.end;
          mouse(ctx, 'mouseMove', { x: Math.round((st.start.x + endPt.x) / 2), y: Math.round((st.start.y + endPt.y) / 2) }, mods);
          mouse(ctx, 'mouseMove', endPt, mods);
          mouse(ctx, 'mouseUp', endPt, mods);
          await new Promise((r) => setTimeout(r, 300));
          // 独立复算"这一框**应该**命中谁"（口径：节点中心落在框内 —— 与实现的 nodeSelectedBy 同思路 ✓）
          // 用来分辨"实现没生效"与"我测试的假设错" ✗（实测这一步很值得 ✓）
          const expect = await execJson(ctx, `(function () {
            var x0 = Math.min(${st.start.x}, ${endPt.x}), x1 = Math.max(${st.start.x}, ${endPt.x});
            var y0 = Math.min(${st.start.y}, ${endPt.y}), y1 = Math.max(${st.start.y}, ${endPt.y});
            var ids = [];
            Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).forEach(function (el) {
              var q = el.getBoundingClientRect();
              if (q.width <= 0) return;
              var cx = q.left + q.width / 2, cy = q.top + q.height / 2;
              if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ids.push(el.getAttribute('nodeid'));
            });
            return JSON.stringify({ ok: true, ids: ids, text: '框 [' + x0 + ',' + y0 + ' → ' + x1 + ',' + y1 + '] 内中心点节点='
              + (ids.join(',') || '无') });
          })()`);
          const got = await execJson(ctx, `(function () {
            var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
            var prev = ${JSON.stringify(curNow)};
            var entry = ${JSON.stringify(cur)};
            var kept = prev.filter(function (id) { return raw.indexOf(id) >= 0; });
            // ⚠️ **入口级不变量**（判别力证明【29-plain-box】当场抓出来的一个真洞）：只比 prev（按下**之后**
            //    读的基准）是不够的 —— 若某一次按下**没起框**却又把已有选区清掉了（普通点画布就会），
            //    下一次的基准就成了 0 ⇒ "只增不减"看着成立、实际上用户的选区已经没了 ✗（实测：2 → 1 却判绿）。
            //    ⇒ 再比一道**进本档时**的选区：加选不许把它弄丢（一个都不许）✓
            var entryKept = entry.filter(function (id) { return raw.indexOf(id) >= 0; });
            // **契约**（能作为硬判据的那一半）：Ctrl+框选 = **只增不减** —— 原有节点一个不少 ✓
            //  · 这正是本轮修掉的那个真缺陷的判据（修复前实测 2 → 1 ✗）：不是空断言 ✓
            //  · "这一框是否命中新节点"取决于**实时布局**（框内命中要求中心/过半在框内 ✓），
            //    不适合做硬判据 ⇒ 作为观测信息展示 ✗→✓
            return JSON.stringify({ ok: raw.length >= prev.length && kept.length === prev.length
                && entryKept.length === entry.length,
              n: raw.length, kept: kept.length, entryKept: entryKept.length,
              text: 'raw=' + raw.join(',') + ' 原有 ' + prev.length + ' 个保留 ' + kept.length
                + ' 个（进本档时的 ' + entry.length + ' 个保留了 ' + entryKept.length + ' 个）'
                + ' ｜ 本框命中=' + (raw.length > prev.length ? ('+' + (raw.length - prev.length)) : '无新增') });
          })()`);
          log.push('第 ' + attempts + ' 次：目标=' + st.targetId + ' 预计入选=[' + (st.grow || []).join(',') + '] 起点=(' + st.start.x + ',' + st.start.y + ') ⇒ ' + got.text
            + '（' + baseN + ' → ' + got.n + '）｜ ' + expect.text);
          if (got.n > baseN) grew = true;
          if (got.kept < baseN) lost = true;      // 任何一次"丢了原有节点"都是真缺陷 ⇒ 断言必须红 ✓
          if (got.entryKept < cur.length) lost = true;   // 更严的那一道：把**进本档时**的选区弄丢了 ⇒ 红 ✓
        }
        /* ── 判定落点（三档）：`anyPre` 决定"这一档到底有没有资格判" ───────────────────────────
         *   · 探针自己抛错（PRE-ERR / JSON 没解析出来）⇒ **判红**（那是真错误，不是"前提造不出" ✗）；
         *   · 一次前提都没成立 ⇒ **第三态**（响亮"未验证"、不计入通过/总数、不阻断）；
         *   · 成立过 ⇒ 硬判据说了算：`grew && !lost`（"加选必须真的长大" + "只增不减"，一个字不放宽 ✗）。 */
        if (preFail && !preFail.reason) {
          return { ok: false, text: '前提探针**抛错**（真错误，不是"前提造不出" ⇒ 判红 ✗）：' + (preFail.text || JSON.stringify(preFail)) };
        }
        if (!anyPre) {
          const why = preFail || { text: '（没拿到前提失败的具体读数）' };
          return {
            ok: true,
            unverified: '域 29⑥ **本项未验证**：' + poolLine + ' ⇒ 前提造不出来（' + why.text + '）'
              + ' ⇒ 既不判绿（一条拖拽证据都没采到）、也不判红（不是产品没做到）、不计入通过/总数、也不阻断 ✓。'
              + '⚠️ 本档**判不了**的正是那两条核心判据："选区只增不减"与"加选真的长大"（无拖拽证据 ⇒ 无从采值）',
            text: poolLine + ' ｜ 前提未成立：' + why.text + ' ｜ 尝试 ' + attempts + ' 次 ｜ ' + log.join(' ／ ')
          };
        }
        const res = await execJson(ctx, `(function () {
          var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
          return JSON.stringify({ ok: ${grew} && !${lost},
            text: '加选前 ' + ${before} + ' 个 ⇒ 加选后 ' + raw.length + ' 个 ｜ 至少一次真的长大=${grew} 任何一次丢过节点=${lost}'
              + ' ｜ 尝试 ${attempts} 次 ｜ '
              + ${JSON.stringify(log.join(' ／ '))}
              + ' ｜ 渲染层事件=' + JSON.stringify((window.__dbg || []).slice(0, 4))
          });
        })()`);
        return { ok: grew && !lost, text: res.text + ' ｜ ' + poolLine };
      } finally {
        // 收尾（**必做**）：把视图还原成进本档时的样子 —— ⑤ 为了造前提动过它，
        // 不还原就会把位移带给后面的域（30/33/36/37… 全是真输入域，采样点全靠当前布局 ✗）。
        await ctx.exec(`(function () { var v = ${savedViewJson}; if (v && window.MM.setViewTransform) window.MM.setViewTransform(v); return 1; })()`);
      }
    }
  }
];
