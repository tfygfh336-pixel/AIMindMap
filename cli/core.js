/* ============================================================
 * cli/core.js — CLI 共享上下文
 * ------------------------------------------------------------
 * 给每个命令一个 ctx：
 *   - store       DataStore（projects 根目录）
 *   - args        yargs 风格解析后的参数对象
 *   - projectName 首个位置参数（若存在）
 *   - read()      读取当前项目 { file, data }
 *   - write(data) 写回项目（过 schema 校验闸门）
 *   - mutate(fn)  读 → 改 → 写；**并发时可安全自动重放**（多路同时编辑的入口，见 src/concurrency.js）
 *   - root        当前项目 data.data（根节点）
 *   - find(id)    在树中查找节点
 *   - out(text)   stdout 输出
 *   - outJson(obj)  --json 时 JSON.stringify 输出
 *   - error(msg)  输出 error: 前缀并终止
 *   - idemKey     `--idem <键>` 的键（没给 = null）
 *   - replayCheck()  幂等守卫：这个键已经写成功过就**不再执行**、直接回放首次结果
 *   - setIdemResult(text) 显式声明"这次执行的回显"（不给则自动取本次的 ctx.out 内容）
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const { createStore } = require('../src/data-store.js');
const concurrency = require('../src/concurrency.js');
const schema = require('../src/schema.js');
const tree = require('../src/tree-utils.js');
const changes = require('../src/changes.js');

/**
 * projects 根目录。
 *
 * 默认是工程内的 `projects/`。**可用环境变量 `AI_MINDMAP_PROJECTS_DIR` 覆盖** ——
 * 这是为了让宿主（main.js 的冒烟沙箱、未来的自动化）能把 CLI 的重定向到临时副本。
 *
 * 为什么必须支持覆盖：main.js 冒烟时把**自己**的 store 指向临时目录，但它经
 * `runCli()` 调起的 CLI 是**另一个进程**，自己算出 `projects/` 就是真实目录 ——
 * 于是"渲染层随便写、反正写的是副本"的假设在**经 CLI 的写操作**上不成立，
 * 冒烟会真的改动用户数据（曾实际发生：新增的关系审计断言调用 `link`，
 * 把一条链接写进了真实项目）。宿主必须能把写路径一并重定向。
 */
const PROJECTS_DIR = process.env.AI_MINDMAP_PROJECTS_DIR
  ? path.resolve(process.env.AI_MINDMAP_PROJECTS_DIR)
  : path.resolve(__dirname, '..', 'projects');

/** 极简参数解析：--key value / --key=value / --flag / 位置参数 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--brief') { out.brief = true; continue; }
    // 比 --brief 更窄一档：连 tags/links 也省掉（实测再省 27.5%）。纯 opt-in，不改默认。
    if (a === '--skeleton') { out.skeleton = true; continue; }
    // 全局开关：--json 不再缩进换行（实测在真实项目上省 24%，配 --brief 省 47%）。
    // 单行 JSON 对机器消费者（AI / MCP）毫无损失，省下的全是缩进与换行。
    if (a === '--compact') { out.compact = true; continue; }
    // 注意：--detail 不能放显式 flag 列表——它在 read/get 是 flag，
    // 在 add/edit 是带值参数（历史 bug：放这里导致 detail 永远=true 校验必失败）。
    if (a === '--images') { out.images = true; continue; }
    if (a === '--clear-detail') { out.clearDetail = true; continue; }
    if (a === '--clear-tags') { out.clearTags = true; continue; }
    if (a === '--full') { out.full = true; continue; }
    if (a === '--with-detail') { out.withDetail = true; continue; }
    if (a === '--deep') { out.deep = true; continue; }
    // 纯布尔 flag 显式登记：否则会被通用分支按"--key value"处理，
    // 一旦后面跟了位置参数（如 `mentions 项目 --include-structural 5`）就被误吞成值。
    if (a === '--content-only') { out.contentOnly = true; continue; }
    if (a === '--include-structural') { out.includeStructural = true; continue; }
    if (a === '--cross') { out.cross = true; continue; }
    if (a === '--clear-note') { out.clearNote = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--clean-assoc') { out.cleanAssoc = true; continue; }
    if (a === '--clean-links') { out.cleanLinks = true; continue; }
    // 其余纯布尔开关显式登记（否则会被通用分支按"--key value"吞掉下一个位置参数）
    if (a === '--clear') { out.clear = true; continue; }
    if (a === '--raw') { out.raw = true; continue; }
    // 覆盖式导入的显式开关（import-project / import-md）：纯布尔 ⇒ 必须在这里登记，
    // 否则会被通用分支按"--key value"处理、把后面的位置参数吞成它的值（见上面那条注释）
    if (a === '--force') { out.force = true; continue; }
    if (a === '--unmounted') { out.unmounted = true; continue; }
    if (a === '--major') { out.major = true; continue; }
    if (a === '--minor') { out.minor = true; continue; }
    if (a === '--patch') { out.patch = true; continue; }
    // `--idem` 是**所有写命令**的幂等键（机制在下方 createContext 里，见文件头的幂等契约）：
    // 它**带值**（`--idem k` / `--idem=k`），故不在这里当纯布尔登记 —— 走下面的通用分支即可，
    // 键名由 optionKey 归一成 `idem`。裸写 `--idem`（没有值）会被解析成 `true`，
    // 由 `normalizeIdemKey` **响亮拒绝**（键不能是布尔值：那会让每一次重放都命中同一个键）。
    if (a.startsWith('--')) {
      // `--key=value` 与 `--key value` 等价（**只有这一处归一**，见 optionKey）。
      // 为什么必须支持 `=`：不支持时 `--expanded=nonsense` 会变成一个**键里带等号**的怪选项，
      // 命令读不到 `args.expanded` ⇒ **静默当成默认值**（实测：盘上写的是默认 true）。
      const eq = a.indexOf('=');
      if (eq > 2) {
        out[optionKey(a)] = a.slice(eq + 1);
        continue;
      }
      const key = optionKey(a);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { out[key] = nxt; i++; }
      else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * `--foo-bar` / `--foo-bar=值` → 归一后的键名 `fooBar`。
 *
 * **唯一的归一实现**：解析（parseArgs）与未知选项检查（unknownOptions）必须用同一套规则，
 * 否则会出现"解析器认识、白名单不认识"的错杀（例如 `--detail-md` vs `detailMd`）。
 */
