# 条目层契约（ITEM-MODEL）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 契约
作用: 条目层 v3 唯一契约：条目形状、items↔detail 派生、CLI/模块签名、迁移、并发粒度
不该写: v2 字段全表（见 DATA-FORMAT）、命令完整用法（见 CLI.md）、实现进度与计划
更新方式: 改冻结项前先改本文，再同批同步受影响的下游流
-->

> **状态：契约已冻结**（F0 会话，2026-10-11）。本工程并行开发的各条流**按本文编码**，
> 不按记忆、不按旧稿（`.review/` 里的设计草案是**种子**，本文是唯一权威）。
> 要改冻结项 = 改契约：**先改本文**，再同批同步受影响的流与 `docs/DATA-FORMAT.md` 的指针行。
>
> 边界：v2 现行字段全表见 `docs/DATA-FORMAT.md`；命令**完整用法串**见 `docs/CLI.md`（生成物，
> 由 `cli/registry.js` 的 `usage` 渲染）；架构理由见 `docs/ARCHITECTURE.md`。
> **冲突口径**：用法串以 `docs/CLI.md` 为准，**语义 / 回显 / 判据以本文为准**；
> 两者不一致时改 registry 并跑 `docs-gen`，不要改这份文档去迁就实现。

## 0. 谁读哪一节（以及最容易读错的一条）

| 流 | 必读 |
|----|------|
| S1 模型与迁移 | §1 §2 §5 §6 §8 §9 §10 |
| S2 条目写原语 | §1 §2 §3（写命令） §5 §8 §10 |
| S3 条目读与检索 | §1 §3（读命令） §7（qa 派生化） §10 |
| S4 复校与体检 | §1（`src` / `verified`） §9 §10 |
| S5 界面 | §2 §7 §12 |
| S6 关系与标签升层 | §7 §10 |
| S7 写管道 | §5.2（`--idem` 全节） §9 |
| W12 导入（Obsidian 直进等） | **§2.1（前导/前言的合法落点 + 预览与真跑同一份判据）** §2 §5.1 |
| I 整合 | §5.2 §9 §11 §12 |

> ⚠️ **最容易读错的一条**：`type:'rich'`（**条目**级：一条不可拆的表格/代码块）与
> `detailMode:'rich'`（**节点**级：整节点是富文本、没有 items）是**两个不同层级**的东西。
> 看到 `rich` 先问"这是条目的 type，还是节点的 detailMode"。

## 1. 条目形状（`formatVersion: 3`）

```jsonc
{
  "id": "i-3f2k9a",              // 必填。稳定、可寻址；生成后**永不变**（禁止用序号当接口）
  "type": "text",                // 必填。text | rich | qa（取值表封闭，见下）
  "html": "…",                   // type=text|rich 必填；type=qa **禁止**（正文由 qa 渲染）
  "src": ["CHANGELOG.md:713-717"], // 可选。出处：file:line / URL / 命令；字符串或字符串数组
  "tags": ["门禁", "检索"],        // 可选。**条目级**标签（节点级 tags 另有其人，见 §7）
  "at": "2026-10-11T04:00:00.000Z", // 可选（写命令一律给）。ISO 时间，与 qa.at 同口径
  "by": "cli:item-add",          // 可选。写入者，与 .changes.jsonl 的 writer 同一套标识
  "verified": {                  // 可选。核验：**缺失 = 未核**（不写 null）
    "at": "2026-10-11T04:00:00.000Z",  // 必填
    "by": "cli:item-edit",             // 必填（与 by 同口径）
    "how": "读了 src 指向的源码行"       // 必填：一句话说清"怎么核的"
  },
  "supersededBy": "i-xxxx",      // 可选。被哪条取代（只增不减：过期不删，指过去）
  "qa": { "q": "…", "a": "…", "at": "…", "model": "…" }  // 仅 type=qa，形状同 v2 的 qa[] 项
}
```

| 字段 | 类型 | 必填 | 默认 | 规则 |
|------|------|------|------|------|
| `id` | string | ✓ | — | `^[a-z0-9][a-z0-9-]*$`（与节点/assoc 同一套），**全项目唯一**（见 §5.1）。生成器一律带 `i-` 前缀；**校验不强制前缀**（照 assoc 的 `a-` 先例） |
| `type` | string | ✓ | `text` | 取值表 = `text` / `rich` / `qa`。**封闭**：别的值判红（设计草案里的 `fact`/`decision`/`todo` 是**预留、未启用**，不进契约；要启用先改这一行） |
| `html` | string | 见规则 | — | `type=text` / `type=rich` **必填**（HTML 片段，与节点 `detail` 同一套约定，渲染层 `innerHTML` 注入）；`type=qa` **禁止出现**（否则同一事实两处表达） |
| `src` | string 或 string[] | - | 不出现 | 出处。非空字符串（数组则每项非空）。**不校验指向的文件是否存在**（同 `localPath`/`origin`：那是环境问题） |
| `tags` | string[] | - | 不出现 | 每项非空字符串；条目级标签，**不合并**进节点级 `tags` |
| `at` | string | - | 不出现 | ISO 时间。**契约里可选**（写命令一律给；迁移写迁移时刻）。理由：把它做成硬必填会让"外部生成器拿不到时刻"变成假红 |
| `by` | string | - | 不出现 | `<外壳>:<命令>`，与变更日志 `writer` 同源，别自己拼 |
| `verified` | object | - | 不出现 | 三字段全必填（`at`/`by`/`how`）。**缺失 = 未核**；不写 `null`、不写空对象 |
| `supersededBy` | string | - | 不出现 | 另一个条目 id（同项目）。被它取代的条目**保留**（只增不减） |
| `qa` | object | 仅 `type=qa` | — | `{q,a,at,model?}`，形状与 v2 `qa[]` 项**逐字段相同**（`a` 非空、`at` 非空、`q` 允许空串、`model` 取不到就不写） |

**`type` 三个取值分别是什么**

- `text`：一条可独立成立的知识（事实 / 判据 / 设计 / 待做）。迁移把 `<li>` 认成这一档。
- `rich`：**条目内部**不可再拆的富内容（表格、代码块、整段引文）。迁移把非 `<li>` 的顶层块认成这一档。
- `qa`：一条 AI 问答（结构化在 `qa` 子对象里；正文由 `src/qa.js` 渲染，见 §5.1）。

> **渲染顺序 = 数组顺序**。条目**没有**权重、没有父子、没有嵌套（要分层就用节点）。

