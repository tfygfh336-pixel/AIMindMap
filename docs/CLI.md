# CLI 参考（AI MindMap）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 契约
作用: 命令参考
不该写: —（**勿手改**）
更新方式: `docs-gen` 生成（G7 校验）
-->

> 本文件由 `node cli/mm-cli.js docs-gen` 从 cli/registry.js 自动生成。
> **新增命令时修改 registry.js 后重跑 docs-gen**，勿手改本文件。

## 通用

- 入口：`node cli/mm-cli.js <command> [args...]`
- `--json`：以 JSON 输出（供 AI / MCP 解析）
- **失败：退出码非 0**（首选判据；脚本/CI 看这个），同时 stdout 输出 `error: <原因>`（文本辅助判据）
- `validate` / `validate-all` 例外：输出结构化报告（`FAIL <项目>: …` 或 `--json` 的 `{ok,errors}`），同样以非 0 退出码表达失败
- 项目名 = `projects/<name>/<name>.json` 的目录名

## 命令一览

| 命令 | 说明 |
|------|------|
| `projects` | projects [--json] |
| `read` | read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--items <条目id,…>] [--images] |
| `list` | list <项目> [--json] |
| `get` | get <项目> <id> [--json] [--item <itemId>] [--detail] [--images] |
| `search` | search <项目> <关键词|--tag 标签> [--json] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] |
| `search-all` | search-all <关键词|--tag 标签> [--scope 项目名,…] [--json] [--compact] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] |
| `stats` | stats <项目> [--json] |
| `init` | init <项目> [--title 标题] |
| `backlinks` | backlinks <项目> <id> [--json] |
| `related` | related <项目> <id> [--json] [--depth N] |
| `ask` | ask <项目> [<节点id>] [--nodes a,b,c] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run] |
| `theme-layout` | theme-layout <项目> [--left a,b] [--right c,d] [--clear] |
| `add` | add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force] |
| `add-root` | add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--force] |
| `edit` | edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false] |
| `move` | move <项目> <id> <新父id> [--index n] |
| `expand-depth` | expand-depth <项目> [--depth N] [--id 子树根id] |
| `remove` | remove <项目> <id> [--clean-assoc] [--clean-links] |
| `clone` | clone <项目> <源id> <新父id> [--deep] [--repoint-items] [--json] |
| `apply` | apply <项目> --ops-file ops.json [--dry-run] |
| `item-add` | item-add <项目> <节点id> --md "Markdown" | --html "HTML" [--src 出处] [--tags a,b] [--type text|rich] [--after itemId | --before itemId] [--force] |
| `item-edit` | item-edit <项目> <节点id> <itemId> [--md "Markdown" | --html "HTML"] [--src 出处 | --clear-src] [--tags a,b | --clear-tags] [--type text|rich] [--verified --how "怎么核的" | --clear-verified] |
| `item-remove` | item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc] |
| `item-move` | item-move <项目> <节点id> <itemId> --to 目标节点id [--after itemId | --before itemId] |
| `item-order` | item-order <项目> <节点id> --ids i-a,i-b,… |
| `render-detail` | render-detail <项目> <节点id> | --all |
| `recheck` | recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json] [--write-verified --how "怎么核的"] [--dry-run] |
| `health` | health [<项目>] [--project 项目名] [--all] [--root 目录] [--json] |
| `migrate` | migrate items <项目> [--dry-run] [--json] |
| `ask-apply` | ask-apply <项目> <id> --answer "回答" [--question "提问"] [--model 模型] [--at ISO时间] [--answer-file 路径] [--as-child] [--child-id id] [--json] |
| `import-md` | import-md <项目> <md文件> [--parent id] [--force] |
| `import-project` | import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json] [--force] |
| `import-dir` | import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] [--max-files N] [--dry-run] [--json] [--force] |
| `export-md` | export-md <项目> <输出目录> [--format heading|list] [--with-detail] |
| `export-json` | export-json <项目> <输出.json> |
| `export-html` | export-html <项目> <输出目录> |
| `import-json` | import-json <aimap.json> [--name 项目名] |
| `add-image` | add-image <项目> <id> --file 图片 --caption 备注 [--source 出处] [--tags a,b] |
| `remove-image` | remove-image <项目> <id> <相对路径 assets/x.png> |
| `assets` | assets <项目> [--json] |
| `add-file` | add-file <项目> <id> --file 附件 --caption 备注 [--source 出处] |
| `remove-file` | remove-file <项目> <id> <相对路径 attachments/x.md> |
| `files` | files <项目> [--json] |
| `sidebar-only` | sidebar-only <on|off> [--json] |
| `dsh-sidebar` | dsh-sidebar <on|off> [--json] |
| `dsh-status` | dsh-status [--json] |
| `dsh-prefill` | dsh-prefill "<文本>" | dsh-prefill --file <路径> [--json] |
| `link` | link <项目> <id> --to 目标项目 --id 目标id [--item 目标条目id] [--caption 说明] |
| `unlink` | unlink <项目> <id> --to 目标项目 --id 目标id |
| `links` | links <项目> [--json] |
| `links-prune` | links-prune <项目> [--nodes a,b] [--items a#i-1,b#i-2] [--dry-run] |
| `orphans` | orphans <项目> [--json] [--content-only] [--limit n] |
| `mentions` | mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n] |
| `assoc-list` | assoc-list <项目> [--node <id>] [--json] [--raw] |
| `assoc-add` | assoc-add <项目> --members a,b,c [--title 标题] [--note html | --note-md markdown] [--id id] [--force] |
| `assoc-edit` | assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c] |
| `assoc-remove` | assoc-remove <项目> <assocId> |
| `assoc-prune` | assoc-prune <项目> [--nodes a,b] [--dry-run] |
| `validate` | validate <项目|json文件> [--json] |
| `validate-all` | validate-all |
| `ui-state` | ui-state [<项目>] [--json] |
| `changes` | changes [<项目>] [--since <rev|版本号>] [--json] [--limit n] |
| `visit` | visit <项目> <节点id> --channel <通道> [--json] |
| `heat` | heat <项目> [--json] [--limit <n>] [--node <id>] [--derived <summary|keys>] |
| `docs-gen` | docs-gen |
| `release` | release [版本号] [--major|--minor|--patch] |
| `changelog` | changelog [--grep 关键词] [--full] [--limit n] [--json] |
| `dsh-caps` | dsh-caps [--json] [--grep 关键词] [--unmounted] |

