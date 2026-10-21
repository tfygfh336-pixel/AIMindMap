/* ============================================================
 * cli/commands/batch.js — `batch --calls-file calls.json`：**一次进程跑多条命令**
 * ------------------------------------------------------------
 * 为什么存在（W25 实测）：一次典型任务（查 3 个词 + 读 2 个节点 + 改 1 处 + `ui-state` + `validate`）
 * 要起 **8 个 node 进程**：**5777 ms**，其中 **5471 ms（94.7%）是 Node 启动**，命令自身只占 **306 ms**。
 * 而"多跑一条命令"的增量**几乎是 0**（同一条 `edit` op 跑 1 / 2 / 3 / 5 条 = 165.0 / 157.9 / 158.9 / 136.6 ms）。
 * ⇒ 把 8 次调用塞进一个进程，实测 **950 ms**（−83.6%）。判据与脚本见 `.review/20261020-W25-perf/`。
 *
 * ## 语义（这条命令**必须**先说清楚，它决定 AI 敢不敢用）
 *
 * **逐条独立生效，失败不回滚。**
 *   第 3 条失败时，第 1、2 条**已经在盘上**了 —— 它们各自的写入是各自的一次原子写（各自的 rev）。
 *
 * 为什么不做"整批原子"（三条理由，每条都能反过来害人）：
 *   ① `apply --ops-file` **已经**是原子事务原语（一个 rev / 一次原子写 / 全成或全不动）。
 *      让 `batch` 再实现一套原子语义 = **同一个语义两处实现**，两处必然漂移。
 *   ② `batch` 要跑**任意**命令，含只读的 `search`/`get` —— 对读操作"回滚"没有意义，
 *      原子模型在通用情形下根本不成立。
 *   ③ 回滚只能靠"快照 `projects/**` 再恢复"，而本机**同时有界面与别的 agent 在写** ⇒
 *      恢复快照会**覆盖别人的写**。那是正确性风险，不是性能特性。
 *
 * ⇒ 所以出口是**精确回执**：失败时逐条给出 `code` 与各自的 `stdout`/`stderr`，
 *   调用方据此**只重试失败那几条**。要重试安全就把 `--idem <键>` 写在**子 argv** 里
 *   （与 `"dryRun"` 同一套机制；`batch` 自己**不收** `--idem` —— 见下面"为什么本命令没有 --dry-run / --idem"）。
 *
 * ## 为什么本命令没有 `--dry-run` / `--idem` / `--continue` 这三个开关
 *
 * 它们全部写在 **payload** 里（`"dryRun"` / `"continueOnError"`），原因有两条，第二条是硬的：
 *   ① **归属**：`--idem` 的作用域是"项目 × 命令"，而一个批次里可以有多个项目、多条命令
 *      ⇒ 一个批次级幂等键是个**假承诺**（它会让调用方以为"整批重试安全"）。逐条给才对。
 *   ② **`cli/core.js` 的 `parseArgs` 只认它显式登记过的纯布尔开关**（`--dry-run` 在列、`batch` 的新开关不在列）。
 *      没登记的裸布尔会被通用分支按 `--key value` 吞掉下一个 token ⇒ 那种"碰巧能用"不是契约
 *      （同一句话 `docs-gen --check` 的注释里已经写过一遍）。而**本批不许动 `cli/core.js`**，
 *      所以正解不是"去登记一下"，而是**别在命令行上造新开关** —— 反正这些参数本来就是"一批的元数据"，
 *      跟 `calls` 放一起才对。
 *
 * ## 与单独执行**同一条路**
 *
 * 子调用一律走 `cli/main.js` 的 `invokeSync()`（= `cli-integration.js` 那 140 条断言用的同一个入口），
 * **不自己拼参数、不自己判定**。于是「未知选项 / 别名归一 / `--dry-run` 归属 / `S7` 幂等守卫 /
 * `<命令> --help`」这一整套守门对每条子调用照旧生效 —— 批量化**不是后门**。
 * ⚠️ 承重条件：`require('../main.js')` 必须**惰性**（在函数里 require）。
 *    顶层 require 会踩循环依赖：`main.js` → `registry.js` → 本文件 → `main.js`，
 *    此时 `main.js` 的 exports **还没填**，拿到的就是 `{}`，而 `require` 缓存会把这个空对象
 *    **永久**留在那里（实测形状：`invokeSync is not a function`，且只在进程内调用时出现）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/** 一批最多跑多少条。为什么有上界：一次调用里每条的结果都留在内存里（回执要逐条给），
 *  没有上界 = 一次调用能把进程内存打爆（`.review/20261020-W25-perf/README.md` §6.2 记了一次
 *  `0xC0000409` 的现场，虽然不是本命令造成的，但同一类风险）。 */
