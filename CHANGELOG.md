# CHANGELOG — AI MindMap（原 NetworkMindMap）


<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 记录
作用: 变更轨迹（`[Unreleased]` + 最近 3 个已发版本段）
不该写: —
更新方式: 每次变更必写；更老的版本段由 `release` 滚动归档
-->

> 约定：每次功能/数据格式变更先记在 `[Unreleased]`，发版时用
> `node cli/mm-cli.js release [版本号]` 移到版本段并重建 Unreleased。
> README.md 版本锁同步更新（release 命令自动完成）。

## [Unreleased]

### 写入类命令统一 `--dry-run`：写前可审，报告与真跑同源（W8，2026-10-13）

- **所有会改盘的命令都支持 `--dry-run`**（写命令 **34 条**；支持集 `cli/core.js` 的 `DRY_RUN_COMMANDS` 是**唯一登记处**，registry 的选项白名单由它现取 ⇒ 两处不许各写一份）：跑完**盘上逐字节零变化**（项目目录整棵树：`assets/`、`.changes.jsonl` 与 `mtime` 全不变，`.visits/` 埋点也不多一条 —— "不写盘"包含"不记账"）；报告**给出将改的对象与数量**（`这次写盘将改动 N 个对象：<类型>:<id>、…`，可机械解析，个数 == 清单条数）；且 **⭐ 报告与真跑结果一致** —— 两侧由**同一个函数、同一对输入**算出来（`src/concurrency.js` 的 `changedKeys`；dry-run 侧入口是 `cli/core.js` 的 `planWrite`）⇒ 22 条命令的报告清单与真跑后 `.changes.jsonl` 末条的 `changed` **逐字相等**（不是"都非空"的弱口径）；**判据也与真跑同一套**（语义去重命中时 `--dry-run` 与真跑同样 exit 1、报文逐字相同 ⇒ 不存在"预览说能写、真跑被拒"的落差）。
- **不认这个开关的命令响亮拒绝并给出路**：`--dry-run=false` 与不适用者（**唯一一条** `import-json` —— 会改盘但建**新项目**、资源解包**不走写管道**，给了只会得到假报告）⇒ 当场 exit 1 并**点名原因**；只读命令（`read` 及别名 `tree`）⇒ 说明"只对**会改盘的命令**有意义"并**指回 `DRY_RUN_COMMANDS`**（不许含糊成"未知选项"）。
- **机制全在一处**：`ctx.write` / `ctx.mutate` 两条写出口**各一处短路**，物理副作用读**同一个 `ctx.dryRun`**（唯一读取点）；命令层**不出现** `args.dryRun`（静态把守：命令层扫描 + 支持集 ↔ registry 双向比对 + 行首标记只在 `cli/core.js`）。
- **MCP 面只加参数、不新增工具**：**29 个工具**带 `dry_run`（schema 注入与 `--dry-run` 转发**共用同一张表** `DRY_RUN_TOOL_CMD`），工具数**仍是 51**；`import_json` **不给**这个参数（它建新项目、不走写管道）。
- **判据**：`tests/w8-dry-run.test.js` **24 条**（vitest 实跑 24 passed，进程内临时沙箱；含**注入证明** —— 让 dry-run 偷偷写盘 ⇒ `A1` / `C1` 两条断言必红）+ 集成新增 **10 条**（W8 段，探针 `it-probe-w8-*` 自带收尾）；集成断言 **468 → 478**（`docs/VERIFY.md` 由 `doc-facts --write` 同步）。
- **边界如实**：`render-detail` 的**计划**报"0 个对象"（`detail` 是 `items` 的派生缓存，不进变更日志口径）而命令自己的**领域计数**报"实际变化 1" —— 两条读数各说一个维度、都如实，真跑日志同为 `[]`；会**现摇新 id** 的命令（`add` / `clone` / `item-add`）改用"按对象类型的计数"比对报告与日志（与随机无关的那一半必须完全准）。

### `search-all` 跨项目检索：一次扫全库、命中带项目前缀（W1，2026-10-13）

- **新增命令 `search-all <关键词>`**：一次调用扫**全部项目**，每条命中都带 `project` 前缀 ⇒ 不必先知道项目名，也不必逐个 `search` 再把结果拼起来。命中分片与 `search <该项目>` **逐条同序**（同源排序，命令层不重排）；`--scope a,b` 只扫点名的那几个项目（回显 `scoped=true`，`scanned` 与命中**双向收窄**），点名的项目不存在、或名单为空 ⇒ **响亮拒绝**（不静默退化成"其实全库都扫了"）。
- **两条硬上限，越限响亮报错、绝不截断**：命中总数 `2000` 条、扫描耗时 `3000ms`（唯一定义处 `src/item-index.js`）。越限 ⇒ 非 0 退出 + **点名上限与本次读数** + 给出路；**不返回**一份"看着正常"的截断榜单 —— "少给几条"是静默失败，比报错更坏。
- **某个项目读不出来 ⇒ 跳过它，但逐个点名**：文本档打「⚠ 跳过项目「X」」+ 出路（`validate X` / `--scope` 收窄），JSON 档进 `skipped[]` 且**不出现在 `scanned` 里**（两处对账看得见"少扫了谁"）。**绝不静默少扫**。
- **MCP 同名工具透传，不新增工具**：`search_nodes` 的 `project` 变**可选**（少给 = 全库档）+ 新增 `scope`；MCP 工具数**仍是 51**。
- **判据**：`tests/search-all.test.js` **26 条**（vitest 实跑 26 passed，进程内临时沙箱，含可重复执行的判别力注入）+ 集成新增 **8 条**（W1 段，探针 `it-probe-w1-*` 自带收尾）。

### 冒烟剪贴板判据加「严格档」`MM_SMOKE_CLIP_STRICT`（默认关，2026-10-13）

- **补的是已知盲区**：域 39 的剪贴板判据是三态（环境探针**不可用** ⇒ 响亮"未验证"、不计入通过/总数；探针可用而**没写进去** ⇒ 判红；可用且写进去 ⇒ 通过）—— 三态修掉了"环境问题冒充产品缺陷"，但同时开了个口子：**环境坏时"我们没写进去"根本采不到真值** ⇒ 产品真回归被**降级成"未验证"**，在 CI / 受控环境里等于**悄悄放过**。新增开关 `MM_SMOKE_CLIP_STRICT`：**默认关**（关着一个字节都不变）；开时「未验证」**按失败计**（进 `failed` 与 `total`、汇总多打一行读数、`exit≠0`），每条"未验证"**仍如实打印、仍点名原因**。
- **非法值响亮报错**：未设 / `0` / `false` ⇒ 关；`1` / `true` / 空串（裸写）⇒ 开；**别的值当场拒绝**（`SMOKE STRICT FLAG ERROR` + 非 0 退出，**一条断言都不跑**）—— 不静默落回某一档。语义解析（`scripts/smoke-assertions.js` 的 `parseStrictEnv`）与计数（同文件 `tally(results,{strict})`）**各只有一处实现**，`main.js` 的 `runSmoke` 只做接线。
- **判据**：默认档与加开关之前的读数**逐字节相同**（7 条总结行相同；raw 差异 22 行全属 6 类必变 token、0 行无法归类；归一化 SHA-256 相同）；**注入证明**：把 `tally()` 里那一行 `if (strict) failed++` 摘掉 ⇒ 同一跑**退出码回到 0** 而报文明说 `exit=1` ⇒ 判据的接缝就是那一行；还原后 SHA-256 逐字节相同、复绿。冒烟断言数仍 **219**（不动判据本身）。
- **边界如实**：**严格档 + 真实坏环境未采到**（本机剪贴板现在是好的，域 39 走"探针可用"档）⇒ 开档读数全部为**打桩**；`smoke-frame.json` 未接严格档字段；文档里 **0 处** `MM_SMOKE_*` 登记。

### 克隆不再静默丢字段 + 给这个形态补机械判据（2026-10-12）

- **修**：`cli/commands/edit.js` 的 `clone`（以及 `apply` 的 clone op）原先各自**手挑字段**做深拷贝（漏 `items`/`detailMode`，还漏早已发货的 `localPath`/`origin`）⇒ 克隆一个条目化节点会**把条目层静默退回 v2**，而 `validate` 照样通过（**无门禁、不可逆、事后极难发现**）。这是本工程**同一形态第 5 次**（qa → localPath → origin → 界面 items/detailMode → clone）。现在两份深拷贝合成**唯一实现** `cloneNode`：字段表逐行对齐契约，**只增字段 + 只在有值时写**（不含这些字段的旧数据克隆结果与从前**逐字节相同**）；`items` 整块搬运但**条目 id 重新签发**（否则撞"条目 id 全项目唯一"，实测会被写盘闸门拒）。
- **判据（本条的真正价值）**：`src/schema.js` 里落了一份**契约字段表**（`NODE_FIELDS`，required 4 / optional 11）+ 纯函数 `analyzeCloneFieldCopy(src)`（`require` 零副作用、可单测）；集成里新增一条静态判据"**节点复制写回的字段清单必须覆盖契约节点字段**（漏一个 = 克隆时静默抹掉）"，并且**把界面那条同类判据的字段清单也换成同一份来源**（一份清单两处用，不再各写一份）。四档判定可分：`missing`（契约有而代码不写）/`drift`（表与代码对不上）/`unknown`（写了契约外字段）/锚点缺失 ⇒ 缺 = 全表（不许把"定位失败"当通过）。
- **判别力证明**：把 `cloneNode` 里 `items` 的加注与赋值两处去掉 ⇒ 该判据 **FAIL** 且报文点名 `items`，行为级断言同时必红；还原后 **SHA-256 与注入前逐字节相同** ⇒ 复绿。
- **顺带修的既有判据缺陷**：`scripts/docs-registry-check.js` 第 ⑪ 条原把"字段名在 `src/schema.js` 里出现过"当成"schema 校验了它"，于是纯数据表里的 `background` 会让它报红并**建议把分类改成 true —— 那会让清单说谎**；改成"**真被校验 = schema 真的读了 `node.<名>`**"。
- **读数**：单测 **1385/1385**、集成 **427/427**（以实跑为准）、`validate-all` exit 0、`rules-consistency` exit 0。

### MCP：`item_remove` 恢复 `--json` 透传（返回形状**有意变化**，2026-10-12）

- **修**：`item_remove` 从前**不传 `--json`**，唯一原因是带 `--clean-links/--clean-assoc` 时 CLI 会**先打一行文本再打 JSON**（stdout 成"半截 JSON"）。该缺陷已修（`cli/commands/item.js`：清理结果进 `cleaned`，`--json` 下 stdout 只有一份 JSON）。
- **因此这条例外取消**：`item_remove` 现在与其他五个 `item_*` 透传**一致**地传 `--json`；返回从"一行中文文本"变成 **JSON 对象**（`{ok,project,nodeId,itemId,items}`，真清理时多 `cleaned:{links:[…],assoc:{…}}`）—— 这是**有意的形状变化**（"连带清了哪几条引用"从此是结构化的，不再只能字符串匹配），与前批"只增参数、不改既有参数语义"不冲突，但**形状确实变了，故单列**。
- **同批反转的"守旧说法"**：`scripts/mcp-server.js` 三处都改成新口径 —— 工具清单头注释、`case 'item_remove'`、以及**工具描述正文**（模型实际读到的那段，改前它断言"回显是文本（点名 itemId），不带 `--json`"）；`docs/ITEM-MODEL.md` §3.2 的 `item-remove` 行补上此前**缺失的 `--json` 形状**（同表 `item-add`/`item-edit`/`render-detail` 都有）。
- **判据**：`tests/item-commands.test.js` 新增 `S2-L` 四条（端到端 `JSON.parse` 成功 · 文本档逐字 · **假 ctx 结构判据**（JSON 档 `calls.out === []`，附文本档对照组防空转）· 注入证明两轮 + sha256 逐字节还原）；`tests/mcp-protocol.test.js` 12/12；真端到端探针（进程内 `tools/call` + 真 CLI 子进程）实读 `cleaned.links[0] = {node,target,caption,item}` ✓。

### 条目层 v3 · 界面侧：详情框「逐条」呈现 + 修掉"界面保存把整层条目静默抹掉"（S5，2026-10-12）

- **条目化节点上多出「逐条」呈现**（`renderer/app-detail-content.js` / `renderer/app-detail.js` / `renderer/style.css`）：详情框里给出**条目清单**（一条一行：序号/类型/正文摘要/id + 条目级标签、出处、核验「怎么核的」，右侧 ⧉ 复制 `节点id#条目id`），并在正文里给每条**贴归属** ⇒ 点一条即"清单行 + 正文那一段"同时高亮，`MM.showDetailItem(nodeId,itemId)` 供关联视图跳到具体条目。**正文只有一份**：渲染路径仍是 `dc.innerHTML = detail`（契约 `docs/ITEM-MODEL.md` §2/§12 点名给界面流的那句），正文里的条目分隔与序号由 CSS 生成内容画、**不往正文里塞元素**；把属性级装饰撤掉后正文逐字节等于 CLI 的 `detail`。归属用"两侧同一解析器 + `isEqualNode`"认领，**对不上就不贴**（只出清单、正文一字不动、原因进读数）。**未条目化节点一个字节都不加**（含"复用同一个跟随框"的真机路径）。**没有新增任何 IPC / 命令。**
- **修掉一个静默数据丢失**（同类先例：`qa` / `localPath` / `origin`）：`renderer/app-core.js` 的 `serializeTree()` 是手挑字段的整树写回，它不带 `items` / `detailMode`、且把 `meta.formatVersion` 写死 2 ⇒ 打开条目化项目后**按一次保存**（或 Ctrl+Z / 重做，同走快照）就把整层条目抹掉：节点退回 v2、`detail` 还在 ⇒ **没有任何门禁会红**，条目级 id / src / verified / tags 永久丢失。现在 `items`（含空数组与 `_container` / `_groupStart` 等下划线键）与 `detailMode` **原样平铺**，`formatVersion` **继承载入时那一份**（载入时没有 ⇒ 2，不凭空造 3），只在有值时写 ⇒ v2 项目与旧文件**逐字节零差异**。
- **判据**：冒烟域 `scripts/smoke/39-item-detail.js`（8 条；探针项目 `smoke-item-39` 自建自删，冒烟沙箱副本内，真实 `projects/` 零写入）⇒ 单域跑 **16/16 passed**（含预热域 01）。**注入证明**：去掉 `renderer/app-core.js` 的 `walk()` 里 `out.items` / `out.detailMode` 两行 ⇒ **13/16、exit 1**，断言⑤⑥⑦ 必红（报文见交付记录），还原后 **sha256 逐字节还原**（`4A6BFC9E…DBC63`）并复绿。**边界**：三方合并入口未覆盖（补法照 `scripts/smoke/15-write-conflict.js` 的手法）。

### 关系与标签升层（S6，2026-10-12）

- **`link` 支持 `--item <条目id>`**：边可以精确指向**目标节点里的某一条条目**（`links[].item`，契约 §7）；目标节点在、但那条条目不在 ⇒ **拒绝并点名**（绝不造出"节点在、条目不在"的悬挂引用）；`link --item ""` 与服务 K8 定的 `--caption ""` 是**同一套"显式空串才清空"** 与三态回显（`已添加链接` / `已更新链接` / `无变化`），**未新增** `--clear-item` 之类开关。
- **`links-prune` 把"节点还在、条目已被删"与"节点整个不在了"用同一处判据抓出来，并在报告里分开点名**，新增 `--items 节点id#条目id` 精确档。顺带修掉一处**静默空转**：原 `--nodes` 谓词拿**源**项目名比**目标**项目名 ⇒ 恒不等、永远不命中，而回显照样说"没有需要清理的链接"。
- **读口只增字段**：`links` / `backlinks` / `related` 里条目级的边多 `item` / `itemLabel`，**节点级的边一个键都不多**（v2 数据与渲染层零改动）。判定只有一处实现：`src/relations.js` 的 `refState()` / `targetHasItem()`。
- **判据**：`tests/link-item.test.js` 35 条 + 既有 7 个测试文件 **204/204** 全绿；集成 **§51 九条**；依赖方向 `node scripts/dep-direction-check.js` ⇒ 124 条边全朝下（或同层）。

### 条目层 v3 · 复校与体检：`recheck` / `health`（S4，2026-10-12）

- **新增 `recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json]`**：条目级的"再核一遍" —— 逐条判「这件出处在今天还成不成立」，输出**三类**（`ok` / `needs-recheck` / `src-gone`）+ 原因分布（`no-src`/`src-gone`/`quote-missing`/`line-out-of-range`/`file-changed`/`unverifiable-url`/`unverifiable-command`/`unrecognized-src`/`unverified`/`superseded-unknown`），**逐条点名**（节点 + `itemId` + 出处）并给**可执行的下一步**（改 `--src` / 补出处 / 写核验 / 清悬挂，每条都是能直接粘的命令）。**只读是默认**（一次盘都不写，连 `.changes.jsonl` 也不动）；确认后用 `--write-verified --how "读了 src 指向的源码行"` 写回 `verified{at,by,how}`（三字段全必填 —— 取不到 `how` **就不写**，空核验记录会让"已核"永远为真）：默认只给"**出处这一维判得过**"的条目写（判据刻意不是"当前是绿的"—— 迁移刚落地时 `ok` 恒为 0，那样批量写回永远无事可做）；出处失效/引文找不到/行号漂移/源已改/无出处/不可机核的一律**不写并逐条点名原因**，要写用 `--only` 点名（`src-gone` 的还要 `--force`）；写回**只动 `verified`**（`detail` 逐字节不变、一次原子写、日志只多 1 条）。`--dry-run` 出计划不写盘。
- **新增 `health [<项目>] [--project 项目名] [--all] [--root 目录] [--json]`**：条目层健康度的**真值出口**（契约 §11：迁移规模一类数字**不写进文档**）。报：条目化节点数/总节点数（富文本 / v2 分档）、条目数（按 `type`）、无出处·未核·需复核·出处失效·核验后源文件改过·被取代·**最后核验时间**、`items ↔ detail` **不一致的节点逐节点点名**（+ 修法 `render-detail`）、**悬挂引用**（`links[].item` / `assoc.members[].item` / `supersededBy` 逐处点名）、**`qa` 残留**（条目化节点上仍有 `qa[]`）与 `detailMode` 残留、以及迁移（契约 §6）的**五档**（可迁移 / 已条目化 / 无内容 / 不在范围 / **跳过**）—— 跳过项**逐节点点名 + 原因分布**（"回放不了"不许伪装成"没有要迁的"）。**是读数不是门禁**（有红项仍 exit 0；红绿由 G2 的 `validate-all` 判）；**确定性**（同状态连跑两次 `--json` **逐字节相同**、不带运行时刻 —— 契约 §10 AC14）。不给项目名 = **整个库**（按项目名排序 + 合计；读不了的项目如实进 `unreadable` 且**不计入合计** —— "没有"与"读不到"不是一回事）。
- **实现落点**：新增 `src/item-src.js`（**"出处"这一维的唯一实现处**：归一化 / 解析 `file:line`·`file:line::引文`·URL·命令 / "过期"判定；读盘按绝对路径 memo ⇒ 同一次运行里同一个文件**只读一次**）、`cli/commands/recheck.js`（条目层复校判定的**唯一实现处**：`health` 直接复用它的 `scanProject()`，不重判一遍）、`cli/commands/health.js`（只做聚合与点名）。MCP 同步（见下）。
- **判据**：单测 `tests/recheck.test.js` 35 条全绿（含**注入证明** —— 改一个源文件 ⇒ `needs-recheck(file-changed)`；引文消失 ⇒ `src-gone(quote-missing)`；`health --json` 两次逐字节相同；`recheck` 跑完项目文件与 `.changes.jsonl` 都不变）；集成 §50 二十一条交 I 串行落盘。
- **MCP 面（契约 §4）**：`search_nodes` 增补 `item_level` / `src` / `verified` / `type` / `since` / `limit` / `max_bytes`（`tag` 的语义扩到**条目级**标签），`get_node` 加 `item`（按条目取回一条）；新增 `item_add` / `item_edit` / `item_remove` / `item_move` / `item_order` / `render_detail` 六个**透传**工具 —— **只增参数、不改既有参数语义与返回形状**，每个新参数都在工具描述里写明"是什么、对应哪个 `--xxx`"。工具数 **45 → 51**（`docs/VERIFY.md` 由 `doc-facts --write` 同步）。

### 修掉 `import-md` / `import-project` 导入时的图片/附件坏引用（W19，2026-10-12）

- **修**：两条命令从前把 md 里的资源行按**原样字符串**记进 `images[].file` / `files[].file`，而文件从没被复制进项目 ⇒ 悬空引用**静默落盘**（exit 0、回显不提、`assets/` 不存在，而 `validate` 照样通过 —— schema 只校验 `file` 是非空字符串）。现在：**能解析到** ⇒ 复制进 `projects/<项目>/assets|attachments/`（命名与图片格式规则同 `add-image` 那一条） + 引用改写为**项目内相对路径**；**已在项目内有效**（export-md 往返）⇒ 原样保留、不重复复制；**解析不到** ⇒ **拒绝整份导入**并逐条点名（节点 / 引用 / 原样路径 / 按序试过的路径）+ 三条出路，拒绝是**干净**的（判据在复制与写入之前：不建目录、不写盘、项目文件逐字节不变）；**非本地引用**（`https:` / `data:`）⇒ 不挂进 `images/files`（`file` 的规范是项目内相对路径，否则 GUI 会拼成`../projects/<项目>/https://…` 裂图），那一行**按正文**并入该节点 `detail` —— 不丢内容、不污染 `stats`。
- **实现（一处）**：`src/markdown.js` 的 `resolveImportRefs()`（+ 纯收集 `collectResourceRefs`、资源行语法的唯一写出 `resourceLine`），`import-md` 与 `import-project` 共用；命令层只放 `refBlockedError` / `printRefReport`；`--dry-run` 报 `resourceRefs` 明细并把坏引用计入 `wouldRefuse`。
- **判据**：`tests/import-refs.test.js` 29 条（含与 `add-image` 命名/格式白名单的**防漂移**断言、dry-run 零副作用、一处实现的源码级守卫）；集成 **§56 十一条**；**注入证明**：把 `resolveImportRefs` 打桩成旧行为 ⇒ 共用判据当场必红，复原后复绿。
- **边界（如实登记）**：`import-dir` 仍是老口径（解析器已备好 `onMissing:'detail'`，下一轮一行接入）；`--force` **不绕过**这道闸；复制先于 `ctx.write`（同 `add-image` 形状）⇒ 只在写盘那一步失败会留孤儿资源文件（无悬空引用），本批不做回滚。

### 条目层迁移（S1，2026-10-12）

- **新增 `migrate items <项目> [--dry-run] [--json]`**（v2 → v3）：只迁"能逐字节回放"的节点（`renderDetail(parseDetail(detail)) === detail`），回放不了就**整节点跳过 + 逐条点名**（不许"修一下再写"）；`qa[]` 收敛成 `type:'qa'` 条目后删掉 `qa` 键；**不写** `detailMode`；写盘**之前**自动 `export-json` 一份到`.review/<日期>-条目层迁移/`（**没有跳过备份的开关**）；`meta.formatVersion` → 3（`validate` 同时接受 2 与 3 ⇒ 回退可走通）；幂等（第二次 `changed:{nodes:0,items:0}`、文件逐字节不变）。同批：`src/schema.js` 的 G2 补条目层判据（`formatVersion` 2|3、`items` 形状、`items`↔`detail` 逐字节一致且判红给修法 `render-detail`、`items` ⇄ `detailMode`/`qa[]` 互斥、条目 id **全项目唯一**）；`src/concurrency.js` 按 §8 加三个指纹键（`node:` 在条目化节点上排除 `detail`/`items`、`items:` 有序 id 表、`item:<节点>#<条目>`）并让 `mergeTrees`**逐条目挑来源 + 当场重建 detail**。实测（真实项目副本）：卖点讨论 182/186 条目化（+1572 条）/ comnet 220/220（+1329 条），跳过项逐条点名，两次 `validate` 绿、`detail ≠ renderDetail(items)` 0 个。

### 条目层 · 条目级写原语（S2，2026-10-12）

- **新增 `item-add` / `item-edit` / `item-remove` / `item-move` / `item-order` / `render-detail` 六条命令**：改一条不必重写整块 detail。未条目化节点上 `item-add` 会**自动条目化**（且必须先通过**逐字节回放前置校验**，回放不了就拒绝、一个字节都不动）；`item-remove` 被 `links[].item` / `assoc.members[].item` 引用时**默认拒绝并逐个点名**（`--clean-links` / `--clean-assoc` 才连带清理）；一次 `item-move` 同时重渲染两侧 detail（一个 rev、一条日志）。单测 `tests/item-commands.test.js`。

### 条目层 v3 · 条目读与检索：`search` 默认搜条目 + `get --item` + `read --items`（S3，2026-10-12）

- **`search` 默认口径改为「搜条目」**（节点 topic ∪ 条目正文，契约 `docs/ITEM-MODEL.md` §3.4）：命中形状在 v2 之上**只增字段** —— `{id,topic,nodeId,nodeTopic,itemId,type,itemized,matchIn,snippet,src,verified,score}`，新增 `--topic-only` 作为回退开关（同时把"同一命中 `itemId` 为 null"钉成断言）；`--full` 保留 v2 的额外面（detail / 图片 caption / 节点级标签 / 链接说明）。新增过滤 `--tag`/`--src`/`--verified`/`--type`/`--since` 与预算 `--limit`/`--max-bytes`（缺省有界；`--json` 顶层加 `hitCount`/`truncated`/`mode`/`budget{bytes,estTokens,limit,maxBytes}`，超限**截断并给续取方式**）；**非法值当场报错**（含 `--verified`/`--type`/`--since` 写错 —— 它们以前会静默变成"0 命中"）；给定条目级过滤时不再返回未条目化节点与节点级命中（契约对 `--since` 明说的那条规矩，同批扩到另外三维）。
- **新增 `get --item <itemId>`**（单条条目视图：保真的 `html` / `qa`、`src` 归一成数组、真实 `path`；"条目不在该节点"⇒ **点名它实际属于哪个节点**）与 **`read --items <i-a,i-b>`**（只取这几条正文；任一 id 缺失 ⇒ **整体失败并逐个点名**，不给半份；与 `--brief`/`--skeleton`/`--subtree` 互斥）。`get` 对条目化节点额外带 `items` **摘要**（`{itemId,type,src,verified,at,bytes}`，不含正文）。`read --json` 的字节形状**不变**（节点视图不加 `items`；`qa` 字段在条目化节点上由 items 现场派生，形状与 v2 逐字段相同）。
- **实现落点**：新增 `src/item-index.js`（UMD 纯逻辑、**不落盘**：索引只在内存里建、可复用；命中长度/预算/token 口径的常量**只有这一处**），`src/query.js` 只做视图组装与兼容转发。`--limit`（缺省 200 / 上界 1000）与 `--max-bytes`（缺省 65536 / 16–4194304）。
- **判据**：单测 `tests/item-index.test.js` 44 条全绿（含 v2 口径兼容复刻、命中/视图键集逐字、`--max-bytes` 字节上界、只读不生成索引文件的静态守卫）；集成 §49 二十七条交 I 串行落盘。
- **实测（只读，真实项目）**：「已有功能与设计（154 条）」那条 16864 字符的节点里定位一条 —— 改前整块 detail **31035 B**（整节点 `get --json` 40910 B）⇒ 改后一次 search 单条 **302 B** + `get --item` **214 B** = **516 B**（**60.1x** / 对整节点 **79.3x**）。

### 写命令"重试安全"（幂等）+ 语义去重 + 新增 `apply` 事务（S7，2026-10-12）

- **写命令"重试安全"（幂等，S7）**：任何写命令都可带 `--idem <键>` —— 同键重放**不重复执行**并原样复述首次结果（回显含「幂等命中」），键落进 `projects/<项目>/.changes.jsonl` 的**可选字段** `idem`（照 `origin` 先例：**可选字段、不升 formatVersion**、不写进项目文件；键按项目各自判、不能跨命令复用、只读命令带它会被**响亮拒绝**）。`add` / `add-root` / `assoc-add` 另有**语义去重**（父 + 标题 + 内容指纹；命中**默认拒绝并点名那一条**，`--force` 放行有意重复）。新增 **`apply <项目> --ops-file ops.json [--dry-run]`**：一批改动在**一次 `ctx.mutate`**（一个 rev / 一次原子写 / 一条日志）内完成 ⇒ **全成或全不动**，逐条回执，任何一条非法（含人为注入的第 k 条）**整体不动并指名第 k 条**；**只允许数据面操作**（新增/编辑/移动/复制节点 + 关联增改），需要外部副作用或连带清理的动作（图片/附件/导入/`remove`）**不在事务里**、写到 ops 文件里会被**指名拒绝**。**边界（如实写明）**：命令失败**不记键**（重试会照常执行，这是有意的）；键活在**有界窗口**的日志里（滑出窗口即"忘了"，同键重放会再执行一次）；`--dry-run` 不查也不记键。

### 修掉 `link` 重复添加时**静默清掉已有说明**（K8，2026-10-12）

- **修**：同一条边第二次 `link` 若**不给** `--caption`，盘上 `links[]` 会从 `{"project":…,"id":…,"caption":"出自：…"}`
  变成 `{"project":…,"id":…}`（说明没了、无任何提示），而回显与第一次**逐字相同**（`已添加链接: …`）
  ⇒ **成功与覆盖不可分辨** ✗。根因：`cli/commands/links.js` 旧写法把那条边**从零重建**再 concat
  （"没给 `--caption`"与"没有 caption"在数据上不可区分）。新语义：**省略 = 保留原说明**（重复添加退化成幂等，
  且**不产生空写入**）；**显式给（含空串）= 覆盖**；回显分三种：`已添加链接` / `已更新链接`（清空时点明
  `caption 清空`）/ `无变化`。另：改说明只在**原对象**上改一个键（边上其它字段如 `note` 与数组顺序都不动）；
  只写 `--caption` 不给值 ⇒ **响亮拒绝**（旧写法会把 `true` 写进数据）。
- **判据**：`tests/link-caption.test.js` 13 条全过；**注入证明**（还原旧行为）⇒ 9 条红，撤销后 sha256 逐字节还原；
  端到端读数（临时项目根，真实 `projects/` 零写入）见 `.review/20261010-卖点与功能-常驻讨论/K8-复现与读数.md`。
- **文档**：`docs/DATA-FORMAT.md` 里"重跑 `link` 会整个替换该链接对象（`note` 被抹掉）"这句**已随本次修复改掉**
  （现在只改 `caption` 一个键）；`link` 的 `--caption` 一键说明同步写进 `cli/registry.js`。

### 修掉「第一个标题之前的正文会丢」（W14，2026-10-12）

- **修**：`src/markdown.js` 的 `markdownToTree` 在"还没有任何节点"时直接跳过正文行（`if (!cur) continue`）
  ⇒ 第一个标题**之前**的正文被**静默丢弃**（`import-project` / `import-md` / `import-dir` 三条路共有）。
  现在按段收进 `preamble` 交回调用方，落点**三条路统一** = **本次导入的父/文件节点的 `detail` 开头**：
  `import-project` → 根节点；`import-md` → `--parent` 节点（**前置**在原有 detail 之前，不覆盖）；
  `import-dir` → 各自的**文件节点**（与既有的"无标题兜底"**互斥** ⇒ 同一段内容不会被写两遍）。
  三条命令的**回显都点明落点**（静默落盘与静默丢弃同样不可查）。
- **判据**：单元 6 条（`tests/markdown.test.js` +5、`tests/doc-import.test.js` +1，含 `built.preambles` 逐文件计数）
  + 集成 §54 六条（含"前导正文在落盘文件里**只出现一处**"与负例"开头就是标题 ⇒ 不产生空字段"）；
  **注入证明**：还原旧行为 ⇒ 5 条里 4 条判红（第 5 条两版都成立，作负例对照），撤销后全绿。
- **边界**：前导区里的 `![图](…)` / `[附件](…)` 按**正文**处理（不当资源挂载）—— 导入资源的坏引用属 W19，另办。

### 冻结「条目层 v3」契约（F0，2026-10-12）

- **新增受管文档** `docs/ITEM-MODEL.md`（§5 登记为「**契约**」层）：条目形状（`formatVersion 3`）、
  `items` 真源 ↔ `detail` 派生缓存的**互斥规则**、CLI/MCP 签名表（`item-add`/`item-edit`/`item-remove`/
  `item-move`/`item-order`/`render-detail`/`migrate items` + `get --item`/`read --items`/`search` 条目级命中形状）、
  `src/item-model.js` 与 `--idem` 的模块签名、v2→v3 迁移规则、与既有字段的边界，以及 **§8 并发粒度**：
  新增三个指纹键 `node:<id>`（条目化节点上排除 `items`/`detail`）、`items:<id>`、`item:<节点id>#<条目id>`。
- **`docs/DATA-FORMAT.md`** 加一行指针（v3 契约不重复表述）；**`SKILL.md`** 加一行导航
  （G8 判定⑩「导航可达」机械要求"登记过的文档必须能从 `SKILL.md` 找到"）。
- **未实现任何代码**：契约先冻结，供并行流互不等待地编码；断言与迁移实测留给 S1 及后续流。

### 内置 DSH 新增第二种作业模式「迭代模式」+ 修掉一处会让多模式误报的门禁（2026-10-10）

- **新增**：`$presets.iterate`（标签「迭代模式」）—— 与既有的「aimindmap 模式」（**改笔记**）分工，它的人设是
  **改本工程本体**（代码/文档/数据/工具链）：单一真源先行（`SKILL.md` + `docs/AI-GUIDE.md`）、落盘规矩（**别用 PowerShell 写中文**）、
  数据面只走 CLI、**改完跑完整验证链才算完**、改文档要登记、远端被拦 ⇒ **只做本地提交**。
  **人设文本的唯一真源**依旧只有一处：`scripts/dsh-embedded-overrides.js` 的 `PRESETS`（渲染时写进生成块）；
  数据侧只写**差异**（`dsh-home\.embedded-overrides.json`）✓。**不设 `makeDefault`** ⇒ 默认模式仍是 aimindmap，
  免得把"改笔记"的日常会话默认变成"改代码"。
- **修**：**多模式会让 `overrides check` 必红**（误报）—— 旧形态是"**每个 preset 各一对横幅**"（渲染时首尾相接），
  而 `check` 天生只认**第一个**生成块 ⇒ 声明第二个模式时它报"iterate 不一致"，**即使文件完全正确** ✗。
  现在：**一个横幅对包住全部 preset 的声明**（"文件里有几个生成块"**恒等于 1**），`check` 判据 = 整个生成区与"现在重新生成"逐行一致。
  另加 **`--tag <patch 文件>`**（把任意候选 patch 按正式判据核一遍，便于排查"到底哪里不一致"）。
- **判据（现场读数）**：`overrides render` ✓ 写盘（自动备份）→ `overrides check` **exit 0**
  （`✓ permission.defaultPreset` + `✓ $presets（aimindmap ← standard, iterate ← standard）`）；
  patch 里 `BEGIN/END` **各 1 个**，两种模式的声明都在，`agent-preset-registry.default` 仍为 **aimindmap** ✓；
  单测 `tests/dsh-embedded-overrides.test.js` **26 条全过**（新增回归：多模式单块 + 幂等 + 手改可抓）。
  **生效核对**（人工，5 秒）：内置侧栏 → 新建任务 → 模式选择器里应看到「**迭代模式**」；
  ⚠️ **用户选择优先** —— 若你曾在界面里选过模式，部署默认对已选值不生效。
### 待做清单搬回工作产物区（2026-10-10 用户裁定）

- **决定**：`docs/BACKLOG.md`（2026-10-10 当天刚升格进来的待做台账）**撤回** —— 内容整体搬回
  `.review/20261010-卖点与功能-常驻讨论/待做清单.md`，`docs/BACKLOG.md` 删除。**理由**：这份清单是在"卖点×功能"讨论里
  长出来的**在飞工作稿**，按 `docs-for-ai` 的 D1/D3 应住在**工作产物区**（可整目录删、不进扫描、不登记）；
  "长期保留"进 `docs/` 的应该是**其中定案的那条结论**，不是整份清单 ✗。
- **同批撤掉的指针**（否则留死指针）：§5 登记表那一行 · `SKILL.md` 导航表那一格 · `docs/ROADMAP.md` 顶部指回行 ·
  `docs/RULES.md` 的 `G-19`/`G-20` 指路 —— 四处全部改指新位置。
- **留下的历史记录**：本文件下面那条「待做清单升格为 `docs/BACKLOG.md`」保留原文（它记录的是当时真实的动作），
  以本条为准 ✗（同一天内先升格、后撤回，两次决定都留痕）。

### 三条"最疼的"结构门禁：S1 单向依赖 / S2 连带清单 / S3 确定性产物（2026-10-10）

**一句话**：E6 分析稿 §3.1 甲类点名的那一类 **"约束存在、机械检查不存在"**（⚠️ 条目的头号成因），
挑出最疼的三条补上判定 —— 三条都挂进 `npm run verify`（链从 **11 步 → 14 步**，总预算仍 400s）。

| 门禁 | 守什么 | 上线档位 | 现场读数 |
|---|---|---|---|
| **S1** `dep-direction-check.js` | 单向依赖：`renderer → main/scripts → cli → src`，**反向边即红并指名 `A → B`**（分层图**唯一权威** = 该文件的 `LAYERS`；同层成环 / 图外依赖一并判） | **甲档**（上线即全绿） | 135 个第一方文件 / **101 条相对边零回边**；27 处动态 `require` 判不了方向 ⇒ **如实计数并打印**（不静默跳过） |
| **S2** `collateral-check.js` | "改动类型 → 连带处"的**单源表** + 从表里派生断言（已机制化的那几处**指过去复用**，不重做）：① MCP 派发到的每条命令必须存在 ② 每个冒烟域都必须在**断言注册面**里 ③ 表里"指过去复用"的门禁必须真挂在链上 ④ 双向闭包 | **甲档**（存量已补齐） | 45 条 MCP 派发命令全在 registry；37 个冒烟域登记率 **100%**（上线当场抓到并补齐 **11 处存量**漏登记 ✗）；表里引用的 7 个门禁全部已挂链 |
| **S3** `determinism-check.js` | 确定性产物：**真值比**产物必须"同一状态**连续两次**重算逐字节相同"（时钟 / 随机 / 顺序 / 工作区**四类扰动分开**判 ⇒ 差异来源可分类）；**允许不确定**产物必须在生成器里**点名标注**"非确定性、不得当真值"；自述是生成物却没进表的一律判红 | ⚠️ **乙档**（带**封闭欠账册**，不许一次修干净） | 真值比 **3** 个（`docs/CLI.md` / `docs/VERIFY.md` / §5 登记表）四类扰动下**逐字节相同**；允许不确定 **4** 个（`.review/verify-tests.json` · `.review/last-verify.json` · `.review/verify-history.jsonl` · `smoke-frame.json`）都有标注；**在册欠账 1 条**（冒烟截图"连续两帧逐字节相同"尚无判定 —— 哈希被记录被绑定，却从没被用来证明一致性） |

- **三条都做了"先证明会红"**：注入 ⇒ FAIL ⇒ 撤销 ⇒ **sha256 逐字节还原**（报文原文见本轮交接报告）；
  另有 `tests/dep-direction-check.test.js` · `tests/collateral-check.test.js` · `tests/determinism-check.test.js`
  三条**判别力可重复版**（只在内存里注入，不落盘 ✗）。
- **欠账册是封闭的**：在册算欠账（输出里可见）/ 只减不增（上界 1，复审时机 = 每次动冒烟取景链路）/ 修好忘销账判红 / 册上对象不存在判红。
- **差异来源分类**（`S3 --list` 现场取）：时间戳 / 耗时 / 随机名 / 路径 / 渲染取景 = **允许**（只落在留痕与证据产物里）；
  **顺序 = 不允许**（"同一输入两次产出顺序不同"不是不确定，是缺陷 —— 本工程实测过：把工作目录清单渲染进受管文档 ⇒ 新建一个工作目录就让全链判红 ✗）。
- **连带补齐**：`docs/RULES.md` §2 三行（含能力边界）· `docs/ARCHITECTURE.md` §2.6 三条脚本行 + §4 原则 2 指认分层图唯一权威 + 新增 **§5.2 产物确定性表** · `SKILL.md` 第一屏步骤数 11 → **14**（G6 校核）· `scripts/changed-plan.js` 的 `FULL_STEPS`/`ALWAYS` · 两处 `tests/` 期望。
- **档位与依据**（用户 2026-10-10 选方案 B）：S1/S2 甲档（现有对象集合实测就是干净的 ⇒ 上线即绿）；
  S3 乙档（判定目前尚不存在 ⇒ 有 1 条在册欠账，**不是**一次性全红）。

### E6 工程侧五项收口（2026-10-10，提交 `84be218`）

- **第一屏步骤数绑死 `STEPS`**：`SKILL.md` 第一屏原写"9 条步骤 / 实跑 8 步"（漂了两轮 ✗ ⇒ 现 11 步 ✓）；改由 `scripts/doc-facts.js` 的 `scanStepCount` 校核（数字不符 / 字样缺失 / 采不到真值 **三种情况都判红** ✓），并有注入证明 ✓。
- **V1/V2 登记 `docs/RULES.md` §2** + 新增**反向断言**"链上实现的每个门禁都必须在 §2 有声明"（防"挂了门禁没人声明"✓），含注入证明（报文**指名** `V1` ✓）。
- **22 条缺口 `G-01…G-22` 原样并入 `docs/BACKLOG.md`**（源与清单 22 行 sha256 相同 ✓）。
- **口径修正**：全仓 10 处"零运行时依赖" → "**零必需运行时依赖**（唯一例外：PDF 解析用的 `pdfjs-dist`）"✓；4 处**字面为真**者刻意保留（模块/产物级表述 ✓）；`README.md` 门禁清单、`RULES.md` §2 的 G6 行与本清单附录 A 的那条**一并收口** ✓。

### 文档体系：待做清单升格为 `docs/BACKLOG.md`（§5 登记 + 四处指针同步）（2026-10-10）

**一句话**：`W1–W24` 逐条 + 附录 A 的 50 条既有待做（每条带 `file:line` 出处）从 `.review/20261010-卖点与功能-常驻讨论/待做清单.md` 迁入 **`docs/BACKLOG.md`**（**层:记录**，**只增不减**：写完不删、不改编号），按 §5 准入**登记进登记表**、加 `SKILL.md` ⑥ 记录层导航一行、`.review` 旧文件改成只剩指针的兼容壳 —— 提交 **`f7a0b69`**（SKILL.md / docs/ARCHITECTURE.md / docs/BACKLOG.md / docs/ROADMAP.md / docs/VERIFY.md，325 insertions / 3 deletions）。

**为什么搬**（`SKILL.md` 顶部「落盘规矩」/ `docs/ARCHITECTURE.md` §5 准入 / `docs-for-ai` 的分层三条同向）：**长期文档必须放 `docs/` 并在 §5 登记**，而 `.review/` 是"可随时整目录删除"的工作产物区。实据：`.review/` 是 `.gitignore` 的（`git ls-files .review` 为空）⇒ 这份清单**此前从未进过 Git**，随工作目录一删就永久没了。

| 项 | 做法 |
|---|---|
| 正文 | **原样搬走**（295 行；迁移时源文件已 296 行 —— 其中 1 行是另一个会话在搬运同一秒追加的 skill 更新日志条目，已一并带过来）。一条没删，**编号 / 验收判据 / 出处一字未改** |
| 只**新增**头部 | 四行元信息块（`层/作用/不该写/更新方式`，§5 表的数据源）+「本文是什么 / 与 `docs/ROADMAP.md` 的分工（ROADMAP=阶段与外部阻塞；BACKLOG=逐条待做与验收判据；**状态以 ROADMAP 为准、判据以本文为准**）/ **只增不减**」说明 |
| G6 逼出来的 4 处 | `.review/` 不在 G6 扫描面内，进 `docs/` 才被扫 ⇒ 三处体量/行数按 `RULES.md` §4 加同行锚（`64 MB` / `32 MB` / `151 行`，**数字一个没变**）、一处「六组共约 40 条命令」改中文数字（G6 把任何「N 条命令」当成"CLI 命令总数=55"比对，而这里的 40 是 `docs/EXTENSIONS.md` 三级表里「演进中」那六组的分组条目数） |
| 指针同步 | `.review/…/待做清单.md` → 8 行兼容壳（**可删**）；该目录 `README.md` 两行改指 `docs/BACKLOG.md`；`docs/ROADMAP.md` 顶部 **+1 行**指回（未动父会话那行「技能目录 C→D 销账」）；`SKILL.md` 导航 **+1 行**（G8 第 10 条：登记了就必须能从第一屏找到）；`docs/VERIFY.md` 由 `facts:write` 重生成（受管文档 **13→14 份**、记录层 3→4） |
| 副本上限 | **不留两份**：原文件正文零残留，搬运时留的临时备份已删 |

**顺带记一条"动作现场规矩"（本次实测发现，值得进 BACKLOG）**：**§5 登记表不是手写的** —— 它由每份文档头部的 `<!-- registry 层/作用/不该写/更新方式 -->` 元信息块**生成**（`scripts/docs-registry-check.js`）。所以"加一行登记"的正确姿势 = **写头部元信息块 + `npm run docs:registry`**；**手改表格会被 G8 第 13 条判红**（生成物与元信息逐字比对，报出差异行）。

**验收**：`node scripts/verify.js` 全绿（**10 步 / 268.7s**，预算 400s，进程退出码 0）；G8 15 条判定全绿；G6 13 份受管 markdown 与真值全一致。

### 批 5（补功能）：`import-dir` 整库导入 —— 把**文件夹结构镜像成一棵可用的树**（2026-10-10）

**一句话**：上一批把"入参是目录"改成**响亮拒绝 + 如实说 `import-dir` 尚未实现 + 给出逐文件流程**；本批把那条路**真的做出来** —— `import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] [--max-files N] [--dry-run] [--json] [--force]`：每一级子目录 = 一个容器节点、每个文件 = 该容器下的一个文件节点（标题取**文件名去扩展名**，文档自己的标题在它下面）。跳过、体量、文件数、幂等四道闸门**全在写盘之前**，整棵树先在内存里建好再**一次原子写**（失败不留半个项目）。**没有降低任何产品要求**：`describeImportSourceProblem` 从"说没实现"改成"指给真命令"，容错/幂等/响亮拒绝一条不少。

#### 一、设计与四条取舍（各一句理由）

| 取舍 | 选择 | 理由 |
|------|------|------|
| 结构映射 | **目录树的每一级 = 一个容器节点**，不是"只取第一层" | 只取一层的话，嵌套目录要么被拍平（结构信息丢失）、要么整条丢掉 —— 两种都与"镜像文件夹"相反。目录在前、文件在后（与资源管理器同序），两层各自按名字排序 ⇒ 结构稳定可复现 |
| 文件节点标题 | **文件名去扩展名**（不是文档首个标题） | 文件名本身就是文件夹结构的一部分（两个目录下的 `第1章.md` 取首个标题会得到两个同名节点，"这是哪个文件"没人答得出来），且它与 `origin.src` 同构、一眼可对。文档自己的标题**不丢** —— 它照样是文件节点的第一层子节点（正文走同一条 `markdownToTree` 入口） |
| 幂等粒度 | **整个目录重复导 ⇒ 整体拒绝**（推荐的那档），另加**文件级**也拒绝 | "重复导入不可察觉的污染"在整库这一级是一整棵树；按文件粒度放行会让人逐条自己判断，反而更容易漏。两档都指名、都给 `--force` 出口（与既有两条导入命令**同一语义**） |
| 上限值 | 合计体积沿用 `MAX_SOURCE_MB`（**一份常量**）+ 文件数默认 **200**（`--max-files` 覆盖） | 整库导入是"整棵树先在内存里建好再一次性原子写" ⇒ 总有一个瞬间它全在内存里，上限必须在这个口径里体现（不偷偷放宽 ✗）。200 是"一份个人笔记库的常见量级过得去、再多明确要调用方自己说"的保守值 |

#### 二、根因/现状取证 → 改了什么

| # | 现状取证 | 改了什么 |
|---|----------|----------|
| 1 | `src/doc-import.js` 的 `directoryMessage()` 原文写着"整库导入（`import-dir`）**尚未实现** ✗"，而 `scripts/cli-integration.js` 的 `dirOk()` 把"尚未实现"当**判据**在守（`r.out.indexOf('尚未实现') >= 0`）⇒ 一旦实现，**测试会替旧事实站岗** | 报文改成"要把**整个文件夹的结构**镜像成一棵树，用**整库导入** `import-dir` ✓"并给出**能照着敲**的整句命令；集成断言同步改成"必须出现 `node cli/mm-cli.js import-dir`、**且不许**再出现'尚未实现'"（否则就是过期的绿 ✗） |
| 2 | 目录走查、跳过分类、容器拼装**全新增**（此前 `src/doc-import.js` 只有"单文件 → 提纲"的前端） | `scanImportDir`（**只读**：逐类跳过计数、总量、容器数）+ `buildDirImportTree`（每个文件走 `docToOutline`、每棵子树走 `markdown.markdownToTree` —— **建树仍然只有一处实现**，本文件不做任何格式解析）。跳过判据抽成**纯函数** `entrySkipReason`（隐藏项 / 依赖目录 / 符号链接 / 空目录 / 无可导入文件 / 不支持的扩展名 / 无读权限 / 非普通文件），走查与报告**共用它一处** |
| 3 | **两个只在整库导入才暴露的坑**：① `markdownToTree` 只在"当前节点存在"时收正文（`if (!cur) continue`）⇒ **一个标题都没有的提纲**（纯 txt 笔记最常见）会**整份落空** ⇒ 静默丢内容；② `markdown.idGen` 把非 ASCII 主题用 `[^a-z0-9]+` 整段抹掉 ⇒ 中文笔记里成百上千节点都落到同一个 base，只剩时间+4 位随机在区分，同毫秒内会撞 id，而 `schema` 判"**全树 id 唯一**" ⇒ 一次整库导入以"id 重复"**整体失败**（人完全看不出为什么） | ① 没有标题时把整份正文放进**文件节点自己的 `detail`**（HTML 用 `convert.markdownToHtml` 转 —— 与 `markdownToTree` 内部同一个转换，不另写解析）；真的什么都没有（0 字节/纯空白）才计成"空文件"跳过。② `uniqueIdGen()`（`markdown.idGen` 的薄包装，不另立 id 方案）：见过就再摇一次 |
| 4 | 幂等闸门要按**文件粒度**逐个查全库，而 `originHitAcrossStore` 一次只回答一个 `want` ⇒ 逐个文件各扫一遍全库是 O(文件数 × 全库节点数) | 全库收敛成一张索引（**一次扫盘**）：`originKey`（`src`+NUL+`sha256`）为键，`originHitAcrossStore` 改成搭在索引上 ⇒ 两条命令共用同一份扫盘实现，判据仍是**同一处**（`originMatches` 现在由 `originKey` 实现，单测逐例核对两者同结论） |
| 5 | 上限与报错：整库导入此前没有"合计体积"与"文件数"这两个概念 | `describeTooManyFiles` / `describeDirOversize`（**说准是哪个上限 + 三条可执行出路**）+ `describeNoImportableFiles`（一个可导的都没有 ⇒ **不建空项目**）。🚫 反例守住了：报文里不许出现"坏了 / 损坏 / 内存不足"（那会把"超限"说成"文件有问题"✗） |
| 6 | 目录入参的 stat 归类（ENOENT/EACCES/ENOTDIR/ELOOP）原先**内联在** `describeImportSourceProblem` 里，而 `import-dir` 需要一份"要的是目录"的口径 | 抽成 `classifyStatFailure(p, e, noun)` —— 归类**只有一处**，两条路只差一个名词与"拒绝的是文件还是目录"；新增 `describeImportDirProblem`（给**文件** ⇒ 说清"这是文件不是目录" + 点名 `import-project`/`import-md`） |
| 7 | 命令层 `importDir`：四道闸门 + 两种输出 + 一次写入 | 入参 → 项目重名 → `--ext`（非法值当场报错，**不静默退默认**）→ `--max-files` → 扫描 → 上限（超限**不转换**，没必要把几十 MB 读进内存）→ 转换建树 → 幂等索引比对 → `--dry-run` 出报告（**绝不写盘**，并如实报"会不会被拒"）→ `ctx.write` 一次原子写。报告两条硬要求：**"导入了 N 个文件 / 跳过 M 个（按原因分组）"** + 逐条点名；`--ext` 排除掉的**可导**扩展名单独给一句"想一起导就加 `--ext md,txt`" |
| 8 | MCP 同步 / 文档登记 | ✅ `scripts/mcp-server.js` 新增 `import_dir` 工具（参数与 CLI 对齐，只透传不复制业务逻辑）⇒ 工具数 44 → 45；✅ `cli/registry.js` 登记（命令数 54 → 55）；✅ `docs/CLI.md` 由 `docs-gen` 重生成；✅ `docs/VERIFY.md` 由 `npm run facts:write` 重生成；✅ `docs/EXTENSIONS.md` §1.2 稳定性三级表把 `import-dir` 放进**演进中**（G8 第 ⑮ 条判定机械核对"每条命令恰好落一级"）；✅ `README.md` 能力表新增一行（并把 `import-project` 那行里过期的"如实说 `import-dir` 尚未实现"改掉）；✅ `docs/DATA-FORMAT.md` §2.8 补 `import-dir` 的**两档 origin**（项目根=目录清单指纹、文件节点=文件指纹）；✅ `docs/ARCHITECTURE.md` 的 `commands/project.js` / `doc-import.js` 两行 + origin ADR 行 |

#### 三、判别力证明（每条：注入 ⇒ 必红 ⇒ 撤销 ⇒ **逐字节还原**）

| # | 注入（改什么） | 期望红 | 实测报文 |
|---|---------------|--------|----------|
| 1 | `buildDirImportTree` 里**不再给子目录建容器**，把它的孩子直接提到本层（= 目录层级拍平） | "与文件夹同构"那条必红 | `[FAIL] ★★ import-dir 建出来的树**与文件夹同构**… :: 实际结构=书库(深层 第一章(第一章) 第二章(第二章) note-a(甲的主题))`（`笔记`/`子目录` 两个容器没了）；同批红 3 条（容器数 2→0、节点数 9→7）⇒ **307/310** ✓；撤销后逐字节还原 + **310/310** |
| 2 | `scanImportDir` 的 `push()` 直接 `return`（**连计数都不记** = 跳过项静默） | "跳过按原因分组 / 逐条点名"两条必红 | `[FAIL] ★ 报告给"导入了 N 个文件 / 跳过 M 个（按原因分组）"…`、`[FAIL] ★ 跳过项**逐条点名**…`，且空目录那条的报文从"跳过 1 项：空目录 1"退化成"（目录里一个条目都没有）"；集成 **305/310**、**单测 43/45**（2 条跳过分类断言红）✓；撤销后逐字节还原 + 复绿 |
| 3 | `importDir` 的 `--dry-run` 分支里**先写一个空项目**再出报告（= dry-run 真的写了盘） | "`--dry-run` 绝不写盘"那条必红 | `[FAIL] ★ --dry-run **绝不写盘**… :: 项目 imp-a imp-b imp-d legacy → imp-a imp-b imp-d legacy **lib1**`（项目列表多出一个）✓；并连锁红掉后面 11 条（后续断言全在被污染的盘上跑 —— 这正说明"绝不写盘"不是一条可有可无的检查）✓；撤销后逐字节还原 + **310/310** |

**逐字节还原**：`src/doc-import.js` = `E7EFBE33…D1D3`、`cli/commands/project.js` = `5BD07F18…02B5`（注入前后逐字节相同，用 `Get-FileHash -Algorithm SHA256` 比）。

#### 四、验收（机械可判）

- **单测 45/45**（`tests/doc-import.test.js` 新增 13 条）：目录树→节点树的映射（嵌套/空目录/混合扩展名/跳过计数/符号链接/空文件）、**一个标题都没有的 txt 不许丢内容**、清单指纹确定性、`originKey ⇄ originMatches` 同口径、上限报文、**走查与建树都不写盘**、**300 个中文目录不许撞 id**；
- **集成 +20 条**（`scripts/cli-integration.js` §9.3，全部在 `%TEMP%` 沙箱项目根里跑，真实 `projects/` 零接触）：结构与文件夹同构、跳过逐条点名、`--dry-run` 不写盘、整库重复导整体拒绝并指名、子目录重复导按文件点名、`--max-files` 写盘前拒绝、`--ext` 覆盖与提示、文件/空目录入参闸门；夹具目录**自建自删**；
- **全链 `node scripts/verify.js` 全绿**（11 步 / 逐段耗时见 `docs/VERIFY.md`）。

### 批 4（三个真缺陷 + 三个小尾巴）：BOM 静默吃掉第一个标题 · 恒真断言 · 模态跨域污染（2026-10-10）

**一句话**：三件**改代码**、不动措辞、不缩要求 —— ① `import-md` 不剥 BOM ⇒ **整个第一个标题被静默吃掉**（带 BOM 只剩「第二本书」，无 BOM 两个都在 —— 同一份内容两条导入路给出两棵树 ✗）；② `scripts/cli-integration.js` 有一条断言的**一半判据从来没生效过**（读的字段不存在 ⇒ `undefined !== 0` 恒真）；③ 冒烟的「每域隔离」**收不掉 DOM 模态** ⇒ 域 16 的 `addNode` 留下的「编辑节点」框跨域存活，把域 36/37 连锁弄红 **11 条**（而那两个文件一行都没改过）。三条各自做了**注入 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原**的判别力证明（报文见下）。

#### 一、三项各自：根因取证 → 改了什么

| # | 根因取证（file:line + 实测报文） | 改了什么 |
|---|--------------------------------|----------|
| 1 | `cli/commands/project.js` 的 `importMd` 把 `fs.readFileSync(file,'utf8')` 的**原文**直接喂给 `markdown.markdownToTree`，而 `src/doc-import.js` 的 `normalizeOutline`（CRLF→LF + 剥 BOM，**唯一实现**）只在 `docToOutline` 里被调（第 356 行）⇒ 带 BOM 的 md 首行 `#` 匹配不上、被当成正文吞掉。实测（`%TEMP%` 沙箱、临时项目）：`# 第一本书\n正文一\n\n# 第二本书\n正文二` 带 BOM ⇒ `导入完成，新增 1 个节点` + `read --brief` 只有「第二本书」；同内容不带 BOM ⇒ `新增 2 个节点` + 两个标题都在 | `import-md` 先 `normalizeOutline(raw)` 再**建树 + 算指纹**（正文与指纹共用同一份规范化）；`describeOversizeSource(file)` 体量闸门加在**读之前**。**同类扫描**：全树只有这一处"原文直接进建树入口"——`import-project` 的 md/txt/docx/pdf 四条前端都经 `docToOutline`（已规范化）、PDF 文字层在 `src/pdf-text.js` 里自己拼 `#` 提纲后同样回到同一入口、`ask-apply`/`import-json` 不走建树 ⇒ **已逐条核对，只有这一处** ✓ |
| 2 | `scripts/cli-integration.js:817` 写的是 `r4.status !== 0 && /项目已存在/.test(r4.err + r4.out)`，而同一文件第 84 行的 `run()` 只返回 `{ code, out }` ⇒ `.status`/`.err` **都是 undefined** ⇒ `undefined !== 0` **恒真**（只在 `"undefined" + out` 顺带命中文本时才没暴露）；机械扫同类又查出 **5 处**同型的 `r.status !== 0`（ask 段）与 **6 处** `r.err + r.out` | 全部改成真实字段（`r.code` / `r.out`；`out` 本就是 stdout+stderr 合并）。**改了几处 / 还剩几处**：`run()` 的调用点 **6 处**全改；文件里其余 `.status`/`.stdout`/`.stderr` 都是**真子进程结果**（`spawnSync`，第 836/838/1357/2004 行等）—— 那些字段真实存在，**留着不动** ✓ |
| 3 | `main.js` 的「每域隔离」只做"还原沙箱数据文件 + 让应用重开当前项目"，而「编辑节点」模态是**纯 DOM** 的（`renderer/editor.js`）⇒ 跨域存活。实测（`SMOKE_ONLY='16,36,37'`）**12/23**：域 36 报文 `点不到 comp-net：该节点此刻没有可命中点…各候选：(382,540)→DIV.dialog-box[125,171 480x454]`、域 37 报文 `命中测试命中圆钮=false（命中=overlay）`；元凶是 **16-local-path.js** 的 `app.addNode('overview')`（`undo()` 撤得掉节点、撤不掉框）。全量跑当时还绿，只因后面的域**各自顺手**擦了桌子（`12-dsh-drag.js` 扫 `.overlay`、`27-import-doc.js` 点 `edit-cancel`）—— 五份拷贝、各写各的，实测漏了 **5 个域**（11/13/15/16/17） | ① **渲染层唯一入口** `MMApp.closeAllDialogs()`（`renderer/app-actions.js`）：走**产品自己的关闭路径**收干净模态/浮层，并**返回列表**（不静默关掉）；② 冒烟**共用工具** `require('../smoke-assertions.js').closeDialogs(ctx)`，5 个漏收尾的域逐条接上；③ **框架级干净前置**：每个域开始时（隔离之后）调它，**有残留 ⇒ 该域直接红并点名"是哪个域留下的"** —— 过滤运行照样生效（这正是当年漏掉的那条路）；④ 新门禁 **V2**（`scripts/smoke-state-check.js`，挂进 verify）：静态扫 37 个域文件，"会留下浮层的动作"在**域末**必须有收尾或显式豁免 `收尾-豁免: <原因>` |

#### 二、三个小尾巴（都做完 ✓）

- **`docs/EXTENSIONS.md` 的稳定性三级表**：补上 `import-project`，并顺带清点出**同型漏登记 11 条**（`ask`/`ask-apply`/`theme-layout`/`expand-depth`/`ui-state`/`sidebar-only`/`dsh-sidebar`/`dsh-status`/`dsh-prefill`/`dsh-caps`/`changelog`）；新增 G8 第 ⑮ 条判定 `checkStabilityCoverage`：`cli/registry.js` 的**每条命令必须落在某一级里**（真值运行时可数；解析不到表 / 注册表为空一律**判红**，不静默通过）。**判"放哪一级"仍是人的判断**，门禁只判"有没有落在某一级"。
- **导入体量闸门**：新增 `MAX_SOURCE_MB`（64 MB，**一份常量**）+ `describeOversizeSource`/`describeOversizeBuffer`，两条导入路在**读之前**判 ⇒ 超限**响亮拒绝** + 三条出路（拆 / 转格式 / 取一段）"**没有读它**"。PDF 那条路另外修**报文**：子进程输出超 `maxBuffer`（32 MB）时原先只说"读 PDF 的子进程没有给出结果"（会让人以为 PDF 坏了），现在明确说"**提纲文本超过读取上限**，不是 PDF 坏了" + 出路。
- **`scripts/smoke/27-import-doc.js` 的 `writeProbe()`**：改为返回 `{file, dir}` 并新增 `removeProbe(dir)`，探针用完**立刻自建自删**，"探针目录已删=true/false"进断言报文（原先每跑一轮全量冒烟就在 `%TEMP%` 留 2–3 个 `mm-imp-*` 目录 ✗）。

#### 三、判别力证明（每条：注入 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原）

| # | 注入（改什么） | 期望红 | 实测报文 |
|---|---------------|--------|----------|
| 1 | 把 `importMd` 里的 `normalizeOutline(raw)` 还原成 `raw`（即回到不剥 BOM） | 集成 §9.2 的 BOM 断言必红 | `[FAIL] ★ 带 BOM 的 md 经 import-md ⇒ **两个标题都在**…` + 报文里可见"节点数只涨了 1"与读回只剩「第二本书」⇒ **第一个标题消失** ✓；撤销后 `290/290` |
| 2 | 让"项目已存在"那条命令**返回 0**（让 `error()` 不改退出码） | 第 816 行那条断言必红 | 旧写法（读 `r4.status`）**不变红** —— 这就是"一半判据恒真"的直接证据；改成 `r4.code` 后同一注入 ⇒ `[FAIL] import-project 项目名已存在 ⇒ 非 0 且点名…` ✓；撤销后逐字节还原 |
| 3 | ① `MM_SMOKE_INJECT=16-leave-modal`（域 16 故意不关模态）+ `SMOKE_ONLY='16,36,37'` | 域 36 必须红并**点名 16** | `[smoke] ⚠ 域开始的干净前置：收掉了 ["edit-dialog"] —— 这是域 16-local-path.js 留下的残留模态（它自己跑绿了 ✗）` + `[FAIL] 域开始的干净前置：域 36-real-input.js 开始时**没有**残留模态/浮层 … ← **由 16-local-path.js 留下**` ✓；不带注入 ⇒ `23/23`（修前 `12/23`）✓ |
| 3b | 把域 17 的 `await mm.closeDialogs(ctx)` 抹掉（V2 门禁的注入自检） | **V2 门禁**必红 | `✗ 1 个冒烟域文件里，有断言打开了浮层/模态却没写收尾：[未收尾] scripts/smoke/17-ui-polish.js … 打开的：openFilePreview → 文件预览浮层（#file-preview）`（exit 1）；撤销后 sha256 **逐字节相同**（`088ce1259f5bfcf8`）⇒ 复绿 ✓。同一注入在**真实仓库**上由 `tests/smoke-state-check.test.js` 再演一遍（只改内存、磁盘不动 ✓） |
| 4 | 稳定性表里删掉一条命令（`import-project`） | G8 第 ⑮ 条必红并**点名** | `✗ 稳定性三级表漏登记 1 条命令：import-project（注册表共 54 条）…处置：给它选一级` ✓；撤销后 `✓ CLI 稳定性表覆盖注册表全部命令（docs/EXTENSIONS.md §1.2：54 条已登记）` |
| 5 | 体量闸门：把 65 MB 的 txt 喂给 `import-md` / `import-project` | 两条都要**响亮拒绝**且**不读** | `error: 这个文件 65 MB，超过导入上限 64 MB: …。**没有读它**…出路（三选一）：① 拆成几份…② 先转成体量小得多的格式…③ 只要其中一段…`；断言同时核对"项目数不变 / 目标项目节点数不变"（拒绝是真的没写）✓。边界由单测钉住 -1 / 正好 / +1 三档 |

> ⚠️ **注入过程本身踩到两个坑（如实记，都是本工程记过的老形状）**：① 把反引号写进 JS **模板串**里的注释 ⇒ 提前终止字符串、`require` 期直接 SyntaxError，整轮冒烟变成 `SMOKE LOAD ERROR`（一条断言都不跑）——踩了**两次**（域 16、域 27），第二次是"解释这个坑的注释自己又踩了一遍" ✗；② `smoke-assertions.js` 里新加的共用工具挂在 `require` 各分域**之后** ⇒ 循环 require 让分域拿到 `undefined` ⇒ 5 个域一起报 `mm.closeDialogs is not a function`（已把挂载点提到 `require` 分域之前，并在注释里写明这是本文件唯一的顺序约束）。

#### 四、改动即连带（RULES §3 R5）

| 可见面 | 结论 |
|--------|------|
| **GUI 交互** | 新增对外 API `window.MMApp.closeAllDialogs()`（自动化/隔离用，**不新增任何界面入口**，也不改任何既有交互）；`import-md` 的**正常路径**行为不变（只是"带 BOM 的文件不再丢第一个标题"） |
| **CLI 命令语义** | `import-md` 新增一条**入参拒绝**（>64 MB）；`import-project` 同样。成因与出路都写在报文里；`docs/CLI.md` 由 `docs-gen` 重生成（54 条命令，逐字无变化）✓ |
| **MCP 工具** | 无变化（`import_markdown`/`import_project` 只是转发 CLI ⇒ 自动获得新报文） |
| **数据格式** | 无新字段、`formatVersion` 不变；`origin.sha256` 的算法不变（BOM 本来就不参与指纹） |
| **冒烟 / 集成断言** | 集成 **284 → 290**（+6：BOM 三条 + 体量三条）；冒烟 **204 → 204**（**条数不变** —— 域 16/17 只是把"收尾"写进既有断言的报文，不新增断言；框架级判据是**前置检查**，不进断言计数）；单测 **987 → 1012 / 54 → 55 文件**（`tests/smoke-state-check.test.js` 12 条 + `doc-import` 8 条 + `docs-registry` 5 条 + `changed-plan` 措辞）；`docs/VERIFY.md` 由 `npm run facts:write` 重生成 ✓ |
| **门禁** | V1 之后新增 **V2**（`scripts/smoke-state-check.js`），挂进 `scripts/verify.js` 的 STEPS（第 5 步，10 s 预算）⇒ 全链 **10 步 → 11 步**；`scripts/changed-plan.js` 的 `ALWAYS`/`FULL_STEPS` 同批更新（+ 对应单测）✓；G8 新增第 ⑮ 条判定（`docs/RULES.md` §2 的 G8 行条数 14 → 15 同批改，G9 机械核对 ✓）。⚠️ V1/V2 的编号仍是 V 而不是 G：§2 是门禁编号的唯一权威，而该文件本轮仍被另一会话占用（脏文件）⇒ 待交回后并入（只改编号声明，不改实现） |

#### 五、验证（全链原文数字）

（本节以下数字为本轮实测，原文取自 runner 的逐段耗时表与各步汇总行 —— 易腐数字以 docs/VERIFY.md 为权威副本。）

全链 `npm run verify`：**11 步全绿 / 263.6s**（预算 400s）—— G1 0.7s ｜ G8 0.7s ｜ G9 0.6s ｜ V1 0.6s ｜
**V2 0.6s（本轮新增）** ｜ G3 **1012 用例 / 55 文件** ｜ G6+G7 0.7s ｜ G4 **290/290** ｜ G2 0.6s ｜
G5 冒烟 **204/204** + 视觉 **2/2** ｜（逐段耗时表由 runner 每次打印）。另有：`SMOKE_ONLY='16,36,37'`
**23/23**（修前 **12/23**）、`SMOKE_ONLY='08,11,12,13,15,16,25,27,36,37,38'` **79/79**（修前同一批里
有 5 处"域开始的干净前置"判红）。

#### 六、本轮**没动**的东西（诚实边界）

- `import-dir`（整库导入）仍未实现（上一批的结论，本轮没碰）；
- 体量闸门的上限是**人为约定的 64 MB**，不是性能测量结论；要按机器调就改 `MAX_SOURCE_MB` 一处（两条路共用）；
- PDF 的 `maxBuffer` 上限（32 MB 提纲文本）**只改了报文**，没有改成流式/分块读 —— 超过它仍然失败，只是原因现在是准的；
- 冒烟框架的"干净前置"收的是**模态/浮层**（`.overlay` 一族 + 命令面板 + 审计面板）：浮动详情框、选区块、大小锁属**另一类**状态，不在它的责任内（各有各的域在收拾）。

### 批 3（四件小事）：`broadcastStatus` 核实 + 导入来源指纹 `origin`（幂等）+ 目录入参响亮拒绝 + 单短横线选项原因准确（2026-10-10）

**一句话**：四件事都**改代码**，不动措辞、不缩要求 —— ① 核实一个"疑似未定义"的广播函数（结论：**不是 bug**，
靠函数声明提升成立）并给出运行时证据；② 新增节点可选字段 `origin`（来源路径 + 内容指纹）与**导入幂等闸门**
（同一份文档默认不再导成第二棵树）；③ `import-project`/`import-md` 拿到**目录**时不再露 `EISDIR`，
改成"原因准确 + 给出路"；④ 单短横线选项不再被当成项目名（`read -x` 不再报"项目不存在: -x"）。

#### 一、四件事各自：根因取证 → 改了什么

| # | 根因取证（file:line + 实测报文） | 改了什么 |
|---|--------------------------------|----------|
| 1 | **不是 bug**。`broadcastStatus()` 共 **14 处**调用（`main-dsh-sidebar.js` 188/204/211/256/308/380/433/457/866/878/955/1314/1388/1410），定义在 **1208 行**（本轮改动后 1220 行）—— 在**所有调用点下方**，靠**函数声明提升**（同一模块作用域的 `function` 声明）成立；`main.js` 只 `require` 它、**没有**任何注入或挂载。上一轮 grep 被截断 ⇒ 结论误判为"缺失" | 定义处补一段说明（写明"本文件内声明、不是外部注入、为什么能提升到上方调用点"）+ 最早那处调用点（188）加一行指针注释，免得下一个人重跑一遍这个枉路；新增**运行时**证据（见下） |
| 2 | 节点 id 由 `src/markdown.js:29-33` 的 `idGen()` 用 `Date.now()+随机` 生成 ⇒ **同一份文档导入两次得到两棵不相交的树**（内容相同、id 全不同）⇒ 批量/整库导入在结构上**不可能幂等** | 新增**可选**节点字段 `origin`（`{kind,src,sha256,at,tool?}`，**不升 formatVersion**，无则兼容）：`import-project` 写在**新项目根节点**、`import-md` 写在**这次追加的每个顶层子树根**上。指纹 = **规范化后提纲文本**（CRLF→LF、剥 BOM）的 sha256（`src/doc-import.js` 的 `normalizeOutline`/`outlineSha256`/`makeOrigin`，**唯一实现**）。写盘**之前**比 `src`+`sha256`：命中 ⇒ **拒绝并指名**上次导到哪个项目的哪个节点，`--force` 才放行。`get --json`/`read` 读得到（`skeleton` 档省），`stats` 新增 `originNodes`/`originSources` 两个数。MCP 的 `import_project`/`import_markdown` 同步加 `force` 参数（否则 MCP 侧没有出路 ✗） |
| 3 | `import-project <项目> <目录>` 与 `import-md <项目> <目录>` 都露 `error: EISDIR: illegal operation on a directory, read`（实测）—— 既没说"这是目录不是文件"，也没有任何出路；而"想导整库"的人**第一步**就会撞到它 | `src/doc-import.js` 新增 `describeImportSourceProblem()`（两条命令**共用**）：目录 / 路径不存在 / 无读权限 / 不是普通文件 / 符号链接成环各自**原因准确**，且目录那条**如实说 `import-dir`（整库导入）尚未实现** + 给出**现在就能跑**的三条逐文件流程（含 PowerShell 一行）。路径不存在仍是"文件不存在: <路径>"并补上"相对路径按**当前工作目录**解析"⚠️ 本批**没有**实现 `import-dir`（那是下一批），只把"没做"与"出路"写清楚 |
| 4 | `read -x` ⇒ `error: 项目不存在: -x`（实测）。退出码非 0 是响亮的，但**原因错**：`-x` 被当成项目名 ⇒ 人和 AI 都会去查"项目 -x 为什么不存在"。根因：未知选项守门点只认 `--xxx`（`a.slice(0,2) !== '--'` 直接跳过单横线）⇒ `-x` 落到位置参数 | `cli/core.js` 新增 `unknownShortOptions()`（**只看位置参数**，`parseArgs(rest)._`）+ `SHORT_OPTIONS=['-h']`；`cli/main.js` 的 dispatch 在**未知长选项之后、`-h` 短路之后**加第二个守门点 ⇒ 报"不认识的选项 -x（本工程约定使用长选项 --xxx）"+ 支持集 + 用法，并给出 `--key=值` / `./-x.md` 两条官方逃生口 |

#### 二、边界与取舍（写清楚，不留"看起来能用"）

* **`-h` 的既有语义一律保留**（取证：`<命令> -h` 打印该命令用法、exit 0；工程里**没有** `-v` 语义）——
  单横线扫描发生在 `-h` 短路**之后**，且**只看位置参数**：`edit <项目> <id> --topic -x` 里的 `-x`
  是**选项值**、属正常用法，不许误杀（集成里两条正向对照钉住它真的落盘）。
* **默认拒绝重复导入，而不是默认放行**（取舍）：重复导入是**不可察觉**的污染 —— 第二棵树与第一棵
  不重合（id 全不同），事后无法分辨谁是谁；`--force` 留给"我真的要第二份"，且它会如实说"这是同一个来源的第 2 份"。
  两个键**都要**相同才算同一份：只比 `sha256` 会把"两份内容恰好相同的不同文件"误判成重复；只比 `src`
  则文件被改过就判不出来（而那正是最该拦住的情形）。
* **`origin` 只校验形状、不重算哈希**（同 `localPath` 不校验存在性）：重算要把源文档读回来，
  而它可能早已不在本机/已被改过 —— 那是把**环境问题伪装成数据问题**。
* **`--dry-run` 也报"这份导过了"**（`wouldRefuse`）：预览说"能导"、真导被拒是最烦人的那种落差 ✗。

#### 三、判别力证明（每条：注入 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原）

| # | 注入（改什么） | 期望红 | 实测报文 |
|---|---------------|--------|----------|
| 1 | 把 `main-dsh-sidebar.js` 里 `broadcastStatus` 的函数声明**改名**（模拟"真的缺失"） | `smoke/11` 新断言必红 | `[FAIL] DSH 侧栏：状态广播真的送达 … :: 异常=broadcastStatus is not defined ｜ 真实路径加宽并广播=null ｜ 渲染层收到=没有`（14/15，exit 1）⇒ 撤销后 15/15 |
| 2 | 把幂等闸门那句（`if (refused) ctx.error(...)`）改成 `if (false && refused)` | 集成 §9.2 三条必红 | `[FAIL] ★ 同一份文档换个项目名再导一次 …`、`[FAIL] ★★ 被拒之后盘上没有第二个项目 :: 项目列表=[imp-a imp-b]`、`[FAIL] --force 是显式出口 …`（281/284）⇒ 撤销后 284/284 |
| 3 | 把 `describeImportSourceProblem` 的目录分支短路成 `return null` | 集成 §9.2 两条 + `tests/doc-import` 一条必红 | `[FAIL] ★ import-project 拿到目录 … :: error: EISDIR: illegal operation on a directory, read`（**旧报文原样回来**）；单测 `1 failed \| 24 passed`（282/284）⇒ 撤销后全绿 |
| 4 | 退回单横线守门点（`cli/main.js` 去掉 `if (shortBad.length)`） | 集成 §21c 两条 + `tests/cli-main` 两条必红 | `[FAIL] 单短横线未知选项（-x）… :: error: 项目不存在: -x`（**旧报文原样回来**）；单测 `2 failed \| 17 passed`（282/284）⇒ 撤销后全绿 |
| 5 | 把 `renderer/app-core.js` 的 `serializeTree` 里那行 `out.origin` 短路（＝原样回到"手挑字段漏一个"） | `smoke/27` 新断言必红 | `[FAIL] 导入：来源指纹 origin 记下来了，且界面保存不会抹掉它 … 保存后指纹仍在=false｜⚠️ 被整树写回丢掉了`（11/12，exit 1；**改完断言体之后又复跑一次确认**）⇒ 撤销后 12/12 |

> 还原方式：每条注入前记 `Get-FileHash -Algorithm SHA256`，撤销后重算比对 —— 五条全部 `EXACT=True`（逐字节还原 ✓）。

> 额外一条**非代码**的判别力教训（值得记）：本域新断言最初没关掉 `addNode` 顺手打开的「编辑节点」对话框，
> 于是 34/36/37 三个域共 **9 条断言**变红（报文 `命中测试命中圆钮=false（命中=overlay）` / `编辑框=true`），
> 而这 9 条**一行代码都没被改过**。根因是 `openProject` 式的域间隔离**不重载页面**（只重开项目），
> 模态会跨域存活。⇒ 冒烟域"离开时不留脏状态"这条既有要求不是洁癖，是**防连锁红**的机制。

#### 四、改动即连带：使用者可见面逐个核对（RULES §3 R5）

| 可见面 | 结论 |
|--------|------|
| **GUI 交互**（按钮/右键/菜单/快捷键/对话框/状态栏） | 本批**没有**新增/改动任何交互入口。唯一动到界面的地方是 `renderer/app-core.js` 的 `serializeTree`：新增一行平铺 `origin` —— 它不改任何呈现，**只防止整树写回把它抹掉**（同 `qa`/`localPath`；判据 `scripts/smoke/27-import-doc.js`） |
| **CLI 命令语义** | `import-project` / `import-md` 各自新增 `--force`；两者在**默认情形**下多了一条"同一份来源已导过 ⇒ 拒绝"的结局。受影响的老调用方有**唯一的显式出路**（`--force`），且报文里就写着怎么加。`docs/CLI.md` 由 `docs-gen` 重生成 ✓ |
| **MCP 工具** | `import_project` / `import_markdown` 同步新增布尔参数 `force`（否则 MCP 侧没有出路 ✗）。其余 42 个工具与 `tools` 计数**不变**（44）✓ |
| **冒烟 / 集成断言** | 新增 1 条冒烟断言（`smoke/27`）+ **26 条**集成断言（§9.2 导入沙箱 **20 条** + §21c 单短横线 **6 条**）⇒ 集成断言 **258 → 284**、冒烟 **203 → 204**；`docs/VERIFY.md` 已由 `npm run facts:write` 重生成 ✓ |
| **`AI-GUIDE.md` / `README.md` 的操作示例** | `README.md` 的两行能力表按新语义改写（导入幂等 + 目录拒绝 + 出路）；`AI-GUIDE.md` 里 `import-md`/`import-project` 的示例**无需改**（默认路径的用法逐字不变，只是重复导入会明确报错而不是悄悄再长一棵树）✓ |
| **详情框与关联笔记渲染入口** | **无影响**：`origin` 不进任何渲染路径（它是追溯字段，界面上不显示）✓ |

#### 五、验证（全链原文数字）

（本节以下数字为本轮实测，原文取自 runner 的逐段耗时表与各步汇总行 —— 易腐数字以 docs/VERIFY.md 为权威副本。）

* 全链 `npm run verify`：**9 步全绿 / 259.7s**（预算 400s）—— G3 **987 用例 / 54 文件**、
  G4 **284/284** CLI 集成断言、G5 冒烟 **204/204** + 视觉 **2/2**、G8 **14 条判定**全绿。
  逐门禁耗时：G1 0.7s ｜ G8 0.6s ｜ G9 0.5s ｜ V1 0.6s ｜ G3 24.8s ｜ G6+G7 0.6s ｜ G4 14.8s ｜ G2 0.6s ｜ G5 216.4s（预算内 ✓）。

#### 六、诚实边界（本批做不到的）

* `import-dir`（整库导入）**仍未实现** ✗ —— 本批只把"没做"说清楚 + 给出逐文件出路（用户已明确划到下一批）。
* 导入**没有大小上限**：本批只把"目录 / 不存在 / 无权限"三类原因说准；超大文件（几百 MB 的 txt/docx）
  仍会整份读进内存，PDF 那条路另有 32 MB 的 `maxBuffer` 上限（`src/doc-import.js`）。
* 幂等闸门**按 `src`+`sha256` 判定**：同一份内容换个文件名（`src` 不同）仍会被当成新来源导第二棵树 ——
  这是有意的（那**是**另一份来源），需要"按内容去重"的口径要等整库导入那一批再定。
* 闸门要**扫全部项目**：项目数很大时每次导入会多读 N 个 JSON（本机 1 个真实项目，实测无感）。

### AI 问答落盘（`ask-apply`）+ 控制通道多槽化 + `dsh-prefill` 成功路径取证（2026-10-11）

**一句话**：把"A"补完整（AI 产出**真的落到节点与详情**：新字段 `qa` + `ask-apply` 命令 + 界面两个动作 + 冒烟⑤条），
把"C"的两个并发缺陷根治（单槽覆盖 / 重复派发），并**撤掉**一条缺桩服务就报不了成功的"口头证据"、换成能真跑的桩脚本（B 的 D7）。

#### 一、本轮三件事与判据

| 项 | 做了什么 | 判据（谁守着） |
|----|----------|----------------|
| **A 问答落盘** | 新命令 `ask-apply`（一次原子写完成三件事：追加 `qa` 记录 / 追加 `detail`(带 `🤖 AI 问答` 来源标记与时间) / `--as-child` 建子节点）+ 新字段 `qa`（**可选、不升 formatVersion**，`get --json` 与 MCP `get_node` 都读得到）+ 界面「写入本节点详情 / 新建子节点」两个动作（**只经 CLI**，闸门 + 原子写 + 写后回读） | 集成 46 段 10 条（数据侧真值）+ `scripts/smoke/38-ai-落盘.js` 5 条（界面侧）+ `tests/` 的 schema 形状由 `qa` 契约覆盖检查（G8） |
| **C 控制通道** | 协议 v2：`pending/<token>.json` →（`rename` **原子认领**）`consuming/<token>` → `done/<token>`。**多槽**治"两个 CLI 同时下命令互相覆盖"；**认领**治"不清命令文件 ⇒ 400ms 轮询重复派发";回执**按 token 认**（按命令名认时，两条同名命令并发会互相吃到对方的回执）；`src/control-poll.js` 把轮询消费器从 `main.js` 抽出来（**纯逻辑可单测** —— 那两条缺陷原先长在一段只能靠"真跑起来看"的代码里） | `tests/control.test.js` 10 条 + 新增 `tests/control-poll.test.js` 8 条（★ 慢命令跨 5 拍只派发一次 / 两条并发各有各的回执 / 同步抛也给回执 / 同 token 回两次只认第一次）+ `tests/dsh-prefill-wait.test.js` 真往返一条（**命令文件先落盘**再等回执） |
| **B D7 取证** | 新增 `npm run dsh:prefill-stub`：桩服务走通 `prefillComposer` 的**成功分支**（返回 `ok:true` ⇒ 读 DOM 真值确认文本真的落进 textarea ⇒ 页面计数器证明 `input`/`change` 真的派发 ⇒ 负例空文本响亮拒绝）。**"发出去了"的断言一律以"命令文件真的写出去了"为判据**（批 1 的教训：只等回执抓不到"漏发探针"） | 该脚本 8/8；`tests/dsh-prefill-wait.test.js` 的 `recorder` / 真往返断言 |

#### 二、本轮**修掉的真缺陷**（都是"只在真机上才发现"的那一类 ⇒ 值得单列）

| # | 缺陷（修前行为） | 真因 | 修法 |
|---|------------------|------|------|
| A-1 | **界面保存一次就把刚落盘的 `qa` 静默抹掉** | `renderer/app-core.js` 的 `serializeTree` 是**手挑字段**的（`detail/tags/images/files/links/background/localPath`），新字段 `qa` 漏了 ⇒ 整树写回时它不在序列化结果里 | 平铺 `qa`（与 `localPath` 同一处、同一理由）。判别力证明：注释掉该行 ⇒ `smoke/38` 断言⑤ 必红（`保存后盘上 qa 仍在=false（条数=0）`）⇒ 撤销 ⇒ 13/13 绿 |
| A-2 | **落盘成功但框里看不见留痕** | `showAskBox` 每次都会把 `box.ask` **换成一个新对象**（`box.ask = { kind, log: box.ask.log }`），而写盘是异步的、`writeBack` 把 `box.ask` 存成了局部量 `const st` ⇒ "已落盘"被写进一个**已经不属于这个框的孤儿对象**，界面按新的 `box.ask` 渲染（盘上写了、界面上看不见 = 最该避免的"看起来没做"） | `writeBack` 里改用 `live()`，**每次重新取 `box.ask`**；并在现场写清"为什么不能存成局部量" |
| C-1 | `pollOnce` 的 `reply` 对同一个 token 回两次时，**日志说"忽略后一次"而行为是"后一次覆盖前一次"**（比不打日志更坏） | 漏了 `return` | 补 `return`（真忽略），日志与行为一致。判别力：新单测"同一个 token 回两次 ⇒ 只认第一次"必红 |
| C-2 | `listPending` 的**排序发生在丢弃之后**（`sort().map().filter()`）⇒ 只要有坏文件被丢掉，两条好命令的相对顺序就可能翻（"先来先做"不再成立） | 过滤改变了下标 | 排序挪到过滤**之前**；并给 `listPending` 加 `onDropped` 回调 ⇒ **丢弃可见**（静默丢一条命令的表现是"调用方等到超时、日志里什么都没有"，最难排查）。旁证：原来那条"坏 JSON ⇒ `listPending` 为空"的断言**本身是错的**（它其实是"好命令也没了"才通过，被测行为根本没被验到）⇒ 已改成"好命令照旧读得到 + 两处坏文件被如实点名" |

#### 三、判别力证明（注入 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原）

| # | 注入 | 期望红 | 实测报文 |
|---|------|--------|----------|
| A-1 | 注释掉 `serializeTree` 的 `out.qa = n.data.qa` | `smoke/38` 断言⑤ 必红 | `[FAIL] … save() 返回 true ｜ 保存后盘上 qa 仍在=false（条数=0） ｜ 这次保存真的写了盘（子节点=1）` ⇒ 撤销后 `13/13 passed` |
| C-1 | 去掉 `reply` 里的 `return` | `control-poll` "回两次" 必红 | `AssertionError: expected false to be true`（读到的是**后一次**的回执 `ok:false`） |
| C-2 | 还原 `sort().map().filter()` | `control.test.js` 顺序断言必红 | 见同批单测（坏文件排在中间时两条好命令顺序翻转） |
| B | 断言只记"发过了"的标志（不发命令文件） | `dsh-prefill-wait` 真往返必红 | 真往返用例断言**盘上 pending 里那条命令的 cmd/text** ⇒ 漏发即红（批 1 教训的落地） |

#### 四、验证

* 全链 `npm run verify`：**9 步全绿 / 265.8s**（预算 400s）——G3 **965 用例 / 54 文件**、
  G4 **258/258** CLI 集成断言、G5 冒烟 **202/202** + 视觉 **2/2**、G8 **14 条判定**全绿。
* `npm run dsh:prefill-stub`（**不在 verify 里**）：**8/8 通过**。
* 判别力证明见下面 §三（每条：注入 ⇒ 必红 ⇒ 撤销 ⇒ 还原）。

#### 五、诚实边界（本会话做不到的）

* **`prefillComposer` 的"真 DSH 页面"成功路径**仍未被门禁覆盖：桩页面验的是"接上 running 服务之后那一段"（选择器 / 事件 / 返回体形状），**验不了真 DSH 页面的 DOM 是否仍是 textarea**。真机复核项见提交信息。
* 控制通道 v2 是**同名同批升级**（`src/control.js` 的读写两侧一起改）：旧单文件 `mm-control.json` / `mm-control-result.json` **不再被读**。残留的旧文件只会"被当作没有命令"（不会被执行），这是有意的 —— 过期命令不该在升级后突然生效。

### 一轮「失败不许伪装成成功」治理：CLI 未知选项 / MCP 协议错 / `.review` 污染真值 / 注释反转 / dsh-prefill 白等，外加 `related` 多跳（2026-10-10）

**一句话**：上一轮全功能重测报出 5 个"把失败伪装成成功（或把等待伪装成失败）"的缺陷 + 1 处**人为上限**，
本轮全部改代码修掉（不是改措辞）：4 条可机械判定的缺陷各配**判别力证明**（注入 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原）。

#### 一、六条各自的根因（源码级 / 实测报文，先取证再动手）

| # | 现象（修前实测） | 根因（file:line） | 修法 |
|---|------------------|-------------------|------|
| D1 | `add <项目> root --topic X --tags aaa,bbb` ⇒ **exit 0 +「已添加」**，而 `get` 里没有 tags、`stats.taggedNodes` 是 0；`--bogus xyz`、`--expanded=nonsense`（盘上落成默认 `true`）同样静默 | `cli/core.js` 的通用参数分支**没有白名单**（`git log -S` 只命中首次提交 `5888f90` ⇒ 旧遗留）；`--tags` 在 `edit`/`add-image` 上**是合法选项** ⇒ 跨命令误用极自然 | 每条命令在 `cli/registry.js` 声明 `options`；`cli/main.js` 的 dispatch **唯一一处**判未知选项 ⇒ exit 1 + 点名 + **打印支持集**（是别的命令的选项就点名那条命令）。`core.parseArgs` 支持 `--key=value`；`--expanded` 取值只认 true/false；`--index` 只认非负整数。**同类的"值非法"一并收口**：`--limit` / `--min-length` / `--timeout` 走 `ctx.intOption`（修前 `--limit abc` 会静默变 NaN ⇒ `slice(0,NaN)` = 空清单、`--timeout abc` 会静默退回默认超时）。新增 `tests/cli-options.test.js`（20 条：声明自洽 + 判定纯函数 + 报错文本 + 进程内行为） |
| D2 | 原始报文 `{"jsonrpc":"2.0","id":4,"result":"method not found: no-such-method"}` —— 未知方法回 `result` 字符串，无 `error` 无 `code` ⇒ 标准客户端按成功处理 | `scripts/mcp-server.js` 默认分支漏传 `isError`（对照 `tools/call` 那条传了） | 抽出 `handleMessage`（唯一分流点）：未知方法/未知工具 ⇒ `error -32601`；缺必填参数/没给工具名 ⇒ `error -32602`；服务器异常 ⇒ `-32603`；**工具内部失败仍走 `result + isError:true`**（MCP 约定：失败原因要让模型看得见）。必填项取自 `inputSchema.required`（与工具定义同源）。两面都钉：`tests/mcp-protocol.test.js`（12 条）+ 真 stdio 一拍（集成 6 条） |
| D3 | 新建一个 `.review/<目录>/`（哪怕只写它的 README）⇒ 全链 G6 判红：`✗ 生成物已过期：docs/VERIFY.md（第 98 行起不一致）` ⇒ 任何"只读仓库 + 只写 `.review/`"的核查任务**不可能让全链变绿** | `scripts/doc-facts.js` 把 `.review/` 的**目录清单 + 各自状态**渲染进受管文档 `docs/VERIFY.md` | 该行改为**不含清单**的语义指针（"见 `.review/*/README.md`"）。判据：**易变、可随时整目录删的工作区不得成为受管真值的一部分**。G8 对 `.review/<目录>/README.md` 的**死活声明**照旧保留（它管可删性，不管清单） |
| D4 | `renderer/app-ask.js` 的函数 docblock 写"**不做上下翻转 / 不夹取**…由 overflow 裁掉"，而函数体正是 below → above → clamp + 水平夹取（行为是对的，注释是反的） | 该 docblock 是上一次改动前留下的（实现的兜底档位后加） | docblock 改成与实现一致的**真实档位语义**，并写清"为什么要兜底"（框可以比面板高 ⇒ 只放下方 = **看不见**，与圆钮那个真 bug 同类）。顺带发现同函数内**第二处**反转：`// 夹取只在这最后一档做` 与"水平夹取每一档都做"矛盾 ⇒ 一并改正 |
| D5 | `dsh-prefill` 失败要等 **12.56s**，而同批 `dsh-status` / `dsh-sidebar` / `sidebar-only` 只需 ~3.0s | `cli/commands/ui.js` 只有这一条用 12s 窗口（另三条 2.5s），而等待是"轮询到窗口用完"；更隐蔽的是 app 侧最坏路径 ≈12.4s（起服务 ≤6s + 加宽 0.4s + `executeJavaScript` ≤6s）**> CLI 的 12s** ⇒ 界面还在干活就被判"没在运行"（**假原因**） | 两步式：先发**只读探针** `dsh-status`（当场可答、无慢路径）→ 没回执 = 没在跑（**立刻**报错，且**不发出**慢命令）；有回执 = 活着，再给 14s（> app 侧最坏路径）。实测：无界面 3.03s（−76%）、界面在跑 1.58–1.77s 成功 ✓ |
| F1 | `related --depth` **只认 1/2**，`--depth 3` 静默退化成 1（回 `"depth": 1`）—— 而"多跳关系可查"是卖点原话 | `cli/commands/relations.js` 的 `depth === '2' ? 2 : 1` + `src/relations.js` 写死两跳展开 | `relatedAll` 改**逐层 BFS**：深度任意（1–100），**防环**（访问集合 ⇒ 每节点只以最短跳数入表一次），**结果上限** `MAX_ITEMS`=500（撞上限**响亮报错** + 给出缩小范围的办法，绝不静默截断）；深度越界给清晰用法；`byDepth` 分层计数（`depth2Count` 语义不变）；文本输出按跳数分组；MCP `related.depth` 同步（任意正整数 + 上限说明） |

#### 二、判别力证明（每条：注入 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原）

| # | 注入 | 期望红 | 实测报文 |
|---|------|--------|----------|
| D1 | 还原旧语义（去掉 dispatch 的未知选项判定） | 集成 21b 段必红 | `[FAIL] 写命令的未知选项 ⇒ 非 0 退出…`（旧行为：exit 0 +「已添加」，盘上无 tags / `taggedNodes`=0） |
| D2 | 还原默认分支（`respond('method not found: …')`） | 单测 + stdio 段必红 | `AssertionError: expected 'undefined' … error.code` / 真 stdio 报文回到 `{"result":"method not found: …"}` |
| D3 | 还原 doc-facts 的目录清单行 + 注入 `.review/zz-d3-inject-probe/README.md` | G6 必红 | `✗ 生成物已过期：docs/VERIFY.md（第 98 行起不一致）`；改回后同一注入下**校验通过**；撤销后 SHA256 逐字节相同（`837EFA87…`） |
| F1 | 还原 `depth === '2' ? 2 : 1` | 深 3 跳正例必红 | 旧断言本身写成"depth 3 ⇒ depth2Count 0"（正是被修的缺陷）⇒ 已按新语义改写为新断言 |
| D5 | 旧窗口（第一段 12s、无探活） | 计时断言必红 | 修前实测 12.56s；修后 3.03s；单测断言 `< 6s`（旧值会飞到 ~12.5s） |

#### 三、兼容性检查（"有没有用例依赖旧语义"）

* 集成里**没有**依赖"未知选项被忽略"的断言，但**有两类被新语义碰到**、已按新语义改并说明：
  `read --detail`（旧行为是"文本模式响亮报错 / --json 空操作"，属于**有意的兼容例外** ⇒ registry 里用
  `compatOptions` 显式登记，本命令照旧支持）；F1 的 `depth 非 1/2 退化为 1` 断言（改成"真按该深度展开"）。
* 顺带**抓到两处文档↔行为漂移**（新加的自洽门禁第一次跑就红）：`ask` 的 `--nodes` 是真实选项却没写进
  usage、`projects --json` 能跑也没写 ⇒ 补进 usage（`docs/CLI.md` 由 docs-gen 重生成）。

#### 四、验证

* 单测 **949 用例 / 52 文件**（新增 `tests/cli-options.test.js`、`tests/mcp-protocol.test.js`、
  `tests/dsh-prefill-wait.test.js`）；集成 **249 条**（新增 D1 未知选项 10 条 + 值非法 6 条、
  F1 多跳 8 条、MCP 真 stdio 6 条）；全链 `npm run verify` 见本轮提交信息里的原文数字。
* ⚠️ 只能真机复核的项（本会话无法重启用户正在用的应用实例）：`dsh-prefill` 的 14s 窗口只在
  "探活成功但界面迟迟不回"时才会走满 —— 探活成功路径已在本机真实实例上验证（1.58–1.77s 成功）。

### 可见性判据治理收口：V1 门禁在册的 **7 条盲判据逐条迁到真判据**（2026-10-09）

**这件事是什么**：`aed73ab` 落地的 V1 门禁（`scripts/visibility-judge-check.js`）判"**名字里声称可见/看不见**的断言
必须给出真判据"（`document.elementFromPoint` 命中测试 ⇒ 抓遮挡 · `scanRegion` 一类真帧像素 ⇒ 抓裁切 ·
或显式 `判据-豁免: <原因>`）。上线时仓库里已有 7 条这类"只看 rect / 类名 / `style.display`"的旧断言 ——
当时另一个会话正占着同批文件，于是它们被登记成**封闭清单**的欠账（在册算欠账、**不在册一律判红**、
**修好忘销账也判红**）。本次把它们**逐条迁完并逐条销账** ⇒ 欠账归零，机制保留（清单仍只减不增）。

#### 一、逐条：原判据 → 新判据（行号为迁移前的位置）

| # | 断言 | 原判据 | 新判据 |
|---|------|--------|--------|
| 1 | `scripts/smoke/05-pan-lock.js:565` 拖动树后"每条可见连线不被裁" | line/层**两级 rect** 比大小 | 几何（端点落在连线层矩形内）+ **每个在屏端点** 9×9px 窗口真帧非背景像素 ≥`paint.minHitsLineEnd` + 可见区整块像素地板 `paint.minHitsMapVisible` |
| 2 | `scripts/smoke/08-audit-palette.js:112` 审计面板"关闭后不再遮挡" | 面板自己的 `style.display` | `elementFromPoint` 关前必须在面板层上、关后**必须不在**；+ 同一小块真帧 `mean` 必须**变亮** ≥`paint.minOverlayBrighten` |
| 3 | `scripts/smoke/12-dsh-drag.js:62` 保存按钮"仍可见可点" | rect 在 toolbar 内 + `flexWrap` 计算样式 | `elementFromPoint(按钮中心)` 命中自身 + 按钮矩形真帧像素 ≥`paint.minHitsSaveBtn` + **真输入** `ctx.input.click`（capture 阶段拦下 click 只记"这一点上是谁"⇒ 不真触发 save，落盘正确性仍归 09 域） |
| 4 | `scripts/smoke/12-dsh-drag.js:270` 虚线框范围"选中节点 ∪ 其**可见**子节点" | rect | **改名消歧** ⇒ `其展开中的子节点`：那里的"可见"是**数据语义**的展开集合（`jm.layout.is_visible`），与"用户看不看得见"无关 ⇒ 硬套像素反而是**错的**判据 |
| 5 | `scripts/smoke/34-user-paths.js:72` 用户路径① 圆钮"每次都在" | `BTN_JS` 纯几何（`visible: r.width>8 && !!b.offsetParent`） | `BTN_JS` 加 `elementFromPoint(圆心)` 命中圆钮自身 + 圆钮矩形真帧像素 ≥`paint.minHitsRoundBtn` |
| 6 | `scripts/smoke/34-user-paths.js:235` 圆钮"**完整落在面板内**" | 一句纯 rect 包含判断 | 同上（命中自身 + 真帧像素；被面板 `overflow:hidden` 裁掉 ⇒ 像素骤降）；那句 rect 保留为几何旁证，不再是"看得见"的依据 |
| 7 | `scripts/smoke/35-rel-edit.js:79` 编辑条"可见 · 在面板内 · 不遮住节点" | 三句 rect 比较 | 中心 + **四角**（各内缩 1px）`elementFromPoint` 都必须命中条自身/子孙；每个被框节点**顶缘中点**上的命中**不得落进条**；+ 真帧像素 ≥`paint.minHitsRelBar` |

**阈值单源**：5 个新数字全部落在 `scripts/vision/thresholds.js` 的 `paint` 一节（每个数都带**实测标定依据**），
断言体里不写数字。`scripts/vision/frame-stats.js` 新增 `nonBackground` / `nonBackgroundPredicate` /
`scanRegionMany`（`scanRegion` 的批处理形态：`bitmapInfo` 一帧只取一次 —— 逐条连线各扫两端近 400 次/帧，
单调用形态会复制近 2 GB，慢到进不了冒烟 ✗）。

#### 二、判别力证明（每条注入一次违规 ⇒ **必红** ⇒ 撤销后逐字节还原）

开关 `MM_SMOKE_INJECT=<key>`（**支持逗号分隔多键** ⇒ 6 条注入**一趟冒烟跑完**：
`SMOKE_ONLY=05,08,12,34,35` + 6 个键 ⇒ **59/65，红的正好是这 6 条、其余全绿**）。报文（逐字，★ = 旧判据在同一时刻**照样绿**）：

| key | 注入 | 报文节选 |
|-----|------|---------|
| `05-fixed-bitmap` | 复刻旧缺陷：连线层位图固定 `200×150`（不随包围盒扩） | `[260,150]几何bad=547/547（端点落在连线层矩形外 ⇒ 该帧红了）` |
| `08-keep-open` | 面板关不干净（直接不关） | `display: flex → flex` ★｜`关后…都不在面板层上=false`｜`变亮=0.0（阈值 ≥20）` |
| `12-cover-save` | DOM 浮层盖住保存按钮 | `命中=#mm-save-cover-probe`｜`真帧非背景像素=0`｜`真输入点击送达=false（事件目标=#mm-save-cover-probe）`｜★`按钮rect右缘=547 ≤ 内容框右缘=696=true` |
| `34-clip-btn` | `clip-path` 把圆钮裁光（rect / 位置 / 形状一个数不变） | `命中测试命中圆钮=false（命中=theme-primary）`｜真帧像素 `663 → 0`｜★`在框外=true 圆角=50% 几何可见=true` 四轮全绿 |
| `34-btn-covered` | DOM 浮层盖住圆钮 | `命中测试命中圆钮=false（命中=DIV）`｜★`完整在内=true` |
| `35-bar-over-nodes` | 编辑条挪下去压住最高节点（位置按现场算，不写死像素） | `被条盖住的节点=1(1-fifo-…)`｜★`在面板内=true 命中条自身(中心+四角)=true` |

#### 三、门禁自身的一处修正（**是注入选错了对象，不是门禁空转**）

`--selftest` 的注入① 原先把"**样板断言的 `document.elementFromPoint` 抹掉**" —— 在"仓库里只有域 37 一条合规断言"
时那是有效注入 ✓；迁移后有 **7 条**合规断言、其中 **6 条同时用了两类判据**（命中测试 + 真帧像素，缺一不可）
⇒ 只抹一类时它仍合规、门禁**照样绿** ✗。修法：新增 `zeroRealJudges(src)`，抹的是这条断言**用到的全部**真判据，
且清单**由门禁自己的 `REAL_JUDGES` 生成**（不另写一份 ⇒ 以后加一类真判据时注入自动覆盖，
不会再出现"注入漏了新判据"这种空转 ✓）。`tests/visibility-judge-check.test.js` 的同款用例一并改；
教训如实留在注释与本节里（**判别力证明失败时先问"我注入的到底是不是那条判据"** ✗）。

#### 四、迁移过程中被新判据**抓到的三处真问题**（前两处本次修掉，第三处如实记录）

① 域 05：主题模式下"root → 顶层主题"的线是**设计性不画**的 ⇒ 被像素判据误判成"线被裁"（`comp-net 0/0`）
—— 已按 `isThemeMode && parent.isroot` 跳过（与他处同一判据 ✓）；
② 域 05：本工程地图（comnet **548** 节点）远大于面板（实测 **729×754**）⇒ 547 条线里只有个位数在屏上
—— 判据改成"**只判在屏的那一端**"（两端都出屏的如实计数、不当作失败），并在报文里报出
"只有一端在屏 / 两端都出屏"的条数（取不到真值时**判红**，不许静默放过 ✓）；
③ **全链跑到域 12 时 `#edit-dialog`（编辑节点弹窗）还开着，把工具栏盖住了** —— 新判据当场抓到
（`命中测试命中保存按钮=false（命中=#edit-dialog）`），而旧的 rect 判据只会报"按钮在工具栏内=true" ✓。
这**不是本次迁移引入的**：域 17 早就记过同一现象并做了同样的前置收尾（`scripts/smoke/17-ui-polish.js:66`
"关掉前序断言遗留的遮罩层……实测'裁剪出来全白'就是被「编辑节点」弹窗盖住"）。
本次按工程既有的「**断言自建前置**」纪律（域 09 / 17 / 37 同一做法）在域 12 也把它收干净，
**并把"收了谁"写进断言报文**（`前置收掉的残留模态=edit-dialog`）—— 免得看起来像是把判据放宽了 ✗。
⚠️ **根因未查明（如实标注）**：域 03 那条"双击节点**不再弹**编辑框"是**同步**读 `style.display`
（`03-edit-search.js:73`）—— 若弹窗是**异步**开的，它当时读不到、却在之后自己冒出来；
这是线索不是结论（未做探针取证），留给下一轮查 ✓。

#### 五、门禁状态（实测）

| 项 | 结果 |
|----|------|
| V1 门禁 | 触发 **11** 条（下限 6）／有真判据 **7** 条／**在册欠账 0 条**／新违规 0 条；`--selftest` 5/5 ✓；`--debt` 输出"（空 —— 已全部迁完 ✓）" |
| 冒烟断言数 | **197（未变）** —— 本次只改判据与一处改名，不增删断言 |
| 全链 | `node scripts/verify.js` **197/197 冒烟 + 2/2 视觉断言**，9 步 **全绿**。实测 2026-10-09（**同一份代码的两次读数**，差异是负载）：合计 **262.4s / 242.0s**（预算 400s）；G5 **208.6s / 202.8s**（预算 320s）；V1 那一步 0.6–0.8s —— 纯文本扫描的廉价门禁 |
| `docs/VERIFY.md` | 随真值重生成（`npm run facts:write`）：工作产物区一行跟着 `.review/` 现状更新，断言数仍是 197 |
| 编号 | V1 **仍是 V1**：门禁编号的唯一权威是 `docs/RULES.md` §2，而该文件此刻仍是**别人的脏文件**（`git status` 里 ` M`）⇒ **本次不登记**，待它交回后再并入（届时只改 `verify.js` 的 gate 串、`docs/ARCHITECTURE.md` §2.6 一行与两处 `tests/` 期望） |

#### 六、只能真机复核（自动断言覆盖不到）

① DSH 侧栏是主进程的 `WebContentsView`，**不参与 DOM 命中测试** ⇒ 域 12 里"按钮是否落在给侧栏让出的那一条带里"
只能用几何判（`按钮rect右缘 ≤ toolbar 内容框右缘`），侧栏 native view 那一层要真机看；
② 域 05 的像素判据只覆盖屏幕上看得见的那几条线（地图远大于面板，已如实计数）—— 其余靠
"**连线层矩形 == 位图尺寸**"这条几何关系兜底（对本条要抓的"位图没扩"它**不是盲的** ✓）；
③ 域 35 编辑条在**长框 / 贴边**时的四角命中，建议真机复看一次。

### 圆钮与悬浮工具条和「节点详情框」严格绑定 + 修「圆钮一直被框裁掉：看不见也点不到」（2026-10-09）

**用户原话（本轮验收口令）**：「关联视图按钮和悬浮工具栏的显示渲染逻辑和节点详情严格绑定，
甚至'大小锁'的时候也呈现一样效果，但是大小锁的时候要关闭悬浮工具栏，但是保留视图按钮。」

#### 一、真因：同一件事两轮都修错了层级

① **圆钮 `.rel-show-btn` 被"框自己"裁掉**：它原本是**详情框的子元素**、位置交回 CSS（`left:-54px`），
   而框是 `overflow:hidden` ⇒ 落在框外的圆钮被裁：**看不见、也点不到**。当时守着它的断言一律用
   `getBoundingClientRect()` 判"可见"，而该 API **忽略裁切** ⇒ 一直全绿。
   判别力探针（`.review/20261009-圆钮工具栏绑定/probe-clip.js`，同一读数量两种 CSS）：
   `rect` 两遍都报"在框外、在面板内"（**对裁切是盲的**）；而 `elementFromPoint(圆心)` 在被裁时命中普通
   DIV、正常时命中圆钮内部；真帧非白像素 **81**（被裁）vs **768**（正常）。
   ⇒ 用户两条反馈（「还是没看到那个按钮」「按钮位置会浮动」）都出在这里：只有 `clamp` 分支落进框内才看得见，
   于是忽有忽无。上一轮把"看不到"归因到**面板**、改成"贴面板边就镜像到右缘"——方向对、**层级错**。
② **悬浮工具条与框脱钩**：`#mm-node-toolbar` 是 body 上的 `position:fixed`，位置按**节点矩形**算，
   且只在 `MM.showDetail` 被包住那一刻刷一次 ⇒ 拖动框／改大小／缩放之后它停在原地；
   同一套显隐判据散在 **5 处**（包 `showDetail`／包 `closeFdBox`／点别处／`showBarFor` 内两条早退／选区变化）。
③ **大小锁不认识卫星**：`FD_LOCK.SCREEN` 原先只管框自己 ⇒「上锁关工具条／留圆钮」两条都没实现。

#### 二、改法：搬进「与框同级」的卫星浮层 + 判据收敛成一处

- 圆钮与工具条都住进 `#fd-satellite-layer`（`#mindmap-container` 的子元素、**与 `.float-detail` 同级**）——
  框的 `overflow` 管不到同级元素，这才是"看不见"的真修法；浮层自己 `pointer-events:none`、
  子元素各自 `auto`（**否则整块画布点不动** ✗）。
- 位置**只从框的 `getBoundingClientRect()` 推导**；刷新时机与框**同一批事件**：
  `positionFdBox` / `syncFdBoxes` / 拖动·改大小 mousemove（窗口 resize 汇入 `syncFdBoxes`）⇒ 拖动零漂移。
- 显隐判据从 5 处收敛成 **1 处**（`MM.fdSatellitePlan`）：框不可见 ⇒ 两颗都不出现；节点详情框 ⇒ 圆钮恒有；
  **大小锁 ⇒ 工具条收起、圆钮保留，且位置/尺寸/可点性逐字不变**。
- 工具条**拆掉两条猴子补丁**（包 `showDetail` / 包 `closeFdBox`）：目标改由框池推导，框一关自动收起。
  落位三档：默认贴框**下缘外侧 +6**；框高到下方放不下就**翻到上缘外侧 −6**；再放不下才夹进面板
  （档位写 `data-place`，断言读它 ⇒ 不静默）——只放下方会把工具条推到面板外被裁掉 = 看不见（与圆钮同一类损害 ✗）。
- 顺带修一个**真回归**（改造中暴露）：圆钮原先在 `.float-detail` 里 ⇒ 各处"点别处"的守卫顺手就挡住了它；
  搬进浮层后会**点一下圆钮就把未锁定的详情框关掉** ✗ ⇒ 新增唯一判据 `MM.fdIsSatelliteTarget`，
  4 处守卫（容器点空白关框 / 点别处关 AI 浮窗 / 点框外清选区 / 拖拽与加选起手）共用同一份实现。

#### 三、两条要留给后人的结论

- **判据纪律**：「可见性断言不得只用 `rect`／类名／计算样式」已写进 `docs/ARCHITECTURE.md` §4b、
  `scripts/smoke-assertions.js` 头与本域文件头；配套机械门禁是 **V1**（`scripts/visibility-judge-check.js`），
  本域的 ① 就是它认的"给了真判据"那一条。
- ⚠️ **注入必须打在"真接缝"上**（本轮踩到并修正的空转门禁）：第一版注入替换的是 `MM.fdSatellitePlan`，
  而 `syncFdSatellites` 当时按**局部函数名**调用 ⇒ **注入完全无效、三条断言"绿着通过"**（没红过的不算门禁 ✗）。
  修法两头做：① 产品侧那一跳改成走 `MM.fdSatellitePlan`（真接缝）并在该处留注释；
  ② 本域全部注入改到真接缝 —— 改完 7 个注入**逐个都能红**（报文见提交信息）。
- **一条不是"顺手"的取舍**：工具条的默认档不翻转也不夹取（相对坐标才恒定，用户要的"同步跟随"才可判）；
  只有真的放不下才翻 —— 本工程既有实测教训「翻转 ⇒ 上下区间跳」，故把翻转限制在"不翻就看不见"的情形。

#### 四、实测（2026-10-09）

| 项 | 结果 |
|----|------|
| 冒烟断言（真值 = `docs/VERIFY.md`） | 185 → **197**（新增域 `37-圆钮工具栏绑定.js`，7 条） |
| 全量冒烟 | 全过（含视觉断言 2/2、真实数据零写入） |
| 单元测试 / CLI 集成断言 | 全过 / 未受影响 |
| 判别力证明 | 7 个 `MM_SMOKE_INJECT=37-<key>` 逐个 ⇒ **目标那条必红、其余仍绿** |

#### 五、只能真机复核（自动断言覆盖不到）

① 真实鼠标手感；② 观感是否仍是设计意图（浮层与框的层次、圆钮/工具条位置读起来是否自然）；
③ 高 DPI 缩放与多显示器下的落位（真输入走真实输入管线，但不是真实硬件）；
④ 工具条"默认不翻转、放不下才翻"的取舍在长框/贴边时是否可接受；
⑤ 中文输入法在工具条与 AI 浮窗输入框里的行为（既有未覆盖项）。

### 可见性判据门禁（V1）：声明"看得见"就必须给真判据 —— 真输入 / 真像素（2026-10-09）

**这条门禁的来历是一次真事故**：用户报「关联视图的圆钮看不见」，而当时守着它的断言**全是绿的**。
查下来界面代码没错 —— 错的是**我们判"看不见"的方法**：断言用 `getBoundingClientRect()`（以及类名 /
`style.display`）判可见，而这几样对**裁切**与**遮挡是盲的**。
实测同一条圆钮：被父元素 `overflow:hidden` 裁掉时与正常显示时，`rect` 读数**完全相同**；
而同一区域的真帧像素是 **81 px vs 768 px**（判据见 `scripts/vision/frame-stats.js` 的 `scanRegion`）。
⇒ 这一类断言在"元素还在、只是用户看不到"时照样绿。本次要推广到整个验证体系的，就是这一条纪律。

#### 一、机械门禁（本次交付的主体）

- **`scripts/visibility-judge-check.js`（新，门禁 V1）**：纯文本扫描 `scripts/smoke/*.js`，凡**名字**里声称可见性
  （可见 / 不可见 / 遮挡 / 面板内 / 框外 / 看得见 / 看不见）的断言，判据必须出现下列之一 ——
  `document.elementFromPoint` 命中测试（抓遮挡）· 真帧像素（`scanRegion` / `isAccentBlue` / `bitmapInfo`，抓裁切）·
  一行显式豁免 `判据-豁免: <原因>`；否则**判红**，报文给 `file:line + 断言名 + 原因 + 修法`。
  **不做重活**：不起 Electron、不起服务、不联网，实测 ≈0.3 s（预算 10 s），挂进 `STEPS` 第 4 步（紧跟 G9）。
- **三处判定细节都是踩出来的**（写下来免得下一个人再踩）：
  ① **同文件 JS 片段常量要展开** —— 域 34 的真判据（`getBoundingClientRect` / `offsetParent`）全写在文件顶部的
  `BTN_JS` 里；只扫断言体会把**事故现场那一条**判成"没有判据" ✗；
  ② **判据要是代码**：去注释，且抹掉 `name` 那个字符串 —— 第一版门禁就栽在这（域 37 那条合规断言的**名字里**写着
  "elementFromPoint 命中"，于是把代码里的判据抹掉后门禁照样绿，是个**空转的门禁** ✗，与工程此前
  "注入违规后 exit 0 没变红"同型）；
  ③ **名字含词但体内没有任何可视判据的不判红**（"写后重读可见""变更可见性""桩标记可见"这类是数据 / 文案语义）——
  只提示改名，因为造**必然假红**的门禁等于没有门禁；另设触发数下限，防"把名字里的词删掉"绕过 ✗。
- **既有欠账只减不增**：门禁上线时仓库里已有 7 处这类断言（其中 3 处正是本次事故现场：域 34 两条 + 域 35 一条；
  另有域 05 / 08 / 12 的旧断言）。它们先记进 `DEBT`（`--debt` 打印"为什么是欠账 + 怎么迁"）：
  **在册的算欠账、不在册的一律判红**；欠账修好却忘销账 ⇒ **判红**（封闭清单，逼人销账）。
  为什么不直接判红：长期变红的门禁下场是被关掉 ✗。为什么迁移推迟、以及只能真机复核的项，见第四节。

#### 二、判别力证明（门禁自己先红过，且每次都能重放）

- `node scripts/visibility-judge-check.js --selftest`（**不碰任何文件**，只在内存里注入）：基线绿 ⇒
  ① 抹掉样板断言的 `document.elementFromPoint` ⇒ **必红**；② "名字里写着判据、代码里只有 rect" ⇒ **必红**；
  ③ 用原始字节重算 ⇒ **必绿**。同一套注入也在 `tests/visibility-judge-check.test.js` 里（可重复重放 ✓）。
- **落盘注入也做过一次**：临时放入 `scripts/smoke/99-判据注入探针.js` ⇒ 门禁 exit 1
  （报红样例：`scripts/smoke/99-…js:11　注入探针：圆钮**完整落在面板内**、看得见（只用 rect 判 ⇒ 门禁必须红）`
  ＋ 原因"体内只有 getBoundingClientRect（几何）" ＋ 修法两条）；取走该文件后 `scripts/smoke` 目录指纹
  **逐字节还原**（`dirsha256` 前后同为 `c5722546…de473`，36 个文件）✓。
- 同批更新：`tests/verify-budget.test.js`（链上顺序锁）、`tests/changed-plan.test.js`（V1 归"恒定跑的廉价门禁"）、
  `scripts/changed-plan.js`（`FULL_STEPS` / `ALWAYS`）。

#### 三、能力边界（诚实标注，别以为它包住一切）

- 它查**判据的来源**，查不了**判据用得对不对**（`elementFromPoint` 也能传错坐标 ⇒ 照样绿）—— 那一层只能靠读图与真机复核；
- 名字里不写可见性词的断言它抓不到 ⇒ "**名字要说清凭什么判**"是配套纪律（名字是这门禁的输入 ✗）；
- 它只管"有没有真判据"，**不管阈值取多少**（阈值单源仍在 `scripts/vision/thresholds.js`）。

#### 四、欠账与推迟（接手者必读）

- **`docs/RULES.md` §2 的 V1 登记未完成**：该文件此刻是**另一个会话的脏文件**（本会话被禁止提交它），
  而 §2 是门禁编号的唯一权威 ⇒ 本门禁先以 **V1** 挂牌（不是 G 号），登记落在 `docs/ARCHITECTURE.md` §2.6。
  待该文件交回后并入 §2：改 `scripts/verify.js` 的 gate 串、`docs/ARCHITECTURE.md` §2.6 那一行、两处 `tests/` 期望。
- **第二步（把 7 处欠账逐条迁到 `elementFromPoint` / 像素）推迟**：另一个会话此刻正在改同一批文件
  （`renderer/*` + `scripts/smoke/{25,26,34}-*.js`，`git status` 不干净）⇒ 并发改同一批文件会互相覆盖
  （本工程丢过两次工作）。迁移清单当场取：`node scripts/visibility-judge-check.js --debt` —— **不在文档里抄一份** ✓。
- **只能真机复核的项**：① 像素阈值具体取多少（门禁只保证"判据是真判据"，不保证"阈值定得对"）；
  ② 圆钮 / 悬浮工具条在真机各档布局（窄主区、大小锁、多详情框）下是否真的看得见；
  ③ 迁移时"该用命中测试还是该用像素"的选择，仍需人看图判断。

### 真机反馈的两个 bug：修 Ctrl 加选的虚线描边 + 「💬 问这 N 个」的 N；并把「模拟人类操作 + 可视化证据」做成冒烟底座（2026-10-09）

**用户质问**：「你有没有做模拟人类操作的可视化测试？！！」

**先认账**：在本次之前，冒烟里的"点击"绝大多数是 `dispatchEvent(new MouseEvent(...))` —— 那是**直接派发到已知元素**，
**整条绕过** Chromium 的输入管线（命中测试 / 修饰键 / hover / 指针捕获 / 拖拽阈值 / 浮层遮挡）。
这类缺陷因此天然测不到：**合成事件永远点得到，而真人永远点不到**（工程里 25-域记过同一起"断言绿、功能坏"的真实事故）。
只有 5 个域在用真输入（25/26/29/30/33），而且各自抄了一份 `mouse()`/`click()`，
**没有一处把"截图画面上到底画没画出来"当判据**（截图只写不读）。

#### 一、底座（先做，本轮的验收标准就是它能复现这两个 bug ✓）

- **`scripts/smoke-input.js`（新，唯一实现）**：用 Electron 自带的 `webContents.sendInputEvent` 发**真实**鼠标/键盘事件
  （`mouseMove/mouseDown/mouseUp/mouseWheel` + `modifiers:['control']` + `char`/`keyDown`）＋ `capturePage` 截图证据，
  **零新增依赖**。事件序列是**纯函数**（可单测），驱动带 `click/drag/wheel/typeText/pressKey/settle/shot`。
- **接线**：`sendInputEvent` / `capturePage` 都是**主进程** API，而冒烟断言本身就跑在主进程
  （`ctx.exec` 只是主→渲染的桥）⇒ 直接挂在 `ctx.input` 上，**不需要也不引入 IPC 通道**（少一个没有调用方的通道 ✓）。
  "非冒烟模式完全不可用"由**三重**保证：① 只在 `runSmoke()` 里构造；② `createDriver()` 见 `isSmoke !== true` **直接抛**；
  ③ `tests/smoke-input.test.js` 有单测 + **源码级接线检查**（照 `smoke-flags.js` 那套）。
- **像素判据进 `scripts/vision/frame-stats.js`**（`scanRegion` / `isAccentBlue` / `bitmapInfo`）：在节点**外圈带**上数
  "高饱和强调蓝"（`#1664ff`）像素，**通道序无关**（与既有契约一致 ✓），挖掉浮层矩形，给出**单行最长连续段**
  （用来分辨"虚线"与"实线/整条色带"）；阈值单源在 `thresholds.js` 的 `dashStroke`。
  **`bitmapInfo` 位图与 `getSize` 对不上时返回 `ok:false`** —— 采不到真值 = 红，不许按猜的尺寸数像素 ✗。
- **新冒烟域 `scripts/smoke/36-real-input.js`（5 条断言，冒烟真值 185 → 190）**：
  ①真鼠标点中 `<jmnode>`（命中测试走通 ⇒ 按被点节点打开详情框，含"点空白不弹"对照组）
  ②Ctrl 依次加选 3 个（含父子）⇒ **3 个都真的有虚线描边**（DOM 类名 + 计算样式 + **像素**）且**没有大虚线框**、N=3
  ③再 Ctrl 点一次那个"只进了原始集"的子节点 ⇒ **真的取消加选**（描边与像素一起消失）且 N 立即回落
  ④「💬 问这 N 个」的 N = 真的带描边的节点数 = **点击后真正送出去的节点数**（真点按钮 + 真键盘输入 + Enter，读桩回显）
  ⑤点空白清选区 ⇒ 描边真的消失（不留残影）
  截图落 `.review/20261009-真输入可视测试/shots/`（**不进版本库** ✓），**判定用的那帧就是落盘的那张**（同源可复核 ✓）。

#### 二、真因（先复现，再改；不是猜的）

**两个 bug 是同一个根因的下游症状**，都在 `renderer/app-view.js` 的**选区双口径**上：

1. **`toggleNodeSelection` 拿「裁剪集」判"这个节点在不在选区里"** ✗
   —— 裁剪集（`fdSelection`）是**给树操作定义的口径**（剔父冗余 + 同父只留一组），父也在选区时它的子节点会被剔出去；
   而描边画的是**原始命中集**（`fdSelectionRaw`）。于是拿裁剪集判"在不在"**永远判不在** ⇒
   再点一次取消不掉、且下一次点别的节点时 `fdSelection.concat([id])` 会把那个子节点**冲掉**。
2. **`clearSelection()` 只清裁剪集、不重绘描边** ✗ —— 有"我点过谁"（`fdSelectionRaw`）与 `mm-sel-raw` 类
   留在节点上 ⇒ 点空白也擦不掉，而且画面上的描边与工具条 N 从此对不上。
   （一个旁证：31-域的收尾**不得不手动补一句 `MM.paintRawSelection()`** —— 测试在替产品擦屁股，正是这个缺陷。）

**实测报文（真输入，修复前；坐标/读数逐字取自冒烟输出）**

| 断言 | 修复前 | 修复后 |
|------|--------|--------|
| ② Ctrl 点 `wlan-book(459,351)` → 子 `wlan-01(648,119)` → `comp-net(55,438)` | raw=[wlan-book,**comp-net**]（期望 3 个）｜`wlan-01:none`（**描边消失**）｜像素外圈带 `0→0`｜N=**2** | raw=[wlan-book,wlan-01,comp-net]｜三个都 dashed 2px｜像素 `0→217`｜N=**3** |
| ③ 再 Ctrl 点一次子节点 `wlan-01` | raw **仍是** [wlan-book,wlan-01]（取消不掉）｜像素 `231→231`｜N 仍 2（没回落） | raw=[wlan-book]｜像素 `231→0`｜N=1、文案回落「💬 问问AI」 |
| ④ 选中 3 个后点「💬 问这 N 个」 | N=2、桩回显「收到节点数：2」（用户点了 3 个） | N=3、标题「AI 问答：3 个节点」、桩回显 3 |
| ⑤ 真点空白处清选区 | raw 与描边类**都还在**｜像素 `403,231→403,217` | raw=[]、带描边节点=[]｜像素 `→16,0` |

**修法（两处，带理由）**

- `toggleNodeSelection`：判据与并集的基都改用 **`fdSelectionRaw`**（用户"点过谁"的唯一真源 ✓）—— 裁剪集继续管树操作，两者分工不复述、也不合并。
- `clearSelection`：**同时清原始命中集并重绘**（把类真正摘掉，而不是只把大框藏起来 ✓）。
- 连带澄清：`MM.hasSelection()` 改读原始命中集（"有没有选区" = "有没有节点被描边"），
  否则工具条 `barTargets()` 会在"画面有描边但裁剪集为空"时退回单节点分支 ⇒ N 与实际参与提问的集合对不上。

#### 三、判别力证明（纪律：新断言先注入一次违规、确认变红、再撤销）

`MM_SMOKE_INJECT=<key>` 只在本域生效（测试侧注入，不动产品代码；默认空 ⇒ 正常跑不受影响 ✓）。实测结果：

| 注入 | 目标断言 | 实测（红） |
|------|---------|-----------|
| `miss-click`（把点击坐标挪出节点） | ① | `点后详情框=0 属主=null` ⇒ 红（证明"点中"这件事真被判了） |
| `invisible-outline`（给选中节点加 `outline-color: transparent`） | ② | **DOM 类名 ✓、计算样式 `dashed 2px` ✓、像素 `16→16 / 0→0 / 15→12` ⇒ 红** —— 只有像素判据抓得住"画面上其实没画出来"，这就是它相对 DOM 判据的**唯一**价值 ✓ |
| `big-box`（把大虚线框画出来） | ② | `大虚线框 DOM可见=true 像素带命中=134（阈值 ≤24）` ⇒ 红 |
| `ask-count`（把工具条文案改成"问这 9 个"） | ④ | `文案="💬 问这 9 个"（文案里的数=9）` vs `data-count=3` ⇒ 红 |
| `stale-raw`（造出"清选区后描边残留"的旧缺陷态） | ⑤ | `raw=[wlan-book,wlan-01] 描边=[wlan-book,wlan-01] 像素 403,220` ⇒ 红 |

每次注入**只有目标那条变红**（`12/13 passed`：01-域 8 条 + 本域另 4 条全绿 ✓），撤销后本域 5/5 全绿 ✓。

#### 四、连带核对（R5：判据是"人按原习惯操作还是不是设计意图"，不是"测试还绿"）

| 使用者可见面 | 结论 |
|--------------|------|
| Ctrl+点击加选/取消加选 | **变**（就是修的目标）：描边与"我点过谁"一致；父+子+第三点不再丢描边；再点一次真能取消 |
| 工具条「💡 解释 N 个 / 💬 问这 N 个」 | **变**：N = 用户实际点选的节点数 = 真的带描边的节点数 = 真送出去的集合（三者同源 ✓） |
| 点空白/切项目/右键「清除框选」清选区 | **变**：描边真的消失（原先留在画面上直到重排） |
| 右键菜单（"框选专属"那张） | **无影响**：判据从裁剪集改读原始命中集，两者在"有描边"时同时非空（唯一差异是"只选中了容器根"这类边界，行为更符合直觉） |
| 框选（非 Ctrl）/ 拖动/收起/关联视图/DSH 侧栏 | **无影响**：裁剪集口径与树操作路径未动（29/30/31/33/34/12 域全绿复核 ✓） |
| `README.md` / `docs/AI-GUIDE.md` | **无影响**：两份都没写 Ctrl 多选与 N 的文案（已核对 ✓）—— 只更新了 `docs/ARCHITECTURE.md`（§2.6 登记新脚本 + app-ask 行的 N 口径）与 `docs/ROADMAP.md` 的真机复核项 |

#### 五、只有真机/真人能验的部分（如实标注，不冒充已测）

- **手感**：描边的粗细/颜色好不好看、连点的手感、工具条弹出位置是否顺手 —— 门禁抓不到（R5 残差）。
- **真硬件差异**：本域走的是**真实输入管线**但**不是真实鼠标**：高 DPI 缩放、系统鼠标加速、多显示器、
  中文输入法（本域键盘只发 ASCII，非 ASCII `char` 属**未验证**区间）都还只有真人能判。
- **已知边界**：隐藏窗口的 `capturePage()` **可能给旧帧**（17-域有实测记录）⇒ 像素判据一律做成**前后差分**
  并允许有限次重拍：旧帧只会造成**假红**、不会造成假绿 ✓（这也是为什么"数字与图片必须同源"）。


### 渲染库（jsMind）适配层落地：把"换库"变成只改一个文件 + 内部耦合成表（**纯重构，行为不变**）

**起因与结论（可引用）**：起因是"渲染库要不要换个更好的、要不要重构"这次评估。
结论 = **有条件地不换**（置信度 0.8）。依据是把集成面分成两半看：

- 约 **1/3 是可移植的公共 API**（迁移前 83 处调用点）—— 换库时这半边"白送"；
- 约 **2/3 是我们主动接管渲染层内部**（14 类符号 / 75 个代码行：`view.relayout`、`show_lines`、
  `e_panel`、`<jmnode>`/`<jmnodes>`、`jmexpander`、`zoom_current`、`layout.is_visible` …）。

换库会**淘汰便宜的 1/3、重建最贵的 2/3**，还要重付一份"渲染几何类冒烟断言"的回归成本 ✗。
所以不换，但把便宜那一半收进适配层 —— 将来真要换，改动面落在**一个文件**上。

**做了三件事**

1. **`renderer/mindmap-adapter.js`（新）** —— 12 个语义函数覆盖全部公共 API 调用点，全工程唯一的
   调用形状是 `MM.adapter.X(jm, …)`：`getNode` / `getRoot` / `getSelected` / `available` /
   `selectNode` / `addNode` / `updateNode` / `removeNode` / `expandNode` / `collapseNode` /
   `expandAll` / `loadTree`。
   - **纯转发**：不判空、不兜底、不吞异常、不 try/catch ⇒ 与直接调库**逐字同义**。
   - **`jm` 显式传参**，不从 `state.jm` 内部取：`renderMind()` 里 `new jsMind(…)` 与 `jm.show(data)`
     发生在 `state.jm = jm` **之前**，内部读全局态会在那个窗口里取到上一次的实例（静默错误）。
   - `renderer/*.js`（不含适配层）里的公共 API 调用点：**83 → 0**。
   - 另补：`editor.js` / `contextmenu.js` 原先**没有 `MM` 绑定**（只用 `window.MMApp`），
     走 `MM.adapter` 就必须显式持有它 —— 同批补上，不依赖"`window.MM` 恰好能当裸标识符解析"。

2. **`renderer/vendor/JSMIND-INTERNALS.md`（新）** —— 我们**主动接管的内部**逐条给 `file:line`：
   14 类符号 / 75 个代码行的位置 + 三个"整体替换"的库方法（`view.set_zoom` / `zoom_in` / `zoom_out` /
   `view.show_lines`）+ **刻意不用**的三个（`view.reset`、`get_node_point_in/out`，附历史事故）。
   **升级 jsMind 时人工回归的就是这张表**；行号会漂移，文件里给了重算命令。

3. **登记**：`docs/ARCHITECTURE.md` §2.1 的 `vendor/jsmind.js` 行写明 **版本 0.9.1** 与
   "升级前必须先读 `JSMIND-INTERNALS.md`"；新增 `mindmap-adapter.js` 行；
   **顺带更正**加载顺序清单漏列的 5 个模块（`related-model` / `sidebar-context` / `app-related` /
   `app-ask` / `app-import`）。

**行为不变量（判据，不是"测试还绿"）**

| 判据 | 迁移前 | 迁移后 |
|------|--------|--------|
| 冒烟断言（真值 = `docs/VERIFY.md`） | 185/185 通过 | **185/185 通过**（条数未变） |
| 视觉断言（L2 ROI） | 2/2 | **2/2** |
| 单元测试 | 853/853 · 48 文件 | **853/853 · 48 文件** |
| CLI 集成断言 | 216 | 216（迁移未触碰 CLI） |
| 真实数据写入 | 零 | **零**（跑完 21 个文件逐字节一致） |
| `renderer/*.js` 语法 | — | 全部 `node --check` 通过 |

**判别力证明（注入违规必须红；没红过的不算门禁）**

冒烟套件是这次改动唯一能守住行为的安全网（渲染层没有单测）。它真的在看适配层吗？实测：

1. 注入：把 `getNode` 改成 `return undefined`（`SHA256 9FCC…9E40 → A24C…5EDDA`）；
2. **变红**：`SMOKE_ONLY=01 npm run smoke` ⇒ `过滤运行 6/8 passed`、退出码 **1**，
   报出 `[FAIL] click node → float detail shows`、`[FAIL] float detail sits below its node box`；
3. 撤销：从备份逐字节还原（`SHA256` 回到 `9FCC…9E40`，注入标记已不存在）；
4. **复绿**：同一条命令 ⇒ `过滤运行 8/8 passed`、退出码 **0**。

⇒ 适配层在**真实执行路径**上（不是没人走的摆设），且冒烟对它**有判别力**。
（完整报文：`.review/20261009-渲染库适配层/` —— 工作产物区，可随时删除。）

**顺带的一次取证更正（"结论对、根因错"）**：`app-detail-content.js` 顶部原注释写
"jsMind 0.9 不派发 select 事件"。实测**这句话是错的**：

- vendor bundle 里 `invoke_event_handle` 共 **12 个派发点**（`show`×3 / `resize`×1 / `edit`×7 /
  `select`×1），`select` 那个就写在**公开方法 `jm.select_node()` 的函数体里**；
- 编程调 `jm.select_node('a')` 派发 **1** 次，真点一下 `<jmnode>` 也派发 **1** 次，
  `code/evt` **完全相同** ⇒ **两条路径命中同一个派发点**，"编程不派发、只有点击派发"不成立；
- 会看混的是**同名**的 `view.select_node()` —— 只有那一层是"只改 selected 样式、不派发"。

**但"必须在 DOM 层接管"这个结论仍然对**，理由换成四条实测：点空白**根本不派发**（走
`select_clear()`，全链 0 派发，而我们要靠"点了空白"关详情框）· 派发是**异步**的
（`setTimeout(…,0)`）· 节点**不可见就不派发**（`layout.is_visible` 守卫）· 载荷里**没有 Ctrl/Cmd**，
而 Ctrl+点击在本工程是"加选"。真正的理由仍是"要的是**库里没有的模型**"：
多选 / 框选 / 非选中节点虚化 / 关联高亮（jsMind 只有**单个** `mind.selected`）。

**已知缺陷（如实记录，本次纯重构按原样保留，没有顺手"修"）**：`app-actions.js` 的
`addSiblingNode` 想"把新节点插到所选节点之后"，于是给 `add_node` 传了第 6 个实参
`sel.index + 1` —— 但 jsMind 0.9.1 的公开 `add_node(parent, id, topic, data, direction)`
**只有 5 个形参、没有 index**，那个实参**一直被静默丢弃**，新节点实际追加在**父节点末尾**。
修它属于**行为变更**（换了落点），应另开一次改动并补一条"落点"断言；本条目只在调用点留了醒目注释。

**三个重新评估的硬触发（满足任一就该重开这次决策）**

1. **jsMind 连续 > 18 个月无发布**（"库很老"才真正成立；当前反例：0.8.6 → 0.9.1 一路在发，
   vendor 里就是 npm 最新版 0.9.1）；
2. **需要虚拟化 / 万级节点而现库做不到**（那是库层面的能力缺口，适配层解决不了）；
3. **适配层落地后，数据显示那 7 项深度改造（渲染几何/连线重写/统一 transform/主题分侧/框选与
   关联高亮的渲染）成了 bug 的主要来源** —— 即"贵的那 2/3"开始自己制造缺陷，而不是在提供价值。

### 两个 ✕ 改成**真关**：导图页从内存里卸载、侧栏视图真正销毁（用户明确选了"内存里真的不留页面"）

**根因（两处"关"其实都不是关）**：
- **导图页 ✕** 原来只给 `body` 加一个 `dsh-only` 类（CSS 把 `#main`/`#toolbar` 设成 `display:none`）
  ⇒ 导图页的 DOM、jsMind 实例、全部视图模块**都还活在内存里**；
- **侧栏 ✕**（`closeSidebar()`）只 `removeChildView`，把那个 `WebContentsView` **从窗口上摘下来挂着**
  ⇒ DSH 页面与它的 JS 堆照旧活着。
用户明确选定语义：**"关"就是内存里真的不留这一侧的页面**（并接受"重开要重新加载 ⇒ 比原来慢"这个代价）。

**导图页那一半（关键认知：它不是独立窗口，它就是主窗口的渲染层）**
- "真关"只有一条路 —— 让主窗口**导航到占位页**：新增 `renderer/map-closed.html`
  （写清"已关闭 + 三个回去的入口"，不留一片白 ✗）。
  **实测报文**：`index.html → map-closed.html`；页内 `#main=false`、`MMApp=false`（两者都不存在了，
  而旧"隐藏"实现下两者都在）；`getOSProcessId()` 前后相同 ⇒ **渲染进程被复用，被卸载的是旧文档
  （DOM + JS 堆）** —— 文档只按这个实测口径写，不写成"渲染进程被替换"。
- **关之前先拦未保存编辑**（不许省）：有脏改动 ⇒ 弹「保存后关闭 / 取消」，**复用既有** `save()`
  （含并发冲突保护：`MERGE_CONFLICT` / `RACE_RETRY` 都还在那条路上）；**保存没成功就不关**。
  脏标记只活在渲染层内存里（页面一卸载它也没了）⇒ 这件事**只能**在卸载之前做。
- **重开**（占位页按钮 / 菜单「视图 → 重新加载思维导图页」/ 侧栏控制栏「⤢」/ CLI `sidebar-only off`）
  = **重新加载** `renderer/index.html` + **还原停靠宽度** + **回到上次的项目**。后两项由**主进程**记
  （`project:read` 时 `setCurrentProject()`，落 `userData/dsh-sidebar-prefs.json`；页面 boot 时问一次
  `dsh-sidebar:boot-project`）—— 页面自己记不住，它已经被卸载了。**正常启动不武装这个提示** ⇒ 启动行为不变 ✓。

**侧栏那一半**：新增 `destroyView()` —— 摘下来 + `webContents.close()`（**真的销毁**）+ `state.view` 置空；
重开走既有 `ensureView()` 重建（**新** webContents ⇒ 页面重新加载）。
判据字段进 `getStatus()`：`hasView / viewId / viewEpoch / lastDestroyedViewId`（`dsh-status` 白名单里也放这几个，
不含 url/token ✓）。**实测**：关后 `hasView=false viewId=null lastDestroyedViewId=2`、`webContents.fromId(2)`
已取不到；重开 `viewId=4`、`viewEpoch 1→2` ⇒ 确实是**新视图**，不是把旧的又挂回来。

**副作用：都同批处理了，不留给人踩**
- **关闭期间把发往导图页的菜单项置灰**（16 条：保存/撤销/重做/新建·编辑·删除节点/展开收起/命令面板/
  关系审计 + 文件菜单 6 条导入导出）：否则点下去只是"发进一个空页" —— 又一种"没反应" ✗。
  重开后恢复；「重新加载思维导图页」在**关着时**才可点（两个入口按状态互斥）；菜单入口也从
  「视图 → 仅 DSH 侧边栏」（勾选项，语义是"隐藏"）换成「关闭思维导图页（只留 DSH 侧栏）」。
- **关闭期间控制栏拖宽不响应**：那时侧栏铺满整窗，拖宽既看不出效果、又会把"重开时要还原的停靠宽度"
  改坏 ✗（这是"重开还原宽度"能成立的**前提**，所以宁可明确不响应并记日志，也不静默改坏）。
- **控制通道不受影响（核对后的事实，写进注释）**：那个 400ms 轮询在**主进程**
  （`main.js` 的 `startControlChannel`），不在渲染层 ⇒ 卸载期间 `dsh-status` / `sidebar-only` /
  `dsh-prefill` 照常工作 ✓。受影响的只有"发给导图页渲染层"的菜单项（就是上面那条）。
- **CLI 与界面在脏改动上的分工**：`sidebar-only on` 遇到未保存编辑**直接拒绝**（回执里带原因，
  **不弹模态框** —— AI 调用时没人保证有人在看，弹窗会把调用方挂死 ✗）；界面上的 ✕ 弹确认框（人在）。
  `cli/commands/ui.js` 同时把"界面**拒绝了**"与"界面**没响应**"分开报（原先一律说"主界面没有响应"，
  会把人引到错误的排查方向）。
- **连带发现（如实记录，本次不顺手改）**：`main-dsh-sidebar.js` 的 `hideWindowToBackground()` /
  `hideToBackground()` **没有任何调用方** ⇒ 旧 README 那句"仅侧栏模式下 ✕ = 隐藏到后台"与实现不符
  （实际是"窗口 ✕ = 退出应用"）。本次按**实际行为**改写文档，**没有**去实现那个后台隐藏
  （那是另一个决定，不在本卡范围）。

**判别力证明（每处注入一次违规，确认变红，再撤销；撤销后逐字节还原，比 sha1）**
- 注入 A「导图页只隐藏、不导航」（把 `loadFile(mapClosedPage())` 换成空操作）+ 注入 B「菜单不置灰」
  ⇒ 冒烟 23：② 红（报文：`【页】index.html → index.html｜#main=true MMApp=true｜【菜单】禁用 1/30 项`）、
  ③ 红（`关着时禁用 1 → 重开后 1`）；**① 仍绿** ⇒ 注入是"定点"的，且这一轮不是整体坏掉。
- 注入 C「`closeSidebar` 只摘视图、不销毁」+ 注入 D「渲染层省掉'先拦未保存编辑'」
  ⇒ 冒烟 24 红（`旧 view id=2 ⇒ hasView=true viewId=2 lastDestroyedViewId=null 旧 id 已取不到=false`、
  `新 id=2 epoch 1→1`）、冒烟 23① 红（`确认框被问=-1 次`、`这一页还在：MMApp=false`、`mapPageClosed=true`）、
  23② 红（`【盘】探针在盘上=false` —— **省掉保存直接卸页 = 丢改动**，正是最重的损害类别）。
- 撤销后哈希逐字节还原：`main-dsh-sidebar.js ee2794cdb13f`、`main.js fd4a033ea445`、
  `renderer/app-actions.js 17c06e920692`；复跑 12/12 绿（exit 0）。
- 顺带修了断言本身的脆弱点：注入 D 第一次跑时整轮冒烟**挂到守卫超时**（页面被卸载 ⇒ 页内 Promise 永不 settle
  ⇒ `executeJavaScript` 永不返回）⇒ 冒烟 23 的页内调用一律加超时、超时当**结构化失败**回报（"红得有话说"）。

**连带面（R5：改变"某功能如何被使用"时逐个核对使用者可见面）**
- 渲染层：`renderer/app.js`（✕ 与菜单事件）、`renderer/app-actions.js`（`closeMapPage` + boot 项目）、
  新增 `renderer/map-closed.html`；`preload.js` 的 `desktop.dsh` 去掉 `sidebarOnly`、加
  `closeMapPage/openMapPage/bootProject` ⇒ 冒烟 11 的**刻意手写白名单**同批更新 ✓。
- 断言：`scripts/smoke/23-dsh-only.js` 重写（拦脏 / 真卸载+菜单置灰 / 重开还原三段，每段自建前置）、
  `scripts/smoke/24-sidebar-close.js` 增销毁取证；`scripts/smoke/11-dsh-sidebar.js` 白名单。
- CLI：`cli/registry.js` + `cli/commands/ui.js`（文案与失败口径）⇒ `docs/CLI.md` 同批重生成 ✓；
  `src/dsh-sidebar-skill.js`（侧栏 AI 的操作说明 + 一条边界：这条命令会真卸载、脏改动会被拒）。
- 文档：README「两条对称能力」与「三条操作语义」两张**语义表**、`docs/ARCHITECTURE.md`
  （§2.2 / §2.4 / §4b ADR「两个 ✕ 都是真关」）、本文件。
- 数据格式 / CLI 命令数 / MCP 工具数：**无影响**。
- 顺手修：README 那行手写的侧栏宽度范围 `280–720px` 早已过期（上限早在"内核右栏自动加宽"那轮提到
  900）⇒ 改成 280–900。

**⚠️ 只能真机验（headless 覆盖不到 —— 已在冒烟里覆盖"机制"，但下面三件需要你在真机上复核）**
1. 重开后是否**真的**回到你原来的项目与侧栏停靠宽度（冒烟用 comnet + 512px 验的是机制）；
2. 占位页按钮 / 菜单回开的**观感**（本来就会比"隐藏恢复"慢，因为要重新加载整页）；
3. 关闭导图页期间侧栏对话**完全不受影响**（本卡只断言"侧栏视图还在、服务没被动"，
   没有真的起服务跑一轮对话）。

### 关联视图里能**人工编辑关联信息**了（用户需求：加/删链接 + 新建关联笔记）

**根因（"看得见、改不动"）**：关联视图（功能 2）把关联节点高亮并画出关系线，但那条信息在界面上**只能看**：
补链接只有关系审计面板有、**删链接只有 CLI**、关联笔记**只能改 AI 已经写好的那篇**（界面没有创建入口）
⇒ 人在图上看到一条错的边，唯一的办法是去敲 `node cli/mm-cli.js unlink …`。

**做了什么**：进视图（三个入口都行：详情框左缘圆钮 / 右键菜单 / 命令面板）后，面板顶部出现**「关联信息」编辑条**：

- **链接清单两个方向都列**：出边（→ 我引用谁，来自 `related` 的 dir=out/both）+ 入边（← 谁引用我，
  来自 `backlinks` 的 within+cross），每条一个 ✕；互指的 A↔B 显示**两行**（本来就是两条独立的边）。
  **入边可能写在别的项目里** ⇒ 删除时按 CLI 的签名指定"那条边属于谁的项目"（`unlink <来源项目> <来源id> --to <目标项目> --id <目标id>`）。
- **➕ 添加链接**：输入即搜，**复用命令面板那一套**（`desktop.app.nodes` + `src/palette-rank.js` 的 `rankPalette`）——
  不在渲染层另写一套模糊排序；候选已排除"自己"与"已经链接过的目标"。
- **📝 新建关联笔记**：成员用小标签列出（**中心节点预置**），**至少再加一个**才能提交；标题 + Markdown 正文。

**两条新 IPC（写完回读）**：`app:unlink-nodes`、`app:assoc-add`（`preload.js` 暴露 `unlinkNodes` / `assocAdd`）。
两条都**只经 CLI**（校验闸门 + 原子写 + 并发重放），且**写完回读**：

- `unlink` 后回读该节点剩下的出边，并**裁成契约形状**（只留 `project`/`id`/`caption`）—— 渲染层会拿它去同步内存树，
  而内存树在下一次保存时整树写回磁盘，把 CLI 视图字段（`node`/`topic`）存回去就是污染契约（与 `assoc-edit` 用 `--raw` 同一回事）；
- `assoc-add` 后回读 `assoc-list --json --raw` 并**认出新增那篇的 id**（写前先回读一次 id 集合，写后取差集）——
  **不解析给人和看的 stdout**（那是中文句子，改一个字就坏）；**写前回读失败 = 直接判失败**（拿不到真值不猜、不写）。

**写后同步内存（本工程反复踩过的那条纪律）**：界面保存写回的是内存里的节点树，而链接/关联是 CLI 写的 ⇒
不同步就会"刚写完，下一次保存又覆盖回去"。故：

- 链接：**`MM.applyLinkToMemory` 是唯一实现**（app-related.js）——审计面板的补链接、编辑条的添加/删除三处共用
  一份"怎么改内存"（原先 `app-audit.js` 里内联，已改为调用它）；
- 关联：**`MM.syncAssocRaw` 是唯一实现**（app-assoc.js，**按 id 合并、不能整体替换**）——详情框、页内编辑、
  新建三处共用（`app-detail-content.js` 原先自己抄了一份合并逻辑，已改为调用它）。

**编辑条不让位就会遮住节点**：`fitToNodes(ids, insetTop)` 新增顶部让位 —— 编辑条压在面板顶部，
若还把节点居中到面板正中，最上面那排会被它盖住，"刚好框住"就名不副实（与"圆钮不许进框内"同一条纪律）。

**顺带修掉两处跨域状态泄漏（都不是本功能的缺陷，是被本功能的断言照出来的）**：

- **域 08 把审计面板开到了下一个域**：域 08 给审计面板「补链接」，而 `addLinkFromAudit` 结尾会 `openAudit()` ——
  它自己的收尾注释写着"不给后续断言留一个开着的面板"，但只关了命令面板。实测代价：审计卡 720x668 盖住屏幕中部，
  域 25「点线 ⇒ 按鼠标位置开笔记」采到的点正好落在卡上，**真鼠标点击打到审计列表** ⇒ 打开的是另一篇笔记且没有大锁（红，
  且看不出跟域 08 有关 ✗）。修法：域 08 收尾把审计面板一起关掉（在**制造它的地方**收口）；同时把域 25 的采样判据从
  "在视口内"收紧到**"真的是最上层元素"**（`elementFromPoint`），报错时打印最上层元素的祖先链 —— 真人同样点不穿一个全屏模态。
- **域 25 把高亮/编辑条开到了下一个域**：它的最后一条（⑦c 性能）自己 `showRelated` 了一次，收尾却不退出视图。
  实测代价：**编辑条占着面板顶部**，域 33「从已选中节点拖到右缘松手」挑中的节点中心正好落在条上 ⇒
  真鼠标按下打到条上、拖拽根本没启动（状态栏停在选区提示上，红得莫名其妙 ✗）。修法：本域收尾显式 `clearRelated()`
  （本域自己改的状态自己复位，与它上一条"别把 s/x/y 留给后面的域"同一规矩）。

> 两次泄漏的判据是同一句话：**跨域状态只能由制造它的域收口**，下游断言不该替别人擦桌子（也不该依赖"屏幕上没别的东西"这种隐式前提）。

**测试与判别力**：

- 冒烟新增 `scripts/smoke/35-rel-edit.js` **6 条**（跑在沙箱副本上）：进视图即出编辑条（可见/在面板内/有出边入边两组/**不遮住被框住的节点**）·
  输入即搜用**非连续子序列**也命中（等价子串匹配会落空 ⇒ 判的是"真用了共享模糊排序"而非随手一个 `indexOf`）·
  建立链接后**界面侧（清单多一行 + 内存 `node.data.links` 有它）与数据侧（CLI `links --json` 读回）两侧都变** ·
  删链接**自证**（CLI 读回没了）+ **自清**（内存里也没了）· 新建关联笔记（中心节点预置 / 单成员提交按钮禁用 /
  加一个成员后可提交 ⇒ CLI `assoc-list --raw` 有它、内存 `state.assoc` 有它、**「关联笔记（N）」清单里出现它**）·
  Esc 退出后编辑条/高亮/线全清且不带脏状态。
- **判别力证明（各注入一次，确认变红后撤销）**：① 把 `app:unlink-nodes` 的"CLI 成功判据"改成**恒真**
  （完全不调用 CLI 却宣称成功）⇒ 断言 4 红：`清单里残留=1 内存 links 残留=1 ｜ 自证（CLI links --json 残留）=1`；
  ② 把 `app:assoc-add` 改成**恒假**（一律报失败、不写盘）⇒ 断言 5 红：
  `内存 state.assoc 命中=0 ｜ 数据侧命中=0 ｜「关联笔记」条目含探针标题=0`。撤销后 `main.js` 的 sha1 **逐字节还原**
  （`3056a39288aa0b58`），复绿 `14/14`。
- 连带：域 25 的采样加固 + 两处跨域泄漏修复后，`25,33,34,35` 一起跑 **27/27**；`npx vitest run` **853/853**；`node scripts/cli-integration.js` **216/216**。

**文档同步**：`README.md` 功能表（新增「关联视图 / 关联信息编辑条」一行 + 改写「关联笔记」一行）、
`docs/DATA-FORMAT.md` §2.6 归属段（"界面**没有创建入口**"已按新行为改写）、
`docs/ARCHITECTURE.md` §2.1（`app-related.js` / `app-assoc.js` 的职责 + 归属划分段）、`docs/VERIFY.md`（`facts:write` 重生成计数）。

### P0 文字层抽取（用户批准 ✓）：**无书签的 PDF 也能建树**了（2026-10-09）

**根因（就是"用户自己的 PDF 会被直接拒绝"✗）**：P8 最小切片只做"有书签的 PDF"，而
`projects/comnet/attachments/mumuhe9jafs5.pdf`（30 页，Chromium/Skia 生成的技术文档）`getOutline()` 返回 **null**
⇒ 只走书签的实现对它**直接拒绝**。而实测它的文字层完好：**30 页 / 30077 字符**，字号分布极干净 ——
21pt 标题 ×24 字、15.75pt 章 ×152、12.28pt 节 ×487、10.5pt 正文 ×28583、9pt 页眉页脚 ×831
（另有调研留下的中文真值 PDF 复核：22pt 章 / 15pt 节 / 10.5pt 正文 ⇒ 同一套判据都成立 ✓）。

**做了什么**：`getOutline()` 为空 ⇒ **自动回退到文字层**（`page.getTextContent()`）⇒ 行 → 段 → 标题层级 →
"带 `#` 的 Markdown 提纲" ⇒ 走**同一条**建树路（`src/markdown.js`，建树逻辑仍然只有一处 ✓）。零新增依赖 ✓。

**新增 `src/pdf-text.js`（纯函数，UMD）**：`TextItem[]` → 行（`LINE_FACTOR=0.2`）/ 段（`PARA_FACTOR=1.8`）/
标题层级 + `md`。三条硬事实写进实现（都是实测/上游源码得出的，别凭直觉改 ✗）：
① **字号只能取 `transform[3]`** —— `TextItem` **没有** fontSize 字段，`height` 是渲染视角下的量；
② 字体只能用 `fontName` —— Chromium PDF 里 `styles[fontName].fontFamily` 恒为 `"sans-serif"`（真样本 5 个
fontName 全报同一个 family ✗）；③ 中文判据**自己写**（`第X章|篇|部|卷` / `第X节` / `N.N` / `附录A` …）——
Calibre 的阈值只**抄方法不抄代码**（它是 GPLv3 ✗，且其正则全是英文、源码注释自述中文完全没处理）。
正文基准字号按**字符数**取众数（真样本 10.5pt 以 28583 : 1494 压倒 ✓；按行数会被上百行标题带偏）。

**标题判据（三条并行，每条阈值都有实测依据）**：
· **字号 ≥ 基准 × 1.15** —— 真样本的节标题是 12.28pt / 正文 10.5pt = **1.17 倍**，按 Calibre 的 1.3 会整级漏掉 ✗；
· **居中 + 本页前两个内容行内 + ≤24 字** —— 关键是"居中"的定义：实测按"行中心贴近页中心"那条宽松判据，
  真样本有 **74 行**命中（全是左边距 43–61、右边距 100+ 的正文/代码行，中心只是被行宽推到页中心附近 ✗）；
  改成**左右边距近似相等（≤25%）且行宽 ≤65% 页宽**后 74 行**全部落空** ✓；
· **无歧义编号 + "孤立"（与上一行间距 > 1.8× 较小字号）** —— 挡住实测抓到的假阳性：正文残行 `5.6才引入）`
  命中 `N.N` 正则但上间距只有 1.57 倍（真标题都在 2.2 倍以上）；**有歧义编号**（裸 `1.` / `一、` / `（一）`）
  **不单独成立候选**（实测样本 p26 有 `1./2./3./4.` 四条命令步骤列表，按"编号即候选"会凭空多出 2 个顶层主题 ✗），
  它们只参与**层级**判定。
层级：有字号信号的按**字号桶排名**（大=浅）⇒ 真样本 21 / 15.75 / 12.28 正好是"标题 → 章 → 节"三级 ✓；
同桶内编号更深的往下压一层；无字号信号的按编号深度（调研样本的 `2.1 xxx`）。

**文字层闸门（"有没有文字层"是第一道关 ✓）**：单页字符数 < 20 且页数 > 1 ⇒ 判**疑似扫描页**；
过半页如此 ⇒ 判"整本疑似扫描件"并**响亮拒绝**（`1 页时用不了"过半页"判据 ⇒ 按单页判据处理`，口径写在理由里）。
**一个标题都认不出来**同样是响亮拒绝（不给一棵没骨架的树 ✗）。

**如实报告（一律不静默 ✗）**：`--dry-run` 与真导入都会打印来源（`pdf·书签` / `pdf·文字层`）与
沿途实况 —— 疑似扫描页的页号与字数、剔除了多少行页眉页脚（真样本 **60 行**：逐字相同的 9pt 页眉 +
`1 / 30` 形态的页脚）、认出的目录条目（真样本第 1 页 **12 行**：**不当标题**、逐行作为正文保留在「目录」节点下）、
"第一个标题之前有多少字符没进树"（建树时无处可挂 ⇒ 说清，不假装没丢）。

**页眉页脚只做最小一条**（P1 的正式做法没做 ✗）：每页首尾各 2 行里"逐字相同"或"页号形态"且出现 > 半数十页才剔。
不做这条的实测后果是全样本每页的 9pt 页眉与 `1 / 30` 页脚混进每个节点正文，且页脚还会命中 `^\d+…` 编号正则变标题 ✗。

**实现约束（被工程不变量逼出来的）**：`cli/commands/*` 及其依赖闭包**不许出现异步 API**（`tests/cli-sync-invariant.test.js` 静态把守）
⇒ `src/pdf-text.js` 是**纯同步函数**，真正的 `await` 全在既有的独立小进程 `scripts/pdf-outline-helper.mjs` 里
（主进程 `spawnSync` 拿结果，命令体自己仍然同步 ✓）。CLI 未新增命令（`import-project` 语义扩展 + usage/desc 同步）。

**测试与判别力**：
- 单测 `tests/pdf-text.test.js` **32 条**（行/段/基准字号/三判据/闸门/目录页/页眉页脚/端到端）+ `tests/doc-import.test.js` 增量；
  每条"★"断言都做了**注入证明会红**：字号改用 `height` ⇒ 红；基准字号改成按行数 ⇒ 红；
  弱编号当强编号 ⇒ 红；去掉"孤立"条件 ⇒ 红；"居中"改回"中心贴页中心" ⇒ 红；删掉文字层闸门 ⇒ 红。
- 夹具**纯代码生成**（`tests/pdf-fixture.js` 的 `buildTextPdf` / `buildUnlabeledChinesePdf`）：Type0 + `/Identity-H` +
  **ToUnicode CMap**（不内嵌字体 —— pdf.js 抽文本走 ToUnicode，只有渲染才要字形 ✓ 实测取回的 `str`/`transform[3]` 与写进去的一致）；
  含重复页眉与 `N / M` 页脚，且**没有书签** ⇒ 正好是 P0 要覆盖的那种 PDF ✓。
- 集成断言 +2（`scripts/cli-integration.js` 216 条 ✓）：**无书签但有文字层 ⇒ 真建成项目**（顶层主题 1 / 节点 5 / 层级 {1:1,2:2,3:2}，
  dry-run 不写盘、真写后能读回并过校验）；无书签且文字层不足 ⇒ 响亮拒绝且理由**带数字**（`20 个字符`）与出路 ✓。

**使用者可见面（R5 逐个核对）**：`import-project` 的 CLI 输出（新增来源标注与实况行）、`docs/CLI.md`（重新生成 ✓）、
`README.md`（新增"大文档导入建树"一行）、`docs/ARCHITECTURE.md` §2 模块表（新增 `pdf-text.js`，G8 要求 ✓）。
GUI 不涉及（导入是 CLI 侧能力，界面无对应入口）。边界：目录页 → 页码树 / 页码 ↔ 物理页偏移（P2）、多书自动判定（P3）、
OCR（P4）**仍未做** —— 无书签启发式的"字号 + 中文正则"这一部分是本次批准的 P0，其余不在本次范围 ✓。

### P8 最小切片（用户批准 ✓）：PDF **有书签** → 骨架 → 落盘（2026-10-08）

**做了什么**：导入 PDF 时读它的**书签（大纲）**，把书签树变成 `#` 标题提纲 ⇒ 走**同一条**建树路
（md/txt/docx 那条 ✓ 建树逻辑仍然只有一处 ✓）。**顶层书签多于一个 = 一个文件多棵树** ✓ —— 用户要的
「一个 PDF 里两本书 ⇒ 自动成两棵」在最小切片里就自然成立 ✓（实测：两个顶层书签 ⇒ 2 个顶层主题 / 3 个节点 ✓）。

**边界（如实写明 ✗）**：只做**有书签**的 PDF ✓。无书签的字号启发式 / 目录页正则 / 页偏移 / 多书自动
判定 / 外部 OCR 后端**一律未做**（5b 其余部分仍未批准 ✗）⇒ 没有书签的 PDF **响亮拒绝**并给出三条出路
（换带书签的 PDF / 先转 md / 把目录贴给 AI 整理），**不猜、不静默降级** ✓。

**实现（一条被工程不变量逼出来的设计 ✗→✓）**：`cli/commands/*` 有一条硬不变量——**命令体及其依赖
闭包内不许有异步 API**（进程内集成断言序列依赖它，`tests/cli-sync-invariant.test.js` 静态把守，
`cli/main.js` 还会在运行时报「CLI 命令未同步完成」✗）。而 pdf.js 的 `getDocument()/getOutline()` 是异步的
⇒ 一度把 `import-project` 改成 async，**当场掉了 8 条集成断言** ✓（现场报文留档）。正解：命令体保持同步，
由 `scripts/pdf-outline-helper.mjs`（独立小进程，自己在那边 await）读书签，主进程用 `spawnSync` 拿结果 ✓。

**依赖**：首次引入运行时依赖 `pdfjs-dist@6.4.299`（Apache-2.0 ✓，仅用它读书签，不做渲染 ⇒ 不需要
canvas 原生垫片 ✓；`require(ESM)` 已实测可用 ✓）。此前 `dependencies` 为空，这点已在 CHANGELOG 与
调研稿的 D1 决策点上写明 ✓。

**测试与判别力**：
- 夹具**自己生成**（`tests/pdf-fixture.js`：纯代码拼一份最小 PDF，不引二进制样本 ✓）——
  造的过程中实测抓出一个真坑：PDF 的同级书签是**链表**（`/Next /Prev`），漏了它 pdf.js 只看得到第一个
  同级项 ✗（两个顶层书签只解析出一个）⇒ 已按规范补上 ✓。
- 单测 +2（`tests/doc-import.test.js` 16 条 ✓）：有书签 ⇒ 标题层级与"两个顶层 = 两棵树"✓；
  无书签 / 坏 PDF ⇒ **响亮拒绝** ✓；同步入口对 PDF 必须**指路**（不许静默走错路 ✗）。
- 集成断言 +2（`scripts/cli-integration.js` 214 条 ✓）：带书签的 PDF 真建成项目且顶层主题数 = 顶层书签数 ✓；
  无书签的 PDF 响亮拒绝并点名「没有书签」✓。**顺带修掉一处老毛病**：这三条断言原先读的是 harness 的
  `status/err` 字段，而 `run()` 其实返回 `{code, out}` ⇒ `undefined !== 0` 恒真、前半句白写 ✗（已修正 ✓）。
- 冒烟域 27 改成新契约：`.pdf` 从"不支持"改为"支持（限有书签）"，`.doc/.epub/.png` 仍响亮说明 ✓（11/11 ✓）。

（新变更先记在这里，发版时移入下方版本段）

## [v0.18.0] - 2026-10-08

### G5 收口：Electron 无头冒烟在**跨域隔离**下 170/170（2026-10-08）

**诊断到底**：不隔离时全跑会随机炸（实测 137/167 · destroyed 30 ✗）；A/B 已证明真因是**跨域状态污染**
（不是渲染进程崩溃、不是内存、不是项目文件坏、不是撕裂快照 ✓ 这些假设都已实测否证，别再重查 ✗）。
按域隔离后同一份代码 167/167 · destroyed 0 ✓。

**收口**：隔离改为**默认开**（`MM_SMOKE_NO_ISOLATE=1` / `MM_SMOKE_ISOLATE=0` 只作诊断逃生口 ✓），
并把四条"依赖跨域状态"的断言改成**自建前置**（各自把前置做足，不看运气 ✓）：
- `06` theme-layout：ready 只证明"项目名对了"，不证明"树真的换了" ⇒ 改成"打开 → 自证真能取到 l1/r1"（最多 3 次）；
- `09` 保存：先把内存重开成"刚打开磁盘上那份"的干净基线（同名打开不弹丢弃确认 ✓）；
- `29` Ctrl+框选=加选：起框前关浮窗 + 把根居中，起始点候选 4⇒9 个；失败信息带三段拒绝计数；
- `30` 拖动模式：原先会挑到**主题模式下隐藏的容器根**（点不中 ⇒ 拖动根本没起来 ✗）⇒ 改成
  elementFromPoint **真命中**才算候选 + 跳过 root，并把"这一拖到底动没动"作为现场数据报出来 ✓。

**顺带挖出一个产品侧竞态（数据安全）**：`theme-layout` 那条红追下去发现，"外部改盘自动重读"与
"保存后被自动合并的重建"两处都是**先 await 读盘、再 renderMind**，中间**不复核项目是否已切走** ✗
⇒ 迟到的重建会把**旧项目的树**盖到新项目上（实测：`project.name` 已是 layout-probe，而内存树/metaLayout
还是 comnet 的；真实后果是"界面显示 A、state.project 指向 B ⇒ 下一次保存把错树写进 B" ✗——
冒烟的写前闸门当场抓到过 `project:save 校验失败：悬挂关联成员 comnet/… 不存在` ✓）。
修法：新增**载入世代**（`openProject` 开始时 +1；两处异步消费者在 await 前记下、回来核对，不符即丢弃 ✓）。

**预算按实测重设**：G5 150s→320s、整链 180s→400s（调整史与实测依据都写在 `scripts/verify.js` 注释里 ✓；
隔离买到的是"同一份代码稳定复现"，实测 G5 155.1s / 全链 199.1s ✓）。

### P7 真·跨视图拖放：把选中节点拖到**原生侧栏视图**上松手也生效（2026-10-08）

用户原话 C：「然后还要做**真的跨视图拖放**效果」✓。技术原因：侧栏是主进程的原生 `WebContentsView`
⇒ 指针一进它的矩形，渲染层就收不到 `mousemove/mouseup` ✗（拖动会卡住）⇒ 轨迹与落点判定必须由主进程做。

- **通道新开**：`dsh-sidebar:sel-drag-start/end` —— **不复用** `dsh-sidebar:drag-start/end`（那是"拖宽
  分隔条"用的 ✗；复用会静默弄坏拖宽 ✓）。`preload` 暴露 `desktop.dsh.selDragStart(ids)/selDragEnd()`，
  冒烟域 11 的**白名单断言**同步加两笔（不改必红 ✗）。
- **判定用已完成的纯函数**：`src/drop-target.js` 的 `isPointInSidebar(pt, winBounds, viewBounds)`
  （窗口内坐标 → 屏幕坐标换算 ✓ 有单测 ✓）。主进程在拖拽期间 40ms 轮询 `screen.getCursorScreenPoint()`，
  终点回**结构化回执** `{ok,hit,ids,reason,pt,ptWin,viewRect}`（失败必带原因 ✓ 不静默 ✗）；
  30s 收不到终点就自动清理并留日志 ✓（不静默泄漏 ✗）。
- **投喂单源**：命中后仍走渲染层既有的 `MM.sendNodesToSidebar`（节点标题/路径/正文只有那一处实现 ✓）；
  渲染层抽出 `MM.requestSelDropVerdict()` 作为"要回执"的唯一入口 ⇒ 冒烟可用桩替换它判接线 ✓。
- **冒烟 +3 条（167→170，成对 ✓）**：① 两方法都在且与拖宽那套**同时都在**；② 回执的 `hit` 必须等于
  **几何独立复算**（`ptWin` 是否落在 `viewRect` 内）——判别力证明：把 `isPointInSidebar` 注入成恒真 ⇒
  `几何复算 hit应=false 实=true` **必红** ✓（已实跑，测完 `git checkout` 逐字节还原 ✓）；③ 渲染层接线
  （桩回执）：`hit=true` ⇒ 真的投喂、`hit=false` ⇒ **不许**投喂 ✓。
- ⚠️ **未验证项（如实标注 ✗）**：指针停在原生侧栏视图上松手时，渲染层到底收不收得到 `mouseup` ——
  headless 无法用合成事件复现跨视图路由（`sendInputEvent` 直达渲染层 ✗）⇒ 列入真机复核清单。
  若收不到：`selDragEnd` 不到达 ⇒ 主进程 30s 兜底清理，既有的"面板右缘 24px"路径仍可用 ✓（降级不崩 ✓）。

## [v0.17.0] - 2026-10-08

### 反馈⑦c：关联展示卡顿 —— 拖动时不再重复刷 551 个节点的类（2026-10-08）

**实测量到的病根**：`scheduleRedraw` 在拖动/缩放时**每帧**都跑 `applyHighlight`，
而它原来对**全部**节点（本机 551 个）各做 2 次 `classList.toggle` ⇒ **每帧 ~1102 次 DOM 写** ✓✗。
（判别力证明里关掉优化，13 帧就写了 **14326** 次 ✓ 这就是"有时候会卡"的来源。）

**修法**：用 **WeakSet 记账** —— 同一个高亮状态里标过的元素直接跳过 ⇒ 每帧只处理"新出现"的元素；
状态一变（换节点/退出/成员集变化）就清账重来 ✓。**关键是它不会静默失效**：jsMind 重排/展开会重建
节点元素，新元素不在账上 ⇒ 下一帧自动补类 ✓（冒烟断言同时验"写的次数下来了"和"高亮没丢"✓）。

**测试**：冒烟域 25 新增第 5 条（159）：数 `DOMTokenList.prototype.toggle` 上高亮类的写入次数 ——
**与机器快慢无关的确定性判据**（第 1 帧 ≤ 2×节点数、连刷 13 帧 ≤ 同量级 ✓），并同时断言
`高亮+虚化 ≈ 全部节点` ✓（一帧都不能丢 ✓）。实测：**13 帧写 0 次**（账本有效 ✓），高亮=2/虚化=549=551 ✓。
**判别力证明（实跑）**：关掉账本 ⇒ **14,326 次写入** ⇒ 断言报红 ⇒ 撤销后 13/13 ✓。

**另（⑦a 已完成，见上一版）**：「展示关联节点」已是详情框左缘的竖排大按钮 ✓。

### 反馈④⑥：多选（Ctrl+点击 / Ctrl+框选）＋ 把整批所选交给 AI（2026-10-08）

**用户原话**：④「框选出来多个节点的时候，应该自动链接上所有这些被框选的节点，意思是我想把所有
被框选的都给 AI 看然后让他回答我」；⑥「应该要可以通过按住 Ctrl 然后鼠标点击或者框选实现多选功能，
就可以问 AI 所有我想选择的了」✓

**做了什么**：
- **⑥ Ctrl+点击**：把节点加入/移出选区（捕获阶段处理 —— 见下面的坑 ✓）；**Ctrl+框选**：在已有选区上**并集** ✓
  （普通框选仍然是"重新选" ✓）。
- **选区分两份**：`getSelection()`（**裁剪后** —— 同父/父冗余裁剪是"收起/拖动"这类树操作的口径 ✓）
  与新增的 `getSelectionRaw()`（**原始命中共** ✓）。**问 AI 用后者**：用裁剪后的会把你明明框住的节点
  悄悄丢掉 ✗。工具条、AI 上下文都走 raw ✓。
- **④ 工具条对整批生效**：有选区时工具条**出现**在选区外接矩形上方，按钮写明数量（「💡 解释 3 个」/「💬 问这 3 个」）；
  点它 ⇒ 问答浮窗标题「AI 解释：3 个节点」✓，并把**整批**交给后端 ✓。
- **后端**：`ask --nodes a,b,c` ⇒ 情境里**逐个列出**（标题/路径/标签/正文），并明确要求
  "把它们放在一起看（共同点/差异/彼此关系），不要只答第一个" ✓；正文按**总量**预算截断（不撑爆提示词 ✓）；
  有不存在的节点 ⇒ **响亮报错并点名**（不许悄悄少给一个 ✗）。开场白也按"多节点/单节点/项目级"分别措辞 ✓。

**踩到的两个真坑（都不是"随手写错"，是机制性的）**：
1. **Ctrl+点根节点没反应** ✗：jsMind 对节点（尤其根节点）的 mousedown 会 `stopPropagation` ⇒
   冒泡阶段收不到 ⇒ 必须放在**捕获阶段** ✓。
2. **加选会丢节点** ✗（断言抓出来的真缺陷）：并集的**基**原先取的是**裁剪后**的选区 ⇒
   被裁剪掉的节点在"再加框"时静默消失 ✓（实测 2 → 1）。改成以 `fdSelectionRaw` 为基 ✓。

**测试**：集成断言 **+2**（212，全离线）：`--nodes` 逐个进提示词且说明"放在一起看"、
含不存在节点 ⇒ 非 0 且点名。冒烟新增 `scripts/smoke/29-multiselect.js` **4 条**（158）：
Ctrl+点击逐个加选、工具条写明整批、点它⇒标题 N 个节点＋桩回显"收到节点数：N"、Ctrl+框选只增不减。
**判别力证明（实跑）**：把渲染层传给主进程的 `nodes` 拿掉 ⇒ 断言**报红**在"桩回显收到节点数"这一条 ✓
（说明它真的在验"后端收到了整批"，而不只是"界面知道有 N 个" ✓）。

**⚠️ 上一版在这里记过一条"加选仍会丢节点"的未尽 bug —— 本轮查清并**撤回** ✓**：
那是**我的断言自己造出来的假警报** ✗。真因：我在**按下鼠标之前**读了选区当基准，而这次按下有时会落到节点上 ⇒
走 Ctrl+点击的加减选分支 ⇒ 基准**已经过期** ✓；实现那条 `mouseup additive=true base=[comp-net,s-5-1] hit=[]
merged=[comp-net,s-5-1]`（临时探针实录）证明它用的是**按下那一刻**的真实选区、原样保留 ✓。
修法在**测试侧**：基准改成"框确认起来之后"再读（此后不再有加减选 ✓），并把断言升级为
「**至少一次真的长大** ＋ **任何一次都不许丢**」✓。留作教训：**基准要在"被测动作已经发生"之后再读**，
否则你量的是上一秒的世界 ✗。（`fdSelectionRaw` 当并集基这个修法**保留** ✓ —— 它是设计上必须的：
用裁剪后的选区当基，确实会静默丢掉被裁剪掉的节点 ✓。）
另：本轮还发现"独立复算说根节点中心在框内、实现却没选中它" ⇒ 记进台账待查（与本轮④⑥无关 ✓）。

### 反馈③：解释/问AI 提速 —— 思考强度可调（默认解释 low、问答 medium）（2026-10-08）

**取证结论**（都是实测，不是推断）：
- `dsh headless` **没有**思考强度参数（只有 `--json` / `--session-id`）✗ ⇒ 唯一的旋钮是 profile 里的
  `agent-default-model.reasoningEffort`，而现网 web profile 是 **`high`** —— 这就是"慢"的直接原因 ✓；
- 允许取值**按模型声明**：本机在用的 `deepseek-flash` 声明 `low/medium/high/xhigh`
  （另一个模型是 `high/max`）⇒ 代码只做粗校验，未知值**一律拒绝**并列出可用值（不猜 ✗）；
- ⚠️ **patch 是整行替换**：实测只写 `reasoningEffort` 会把同行的 `provider`/`model` 一起抹掉 ✗✗
  ⇒ 生成的 patch 必须**三项写全**（provider/model 从 `--dump-config` 的现实值里扫出来）。

**实现**：`src/dsh-ask.js` 新增 `EFFORTS`（含取值来源注释）/`DEFAULT_EFFORT`（解释 low、问答 medium）/
`parseAgentModel`（**不引 YAML 解析器** —— 本工程零运行时依赖，只做一次极窄文本扫描；扫不到就返回 null，
调用方**放弃覆盖并如实说明**，不猜 ✗）/`buildEffortPatch`（三项写全 + 未知值抛错）；
`askOnce` 在需要时落一个**临时 patch 文件**（用完即删 ✓）。CLI：`ask --effort low|medium|high|xhigh`
（`--dry-run` 会把 patch 也打出来 ⇒ **离线可验** ✓）。界面：对话栏加了「思考：低/中/高/很高」下拉
（用户原话"对话栏里要可以手动设置"✓），改完对**下一次**提问生效 ✓。

**提速实测**：同一条解释（`comnet/tcp-handshake --kind explain`）——
`high` **23.8 s** → `low` **15.8 s**（端到端 16.4 s，答案仍 1534 字，不是变短敷衍 ✓）。**单次样本，不是严谨基准** ✓。

**测试**：单测 18 → **24**（dump 文本扫描不串行/扫不到返回 null/三项写全/未知值抛错/默认值/带 patch 的参数形状）；
集成断言 **+3**（210，全离线）：解释默认 low 且 patch 三项齐全、显式 `--effort xhigh` 生效、
未知值非 0 且列出可用值；冒烟 **+1**（154）：下拉四个选项齐、默认 low、改成 high 后**桩回显 `思考强度：high`**
（证明 渲染层→主进程 这一跳真的把强度送出去了 ✓，主进程→CLI 那跳由集成断言覆盖 ✓）。
**判别力证明（实跑）**：让 CLI 忽略 `--effort` ⇒ **4 条断言同时报红**（含两条新的强度断言）⇒ 撤销后 210/210 ✓。

### 按用户反馈修 5 项：Markdown 渲染 / 空对话框 / 点线打不开 / 悬浮窗行为 / 抓到一个真根因（2026-10-08）

**① 全局 `**粗体**` 不渲染** —— 根因有两处，都在我这边：
- **AI 的回答**是用纯文本渲染的（`esc(a).replace(/\n/,'<br>')`）✗ ⇒ 答案里的 Markdown 全是字面量。
  现在走**唯一的两个渲染口**（新增，都在 app-core.js）：`MM.mdInline`（一行里的加粗/行内代码 ⇒
  转义后替换，复用既有的 `topicMarkup` ✓）与 `MM.mdBlock`（整段 ⇒ 走 `src/convert.js` 的 `markdownToHtml`，
  与 `--note-md` 导入同一个转换器 ✓）。两者**都只作用于 DOM**，绝不写回数据 ✓。
- 我自己在 `.ask-hint` 里写了一句字面 `**独立**` ✗ ⇒ 去掉标记。
- 机械判据（冒烟）：桩答案**故意带 Markdown** ⇒ 断言 `答案里出现 <strong>` 与 `<li>` ✓。
  **往外扩散**（关联标题、列表项等）留到后续（见台账）。

**⑤「问问AI」看着像 AI 先开口** —— 真相：它**没有**自动发第一句（只有「解释」会自动发 ✓），
但我给**空流水**也渲染了「正在生成…」✗ ⇒ 看着就像 AI 抢先说了话。现在：空框显示
「在下面输入你的问题，按 Enter 发送（我只会回答你问的 ✓）」；「正在生成…」只在**真的发出去之后**出现 ✓。

**⑦ 点关联线条打不开笔记（这是真 bug，而且我上一轮的断言是假绿 ✗✗）** ——
根因：**视觉线在节点层下面**（不然会压在节点上 ✓），而节点层是一整块 DOM ⇒ **真鼠标事件永远落在节点层上**，
到不了线 ✗。我上一轮的断言用 `dispatchEvent` 直接派到 path 上，**绕过了命中测试** ⇒ 断言绿、功能坏 ✓✓。
修法：**命中单独一层**（`#mm-rel-hit-layer`，透明、z-index 3 盖在节点之上、只有 stroke 可点 ✓），视觉层仍在下方 ✓。
断言改造：改用 **`sendInputEvent` 发真鼠标事件**（走 Chromium 命中测试 ✓）——
**判别力证明（实跑）**：把命中层压回节点下面 ⇒ 断言**报红**「最后打开的框不是关联页：kind=null」（= 你的现象 ✓）⇒
恢复后 12/12 ✓。**教训记在该文件注释里：验点击必须发真鼠标事件，DOM 派发会掩盖这类缺陷。**

**⑧ 悬浮窗行为** —— 现在：首次显示时定好位置并上**大锁**（相对屏幕锁死 ⇒ "绑定在第一次显示的位置" ✓，
实测视图变换后位置读数一字不变 ✓）；**界面上不显示**大小锁（用户说不需要，行为保留 ✓）；
**点击别处即消失**（连同工具条一起收起 ✓，实测点导图空白后剩余 AI 框 = 0 ✓）。冒烟有专门一条断言串起这三件事 ✓。

**顺带抓到一个"抓不到名字的偶发"的真根因**（上轮留的尾巴 ✓）：`tests/dsh-embedded-overrides.test.js`
里的用例会 **spawn 一个 node 子进程**（1.9–5.1 s），而 **vitest 默认单测超时是 5000 ms** ⇒ 机器一有负载就
偶发超时 ✗（实测抓到 `5087 ms` 的失败：**结论对、根因是超时**）。修法：本文件 `vi.setConfig({ testTimeout: 30000 })` ✓
—— 性能该由链上的预算管，单测只管"对不对" ✓。

### 功能 5a 入口③：下方消息栏「或者你可以直接向我描述要导入什么」（2026-10-08）

**用户原话**：「在下方消息栏（显示发送消息框的地方）上方有一些虚体字，写『或者你可以直接向我描述要导入什么』，
如果用户向里输入，就认为用户在向内嵌 DSH 发送提示词，**自动补充情境信息**」✓

**做了什么**：主视图底部加了消息栏 —— 上面一行**浅灰虚体字**就是那句话（**一字不差**，有断言守着 ✓），
下面是输入行 + 发送（Enter 也发）。输入即视为向内嵌 AI 发提示词 ⇒ 结果出现在**复用了详情框组件**的
AI 浮窗里（标题是「AI 助手 · <项目>」，因为这条入口常常没选中节点 ✓）。

**"自动补充情境信息"落在哪**（这条最要紧）：`ask` 命令改成**节点可选** —— 不给节点就是**项目级**提问，
情境块由 `src/dsh-ask.js` 统一补齐，除了项目与工程根，还明确告诉 AI：
> 「你可以**动手**：本工程有 CLI（`node cli/mm-cli.js --help`），例如从一个大文件建新项目
> `import-project <新项目名> <文件.md|.txt|.docx>`、查询 `read/search/related/backlinks`、编辑 `add/edit/move/remove`。
> 用户让你"导入/整理某个文件"时，先看清文件存不存在、再动手，并把结果如实回报。」

⇒ 于是"描述一句话 ⇒ AI 真去建项目"这条路通了（它知道自己能动手、也知道**用哪条命令** ✓）。
节点级的开场白与情境**保持不变**（有断言守住"项目级的改动没把原来的挤掉" ✓）。
项目级但没给问题 ⇒ **响亮报错**（不许发一个空问题出去 ✗）。

**测试**：单测 `tests/dsh-ask.test.js` 16 → **18**（项目级提示词含"可以动手"+`import-project`+问题原文、
且不含节点级的措辞与"还没有正文"；节点级不被污染）；
集成断言 **+2**（207）：项目级 dry-run 的情境内容齐全、项目级缺问题 ⇒ 非 0 且说明原因；
冒烟 `scripts/smoke/28-msgbar.js` **3 条**（152）：消息栏在且**虚体字文案一字不差**（含颜色读数
`rgb(176,182,192)` = 浅灰 ✓）、输入+Enter ⇒ 打开**项目级**浮窗（标题 `AI 助手 · comnet`）并拿到回答、
空输入不发（流水条数不变 ✓）。
**判别力证明（实跑）**：把提示文案里的"什么"改成"的内容" ⇒ 文案断言**报红**并打出实际文案 ⇒ 撤销后复绿 ✓。

**如实记一条观察**：本轮链跑里 G3 出现过两次异常（一次退出码 2147483651 = 崩溃、一次 1 条失败），
**后续三次（含两次单跑一次全链）全绿 ⇒ 抓不到名字的偶发** ✗。当时机器负载明显偏高
（同一条链 131.6 s → 159.3 s）。这与工程历史上记过的"并发/负载下的偶发"同类；
**没在第一次就捕获失败用例名是我的失误**（下次遇到先加 `--reporter` 落盘 ✓）。

### 功能 5a 入口① ②：菜单「导入大文件生成新项目…」+ 拖拽文件进窗口（2026-10-08）

**两条入口，一个实现** ✓：菜单走主进程的 `importDocDialog`，拖拽走 `app:import-doc` IPC，
最后都调 `importDocToNewProject` ⇒ 项目名清洗、重名自动 `-2/-3`、失败口径全都只有一份 ✓
（两条入口各写一份的话，行为迟早分叉 ✗）。
导入成功后的收尾也共用：刷新项目列表 + **自动打开新项目** + 提示 ✓。

- **菜单**：「文件 → 导入大文件生成新项目…」（`Ctrl+Shift+I`），选文件对话框只列 .md/.markdown/.txt/.text/.docx ✓。
  ⚠️ 你说的是"窗口选项里"，但这个应用的菜单只有 **文件/编辑/视图/帮助** —— 没有「窗口」；
  导入这类动作的天然归宿是「文件」（和已有的「导入 Markdown…」并排 ✓）。要挪到别处说一声即可。
- **拖拽**：把文件拖到窗口任意处 ⇒ 覆盖层提示「松手即导入为新项目」⇒ 松手导入 ✓。
  **取路径必须走 `desktop.app.pathForFile()`**：Electron ≥32 起 `File.path` 已被移除，
  `webUtils` 只有 preload 拿得到 ⇒ 这是渲染层唯一的取路径方式 ✓（版本实测 44.3.0）。
  不支持的扩展名（.pdf/.doc/…）**说清楚**并指向 5b，**不静默失败** ✗。

**顺带修掉一个既有的用户可见缺陷**（我的导入把它暴露了）：`loadProjects()` 原来**无条件**
`sel.value = projects[0].name; await openProject(projects[0].name)` ✗ ⇒ **任何一次列表刷新**
（例如"外部改动 ⇒ menu:project-changed"）都会把界面**拽回第一个项目**。实测时间线很清楚：
`事件到达 cur=comnet` → `openProject 返回 true cur=两本书` → **`1.5s 后 cur=comnet`** ✗。
现在改为：保留当前选中的项目，**只有当前没有项目**时才自动打开第一个 ✓。

**测试**：冒烟 `scripts/smoke/27-import-doc.js` **3 条**（149）：扩展名判据 + `.pdf` 响亮拒绝
（状态栏文案有断言 ✓）、**真导入一条链**（写探针 md ⇒ 导入 ⇒ 项目数 1→2 ⇒ CLI 读回两棵树 ⇒
界面自动打开它 ⇒ 收尾切回原项目，不给视觉断言留脏状态 ✓）、路径不存在 ⇒ `ok:false` 且带原因。
**判别力证明**：本轮的三次"红"都是真的：① `win is not defined`（我在 IPC handler 里用了只在菜单里
存在的 `win` ✗ ⇒ 改用 `e.sender`）；② 我猜的状态栏元素 id 不对（`#status` → `#status-text` ✓）；
③ 自动打开被拽回 —— 见上面那条既有缺陷 ✓。

### 功能 5a（引擎）：`import-project` —— 大文档一键生成新项目 + 新树（2026-10-08）

**这是"一键导入"的引擎**（菜单/拖拽/消息栏那三个入口是下一步）。已支持 **md / txt / docx** 三种，
**零运行时依赖**（本工程的硬约束）。

**设计：一个建树入口，三种前端** —— md 直接用、txt 走启发式、docx 自己解，三者都先变成
"带 `#` 的 Markdown 提纲"，再统一交给既有的 `markdown.js` 建树 ⇒ **只有一套树构建规则**，
不会出现"txt 导进来的树和 md 导进来的结构规则不一样"这种漂移 ✓。
**一个文件里的多个 1 级标题 ⇒ 多个顶层主题** ⇒ "一本书里的多本书 / 一个文件里的几本书 ⇒ 几棵树"
在 5a 这一级就已经成立 ✓（实测：示例 md ⇒ 2 个顶层主题）。

**docx 为什么自己解**：docx 就是一个 zip + 一份 `word/document.xml`，而 zip 的 deflate 用 node 自带的
zlib 就能解 ⇒ 约 100 行换掉一个依赖，划算 ✓。读段落 + `Heading1..6` 样式 + XML 实体解码（跨 run 拼接 ✓）。
**边界写清**：不支持 ZIP64 / 加密（**响亮抛错**，不猜、不静默给空树 ✓）。

**txt 的启发式**（边界写在 `src/doc-import.js`）：短行（≤40 字）+ 前后是空行 + 不以句末标点/逗号结尾 +
不像列表/网址 ⇒ 认作标题；`第一章`/`1.1`/`一、`/`（一）` ⇒ 层级。**认不出就是正文** ——
**绝不丢内容**（有专门的"内容零丢失"断言：提纲里每一行都能在原文里找到、原文每一行也都在提纲里 ✓）。

**两个实测踩出来的缺陷（都已修 + 都有断言）**：
1. **BOM**：Windows 上编出来的 md/txt 常带 BOM，而它会让**首行的 `#` 匹配不上** ⇒ 第一个标题被当正文吞掉、
   整棵树少一层（实测：带 BOM 的 md 导入后顶层主题变成合成的「（层级2）」✗）⇒ 导入器剥 BOM ✓；
2. **`.pdf` 落到"当 txt 读"的兜底里** ⇒ PDF 的二进制原文会被当正文导进树（看着"导入成功"、内容全是乱码 ✗，
   正是"静默给出错误结果"）⇒ 现在对**认识的但不支持**的格式（pdf/doc/epub/…）**响亮拒绝**并指向 5b ✓。

**命令**：`import-project <新项目名> <文件> [--title 标题] [--dry-run] [--json]`。
`--dry-run` 只报格式/规模/层级分布/前几个顶层主题，**不写盘**（可机械验证，也是使用者预览的第一入口）；
真导入是**一次 `ctx.write`**（原子）⇒ 中途失败不留半个项目；项目名已存在则拒绝（不覆盖 ✓）。

**测试**：单测 `tests/doc-import.test.js` **14 条**（含"手工造 zip 验证读取器"—— 不是自己验自己 ✓、
内容零丢失、BOM、ZIP64 抛错、`.pdf` 拒绝）；
集成断言 **+8**（205）：dry-run 不写盘且报 2 个顶层主题、真写后能读回来且过校验、txt 启发式的层级分布、
`.pdf` 拒绝、项目名重复拒绝、收尾无残留。
**判别力证明（实跑）**：让 `--dry-run` 真写盘 ⇒ 该断言报红（并连带 2 条下游断言也红）⇒ 撤销后 205/205 ✓。

**过程里的三个自伤（都记在注释里）**：① 清理探针的路径写成了临时目录（夹具其实**故意**在真实
`projects/` 下造探针）⇒ 留下垃圾 + 注释说反了；② 一次"删空行"的编辑把下一行代码接到了注释后面 ⇒
`ReferenceError` 让整个 G4 崩掉；③ 判别力证明那次注入让 dry-run 真写盘 ⇒ 多留了一个 `imp-probe-b`，
下一轮变成"项目已存在"的假红 ⇒ 清理改成**按前缀清** ✓。

### 功能 1 界面层：节点悬浮工具条 + AI 问答浮窗（2026-10-08）

**入口**：选中任一节点（单击 / 跳转 / 关联页点成员都会）⇒ 节点**上方**弹出工具条
「**💡 解释**」「**💬 问问AI**」（贴不住上方就翻到下方，并夹进视口）。

**三个关键取舍**（都写在 `renderer/app-ask.js` 文件头，免得后人重做一遍）：
1. **浮窗直接复用节点详情框组件**（`MM.createFdBox()`）：需求原话是"视觉与节点详情的对话框一致" ——
   **照抄组件就是最省力的达成方式** ✓，而且自动获得拖动 / 改大小 / 📌🖥 锁 / 与 DSH 侧栏让位，
   不必新建窗口、不引入 `WebContentsView`、不需要第二套拖拽与锁逻辑；
2. 钩子只包**一个**入口：本工程"选中节点"的唯一标志是它有了详情框（`MM.showDetail`）——
   单击、命令面板跳转、关联页点成员最后都走它 ⇒ 包这一个点覆盖所有"选中"路径
   （逐个调用点加代码的做法必漏 ✗）；同时包 `MM.closeFdBox` 让工具条跟着收起；
3. **后端是一次性问答**（`app:ask` → `cli ask` → `dsh headless`）⇒ 每问一次是**一次独立会话**
   （没有上下文延续）。界面上**明说**这一点（`.ask-hint`），不假装是连续对话 ✗；
   真多轮要 `--resume`，属后续步。

**主进程侧**（`main.js` 的 `app:ask`）：自己 `spawn` + Promise（**不能用 runCli** —— 它是 spawnSync，
一次解释 20+ 秒会把主进程整段卡死、界面假死 ✗），并复用同一套环境（`ELECTRON_RUN_AS_NODE` +
`AI_MINDMAP_PROJECTS_DIR` 数据隔离）。**冒烟/离线**（`--smoke` 或 `MM_ASK_STUB=1`）返回 `stub:true` 的**桩**：
门禁里不做重活（不烧额度、不依赖网络），要验的是链路不是模型质量；而**桩必须被界面标出来**
（`.ask-stub`，有断言守着 —— 见下）。

**判别力证明（实跑）**：把界面里"桩标记"那行去掉 ⇒ 第 2、3 两条断言同时报红（`桩标记=false`）⇒ 撤销后 12/12 ✓。
这条契约的意思很直白：**不许把桩冒充成真答案** ✗。

**测试**：冒烟 `scripts/smoke/26-ai-ask.js` **4 条**：工具条出现且贴着节点（实测水平偏差 **0px**）、
「解释」⇒ 浮窗**复用了详情框外壳**（📌/🖥/✕/改大小把手齐备）+ 标题含节点标题 + 正文出答案 + 桩标记可见、
「问问AI」⇒ 输入行可用且回车往返成功、工具条定位的**纯几何**（上方放不下 ⇒ 翻到下方、贴右 ⇒ 夹回视口）。
**端到端人工实测**：`cli ask … --json` 真跑 5.6 s 返回 `{ok:true,ms:5084,text:"传输控制协议…"}` ✓
（渲染层→主进程那跳由冒烟桩覆盖，CLI→DSH 这跳由这次真跑覆盖 ⇒ **每一段都验过**）。

**又抓到一条架构不变量**：我最初把 `askOnceAsync` 写进了 `src/dsh-ask.js` ⇒ 被
`tests/cli-sync-invariant.test.js` 判红（CLI 命令的**依赖闭包**不许出现异步 API，`invokeSync` 依赖它）。
它其实**根本没被用到**（界面走主进程异步 spawn CLI）⇒ 删掉，并在该文件顶部写明"本文件不许出现异步 API，
异步只能住在主进程" ✓。这正是那条不变量存在的意义。

### 功能 1（后端通道）：`ask` —— 向内嵌 DSH 提一个一次性问题（2026-10-08）

**这是「解释 / 问问AI」两个按钮的后端**。界面还没做（下一步），但通道与提示词这一层先落地并已机械验证 ✓。

**通道（运行包自带 help 的原文 + 实测）**：
```
dsh headless "run the tests"   → answer one task, print the result, and exit
```
- `headless` 是**内置 profile**（不落在 `$DSH_HOME/profiles` 里，所以不必也不能用 `--from-default-profile` 建它
  —— 实测报错原文：`profile "headless" is shipped and cannot be a custom profile target`）；
- 实测：`dsh headless "用不超过 10 个字回答：1+1 等于几？"` ⇒ 退出码 0、**4.4 s**、stdout **只有答案一行**
  （无 banner / 无 token / 无噪音）✓；
- 实测（真情境）：`node cli/mm-cli.js ask comnet tcp-handshake --kind explain` ⇒ **23.8 s** 得到一段
  贴住该节点语境的解释（引用它的正文、上下游节点、三次握手/四次挥手/TIME_WAIT 的因果）✓；
- ⇒ **一次性子进程**足够撑起第一版对话：不需要 web 服务、不需要 ACP/SSE，**不碰用户侧栏的会话写锁**（那套冲突全绕开）。
  代价是每次一问一个新会话；多轮要 `--resume <session>`，属后续步。

**新增**：
- `src/dsh-ask.js`：纯函数（`buildAskPrompt` / `buildContextBlock` / `buildAskArgs` / `buildAskEnv`）
  + 运行器（`spawn` 可注入 ⇒ 单测验参数与环境而不真起进程）。
  **"AI 收到什么"只有这一处定义**：自动补齐 项目 / 工程根 / 节点 id / 树中路径 / 标签 / 正文（截断 1500 字）/
  相关节点，并明说"不要寒暄、不要复述情境"；
- `cli/commands/dsh-ask.js` + registry：`ask <项目> <id> [--question "…"] [--kind explain|ask] [--json] [--timeout 秒] [--dry-run]`。
  **`--dry-run` 只打印将要发送的提示词与命令行、不调用模型** —— 让门禁能在**不烧额度、不联网**的前提下核对提示词，
  也是使用者自查"为什么它答偏了"的第一入口；
- **失败绝不当成功**：非 0 退出 / **退出码 0 但没有输出** / 超时 ⇒ 一律 `ok:false` 并带原因（"采不到真值 = 红"）。

**过程里抓到的三个真缺陷**（都由"测量"而非"阅读"现形）：
1. **`--dry-run` 静默失效**：CLI 把 `--dry-run` 解析成 `args.dryRun`（驼峰），我写成 `args['dry-run']`
   ⇒ 标志被忽略、**真烧了一次模型调用**（本该 0.4 s 却跑了 23.3 s）✓ 已修 + 单测锁死
   （桩掉 `askOnce` 断言 dry-run 下**一次都不调用**，并配一条"不带 dry-run 确实会调用"的对照）；
2. **树中路径全空**：`ctx.tree.pathTo()` 返回的是 **id 数组**（不是节点对象），我按节点取 `.topic` ⇒ 提示词里
   是「 /  /  / 」✗。（`--dry-run` 一眼看出；真跑时模型照样能答 ⇒ **只有断言提示词才抓得住** ✓）
3. **工程根算错**：`dirname` 了两次得到 `…\projects` ✗ ⇒ 改为仓库根（单一真源）。

**测试**：`tests/dsh-ask.test.js` **16 条**（提示词补齐/两种 kind 措辞/参数是一个 argv/环境只增不覆盖/
非 0·空输出·超时·运行包缺失都不当成功/dry-run 契约）；
`scripts/cli-integration.js` **+4 条**（197）：dry-run 不调模型且命令行形状正确、
**情境三项都不能空**（就是能抓住缺陷 2 的那条）、kind=ask 缺问题 ⇒ 非 0、节点不存在 ⇒ 非 0 且点名原因。
**判别力证明（实跑）**：把 `pathText` 清空 ⇒ 该断言报红 `(没有路径行)` ⇒ 撤销后 197/197 ✓。

**顺带**：`docs/CLI.md` 重生成（50 → **51** 条命令）；**不加 MCP 工具** —— MCP 是给**外部** AI 用的，
把"再问一个内嵌 DSH"暴露出去等于递归入口，没用还危险 ✗。

### 功能 2：关联节点可视化（"展示关联节点"按钮 + 缩放框住 + 高亮虚化 + 关系虚线 + 点线按鼠标位置开笔记）（2026-10-08）

**入口**：节点详情的「关联笔记」区新增按钮 **🔗 展示关联节点**（**恒常出现** —— 一个节点可能没有关联笔记但**有链接**，那种情况一样能展示）。再点一次或按 **Esc** 退出。

**四条效果**（对应用户原话）：
1. **缩放到刚好框住所有关联节点**：一趟算完（逻辑坐标 ↔ 屏幕是纯仿射）——新增 `MM.setViewTransform({s,x,y})`
   （既有的 `setViewScale`/`zoomViewAt` 只能"围绕某点按倍率缩放"，表达不了"我要这一个目标值"）；
2. **高亮关联节点 + 轻微虚化其余**：`jmnode.mm-rel-hit` / `.mm-rel-dim`，**只写类**（jsMind 的
   `_reset_node_custom_style()` 会重写内联样式 ⇒ 内联的高亮活不过一次 show_nodes ✗；
   本文件已有先例 `mm-rubber-hit`）；
3. **关联节点之间出现虚线连接线**：`#mm-rel-layer`（SVG）**挂进 `fdViewEls()`** ⇒ 与 canvas/节点层
   同变换，**平移缩放零重算**。线两类：当前节点↔每个成员（星形，带"为什么相关"）+ 同一篇关联笔记
   成员之间（成员 > 8 只画星形 —— 线一多就盖住图，反而看不清哪些是关联节点）；
4. **点线弹关联笔记，位置取决于鼠标点击位置**：大锁（SCREEN）+ 写一次 left/top。
   **与"从入口原位打开"是两种位置来源**，正是需求要的差别；线太细 ⇒ 叠一条透明加粗热区（`pointer-events: stroke`）。

**口径**（见 `src/related-model.js` 的文件头）：关联节点 = **关联笔记成员 ∪ 链接两端**；
**跨项目只标不画**（不在当前图上 → 画不出线，只计数并如实告知，**不许静默丢掉**）；
线按"为什么相关"区别配色（关联=蓝 / 链接=橙 / 两者都有=紫）。

**结构**：模型是纯函数放 `src/related-model.js`（UMD ⇒ node 可直接 require ⇒ 有单测），
渲染粘合放 `renderer/app-related.js`。**不再有第二份模型**（第一版在渲染层里写过一份，已删 ✓）。

**冒烟抓到并修掉的两个真缺陷**（都是"只在全量/真实数据下才现形"的）：
1. **被收起的关联节点没有几何**：jsMind 里元素还在、`getBoundingClientRect()` 是 **0×0** ⇒ 缩放算出
   退化框（s 直接飙到上限 4）、线端点全错（实测"越界=5、占比=0.00、误差 135px"）。修法：
   展示前**展开祖先**（"缩放至刚好展示"的前提就是它们可见），并**把退化矩形当"没渲染"**；
2. **跨项目与"展开后仍不可见"的要如实计数**（`unrendered` / `crossProject` 进状态栏文案）。

**判别力证明（实跑）**：把 `#mm-rel-layer` 从 `fdViewEls()` 里摘掉（= "忘了挂进去"这个最容易犯的错）
⇒ 第 2 条断言**报红**：`最大端点误差=267.7px`（正常 0.0px）⇒ 撤销后复绿 12/12 ✓。

**测试**：单测 `tests/related-model.test.js` **10 条**（并集/去重/跨项目/毛线球上限/垃圾数据不抛）；
冒烟 `scripts/smoke/25-related-view.js` **4 条**（全部几何或机制级：越界数+占比判定"刚好框住"、
端点**屏幕坐标**误差判定"线随变换"、assocId+大锁+盖住点击点判定"按鼠标位置开笔记"、Esc 后清干净）。
**顺序依赖的教训**：本域最初借真实节点（`tcp-reliable`）⇒ 单跑绿、**全量红**
（`节点不存在` —— 前面的域会删节点 ✗）；改成自造节点又**进不了界面内存**（界面先于种子加载完 ⇒
详情框停在旧节点 ✗）。最终做法：**运行时从界面自己的树里挑两个真实存在的节点**，再用 CLI 建关联笔记 ✓。
连带把 `seed` 的"静默返回布尔"改成**如实报错**（否则全量里红了看不出原因）。

**顺带**：`MM.getFloatDetailState()` 增加 `width/height`（断言要判"框是否盖住某点"必须知道框多高；
先前用 DOM 选择器找框会**选到节点详情框**，量出 136×99 ✗）。观察（未修，非本功能引入）：
关联页框在窗口 795 高时会到 926 高 ⇒ 位置会被夹回视口（行为正确，已按"覆盖住点击点"判定 ✓）。

### 功能 4 批 2：`verify --changed` —— 按改动面裁掉用不着的步骤（2026-10-08）

**为什么**：全链 ≈125 s，其中**冒烟段 ≈102 s（81%）**，而多数改动（改文档、改一条单测、改某个冒烟域）
根本用不着那 101 秒 ⇒ 现实里只有两种选择：每次都付全价（慢），或凭感觉跑（漏）。
现在"该跑什么"是**机械可算**的答案。

**映射**（`scripts/changed-plan.js`，纯函数 + **31 条单测**；由 `verify.js --changed` 调用）：
| 改动落在 | 跑 | 实测成本 |
|---|---|---|
| `docs/**`、`CHANGELOG.md`、`README.md`、`.review/**` | G1+G8+G9+G3+G6 | **≈19.7 s**（对比全链 125.7 s ⇒ **6.4×**） |
| `tests/**` | G1+G8+G9+G3+G6 | 同上 |
| `scripts/smoke/NN-*.js` | G1+G8+G9+G6+**G5（收窄到该域）** | 冒烟只跑该域 + `01-*` 预热 |
| 认不出的（`renderer/**`、`src/**`、`main.js`、门禁自身、`projects/**`…） | **全量** | 125 s |

**三条保守设计（都是踩过坑换来的）**：
1. **认不出的路径一律全量** —— 这是它唯一允许"多跑"的方向（宁可多跑，不可漏跑）；
2. `G1/G8/G9` **恒定跑**（≈1.5 s 合计；G8 还负责"新代码文件必须入档"，任何代码改动它都该看一眼）；
   **干净工作树 ⇒ 一步都不跑**（不许跑两件卫生门禁假装"验证过了"✗）；
3. 冒烟**只在**"G5 的唯一来源是已知冒烟域"时才收窄，且走既有 `SMOKE_ONLY`
   （它的选择器本来就会"筛错名字响亮失败"并自标"过滤运行不是全量真值"✓）。

**"部分验证"绝不当验收**（这条是设计里最要紧的）：
- 输出顶部**显式横幅**：`⚠️ == 部分验证（--changed）== **这不是全量真值**，发版/交付前请跑 npm run verify`，
  并逐条打出"为什么选了这些"（哪条规则、几个文件、理由）；
- 记录写进**另一个格子** `.review/last-verify-changed.json` —— **不覆盖** `last-verify.json`
  （那句话回答的是"上次**全链**绿没绿"，被一条只跑了 4 步的记录改写就变成假事实 ✗）；
  开跑时若存在部分验证记录，会**另起一行**说明"另有上次**部分**验证"（不提会让人以为没跑过）；
- 历史记录标 `partial: true`，**耗时基线不认它**（与"失败/中断的运行不当基线"同一个理由）；
- 表里把跳过的步骤标成 `（--changed 计划外：跳过）`，不是 `ms=0`（那会被读成"很快" ✗）。

**一条由实测推翻的规则**：原以为"文档改动只要 G6"更快 —— 实测 G6 单独跑 **18.1 s**
（它会**自己重跑一遍 vitest** 取用例数），而 G3(17.6 s)+G6(0.6 s)=18.2 s ⇒ 耗时一样，
但后者**单测真的跑了** ⇒ 规则改成带上 G3 ✓（数字是量出来的，不是估的）。

**接线检查**（`tests/changed-plan.test.js` 5 条，源码级）：`SMOKE_ONLY` 真的传给了 G5、
计划外步骤真的被跳过且标了原因、两处收尾都走"partial ⇒ 另一个格子"、历史真的带 `partial`、
横幅真的说了"这不是全量真值"。`--plan-only` 可以只报计划不跑（给人/AI 看"为什么选了这些"）。

### 度量列：耗时表现在直接打出"比上次快/慢多少"（2026-10-08）

**为什么**：本链有过一次真实教训 —— 从 176 s 压到 77 s 之后**又慢慢涨回去**（`01` 里那个 70 s 与后来的 118 s
就是同一件事的两个时点）。只打印"本次耗时"看不出趋势 ⇒ "这轮省下的"没人知道、也就没人守。

**实现**（`scripts/verify.js`，全部只影响**控制台输出**，不进任何生成物 ⇒ 不违"文档不含易变内容"）：
- 耗时表新增 `上次` / `差` 两列（差的格式**总是带符号**：`+7.6s` 变慢 / `-12.3s` 变快 / `±0.0s` 持平 / `—` 无数据）；
- 合计行同样带差；比上次慢 **>15%** 时加一行提示（**只提示不判红** —— 同一份代码实测能差 20%+，判红交给预算 ✓）；
- 历史在**写本次记录之前**读（就在打印那一刻）⇒ 比的是"上一次"，不是自己；
- **基线只认"最后一次成功的验证"**（`pickHistoryBaseline`）：失败/中断的那次步骤压根没跑完，
  拿来比是**假信号** —— 实测踩到（一次在 G4 中断的运行让下一次全链显示"比上次慢了 +101.7s" ✗）。
  表头会打出对比对象的时间戳，并在它不是紧邻那次时说明"中间有失败/中断的验证" ✓；
- 三个新纯函数 `readHistoryBaseline` / `pickHistoryBaseline` / `historyDelta` / `fmtDelta`：读不到历史返回 null（首次运行）、
  `skipped` 的步骤不参与比较（它的 ms 是 0，比出来是假信号 ✗）、坏行不抛。
- 单测 6 条（`tests/verify-budget.test.js` 20 → 26）。

### 防挖空：验证规模不得静默下降（2026-10-08）

**为什么**：断言数是本工程唯一"覆盖规模"的机械真值，而**删掉一批断言不会让任何门禁变红** ——
G6 只查"文档与代码一致"（删完重跑 `facts:write` 就又一致了 ✗），G5 只查"跑没跑过"。
于是一次"为了让它绿"的清理就能把覆盖悄悄削掉，而所有人都以为还在守（这正是本工程最重的损害类别：静默）。

**实现**（`tests/truth-floor.test.js`，3 条）：以**已提交**的 `git show HEAD:docs/VERIFY.md` 为**地板**，
当前 `docs/VERIFY.md` 的任何一项（命令数 / MCP 工具数 / 单测用例与文件数 / 集成断言 / 冒烟断言 / 视觉断言）
低于地板即红，并逐项报出"多少 → 多少（少 N）"。
- **为什么地板取已提交的那份**：当前那份是**生成物**，删掉断言后重跑 `facts:write` 它自己就变小了 ⇒ 拿它当地板等于没地板 ✗；
  也**不写在测试文件里当常量**（那是第二份会漂移的副本 ✗）。
- **降级**：没有 git 历史 ⇒ **响亮跳过**（打印 `[防挖空] …本次跳过地板核对，未在守护`），不当假红 ——
  它是安全网不是门禁（同 `verify.js` 的 `backupHint()` 对"有没有本地 Git"的处理风格）。
- **判别力证明（实跑）**：把 `scripts/smoke/13-ui-state.js` 的导出改成 `assertions.slice(1)`（模拟悄悄少一条断言）
  + 重跑 `facts:write`（真值降为 137）⇒ 地板检查**报红**并直指"冒烟断言下降"；撤销两处后转绿 ✓。

### 权限漂移按"对齐现实"收口 + aimindmap 设为默认模式（2026-10-08，使用者决定）

**权限漂移**：`overrides` 声明 `permission.defaultPreset: workspace-write`，而现网（自 2026-09-30 那次手工改动被重跑导入冲掉之后）
一直是 `full-access-review` —— 两个文件说的不是一回事，且**任何一次 `render`（升级运行包 / 重跑插件导入之后都要跑）都会把声明悄然生效**，
即"一个会自己找时机生效的决定"。使用者选择 **B：把声明改成现实**（`full-access-review`）⇒ 声明与现网一致，
**本次 render 对权限零改动**（值本来就相同），隐患消除，`check` 的 `✓ permission.defaultPreset` 转绿 ✓。

**默认模式**：应用户原话"单独加一个**默认使用**的 aimindmap 模式"，渲染器新增 `$presets.<id>.makeDefault`：
在同一个生成块里追加一条**按 id 覆盖**的 `agent-preset-registry: {default: aimindmap}`
（注册表那行由 `dsh-web-app` bundle 定义、不在 profile patch 里 ⇒ 只能用按 id 覆盖这种形态；
该行 config 只有 `default` 一个键 ⇒ 整份替换是完整的 ✓）。
⚠️ **用户选择优先**：界面里选过模式（volatile `selectedDefault`）时部署默认不生效 —— 那时再选一次 aimindmap 即可。

**结果**：`overrides check` **全绿**（`✓ permission.defaultPreset = full-access-review` + `✓ $presets.aimindmap`）；
自检 **PASS 8 / FAIL 0 / UNKNOWN 2**（此前 6/2/2：漂移一条 + 一次热重载瞬态）；
服务日志 `[hub] routes mounted (profile=web)` 无激活错误 ⇒ 侧栏照常起。

**测试**：`tests/dsh-embedded-overrides.test.js` 22 → 26 条（新增：`makeDefault` 生成注册表覆盖行且与声明同块、
不给 `makeDefault` 就**不碰**别人的默认模式、`makeDefault` 必须是布尔）。台账 A5 同步写入默认模式与"用户选择优先"这条。

### 自检第 5 项改对了判据：从"目录里有文件"改成"模式**被声明**"（2026-10-08）

**问题**：自检第 5 项（`scripts/dsh-embedded-check.js`）核对 `.agent-presets\` 的**文件数与哈希**，
但内核**已不再读那个目录**（`Nothing reads that directory any more` ⇒ 见 `docs/DSH-EMBEDDED.md` A1 更正）
⇒ 它核对的是一份**不影响生效的副本** ✗：文件在、判 PASS，而模式可能根本不存在。
（同一天还发现过它的反面：第 8 项在 patch 热重载的瞬间读到 `null` 报了 FAIL，其实注入链是好的。）

**改法**：第 5 项改为 **「模式被声明」** —— `overrides.$presets` 里每个模式都必须在
`cordis.patch.yml` 里有对应的 `- id: preset-<id>` 行（机械可判）；**遗留目录降级为信息**附带报告
（"内核已不读，仅留档"）；内容级核对（生成块逐行比对）留在第 6 项，**不在两处表达同一事实**。
台账 §4 的自检表同步更新。

**实测**：第 5 项 ⇒ `PASS 已声明且在 patch 里: aimindmap；遗留 .agent-presets: liangshen（内核已不读，仅留档）`；
`--json` 输出仍是**纯 JSON**（10 项，已单独验证 —— 该项的 stdout 纯度是既有契约）。
另两项 UNKNOWN 保持原样（第 2 项需跑重命令、第 9 项需人工点一次右栏）；第 6 项仍 FAIL，
原因是**既有的** `permission.defaultPreset` 漂移（`workspace-write` vs 现网 `full-access-review`），
与本次改动无关 —— 改不改那个档位由使用者定（改它 = 改内置 AI 的沙箱档位）。

### 框选拖动可以保存了：顶层主题偏移进 `meta.themeOffsets`（2026-10-08）

**症状（用户报的）**：「框选之后的移动功能应该可以通过保存永久化，而不是无法保存」。
根因不是 bug 而是设计缺口：拖动改的是**渲染层的 `treeOffsets`**（给顶层主题的 jmnode 加 CSS `transform: translate`），
而数据模型里**根本没有坐标字段** ⇒ 保存时它不在数据里，重新打开自然弹回原位（撤销也一样，因为撤销快照 = 序列化结果）。

**实现**（四处，全部围绕"**唯一真源在视图层**"）：
- `renderer/app-view.js`：新增 `getTreeOffsets()` / `setTreeOffsets()`（前者只回**当前树里真实存在的顶层主题**的非零偏移，
  后者按当前树筛掉不存在的 id、坏数据一律忽略）；`clearTreeOffsets(treeId)` 支持只清一棵。
- `renderer/app-core.js`：`serializeTree()` 向视图要偏移并**条件写回** `meta.themeOffsets`（与既有 `rootMode` / `layout`
  同一套手法 ⇒ 没拖过的项目与旧文件**零差异**）；`renderMind()` 在 `state.jm` 就位、节点 DOM 建好后**恢复**偏移
  （`renderMind` 是打开项目与 undo/redo 的唯一入口 ⇒ 一处覆盖两条路径）。
- `src/schema.js` + `docs/DATA-FORMAT.md`：可选字段校验 + 契约行（形状、语义、"只影响呈现、不改父子关系"、
  只写非零项、缺省 = 自动布局）。**格式版本不升**（可选新增，老文件照样读）。
- `renderer/contextmenu.js`：框选菜单新增「**把这棵树移回自动布局**」—— 拖动结果现在会保存，就必须给一条清回去的路。

**顺手补的一个缺口**（不补的话这功能一上线就会被骂）：折叠/展开会**重建节点元素**，元素上的偏移 transform 随之丢失 ⇒
那棵树看着散架。现网此前也有，只是偏移不持久所以不显眼。修法：`wrapLayoutAnchor` 包住的 `view.relayout()`
是 jsMind 重排的**唯一入口**，在那里补一次重放（无偏移时空跑，零成本）。

**验收（冒烟 09-*，真手势）**：`选中顶层主题 → 进入拖动模式 → 合成 mousedown/mousemove/mouseup` 拖 (+120,−60)
⇒ 偏移 = `{x:120,y:-60}`（与位移精确相符）⇒ **保存 ⇒ 从磁盘重开项目 ⇒ 偏移一模一样**、界面不脏、DOM 上确有
`translate(120px, -60px)` ⇒ 收尾清掉并保存（不留脏状态给后续断言）。
**判别力证明（实跑）**：把 `serializeTree()` 里那行写成注释（刻意不写 themeOffsets）⇒ 该断言**报红**且诊断直指
`重开后=undefined`；撤销后同一域 13/13、全量 138/138 + 视觉 2/2 通过。

**规格边界（写清楚免得被当 bug）**：① 偏移是**逻辑画布像素的相对偏移**（不是绝对坐标）⇒ 增删节点不会让旧偏移失效；
② `meta` 在冲突指纹里是**整体一个键** ⇒ "你拖主题 A、我拖主题 B"会被判成同一对象冲突（不能自动合并）——
拖动是低频动作，撞车时人工决定即可；③ CLI **只读透传**（`read --json` 里能看到），不提供写命令（没有这个需求）。

### 覆盖渲染器支持 agent preset 声明：为「aimindmap 模式」备好可重放的载体（2026-10-08）

**背景**（功能 6，调研见 `.review/20261008-DSH深度集成调研/07-功能6-DSH模式与人设.md`）：
内置 DSH 的「模式」= `@deepseek-ai/dsh-agent-preset` 的一条**声明**，而它的 `plugins` 是**该模式 agent 的全部能力**
（人设 / 工具 / 技能 / plan-mode / 压缩 / 委派 —— 实测「标准模式」那份 **19 个顶层条目**，其中 3 个是分组、组内还有子行）。
内核自带的声明在 `dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`，**是运行包的事实、随升级会变** ✗。
⇒ 手抄一份清单进本仓库 = 又一份会漂移的副本（同 `docs/DSH-EMBEDDED.md` §5「快照漂移」那一类）。

**实现**（扩 `scripts/dsh-embedded-overrides.js`，它是那份 patch 的**唯一写者**，不另开脚本）：
- 新的陈述式键 `"$presets": { "aimindmap": { "cloneFrom": "standard", "order": 0 } }`；
- 渲染时**从运行包自带的 `presets/<cloneFrom>.patch.yml` 读出 plugins 段原文**，
  只把 `persona` 行的 `prefix` 换成脚本内的人设文本（块标量 `|-`，往返逐字相等）⇒ 单一真源 ✓；
- 生成块带 BEGIN/END 横幅、**幂等**（重复渲染整块覆盖，第二次"无需改动"）、写盘前备份；
- `check` 除了比标量，还把生成块与"现在重新生成的结果"**逐行比对** ⇒ 手改或半截块都会红 ✓；
- 白名单纪律不变：`$presets` 的 id 必须在脚本的 `PRESETS` 里、`cloneFrom` 必须是运行包里真实存在的 preset，
  否则**报错退出**（不许猜 ✗）；运行包路径给错也响亮失败（不静默生成空清单模式）。
- 顺手修：脚本此前**没有 `require.main` 守卫**（`require()` 它会当场执行 CLI 并 exit ⇒ 不可单测）。

**测试**：`tests/dsh-embedded-overrides.test.js` 13 → **22 条**（新增：结构与"逐行 id 与运行包一致"、
人设落位与占位符保留、幂等、手改被抓、运行包路径错、白名单拒绝、require 守卫）。全部在**临时 home** 上跑，
不碰真实实例 ✓。

**现网已 apply（2026-10-08 11:27）**：`render` 把生成块写进 `profiles\web\cordis.patch.yml`（先备份 `.bak-<时间>`）；
`check` ⇒ `✓ $presets.aimindmap`。⚠️ **apply 时故意不动权限键**：overrides 里原有的
`permission.defaultPreset: workspace-write` 与现网（`full-access-review`）不一致是**既有漂移**（台账 A3 那次手改被冲掉的后果），
改它等于改内置 AI 的沙箱档位 —— 与"加模式"无关，故**保留原样**、`check` 仍如实报那一条 ✗（与 apply 前一致）。
**生效判据**（人工 5 秒）：内置侧栏 → 新建任务 → 模式选择器里应有「aimindmap 模式」。
台账 `docs/DSH-EMBEDDED.md` 同批更新（新增 A5 行；并**更正 A1**：遗留 `.agent-presets\liangshen` 是内核已不再读取的形态，
"文件数+哈希"核对的是**不影响生效的副本** ✗ —— 真正生效靠插件声明）。

### 修一条顺序依赖的冒烟假红：save() 会重建 jsMind 实例，旧引用必须弃用（2026-10-08）

**症状**：全量冒烟里 `09-*` 的「未保存改动判定」四个值全是 `false`（`复位后=false 新增后=false 改详情后=false 保存后=false`），
但**单跑该域 12/12 全绿** —— 典型的顺序依赖假红。前一会话修过它的另一半（"刚载入应为干净"的假设），这次是另一半。

**定位（实测，不靠猜）**：
- 二分 `SMOKE_ONLY`：`02,03,04,09` 红 → `05,06,07,08,09` 绿 → 逐个试 ⇒ **元凶是 `04-*`**（`04,09` 红、`09` 单跑绿）；
- 诊断探针打出 `saveOk=true 项目=comnet **jm唯一=false**` ⇒ 复位那次 `save()` **成功了**，
  但**当前 jsMind 实例已经不是断言开头抓到的那个**。

**根因**：`await app.save()` 在"盘上这份与载入时那份不一致"时走**三方合并**，而合并路径会 `rebuildFromJson()` ⇒
**jsMind 实例被重建**。断言在 await **之前**缓存了 `var jm = app.getState().jm`，
之后 `jm.add_node(...)` 改的是**已脱离的旧实例** ⇒ 应用真正的树一字未变 ⇒ `isDirty()`（**快照比对**实现）恒 false。
`04-*` 只是"留下不一致"的那个前提，不是错误本身 —— 所以它单独跑也看不出问题。

**修法（结构化，不是补丁）**：`scripts/smoke/09-save-persistence.js` 三条断言统一改为
**`jmNow()` 现取**（`app.getState().jm` 在使用点取），并在文件头写明这条陷阱与实测证据。
⇒ 以后**任何 await 之后要动树，都不许复用旧引用**。

**验证**：`SMOKE_ONLY=04,09` 23/23 通过（原 22/23）；全量冒烟 **137/137** + 视觉 2/2。

### 冒烟保帧开关：治"隐藏窗口不出帧"引发的假红（2026-10-08）

**症状**：G5 冒烟段偶发假红 —— 隐藏窗口捕到的帧可能偏黑/偏旧，断言里的 `setTimeout` 也可能被降频。
假红的真正代价不是那一次红，而是**有人把断言关掉**（本工程已发生过门禁退化与数字漂移）。

**来源（不是现想的）**：Playwright 给 Chromium 的默认启动参数（官方源码
`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`，Apache-2.0）。
**只照搬开关名，不引任何依赖**：三个 `disable-*`（遮挡不后台化 / 渲染进程不降级 / 后台定时器不降频）
+ `enable-features=CDPScreenshotNewSurface`（抓帧走新 surface）。

**实现**：
- 清单是**纯函数** `scripts/smoke-flags.js`：`keepAliveSwitches(isSmoke)`，**正常启动返回空数组**；
- `main.js` 在**窗口创建之前**、**只在 `--smoke` 分支**追加（Chromium 只认启动前参数）；
- **三道锁**（缺一就会退化成"注释里声称加了"）：
  · `tests/smoke-flags.test.js`（7 条）锁清单内容 + **接线**：调用点必须在 `isSmoke` 守卫内、且在 `new BrowserWindow` 之前（源码级检查，同 `tests/verify-budget.test.js` 守 RULES→verify 接线的做法）；
  · `scripts/smoke/14-headless-window.js` 新增一条断言，机械核对四个开关**真的加上了**（无值开关必须走 `hasSwitch` —— `getSwitchValue` 对"无值"与"没有"都返回空串，区分不了）；
  · 冒烟断言文件**不得在顶层 require electron**（`scripts/doc-facts.js` 会在纯 node 里 require 它来计数）⇒ 一律惰性取。

**判别力证明（实跑，非口头）**：把 `main.js` 里那个守卫临时改成 `if (false)` ⇒ 新断言**报红**并逐项列出缺哪些开关；
**同一次运行里"隐藏窗口能出帧"那条仍然 PASS** —— 这恰好说明新断言的价值：帧断言是**偶发**的，新断言是**确定**的。
撤销注入后同一域 11/11 通过。

**能力边界（诚实标注）**：这四个开关在 **Electron 44** 上的**实际效力尚未验证**（来源是 Chromium/Playwright 的用法，
不是 Electron 文档）。判据是**长期指标**：`verify-history.jsonl` 里 G5 的假红率与耗时趋势（真涨了 >10% 就该撤）。
正常启动不带这些开关 —— 否则会改变真实用户进程的功耗与后台行为。

### 内核「打开侧边栏」右栏：自动加宽侧栏、关掉还原（2026-09-30，用户提议）

**症状**：内置 DSH 右上角「打开侧边栏」（Ctrl+Shift+B）点一下就消失 ✗ —— 面板里是
「工作区文件 / 上下文 / 新建终端」三块 ✓。

**根因**（读内核 `@deepseek-ai/dsh-client-ui-layout/lib/client.js` 得到，非插件 ✗ 非我们的窄宽 CSS ✗）：
```js
const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);   // 左栏：展开 280 / 图标轨道 56
const available = viewport - s - 400;                           // 中间列保底 400
const r = rightbar === 0 || available < 300 ? 0 : …;            // 不足 300 就把右栏宽度算成 0 ✗
const narrow = viewport < 1024;                                 // 窄模式下开右栏时左栏按 0（=56）算
```
⇒ 窄模式下需要 **view ≥ 56 + 400 + 300 = 756px**；而我们的侧栏上限是 **720** ⇒
**这个面板以前也打不开** ✓（实测 694 时 available=238 ✗、720 时也只有 264 ✗）
—— 用户感觉"以前能用"应是在铺满（仅侧栏模式）或全局 DSH 里点的 ✓。

**实现**（用户提议：开右栏自动加宽、关掉还原）：
- 侧栏上限 **720 → 900** ✓；自动加宽目标 `RIGHTBAR_AUTO_WIDTH = 900`（view 870 ⇒ available 414 ≥ 300 ✓）。
- 注入观察器到 DSH 页面（每页装一次 ✓）：
  · **事实**信号：官方 frame 的 `data-rightbar-collapsed` 属性（MutationObserver）⇒ `[dsh-rightbar-open|closed]`；
  · **意图**信号（必须）：点官方「打开侧边栏」（title/aria-label 双语匹配）或 Ctrl+Shift+B ⇒ `[dsh-rightbar-request]`
    —— 因为**宽度不够时内核属性根本不会变**，只靠属性检测不到用户点击 ✗（实测踩到的坑）。
- 主进程：`ensureRightbarRoom()` / `releaseRightbarRoom()` —— 幂等、只在我们仍处于自动宽度时还原 ✓
  （用户手动改过宽度就不动 ✓）。
- `dsh-status` 新增 `rightbarOpen / autoWide / rightbarWatcher` 三个只读字段 ✓。

**断言**（`scripts/smoke/24-*` 实测）：
`【右栏自动加宽】加宽=true/900 幂等=true 还原=true/694 已够宽不动=true 契约=true` ✓

### ③ 窄宽适配的实测 + 只读诊断 `dsh-status`（2026-09-30，用户追问"做完了吗"）

**为什么加这个命令**：窄宽适配（③）的效果原先只能靠肉眼看 ✗，而"改布局"必须有数字 ✓。
新增**只读**控制通道命令 `dsh-status`（**输出白名单、绝不带 url/token** ✓），CLI 侧
`node cli/mm-cli.js dsh-status [--json]` ✓。

**第一条实测**（当前 694px 侧栏）：
```
侧栏状态: running（可见）
宽度: 意图 694 / 实际占宽 694（控制栏 + 内容）
窄宽适配: 模式 wide，内容宽 664，页面 664px / 内容 664px ⇒ 不溢出
```

**这条诊断一路挖出 ③ 的两个真 bug**（都是"看起来没做、其实卡住"的类型 ✗）：
1. **URL 比对永远失败** ✗：DSH 页面加载后会把地址栏里的 `?token=…` **抹掉**（安全惯例），
   而我做的是**严格全等比较** ⇒ 注入一次都没跑过；改成只比 **origin + path** ✓。
2. **重试预算太小** ✗：一次性调度赶不上 DSH 页面加载 ⇒ 加**有限重试**（12 次）+
   早退时**记下原因**（`state.narrowSkip`）✓ —— 没有这个"原因"字段，上面两条只能靠猜 ✗。
   同时修掉"每次 relayout 都重置"的写法（resize 风暴下会无限重置 ⇒ 表现为"永远没注入" ✗）。

**给断言加的**：`24-*` 现在检查注入规则**内容**本身（`min-width:0` / `.dsh-narrow` /
`.dsh-narrow-xs` / `overflow-x:hidden` ✓）—— 空 CSS 同样是"没做"，但外观上看不出来 ✗。

### 对称能力：保留主界面、独立关掉侧栏 DSH（2026-09-30，用户要求）

用户要的对称语义（此前只有"关左页留侧栏"一个方向）：
- **侧栏右上角新增 ✕**（就在「—」**下面**）⇒ 收起侧栏**并停掉 DSH 服务**，**主界面（思维导图）继续运行**、
  让位宽度归零 ⇒ 导图铺满；点主界面右缘的 🤖 即重新打开（`show()` 发现服务不在会自动重新孵化/接管）。
  这样"只改 DSH 那一侧"（插件/配置/运行包）时**不必重启整个应用** ✓。
- **「—」位置下移**（y=4 → y=44）：原先会压住 DSH 页面自己的头部 UI（用户实测反馈）。
- 仅侧栏模式下点这个 ✕ 会**先恢复主界面**再关侧栏（否则关完窗口是空的 ✗）。

**给 AI 的对称接口**（人类用按钮；两条都"有回执才算生效"）：
```bash
node cli/mm-cli.js sidebar-only on|off   # on=只留侧栏（关导图页）
node cli/mm-cli.js dsh-sidebar  on|off   # off=关侧栏 DSH（连服务停；主界面不受影响）
```
控制通道（`src/control.js`）新增 `dsh-sidebar` 命令；`closeSidebar()` 带 `keepService` 选项仅供断言用
（冒烟进程可能正接管着用户的真实服务，断言不能把它杀掉 ✗）。

**验证**：新增冒烟断言 `scripts/smoke/24-sidebar-close.js`（实测输出）：
`【几何】— y=44  ✕ y=74  同列=true  在侧栏内=true｜【关后】主内容可见=true 让位宽度=0 visible=false｜【重开】visible=true`
—— 把"✕ 在下面、不重叠、已下移、关掉后主界面铺满、能再打开"四条都变成机械判据 ✓。

**文档体系同步**（用户明确要求，避免"改一边"这事只有我知道）：README 的对称能力表 + `docs/AI-GUIDE.md`
新增 §4.0「只改一侧」+ `docs/ARCHITECTURE.md` 的 `commands/ui.js` / `control.js` 两行 + `docs/CLI.md` 重生成 ✓。


### 两个 ✕ 的分工（用户指定的最终版）+ AI/DSH 接口（2026-09-29）

**用户定的语义**（我前两轮都理解错了 ✗）：
- **窗口 ✕ = 关整个应用**（连同侧栏一起）—— 不再是"藏到后台"，也不再是"只关左页"；
- **导图页右上角一个独立 ✕ = 只关左边导图页**：进"仅侧栏"模式（`body.dsh-only` ⇒ `#main`/`#toolbar` 隐藏），
  并且**连应用菜单栏一起隐掉**（`win.setMenuBarVisibility(false)`）；DSH 侧栏继续显示、对话保活；
- **菜单里的「退出」删除**（退出就用窗口 ✕，加速键 Ctrl+Q 一并去掉）；
- **回去的路（必须有，否则卡死在这一页 ✗）**：仅侧栏模式下，侧栏右上角那个原生按钮从「—」变成
  「⤢ 恢复思维导图页」（`[dsh-restore]`），点它回到导图页。
- DSH 服务不变：退出**不收割已就绪的服务** ⇒ 下次打开对话还在。

**接线**：`#btn-close-map`（渲染层动态插入到工具栏右端）⇒ `desktop.dsh.sidebarOnly(true)`
⇒ IPC `dsh-sidebar:sidebar-only` ⇒ `setDshOnly(true)`。给 AI/DSH 的同一能力仍走 CLI
`sidebar-only on|off`（文件式控制通道，无回执即报错）。

**验证**：冒烟断言 `scripts/smoke/23-dsh-only.js` 扩到 4 个观察点 —— 进模式：`#main`/`#toolbar` 不可见、
侧栏宽 == 窗口宽（1424==1424）、**菜单栏不可见**；出模式：全部恢复、侧栏回到 624、菜单栏回来；
侧栏 view 全程存在。另：`desktop.dsh` 键集合断言同步加 `sidebarOnly`（防"新 API 悄悄漏登记"）。

### 整窗截图（能看到原生侧栏）+ 关主窗口不再关侧栏（2026-09-29，用户提出）

**整窗截图 `--export-window <out.png>`**：分别截「主页面」与「原生侧栏 view」，
再按侧栏真实 `getBounds()` 贴回主图（合成器 `scripts/vision/window-shot.js`，纯函数、有单测）。
尺寸取**窗口内容实际大小**（自适应，不写死分辨率）—— 起因是用户问"截图不能截大一点/自适应吗"，
而更本质的需求是：**要一张能看到侧栏的图**（原生 view 不在 `capturePage()` 里，这是唯一的离线办法）。
**已知边界（如实记）**：离屏实例里侧栏 view 的页面可能一直没渲染 ⇒ 拿不到侧栏那块（本轮实测 20s 重试仍未出图 ✗），
此时工具会明确打印"侧栏 未进来"而不是假装拍到了；有真实窗口时该路径正常。

**关窗语义改为"藏到后台"**（用户要求："除非更新内置 DSH 或重启它，都不要关闭侧边栏"）：
✕ = 主界面隐藏，**侧栏 view 与 DSH 服务都不动** ⇒ 对话保活（任务栏可复原）；
真正退出走「文件 → 退出 / Ctrl+Q」（`before-quit` 置 `quitting` 放行，那时才按驻留语义处理服务）。
实测证据：本机跑一次 `--export-window`（离屏实例）日志出现 `[dsh-sidebar] 已接管驻留服务 pid=…`，
退出后用户原窗口与服务**都还在** ⇒ 保活链路成立；我自己的验证工作流也随之改为**不再强杀应用**（见下）。

**我的验证工作流（写进文档，避免再犯）**：
- 只改 `renderer/*` ⇒ 你按 **Ctrl+R**（视图菜单有 `reload`）重载页面即可，侧栏 view 完全不受影响；
- 改主进程（`main.js` / `main-dsh-sidebar.js`）⇒ 走「文件 → 退出」再启动，**驻留服务与对话存活**；
- 我这边**不再** `Stop-Process -Force` 杀 electron（那是把侧栏一起带走的元凶，也是之前把整机提交内存顶到 80% 的元凶）。

**配套补上的"回去的路"（实测才发现缺）**：单实例锁 + `second-instance` ⇒ `restoreWindow()`。
没有它，藏到后台就再也回不来（既无托盘、也没有任何调用 `restoreWindow` 的地方，再启动只会开出第二个实例 ✗）。
实测（真实流程）：点 ✕ ⇒ electron **7 个进程全在**、有窗口的 **0** 个、DSH 服务 **3 个**在；
再启动一次 ⇒ 窗口回来且 **pid 不变**（没开第二个实例）、服务全程存活。

**⚠️ 同时抓到一个自己造的假绿（已修）**：单实例锁一度把**冒烟**那个实例也挡在门外 ⇒ 冒烟一条断言都没跑，
G5 只用 **2.2s** 就被判"通过" ✗（全链 12.6s vs 正常 ~103s）。修法两条：
① 单实例锁只在**真实交互模式**申请（`isSmoke / --export-image / --export-window` 一律不加锁）；
② `runSmoke` 增加**环境守卫**：窗口不可用或找不到断言文件 ⇒ `SMOKE ENV ERROR` + `exit 1`（"没跑"绝不能算"通过"）。
修后全链回到 **103.3s / G5 = 93.4s** ✓。

### 侧栏隔壁的"灰色背景" + 折叠后重开圆钮消失：真因是我自己漏写两行（2026-09-29，用户两次反馈）

**真因（已复现、已修、有数字）**：上一轮我给 `applyLayout` 加"状态没变就 return"的幂等守卫重写本函数时，
把两行**必需**的 DOM 同步漏掉了 ✗：
```js
document.body.style.setProperty('--dsh-sidebar-width', width + 'px');
window.__dshSidebarW = width;
```
后果一：页面**从不写内联变量** ⇒ `--dsh-sidebar-width` 回落到 `style.css` 的兜底值 **420px**，
而侧栏实际只有（用户拖过的）308 ⇒ 页面多留 **112px** ⇒ 就是那道灰缝（与用户截图 ≈114px 一致）。
后果二：折叠圆钮（🤖 重开入口）的显隐也被裹进了守卫里 ⇒ 按下侧栏减号收起后，重开圆钮不出现。

**修法（把语义理清，避免再犯）**：`classList` / CSS 变量 / `__dshSidebarW` / FAB 显隐都是**纯 DOM 同步、每次必做**
（幂等且代价极低）；守卫只守住**扰动视图**的那一件事 —— `resize` 派发（启动时那次主动询问不该白扰动视图）。

**验证**（`scripts/smoke/22-sidebar-gap.js`，冒烟里主动建出侧栏 view 再量）：

| 场景 | 页面预留 | 侧栏实际 | 缝 | 折叠后重开圆钮 |
|------|---------|---------|----|---------------|
| 宽窗 1424 | 280 | 280 | **0px** | flex/visible ✓ |
| 最小窗 944 | 280 | 280 | **0px** | — |

判别力：把上面两行再删掉，这条断言立刻变红（420≠280 ⇒ 缝 140px）✓。

**两条方法论收获（比修复本身值钱）**：
1. **这类缺陷截图永远看不见**：侧栏是原生 `WebContentsView`，`capturePage()` 只截页面 ⇒ 判据只能是**几何**
   （页面预留宽度 == 侧栏 `getBounds().width`）。用户问"你到底有没有截图检查"时，答案是"看了也看不见，得量"。
2. **"顺手加守卫"是这个 bug 的来源**：守卫把**纯 DOM 同步**和**会扰动视图的动作**混在了一起 ——
   前者必须每次做，后者才需要"变了才做"。混在一起的代价是两个用户可见回归。

### 冒烟支持"单跑"：只验一条断言从约 100s 降到约 4s（2026-09-29，来自"为什么这几轮这么慢"的复盘）

**背景（实测）**：全链一轮 100–122s，其中冒烟（Electron 无头 + 截图 + 视觉断言）占大头；改一条断言就得
等整轮，而每一轮都真启动 Electron、真占内存 —— 本会话反复跑把整机**提交内存推到 80%**（38.4/48.1 GB），
连带把同机的 Edge 拖卡、把 DSH 界面拖崩。日志侧证据：`GPU process exited unexpectedly: exit_code=3` 10 次、
`VirtualAlloc failed` 4 次、`GUARD TIMEOUT` 7 次、`mm-cli exited null` 1 次（新进程都起不来）。

**做法**：新增 `scripts/smoke-select.js`（**纯函数、零副作用、可单测**）＋ 主进程 `runSmoke` 接线：
- 用法：`SMOKE_ONLY=20,21 npm run smoke`（PowerShell：`$env:SMOKE_ONLY='20,21'; npm run smoke`）
  或 `electron . --smoke-only=20,21`；按**文件名前缀**选中，**永远并入 `01-*` 预热**
  （它负责加载渲染层并打开 comnet，后面的断言都假设这个前提）。
- **采不到真值 = 红**：选择串里任何一项没匹配到文件 ⇒ 打印 `SMOKE SELECTION ERROR` 并 `exit 1`，
  **绝不返回空集** —— "筛错名字却跑出 0/0 passed"正是本工程反复栽过的那种"没做，却看不出没做"。
- **过滤运行 ≠ 全量真值**：显著打印标记，并**跳过截图 / 取景记录 / 视觉断言**（省掉的正是 GPU 合成那段）；
  `docs/VERIFY.md` 的冒烟真值只由全量运行代表。

**实测**：`SMOKE_ONLY=21` ⇒ `过滤运行 9/9 passed`、**耗时 4s**（全量约 90–110s）；故意给一个不存在的名字
⇒ `exit 1` + 逐字指出没匹配到的项（这就是它的判别力证明）。

**文档同步（同批，按"改动即连带"）**：`docs/ARCHITECTURE.md` §2.6 登记新脚本（G8 第 7 条守着）·
`docs/AI-GUIDE.md` 的验证命令表 + 维护规范表新增"只改/只查某一条冒烟断言"一行（改动面 → 必跑哪层）·
`docs/VERIFY.md` 由它的生成器 `scripts/doc-facts.js` 重新渲染（生成物仍逐字校验）·
新增单测 `tests/smoke-select.test.js`（4 条，含"一项不匹配必须抛错"的判别力注入）。

### 刚打开时工具栏被 DSH 侧栏盖住（"稍微拖一下就恢复"）（2026-09-29，用户反馈）

**机制**（读代码 + 实测复现）：让位靠 CSS 变量，而**类与变量只在收到 `dsh-sidebar:layout` 事件时才设**：
`body.dsh-sidebar-on { --dsh-sidebar-width: 420px }` 与
`body.dsh-sidebar-on #toolbar { padding-right: calc(var(--dsh-sidebar-width) + 8px) }`。
主进程**首次发送发生在页面加载完成之前**（`init(win)` 里那次），渲染层的订阅还不存在 ⇒ 消息丢掉
⇒ body 上两个类都没有 ⇒ 工具栏右端不 reserve ⇒ 被原生侧栏盖住；拖一下侧栏 → `setWidth` → 再发一次
事件 → 恢复。**实测取证**（断言里保留）：清掉类与变量后工具栏 `padding-right=12px`（不 reserve）。

**修法**（两处，互为保险）：
- 主进程 `notifyAfterLoad()`：`did-finish-load` 后再补发一次布局（源头：那次发送太早）。
- 渲染层 `bindDshSidebar()`：订阅完**主动问一次** `desktop.dsh.status()`（已含 visible/width，无需新 IPC），
  与事件共用同一段 `applyLayout`；并**显式把变量写成 0px**（未定义会让 `calc()` 整条失效）。
- `applyLayout` 加**幂等守卫**：状态没变就不派发 `resize` —— 否则启动那次"主动问"会白白扰动一次视图。

**验证**：新增 `scripts/smoke/21-sidebar-first-paint.js`（整页重载复现"刚打开"，**不许拖任何东西**）：
① 机制取证：清掉类+变量 ⇒ 工具栏 `padding-right=12px`（不 reserve）；② 重载后：`class=true`、
变量 `420px`、工具栏 `padding-right=428px` ✓。判别力：去掉上面任一处修复，②立刻变红。

**顺带修好两条"判据本身错了"的陈旧断言**（它们把合法行为误判成回归）：
- `11-dsh-sidebar` 的让位断言用 "before ≠ after" 当判据，前提是"冒烟下渲染层收不到事件" —— 现在
  启动就会主动问到真实布局，`before` 本来就是 420px。改为直接验 CSS 契约（on ⇒ 420px / off ⇒ 0px）。
- `05-pan-lock` 的"拖动树后 Esc 保留偏移"用**绝对屏幕坐标**当判据：实测 Esc 时 jsMind 会重排，
  **两棵树一起上移 22px**（相对差一分未变、`fdView` 位移为 0,0）⇒ 旧判据把"合法重排"读成"偏移丢了"。
  改为**两棵树相对位置不变**（并保留诊断数值输出）。

### PDF 预览的缩放按钮无效 + ✕ 关闭是死按钮（2026-09-29，用户反馈"除了打开文件夹和系统打开，其他都有问题"）

两处独立缺陷，都用机械手段定位（不是靠点）：

1. **✕ 关闭从未接线**。扫描 `renderer/index.html` 里所有 `<button id="…">`（19 个）再在
   `renderer/*.js` 里找引用：只有 `fp-close` **一个字都没被提到** —— 用户只能靠 Esc 关预览。
   已补上（按惯例交给唯一入口 `closeFilePreview`）。
2. **页宽/整页/100% 接了线但毫无效果**：`setPdfSrc()` 只把 `iframe.src` 改成"同 URL 异 hash"，
   而那是**同文档导航** —— Chromium 的 PDF 查看器不会重新读 `#zoom`。
   实测取证（断言里保留这条）：直接改 hash **不触发 iframe 的 `load`**（次数 0）。
   修法：**先卸载（`about:blank`）再挂上目标 URL**，才是真正的重新导航；同时用 `pdfView.applied`
   记住已应用的 URL，避免打开同一份 PDF 时重复加载、关闭预览时清空（否则下次打开沿用旧 `#zoom` 不刷新）。

**怎么防它再犯（这次把教训变成机械检查，而不是"下次注意"）**：
- 新增单测 `tests/ui-buttons.test.js`：**每个带 id 的按钮都必须在渲染层被引用**，
  带**判别力注入**（喂一份"有按钮没接线"的合成 HTML，检查器必须报出来）与"按钮数不许悄悄归零"
  （防止解析失效导致门禁空转）。它当场就抓回了 `fp-close`。
- 新增冒烟断言 `scripts/smoke/20-preview-buttons.js`：机制取证（hash-only 不重载）+ 三个按钮
  必须"经过 about:blank 真重载且 `#zoom` 正确" + ✕ 必须关掉预览。判别力：把修复回退，后两条立刻红。
  断言自带"步迹"（哪一步抛错），因为冒烟的 THREW 只给一句笼统错误（本轮为此多花了两轮）。
- 顺带：`main.js` 在冒烟模式下把沙箱项目根暴露为 `AI_MINDMAP_PROJECTS_DIR`，
  好让断言放**文件类夹具**（如造一份 PDF）——`runCli` 只能写数据；真实数据依旧零触碰。

### 展开/收起不再"整页瞬移"：重排锚点保持（2026-09-29，用户反馈"展开折叠导致页面跳来跳去"）

**病象与机制（已量化）**：一次性探针在真实项目上实测（证据 `$TEMP/mm-jump-probe.jsonl`）：
全展开状态下收起 `md-m1-week2` 时，主题根屏幕 y 从 1620 跳到 −5137（**Δ = −6757px**），
而视图变换 `fdView` 与滚动全程一字未变（`scroll=[0,0]`）⇒ **布局坐标系动了、视图坐标系没动**。

机制在 `vendor/jsmind.js` 里读清：布局是"**每个父节点把自己的子节点栈居中**"
（`layout_offset(){ … r.offset_y = a - s/2 …; for(…) o._data.layout.offset_y += l; }`），
再叠加原点 `get_view_offset()`（依赖内容包围盒）。
⇒ 展开/收起后**每一层都要重新居中**，位移**不是等量平移**（探针实测：主题A −565px、主题B −1406px）。
这一点推翻了两个中间判断：❌"整棵树等量平移"（我最初的推断）、❌"钉住布局原点就够了"（试过，无效）。

**做法（`renderer/app-view.js` 的 `wrapLayoutAnchor`）**：包住 `view.relayout()`
—— jsMind 重排的**唯一入口** —— 在调用前后量同一个节点的**布局坐标**（`style.left/top`，
天然不含变换），把差值按当前缩放换算成屏幕位移补进 `fdView`。锚点＝**这次操作的那个节点**
（`expand_node/collapse_node` 的入参），退化到"第一个可见顶层主题"。
⇒ 语义就是用户要的：**你点开/收起谁，谁就在屏幕上原地不动**，其余节点照常重排。

**为什么这次能避开前两版的坑**：前两版都在节点层 MutationObserver 里做事后对冲，
**分不清**"布局重排"与"用户在平移/缩放"，于是把用户的平移当成布局位移纠正掉
（实测位移 = −150,−75 = −平移×缩放 ✗）；本版只在**重排函数被调用那一刻**测量，
用户平移/缩放根本不经过那里 ⇒ 不可能被误判。
另一个坑：测量必须用 `style.left/top`（`offsetLeft/offsetTop` 含祖先变换，会把平移算进来 ✗）。

**怎么验的（断言 `scripts/smoke/19-view-offset-pin.js`，三条）**：
1. **可控复现 + 判别力证明**（自带探针树：主题模式 + 链三层 + 30 叶子）：解钉时收起
   **布局位移 −564.5px、屏幕位移 −565px**（复现成立）／钉住后被操作节点收起、展开位移都是 **[0,0]**；
   补偿日志 `[0,−564.5,1,…]` 显示补偿量恰等于那次布局位移（证明它在干活，不是空转）。
2. **不越权**：用户平移 (+100,+50) + 缩放 1.5 后再展开 ⇒ 视图增量与被操作节点位移都是 [0,0]；
3. **不干扰重建**：连续两次打开项目，见证位置与 fdView 完全一致。
探针树为什么不用真实项目：6757px 的位移会让 headless 光栅层直接 `VirtualAlloc failed`（实测断言 THREW），
探针树 −565px 够判又安全。

**顺带修掉一条自相矛盾的守卫**：冒烟内部兜底是 90s（`main.js`），而验证体系给 G5 的预算却是 **120s**
⇒ "预算内本该通过"的运行会被内部守卫先掐掉，表现为**同一份代码有时绿有时红**（实测多次）。
它把我引向过错误方向（一度判定"新写的代码把渲染层拖死了"，回退后仍复现才发现根因）。守卫改为 **150s**。

**已知未覆盖**：截图在本工程里对"树形变化"不可靠（隐藏窗口给旧帧，实测截出来的是上一个项目；
`invalidate()` 强制重绘会把 GPU 上下文搞崩）⇒ 本项以**数值**为判据，截图仅作参考。

### 弹窗让位给 DSH 侧边栏 + PDF 缩放控制（2026-09-29，用户反馈"PDF 预览和侧栏打架"）

**根因不是层级顺序，而是坐标系**：DSH 侧栏是主进程的 `WebContentsView`（**原生控件**，
`setBounds` 停靠在窗口右侧，默认 420px、可拖 280–720），**永远画在网页之上** ——
页面里 `z-index` 再大也盖不住它。而让位只做了两处（`#main` 的 `margin-right`、
`#toolbar` 的 `padding-right`），**8 个弹窗全是 `.overlay { inset: 0 }`** ⇒ 它们按整窗算尺寸与居中，
右缘必然伸到侧栏底下。放大预览框（上一轮）把这个矛盾放大了：`#zoom=page-width` 按
**iframe 宽度**算页宽，而 iframe 有一截藏在侧栏下 ⇒ 页面按"看不见的宽度"排版、右半边被裁。

**做法（A：让位下移到弹窗层，纯 CSS）**

- `.overlay` 与 `#lightbox` 的定位由 `inset: 0` 改为 `top/left/bottom: 0; right: var(--dsh-sidebar-width, 0px)`
  ⇒ 遮罩与其中的弹窗都在**可用区域**内居中。`--dsh-sidebar-width` 早已存在（`dsh-sidebar:layout`
  事件里写入权威值，折叠时 CSS 兜底 `0px`），所以**零 JS 改动**、侧栏折叠时行为与改前完全一致。
- 8 个弹窗一次修好：编辑 / 图片 / 附件 / 关联 / 关系审计 / 命令面板 / 灯箱 / 文件预览。
- 宽度上限统一改成 `min(原值, calc(100vw - 侧栏 - 32px))`（编辑框 480、审计 720、命令面板 560、灯箱图 92vw）。
- ⚠️ `#file-preview` **自己就是 overlay**，固定定位下同时给 `left/right/width` 时 `right` 被忽略、盒子贴左
  （实测 left=0、右侧空 32px）⇒ 用 `margin: 0 auto` 才是在 `[0, 可用区域]` 内居中的手段。

**做法（C：PDF 自身两处）**

- `#zoom=` **只在设置 `src` 那一刻生效** ⇒ 新增「页宽 / 整页 / 100%」分段控件（默认页宽），
  切换即重设 `src`；并监听 `resize`（260ms 去抖、宽度变化 >24px 才重设，避免抖动与丢滚动位置）。
- 预览头新增「📁 文件夹」：节点带 `localPath` 时出现，点击复用 `openLocalPath` ——
  把"附件预览"与"文件夹链接"两件事接起来（没有 `localPath` 的节点不显示该按钮）。

**验收**：`scripts/smoke/18-overlay-sidebar.js` 四条断言（让位后右缘 ≤ 可用宽且左右留白相等 /
8 个 overlay 的 `right` 随侧栏开关在 420px↔0px 之间切换、编辑框宽度被压到可用宽 /
缩放控件默认页宽且切换会改 `src` / 文件夹按钮点击真的走了 `openLocalPath`）。
复跑时我自己的**三条判据先判红**（把 `#file-preview` 当成"子元素"、读计算样式前先摘了 class、
拿 `display` 的 `inline-flex` 字符串做判据 —— flex item 会被块化）—— 实现是对的，判据是错的，
已一并修正并写进注释。

### G8 门禁补三处"不严"：四行元信息 / 层取值表（判定⑭）/ 递归 + 采不到真值＝红（2026-09-29）

**来源**：一次外部复核报来"起步模板有 6 处不严"。逐条用**注入**核过后：**三条属实**（另两条同源加固）。
更关键的是 —— **本工程的真实现同样不严**（`collectDocHeaders` 只扫一层、`parseDocHeader` 只强制两行、
`LAYER_ORDER` 只用于排序、`catch → return` 静默跳过）：文档里一直声称的规则，**从未被任何实现落实**。声称 ≠ 实现。

**`scripts/docs-registry-check.js` 改了什么**：

- **元信息块要求「四行齐备」**：原先只强制 `层`/`作用`，缺 `不该写`/`更新方式` 也能过；渲染登记表时还用
  `|| '—'` / `|| '手写'` **静默补默认值**，把"缺两行"掩盖成"看起来合规"。现在缺行 = `partial`（与"没有块"**分开报**，
  报文点名缺哪几行），且**生成模式同样拒绝**（两路径一致 —— 否则"检查拒绝、生成放过"会让人以为改对了）。
- **新增判定⑭「层取值表」**：`LAYER_ORDER` 此前**只用于排序**（非法层落到末尾就没人管），等价于没判；
  而 `RULES`/`ARCHITECTURE`/`SKILL.md` B3 一直声称"值必须在取值表内"。
- **归档横幅检查与元信息收集改成递归**：原先只扫一层 ⇒ `docs/<子目录>/*.md` **既不会被告知要补元信息、
  也没法合法进表**（手工加进 §5 反被"表过期"判红）—— 报错指了一条**走不通的路**。归档重复版本段检查同步递归。
- **读失败不再静默 `catch → return`**（**采不到真值＝红**）；"文件不存在"不再被误报成"缺元信息块"（根因要说准）。
- **`--list` 不再假绿**：有任一问题时置失败退出码 —— 否则有人把它挂进 CI，看一屏 ✓ 就以为合规。

**顺带**：`docs/RULES.md` 的 G8 行由"13 条判定"改为"**14 条**"。这次不一致**是 G9 当场抓到的**
（"声明 13、实际 14"）—— 上一轮做的"声明条数与实现标记机械对齐"两道防线按预期生效，不是靠人记得改。

**验收**：4 次注入全部判红（docs 子目录无元信息 / 元信息缺行 / 层非法值 / 归档子目录无横幅）→
撤销后**逐字节还原**且复绿；`tests/docs-registry.test.js` 新增 6 条用例锁住判别力（含"生成模式必须拒绝"与"缺失≠缺元信息"）。

### 体验四项修复 + 新命令 `expand-depth`（2026-09-29，用户反馈）

**① 节点标题的行内 Markdown 现在会渲染**（用户："很多节点带 `**文字**`，要么去掉要么实现，建议实现"）

- 来源：源笔记的标题本身写成 `## **sysfs文件系统**`，导入后 topic 里就是字面 `**`。实测 13 个节点。
- 做法：**渲染期**转换（`renderer/app-core.js` 的 `applyTopicMarkup`）——`**加粗**` → `<strong>`、
  反引号 → `<code>`。**绝不写回数据**：`serializeTree` 读的是 jsMind 节点的 topic（原文），
  若把 HTML 塞进 jsMind 数据，界面一保存就会把 `<strong>` 写进 topic（静默污染）。
- 顺带修好一类老问题：topic 里含 `<`/`&` 的字面文本（`support_html` 模式下本来会被当标签解析）现在先转义再还原两种语法。
- ⚠️ 代码块里的 `**必须**` **仍然保持字面**（围栏内容原样是上一条修复的约定，那是代码不是 Markdown）。

**② 展开状态以数据为准，深层默认收起**（用户："子节点应该是折叠状态而不是打开"）

- 根因有两半：渲染层无条件 `jm.expand_to_depth(3)`（**覆盖了数据里的折叠状态** ⇒ 在界面收起过的节点，下次打开又被展开），
  且导入/建树一律写 `expanded: true`。
- 修法：渲染层不再兜底展开（数据说啥就是啥）；导入器默认**只让前两层展开**；
  跳转类动作（搜索/关联/媒体）改为**只展开目标节点的祖先链**（原来 `expand_to_depth(20)` 会把整棵树摊开、折叠状态全丢）。
- 存量数据用新命令规范化：**`expand-depth <项目> [--depth N] [--id 子树]`**（默认前两层展开，`--depth 0` 全收起、
  给大值即全展开）——**一次原子写**完成；逐个 `edit --expanded false` 要写几百次盘（写放大）。实测 comnet：展开 113 → 24。

**③ 展开/收起按钮加大**（用户："太小了不好按"）

- jsMind 默认 `11×11px`、字号 10px。现为 **19×19px 圆钮**（白底蓝边、hover 反色放大、`+`/`−` 字号 14px）。
- 只覆盖尺寸与外观：位置由 jsMind 内联 `left/top` 决定，配 `margin:-4px` 把它拉回原来的视觉中心。

**④ 文件预览铺满 + PDF 默认页宽**（用户："可用区域很窄、默认画面太小"）

- 两个独立原因都修了：
  - 预览弹窗**没有自己的尺寸**，落回 `.dialog-box` 的 480px ⇒ 现在 `92vw × 90vh`（上限 1560px）；
  - **`.overlay { align-items:center }` 同时作用于弹窗自己的子元素** ⇒ `#fp-body` 被收缩成内容宽（实测 300px，
    即 iframe 的默认宽度）⇒ 显式 `align-items: stretch` 才真正铺满（实测 1310px）。
- PDF 内嵌链接补 `#zoom=page-width`（不加时 Chromium viewer 按 100% 显示，大画布上也只是一小页）。

**顺带修两处"检查自己过期"**

- `scripts/docs-registry-check.js` 的数据目录白名单只放行 `/\.json$/`，把 §5 早已声明的 `.changes.jsonl` 误报成
  "契约未声明的项" ⇒ 改为 `.jsonl?` 并把文案里的声明清单写全。
- 新增 4 条冒烟断言（`scripts/smoke/17-ui-polish.js`），其中"行内加粗"与"展开状态"都用**自建探针项目**判定 ——
  实测直接量真实项目会被前序断言改过的沙箱状态污染（假红）。

### 修两个真 bug：围栏代码块被当结构解析 / rename 在并发下瞬时失败（2026-09-29）

这两个都是**在真实任务里撞出来的**（把 `E:\markdown` 的笔记与案例程序导进项目），不是推演出来的。

**① `src/markdown.js`：围栏代码块必须整段原样，不能当结构解析**（静默损坏类）

- 病象：跨空行的围栏被 `flushSeg()` 按空行切成多段、各段独立转 HTML ⇒ 只有第一段在
  `<pre><code>` 里，其余变成 `<p>`/`<li>` 碎片（缩进被 trim 吃掉、` * 注释` 变列表项）；
  围栏内 `# 终端 A：…` 这类 shell 注释**被当成标题新建了节点**。
- 量化（导入前）：day4 笔记 47 个代码块里只有 8 个完整；day3 两篇有 50 个**空**代码块、
  8 个伪标题节点、29 处块内 markdown 被解释；案例程序则出现 "Makefile 源 7 行 → detail 只剩 1 行"。
- 修法：显式 `inFence` 状态 —— 围栏内**空行不触发 flush、标题/列表/资源语法一律不解读、行原样收集**
  （含收尾标记，好让 `markdownToHtml` 渲染成 `<pre><code>`）。
- 验收：`tests/markdown.test.js` 新增 3 条（空行 / `# ` 注释行 / 未闭合围栏）；
  全量重导后 **247 个代码块逐字命中 0 缺失**、空代码块 0、伪标题 0。
- 附带发现（已写进 `docs/DATA-FORMAT.md`）：`import-md` 的图片引用不会搬进 `assets/`，
  博客导出的 md 还夹带 1×1 透明 GIF 占位图（实测一篇 128 处）—— 两者都要 `remove-image` 清掉。

**② `src/data-store.js`：原子写盘的 rename 加**有界重试****

- 病象：并发写同一个项目时实测 `EPERM: operation not permitted, rename '…comnet.json.<pid>.<ts>.tmp' -> '…comnet.json'`
  （Windows 上目标文件被另一进程短暂打开）—— 调用方只能原样重跑。
- 修法：只对**瞬时占用类**错误（`EPERM`/`EBUSY`/`EACCES`）重试（6 次、约 100ms 上限），
  其它错误立刻抛；重试用尽抛**原错误**并附「已重试 N 次」。多会话并发写是本工程的常态，这类抖动该由写盘层吸收。

### 节点「本机文件夹」链接（localPath）+ 按文件夹结构建树（2026-09-29）

**问题**：用本地 Markdown/源码目录当知识库时，导图与真目录之间没有连接 ——
看到一个节点想"去翻原始文件"，只能自己去资源管理器里找。

**做法**：新增可选节点字段 **`localPath`**（本机文件夹绝对路径），界面两处入口点击即用系统文件管理器打开：

- **数据**：`docs/DATA-FORMAT.md` §2.1 登记字段。它是本格式里**唯一的绝对路径** ——
  资源引用（`images[].file` / `files[].file`）仍然只准相对路径；`localPath` 是**目录快捷方式**，
  天生机器本地、没有可移植含义。**只校验形状（非空/无换行/≤500），不校验存在性** ——
  存在性依赖运行环境（盘没挂、目录还没建都正常），做成校验条件会让"换台机器打开就连 validate 都红"。
- **可选字段 ⇒ 不升 `formatVersion`**（按 §4 的"只增不改"规则），旧文件无需迁移。
- **CLI**：`add` / `edit` 新增 `--local-path <绝对路径>` 与 `--clear-local-path`。
  放行**绝对路径**并要求它（相对路径会随工作目录漂移，而点击打开的是操作系统，它没有"项目根"概念）；
  路径当前不存在时**警告但照记**（盘没挂载是正常情况）——不静默、也不武断拒绝。
- **界面**：详情框里一条可点链接「📁 <路径>」+ 右键菜单「📁 打开文件夹：<末级目录名>」。
  打开动作**复用既有的 `app:open-file`**（它本来就是 `shell.openPath`，对目录同样适用）——
  不为同一件事造第二条 IPC。失败（路径不存在/盘没挂）会明确报到状态栏，**绝不"点了没反应"**。
- **读视图**：`get --json` 与 `read --json`（含 `--brief`）都带上 `localPath`，`--skeleton` 才省 ——
  不然字段存下来了、AI 却看不见，功能只做了一半。
- **⚠️ headless 守卫**：`app:open-file` 在 `--smoke` 下**不真的打开**（否则每跑一次 verify 都会在
  跑验证的机器上弹出文件管理器），只做**路径可访问性校验**并回报 `headless:true` ——
  不是静默降级：调用方看到这个标志就知道"校验过了、只是没开"。

**基于它的一次真实使用**：把 `E:\markdown` 的目录结构建成了项目里的一棵新树
（根「课程笔记」→ M1/M2/M3 → 周 → 天/任务 → 专题，共 76 个结构节点，每个都带 `localPath`），
两棵上游 OpenWrt 包源码树（`Task1-day2utils` 56 目录 / `Task2-day3kernel` 109 目录）**不展开**，
只在节点 detail 里说明规模并给文件夹链接 —— 展开它们会把笔记结构淹没在包名里。

**验收**：`scripts/smoke/16-local-path.js` 三条断言（CLI 设了界面看得见 / **界面保存不丢字段** /
点开的两种结局 + 点击确实调用了打开通道）；`tests/schema.test.js` 与 `tests/query.test.js` 各新增 4 条。
其中「保存不丢字段」这条针对的是一个真实失效模式：`serializeTree()` 是**手挑字段**的，
漏一个字段就会被整树写回静默丢掉（与曾经"保存不丢 assoc"同型）。

### 多路同时编辑 · 阶段 4：接线收口 + 两条"故意不接"写成决定（2026-09-29）

**至此四个阶段全部落地**（阶段 1 CLI 自动重放 / 阶段 2 GUI 三方合并 + 冲突二选一 / 阶段 3 `changes`
事前避让 / 阶段 4 接线收口）。

**接上 `ctx.mutate` 的 4 个写点**（原先都是"读→改→写，冲突就整条白做"）：

- **`import-md`**（最值得接的一条：窗口最宽 —— 读 md + 转节点树 + 追加；形状与 `add` 完全一样）。
  转换**只做一次**并捕获进闭包（`fn` 里禁止 I/O，且重放不该重新生成一遍节点 id）。
- **`theme-layout`**（只动 `meta`；布局对象在 `fn` 外算好，顶层主题校验仍用预读数据 ⇒ 报错顺序不变）。
- **`assoc-prune` / `links-prune`**（修复类）：判据 `should` 在 `fn` **外**固定 —— 它依赖**别的项目**的读盘
  （成员/目标是否还在），而 `fn` 里禁止 I/O。重放只按"**我核实过的那份名单**"剪，**不猜新的**
  （"不确定就不删"的规矩不变）。重放时若已被别人清掉，命令**如实报告**"并发期间…已被其他写入者清掉，
  本次无需改动"，而不是报一个版本冲突让调用方以为失败。

**两条"故意不接"（写成决定，不再当欠账）**：

- **`init`** 接不上：`mutate` 第一步就要 `read()`，而它的前提是项目**不存在**。
- **`import-json`** 不接："用这个文件覆盖成新项目"是**显式整体替换**，合并没有语义；它也不声明 `expectVersion`。

边界与理由写进 `docs/ARCHITECTURE.md` §4b ADR 的「接线范围」+ `docs/ROADMAP.md`（该条从「在飞」移入「已收口」）。
接线后 `cli/commands/*` 里只剩 `init` 一处裸 `ctx.write`（实测计数：19 处 `ctx.mutate`）。

**实测发现的两条硬事实（都进了 ADR 与断言）**：

1. **坏状态会把所有写命令一起挡住**：项目一旦有悬挂关联成员/链接，`validate` 判红 ⇒ **任何写入都过不了
   校验闸门**（连测试里模拟的"外部写入者"也过不了）。所以修复类命令的真实并发场景**只有"另一个修复者"**；
   给这类断言造外部写入时**必须写合法数据**，否则先被校验拦掉、根本走不到版本冲突
   （我第一版断言就栽在这里，报的是 `校验失败: 悬挂关联成员` —— 不是并发逻辑的问题）。
2. 由此也确认：**只有 `init` 一处裸写**是合理的，其余"读写既有项目"的写点全部经过并发裁决。

**顺带补掉阶段 3 的一个洞**：`import-json` 走的是 `ctx.store.write`（绕过 `ctx.write`），因此**没带 writer**
⇒ 变更日志里那条显示成 `writer: unknown`。已把 `writer` 暴露为 `ctx.writer` 并传下去，实测现在记成
`cli:import-json`。

**验收**：`scripts/cli-integration.js` 新增 3 条（悬挂前置判红 / `assoc-prune` 并发走重放且**重放后仍过
validate** / `import-md` 并发不相交自动合并且对方改动保住）；全链 9 门禁绿。

### 多路同时编辑 · 阶段 3：变更可见性（`changes`）—— 从事后合并到**事前避让**（2026-09-29）

**问题**：阶段 1/2 解决的是"撞上之后怎么办"。但更省事的是**别撞上** —— 而会话动手前没有任何办法
知道"我要改的这个东西，最近被谁碰过"。于是它只能靠"白做一轮"来发现自己撞了。

**做法**：唯一写盘出口**顺带记账** —— `projects/<项目>/.changes.jsonl`（与 `.ui-state.json` 同一惯例的
点文件 sidecar：一行一条、追加式、**有界**＝只留最近 `MAX_ENTRIES` 条）。

- `changed[]` **不是谁手写的**：用**与冲突判定同一套指纹**（`src/concurrency.js` 的 `changedKeys`）
  在写盘时当场算出来 ⇒"哪里算冲突"与"哪里报变更"永远同一份定义（A3）。
- `rev` 从日志自身推导（不依赖项目文件里的任何字段）⇒ **不改数据格式**：`src/schema.js` 与
  `docs/DATA-FORMAT.md` 的契约部分一行没动，只在那份目录树里登记了这个 sidecar。
- 新命令 **`changes <项目> [--since <rev|版本号>] [--json] [--limit n]`**（只读）+ MCP 工具 `changes`。
- **写入者身份**：`MM_WRITER` 区分 `cli:<命令>` / `mcp:<命令>` / `gui`（界面保存）/ `gui-cli:<命令>`
  （界面经 CLI 代写，如 assoc-edit）。它**只进日志，不参与任何判定**（不是权限、不是闸门）。

**两条硬口径（都配了断言）**：

1. **"答不了"绝不等于"没有变更"**：`--since` 给不出答案时（锚点滑出窗口 / 本机没有日志）
   **报错 + 非 0 退出**，文案里明写"这不等于没有变更"。不带 `--since` 只是"看现状"，缺日志就明说。
   理由：调用方是 AI，它会把静默的空结果当成"没人动过，放心写"。
2. **日志是辅助产物，记账失败不能让数据写入失败**：记账抛错只打 stderr（响亮但不致命）；
   日志被删后 `changes` 明说"本机没有日志"。它不进 `export-json`（已加 `.gitignore`）。

**实测踩过的两个坑（都已锁住）**：

1. **`changedKeys` 返回 `Set`**，第一版按数组塞进 JSON ⇒ 每条日志的 `changed` 都是**空数组**，
   `changes` 于是**安静地告诉会话"没有对象变化"** —— 这正是可见性功能**最坏的失效形态**（比报错危险得多：
   它让人放心写下去）。发现方式是**功能验证**（真跑一次 `add` 再看输出），**不是单测** ——
   当时的单测只覆盖了我写的解析逻辑，没覆盖"真 store 写一次之后，日志里到底有什么"。
   现在两处都有断言（`tests/changes.test.js` 有一条专门读真 store 的日志）。
2. 帮助文案里我曾写"锚点取 `read --json` 的 `version`"—— 实测 **`read --json` 不含 version**
   （只有 meta/nodeCount/nodes/images）⇒ 锚点只能来自 `changes --json`。已改正（命令说明、MCP 工具说明、
   `SKILL.md` 的命令速查一起改）。

**成本（按 H3 量过再装）**：每次写入多读一次旧文件 + 算一次逐对象指纹 —— 实测最大项目
（152 KB / 187 节点）`changedKeys` ≈ 7 ms；而同一次写命令的端到端耗时是 **685–1056 ms**（含 node 启动），
即 **≈1%**。日志本身有界，不会让项目目录无界增长。

### 多路同时编辑 · 阶段 2：界面保存也改成"能合就合"，不再要求重开项目（2026-09-29）

**问题**（阶段 1 之后剩下的那一半）：CLI / 侧栏 AI 之间已经能自动合并，但**人开着界面**时仍是旧的
"一律拒绝"，冲突提示让人"重新打开项目（丢弃界面里未保存的改动）或 Ctrl+Z"。**人机之间是净损失**：
AI 只是改了个别的地方，人的全部未保存编辑却要一起丢掉。

**做法**：`main.js` 的 `project:save` 改走**三方合并**（`src/concurrency.js` 的 `mergeTrees`）——
`base` = 界面读到的那份（新增 `baseAtRead` 记它，与 `versionAtRead` 同生共死）、`mine` = 界面内存载荷、
`theirs` = 盘上最新：

- 两边改的对象**不相交** ⇒ **自动合并**，保存成功，**双方改动都保留**；
- **相交** ⇒ **不写盘**，把**冲突对象名**回报渲染层；渲染层让用户二选一 ——
  「用磁盘上的版本」（**只丢冲突对象上的改动，你的其他改动照常落盘**）或「保留我的、本次不保存」；
- 合并结果在 validate 期间又被插队 ⇒ 仍**不盲写**，回报 `RACE_RETRY` 让用户再点一次保存。

新增 `MMApp.resolveConflict('theirs' | 'mine')`：界面按钮与冒烟断言**共用同一份语义**（不是测试专用接口）。

**两条踩过的坑（都写进了代码注释与断言）**：

1. **模态框会把 headless 卡死**：第一版在渲染层用 `window.confirm` 问用户，冒烟里没人回答 ⇒
   `SMOKE GUARD TIMEOUT — force exit`。修法：主进程在冲突响应里回 `headless` 标志；headless 下只报状态、
   **不弹框**，程序化选择走 `resolveConflict`。
2. **`serializeTree()` 不产 `assoc`** ⇒ 三方合并里"载荷缺这个键"必须当作**界面没有意见**（从 base 继承），
   而不是"界面把 assoc 删光了"—— 后者会让"界面保存"变成**删掉全部关联笔记**（本工程最重的损害类别）。
   `mergeTrees` 内置了这一步，并有单测锁住。

**验收**：`tests/concurrency.test.js` 新增 `mergeTrees` 一组（不相交合并 / 同对象拒绝且**指名** /
`onConflict:'theirs'` 只丢冲突对象 / 载荷缺 assoc 不误删 / 我删的节点不被"以对方为底"复活 / assoc 逐条目）；
`scripts/smoke/15-write-conflict.js` 的判据**从"必须被拒"升级为"两边改动都在"**（更严的判据），
并新增"同对象冲突 → 盘上逐字节不动 → 再用磁盘版本能存且其余改动保住"。

### 多路同时编辑：并发冲突从"一律拒绝"改成"可自动合并 / 相交才拦"（2026-09-29）

**问题**（真实场景）：本工程的常态是**多个 AI 会话同时改同一个笔记项目**（内嵌侧栏 + 外部会话 + MCP）。
原先的写盘闸门只会**拒绝**并发写，而且判据是**整文件一个内容指纹** —— 于是"两个会话各改一个节点"也会被拒，
被拒的那次改动白做（对 AI 是白跑一轮）。多路同时编辑的结局要么"白做"，要么被人改成"最后写者赢"。

**做法**：在"拒绝"之外补一条**有安全论证的出路**。

- 新增 `src/concurrency.js`（纯逻辑，无 I/O）：`fingerprint(data)` 逐 `node:<id>` / `children:<父id>` /
  `assoc:<id>` / `meta` 给指纹；**`withReplay(io, fn)`** 在版本冲突时**先证明两路改动的对象集合不相交**，
  不相交才把改动**重放到最新版**（双方改动都保留）；相交则**指名叫出冲突对象**并中止写入。
- `cli/core.js` 新增 **`ctx.mutate(fn)`**（读→改→写的并发安全入口）；笔记编辑命令的写路径
  （`commands/edit.js` / `assoc.js` / `links.js` / `assets.js`）已接到它上面。
- `src/data-store.js`：冲突错误打上 **`code='VERSION_CONFLICT'`**（重放器**只认码、不认文案** ——
  文案会漂，靠正则匹配报错文本会静默失效）；`write` 成功时回传 `{file, version}`，
  供同一条命令里连续写不误报冲突。

**安全论证**（本改动最容易被"优化"坏的地方）：**只写被证明过的那一份数据**；
判据用**重放后实测的差集**，不用重放前的预测（`fn` 可能依赖数据内容 —— 例如"父节点不存在就报错" ——
两次调用的改动集合未必相同）。

**纪律（写命令的新约束）**：改动函数 `fn` 里**不得做 I/O / 打印 / 物理写盘** —— 并发重放会再调用它一次
（打印会重复、物理写盘会留下孤儿文件：实测教训是**附件复制必须留在 `fn` 之外**）。
要把结果带出去，记进闭包变量即可。

**验收**：`tests/concurrency.test.js`（含与**真 store** 对齐的一组，防止"只在假对象上通过"）；
`scripts/cli-integration.js` 新增并发断言段（不相交自动合并 / 相交指名拒绝 / 跨对象类别不相交），走真实
`createContext` + 真实命令 + 真实 store，只在**「我读之后、我写之前」**这个唯一窗口注入一次"别人的写"。

**边界（诚实标注，见 `docs/ROADMAP.md`「在飞」）**：`assoc-prune` / `links-prune` 与项目级命令
（`init` / `import-json`）仍走原闸门（**只拒不合** —— 安全，但不自动合并）；阶段 2（GUI 逐节点合并）/
阶段 3（变更可见性 `changes --since`）/ 阶段 4（收掉上述边界）未做。
**明确不做**：文件锁（AI 场景会死锁/误杀）、CRDT（对"节点+字段"粒度是过度设计且会破坏确定性产物）、
同一字段自动合并（那是"最后写者赢"，即本工程最重的损害类别）。

### 顺带修掉：`doc-facts` 把"用例数真值"记成 `passed` 而不是总数（同批发现）（2026-09-29）

**根因**：`parseVitestCount` 取的是 vitest 摘要行里的 `passed`。**有失败用例时**摘要是
`Tests  2 failed | 590 passed (592)` ⇒ 它记下 **590**（真实总数 592），并把**偏小的错值**写进
`docs/VERIFY.md` 当"真值"。**为什么没有门禁抓得到**：G6 是"文档 vs 本脚本现算"**自比自** ⇒ 这个错
永远不会有门禁报红。（发现过程：本次 `npm run facts:write` 正赶上另一处门禁红着、恰有测试失败。）

**修法**：**优先取括号里的总数**，没有括号才退回 `passed`；把 `parseVitestCount` 提到模块顶层并导出，
在 `tests/doc-facts.test.js` 加断言锁住"**有失败用例时也必须给出总数**"（含 ANSI 色码形态、
以及"无摘要行 ⇒ null"——"取不到真值"必须与"取到了"可区分）。

### G9 判定六：门禁的"判定条数"不再允许四处各写一种说法（2026-09-29）

**触发**：用户指出一处**活体漂移** —— 同一个门禁的判定条数在四处有四种说法（规则文件写"12 条"且只列 11 项 /
架构文档写"13 条"、另有更旧的"四条" / 实现脚本**头注释**写"三条" / 代码实际 13 条），
而 G9 的"转述条数"判定要求「共 N 条」字样，**抓不到「（N 条判定）」这种写法**。
核实结果：**全部属实**，并且我另外扫出两处用户没提到的（脚本里还有一处 `三条判定` 分节标题、
`docs/ROADMAP.md` 写"含 G8 的 12 条判定"）。

**根因（是我自己的）**：第五批加第 13 条判定时只更新了 `docs/ARCHITECTURE.md` 一处；
而脚本头注释是最初三条判定时写的，此后没人再看它。

**修法（不只改数字，而是把这一类机械化）** —— `scripts/rules-consistency.js` 新增 **判定六**：

1. **声明的条数必须等于实现脚本里现场数出的标记数**：门禁行写「（N 条判定）」时，N 必须 ==
   实现脚本里 ①–⑳ 标记的**去重个数**（`collectJudgmentMarkers`）。
2. **标记必须唯一**：实测脚本里曾有两个 `①`，导致"数一遍"得到 **14** —— 重复标记单独报错。
3. **实现脚本的注释里不得写死条数**（脚本头注释正是第四处说法的来源）→ 报错并提示"改为指向 ①…⑳ 标记"。
4. **其他文档里不得复述这个条数**（应改为指针）→ 实测抓出 `ARCHITECTURE.md` ×2 与 `ROADMAP.md` ×1。
   注意：**只抓"总数声明"，不抓"第 N 条判定"这类序数标签** —— 第一版没排除，误报了一屏
   （且写成 `(?<!第)` 不够：中文里"第 7 条"中间有空格），现改为**先剥离序数用法再判**。

**内容侧同步修正**：`docs/RULES.md` §2 的 G8 行改为 **13 条**并补齐第 13 项（登记表与元信息一致）、
G9 行补上新增判定；`docs/ARCHITECTURE.md`（脚本表行 + §5 准入第 4 条）与 `docs/ROADMAP.md`
**一律改为指针**（"判定清单见 `RULES.md` §2"），不再复述条数；`scripts/docs-registry-check.js`
的头注释与分节标题改为"清单以 ①…⑬ 标记为准"，并把重复的 `①` 改成 `（续 ①）`。

**R3 分层测试**：`tests/rules-consistency.test.js` **+6 例**（条数不符 / 一致不报 / 标记重复 /
测试文件不算实现（第一版的真实误报）/ 未声明条数的行不判 / 真实工程回归）。
**判别力**：注入「声明 12 条」「声明 14 条」「`②` 用两次」「删掉 `⑬` 标记」四种违规，**全部判红**；撤销后复绿。

#### 追加：第二轮复核的三处残余 + 一个"后门"（2026-09-29 同日）

第二轮复核指出判定六**给自己留了后门**，并报出三处残余。**全部核实属实**，已修：

| 残余 | 事实 | 修法 |
|------|------|------|
| **后门** | `G9` 那行写作「N 条判定」（**没有数字**）⇒ `DECLARED_COUNT_RE` 不匹配 ⇒ 判定六**整段跳过 rules-consistency.js**，于是它的实现文件里同时存在"标记重复"与"注释写死条数" | 判定六拆两层：**标记唯一 + 文案不写死条数** 对 §2 点名的**所有**实现脚本生效（不限是否声明数字）；**数字比对**才要求行内有数字。并给 G9 行补上「6 条判定」，让它**检查自己** |
| **G5a 标记重复** | `// ⑥` 与 `// ⑥b` 被算成两个 ⑥（与"两个 ①"同一形状） | 改为「（承 ⑥）」这类续写写法（不计入），并把这条经验写进报错文案 |
| **G5b 注释写死条数** | 本门禁自己的头注释写"四条判定"，实际 6 条 | 头注释改为"清单见 `analyze()` 的标记"，**不再写死条数**（与它对别人的要求一致） |
| **G5c 列举少一项** | `RULES.md` 的 G8 行声明 13 条、逐条列举只有 12 项（缺「悬挂登记」） | **不再逐条列举**：改为**五类分类 + 现场取清单**（新增 `npm run check:docs -- --judgments`，从实现的 ①…⑬ 标记打印全套）；`RULES.md` §4 增约定："声明条数由门禁强制；若逐条列举则必须与标记一一对应，做不到就别列" |

**过程中又踩到两次同类**（都写进代码注释与单测）：
1. 我改写 RULES 时把条数写成加粗的 `（**6 条判定**）` —— 旧正则要求 `（` 后紧跟数字 ⇒ **静默失配**，
   整个计数比对被悄悄停用（门禁照样全绿）。现正则容忍 markdown 强调，并**单测锁死加粗声明的识别**。
2. 判定六第一版把「**第 7 条判定**」这类**序数标签**与「**加一条判定**」这类汉语动宾搭配都当成总数声明 ⇒ 误报一屏；
   现改为"先剥离序数用法 + 汉语数词只认 ≥ 二"。

**判别力（本轮新增 3 项注入）**：给 G9 实现加第 7 个标记 → 报「声明 6 条判定…实际 7」✅；
在 `encoding-check.js` 注释里写死条数 → 报「写死了判定条数」✅；把 `②` 改成「（承 ①）」→ 报「实际有 12 条」✅。


### 第六批：冗余审计与**修剪**（T1–T5）—— 门禁清单三份 → 两份，登记表从手写改为生成（2026-09-29）

**出发点**：用户问"这套体系是否冗余"。这是一次**反向**审计：前五批都在加，这次先量化"同一事实写了几处"、
"一次错误触发几条消息"、"一次改动的同步成本"，再决定删什么。
结论：**机制不冗余**（一次错误只触发 1–2 条消息、报错即教程、12 条判定里 9 条在真实内容上抓到过东西、
文档类门禁合计只占全链约 5%）；**冗余集中在"记录与清单"层**（3 处真冗余 + 1 个缺上限）。本批全部处理。

#### T1 · README 的门禁表 → 指针（门禁清单 3 份 → 2 份）

README §九 曾把 G1–G9 连**实现命令**整表复述一遍，与 `RULES.md` §2（权威）、`docs/VERIFY.md`（生成）
三份并存 —— 而 README 那份是纯手工复制，必然漂移。现改为**指针 + 一句"要跑就 `npm run verify`"**，
并写明这次收敛的理由。**净删 10 行复制**。

#### T2 · ROADMAP 改为「功能状态视图」（不再按版本记流水）

- **头部口径**：本文只回答"这个能力现在什么状态"；**版本流水的唯一权威是 `CHANGELOG.md`**（+ 归档）。
- **`已发版` 段重写**：从"vX.Y 改了什么"的流水改为**能力清单**（引入版本放括号里便于追溯），
  原先散在里面的叙述性细节（`mentions` 的实测命中、拆分时的行数快照等）删掉 —— 那些属于 CHANGELOG。
- 一并删掉 `待办` 段里与 `已实现` 段**逐条重复**的 4 个 `[x]` 项（同一批工作在本文里写了两遍）。

#### T3 · `待办` 并入「在飞 / 未收口」，用**状态列**区分

原来"没做完的事"分散在三处（`待办` / `在飞` / `CHANGELOG [Unreleased]`），而实测 `待办` 只剩 1 条
（且那条其实是**外部阻塞**）。现合并为一张表，状态取 `未开始` / `在飞` / `外部阻塞` / `已收口`：
Git 解锁改为 **`外部阻塞`** 并注明"等待外部处理；期间唯一兜底是 `export-json` 到工程外"；
L3 的**触发条件**从小节末尾提为该表脚注（信息没丢，位置更准）。
`checkHandoverPointers` / `handoverNotice` 的状态列正则同步扩展（含加粗写法）。

#### T4 · §5.0 增第 6 条硬约定：**副本上限**

> 一条规则 / 一份清单 / 一组数字，**最多 1 处权威 + 1 处动作现场，第 3 处必须写成指针**。

M3 的"动作现场"是**允许的第 2 处**，但必须是"摘要 + 指针"而非逐条复制；同时写明三类清单的唯一权威
（门禁与铁律 → `RULES.md` §2/§3；文档清单 → §5 表；命令与计数 → `CLI.md` + `VERIFY.md`），
以及**可当场做的判断方法**：拿一条规则 grep 活跃文档，>2 处命中就该改成指针。

#### T5 · §5 登记表从**手写**改为**由文档头部元信息生成**（结构性）

- **问题**：登记表是唯一权威却一直手写，且它的解析已出过两次脆弱问题（占位符被当成登记项、表格被空行打断）；
  加一份文档要改"别处的表格"。
- **改法**：每份受管文档在**自己头部**声明元信息
  `<!-- registry 层: … 作用: … 不该写: … 更新方式: … -->`（须在文件前 25 行内）；
  `npm run docs:registry`（= `docs-registry-check.js --write`）据此**生成** §5 表（含归档族两行前缀）；
  **G8 新增第 13 条判定**逐字比对 —— **手改表格、或改了元信息不重生成，都会判红并给出差异行**。
- **生成物也不例外**：`CLI.md` / `VERIFY.md` 的元信息块由**它们的生成器**产出
  （`docs-gen` / `doc-facts --write`）—— 否则每次重生成都会抹掉它、G8 立刻报「文档无元信息」。
  这一点落地时**当场就踩到了**（迁移脚本给生成物插了块，一重生成即消失），故写进 §5 准入第 1 条。
- **自适应门**：只有当工程里**至少一份文档带元信息**时才判（旧工程 / 单测 fixture 不会被误伤）；
  真工程里"块被删光"仍会由「文档无元信息」逐份报出，不会静默放过。
- **净效果**：加一份文档的同步点 **4 → 3**（文档头 + 重生成表 + CHANGELOG），且不再需要手改别处的表格。

**判别力（本批全部注入验证）**：手改 §5 表一行 → `[登记表过期]` 并给出行号 ✅；
改元信息不重生成 → 同样判红 ✅；删掉某文档的元信息块 → `[文档无元信息]` ✅；撤销 → 绿 ✅。
**R3 分层测试**：`tests/docs-registry.test.js` **+5 例**（元信息解析含无效块 / 表格按层排序且归档族用前缀 /
过期必红 / 缺块必报 / 未采用元信息的工程不判）→ 合计 **566 用例**。
**R2/R5 连带核对**：`README.md`（门禁表→指针）、`docs/ROADMAP.md`（重写为功能状态视图 + 状态列）、
`SKILL.md`（落盘规矩第 2 条 → "写元信息块 + 跑 docs:registry"）、`docs/ARCHITECTURE.md`
（§5 准入第 1/2 条、§5.0 第 6 条、§5 表改为生成、§6 文档任务行、§2.6 脚本行）、
`scripts/docs-registry-check.js`（生成 + 校验、状态列正则）、`cli/commands/release.js` 与
`scripts/doc-facts.js`（生成器产出元信息块）、`package.json`（新增 `docs:registry`）→ 已同步；
**产品功能 / 渲染层 / 数据格式 / CLI 命令数无影响**（`docs-gen` 产物只多一个注释块）。

### 第五批：决策入档、恢复 runbook、并发检测、写作约定、体系快照、演练协议（2026-09-29）

**出发点**：四批之后重新探"还没人碰过的面"，找出 6 处缺口（全部有实测依据），本轮全部落地。
其中 **O21 正面回答了"怎么知道初衷达成"这个问题**：完整性无法穷举，只能把"发现缺口的能力"制度化。

#### O16 · 文档体系决策补成 **6 条 ADR**（`docs/ARCHITECTURE.md` §4b）

四批的决策此前只散在 §5 引用块与 CHANGELOG 流水里（**14 条 ADR 里只有 1 条是文档体系的**），
"读懂当初为什么这样设计"因此缺一环。现补：**文档体系即交接面** / **归档族与工作产物区分治** /
**发布版本 vs 迭代编号** / **契约与代码必须对应（门禁）** / **文档写作约定** / **接手演练（可重复的验收动作）**。

#### O17 · §6 补三行任务 + **零 Git 下的恢复 runbook**

- 新增任务行：**动 DSH 侧栏 / 运行包**（vendor 制包、`dsh:maint -- import/rollback`、`dsh:e2e`、`dsh:resident`
  —— 并注明**后两个不在 verify 里**）、**加 / 改断言**（分域文件 + `facts:write`）、**从导出恢复**。
- 新增 **恢复 runbook**（此前 `import-json` 只有"用法"，没有"出事了怎么用"）：
  **① 找**工程外导出 → **② 验**（`import-json <备份> --name 恢复验证` 导成**临时项目**，
  **绝不直接覆盖在用项目**）→ **③ 查**（`validate` + 抽查内容）→ **④ 决**（替换还是合并，
  **CHANGELOG 必须记"何时、从哪份备份、恢复成什么"**）。并写明：**`backups/` 在工程内 = 不算兜底**。

#### O18 · 并发写入：**检测 + 约定**（不引入锁）

- `verify` 与 `npm run check:docs` 每次打印「**最近 10 分钟内被改动的受管文件**」——
  本工程**同时会有多个 AI 会话在改**（实测被回退过两次），数据层有版本闸门，**文档层此前什么都没有**。
- `docs/RULES.md` §4 增约定：改动前先重读文件；发现被覆盖**不要反复重写**；跑完 verify 复核自己的改动。
- **为什么不做锁**：AI 场景下锁会死锁/误杀（会话异常退出后无人释放），而损害是"可发现、可重做"（M1 ⇒ 约定 + 检测）。
- 实现为纯函数 `recentlyChanged(root, minutes, nowMs)`（可注入"现在"，便于测试），含**未来时间戳守卫**。

#### O19 · 文档写作约定（`docs/ARCHITECTURE.md` §5.0，五条）

每行要么**可执行/可验证/是"为什么"** · **不写易腐数字** · **一份事实只写一处** · **报错即教程** ·
**状态类措辞必须带锚**（`开发中/待办/临时` 要么带版本或日期，要么别写 —— README 那句"v0.15/v0.16 开发中"
躺过两个版本没人发现，正是没有这条）。§5 至此分工明确：**上文管"放哪里"，§5.0 管"怎么写"**。

#### O20 · `docs/VERIFY.md` 增「文档体系快照」（生成物）

各层文档分布 / 归档族份数 / `.review` 各工作目录的死活 / 上次全链**指针** —— 全部现场计算。
**过程中修掉两个真问题**（都是新加的判定自己抓出来的）：
1. **快照最初混进了 §5.0/§5.1 子节的表格**（把"只读理解/执行变体"算成了"层"）⇒ 只统计 §5 主表（遇 `###` 即停）；
2. **VERIFY.md 此前不在 G7 的逐字校验范围内** —— 手改快照无人抓。现把它纳入 G7：
   为此把文件改成**确定性生成物**（生成日期 → 版本号、"上次全链结果"只留指针，值由 `verify`/`check:docs` 现场打印）。
   实测：手改快照 → `✗ 生成物已过期：docs/VERIFY.md（第 13 行起不一致）`。

#### O21 · 接手演练协议（`docs/ARCHITECTURE.md` §5.1）

写清**目的**（完整性无法穷举，演练是唯一不依赖作者假设的检验）、**两种变体**
（只读理解 / 执行变体：在临时副本上真改一处并跑门禁）、**提示词必须包含的五点**、
**产出留痕**（`.review/<日期>-接手演练/`，须带 README 声明死活）、
**闭环要求**（每条卡点必须转化为条目/判定，或显式写下"决定不做"及理由）。

#### 顺带修掉的两处门禁自身缺陷（都由本轮实测暴露）

1. **`doc-facts --write` 在取不到单测真值时照样生成 `null 用例`** —— `--check` 会拒绝，`--write` 却不会。
   现改为**拒绝生成**并给出处置建议（VERIFY.md 是权威基线，写进 `null` 比不写更糟）。
2. **vitest 摘要解析只认"全绿"形态**：`Tests  3 failed | 556 passed (559)` 会被解析成 null，
   于是"明明拿到了数字、只是有失败用例"被报成"取不到真值"。现改为先抓摘要行再取 `passed`；
   并在首次取不到时**自动重试一次**（这正是 `docs/VERIFY.md` 记的处置："让它单独重跑一次"——
   本机已记录：并发写入会让 vitest 以 `3221225477` = 0xC0000005 原生崩溃收场且不产出摘要）。

**R3 分层测试**：`tests/docs-registry.test.js` +2 例（并发窗口语义 / 排除工作产物区与归档族）、
`tests/doc-facts.test.js` 修正 1 例（把"语料里必须有声明"改成**"没有一条声明能逃过比对"** ——
因为 ADR「易腐事实不手写」正是要消灭散文副本，语料归零时旧断言会**假红**）→ 合计 **561 用例**。
**判别力**：本轮 3 条新机制全部注入验证（并发检测窗口语义 / check:docs 提示 / **手改 VERIFY.md 被 G7 判红**）。
**R2/R5 连带核对**：`docs/ARCHITECTURE.md`（§4b 六条 ADR + §5.0 + §5.1 + §6 四行 + 恢复 runbook）、
`docs/RULES.md`（§4 两条新约定）、`docs/VERIFY.md`（新快照节，生成）、
`scripts/{doc-facts,docs-registry-check,verify}.js`、`tests/*` → 已同步；**产品功能 / 渲染层 / CLI 命令数无影响**。


### 第四批：让"接手"可被机器检验 —— 冷启动演练实测出的 6 处缺陷全部收口（2026-09-29）

**方法**：派一个**零上下文的新会话**（只读工程内文档、不许改文件、不许跑重命令）做真实接手演练，
再逐条核实它报的问题（不采信未验证的断言）。演练结论：*"这条链子是通的 —— 这是本工程做得最好的地方"*
（它自己拼出了「加字段」的完整步骤、四层写盘禁令、"算不算做完"的判据）。它同时实测出 6 处缺口，
本轮把它们全部变成**机械判定或明确约定**。

#### O8 · 数据契约缺字段 + 章节断号 → 两条新判定（G8 第 11/12 条）

- **演练实测**：`meta.layout`（CLI `theme-layout` 写入、`src/schema.js` 校验、`docs/CLI.md` 有说明）
  **在 `docs/DATA-FORMAT.md` 里根本没有** —— 而该文档自述"第三方只读本文档就能写出正确解析器"；
  另外它的二级编号是 2.1 2.2 2.3 **2.5** 2.6 2.7（**缺 §2.4**）。
- **修内容**：契约 §1 补 `meta.layout` 一行（含 `{left,right}` 形状与校验口径）；把 §2.5/2.6/2.7
  重排为 **§2.4/2.5/2.6**，并同步 6 处交叉引用（`cli/commands/edit.js`、`AI-GUIDE`×2、
  `ARCHITECTURE`×2、`SKILL`；CHANGELOG 里的历史引用**不动**）。
- **加判定（G8 第 11 条）** `checkContractCoverage()`：`SCHEMA_FIELDS` 清单里**校验型**字段必须
  出现在 `src/schema.js`（否则清单自己过期 → `[检查表过期]`）、**仅契约型**字段**不应**出现
  （分类漂移也要报）、两类都必须在 `docs/DATA-FORMAT.md` 出现（否则 `[契约缺字段]`）。
  **上线即抓到我自己**：`meta.rootMode` 被我错标为"校验型"，而 schema 并不校验它 —— 判定按设计工作。
- **加判定（G8 第 12 条）** `checkSectionNumbering()`：受管 `docs/*.md` 的顶级与二级编号必须**连续**
  （允许从 0 或 1 起、允许无编号章节；跳过生成物 CLI.md / VERIFY.md）。
- **判别力**：删契约里的 `meta.layout` 行 → 红；把 §2.5 改成 §2.6 → 报「章节编号断号」；撤销 → 绿。

#### O9 · 版本命名空间统一（消灭"v0.16.6 是什么"）

- **演练原话**：README 写「（v0.16.6 起）」、ARCHITECTURE 的 ADR 写「（v0.16.2）」，而
  `package.json` 是 **0.16.1** —— *"我无法判断这是笔误还是另一套命名空间"*。
- **约定**：`vX.Y.Z` **只表示发布版本**；内部迭代/批次写成「v0.16 系列」或「迭代 N」。两处措辞已改。
- **加判定（G6 第四类扫描）** `findFutureVersion()`：受管文档里出现**高于** `package.json` 的
  `vX.Y.Z` 即红；同行带「计划 / 拟 / 目标 / 预计 / 未来」等字样则放行（那是在描述规划）。
- **判别力**：注入「将在 v0.17.3 提供」→ 红；撤销 → 绿。

#### O10 · "上一次全链绿没绿"留痕（接手者不必猜）

- **演练实测**：它能看出"最后像是跑过一轮测试"（VERIFY.md / 冒烟产物的时间戳），但
  **无法确认上次 `verify` 是否全绿** —— 工程里没有任何落盘痕迹。
- **落地**：`scripts/verify.js` 每次结束写 `.review/last-verify.json`（时间 / 结果 / 失败门禁 /
  总耗时 / 版本 / 各步耗时），并在**开跑前打印**一行「上次全链：<时间> ✅通过 / ❌失败于 Gx」。
  落在工作产物区（已 gitignore、不进 G6、G8 豁免），**丢了就显示"无记录"**，不判红。

#### O11 · 厘清「在飞」与 `[Unreleased]` 的分工（修我自己造成的口径混乱）

- **演练实测的冲突**：最新三批工作（已完成、未发版）**不在**「在飞 / 未收口」里，而该小节登记的
  那条其实已收口 —— 按 `SKILL.md` 指定的路线读，会误判"最新在飞"。**根因是我把两件事混在一个口径里**。
- **修**：小节顶部写明分工 —— **"最近改了什么"看 `CHANGELOG [Unreleased]`；"什么没做完"才写在本节**。
- **加提示（不算违规）** `handoverNotice()`：`[Unreleased]` 有 `###` 条目而「在飞」为空时，
  `check:docs` 打印一行提醒（"别只读一边"）。

#### O12 · 数据目录卫生：删除无主脚本 + 契约补充 + 提示级检查

- **演练实测**：`projects/comnet/build.js`（26 KB，带"⚠️ 请勿重跑"警告的历史初始化脚本）躺在
  **用户数据目录**里，而 `DATA-FORMAT.md` §5 只声明 `<name>.json` / `assets/` / `attachments/`，
  G8 又刻意跳过 `projects/` —— 无门禁、无说明。**已按用户决定删除**（删后 `validate-all` 通过）。
- **契约补充**：§5 目录树补 `.ui-state.json`（运行时协调信号，不是数据），并写明"数据目录里只应有
  这几项，脚本/分析稿请放 `.review/`"。
- **提示级检查**：`check:docs` 列出数据目录里"契约未声明的项"（**不判红** —— 那是用户数据，
  误伤代价高）。

#### O13 · 第一屏「接手 5 步」

- **演练实测**：`SKILL.md` 里"接手"字样在第 97 行（全 199 行），要拼出"下一步"得读 3 份文档。
- **落地**：`SKILL.md` 顶部落盘规矩之后新增**接手 5 步**（看没做完的 → 看最近改的 → 找你这类的做法 →
  改完怎么算完 → 收尾），并把"子集自检 ≠ 验收"写在动作现场。

#### O14 · 统一「③跑」的口径（消除灰区）

- **演练实测的灰区**：`§6` 四步表写"③跑 = `npm test` + `validate-all`"，而 R3 / README / AI-GUIDE
  写"改代码 → `npm run verify` 全链"，**没有一处说明前者是否被后者覆盖**。
- **修**：§6 全表的"③跑"列统一为 **`npm run verify`（全链＝验收）**，并加一段说明：
  单个门禁脚本只是**自检**（十几秒级），全链还含单测 / 集成 / 冒烟 / 数据校验。
  "改数据格式"行补注"其中的 **G2** 就是 `validate-all`"。

#### O15 · 兜底备份的新鲜度（Git 零提交下唯一回滚手段）

- **演练实测**：工程 **Git 零提交**（`.git/objects` 被 EDR 拦），文档指定的工程外目录
  `D:/backup/ai-mind-map/` **不存在**，`backups/` 里最新一份是 **7 天前**且**就在工程内（同盘）**。
- **落地**：`verify` 结束打印一行兜底备份新鲜度（未找到工程外导出 / 最新在 N 天前 / 今天）——
  **只提示，不影响退出码**（"该不该现在备份"是人的判断）。

**R3 分层测试**：`tests/docs-registry.test.js` +5 例（契约缺字段 / 检查表过期 / 断号必红 /
编号连续不报 / 交接提示不算违规）、`tests/doc-facts.test.js` +4 例（未来版本号三组判据 +
真实工程回归）→ 合计 **559 用例**。
**判别力**：本批 4 条新判定全部做过注入验证；**其中"撤销后复核"还抓出我引入的一个真 bug**
（`main()` 里误用未定义的 `root`，会让 G8 崩溃而不是判红）—— 已修，这正是"改完必须重跑"的价值。
**顺带**：G6 的体量类扫描**当场抓到我自己刚写进 SKILL 的"460 KB"** —— 判定有效，已改写为不带数字。
**R2/R5 连带核对**：`docs/DATA-FORMAT.md`（§1 字段 + §5 目录树 + 编号重排）、
`docs/ARCHITECTURE.md`（§6 口径 + ADR 措辞）、`docs/ROADMAP.md`（分工说明）、`SKILL.md`（接手 5 步）、
`cli/commands/edit.js`、`docs/AI-GUIDE.md`、`README.md`（版本措辞）、
`scripts/{doc-facts,docs-registry-check,verify}.js` → 均已同步；**产品功能 / 渲染层 / CLI 命令数无影响**。

#### 补记 · `.review/` 根下清理与"机器产物"口径（同一批，演练也提了这条）

演练者另外指出：`.review/` 根下的 `verify-tests.json`（190 KB）**地位不明** ——
它"只能读、不能判断算不算权威证据"。核实后按用户决定处理：

- **删掉 `.review/survey.js`**（自述"一次性，用完即删"的巡检脚本，在根下躺了 6 天）。
- **删掉 `.review/verify-tests.json`**，并**写明它是什么**：它是 `verify` 的**机器产物**
  （第 4 步把 vitest 用例数交给第 8 步，省一次重跑）——**下次 `verify` 会按设计重建**，
  所以"删掉"只解决"来路不明"，真正要补的是口径。
- **补口径（三处）**：`ARCHITECTURE.md` §5 准入第 3 条写明「`.review/` 根下只允许两种东西」——
  ① 各任务的工作目录（须带 README 声明死活）；② **机器产物**，目前只有
  `verify-tests.json` 与 `last-verify.json` 两个（命令自动写、可随时删、**不要手工编辑**）；
  手写的散落文件（探针脚本、临时数据）应放进某个工作目录。`SKILL.md` 落盘规矩同步一句。


### 接手可达性加固（第 3 批）：清单单源化 + 体量数字门禁化 + 发版提示（2026-09-29）

#### O6 · 文档清单"只有一处权威" —— README 文档地图降级为指针 + **G8 第 10 条判定**

- **问题**：同一批文档事实有**三处视图**（`ARCHITECTURE.md` §5 登记表 = 权威 / README 文档地图 13 行 /
  SKILL 导航），却只有 §5 被门禁守着 —— README 与 SKILL 的清单漂移无人管（历史上正是这么漂过一次）。
- **降级**：README 的文档地图**只留 4 份面向人的**（RULES / ARCHITECTURE / CHANGELOG / ROADMAP）
  + 一行"完整清单见 §5"，并在表前写明理由（再抄一份完整清单 = 制造第二份副本）。
- **补守卫（G8 第 10 条）**：`checkNavCoverage()` —— **§5 登记的每份文档都必须能从 `SKILL.md` 找到**
  （接受完整路径或文件名两种写法；判据是**集合级**，措辞不限）。为什么只查 SKILL：新接手的 AI 的
  **第一屏**就是 `SKILL.md`，那里找不到就等于不知道它存在；README 既已降级为指针，就不再承担"列全"责任。
- **判别力**：抹掉 SKILL.md 里对 `docs/INCIDENTS.md` 的全部提及 ⇒ 报 `[导航不可达]`；撤销 ⇒ 绿。

#### O7 · 体量/行数类数字**门禁化**（约定 → G6）+ `[Unreleased]` 发版提示

- **问题**：`RULES.md` §4 早有"体量/行数类数字不手写"的约定，但**没有门禁** —— 实测过期 5 处。
- **落地（G6 新增一类扫描）**：受管文档里出现 `N KB/MB`（含 `230+ KB` 这种写法）或三位数以上「N 行」，
  **同行必须带锚**（`vX.Y.Z` 或「快照」/「原记」/「当时」/「曾」）才放行，否则判红并给出改写指引。
  纯函数 `findSizeClaim(line)` 独立可测（+4 单测；含"小数与版本号不误伤"）。
- **顺手清掉 5 处命中**（**加历史锚或去数字，不放宽判定**）：
  `README.md` vendor 包体量（改为不写数字，注明"随 DSH 版本变化"）；
  `docs/ROADMAP.md` 三处拆分快照（加「拆分当时的快照」标注）；
  `docs/RULES.md` 规则自身的引例（`230+ KB`/`2200 行` → 占位 `<N>`，规则文字不该含易腐数字）。
- **`[Unreleased]` 提示（只提示不判红）**：G6 在 `[Unreleased]` 超过 400 行时打印一行建议发版 ——
  它**不受滚动窗口约束**（滚动只作用于已发版本段），上一轮实际长到 2087 行 / 189 KB。

**R3 分层测试**：`tests/doc-facts.test.js` +5 例（`findSizeClaim` 四组判据 + 负向后顾不误伤）、
`tests/docs-registry.test.js` +0 例（既有 fixture 按新判定补 SKILL 提及，并保留严格断言）。
**R2/R5 连带核对**：`docs/RULES.md`（§2 的 G6/G8 行重写 + §4 体量类改为"已机械化"）、
`README.md`（文档地图降级 + vendor 体量去数字）、`docs/ROADMAP.md`（三处快照标注）、
`scripts/doc-facts.js`（新判定 + 导出）、`scripts/docs-registry-check.js`（第 10 条）、
`CHANGELOG.md` → 均已更新；产品功能 / 渲染层 / 数据格式 / CLI 命令数 **无影响**。


### 接手可达性加固（第 2 批）：架构文档↔代码对应 + 归档横幅 + 工作目录死活（2026-09-29）

**背景**：延续"文档体系 = 让新接手的 AI 能独立接手"这条标尺。三个客观探针查出的缺口，
本批把它们从"靠自觉"变成"机械守卫"。

#### O3 · 架构文档 ↔ 代码：补 3 个模块 + 新增 §2.6 scripts 表 + **G8 第 7 条判定**

- **缺口（探针实测）**：`src/` 21 个模块里 **3 个没被架构文档提到**
  （`ui-state.js` / `dsh-capabilities.js` / `dsh-sidebar-skill.js`）；**`scripts/` 连章节都没有** ——
  连 `verify.js`（验证链的**单源**）都不在架构文档里。接手者靠 §2 认识代码结构，而它已落后于代码。
- **补文档**：§2.3 补 3 行；**新增 §2.6「脚本层（scripts/）」**表 —— 15 个脚本逐条列出职责，
  并标注哪些**不在 verify 里**（`dsh-e2e` / `dsh-resident` 需真实冷启动，慢）。
- **补守卫（G8 第 7 条）**：`checkModuleCoverage()` —— **`src/*.js`、`cli/commands/*.js`、`scripts/*.js`
  每个文件必须被 `ARCHITECTURE.md` 提到**，否则判红（`[代码未入档]`）。范围刻意收窄：
  `tests/`、`scripts/smoke/`、`scripts/vision/` **豁免**（目录级说明 + 自描述命名，逐文件登记只增维护面）。
- **判别力**：注入 `src/zzz-未入档模块.js` ⇒ exit 1 并定位；撤销 ⇒ 绿。

#### O4 · 归档文档必须有「历史」横幅 + **G8 第 8 条判定**

- **缺口（探针实测）**：`docs/archive/` 6 份里 **4 份没有任何历史标记**（3 个 HTML 分析稿 +
  `DSH-IMPL-CONTRACT-2026-09.md`）—— 归档不是藏起来，它**仍会被 grep 到**，接手者可能把旧稿当成现状。
- **补横幅**：4 份各加固定横幅（`.md` 用引用块、`.html` 用注释，插在 `<!DOCTYPE>` 之后）；
  §5 准入第 3 条写明"归档文档必须带横幅，**加横幅不算改内容**"。
- **补守卫（G8 第 8 条）**：`checkArchiveBanners()` —— `docs/archive/**.{md,html}` 前 8 行必须含标记。
- **判别力**：去掉某份的横幅 ⇒ exit 1；撤销 ⇒ 绿。

#### O5 · 工作目录必须声明死活 + **G8 第 9 条判定**

- **缺口（探针实测）**：`.review/` 四个工作目录里最新一个**当天还在写（70 个文件）**，
  却没有任何状态标记 —— 接手者要么误删在飞工作，要么把陈旧分析当现状。
- **补状态**：4 个目录各建 `README.md`（主题 / 开始日期 / **状态：在飞|已收口|已废弃**），
  状态与 `docs/ROADMAP.md`「在飞 / 未收口」一致（1 在飞 + 3 已收口）。
- **补守卫（G8 第 9 条）**：`checkWorkDirStatus()` —— `.review/` 的**直接子目录**缺 `README.md` 即红
  （`[工作目录无状态]`）；`.review/` 下的散落文件豁免；**`.review/vision/` 豁免**（由
  `scripts/vision/record.js` 按需创建、固定用途的读图留痕存储，已在 §2.4/§4b 说明）。
- **判别力**：临时删掉某目录 README ⇒ exit 1；撤销 ⇒ 绿。

#### G8 长成了"文档体系完整性"门禁（3 条 → 9 条）

登记 / 家门 / 根与顶层白名单 / 归档重复 / **交接死指针** / **代码入档** / **归档横幅** / **工作目录状态**。
`docs/RULES.md` §2 的 G8 行已按新范围重写（含每条防什么损害）。

**R3 分层测试**：`tests/docs-registry.test.js` **+9 例**（本批 5 例：src 未入档、cli/scripts 同纳且
tests/smoke 豁免、归档缺横幅、横幅两种形式、工作目录缺 README 且散落文件豁免）→ 25/25 通过。
**R2/R5**：`docs/ARCHITECTURE.md`（§2.3 + §2.6 + §5 准入）、`docs/RULES.md` §2、4 份归档横幅、
4 个工作目录 README 已同步；`README.md` 与产品功能**无影响**（未改）。


### 交接面（O1）+ 每任务四步（O2）：让"新接手的 AI"能自己知道下一步做什么（2026-09-29）

**背景**：以"文档体系是为**AI 生成、AI 维护迭代**的工程准备的交接面"为标尺做了一轮可达性审计，
四个客观探针查出的缺口里，最要命的两条是：**「接手未完成工作」没有任何路由**、
**在飞状态只散落在散文里**（`.review/` 四个工作目录中最新一个有 70 个文件、当天还在写，
却没有任何"在飞/已收口"标记，而规则又说整个目录可随时删）。本次落地前两项。

#### O1 · 交接面：`docs/ROADMAP.md` 新增「在飞 / 未收口」小节

- **内容**：4 条记录（1 在飞 + 3 已收口），每条 `主题 · 当前结论 · 下一步 · 证据指针`，
  证据指向对应的 `.review/<目录>`；口径写明**在飞 / 已收口**两种状态。
- **规矩**（写进 `docs/ARCHITECTURE.md` §5 准入第 5 条）：只写"现在"（不复制"要不要做"）、
  每条 ≤3 行、**发版时清空或移入版本段**、证据指针由 **G8** 校验。
- **新门禁判定（G8 第 6 条）**：`scripts/docs-registry-check.js` 新增 `checkHandoverPointers()`
  —— 扫「在飞 / 未收口」小节里的 `.review/...` 指针，**目录不存在即判红**（报 `[交接死指针]`）。
  **判别力已注入验证**：把指针改成不存在的目录 ⇒ exit 1 并给出 `docs/ROADMAP.md:<行号>`；
  撤销 ⇒ 绿。**上线即抓到一次自己的假阳性**：规矩文字里的占位写法 `` `.review/<目录>` ``
  被当成真指针，已改为跳过含 `<` `>` `*` 的占位写法（单测锁住）。
- **`release` 提醒**：发版时若该小节仍有记录，打印一行提醒（**只提醒不代改** —— 清空前需判断哪些还没收口）。

#### O2 · 任务路由补全 + `ARCHITECTURE.md` §6 改为「每任务四步」

- **SKILL.md 导航补两行**（原先这两类任务无路由）：⑤ 组「改数据格式（加字段/改结构）」→
  `DATA-FORMAT.md` + `ARCHITECTURE.md` §6；⑥ 组「**接手 / 看现在做到哪了、下一步做什么**」→ ROADMAP 在飞小节。
- **§6 从"想做什么→改哪里"两列改为四列**：`① 读 → ② 改 → ③ 跑 → ④ 更新`，覆盖 9 类任务
  （加/改命令、加渲染功能、改数据格式、加 IPC、加 MCP 工具、**加/改门禁**、改文档体系、发版、打包），
  并补上原先只在 `RULES.md` §2 里的动作要求：**加/改门禁必须先注入一次违规证明会红再撤销**；
  三条横切规矩（写盘出口 / 版本号单源 / 观察者幂等）移出表格改为表后说明。

#### 顺带修掉一处门禁覆盖不到的漂移

`docs/ROADMAP.md` 首行写着「当前版本 0.15.0」，**实际已是 0.16.1** —— `release` 只同步
package.json / config.js / lock / README 四处，不同步 ROADMAP，**没有任何门禁会抓**。
已改为**不写版本号**、指向 `package.json` / `docs/VERIFY.md`（与 §4 约定「易腐数字不手写」一致），
并在该处注明这次漂移的事实。

**R3 分层测试**：`tests/docs-registry.test.js` +4 例（指针存在不报 / 死指针必红 / 占位写法不算指针 /
无该小节不判）；并把 `fakeProject` 提到模块级供多个 describe 共用。CLI 侧 `release` 的提醒走既有集成断言覆盖。

**R5 改动即连带（逐项核对）**：
- `docs/ROADMAP.md`（新增小节 + 去版本号）、`docs/ARCHITECTURE.md`（§5 准入第 5 条 + §6 四步表）→ 已更新；
- `SKILL.md` 导航 ⑤⑥ 组 → 已更新；`scripts/docs-registry-check.js`（第 6 条判定 + 导出）→ 已更新；
- `cli/commands/release.js`（发版提醒）→ 已更新；`docs/VERIFY.md`：**无新增计数真值** → 由 `facts:write` 复核；
- `README.md`：本次不涉及产品功能与文档地图条目 → **无影响**（未改）；
- 应用代码 / 渲染层 / 数据格式 / CLI 命令数：**无影响**。

## [v0.16.1] - 2026-09-27

### 发版 v0.16.0（本文件首次滚动归档实战）+ 修掉发布路径的一个误导性报错（2026-09-27）

**发版**：`node cli/mm-cli.js release --minor` ⇒ **v0.16.0**（v0.15.0 之后累计的全部变更一次性收口），
四处版本号同步（package.json / src/config.js / package-lock.json / README 版本锁）。
本文件结构随之进入**受窗口约束**的稳态：`[Unreleased]`（空）+ 最近 3 个版本段（v0.16.0 / v0.15.0 / v0.14.0），
v0.13.0 由 `release` 自动滚入 `docs/changelog/`（归档现有 **13** 份）。
这是滚动归档机制上线后第一次真实发版，机制按设计工作。

**顺带修掉一个会让人白花时间的报错**：发版时后置不变量报
`占位行出现 2 次（应为 1 次）` —— 真因是 **v0.15.0 版本段里残留了占位行**
（正是 v0.15.0 那次"占位行被带进版本段"缺陷的残留物，一直没清）。处理：
- 删掉那行残留（`CHANGELOG.md` 的 v0.15.0 段内）；
- **报错文案改为直接点出最可能的原因与定位命令**（`changelog --grep 占位行 --full`），
  并加单测锁住这个指引（不变量本身不动 —— 它抓对了，只是没说清）。

> 用法纠错记录：`release minor` 会被当成"版本号 = minor"而报 `版本号格式: x.y.z`；
> 正确写法是 **`release --minor`**（`registry` 的 usage 一直写的是标志形式）。
