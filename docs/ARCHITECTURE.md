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
| `app-detail-content.js` | `renderFdBox` 内容渲染（含 `dc.innerHTML = detail`）+ 容器/resize/节点层观察者接线 |
| `app-media.js` | 图片灯箱、附件预览（md 内联渲染 / pdf 内嵌）、`renderRelated`（相关知识点面板） |
| `app-audit.js` | 关系审计面板：呈现 `orphans`/`mentions` 清单，**漏链接可一键补链接**（写操作走 CLI） |
| `app-palette.js` | 命令面板（Ctrl+P）：模糊搜索节点与命令；排序用 `src/palette-rank.js` |
| `app-assoc.js` | **「关联笔记」二级页面**：渲染关联实体页（标题/成员列表/正文）+ 编辑对话框（标题与正文）；从节点详情的「相关知识点」区进入。**并在该区渲染「展示关联节点」按钮**（功能 2 的入口，恒常出现——没有关联笔记也可能有链接关系）。**assoc 的内存同步只有一处实现**：`MM.syncAssocRaw`（按 id 合并、**不能整体替换**——整份替换成子集曾导致保存时删掉别的笔记）；`MM.assocAddFromView` 是"关联视图里新建一篇"的唯一落点（IPC → CLI `assoc-add` → 回读同步 → 取回视图）。**圆钮 🔗 是详情框的卫星**：住在 `#fd-satellite-layer` 里、用 `data-fd-box` 与框一一对应、框一关就被 `MM.dropFdSatellites(boxId)` 收干净（同生命周期 ✓）；落位的唯一实现在 `MM.layoutRelShowBtn()`，取钮 / 反查框是 `MM.fdRelShowBtnOf(boxEl)` ↔ `MM.fdBoxOfSatellite(btn)` **这一对**（圆钮不在框里了 ⇒ `btn.closest('.float-detail')` 永远是 null ✗，靠它判"在框外不遮挡"会静默判错） | `MM.syncAssocRaw(list)` / `MM.assocAddFromView(project, centerId, members, title, noteMd)` |
| `app-import.js` | **拖拽文件 ⇒ 导入成新项目**（功能 5a 的拖拽入口）：投放提示覆盖层、取路径、如实报结果。**两条入口一个实现**：菜单走主进程的 `importDocDialog`，拖拽走这里，最后都调 `importDocToNewProject`。**取路径必须走 `desktop.app.pathForFile()`** —— Electron ≥32 起 `File.path` 已被移除，`webUtils` 只有 preload 拿得到（这是渲染层唯一的取路径方式 ✓）。不支持的扩展名**说清楚**（不静默失败）| `MM.importDocFile(path)` / `MM.importHandleFiles(FileList)` / `MM.showDropHint()` / `MM.hideDropHint()` |
| `app-ask.js` | **节点悬浮工具条 + AI 问答浮窗**（功能 1 界面层）：选中节点（= 出现详情框）后弹出工具条；**工具条锚在详情框上**（`data-anchor=box`：默认贴框**下缘外侧** +6；框高到下方放不下就**翻到上缘外侧** −6；再放不下才夹进面板 —— 档位写 `data-place`；只有选区、没有框时才退回"贴选区外接矩形上方并夹进视口"，`data-anchor=nodes`，`scripts/smoke/29-multiselect.js` ④ 要求它必须出现）。**显隐与落位的唯一实现是 `MM.layoutNodeToolbar()`**：改前判据散在 5 处（包 `showDetail` / 包 `closeFdBox` / 点别处 / 内部两条早退 / 选区变化），于是**只在"开框那一刻"刷一次** ⇒ 拖动框、改大小、缩放后全脱钩（用户报的"浮动/滞后"）；现在两条猴子补丁已拆掉：目标由**框池**推导（`MM.fdPrimaryNodeBox()`）、框一关自动收起；**大小锁时收起**（圆钮不受影响）。浮窗**复用详情框组件**（`createFdBox`）从而自带拖动/改大小/📌🖥 锁/让位 —— 这正是"视觉与节点详情一致"最省力的达成方式 ✓。后端走 `app:ask`（main.js）→ `cli ask` → `dsh headless`，**每问一次是一次独立会话**（界面上明说，不假装连续对话）；冒烟里后端返回 `stub:true` 的桩，界面**必须**把它标出来（`.ask-stub`，有断言守）。**N 的口径**：多选时按钮写「💬 问这 N 个」，N = **原始命中集**（`MM.getSelectionRaw()`，= 用户"点过谁"= 画面上真的带虚线描边的那些），**不是**裁剪集（`fdSelection` 是给收起/拖动这类树操作定义的口径，父也在选区时会把子节点剔掉 ⇒ 拿它计数会与画面和实际提问集合都对不上 ✗）。工具条 `data-count`、按钮文案里的数、真正送出去的 `nodes` 三者同源 ✓（`scripts/smoke/36-real-input.js` ④ 用真点按钮 + 真键盘 + 桩回显钉住它）| `MM.showNodeToolbar(id)` / `MM.hideNodeToolbar()` / `MM.layoutNodeToolbar(layer, frames, view)`（唯一落位实现）/ `MM.showAskBox(id, {kind, focus})` / `MM.renderAskPage(box)` / `MM.computeBarPos(rect,w,h,view)`（纯几何，可判） |
| `app-related.js` | **关联节点可视化**（功能 2）：按 `src/related-model.js` 的模型把关联节点**缩放至刚好框住**（`MM.setViewTransform` 一趟算出 s/x/y）、高亮它们并轻微虚化其余（**只写 CSS 类** —— jsMind 会重写内联样式）、在 `fdViewEls()` 里的 SVG 关系层画虚线（随导图同变换 ⇒ 平移缩放零重算），点线按**鼠标位置**开关联笔记（大锁钉住 = 不跟导图跑）。模型缺 `src/related-model.js` 时**响亮抛错**（不静默退化）。**并承载「关联信息」编辑条**（`#mm-rel-edit`，进视图即出现、与视图同生命周期）：链接清单（出边/入边逐条 ✕ 删）· 添加链接（输入即搜 = `app.nodes` + `src/palette-rank.js`）· 新建关联笔记（成员小标签，走 `MM.assocAddFromView`）；`fitToNodes(ids, insetTop)` 会**让出编辑条占掉的顶部高度**，否则"刚好框住"会把最上面那排节点藏在条底下。**链接改动写内存只有一处实现**：`MM.applyLinkToMemory`（补链接与删链接共用，`app-audit.js` 的补链接也走它） | `MM.showRelated(id)` / `MM.clearRelated()` / `MM.isRelatedActive()` / `MM.scheduleRelatedRedraw()` / `MM.applyLinkToMemory(opts)` / `MM.isRelatedEditBarOpen()` / `MM.relatedEditBarEdges()` / `MM.setViewTransform({s,x,y})`（在 app-view.js） |
| `app-actions.js` | 保存闸门与未保存判定（`isDirty`）、**并发冲突的两条出路**（`resolveConflict`：用磁盘版本 / 保留我的）、快照撤销重做、节点增删改、搜索、项目加载/切换、MD 导入导出 |
| `app.js` | **接线层**：`wireUI()` + `window.MMApp` 对外导出 + `DOMContentLoaded` 启动 |
| `editor.js` | **交互层**：编辑/图片/附件对话框、快捷键、MD 导入导出文件选择；只调 MMApp API，不直接改状态 |
| `contextmenu.js` | **交互层**：节点/背景右键菜单 + 双击节点打开编辑对话框 |
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
| `registry.js` | **命令注册表**：每条命令的 name/aliases/usage/desc/fn；**新增命令必须在此登记**（docs-gen 依赖它）。当前命令数见 `docs/VERIFY.md` |
| `core.js` | 上下文工厂：参数解析（--key value / 位置参数）、DataStore、校验闸门、项目读写封装；**`ctx.mutate(fn)` = 多路同时编辑的入口**（读→改→写，并发时按 `src/concurrency.js` 的规则自动重放或指名拒绝） |
| `commands/project.js` | 项目级命令（只做"读参数 → 调 src/ 纯逻辑 → 输出"）：projects/read/list/get/search/stats/init/import-md/export-md/**export-html**/export-json/import-json/validate/validate-all |
| `commands/edit.js` | 节点编辑：add/add-root/edit/move/remove/clone |
| `commands/assets.js` | 图片与附件：add-image/remove-image/assets/add-file/remove-file/files |
| `commands/links.js` | 跨项目链接：link/unlink/links/links-prune（清理悬空链接 —— 别的项目删了目标节点后本项目的自救路） |
| `commands/ui.js` | 界面控制**三条命令**：`sidebar-only <on\|off>`（on = **真卸载导图页**（这一页的内存被释放，主窗口只剩占位页）、只留 DSH 侧栏；off = 重新加载导图页）、`dsh-sidebar <on\|off>`（**保留主界面**、关/开侧栏 DSH，off 连服务一起停并销毁侧栏视图）、`dsh-status`（**只读**诊断：视图在不在/导图页关没关/可见性/总占宽/窄宽模式/是否横向溢出，白名单输出不含 url/token）。存在理由：改哪一半就只关哪一半 ⇒ **不必重启整个应用**；改侧栏布局前先 `dsh-status` 拿数字，别凭肉眼。走文件式控制通道（`src/control.js`），**没有回执即报错**（界面没在运行时不许假装成功）；**被界面拒绝**（如导图页有未保存编辑）时转述原因，与"没响应"分开报 |
| `commands/relations.js` | 引用关系：backlinks（单向反查）/ related（出边+入边双向合并）/ orphans（关系审计）/ mentions（未链接提及） |
| `commands/assoc.js` | 关联笔记（N 元关联实体）：assoc-list/assoc-add/assoc-edit/assoc-remove/assoc-prune（参数处理 + 读写 + 输出；纯逻辑在 `src/assoc.js`） |
| `commands/release.js` | 工程命令：docs-gen（从 registry 重生成 `docs/CLI.md`）/ release（发版）/ **changelog**（CHANGELOG **只读**窄查询：段/条目索引或按关键词检索正文）。`changelog` 的索引从正文**现算**、不落生成物 —— 详见 `src/changelog.js` 的 `indexChangelog` 注释（为什么不做成生成文件） |
| `commands/changes.js` | **变更可见性**（只读，阶段 3）：谁、何时、改了哪些对象。数据来自唯一写盘出口顺带产生的 `projects/<项目>/.changes.jsonl`；`--since <rev\|版本号>` 回答"自那以来改了什么"。⚠ **答不了时报错并非 0 退出**（锚点滑出窗口 / 本机无日志）——**不等于"没有变更"** |

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
| `relations.js` | 引用关系计算（纯逻辑，依赖注入） | `backlinksAll()`（谁引用我）/ `relatedAll()`（出边+入边合并、标注 out/in/both） |
| `assoc.js` | 「关联笔记」实体（N 元关联，纯逻辑） | `parseMembers`/`includes`/`forNode`/`memberLabel`/`autoTitle`/`pruneMembers`/`validateAssoc`/`validateAll`/`genId`（`MIN_MEMBERS`=2；成员是否存在由 `schema.validateProject` 读盘检测） |
| `links.js` | 链接剪枝纯逻辑（与 assoc 同源的"删节点→悬空"问题） | `pruneLinks(root, shouldRemove)`（**就地修改**树、删空则去键）/ `allLinks` / `inbound(root,project,id)` / `targetKey` |
| `mentions.js` | 「未链接提及」计算（纯逻辑） | `findMentions(root, opts)` 本项目内；`findCrossMentions(projects, self, opts)` 跨项目 in/out（同名歧义标 `ambiguous` 而非乱猜） |
| `palette-rank.js` | 命令面板的模糊检索与排序（纯逻辑） | `fuzzyScore`（**null 表示不匹配**，分数可为负）/`rankPalette`（空查询时命令在前） |
| `export-html.js` | 静态站点导出（纯逻辑，无 IO） | `buildIndexHtml`/`buildModel`/`collectAssets`/`safeJson`；相关知识点内联为可跳转链接 |
| `query.js` | 查询与视图构造（纯逻辑） | `buildReadView`/`buildNodeList`/`getNodeView`/`computeStats`/`searchNodes`/`treeLines` —— **决定 AI 看到什么** |
| `bundle.js` | aimap v1 打包格式（Node 侧纯逻辑） | `buildBundle`/`parseBundle`/`collectResourceRefs`/`isSafeRelPath`（路径穿越防御） |
| `doc-import.js` | **大文档 → 提纲的前端**（功能 5a，Node 侧同步）：**一个建树入口、四种前端** —— md 直接用、txt 走启发式（短行+前后空行+不像列表/网址 ⇒ 标题；`第一章`/`1.1` ⇒ 层级）、docx 自己解最小 zip（**零依赖**：node 自带 zlib 解 deflate ✓，读 `word/document.xml` 的段落与 `Heading1..6` 样式）、**pdf 起小进程读**（`scripts/pdf-outline-helper.mjs`：**有书签走书签，无书签回退文字层** —— 纯逻辑在 `src/pdf-text.js`）。四者都先变成"带 `#` 的 Markdown 提纲"再交给 `markdown.js` 建树 ⇒ 只有一套树构建规则。**边界**：txt 的标题识别是尽力而为（认不出就是正文，绝不丢内容）；docx 不支持 ZIP64/加密（**响亮抛错**）；PDF 无书签且文字层也用不上时**响亮拒绝**并给出路（带数字，不许当文本读进去 ✗）；`.doc/.epub` 等**认识的但不支持**的格式直接拒绝。**容错**：剥掉 BOM（实测带 BOM 的 md 会让首行 `#` 匹配不上、吃掉第一个标题 ✗）| `detectFormat`/`textToOutline`/`docxParagraphs`/`docxToOutline`/`docToOutline`/`zipFindEntry`；`UNSUPPORTED` 清单 |
| `pdf-text.js` | **PDF 文字层 → 行/段/标题层级的纯逻辑**（P0）：`TextItem[]` → 行（`LINE_FACTOR=0.2`）/ 段（`PARA_FACTOR=1.8`）/ 标题层级（三判据并行：**字号 ≥ 基准×1.15** / **居中且在本页前两个内容行内** / **无歧义中文编号且"孤立"**；正文基准字号按**字符数**取众数）；外加**文字层闸门**（单页 < 20 字符且页数 > 1 ⇒ 疑似扫描页）与最小页眉页脚剔除（首尾各 2 行的重复/页号形态）。**三条硬事实写进实现**：字号只能取 `transform[3]`（`TextItem` 没有 fontSize ✗）、字体只能用 `fontName`（Chromium 的 `styles[].fontFamily` 恒为 `"sans-serif"` ✗）、中文正则自己写（Calibre 只抄方法不抄代码 —— 它是 GPLv3 ✗）。纯函数：不做 I/O、不 await ⇒ 单测喂合成 items 即可（挂在小进程里被调用）| `buildOutline(pages)` → `{ok, reason, md, headings, paragraphs, lines, stats, notes}`；单项：`itemsToLines`/`linesToParagraphs`/`bodyFontSize`/`numbering`/`headingHit`/`assignLevels`/`assessTextLayer` |
| `related-model.js` | **「关联节点」可视化模型**（功能 2）：把 `assoc` 与 `relations` 的**两处既有结果合成**成一个可画的图 —— 成员并集、去重、每条边带"为什么相关"（哪篇关联笔记 / 哪条链接）。**不是** `relations.js`/`assoc.js` 的重复实现：那两个各算**一种**关系（且跑在 Node 侧），这个只负责**合并成显示用的图**并定口径（跨项目只标不画；成员 > `CLIQUE_MAX`(8) 时只画星形）。**它的输入是既有 IPC 的返回形状**，所以不新增任何后端逻辑 ✓ | `buildRelationModel({nodeId, project, assocItems, relatedItems})` → `{members, edges, crossProject, assocCount}` |
| `sidebar-context.js` | **⑨「送进 DSH 侧栏」的文本编排**（纯函数）：把选中的节点编成一段投喂文本（抬头写项目与个数、多节点逐个编号、带路径/标签/正文，正文按 `DETAIL_MAX`(600) 截断并**标明**截断）。**为什么单独成模块**：`renderer/*.js` 是 IIFE、node 里 require 不了 ⇒ 文本逻辑写在渲染层就**无法单测** ✗；放这里则渲染层（`<script>`）与 node 单测**共用一份** ✓。⚠️ 它只**编文本**，不发送、不碰 DOM ✓（发送由 renderer 调 `desktop.dsh.prefill` ⇒ 主进程 ⇒ 侧栏输入框；**不代替用户按发送** ✓） | `buildSidebarText(projectName, nodes)` → string；`DETAIL_MAX` |
| `drop-target.js` | **跨视图拖放（P7）的落点判定**（纯函数 ✓ 可单测）：屏幕坐标换算 `toScreenRect` + 命中判定 `isPointInSidebar` —— 侧栏是原生 WebContentsView，指针进去后渲染层收不到 mouseup ✗ ⇒ 由主进程轮询光标并用本模块判定"松手是否落在侧栏上" ✓；边界（未打开/零宽/坐标非数字）一律安全退化不误判 ✓。单测见 `tests/drop-target.test.js`。 |
| `version.js` | 版本号纯逻辑 | `isValid`/`parse`/`bump`（低位归零）/`compare` |
| `changelog.js` | CHANGELOG 的发版变换（Node 侧纯逻辑） | `releaseChangelog(text, next, date)`：按**段落边界**改写 `[Unreleased]`（早期两次 `String.replace` 写法会把段首占位行带进版本段）；无变更内容时拒绝发版 |
| `config.js` | 常量（版本/默认值） | `MMConfig`（`APP_VERSION` 是版本号单源） |
| `changes.js` | **变更日志的纯逻辑**（无 I/O）：构造/序列化/解析条目、分配单调 `rev`、有界窗口裁剪、`since` 判定（**"答不了"与"没有变更"必须可分辨**）、按对象归并 | `buildEntry`/`serializeEntry`/`parseLog`/`appendLog`/`since`/`groupByObject`/`lastEntry`；文件名与上限在此定义（`FILE_NAME`/`MAX_ENTRIES`） |
| `data-store.js` | 项目文件读写（Node 侧） | `createStore(rootDir, validate)`：list/read/write/assetDir/attachmentDir/**writeFileAtomic**；`write` 在 `expectVersion` 不符时抛 **`code='VERSION_CONFLICT'`**（错误码单源在 `concurrency.js`，调用方**只认码不认文案**），成功时回传 `{file, version}`；**每次写入顺带记一条变更日志**（`recordChange`，实现只有一份，GUI 保存那条路径也调它） |
| `concurrency.js` | **并发编辑的"可安全重放"核心**（纯逻辑，无 I/O） | `fingerprint(data)`（逐 `node:<id>` / `children:<父id>` / `assoc:<id>` / `meta` 指纹）/ `changedKeys(a,b)` / `intersection(mine,theirs)` / **`withReplay(io, fn, opts)`**：两路改动**不相交 ⇒ 自动重放到最新版**（双方改动都保留）；**相交 ⇒ 指名拒绝**（绝不静默覆盖）；`replayable:false` 供不可重复执行的动作用 |
| `dsh-package.js` | DSH 独立运行包的解析/校验/安装/回滚（v0.16，Node 侧） | `validateRuntime`（全量哈希）/`resolveRuntime`（bundled/installed，坏状态**报错不降级**）/`installRuntime`（幂等导入+原子切 active）/`rollbackRuntime`/`acquireRuntimeLock`（运行锁/维护锁互斥） |
| `dsh-ask.js` | **向内嵌 DSH 提一个一次性问题**（功能 1 的后端，Node 侧）：走运行包自带的 `dsh headless "<prompt>"`（实测退出码 0 / 极简提示词 **4.4 s** / stdout **只有答案一行**）；**提示词构造是纯函数**（`buildAskPrompt`：自动补齐项目/路径/正文/相关节点 ⇒ 这是"AI 收到什么"的唯一定义处），运行器的 `spawn` 可注入 ⇒ 单测能验参数与环境而不真起进程。失败**绝不当成功**：非 0 退出 / 空输出 / 超时都是 `ok:false` 并带原因 | `buildAskPrompt`/`buildContextBlock`/`buildAskArgs`/`buildAskEnv`/`resolveAskRuntime`/`askOnce`；`KINDS`={explain,ask} |
| `dsh-capabilities.js` | DSH 能力边界（纯逻辑：解析装配清单 + 合成模型） | 支撑 `dsh-caps` 命令：回答"某能力到底挂没挂载"，防"以为不具备其实有"与反向误判 |
| `dsh-sidebar-skill.js` | 侧栏 AI 的**指针 skill 内容生成**（纯函数） | `buildSidebarSkillContent(projectRoot)`：应用孵化内嵌实例时写入 `dsh-home/skills/ai-mind-map/SKILL.md` |
| `ui-state.js` | 「界面有未保存编辑」的跨进程协调信号（纯逻辑 + 文件契约） | 读写 `projects/<项目>/.ui-state.json`，支撑"写前协调"（CLI 侧 `ui-state` 命令读它） |
| `control.js` | **界面控制通道**（纯文件读写，不 require electron） | userData 下 `mm-control.json`（命令）/ `mm-control-result.json`（回执）；界面每 400ms 轮询执行一次。为什么不用 socket/命名管道：本机受限环境禁命名管道、网络要走代理 —— 文件是唯一到处都成立的通道。CLI 侧 `sidebar-only` / `dsh-sidebar` 都靠回执判"真生效"；**两个方向各关一半**（关左页留侧栏 / 留主界面关侧栏）⇒ 改一侧不必重启整个应用 |
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
  支撑「边聊边编辑」的界面实时同步）。
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
- `preload.js`：contextBridge 暴露 `window.desktop`（projects/project.save/asset.import/
  app.exportMd/app.importMd/app.version/on/dsh.status/onProjectDiskChange）。渲染层**无 Node 权限**，只能走 IPC。
- **保存闸门**：`project:save` 先把数据写临时文件 → 跑 `mm-cli validate` →
  通过才 rename 覆盖正式文件；坏数据拒收且不污染原文件。
- **保存时的并发处理（多路同时编辑）**：盘上版本 ≠ 渲染层读到的那一版时，**能合就合、合不了才拦** ——
  用三方（`baseAtRead` 记的"界面读到的那份" / 界面内存 / 盘上最新）走 `src/concurrency.js` 的 `mergeTrees`：
  两边改的对象**不相交 ⇒ 自动合并**（双方改动都保留）；**相交 ⇒ 不写盘**、把**冲突对象名**回报给渲染层，
  由它让用户二选一（`MMApp.resolveConflict('theirs')` = 用磁盘上的版本，**只丢冲突对象上的改动**；
  `'mine'` = 保留改动、本次不保存）。**headless 下不弹模态框**（没人回答会把整轮卡死 —— 主进程回 `headless` 标志）。
- **外部编辑冲突规则**：渲染层收到磁盘变更时，**无脏改动 → 静默重读**（AI 编辑实时上屏）；
  **有脏改动 → 绝不覆盖人的编辑**，只提示冲突由人决定（数据安全优先于自动同步）。
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

### 2.6 脚本层（scripts/ —— 验证链、门禁与一次性工具）

> **新接手的 AI**：想知道"验证是怎么跑的、门禁在哪、工具怎么用"，看这张表即可。
> **`scripts/` 下每个文件都必须在本表出现** —— 由 **G8** 第 7 条判定守着（加脚本忘登记会变红）。

| 文件 | 职责 |
|------|------|
| `verify.js` | **验证链的运行器**：`STEPS` 是"执行顺序 / 每步命令 / 耗时预算"的**唯一定义**，`docs/VERIFY.md` 的链表由它渲染；首败即停 |
| `encoding-check.js` | **G1** 文件编码完整性（UTF-8 BOM / U+FFFD / 经典乱码特征） |
| `docs-registry-check.js` | **G8** 文档体系完整性（**判定清单现场取**：`npm run check:docs -- --judgments` 会从实现的**全部**判定标记打印全套；条数由 `docs/RULES.md` §2 声明并与标记机械对齐 —— **本表不复述**，复述一次就是第二份会漂移的副本）；`--write` 从各文档头部元信息**生成** §5 登记表（`npm run docs:registry`，`npm run check:docs` 为校验模式） |
| `rules-consistency.js` | **G9** 规则文件自洽：声明条数 == 表格行数、表格未被空行打断、编号引用闭合、实现列点名的脚本存在、其他文档的条数转述一致、**门禁声明的判定条数 == 实现脚本的判定标记数**（且标记唯一；实现脚本文案里也不得写死条数）；逐条清单见 `docs/RULES.md` §2，**本表不复述** |
| `visibility-judge-check.js` | **V1** 可见性判据门禁：扫描 `scripts/smoke/*.js`，凡**名字**里声称可见性（可见/不可见/遮挡/面板内/框外/看得见/看不见）的断言，判据必须是**真判据**（`document.elementFromPoint` 命中测试 ⇒ 抓遮挡；`scanRegion` / `isAccentBlue` / `bitmapInfo` 等真帧像素 ⇒ 抓裁切）或一行显式豁免 `判据-豁免: <原因>` —— 只用 rect / 类名 / `style.display` 判"可见"的断言**对裁切与遮挡是盲的**（实测：同一元素被父元素 `overflow:hidden` 裁掉时 rect 读数与正常显示**完全相同**，而真帧像素 81 px vs 768 px）⇒ 它在"用户根本看不到"时照样绿 ✗。判定清单现场取：`--list`（逐条分类）· `--debt`（既有欠账，**只减不增**，含"为什么是欠账 + 怎么迁"）· `--selftest`（**判别力自检**：内存注入 ⇒ 必红 ⇒ 撤销 ⇒ 必绿，不碰任何文件）；`npm run check:visibility` 单跑。**能力边界**：它查判据的**来源**，查不了判据用得对不对（`elementFromPoint` 也能传错坐标）；名字里不写可见性词的断言它抓不到 ⇒"**名字要说清凭什么判**"是配套纪律（名字是这门禁的输入 ✗）。⚠️ **编号是 V1 而不是 G 号**：门禁编号的唯一权威是 `docs/RULES.md` §2，而本门禁上线时该文件正被另一个会话占用（脏文件、禁止提交）⇒ 待它交回后并入 §2（界时只改 `scripts/verify.js` 的 gate 串、本行与两处 `tests/` 期望；**不是**再挂一个门禁） |
| `doc-facts.js` | **G6/G7** 文档数字与版本一致性 + 生成物是否过期；`--write` 生成 `docs/VERIFY.md` |
| `cli-integration.js` | **G4** 全部 CLI 命令端到端断言（进程内调用，临时项目自动清理） |
| `smoke-assertions.js` | **G5** 冒烟断言清单入口：自动发现并按文件名顺序拼接 `scripts/smoke/NN-*.js`（入口只做 require + 拼接；另导出 `files` / `groups` 供单跑选子集，`.length` 仍是**全量**真值） |
| `smoke-select.js` | 冒烟**单跑**选择器（纯函数，可单测）：把 `SMOKE_ONLY=20,21` / `--smoke-only=20,21` 解析成要跑的断言文件，**永远并入 `01-*` 预热**；**一项都不匹配 ⇒ 抛错**（采不到真值 = 红），避免"筛错名字却跑出 0/0 passed"的假绿 |
| `changed-plan.js` | **「改动面 → 必跑集」的映射**（纯函数，可单测）：把 `git diff` 出的文件清单映射成该跑哪几步（+ 冒烟该收窄到哪些域）。**保守优先**：认不出的路径一律**全量**（这是它唯一允许"多跑"的方向 ✓）；`G1/G8/G9` 恒定跑（G8 还管"新代码文件必须入档"）；干净工作树 ⇒ **一步都不跑**（不许跑两件卫生门禁假装验证过）。`verify.js --changed` 是唯一调用方 —— 它会打出"**这不是全量真值**"横幅、把记录写进 `.review/last-verify-changed.json`（**不覆盖** `last-verify.json` 那句"上次全链"）、历史标 `partial: true`（耗时基线也不认它 ✓） |
| `smoke-flags.js` | 冒烟/离屏路径额外的 **Chromium 保帧开关**（纯函数，可单测）：照搬 Playwright 给 Chromium 的四个默认开关（三个 `disable-*` + `enable-features=CDPScreenshotNewSurface`），治"隐藏窗口不出帧 / 定时器被降频"引发的**假红**。**只在 `--smoke` 路径生效**（正常启动必须为空 —— `tests/smoke-flags.test.js` 有接线检查），"真的加上了"由 `scripts/smoke/14-headless-window.js` 断言。**效力在 Electron 上的验证未完成**，判据是 `verify-history.jsonl` 里 G5 的假红率与耗时趋势 |
| `smoke-input.js` | **冒烟专用「真输入 + 截图证据」驱动**（唯一实现）：用 Electron 自带的 `webContents.sendInputEvent` 发**真实**鼠标/键盘事件（`mouseMove/mouseDown/mouseUp/mouseWheel` + `modifiers:['control']` + `char/keyDown`），走 **Chromium 的真实输入管线** —— 命中测试、修饰键、hover、拖拽阈值、浮层遮挡全都在内；合成事件 `dispatchEvent` **整条绕过**这些（本工程 25-域记过"断言绿、功能坏"的真实事故 ✗）。截图证据用 `capturePage` 落 `.review/<工作目录>/shots/`（**不进版本库** ✓），判定用的帧与落盘的那张**同源**（`captureUntil` 一起返回）✓。**为什么不是一条 IPC 通道**：冒烟断言本身就跑在**主进程**（`ctx.exec` 只是主→渲染的桥），而这两个 API 都是主进程 API ⇒ 直接挂在 `ctx` 上；"非冒烟模式完全不可用"由**三重**保证：① 只在 `runSmoke()` 里构造（正常启动的进程里不存在）；② `createDriver()` 见 `isSmoke !== true` **直接抛**；③ `tests/smoke-input.test.js` 有单测 + **源码级接线检查**（照 `smoke-flags.js` 那套 ✓）。用法与边界（隐藏窗口可能给旧帧 ⇒ 像素判据一律前后差分）写在该文件头 ✓ |
| `vendor-dsh.js` | 制作独立 DSH 运行包（`vendor/dsh`，含哈希清单；一次性/更新时重跑） |
| `dsh-maintenance.js` | 运行包维护 CLI：导入 / 切换 / 回滚 / 列表 / 校验（`npm run dsh:maint`） |
| `dsh-e2e.js` | DSH 独立实例端到端（孵化→401/200→收割）—— **不在 verify 里**（需真实冷启动，慢） |
| `dsh-resident.js` | 驻留语义端到端（宿主退出→服务存活→新宿主接管→显式停止）—— **不在 verify 里** |
| `dsh-resident-host.js` | 上面那条用的一次性宿主进程（被 `dsh-resident.js` 拉起） |
| `dsh-assembly-probe.js` | 回答"某插件 id 能不能被 profile patch 打到"（读运行时合成结果，不看装配文件） |
| `dsh-token-ratio.js` | 实测 DSH token 启发式的真实偏差（诊断用，非门禁） |
| `dsh-embedded-overrides.js` | **内置 DSH"本地覆盖值"的渲染器**（`render [--dry-run]` / `check`，`--home` 指向 dsh-home，`--runtime` 指向内置运行包）：把 `<dsh-home>\.embedded-overrides.json` 里的**陈述式**差异**幂等**渲染进 `profiles\web\cordis.patch.yml`。**它是那份 patch 的唯一写者**（新增"要渲染进 patch 的东西"请扩这里，别再开第二个写者 ✗）。两类被渲染的东西：**① 标量覆盖**（改已存在条目的已存在键；白名单 4 个条目，白名单外**报错退出**、不猜）；**② agent preset 声明**（`"$presets": {"<id>": {cloneFrom, order}}` ⇒ 插入一条 `@deepseek-ai/dsh-agent-preset` 行）—— 清单**从运行包自带的 `presets/<cloneFrom>.patch.yml` 生成**、只替换其中的 persona 文本，**不把清单抄进本仓库**（抄一份就是又一份会随内置 DSH 升级漂移的副本 —— 见 `docs/DSH-EMBEDDED.md` §5 的「快照漂移」✗）。写盘前先复制 `.bak-<时间>`；`check` 除比标量外，还会把生成块与"现在重新生成的结果"**逐行比对**（手改/半截都会被抓到）。**为什么需要**：那份 patch 是**生成物**，手改态既不可复现、事后也无人知道曾改过 —— 实测已发生一次（台账 A3）✗；写成 overrides 才能"重放一次就回到同一状态" ✓。纯函数与 CLI 端到端见 `tests/dsh-embedded-overrides.test.js`（22 条，全部在临时 home 上跑） |
| `dsh-embedded-check.js` | **内置 DSH 升级后自检**（只读，不起 Electron；`--home` / `--json`）：10 项三态 `PASS/FAIL/UNKNOWN`（**UNKNOWN ≠ 通过** ✗），对照真值取自迁移回执 `receipt-migrate-*.json` 与它指向的 `packageDir\manifest.json`。**为什么需要**：内置实例的现状**只存在于 `%APPDATA%` 的现网状态里**，换运行包/重跑导入后"哪些改动还在"没有别的机械判据（台账 A3 就是靠它才发现手改已丢）；它读的是机器本地状态，**故意不进 verify**（会破坏"验证链可移植"这条前提）⇒ 它是 skill `embedded-dsh-maintain` 的必跑项 ✓ |

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
3. **可测性优先**：核心逻辑全部可 headless 验证（npm test / npm run smoke）。
4. **零运行时依赖**：生产代码只用 Node 内置 + 本地 vendor；npm 依赖仅限
   electron / jsmind / vitest(dev) / electron-builder(dev)。
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
| **归档族与工作产物区分治** | 两处"非活跃内容"规则**不同**：`docs/archive/` + `docs/changelog/` = **归档族**（只增不改、不进 G6 扫描、**必须带历史横幅**、由 §5 前缀行统一覆盖、不需逐份登记）；`.review/` = **工作产物区**（唯一杂物区、可随时整目录删、根下只允许"工作目录"与两个**机器产物**） | 归档是"**要留的历史**"，工作产物是"**随时可丢的草稿**" —— 规则不同才配分开（§5 里"建文件夹的唯一标准"）。另外归档**仍会被 grep 到**：实测 6 份归档里 4 份没有任何标记，接手者搜到旧稿会当成现状 ⇒ 横幅是硬要求 |
| **发布版本 vs 迭代编号** | `vX.Y.Z` **只表示发布版本**（唯一真源 = `package.json`）；内部迭代 / 批次写「v0.16 系列」或「迭代 N」。高于发布版本的 `vX.Y.Z` 由 **G6** 判红（同行带"计划/拟/目标"等字样则放行） | 接手演练实测：`README.md` 写「（v0.16.6 起）」、本文档 ADR 写「（v0.16.2）」，而 `package.json` 是 **0.16.1** —— 演练者原话是"**我无法判断这是笔误还是另一套命名空间**"。同一个符号承载两个含义，等于没有含义 |
| **契约与代码必须对应（门禁）** | `docs/DATA-FORMAT.md` 必须覆盖 `src/schema.js` 校验的字段（清单在 `scripts/docs-registry-check.js` 的 `SCHEMA_FIELDS`，且清单自身要与 schema 对得上）；受管文档的顶级/二级章节**编号必须连续**。两者都由 **G8**（第 11 / 12 条）机械判定 | 契约自述"任何第三方只读本文档就能写出正确的解析器"，而实测 **`meta.layout` 根本不在契约里**（CLI 写它、schema 校验它）；`DATA-FORMAT.md` 还有一处 `2.3 → 2.5` 的断号。缺字段会让接手者照着契约改却漏掉它 —— 这是**可机械化**的损害，所以不做成约定而做成门禁 |
| **文档写作约定** | 五条：① 每行要么**可执行**、要么**可验证**、要么是**"为什么"**；② **不写易腐数字**（要当前值就指路当场取）；③ **一份事实只写一处**（其余用指针）；④ **报错即教程**（门禁判红必须告诉人怎么改）；⑤ **状态类措辞带锚**（"开发中/待办/临时"必须带版本或日期） | 四批里修掉的缺陷 —— 手写体量数字（5 处过期）、README 复制第二份文档清单、`v0.15/v0.16 开发中` 标记躺过两个版本、无锚断言 —— **全是写作方式问题**，而旧规则只管"放哪儿"。写作规范与准入门禁是两件事：门禁只能**事后抓**，写作约定才是**事前不写坏**（全文见 §5 末） |
| **`localPath`：契约里唯一的绝对路径，且只校验形状** | 节点可带 `localPath`（本机目录绝对路径），界面点击即用文件管理器打开。它与 §DATA-FORMAT §5 的「**禁止绝对路径**」并存，**不是自相矛盾**：那条禁令管的是**资源引用**（`images[].file` / `files[].file`）—— 它们必须能在别的机器上解析；`localPath` 是**目录快捷方式**，天生机器本地、没有可移植含义。校验口径：**只校验形状（非空/无换行/≤500），不校验存在性**（盘没挂、目录还没建都正常；加 existsSync 会让"换台机器打开就连 `validate` 都红"）；可选字段 ⇒ **不升 `formatVersion`** | 场景：把本地 Markdown/源码目录建成知识树时，导图与真目录之间没有任何连接。为什么不在校验层管存在性：那是把**环境问题伪装成数据问题**（本工程反复治过的一类误判）。为什么打开动作**复用既有 `app:open-file`** 而不新造 IPC：`shell.openPath` 对目录本来就行 —— 同一件事一种写法。⚠️ 附带一条 headless 约定：`app:open-file` 在 `--smoke` 下**不真的打开**（否则每跑一次 verify 都在机器上弹窗），只做可访问性校验并回报 `headless:true`（显式标志，不是静默降级） |
| **围栏代码块是数据，不是结构** | 导入 Markdown 时，` ``` ` 之间的内容**整段原样**进 detail：空行不切断、`#`/`-`/`|` 一律不按标题/列表/表格解析；同时**标题层级要连续**（层级跳跃由 `（层级N）` 占位节点兜底；想让标题成为给定父节点的直接子节点，md 里就用一个 `#`）。另有唯一一处归一化：行尾空白被去掉 | 真实导入任务撞出的静默损坏：修复前"跨空行的围栏被按空行切成多段、各段独立转 HTML"，实测一篇笔记 47 个代码块只有 8 个完整、另一篇出现 50 个**空**代码块与 8 个由 shell 注释产生的**伪标题节点**，案例程序则"Makefile 源 7 行 → detail 只剩 1 行"。之所以定为 ADR 而不是随手改：**"内容悄悄变质"是本工程最重的损害类**（不报错、事后难发现），所以判定成文 + 单元测试 + 导入后逐块比对三重锁住 |
| **接手演练（可重复的验收动作）** | 每个发版周期**至少一次**：让一个**零上下文**的 AI 会话只读本工程（或允许它在**临时副本**上真改一处并跑门禁），要求它回答四问并**如实报告卡点**；记录落 `.review/<日期>-接手演练/`；**每条卡点必须转化为条目或显式写下"决定不做"** | "能被任何新 AI 接手"是对**未来读者 × 未来任务**的断言，**穷举检查在原理上不可能**（任务空间开放、读者在变、事实会自己腐坏）。演练是唯一**不依赖作者假设**的检验手段 —— 前两次演练实测出 12 处缺陷，全部转化成了判定或约定。协议见 §5.1 |
| **详情框的「卫星」与框同级、判据单源** | 圆钮（`.rel-show-btn`）与悬浮工具条（`#mm-node-toolbar`）都住在 `#fd-satellite-layer`——**与 `.float-detail` 同级**（`#mindmap-container` 的子元素），**不是框的子元素**；位置**只从框的 `getBoundingClientRect()` 推导**（`MM.fdBoxFrame`），刷新时机与框**同一批事件**（`positionFdBox` / `syncFdBoxes` / 拖动·改大小 mousemove；窗口 resize 汇入 `syncFdBoxes`）。显隐判据**只有** `MM.fdSatellitePlan()` 一处；**大小锁（`FD_LOCK.SCREEN`）特例**：关工具条、留圆钮，且圆钮的位置/尺寸/可点性**逐字不变**。浮层自己 `pointer-events:none`、子元素各自 `auto`（否则整块画布点不动 ✗）。**判据纪律（写断言的人必读）**：**可见性断言不得只用 `rect` / 类名 / 计算样式** —— `getBoundingClientRect()` 对 `overflow` 裁切是**盲的**；至少要用 ① `document.elementFromPoint(圆心)` 命中它自己，或 ② 真帧像素计数（`scripts/vision/frame-stats.js`）。`rect` 只用来判**几何**（位置/尺寸/相对坐标） | 用户原话：「关联视图按钮和悬浮工具栏的显示渲染逻辑和节点详情严格绑定……大小锁的时候要关闭悬浮工具栏，但是保留视图按钮」。历史两轮都修错了层级：① 圆钮原先写在**框里**、位置交回 CSS（`left:-54px`）⇒ 被**框自己**的 `overflow:hidden` 裁掉 —— 实测同一帧上 `rect` 报"在框外、在面板内"（断言全绿）而 `elementFromPoint` 命中普通 DIV、真帧非白像素 **81**（真的画出来时是 **768**），于是用户两轮反馈（「还是没看到那个按钮」与「按钮位置会浮动」）都出在这里，而上一轮把它归因到**面板**、改成"贴面板边就镜像到右缘"（方向对、层级错）；② 工具条原先 `position:fixed` + 按**节点矩形**定位、只在 `MM.showDetail` 被包住那一刻刷一次 ⇒ 拖动框/改大小/缩放后与框脱钩，且同一显隐判据曾散在 **5 处**。证据：`.review/20261009-圆钮工具栏绑定/probe-clip.js`（裁切根因）、`probe-newsat.js`（新结构五项预检）与 `shots/` |

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
>    **发版时清空或移入版本段**；证据指针指向的 `.review/<目录>` 由 **G8** 校验存在（防指针腐烂）。
>    工作产物区的死活由**每个目录自己的 `README.md`** 声明（在飞 / 已收口 / 已废弃）。

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
| **从导出恢复**（零 Git 下唯一手段） | `docs/INCIDENTS.md`（两次全损与派生禁令）+ `docs/AI-GUIDE.md` §4.1 + `export-json` / `import-json` 用法 | **不要直接覆盖在用项目**：先 `import-json <备份.aimap.json> --name 恢复验证` 导成**临时项目** | `node cli/mm-cli.js validate 恢复验证` → 用 `read`/`export-md` 抽查内容是否完整 | 确认无误后决定"替换在用项目"还是"合并"；**CHANGELOG 必须记：何时、从哪份备份、恢复成什么** |
| 打包 | `electron-builder.yml` | —— | `npm run dist` | 打包后**冒烟一次** + `CHANGELOG.md` |

> **③"跑"的口径（唯一，消歧）**：**验收 = `npm run verify` 全链全绿**（步骤数 / 每步命令 / 预算的**唯一定义**在 `scripts/verify.js` 的 `STEPS`，`docs/VERIFY.md` 的链表由它渲染 —— **此处不复述条数**；G7 与 G6 共用一次运行 ⇒ 末尾打印的"实跑 N 步"比步骤数少 1；**总预算 400s**）。
> 单个门禁脚本（`npm run check:docs` / `check:rules` / `check:visibility` / `facts` / `check:encoding`）只是**自检**，
> 用来快速迭代（实测文档类四步合计十几秒），**任何一条都不能当作"做完了"** ——
> 它们只是全链的子集，全链还含单测 / 集成 / 冒烟 / 数据校验。
> （此前本表的"③跑"列写的是子集命令，而 `RULES.md` R3 / README / AI-GUIDE 写的是全链，
> **接手演练实测指出这是灰区**：不知道子集是否被全链覆盖。现统一为全链，子集只作自检。）

> **零 Git 下的"改坏了怎么办"（恢复 runbook，**唯一**手段是导出文件）**：
> 本工程 Git **零提交**（`.git/objects` 被 EDR 拦，见 `docs/INCIDENTS.md`），所以没有 `git checkout` 可救。
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