## 2. 节点与条目的关系（真源 / 派生 / 互斥）

```
项目（project）   一个知识域（不变）
 └ 节点（node）   主题 / 容器 / 导航 / 界面上的方框 —— **组织与定位**
    └ 条目（item）**知识的最小单位**：一条事实 / 一个判据 / 一条设计 / 一条待做
```

**判定规则（三档，封闭；`validate` 按这一节判）**

| 节点状态 | 真源 | 必须满足 | 判红 |
|---------|------|---------|------|
| 有 `items`（**含空数组**） | `items` | `detail` **逐字节等于** `renderDetail(items)`；不得有 `detailMode`；不得有 `qa[]` | detail 不一致 / 出现 `detailMode` / 出现 `qa[]` |
| 无 `items` 且有 `detailMode:'rich'` | `detail` | 富文本节点，**不得**出现 `items` | 出现 `items` |
| 无 `items` 且无 `detailMode` | `detail` | v2 节点，语义与 v2 **完全一致** | — |

- **互斥的判据就是这张表**：有 `items` ⇒ 条目化（`detail` 是**落盘派生缓存**，由门禁保证一致）；
  `detailMode:'rich'` ⇒ 富文本（`detail` 是真源、无 items）。**同时出现即判红**。
- `detailMode` 的**唯一合法取值是 `'rich'`**（别的值判红）。它由**显式**动作写入
  （`edit --detail-mode rich`），**不由迁移自动推断** —— 迁移只做两件事：能无损回放的写 `items`，
  其余**一个字节都不动**（不写标记、不删字段），并把跳过项逐条写进报告。
- **混合是合法的**：同一个项目里允许有的节点条目化、有的没有（这是"迁移可分批、可回退"的前提）。
- `renderDetail([])` **必须返回空串**；校验时"缺 `detail`"与"空串"**等价**（否则删空条目的节点过不了闸门）。
- 条目化节点的 `detail` **不参与**并发指纹（它是派生值，见 §8）—— 这是"两个会话各改不同条目"能自动合并的前提。

### 2.1 前导 / 前言的**合法落点**（导入类命令的唯一规则，W12 直接照这条做）

任何"把一整篇文档塞进某个**已有**节点"的入口（`import-md`，以及将来的 Obsidian 直进）
都要面对同一个问题：**第一个标题之前**的那段正文（前导正文 / 前言）往哪儿放。规则只有一条，
它由"目标节点有没有 `items`"决定（这正是 §2 那张三档表的直接推论）：

| 目标节点 | 真源 | 前导正文的合法落点 | 判红的情形 |
|---------|------|-----------------|-----------|
| **没有** `items` 键 | `detail` | **前置**进 `detail`：`前导 + '\n' + 原 detail`（原有内容在其后，一个字节都不覆盖） | —（v2 语义，与从前逐字节相同） |
| **有** `items`（含空数组） | `items` | 新增一条 `{id, type:'rich', html: 前导}` 插到 **`items[0]`**，然后把 `detail` 用 `renderDetail(items)` **整块重建** | 把前导**字符串拼进 `detail`** ⇒ `detail ≠ renderDetail(items)` ⇒ 写前校验判红、**整个导入失败** |

三条落地纪律（违反任何一条都会写出一份门禁判红的数据，或悄悄丢内容）：

1. **绝不手拼 `detail`**。有 `items` 时它只是派生缓存（§2），拼进去就是"证明的是这个、落盘的是那个"。
   需要前导与原有内容之间那个换行时，按 §5.1 的拼装表把它挂在**后一条**条目的 `_gap` 上
   （`_gap` 的语义是"这一条**之前**的空白"；`validateItems` 放行 `_` 起头的内部键）。
   这样落点与"非条目化"那条路**逐字节等价**：两条路都得到 `前导 + '\n' + 原内容`。
2. **id 与重渲染都复用既有实现**：`cli/commands/item.js` 导出的 `mintItemId()`（在全**项目**里查重，
   不许靠概率）与 `rerender()`（`detail` 的重建只有这一份实现）。别在导入命令里各写一份。
3. **父节点已经是坏数据时响亮拒绝、给出路**：若它的 `detail` 与 `renderDetail(items)` 已经不一致，
   这次导入就**只能**靠重建 `detail` 收场 —— 那会把缓存里**多出来的内容**抹掉。拒绝（`exit 1`）并
   点名"父节点已**条目化**"，给出真出路：换一个没有 `items` 的父节点 / 先 `item-add` 把前导自己
   加成条目再导 / 先 `render-detail` 修好父节点（并说清代价）。**盘上零改动**。
   ⚠️ 不许把"删掉刚导入的内容"当出路（`render-detail` 在**失败之后**跑正是这个效果 —— 那是旧报文的误导）。

#### 预览与真跑必须**同一份判据**

导入类命令的 `--dry-run` 与真跑必须**同判**（`import-dir` 的 registry 描述里那句"预览与真导必须
同一份判据"，推广到全部写命令）：

- **真跑必失败 ⇒ 预览必须也失败**，报文逐字相同，且**不许先报一份计划再失败**；
- **预览说能成 ⇒ 真跑必能成**。

实现上只有一条：dry-run 在短路之前也调**写盘前的那一个校验函数**（`cli/core.js` 的
`validateBeforeWrite` —— 它同时是 `store.write` 的闸门，两处**同一个函数** ⇒ 不可能分叉）。

**覆盖范围如实登记**（别当全仓已覆盖）：走 `ctx.write` / `ctx.mutate` 两条写路径的命令都在内；
**自带预览、不走这两条路**的 `import-project` / `import-dir` / `migrate items` / `apply` 仍不在内
（`ask` 的 dry-run 不写盘，不存在这条性质）。扩到那四条时要让它们的预览**复用同一个校验入口**，
而不是各拼一份"我觉得会成"的清单。

## 3. CLI 签名表

**通用约定（所有命令）**

- 成功 ⇒ 退出码 `0`；失败 ⇒ 退出码 `1`，且 stdout 以 `error: ` 开头。**本工程只有一个失败码**，
  不分立错误码编号；调用方要分辨原因就读报文（报文**必须点名对象**）。
- `--json` ⇒ stdout 是**一份**可解析 JSON（幂等回放时也如此，末尾不追加文本行）。
- 写命令：全部走 `ctx.mutate`（原子写 + 写后回读 + 并发重放）；**`fn` 内不做 I/O**；
  写成功后回显**必须点名 `itemId`**。写命令**自动获得** `--idem`（见 §5.2）。