## 详细用法

### projects

列出 projects/ 下全部项目（含 meta）

```
node cli/mm-cli.js projects [--json]
```

### read

读取项目可读视图（树 + 详情 + 图片清单）。四个变窄开关可叠加：--brief 去长文本 / --skeleton 再去 tags+links（只要结构）/ --subtree <id> 只要某棵子树 / --compact 单行 JSON；实测全叠加比全量省约 86%（`--detail` 不再写进用法但**照旧可用**：--json 下是空操作、文本模式下响亮报错并给出替代路径 —— 老调用方不会因为"它被移除了"而突然失败）。**`--items <条目id,…>` 是条目层（v3）的另一档**：只取这几条的正文，返回 `{meta,project,itemCount,items:[条目视图]}`；任一条目 id 不存在 ⇒ **整体失败并逐个点名**（不给半份），且与 --brief/--skeleton/--subtree 互斥（两种口径不混）

```
node cli/mm-cli.js read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--items <条目id,…>] [--images]
```

### list

树形列出项目全部节点

```
node cli/mm-cli.js list <项目> [--json]
```

### get

查看节点（路径/详情/图片）。`--item <itemId>` 取**单条条目**（条目视图：nodeId/nodeTopic/path/itemId/type/html|qa/src/tags/at/by/verified，空值不产生噪音键）；不给它时行为同 v2，**并且**条目化节点额外带 `items` 摘要数组（`{itemId,type,src,verified,at,bytes}`，不含正文）

```
node cli/mm-cli.js get <项目> <id> [--json] [--item <itemId>] [--detail] [--images]
```

### search

