#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-token-ratio.js — 实测 DSH token 启发式的**真实偏差**
 * ------------------------------------------------------------
 * **存在的唯一理由**：DSH 的 token 估算是硬编码启发式
 * （`dsh-token-meter/lib/index.js:16` `const CHARS_PER_TOKEN = 4;`），
 * 官方自己承认「**CJK text and JSON schemas underprice badly at four characters per token**」
 * （同包 README.md:64/148）。而这个估计量**直接决定压缩何时触发**
 * （`dsh-compaction-basic/lib/index.js:899-900` 拿 `measure().totalTokens` 比 `floor(contextWindow × thresholdRatio)`）。
 *
 * 估算偏小 ⇒ 阈值在**真实用量早已超过**时才触发 ⇒ 压缩来得比设计意图晚。
 *
 * **改不了它，但可以量出它偏多少**：DSH 把**成对的两个数**明文落在会话投影缓存里 ——
 *   · `record.rows.contextPressure.val.pressureTokens`  = provider 报的**真实** prompt 量
 *   · 同处的 `surfaceTokens` / `sampledSurfaceTokens` = **启发式**量
 * 于是本脚本**离线**（零 API 成本、可复现）算出真实比值分布。
 *
 * ⚠️ **三条不能含糊的口径**（都是实测踩出来的）：
 *  1. 字段路径是 `record.rows.contextPressure.val`，**不是**顶层 `contextPressure.val` ——
 *     按后者扫会得出"249 个文件、0 个样本"的**假结论**。
 *  2. **只给分布与中位，不给"万能倍数"**：实测 231 个样本里比值从 **0.995 到 4.197**，
 *     单样本波动极大（比值随中文/JSON 占比变化）。而且比值**可以 < 1**（启发式偶尔反而高估）
 *     ⇒ "启发式总是低估"这句话本身也是错的。
 *  3. **样本来自哪个 home 必须写清楚**：本机有两套 DSH home ——
 *     当前 harness 的 `~/.dsh`（有 249 个会话）与 AI MindMap 内嵌实例的 `%APPDATA%\AI MindMap\dsh-home`
 *     （**零会话**）。拿 A 的样本去说 B 的行为属**跨实例推断**（模型与语料都可能不同），必须标注。
 *
 * 用法：
 *   node scripts/dsh-token-ratio.js [--home <dshHome>] [--json] [--min-real <n>]
 * 默认 `--home` = AI MindMap 内嵌实例（`%APPDATA%\AI MindMap\dsh-home`）。
 * 退出码：home 目录不存在 = 1（多半是路径给错）；**有 home 但无样本 = 0**（那是有效结论，不是错误）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 内嵌实例的 home（与 `main-dsh-sidebar.js:82` 的 `dshHome()` 同址；此处不 require 主进程代码）
 *  ⚠️ 目录名是 **`AI MindMap`** —— "AI" 后一个空格、**MindMap 是一个词**。
 *  实测（按码点核对）：`65,73,32,77,105,110,100,77,97,112`。
 *  写成 `AI Mind Map`（空格位置不同）`Test-Path` 为 **False** —— 这个拼写错误在本任务的三路侦察里都出现过。 */
function embeddedHome() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'AI MindMap', 'dsh-home');
}

/** 会话投影缓存目录 */
function projCacheDir(home) {
  return path.join(home, 'storages', 'session_projcache', 'sessions');
}

/**
 * 从一个 projcache 记录的**已解析对象**里取出成对样本。
 * 纯函数（不碰 fs），便于用 fixture 单测。
 * @returns {{sessionId:string, real:number, heuristic:number, sampled:number|null, ratio:number}|null}
 */
