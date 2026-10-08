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

    // 导图页右上角独立 ✕：**只关左边导图页**（进"仅侧栏"模式，连菜单栏一起隐掉），侧栏留着。
    // 与窗口的 ✕ 分工不同：窗口 ✕ = 关整个应用；详情框里那个 ✕ = 关详情框。
    // 动态插入而不是写进 index.html：接线集中在这一处，也避免与工具栏既有布局打架。
    (() => {
      const bar = document.getElementById('toolbar');
      if (!bar || document.getElementById('btn-close-map')) return;
      const btn = document.createElement('button');
      btn.id = 'btn-close-map';
      btn.title = '关闭导图页（只留 DSH 侧栏；窗口 ✕ 才是退出应用）';
      btn.textContent = '✕';
      btn.style.marginLeft = '4px';
      btn.addEventListener('click', () => {
        if (window.desktop && window.desktop.dsh && window.desktop.dsh.sidebarOnly) {
          window.desktop.dsh.sidebarOnly(true);
        }
      });
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
    // 主进程 toast（导入导出结果提示）与项目列表刷新（导入 JSON 后）
    window.desktop.on('app:toast', (text, isErr) => setStatus(text, !!isErr));
    window.desktop.on('menu:project-changed', () => loadProjects());
    // 「边聊边编辑」：侧栏 AI 改盘上 JSON → 实时同步到导图（脏冲突保护在 handler 内）
    if (window.desktop.onProjectDiskChange && MM.onProjectDiskChange) {
      window.desktop.onProjectDiskChange((filename) => MM.onProjectDiskChange(filename));
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
    setDragMode: (on, treeRootId) => MM.setDragMode(on, treeRootId),
    dragModeActive: () => MM.dragModeActive(),
    getDragTreeRoot: () => MM.getDragTreeRoot(),
    treeRootOf: (nodeId) => MM.treeRootOf(nodeId),
    clearTreeOffsets: (treeId) => MM.clearTreeOffsets(treeId),
    // 树偏移读口（框选拖动持久化的真源在 app-view.js 的 treeOffsets）：序列化与冒烟断言用
    getTreeOffsets: () => (MM.getTreeOffsets ? MM.getTreeOffsets() : {}),
    setTreeOffsets: (map) => (MM.setTreeOffsets ? MM.setTreeOffsets(map) : 0),
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
    openLightbox,
    closeLightbox,
    lightboxZoom,
    openFilePreview,
    closeFilePreview,
    openProject,
    runSearch,
    jumpToNode,
    // 未保存改动（供工具栏、菜单与冒烟断言使用）
    isDirty,
    confirmDiscardIfDirty: (label) => MM.confirmDiscardIfDirty(label),
    // 关系审计与命令面板（供工具栏、菜单、冒烟断言与 AI 注入使用）
    openAudit,
    closeAudit,
    addLinkFromAudit: (f, t) => MM.addLinkFromAudit(f, t),
    openPalette,
    closePalette,
    paletteIsOpen,
    setStatus
  };

  // 启动
  document.addEventListener('DOMContentLoaded', () => {
    wireUI();
    loadProjects();
  });
})();
