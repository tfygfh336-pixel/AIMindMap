# 扩展契约（EXTENSIONS）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 契约
作用: 扩展契约：稳定性等级、如何新增命令/工具
不该写: CLI 全量签名（指向 CLI.md）
更新方式: 手写
-->

> 作用：写给**要在本工程上加东西的人 / AI** —— 能扩展什么、怎么扩展、哪些接口可以依赖。
> 边界：命令**完整用法**见 `docs/CLI.md`（自动生成）；架构理由见 `docs/ARCHITECTURE.md`。
> 前置认知：本工程没有插件市场，也**不打算有**（原因见 §5）。扩展 = 改源码 + 跑验证。

---

## 1. 可依赖的稳定接口

只有以下三类是**对外承诺**的接口。其余（内部函数、文件布局、DOM 结构）随时可能变。

### 1.1 数据格式（最稳定）

`projects/<name>/<name>.json` 是**唯一真源**，格式契约见 `docs/DATA-FORMAT.md`。
承诺：**只增不改**（新增可选字段不破坏旧解析器；破坏性变更递增 `formatVersion`）。
→ 外部工具应直接读 JSON 文件，而不是调 CLI 来读。

### 1.2 CLI 命令（稳定的自动化入口）

`node cli/mm-cli.js <命令>`，退出后：stdout 输出结果；**失败时退出码非 0** 且 stdout 以
`error: <原因>` 开头（两重判据）。`--json` 提供机器可读输出。

稳定性分三级 —— 改动前请确认你在依赖哪一级：

| 级别 | 含义 | 命令 |
|------|------|------|
| **稳定** | 名称、参数、JSON 字段结构不会在非大版本中变更 | 数据读写类：`read`/`list`/`get`/`search`/`add`/`edit`/`move`/`remove`/`validate`/`validate-all`/`projects`/`stats`/`assets`/`files`/`init` |
| **演进中** | 可用，但字段可能增补（不影响既有字段） | 树与资源：`backlinks`/`related`/`source-chain`（**经验来源链 `SC`**，台账 `W17`：**只沿** `links[].caption` 以「出自：」开头的边多跳溯源，`--reverse` 反查"谁把我当出处"；**成环响亮拒绝并逐条点名环上的边**、撞上限**响亮报错**、**零写盘**（不记热度 ⇒ `--json` 两跑逐字节相同）；`--json` 的 `chains`/`otherPrefixes`/`nearMiss` 字段可能增补）/`orphans`/`mentions`/`contents`（**概念目录 `CC`**：把树聚合成**按书内出现顺序**排的概念清单，同名合并、每条带落点 id；`--apply` 才写，生成/就地更新「概念索引」分支且**幂等**；「概念」的判据 = 标题去章节号前缀 + 承载体（纯分组容器不算）+ `count` = 落点数 + 正文提及数，而"提及"与 `mentions` **同一个** `findMentions`；`--json` 的 `items[]` 字段可能增补）/`clone`/`add-root`/`expand-depth`/`theme-layout`/`link`/`unlink`/`links`/`links-prune`/`add-image`/`remove-image`/`add-file`/`remove-file`<br>导入导出：`import-md`/`import-project`/`import-dir`/`bind-sync`（绑定工作区文件夹：`--bind`/`--pause`/`--resume`/`--unbind`/`--list`/`--watch-dirs` 与"同步一次"，R4）/`merge-project`（把若干个**已有项目**整棵并进一个已有项目；每个源成为一个分组节点 `merge-<源项目名>`，除源根外的 id 逐字带走、`origin` 原样带走；跨项目边默认 `--links keep` 不改、`repoint` 才逐条核验改指）/`learn-path`（**学习链路 `LP`**：若干本已入库的书 ⇒ **一条有序链路**，落成**一个新项目**；步骤顺序 = `children` 顺序、每步 `links[]` 指回原书节点、`detail` 里写"为什么排在这"；**输入只读**，生成前后对输入逐字节对拍，任一字节不同即响亮失败；**零 AI 调用**，AI 只留接口位；`--json` 的 `steps[]`/`gaps`/`ai`/`determinism` 字段可能增补）/`export-md`/`export-json`/`export-html`/`import-json`<br>事务（操作清单一次生效）：`apply`<br>条目层写原语（契约 `docs/ITEM-MODEL.md` §3）：`item-add`/`item-edit`/`item-remove`/`item-move`/`item-order`/`render-detail`、`migrate`（`migrate items` 子命令：v2→v3 条目层迁移）<br>条目层复校与体检：`recheck`/`health`<br>关联笔记：`assoc-list`/`assoc-add`/`assoc-edit`/`assoc-remove`/`assoc-prune`<br>AI 问答：`ask`/`ask-apply`<br>界面协作：`ui-state`/`sidebar-only`/`dsh-sidebar`/`dsh-status`/`dsh-prefill`/`dsh-caps`/`draft-map`（**草稿图 `DM`**：把一棵树（`{topic, detail?, children?}`）送进一个**临时**小窗（置顶、按内容定窗口大小、**不落 `projects/`**、关窗即弃），人在窗口里决定「并入主导图（选落点）」或「丢弃」；并入 = `apply` 一次原子写 + 回读，同指纹**幂等**拒绝。⚠️ 它**只新增窗口**，对主图零写入 —— 与 `sidebar-only` 那族"驱动已有界面"的方向相反；`--json` 的 `result` 字段可能增补）<br>历史：`changes`/`changelog`<br>访问热度：`visit`/`heat`<br>跨项目检索：`search-all`（一次扫全库，每条命中带 `project`；`--scope` 收窄范围）<br>标签清单：`tags`（**只读**：有哪些标签 / 各多少个节点 / 分布在哪几个项目 —— 不给项目名 = 全库，点名项目 = 只扫这些。`--vocab` 追加三条**契约判据**：闭集核对（是否都在 `docs/TAGS.md` §4）/ 落点下限（§2 第 6 条 · §8 判据①：≥5，§4 写明「门面特性」的行 ≥3）/ "词表空转"（§4 有但 0 落点）。⚠️ `--vocab` **必须点名项目**：那份词表的标题是「7 本书共用」，而"哪几个项目适用"盘上没有机器可读的声明（`comnet` 有自己的标签，不受它约束）⇒ 全库只给清单、不给合规判断；`--json` 的字段可能增补） |
| **内部** | 工程维护用，不保证兼容 | `docs-gen`/`release` |