- 读命令的 `--brief` / `--skeleton` / `--compact` 语义与 v2 一致，本文不改它们。

### 3.1 条目视图（`get --item` / `read --items` 的元素）

```jsonc
{
  "nodeId": "1c", "nodeTopic": "①c 关键判据", "path": ["root", "bl-root", "1c"],
  "itemId": "i-3f2k9a", "type": "text",
  "html": "<p>…</p>",                     // 保真：原样带出，便于原地改写
  "src": ["CHANGELOG.md:713-717"],
  "tags": ["门禁"],
  "at": "2026-10-11T04:00:00.000Z",
  "by": "cli:item-add",
  "verified": { "at": "…", "by": "…", "how": "…" },
  "supersededBy": "i-xxxx",
  "qa": { "q": "…", "a": "…", "at": "…", "model": "…" }
}
```

空值**不产生噪音键**（照 `get` 的既有策略）：`src`/`tags`/`at`/`by`/`verified`/`supersededBy`/`qa`
缺省即不出现。`path` 与 `get` 同口径（节点层级 id 数组）。

### 3.2 写命令

| 命令 | 参数 | 回显 / `--json` | 必错情形（退出码 1，报文要点名） |
|------|------|----------------|--------------------------------|
| `item-add` | `<项目> <节点id>` **`--md <Markdown>`** 或 **`--html <HTML>`**（互斥、必给其一） `[--src …] [--tags a,b] [--type text\|rich] [--after <itemId> \| --before <itemId>]` | 文本：`已添加条目 <itemId>（节点 <id>，共 <N> 条）`；JSON：`{ok:true, project, nodeId, itemId, items:<条数>, rev}` | 节点不存在；两个正文选项都给/都没给；`--after/--before` 的条目不在该节点；`--type qa`（指路 `ask-apply`）；节点是 `detailMode:'rich'`（指路 `edit --clear-detail-mode`） |
| `item-edit` | `<项目> <节点id> <itemId>` `[--md … \| --html …] [--src … \| --clear-src] [--tags a,b \| --clear-tags] [--type text\|rich] [--verified --how "…" \| --clear-verified]` | 文本：`已更新条目 <itemId>（节点 <id>）` + **真的变了的字段名**；JSON：`{ok:true, project, nodeId, itemId, changed:["html","tags"], items:<条数>, rev}` | itemId 不在该节点（指名它实际属于哪个节点）；`--verified` 没给 `--how`（"取不到就不写"口径）；`--type qa` |
| `item-remove` | `<项目> <节点id> <itemId> [--clean-links] [--clean-assoc]` | 文本：`已删除条目 <itemId>（节点 <id>，剩 <N> 条）`（带 `--clean-*` 时**先**分行打印 `已同步清理链接：…` / `已同步清理关联：…`）；JSON：`{ok:true, project, nodeId, itemId, items:<条数>}` —— 带 `--clean-*` 且**真清理了东西**时多一个 `cleaned:{links:[{node,target,caption?,item?}], assoc:{touched:[{id,removed}],dropped:[id]}}`（没清理则不出现这个键）；⚠️ `--json` 下 stdout **只有这一份 JSON**（清理行只走文本形态） | 被 `links[].item` 或 `assoc.members[].item` 引用时**默认拒绝**并逐个点名引用者，给两条出口：`--clean-links` / `--clean-assoc`，或事后的 `links-prune` / `assoc-prune`。**不许静默删出悬挂引用** |
| `item-move` | `<项目> <节点id> <itemId> --to <目标节点id> [--after <itemId> \| --before <itemId>]` | 文本：`已移动条目 <itemId>：<源节点id> → <目标节点id>` | 目标节点不存在；目标节点**未条目化**（指路：先 `item-add` 或 `migrate items`）；源 = 目标（指路 `item-order`）。**一次原子写同时重渲染两侧 detail**（一条日志、一个 rev） |
| `item-order` | `<项目> <节点id> --ids i-a,i-b,…` | 文本：`已重排 <N> 条（节点 <id>）` | `--ids` 不是该节点现有条目的**一个完整排列**时拒绝，并逐项点名"少了谁 / 多了谁 / 重复了谁"。**不得用来增删条目** |
| `render-detail` | `<项目> [<节点id> \| --all]` | 文本：`已重建 detail：扫描 <N>，重建 <M>，实际变化 <K>`；JSON：`{ok:true, project, scanned, rebuilt, changed}` | 节点不存在；`<节点id>` 与 `--all` 同给。**幂等**：已一致 ⇒ `changed:0` 并明说"无需重建"。**它是 G2 判红时唯一的修法，G2 报文里必须给出这条命令** |
| `migrate items` | `<项目> [--dry-run] [--json]` | 见 §6 | 见 §6 |

> **`item-add` 的 `--md` / `--html` 是 F0 冻结的**：`--md` 走 `markdownToHtml` 会把**裸 HTML 标签转义**
> （见 `docs/DATA-FORMAT.md` §2.4），而 `type:'rich'` 的条目内**就是**表格/代码块 ⇒ 只有 `--md`
> 无法把迁移产物写回去。两个选项都保留，与 `add`/`edit` 的 `--detail`/`--detail-md` 先例一致。

### 3.3 读命令

| 命令 | 参数 | 返回 | 必错情形 |
|------|------|------|---------|
| `get` | `<项目> <节点id> [--item <itemId>] [--json] [--detail] [--images]` | `--item` ⇒ 条目视图（§3.1）。不给 `--item` ⇒ 行为同 v2，**并且**条目化节点额外带 `items` **摘要数组**（`{itemId, type, src, verified:<bool>, at, bytes}`，**不含正文**） | itemId 不属于该节点 ⇒ 指名它实际属于哪个节点 |
| `read` | `<项目> [--items <i-a,i-b,…>] [--json]` | `--items` ⇒ `{meta, project, itemCount, items:[条目视图…]}`（正文只取这几条） | 任何 id 不存在 ⇒ **整体失败**并逐个点名（不给半份：调用方会把"缺失"当"空"）；`--items` 与 `--brief`/`--skeleton`/`--subtree` 同给 ⇒ 拒绝（两种口径不混） |
| `search` | `<项目> <关键词…> [--json] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text\|rich\|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>]` | 见 §3.4 | `--limit`/`--max-bytes` 非法值 ⇒ 当场报错并给出允许范围（不静默退化成默认值） |