搜索（**默认口径 = 搜条目**：节点 topic ∪ 条目正文；`--topic-only` 回退 v2 只搜标题）。命中形状：`{id,topic,nodeId,nodeTopic,itemId,type,itemized,matchIn,snippet,src,verified,score}`（`id`/`topic` 是 v2 兼容别名；未条目化节点 itemId=null/type=null/itemized=false）。过滤：`--tag`（条目级标签 → item-tag / 节点级 → node-tag；未条目化节点照 v2 报 tag）、`--src`（src 子串，字符串或数组任一项）、`--verified`（只要已核条目）、`--type`（text|rich|qa）、`--since <ISO>`（at >= ISO；不给未条目化的节点命中）；`--full` 在默认口径之上再并上 v2 的额外面（图片 caption / 节点级标签 / 链接说明）。排序：热度（人 / AI 两条，近 30 天窗口）作为**一个封顶向量**并入 —— 只重排、不改变命中与否，占总分 ≤ 8%（取值与理由的唯一一处：src/heat.js 的 SEARCH_RANK）；本机没有该日志时**不参考热度**（≠ 热度为 0，`--json` 的 heat.reason 会说明）。`--no-heat`：**显式**跳过热度日志 —— 本次调用**完全不碰它（不读、不写、不排序）**：日志坏了 / 认不出通道 / 时间乱序时这是**先拿到结果**的出口（往坏日志里再追加一条只会搅得更坏 ⇒ 写入这一半也必须一起关）；⚠ 它不改变默认档：默认遇到坏日志仍然**响亮失败**（不许静默降级成"按 0 排"）。预算：`--limit`（缺省 200，上界 1000）/ `--max-bytes`（缺省 65536，16–4194304）；`--json` 顶层 `{project,keyword,hits,hitCount,truncated,mode,budget:{bytes,estTokens,limit,maxBytes},heat:{applied,reason,weights,windowDays,rankedNodes,hitNodes,log}}`，超限截断并给续取方式（budget.resume）。非法值（含 --verified/--type/--since 写错）**当场报错**，不静默退化成默认值或"0 命中"

```
node cli/mm-cli.js search <项目> <关键词|--tag 标签> [--json] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat]
```

### search-all

**跨项目检索**：一次调用扫**全库**（`projects/` 下全部项目，按**项目名升序**），每条命中带 `project` —— 这是卖点 1 那句"AI 不必每次上网搜"的技术前提（从前 `search` 必须点名**单个**项目）。`--scope 项目甲,项目乙` 把范围收回来（名单里的项目不存在 ⇒ **报错并逐个点名**；`--scope` 裸写/空名单 ⇒ 报错，不静默当"全库"）；其余选项与 `search` **同一个语义**（同一条 `searchItems` 实现）：`--tag` / `--full` / `--topic-only` / `--src` / `--verified` / `--type` / `--since` / `--limit` / `--max-bytes`。顺序 = **项目名升序 × 项目内既有顺序**（项目内与 `search <该项目>` 逐条同序，含它自己的热度榜）；**不做跨项目重排**（排序的唯一实现是 `src/item-index.js` 的 `orderByHeat` —— 跨项目比分数会是第二份排序实现，且 nodeId 只在项目内唯一）。热度**逐项目各算各的榜**（人 / AI 两条，窗口 30 天，封顶见 `src/heat.js` 的 SEARCH_RANK）；`--no-heat` = `search` 的同名开关（本次完全不碰任何项目的热度日志）。两条**硬上限**（调用方改不了，越限 ⇒ **响亮报错 + 一条命中都不返回**，与"截断"是两件事）：命中总数 2000 条、扫描耗时 3000 ms（取值与报文都在 `src/item-index.js` 的 `scanGate`）。`--limit` / `--max-bytes` 是**调用方预算**：截断时如实写 `truncated` 并给续取方式。**不许静默少扫**：某个项目的**数据读不出来** ⇒ 跳过它，但在 `skipped` 里逐个点名（文本档一行 `⚠ 跳过项目「…」`，汇总行写"⚠ 另有 N 个项目没扫成"）；它的**热度日志坏了** ⇒ 整体失败并点名那个项目（与 `search` 同一条纪律，出路 `--no-heat`）。无命中时**明确报"0 条"**（不是空输出）。`--json` 顶层 `{keyword,tag,scoped,scope,scanned,skipped,hits,hitCount,truncated,mode,budget,heat:{applied,reason,weights,windowDays,rankedNodes,hitNodes,perProject}}`

```
node cli/mm-cli.js search-all <关键词|--tag 标签> [--scope 项目名,…] [--json] [--compact] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat]
```

### stats

项目统计（节点数/深度/图片数/链接数）

```
node cli/mm-cli.js stats <项目> [--json]
```

### init

创建空项目（meta + root 节点）

```
node cli/mm-cli.js init <项目> [--title 标题]
```

### backlinks

查看节点反向链接（谁引用了我，跨项目）

```
node cli/mm-cli.js backlinks <项目> <id> [--json]
```

### related

查看节点相关知识点（我引用谁 + 谁引用我，双向合并去重；--depth N 扩到 N 跳邻域，N 任意正整数，防环 + 结果上限 500 条，超限响亮报错）

