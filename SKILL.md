---
name: "ai-mind-map"
description: "维护 AI MindMap 智能笔记工程（面向 AI 与人协作的思维导图式笔记工具）：人用 Electron、AI 用 CLI 或 MCP，数据为 JSON 节点树；支持节点/详情/图片/附件增删改、跨项目链接、Markdown 导入导出、按内容检索。触发：整理或维护思维导图笔记、新建或编辑笔记项目并加内容、把 Markdown 变导图、用 mm-cli 或 MCP 操作笔记数据。写任何文件前先读正文顶部「落盘规矩」（分析/汇报放对话或 .review/，文档须先登记 §5，乱放会被门禁 G8 判红）。"
---

# AI MindMap

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 入口
作用: 触发与导航：何时用、从哪读起、动作现场条目
不该写: 规则全表、命令清单、数据格式
更新方式: 手写
-->

本目录是一个**完整可独立运行的工程**，同时以 **Skill 形式**被本机豆包加载。

## 落盘规矩（写任何文件之前先读这 4 条）

> 面向**每一次全新的对话**：你不必读完本工程的全部文档，但**落盘**这件事没有自由裁量权。

1. **默认不落盘**：分析、汇报、方案讨论**写在对话里**就够。落盘前先问一句：**3 个月后还会有人读它吗？**
2. **必须落盘时只有三条路**：
   - **工作产物**（分析稿、评审稿、读图记录、探针脚本、临时数据）→ **`.review/<YYYYMMDD>-<主题>/`**
     —— 这是本工程**唯一**的杂物区：可随时整目录删除、不进版本库、不进 G6 数字扫描；
     根下只另有**机器产物**（`verify-tests.json` / `last-verify.json`，由命令自动写，别手改）。
   - **要长期存在的文档** → `docs/`，**但必须在文档自己的头部写元信息块**
     （`<!-- registry 层/作用/不该写/更新方式 -->`），然后跑 **`npm run docs:registry`**
     重新生成 `docs/ARCHITECTURE.md` §5 登记表（**表是生成的，不要手改**；改表格或改了元信息
     不重生成，G8 都会判红），并遵守"一份事实只写一处"；
   - **一次性旧稿** → `docs/archive/`（只增不改）。
3. **禁止**：在工程根或任何其它目录新建 `md`/`html`/图片/`json`/脚本；也**不要写到工程外**
   （如 `.user_skills/` 根目录）—— 要留就留 `.review/`。
4. **违反会被机器抓住**：`npm run verify` 的**门禁 G8**（`npm run check:docs`）会判红 ——
   表外文档、散落文档、工程根乱放、陌生顶层目录都在判定范围内，报错信息里直接给出上面三条路。

## 接手 5 步（**第一次进入本工程就按这个顺序走**）

> 面向"新接手的 AI"：不必通读全部文档（活跃文档体量可观，其中 CHANGELOG 占了大头）。
> 按这五步走，够你正确使用它、也够你把活接着干完。

1. **看没做完的事** → `docs/ROADMAP.md` 的「**在飞 / 未收口**」小节（每条都带 `.review/` 证据指针）。
2. **看最近改了什么** → `CHANGELOG.md` 的 `[Unreleased]`（已完成、等发版的变更）。
   > 两者分工不同，**缺一边就会误判现状**：`[Unreleased]` = 做完但没发版；「在飞」= 还没做完。
3. **找你这类的做法** → `docs/ARCHITECTURE.md` **§6 每任务四步**（读哪份 → 改哪里 → 跑什么 → 更新什么）。
4. **改完怎么算完** → `npm run verify` **全链全绿**才算验收（**步骤数 14 步** —— 由 `scripts/verify.js` 的
   `STEPS` 现场决定、**G6 校核这一句**（`docs/VERIFY.md` 是生成物，跟着 `STEPS` 走；本页是手写的，
   曾经漂了两轮没人察 ✗）；其中 G7 与 G6 共用一次调用、没有自己的命令）。
   **总预算 400s**，单项预算见 `scripts/verify.js` 的 `STEPS`，改动要带实测理由。
   只改文档时可先跑子集自检（`check:docs` + `check:rules` + `facts` + `check:encoding`，十几秒），**但它不是验收**。
   > 顺手看 verify 开头那行「**上次全链**」—— 它告诉你动手前的基线绿不绿（记录在 `.review/last-verify.json`）。
