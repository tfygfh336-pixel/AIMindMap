/* ============================================================
 * AI MindMap — 渲染层编排（app.js）
 * ------------------------------------------------------------
 * 职责：
 *   1) 项目加载/切换（window.desktop.projects / project.read）
 *   2) jsMind 实例生命周期（渲染、重建、序列化扩展）
 *   3) 详情面板 + 图片面板（图片带 caption，供 AI 二次理解）
 *   4) 编辑操作编排（新增/编辑/删除/展开收起）+ 快照式撤销重做
 *   5) 保存闸门（经 desktop.project.save → 主进程 CLI validate）
 *   6) 工具栏 / 菜单事件接线
 * 交互细节见 renderer/editor.js；本文件不直接操作 DOM 输入框。
 * ============================================================ */
/* ------------------------------------------------------------
 * 拆分说明（renderer/app.js 1340 行 → 多个原生 <script> 模块）：
 *   本文件现在只保留「工具栏/菜单事件接线 wireUI + 对外 API window.MMApp + 启动」。
 *   上面列出的职责已按职责边界搬到：
 *     app-core.js（共享状态/序列化/渲染入口/状态栏）
 *     app-view.js（画布平移缩放/居中/主题模式/展开收起）
 *     app-detail.js（详情框池与定位锁定）
 *     app-detail-drag.js（详情框拖动改大小/图片悬停提示）
 *     app-detail-content.js（详情框内容渲染与容器接线）
 *     app-media.js（灯箱/文件预览/相关知识点）
 *     app-actions.js（保存/撤销重做/编辑操作/搜索/项目/导入导出）
 *   搬迁的函数体**逐字未改**（含缩进、注释、空行、中文）；跨文件调用一律走
 *   window.MM 的包装函数，函数体里的裸名调用/赋值与拆分前完全一致。
 *   几个会被重新赋值的跨文件共享变量（fdView / fdHideRootLinks / fdDrag /
 *   fdResize）在 app-core.js 里用同名全局槽位承载（原因见该文件注释）。
 * ------------------------------------------------------------ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const $ = MM.$;

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const getState = () => MM.getState();
  const serializeTree = () => MM.serializeTree();
  const save = () => MM.save();
  const addNode = (parentId) => MM.addNode(parentId);
  const addSiblingNode = (id) => MM.addSiblingNode(id);
  const addTopic = () => MM.addTopic();
  const resetView = () => MM.resetView();
  const getPanState = () => MM.getPanState();
  const setViewScale = (s) => MM.setViewScale(s);
  const setRootMode = (mode) => MM.setRootMode(mode);
  const isThemeMode = () => MM.isThemeMode();
  const editNode = (id) => MM.editNode(id);
  const deleteNode = (id) => MM.deleteNode(id);
  const expandAll = () => MM.expandAll();
  const collapseAll = () => MM.collapseAll();
  const undo = () => MM.undo();
  const redo = () => MM.redo();
  const showDetail = (node) => MM.showDetail(node);
  const hideFloatDetail = () => MM.hideFloatDetail();
  const closeAllFloatDetail = () => MM.closeAllFloatDetail();
  const positionFloatDetail = () => MM.positionFloatDetail();
  const getFloatDetailState = (i) => MM.getFloatDetailState(i);
  const openLightbox = (src) => MM.openLightbox(src);
  const closeLightbox = () => MM.closeLightbox();
  const lightboxZoom = (delta) => MM.lightboxZoom(delta);
  const openFilePreview = (node, rel) => MM.openFilePreview(node, rel);
  const closeFilePreview = () => MM.closeFilePreview();
  const openProject = (name) => MM.openProject(name);
  const isDirty = () => MM.isDirty();
  const runSearch = (keyword) => MM.runSearch(keyword);
  const jumpToNode = (id) => MM.jumpToNode(id);
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const bindFdGlobalDrag = () => MM.bindFdGlobalDrag();
  const loadProjects = () => MM.loadProjects();
  const importMarkdown = () => MM.importMarkdown();
  const exportMarkdown = () => MM.exportMarkdown();
  const openAudit = () => MM.openAudit();
  const closeAudit = () => MM.closeAudit();
  const bindAudit = () => MM.bindAudit();
  const openPalette = () => MM.openPalette();
  const closePalette = () => MM.closePalette();
  const paletteIsOpen = () => MM.paletteIsOpen();
  const bindPalette = () => MM.bindPalette();
  const bindAssocDialog = () => MM.bindAssocDialog();

  /* ================= UI 接线 ================= */
  function wireUI() {
    $('#project-select').addEventListener('change', (e) => openProject(e.target.value));
    // 保存按钮：此前**界面上根本没有任何保存入口**（工具栏无按钮、菜单无项、无 Ctrl+S），
    // 而对话框文案写着"点击保存生效" → 人的编辑只存在内存里，关窗即丢。
    $('#btn-save').addEventListener('click', () => save());
    // 导入/导出 MD 只保留「文件」菜单入口（工具栏按钮已在 v0.16 移除）
    // 新建/新建主题/编辑/删除/关系审计的工具栏按钮已在 v0.16.2 移除（只删按钮不删功能）：
    //   · 节点操作走右键菜单 / 快捷键（Ctrl+N、F2、Delete）与命令面板；
    //   · 关系审计走菜单「编辑 → 关系审计…」（Ctrl+Shift+A）与命令面板。
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-expand').addEventListener('click', expandAll);
    $('#btn-collapse').addEventListener('click', collapseAll);
    $('#btn-reset-view').addEventListener('click', resetView);
    // 全文搜索：Enter 触发；结果面板关闭
    $('#search-box').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    // 点击导图空白处关闭搜索结果面板
    document.getElementById('mindmap-container').addEventListener('click', (e) => {
      const sr = $('#search-results');
      if (sr && sr.style.display !== 'none' && !sr.contains(e.target)) sr.style.display = 'none';
    });

    // 审计面板与命令面板（内容由各自模块渲染；入口 = 菜单/快捷键/命令面板）
    $('#btn-palette').addEventListener('click', () => openPalette());
    bindAudit();
    bindPalette();
    bindAssocDialog();   // 关联笔记编辑对话框（二级页面内）
    // Ctrl+P / Cmd+P 打开命令面板。优先用主进程菜单事件（见 wireUI 末尾的 menu:palette），
    // 这里再用 keydown 兜底一层：即使菜单注册失败，快捷键仍然可用。
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openPalette();
      } else if (e.key === 'Escape') {
        if (paletteIsOpen()) closePalette();
        else if ($('#audit-panel') && $('#audit-panel').style.display !== 'none') closeAudit();
      }
    });

    // 浮动详情框：拖动全局只绑一次；关闭/锁定按钮在 createFdBox 里随每个框各自绑定
    bindFdGlobalDrag();

    // DSH 侧边栏：布局让位 + 状态栏提示（监听主进程事件；不涉及 token/url）
    if (MM.bindDshSidebar) MM.bindDshSidebar();

    // 导图页右上角独立 ✕：**真的把这一页关掉**（卸载渲染层 ⇒ 它的内存真正释放；v0.19 语义）。
    // 与窗口的 ✕ 分工不同：窗口 ✕ = 关整个应用；详情框里那个 ✕ = 关详情框。
    // 顺序（不许颠倒）：先拦未保存编辑（有脏就弹「保存后关闭 / 取消」并走既有保存路径）
    //   ⇒ 保存成功才让主进程卸载这一页。主进程做不了这个判断：脏标记只活在渲染层内存里。
    // 动态插入而不是写进 index.html：接线集中在这一处，也避免与工具栏既有布局打架。
    (() => {
      const bar = document.getElementById('toolbar');
      if (!bar || document.getElementById('btn-close-map')) return;
      const btn = document.createElement('button');
      btn.id = 'btn-close-map';
      btn.title = '关闭导图页（真卸载这一页：有未保存编辑会先问你；窗口 ✕ 才是退出应用）';
      btn.textContent = '✕';
      btn.style.marginLeft = '4px';
      btn.addEventListener('click', () => { MM.closeMapPage(); });
      bar.appendChild(btn);
    })();

    // 图片灯箱：滚轮缩放 / 双击或点击遮罩关闭 / Esc 关闭
    const lb = $('#lightbox');
    lb.addEventListener('wheel', (e) => { e.preventDefault(); lightboxZoom(e.deltaY); }, { passive: false });
    lb.addEventListener('dblclick', closeLightbox);
    lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

    // 主进程菜单事件
    window.desktop.on('menu:save', () => save());
    window.desktop.on('menu:undo', undo);
    window.desktop.on('menu:redo', redo);
    window.desktop.on('menu:add-node', () => addNode());
    window.desktop.on('menu:edit-node', () => editNode());
    window.desktop.on('menu:delete-node', () => deleteNode());
    window.desktop.on('menu:expand-all', expandAll);
    window.desktop.on('menu:collapse-all', collapseAll);
    window.desktop.on('menu:import-md', importMarkdown);
    window.desktop.on('menu:export-md', exportMarkdown);
    window.desktop.on('menu:palette', () => openPalette());
    window.desktop.on('menu:audit', () => openAudit());
    /* 【R4】绑定工作区文件夹的入口（菜单「文件 → 绑定工作区文件夹…」）：
     * 与命令面板里那条命令**同一个实现**（`MM.bindWorkspace()`，见 renderer/app-bindings.js）✓ */
    window.desktop.on('menu:bind-workspace', () => { if (MM.bindWorkspace) MM.bindWorkspace(); });
    /* 【W13】界面侧导入入口（菜单「文件 → 导入 Markdown 文件… / 导入文件夹成新项目…」）：
     * 与命令面板里那两条**同一个实现**（`MM.importIntoMap({kind})`，见 renderer/app-import.js）✓ */
    window.desktop.on('menu:import-files', () => { if (MM.importIntoMap) MM.importIntoMap({ kind: 'files' }); });
    window.desktop.on('menu:import-dir', () => { if (MM.importIntoMap) MM.importIntoMap({ kind: 'dir' }); });
    // 菜单「视图 → 关闭思维导图页」：与工具栏那个 ✕ **同一条路**（先拦未保存编辑 ⇒ 保存成功才卸页）
    window.desktop.on('menu:close-map-page', () => { MM.closeMapPage(); });
    // 主进程 toast（导入导出结果提示）与项目列表刷新（导入 JSON 后）
    window.desktop.on('app:toast', (text, isErr) => setStatus(text, !!isErr));
    window.desktop.on('menu:project-changed', () => loadProjects());
    // 「边聊边编辑」：侧栏 AI 改盘上 JSON → 实时同步到导图（脏冲突保护在 handler 内）
    if (window.desktop.onProjectDiskChange && MM.onProjectDiskChange) {
      window.desktop.onProjectDiskChange((filename) => MM.onProjectDiskChange(filename));
    }
    // A（AI 产出直接落到节点）：问答落盘后**立刻**对齐内存树。
    // 为什么复用 onProjectDiskChange 而不是自己改内存：那条路已经有脏冲突保护、
    // 世代校验与"外部改了别覆盖人的编辑"三条判定（重写一遍必然漏一条 ✗）。
    // 为什么还要显式触发：fs.watch 有 300ms 防抖 ⇒ 不触发的话界面上会"晚一拍"才看见
    // 新子节点，而断言要判的就是"界面侧也变了"（一条 300–600ms 的延迟足以让断言随机红）。
    if (MM.requestReread) {
      window.desktop.on('app:project-reread', () => MM.requestReread());
    }
  }

  /* ================= 对外 API（供 editor.js / 冒烟断言 / 未来 AI 注入使用） ================= */
  window.MMApp = {
    getState,
    serializeTree,
    save,
    // 并发冲突的两条出路（界面按钮与冒烟断言共用同一份语义）：
    //   resolveConflict('theirs') = 用磁盘上的版本（只丢冲突对象上的改动）；'mine' = 保留我的、本次不保存
    resolveConflict: (choice) => MM.resolveConflict(choice),
    hasPendingConflict: () => MM.hasPendingConflict(),
    // 打开节点对应的本机文件夹（节点字段 localPath；详情框的链接与右键菜单都走它）
    openLocalPath: (p) => MM.openLocalPath(p),
    addNode,
    addSiblingNode,
    addTopic,
    resetView,
    getPanState,
    setViewScale,
    setDragMode: (on, treeRootId, opts) => MM.setDragMode(on, treeRootId, opts),
    dragModeActive: () => MM.dragModeActive(),
    getDragTreeRoot: () => MM.getDragTreeRoot(),
    // 【R2 期 3 · e】同级重排：现状读数（断言用）/ 取消（Esc、右键、收尾共用一处）
    reorderState: () => (MM.reorderState ? MM.reorderState() : null),
    dragModeKind: () => (MM.dragModeKind ? MM.dragModeKind() : null),
    reorderCancel: () => (MM.reorderCancel ? MM.reorderCancel() : false),
    // 【R2 期 4 · f】重挂拖动：现状读数（断言用）/ 取消（Esc、右键、收尾共用一处）
    reparentState: () => (MM.reparentState ? MM.reparentState() : null),
    reparentCancel: () => (MM.reparentCancel ? MM.reparentCancel() : false),
    // 【R2 期 3 · e】同级重排的**唯一写口**（→ IPC → CLI `move --index` → 回读重建）。
    // 顺带暴露 `reorderNodeChildRaw`：语义逐字相同但**绕过界面 clamp** —— 它是"越界必被 CLI 拒"那条
    // 判据的**唯一注入点**（界面 clamp 之后永远发不出越界值，光靠拖动判不到那条 ✗）。
    reorderNodeChild: (id, parentId, index) => (MM.reorderNodeChild
      ? MM.reorderNodeChild(id, parentId, index) : Promise.resolve({ ok: false, text: '没有 reorderNodeChild 入口' })),
    reorderNodeChildRaw: (id, parentId, index) => (MM.reorderNodeChildRaw
      ? MM.reorderNodeChildRaw(id, parentId, index) : Promise.resolve({ ok: false, text: '没有 reorderNodeChildRaw 入口' })),
    // 【R2 期 4 · f】重挂父：确认版（预览 + 确认 + 写 + 回读重建）与 raw 版（绕过预览/确认、
    // 直通写通道 —— 里面仍有 --dry-run 预检；只给域 49 的判据取证用，UI 没有调用点）。
    reparentNode: (id, newParentId) => (MM.reparentNode
      ? MM.reparentNode(id, newParentId) : Promise.resolve({ ok: false, text: '没有 reparentNode 入口' })),
    reparentNodeRaw: (id, newParentId) => (MM.reparentNodeRaw
      ? MM.reparentNodeRaw(id, newParentId) : Promise.resolve({ ok: false, text: '没有 reparentNodeRaw 入口' })),
    treeRootOf: (nodeId) => MM.treeRootOf(nodeId),
    clearTreeOffsets: (treeId) => MM.clearTreeOffsets(treeId),
    // 树偏移读口（框选拖动持久化的真源在 app-view.js 的 treeOffsets）：序列化与冒烟断言用
    getTreeOffsets: () => (MM.getTreeOffsets ? MM.getTreeOffsets() : {}),
    // R2 期 1：更深的子树根那一桶（序列化写 meta.nodeOffsets 的同一份读数）
    getNodeOffsets: () => (MM.getNodeOffsets ? MM.getNodeOffsets() : {}),
    hasOwnOffset: (id) => !!(MM.hasOwnOffset && MM.hasOwnOffset(id)),
    themeSideOf: (id) => (MM.themeSideOf ? MM.themeSideOf(id) : null),
    setThemeSide: (id, side) => (MM.setThemeSide
      ? MM.setThemeSide(id, side) : Promise.resolve({ ok: false, reason: '没有 setThemeSide' })),
    setTreeOffsets: (map, nodeMap) => (MM.setTreeOffsets ? MM.setTreeOffsets(map, nodeMap) : 0),
    // 框选（v0.16.3）：contextmenu.js 路由右键菜单用
    hasSelection: () => MM.hasSelection ? MM.hasSelection() : false,
    selectionHitTest: (x, y) => MM.selectionHitTest ? MM.selectionHitTest(x, y) : false,
    getSelection: () => MM.getSelection ? MM.getSelection() : { canDrag: false, groups: [] },
    dragSelection: () => MM.dragSelection(),
    collapseSelection: () => MM.collapseSelection(),
    expandSelection: () => MM.expandSelection(),
    clearSelection: () => MM.clearSelection(),
    applySelection: (ids) => MM.applySelection(ids),
    setRootMode,
    isThemeMode,
    editNode,
    deleteNode,
    expandAll,
    collapseAll,
    undo,
    redo,
    showDetail,
    hideFloatDetail,
    closeAllFloatDetail,
    positionFloatDetail,
    getFloatDetailState,
    /* 热度条（第三件·A）：给冒烟断言与排查读原始读数 —— **只读**，不改任何状态。
     * `heatBarsState()` 回的是"最近一次拿到的 `heat --json` 载荷 + 最近一次采样结果"，
     * 断言拿它与 CLI `heat --json` 对拍（判据①：界面显示的值与 CLI 逐字一致）。 */
    heatBarsState: () => (MM.heatBarsState ? MM.heatBarsState() : null),
    openLightbox,
    closeLightbox,
    lightboxZoom,
    openFilePreview,
    closeFilePreview,
    openProject,
    // 一次收干净所有模态/浮层（返回**本来开着哪些**，不静默关掉；见 app-actions.js 的说明）——
    // 冒烟框架在每个域开始时用它做"干净前置"，并把上一次留下的模态**点名叫出来** ✓
    closeAllDialogs: () => MM.closeAllDialogs(),
    runSearch,
    jumpToNode,
    // 未保存改动（供工具栏、菜单与冒烟断言使用）
    isDirty,
    confirmDiscardIfDirty: (label) => MM.confirmDiscardIfDirty(label),
    // **真关**导图页（v0.19：卸载这一页，不是隐藏）+ 自动化用的确认框桩
    closeMapPage: () => MM.closeMapPage(),
    setConfirmStub: (fn) => MM.setConfirmStub(fn),
    // 关系审计与命令面板（供工具栏、菜单、冒烟断言与 AI 注入使用）
    openAudit,
    closeAudit,
    addLinkFromAudit: (f, t) => MM.addLinkFromAudit(f, t),
    openPalette,
    closePalette,
    paletteIsOpen,
    /* 【R4】绑定工作区文件夹：入口由 app-bindings.js 注册（工具栏那个按钮的**同一条实现**） */
    /* 并发可见性（v0.20）：只读差异预览 / 冲突面板的公开入口（冒烟断言与排查用）。
     * ⚠️ 这几个都**只读**：面板自己不写盘 —— "用盘上"仍然走 resolveConflict（上面那一条）✓ */
    showDiskDiffPanel: () => MM.showDiskDiffPanel(),
    closeConcPanel: () => MM.closeConcPanel(),
    concPanelOpen: () => MM.concPanelOpen(),
    closeConcBanner: () => MM.closeConcBanner(),
    refreshDiskDiff: () => MM.refreshDiskDiff(),
    /* 【R4】绑定工作区文件夹（界面侧）。这几个入口与工具栏那个按钮**同一条实现**
     * （`renderer/app-bindings.js`）—— 冒烟断言与排查用它驱动同一条产品路径，
     * 判据仍然读**内容 / 命中测试 / 盘上字节**，不靠这些 getter 自证。
     * ⚠️ 它们**都不含同步判定**：绑定/暂停/立即同步/解绑各自打到 CLI `bind-sync` 的一个既有开关上。 */
    bindWorkspace: () => MM.bindWorkspace(),
    bindRefresh: () => MM.bindRefresh(),
    bindAct: (action) => MM.bindAct(action),
    bindPreviewRun: () => MM.bindPreviewRun(),
    bindPreviewCancel: () => MM.bindPreviewCancel(),
    bindPreviewConfirm: () => MM.bindPreviewConfirm(),
    bindPreviewShown: () => MM.bindPreviewShown(),
    bindShowBroadcast: () => MM.showBindPanel(),
    bindCloseBanner: () => MM.closeBindBanner(),
    bindBannerShown: () => MM.bindBannerShown(),
    bindBannerText: () => MM.bindBannerText(),
    bindState: () => MM.bindState(),
    setStatus
  };

  // 启动
  document.addEventListener('DOMContentLoaded', () => {
    wireUI();
    loadProjects();
  });
})();
