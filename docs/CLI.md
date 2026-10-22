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
- `docs-gen --check` 同这一档：**只比对、绝不写盘**；`--json` 给 `{ok,mismatchCount,products[]}`（键序固定、无时间戳 ⇒ 同一状态两跑逐字节相同），失败也以**非 0 退出码**表达，stdout 仍是**一份**可解析 JSON
- 项目名 = `projects/<name>/<name>.json` 的目录名

## 命令一览

| 命令 | 说明 |
|------|------|
| `projects` | projects [--json] |
| `read` | read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--items <条目id,…>] [--images] |
| `list` | list <项目> [--json] |
| `get` | get <项目> <id> [--json] [--item <itemId>] [--detail] [--images] |
| `search` | search <项目> <关键词|--tag 标签> [--json] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] [--mode <预设>] [--weights <路由=权重,…>] [--recall <路由>] [--explain] |
| `search-all` | search-all <关键词|--tag 标签> [--scope 项目名,…] [--json] [--compact] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] [--mode <预设>] [--weights <路由=权重,…>] [--recall <路由>] [--explain] |
| `stats` | stats <项目> [--json] |
| `tags` | tags [<项目>…] [--json] [--vocab] |
| `init` | init <项目> [--title 标题] [--dry-run] |
| `backlinks` | backlinks <项目> <id> [--json] |
| `related` | related <项目> <id> [--json] [--depth N] |
| `source-chain` | source-chain <项目> <id> [--json] [--depth N] [--reverse] |
| `ask` | ask <项目> [<节点id>] [--nodes a,b,c] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run] |
| `theme-layout` | theme-layout <项目> [--left a,b] [--right c,d] [--clear] [--dry-run] |
| `add` | add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force] [--dry-run] |
| `add-root` | add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force] [--dry-run] |
| `edit` | edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false] [--dry-run] |
| `move` | move <项目> <id> <新父id> [--index n] [--dry-run] |
| `expand-depth` | expand-depth <项目> [--depth N] [--id 子树根id] [--dry-run] |
| `remove` | remove <项目> <id> [--clean-assoc] [--clean-links] [--dry-run] |
| `clone` | clone <项目> <源id> <新父id> [--deep] [--repoint-items] [--json] [--dry-run] |
| `apply` | apply <项目> --ops-file ops.json [--dry-run] |
| `batch` | batch --calls-file calls.json [--json] |
| `item-add` | item-add <项目> <节点id> --md "Markdown" | --html "HTML" [--src 出处] [--tags a,b] [--type text|rich] [--after itemId | --before itemId] [--force] [--dry-run] |
| `item-edit` | item-edit <项目> <节点id> <itemId> [--md "Markdown" | --html "HTML"] [--src 出处 | --clear-src] [--tags a,b | --clear-tags] [--type text|rich] [--verified --how "怎么核的" | --clear-verified] [--dry-run] |
| `item-remove` | item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc] [--dry-run] |
| `item-move` | item-move <项目> <节点id> <itemId> --to 目标节点id [--after itemId | --before itemId] [--dry-run] |
| `item-order` | item-order <项目> <节点id> --ids i-a,i-b,… [--dry-run] |
| `render-detail` | render-detail <项目> <节点id> | --all [--dry-run] |
| `recheck` | recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json] [--write-verified --how "怎么核的"] [--dry-run] |
| `health` | health [<项目>] [--project 项目名] [--all] [--root 目录] [--json] |
| `migrate` | migrate items <项目> [--dry-run] [--json] |
| `ask-apply` | ask-apply <项目> <id> --answer "回答" [--question "提问"] [--model 模型] [--at ISO时间] [--answer-file 路径] [--as-child] [--child-id id] [--json] [--dry-run] |
| `import-md` | import-md <项目> <md文件> [--parent id] [--force] [--dry-run] [--json] |
| `import-project` | import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json] [--force] |
| `import-dir` | import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] [--max-files N] [--vault|--no-vault] [--dry-run] [--json] [--force] |
| `merge-project` | merge-project <目标项目> <源项目> [<源项目…>] [--parent <id>] [--links keep|repoint] [--group-id <id>] [--dry-run] [--json] |
| `export-md` | export-md <项目> <输出目录> [--format heading|list] [--with-detail] |
| `bind-sync` | bind-sync <项目> [--bind --dir <目录> --mode flat|mirror --include <模式,…> --ignore <模式,…> --ext <扩展名,…> --debounce <毫秒> --id <绑定id>] [--binding <绑定id>] [--pause|--resume|--unbind|--list] [--watch-dirs] [--forget-snapshot] [--confirm-deletions] [--json] [--dry-run] |
| `learn-path` | learn-path <项目…> [--out <新项目名>] [--order 项目,…] [--limit n] [--title 标题] [--force] [--json] [--dry-run] |
| `export-json` | export-json <项目> <输出.json> |
| `export-html` | export-html <项目> <输出目录> |
| `import-json` | import-json <aimap.json> [--name 项目名] [--json] |
| `import-grade` | import-grade [<项目>] [--project 项目名] [--all] [--only 子串] [--limit n] [--include-probe] [--json] |
| `add-image` | add-image <项目> <id> --file 图片 --caption 备注 [--source 出处] [--tags a,b] [--dry-run] |
| `remove-image` | remove-image <项目> <id> <相对路径 assets/x.png> [--dry-run] |
| `assets` | assets <项目> [--json] |
| `add-file` | add-file <项目> <id> --file 附件 --caption 备注 [--source 出处] [--dry-run] |
| `remove-file` | remove-file <项目> <id> <相对路径 attachments/x.md> [--dry-run] |
| `files` | files <项目> [--json] |
| `sidebar-only` | sidebar-only <on|off> [--json] |
| `dsh-sidebar` | dsh-sidebar <on|off> [--json] |
| `dsh-status` | dsh-status [--json] |
| `dsh-prefill` | dsh-prefill "<文本>" | dsh-prefill --file <路径> [--json] |
| `draft-map` | draft-map --file <树.json> [--source 说明] [--json] |
| `point` | point <项目> <节点id> [--mode note|related] [--json] |
| `link` | link <项目> <id> --to 目标项目 --id 目标id [--item 目标条目id] [--caption 说明] [--dry-run] |
| `unlink` | unlink <项目> <id> --to 目标项目 --id 目标id [--dry-run] |
| `links` | links <项目> [--json] |
| `links-prune` | links-prune <项目> [--nodes a,b] [--items a#i-1,b#i-2] [--dry-run] |
| `orphans` | orphans <项目> [--json] [--content-only] [--limit n] |
| `mentions` | mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n] |
| `contents` | contents <项目> [--json] [--depth N] [--parent <id>] [--min-count N] [--apply] [--dry-run] |
| `assoc-list` | assoc-list <项目> [--node <id>] [--json] [--raw] |
| `assoc-add` | assoc-add <项目> --members a,b,c | --anchor "项目/节点id#text:关键词" [--anchor …] [--title 标题] [--note html | --note-md markdown] [--id id] [--force] [--dry-run] |
| `assoc-edit` | assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c] [--anchor …] [--clear-anchors] [--dry-run] |
| `assoc-remove` | assoc-remove <项目> <assocId> [--dry-run] |
| `assoc-prune` | assoc-prune <项目> [--nodes a,b] [--dry-run] |
| `validate` | validate <项目|json文件> [--json] [--anchors] |
| `validate-all` | validate-all |
| `ui-state` | ui-state [<项目>] [--json] |
| `changes` | changes [<项目>] [--since <rev|版本号>] [--json] [--limit n] |
| `timeline` | timeline [<项目>] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit n] [--json] |
| `visit` | visit <项目> <节点id> --channel <通道> [--json] |
| `heat` | heat <项目> [--json] [--limit <n>] [--node <id>] [--derived <summary|keys>] |
| `docs-gen` | docs-gen [--check] [--json] |
| `release` | release [版本号] [--major|--minor|--patch] |
| `changelog` | changelog [--grep 关键词] [--full] [--limit n] [--json] |
| `features` | features [--grep <词>] [--code <代号>] [--json] |
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