5. **收尾** → 在 `CHANGELOG.md` 的 `[Unreleased]` 记一笔（新增文档还要先在 `docs/ARCHITECTURE.md` §5 登记）；
   在飞的事做完了，去 `ROADMAP.md` 改状态或删目录。

## 双重身份与角色边界（作为 skill 使用时先读）

本工程有两个使用面，**你作为 skill 消费者只涉及第一个**：

| 使用面 | 谁在用 | 相关目录 |
|--------|--------|---------|
| **笔记数据操作**（skill 的全部意义） | AI（你）经 CLI / MCP | `cli/` `src/` `projects/` `docs/` |
| **桌面应用功能** | 人类经 `npm start` 打开界面 | `renderer/` `main-dsh-sidebar.js` `vendor/dsh` `scripts/dsh-*` |

**内嵌 DSH 侧边栏属于第二个使用面**：它是给"没开 harness 的人类"在导图界面里用的
AI 助手。你本身就是运行中的 AI agent（本机场景下正是 DSH）——skill 场景里
**不需要、也不应该**去启动或连接这个内嵌实例：

- ❌ 操作笔记时不要碰 `vendor/dsh`、内嵌实例的端口、`dsh:vendor` / `dsh:maint`。
  CLI 就是你的操作面；绕道内嵌 DSH 等于让 AI 去找另一个 AI 代办自己能直接做的事
  （且内嵌实例有独立 HOME 与凭据，它默认甚至不认识本 skill）。
  （注：内嵌实例**自己**会经注入的指针 skill 操作笔记 —— 那是它作为人类桌面
  AI 的职责，与本 skill 消费者无关，两边用同一套 CLI 与数据闸门。）
- ❌ `npm start` 是人类动作（headless 下没有界面可看）；界面回归一律走 `npm run smoke`。
- ✅ 唯一例外：任务本身是**改应用代码**（含侧栏 / DSH 运行包 / 打包配置）——
  照常走分层测试 `npm run verify`，涉及 DSH 运行包或侧栏的改动追加
  `npm run dsh:e2e`（headless 脚本：孵化 → 校验 → 收割）与
  `npm run dsh:resident`（驻留语义：宿主退出后服务存活 → 新宿主接管 → 显式停止；
  这两条都不在 verify 里，因为各要真实冷启动一次，慢）。

## 导航：按任务读文档（按**层**分组，不要全读）

> 组序 = 文档架构的自上而下（第 0 屏 → 入口 → 治理 → 契约 → 设计 → 记录 → 归档）；
> 每一层的定义、作用与准入规则见 `docs/ARCHITECTURE.md` §5。
> **挑中一行即可，不必读完** —— 分组是为了让你知道"这份文档为什么存在、能不能改"。

**① 第 0 屏 · 落盘规矩**（写任何文件之前）

| 你要做的事 | 读这份 |
|-----------|-------|
| **要落盘 / 放文档 / 挪文件** | `SKILL.md` 顶部「落盘规矩」+ **`docs/ARCHITECTURE.md` §5**（准入登记表；表外文档 = 门禁 G8 红） |

**② 入口层 · 这是什么、怎么跑**

| 你要做的事 | 读这份 |
|-----------|-------|
| 产品全貌（人看的） | `README.md` |

**③ 治理层 · 必须遵守什么**

| 你要做的事 | 读这份 |
|-----------|-------|
| **查"必须遵守什么"** | **`docs/RULES.md`** —— 唯一权威副本（门禁 / 铁律 / 约定 / 元规则，含强制方式与来源） |

**④ 契约层 · 对外承诺与稳定接口**（改这些 = 改契约，需同步）

