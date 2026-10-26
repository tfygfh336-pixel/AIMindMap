#!/usr/bin/env node
/* ============================================================
 * AI MindMap — MCP (Model Context Protocol) stdio server
 * ------------------------------------------------------------
 * 让任意支持 MCP 的 agent 工具（DeepSeek Harness、Claude Desktop、
 * Cursor、其他自研 harness 等）以标准协议调用本工程的全部能力。
 *
 * 零第三方依赖：仅用 Node 内置模块；工具实现全部转发给
 * cli/mm-cli.js（CLI 是唯一逻辑源，这里不复制任何业务逻辑）。
 *
 * 启动方式：node scripts/mcp-server.js
 * 协议：MCP 2024-11-05，stdio 传输，逐行 JSON-RPC 2.0。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'mm-cli.js');
/**
 * 【W4】混合检索的**预设权重 / 路由表**单源（`src/palette-rank.js`）—— 只用来拼 `search_nodes` 的
 * 参数描述（**现取**，与 cli/registry.js 同一条纪律）：数字抄进 desc 就是第二份副本，
 * 而它漂移的方向恰好是"AI 照描述传的权重与实际生效的不是一批"。
 */
const paletteSpec = require(path.join(ROOT, 'src', 'palette-rank.js'));
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

/* ---------------- 工具定义（每个工具 = 一个 mm-cli 调用） ---------------- */
const T = (name, description, params, required) => ({
  name, description,
  inputSchema: { type: 'object', properties: params, required: required || [] }
});
const s = (d) => ({ type: 'string', description: d });
const b = (d) => ({ type: 'boolean', description: d });
const a = (d) => ({ type: 'array', items: { type: 'string' }, description: d });