const MAX_CALLS = 200;
/** 全部子调用 stdout 合计的字节省上界。**不截断**（截断会静默改变输出字节），超了**响亮报错**并给出路。 */
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;

/**
 * 读并校验 `--calls-file`。
 *
 * 支持两种形态（与 `apply --ops-file` 同一口径，不另立一套）：
 *   · **文件路径** —— `--calls-file calls.json`
 *   · **内联 JSON 文本** —— 以 `{` 或 `[` 开头即当文本（给脚本与 AI 用，省掉一次落盘）
 *
 * 错误一律带**出路**，且必须点名"第几条"（批量命令的报错不点名序号就没法修）。
 */
function readCalls(ctx) {
  const raw = ctx.args.callsFile;
  if (raw === undefined || raw === true || raw === '') {
    ctx.error('缺少 --calls-file（一个 JSON 文件路径，或**内联 JSON 文本**，形如 '
      + '`--calls-file \'{"calls":[["search","项目","关键词","--json"]]}\'`）。'
      + '要跑一条命令就别用 batch —— 直接跑那条命令。');
  }
  const text = String(raw);
  let body = text;
  let source = '（内联 JSON）';
  if (!/^\s*[[{]/.test(text)) {
    /* 路径分支：与 apply 的 readOpsFile 同形状 —— 存在性、可读性、JSON 合法性三步各给一句人话。 */
    const file = path.resolve(text);
    if (!fs.existsSync(file)) {
      ctx.error('--calls-file 指向的文件不存在: ' + text
        + '（要传内联 JSON 就让内容以 `{` 或 `[` 开头；相对路径按当前工作目录解析）');
    }
    try { body = fs.readFileSync(file, 'utf8'); }
    catch (e) { ctx.error('--calls-file 读不了: ' + text + '（' + ((e && e.message) || e) + '）'); }
    source = file;
  }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { ctx.error('--calls-file 不是合法 JSON（' + source + '）：' + ((e && e.message) || e)); }

  /* 两种顶层形态：`{version, calls, …}` 或裸数组 `[[argv], …]`。
   * 第 2 种是为了让"就地跑三条命令"这件事能一行写完（AI 手写 payload 时少一层嵌套就少一次出错）。 */
  let root;
  if (Array.isArray(parsed)) root = { calls: parsed };
  else if (parsed && typeof parsed === 'object') root = parsed;
  else ctx.error('--calls-file 的顶层必须是对象或数组（收到 ' + (parsed === null ? 'null' : typeof parsed) + '）');

  if (root.version !== undefined && root.version !== 1) {
    ctx.error('--calls-file 的 version 只支持 1（收到 ' + JSON.stringify(root.version) + '）');
  }
  if (!Array.isArray(root.calls)) {
    ctx.error('--calls-file 里缺少 calls 数组（形如 {"version":1,"calls":[["search","项目","词","--json"]]}）');
  }
  if (!root.calls.length) ctx.error('--calls-file 的 calls 是空的（一批至少要有一条命令；只跑一条就别用 batch）');
  if (root.calls.length > MAX_CALLS) {
    ctx.error('一批最多 ' + MAX_CALLS + ' 条命令（收到 ' + root.calls.length + ' 条）。'
      + '拆成几批分别跑 —— 批量的收益是"少起进程"，不是"一次塞进整个会话"');
  }

  /* 逐条查形状。**在跑第一条之前查完**（与 apply 的预检同一条纪律）：
   * 如果跑到第 5 条才发现第 3 条形状错，前 2 条已经生效了 —— 那不是"预检"，那是事后报错。 */
  const calls = [];
  for (let i = 0; i < root.calls.length; i++) {
    const at = '第 ' + (i + 1) + ' 条';
    const item = root.calls[i];
    if (!Array.isArray(item)) {
      ctx.error(at + '不是数组：每条调用必须写成 argv 数组，如 ["search","项目","词","--json"]'
        + '（收到 ' + (item === null ? 'null' : typeof item) + '）');
    }
    if (!item.length) ctx.error(at + '是空数组：至少要有一个命令名');
    for (let k = 0; k < item.length; k++) {
      if (typeof item[k] !== 'string') {
        ctx.error(at + '的第 ' + (k + 1) + ' 项不是字符串（收到 ' + typeof item[k] + '）——'
          + 'argv 必须逐项是字符串，数字/布尔请自己写成 "5" / "true"');
      }
    }
    const name = item[0];
    if (!name.trim()) ctx.error(at + '的命令名是空字符串');
    /* 嵌套 batch：批里套批 = 无界递归 + 退出码归属说不清（内层的失败到底是"这一条失败"还是"整批失败"）。
     * 要跑很多条就写成一批，别套。 */
    if (name === 'batch') {
      ctx.error(at + '又是 batch（批里套批）—— 不允许：它会让退出码与回执的归属说不清。'
        + '把那些命令直接平铺进这一批即可');
    }
    // `--` 之后的内容不再解析（本工程的 argv 里没有 shell，`--` 只会被当成一个位置参数）
    if (item.indexOf('--') >= 0) {
      ctx.error(at + '里有 `--`：本命令的 argv 不经过任何 shell，`--` 不会被当成"选项结束符"，'
        + '只会变成子命令的一个位置参数 ⇒ 请去掉它');
    }
    calls.push({ index: i, argv: item.slice() });
  }

  /* dryRun 写在 payload 里（命令行上没有这个开关，理由见文件头）。
   * 只做**布尔**：字符串 "false" 会被 `=== true` 静默判成 false，那正是本工程反复治的那种静默。 */
  if (root.dryRun !== undefined && typeof root.dryRun !== 'boolean') {
    ctx.error('dryRun 必须是布尔 true / false（收到 ' + JSON.stringify(root.dryRun) + '）——'
      + '不写就等于 false；写 "false"（字符串）会被当成真值读，故一律**响亮拒绝**');
  }
  if (root.continueOnError !== undefined && typeof root.continueOnError !== 'boolean') {
    ctx.error('continueOnError 必须是布尔 true / false（收到 ' + JSON.stringify(root.continueOnError) + '）');
  }

  return {
    calls,
    dryRun: root.dryRun === true,
    continueOnError: root.continueOnError === true,
    source
  };
}

/** 把一条 argv 里的 `--dry-run` 位置补齐（只在 payload 要干跑时用）。
 *  判据必须是 `cli/core.js` 的 `DRY_RUN_COMMANDS`（**唯一一处**说"哪些命令认这个开关"）——
 *  在 `search` 这类只读命令上加 `--dry-run` 会被守门响亮拒绝，那样整批都会因为"干跑"而失败，
 *  而失败原因与被测的改动毫无关系。 */
function injectDryRun(argv) {
  if (argv.indexOf('--dry-run') >= 0) return argv.slice();
  const core = require('../core.js');
  const name = argv[0];
  const cmd = require('../registry.js').get(name);
  const canonical = (cmd && cmd.name) || name;
  if (core.DRY_RUN_COMMANDS.indexOf(canonical) < 0) return argv.slice();
  /* 插在**命令名之后、位置参数之前**：`--dry-run` 是纯布尔开关，任何位置都认，
   * 但放在最前面能保证它不会被某个带值选项的 `--key value` 形态吞掉。 */
  return [argv[0], '--dry-run'].concat(argv.slice(1));
}

/**
 * `batch --calls-file calls.json [--json]`
 *
 * 逐条跑、逐条回执。失败语义见文件头：**前 N 条保留，不整体回滚**。
 */
function batch(ctx) {
  const plan = readCalls(ctx);
  /* 惰性 require（承重，见文件头）：顶层 require 会拿到循环依赖里那个**尚未填好**的 `main.js`。 */
  const main = require('../main.js');

  const results = [];
  let failed = 0;
  let stoppedAt = null;
  let totalChars = 0;

  for (const c of plan.calls) {
    const argv = plan.dryRun ? injectDryRun(c.argv) : c.argv;
    const r = main.invokeSync(argv);          // ← 与单独执行**同一个入口**（含全部守门）
    const rec = { i: c.index, argv: argv, code: r.code, stdout: r.stdout || '', stderr: r.stderr || '' };
    results.push(rec);
    totalChars += rec.stdout.length + rec.stderr.length;
    if (rec.code !== 0) {
      failed++;
      if (!plan.continueOnError) { stoppedAt = c.index; break; }
    }
    if (totalChars > MAX_TOTAL_CHARS) {
      /* **不截断**（截断 = 静默改变输出字节），改成响亮报错并点名已跑到哪一条。
       * 已生效的调用**不会**被撤回（见文件头的语义），所以这里必须说清"前面那些已经生效"。 */
      stoppedAt = c.index;
      break;
    }
  }

  const truncatedByBudget = totalChars > MAX_TOTAL_CHARS;
  const summary = {
    total: results.length,
    ok: results.filter((x) => x.code === 0).length,
    failed: failed,
    stoppedAtIndex: stoppedAt
  };

  /* ---------- --json：一份可解析的 JSON（键序固定、无时间戳 ⇒ 同一状态两跑逐字节相同） ---------- */
  if (ctx.args.json) {
    const out = {
      command: 'batch',
      version: 1,
      dryRun: plan.dryRun,
      continueOnError: plan.continueOnError,
      results: results.map((x) => ({
        i: x.i,
        argv: x.argv,
        code: x.code,
        stdout: x.stdout,
        stderr: x.stderr
      })),
      summary: summary
    };
    if (truncatedByBudget) {
      out.error = '这一批的输出超过 ' + MAX_TOTAL_CHARS + ' 字节省上界，已在第 '
        + (stoppedAt + 1) + ' 条之后停止；前面 ' + summary.total + ' 条**已经执行**（不会撤回）。'
        + '把这一批拆小，或改用 --brief / --limit 减小单条输出';
    }
    ctx.outJson(out);
    if (failed || truncatedByBudget) process.exitCode = 1;
    ctx.setIdemResult('batch：' + summary.total + ' 条，失败 ' + failed + ' 条');
    return;
  }

  /* ---------- 文本档 ----------
   * 失败时**首行必须是 `error:`**（这是本工程对文本消费者的失败契约，见 `cli/mm-cli.js` 头部：
   * "失败：退出码非 0 ＋ stdout 输出 error: <原因>"）。回执跟在后面 —— 调用方既要"知道错了"，
   * 也要"知道哪几条已经生效"，两样都不能省。 */
  if (failed || truncatedByBudget) {
    const why = truncatedByBudget
      ? '输出超过 ' + MAX_TOTAL_CHARS + ' 字节省上界，已在第 ' + (stoppedAt + 1) + ' 条之后停止'
      : '第 ' + (stoppedAt + 1) + ' 条失败' + (plan.continueOnError ? '' : '（已停止，后面的没跑）');
    const kept = summary.ok;
    process.stdout.write('error: batch 这一批' + why + '；'
      + (kept > 0
        ? '前 ' + kept + ' 条**已经生效**（逐条独立写入，不整体回滚）'
        : '还没有任何一条生效')
      + '。要只重试失败的：把它们单独组成新的一批。\n');
  } else {
    ctx.out('batch 完成：' + summary.total + ' 条全部成功（' + (plan.dryRun ? '干跑，未写盘' : '逐条独立生效') + '）。');
  }

  results.forEach((r) => {
    const tag = r.code === 0 ? 'ok  ' : 'FAIL';
    const detail = r.code === 0
      ? (r.stdout.length + ' 字')
      : (String(r.stdout || r.stderr).split('\n')[0] || ('code ' + r.code));
    ctx.out('  [' + (r.i + 1) + '/' + plan.calls.length + '] ' + tag + '  '
      + r.argv.join(' ') + '   → ' + detail);
  });
  if (plan.dryRun) {
    ctx.out('（payload 里 dryRun=true：上面前缀 `[dry-run 未写盘]` 的那些回执都是预览，盘上零改动）');
  }

  ctx.setIdemResult('batch：' + summary.total + ' 条，失败 ' + failed + ' 条');
  if (failed || truncatedByBudget) process.exitCode = 1;
}

module.exports = { batch };
