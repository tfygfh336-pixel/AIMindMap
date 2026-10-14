/* ============================================================
 * cli/main.js — CLI 的**可进程内调用**入口（同步 + 异步两条）
 * ------------------------------------------------------------
 * 为什么存在：`scripts/cli-integration.js` 原先对每条断言**起一个 Node 进程**
 *   （`spawnSync`）。实测 140 条断言 / 102 s ≈ **0.73 s/条**，而每条的真实校验逻辑
 *   只有几毫秒 —— 绝大部分是进程冷启动。导出纯函数后可在**同进程内**逐条调用。
 *
 * 两个入口：
 *   - `invoke(argv)`     **异步**：供进程内但愿意 await 的调用方（MCP / Electron 主进程 / 测试）。
 *   - `invokeSync(argv)` **同步**：供**直线式**同步断言序列（`scripts/cli-integration.js`
 *                        的 140 条断言就是这种形状；改 async 要动近 200 个调用点）。
 *
 * 为什么可以有「同步版」（**这是一条显式不变量**）：
 *   `cli/commands/*.js` 全部写成 `async function`，但**没有任何一处 `await`**，
 *   也没有 `.then()` / `fs.promises` / `setTimeout` 等异步 API（全树 grep 为 0）。
 *   JS 里 async 函数体在遇到第一个 `await` 之前是**同步执行**的，所以这些命令实际上是
 *   同步完成的，`cmd.fn()` 返回的是一个**已 resolve** 的 Promise。
 *   ⇒ 一旦有人给命令加了 `await`，`invokeSync` 会**立刻抛错**（靠 `util.inspect` 看是否仍是
 *   `<pending>`；实测可区分 `Promise { 1 }` 与 `Promise { <pending> }`），同时
 *   `tests/cli-sync-invariant.test.js` 会**先变红**。两道防线，都不静默降级。
 *
 * 对外契约（**与子进程模式逐字节一致**，不得改变）：
 *   - 返回 `{ code, stdout, stderr }`；`stdout` 与 `node cli/mm-cli.js <args>` 逐字节相同
 *   - `code`：0 = 成功；1 = 失败（未知命令 / **未知选项** / 命令内 throw / 命令自行置非 0）
 *   - 失败时 stdout 以 `error: ` 开头（文本辅助判据；**退出码是首选判据**）
 *   - `<命令> --help` 打印该命令的用法与**支持集**（退出码 0，不执行命令）
 *
 * 两条硬约束：
 *   1. **不调用 `process.exit`** —— 会连带杀死宿主（MCP / Electron 主进程 / 测试进程）；
 *   2. **进出隔离 `process.exitCode`** —— 它是全局态，且 `validate` / `validate-all` 会
 *      **自行置非 0** 表达失败（不抛异常），故 code 必须读回而不能只看抛没抛错。
 * ============================================================ */
'use strict';

const util = require('util');
const registry = require('./registry.js');
const core = require('./core.js');

/** 捕获 `process.stdout` / `process.stderr` 的写入。
 *  为什么用拦截而不是「让命令返回字符串」：命令层是 `(ctx, args) => void`，输出散落在
 *  `ctx.out` / `ctx.outJson` / `console.log` 多处（`cli/commands/*.js` 共 7 个文件）。
 *  拦截 stream 是**唯一**能保证输出逐字节不变、且不改动那 7 个文件的做法。 */
function captureStreams() {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;

  const mk = (chunks) => function write(chunk, enc, cb) {
    if (typeof chunk === 'string') chunks.push(chunk);
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString(typeof enc === 'string' ? enc : 'utf8'));
    else chunks.push(String(chunk));
    // 透传回调约定，避免调用方（console.log）把「没有回调」当成写失败
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };

  process.stdout.write = mk(outChunks);
  process.stderr.write = mk(errChunks);

  return {
    restore() { process.stdout.write = origOut; process.stderr.write = origErr; },
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join('')
  };
}

function usage() {
  const lines = ['AI MindMap CLI v' + (require('../package.json').version || '0.0.0'), ''];
  lines.push('用法: node cli/mm-cli.js <command> [参数...]');
  lines.push('');
  lines.push('命令:');
  const cmds = registry.list();
  const w = Math.max.apply(null, cmds.map((c) => (c.name + (c.aliases && c.aliases.length ? ' (' + c.aliases.join(',') + ')' : '')).length));
  cmds.forEach((c) => {
    const alias = c.aliases && c.aliases.length ? ' (' + c.aliases.join(',') + ')' : '';
    lines.push('  ' + (c.name + alias).padEnd(w + 2) + c.usage || c.desc || '');
  });
  lines.push('');
  lines.push('提示：命令后加 --json 以 JSON 输出（供 AI / MCP 解析）。');
  return lines.join('\n');
}