const TOOLS = [
  T('projects', '列出全部笔记项目', { json: b('返回 JSON') }),
  T('read_project', '读取项目可读视图：树 + 各节点详情 + 图片清单（AI 引用内容与图片）', {
    project: s('项目名或 JSON 文件路径'), brief: b('只要结构不要长文本')
  }, ['project']),
  T('list_nodes', '树形列出项目全部节点', { project: s('项目名或 JSON 文件路径') }, ['project']),
  T('get_node', '查看节点（含路径/详情/图片）。给 item（= 条目 id）则**只取回那一条条目**（条目视图：'
    + 'html/src/tags/verified/qa…，对应 CLI 的 `get … --item <itemId>`）；不给 item 时行为与从前完全一致', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'),
    item: s('可选：条目 id（`i-…`）—— 对应 CLI 的 --item。条目不属于该节点会**指名它实际在哪个节点**')
  }, ['project', 'id']),
  T('search_nodes', '搜索**条目**（默认口径：节点标题 ∪ 条目正文）。**命中 = 关键词是命中面的「非连续子序列」**'
    + '（大小写不敏感 —— 与界面命令面板**同一个谓词、同一份打分**，`src/palette-rank.js` 是唯一实现处）：'
    + '`闸门` 命中 `闸 与 门` 之间隔了字的标题，`tp` 命中 `TCP`（子串命中是它的特例）。'
    + 'item_level=false 退回旧口径"只搜标题"'
    + '（对应 CLI 的反向开关 --topic-only）；full=true 再加全文面（detail / 图片 caption / 节点标签 / 链接说明）；'
    + 'tag 按标签过滤（条目级或节点级）；src / verified / type / since 是**条目级**过滤（给了它们就只返回条目命中）；'
    + 'limit / max_bytes 卡预算（超限会截断并在结果里给续取方式）；'
    + '**顺序 = 那份模糊打分升序、同分保持「深度优先 + 条目序」**，热度只在其上重排（封顶，不改变命中与否）'
    + '⇒ **零热度档**（本机没有热度日志，或 no_heat=true）时，同一查询的**节点顺序与界面命令面板逐条相同**；'
    + 'no_heat=true 跳过热度日志（**热度日志损坏时可用 no_heat:true 先检索**：排序回到零热度档，'
    + '与从来没有过热度的项目逐字相同）—— 对应 CLI 的 --no-heat；不给它时日志坏了**照旧响亮失败**'
    + '（失败原因里会点名这条出路）。'
    + '**不给 project ⇒ 扫全库**（跨项目检索，对应 CLI 的 `search-all`）：命中来自所有项目、每条带 project，'
    + '可用 scope 收窄范围（对应 CLI 的 --scope）；跨项目时不合并排序（顺序 = 项目名升序 × 项目内既有顺序 —— '
    + '上面那条"与面板逐条相同"只对**给了 project 的单项目档**成立），'
    + '热度逐项目各算各的榜；读不动的项目会被**跳过并在结果里的 skipped 点名**。'
    + '给了 project 时行为与从前**逐字相同**', {
    project: s('项目名或 JSON 文件路径。**不给它** ⇒ 扫全库（跨项目检索，对应 CLI 的 `search-all`），'
      + '每条命中带 project 字段；给了它 ⇒ 只搜这一个项目（行为与从前逐字相同）'),
    scope: a('可选：**只扫这几个项目**（项目名数组，对应 CLI 的 --scope）—— 只在"不给 project"'
      + '（扫全库）时有意义；名字写目录名，名单里有库里不存在的项目会**报错并逐个点名**'),
    keyword: s('关键词（与 tag 可组合）'),
    full: b('全文搜索（detail/caption/节点标签/链接说明）—— 对应 CLI 的 --full'),
    tag: s('按标签过滤：**条目级** `item.tags` 或**节点级** `tags` 含它即命中（对应 CLI 的 --tag）'),
    item_level: b('是否按**条目层**检索（对应 CLI 的反面 `--topic-only`）：默认 true = 搜条目；'
      + '显式给 false ⇒ 加上 --topic-only，退回 v2 的"只搜标题"口径'),
    no_heat: b('**显式**跳过热度日志 —— 本次调用**完全不碰它：不读、不写、不排序**'
      + '（往坏日志里再追加一条只会搅得更坏，所以"写入"这一半也一起关）。'
      + '热度日志损坏 / 认不出通道 / 时间乱序时这是**先拿到结果**的出口（排序回到零热度档）；'
      + '不给它时默认档**仍然响亮失败**（不许静默降级成"按 0 排"）—— 对应 CLI 的 --no-heat'),
    src: s('只要**出处**（条目 `src`，字符串或数组的任一项）含该子串的条目 —— 对应 CLI 的 --src'),
    verified: b('只要**已核**条目（没有 `verified` = 未核）—— 对应 CLI 的 --verified'),
    type: s('只要该 `type` 的条目：text | rich | qa —— 对应 CLI 的 --type'),
    since: s('只要写入时间 `at >= ISO` 的条目（给了它就不返回未条目化的节点命中）—— 对应 CLI 的 --since'),
    limit: s('命中条数上界（整数）—— 对应 CLI 的 --limit；非法值当场报错，不静默退化'),
    max_bytes: s('单次返回的**字节**上界（整数）—— 对应 CLI 的 --max-bytes；超限截断 + 给续取方式'),
    /* 【W4】混合检索：**只加参数、不新增工具**（工具数不变）。三个参数的语义与 CLI 逐字相同
     * （它们最后落到同一个 `src/item-index.js` 的 `searchItems` ⇒ 解析、权重表、RRF 都只有一处）。 */
    mode: s('可选：混合检索预设（对应 CLI 的 --mode）——' + Object.keys(paletteSpec.MODES).join(' | ')
      + '。**不给 mode 也不给 weights ⇒ 这一层是关的**（排序与从前逐字相同）；'
      + '给了它就在既有命中内部按多路信号重排（不增删命中）：'
      + Object.keys(paletteSpec.MODES).map((m) => m + '(' + paletteSpec.ROUTE_IDS
        .map((r) => r + '=' + paletteSpec.MODES[m][r]).join(',') + ')').join(' / ')
      + ' —— 预设表与理由的唯一一处是 src/palette-rank.js 的 MODES'),
    weights: s('可选：自己定权重（对应 CLI 的 --weights），形如 `text=1,graph=.5`；它是**完整名单**，'
      + '没提到的路由权重按 0；可选路由 ' + paletteSpec.ROUTE_IDS.join(' / ')
      + '（semantic = W3 未落地 ⇒ 未安装，权重收下但不产生名次）。与 mode **不能同给**'),
    explain: b('可选：只要"每路贡献"的读数（对应 CLI 的 --explain）—— **只多给读数、不改排序**：'
      + '结果里多一个顶层 explain:{enabled,mode,k,weights,recall,routes,hits}，逐路给权重与有名次条数'
      + '（含"这一路为什么没出力"），`recall` 那一栏逐路报"扩召回接回来几条 / 为什么是 0"，'
      + 'explain.hits 与 hits 逐条同长同序（每条的逐路名次与贡献）。'
      + '命中对象**不加任何键**（12 键契约不动）'),
    /* 【W4b】扩召回：**只加参数、不新增工具**（工具数不变）。语义与 CLI 逐字相同
     * （它最后落到同一个 `src/item-index.js` 的 `searchItems` ⇒ 解析、上界、新取值名都只有一处）。 */
    recall: s('可选：**扩召回**（对应 CLI 的 --recall）—— 把"非字面命中"（最佳字面命中在有界邻域里的'
      + '近邻，上界取自 src/palette-rank.js 的路由表）也接进结果：hitCount / hits **会因此变多**，'
      + '新命中的 matchIn = 该路声明的取值（'
      + paletteSpec.RECALL_ROUTE_IDS.map((id) => {
        const r = paletteSpec.ROUTES.filter((x) => x.id === id)[0];
        return id + ' → ' + r.recallHit + '（上界 ' + r.bound + ' 跳）';
      }).join(' / ')
      + '）。**不给它时结果与从前逐字相同**；它改变的是候选集 ⇒ 必须与 mode / weights **同给**'
      + '（"这批候选怎么排"是融合那一层的事）')
  }, []),
  T('backlinks', '查看节点反向链接（谁引用了我，含跨项目反查）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id')
  }, ['project', 'id']),
  T('related', '查看节点相关知识点（我引用谁 + 谁引用我，双向合并去重；depth=N 扩到 N 跳邻域，任意正整数）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'),
    depth: s('邻域半径（跳数）：默认 1（仅直接关联）；2 = 两跳/间接关联的知识簇；可给更大整数'
      + '（防环、每节点只算最短跳数）。⚠ 邻域超过 500 条会**报错**（不是截断）—— 那时把 depth 调小或换个节点')
  }, ['project', 'id']),
  T('orphans', '关系审计：列出无任何引用关系的节点，并区分「含内容待处理」与「纯结构正常」（用于发现漏挂链接的笔记）', {
    project: s('项目名或 JSON 文件路径'), content_only: b('只返回含内容的那部分（真正该处理的）'), limit: s('最多返回条数，默认 40')
  }, ['project']),
  T('mentions', '未链接提及：正文提到了某节点却没建 links —— orphans 的另一半，会告诉你"该往哪连"；cross=true 额外扫描跨项目两个方向（同名歧义不猜，会标记 ambiguous）', {
    project: s('项目名或 JSON 文件路径'),
    min_length: s('主题短于此长度不作匹配目标，默认 3'),
    include_structural: b('把"结构上已相邻(父子/祖孙)"也算命中，默认 false'),
    cross: b('是否扫描跨项目（其他项目正文提到本项目 / 本项目正文提到其他项目），默认 false'),
    limit: s('最多返回条数，默认不限')
  }, ['project']),
  T('assets', '列出项目全部图片及备注 caption（AI 决定引用哪些图）', { project: s('项目名或 JSON 文件路径') }, ['project']),
  T('add_node', '在 parent 下新增子节点', {
    project: s('项目名或 JSON 文件路径'), parent: s('父节点 id'), topic: s('标题'),
    id: s('可选，见名知义的 id'), detail: s('可选，详情 HTML（渲染层按 HTML 注入）'),
    detail_md: s('可选，详情 Markdown（推荐 AI 使用；命令内转 HTML 存储，与 detail 互斥）'),
    expanded: b('可选，默认折叠（expanded:true 可显式展开）')
  }, ['project', 'parent', 'topic']),
  T('edit_node', '编辑节点（标题/详情/标签/展开状态）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), topic: s('新标题'),
    detail: s('设置详情 HTML'), detail_md: s('设置详情 Markdown（推荐 AI 使用，与 detail 互斥）'),
    clear_detail: b('删除详情'), tags: a('覆盖设置标签数组'),
    clear_tags: b('清空标签'), expanded: b('展开/收起')
  }, ['project', 'id']),
  T('move_node', '移动节点到新父节点', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), parent: s('目标父节点 id'), index: s('可选索引，默认末尾')
  }, ['project', 'id', 'parent']),
  T('remove_node', '删除节点（含子树）。若该节点被「关联笔记」或链接引用，默认会被拒并提示清理方式；clean_assoc=true 清理关联成员（清到只剩一个成员的关联会整篇删除），clean_links=true 清理指向它的链接', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'),
    clean_assoc: b('同时清理引用了该节点的关联成员'),
    clean_links: b('同时清理指向该节点的链接')
  }, ['project', 'id']),
  T('import_markdown', '从 Markdown 文件导入节点（追加到 parent）。**第一个标题之前的正文（前导正文）不会丢**：父节点没有 `items` ⇒ 前置进它的 detail；父节点**已条目化**（有 `items`）⇒ 作为**首条条目**插进 items[0]、detail 随之重建（落点规则全文见 docs/ITEM-MODEL.md §2.1）。**同一份来源默认只导一次**：命令会记下来源路径 + 内容指纹，重复导入会被拒并指名上次导到哪去了；确实要第二份就 force=true', {
    project: s('项目名或 JSON 文件路径'), file: s('Markdown 文件路径'), parent: s('可选，目标父节点 id，默认 root'),
    force: b('同一个来源**故意**再导一次（默认拒绝重复导入）')
  }, ['project', 'file']),
  T('export_markdown', '导出项目为 Markdown 大纲', {
    project: s('项目名或 JSON 文件路径'), out: s('输出 .md 文件路径'),
    format: s('可选 heading|list'), with_detail: b('附带详情引用块')
  }, ['project', 'out']),
  T('export_json', '导出项目为 aimap 单文件（图片 base64 内嵌，可移植/备份/跨电脑）', {
    project: s('项目名或 JSON 文件路径'), out: s('输出 .json 文件路径')
  }, ['project', 'out']),
  T('export_html', '导出项目为静态站点（index.html + assets/ 复制），可分享/部署；「相关知识点」已内联为可跳转链接', {
    project: s('项目名或 JSON 文件路径'), out: s('输出目录路径')
  }, ['project', 'out']),
  T('import_json', '从 aimap 单文件导入为新项目（解包图片到 assets/）', {
    file: s('aimap .json 文件路径'), name: s('可选，新项目名（默认取包内 meta.name；同名会报错）')
  }, ['file']),
  T('add_image', '给节点添加图片（复制进 assets/，caption 必填）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), file: s('图片文件路径'),
    caption: s('图片内容说明（AI 凭此理解图片）'), source: s('可选出处'), tags: a('可选标签')
  }, ['project', 'id', 'file', 'caption']),
  T('remove_image', '移除节点上的图片引用', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), file: s('图片相对路径如 assets/x.png')
  }, ['project', 'id', 'file']),
  T('add_file', '给节点添加附件文件（复制进 attachments/，caption 必填，md/pdf 可内预览）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), file: s('附件文件路径'),
    caption: s('附件内容备注（AI 凭此理解附件用途）'), source: s('可选出处')
  }, ['project', 'id', 'file', 'caption']),
  T('files', '列出项目全部附件及 caption', { project: s('项目名或 JSON 文件路径') }, ['project']),
  T('link_nodes', '添加跨项目链接', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'),
    to: s('目标项目名'), to_id: s('目标节点 id'), caption: s('可选说明')
  }, ['project', 'id', 'to', 'to_id']),
  T('unlink_nodes', '移除跨项目链接', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), to: s('目标项目名'), to_id: s('目标节点 id')
  }, ['project', 'id', 'to', 'to_id']),
  T('list_links', '列出项目全部跨项目链接', { project: s('项目名或 JSON 文件路径') }, ['project']),
  T('assoc_list', '列出「关联笔记」（N 元关联实体）—— 介绍二者/多者之间关联知识的笔记；node 可只看某节点所属的', {
    project: s('项目名或 JSON 文件路径'), node: s('可选：只列出包含该节点的关联')
  }, ['project']),
  T('assoc_add', '新增关联笔记（成员至少 2 个，支持跨项目 项目/节点id）', {
    project: s('项目名或 JSON 文件路径'),
    members: s('成员，逗号分隔，如 a,b,c 或 comnet/dns,comnet/tcp-basics'),
    title: s('可选标题（不写则用成员主题拼接）'),
    note: s('可选笔记正文（HTML）'),
    note_md: s('可选笔记正文（Markdown，由 CLI 转为 HTML 落盘）'),
    id: s('可选自定义 id')
  }, ['project', 'members']),
  T('assoc_edit', '修改关联笔记的标题/成员/正文', {
    project: s('项目名或 JSON 文件路径'), assoc_id: s('关联 id'),
    title: s('可选新标题'), members: s('可选：替换成员列表'),
    note: s('可选新正文（HTML）'), note_md: s('可选新正文（Markdown）'),
    clear_note: b('清空笔记正文')
  }, ['project', 'assoc_id']),
  T('assoc_remove', '删除关联笔记', {
    project: s('项目名或 JSON 文件路径'), assoc_id: s('关联 id')
  }, ['project', 'assoc_id']),
  T('assoc_prune', '清理「关联笔记」里已不存在的成员（修好悬挂成员导致的校验红）。默认自动找出确认不存在的成员；nodes 可限定为本项目的这些节点；dry_run=true 只报告不写盘', {
    project: s('项目名或 JSON 文件路径'),
    nodes: s('可选：只清理本项目里这些节点（逗号分隔）'),
    dry_run: b('只报告将要做的清理，不写盘')
  }, ['project']),
  T('links_prune', '清理"悬空链接"（目标节点已不存在）—— 别的项目把节点删掉后，本项目的链接会悬空并导致本项目所有写操作被校验闸门挡住；默认自动找出确认不存在的目标，nodes 可限定为指向本项目这些节点，dry_run=true 只报告不写盘', {
    project: s('项目名或 JSON 文件路径'),
    nodes: s('可选：只清理指向本项目这些节点的链接（逗号分隔）'),
    dry_run: b('只报告将要做的清理，不写盘')
  }, ['project']),
  T('theme_layout', '设置顶层主题左右分侧（meta.layout）：left/right 逗号分隔的主题 id，未列出的主题默认在右侧；clear=true 清除布局', {
    project: s('项目名或 JSON 文件路径'), left: s('放左侧的主题 id（逗号分隔）'),
    right: s('放右侧的主题 id（逗号分隔）'), clear: b('清除布局配置')
  }, ['project']),
  T('validate', '校验项目数据格式', { project: s('项目名或 JSON 文件路径') }, ['project']),
  // ---- 2026-10-09 补齐缺口（用户点名 9 条；只透传同名 CLI ✓）----
  T('stats', '项目统计：节点数 / 最大深度 / 图片数 / 链接数', {
    project: s('项目名或 JSON 文件路径')
  }, ['project']),
  T('validate_all', '校验 projects/ 下**全部**项目（结构 + 悬挂链接 + 悬挂关联成员 + 环）—— 写盘闸门挡住时先跑它定位', {}),
  T('ui_state', '界面是否有**未保存编辑**（写前协调用）：dirty 时先请用户保存，再让 AI 动笔 ✓', {
    project: s('可选，只看某个项目')
  }),
  T('add_root', '新增**顶层主题**（不选父节点，直接挂在根下）—— 一个项目里放多个不同方面的笔记', {
    project: s('项目名或 JSON 文件路径'), topic: s('顶层主题标题'), id: s('可选，见名知义的 id'),
    detail: s('可选，详情 HTML'), detail_md: s('可选，详情 Markdown（推荐；与 detail 互斥）'),
    local_path: s('可选，本机文件夹绝对路径（界面里可点开）')
  }, ['project', 'topic']),
  T('expand_depth', '按深度**规范化展开状态**（默认前 2 层展开；depth=0 = 全收起），一次原子写', {
    project: s('项目名或 JSON 文件路径'), depth: s('保留展开的层数，默认 2；0 = 全收起'),
    id: s('可选，只规范化这棵子树')
  }, ['project']),
  T('clone_node', '复制节点到新父节点（deep=true 连子树一起）—— 注意与 move_node 的区别：clone 是**新增副本**；'
    + '要拿副本上的**条目级边**（`itemEdges`：默认档逐条点名 kept/repointable/wouldBe，即"哪几条链接仍指原物"）'
    + '就传 json:true', {
    project: s('项目名或 JSON 文件路径'), id: s('源节点 id'), parent: s('新父节点 id'),
    deep: b('是否连子树一起复制'),
    json: b('返回 JSON —— 要取 `itemEdges`（副本上的条目级链接清单与"能不能重指向"）就传它；'
      + '对应 CLI 的 --json（文本档只在副本上真有这类边时多一行 ⚠）')
  }, ['project', 'id', 'parent']),
  T('remove_file', '移除节点上的**附件引用**（文件本身留不留由调用方决定；与 remove_image 对称）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), file: s('相对路径，如 attachments/x.md')
  }, ['project', 'id', 'file']),
  T('import_project', '**从大文档建一个新项目 + 一棵新树**（md / txt / docx / **带书签的 pdf**）：1 级标题成为顶层主题；一次原子写，失败不留半个项目。**同一份来源默认只导一次**（全库比来源指纹，重复会拒绝并指名是哪个项目导的）；入参是目录或读不了 ⇒ 响亮拒绝并给出路', {
    name: s('新项目名'), file: s('源文件路径（.md / .txt / .docx / 带书签的 .pdf）'),
    title: s('可选，项目标题'), dry_run: b('只预览格式/规模/前几个标题与来源指纹，不写盘（建议先跑一次）'),
    force: b('同一个来源**故意**再建一棵（默认拒绝重复导入）')
  }, ['name', 'file']),
  T('import_dir', '**整库导入：把一个文件夹的结构镜像成一棵树**（每一级子目录 = 一个容器节点，每个文件 = 该容器下的一个文件节点，标题取文件名去扩展名）。默认导 .md/.txt/.docx/.pdf/.m3u8（ext 覆盖）；隐藏文件/.git/node_modules/符号链接/空目录/无读权限/不支持的扩展名**一律跳过并逐类计数**（报告里有"导入了几个 / 跳过几个（按原因分组）"）。**目录总量没有上限**：超过单批线只按顶层子树**分批**（不是拒绝）；唯一还存在的拒绝线是文件数 max_files（默认 200，管的是"人还能不能核对"）。视频目录：.m3u8 当**入口节点**（节点字段 localPath 指向本机那份播放列表，不内嵌不拷贝），HLS 包里的分片/密钥/索引按单独一类跳过。**一次原子写**，失败不留半个项目。**幂等**：同一个目录重复导 ⇒ 整体拒绝并指名；同一个文件被别的命令导过也拒绝；确实要第二份用 force=true。**建议先 dry_run=true 预览**', {
    name: s('新项目名'),
    dir: s('源目录路径（整库导入要的是**目录**，不是单个文件）'),
    title: s('可选，项目标题（不写就用目录名）'),
    ext: s('可选，逗号分隔的扩展名列表（默认 md,txt,docx,pdf,m3u8；只许写真的能导的：md/markdown/txt/text/docx/pdf/m3u8）'),
    max_files: s('可选，允许导入的文件数上限（默认 200；超了要明确写大）'),
    dry_run: b('只出报告、**绝不写盘**（并如实报"会分几批"与"这个目录已经导过了"）'),
    force: b('同一个目录/同一个文件**故意**再导一份（默认拒绝重复导入）')
  }, ['name', 'dir']),
  T('ask', '向内嵌 DSH 提**一次性问题**（stdout 即答案）：不给 id 就是项目级提问；kind=explain|ask；effort 调思考强度；dry_run=true 只打印提示词与命令行、**不调模型**（不烧额度）', {
    project: s('项目名或 JSON 文件路径'), id: s('可选，节点 id（给了就是针对该节点提问）'),
    question: s('问题原文'), kind: s('explain（解释该节点）或 ask（自由问答），默认 explain'),
    effort: s('思考强度 low|medium|high|xhigh'), timeout: s('超时秒数'),
    dry_run: b('只打印提示词/思考强度/命令行，不调模型')
  }, ['project']),
  /* ---- 【20261048】`video_summary` → CLI `video-summary`（一层透传；判定全在 CLI 侧）----
   * 为什么**必须有**这个工具：一个用户能敲的功能，AI 也该能调到（本工程的立身之本：
   * 人用 Electron、AI 用 CLI 或 MCP）。它进的是 `TOOLS` 而不是 `MCP_GAP_DEBT` ——
   * 缺口册是「只减不增」的收敛账，拿它当"新命令的停车场"就等于把收敛这件事废掉。
   * ⚠️ 参数名是 `path` 而不是 `project`：**这是本工程唯一一个不读 `projects/` 的命令**
   * （位置参数是文件系统路径），别照着别的工具的习惯传项目名。 */
  T('video_summary', '**视频摘要**（透传 CLI `video-summary`）：三条路（字幕解析 / ffmpeg 解码 / 两者结合）+ '
    + '两档（coarse|detailed）+ **自动检测**（返回里的 `why` 会说清"凭什么选它"）。'
    + '⚠️ `path` 是**文件系统路径**（一个目录，或一份 `.m3u8`），**不是项目名** —— '
    + '这是唯一一个**不写 projects/** 的工具：不建节点、不落盘，产物只在这次返回里。'
    + 'method=auto（默认）才会自动挑；**显式指定而不可用 ⇒ 失败并说清"现在可用的是哪条"，不会悄悄换路**。'
    + 'level=coarse（默认）= 结构 + 时长（播放列表 `#EXTINF` 之和，**不需要 ffmpeg**）+ 分片数 + 是否加密 + '
    + '课程/课时层级 + 一句话主题（契约禁止解码/抽帧/起进程）；level=detailed = 再加逐段要点（带时间戳）+ '
    + '术语 + 一图读懂的层级，且**必须**有内容源（字幕或能解码且有人能读的音轨/画面）—— 没有就明确失败，'
    + '**不拿文件名硬凑**。本批 ASR 与视觉模型**未接** ⇒ 只有"有字幕"这一条能出真内容'
    + '（要点是**抽取式**：字幕原句按停顿切段取段首句，不是生成摘要）。', {
    path: s('目录或 `.m3u8` 播放列表的**绝对/相对路径**（不是项目名）'),
    method: s('可选：auto（默认，自动检测并说明为什么）| subtitle | ffmpeg | hybrid —— '
      + '显式指定而不可用时**失败**，不会换成别的路'),
    level: s('可选：coarse（默认，结构 + 时长 + 层级）| detailed（再加逐段要点 + 术语 + 一图层级）')
  }, ['path']),
  // ---- 缺口补齐结束 ----

  /* ---- 【W21】`ask_apply`：`ask-apply` 的 MCP 透传（台账 `W21` 的"工具面"那半）----
   * 为什么必须有它：`ask-apply` 是界面「写入本节点详情 / 新建子节点」两个按钮的**唯一写盘出口**，
   * 而它此前**只在 CLI 有**（本批之前 MCP 的 51 个工具里没有它）⇒ 走 MCP 的 AI（侧栏 / 外部 agent）
   * 只能看到"问出了答案"，没办法把答案**落进节点**。
   * 它的 "apply" 是**写盘**不是渲染（一次 `ctx.mutate`：`qa` 记录 + `detail` 末尾 + 可选子节点，
   * 见 `cli/commands/qa.js`）⇒ 本工具挂在 `DRY_RUN_TOOL_CMD` 里（`dry_run:true` 先审再写）。
   * 判定一条都不复制：空回答的响亮拒绝、幂等、子节点 id 冲突、`--at` 语义全在 CLI 那一处
   * ⇒ 所以 `required` 只写 `project` / `id`，**不写 answer**（空答案由 CLI 判成业务失败，
   * 而不是被这里判成"参数缺了"那种协议错误；`answer_file` 那条路也不会被 required 挡住）。
   */
  T('ask_apply', '把一次 AI 问答**落进节点**（透传 CLI `ask-apply`）—— 一次原子写完成三件事：'
    + '① 追加问答记录 `qa`（`{q,a,at,model?}`，**追加不覆盖**；完全相同的条目幂等不重复追加）；'
    + '② 把带来源标记与时间的问答追加到 `detail` 末尾（存储是 HTML）；'
    + '③ `as_child:true` 时再建一个子节点（标题取回答首行截断、详情放全文）。'
    + '**空回答会被响亮拒绝**（不许落一条空记录 —— 落空记录比报错危险得多）。'
    + '⚠️ **幂等的口径只有 `qa` 这一半**：完全相同的问答再落一次 ⇒ `duplicate:true`、`qa` 条数不变，'
    + '而 `detail` 是**流水**（`src/qa.js` 的既定语义：「重复写入必然堆叠而不互相覆盖」）⇒ 会**再叠一段**。'
    + '所以：疑似重复时**先看幂等键再决定要不要重试**，别拿"再落一次"当幂等重试（那会在正文里留两段同样的问答）。'
    + '⚠️ 这是**写类**工具：`dry_run:true` 只报告"这次会改动哪些对象"、一个字节都不写。'
    + '`at` 由调用方给（界面显示的时间 = 落盘时间）；长回答用 `answer_file` 避开命令行长度限制', {
    project: s('项目名或 JSON 文件路径'),
    id: s('节点 id（对应 CLI 的位置参数 `<id>`）：问答记在这个节点上'),
    answer: s('AI 的回答正文 —— 对应 CLI 的 --answer（与 answer_file 二选一，至少给一个非空的）'),
    answer_file: s('从文件读回答（长回答用，避开命令行长度与引号问题）—— 对应 CLI 的 --answer-file'),
    question: s('当时提的问题 —— 对应 CLI 的 --question（只记进 qa 记录与详情里那段来源标记）'),
    model: s('产出这个回答的模型名 —— 对应 CLI 的 --model（可选）'),
    at: s('这条问答的时间戳（ISO）—— 对应 CLI 的 --at；**给了它就以它为准**'
      + '（界面显示的时间 = 落盘时间），缺省取当前时间'),
    as_child: b('同时把回答**建成一个子节点** —— 对应 CLI 的 --as-child'
      + '（标题取回答首行并截断、详情放全文）'),
    child_id: s('配合 as_child：指定子节点 id —— 对应 CLI 的 --child-id（不给就由回答首行生成）')
  }, ['project', 'id']),

  /* ---- 条目层（v3）：六条写原语 + 按条目取回（契约 docs/ITEM-MODEL.md §4）----
   * 每条都是某条 CLI 命令的**透传**（不复制任何判定：去重、回放前置校验、悬挂引用检查都在 CLI 侧），
   * 参数名一律 snake_case 且与 CLI 选项**一一对应**（每个参数描述里都写明对应哪个 `--xxx`）。
   * （`item_remove` 原先**不传 `--json`**：带 `--clean-links/--clean-assoc` 时它先打一行文本再打 JSON
   *  ⇒ "半截 JSON"。**该缺陷已修**：文本形态照旧分行打印，JSON 形态把清理结果放进 `cleaned`
   *  {links:[{node,target,item?}], assoc:{touched:[{id,removed}],dropped:[id]}}，stdout 现在只有一份 JSON。）
   */
  T('item_add', '新增**一条**条目（透传 CLI `item-add`）—— 改一条不必重写整块 detail。'
    + 'md 与 html 互斥、必给其一（md 走 Markdown→HTML；表格/代码块这类富内容用 html 原样存）；'
    + '未条目化的节点会**自动条目化**（要求旧 detail 能逐字节回放，回放不了就拒绝并说明）；'
    + '同节点同 type 同正文默认拒绝并**点名那一条**，force=true 放行', {
    project: s('项目名或 JSON 文件路径'),
    id: s('节点 id（对应 CLI 的位置参数 `<节点id>`）'),
    md: s('条目正文 Markdown —— 对应 CLI 的 --md（与 html 互斥）'),
    html: s('条目正文 HTML —— 对应 CLI 的 --html（与 md 互斥；表格/代码块用它）'),
    src: s('出处：`文件:行` / `文件:行::引文` / URL / 命令 —— 对应 CLI 的 --src'),
    tags: a('条目级标签 —— 对应 CLI 的 --tags（逗号分隔）'),
    type: s('条目类型 text | rich —— 对应 CLI 的 --type（qa 条目由 ask_apply 产出，不能手写）'),
    after: s('插到该条目**之后**（必须在同一节点内）—— 对应 CLI 的 --after'),
    before: s('插到该条目**之前** —— 对应 CLI 的 --before（与 after 二选一）')
  }, ['project', 'id']),
  T('item_edit', '改写**一条**条目（透传 CLI `item-edit`）—— 只动你给的字段，回显**真的变了的字段名**。'
    + 'verified=true 时必须同时给 how（核验是三字段全必填的记录 at/by/how：**缺失 = 未核**）', {
    project: s('项目名或 JSON 文件路径'),
    id: s('节点 id（对应 CLI 的位置参数 `<节点id>`）'),
    item_id: s('条目 id（对应 CLI 的位置参数 `<itemId>`；不在该节点会指名它在哪个节点）'),
    md: s('新正文 Markdown —— 对应 CLI 的 --md（与 html 互斥）'),
    html: s('新正文 HTML —— 对应 CLI 的 --html（与 md 互斥）'),
    src: s('设置出处 —— 对应 CLI 的 --src'),
    clear_src: b('清掉出处 —— 对应 CLI 的 --clear-src'),
    tags: a('覆盖设置条目级标签 —— 对应 CLI 的 --tags'),
    clear_tags: b('清空条目级标签 —— 对应 CLI 的 --clear-tags'),
    type: s('改成 text | rich —— 对应 CLI 的 --type'),
    verified: b('给这条**写核验记录** —— 对应 CLI 的 --verified（必须同时给 how）'),
    how: s('一句话说清**怎么核的** —— 对应 CLI 的 --how（verified=true 时必给；取不到就别写）'),
    clear_verified: b('清掉核验记录（回到"未核"）—— 对应 CLI 的 --clear-verified')
  }, ['project', 'id', 'item_id']),
  T('item_remove', '删除**一条**条目（透传 CLI `item-remove`）。被 `links[].item` 或 `assoc.members[].item` '
    + '引用时**默认拒绝并逐个点名引用者**（不许静默删出悬挂引用）；clean_links / clean_assoc 才连带清理。'
    + '返回 JSON（`--json` 透传）：点名 itemId；**带清理时**清理结果在 `cleaned` 里'
    + '（`{links:[{node,target,item?}], assoc:{touched,dropped}}`）—— 于是"连带清了哪几条引用"是结构化的', {
    project: s('项目名或 JSON 文件路径'),
    id: s('节点 id（对应 CLI 的位置参数 `<节点id>`）'),
    item_id: s('条目 id（对应 CLI 的位置参数 `<itemId>`）'),
    clean_links: b('同时清掉引用了它的 links —— 对应 CLI 的 --clean-links'),
    clean_assoc: b('同时清掉引用了它的关联成员 —— 对应 CLI 的 --clean-assoc')
  }, ['project', 'id', 'item_id']),
  T('item_move', '把一条条目移到**另一个节点**（透传 CLI `item-move`）—— 一次原子写同时重渲染两侧 detail。'
    + '目标节点必须**已条目化**；只调顺序请用 item_order', {
    project: s('项目名或 JSON 文件路径'),
    id: s('源节点 id（对应 CLI 的位置参数 `<节点id>`）'),
    item_id: s('条目 id（对应 CLI 的位置参数 `<itemId>`）'),
    to: s('目标节点 id —— 对应 CLI 的 --to'),
    after: s('插到**目标节点**里该条目之后 —— 对应 CLI 的 --after'),
    before: s('插到**目标节点**里该条目之前 —— 对应 CLI 的 --before（与 after 二选一）')
  }, ['project', 'id', 'item_id', 'to']),
  T('item_order', '重排一个节点内部的条目顺序（透传 CLI `item-order`）—— `ids` 必须是该节点现有条目的'
    + '**完整排列**（只重排、不增删；少了谁/多了谁/重复了谁都会被逐项点名）', {
    project: s('项目名或 JSON 文件路径'),
    id: s('节点 id（对应 CLI 的位置参数 `<节点id>`）'),
    ids: a('条目 id 的**完整排列** —— 对应 CLI 的 --ids（CLI 要逗号分隔，这里可传数组）')
  }, ['project', 'id', 'ids']),
  T('render_detail', '按 `items` 重新渲染 `detail`（透传 CLI `render-detail`）—— **G2 判'
    + '"detail 与 items 不一致"时的唯一修法**。幂等：已一致 ⇒ changed=0。只处理**条目化节点**'
    + '（没有 items 的节点 detail 是真源，不碰）', {
    project: s('项目名或 JSON 文件路径'),
    id: s('节点 id（对应 CLI 的位置参数 `<节点id>`；与 all 二选一）'),
    all: b('重建**全部**条目化节点 —— 对应 CLI 的 --all（与 id 二选一）')
  }, ['project']),


  T('changes', '变更可见性（多路同时编辑的**事前避让**）：最近是谁、什么时候、改了哪些对象。'
    + '不带 since 时返回当前 rev/version（当作下次的锚点）；带上 since（上一次的 rev 或 version）'
    + '即回答"自那以来改了什么"。⚠ 报错表示**答不了**（锚点滑出窗口/本机无日志），'
    + '那**不等于"没有变更"** —— 别把报错当"没人动过"', {
    project: s('项目名或 JSON 文件路径'),
    since: s('锚点：上一次返回的 rev 或 version（省略 = 只看最近）')
  }),

  /* ---- 产品名册查询（`I-1` · `W18` §四）：把 `docs/FEATURES.md` §3 的**唯一权威表**透传进来 ----
   * 为什么要有这个工具：另一批（`I-3`）刚给 `S2` 加了 `mcp-gap` **反向**断言，它第一次跑就把
   * `features` 点出来了 ——「CLI 有而 MCP 无」正是 `W18` 量出的那批缺口之一（工具 52 条、
   * 命令 78 条，缺口是**今天刚量出来的真问题**），而加一条只读工具的代价极小 ⇒ 不该往上加缺口。
   * ⚠️ 不设 `json` 参数：本工具**总是**返回 JSON（见 `callTool` 那一支）—— 一个"能关掉但其实关不掉"
   *    的开关就是假开关（本工程的口径：静默 = 错觉）。 */
  T('features', '产品功能名册（**只读**，透传 CLI `features`）：代号 ↔ 中文名 ↔ 承载命令**三向互查** —— '
    + '它存在的理由是答两个问题：**Q1「这个功能现在处于什么状态」**（`W18` 量过：原先要读整节名册）'
    + '与 **Q7「这个代号指什么」**（`--code DM` 一行给出中文名 / 状态 / 承载命令）。'
    + 'grep 在**三处联合搜**（代号 / 中文名 / 该行提到的 CLI 命令名）；**0 命中会响亮列出搜过的三处**'
    + '（那不等于"没有这个功能"，也不是调用失败）。code 精确取一行：取不到 ⇒ 本工具**失败**（isError）—— '
    + '检索与精确取行是两种语义。返回里另有 `diff`：名册提到而 registry 没有的命令 / '
    + 'registry 有而名册一行都没提的命令（后者 = "一条命令回不到任何功能代号"）。'
    + '**只读**（不写盘、不记热度）；**总是返回 JSON**（键序固定、无时间戳 ⇒ 两跑逐字节相同）', {
    grep: s('在代号 / 中文名 / 该行提到的 CLI 命令名**三处联合搜**（子串、大小写不敏感）—— 对应 CLI 的 --grep'),
    code: s('按**代号**精确取一行（如 `DM`）—— 对应 CLI 的 --code；与 grep 互斥（两个一起给会被 CLI 响亮拒绝）')
  })
];

