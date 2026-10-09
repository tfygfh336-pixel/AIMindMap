# 数据格式（DATA-FORMAT）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 契约
作用: 数据契约：全部字段、版本演进与兼容承诺
不该写: 命令用法、架构理由
更新方式: 改 schema 必同步
-->

> 作用：**数据契约** —— 本工程笔记文件的全部字段、约束与版本演进承诺。
> 边界：不写命令用法（见 `docs/CLI.md`）、不写架构理由（见 `docs/ARCHITECTURE.md`）。
> 适用范围：`projects/<name>/<name>.json`。
> 校验实现：`src/schema.js`（CLI `validate` 闸门 / 渲染层保存闸门共用）。
> 契约目标：**任何第三方工具（或另一个 AI）只读本文档就能写出正确的解析器与生成器。**

## 1. 总体结构

```json
{
  "meta": {
    "name": "项目显示名",
    "author": "",
    "version": "<写入时的应用版本，见 package.json>",
    "formatVersion": 2,
    "rootMode": "themes"
  },
  "format": "node_tree",
  "data": { "id": "root", "topic": "根标题", "expanded": true, "children": [] },
  "assoc": [
    { "id": "a-xxx", "title": "两者之间是什么关系", "members": [
      { "project": "本项目", "id": "node-a" }, { "project": "本项目", "id": "node-b" }
    ], "note": "<p>关联知识（HTML，同 detail 约定）</p>" }
  ]
}
```

`assoc` 是**项目级可选集合**（与 `data` 平级，**不在节点树里**），见 §2.6。

| 字段 | 必填 | 说明 |
|------|------|------|
| meta.name | ✓ | 项目显示名（界面/导出用） |
| meta.author | - | 作者（当前恒为空串） |
| meta.version | - | **写入时的应用版本**，仅供追溯；解析方**不应**据此判断格式（格式看 `formatVersion`） |
| meta.formatVersion | ✓ | 数据格式版本（当前 **2**） |
| meta.rootMode | - | `"themes"` 时启用**主题模式**：根节点被当作容器（隐藏其方框与连线），各顶层子节点互相独立。缺省 = 单中心模式 |
| meta.layout | - | **主题左右分侧**：`{ "left": [主题id], "right": [主题id] }`（`left`/`right` 可各自缺省）。由 CLI `theme-layout <项目> --left a,b --right c,d` 写入，界面保存不丢；id 必须是**顶层主题**的 id。缺省 = 全部按树序排布。校验见 `src/schema.js`（`meta.layout` 必须是对象、两侧必须是数组、元素必须合法 id） |
| meta.themeOffsets | - | **顶层主题的拖拽偏移**：`{ "<顶层主题id>": { "x": 数, "y": 数 } }`。界面上「框选 → 拖动所选（整棵所属树）」的结果**就存在这里**（此前只活在渲染层，保存即丢 —— 用户报的"移动无法保存"）。坐标为**逻辑画布像素**、**相对该主题的自动布局位置**（不是绝对坐标：增删节点不会让旧偏移失效）。**只写非零项**；缺省 = 全部按自动布局。它只影响**呈现**，不改父子关系、不改分侧（分侧仍看 `meta.layout`）。校验见 `src/schema.js`（必须是对象、键是合法**顶层主题**id、值是 `{x,y}` 有限数字且绝对值 ≤ 20000） |
| format | ✓ | 固定 `"node_tree"` |
| data | ✓ | 根节点（id 固定 `root`） |
| assoc | - | **关联笔记**（N 元关联实体）集合，与 `data` 平级、**不属于节点树**。缺省 = 该项目没有任何关联（合法）。见 §2.6 |


## 2. 节点

```json
{
  "id": "my-node",
  "topic": "示例节点",
  "expanded": true,
  "detail": "这里是节点的详情（HTML）：\n1. ...",
  "tags": ["网络", "传输层"],
  "background": "#fff8e1",
  "images": [
    { "file": "assets/demo.png", "caption": "示意图：图里有什么、重点看什么", "source": "出处（可选）", "tags": ["示例"] }
  ],
  "files": [
    { "file": "attachments/notes.md", "caption": "完整笔记：何时引用、里面有什么", "source": "出处（可选）" }
  ],
  "links": [
    { "project": "other-project", "id": "some-node", "caption": "相关说明" }
  ],
  "children": []
}
```

