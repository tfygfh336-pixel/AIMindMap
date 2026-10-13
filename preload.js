/* ============================================================
 * AI MindMap — 预加载脚本（contextBridge）
 * ------------------------------------------------------------
 * 向渲染层暴露安全的 window.desktop API（IPC 封装）：
 *   desktop.projects()                 → 项目列表
 *   desktop.project.read(name)         → { file, data }
 *   desktop.project.save(file, data)   → 写盘（CLI validate 闸门）
 *   desktop.project.peek(name)         → 只读探视：{ file, data, version, base, baseVersion }
 *                                        （不推进"界面读到哪一版"的记录 —— 见下方 project.peek 的注释）
 *   desktop.asset.import(...)          → 导入图片到 assets/
 *   desktop.asset.importFile(...)      → 导入附件到 attachments/（v0.16）
 *   desktop.app.readFile(abs)          → 读附件文本（md 预览）
 *   desktop.app.openFile(abs)          → 系统默认应用打开附件
 *   desktop.app.exportMd(...)          → 导出 Markdown（v0.16 起为文件夹导出）
 *   desktop.app.related(...)           → 某节点的相关知识点（出边+入边）
 *   desktop.app.heat(name, nodeId)     → 热度读数（来自 `heat --json`：两条榜 + 窗口内样本量）——
 *                                        界面两条热度条**只**显示它给的数，自己不计算（第三件·A）
 *   desktop.app.visit(name, nodeId, ch) → 记一次人类访问（打开详情框）⇒ 访问日志追加一行；
 *                                        **不碰项目数据、不触发保存**（改热度条不写盘）
 *   desktop.app.audit(name)            → 关系审计（orphans + mentions 两清单）
 *   desktop.app.linkNodes(...)         → 补一条链接（写操作，走 CLI 闸门）
 *   desktop.app.unlinkNodes(...)       → 摘掉一条链接（写操作，走 CLI 闸门；入边可指定**来源所在项目**）
 *   desktop.app.nodes(name)            → 扁平节点清单（命令面板与关联视图的"输入即搜"共用）
 *   desktop.app.assoc(name, nodeId?)   → 关联笔记（N 元关联实体）；给 nodeId 则只列该节点所属的
 *   desktop.app.assocAdd(...)          → 新建一篇关联笔记（写操作，走 CLI 闸门；回读原始实体 + 新条目）
 *   desktop.app.assocEdit(...)         → 保存关联笔记（写操作，走 CLI 闸门；回读最新形态）
 *   desktop.app.assocPrune(name, ids)  → 删节点前在**磁盘上**剪掉这些节点在关联/链接里的引用
 *                                        （写操作只经 CLI —— 见 main.js 里的说明）
 *   desktop.app.writeClipboard(text)   → 写**系统剪贴板**（**主进程实现，与窗口焦点无关**）：
 *                                        写后回读，返回 `{ ok, value, readback, matched }`。
 *                                        "复制 节点id#条目id"走的就是它（渲染层的浏览器通道
 *                                        在无焦点的隐藏窗口里被拒/自报成功却什么都没写 ✗）
 *   desktop.app.version()              → 版本号
 *   desktop.app.ask(name, nodeId, opts) → 向内嵌 AI 问一个节点（功能 1 后端；opts={kind:'explain'|'ask',
 *                                        question}）。**异步**、实测 20+ 秒；冒烟/`MM_ASK_STUB=1` 时返回
 *                                        `stub:true` 的桩（绝不冒充真答案）。走 `cli ask` ⇒
 *                                        "AI 收到什么"只有一处定义
 *   desktop.app.askApply(name, nodeId, payload) → 把 AI 的回答**落进节点与详情**（A：问答记录 `qa`
 *                                        + detail 追加 + 可建子节点）。**写操作只经 CLI**（`ask-apply`：
 *                                        闸门 + 原子写 + 写后回读），返回回读到的 `qa/detail` 真值
 *   desktop.on(channel, cb)            → 订阅菜单事件
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  projects: () => ipcRenderer.invoke('project:list'),
  project: {
    read: (name) => ipcRenderer.invoke('project:read', name),
    save: (file, data, opts) => ipcRenderer.invoke('project:save', file, data, opts),
    watch: (absDir) => ipcRenderer.invoke('project:watch', absDir),
    /* 只读探视（v0.20）：在**有未保存编辑**时看看盘上现在是什么样（给「外部改动预览」取数据）。
     * ⚠️ 与 read 的区别就是它**没有副作用**：read 会把主进程的"界面读到哪一版"推进到盘上这一版
     * （保存闸门比的就是那个记录）—— 拿 read 去探视会让界面随后保存时**静默覆盖**外部改动 ✗。
     * 返回 `{ok, file, data, version, base, baseVersion}`：base/baseVersion 来自主进程那份记录，
     * 与保存闸门、与三方合并**同一份基线**。它只读文件，不写盘、不改任何记录。 */
    peek: (name) => ipcRenderer.invoke('project:peek', name)
  },
  asset: {
    import: (projectName, nodeId, srcPath, caption, source, tags) =>
      ipcRenderer.invoke('asset:import', projectName, nodeId, srcPath, caption, source, tags),
    importFile: (projectName, nodeId, srcPath, caption, source) =>
      ipcRenderer.invoke('asset:import-file', projectName, nodeId, srcPath, caption, source)
  },
  app: {
    exportMd: (projectName, outFile) => ipcRenderer.invoke('app:export-md', projectName, outFile),
    exportMdDialog: (projectName) => ipcRenderer.invoke('app:export-md-dialog', projectName),
    importMd: (projectName, srcFile, parent) => ipcRenderer.invoke('app:import-md', projectName, srcFile, parent),
    readFile: (absPath) => ipcRenderer.invoke('app:read-file', absPath),
    openFile: (absPath) => ipcRenderer.invoke('app:open-file', absPath),
    search: (projectName, keyword) => ipcRenderer.invoke('app:search', projectName, keyword),
    backlinks: (projectName, nodeId) => ipcRenderer.invoke('app:backlinks', projectName, nodeId),
    related: (projectName, nodeId) => ipcRenderer.invoke('app:related', projectName, nodeId),
    /* 热度条（第三件·A）。两条通道都**只展示 / 只记录**，与"正文只有一份"无关：
     *   heat(...)  → 读 `heat --json`（同一处口径；界面**绝不自己算**分位与名次）
     *   visit(...) → 记一次**人类访问**（裁决一：人只算"打开详情框"）⇒ 往**访问日志**追加一行。
     *                ⚠️ 它**不写项目数据**、不触发保存、不产生脏标记（用户只是看热度，不该留下任何写）。
     *                失败如实回报 `{ok:false, errors}`（渲染层显示可见提示，不静默）。 */
    heat: (projectName, nodeId) => ipcRenderer.invoke('app:heat', projectName, nodeId),
    visit: (projectName, nodeId, channel) => ipcRenderer.invoke('app:visit', projectName, nodeId, channel),
    audit: (projectName) => ipcRenderer.invoke('app:audit', projectName),
    linkNodes: (projectName, fromId, toProject, toId, caption) =>
      ipcRenderer.invoke('app:link-nodes', projectName, fromId, toProject, toId, caption),
    unlinkNodes: (projectName, fromId, toProject, toId) =>
      ipcRenderer.invoke('app:unlink-nodes', projectName, fromId, toProject, toId),
    nodes: (projectName) => ipcRenderer.invoke('app:nodes', projectName),
    ask: (projectName, nodeId, opts) => ipcRenderer.invoke('app:ask', projectName, nodeId, opts),
    /* 功能 1 的下半截（A）：把 AI 的回答**落进节点与详情**（写操作走 CLI `ask-apply` 闸门）。
     * payload = { answer, question?, model?, at?, asChild? }；返回 { ok, qa, detail, child, error? } ——
     * `qa/detail` 是**写后回读**的真值（渲染层据此同步内存，不靠猜）。 */
    askApply: (projectName, nodeId, payload) => ipcRenderer.invoke('app:ask-apply', projectName, nodeId, payload),
    // 功能 5a：把一个大文件导入成**新项目**（拖拽入口；菜单入口在主进程里直接调同一个实现）
    importDoc: (filePath) => ipcRenderer.invoke('app:import-doc', filePath),
    // Electron ≥32 起 `File.path` 已被移除 ⇒ 取拖拽文件的真实路径**只有** webUtils 这一条路
    //（这也是"必须从 preload 暴露"的原因：渲染层拿不到 webUtils ✓）
    pathForFile: (file) => {
      try { return require('electron').webUtils.getPathForFile(file); }
      catch (e) { return ''; }
    },
    assoc: (projectName, nodeId) => ipcRenderer.invoke('app:assoc', projectName, nodeId),
    // members: 本项目节点 id 数组（≥2 由 CLI 判定）；title / noteMd 可为空串（表示不写）
    assocAdd: (projectName, members, title, noteMd) =>
      ipcRenderer.invoke('app:assoc-add', projectName, members, title, noteMd),
    assocEdit: (projectName, assocId, title, noteMd) =>
      ipcRenderer.invoke('app:assoc-edit', projectName, assocId, title, noteMd),
    assocPrune: (projectName, ids) => ipcRenderer.invoke('app:pre-delete-cleanup', projectName, ids),
    /* 写**系统剪贴板**（主进程实现，**与窗口焦点无关**）：渲染层的 navigator.clipboard / execCommand
     * 在无焦点的隐藏窗口里"要么被拒、要么自报成功却没写进去"（实测）⇒ 复制走这一条。
     * 主进程写后会**回读**，返回 `{ ok, value, readback, matched }` —— `matched:false` = 回读到的
     * 不是这段文本（不算成功，别自报 ✓）；失败一律带 `error`，不静默 ✗。 */
    writeClipboard: (text) => ipcRenderer.invoke('app:clipboard-write', text),
    /* 【R4 界面侧】绑定工作区文件夹（**界面只做入口/状态/播报**；判定与写盘全在 CLI `bind-sync`）：
     *   bindPickDir()                 → 原生选目录对话框（`dialog.showOpenDialog({properties:['openDirectory']})`；
     *                                   `--smoke` 下改读脚本化答案，返回里带 `stub:true` 如实说明这一跳是桩）
     *   bindPreview(项目, 目录, 形态) → 绑定前预览：在**演练副本**上跑既有 `--dry-run`（用户项目零写入）
     *   bindApply(项目, 目录, 形态)   → 确认绑定（写绑定记录 + 立刻同步一次）
     *   bindCmd(项目, 动作)           → 暂停/继续/立即同步/解绑（动作 ∈ pause|resume|sync|unbind）
     * 四个入口**都不做同步判定**：各自打到 `bind-sync` 的一个既有开关上（见 main.js 的注释）。 */
    bindPickDir: () => ipcRenderer.invoke('app:bind-pick-dir'),
    bindPreview: (projectName, dir, opts) => ipcRenderer.invoke('app:bind-preview', projectName, dir, opts),
    bindApply: (projectName, dir, opts) => ipcRenderer.invoke('app:bind-apply', projectName, dir, opts),
    bindCmd: (projectName, action) => ipcRenderer.invoke('app:bind-cmd', projectName, action),
    /* 只读状态探针：引擎里唯一"只报告、不写盘"的读法是 `--dry-run`（CLI 的中央短路）——
     * 状态区的"上次同步 / 待确认删 K / 未转换 K"由它给，界面一个数都不自己算 ✓。 */
    bindProbe: (projectName) => ipcRenderer.invoke('app:bind-probe', projectName),
    /* 【W13】界面侧导入入口（**入口 + 预览 + 播报**三件事；判定与写盘全在 CLI 的两条既有命令上）：
     *   importPick(kind, opts)      → 原生对话框：kind='files' 多选 Markdown / kind='dir' 选一个文件夹。
     *                                 `opts.where` = 落点那句人话（写进对话框标题 ⇒ 选的时候就知道导到哪）。
     *                                 `--smoke` 下改读脚本化答案（返回里带 `stub:true`，如实说明这一跳是桩）。
     *   importPreview(项目, 计划)    → 导入前预览：在**演练副本**上跑既有 `--dry-run`（用户项目零写入）。
     *                                 计划 = {kind:'files', files:[…], parent} | {kind:'dir', dir, name, title}
     *   importApply(项目, 计划)      → 真导入：文件走 `import-md`（逐文件 ⇒ 一个坏文件拖不垮整批）、
     *                                 目录走 `import-dir`（**新建一个项目**并按既有路径打开它）。
     *                                 回执带"这次加了哪些节点"的键与人话名（播报面板点一行能跳过去）。
     * 三个入口都**不做导入判定**（判定在 CLI；读数形状的归一在 scripts/import-reading.js），界面只显示。 */
    importPick: (kind, opts) => ipcRenderer.invoke('app:import-pick', kind, opts),
    importPreview: (projectName, plan) => ipcRenderer.invoke('app:import-preview', projectName, plan),
    importApply: (projectName, plan) => ipcRenderer.invoke('app:import-apply', projectName, plan),
    version: () => ipcRenderer.invoke('app:version'),
    /* 界面状态上报（脏标记变化时推）：主进程写 projects/<项目>/.ui-state.json，
     * 侧栏 AI 用 `node cli/mm-cli.js ui-state --json` 读 —— 写前协调的可执行通道。 */
    uiState: (payload) => ipcRenderer.send('app:ui-state', payload)
  },
  on: (channel, cb) => {
    const wrap = (e, ...args) => cb(...args);
    ipcRenderer.on(channel, wrap);
    return () => ipcRenderer.removeListener(channel, wrap);
  },
  /* 项目文件被外部（侧栏 AI）修改的实时通知 */
  onProjectDiskChange: (cb) => {
    const wrap = (_e, filename) => cb(filename);
    ipcRenderer.on('project:disk-changed', wrap);
    return () => ipcRenderer.removeListener('project:disk-changed', wrap);
  },
  /* 【R4】工作区文件夹**自动同步**的报告（`why` = fs.watch / sweep）—— 变更播报与状态区吃它。
   * 与 onProjectDiskChange 的分工：那条管"盘上变了 ⇒ 界面该重读"（既有判定，一个字没改）；
   * 这一条只是**多带一份 CLI 的读数**（本次 +N 改 M / 待确认删 K / 未转换 K），
   * 界面据此显示，并允许"点开看这次自动加进来的是哪些节点"。 */
  onBindSynced: (cb) => {
    const wrap = (_e, payload) => cb(payload);
    ipcRenderer.on('app:bind-synced', wrap);
    return () => ipcRenderer.removeListener('app:bind-synced', wrap);
  },
  /* DSH 侧边栏：状态查询、布局事件、toggle 与拖宽（token/URL 永不进渲染层） */
  dsh: {
    status: () => ipcRenderer.invoke('dsh-sidebar:status'),
    // ⑩ 把一段对话预填进侧栏输入框（返回 {ok, reason} ✓ 失败不静默 ✗）
    prefill: (text) => ipcRenderer.invoke('dsh-sidebar:prefill', text),
    toggle: () => ipcRenderer.send('dsh-sidebar:toggle'),
    /* P7 真·跨视图拖放：选区拖拽的**起点/终点**上报 ✓（坐标跟踪与落点判定在主进程 ——
     * 侧栏是原生 WebContentsView，指针进它的矩形后渲染层收不到 mouseup ✗）。
     * ⚠️ 与上面的 beginDrag/endDrag **不是一套**：那两个是"拖宽侧栏"用的 ✓ 别混用 ✗。 */
    selDragStart: (ids) => ipcRenderer.send('dsh-sidebar:sel-drag-start', ids),
    selDragEnd: (pt) => ipcRenderer.invoke('dsh-sidebar:sel-drag-end', pt),
    /* 跨视图兜底：主进程判出"光标停在侧栏上很久 ⇒ 就是在这儿松手"，把 ids 发回来 ⇒ 渲染层负责投喂 ✓ */
    onSelDrop: (cb) => {
      const wrap = (_e, ids) => cb(ids);
      ipcRenderer.on('dsh-sidebar:sel-drop', wrap);
      return () => ipcRenderer.removeListener('dsh-sidebar:sel-drop', wrap);
    },
    beginDrag: () => ipcRenderer.send('dsh-sidebar:drag-start'),
    endDrag: () => ipcRenderer.send('dsh-sidebar:drag-end'),
    isDshOnly: () => ipcRenderer.invoke('dsh-sidebar:dsh-only'),
    /* 导图页**真关**（v0.19 语义）：把这一页从内存里卸掉（主窗口导航到 renderer/map-closed.html）。
     * ⚠️ 这条 IPC 的契约是"**已经问过用户、并且保存完了**"：调用方（渲染层）必须先拦未保存编辑
     * （「保存后关闭 / 取消」，复用既有脏标记 + 保存路径 + 冲突保护），保存成功才调它。
     * 返回结构化结果 { ok, reason } —— 失败不静默 ✗（P19 起：不再有"只隐藏"的那条路） */
    closeMapPage: () => ipcRenderer.invoke('dsh-sidebar:close-map-page'),
    /* 重开：**重新加载**导图页 + 还原停靠宽度 + 回到上次的项目。
     * 三个入口共用它：占位页上的按钮 / 菜单「重新加载思维导图页」/ 侧栏控制栏的「⤢」 */
    openMapPage: () => ipcRenderer.invoke('dsh-sidebar:open-map-page'),
    /* 页面 boot 时问一次"我该打开哪个项目"：只有"重开"会武装它 ⇒
     * 正常启动返回 null（仍按原样打开 projects[0]，启动行为不变 ✓） */
    bootProject: () => ipcRenderer.invoke('dsh-sidebar:boot-project')
  }
});
