# 架构设计（AI MindMap）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 设计
作用: 分层决策与理由、模块职责、架构约束、改哪里
不该写: 具体数字（指向 VERIFY.md）、规则全表
更新方式: 手写
-->

> 适用读者：任何接手本工程的 AI / 开发者。
> 本文解释"为什么这么分层"；实现细节见代码，命令清单见 `docs/CLI.md`，数据契约见 `docs/DATA-FORMAT.md`。
> **本文刻意不写"当前数字"**（命令数 / 用例数 / 版本号）——那些会漂移，权威值见 `docs/VERIFY.md`。
> 版本以 `package.json` 为准（四处版本号由 `node scripts/doc-facts.js --check` 校验一致性）。

## 1. 总体分层

```
┌─────────────────────────────────────────────────────────────┐
│  接入层（两种使用者，殊途同归）                                │
│  A. 人 → Electron 界面（renderer/ + main.js + preload.js）   │
│  B. AI → CLI（cli/mm-cli.js） ← MCP 包装（scripts/）         │
├─────────────────────────────────────────────────────────────┤
│  共享核心 src/（UMD：同一份代码 Node 与浏览器双端可 require） │
│  schema / markdown / convert / tree-utils / history /        │
│  config / data-store                                         │
├─────────────────────────────────────────────────────────────┤
│  数据层 projects/<name>/<name>.json + assets/（唯一事实来源）│
└─────────────────────────────────────────────────────────────┘
```

**核心决策**：CLI 是唯一逻辑源（single source of truth for logic）。渲染层所有
写操作都经 IPC → 主进程 → CLI validate 闸门 → 写盘；渲染层**不复制**任何校验/转换
业务逻辑，只做展示与交互编排。这样：

- AI 和人在同一套数据语义上工作，不会出现"界面保存的格式 CLI 不认"。
- 冒烟测试可以直接驱动渲染层 API（window.MMApp），无需键盘鼠标。

## 2. 各层职责

### 2.1 渲染层（renderer/，原生 `<script>`，无打包器）

`renderer/index.html` 是唯一页面；脚本按固定顺序用 `<script src>` 加载，
模块全部挂在共享命名空间 `window.MM` 上（拆分前它们是 `app.js` 单文件里的一个 IIFE）。
每个模块顶部为「定义在其他文件」的函数声明**转发包装**
（`const renderMind = (d) => MM.renderMind(d);`），因此各函数体内仍是裸调用。

| 文件 | 职责 |
|------|------|
| `index.html` | 唯一页面：工具栏、导图容器、浮动详情框模板、编辑/图片/附件对话框、审计与命令面板；**CSP 限制脚本来源** |
| `mindmap-adapter.js` | **渲染库适配层**（v0.18 起）：把对 jsMind **公共 API** 的调用收敛成 12 个语义函数（`getNode` / `getRoot` / `getSelected` / `available` / `selectNode` / `addNode` / `updateNode` / `removeNode` / `expandNode` / `collapseNode` / `expandAll` / `loadTree`），全工程唯一的调用形状是 `MM.adapter.X(jm, …)`。**纯转发**：不判空、不兜底、不吞异常、不 try/catch。目的 = 换库只改这一个文件（迁移前 83 处调用点，迁移后 `renderer/*.js` 里公共 API 调用点为 0）。⚠️ 它**只**覆盖可移植的那一半；我们主动接管的内部（`view.relayout` / `show_lines` / `e_panel` / `<jmnode>` / `jmexpander` …）**故意不进来**，清单见 `renderer/vendor/JSMIND-INTERNALS.md` |
| `app-core.js` | **必须最先加载**：初始化 `window.MM`、共享状态、`serializeTree`、`renderMind`、纯函数助手、`setStatus` |
| `app-view.js` | 画布视图：统一 transform 平移缩放、视口接线、居中/还原、主题模式、展开收起 |
| `app-detail.js` | 浮动详情框池：创建/复用/关闭、跟随锚点、小锁/大锁、逐帧看护、`showDetail`。**并持有详情框的「卫星」**（圆钮 🔗 与悬浮工具条）：卫星浮层 `MM.fdSatLayer()`（`#fd-satellite-layer`，与框**同级** —— 不是框的子元素：框是 `overflow:hidden`，放框里的圆钮会被裁掉，实测 DOM 读数说"在框外可见"而真帧 0 像素、`elementFromPoint` 点不到 ✓）；**显隐判据的唯一实现** `MM.fdSatellitePlan(box)`（框不可见⇒都不出现；节点详情框⇒圆钮恒有；**大小锁⇒关工具条、留圆钮**）；**唯一刷新口** `MM.syncFdSatellites()`（在 `positionFdBox` / `syncFdBoxes` / 拖动·改大小 mousemove 三处触发，再分派给各自的 owner）；**"这一击算不算点空白"的唯一判据** `MM.fdIsSatelliteTarget(evTarget)` | `MM.fdSatLayer()` / `MM.fdSatellitePlan(box)` / `MM.syncFdSatellites()` / `MM.fdBoxFrame(box)` / `MM.fdPrimaryNodeBox()` / `MM.fdIsSatelliteTarget(t)` |
| `app-detail-drag.js` | 详情框拖动与改大小、图片悬停提示；**拖动/改大小那一刻同步一次卫星**（那条路径不经过 `positionFdBox`，而逐帧看护在拖动期间主动让位 ⇒ 不在那里同步，卫星就停在原地 = 用户报过的"浮动/滞后" ✗） |
| `sanitize.js` | **正文 HTML 的消毒实现**（唯一一份；白名单表在 `src/html-whitelist.js`，本文件只做"按表删"）：`MM.Sanitize.inject(dc, html, opts)` 是**正文进 DOM 的唯一消毒入口**（`app-detail-content.js` 调它；只有 `MM.Sanitize` 整个不可用时才回落到裸赋 `innerHTML` —— 那条回落是既有兼容路径，不是消毒路径），`changed === false` 时注入**原始字节**（默认档逐字节不变）。手法纪律 = **先 `DOMParser` 解析成 DOM、再遍历删**，绝不正则处理 HTML —— `DOMParser` 产出的文档**没有浏览上下文**，远程 `<img src>` / `<iframe>` 在消毒**之前**不会发请求。威胁模型不是"Node RCE"（主世界无 `require`）：守的是 `window.desktop` 那条 **IPC 桥的授权面** —— 正文可来自别人仓库导入的 `.md`，一旦能变成活动代码就等于把整个授权面交出去 | `MM.Sanitize.inject(dc, html, opts)` / `MM.Sanitize.sanitize(html, opts)` / `MM.Sanitize.rules()` / `MM.Sanitize.state()` / `MM.Sanitize.resetState()` / `MM.Sanitize.bucketSuffix()` |
| `app-md.js` | **正文增强：注入之后的那一步**（消毒负责"不许进来什么"，本模块负责"进来之后怎么点、怎么画"）—— `MM.mdEnhance(box)` 由 `app-detail-content.js` 在正文注入后调；**不改数据**，产物只进 DOM。三件事：① **Mermaid 懒加载**（唯一实现在 `MM.mdLoadMermaid()`：往页内注入 `vendor/mermaid/mermaid.min.js` 这个**经典脚本**，不用 `import()` —— 本页是 `file://`，模块脚本走 CORS 会被拦；强制 `securityLevel:'strict'`；上界是 `MM.mdLimits` 的 `maxDiagrams` / `maxSrcBytes`，超限**如实降级并给原因**、图源代码块一个字不丢）；② **三类链接的事件委托**（工程内路径 / `http(s)` 交系统浏览器 / 其他 scheme 拦下并点名 URL；判据全在 `src/path-chain.js`，出口是既有的 `app:open-file`，经 `MM.openByChain`）；③ **笔记锚点**（按 `assoc.anchors[]` 在**消毒后的 DOM 文本节点**上匹配，跳过 `code`/`pre`/`a` 与属性值 ⇒ 正文**逐字节不动**；失效锚点显坏引用态，不静默） | `MM.mdEnhance(box)` / `MM.mdLoadMermaid()` / `MM.mdApplyAnchors(…)` / `MM.mdAnchorState()` / `MM.mdMermaidStats()` / `MM.mdIsMermaidBlock(text)` / `MM.mdLimits` / `MM.mdVendorUrl` |
| `app-detail-content.js` | `renderFdBox` 内容渲染（正文注入经 `MM.Sanitize.inject`，后者不在时才裸赋 `dc.innerHTML`）+ 容器/resize/节点层观察者接线 |
| `app-media.js` | 图片灯箱、附件预览（md 内联渲染 / pdf 内嵌）、`renderRelated`（相关知识点面板） |
| `app-bindings.js` | **绑定工作区文件夹的界面侧**（R4 第④步）：工具栏「📁 绑定文件夹」→ 主进程原生选目录 → **先预览**（复用 `bind-sync --dry-run`：新增 N / 更新 M / 未转换 K）→ **人确认才真绑定**；状态区（守护中/已暂停 · 已收录 N · 上次同步 hh:mm:ss · 本次 +N 改 M · 待确认删 K）+ 三个按钮（暂停/继续 · 立即同步 · 解绑）；同步真的改过树 ⇒ 复用并发可见性那一套 banner/面板与**同一个卡片渲染器** `MM.renderConcPanel` 逐条播报"这次加进来的是哪些节点"、点一条跳到它。**本文件一行同步逻辑都没有**：判定与写盘全在 CLI（`bind-sync`），界面只调 IPC 并**照原话**显示（脏时引擎报 `blocked-dirty` 就照原话显示）⇒ "绝不静默覆盖人的编辑"仍由既有版本闸门保证。**读状态只用 `--dry-run`** —— ⚠️ 不许拿 `--list` 当只读查询：它其实**会同步**，用它刷状态会让"暂停"名存实亡。未绑定 = 零噪声（状态条/播报/面板一律 `display:none`） | `MM.bindWorkspace()` / `MM.bindRefresh()` / `MM.bindAct(action)` / `MM.showBindPanel()` / `MM.bindPreviewRun()` / `MM.bindPendingOpen()` / `MM.bindConfirmDeletions()` / `MM.bindState()` / `MM.onBindSynced(payload)` |
| `app-audit.js` | 关系审计面板：呈现 `orphans`/`mentions` 清单，**漏链接可一键补链接**（写操作走 CLI） |
| `app-palette.js` | 命令面板（Ctrl+P）：模糊搜索节点与命令；排序用 `src/palette-rank.js` |
| `app-assoc.js` | **「关联笔记」二级页面**：渲染关联实体页（标题/成员列表/正文）+ 编辑对话框（标题与正文）；从节点详情的「相关知识点」区进入。**并在该区渲染「展示关联节点」按钮**（功能 2 的入口，恒常出现——没有关联笔记也可能有链接关系）。**assoc 的内存同步只有一处实现**：`MM.syncAssocRaw`（按 id 合并、**不能整体替换**——整份替换成子集曾导致保存时删掉别的笔记）；`MM.assocAddFromView` 是"关联视图里新建一篇"的唯一落点（IPC → CLI `assoc-add` → 回读同步 → 取回视图）。**圆钮 🔗 是详情框的卫星**：住在 `#fd-satellite-layer` 里、用 `data-fd-box` 与框一一对应、框一关就被 `MM.dropFdSatellites(boxId)` 收干净（同生命周期 ✓）；落位的唯一实现在 `MM.layoutRelShowBtn()`，取钮 / 反查框是 `MM.fdRelShowBtnOf(boxEl)` ↔ `MM.fdBoxOfSatellite(btn)` **这一对**（圆钮不在框里了 ⇒ `btn.closest('.float-detail')` 永远是 null ✗，靠它判"在框外不遮挡"会静默判错） | `MM.syncAssocRaw(list)` / `MM.assocAddFromView(project, centerId, members, title, noteMd)` |
| `app-import.js` | **拖拽文件 ⇒ 导入成新项目**（功能 5a 的拖拽入口）：投放提示覆盖层、取路径、如实报结果。**两条入口一个实现**：菜单走主进程的 `importDocDialog`，拖拽走这里，最后都调 `importDocToNewProject`。**取路径必须走 `desktop.app.pathForFile()`** —— Electron ≥32 起 `File.path` 已被移除，`webUtils` 只有 preload 拿得到（这是渲染层唯一的取路径方式 ✓）。不支持的扩展名**说清楚**（不静默失败）| `MM.importDocFile(path)` / `MM.importHandleFiles(FileList)` / `MM.showDropHint()` / `MM.hideDropHint()` |
| `app-ask.js` | **节点悬浮工具条 + AI 问答浮窗**（功能 1 界面层）：选中节点（= 出现详情框）后弹出工具条；**工具条锚在详情框上**（`data-anchor=box`：默认贴框**下缘外侧** +6；框高到下方放不下就**翻到上缘外侧** −6；再放不下才夹进面板 —— 档位写 `data-place`；只有选区、没有框时才退回"贴选区外接矩形上方并夹进视口"，`data-anchor=nodes`，`scripts/smoke/29-multiselect.js` ④ 要求它必须出现）。**显隐与落位的唯一实现是 `MM.layoutNodeToolbar()`**：改前判据散在 5 处（包 `showDetail` / 包 `closeFdBox` / 点别处 / 内部两条早退 / 选区变化），于是**只在"开框那一刻"刷一次** ⇒ 拖动框、改大小、缩放后全脱钩（用户报的"浮动/滞后"）；现在两条猴子补丁已拆掉：目标由**框池**推导（`MM.fdPrimaryNodeBox()`）、框一关自动收起；**大小锁时收起**（圆钮不受影响）。浮窗**复用详情框组件**（`createFdBox`）从而自带拖动/改大小/📌🖥 锁/让位 —— 这正是"视觉与节点详情一致"最省力的达成方式 ✓。后端走 `app:ask`（main.js）→ `cli ask` → `dsh headless`，**每问一次是一次独立会话**（界面上明说，不假装连续对话）；冒烟里后端返回 `stub:true` 的桩，界面**必须**把它标出来（`.ask-stub`，有断言守）。**N 的口径**：多选时按钮写「💬 问这 N 个」，N = **原始命中集**（`MM.getSelectionRaw()`，= 用户"点过谁"= 画面上真的带虚线描边的那些），**不是**裁剪集（`fdSelection` 是给收起/拖动这类树操作定义的口径，父也在选区时会把子节点剔掉 ⇒ 拿它计数会与画面和实际提问集合都对不上 ✗）。工具条 `data-count`、按钮文案里的数、真正送出去的 `nodes` 三者同源 ✓（`scripts/smoke/36-real-input.js` ④ 用真点按钮 + 真键盘 + 桩回显钉住它）| `MM.showNodeToolbar(id)` / `MM.hideNodeToolbar()` / `MM.layoutNodeToolbar(layer, frames, view)`（唯一落位实现）/ `MM.showAskBox(id, {kind, focus})` / `MM.renderAskPage(box)` / `MM.computeBarPos(rect,w,h,view)`（纯几何，可判） |
| `app-related.js` | **关联节点可视化**（功能 2）：按 `src/related-model.js` 的模型把关联节点**缩放至刚好框住**（`MM.setViewTransform` 一趟算出 s/x/y）、高亮它们并轻微虚化其余（**只写 CSS 类** —— jsMind 会重写内联样式）、在 `fdViewEls()` 里的 SVG 关系层画虚线（随导图同变换 ⇒ 平移缩放零重算），点线按**鼠标位置**开关联笔记（大锁钉住 = 不跟导图跑）。模型缺 `src/related-model.js` 时**响亮抛错**（不静默退化）。**并承载「关联信息」编辑条**（`#mm-rel-edit`，进视图即出现、与视图同生命周期）：链接清单（出边/入边逐条 ✕ 删）· 添加链接（输入即搜 = `app.nodes` + `src/palette-rank.js`）· 新建关联笔记（成员小标签，走 `MM.assocAddFromView`）；`fitToNodes(ids, insetTop)` 会**让出编辑条占掉的顶部高度**，否则"刚好框住"会把最上面那排节点藏在条底下。**链接改动写内存只有一处实现**：`MM.applyLinkToMemory`（补链接与删链接共用，`app-audit.js` 的补链接也走它） | `MM.showRelated(id)` / `MM.clearRelated()` / `MM.isRelatedActive()` / `MM.scheduleRelatedRedraw()` / `MM.applyLinkToMemory(opts)` / `MM.isRelatedEditBarOpen()` / `MM.relatedEditBarEdges()` / `MM.setViewTransform({s,x,y})`（在 app-view.js） |
| `app-heat-bars.js` | **详情框里的两条热度条（人 / AI）+ 那次人类访问的采样**（热度条第三件·A）。两条纪律：① **只展示** —— 每一个数都来自 `desktop.app.heat` → 主进程 `app:heat` → CLI `heat --json --node <id>`（档位映射的唯一一处在 `src/heat.js` 的 `heatProfile`），本文件**不折算任何数**（`bands`/`heat`/`rank` 逐字照读数画；结构断言盯着"源码里不出现档位换算"）；② **不写盘** —— 它只调两条 IPC（读热度 / `app:visit` 记一次人类访问），**不碰项目数据、不触发保存、不产生脏标记**（看热度不该留下写）。采样点写在 **`app-detail.js` 的 `showDetail`**（"打开详情框"的唯一入口，节点点击/搜索/关联/面板全汇到它）⇒ 框内重绘不经它、不会重复计数；打开**不被拖慢**（fire-and-forget），失败**响亮**（控制台一条 + 框里/状态栏一条可见提示，不静默）。⚠️ 它写在**另一个容器**（`.fd-heat`）里，与"正文只有一份"（`app-detail-content.js` 的 `dc.innerHTML = detail`）**无关**：正文的字节一个都没变 | `MM.heatBarsRefresh(box, node)` / `MM.heatBarsRecordHumanOpen(node)` / `MM.heatBarsState()`（前两个由 `app-detail*.js` 调，第三个给冒烟断言读原始读数） |
| `app-actions.js` | 保存闸门与未保存判定（`isDirty`）、**并发冲突的两条出路**（`resolveConflict`：用磁盘版本 / 保留我的）、快照撤销重做、节点增删改、搜索、项目加载/切换、MD 导入导出 |
| `app.js` | **接线层**：`wireUI()` + `window.MMApp` 对外导出 + `DOMContentLoaded` 启动 |
| `editor.js` | **交互层**：编辑/图片/附件对话框、快捷键、MD 导入导出文件选择；只调 MMApp API，不直接改状态 |
| `contextmenu.js` | **交互层**：节点/背景右键菜单 + 双击节点（**有子节点 = 展开/收起；无子节点 = 打开详情框**，R5-3 起；开详情只经 `MM.showDetail`）+ 结构轴菜单项（树 / 复杂，会话级，R2 期 5） |
| `vendor/jsmind.js` | 第三方导图引擎（npm **jsmind@0.9.1** es6 版，本地化避免 CDN）。**升级前必须先读 `renderer/vendor/JSMIND-INTERNALS.md`** —— 那张表列着我们**主动接管**的内部符号（14 类 / 75 个代码行）与三条实测事实，是升级时**要人工回归的清单**（本节只说明"它是谁"，不复述那张表） |
| `style.css` | 界面样式（含审计面板与命令面板） |

**为什么 app.js 与 editor.js 分离**：冒烟断言直接调用 `MMApp` 的 API（如
`MMApp.addNode / save / undo`），editor.js 的 DOM 交互不进入测试路径——
保证"核心逻辑可 headless 验证，交互只是壳"。

**对外契约**：`window.MMApp`（项数见实际导出）是渲染层唯一对外 API，供 `main.js`、
`renderer/contextmenu.js` 与冒烟断言使用；`main.js` 还读 `MMApp.getState().jm` / `.project`。
**跨文件可变状态**：`fdView` / `fdHideRootLinks` / `fdDrag` / `fdResize` 会被整体重新赋值，
无法用转发包装共享，故以同名全局槽位承载（声明于 `app-core.js`，页面内无同名元素 id）。

**序列化扩展**（`app-core.js` 的 `serializeTree`）：jsMind 的 `get_data('node_tree')`
会丢失节点自定义字段（detail/images/links 存在 node.data 上），因此手写
walk 序列化，把 data 字段平铺到节点层级，保证工程 JSON 与界面一致。

**归属划分：「节点树归渲染层，`assoc`（关联笔记）归 CLI」**。`assoc` 是项目级集合、
不在节点树里，**成批作者是 AI/CLI**（界面里"新建一篇"走关联视图的「关联信息」编辑条 →
CLI `assoc-add`；二级页面本身仍只能从节点详情的「相关知识点」区进入，用它读它、并编辑标题与正文
——写操作仍走 CLI）。因此两侧各让一步：
渲染层用 `state.assoc` 持有它并由 `serializeTree` 原样写回（否则界面保存即抹掉），
主进程 `project:save` 在渲染层未带 `assoc` 时**从磁盘取回**、不用空值覆盖
（否则 AI 刚写的笔记会被一次界面保存清掉）。**删节点是两侧唯一的交叉点**：删掉被关联引用的节点
会留下悬挂成员，而 `project:save` 的校验闸门会**拒绝保存**（此后该项目所有写操作都被挡住），
界面又没有"改成员"入口 —— 故渲染层的删除会先读 `assoc-list --raw` 与同项目入边链接、弹确认列出
影响面，再经 IPC `app:pre-delete-cleanup` 让 **CLI 在磁盘上**先剪干净（`links-prune` + `assoc-prune`），
**成功后才删节点**（清理失败就不删，绝不留下"保存不了"的中间状态）。
为什么清理不能只在渲染层内存里做：`project:save` 在载荷里没有 `assoc` 时会从磁盘取回，
于是"我把 assoc 清空了"与"我没见过 assoc"在载荷上无法区分 → 内存里剪掉的成员会**原地复活**（实测）。
清理完渲染层还要把**内存树**里指向被删节点的链接一并摘掉（与 `app-audit.js` 补链后的就地同步同一道理、方向相反），
否则下一次 `save()` 会把悬挂链接原样写回磁盘。数据契约见 `docs/DATA-FORMAT.md` §2.6。

**链接改动写内存的唯一实现是 `MM.applyLinkToMemory`**（app-related.js）：补链接（`app-audit.js`
的审计面板、关联视图编辑条的「➕ 添加链接」）与摘链接（编辑条的每行 ✕）都走它，别在调用点各写一遍。
两条相关 IPC 都是**写完回读**：`app:unlink-nodes` 回读该节点剩下的出边并**裁成契约形状**
（只留 project/id/caption —— 派生字段写回内存会污染契约），`app:assoc-add` 回读**原始实体**
（`assoc-list --raw`）并认出新增那篇的 id；`assoc-add` 的**写前**回读失败即判失败（拿不到真值不猜）。

### 2.2 CLI 层（cli/）