搜索（**默认口径 = 搜条目**：节点 topic ∪ 条目正文；`--topic-only` 回退 v2 只搜标题）。**命中 = 关键词是命中面的「非连续子序列」**（大小写不敏感 —— 与界面命令面板**同一个谓词、同一份打分**，`src/palette-rank.js` 是唯一实现处）：`闸门` 命中 `闸 与 门` 之间隔了字的标题，`tp` 命中 `TCP`；纯 `--tag`（无关键词）不参与这套排序。**顺序 = 那份模糊打分升序，同分保持「深度优先 + 条目序」** ⇒ 本机没有热度日志（或加 `--no-heat`）时，同一查询的节点顺序与命令面板**逐条相同**。命中形状：`{id,topic,nodeId,nodeTopic,itemId,type,itemized,matchIn,snippet,src,verified,score}`（`id`/`topic` 是 v2 兼容别名；未条目化节点 itemId=null/type=null/itemized=false；`score` 仍是**子串出现次数**，模糊命中回落 1）。过滤：`--tag`（条目级标签 → item-tag / 节点级 → node-tag；未条目化节点照 v2 报 tag）、`--src`（src 子串，字符串或数组任一项）、`--verified`（只要已核条目）、`--type`（text|rich|qa）、`--since <ISO|相对时长>`（at >= 界；**给了它就不给未条目化的节点命中** —— 节点上本来没有写入时间（`TL` 的节点级时间走 `timeline` 命令）；相对时长 `7d`/`24h`/`90m`/`2w` **必须配 `--now <ISO>`**，否则**报错**：本命令不读墙钟 —— 读墙钟会让同一查询两跑结果不同）；`--full` 在默认口径之上再并上 v2 的额外面（图片 caption / 节点级标签 / 链接说明）。排序：模糊打分（上面那一条）先定基线，热度（人 / AI 两条，近 30 天窗口）作为**一个封顶向量**在其上重排 —— 只重排、不改变命中与否，占总分 ≤ 8%（取值与理由的唯一一处：src/heat.js 的 SEARCH_RANK）；本机没有该日志时**不参考热度**（≠ 热度为 0，`--json` 的 heat.reason 会说明）。`--no-heat`：**显式**跳过热度日志 —— 本次调用**完全不碰它（不读、不写、不排序）**：日志坏了 / 认不出通道 / 时间乱序时这是**先拿到结果**的出口（往坏日志里再追加一条只会搅得更坏 ⇒ 写入这一半也必须一起关）；⚠ 它不改变默认档：默认遇到坏日志仍然**响亮失败**（不许静默降级成"按 0 排"）。预算：`--limit`（缺省 200，上界 1000）/ `--max-bytes`（缺省 65536，16–4194304）；`--json` 顶层 `{project,keyword,hits,hitCount,truncated,mode,budget:{bytes,estTokens,limit,maxBytes},heat:{applied,reason,weights,windowDays,rankedNodes,hitNodes,log}}`，超限截断并给续取方式（budget.resume）。非法值（含 --verified/--type/--since 写错）**当场报错**，不静默退化成默认值或"0 命中"。混合检索（**W4**）：**不给 `--mode` / `--weights` 时这一层是关的 —— 输出与从前逐字节相同**；给了才启用，且只在**既有命中内部**重排（不增删命中、不改命中形状与 hitCount）。`--mode`：balanced(text=1,graph=0.5,expand=0.5,trust=0.2,time=0.2,semantic=0) / recent(text=1,graph=0.2,expand=0.2,trust=0.1,time=1,semantic=0) / conceptual(text=0.5,graph=1,expand=0.5,trust=0.2,time=0,semantic=0)（预设表与理由的唯一一处：src/palette-rank.js 的 MODES）。`--weights text=1,graph=.5,…` 自己定权重：它是**完整名单**，没提到的路由权重按 0（写在明面上，不做"在预设上偷偷覆盖"那套）；可选路由 text / graph / expand / trust / time / semantic—— 语义（`semantic`）那一档的**向量**那一半仍未落地 ⇒ **未安装**（权重收下但不产生名次，`--explain` 里逐路点名，不静默少一路）；"生成候选"那一半已由 `expand` 落地（见下，**它是词法不是向量**）。`--mode` 与 `--weights` **不能同给**（预设 vs 完整名单，两种口径不混）。融合是 **RRF**：总分 = Σ 权重/(k + 名次)，k = 60（只吃名次 ⇒ 不含量纲、不需要归一化；k 与理由只有 src/palette-rank.js 一处）。`--explain` 只**多给读数**、**不改排序**：文本档逐路 + 逐条列出"由哪几路贡献、各自什么排名"，`--json` 多一个顶层 `explain:{enabled,mode,k,weights,recall,routes,hits}`（`explain.hits` 与 `hits` 逐条同长同序；命中对象**不加任何键** —— 12 键契约不动）。扩召回（**W4b**）：`--recall <路由>` —— **不给它时输出与从前逐字节相同**（候选集、`hitCount`、`matchIn` 取值集合都不变，与 W4 那条"默认关"同一条纪律）。给了才**真的扩召回**：把"非字面命中"也接进结果 —— 候选来源逐路由表：`graph` = 头名在有界邻域里的近邻（门槛 = 那一行的 `bound`）；【W3-do】`expand` = **候选生成**（查询与**标题**的最长公共片段 ≥ 2 字，**不需要头名** ⇒ 零字面命中的查询也能接回候选；**它是词法片段，不是向量、没有模型**）⇒ `hitCount` 与 `hits` **会因此变多**，新命中的 `matchIn` = 该路声明的取值（graph(matchIn=near，上界 2 跳) / expand(matchIn=expand，最短公共片段 ≥ 2 字)）。能扩召回的只有路由表里标了 `recall` 的那几路（graph / expand）；它必须与 `--mode` / `--weights` **同给**（它改变的是**候选集**，而"这批候选怎么排"是融合那一层的事 —— 只给 --recall 就等于替你偷偷挑一个默认预设）；不认识的 route / 不能扩召回的路由 / 写两遍 ⇒ **当场报错**。硬过滤仍正交：`--tag` 与关键词照旧 AND，给了条目级过滤（--src/--verified/--type/--since）就只允许条目命中 ⇒ 扩召回不参与（它不许绕过过滤）。`--explain` 里逐路报"这次接回来几条 / 为什么是 0"（没点名的那几路也在，标 `asked:false`）。**命中形状仍是 12 键**：本件是**开** `matchIn` 的取值表（多一个 `near / expand`），**不是加键**。判据与读数：`tests/search-recall.test.js`（默认档逐字节不变 / 上界来自路由表 / 硬过滤不被绕过 / 黄金集扩量给读前读后 / 注入证明 / 一处实现的静态把守），语料 `tests/fixtures/hybrid-golden.json`。