function sampleFromRecord(rec) {
  const cp = rec && rec.record && rec.record.rows && rec.record.rows.contextPressure;
  const v = cp && cp.val;
  if (!v) return null;
  const real = v.pressureTokens;
  const heuristic = v.surfaceTokens;
  if (typeof real !== 'number' || typeof heuristic !== 'number') return null;
  // 退化样本：provider 报 0 而启发式 > 0（实测有，多半是最后一次请求没成）。
  // 它会让 min 变成 0、把分布拉开到无意义 —— 必须排除，但**要计数**而不是悄悄丢掉。
  if (!(real > 0) || !(heuristic > 0)) return null;
  const id = (rec.record.identity && (rec.record.identity.sessionId || rec.record.identity.id)) || '(未知会话)';
  return {
    sessionId: String(id),
    real,
    heuristic,
    sampled: typeof v.sampledSurfaceTokens === 'number' ? v.sampledSurfaceTokens : null,
    ratio: real / heuristic
  };
}

/** 投影里到底有没有 contextPressure（用于区分"没有样本"与"样本不可用"） */
function hasPressure(rec) {
  const cp = rec && rec.record && rec.record.rows && rec.record.rows.contextPressure;
  return !!(cp && cp.val);
}

/** 从 home 收集样本。返回 {home, homeExists, dir, dirExists, files, samples, degenerate, unreadable} */
function collect(home) {
  const dir = projCacheDir(home);
  const homeExists = fs.existsSync(home);
  const dirExists = fs.existsSync(dir);
  if (!dirExists) return { home, homeExists, dir, dirExists: false, files: 0, samples: [], degenerate: 0, unreadable: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const samples = [];
  let degenerate = 0, unreadable = 0;
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const s = sampleFromRecord(rec);
      if (s) samples.push(s);
      else if (hasPressure(rec)) degenerate++;   // 有 contextPressure 但数值不可用
    } catch (e) { unreadable++; }
  }
  return { home, homeExists, dir, dirExists: true, files: files.length, samples, degenerate, unreadable };
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/**
 * 汇总比值分布。**只给分布与中位** —— 单样本不可用于外推（见文件头口径 2）。
 * @param {Array} samples sampleFromRecord 的产物
 * @param {{minReal?:number}} [opts] minReal：只统计真实量 ≥ 该值的样本（默认 0）
 */
function summarize(samples, opts) {
  const minReal = (opts && opts.minReal) || 0;
  const kept = samples.filter((s) => s.real >= minReal);
  const rs = kept.map((s) => s.ratio).sort((a, b) => a - b);
  if (!rs.length) return { n: 0, minReal, median: null, mean: null, min: null, max: null, p10: null, p90: null, underPct: null };
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const median = quantile(rs, 0.5);
  return {
    n: rs.length,
    minReal,
    min: rs[0],
    p10: quantile(rs, 0.1),
    median,
    mean,
    p90: quantile(rs, 0.9),
    max: rs[rs.length - 1],
    underPct: (median - 1) * 100,          // 中位低估百分比（负值=高估）
    belowOne: rs.filter((r) => r < 1).length
  };
}

function fmt(n, d) { return n === null || n === undefined ? '—' : Number(n).toFixed(d === undefined ? 3 : d); }

