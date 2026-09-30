# AI 协作指南（AI-GUIDE）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 设计
作用: AI 操作规范：怎么读写、验证链、坑 + **笔记内容写作规范（节点粒度 / detail / caption）**
不该写: 工程流程（指向 RULES/ARCHITECTURE）
更新方式: 手写
-->

> 面向**任何 AI agent**（豆包、DeepSeek Harness、Claude、Cursor 等）使用本工程维护
> 笔记项目的操作规范。**本文只讲"怎么操作"**；数据字段含义见 `docs/DATA-FORMAT.md`，
> **笔记内容写作规范见本文 §3**，命令完整用法见 `docs/CLI.md`。

## 0. 三句话

1. 数据是 `projects/<项目>/<项目>.json`（节点树），**只通过 CLI 改**（有校验闸门），不直接手改 JSON。
2. 每次改动**同步更新 CHANGELOG.md（[Unreleased]）+ README.md**，缺一不可。
3. 测试一律 headless：`npm run verify`（单测 → CLI 集成 → 冒烟 → validate-all → 文档基线），**禁止用鼠标键盘操作界面测试**。

> **你不需要内嵌 DSH**：应用里虽有内嵌 DSH 侧边栏（人类开桌面界面用的），
> 但你**就是** AI agent——操作笔记直接走本文的 CLI/MCP，不要启动或连接内嵌实例
> （它有独立 HOME 与凭据，且多一层毫无意义的间接）。只有当任务本身是
> **改侧栏/DSH 运行包的代码**时才涉及它：改完跑 `npm run verify` + `npm run dsh:e2e`。

> 各项计数（命令数/工具数/用例数/断言数）见 `docs/VERIFY.md`，本文不抄写以免漂移。

## 1. 读数据（回答问题 / 引用内容）
```bash
# 项目列表
node cli/mm-cli.js projects --json

# 读整个项目（树 + 详情 + 图片清单）—— 回答用户问题首选
node cli/mm-cli.js read my-notes --json

# 只要结构（省 token）
node cli/mm-cli.js read my-notes --json --brief

# 查单个节点（含详情 + 图片 + 路径）
node cli/mm-cli.js get my-notes my-node --json --detail --images

# 搜索
node cli/mm-cli.js search my-notes 关键词 --json

# 全部图片清单（含 caption —— AI 凭 caption 决定引用哪张图）
node cli/mm-cli.js assets my-notes --json

# 关系审计：找出"有内容却没有任何引用关系"的节点（很可能漏挂 links）
node cli/mm-cli.js orphans my-notes --json
node cli/mm-cli.js orphans my-notes --content-only --limit 100   # 只看该处理的

# 未链接提及：正文提到了某节点却没建 links（orphans 的另一半，直接指出"该往哪连"）
node cli/mm-cli.js mentions my-notes --json
node cli/mm-cli.js mentions my-notes --min-length 4              # 调高门槛减少误报
node cli/mm-cli.js mentions my-notes --cross                     # 再扫跨项目两个方向（同名歧义会标记）

# 两跳邻域：把「相关知识点」从直接关联扩到间接关联（看得出知识簇）
node cli/mm-cli.js related my-notes my-node --depth 2

# 静态站点导出：给人看的只读页面（相关知识点已内联为可跳转链接）
node cli/mm-cli.js export-html my-notes ./out-site
```

**引用图片**：`assets` 输出里每张图有 `node`/`file`/`caption`。回答用户时引用图片 =
给出相对工程根的路径 `projects/<项目名>/assets/xxx.png` 并复述 caption（在支持图片展示的
界面中可直接展示）。**不要**猜测图片内容——caption 不足时先 Read 图片文件再引用。

## 2. 写数据（增删改）

> ⚠️ **detail 的存储格式是 HTML，不是 Markdown**（渲染层以 `innerHTML` 注入）。
> **AI 请一律使用 `--detail-md` 写 Markdown**，命令会转成 HTML 落盘；
> `--detail` 是"按 HTML 原样存"，只在你要直接写标签（如 `<table>`）时使用。
> 两个选项**互斥**。详见 `docs/DATA-FORMAT.md` §2.4。

