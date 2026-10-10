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
  T('get_node', '查看节点（含路径/详情/图片）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id')
  }, ['project', 'id']),
  T('search_nodes', '搜索节点（默认标题；full=true 全文匹配 detail/图片caption/标签/链接说明；tag 按标签过滤）', {
    project: s('项目名或 JSON 文件路径'), keyword: s('关键词（与 tag 可组合）'),
    full: b('全文搜索（detail/caption/tags/链接说明）'), tag: s('按标签过滤')
  }, ['project']),
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
    expanded: b('可选，默认展开')
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
  T('import_markdown', '从 Markdown 文件导入节点（追加到 parent）。**同一份来源默认只导一次**：命令会记下来源路径 + 内容指纹，重复导入会被拒并指名上次导到哪去了；确实要第二份就 force=true', {
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
  T('clone_node', '复制节点到新父节点（deep=true 连子树一起）—— 注意与 move_node 的区别：clone 是**新增副本**', {
    project: s('项目名或 JSON 文件路径'), id: s('源节点 id'), parent: s('新父节点 id'),
    deep: b('是否连子树一起复制')
  }, ['project', 'id', 'parent']),
  T('remove_file', '移除节点上的**附件引用**（文件本身留不留由调用方决定；与 remove_image 对称）', {
    project: s('项目名或 JSON 文件路径'), id: s('节点 id'), file: s('相对路径，如 attachments/x.md')
  }, ['project', 'id', 'file']),
  T('import_project', '**从大文档建一个新项目 + 一棵新树**（md / txt / docx / **带书签的 pdf**）：1 级标题成为顶层主题；一次原子写，失败不留半个项目。**同一份来源默认只导一次**（全库比来源指纹，重复会拒绝并指名是哪个项目导的）；入参是目录或读不了 ⇒ 响亮拒绝并给出路', {
    name: s('新项目名'), file: s('源文件路径（.md / .txt / .docx / 带书签的 .pdf）'),
    title: s('可选，项目标题'), dry_run: b('只预览格式/规模/前几个标题与来源指纹，不写盘（建议先跑一次）'),
    force: b('同一个来源**故意**再建一棵（默认拒绝重复导入）')
  }, ['name', 'file']),
  T('ask', '向内嵌 DSH 提**一次性问题**（stdout 即答案）：不给 id 就是项目级提问；kind=explain|ask；effort 调思考强度；dry_run=true 只打印提示词与命令行、**不调模型**（不烧额度）', {
    project: s('项目名或 JSON 文件路径'), id: s('可选，节点 id（给了就是针对该节点提问）'),
    question: s('问题原文'), kind: s('explain（解释该节点）或 ask（自由问答），默认 explain'),
    effort: s('思考强度 low|medium|high|xhigh'), timeout: s('超时秒数'),
    dry_run: b('只打印提示词/思考强度/命令行，不调模型')
  }, ['project']),
  // ---- 缺口补齐结束 ----


  T('changes', '变更可见性（多路同时编辑的**事前避让**）：最近是谁、什么时候、改了哪些对象。'
    + '不带 since 时返回当前 rev/version（当作下次的锚点）；带上 since（上一次的 rev 或 version）'
    + '即回答"自那以来改了什么"。⚠ 报错表示**答不了**（锚点滑出窗口/本机无日志），'
    + '那**不等于"没有变更"** —— 别把报错当"没人动过"', {
    project: s('项目名或 JSON 文件路径'),
    since: s('锚点：上一次返回的 rev 或 version（省略 = 只看最近）')
  })
];

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
  switch (name) {
    case 'projects': return runCli(['projects', '--json']);
    case 'read_project': {
      const c = ['read', argOf('project'), '--json'];
      if (a.brief) c.push('--brief');
      return runCli(c);
    }
    case 'list_nodes': return runCli(['list', argOf('project'), '--json']);
    case 'get_node': return runCli(['get', argOf('project'), argOf('id'), '--json', '--detail', '--images']);
    case 'search_nodes': {
      const c = ['search', argOf('project')];
      if (a.keyword) c.push(a.keyword);
      if (a.full) c.push('--full');
      if (a.tag) c.push('--tag', a.tag);
      c.push('--json');
      return runCli(c);
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
    /* ---- 补齐结束 ---- */


    case 'validate': return runCli(['validate', argOf('project')]);
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
module.exports = { TOOLS, callTool, runCli, startStdioServer, handleMessage, RPC, VERSION };