**`read` 的兼容承诺（可断言）**：迁移前后 `read --json`（全档）逐字节不变，
**唯一允许的差异是 `meta.formatVersion`（2 → 3）**。所以 `read` 的节点视图**不加 `items`**：
条目正文的取回走 `get --item` / `read --items`，整块读走 `detail`（它逐字节没变）。

### 3.4 `search` 的条目级命中形状与预算

**默认口径**：`search <项目> <关键词…>` 搜**条目**（节点 topic ∪ 条目正文）；`--topic-only` 退回 v2
（只搜标题）。`--full` 在默认口径之上再并上 v2 的额外面（图片 caption / 节点级标签 / 链接说明）。

**命中形状（统一一套；在 v2 形状之上只增字段）**

```jsonc
{
  "id": "1c", "topic": "①c 关键判据",        // v2 兼容别名
  "nodeId": "1c", "nodeTopic": "①c 关键判据",
  "itemId": "i-3f2k9a", "type": "text",      // 未条目化节点：itemId=null, type=null, itemized=false
  "itemized": true,
  "matchIn": "item",                          // 取值表（**封闭**，见本节的表）：topic / item /
                                              // item-tag / node-tag / caption / tag / link / detail /
                                              // near / expand
  "snippet": "…闸门…",                         // 长度上界只有一处实现（src/item-index.js 的常量）
  "src": ["CHANGELOG.md:713-717"],
  "verified": false,
  "score": 3
}
```

**`matchIn` 是封闭取值表**（键数**不是**它管的 —— 命中形状**固定 12 键**，取值表管的是这 12 键里
`matchIn` 那一格能取什么值）。这张表**开过两次口子**，每次都是"多一种**非字面**命中"，键数一次没动：

- `W4b`：**8 → 9**，新增 `near` —— **显式**给了 `--recall graph` 时，由图距离那一路按 `links` /
  `assoc.members` 的**跳数**接回来的近邻（跳数上界 = 那一行的 `bound`）。
- `W3-do`：**9 → 10**，新增 `expand` —— **显式**给了 `--recall expand` 时，由**候选生成**那一路
  按"查询与节点**标题**的最长公共片段"接回来的候选（门槛 = 那一行的 `minShared`，单位是**字**）。

| `matchIn` 取值 | 含义 | 什么时候出现 |
|----------------|------|--------------|
| `topic` / `item` / `item-tag` / `node-tag` / `caption` / `tag` / `link` / `detail` | 关键词落在**哪一个命中面**上（标题 / 条目正文 / 条目标签 / 节点标签 / 图片说明 / 节点标签（v2 口径）/ 链接说明 / 正文（v2 兼容值）） | 一直是这一套 |
| **`near`** | **不是字面命中**：关键词在这条命中的任何命中面上都**不存在**；它是由扩召回那一路按**跳数**接回来的近邻 | 只在显式给了 `--recall <路由>` 时（见参数表）；其余任何调用都**不会**出现 |
| **`expand`** | **不是字面命中**：关键词的**任何一段**在标题里出现（最长公共片段 ≥ `minShared` 字），但整条查询不是标题的非连续子序列；它是由**候选生成**那一路接回来的候选。⚠️ **它是词法片段，不是向量/语义**（这一路没有模型、没有词表） | 只在显式给了 `--recall expand` 时；其余任何调用都**不会**出现 |

`near` 那类命中形状上的三条（与其它取值同一套键，**没有**新键）：`itemId`/`type` 一律 `null`
（它没有"命中在哪一段正文"这回事）、`snippet` 不出现（没有命中面原文 ⇒ 按既有口径不产生噪音键）、
`score` 回落 `1`（与模糊命中同一个回落口径 —— `score` 本来就不是排序键）。
`expand` 同样三条、同样没有新键；差别只在**名次**：`near` 的候选照旧进 `graph` / `trust` / `time`
三路（`W4b` 的既有口径，黄金集钉着它），而 `expand` 的候选**只由 `expand` 那一路给名次** ——
理由是**证据来源不同**：一条只靠 2 字片段进来的候选，若同时拿到"已核 / 时间新 / 是头名邻居"三份
**与本次查询无关**的贡献，凑起来就可能压过真命中；把它排除在另外三路之外，让那一类结果**结构上不可能**
（本批评价集实测：这条规则排除前后 T1 名次**逐条相同** —— 它不是用来修某个已发生的坏读数）。

| 参数 | 语义 |
|------|------|
| `--tag <t>` | 命中 = 条目级 `tags` 含 t **或** 该节点级 `tags` 含 t（`matchIn` 分别给 `item-tag` / `node-tag`） |
| `--src <s>` | 只命中 `src`（字符串或数组任一项）含子串 s 的条目 |
| `--verified` | 只要**已核**条目（未核 = 没有 `verified`） |
| `--type <t>` | 只要该 `type` 的条目 |
| `--since <ISO>` | 只要 `at >= ISO` 的条目。**给了它就不返回未条目化的节点命中**（节点没有写入时间） |
| `--recall <路由>` | **扩召回**（W4b）：让那一路把**非字面命中**也接进结果（`matchIn` = 该路声明的取值，见上表）。**默认关**：不给它时候选集、`hitCount`、`matchIn` 取值集合与从前**逐字节相同**；给了它 `hitCount` 与 `hits` **会变多**（这是它的用途，不是缺陷）。只有 `ROUTES` 里标了 `recall` 的那几路能被点名（当前 **`graph` + `expand`**；候选来源由那一行的 `recallSource` 声明，`graph` 从**头名**出发、`expand` **不需要头名**），门槛就是那一行声明的量（`graph` = `bound` 跳数；`expand` = `minShared` 字）；**必须与 `--mode`/`--weights` 同给**（它改的是候选集，"怎么排"是融合那一层的事）。硬过滤仍正交：`--tag` 照旧 AND，给了条目级过滤（`--src`/`--verified`/`--type`/`--since`）⇒ 扩召回不参与 |
| `--limit <n>` | 命中条数上界；`--max-bytes <n>` 单次返回**字节**上界。两者缺省值都有界（常量只在 `src/item-index.js`，本文不抄数值） |
| `--max-bytes` 超限 | 截断 + 顶层 `truncated:true` + 给**续取方式**（收窄关键词 / 加 `--since` / 下调 `--limit`）。**不许**静默少给 |