/* ---------------- 【W8】`--dry-run` 的 MCP 面：**只加参数、不新增工具**（工具数仍 51） ----------------
 * 「CLI 能做的，MCP 都能做」是 §1.3 的承诺 ⇒ W8 的开关必须在 MCP 侧也够得着，否则 CLI 报文里那句
 * "去掉 --dry-run 才会真的应用"对走 MCP 的 AI 就是一条**指不到东西的出路**（与 `--no-heat` 那次同一条理由）。
 */
/**
 * tool → CLI 命令 的**唯一映射**（只列认 `--dry-run` 的**写类**工具）。
 *
 * 一张表喂两处，故**不会漂移**（这正是不逐个 case 手写的原因）：
 *   ① `tools/list` 的 schema —— 给这些工具注入 `dry_run` 参数（模型看不见就用不上）；
 *   ② `callTool` 的转发 —— `dry_run: true` ⇒ 本工具这一拍的 argv 末尾加 `--dry-run`。
 * ⚠️ 命令名必须与 `cli/core.js` 的 `DRY_RUN_COMMANDS` 对得上 —— `tests/w8-dry-run.test.js` 机械核对
 *    （并核对工具数没变、`--dry-run` 的判定与短路仍只在 CLI 侧那一处）。
 * ⚠️ `import_json` **不在本表**（盘上没有这个项目、资源解包又不走写管道 ⇒ 给了它只会得到假报告；
 *    理由与出路在 `cli/core.js` 的 `DRY_RUN_UNSUPPORTED`，MCP 侧照旧把 CLI 的拒绝报文原样带回来）。
 */
