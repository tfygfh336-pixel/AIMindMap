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
const { createStore, createProjectValidator } = require('../src/data-store.js');
const concurrency = require('../src/concurrency.js');
const schema = require('../src/schema.js');
const tree = require('../src/tree-utils.js');
const changes = require('../src/changes.js');
const heatSensor = require('../src/heat-sensor.js');

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
    // `clone` 的另一档语义开关（`--repoint-items`）：同样是**纯布尔** ⇒ 同样必须登记。
    // ★ 实测形状（不登记时）：`clone 项目 --repoint-items 源id 新父id` 会被通用分支吞成
    //   `repointItems='源id'`、位置参数少一个 ⇒ 用户看到的是「源节点不存在: 新父id」这种
    //   看不懂的话（而不是"照 --deep 那样写就行"）。
    if (a === '--repoint-items') { out.repointItems = true; continue; }
    // `search` 的热度逃生门（`--no-heat`）：也是纯布尔 ⇒ 一并登记（同一类病：裸写时吞掉后面的关键词）。
    // ⚠️ 带等号的两态写法（`--no-heat=false` / `--no-heat=true`）走**通用 `=` 分支**、语义一个字不变
    //   —— `tests/search-heat.test.js` 的 J5 钉着这两条；这里只接管**裸写**那一种。
    if (a === '--no-heat') { out.noHeat = true; continue; }
    // 【W4】`search` / `search-all` 的 `--explain`：也是**纯布尔** ⇒ 同样登记
    //   （不登记就会被通用分支按"--key value"吞掉后面的关键词 —— 与 `--no-heat` 同一种病）。
    if (a === '--explain') { out.explain = true; continue; }
    // ⚠️ `--mode` / `--weights` **带值**，故意**不**在这里登记（走通用分支：`--mode x` / `--mode=x`）。
    // 纯布尔 flag 显式登记：否则会被通用分支按"--key value"处理，
    // 一旦后面跟了位置参数（如 `mentions 项目 --include-structural 5`）就被误吞成值。
    if (a === '--content-only') { out.contentOnly = true; continue; }
    if (a === '--include-structural') { out.includeStructural = true; continue; }
    if (a === '--cross') { out.cross = true; continue; }
    if (a === '--clear-note') { out.clearNote = true; continue; }
    if (a === '--clear-anchors') { out.clearAnchors = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--clean-assoc') { out.cleanAssoc = true; continue; }
    if (a === '--clean-links') { out.cleanLinks = true; continue; }
    // 其余纯布尔开关显式登记（否则会被通用分支按"--key value"吞掉下一个位置参数）
    if (a === '--clear') { out.clear = true; continue; }
    if (a === '--raw') { out.raw = true; continue; }
    // 覆盖式导入的显式开关（import-project / import-md）：纯布尔 ⇒ 必须在这里登记，
    // 否则会被通用分支按"--key value"处理、把后面的位置参数吞成它的值（见上面那条注释）
    if (a === '--force') { out.force = true; continue; }
    /* `--anchor`（`assoc-add` / `assoc-edit`）是**可重复**选项：一篇笔记可以有多条锚点。
     * 为什么必须单独登记（不能走下面的覆盖式通用分支）：重复给同一个选项时，通用分支是
     * "后者覆盖前者"⇒ 用户给三条锚点只会剩最后一条，而且**静默**（exit 0、回显"已更新"）。
     * 这正是本工程反复治的那种"看起来成功、其实按别的参数跑了"✗ ⇒ 这里累积成数组；
     * 命令侧一律 `[].concat(ctx.args.anchor || [])` 归一（单条也走同一形状）。 */
    if (a === '--anchor') {
      const v = argv[i + 1];
      if (v !== undefined && !String(v).startsWith('--')) {
        out.anchor = (out.anchor === undefined) ? [v] : [].concat(out.anchor, v);
        i++;
      } else { out.anchor = true; }        // 裸写 `--anchor`：解析成 true，由命令侧**响亮拒绝**
      continue;
    }
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
  // 导入与项目级写入（cli/commands/project.js / qa.js / merge.js）
  'import-md', 'import-project', 'import-json', 'ask-apply',
  // `merge-project`（把若干个已有项目整棵并进一个已有项目）**也写盘**：走 `ctx.mutate` ⇒
  // 与别的写命令同一条闸门。不写这一行，它带 `--idem` 会被当成"只读命令"响亮拒绝。
  'merge-project',
  // 条目层写入（cli/commands/item.js / migrate.js，契约 docs/ITEM-MODEL.md §3）
  // 说明：这份清单是**手写的**（见上面注释：逐条登记才能被 `--idem` 的归属守门认得），
  // 新增写命令必须**同批**把名字加进来，否则它带 `--idem` 会被当成"只读命令"拒掉。
  'item-add', 'item-edit', 'item-remove', 'item-move', 'item-order', 'render-detail',
  // `migrate`（v2 → v3 条目层迁移）**也写盘**：不写这一行，它带 `--idem` 会被当成"只读命令"响亮拒绝
  'migrate',
  // `recheck`（条目复校）**也会写盘**：显式 `--write-verified` 时写回 verified{at,by,how}。
  // 不写这一行，它带 `--idem` 会被当成"只读命令"响亮拒绝（`health` 不写盘，故不在本清单里）。
  'recheck',
  // 【R4】`bind-sync`（绑定工作区文件夹的同步/绑定/解绑）**也写盘**：同步走 `ctx.mutate`、
  // 绑定动作走 `ctx.mutate` ⇒ 与别的写命令同一条闸门（不写这一行，它带 `--idem` 会被当成只读命令拒掉）。
  'bind-sync'
]);