`--json` 顶层：`{project, keyword, hits:[…], hitCount, truncated, mode:'items'|'topic-only',
budget:{bytes, estTokens, limit, maxBytes}}`（预算报告口径只有一处实现）。

## 4. MCP 面

新增六个工具（**每个都是某条 CLI 命令的透传，不复制逻辑**）：
`item_add` / `item_edit` / `item_remove` / `item_move` / `item_order` / `render_detail`。
已有两个工具扩参：`get_node` 加 `item`；`search_nodes` 加 `item_level`（对应 `--topic-only` 的反面）/
`tag`/`src`/`verified`/`type`/`since`/`limit`/`max_bytes`/`no_heat`（`no_heat` 对应 CLI 的 `--no-heat`：**热度日志损坏时的逃生门**，排序回到零热度档；不给它时默认档照旧**响亮失败**），
以及混合检索的 `mode` / `weights` / `explain`（W4）与**扩召回的 `recall`**（W4b，对应 `--recall`）。
这些都只是**一层透传**：取值合法性、权重/路由表、上界、新取值名全由 CLI 那一处解析决定，
**工具数不变**（本文件不写总数：总数见 `docs/VERIFY.md`，生成物）。

- 参数名一律 snake_case，语义与 CLI **一一对应**；不新增 MCP 侧默认值。
- 工具总数与稳定性分级**不写在本文件**：总数见 `docs/VERIFY.md`（生成物），分级表见 `docs/EXTENSIONS.md` §1.2/§1.3 —— 两者都由 I 同批更新（新命令不进分级表会被 G8 判红）。

## 5. 内部模块签名（冻结，别的流按它编码）

### 5.1 `src/item-model.js`（新建，S1 实现）

纯函数、**无 I/O、不读时钟、不读盘**、UMD（Node + 浏览器双端，照 `src/` 既有约定）。

| 签名 | 语义 | 硬约束 |
|------|------|--------|
| `parseDetail(html, opts?) -> items` | 把一段 detail HTML 按**顶层块**切成条目（保序）：`<li>` 元素 ⇒ `type:'text'`，其余顶层块 ⇒ `type:'rich'`。`opts = {at?, by?, src?}` 给了就写进每一条 | 每条带由 `newItemId()` 生成的 `id`；**不写** `verified`；产物必须能过 `validateItems` |
| `renderDetail(items) -> html` | 唯一的渲染实现（数组顺序 = 渲染顺序） | **幂等**（同 items 两次逐字节相同）；`renderDetail([]) === ''`；`type:'qa'` 的那一段必须调 `src/qa.js` 的 `appendHtml(item.qa)` 渲染（**不许复制**那段逻辑）；**往返契约**：`renderDetail(parseDetail(detail)) === detail` 逐字节成立 —— 这是迁移的准入门槛 |
| `validateItems(items) -> errors` | 校验**单个节点**的 items 数组 | 返回**字符串数组**（空数组 = 合法），报错逐条点名（序号或 id + 字段 + 期望/实际）；纯函数；**不判全项目唯一性**（见下） |
| `newItemId() -> string` | 生成候选 id：`i-` + 时间戳 base36 + 随机后缀（同 `src/markdown.js` 的 `idGen` / `assoc` 的先例） | 只**生成候选**；唯一性由调用方在**全项目** id 集合里查重，撞了重生成（不许"靠概率"） |

**id 唯一性的分工（易漏，写清楚）**：`validateItems(items)` 只能看到**一个节点**的数组 ⇒ 它判
"节点内唯一"；**全项目唯一**由 `src/schema.js` 在遍历整棵树时用一张 Set 判（S1 实现），
因为 `supersededBy` / `links[].item` 只带条目 id、不带节点 id —— 只有全项目唯一，引用才无歧义。

### 5.2 `cli/core.js`：写命令统一获得 `--idem`

> **本节以**（S7 已落地的）**`cli/core.js` 实现为准冻结**，机制全部在 core，命令体零改动。
> ⚠️ **与 F0 派发词的差异（如实标注）**：派发词写的是"命令只需在自己的 options/usage 里声明"；
> 落地形态是**横切开关**：`--idem` 放进 `GLOBAL_OPTIONS` ⇒ **任何命令都放行**，
> 不需要逐条声明，也**不要**写进各命令的 usage（`tests/cli-options.test.js` 会要求 usage 与
> `options` 一一对上，逐条声明反而会逼着改一串用法串）。冻结如下：

| 冻结项 | 内容 |
|--------|------|
| 选项 | `--idem <键>`；`--idem=k` 与 `--idem k` 等价。**全局横切**（`cli/core.js` 的 `GLOBAL_OPTIONS`），命令无需声明 |
| 键的合法值 | 非空字符串，trim 后 ≤ `IDEM_MAX`。裸写 `--idem`（`true`）或空串**响亮拒绝** —— 空键会让所有调用互相命中，比没有幂等更危险 |
| 哪些命令接受 | `cli/core.js` 的 `WRITE_COMMANDS`（**手写清单，新增写命令必须同批加自己的命令名**）。只读命令带 `--idem` ⇒ 报错（不许默默忽略） |
| 作用域 | **项目**：键查的是 `projects/<项目>/.changes.jsonl`；同键在不同项目互不影响。**不得跨命令复用**：命中记录里的命令名与本次不符 ⇒ 报错并点名首次是哪个命令、哪条 rev |
| 命中行为 | **不执行命令体、不写盘**（守卫在 `ctx.write` / `ctx.mutate` 里抛 `IdemReplay`，由 `cli/main.js` 的 `replayIdem` 接住）⇒ 回放**首次结果**；文本回显含「**幂等命中**」；`--json` 带 `{command, idem, hit:true, rev, version, result}`；**退出码 0**（重放不是失败：判据是 `hit`，不是退出码） |
| 未命中 | 照常执行；首次写成功时把 `idem` + 首次回显 `out` 写进 `.changes.jsonl` 条目的**可选字段**（`ENTRY_VERSION` 不升、不进项目文件、不进 `export-json`）；`out` 有字符上限（常量在 `src/changes.js`） |
| 失败 | 命令抛错 ⇒ **不记键**（失败的那次没生效，"跳过"才是错的）。重试会照常执行 |
| `--dry-run` | **不查也不记**（不写盘 ⇒ 不算生效） |
| 寿命（如实登记的边界） | 键只活在 `.changes.jsonl` 的**有界窗口**里（`src/changes.js` 的 `MAX_ENTRIES`）；滑出窗口后同键重放会**再执行一次**，删掉日志文件即"忘了"。**别把 `--idem` 当事务或锁用** |
| 不在面内 | 幂等面只覆盖**项目数据**的写入；界面控制类、网络/外部进程类不在面内 |