const DRY_RUN_TOOL_CMD = {
  add_node: 'add', add_root: 'add-root', edit_node: 'edit', move_node: 'move', remove_node: 'remove',
  clone_node: 'clone', expand_depth: 'expand-depth', theme_layout: 'theme-layout',
  link_nodes: 'link', unlink_nodes: 'unlink',
  assoc_add: 'assoc-add', assoc_edit: 'assoc-edit', assoc_remove: 'assoc-remove', assoc_prune: 'assoc-prune',
  links_prune: 'links-prune',
  add_image: 'add-image', remove_image: 'remove-image', add_file: 'add-file', remove_file: 'remove-file',
  import_markdown: 'import-md', import_project: 'import-project', import_dir: 'import-dir',
  item_add: 'item-add', item_edit: 'item-edit', item_remove: 'item-remove', item_move: 'item-move',
  item_order: 'item-order', render_detail: 'render-detail',
  ask: 'ask',
  /* 【W21】`ask_apply` 是**写类**（一次 `ctx.mutate` 落 `qa` + `detail` + 可选子节点）⇒ 必须挂
   * `dry_run`（否则走 MCP 的 AI 拿不到"先审再写"这条出路，与 `--no-heat` 那次同一条理由）。 */
  ask_apply: 'ask-apply'
};
/** `dry_run` 参数的一句话说明（**一处** —— schema 注入的每个工具都印同一句，别各写一份） */
const DRY_RUN_DESC = '**只预览、不写盘**（对应 CLI 的 --dry-run）：报告"这次写盘会改动哪些对象'
  + '（个数 + 对象键清单 + 按类型的计数）"，而项目文件与变更日志**一个字节都不写**。'
  + '报告里那份清单就是真跑之后 `.changes.jsonl` 里那条 `changed` ⇒ 可以先审、再执行；'
  + '真要写就去掉这个参数。`--json` 档的返回里另有 `dryRun:true` 与 `plan`。';