/* ============================================================================
 * 【W8】写入类命令统一 `--dry-run` —— **判定 / 打印 / 短路只有这一处**
 * ----------------------------------------------------------------------------
 * ## 要修的问题（本工程实测的形状）
 *   会改盘的命令里只有导入类（`import-project` / `import-dir`）与少数清理型命令会预览；
 *   最常用的 `add` / `edit` / `move` / `link` … **写完才知道**改成了什么样。
 *   调用方是 AI ⇒ 它只能"先写、再回读盘上变成了什么"，而写错的代价已经落在数据里了。
 *   W8 要的是把"可校"从**写完才知道**升级成**写前就能审**。
 *
 * ## 契约（调用方只需记三条）
 *   1. 任何**数据面写命令**都可带 `--dry-run`：报告"这次写盘会改动哪些对象"（**个数 + 对象键清单**），
 *      而**一个字节都不写盘**（既不写项目 JSON，也不追加 `.changes.jsonl`）。
 *   2. 报告里那份对象键清单**就是**真跑之后 `.changes.jsonl` 里那条 `changed` ——
 *      两处走的是**同一个** `concurrency.changedKeys`，输入也是同一对（盘上现有数据 → 计划数据）
 *      ⇒ "dry-run 说的 = 真跑后实际变的"是**构造保证**，不是两边各写一份口径再祈祷它们一致。
 *   3. `--dry-run` 与 `--idem`：dry-run 不写盘 ⇒ 不算"生效" ⇒ **不查也不记**键（见 `replayCheck` 第 ② 条）。
 *
 * ## 为什么必须是一处（而不是每条命令各写一段 `if (args.dryRun)`）
 *   41 条写命令各写一遍必然漂移，而漂移的方向是**最坏的那一种**：某条命令的 dry-run 分支
 *   忘了短路 ⇒ 它**照样写盘**，回显却还说着"未写盘"（"报告骗人"）。
 *   本工程已有两个同型的先例：`src/item-index.js` 的 `budgeted()`（预算）与主进程的 `parseStrictEnv`
 *   —— 口径抽一处、调用方只给参数。这里照办：
 *     · **判定**：`ctx.dryRun`（唯一读取点；命令层不许再读 `ctx.args.dryRun`，`tests/w8-dry-run.test.js` 静态把守）
 *     · **短路**：`ctx.write` / `ctx.mutate` 两条写路径各一处 `if (this.dryRun)`（写命令只有这两条出口）
 *     · **打印**：`planWrite()`（唯一一处报"将改哪些对象、几个"）
 *     · **登记**：`DRY_RUN_COMMANDS`（唯一一处说"哪些命令认这个开关"）
 *   ⚠️ 命令体里**物理副作用**（复制文件、写备份、外部进程）不在写管道里，中央拦不住 ⇒ 那几条
 *      由命令层读同一个 `ctx.dryRun` 自己关掉（`add-image` / `add-file` / `import-md` 的资源复制）。
 *
 * ## 边界（如实说明，别把它当"事务预览"）
 *   · 计划是**读一次盘、算一次**的：算完到真跑之间别人改了盘 ⇒ 真跑的结果与报告可能不同
 *     （与真跑的并发语义一致：真跑会拒绝或自动重放，**绝不会静默覆盖**）。
 *   · `--dry-run` 只保证"**这条命令**不写盘"：只读命令（`search` 等）照样会记访问埋点
 *     （那是**项目目录之外**的旁路日志，见 `src/data-store.js` 的 `visitLogFile`）。
 *   · 新建项目的命令（`init`）：真跑的日志里 `created:true` 而 `changed:[]`
 *     ⇒ 报告也只说"会新建项目、没有既有对象被改"（**不编一份假的对象清单**）。
 * ========================================================================== */