### 2.1 字段规则

| 字段 | 必填 | 类型 | 规则 |
|------|------|------|------|
| id | ✓ | string | 小写字母/数字/连字符（`^[a-z0-9][a-z0-9-]*$`），全树唯一，根为 `root` |
| topic | ✓ | string | 节点标题（非空）。可含**行内 Markdown**（`**加粗**`、`` `代码` ``）——界面渲染时转成 `<strong>`/`<code>`，**数据里仍是原文**（不写回 HTML，见下） |
| expanded | - | bool | 默认 true；false 表示收起 |
| detail | - | string | **HTML 片段**（见 §2.5）。渲染层以 `innerHTML` 注入，故必须写 HTML 标签才会呈现格式 |
| tags | - | array | 字符串数组；**每项必须是非空字符串**。用于分类与 `search --tag` |
| background | - | string | 节点底色。**当前为透传字段**：schema 不校验、界面与 CLI 均无设置入口，仅在序列化时原样保留 |
| images | - | array | 图片引用列表；**每项 file + caption 必填** |
| files | - | array | 附件引用列表；**每项 file + caption 必填** |
| links | - | array | 跨项目链接；**每项 project + id 必填** |
| localPath | - | string | **本机文件夹绝对路径**（如 `E:\markdown\M1`）。界面点击即用文件管理器打开；见下方说明 |
| children | - | array | 子节点（递归同构） |

> **`localPath` 是本格式里唯一的绝对路径**（与 §5「禁止绝对路径」的关系，别混淆）：
> 那条禁令针对的是**资源引用**（`images[].file` / `files[].file`）—— 它们要能在别的机器上解析，
> 所以只允许 `assets/`、`attachments/` 下的相对路径。而 `localPath` 是**目录快捷方式**：
> 它天生就是"**这台机器上的那个目录**"，没有可移植的含义（从文件夹结构建出来的树，每个结构节点挂一条）。
> 因此它**只校验形状**（非空 / 无换行 / ≤500 字符），**不校验存在性** —— 存在性依赖运行环境
> （盘没挂载、目录还没建都正常），把它做成校验条件会让"换台机器打开就连 `validate` 都红"。
> 换机器/换盘后本字段可能失效：**点开会明确报错，不会静默没反应**。
> 设置用 `add`/`edit` 的 `--local-path`，清除用 `--clear-local-path`；
> 界面上出现在**详情框的可点链接**与**右键菜单「📁 打开文件夹」**。

> **images 与 files 的区别**：`images` 是**图片**，界面中可直接预览/灯箱放大，文件存 `assets/`；
> `files` 是**任意附件**（md/pdf/zip…），文件存 `attachments/`：**md 在应用内联渲染预览、
> pdf 内嵌预览**（Chromium PDF viewer），其余类型交系统默认应用打开
> —— 见 `renderer/app-media.js` 的 `openFilePreview`。
> 两者都**必须**有 `caption` —— AI 读笔记时凭 caption 判断内容与是否引用，没有 caption 的
> 附件等于不可发现。

### 2.2 images 项

```json
{ "file": "assets/abc.png", "caption": "图里有什么、重点看什么", "source": "出处（可选）", "tags": ["标签1"] }
```

- `file`：相对 `projects/<name>/` 的路径（规范为 `assets/<文件名>`）。
- `caption`：**必填**。AI 阅读笔记时凭 caption 理解图片内容、决定是否引用。
- `source`：可选出处（文档名/页码/链接）。
- `tags`：可选标签数组。

> ⚠️ **`import-md` 的图片/附件引用不会自动搬进 `assets/` / `attachments/`**：
> 它只把 Markdown 里的 `![](文件名.png)` 按**原样字符串**登记成 `images[].file` —— 于是得到一个
> **指向不存在文件的坏引用**（`export-json` 会把它报成「缺失资源」，界面上是裂图）。
> 正确流程：`import-md` 之后，用 `add-image --file <绝对路径> --caption <说明>`（附件同理 `add-file`）
> 把**真图**挂到目标节点，再 `remove-image` 清掉那些裸文件名的坏引用。
> 同一个坑还有另一半：从博客/编辑器导出的 Markdown 常夹带 **1×1 透明 GIF 占位图**
> （`data:image/gif;base64,R0lGODlhAQABAPABAP…`，caption 多为「点击并拖拽以移动」），
> 它们会被当成正常图片登记 —— 实测量级可以到一篇笔记 128 处，一样用 `remove-image` 清掉。
> 两类都不是数据损坏（引用可查、可清），但不清就会污染图片区与 `stats` 计数。