> **`clone` 的条目级边口径（v3，2026-10）**：仍列「**演进中**」—— 名称、既有参数与既有 JSON 面未变，
> 只**新增**了开关 `--repoint-items` 与 `--json` 的 `itemEdges` 字段。口径三态：副本上的条目 **id 重新签发**
> （`docs/ITEM-MODEL.md` §5.1 的全项目唯一），而副本上的条目级边（`links[].item`）**默认逐字仍指原物**
> （**引用语义**：克隆不改边自己的意思；`--json` 的 `itemEdges.kept` 逐条点名"未被重指向"的边，
> 文本档**仅当副本上真有这类边**时多一行 —— 没有 ⇒ 输出与从前逐字相同）。
> `--repoint-items` 把它们改指**副本自己那份新条目**的**同序号**条目（**语义改变**：引用原物 →
> 副本内部指涉；目标节点与条目**两端一起换** —— 只换 `item` 会立刻变成悬挂），
> 对不上（目标在别的项目 / 目标节点不在被复制范围 / 那个节点里没有这条条目）⇒ **拒绝并点名**、
> **绝不按序号猜**。判据：`tests/clone-item-links.test.js`（含"无这类边时输出逐字不变"与注入证明）。
>
> **同一条口径的接线面（v3，2026-10）**：① `--repoint-items` 已进 `cli/core.js` 的**纯布尔登记表**
> ⇒ `clone 项目 --repoint-items <源> <新父>` 与 `--deep` **同待遇**（选项写在位置参数之前也不会把源 id
> 吞成它的值；带 `=` 的写法照旧**响亮拒绝**）；② `apply` 的 clone op 支持同一个开关
> （`"repointItems": true`，别名 `repoint_items`，解析只有一处 = `repointFlagOf`）—— 判定与执行就是
> 上面这两条命令面实现（`planItemEdges` / `repointRefusal`，**不另写一份**），对不上 ⇒ **整份 ops 拒绝、
> 盘上零改动**并点名（与别的 op 的执行期失败同一形状；`--dry-run` 里同样看得见）；
> ③ MCP `clone_node` 增补 `json: true`（拿 `itemEdges`；**只加参数、不新增工具**，工具数不变）。
>
> **`merge-project` 的 id 与边口径（2026-10-19）**：列「**演进中**」—— 名称、既有参数与既有 JSON 面都是
> 新命令的第一版，`--json` 的字段可能增补。三条对外承诺（改动前先读，改了就是改契约）：
>   ① **除源项目根那一个 id 之外，每一个节点 id 都逐字保持不变**（不重签发）。分组节点就是**源项目的根**，
>      只把 `root` 换成确定性的 `merge-<源项目名>` ⇒ 所以"合并后的节点 id 还能不能拿来用"的答案是
>      **能，除了那一个分组 id**。撞号一律**拒绝并点名**，不自动改名。
>   ② `origin` **逐字原样带走**（`src`/`sha256`/`at`/`tool` 一个字都不重算 —— 它是溯源，不是指纹）。
>   ③ `links[]` **默认一个字节都不改**（`--links keep`）：源项目默认保留 ⇒ 跨项目边不会悬挂；
>      `--links repoint` 才把"指向本次也合并进来的源项目"的边改指目标项目内**同 id** 的节点
>      （指源的根则改指那个分组节点），**每一条都逐条核验**，一条核验不过 ⇒ **整条命令拒绝并点名**，
>      绝不按序号猜。**幂等**：同一份源合并两次会被拒并**指名上一次落到哪个分组节点**；没有 `--force`。
>   判据：`tests/merge-project.test.js`（38 条纯逻辑用例，含每一条拒绝分支"目标数据零改动"）+
>      `scripts/cli-integration.js` 的「合并·*」组（22 条端到端断言）。
>
> **本表必须覆盖 `cli/registry.js` 里的全部命令**（每条命令**恰好**落在某一级里）——
> 门禁 G8 的第 ⑮ 条判定（`scripts/docs-registry-check.js` 的 `checkStabilityCoverage`）机械核对。
>
> **`search` 的条目层增补（v3，2026-10）**：仍列「**稳定**」—— 名称、参数、**既有**字段结构未变；
> 但默认搜索口径从"只搜节点"改为"**默认搜条目**"（`--topic-only` 回退到旧口径），并**增补**了命中字段
> `itemId`/`type`/`itemized`/`matchIn`（只增不改、不影响既有字段消费方）。理由与签名冻结在 `docs/ITEM-MODEL.md` §3。
> ⚠️ `--no-heat` 也进 `cli/core.js` 的**纯布尔登记表**（2026-10）：`search 项目 --no-heat <关键词>` 这种
> 摆法不再把关键词吞成开关的值（与 `--deep` / `--repoint-items` 同一处登记、同一个理由）；
> 带等号的两态写法（`--no-heat=false` / `=true`）语义**一个字不变**。
>
> **导入类的「前导正文落点」口径（2026-10）**：`import-md` / `import-project` / `import-dir` 仍列
> 「**演进中**」—— 名称、参数与既有 JSON 面**未变**，只是把"**第一个标题之前**的那段正文（前导正文）
> 往哪儿放"从"代码注释里的约定"升成**明文规则**：目标节点**没有** `items` ⇒ 前置进它的 `detail`；
> 目标节点**有** `items`（已条目化）⇒ 成为 **`items[0]`** 并按其重建派生缓存 `detail`
> （条目化节点上 `detail` 是派生缓存、真源是 `items`）。规则全文与三条落地纪律**只有一处**：
> `docs/ITEM-MODEL.md` §2.1 —— **新增加导入入口的流照抄那一节，别在导入命令里另写一套**
> （同批还钉住了"`--dry-run` 与真跑**同一份判据**"，覆盖范围见那一节的如实登记）。
> 加这条判定的原因是一次真实的漏登记：`import-project` 一度**不在任何一级**，
> 而同批清点又查出 11 条同型漏登记（`ask`/`ask-apply`/`theme-layout`/`expand-depth`/
> `ui-state`/`sidebar-only`/`dsh-sidebar`/`dsh-status`/`dsh-prefill`/`dsh-caps`/`changelog`）。
> 病根是老病：**表在文档里、命令在代码里，两边都没有守望者** —— 新增命令时忘了改文档，
> 没有任何东西会红 ✗。现在有门禁了 ⇒ 新增/改名/删除命令时本表与 `cli/registry.js` 要**同批**改 ✓。
> 判"放哪一级"是人的判断（门禁只判"有没有落在某一级"）：会被外部工具/AI 依赖的放**演进中**，
> 工程自用的放**内部**。
>
> **新增的那条命令是 `search-all`（W1，2026-10-13）** —— 为什么是「**演进中**」：它会被外部 AI 当检索
> 入口长期依赖，但**返回面还在长**（本件只保证 `{keyword,tag,scoped,scope,scanned,hits,hitCount,truncated,mode,budget,heat}`
> 这些字段先生效；W4 的混合检索/权重、W2 的时效、W3 的语义一路一路都会往这里加**新字段**），
> 所以不放进「**稳定**」那一格（那一格的承诺是"字段结构不在非大版本中变更"）。
> 它**不是**新的一套检索：选项面 = `search` 那一套 + `--scope`，逐个项目转发给**同一个**
> `src/item-index.js` 的 `searchItems` ⇒ 过滤/命中形状/预算口径/热度排序都只有那一份实现
> （排序唯一实现处仍是 `orderByHeat`；跨项目**不做重排**，理由写在 `cli/commands/project.js` 的 `scanAll`）。
> 两条硬上限（命中总数 / 扫描耗时）与它们的报文在 `src/item-index.js` 的 `scanGate`（唯一一处）；
> MCP 侧**不新增工具**（仍是 51 个）：`search_nodes` 少给 `project` 即走全库档、`scope` 收窄。
>
> **写入类命令的 `--dry-run`（W8，2026-10-13）**：**数据面写命令统一支持**这个开关 ——
> 先报告"这次写盘会改动哪些对象"（**个数 + 对象键清单 + 按类型的计数**），而**一个字节都不写盘**
> （项目 JSON 与 `.changes.jsonl` 都逐字节未动）。三条契约：
>   ① 报告里那份清单**就是**真跑之后 `.changes.jsonl` 里那条 `changed`（两处走同一个
>      `src/concurrency.js` 的 `changedKeys`、输入是同一对：盘上现有数据 → 计划数据）⇒
>      "dry-run 说的 = 真跑后实际变的"是**构造保证**，不是两边各写一份口径再祈祷它们一致；
>   ② 报告与真跑**同一套判据**：dry-run 期照样会拒绝（节点不存在 / 重复拒绝 / 悬空引用…），
>      且报同一句话 —— "预览说能写、真跑被拒"这种落差不存在；
>   ③ `--dry-run` 与 `--idem` 互不影响：dry-run 不写盘 ⇒ 不算"生效" ⇒ **不查也不记**幂等键。
> **登记只有一处**（`cli/core.js` 的 `DRY_RUN_COMMANDS`）：registry 的选项白名单由它**现取**，
> 命令层判定统一读 `ctx.dryRun`（不许各读 `ctx.args.dryRun`），打印与短路在 `ctx.write` / `ctx.mutate`
> 两个写出口各一处（`planWrite`）。**唯一不支持的是 `import-json`**（它建新项目、资源解包又不走写管道
> ⇒ 给了这个开关只会得到假报告），带它会被**响亮拒绝**并说明原因与出路（`DRY_RUN_UNSUPPORTED`）。
> MCP 侧**不新增工具**（仍是 51 个）：29 个写类工具多一个 `dry_run` 参数（`import_json` 故意没有）。
> 判据：`tests/w8-dry-run.test.js`（①零字节 ②报告可解析 ③报告⇄日志逐字一致 ④注入证明 + "一处实现"静态把守）。
>
> **检索的命中与排序口径（W6，2026-10-13）**：`search` / `search-all` 仍列「**稳定**」—— 名称、参数、
> **字段结构**一个字未变（改动只落在"**什么算命中**"与"**谁排前面**"这两件事上，`score` 的含义仍是
> "子串出现次数"、模糊命中回落 `1`）。两条新口径，CLI / MCP 与**界面命令面板同一份**：
>   ① **命中 = 关键词是命中面的「非连续子序列」**（大小写不敏感）—— 与面板的模糊检索同一个谓词；
>      于是 `闸门` 能命中 `闸 与 门` 之间隔了字的标题（从前 CLI 只认字面子串，同一个词在面板里能搜到、
>      在 CLI 里搜不到）；判据"非连续子序列时 CLI 也能命中"就是这一条的读数。
>   ② **顺序 = 那份模糊打分升序，同分保持「深度优先 + 条目序」**（纯 `--tag` 无关键词 ⇒ 不排序）——
>      于是**本机没有热度日志**（或加 `--no-heat`）时，同一查询的节点顺序与命令面板**逐条相同**
>      （判据②"UI 与 CLI 一致顺序"）。热度（H1）仍是**最后一道**重排、照旧封顶：它把①这一层排好的
>      顺序当基线，只在其上微调 ⇒ `--no-heat` 那一档与"从来没有过热度的项目"逐字节相同（H1 判据不变）。
> **打分与定序只有一处实现**：`src/palette-rank.js` 的 `fuzzyMatch` + `rankRows`（命令面板吃同一份）；
> `src/item-index.js` 只决定"哪些面参与打分"（标题 / 正文 / 条目正文 / 图片说明 / 链接说明）与命中形状，
> **不写第二份打分**（结构断言在 `tests/search-fuzzy.test.js`）。契约 `docs/ITEM-MODEL.md` §3.4 的
> 命中形状（12 键）与 `matchIn` 封闭取值表**未动**。
> 判据：`tests/search-fuzzy.test.js`（两条判据 + 一致顺序 + 注入证明 + "一处实现"静态把守，端到端走
> `AI_MINDMAP_PROJECTS_DIR` 临时沙箱）；受影响的既有断言在 `tests/item-index.test.js` 与
> `tests/search-all.test.js` 各一处**如实改口径并写明理由**（不是放宽：命中集合与顺序都写死成真值）。
>
> **混合检索与权重（W4，2026-10-13）**：`search` / `search-all` 的选项面**只增不改** ——
> 多三个开关 `--mode <预设>` / `--weights <路由=权重,…>` / `--explain`，其余参数与命中形状
> （12 键）、`hitCount`、`matchIn` 封闭取值表**一个字未变**。三条口径：
>
> ① **默认关**：**不给 `--mode` / `--weights` 时，混合检索这一层不启用 —— 输出与从前逐字节相同**
>    （W6 判据②"零热度档 CLI 顺序与命令面板逐条相同"、H1 的热度封顶判据因此都不受影响）。
>    什么时候打开：**想按"相关性之外的第二维"再排一次**时 —— 例如"跟最佳命中相邻的也算相关"（`graph`）、
>    "同等相关时人核过 / 人写过的先看"（`trust`）、"最近写下的先看"（`time`）。
>    要复现"我想看看换一套权重会怎样"就用 `--explain` 把逐路读数一并拿到。
> ② **融合是 RRF，只有一处实现**：`总分(d) = Σ_r 权重_r / (k + 名次_r(d))` ——
>    **只吃名次** ⇒ 不含量纲、不需要归一化、不必知道某一路的分数值域（模糊分可为负、热度是份额、
>    图距离是跳数，本来互不可比）。路由表 `ROUTES`、预设 `MODES`、平滑常数 `k`、解析与 `fuse()`
>    **都只有 `src/palette-rank.js` 一处**（与"什么算命中、谁排前面"同一个家）；
>    `src/item-index.js` 只负责把每路的**名次**算出来喂进去，**不写第二份融合或权重**。
>    权重与 `k` 全部从那一处**现取** —— 本文与 `docs/CLI.md`、命令登记表里一个数字都不抄
>    （F10：只写去哪取）。
> ③ **热度不在这张路由表里**（两条独立裁决）：热度有自己的封顶口径（`src/heat.js` 的 `SEARCH_RANK`：
>    人 / AI 两条、合并 ≤ 8%）与自己的位置（**最后一道**重排，`src/item-index.js` 的 `orderByHeat`）——
>    把它并进 RRF 会让"热度占比 ≤ 10%"那条变成"众多一路之一"。
>    顺序因此固定为：**硬过滤 → 字面匹配定候选与基线 → 多路 RRF 融合 → 热度封顶重排 → 预算**。
>
> **能力边界（W4 那一批没做、且明说）**：融合只在**既有命中内部**重排，**不扩召回** ——
> 让"非字面命中"也进结果要给它一个 `matchIn` 取值，而那张表是**封闭**契约（`docs/ITEM-MODEL.md` §3.4），
> 改它是一次契约变更 ⇒ 当初另立一件做（W4b）。**W4b 已落地**：见下面紧邻的那一段。
> 另外**语义那一路（W3）未落地**：
> 它是路由表里 `installed:false` 的一行，权重收下但**不产生名次**，`--explain` 会**逐路点名**
> （"少了一路"必须看得见，不许静默）；同理，某一路因为**没有那一维的数据**而恒空时
> （例如命中的条目一条都没有 `at`），`--explain` 也照实说，读者不会把它误读成"这一维没有问题"。
> MCP 侧**不新增工具**（仍是 51 个）：`search_nodes` 多三个参数 `mode` / `weights` / `explain`
> （一层透传，取值一律由 CLI 决定）。
> 判据：`tests/search-hybrid.test.js`（默认档逐字节不变 + `--explain` 逐路可见 + 改权重的前后对比
> 走黄金集 `tests/fixtures/hybrid-golden.json` + 参数写错响亮 + 结构断言 + 注入证明 + 端到端沙箱）。
>
> **扩召回与 `matchIn` 开表（W4b，2026-10-13）**：`search` / `search-all` 的选项面**只增不改** ——
> 多一个开关 `--recall <路由>`；命中形状仍是 **12 键**（本件是**开** `matchIn` 的**取值表**
> —— 旧的八个值原样保留、多一个 `near`，**一个键都没加**：开取值表 ≠ 加键）。四条口径：
>
> ① **默认关**：**不给 `--recall` 时输出与从前逐字节相同** —— 候选集、`hitCount`、`matchIn` 的取值集合
>    都不变（与 W4 那条"不给 `--mode` / `--weights` 就不启用"同一条纪律；W6 判据②与 H1 的封顶判据都不受影响）。
>    什么时候打开：**答案只写在邻居里、它自己的正文里没有那个词**时 —— 例：问「构建缓存」，而
>    "上次编译的产物怎么复用"那条笔记一个字都没提它：从前它**连结果都不在**（不是"排在后面"），
>    也就是"AI 只好再上网搜一次"的那个处境。
> ② **真的扩召回**：给了它 `hitCount` 与 `hits` 会**变多**（不是重排）。新命中的 `matchIn` = 该路声明的
>    取值（`graph` ⇒ `near`）、`itemId`/`type` 为 `null`、没有 `snippet`、`score` 回落 `1` —— 形状仍是
>    契约 §3.4 那 12 个键（语义与逐键见 `docs/ITEM-MODEL.md` §3.4）。
>    它**必须与 `--mode` / `--weights` 同给**：它改的是**候选集**，而"这批候选怎么排"是融合那一层的事 ——
>    只给 `--recall` 就等于替你偷偷挑一个默认预设，那会**当场报错**（不静默）。
> ③ **一处实现**：能扩召回的路由、深度上界、新取值名**都只有 `src/palette-rank.js` 一处**
>    （路由表那一行的 `recall` / `bound` / `recallHit`）。`src/item-index.js` 只做三件事：用**同一个**
>    `graphHopsFrom` 拿跳数表、用**同一个** `hitOf` 造命中、用**同一份** `paletteRank.fuse` 排序
>    （扩召回**没有**第二套打分/排序）。上界 = 那一行的 `bound`（与"图距离"这一路**同一个数**：
>    能进来的正是"名次表里本来就有、只是从前没有候选位"的那批节点）。
>    硬过滤仍正交：`--tag` 与关键词照旧 AND；给了条目级过滤（`--src` / `--verified` / `--type` / `--since`）
>    ⇒ 扩召回不参与（它不许绕过过滤）。
> ④ **归因可见**：`--explain` 多一栏 `recall:{on,asked,routes:[{id,hitValue,bound,asked,added,note}]}`
>    —— 逐路报"这次接回来几条 / 为什么是 0"（**没点名的路由也在**，标 `asked:false`：少一个开关也要看得见）；
>    新命中的逐条读数里 `text` 那一路名次是 `null`（"它不是字面命中"看得见）。
>    ⚠️ **如实标注的一处差异**：`--explain` 的**读数面只增**了这一栏（含"扩召回没启用"时的说明）——
>    它**不改命中集、不改顺序**；**默认档（不给 `--explain`）逐字节不变**，跨版本文档对照见交付说明。
> MCP 侧**不新增工具**（仍是 51 个）：`search_nodes` 多一个参数 `recall`（一层透传，取值由 CLI 决定）。
> 判据：`tests/search-recall.test.js`（默认档逐字节不变 + 只增不许变差 + 上界取自路由表 + 硬过滤正交 +
> `--explain` 逐路点名 + 黄金集里"非字面命中"那一类的读前/读后读数 + 注入证明 + 结构断言 + 端到端沙箱），
> 契约与逐键在 `docs/ITEM-MODEL.md` §3.4 与 `tests/item-index.test.js`（**键仍 12**）。

