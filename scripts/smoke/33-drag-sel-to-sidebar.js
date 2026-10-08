/* ============================================================
 * scripts/smoke/33-drag-sel-to-sidebar.js — P4：框选后**直接**拖给侧栏（不进拖动模式）
 * ------------------------------------------------------------
 * 用户原话（C）：「不用进拖动模式，拖动给侧边栏的拖动和拖动节点位置的拖动不一样，
 *   框选之后拖动给侧边栏应该是框选之后**直接可以**进行的」
 *
 * 成对契约（互为判别力证明 ✓）：
 *   ① 从**已选中节点**上按下 → 拖到**面板右缘**松手 ⇒ 必须给出结论
 *      （冒烟里没有真侧栏 ⇒ 预期"如实报错" ✗ 不许沉默）
 *   ② 对照组：同样按下 → 在**离右缘 80px** 松手 ⇒ 什么都不该被送出去 ✓
 *      （边界判定若变成恒真，这一条立刻红 ✓）
 *
 * 前置只选**一个**节点：上一版要求"父不同且互不祖先的两个" ⇒ 界面里挑不出来（试过等重排也没用）✗；
 * P4 要验的是**手势**而非批量 ✓（批量那条已由工具条「⇥ 侧栏」+ 域 29/31 覆盖 ✓）。
 * 全程**真鼠标事件**（sendInputEvent ⇒ 走命中测试 ✓ 不用 DOM 派发 —— 老假绿根因 ✗）。
 * ============================================================ */
'use strict';

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 200) }; }
}

function mouse(ctx, type, p) {
  ctx.win.webContents.sendInputEvent({ type: type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

/** 选中一个可见的非根节点；顺带把"可见数 / 选中集"打进 text（诊断信息 ✓ 不靠猜 ✗） */
async function setupOne(ctx) {
  return execJson(ctx, `(async function () {
    if (window.MM.expandAll) window.MM.expandAll();
    await new Promise(function (r) { setTimeout(r, 350); });          // 等 jsMind 重排 ✓
    if (window.MM.clearSelection) window.MM.clearSelection();
    var jm = window.MMApp.getState().jm;
    var vis = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10 && r.left > 4 && r.top > 40
        && r.right < window.innerWidth - 60 && r.bottom < window.innerHeight - 60;
    });
    if (!vis.length) return JSON.stringify({ ok: false, text: '没有可见节点' });
    var picked = null, pid = null;
    for (var i = 0; i < vis.length; i++) {
      var id = vis[i].getAttribute('nodeid');
      var n = jm && jm.get_node(id);
      if (n && !n.isroot) { picked = vis[i]; pid = id; break; }
    }
    if (!picked) return JSON.stringify({ ok: false, text: '可见 ' + vis.length + ' 个，但没有非根节点' });
    window.MM.toggleNodeSelection(pid);
    var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
    var r2 = picked.getBoundingClientRect();
    return JSON.stringify({ ok: raw.length >= 1,
      x: Math.round(r2.left + Math.round(r2.width / 2)), y: Math.round(r2.top + Math.round(r2.height / 2)),
      text: '可见=' + vis.length + ' 选中=[' + raw.join(',') + ']（应含 ' + pid + '）' });
  })()`);
}

module.exports = [
  {
    name: 'P4 ①：从已选中节点直接拖到面板右缘松手 ⇒ 送去侧栏（送不出去要如实说原因）',
    run: async (ctx) => {
      const st = await setupOne(ctx);
      if (!st.ok) return { ok: false, text: st.text };
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 10) });
      })()`);
      mouse(ctx, 'mouseMove', { x: st.x, y: st.y });
      mouse(ctx, 'mouseDown', { x: st.x, y: st.y });
      mouse(ctx, 'mouseMove', { x: Math.round((st.x + edge.x) / 2), y: st.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: st.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: st.y });
      await new Promise((r) => setTimeout(r, 700));
      const res = await execJson(ctx, `(function () {
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        return JSON.stringify({
          ok: /没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框|正在送进侧栏/.test(status),
          text: '状态栏=' + JSON.stringify(status.slice(0, 70))
        });
      })()`);
      return { ok: !!res.ok, text: st.text + ' ⇒ 拖到 x=' + edge.x + ' 松手 ｜ ' + res.text };
    }
  },
  {
    name: 'P4 ② 对照组：同样从已选中节点拖，但离右缘 80px 松手 ⇒ 什么都不该被送出去',
    run: async (ctx) => {
      const st = await setupOne(ctx);
      if (!st.ok) return { ok: false, text: st.text };
      await ctx.exec('window.MM.setStatus("（对照组：起点干净）"); 1');
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 80) });
      })()`);
      mouse(ctx, 'mouseMove', { x: st.x, y: st.y });
      mouse(ctx, 'mouseDown', { x: st.x, y: st.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: st.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: st.y });
      await new Promise((r) => setTimeout(r, 600));
      const res = await execJson(ctx, `(function () {
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        var bad = /没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框|正在送进侧栏/.test(status);
        return JSON.stringify({ ok: !bad,
          text: '离右缘 80px 松手 ⇒ 状态栏=' + JSON.stringify(status.slice(0, 60)) + '（不该有送栏结论 ✓）' });
      })()`);
      await ctx.exec('if (window.MM.clearSelection) window.MM.clearSelection(); 1');
      return { ok: !!res.ok, text: res.text };
    }
  }
];