| 文件 | 职责 |
|------|------|
| `mm-cli.js` | **薄壳**：把 `process.argv` 交给 `main.js` 的 `invoke()`，再把 stdout/stderr 落地、把 code 写进 `process.exitCode`。拆薄的理由：集成断言原先只能靠 `spawnSync` 起子进程（实测每条 0.73 s 冷启动），导出纯函数后可在同进程内调用 |
| `main.js` | **可进程内调用的入口**，两个：`invoke(argv)`（异步）与 `invokeSync(argv)`（同步，供直线式同步断言序列）—— 均返回 `{code, stdout, stderr}`；解析 argv → 查 registry → 执行；`--help`；错误输出 `error: <原因>` 约定。两条硬约束：**不调用 `process.exit`**（会连带杀死宿主：MCP / Electron 主进程 / 测试进程）；进出**隔离 `process.exitCode`**（它是全局态，且 `validate`/`validate-all` 会**自行置非 0** 表达失败，故 code 必须读回而不是只看抛没抛错）<br>⚠️ **`invokeSync` 依赖一条不变量**：`cli/commands/*` 的命令体**不得出现 `await`**（及 `.then()` / `fs.promises` / `setTimeout` 等）。JS 里 async 函数体在首个 `await` 前是同步执行的，所以这些命令实际同步完成。违反时 `invokeSync` **立刻抛错**（不静默降级），并由 `tests/cli-sync-invariant.test.js` **静态把守** |
| `registry.js` | **命令注册表**：每条命令的 name/aliases/usage/desc/**options**/compatOptions/fn；**新增命令必须在此登记**（docs-gen 依赖它）。当前命令数见 `docs/VERIFY.md`。<br>⚠️ **`options` 是"这条命令认识哪些选项"的唯一声明处**，`cli/main.js` 在 dispatch 里据此判未知选项（判定只有这一处，见下条）。`compatOptions` = 接受但**故意不写进 usage** 的旧写法（如 `read --detail`：`--json` 下空操作、文本模式响亮报错）。三者必须同步：usage（文档）/ options（判定）/ 命令体（实现）—— `tests/cli-options.test.js` 机械核对前两者，漏一处即红 |
| `core.js` | 上下文工厂：参数解析（`--key value` / **`--key=value`** / 布尔 flag / 位置参数）、DataStore、校验闸门、项目读写封装；**`ctx.mutate(fn)` = 多路同时编辑的入口**（读→改→写，并发时按 `src/concurrency.js` 的规则自动重放或指名拒绝）。`--key=value` 的归一（`optionKey`）与未知选项扫描（`unknownOptions`）都是**无 IO 纯函数**（可单测）：解析与白名单判定必须共用同一套归一规则，否则会出现"解析器认识、白名单不认识"的错杀。**整数选项走 `ctx.intOption(key, {min,max,def})`**：非法值当场报错并说清允许范围，**不静默退化成 NaN / 默认值**（修前 `--limit abc` ⇒ `slice(0,NaN)` = 空清单、`--timeout abc` ⇒ 悄悄用默认超时） |
| `commands/project.js` | 项目级命令（只做"读参数 → 调 src/ 纯逻辑 → 输出"）：projects/read/list/get/search/stats/init/import-md/**import-dir**/export-md/**export-html**/export-json/import-json/validate/validate-all。**两条"从零建项目"的导入**分工：`import-project` = 一个**文件** → 一棵树；**`import-dir`（批 5）= 一个目录 → 与文件夹同构的一棵树**（每一级子目录一个容器节点、每个文件一个文件节点，标题取文件名去扩展名；文档自己的标题在它下面）。`import-dir` 的四道闸门全在**写盘之前**（入参 / 体量+文件数 / 幂等 / 项目重名），整棵树先在内存里建好再**一次 `ctx.write`** ⇒ 失败不留半个项目。幂等两档：项目根挂**目录清单指纹**（同一个目录重复导 ⇒ **整体拒绝**并指名上一次导到哪个项目的哪个节点）、每个文件节点挂自己的来源指纹（同一个文件被别的命令导过也拒绝）—— 两档都走 `src/doc-import.js` 的 `originKey`/`originMatches`（判据只有一处），全库比对走**一次扫盘**建的索引（按文件粒度逐个查全库是 O(文件数 × 全库规模)） |
| `commands/edit.js` | 节点编辑：add/add-root/edit/move/remove/clone |
| `commands/merge.js` | **`merge-project <目标项目> <源项目…>`** —— 把若干个已有项目整棵并进一个已有项目（判据全在 `src/merge-project.js`，本文件只做"读盘 → 调它 → 回显"）。走 `ctx.mutate` ⇒ 版本闸门 / 并发重放 / 写盘前校验 / 一次原子写 / `--dry-run` 中央短路全部复用既有机制；`--dry-run` 与真跑跑的是**同一个改动函数 + 同一份写盘前校验**（预览期每一条拒绝照原样抛出、报文逐字相同）。 **源项目只读**（合并是复制一棵树进去），**不提供删源**；撤销是一条既有命令：`remove <目标> <分组节点id>`。R5 连带面：目标项目若是 `meta.rootMode='themes'`，新并入的顶层主题默认排**右侧** ⇒ 回显主动提示用 `theme-layout` 分侧 |
| `commands/learn-path.js` | **`learn-path <项目…>`（产品代号 `LP`，学习链路）** —— 把若干本已入库的书（或若干份有树 + 正文的资料/经验）排成**一条有序链路**，落成一个**新项目**。判定与排序**全部**在 `src/learn-path.js`；本文件只做"读参数 → 读盘（**并先给输入拍 sha256 快照**）→ 调它 → 一次 `ctx.write` → **写完再拍一次快照逐字节对拍**"。**输入项目只读**：本文件里没有任何一处对输入调 `store.write`/`ctx.mutate`，而且"我没写"由 `sourceIntegrity` **量出来**（任一字节不同 ⇒ 命令**响亮失败**，不是警告）。产物**零新增字段**：顺序由 `children` 顺序表达（数据里唯一有序的表达）、出处由既有跨项目 `links[]` 指回原书节点、依据写在 `detail`（含一行机器可读的 `lp-why:v1\|…`）。`--dry-run` 走**中央短路**（本文件里没有任何 dry-run 分支）；`--out` 已存在 ⇒ 拒绝，覆盖必须显式 `--force`。⚠️ 三个"只在真数据上才会踩"的点写在这里：① `--out` 不能与输入同名（否则就改了原书）；② `links[].project/id` 必须指向**真存在**的节点（`src/schema.js` 的悬挂检测在写盘前校验里）；③ `--limit` 截断**不是成环**（两者混起来会让调用方去改本来没坏的数据）。 |
| `commands/assets.js` | 图片与附件：add-image/remove-image/assets/add-file/remove-file/files |
| `commands/links.js` | 跨项目链接：link/unlink/links/links-prune（清理悬空链接 —— 别的项目删了目标节点后本项目的自救路） |
| `commands/qa.js` | **`ask-apply <项目> <id> --answer "回答"`**（功能 1 的下半截：把一次 AI 问答**落到节点上**）—— 界面「写入本节点详情 / 新建子节点」两个按钮的**唯一出口**。一次调用做三件事、**同一个 `ctx.mutate` ⇒ 一次原子写**：① 追加 `qa` 记录（完全相同条目幂等）；② 把带来源标记的问答追加到 `detail` 末尾（HTML，形状在 `src/qa.js` —— 单一实现）；③ `--as-child` 时建子节点（标题取回答首行截断、详情放全文）。为什么 ①② 必须同一条命令：分两次调用要写两次盘 ⇒ 中间被打断就留下"qa 记了、详情没写"这种自相矛盾的数据。**空回答响亮拒绝**（落一条空记录比报错危险得多）。`--at` 由调用方给（界面显示的时间 = 落盘时间）。写盘的闸门/原子写/并发版本闸门全在 `ctx.mutate` 里，渲染层不碰盘 |
| `commands/ui.js` | 界面控制**四条命令**：`sidebar-only <on\|off>`（on = **真卸载导图页**（这一页的内存被释放，主窗口只剩占位页）、只留 DSH 侧栏；off = 重新加载导图页）、`dsh-sidebar <on\|off>`（**保留主界面**、关/开侧栏 DSH，off 连服务一起停并销毁侧栏视图）、`dsh-status`（**只读**诊断：视图在不在/导图页关没关/可见性/总占宽/窄宽模式/是否横向溢出，白名单输出不含 url/token）、`dsh-prefill`（把文本预填进侧栏输入框；**不代替用户发送**）。存在理由：改哪一半就只关哪一半 ⇒ **不必重启整个应用**；改侧栏布局前先 `dsh-status` 拿数字，别凭肉眼。走文件式控制通道（`src/control.js`），**没有回执即报错**（界面没在运行时不许假装成功）；**被界面拒绝**（如导图页有未保存编辑）时转述原因，与"没响应"分开报。<br>⚠️ **每条命令带自己的 token，回执按 token 认**（协议 v2）：旧实现按命令名认回执 ⇒ 两条**同名**命令并发时会互相吃到对方的回执；`dsh-prefill` 的探针与慢命令**共用同一个 token**（同一个调用方 = 同一个等待位）。<br>⚠️ **慢命令走"先探活、再下命令"两步**：`dsh-prefill` 可能要先把侧栏服务起起来（app 侧最坏 ≈12.4s），而"界面没在跑"与"界面在跑但慢"只看它自己的回执**分不开** ⇒ 先问一句只读的 `dsh-status`（当场可答、无慢路径）：没回执 = 没在跑（**立刻**报错，且不发出慢命令）；有回执 = 活着，再给足窗口（14s > 12.4s）。修前实测：失败路径 12.56s（同批另三条 ~3.0s），且 12s 窗口 < app 侧最坏路径 ⇒ 界面还在干活就被判"没响应"（**假原因**）|
| `commands/relations.js` | 引用关系：backlinks（单向反查）/ related（出边+入边双向合并；**`--depth N` 深度任意**，逐层 BFS + 防环（每节点只以最短跳数入表一次）+ 结果上限（撞上限**响亮报错**并给出缩小范围的办法，绝不静默截断）/ orphans（关系审计）/ mentions（未链接提及） |
| `commands/assoc.js` | 关联笔记（N 元关联实体）：assoc-list/assoc-add/assoc-edit/assoc-remove/assoc-prune（参数处理 + 读写 + 输出；纯逻辑在 `src/assoc.js`） |
| `commands/release.js` | 工程命令：docs-gen（从 registry 重生成 `docs/CLI.md`）/ release（发版）/ **changelog**（CHANGELOG **只读**窄查询：段/条目索引或按关键词检索正文）。`changelog` 的索引从正文**现算**、不落生成物 —— 详见 `src/changelog.js` 的 `indexChangelog` 注释（为什么不做成生成文件） |
| `commands/changes.js` | **变更可见性**（只读，阶段 3）：谁、何时、改了哪些对象。数据来自唯一写盘出口顺带产生的 `projects/<项目>/.changes.jsonl`；`--since <rev\|版本号>` 回答"自那以来改了什么"。⚠ **答不了时报错并非 0 退出**（锚点滑出窗口 / 本机无日志）——**不等于"没有变更"** |
| `commands/heat.js` | **访问热度**（只读 `heat <项目>` + 记一次访问 `visit <项目> <节点id> --channel <通道>`）：口径（通道权重表 / 窗口 / 名次→档位 / 事件日志格式）**全在 `src/heat.js`**，本文件只读参数、调它、排输出。热度条第三件起 `--json` 另有两档**只给 AI**：`--node <id>`（界面两条热度条读的那一份单节点读数；**按全量排名算，不受 `--limit` 影响**）与 `--derived summary\|keys`（**隐藏维度**：标签 / 章节 / 节点树的派生热度 + 每维样本量 `nodes/visited/events`）—— 两者都**不在文本档、也不在界面**出现 |
| `commands/item.js` | **条目级写原语**（v3 条目层的写入端）：item-add/item-edit/item-remove/item-move/item-order/render-detail。签名、回显、`--json` 字段、必错情形与"指路"文案**逐字**按 `docs/ITEM-MODEL.md` §3.2 实现（本文件**不重新设计**任何一条语义）。三条纪律：① 全部走 `ctx.mutate`，改动函数保持**纯**（不做 I/O、不打印、不读时钟 —— 并发冲突时会被**再调一次**，时间戳/写入者/新 id 一律在进 mutate 之前算好）；② 每次改完一个节点的 `items` **立刻重渲染它的 detail**（detail 是派生缓存，半路返回 = 数据非法）；③ 回显**点名 itemId**，拒绝**点名对象 + 给出路**。`edit --detail`/`--detail-md` 两扇门在条目化节点上的关闭**落在 `commands/edit.js`**，不在此文件。 |
| `commands/migrate.js` | **v2 → v3 条目层迁移**：`migrate items <项目> [--dry-run] [--json]`。判定逐条按 `docs/ITEM-MODEL.md` §6：只迁"无 `items` 且（detail 含 `<li>` 或 有 `qa[]`）且 `renderDetail(parseDetail(detail)) === detail` **逐字节**成立"的节点；回放不了 ⇒ **整节点跳过 + 逐条点名**；`qa[]` 收敛成 `type:'qa'` 条目后删掉 `qa` 键；**不写** `detailMode`；`meta.formatVersion` → 3。写盘**之前**自动 `export-json` 到 `.review/<YYYYMMDD>-条目层迁移/<项目>.aimap.json`（与 `commands/project.js` 的 export-json **同一实现** `src/bundle.js`），**没有跳过备份的开关**。⚠️ 位置参数陷阱：项目名取 `ctx.args._[1]`（`ctx.projectName` 会是子命令名 `items`）；备份先于写盘 ⇒ 命令体**显式先调 `ctx.replayCheck()`**。 |
| `commands/recheck.js` + `commands/health.js` | **条目层复校与体检**：`recheck` 逐条点名 `ok`/`needs-recheck`/`src-gone` 与原因并给下一步（只读默认；写回 `verified{at,by,how}` 需显式 `--write-verified --how`）；`health` 是**真值出口**（条目化/总数、type 分布、`items↔detail` 不一致逐节点点名、悬挂引用、`qa` 残留、迁移五档含跳过点名）。两者共用 `recheck` 的 `scanProject()`（判定只有一处实现） |
| `src/item-src.js` | **"出处"这一维的主体实现处**：`src` 的解析（`file:line`、`file:line::引文`、URL、命令）/ "过期"判定（文件在不在 + 引文逐字搜 + `mtime > verified.at`）/ **两处薄转发**（归一化与子串匹配的**唯一实现都在 `src/item-index.js`**：`srcList` / `srcMatches`）；按绝对路径 memo（同一文件一次运行只读一次） |

**错误约定**：所有失败经 `ctx.error()` 抛错，`main.js` 的 `invoke()` 捕获后输出
`error: <message>` 并设**退出码 1**。MCP 与主进程同时检查退出码与前缀——两重判据、可解析。
（`validate`/`validate-all` 输出结构化报告，同样以非 0 退出码表达失败。）

### 2.3 共享核心（src/，UMD）