```
node cli/mm-cli.js search <项目> <关键词|--tag 标签> [--json] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] [--mode <预设>] [--weights <路由=权重,…>] [--recall <路由>] [--explain]
```

### search-all

**跨项目检索**：一次调用扫**全库**（`projects/` 下全部项目，按**项目名升序**），每条命中带 `project` —— 这是卖点 1 那句"AI 不必每次上网搜"的技术前提（从前 `search` 必须点名**单个**项目）。`--scope 项目甲,项目乙` 把范围收回来（名单里的项目不存在 ⇒ **报错并逐个点名**；`--scope` 裸写/空名单 ⇒ 报错，不静默当"全库"）；其余选项与 `search` **同一个语义**（同一条 `searchItems` 实现）：`--tag` / `--full` / `--topic-only` / `--src` / `--verified` / `--type` / `--since` / `--limit` / `--max-bytes`；**命中口径与排序口径也逐字同一条**（命中 = 关键词是命中面的**非连续子序列**；项目内顺序 = 模糊打分升序、同分保持「深度优先 + 条目序」—— 打分与定序的唯一实现在 `src/palette-rank.js`，界面命令面板吃的是同一份）。顺序 = **项目名升序 × 项目内既有顺序**（项目内与 `search <该项目>` 逐条同序，含它自己的热度榜）；**不做跨项目重排**（**热度重排**的唯一实现是 `src/item-index.js` 的 `orderByHeat`；跨项目比分数会是第二份排序实现，且 nodeId 只在项目内唯一）。热度**逐项目各算各的榜**（人 / AI 两条，窗口 30 天，封顶见 `src/heat.js` 的 SEARCH_RANK）；`--no-heat` = `search` 的同名开关（本次完全不碰任何项目的热度日志）。两条**硬上限**（调用方改不了，越限 ⇒ **响亮报错 + 一条命中都不返回**，与"截断"是两件事）：命中总数 2000 条、扫描耗时 3000 ms（取值与报文都在 `src/item-index.js` 的 `scanGate`）。`--limit` / `--max-bytes` 是**调用方预算**：截断时如实写 `truncated` 并给续取方式。**不许静默少扫**：某个项目的**数据读不出来** ⇒ 跳过它，但在 `skipped` 里逐个点名（文本档一行 `⚠ 跳过项目「…」`，汇总行写"⚠ 另有 N 个项目没扫成"）；它的**热度日志坏了** ⇒ 整体失败并点名那个项目（与 `search` 同一条纪律，出路 `--no-heat`）。无命中时**明确报"0 条"**（不是空输出）。`--json` 顶层 `{keyword,tag,scoped,scope,scanned,skipped,hits,hitCount,truncated,mode,budget,heat:{applied,reason,weights,windowDays,rankedNodes,hitNodes,perProject}}`。混合检索（**W4**）：`--mode` / `--weights` / `--explain` = `search` 的同名开关（同一处解析与同一份路由表，`src/palette-rank.js`）；**不给 `--mode` / `--weights` 时这一层是关的**（输出与从前逐字节相同）。顺序仍是 **项目名升序 × 项目内顺序**：融合是**逐项目各算各的**（每路的名次都是项目内的）⇒ 每个项目的分片与 `search <该项目> --mode/--weights …` 逐条同序；**仍然不做跨项目重排**（跨项目比分数/名次会是第二份排序实现，且 nodeId 只在项目内唯一）。`--explain` 的 `routes[].ranked` 是**跨项目合计** + 逐项目分账（名次不能跨项目相加，所以分账也一并给），`explain.hits` 每条带 `project`。扩召回（**W4b**）：`--recall <路由>` = `search` 的同名开关（同一处解析；能扩召回的是 graph / expand，报 `matchIn` = near / expand）；**不给它时输出与从前逐字节相同**；给了也**逐项目各算各的**（候选来源与名次都是项目内的 ⇒ 每个项目的命中与 `search <该项目> --recall …` 逐条相同）。`--explain` 的 `recall.routes[].added` 同样是**跨项目合计 + 逐项目分账**；命中形状仍是 **12 键**（开的是 `matchIn` 取值表，不是加键）

```
node cli/mm-cli.js search-all <关键词|--tag 标签> [--scope 项目名,…] [--json] [--compact] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] [--mode <预设>] [--weights <路由=权重,…>] [--recall <路由>] [--explain]
```

### stats

项目统计（节点数/深度/图片数/链接数）

```
node cli/mm-cli.js stats <项目> [--json]
```

### tags

**标签清单**（只读）：有哪些标签、各多少个节点、分布在哪几个项目 —— 答的是 `stats` 答不了的那半（`stats` 只给标签总数，而 `search --tag` 要求你先知道标签名）。**不给项目名 = 全库**（按项目名升序扫）；点名项目 = 只扫这些（`tags 甲 乙`）。`--vocab` 追加**词表核对**三条判据：① 出现的标签是否都在 `docs/TAGS.md` §4 那个闭集里（`tags[].inVocab`）；② 落点是否达到 §2 第 6 条 / §8 判据① 的下限（≥5；§4 该行写明「门面特性」的 ≥3）；③ §4 里有、本次扫描面 0 落点的"词表空转"。⚠️ `--vocab` **必须点名项目**：那份词表的标题是「7 本书共用」，而"哪几个项目适用"在盘上没有机器可读的声明（`comnet` 有自己的标签，不受它约束）⇒ 全库只给清单、不给合规判断（不带项目名会响亮拒绝并给出路）。**不做标签之间的共现/孤岛/层级**（理由见 `cli/commands/project.js` 的 `tags` 函数头）。`--json` **两跑逐字节相同**：键序固定、无时间戳、排序一律码点序（不用 locale）。

```
node cli/mm-cli.js tags [<项目>…] [--json] [--vocab]
```

### init

创建空项目（meta + root 节点）