function optionKey(token) {
  const raw = String(token).replace(/^--/, '');
  const eq = raw.indexOf('=');
  return (eq >= 0 ? raw.slice(0, eq) : raw).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

/**
 * 扫出 argv 里**这条命令不认识**的选项（纯函数、无 IO ⇒ 可单测）。
 *
 * 为什么需要它（本工程实测的缺陷，2026-10-10）：写命令对不认识的选项**静默忽略** ——
 * `add <项目> root --topic X --tags aaa,bbb` 返回 exit 0 且打印"已添加"，
 * 但 `get` 里根本没有 tags、`stats` 报 `taggedNodes: 0`。调用方是 AI，
 * 它会把"退出码 0 + 成功话术"当成依据 ⇒ 一次静默 = 一条假数据 + 一个自以为成功的 AI。
 * 危险点在于 `--tags` 在 `edit` / `add-image` 上**是合法选项**，跨命令误用极其自然。
 *
 * ⚠️ **全局开关一律放行**（`GLOBAL_OPTIONS`）：这些是**横切机制**的开关（幂等键 / 输出形态），
 * 不属于某一条命令的语义面 —— 逐条登记必然漏掉某条命令，而漏掉的表现是"这条命令不认 `--idem`"
 * （一个**只有那条命令**才有的假红线，最难查的那种）。`--json` / `--brief` / `--compact`
 * 早就是这个待遇（它们从不出现在任何一条命令的 `options` 里，却处处都能用）。
 *
 * @param {string[]} argv 命令名之后的参数
 * @param {string[]} allowed 该命令认识的选项键（camelCase，含全局输出开关）
 * @param {string[]} [globals] 额外放行的横切开关键（默认 `GLOBAL_OPTIONS`）
 * @returns {Array<{key:string, token:string}>} 去重后的未知选项（按出现顺序）
 */
function unknownOptions(argv, allowed, globals) {
  const known = new Set(allowed || []);
  (globals || GLOBAL_OPTIONS).forEach((k) => known.add(k));
  const out = [];
  const seen = new Set();
  (argv || []).forEach((a) => {
    if (typeof a !== 'string' || a.length < 3 || a.slice(0, 2) !== '--') return;
    const key = optionKey(a);
    if (known.has(key) || seen.has(key)) return;   // 同一个未知选项重复出现只报一次
    seen.add(key);
    out.push({ key: key, token: a.split('=')[0] });
  });
  return out;
}

/**
 * 解析一个"必须是整数"的选项值（纯函数、无 IO ⇒ 可单测）。
 *
 * 为什么需要它（与"未知选项"同一类缺陷，2026-10-10 实测）：
 * `--limit abc` / `--min-length abc` / `--timeout abc` 以前被**静默吞掉** ——
 *   · `Math.max(0, Number('abc'))` = NaN ⇒ `slice(0, NaN)` = `[]` ⇒ **静默给出一份空清单**
 *     （读者会当"真的没有"）；
 *   · `Number('abc') > 0` 为假 ⇒ 悄悄退回默认值 ⇒ 调用方以为自己设的超时生效了。
 * 这两条都属于"看起来成功、其实按别的参数跑了"。统一在这里判：非法值**当场报错并说清允许范围**。
 *
 * @param {*} raw 原始值（`undefined` = 没给这个选项）
 * @param {{min?:number, max?:number, def?:number, label?:string}} [opts]
 * @returns {{ok:true, value:(number|undefined)}|{ok:false, reason:string}}
 */
function parseIntOption(raw, opts) {
  const o = opts || {};
  if (raw === undefined) return { ok: true, value: o.def };
  if (raw === true || raw === '' || raw === null) {
    return { ok: false, reason: '需要一个整数（没给值）' };
  }
  const n = Number(raw);
  const min = o.min === undefined ? 0 : o.min;
  const max = o.max === undefined ? Number.MAX_SAFE_INTEGER : o.max;
  const range = (min === 0 && max === Number.MAX_SAFE_INTEGER) ? '非负整数'
    : (max === Number.MAX_SAFE_INTEGER ? '≥ ' + min + ' 的整数' : min + '–' + max + ' 的整数');
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, reason: '必须是' + range + '（收到 ' + JSON.stringify(raw) + '）' };
  }
  return { ok: true, value: n };
}

