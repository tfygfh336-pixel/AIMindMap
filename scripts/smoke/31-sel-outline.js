/* ============================================================
 * scripts/smoke/31-sel-outline.js — P5：真正被框选的节点画虚线描边
 * ------------------------------------------------------------
 * 用户原话（C②）：
 *   「原本框选了几个子节点后，就会用虚线框展示被框选的子节点的父节点下的所有内容，
 *     现在应该是除了保留那个虚线框设计之外，还将实际被框选的节点用虚线描出来，
 *     比如框选了 a 和 b，那就把 a 和 b 节点的边框变成虚线，并且**不会被同一父节点下的条件限制**
 *     （这与拖动的逻辑独立）」
 * ⇒ 两条契约：
 *   ① 父级那块虚线框**仍然在**（原有设计不删 ✓）；
 *   ② 真正被框选的节点**各自有虚线描边**（类 mm-sel-raw ✓），且**跨父也能同时上色** ✓
 *     —— 这一层用的是 applySelection 里的 fdSelectionRaw（未裁剪）✓ 与拖动/收起的裁剪口径解耦 ✓
 * 本域用**界面自己的选区入口**（MM.applySelection 不行 —— 它是内部函数；用框选真实手势太久 ✗）
 * ⇒ 直接调 `MM.toggleNodeSelection`（Ctrl+点击那条路径 ✓ 它内部走 applySelection ✓ 会存 raw ✓），
 *   再断言"两个**不同父**的节点同时上了色" ✓ —— 这一条正是"不受同一父限制"的判据 ✓
 * ============================================================ */
'use strict';

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 200) }; }
}

module.exports = [
  {
    name: 'P5 选区：两个**不同父**的节点同时虚线描边（不受同父限制）+ 父级虚线框仍在',
    run: async (ctx) => {
      const pre = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm;
        if (!jm) return JSON.stringify({ ok: false, text: '没有 jm' });
        if (window.MM.clearSelection) window.MM.clearSelection();
        // 先**展开全树**：实测折叠状态下可见节点常常同父（甚至只有一条链）⇒ 挑不出"两个不同父" ✗
        if (window.MM.expandAll) window.MM.expandAll();
        // 找两个**父不同**的可见节点（用 jsMind 的真实父子关系判 ✓ 不猜 id 形状 ✓）
        var vis = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]')).filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 10 && r.height > 10;
        });
        var picked = [];
        for (var i = 0; i < vis.length && picked.length < 2; i++) {
          var id = vis[i].getAttribute('nodeid');
          var n = jm.get_node(id);
          if (!n || n.isroot) continue;
          var pid = n.parent ? n.parent.id : '(none)';
          if (picked.length === 0) { picked.push({ id: id, pid: pid }); continue; }
          if (pid !== picked[0].pid) picked.push({ id: id, pid: pid });
        }
        if (picked.length < 2) return JSON.stringify({ ok: false, text: '找不到两个不同父的可见节点' });
        picked.forEach(function (p) { if (window.MM.toggleNodeSelection) window.MM.toggleNodeSelection(p.id); });
        var cls = (window.MM.rawSelectionClass && window.MM.rawSelectionClass()) || 'mm-sel-raw';
        var painted = picked.map(function (p) {
          var el = document.querySelector('jmnode[nodeid="' + p.id + '"]');
          return { id: p.id, pid: p.pid, cls: !!(el && el.classList.contains(cls)) };
        });
        var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
        var box = document.getElementById('dsh-selection-outline');
        return JSON.stringify({
          ok: painted.every(function (x) { return x.cls; }) && raw.length >= 2
            && !!box && box.style.display !== 'none',
          text: '两个不同父节点=' + JSON.stringify(painted) + ' ｜ raw=' + raw.join(',')
            + ' ｜ 父级虚线框可见=' + (!!box && box.style.display !== 'none')
            + ' ｜ 描边类=' + cls
        });
      })()`);
      // 收尾：清掉选区与描边，不给后续断言留脏状态 ✓
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); if (window.MM.paintRawSelection) window.MM.paintRawSelection(); return 1; })()');
      return { ok: !!pre.ok, text: pre.text };
    }
  }
];