TOOLS.forEach((t) => {
  if (!DRY_RUN_TOOL_CMD[t.name]) return;
  if (!t.inputSchema.properties) t.inputSchema.properties = {};
  t.inputSchema.properties.dry_run = b(DRY_RUN_DESC);
});

/* ---------------- JSON-RPC 错误码（**协议级**） ----------------
 * 边界（**只在这里判一次**，别在别处再判一遍）：
 *   · **协议级** —— 方法不存在 / 工具不存在 / 参数不合法 ⇒ JSON-RPC `error`（-32601 / -32602）。
 *     那是"你调错了"，不是"调用失败了"；报文形状必须先对，调用方（模型/宿主）才有可能据此纠正。
 *   · **业务级** —— 工具存在、参数齐全，但执行结果失败（项目不存在 / 校验失败 / 文件读不到 /
 *     CLI 退出码非 0）⇒ 仍是 `result` + `isError: true`（MCP 约定：失败内容要让模型**看见**并自行纠正）。
 *   两者混了都坏事：业务失败变协议错误 ⇒ 模型看不到失败原因，只会重复调同一个错方法；
 *   协议错误变 result ⇒ 调用方以为"工具成功返回了一段文字"。
 *   **修前实测报文**（2026-10-10）：`{"jsonrpc":"2.0","id":4,"result":"method not found: no-such-method"}`
 *   —— 未知方法回了 `result`（字符串），既没有 error 也没有 code，标准 MCP 客户端按 result 处理 ⇒ 静默。
 */
const RPC = {
  PARSE: -32700,
  METHOD_NOT_FOUND: -32601,   // 未知方法；以及 tools/call 里**未知工具名**（同一个"不存在"语义）
  INVALID_PARAMS: -32602,     // 缺必填参数 / 没给工具名 / 参数形状不对
  INTERNAL: -32603            // 服务器内部异常（本进程 bug，不是调用方的错）
};

/* ---------------- 执行：构造 mm-cli 参数并转发 ---------------- */
/**
 * 真正起 CLI 子进程的那一处（**唯一**）。
 * 导出名仍是 `runCli`（见文件末的 module.exports —— `scripts/doc-facts.js` 与单测都在用它），
 * 但**工具层**的调用走的 `callTool` 里那个同名的局部转发器（它只管"多带一个开关"，逻辑在这里）。
 */
function runCli(args) {
  const res = spawnSync(process.execPath, [CLI].concat(args), {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    // 变更日志的"谁在写"：让经 MCP 的写入记成 `mcp:<命令>`，与直连 CLI 区分开
    // （侧栏 AI / 外部 AI 大多走 MCP；事后看日志才分得清是谁动的）
    env: Object.assign({}, process.env, { MM_WRITER: 'mcp' })
  });
  const text = (res.stdout || '').trim() + (res.stderr ? '\n' + res.stderr.trim() : '');
  // mm-cli 失败时退出码非 0，且 stdout 以 "error:" 开头 —— 两重判据都查一遍
  // （历史上失败也返回 exit 0，那时只能靠前缀；现在两者一致，检查更稳）。
  if (res.status !== 0 || /^error:/.test(text)) return { ok: false, text: text || 'mm-cli exited ' + res.status };
  return { ok: true, text: text || '(empty)' };
}