```
node cli/mm-cli.js related <项目> <id> [--json] [--depth N]
```

### ask

向内嵌 DSH 提一个问题（走 `dsh headless` 一次性通道，stdout 即为答案）；**节点可选** —— 不给节点就是项目级提问，--nodes 可一次问多个节点（情境逐个列出）；**思考强度可调**（解释默认 low、问答默认 medium，经 `--patch` 覆盖 `agent-default-model`，取值由模型自己声明）；自动补齐情境；--dry-run 只打印提示词/思考强度 patch/命令行、**不调用模型**

```
node cli/mm-cli.js ask <项目> [<节点id>] [--nodes a,b,c] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run]
```

### theme-layout

设置顶层主题左右分侧（meta.layout；未列出的主题默认在右侧）

```
node cli/mm-cli.js theme-layout <项目> [--left a,b] [--right c,d] [--clear]
```

### add

在父节点下新增子节点（--detail 为 HTML；--detail-md 为 Markdown，命令内转 HTML；--local-path 记录本机文件夹，界面点击即打开）

```
node cli/mm-cli.js add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force]
```

### add-root

新增顶层主题（不选父节点，直接挂在根节点下）—— 一个项目里可放多个不同方面的笔记

```
node cli/mm-cli.js add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--force]
```

### edit

编辑节点字段（--detail HTML / --detail-md Markdown；--tags 覆盖设置标签，逗号分隔；--local-path 记录本机文件夹供界面点击打开）

```
node cli/mm-cli.js edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false]
```

### move

移动节点到新父节点

```
node cli/mm-cli.js move <项目> <id> <新父id> [--index n]
```

### expand-depth

按深度规范化展开状态（默认前 2 层展开、更深的收起；--depth 0 = 全收起），一次原子写

```
node cli/mm-cli.js expand-depth <项目> [--depth N] [--id 子树根id]
```

### remove

删除节点（含子树）；被关联/链接引用时需 --clean-assoc / --clean-links

```
node cli/mm-cli.js remove <项目> <id> [--clean-assoc] [--clean-links]
```

### clone

复制节点到新父节点（--deep 含子树）。副本上的**条目 id 重新签发**（全项目唯一，ITEM-MODEL §5.1），而副本上的条目级边（`links[].item`）**默认逐字仍指原物**（引用语义，克隆不改它）——`--json` 的 `itemEdges.kept` 会把"未被重指向"的条目级边逐条点名（副本节点 / 边下标 / 目标 / 源条目 id，并标 `repointable`），文本档**仅当副本上真有这类边**时多一行（没有 ⇒ 输出与从前逐字相同）。`--repoint-items`：把它们改指**副本自己那份新条目**的**同序号**条目（**语义改变**：引用原物 → 副本内部指涉）；对不上（目标在别的项目 / 目标节点不在被复制范围 / 那个节点里没有这条条目）⇒ **拒绝并点名**，**绝不按序号猜**（猜错就是换了一条边，而回显还说成功）

```
node cli/mm-cli.js clone <项目> <源id> <新父id> [--deep] [--repoint-items] [--json]
```

### apply

按操作清单**一次事务**生效：一批改动在同一个 rev / 一次原子写 / 一条变更日志里完成 ⇒ 全成或全不动；逐条回执（应用/跳过/失败）。**只允许数据面操作**（需要外部副作用的动作必须留在事务外）。支持 `--idem <键>` 重试安全

```
node cli/mm-cli.js apply <项目> --ops-file ops.json [--dry-run]
```

### item-add

新增**一条**条目（改一条不必重写整块 detail）。未条目化的节点会**自动条目化**（先把旧 detail 解析成条目，**且必须能逐字节回放**才动它）。--md 转 Markdown、--html 原样存（表格/代码块要用 --html）；同 type 同正文默认拒绝并点名，--force 放行

```
node cli/mm-cli.js item-add <项目> <节点id> --md "Markdown" | --html "HTML" [--src 出处] [--tags a,b] [--type text|rich] [--after itemId | --before itemId] [--force]
```

### item-edit

改写**一条**条目（只动指定字段，回显**真的变了的字段名**）。--verified 必须同时给 --how（核验是三字段全必填的记录：at/by/how）

```
node cli/mm-cli.js item-edit <项目> <节点id> <itemId> [--md "Markdown" | --html "HTML"] [--src 出处 | --clear-src] [--tags a,b | --clear-tags] [--type text|rich] [--verified --how "怎么核的" | --clear-verified]
```

