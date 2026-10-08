/* ============================================================
 * AI MindMap — 渲染层核心底座（app-core.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 初始化共享命名空间 window.MM（**本文件必须最先加载**）
 *   2) 共享状态底座：state、UndoStack 兜底、跨模块共享的可变槽位
 *   3) 序列化（jsMind → 工程 JSON）：serializeTree
 *   4) 导图渲染入口：renderMind / rebuildFromJson
 *   5) 详情与图片区共用纯函数：escHtml / nodeImages / nodeFiles
 *   6) 状态栏：setStatus
 * 边界（本文件不负责）：
 *   · 画布视图与平移缩放 → app-view.js
 *   · 浮动详情框 → app-detail.js / app-detail-drag.js / app-detail-content.js
 *   · 图片灯箱与文件预览 → app-media.js
 *   · 编辑操作与数据读写 → app-actions.js
 *   · UI 接线与对外 API → app.js
 * 所有搬迁的函数体与拆分前逐字相同（含缩进、注释、空行、中文）；
 * 本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  /* —— 跨模块共享的可变槽位（拆分前是同一个 IIFE 闭包里的 let 变量）——
   * 这几个变量被多个文件读写、且会被整体重新赋值，无法用「同一引用」的别名共享，
   * 因此用与拆分前**同名**的全局槽位承载：函数体里仍是裸名读写，一个字符都不用改。
   * 读写只发生在事件回调与渲染时，不在模块求值时，故与脚本加载顺序无关。 */
  window.fdView = { x: 0, y: 0, s: 1 };
  window.fdHideRootLinks = false;
  window.fdDrag = null;  // 拖动中：{ box, x, y, l, t, cw, ch, w, h }
  window.fdResize = null; // 改大小中：{ box, dir, S, x, y, l, t, w, h }

  const $ = (sel) => document.querySelector(sel);
  const UndoStack = (window.MMHistory && window.MMHistory.UndoStack) || function () { return { push: function () {}, canUndo: function () { return false; }, canRedo: function () { return false; }, undo: function () { return null; }, redo: function () { return null; } }; };

  const state = {
    jm: null,                // jsMind 实例
    project: null,           // { name, file }
    history: new UndoStack(50),
    ready: false,
    selectedNode: null,      // 当前浮动详情对应的节点
    // 「关联笔记」是**项目级集合、不属于节点树**。它必须在这里被持有，
    // 并由 serializeTree 原样写回 —— 否则界面每次保存都会把它抹掉
    // （jsMind 只承载节点树，任何"不在树里的数据"都得靠这条通道存活）。
    assoc: [],
    // 主题布局（meta.layout：{ left:[主题id], right:[主题id] }）。renderMind 载入时
    // 持有，serializeTree 原样写回 —— 否则界面保存会把方向配置抹掉。
    metaLayout: null
  };

  const getState = () => state;

  /* ================= 序列化（jsMind → 工程 JSON） =================
   * jsMind 的 get_data('node_tree') 会丢失节点自定义字段
   * （detail/images/links 存在 node.data 上），这里手动平铺。
   */
  function serializeTree() {
    const jm = state.jm;
    if (!jm) return null;
    const walk = (n) => {
      const out = { id: n.id, topic: n.topic, expanded: n.expanded !== false };
      if (n.data) {
        if (n.data.detail) out.detail = n.data.detail;
        if (Array.isArray(n.data.tags) && n.data.tags.length) out.tags = n.data.tags;
        if (Array.isArray(n.data.images) && n.data.images.length) out.images = n.data.images;
        if (Array.isArray(n.data.files) && n.data.files.length) out.files = n.data.files;
        if (Array.isArray(n.data.links) && n.data.links.length) out.links = n.data.links;
        if (n.data.background) out.background = n.data.background;
        // 本机文件夹路径：**必须在这里平铺**，否则界面保存（整树写回）会把这个字段丢掉 ——
        // 与曾经"保存不丢 assoc"是同一类静默数据丢失（有专门的冒烟断言守着）。
        if (n.data.localPath) out.localPath = n.data.localPath;
      }
      if (n.children && n.children.length) out.children = n.children.map(walk);
      return out;
    };
    const root = jm.get_node('root') || jm.mind.root;
    // 树偏移（框选后拖动的结果）：**向视图层要**（唯一真源在 app-view.js 的 treeOffsets），
    // 只写非零项 ⇒ 没拖过的项目与旧文件零差异（与 rootMode / layout 同一套"条件写回"手法）。
    const themeOffsets = (MM.getTreeOffsets && MM.getTreeOffsets()) || {};
    const out = {
      meta: {
        name: state.project ? state.project.name : '未命名项目',
        author: '',
        // 版本号单源：读共享核心 src/config.js 的 APP_VERSION（index.html 已先加载）。
        // 历史上此处硬编码 '0.13.0'，导致界面每次保存都把 meta.version 回写成陈旧版本。
        version: (window.MMConfig && window.MMConfig.APP_VERSION) || '0.0.0',
        formatVersion: 2,
        // 主题模式（顶层主题互相独立）需持久化，否则重新打开会退回单中心
        ...(state.rootMode === 'themes' ? { rootMode: 'themes' } : {}),
        // 主题布局（左右分侧）需持久化，否则重新打开会退回全右侧堆叠
        ...(state.metaLayout ? { layout: state.metaLayout } : {}),
        // 树偏移同理：不写回就等于"拖了白拖"（用户报的正是"框选后的移动无法保存"）
        ...(Object.keys(themeOffsets).length ? { themeOffsets } : {})
      },
      format: 'node_tree',
      data: walk(root)
    };
    // 关联笔记不属于节点树，必须在这里原样带出；否则保存即丢（仅在非空时写，保持旧形状）
    if (Array.isArray(state.assoc) && state.assoc.length) out.assoc = state.assoc;
    return out;
  }

  /* ================= 渲染 ================= */
  /* ================= 节点标题的行内 Markdown =================
   * 源笔记的标题常带 `**加粗**`（如 `## **sysfs文件系统**`），导入后 topic 里就是**字面量** ——
   * 直接显示成 `**sysfs文件系统**` 既难看又占宽。这里做**渲染期**的行内转换（加粗 / 行内代码）。
   *
   * ⚠️ 转换只发生在 DOM 层，**绝不写回数据**：
   *   `serializeTree()` 读的是 jsMind 节点的 topic（原文）—— 若把 `<strong>` 塞进 jsMind 数据，
   *   界面一保存就会把 HTML 写进 topic（静默污染数据）。所以这里改的是渲染出来的 `jmnode` 元素。
   * 幂等：转换后再读 `textContent` 已不含标记（`<strong>x</strong>` 的 textContent 是 `x`），
   *   重复调用不会二次转义；jsMind 重建该节点元素时会重新写回原文，下次调用再转一次。
   * 顺带修好一类老问题：topic 里含 `<`/`&` 的字面文本（支持 HTML 的模式下本来会被当标签解析），
   *   现在统一先整体转义再还原两种行内语法。 */
  const TOPIC_INLINE_RE = /\*\*[^*\n]+\*\*|`[^`\n]+`/;
  function topicMarkup(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }
  function applyTopicMarkup(jm) {
    const host = (jm && jm.view && jm.view.e_panel) || document.getElementById('jsmind_container');
    if (!host) return 0;
    let n = 0;
    host.querySelectorAll('jmnode').forEach((el) => {
      const plain = el.textContent;
      if (!plain || !TOPIC_INLINE_RE.test(plain)) return;
      el.innerHTML = topicMarkup(plain);
      n++;
    });
    return n;
  }

  function renderMind(data) {
    // 「关联笔记」随项目数据一起进来，在这里统一接管（renderMind 是打开项目与
    // undo/redo 两条路径的唯一入口，故这一处即可覆盖两者）。
    // 它是项目级集合、不在节点树里，只有靠 state 持有 + serializeTree 写回才能存活。
    state.assoc = (data && Array.isArray(data.assoc)) ? data.assoc : [];
    // 主题布局随项目数据进来并持有（序列化时写回，防止界面保存丢失方向配置）
    state.metaLayout = (data && data.meta && data.meta.layout) || null;
    // 先清空容器：jsMind **不会**清理 container，重复建图会在同一容器里堆叠出多棵结构
    // 相同的 DOM 树（实测同一节点出现 2 份 jmnode），于是 document.querySelector 可能命中
    // 旧树 —— 详情框锚定、平移、滚动都会作用到错误的元素上。
    const jsmindHost = document.getElementById('jsmind_container');
    if (jsmindHost) jsmindHost.innerHTML = '';
    // —— 统一视图变换：只用一个 transform（translate + scale）作用在 canvas 与节点层 ——
    // 关键教训：jsMind 原生用「e_panel.scrollLeft/Top（滚动）+ 子元素 style.zoom」实现平移缩放，
    // 若我们再在外层叠一套 transform，就形成两套坐标系，放大后内容超出面板、滚动又够不到，
    // 于是"放大显示不全"。这里改为：**完全不调用 jsMind 的 zoom/scroll**（其内部 zoom_current
    // 恒为 1、滚动恒为 0），平移与缩放全部由 fdView 这一个 transform 承担。
    fdView = { x: 0, y: 0, s: 1 };
    fdHideRootLinks = fdIsThemeMode(data); // 主题模式标志（连线绘制前置位）
    // 树偏移随画布重建复位：renderMind 是切换项目与 undo/redo 的唯一入口，
    // 重建即回到"初始布局"（与 fdView 重置同一语义，避免残留偏移错位）。
    if (MM.clearTreeOffsets) MM.clearTreeOffsets();
    if (MM.clearSelection) MM.clearSelection(); // 框选同理（纯视图状态，重建即清）
    if (MM.resetLayoutAnchor) MM.resetLayoutAnchor();   // 新树 = 新元素，重排锚点作废

    const jm = new jsMind({
      container: 'jsmind_container',
      theme: 'primary',
      editable: true,
      support_html: true,
      // 范围放宽到 0.15–4；但缩放由我们自管（jsMind 的 zoom/scroll 不再使用）
      view: { zoom: { min: 0.15, max: 4, step: 0.1, mask_key: 4096 } },
      // 双击与快捷键由本工程接管（editor.js / contextmenu.js），禁用 jsMind 内置行为避免冲突
      default_event_handle: { enable_dblclick_handle: false },
      shortcut: { enable: false }
    });

    // 主题模式：重写连线绘制，按「父节点是否为根」精确跳过根→顶层子女的连线
    // （只重画 canvas 上的线，绝不动节点 DOM —— 与曾导致节点全消失的 view.reset() 不同）。
    installRootLineOverride(jm);

    // 兼容 jsMind 的 set_zoom(scale, point) 契约，但内部转到统一 transform，
    // 绝不使用其原生「style.zoom + 滚动」实现（否则又会形成双坐标系）。
    jm.view.set_zoom = function (scale, point) {
      const r = this.e_panel.getBoundingClientRect();
      const px = point ? point.x - r.left : r.width / 2;
      const py = point ? point.y - r.top : r.height / 2;
      zoomViewAt(px, py, scale / fdView.s, 0.0001, 99);
      return true;
    };
    jm.view.zoom_in = function (point) { this.set_zoom(fdView.s + 0.1, point); };
    jm.view.zoom_out = function (point) { this.set_zoom(fdView.s - 0.1, point); };

    // 主题布局：依 meta.layout 在 show 前给顶层主题标 direction（jsMind 左右分侧），
    // 未列出的主题保持默认右侧。方向唯一真源是 meta.layout（序列化不带 direction）。
    applyThemeLayout(data);
    jm.show(data);
    // 重排锚点保持：包住 view.relayout()，让"刚被展开/收起的那个节点"在屏幕上原地不动
    //（jsMind 会把每个父节点的子节点栈重新居中 ⇒ 不动手就是"页面跳来跳去"；见 app-view.js）。
    if (MM.wrapLayoutAnchor) MM.wrapLayoutAnchor(jm);
    // 展开状态**以数据为准**（节点的 `expanded` 字段）。原先这里是无条件 `expand_to_depth(3)`：
    // 后果一是"在界面收起的节点，下次打开又被强制展开"（用户的折叠白做了），
    // 后果二是导入的大树一打开就是一片全展开、要滚很久才找到东西（用户反馈）。
    // 现在不再在渲染层兜底展开；数据本身的默认值由导入器（前两层展开）与一棵树的规范化负责。
    applyTopicMarkup(jm);
    state.jm = jm;
    applyRootMode(jm, data);
    // 树偏移：**数据 → 视图**。顺序有讲究：必须在 `state.jm` 就位、节点 DOM 建好之后
    // （setTreeOffsets 要按当前树筛掉不存在的主题），且在 centerOnRoot 之前 ——
    // 偏移只动顶层主题、不动根节点，先落偏移再定视口少闪一下 ✓。
    if (MM.setTreeOffsets) MM.setTreeOffsets((data.meta && data.meta.themeOffsets) || null);
    bindViewportControls(); // 视口滚轮缩放 / 中键平移 / 滚动吸收（全局只绑一次）
    // 打开即把根节点摆到视口正中；再延迟一次以覆盖 jsMind 的异步布局
    centerOnRoot();
    setTimeout(() => { if (state.jm === jm) { neutralizeScroll(); centerOnRoot(); } }, 80);

    fdStartWatch();

    // 点击选中 / 空白处隐藏 / 窗口 resize / 节点层变化监听：
    // 统一交给「全局只绑一次」的接线函数，观察者则在每次重建时先 disconnect 再重挂。
    // 历史 bug：这三处原先直接内联在 renderMind 内，而 renderMind 每次 undo/redo /
    // 切换项目都会执行 → 监听器与 MutationObserver 无限累积（全工程 59 个
    // addEventListener 对应 0 个 removeEventListener），表现为点击一次触发 N 次
    // showDetail、详情框重复定位、内存持续增长。
    bindContainerControls();
    observeNodeLayer(jm);

    window.__mindReady = true;
    setStatus('已加载：' + (data.meta ? data.meta.name : ''));
  }

  function rebuildFromJson(json) {
    renderMind(json);
  }

  /* ================= 详情 / 图片面板 ================= */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function nodeImages(node) {
    return (node && (node.images || (node.data && node.data.images))) || [];
  }
  function nodeFiles(node) {
    return (node && (node.files || (node.data && node.data.files))) || [];
  }

  /* ================= DSH 侧边栏让位（v0.16） =================
   * WebContentsView 是主窗口右侧的覆盖层（不参与 DOM 布局）。
   * 这里只做三件事：
   *   1) 监听 dsh-sidebar:layout → body class + margin 让位（导图与工具栏不被遮住）
   *   2) 状态栏提示 DSH 生命周期（启动中/就绪/失败）
   *   3) 拖宽分隔条：侧栏左缘 6px 热区内 mousedown → 通知主进程接管拖拽
   *      （主进程用 screen.getCursorScreenPoint 轮询改宽度，Escape 结束）
   * token/URL 永不进渲染层（toggle 走应用菜单 Ctrl+B）。 */
  function bindDshSidebar() {
    if (!window.desktop || !window.desktop.on) return;
    // 折叠后的重展开圆钮（主界面右缘中部）：主进程 layout(false) 时显示
    let fab = document.getElementById('dsh-restore-fab');
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'dsh-restore-fab';
      fab.title = '展开 DSH 侧边栏（Ctrl+B）';
      fab.textContent = '🤖';
      fab.addEventListener('click', () => {
        if (window.desktop.dsh && window.desktop.dsh.toggle) window.desktop.dsh.toggle();
      });
      document.body.appendChild(fab);
    }
    fab.style.display = 'none'; // 初始隐藏（layout 事件到达后按可见性同步）
    // 收到布局信息 → 应用（订阅与"主动问"共用同一段逻辑，避免两条路各写一份）
    let lastSidebarLayout = '';
    const applyLayout = (info) => {
      const visible = !!(info && info.visible);
      const width = (visible && info.width) || 0;
      const key = visible + ':' + width;
      // 诊断留痕：最后一次**收到**的布局信息（给断言/排查用：能区分"事件没送到"与"送到的是旧值"）
      window.__dshLayoutLast = { visible: visible, width: width, key: key, at: Date.now() };
      // ── 下面三件都是**纯 DOM 同步，每次必做**（幂等、代价极低）──
      // 教训：上一版把它们放进"状态没变就 return"的守卫里 ⇒ 一旦某条路径没触发状态变化，
      // 就让位变量/FAB 落空，用户看到"灰色背景"和"重开圆钮不见了"。守卫只该守住**扰动视图**的那件事。
      document.body.classList.toggle('dsh-sidebar-on', visible);
      // `--dsh-sidebar-width` 必须显式写：不写就回落到 style.css 的兜底值 420px，
      // 而侧栏实际可能只有 308 ⇒ 页面多留 112px ⇒ 就是用户看到的"侧栏隔壁灰色背景"。
      document.body.style.setProperty('--dsh-sidebar-width', width + 'px');
      window.__dshSidebarW = width;
      // 折叠圆钮（🤖 重开入口）：侧栏可见时藏、折叠时显示
      const fab2 = document.getElementById('dsh-restore-fab');
      if (fab2) fab2.style.display = visible ? 'none' : 'flex';
      // ── 只有"扰动视图"这件事需要守卫 ──
      // resize 是告诉渲染层"导图区宽度变了"：若每次都派发，启动时那次主动询问会白白扰动一次视图
      // （浮动详情重定位、树偏移/居中重算 —— 实测把"拖动树后 Esc 保留偏移"的断言搞红）。
      if (key === lastSidebarLayout) return;
      lastSidebarLayout = key;
      window.dispatchEvent(new Event('resize'));
    };
    window.desktop.on('dsh-sidebar:layout', applyLayout);
    // ⚠️ 订阅完必须**主动问一次**当前布局：主进程首次发送发生在页面加载完成之前
    //（`init(win)` 里那次），订阅还不存在 ⇒ 消息丢掉 ⇒ body 上既没有 class 也没有 CSS 变量
    // ⇒ 工具栏右侧被原生侧栏盖住，直到用户拖一下侧栏（拖宽会再发一次）才恢复。
    // 用户实测症状："刚打开时菜单栏被侧栏遮盖，稍微拖一下就恢复"。
    try {
      const st = window.desktop.dsh && window.desktop.dsh.status && window.desktop.dsh.status();
      // 优先用**实际占宽**（status().actualWidth，来自原生 view 的 bounds）：
      // `width` 只是意图/偏好，页面按它预留、侧栏按实际绘制 ⇒ 不一致就多留一条（灰缝）。
      const fromStatus = (s) => { if (s) applyLayout({ visible: s.visible, width: s.actualWidth || s.width }); };
      if (st && typeof st.then === 'function') {
        st.then(fromStatus).catch(() => {});
      } else if (st) {
        fromStatus(st);
      }
    } catch (e) { /* 问不到就等事件 */ }
    window.desktop.on('dsh-sidebar:status', (st) => {
      if (!st) return;
      if (st.status === 'starting') setStatus('DSH 启动中…（首次启动需要几十秒）');
      else if (st.status === 'running') setStatus('DSH 就绪（Ctrl+B 切换侧边栏）');
      else if (st.status === 'error') setStatus('DSH 侧边栏异常：' + (st.error || '未知'), true);
    });
    // 仅侧边栏模式：主界面隐藏（外部 AI 迭代主界面时用）；恢复时显示
    window.desktop.on('dsh-sidebar:dsh-only', (on) => {
      document.body.classList.toggle('dsh-only', !!on);
      window.dispatchEvent(new Event('resize'));
    });
    // 拖宽分隔条：当前侧栏左缘 x = 内容宽 - 侧栏宽；热区 ±6px。
    // mousedown 进入拖拽 → mouseup / Escape 结束（宽度计算与 setBounds 全在主进程）。
    if (window.desktop.dsh && window.desktop.dsh.beginDrag) {
      let dragging = false;
      const sidebarLeftEdge = () => window.innerWidth - (window.__dshSidebarW || 0);
      window.addEventListener('mousemove', (e) => {
        if (dragging) return;
        const onEdge = Math.abs(e.clientX - sidebarLeftEdge()) <= 8;
        document.body.style.cursor = onEdge ? 'col-resize' : '';
      });
      window.addEventListener('mousedown', (e) => {
        if (Math.abs(e.clientX - sidebarLeftEdge()) <= 8 && (window.__dshSidebarW || 0) > 0) {
          dragging = true;
          window.desktop.dsh.beginDrag();
          e.preventDefault();
        }
      });
      window.addEventListener('mouseup', () => {
        if (dragging) { dragging = false; window.desktop.dsh.endDrag(); }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dragging) {
          dragging = false;
          window.desktop.dsh.endDrag();
        }
      });
    }
  }
  /* ================= 状态栏（本文件定义，其他模块经 MM 转发调用） ================= */
  function setStatus(text, isErr) {
    const el = $('#status-text');
    el.textContent = text;
    el.style.color = isErr ? '#f53f3f' : '#86909c';
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const fdIsThemeMode = (data) => MM.fdIsThemeMode(data);
  const installRootLineOverride = (jm) => MM.installRootLineOverride(jm);
  const zoomViewAt = (px, py, factor, min, max) => MM.zoomViewAt(px, py, factor, min, max);
  const applyRootMode = (jm, data) => MM.applyRootMode(jm, data);
  const applyThemeLayout = (data) => MM.applyThemeLayout(data);
  const bindViewportControls = () => MM.bindViewportControls();
  const centerOnRoot = () => MM.centerOnRoot();
  const neutralizeScroll = () => MM.neutralizeScroll();
  const fdStartWatch = () => MM.fdStartWatch();
  const bindContainerControls = () => MM.bindContainerControls();
  const observeNodeLayer = (jm) => MM.observeNodeLayer(jm);

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.$ = $;
  MM.UndoStack = UndoStack;
  MM.state = state;
  MM.getState = getState;
  MM.serializeTree = serializeTree;
  MM.renderMind = renderMind;
  MM.rebuildFromJson = rebuildFromJson;
  MM.escHtml = escHtml;
  MM.topicMarkup = topicMarkup;          // 单源：行内 Markdown → HTML（供详情框标题等复用）
  MM.applyTopicMarkup = applyTopicMarkup;
  MM.nodeImages = nodeImages;
  MM.nodeFiles = nodeFiles;
  MM.setStatus = setStatus;
  MM.bindDshSidebar = bindDshSidebar;
})();
