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

/** 投喂计数 + 起势计数（只读读数，不参与产品判定）。
 *  `feeds` = 真的调了 `MM.sendNodesToSidebar` 的次数（投喂的唯一出口）；
 *  `armed` = `selDragDrop` 跑过几次（= 产品把某次松手当成"拖拽结束"的次数）。
 *  ⚠️ 前提必须用 `armed` 判，不能用"按下+移动过"猜：没起势的那次松手是**单击**，
 *     而单击本来就该开详情、也不该走任何拖动分支（第一版就是在这里读成假红的）。 */
async function statsOf(ctx) {
  return execJson(ctx, '(function () {'
    + ' var s = (window.MM && window.MM.selDropStats) ? window.MM.selDropStats() : { feeds: -1, verdicts: -1 };'
    + ' var k = (window.MM && window.MM.selDragClickState) ? window.MM.selDragClickState() : { armed: -1 };'
    + ' return JSON.stringify({ feeds: s.feeds, verdicts: s.verdicts, armed: k.armed }); })()');
}

/** 选**两个**可见非根节点（多选 = 唯一允许拖给 DSH 的那一档），返回第一个节点的可按点。
 *  不要求"同一父"：本域验的是**手势**（渲染层"面板右缘 24px"那条兜底只看坐标）；
 *  同父那条约束是**树操作**的口径（收起/重排/重挂），不在这里。 */
