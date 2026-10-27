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

  /* 载入时那份 `meta.formatVersion`（唯一真源 = 盘上/快照里读到的那份）。
   * 为什么不能写死 2：条目层（v3）把项目的 `formatVersion` 升成 3，而界面保存是**整份写回** ⇒
   * 写死 2 = 每次界面保存都把 v3 项目**降级**成 v2（`meta` 也是手挑字段的，见 serializeTree）。
   * 载入时没有这个键 ⇒ 仍按 v2 写（**不凭空造 3**）；`renderMind` 是打开项目与
   * undo/redo 的唯一入口 ⇒ 在这一处接管即可覆盖两者（快照里的 meta 也带着它回来 ✓）。 */
  let metaFormatVersion = 2;

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
        // AI 问答记录（可选字段，见 docs/DATA-FORMAT.md §2.7）：**同理必须平铺**。
        // 漏了它的后果比 localPath 更重：`qa` 是"这段结论是哪次 AI 交流得来的"，而 AI 问答落盘
        // 走的是 CLI（外部写盘）—— 只要用户随后在界面上按一次保存（整树写回），刚落盘的问答记录
        // 就会被**静默抹掉**，而界面上一切正常（`scripts/smoke/38-ai-落盘.js` 断言⑤专治这一条）。
        if (Array.isArray(n.data.qa) && n.data.qa.length) out.qa = n.data.qa;
        // 来源指纹（可选字段，见 docs/DATA-FORMAT.md §2.8）：**同理必须平铺**。
        // 它是"这份文档导过没有"的唯一判据（导入幂等闸门靠它），而导入走的是 CLI（外部写盘）——
        // 只要用户随后在界面上按一次保存（整树写回），import-project/import-md 留下的 origin
        // 就会被**静默抹掉** ⇒ 同一份文档又能被导入第二遍（正是本批要治的那个缺陷）。
        // 与 qa / localPath 同一类，判据在 `scripts/smoke/27-import-doc.js`。
        // 只在有值时写（保持旧形状：没导入过的节点与老文件零差异）。
        if (n.data.origin && typeof n.data.origin === 'object') out.origin = n.data.origin;
        // 条目层（v3）：**原样平铺，一个字节都不改**。
        // 为什么必须在这里（同一处漏字段的三个先例：qa / localPath / origin）：
        //   条目层的**真源就是 `items`**，`detail` 只是它的落盘派生缓存（docs/ITEM-MODEL.md §2）；
        //   界面保存是**整树写回**（`serializeTree` 手挑字段）—— 漏掉这一行，用户按一次保存
        //   （或 Ctrl+Z/重做走同一份快照）就会把整层条目**静默抹掉**：节点退回 v2、detail 还在
        //   ⇒ **没有任何门禁会红**，而条目级 id/src/verified/tags 永久丢失。
        // ⚠️ 下划线键（`_container`/`_groupStart`/`_gap`/`_tail`）**一并原样带回去**：它们是
        //   解析期事实、由 CLI 写入，界面**只负责搬运**，不许自己决定删或补（去留是契约问题）。
        // ⚠️ 判据是 `Array.isArray`：空数组 `[]` 也是"有 items"（= 已条目化，见契约 §2），
        //   必须写回；不是数组/不在场 ⇒ **一个字节都不写**（v2 项目与旧文件逐字节零差异）。
        if (Array.isArray(n.data.items)) out.items = n.data.items;
        if (n.data.detailMode) out.detailMode = n.data.detailMode;
      }
      if (n.children && n.children.length) out.children = n.children.map(walk);
      return out;
    };
    const root = MM.adapter.getRoot(jm);
    // 树偏移（框选后拖动 / 拖动子树的结果）：**向视图层要**（唯一真源在 app-view.js 的 treeOffsets），
    // 只写非零项 ⇒ 没拖过的项目与旧文件零差异（与 rootMode / layout 同一套"条件写回"手法）。
    // 两个键**同一处实现、按树结构分桶**（顶层主题 / 更深的子树根，见 app-view.js 的 collectOffsets）：
    //   · themeOffsets（2026-10-08 起）：顶层主题的偏移；
    //   · nodeOffsets （2026-10-14 起，R2 期 1）：更深的节点/子树根的偏移。
    // ⚠️ 两个都必须**条件写回**（非空才写）：无条件写会让每个项目保存一次就多出一个空键
    //   ⇒ 破"默认档逐字节不变"（这正是本期注入②要判红的那一处）。
    const themeOffsets = (MM.getTreeOffsets && MM.getTreeOffsets()) || {};
    const nodeOffsets = (MM.getNodeOffsets && MM.getNodeOffsets()) || {};
    const out = {
      meta: {
        name: state.project ? state.project.name : '未命名项目',
        author: '',
        // 版本号单源：读共享核心 src/config.js 的 APP_VERSION（index.html 已先加载）。
        // 历史上此处硬编码 '0.13.0'，导致界面每次保存都把 meta.version 回写成陈旧版本。
        version: (window.MMConfig && window.MMConfig.APP_VERSION) || '0.0.0',
        // 版本号**继承载入时那一份**（见 metaFormatVersion 的说明）：写死 2 ⇒ 界面保存会把
        // v3（条目层）项目静默降级成 v2。载入时没有这个键 ⇒ 仍是 2（不凭空造 3）。
        formatVersion: metaFormatVersion,
        // 主题模式（顶层主题互相独立）需持久化，否则重新打开会退回单中心
        ...(state.rootMode === 'themes' ? { rootMode: 'themes' } : {}),
        // 主题布局（左右分侧）需持久化，否则重新打开会退回全右侧堆叠
        ...(state.metaLayout ? { layout: state.metaLayout } : {}),
        // 树偏移同理：不写回就等于"拖了白拖"（用户报的正是"框选后的移动无法保存"）
        ...(Object.keys(themeOffsets).length ? { themeOffsets } : {}),
        ...(Object.keys(nodeOffsets).length ? { nodeOffsets } : {})
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

  /* 全工程**唯一**的两处 Markdown 渲染口（用户反馈「很多地方**字面量**没渲染成粗体」）——
   *   · `mdInline`：**一行**里的加粗/行内代码（标题、列表项、标签）⇒ 只做行内替换，先整体转义 ✓；
   *   · `mdBlock`：**整段** Markdown（AI 的回答、笔记正文）⇒ 走 `src/convert.js` 的 markdownToHtml ✓
   *     （与 `--note-md` 导入走的是同一个转换器 ⇒ 一份实现、两种来源表现一致 ✓）。
   * ⚠️ 两者都**只作用于 DOM**，绝不写回数据（`serializeTree` 读的是原文 ✓，见上面 topic 的说明）。 */
  function mdInline(text) { return topicMarkup(text); }
  function mdBlock(text) {
    const s = String(text == null ? '' : text);
    if (window.MMConvert && window.MMConvert.markdownToHtml) {
      try {
        const html = window.MMConvert.markdownToHtml(s);
        if (html) return html;
      } catch (e) { /* 转换失败退回行内渲染 —— 宁可少渲染，不可整段丢失 ✗ */ }
    }
    return topicMarkup(s).replace(/\n/g, '<br>');
  }

  function applyTopicMarkup(jm) {    const host = (jm && jm.view && jm.view.e_panel) || document.getElementById('jsmind_container');
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

  /** 【折叠默认】打开项目后的**视图归一**：只展开根，其余一律收起（**不写数据**）。
   *
   *  为什么需要：用户反馈"新开的树 / 新编辑的子树应当是默认折叠"。数据里 `expanded:true` 可以有很多个
   *  （导入来的、历史留下的），而渲染层在 `1a06862` 之后是"**以数据为准**"⇒ 打开项目就是一片全展开、
   *  要滚很久才找到东西。本函数把**视图**收成"只展开根" —— 这是对 `1a06862` 那条"以数据为准"的
   *  **有意覆盖**（覆盖的是**显示**，不是数据 ✓）。
   *
   *  为什么只收起**根的直接子节点**（顶层主题），而不是逐节点收起：
   *  jsMind 的可见性是**从祖先往下传播**的（`set_visible(children,false)` 递归隐藏整棵子树，见
   *  `renderer/vendor/JSMIND-INTERNALS.md`）⇒ 收起顶层主题就等于把整棵树收进主题里，与库里
   *  "收起到树根"同一个手法（`renderer/app-view.js` 的 `collapseAll()` 已被用户实测过这一条 ✓）。
   *
   *  ⚠️ 三条边界（动这个函数之前先读；三条都是"改了就出事故"的形态）：
   *    ① **深层的 `expanded` 一个字节都不动** —— 那是用户自己的折叠/展开（裁决③：手动展开仍持久化在
   *       数据层）。"只展开根"落在**可见性**上：主题一收起，它的后代**全部不可见**，无论它们自己的
   *       `expanded` 说什么 ✓。若改成"逐节点收起"（`collapse_all` / `expand_to_depth(0)` 那一类），
   *       打开一次项目就把用户所有手动展开**在内存里抹平**，随后任何一次保存都会把它写回盘上
   *       ⇒ 那正是"我收起的节点下次打开又被强制展开、折叠白做了"这个老毛病。
   *    ② 顶层主题自身的 `expanded` **会**被置 false：这就是"只展开根"的定义。而且必须如此 ——
   *       圆钮的 +/− 与库的 `toggle_node` 都读 `node.expanded`（`renderer/vendor/jsmind.js`），
   *       只隐藏不改它的话，第一次点圆钮会**看起来没反应**（库判定"已展开 ⇒ 收起"，而画面上早收着了）。
   *    ③ 顺序：**必须**在 `wrapLayoutAnchor` 之前调用。那条"重排锚点保持"会为了让"被操作的那个节点
   *       原地不动"而补偿一次 transform，而打开项目时紧接着就要 `centerOnRoot()` 重新定位 ⇒ 两者叠算是白算。
   *       另外本函数**不写盘**：渲染层从不因为"打开项目"而保存；`openProject` 的"未保存基线"
   *       （`lastSavedSnapshot`）取自 `renderMind` 之后的 `snapshot()` ⇒ 归一不会被记成"有未保存改动" ✓。
   *
   *  @returns {number} 本次真正改写的顶层主题数（0 = 本来就只展开根 ⇒ 幂等）
   */
  function collapseBelowRoot(jm) {
    const root = MM.adapter.getRoot(jm);
    if (!root) return 0;
    let n = 0;
    (root.children || []).forEach((tp) => {
      const node = MM.adapter.getNode(jm, tp.id);
      if (!node || !node.children || !node.children.length) return;   // 没有子节点：没有可收的东西
      if (node.expanded === false) return;                            // 已经收起：不动它（少一次重排）
      MM.adapter.collapseNode(jm, tp.id);
      n++;
    });
    return n;
  }

  function renderMind(data, opts) {
    // 【折叠默认】"只展开根"只属于**打开/重载项目的首屏**，不属于撤销/重做：
    //   · 打开项目（`app-actions.js` 的 openProject）与"外部改盘自动重读"都是"从盘上取一份新数据来渲染"
    //     ⇒ 归一 ✓（默认）；
    //   · `rebuildFromJson`（撤销/重做）是"把用户刚才看过的那一版原地装回去"，再折叠一次等于
    //     每按一次 Ctrl+Z 就把视野收一遍，而且会让 `snapshot()` 与撤销栈里那份**不再相等**
    //     ⇒ 判脏口径跟着漂 ✓ ⇒ 显式传 `{collapseToRoot:false}` 关掉它。
    const collapseToRoot = !opts || opts.collapseToRoot !== false;
    // 「关联笔记」随项目数据一起进来，在这里统一接管（renderMind 是打开项目与
    // undo/redo 两条路径的唯一入口，故这一处即可覆盖两者）。
    // 它是项目级集合、不在节点树里，只有靠 state 持有 + serializeTree 写回才能存活。
    state.assoc = (data && Array.isArray(data.assoc)) ? data.assoc : [];
    // 主题布局随项目数据进来并持有（序列化时写回，防止界面保存丢失方向配置）
    state.metaLayout = (data && data.meta && data.meta.layout) || null;
    /* 图附加层（`graph`）：**只读**捕获一份（就为了在界面上说清"本项目带图附加层、本剖面不显示"）。
     * 两条口径：
     *   · **绝不写回** —— `serializeTree` 的字段白名单里没有它，盘上那份由主进程
     *     `prepareSavePayload`（载荷没带这个键才从磁盘取回）保住（§6.4 纪律②/§6.5 判据①）；
     *   · 只在"从盘上载入一份新数据"这一档更新（撤销/重做传的是 `{collapseToRoot:false}`）——
     *     快照里没有 `graph`（`serializeTree` 不产这个键）⇒ 不设这道闸，按一次 Ctrl+Z
     *     就会把"本项目带图附加层"那句提示抹掉，而盘上那份图一个字节都没变。 */
    if (collapseToRoot) {
      capGraph = (data && data.graph && typeof data.graph === 'object' && !Array.isArray(data.graph))
        ? data.graph : null;
    }
    // 载入时那份 `meta.formatVersion`（载入时没有 ⇒ 2）—— serializeTree 据此写回，
    // 不许写死（见 metaFormatVersion 的说明）。这里是打开项目与 undo/redo 的共同入口 ✓。
    metaFormatVersion = (data && data.meta && Number.isInteger(data.meta.formatVersion))
      ? data.meta.formatVersion : 2;
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
    MM.adapter.loadTree(jm, data);
    // 【折叠默认】打开项目 ⇒ **只展开根**（视图归一，不写数据）。改这里之前先读 collapseBelowRoot 的注释：
    // 它只收顶层主题、不碰深层的展开态 —— 那一条是"手动展开不许被打开动作抹掉"的判据所在。
    // 撤销/重做走 `rebuildFromJson`（`collapseToRoot:false`）⇒ 不会在这里被收一遍（见 renderMind 的 opts 说明）。
    if (collapseToRoot) collapseBelowRoot(jm);
    // 重排锚点保持：包住 view.relayout()，让"刚被展开/收起的那个节点"在屏幕上原地不动
    //（jsMind 会把每个父节点的子节点栈重新居中 ⇒ 不动手就是"页面跳来跳去"；见 app-view.js）。
    if (MM.wrapLayoutAnchor) MM.wrapLayoutAnchor(jm);
    // 展开状态**以数据为准**（节点的 `expanded` 字段）—— 即：数据说收起就收起、说展开就展开，
    // 渲染层**不做任何兜底展开**。原先这里是无条件 `expand_to_depth(3)`：后果一是"在界面收起的节点，
    // 下次打开又被强制展开"（用户的折叠白做了）；后果二是导入的大树一打开就是一片全展开、要滚很久
    // 才找到东西。这一条至今不变；**变的是"打开那一刻的初始视野"**：上面那次
    // `collapseBelowRoot(jm)` 把视图归一成"只展开根"（用户反馈：新开的树/新编辑的子树应当默认折叠），
    // 但它只改顶层的显示 + 顶层主题的 `expanded`，**深层的展开态与盘上数据都不动** ✓。
    applyTopicMarkup(jm);
    state.jm = jm;
    applyRootMode(jm, data);
    // 树偏移：**数据 → 视图**。顺序有讲究：必须在 `state.jm` 就位、节点 DOM 建好之后
    // （setTreeOffsets 要按当前树筛掉不存在的主题/节点），且在 centerOnRoot 之前 ——
    // 偏移只动子树、不动根节点，先落偏移再定视口少闪一下 ✓。
    // 两个键一起交给**同一个**恢复入口（一次清空 + 一次应用；第二参缺省 ⇒ 与从前逐项相同）。
    if (MM.setTreeOffsets) {
      MM.setTreeOffsets((data.meta && data.meta.themeOffsets) || null,
        (data.meta && data.meta.nodeOffsets) || null);
    }
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
    /* 载入之后重算"本项目带图附加层"那句（`graph` 只在这一刻刚被捕获）。
     * 剖面本身**不在这里改**：它是会话级的选择，切项目不重置（否则"两剖面交替打开同一个项目"
     * 这条判据根本没法验 —— 每次打开都被重置回缺省档）。 */
    refreshProfileNote();
  }

  function rebuildFromJson(json) {
    // 撤销/重做：装回的是**用户刚才看过的那一版**（内存快照）⇒ 不做"只展开根"的视图归一
    //（理由与判脏口径的影响见 renderMind 的 opts 说明）。
    renderMind(json, { collapseToRoot: false });
  }

  /** 在**工程 JSON**（`serializeTree` 产的那个形状 / 盘上读回来的那一份）里按 id 找节点。
   *  谁需要它：AI 落盘后把"盘上刚长出来的子节点"接进内存（app-ask.js 的 syncMemoryAfterWriteBack）
   *  —— 节点数据整份取自磁盘（id / 标题取回答首行 / 详情放全文这三条规则都在 CLI 那边，
   *  渲染层**不许**自己重算一遍 ✗）。
   *  ⚠️ 这是**唯一实现**：editor.js 里那份同型的小 findNode 是历史包袱，别再添第三份 ✗。
   *  容忍两种入参：整份工程 JSON（带 `data`）或已经是一棵节点子树。 */
  function findJsonNode(json, id) {
    if (!json || !id) return null;
    let hit = null;
    (function walk(n) {
      if (!n || hit) return;
      if (n.id === id) { hit = n; return; }
      (n.children || []).forEach(walk);
    })(json.data || json);
    return hit;
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
      // ⚠️ 第 4 个原生面板（停靠面板）起，width 的语义 = **页面要让出的总量**
      //    （控制栏 + 侧栏 + 面板），不再恒等于"侧栏可见时的占宽"：面板开着而侧栏收起时，
      //    这个数**只含面板**。所以下面两件事要分开判：
      //      · 让位 CSS 的开关（body.dsh-sidebar-on）按 width > 0
      //      · 重开侧栏的圆钮（🤖）仍按 visible
      //    混用会让"侧栏收起、面板开着"这一档要么露出灰缝、要么把 🤖 入口藏掉。
      const width = (info && info.width) || 0;
      // 侧栏**那条带**（控制栏 + 内容）的宽 —— 拖宽热区必须用它（用总量会偏一整个面板宽）
      const sidebarWidth = (visible && info && info.sidebarWidth) || 0;
      const key = visible + ':' + width + ':' + sidebarWidth;
      // 诊断留痕：最后一次**收到**的布局信息（给断言/排查用：能区分"事件没送到"与"送到的是旧值"）
      window.__dshLayoutLast = { visible: visible, width: width, sidebarWidth: sidebarWidth, key: key, at: Date.now() };
      // ── 下面三件都是**纯 DOM 同步，每次必做**（幂等、代价极低）──
      // 教训：上一版把它们放进"状态没变就 return"的守卫里 ⇒ 一旦某条路径没触发状态变化，
      // 就让位变量/FAB 落空，用户看到"灰色背景"和"重开圆钮不见了"。守卫只该守住**扰动视图**的那件事。
      document.body.classList.toggle('dsh-sidebar-on', width > 0);
      // `--dsh-sidebar-width` 必须显式写：不写就回落到 style.css 的兜底值 420px，
      // 而侧栏实际可能只有 308 ⇒ 页面多留 112px ⇒ 就是用户看到的"侧栏隔壁灰色背景"。
      document.body.style.setProperty('--dsh-sidebar-width', width + 'px');
      window.__dshSidebarW = width;
      // 侧栏那条带自己的宽 + 侧栏是否在屏上（拖宽热区那两个前提，见下面的 sidebarLeftEdge）
      window.__dshSidebarBandW = sidebarWidth;
      window.__dshSidebarVisible = visible;
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
      // actualWidth = **页面让位总量**（含停靠面板）；sidebarWidth = 侧栏那条带自己的宽
      const fromStatus = (s) => { if (s) applyLayout({ visible: s.visible, width: s.actualWidth || s.width, sidebarWidth: s.sidebarWidth }); };
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
      // 侧栏左缘 = 窗口宽 − **侧栏带**宽（不是让位总量：面板开着时总量还含面板 ⇒ 热区偏一个面板宽）
      const sidebarLeftEdge = () => (window.__dshSidebarVisible
        ? window.innerWidth - (window.__dshSidebarBandW || 0) : -9999);
      window.addEventListener('mousemove', (e) => {
        if (dragging) return;
        const onEdge = Math.abs(e.clientX - sidebarLeftEdge()) <= 8;
        document.body.style.cursor = onEdge ? 'col-resize' : '';
      });
      window.addEventListener('mousedown', (e) => {
        if (window.__dshSidebarVisible && (window.__dshSidebarBandW || 0) > 0
            && Math.abs(e.clientX - sidebarLeftEdge()) <= 8) {
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
  /* ================= 状态栏 + 持久错误条（本文件定义，其他模块经 MM 转发调用） =================
   *
   * 【2026-10-27 UI 优化】改版前这一档只有两行：写 textContent + 改 color。两个后果都实测过：
   *   ① **报错只活到"下一次状态写入"**（实测 35ms 就被 `已加载：…` 之类覆盖）——
   *      `app-screens.md` §11 要求错误留在屏幕上、说清什么失败了；
   *   ② `#status-text` 固定 280px + ellipsis ⇒ 长报文只剩前 ~23 个汉字。
   *
   * 修法（**并列第二个载体**，不是替换 —— 状态栏的语义与既有判据一个字都不动）：
   *   · 状态栏照旧只报"最近一次动作"（域 40 直接读 `style.color` 判失败态，见下面那条注释）；
   *   · 新加 `#err-toast`（`index.html` 里有一段长注释说明它为什么不在工具栏、为什么让位给侧栏）：
   *     报错写进去后**一直留着**，直到用户点 ✕ 或下一条报错替换它。不做"几秒后自动消失"——
   *     那只是把"被灰字盖掉"换成"被计时器删掉"，同样是静默。
   *   · 非报错状态把 color 交还给 CSS（`var(--ink-3)` = 4.62:1），不再写死 `#86909c`（3.24:1）。
   */
  function setStatus(text, isErr) {
    const el = $('#status-text');
    if (!el) return;
    const msg = (text === undefined || text === null) ? '' : String(text);
    el.textContent = msg;
    if (isErr) {
      /* ⚠️ 这个字面量**不许**换成 token / var()：域 40 按 `style.color` 判失败态
       * （`scripts/smoke/40-heat-bars.js` 用 /245,\s*63,\s*63|f53f3f/i 匹配读回来的值），
       * 换成 var(--danger-ink) 会读出 rgb(196,36,42) ⇒ 该域假红。理由与取舍见
       * `.review/20261062-UI优化/诊断.md` §4「与三条硬约束的对照」。
       * 对比度补救在**持久载体**上：`#err-toast` 用的是 5.78:1 的 `--danger-ink`。 */
      el.style.color = '#f53f3f';
      el.title = msg;                 // 状态栏会省略，原文挂 title（悬停可看全）
      showErrToast(msg);
    } else {
      el.style.color = '';            // 交还 CSS：var(--ink-3)，4.62:1
      el.title = '最近操作状态';
    }
  }

  /** 把报错写进持久错误条（`#err-toast`）。缺元素时静默返回 —— 状态栏那一手已经报了，不许抛。 */
  function showErrToast(msg) {
    const box = $('#err-toast');
    const txt = $('#err-toast-text');
    if (!box || !txt) return;
    txt.textContent = msg;
    box.hidden = false;
  }

  /** 收起持久错误条（用户点 ✕）。报错原文仍留在状态栏 —— 收起的只是这条浮层。 */
  function hideErrToast() {
    const box = $('#err-toast');
    if (box) box.hidden = true;
  }

  /* 持久错误条的 ✕（`#err-toast` 排在脚本之前 ⇒ 加载期就能取到，不需要等 DOMContentLoaded）。
   * 取不到就什么都不做：草稿窗有自己的一份（`draft-map.js`），主窗缺元素也不许抛。 */
  (function bindErrToastClose() {
    const btn = $('#err-toast-close');
    if (btn) btn.addEventListener('click', () => hideErrToast());
  })();

  /* ================= 剖面（profile）轴：**控件面由剖面生成**（MS4 · docs/DIAGRAM-MODES.md §4.3） =================
   *
   * 这条轴要回答的唯一问题：**这个剖面在界面上有哪些控件**。
   * 判据（§4.3 第 3 条，五个剖面各跑一次）：切成某剖面后
   *   `document.querySelectorAll('[data-cap]')` 的属性集合 **===** 该剖面展开的集合（双向：多一个少一个都红）。
   *
   * ⚠️ 三条"不许"（每一条都对应一次本工程踩过的坑）：
   *   ① **不许在渲染层按剖面名写分支**（形如"剖面变量 === 某个剖面名"的三元/switch）——
   *      那是把同一份矩阵抄第二遍，抄完必然漂。本文件里**一次剖面名都不出现**（判据见冒烟域 58 的
   *      静态扫描：五个剖面名在**剖面轴的两处代码**（本文件 + `app.js`）与 `index.html` 里
   *      作为字符串字面量的出现次数必须 **=== 0**；剖面名只从 `PROFILES` 里来）。
   *   ② **不许给每个控件写死"它在哪个剖面出现"**。清单只声明 `{id, cap}`（我是哪条能力），
   *      出不出**由 `controlsFor(profile, 清单)` 算**（唯一过滤点 ⇒ 想手写一份"恰好相等"的名单，
   *      就只能再加一个过滤点，而那会被"唯一过滤点"那条结构判据抓住）。
   *   ③ **不许把剖面写进数据**。它是**会话级**的视图选择（与 `app-view.js` 里那条"结构轴"的会话级
   *      读数同一条口径）：切剖面**零序列化写入**（盘上 sha256 不变、`isDirty()` 不变）——
   *      否则"窄剖面保存一次"就会顺手把 `meta` 改出一个新键，而那正是 §6.2 禁令要防的那类静默漂移。
   *      ⚠️ 这条注释刻意**不写那条结构轴的变量名**：域 51 的结构判据会数它在哪些文件里出现，
   *      而本工程的注释剥除器对**这个文件**会失步（见 `.review/20261064-MS4剖面开关/probe-strip.js`）
   *      ⇒ 注释里写它等于在代码里写它（实测：写了那条判据就红）。
   *
   * 两档记号怎么落到界面上（与数学矩阵的三档记号一一对应，见 `src/diagram/profiles.js`）：
   *   · ✓ = 支持且默认开 ⇒ 控件**在**、可交互（`data-cap` + `data-cap-on="1"`）；
   *   · ○ = 支持但默认关 ⇒ 控件**在**、**按不动**（`data-cap` + `data-cap-on="0"` + `disabled`，
   *     §3.5 给了"什么条件下才开"；条件由将来的产品路径触发，不由这里拍脑袋打开）；
   *   · ✗ = 本剖面不出现 ⇒ 控件**摘掉 `data-cap` 并藏起来**（`data-cap-off`）。
   *     ⚠️ 摘掉属性而不是只藏起来：判据读的是 `[data-cap]` 的**集合**，
   *     藏起来但属性还在 ⇒ 那一集合就不再等于剖面展开集合（判据当场变红，且红得对 ——
   *     因为"声明了却不在面上"与"在面上"在读数上分不开）。
   */

  /** 受剖面管的控件清单 —— **本工程唯一的控件面声明**（`docs/DIAGRAM-MODES.md` §4.3 第 1 条：
   *  每个控件必须说清自己是哪条能力；没有归属的控件 = 不受剖面管 = 一定会漏）。
   *
   *  两个字段就够：`id`（稳定标识，判据按它点名）+ `cap`（能力编号，**必须**在能力目录里，
   *  否则 `controlsFor` 会响亮抛 `E_PROFILE_CAP`）。
   *  两种挂载方式（区别只在"元素本来就有"还是"由本文件生成"）：
   *   · `target: '#…'` —— 界面上**既有**的控件（工具栏按钮/搜索框）：只给它挂/摘 `data-cap` 与禁用态，
   *     元素本身不动（它的点击行为早就接线在 `app.js`，这里**不重复接一遍**）；
   *   · `mount: true` + `label/run` —— 剖面控件面**自己生成**的控件（挂在 `#cap-bar`）：
   *     不显示时**从 DOM 移除**（不是藏起来）—— 生成物就该随剖面来去。
   *  ⚠️ 清单里**不许**出现"哪个剖面"这三个字以上的信息：出不出由 `controlsFor` 算。
   */
  const CAP_CONTROLS = Object.freeze([
    /* 折叠/展开（`C-F7-05`）：缺省 ✓ 于 complex / mindmap / path，✗ 于 logic / module
     *（那两处"隐藏节点会让路径/依赖断成一截且看不出来"，理由在文档 §3.3.4 / §3.3.5） */
    { id: 'fold-expand', cap: 'C-F7-05', target: '#btn-expand' },
    { id: 'fold-collapse', cap: 'C-F7-05', target: '#btn-collapse' },
    /* 搜索定位（`C-F7-04`）：mindmap 是 ○（"只有用户抱怨面板找不到树里的位置时才补画布内定位"）
     * ⇒ 那一档里搜索框**看得见但按不动**，不是消失。 */
    { id: 'search-locate', cap: 'C-F7-04', target: '#search-box' },
    /* 缩放与平移（`C-F7-01`）：五个剖面全 ✓（唯一的"哪一档都在"的那条）⇒ 这条是控件面判据的
     * **恒在项**：任何剖面里它都该在（少了它就说明过滤逻辑整个坏了，而不是某个剖面特别）。 */
    { id: 'view-reset', cap: 'C-F7-01', target: '#btn-reset-view' },
    /* 手工拖动写回 + 微调（`C-F4-05`）：✓ complex / module，○ logic，✗ mindmap / path
     *（那一档"位置是布局的输出，不是人的输入"⇒ 连"清掉手工位置"这件事都不该存在）。 */
    { id: 'offsets-clear', cap: 'C-F4-05', mount: true, label: '回到自动布局',
      title: '把所有手工拖动过的位置清掉，全部回到自动布局（保存后生效）',
      run: function () {
        const themes = (MM.getTreeOffsets && MM.getTreeOffsets()) || {};
        const nodes = (MM.getNodeOffsets && MM.getNodeOffsets()) || {};
        const n = Object.keys(themes).length + Object.keys(nodes).length;
        if (MM.clearTreeOffsets) MM.clearTreeOffsets();          // 不传参 = 全清（唯一实现，app-view.js）
        setStatus(n ? ('已回到自动布局：清掉 ' + n + ' 处手工位置（保存后生效）')
          : '本来就在自动布局上：没有手工位置要清');
      } }
  ]);

  /** 当前剖面（会话级；`null` = 还没应用过 ⇒ 用"全开剖面"当缺省）。**绝不进序列化产物**。 */
  let capProfileName = null;
  /** 载入时那份 `graph`（**只读**：只为了在界面上说清"本项目带图附加层、本剖面不显示"）。
   *  ⚠️ 它**不写回**：`serializeTree` 的字段白名单里没有 `graph`（§6.2 禁令），
   *  盘上那份由主进程 `prepareSavePayload`（载荷没带才取回）保住 —— 这正是 §6.5 判据①验的那条。 */
  let capGraph = null;

  /** 能力矩阵模块（`src/diagram/profiles.js`，UMD ⇒ 挂在 window 上） */
  function profilesModule() { return (typeof window !== 'undefined' && window.MMDiagramProfiles) || null; }

  /** **全开剖面** = 拒绝集为空的那一个（D1 的定义本身，不写死名字）。
   *  为什么按性质找而不是按名字找：① 本文件里一个剖面名都不许出现（见上面 ①）；
   *  ② "全开"这件事的判据就是"零 ✗"（`profileIssues()` 的不变量①），按性质找与按名字找同源同义。 */
  function fullProfile() {
    const P = profilesModule();
    if (!P) return null;
    for (let i = 0; i < P.PROFILES.length; i++) {
      if (P.expandProfile(P.PROFILES[i]).rejected.length === 0) return P.PROFILES[i];
    }
    return null;   // 数据本身坏了（没有零 ✗ 的剖面）⇒ 交给 applyCapSurface 响亮报
  }

  /** 当前剖面读数（没应用过 ⇒ 全开剖面） */
  function capProfile() { return capProfileName || fullProfile(); }

  /** 摘掉一个既有控件身上的剖面痕迹（不见的时候走这一支） */
  function hideCapTarget(el) {
    el.removeAttribute('data-cap');
    el.removeAttribute('data-cap-on');
    el.setAttribute('data-cap-off', '1');
    // 只撤销**我们自己**加的禁用（`data-cap-disabled` 是"这一支是我按下去的"的记号）
    if (el.getAttribute('data-cap-disabled') === '1') {
      el.disabled = false;
      el.removeAttribute('data-cap-disabled');
    }
  }

  /** 给一个既有控件挂上剖面痕迹（在面上的时候走这一支） */
  function showCapTarget(el, entry, isOn) {
    el.removeAttribute('data-cap-off');
    el.setAttribute('data-cap', entry.cap);          // ← 判据读的就是这一个属性
    el.setAttribute('data-cap-on', isOn ? '1' : '0');
    if (isOn) {
      if (el.getAttribute('data-cap-disabled') === '1') {
        el.disabled = false;
        el.removeAttribute('data-cap-disabled');
      }
    } else if (!el.disabled) {
      el.disabled = true;
      el.setAttribute('data-cap-disabled', '1');
    }
  }

  /** 生成式控件：挂到 `#cap-bar`（同一个 id 只挂一次；已被摘掉的会重建） */
  function mountCapControl(entry, isOn) {
    const bar = document.getElementById('cap-bar');
    if (!bar) return null;
    let el = bar.querySelector('[data-cap-ctl="' + entry.id + '"]');
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('data-cap-ctl', entry.id);
      el.textContent = entry.label || entry.id;
      el.addEventListener('click', function () { if (entry.run) entry.run(); });
      bar.appendChild(el);
    }
    el.title = entry.title || '';
    showCapTarget(el, entry, isOn);
    return el;
  }

  /** 生成式控件：不显示就**从 DOM 移除**（生成物不留在面上，免得"看得见但没接线"） */
  function unmountCapControl(entry) {
    const bar = document.getElementById('cap-bar');
    if (!bar) return;
    const el = bar.querySelector('[data-cap-ctl="' + entry.id + '"]');
    if (el) el.remove();
  }

  /**
   * **把某个剖面落到界面上**（本批的核心动作；唯一过滤点就在下面那一次 `controlsFor` 调用）。
   * @param {string} profile 剖面标识符（必须 ∈ `PROFILES`；未知剖面**响亮拒绝**，不静默当全开）
   * @returns {{ok:boolean, profile:(string|null), shown:number, optional:number, reason:string}}
   */
  function applyCapSurface(profile) {
    const P = profilesModule();
    if (!P) {
      setStatus('剖面模块没加载（src/diagram/profiles.js 缺了）⇒ 控件面生成不了', true);
      return { ok: false, profile: null, shown: 0, optional: 0, reason: '没有 MMDiagramProfiles 模块' };
    }
    if (P.PROFILES.indexOf(profile) < 0) {
      const why = '未知剖面 ' + JSON.stringify(profile) + '（合法取值：' + P.PROFILES.join(' / ') + '）'
        + ' —— 未知剖面**不静默当成全开剖面**';
      setStatus('切剖面失败：' + why, true);
      return { ok: false, profile: capProfileName, shown: 0, optional: 0, reason: why };
    }
    let res;
    try {
      res = P.controlsFor(profile, CAP_CONTROLS);   // ← 唯一的过滤点（别在别处再算一次）
    } catch (err) {
      /* 剖面数据坏了（能力编号不在目录里 / 控件没声明 cap）⇒ **整块清空**并响亮报。
       * 为什么清空而不是"跳过坏的那一条"：留一半会让界面看起来"剖面生效了"，
       * 而实际上面上少了一个控件、没人知道 —— 那正是"没做却看不出没做"。 */
      CAP_CONTROLS.forEach(function (c) { if (c.mount) unmountCapControl(c); });
      const targets = document.querySelectorAll('[data-cap]');
      Array.prototype.forEach.call(targets, hideCapTarget);
      setStatus('剖面数据有毛病（控件面已清空）：' + ((err && err.message) || err), true);
      return { ok: false, profile: capProfileName, shown: 0, optional: 0, reason: String((err && err.message) || err) };
    }
    capProfileName = profile;
    const shownIds = new Set(res.shown.map(function (c) { return c.id; }));
    let nShown = 0, nOptional = 0;
    CAP_CONTROLS.forEach(function (c) {
      const inSurface = shownIds.has(c.id);
      const isOn = inSurface && P.markOf(profile, c.cap) === P.ENABLED;
      if (inSurface) { nShown++; if (!isOn) nOptional++; }
      if (c.mount) {
        if (inSurface) mountCapControl(c, isOn); else unmountCapControl(c);
        return;
      }
      const el = document.querySelector(c.target);
      if (!el) return;               // 这个窗口没有该控件（草稿窗等）⇒ 不是错误，也不是"漏了"
      if (inSurface) showCapTarget(el, c, isOn); else hideCapTarget(el);
    });
    refreshProfileNote();            // 剖面变了 ⇒ "本项目带图附加层"那句的措辞跟着变
    const sel = document.getElementById('profile-select');
    if (sel && sel.value !== profile) sel.value = profile;
    return { ok: true, profile: profile, shown: nShown, optional: nOptional, reason: '' };
  }

  /** 读数出口（冒烟只拿它读"当前是什么"，判据本身一律读 DOM/盘上字节 —— 不拿这个自证） */
  function capSurfaceRead() {
    const on = [];
    const all = [];
    document.querySelectorAll('[data-cap]').forEach(function (el) {
      const rec = {
        cap: el.getAttribute('data-cap'),
        on: el.getAttribute('data-cap-on') === '1',
        id: el.id || el.getAttribute('data-cap-ctl') || '',
        rendered: el.getClientRects().length > 0
      };
      all.push(rec);
      if (rec.on) on.push(rec.cap);
    });
    const noteEl = document.getElementById('profile-note-text');
    return {
      profile: capProfile(),
      controls: all,
      enabledCaps: on,
      note: noteEl ? noteEl.textContent : '',
      graph: capGraph ? {
        layers: countOf(capGraph.layers), containers: countOf(capGraph.containers),
        edges: countOf(capGraph.edges), annotations: countOf(capGraph.annotations)
      } : null
    };
  }

  function countOf(v) { return Array.isArray(v) ? v.length : 0; }

  /** 「本项目带图附加层 …，本剖面不显示」那一条（`docs/DIAGRAM-MODES.md` §6.5 判据①的可判形式之一：
   *  **看得见地说明** + 一个"切到全开剖面"的入口）。
   *
   *  三档措辞，逐档都有出处，别在这里自由发挥：
   *   · 没有 `graph`（或它是个空壳）⇒ **一个字都不说**（默认档零噪声：老项目界面与从前逐字节相同）；
   *   · 有 `graph` 且当前不是全开剖面 ⇒ 报四类计数 + "**本剖面不显示**" + "数据原样保留，保存不会抹掉"
   *     （后半句是判据①验的那件事：窄剖面保存一次 `graph` 逐字节不变）；
   *   · 有 `graph` 且当前是全开剖面 ⇒ 同样报计数，但如实说"图形渲染尚未接界面"。
   *     ⚠️ 这一档**不许**写成"本剖面会画它"—— 今天的渲染器只画树（MS1/MS2 的产物在 `src/diagram/`，
   *     接界面是 MS3 的活）；把没做的事说成做了，比不说更坏。
   */
  function refreshProfileNote() {
    const textEl = document.getElementById('profile-note-text');
    const btn = document.getElementById('profile-switch-full');
    if (!textEl) return;
    const g = capGraph;
    const nLayers = g ? countOf(g.layers) : 0;
    const nContainers = g ? countOf(g.containers) : 0;
    const nEdges = g ? countOf(g.edges) : 0;
    const nAnn = g ? countOf(g.annotations) : 0;
    const total = nLayers + nContainers + nEdges + nAnn;
    if (!total) {                                  // 没有图附加层 ⇒ 这一格是空的（零噪声）
      textEl.textContent = '';
      textEl.removeAttribute('title');
      if (btn) btn.style.display = 'none';
      return;
    }
    const full = fullProfile();
    const isFull = capProfile() === full;
    const counts = nLayers + ' 条层带 · ' + nContainers + ' 个容器 · ' + nEdges + ' 条边'
      + (nAnn ? ' · ' + nAnn + ' 条注释' : '');
    const tail = isFull
      ? '全开剖面：图形渲染尚未接界面（数据原样保留，保存不会抹掉）'
      : '本剖面不显示它们（数据原样保留，保存不会抹掉）';
    textEl.textContent = '本项目带图附加层：' + counts + ' —— ' + tail;
    textEl.title = textEl.textContent;
    if (btn) {
      btn.style.display = isFull ? 'none' : '';
      btn.hidden = isFull;
    }
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
  MM.findJsonNode = findJsonNode;   // 工程 JSON 里按 id 找节点（**唯一实现**，见函数说明）
  MM.renderMind = renderMind;
  MM.rebuildFromJson = rebuildFromJson;
  MM.escHtml = escHtml;
  // Markdown 渲染的**唯一两个口**（行内 / 整段）—— 见文件里 mdInline/mdBlock 的说明 ✓
  MM.mdInline = mdInline;
  MM.mdBlock = mdBlock;
  MM.topicMarkup = topicMarkup;          // 单源：行内 Markdown → HTML（供详情框标题等复用）
  MM.applyTopicMarkup = applyTopicMarkup;
  MM.nodeImages = nodeImages;
  MM.nodeFiles = nodeFiles;
  MM.setStatus = setStatus;
  MM.hideErrToast = hideErrToast;   // 收持久错误条（冒烟域也用它复位，别让上一条报错串到下一档）
  /* —— 剖面（profile）轴：控件面由 `src/diagram/profiles.js` 生成 ——
   * `CAP_CONTROLS` 也导出（只读引用）：**判据要用它对齐"清单里有哪几个 id"**，
   * 但"出不出"一律由 `applyCapSurface` 里那一次 `controlsFor` 算，不许调用方再算一次。 */
  MM.CAP_CONTROLS = CAP_CONTROLS;
  MM.capProfile = capProfile;
  MM.applyCapSurface = applyCapSurface;
  MM.refreshProfileNote = refreshProfileNote;
  MM.capSurfaceRead = capSurfaceRead;
  /** 切剖面（唯一入口）：校验 + 落界面 + 人话回执。未知剖面**响亮拒绝**（不静默当全开）。 */
  MM.setCapProfile = function (profile) { return applyCapSurface(profile); };
  MM.bindDshSidebar = bindDshSidebar;
})();
