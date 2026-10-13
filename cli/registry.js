/* ============================================================
 * cli/registry.js — 命令注册表
 * ------------------------------------------------------------
 * 每条命令：{ name, aliases, usage, desc, options, compatOptions, fn }
 *   `options` —— **这条命令认识的选项键**（camelCase，与 `cli/core.js` 的 parseArgs 同一套归一规则）。
 *   为什么必须逐条声明（实测缺陷，2026-10-10）：写命令原先对**不认识的选项静默忽略** ——
 *   `add <项目> root --topic X --tags aaa,bbb` 打印"已添加"、退出码 0，而盘上没有任何 tags。
 *   调用方是 AI，它把"0 + 成功话术"当依据 ⇒ 一次静默 = 一条假数据 + 一个自以为成功的 AI。
 *   危险点在 `--tags` 在 edit / add-image 上**是合法选项**，跨命令误用极其自然。
 *   现在：未知选项由 `cli/main.js` 的 dispatch **唯一一处**判定 ⇒ exit 1 + 打印支持集。
 *   `compatOptions` —— **接受但不再写进 usage 的旧写法**（有意的向后兼容，各条在代码里注明原因）。
 *   两者的区别是**文档口径**：`options` 必须出现在 usage 里；`compatOptions` 故意不出现，
 *   但**照旧能跑**（例如 read 的 `--detail`：文本模式下仍是响亮报错、--json 下是空操作）。
 *   ⚠️ 新增选项时必须**同时**改三处：usage（文档）、options（判定）、命令体（实现）——
 *   `tests/cli-options.test.js` 会核对前两者，漏一处即红（用法字符串里的 `--x` 与 options 必须一一对上）。
 * docs-gen 依据本表重生成 docs/CLI.md，因此新增命令必须在此登记。
 * ============================================================ */
'use strict';

const path = require('path');
/**
 * 访问热度的**口径单源**（`src/heat.js`）—— 注册表只从它**现取**窗口天数 / 档位数 / 日志文件名，
 * 用来拼 desc（desc 会进生成物 `docs/CLI.md`）：数字写在这里就等于抄了第二份、迟早漂移。
 */
const heatSpec = require('../src/heat.js');
/**
 * 【W8】`--dry-run` 支持集的**口径单源**（`cli/core.js` 的 `DRY_RUN_COMMANDS`）——
 * 「哪些命令认 `--dry-run`」只有那一处登记，本表**现取**（与 heatSpec 同一条纪律）：
 * 各命令在自己的 `options` 里再抄一份 `dryRun` 就等于有了第二份清单，两处必然漂移，
 * 而漂移的方向是"某条命令的开关认不认"这种**只在踩到时才可见**的差异。
 */
const coreSpec = require('./core.js');
/**
 * 【W1】跨项目检索的两条**硬上限**也照上面同一条纪律**现取**（`src/item-index.js` 才是那一类事实
 * 的唯一实现处）—— desc 会进生成物 `docs/CLI.md`，数字抄在这里就等于第二份副本。
 */
const itemIndexSpec = require('../src/item-index.js');
/**
 * 【W4】混合检索的**路由表 / 预设权重 / 平滑常数 k**也照同一条纪律**现取**（`src/palette-rank.js`
 * 才是那一类事实的唯一实现处）—— desc 会进生成物 `docs/CLI.md`，数字抄在这里就等于第二份副本、
 * 迟早漂移（而漂移的方向恰好是"AI 照着文档写的权重与实际生效的不是一批"）。
 */
const paletteSpec = require('../src/palette-rank.js');
/** 【W4】把预设表渲染成 `balanced(text=1,graph=0.5…)` 这种一行一段（**只回显，不判断**） */
function modeLine(id) {
  const w = paletteSpec.MODES[id];
  return id + '(' + paletteSpec.ROUTE_IDS.map((r) => r + '=' + w[r]).join(',') + ')';
}

/**
 * 【W4b】把**能扩召回的路由**渲染成 `graph(matchIn=near，上界 2 跳)`（**只回显，不判断**）。
 * 路由名 / 新取值名 / 跳数上界三件全部从 `src/palette-rank.js` 的 ROUTES **现取** ——
 * 抄一份进 desc 就等于第二份副本，而漂移的方向恰好是"AI 照着文档给的取值跟实际报的不一样"。
 */
function recallLine() {
  return paletteSpec.RECALL_ROUTE_IDS.map((id) => {
    const r = paletteSpec.ROUTES.filter((x) => x.id === id)[0];
    return id + '(matchIn=' + r.recallHit + '，上界 ' + r.bound + ' 跳)';
  }).join(' / ');
}

/** 【W4b】扩召回接回来的命中报的 `matchIn` 取值（从路由表现取；可能是不止一个 —— 逐路各自声明） */
function recallHitNames() {
  return paletteSpec.RECALL_ROUTE_IDS
    .map((id) => (paletteSpec.ROUTES.filter((x) => x.id === id)[0] || {}).recallHit)
    .join(' / ');
}

const COMMANDS = [];
const BY_NAME = new Map();
/** 选项键 → 认识它的命令名（用于"你是不是把它用错了命令"的提示；init 后填） */
const KNOWERS = new Map();