/**
 * `callTool` 里那个**工具层转发器**用的名字。
 * 为什么要有这个别名：`callTool` 内部声明了一个同名的局部 `runCli`（【W8】dry-run 的唯一转发点，
 * 它要在 argv 里多带一个开关）—— 局部名会遮蔽模块级的这个函数，于是转发器改从这里回去。
 * 只起别名、不改实现 ⇒ 导出名与行为逐字不变（`scripts/doc-facts.js` 与单测都按 `runCli` 用它）。
 */
const spawnCli = runCli;

/**
 * `search_nodes` 的**共用选项拼装**（`search` 与 `search-all` 两个模式各用一次，但映射只写这一份）。
 *
 * 为什么单列：全库档（不给 `project`）与单项目档的差别**只有范围这一维**，其余参数逐字同一个语义
 * （它们最后落到同一个 `src/item-index.js` 的 `searchItems`）—— 两处各写一遍这份映射，
 * 迟早一边加参数另一边没加（那正是"同一个开关在两条路上不一样"的病）。
 *
 * ⚠️ 取值一律由 CLI 决定：这里只拼参数，**不复制**任何权重/上限（三串热度数字仍只在 `src/heat.js`）。
 * @param {object} a MCP 工具实参
 * @param {(k:string)=>string|undefined} argOf 取字符串参数的小助手（与 `callTool` 同一份）
 * @returns {string[]} 追加在位置参数之后的开关序列
 */
function searchNodeFlags(a, argOf) {
  const c = [];
  if (a.full) c.push('--full');
  if (a.tag) c.push('--tag', a.tag);
  // ---- 条目层扩参（S4）：**只增参数**，既有参数（keyword/full/tag）的语义与返回形状不变 ----
  // `item_level` 是 `--topic-only` 的**反面**：只有显式 false 才加那个开关（默认口径已是"搜条目"）
  if (a.item_level === false) c.push('--topic-only');
  if (argOf('src')) c.push('--src', argOf('src'));
  if (a.verified === true) c.push('--verified');
  if (argOf('type')) c.push('--type', argOf('type'));
  if (argOf('since')) c.push('--since', argOf('since'));
  if (a.limit !== undefined) c.push('--limit', argOf('limit'));
  if (a.max_bytes !== undefined) c.push('--max-bytes', argOf('max_bytes'));
  // ---- 逃生门（热度条第二件）：**只加这一个参数**，直通 CLI 的 `--no-heat`（同一处语义）----
  // 为什么必须有它：CLI 的坏日志报文里点名"加 --no-heat 先检索"—— 走 MCP 的调用方（AI）
  // 若传不进这个开关，那条出路就是**指不到东西的死指针**（收报错的人用不了它）。
  // ⚠️ 取值一律由 CLI 决定：MCP 侧**不复制**任何热度权重/上限（三串数字仍只在 src/heat.js）。
  if (a.no_heat === true) c.push('--no-heat');
  // ---- 【W4】混合检索：**只加三个参数**（工具数不变），直通 CLI 的同名开关 ----
  // 为什么 AI 需要它们：清单 W4 要的是"AI 才敢据此推理"——而走 MCP 的调用方若传不进 mode/weights，
  // 那套权重与归因就只对敲 CLI 的人可见（与 `--no-heat` 那次"出路是指不到东西的死指针"同一条理由）。
  // ⚠️ 取值一律由 CLI 决定：这里只拼参数，不复制任何预设权重/k/路由表（那些数字仍只在 src/palette-rank.js）。
  if (argOf('mode')) c.push('--mode', argOf('mode'));
  if (argOf('weights')) c.push('--weights', argOf('weights'));
  // 【W4b】扩召回：**只加这一个参数**（工具数不变），直通 CLI 的 `--recall`（同一处解析与上界）。
  // 为什么 AI 需要它：不扩召回时"答案只写在邻居里、正文里没有那个词"的问题**一条都搜不到**
  // （W4b 之前就是这么工作的）—— 这是"AI 不必每次上网搜"那一条在**换了个说法/只写在邻域里**时的补丁。
  if (argOf('recall')) c.push('--recall', argOf('recall'));
  if (a.explain === true) c.push('--explain');
  return c;
}

/**
 * 执行一个工具调用。
 *
 * 返回值有两种形态（**协议级 vs 业务级**的边界见上方 RPC 表的注释）：
 *   · `{ protocol: true, code, text }` —— 调用方**调错了**（未知工具 / 缺必填参数）：
 *     调用方要把它转成 JSON-RPC `error`（stdio 传输那条路会自动转）。
 *   · `{ ok, text }` —— 调用对了但结果失败/成功：`ok:false` 时走 MCP 的
 *     `result` + `isError:true`（让模型看见失败原因），**不是**协议错误 ✗。
 *
 * 必填参数由工具定义里的 `inputSchema.required` 机械核对（单一真源：schema 与判定同源，
 * 不另写一份"哪些参数必填"的清单 —— 那种副本必然漂移）。
 */