async function setupTwo(ctx) {
  return execJson(ctx, `(async function () {
    if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    if (window.MM.expandAll) window.MM.expandAll();
    await new Promise(function (r) { setTimeout(r, 350); });
    if (window.MM.clearSelection) window.MM.clearSelection();
    var jm = window.MMApp.getState().jm;
    var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
    var vis = all.filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10 && r.left > 4 && r.top > 40
        && r.right < window.innerWidth - 60 && r.bottom < window.innerHeight - 60;
    });
    var picked = [], pts = [];
    for (var i = 0; i < vis.length && picked.length < 2; i++) {
      var id = vis[i].getAttribute('nodeid');
      var n = jm && jm.get_node(id);
      if (!n || n.isroot) continue;
      var r2 = vis[i].getBoundingClientRect();
      var cands = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5]];
      for (var c = 0; c < cands.length; c++) {
        var x = Math.round(r2.left + r2.width * cands[c][0]), y = Math.round(r2.top + r2.height * cands[c][1]);
        var at = document.elementFromPoint(x, y);
        if (at && at.closest && at.closest('jmnode[nodeid]') === vis[i]) { pts.push({ x: x, y: y }); break; }
      }
      if (pts.length !== picked.length + 1) continue;
      picked.push(id);
    }
    if (picked.length < 2) return JSON.stringify({ ok: false, text: '只找到 ' + picked.length + '/2 个可点的可见非根节点' });
    picked.forEach(function (id) { window.MM.toggleNodeSelection(id); });
    var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
    return JSON.stringify({ ok: raw.length >= 2, x: pts[0].x, y: pts[0].y,
      text: '可见=' + vis.length + ' 选中=[' + raw.join(',') + ']（应 ≥2 个）' });
  })()`);
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
    /* ⚠️ 2026-10-38 改写（判据换口径，**条数不减**：2 条 → 3 条）。
     * 为什么必须改：用户 2026-10-31 的结构化规格是 ——
     *   「单一节点 / 框选后那个大虚线框 直接拖动 ⇒ 相当于**拖动位置**，必须松在**导图页**才算；
     *     松在内置 dsh 就相当于**不修改位置**」「**多选** ⇒ 不符合拖动前提，**只能拖到内置 dsh**」
     * ⇒ 「单选松在侧栏 = **取消**」是**规格**，不是失败；落地就是 `SINGLE_SELECT_CAN_DROP_TO_DSH = false`。
     * 而本条改前验的是"单选拖到面板右缘 ⇒ 送去侧栏"（旧手势），它在新规格下**必然**红
     * —— 上一批的收口报告里"9 域"不包含本域，这条连带被漏掉了（G5 因此一直红在这一条）。
     * 现在本条验**新判定表里它该有的那一格**：单选 + 右缘松手 ⇒ 取消（状态栏说「已移动…」、不送侧栏）。
     * "送到侧栏"那一格搬到下一条（多选），那才是唯一允许投喂的形状。 */
    name: 'P4 ① 单选 + 面板右缘松手 ⇒ 按用户 2026-10-31 规格 = **取消**：状态栏说「已移动…」且**一个节点都不送**（feedsΔ=0）',
    run: async (ctx) => {
      const st = await setupOne(ctx);
      if (!st.ok) return { ok: false, text: st.text };
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 10) });
      })()`);
      const s0 = await statsOf(ctx);
      mouse(ctx, 'mouseMove', { x: st.x, y: st.y });
      mouse(ctx, 'mouseDown', { x: st.x, y: st.y });
      mouse(ctx, 'mouseMove', { x: Math.round((st.x + edge.x) / 2), y: st.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: st.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: st.y });
      await new Promise((r) => setTimeout(r, 700));
      const s1 = await statsOf(ctx);
      const res = await execJson(ctx, `(function () {
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        return JSON.stringify({
          moved: /已移动/.test(status),
          fed: /没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框|正在送进侧栏/.test(status),
          text: '状态栏=' + JSON.stringify(status.slice(0, 70))
        });
      })()`);
      const dFeeds = s1.feeds - s0.feeds;
      /* 前提：这一次松手必须被产品当成"拖拽结束"（而不是单击）—— 否则"取消"这一格是空转的。 */
      const armedOk = (s1.armed - s0.armed) === 1;
      const ok = armedOk && res.moved === true && res.fed === false && dFeeds === 0;
      return { ok: ok, text: st.text + ' ⇒ 拖到 x=' + edge.x + ' 松手 ｜ ' + res.text
        + ' ｜ 投喂Δ=' + dFeeds + '（应 0）· 起势 armedΔ=' + (s1.armed - s0.armed) + '（应 1）'
        + ' ｜ 判据：已移动=' + res.moved + '（应 true）· 送栏字样=' + res.fed + '（应 false）'
        + ' ⇒ 取消（不改位置、不送侧栏）' + (ok ? ' ✓' : ' ✗') };
    }
  },
  {
    /* ★ 这一条是「送到侧栏」唯一该被验的形状（用户规格：**多选只能拖到内置 dsh**）。
     * 改前**没有任何断言覆盖它** —— 域 33 只验了单选的旧手势，域 30 的 ⑨ 验的是真鼠标拖到侧栏矩形。
     * 两条都要在，因为它们验的是**两个不同的判定入口**：
     *   · 本域这一条 = 渲染层的"面板右缘 24px"兜底（`selDragDrop` 路径①，只听渲染层自己的坐标）；
     *   · 域 30 的 ⑨ = 主进程按侧栏视图矩形判的跨视图落点（真机唯一可信的那条）。
     * ⚠️ 冒烟里没有侧栏服务 ⇒ 预期"如实报错"（`没送进侧边栏：…`），那也是**投喂发生过**的证据。 */
    name: 'P4 ①-b 多选（选中 2 个节点）+ 面板右缘松手 ⇒ **真的送进侧栏**：feedsΔ=1 且状态栏命中送栏字样（这是"送到侧栏"唯一该成功的形状）',
    run: async (ctx) => {
      const st = await setupTwo(ctx);
      if (!st.ok) return { ok: false, text: st.text };
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 10) });
      })()`);
      const s0 = await statsOf(ctx);
      mouse(ctx, 'mouseMove', { x: st.x, y: st.y });
      mouse(ctx, 'mouseDown', { x: st.x, y: st.y });
      mouse(ctx, 'mouseMove', { x: Math.round((st.x + edge.x) / 2), y: st.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: st.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: st.y });
      await new Promise((r) => setTimeout(r, 700));
      const s1 = await statsOf(ctx);
      const res = await execJson(ctx, `(function () {
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        return JSON.stringify({
          fed: /没送进侧边栏：|已把 \\d+ 个节点送进侧栏输入框|正在送进侧栏/.test(status),
          text: '状态栏=' + JSON.stringify(status.slice(0, 70))
        });
      })()`);
      const dFeeds = s1.feeds - s0.feeds;
      const armedOk = (s1.armed - s0.armed) === 1;
      const ok = armedOk && res.fed === true && dFeeds === 1;
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      return { ok: ok, text: st.text + ' ⇒ 拖到 x=' + edge.x + ' 松手 ｜ ' + res.text
        + ' ｜ 投喂Δ=' + dFeeds + '（应 1）· 起势 armedΔ=' + (s1.armed - s0.armed) + '（应 1）'
        + ' ｜ 送栏字样=' + res.fed + '（应 true）' + (ok ? ' ✓' : ' ✗') };
    }
  },
  {
    /* 幂等（用户 2026-10-39：「拖过去两个节点直接弹这么多」那一轮顺出来的不变量）：
     * **同一次拖拽只许投一次**。终点有三条上报路（渲染层 / DSH 内容页 / 控制栏页），
     * 其中任意两条先后到达都是**合法的重复**，绝不允许变成第二次投喂。
     * 本条把"重复上报"做成确定的注入：先正常拖一次（feedsΔ=1），再把**同一个终点**
     * 往主进程报第二遍 / 第三遍 ⇒ feeds 必须**停在** 1。
     * 该红的形态很清楚：谁把"终点"当成"投喂的触发点"（在 `sel-drag-end` 或观察者里再 feed 一次），
     * 这条立刻变成 2 —— 而 ①-b 那条（feedsΔ=1）**抓不到**它（它只看第一次）。 */
    name: 'P4 ①-c 幂等：同一次拖拽的终点被**重复上报**时不许再投（多选 + 右缘松手 ⇒ feedsΔ=1；随后再把同一终点报 3 遍 ⇒ feeds 必须仍为 1）',
    run: async (ctx) => {
      const st = await setupTwo(ctx);
      if (!st.ok) return { ok: false, text: st.text };
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.right - 10) });
      })()`);
      const s0 = await statsOf(ctx);
      mouse(ctx, 'mouseMove', { x: st.x, y: st.y });
      mouse(ctx, 'mouseDown', { x: st.x, y: st.y });
      mouse(ctx, 'mouseMove', { x: Math.round((st.x + edge.x) / 2), y: st.y });
      mouse(ctx, 'mouseMove', { x: edge.x, y: st.y });
      mouse(ctx, 'mouseUp', { x: edge.x, y: st.y });
      await new Promise((r) => setTimeout(r, 700));
      const s1 = await statsOf(ctx);
      const dFeeds1 = s1.feeds - s0.feeds;
      const armedOk = (s1.armed - s0.armed) === 1;
      /* 重复上报同一个终点：连报 3 遍（多报几遍才分得清"一次"与"每次"） */
      const re = await execJson(ctx, `(async function () {
        var out = [];
        for (var i = 0; i < 3; i++) {
          try { out.push(await window.desktop.dsh.selDragEnd({ x: ${edge.x}, y: ${st.y} })); }
          catch (e) { out.push({ err: String((e && e.message) || e) }); }
        }
        return JSON.stringify({ ok: true, out: out.map(function (v) {
          return { ok: !!(v && v.ok), reason: (v && v.reason) || null, hit: !!(v && v.hit) }; }) });
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const s2 = await statsOf(ctx);
      const dFeeds2 = s2.feeds - s0.feeds;
      const noRefeed = re && Array.isArray(re.out) && re.out.every((v) => v.ok === false || v.hit === false);
      const ok = armedOk && dFeeds1 === 1 && dFeeds2 === 1 && noRefeed === true;
      await ctx.exec('(function () { if (window.MM.clearSelection) window.MM.clearSelection(); return 1; })()');
      return { ok: ok, text: st.text + ' ⇒ 松手 ｜ 首次投喂Δ=' + dFeeds1 + '（应 1）· 起势 armedΔ=' + (s1.armed - s0.armed)
        + '（应 1）· 重复上报同一终点 3 次 ⇒ 回执=' + JSON.stringify((re && re.out) || re)
        + ' · 累计投喂Δ=' + dFeeds2 + '（应仍为 1 —— 重复上报不许再投）' + (ok ? ' ✓' : ' ✗') };
    }
  },
  {
    name: 'P4 ② 对照组：同样从已选中节点拖，但**在面板左侧**松手（离侧栏很远）⇒ 什么都不该被送出去',
    run: async (ctx) => {
      const st = await setupOne(ctx);
      if (!st.ok) return { ok: false, text: st.text };
      await ctx.exec('window.MM.setStatus("（对照组：起点干净）"); 1');
      // ⚠️ 松手点必须**离原生侧栏足够远**：窄窗时侧栏能占到窗口右侧 690px，面板本身只剩 ~250px 宽，
      //    "离右缘 80px"就会**真的落在侧栏上** ⇒ P7 的落点判定判 hit ✓ ⇒ 投喂 ✓ —— 那不是缺陷，
      //    是本对照组的前提错了 ✗（实测：全链跑窗口更窄时这条假红 ✓）。改成"面板左缘 +80px"：
      //    无论窗口多窄都远离侧栏 ✓，而"不在右缘 24px 内 ⇒ 不投喂"这条契约照旧被验 ✓。
      const edge = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.left + 80) });
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
          text: '在面板左侧（x=' + ${edge.x} + '）松手 ⇒ 状态栏=' + JSON.stringify(status.slice(0, 60)) + '（不该有送栏结论 ✓）' });
      })()`);
      await ctx.exec('if (window.MM.clearSelection) window.MM.clearSelection(); 1');
      return { ok: !!res.ok, text: res.text };
    }
  }
];
