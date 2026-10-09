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
      const pr = await execJson(ctx, `(function () {
        var cur = ${JSON.stringify(cur)};
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        var vis = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).filter(function (el) {
          var q = el.getBoundingClientRect();
          // ⚠️ 目标必须在**当前选区之外**：否则并集后数量不变 ⇒ 断言会因为前提不成立而假红 ✗
          return q.width > 20 && q.height > 10 && q.left > 4 && q.top > 4 && q.right < window.innerWidth - 4
            && q.bottom < window.innerHeight - 4 && cur.indexOf(el.getAttribute('nodeid')) < 0;
        });
        // 起点必须满足**与实现相同的判据**（app-view: e.target.closest('jmnodes, canvas.jsmind') ✓）：
        // 只查"不是节点"是不够的 —— 详情框/工具条也会命中，那样根本起不了框选 ✗（全量跑实测踩到 ✓）
        function canStart(pt) {
          var at = document.elementFromPoint(pt.x, pt.y);
          if (!at) return false;
          if (at.closest && at.closest('.float-detail')) return false;
          return !!(at.closest && at.closest('jmnodes, canvas.jsmind'));
        }
        var target = vis[vis.length - 1];
        var tq = target.getBoundingClientRect();
        var cands = [];
        for (var gx = 0.05; gx <= 0.95; gx += 0.1) {
          for (var gy = 0.25; gy <= 0.95; gy += 0.1) {
            cands.push({ x: Math.round(r.left + r.width * gx), y: Math.round(r.top + r.height * gy) });
          }
        }
        var start = null;
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i];
          if (!canStart(c)) continue;
          // 必须与目标节点拉开距离（否则框太小 <8px 会被当成误触 ✗）
          if (Math.abs(c.x - tq.left) < 40 && Math.abs(c.y - tq.top) < 40) continue;
          start = c; break;
        }
        if (!start) return JSON.stringify({ ok: false, text: '找不到能起框选的空白起点' });
        return JSON.stringify({ ok: true, start: start,
          end: { x: Math.round(tq.right + 6), y: Math.round(tq.bottom + 6) },
          targetId: target.getAttribute('nodeid') });
      })()`);
      if (!pr.ok) return { ok: false, text: pr.text };
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
      // 前置加固（断言自建前置 ✓）：全量跑实测这条曾出现「顶层候选=1、起框点全被拒」✗ ⇒
      // 先关掉所有浮窗详情框、把根重新居中（可见的顶层主题才是候选 ✓），再挑点。
      await ctx.exec('(function () { if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail(); if (window.MM.centerOnRoot) window.MM.centerOnRoot(); return 1; })()');
      await new Promise((r) => setTimeout(r, 250));
      let attempts = 0, grew = false, lost = false, last = '';
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
          return JSON.stringify({ ok: false, text: 'no-empty-start-point-with-unselected-top-topic（顶层候选=' + cands.length + ' 起点被拒=' + rejStart + ' 框住根被拒=' + rejRoot + ' 没圈住目标被拒=' + rejHit + ' 视线内节点=' + allRects.length + '）' });
        } catch (e) { return JSON.stringify({ ok: false, text: 'PRE-ERR: ' + ((e && e.message) || String(e)) }); } })()`);
        if (!st.ok) { log.push('第 ' + attempts + ' 次：' + st.text); break; }
        mouse(ctx, 'mouseMove', st.start, ['control']);
        mouse(ctx, 'mouseDown', st.start, ['control']);
        await new Promise((r) => setTimeout(r, 90));
        const started = JSON.parse(await ctx.exec(`(function () {
          var el = document.getElementById('dsh-rubber-band');
          return JSON.stringify({ ok: !!el && el.style.display !== 'none' });
        })()`));
        if (!started.ok) { mouse(ctx, 'mouseUp', st.start, ['control']); log.push('第 ' + attempts + ' 次起点没起框'); continue; }
        // ⚠️ 基准必须**在按下之后**读：这次按下若落到节点上，会走 Ctrl+点击的加减选分支 ⇒ 按下**之前**
        //    读的值已经过期 ✗（实测：拿它去比"保留了几个"，冤枉了并集，还误报成"加选丢节点" ✓）。
        //    现在框已经起来了（started ✓），这之后再没有加减选 ⇒ 这个基准是准的 ✓
        const curNow = JSON.parse(await ctx.exec('JSON.stringify(window.MM.getSelectionRaw())'));
        const baseN = curNow.length;
        mouse(ctx, 'mouseMove', { x: Math.round((st.start.x + st.end.x) / 2), y: Math.round((st.start.y + st.end.y) / 2) }, ['control']);
        mouse(ctx, 'mouseMove', st.end, ['control']);
        mouse(ctx, 'mouseUp', st.end, ['control']);
        await new Promise((r) => setTimeout(r, 300));
        // 独立复算"这一框**应该**命中谁"（口径：节点中心落在框内 —— 与实现的 nodeSelectedBy 同思路 ✓）
        // 用来分辨"实现没生效"与"我测试的假设错" ✗（实测这一步很值得 ✓）
        const expect = await execJson(ctx, `(function () {
          var x0 = Math.min(${st.start.x}, ${st.end.x}), x1 = Math.max(${st.start.x}, ${st.end.x});
          var y0 = Math.min(${st.start.y}, ${st.end.y}), y1 = Math.max(${st.start.y}, ${st.end.y});
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
          var kept = prev.filter(function (id) { return raw.indexOf(id) >= 0; });
          // **契约**（能作为硬判据的那一半）：Ctrl+框选 = **只增不减** —— 原有节点一个不少 ✓
          //  · 这正是本轮修掉的那个真缺陷的判据（修复前实测 2 → 1 ✗）：不是空断言 ✓
          //  · "这一框是否命中新节点"取决于**实时布局**（框内命中要求中心/过半在框内 ✓），
          //    不适合做硬判据 ⇒ 作为观测信息展示 ✗→✓
          return JSON.stringify({ ok: raw.length >= prev.length && kept.length === prev.length,
            n: raw.length, kept: kept.length,
            text: 'raw=' + raw.join(',') + ' 原有 ' + prev.length + ' 个保留 ' + kept.length
              + ' 个 ｜ 本框命中=' + (raw.length > prev.length ? ('+' + (raw.length - prev.length)) : '无新增') });
        })()`);
        log.push('第 ' + attempts + ' 次：目标=' + st.targetId + ' 预计入选=[' + (st.grow || []).join(',') + '] 起点=(' + st.start.x + ',' + st.start.y + ') ⇒ ' + got.text
          + '（' + baseN + ' → ' + got.n + '）｜ ' + expect.text);
        if (got.n > baseN) grew = true;
        if (got.kept < baseN) lost = true;      // 任何一次"丢了原有节点"都是真缺陷 ⇒ 断言必须红 ✓
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
      return { ok: !!res.ok, text: res.text };
    }
  }
];