/** 单命令帮助（`<命令> --help`）：把该命令**支持哪些选项**整份打印出来。
 *  为什么必须有：未知选项现在会响亮报错（见下），那调用方就需要一个"我到底能写什么"的正规入口；
 *  而报错文本里也只能给出支持集，讲不清每项的语义。 */
function commandHelp(cmd) {
  const keys = registry.allowedOptions(cmd.name);
  const lines = ['AI MindMap CLI — ' + cmd.name, ''];
  lines.push('用法: node cli/mm-cli.js ' + (cmd.usage || cmd.name));
  lines.push('支持的选项: ' + (keys.length ? keys.map((k) => '--' + registry.kebab(k)).join(' ') : '（无）'));
  if (cmd.desc) { lines.push(''); lines.push(cmd.desc); }
  lines.push('');
  lines.push('提示：`--compact` 与 `--json` 一起用（单行 JSON）；未列出的选项一律报错并非 0 退出。');
  return lines.join('\n');
}

/** 选命令、建 ctx、调用。**刻意不 await** —— 由 `invoke` / `invokeSync` 各自决定。
 *  返回命令返回的 Promise（或 undefined，表示已就地处理完）。 */
function dispatch(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(usage() + '\n');
    return undefined;
  }
  const name = argv[0];
  const rest = argv.slice(1);
  const cmd = registry.get(name);
  if (!cmd) {
    process.stdout.write('error: 未知命令: ' + name + '（node cli/mm-cli.js --help 查看全部）\n');
    process.exitCode = 1;
    return undefined;
  }
  if (rest.indexOf('--help') >= 0 || rest.indexOf('-h') >= 0) {
    process.stdout.write(commandHelp(cmd) + '\n');
    return undefined;
  }
  // ---- 【W8】`--dry-run` 的**归属守门**（与下面那条 `--idem` 同一形状、同一处）----
  // 为什么要在这里：`--dry-run` 是**写管道流（W8）的横切开关**，但只对「会改盘的命令」有意义。
  // 不许默默忽略（那正是本工程反复修掉的那类病）：调用方带 `--dry-run` 的**意图**是"先看计划、
  // 别写盘"，而在不认它的命令上它什么都不做 ⇒ 人家会以为自己审过了（一次静默 = 一个错觉）。
  // 拒绝报文也在这里**一处**给出（`cli/core.js` 的 `dryRunRefusal` 是唯一判定，命令清单同源）。
  // ⚠️ 用 `cmd.name`（正式名）而不是 `name`（可能是别名）：`rm --dry-run` 与 `remove --dry-run` 同待遇。
  {
    const dryMsg = core.dryRunRefusal(cmd.name, core.parseArgs(rest).dryRun);
    if (dryMsg) {
      process.stdout.write('error: ' + dryMsg + '\n');
      process.exitCode = 1;
      return undefined;
    }
  }
  // ---- 未知选项的唯一守门点（缺陷取证：写命令原先静默忽略不认识的选项，
  //      `add … --tags a,b` 打印"已添加"且 exit 0，盘上却没有标签）----
  // 为什么放在 dispatch 而不在各命令里：40+ 条命令各写一遍必然漏，且漏掉的那条**又是静默的**。
  const unknown = core.unknownOptions(rest, registry.allowedOptions(name));
  if (unknown.length) {
    process.stdout.write('error: ' + registry.unknownOptionError(name, unknown) + '\n');
    process.exitCode = 1;
    return undefined;
  }
  // ---- 单短横线选项的守门点（缺陷取证：`read -x` 原先报"项目不存在: -x"）----
  // 上面的 unknownOptions 只认 `--xxx`（它按 `a.slice(0, 2) !== '--'` 直接跳过单横线），
  // 于是 `-x` 一路落到位置参数 ⇒ 被当成项目名 ⇒ **响亮，但原因错**：调用方会去查
  // "项目 -x 为什么不存在"，而真因是"这个选项写错了"。诊断方向一错，弯路就长了。
  // ⚠️ 顺序：必须在上面 `-h` 短路**之后** —— `-h` 是工程既有语义（`<命令> -h` 打印该命令用法），
  //    有语义的短选项一律保留 ✓，别把正常用法判死 ✗。
  // ⚠️ 只看**位置参数**：被当作选项值的 `-x`（如 `--topic -x`）是正常用法，拿原始 argv 扫会误杀 ✗。
  const shortBad = core.unknownShortOptions(core.parseArgs(rest)._, core.SHORT_OPTIONS);
  if (shortBad.length) {
    process.stdout.write('error: ' + registry.unknownShortOptionError(name, shortBad) + '\n');
    process.exitCode = 1;
    return undefined;
  }
  // ---- 幂等键的**归属守门**（S7）：只读命令带 `--idem` 一律响亮拒绝 ----
  // 为什么不能默默忽略（那正是本次要修的那类病）：调用方带 `--idem` 的**意图**是"重试安全"，
  // 而在不写盘的命令上它什么都不做 ⇒ 人家会以为自己拿到了重试安全（一次静默 = 一个错觉）。
  // 判定放在 dispatch（与未知选项同一处），因为它是**跨命令**的横切规则，不是某条命令的语义。
  if (core.parseArgs(rest).idem !== undefined && core.WRITE_COMMANDS.indexOf(name) < 0) {
    process.stdout.write('error: --idem 只对**写命令**有意义：' + name + ' 不写盘（不会重复生效，'
      + '因此不需要幂等键）。写命令清单见 cli/core.js 的 WRITE_COMMANDS。\n');
    process.exitCode = 1;
    return undefined;
  }
  const ctx = core.createContext(rest, { command: name });
  /* 访问埋点（热度条第三件 · C）：给命令层一个**薄转发** —— `ctx.recordVisit` 与本块都要用到
   * `ctx.store`（日志路径的唯一推导处）与 `ctx.writer`（"谁记的"）。命令层直接 import `ctx.store`
   * 就是第二处路径推导，所以只交出"路径 + 谁在记"这两样，**不交出更宽的口子** ✓ */
  ctx.heatContext = {
    logFile: name ? (function () { try { return ctx.store.visitLogFile(ctx.projectName); } catch (e) { return null; } })() : null,
    by: ctx.writer
  };
  // ---- 写命令的幂等短路（S7）：`--idem` 命中时**这条命令根本不执行** ----
  // 为什么把回放放在这里（dispatch）而不是各命令里：与"未知选项守门"同一个理由 ——
  // 40+ 条写命令各写一遍必然漏，而漏掉的那条**又是静默的**（重试照样重复生效）。
  // 判定在 `cli/core.js` 的 replayCheck（`ctx.mutate` / `ctx.write` 两条路径共用一个入口），
  // 这里只负责**接住 IdemReplay 并回放首次结果**（回显里含「幂等命中」）。
  try {
    const r = cmd.fn(ctx, rest);
    // 命令体跑完 ⇒ 把"首次回显"补进那条幂等记录（写命令的收尾回执在写盘**之后**才打印，
    // 所以这一步只能在这里做；它只补日志的一个可选字段，不改数据、不改 stdout ✓）
    ctx.flushIdemRecord();
    reportVisitErrors(ctx);
    return r;
  } catch (err) {
    if (err && err.name === 'IdemReplay') { replayIdem(ctx, name, err.idem); return undefined; }
    reportVisitErrors(ctx);
    throw err;
  }
}