```
node cli/mm-cli.js init <项目> [--title 标题] [--dry-run]
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

### source-chain

**经验来源链（产品代号 `SC`，台账 `W17`）**：**只沿** `links[].caption` 以「出自：」开头的边多跳溯源，逐跳给出节点与那一跳的出处原文；`--reverse` 反查"谁把我当出处"（同一张图的入边方向，不需要第二套语义）。**与 `related` 的分工**：那个是**无类型区分**的双向邻域（浏览相关），这个是**有向 + 有类型**的溯源 ⇒ 判据只有一处（`src/source-chain.js`）。**三条硬口径**：① **只读**（不进写命令、不碰 `.changes.jsonl`、**不记热度** ⇒ `--json` 两跑逐字节相同：键序固定、无时间戳、无随机、排序一律码点序）；② **成环响亮拒绝并逐条点名环上的边**（含每条的 caption 与路径，**一条边都不丢**、也不替你挑一条断掉）；③ **撞上限响亮报错**（`--depth` 1–`MAX_DEPTH`、链条数/边条数各一档），绝不静默截断。`otherPrefixes` 如实报"这些边我没跟"（caption 前缀计数）——真实数据里 `来源：` 560 条由 `learn-path` 生成，**本命令有意不认**（词表唯一权威是 `docs/TAGS.md` §11，不越权替它认第 6 种写法）；`nearMiss` 报"以「出自」开头但不是「出自：」"的写法（`出自:` 这类会让一条出处声明**静默失效**）

```
node cli/mm-cli.js source-chain <项目> <id> [--json] [--depth N] [--reverse]
```

### ask

向内嵌 DSH 提一个问题（走 `dsh headless` 一次性通道，stdout 即为答案）；**节点可选** —— 不给节点就是项目级提问，--nodes 可一次问多个节点（情境逐个列出）；**思考强度可调**（解释默认 low、问答默认 medium，经 `--patch` 覆盖 `agent-default-model`，取值由模型自己声明）；自动补齐情境；--dry-run 只打印提示词/思考强度 patch/命令行、**不调用模型**

```
node cli/mm-cli.js ask <项目> [<节点id>] [--nodes a,b,c] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run]
```

### theme-layout

设置顶层主题左右分侧（meta.layout；未列出的主题默认在右侧）

```
node cli/mm-cli.js theme-layout <项目> [--left a,b] [--right c,d] [--clear] [--dry-run]
```

### add

在父节点下新增子节点（--detail 为 HTML；--detail-md 为 Markdown，命令内转 HTML；--local-path 记录本机文件夹，界面点击即打开）。**新节点默认折叠**（不给 --expanded 就显式写 expanded:false —— 缺键等于展开，靠省略折不起来）

```
node cli/mm-cli.js add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force] [--dry-run]
```

### add-root

新增顶层主题（不选父节点，直接挂在根节点下）—— 一个项目里可放多个不同方面的笔记。**新主题默认折叠**（同 add；要它展开就写 --expanded true，那是本命令唯一的逃生门）

```
node cli/mm-cli.js add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force] [--dry-run]
```

### edit

编辑节点字段（--detail HTML / --detail-md Markdown；--tags 覆盖设置标签，逗号分隔；--local-path 记录本机文件夹供界面点击打开）

```
node cli/mm-cli.js edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false] [--dry-run]
```

### move

移动节点到新父节点。`--index n` = **移动完成后**在新父 children 里的下标（0 基）；上界 = 新父**移除该节点之后**的子节点数（n = 上界即插到末尾）⇒ 越界**响亮拒绝并报出合法范围**（不许静默退化成"插到末尾"）

```
node cli/mm-cli.js move <项目> <id> <新父id> [--index n] [--dry-run]
```

### expand-depth

按深度规范化展开状态（默认前 2 层展开、更深的收起；--depth 0 = 全收起），一次原子写

```
node cli/mm-cli.js expand-depth <项目> [--depth N] [--id 子树根id] [--dry-run]
```

### remove

删除节点（含子树）；被关联/链接引用时需 --clean-assoc / --clean-links

```
node cli/mm-cli.js remove <项目> <id> [--clean-assoc] [--clean-links] [--dry-run]
```

### clone

复制节点到新父节点（--deep 含子树）。副本上的**条目 id 重新签发**（全项目唯一，ITEM-MODEL §5.1），而副本上的条目级边（`links[].item`）**默认逐字仍指原物**（引用语义，克隆不改它）——`--json` 的 `itemEdges.kept` 会把"未被重指向"的条目级边逐条点名（副本节点 / 边下标 / 目标 / 源条目 id，并标 `repointable`），文本档**仅当副本上真有这类边**时多一行（没有 ⇒ 输出与从前逐字相同）。`--repoint-items`：把它们改指**副本自己那份新条目**的**同序号**条目（**语义改变**：引用原物 → 副本内部指涉）；对不上（目标在别的项目 / 目标节点不在被复制范围 / 那个节点里没有这条条目）⇒ **拒绝并点名**，**绝不按序号猜**（猜错就是换了一条边，而回显还说成功）

```
node cli/mm-cli.js clone <项目> <源id> <新父id> [--deep] [--repoint-items] [--json] [--dry-run]
```

### apply

按操作清单**一次事务**生效：一批改动在同一个 rev / 一次原子写 / 一条变更日志里完成 ⇒ 全成或全不动；逐条回执（应用/跳过/失败）。**只允许数据面操作**（需要外部副作用的动作必须留在事务外）。支持 `--idem <键>` 重试安全

```
node cli/mm-cli.js apply <项目> --ops-file ops.json [--dry-run]
```

### batch

**一次进程跑多条命令**（W25 实测：一次典型任务 5777 ms → 950 ms，−83.6%）。payload 形如 `{"version":1,"calls":[["search","项目","词","--json"],["get","项目","id","--json"]]}`，也可只给裸数组；`--calls-file` 接受**文件路径或内联 JSON 文本**。语义：**逐条独立生效、失败不回滚** —— 第 3 条失败时前 2 条已在盘上（每条各自的写入仍是各自的一次原子写），回执逐条给 `code` 与 `stdout`/`stderr` ⇒ 调用方**只重试失败那几条**；要"全成或全不动"请用 `apply`。`dryRun` / `continueOnError` 写在 **payload 里**（`"dryRun":true` 只对认这个开关的命令注入 `--dry-run`）—— 命令行上**没有**这两个开关，理由见 `cli/commands/batch.js` 文件头。子调用走与单独执行**同一个入口**（`invokeSync`）⇒ 未知选项 / 别名 / 幂等守门照旧生效，批量化不是后门

```
node cli/mm-cli.js batch --calls-file calls.json [--json]
```

### item-add

新增**一条**条目（改一条不必重写整块 detail）。未条目化的节点会**自动条目化**（先把旧 detail 解析成条目，**且必须能逐字节回放**才动它）。--md 转 Markdown、--html 原样存（表格/代码块要用 --html）；同 type 同正文默认拒绝并点名，--force 放行

```
node cli/mm-cli.js item-add <项目> <节点id> --md "Markdown" | --html "HTML" [--src 出处] [--tags a,b] [--type text|rich] [--after itemId | --before itemId] [--force] [--dry-run]
```

### item-edit

改写**一条**条目（只动指定字段，回显**真的变了的字段名**）。--verified 必须同时给 --how（核验是三字段全必填的记录：at/by/how）

```
node cli/mm-cli.js item-edit <项目> <节点id> <itemId> [--md "Markdown" | --html "HTML"] [--src 出处 | --clear-src] [--tags a,b | --clear-tags] [--type text|rich] [--verified --how "怎么核的" | --clear-verified] [--dry-run]
```

### item-remove

删除**一条**条目。被 links[].item / assoc.members[].item 引用时**默认拒绝并逐个点名**，显式 --clean-links / --clean-assoc 才连带清理（不许静默删出悬挂引用）

```
node cli/mm-cli.js item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc] [--dry-run]
```

### item-move

把一条条目移到**另一个节点**（一次原子写同时重渲染两侧 detail）。目标节点必须已条目化；只调顺序请用 item-order

```
node cli/mm-cli.js item-move <项目> <节点id> <itemId> --to 目标节点id [--after itemId | --before itemId] [--dry-run]
```

### item-order

重排条目顺序（--ids 必须是该节点现有条目的**完整排列**；只重排、不增删）

```
node cli/mm-cli.js item-order <项目> <节点id> --ids i-a,i-b,… [--dry-run]
```

### render-detail

按 items 重新渲染 detail（**G2 判"detail 与 items 不一致"时的唯一修法**）。幂等：已一致 ⇒ 实际变化 0。只处理条目化节点（没有 items 的节点 detail 是真源，不碰）

```
node cli/mm-cli.js render-detail <项目> <节点id> | --all [--dry-run]
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
node cli/mm-cli.js ask-apply <项目> <id> --answer "回答" [--question "提问"] [--model 模型] [--at ISO时间] [--answer-file 路径] [--as-child] [--child-id id] [--json] [--dry-run]
```

### import-md

从 Markdown 导入节点（追加到 parent）。**第一个标题之前的正文（前导正文）不会丢**，落点由父节点决定：父节点**没有 `items`** ⇒ 前置进它的 `detail`（`前导 + \n + 原 detail`，原有内容一个字节都不覆盖）；父节点**有 `items`**（已条目化）⇒ 作为**首条条目**插进 `items[0]`，`detail` 随之按 `renderDetail(items)` 重建（条目化节点上 `detail` 是派生缓存，真源是 `items`）。父节点已是**坏数据**（`detail` 与 `renderDetail(items)` 不一致）或 `items` 不是数组时**响亮拒绝并给出两条真出路**（换父节点 / 先 `item-add` 再导），盘上零改动 —— 规则全文见 docs/ITEM-MODEL.md §2.1。**同一份来源默认只导一次**：本命令会给导入的子树的根写上 `origin`（来源路径 + 内容指纹，见 docs/DATA-FORMAT.md §2.8），再次导入同一 `src`+`sha256` 会**被拒并指名**上一次导到哪去了 —— 真的想要第二份就加 `--force`（那是有意的重复，不是手滑）。`--dry-run` 与真跑**同一份判据**（写盘前校验也一起跑：预览说能成 ⇒ 真跑必能成，真跑必失败 ⇒ 预览也必失败）。`--json`：机器可判的一份（`{ok,command,project,parent,nodes,themes,preamble,source,resourceRefs}`），与文本回档**同一份读数**；**两跑逐字节相同**（键序固定、无时间戳、无耗时、无绝对路径 —— 节点 id / 资源新文件名 / 试过的候选路径**不进**，它们的完整内容仍在文本回档里）

```
node cli/mm-cli.js import-md <项目> <md文件> [--parent id] [--force] [--dry-run] [--json]
```

### import-project

功能 5a：**从大文档建一个新项目 + 一棵新树**（md/txt/docx；PDF **有书签走书签、无书签自动回退文字层**，两样都没有才响亮拒绝）；1 级标题成为顶层主题；一次原子写入，失败不留半个项目；--dry-run 只预览格式/规模/前几个标题与来源、不写盘（并如实报"这份文档已经导过了"）；入参是**目录**或路径读不了时**响亮拒绝并给出路**；**同一份来源默认只导一次**（`origin.src`+`origin.sha256` 全库比对，重复会拒绝并指名是哪个项目导的）—— 真的想再建一棵就加 `--force`

```
node cli/mm-cli.js import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json] [--force]
```

### import-dir

批 5：**整库导入 —— 把一个文件夹的结构镜像成一棵树**（每一级子目录 = 一个容器节点，每个文件 = 该容器下的一个文件节点，标题取**文件名去扩展名**，文档自己的标题在它下面）。默认导 `.md/.txt/.docx/.pdf`（`--ext` 覆盖，只许写真的能导的扩展名）；隐藏文件/`.git`/`node_modules`/符号链接/空目录/无读权限/不支持的扩展名**一律跳过并逐类计数**（报告给"导入了 N 个文件 / 跳过 M 个（按原因分组）"，**不许静默**）；上限：合计 `MAX_SOURCE_MB`（与单文件闸门共用一份常量）+ 文件数 `--max-files`（默认 200），**超限在写盘之前响亮拒绝并给出路**；**一次原子写**，失败不留半个项目；`--dry-run` 只出报告、绝不写盘（并如实报超限与"这个目录已经导过了"）；**幂等**：项目根记**目录清单指纹**（同一个目录重复导 ⇒ **整体拒绝**并指名）、每个文件节点记自己的来源指纹（同一个文件被别的命令导过也拒绝）—— 确实要第二份就加 `--force`。【W12】**Obsidian 库直进**：目录里有 `.obsidian/`（或显式给 `--vault`）时多走一段**本地解析（零 LLM、零 token）** —— ① `[[页]]` / `[[页|别名]]` / `[[页#标题]]` 三类 wiki 链接接成**关联**：落点就是既有的 `links[]`（`{ project: <本次项目>, id: <目标节点> }`，带 `#标题` 时指到那篇笔记里**对应的标题节点**，`caption` 记原样写法与别名）；`![[图.png]]` 这类附件/图片嵌入走**既有资源管线**（与 `add-image` 同一处）。② frontmatter 的 `tags` / `tag`（含 `#a` 写法）落到**该笔记文件节点的 `tags`**（与 `--tags` 同一套标签机制），`aliases` / `alias` 参与**链接解析**（`[[别名]]` 能指到那篇笔记）。③ **断链 / 同名多篇 / 附件没落成**一律**逐条点名**（并入跳过清单），**绝不写悬空链接**。④ 附件目录 `assets/`、`attachments/` 按 P0 边界不导（附件本身属 P1）。`--no-vault` = **显式关掉**（库目录里也只想拿结构时用）⇒ 与从前**逐字节相同**。**不做**：笔记嵌入的正文合并（transclusion）、反向同步（本工程 → Obsidian）、daily notes 与插件语法；`[[页#^块引用]]` 这类认得出但转不了的按"逐条点名"处理。

```
node cli/mm-cli.js import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] [--max-files N] [--vault|--no-vault] [--dry-run] [--json] [--force]
```

### merge-project

**把若干个已有项目整棵并进一个已有项目**（唯一的跨项目"搬整棵树"入口；`move`/`clone` 都只收一个项目名，`import-*` 建的是新项目）。每个源项目成为目标里的**一个分组节点** —— 而且它就是**源项目的根节点本身**，只把 id 换成确定性的 `merge-<源项目名>`（全库 9 个项目的根 id 都是 `root`、根节点上只有 `{id,topic,expanded,children}`、且全库**没有任何** links/assoc/anchors 指向 `id==='root'`）⇒ 换这一个 id 不可能改指任何边。**其余每一个 id 一律逐字带走、绝不重签发**：id 是 `links[]` / `assoc.members[]` 的唯一键，重签发就是静默改指或改悬空（照 `clone --repoint-items` 的先例）。`origin` 逐字原样带走（溯源不重算）。`--parent` 缺省 `root`（每本书成为目标的一个顶层主题）。`--links`：默认 `keep` = 边一个字节都不改（源项目**默认保留** ⇒ 跨项目边不悬挂）；`repoint` = 把"指向本次也合并进来的源项目"的边改指到目标项目内**同 id** 的节点（根改指那个分组节点），**每一条都逐条核验**目标 id 在源里真实存在，任一条不过 ⇒ 整条命令拒绝并点名，**绝不按序号猜**。**幂等**：`merge-<源项目名>` 已存在且该源全部非根 id 都已在目标里 ⇒ 拒绝并指名上一次合并落到哪个节点（判定键不用 `origin.src+sha256`：合并的输入是一个项目而不是一份文件，而携带的 id 逐字相同，比指纹更硬）；**没有 `--force`**（再写一份必须重签发 471 个 id，那正是被禁止的）。**一次原子写**（全源都验过才动盘，失败不留半个合并）；`--dry-run` 与真跑**同一份判据**（同一个函数 + 同一份写盘前校验 ⇒ 预览说能成，真跑必能成）。**不合并** `data.assoc` / `data.bindings` / 未知节点字段 / `meta.formatVersion` 与目标不同的源 —— 一律**拒绝并点名**，绝不静默丢。**不删源项目**、也不提供删；撤销是一条既有命令：`remove <目标项目> <分组节点id>`。

```
node cli/mm-cli.js merge-project <目标项目> <源项目> [<源项目…>] [--parent <id>] [--links keep|repoint] [--group-id <id>] [--dry-run] [--json]
```

### export-md

导出为文件夹：<项目>.md + assets/ + attachments/（v0.16 起）。**读向导出**（给编辑器 / 人 / AI 读）—— 保证"读得懂、不静默丢"，**不保证** export-md → import-md 往返等价（往返与跨机迁移是 export-json 的职责）；本命令**不**为往返发明标记语法（那会变成第二份数据格式）。导出的不只是标题树：① 条目层 items[] 展开成该节点下的 `1.` 有序子列表，行尾括注 = 核验状态 · 出处 · 条目标签（**未核也显示**：只写"已核"的话，读者分不清"这条未核"与"这行丢了标注"）；② 节点 tags 作为行内 `#标签`；③ localPath 作为行内**路径原文** + 失效说明（它按契约是本机绝对路径 ⇒ 恒不在导出目录内，写成链接只会得到一个"点了没反应"的链接，反而说不清为什么打不开）；④ 有 items 的节点**不导** detail（它逐字节等于 renderDetail(items)，导两遍会让读者不知道哪份是真源）。`--with-detail` **只管** detail，上面四样一律不受它控制（它们是结构与标注，不是正文长文）。不导出（读向不需要，要全的用 export-json）：节点/条目 id、at/by、supersededBy、qa[] 原始结构、links[]、origin、expanded

```
node cli/mm-cli.js export-md <项目> <输出目录> [--format heading|list] [--with-detail]
```

### bind-sync

【R4】**绑定工作区文件夹 → 定时/有变化就同步进思维导图**（零 token：纯本地文件事件 + 字符串处理，**不经 LLM**）。形态：不带开关 ⇒ **同步一次**（增量：按 mtime/大小只处理变过的文件）；`--bind --dir <目录>` 新建一条绑定；`--pause` / `--resume` / `--unbind` 暂停/继续/解绑（**都只影响"要不要同步"，已导入的节点一个都不动**）；`--list` 只看状态。**三条纪律**：① **界面有未保存编辑 ⇒ 本轮一个字节都不写**（回显报 `blocked-dirty`，下一轮自己再来 —— 否则你保存时会撞冲突）；② **删除/改名只产出"待确认"提议，绝不自动删节点**（改名 = 新增 + 提议删旧）；③ **转不了的文件逐条点名**进"未转换"清单（不静默跳过、也不拖垮同一批里别的文件）。**`--confirm-deletions` = 确认流**（排期第⑥步）：把**读得到的提议**逐条列出来（名字 / 来源文件 / 来源节点）并交给引擎那**一条既有**出口（`plan.confirmedNodeIds`）⇒ 只删被确认的那些；未确认之前**盘上一个节点都不少**。是一条 fail-closed 的路：目录读不到 / 旁路快照读不出来 / 提议里读不到对应节点 ⇒ **响亮拒绝**，一个节点都不删（读不到就不猜）；没有提议时是**幂等空转**（不报错，但它说清楚"一个都没删"）。导入复用**同一条**既有管线（`import-dir` 的 `docToOutline` + `markdownToTree` + 资源引用解析），本命令不写第二套转换。扫描快照落在**旁路文件** `<项目目录>/.bindings.json`（可随时删；丢了会从树里的 `origin` 重建，不会重复建节点）—— **不进项目数据**，所以守护进程不会把项目 JSON 搅脏；`--forget-snapshot` 那道"丢掉重来"同理（重读全部文件、按 `origin` 接回各文件的节点；代价是快照里那些"待确认"的提议一起没了）。**一个文件在树里最多一个节点**：快照丢了、或者"提议删过的文件又回来"时，计划先问一句"树里已经有它的节点了吗"（判据 = 快照里那条提议点过名的 `nodeId`，或树里 `origin.src` 现算出的那份对应关系）⇒ 认得出就**就地更新**（读数是每行的 `reconnected` / `reconnectedList`），认不出才当新增；文件回来时那条提议随之**撤回**（前提"盘上没了"已经不成立），不必等确认、也绝不会先多一个同名节点。事件驱动由主进程守护（`fs.watch` 递归 + 防抖 + 低频巡检兜底），应用开着才守护

```
node cli/mm-cli.js bind-sync <项目> [--bind --dir <目录> --mode flat|mirror --include <模式,…> --ignore <模式,…> --ext <扩展名,…> --debounce <毫秒> --id <绑定id>] [--binding <绑定id>] [--pause|--resume|--unbind|--list] [--watch-dirs] [--forget-snapshot] [--confirm-deletions] [--json] [--dry-run]
```

### learn-path

【LP】**学习链路**：把若干本已入库的书（或若干份有树 + 正文的资料/经验）排成**一条有序的链路**，落成一个**新项目**（`projects/<--out>/`）：步骤顺序 = `children` 顺序，每步的 `links[]` 指回原书节点，`detail` 里写着"为什么排在这"。**输入只读**（生成前后对输入项目逐字节对拍，任一字节不同即响亮失败）。**有序从哪来**（封闭四档，写在每步的 `why.kind` 里）：`chapter-order` 书内章序（权威）、`explicit-prereq` 人工标注的显式前置（权威：`links[].caption` 以「前置：」开头）、`term-affinity` 术语共现导航（**弱** —— 共现是对称的，只决定"下一步学谁"，**不宣布前置**）、`mechanical` 确定性兜底序（书序 → 书内序 → nodeId；**机械序，如实标注，不冒充推断**）。图只有两种边（书内骨架 + 显式前置）⇒ 共现/兜底**不可能造出环**；真成环时**响亮拒绝并逐条点名成环的边**（含声明处 `at`），**一条边都不静默丢**。`unresolvedEdges` 点名"指向非学习单元的显式前置"（未生效的前置绝不当没事）。`gaps` = **跳级读数**（这一步引用了路径外的知识点，按 outside-path / later / not-a-unit 三档计数）。**AI 预算**：单位 = **调用次数**（计数来自调用日志的**条数**，不是自报计数器），上界公式见 `src/learn-path.js` 的 `AI_BUDGET.maxCalls`；**本版是纯程序侧切片，maxCalls = 0、一次也不调模型**（AI 只留接口位）。`--order` 只影响**同分优先**（不覆盖章序与显式前置）；`--out` 缺省 `学习链路-<N>书`，已存在则拒绝（覆盖必须显式 `--force`）；`--limit` 只生成前 N 步（`truncated` 如实报）；`--json` 给全量报告（含 `sourceIntegrity` 与 `determinism.sha256` —— 同输入两次必须同一个值）。

```
node cli/mm-cli.js learn-path <项目…> [--out <新项目名>] [--order 项目,…] [--limit n] [--title 标题] [--force] [--json] [--dry-run]
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

从 aimap 单文件导入为新项目（解包图片）。`--json`：机器可判的一份（`{ok,command,project,nodes,images,files,assets,assoc,source}`，与文本回档**同一份读数**；`source` 只给文件名 + 内容指纹 ⇒ **不含绝对路径**）；**两跑逐字节相同**（键序固定、无时间戳、无耗时）。⚠️ 本命令**没有** `--dry-run`：它按设计走裸 `store.write`（见 docs/ARCHITECTURE.md §4b 的"接线边界"），中央短路拦不住 ⇒ 给那个开关只会得到一份"说没写、其实写了"的假报告；要看它会建成什么样，把 `AI_MINDMAP_PROJECTS_DIR` 指到临时目录先真导一次

```
node cli/mm-cli.js import-json <aimap.json> [--name 项目名] [--json]
```

### import-grade

【IG】导入分档读数（只读、零写盘）：每份 `origin` 源文件判 `clean`（与重放导入逐条全等）/`rewritten`（有节点在源文里找不到，逐条点名）/`grown`（导入后长过节点 ⇒ **不出分**：那时"本次导入的产物"没有边界）/`src-gone`/`unreadable`/`unknown-tool`，并给**可复算**的 precision / recall（**零模型**：对照组就是它自己）。**默认排除探针项目**（`it-probe-*` / `imp-probe-*` / `it-s<N>-`，并打印排除了几个），`--include-probe` 放回；`--only` / `--project` 锁扫描面；`--json` 带 `scope`（这份读数覆盖了谁）。**它是读数不是门禁**：退出码恒 0（除非命令自己出错），红/绿由别的判据管（与 `health` 同一档口径）。

```
node cli/mm-cli.js import-grade [<项目>] [--project 项目名] [--all] [--only 子串] [--limit n] [--include-probe] [--json]
```

### add-image

给节点添加图片（复制进 assets/）

```
node cli/mm-cli.js add-image <项目> <id> --file 图片 --caption 备注 [--source 出处] [--tags a,b] [--dry-run]
```

### remove-image

移除节点上的图片引用

```
node cli/mm-cli.js remove-image <项目> <id> <相对路径 assets/x.png> [--dry-run]
```

### assets

列出项目全部图片及 caption

```
node cli/mm-cli.js assets <项目> [--json]
```

### add-file

给节点添加附件文件（复制进 attachments/，md/pdf 可内预览）

```
node cli/mm-cli.js add-file <项目> <id> --file 附件 --caption 备注 [--source 出处] [--dry-run]
```

### remove-file

移除节点上的附件引用

```
node cli/mm-cli.js remove-file <项目> <id> <相对路径 attachments/x.md> [--dry-run]
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

### draft-map

把一棵树（`{topic, detail?, children?}`，也接受内联 JSON 文本）送进一个**临时导图小窗**：置顶、按内容定窗口大小、**不落 projects/**、关窗即弃；人在窗口里决定「并入主导图（选落点）」或「丢弃」。并入 = CLI `apply` 一次原子写 + 回读，且同指纹**幂等**拒绝（⚠️ 与 `sidebar-only` 同一族：**无回执即报错**，界面没在跑就非 0 退出）

```
node cli/mm-cli.js draft-map --file <树.json> [--source 说明] [--json]
```

### point

**指给你看**（`AP`）：让正在运行的界面做一件**只读视图动作** —— `--mode note`（默认）= 打开那篇笔记（选中 + 展开祖先链 + 详情框显示它）；`--mode related` = 打开它的关联视图（高亮本节点与关联节点、其余虚化、视口缩放到框住）。⚠️ 只作用于界面**当前打开的那个项目**：项目不符会被界面**拒绝并点名两个项目名**（本命令不切项目：切项目会丢界面上未保存的编辑）；**无回执即报错**（界面没在跑就非 0 退出）；**零写盘**（不读 projects/**、不调 mutate/write，界面侧调的是不写盘的两个渲染层函数）

```
node cli/mm-cli.js point <项目> <节点id> [--mode note|related] [--json]
```

### link

添加跨项目链接（`--item` ⇒ 边指向**目标节点里的某一条条目**，即 `{project,id,item}`）。**重复添加同一条边**（同项目/同目标/同条目）分三种结局，回显可分辨：省略 --caption/--item ⇒ **保留**原有值（幂等，回显「无变化」且不写盘）；显式给新值 ⇒ **覆盖**（回显「已更新链接」并写出 旧 → 新）；显式 `--caption ""` / `--item ""` ⇒ **清空**那一层（回显「已更新链接（caption 清空 / item 清空）」）。⚠️ 只写 `--caption` / `--item` 不给值会被**响亮拒绝**；目标节点在、但 `--item` 那条条目不在 ⇒ **拒绝并点名**（绝不造出"节点在、条目不在"的悬挂引用）。⚠️ **人手里敲不出"显式空串"**：PowerShell 会把裸 `""` 从 argv 里**抹掉** ⇒ `--caption ""` / `--item ""` 根本到不了命令（实测：argv 里只剩 `--caption` / `--item`，被解析成 `true`，随后被上面那条**响亮拒绝**）。要清空请用**等号形式** `--caption=` / `--item=`（PowerShell 里**加引号没用** —— 实测 `""` 同样被抹掉）。这是**外壳**（shell）的行为，**不是**本命令的行为：命令本身照旧支持"显式空串 = 清空"

```
node cli/mm-cli.js link <项目> <id> --to 目标项目 --id 目标id [--item 目标条目id] [--caption 说明] [--dry-run]
```

### unlink

移除跨项目链接（指向该目标的边一律移除，含条目级的）

```
node cli/mm-cli.js unlink <项目> <id> --to 目标项目 --id 目标id [--dry-run]
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

### contents

概念目录（`CC`）：把树聚合成**按书内出现顺序**排的概念清单（同名合并、每条带落点 id 与路径），可 `--apply` 一键补成「概念索引」分支（挂在 `--parent` 下，缺省 root；**幂等**，重复跑就地更新、清单没变则一个字节都不写）。「概念」的判据可复算：概念名 = 标题去章节号前缀（`1.1 收包` → `收包`，`802.11` 这类不会被误吃）· 同名（大小写折叠）合并 · `count` = 落点数 + 正文提及数，**提及与 `mentions` 共用同一份命中计算**（`src/mentions.js` 的 `findMentions`）；纯分组容器（无正文/无标签/无链接但有子节点）不算概念。`--parent` 限定作用域子树、`--depth N` 限定层数、`--min-count N` 只留出现 N 次以上的概念。**它不从 `tags` 派生**：标签是跨书共享的 39 词受控词表（`docs/TAGS.md`），本书的概念数是数百个 —— 两者粒度与范围都不同，`tags` 只作为附加列随每条概念带出

```
node cli/mm-cli.js contents <项目> [--json] [--depth N] [--parent <id>] [--min-count N] [--apply] [--dry-run]
```

### assoc-list

列出关联笔记（--node 看该节点**所属**的与**锚在**它的；--raw 附带原始实体）

```
node cli/mm-cli.js assoc-list <项目> [--node <id>] [--json] [--raw]
```

### assoc-add

新增关联笔记（成员 ≥2 **或** 锚点 ≥1；跨项目写 项目/节点id；锚点语法 `#tag:工具` / `项目/节点id#text:关键词` / `项目/节点id#item:条目id`）

```
node cli/mm-cli.js assoc-add <项目> --members a,b,c | --anchor "项目/节点id#text:关键词" [--anchor …] [--title 标题] [--note html | --note-md markdown] [--id id] [--force] [--dry-run]
```

### assoc-edit

修改关联笔记的标题/成员/锚点/笔记内容

```
node cli/mm-cli.js assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c] [--anchor …] [--clear-anchors] [--dry-run]
```

### assoc-remove

删除关联笔记

```
node cli/mm-cli.js assoc-remove <项目> <assocId> [--dry-run]
```

### assoc-prune

清理关联里已不存在的成员（修好悬挂成员导致的校验红）；**锚点只报不剪**

```
node cli/mm-cli.js assoc-prune <项目> [--nodes a,b] [--dry-run]
```

### validate

校验项目数据格式（含悬挂链接与悬挂关联成员）；--anchors 额外判"笔记锚点失效"（默认不判：它是写盘闸门，弱判据判红会让项目变只读）

```
node cli/mm-cli.js validate <项目|json文件> [--json] [--anchors]
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

### timeline

时间线（只读，`TL`／台账 `W2`）：**哪些笔记最近被改过**，按时间新→旧。不给项目名 ⇒ 全库（与 `changes` 同一形态）。时间来源 = 变更日志（`.changes.jsonl`，唯一写盘出口顺带产生）：窗口内出现过的节点给**精确**时间（`atSource:"changes"`）、没出现的只知"**早于**窗口起点"（`before-window`，给上界不给假时间）、本项目没有日志则 `unknown` —— 三档**都可分辨**，且 `summary` 逐档计数（"时间未知"绝不静默消失）。⚠ 节点上没有 `updatedAt` 这类字段（`src/schema.js` 的契约表 15 项里没有），`origin.at` 是**导入**时刻、不是改动时刻 ⇒ 只作 `importedAt` 信息列，不参与排序与判定。排序 = `at` 降序 → 项目名升序 → nodeId 升序（`(项目,nodeId)` 全库唯一 ⇒ **同时间戳也有唯一答案**）。`--since` 收绝对时间或相对时长（`m`/`h`/`d`/`w`）；**相对时长必须配 `--now <ISO>`**（不读墙钟：读墙钟会让两跑结果不同）。`--limit 0` = 不截断

```
node cli/mm-cli.js timeline [<项目>] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit n] [--json]
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

从 registry 重生成 docs/CLI.md。`--check`：**只比对、绝不写盘** —— 一致 ⇒ exit 0，不一致 ⇒ exit 1 并点名**哪一份生成物、第几行起**不一致（报错形状同 `G6`，含"磁盘这一行 / 应为这一行"与 fix 命令）。`--json`：固定键序的结构化报告（`{ok,mismatchCount,products[]}`，无时间戳 ⇒ 同一状态两跑逐字节相同）。**写盘档与比对档共用同一个渲染函数**（`renderCliDoc`）⇒ 两个方向不可能各自漂移。⚠️ **能力边界**：本命令只负责**它自己产的那一份**（`docs/CLI.md`）；`docs/VERIFY.md` 与 `ARCHITECTURE.md` §5 登记表由 `scripts/` 侧生成，而 `cli/` 不许 require `scripts/`（`S1`）⇒ 那两份的新鲜度归 `G7` / `G8` 第 ⑬ 条，本命令**不假装覆盖**（否则报错里的 fix 指针会骗人）

```
node cli/mm-cli.js docs-gen [--check] [--json]
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

### features

产品功能名册（只读）：从 `docs/FEATURES.md` §3 的**唯一权威表**现算「代号 ↔ 中文名 ↔ 承载命令」—— 答「这个功能现在什么状态」与「这个代号指什么」，不必读整节名册（`W18` 量过它的阅读成本）。`--grep` 在**三处联合搜**（代号 / 中文名 / 该行提到的 CLI 命令名 —— 即 `GAP-4` 的三向互查）；**0 命中会响亮列出搜过的三处**并不静默返回空（exit 0，与 `changelog --grep` / `dsh-caps --grep` 同口径）。`--code` 精确取一行（取不到 exit 1 —— 检索与精确取行是两种语义）。另给**两个差集**（本命令最有价值的输出）：名册按"命令调用形态"提到而 `registry` 里没有的命令 / `registry` 有而名册任何一行都没提的命令（后者 = "一条命令回不到任何功能代号"）。零写盘（不记热度、不进 `WRITE_COMMANDS`），`--json` 两跑逐字节相同（键序固定、排序码点序、不读时钟）

```
node cli/mm-cli.js features [--grep <词>] [--code <代号>] [--json]
```

### dsh-caps

DSH 能力边界（只读）：从 vendor/dsh 的装配清单 + 磁盘包目录机械读取「挂了什么/有什么」—— 防止为"其实已经有"的能力写新命令或装新插件。⚠️ 两条最易误判：host 平面 disabled:true ≠ 不可用；装配文件里没有 ≠ 不具备（包可能就在磁盘上、只是当前没挂）

```
node cli/mm-cli.js dsh-caps [--json] [--grep 关键词] [--unmounted]
```