> 🤝 **写前协调（界面开着时才需要）**：桌面应用正打开这个项目时，先查一次
> `node cli/mm-cli.js ui-state <项目> --json`：
> `dirty: true` = 界面上有**未保存**的编辑 —— 先请用户保存（或确认丢弃）再动笔，
> 否则用户一保存就会把你刚写的内容覆盖掉（白做工）。
> `uiRunning: false` / `stale: true` = 界面没在跑或已退出，直接写。
> 信号文件是 `projects/<项目>/.ui-state.json`（主进程在脏标记变化时写入，界面退出时归零）。
> 落盘后界面会**自动感知磁盘变化并刷新导图**，无需额外操作。

```bash
# 新增节点（parent 是目标父节点 id；id 可选，建议给见名知义的 id）
# —— 推荐：--detail-md 写 Markdown（可含 \n 换行），命令自动转 HTML 存储
node cli/mm-cli.js add my-notes root --topic 新知识点 --id my-new-node --detail-md "## 小节\n正文 **加粗**\n- 要点一"

# 编辑节点（标题/详情/标签/展开）
node cli/mm-cli.js edit my-notes my-new-node --detail-md "新内容（Markdown）"
node cli/mm-cli.js edit my-notes my-new-node --topic 新标题
node cli/mm-cli.js edit my-notes my-new-node --tags 标签1,标签2
node cli/mm-cli.js edit my-notes my-new-node --clear-detail

# 只在需要精确控制 HTML（表格、嵌套结构）时才用 --detail
node cli/mm-cli.js edit my-notes my-new-node --detail "<h3>标题</h3><table>…</table>"

# 移动 / 删除 / 复制
node cli/mm-cli.js move my-notes my-new-node root
node cli/mm-cli.js remove my-notes my-new-node
node cli/mm-cli.js clone my-notes my-new-node root --deep

# 加图片（caption 必填！）
node cli/mm-cli.js add-image my-notes my-new-node --file D:/figs/demo.png --caption "流程示意图：步骤 A → 步骤 B → 步骤 C，标注了输入输出" --source "出处（可选）" --tags 配图,示例

# 跨项目链接
node cli/mm-cli.js link my-notes note-a --to my-notes --id note-b --caption "相关说明"
node cli/mm-cli.js links my-notes --json

# 导入/导出 Markdown
node cli/mm-cli.js import-md my-notes notes/第5章.md --parent root
node cli/mm-cli.js export-md my-notes out.md --with-detail

# 备份/迁移：导出为单个 JSON 包（含全部图片，跨机器/跨工具搬运首选）
node cli/mm-cli.js export-json my-notes backup/my-notes.aimap.json
node cli/mm-cli.js import-json backup/my-notes.aimap.json --name my-notes-copy
```

**写后必须**：`node cli/mm-cli.js validate <项目>`（或最后 `validate-all`）确认结构合法。

> **防丢失**（本项目发生过两次 EDR 清目录全损事故）：见 §4.1。

## 3. 笔记内容规范（节点粒度 / detail / caption / 链接）

> **本文是唯一权威处**（原 `docs/CONTENT-STYLE.md` 已并入本节 —— 两份文档讲同一件事
> 必然各自漂移，见 `docs/RULES.md` §0）。

### 3.1 节点组织

- 每个**知识点一个节点**（粒度 ≈ 一篇文章的一个小节 / 一个概念 / 一个方法）。
- 层级不超过 5-6 层：根 → 主题 → 子主题 → 条目 → 细节。
- 同层节点**并列**（都是某父节点的孩子），不要出现"兄弟之间父子关系"的歧义。

```
topic-a（示例主题）
├── topic-overview（总览：背景与范围）
│   ├── part-1（第一部分）
│   └── part-2（第二部分）
│       ├── item-1（子条目一）
│       └── item-2（子条目二）
└── methods（关键方法）
    ├── method-1 / method-2
```

### 3.2 detail 写作

> **写入方式**：用 **Markdown 书写**，通过 `--detail-md`（CLI）或 MCP 的 `detail_md` 提交，
> 命令会自动转成 HTML 存储。**存储格式是 HTML**（渲染层 `innerHTML` 注入），
> 直接写 `--detail` 的内容必须是 HTML 标签。详见 `docs/DATA-FORMAT.md` §2.4。

- 使用 **Markdown** 语法（标题、列表、粗体、代码块），由 `--detail-md` 转换后落盘。
- **先定义、后机制、再例子**：
  ```
  名称（英文全称）：一句话定义。
  机制/步骤：编号列表。
  关键点/易错点：列表或粗体。
  ```
- 数字、端口、字段、公式用代码或粗体标出。
- 对比类内容（方案 A vs 方案 B）用并列列表或简短表格文字。
- 长度适中：一个节点 100-400 字为宜；超长拆子节点。