### 2.3 files 项

```json
{ "file": "attachments/abc.md", "caption": "该附件是什么、何时引用", "source": "出处（可选）" }
```

- `file`：相对 `projects/<name>/` 的路径（规范为 `attachments/<文件名>`）。
- `caption`：**必填**。说明该附件的内容与用途。
- `source`：可选出处。
- 通过 `add-file` / `remove-file` / `files` 命令维护。

### 2.4 detail 的语义：**HTML，不是 Markdown**

> ⚠️ **本节纠正一处长期存在的文档错误。** 旧版本文档称 detail 为"Markdown 语义、
> 渲染层转 HTML 展示"，**与实现不符**，曾误导 AI 写入 Markdown 从而渲染成字面量。

**实现事实（三重证据）**：

1. `renderer/app-detail-content.js` 渲染详情时执行 `dc.innerHTML = detail` —— 直接按 HTML 注入，无任何转换；
2. `renderer/editor.js` 保存时原样取编辑框文本，不做转换；
3. 全文搜索（`src/query.js` 的 `searchNodes`，`cli/commands/project.js` 的 `search` 只做转发）
   需**先剥掉 HTML 标签**（`convert.stripHtml`）再匹配 detail —— 反证存储值含标签。

**实测**：当前唯一真实项目 `comnet` 的 133 个含 detail 节点，**100% 为 HTML**（`<h3>/<p>/<b>/<ul>/<table>`），
Markdown 语法占比 **0%**。

**所以**：

| 场景 | 该写什么 |
|------|---------|
| 直接写 `--detail` | **HTML**，如 `--detail "<h3>标题</h3><ul><li>要点</li></ul>"` |
| `import-md` 导入 Markdown 文件 | 写 **Markdown**；导入时自动转换为 HTML 存储 |
| `--detail-md`（`add`/`edit` 的选项） | 写 **Markdown**；命令内转换为 HTML 存储 |
| `export-md` 导出 | 输出 **Markdown**（HTML → Markdown 转换） |

> **`import-md` 导入代码的两条硬规则**（2026-09-29 修完围栏缺陷后固化，都有单元测试守着）：
> 1. **围栏代码块是数据，不是结构**：` ``` ` … ` ``` ` 之间的内容一律原样进 detail，不参与标题/列表/表格/强调解析。
>    修复前它会被空行切断、`#include` 被当成 `<h1>`（实测一篇笔记 47 个块只有 8 个完整）——属静默损坏。
> 2. **标题层级要连续**：`src/markdown.js` 遇到层级跳跃会插一个 `（层级N）` 占位节点兜底
>    （源文件 `H2` 直接跳到 `H4` 时就会出现）。想让某个标题成为**目标父节点的直接子节点**，
>    在待导入的 md 里就用**一个 `#`（H1）** —— 因为导入时"层级差"是相对给定的父节点算的。
> 3. 已知的**唯一**文本归一化：每行行尾空白被去掉（`replace(/\s+$/, '')`），于是代码块里
>    "只由空格组成的行"会变成空行 —— 渲染等价，但逐字节 diff 时要知道这一点。
| 附件 `.md` 预览 | 按 Markdown 渲染（那是文件预览，与节点 detail 无关） |

**Markdown 只存在于"导入/导出边界"**，不是存储格式。转换由 `src/convert.js`
（`markdownToHtml` / `htmlToMarkdown`）与 `src/markdown.js` 承担。

> **写 HTML 时注意**：`markdownToHtml` 会把**裸 HTML 标签转义**（防注入）。因此走 Markdown
> 路径（`--detail-md` / `import-md`）时不要在 Markdown 里混写 HTML 标签，否则标签会显示为字面量。
> 反之，直接写 `--detail` 时内容是 HTML，不会被转义——**两条路径不要混用**。

