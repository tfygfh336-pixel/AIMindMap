/* ============================================================
 * AI MindMap — 浮动详情框：框池与定位（app-detail.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 详情框池：创建/关闭/复用（fdBoxes、createFdBox、closeFdBox、hideFloatDetail…）
 *   2) 定位与锁定：跟随节点、小锁锚点（相对导图）、大锁（相对屏幕）
 *      —— fdComputeAnchor / fdApplyAnchor / setFdBoxLock / positionFdBox / syncFdBoxes
 *   3) 逐帧看护 fdStartWatch（与滚动事件解耦）
 *   4) 打开详情框的编排 showDetail 与自检读数 getFloatDetailState
 * 边界（本文件不负责）：
 *   · 框内容渲染与容器点击选中 → app-detail-content.js
 *   · 拖动/改大小/图片悬停提示 → app-detail-drag.js
 *   · 画布缩放平移 → app-view.js；编辑操作 → app-actions.js
 * 所有搬迁的函数体与拆分前逐字相同；本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const state = MM.state;

  /* ================= 浮动详情框：多框池 + 可拖动 + 小锁/屏幕锁 =================
   * 规则：
   *   1) 尺寸与节点框保持固定比例 —— 随导图缩放同步缩放（transform: scale(zoom)）；
   *   2) 未锁定的框（follow）被下一个节点复用；小锁（map）/屏幕锁（screen）的框保留，
   *      因此可同时展示多个详情框；每个新框出现在「节点框的下面」；
   *   3) 拖动即自动上小锁（按其在导图中的内容坐标锁定）。
   */
  const FD_LOCK = { FOLLOW: 'follow', MAP: 'map', SCREEN: 'screen' };
  // [{ el, node, lock, anchor, kind, assoc }]
  //   kind: 'node'（默认，节点详情）| 'assoc'（关联笔记二级页面）
  //   关联页面**复用同一个框组件**，因此拖动/改大小/📌/🖥/多框并存/逐帧看护全部免费继承。
  //   它仍然需要 `node`：定位（positionFdBox）靠 `box.node.id` 找 jmnode —— 故把
  //   "你从哪个节点点进来的"作为**锚定节点**存进去，页面就跟着那个节点走。
  //   `assoc` 存该页面对应的关联实体。
  let fdBoxes = [];   // [{ el, node, lock, anchor, kind, assoc }]
  let fdSeq = 0;

  /** 当前导图缩放（统一视图变换的 s）：详情框据此与节点框保持固定比例 */
  function fdZoom() {
    return (fdView && fdView.s > 0) ? fdView.s : 1;
  }

  function createFdBox() {
    const tpl = document.getElementById('fd-tpl');
    const container = document.getElementById('mindmap-container');
    const el = tpl.content.firstElementChild.cloneNode(true);
    fdSeq += 1;
    el.dataset.boxId = 'fd' + fdSeq;
    container.appendChild(el);
    const box = { el, node: null, lock: FD_LOCK.FOLLOW, anchor: null, kind: 'node', assoc: null };
    fdQ(box, '.fd-close').addEventListener('click', (e) => { e.stopPropagation(); closeFdBox(box); });
    fdQ(box, '.fd-lock-map').addEventListener('click', (e) => { e.stopPropagation(); setFdBoxLock(box, FD_LOCK.MAP); });
    fdQ(box, '.fd-lock-screen').addEventListener('click', (e) => { e.stopPropagation(); setFdBoxLock(box, FD_LOCK.SCREEN); });
    // 四边 / 四角改大小把手
    el.querySelectorAll('.fd-rs').forEach((hd) => {
      hd.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startFdResize(box, hd.dataset.rs, e);
      });
    });
    fdQ(box, '.fd-head').addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return; // 锁定/关闭键不触发拖动
      e.preventDefault();
      e.stopPropagation();
      bringFdBoxToFront(box);
      fdDrag = {
        box, x: e.clientX, y: e.clientY,
        l: parseFloat(el.style.left || 0), t: parseFloat(el.style.top || 0)
      };
      el.classList.add('dragging');
    });
    fdBoxes.push(box);
    fdStartWatch(); // 有框了 → 启动逐帧看护
    return box;
  }

  function bringFdBoxToFront(box) {
    fdBoxes.forEach((b) => { if (b !== box) b.el.style.zIndex = '50'; });
    box.el.style.zIndex = '51';
  }

  function closeFdBox(box) {
    if (box.el.parentElement) box.el.parentElement.removeChild(box.el);
    fdBoxes = fdBoxes.filter((b) => b !== box);
    hideFdImgTip();
    if (!fdBoxes.length) state.selectedNode = null;
  }

  /** 关闭所有「未锁定」的框；已上小锁/屏幕锁的框保留（点空白、Esc 都不误关） */
  function hideFloatDetail() {
    fdBoxes.slice().forEach((b) => { if (b.lock === FD_LOCK.FOLLOW) closeFdBox(b); });
    hideFdImgTip();
  }

  /** 关闭全部详情框 */
  function closeAllFloatDetail() {
    fdBoxes.slice().forEach(closeFdBox);
    state.selectedNode = null;
  }

  function updateFdBoxButtons(box) {
    fdQ(box, '.fd-lock-map').classList.toggle('active', box.lock === FD_LOCK.MAP);
    fdQ(box, '.fd-lock-screen').classList.toggle('active', box.lock === FD_LOCK.SCREEN);
  }

  /** 记录小锁锚点。
   *  · dx/dy —— 详情框左上角相对**所属节点框左上角**的偏移（除以当前缩放换算成节点自身坐标，
   *             因此与缩放无关，这正是"相对导图某点被锁死"的含义）；
   *  · sLeft/sTop —— 兜底：相对画布内容（位置 = 锚点 − 滚动量），仅当节点框 DOM 不存在时用。 */
  function fdComputeAnchor(box) {
    const el = box.el;
    const S = fdZoom() || 1;
    const panel = fdPanel();
    const container = document.getElementById('mindmap-container');
    const left = parseFloat(el.style.left || 0);
    const top = parseFloat(el.style.top || 0);
    const anchor = {
      dx: 0, dy: 0, hasNode: false,
      sLeft: left + (panel ? panel.scrollLeft : 0),
      sTop: top + (panel ? panel.scrollTop : 0)
    };
    const nodeEl = (box.node && container) ? container.querySelector('jmnode[nodeid="' + box.node.id + '"]') : null;
    if (nodeEl && container) {
      const nr = nodeEl.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      anchor.dx = ((left + cr.left) - nr.left) / S;
      anchor.dy = ((top + cr.top) - nr.top) / S;
      anchor.hasNode = true;
    }
    return anchor;
  }

  /** 应用小锁锚点：优先按「相对节点框」定位（平移与缩放都精确跟随；
   *  节点框移出视野时详情框同步移出，由容器 overflow:hidden 裁切）；
   *  节点框 DOM 不存在（如父节点折叠）时退回「锚点 − 滚动量」。 */
  function fdApplyAnchor(box) {
    const el = box.el;
    const a = box.anchor;
    const container = document.getElementById('mindmap-container');
    if (!container) return;
    const S = fdZoom() || 1;
    const nodeEl = (box.node && a.hasNode) ? container.querySelector('jmnode[nodeid="' + box.node.id + '"]') : null;
    if (nodeEl) {
      const nr = nodeEl.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      el.style.left = ((nr.left - cr.left) + a.dx * S) + 'px';
      el.style.top = ((nr.top - cr.top) + a.dy * S) + 'px';
      return;
    }
    const panel = fdPanel();
    el.style.left = (a.sLeft - (panel ? panel.scrollLeft : 0)) + 'px';
    el.style.top = (a.sTop - (panel ? panel.scrollTop : 0)) + 'px';
  }

  /** 上锁 / 解除：点锁键 → 上该锁；再点同一个键 → 解除回 follow。
   *  map = 小锁（相对导图锁死）；screen = 大锁（相对屏幕锁死，大小+位置都冻结） */
  function setFdBoxLock(box, mode) {
    const next = box.lock === mode ? FD_LOCK.FOLLOW : mode;
    box.lock = next;
    box.anchor = next === FD_LOCK.MAP ? fdComputeAnchor(box) : null;
    updateFdBoxButtons(box);
    positionFdBox(box);
    setStatus(next === FD_LOCK.MAP ? '详情框：已上小锁（相对导图锁死，平移/缩放都跟着走）'
      : next === FD_LOCK.SCREEN ? '详情框：已上大锁（相对屏幕锁死，大小与位置都不再变化）'
        : '详情框：已解除锁定（回到跟随节点，会被下一个节点复用）');
  }

  /** 定位单个框：screen=纹丝不动（大小也冻结）；map=锚点−滚动；follow=挂在节点框下面 */
  function positionFdBox(box) {
    const el = box.el;
    if (!el || el.style.display === 'none') return;
    // 大锁：位置完全不动（大小由 syncFdBoxes 一并冻结）
    if (box.lock === FD_LOCK.SCREEN) return;
    const container = document.getElementById('mindmap-container');
    if (!container) return;
    const panel = fdPanel();
    // 小锁：相对**所属节点框**锁死（平移与缩放都精确跟随，节点看不到时详情也看不到）。
    // 锚点缺失就地补，绝不落到"跟随节点"分支 —— 否则平移时会上下翻转（上下区间跳）。
    if (box.lock === FD_LOCK.MAP) {
      if (!box.anchor) box.anchor = fdComputeAnchor(box);
      fdApplyAnchor(box);
      return;
    }
    if (!box.node) return;
    const S = fdZoom();
    const w = el.offsetWidth * S;
    const nodeEl = container.querySelector('jmnode[nodeid="' + box.node.id + '"]');
    if (!nodeEl) return;
    const nRect = nodeEl.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    // 固定出现在「节点框的下面 +8px」：
    //   · 不做上下翻转 —— 否则节点上下移动时会「上下区间跳」；
    //   · 不夹进可见区 —— 否则节点移出视野时详情框会一直黏在边缘（永远可见）。
    // 节点移出视野时详情框跟着移出，由 #mindmap-container 的 overflow:hidden 自然裁切。
    const left = (nRect.left - cRect.left) + (nRect.width - w) / 2;
    const top = (nRect.bottom - cRect.top) + 8;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  /** 同步所有框的缩放比例与位置（导图缩放/平移/节点移动/窗口缩放后调用）。
   *  大锁（screen）的框**位置与大小都冻结**，完全不动。 */
  function syncFdBoxes() {
    const S = fdZoom();
    fdBoxes.forEach((box) => {
      const el = box.el;
      if (!el || el.style.display === 'none') return;
      if (box.lock === FD_LOCK.SCREEN) return; // 大锁：大小 + 位置都不再变化
      el.style.transform = S === 1 ? '' : 'scale(' + S + ')';
      positionFdBox(box);
    });
  }

  function positionFloatDetail() { syncFdBoxes(); }

  /* —— 逐帧看护：只要存在非「大锁」的详情框，就每帧校正一次位置 ——
   * 与画布的平移/缩放实现彻底解耦：不关心是哪个元素在滚、也不依赖 scroll 事件。 */
  let fdWatchId = 0;
  function fdStartWatch() {
    if (fdWatchId) return;
    const tick = () => {
      if (!fdBoxes.length) { fdWatchId = 0; return; } // 没有框 → 自动停，不空转
      fdWatchId = requestAnimationFrame(tick);
      if (fdDrag || fdResize) return;
      syncFdBoxes();
    };
    fdWatchId = requestAnimationFrame(tick);
  }

  /** 供冒烟断言读取：框数量 / 指定框（默认最后一个）的锁定态与位置 / 画布滚动量 */
  function getFloatDetailState(i) {
    const box = fdBoxes.length
      ? (typeof i === 'number' ? fdBoxes[i] : fdBoxes[fdBoxes.length - 1])
      : null;
    const panel = fdPanel();
    const el = box && box.el;
    return {
      boxes: fdBoxes.length,
      locks: fdBoxes.map((b) => b.lock),
      lock: box ? box.lock : null,
      nodeId: box && box.node ? box.node.id : null,
      // 框类型与关联 id：冒烟断言据此区分"节点详情框"与"关联笔记二级页面"
      kind: box ? box.kind : null,
      assocId: box && box.assoc ? box.assoc.id : null,
      kinds: fdBoxes.map((b) => b.kind),
      left: parseFloat((el && el.style.left) || 0) || 0,
      top: parseFloat((el && el.style.top) || 0) || 0,
      scrollLeft: panel ? panel.scrollLeft : 0,
      scrollTop: panel ? panel.scrollTop : 0,
      visible: !!(el && el.style.display !== 'none'),
      debug: box ? {
        nodeId: box.node ? box.node.id : null,
        hasNode: !!(box.anchor && box.anchor.hasNode),
        dx: box.anchor ? Math.round(box.anchor.dx) : null,
        dy: box.anchor ? Math.round(box.anchor.dy) : null,
        anchorFound: !!(box.node && document.getElementById('mindmap-container')
          .querySelector('jmnode[nodeid="' + box.node.id + '"]'))
      } : null
    };
  }

  /** 打开节点详情框：优先复用「未锁定」的框；若全部已锁定则新开一个（出现在节点框的下面） */
  function showDetail(node) {
    if (!node) return;
    state.selectedNode = node;
    // 该节点已在某个详情框里 → 直接刷新那个框（不重复开框，也不覆盖别的锁定框）
    // 注意排除 kind==='assoc'：关联页面的 box.node 只是**锚定节点**，不是"这个节点的详情框"，
    // 否则打开关联页面后，点同一节点会被误判成"已存在"，把关联页当成节点详情刷新掉。
    let box = fdBoxes.find((b) => b.kind !== 'assoc' && b.node && b.node.id === node.id);
    // 否则复用「未锁定（跟随）」的框；锁定框不被新节点覆盖（同样只复用节点框）
    if (!box) box = fdBoxes.find((b) => b.kind !== 'assoc' && b.lock === FD_LOCK.FOLLOW);
    if (!box) box = createFdBox();
    box.kind = 'node';
    box.assoc = null;
    box.node = node;
    box.el.style.display = 'flex';
    bringFdBoxToFront(box);
    syncFdBoxes();
    renderFdBox(box, node);
    positionFdBox(box);
    setTimeout(() => { if (box.el.parentElement) positionFdBox(box); }, 40);
    return box;
  }

  /** 打开「关联笔记」二级页面（关联的 N 元实体，不属于节点树）。
   *
   *  · 锚定到 `anchorNode`（你从哪个节点的「相关知识点」点进来的）：
   *    于是拖动/改大小/📌/🖥 与节点详情**完全一致**，因为它就是同一个框组件；
   *  · 与节点详情**互不挤占**：只在 assoc 类型的框之间复用，节点详情不受影响
   *    —— 这样可以一边看节点详情、一边看这个关联笔记并排对比（正是多框并存的意义）；
   *  · 只能从这里进入：它不是节点、不在树里、命令面板也搜不到。 */
  function showAssocPage(assoc, anchorNode) {
    if (!assoc || !assoc.id) return null;
    let box = fdBoxes.find((b) => b.kind === 'assoc' && b.assoc && b.assoc.id === assoc.id);
    if (!box) box = fdBoxes.find((b) => b.kind === 'assoc' && b.lock === FD_LOCK.FOLLOW);
    if (!box) box = createFdBox();
    box.kind = 'assoc';
    box.assoc = assoc;
    box.node = anchorNode || box.node;      // 定位靠它；没有锚点就沿用上一个
    box.el.style.display = 'flex';
    bringFdBoxToFront(box);
    syncFdBoxes();
    MM.renderAssocPage(box, assoc, box.node);
    positionFdBox(box);
    setTimeout(() => { if (box.el.parentElement) positionFdBox(box); }, 40);
    return box;
  }

  /** 关联页面数据变化后重绘（例如从页面内改完笔记） */
  function refreshAssocPage(assocId) {
    const box = fdBoxes.find((b) => b.kind === 'assoc' && b.assoc && b.assoc.id === assocId);
    if (!box) return false;
    MM.renderAssocPage(box, box.assoc, box.node);
    return true;
  }

  /** 重绘某节点的详情框（内容渲染会顺带重新拉取「相关知识点」与「关联笔记」入口）。
   *  不改选中状态、不抢焦点 —— 只用于"数据变了，把这框刷新一下"。 */
  function refreshNodeDetailBox(nodeId) {
    const box = fdBoxes.find((b) => b.kind !== 'assoc' && b.node && b.node.id === nodeId);
    if (!box || !box.el || !box.el.parentElement) return false;
    renderFdBox(box, box.node);
    return true;
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const fdQ = (box, sel) => MM.fdQ(box, sel);
  const fdPanel = () => MM.fdPanel();
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const hideFdImgTip = () => MM.hideFdImgTip();
  const renderFdBox = (box, node) => MM.renderFdBox(box, node);
  const startFdResize = (box, dir, e) => MM.startFdResize(box, dir, e);

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.FD_LOCK = FD_LOCK;
  MM.fdZoom = fdZoom;
  MM.createFdBox = createFdBox;
  MM.bringFdBoxToFront = bringFdBoxToFront;
  MM.closeFdBox = closeFdBox;
  MM.hideFloatDetail = hideFloatDetail;
  MM.closeAllFloatDetail = closeAllFloatDetail;
  MM.updateFdBoxButtons = updateFdBoxButtons;
  MM.fdComputeAnchor = fdComputeAnchor;
  MM.fdApplyAnchor = fdApplyAnchor;
  MM.setFdBoxLock = setFdBoxLock;
  MM.positionFdBox = positionFdBox;
  MM.syncFdBoxes = syncFdBoxes;
  MM.positionFloatDetail = positionFloatDetail;
  MM.fdStartWatch = fdStartWatch;
  MM.getFloatDetailState = getFloatDetailState;
  MM.showDetail = showDetail;
  MM.showAssocPage = showAssocPage;
  MM.refreshAssocPage = refreshAssocPage;
  MM.refreshNodeDetailBox = refreshNodeDetailBox;
})();