UMD 包装让同一份代码在 Node（CLI/测试）与浏览器（renderer script 标签）都可用：

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(...);
  else root.MMXXX = factory(...);
})(typeof self !== 'undefined' ? self : this, function () { ... });
```

| 文件 | 职责 | 关键接口 |
|------|------|---------|
| `schema.js` | 数据校验 + 版本（formatVersion 2） | `validateProject(data, projectsRoot)` |
| `markdown.js` | MD ⇄ 节点树 | `markdownToTree(md, parentId)` / `treeToMarkdown(root, opts)` |
| `convert.js` | HTML ⇄ Markdown（**仅用于 import-md/export-md 边界与 .md 附件预览**；节点 detail 本身以 HTML 存储，见 DATA-FORMAT §2.4） | `htmlToMarkdown(html)` / `markdownToHtml(md)` |
| `tree-utils.js` | 纯树函数（无副作用） | `walk/find/count/flatten/removeNode/moveNode/pathTo` |
| `history.js` | 快照式撤销重做栈 | `UndoStack(limit)`：push/undo/redo/canUndo/canRedo/clear |
| `relations.js` | 引用关系计算（纯逻辑，依赖注入） | `backlinksAll()`（谁引用我）/ `relatedAll()`（出边+入边合并、标注 out/in/both；**`depth` 任意正整数**，逐层 BFS，返回 `byDepth` / `truncated`；`MAX_ITEMS`=500 —— 到了就停并置 `truncated`，**要不要报错由调用方决定**） |
| `assoc.js` | 「关联笔记」实体（N 元关联，纯逻辑） | `parseMembers`/`includes`/`forNode`/`memberLabel`/`autoTitle`/`pruneMembers`/`validateAssoc`/`validateAll`/`genId`（`MIN_MEMBERS`=2；成员是否存在由 `schema.validateProject` 读盘检测） |
| `links.js` | 链接剪枝纯逻辑（与 assoc 同源的"删节点→悬空"问题） | `pruneLinks(root, shouldRemove)`（**就地修改**树、删空则去键）/ `allLinks` / `inbound(root,project,id)` / `targetKey` |
| `merge-project.js` | **把若干个已有项目整棵并进一个已有项目**的纯逻辑（**唯一的跨项目"搬整棵树"入口**：`move`/`clone` 只收一个项目名，`import-*` 建的是新项目）。**id 处理是本模块唯一的判断**，依据三条实测：① 全库 9 个项目的根 id 都是 `root`，且根节点上**只有** `{id,topic,expanded,children}`（`detail` 长度 0、无 origin/tags/items）⇒ 它是容器占位 id；② 除根外 466 个源 id 与目标 889 个 id 交集为 0；③ 全库 **0 条** `links[].id` / `assoc.members[].id` / `assoc.anchors[].id` 指向 `id==='root'` ⇒ 换那一个 id 不可能改指任何边。于是：**分组节点就是源项目的根**（深拷贝、只把 id 换成确定性的 `merge-<源项目名>`），**其余 id 一律逐字带走、绝不重签发**（id 是 links/assoc 的唯一键，重签发 = 静默改指或改悬空 —— `clone --repoint-items` 的同一条教训）；撞号/条目 id 撞号**一律拒绝并点名**，不提供自动改名。**幂等键 = 分组 id 存在 + 该源全部非根 id 已在目标里**（不用 `origin.src+sha256`：合并的输入是一个项目而不是一份文件，而携带的 id 逐字相同比指纹更硬），命中即拒绝并**指名上一次落到哪个节点**；**没有 `--force`**（再写一份必须重签发 471 个 id）。`--links keep`（默认，边一字节不改）/ `repoint`（把指向本次合并源的边改指目标项目内**同 id**，根改指分组节点，**逐条核验**，一条不过即整体拒绝）。`data.assoc` / `data.bindings` / 未知节点字段 / `meta.formatVersion` 与目标不同 ⇒ **拒绝并点名**。全部源验过才动 `target.data` ⇒ 一次原子写、失败不留半个合并。**不删源项目**（源默认保留），撤销 = `remove <目标> <分组节点id>` | `mergeProjectData({target, sources, parentId, linksMode, groupIdOf})` → `{ok:true, data, groups, totals}` / `{ok:false, code, message}`；取值表 `LINKS_MODES` / `GROUP_PREFIX`；`defaultGroupIdOf` |
| `mentions.js` | 「未链接提及」计算（纯逻辑） | `findMentions(root, opts)` 本项目内；`findCrossMentions(projects, self, opts)` 跨项目 in/out（同名歧义标 `ambiguous` 而非乱猜） |
| `learn-path.js` | **「学习链路（`LP`）」的判据与排序唯一实现处**（UMD 纯逻辑：**零 I/O、零时钟、零随机**；设计定稿在 `.review/20261020-LP-学习链路/设计.md`）。它回答的是 `.review/` 下 2026-10-15 那份「多文档逻辑分析图谱」雏形**一个字没写**的那一维：**顺序从哪来、凭什么说它对**（那份设计只给了两种**无序**产物：关系图谱与新树）。**四层依据、方向只来自前两层**：`chapter-order` 书内 DFS 前序（权威 —— 书的 `children` 顺序是数据里唯一有序的表达）· `explicit-prereq` `links[].caption` 以「前置：」开头（权威 —— 人显式给的）· `term-affinity` 术语共现**导航**（弱 —— 共现是**对称的**，只决定"下一步学谁"，**绝不宣布前置**；权重是 **IDF 定点整数** `round(10000·ln(N/df))` ⇒ `df === N` 的模板噪声权重 0，**不靠手写停用词追**）· `mechanical` 确定性兜底序（书序 → 书内序；**如实标注"这不是学出来的顺序"**）。图**只有**书内骨架与显式前置两种边 ⇒ 共现与兜底序**不可能造出环**；真成环时返回 `{ok:false, code:'cycle'}` 并用 Tarjan SCC **逐条点名环上的边**（含声明处 `at`），**一条边都不静默丢**。**跳级**落成能算的判据：`gaps` 三档（目标项目不在输入 / 排在后面 / 目标节点没有正文）。**AI 预算单位 = 调用次数**（不是字符数：字符数是"我们自报的读数"，次数是执行留下的痕迹），计数 **= `ai.log` 的条数**（适配器每调一次必须追加一行 ⇒ "少报次数"被结构性堵死）；本版 `maxCalls = 0`、`ai.calls === 0` 是**判据**。 | `planPath(projects, opts)` → 报告（books/units/graph/steps/gaps/ai/determinism）；`collectUnits` / `buildGraph` / `topoOrder` / `computeGaps` / `whyOf` / `whyTokenOf` / `parseWhyToken`；`extractTerms` / `idfWeight` / `parseChapterNo`；取值表 `WHY_KINDS` / `PREREQ_PREFIXES` / `TERM` / `STOP_TERMS` / `AI_BUDGET` / `MAX_UNITS` |
| `palette-rank.js` | 命令面板的模糊检索与排序（纯逻辑） | `fuzzyScore`（**null 表示不匹配**，分数可为负）/`rankPalette`（空查询时命令在前） |
| `export-html.js` | 静态站点导出（纯逻辑，无 IO） | `buildIndexHtml`/`buildModel`/`collectAssets`/`safeJson`；相关知识点内联为可跳转链接 |
| `query.js` | 查询与视图构造（纯逻辑） | `buildReadView`/`buildNodeList`/`getNodeView`/`computeStats`/`searchNodes`/`treeLines` —— **决定 AI 看到什么** |
| `bundle.js` | aimap v1 打包格式（Node 侧纯逻辑） | `buildBundle`/`parseBundle`/`collectResourceRefs`/`isSafeRelPath`（路径穿越防御） |
| `doc-import.js` | **大文档 → 提纲的前端**（功能 5a，Node 侧同步）：**一个建树入口、四种前端** —— md 直接用、txt 走启发式（短行+前后空行+不像列表/网址 ⇒ 标题；`第一章`/`1.1` ⇒ 层级）、docx 自己解最小 zip（**零依赖**：node 自带 zlib 解 deflate ✓，读 `word/document.xml` 的段落与 `Heading1..6` 样式）、**pdf 起小进程读**（`scripts/pdf-outline-helper.mjs`：**有书签走书签，无书签回退文字层** —— 纯逻辑在 `src/pdf-text.js`）。四者都先变成"带 `#` 的 Markdown 提纲"再交给 `markdown.js` 建树 ⇒ 只有一套树构建规则。**边界**：txt 的标题识别是尽力而为（认不出就是正文，绝不丢内容）；docx 不支持 ZIP64/加密（**响亮抛错**）；PDF 无书签且文字层也用不上时**响亮拒绝**并给出路（带数字，不许当文本读进去 ✗）；`.doc/.epub` 等**认识的但不支持**的格式直接拒绝。**容错**：剥掉 BOM（实测带 BOM 的 md 会让首行 `#` 匹配不上、吃掉第一个标题 ✗ —— 两条导入路都走 `normalizeOutline`，见 `docs/DATA-FORMAT.md` §2.8）。**入参闸门**（`describeImportSourceProblem`）：目录 / 路径不存在 / 没权限 / 不是普通文件各自给**原因准确 + 带出路**的报文 —— 原先目录会露出 Node 原始的 `EISDIR: illegal operation on a directory, read`，而"想导整库"的人第一步就会撞到它 ✗。**体量闸门**（`describeOversizeSource`/`describeOversizeBuffer`，上限是 `src/doc-import.js` 里的一份常量 `MAX_SOURCE_MB`，两条导入路共用）：超限时在**读之前**响亮拒绝 + 三条出路（拆 / 转格式 / 取一段）—— 几百 MB 的 txt 整份读进来会把进程拖垮，而"被拖垮的进程什么都不打印" ✗。**PDF 子进程的上限报文**（`pdfOutlineViaHelper`）：子进程输出超 `maxBuffer` 时明确说"这是**提纲文本超过读取上限**，不是这份 PDF 坏了"（原先只说"子进程没有给出结果"，会让人朝错的方向查）。**来源指纹**（`makeOrigin`/`outlineSha256`/`originMatches`/`describeOrigin`）：记下"这棵树从哪份文档、哪一次导入来"（见 DATA-FORMAT §2.8），是批量导入幂等的前提；规范化与指纹**只有这一处实现**，写入方不许自己拼 origin。<br>**批 5 追加：整库导入（`import-dir`）的"目录 → 容器树"前端** —— 把**文件夹结构**镜像成树：`scanImportDir`（**只读**走查：逐类跳过计数、总量、容器数；不读文件内容、不写盘）+ `buildDirImportTree`（每个文件走 `docToOutline`、每棵子树走 `markdown.markdownToTree` —— **建树仍然只有一处**，本文件不做任何格式解析）。**三条取舍**：① 每一级子目录都建容器节点（只取一层会把嵌套目录拍平或丢掉，与"镜像"相反）；② 文件节点标题取**文件名去扩展名**（文件名本身是文件夹结构的一部分，且与 `origin.src` 同构；文档自己的标题不丢 —— 它是文件节点的第一层子节点）；③ 文件节点各自带 origin（文件级幂等）+ 项目根带**目录清单指纹**（`makeDirOrigin`/`dirManifestSha256`，整库级幂等）。**跳过判据只有一处**（`entrySkipReason`，纯函数）：隐藏项 / 依赖目录（`node_modules` 这类）/ 符号链接（**不跟随** ⇒ 环不可能造成死循环）/ 空目录 / 无可导入文件 / 不支持的扩展名 / 无读权限 / 非普通文件 —— **逐类计数 + 逐条点名**，不许静默。**两个上限**：合计体积沿用同一份 `MAX_SOURCE_MB`（`describeDirOversize`），文件数 `MAX_IMPORT_FILES_DEFAULT`（`--max-files` 覆盖；`describeTooManyFiles`）—— 两条都在**读之前**判、都给可执行的出路。<br>⚠️ 两处只在整库导入才暴露的坑（都已在实现里堵住）：**没有任何标题的提纲**（纯 txt 笔记）在 `markdownToTree` 里会**全部落空**（它只在"当前节点"存在时收正文）⇒ 退到文件节点自己的 `detail`，不许丢内容；**中文主题会让 `idGen` 把 base 压成同一个 `n`** ⇒ 成百上千节点只剩时间+4 位随机在区分，同毫秒内会撞 id 而 schema 判"全树唯一" ⇒ `uniqueIdGen()` 兜底 | `detectFormat`/`textToOutline`/`docxParagraphs`/`docxToOutline`/`docToOutline`/`zipFindEntry`/`describeImportSourceProblem`/`directoryMessage`/`describeImportDirProblem`/`classifyStatFailure`/`normalizeOutline`/`outlineSha256`/`sourceRef`/`makeOrigin`/`makeDirOrigin`/`originMatches`/`originKey`/`describeOrigin`/`describeOversizeSource`/`describeOversizeBuffer`/`describeOversizeSize`/`MAX_SOURCE_MB`/`scanImportDir`/`buildDirImportTree`/`uniqueIdGen`/`dirManifestSha256`/`entrySkipReason`/`normalizeExtList`/`describeTooManyFiles`/`describeDirOversize`/`describeNoImportableFiles`/`groupSkips`/`skippedTotal`/`IMPORT_EXT_DEFAULT`/`IMPORTABLE_EXT`/`SKIP_DIR_NAMES`/`MAX_IMPORT_FILES_DEFAULT`；`UNSUPPORTED` 清单 |
| `pdf-text.js` | **PDF 文字层 → 行/段/标题层级的纯逻辑**（P0）：`TextItem[]` → 行（`LINE_FACTOR=0.2`）/ 段（`PARA_FACTOR=1.8`）/ 标题层级（三判据并行：**字号 ≥ 基准×1.15** / **居中且在本页前两个内容行内** / **无歧义中文编号且"孤立"**；正文基准字号按**字符数**取众数）；外加**文字层闸门**（单页 < 20 字符且页数 > 1 ⇒ 疑似扫描页）与最小页眉页脚剔除（首尾各 2 行的重复/页号形态）。**三条硬事实写进实现**：字号只能取 `transform[3]`（`TextItem` 没有 fontSize ✗）、字体只能用 `fontName`（Chromium 的 `styles[].fontFamily` 恒为 `"sans-serif"` ✗）、中文正则自己写（Calibre 只抄方法不抄代码 —— 它是 GPLv3 ✗）。纯函数：不做 I/O、不 await ⇒ 单测喂合成 items 即可（挂在小进程里被调用）| `buildOutline(pages)` → `{ok, reason, md, headings, paragraphs, lines, stats, notes}`；单项：`itemsToLines`/`linesToParagraphs`/`bodyFontSize`/`numbering`/`headingHit`/`assignLevels`/`assessTextLayer` |
| `related-model.js` | **「关联节点」可视化模型**（功能 2）：把 `assoc` 与 `relations` 的**两处既有结果合成**成一个可画的图 —— 成员并集、去重、每条边带"为什么相关"（哪篇关联笔记 / 哪条链接）。**不是** `relations.js`/`assoc.js` 的重复实现：那两个各算**一种**关系（且跑在 Node 侧），这个只负责**合并成显示用的图**并定口径（跨项目只标不画；成员 > `CLIQUE_MAX`(8) 时只画星形）。**它的输入是既有 IPC 的返回形状**，所以不新增任何后端逻辑 ✓ | `buildRelationModel({nodeId, project, assocItems, relatedItems})` → `{members, edges, crossProject, assocCount}` |
| `sidebar-context.js` | **⑨「送进 DSH 侧栏」的文本编排**（纯函数）：把选中的节点编成一段投喂文本（抬头写项目与个数、多节点逐个编号、带路径/标签/正文，正文按 `DETAIL_MAX`(600) 截断并**标明**截断）。**为什么单独成模块**：`renderer/*.js` 是 IIFE、node 里 require 不了 ⇒ 文本逻辑写在渲染层就**无法单测** ✗；放这里则渲染层（`<script>`）与 node 单测**共用一份** ✓。⚠️ 它只**编文本**，不发送、不碰 DOM ✓（发送由 renderer 调 `desktop.dsh.prefill` ⇒ 主进程 ⇒ 侧栏输入框；**不代替用户按发送** ✓） | `buildSidebarText(projectName, nodes)` → string；`DETAIL_MAX` |
| `drop-target.js` | **跨视图拖放（P7）的落点判定**（纯函数 ✓ 可单测）：屏幕坐标换算 `toScreenRect` + 命中判定 `isPointInSidebar` —— 侧栏是原生 WebContentsView，指针进去后渲染层收不到 mouseup ✗ ⇒ 由主进程轮询光标并用本模块判定"松手是否落在侧栏上" ✓；边界（未打开/零宽/坐标非数字）一律安全退化不误判 ✓。单测见 `tests/drop-target.test.js`。 |
| `path-chain.js` | **「路径 → 打开 / 预览」的判据 —— 唯一实现**（UMD 纯函数：**零 Electron、零 I/O**，渲染层 `<script>` 与 node 单测共用一份）。三段式：①**解析**（原始输入 → 规范绝对路径 `abs`）②**判据**（`{ok, abs, reason, action, code, kind}`，`action ∈ {preview, system, external, reject}`）③交给**唯一出口** = 既有 IPC `app:open-file`（**不新开 IPC 名字** —— 外部链接出口批只给它**多收一个可选参数** `opts.kind`，候选表 `EXIT_KINDS` 仍只住在本模块 ⇒ "哪几档能到出口"也只有一处表达）。**六条判据**：**禁 `..` 逃逸**（规范化后必须仍在当前项目目录**之内**）· **禁 UNC / 设备路径**（`\\?\`、`\\.\`、`\\server\share`、`//host/share`；**只按形状判、零 I/O** —— 本机 `X:` 是不可达映射网络盘，一句 `existsSync` 要 9–21 秒）· **打不开必须带非空 `reason`**（文案单源 `REASONS`，调用方只显示、不自拼）· **`localPath` 单开一档**（工作区外的绝对路径，**只校验形状**，**不许**拿"在项目内"卡它）· **`action` 与改动前逐条等价或更严**（绝不更松）· **`http(s)` 只放行、别的协议一律拒**（`kind:'externalUrl'` 那一档：`new URL()` 解析 → 协议**白名单**只放 `http:`/`https:` → 拒带凭据；`file:`/`javascript:`/`data:`/`vbscript:`/`blob:`/`aimm:` 与畸形串**全 reject + 非空 reason**，`action:'external'` = 交系统浏览器 —— 外部链接出口批新增，见 §4b ADR「路径解析 / 授权链：判据唯一实现、出口唯一」那一行）。改动前这件事**散在渲染层四处、判据各不相同**（`attachmentAbsPath` 零校验的字符串拼接、预览头两处各自分档、`openLocalPath` 原样透传、图片区另一行拼接）⇒ 现在四处只**调**它。授权主体 = **当前项目**；与内置 DSH 的 `dsh-resource://file/session/<id>/<path>`（主体 = Session）**同形不同主体**，见 §4b ADR。**判据不许有存在性探测**（那条既是性能红线也是"环境问题不当数据问题"的既有口径） | `decide({kind, raw, project, force})` → `{ok, abs, reason, action, code, kind}`；`rendererUrlOf(project, raw)`（页面相对地址，**唯一一处**）· `projectDirOf` · `extOf` · `normalizeForJudge`；取值表 `KINDS` / `ACTIONS` / `PREVIEW_EXTS` / `REASONS` · **`EXIT_KINDS`**（出口能收哪几档）/ **`ALLOWED_URL_PROTOCOLS`**（URL 协议白名单，唯一一处） |
| `feedback-candidates.js` | **「本地信号 → 反馈选项」的唯一实现**（UMD 纯函数：**零 DOM、零 I/O**，渲染层 `<script>` 与 node 单测共用一份；消费者两处 = `renderer/app-ask.js`（只薄转发）与 `tests/feedback-candidates.test.js`）。**为什么必须搬出渲染层**（五星评价批的独立验收实测）：冒烟域 50 的 ② 做的是"DOM 选项 × 产品纯函数现算"对拍，而**两侧同源**（两侧都调同一个函数）⇒ 改坏纯函数时两侧一起变、比对**恒等** —— 实测把候选改成固定写死之后域 50 **全绿（漏过）**，只有把写死挪到"真正生成 DOM 那一跳"才红 ⇒ **② 只守得住"DOM 照纯函数画"，守不住"纯函数自己的语义"**，后者只能由 node 侧夹具单测守（期望值手算、不调产品同一个函数）。**四个信号**：`len`（长度档：短 / 长两个边界）· `kind`（解释\|问答）· `code`（围栏代码或行首命令）· `mapWrite`（已落进导图）；**候选**每条 `{text, signal}` 指回产生它的信号名，stars 高档出"满意"措辞、其余出"不满意"措辞，顺序固定 len→kind→code→mapWrite。⚠️ **上限当前不可达**（信号集最多点亮 4 条 == 常量上限）⇒ 单测只断言"不超过上限"，**不**断言"截断生效"（那是恒假判据） | `collectAnswerSignals(entry, st)` → `{len, lenBucket, kind, mapWritten, hasCode}` · `deriveFeedbackCandidates(sig, stars)` → `[{text, signal}]`；取值表 `ASK_FB_MAX_CANDIDATES` / `SIGNALS` / `LEN_SHORT_BELOW` / `LEN_LONG_ABOVE` |
| `editor-candidates.js` | **「在编辑器里打开」的判据 —— 唯一实现**（UMD 纯函数：**零 Electron、零 I/O**；`main.js` 与 node 单测共用一份）。为什么要有：应用侧那条打开链（`app:open-file` → `shell.openPath`）**原本完全不知道编辑器存在** —— 本机实测 `.js` 的关联是 `WScript.exe`，于是"交系统打开"实际是**执行脚本** ✗。**两档必须分清**：`jump`（有 CLI，且**它的 `--help` 自己声明** `--goto <file:line[:character]>`）＝「可打开并跳到第 N 行」；`open`（只有 exe / 只有 URL scheme / CLI 起不了）＝「**只能打开**（跳不了行）」，界面按 `TIER_TEXT` 显示、**绝不让用户以为跳了**。**判据三条**：① 行号只认正整数（`0`/负数/垃圾 ⇒ **不带行号**，不编造第 1 行）② 参数一律 **argv 数组**（`['--goto', '<abs>:<line>']`），**全程不拼命令行字符串**（注入面 0）③ URL scheme 目标**恒标 `jumped:false`**（本机实测：`cursor://` / `trae-cn://` 都**注册了**，但"带行号会不会真跳"**没有读数** ⇒ 不许拿它冒充跳行）。**危险关联分档**（第 3 件）：`assoc-exec`（命令行指向 `wscript`/`cscript` ⇒ 会**执行**）与 `assoc-media`（ProgId 形状 = 应用抢注的媒体类型：`AssocFile` 前缀 或 以 `.TS/.MP4/…` 结尾，实测本机 `.ts` → `PotPlayerMini64.TS`）**都判 `block`**（不放行给系统）；`assoc-none` 判 `note`（放行但要说）。**判据为什么用"形状"而不是播放器名单**：名单永远列不完（第一版只认 `wmplayer.exe`，本机 `.ts` 关联的是 PotPlayer ⇒ 漏判，被单测与实测各抓一次）。**"用户选的是哪个"由 `main.js` 记在 `<userData>/editor-prefs.json`**（**唯一写者 = main.js**；不用渲染层 `localStorage` —— 那是冒烟域 50 结构断言在守的规则） | `choose(candidates, preference)` → `{candidate, why, stalePreference}`（**用户偏好优先**；偏好失效**不静默**：带 `stalePreference` 出来）· `commandArguments(candidate, abs, line, col)` → `{file, args[], jumped}` · `schemeTarget` · `parseGotoSupport(helpText)` · `normalizeLine` · `assocHazard(command, progId)` / `hazardText` / `hazardLevel` / `summarize` / `layoutOf` / `byExeName` / `exePathFromCommand`；取值表 `TIERS` / `TIER_TEXT` / `HAZARDS` / `CATALOG` |
| `editor-probe.js` | **编辑器候选的运行时探测**（只有 I/O；判断在上一行那个模块）。**四个来源、结果取并集**（**由强到弱**，每条带 `found` 出处）：`path`（`where`）> `registry-scheme`（`HKCU/HKLM\Software\Classes\<scheme>\shell\open\command`，**协议处理器**）> `app-paths`（`…\CurrentVersion\App Paths\<exe>`）> `known-dir`（常见落点，**最弱**）。⭐ **为什么必须四路都探**：本机实测按"常见落点"探会得到「Trae CN 没装」（**假**），而注册表 scheme + `D:\Program Files\Trae CN\` 都在 ⇒ 只留一条路就漏人。**"能不能跳行"怎么判**：跑一次该 CLI 的 `--help`（形态 = `"<dir>\<Name>.exe" "<dir>\resources\app\out\cli.js" --help` + `ELECTRON_RUN_AS_NODE=1` —— 实测这是**唯一**拿得到 stdout 的起法，`*.cmd` 包装脚本会吞输出 ✗），交给 `parseGotoSupport` ⇒ **拿产品自己的输出当读数**，编辑器升级改了参数就自动降级成 `open` 档。**去重按编辑器 id**（不是按路径 —— 本机实测 Cursor 会从 `path` 与 `registry-scheme` 各进一次，按路径去重会让界面出现两行「Cursor」）。**每一处"没成"都记账**（`errors[]`：help 跑不通 / 没有 `--goto` / 注册表指向的 exe 不在盘上 …），不静默。**只读**：全程只有 `where` / `reg query` / `--help` 三类调用与 `existsSync`。探测结果**进程内缓存 5 分钟**（每条 CLI 一次子进程，实测本机整轮 ≈ 3.7 s ⇒ 不能每次打开都重探） | `probe({force, io, extensions})`（带缓存的入口）· `probeWith(io, opts)`（**I/O 全注入 ⇒ 可单测/可喂假读数**）· `resolveCli(io, def, hitPath)` · `defaultIo()` · `reset()`；`EXTENSIONS` / `TTL_MS` |

| `version.js` | 版本号纯逻辑 | `isValid`/`parse`/`bump`（低位归零）/`compare` |
| `html-whitelist.js` | **「正文 HTML 子集」白名单表的唯一一份**（UMD 纯数据 + 纯判定：**零 DOM、零 I/O**）。为什么单独一个 `src/` 模块而不写在渲染层：这张表有**三个消费者、分属三层** —— ①消毒 `renderer/sanitize.js`（先解析成 DOM 再遍历删，绝不用正则）②语料读数 `scripts/detail-census.js`（"这段 detail 有没有 HTML 结构"的量具，它的 `TAG_RE` 就取自本模块）③`src/convert.js` 的行内链接/图片（**URL scheme 那一档**：`markdownToHtml('[x](javascript:…)')` 一度会产出**活的** `href`）⇒ 放 `src/` 是唯一能让三层都 `require` 到、又不破单向依赖（S1）的位置。档位 = 用户 2026-10-16 拍板的 **A 档**：允许 `details/summary`、`table`、`img`、`a` 与常用排版标签；**禁** `style` / `on*`（按**前缀**判，不枚举）/ `script` / `iframe` / `svg` / `form` / `meta` / `base` / `object` / `embed` / `template`。**两个 CSP 真空档必须自己顶住**（① `style-src 'unsafe-inline'` 放行 `<style>` 与 `style=`；② 未声明 `frame-src` ⇒ 回落链 `frame-src → child-src → default-src` 吃 `default-src … data:`）**外加 CSP 管不到的两处**（`<meta http-equiv=refresh>` 能导航、`<base>` 能劫持相对地址）⇒ 四类都**有名有姓**地列在表里，不是"反正不在白名单里"的副作用。URL 档：`a` 放行 `http/https/mailto` 与站内 scheme `aimm:`；`img` 放行 `https/file/data` + 工程内相对路径（**明文 `http:` 图**拦下并给可见占位 —— 2026-10-16 用户裁决只放宽 `https:`，`renderer/index.html` 的 `img-src` 同批加 `https:`，其余 CSP 档一律不动） | `classifyUrl(raw, where, mode)`（`'render'` / `'convert'` 两档放行名单）· `parseAimUrl` · `attrAllowed` / `isEventAttr` / `isAllowedTag` / `isDropTag` / `isMermaidLang` · 取值表 `ALLOW_TAGS` / `DROP_SUBTREE_TAGS` / `ATTR_ALLOW` / `DATA_ATTR_ALLOW` / `SCHEME_ALLOW` / `REASONS` / `TAG_RE` |
| `changelog.js` | CHANGELOG 的发版变换（Node 侧纯逻辑） | `releaseChangelog(text, next, date)`：按**段落边界**改写 `[Unreleased]`（早期两次 `String.replace` 写法会把段首占位行带进版本段）；无变更内容时拒绝发版 |
| `config.js` | 常量（版本/默认值） | `MMConfig`（`APP_VERSION` 是版本号单源） |
| `changes.js` | **变更日志的纯逻辑**（无 I/O）：构造/序列化/解析条目、分配单调 `rev`、有界窗口裁剪、`since` 判定（**"答不了"与"没有变更"必须可分辨**）、按对象归并 | `buildEntry`/`serializeEntry`/`parseLog`/`appendLog`/`since`/`groupByObject`/`lastEntry`；文件名与上限在此定义（`FILE_NAME`/`MAX_ENTRIES`） |
| `heat.js` | **访问事件日志 + 两条热度（人 / AI）的派生**（热度条第一件 + 第三件）：通道权重表、窗口、名次→档位、事件格式、O(1) 追加、尾部窄查询 —— 各自**只有这一处**；第三件起另含**单节点读数**（`heatProfile`：界面两条热度条显示的那一份）与**AI 侧隐藏维度**（`derivedHeat`：标签 / 章节 / 节点树，**全部由节点热度派生**，不是各记一套；每个维度自带 `nodes/visited/events` 样本量，界面不显示） | `CHANNELS`/`channelInfo`/`buildEvent`/`serializeEvent`/`parseEvents`/`computeHeat`/`heatFromRank`/`heatProfile`/`derivedHeat`/`appendEvent`/`readTail`/`readHeatFile`；文件名与各上限在此定义（`FILE_NAME`/`WINDOW_DAYS`/`HEAT_BANDS`/`MAX_READ_BYTES`/`DIM_TOP`） |
| `heat-sensor.js` | **访问埋点的唯一实现**（热度条第三件·C）：把"这次命令真的返回了哪些节点"折成"每条通道每次调用最多记几行"的一次日志追加 —— 上限口径（`LOG_MAX_PER_CALL`）、去重、未知通道、写失败**只在这里定义一次**（`cli/core.js` 的 `ctx.recordVisit` 与 `main.js` 的 `app:visit` 都调它，命令层与渲染层都不自己写盘）。三条纪律：**只追加**（经 `heat.appendEvent`，不读日志、不读项目文件）、**不改输出**（一个字节都不往 stdout/stderr 写；`cli/main.js` 在命令体跑完后统一把失败**响亮**报出）、**不阻断**（写失败如实 `dropped`/`errors`，不掐死读路径） | `recordVisit(file, channel, nodeIds, opts)`；`LOG_MAX_PER_CALL`；开关 `MM_HEAT_SENSOR=off` 与 `__setEnabledForTest`（**只给测试**，生产代码不引用 —— 由单测机械盯着）。⚠️ 日志落在 `<项目根>/.visits/<项目名>.jsonl`（**项目目录之外**，路径的唯一推导处是 `data-store` 的 `visitLogFile`）：项目目录内"只读路径零字节"是本工程硬挣来的不变量 |
| `data-store.js` | 项目文件读写（Node 侧） | `createStore(rootDir, validate)`：list/read/write/assetDir/attachmentDir/**writeFileAtomic**；`write` 在 `expectVersion` 不符时抛 **`code='VERSION_CONFLICT'`**（错误码单源在 `concurrency.js`，调用方**只认码不认文案**），成功时回传 `{file, version}`；**每次写入顺带记一条变更日志**（`recordChange`，实现只有一份，GUI 保存那条路径也调它） |
| `concurrency.js` | **并发编辑的"可安全重放"核心**（纯逻辑，无 I/O） | `fingerprint(data)`（逐 `node:<id>` / `children:<父id>` / `assoc:<id>` / `meta` 指纹）/ `changedKeys(a,b)` / `intersection(mine,theirs)` / **`withReplay(io, fn, opts)`**：两路改动**不相交 ⇒ 自动重放到最新版**（双方改动都保留）；**相交 ⇒ 指名拒绝**（绝不静默覆盖）；`replayable:false` 供不可重复执行的动作用 |
| `dsh-package.js` | DSH 独立运行包的解析/校验/安装/回滚（v0.16，Node 侧） | `validateRuntime`（全量哈希）/`resolveRuntime`（bundled/installed，坏状态**报错不降级**）/`installRuntime`（幂等导入+原子切 active）/`rollbackRuntime`/`acquireRuntimeLock`（运行锁/维护锁互斥） |
| `dsh-ask.js` | **向内嵌 DSH 提一个一次性问题**（功能 1 的后端，Node 侧）：走运行包自带的 `dsh headless "<prompt>"`（实测退出码 0 / 极简提示词 **4.4 s** / stdout **只有答案一行**）；**提示词构造是纯函数**（`buildAskPrompt`：自动补齐项目/路径/正文/相关节点 ⇒ 这是"AI 收到什么"的唯一定义处），运行器的 `spawn` 可注入 ⇒ 单测能验参数与环境而不真起进程。失败**绝不当成功**：非 0 退出 / 空输出 / 超时都是 `ok:false` 并带原因 | `buildAskPrompt`/`buildContextBlock`/`buildAskArgs`/`buildAskEnv`/`resolveAskRuntime`/`askOnce`；`KINDS`={explain,ask} |
| `dsh-capabilities.js` | DSH 能力边界（纯逻辑：解析装配清单 + 合成模型） | 支撑 `dsh-caps` 命令：回答"某能力到底挂没挂载"，防"以为不具备其实有"与反向误判。**装配面的发现口径（2026-10-19 修，`385767e` 实测发现）**：host 平面 = 凡带 `cordis.patch.yml` 的包（实测 **9 套并列 bundle**）；agent 平面 = `@deepseek-ai/<包>/presets/` 下的 `.patch.yml`（实测 1 个载体 `dsh-web-app` / 4 个 preset 文件 ⇒ 4 层）。⚠️ **这里曾是一条恒空的发现路径**：写死 `dsh-agent-presets/presets/<name>/agent.cordis.yml` —— 那个包在发行包里**不存在**，且真实形态是**平铺文件、没有子目录** ⇒ `fs.existsSync` 恒假、`if` 里**静默跳过** ⇒ `kind:'preset'` 层**一次都没出现过**（修前实测 0 层）。代价不是"少一层"：本模块顶部的核心叙事「host 行 `disabled: true` **≠ 不可用** —— preset 会把同一 id 重挂」因此**读者无法观察、无法核对**（"声称能做到、实测是另一回事"这一类病）。现在三件事同时成立：① 找不到 preset 平面 ⇒ **报错退出**，不出"preset 平面为空"的报告；② 文本报告末尾印出「host 按 id 算 `disabled: true`、某个 preset 又把它挂回来」的实例**连同两处行号**（实测 20 个；例 `agent-instructions` = `dsh-web-app/cordis.patch.yml:546` ⟶ `presets/standard.patch.yml:16`；口径：**按 id** 配对、只沿 `dsh-base → 载体包` 一条序列算有效状态、**preset 那一行自己也得是启用的**（两边都 `disabled: true` 是"两边都关"，不是重挂 —— 实测有 `tool-ralph` 这一档，只按 id 配对会把它算成实例）、`disabled: !!js …` 的表达式行**不算**，因为运行期才知道）；③ 判据 `tests/dsh-caps-preset-plane.test.js`：preset 层数 > 0 **且 == 独立磁盘扫描出的文件数**（判别力：把发现路径改回那个不存在的包 ⇒ 层数 0 ⇒ 必红；证据 `.review/20261019-preset平面/inject-red.txt`）；④ **per-layer `disabled` 不再漏「纯 id 覆盖行」（2026-10-19 修）**：有一类行**只有 id、没有 `name`**（`- id: X` + `disabled: true`，patch 语义：按 id 覆盖上游那一行），旧实现只按「带 `name:` 的行」归属包 ⇒ 这类行的 `disabled` **整条记录都不进 `packages[].layers`**（不是读成 `false`，是**消失**）；实测 **40 行**（其中 **33 行**自带 `disabled`），`dsh-web-app` 一层就 **24 行** ⇒ `dsh-compaction-basic` / `dsh-agent-instructions` 在 **`dsh-web-app` 层 `disabled: true`** 这件事在输出里**完全看不到**，而读报告的人会据此认为"该能力在 host 层是启用的"（它其实被关着，只是 preset 又挂回来了）。现在按**装配序列**归属（`assemblySequenceOf`：`dsh-base` → 载体包 → 本层，找到该 id 的 **`name:` 声明行**，那个包才是它该落的包）；**推导唯一性（现算，不是假设）**：216 个有 `name` 声明的 id、**没有一个**被 ≥2 个不同包声明过，40 行纯 id 行在三种口径（只看本层之前 / 整层 / 全仓不分层序）下**读数完全相同**（40/40 唯一）⇒ 真实装配面上不需要猜；但"现在唯一"≠"永远唯一"，`packageOfRow` 在 `no-declaration` / `ambiguous` 时**返回 `null` 并给出全部候选**，`buildModel` 记进 `idUnresolved` 且报告**逐行点名**，**不猜一个候选**（与 `expr` 三态同一条纪律）。判据 `tests/dsh-capabilities.test.js`：`packageLayers` 与**裸读 yml 独立算出的 (包, 层) `disabled`** **逐条相等**（实测 338 条）。判别力：注入「把纯 id 行的 `disabled: true` 丢掉」⇒ **28 条值错、必红**；注入「归属退回只认 `name` 行」⇒ **35 条层缺、必红**；两次都原始 Buffer（`32900 B / sha256 44b568a218… / CR 0`）三记还原 ⇒ 复绿（证据 `.review/20261019-caps-id-override/`）。`cli/commands/release.js` 的 `findRemounts` **保留**（它判的是 **per-id** + 两处行号 = **20** 个实例；包级 `packages[].layers` 只能给出 **18** 个包 —— `tool-subagent`/`tool-subagent-fork` 与 `tool-subagent-control`/`tool-subagent-list-agents` 各并成一个，且判不出"preset 侧自己也是禁用/未知"那 4 个包），但它内部**不再自己写**序列/载体包推导，改取本模块的 `assemblySequenceOf` / `presetCarrierOf`（H1） |
| `dsh-sidebar-skill.js` | 侧栏 AI 的**指针 skill 内容生成**（纯函数） | `buildSidebarSkillContent(projectRoot)`：应用孵化内嵌实例时写入 `dsh-home/skills/ai-mind-map/SKILL.md` |
| `panel-geometry.js` | **主窗口「右侧让位带」几何的唯一计算处**（UMD 纯函数：**零 Electron、零 I/O**，node 单测直测；消费者只有 `main-dsh-sidebar.js` 的 `relayout()` 一处）。为什么单独成模块：那段算术原本内联在 `relayout()` 里，**要先起 Electron 才跑得到** ⇒ 每条不变式只能靠冒烟"起窗口看读数"守；第 4 个原生面板（停靠面板）把它从 2 个矩形变成 3 个，再不搬出来就会变成"每加一次业务就改一次判据"。**形态 = 右侧二阶并列**：`[页面][停靠面板][控制栏 30][DSH 侧栏]` —— 侧栏（含控制栏）**继续锚在窗口右缘** ⇒ 既有拖宽协议（`newWidth = 窗口右缘 − 光标`）一个字节不用改；页面让位仍是**一维的一条横带**（`--dsh-sidebar-width` = 三段之和）⇒ 既有 5 处 CSS 消费者（`#main` margin / `#toolbar` padding / `.overlay` 与 `#lightbox` 的 `right` / `.dialog-box` 的 max-width）全不改就正确。**为什么不选另两种**：改停**下缘**会让让位变二维（横向 + 纵向），且 `position:fixed; inset:0` 的浮层会直接盖住下缘面板；**互斥**（开面板就收起侧栏）会逼出一台"谁拥有右侧带"的状态机（侧栏有服务驻留/偏好/可见性一整套生命周期），且杀掉"一边对话一边看面板"这个主要用法。**三条不变式**（判据在 `scripts/smoke/22-sidebar-gap.js` 那条**追加**断言里独立复算，不调本模块 ⇒ 避免两侧同源）：① 贴接 `panel.x+panel.width == rail.x`；② 锚右 `view.x+view.width == 窗口内容宽`；③ 让位守恒 `occupied == panel + rail + view`。**夹取优先序**：面板是次要方 —— 先按自己的 min/max 夹，再让位给**页面地板** `pageMinWidth`（400），夹到就如实记 `clamped {want, got, reason}`，绝不静默挤。**侧栏收起 ≠ 面板收起**：面板独立停在窗口右缘（它是容器，不是侧栏的子状态）。⚠️ `railWidth` **本模块不给默认值**（唯一真源仍是 `main-dsh-sidebar.js` 的 `RAIL_WIDTH`）；面板的 min/默认/max 与页面地板才是本模块的 `DEFAULTS`（取值推导写在文件头：最小窗 960 − 侧栏下限 280 − 面板下限 260 = 420 ⇒ 地板取 400）| `DEFAULTS`（`panelMinWidth:260` / `panelWidth:360` / `panelMaxWidth:720` / `pageMinWidth:400`）· `computeGeometry({winWidth,winHeight,sidebarVisible,sidebarWidth,railWidth,dshOnly,panelOpen,panelWidth,...})` → `{rail, view, panel, sidebarBandWidth, panelWidth, occupiedWidth, pageWidth, clamped, notes}` |
| `change-log.js` | **「AI 改了哪些文件」清单的唯一实现**（第 4 面板的第一份业务内容，2026-10-18 第 2 批 a76bab32）。**为什么需要它**：内核 `dsh-workspace-changes` 会算"本回合改了哪些文件"，但它 ① **子代理会话一律不录**（`origin === 'subagent' \|\| (delegationDepth ?? 0) > 0 ? undefined : cwd`）② 摘要是 **Host 内存态**（`session/disposed ⇒ forget`，重启后 `404 Change summary unavailable`）。本模块补的正是这两条 —— 靠的是**换数据源**：读 **git working-tree 快照**，与"谁写的"无关 ⇒ 主会话 / 子代理 / 外部编辑器 / 别的进程一视同仁，且不要求 DSH 在跑。**三条不选的理由**（都写进模块头）：② 工具写入事件活在 Host 进程里（要收它得当 DSH 插件 ⇒ 碰"不 fork 内核 / 不手改 `cordis.patch.yml`"）、且是会话内瞬态（重启就没了）；③ 我们自己的写盘出口只覆盖"我们写的那几类受管资产"，对"AI 改了什么"覆盖率≈0。**度量口径必须与内核分得清**：内核 = turn 起点树→终点树（"本回合"），本模块 = **HEAD→采样那一刻**（"累计未提交"）⇒ 界面逐字标注，绝不冒充。**三条实现纪律**：① **唯一写者**——`createStore().record()` 是唯一落盘处，且只经 `src/data-store.js` 的 `writeFileAtomic`（本模块里 `writeFileSync(` / `appendFile(` / `renameSync(` **一次都没有**，单测钉住）；② **只增 ≠ 不设界**——记录只追加不改写，但有界窗口 `MAX_RECORDS`(400)，裁剪时**保住每个文件的最新一条**（否则一个早先改过、之后没再动的文件会从清单里凭空消失）；③ **采不到 ≠ 没有改动**——`readSnapshot` 的 `source` 分四档（`git` / `no-git` / `no-repo` / `error`），空 `rows` 才表示"真的没改"。**没有 HEAD**（刚 `git init`）时 `git diff --numstat HEAD` 会 exit 128 ⇒ 行数走"文件行数"回退档并**记一笔口径变化**；**未跟踪的二进制**按前 8000 字节嗅探 NUL 判二进制（行数留空，不许拿 utf8 数出一个捏造的数字）。**追溯**：三条 git 命令的 argv 是本模块的 `GIT_ARGV` 单源，界面照它印出来 ⇒ 读数可原样重跑对拍 | `GIT_ARGV` / `GIT_ENV` · `readSnapshot({root, runGit?, readFile?})` → `{ok, source, repoRoot, head, rows, notes, bad, git}` · `createStore({file, writeFileAtomic})` → `{read, record, reading, status}` · 纯函数 `parseStatusZ` / `parseNumstatZ` / `mergeRows` / `planAppend`（去重 + 冲销 + 有界窗口）/ `compact` / `summarize`（界面要显示的那一份，含 `unit`/`unitText`/`trace`）/ `latestPerPath` / `recordKey` · 常量 `FILE_NAME` / `MAX_RECORDS` / `SAMPLE_MIN_INTERVAL_MS`(1500) / `COUNT_MAX_BYTES` / `COUNT_SNIFF_BYTES` / `STATUS_TEXT` / `SRC_TEXT` |
| `dock-panel-page.js` | **第 4 原生面板的页面本体**（`main-dsh-sidebar.js` 只留一行 `dockPanelPageHtml() { return dockPanelPage.dataUrl(); }`）。**为什么单独成模块**：页面里那段 JS **只有真起一个 `WebContentsView` 才会被解析** —— 写完不跑冒烟时，一句语法错的表现只是"面板一片空白"，没有任何判据会红（本批第一版就是被这个坑咬过：页面 JS 里嵌了 ASCII 双引号，把宿主那层字符串提前截断）。搬进 `src/` 之后 node 单测能直接 `new Function(scriptOf())` 解析它 ⇒ 语法错在 G3 就红。**它只做三件事**：画清单、**把口径逐字说出来**（"相对 HEAD 的累计"）、**把"我画了几行"回传**（`[mm-changelog:rendered]`）；**不做任何算术**（行数/合计/去重全在 `change-log.js`），也**拿不到 fs / IPC**（沙箱 + 无 preload ⇒ 它连"自己去读那个 jsonl"都做不到）。**四种结局分开说**：`ok` / `empty`（真的没改）/ `no-git` / `no-repo` / `error`（响亮报错 + 原因，**绝不给空清单**）。**安全面**：一律 `createElement` + `textContent`，页内**零 innerHTML** ⇒ 文件名里的 `<`、`&`、`</script>` 不可能是结构 | `pageHtml()` / `dataUrl()`（**唯一**拼 `data:text/html;charset=utf-8,` 前缀处）/ `scriptOf(html?)`（单测语法闸门用）/ `MARKERS`（`req` / `reqForce` / `rendered` / `close` —— 与主进程分派**同一份真源**）/ `LINES` |
| `ui-state.js` | 「界面有未保存编辑」的跨进程协调信号（纯逻辑 + 文件契约） | 读写 `projects/<项目>/.ui-state.json`，支撑"写前协调"（CLI 侧 `ui-state` 命令读它） |
| `control.js` | **界面控制通道**（纯文件读写，不 require electron） | userData 下 `control/` 三态目录：`pending/<token>.json`（命令）→ `consuming/<token>.json`（`rename` **原子认领**）→ `done/<token>.json`（回执）；界面每 400ms 轮询执行一次。**多槽 + 序号（v2）**：文件名就是 token ⇒ 两个 CLI 同时下命令**各有各的槽**（旧单槽实现里后写的会把先写的覆盖掉，先写那方永远等不到回执 —— 多 AI 会话同时用一个界面是本工程常态，不是理论风险）；认领靠 `rename`（只有一个赢家）⇒ 同一条命令**至多**被派发一次（旧实现的"清命令"要等异步工作做完，400ms 轮询在这中间会再读一遍并**重复派发** `dsh-prefill`）。三个状态用路径表达而不是"已消费"标记文件：标记要"读标记 + 写标记"，本身又是一次竞态。为什么不用 socket/命名管道：本机受限环境禁命名管道、网络要走代理 —— 文件是唯一到处都成立的通道。CLI 侧 `sidebar-only` / `dsh-sidebar` / `dsh-prefill` 都靠**自己那个 token** 的回执判"真生效"（按命令名认回执时，两条同名命令并发会互相吃到对方的回执）；**两个方向各关一半**（关左页留侧栏 / 留主界面关侧栏）⇒ 改一侧不必重启整个应用。**慢命令的调用方先探活**（用只读的 `dsh-status` 问一句）再下慢命令 —— 否则"界面没在跑"与"界面在跑但慢"分不开（见 §2.2 `commands/ui.js`） |
| `control-poll.js` | **界面侧的轮询消费器**（纯逻辑，不 require electron ⇒ 可单测） | `createControlPoller({dir, handle, log})` → `{pollOnce, maybeSweep, start, stop, dispatched}`。从 `main.js` 抽出来的理由：那两个缺陷（重复派发 / 单槽覆盖）都长在那段内联轮询上，而它要 Electron 才能加载 ⇒ **从来没有单测**，偏偏"两个进程同时下命令""一条慢命令跨好几拍"是跑一次看不出来的竞态。契约：`pollOnce()` 扫一遍 pending，**认领后**交给 `handle(claim, reply)`；返回本次真正派发的 token 数组；`handle` 可以返回 Promise（慢命令）—— 派发与收尾分开，收尾由 `reply` 回调完成（**必须**调，否则就是欠调用方的回执 ⇒ 调用方超时判失败，那是**可见**的失败不是静默通过）。`sweep` 清孤儿认领位/超量 pending/过期回执，**如实告警**不静默丢 |
| `qa.js` | **AI 问答落盘的两处文本形状**（纯函数、无 IO；功能 1 的下半截） | `entryOf`（造 `{q,a,at,model?}` 记录）/`appendToDetail`（把带**来源标记与时间**的问答追加到 `detail` 末尾，HTML）/`deriveTitle`（子节点标题取回答首个非空行并截断）/`childNodeOf`/`fmtAt`/`escapeHtml`。为什么必须是**唯一实现**：否则界面与 CLI 各写一套 —— 迟早出现"界面追加的没有来源标记""两边时间戳格式不同"（本工程的"同一事实两处表达"病）。为什么**追加**而不是覆盖：问答是流水，第二次写入抹掉第一次 = 把 AI 产出变成"只有最后一次"（最重的损害类别：静默丢失） |
| `item-model.js` | **条目层 v3 的模型核心**（UMD，纯函数：无 I/O、不读盘、不读时钟）——存在的唯一理由是 `detail` 必须能由 `items` **逐字节**重建：`renderDetail(parseDetail(detail)) === detail` 是 v2→v3 迁移的**准入门槛**，回放不了就返回 `null` 哨兵 ⇒ 那个节点**整块跳过**（一个字节都不动），绝不"修一下再写"（内容悄悄变质是本工程最重的损害类别）。切分口径 = **内容层顶层块**（`<li>` ⇒ `type:'text'`，其余块 ⇒ `type:'rich'`；`<ul>`/`<ol>` 外壳是"该组条目共有的容器"，逐条记住才能保渲染保真，也才定得了并发粒度 —— 见 `docs/ITEM-MODEL.md` §8）。`type:'qa'` 的正文**调用** `src/qa.js` 的 `appendHtml(item.qa)` 渲染，**不复制**那段逻辑（契约 `docs/ITEM-MODEL.md` §5.1，已冻结） | `parseDetail(html, opts?)`→items / `renderDetail(items)`→html（幂等；`[]` ⇒ 空串） / `validateItems(items)`→errors（字符串数组，空 = 合法，**只判单个节点**） / `newItemId()`→候选 id（**全项目**唯一性由调用方查重）；另加装配点 `itemizeNode(node)` 与结构助手 `itemsWithContainers(items)`（只读，给并发合并逐条挑来源） |
| `item-index.js` | **条目级索引 / 检索 / 取回**（UMD 纯逻辑，无 I/O）——这一类事实的**唯一实现处**：命中形状、snippet 与预算的**全套常量**（snippet 上界 / `--limit` / `--max-bytes` / token 估算口径；契约 §3.4 明写"本文不抄数值"⇒ 命令层、文档、测试里都**不许**再写一份数字）、条目视图（§3.1）、`get` 的条目摘要数组（§3.3）、`qa` 的派生化（§7）。三条纪律：① **不落盘**（只读查询不生成索引文件，只在内存建一次、`opts.indexes` 传给批量查询复用，照 `src/relations.js` 先例）；② 纯函数（不改树、不读盘、不读时钟 —— `--since` 只比较给定的时间串）；③ 本模块**不认识"项目名"**，顶层 `{project}` 由命令层附加（照 `src/query.js` 的 `computeStats` 先例）| `buildIndexes(root)` / `findItem`；检索与取回 `searchItems` / `getItemView` / `readItemsView`；视图 `itemView` / `itemSummary` / `qaFromItems`；选项解析 `parseFlag` / `parseSince` / `parseType` / `normalizeItemIds`；常量 `SNIPPET_MAX` / `DEFAULT_LIMIT` / `LIMIT_MAX` / `DEFAULT_MAX_BYTES` / `MAX_BYTES_MAX` / `BYTES_PER_TOKEN` / `MATCH_IN` / `TYPES` / `RESUME_ADVICE` |
**加载顺序**（与 `renderer/index.html` 里实际的 `<script src>` 顺序一致 = 依赖顺序）：
`vendor/jsmind.js` → `history` → `tree-utils` → `schema` → `convert` → `config` →
`palette-rank` → `related-model` → `sidebar-context` → `mindmap-adapter` → `app-core` →
`app-view` → `app-detail` → `app-detail-drag` → `app-detail-content` → `app-media` →
`app-actions` → `app-audit` → `app-palette` → `app-assoc` → `app-related` → `app-ask` →
`app-import` → `app.js` → `editor.js` → `contextmenu.js`。