### 2.5 links 项

```json
{ "project": "other-project", "id": "some-node", "caption": "说明（可选）" }
```

- `project`：目标项目目录名（`projects/<project>/`）。
- `id`：目标节点 id。
- 校验（悬挂链接检测）：validate 会检查 `(project, id)` 是否真实存在；
  目标项目文件不存在或目标节点不存在 → 报错。
- 注意：`links` 是**跨项目**引用；**同项目内**节点的引用关系由 `relations.js` 按
  `links` 反查得到（`backlinks` / `related`），不需要额外字段。

### 2.6 assoc 项（「关联笔记」= N 元关联实体）

```json
{
  "id": "a-lz3k7q",
  "title": "三次握手与可靠传输的关系",
  "members": [
    { "project": "comnet", "id": "tcp-handshake" },
    { "project": "comnet", "id": "tcp-reliable" }
  ],
  "note": "<p><strong>先建连</strong>，再在其上做可靠传输。</p>"
}
```

| 字段 | 必填 | 类型 | 规则 |
|------|------|------|------|
| id | ✓ | string | 与节点 id 同一套规范（`^[a-z0-9][a-z0-9-]*$`），**在 `assoc` 集合内唯一**。生成器用 `a-` 前缀（`a-` + 时间戳 base36 + 随机后缀），便于与节点 id 区分 |
| title | - | string | 这篇关联的标题。缺省时界面/CLI 用成员主题拼接出「有效标题」（`A ↔ B`）——那只是**视图派生值**，不落盘 |
| members | ✓ | array | 成员列表：**至少 2 个**且**不可重复**（同一 `project` + `id` 出现两次即报错）。每项含 `project`（项目目录名）+ `id`（节点 id），两者都必填 |
| note | - | string | 关联正文。**HTML**，与节点 `detail` 同约定（见 §2.5）；Markdown 只出现在命令行边界（`assoc-add`/`assoc-edit` 的 `--note-md`，命令内转 HTML 后存储） |

**与 `links` 的分工（这是本集合存在的唯一理由）**

`links` 是**逐条声明的有向边**：图结构上它完全能表达三角关系与两两互指，
所以"图论上能不能表达"不是问题所在。`links` 表达不了的是
**「把若干节点的关联当成一个对象」** —— 而"介绍二者/多者之间关联知识"的笔记
需要的恰恰是这个对象：

| 挂在某条 `links` 边上 | 独立实体 `assoc` |
|----------------------|-----------------|
| 标题只能写成边的两端，**第三个成员在标题里消失** | 标题属于整篇关联，N 个成员平等 |
| 重跑 `link` 会整个替换该链接对象 → **笔记被抹掉**（实测：`note` 丢失） | 关联有独立 id 与独立生命周期，改 `links` 不影响它 |
| `unlink` 会让笔记**陪葬** | 成员由 `--members` 单独维护，与 `unlink` 无关 |

> 三条都是**实测结论**，不是推测；回归断言见 `scripts/cli-integration.js` 的
> 「关联笔记」段与 `scripts/smoke/10-assoc.js`。

**N 元的实际含义**：成员可跨项目（`项目/节点id`，如 `comnet/dns`），
且从**任一成员**都能查到同一篇关联（`assoc-list --node <id>`），
界面里也从任一成员的「相关知识点」区进入同一个二级页面。

**校验**（`src/schema.js` + `src/assoc.js`，`validate` / `validate-all` 都会报）：

1. **结构**：`assoc` 必须是数组；每项 id 非空且合规范、`title`/`note` 是字符串、
   `members` 是数组且 ≥2 个、成员每项有 `project`+`id`、同一集合内 id 不重复、
   同一关联内成员不重复（结构问题由 `assoc.validateAll` 报）。
2. **悬挂关联成员**：成员指向的节点必须**真实存在**，检测与**悬挂链接同一处逻辑**。
   判定真值分两种：**本项目**成员以**即将落盘的那份 data** 为准（不是磁盘 —— 读盘会把
   "刚删掉的节点"算成还在，闸门因此慢一步漏判）；**跨项目**成员只能读盘（磁盘是唯一真值）。
   目标项目不存在 / 目标节点不存在 / 项目文件不可读，三种都报错。
   `assoc-add` / `assoc-edit --members` 在写入前也会逐个检查成员存在，**不让你造出悬挂关联**。
