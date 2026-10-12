/* ============================================================
 * src/heat-sensor.js —— 把「AI 的访问」记下来的**唯一一处埋点实现**（热度条第三件 · C 块）
 * ------------------------------------------------------------
 * 为什么单独一个文件：埋点要落到 `get` / `read` / `search` / `related` / `ask` 五条（含 MCP 同名工具）
 * 共六个命令上，它们**只许做同一件事**：把"这次真的返回了哪些节点"交给这里。
 * 各处自己 `appendEvent` + 各自截断 + 各自兜错 ⇒ 必然是五份会漂移的口径。
 *
 * ## 三条设计约束（都是本件最容易出事的点，逐条对应到这里的一个决定）
 *
 * ① **只许 O(1) 追加，不许读全量** —— 实现上只有一条路：`heat.appendEvent()`（一次
 *    `appendFileSync`）。本文件**不读**日志、**不读**项目文件、**不查**节点是否存在。
 *
 * ② **不许改命令的输出（逐字节）** —— 本文件**只返回读数**，一个字节都不往 stdout / stderr 写；
 *    要不要报错、怎么报，由调用方（`cli/main.js`）在**命令体跑完之后**决定。
 *    所以"埋点前 / 埋点后"同一命令的 stdout **必须逐字节相同**（判据见 `tests/heat.test.js` L 段）。
 *
 * ③ **上限只在这一处**（见 `LOG_MAX_PER_CALL` 与 `LOG_MAX_IDS`）—— 五种通道共用一份口径，
 *    不在命令层各写一遍（那必然漂移）。
 *
 * ## 上限口径（为什么"只记被真正返回的前缀"）
 *   一次 `read` 整项目会**带出几百个节点**，一次 `search` 命中几百条也是常事；若一条命中一行，
 *   一次调用就能写下几十 KB —— 而这是**读路径**（最高频的动作），日志会以"每次检索 × 命中数"
 *   的速度膨胀，`heat` 的窄查询窗口迟早读不完（那是**响亮报错**，但报错的根源是我们自己灌的）。
 *   所以口径是：**每条通道每次调用最多记 `LOG_MAX_PER_CALL` 行**，取**返回顺序的前缀**
 *   （返回顺序 = 重要性顺序：命中排在前面的更可能被真读）。这条口径的副作用要如实说：
 *   **排在后面的命中不会被记**，所以"热度"对"检索结果尾部"是系统性低估的 —— 这是**有意**的取舍
 *   （宁可少记，也不能让读路径把日志灌爆），并且**上限值与本说明只有这一处**。
 *
 * ## 出错怎么办（响亮，但不阻断）
 *   单个节点 id 不合法 / 写盘失败，都**不抛**（读路径不该因为旁路日志而失败）——
 *   它们被记进返回值的 `dropped` 与 `errors`，由调用方**响亮报出来**（stderr + 界面提示）。
 *   静默吞掉是本工程最重的一类损害（"没做，却看不出没做"）。
 *
 * ## 关掉它的口子（一条，明写）
 *   `MM_HEAT_SENSOR=off` ⇒ 本次进程**完全不记**（返回 `reason:'disabled'`，不静默）。
 *   它存在的原因很实在：**夹具自造日志的测试**里，被夹具调用的 CLI 命令若顺手往同一份日志里写，
 *   夹具的判据（"日志恰好 N 行"）就被自己污染了。测试在**模块顶部**显式调 `__setEnabledForTest(false)`
 *   （比环境变量更可读：一眼看出"这个文件不记访问"），生产代码永远不碰这个口子。
 * ============================================================ */
'use strict';

const heat = require('./heat.js');
const schema = require('./schema.js');

/**
 * **每条通道、每次调用最多记几行**（全工程唯一一处口径）。
 *
 * 取 20 的理由：① 它足够盖住"人/ AI 真正取回来细看的那一小撮"（`get` 一次 1 个、
 * `related` 一跳几十个但真正会被读的是前面几个）；② 它让**单次调用的日志增量**有硬上界
 * （20 行 ≈ 2 KB），于是"读路径灌爆日志"这条风险被结构性地掐住，而不是靠"应该不会太多"；
 * ③ 它远小于窄查询的一个 chunk（64 KB = 约 600 行）⇒ 一次调用最多花掉窗口容量的 1/30。
 * ⚠️ 改这个数就是改**口径**：`tests/heat.test.js` 与交付说明里的读数都跟着它走。
 */
const LOG_MAX_PER_CALL = 20;

/**
 * 一次调用**最多看几个 id**（性能闸）。它就是 `LOG_MAX_PER_CALL` 的别名 —— 只为了在代码里
 * 说清"截断发生在**进循环之前**，不是写的时候才发现超了"（避免为几百个前缀做无用的 map/set 操作）。
 */
const LOG_MAX_IDS = LOG_MAX_PER_CALL;