/** 渲染文本报告 */
function renderReport(home, res, opts) {
  const o = opts || {};
  const out = [];
  out.push('DSH token 启发式偏差实测（来源：' + home + '）');
  out.push('');
  out.push('⚠️ 口径：');
  out.push('   1. 字段路径是 record.rows.contextPressure.val（不是顶层 contextPressure.val）');
  out.push('   2. **只给分布与中位**：单样本波动很大，且比值可以 < 1（启发式偶尔反而高估）');
  out.push('   3. 样本来自**上面这个 home**；拿去说另一个实例的行为属跨实例推断，必须标注');
  out.push('');
  if (!res.homeExists) {
    out.push('✗ home 目录不存在：' + home);
    out.push('  ⇒ 路径给错了。本机两套 home：');
    out.push('     · 当前 harness        ' + path.join(os.homedir(), '.dsh'));
    out.push('     · AI MindMap 内嵌实例 ' + embeddedHome());
    return out.join('\n');
  }
  if (!res.dirExists) {
    out.push('✗ home 存在，但里面没有 ' + path.join('storages', 'session_projcache', 'sessions'));
    out.push('  ⇒ **这是有效结论，不是路径错误**：该实例**从未产生过可校准的会话**。');
    out.push('     （实测：AI MindMap 内嵌实例正是这种状态。）');
    out.push('  ⇒ **不得**据此宣称"启发式准确"（无样本 ≠ 偏差为 1）；');
    out.push('     也**不得**把另一个 home 的数字当成它的实测 —— 那属**跨实例推断**，须显式标注。');
    return out.join('\n');
  }
  out.push('会话投影文件：' + res.files + ' 个'
    + (res.unreadable ? '（读不了/结构不符 ' + res.unreadable + ' 个，已跳过）' : '')
    + (res.degenerate ? '（**退化样本 ' + res.degenerate + ' 个已排除**：provider 报 0 而启发式 >0）' : ''));
  const s = summarize(res.samples, { minReal: o.minReal });
  if (!s.n) {
    out.push('');
    out.push('✗ **可算比值的样本 = 0** —— 这是一个**有效结论**，不是"偏差为 1"：');
    out.push('  该实例没有产生过可校准的会话（或投影里缺 contextPressure）。');
    out.push('  ⇒ **不得**据此宣称"启发式准确"；也**不得**借用别的 home 的数字当它的实测。');
    return out.join('\n');
  }
  out.push('可算比值样本：' + s.n + ' 个' + (s.minReal ? '（仅真实量 ≥ ' + s.minReal + '）' : ''));
  out.push('');
  out.push('  比值（真实 prompt 量 ÷ 启发式量）');
  out.push('    min ' + fmt(s.min) + '   p10 ' + fmt(s.p10) + '   **中位 ' + fmt(s.median) + '**   p90 ' + fmt(s.p90) + '   max ' + fmt(s.max));
  out.push('    均值 ' + fmt(s.mean) + '（中位与均值差距大 ⇒ 长尾，**用中位**）');
  out.push('    比值 < 1 的样本：' + s.belowOne + ' / ' + s.n + '（启发式反而高估）');
  out.push('');
  out.push('  ⇒ 启发式**中位**偏差：' + (s.underPct >= 0 ? '低估 ' : '高估 ')
    + Math.abs(s.underPct).toFixed(1) + '%');
  out.push('  ⇒ 修正系数（真实 ÷ 启发式）**中位** ≈ ' + fmt(s.median, 2)
    + '；**请勿当成万能倍数**（min～max 跨度 ' + fmt(s.min, 2) + '～' + fmt(s.max, 2) + '）');
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const args = { json: false, home: null, minReal: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--home') { args.home = argv[++i]; if (args.home === undefined) { console.error('error: --home 需要一个路径'); process.exit(1); } }
    else if (a === '--min-real') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) { console.error('error: --min-real 需要一个非负数字'); process.exit(1); }
      args.minReal = v;
    } else { console.error('error: 未知参数 ' + a + '\n用法: node scripts/dsh-token-ratio.js [--home <dshHome>] [--json] [--min-real <n>]'); process.exit(1); }
  }
  const home = args.home ? path.resolve(args.home) : embeddedHome();
  const res = collect(home);
  if (args.json) {
    const s = summarize(res.samples, { minReal: args.minReal });
    process.stdout.write(JSON.stringify({
      home, dir: res.dir, homeExists: res.homeExists, dirExists: res.dirExists,
      files: res.files, unreadable: res.unreadable, degenerate: res.degenerate,
      sampleCount: res.samples.length, stats: s
    }, null, 2) + '\n');
  } else {
    console.log(renderReport(home, res, { minReal: args.minReal }));
  }
  // **home 不存在 = 1**（路径给错，是错误）；**有 home 但无 projcache / 无样本 = 0**（有效结论）
  if (!res.homeExists) process.exit(1);
}

if (require.main === module) main();

module.exports = { embeddedHome, projCacheDir, sampleFromRecord, collect, summarize, renderReport, quantile };
