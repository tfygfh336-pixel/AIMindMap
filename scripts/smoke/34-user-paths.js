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

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** 圆钮的现场读数（存在 / 可见 / 在框外 / 贴哪边）——多处复用 ✓ */
const BTN_JS = `(function () {
  // 只认**可见的那个**详情框（域与域之间会留下隐藏的旧框 ✗ 实测量到过 121x121、负坐标的僵尸框 ✓）
  var allBoxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
  var box = null;
  for (var bi = 0; bi < allBoxes.length; bi++) {
    var bq0 = allBoxes[bi].getBoundingClientRect();
    if (allBoxes[bi].style.display !== 'none' && bq0.width > 40 && bq0.height > 40) { box = allBoxes[bi]; break; }
  }
  var b = box ? box.querySelector('.rel-show-btn') : null;
  if (!b) return JSON.stringify({ ok: false, text: '没有圆钮（.rel-show-btn）' });
  var r = b.getBoundingClientRect();
  var bq = box.getBoundingClientRect();
  var cs = window.getComputedStyle(b);
  return JSON.stringify({
    ok: true,
    w: Math.round(r.width), h: Math.round(r.height),
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
    name: '用户路径①：详情框**反复开关/切节点**，圆钮每次都在、都在框外、都是圆形（治"出现一次就消失"）',
    run: async (ctx) => {
      const pick = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, out = [];
        (function walk(n) { if (!n) return; if (n.id && n.id !== 'root' && out.length < 2) out.push(n.id); (n.children || []).forEach(walk); })(jm.get_node('root'));
        return JSON.stringify({ ok: out.length === 2, a: out[0], b: out[1] });
      })()`);
      if (!pick.ok) return { ok: false, text: '挑不到两个节点' };
      const seq = [pick.a, pick.b, pick.a, pick.b];   // 切四次 ⇒ 覆盖"每次渲染都要有" ✓
      const rounds = [];
      for (let i = 0; i < seq.length; i++) {
        await ctx.exec(`(function () { var n = window.MMApp.getState().jm.get_node(${JSON.stringify(seq[i])}); if (n) window.MMApp.showDetail(n); return 1; })()`);
        await new Promise((r) => setTimeout(r, 120));
        const s = await execJson(ctx, BTN_JS);
        rounds.push({ node: seq[i], ok: !!(s.ok && s.visible && s.outsideBox && s.radius === '50%'), text: s.text || ('w=' + s.w + ' 在框外=' + s.outsideBox + ' 圆角=' + s.radius + ' 可见=' + s.visible) });
      }
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
        var b = document.querySelector('.float-detail .rel-show-btn');
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
        var b = document.querySelector('.float-detail .rel-show-btn');
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
    name: '用户路径④：双击**叶子节点**⇒ 只给状态说明、不弹编辑框、不报错（边界）',
    run: async (ctx) => {
      const r = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, id = null;
        (function walk(n) { if (id || !n) return; var k = n.children || []; if (n.id && n.id !== 'root' && k.length === 0) { id = n.id; return; } k.forEach(walk); })(jm.get_node('root'));
        if (!id) return JSON.stringify({ ok: false, text: '找不到叶子节点' });
        window.MMApp.showDetail(jm.get_node(id));     // 让状态栏有个干净起点
        window.MM.setStatus('（探针起点）');
        var el = document.querySelector('jmnode[nodeid="' + id + '"]');
        if (!el) return JSON.stringify({ ok: false, text: '叶子不可见：' + id });
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        var dlg = document.getElementById('edit-dialog').style.display === 'flex';
        if (dlg) document.getElementById('edit-cancel').click();
        // 期望：状态栏说明"没有子节点"（不静默 ✗）；编辑框不得弹出 ✓
        return JSON.stringify({ ok: /没有子节点/.test(status) && !dlg, id: id, text: '叶子=' + id + ' 状态栏=' + JSON.stringify(status.slice(0, 60)) + ' 编辑框=' + dlg });
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
        var btn = vbox ? vbox.querySelector('.rel-show-btn') : null;
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
  }
];