/**
 * 本工程**真的认**的短选项。当前只有 `-h`（= `--help`：全局与 `<命令> -h` 两种用法，
 * 见 `cli/main.js` 的 dispatch —— 它在进到下面那个扫描之前就已经被处理掉了）。
 * 定义在这里是**为了有唯一一份**：扫描器与报错文案必须共用它，否则"报不认识的选项"
 * 会把工程自己的正常用法判死 ✗。
 */
const SHORT_OPTIONS = ['-h'];

/* ============================================================================
 * 写命令的幂等键（S7）—— **机制全在这里**，命令只需在自己的 registry 里声明 `idem` 即可生效
 * ----------------------------------------------------------------------------
 * ## 要修的问题（已实测，不是假设）
 *   ① `add` 重试即造重复：`src/markdown.js` 的 `idGen` 含时间 + 随机 ⇒ 重跑一次得到的
 *      是**另一个** id 的另一个节点，而调用方（AI / 脚本）看起来"成功了"；
 *   ② 没有统一的幂等键 ⇒ **重试 = 重复生效**（网络重发、脚本重跑、AI 拿不准再敲一遍都算）；
 *   ③ `.changes.jsonl` 里没有"这次是哪一次重试"的位置 ⇒ 事后连"重复过"都看不出来。
 *
 * ## 契约（调用方只需记这三条）
 *   1. 任何**写命令**都可以带 `--idem <键>`。同键重放 ⇒ **不重复执行 + 返回首次结果**，
 *      回显里出现「幂等命中」。键不同 ⇒ 照常执行（不同键就是不同的一次操作）。
 *   2. 键落在 `projects/<项目>/.changes.jsonl` 的**可选字段** `idem`（外加首次回显 `out`）——
 *      照 `origin` 的先例：可选字段、**不升 formatVersion**、不写进项目文件。
 *   3. 键**按项目**各自判（同一个键在两个项目里互不影响）。键必须是非空字符串（≤128 字）。
 *
 * ## 如实说明的边界（别把它当"事务"用）
 *   · **命令失败（抛错）不会记键** ⇒ 重试会照常执行。这是有意的：失败的那次没生效，
 *     "跳过"才是错的（会把一次真的没做的操作伪装成做过了）。
 *   · 键活在**有界窗口**的日志里（`changes.MAX_ENTRIES` 条；删掉 `.changes.jsonl` 即"忘了"）
 *     ⇒ 很久以前用过的键会滑出窗口，那时同键重放会**再执行一次**。想要更长的记忆就得
 *     把键写进数据 —— 那正是本工程不做的事（数据只有一套语义）。
 *   · `--dry-run` 的调用**不查也不记**键（dry-run 不写盘 ⇒ 不算"生效"）。
 *   · 键**不能跨命令复用**：同一个键换个命令会用首次那条记录里的命令名**拒绝**（见下）。
 *   · 只覆盖**数据面**：碰物理文件 / 外部进程的命令（add-image 复制文件、add-file、
 *     界面控制类）不在幂等面内 —— 它们的"重复"是文件级或界面级的，不是本次要修的那类。
 * ========================================================================== */