### 1.3 MCP 工具（面向支持 MCP 的 agent）

`node scripts/mcp-server.js` 启动 stdio MCP 服务器（协议 2024-11-05）。
**每个 MCP 工具都是某个 CLI 命令的透传**，不包含独立业务逻辑 ——
所以「CLI 能做的，MCP 都能做；MCP 没暴露的，直接用 CLI」。工具清单见 `docs/VERIFY.md` 与
`scripts/mcp-server.js` 的 `TOOLS`（已导出，可 `require` 读取）。

---

## 2. 如何新增一个 CLI 命令

1. 在 `cli/commands/<域>.js` 中实现，函数签名 `fn(ctx)`：
   - `ctx.read()` / `ctx.write(data)` —— 读/写当前项目（**写会过校验闸门**）
   - `ctx.args._` 位置参数、`ctx.args.<key>` 具名参数（`--key value`）
   - `ctx.projectName`、`ctx.out()` / `ctx.outJson()`、`ctx.error(msg)` 抛错
   - `ctx.tree`（共享树函数）、`ctx.store`（存取层，含 `writeFileAtomic`）
2. 在 `cli/registry.js` 的 `init()` 中登记 `{ name, aliases, usage, desc, fn }`。
3. 在 `scripts/cli-integration.js` 追加断言（**新增命令必须加**）。
   断言要测**真实副作用**，而不是"命令没报错"：例如 `export-html` 的断言会校验
   "模型引用的每个资源都真的复制到了输出目录"（否则分享出去的站点会图挂）。
   造测试图时注意：**目标节点必须真的存在且真的建成了链接**，否则 `link` 会静默失败、
   断言假通过/假失败 —— 必要时先加一条"前置条件断言"。
