/* ============================================================
 * AI MindMap — 画布视图（app-view.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 统一视图变换：只用**一个** CSS transform（translate + scale）承担平移与缩放
 *      —— fdView / fdApplyView / zoomViewAt / neutralizeScroll / setViewScale / getPanState
 *   2) 视口交互接线：滚轮缩放（指针锚点）+ 中键平移 + 吸收残留滚动（全局只绑一次）
 *   3) 面板锚定：根节点居中、还原视图
 *   4) 主题模式：容器根隐藏、根→顶层主题连线跳过（改写 jsMind 的 show_lines）
 *   5) 拖动树（v0.15）：右键顶层主题树根 → 拖动模式 → 左键拖动 = **只移动该棵树**
 *      （其他树不动）。实现 = 树偏移 treeOffsets：目标树 jmnode 加 transform: translate，
 *      连线在 show_lines override 里按所属树偏移坐标重画（canvas 整张重画）。
 *   6) 展开/收起全部
 * 边界（本文件不负责）：
 *   · 浮动详情框的创建/定位/拖动 → app-detail*.js（本文件只经 MM 转发调用）
 *   · 序列化与渲染入口 → app-core.js；编辑操作 → app-actions.js
 * 共享可变槽位 fdView / fdHideRootLinks 定义在 app-core.js（同名全局槽位，
 * 因此函数体里的裸名读写与拆分前完全一致）。
 * 所有搬迁的函数体与拆分前逐字相同；本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const state = MM.state;

  function fdPanel() {
    const jm = state.jm;
    return (jm && jm.view && jm.view.e_panel) || null;
  }
  function fdQ(box, sel) { return box.el.querySelector(sel); }

  /** 真正的滚动容器：jsMind 的 e_panel 并不包含节点，节点在 jsmind-inner（overflow:auto）里 */
  function fdScrollHost() {
    const nodesEl = document.querySelector('jmnodes');
    return (nodesEl && nodesEl.parentElement) || fdPanel();
  }

  /* ================= 统一视图变换（平移 + 缩放） =================
   * 只用**一个** CSS transform 作用在 jsMind 的 canvas 与节点层上：
   *     translate(x,y) scale(s)，transform-origin: 0 0
   * jsMind 原生用「e_panel 滚动 + 子元素 style.zoom」实现平移缩放；我们**完全不调用**
   * 它的 zoom/scroll（内部 zoom_current 恒置为 s 仅用于读数，scrollLeft/Top 恒为 0），
   * 从而只有一套坐标系 —— 放大后不会再因"滚动够不到"而显示不全。
   * 详情框在变换层之外，按所属节点的 getBoundingClientRect 跟随，自身再按 s 缩放。 */

  /** 变换作用对象：jsMind 的连线 canvas 与节点层（两者同变换，线与节点永不错位） */
  function fdViewEls() {
    const p = fdPanel();
    if (!p) return [];
    return ['canvas.jsmind', 'jmnodes']
      .map((sel) => p.querySelector(sel))
      .filter(Boolean);
  }

  function fdApplyView() {
    fdViewEls().forEach((el) => {
      el.style.transformOrigin = '0 0';
      // 连线层可能为覆盖负坐标而整体平移原点（dataset.ox/oy = 逻辑原点，s=1 空间）。
      // 该平移必须**随 fdView.s 缩放**并并入 transform；若用 style.left/top（布局值，
      // 不随 scale），zoom 后会与节点错位 ox*(1-s)。
      let ex = 0, ey = 0;
      if (el.dataset && el.dataset.ox !== undefined && el.dataset.ox !== '') {
        ex = Number(el.dataset.ox) * fdView.s;
        ey = Number(el.dataset.oy) * fdView.s;
      }
      el.style.transform = 'translate(' + (fdView.x + ex) + 'px,' + (fdView.y + ey) + 'px) scale(' + fdView.s + ')';
    });
  }

  /** 吸收 jsMind 的任何滚动：平移只允许走 transform，杜绝双坐标系 */
  function neutralizeScroll() {
    const p = fdPanel();
    if (p && (p.scrollLeft || p.scrollTop)) { p.scrollLeft = 0; p.scrollTop = 0; }
  }

  /** 以容器内点 (px,py) 为不动点缩放；factor 为缩放倍数 */
  function zoomViewAt(px, py, factor, min, max) {
    const s2 = Math.max(min, Math.min(max, fdView.s * factor));
    const k = s2 / fdView.s;
    fdView.x = px - (px - fdView.x) * k;
    fdView.y = py - (py - fdView.y) * k;
    fdView.s = s2;
    const jm = state.jm;
    if (jm && jm.view) jm.view.zoom_current = s2; // 仅用于读数
    neutralizeScroll();
    fdApplyView();
  }

  /** 直接设置缩放（围绕面板中心），供外部/自检使用 */
  function setViewScale(s) {
    const p = fdPanel();
    if (!p) return;
    const r = p.getBoundingClientRect();
    zoomViewAt(r.width / 2, r.height / 2, s / fdView.s, 0.0001, 99);
  }

  /** 当前平移量（供外部/自检读取） */
  function getPanState() { return { x: fdView.x, y: fdView.y, s: fdView.s }; }

  let fdViewportBound = false;
  let fdPanning = null;

  /* —— 拖动树（右键菜单「拖动树」入口，v0.15 开发中）——
   * 语义：**只移动目标顶层主题树**（如「802.11 无线网络」），其他树不动。
   * 实现：
   *   · 树偏移 treeOffsets[顶层主题id] = {x, y}（逻辑画布坐标，与 fdView 同一坐标空间；
   *     经 fdView 父层 scale 放大成屏幕位移 → 缩放时树相对位置保持）。
   *   · 节点：目标树全部 jmnode 设 style.transform = translate(x,y)（jsMind 只写
   *     left/top、不设 transform，故无冲突；重布局/缩放后保留）。
   *   · 连线：canvas 整张重画，show_lines override 里给「属于目标树」的线两端坐标
   *     加偏移（其他树的线坐标不变 → 视觉上只有目标树移动）。
   * 纯视图操作：不产生脏数据、不进撤销栈、不落盘；renderMind 重建时清空。 */
  const treeOffsets = {};        // { [顶层主题id]: {x, y} }
  let fdDragMode = false;
  let fdDragTreeRoot = null;     // 拖动模式锁定的目标树根（root 直接子节点 id）
  let fdTreeDragStart = null;    // {x, y, ox, oy} 拖动起点（屏幕）与起始偏移（逻辑）
  let fdDragModePan = null;      // 兜底：无目标树时的画布平移（中键同款）

  /* —— 框选节点（v0.16.3）——
   * 交互（用户最终语义）：
   *   · 主界面空白处**左键拖拽** = 框选（虚线橡皮筋实时跟随）；
   *   · 松开后与框相交的**可见**节点被选中：虚线框包裹（与拖动树同款虚线视觉）；
   *   · 选中态**持久**，直到下一次左键点击框外区域才清除；
   *   · 右键框内 → 专属菜单：「拖动所选」「收起所选」「展开所选」；
   *     每次操作只作用于**同一父节点**的一组（框选可能跨父，按父分组取最大组），
   *     收起/展开对选中节点里"有子节点"的逐个执行，拖动按树偏移机制整体平移
   *     其所属顶层树（拖动单位是树，与既有拖动树一致）。
   * 纯视图操作：不产生脏数据、不落盘；renderMind 重建时清除。 */
  let fdRubber = null;           // 框选中：{x0,y0,x1,y1}（面板内坐标）
  let fdRubberEl = null;         // 橡皮筋 DOM
  let fdSelection = [];          // 选中的节点 id（持久到点击框外）
  const RUBBER_ID = 'dsh-rubber-band';
  const SEL_OUTLINE_ID = 'dsh-selection-outline';

  /** 节点逻辑坐标（含树偏移——与连线端点同一真源语义） */
  function nodeLogicalPos(el) {
    const id = el.getAttribute('nodeid');
    const to = id ? treeOffsetFor(id) : null;
    return {
      x: parseFloat(el.style.left || '0') + (to ? to.x : 0),
      y: parseFloat(el.style.top || '0') + (to ? to.y : 0)
    };
  }

  /** 面板内坐标（e_panel 逻辑坐标，与节点 style.left/top 同一空间） */
  function panelPoint(clientX, clientY) {
    const p = fdPanel();
    const r = p.getBoundingClientRect();
    const s = fdView.s || 1;
    return {
      x: (clientX - r.left - fdView.x) / s,
      y: (clientY - r.top - fdView.y) / s
    };
  }

  function ensureRubberEl() {
    let el = document.getElementById(RUBBER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = RUBBER_ID;
    el.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:998;'
      + 'border:1px dashed #1664ff;background:rgba(22,100,255,.06);box-sizing:border-box;';
    const jmnodes = document.querySelector('jmnodes');
    if (jmnodes) jmnodes.appendChild(el);
    return el;
  }

  function ensureSelOutline() {
    let el = document.getElementById(SEL_OUTLINE_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = SEL_OUTLINE_ID;
    // 与拖动树虚线框同款视觉（tree-drag-outline）
    el.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:999;'
      + 'box-sizing:border-box;border:2px dashed #1664ff;border-radius:12px;'
      + 'background:rgba(22,100,255,.06);';
    const jmnodes = document.querySelector('jmnodes');
    if (jmnodes) jmnodes.appendChild(el);
    return el;
  }

  /** 可见节点（jmnode 有实际尺寸）与其逻辑包围盒 */
  function visibleNodeRects() {
    const out = [];
    document.querySelectorAll('jmnode[nodeid]').forEach((el) => {
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
      const id = el.getAttribute('nodeid');
      if (!id || id === 'root') return;
      const p = nodeLogicalPos(el);
      out.push({ id, x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight });
    });
    return out;
  }

  /** 当前橡皮筋的 band（规范化 x0<x1 / y0<y1） */
  function rubberBand() {
    if (!fdRubber) return null;
    return {
      x0: Math.min(fdRubber.x0, fdRubber.x1), x1: Math.max(fdRubber.x0, fdRubber.x1),
      y0: Math.min(fdRubber.y0, fdRubber.y1), y1: Math.max(fdRubber.y0, fdRubber.y1)
    };
  }

  /** 实时命中预览：拖动中给当前会命中的节点加临时视觉（outline 样式，
   *  松手 applySelection 后由选区虚线框接管；取消框选时清除）。
   *  **与落选同口径**：命中集先做范围筛选（剔父冗余 + 同父组），预览即结果。 */
  function previewRubberHits() {
    const band = rubberBand();
    if (!band) return;
    if (band.x1 - band.x0 < 8 || band.y1 - band.y0 < 8) return; // 误触量级不预览
    const hit = visibleNodeRects()
      .filter((r) => nodeSelectedBy(r, band))
      .map((r) => r.id);
    const res = trimSelection(hit); // 预览口径 = 落选口径
    const kept = new Set(res.kept);
    document.querySelectorAll('jmnode.mm-rubber-hit').forEach((el) => {
      const id = el.getAttribute('nodeid');
      if (!kept.has(id)) el.classList.remove('mm-rubber-hit');
    });
    kept.forEach((id) => {
      document.querySelectorAll('jmnode[nodeid="' + id + '"]').forEach((el) => {
        el.classList.add('mm-rubber-hit');
      });
    });
  }

  function clearRubberPreview() {
    document.querySelectorAll('jmnode.mm-rubber-hit').forEach((el) => {
      el.classList.remove('mm-rubber-hit');
    });
  }

  /** 矩形相交测试（框选命中） */
  function rectsIntersect(a, b) {
    return !(a.x + a.w < b.x0 || a.x > b.x1 || a.y + a.h < b.y0 || a.y > b.y1);
  }

  /** 框选命中判定（v0.16.4 参照业界口径修正）：
   *  通行做法（React Flow partialInclusion / draw.io Partial / GoJS）是
   *  "节点与选框任意重叠即选"，但思维导图节点密集、连线穿插，蹭边全选
   *  反而难用。采用 **中心点命中 + 过半面积命中** 双口径（draw.io 与
   *  Inkscape rubber band 的折中）：
   *    · 节点中心在框内 → 选（小框套节点主体的场景，手感最直接）；
   *    · 或节点被框覆盖的面积 ≥ 50% → 选（从边缘圈一大片的场景）。
   *  仅擦到一点边缘（<50% 且中心在外）→ 不选。 */
  function nodeSelectedBy(r, band) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const centerIn = cx >= band.x0 && cx <= band.x1 && cy >= band.y0 && cy <= band.y1;
    if (centerIn) return true;
    const ix = Math.max(0, Math.min(r.x + r.w, band.x1) - Math.max(r.x, band.x0));
    const iy = Math.max(0, Math.min(r.y + r.h, band.y1) - Math.max(r.y, band.y0));
    return (ix * iy) * 2 >= r.w * r.h; // 交集面积 ≥ 一半
  }

  /** 应用框选结果：选中集先做**范围筛选**（v0.16.5 语义），虚线框只包筛选后的
   *  实际生效集——虚线框、右键菜单、收起/展开从此基于同一口径。
   *  筛选两步（用户设计）：
   *    ① 剔父冗余：父节点也在选区的子节点剔除（父收起时它们本来就会折进去）；
   *    ② 同父约束：一次操作只针对同一父节点的节点 → 按组取**最浅层**一组
   *       （收起范围的外沿；例：[主题A, A的子, 跨主题的STA] → 只留 A）。
   *  返回 { kept, dropped } 供状态栏说明。 */
  function trimSelection(ids) {
    const jm = state.jm;
    if (!jm || !ids || !ids.length) return { kept: [], dropped: 0 };
    const set = new Set(ids);
    // ① 剔父冗余
    const eff = ids.filter((id) => {
      const n = jm.get_node(id);
      return n && n.parent && !set.has(n.parent.id);
    });
    // ② 按**直接父节点**分组（不是按树根！用户实测 bug 根因：wlan-01 与
    //    wlan-sta 同属一棵主题树，按树根分组会把跨主题节点错误并入一组）；
    //    组间取**平均深度最浅**的组（深度 = 到根的跳数，即收起范围的外沿）。
    //    例：[wlan-01(父wlan-book,深1), wlan-sta(父wlan-02,深2), …叶子们已剔]
    //    → 两组不同父 → 取 wlan-01 组（更浅）→ STA 被过滤。
    const groups = {};
    eff.forEach((id) => {
      const n = jm.get_node(id);
      const pid = n.parent.id;
      let depth = 0;
      let w = n;
      while (w && w.parent && !w.parent.isroot) { depth++; w = w.parent; }
      (groups[pid] = groups[pid] || { parentId: pid, ids: [], depthSum: 0 });
      groups[pid].ids.push(id);
      groups[pid].depthSum += depth;
    });
    const list = Object.values(groups).sort((a, b) =>
      (a.depthSum / a.ids.length) - (b.depthSum / b.ids.length)
      || b.ids.length - a.ids.length);
    const kept = list.length ? list[0].ids : eff;
    return { kept, dropped: ids.length - kept.length };
  }

  /** 应用框选结果：先筛选，再由虚线框包裹（含可见子树 = 折叠范围预告）。 */
  function applySelection(ids) {
    const res = trimSelection(ids || []);
    fdSelection = res.kept;
    refreshSelectionOutline();
    return { kept: res.kept.length, dropped: res.dropped };
  }

  /** 重算选区虚线框：跟随节点当前位置、大小自适应（不可见节点除外）。
   *  语义（v0.16.5）：框标注的范围 = **实际会被收起的范围** = 选中节点
   *  ∪ 它们**可见的子节点**（收起动作藏的正是这些子节点）。这样框选父节点
   *  时框就预告折叠范围，收起后收缩到父节点，展开再涨回（大小自适应）。 */
  function refreshSelectionOutline() {
    const el = ensureSelOutline();
    if (!fdSelection.length) { el.style.display = 'none'; return; }
    const jm = state.jm;
    const scope = new Set(fdSelection);
    // 把选中节点的**可见子节点**并入范围（折叠动作影响的就是它们）
    const addVisibleChildren = (id) => {
      const n = jm ? jm.get_node(id) : null;
      (n && n.children ? n.children : []).forEach((c) => {
        const cel = document.querySelector('jmnode[nodeid="' + c.id + '"]');
        if (cel && cel.offsetWidth > 0) {
          scope.add(c.id);
          addVisibleChildren(c.id); // 展开状态下子树整体可见 → 整棵都在折叠范围内
        }
      });
    };
    fdSelection.forEach(addVisibleChildren);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    scope.forEach((id) => {
      document.querySelectorAll('jmnode[nodeid="' + id + '"]').forEach((node) => {
        if (node.offsetWidth === 0 && node.offsetHeight === 0) return; // 不可见的不进框
        const p = nodeLogicalPos(node);
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + node.offsetWidth);
        maxY = Math.max(maxY, p.y + node.offsetHeight);
      });
    });
    if (minX === Infinity) { el.style.display = 'none'; return; }
    const pad = 14;
    el.style.left = (minX - pad) + 'px';
    el.style.top = (minY - pad) + 'px';
    el.style.width = (maxX - minX + pad * 2) + 'px';
    el.style.height = (maxY - minY + pad * 2) + 'px';
    el.style.display = 'block';
  }

  function clearSelection() {
    fdSelection = [];
    const el = document.getElementById(SEL_OUTLINE_ID);
    if (el) el.style.display = 'none';
    clearRubberPreview(); // 预览残留一并清
  }

  /** 选中集按父分组；取最大组（框选设计：一次操作只针对同一父节点的节点）。
   *  可传入 ids（默认用完整选区）。 */
  function selectionByParent(ids) {
    const jm = state.jm;
    if (!jm) return [];
    const list = ids || fdSelection;
    const groups = {};
    list.forEach((id) => {
      const n = jm.get_node(id);
      if (!n || !n.parent) return;
      const pid = n.parent.id;
      (groups[pid] = groups[pid] || []).push(id);
    });
    return Object.keys(groups)
      .map((pid) => ({ parentId: pid, ids: groups[pid] }))
      .sort((a, b) => b.ids.length - a.ids.length);
  }

  /* —— 框选右键菜单的操作实现 ——
   * 选区已在 applySelection 时做过范围筛选（剔父冗余 + 同父组），
   * fdSelection 即**实际生效集**，这里直接分组执行即可。 */

  /** 命中测试：屏幕坐标是否落在选区虚线框内（供 contextmenu 路由） */
  function selectionHitTest(clientX, clientY) {
    if (!fdSelection.length) return false;
    const el = document.getElementById(SEL_OUTLINE_ID);
    if (!el || el.style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  /** 拖动所选：选区即生效集（同父同树已由筛选保证——同父必同树），
   *  把它们所属的顶层树整体拖动（与"拖动树"同一机制）。 */
  function dragSelection() {
    const groups = selectionByParent();
    if (!groups.length) { setStatus('框选为空'); return; }
    const g = groups[0];
    const jm = state.jm;
    const trees = Array.from(new Set(g.ids.map((id) => treeRootOf(id)).filter(Boolean)));
    if (trees.length !== 1) {
      setStatus('所选节点跨 ' + trees.length + ' 棵主题树，拖动只支持同一棵树内的一组（已取消）', true);
      return;
    }
    setDragMode(true, trees[0]);
  }

  /** 收起所选：**只作用于被框选的节点**（jsMind 语义：收起 = 藏起它们的子节点）。
   *  fdSelection 已是筛选后的生效集，直接逐个折叠。 */
  function collapseSelection() {
    const jm = state.jm;
    if (!jm) return;
    const groups = selectionByParent();
    if (!groups.length) { setStatus('框选为空'); return; }
    const g = groups[0];
    let n = 0;
    g.ids.forEach((id) => {
      const node = jm.get_node(id);
      if (node && node.children && node.children.length) { jm.collapse_node(id); n++; }
    });
    refreshSelectionOutline();
    setStatus(n ? '已收起所选 ' + n + ' 个节点' : '所选节点没有可收起的子节点');
  }

  /** 展开所选：与收起同语义（逐个展开一层），展开后虚线框重算跟随。 */
  function expandSelection() {
    const jm = state.jm;
    if (!jm) return;
    const groups = selectionByParent();
    if (!groups.length) { setStatus('框选为空'); return; }
    const g = groups[0];
    let n = 0;
    g.ids.forEach((id) => {
      const node = jm.get_node(id);
      if (node && node.children && node.children.length) { jm.expand_node(id); n++; }
    });
    refreshSelectionOutline();
    setStatus(n ? '已展开所选 ' + n + ' 个节点' : '所选节点没有可展开的子节点');
  }

  /** nodeId 所在顶层主题树根（root 的直接子节点）；root 自身返回 null */
  function treeRootOf(nodeId) {
    const jm = state.jm;
    if (!jm) return null;
    let n = jm.get_node(nodeId);
    while (n && n.parent && !n.parent.isroot) n = n.parent;
    return (n && n.parent && n.parent.isroot && !n.isroot) ? n.id : null;
  }

  /** id 所属顶层主题树的偏移；不在偏移树或偏移为 0 时返回 null */
  function treeOffsetFor(id) {
    const jm = state.jm;
    if (!jm) return null;
    let n = jm.get_node(id);
    if (!n) return null;
    while (n && n.parent && !n.parent.isroot) n = n.parent;
    if (!n || n.isroot || !n.parent || !n.parent.isroot) return null;
    const o = treeOffsets[n.id];
    return (o && (o.x !== 0 || o.y !== 0)) ? o : null;
  }

  /** 把全部树偏移落到 DOM（节点 transform）；无偏移的顶层主题清空 transform 防残留 */
  function applyTreeOffsets() {
    const jm = state.jm;
    if (!jm) return;
    const rootNode = jm.get_node('root');
    const topics = (rootNode && rootNode.children) || [];
    topics.forEach((tp) => {
      const o = treeOffsets[tp.id];
      const t = (o && (o.x !== 0 || o.y !== 0)) ? 'translate(' + o.x + 'px,' + o.y + 'px)' : '';
      const ids = [];
      const walk = (n) => { ids.push(n.id); (n.children || []).forEach(walk); };
      walk(tp);
      ids.forEach((id) => {
        // jmexpander（折叠时的 +/− 号，nodeid 同为该节点）必须一起偏移，
        // 否则加减号留在原地、节点走了（用户反馈①）。jsMind 不写 expander 的
        // transform，relayout 后保留，无冲突。
        document.querySelectorAll('jmnode[nodeid="' + id + '"], jmexpander[nodeid="' + id + '"]')
          .forEach((el) => { el.style.transform = t; });
      });
    });
  }

  /** 清空全部树偏移（切换项目/撤销重做重建由 renderMind 调；还原视图也复位） */
  function clearTreeOffsets() {
    for (const k in treeOffsets) delete treeOffsets[k];
    applyTreeOffsets();
  }

  /* —— 拖动模式虚线框：用虚线框框住被选中的整棵树（用户反馈②）——
   * 框作为 jmnodes 子元素（jmnodes 在 fdView 变换层内 → 画布平移/缩放自动跟随）：
   *   · left/top/width/height = 树**未偏移**的可见包围盒（进入时算一次，折叠状态
   *     在拖动中不会变，避免 mousemove 每帧重算）；
   *   · transform = 当前树偏移 translate（syncTreeOutline，拖动中更新）
   *     → 视觉上始终框住移动后的树。
   * pointer-events:none：纯视觉，不拦截任何鼠标事件。 */
  const TREE_OUTLINE_ID = 'tree-drag-outline';
  const OUTLINE_PAD = 14;

  function collectTreeIds(tp) {
    const ids = [];
    const walk = (n) => { ids.push(n.id); (n.children || []).forEach(walk); };
    walk(tp);
    return ids;
  }

  /** 目标树可见元素（jmnode + jmexpander）的未偏移逻辑包围盒 {left,top,width,height} */
  function computeTreeBounds(treeRootId) {
    const jm = state.jm;
    if (!jm) return null;
    const tp = jm.get_node(treeRootId);
    if (!tp) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;
    collectTreeIds(tp).forEach((id) => {
      document.querySelectorAll('jmnode[nodeid="' + id + '"], jmexpander[nodeid="' + id + '"]')
        .forEach((el) => {
          // 折叠/隐藏元素：display:none 时 offsetWidth/Height 为 0，跳过（不污染包围盒）
          if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
          const x = parseFloat(el.style.left || '0');
          const y = parseFloat(el.style.top || '0');
          found = true;
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + el.offsetWidth);
          maxY = Math.max(maxY, y + el.offsetHeight);
        });
    });
    if (!found) return null;
    return {
      left: minX - OUTLINE_PAD, top: minY - OUTLINE_PAD,
      width: maxX - minX + OUTLINE_PAD * 2, height: maxY - minY + OUTLINE_PAD * 2
    };
  }

  function ensureTreeOutline() {
    let box = document.getElementById(TREE_OUTLINE_ID);
    if (box) return box;
    const jmnodes = document.querySelector('jmnodes');
    if (!jmnodes) return null;
    box = document.createElement('div');
    box.id = TREE_OUTLINE_ID;
    jmnodes.appendChild(box);
    return box;
  }

  /** 进入拖动模式：按当前布局计算包围盒并显示（每次进入重算，覆盖折叠状态变化） */
  function showTreeOutline(treeRootId) {
    const box = ensureTreeOutline();
    if (!box) return;
    const b = computeTreeBounds(treeRootId);
    if (!b) { box.style.display = 'none'; return; }
    box.style.left = b.left + 'px';
    box.style.top = b.top + 'px';
    box.style.width = b.width + 'px';
    box.style.height = b.height + 'px';
    box.style.display = 'block';
    syncTreeOutline();
  }

  /** 拖动中：框 transform 跟随树偏移（包围盒不变，只更新 transform） */
  function syncTreeOutline() {
    const box = document.getElementById(TREE_OUTLINE_ID);
    if (!box || !fdDragTreeRoot) return;
    const o = treeOffsets[fdDragTreeRoot];
    box.style.transform = (o && (o.x !== 0 || o.y !== 0))
      ? 'translate(' + o.x + 'px,' + o.y + 'px)' : '';
  }

  function hideTreeOutline() {
    const box = document.getElementById(TREE_OUTLINE_ID);
    if (box) box.style.display = 'none';
  }

  /** 进入/退出拖动模式（toggle 由菜单项调用）。treeRootId 为锁定的目标树根（顶层主题）。 */
  function setDragMode(on, treeRootId) {
    fdDragMode = !!on;
    fdDragTreeRoot = fdDragMode ? (treeRootId || null) : null;
    const panel = fdPanel();
    if (panel) panel.style.cursor = fdDragMode ? 'grab' : '';
    document.body.classList.toggle('mm-dragmode', fdDragMode);
    let topic = '';
    if (fdDragTreeRoot) {
      const jm = state.jm;
      const n = jm && jm.get_node(fdDragTreeRoot);
      topic = n ? n.topic : '';
    }
    setStatus(fdDragMode
      ? (fdDragTreeRoot
          ? '拖动模式：按住左键拖动移动「' + topic + '」树，其他树不动（右键 / Esc 退出）'
          : '拖动模式：按住左键拖动平移画布（Esc 退出）')
      : '已退出拖动模式');
    // 虚线框：进入（且锁定了目标树）→ 显示并框住整棵树；退出 → 隐藏
    if (fdDragMode && fdDragTreeRoot) showTreeOutline(fdDragTreeRoot);
    else hideTreeOutline();
    return fdDragMode;
  }

  /** 当前是否处于拖动模式（供菜单项切换文案与冒烟断言读取） */
  function dragModeActive() { return fdDragMode; }

  /** 拖动模式锁定的目标树根 id（无目标时为 null，供冒烟断言读取） */
  function getDragTreeRoot() { return fdDragTreeRoot; }

  /** 视口交互：滚轮缩放（指针锚点）+ 中键平移（无界）+ 拖动模式左键平移 +
   *  吸收残留滚动。全局只绑一次，每次操作都通过 state.jm / fdPanel() 取当前实例，
   *  避免重复建图时重复注册。 */
  function bindViewportControls() {
    if (fdViewportBound) return;
    fdViewportBound = true;

    document.addEventListener('wheel', (e) => {
      const cont = document.getElementById('mindmap-container');
      if (!cont || !cont.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.float-detail')) return; // 详情框内滚轮归详情框
      e.preventDefault();
      e.stopPropagation();
      const cr = cont.getBoundingClientRect();
      const px = e.clientX - cr.left, py = e.clientY - cr.top;
      // 步长 0.1（与 jsMind 语义一致），但锚点/位置全由统一 transform 承担
      const target = Math.max(0.15, Math.min(4, fdView.s + (e.deltaY < 0 ? 0.1 : -0.1)));
      zoomViewAt(px, py, target / fdView.s, 0.15, 4);
      positionFloatDetail();
    }, { capture: true, passive: false });

    document.addEventListener('mousedown', (e) => {
      const cont = document.getElementById('mindmap-container');
      if (!cont || !cont.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.float-detail')) return;
      // 框选：主界面空白处左键按下 = 开始框选（节点上按下不算——那是选中/详情）。
      // 已有选区时点击**框外**（空白或节点）→ 先清除选区再按普通逻辑走。
      if (e.button === 0 && !fdDragMode && !fdSelection.length
        && (e.target.tagName === 'JMNODES' || e.target.tagName === 'CANVAS'
          || (e.target.closest && e.target.closest('jmnodes, canvas.jsmind')))) {
        const pt = panelPoint(e.clientX, e.clientY);
        fdRubber = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
        const el = ensureRubberEl();
        el.style.display = 'block';
        e.preventDefault();
        return;
      }
      if (e.button === 0 && fdSelection.length && !fdDragMode) {
        // 点击框外（空白/其他节点）→ 清除选区（点击框内节点不清，供右键菜单用）
        const inside = fdSelection.some((id) => {
          const n = document.querySelector('jmnode[nodeid="' + id + '"]');
          return n && n.contains(e.target);
        });
        if (!inside) clearSelection();
      }
      // 拖动模式：左键按住 = 拖动目标树（有 fdDragTreeRoot 时）或平移画布（兜底）。
      // preventDefault+stopPropagation 阻止 jsMind select / 后续 click，
      // 纯视图工具语义；Esc 退出后恢复正常点击
      if (e.button === 0 && fdDragMode) {
        e.preventDefault();
        e.stopPropagation();
        const panel = fdPanel();
        if (fdDragTreeRoot) {
          const o = treeOffsets[fdDragTreeRoot] || (treeOffsets[fdDragTreeRoot] = { x: 0, y: 0 });
          fdTreeDragStart = { x: e.clientX, y: e.clientY, ox: o.x, oy: o.y };
        } else {
          fdDragModePan = { x: e.clientX, y: e.clientY, px: fdView.x, py: fdView.y };
        }
        if (panel) panel.style.cursor = 'grabbing';
        document.body.classList.add('mm-dragging'); // CSS: 全画布 cursor:grabbing
        return;
      }
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const panel = fdPanel();
      fdPanning = { x: e.clientX, y: e.clientY, px: fdView.x, py: fdView.y };
      if (panel) panel.style.cursor = 'grabbing';
      document.body.classList.add('panning');
    }, true);

    document.addEventListener('mousemove', (e) => {
      // 框选拖拽：橡皮筋实时跟随 + **实时命中预览**（业界 realtime:true 口径）：
      // 拖动过程中即时计算当前会命中的节点并临时加虚线视觉，松手才真正落选。
      if (fdRubber) {
        e.preventDefault();
        const pt = panelPoint(e.clientX, e.clientY);
        fdRubber.x1 = pt.x; fdRubber.y1 = pt.y;
        const el = ensureRubberEl();
        if (el) {
          const x = Math.min(fdRubber.x0, fdRubber.x1);
          const y = Math.min(fdRubber.y0, fdRubber.y1);
          el.style.left = x + 'px';
          el.style.top = y + 'px';
          el.style.width = Math.abs(fdRubber.x1 - fdRubber.x0) + 'px';
          el.style.height = Math.abs(fdRubber.y1 - fdRubber.y0) + 'px';
        }
        previewRubberHits();
        return;
      }
      if (fdTreeDragStart) {
        e.preventDefault();
        const s = fdView.s || 1;
        const o = treeOffsets[fdDragTreeRoot] || (treeOffsets[fdDragTreeRoot] = { x: 0, y: 0 });
        o.x = fdTreeDragStart.ox + (e.clientX - fdTreeDragStart.x) / s;
        o.y = fdTreeDragStart.oy + (e.clientY - fdTreeDragStart.y) / s;
        applyTreeOffsets();
        syncTreeOutline(); // 虚线框 transform 跟随树偏移
        refreshSelectionOutline(); // 框选虚线框同样跟随（节点含树偏移）
        const jm = state.jm;
        if (jm && jm.view && typeof jm.view.show_lines === 'function') {
          try { jm.view.show_lines(); } catch (err) { /* 忽略重画异常 */ }
        }
        syncFdBoxes();
        return;
      }
      if (fdDragModePan) {
        e.preventDefault();
        fdView.x = fdDragModePan.px + (e.clientX - fdDragModePan.x);
        fdView.y = fdDragModePan.py + (e.clientY - fdDragModePan.y);
        fdApplyView();
        syncFdBoxes();
        return;
      }
      if (!fdPanning) return;
      e.preventDefault();
      fdView.x = fdPanning.px + (e.clientX - fdPanning.x);
      fdView.y = fdPanning.py + (e.clientY - fdPanning.y);
      fdApplyView();
      syncFdBoxes();
    });

    document.addEventListener('mouseup', () => {
      // 框选收尾：中心点/过半面积命中的可见节点入选（与预览同口径）
      if (fdRubber) {
        const band = rubberBand();
        fdRubber = null;
        const el = ensureRubberEl();
        if (el) el.style.display = 'none';
        clearRubberPreview();
        // 太小的拖拽（<8px）视为误触/点击 → 清选区不框
        if (!band || band.x1 - band.x0 < 8 || band.y1 - band.y0 < 8) { clearSelection(); return; }
        const hit = visibleNodeRects()
          .filter((r) => nodeSelectedBy(r, band))
          .map((r) => r.id);
        const res = applySelection(hit);
        if (!hit.length) setStatus('框选为空');
        else if (res.dropped > 0) {
          setStatus('已框选 ' + res.kept + ' 个节点（另有 ' + res.dropped
            + ' 个跨父/已被包含的节点被过滤；右键框内可拖动/收起/展开）');
        } else {
          setStatus('已框选 ' + res.kept + ' 个节点（右键框内可拖动/收起/展开）');
        }
        return;
      }
      if (fdTreeDragStart) {
        fdTreeDragStart = null;
        const panel = fdPanel();
        if (panel && fdDragMode) panel.style.cursor = 'grab'; // 拖完回到可拖动光标
        document.body.classList.remove('mm-dragging');
        return;
      }
      if (fdDragModePan) {
        fdDragModePan = null;
        const panel = fdPanel();
        if (panel && fdDragMode) panel.style.cursor = 'grab'; // 拖完回到可拖动光标
        document.body.classList.remove('mm-dragging');
        return;
      }
      if (!fdPanning) return;
      fdPanning = null;
      const panel = fdPanel();
      if (panel) panel.style.cursor = '';
      document.body.classList.remove('panning');
    });

    // Esc 退出拖动模式（capture + stopImmediatePropagation，优先于命令面板/审计的 Esc）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fdDragMode) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDragMode(false);
      }
    }, true);

    // 拖动模式下左键点击节点/空白不产生 jsMind 选中与详情副作用（纯平移工具）。
    // 精确限定目标为导图节点层，不误伤菜单/面板/详情框内的点击。
    document.addEventListener('click', (e) => {
      if (!fdDragMode) return;
      const t = e.target;
      if (!t) return;
      if (t.closest && t.closest('.float-detail, #ctx-menu, #palette, #audit-panel, .overlay, .lightbox')) return;
      if (t.tagName === 'JMNODES' || t.tagName === 'JMNODE' || t.tagName === 'CANVAS'
        || (t.closest && t.closest('jmnodes, jmnode, canvas.jsmind'))) {
        e.stopPropagation();
      }
    }, true);

    // jsMind 内部动作残留的滚动一律归零（平移只由 transform 负责）
    document.addEventListener('scroll', () => {
      neutralizeScroll();
      if (!fdDrag && !fdResize) syncFdBoxes();
    }, true);
  }

  /** 用平移把根节点摆到面板正中（先应用当前缩放/平移，再据真实矩形测量） */
  function centerOnRoot() {    if (!state.jm) return;
    neutralizeScroll();
    fdApplyView(); // 先让当前 fdView（含最新 s）落到 DOM，否则测量的是旧缩放下的矩形
    const p = fdPanel();
    const nodeEl = document.querySelector('#jsmind_container jmnode[nodeid="root"]');
    if (!p || !nodeEl) return;
    const nr = nodeEl.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    fdView.x += (pr.left + pr.width / 2) - (nr.left + nr.width / 2);
    fdView.y += (pr.top + pr.height / 2) - (nr.top + nr.height / 2);
    fdApplyView();
  }

  /* —— 主题模式：让顶层主题互相独立 ——
   * 数据仍是单根树，但把根当「容器」：隐藏其方框、标题转角标，并在绘制连线时
   * 精确跳过「父节点是根」的那些线（按节点父子关系判定，不猜坐标）。 */

  function fdIsThemeMode(data) {
    return !!(data && data.meta && data.meta.rootMode === 'themes');
  }

  /** 当前是否处于主题模式（供外部/自检读取） */
  function isThemeMode() { return fdHideRootLinks; }

  /**
   * 节点**实际边框**（e_panel 逻辑坐标，已含 view offset 与所属树偏移）——连线端点的唯一真源。
   * 直接读 jmnode 的 style.left/top（jsMind 写的左上角、含 view offset）+ offsetWidth/Height
   * （transform 不影响布局尺寸，树偏移走 transform，故拖动时读取不触发 reflow），
   * **不依赖** get_node_point_in/out 的布局 pin 缓存。
   * 因而节点被任意移动（改 left/top 或 transform）后，show_lines 重算即精确跟随，
   * 为后续「移动单个 / 所有节点」功能奠基。
   * 返回 {left,right,top,bottom,cx,cy}；cx/cy 为边框中心。
   */
  function nodeBorderRect(el, treeId) {
    const to = treeOffsetFor(treeId);
    const tx = to ? to.x : 0, ty = to ? to.y : 0;
    const x = parseFloat(el.style.left || '0') + tx;
    const y = parseFloat(el.style.top || '0') + ty;
    const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
    return { left: x, right: x + w, top: y, bottom: y + h, cx: x + w / 2, cy: y + h / 2 };
  }

  /** 重写 jsMind 的连线绘制：复刻其原实现，仅额外跳过 parent 为根的线，
   *  并按「所属顶层主题树」的树偏移移动线两端（拖动树：只移目标树，其他树不动）。
   *  只重画 canvas 上的线、绝不触碰节点 DOM（区别于曾导致节点全消失的 view.reset()）。
   *  注意：get_node_point_in/out 返回带 _offset_/_pout_ 缓存的复用对象，
   *  改坐标前必须拷贝，否则会污染布局缓存导致后续布局错乱。 */
  function installRootLineOverride(jm) {
    const view = jm.view;
    window.__mmSkippedLines = 0;
    view.show_lines = function () {
      const nodes = this.jm.mind.nodes;
      const HM = this.opts.hmargin, VM = this.opts.vmargin;
      window.__mmSkippedLines = 0;
      // 第一遍：线端 = 父子节点**相邻侧边框中点**。直接读节点实际 DOM 边框（nodeBorderRect，
      // 已含 view offset 与树偏移），**不再用** get_node_point_in/out 布局缓存、也不再加 off。
      const lines = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id in nodes) {
        const t = nodes[id];
        if (t.isroot) continue;
        if (!this.layout.is_visible(t)) continue;
        if (fdHideRootLinks && t.parent && t.parent.isroot) { window.__mmSkippedLines += 1; continue; }
        const parentEl = document.querySelector('jmnode[nodeid="' + t.parent.id + '"]');
        const childEl = document.querySelector('jmnode[nodeid="' + t.id + '"]');
        if (!parentEl || !childEl) continue;
        const pb = nodeBorderRect(parentEl, t.parent.id);
        const cb = nodeBorderRect(childEl, t.id);
        let px, py, cx, cy;
        if (cb.cx < pb.cx) {            // 子在父左：父端=左边框中点，子端=右边框中点
          px = pb.left; py = pb.cy; cx = cb.right; cy = cb.cy;
        } else {                         // 子在父右：父端=右边框中点，子端=左边框中点
          px = pb.right; py = pb.cy; cx = cb.left; cy = cb.cy;
        }
        lines.push({ parent: t.parent.id, child: t.id, px, py, cx, cy,
          color: t.data && t.data['leading-line-color'] });
        if (px < minX) minX = px; if (cx < minX) minX = cx;
        if (py < minY) minY = py; if (cy < minY) minY = cy;
        if (px > maxX) maxX = px; if (cx > maxX) maxX = cx;
        if (py > maxY) maxY = py; if (cy > maxY) maxY = cy;
      }
      // 暴露线端真源（e_panel 逻辑坐标）：供 AI/断言核对「线端 == 节点边框中点」、移动后跟随
      window.__mmLineEndpoints = lines.map((L) => ({ parent: L.parent, child: L.child,
        p: { x: L.px, y: L.py }, c: { x: L.cx, y: L.cy } }));
      const gel = this.graph.element();
      if (!lines.length) {
        gel.dataset.ox = ''; gel.dataset.oy = '';
        gel.style.left = '0px'; gel.style.top = '0px';
        this.clear_lines();
        fdApplyView();
        return;
      }
      // 连线层（canvas/svg）逻辑原点（s=1 空间，可为负）与位图尺寸包住包围盒。
      // 原点**不**用 style.left/top（布局值不随 scale，zoom 会与节点错位 ox*(1-s)），
      // 而是存入 dataset.ox/oy，由 fdApplyView 并入 transform 的 translate 并随 s 缩放：
      // 线屏幕 = ox*s + (e_panel-ox)*s + fdView.x = e_panel*s + fdView.x，与节点恒对齐。
      // 位图尺寸量化 20px 网格：拖动中多数帧只重画、不重设位图（canvas 重设 width 开销大）。
      const GRID = 20;
      const ox = Math.floor((minX - HM) / GRID) * GRID;
      const oy = Math.floor((minY - VM) / GRID) * GRID;
      const cw = Math.ceil((maxX - minX + 2 * HM) / GRID) * GRID;
      const ch = Math.ceil((maxY - minY + 2 * VM) / GRID) * GRID;
      gel.dataset.ox = ox; gel.dataset.oy = oy;
      gel.style.left = '0px'; gel.style.top = '0px';
      if (this.graph.size.w !== cw || this.graph.size.h !== ch) this.graph.set_size(cw, ch);
      this.clear_lines(); // canvas: 清新位图；svg: 移除旧 path（set_size 不清 svg）
      // 内部坐标 = e_panel 坐标 - 逻辑原点；屏幕对齐由 fdApplyView 的 transform 保证。
      for (const L of lines) {
        this.graph.draw_line( // draw_line(父端, 子端, offset, color)
          { x: L.px - ox, y: L.py - oy },
          { x: L.cx - ox, y: L.cy - oy },
          { x: 0, y: 0 }, L.color
        );
      }
      fdApplyView();
    };
  }

  /** 隐藏/显示容器根方框 + 角标，并重绘连线（安全，只动 canvas） */
  function applyRootModeVisual(jm, themed) {
    fdHideRootLinks = themed;
    window.__mmSkippedLines = 0;
    const rootEl = document.querySelector('#jsmind_container jmnode[nodeid="root"]');
    if (rootEl) rootEl.classList.toggle('mm-container-root', themed);
    const cont = document.getElementById('mindmap-container');
    let label = document.getElementById('mm-root-label');
    if (themed && cont && jm) {
      if (!label) {
        label = document.createElement('div');
        label.id = 'mm-root-label';
        cont.appendChild(label);
      }
      label.textContent = (jm.get_node('root') || {}).topic || '';
      label.style.display = '';
    } else if (label) {
      label.style.display = 'none';
    }
    if (jm && jm.view && typeof jm.view.show_lines === 'function') {
      try { jm.view.show_lines(); } catch (e) { /* 忽略 */ }
    }
  }

  /** 依项目 meta.layout 应用顶层主题左右分侧（渲染时、jm.show 之前调用）。
   *  jsMind 原生从数据读「root 直接子节点」的 direction 字段（left/right）做左右分侧
   *  （见 _extract_subnode：root 的孩子 direction==='left' 走左布局，其余默认右）。
   *  meta.layout 只记「哪些主题在左/右」，未列出的主题保持 jsMind 默认（右侧）。
   *  序列化走 serializeTree 的自建 walk，不携带 direction —— 方向以 meta.layout 为唯一真源。 */
  function applyThemeLayout(data) {
    const layout = data && data.meta && data.meta.layout;
    if (!layout || !data.data || !Array.isArray(data.data.children)) return;
    const left = new Set(Array.isArray(layout.left) ? layout.left : []);
    const right = new Set(Array.isArray(layout.right) ? layout.right : []);
    data.data.children.forEach((c) => {
      if (left.has(c.id)) c.direction = 'left';
      else if (right.has(c.id)) c.direction = 'right';
    });
  }

  /** 依项目 meta 应用主题模式（渲染时调用） */
  function applyRootMode(jm, data) {
    const themed = fdIsThemeMode(data);
    state.rootMode = themed ? 'themes' : 'tree';
    applyRootModeVisual(jm, themed);
  }

  /** 切换主题模式（立即生效：方框显隐 + 连线重画） */
  function setRootMode(mode) {
    const jm = state.jm;
    if (!jm) { setStatus('导图尚未就绪'); return; }
    const want = mode === 'themes' ? 'themes' : 'tree';
    if (state.rootMode === want) { setStatus('已是该模式'); return; }
    state.rootMode = want;
    applyRootModeVisual(jm, want === 'themes');
    save(); // 持久化 meta.rootMode（serializeTree 会带上它）
    setStatus(want === 'themes'
      ? '已开启主题模式：容器根已隐藏，各顶层主题互相独立'
      : '已恢复单中心模式：中心节点重新显示');
  }

  /** 还原视图：把根节点重新居中（纯平移，不依赖滚动范围），并复位所有树偏移 */
  function resetView() {
    if (!state.jm) { setStatus('导图尚未就绪'); return; }
    fdView.s = 1;                       // 缩放回到 100%
    const jm = state.jm;
    if (jm && jm.view) jm.view.zoom_current = 1;
    neutralizeScroll();
    clearTreeOffsets();                 // 拖动树造成的树偏移一并复位（还原 = 回到初始）
    centerOnRoot();                     // 再把根节点居中
    syncFdBoxes();
    setStatus('已还原视图：100% 缩放，根节点居中');
  }

  function expandAll() { const jm = state.jm; if (jm) { jm.expand_all(); setStatus('已全部展开'); } }
  /** 收起（v0.16.2 修复）：jm.collapse_all() 会把 root 也折叠 → 容器根隐藏后
   *  什么都看不到（用户实测）。改为只收起**顶层主题**（root 保持展开），
   *  即"收起到树根"：主题的孙辈及以下全部收进主题节点。 */
  function collapseAll() {
    const jm = state.jm;
    if (!jm) return;
    const root = jm.get_node('root');
    let n = 0;
    (root.children || []).forEach((tp) => {
      if (jm.get_node(tp.id).children && jm.get_node(tp.id).children.length) {
        jm.collapse_node(tp.id);
        n++;
      }
    });
    setStatus(n ? '已收起到树根（' + n + ' 个主题）' : '没有可收起的主题');
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const save = () => MM.save();
  const positionFloatDetail = () => MM.positionFloatDetail();
  const syncFdBoxes = () => MM.syncFdBoxes();

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.fdPanel = fdPanel;
  MM.fdQ = fdQ;
  MM.fdScrollHost = fdScrollHost;
  MM.fdViewEls = fdViewEls;
  MM.fdApplyView = fdApplyView;
  MM.neutralizeScroll = neutralizeScroll;
  MM.zoomViewAt = zoomViewAt;
  MM.setViewScale = setViewScale;
  MM.getPanState = getPanState;
  MM.setDragMode = setDragMode;
  MM.dragModeActive = dragModeActive;
  MM.getDragTreeRoot = getDragTreeRoot;
  MM.treeRootOf = treeRootOf;
  MM.applyTreeOffsets = applyTreeOffsets;
  MM.clearTreeOffsets = clearTreeOffsets;
  MM.computeTreeBounds = computeTreeBounds;
  MM.showTreeOutline = showTreeOutline;
  MM.syncTreeOutline = syncTreeOutline;
  MM.hideTreeOutline = hideTreeOutline;
  MM.clearSelection = clearSelection;
  MM.applySelection = applySelection;
  MM.refreshSelectionOutline = refreshSelectionOutline;
  MM.nodeSelectedBy = nodeSelectedBy; // 冒烟断言用（纯几何判定）
  MM.getSelection = () => ({
    count: fdSelection.length,
    ids: fdSelection.slice(),
    groups: selectionByParent()
  });
  MM.hasSelection = () => fdSelection.length > 0;
  MM.selectionHitTest = selectionHitTest;
  MM.dragSelection = dragSelection;
  MM.collapseSelection = collapseSelection;
  MM.expandSelection = expandSelection;
  MM.bindViewportControls = bindViewportControls;
  MM.centerOnRoot = centerOnRoot;
  MM.fdIsThemeMode = fdIsThemeMode;
  MM.isThemeMode = isThemeMode;
  MM.nodeBorderRect = nodeBorderRect;
  MM.installRootLineOverride = installRootLineOverride;
  MM.applyRootModeVisual = applyRootModeVisual;
  MM.applyThemeLayout = applyThemeLayout;
  MM.applyRootMode = applyRootMode;
  MM.setRootMode = setRootMode;
  MM.resetView = resetView;
  MM.expandAll = expandAll;
  MM.collapseAll = collapseAll;
})();