/**
 * 横切开关键：任何命令都认（不属于某条命令的语义面，见 `unknownOptions` 的注释）。
 *
 * `force` 与 `idem` 都属于**写管道流（S7）**的横切面：
 *   · `force` —— "我真的要这一份重复"的显式出口（`add` / `add-root` / `assoc-add` 语义去重用它，
 *     导入类命令早就在用）⇒ 逐条登记必然漏（漏掉的那条会把正常用法判成"未知选项"✗）
 *   · `idem`  —— 幂等键（见下面的幂等契约）
 * 两者都**不是权限**、不含判定，只是把"调用方的意图"带进来。
 */
const GLOBAL_OPTIONS = ['json', 'brief', 'skeleton', 'compact', 'images', 'force', 'idem'];

/** 幂等键的长度上限：日志是有界产物，不该被一个超长键撑变形（正常键都是调用方自造的名） */
const IDEM_MAX = 128;

/**
 * 幂等键的**唯一校验处**（纯函数 ⇒ 可单测）。
 * 只接受非空字符串；`true`（裸写 `--idem`）**响亮拒绝** —— 那会让每一次重放都命中同一个键，
 * 于是"第二次运行"永远返回第一次的结果（比没有幂等更危险的一种静默）。
 * @returns {{ok:true, key:(string|null)}|{ok:false, reason:string}}
 */
function normalizeIdemKey(raw) {
  if (raw === undefined || raw === null) return { ok: true, key: null };
  if (raw === true || raw === false || typeof raw === 'object') {
    return { ok: false, reason: '--idem 需要一个**键**（如 --idem add-tcp-1），不能裸写' };
  }
  const s = String(raw).trim();
  if (!s) return { ok: false, reason: '--idem 的键不能为空（空键会让所有调用都互相命中）' };
  if (s.length > IDEM_MAX) {
    return { ok: false, reason: '--idem 的键最长 ' + IDEM_MAX + ' 字符（收到 ' + s.length + '）' };
  }
  return { ok: true, key: s };
}

/**
 * 认 `--idem` 的**写命令**（键名 = registry 里的正式命令名，别名归一到正式名）。
 *
 * 为什么要有这份清单：`--idem` 是**横切开关**，任何命令都被放行（见 `GLOBAL_OPTIONS`），
 * 但不该在**只读**命令上装作"重试安全" —— `read` / `search` 带 `--idem` 是调用方搞错了机制，
 * 这时**响亮拒绝**比默默忽略有用（默认为什么不行：AI 会把"我带了幂等键"当成一件事已经办妥）。
 * 清单**与实现同步**：每条都在 `cli/commands/*` 里走 `ctx.mutate` / `ctx.write`
 * （唯一例外是 `import-json`：它按设计走裸 `store.write`，见 ARCHITECTURE §4b 的"接线边界"）。
 */
const WRITE_COMMANDS = Object.freeze([
  // 节点编辑（cli/commands/edit.js）
  'add', 'add-root', 'edit', 'move', 'remove', 'clone', 'expand-depth', 'apply',
  // 关联笔记（cli/commands/assoc.js）
  'assoc-add', 'assoc-edit', 'assoc-remove', 'assoc-prune',
  // 跨项目链接（cli/commands/links.js）
  'link', 'unlink', 'links-prune',
  // 图片与附件（cli/commands/assets.js）：数据面（节点上的引用）经 mutate ✓
  'add-image', 'remove-image', 'add-file', 'remove-file',
  // 导入与项目级写入（cli/commands/project.js / qa.js）
  'import-md', 'import-project', 'import-json', 'ask-apply',
  // 条目层写入（cli/commands/item.js / migrate.js，契约 docs/ITEM-MODEL.md §3）
  // 说明：这份清单是**手写的**（见上面注释：逐条登记才能被 `--idem` 的归属守门认得），
  // 新增写命令必须**同批**把名字加进来，否则它带 `--idem` 会被当成"只读命令"拒掉。
  'item-add', 'item-edit', 'item-remove', 'item-move', 'item-order', 'render-detail'
]);

/**
 * 幂等命中：命令体**根本没跑**，由 `cli/main.js` 的 dispatch 接住并回放首次结果。
 * 用异常而不是返回值传递，是因为"不重复执行"必须能**从任意深度短路**（`replayCheck`
 * 在 `ctx.mutate` 里被调用），而各命令体不必知道幂等这回事 —— 这才叫机制在 core。
 */
class IdemReplay extends Error {
  constructor(info) {
    super('幂等命中（未执行本次命令）');
    this.name = 'IdemReplay';
    this.idem = info;
  }
}

