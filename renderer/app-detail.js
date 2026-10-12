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
    // 卫星（圆钮/工具条）与框是**同一生命周期**：框一消失，属于它的圆钮立刻收干净（不留残影 ——
    // 用户验收口径"关框 ⇒ 两者都消失"）。判据仍是 fdSatellitePlan（不在这里另判一次 ✗）。
    const boxId = box.el && box.el.dataset ? box.el.dataset.boxId : '';
    if (boxId && MM.dropFdSatellites) MM.dropFdSatellites(boxId);
    if (box.el.parentElement) box.el.parentElement.removeChild(box.el);
    fdBoxes = fdBoxes.filter((b) => b !== box);
    hideFdImgTip();
    if (!fdBoxes.length) state.selectedNode = null;
    syncFdSatellites();   // 框池变了 ⇒ 卫星同一批更新（工具条该收就收 ✓）
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

  /* ================= 详情框的「卫星」：圆钮 + 悬浮工具条 =================
   * 为什么它们**不放在框里**：圆钮必须落在框**外面**（用户 2026-10-08 第二批："不要在框内，
   * 就放在边上，变成一个圆形按钮浮在节点详情左边"），而框是 `overflow:hidden`（style.css:261）
   * ⇒ 放框里会被裁掉。实测（`.review/20261009-圆钮工具栏绑定/probe-clip.js`，同一读数跑两种 CSS）：
   *   · `getBoundingClientRect()` 说"在框外、在面板内"（现有断言全绿 ✗）；
   *   · 可 `elementFromPoint(圆心)` 命中普通 DIV（**不是按钮**）、真帧里圆钮矩形内只有 81 个非白像素
   *     （放到框外可见时是 768）⇒ **看不见也点不到**。
   * 所以：两者都放**与框同级**的浮层 `#fd-satellite-layer`（本文件创建），
   * 位置**只从框的 `getBoundingClientRect()` 推导**，刷新时机与框**同一批事件**。
   *
   * 纪律（本工程硬规矩：一份事实一处实现）：
   *   · 显隐判据**只有** fdSatellitePlan() 一处；
   *   · 位置计算**只有** syncFdSatellites() 一处（它再分派给各自的 owner：圆钮 → app-assoc.js、
   *     工具条 → app-ask.js）；触发时机**只有**三处，且都是"框几何刚变过"的同一批事件：
   *     positionFdBox / syncFdBoxes / 拖动·改大小 mousemove（窗口 resize 汇入 syncFdBoxes）。
   *   别在别处再判一次"该不该显示" ✗（改前这套判据散在 5 处，正是漂移的来源）。
   */
  const SAT_LAYER_ID = 'fd-satellite-layer';

  /** 卫星浮层：与详情框同级（`#mindmap-container` 的子元素）⇒ **不受框的 overflow 影响**。
   *  ⚠️ 它自己必须 `pointer-events:none`（样式在 style.css），否则整块画布点不动 ✗ */
  function fdSatLayer() {
    const container = document.getElementById('mindmap-container');
    if (!container) return null;
    let el = document.getElementById(SAT_LAYER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = SAT_LAYER_ID;
      // 放最后 ⇒ 与框同层但排在框之后（再加 CSS 的 z-index ⇒ 稳定压在框上）
      container.appendChild(el);
    }
    return el;
  }

  /** **唯一判据**：这个框的卫星该不该出现。
   *  · 框不可见 ⇒ 两个都不出现；
   *  · 圆钮：节点详情框恒有（与"有没有关联数据"无关 —— 2026-10-08 的既定契约 ✓）；
   *  · 悬浮工具条：**大小锁（FD_LOCK.SCREEN）时关闭** ← 用户原话「大小锁的时候要关闭悬浮工具栏，
   *    但是保留视图按钮」（圆钮照样保留，位置/尺寸/可点性逐字不变 ✓）。
   *  返回 reason 供断言与排查（**不静默**：判据的结果要能读出来）。 */
  function fdSatellitePlan(box) {
    const el = box && box.el;
    const visible = !!(el && el.parentElement && el.style.display !== 'none');
    if (!visible) return { visible: false, round: false, toolbar: false, locked: false, reason: 'box-hidden' };
    const locked = box.lock === FD_LOCK.SCREEN;
    return {
      visible: true,
      round: box.kind === 'node',
      toolbar: box.kind === 'node' && !locked,
      locked: locked,
      reason: locked ? 'size-lock' : 'ok'
    };
  }

  /** 框在**卫星浮层坐标系**里的几何帧 —— 卫星位置的唯一来源。
   *  为什么不用 `offsetLeft/offsetTop`：框带 `transform: scale(S)`，布局值不含缩放；
   *  `getBoundingClientRect()` 是**显示**矩形（含缩放）⇒ 与"看起来在哪"一致 ✓ */
  function fdBoxFrame(box) {
    const layer = fdSatLayer();
    const el = box && box.el;
    if (!layer || !el || !el.parentElement) return null;
    const lr = layer.getBoundingClientRect();
    const br = el.getBoundingClientRect();
    return { x: br.left - lr.left, y: br.top - lr.top, w: br.width, h: br.height, s: fdZoom() || 1 };
  }

  /** 当前"活着"的节点详情框（最上面的那个）—— 工具条据此认锚（**框池是唯一真源**）。
   *  取 z-index 最大者；并列时取后加入的（bringFdBoxToFront 会给活动框 51）✓ */
  function fdPrimaryNodeBox() {
    let best = null, bestZ = -1;
    fdBoxes.forEach((box) => {
      if (box.kind !== 'node' || !box.node) return;
      if (!fdSatellitePlan(box).visible) return;
      const z = parseInt((box.el.style.zIndex || '0'), 10) || 0;
      if (z >= bestZ) { bestZ = z; best = box; }
    });
    return best;
  }

  /** **唯一刷新口**：算一遍所有框的 `{plan, frame}`，再交给各卫星的 owner 落位。
   *  返回读数（冒烟断言可直接读它，不必猜 DOM）。
   *  ⚠️ 判据走 `MM.fdSatellitePlan`（不是直接引用本文件的局部名）——**这是刻意的接缝**：
   *  否则"判据只有一处"只在源码里成立，**外部无法替换它做判别力注入**（实测踩过：按局部名调用时，
   *  注入 `MM.fdSatellitePlan` 完全无效 ⇒ 三条注入"绿着通过"= 门禁在空转 ✗ 见 37-域文件头）。 */
  function syncFdSatellites() {
    const layer = fdSatLayer();
    if (!layer) return null;
    const frames = fdBoxes.slice().map((box) => {
      const plan = MM.fdSatellitePlan(box);
      return { box: box, plan: plan, frame: plan.round ? fdBoxFrame(box) : null };
    });
    const lr = layer.getBoundingClientRect();
    const view = { w: lr.width, h: lr.height };
    if (MM.layoutRelShowBtn) MM.layoutRelShowBtn(layer, frames, view);       // 圆钮（app-assoc.js 拥有）
    if (MM.layoutNodeToolbar) MM.layoutNodeToolbar(layer, frames, view);     // 工具条（app-ask.js 拥有）
    return { frames: frames, view: view, count: frames.length };
  }

  MM.fdSatLayer = fdSatLayer;
  MM.fdSatellitePlan = fdSatellitePlan;
  MM.fdBoxFrame = fdBoxFrame;
  MM.fdPrimaryNodeBox = fdPrimaryNodeBox;
  MM.syncFdSatellites = syncFdSatellites;

  /** 事件是不是落在**卫星浮层**上（圆钮/悬浮工具条）。
   *  为什么要它：圆钮原先在 `.float-detail` 里 ⇒ 各处"点别处"的守卫只写 `.float-detail` 就够了；
   *  搬进浮层后那些守卫会**集体失效** —— 实测后果：点一下圆钮会顺手把未锁定的详情框关掉 ✗。
   *  **一份事实一处实现**：调用点各自写 `closest('#fd-satellite-layer')` 就是第二份表达，别那么干 ✗ */
  function fdIsSatelliteTarget(target) {
    return !!(target && target.closest && target.closest('#' + SAT_LAYER_ID));
  }
  MM.fdIsSatelliteTarget = fdIsSatelliteTarget;

  /** 定位单个框：screen=纹丝不动（大小也冻结）；map=锚点−滚动；follow=挂在节点框下面 */
  function positionFdBoxInner(box) {
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

  /** 对外的 positionFdBox：**几何一变就同步卫星**（触发时机之一，见文件头）。
   *  内部原函数改名 positionFdBoxInner；既有调用点全部仍走这个壳 ⇒ 一处不漏 ✓ */
  function positionFdBox(box) {
    positionFdBoxInner(box);
    syncFdSatellites();
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
      positionFdBoxInner(box);
    });
    syncFdSatellites();   // 触发时机之二：视图变换（缩放/平移/窗口 resize）后与框同一批更新 ✓
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
      // 尺寸：断言要判"框是否盖住某个点"时必须知道它有多高 —— 猜 DOM 里的框会选错
      //（实测：用 `.fd-lock-screen.active` 选到的是**节点详情框**，量出来 136x99 ✗）
      width: el ? Math.round(el.offsetWidth) : 0,
      height: el ? Math.round(el.offsetHeight) : 0,
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
    /* ---- 采样点（热度条第三件 · A）：**人打开详情框**（裁决一里唯一算数的人类动作）----
     * 为什么放在这里：本函数是"打开详情框"的**唯一入口** —— 节点点击（app-detail-content）、
     * 搜索结果、关联视图、命令面板、审计面板、`showDetailItem` 全都汇到它 ⇒ 一处采样点覆盖全部路径。
     * 三条纪律（都在 `renderer/app-heat-bars.js` 里）：
     *   · **异步、不阻塞**：DOM 已经画完，这一步是 fire-and-forget（绝不 await，打开不许变慢）；
     *   · **只往访问日志追加一行**（旁路产物，`<项目根>/.visits/<项目>.jsonl`，在项目目录**之外**）
     *     ⇒ 不写项目数据、不触发保存、不产生未保存标记（判据：改/看热度条不写盘）；
     *   · 失败**响亮**：控制台一条 + 状态栏可见提示（`app-heat-bars.js` 里做，不静默）。
     * ⚠️ 框内的**重绘**（`renderFdBox` / `refreshNodeDetailBox` / 条目选择）**不经**本函数
     * ⇒ 它们不会重复计数（"关掉/重开只算打开那一次"要区分的正是这两件事）。 */
    if (MM.heatBarsRecordHumanOpen) MM.heatBarsRecordHumanOpen(node);
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
    // 这个框可能刚才是**节点详情框**（跟随框会在两种页面之间复用）⇒ 先摘掉条目清单，
    // 否则上一位节点的"逐条"清单会挂在这篇关联笔记上（张冠李戴，比不显示更糟）。
    if (MM.fdItemsClear) MM.fdItemsClear(box);
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

  /** 打开某节点的详情框，并**选中它的某一条**（条目层 v3）。
   *
   *  用途：从别处**指到具体条目**（关联视图/检索结果跳进来时高亮那一条）。
   *  为什么放在这里：它只是"既有的 showDetail + 条目层的选中"两步编排 ——
   *  **没有新增 IPC / 命令**（渲染层只读既有通道：`node.items` 来自项目数据本身）。
   *  @returns {boolean} 是否真的选中了（节点或条目不存在 ⇒ false，并在状态栏说明）
   */
  function showDetailItem(nodeId, itemId) {
    const jm = state.jm;
    if (!jm || !nodeId) return false;
    const node = MM.adapter.getNode(jm, nodeId);
    if (!node) { MM.setStatus('节点不在当前视图：' + nodeId, true); return false; }
    const box = showDetail(node);
    if (!box || !MM.fdSelectItem) return false;
    const ok = MM.fdSelectItem(box, itemId);
    if (!ok) MM.setStatus('节点 ' + nodeId + ' 上没有条目 ' + itemId + '（未选中）', true);
    return !!ok;
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
  MM.showDetailItem = showDetailItem;
})();