| 你要做的事 | 读这份 |
|-----------|-------|
| 查某条命令怎么用 | `docs/CLI.md`（生成物，勿手改）—— 不用读 README |
| 了解数据字段含义 | `docs/DATA-FORMAT.md` —— 不用读源码 |
| **动条目层（`items` / 条目级命令 / v2→v3 迁移）** | `docs/ITEM-MODEL.md`（v3 契约：条目形状、`items`↔`detail` 派生、CLI 与模块签名、迁移、并发粒度）—— v2 字段表仍在 `docs/DATA-FORMAT.md` |
| 跑验证 / 看当前各项数字 | `docs/VERIFY.md`（生成物：权威计数 + 验证链） |
| 要加命令 / 加 MCP 工具 | `docs/EXTENSIONS.md`（稳定性等级与扩展契约） |

**⑤ 设计层 · 怎么操作、为什么这么设计**

| 你要做的事 | 读这份 |
|-----------|-------|
| 读写笔记内容（最高频） | `docs/AI-GUIDE.md` + `docs/DATA-FORMAT.md` |
| 写笔记内容（节点怎么切、detail/caption 怎么写） | `docs/AI-GUIDE.md` **§3 笔记内容规范** |
| **改数据格式（加字段 / 改结构）** | `docs/DATA-FORMAT.md`（契约）+ `docs/ARCHITECTURE.md` **§6**（四步：读→改→跑→更新） |
| 改代码（加功能 / 改渲染 / 动侧栏与 DSH 运行包） | `docs/ARCHITECTURE.md` **§6 每任务四步** + `docs/EXTENSIONS.md` |
| **动内置 DSH（换运行包 / 导插件 / 改侧栏注入）** | `docs/DSH-EMBEDDED.md`（三层划分 + 每项改动升级后会不会丢 + 重建/核对办法）；执行用 skill `embedded-dsh-maintain`（换包/维护）或 `dsh-migrate-in`（**一次单向导入**：本机迁移 / 给别人的电脑打包 + 首次运行导入 / 回滚） |

**⑥ 记录层 · 发生过什么、要去哪**

| 你要做的事 | 读这份 |
|-----------|-------|
| **接手 / 看"现在做到哪了、下一步做什么"** | `docs/ROADMAP.md` 的**「在飞 / 未收口」小节**（每条带 `.review/` 证据指针，由 G8 校验不死） |
| 想知道做过什么 / 要做什么 | `CHANGELOG.md`（`[Unreleased]` + 最近 3 个已发版本段）/ `docs/ROADMAP.md` |
| **查"某件事怎么算做完"（逐条待做与验收判据）** | `.review/20261010-卖点与功能-常驻讨论/待做清单.md` —— **在飞工作稿（工作产物区，不在 §5 登记）**：用户 2026-10-10 裁定"讨论里长出来的待办留在讨论目录"；其中**定案且要长期保留**的结论才按 `docs/` 准入规则另立受管文档 ✓ |
| **查更早的版本变更** | `docs/changelog/`（**滚动归档**的历史版本段）或 `node cli/mm-cli.js changelog --grep <关键词>` —— 不要通读 CHANGELOG |
| 为什么有这些奇怪的禁令 | `docs/INCIDENTS.md` |

**⑦ 归档层 · 历史快照**

| 你要做的事 | 读这份 |
|-----------|-------|
| 回溯旧方案 / 旧审查结论 | `docs/archive/` —— **只增不改，勿作现状引用** |

## 用 CLI 操作数据（唯一的写入方式）

**不要直接改 JSON** —— 校验闸门在 CLI 里，绕过它会写出非法数据。
（提醒：你是 agent，操作面就是下面的 CLI —— 内嵌 DSH 侧边栏与你的任务无关，见顶部「双重身份」。）