**F0 追加的接口纪律（命令体唯一的例外点）**：命令体若在写盘**之前**做**物理副作用**
（复制/删除文件、起进程），**必须显式先调一次 `ctx.replayCheck()`** —— 否则重放会先把副作用
做掉、再命中幂等 ⇒ 留下孤儿产物，而回显却说"盘上数据未改动"。
⇒ 已核出的现存违反：`cli/commands/assets.js` 的 `addImage` / `addFile`（`copyFileSync` 在
`ctx.mutate` 之前，目标名 = 时间戳 + 随机 ⇒ 重放会在 `assets/` / `attachments/` 里多一份**不覆盖**的
孤儿文件）。归属：S7（它拥有 `cli/core.js`；`cli/commands/assets.js` 不在任何流的所有权列里 ⇒ 由 I 指派）。

## 6. 迁移规则（v2 → v3）

**命令**：`migrate items <项目> [--dry-run] [--json]`

> ⚠️ **子命令形式的位置参数陷阱（已实测）**：`migrate items <项目>` 里第一个位置参数是 `items`，
> 而 `cli/core.js` 的 `ctx.projectName = args._[0]` ⇒ 它会等于 `"items"`。命令体**必须**用
> `ctx.args._[1]` 取项目名，并自己 `store.read` / 传名字给写盘口；直接用 `ctx.read()` / `ctx.mutate()`
> 会报"项目不存在: items"。

| 规则 | 内容 |
|------|------|
| 幂等 | 只处理"无 `items` 且 detail 含 `<li>` 且能无损回放"的节点；跑第二次时没有候选 ⇒ 回显"无需迁移"，`changed:{nodes:0, items:0}`，**文件逐字节不变** |
| 不改内容 | 仅当 `renderDetail(parseDetail(detail)) === detail` **逐字节**成立才写 `items`；不成立 ⇒ **整个节点跳过**，一个字节都不动，并把 `{nodeId, reason}` 逐条写进报告。**不许**"修一下再写"（内容悄悄变质是本工程最重的损害类） |
| 跳过项 | 报告必须逐条点名（节点 id + 原因）；`--json` 的 `skipped` 数组与文本回显是**同一份**数据 |
| `qa[]` 收敛 | `qa[]` 的每一项映射成一条 `type:'qa'` 条目（`{q,a,at,model?}` 原样进 `item.qa`），**保序追加**在解析出的条目之后；随后**删掉节点的 `qa` 键**（不留只读副本：两处表达必漂移）。读兼容由视图层派生（§7） |
| `detailMode` | 迁移**不写**它（见 §2）；跳过项里"内容不可分"的节点由人/AI 用 `edit --detail-mode rich` 显式标记 |
| 版本号 | 迁移把 `meta.formatVersion` 写成 `3`；**`validate` 同时接受 2 与 3**（见 §9 的第一条：这是回退能成立的硬前提） |
| 备份（迁移前） | 写盘之前**自动** `export-json` 一份到 `.review/<YYYYMMDD>-条目层迁移/<项目>.aimap.json`，并打印**绝对路径**；同时打印"工程外备份"的推荐命令（工程内备份**不是**磁盘级事故的兜底，见 `docs/INCIDENTS.md`）。**不提供跳过备份的开关** |
| 可回退 | 回退 = 恢复那份备份（`.aimap.json` 里 `formatVersion` 是 2）⇒ 恢复后**所有写命令必须照常可用**。这是"必须同时接受 2 与 3"的硬理由 |
| 报告 | 文本与 `--json` 同一份：`{ok, project, scanned, itemized, skipped:[…], items:<新增条数>, changed:{nodes, items}, backup}`；`--dry-run` 只出报告（不写盘、不备份） |
| 门禁 | 迁移完成后必须跑 `node cli/mm-cli.js validate-all`（G2）+ 该项目的 `health`（S4）；迁移是"改代码"轨道的活，但**各流不跑全链**（见 §9） |

## 7. 与既有字段的边界（终态）

| 字段 | 终态定位 | 冻结点 |
|------|---------|--------|
| `items[]` | **文本型知识条目的唯一真源** | 有它即条目化（§2） |
| `qa[]` | **退役** | 条目化节点**禁止**出现；未条目化节点照旧可用（v2 读兼容）。写新问答走 `type:'qa'` 条目（出口 `ask-apply`，见 §11） |
| `get` / `read` 的 `qa` 字段 | **视图派生** | 条目化节点上由 items 里 `type:'qa'` 的 `qa` 子对象**按条目序**派生（形状、字段顺序与 v2 一致）⇒ 老消费者照常可用，且 `read --json` 迁移前后逐字节不变（§3.3） |
| `images[]` / `files[]` | 保留（媒体，不是文本） | 新增**可选** `id`（前缀 `m-`，形状同条目 id，**节点内唯一**）；缺失 = 老数据未编号（合法，不迁移）；**新写入**（`add-image` / `add-file`）一律带 id。⚠️ 生成与写入点在 `cli/commands/assets.js`，该文件**不在任何流的所有权列里**（见 §11） |
| `links[]` | 保留，target 扩容 | 每项 = `{project, id, item?, caption?}`；`item` 指目标节点的条目 id。**悬挂检测必须覆盖条目级**：目标节点在但条目不在 ⇒ 报错并点名 `project/id/item`。不带 `item` 的老链接语义**完全不变**。**同一性 = `(project, id, item)` 三元组**（`item` 缺省即*节点级边*）⇒ 同 (源节点, 目标节点) 下**节点级边与条目级边可以并存**，`--item` 是二者唯一的区分；省略 `--item` 只指向/新建**节点级那条边**，`--item <id>` 只指向/新建**那一条条目级边**（`unlink` 仍按目标移除全部，含条目级） |
| `assoc.members[]` | 保留，扩容 | 同样允许 `item?`；悬挂成员检测同链接（同一处逻辑） |
| 标签（两级） | 节点级 `tags` 保留不变；新增条目级 `item.tags` | 检索跨两级（§3.4）；**不把条目标签合并进节点 `tags`**，也不反向复制 |
| `origin` / `localPath` / `background` / `meta.*` | 不受条目层影响 | 照旧，本文一个字都不改它们 |

