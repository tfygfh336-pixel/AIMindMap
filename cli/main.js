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
  // ---- 未知选项的唯一守门点（缺陷取证：写命令原先静默忽略不认识的选项，
  //      `add … --tags a,b` 打印"已添加"且 exit 0，盘上却没有标签）----
  // 为什么放在 dispatch 而不在各命令里：40+ 条命令各写一遍必然漏，且漏掉的那条**又是静默的**。
  const unknown = core.unknownOptions(rest, registry.allowedOptions(name));
  if (unknown.length) {
    process.stdout.write('error: ' + registry.unknownOptionError(name, unknown) + '\n');
    process.exitCode = 1;
    return undefined;
  }
  const ctx = core.createContext(rest, { command: name });
  return cmd.fn(ctx, rest);
}

/** Promise 是否**尚未 settle**。实测：无 await 的 async 函数 → `Promise { 1 }`；
 *  有 await → `Promise { <pending> }`。同步判据只能靠 inspect 的呈现。 */
function isPending(p) { return util.inspect(p).includes('<pending>'); }

/** 按 CLI 失败契约输出错误并置非 0 退出码（**输出到 stdout**，与历史行为一致）。 */
function fail(err) {
  process.stdout.write('error: ' + ((err && err.message) || String(err)) + '\n');
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