3. **删节点会留下悬挂成员吗**：会 —— 所以 **CLI** 的 `remove <项目> <id>` 在发现被删（子）树
   被关联引用时**拒绝执行**并给出两条路（因为一旦写下去，该项目**所有**写命令都会被闸门挡住）：
   `remove <项目> <id> --clean-assoc`（删节点并同步剪掉这些关联里的该成员，
   剪完不足 2 个成员的关联整篇删除）或 `assoc-prune <项目> --nodes <id>`（先摘引用再单独删节点）。
   **界面**的删除走同一条规约：先弹确认列出影响面，再经 IPC `app:pre-delete-cleanup` 让 **CLI 在磁盘上**
   用 `links-prune` + `assoc-prune` 剪干净，**成功后才删节点**（清理失败就不删）。
   清理完渲染层还把**内存树**里指向被删节点的链接一并摘掉，否则 `save()` 会把悬挂链接写回磁盘（实测）。
4. **链接也会悬空（同项目，或别的项目删了节点）**：`remove` 同样会对同项目入边链接拒绝执行，
   需 `--clean-links`；而"**别的项目**把目标节点删掉"这种情况本项目无从预防，只能事后修 ——
   用 **`links-prune <项目> [--nodes a,b] [--dry-run]`**（默认只删**确认不存在**的目标，
   目标项目读不出来时只警告、不猜）。没有它，被判红的本项目**无法自救**（界面上没有删链接的入口）。
   更一般地，**`assoc-prune <项目> [--nodes a,b] [--dry-run]`** 可清理已存在的悬挂成员：
   默认只剪**确认不存在**的成员，项目读不出来（损坏/权限）的成员单独列出警告而**不当作悬空**；
   全清空时 `assoc` 键一并去掉（与 `assoc-remove` 同一约定）。

**归属（重要）**：`assoc` 的**主要作者是 AI/CLI** —— 界面**没有创建入口**
（二级页面只能从节点详情的「相关知识点」区进入，它不是节点、不在树里、命令面板也搜不到）；
界面可以**编辑标题与正文**，走的是 CLI `assoc-edit`（渲染层不直接改盘，也不自己拼 HTML）。
因为**节点树由渲染层拥有、而 assoc 由 CLI 拥有**，保存链路上有两道保护：

- 渲染层 `serializeTree` 会把内存里的 `state.assoc` **原样带出**（漏掉即"保存就抹掉"）；
- 主进程 `project:save` 若发现渲染层没带 `assoc`，会**从磁盘现有文件取回**，不用空值覆盖
  —— 防止 AI 刚写的笔记被一次界面保存清掉。

**向后兼容**：`assoc` 是 `formatVersion` 2 内**只增不改**的顶层可选集合 ——
缺失即"没有关联"（合法）；旧文件**不需要迁移**，`formatVersion` 仍为 2。
全部删空时 `assoc-remove` 会把 `assoc` 键**整个去掉**（不留空数组噪音，与旧格式完全一致）。
`export-json` / `import-json`（aimap v1）同样携带 `assoc`（仅非空时写入，旧包形状不变），
故"无损备份/迁移"路径不会丢关联笔记。

## 3. 校验规则（schema.js）

1. 顶层必须有 meta/format/data。
2. format 必须为 `node_tree`。
3. 每个节点：id 规范 + 全树唯一；topic 非空；children 是数组。
4. detail 必须是字符串。
5. tags 必须是数组，且每项为非空字符串。
6. images 每项 file + caption 非空。
7. files 每项 file + caption 非空。
8. links 每项 project + id 非空；目标 (project,id) 存在（悬挂链接检测）。
9. `assoc`（缺省合法）必须是数组；每项 id 规范且集合内唯一、members 是数组且 ≥2 个不重复成员、
   成员每项 project + id 非空；每个成员指向的节点存在（**悬挂关联成员检测**，与悬挂链接同处逻辑；
   修好悬挂成员用 `assoc-prune`）。见 §2.6。