## 8. 并发粒度（**必须冻结**，否则 S2/S3 做完要回头改地基）

**冻结结论：条目升为独立指纹键，同批扩 `src/concurrency.js`，`src/changes.js` 只改说明不改代码。**

| 键 | 含义 | 与现状的关系 |
|----|------|-------------|
| `node:<id>` | 节点**自身字段**，但**排除** `children`、`items`，以及（仅当节点有 `items` 时）`detail` | `children` 的排除照旧；新增两条排除。理由：`items` 由 `items:` / `item:` 键承载；`detail` 在条目化节点上是**被门禁保证的派生值** ⇒ 把它算进指纹会让"同一节点的不同条目"永远相撞，而"多会话同时补条目"正是最常见的形态 |
| `items:<id>` | 该节点**条目 id 的有序列表** | 与 `children:<父id>` 同形：顺序算改动，增删条目也在这里可见 |
| `item:<节点id>#<条目id>` | **单个条目**（按 id，不看数组顺序） | 与 `assoc:<id>` 同形。**节点 id 必须进键**：条目移动（`item-move`）是"键改名 + 旧键消失"，只用条目 id 会让移动**完全不可见**（条目自身内容没变） |

**同批要动的实现**（都在 `src/concurrency.js`，S1 实现；`src/changes.js` 不用改）：

1. `fingerprint` / `changedKeys`：按上表出键（纯函数，唯一来源）。
2. `flattenProject`：摊平出"按节点取条目表（id → 条目）"，供三方合并逐条挑来源。
3. `mergeTrees`：**逐条目挑来源**（照 `assoc` 的先例）；`items` 的顺序按 `items:<id>` 的选择；
   节点是条目化的 ⇒ **丢弃两侧的 `detail`，合并后用 `renderDetail(items)` 当场重建**（否则写盘的
   detail 与 items 不一致，G2 立刻判红；而 `detail` 是被排除的派生字段，任何一方都不该"赢")。
4. `describeKeys`：加 `items:` / `item:` 两个分支（翻成"节点「X」的条目顺序" / "节点「X」的条目「…」"）。
   **不加会让冲突报错打印裸键**，违反"报错要指名对象"。
5. `src/changes.js` 的 `groupByObject`：**已核实无需改**（它按 `changed[]` 的键泛化归并，新键自动生效）。

**安全论证（别弱化）**：`items`/`detail` 的排除成立，是因为"有 `items` ⇒ `detail == renderDetail(items)`"
是**门禁保证的不变量**（§2/§9）。若某天把那条门禁去掉，这些排除就变成静默丢数据的通道。

**所有权（本条的落地条件）**：`src/concurrency.js` 与 `src/changes.js` 在并行计划的所有权表里
**不属于任何流**（孤儿文件）⇒ **并入 S1**，并把这两个文件加进 S1 的所有权列；断言加在
`tests/item-model.test.js`（或 S1 自建的 `tests/concurrency-items.test.js`，需 I 同批登记所有权）。

**判据（可执行）**：两个会话分别改**同一节点的不同条目** ⇒ 自动合并、两侧改动都在；
改**同一条** ⇒ 指名拒绝，报文里出现那条的可读名。

## 9. 门禁与断言（谁跑什么）

| 门禁 | 要扩的点 | 谁实现 / 谁证明 |
|------|---------|----------------|
| **G2** `validate` / `validate-all` | ① `meta.formatVersion` ∈ {2,3}；② §2 真源互斥表；③ `items` 形状（`validateItems`）+ **全项目 id 唯一**；④ `detail` 逐字节 == `renderDetail(items)`（**判红必须给修法**：跑 `render-detail`）；⑤ 链接/关联的**条目级悬挂** | **判定全在 `src/schema.js`（S1 的文件，S6 给口径）**；条目级悬挂的**清理出口**（`links-prune` / `assoc-prune` 的条目分支）归 S6（`cli/commands/links.js` + `src/relations.js`） |
| **判别力证明** | 注入一次不一致（改一个 `items` 元素）⇒ G2 **必红**；再撤销 ⇒ 复绿 | S1（照工程惯例：没红过的不算门禁） |
| **G3 / G4 / G5** | `<li>`↔items 互转与往返、id 稳定性、渲染幂等、`qa` 收敛映射（单测）；`item-*` 端到端 + 条目化节点拒绝 `edit --detail` + 迁移幂等（集成）；详情框照常渲染 + 单条交互（冒烟） | S1 / S2 / S3 / S4 / S6 / S5 各交付**断言原文**给 I |
| **G6** | 条目数字（总数/未核数…）**不手写**：走 `docs/VERIFY.md` + `health --json` 的真值出口 | S4 + I |
| **G8** | 本文档已登记 + 导航可达；S1 往 `SCHEMA_FIELDS` 加 `items`/`detailMode` 时，`docs/DATA-FORMAT.md` 里必须有这两个词（F0 已在指针行里写下，见交付说明） | I |
| **§8 的并发口径** | 见 §8 的"判据" | S1 |

**各流怎么跑（照并行纪律，别自己跑全链）**：只跑 `npx vitest run tests/<自己的>.test.js`（走临时目录，安全）；
**禁止**自己跑 `scripts/cli-integration.js` 与 `npm run smoke`（它们在**真实 `projects/`** 里造数据，会与其它流互踩、
让别人的门禁报假红）；集成与冒烟断言按交付格式交给 I，由 I **串行**落盘并跑全链。
`cli/registry.js` / `scripts/cli-integration.js` / `CHANGELOG.md` / `README.md` / `docs/CLI.md` /
`docs/VERIFY.md` / `package.json` / `docs/EXTENSIONS.md` **一律由 I 改**。

## 10. 验收判据（每条都可执行）

> `<副本>` = 用 `export-json` + `import-json` 造的临时项目副本（**不要在真实项目上试破坏性操作**）。