### item-remove

删除**一条**条目。被 links[].item / assoc.members[].item 引用时**默认拒绝并逐个点名**，显式 --clean-links / --clean-assoc 才连带清理（不许静默删出悬挂引用）

```
node cli/mm-cli.js item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc]
```

### item-move

把一条条目移到**另一个节点**（一次原子写同时重渲染两侧 detail）。目标节点必须已条目化；只调顺序请用 item-order

```
node cli/mm-cli.js item-move <项目> <节点id> <itemId> --to 目标节点id [--after itemId | --before itemId]
```

### item-order

重排条目顺序（--ids 必须是该节点现有条目的**完整排列**；只重排、不增删）

```
node cli/mm-cli.js item-order <项目> <节点id> --ids i-a,i-b,…
```

### render-detail

按 items 重新渲染 detail（**G2 判"detail 与 items 不一致"时的唯一修法**）。幂等：已一致 ⇒ 实际变化 0。只处理条目化节点（没有 items 的节点 detail 是真源，不碰）

```
node cli/mm-cli.js render-detail <项目> <节点id> | --all
```

### recheck

条目层复校：逐条点名 `ok` / `needs-recheck` / `src-gone` 与原因，并给出可执行的下一步。只读是默认；写回 `verified{at,by,how}` 必须显式 `--write-verified --how`，且**写回目标是「出处这一维判得过」**（判不过就不写并点名原因）

```
node cli/mm-cli.js recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json] [--write-verified --how "怎么核的"] [--dry-run]
```

### health