/**
 * **"这次别写盘"的哨兵**（S7 的语义去重需要它）。
 *
 * 场景：命令的改动函数在预检/执行期发现"这是一次重复新增"⇒ 要拒绝。但它的返回值就是
 * **要写下去的数据** ⇒ 返回 `null` 会让写入与 `changedKeys` 直接崩（实测形态：
 * `校验失败: 顶层必须是对象`）；原样返回 `data` 又会让一次**被拒绝**的命令照样落盘一条
 * 日志（实测形态：日志里多出一条 `changed: []` 的空写入，而命令其实报了错 ✗）。
 * 于是引入这个哨兵：改动函数返回它 ⇒ `mutate` / `write` **一次盘都不写**，命令体照旧
 * 抛自己的错误（`add` 的重复拒绝 / `assoc-add` 的重复拒绝都走这条路）。
 */
const SKIP_WRITE = Object.freeze({ skipWrite: true });

/**
 * 读一个项目的变更日志条目（**只读**、损坏即当"没有"）。
 * 复用 `store.changeLogFile()` 这一处路径推导（别处不许自己拼路径）。
 */
function readChangeEntries(store, name) {
  if (!store || !name) return [];
  let text = '';
  try { text = fs.readFileSync(store.changeLogFile(name), 'utf8'); } catch (e) { return []; }
  return changes.parseLog(text).entries;
}

/**
 * 扫出 argv 里**单短横线开头、又不是已知短选项**的位置参数（纯函数、无 IO ⇒ 可单测）。
 *
 * 为什么需要它（缺陷取证，实测）：`node cli/mm-cli.js read -x` ⇒ `error: 项目不存在: -x`。
 * 退 1 是响亮的，但**原因错**：它把 `-x` 当成项目名了 ⇒ 调用方（人和 AI 都会）
 * 去查"项目 -x 为什么不存在"，而真实原因是"这个选项写错了"。诊断方向一错，弯路就长了。
 *
 * ⚠️ 只扫**位置参数**（`parseArgs(...)._`），不扫原始 argv —— 被当作**选项值**的 `-x` 是正常用法：
 *   `edit <项目> <id> --topic -x` 里的 `-x` 会被通用分支吃成 topic 的值，
 *   拿原始 argv 去扫会把它误报成未知选项 ✗（"别把正常用法判死"）。
 * @param {string[]} positionals `parseArgs(argv)._`
 * @param {string[]} [knownShort] 真的认的短选项（默认 SHORT_OPTIONS）
 * @returns {string[]} 去重后的未知短选项（按出现顺序）
 */
function unknownShortOptions(positionals, knownShort) {
  const known = new Set(knownShort || SHORT_OPTIONS);
  const out = [];
  const seen = new Set();
  (positionals || []).forEach((a) => {
    if (typeof a !== 'string' || a.length < 2 || a[0] !== '-' || a.slice(0, 2) === '--') return;
    if (known.has(a) || seen.has(a)) return;    // 同一个未知选项重复出现只报一次
    seen.add(a);
    out.push(a);
  });
  return out;
}