**好例**：

```markdown
示例概念（Example Concept）：一句话说明它是什么。

- **关键特征 1**：简要说明它的第一个特点
- **关键特征 2**：简要说明它的第二个特点
- **适用场景**：列出典型的使用场景
- **常见误区**：列出容易混淆或弄错的地方
```

**坏例**（无结构大段文字、口语化、无重点）。

### 3.3 图片规范（重要）

- **caption 必填**，且写清楚：**图里有什么 + 重点看什么**。
- 不要只写"示意图"三个字 —— AI 无法读图时会凭 caption 判断是否引用。

```
好：caption="流程示意图：步骤 A → 步骤 B → 步骤 C，标注了每一步的输入与输出"
差：caption="图"
```

- 需要 AI 二次理解的内容（时序图、架构图、对比表截图）尤其要详细；
  纯装饰图（图标）不必挂载。
- `source` 记录出处（教材图号/URL），便于追溯。

### 3.4 链接与搜索友好

- 跨项目链接用于"相关内容的引用"，如 A 项目的某条目在 B 项目有补充或应用示例；
  caption 说明"为什么链过去"。
- topic 用**规范术语**（标准名称、完整表述），不要用口语/缩写歧义；
  同义术语可在 detail 首行给出（如"中文名（English Name）"）。

### 3.5 多项目组织

- 一个项目 = 一个主题域（如"读书笔记"、"产品知识库"、"某门课"）。
- 跨主题引用用 links，不复制内容；项目内保持单一知识主线，避免重复节点。

一句话要点：detail 写 **Markdown** 并用 `--detail-md` 提交（存储会被转成 HTML）；
caption **必填**且要写清"图里有什么、重点看什么"。

## 4. 维护规范（每次迭代必做）

| 动作 | 必做项 |
|------|--------|
| 任何代码/功能/数据格式变更 | CHANGELOG.md [Unreleased] 段 + README.md（模块表/功能表/版本） |
| **改变「某功能如何被使用」**（数据形状/命令语义/交互模型/字段含义/默认值） | **铁律 R5「改动即连带」**：同一次改动里列出受影响的**使用者可见面**并逐个核对 —— GUI 交互（按钮/右键/菜单/快捷键/对话框/状态栏）、冒烟与集成断言、本文档与 README 的操作示例、详情框与关联笔记的渲染入口；结论（含"无影响"）写入 CHANGELOG。**判据不是"测试是否还绿"**，而是"人按原有习惯操作，得到的还是不是设计意图" —— G5 冒烟抓不住这类损害。详见 `docs/RULES.md` §3 R5 |
| 新增 CLI 命令 | cli/registry.js 登记 → `node cli/mm-cli.js docs-gen` 重生成 docs/CLI.md → scripts/cli-integration.js 加断言 |
| 新增渲染功能 | 在 `scripts/smoke/NN-*.js` 的**对应分域文件**追加断言（入口 `scripts/smoke-assertions.js` 只做 require + 顺序拼接，不再往入口里加）→ `npm run smoke` 验证 |
| **只改/只查某一条冒烟断言**（或只想确认某个功能没坏） | **别跑全链**：`SMOKE_ONLY=<文件前缀> npm run smoke`（PowerShell：`$env:SMOKE_ONLY='20,21'; npm run smoke`；等价 `electron . --smoke-only=20,21`）。只跑选中文件 + `01-*` 预热，**不产截图/取景记录/视觉断言**，计数**不是全量真值**；筛错名字会**响亮失败**（`SMOKE SELECTION ERROR`）。规则见 `scripts/smoke-select.js`、`docs/VERIFY.md` §验证链 |
| 改数据格式 | src/schema.js 版本号 + docs/DATA-FORMAT.md + 迁移逻辑 |
| **新增 / 挪动文档** | **先在 `docs/ARCHITECTURE.md` §5 表登记**（层 / 作用 / 不该写什么 / 更新方式）—— **未登记 = 门禁 G8 红**。判断"该不该建"用 §5 的决策树：事实→已有文档或 VERIFY；计划→ROADMAP；执行记录→CHANGELOG；机制设计→登记一份设计文档。**不复制既有事实、不手写易腐数字** |
| **要落盘任何文件**（分析稿 / 汇报稿 / 截图 / 数据 / 探针脚本） | **先读 `SKILL.md` 顶部「落盘规矩」**（4 条）：默认**不落盘** —— 分析汇报放对话里；必须落盘时**工作产物一律放 `.review/<YYYYMMDD>-<主题>/`**（唯一杂物区：可随时整目录删、不入版本库、不进 G6 数字扫描）；要长期存在才升格为 `docs/` 文档并登记 §5；一次性旧稿 → `docs/archive/`。**工程根 / 其它目录 / 工程外一律不许写** —— 工程根与顶层目录有白名单，乱放（含 png/json/脚本）由 **G8** 判红 |
| 发版 | `node cli/mm-cli.js release [版本号]`（自动：CHANGELOG 段落 + package.json + `src/config.js` + `package-lock.json` + README 版本锁）→ `npm run verify` → `npm run dist` |