```
node cli/mm-cli.js projects                       # 列出项目
node cli/mm-cli.js read <项目> --json              # 读全项目（树+详情+图片+附件）
node cli/mm-cli.js read <项目> --json --brief      # 只要结构（省 token；**省多少取决于详情占比，故不写百分比**）
node cli/mm-cli.js read <项目> --json --brief --compact  # 再加单行 JSON —— 三开关可叠加，省得多（**具体倍数见 `cli/registry.js` 的 `read` 条**：那里写着实测口径 ✓ 本文不写易腐数字）
node cli/mm-cli.js read <项目> --json --subtree <id>     # 只要某棵子树（定位到分支后的定点作业，再省一大截）
node cli/mm-cli.js list <项目> --json              # 只要 id+标题+层级（最省的「这里都有什么」）
node cli/mm-cli.js get <项目> <id> --json          # 读单个节点（含 path 层级路径）
node cli/mm-cli.js search <项目> <关键词> --json    # 全文检索（--tag 按标签）
node cli/mm-cli.js add <项目> <父id> --topic 标题 --detail-md "Markdown 详情"   # 推荐：自动转 HTML
node cli/mm-cli.js edit <项目> <id> --detail-md "..." --tags a,b
node cli/mm-cli.js backlinks <项目> <id> --json     # 谁引用了我
node cli/mm-cli.js related <项目> <id> --json       # 相关知识点（双向）
node cli/mm-cli.js orphans <项目>                   # 关系审计：有内容却无人引用的笔记
node cli/mm-cli.js ui-state <项目> --json           # 写前协调：界面有没有未保存编辑（桌面端开着时先查）
node cli/mm-cli.js changes <项目> --json            # 变更可见性：最近是谁、什么时候、改了哪些对象；
                                                   # 拿它的 rev/version 当锚点，写前再问 --since <锚点>
node cli/mm-cli.js changes <项目> --since <锚点>    # 自那以后改了什么。**报错 ≠ 没有变更**（答不了时它非 0 退出）
node cli/mm-cli.js mentions <项目>                  # 未链接提及：正文提到却没建链接的地方
node cli/mm-cli.js mentions <项目> --cross          # 同上，再扫跨项目两个方向（同名歧义会标记）
node cli/mm-cli.js related <项目> <id> --depth 2    # 两跳邻域：看得见间接关联的知识簇
node cli/mm-cli.js export-html <项目> <输出目录>    # 导出可分享的静态站点（含内联相关链接）
node cli/mm-cli.js theme-layout <项目> --left a,b --right c,d   # 顶层主题左右分侧（写入 meta.layout）
node cli/mm-cli.js changelog                      # 查变更轨迹：段/条目索引（行号+行数），不必通读全文
node cli/mm-cli.js changelog --grep 关键词 --full  # 同上的检索模式：命中条目连正文一起给
node cli/mm-cli.js dsh-caps --grep 关键词          # 查「DSH 到底能做什么／有没有这个能力」—— 从 vendor 装配清单机械读取，
                                                  # 防"以为不具备其实有"与"以为有其实没挂载"。**动手写新命令/装插件前先查它**
node cli/mm-cli.js validate-all                   # 全部项目校验
```

全部命令见 `docs/CLI.md`。失败时**退出码非 0**，且 stdout 以 `error:` 开头（两者都可用作判据）。

> **detail 存储格式是 HTML**（渲染层 `innerHTML` 注入），不是 Markdown。
> **写内容一律用 `--detail-md`**（命令内转 HTML）；`--detail` 是按 HTML 原样存，两者互斥。
> 详见 `docs/DATA-FORMAT.md` §2.4。

## 铁律（每次改动都要遵守）

> 规则的**唯一权威副本是 `docs/RULES.md`**（含分级、强制方式与来源）。下面是执行动作时
> 当场需要的那几条；与规则清单不一致时以 `docs/RULES.md` 为准。

1. **断言必须来自执行**：写下"支持 / 会 / 返回 / 省 token"之前**先跑一次**；跑不了就显式写「未验证」。
   —— 这是本项目历史上所有"文档说能用、实际不生效"缺陷的共同病因。