| # | 判据 | 命令 | 期望 |
|---|------|------|------|
| AC1 | 契约自检绿 | `npm run check:docs` | exit 0（本文档已登记、§5 表已生成、SKILL.md 导航可达） |
| AC2 | 迁移幂等 | `migrate items <副本>` 连跑两次 | 第二次 `--json` 里 `changed.nodes==0 && changed.items==0`，且第二次前后项目文件**哈希不变** |
| AC3 | 迁移后数据合法 | `validate-all` | exit 0（含条目化节点的 detail 一致性） |
| AC4 | 迁移不改内容 | 迁移前后各 `export-md <副本>` | 除 frontmatter/meta 的 `formatVersion` 外，正文逐字节相同（由 AC2 的哈希与断言共同钉住） |
| AC5 | 跳过项点名 | 对含不可回放 detail 的探针节点跑 `migrate items --dry-run` | 该节点出现在 `skipped` 里且带原因；它的 detail 逐字节未变 |
| AC6 | 一致性门禁有判别力 | 手工改一个 `items[].html` 后 `validate <副本>` | **必红**，报文里出现 `render-detail` |
| AC7 | 条目写读闭环 | `item-add <副本> <节点> --html "<p>甲</p>"` → `get <副本> <节点> --json --item <返回的itemId>` | `html` 与写入值逐字节相同；`itemId` 在 `item-edit` / `item-order` / `item-move` 后**不变** |
| AC8 | 条目化节点拒绝整块改 | `edit <副本> <节点> --detail "<p>x</p>"` | exit 1，stdout 以 `error: ` 开头且**指路** `item-*` |
| AC9 | 检索命中到条目 | `search <副本> <词> --json` | 命中项有 `itemId`；`--topic-only` 下同一命中的 `itemId` 为 `null` |
| AC10 | 取回字节有上界 | `search … --max-bytes <很小的值> --json` | `truncated:true` 且实际返回字节 ≤ 上界（单测钉住，不写死数字） |
| AC11 | 并发粒度 | 两会话改同一节点的**不同条目** / 改**同一条** | 前者自动合并（两侧都在）；后者指名拒绝并给出条目可读名 |
| AC12 | 幂等重放 | 同 `--idem <键>` 跑两次 `item-add` | 第二次回显含「幂等命中」、`--json` 带 `hit:true`、**退出码 0**、项目文件逐字节不变、`.changes.jsonl` 只多 1 条 |
| AC13 | 读兼容 | 迁移前后 `read --json`（全档） | 除 `meta.formatVersion` 外逐字节相同 |
| AC14 | 确定性产物 | 同状态连跑两次 `renderDetail` / `health --json` | 逐字节相同（S4 的读数必须确定） |

## 11. 未定 / 未核实（如实登记，别当已完成）

1. **`ask-apply` 的双写收敛没有归属流**：把 `qa[]` 收敛成 `type:'qa'` 条目的写入口是
   `cli/commands/qa.js`（+ `src/qa.js` 的渲染），这两个文件**不在任何一条流的所有权列里**。
   本契约只冻结了两处：`item.qa` 的形状（§1）与"qa 段由 `src/qa.js` 的 `appendHtml` 渲染"（§5.1）。
   **需要 I 指派**（建议并入 S1，它已经在动 schema 与迁移），否则 P2 之后会出现"新问答进不去条目层"。
2. **`images[].id` / `files[].id` 的写入点同样是孤儿**：`cli/commands/assets.js`。形状已冻结（§7），
   实现归属未定；另外 `add-image` / `add-file` 的 `--idem` 孤儿文件问题（§5.2）也在同一个文件里。
3. **`search` 默认口径 vs 稳定性承诺**：`docs/EXTENSIONS.md` §1.2 把 `search` 列在**稳定**级
   （"名称、参数、JSON 字段结构不会在非大版本中变更"），而本契约按设计把默认口径改成"搜条目"。
   本契约的取舍：**保留设计（默认搜条目）+ 只增字段 + `--topic-only` 作反向开关**，
   I 需同批更新 `docs/EXTENSIONS.md` 的措辞（说明默认口径已变、`--topic-only` 是回退路径）。
4. **迁移规模未实测**：哪些节点会被条目化、有多少会被跳过，只有跑过 `migrate items --dry-run` 才知道；
   本契约**不写任何条数**（设计草案里的数字是估算，且属于易腐事实 ⇒ 真值出口是 `health --json`）。
5. **`type:'rich'` 没有长度阈值**：契约按"是不是 `<li>`"判（`<li>` → `text`，其余顶层块 → `rich`），
   不引入"多长算 rich"的阈值。若实测发现某类节点被切得过碎，改的是 `parseDetail` 的切分口径 —— **改它 = 改契约**。
6. **`--idem` 在 `add-image` / `add-file` 上的孤儿文件**：由代码路径逐行读出（未实测，探针未跑），
   见 §5.2。若确认为真，修法是命令体在副作用前显式调 `ctx.replayCheck()`。
7. **`read --brief` 不带 `items` 摘要**是 F0 的取舍（保 `read` 字节不变）。若后续发现"AI 读整个项目时
   看不见条目结构"是真痛点，加 `list --json` 的 `itemCount` 或 `read --items-hint` 之类 —— **走契约变更**。
8. **`edit --detail-mode rich` / `--clear-detail-mode` 与"未条目化节点上 `item-add` 自动条目化"**
   是 F0 新增的两条冻结项（设计草案里没有）：前者落在 `cli/commands/edit.js`（S7 的所有权），
   后者落在 `cli/commands/item.js`（S2）。两者都要在 registry 里落一行（由 I 代改）。

## 12. 给下游各流的一句话提醒

| 流 | 最容易理解错的一点 |
|----|------------------|
| S1 | `renderDetail(parseDetail(detail)) === detail` 是**准入门槛**而不是努力方向：回放不了就**整节点跳过**，不许"修一下再写" |
| S2 | 条目化节点只关掉 `--detail` / `--detail-md` 两扇门；`--topic` / `--tags` / `--expanded` / `--local-path` **照常可用** |
| S3 | 默认口径改了（搜条目），但 `read` 的字节形状**不许变**（`qa` 由 items 现场派生）；`--topic-only` 是回退开关 |
| S4 | `verified` 是"怎么核的"的记录（三字段全必填），不是布尔；`health` 是**读数不是门禁**，且必须确定性 |
| S5 | `detail` 仍是渲染产物 ⇒ 详情框的现有渲染路径**不用改**，本轮只加条目级交互 |
| S6 | `links[].item` / `assoc.members[].item` 的悬挂检测与节点级**同一处逻辑**；`groupByObject` 不用改（§8 已核实） |
| S7 | 新增写命令**必须**把自己的名字加进 `cli/core.js` 的 `WRITE_COMMANDS`，否则 `--idem` 会被响亮拒绝 |
| I | 新命令不进 `docs/EXTENSIONS.md` 分级表、新代码不进 `docs/ARCHITECTURE.md` §2 都会被 G8 判红（并行计划的补丁 1） |