function register(entry) {
  const cmd = {
    name: entry.name,
    aliases: entry.aliases || [],
    usage: entry.usage || '',
    desc: entry.desc || '',
    options: entry.options || [],
    compatOptions: entry.compatOptions || [],
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

/** 选项键（camelCase）→ 命令行写法（kebab-case）：报错与 --help 都按命令行写法打印 */
function kebab(key) {
  return String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * 这条命令**认识**的全部选项键（含自动附带的输出开关）。
 *
 * `--compact` 只对"会输出 JSON 的命令"有意义（它改的是 `ctx.outJson` 的缩进与换行），
 * 所以不手写进每条命令，而是**派生**出来的 —— 手写必然漂移（本工程吃过"同一份清单多副本"的亏）。
 */
function allowedOptions(name) {
  const cmd = BY_NAME.get(name);
  if (!cmd) return [];
  const out = (cmd.options || []).concat(cmd.compatOptions || []);
  if (out.indexOf('json') >= 0 && out.indexOf('compact') < 0) out.push('compact');
  // 【W8】`--dry-run` 与前两者同一档：**派生**出来的（支持集在 cli/core.js 的 DRY_RUN_COMMANDS）。
  // 认这个开关的命令由那**一处**清单决定 ⇒ 各命令的 options 里不再各抄一份（否则就是第二份清单）。
  if (coreSpec.DRY_RUN_COMMANDS.indexOf(cmd.name) >= 0 && out.indexOf('dryRun') < 0) out.push('dryRun');
  return out;
}

/** 写进文档（usage）里的那一份：**不含** compatOptions（见文件头对两者的区分） */
function documentedOptions(name) {
  const cmd = BY_NAME.get(name);
  return cmd ? (cmd.options || []).slice() : [];
}

/** 认识某个选项的全部命令名（按注册顺序，去掉别名重复项） */
function optionKnowers(key) {
  return (KNOWERS.get(key) || []).slice();
}

/**
 * 未知选项 → 一句**能照着改**的 error 文本（纯函数 ⇒ 可单测）。
 *
 * 必须说清两件事（否则调用方只知道"错"，不知道"该写什么"）：
 *   ① 哪个选项不认识；如果它其实是**别的命令**的选项，直接点名（跨命令误用是最常见的形态）；
 *   ② 这条命令**支持哪些**选项（把支持集整份打出来）。
 */
function unknownOptionError(name, unknown) {
  const cmd = BY_NAME.get(name);
  const list0 = allowedOptions(name);
  const first = unknown[0];
  let msg = '未知选项 ' + first.token + '：' + name + ' 不认识它';
  const others = optionKnowers(first.key).filter((n) => n !== (cmd && cmd.name));
  if (others.length) msg += '（' + first.token + ' 是 ' + others.join(' / ') + ' 的选项，别用错命令）';
  if (unknown.length > 1) msg += '；另有 ' + (unknown.length - 1) + ' 个未知选项：'
    + unknown.slice(1).map((u) => u.token).join(' ');
  msg += '。' + name + ' 支持的选项：'
    + (list0.length ? list0.map((k) => '--' + kebab(k)).join(' ') : '（无）');
  if (cmd && cmd.usage) msg += '。用法：node cli/mm-cli.js ' + cmd.usage;
  return msg;
}

/**
 * 未知**短选项**（单短横线）→ 一句能照着改的 error 文本（纯函数 ⇒ 可单测）。
 *
 * 必须说清三件事（缺陷取证：`read -x` 原先报的是"项目不存在: -x" —— 原因错，会把人领到
 * 完全无关的方向上）：
 *   ① 这是**选项**写错了，不是项目名/文件名错；
 *   ② 本工程的约定是**长选项** `--xxx`（短选项只有 `-h`）；
 *   ③ 想把它当成一个"以 `-` 开头的值"传，怎么写（`--key=值`）。
 * 再附上该命令的**支持集**与用法 —— 与 `unknownOptionError` 同一口径（不知道能写什么时
 * 有正规入口：`<命令> --help`）。
 */
function unknownShortOptionError(name, tokens) {
  const cmd = BY_NAME.get(name);
  const list0 = allowedOptions(name);
  let msg = '不认识的选项 ' + tokens.join(' ') + '：本工程约定使用**长选项**（--xxx），'
    + '短选项只有 -h（= --help）';
  msg += '。要传一个以 "-" 开头的**值**，写成 `--<选项>=<值>`（如 `--topic=-x`）';
  msg += '；要把一个以 "-" 开头的文件当成位置参数，写成 `./-x.md`';
  msg += '。' + name + ' 支持的选项：'
    + (list0.length ? list0.map((k) => '--' + kebab(k)).join(' ') : '（无）');
  if (cmd && cmd.usage) msg += '。用法：node cli/mm-cli.js ' + cmd.usage;
  return msg;
}

/* ---------------- 登记全部命令 ---------------- */
function init() {
  if (COMMANDS.length) return;

  // 项目与数据
  register({ name: 'projects', usage: 'projects [--json]', options: ['json'], desc: '列出 projects/ 下全部项目（含 meta）', fn: loadFile('project').projects });
  register({ name: 'read', usage: 'read <项目> [--json] [--brief] [--skeleton] [--compact] [--subtree id] [--items <条目id,…>] [--images]', options: ['json', 'brief', 'skeleton', 'subtree', 'items', 'images'], compatOptions: ['detail'], desc: '读取项目可读视图（树 + 详情 + 图片清单）。四个变窄开关可叠加：--brief 去长文本 / --skeleton 再去 tags+links（只要结构）/ --subtree <id> 只要某棵子树 / --compact 单行 JSON；实测全叠加比全量省约 86%（`--detail` 不再写进用法但**照旧可用**：--json 下是空操作、文本模式下响亮报错并给出替代路径 —— 老调用方不会因为"它被移除了"而突然失败）。**`--items <条目id,…>` 是条目层（v3）的另一档**：只取这几条的正文，返回 `{meta,project,itemCount,items:[条目视图]}`；任一条目 id 不存在 ⇒ **整体失败并逐个点名**（不给半份），且与 --brief/--skeleton/--subtree 互斥（两种口径不混）', fn: loadFile('project').read });
  register({ name: 'list', aliases: ['tree'], usage: 'list <项目> [--json]', options: ['json'], desc: '树形列出项目全部节点', fn: loadFile('project').list });
  register({ name: 'get', usage: 'get <项目> <id> [--json] [--item <itemId>] [--detail] [--images]', options: ['json', 'item', 'detail', 'images'], desc: '查看节点（路径/详情/图片）。`--item <itemId>` 取**单条条目**（条目视图：nodeId/nodeTopic/path/itemId/type/html|qa/src/tags/at/by/verified，空值不产生噪音键）；不给它时行为同 v2，**并且**条目化节点额外带 `items` 摘要数组（`{itemId,type,src,verified,at,bytes}`，不含正文）', fn: loadFile('project').get });
  register({ name: 'search', usage: 'search <项目> <关键词|--tag 标签> [--json] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] [--mode <预设>] [--weights <路由=权重,…>] [--recall <路由>] [--explain]', options: ['json', 'topicOnly', 'tag', 'full', 'src', 'verified', 'type', 'since', 'limit', 'maxBytes', 'noHeat', 'mode', 'weights', 'recall', 'explain'], desc: '搜索（**默认口径 = 搜条目**：节点 topic ∪ 条目正文；`--topic-only` 回退 v2 只搜标题）。**命中 = 关键词是命中面的「非连续子序列」**（大小写不敏感 —— 与界面命令面板**同一个谓词、同一份打分**，`src/palette-rank.js` 是唯一实现处）：`闸门` 命中 `闸 与 门` 之间隔了字的标题，`tp` 命中 `TCP`；纯 `--tag`（无关键词）不参与这套排序。**顺序 = 那份模糊打分升序，同分保持「深度优先 + 条目序」** ⇒ 本机没有热度日志（或加 `--no-heat`）时，同一查询的节点顺序与命令面板**逐条相同**。命中形状：`{id,topic,nodeId,nodeTopic,itemId,type,itemized,matchIn,snippet,src,verified,score}`（`id`/`topic` 是 v2 兼容别名；未条目化节点 itemId=null/type=null/itemized=false；`score` 仍是**子串出现次数**，模糊命中回落 1）。过滤：`--tag`（条目级标签 → item-tag / 节点级 → node-tag；未条目化节点照 v2 报 tag）、`--src`（src 子串，字符串或数组任一项）、`--verified`（只要已核条目）、`--type`（text|rich|qa）、`--since <ISO>`（at >= ISO；不给未条目化的节点命中）；`--full` 在默认口径之上再并上 v2 的额外面（图片 caption / 节点级标签 / 链接说明）。排序：模糊打分（上面那一条）先定基线，热度（人 / AI 两条，近 30 天窗口）作为**一个封顶向量**在其上重排 —— 只重排、不改变命中与否，占总分 ≤ 8%（取值与理由的唯一一处：src/heat.js 的 SEARCH_RANK）；本机没有该日志时**不参考热度**（≠ 热度为 0，`--json` 的 heat.reason 会说明）。`--no-heat`：**显式**跳过热度日志 —— 本次调用**完全不碰它（不读、不写、不排序）**：日志坏了 / 认不出通道 / 时间乱序时这是**先拿到结果**的出口（往坏日志里再追加一条只会搅得更坏 ⇒ 写入这一半也必须一起关）；⚠ 它不改变默认档：默认遇到坏日志仍然**响亮失败**（不许静默降级成"按 0 排"）。预算：`--limit`（缺省 200，上界 1000）/ `--max-bytes`（缺省 65536，16–4194304）；`--json` 顶层 `{project,keyword,hits,hitCount,truncated,mode,budget:{bytes,estTokens,limit,maxBytes},heat:{applied,reason,weights,windowDays,rankedNodes,hitNodes,log}}`，超限截断并给续取方式（budget.resume）。非法值（含 --verified/--type/--since 写错）**当场报错**，不静默退化成默认值或"0 命中"。'
      /* 【W4】混合检索：**何时用** + "不给就逐字节不变" + 数字一律从 `src/palette-rank.js` **现取** */
      + '混合检索（**W4**）：**不给 `--mode` / `--weights` 时这一层是关的 —— 输出与从前逐字节相同**；'
      + '给了才启用，且只在**既有命中内部**重排（不增删命中、不改命中形状与 hitCount）。'
      + '`--mode`：' + Object.keys(paletteSpec.MODES).map(modeLine).join(' / ')
      + '（预设表与理由的唯一一处：src/palette-rank.js 的 MODES）。'
      + '`--weights text=1,graph=.5,…` 自己定权重：它是**完整名单**，没提到的路由权重按 0'
      + '（写在明面上，不做"在预设上偷偷覆盖"那套）；可选路由 ' + paletteSpec.ROUTE_IDS.join(' / ')
      + '—— 语义那一档 W3 未落地 ⇒ **未安装**（权重收下但不产生名次，`--explain` 里逐路点名，不静默少一路）。'
      + '`--mode` 与 `--weights` **不能同给**（预设 vs 完整名单，两种口径不混）。'
      + '融合是 **RRF**：总分 = Σ 权重/(k + 名次)，k = ' + paletteSpec.RRF_K
      + '（只吃名次 ⇒ 不含量纲、不需要归一化；k 与理由只有 src/palette-rank.js 一处）。'
      + '`--explain` 只**多给读数**、**不改排序**：文本档逐路 + 逐条列出"由哪几路贡献、各自什么排名"，'
      + '`--json` 多一个顶层 `explain:{enabled,mode,k,weights,recall,routes,hits}`（`explain.hits` 与 `hits` '
      + '逐条同长同序；命中对象**不加任何键** —— 12 键契约不动）。'
      /* 【W4b】扩召回：**何时用** + "不给就逐字节不变" + 新取值从 `src/palette-rank.js` **现取** */
      + '扩召回（**W4b**）：`--recall <路由>` —— **不给它时输出与从前逐字节相同**（候选集、`hitCount`、'
      + '`matchIn` 取值集合都不变，与 W4 那条"默认关"同一条纪律）。给了才**真的扩召回**：把'
      + '"非字面命中"（头名在有界邻域里的近邻 —— 上界就是路由表那一行的 `bound`）也接进结果 ⇒ '
      + '`hitCount` 与 `hits` **会因此变多**，新命中的 `matchIn` = 该路声明的取值（' + recallLine() + '）。'
      + '能扩召回的只有路由表里标了 `recall` 的那几路（' + paletteSpec.RECALL_ROUTE_IDS.join(' / ') + '）；'
      + '它必须与 `--mode` / `--weights` **同给**（它改变的是**候选集**，而"这批候选怎么排"是融合那一层的事 —— '
      + '只给 --recall 就等于替你偷偷挑一个默认预设）；不认识的 route / 不能扩召回的路由 / 写两遍 ⇒ **当场报错**。'
      + '硬过滤仍正交：`--tag` 与关键词照旧 AND，给了条目级过滤（--src/--verified/--type/--since）就只允许条目命中 '
      + '⇒ 扩召回不参与（它不许绕过过滤）。`--explain` 里逐路报"这次接回来几条 / 为什么是 0"（没点名的那几路也在，'
      + '标 `asked:false`）。**命中形状仍是 12 键**：本件是**开** `matchIn` 的取值表（多一个 `'
      + recallHitNames() + '`），**不是加键**。'
      + '判据与读数：`tests/search-recall.test.js`（默认档逐字节不变 / 上界来自路由表 / 硬过滤不被绕过 / '
      + '黄金集扩量给读前读后 / 注入证明 / 一处实现的静态把守），语料 `tests/fixtures/hybrid-golden.json`。', fn: loadFile('project').search });
  /* 【W1】`search-all` —— 一次检索**扫全库**（跨项目）。选项面 = `search` 那一套 + `--scope`：
   * 相同的选项在这里**逐字同一个语义**（它们逐个项目转发给同一个 `searchItems`），所以多出来的
   * 只有"范围"这一维 —— 不新增第二套过滤/排序/预算口径。两条硬上限的数字从 `src/item-index.js`
   * **现取**（desc 会进 `docs/CLI.md`；抄一份数字在这里迟早漂移）。 */
  register({ name: 'search-all', usage: 'search-all <关键词|--tag 标签> [--scope 项目名,…] [--json] [--compact] [--topic-only] [--full] [--tag <t>] [--src <s>] [--verified] [--type text|rich|qa] [--since <ISO>] [--limit <n>] [--max-bytes <n>] [--no-heat] [--mode <预设>] [--weights <路由=权重,…>] [--recall <路由>] [--explain]', options: ['json', 'topicOnly', 'tag', 'full', 'src', 'verified', 'type', 'since', 'scope', 'limit', 'maxBytes', 'noHeat', 'mode', 'weights', 'recall', 'explain'], desc: '**跨项目检索**：一次调用扫**全库**（`projects/` 下全部项目，按**项目名升序**），每条命中带 `project` —— 这是卖点 1 那句"AI 不必每次上网搜"的技术前提（从前 `search` 必须点名**单个**项目）。`--scope 项目甲,项目乙` 把范围收回来（名单里的项目不存在 ⇒ **报错并逐个点名**；`--scope` 裸写/空名单 ⇒ 报错，不静默当"全库"）；其余选项与 `search` **同一个语义**（同一条 `searchItems` 实现）：`--tag` / `--full` / `--topic-only` / `--src` / `--verified` / `--type` / `--since` / `--limit` / `--max-bytes`；**命中口径与排序口径也逐字同一条**（命中 = 关键词是命中面的**非连续子序列**；项目内顺序 = 模糊打分升序、同分保持「深度优先 + 条目序」—— 打分与定序的唯一实现在 `src/palette-rank.js`，界面命令面板吃的是同一份）。顺序 = **项目名升序 × 项目内既有顺序**（项目内与 `search <该项目>` 逐条同序，含它自己的热度榜）；**不做跨项目重排**（**热度重排**的唯一实现是 `src/item-index.js` 的 `orderByHeat`；跨项目比分数会是第二份排序实现，且 nodeId 只在项目内唯一）。热度**逐项目各算各的榜**（人 / AI 两条，窗口 ' + heatSpec.WINDOW_DAYS + ' 天，封顶见 `src/heat.js` 的 SEARCH_RANK）；`--no-heat` = `search` 的同名开关（本次完全不碰任何项目的热度日志）。两条**硬上限**（调用方改不了，越限 ⇒ **响亮报错 + 一条命中都不返回**，与"截断"是两件事）：命中总数 ' + itemIndexSpec.SCAN_MAX_HITS + ' 条、扫描耗时 ' + itemIndexSpec.SCAN_MAX_MS + ' ms（取值与报文都在 `src/item-index.js` 的 `scanGate`）。`--limit` / `--max-bytes` 是**调用方预算**：截断时如实写 `truncated` 并给续取方式。**不许静默少扫**：某个项目的**数据读不出来** ⇒ 跳过它，但在 `skipped` 里逐个点名（文本档一行 `⚠ 跳过项目「…」`，汇总行写"⚠ 另有 N 个项目没扫成"）；它的**热度日志坏了** ⇒ 整体失败并点名那个项目（与 `search` 同一条纪律，出路 `--no-heat`）。无命中时**明确报"0 条"**（不是空输出）。`--json` 顶层 `{keyword,tag,scoped,scope,scanned,skipped,hits,hitCount,truncated,mode,budget,heat:{applied,reason,weights,windowDays,rankedNodes,hitNodes,perProject}}`'
      /* 【W4】混合检索：与 `search` **同一个开关、同一处语义**（逐项目各算各的融合） */
      + '。混合检索（**W4**）：`--mode` / `--weights` / `--explain` = `search` 的同名开关'
      + '（同一处解析与同一份路由表，`src/palette-rank.js`）；**不给 `--mode` / `--weights` 时这一层是关的**'
      + '（输出与从前逐字节相同）。顺序仍是 **项目名升序 × 项目内顺序**：融合是**逐项目各算各的**'
      + '（每路的名次都是项目内的）⇒ 每个项目的分片与 `search <该项目> --mode/--weights …` 逐条同序；'
      + '**仍然不做跨项目重排**（跨项目比分数/名次会是第二份排序实现，且 nodeId 只在项目内唯一）。'
      + '`--explain` 的 `routes[].ranked` 是**跨项目合计** + 逐项目分账（名次不能跨项目相加，'
      + '所以分账也一并给），`explain.hits` 每条带 `project`'
      /* 【W4b】扩召回：与 `search` 同名同义、逐项目各算各的；`explain.recall[].added` 同样给合计 + 分账 */
      + '。扩召回（**W4b**）：`--recall <路由>` = `search` 的同名开关（同一处解析；能扩召回的是 '
      + paletteSpec.RECALL_ROUTE_IDS.join(' / ') + '，报 `matchIn` = ' + recallHitNames() + '）；'
      + '**不给它时输出与从前逐字节相同**；给了也**逐项目各算各的**（邻域是项目内的 ⇒ 每个项目的'
      + '命中与 `search <该项目> --recall …` 逐条相同）。`--explain` 的 `recall.routes[].added` '
      + '同样是**跨项目合计 + 逐项目分账**；命中形状仍是 **12 键**（开的是 `matchIn` 取值表，不是加键）',
    fn: loadFile('project').searchAll });
  register({ name: 'stats', usage: 'stats <项目> [--json]', options: ['json'], desc: '项目统计（节点数/深度/图片数/链接数）', fn: loadFile('project').stats });
  register({ name: 'init', usage: 'init <项目> [--title 标题] [--dry-run]', options: ['title'], desc: '创建空项目（meta + root 节点）', fn: loadFile('project').init });
  register({ name: 'backlinks', usage: 'backlinks <项目> <id> [--json]', options: ['json'], desc: '查看节点反向链接（谁引用了我，跨项目）', fn: loadFile('relations').backlinks });
  register({ name: 'related', usage: 'related <项目> <id> [--json] [--depth N]', options: ['json', 'depth'], desc: '查看节点相关知识点（我引用谁 + 谁引用我，双向合并去重；--depth N 扩到 N 跳邻域，N 任意正整数，防环 + 结果上限 500 条，超限响亮报错）', fn: loadFile('relations').related });

  // 内置 AI（功能 1 的后端通道：一次性问答；--dry-run 只打印提示词、不调模型）
  register({ name: 'ask', usage: 'ask <项目> [<节点id>] [--nodes a,b,c] [--question "..."] [--kind explain|ask] [--effort low|medium|high|xhigh] [--json] [--timeout 秒] [--dry-run]', options: ['json', 'question', 'kind', 'effort', 'timeout', 'nodes'], desc: '向内嵌 DSH 提一个问题（走 `dsh headless` 一次性通道，stdout 即为答案）；**节点可选** —— 不给节点就是项目级提问，--nodes 可一次问多个节点（情境逐个列出）；**思考强度可调**（解释默认 low、问答默认 medium，经 `--patch` 覆盖 `agent-default-model`，取值由模型自己声明）；自动补齐情境；--dry-run 只打印提示词/思考强度 patch/命令行、**不调用模型**', fn: loadFile('dsh-ask').ask });

  register({ name: 'theme-layout', usage: 'theme-layout <项目> [--left a,b] [--right c,d] [--clear] [--dry-run]', options: ['left', 'right', 'clear'], desc: '设置顶层主题左右分侧（meta.layout；未列出的主题默认在右侧）', fn: loadFile('project').themeLayout });

  // 编辑
  register({ name: 'add', usage: 'add <项目> <父id> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--expanded true|false] [--force] [--dry-run]', options: ['topic', 'id', 'detail', 'detailMd', 'localPath', 'expanded', 'force'], desc: '在父节点下新增子节点（--detail 为 HTML；--detail-md 为 Markdown，命令内转 HTML；--local-path 记录本机文件夹，界面点击即打开）', fn: loadFile('edit').add });
  register({ name: 'add-root', usage: 'add-root <项目> --topic 标题 [--id id] [--detail html | --detail-md markdown] [--local-path 绝对路径] [--force] [--dry-run]', options: ['topic', 'id', 'detail', 'detailMd', 'localPath', 'force'], desc: '新增顶层主题（不选父节点，直接挂在根节点下）—— 一个项目里可放多个不同方面的笔记', fn: loadFile('edit').addRoot });
  register({ name: 'edit', usage: 'edit <项目> <id> [--topic 标题] [--detail html | --detail-md markdown] [--clear-detail] [--tags a,b] [--clear-tags] [--local-path 绝对路径 | --clear-local-path] [--expanded true|false] [--dry-run]', options: ['topic', 'detail', 'detailMd', 'clearDetail', 'tags', 'clearTags', 'localPath', 'clearLocalPath', 'expanded'], desc: '编辑节点字段（--detail HTML / --detail-md Markdown；--tags 覆盖设置标签，逗号分隔；--local-path 记录本机文件夹供界面点击打开）', fn: loadFile('edit').edit });
  register({ name: 'move', usage: 'move <项目> <id> <新父id> [--index n] [--dry-run]', options: ['index'], desc: '移动节点到新父节点', fn: loadFile('edit').move });
  register({ name: 'expand-depth', usage: 'expand-depth <项目> [--depth N] [--id 子树根id] [--dry-run]', options: ['depth', 'id'], desc: '按深度规范化展开状态（默认前 2 层展开、更深的收起；--depth 0 = 全收起），一次原子写', fn: loadFile('edit').expandDepth });
  register({ name: 'remove', aliases: ['rm'], usage: 'remove <项目> <id> [--clean-assoc] [--clean-links] [--dry-run]', options: ['cleanAssoc', 'cleanLinks'], desc: '删除节点（含子树）；被关联/链接引用时需 --clean-assoc / --clean-links', fn: loadFile('edit').remove });
  register({
    name: 'clone',
    usage: 'clone <项目> <源id> <新父id> [--deep] [--repoint-items] [--json] [--dry-run]',
    options: ['deep', 'repointItems', 'json'],
    desc: '复制节点到新父节点（--deep 含子树）。副本上的**条目 id 重新签发**（全项目唯一，ITEM-MODEL §5.1），'
      + '而副本上的条目级边（`links[].item`）**默认逐字仍指原物**（引用语义，克隆不改它）——'
      + '`--json` 的 `itemEdges.kept` 会把"未被重指向"的条目级边逐条点名'
      + '（副本节点 / 边下标 / 目标 / 源条目 id，并标 `repointable`），'
      + '文本档**仅当副本上真有这类边**时多一行（没有 ⇒ 输出与从前逐字相同）。'
      + '`--repoint-items`：把它们改指**副本自己那份新条目**的**同序号**条目'
      + '（**语义改变**：引用原物 → 副本内部指涉）；对不上'
      + '（目标在别的项目 / 目标节点不在被复制范围 / 那个节点里没有这条条目）⇒ **拒绝并点名**，'
      + '**绝不按序号猜**（猜错就是换了一条边，而回显还说成功）',
    fn: loadFile('edit').clone
  });
  // 事务：操作清单一次生效（S7 实现，整合流按 `docs/ITEM-MODEL.md` §3 契约收编登记）
  register({ name: 'apply', usage: 'apply <项目> --ops-file ops.json [--dry-run]', options: ['opsFile'], desc: '按操作清单**一次事务**生效：一批改动在同一个 rev / 一次原子写 / 一条变更日志里完成 ⇒ 全成或全不动；逐条回执（应用/跳过/失败）。**只允许数据面操作**（需要外部副作用的动作必须留在事务外）。支持 `--idem <键>` 重试安全', fn: loadFile('edit').apply });
  // 条目层写原语（S2 实现，整合流按 `docs/ITEM-MODEL.md` §3 契约收编登记）
  register({ name: 'item-add', usage: 'item-add <项目> <节点id> --md "Markdown" | --html "HTML" [--src 出处] [--tags a,b] [--type text|rich] [--after itemId | --before itemId] [--force] [--dry-run]', options: ['md', 'html', 'src', 'tags', 'type', 'after', 'before', 'force'], compatOptions: ['noDedup'], desc: '新增**一条**条目（改一条不必重写整块 detail）。未条目化的节点会**自动条目化**（先把旧 detail 解析成条目，**且必须能逐字节回放**才动它）。--md 转 Markdown、--html 原样存（表格/代码块要用 --html）；同 type 同正文默认拒绝并点名，--force 放行', fn: loadFile('item').itemAdd });
  register({ name: 'item-edit', usage: 'item-edit <项目> <节点id> <itemId> [--md "Markdown" | --html "HTML"] [--src 出处 | --clear-src] [--tags a,b | --clear-tags] [--type text|rich] [--verified --how "怎么核的" | --clear-verified] [--dry-run]', options: ['md', 'html', 'src', 'clearSrc', 'tags', 'clearTags', 'type', 'verified', 'how', 'clearVerified'], desc: '改写**一条**条目（只动指定字段，回显**真的变了的字段名**）。--verified 必须同时给 --how（核验是三字段全必填的记录：at/by/how）', fn: loadFile('item').itemEdit });
  register({ name: 'item-remove', usage: 'item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc] [--dry-run]', options: ['cleanLinks', 'cleanAssoc'], desc: '删除**一条**条目。被 links[].item / assoc.members[].item 引用时**默认拒绝并逐个点名**，显式 --clean-links / --clean-assoc 才连带清理（不许静默删出悬挂引用）', fn: loadFile('item').itemRemove });
  register({ name: 'item-move', usage: 'item-move <项目> <节点id> <itemId> --to 目标节点id [--after itemId | --before itemId] [--dry-run]', options: ['to', 'after', 'before'], desc: '把一条条目移到**另一个节点**（一次原子写同时重渲染两侧 detail）。目标节点必须已条目化；只调顺序请用 item-order', fn: loadFile('item').itemMove });
  register({ name: 'item-order', usage: 'item-order <项目> <节点id> --ids i-a,i-b,… [--dry-run]', options: ['ids'], desc: '重排条目顺序（--ids 必须是该节点现有条目的**完整排列**；只重排、不增删）', fn: loadFile('item').itemOrder });
  register({ name: 'render-detail', usage: 'render-detail <项目> <节点id> | --all [--dry-run]', options: ['all'], desc: '按 items 重新渲染 detail（**G2 判"detail 与 items 不一致"时的唯一修法**）。幂等：已一致 ⇒ 实际变化 0。只处理条目化节点（没有 items 的节点 detail 是真源，不碰）', fn: loadFile('item').renderDetail });

  // 条目层复校与体检（S4 实现，整合流按契约收编登记）
  register({ name: 'recheck', usage: 'recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json] [--write-verified --how "怎么核的"] [--dry-run]', options: ['src', 'only', 'limit', 'root', 'json', 'writeVerified', 'how'], desc: '条目层复校：逐条点名 `ok` / `needs-recheck` / `src-gone` 与原因，并给出可执行的下一步。只读是默认；写回 `verified{at,by,how}` 必须显式 `--write-verified --how`，且**写回目标是「出处这一维判得过」**（判不过就不写并点名原因）', fn: loadFile('recheck').recheck });
  register({ name: 'health', usage: 'health [<项目>] [--project 项目名] [--all] [--root 目录] [--json]', options: ['project', 'all', 'root', 'json'], desc: '条目层体检（**真值出口**，不是门禁）：条目化/总数、type 分布、`items ↔ detail` 不一致（逐节点点名）、悬挂引用、`qa` 残留、**迁移五档**（可迁移/已条目化/无内容/不在范围/**跳过**，跳过项逐节点点名 + 原因分布）。确定性：两次 `--json` 逐字节相同，不带运行时刻', fn: loadFile('health').health });

  // 条目层迁移（S1 实现，整合流按 `docs/ITEM-MODEL.md` §6 契约收编登记）
  register({
    name: 'migrate',
    usage: 'migrate items <项目> [--dry-run] [--json]',
    options: ['json'],
    desc: '把 v2 节点的 detail **无损**迁成条目层 items（v2 → v3）：只迁"能逐字节回放"的节点，'
      + '其余整节点跳过并逐条点名（不许"修一下再写"）；`qa[]` 收敛成 `type:\'qa\'` 条目后删掉 `qa` 键；'
      + '写盘前自动 `export-json` 一份到 `.review/<日期>-条目层迁移/` 并打印绝对路径（**没有跳过备份的开关**）；'
      + '`meta.formatVersion` → 3（validate 同时接受 2 与 3）。幂等：第二次跑 `changed:{nodes:0,items:0}`',
    fn: loadFile('migrate').migrate
  });

  // AI 问答落盘（界面「写入本节点详情 / 新建子节点」两个动作的唯一出口；写操作只经 CLI）
  register({
    name: 'ask-apply',
    usage: 'ask-apply <项目> <id> --answer "回答" [--question "提问"] [--model 模型] [--at ISO时间] '
      + '[--answer-file 路径] [--as-child] [--child-id id] [--json] [--dry-run]',
    options: ['answer', 'question', 'model', 'at', 'answerFile', 'asChild', 'childId', 'json'],
    desc: '把一次 AI 问答落进节点（**一次原子写**完成三件事）：追加 `qa` 记录（`{q,a,at,model?}`，'
      + '追加不覆盖、完全相同的条目幂等）、把带来源标记与时间的问答追加到 detail 末尾（HTML 存储）、'
      + '`--as-child` 时再建一个子节点（标题取回答首行截断、详情放全文）。'
      + '空回答**响亮拒绝**（不许落一条空记录）。`--at` 由调用方给（界面上显示的时间就是落盘时间）',
    fn: loadFile('qa').askApply
  });

  // 导入导出
  register({ name: 'import-md', usage: 'import-md <项目> <md文件> [--parent id] [--force] [--dry-run]', options: ['parent', 'force'], desc: '从 Markdown 导入节点（追加到 parent）。**第一个标题之前的正文（前导正文）不会丢**，落点由父节点决定：父节点**没有 `items`** ⇒ 前置进它的 `detail`（`前导 + \\n + 原 detail`，原有内容一个字节都不覆盖）；父节点**有 `items`**（已条目化）⇒ 作为**首条条目**插进 `items[0]`，`detail` 随之按 `renderDetail(items)` 重建（条目化节点上 `detail` 是派生缓存，真源是 `items`）。父节点已是**坏数据**（`detail` 与 `renderDetail(items)` 不一致）或 `items` 不是数组时**响亮拒绝并给出两条真出路**（换父节点 / 先 `item-add` 再导），盘上零改动 —— 规则全文见 docs/ITEM-MODEL.md §2.1。**同一份来源默认只导一次**：本命令会给导入的子树的根写上 `origin`（来源路径 + 内容指纹，见 docs/DATA-FORMAT.md §2.8），再次导入同一 `src`+`sha256` 会**被拒并指名**上一次导到哪去了 —— 真的想要第二份就加 `--force`（那是有意的重复，不是手滑）。`--dry-run` 与真跑**同一份判据**（写盘前校验也一起跑：预览说能成 ⇒ 真跑必能成，真跑必失败 ⇒ 预览也必失败）', fn: loadFile('project').importMd });
  register({ name: 'import-project', usage: 'import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--json] [--force]', options: ['title', 'json', 'force'], desc: '功能 5a：**从大文档建一个新项目 + 一棵新树**（md/txt/docx；PDF **有书签走书签、无书签自动回退文字层**，两样都没有才响亮拒绝）；1 级标题成为顶层主题；一次原子写入，失败不留半个项目；--dry-run 只预览格式/规模/前几个标题与来源、不写盘（并如实报"这份文档已经导过了"）；入参是**目录**或路径读不了时**响亮拒绝并给出路**；**同一份来源默认只导一次**（`origin.src`+`origin.sha256` 全库比对，重复会拒绝并指名是哪个项目导的）—— 真的想再建一棵就加 `--force`', fn: loadFile('project').importProject });
  register({ name: 'import-dir', usage: 'import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] [--max-files N] [--dry-run] [--json] [--force]', options: ['title', 'ext', 'maxFiles', 'json', 'force'], desc: '批 5：**整库导入 —— 把一个文件夹的结构镜像成一棵树**（每一级子目录 = 一个容器节点，每个文件 = 该容器下的一个文件节点，标题取**文件名去扩展名**，文档自己的标题在它下面）。默认导 `.md/.txt/.docx/.pdf`（`--ext` 覆盖，只许写真的能导的扩展名）；隐藏文件/`.git`/`node_modules`/符号链接/空目录/无读权限/不支持的扩展名**一律跳过并逐类计数**（报告给"导入了 N 个文件 / 跳过 M 个（按原因分组）"，**不许静默**）；上限：合计 `MAX_SOURCE_MB`（与单文件闸门共用一份常量）+ 文件数 `--max-files`（默认 200），**超限在写盘之前响亮拒绝并给出路**；**一次原子写**，失败不留半个项目；`--dry-run` 只出报告、绝不写盘（并如实报超限与"这个目录已经导过了"）；**幂等**：项目根记**目录清单指纹**（同一个目录重复导 ⇒ **整体拒绝**并指名）、每个文件节点记自己的来源指纹（同一个文件被别的命令导过也拒绝）—— 确实要第二份就加 `--force`', fn: loadFile('project').importDir });
  register({ name: 'export-md', usage: 'export-md <项目> <输出目录> [--format heading|list] [--with-detail]', options: ['format', 'withDetail'], desc: '导出为文件夹：<项目>.md + assets/ + attachments/（v0.16 起）', fn: loadFile('project').exportMd });
  register({ name: 'export-json', usage: 'export-json <项目> <输出.json>', options: [], desc: '导出为 aimap 单文件（图片 base64 内嵌，可移植）', fn: loadFile('project').exportJson });
  register({ name: 'export-html', usage: 'export-html <项目> <输出目录>', options: [], desc: '导出为静态站点（index.html + assets/，可分享部署；相关知识点已内联为可跳转链接）', fn: loadFile('project').exportHtml });
  register({ name: 'import-json', usage: 'import-json <aimap.json> [--name 项目名]', options: ['name'], desc: '从 aimap 单文件导入为新项目（解包图片）', fn: loadFile('project').importJson });

  // 图片与附件
  register({ name: 'add-image', usage: 'add-image <项目> <id> --file 图片 --caption 备注 [--source 出处] [--tags a,b] [--dry-run]', options: ['file', 'caption', 'source', 'tags'], desc: '给节点添加图片（复制进 assets/）', fn: loadFile('assets').addImage });
  register({ name: 'remove-image', usage: 'remove-image <项目> <id> <相对路径 assets/x.png> [--dry-run]', options: [], desc: '移除节点上的图片引用', fn: loadFile('assets').removeImage });
  register({ name: 'assets', usage: 'assets <项目> [--json]', options: ['json'], desc: '列出项目全部图片及 caption', fn: loadFile('assets').assets });
  register({ name: 'add-file', usage: 'add-file <项目> <id> --file 附件 --caption 备注 [--source 出处] [--dry-run]', options: ['file', 'caption', 'source'], desc: '给节点添加附件文件（复制进 attachments/，md/pdf 可内预览）', fn: loadFile('assets').addFile });
  register({ name: 'remove-file', usage: 'remove-file <项目> <id> <相对路径 attachments/x.md> [--dry-run]', options: [], desc: '移除节点上的附件引用', fn: loadFile('assets').removeFile });
  register({ name: 'files', usage: 'files <项目> [--json]', options: ['json'], desc: '列出项目全部附件及 caption', fn: loadFile('assets').files });

  // 界面控制（给**外部 AI 与内置 DSH 侧栏**用；人类用界面上的两个 ✕，不需要调它）
  // 两个方向各关一半：sidebar-only 关掉导图页（**真卸载这一页**）留侧栏；dsh-sidebar 留主界面关侧栏。
  register({
    name: 'sidebar-only',
    usage: 'sidebar-only <on|off> [--json]',
    options: ['json'],
    desc: 'on = 关掉左边思维导图页（**真卸载这一页**：内存释放、主窗口只剩占位页），DSH 侧栏继续可用；'
      + 'off = 重新加载导图页（回到上次的项目与侧栏停靠宽度）。⚠️ 有未保存编辑时 on 会被**拒绝**'
      + '（报错带原因、不弹模态框）—— 先让人保存，或让人点界面上的 ✕（那条路会先问「保存后关闭」）。无回执即报错（界面没在跑）',
    fn: loadFile('ui')['sidebar-only']
  });
  register({
    name: 'dsh-sidebar',
    usage: 'dsh-sidebar <on|off> [--json]',
    options: ['json'],
    desc: 'on = 打开侧栏 DSH；off = 关掉侧栏 DSH（连服务一起停、侧栏视图**销毁**；主界面与项目数据不受影响）。方向与 sidebar-only 相反',
    fn: loadFile('ui')['dsh-sidebar']
  });
  register({
    name: 'dsh-status',
    usage: 'dsh-status [--json]',
    options: ['json'],
    desc: '**只读**诊断：侧栏实况（可见性/总占宽/窄宽模式/是否横向溢出/内核右栏与自动加宽状态）。不改状态、不含 url/token',
    fn: loadFile('ui')['dsh-status']
  });
  register({
    name: 'dsh-prefill',
    usage: 'dsh-prefill "<文本>" | dsh-prefill --file <路径> [--json]',
    options: ['file', 'json'],
    desc: '把一段文本送进 DSH 侧栏的输入框（**不代替你发送** ✗ —— 侧栏按了发送才进它的会话历史）；等主进程**回执**才报成功 ✓；失败会给出原因（侧栏没开/服务没跑/找不到输入框）',
    fn: loadFile('ui')['dsh-prefill']
  });

  // 跨项目链接
  register({ name: 'link', usage: 'link <项目> <id> --to 目标项目 --id 目标id [--item 目标条目id] [--caption 说明] [--dry-run]', options: ['to', 'id', 'item', 'caption'], desc: '添加跨项目链接（`--item` ⇒ 边指向**目标节点里的某一条条目**，即 `{project,id,item}`）。**重复添加同一条边**（同项目/同目标/同条目）分三种结局，回显可分辨：省略 --caption/--item ⇒ **保留**原有值（幂等，回显「无变化」且不写盘）；显式给新值 ⇒ **覆盖**（回显「已更新链接」并写出 旧 → 新）；显式 `--caption ""` / `--item ""` ⇒ **清空**那一层（回显「已更新链接（caption 清空 / item 清空）」）。⚠️ 只写 `--caption` / `--item` 不给值会被**响亮拒绝**；目标节点在、但 `--item` 那条条目不在 ⇒ **拒绝并点名**（绝不造出"节点在、条目不在"的悬挂引用）。⚠️ **人手里敲不出"显式空串"**：PowerShell 会把裸 `""` 从 argv 里**抹掉** ⇒ `--caption ""` / `--item ""` 根本到不了命令（实测：argv 里只剩 `--caption` / `--item`，被解析成 `true`，随后被上面那条**响亮拒绝**）。要清空请用**等号形式** `--caption=` / `--item=`（PowerShell 里**加引号没用** —— 实测 `""` 同样被抹掉）。这是**外壳**（shell）的行为，**不是**本命令的行为：命令本身照旧支持"显式空串 = 清空"', fn: loadFile('links').link });
  register({ name: 'unlink', usage: 'unlink <项目> <id> --to 目标项目 --id 目标id [--dry-run]', options: ['to', 'id'], desc: '移除跨项目链接（指向该目标的边一律移除，含条目级的）', fn: loadFile('links').unlink });
  register({ name: 'links', usage: 'links <项目> [--json]', options: ['json'], desc: '列出项目全部跨项目链接（条目级的边多 `item` 字段并写成 `目标/节点#条目`；`--json` 另有 `itemEdges` 计数 —— **只增字段**，节点级的边形状不变）', fn: loadFile('links').links });
  register({ name: 'links-prune', usage: 'links-prune <项目> [--nodes a,b] [--items a#i-1,b#i-2] [--dry-run]', options: ['nodes', 'items'], desc: '清理悬空链接（目标已不存在，修好悬挂链接导致的校验红）。**条目级与节点级同一处判据**：节点整个不在了、或**节点还在但那一条条目已被删**，都会被抓出来剪掉，并在报告里**分开点名**（后者单独列出）；`--items 节点id#条目id` 是等价的精确档。`--nodes a,b` 是**按节点 id 的强力档**：**不比对项目名** ⇒ 链接指向**别的项目**里同名 id 的节点时**也照样剪**（删节点时正是要这个），且**含**精确指到它某一条目的边（即"含条目级"）', fn: loadFile('links').linksPrune });

  // 引用关系（backlinks / related 已在下方「引用关系」区登记，此处只加 orphans）
  register({ name: 'orphans', usage: 'orphans <项目> [--json] [--content-only] [--limit n]', options: ['json', 'contentOnly', 'limit'], desc: '关系审计：列出无任何引用关系的节点，并区分「含内容待处理」与「纯结构正常」', fn: loadFile('relations').orphans });
  register({ name: 'mentions', usage: 'mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n]', options: ['json', 'minLength', 'includeStructural', 'cross', 'limit'], desc: '未链接提及：正文提到了某节点却没建 links（orphans 的另一半，告诉你"该往哪连"）；--cross 扫描跨项目两个方向', fn: loadFile('relations').mentions });

  // 关联笔记（N 元实体；界面里是「相关知识点」区可打开的二级页面）
  register({ name: 'assoc-list', usage: 'assoc-list <项目> [--node <id>] [--json] [--raw]', options: ['node', 'json', 'raw'], desc: '列出关联笔记（--node 只看该节点所属的；--raw 附带原始实体）', fn: loadFile('assoc').assocList });
  register({ name: 'assoc-add', usage: 'assoc-add <项目> --members a,b,c [--title 标题] [--note html | --note-md markdown] [--id id] [--force] [--dry-run]', options: ['members', 'title', 'note', 'noteMd', 'id', 'force'], desc: '新增关联笔记（成员 ≥2；跨项目写 项目/节点id）', fn: loadFile('assoc').assocAdd });
  register({ name: 'assoc-edit', usage: 'assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md markdown] [--clear-note] [--members a,b,c] [--dry-run]', options: ['title', 'note', 'noteMd', 'clearNote', 'members'], desc: '修改关联笔记的标题/成员/笔记内容', fn: loadFile('assoc').assocEdit });
  register({ name: 'assoc-remove', usage: 'assoc-remove <项目> <assocId> [--dry-run]', options: [], desc: '删除关联笔记', fn: loadFile('assoc').assocRemove });
  register({ name: 'assoc-prune', usage: 'assoc-prune <项目> [--nodes a,b] [--dry-run]', options: ['nodes'], desc: '清理关联里已不存在的成员（修好悬挂成员导致的校验红）', fn: loadFile('assoc').assocPrune });

  // 校验与工程
  register({ name: 'validate', usage: 'validate <项目|json文件> [--json]', options: ['json'], desc: '校验项目数据格式（含悬挂链接与悬挂关联成员）', fn: loadFile('project').validate });
  register({ name: 'validate-all', usage: 'validate-all', options: [], desc: '校验 projects/ 下全部项目', fn: loadFile('project').validateAll });
  register({ name: 'ui-state', usage: 'ui-state [<项目>] [--json]', options: ['json'], desc: '查界面是否有未保存编辑（写前协调：dirty 时先请用户保存再动笔）', fn: loadFile('project').uiState });
  register({
    name: 'changes',
    usage: 'changes [<项目>] [--since <rev|版本号>] [--json] [--limit n]',
    options: ['since', 'json', 'limit'],
    desc: '变更可见性（只读，多路同时编辑的**事前避让**）：最近是谁、什么时候、改了哪些对象。'
      + '--since <锚点> 回答"自这一版以来改了什么"，锚点取 `changes <项目> --json` 的 version 或 rev'
      + '（⚠ `read --json` 不含 version）。'
      + '⚠ 答不出来时**报错并非 0 退出**（锚点滑出窗口 / 本机无日志）—— 那**不等于"没有变更"**',
    fn: loadFile('changes').changes
  });

  // 访问热度（热度条第一件：先只做"能读出来" —— 事件日志 + 窗口/排名口径 + 读出来，不碰检索与界面）
  // ⚠️ 窗口天数与档位数**从 `src/heat.js` 现取**（那是唯一一处定义）⇒ 改常量，用法里的数字跟着变，
  //    不会出现"文档写 30 天、代码算 7 天"这种第二份副本。
  register({
    name: 'visit',
    usage: 'visit <项目> <节点id> --channel <通道> [--json]',
    options: ['channel', 'json'],
    desc: '记一次**访问事件**（旁路日志 `' + heatSpec.FILE_NAME + '`，一行一条 JSON、不进 export-json、可随时删；'
      + '**O(1) 追加**：只多写一行，不读全量、不重写文件）。「谁（人/AI）」由 `--channel` 决定，'
      + '**不许调用方自报**；通道权重表只有一处（`src/heat.js` 的 `CHANNELS`），未知通道**响亮拒绝**。'
      + '时间取**写入时刻**（一次访问不该有两个时间 ⇒ 本命令没有 `--at`）。合法通道与权重见报错报文',
    fn: loadFile('heat').visit
  });
  register({
    name: 'heat',
    usage: 'heat <项目> [--json] [--limit <n>] [--node <id>] [--derived <summary|keys>]',
    options: ['json', 'limit', 'node', 'derived'],
    desc: '访问热度（只读，**热度条第一件**）：人 / AI 两条榜 + 每节点热度值 + **窗口内样本量**。'
      + '窗口 = 最近 ' + heatSpec.WINDOW_DAYS + ' 天（滚动）；排名在「窗口内被访问过的节点」这个**子集内**做'
      + '（零访问节点不进榜、不参与分位）；热度是**名次**的十档位置（1–' + heatSpec.HEAT_BANDS + '），'
      + '**与次数的绝对值无关**（次数 ×10 而名次不变 ⇒ 热度不变）。AI 侧按通道**加权**（权重表见 '
      + '`src/heat.js` 的 `CHANNELS`），人侧只算「打开详情框」。'
      + '`--derived summary|keys`（**只在 `--json` 里**）另给 **AI 侧的隐藏维度**：`tags` / `sections` / '
      + '`trees` 三组，**全部由节点热度派生**（不是各记一套），每维带 `nodes/visited/events` 样本量；'
      + '`keys` 是最省的一档（只要维度名）。**界面不显示这些维度**（渲染层只画节点自己的两条热度条）。'
      + '每维至多列 20 项（**只截显示**，名次与档位一律按全量算；`total`/`truncated`/`keys` 仍是全量读数）。'
      + '`--node <id>`（**只在 `--json` 里**）另给**这一个节点**的读数 `node`：'
      + '`{heat,bands,rank,visits,listed,reason,sample}` —— 界面两条热度条读的就是它，'
      + '折算（名次→档位→该亮几格）只有一处（`src/heat.js` 的 `heatProfile`）；'
      + '**按全量排名算，不受 `--limit` 影响**（被访问过但没进显示窗口的节点也能取到）。'
      + '⚠ 日志损坏 / 认不出的通道 / 时间乱序 / 未来时间戳 ⇒ **报错并非 0 退出并点名**（不静默当 0）；'
      + '本机没有该日志 ⇒ 明说"没有访问日志"，**不等于"热度为 0"**。`--limit` 只截断显示，'
      + '热度一律按全量排名算',
    fn: loadFile('heat').heat
  });
  register({ name: 'docs-gen', usage: 'docs-gen', options: [], desc: '从 registry 重生成 docs/CLI.md', fn: loadFile('release').docsGen });
  register({ name: 'release', usage: 'release [版本号] [--major|--minor|--patch]', options: ['major', 'minor', 'patch'], desc: '发版：CHANGELOG 段落版 → [Unreleased] 重建 + 四处版本号同步 + README 版本锁（拒绝版本倒退）', fn: loadFile('release').release });
  register({ name: 'changelog', usage: 'changelog [--grep 关键词] [--full] [--limit n] [--json]', options: ['grep', 'full', 'limit', 'json'], desc: 'CHANGELOG 窄查询（只读）：段/条目索引（行号+行数+字节）或按关键词检索正文 —— 回答「上轮改了什么」不必通读全文（体量随迭代增长，要当前值就跑 `node scripts/doc-facts.js`，别在文档里写死）', fn: loadFile('release').changelog });
  register({ name: 'dsh-caps', usage: 'dsh-caps [--json] [--grep 关键词] [--unmounted]', options: ['json', 'grep', 'unmounted'], desc: 'DSH 能力边界（只读）：从 vendor/dsh 的装配清单 + 磁盘包目录机械读取「挂了什么/有什么」—— 防止为"其实已经有"的能力写新命令或装新插件。⚠️ 两条最易误判：host 平面 disabled:true ≠ 不可用；装配文件里没有 ≠ 不具备（包可能就在磁盘上、只是当前没挂）', fn: loadFile('release').dshCaps });

  // 选项键 → 认识它的命令（跨命令误用的提示用；放在最后统一建，避免遗漏）
  COMMANDS.forEach((c) => {
    (c.options || []).forEach((k) => {
      const arr = KNOWERS.get(k) || [];
      if (arr.indexOf(c.name) < 0) arr.push(c.name);
      KNOWERS.set(k, arr);
    });
  });
}

init();

module.exports = {
  register, get, list, allowedOptions, documentedOptions,
  unknownOptionError, unknownShortOptionError, optionKnowers, kebab
};