/**
 * **访问埋点的失败要响亮**（热度条第三件 · C 块）。
 *
 * 为什么在这里、而不是各命令里：埋点（`ctx.recordVisit`）跨 5 个命令，
 * 而"失败怎么报"必须**只有一处**（与 `cli/core.js` 的 `flushIdemRecord` 同一条理由）。
 *
 * 两条硬约束决定了这个落点：
 *   ① **stdout 逐字节不变** —— 所以一个字节都不往 stdout 写（埋点是旁路的旁路，
 *      它坏掉不许污染主干的输出）；打到 **stderr**：人是"黑底终端里能看见"，
 *      MCP 侧 `runCli` 把 stderr 合并进 error 文本 ⇒ AI 也看得见；
 *   ② **不阻断**：命令已经成功跑完了，这里只是把"没记上"这件事喊出来 ——
 *      它不影响退出码（退出码仍由命令本身决定）。
 *
 * ⚠️ 与 `cli/core.js` 的变更日志失败同型：**警告进 stderr、数据/输出不动**。
 */
function reportVisitErrors(ctx) {
  let list = [];
  try { list = ctx.visitErrors ? ctx.visitErrors() : []; } catch (e) { list = []; }
  if (!list.length) return;
  const body = list.map((x) => '\n  · 通道 ' + x.channel + '：' + (x.reason || '失败')
    + (x.errors && x.errors.length ? ' —— ' + x.errors.join('；') : '')).join('');
  process.stderr.write('warning: 访问热度日志没能记上这次访问（读路径不受影响，热度会**少算**）'
    + body + '\n  · 出处：src/heat-sensor.js（上限与失败口径的唯一一处）\n');
}