4. 重生成文档：`node cli/mm-cli.js docs-gen`。
5. 若需暴露给 MCP：在 `scripts/mcp-server.js` 的 `TOOLS` 加定义、在 `callTool` 加 `case`
   （**只允许拼参数转发 CLI，不得复制业务逻辑**）。
6. 同步 `CHANGELOG.md` 的 `[Unreleased]` 与 `README.md`（规则 R2，见 `docs/RULES.md`）。

**红线**：不要在命令里手写 `fs.writeFileSync` —— 一律用 `ctx.store.write()` /
`ctx.store.writeFileAtomic()`，否则绕过校验闸门或产生非原子写。

---

## 3. 如何新增渲染层功能

渲染层已拆分（`renderer/app.js` 曾是 1340 行单文件，现按职责分为多个模块，
全部挂在共享命名空间 `window.MM`，详见 `docs/ARCHITECTURE.md` §2.5）：

1. 新功能放进**对应职责的模块**（视图→`app-view.js`、详情框→`app-detail*.js`、
   媒体→`app-media.js`、操作与数据→`app-actions.js`）；`app.js` 只留 UI 接线与
   `window.MMApp` 导出。纯计算（如排序、检索）应下沉到 `src/` 并加单测 ——
   `src/palette-rank.js` 就是这么来的。
