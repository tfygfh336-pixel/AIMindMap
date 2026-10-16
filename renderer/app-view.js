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

  /** 变换作用对象：jsMind 的连线 canvas 与节点层（两者同变换，线与节点永不错位）
   *  ＋ 关联节点可视化层（app-related.js 的 SVG，`#mm-rel-layer`，按需创建）——
   *  挂进来它就跟着同一个 translate+scale 走 ⇒ 平移/缩放**零重算**（functional 2 的核心便利 ✓） */
  function fdViewEls() {
    const p = fdPanel();
    if (!p) return [];
    return ['canvas.jsmind', '#mm-rel-layer', 'jmnodes', '#mm-rel-hit-layer']
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

  /* ================= 重排时钉住"你点的那个节点"（展开/收起不再跳） =================
   * 病象（用户反馈"展开折叠导致页面跳来跳去"，已量化）：探针实测收起一个大子树时，
   * 节点**布局坐标**位移 −564.5px、屏幕位移 −565px；真实项目里更大的子树能到 −6757px。
   *
   * 机制（vendor/jsmind.js 读出来的）：jsMind 的布局是"**每个父节点把自己的子节点栈居中**"
   *   `layout_offset(){ … r.offset_y = a - s/2 … ; for (… ) o._data.layout.offset_y += l; }`
   * 再叠加原点 `get_view_offset(){ x:(面板宽-bounds.e-bounds.w)/2, y:面板高/2 }`。
   * ⇒ 展开/收起改变包围盒与各层子栈高度 ⇒ **每个父节点的子节点都要重新居中** ⇒ 位移是
   *   **非等量**的（实测：主题A 位移 −565px、主题B −1406px）。所以"钉住原点"无效（试过），
   *   "整棵树会等量平移"也是错的（我最初的判断）—— 只有**钉住具体某个节点**才对。
   *
   * 做法：包住 `view.relayout()`（jsMind 重排的**唯一入口**），在**调用前后**量同一个节点的
   * 布局坐标（`style.left/top`，天然不含变换），把差值按当前缩放换算成屏幕位移补进 fdView。
   * 为什么这次能避开上一版的坑：
   *   · 上一版在节点层 MutationObserver 里做，**分不清**"布局变了"和"用户在平移/缩放"，
   *     于是把用户的平移当成布局位移纠正掉（实测位移 = −平移×缩放）。
   *   · 本版只在**重排函数被调用的那一刻**测量 ⇒ 用户平移/缩放根本不经过这里，不可能被误判。
   * 锚点：本次操作的那个节点（`expand_node/collapse_node` 的入参，由 wrapLayoutAnchor 记录），
   *   退化到"第一个可见顶层主题"（主题模式下容器根是隐藏的，不能用它）。 */
  let layoutAnchorId = '';

  function layoutPos(el) {
    const lx = parseFloat(el.style && el.style.left);
    const ly = parseFloat(el.style && el.style.top);
    if (!isFinite(lx) || !isFinite(ly)) return null;
    return [lx, ly];
  }

  function anchorNodeEl(jm) {
    const panel = fdPanel();
    if (!panel) return null;
    const byId = (id) => (id ? panel.querySelector('jmnode[nodeid="' + id + '"]') : null);
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
    const picked = byId(layoutAnchorId);
    if (visible(picked)) return picked;
    const tops = (jm && jm.mind && jm.mind.root && jm.mind.root.children) || [];
    for (const t of tops) { const el = byId(t.id); if (visible(el)) return el; }
    return null;
  }

  /** 安装"重排锚点保持"。每个 jm 实例一次；`__unwrapAnchor` 供断言做判别力证明 */
  function wrapLayoutAnchor(jm) {
    const view = jm && jm.view;
    if (!view || typeof view.relayout !== 'function' || view.__anchorWrapped) return false;
    const origRelayout = view.relayout;
    view.relayout = function () {
      const el = anchorNodeEl(jm);
      const before = el ? layoutPos(el) : null;
      const r = origRelayout.apply(this, arguments);
      if (el && before) {
        const after = layoutPos(el);
        if (after) {
          const dx = after[0] - before[0], dy = after[1] - before[1];
          if (dx || dy) {
            // 屏幕位移 = 布局位移 × 当前缩放（视图变换只负责平移缩放，不参与布局）
            fdView.x -= dx * fdView.s;
            fdView.y -= dy * fdView.s;
            fdApplyView();
            // 诊断留痕（供断言取证）：最近 8 次补偿 —— **只放数字**，避免 JSON 轮转炸掉
            //（曾把 DOM/数组塞进来，冒烟直接 "Converting circular structure to JSON"）
            window.__anchorLog = (window.__anchorLog || [])
              .concat([[dx, dy, fdView.s, Math.round(fdView.x), Math.round(fdView.y)]])
              .slice(-8);
          }
        }
      }
      // ⚠️ 重排会**重建节点元素**（折叠/展开时 jsMind 为新可见节点建 DOM）⇒ 元素上的
      // 「树偏移」transform 随旧元素一起丢 ⇒ 那棵树看着散架。relayout 是 jsMind 重排的
      // **唯一入口**，在这里补一次重施即可（无偏移时是空跑，零成本 ✓）。
      applyTreeOffsets();
      return r;
    };
    view.__anchorWrapped = true;
    view.__unwrapAnchor = function () { view.relayout = origRelayout; view.__anchorWrapped = false; };
    // 记录"这次操作的是哪个节点"，让锚点＝用户刚点的那个（jsMind 自己的 +/- 按钮也走这里）
    ['expand_node', 'collapse_node'].forEach((m) => {
      const orig = jm[m];
      if (typeof orig !== 'function') return;
      jm[m] = function (id) {
        if (id) layoutAnchorId = id;
        return orig.apply(this, arguments);
      };
    });
    return true;
  }

  /** 重建/切换项目时调用：新树换了元素，锚点作废 */
  function resetLayoutAnchor() { layoutAnchorId = ''; }

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

  /** **精确**设置整个视图变换（缩放 + 平移），供"缩放到刚好框住这些节点"这类需求用。
   *  为什么必须有它：既有的 `setViewScale` 只围绕面板中心按倍率缩放，`zoomViewAt` 只做锚点缩放
   *  —— 两者都表达不了"我要 (s,x,y) 这**一个**目标值"（功能 2 的 fit 需要的正是后者）。
   *  语义：屏幕坐标 = 逻辑坐标 × s + (x,y)，与 fdApplyView 完全一致；范围夹取 0.15–4（与滚轮缩放同区间）。 */
  function setViewTransform(t) {
    if (!t) return getPanState();
    const s = Math.max(0.15, Math.min(4, Number(t.s) || fdView.s));
    if (typeof t.x === 'number' && isFinite(t.x)) fdView.x = t.x;
    if (typeof t.y === 'number' && isFinite(t.y)) fdView.y = t.y;
    fdView.s = s;
    const jm = state.jm;
    if (jm && jm.view) jm.view.zoom_current = s; // 仅用于读数（同 setViewScale）
    neutralizeScroll();
    fdApplyView();
    return getPanState();
  }

  /** 当前平移量（供外部/自检读取） */
  function getPanState() { return { x: fdView.x, y: fdView.y, s: fdView.s }; }

  let fdViewportBound = false;
  let fdPanning = null;

  /* —— 拖动树 / 拖动子树（右键菜单入口，v0.15 起；R2 期 1 扩到节点级）——
   * 语义：**只移动目标子树**（顶层主题树，或某个更深的节点及其后代），其他节点不动。
   * 实现：
   *   · 子树偏移 treeOffsets[**任意节点id**] = {x, y}（逻辑画布坐标，与 fdView 同一坐标空间；
   *     经 fdView 父层 scale 放大成屏幕位移 → 缩放时相对位置保持）。
   *     ⚠️ 键域是"**偏移根**"：顶层主题（如「802.11 无线网络」）与更深的节点都能当根；
   *     一个节点最多有一个偏移根（它自己 or 某个祖先），累计值见 treeOffsetFor。
   *   · 节点：目标子树全部 jmnode 设 style.transform = translate(累计偏移)
   *     （jsMind 只写 left/top、不设 transform，故无冲突；重布局/缩放后保留）。
   *     jsMind 的节点是**平铺的兄弟元素**（不相嵌套）⇒ 每个元素各带自己的 transform，
   *     祖先的偏移不会自动传给后代 —— 所以"累计"这件事必须由我们自己算（treeOffsetFor）。
   *   · 连线：canvas 整张重画，show_lines override 里按**同一个**累计偏移改线两端
   *     （其他节点的线坐标不变 → 视觉上只有目标子树移动）。
   * 纯视图操作：不产生脏数据、不进撤销栈；偏移本身**会随项目保存**（meta.themeOffsets /
   * meta.nodeOffsets，见 serializeTree），renderMind 重建时清空再按数据恢复。 */
  const treeOffsets = {};        // { [偏移根 id]: {x, y} }（键域 = 任意节点，root 除外）
  let fdDragMode = false;
  let fdDragTreeRoot = null;     // 拖动模式锁定的目标子树根（顶层主题 id，或任意节点 id）
  let fdTreeDragStart = null;
  /* 【R2 期 3 · e】同级重排拖动：`fdReorderRoot` 非空 ⇒ 这一次拖动改的是**同级上下序**，
   *  **不动偏移桶一点**（所以"拖动期间序列化文本逐字节不变 + 盘上零写入"是构造性的，
   *  不是靠"记得别写"）—— 拖动期间只有**副本元素**（`#tree-reorder-ghost`）跟着指针走。 */
  let fdDragKind = 'move';       // 'move'（动位置，写 meta.*Offsets）/ 'reorder'（改同级上下序）/ 'reparent'（期 4 · f，改父子关系）
  let fdReorderRoot = null;      // 重排拖动锁定的节点 id（空 = 不是重排档）
  let fdReorderStart = null;     // { x, y, parentId } 按下时的屏幕坐标与父节点
  let fdReorderDrop = null;      // 松手要写回的那一位：{ index, parent }（**等于**落位预览算出来的那一个）
  /* 【R2 期 4 · f】重挂父拖动：`fdReparentRoot` 非空 ⇒ 这一次拖动改的是**父子关系**
   *  （把锁定的节点连同子树挂到松手时压着的那个节点下）。与 reorder 共用同一个副本元素
   *  `#tree-reorder-ghost`（不新造视觉 ✓）；**没有**插入横线 —— 落点是"压着的节点"，
   *  不是兄弟之间的缝隙。松手只把 (id, 目标父) 交出去，写盘由 app-actions 的
   *  reparentNode 经三道闸（落位预览 / --dry-run 预检 / 回读重建）走。 */
  let fdReparentRoot = null;     // 重挂拖动锁定的节点 id（空 = 不是重挂档）
  let fdReparentStart = null;    // { x, y } 按下时的屏幕坐标
  let fdReparentDrop = null;     // 松手要交给写通道的那一对：{ parent }（当前压着的节点 id）
  let fdSelDrag = null;          // P4：从"已选中的节点"上按下开始的拖拽（起点坐标 ✓）    // {x, y, ox, oy} 拖动起点（屏幕）与起始偏移（逻辑）
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
  let fdRubberAdditive = false;  // 本次框选是不是"加选"（Ctrl/Cmd 按住 → 与已有选区并集 ✓）
  let fdRubberBase = null;       // 加选时要保留的原选区 id 列表
  let fdRubberEl = null;         // 橡皮筋 DOM
  let fdSelection = [];          // 选中的节点 id（持久到点击框外）
  let fdSelectionRaw = [];       // 原始命中共（未做"同父裁剪"）—— 见 applySelection 的说明 ✓
  /** 大虚线框是否可见：**只有框选才画它** ✓（Ctrl+点击加选不画 —— 用户 2026-10-08："按住 Ctrl 选的时候不要出现那个大的虚线框，它的逻辑和框选不一样" ✓） */
  let fdSelectionBoxVisible = true;
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
      const n = MM.adapter.getNode(jm, id);
      return n && n.parent && !set.has(n.parent.id);
    });
    // ② 按**直接父节点**分组（不是按树根！用户实测 bug 根因：wlan-01 与
    //    wlan-sta 同属一棵主题树，按树根分组会把跨主题节点错误并入一组）；
    //    组间取**平均深度最浅**的组（深度 = 到根的跳数，即收起范围的外沿）。
    //    例：[wlan-01(父wlan-book,深1), wlan-sta(父wlan-02,深2), …叶子们已剔]
    //    → 两组不同父 → 取 wlan-01 组（更浅）→ STA 被过滤。
    const groups = {};
    eff.forEach((id) => {
      const n = MM.adapter.getNode(jm, id);
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
  function applySelection(ids, rawIds, opts) {   // opts.hideBox：Ctrl+加选不画大框 ✓
    const res = trimSelection(ids || []);
    fdSelection = res.kept;
    // ④ 原始的命中共（未裁剪）单独留一份：**问 AI 要看到全部被框选的节点**
    //（`trimSelection` 的同父/父冗余裁剪是给"收起/拖动"这类树操作定义的，用它来筛 AI 的上下文
    //  会把用户明明框住的节点悄悄丢掉 ✗）。
    fdSelectionRaw = (rawIds || ids || []).filter(Boolean);
    // 大框只在**框选**时出现 ✓：opts.hideBox（Ctrl+点击加选 ✓）传 true 就把它藏起来 ✓
    fdSelectionBoxVisible = !(opts && opts.hideBox);
    refreshSelectionOutline();
    if (MM.showNodeToolbar) MM.showNodeToolbar(null);   // 选区一变 ⇒ 工具条按**整批**刷新/出现 ✓
    return { kept: res.kept, dropped: res.dropped };
  }

  /** 选区的**原始命中集**（未裁剪）—— 给 AI 上下文用 ✓ 与 `getSelection()`（裁剪后，给树操作用）区分开 */
  MM.getSelectionRaw = () => fdSelectionRaw.slice();

  /** P5：给**真正被框选**的节点画虚线描边（用户要的"框了 a 和 b 就把 a、b 的边框变虚线"✓）。
   *  · 数据源是 `fdSelectionRaw`（原始命中共 ✓）—— 它**不受同父/父冗余裁剪**影响 ✓
   *    （那套裁剪是"收起/拖动"这类树操作的口径 ✓ 与"我框住了什么"是两回事 ✓ 用户明确说这两者要分开 ✓）；
   *  · 只写 CSS 类（jsMind 会重置内联样式，类不受影响 ✓ 与本工程既有高亮同款做法 ✓）；
   *  · 幂等：先清后加；raw 为空时把类清干净（不在 DOM 里留残影 ✓） */
  const CLS_SEL_RAW = 'mm-sel-raw';
  function paintRawSelection() {
    const panelEl = fdPanel();
    if (!panelEl) return 0;
    const want = new Set(fdSelectionRaw);
    let n = 0;
    panelEl.querySelectorAll('jmnode').forEach((el) => {
      const on = want.has(el.getAttribute('nodeid'));
      el.classList.toggle(CLS_SEL_RAW, on);
      if (on) n++;
    });
    return n;
  }
  MM.paintRawSelection = paintRawSelection;            // 给冒烟断言用：手动刷一次并拿条数 ✓
  MM.rawSelectionClass = () => CLS_SEL_RAW;             // 只读：断言里别写死类名字符串 ✓

  /** 重算选区虚线框：跟随节点当前位置、大小自适应（不可见节点除外）。
   *  语义（v0.16.5）：框标注的范围 = **实际会被收起的范围** = 选中节点
   *  ∪ 它们**可见的子节点**（收起动作藏的正是这些子节点）。这样框选父节点
   *  时框就预告折叠范围，收起后收缩到父节点，展开再涨回（大小自适应）。 */
  function refreshSelectionOutline() {
    paintRawSelection();   // P5：先给"真正被框选"的节点上色（不受同父裁剪限制 ✓ 数据是 fdSelectionRaw ✓）
    const el = ensureSelOutline();
    if (!fdSelectionBoxVisible || !fdSelection.length) { el.style.display = 'none'; return; }   // Ctrl+加选 ⇒ 不画大框 ✓
    const jm = state.jm;
    const scope = new Set(fdSelection);
    // 把选中节点的**可见子节点**并入范围（折叠动作影响的就是它们）
    const addVisibleChildren = (id) => {
      const n = jm ? MM.adapter.getNode(jm, id) : null;
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

  /** 清空选区（点空白处、切项目重建、右键「清除框选」都走它）。
   *  ⚠️ **原始命中集与描边类必须一起清**（本轮真机缺陷的第二个根因）：原先只清裁剪集 + 把大框藏起来，
   *  而描边画的是 `fdSelectionRaw` ⇒ **节点上的虚线描边留在画面上**（点空白也擦不掉，直到重排/重开）✗；
   *  顺带还会让"工具条 N / 问 AI 的集合"与画面上的描边对不上（一个说 0，一个还画着 3 个 ✗）。
   *  真机复现见 `scripts/smoke/36-real-input.js` ⑤（真鼠标点空白 ⇒ raw 与像素判据都仍在 ✗）。 */
  function clearSelection() {
    fdSelectionBoxVisible = true;   // 复位 ✓（下一次框选照常画框 ✓）
    fdSelection = [];
    fdSelectionRaw = [];            // ★ 原始命中集也清（"我点过谁"这件事必须真的归零 ✓）
    const el = document.getElementById(SEL_OUTLINE_ID);
    if (el) el.style.display = 'none';
    clearRubberPreview(); // 预览残留一并清
    paintRawSelection();  // ★ 把 mm-sel-raw 类从节点上摘掉（不是只把大框藏起来 ✓）
  }

  /** 选中集按父分组；取最大组（框选设计：一次操作只针对同一父节点的节点）。
   *  可传入 ids（默认用完整选区）。 */
  function selectionByParent(ids) {
    const jm = state.jm;
    if (!jm) return [];
    const list = ids || fdSelection;
    const groups = {};
    list.forEach((id) => {
      const n = MM.adapter.getNode(jm, id);
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
      const node = MM.adapter.getNode(jm, id);
      if (node && node.children && node.children.length) { MM.adapter.collapseNode(jm, id); n++; }
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
      const node = MM.adapter.getNode(jm, id);
      if (node && node.children && node.children.length) { MM.adapter.expandNode(jm, id); n++; }
    });
    refreshSelectionOutline();
    setStatus(n ? '已展开所选 ' + n + ' 个节点' : '所选节点没有可展开的子节点');
  }

  /** nodeId 所在顶层主题树根（root 的直接子节点）；root 自身返回 null */
  function treeRootOf(nodeId) {
    const jm = state.jm;
    if (!jm) return null;
    let n = MM.adapter.getNode(jm, nodeId);
    while (n && n.parent && !n.parent.isroot) n = n.parent;
    return (n && n.parent && n.parent.isroot && !n.isroot) ? n.id : null;
  }

  /** 节点到根这条路上**所有偏移根的和**；一个都没有（或全是零）时返回 null。
   *
   *  为什么是"和"而不是"最上面那个"：jsMind 的节点是**平铺的兄弟元素**（jmnodes 的直接子元素，
   *  相互不嵌套）⇒ 给某个节点设 transform **不会**传给它的后代 —— 后代的屏幕位置要由我们**自己**
   *  把祖先链上的偏移加起来（含它自己）。这也正是"只移动目标子树、别的一动不动"能成立的原因：
   *  每个元素的 transform 互相独立。
   *  既有语义（只有顶层主题有偏移时）逐项不变：那时链上只有一个非零项，和 == 那一项 ✓。
   *  root 自身不参与（它是容器：jsMind 不把 root 的 transform 传给谁，给它偏移没有意义）。 */
  function treeOffsetFor(id) {
    const jm = state.jm;
    if (!jm) return null;
    let n = MM.adapter.getNode(jm, id);
    if (!n) return null;
    let x = 0, y = 0, hit = false;
    while (n && !n.isroot) {
      const o = treeOffsets[n.id];
      if (o && (o.x !== 0 || o.y !== 0)) { x += o.x; y += o.y; hit = true; }
      n = n.parent;
    }
    return hit ? { x: x, y: y } : null;
  }

  /** 这个节点**自己**那一项偏移（不含祖先的）；没有或为零时返回 null。
   *  用途：右键菜单「把这个子树移回自动布局」的显示条件 —— 该清的是**它自己那一项**，
   *  祖先（如顶层主题）的偏移不是它的事（那条路由祖先自己的那一条菜单项负责）✓ */
  function ownOffsetFor(id) {
    const o = id ? treeOffsets[id] : null;
    return (o && (o.x !== 0 || o.y !== 0)) ? o : null;
  }

  /** 把全部偏移落到 DOM（节点 transform）；没有偏移的节点清空 transform 防残留。
   *  遍历整棵树（不是只遍历顶层主题）—— 键域扩到任意子树根之后，跳过深层节点就会漏掉它们。 */
  function applyTreeOffsets() {
    const jm = state.jm;
    if (!jm) return;
    const rootNode = MM.adapter.getNode(jm, 'root');
    if (!rootNode) return;
    (rootNode.children || []).forEach(function walk(tp) {
      const o = treeOffsetFor(tp.id);
      const t = o ? 'translate(' + o.x + 'px,' + o.y + 'px)' : '';
      // jmexpander（折叠时的 +/− 号，nodeid 同为该节点）必须一起偏移，
      // 否则加减号留在原地、节点走了（用户反馈①）。jsMind 不写 expander 的
      // transform，relayout 后保留，无冲突。
      document.querySelectorAll('jmnode[nodeid="' + tp.id + '"], jmexpander[nodeid="' + tp.id + '"]')
        .forEach((el) => { el.style.transform = t; });
      (tp.children || []).forEach(walk);
    });
    // 树被拖动/重排后**关系线的端点也变了** ⇒ 通知关联层重画（rAF 合并，拖动时每帧只画一次 ✓；
    // 关联层没在展示时是空操作，零成本）
    if (MM.scheduleRelatedRedraw) MM.scheduleRelatedRedraw();
  }

  /** 清空树偏移（切换项目/撤销重做重建由 renderMind 调；还原视图也复位）。
   *  传 treeId ⇒ 只清那一棵（右键菜单"回到自动布局"用）；不传 ⇒ 全清。 */
  function clearTreeOffsets(treeId) {
    if (treeId && treeOffsets[treeId]) delete treeOffsets[treeId];
    else if (!treeId) for (const k in treeOffsets) delete treeOffsets[k];
    applyTreeOffsets();
  }

  /* —— 树偏移的对外读写口（功能：框选后拖动可**保存永久化**，2026-10-08；R2 期 1 扩到节点级）——
   * 单一真源：偏移只活在**这一层**（treeOffsets），序列化时向这里取
   * （`MM.getTreeOffsets` / `MM.getNodeOffsets`），绝不在数据层再存一份 —— 两份就会漂移
   * （本工程修过多次同类问题）。
   * 数据形状（两个键**共用一套形状与上下界**，只差键域）：
   *   · `meta.themeOffsets = { "<顶层主题id>": { x, y } }`（2026-10-08 起）
   *   · `meta.nodeOffsets  = { "<更深的子树根id>": { x, y } }`（2026-10-14 / R2 期 1 起）
   * 都是逻辑画布坐标、相对该根的自动布局位置；缺省 = 自动布局。
   * 契约见 docs/DATA-FORMAT.md，校验见 src/schema.js（`validateOffsetMap`，一处实现）。 */

  /** 偏移的**唯一收集实现**：按遍历现树分成两个桶（顶层主题 / 更深的子树根）。
   *  为什么分桶放在这里而不是序列化那一处：只有这一层知道"当前树长什么样"，
   *  而两个数据键的键域差别**就是树结构**（root 的直接子节点 vs 更深的节点）。
   *  只回**当前树里真实存在的节点**（脏 id 一律丢弃，绝不写回数据）；
   *  只回非零项、坐标取整（与既有 `themeOffsets` 写回口径逐项相同）。 */
  function collectOffsets() {
    const themes = {}, nodes = {};
    const jm = state.jm;
    if (!jm) return { themes: themes, nodes: nodes };
    const rootNode = MM.adapter.getNode(jm, 'root');
    if (!rootNode) return { themes: themes, nodes: nodes };
    const put = (id, isTop) => {
      const o = treeOffsets[id];
      if (!o || (o.x === 0 && o.y === 0)) return;                 // 零偏移 = 无偏移，不写
      const rec = { x: Math.round(o.x), y: Math.round(o.y) };
      if (isTop) themes[id] = rec; else nodes[id] = rec;
    };
    const walk = (n, isTop) => {
      put(n.id, isTop);
      (n.children || []).forEach((c) => walk(c, false));
    };
    (rootNode.children || []).forEach((tp) => walk(tp, true));
    return { themes: themes, nodes: nodes };
  }

  /** 读出全部非零偏移里**顶层主题**那一桶（序列化写 `meta.themeOffsets` 的唯一入口） */
  function getTreeOffsets() { return collectOffsets().themes; }

  /** 读出全部非零偏移里**更深的子树根**那一桶（序列化写 `meta.nodeOffsets` 的唯一入口）。
   *  ⚠️ 与 getTreeOffsets 共用上面那一个收集实现 —— 别在这里再遍历一遍树（第二份必然与第一份漂）。 */
  function getNodeOffsets() { return collectOffsets().nodes; }

  /** 从数据恢复偏移（打开项目 / undo 之后调用 —— **节点 DOM 必须已建好**）。
   *  `themeMap` = `meta.themeOffsets`、`nodeMap` = `meta.nodeOffsets`（都可缺省 ⇒ 与从前逐项相同）。
   *  一次清空 + 一次落盘 + **一次** applyTreeOffsets（两桶一起落，避免"先落主题再落节点"两次重排）。
   *  返回真正落下的条数，供断言与诊断用（0 = 没有偏移或全被丢弃）。 */
  function setTreeOffsets(themeMap, nodeMap) {
    clearTreeOffsets();
    const jm = state.jm;
    if (!jm) return 0;
    const has = (m) => !!(m && typeof m === 'object');
    if (!has(themeMap) && !has(nodeMap)) return 0;
    const rootNode = MM.adapter.getNode(jm, 'root');
    const topics = (rootNode && rootNode.children) || [];
    /* 两条**键域判据**（校验只管形状，见 src/schema.js 的取值表；这里判"这个 id 在当前树里算哪一桶"）：
     *   · 顶层主题桶：id 必须是 root 的**直接**子节点（既有口径，一字未改）；
     *   · 节点桶：id 必须存在、且**不是 root 的直接子节点**（属于顶层主题的 id 归上面那一桶 ——
     *     同一个 id 只允许住在**一个**键里，否则"哪个键说了算"要靠调用顺序决定 ✗）。
     * 两条都是"命中才落"，不命中一律丢弃（数据里有、当前树里没有 ⇒ 不写回）。 */
    const topIds = new Set(topics.map((tp) => tp.id));
    const accept = (map, ok) => {
      let m = 0;
      if (!has(map)) return m;
      Object.keys(map).forEach((id) => {
        if (!ok(id)) return;
        const o = map[id];
        if (!o || typeof o !== 'object') return;
        const x = Number(o.x), y = Number(o.y);
        if (!isFinite(x) || !isFinite(y)) return;          // 坏数据一律忽略（schema 已拦，这里兜底）
        if (x === 0 && y === 0) return;                   // 零偏移 = 无偏移，不落
        treeOffsets[id] = { x: x, y: y };
        m++;
      });
      return m;
    };
    const n = accept(themeMap, (id) => topIds.has(id))
      + accept(nodeMap, (id) => !topIds.has(id) && !!MM.adapter.getNode(jm, id) && id !== 'root');
    applyTreeOffsets();
    return n;
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
    const tp = MM.adapter.getNode(jm, treeRootId);
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

  /** 拖动中：框 transform 跟随子树**累计**偏移（包围盒不变，只更新 transform）。
   *  用累计值而不是"子树根自己那一项"：拖动一个**深层**子树时，祖先（如顶层主题）也带偏移 ——
   *  框要落在它**看上去**所在的位置，否则框与子树当场脱开。既有语义（只有顶层主题有偏移）
   *  下两者恒等 ✓。 */
  function syncTreeOutline() {
    const box = document.getElementById(TREE_OUTLINE_ID);
    if (!box || !fdDragTreeRoot) return;
    const o = treeOffsetFor(fdDragTreeRoot);
    box.style.transform = o ? 'translate(' + o.x + 'px,' + o.y + 'px)' : '';
  }

  function hideTreeOutline() {
    const box = document.getElementById(TREE_OUTLINE_ID);
    if (box) box.style.display = 'none';
  }

  /** 进入/退出拖动模式（toggle 由菜单项调用）。treeRootId 为锁定的**目标子树根**：
   *  顶层主题（既有语义，「拖动树」入口）或更深的任意节点（R2 期 1，「拖动此子树」入口）。
   *  `opts.mode`：`'move'`（默认，动位置 ⇒ 写 `meta.*Offsets`）/ `'reorder'`（R2 期 3 · e，
   *  改**同级上下序** ⇒ 走既有 CLI `move --index` 写 `children` 顺序）/ `'reparent'`（R2 期 4 · f，
   *  改**父子关系** ⇒ 走既有 CLI move 语义 + 三道闸）。
   *  三档共用同一套"按住左键拖"的手势与虚线框，只在按下之后分岔（见 mousedown/mousemove）——
   *  所以没有第二份拖动外壳；而"写回"这条路三档各自只有一处实现（见文件头的不变式②）。 */
  function setDragMode(on, treeRootId, opts) {
    const mode = (opts && opts.mode === 'reorder') ? 'reorder'
      : ((opts && opts.mode === 'reparent') ? 'reparent' : 'move');
    if (!on) {
      clearReorderArtifacts();
      fdReorderStart = null; fdReorderDrop = null; fdReorderRoot = null; fdDragKind = 'move';
      fdReparentStart = null; fdReparentDrop = null; fdReparentRoot = null;
    }
    fdDragMode = !!on;
    fdDragTreeRoot = fdDragMode ? (treeRootId || null) : null;
    fdDragKind = fdDragMode ? mode : 'move';
    fdReorderRoot = (fdDragMode && mode === 'reorder') ? fdDragTreeRoot : null;
    fdReparentRoot = (fdDragMode && mode === 'reparent') ? fdDragTreeRoot : null;
    const panel = fdPanel();
    if (panel) panel.style.cursor = fdDragMode ? 'grab' : '';
    document.body.classList.toggle('mm-dragmode', fdDragMode);
    let topic = '';
    let isTopTree = false;
    if (fdDragTreeRoot) {
      const jm = state.jm;
      const n = jm && MM.adapter.getNode(jm, fdDragTreeRoot);
      topic = n ? n.topic : '';
      isTopTree = !!(n && n.parent && n.parent.isroot && !n.isroot);
    }
    setStatus(fdDragMode
      ? (fdDragTreeRoot
          ? (mode === 'reorder'
              ? '同级重排：按住左键拖动「' + topic + '」到目标位置（松手才写盘；Esc / 右键退出）'
              : (mode === 'reparent'
                  ? '重挂父：按住左键把「' + topic + '」拖到**目标父节点上**松手（先落位预览、确认后才写盘；Esc / 右键退出）'
                  : (isTopTree
                      ? '拖动模式：按住左键拖动移动「' + topic + '」树，其他树不动（右键 / Esc 退出）'
                      : '拖动模式：按住左键拖动移动「' + topic + '」子树（只动它和它的后代），其他节点不动（右键 / Esc 退出）')))
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

  /** 本次拖动是哪一档：`'move'`（动位置）/ `'reorder'`（改同级上下序）。 */
  function dragModeKind() { return fdDragKind; }

  /* ================= 【R2 期 3 · e】同级重排：拖动 + 落位预览 + clamp =================
   * 语义（`--index` 契约的渲染层一侧，**与 CLI 的判定分工不同**）：
   *   · CLI `move <项目> <id> <新父id> --index k` 的 `k` = **移动完成后**在新父 `children`
   *     里的下标（0 基）；合法范围 `0…L'`，`L'` = **目标父移除该节点之后**的子节点数
   *     （唯一实现 `cli/commands/edit.js` 的 `moveIndexUpperBound`，P3 那批落地 ✓）。
   *   · 渲染层这里只做**体验**：把"指针拖到哪儿"翻译成一个**永远合法**的 k（拖出列表 ⇒ 贴到
   *     首/末）。非法档**响亮失败**仍然由 CLI 负责（它才是契约校验）—— 渲染层永远发 clamp 后的值，
   *     既不是替 CLI 判、也不是绕过它。
   *   · ⚠️ **不许在这里写第二份 move 实现** ✗：算出来的 k 只经
   *     `MMApp.reorderNodeChild` → IPC → **CLI `move`** → 回读重建（不变式②）。
   * 判据（冒烟域 48 的乙/丁）：拖动期间**盘上零写入、序列化文本逐字节不变**（构造性：
   *   这一档一个偏移桶都不写）；松手才落盘，且盘上顺序 == 期望、其余字节白名单为空。 */

  /** 同一父下的全部**兄弟**（不含自己）按数据顺序；取不到父 ⇒ null */
  function reorderSiblings() {
    const jm = state.jm;
    if (!jm || !fdReorderRoot) return null;
    const n = MM.adapter.getNode(jm, fdReorderRoot);
    if (!n || !n.parent) return null;
    return { parentId: n.parent.id, list: (n.parent.children || []).filter((c) => c && c.id !== n.id) };
  }

  /** 指针停在某个屏幕坐标时，**应该在的**下标 k。
   *  口径（与 `moveNode` 的"先摘后插"逐项对齐）：k = 在**摘掉自己之后**的兄弟序列里插到第几位。
   *  取法 = 数"**原始位置**里在自己上面（cy 更小）的兄弟个数"：
   *    · 往上拖过头 / 原本就是第 1 个 ⇒ 0（贴到最前）
   *    · 往下拖出头 / 原本就是最后一个 ⇒ k（贴到最后，k = 兄弟数 = 合法上界）
   *  ⚠️ 判据里"其余兄弟用的是**新位置**（拖动中）"这条正是这一处的依据：拖动中节点会挪开
   *    （jsMind 重排），所以拿"原始 cy"当可分辨的阈值是稳的；拿新位置会把阈值自己也挪走 ✗。 */
  function reorderIndexAt(y) {
    const sib = reorderSiblings();
    if (!sib) return null;
    let above = 0;
    const sibRect = [];
    sib.list.forEach((c) => {
      const el = document.querySelector('jmnode[nodeid="' + c.id + '"]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const cs = { id: c.id, cy: cy };
      sibRect.push(cs);
      if (y > cy) above++;
    });
    const upper = sib.list.length;                 // = L'（合法上界，见 moveIndexUpperBound）
    const k = Math.max(0, Math.min(upper, above)); // **渲染层 clamp**：拖出列表就贴到首/末
    return { index: k, parent: sib.parentId, upper: upper, siblings: sib.list.length,
      siblingRects: sibRect, raw: above, clamped: above !== k };
  }

  const REORDER_GHOST_ID = 'tree-reorder-ghost';
  const REORDER_MARK_ID = 'tree-reorder-mark';

  /** 清掉重排/重挂拖动留下的 DOM、并把被拖节点的透明度还原（域之间不留状态） */
  function clearReorderArtifacts() {
    [REORDER_GHOST_ID, REORDER_MARK_ID].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    [fdReorderRoot, fdReparentRoot].forEach((dimRoot) => {
      if (dimRoot) {
        document.querySelectorAll('jmnode[nodeid="' + dimRoot + '"]')
          .forEach((el) => { if (el.dataset.mmDimmed === '1') el.style.opacity = ''; delete el.dataset.mmDimmed; });
      }
    });
  }

  /** 进入重排拖动：把被拖节点**复制**成一个跟指针走的副本（源节点留在原地当锚点）。
   *  为什么是副本而不是"把真元素拽走"：源节点留在原位，落位预览与"插到第几位"的判定
   *  才有稳定的参照物；真元素一旦走了，"拖动期间序列化/盘上零变化"也就无从谈起（那是 DOM 状态）。 */
  function spawnDragGhost(n, src) {
    const ghost = document.createElement('div');
    ghost.id = REORDER_GHOST_ID;
    ghost.textContent = String(n.topic == null ? '' : n.topic);
    const sr = src.getBoundingClientRect();
    ghost.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:1000;'
      + 'width:' + Math.round(sr.width) + 'px;height:' + Math.round(sr.height) + 'px;'
      + 'line-height:' + Math.round(sr.height) + 'px;text-align:center;'
      + 'background:rgba(22,100,255,.10);border:1px dashed #1664ff;border-radius:6px;'
      + 'font:inherit;color:inherit;opacity:.85;';
    ghost.style.transform = 'translate(' + Math.round(sr.left) + 'px,' + Math.round(sr.top) + 'px)';
    document.body.appendChild(ghost);
    src.dataset.mmDimmed = '1';
    src.style.opacity = '.45';
    return ghost;
  }

  function reorderBegin(x, y) {
    clearReorderArtifacts();
    const jm = state.jm;
    const n = fdReorderRoot && MM.adapter.getNode(jm, fdReorderRoot);
    if (!n) return false;
    const src = document.querySelector('jmnode[nodeid="' + fdReorderRoot + '"]');
    if (!src) return false;
    fdReorderStart = { x: x, y: y, parentId: n.parent.id };
    spawnDragGhost(n, src);
    const mark = document.createElement('div');
    mark.id = REORDER_MARK_ID;
    mark.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:1000;display:none;'
      + 'height:0;border-top:2px dashed #1664ff;';
    document.body.appendChild(mark);
    return true;
  }

  /** 拖动中：副本跟指针走 + 落位预览（那条横线画在**将要插进的那个缝隙**上）。
   *  返回**就是**松手会写下去的那一位（`{index,parent,upper,...}`）—— 预览与写回**同一个读数**，
   *  不许两处各算一套（本工程明令"同一逻辑两处表达 ⇒ 必然漂"）。 */
  function reorderUpdate(x, y) {
    if (!fdReorderStart || !fdReorderRoot) return null;
    const ghost = document.getElementById(REORDER_GHOST_ID);
    if (ghost) {
      const sr = ghost.getBoundingClientRect();
      ghost.style.transform = 'translate(' + Math.round(x - sr.width / 2) + 'px,'
        + Math.round(y - sr.height / 2) + 'px)';
    }
    const at = reorderIndexAt(y);
    fdReorderDrop = at ? { index: at.index, parent: at.parent, upper: at.upper, siblings: at.siblings } : null;
    const mark = document.getElementById(REORDER_MARK_ID);
    if (mark) {
      if (!at || !at.siblingRects.length) {
        mark.style.display = 'none';
      } else {
        const order = at.siblingRects.slice().sort((a, b) => a.cy - b.cy);
        let lineY;
        if (at.index <= 0) lineY = order[0].cy - 14;
        else if (at.index >= order.length) lineY = order[order.length - 1].cy + 14;
        else lineY = (order[at.index - 1].cy + order[at.index].cy) / 2;
        const rects = order.map((o) => {
          const el = document.querySelector('jmnode[nodeid="' + o.id + '"]');
          return el ? el.getBoundingClientRect() : null;
        }).filter(Boolean);
        if (rects.length) {
          const left = Math.min.apply(null, rects.map((r) => r.left));
          const right = Math.max.apply(null, rects.map((r) => r.right));
          mark.style.left = Math.round(left - 6) + 'px';
          mark.style.top = Math.round(lineY) + 'px';
          mark.style.width = Math.round(right - left + 12) + 'px';
          mark.style.display = 'block';
        }
      }
    }
    return fdReorderDrop;
  }

  /** 松手：把落位读数交出去（自己**不写盘** —— 写盘由 app-actions 的 reorderNodeChild 经 CLI 走）。
   *  返回 `{ok, drop}` / `{ok:false, reason}`（不静默）；清理 DOM 把状态交还给界面。 */
  function reorderEnd() {
    if (!fdReorderStart || !fdReorderRoot) return { ok: false, reason: '没有正在进行中的同级重排拖动' };
    const id = fdReorderRoot;
    const drop = fdReorderDrop;
    clearReorderArtifacts();
    fdReorderStart = null;
    fdReorderDrop = null;
    fdReorderRoot = null;
    fdDragKind = 'move';
    if (!drop) return { ok: false, reason: '拖动的这一段没有算出落位（没移动过指针？）', id: id };
    return { ok: true, id: id, parent: drop.parent, index: drop.index, upper: drop.upper, siblings: drop.siblings };
  }

  /** 取消：清 DOM + 复位状态（Esc / 右键 / 收尾都用它，不拆成两份） */
  function reorderCancel() {
    const id = fdReorderRoot;
    clearReorderArtifacts();
    fdReorderStart = null;
    fdReorderDrop = null;
    fdReorderRoot = null;
    fdDragKind = 'move';
    return !!id;
  }

  /** 现状读数（断言用）：当前是不是重排档、目标是谁、当前落位是第几位。 */
  function reorderState() {
    return { active: !!fdReorderRoot, kind: fdDragKind, id: fdReorderRoot,
      parent: fdReorderStart ? fdReorderStart.parentId : null,
      drop: fdReorderDrop ? { index: fdReorderDrop.index, parent: fdReorderDrop.parent,
        upper: fdReorderDrop.upper, siblings: fdReorderDrop.siblings } : null };
  }

  /* ================= 【R2 期 4 · f】重挂父：拖动 + 落点（压着的节点） =================
   * 语义：松手时**压着哪个节点**，就把锁定的节点（连同子树）挂到它下面（末尾）。
   *  · 与 reorder 共用同一个副本元素（`#tree-reorder-ghost`，spawnDragGhost 一处实现）⇒ 不新造视觉 ✓；
   *  · **没有**插入横线：落点是节点，不是兄弟之间的缝隙；压着空白 = 取消（零写入）；
   *  · 成环（落到自己的子孙上）**不在这里拦**：那一条判据要的是 CLI 的**具体理由**
   *    + 盘上 sha256 不变，拦截只能发生在唯一实现里（预览/预检会带原话回来）；
   *  · 松手只把 (id, 目标父) 交出去 —— 写盘走 app-actions 的 `reparentNode`（三道闸），
   *    这里**不写盘、不改内存树**（不变式②）。 */
  function reparentBegin(x, y) {
    clearReorderArtifacts();
    const jm = state.jm;
    const n = fdReparentRoot && MM.adapter.getNode(jm, fdReparentRoot);
    if (!n) return false;
    const src = document.querySelector('jmnode[nodeid="' + fdReparentRoot + '"]');
    if (!src) return false;
    fdReparentStart = { x: x, y: y };
    spawnDragGhost(n, src);
    return true;
  }

  /** 拖动中：副本跟指针走 + 落点预览（当前压着的节点 id）。ghost 是 pointer-events:none
   *  ⇒ elementFromPoint 看得穿它；压着非节点（空白/画布）⇒ null（松手即取消）。 */
  function reparentUpdate(x, y) {
    if (!fdReparentStart || !fdReparentRoot) return null;
    const ghost = document.getElementById(REORDER_GHOST_ID);
    if (ghost) {
      const sr = ghost.getBoundingClientRect();
      ghost.style.transform = 'translate(' + Math.round(x - sr.width / 2) + 'px,'
        + Math.round(y - sr.height / 2) + 'px)';
    }
    let hitId = null;
    const el = document.elementFromPoint(x, y);
    const nodeEl = el && el.closest ? el.closest('jmnode[nodeid]') : null;
    if (nodeEl) hitId = nodeEl.getAttribute('nodeid');
    fdReparentDrop = hitId ? { parent: hitId } : null;
    return fdReparentDrop;
  }

  /** 松手：把 (id, 目标父) 交出去（自己**不写盘** —— 写盘由 app-actions 的 reparentNode
   *  经三道闸走）。压着空白/没有拖动 ⇒ {ok:false, reason}（不静默）；清理 DOM 还状态。 */
  function reparentEnd() {
    if (!fdReparentStart || !fdReparentRoot) return { ok: false, reason: '没有正在进行中的重挂拖动' };
    const id = fdReparentRoot;
    const drop = fdReparentDrop;
    clearReorderArtifacts();
    fdReparentStart = null;
    fdReparentDrop = null;
    fdReparentRoot = null;
    fdDragKind = 'move';
    if (!drop || !drop.parent) return { ok: false, reason: '松手时没有落在任何节点上（落到空白 = 取消，零写入）', id: id };
    return { ok: true, id: id, parent: drop.parent };
  }

  /** 取消：清 DOM + 复位状态（Esc / 右键 / 收尾都用它，不拆成两份） */
  function reparentCancel() {
    const id = fdReparentRoot;
    clearReorderArtifacts();
    fdReparentStart = null;
    fdReparentDrop = null;
    fdReparentRoot = null;
    fdDragKind = 'move';
    return !!id;
  }

  /** 现状读数（断言用）：当前是不是重挂档、目标是谁、当前压着谁。 */
  function reparentState() {
    return { active: !!fdReparentRoot, kind: fdDragKind, id: fdReparentRoot,
      drop: fdReparentDrop ? { parent: fdReparentDrop.parent } : null };
  }

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

    /* P4：框选后**直接**拖给侧栏（不进拖动模式 ✓）。三个捕获监听，**不阻断**其它行为 ✓：
     *  · 只有"按在**当前选中的节点**上"才算这次拖拽的起点 ✓（按在别处/空白 ⇒ 与原来一模一样 ✓）
     *  · 松手点必须落在**面板右缘 24px 内**才发送 ✓（否则什么都不做 ⇒ 普通点击照常弹详情 ✓）
     *  · 发送的是**整批 raw 选区**（getSelectionRaw ✓ 未裁剪 ✓ —— 与 P5 的描边同源 ✓）
     *  · 不搞拖动模式：那条路径是"移动树的位置"（fdDragMode）✓ 两者互不干扰 ✓ 用户明确要求分开 ✓ */
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || fdDragMode) return;
      const cont = document.getElementById('mindmap-container');
      if (!cont || !cont.contains(e.target)) return;
      if ((e.target.closest && (e.target.closest('.float-detail') || e.target.closest('#mm-node-toolbar')))
        || (MM.fdIsSatelliteTarget && MM.fdIsSatelliteTarget(e.target))) return;
      const nodeEl = e.target.closest && e.target.closest('jmnode[nodeid]');
      if (!nodeEl) return;
      const id = nodeEl.getAttribute('nodeid');
      if (!fdSelectionRaw.length || fdSelectionRaw.indexOf(id) < 0) return;   // 只认"选中批"里的节点 ✓
      // P7：把"起点"报给主进程（拖拽期间它用 40ms 轮询光标屏幕坐标 ✓ ——
      // 指针飘到原生侧栏视图上时渲染层收不到 mouseup ✗ ⇒ 那条路由主进程判定，见 main.js）
      try {
        if (window.desktop && desktop.dsh && desktop.dsh.selDragStart) desktop.dsh.selDragStart(fdSelectionRaw.slice());
      } catch (err) {
        if (MM.setStatus) MM.setStatus('侧栏拖放：起点上报失败（' + ((err && err.message) || err) + '）', true);
      }
      fdSelDrag = { x: e.clientX, y: e.clientY };
    }, true);
    document.addEventListener('mousemove', (e) => {
      if (!fdSelDrag) return;
      fdSelDrag.x = e.clientX; fdSelDrag.y = e.clientY;
    }, true);
    document.addEventListener('mouseup', (e) => {
      if (!fdSelDrag) return;
      fdSelDrag = null;
      const pnel = fdPanel();
      const pr = pnel ? pnel.getBoundingClientRect() : null;
      const ids = MM.getSelectionRaw ? MM.getSelectionRaw() : [];
      // P7：把"终点"报给主进程 —— 它拿的是**屏幕坐标 + 原生侧栏真实几何**，比渲染层这份可信 ✓
      //（命中 ⇒ 投喂；投喂仍走同一条 sendNodesToSidebar ⇒ 文本只有一处实现 ✓）
      let verdictP = null;
      try {
        if (MM.requestSelDropVerdict) verdictP = MM.requestSelDropVerdict({ x: e.clientX, y: e.clientY });
      } catch (err) {
        if (MM.setStatus) MM.setStatus('侧栏拖放：终点判定失败（' + ((err && err.message) || err) + '）', true);
      }
      if (pr && ids.length && e.clientX >= pr.right - 24) {   // 面板右缘 24px 兜底（已验过 ✓ 保留）
        e.preventDefault();
        e.stopPropagation();                                   // 吞掉这次点击 ⇒ 不再额外弹详情 ✓
        if (MM.sendNodesToSidebar) MM.sendNodesToSidebar(ids);
        return;
      }
      if (verdictP && ids.length) {
        Promise.resolve(verdictP).then((v) => {
          if (v && v.ok && v.hit && MM.sendNodesToSidebar) MM.sendNodesToSidebar(ids);
          // 只说**需要用户知道**的原因 ✓：point-not-over-sidebar = 在别处松手 ⇒ 正常操作，不该弹失败文案 ✗
          // （实测：这条正是被 P4 ② 对照组抓出来才收窄的 ✓ —— 对照组存在的意义 ✓）
          else if (v && v.reason && v.reason !== 'point-not-over-sidebar') {
            MM.setStatus('没送进侧栏：' + v.reason + (v.reason === 'sidebar-closed' ? ' —— 先打开侧栏再拖 ✓' : ''), true);
          }
        }).catch(() => { /* 失败已在上面的状态栏里说过 ✗ */ });
      }
    }, true);

    /* ⑥ Ctrl/Cmd+点击节点 = 加选/减选。**必须在捕获阶段**：
     * jsMind 对节点（尤其**根节点**）的 mousedown 会 stopPropagation ✗ ⇒ 冒泡阶段收不到，
     * 表现为"Ctrl 点根节点没反应"（实测踩到 ✓）。捕获阶段先于 jsMind ✓ */
    document.addEventListener('mousedown', (e) => {
      const additive = !!(e.ctrlKey || e.metaKey);
      if (!additive || e.button !== 0 || fdDragMode) return;
      const cont = document.getElementById('mindmap-container');
      if (!cont || !cont.contains(e.target)) return;
      if ((e.target.closest && (e.target.closest('.float-detail') || e.target.closest('#mm-node-toolbar')))
        || (MM.fdIsSatelliteTarget && MM.fdIsSatelliteTarget(e.target))) return;
      const nodeEl = e.target.closest && e.target.closest('jmnode[nodeid]');
      if (!nodeEl) return;
      e.preventDefault();
      e.stopPropagation();
      if (MM.toggleNodeSelection) MM.toggleNodeSelection(nodeEl.getAttribute('nodeid'));
    }, true);

    document.addEventListener('mousedown', (e) => {
      const cont = document.getElementById('mindmap-container');
      if (!cont || !cont.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.float-detail')) return;
      // 卫星浮层同样不算"点框外" —— 否则点一下圆钮会顺手把选区清掉 ✗（圆钮原先在框里，靠上面那条挡住）
      if (MM.fdIsSatelliteTarget && MM.fdIsSatelliteTarget(e.target)) return;
      // ⑥ 多选：Ctrl（或 Mac 的 Cmd）按住时——**加选**语义（用户反馈⑥）：
      //   · Ctrl+点击节点 ⇒ 捕获阶段已处理（见上）✓；
      //   · Ctrl+框选 ⇒ 在**已有选区**上继续加（普通框选是"重新选"）。
      const additive = !!(e.ctrlKey || e.metaKey);
      // 框选：主界面空白处左键按下 = 开始框选（节点上按下不算——那是选中/详情）。
      // 已有选区时点击**框外**（空白或节点）→ 先清除选区再按普通逻辑走（加选时**不清** ✓）。
      if (e.button === 0 && !fdDragMode && (!fdSelection.length || additive)
        && (e.target.tagName === 'JMNODES' || e.target.tagName === 'CANVAS'
          || (e.target.closest && e.target.closest('jmnodes, canvas.jsmind')))) {
        const pt = panelPoint(e.clientX, e.clientY);
        fdRubber = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
        fdRubberAdditive = additive;
        // ⚠️ 并集的**基**必须是"原始命中共"（fdSelectionRaw），不是裁剪后的 fdSelection：
        //    裁剪（同父/父冗余）是给树操作定义的口径 ⇒ 用它当基会把用户明明框住的节点**悄悄丢掉** ✗
        //    （实测：加选一次，选区从 2 个变 1 个 ✓ 这条是断言抓出来的真缺陷）
        fdRubberBase = additive ? fdSelectionRaw.slice() : [];
        const el = ensureRubberEl();
        el.style.display = 'block';
        e.preventDefault();
        return;
      }
      if (e.button === 0 && fdSelection.length && !fdDragMode && !additive) {
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
          if (fdDragKind === 'reorder') {
            // 【R2 期 3 · e】同级重排：按在锁定的那个节点上才开始（按别处什么都不做 —— 与"拖动此子树"
            // 只认目标子树同一条纪律）；拖动期间**一个偏移桶都不写**，只有副本跟指针走。
            const hitEl = e.target && e.target.closest && e.target.closest('jmnode[nodeid]');
            const hitId = hitEl ? hitEl.getAttribute('nodeid') : null;
            if (hitId === fdDragTreeRoot) reorderBegin(e.clientX, e.clientY);
          } else if (fdDragKind === 'reparent') {
            // 【R2 期 4 · f】重挂父：同一条纪律（按在锁定的节点上才开始）；副本跟指针走，
            // 松手把 (id, 压着的节点) 交给写通道 —— 拖动期间不写盘、不动内存树。
            const hitEl = e.target && e.target.closest && e.target.closest('jmnode[nodeid]');
            const hitId = hitEl ? hitEl.getAttribute('nodeid') : null;
            if (hitId === fdDragTreeRoot) reparentBegin(e.clientX, e.clientY);
          } else {
            const o = treeOffsets[fdDragTreeRoot] || (treeOffsets[fdDragTreeRoot] = { x: 0, y: 0 });
            fdTreeDragStart = { x: e.clientX, y: e.clientY, ox: o.x, oy: o.y };
          }
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
      if (fdReorderStart) {              // 【R2 期 3 · e】同级重排：副本跟指针 + 落位预览
        e.preventDefault();
        reorderUpdate(e.clientX, e.clientY);
        return;
      }
      if (fdReparentStart) {             // 【R2 期 4 · f】重挂父：副本跟指针 + 落点（压着的节点）
        e.preventDefault();
        reparentUpdate(e.clientX, e.clientY);
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

    document.addEventListener('mouseup', (e) => {
      // 【R2 期 3 · e】同级重排：**松手才写盘**（拖动期间盘上零写入由构造保证 —— 这一档
      // 一个偏移桶都不写、序列化文本也一个字不变）。写盘只经 MMApp.reorderNodeChild → CLI move。
      if (fdReorderStart) {
        e.preventDefault();
        const r = reorderEnd();
        if (!r.ok) {
          setStatus('没有重排：' + r.reason, true);          // 不静默 ✗
        } else {
          const p = (window.MMApp && window.MMApp.reorderNodeChild)
            ? window.MMApp.reorderNodeChild(r.id, r.parent, r.index) : null;
          if (!p) { setStatus('没有重排：缺少 reorderNodeChild 入口（没接上 CLI 的 move）', true); }
          else {
            Promise.resolve(p).then((res) => {
              if (res && res.ok) {
                setStatus('已把「' + (res.topic || r.id) + '」移到第 ' + (r.index + 1) + ' 位（盘上顺序已更新）');
              } else {
                setStatus('重排没生效：' + ((res && res.text) || '未知原因'), true);
              }
            }).catch((err) => setStatus('重排失败：' + ((err && err.message) || err), true));
          }
        }
        document.body.classList.remove('mm-dragging');
        const pnl = fdPanel();
        if (pnl) pnl.style.cursor = fdDragMode ? 'grab' : '';
        return;
      }
      // 【R2 期 4 · f】重挂父：**松手才进入三道闸**（拖动期间盘上零写入由构造保证 —— 这一档
      // 一个偏移桶都不写、序列化文本也一个字不变）。写盘只经 MMApp.reparentNode →
      // 落位预览（演练副本）→ 确认 → IPC → CLI apply（--dry-run 预检 + move op 唯一实现）→ 回读重建。
      if (fdReparentStart) {
        e.preventDefault();
        const rr = reparentEnd();
        if (!rr.ok) {
          setStatus('没有重挂：' + rr.reason, true);          // 不静默 ✗
        } else {
          const p = (window.MMApp && window.MMApp.reparentNode)
            ? window.MMApp.reparentNode(rr.id, rr.parent) : null;
          if (!p) { setStatus('没有重挂：缺少 reparentNode 入口（没接上 CLI 的 move 语义）', true); }
          else {
            Promise.resolve(p).then((res) => {
              if (res && res.ok) {
                setStatus('已把「' + (res.topic || rr.id) + '」挂到新的父节点下（盘上父子关系已更新）');
              } else {
                setStatus('重挂没生效：' + ((res && res.text) || '未知原因'), true);
              }
            }).catch((err) => setStatus('重挂失败：' + ((err && err.message) || err), true));
          }
        }
        document.body.classList.remove('mm-dragging');
        const pnlR = fdPanel();
        if (pnlR) pnlR.style.cursor = fdDragMode ? 'grab' : '';
        return;
      }
      // 框选收尾：中心点/过半面积命中的可见节点入选（与预览同口径）
      if (fdRubber) {
        const band = rubberBand();
        const additive = fdRubberAdditive;
        const base = fdRubberBase || [];
        fdRubber = null; fdRubberAdditive = false; fdRubberBase = null;
        const el = ensureRubberEl();
        if (el) el.style.display = 'none';
        clearRubberPreview();
        // 太小的拖拽（<8px）视为误触/点击 → 清选区不框（加选时不清：那会把人已有的选区弄没 ✗）
        if (!band || band.x1 - band.x0 < 8 || band.y1 - band.y0 < 8) { if (!additive) clearSelection(); return; }
        const hit = visibleNodeRects()
          .filter((r) => nodeSelectedBy(r, band))
          .map((r) => r.id);
        // Ctrl+框选 = **加选**（用户反馈⑥）：在原选区基础上并集，而不是替换 ✓
        const merged = additive ? Array.from(new Set(base.concat(hit))) : hit;
        const res = applySelection(merged, merged);
        if (!merged.length) setStatus('框选为空');
        else if (res.dropped > 0) {
          setStatus('已框选 ' + res.kept + ' 个节点' + (additive ? '（加选，共 ' + res.kept + '）' : '')
            + '（另有 ' + res.dropped + ' 个跨父/已被包含的节点被过滤；右键框内可拖动/收起/展开）');
        } else {
          setStatus('已框选 ' + res.kept + ' 个节点' + (additive ? '（加选）' : '') + '（右键框内可拖动/收起/展开）');
        }
        return;
      }
      if (fdTreeDragStart) {
        fdTreeDragStart = null;
        // ⑨「拖进侧栏」：**在面板最右侧松手** = 把这棵树交给右侧 DSH 侧栏 ✓。
        // 为什么是"最右侧"而不是"真落在侧栏上"：侧栏是主进程的**原生 WebContentsView**，
        // 指针一进去渲染层就收不到事件（连 mouseup 都收不到 ⇒ 拖动会卡住 ✗）⇒ 跨视图协调得由主进程做
        // （下一步再做）。取"距面板右缘 ≤ 24px 松手"是**渲染层自己就能判定**的边界手势 ✓
        const pnl9 = fdPanel();
        const pr9 = pnl9 ? pnl9.getBoundingClientRect() : null;
        if (pr9 && e && e.clientX >= pr9.right - 24 && fdDragTreeRoot && MM.sendNodesToSidebar) {
          MM.sendNodesToSidebar([fdDragTreeRoot]);
          if (pnl9 && fdDragMode) pnl9.style.cursor = 'grab';
          document.body.classList.remove('mm-dragging');
          return;
        }
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
        clearReorderArtifacts();     // 重排档：连副本/落位线一起收掉（退出拖动模式即取消这次拖动）
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

  /** 用平移把**某个节点**摆到面板正中（先应用当前缩放/平移，再据真实矩形测量）。
   *
   * 这是本工程**唯一**一处"把某个节点摆进视口"的实现（`R7-0` 起把原先只认 `'root'` 的那一版
   * 节点级化）：点站内链接跳到目标节点、以及打开项目时把根摆正，都走它 —— 别在调用点各算一套
   * 平移（同一件事两处表达 ⇒ 必然漂，本工程反复治过的病）。
   *
   * @param {string} id 节点 id（`'root'` 就是原来的行为）
   * @param {{always?:boolean}} [opts] `always:true` ⇒ **无条件**摆到正中（打开项目/还原视图用，
   *   与改动前逐字节相同）；默认 `false` ⇒ 目标**已完整落在面板内**时**不动视野**
   *   （点链接跳到眼前这个节点时，不该把整张图挪一下 —— 那是用户没要求的副作用 ✗）。
   * @returns {boolean} 真的发生了平移 ⇒ true；没动（已可见 / 找不到节点或面板）⇒ false
   */
  function centerOnNode(id, opts) {
    if (!state.jm || !id) return false;
    neutralizeScroll();
    fdApplyView(); // 先让当前 fdView（含最新 s）落到 DOM，否则测量的是旧缩放下的矩形
    const p = fdPanel();
    const nodeEl = document.querySelector('#jsmind_container jmnode[nodeid="' + id + '"]');
    if (!p || !nodeEl) return false;
    const nr = nodeEl.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    if (nr.width <= 0 || nr.height <= 0) return false;   // 折叠/未渲染的节点：几何是 0×0，挪了也没用
    const inside = nr.left >= pr.left && nr.top >= pr.top && nr.right <= pr.right && nr.bottom <= pr.bottom;
    if (inside && !(opts && opts.always)) return false;   // 已经完整看得见 ⇒ 不动视野（见 @param）
    fdView.x += (pr.left + pr.width / 2) - (nr.left + nr.width / 2);
    fdView.y += (pr.top + pr.height / 2) - (nr.top + nr.height / 2);
    fdApplyView();
    return true;
  }

  /** 打开项目 / 还原视图时把根节点摆到面板正中（= `centerOnNode('root')` 的**无条件**那一档） */
  function centerOnRoot() { return centerOnNode('root', { always: true }); }

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

  /* ================= 【R2 期 3 · d】线端**按子序分散**（连线不打架） =================
   * 问题（**已实测**，不是"读源码推断"）：一个父节点有 N 个子节点时，N 条线**共用父的同一个
   * 侧边中点**。真读数（`comnet`，2026-10-16：
   * `.review/20261014-导图交互重构/probe-line-endpoints.js` 现量）：
   *   · 135 个"扇出 ≥ 3"的父，**每一个都只有 1 个不同的父端点**；
   *   · 766 条线的父端落在同一个点上；最大扇出 13 个孩子的父端**全部重合**于
   *     `(2194, 5927)` = 父矩形 `[1923,5908,2194,5946]` 的右边框中点。
   * ⇒ 视觉上是"一团线从一个点炸开"，看不出哪条线接哪个孩子。
   *
   * 打法（**只改几何、不改节点位置、不改数据**）：把同一个父的**同一侧**的 N 个孩子按
   * **上下序**排个名次，父端落到该侧边框上的等分点；子端仍是孩子自己的侧边中点。
   *
   * 为什么是"上下序"而不是别的顺序（这条决定了"交叉数不增"能不能成立）：
   *   `children` 数组的顺序**就是**上下序（要求 e 的语义），而 jsMind 把父子纵向居中
   *   ⇒ 孩子 i 的屏幕 cy 随 i 单调。于是"名次 i ⇒ 边框上第 i 个等分点"的两条序列
   *   （父端 y 名次递增、子端 y 名次递增）**同时单调** ⇒ 同一组里任意两条线段
   *   **不可能相交**（`min(p_i,p_j) > max(c_i,c_j)` 一类的不相交判据恒成立 —— 与
   *   手工偏移无关：偏移只改 cy 的值、不改"按 cy 排名"这件事）。
   *   实测：真 comnet 的 13 个孩子一组上，现状 0 交叉、本口径 0 交叉；把口径换成
   *   "按 id 字典序分散"同一组立刻 **34 交叉**（同一次现算，见 `probe-crossings.js`）
   *   ⇒ 这条判据不是恒真的（判别力证明见冒烟域 48 的断言②）。
   *
   * ⚠️ 端点真源**仍然只有 `nodeBorderRect` 一处**：本函数只决定"父端在这条边框上的**哪个点**"，
   *   坐标本身一律来自 `nodeBorderRect(parentEl, …)`；子端直接用它的侧边中点。
   *   绝不再算第二份边框（本工程修过的缺陷："端点真源被 get_node_point_in/out 的布局缓存污染"）。 */
  const LINE_ENDPOINT_SCHEMES = ['order', 'reverse'];
  let fdLineEndpointScheme = 'order';   // 'order' = 上下序（默认，正确口径）；'reverse' = 只给判别力证明用

  /** 线端分散口径开关。**只有冒烟域 48 的判别力证明会切它**：切到 `'reverse'`（把名次整个**反过来**）
   *  是为了让"交叉数不增"那条判据**当场变红**，证明它不是恒真；默认值就是产品口径。
   *  ⚠️ 为什么不是"按 id 字典序"（第一版那样写，实测**没能变红** ✗）：字典序在具体夹具上可能与
   *  上下序**恰好一致**（`f1..f8` 排在 `n1..n4` 之后、而它们的 y 也更大 ⇒ 一交叉都没有）⇒
   *  注入形同虚设。把名次**倒过来**则**必然**与上下序相反 ⇒ 任何扇出 ≥ 2 的父都会立刻相交 ✓。 */
  function setLineEndpointScheme(name) {
    if (LINE_ENDPOINT_SCHEMES.indexOf(name) < 0) return null;
    fdLineEndpointScheme = name;
    return fdLineEndpointScheme;
  }

  /** 父→子 的**组**（同一侧、同一个父的孩子）与它们的父端落点。
   *  分组按"孩子在父的左/右"判（与既有的相邻侧判定逐字同源：`childRect.cx < parentRect.cx`）。
   *  返回 `{ [childId]: {x, y} }`；`x` 恒等于父的那条侧边（端点**仍在边框上** ✓）。
   *  `unknown` = 取不到节点边框的孩子数（采不到真值 ⇒ 调用方如实报出来，不装作零）。 */
  function lineParentPoints(parentEl, parentId, children) {
    const pb = nodeBorderRect(parentEl, parentId);
    const groups = { left: [], right: [] };
    const unknown = [];
    (children || []).forEach((t) => {
      const el = document.querySelector('jmnode[nodeid="' + t.id + '"]');
      if (!el) { unknown.push(t.id); return; }
      const cb = nodeBorderRect(el, t.id);
      (cb.cx < pb.cx ? groups.left : groups.right).push({ id: t.id, cy: cb.cy, index: t.index });
    });
    const out = {};
    ['left', 'right'].forEach((side) => {
      const list = groups[side];
      list.sort((a, b) => (a.cy - b.cy)
        || ((fdLineEndpointScheme === 'reverse' && String(a.id) < String(b.id)) ? -1 : 0)
        || ((fdLineEndpointScheme === 'reverse' && String(a.id) > String(b.id)) ? 1 : 0)
        || ((typeof a.index === 'number' && typeof b.index === 'number') ? (a.index - b.index) : 0));
      if (fdLineEndpointScheme === 'reverse') list.reverse();   // 判别力注入：把名次整个反过来
      const n = list.length;
      list.forEach((it, rank) => {
        out[it.id] = n > 1
          ? { x: side === 'left' ? pb.left : pb.right, y: pb.top + (pb.bottom - pb.top) * (rank + 1) / (n + 1) }
          : { x: side === 'left' ? pb.left : pb.right, y: pb.cy };   // 独子 ⇒ 与改动前逐字节相同
      });
    });
    return { points: out, unknown: unknown, groups: { left: groups.left.length, right: groups.right.length } };
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
      // 第一遍：线端 = 父子节点**相邻侧边框上的点**。直接读节点实际 DOM 边框（nodeBorderRect，
      // 已含 view offset 与树偏移），**不再用** get_node_point_in/out 布局缓存、也不再加 off。
      // 【R2 期 3 · d】父端**按子序分散**（见 lineParentPoints 的头注释）：同一父同一侧的孩子
      // 各自落在这条边框的一个等分点上，不再共用同一个中点。子端仍是孩子的侧边中点。
      const lines = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      window.__mmEndpointUnknown = [];
      const parents = [];
      for (const id in nodes) {
        const t = nodes[id];
        if (t.isroot) continue;
        if (!this.layout.is_visible(t)) continue;
        if (fdHideRootLinks && t.parent && t.parent.isroot) { window.__mmSkippedLines += 1; continue; }
        if (!t.parent) continue;
        const parentEl = document.querySelector('jmnode[nodeid="' + t.parent.id + '"]');
        const childEl = document.querySelector('jmnode[nodeid="' + t.id + '"]');
        if (!parentEl || !childEl) continue;
        parents.push({ t: t, parentEl: parentEl, childEl: childEl });
      }
      // 同一父只算一次分组（分组要"这个父的**全部**可见孩子"，不是逐条各算各的）
      const byParent = {};
      parents.forEach((p) => { (byParent[p.t.parent.id] = byParent[p.t.parent.id] || []).push(p); });
      for (const pid in byParent) {
        const group = byParent[pid];
        const pts = lineParentPoints(group[0].parentEl, pid, group.map((p, i) => ({
          id: p.t.id, index: (typeof p.t.index === 'number' ? p.t.index : i)
        })));
        window.__mmEndpointUnknown = window.__mmEndpointUnknown.concat(pts.unknown);
        group.forEach((p) => {
          const pb = nodeBorderRect(p.parentEl, pid);
          const cb = nodeBorderRect(p.childEl, p.t.id);
          const pt = pts.points[p.t.id];
          // 采不到落点（理论上不会：同一次查询里 parentEl 在、childEl 也在）⇒ 退回**改动前的口径**
          //（父端 = 侧边中点）。这不是"兜底假装成功"：它让"偶发取不到"与"取到了"可分辨，
          // 且退回的那一支与改动前逐字节相同（域 48 的断言①能看出条数变少）。
          const px = pt ? pt.x : (cb.cx < pb.cx ? pb.left : pb.right);
          const py = pt ? pt.y : pb.cy;
          const cx = cb.cx < pb.cx ? cb.right : cb.left;
          const cy = cb.cy;
          lines.push({ parent: pid, child: p.t.id, px: px, py: py, cx: cx, cy: cy,
            color: p.t.data && p.t.data['leading-line-color'] });
          if (px < minX) minX = px; if (cx < minX) minX = cx;
          if (py < minY) minY = py; if (cy < minY) minY = cy;
          if (px > maxX) maxX = px; if (cx > maxX) maxX = cx;
          if (py > maxY) maxY = py; if (cy > maxY) maxY = cy;
        });
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
      label.textContent = (MM.adapter.getNode(jm, 'root') || {}).topic || '';
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

  /* —— （a）「方向」的界面入口（R2 期 1）——
   * **只把已有的顶层分侧语义变成可点**，不新增任何方向能力：
   *   · 底层语义 = `meta.layout` + `applyThemeLayout`（jsMind **只认 root 直接子节点的 direction**，
   *     更深的节点声明会被库忽略并改写成 right —— 已由实测探针钉住，
   *     见 `.review/20261014-导图交互重构/probe-direction-nonroot.js` 与设计稿 §2.2.1）；
   *   · 所以这一条**只对顶层主题开放**，给深层节点用是骗人（库根本不理）⇒ 非顶层主题一律拒绝；
   *   · 落地方式**不是**改库、也不是给节点写 direction，而是改 `meta.layout` 后
   *     **走"打开项目"那一套重渲染**（`MM.rebuildFromJson` ⇒ renderMind 里 `applyThemeLayout`
   *     在 `jm.show` **之前**打 direction）—— 与"改数据文件里那一行"完全同一条路，
   *     零新契约、零新语义。
   * 返回值给断言与菜单用（`ok:false` 必带 `reason`，不静默）。 */

  /** 顶层主题分侧现状（`'left'` / `'right'` / `null` = 数据里没列 ⇒ 库默认右侧） */
  function themeSideOf(nodeId) {
    const layout = state.metaLayout || {};
    if ((layout.left || []).indexOf(nodeId) >= 0) return 'left';
    if ((layout.right || []).indexOf(nodeId) >= 0) return 'right';
    return null;
  }

  /** 把一个**顶层主题**摆到左侧/右侧：改 meta.layout（唯一真源）→ 重渲染 → 落盘。
   *  ⚠️ 重渲染 = `rebuildFromJson`（与撤销/重做同一个入口，`collapseToRoot:false`）：
   *  它**会**丢掉视图态（平移/缩放复位、详情框关闭、选区清空）—— 这是"改了分侧就得重新布局"
   *  的必然代价，故在状态栏如实说出来，别让用户以为界面抖了一下是故障。
   *  偏移不丢：`renderMind` 从数据恢复两个偏移键（meta.themeOffsets / meta.nodeOffsets）✓。 */
  async function setThemeSide(nodeId, side) {
    const jm = state.jm;
    if (!jm) return { ok: false, reason: '导图尚未就绪' };
    const n = MM.adapter.getNode(jm, nodeId);
    if (!n || n.isroot) return { ok: false, reason: '根节点没有分侧（它是容器）' };
    if (!n.parent || !n.parent.isroot) {
      return { ok: false, reason: '只有顶层主题能分侧（jsMind 只认 root 直接子节点的 direction）' };
    }
    const want = side === 'left' ? 'left' : 'right';
    const old = state.metaLayout || {};
    const other = want === 'left' ? 'right' : 'left';
    const pick = (k) => (Array.isArray(old[k]) ? old[k] : []).filter((id) => id !== nodeId);
    const layout = {};
    layout.left = want === 'left' ? pick('left').concat([nodeId]) : pick('left');
    layout.right = want === 'right' ? pick('right').concat([nodeId]) : pick('right');
    // 两侧都空 ⇒ 不写空数组（数据形状与从前一致：没分过侧的项目就是没有 layout 键）
    if (!layout.left.length) delete layout.left;
    if (!layout.right.length) delete layout.right;
    const data = MM.serializeTree();
    if (!data) return { ok: false, reason: '序列化失败（没有当前树？）' };
    data.meta.layout = layout;
    MM.rebuildFromJson(data);            // ← 唯一入口：方向在"载入时"生效（见本段抬头）
    const saved = await save();          // 落盘（判据要的是"盘上 meta.layout 里有它"）
    setStatus('已把「' + n.topic + '」摆到' + (want === 'left' ? '左' : '右') + '侧'
      + (saved ? '（已保存）' : '（**保存失败**，盘上还没变 ✗）')
      + ' —— 分侧是顶层主题级语义，视图已按新布局重建');
    return { ok: true, side: want, layout: layout, saved: !!saved };
  }

  /** 依项目 meta 应用主题模式（渲染时调用） */
  function applyRootMode(jm, data) {
    const themed = fdIsThemeMode(data);
    state.rootMode = themed ? 'themes' : 'tree';
    applyRootModeVisual(jm, themed);
  }

  /** 切换主题模式（立即生效：方框显隐 + 连线重画） */
  function setRootMode(mode) {    const jm = state.jm;
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

  /* ================= 【R5 · R2 期 5】结构轴 = 树结构 / 复杂结构 =================
   * 用户 2026-10-14 插入的 R5：显示逻辑要分**两条轴** —— 树结构（既有父子树）与复杂结构
   * （节点之间的连接关系不限于父子；边来自既有 `links[]` / `assoc[]` 两处表达，不新造字段）。
   *
   * ⚠️ **这不是**上面那条 `setRootMode` 轴：那条管的是「容器根显隐 + 根→顶层主题连线」、
   *   持久化在 `meta.rootMode`；本条管的是「**边从哪来**」。两件事塞进一个键 = 一次改动写两件事 ✗
   *   ⇒ 两条轴各自一个状态、各自一个入口，互不读写对方（域 51 有"两条轴正交"的判据）。
   *
   * 口径（用户 2026-10-16 拍板，本文件是它的**唯一实现**）：
   *   · **会话级内存**：不写项目、不写 `meta`、不写应用偏好 —— 切模式**零序列化写入**；
   *   · **默认 = 树结构**；**启动 / 切项目 ⇒ 回树结构**（不跨会话记忆，见 resetStructureMode）；
   *   · 开放 `MM.structureMode()` 读数出口给菜单文案与冒烟断言（域 51）。
   *
   * 复杂档的呈现**不重写任何取舍**：直接复用关系层的**唯一入口** `MM.showRelated`
   * （`renderer/app-related.js`）⇒「跨项目只标不画」「同一篇关联笔记成员之间不超过既有
   * `CLIQUE_MAX` 才画团边、超过就不画」这些既有口径**一个字都没有第二份**（线数由域 51 与
   * 既有模型现算对拍）。代价如实写在这里：它同时会开「关联信息」编辑条并把视图缩放到刚好
   * 框住 —— 那正是点 🔗 的同一套呈现（换来的是一条不重复的实现 ✓）。
   */
  let fdStructureMode = 'tree';        // 'tree' | 'complex'（会话级；不进任何序列化产物）

  /** 当前结构轴模式（菜单文案与冒烟断言读它） */
  function structureMode() { return fdStructureMode; }

  /** 会话级复位：**启动 / 切项目**回树结构（调用点在 app-actions.js 的 openProject）。
   *  只动这一个内存读数：不碰关系层状态、不写盘、不改 `meta.rootMode` 那条旧轴。 */
  function resetStructureMode() { fdStructureMode = 'tree'; return fdStructureMode; }

  /** 切结构轴模式（菜单项的 action）。返回 Promise<{ok, mode, related, reason?}>；拿不到真值时
   *  必带 reason 且**响亮说**（不静默 ✗）：
   *   · `'tree'`    ⇒ 关系层走既有唯一出口 `MM.clearRelated()`（幂等）；
   *   · `'complex'` ⇒ 对**当前选中节点**调既有 `MM.showRelated`；**没选中就响亮说**，层保持原样；
   *   切档途中又被切回去（showRelated 内部有两次 IPC ⇒ 是异步的）⇒ 不把过期那一层留在屏上。 */
  async function setStructureMode(mode) {
    const want = mode === 'complex' ? 'complex' : 'tree';
    if (fdStructureMode === want) { setStatus('已是该模式'); return { ok: true, mode: want, related: null }; }
    fdStructureMode = want;
    if (want === 'tree') {
      if (MM.clearRelated) MM.clearRelated();
      setStatus('已回到树结构模式：只画父子骨架');
      return { ok: true, mode: want, related: null };
    }
    if (typeof MM.showRelated !== 'function') {
      setStatus('复杂结构模式：拿不到 MM.showRelated（关系层没加载）⇒ 自由边画不出来', true);   // 不静默 ✗
      return { ok: false, mode: want, related: null, reason: '缺 MM.showRelated' };
    }
    const jm = state.jm;
    const sel = (jm && MM.adapter && MM.adapter.available(jm)) ? MM.adapter.getSelected(jm) : null;
    if (!sel || !sel.id) {
      setStatus('已切到复杂结构模式：选一个节点（或右键 → 🔗 关联节点），它的自由边就画在图上', true);
      return { ok: true, mode: want, related: null, reason: '没有选中节点' };
    }
    const related = await MM.showRelated(sel.id);      // 它自己会报"画了几条线"（不重复报）
    if (fdStructureMode !== 'complex') {               // 等待期间被切回树结构 ⇒ 别留过期的一层
      if (MM.clearRelated) MM.clearRelated();
      return { ok: true, mode: fdStructureMode, related: related, reason: '切换期间已切回树结构' };
    }
    return { ok: true, mode: want, related: related };
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

  function expandAll() { const jm = state.jm; if (jm) { MM.adapter.expandAll(jm); setStatus('已全部展开'); } }
  /** 收起（v0.16.2 修复）：jm.collapse_all() 会把 root 也折叠 → 容器根隐藏后
   *  什么都看不到（用户实测）。改为只收起**顶层主题**（root 保持展开），
   *  即"收起到树根"：主题的孙辈及以下全部收进主题节点。 */
  function collapseAll() {
    const jm = state.jm;
    if (!jm) return;
    const root = MM.adapter.getNode(jm, 'root');
    let n = 0;
    (root.children || []).forEach((tp) => {
      if (MM.adapter.getNode(jm, tp.id).children && MM.adapter.getNode(jm, tp.id).children.length) {
        MM.adapter.collapseNode(jm, tp.id);
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
  MM.pinViewOffset = wrapLayoutAnchor;           // 兼容旧名（实为"重排锚点保持"，见函数头注释）
  MM.wrapLayoutAnchor = wrapLayoutAnchor;
  MM.resetLayoutAnchor = resetLayoutAnchor;
  MM.neutralizeScroll = neutralizeScroll;
  MM.zoomViewAt = zoomViewAt;
  MM.setViewScale = setViewScale;
  MM.setViewTransform = setViewTransform;   // 精确设 (s,x,y)：fit「刚好框住这些节点」用（app-related.js）
  MM.centerOnNode = centerOnNode;           // 把某个节点摆进视口（**唯一**实现；站内链接跳转用它）
  MM.getPanState = getPanState;
  MM.setDragMode = setDragMode;
  MM.dragModeActive = dragModeActive;
  MM.getDragTreeRoot = getDragTreeRoot;
  MM.dragModeKind = dragModeKind;            // 'move' / 'reorder' / 'reparent'（断言用它分辨三档）
  MM.reorderState = reorderState;            // 重排拖动的现状读数（目标 / 落位 / 上界）
  MM.reorderCancel = reorderCancel;          // 收尾/取消（清 DOM + 复位，不拆成两份）
  MM.reparentState = reparentState;          // 【R2 期 4 · f】重挂拖动的现状读数（目标 / 压着的节点）
  MM.reparentCancel = reparentCancel;        // 收尾/取消（与 reorderCancel 同一份清理，不拆成两份）
  MM.treeRootOf = treeRootOf;
  MM.applyTreeOffsets = applyTreeOffsets;
  MM.clearTreeOffsets = clearTreeOffsets;
  MM.getTreeOffsets = getTreeOffsets;   // 序列化取偏移的唯一入口（app-core.js 的 serializeTree）
  MM.getNodeOffsets = getNodeOffsets;   // 同上，另一桶（更深子树根 ⇒ meta.nodeOffsets）
  MM.hasOwnOffset = (id) => !!ownOffsetFor(id);   // 右键菜单「移回自动布局」的显示条件
  MM.setTreeOffsets = setTreeOffsets;   // 打开项目/undo 后从 meta.themeOffsets + meta.nodeOffsets 恢复
  MM.themeSideOf = themeSideOf;         // 顶层主题分侧现状（右键菜单文案 + 断言）
  MM.setThemeSide = setThemeSide;       // （a）方向入口：只对顶层主题开放（见函数头）
  MM.computeTreeBounds = computeTreeBounds;
  MM.showTreeOutline = showTreeOutline;
  MM.syncTreeOutline = syncTreeOutline;
  MM.hideTreeOutline = hideTreeOutline;
  /** ⑥ Ctrl+点击：把一个节点**加入/移出**选区（不打开详情框 ✓ 用户反馈⑥的多选入口之一）。
   *  与框选共用同一个选区模型（`applySelection`）⇒ 虚线框、右键菜单、AI 提问看到的都是同一份 ✓
   *
   *  ⚠️ **判据与并集的基都必须是「原始命中集」`fdSelectionRaw`（本轮真机缺陷的根因）**：
   *  原先用裁剪集 `fdSelection` 判"这个节点在不在选区里"，而裁剪集是**给树操作定义的口径**
   *  （剔父冗余 + 同父只留一组）—— 父节点也在选区时，它的**子节点会被整个剔出去**
   *  ⇒ 于是：① 再 Ctrl 点一次那个子节点**取消不掉**（判"不在选区"⇒ 又加一遍）；
   *          ② 下一次点别的节点时，`fdSelection.concat([id])` 会把它**冲掉**（描边凭空消失）✗。
   *  真机复现（`scripts/smoke/36-real-input.js` ②③，真鼠标事件 + 像素判据）：
   *    Ctrl 点 wlan-book → wlan-01（它的子）→ comp-net ⇒ raw 变成 [wlan-book,comp-net]，
   *    **wlan-01 的虚线描边消失**、工具条 N=2（用户点了 3 个）；
   *    再 Ctrl 点 wlan-01 ⇒ raw 仍是 [wlan-book,wlan-01]（取消不掉）。
   *  ⇒ 用户要的是"我点过谁，谁就带描边"（"全部都包住"）⇒ **唯一真源只能是 raw** ✓ */
  function toggleNodeSelection(id) {
    if (!id) return { kept: 0, added: false };
    const has = fdSelectionRaw.indexOf(id) >= 0;
    const next = has ? fdSelectionRaw.filter((x) => x !== id) : fdSelectionRaw.concat([id]);
    // raw = next（未裁剪 ✓）⇒ paintRawSelection 会给**每一个**被选中节点描边（"全部都包住" ✓）；
    // hideBox：Ctrl 加选不画大虚线框 ✓（大框是框选的概念 ✓）
    const res = applySelection(next, next, { hideBox: true });
    // 状态里报**原始命中数**（= 用户看到的描边数 ✓）；批量操作作用几个也如实说 ✓
    setStatus(has ? ('已从选区移除（剩 ' + fdSelectionRaw.length + ' 个）')
      : ('已加入选区（共 ' + fdSelectionRaw.length + ' 个已描边' + (res.kept !== fdSelectionRaw.length ? '；批量操作按其所属树取 ' + res.kept + ' 个' : '') + '；Ctrl+点击可加/减、右键可批量操作）'));
    return Object.assign({ added: !has }, res);
  }

  /** P7：向主进程要"落点回执"（抽成 MM 上的小函数 ⇒ 冒烟可替换它来判"回执驱动投喂"这条接线 ✓）。
   *  没有桌面 API（纯浏览器里跑）⇒ 返回 null（= 没有回执 ⇒ 不投喂 ✓ 不静默假成功 ✗）。 */
  function requestSelDropVerdict(pt) {
    if (window.desktop && window.desktop.dsh && window.desktop.dsh.selDragEnd) return window.desktop.dsh.selDragEnd(pt);
    return null;
  }
  MM.requestSelDropVerdict = requestSelDropVerdict;
  /* P7 跨视图兜底：主进程判出「光标停在原生侧栏视图上 ≥400ms ⇒ 就是在这儿松手」之后，
   * 把 ids 发回来 ⇒ 这里投喂（走同一条 sendNodesToSidebar ✓）并清掉那份可能一直挂着的拖拽状态 ✓。
   * 注册在 IIFE 顶层：只绑一次 ✓ 且与 fdSelDrag 同作用域 ✓。preload 老版本没这个 key 时退化为
   * 「只有页面内松手才送」✓，并留一句日志（不静默 ✗）。 */
  if (window.desktop && window.desktop.dsh && window.desktop.dsh.onSelDrop) {
    try {
      window.desktop.dsh.onSelDrop((ids) => {
        fdSelDrag = null;
        if (ids && ids.length && MM.sendNodesToSidebar) MM.sendNodesToSidebar(ids);
      });
    } catch (e) { console.log("P7 跨视图兜底接线失败：" + ((e && e.message) || e)); }
  }
  /* 「圆钮贴哪边」的判定**已搬走**：它属于圆钮自己 —— 见 app-assoc.js 的 MM.layoutRelShowBtn，
   * 由 MM.syncFdSatellites 一处调用（一份事实一处实现 ✓）。
   * 搬走的理由（实测）：圆钮原先写在详情框里、位置"交回 CSS"（left:-54px），于是被**框自己的**
   * overflow:hidden 裁掉 —— 而 getBoundingClientRect() 看不出被裁，断言一直绿。
   * 现在它挂在卫星浮层里、位置**显式**由框的 frame 算出（.review/20261009-圆钮工具栏绑定/probe-clip.js）。 */
  MM.toggleNodeSelection = toggleNodeSelection;
  MM.clearSelection = clearSelection;
  MM.applySelection = applySelection;
  MM.refreshSelectionOutline = refreshSelectionOutline;
  MM.nodeSelectedBy = nodeSelectedBy; // 冒烟断言用（纯几何判定）
  MM.getSelection = () => ({
    count: fdSelection.length,
    ids: fdSelection.slice(),
    groups: selectionByParent()
  });
  /** 「现在有没有选区」= **有没有节点被描边** ⇒ 真源是原始命中集（`fdSelectionRaw`）。
   *  原先读裁剪集：父与子一起选中时子会被剔掉 ⇒ 某些组合下"画面明明有描边、这里说没有"
   *  ⇒ 工具条 `barTargets()` 会退回单节点分支（N 与实际参与提问的集合对不上 ✗）。
   *  （`fdSelection` 仍是**树操作**的口径 —— 收起/拖动/右键批量都按它 ✓ 两者分工不同，别合并 ✗） */
  MM.hasSelection = () => fdSelectionRaw.length > 0;
  MM.selectionHitTest = selectionHitTest;
  MM.dragSelection = dragSelection;
  MM.collapseSelection = collapseSelection;
  MM.expandSelection = expandSelection;
  MM.bindViewportControls = bindViewportControls;
  MM.centerOnRoot = centerOnRoot;
  MM.fdIsThemeMode = fdIsThemeMode;
  MM.isThemeMode = isThemeMode;
  MM.nodeBorderRect = nodeBorderRect;
  MM.lineParentPoints = lineParentPoints;   // 线端分散的**唯一实现**（断言用它算一份独立读数对照产品）
  MM.setLineEndpointScheme = setLineEndpointScheme;   // 只给判别力证明切口径（默认就是产品口径）
  MM.getLineEndpointScheme = () => fdLineEndpointScheme;
  MM.installRootLineOverride = installRootLineOverride;
  MM.applyRootModeVisual = applyRootModeVisual;
  MM.applyThemeLayout = applyThemeLayout;  MM.applyRootMode = applyRootMode;
  MM.setRootMode = setRootMode;
  MM.structureMode = structureMode;             // 【R5 · R2 期 5】结构轴（树 / 复杂）读数出口
  MM.setStructureMode = setStructureMode;
  MM.resetStructureMode = resetStructureMode;
  MM.resetView = resetView;
  MM.expandAll = expandAll;
  MM.collapseAll = collapseAll;
})();
