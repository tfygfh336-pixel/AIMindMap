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
| `read` | read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--images] |
| `list` | list <项目> [--json] |
| `get` | get <项目> <id> [--json] [--detail] [--images] |
| `search` | search <项目> <关键词|--tag 标签> [--json] [--full] |
| `stats` | stats <项目> [--json] |
| `init` | init <项目> [--title 标题] |
| `backlinks` | backlinks <项目> <id> [--json] |
| `related` | related <项目> <id> [--json] [--depth N] |
| `ask` | ask <项目> [<节点id>] [--nodes a,b,c] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run] |
| `theme-layout` | theme-layout <项目> [--left a,b] [--right c,d] [--clear] |
| `add` | add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] |
| `add-root` | add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] |
| `edit` | edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false] |
| `move` | move <项目> <id> <新父id> [--index n] |
| `expand-depth` | expand-depth <项目> [--depth N] [--id 子树根id] |
| `remove` | remove <项目> <id> [--clean-assoc] [--clean-links] |
| `clone` | clone <项目> <源id> <新父id> [--deep] |
| `import-md` | import-md <项目> <md文件> [--parent id] |
| `import-project` | import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json] |
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
| `link` | link <项目> <id> --to 目标项目 --id 目标id [--caption 说明] |
| `unlink` | unlink <项目> <id> --to 目标项目 --id 目标id |
| `links` | links <项目> [--json] |
| `links-prune` | links-prune <项目> [--nodes a,b] [--dry-run] |
| `orphans` | orphans <项目> [--json] [--content-only] [--limit n] |
| `mentions` | mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n] |
| `assoc-list` | assoc-list <项目> [--node <id>] [--json] [--raw] |
| `assoc-add` | assoc-add <项目> --members a,b,c [--title 标题] [--note html | --note-md markdown] [--id id] |
| `assoc-edit` | assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c] |
| `assoc-remove` | assoc-remove <项目> <assocId> |
| `assoc-prune` | assoc-prune <项目> [--nodes a,b] [--dry-run] |
| `validate` | validate <项目|json文件> [--json] |
| `validate-all` | validate-all |
| `ui-state` | ui-state [<项目>] [--json] |
| `changes` | changes [<项目>] [--since <rev|版本号>] [--json] [--limit n] |
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

读取项目可读视图（树 + 详情 + 图片清单）。四个变窄开关可叠加：--brief 去长文本 / --skeleton 再去 tags+links（只要结构）/ --subtree <id> 只要某棵子树 / --compact 单行 JSON；实测全叠加比全量省约 86%（`--detail` 不再写进用法但**照旧可用**：--json 下是空操作、文本模式下响亮报错并给出替代路径 —— 老调用方不会因为"它被移除了"而突然失败）

```
node cli/mm-cli.js read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--images]
```

### list

树形列出项目全部节点

```
node cli/mm-cli.js list <项目> [--json]
```

### get

查看节点（路径/详情/图片）

```
node cli/mm-cli.js get <项目> <id> [--json] [--detail] [--images]
```

### search

搜索节点（默认标题；--full 全文匹配 detail/图片caption/标签/链接说明；--tag 按标签过滤）

```
node cli/mm-cli.js search <项目> <关键词|--tag 标签> [--json] [--full]
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
node cli/mm-cli.js add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false]
```

### add-root

新增顶层主题（不选父节点，直接挂在根节点下）—— 一个项目里可放多个不同方面的笔记

```
node cli/mm-cli.js add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径]
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

复制节点到新父节点（--deep 含子树）

```
node cli/mm-cli.js clone <项目> <源id> <新父id> [--deep]
```

### import-md

从 Markdown 导入节点（追加到 parent）

```
node cli/mm-cli.js import-md <项目> <md文件> [--parent id]
```

### import-project

功能 5a：**从大文档建一个新项目 + 一棵新树**（md/txt/docx；PDF **有书签走书签、无书签自动回退文字层**，两样都没有才响亮拒绝）；1 级标题成为顶层主题；一次原子写入，失败不留半个项目；--dry-run 只预览格式/规模/前几个标题与来源、不写盘

```
node cli/mm-cli.js import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json]
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

添加跨项目链接

```
node cli/mm-cli.js link <项目> <id> --to 目标项目 --id 目标id [--caption 说明]
```

### unlink

移除跨项目链接

```
node cli/mm-cli.js unlink <项目> <id> --to 目标项目 --id 目标id
```

### links

列出项目全部跨项目链接

```
node cli/mm-cli.js links <项目> [--json]
```

### links-prune

清理悬空链接（目标已不存在，修好悬挂链接导致的校验红）

```
node cli/mm-cli.js links-prune <项目> [--nodes a,b] [--dry-run]
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
node cli/mm-cli.js assoc-add <项目> --members a,b,c [--title 标题] [--note html | --note-md markdown] [--id id]
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
