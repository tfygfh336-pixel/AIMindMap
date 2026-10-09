# jsMind 内部符号依赖表（我们主动接管的那一半）

> **这份文件是给"升级 / 更换渲染库的人"看的**。它列的不是库的 API，而是我们**主动伸进库内部**
> 的那些符号 —— 换库时**必然要重写**的部分。升级 jsMind 时，按这张表逐条回归。
>
> **为什么它住在 `renderer/vendor/` 而不是 `docs/`**：它必须紧挨着被升级的那份 bundle
> （动作现场）；且 `docs/` 的登记门禁（G8）只治理文档，`renderer/vendor/` 是**第三方目录**、
> 明确不在门禁扫描范围内（见 `scripts/docs-registry-check.js` 的 `SKIP_DIRS`）。
> 它在导航上的入口是 `docs/ARCHITECTURE.md` §2.1 的 `vendor/jsmind.js` 行与
> `renderer/mindmap-adapter.js` 的头部 —— 两处都指向本文件。

## 0. 版本锚

| 事实 | 值 |
|------|----|
| 库 | jsMind（`https://github.com/hizzgdev/jsmind`，BSD-3-Clause） |
| 版本 | **0.9.1**（bundle 内 `const e="0.9.1"`；`package.json` 的 devDependency 同为 `^0.9.1`） |
| 文件 | `renderer/vendor/jsmind.js`（minified UMD，51 KB / 10 行） |
| 本表快照日期 | 2026-10-09 |

**换库评估的结论（2026-10-09）是"有条件地不换"**，三个重新评估的硬触发写在 `CHANGELOG.md`。
本表就是那次评估里"最贵的那 2/3"的账本。

## 1. 我们主动依赖的内部符号（**升级时必须人工回归的清单**）

> ⚠️ **行号会随 `renderer/*.js` 改动漂移**：本表是 2026-10-09 的快照。
> 判据请以第 4 节的命令**现算结果**为准，不以本表的行号为契约。
> 口径：**只算代码行**（以 `*` / `//` / `/*` 开头的注释行整行跳过）。

| 符号 | 类 | 用途（为什么非用不可） | 行数 | 位置（`file:line`） |
|------|----|----------------------|-----:|--------------------|
| `jmnode` | DOM | 节点自定义元素标签名：选择器、几何测量、命中判定到处在用 | 29 | `app-ask.js:41` · `app-core.js:144` · `app-detail-content.js:83` · `app-detail.js:127,147,192,266` · `app-related.js:93,107` · `app-view.js:111,301,332,337,344,439,463,473,614,701,820,878,913,1072,1089,1148,1149,1207` · `contextmenu.js:39,47` |
| `jmnodes` | DOM | 节点层标签名："点空白"判定与面板内查询 | 15 | `app-detail-content.js:92,106` · `app-view.js:36,54,279,280,293,294,723,724,727,897,1072` · `contextmenu.js:40,48` |
| `e_panel` | view | 面板元素（滚动容器）：统一 transform、几何测量、容器根的基准 | 6 | `app-core.js:141,197` · `app-detail-content.js:106` · `app-related.js:92,93` · `app-view.js:30` |
| `show_lines` | view | 重画连线层。我们自己改了节点位置后**必须手动重画**，否则线与节点脱开；且它被我们**整体替换**过（见下） | 5 | `app-view.js:973,974,1135,1222,1223` |
| `view.relayout` | view | 库的重排出口（展开/收起/拖动后重算并重画）；我们包住它做"重排锚点保持" | 4 | `app-view.js:123,124,125,153` |
| `jmexpander` | DOM | 展开/收起圆钮元素，我们要改它的尺寸并让它随树一起偏移 | 3 | `app-view.js:614,701` · `contextmenu.js:39` |
| `zoom_current` | view | 库自己的缩放读数。**我们把它钉在 1**（缩放自管，不叠第二套坐标系） | 3 | `app-view.js:177,201,1269` |
| `set_zoom` | view | **被我们整体替换**（转到统一 transform），不是调用 | 3 | `app-core.js:196,203,204` |
| `zoom_in` / `zoom_out` | view | 同上：被替换 | 2 | `app-core.js:203,204` |
| `mind.nodes` | mind | 节点字典（id → node）：整树遍历 / 统计的入口 | 1 | `app-view.js:1136` |
| `mind.root` | mind | 根节点对象 | 1 | `app-view.js:115` |
| `layout.is_visible` | layout | 节点当前是否可见（收起的分支里为 false）。库有公开的 `is_node_visible` 包着它，我们直接调了里面这层 | 1 | `app-view.js:1146` |
| `view.opts` | view | 视图的横/纵向间距选项（`hmargin` / `vmargin`）：复刻连线算法时要按同样的间距算端点 | 1 | `app-view.js:1137` |
| `view.jm` | view | 视图反向持有 jsMind 实例：`view.show_lines` 被换成我们自己的实现后靠它取节点集合 | 1 | `app-view.js:1136` |

**合计 75 个代码行命中**（同一行出现多个符号会计多次）。

### 1b. 三个"整体替换"的库方法（不是调用，是接管）

替换与调用不同：库升级后这些**函数体的前提**变了，我们那份实现**不会自动跟着变**。