2. **业务逻辑不得在渲染层复制**：校验/转换/序列化走 `src/`（UMD，浏览器可直接用）。
3. **跨模块调用一律走 `window.MM` 的包装函数**（`const renderMind = (d) => MM.renderMind(d);`）。
   不要用解构赋值 —— 其他模块是后加载的，解构会在加载时捕获 `undefined`。
   拆分前同一闭包里的可变共享变量（整体重新赋值的那种）用同名全局槽位承载。
4. **注册全局监听 / 观察者必须放进带幂等守卫的 `bind*` 函数**
   （如 `bindContainerControls`、`bindViewportControls`、`bindFdGlobalDrag`、`bindAudit`、`bindPalette`），
   **禁止内联进 `renderMind()`** —— 该方法每次 undo/redo、切项目都会执行，
   内联注册会导致监听器无限累积（本项目曾因此出现"点一次触发 N 次"的泄漏）。
5. 在 `scripts/smoke/` 的**对应分域文件**追加断言（**新增渲染功能必须加**）。
   注意测**可观测的副作用**，不要依赖 jsMind 内部实现 —— 例如"折叠是否生效"不能用
   `jmnode` 数量判断（折叠时节点仍留在 DOM 里，靠样式隐藏，数量恒不变）。
6. 同步 `CHANGELOG.md` + `README.md`。