/**
 * 回放"幂等命中"（首次执行的回显）。
 *
 * 三件事必须同时做到：
 *   ① **说出来**：回显里含「幂等命中」四个字 —— 调用方（AI / 脚本）要靠它分辨
 *      "这次没执行"与"执行成功了"（两者的退出码都是 0，只看码分不出来）；
 *   ② **返回首次结果**：把第一次写成功时记在 `.changes.jsonl` 里的回显原样复述
 *      （所以 `add` 重放会给出**首次**那个 id，而不是新造一个）；
 *   ③ **不改数据**：命中路径一次盘都不写（守卫在写盘之前抛，见 core.js 的 replayCheck）。
 *
 * `--json` 时输出**结构化**的回放对象（`hit:true`）：机器可判、不必去解析中文文案。
 * 末尾不再追加文本行 —— JSON 消费者的 stdout 必须仍然是**一份**可解析的 JSON。
 */
function replayIdem(ctx, name, info) {
  const r = String((info && info.result) || '');
  if (ctx.args.json) {
    ctx.outJson({
      command: name,
      idem: info.key,
      hit: true,
      rev: info.rev,
      version: info.version,
      result: r
    });
    return;
  }
  if (r) ctx.out(r);
  ctx.out('已在本项目生效过（第 ' + info.rev + ' 次写入）'
    + ' ⇒ 幂等命中：本次**未执行** ' + name + '、盘上数据未改动（键 ' + info.key + '）。');
}

/** Promise 是否**尚未 settle**。实测：无 await 的 async 函数 → `Promise { 1 }`；
 *  有 await → `Promise { <pending> }`。同步判据只能靠 inspect 的呈现。 */
function isPending(p) { return util.inspect(p).includes('<pending>'); }

/** 按 CLI 失败契约输出错误并置非 0 退出码（**输出到 stdout**，与历史行为一致）。
 *  `MM_DEBUG=1` 时**额外**打一行栈到 stderr（同一进程流的另一个口，失败契约与退出码都不动）——
 *  为什么要有它：`fail()` 只说 `err.message`，而命令内部的 `TypeError` 消息（如
 *  `Cannot read properties of undefined`）**不带位置**，定位只能靠猜。默认**一个字都不多打**。 */
function fail(err) {
  process.stdout.write('error: ' + ((err && err.message) || String(err)) + '\n');
  if (process.env.MM_DEBUG && err && err.stack) process.stderr.write(String(err.stack) + '\n');
  process.exitCode = 1;
}

/** 进入捕获态：接管 stdout/stderr，并把 `process.exitCode` 隔离成「本次调用的」。 */
function beginCapture() {
  const cap = captureStreams();
  const prevExitCode = process.exitCode;
  process.exitCode = undefined; // 隔离：否则上一次调用遗留的 1 会被当成本次失败
  return { cap, prevExitCode };
}

/** 退出捕获态：读回 exitCode 判定成败，复原 stream 与调用方原有的 exitCode。 */
function endCapture(cap, prevExitCode) {
  const code = (process.exitCode === undefined || process.exitCode === 0) ? 0 : 1;
  cap.restore();
  process.exitCode = prevExitCode;
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

/**
 * **异步**执行一条 CLI 命令（进程内）。
 * @param {string[]} argv 不含 `node` 与脚本名，等价于 `process.argv.slice(2)`
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
async function invoke(argv) {
  const { cap, prevExitCode } = beginCapture();
  try {
    const p = dispatch(argv);
    if (p) await p; // 真异步命令在这里被等到
  } catch (err) { fail(err); }
  return endCapture(cap, prevExitCode);
}

/**
 * **同步**执行一条 CLI 命令（进程内）—— 供直线式同步断言序列使用。
 * 依赖「`cli/commands/*` 命令体不含 await」这条不变量；一旦被违反，**立刻抛错**而非静默降级
 * （否则调用方会拿到一个尚未跑完的结果，断言会以难以定位的方式失败）。
 * @param {string[]} argv
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function invokeSync(argv) {
  const { cap, prevExitCode } = beginCapture();
  try {
    const p = dispatch(argv);
    if (p && typeof p.then === 'function' && isPending(p)) {
      throw new Error('CLI 命令未同步完成（Promise 仍是 pending）：命令体里出现了 await，'
        + '与「cli/commands/* 必须同步完成」的不变量冲突 —— scripts/cli-integration.js 的同步断言序列依赖它。'
        + '修正方式二选一：去掉该 await，或把调用方改为 await cli/main.js 的 invoke()。'
        + '（该不变量由 tests/cli-sync-invariant.test.js 静态把守。）');
    }
  } catch (err) { fail(err); }
  return endCapture(cap, prevExitCode);
}

module.exports = { invoke, invokeSync, usage };