| 库方法 | 我们的实现 | 为什么必须接管 |
|--------|-----------|----------------|
| `view.set_zoom` | `app-core.js:196` | 库用 `style.zoom` + 面板滚动实现缩放；我们再叠一层 transform 会形成**两套坐标系**（放大后内容超出面板、滚动够不到）。⇒ 缩放全部由 `fdView` 的一个 transform 承担 |
| `view.zoom_in` / `view.zoom_out` | `app-core.js:203-204` | 同上，改走后者的统一入口 |
| `view.show_lines` | `app-view.js:1135`（`installRootLineOverride`） | 主题模式下必须**跳过"根 → 顶层主题"的连线**；并按"所属顶层主题树"的偏移移动线两端 —— 库里没有这个概念 |

## 2. 我们**刻意不用**的内部物（升级时不要"顺手接回去"）

| 符号 | 结论 | 依据 |
|------|------|------|
| `view.reset()` | **不用**。它会把节点 DOM 全部重造 ⇒ 我们注册的类/样式全丢 | 历史事故：曾导致节点整体消失（`app-view.js:1129` 的注释）；`app-core.js` 的 `installRootLineOverride` 就是为"只重画线、不动节点 DOM"而写的 |
| `get_node_point_in` / `get_node_point_out` | **不用**。它们返回**带缓存复用的对象**（`_offset_` / `_pout_`），改坐标会污染布局缓存、导致后续布局错乱 | `app-view.js:1113` / `1130` / `1140` 的注释。线端改读节点**实际 DOM 边框**（`nodeBorderRect`，唯一真源）⇒ 节点被任意移动后 `show_lines` 重算即精确跟随 |
| `clear_selected_node_custom_style` / `restore_selected_node_custom_style` / `_reset_node_custom_style` | **渲染层当前未直接调用**（只在注释里被提及） | 它们存在于 `view.select_node` / `view.select_clear` 内部；我们**不替换**这两个方法，所以不受影响。但它们与"节点样式"相关 ⇒ 升级后若改变行为，影响的是选中态外观 |

## 3. 关于 0.9.1 的三条实测事实（容易读错，先看这里）

三条都由 2026-10-09 的探针实测（报文见 `.review/20261009-jsMind事件派发探针/`）：

1. **事件是派发的，但派发点只有一个**：`invoke_event_handle` 在 bundle 里共 **12 个调用点**
   （`show`×3 / `resize`×1 / `edit`×7 / `select`×1）。其中 `select` 那个**写在公开方法
   `jsMind.select_node()` 的函数体内** ⇒ 编程调用与用户点击**命中同一个派发点**。
   （容易被看混的是**同名**的 `view.select_node()` —— 那一层只改样式、不派发。）
2. **`select` 事件不可依赖**，四条实测：点空白**不派发**（走 `select_clear()`）；派发是**异步**的
   （`setTimeout(…,0)`）；节点**不可见不派发**（`layout.is_visible` 守卫）；
   载荷 `{evt,data,node}` 里**没有 Ctrl/Cmd**。⇒ 选中语义由渲染层在 DOM 层自管。
3. **公开 `add_node` 只有 5 个形参**（parent / id / topic / data / direction），**没有 index**。
   形如 `add_node(parent, id, topic, data, undefined, idx)` 的写法里那个 `idx` 会被**静默丢弃**
   ——本仓 `app-actions.js` 的 `addSiblingNode` 就是这个形态（已就地留注释，属**已知缺陷、
   本次纯重构按原样保留**）。底层 `mind.add_node(...)` 确实有第 7 个形参做 index，
   但公开层不外传。

## 4. 怎么重新算这张表（行号漂移时用）

改过 `renderer/*.js` 后，用下面任一方式重算第 1 节的位置（**只算代码行**）：

```powershell
# PowerShell：列出全部内部符号命中（file:line）
$re = 'jmnode(?![a-z])|jmnodes|jmexpander|view\.relayout|show_lines|e_panel|zoom_current|set_zoom|mind\.(nodes|root)|mind\.selected|layout\.is_visible|opts\.(hmargin|vmargin)|this\.jm'
Get-ChildItem renderer\*.js | Where-Object { $_.Name -ne 'mindmap-adapter.js' } | ForEach-Object {
  $f = $_.Name; $n = 0
  Get-Content $_.FullName | ForEach-Object {
    $n++
    if ($_ -notmatch '^\s*(\*|//|/\*)' -and $_ -match $re) { '{0}:{1}' -f $f, $n }
  }
}
```

## 5. 与适配层的关系（两半的分工）

| 半边 | 覆盖 | 换库的代价 | 住哪 |
|------|------|-----------|------|
| **可移植的公共 API** | 11 个方法 / 迁移前 83 处调用点 | **只改 1 个文件** | `renderer/mindmap-adapter.js`（唯一的调用形状：`MM.adapter.X(jm, …)`） |
| **主动接管的内部** | 本文第 1 节那 14 类符号 / 75 个代码行 | **必然重写**：`view.show_lines`、统一 transform、几何测量、主题分侧、框选与关联高亮的渲染 | 散布在 `renderer/app-*.js`，即本文 |

> 迁移后 `renderer/*.js`（不含适配层）里**公共 API 调用点 = 0**；
> 判据命令见 `.review/20261009-渲染库适配层/`（工作产物区，可随时删除）。