**验证命令**（headless，按序执行，全绿才可交付）：

```bash
npm run verify                    # 一键全链（含文档登记 G8、规则自洽 G9 与文档基线校验）
npm test                          # 单测
node scripts/cli-integration.js   # CLI 命令端到端（临时项目自动清理）
npm run smoke                     # 冒烟（Electron 无头 + 截图 smoke-shot.png）
SMOKE_ONLY=20,21 npm run smoke     # 冒烟**单跑**：只跑选中的断言文件（+ 01 预热）；不产截图/视觉断言
$env:SMOKE_ONLY='20,21'; npm run smoke   # ↑ 的 PowerShell 写法（Windows 上就用这个）
node cli/mm-cli.js validate-all   # 全部项目校验
npm run check:docs                # 文档登记门禁（G8：表外文档/散落文档/悬挂登记）
npm run check:rules               # 规则文件自洽门禁（G9：条数/表格结构/编号引用/实现列）
node scripts/doc-facts.js         # 打印当前权威计数（命令/工具/用例/断言/版本）
```

> 各项计数不在本文维护：见 `docs/VERIFY.md`。

> **本机受限环境注意**：
> - `npm test` 已固定 `--pool=threads`。若改回默认 `forks` 池，vitest 会 fork 子进程并用
>   **管道 stdio** 收集结果，在禁止管道 stdio 的环境下报 `spawn EPERM` 与 "no tests"
>   —— 那是**假失败**，会掩盖真实结果。
> - `scripts/cli-integration.js` 内部用管道捕获子进程输出，同类受限环境下会**整批假失败**
>   （显示全部 FAIL 但 CLI 本身正常）。判断真伪：手动跑一条
>   `node cli/mm-cli.js projects` 看是否正常。

### 4.1 防丢失（本项目发生过两次全损事故）

- 每次大改后 `export-json` 一份**到工程外目录**（如 `D:/backup/ai-mind-map/`）。
- **不要**用 `robocopy /MOVE` 移动 `.user_skills` 内目录；**不要**写批量写盘脚本。
- 详情与派生禁令见 `docs/INCIDENTS.md`。

## 5. 被其他 AI 工具调用（MCP）

```bash
node scripts/mcp-server.js
```

标准 MCP stdio（2024-11-05），**每个工具都透传同名 CLI 能力**，不包含独立逻辑。
工具名与参数：见 `scripts/mcp-server.js` 的 `TOOLS`（已导出，可直接 `require` 读取），
或运行 `node scripts/doc-facts.js` 看工具总数；完整语义对照 `docs/CLI.md`。

Cursor / Claude Desktop 在 MCP 配置中加：

```json
{ "mcpServers": { "ai-mind-map": { "command": "node", "args": ["<本工程路径>/scripts/mcp-server.js"] } } }
```

## 6. 常见坑

- **不要**用界面手动测试（headless，见 `docs/RULES.md` 的 R4）。
- **不要**直接改 JSON 绕过校验（除非做数据迁移，且改完 validate-all + 更新 DATA-FORMAT）。
- **不要**重复实现转换/校验——用 src/ 共享模块。
- 图片引用用相对路径（`assets/xxx.png`），**不要**用绝对路径。
- 删除节点是**级联**的（子树全删）；删除前确认。
- 根节点 id 固定 `root`，不可删除/移动。
- `clone` 会**保留** tags/files（曾丢失过）；新 id 由命令自动生成并在输出中给出，勿自行假设。
- CLI 失败时**退出码非 0**（首选判据），同时 stdout 以 `error:` 开头（文本辅助判据）。
  > 历史：失败曾返回 exit 0，只能靠前缀判断；现已修正（见 `docs/CLI.md` 通用约定）。