10. meta.formatVersion 为 2（缺省视为合法；**无 v1 迁移分支**）。
11. 整树无环（**迭代式检测**，不用递归，避免深树爆栈）。
12. **detail 内容不做 HTML/Markdown 校验**：任何字符串都合法（含义见 §2.5）。

## 4. 版本演进

| 版本 | 说明 | 兼容性 |
|------|------|--------|
| 2（当前） | 现行格式 | — |

> **纠正**：旧版本文档称"v1→v2 时 detail 由 HTML 改为 Markdown 语义、旧数据读取时懒转换"。
> **代码中不存在该迁移**：`src/schema.js` 只校验 `formatVersion === 2`（缺省视为合法），
> 没有任何 v1 分支或 `htmlToMarkdown` 懒转换；且 detail 至今仍是 HTML（见 §2.5）。
> `convert.js` 的 HTML⇄Markdown 只服务于 `import-md`/`export-md` 与附件预览。

**兼容承诺**：
- **只增不改**。新增可选字段不递增 `formatVersion`——旧解析器忽略未知字段即可正常工作。
- **破坏性变更**（改字段语义、删字段、改必填性）必须递增 `formatVersion`，并在
  `src/schema.js` 加迁移分支、同步本文档与 `CHANGELOG.md`。
- `meta.version`（应用版本）**不是**格式版本，解析方不应据此判断格式。
- 字段顺序无意义；解析方不得依赖 JSON 键序。

## 5. 文件与目录约定

```
projects/
└── <name>/
    ├── <name>.json      # 项目数据（唯一真源）
    ├── assets/          # 图片文件（节点 images[].file 指向这里）
    ├── attachments/     # 附件文件（节点 files[].file 指向这里）
    └── .ui-state.json   # 运行时协调信号（「界面有未保存编辑」），不是数据；可随时删
    └── .changes.jsonl   # 变更日志（谁/何时/改了哪些对象，多路同时编辑的事前避让依据），不是数据；
                         # 由唯一写盘出口顺带产生、有界（最近 N 条）、不进 export-json；可随时删
```

- 项目名 = 目录名 = JSON 文件名（三处一致）。
- 图片只存 `assets/`、附件只存 `attachments/`，一律用相对路径引用；**禁止绝对路径**。
- 目录按需创建：无图片则无 `assets/`，无附件则无 `attachments/`（空目录不入库）。
- **数据目录里只应有上面这几项**。它是**用户数据目录**，不是工作区：脚本、分析稿、一次性
  工具**不要**放进来（实测曾有一个 26 KB 的 `build.js` 躺在里面、无人知道来历，且**没有任何门禁管**
  —— G8 刻意跳过 `projects/`）。`npm run check:docs` 会**列出**契约未声明的项提醒确认（不判红）。
  需要长期保留的脚本请移入 `.review/`（工作产物区）。
- 写盘一律走**原子写**（`src/data-store.js` 的 `writeFileAtomic`：同目录临时文件 → `fsync`
  → `rename`），保证中断不产生半截文件；解析时剥离 UTF-8 BOM。
- **路径穿越不在 `file` 字段的校验范围内**：`src/schema.js` 只要求 `file` 是**非空字符串**，
  `../` 之类的相对路径**能通过 `validate`**（实测：把 `files[0].file` 写成 `../../evil.md`，
  `validate` 仍报"校验通过"）。真正的拦截点在 `import-json` 解包资源时 ——
  `src/bundle.js` 的 `isSafeRelPath` 要求资源路径解析后仍在目标项目目录内部。
  即：`validate` **不做**此校验，别把它当成路径穿越的防线。

## 6. 导出语义（export-md）

- heading 格式：`#` 根 → `##` 一层 → `###` 二层……
- list 格式：缩进 + `- `。
- `--with-detail`：节点 detail 转为 `> 引用块` 跟在标题行后。
- 导入（import-md）为反向：heading 层级 → 节点树；非标题行并入最近标题节点的 detail。

> **不含 `assoc`**：`export-md` 导出的是**节点树**，`assoc` 是项目级集合、不在树里，故不进入
> Markdown 导出。需要连关联笔记一起迁移/备份请用 **`export-json`**（aimap v1，见 §2.6）。