/**
 * dry-run 报告里每一行的行首标记（**唯一一处**）。
 *
 * 为什么要给命令自己的输出也加它：`add --dry-run` 的收尾回执是命令体打印的
 * （"已添加: n-x"），中央短路管不到那句话 —— 不加标记就会出现"报告说没写盘、回显说已添加"
 * 的自相矛盾（本工程最忌的"报告骗人"）。所以 dry-run 短路之后，命令的每一行输出都带上它。
 */
const DRY_RUN_TAG = '[dry-run 未写盘] ';

/**
 * 认 `--dry-run` 的命令（**唯一登记处**：registry 的选项白名单、docs 的支持集、main.js 的归属守门
 * 都从这里**现取**，不许各写一份）。
 *
 * 分四类，各自写清来由（读这一段就知道"新命令该怎么登记"）：
 *   ① **走中央短路**（本批新覆盖，命令体里**没有**任何 dry-run 分支）：单对象写 `add` / `edit` / `move` /
 *      `remove` / `clone` / `add-root` / `expand-depth`、链接 `link` / `unlink`、关联 `assoc-*`、
 *      条目层 `item-*` / `render-detail`、资源引用 `remove-image` / `remove-file`、项目级 `init` /
 *      `theme-layout`。
 *   ② **走中央短路 + 命令层关掉物理副作用**（复制资源不在写管道里）：`add-image` / `add-file` /
 *      `import-md`。
 *   ③ **清理型**：`links-prune` / `assoc-prune` —— 判定与短路同样走中央；它们**自己的报告文案**
 *      （"将要删除链接: …"）是领域事实，不是机制，故留在命令里（同一份 `ctx.dryRun` 读出来）。
 *   ④ **已有自备预览**（导入类与 AI 通道；本批**不改它们的语义**）：`apply` / `recheck` / `migrate` /
 *      `import-project` / `import-dir` / `ask`。登记在这里只是为了让"哪些命令认 `--dry-run`"
 *      **只有一个出处**，将来新增写命令时不会出现两处清单各自漂移。
 *
 * ⚠️ 手写清单（与 `WRITE_COMMANDS` 同一条纪律）：新增会改盘的命令时**同批**加进来，
 * `tests/w8-dry-run.test.js` 会核对"清单里的命令都真的认 `--dry-run`"与"清单外的写命令都响亮拒绝"。
 */
const DRY_RUN_COMMANDS = Object.freeze([
  // ① 走中央短路
  'add', 'add-root', 'edit', 'move', 'remove', 'clone', 'expand-depth',
  'link', 'unlink',
  'assoc-add', 'assoc-edit', 'assoc-remove',
  'item-add', 'item-edit', 'item-remove', 'item-move', 'item-order', 'render-detail',
  'remove-image', 'remove-file',
  'init', 'theme-layout',
  // ② 中央短路 + 命令层关物理副作用
  'add-image', 'add-file', 'import-md',
  // ③ 清理型
  'links-prune', 'assoc-prune',
  // ④ 已有自备预览（原样保留）
  'apply', 'recheck', 'migrate', 'import-project', 'import-dir', 'ask', 'ask-apply',
  // ⑥【本批】`merge-project`：走**中央短路**（命令体里没有任何 dry-run 分支）+ 命令层只读盘。
  //    它跑的是"同一个改动函数 + 同一份写盘前校验"⇒ 预览期每一条拒绝都照原样抛出、报文逐字相同
  //    （判据：`.review/20261019-merge-project/` 与 tests/merge-project.test.js 的 D 组）。
  'merge-project',
  // ⑤ 中央短路 + 命令层关物理副作用（【R4】绑定同步）：`ctx.mutate` 会自动短路 ⇒ 数据面零改动；
  //    而**旁路快照**（`.bindings.json`）是命令层的物理副作用，由命令层读同一个 `ctx.dryRun` 关掉
  //    （与 `add-image` / `import-md` 的"资源复制"同一形状）
  'bind-sync'
]);