function callTool(name, args) {
  const tool = TOOLS.filter((t) => t.name === name)[0];
  if (!tool) return { protocol: true, code: RPC.METHOD_NOT_FOUND, text: 'unknown tool: ' + name };
  const a = args || {};
  const need = (tool.inputSchema && tool.inputSchema.required) || [];
  const missing = need.filter((k) => a[k] === undefined || a[k] === null || a[k] === '');
  if (missing.length) {
    return {
      protocol: true, code: RPC.INVALID_PARAMS,
      text: '缺少必填参数: ' + missing.join(', ') + '（' + name + ' 的必填项：' + need.join(', ') + '）'
    };
  }
  const argOf = (k) => (a[k] === undefined || a[k] === null) ? undefined : String(a[k]);
  /* 【W8】`--dry-run` 的**唯一转发点**：调用方传 `dry_run: true` ⇒ 本工具这一拍的 argv 末尾统一加
   * `--dry-run`（**判定与短路仍在 CLI 侧那一处**，见 cli/core.js 的 planWrite —— MCP 只搬参数，不复制逻辑）。
   * 为什么不逐个 case 加：那要写 30 遍，而漏掉的那一条会**静默降级成真写**（正是 W8 要消灭的那种病）。
   * ⚠️ 只对 `DRY_RUN_TOOL_CMD` 里登记过的工具生效 —— 与上面那次 `inputSchema.dry_run` 的注入**同一张表**
   *    ⇒ "schema 里写了、转发时漏了"这种漂移不可能发生。
   * ⚠️ `argv.indexOf('--dry-run') < 0`：case 自己已经加过时不重复（argv 里两个同义开关是噪音）。 */
  const runCli = (argv) => ((a.dry_run === true && DRY_RUN_TOOL_CMD[name] && argv.indexOf('--dry-run') < 0)
    ? spawnCli(argv.concat(['--dry-run'])) : spawnCli(argv));
  switch (name) {
    case 'projects': return runCli(['projects', '--json']);
    case 'read_project': {
      const c = ['read', argOf('project'), '--json'];
      if (a.brief) c.push('--brief');
      return runCli(c);
    }
    case 'list_nodes': return runCli(['list', argOf('project'), '--json']);
    case 'get_node': {
      // 条目层（v3）：给了 `item` 就是"按条目取回"（`get … --item`）—— 只取那一条的条目视图。
      // 不给 `item` 时这一支**逐字不变**（既有消费者看到的形状与从前完全一致）。
      if (argOf('item')) return runCli(['get', argOf('project'), argOf('id'), '--item', argOf('item'), '--json']);
      return runCli(['get', argOf('project'), argOf('id'), '--json', '--detail', '--images']);
    }
    case 'search_nodes': {
      // 选项拼装**只有一份**（`searchNodeFlags`）：两个模式（全库 / 单项目）共用它，避免"一边加了
      // 参数另一边没加"的漂移。位置参数在各自那一支里拼（关键词必须在开关之前）。
      const flags = searchNodeFlags(a, argOf);
      // ---- 【W1】不给 `project` ⇒ **扫全库**（= CLI 的 `search-all`）----
      // 为什么用"省掉 project"而不是新增一个布尔开关：`search-all` 与 `search` 的差别**只有范围这一维**
      // （其余参数逐字同一个语义），"没有指定项目"就是"全库"最自然的表达。
      // 工具数不变（51）—— 这是给既有工具**加一个模式**，不是新增工具（判据⑤：一层透传）。
      // `scope` 只在这个模式里有意义（数组 → CLI 的逗号列表）。
      if (!argOf('project')) {
        const c = ['search-all'];
        if (a.keyword) c.push(a.keyword);
        const scope = Array.isArray(a.scope) ? a.scope.join(',') : argOf('scope');
        if (scope) c.push('--scope', scope);
        return runCli(c.concat(flags, ['--json']));
      }
      // 给了 `project` ⇒ 只搜这一个项目（行为与从前**逐字相同**：同一个命令、同一组开关）
      const c = ['search', argOf('project')];
      if (a.keyword) c.push(a.keyword);
      return runCli(c.concat(flags, ['--json']));
    }
    case 'backlinks': return runCli(['backlinks', argOf('project'), argOf('id'), '--json']);
    case 'related': {
      const c = ['related', argOf('project'), argOf('id'), '--json'];
      if (a.depth !== undefined) c.push('--depth', argOf('depth'));
      return runCli(c);
    }
    case 'orphans': {
      const c = ['orphans', argOf('project'), '--json'];
      if (a.content_only) c.push('--content-only');
      if (a.limit !== undefined) c.push('--limit', argOf('limit'));
      return runCli(c);
    }
    case 'mentions': {
      const c = ['mentions', argOf('project'), '--json'];
      if (a.min_length !== undefined) c.push('--min-length', argOf('min_length'));
      if (a.include_structural) c.push('--include-structural');
      if (a.cross) c.push('--cross');
      if (a.limit !== undefined) c.push('--limit', argOf('limit'));
      return runCli(c);
    }
    case 'assets': return runCli(['assets', argOf('project'), '--json']);
    case 'add_node': {
      const c = ['add', argOf('project'), argOf('parent'), '--topic', argOf('topic')];
      if (a.id) c.push('--id', argOf('id'));
      if (a.detail) c.push('--detail', argOf('detail'));
      // AI 天然写 Markdown：detail_md 走命令内转换（存储格式是 HTML）
      if (a.detail_md) c.push('--detail-md', argOf('detail_md'));
      if (a.expanded !== undefined) c.push('--expanded', a.expanded ? 'true' : 'false');
      return runCli(c);
    }
    case 'edit_node': {
      const c = ['edit', argOf('project'), argOf('id')];
      if (a.topic) c.push('--topic', argOf('topic'));
      if (a.detail) c.push('--detail', argOf('detail'));
      if (a.detail_md) c.push('--detail-md', argOf('detail_md'));
      if (a.clear_detail) c.push('--clear-detail');
      if (a.tags) c.push('--tags', Array.isArray(a.tags) ? a.tags.join(',') : argOf('tags'));
      if (a.clear_tags) c.push('--clear-tags');
      if (a.expanded !== undefined) c.push('--expanded', a.expanded ? 'true' : 'false');
      return runCli(c);
    }
    case 'move_node': {
      const c = ['move', argOf('project'), argOf('id'), argOf('parent')];
      if (a.index !== undefined) c.push('--index', argOf('index'));
      return runCli(c);
    }
    case 'remove_node': {
      const c = ['remove', argOf('project'), argOf('id')];
      if (argOf('clean_assoc') === true) c.push('--clean-assoc');
      if (argOf('clean_links') === true) c.push('--clean-links');
      return runCli(c);
    }
    case 'import_markdown': {
      const c = ['import-md', argOf('project'), argOf('file')];
      if (a.parent) c.push('--parent', argOf('parent'));
      // 重复导入的唯一出口（默认拒绝）：与 CLI 的 --force 同一个开关，别让 MCP 侧没有出路 ✗
      if (a.force === true) c.push('--force');
      return runCli(c);
    }
    case 'export_markdown': {
      const c = ['export-md', argOf('project'), argOf('out')];
      if (a.format) c.push('--format', argOf('format'));
      if (a.with_detail) c.push('--with-detail');
      return runCli(c);
    }
    case 'export_json': {
      return runCli(['export-json', argOf('project'), argOf('out')]);
    }
    case 'export_html': {
      return runCli(['export-html', argOf('project'), argOf('out')]);
    }
    case 'import_json': {
      const c = ['import-json', argOf('file')];
      if (a.name) c.push('--name', argOf('name'));
      return runCli(c);
    }
    case 'add_image': {
      const c = ['add-image', argOf('project'), argOf('id'), '--file', argOf('file'), '--caption', argOf('caption')];
      if (a.source) c.push('--source', argOf('source'));
      if (Array.isArray(a.tags) && a.tags.length) c.push('--tags', a.tags.join(','));
      return runCli(c);
    }
    case 'remove_image': return runCli(['remove-image', argOf('project'), argOf('id'), argOf('file')]);
    case 'add_file': {
      const c = ['add-file', argOf('project'), argOf('id'), '--file', argOf('file'), '--caption', argOf('caption')];
      if (a.source) c.push('--source', argOf('source'));
      return runCli(c);
    }
    case 'files': return runCli(['files', argOf('project'), '--json']);
    case 'link_nodes': {
      const c = ['link', argOf('project'), argOf('id'), '--to', argOf('to'), '--id', argOf('to_id')];
      if (a.caption) c.push('--caption', argOf('caption'));
      return runCli(c);
    }
    case 'unlink_nodes': return runCli(['unlink', argOf('project'), argOf('id'), '--to', argOf('to'), '--id', argOf('to_id')]);
    case 'list_links': return runCli(['links', argOf('project'), '--json']);
    case 'assoc_list': {
      const c = ['assoc-list', argOf('project'), '--json'];
      if (a.node !== undefined) c.push('--node', argOf('node'));
      return runCli(c);
    }
    case 'assoc_add': {
      const c = ['assoc-add', argOf('project'), '--members', argOf('members')];
      if (a.title !== undefined) c.push('--title', argOf('title'));
      if (a.note !== undefined) c.push('--note', argOf('note'));
      if (a.note_md !== undefined) c.push('--note-md', argOf('note_md'));
      if (a.id !== undefined) c.push('--id', argOf('id'));
      return runCli(c);
    }
    case 'assoc_edit': {
      const c = ['assoc-edit', argOf('project'), argOf('assoc_id')];
      if (a.title !== undefined) c.push('--title', argOf('title'));
      if (a.members !== undefined) c.push('--members', argOf('members'));
      if (a.note !== undefined) c.push('--note', argOf('note'));
      if (a.note_md !== undefined) c.push('--note-md', argOf('note_md'));
      if (a.clear_note) c.push('--clear-note');
      return runCli(c);
    }
    case 'assoc_remove': return runCli(['assoc-remove', argOf('project'), argOf('assoc_id')]);
    case 'assoc_prune': {
      const c = ['assoc-prune', argOf('project')];
      if (argOf('nodes')) c.push('--nodes', argOf('nodes'));
      if (argOf('dry_run') === true) c.push('--dry-run');
      return runCli(c);
    }
    case 'links_prune': {
      const c = ['links-prune', argOf('project')];
      if (argOf('nodes')) c.push('--nodes', argOf('nodes'));
      if (argOf('dry_run') === true) c.push('--dry-run');
      return runCli(c);
    }
    case 'theme_layout': {
      const c = ['theme-layout', argOf('project')];
      if (a.left) c.push('--left', argOf('left'));
      if (a.right) c.push('--right', argOf('right'));
      if (a.clear) c.push('--clear');
      return runCli(c);
    }
    /* ---- 2026-10-09 补齐的 9 条（只透传同名 CLI ✓）---- */
    case 'stats': return runCli(['stats', argOf('project'), '--json']);
    case 'validate_all': return runCli(['validate-all']);
    case 'ui_state': {
      const c = ['ui-state'];
      if (a.project) c.push(argOf('project'));
      c.push('--json');
      return runCli(c);
    }
    case 'add_root': {
      const c = ['add-root', argOf('project'), '--topic', argOf('topic')];
      if (a.id) c.push('--id', argOf('id'));
      if (a.detail) c.push('--detail', argOf('detail'));
      if (a.detail_md) c.push('--detail-md', argOf('detail_md'));
      if (a.local_path) c.push('--local-path', argOf('local_path'));
      return runCli(c);
    }
    case 'expand_depth': {
      const c = ['expand-depth', argOf('project')];
      if (a.depth !== undefined) c.push('--depth', argOf('depth'));
      if (a.id) c.push('--id', argOf('id'));
      return runCli(c);
    }
    case 'clone_node': {
      const c = ['clone', argOf('project'), argOf('id'), argOf('parent')];
      if (a.deep) c.push('--deep');
      // `--json`：让 MCP 侧也能拿到 `itemEdges`（副本上的条目级边清单）。⚠️ 与 `no_heat` 同款写法：
      // 只认 `=== true`，免得 `false` 被当字符串传下去（那会让 CLI 收到一个"看起来像开关"的值）。
      if (a.json === true) c.push('--json');
      return runCli(c);
    }
    case 'remove_file': return runCli(['remove-file', argOf('project'), argOf('id'), argOf('file')]);
    case 'import_project': {
      const c = ['import-project', argOf('name'), argOf('file')];
      if (a.title) c.push('--title', argOf('title'));
      if (a.dry_run) c.push('--dry-run');
      // 与 CLI 的 --force 同一个开关（默认拒绝重复导入 ⇒ MCP 侧也必须有这条出路 ✓）
      if (a.force === true) c.push('--force');
      c.push('--json');
      return runCli(c);
    }
    case 'import_dir': {
      const c = ['import-dir', argOf('name'), argOf('dir')];
      if (a.title) c.push('--title', argOf('title'));
      if (a.ext) c.push('--ext', argOf('ext'));
      if (a.max_files !== undefined) c.push('--max-files', argOf('max_files'));
      if (a.dry_run) c.push('--dry-run');
      // 与 CLI 的 --force 同一个开关（默认拒绝重复导入 ⇒ MCP 侧也必须有这条出路 ✓）
      if (a.force === true) c.push('--force');
      c.push('--json');
      return runCli(c);
    }
    case 'ask': {
      const c = ['ask', argOf('project')];
      if (a.id) c.push(argOf('id'));
      if (a.question) c.push('--question', argOf('question'));
      if (a.kind) c.push('--kind', argOf('kind'));
      if (a.effort) c.push('--effort', argOf('effort'));
      if (a.timeout !== undefined) c.push('--timeout', argOf('timeout'));
      if (a.dry_run) c.push('--dry-run');
      c.push('--json');
      return runCli(c);
    }
    /* ---- 【20261048】`video_summary` → CLI `video-summary`（一层透传）----
     * 一律带 `--json`：调用方（模型）要的是 `{level, method, why, summary, plan, contract}` 这种结构化回执，
     * 而不是一段中文。`--method` / `--level` **只在给了才转发**（不给 = 用 CLI 的默认：auto + coarse），
     * 这样"显式指定"这条语义在两侧完全一致（不可用时 CLI 会非 0 退出并说明可用的是哪条）。 */
    case 'video_summary': {
      const c = ['video-summary', argOf('path')];
      if (a.method !== undefined) c.push('--method', argOf('method'));
      if (a.level !== undefined) c.push('--level', argOf('level'));
      c.push('--json');
      return runCli(c);
    }
    /* ---- 补齐结束 ---- */

    /* ---- 【W21】`ask_apply` → CLI `ask-apply`（一层透传；判定全在 CLI 侧）----
     * 一律带 `--json`：调用方（模型）要拿到 `{qaIndex, qaCount, duplicate, child}` 这种结构化回执，
     * 而不是一句中文（"重复写一条"与"新写了一条"必须能分辨）。
     * `dry_run` 由上面那个**唯一转发点**统一加 `--dry-run`（本 case 里不再自己加，免得两个同义开关）。 */
    case 'ask_apply': {
      const c = ['ask-apply', argOf('project'), argOf('id')];
      if (a.answer !== undefined) c.push('--answer', argOf('answer'));
      if (a.answer_file !== undefined) c.push('--answer-file', argOf('answer_file'));
      if (a.question !== undefined) c.push('--question', argOf('question'));
      if (a.model !== undefined) c.push('--model', argOf('model'));
      if (a.at !== undefined) c.push('--at', argOf('at'));
      if (a.as_child === true) c.push('--as-child');
      if (a.child_id !== undefined) c.push('--child-id', argOf('child_id'));
      c.push('--json');
      return runCli(c);
    }

    /* ---- 条目层（v3）：六条写原语（契约 docs/ITEM-MODEL.md §4）----
     * 一律 `runCli(...)` 拼参数转发；判定（去重 / 回放前置校验 / 悬挂引用检查 / 重渲染）全在 CLI 侧。
     */
    case 'item_add': {
      const c = ['item-add', argOf('project'), argOf('id')];
      if (a.md !== undefined) c.push('--md', argOf('md'));
      if (a.html !== undefined) c.push('--html', argOf('html'));
      if (a.src !== undefined) c.push('--src', argOf('src'));
      if (Array.isArray(a.tags)) c.push('--tags', a.tags.join(','));
      if (a.type !== undefined) c.push('--type', argOf('type'));
      if (a.after !== undefined) c.push('--after', argOf('after'));
      if (a.before !== undefined) c.push('--before', argOf('before'));
      if (a.force === true) c.push('--force');        // 语义去重的唯一出口（与 CLI 同一个开关）
      c.push('--json');
      return runCli(c);
    }
    case 'item_edit': {
      const c = ['item-edit', argOf('project'), argOf('id'), argOf('item_id')];
      if (a.md !== undefined) c.push('--md', argOf('md'));
      if (a.html !== undefined) c.push('--html', argOf('html'));
      if (a.src !== undefined) c.push('--src', argOf('src'));
      if (a.clear_src === true) c.push('--clear-src');
      if (Array.isArray(a.tags)) c.push('--tags', a.tags.join(','));
      if (a.clear_tags === true) c.push('--clear-tags');
      if (a.type !== undefined) c.push('--type', argOf('type'));
      if (a.verified === true) c.push('--verified');
      if (a.how !== undefined) c.push('--how', argOf('how'));
      if (a.clear_verified === true) c.push('--clear-verified');
      c.push('--json');
      return runCli(c);
    }
    case 'item_remove': {
      // `--json` 现在可以安全透传（缺陷已修，见 `cli/commands/item.js` 的 item-remove 尾段）：
      // 带 `--clean-links/--clean-assoc` 时清理结果进 `cleaned`，stdout 只此一份 JSON ——
      // 于是"连带清了哪几条引用"对调用方是**结构化**的（不再只有一行中文文本）。
      const c = ['item-remove', argOf('project'), argOf('id'), argOf('item_id')];
      if (a.clean_links === true) c.push('--clean-links');
      if (a.clean_assoc === true) c.push('--clean-assoc');
      c.push('--json');
      return runCli(c);
    }
    case 'item_move': {
      const c = ['item-move', argOf('project'), argOf('id'), argOf('item_id'), '--to', argOf('to')];
      if (a.after !== undefined) c.push('--after', argOf('after'));
      if (a.before !== undefined) c.push('--before', argOf('before'));
      c.push('--json');
      return runCli(c);
    }
    case 'item_order': {
      const ids = Array.isArray(a.ids) ? a.ids.join(',') : argOf('ids');
      return runCli(['item-order', argOf('project'), argOf('id'), '--ids', ids, '--json']);
    }
    case 'render_detail': {
      const c = ['render-detail', argOf('project')];
      if (a.all === true) c.push('--all'); else c.push(argOf('id'));
      c.push('--json');
      return runCli(c);
    }


    case 'validate': return runCli(['validate', argOf('project')]);
    case 'features': {
      // 产品名册（I-1）：只读，只搬参数（判据、别名归一、两个差集全在 `src/features-roster.js` 一处）。
      // `--json` **总是**加上：MCP 的消费者是 AI，文本档那份列对齐对它没有价值，而 `--json` 的键序固定、
      // 两跑逐字节相同 ⇒ 判定不必去解析中文（与 `changes` 同一处理）。
      const c = ['features'];
      if (argOf('grep')) c.push('--grep', argOf('grep'));
      if (argOf('code')) c.push('--code', argOf('code'));
      c.push('--json');
      return runCli(c);
    }
    case 'changes': {
      // 变更可见性（多路同时编辑的**事前避让**）：写之前先问"我要动的对象最近被谁碰过"。
      // `since` 传上一次拿到的 rev 或 version（本工具会一并回给你）⇒ 即"自那以来改了什么"。
      const c = ['changes'];
      if (args && args.project) c.push(argOf('project'));
      if (args && args.since) c.push('--since', argOf('since'));
      c.push('--json');
      return runCli(c);
    }
    default: return { protocol: true, code: RPC.METHOD_NOT_FOUND, text: 'unknown tool: ' + name };
  }
}