/** 单条 id 的守卫：与 `heat.buildEvent` 同一处规范（`src/schema.js` 的 ID_RE），不在这里另写一份 */
function idOk(id) {
  const s = String(id === undefined || id === null ? '' : id).trim();
  return !!s && !!schema.ID_RE && schema.ID_RE.test(s);
}

/** 埋点总开关（见文件头；生产代码不许碰它，只有测试在模块顶部显式关掉） */
let enabled = true;
function isEnabled() {
  if (process.env.MM_HEAT_SENSOR === 'off') return false;
  return enabled;
}
/** **只给测试用**：关掉/打开埋点。返回被换掉的那个值，便于还原。 */
function __setEnabledForTest(v) {
  const old = enabled;
  enabled = v !== false;
  return old;
}

/**
 * 记一次"AI 在某条通道上访问了这些节点"。**不抛错**（读路径不该被旁路日志掐死），
 * 失败全部折成读数交给调用方。
 *
 * @param {string} file `.visits.jsonl` 的绝对路径（由 `store.visitLogFile` 推导，别处不许自己拼）
 * @param {string} channel 通道 id（必须在 `heat.CHANNELS` 里 —— 未知通道**不猜**，如实 dropped）
 * @param {string[]|string} nodeIds 本次**真的返回**的节点 id（按返回顺序；重复会被去掉）
 * @param {{by?:string, cap?:number}} [opts] `by` = 谁在记（与变更日志同口径的 `writer`）
 * @returns {{ok:boolean, reason:string, channel:string, considered:number, unique:number,
 *            recorded:number, dropped:number, caps:number, cap:number, file:string, errors:string[]}}
 */
function recordVisit(file, channel, nodeIds, opts) {
  const o = opts || {};
  const ch = String(channel === undefined || channel === null ? '' : channel).trim();
  const report = {
    ok: false, reason: '', channel: ch,
    considered: 0, unique: 0, recorded: 0, dropped: 0,
    caps: 0, cap: LOG_MAX_PER_CALL, file: file || '', errors: []
  };
  if (!isEnabled()) {
    // ⚠️ `disabled` 是**有意的关闭**（不是失败）⇒ `ok:true`、**不进调用方的失败报表**。
    //    第一版把它当失败 ⇒ 关掉埋点的测试里每条命令都往 stderr 打一行"没能记上"，
    //    对拍直接判"逐字节不同"（实测抓到的假红）。"没打开"与"打开着却写失败"必须可分辨。
    report.ok = true; report.reason = 'disabled'; return report;
  }
  if (!file) { report.reason = 'no-file'; report.errors.push('缺少日志路径'); return report; }
  const c = heat.channelInfo(ch);
  if (!c) {
    report.reason = 'unknown-channel';
    // 报文与写入端同源（`heat.unknownChannelError`）—— 通道表只有一处，报错也只有一处
    report.errors.push(heat.unknownChannelError(ch, '埋点'));
    return report;
  }
  const raw = Array.isArray(nodeIds) ? nodeIds : (nodeIds === undefined || nodeIds === null ? [] : [nodeIds]);
  report.considered = raw.length;
  // ---- 规范化 + 去重（一次调用里同一个节点只记一次：一次 read 带出的重复 id 不该算两次访问）----
  const seen = new Set();
  const ids = [];
  let bad = 0;
  for (let i = 0; i < raw.length && ids.length < LOG_MAX_IDS; i++) {
    const id = String(raw[i] === undefined || raw[i] === null ? '' : raw[i]).trim();
    if (!id) continue;
    if (!idOk(id)) { bad++; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  report.unique = ids.length;
  if (bad) report.errors.push('有 ' + bad + ' 个 id 不合规范（小写字母/数字/连字符），已跳过不记');
  if (!ids.length) {
    report.reason = raw.length ? 'no-valid-id' : 'no-node';
    report.dropped = bad;
    report.ok = true;                      // "这次没有可记的"不是错误（项目级提问、空命中就是这种）
    return report;
  }
  // ---- 记：**逐条 O(1) 追加**（每条一次 appendFileSync，不读历史；见 heat.appendEvent）----
  let firstError = null;
  ids.forEach((id) => {
    try {
      heat.appendEvent(file, { node: id, ch: ch, by: o.by || '' });
      report.recorded++;
    } catch (err) {
      report.dropped++;
      if (!firstError) firstError = String((err && err.message) || err);
    }
  });
  if (firstError) report.errors.push('写入失败（' + report.dropped + ' 条没能记上）：' + firstError);
  report.caps = LOG_MAX_PER_CALL;
  report.ok = report.recorded > 0;
  report.reason = report.ok
    ? (raw.length > LOG_MAX_PER_CALL ? 'recorded-capped' : 'recorded')
    : 'all-failed';
  return report;
}

module.exports = {
  LOG_MAX_PER_CALL, LOG_MAX_IDS, recordVisit, isEnabled, __setEnabledForTest
};