/**
 * 会改盘、但**明确不支持** `--dry-run` 的命令（**唯一登记处**，与 `DRY_RUN_COMMANDS` 同一纪律）。
 *
 * 为什么留着这唯一一条：`import-json` 建的是**新项目**，而且它的资源解包（往 assets/ 写文件）
 * **不走 `ctx.write` 那条写管道**（ARCHITECTURE §4b 的"接线边界"：这条路按设计走裸 `store.write`）
 * ⇒ 中央的 dry-run 短路拦它不住，给了 `--dry-run` 就会出现"说没写、其实写了"的**假报告**。
 * 与其给一个骗人的开关，不如**响亮拒绝并说清原因与出路**（这正是 W8 要消灭的那种静默）。
 */
const DRY_RUN_UNSUPPORTED = Object.freeze({
  'import-json': '它建的是**新项目**，且资源解包不走 `ctx.write` 那条写管道'
    + '（这条命令按设计直接走 `store.write`，见 docs/ARCHITECTURE.md §4b 的"接线边界"）'
    + '⇒ 中央的 `--dry-run` 短路拦不住它，给了这个开关就会得到一份"说没写、其实写了"的假报告。'
    + '要看它会建成什么样：把 `AI_MINDMAP_PROJECTS_DIR` 指到一个临时目录里先真导一次'
    + '（那条路径是给沙箱用的，见本文件顶部的说明）。'
});

/**
 * `--dry-run` 的**归属守门**（纯函数、无 IO ⇒ 可单测）：这条命令带 `--dry-run` 到底行不行。
 *
 * 三种结局，各有各的话（**不静默忽略**是这条函数的全部意义 —— 调用方是 AI，
 * 它会把"命令跑通了"当成"我审过了"）：
 *   · 认这个开关（在 `DRY_RUN_COMMANDS` 里）⇒ `null`（放行）
 *   · 会改盘但明确不支持（`DRY_RUN_UNSUPPORTED`）⇒ 说清**为什么**与**出路**
 *   · 其余（只读命令 / 不碰项目数据面）⇒ 说清"它不写盘，用不上"，并指回清单
 *   · **带了值**（`--dry-run=false` 这类两态写法）⇒ **响亮拒绝**：它是**纯开关**，
 *     "不干跑"就是把开关去掉。照 `--repoint-items` 的先例（带 `=` 的形态走通用分支、
 *     登记表管不到 ⇒ 那种写法一律拒绝，别让它悄悄流进"只认布尔"的地方）。
 *     ⚠️ 为什么这条重要：若把 `--dry-run=false` 当成"开"，一次**想要真写**的调用会变成预览
 *     （**没写盘而调用方以为写了** —— 另一种静默）；当成"关"又会把 `--dry-run=true` 也带偏。
 *     两种猜法都危险 ⇒ 唯一的正解是**不猜**。
 *
 * @param {string} name 命令的**正式名**（别名已由 registry 归一）
 * @param {*} raw `--dry-run` 的**原始值**（没给 = `undefined`；裸写 = `true`）
 * @returns {string|null} 拒绝报文（放行时 `null`）
 */