---

## 4. 如何新增数据字段

1. 改 `src/schema.js` 的校验（新增**可选**字段不必递增 `formatVersion`）。
2. 改 `docs/DATA-FORMAT.md`（契约文档，必须与实际一致）。
3. 若字段需要被 AI 读到：确认 `cli/commands/project.js` 的 `buildReadView` / `get` 输出它。
   **若新字段不在节点树里**（如 `assoc` 这类项目级集合）：它不会被 `serializeTree`、
   `export-md` 自动带上，必须逐条确认出口 —— 渲染层序列化（`state` 持有 + 写回）、
   `export-json`/`import-json`（`src/bundle.js` 的 `buildBundle` 与命令层复原）、
   主进程 `project:save` 的兜底，否则会在某条路径上**静默丢数据**。
4. 加测试：`tests/schema.test.js`（校验规则）+ 必要时 CLI 集成断言。

**注意**：字段加进 JSON 不等于**对 AI 可见**。AI 只读 `read` / `get` 的输出，
新增字段若没进这两个视图，等于白加。

---

## 5. 为什么不支持插件 / 主题 / 脚本扩展

本工程刻意不提供插件体系（**已决策，不再讨论**，原因记录在 `docs/ROADMAP.md` 的"已否决"）：

| 常规做法 | 本工程的选择 | 理由 |
|---------|------------|------|
| 插件市场 + 热加载 | ❌ 不做 | 需要沙箱、签名、审核、版本兼容矩阵；单机个人工具，收益远小于维护成本 |
| 主题/样式包 | ❌ 不做 | 样式集中在 `renderer/style.css`，需要时直接改文件即可 |
| 用户脚本钩子 | ❌ 不做 | 与"数据改动一律走 CLI 校验闸门"冲突，会引入未校验写入 |
| 外部 API 集成 | ✅ 用 MCP | **AI 就是扩展机制**：长尾需求由 AI 通过 CLI/MCP 组合现有原子能力动态完成，无需预置插件点 |

**这条设计的实际含义**：想加功能时不要设计"扩展点"，而是问
"现有原子命令能否组合出来" —— 例如"批量给某主题下所有节点打标签"不需要新插件，
用 `list --json` 筛出 id 再循环 `edit --tags` 即可；若这个组合被反复需要，
就把它固化成**一条新 CLI 命令**（§2），而不是一个插件 API。

---

## 6. 与其他 AI 工具协作

- **MCP 客户端**（Claude Desktop / Cursor / DeepSeek Harness 等）：配置
  `command: node`、`args: ["<工程绝对路径>/scripts/mcp-server.js"]` 即可。
- **无 MCP 的工具**：直接调 CLI（`node cli/mm-cli.js ...`）或读 JSON 文件。
- **接入前建议先读**：`SKILL.md`（触发与动作现场条目）→ `docs/RULES.md`（必须遵守什么）→
  `docs/AI-GUIDE.md`（操作规范）→
  `docs/DATA-FORMAT.md`（数据契约）。这三份足够写出正确的读写实现，无需读源码。