/** 选项键 → 命令行写法（报错里要写用户敲的那个 `--foo-bar`） */
function optionFlag(key) {
  return '--' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * @param {string[]} argv 去掉命令名之后的参数（`cli/main.js` 已切掉）
 * @param {{command?:string}} [meta] 命令名 —— 只用于**变更日志的"谁在写"**（见 writer）
 */
function createContext(argv, meta) {
  const args = parseArgs(argv);
  const projectName = args._[0];
  // 注意：`projectName` 必须在 store 之前取出 —— 校验器要拿它做 selfProject。
  // （`import-json` 的 `_[0]` 是文件路径而不是项目名，故校验器用的是 store.write 传进来的
  //   真实目标项目名 `name`，不是这里的闭包值。）
  const store = createStore(PROJECTS_DIR, (data, name) => {
    const v = schema.validateProject(data, PROJECTS_DIR, name);
    if (!v.ok) throw new Error('校验失败: ' + v.errors.join('; '));
  });
  /**
   * 「**谁在写**」—— 变更日志里那一列，多路同时编辑时用来回答"是谁改的"。
   * 外壳（MCP / 侧栏 / 界面代写）设 `MM_WRITER` 声明自己是谁；没设就是 `cli`。
   * 只影响日志的可读性，**不参与任何判定**（不是权限、不是闸门）。
   */
  const surface = (process.env.MM_WRITER || 'cli').trim() || 'cli';
  const writer = surface + ':' + ((meta && meta.command) || 'unknown');
  /** 本命令的**正式名**（幂等键的作用域 = 项目 × 命令；别名已在 registry 归一） */
  const cmdName = (meta && meta.command) || 'unknown';
  /**
   * 本次执行里**最近一次 ctx.out / ctx.outJson 的内容**（首次执行的回显 ⇒ 重放时原样复述）。
   * ⚠️ 它是**每次写入重新起算**的（`beginWrite` 清空）—— 一个 ctx 只服务一条命令，但同一条命令
   * 里可能写多次（命令内部再写一次 / 并发自动重放）；不清空就会把"这条命令早些时候打印的东西"
   * 也算进本次回显，重放时复述出一堆无关内容（实测：`add` 的首次回显里混进了它前面几条命令的输出 ✗）。
   */
  let captured = { text: [], json: null };
  let captureDirty = false;
  /** 回显起算位置（见 `beginWrite`）：只把**这次写**涉及的那一段文本算进本次回显 */
  let captureMark = 0;
  /** 守卫只对**第一次**读改写生效：命令内部若还要再写一次（罕见），不该命中自己刚写的那条 */
  let replayChecked = false;
  /** 幂等命中时回放的载荷（`cli/main.js` 读它 —— 判定与输出处只有那一处） */
  let replayPayload = null;
  /** `read()` 读到的版本指纹。写回时交给 data-store 的**并发版本闸门**：
   *  若读与写之间别处写入过，写入会中止并报错，而不是静默抹掉那次改动。 */
  let readVersion;
  /** `--idem` 的键（在 `replayCheck` 里定下来；落账时要用它） */
  let idem = null;
  /** 延迟落账槽（一次命令体里最多一条：第一次有效写的那条） */
  let pending = null;
  /**
   * 开始记"这一次写盘的回显"：把起点挪到**当前位置**（前面的输出留在数组里、但不进本次回显）。
   * ⚠️ 刻意**不清 `captureDirty`**：写命令的 `ctx.out('已添加: …')` 常常发生在写**之后**
   * （`add` / `edit` 都是）⇒ 写盘那一刻的快照本来就拿不到它；清掉脏标记等于把这次回显判死。
   * 由 `idemSnapshot()` 在**下次写入**时把这段尾巴取走，首次回显才是完整的；
   * 而"上一次写入之后、这一次写入之前"打印的内容（上一轮的尾巴）被标记排除掉 ✓ 两者兼顾。
   */
  function beginWrite() { captureMark = captured.text.length; captured.json = null; }
  /**
   * 取本次写的回显快照（**取即推进标记** ⇒ 并发自动重放时只有"第一次真的写下去"的那次取到新内容）。
   * `--json` 命令给对象、文本命令给多行文本；什么都没打印 ⇒ 空串（`buildEntry` 会把空串当"没给"）。
   */
  function idemSnapshot() {
    const text = captured.text.slice(captureMark).join('\n');
    captureMark = captured.text.length;
    return captured.json !== null ? captured.json : text;
  }
  /**
   * **延迟落账**：把"这一次写的回显"先攒在内存里，等命令体跑完再追进日志。
   *
   * 为什么必须延迟（S7 实测的坑）：`store.write` 在写盘那一刻只有**写盘之前**打印的内容，
   * 而写命令的收尾回执（`已添加: n-xxxx`）发生在**写盘之后** ⇒ 立刻落账的话 `out` 永远是空串，
   * 幂等重放就复述不出"首次那个随机 id"（那正是重放最该给出的信息）。
   * 延迟只影响**日志**什么时候写（命令结束时写完，`changes` 的有界窗口语义不变）。
   * ⚠️ 代价写明：中间存在一个"数据已落盘、`idem` 记录尚未落账"的窗口（一次命令体的长度）。
   *    此时进程被硬杀 ⇒ 同键重放会**再执行一次**。取舍：日志是**旁路产物**，数据安全优先。
   */
  function markRecord() {
    if (!idem) return;                       // 没给键 ⇒ 什么都不用记（老路径行为不变）
    pending = { key: idem, mark: captureMark, json: captured.json };
    captureDirty = true;
  }
  /** 命令体结束时把延迟的那条记录补全并写进日志 */
  function flushIdemRecord() {
    if (!idem) return;
    const p = pending;
    const from = p ? p.mark : 0;                 // 没见过写盘（如并发冲突后没写成）⇒ 从命令开头算
    pending = null;
    const text = captured.text.slice(from).join('\n');
    if (text === '') return;
    try {
      store.recordChangeOut(projectName, idem, text);
    } catch (err) {
      console.error('warning: 变更日志写入失败（本次数据已写入，日志缺一条）：'
        + ((err && err.message) || err));
    }
  }
  const ctx = {
    store,
    args,
    projectName,
    schema,
    tree,
    PROJECTS_DIR,
    /**
     * 「谁在写」（`<外壳>:<命令>`）—— 只用于变更日志。
     * 暴露出来是给**绕过 `ctx.write` 的写点**用的（如 `import-json`：它新建整个项目，
     * 走 `ctx.store.write` 而不走 `ctx.write`）。少了这个，那些写入在日志里会显示成 `unknown`。
     */
    writer,

    out(text) {
      process.stdout.write(text + '\n');
      captured.text.push(String(text));
      captureDirty = true;
    },
    // `--compact` 时输出单行 JSON：**机器消费者零损失**，省掉的纯是缩进与换行。
    outJson(obj) {
      process.stdout.write(JSON.stringify(obj, null, args.compact ? 0 : 2) + '\n');
      captured.json = obj;
      captureDirty = true;
    },
    error(msg) { throw new Error(msg); },

    /** 幂等键（`--idem <键>`；没给 = `null`）。校验在第一次写时做，见 `replayCheck`。 */
    idemKey: null,

    /**
     * **幂等守卫**（写命令的"重试安全"就靠这一个入口）。
     *
     * 调用时机：`ctx.mutate` / `ctx.write` 的**第一次**调用之前 —— 也就是"要写盘"这件事
     * 第一次发生时。放在这里而不是命令体里，是为了让 40+ 条写命令**零改动**地获得它。
     *
     * @throws {IdemReplay} 该键已经写成功过 ⇒ **本次命令体不再执行**（由 `cli/main.js` 回放首次结果）
     */
    replayCheck() {
      if (replayChecked) return;
      replayChecked = true;
      const p = normalizeIdemKey(this.args.idem);
      if (!p.ok) this.error(p.reason);
      this.idemKey = p.key;
      idem = p.key;
      if (!p.key) return;
      // ① 只读 / 不写盘的命令不接受它：默默忽略会让 AI 以为"我带了幂等键 ⇒ 重试安全"
      if (WRITE_COMMANDS.indexOf(cmdName) < 0) {
        this.error('--idem 只对**写命令**有意义：' + cmdName + ' 不写盘（它不会重复生效，也不该带幂等键）。'
          + '写命令清单见 cli/core.js 的 WRITE_COMMANDS。');
      }
      // ② dry-run 不查也不记（它不写盘 ⇒ 不算"生效"）
      if (this.args.dryRun) return;
      // ③ 查这个键**在本项目里**写成功过没有（键的落点见 src/changes.js 的 buildEntry）
      const hit = changes.idemLookup(readChangeEntries(store, projectName), p.key);
      if (!hit) return;
      const first = String(hit.writer || '').split(':').pop();   // `cli:add` → `add`
      if (first && first !== cmdName) {
        this.error('幂等键 ' + p.key + ' 已经用在命令 ' + first + ' 上（见 .changes.jsonl 的 rev '
          + hit.rev + '）—— 同一个键换个命令会产生一次**假命中**：'
          + '这次要执行的 ' + cmdName + ' 会被跳过。请换一个键（建议 <命令>-<对象>-<序号>）。');
      }
      replayPayload = {
        key: p.key, cmd: cmdName, rev: hit.rev, version: hit.version,
        result: hit.out || '', at: hit.at, writer: hit.writer
      };
      throw new IdemReplay(replayPayload);
    },

    /**
     * 取回"幂等命中"的载荷（没有命中 = `null`）。
     * 由 `cli/main.js` 的 dispatch 调用：它接住 `IdemReplay` 之后靠这个对象回放。
     */
    idemReplay() { return replayPayload; },

    /**
     * 命令体跑完时把**延迟的那条幂等记录**补全（`cli/main.js` 的 dispatch 在 `cmd.fn` 之后调）。
     * 不调也不会崩（记录少一个 `out` 字段而已），但幂等重放就复述不出首次回显了。
     */
    flushIdemRecord() { flushIdemRecord(); },

    /**
     * **显式声明这次执行的回显**（幂等重放时原样复述的那一段）。
     * 不给也能工作（自动取本次 `ctx.out` 的内容），但显式声明的可读性更好：
     * 多行回执、`--json` 形态的命令都该用它，别让重放去猜。
     */
    setIdemResult(text) {
      captured = { text: [String(text)], json: null };
      captureDirty = true;
    },

    /**
     * 读一个"必须是整数"的选项（`--limit` / `--min-length` / `--timeout` …）。
     * 非法值**当场报错**（带上允许范围），不静默退化成 NaN / 默认值 —— 理由见 `parseIntOption`。
     * @param {string} key camelCase 键名（如 `limit` / `minLength`）
     * @param {{min?:number, max?:number, def?:number}} [opts]
     * @returns {number|undefined} 没给该选项时返回 `def`（默认 `undefined`）
     */
    intOption(key, opts) {
      const p = parseIntOption(this.args[key], opts);
      if (!p.ok) this.error(optionFlag(key) + ' ' + p.reason);
      return p.value;
    },

    read() {
      if (!projectName) throw new Error('缺少项目名');
      const r = store.read(projectName);
      readVersion = r.version; // 记下「我读的是哪一版」，write 时用作并发闸门
      return r;
    },
    write(data) {
      // ---- 幂等守卫（S7）：要写盘之前先问一句"这个键是不是已经写成功了" ----
      // 命中 ⇒ 抛 IdemReplay（**命令体到此为止**，一次盘都不写），由 cli/main.js 回放首次结果。
      this.replayCheck();
      if (data === SKIP_WRITE) return data;      // 命令明确说"这次别写"（见 SKIP_WRITE 的注释）
      beginWrite();
      markRecord();                              // 回显在命令体跑完时才补全（见 markRecord）
      // expectVersion 来自本 ctx 最近一次 read()。命令若没读过就直接写（如 import-json
      // 新建项目），readVersion 为 undefined ⇒ 闸门放行，行为与从前一致。
      const r = store.write(projectName, data, {
        expectVersion: readVersion, writer: writer,
        idem: this.idemKey                      // 幂等键 → .changes.jsonl 的可选字段（见 src/changes.js）
      });
      flushIdemRecord();
      // 自己写下的这一份就是最新版，记下来 —— 同一条命令里再写一次时不会误报冲突
      if (r && r.version) readVersion = r.version;
      return data;
    },
    /**
     * **多路同时编辑的入口**：读 → 改 → 写，并在**可证明安全**时把改动自动重放到最新版。
     *
     * 与"自己 read() 再 write()"的区别只在冲突时：
     *   · 旧写法：别人在你读之后写过 ⇒ 整条命令失败，这次改动白做；
     *   · 本方法：先看**两路改动的对象是否相交**（`node:<id>` / `children:<父id>` / `assoc:<id>` / `meta`）——
     *     不相交 ⇒ 把你的改动套用到最新版上写入（**双方改动都保留**）；
     *     相交 ⇒ 拒绝并**指名**冲突对象（绝不静默覆盖）。
     *
     * @param {(data:any)=>any} fn 改动函数：接收一份拷贝、返回改好的数据。
     *        ⚠️ **不得在里面做 I/O / 打印 / 物理写盘** —— 并发重放会再调用它一次：
     *        打印会重复，物理写盘会留下孤儿文件（实测教训：附件复制必须留在 fn 之外）。
     *        要把结果带出去，记进闭包变量（如 `let addedId = null`）即可。
     * @param {{replayable?:boolean, maxAttempts?:number}} [opts]
     *        `replayable:false` 用于**不可重复执行**的改动（依赖时间/随机/追加语义）⇒ 冲突时不重放，直接拒绝
     * @returns {{data:any, attempts:number, merged:boolean}} `merged:true` 表示发生过自动重放
     */
    mutate(fn, opts) {
      if (!projectName) throw new Error('缺少项目名');
      if (typeof fn !== 'function') throw new Error('mutate 需要一个改动函数');
      // ---- 幂等守卫（S7）：与 ctx.write 走的是**同一处**判定（幂等不是第二条写路径，是同一道闸）----
      // ⚠️ 位置：必须在 withReplay 之前 —— 命中时连读改写都不该发生（零盘面动作才是"不重复执行"）。
      this.replayCheck();
      // 回显快照的取法同 ctx.write（首次写成功那一刻定下来；见那里的注释）。
      // 注意 withReplay **可能**因并发冲突写两次（自动重放到最新版），但只有**第一次成功**的
      // 那次会把快照取走 ⇒ 快照永远是"第一次真的写下去时的回显" ✓
      return concurrency.withReplay({
        read: () => { const r = store.read(projectName); readVersion = r.version; return r; },
        write: (data, wopts) => {
          if (data === SKIP_WRITE) return;         // 命令明确说"这次别写"（见 SKIP_WRITE 的注释）
          beginWrite();                   // 只记**本次改动函数**打印的东西（别混进命令早些时候的输出）
          markRecord();
          const r = store.write(projectName, data, Object.assign({}, wopts, {
            writer: writer, idem: this.idemKey
          }));
          flushIdemRecord();
          if (r && r.version) readVersion = r.version;
        }
      }, fn, opts);
    },
    get root() {
      const { data } = this.read();
      return data.data;
    },
    find(id) {
      const { data } = this.read();
      return tree.find(data.data, id);
    }
  };
  return ctx;
}

module.exports = {
  createContext, parseArgs, optionKey, unknownOptions, parseIntOption, optionFlag, PROJECTS_DIR,
  unknownShortOptions, SHORT_OPTIONS,
  // ---- 写管道流（S7）：幂等键 ----
  IdemReplay, SKIP_WRITE, GLOBAL_OPTIONS, IDEM_MAX, WRITE_COMMANDS, normalizeIdemKey, readChangeEntries
};