2. **双文档同步**：每次功能/格式变更必须更新 `CHANGELOG.md`（`[Unreleased]` 段）与 `README.md`，缺一不可。
3. **分层测试（只约束"改代码"）**：改了 `src/` 核心就加单测（`tests/*.test.js`）；加了/改了 CLI 命令就加集成断言（`scripts/cli-integration.js`）；加了/改了渲染功能就加冒烟断言（`scripts/smoke/NN-*.js`，入口 `scripts/smoke-assertions.js`）。断言要测**可观测副作用**，不要测"命令没报错"。
   **⚠️ 编辑笔记内容不属于"改代码"**：add/edit/link/assoc 等内容操作**只跑** `node cli/mm-cli.js validate <项目>`（数据闸门），**禁止跑 `npm run verify`**（那套 vitest+集成+冒烟全链是功能迭代用的，跑一次几分钟，与笔记编辑无关）。**"编辑笔记"与"功能迭代"是两条完全分开的轨道**：
   | 你在做的事 | 验证 | 什么时候 |
   |-----------|------|---------|
   | 笔记内容增删改（节点/详情/标签/链接/关联） | `validate <项目>` 一次 | 每次写完 |
   | 改应用代码（renderer/ src/ cli/ main*.js vendor 配置…） | `npm run verify` 全链 + 对应层补断言 | 改完代码 |
4. **测试必须 headless**：`npm run verify`。禁止用鼠标键盘测界面。（仅改代码时需要跑；编辑笔记见上条。）
5. **改动即连带**：凡改变「某功能**如何被使用**」的改动（数据形状、命令语义、交互模型、字段含义、默认值），
   **同一次改动里**必须列出受影响的**使用者可见面**并逐个核对 —— GUI 交互（按钮/右键/菜单/快捷键/对话框/状态栏）、
   冒烟与集成断言、`AI-GUIDE.md`/`README.md` 的操作示例、详情框与关联笔记的渲染入口；结论（含"无影响"）写进 CHANGELOG。
   **判据不是"测试是否还绿"**：实现方式变了、旧呈现还"能工作"、测试照样绿 —— 但人按原有习惯操作得到的效果
   已不是设计意图（已发生四起，见 `docs/RULES.md` §3 R5 的来源栏）。门禁 G5 抓不住这类损害，只能靠这一条自觉。

**执行动作时的两条操作约定**（不是铁律，但会省事）：

- **读写文本文件用工具**：读用 `read` 工具，写用 `write`/`edit` 工具；不要用 shell 命令读写文本
  （写入造成的损坏已由门禁 G1 兜住，但 PowerShell 5.1 的 GBK 默认解码曾把整个工程写坏过）。
- **改了 `registry.js` 就跑 `docs-gen`**：`node cli/mm-cli.js docs-gen`。忘跑会被门禁 G7 直接抓到并报出差异行。

> **门禁会自动拦住你**（都在 `npm run verify` 里，含编码完整性、数据校验、三层测试、
> 文档数字/版本一致性、生成物是否过期）—— 这些**不需要你记住**，跑一次 verify 即可。

## 目录速览

```
ai-mind-map/
├── SKILL.md          # 本文件：任务导航 + 动作现场条目
├── README.md         # 产品门面（人看）
├── CHANGELOG.md      # 变更轨迹（必更）
├── docs/             # 全部文档（见上方①–⑦分层导航组；RULES.md 为规则单源；archive/ 历史快照；changelog/ 滚动归档的历史版本段）
├── cli/              # AI 入口：mm-cli.js（薄壳）+ main.js（invoke，可进程内调用）+ registry + commands/
├── scripts/          # MCP 服务器 + 验证链（verify.js = 链的单源；encoding-check / docs-registry-check / rules-consistency / doc-facts / cli-integration / smoke-assertions 入口 + smoke/ 分域断言 / vendor-dsh / dsh-e2e / dsh-maintenance）
├── src/              # 共享核心（UMD：Node + 浏览器双端；dsh-package.js 为 DSH 运行包逻辑）
├── renderer/         # Electron 渲染层
├── projects/         # 笔记数据（<项目>/<项目>.json + assets/ + attachments/）
├── tests/            # vitest 单测
├── vendor/dsh/       # DSH 独立运行包（桌面应用侧栏用；**skill 操作不碰它**，git 忽略）
├── main.js / preload.js / main-dsh-sidebar.js
└── package.json      # 版本与脚本（npm start/smoke/test/verify/dist）
```

## 被其他 agent 调用

`node scripts/mcp-server.js` —— 标准 stdio MCP 服务器，每个工具都透传 CLI。
工具数见 `docs/VERIFY.md`。接入方式见 `docs/EXTENSIONS.md` §6。

