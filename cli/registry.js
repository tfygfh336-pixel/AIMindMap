/* ============================================================
 * cli/registry.js — 命令注册表
 * ------------------------------------------------------------
 * 每条命令：{ name, aliases, usage, desc, file, fn }
 * docs-gen 依据本表重生成 docs/CLI.md，因此新增命令必须在此登记。
 * ============================================================ */
'use strict';

const path = require('path');

const COMMANDS = [];
const BY_NAME = new Map();

function register(entry) {
  const cmd = {
    name: entry.name,
    aliases: entry.aliases || [],
    usage: entry.usage || '',
    desc: entry.desc || '',
    fn: entry.fn
  };
  if (!entry.file) {
    // 内联命令（如 init）直接从 entry.fn 使用
  }
  COMMANDS.push(cmd);
  BY_NAME.set(cmd.name, cmd);
  (cmd.aliases || []).forEach((a) => BY_NAME.set(a, cmd));
}

function loadFile(name) {
  // 按需加载命令文件，避免启动时全量 require
  return require(path.join(__dirname, 'commands', name + '.js'));
}

function get(name) {
  return BY_NAME.get(name) || null;
}

function list() { return COMMANDS.slice(); }

/* ---------------- 登记全部命令 ---------------- */
function init() {
  if (COMMANDS.length) return;

  // 项目与数据
  register({ name: 'projects', usage: '列出全部笔记项目', desc: '列出 projects/ 下全部项目（含 meta）', fn: loadFile('project').projects });
  register({ name: 'read', usage: 'read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--images]', desc: '读取项目可读视图（树 + 详情 + 图片清单）。四个变窄开关可叠加：--brief 去长文本 / --skeleton 再去 tags+links（只要结构）/ --subtree <id> 只要某棵子树 / --compact 单行 JSON；实测全叠加比全量省约 86%（`--detail` 已从此处移除：--json 默认就含详情，它在 read 上是空操作）', fn: loadFile('project').read });
  register({ name: 'list', aliases: ['tree'], usage: 'list <项目> [--json]', desc: '树形列出项目全部节点', fn: loadFile('project').list });
  register({ name: 'get', usage: 'get <项目> <id> [--json] [--detail] [--images]', desc: '查看节点（路径/详情/图片）', fn: loadFile('project').get });
  register({ name: 'search', usage: 'search <项目> <关键词|--tag 标签> [--json] [--full]', desc: '搜索节点（默认标题；--full 全文匹配 detail/图片caption/标签/链接说明；--tag 按标签过滤）', fn: loadFile('project').search });
  register({ name: 'stats', usage: 'stats <项目> [--json]', desc: '项目统计（节点数/深度/图片数/链接数）', fn: loadFile('project').stats });
  register({ name: 'init', usage: 'init <项目> [--title 标题]', desc: '创建空项目（meta + root 节点）', fn: loadFile('project').init });
  register({ name: 'backlinks', usage: 'backlinks <项目> <id> [--json]', desc: '查看节点反向链接（谁引用了我，跨项目）', fn: loadFile('relations').backlinks });
  register({ name: 'related', usage: 'related <项目> <id> [--json] [--depth 2]', desc: '查看节点相关知识点（我引用谁 + 谁引用我，双向合并去重；--depth 2 扩到两跳邻域）', fn: loadFile('relations').related });

  // 内置 AI（功能 1 的后端通道：一次性问答；--dry-run 只打印提示词、不调模型）
  register({ name: 'ask', usage: 'ask <项目> [<节点id>] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run]', desc: '向内嵌 DSH 提一个问题（走 `dsh headless` 一次性通道，stdout 即为答案）；**节点可选** —— 不给节点就是项目级提问；**思考强度可调**（解释默认 low、问答默认 medium，经 `--patch` 覆盖 `agent-default-model`，取值由模型自己声明）；自动补齐情境；--dry-run 只打印提示词/思考强度 patch/命令行、**不调用模型**', fn: loadFile('dsh-ask').ask });

  register({ name: 'theme-layout', usage: 'theme-layout <项目> [--left a,b] [--right c,d] [--clear]', desc: '设置顶层主题左右分侧（meta.layout；未列出的主题默认在右侧）', fn: loadFile('project').themeLayout });

  // 编辑
  register({ name: 'add', usage: 'add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false]', desc: '在父节点下新增子节点（--detail 为 HTML；--detail-md 为 Markdown，命令内转 HTML；--local-path 记录本机文件夹，界面点击即打开）', fn: loadFile('edit').add });
  register({ name: 'add-root', usage: 'add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径]', desc: '新增顶层主题（不选父节点，直接挂在根节点下）—— 一个项目里可放多个不同方面的笔记', fn: loadFile('edit').addRoot });
  register({ name: 'edit', usage: 'edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false]', desc: '编辑节点字段（--detail HTML / --detail-md Markdown；--tags 覆盖设置标签，逗号分隔；--local-path 记录本机文件夹供界面点击打开）', fn: loadFile('edit').edit });
  register({ name: 'move', usage: 'move <项目> <id> <新父id> [--index n]', desc: '移动节点到新父节点', fn: loadFile('edit').move });
  register({ name: 'expand-depth', usage: 'expand-depth <项目> [--depth N] [--id 子树根id]', desc: '按深度规范化展开状态（默认前 2 层展开、更深的收起；--depth 0 = 全收起），一次原子写', fn: loadFile('edit').expandDepth });
  register({ name: 'remove', aliases: ['rm'], usage: 'remove <项目> <id> [--clean-assoc] [--clean-links]', desc: '删除节点（含子树）；被关联/链接引用时需 --clean-assoc / --clean-links', fn: loadFile('edit').remove });
  register({ name: 'clone', usage: 'clone <项目> <源id> <新父id> [--deep]', desc: '复制节点到新父节点（--deep 含子树）', fn: loadFile('edit').clone });

  // 导入导出
  register({ name: 'import-md', usage: 'import-md <项目> <md文件> [--parent id]', desc: '从 Markdown 导入节点（追加到 parent）', fn: loadFile('project').importMd });
  register({ name: 'import-project', usage: 'import-project <新项目名> <文件.md|.txt|.docx> [--title 标题] [--dry-run] [--json]', desc: '功能 5a：**从大文档建一个新项目 + 一棵新树**（md/txt/docx；1 级标题成为顶层主题）；一次原子写入，失败不留半个项目；--dry-run 只预览格式/规模/前几个标题、不写盘', fn: loadFile('project').importProject });
  register({ name: 'export-md', usage: 'export-md <项目> <输出目录> [--format heading|list] [--with-detail]', desc: '导出为文件夹：<项目>.md + assets/ + attachments/（v0.16 起）', fn: loadFile('project').exportMd });
  register({ name: 'export-json', usage: 'export-json <项目> <输出.json>', desc: '导出为 aimap 单文件（图片 base64 内嵌，可移植）', fn: loadFile('project').exportJson });
  register({ name: 'export-html', usage: 'export-html <项目> <输出目录>', desc: '导出为静态站点（index.html + assets/，可分享部署；相关知识点已内联为可跳转链接）', fn: loadFile('project').exportHtml });
  register({ name: 'import-json', usage: 'import-json <aimap.json> [--name 项目名]', desc: '从 aimap 单文件导入为新项目（解包图片）', fn: loadFile('project').importJson });

  // 图片与附件
  register({ name: 'add-image', usage: 'add-image <项目> <id> --file 图片 --caption 备注 [--source 出处] [--tags a,b]', desc: '给节点添加图片（复制进 assets/）', fn: loadFile('assets').addImage });
  register({ name: 'remove-image', usage: 'remove-image <项目> <id> <相对路径 assets/x.png>', desc: '移除节点上的图片引用', fn: loadFile('assets').removeImage });
  register({ name: 'assets', usage: 'assets <项目> [--json]', desc: '列出项目全部图片及 caption', fn: loadFile('assets').assets });
  register({ name: 'add-file', usage: 'add-file <项目> <id> --file 附件 --caption 备注 [--source 出处]', desc: '给节点添加附件文件（复制进 attachments/，md/pdf 可内预览）', fn: loadFile('assets').addFile });
  register({ name: 'remove-file', usage: 'remove-file <项目> <id> <相对路径 attachments/x.md>', desc: '移除节点上的附件引用', fn: loadFile('assets').removeFile });
  register({ name: 'files', usage: 'files <项目> [--json]', desc: '列出项目全部附件及 caption', fn: loadFile('assets').files });

  // 界面控制（给**外部 AI 与内置 DSH 侧栏**用；人类用界面上的两个 ✕，不需要调它）
  // 两个方向各关一半：sidebar-only 关左页留侧栏；dsh-sidebar 留主界面关侧栏。
  register({
    name: 'sidebar-only',
    usage: 'sidebar-only <on|off>',
    desc: 'on = 只留 DSH 侧栏（关掉左边思维导图页，对话继续可用）；off = 恢复导图页。无回执即报错（界面没在跑）',
    fn: loadFile('ui')['sidebar-only']
  });
  register({
    name: 'dsh-sidebar',
    usage: 'dsh-sidebar <on|off>',
    desc: 'on = 打开侧栏 DSH；off = 关掉侧栏 DSH（连服务一起停；主界面与项目数据不受影响）。方向与 sidebar-only 相反',
    fn: loadFile('ui')['dsh-sidebar']
  });
  register({
    name: 'dsh-status',
    usage: 'dsh-status [--json]',
    desc: '**只读**诊断：侧栏实况（可见性/总占宽/窄宽模式/是否横向溢出/内核右栏与自动加宽状态）。不改状态、不含 url/token',
    fn: loadFile('ui')['dsh-status']
  });
  register({
    name: 'dsh-prefill',
    usage: 'dsh-prefill "<文本>" | dsh-prefill --file <路径> [--json]',
    desc: '把一段文本送进 DSH 侧栏的输入框（**不代替你发送** ✗ —— 侧栏按了发送才进它的会话历史）；等主进程**回执**才报成功 ✓；失败会给出原因（侧栏没开/服务没跑/找不到输入框）',
    fn: loadFile('ui')['dsh-prefill']
  });

  // 跨项目链接
  register({ name: 'link', usage: 'link <项目> <id> --to 目标项目 --id 目标id [--caption 说明]', desc: '添加跨项目链接', fn: loadFile('links').link });
  register({ name: 'unlink', usage: 'unlink <项目> <id> --to 目标项目 --id 目标id', desc: '移除跨项目链接', fn: loadFile('links').unlink });
  register({ name: 'links', usage: 'links <项目> [--json]', desc: '列出项目全部跨项目链接', fn: loadFile('links').links });
  register({ name: 'links-prune', usage: 'links-prune <项目> [--nodes a,b] [--dry-run]', desc: '清理悬空链接（目标已不存在，修好悬挂链接导致的校验红）', fn: loadFile('links').linksPrune });

  // 引用关系（backlinks / related 已在下方「引用关系」区登记，此处只加 orphans）
  register({ name: 'orphans', usage: 'orphans <项目> [--json] [--content-only] [--limit n]', desc: '关系审计：列出无任何引用关系的节点，并区分「含内容待处理」与「纯结构正常」', fn: loadFile('relations').orphans });
  register({ name: 'mentions', usage: 'mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n]', desc: '未链接提及：正文提到了某节点却没建 links（orphans 的另一半，告诉你"该往哪连"）；--cross 扫描跨项目两个方向', fn: loadFile('relations').mentions });

  // 关联笔记（N 元实体；界面里是「相关知识点」区可打开的二级页面）
  register({ name: 'assoc-list', usage: 'assoc-list <项目> [--node <id>] [--json] [--raw]', desc: '列出关联笔记（--node 只看该节点所属的；--raw 附带原始实体）', fn: loadFile('assoc').assocList });
  register({ name: 'assoc-add', usage: 'assoc-add <项目> --members a,b,c [--title 标题] [--note html | --note-md markdown] [--id id]', desc: '新增关联笔记（成员 ≥2；跨项目写 项目/节点id）', fn: loadFile('assoc').assocAdd });
  register({ name: 'assoc-edit', usage: 'assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c]', desc: '修改关联笔记的标题/成员/笔记内容', fn: loadFile('assoc').assocEdit });
  register({ name: 'assoc-remove', usage: 'assoc-remove <项目> <assocId>', desc: '删除关联笔记', fn: loadFile('assoc').assocRemove });
  register({ name: 'assoc-prune', usage: 'assoc-prune <项目> [--nodes a,b] [--dry-run]', desc: '清理关联里已不存在的成员（修好悬挂成员导致的校验红）', fn: loadFile('assoc').assocPrune });

  // 校验与工程
  register({ name: 'validate', usage: 'validate <项目|json文件>', desc: '校验项目数据格式（含悬挂链接与悬挂关联成员）', fn: loadFile('project').validate });
  register({ name: 'validate-all', usage: 'validate-all', desc: '校验 projects/ 下全部项目', fn: loadFile('project').validateAll });
  register({ name: 'ui-state', usage: 'ui-state [<项目>] [--json]', desc: '查界面是否有未保存编辑（写前协调：dirty 时先请用户保存再动笔）', fn: loadFile('project').uiState });
  register({
    name: 'changes',
    usage: 'changes [<项目>] [--since <rev|版本号>] [--json] [--limit n]',
    desc: '变更可见性（只读，多路同时编辑的**事前避让**）：最近是谁、什么时候、改了哪些对象。'
      + '--since <锚点> 回答"自这一版以来改了什么"，锚点取 `changes <项目> --json` 的 version 或 rev'
      + '（⚠ `read --json` 不含 version）。'
      + '⚠ 答不出来时**报错并非 0 退出**（锚点滑出窗口 / 本机无日志）—— 那**不等于"没有变更"**',
    fn: loadFile('changes').changes
  });
  register({ name: 'docs-gen', usage: 'docs-gen', desc: '从 registry 重生成 docs/CLI.md', fn: loadFile('release').docsGen });
  register({ name: 'release', usage: 'release [版本号] [--major|--minor|--patch]', desc: '发版：CHANGELOG 段落版 → [Unreleased] 重建 + 四处版本号同步 + README 版本锁（拒绝版本倒退）', fn: loadFile('release').release });
  register({ name: 'changelog', usage: 'changelog [--grep 关键词] [--full] [--limit n] [--json]', desc: 'CHANGELOG 窄查询（只读）：段/条目索引（行号+行数+字节）或按关键词检索正文 —— 回答「上轮改了什么」不必通读全文（体量随迭代增长，要当前值就跑 `node scripts/doc-facts.js`，别在文档里写死）', fn: loadFile('release').changelog });
  register({ name: 'dsh-caps', usage: 'dsh-caps [--json] [--grep 关键词] [--unmounted]', desc: 'DSH 能力边界（只读）：从 vendor/dsh 的装配清单 + 磁盘包目录机械读取「挂了什么/有什么」—— 防止为"其实已经有"的能力写新命令或装新插件。⚠️ 两条最易误判：host 平面 disabled:true ≠ 不可用；装配文件里没有 ≠ 不具备（包可能就在磁盘上、只是当前没挂）', fn: loadFile('release').dshCaps });
}

init();

module.exports = { register, get, list };