function dryRunRefusal(name, raw) {
  if (raw === undefined || raw === null || raw === false) return null;   // 没给这个开关 ⇒ 不管
  if (raw !== true) {
    return '--dry-run 是**纯开关**（不带值）：写法 `… --dry-run`。'
      + '要"不干跑"就把这个开关去掉（`--dry-run=false` 这类两态写法本工程一律**响亮拒绝**，'
      + '理由与 `--repoint-items` 同一条：带 `=` 的形态不受纯布尔登记表保护，猜错方向两种都危险）。'
      + '（收到 ' + JSON.stringify(raw) + '）';
  }
  if (DRY_RUN_COMMANDS.indexOf(name) >= 0) return null;
  const why = DRY_RUN_UNSUPPORTED[name];
  if (why) return '--dry-run 对 ' + name + ' **不可用**：' + why;
  return '--dry-run 只对**会改盘的命令**有意义：' + name + ' 不写盘（它写的是项目数据之外的东西，'
    + '或者只是读）⇒ 没有"将改哪些对象"可报。写命令清单见 cli/core.js 的 DRY_RUN_COMMANDS。';
}

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
  // ⚠️ `projectName` 的默认口径是"**第一个位置参数**"（绝大多数命令如此）；位置参数不是 `_[0]` 的命令
  //    （目前只有 `migrate items <项目>`：`_[0]` 是子命令名 `items`）必须在**读盘/写盘之前**用
  //    `ctx.useProject(<真项目名>)` 自报 —— 否则"幂等键按哪个项目查/落"会落到一个不存在的项目名上，
  //    而幂等守卫是**静默**的（查不到 = 不命中 ⇒ 第二次真又执行一遍，"重试安全"是假的）。
  let projectName = args._[0];
  // 注意：`projectName` 必须在 store 之前取出 —— 校验器要拿它做 selfProject。
  // （`import-json` 的 `_[0]` 是文件路径而不是项目名，故校验器用的是 store.write 传进来的
  //   真实目标项目名 `name`，不是这里的闭包值。）
  /* 【W14】写盘前校验（安全闸门）—— **具名**，因为 dry-run 也要跑**同一份**（见下面两条写路径的
   * `if (this.dryRun)` 分支里的 `validateBeforeWrite`）。
   *
   * 为什么必须抽出来：`--dry-run` 在**任何写盘动作之前**短路（W8 的设计）⇒ 从前它跑不到这道闸，
   * 于是出现"预览说能成、真跑被拒"—— W14 实测的形状：`import-md` 的父节点已条目化且 md 有前导正文时，
   * 真跑 `exit 1`（`校验失败: detail 与 items 不一致…`），而 `--dry-run` `exit 0` 并回显"前导正文…
   * 已并入父节点 …的详情开头"✗✗（**预览说谎**比报错更贵：调用方会照它做决定）。
   *
   * 「预览与真跑**同一份判据**」是 W8 早就写进 registry 的承重性质（`import-dir` 那条 desc 的原话），
   * 只是在写盘前校验这一环上漏掉了。这里的做法是**不给 dry-run 另写一份校验**，而是把它接到
   * **真跑用的那一个函数**上（`store.write` 的 `validate` 参数就是它）⇒ 两边不可能分叉。
   *
   * ⚠️ 覆盖范围（如实说，别声称全仓）：走 `ctx.write` / `ctx.mutate` 两条写路径的命令都在内；
   *    自带预览、**不走**这两条路的命令（`import-project` / `import-dir` / `migrate items` / `apply`）
   *    仍不在内 —— 清单与出路见 `docs/ITEM-MODEL.md` 的「预览与真跑同一份判据」一节。 */
  /* ⚠️ 本函数的**实现**只在 `src/data-store.js` 的 `createProjectValidator` 那一处
   *（`校验失败: <errors>` 的文案也只在那里拼）—— GUI 的保存闸门（`main.js` 的 `project:save`）
   * 用的是**同一个工厂** ⇒ "命令行说能写、界面保存却报另一种错"这类分叉不会发生。 */
  const validateBeforeWrite = createProjectValidator(schema, PROJECTS_DIR);
  const store = createStore(PROJECTS_DIR, validateBeforeWrite);
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
  /* ---------------- 【W8】--dry-run 的本次状态（判定见 `ctx.dryRun`，算法见 `planWrite`） ----------------
   * `dryRunReported` 一旦置位，说明"这条命令的计划已经报过、并且真的没写盘" ⇒ 之后命令自己的
   * 收尾回显要带上 `DRY_RUN_TAG`（否则"已添加: n-x"会把一次没写盘的调用说成写成了）。 */
  let dryRunReported = false;
  /** 最近一次报告的计划（`--json` 时并进 JSON 的 `plan` 字段 —— 机器可判，不必解析中文） */
  let dryRunPlan = null;
  // 归属守门：认不认 `--dry-run` 只有 `dryRunRefusal` 一处判（报文与 main.js 的守门逐字相同）
  {
    const refusal = dryRunRefusal(cmdName, args.dryRun);
    if (refusal) throw new Error(refusal);
  }
  /** `read()` 读到的版本指纹。写回时交给 data-store 的**并发版本闸门**：
   *  若读与写之间别处写入过，写入会中止并报错，而不是静默抹掉那次改动。 */
  let readVersion;
  /** `--idem` 的键（在 `replayCheck` 里定下来；落账时要用它） */
  let idem = null;
  /** 埋点失败的记录（`ctx.recordVisit` 攒、`cli/main.js` 收尾统一报；见那里的说明） */
  const visitErrors = [];
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
  /**
   * 读"盘上现在这一版"给 dry-run 的计划用（**只读**；`store.read` 失败 = 盘上没有这个项目 ⇒ `null`）。
   *
   * 为什么允许失败不抛：`init` 这类命令的 dry-run 目标就是"盘上还没有的项目"
   * （真跑的日志里那条是 `created:true` + `changed:[]` —— 报告照这个说，不编假清单）。
   */
  function readBeforeForPlan() {
    try { const r = store.read(projectName); readVersion = r.version; return r.data; }
    catch (e) { return null; }
  }

  /**
   * 【W8】dry-run 计划：**唯一一处**计算并打印"这次写盘将改动哪些对象"。
   *
   * ③ 号判据（报告与真跑一致）靠的是**同一个函数、同一对输入**，不是靠盘后核对：
   *   真跑的 `changed` 由 `src/data-store.js` 的 `recordChange` 用
   *   `concurrency.changedKeys(oldData, data)` 现算；这里用**同一个** `changedKeys` 算
   *   `(盘上现有数据, 计划数据)`，并按同一口径 `.sort()`（`buildEntry` 也 sort）⇒ 两份清单可**逐字比对**。
   *
   * @param {object|null} before 盘上现有数据（`null` = 盘上没有这个项目 ⇒ 真跑记 `created:true`/`changed:[]`）
   * @param {object} after 计划写下去的那份数据
   * @returns {{created:boolean, changed:string[], changedCount:number}} 计划（`--json` 时并进输出）
   */
  function planWrite(before, after) {
    const created = (before === null || before === undefined);
    const changed = created ? [] : Array.from(concurrency.changedKeys(before, after)).sort();
    /**
     * 按对象**类型**归一的计数（`node:` / `children:` / `items:` / `item:` / `assoc:` / `meta` / `format`）。
     *
     * 为什么要多这一维：`add` / `clone` / `item-add` 会**现摇新 id**（`idGen` 含时间与随机，
     * 见 `src/markdown.js`）⇒ 计划里的 `node:<新id>` 与真跑后的 `node:<另一个新id>` **逐字不同**
     * （那是 id 生成器的随机性，不是两条口径）。类型计数把"改了什么"里**与随机无关**的那一半
     * 变成可逐字比对的读数：真跑日志的 `changed` 按同一套前缀归一后，两份类型计数必须相等 ✓。
     */
    const byKind = {};
    changed.forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); byKind[kind] = (byKind[kind] || 0) + 1; });
    const kindText = Object.keys(byKind).sort().map((k) => k + ' ' + byKind[k]).join(' · ');
    const plan = { created: created, changed: changed, changedCount: changed.length, byKind: byKind };
    if (!args.json) {
      process.stdout.write(DRY_RUN_TAG + (created
        ? '这次跑真命令会**新建**项目（没有既有对象会被改动；真跑的变更日志里 `created:true`、`changed:[]`）'
        : '这次写盘将改动 ' + changed.length + ' 个对象'
          + (kindText ? '（' + kindText + '）' : '（数据面上不会有任何改动）')
          + (changed.length ? '：' + changed.join('、') : '')) + '\n');
      process.stdout.write(DRY_RUN_TAG + '上面这份清单就是真跑后 .changes.jsonl 里那条 `changed`；'
        + '本次**一个字节都没写**（项目文件与变更日志都逐字节未动 ✓）\n');
    }
    dryRunReported = true;
    dryRunPlan = plan;
    return plan;
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

    /**
     * **记一次「AI 访问」**（热度条第三件 · C 块）：把"这次命令真的返回了哪些节点"交给
     * `src/heat-sensor.js`（上限口径与失败口径都只有那一处实现）。
     *
     * 为什么放在 ctx 上、而不是各命令自己 append：五条通道（`ai-get` / `ai-read-view` /
     * `ai-search-hit` / `ai-related-hop` / `ai-ask`）在 5 个命令文件里各写一遍，
     * 迟早有五份会漂移的口径（截断、去重、谁写 by、错了怎么办）。
     *
     * 三条边界（读这一条就够）：
     *   · **只追加**：底层是 `heat.appendEvent`（一次 appendFileSync，不读日志、不读项目文件）；
     *   · **不改输出**：本方法一个字节都不往 stdout / stderr 写 —— 失败只**记下**，
     *     由 `cli/main.js` 在命令体跑完之后统一**响亮**报出（stdout 的逐字节不变靠这条保证）；
     *   · **不阻断**：写失败 / id 不合法都**不抛**（旁路日志不许掐死读路径），但绝不静默。
     *
     * @param {string} channel `src/heat.js` 的 CHANNELS 里的通道 id（未知通道如实 dropped，不猜）
     * @param {string[]|string} nodeIds 本次**真的返回**的节点 id（按返回顺序）
     * @param {{project?:string}} [opts] 记进**哪一个项目**的日志（默认本项目）。
     *        为什么需要这个口子：`search-all` 一次返回**多个项目**的命中，而热度日志是**按项目分**的
     *        （`store.visitLogFile(name)`）—— 逐个项目调它，才能保证"p1 的命中记进 p1 的榜"。
     *        路径推导仍只有 `store.visitLogFile` 一处，本方法不拼路径 ✓
     * @returns {object} 读数（`recorded` / `dropped` / `errors` …），**调用方应当看它**
     */
    recordVisit(channel, nodeIds, opts) {
      const o = opts || {};
      const target = (o.project === undefined || o.project === null || String(o.project) === '')
        ? projectName : String(o.project);
      if (!target) return { ok: false, reason: 'no-project', channel: String(channel), recorded: 0, dropped: 0, errors: [] };
      const r = heatSensor.recordVisit(store.visitLogFile(target), channel, nodeIds, { by: writer });
      // 失败醒目（F1）：攒在 ctx 上，由 cli/main.js 在命令结束后**一处**打印 ——
      // 不在这里 print（那会插进命令的输出中间，破坏"输出逐字节不变"）。
      if (!r.ok) visitErrors.push({ channel: String(channel), reason: r.reason, errors: r.errors.slice() });
      return r;
    },
    /** 本次执行里埋点失败的记录（`cli/main.js` 收尾时统一响亮报出；**不参与任何判定**） */
    visitErrors() { return visitErrors.slice(); },

    /**
     * **自报项目名**：位置参数不是 `_[0]` 的命令（见文件头 `projectName` 的说明）必须在**读盘/写盘
     * 之前**调它。影响面只有一处：**幂等键按哪个项目查/落**（`replayCheck` 的 `readChangeEntries`
     * 与 `flushIdemRecord` 的落点）。
     *
     * 为什么要有这个口子：`migrate items <项目>` 的 `_[0]` 是子命令名 `items`，于是幂等查询会去
     * "项目 `items`"的变更日志里找键 —— **永远查不到**，而"没命中"是**静默**的：第二次调用看起来
     * 正常（exit 0）、其实**又真的执行了一遍**，调用方以为的"重试安全"根本不存在（实测抓到的形状：
     * 第二次 `--json` 输出的是**首跑那份报告**、没有 `hit` 字段）。
     */
    useProject(name) {
      if (name === undefined || name === null || String(name) === '') {
        throw new Error('useProject 需要一个项目名');
      }
      projectName = String(name);
    },

    out(text) {
      // 【W8】dry-run 短路之后，命令自己的回显也带上标记（见 DRY_RUN_TAG 的注释）：
      // 只给**每条消息的首行**加 —— 多行的续行属于同一条消息（`refBlockedError` 那种）。
      // `--json` 时不加：那个消费者的 stdout 必须仍是**一份**可解析的 JSON（标志改从 JSON 字段里读）。
      const body = (dryRunReported && !args.json) ? DRY_RUN_TAG + String(text) : String(text);
      process.stdout.write(body + '\n');
      captured.text.push(String(text));
      captureDirty = true;
    },
    // `--compact` 时输出单行 JSON：**机器消费者零损失**，省掉的纯是缩进与换行。
    outJson(obj) {
      // 【W8】dry-run 短路之后：JSON 消费者同样要能分辨"这是计划、没写盘" —— **只增字段**
      if (dryRunReported && obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj.dryRun = true;
        obj.plan = dryRunPlan;
      }
      process.stdout.write(JSON.stringify(obj, null, args.compact ? 0 : 2) + '\n');
      captured.json = obj;
      captureDirty = true;
    },
    error(msg) { throw new Error(msg); },

    /** 幂等键（`--idem <键>`；没给 = `null`）。校验在第一次写时做，见 `replayCheck`。 */
    idemKey: null,

    /**
     * 【W8】`--dry-run` 的**唯一读取点**。
     *
     * 命令层要判"这是预览还是真跑"（清理型命令的报告文案、资源复制类的物理副作用）**只读它**，
     * 不许各自去读 `ctx.args.dryRun`：判定入口一多，就必然出现"某条命令读错键名 ⇒ dry-run 静默失效、
     * 照样写盘"（本工程实测过同型的一次：`dsh-ask` 第一版把 `--dry-run` 写成 `ctx.args['dry-run']`，
     * 于是它**静默忽略**了标志、真的烧了一次模型调用 —— 见 cli/commands/dsh-ask.js 的注释）。
     * `tests/w8-dry-run.test.js` 静态把守这条契约（`cli/commands/*.js` 里出现 `args.dryRun` 即红）。
     */
    get dryRun() { return args.dryRun === true; },

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
      // ---- 【W8】--dry-run：**在任何写盘动作之前短路**（两条写路径里的一条；另一条见 mutate）----
      // 位置：在 SKIP_WRITE **之后** —— 命令自己说"这次别写"时不必报一份计划（它随后会抛拒绝原因）。
      // ⚠️ 校验**在报计划之前**：真跑就是"写盘时校验不过 ⇒ 整条命令失败、一个字节不写、也不报清单"，
      //    dry-run 要复现的是同一个结局（报出一份计划再失败 = 又一种"预览与真跑不一致"）。
      if (this.dryRun) { validateBeforeWrite(data, projectName); planWrite(readBeforeForPlan(), data); return data; }
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
      // ---- 【W8】--dry-run：在**内存里的一份拷贝**上跑**同一个改动函数**，只报告"将改哪些对象" ----
      // 为什么要跑 fn（而不是"命令自己列个清单"）：报告与真跑一致（判据③）的唯一可靠做法就是
      // **同一份逻辑**算两遍 —— 拷贝用的也是 withReplay 用的那个 `concurrency.clone`。
      // 边界（如实说）：fn 里的 `ctx.error`（节点不存在 / 重复拒绝 / 条目悬挂…）会照真跑那样抛出来
      // ⇒ dry-run 与真跑**同一套判据**（"预览说能导、真跑被拒"是 W8 最想消灭的那种落差 ✗）。
      if (this.dryRun) {
        const pre = store.read(projectName);          // 只读；项目不存在 ⇒ 这里就响亮报（与真跑一致）
        readVersion = pre.version;
        const planned = fn(concurrency.clone(pre.data));
        if (planned !== SKIP_WRITE) {
          /* 【W14】dry-run 还必须过**写盘前校验**——同一份实现（`validateBeforeWrite`）、同一份输入
           * （"将要写下去的那份数据"）⇒ 「预览说能成 ⇒ 真跑必能成；真跑必失败 ⇒ 预览必须也失败」。
           * 不跑它的实测形状见 `validateBeforeWrite` 的注释（预览 exit 0、真跑 exit 1）。
           * ⚠️ 顺序与真跑一致：真跑在 `store.write` 里**先校验、后落盘/记日志** ⇒ 这里也是
           *    **先校验、后报计划**（计划意味着"这份数据能落盘"，报在前就等于在说谎）。 */
          validateBeforeWrite(planned, projectName);
          planWrite(pre.data, planned);
        }
        // 返回值形状与 withReplay 逐字一致（命令体读 `data` / `attempts` / `merged` 三样）
        return { data: planned, attempts: 1, merged: false };
      }
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
  IdemReplay, SKIP_WRITE, GLOBAL_OPTIONS, IDEM_MAX, WRITE_COMMANDS, normalizeIdemKey, readChangeEntries,
  // ---- 【W8】写入类命令统一 --dry-run（判定 / 打印 / 短路 / 登记各只一处）----
  DRY_RUN_COMMANDS, DRY_RUN_UNSUPPORTED, DRY_RUN_TAG, dryRunRefusal
};