条目层体检（**真值出口**，不是门禁）：条目化/总数、type 分布、`items ↔ detail` 不一致（逐节点点名）、悬挂引用、`qa` 残留、**迁移五档**（可迁移/已条目化/无内容/不在范围/**跳过**，跳过项逐节点点名 + 原因分布）。确定性：两次 `--json` 逐字节相同，不带运行时刻

```
node cli/mm-cli.js health [<项目>] [--project 项目名] [--all] [--root 目录] [--json]
```

### migrate

把 v2 节点的 detail **无损**迁成条目层 items（v2 → v3）：只迁"能逐字节回放"的节点，其余整节点跳过并逐条点名（不许"修一下再写"）；`qa[]` 收敛成 `type:'qa'` 条目后删掉 `qa` 键；写盘前自动 `export-json` 一份到 `.review/<日期>-条目层迁移/` 并打印绝对路径（**没有跳过备份的开关**）；`meta.formatVersion` → 3（validate 同时接受 2 与 3）。幂等：第二次跑 `changed:{nodes:0,items:0}`

```
node cli/mm-cli.js migrate items <项目> [--dry-run] [--json]
```

### ask-apply

把一次 AI 问答落进节点（**一次原子写**完成三件事）：追加 `qa` 记录（`{q,a,at,model?}`，追加不覆盖、完全相同的条目幂等）、把带来源标记与时间的问答追加到 detail 末尾（HTML 存储）、`--as-child` 时再建一个子节点（标题取回答首行截断、详情放全文）。空回答**响亮拒绝**（不许落一条空记录）。`--at` 由调用方给（界面上显示的时间就是落盘时间）

```
node cli/mm-cli.js ask-apply <项目> <id> --answer "回答" [--question "提问"] [--model 模型] [--at ISO时间] [--answer-file 路径] [--as-child] [--child-id id] [--json]
```

### import-md

从 Markdown 导入节点（追加到 parent）。**同一份来源默认只导一次**：本命令会给导入的子树的根写上 `origin`（来源路径 + 内容指纹，见 docs/DATA-FORMAT.md §2.8），再次导入同一 `src`+`sha256` 会**被拒并指名**上一次导到哪去了 —— 真的想要第二份就加 `--force`（那是有意的重复，不是手滑）

```
node cli/mm-cli.js import-md <项目> <md文件> [--parent id] [--force]
```

### import-project

功能 5a：**从大文档建一个新项目 + 一棵新树**（md/txt/docx；PDF **有书签走书签、无书签自动回退文字层**，两样都没有才响亮拒绝）；1 级标题成为顶层主题；一次原子写入，失败不留半个项目；--dry-run 只预览格式/规模/前几个标题与来源、不写盘（并如实报"这份文档已经导过了"）；入参是**目录**或路径读不了时**响亮拒绝并给出路**；**同一份来源默认只导一次**（`origin.src`+`origin.sha256` 全库比对，重复会拒绝并指名是哪个项目导的）—— 真的想再建一棵就加 `--force`

```
node cli/mm-cli.js import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json] [--force]
```

### import-dir

批 5：**整库导入 —— 把一个文件夹的结构镜像成一棵树**（每一级子目录 = 一个容器节点，每个文件 = 该容器下的一个文件节点，标题取**文件名去扩展名**，文档自己的标题在它下面）。默认导 `.md/.txt/.docx/.pdf`（`--ext` 覆盖，只许写真的能导的扩展名）；隐藏文件/`.git`/`node_modules`/符号链接/空目录/无读权限/不支持的扩展名**一律跳过并逐类计数**（报告给"导入了 N 个文件 / 跳过 M 个（按原因分组）"，**不许静默**）；上限：合计 `MAX_SOURCE_MB`（与单文件闸门共用一份常量）+ 文件数 `--max-files`（默认 200），**超限在写盘之前响亮拒绝并给出路**；**一次原子写**，失败不留半个项目；`--dry-run` 只出报告、绝不写盘（并如实报超限与"这个目录已经导过了"）；**幂等**：项目根记**目录清单指纹**（同一个目录重复导 ⇒ **整体拒绝**并指名）、每个文件节点记自己的来源指纹（同一个文件被别的命令导过也拒绝）—— 确实要第二份就加 `--force`

```
node cli/mm-cli.js import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] [--max-files N] [--dry-run] [--json] [--force]
```

### export-md

导出为文件夹：<项目>.md + assets/ + attachments/（v0.16 起）

```
node cli/mm-cli.js export-md <项目> <输出目录> [--format heading|list] [--with-detail]
```

### export-json

导出为 aimap 单文件（图片 base64 内嵌，可移植）

```
node cli/mm-cli.js export-json <项目> <输出.json>
```

### export-html

导出为静态站点（index.html + assets/，可分享部署；相关知识点已内联为可跳转链接）

```
node cli/mm-cli.js export-html <项目> <输出目录>
```

### import-json

从 aimap 单文件导入为新项目（解包图片）

```
node cli/mm-cli.js import-json <aimap.json> [--name 项目名]
```

### add-image

给节点添加图片（复制进 assets/）

```
node cli/mm-cli.js add-image <项目> <id> --file 图片 --caption 备注 [--source 出处] [--tags a,b]
```

### remove-image

移除节点上的图片引用

```
node cli/mm-cli.js remove-image <项目> <id> <相对路径 assets/x.png>
```

### assets

列出项目全部图片及 caption

```
node cli/mm-cli.js assets <项目> [--json]
```

### add-file

给节点添加附件文件（复制进 attachments/，md/pdf 可内预览）

```
node cli/mm-cli.js add-file <项目> <id> --file 附件 --caption 备注 [--source 出处]
```

### remove-file

移除节点上的附件引用

```
node cli/mm-cli.js remove-file <项目> <id> <相对路径 attachments/x.md>
```

### files

列出项目全部附件及 caption

```
node cli/mm-cli.js files <项目> [--json]
```

### sidebar-only

on = 关掉左边思维导图页（**真卸载这一页**：内存释放、主窗口只剩占位页），DSH 侧栏继续可用；off = 重新加载导图页（回到上次的项目与侧栏停靠宽度）。⚠️ 有未保存编辑时 on 会被**拒绝**（报错带原因、不弹模态框）—— 先让人保存，或让人点界面上的 ✕（那条路会先问「保存后关闭」）。无回执即报错（界面没在跑）

```
node cli/mm-cli.js sidebar-only <on|off> [--json]
```

### dsh-sidebar

on = 打开侧栏 DSH；off = 关掉侧栏 DSH（连服务一起停、侧栏视图**销毁**；主界面与项目数据不受影响）。方向与 sidebar-only 相反

```
node cli/mm-cli.js dsh-sidebar <on|off> [--json]
```

### dsh-status

**只读**诊断：侧栏实况（可见性/总占宽/窄宽模式/是否横向溢出/内核右栏与自动加宽状态）。不改状态、不含 url/token

```
node cli/mm-cli.js dsh-status [--json]
```

### dsh-prefill

把一段文本送进 DSH 侧栏的输入框（**不代替你发送** ✗ —— 侧栏按了发送才进它的会话历史）；等主进程**回执**才报成功 ✓；失败会给出原因（侧栏没开/服务没跑/找不到输入框）

```
node cli/mm-cli.js dsh-prefill "<文本>" | dsh-prefill --file <路径> [--json]
```

### link

添加跨项目链接（`--item` ⇒ 边指向**目标节点里的某一条条目**，即 `{project,id,item}`）。**重复添加同一条边**（同项目/同目标/同条目）分三种结局，回显可分辨：省略 --caption/--item ⇒ **保留**原有值（幂等，回显「无变化」且不写盘）；显式给新值 ⇒ **覆盖**（回显「已更新链接」并写出 旧 → 新）；显式 `--caption ""` / `--item ""` ⇒ **清空**那一层（回显「已更新链接（caption 清空 / item 清空）」）。⚠️ 只写 `--caption` / `--item` 不给值会被**响亮拒绝**；目标节点在、但 `--item` 那条条目不在 ⇒ **拒绝并点名**（绝不造出"节点在、条目不在"的悬挂引用）。⚠️ **人手里敲不出"显式空串"**：PowerShell 会把裸 `""` 从 argv 里**抹掉** ⇒ `--caption ""` / `--item ""` 根本到不了命令（实测：argv 里只剩 `--caption` / `--item`，被解析成 `true`，随后被上面那条**响亮拒绝**）。要清空请用**等号形式** `--caption=` / `--item=`（PowerShell 里**加引号没用** —— 实测 `""` 同样被抹掉）。这是**外壳**（shell）的行为，**不是**本命令的行为：命令本身照旧支持"显式空串 = 清空"

```
node cli/mm-cli.js link <项目> <id> --to 目标项目 --id 目标id [--item 目标条目id] [--caption 说明]
```

### unlink

移除跨项目链接（指向该目标的边一律移除，含条目级的）

```
node cli/mm-cli.js unlink <项目> <id> --to 目标项目 --id 目标id
```

### links

列出项目全部跨项目链接（条目级的边多 `item` 字段并写成 `目标/节点#条目`；`--json` 另有 `itemEdges` 计数 —— **只增字段**，节点级的边形状不变）

```
node cli/mm-cli.js links <项目> [--json]
```

### links-prune

清理悬空链接（目标已不存在，修好悬挂链接导致的校验红）。**条目级与节点级同一处判据**：节点整个不在了、或**节点还在但那一条条目已被删**，都会被抓出来剪掉，并在报告里**分开点名**（后者单独列出）；`--items 节点id#条目id` 是等价的精确档。`--nodes a,b` 是**按节点 id 的强力档**：**不比对项目名** ⇒ 链接指向**别的项目**里同名 id 的节点时**也照样剪**（删节点时正是要这个），且**含**精确指到它某一条目的边（即"含条目级"）

```
node cli/mm-cli.js links-prune <项目> [--nodes a,b] [--items a#i-1,b#i-2] [--dry-run]
```

### orphans

关系审计：列出无任何引用关系的节点，并区分「含内容待处理」与「纯结构正常」

```
node cli/mm-cli.js orphans <项目> [--json] [--content-only] [--limit n]
```

### mentions

未链接提及：正文提到了某节点却没建 links（orphans 的另一半，告诉你"该往哪连"）；--cross 扫描跨项目两个方向

```
node cli/mm-cli.js mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n]
```

### assoc-list

列出关联笔记（--node 只看该节点所属的；--raw 附带原始实体）

```
node cli/mm-cli.js assoc-list <项目> [--node <id>] [--json] [--raw]
```

### assoc-add

新增关联笔记（成员 ≥2；跨项目写 项目/节点id）

```
node cli/mm-cli.js assoc-add <项目> --members a,b,c [--title 标题] [--note html | --note-md markdown] [--id id] [--force]
```

### assoc-edit

修改关联笔记的标题/成员/笔记内容

```
node cli/mm-cli.js assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c]
```

### assoc-remove

删除关联笔记

```
node cli/mm-cli.js assoc-remove <项目> <assocId>
```

### assoc-prune

清理关联里已不存在的成员（修好悬挂成员导致的校验红）

```
node cli/mm-cli.js assoc-prune <项目> [--nodes a,b] [--dry-run]
```

### validate

校验项目数据格式（含悬挂链接与悬挂关联成员）

```
node cli/mm-cli.js validate <项目|json文件> [--json]
```

### validate-all

校验 projects/ 下全部项目

```
node cli/mm-cli.js validate-all
```

### ui-state

查界面是否有未保存编辑（写前协调：dirty 时先请用户保存再动笔）

```
node cli/mm-cli.js ui-state [<项目>] [--json]
```

### changes

变更可见性（只读，多路同时编辑的**事前避让**）：最近是谁、什么时候、改了哪些对象。--since <锚点> 回答"自这一版以来改了什么"，锚点取 `changes <项目> --json` 的 version 或 rev（⚠ `read --json` 不含 version）。⚠ 答不出来时**报错并非 0 退出**（锚点滑出窗口 / 本机无日志）—— 那**不等于"没有变更"**

```
node cli/mm-cli.js changes [<项目>] [--since <rev|版本号>] [--json] [--limit n]
```

### visit

记一次**访问事件**（旁路日志 `.visits.jsonl`，一行一条 JSON、不进 export-json、可随时删；**O(1) 追加**：只多写一行，不读全量、不重写文件）。「谁（人/AI）」由 `--channel` 决定，**不许调用方自报**；通道权重表只有一处（`src/heat.js` 的 `CHANNELS`），未知通道**响亮拒绝**。时间取**写入时刻**（一次访问不该有两个时间 ⇒ 本命令没有 `--at`）。合法通道与权重见报错报文

```
node cli/mm-cli.js visit <项目> <节点id> --channel <通道> [--json]
```

### heat

访问热度（只读，**热度条第一件**）：人 / AI 两条榜 + 每节点热度值 + **窗口内样本量**。窗口 = 最近 30 天（滚动）；排名在「窗口内被访问过的节点」这个**子集内**做（零访问节点不进榜、不参与分位）；热度是**名次**的十档位置（1–10），**与次数的绝对值无关**（次数 ×10 而名次不变 ⇒ 热度不变）。AI 侧按通道**加权**（权重表见 `src/heat.js` 的 `CHANNELS`），人侧只算「打开详情框」。`--derived summary|keys`（**只在 `--json` 里**）另给 **AI 侧的隐藏维度**：`tags` / `sections` / `trees` 三组，**全部由节点热度派生**（不是各记一套），每维带 `nodes/visited/events` 样本量；`keys` 是最省的一档（只要维度名）。**界面不显示这些维度**（渲染层只画节点自己的两条热度条）。每维至多列 20 项（**只截显示**，名次与档位一律按全量算；`total`/`truncated`/`keys` 仍是全量读数）。`--node <id>`（**只在 `--json` 里**）另给**这一个节点**的读数 `node`：`{heat,bands,rank,visits,listed,reason,sample}` —— 界面两条热度条读的就是它，折算（名次→档位→该亮几格）只有一处（`src/heat.js` 的 `heatProfile`）；**按全量排名算，不受 `--limit` 影响**（被访问过但没进显示窗口的节点也能取到）。⚠ 日志损坏 / 认不出的通道 / 时间乱序 / 未来时间戳 ⇒ **报错并非 0 退出并点名**（不静默当 0）；本机没有该日志 ⇒ 明说"没有访问日志"，**不等于"热度为 0"**。`--limit` 只截断显示，热度一律按全量排名算

```
node cli/mm-cli.js heat <项目> [--json] [--limit <n>] [--node <id>] [--derived <summary|keys>]
```

### docs-gen

从 registry 重生成 docs/CLI.md

```
node cli/mm-cli.js docs-gen
```

### release

发版：CHANGELOG 段落版 → [Unreleased] 重建 + 四处版本号同步 + README 版本锁（拒绝版本倒退）

```
node cli/mm-cli.js release [版本号] [--major|--minor|--patch]
```

### changelog

CHANGELOG 窄查询（只读）：段/条目索引（行号+行数+字节）或按关键词检索正文 —— 回答「上轮改了什么」不必通读全文（体量随迭代增长，要当前值就跑 `node scripts/doc-facts.js`，别在文档里写死）

```
node cli/mm-cli.js changelog [--grep 关键词] [--full] [--limit n] [--json]
```

### dsh-caps

DSH 能力边界（只读）：从 vendor/dsh 的装配清单 + 磁盘包目录机械读取「挂了什么/有什么」—— 防止为"其实已经有"的能力写新命令或装新插件。⚠️ 两条最易误判：host 平面 disabled:true ≠ 不可用；装配文件里没有 ≠ 不具备（包可能就在磁盘上、只是当前没挂）

```
node cli/mm-cli.js dsh-caps [--json] [--grep 关键词] [--unmounted]
```