> ⚠️ 上面这一行是**快照**：唯一的定义在 `renderer/index.html` 的 `<script src>` 顺序里，
> **改加载顺序只改那里**；发现两边不一致时以 `index.html` 为准（2026-10-09 更正：
> 本节此前漏列 `related-model` / `sidebar-context` / `app-related` / `app-ask` / `app-import` 五个模块）。

> 注意：渲染层**不加载** `src/assoc.js`／`src/links.js`。`assoc` 的增删改只经 CLI（渲染层只展示与编辑
> 标题正文，删节点时的清理走 IPC → CLI），链接剪枝同理 —— 所以渲染层不需要这两个模块的纯逻辑，
> 也不该自己复制一份判定规则。

### 2.4 主进程（main.js / preload.js）
- `main.js`：窗口、菜单（文件/编辑/视图/帮助）、IPC 处理器、`--smoke` 冒烟驱动器、
  **项目文件监听**（`project:watch`：fs.watch 300ms 防抖 → `project:disk-changed`，
  支撑「边聊边编辑」的界面实时同步；**窗口获得焦点**时另做一次**只读**指纹比对，
  落后就**复用同一条事件**——`fs.watch` 只在写盘那一刻触发，人可能还没回到窗口）。
- `main-dsh-sidebar.js`：**DSH 侧边栏**（v0.16）——运行包解析、子进程孵化/收割、
  WebContentsView 停靠与让位通知（侧栏恒可见，窗口过窄仅做几何钳制）；
  **侧栏 AI 能力注入**（会话 cwd = 工程根 + 指针 skill 写入 `dsh-home/skills/`，
  让内嵌 AI 直接用 CLI 编辑笔记）。唯一管理者，不依赖外部脚本。
  - **左侧原生控制栏**（拖宽热区 +「—」+「✕」合一，30px）：与 DSH 页面**零重叠** ⇒
    插件 UI 永远不会被我们的按钮挡住；让位宽度用 `occupiedWidth()`（控制栏 + 内容 ✓）。
  - **窄宽适配（应用侧注入）**：按内容宽加 `.dsh-narrow/-xs` + 注入通用防溢出规则 +
    `--dsh-viewport-width`；每次页面加载后重注入（`insertCSS` 不跨导航保留 ✓），
    并量出是否溢出记进 `status.narrow` ✓（改布局先读 `dsh-status`，别凭肉眼 ✗）。
  - **内核右栏 ⇄ 自动加宽**：内核「打开侧边栏」在窄模式下要求 `view ≥ 756px`
    （`available = view − 56 − 400 ≥ 300`，不足即把右栏宽算成 0 ✗）；检测到意图
    （点按钮 / Ctrl+Shift+B ✓ —— **宽度不够时官方属性不变，只靠属性检测不到 ✗**）就把侧栏
    加宽到 900 ✓，右栏关掉还原 ✓（只在我们仍处于自动宽度时还原 ✓）。
  - **两个 ✕ = 真关（"卸载"，不是"隐藏"）**——本工程的一条事实：**渲染层是可被卸载/重载的**。
    · **导图页 ✕** / 菜单「关闭思维导图页」/ CLI `sidebar-only on` ⇒ `closeMapPage()`：
      导图页**不是独立窗口，它就是主窗口的渲染层** ⇒ 想让它"真的不在内存里"只有一条路 ——
      让主窗口**导航到占位页**（`renderer/map-closed.html`），旧文档连同 DOM/JS 堆一起被卸载 ✓。
      **实测**：关完之后页面里 `#main` 与 `MMApp` 都不存在；渲染进程会被复用（`getOSProcessId()`
      前后相同）⇒ **别写成"渲染进程被替换"**。关之前先拦未保存编辑（界面弹「保存后关闭 / 取消」并
      走既有保存+冲突保护；CLI 那条路**直接拒绝**并在回执里带原因）——脏标记只活在渲染层内存里，
      页面一卸载它也没了，所以这件事**只能**在关之前做。关着时：发往导图页的菜单项置灰、
      控制栏拖宽禁用（那时侧栏铺满整窗，拖宽只会改坏"重开要还原的停靠宽度"）。
      重开 `openMapPage()` = **重新加载** + 还原停靠宽度 + 回到上次的项目
      （项目名由**主进程**记：`project:read` 时 `setCurrentProject()`，落 `userData/dsh-sidebar-prefs.json`；
      页面 boot 时问一次 `dsh-sidebar:boot-project`。正常启动不武装它 ⇒ 启动行为不变 ✓）。
    · **侧栏 ✕** ⇒ `closeSidebar()`：收起 + **销毁** `WebContentsView`（`destroyView()`：先摘下来
      再 `webContents.close()` —— 旧实现只摘不销毁，页面还挂在内存里 ✗）+ 停 DSH 服务；
      重开走 `show()`（`ensureView()` 重建 ⇒ **新** webContents，页面重新加载）。
      判据字段（断言/诊断不靠猜）：`getStatus()` 的 `hasView / viewId / viewEpoch / lastDestroyedViewId /
      mapPageClosed / lastProject / bootProject`，`dsh-status` 白名单里也放这些（不含 url/token ✓）。
  - **第 4 个原生面板（停靠面板 · 2026-10-18 底座批）= 第四个 `WebContentsView`**，停在**右侧让位带的内缘**（`[页面][面板][控制栏][DSH 侧栏]`）。本批**只造底座**：能开能关、几何正确、判据齐备的空面板 + 一个 `data:` 占位页，**没有任何业务内容**（浏览器 / 改动清单属下一批 `a76bab32`）。
    · **唯一改几何出口**：`setGeometry({width?, dockWidth?, dockOpen?})` → `relayout()` → `computeGeometry()` → 三条 `setBounds()`；`setWidth()` 只是 `setGeometry({width})` 的薄壳（A1：不新造第二套几何设置函数）。结构断言钉住"只有一处"：`main-dsh-sidebar.js` 代码里 `computeGeometry(` 恰 1 次、`setBounds(` 只出现在 `relayout()` 内（`tests/panel-geometry.test.js`）。
    · **开/关/回退**：`openDockPanel()` 把**开之前那份几何快照**记进 `state.dock.prev`；`closeDockPanel()` 重算几何并留`lastRestore = {opened, before, after, same}`（"关回原样"的比对基准是**开之前**，不是"关那一刻" —— 后者必然不同，那条读数会永远 false，实测踩到过）。关闭默认**只摘不销毁**（面板是将来业务内容的容器，开关一次不该丢它的状态）；要回收内存走 `destroyPanel()` / `closeDockPanel({destroy:true})`；应用退出时 `destroy()` 里销毁。
    · **安全面（照抄既有侧栏 view 的取值，不自己发明）**：`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true` + **独立 session partition** `persist:mm-dock-panel`（与 DSH 页面零共享 cookie/localStorage）+ 外链交系统浏览器。⚠️ 判据**不许**用 `capturePage()`（主页面截图里没有原生视图 —— 这条有**语义可自证**的来源：`scripts/vision/window-shot.js:4`「侧栏是原生 `WebContentsView`，`capturePage()` 只截**页面** ⇒ 截图里永远没有侧栏」；⚠️ 原先此处指 `CHANGELOG.md` 行号，2026-10-20 实测那些行号已指向无关内容，**行号型证据指针会漂，别再写**）⇒ 全是 `getBounds()` 对拍页面让位读数（`scripts/smoke/22-sidebar-gap.js` 那条追加断言）。
    · **让位读数（一处发射）**：`notifyRenderer()` 发的 `width` = `occupiedWidth()` = 控制栏 + 侧栏 + 面板；另带 `sidebarWidth`（侧栏那条带自己的宽）—— 渲染层用它算**拖宽热区**的左缘（用总量会把热区推到面板左缘，表现为"在面板边上拖动却改了侧栏宽度"）。改动前 `width` 恒等于"侧栏可见时的占宽"，改动后**面板关着时逐项相同**。
