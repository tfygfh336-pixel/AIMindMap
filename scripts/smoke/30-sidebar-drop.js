/* ============================================================
 * scripts/smoke/30-sidebar-drop.js — ⑨「拖到面板最右侧 = 丢给 DSH 侧栏」的手势
 * ------------------------------------------------------------
 * 契约（用户反馈⑨「应该可以拖动进隔壁 dsh 侧边栏」；本期实现的边界手势）：
 *   在**拖动模式**下拖动一棵主题树，**在面板最右侧（距右缘 ≤24px）松手** ⇒ 把该节点上下文
 *   送进侧栏输入框 ✓；送不出去必须**如实说出原因** ✗（冒烟里没有真侧栏 ⇒ 预期是"如实报错"）。
 *
 * 为什么不是"真的松手在侧栏上"：侧栏是主进程的**原生 WebContentsView**，指针进去后渲染层
 * 连 mouseup 都收不到 ✗ ⇒ 拖动会卡住 ⇒ 跨视图松手要主进程参与（未做，见代码注释）。
 *
 * 本域用**真鼠标事件**（sendInputEvent ⇒ 走 Chromium 命中测试 ✓，不用 DOM 派发 —— 那是老假绿根因 ✗）。
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

function mouse(ctx, type, p) {
  ctx.win.webContents.sendInputEvent({ type: type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

module.exports = [
  {
    name: '⑨ 拖动模式 + 在最右侧松手 ⇒ 把该节点交给侧栏（送不出去要如实说原因）',
    run: async (ctx) => {
      // 找一棵可拖的树：取一个可见节点所属的顶层主题（拖动单位是树 ✓）
      const prep = await execJson(ctx, `(function () {
        var vis = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 10 && r.left > 4 && r.top > 40
            && r.right < window.innerWidth - 30 && r.bottom < window.innerHeight - 60;
        });
        if (!vis.length) return JSON.stringify({ ok: false, text: '没有可见节点' });
        // 选一个**不是根**、且能算出所属树的节点
        for (var i = 0; i < vis.length; i++) {
          var id = vis[i].getAttribute('nodeid');
          var root = id;   // 拖动目标由 setDragMode(true, <id>) 显式给定 ⇒ 不依赖 treeRootOf 是否导出 ✓
          if (!root) continue;
          var r = vis[i].getBoundingClientRect();
          return JSON.stringify({ ok: true, nodeId: id, rootId: root,
            x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + Math.round(r.height / 2)) });
        }
        return JSON.stringify({ ok: false, text: '找不到可拖的（非根）可见节点' });
      })()`);
      if (!prep.ok) return { ok: false, text: prep.text };

      // 进拖动模式（应用自己的入口 ✓）
      const entered = await execJson(ctx, `(function () {
        if (!window.MM.setDragMode) return JSON.stringify({ ok: false, text: '没有 MM.setDragMode' });
        window.MM.setDragMode(true, ${JSON.stringify(prep.rootId)});
        return JSON.stringify({ ok: !!(window.MM.dragModeActive && window.MM.dragModeActive()),
          text: '拖动模式=' + (window.MM.dragModeActive ? window.MM.dragModeActive() : '?') });
      })()`);
      if (!entered.ok) return { ok: false, text: '进不了拖动模式：' + entered.text };

      // 真鼠标拖拽：节点上按下 → 移到面板最右侧 → 松手（距右缘 ~10px ✓ 在渲染层自己的区域内 ✓）
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 10), y: ${prep.y} });
      })()`);
      mouse(ctx, 'mouseMove', { x: prep.x, y: prep.y });
      mouse(ctx, 'mouseDown', { x: prep.x, y: prep.y });
      mouse(ctx, 'mouseMove', { x: Math.round((prep.x + edge.x) / 2), y: prep.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: edge.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: edge.y });
      await new Promise((r) => setTimeout(r, 700));

      const res = await execJson(ctx, `(function () {
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        return JSON.stringify({
          ok: /没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框/.test(status),
          text: '状态栏=' + JSON.stringify(status.slice(0, 80))
        });
      })()`);
      // 收尾：退出拖动模式，不给后续断言留状态 ✓
      await ctx.exec('if (window.MM.setDragMode) window.MM.setDragMode(false); 1');
      return { ok: !!res.ok, text: '树=' + prep.rootId + ' 拖到 x=' + edge.x + ' 松手 ｜ ' + res.text };
    }
  },

  {
    /* 判别力证明（**常驻对照组**，比一次性注入更有价值 ✓）：
     * 同样的手势，但**在离右缘 80px 处松手** ⇒ 那 24px 的边界判定不该被触发 ⇒
     * 状态栏里**不允许**出现任何"送进侧栏"的结论 ✓。
     * 这一条与上一条成对 ⇒ 上一条一旦变成"永远绿"（例如判定写成恒真），本组立刻红 ✓ */
    name: '⑨ 对照组：在离右缘 80px 处松手 ⇒ 什么都不该被送出去（边界判定必须真的在生效）',
    run: async (ctx) => {
      const prep = await execJson(ctx, `(function () {
        var vis = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 10 && r.left > 4 && r.top > 40
            && r.right < window.innerWidth - 120 && r.bottom < window.innerHeight - 60;
        });
        if (!vis.length) return JSON.stringify({ ok: false, text: '没有可见节点' });
        var el = vis[0], id = el.getAttribute('nodeid'), r = el.getBoundingClientRect();
        return JSON.stringify({ ok: true, nodeId: id, rootId: id,
          x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + Math.round(r.height / 2)) });
      })()`);
      if (!prep.ok) return { ok: false, text: prep.text };
      // 先把状态栏擦干净（否则会读到上一条留下的结论 ✗）
      await ctx.exec(`(function () { window.MM.setStatus('（对照组：起点干净）'); window.MM.setDragMode(true, ${JSON.stringify(prep.rootId)}); return 1; })()`);
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 80), y: ${prep.y} });
      })()`);
      mouse(ctx, 'mouseMove', { x: prep.x, y: prep.y });
      mouse(ctx, 'mouseDown', { x: prep.x, y: prep.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: edge.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: edge.y });
      await new Promise((r) => setTimeout(r, 600));
      const res = await execJson(ctx, `(function () {
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        var bad = /没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框|正在送进侧栏/.test(status);
        return JSON.stringify({ ok: !bad,
          text: '离右缘 80px 松手 ⇒ 状态栏=' + JSON.stringify(status.slice(0, 60)) + '（不该出现送栏结论 ✓）' });
      })()`);
      await ctx.exec('if (window.MM.setDragMode) window.MM.setDragMode(false); 1');
      return { ok: !!res.ok, text: res.text };
    }
  }
];