/* ---------------- MCP stdio 传输（逐行 JSON-RPC 2.0） ----------------
 * 仅在「作为入口直接运行」时启动：被其他脚本 require（如 scripts/doc-facts.js
 * 统计工具数）时不得占用 stdin，否则会干扰调用方的标准输入。
 */

/**
 * 处理**一拍** JSON-RPC 消息，把响应交给 `send`（纯逻辑：不读 stdin、不做 IO ⇒ 可单测）。
 *
 * 协议规定：**通知**（无 `id`）一律不响应；所以 reply/fail 都先看 id。
 * 错误分流见上方 RPC 表的注释 —— 这里只做**分流**，不重新判定业务成败。
 * @param {{id?:any, method?:string, params?:object}} msg
 * @param {(obj:object)=>void} send 收到响应对象时调用（stdio 传输里就是写一行 JSON）
 */
function handleMessage(msg, send) {
  const id = msg && msg.id;
  const reply = (result) => { if (id === undefined) return; send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => {
    if (id === undefined) return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };
  try {
    switch (msg && msg.method) {
      case 'initialize':
        return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ai-mind-map', version: VERSION } });
      case 'notifications/initialized':
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = (msg && msg.params) || {};
        // 没给工具名属于**参数非法**（-32602），不是"未知方法"：调用方连名字都没传
        if (typeof p.name !== 'string' || !p.name) {
          return fail(RPC.INVALID_PARAMS, 'tools/call 缺少工具名（params.name 必须是字符串）');
        }
        const r = callTool(p.name, p.arguments || {});
        if (r && r.protocol) return fail(r.code || RPC.INVALID_PARAMS, r.text);
        // 业务失败照旧是 result + isError:true（MCP 约定；见 RPC 表注释）
        return reply({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
      }
      case 'tools/list-changed':
        return reply({});
      default:
        return fail(RPC.METHOD_NOT_FOUND, 'method not found: ' + (msg && msg.method));
    }
  } catch (e) {
    return fail(RPC.INTERNAL, 'internal error: ' + (e && e.message));
  }
}

function startStdioServer() {
  const rl = require('readline').createInterface({ input: process.stdin });
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    handleMessage(msg, send);
  });
}

if (require.main === module) startStdioServer();

// 导出供 scripts/doc-facts.js 等工具读取（工具数/签名是文档基线的一部分）；
// `handleMessage` / `RPC` 导出是为了让协议形状能被单测直接钉住（见 tests/mcp-protocol.test.js）
module.exports = { TOOLS, callTool, runCli, startStdioServer, handleMessage, RPC, VERSION,
  // 【W8】tool → CLI 命令的映射（只列认 `--dry-run` 的写类工具）：
  // 导出是为了让 `tests/w8-dry-run.test.js` 机械核对"schema 里挂了这个参数的每个工具，
  // 它对应的 CLI 命令都真的在 `cli/core.js` 的 DRY_RUN_COMMANDS 里"（映射不许漂移）
  DRY_RUN_TOOL_CMD };