- `preload.js`：contextBridge 暴露 `window.desktop`（projects/project.save/**project.peek**（只读探视：
  取盘上内容与两份版本，**不推进**闸门记录）/asset.import/
  app.exportMd/app.importMd/app.version/on/dsh.status/onProjectDiskChange）。渲染层**无 Node 权限**，只能走 IPC。
- **保存闸门**：`project:save` 先做**进程内**校验（`data-store.createProjectValidator` —— 与 CLI 写路径
  同一个工厂，判据与错误文案不会分叉；**不落任何临时文件**）→ 通过才 `writeFileAtomic` 原子覆盖正式文件；
  坏数据拒收且不污染原文件。⚠️ 它**曾经**是"把载荷写成 `projects/<项目>/<项目>.json.<pid>.<ts>.validate`
  再 spawn 一条 `mm-cli validate <探针>`"：探针落在**用户数据目录**里（崩溃留残留、绕过唯一写盘出口），
  2026-10-19 已偿。**别改成"把探针挪去 `os.tmpdir()`"** —— CLI 的 `validate` 靠**探针的父目录名**推断项目名
  （`selfProject`），挪出去会让"同项目成员以这份待写数据为准"静默失效（实测：删掉仍被 assoc 引用的节点后
  保存会被放行），故项目名现在是**显式入参**。
- **保存时的并发处理（多路同时编辑）**：盘上版本 ≠ 渲染层读到的那一版时，**能合就合、合不了才拦** ——
  用三方（`baseAtRead` 记的"界面读到的那份" / 界面内存 / 盘上最新）走 `src/concurrency.js` 的 `mergeTrees`：
  两边改的对象**不相交 ⇒ 自动合并**（双方改动都保留）；**相交 ⇒ 不写盘**，把**冲突对象名** +
  **三份只读快照**（`concurrency.conflictSnapshots`：`base` / `mine` / `theirs`，**只含冲突涉及的对象**）
  回报给渲染层 ⇒ 界面开**冲突面板**逐对象显示**两边内容 + 基线内容**，用户在面板上二选一
  （`MMApp.resolveConflict('theirs')` = 用磁盘上的版本 —— **只丢冲突对象上的改动**，非冲突对象的改动照常写入；
  `'mine'` = 保留改动、本次不保存）。**"打架时能预览冲突内容"是本工程的一条对外承诺**（2026-10-13 用户反馈后
  首次写进文档）：面板**只读**，它自己不写盘 —— 写盘永远只有 `project:save` 那一条路；面板**只列冲突对象**，
  我改的其它对象由"点击之后仍然落盘"证明保住（面板少列 ≠ 改动丢了）；撞上时盘上**逐字节不动**。
  **headless 下不弹模态框**（没人回答会把整轮卡死 —— 主进程回 `headless` 标志；面板照常亮出内容，
  程序化选择走 `resolveConflict()`）。**逐对象各挑一边**（每个冲突对象单独选一方）**未做**，面板结构已留得住加它。
- **外部编辑冲突规则（界面与 CLI 互不影响）**：这也是本工程的一条设计承诺（同样在 2026-10-13 首次写进文档）——
  **AI 的编辑与人的编辑互不影响，除非两边改到同一个对象**。三条落地：
  · **无脏改动** → 静默重读（AI 的编辑实时上屏）；
  · **有脏改动** → **绝不覆盖人的编辑**（不重读树、不写盘、不动内存），但**差异必须看得见**：只读探视盘上
    （`project:peek`，**刻意不推进** `versionAtRead`/`baseAtRead` —— 若用 `project:read` 探视，界面随后保存会被
    判成"没有外部改动"而**静默覆盖** AI 刚写的内容）→ 常驻可点 banner「外部已改盘上内容（N 处）—— 点这里看差异」
    → 打开**只读差异面板**（左"我的改动（界面内存）"/ 右"盘上现状（外部写的）"，逐对象差异 + "撞在同一对象上"那一组）。
    盘上内容与基线**一致**时不亮 banner（不制造假警报）；
  · **落后可见**：`projects/<项目>/.ui-state.json` 带 `seenVersion`（界面**所见内容**的盘上版本）与
    `baseVersion`（**闸门基线**）⇒ 侧栏 AI 读 `ui-state --json` 即可判"界面所见落后盘上多少"；
    **窗口获得焦点**时主进程再**只读**比对一次盘上指纹，落后就**复用** `project:disk-changed` 这条既有事件
    （不另造一套通知）。
- **离屏（headless）契约**：`--smoke` / `--export-image` 创建的窗口一律离屏 ——
  `createWindow({show:false})` 进入 headless 分支：构造选项 `skipTaskbar:true`
  （对**从未显示过**的窗口，事后的 `setSkipTaskbar` 在 Windows 上不生效）、
  `backgroundThrottling:false`（隐藏窗口被节流 → 定时器降频/rAF 暂停 → 断言与截图拿到旧帧/黑屏）、
  `paintWhenInitiallyHidden:true`（未显示也绘制，`capturePage` 才读得到真实帧）。
  契约由冒烟断言锁死（`scripts/smoke/14-headless-window.js`）：① `isVisible()===false`
  （不弹桌面、不抢焦点）；② 隐藏状态下 `capturePage` 仍读到**有效帧**（像素统计非空/非纯色，
  防"藏住了但不出帧"的次生回归）。`skipTaskbar` 仅作信息记录，不参与判定 —— Windows 的
  任务栏条目只在窗口**真正显示**时创建，未显示窗口本就不产生条目（理由见 §4b ADR）。
  闭环的**判定阶梯与状态**（L0–L4）就写在本工程文档里：**L0** 产物存在/尺寸/哈希 → **L1** 有效帧 → **L2** 关键区域 ROI → **L3** 基线差率 → **L4** 读图证据；**L1 / L2 / L4 已落地，L3 按 M1 延后**（触发条件 = 出现一次「布局回归在全绿下溜过」的真实事故）。各层落点、**与通用做法的偏离**、记录过的两处误判，见 §4b ADR「**静默验证分层（L0–L4）与工程偏离**」；阈值单源在 `scripts/vision/thresholds.js`，读图记录落 `.review/vision/`。**本节自足：不需要任何工程外文档。**

### 2.5 MCP（scripts/mcp-server.js）

零第三方依赖的 stdio JSON-RPC 服务器。**不复制业务逻辑**：每个工具 = 一次
`mm-cli` 子进程调用，工具参数映射为 CLI 参数。新增 MCP 工具 = 加一条 TOOLS 定义 +
一个 case 分支，转发即可。

**错误分流（协议级 vs 业务级，边界只判一次）**：`handleMessage` 是唯一的判定点，
`callTool` 用 `{protocol:true, code}` 标记"调用方调错了"：

| 情形 | 报文 | 为什么 |
|------|------|--------|
| 未知方法 / 未知工具 | `error` + `-32601` | 那是"你调错了"，不是"调用失败了"；报文形状必须先对，客户端才可能纠正 |
| 缺必填参数 / 没给工具名 | `error` + `-32602` | 同上。必填项取自 `inputSchema.required`（**与工具定义同源**，不另写一份清单） |
| 工具内部的失败（项目不存在 / 校验失败 / CLI 非 0） | `result` + `isError:true` | MCP 约定：失败内容要让**模型看见**并自行纠正；变成协议错误反而让模型看不到原因 |
| 服务器自身异常 | `error` + `-32603` | 本进程 bug，不是调用方的错 |

修前实测报文：`{"jsonrpc":"2.0","id":4,"result":"method not found: no-such-method"}` ——
未知方法回了 `result` 字符串，既无 `error` 也无 `code` ⇒ 标准客户端按成功处理（静默）。
两面都钉住：纯逻辑单测 `tests/mcp-protocol.test.js` + 真 stdio 一拍（`scripts/cli-integration.js` 的 MCP 段）。

### 2.6 脚本层（scripts/ —— 验证链、门禁与一次性工具）

> **新接手的 AI**：想知道"验证是怎么跑的、门禁在哪、工具怎么用"，看这张表即可。
> **`scripts/` 下每个 `.js` 都必须能被本表找到** —— 由 **G8** 第 7 条判定守着（加脚本忘登记会变红）。
> 判定**递归扫整棵子树**，登记口径分两档：**顶层**文件按**文件名**登记（下表逐行；文件名出现在本文档即算入档）；
> **子目录**文件必须按**完整相对路径**登记（`scripts/tools/x.js`）—— 否则"同名文件换个目录"会靠顶层那条登记
> 蒙混过关。**规则确实相同**的子目录（一份目录级说明 + 自描述命名就够）**整目录豁免逐份登记**，
> 写成 §5 那种前缀行：见下表末尾两行（`scripts/smoke/*` / `scripts/vision/*`）。
> ⚠️ 这两条豁免在 2026-10-16 之前**不是声明、是"非递归扫描"的副作用**（旧实现只 `readdirSync` 顶层，
> 子目录根本没进扫描面）：那时把 `mutate-gates.js` 挪进任何子目录就**免检**、挪回顶层又被抓 ——
> 而它是本工程唯一检出过真事故的门禁的战功之一。现在豁免**只有一种写法**：
> `scripts/docs-registry-check.js` 的 **`EXEMPT_DIRS`**（逐条带 `why`，是唯一判据）+ 本节一行前缀行。
> `tests/` 不在扫描根内，同样不逐份登记（用例名与它覆盖的对象同名）。

| 文件 | 职责 |
|------|------|
| `verify.js` | **验证链的运行器**：`STEPS` 是"执行顺序 / 每步命令 / 耗时预算"的**唯一定义**，`docs/VERIFY.md` 的链表由它渲染；首败即停 |
| `encoding-check.js` | **G1** 文件编码完整性（判定清单见 `docs/RULES.md` §2 —— **本表不复述**，也不写条数：这里的枚举漂过一次（少列了"提交面行尾"那条），照着本表改门禁就会漏判 ⇒ 第二份清单就是第二份会漂的副本）。扫描面与"这次没扫什么"每次运行都打印；要逐条看实现自报的清单跑 `node scripts/encoding-check.js --list` |
| `docs-registry-check.js` | **G8** 文档体系完整性（**判定清单现场取**：`npm run check:docs -- --judgments` 会从实现的**全部**判定标记打印全套；条数由 `docs/RULES.md` §2 声明并与标记机械对齐 —— **本表不复述**，复述一次就是第二份会漂移的副本）；`--write` 从各文档头部元信息**生成** §5 登记表（`npm run docs:registry`，`npm run check:docs` 为校验模式） |
| `rules-consistency.js` | **G9** 规则文件自洽：声明条数 == 表格行数、表格未被空行打断、编号引用闭合、实现列点名的脚本存在、其他文档的条数转述一致、**门禁声明的判定条数 == 实现脚本的判定标记数**（且标记唯一；实现脚本文案里也不得写死条数）；逐条清单见 `docs/RULES.md` §2，**本表不复述** |
| `visibility-judge-check.js` | **V1** 可见性判据门禁：扫描 `scripts/smoke/*.js`，凡**名字**里声称可见性（可见/不可见/遮挡/面板内/框外/看得见/看不见）的断言，判据必须是**真判据**（`document.elementFromPoint` 命中测试 ⇒ 抓遮挡；`scanRegion` / `isAccentBlue` / `bitmapInfo` 等真帧像素 ⇒ 抓裁切）或一行显式豁免 `判据-豁免: <原因>` —— 只用 rect / 类名 / `style.display` 判"可见"的断言**对裁切与遮挡是盲的**（实测：同一元素被父元素 `overflow:hidden` 裁掉时 rect 读数与正常显示**完全相同**，而真帧像素 81 px vs 768 px）⇒ 它在"用户根本看不到"时照样绿 ✗。判定清单现场取：`--list`（逐条分类）· `--debt`（既有欠账，**只减不增**，含"为什么是欠账 + 怎么迁"）· `--selftest`（**判别力自检**：内存注入 ⇒ 必红 ⇒ 撤销 ⇒ 必绿，不碰任何文件）；`npm run check:visibility` 单跑。**能力边界**：它查判据的**来源**，查不了判据用得对不对（`elementFromPoint` 也能传错坐标）；名字里不写可见性词的断言它抓不到 ⇒"**名字要说清凭什么判**"是配套纪律（名字是这门禁的输入 ✗）。⚠️ **编号是 V1 而不是 G 号**：门禁编号的唯一权威是 `docs/RULES.md` §2，而本门禁上线时该文件正被另一个会话占用（脏文件、禁止提交）⇒ 待它交回后并入 §2（界时只改 `scripts/verify.js` 的 gate 串、本行与两处 `tests/` 期望；**不是**再挂一个门禁） |
| `smoke-state-check.js` | **V2** 冒烟"域内自收尾"门禁：扫描 `scripts/smoke/*.js`，凡是会**留下浮层/模态**的动作（`addNode`/`addSiblingNode`/`addTopic`/`MMEditor.editNode` 会顺手打开「编辑节点」框；`openFilePreview`/`openLightbox`/`openAudit`/`openPalette`/`openAssocEditor`/`openImageDialog`/`openFileDialog` 各自留下浮层），**域末**必须给出收尾（共用入口 `require('../smoke-assertions.js').closeDialogs(ctx)`，或产品自己的关闭口如 `MM.closeFilePreview` / 点 `#fp-close` / 点 `#edit-cancel`）或写一行显式豁免 `收尾-豁免: <原因>`。**为什么必须有**：`renderer/editor.js` 的模态是纯 DOM 的，而"每域隔离"只还原**项目数据文件 + 重开项目** ⇒ 模态**跨域存活**、盖住后面域的画布（实测：域 16 的 `addNode` 一处漏关 ⇒ 域 36/37 连锁红 **11 条**，报文 `点不到 comp-net …→DIV.dialog-box`，而那两个文件**一行都没改过** ✗；全量跑当时还绿，只因后面的域**各自顺手**擦了桌子）。判定口径是"**域内接力可以，域末必须干净**"（后面的断言读前一条留下的画面是常态；逐段要求"自己开自己关"只会制造假红）。`--list` 现场列清单。**运行时兜底**：`main.js` 的「域开始的干净前置」在每个域开始时调 `MMApp.closeAllDialogs()` 收尾，**有残留就判红并点名是哪个域留下的**（过滤运行也生效 ⇒ 这正是当年漏掉的那条路）。⚠️ **编号是 V2 而不是 G 号**：与 V1 同一处置 —— `docs/RULES.md` §2 是门禁编号的唯一权威，该文件本轮仍被另一会话占用（脏文件、禁止提交）⇒ 待交回后与 V1 一并并入 §2（届时不改实现，只改编号声明） |
| `dep-direction-check.js` | **S1 单向依赖门禁**：扫第一方源码的 `require`/`import` 边，按**单源分层图**（`LAYERS` —— **这个文件是分层图的唯一权威**，`docs/ARCHITECTURE.md` §4 原则 2 只讲为什么）判方向：**依赖只能朝 rank 小的方向**（`renderer`(4) → `main`/`scripts`(3) → `cli`(2) → `src`(1)），**反向边即红并指名 `A → B`**；同层成环、指向"分层图之外"（`EXEMPT_TARGETS` 之外的）也判红。守的是 skill 点名的"**性质成立、检查没建**"那一类：这条约束一直成立（实测 101 条相对边零回边、零环），但一次顺手 `require` 就能破而**全链不红** ✗。**能力边界**：只认**字面量**路径，动态 `require` 判不了方向 —— 它把这些**数出来并打印**（不许静默跳过）；裸包名不在图内；`tests/` 在图外（`EXEMPT_TARGETS` 逐条登记、带原因、输出里可见）。判定清单现场取：`--list`（分层图 + 全量边 + 在册豁免 + 动态 require 计数） |
| `collateral-check.js` | **S2 连带清单门禁**：「改动类型 → 连带处」的**单源表 `COLLATERAL`**（`--list` 现场打印全表，报错即指路），并**从表里派生**断言：① MCP 派发到的每条 CLI 命令都必须存在（防"CLI 改名、MCP 透传没跟上"）；② 每个冒烟域都必须在**断言注册面**（`scripts/smoke-assertions.js` 的「分域文件（仅索引）」）里；③ 表里"指过去复用"的每一处，其门禁必须**真的挂在 verify 链上**；④ 双向闭包（表里声明了没人实现 ⇒ 红；实现了没写进表 ⇒ 红）；⑤ **写盘出口**（`WRITE_OUTLET`，条数与标记**只在实现里**：`--list` 现场取，本表不复述）：① **裸写受管资产** —— 把**写调用点的目标路径**按字面量求值解析出来（`path.join` / `__dirname` / 同文件常量绑定 / 零参函数的 `return`；求不出就如实记"判不了"并逐条打印），凡落在**受管资产**（`docs/**` / 根文档 / `CHANGELOG.md` / 归档 / 版本单源 / `projects/**`）上又没走 `writeFileAtomic` / `writeManagedText` ⇒ 红；② **自造第二份原子写**（同一文件里 `fs.writeFileSync(` 与 `fs.renameSync(` 同时出现）；③ **出口本体不许被降级**（2026-10-19 补）—— `src/data-store.js` 的 `writeFileAtomic` 必须仍然"写 tmp → **fsync** → rename"，三条腿任一条掉了、或内容被直接写到目标 ⇒ 红（**这条治的是"降级方向"**：把原子实现换成一把裸写时，② 的签名反而**不成立**、① 的目标是形参、④ 要文件"提得到受管资产名"而出口本体提不到 ⇒ 旧的四道全盲，实测 `e0f992c` 的 I3 因此 exit 0）；④ **按调用点兜底** —— 一处裸写**判不了目标**、而它所在文件**提得到**受管资产名 ⇒ 这一处必须在册（2026-10-19 从"按文件"改成"按调用点"：按文件时整文件豁免会**先短路**）。**封闭欠账册** `WRITE_OUTLET_DEBT`：三种粒度 `file`（整文件）/ `site`（**逐调用点**，按**第一实参签名** + 处数 `n` 双向核对 ⇒ 已知的仍豁免、**新增的第 8 处判红**）/ `self-atomic`；每条带 `why` / `close`；**两道 cap** —— 条数 `WRITE_OUTLET_CAP` 与**豁免面** `WRITE_OUTLET_SITE_CAP`（被豁免覆盖的调用点数；拆细条目换不来额度）。已机制化的那几处（G8 / G7 / G6 / V2 / V1 / G8 第 ⑮ 条稳定性表 / `SCHEMA_FIELDS`）**只指过去、不重做** ✗。**能力边界**：**不看 `git status`**（易变工作区状态当判据 ⇒ 新建/删除一个工作目录就能让链变色 ✗）；动态派发扫不到（如实计数）；"该不该加这条登记"是人的判断，那种一律标 `role: 'residual'` 显式写下来；判定 ③ 只钉**出口本体**的**形状**，"调用点换成裸写且目标在仓库外又求值不出来"（I3 的真实形状）**它抓不到**，判不了"语义对不对" |
| `determinism-check.js` | **S3 确定性产物门禁**：声明面 = `docs/ARCHITECTURE.md` §5.2 的产物表（两边**双向闭包**），判定 ① 产物表闭合 ② **真值比**产物必须"同一状态**连续两次**重算逐字节相同"（扰动四类已知来源：**时钟** / **随机数** / **目录列举顺序** / **工作产物区**，差异来源可分类；取样纪律：是"同一状态连续两次"，**不是**"改动之后第一次"跟别的比 —— 预热效应会让第一次给出旧值 ✗）③ **允许不确定**产物必须在**生成器里点名标注**"非确定性、不得当真值"，且差异来源类在允许列（`NONDET_CLASSES` 逐类写明为什么可以不确定；**"顺序"那一类不允许**——它不是不确定，是缺陷）④ **封闭欠账册**（`--debt`：在册算欠账 / 只减不增 / 修好忘销账判红 / 册上对象不存在判红）。**档位是乙档**：上线时就带着在册欠账（被当证据真值用、但判定尚不存在的那些），**不许"一次修干净"**✗。**能力边界**：扰动只覆盖上面四类来源（宿主名 / 空闲内存 / 并发的真实写盘扫不到，那几类由"留痕产物"的标注承担）；真值比产物的**过期**不由本门禁判（那是 G7 / G8 第 ⑬ 条，指过去复用）；`renderVerifyDoc` 的重算用**冻结的 facts 快照**（判据问的是"同一输入两次是否相同"，输入值不参与；`facts()` 自己的不确定性由 G7 兜底） |
| `doc-facts.js` | **G6/G7** 文档数字与版本一致性 + 生成物是否过期；`--write` 生成 `docs/VERIFY.md` |
| `cli-integration.js` | **G4** 全部 CLI 命令端到端断言（进程内调用，临时项目自动清理） |
| `recon-integration.js` | **静态 ÷ 实跑对账**（读数工具，**不是门禁**；`node scripts/recon-integration.js --run`／`--log <日志>`）：现算「源码里**行首** `check(`」÷「集成脚本自己打印的 `[PASS]`/`[FAIL]` 行」的**差集**，逐条点名**行号 + 标签 + 判定依据**，并原样打印日志里的 `[SKIP·不是通过]` 行。静态那半与 `doc-facts.js` **逐字相同**；实跑那半与汇总行 `==== N/M …` **交叉校验**（不一致 ⇒ 读数作废 ⇒ 判红）。`--run` 自己跑一遍集成，整段 `finally` 收尾并按**唯一一张前缀表**清掉本次新出现的探针、当场报"残留 / `projects/.visits`"读数。**为什么不是门禁**：那两个数**本来就该差**（夹具下永不执行的兜底分支 + env 门控那几处），它只判"读得准不准"、判不了"该不该差"—— 后者要读那一处的上下文。**能力边界**：只数**行首** `check(`（行中调用数不到；它们真跑了会在「孤儿观测」那一段列出）· 靠 label + 第三个实参（detail）分辨同标签多站点，**不读断言体的语义** · 不替代 G4，也**不挂在 verify 链上**（挂上去就等于每跑一次链把集成跑两遍 —— 那正是 A2 说的净成本）。退出码：0 = 报出了读数 · 1 = 真异常（有 `[FAIL]`／汇总行与实跑行数不一致／收尾没清干净）· 2 = **采不到真值** |
| `detail-census.js` | **detail 语料的现算口径**（只读工具，**不是门禁**；`node scripts/detail-census.js [项目名] [--json]`）：逐项目报「节点数 / 含 detail 数 / 含白名单标签数 / 不含数 / `links` 数（同项目·跨项目）/ `assoc` 数」，并列出"含 detail 但不含白名单标签"的残样（**那是"渲染期探测"规则的真值边界样本**）。**它存在的唯一理由**：本条设计稿那条线上"`comnet` 有 N 个含 detail 节点"被写死过好几处（一度写的 133 是**错数**，实测基线 450 / 工作区 753），而**这类数天生会漂** —— `projects/comnet/comnet.json` 正被并发会话改写，同一时刻工作区与 git `HEAD` 就是两个真值 ⇒ 纪律是"**引用它打印的那个数，不许抄进文档**"。⚠️ 它里面那份白名单标签正则**是设计稿 §② 判定表在读数侧的投影**（消毒模块落地后应改成从模块取，别留第二份实现）；退出码：0 = 报出读数（**不管数字是多少**）· 2 = **采不到真值**。不挂在 verify 链上 |

| `mutate-gates.js` | **门禁变异体检**（读数工具，**不是门禁**）：`node scripts/mutate-gates.js`（`--json` / `--only=<gate>` / `--strict` / `--out=<file>` / `--keep`）把真仓**只读**复制进 `%TEMP%`（`finally` 自清），每条变异体只在**副本**上做语义破坏 ⇒ **真子进程跑门禁、取真 exit code** ⇒ 逐字节还原（"每条都从未变异的副本出发"由构造保证）。当前覆盖 **G9 · S1 · S2 · G6+G7 · V1 · V2 · G8**（S2 覆盖**判定 ⑥ 笔记正文残留**与**判定 ② 冒烟域 ↔ 断言注册面索引**：前者的注入靶子是仓内夹具 `tests/fixtures/note-residue/`（`--note-root=` 把扫描根指过去 ⇒ 真仓 `projects/` 一个字节不动），后者的靶子是副本里 `scripts/smoke-assertions.js` 的索引段（抹掉一个域文件名 —— 门禁读的是**文本**、不 require 它）；V2 覆盖**域内自收尾**的两条真判据（把某域的收尾动作换成不认识的标识符 / 往干净域追加一段未收尾的开浮层断言）；G8 是**判定级**覆盖：它的**每条判定各有一条注入**，判定清单由 `docs-registry-check.js --judgments` 现场取，本工具不抄一份；读数与"门禁 × 有没有证明"的现算汇总表见 `.review/20261016-T4-G8判别力/`），逐条报"**门禁红了吗**"；只有在变体输出里出现**期望原因**、且**原始基线输出里不出现**时才记"拦下"（⇒ 存量红不会被冒充成"我拦下的" ✗）。**防恒真**：无害对照（只改注释/空白 + "声明的就是真值"的同款声明）⇒ 读数必须**逐字不变**；负对照（先把副本里的门禁**钝化**，再注入同一处真违规）⇒ 必须**如实报"没拦下"** ✓。退出码：0 = 跑完并报出读数（**漏过也是读数** —— 做成默认红 ⇒ 长期红 ⇒ 被关掉）· 1 = 有漏过（**仅 `--strict`**）· 2 = 采不到真值／环境不齐。**能力边界**：未覆盖 G1–G5/S3（需起 Electron 或跑全链 ✗）；V2 只扫**静态源码文本** ⇒ 判不了"收尾动作到底关没关掉那个东西"，也**不读** `main.js` 的运行时兜底（那要真起 Electron）；变异体是**手工挑的** ⇒ 除 G8 外只报"这几类破坏拦不拦"，**不报覆盖率** ✗；测的是**门禁**不是产品 ✓ |
| `smoke-assertions.js` | **G5** 冒烟断言清单入口：自动发现并按文件名顺序拼接 `scripts/smoke/NN-*.js`（入口只做 require + 拼接；另导出 `files` / `groups` 供单跑选子集，`.length` 仍是**全量**真值）。另导出**共用工具** `closeDialogs(ctx)`（→ `{n, names}`）：收干净产品自己打开的模态/浮层（渲染层唯一实现在 `renderer/app-actions.js` 的 `closeAllDialogs`）—— 任何动了 `addNode`/`addTopic` 的域都要在 **域末**调它（纪律与原因见文件头「收尾纪律」；不这么做的实测代价是模态跨域存活、后面域整片假红 ✗）。⚠️ 它挂在 `require` 各分域**之前**（分域在加载期就取它）。另导出**三态计数** `tally(results)`（**纯函数、零副作用** ⇒ 可单测，见 `tests/smoke-tally.test.js`）：判定档 = { 通过, 失败, **未验证** }，`ok:true` 且带 `unverified` 的那种**不进"通过/总数"、也不阻断**（环境坏了、真值采不到时用；fail-safe 见该函数注释 —— 域 39 的剪贴板判据是第一处用它的）。 |
| `smoke-select.js` | 冒烟**单跑**选择器（纯函数，可单测）：把 `SMOKE_ONLY=20,21` / `--smoke-only=20,21` 解析成要跑的断言文件，**永远并入 `01-*` 预热**；**一项都不匹配 ⇒ 抛错**（采不到真值 = 红），避免"筛错名字却跑出 0/0 passed"的假绿 |
| `changed-plan.js` | **「改动面 → 必跑集」的映射（唯一权威，纯函数，可单测）**：两条入口**共用同一份形状**（`{full, steps, smokeOnly}`）与同一条执行/跳过/留痕逻辑 —— ① `git diff` 出的**文件清单**（`verify.js --changed`，自动档）；② 人显式点名的**改动面**（`verify.js --for <面>`：`docs` / `tests` / `scripts` / `smoke` / `src` / `cli` / `main` / `renderer` / `all`）。改动面表 `SURFACES` 是本工程**唯一**写"改动面 → 层次/冒烟域"的地方：**每个冒烟域恰好被一个面登记**（域号必须真实存在于 `scripts/smoke/`、登记条数**现算** ⇒ 表与真值分叉即红；自检排在**跑任何一步之前** ⇒ 表坏了当场红、不先付十几分钟）；每个面**自动**含"卫生八件 + G3 + G6"（结构保证，不是一条永远绿的断言）；声明跑 G5 ⇔ 声明了域；层次表的"必跑/跳过"由 `steps` **派生**（不留"视情况"档）；`--domains` 只能收窄本面登记过的域。**保守优先**：`--changed` 认不出的路径一律**全量**（这是它唯一允许"多跑"的方向 ✓）；干净工作树 ⇒ **一步都不跑**（不许跑两件卫生门禁假装验证过）。运行期还有一条**对账**：计划里的步骤必须真的跑过、跑过的必须在计划里 ⇒ **分叉即判红**（哪怕每一步都绿）。`--for all` 与不带开关**同形**（`plan = null` ⇒ 默认档输出逐字节不变 ✓）。记录写 `.review/last-verify-changed.json`（**不覆盖** `last-verify.json` 那句"上次全链"）、历史标 `partial: true`（耗时基线也不认它 ✓）。**能力边界（如实登记）**：`--for <面>` 跑的是**过滤冒烟**（走 `SMOKE_ONLY`）⇒ 跨域状态依赖仍是既有的已知边界（实测 `--for renderer` 第一次就让域 25 ⑦c 红：该域假定"界面开着的是 comnet"，过滤集里上一条断言留下的却是别的项目 ⇒ 已按其纪律加**入口前置**：进域时确保开着 comnet，已在 comnet 则一个字节不动）；读它的前提是那句"**过滤运行不是全量真值**"横幅与逐条"**没跑什么**" ✓ |
| `smoke-flags.js` | 冒烟/离屏路径额外的 **Chromium 保帧开关**（纯函数，可单测）：照搬 Playwright 给 Chromium 的四个默认开关（三个 `disable-*` + `enable-features=CDPScreenshotNewSurface`），治"隐藏窗口不出帧 / 定时器被降频"引发的**假红**。**只在 `--smoke` 路径生效**（正常启动必须为空 —— `tests/smoke-flags.test.js` 有接线检查），"真的加上了"由 `scripts/smoke/14-headless-window.js` 断言。**效力在 Electron 上的验证未完成**，判据是 `verify-history.jsonl` 里 G5 的假红率与耗时趋势 |
| `smoke-input.js` | **冒烟专用「真输入 + 截图证据」驱动**（唯一实现）：用 Electron 自带的 `webContents.sendInputEvent` 发**真实**鼠标/键盘事件（`mouseMove/mouseDown/mouseUp/mouseWheel` + `modifiers:['control']` + `char/keyDown`），走 **Chromium 的真实输入管线** —— 命中测试、修饰键、hover、拖拽阈值、浮层遮挡全都在内；合成事件 `dispatchEvent` **整条绕过**这些（本工程 25-域记过"断言绿、功能坏"的真实事故 ✗）。截图证据用 `capturePage` 落 `.review/<工作目录>/shots/`（**不进版本库** ✓），判定用的帧与落盘的那张**同源**（`captureUntil` 一起返回）✓。**为什么不是一条 IPC 通道**：冒烟断言本身就跑在**主进程**（`ctx.exec` 只是主→渲染的桥），而这两个 API 都是主进程 API ⇒ 直接挂在 `ctx` 上；"非冒烟模式完全不可用"由**三重**保证：① 只在 `runSmoke()` 里构造（正常启动的进程里不存在）；② `createDriver()` 见 `isSmoke !== true` **直接抛**；③ `tests/smoke-input.test.js` 有单测 + **源码级接线检查**（照 `smoke-flags.js` 那套 ✓）。用法与边界（隐藏窗口可能给旧帧 ⇒ 像素判据一律前后差分）写在该文件头 ✓ |
| `register-batch-writer.js` | **批写者的「先登记后写」登记口**（写者侧工具，不做任何归因判断 ✗ —— 守卫侧的判据与四条正证据唯一实现在 `scripts/smoke/real-write-guard.js`）：`node scripts/register-batch-writer.js --name "<批名>" [--minutes 90]` 往 `projects/.writers/<批id>.json` 落一份**自报登记**（pid + 批名 + 时间窗；批 id = 名字净化段 + 时间 + pid + 随机段 ⇒ 并发唯一），让"真实数据零写入"守卫能把 CLI/代理批的写入**归因**给在册批（响亮"本次没验"），而不是把"并行书批在写"判成产品泄漏。批写完可自删；不删也会**过期自动失效**（窗口外 ⇒ 无永久豁免）；只顺手清"已过期超宽限且解析得动"的旧登记（活人/坏文件不动 ✗） |
| `pathchain-conformance.js` | **「新判据 × 现状实现」的全量对拍**（只读读数工具，**不是门禁**；`node scripts/pathchain-conformance.js`，另有 `--json` / `--project <名>`）：扫 `projects/<项目>/<项目>.json` 里**全部路径类字段**（`files[].file` / `images[].file` / `localPath` 在打开链上；`items[].src` / `origin.src` / `links[]` / `bindings[].dir` / `assoc[].members` **逐个点名**说明为什么不在链上），逐条过**两套判据**（新 = `src/path-chain.js`；旧 = 照抄改动前那几行的**纯函数 oracle**，不是产品代码），打印两条结论集并**逐条比对差异**（`ok` / 产物 / `action` 三项）。**它存在的唯一理由**：把判据抽出来时最重的风险不是安全而是**回退** —— 新判据只要与 `attachmentAbsPath` 不完全等价，就会把今天能打开的打不开（附件是随机名、含中文与空格）⇒ **上线条件 = 真实语料差异 0**。另带 22 条**合成边界样本**（中文/空格/元字符/`..`/UNC/设备路径/超长），每条写明期望，其中一部分是**有意的"新判据更严"**（与"未预期的回退"分开报）。三条纪律：**只读**（`projects/**` 正被并发改写，一个字节都不写）· **不探存在性** · **不把任何项目当靶子**。退出码：0 = 报出读数且差异 0 · 1 = 有差异（**那是读数不是工具坏了**，但按上线条件不许上线）· 2 = **采不到真值**。**不挂在 verify 链上**（输入是**活的** `projects/**`：同一时刻工作区与 git HEAD 就是两个真值 ⇒ 它不许成为卡点 —— 与 `detail-census.js` / `recon-integration.js` 同一处置） |
| `vendor-dsh.js` | 制作独立 DSH 运行包（`vendor/dsh`，含哈希清单；一次性/更新时重跑） |
| `dsh-maintenance.js` | 运行包维护 CLI：导入 / 切换 / 回滚 / 列表 / 校验（`npm run dsh:maint`） |
| `dsh-e2e.js` | DSH 独立实例端到端（孵化→401/200→收割）—— **不在 verify 里**（需真实冷启动，慢） |
| `dsh-resident.js` | 驻留语义端到端（宿主退出→服务存活→新宿主接管→显式停止）—— **不在 verify 里** |
| `dsh-resident-host.js` | 上面那条用的一次性宿主进程（被 `dsh-resident.js` 拉起） |
| `dsh-assembly-probe.js` | 回答"某插件 id 能不能被 profile patch 打到"（读运行时合成结果，不看装配文件） |
| `dsh-fixture-freshness.js` | **「装配面夹具」与运行包的一致性门禁**（**挂 G4**，`scripts/cli-integration.js` 里一条断言）：无参数 = 校验（隔离 `DSH_HOME` + profile `web` + bundles `[dsh-base, dsh-web-app]` 现跑 `--dump-config`，与 `tests/fixtures/dsh-composed-tree-web.txt` 的正文**逐字比对**）；`--write` = **重生成夹具（唯一合法写者 —— 夹具的出处头也由它生成，手改必红）**。**为什么需要**：那份夹具曾自称"内置实例 web 装配面"，却落后运行包两代（152 行 vs 287 行、缺 49 个 id，含 `ui-sidebar-terminal` / `ui-sidebar-browser`）⇒ "照夹具数入口"必错（`e3102ac` 差点错在这）。**适用环境（写死在脚本头里）**：它读 `vendor/dsh/`，而 `vendor/` 被 `.gitignore` 忽略、**不在版本库** ⇒ 有运行包的机器上真的比对；**没有运行包时不静默跳过**，而是 `exit 3` + `找不到 DSH 运行包`（G4 断言的正是这条契约）⇒ **CI 覆盖到的是"响亮报错"，不是"夹具保鲜"本身** |
| `dsh-token-ratio.js` | 实测 DSH token 启发式的真实偏差（诊断用，非门禁） |
| `dsh-embedded-overrides.js` | **内置 DSH"本地覆盖值"的渲染器**（`render [--dry-run]` / `check`，`--home` 指向 dsh-home，`--runtime` 指向内置运行包）：把 `<dsh-home>\.embedded-overrides.json` 里的**陈述式**差异**幂等**渲染进 `profiles\web\cordis.patch.yml`。**它是那份 patch 的唯一写者**（新增"要渲染进 patch 的东西"请扩这里，别再开第二个写者 ✗）。两类被渲染的东西：**① 标量覆盖**（改已存在条目的已存在键；白名单 4 个条目，白名单外**报错退出**、不猜）；**② agent preset 声明**（`"$presets": {"<id>": {cloneFrom, order}}` ⇒ 插入一条 `@deepseek-ai/dsh-agent-preset` 行）—— 清单**从运行包自带的 `presets/<cloneFrom>.patch.yml` 生成**、只替换其中的 persona 文本，**不把清单抄进本仓库**（抄一份就是又一份会随内置 DSH 升级漂移的副本 —— 见 `docs/DSH-EMBEDDED.md` §5 的「快照漂移」✗）。写盘前先复制 `.bak-<时间>`；`check` 除比标量外，还会把生成块与"现在重新生成的结果"**逐行比对**（手改/半截都会被抓到）。**为什么需要**：那份 patch 是**生成物**，手改态既不可复现、事后也无人知道曾改过 —— 实测已发生一次（台账 A3）✗；写成 overrides 才能"重放一次就回到同一状态" ✓。纯函数与 CLI 端到端见 `tests/dsh-embedded-overrides.test.js`（22 条，全部在临时 home 上跑） |
| `dsh-embedded-check.js` | **内置 DSH 升级后自检**（只读，不起 Electron；`--home` / `--json`）：10 项三态 `PASS/FAIL/UNKNOWN`（**UNKNOWN ≠ 通过** ✗），对照真值取自迁移回执 `receipt-migrate-*.json` 与它指向的 `packageDir\manifest.json`。**为什么需要**：内置实例的现状**只存在于 `%APPDATA%` 的现网状态里**，换运行包/重跑导入后"哪些改动还在"没有别的机械判据（台账 A3 就是靠它才发现手改已丢）；它读的是机器本地状态，**故意不进 verify**（会破坏"验证链可移植"这条前提）⇒ 它是 skill `embedded-dsh-maintain` 的必跑项 ✓ |
| `dsh-prefill-stub.js` | **用桩服务走通 `prefillComposer` 的成功分支**（`npm run dsh:prefill-stub`，**不在 verify 里** —— 与 `dsh:e2e` / `dsh:resident` 同一类按需工具）。**为什么需要**：`dsh-prefill`（把文本投喂进侧栏输入框）在门禁里**永远走失败路径** —— 冒烟跑在 `setNoSpawn(true)` 下，`prefillComposer` 永远停在 `state.status !== 'running'` 那一句 ⇒ 成功路径（真的把字塞进页面输入框、真的派发 `input`/`change`）**没有任何门禁覆盖**，坏了也只有真机才发现（D7）。它起一个只回一段静态 HTML 的本地 HTTP 桩（随机端口、只监听 127.0.0.1），把它接成"已就绪的服务"（`__injectStubServiceForTest`，**测试专用入口**，产品路径的接管仍走 `adoptExistingService` 的 pid + HTTP 双探活），再调**真正的那份** `prefillComposer`：① 返回 `ok:true`；② **读 DOM 真值**确认文本真的落进 textarea（不信返回值）；③ 页面自己记的计数器证明 `input`/`change` 真的派发了；④ 负例：空文本必须响亮拒绝。`APPDATA` 指向临时目录 ⇒ 真实 `~/.dsh` 与 `%APPDATA%/AI MindMap` 零触碰 |

| `scripts/smoke/*` | **冒烟断言域（整目录前缀覆盖：不逐份登记）**：全部 `NN-<域>.js` 由 `smoke-assertions.js` 按文件名顺序拼接执行，域号 + 文件名即目录级说明 ⇒ 规则相同，逐份登记等于把同一份清单抄两遍（判据 = `EXEMPT_DIRS`，见本节开头）。⚠️ 豁免的只是"逐文件进本表"，**不是**"不受管"：域内文件仍受 G5 执行、**V1** 可见性判据、**V2** 收尾纪律与 **G1** 编码门禁；**增删/改名一个域文件**照旧要同步 `changed-plan.js` 的域登记（**S2** 双向闭包会抓） |
| `scripts/vision/*` | **离屏/读图取证工具（整目录前缀覆盖：不逐份登记）**：同一套目录级说明 + 自描述命名（画面判定 L0–L4 的分层判据见 §4），判定用的帧与落盘证据在 `.review/`；逐份登记只增维护面而无收获（判据同 `EXEMPT_DIRS`） |

## 3. 数据流

```
编辑（人或 AI）
  → 变更内存节点树（渲染层 jsMind / CLI 直接改 JSON 对象）
  → 序列化（serializeTree 或 CLI 写前构造）
  → 校验闸门（CLI validate：结构 + id 规范 + caption 必填 + 悬挂链接 + 悬挂关联成员）
  → 原子写盘 projects/<name>/<name>.json
```

## 4. 设计原则（改代码前先读）

1. **逻辑单源**：转换/校验/序列化只实现一次；渲染层与 CLI 共用 src/。
2. **分层单向**：renderer → main(IPC) → CLI → src → data；不反向依赖。
   **机器可读的那一份分层图在 `scripts/dep-direction-check.js` 的 `LAYERS`（唯一权威，门禁 S1）** ——
   本节只讲"为什么这么分层"；改分层要改那一处（并同批说明：为什么新层不在既有的 rank 序里）。
3. **可测性优先**：核心逻辑全部可 headless 验证（npm test / npm run smoke）。
4. **零必需运行时依赖**：生产代码只用 Node 内置 + 本地 vendor；npm 依赖仅限
   electron / jsmind / vitest(dev) / electron-builder(dev)，**唯一例外是 PDF 解析用的 `pdfjs-dist`**
   （只有 `scripts/pdf-outline-helper.mjs` 这个子进程 require 它 ⇒ 不用 PDF 导入就完全不载入；
   原先这里写的是"零运行时依赖"，与 `package.json` 的 `dependencies` 不一致 —— 实测漂了一版 ✗）。
5. **数据安全**：写盘必经校验，且**一律走 `writeFileAtomic`**（临时文件 + fsync + rename）；
   assets/attachments 引用相对路径；id 稳定规范。

> **"必须遵守什么"不在本文维护** —— 规则（门禁 / 铁律 / 约定）的唯一权威副本是
> **`docs/RULES.md`**。本节只讲**架构性约束**（为什么这么设计），规则与强制方式见该文件。

## 4b. 架构决策记录（ADR）

这些是**一次性决策**，不是每次改动都要遵守的流程规则（故不列在 `docs/RULES.md` 的铁律里）。

| 决策 | 内容 | 理由 / 历史 |
|------|------|-----------|
| **单一真源** | 本目录即完整工程（skill 即工程），**不分离副本**、不用软链、不做自包含打包；只维护本目录。skill 触发名统一为 **AI MindMap**（单名） | 历史上尝试过多目录/软链/自包含方案，均被用户否决 |
| **CLI 是唯一逻辑源** | 业务逻辑只实现一次（`src/`），CLI 是唯一入口；MCP 只转发 CLI；渲染层不复制业务逻辑 | 避免两套实现分叉 |
| **数据改动走 CLI** | 不直接手改 `projects/*.json`（迁移脚本除外）。写盘出口只有 `src/data-store.js` | CLI 提供校验闸门与原子写；直接手改会绕过两者（门禁 G2 只兜住"结果非法"，兜不住"绕过流程"） |
| **DSH 侧边栏独立运行**（v0.16） | 应用自带完整 DSH 运行包（`vendor/dsh`，哈希清单锁定）与**独立数据目录**（`userData/dsh-home`）；侧栏只是视图容器 + 进程管理者（`main-dsh-sidebar.js`）。更新 = 新包装进 `userData/dsh-runtimes/` + `active.json` 原子切换（**换包流程**永不触碰 dsh-home ✓；但**插件/配置导入是另一条受控通道** —— 它就是往 dsh-home 写东西 ✓，见 `docs/DSH-EMBEDDED.md`） | 用户明确要求：独立于全局安装的 DSH；两实例并行实测无冲突（端口/数据/凭据全隔离） |
| **服务驻留与单窗口假设**（v0.16 系列） | dsh web 以 `detached` 孵化（脱离主进程 Job Object，实测主界面退出后存活）；service-info（`userData/dsh-service.json`）承载 {pid,url}，新主界面启动先 adopt（pid+HTTP 双活探测）不新孵化；健康循环 5s pid+HTTP 双探。**当前假设单主窗口**：`state.view/handle` 为单例、`destroy()` 只收割本进程孵化的服务。若未来支持多主窗口，需把 view/handle 所有权改为引用计数 | 拖宽分隔条与服务接管都绑定"一个 contentView"的模型；解耦的价值（重启主界面不掉侧栏）在单窗口下已完整兑现 |
| **token 不进渲染层** | DSH 服务的 token URL 只存在于主进程内存与 loadURL；渲染层只收「侧栏宽度」布局事件与结构化状态（status/visible/error） | 渲染层是高危面（innerHTML 注入 detail）；token 泄进渲染层等于把 DSH 控制权交给任何能执行 JS 的路径 |
| **选项必须逐条声明**（v0.19 系列） | 每条 CLI 命令在 `registry.js` 的 `options` 里声明自己认识的选项；出现未知选项 ⇒ **退出码 1** + 点名 + **打印支持集**（若它是别的命令的选项则直接点名那条命令）。`--key=value` 与 `--key value` 等价；`--expanded` 这类**取值必须合法**（`true`/`false`），非法值当场报错 | 修前写命令对不认识的选项**静默忽略**：`add … --tags a,b` 打印"已添加"、退出码 0，而盘上没有标签（`stats` 的 `taggedNodes` 是 0）。调用方是 AI，它把"0 + 成功话术"当依据 ⇒ 一次静默 = 一条假数据 + 一个自以为成功的 AI。危险点在 `--tags` 在 `edit`/`add-image` 上**是合法选项** ⇒ 跨命令误用极自然 |
| **工作产物区不进受管真值**（v0.19 系列） | `.review/` 的**内容**（目录清单等）不得渲染进受管文档（`docs/VERIFY.md`）；该文档只留一句"见 `.review/*/README.md`"的指针。`.review/<目录>/README.md` 的**死活声明**照旧由 G8 管（`npm run check:docs`） | 修前 `scripts/doc-facts.js` 把 `.review/` 的目录清单+状态渲染进 VERIFY.md ⇒ 任何"只读仓库 + 只写 `.review/`"的核查任务（而写 `.review/` 正是工作产物区的用途）都会让全链在 G6/G7 判红：`✗ 生成物已过期：docs/VERIFY.md`。易变、可随时整目录删的工作区**不能成为真值的一部分**，否则"用它"就等于"改真值" |
| **两个 ✕ 都是"真关"（卸载，而不是隐藏）** | **导图页 ✕** ⇒ 主窗口导航到占位页 `renderer/map-closed.html`（旧文档连同 DOM/JS 堆被卸载）；**侧栏 ✕** ⇒ 收起 + **销毁** `WebContentsView` + 停 DSH 服务。两者重开都是**重新加载**，并还原停靠宽度与"上次的项目"。关之前一律**先拦未保存编辑**（界面弹「保存后关闭 / 取消」；CLI 那条路直接拒绝并带原因）。判据字段进 `getStatus()`：`hasView/viewId/viewEpoch/lastDestroyedViewId/mapPageClosed` | 用户明确选定："**内存里真的不留页面**"（明确否掉了"只隐藏"）。旧做法是两处都不卸载：导图页加 `body.dsh-only`（`#main` 仍 `display:none` 地活着）、侧栏只把 view 从窗口摘下来挂着 —— 渲染层都还在内存里，与"关掉"不是一件事。代价（重开要重新加载，比"隐藏了再显示"慢）**如实写进 README 与占位页** ✓。边界两条：① 渲染**进程**会被 Chromium 复用（实测 `getOSProcessId()` 前后相同）⇒ 文档只说"旧文档被卸载"，不说"进程被替换"；② 控制通道轮询在**主进程**，所以导图页卸载期间通道照常（受影响的只有"发给导图页渲染层"的菜单项，故把它们置灰） |
| **运行包由哈希清单锁定** | `vendor/dsh/manifest.json`（schemaVersion 1）记录全部文件的 size+SHA256；`src/dsh-package.js` 的 `validateRuntime`/`installRuntime` 全量核验。vendor/ 因此**不进 G1 编码门禁与 G6 文档扫描**（2.6 万第三方文件的完整性由哈希清单负责，编码门禁会假红） | 门禁的职责边界：G1 防的是「我们自己写坏文件」，第三方运行时完整性是另一类问题，用另一把锁 |
| **测试不碰真实数据** | 冒烟在 `os.tmpdir()` 的项目副本上运行；`verify` 全链不得修改 `projects/` | 历史上冒烟断言会在真实项目上 `app.save()`，中途崩溃会在真实笔记里残留测试节点 |
| **易腐事实不手写** | 命令数/工具数/用例数/断言数只写在 `docs/VERIFY.md`（生成物）；生成物（`docs/CLI.md`）由门禁校验是否过期 | 同一事实多副本必然漂移（已发生过多次） |
| **AI 迭代验证离屏化** | `--smoke` / `--export-image` 一律在 `show:false` 的离屏窗口里跑（不弹桌面、不抢焦点），并配像素统计断言守住"隐藏仍出帧" | 用户实测：AI 跑验证时窗口弹在桌面上（`createWindow()` 未区分 headless，smoke 与正常启动共用同一创建路径）。离屏的代价是"藏住了但不出帧"这类次生回归 —— 已发生一次，被新增的像素断言抓到；`skipTaskbar` 的 Windows 行为边界见 §2.4 |
| **静默验证分层（L0–L4）与工程偏离** | 画面判定分五级**叠加**，本工程落在哪一级是明确的：**L0** 产物存在/尺寸/哈希可记录（`main.js` 写 `smoke-frame.json`）；**L1** 有效帧「非空、非纯色」（`scripts/vision/frame-stats.js` 统计 + `scripts/smoke/14-headless-window.js` 断言）；**L2** 关键区域 ROI（`scripts/vision/roi-assertions.js`；阈值单源在 `scripts/vision/thresholds.js`）；**L3** 基线差率 —— **延后，不在本工程落地**；**L4** 读图证据（`scripts/vision/record.js` → `.review/vision/`，只产证据、不加门禁）。**偏离点（本工程特有，换项目要重新判断）**：① ROI 矩形**从 DOM 现取**（`getBoundingClientRect` + `devicePixelRatio` 缩放），不写死像素坐标；② 像素统计**与通道序无关**（三通道均值，不用加权亮度），因为 Electron 声明位图格式平台相关；③ 读图记录按**工作产物**落 `.review/vision/`、**不登记 §5、不进验证链**；④ 视觉断言不新增 verify 步，**复用同一次冒烟引导内的同一帧**；⑤ 三级判据的阈值只此一份（`thresholds.js`） | **L3 的触发条件（是延后，不是欠账）**：出现一次「布局回归在**全绿**下溜过」的真实事故 ⇒ 按 **M1** 重新评估并落地；在此之前按 M1「无据不做」（需人确认基线 + 新增 `.raw` 产物形态，且当时无常驻回归事故作据）。**记录过的两处误判**：① 旧规格写「smoke 固定窗口尺寸**已落地**」实测不成立（smoke 只传 `{show:false}`，走的是窗口**默认尺寸**）⇒ **别再把默认值当固定值**，故阶段 2 显式声明 `SMOKE_VIEW`；② 旧规格称缺口是「无任何代码读取截图」，与已有的像素统计断言自相矛盾 —— 真实缺口是「只判空、不判内容」，已由 L2 补上 |
| **文档准入即门禁** | 文档架构表（§5）同时是**准入清单**：新增 `docs/*.md` 必须同批登记，`docs/` 之外不得出现文档；由 **G8**（`scripts/docs-registry-check.js`）机械判定 | §5 原本只是"人读的一句话"，实测两次失守：一份兼有方案与执行记录双性质的表外文档曾漏登记，并抄了一份 CHANGELOG 已有的事实（随后自行漂移）；工程根还散落过 3 份分析稿与 1 份工作笔记 |
| **规则自洽即门禁** | `docs/RULES.md` 是规则的唯一权威副本，但它自己也是**手写**的；其自洽由 **G9**（`scripts/rules-consistency.js`）机械判定：声明条数 == 表格行数、表格未被引用块/空行打断、编号引用闭合、实现列点名的脚本存在、**其他文档转述的条数一致** | 规则清单历史上曾在 6 个文件里各写一份并漂移（README 列 7 条、SKILL 列 6 条），且**漂移掉的恰恰是最要命的那条** —— RULES.md §0 自述。上线 G9 时实测出三处真缺陷：① 本文档 §3 标题写「共 5 条」而表格 6 行；② §2 门禁表被 4 行引用块打断，**G6/G7/G8 掉出表格、渲染成纯文本**（静默消失）；③ `README.md` §九 把铁律条数写成 5（实际 6），且摘要整条漏掉 R3a |
| **并发写入即版本闸门** | 读项目时一并带回**内容指纹**（SHA-1 前 16 位）；写回时若调用方声明了"我读到的是哪一版"，盘上必须仍是那一版，否则**拒绝写入**并报出两侧版本号。**CLI（`cli/core.js`）与 GUI 保存（`main.js` 的 `project:save`）共用同一个闸门**（实现在 `src/data-store.js` 的 `write`）。**v0.16 增补（多路同时编辑）**：拒绝之外再给一条**有安全论证的出路** —— 写命令改走 `ctx.mutate(fn)`；两路改动的**对象集合不相交**（`node:<id>` / `children:<父id>` / `assoc:<id>` / `meta`）时**自动重放到最新版**，相交时**指名拒绝**（报出冲突对象）。判据必须用**重放后实测的差集**，且只写被证明过的那一份数据（`src/concurrency.js` 的 `withReplay`） | 静默丢数据是本工程最重的损害类别。`project:save` 的注释记着两条**实测**路径：内存里是子集时整树写回会删掉其他笔记（曾 7 篇 → 5 篇）；AI/CLI 在界面打开期间写的笔记被渲染层的整树覆盖。原先只对 `assoc` 打了补丁（磁盘优先），**节点树没有** —— 本闸门补的就是它。为什么不用 mtime/size 当版本：mtime 粒度粗到同秒两次写分不开，size 遇到"原地改一个字段"完全不变 —— 两者都会让闸门**静默失效**。**为什么还要增补**：只有"拒绝"时，多路同时编辑的结局是"要么白做、要么被人改成最后写者赢"；而**整文件一个指纹**会把"两个会话改不同节点"也判成冲突。增补后不同节点/不同父节点/不同 assoc 条目的并发编辑**自动合并**，只有真正撞在同一个对象上才拦，且**报出是哪个对象**。**两处落地**：CLI 侧走 `ctx.mutate(fn)`（可重放），**GUI 侧走 `mergeTrees` 三方合并**（渲染层不能"重放用户操作"，只能把两棵树合起来；它还需要 `baseAtRead` 记下"界面读到的那份"）。为什么不做锁、也不做 CRDT：锁在 AI 场景下会死锁/误杀（M1 判定），CRDT 对"节点+字段"粒度是过度设计且会破坏确定性产物。**接线范围（阶段 4 把边界写死，别来回讨论）**：`ctx.mutate` 覆盖全部**读写既有项目**的写点 —— 笔记编辑（`edit`/`assoc`/`links`/`assets`）+ `assoc-prune`/`links-prune`（修复类）+ `import-md`（内容导入）+ `theme-layout`（meta 编辑）。**故意不接**的只有两个，理由各不相同：`init`（**新建**项目，`mutate` 第一步的 `read()` 会直接报"项目不存在"）与 `import-json`（"用这个文件覆盖成新项目"是**显式整体替换**，合并没有语义；它也不声明 `expectVersion`）。**教训（实测）**：项目处于**悬挂状态**（悬挂关联成员/链接）时，**任何写入都过不了校验闸门** —— 所以修复类命令的真实并发场景**只有"另一个修复者"**；给它们做并发测试时，模拟的"外部写入"必须写**合法**数据，否则先被校验拦掉、根本走不到版本冲突 |
| **变更可见性靠"写入闸门顺带记账"，不靠人写** | 唯一写盘出口（`src/data-store.js` 的 `write`；GUI 保存那条路径共用**同一份** `recordChange`）在写盘后往 `projects/<项目>/.changes.jsonl` 追加一条 `{rev, at, writer, version, changed[]}`。`changed` 不是谁手写的 —— 是**用与冲突判定同一套指纹**（`concurrency.changedKeys`）当场算出来的，于是"哪里算冲突"与"哪里报变更"永远同一份定义。`rev` 从日志自身推导（不依赖项目文件里的字段）⇒ **不改数据格式**；有界窗口（最近 `MAX_ENTRIES` 条） | 阶段 1/2 只解决"撞上之后怎么办"，而**更省事的是别撞上**；没有可见性时，会话只能靠"白做一轮"发现自己撞了。**为什么不把历史写进项目文件**：当前状态与变更序列是同一事实的两处表达 ⇒ 必然漂移，且文件无界增长。**为什么删了日志不算故障**：删掉后 `changes` **明说本机没有日志**，绝不把"采不到"说成"没有变更"——这条口径有专门的单测，因为**可见性功能最坏的失效形态是安静地说"没人动过"**（实测踩过：`changedKeys` 返回 `Set`，按数组处理 ⇒ 日志每条都显示"无对象变化"） |
| **文档体系即交接面** | 文档体系的目标是"**任何一个新接手的 AI 都能凭它独立接手**"：`SKILL.md` 顶部给「**接手 5 步**」；`ROADMAP.md` 的「在飞 / 未收口」记"**什么没做完**"，`CHANGELOG [Unreleased]` 记"**最近改了什么**"（两者分工不同，**只读一边就会误判现状**）；`.review/` 每个工作目录用 `README.md` 声明死活；`verify` 留痕"上次全链"结果 | 本工程由 AI 生成、由 AI 长期迭代：**原作者不在场是常态**。零上下文接手演练（2026-09-29）实测：这条链子是通的（演练者自己拼出了加字段的完整步骤与验收判据），但也正是它暴露出"在飞 vs `[Unreleased]` 口径冲突"等 6 处缺口 —— **交接面必须可被检验，不能靠作者自信** |
| **看板不做仓库镜像**（v0.19 系列 · 2026-10-19） | **待办的真源不止一处，分工固定**：`docs/ROADMAP.md`「在飞 / 未收口」= **阶段与外部阻塞**（本仓库唯一的交接面权威）· 工作产物区里的在飞工作稿 = **逐条待做 + 验收判据**（按用户 2026-10-10 裁定留在讨论目录：不进 `docs/`、不进扫描）· **DSH 的 task board = 每张卡推进到哪一步**（仓库外、本机；有工具时 `task_board_list` / `task_board_get` 现场取）。**本仓库不存看板快照、也不把卡搬进 `ROADMAP`。** 能机械化的那部分已落成 G8：**路径类证据指针必须解析得出** + **状态列固定词表**（判定清单见 `docs/RULES.md` §2，本行不复述条数） | **为什么不存快照**：真源在仓库外、没有生成器能跑 ⇒ 只能手工重拍、必然腐 —— 那是给自己造第四份副本。**为什么不把卡搬进 `ROADMAP`**：那会把"执行时的工作台"变成受管文档，每挪一张卡都要一次 git 提交，而卡数**仍是易腐数字**。**实测（2026-10-19，同一天内）**：交接面里写下的「28 张卡」，几小时后同一台机器上的现场读数已是 **42 张**（done 7 / todo 33 / failed 1 / backlog 1）⇒ **一天就腐，而且没有任何门禁抓得到"数字对不对"**。⇒ 交接面能机械判的只有"指针解不解得开"与"状态在不在词表里"；"现在有几张卡"永远由命令当场取（照 §5.0 第 2 条：不写易腐数字，只写去哪取） |
| **归档族与工作产物区分治** | 两处"非活跃内容"规则**不同**：`docs/archive/` + `docs/changelog/` = **归档族**（只增不改、不进 G6 扫描、**必须带历史横幅**、由 §5 前缀行统一覆盖、不需逐份登记）；`.review/` = **工作产物区**（唯一杂物区、可随时整目录删、根下只允许"工作目录"与两个**机器产物**） | 归档是"**要留的历史**"，工作产物是"**随时可丢的草稿**" —— 规则不同才配分开（§5 里"建文件夹的唯一标准"）。另外归档**仍会被 grep 到**：实测 6 份归档里 4 份没有任何标记，接手者搜到旧稿会当成现状 ⇒ 横幅是硬要求 |
| **发布版本 vs 迭代编号** | `vX.Y.Z` **只表示发布版本**（唯一真源 = `package.json`）；内部迭代 / 批次写「v0.16 系列」或「迭代 N」。高于发布版本的 `vX.Y.Z` 由 **G6** 判红（同行带"计划/拟/目标"等字样则放行） | 接手演练实测：`README.md` 写「（v0.16.6 起）」、本文档 ADR 写「（v0.16.2）」，而 `package.json` 是 **0.16.1** —— 演练者原话是"**我无法判断这是笔误还是另一套命名空间**"。同一个符号承载两个含义，等于没有含义 |
| **契约与代码必须对应（门禁）** | `docs/DATA-FORMAT.md` 必须覆盖 `src/schema.js` 校验的字段（清单在 `scripts/docs-registry-check.js` 的 `SCHEMA_FIELDS`，且清单自身要与 schema 对得上）；受管文档的顶级/二级章节**编号必须连续**。两者都由 **G8**（第 11 / 12 条）机械判定 | 契约自述"任何第三方只读本文档就能写出正确的解析器"，而实测 **`meta.layout` 根本不在契约里**（CLI 写它、schema 校验它）；`DATA-FORMAT.md` 还有一处 `2.3 → 2.5` 的断号。缺字段会让接手者照着契约改却漏掉它 —— 这是**可机械化**的损害，所以不做成约定而做成门禁 |
| **文档写作约定** | 五条：① 每行要么**可执行**、要么**可验证**、要么是**"为什么"**；② **不写易腐数字**（要当前值就指路当场取）；③ **一份事实只写一处**（其余用指针）；④ **报错即教程**（门禁判红必须告诉人怎么改）；⑤ **状态类措辞带锚**（"开发中/待办/临时"必须带版本或日期） | 四批里修掉的缺陷 —— 手写体量数字（5 处过期）、README 复制第二份文档清单、`v0.15/v0.16 开发中` 标记躺过两个版本、无锚断言 —— **全是写作方式问题**，而旧规则只管"放哪儿"。写作规范与准入门禁是两件事：门禁只能**事后抓**，写作约定才是**事前不写坏**（全文见 §5 末） |
| **`localPath`：契约里唯一的绝对路径，且只校验形状** | 节点可带 `localPath`（本机目录绝对路径），界面点击即用文件管理器打开。它与 §DATA-FORMAT §5 的「**禁止绝对路径**」并存，**不是自相矛盾**：那条禁令管的是**资源引用**（`images[].file` / `files[].file`）—— 它们必须能在别的机器上解析；`localPath` 是**目录快捷方式**，天生机器本地、没有可移植含义。校验口径：**只校验形状（非空/无换行/≤500），不校验存在性**（盘没挂、目录还没建都正常；加 existsSync 会让"换台机器打开就连 `validate` 都红"）；可选字段 ⇒ **不升 `formatVersion`** | 场景：把本地 Markdown/源码目录建成知识树时，导图与真目录之间没有任何连接。为什么不在校验层管存在性：那是把**环境问题伪装成数据问题**（本工程反复治过的一类误判）。为什么打开动作**复用既有 `app:open-file`** 而不新造 IPC：`shell.openPath` 对目录本来就行 —— 同一件事一种写法。⚠️ 附带一条 headless 约定：`app:open-file` 在 `--smoke` 下**不真的打开**（否则每跑一次 verify 都在机器上弹窗），只做可访问性校验并回报 `headless:true`（显式标志，不是静默降级） |
| **`origin`：来源指纹，批量导入幂等的前提** | 节点可带 `origin`（`{kind,src,sha256,at,tool?}`，见 DATA-FORMAT §2.8），由 `import-project` / `import-md` 写在**一次导入产生的子树的根**上（不是每个节点都抄 ⇒ 条数 ≈ 导入次数）。**批 5 追加（`import-dir`）**：整库导入**两档各留一条痕** —— 项目根写**目录清单指纹**（`src` = 目录、`sha256` = "导了哪些文件、每个内容是什么"的清单哈希）用于"整个目录导过没有"，每个**文件节点**写自己的 `{src, sha256}` 用于"这个文件导过没有"（这样它被 `import-md`/`import-project` 导过也认得出）。两档都只准经 `src/doc-import.js` 的 `makeOrigin`/`makeDirOrigin` 生成。**为什么非有不可**：节点 id 由 `Date.now()`+随机生成 ⇒ **同一份文档导两次得到两棵不相交的树**，事后凭内容判不出"这份导过了"，于是批量/整库导入根本做不到幂等。写盘**之前**比 `src`+`sha256`（`import-project` 扫**全库**、`import-md` 扫本项目）：命中就**拒绝并指名**上次导到哪个项目的哪个节点，`--force` 是显式出口。校验口径同 `localPath`：**只校验形状、不重算哈希**（重算要把源文档读回来，那是环境问题） | 缺陷的根因是一条**结构性**事实：id 生成方式（时间+随机）与"同一份文档"之间没有任何关联 ⇒ 幂等不可能凭空实现，必须先**记下来源**。默认**拒绝**而不是默认放行：重复导入是不可察觉的污染（第二棵树与第一棵不重合，事后无法分辨谁是谁）；`--force` 留给"我真的要第二份"。为什么扫全库：`import-project` 是"从零建项目"，换个项目名再导同一份就是典型的第二次，只看自己的新项目等于没查。为什么 §2.8 的规范化和指纹只有一处实现（`src/doc-import.js`）：界面/CLI/MCP 三条路各拼一个 origin，迟早出现"同一份文件算出两个指纹"（本工程的"同一事实两处表达"病） |
| **围栏代码块是数据，不是结构** | 导入 Markdown 时，` ``` ` 之间的内容**整段原样**进 detail：空行不切断、`#`/`-`/`|` 一律不按标题/列表/表格解析；同时**标题层级要连续**（层级跳跃由 `（层级N）` 占位节点兜底；想让标题成为给定父节点的直接子节点，md 里就用一个 `#`）。另有唯一一处归一化：行尾空白被去掉 | 真实导入任务撞出的静默损坏：修复前"跨空行的围栏被按空行切成多段、各段独立转 HTML"，实测一篇笔记 47 个代码块只有 8 个完整、另一篇出现 50 个**空**代码块与 8 个由 shell 注释产生的**伪标题节点**，案例程序则"Makefile 源 7 行 → detail 只剩 1 行"。之所以定为 ADR 而不是随手改：**"内容悄悄变质"是本工程最重的损害类**（不报错、事后难发现），所以判定成文 + 单元测试 + 导入后逐块比对三重锁住 |
| **接手演练（可重复的验收动作）** | 每个发版周期**至少一次**：让一个**零上下文**的 AI 会话只读本工程（或允许它在**临时副本**上真改一处并跑门禁），要求它回答四问并**如实报告卡点**；记录落 `.review/<日期>-接手演练/`；**每条卡点必须转化为条目或显式写下"决定不做"** | "能被任何新 AI 接手"是对**未来读者 × 未来任务**的断言，**穷举检查在原理上不可能**（任务空间开放、读者在变、事实会自己腐坏）。演练是唯一**不依赖作者假设**的检验手段 —— 前两次演练实测出 12 处缺陷，全部转化成了判定或约定。协议见 §5.1 |
| **详情框的「卫星」与框同级、判据单源** | 圆钮（`.rel-show-btn`）与悬浮工具条（`#mm-node-toolbar`）都住在 `#fd-satellite-layer`——**与 `.float-detail` 同级**（`#mindmap-container` 的子元素），**不是框的子元素**；位置**只从框的 `getBoundingClientRect()` 推导**（`MM.fdBoxFrame`），刷新时机与框**同一批事件**（`positionFdBox` / `syncFdBoxes` / 拖动·改大小 mousemove；窗口 resize 汇入 `syncFdBoxes`）。显隐判据**只有** `MM.fdSatellitePlan()` 一处；**大小锁（`FD_LOCK.SCREEN`）特例**：关工具条、留圆钮，且圆钮的位置/尺寸/可点性**逐字不变**。浮层自己 `pointer-events:none`、子元素各自 `auto`（否则整块画布点不动 ✗）。**判据纪律（写断言的人必读）**：**可见性断言不得只用 `rect` / 类名 / 计算样式** —— `getBoundingClientRect()` 对 `overflow` 裁切是**盲的**；至少要用 ① `document.elementFromPoint(圆心)` 命中它自己，或 ② 真帧像素计数（`scripts/vision/frame-stats.js`）。`rect` 只用来判**几何**（位置/尺寸/相对坐标） | 用户原话：「关联视图按钮和悬浮工具栏的显示渲染逻辑和节点详情严格绑定……大小锁的时候要关闭悬浮工具栏，但是保留视图按钮」。历史两轮都修错了层级：① 圆钮原先写在**框里**、位置交回 CSS（`left:-54px`）⇒ 被**框自己**的 `overflow:hidden` 裁掉 —— 实测同一帧上 `rect` 报"在框外、在面板内"（断言全绿）而 `elementFromPoint` 命中普通 DIV、真帧非白像素 **81**（真的画出来时是 **768**），于是用户两轮反馈（「还是没看到那个按钮」与「按钮位置会浮动」）都出在这里，而上一轮把它归因到**面板**、改成"贴面板边就镜像到右缘"（方向对、层级错）；② 工具条原先 `position:fixed` + 按**节点矩形**定位、只在 `MM.showDetail` 被包住那一刻刷一次 ⇒ 拖动框/改大小/缩放后与框脱钩，且同一显隐判据曾散在 **5 处**。证据：`.review/20261009-圆钮工具栏绑定/probe-clip.js`（裁切根因）、`probe-newsat.js`（新结构五项预检）与 `shots/` |
| **路径解析 / 授权链：判据唯一实现、出口唯一（与内置 DSH 的 Session 授权同形不同主体）** | 「这个路径允不允许开、开了给谁」这件事**只有一处实现** = `src/path-chain.js`（**解析 → 判据 → 出口**三段式；模块职责与六条判据见 §2.3 的 `path-chain.js` 行）。**调用点四处**、全部只**调**它：`renderer/app-media.js` 的附件解析（`attachmentPath` / `attachmentAbsPath`）与预览头（`#fp-open` / 📁 按钮 / 其他类型那条）、`renderer/app-detail-content.js` 的 `openLocalPath`（详情框链接 / 右键菜单 / 预览头的共同入口）与图片区（`MM.imageLinkOf`）。**出口只有一个**：既有 IPC `app:open-file`（**不新开 IPC 名字**；外部链接出口批只给它**多收一个可选参数** `opts.kind` —— 取值表 `EXIT_KINDS` 仍住在本模块，`main.js` 不列自己的候选）；主进程那侧按档**再守一道**：`kind:'system'` 档只校验形状（出口收到的是已解析好的绝对路径，既可能是项目内附件、也可能是工作区外的 `localPath`），`kind:'externalUrl'` 档复核协议白名单/凭据后交 `shell.openExternal`（**这一档就是"节点详情正文渲染的设计稿声称有、实测没有"的那条出口**；`shell.openExternal` 是 Electron 安全清单点名的高危面 ⇒ 它前面必须有判据，而判据只有这一处）。**与内置 DSH 的关系（写在同一处便于比对）**：DSH 宿主文件面按 **Session** 授权，地址是 `dsh-resource://file/session/<sessionId>/<path>`；它接受绝对路径或相对工作区根的路径、**读**不额外要求限定在工作区内（只有**列目录 / 监听**限定工作区，越界报 `workspace-file/outside-workspace`）、拒绝**末端符号链接**、另有两个上限（`maxFileBytes` 32 MiB 与 `maxLines`，取值为 5000）。我们这条链是**同一个形状**，**授权主体换成「当前项目」**；**我们不改 DSH、不引它的代码、也不碰它的 `dsh-home`**。⚠️ 两条**刻意的差异**（别当成"没对齐"）：① 授权主体不同（当前项目 vs Session）；② 本模块**不做 I/O** ⇒ **没有**"末端符号链接拒绝 / 大小上限 / UTF-8 校验"那三条 —— 它们是**读取侧**口径，我们的读取侧是 `app:read-file`（本批未动） | 改动前这件事**散在渲染层四处、判据各不相同**：`attachmentAbsPath` 只做字符串拼接（**零校验**）、预览头两处各自分档、`openLocalPath` 原样交主进程、图片区又是另一行拼接 ⇒ **`..` 逃逸**、**UNC / 设备路径**（`\\?\`、`\\.\`、`\\server\share`）**全部不判**，而"打不开"在几处是**静默**的（点了没反应 —— 本工程反复治过的损害类；先例口径 `docs/DATA-FORMAT.md`「点开会明确报错，不会静默没反应」）。**为什么判据里一次 I/O 都没有**：本机 `X:` 是不可达映射网络盘，一句 `fs.existsSync` 要 **9–21 秒** ⇒ 一律**按形状拒**（这也是"环境问题不当数据问题"的既有口径）。**为什么 `localPath` 必须单开一档**：它本来就是工作区外的绝对路径、契约规定**只校验形状**（`docs/DATA-FORMAT.md` §2.1）⇒ 拿"必须在项目内"去卡它会把今天能打开的 `localPath` **全部打不开**。**为什么先对拍再上线**：等价性不靠读代码判断，靠 `scripts/pathchain-conformance.js` 的**全量对拍**（真实语料差异 0 + 合成边界样本逐条符合期望），读数落 `.review/20261016-路径链抽取/`。**本批不做**：不造内置浏览器、不做"编辑文件"（编辑一律交系统）、不引入任何回写（渲染产物不进 `projects/**`）、不动 CSP 与主窗口 `webPreferences`。**外部链接出口批（2026-10-17）追加**：`http(s)` 链接**真的**交系统默认浏览器了（`kind:'externalUrl'` + `action:'external'`，出口仍是上面那一处 `app:open-file`）—— 补的是**节点详情正文渲染批**"设计稿声称有、实测没有"那条缺口；**仍不做**应用内网页预览、**不动 CSP**、**不动**主窗口 `webPreferences`、**不碰** DSH 与 `dsh-home`；`raw` → `abs` 用的是 `new URL(raw).href`（**判的那一份就是交出去的那一份**，代价是中文域名会变 punycode）。 |
| **不做整个框架模块化** | **不做**：不按功能重切目录、不做"模块级独立编译"、不为模块化改写三个 for-ai skills。**这不是"没评估"** —— 四个候选方案（按层分 / 按功能分 / 折中 / 按"共享可变资产"切）逐条量过，见 `.review/20261016-模块化重构调研/` 的 `调研报告.md` 附录 A 与 `读数.json`（每条读数带复算命令）。**现状已是"该留下的那一档"**：分层图有唯一权威（`scripts/dep-direction-check.js` 的 `LAYERS`，机器可读）且 **S1 门禁在跑**（实测零回边、零环）；文档家目录有 G8/G9；事实数字有 `facts:write` + G6；规则自洽有 G9 | **逐条理由**：① **用户 2026-10-16 亲口判断**「目前这一项目的模块化需求还不是很高，客观来说。」；② 照 skill `architecture-for-ai` 的 **H4**（没有真实事故或实测支撑的抽象 / 分层 / 门禁都是**净成本**）与 **H3**（不给最高频的动作加新成本）⇒ 今天做它是纯支出；③ **真瓶颈是"共享可变资产没有单一写者"，不是目录形状** —— `H4` 要的"真实事故"今天有 5 个一手案例，**全部出在单个文件上**（本文档被两批各改一次冲掉三行 · `CHANGELOG.md` / `RULES.md` / 渲染层注释必须批次隔离才敢提交 · 台账声称某层已落地而仓库无此文件 · `mutate-gates.js` 被点名却从未提交 · 出处引错），**按功能分目录治不了其中任何一条**；④ **"独立编译"在本工程没有对应的动作可做**：零构建步骤、零 bundler、零 TypeScript（`package.json` 的 `scripts` 里没有 build / compile / tsc / bundle），主进程只能有一个入口、渲染层是固定顺序的原生 `<script>` 装进共享命名空间 ⇒ 能机械判定的只有"该文件的 `require` 闭包不越层"这类**近似档**，而**它已经有**（S1）；⑤ 候选"按功能分"会**直接违反**工程第一铁律「这件事只有一处实现」（横切判据会被复制成每模块一份）。**⚠️ 入场阈值（重开这个题目必须命中任一条，且逐条都要现算读数；只凭"更模块化会更好"重开 ⇒ 直接不受理）**：**① 出现"只有动目录 / 分层才能治"的真实事故** —— 事故成因是"同一个功能散在多个目录、一条命令找不全"，且有真实的误改 / 漏改记录（对照组：今天 5 个事故的成因都是单文件写者问题）；**② 现有分层被反复突破** —— S1 判红（回边 / 跨层 / 同层成环）在**不同批次**里出现 ≥2 次，说明 `LAYERS` 这套分层已不敷用（个别越界不算，那是 S1 在正常工作）；**③ "独立编译 / 模块独立发布"变成有消费者的需求** —— 出现第二个运行时或第二份产物需要独立版本与独立发布（今天只有一个 Electron 应用 + 一个 CLI，且 CLI 是唯一逻辑源）；**④ 同一文件因体量在 ≥2 批里各自引发一次"改了 A 漏了 B"的真事故**（这是"该切"的唯一可测形态；只写"文件变大"不算）。**重开时第一步仍然不是切目录**：先把"哪些文件是共享可变资产 + 谁是唯一写者"做成一条能列出越界文件的命令（调研的 T1 原型已跑通），它**与"按功能分目录"无关** |


> **ADR 补充 —— 路径链那批"不在打开链上"的字段：逐类终裁（2026-10-18 · 收尾批）**
> `scripts/pathchain-conformance.js` 把全仓路径类字段扫全了：**在打开链上**的是三类（`files[].file` · `images[].file` ·
> `localPath`），上一段那条链管的就是它们。另外**五类被逐条点名、但去留一直没定**（"取证里点了名、要不要做没定"）。
> 现逐类终裁：**五条都不纳入这条链**，而理由**各自不同**（别合并成一句"不相关"）。
>
> | 字段 | 终裁 | 理由（为什么不该走"解析 → 判据 → 出口"） |
> |---|---|---|
> | `items[].src` | **不纳入** | 它是**出处记录**（`file:line` / URL），不是被打开的对象；渲染层今天**没有**打开入口 ⇒ 纳入等于为一个没有消费者的面新增一条判据（净成本）。哪天要给它开入口，那是**新需求**：届时按 `kind` 新增一档，并**同批**给 UI 与对拍 |
> | `origin.src` | **不纳入** | 它是**导入幂等的比对输入**（与 `sha256` 一起比"这份导过没有"），语义与"能不能打开"无关；且它天然指向**别的机器/别的时刻**的路径（源文件删了也合法）—— 拿打开链的存在性/形状判据去卡它，会把合法的溯源记录判成坏数据 |
> | `links[]` | **不纳入** | 它**不含路径**（`{project, id, caption}` 是站内节点标识）。解析它的是导航面（`switchProject` / 选中 + 展开祖先链 + 滚到目标），**没有任何文件系统动作** ⇒ 塞进路径判据 = 把不是路径的东西当路径判 |
> | `bindings[].dir` | **不纳入** | 工作区绑定的**目录**，消费方是 CLI 的 `bind-sync`（成组读写），不是"点开一个目标"；且它的**授权主体是工作区**、不是"当前项目"—— 与上一段那条链的主体不同（同 §4b 里 DSH 那种"同形不同主体"） |
> | `assoc[].members` | **不纳入** | 成员是**节点 id**，不是路径；打开一篇关联笔记走既有 `assoc` 渲染入口（浮窗），与文件打开无关 |
>
> 不变式（新增一类字段时照这个问）**：只有"被打开的对象"才进这条链**。今天它是三类：附件 / 图片 / `localPath`。
> 新增字段先回答"它是不是被打开的对象" —— 是 ⇒ 走这条链并补 `pathchain-conformance.js` 的对拍；
> 不是 ⇒ **在上表加一行并写明理由**（`scripts/pathchain-conformance.js` 的输出也照此分档，**不许留成沉默**）。
>
> **上面那张表的"理由"只有这一份**（2026-10-19 · 覆盖裁决批补的机械面）：`scripts/pathchain-conformance.js`
> 运行时把这张表**读出来原样打印**（代码里不抄第二份 —— 抄一份必然漂），读不到就 `exit 2` 并指名缺哪几类；
> 而**条数是实测的**：`links[]` 与 `assoc[].members` 这两类旧版**根本没扫**（那时输出里的"0 条"读起来像"没有"，
> 实际是"没看"），本批起如实数出并标注它们**连路径都不是**。⇒ 新增一类字段时，**表与读数两面同时变**：
> 表加一行（理由）；脚本的 `FIELD_CLASSES` 加一条（怎么数、在不在链上）。

## 5. 文档架构（每份文档的作用与边界）

> 原则：**一份事实只写一处**；**易腐的事实靠生成而非手写**；**历史归档，不占活跃视野**。
> 新增文档前先问：它是否与表中某份重叠？能否改为指针？

<!-- BEGIN:registry-table（由各文档头部元信息生成：npm run docs:registry；勿手改）-->

| 层 | 文档 | 作用（存在的唯一理由） | 不该写什么 | 更新方式 |
|----|------|---------------------|-----------|---------|
| 入口 | `README.md` | 产品门面：是什么、能做什么、怎么跑、怎么打包 | 模块表、验证数字、事故记录、路线图 | 手写 |
| 入口 | `SKILL.md` | 触发与导航：何时用、从哪读起、动作现场条目 | 规则全表、命令清单、数据格式 | 手写 |
| 治理 | `docs/RULES.md` | **规则唯一权威副本**：分级（门禁/铁律/约定）+ 强制方式 + 来源 + 元规则 | 具体命令用法、架构理由 | 手写（改规则只改这里） |
| 契约 | `docs/CLI.md` | 命令参考 | —（**勿手改**） | `docs-gen` 生成（G7 校验） |
| 契约 | `docs/DATA-FORMAT.md` | 数据契约：全部字段、版本演进与兼容承诺 | 命令用法、架构理由 | 改 schema 必同步 |
| 契约 | `docs/EXTENSIONS.md` | 扩展契约：稳定性等级、如何新增命令/工具 | CLI 全量签名（指向 CLI.md） | 手写 |
| 契约 | `docs/FEATURES.md` | 产品功能的名字唯一权威 —— 代号 ↔ 中文名 ↔ 一句话 ↔ 承载命令/域 ↔ 实现状态（人与 AI 用同一个词指同一件事） | 命令的完整用法与选项（→ `docs/CLI.md`，生成物）；**"这个功能要不要做"**（→ `projects/卖点讨论` 的待做台账 `bl-3` 子树）；修复/bugfix 与门禁条数（→ `CHANGELOG.md` / `docs/RULES.md` §2）；工程欠账与阶段（→ `docs/ROADMAP.md`「在飞」）；内部模块职责与实现理由（→ `docs/ARCHITECTURE.md` §2） | 手写（新增或改一个功能的名字时**同批**改这里 + 思维导图 `projects/卖点讨论` 的「功能名册」子树；改完跑 `node cli/mm-cli.js validate 卖点讨论` 与 `npm run docs:registry`） |
| 契约 | `docs/ITEM-MODEL.md` | 条目层 v3 唯一契约：条目形状、items↔detail 派生、CLI/模块签名、迁移、并发粒度 | v2 字段全表（见 DATA-FORMAT）、命令完整用法（见 CLI.md）、实现进度与计划 | 改冻结项前先改本文，再同批同步受影响的下游流 |
| 契约 | `docs/TAGS.md` | 7 本书 560 个有正文的节点共用的**一套打标签用词**（39 个标签，每个都带"命中词"判定依据与真实典型节点）与**一套书内关联类型**（`links[].caption` 的前缀约定），使 N 路并行打出的标签可比较、可机械检查 | 打标签的**结果**（那是 `projects/<项目>/<项目>.json` 的 `tags` 字段）；`tags`/`links` 的字段形状与校验（→ `docs/DATA-FORMAT.md` §2.1/§2.5）；`learn-path` 的算法、档位与排序（→ `src/learn-path.js` 文件头注释）；某个标签"该不该存在"的讨论稿（→ `.review/20261020-阶段2标签词表/`）；每本书的目录结构（→ 该书项目自己） | 手写（增/删/改一个标签或一种关联类型时**同批**改 §4 与 §5/§11，再跑 `node scripts/docs-registry-check.js` 与 §8 的词表体检命令） |
| 契约 | `docs/VERIFY.md` | 验证基线（各类计数 + 验证链） | 被测功能说明 | `doc-facts --write` 生成 |
| 设计 | `docs/AI-GUIDE.md` | AI 操作规范：怎么读写、验证链、坑 + **笔记内容写作规范（节点粒度 / detail / caption）** | 工程流程（指向 RULES/ARCHITECTURE） | 手写 |
| 设计 | `docs/ARCHITECTURE.md` | 分层决策与理由、模块职责、架构约束、改哪里 | 具体数字（指向 VERIFY.md）、规则全表 | 手写 |
| 设计 | `docs/DSH-EMBEDDED.md` | 记录「应用内置的独立 DSH 实例」当前被改动成什么样、每项改动属于哪一侧、升级运行包后会不会丢、以及怎么重建/怎么核对 | 不写内核私有常数本身（只写"来源文件+复核命令"，因为它们是易腐数字）；不写会话/消费等运行时状态；不复制 CHANGELOG 的变更叙事 | 每次动内置 DSH（迁移插件、改配置、加应用侧注入、换运行包）后同批更新本表；改完跑 `npm run docs:registry` |
| 记录 | `CHANGELOG.md` | 变更轨迹（`[Unreleased]` + 最近 3 个已发版本段） | — | 每次变更必写；更老的版本段由 `release` 滚动归档 |
| 记录 | `docs/INCIDENTS.md` | 事故与操作禁令 | 功能变更 | 仅事故后追加 |
| 记录 | `docs/ROADMAP.md` | **功能状态视图**：在飞 / 未收口（交接面）、已发版（只回答"这能力有没有"）、已否决 | **版本流水**（那是 `CHANGELOG.md` 的事）、具体计数 | 手写（「在飞」小节发版时清空） |
| 归档 | `docs/archive/*` | 历史快照（回溯用） | —（**勿作现状引用**） | 只增不改（必须带历史横幅） |
| 归档 | `docs/changelog/*` | **滚动归档的历史版本段**（`vX.Y.Z.md`，`release` 自动滚出，保留窗口 3） | —（**勿作现状引用**） | 只增不改；查历史用 `mm-cli changelog --grep` |
<!-- END:registry-table -->

> **文档准入（硬约束，别再靠自觉）**：
> 1. 新增 `docs/*.md` 的**唯一动作**是：在**文档自己的头部**写元信息块
>    （`<!-- registry` + `层/作用/不该写/更新方式` 四行 + `-->`，放在文件前 25 行内），
>    然后跑 **`npm run docs:registry`** 重新生成上表 —— **上表是生成物，不要手改**
>    （手改表格、或改了元信息忘了重生成，**G8 第 13 条**都会判红并给出差异行）。
>    生成物（`CLI.md` / `VERIFY.md`）的元信息块由**它们的生成器**产出（`docs-gen` / `doc-facts --write`）。
>    **没有元信息块的文档视为非法文档**——`docs/` 之外不得再出现文档。
>    **工程根与顶层目录另有白名单**（根只允收入口文档与工程配置文件，顶层目录只允许既有那批）；
>    白名单外出现任何文件/目录 —— 包括 `png`/`json`/`csv`/脚本这类"不是文档的东西" —— 一律判违规。
> 2. 建文件之前先走决策树：
>    **事实** → 已有文档，或 `docs/VERIFY.md`（生成）；**没做完的事** → `docs/ROADMAP.md` 的「在飞 / 未收口」；
>    **执行记录** → `CHANGELOG.md`；**机制/方案设计** → 头部元信息 + 跑 `docs:registry` 建一份「设计」文档；
>    **跨工程可复用的方法论** → 抽为 skill（工程外）；但**双边都不互相引用** —— 本工程只留自己的状态、决策与偏离记录，不维护指向工程外副本的指针（谁不在，另一侧都自足）；
>    **一次性分析稿/汇报稿** → `.review/`（见第 3 条）。
> 3. 工作产物（分析稿、汇报稿、评审稿、读图结论、探针脚本）**不是产品文档**：**统一放工作产物区
>    `.review/<YYYYMMDD>-<主题>/`** —— 这是本工程**唯一**的杂物区：可随时整目录删除、
>    不进版本库（`.gitignore`）、不进 G6 数字扫描（`doc-facts` 的 SKIP），也不进上表的"文档"口径。
>    需要长期存在的，才升格为 `docs/` 文档并登记；旧稿进 `docs/archive/`。
>    **`.review/` 根下只允许两种东西**：① 各任务的**工作目录**（见下条 README 规矩）；
>    ② **机器产物** —— 目前只有两个，都由命令自动写、可随时删、**不要手工编辑**：
>    `.review/verify-tests.json`（`verify` 的第 4 步把 vitest 用例数交给第 8 步，省一次重跑）
>    与 `.review/last-verify.json`（上一次全链的结果留痕，供接手者判断基线）。
>    散落的**手写**文件（探针脚本、临时数据）应当放进某个工作目录里 ——
>    实测曾有 `survey.js` 在根下躺了 6 天、无人知道它还算不算数（已删）。
>    **工作目录必须自带 `README.md` 声明死活**（主题 / 开始日期 / 状态：`在飞` / `已收口` / `已废弃`），
>    状态与 `docs/ROADMAP.md`「在飞 / 未收口」保持一致 —— 否则接手者无法判断它能否删除。
>    由 **G8** 第 9 条判定守着（`.review/` 的直接子目录缺 README 即红）。
>    **归档族**（`docs/archive/` 与 `docs/changelog/`）规则相同：只增不改、不进 G6 扫描、
>    由 §5 的前缀行统一覆盖，**不需要逐份登记** —— 例外只开给"规则确实不同"的目录，
>    这是判断"该不该新建文件夹"的唯一标准（层不同但规则相同的文档，一律平铺在 `docs/` 下）。
>    **归档文档必须在开头带「历史」横幅**（`.md` 用引用块、`.html` 用注释；加横幅不算改内容）——
>    归档不是藏起来，它**仍会被 grep 到**；没有横幅，接手者会把旧稿当成现状。由 **G8** 第 8 条判定守着。
> 4. **由门禁 G8 强制**（`scripts/docs-registry-check.js` / `npm run check:docs`）：**判定清单与能力边界见
>    `docs/RULES.md` §2（此处不复述条数）**，任一不满足即 verify 变红；报错信息直接给出上面三条去向。
>    **规矩同时写在 `SKILL.md` 顶部「落盘规矩」**（新对话的第一屏），因为新 AI 不读完整文档 ——
>    规则必须出现在"它必然会看到的地方"，门禁只是兜底。
> 5. **"现在做到哪了"只住在 `docs/ROADMAP.md` 的「在飞 / 未收口」小节** —— 那是对"AI 生成、
>    AI 维护迭代"的**交接面**：只写现在（不复制"要不要做"）、每条 ≤3 行（结论 + 下一步 + 证据指针）、
>    **发版时清空或移入版本段**。工作产物区的死活由**每个目录自己的 `README.md`** 声明（在飞 / 已收口 / 已废弃）。
>    **这一条里能机械判的都进 G8**（判定清单与能力边界见 `docs/RULES.md` §2，此处不复述条数）：
>    **路径类证据指针必须解析得出**（原先的前缀写死在 `.review/` 上 ⇒ 同一张表里另外几十处反引号
>    **一处都没查**；而裸文件名从仓库根解析不出任何东西，等于**没有**指针）；**状态列必须落在固定词表内**
>    （词表外的词让"要不要做"靠猜）。
>    **「下一步」列那一条进 G9 判定 ⑨**（**不在 G8**）：**非空、且不得只含空话** —— 禁词表只有一处实现，
>    在 `scripts/rules-consistency.js`。为什么单开在 G9：它判的不是"文档有没有家 / 格式对不对"，
>    而是**规则自己承诺的交接面是否兑现**（`docs/AI-GUIDE.md` §4「任一批次收口 / 交接报告必须带一行
>    「主链状态」」是同一件事的**人写那半**）。**能力边界三档（都打印在门禁输出里）**：**判红** = 空 /
>    整格都是禁词 / 采不到真值（无该小节、无表、无「下一步」列）；**只报告** = 禁词出现在更长的句子里；
>    **跳过** = 本节 0 条数据行（"发版时清空"是明文规矩）。⚠️ **它挡不住"写得像动作但是空话"** ——
>    判"动作是否真的可执行"要理解语义，按 M1 刻意不做。
>    **刻意不判的两件（写清代价，别当成漏网）**：
>    ① **本节时点距今多久** —— "多久算旧"没有可判定口径，按日期判红只会造出一条假硬门禁然后被关掉；
>    ② **指针指向的东西是不是真的那条证据** —— 判语义做不到。两条都是**人工残差**，靠改本节的人顺手更新。
>    **待办的真源不止一处，分工固定**：阶段与外部阻塞 = 本节；逐条待做与验收判据 = 工作产物区里的在飞工作稿
>    （不进 `docs/`、不在本表登记）；**每张卡推进到哪一步 = DSH 的 task board（仓库外、本机）**，
>    **本仓库不镜像它**。为什么不做镜像、代价是什么，见 §4b ADR「看板不做仓库镜像」。

> **规则类内容只住在 `docs/RULES.md`。** 其他文档只放"执行该动作时当场需要"的条目 + 指针
> （`docs/RULES.md` 元规则 M2/M3）。

### 5.0 文档写作约定（管"怎么写"，与上面的"放哪里"是两件事）

> §5 上文管的是**位置与准入**（放哪儿、该不该建、谁来守）；这一节管**写法**。
> 为什么需要：四批修掉的缺陷 —— 手写体量数字（5 处过期）、README 复制第二份文档清单、
> `v0.15/v0.16 开发中` 标记躺过两个版本、无锚断言 —— **全是写作方式问题**，
> 而门禁只能**事后抓**。约定本身不可机械化，但它决定了**门禁要抓的东西会不会被写出来**。

1. **每一行都要么可执行、要么可验证、要么是"为什么"**。凑数的行（"本功能很重要""建议注意"）不写 ——
   它们不增加信息，只增加接手者的阅读成本。
2. **不写易腐数字**。要当前值就**指路当场取**（`node cli/mm-cli.js changelog` / `node scripts/doc-facts.js`）。
   必须写历史数值时，同行带锚（`vX.Y.Z` / 快照 / 原记 / 当时 / 曾）。受管文档由 **G6** 判红。
   **行号也属于易腐数字**：引用代码一律"**按符号定位，不按行号**" —— 写 `renderer/x.js` 的
   `函数名` / 选择器 / 唯一字符串（谁读到都能自己跳过去），行号只在**同行**给出并标注日期。
   实测（2026-10-16 核查 → 2026-10-18 复测）：同一批设计稿引用点的位移在两天内从 **+11~13** 涨到
   **+16~37**，`docs/DATA-FORMAT.md` 从 **+47** 涨到 **+98** ⇒ **位移量本身也是易腐事实**。
   现算命令与对照表见 `.review/20261014-节点详情Markdown渲染/设计.md` §⑭。
3. **一份事实只写一处**，其余用**指针**（`见 docs/X.md §N`）。文档清单、规则清单、门禁清单
   都已经各有唯一权威副本 —— 再抄一份就是制造第二个漂移源（README 的文档地图已按此降级为指针）。
4. **报错即教程**：门禁判红时的输出必须**告诉人怎么改**（改哪个文件、跑哪个命令、三条路是哪三条）。
   接手者遇到红时的第一反应是读报错 —— 报错写得含糊，等于把问题丢回给人。
5. **状态类措辞必须带锚**：`开发中` / `待办` / `临时` / `暂不支持` 这类词，**要么带版本或日期，
   要么不要写**。实测：README 把已发版的功能标成"v0.15/v0.16 开发中"，两个版本没人发现
   （`release` 只同步版本号，这类标注无人管；G6 也抓不到它 —— 属于人工残差）。
6. **副本上限（硬约定）：一条规则 / 一份清单 / 一组数字，最多 1 处权威 + 1 处动作现场，第 3 处必须写成指针。**
   - `RULES.md` 元规则 M3 要求"动作现场"留副本（AI 在执行动作时看得到），这是**允许的第 2 处**；
     但它们必须是**摘要 + 指针**，不是逐条复制。
   - 实测（2026-09-29 冗余审计）：门禁清单曾有 **3 份**（README §九 / `RULES.md` §2 / `docs/VERIFY.md`），
     README 那份是纯手工复制且含实现命令 —— 已降级为指针；铁律清单 2 处（RULES 权威 + README 给人看的摘要）
     属可接受上限。
   - 三类"清单"的**唯一权威**分别是：门禁与铁律 → `docs/RULES.md` §2/§3；文档清单 → 本文档 §5 表（**生成**，见下）；
     命令与工具 → `docs/CLI.md`（生成）+ `docs/VERIFY.md`（计数）。
   - 判断方法（可当场做）：拿一条规则去 grep 活跃文档，**>2 处命中就该改指针**。

### 5.1 接手演练（**唯一能检验"初衷是否达成"的动作**）

> 初衷是"任何一个新接手的 AI 都能凭文档独立接手"。这条断言**无法穷举检查**（任务空间开放、
> 读者在变、事实会自己腐坏）—— 只能**反复做实验**。演练就是那个实验：
> **它不依赖作者的假设**，因此能发现作者列不出的缺口（2026-09-29 的两次演练实测出 12 处缺陷）。

**节奏**：每个发版周期**至少一次**（与 `release` 同批做最省事）。

**两种变体**（按当前需要选；第一次做建议只读变体）：

| 变体 | 给新会话的授权 | 能发现什么 |
|------|--------------|-----------|
| **只读理解** | 只读工程内文档与只读命令；**禁止改文件**、禁止 `npm run verify`/`test`/`smoke` 等重命令 | 文档**说不说得清**：能不能自己找到"下一步"、能不能拼出某类任务的完整步骤、有没有自相矛盾的表述 |
| **执行变体** | 在**临时副本**上真改一处（如加一个字段 / 加一条断言）并跑门禁 | 文档**做不做得到**：四步表是否够用、"算做完"的判据是否可执行、门禁报错是否可自救 |

**提示词必须包含**（缺一条结论就不可比）：① 明确"你是**第一次**接手、没有先前上下文"；
② 只读（或：只在**副本**上改，**不许动原工程**）；③ 禁止重命令（只读变体）；
④ 要求回答四问 —— **状态与在飞工作 / 某类任务的步骤 / 写文件的禁令 / 验收标准**；
⑤ 要求**如实报告卡点与困惑**，并声明"报告的价值在于暴露缺口，不在于显得聪明"。

**产出与闭环**：
- 记录落 `.review/<YYYYMMDD>-接手演练/`（该目录须按 §5 第 3 条带 `README.md` 声明死活）；
- **每条卡点必须转化**：要么变成新条目/新判定（走 M1 分级），要么**显式写下"决定不做"及理由** ——
  否则演练等于没做。转化清单写进当次 CHANGELOG。

### 5.2 产物确定性（哪些产物被当真值比、哪些允许不确定）

> 为什么要有这一节：**"被当真值用"的产物必须自己先说清楚它是不是确定的**。
> 生成物（`docs/CLI.md` / `docs/VERIFY.md` / §5 登记表）早就各有"重算逐字比对"（**G7** /
> **G8** 第 ⑬ 条），但那守的是**过期**（render ≠ 磁盘），守不住**不确定**（同一输入两次渲染是否相同）。
> 本工程真吃过这个形状的假红：把工作产物区（`.review/`）的目录清单渲染进受管文档 ⇒
> **新建一个工作目录**就让"生成物已过期"、全链判红 ✗ —— 易变工作区不许成为受判据的输入。
> ⇒ 判定面是 **S3**（`scripts/determinism-check.js`）：
> **真值比**产物必须"同一状态**连续两次**重算逐字节相同"（含时钟 / 随机 / 顺序 / 工作区四类扰动，
> 差异来源可分类）；**允许不确定**产物必须在**生成器里点名标注**"非确定性、不得当真值"。
> 下表与实现**双向闭包**：表里写了没人实现 ⇒ 红；实现了没写进表 ⇒ 红；
> 自述是生成物（头部写"勿手改 / 自动生成"）却没进表 ⇒ 也红。

| 产物 id | 类别 | 重算 / 生成方式 | 谁在守 |
|---------|------|----------------|--------|
| `cli-md` | 真值比 | `cli/commands/release.js` 的 `renderCliDoc()` 重算 ⇒ 与磁盘逐字比对 | `G7` |
| `verify-md` | 真值比 | `scripts/doc-facts.js` 的 `renderVerifyDoc()` 重算 ⇒ 与磁盘逐字比对 | `G7` |
| `registry-table` | 真值比 | `scripts/docs-registry-check.js` 的 `renderRegistryTable(collectDocHeaders())` | `G8` |
| `last-verify` | 允许不确定 | `scripts/verify.js` 每次覆盖写入（时间 / 耗时 / 内存） | `S3` |
| `verify-history` | 允许不确定 | `scripts/verify.js` 追加（同上 + node / host） | `S3` |
| `verify-tests` | 允许不确定 | `scripts/verify.js` 的 vitest JSON reporter（含每文件耗时） | `S3` |
| `smoke-frame` | 允许不确定 | `main.js` 冒烟取景段（分辨率 / 字节 / sha256 / 像素统计） | `S3` |

> **还没判定的那些**（被当真值或当证据用、"两次一致"的判定**尚不存在**）住在**门禁侧的封闭欠账册**里：
> `node scripts/determinism-check.js --debt` 现场取（每条含"为什么是欠账 + 怎么迁 + 什么时候才可能全绿"）。
> 口径是**乙档**：上线时**就带着在册欠账**，册子**只减不增**，不许"一次修干净"✗（一次性全红或
> 硬凑全绿的清单，下场都是被关掉）。差异来源的分类与"哪一类不允许"用 `--list` 现场取。

## 6. 演进指引：每类任务四步（读哪份 → 改哪里 → 跑什么 → 更新什么）

> 面向**新接手的 AI**：拿不准从哪下手时，先在「任务」列找到你这一类，照四列走完即可。
> 「更新什么」一列是**同一次改动里必须做完的**（缺了会被门禁或 R5 连带核对抓出来）。

| 任务 | ① 读 | ② 改 | ③ 跑 | ④ 更新 |
|------|------|------|------|--------|
| 加 / 改 CLI 命令 | `docs/EXTENSIONS.md`（稳定性等级） | `cli/registry.js` + `cli/commands/*.js`（逻辑尽量下沉 `src/`） | `node cli/mm-cli.js docs-gen` → `npm run verify` | `docs/CLI.md`（生成）+ `CHANGELOG.md` + `README.md` |
| 加渲染功能 | `docs/ARCHITECTURE.md` §2.1（模块职责） | `renderer/app-*.js`（逻辑）+ `editor.js`/`contextmenu.js`（交互）+ `style.css` | `npm run verify` | 在 `scripts/smoke/NN-*.js` 的**对应分域**加断言 + `CHANGELOG.md` + `README.md` |
| 改数据格式 | `docs/DATA-FORMAT.md`（契约；字段表在 §1 与 §2.x） | `src/schema.js` + 迁移逻辑 | `npm run verify`（其中的 **G2** 就是 `validate-all`） | `src/schema.js` 版本号 + `docs/DATA-FORMAT.md`（**同批**，否则 G8「契约缺字段」判红）+ `CHANGELOG.md` + `README.md` |
| **改 / 加写盘路径**（CLI 命令 / GUI 保存） | 本文 §4b ADR「并发写入即版本闸门」+ `src/concurrency.js`（逐对象指纹 / 重放 / 三方合并） | **CLI**：命令体走 `ctx.mutate(fn)`，别自己 `read()` 再 `write()`；`fn` 里**不做 I/O / 打印 / 物理写盘**（并发重放会再调用它一次），结果用闭包变量带出。**GUI**：`project:save` 走 `mergeTrees` 三方合并，**别退回"一律拒绝"**；冲突要回报**对象名**，且 headless 下**不弹模态框**（会把冒烟卡死）。**接线边界**：见 §4b ADR 的"接线范围" —— `init` 与 `import-json` 是**故意**走裸写的，别顺手改 | `npm run verify`（并发行为由 `scripts/smoke/15-write-conflict.js` 分域断言守着） | `CHANGELOG.md` + `README.md`；新增 `src/` 模块要登记进本文 **§2 模块表**（否则 **G8「未入档代码」判红**） |
| 加 IPC | `preload.js` 现有通道 | `main.js`（处理器）+ `preload.js`（暴露）+ 渲染层调用点 | `npm run verify` | 冒烟断言覆盖新通道 + `CHANGELOG.md` |
| 加 MCP 工具 | `docs/EXTENSIONS.md` §6 | `scripts/mcp-server.js` 的 `TOOLS` + `case` 分支（只转发 CLI，不写逻辑） | 端到端：写文件再读回 + `npm run verify` | `CHANGELOG.md` + `README.md` |
| **加 / 改门禁** | `docs/RULES.md` §1（分级）与 §2（门禁表 + 边界写法） | `scripts/*.js` + 挂进 `scripts/verify.js` 的 `STEPS`（含 `budgetMs`） | **先注入一次违规证明它会红，再撤销**；然后 `npm run verify` | `docs/RULES.md` §2 登记（含**能力边界**）+ `tests/*` 锁判别力 + `CHANGELOG.md` |
| 改文档体系 / 放文档 | `docs/ARCHITECTURE.md` §5（层 + 准入 + 在飞规矩 + §5.0 写作约定） | 在**文档自己的头部**写元信息块（生成物则由其生成器产出） | `npm run docs:registry`（重生成登记表）→ 自检（`check:docs` 等），**验收仍须 `npm run verify`** | `CHANGELOG.md`；需要时 `README.md` |
| 发版 | `docs/ROADMAP.md`「在飞 / 未收口」（该清了） | —— | `node cli/mm-cli.js release --minor`（**不是** `release minor`）→ `npm run verify` → `npm run dist` | CHANGELOG / package.json / config.js / lock / README **由命令自动同步**；「在飞」小节人工清空 |
| **动 DSH 侧栏 / 运行包** | 本文 §2.5 + §4b ADR（哈希清单锁定 / 原子切换 / rollback）+ `docs/CLI.md` 的 `dsh-*` | `scripts/vendor-dsh.js`（制包）或 `userData/dsh-runtimes/` 换包；**永不触碰 `dsh-home`**（用户数据） | `npm run dsh:maint -- verify` + **`npm run dsh:e2e`** + **`npm run dsh:resident`**（后两个**不在 verify 里**：需真实冷启动，慢）+ `npm run verify` | 本文 §2.5 / ADR 的哈希与切换说明 + `CHANGELOG.md`（含"旧包可 rollback"一句） |
| **加 / 改断言**（冒烟 / 集成 / 单测） | `scripts/smoke/NN-*.js` 的分域划分 + `docs/RULES.md` R3（分层：核心→单测 / 命令→集成 / 渲染→冒烟） | 放**对应分域**文件（不要塞进入口）；集成断言放 `scripts/cli-integration.js` | `npm run verify` | `npm run facts:write`（**断言数是 G6 真值**，不同步就判红）+ `CHANGELOG.md` |
| **从导出恢复**（**`R1a` 禁用 `git checkout`/`restore`/`stash` 时的唯一手段**） | `docs/INCIDENTS.md`（两次全损与派生禁令）+ `docs/AI-GUIDE.md` §4.1 + `export-json` / `import-json` 用法 | **不要直接覆盖在用项目**：先 `import-json <备份.aimap.json> --name 恢复验证` 导成**临时项目** | `node cli/mm-cli.js validate 恢复验证` → 用 `read`/`export-md` 抽查内容是否完整 | 确认无误后决定"替换在用项目"还是"合并"；**CHANGELOG 必须记：何时、从哪份备份、恢复成什么** |
| 打包 | `electron-builder.yml` | —— | `npm run dist` | 打包后**冒烟一次** + `CHANGELOG.md` |

> **③"跑"的口径（唯一，消歧）**：**验收 = `npm run verify` 全链全绿**（步骤数 / 每步命令 / 预算的**唯一定义**在 `scripts/verify.js` 的 `STEPS`，`docs/VERIFY.md` 的链表由它渲染 —— **此处不复述条数**；G7 与 G6 共用一次运行 ⇒ 末尾打印的"实跑 N 步"比步骤数少 1；**总预算 700s**）。
> 单个门禁脚本（`npm run check:docs` / `check:rules` / `check:visibility` / `facts` / `check:encoding`）只是**自检**，
> 用来快速迭代（实测文档类四步合计十几秒），**任何一条都不能当作"做完了"** ——
> 它们只是全链的子集，全链还含单测 / 集成 / 冒烟 / 数据校验。
> （此前本表的"③跑"列写的是子集命令，而 `RULES.md` R3 / README / AI-GUIDE 写的是全链，
> **接手演练实测指出这是灰区**：不知道子集是否被全链覆盖。现统一为全链，子集只作自检。）

> **"改坏了怎么办"（恢复 runbook —— **唯一**手段是导出文件，但**理由已订正**）**：
> ⚠️ **2026-10-19 订正（原文前提已假）**：本节长期写着「本工程 Git **零提交**（`.git/objects` 被 EDR 拦）⇒ 所以没有 `git checkout` 可救」。
> **实测该前提已不成立**：仓库现在有提交历史，`git log` 可查。
> **但"不能靠 git 救"这个结论仍然成立，理由换成了规则**：`docs/RULES.md` §3 **`R1a` 明令禁止** `git checkout` / `git restore` / `git stash`——
> 因为它们会**成片回退**别人（或别的会话）在同一棵树上的改动，而那种损失**不可见、不可追**。
> ⇒ 恢复仍然走下面四步；区别只是**别再以为"git 是空的"**（那样会让人放弃 `git log` / `git show` 这些**只读**的取证手段 ✗）。
> 恢复按这四步走，**顺序不能换**（第二步是关键：先验证、别覆盖）：
> ① **找**最近的工程外导出（`D:/backup/ai-mind-map/` 之类；`verify` 每次会打印它的新鲜度）；
> ② **验**：`node cli/mm-cli.js import-json <备份.aimap.json> --name 恢复验证`
>    —— 导成**临时项目**，**绝不要直接覆盖在用项目**（`import-json` 本身就是"导入为**新**项目"，正好安全）；
> ③ **查**：`node cli/mm-cli.js validate 恢复验证` + 用 `read` / `export-md` 抽查内容（图片在 `.aimap.json` 里是 base64 内嵌，单文件即可整体回滚）；
> ④ **决**：内容无误后再决定"替换在用项目"还是"手工合并"；无论哪种，**CHANGELOG 必须记清楚：何时、从哪份备份、恢复成什么** ——
>    否则下一次接手者会以为那是原生的数据。
> **没有工程外导出 = 没有兜底**：`backups/` 在工程内、与工程同盘，磁盘级事故会一起丢。

> 另有三条**横切**规矩（不属于某类任务，任何改动都可能踩到）：
> ① 加写盘路径 → 复用 `src/data-store.js` 的 `writeFileAtomic`（禁止裸 `writeFileSync`）；
> ② 加版本号引用 → 读 `src/config.js` 的 `APP_VERSION`（禁止硬编码字面量）；
> ③ 加全局监听 / 观察者 → 放进带幂等守卫的 `bind*` 函数（**禁止内联在 `renderMind`**，会随每次重建累积）。

## 7. 高频读取入口的字节量级（`G-14`）

> **为什么这一节住在这里，而不是 `docs/RULES.md`**：`RULES.md` 写的是"**必须遵守什么 + 怎么强制**"；
> 而"`read --json` 对 `comnet` 那 889 个节点（**快照**读数，见 §7.2 那张表；节点数随数据变）大概多大"
> 是**设计事实** —— 它跟着 `cli/commands/project.js` +
> `src/query.js` 的读取形状走，属于架构。**规则里放数字没人守，架构里放形状可以复算。**
> 门禁（`tests/read-size.test.js`）只守这个量级的**上界**，**不复制**这里的读数：读数随数据变，
> 上界不随数据变（见 §7.4 的"为什么不绑真书"）。
> 相关：`docs/CLI.md`（生成物：命令用法）· `docs/AI-GUIDE.md`（该用哪一档）· `docs/RULES.md` §3 `R3`（分层测试）。

### 7.1 哪些入口算"高频读取"（口径：三条同时满足）

① **不改笔记数据**（旁路埋点不算改数据，且可用 `MM_HEAT_SENSOR=off` 关掉）—— 高频调用的前提是"随时可调"；
② **是"决定下一步做什么"的入口** —— 即 `SKILL.md` 动作现场里"读"的那几条：`list` / `read` / `get` / `search`；
③ **一次会话里可能被调一次以上**（不是一次性命令）。

| 入口 | 增长形状 | 上界的写法（**量级**，不是读数） | 谁守 |
|------|---------|------------------------------|------|
| `list --json` | O(节点数) | `≈ 节点数 × 200 B` | `tests/read-size.test.js` |
| `read --json` | O(节点数)，常数由**详情密度**决定 | `≈ 节点数 × 2000 B` | 同上 |
| `read --json --brief` | 同上，砍掉详情与资源清单 | `≈ 节点数 × 600 B` | 同上 |
| `read --json --brief --compact` | 同 `--brief`，再去掉缩进 | `≈ 节点数 × 450 B` | 同上 |
| `get --json` | **O(1)**（与节点数无关） | `≤ 2048 B / 次` | 同上 |
| `search --json` | 由 `--max-bytes` **自己声明** | `≤ 声明的 maxBytes + 信封（约 4096 B）` | 同上 |

**不在这一节的三类**（各有理由，不是漏了）：

- **`export-json`**：产出是**文件**（不进上下文），体积由**内嵌资源**（base64 图片 / 附件）驱动。
  当时测得：`comnet` 项目 JSON 1.24 MB → 导出文件 ≈ 9.2 MB，7.4 倍**全部来自 assets**，而节点数一个没变。
  ⇒ 它不是"节点数 × K"的形状，套那个上界只会得到假判据（`tests/read-size.test.js` §C 把这条理由变成了读数）。
- **`validate` / `stats` / `orphans` / `backlinks` / `mentions`**：不在"读来决策"的主链上（要么只给计数，要么只给关系），
  且目前没有大输出的实测，**不凭空给它定上界**。
- **一次性导出 / 迁移命令**（`export-md` / `export-html` / `import-*` / `migrate`）：同上，且体积由"内容 + 资源"决定。

### 7.2 当次实测读数（**快照**：2026-10-20 · 样本量 = 3 个项目各调 1 次）

**口径三条，读的时候别换**：① 量的是**字节数**（不是字符数 —— 中文 1 字 ≈ 3 字节，拿字符数会把体积算小约 3 倍）；
② 量的是 **stdout 原始字节**；③ 跑时设 `MM_HEAT_SENSOR=off` ⇒ 埋点零写入，`projects/` 的文件清单与字节数**前后指纹一致**
（52 个文件 → 52 个，是一项**测出来的**事实，不是"我看着没写"）。
机器产物：`.review/20261020-测试补全/read-size-readings.json`；复算整张表的命令：
`node .review/20261020-测试补全/probe-read-size.js`。

| 项目（节点数） | `list` | `read` | `read --brief` | `--brief --compact` | `get`（单节点） | `search --limit 20` |
|---|---|---|---|---|---|---|
| `卖点讨论`（293） | 当时 ≈ 53 KB | 当时 ≈ 498 KB | 当时 ≈ 142 KB | 当时 ≈ 98 KB | 当时 152 B | 当时 ≈ 2.5 KB |
| `comnet`（889） | 当时 ≈ 132 KB | 当时 ≈ 1.17 MB | 当时 ≈ 301 KB | 当时 ≈ 185 KB | 当时 289 B | 当时 ≈ 8.3 KB |
| `book-linux-proc-mem`（126） | 当时 ≈ 20.5 KB | 当时 ≈ 163 KB | 当时 ≈ 57 KB | 当时 ≈ 37 KB | 当时 245 B | 当时 961 B |

⇒ **长期有效的那一句是形状，不是上面那些读数**（当时那次跑出来的复算区间）：
`list ≈ 节点数 × 150–190 B` · `read ≈ 节点数 × 1.3–1.8 KB`（详情贡献 862–1246 B/节点，**这就是"详情占比决定省多少"的量化版**）·
`--brief ≈ 节点数 × 350–500 B` · `--brief --compact ≈ 节点数 × 210–340 B` · `get` 与节点数**无关**（0.15–0.3 KB/次）。

### 7.3 拿它做决策（上下文预算怎么花）

- **先问"我要的是结构还是内容"**：同样 889 个节点，`list` 是 ≈ 132 KB 而 `read` 是 ≈ 1.17 MB —— 当时测得差 **8.8 倍**。
  只知道"有哪些节点"就别读全文。
- **定位到分支后再定点**：`read --subtree <id>` 只把某个分支当根建视图（口径见 `src/query.js` 的 `buildReadView`），
  `get --json` 则是 **O(1)** 的单节点实况（≈ 0.3 KB，**不带 `detail`** —— 这是铁律，也有机器判据）。
- **要正文就明说**：`get` 不带 `detail`；取正文走 `read --json` 的对应节点、`read --items` 或 `get --item`。
- **检索自带预算**：`search --json` 的命中数组按 `--max-bytes` 卡（默认值与上下界是 `src/item-index.js` 的常量，
  **本页不抄那个数**），截断时 payload 里 `truncated: true` 并给 `budget.resume` —— 别把"截断"读成"只有这么多"。

### 7.4 门禁与它的边界

- **门禁**：`tests/read-size.test.js`（单测层，**不在** `npm run verify` 的门禁表里）。
  判据 = `对固定夹具，输出字节数 < 上界 × 2`，其中 `上界 = 节点数 × MAG[入口]`（`get` 是常数上界，
  `search` 用**它自己声明的** `budget.maxBytes`，不另抄一份预算常量）。
- **能被打红**：`MAG` 是"量级上界"而不是读数（实测 152–185 B/节点 vs `MAG` 200），
  所以入口**多带一个字段**、**少做一次裁剪**都会按节点数成比例越界；另有两条直接的判别力用例 ——
  边界（上界×2 减 1 绿 / 等于即红）与"`get` 若哪天带出 15360 B 正文 ⇒ 必红"。
- **⚠️ 边界（不绑真书，这是有意的）**：真项目数据每天在改，把门禁绑到"当前三本书的读数"上，
  它会**因为数据变了**而翻红 —— 那是假红，而假红的下场是这条门禁被人关掉（`docs/RULES.md` §3 的同型教训）。
  ⇒ 真书只用来**定标**（写进本节，带样本量），门禁跑在**固定夹具**上：夹具不变 ⇒ 读数可复现。
- **这条门禁判不了什么**：① **`detail` 的"该不该这么大"** —— 它只判"有没有超出量级"，判不了"这本书的详情是不是写太长了"；
  ② **资源体积**（图片 / 附件）—— 已被 §7.1 排除在 `export-json` 上界之外；
  ③ **`search` 命中**的"该不该这么多" —— 那是 `--limit` / `--max-bytes` 的调用方选择，不是入口的形状问题。

