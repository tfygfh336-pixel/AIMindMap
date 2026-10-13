'use strict';
/* ============================================================
 * scripts/recon-integration.js — `scripts/cli-integration.js` 的**静态口径 ÷ 实跑口径对账**（现算）
 * ------------------------------------------------------------
 * 它回答一句话：**"源码里那些 `check(`，有哪几条从来没被跑到？"** —— 逐条给**行号 + 标签 + 判定依据**。
 *
 * 口径（两条都**现算**；本文件的正文里不写死**任何读数**（静态 / 实跑 / 差几条 / 差在哪一行）✗ ——
 *       读数由实现决定，写死必然腐坏，本工程就在 `scripts/cli-integration.js` 的那处注释上栽过一次）：
 *   · 静态 = 与 `scripts/doc-facts.js` **逐字相同**的正则 `/^\s*check\(/gm`
 *     （`docs/VERIFY.md` 的「CLI 集成断言」那一行就是这条口径，权威在 `doc-facts.js`，这里只复用）。
 *   · 实跑 = 集成脚本自己打印的 `[PASS] ` / `[FAIL] ` 行数；并与汇总行 `==== N/M …` 的 M **交叉校验**
 *     （两者不一致 ⇒ 日志被截断或不是 UTF-8 ⇒ 读数作废 ⇒ 判红；不是"差不多"）。
 *   · 差集 = 静态有、实跑里一次都没被消费到的站点（**判定依据**逐条打印，见下面「三种形态」）。
 *
 * 用法：
 *   node scripts/recon-integration.js --run              # 自己跑一遍集成（自带 finally 收尾），再对账
 *   node scripts/recon-integration.js --log <日志路径>    # 用已有日志对账（日志须 UTF-8）
 *   可选： --root <仓库根>（默认 = 本文件所在的仓库根）
 *
 * 退出码：0 = **报出了读数**（差几条都算"报出" —— 它不是门禁，不判"该不该差"，只判"读得准不准"）；
 *        1 = **真发现异常**：日志里有 `[FAIL]`／汇总行与实跑行数不一致／本轮探针收尾没干净；
 *        2 = **采不到真值**（读不到源码 / 读不到日志 / 没有汇总行 / 子进程起不来）——
 *            照 B8「跳过必须与通过可区分」：这时不许回退成"看起来正常"的读数，响亮判红。
 *
 * ## 三种会骗过"按标签对账"的形态，本脚本都处理（这是它比 `diff` 两行计数多的全部价值）
 *   ① **循环内调用**：同一行跑 N 次 ⇒ 按"出现次数"消费（**多重集**，不是 Set），不会误判成 N 个站点；
 *   ② **动态拼标签**（`'前缀' + 变量 + …`）：退化成**字面前缀**匹配，并把前缀打进报告（可人工复核）；
 *   ③ **同一标签多站点**（最阴的一种：`if (兜底) { check(L,false) } else { check(L,cond) }`）：
 *      只按标签匹配会把"哪一条没跑"张冠李戴 ⇒ 再拿**第三个实参（detail）**分辨：
 *      字面量 detail 要求整行逐字相符；`'前缀' + 动态` 按前缀；纯动态只要求标签相符。
 *
 * ## 自收尾（E2：整段 `try/finally`，异常照旧上抛，不为了收尾把它吞掉）
 *   它**要跑集成**（`--run`）⇒ 集成脚本被中断时收尾不执行 ⇒ 这里兜底：跑完（含崩在半路）按
 *   **唯一一张前缀表** `PROBE_PREFIX` 清掉**本次跑期间新出现**的探针项目与探针访问日志，
 *   然后**当场报数**（本次新出现的残留 / `projects/.visits/` 各几个文件；**本次新出现的残留 ≠ 0 ⇒ 判红**）。
 *
 * ## 口径边界（如实声明，照 B8）
 *   · 只数**行首** `check(`：行中调用（`} else check(…)` 那种）**静态口径本来就不数** ——
 *     若它们**真跑了**，会在「实跑里有、静态对不上」那一段作为**孤儿观测**列出，不静默丢弃。
 *     （本工程有几处行中调用 —— **数字不写在这里**：跑一次看报告里「孤儿观测」那一段即可，
 *       那一段**为空**就说明本次没有任何行中调用跑到过。）
 *   · 它判"哪条没跑到"，判不了"该不该跑到"：后者要读那一处的上下文。本工程现状的账在
 *     `.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的对账一节（差因：夹具下永不执行的兜底分支 + env 门控）。
 *   · 收尾前缀是**宽口径** `it-` / `imp-probe-`（集成脚本自己那张前缀表是它的子集）⇒ 只删
 *     **本次跑期间新出现**的；**开工前就在的**只报数、不删 —— 那可能是并发跑的另一份集成持有的。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ARGV = process.argv.slice(2);
const argOf = (name) => { const i = ARGV.indexOf(name); return i >= 0 ? ARGV[i + 1] : null; };
const ROOT = path.resolve(argOf('--root') || path.join(__dirname, '..'));
const SRC = path.join(ROOT, 'scripts', 'cli-integration.js');
const PROJ_DIR = path.join(ROOT, 'projects');

/* 探针前缀表（**唯一一处**）：自收尾与残留计数都只认它，谁也不许在别处再抄一份清单。
 * 宽于集成脚本内部那张表（它按流分前缀）是**故意**的：这里问的是"跑完还剩没剩"，不是"谁留的"。 */
const PROBE_PREFIX = /^(it-|imp-probe-)/;

/* ---------- 1) 静态口径：与 `scripts/doc-facts.js` 逐字相同的正则 ---------- */
const STATIC_RE = /^\s*check\(/gm;   // ⚠️ 改这一行就必须同批改 `doc-facts.js` 里那一行（两边必须逐字相同）

/* 从 `check(` 的实参表里取前三个实参（括号/引号/模板深度感知） */
function splitArgs(text, start, max) {
  const out = [];
  let i = start, depth = 1, cur = '', q = null;
  while (i < text.length && out.length < max) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += text[i + 1] || ''; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '"' || c === '\'' || c === '`') { q = c; cur += c; i++; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; cur += c; i++; continue; }
    if (c === ',' && depth === 1) { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 纯字面量拼接求值 ⇒ {lit}；含动态成分 ⇒ {lit:null, prefix:'字面前缀'}（无字面前缀时 prefix=''） */
function evalStatic(raw) {
  const s = String(raw == null ? '' : raw);
  const tokens = [];
  let i = 0, dynamic = false;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const c = s[i];
    if (c === '+') { i++; continue; }
    if (c === '"' || c === '\'') {
      const q = c; let v = ''; i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') { const e = s[i + 1]; v += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e; i += 2; continue; }
        v += s[i]; i++;
      }
      i++; tokens.push(v); continue;
    }
    dynamic = true; break;                       // 动态成分：后面是什么都不再影响字面前缀
  }
  return dynamic ? { lit: null, prefix: tokens.join('') } : { lit: tokens.join(''), prefix: tokens.join('') };
}

function staticSites(src) {
  const sites = [];
  STATIC_RE.lastIndex = 0;
  let m;
  while ((m = STATIC_RE.exec(src)) !== null) {
    // `\s*` 会吃换行 ⇒ match 的起点可能在更前面的空行上；**行号取 `check(` 自己的位置**（人要对上的行号）
    const at = m.index + m[0].lastIndexOf('check(');
    const line = src.slice(0, at).split('\n').length;
    const args = splitArgs(src, at + 'check('.length, 3);
    const label = evalStatic(args[0]);
    const detail = evalStatic(args[2]);          // 第三个实参 = detail（没有它 ⇒ 日志里没有 ' :: '）
    sites.push({
      line,
      label: label.lit, labelPrefix: label.prefix,
      detail: detail.lit, detailPrefix: detail.prefix,
      hasDetailArg: args.length > 2,
      raw: String(args[0] || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    });
    if (m[0].length === 0) STATIC_RE.lastIndex++;   // 防御：本正则不可能空匹配，但别让它变成死循环
  }
  return sites;
}

/* ---------- 2) 实跑口径：日志里的 [PASS]/[FAIL] 行 + 汇总行 + SKIP 行 ---------- */
function parseLog(text) {
  const obs = [];
  const skips = [];
  text.split(/\r?\n/).forEach((l) => {
    const m = /^\[(PASS|FAIL)\] (.*)$/.exec(l);
    if (m) { obs.push({ kind: m[1], rest: m[2] }); return; }
    if (l.indexOf('[SKIP') >= 0) skips.push(l.trim());
  });
  const summary = (text.split(/\r?\n/).find((l) => /CLI 集成断言通过/.test(l)) || '').trim();
  const sm = /(\d+)\/(\d+) CLI 集成断言通过/.exec(summary);
  return { obs, skips, summary, summaryTotal: sm ? Number(sm[2]) : null };
}

/* ---------- 3) 多重集匹配（标签 + detail 分辨），返回每个站点是否跑到 ---------- */
function reconcile(sites, obs) {
  const used = new Array(obs.length).fill(false);
  const claim = (site, pred, via) => {
    for (let i = 0; i < obs.length; i++) {
      if (used[i]) continue;
      if (pred(obs[i])) { used[i] = true; site.ran = true; site.via = via; return true; }
    }
    return false;
  };
  sites.forEach((s) => { s.ran = false; s.via = ''; });

  // 第 1 轮：**字面 detail** 的站点 —— 整行必须逐字相符（`标签 :: detail`）。
  //           ⚠️ 这一轮是"同标签多站点"能分辨的关键：兜底分支那条的 detail 是**字面量**，
  //              它绝不会因为"标签相符"而被误判成跑过。
  sites.forEach((s) => {
    if (s.label === null || s.detail === null) return;
    claim(s, (o) => o.rest === s.label + ' :: ' + s.detail || (s.detail === '' && o.rest === s.label), '标签+detail 逐字');
  });
  // 第 2 轮：detail 是 `'字面前缀' + 动态` —— 按前缀相符（**必须排在兜底轮之前**，
  //           否则同标签的两处会由"先出现的那个"抢走唯一那条实跑记录 → 张冠李戴）
  sites.forEach((s) => {
    if (s.label === null || s.ran) return;
    if (!s.hasDetailArg || s.detail !== null || !s.detailPrefix) return;
    claim(s, (o) => o.rest.startsWith(s.label + ' :: ' + s.detailPrefix), '标签+detail 前缀');
  });
  // 第 3 轮：**兜底轮** —— 其余情形（第三个实参没解析出来 / detail 是纯动态 / 压根没给 detail）
  //           只按标签消费。⚠️ 唯一**不进**这一轮的是"解析出了**字面 detail**、但整行不逐字相符"的站点：
  //           那种站点要么是另一分支（同标签的第二处，如 `if (兜底) … else …`），要么 detail 真变了
  //           —— 两种都该留在差集里（这一条正是"同标签两站点"能正确归因的关键）。
  sites.forEach((s) => {
    if (s.label === null || s.ran) return;
    if (s.hasDetailArg && s.detail !== null) return;
    claim(s, (o) => o.rest.startsWith(s.label + ' :: ') || o.rest === s.label, '只按标签（兜底轮）');
  });
  // 第 4 轮：**动态标签**按字面前缀
  sites.forEach((s) => {
    if (s.label !== null || s.ran || !s.labelPrefix) return;
    claim(s, (o) => o.rest.startsWith(s.labelPrefix) && o.rest.length > s.labelPrefix.length, '动态标签·字面前缀');
  });
  return { orphanObs: obs.filter((o, i) => !used[i]) };
}

/* ---------- 4) 探针收尾与残留读数（前缀表只有上面那一处 `PROBE_PREFIX`） ---------- */
function probeDirs() {
  try {
    return fs.readdirSync(PROJ_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PROBE_PREFIX.test(e.name)).map((e) => e.name);
  } catch (e) { return []; }                       // projects/ 不存在：读作"没有残留"
}
const VISITS = path.join(PROJ_DIR, '.visits');
function visitFiles() { try { return fs.readdirSync(VISITS); } catch (e) { return []; } }

/** 自收尾：只清**本次跑期间新出现**的探针项目 + 探针访问日志（开工前就在的一律不碰） */
function sweepThisRun(before) {
  const removed = [];
  probeDirs().forEach((n) => {
    if (before.has(n)) return;
    try { fs.rmSync(path.join(PROJ_DIR, n), { recursive: true, force: true }); removed.push(n); } catch (e) { /* 单个失败下面会当残留报出来 */ }
  });
  visitFiles().filter((f) => PROBE_PREFIX.test(f)).forEach((f) => {
    try { fs.rmSync(path.join(VISITS, f), { force: true }); removed.push('.visits/' + f); } catch (e) { /* 同上 */ }
  });
  return removed;
}

/* ---------- 5) 主流程 ---------- */
function main() {
  const before = new Set(probeDirs());            // 开工前快照（并发跑的另一份集成持有的是新鲜目录，不能误删）
  const res = { exit: 0, ran: false, sweepRemoved: [] };
  const problems = [];                            // 真异常 ⇒ 非 0（每条都带"怎么查"）
  let text = null;

  try {
    if (ARGV.includes('--run')) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [SRC], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
      const ms = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.error) {
        console.error('采不到真值：跑不起集成脚本 —— ' + r.error.message);
        res.exit = 2; return;
      }
      res.ran = true;
      text = String(r.stdout || '') + String(r.stderr || '');
      console.log('（自己跑了一遍：exit=' + r.status + ' ｜ ' + ms + ' s）');
    } else {
      const p = argOf('--log');
      if (!p) { console.error('用法：node scripts/recon-integration.js --run 或 --log <日志路径>'); res.exit = 2; return; }
      try { text = fs.readFileSync(p, 'utf8'); }
      catch (e) { console.error('采不到真值：读不到日志 ' + p + ' —— ' + e.message); res.exit = 2; return; }
    }

    let src;
    try { src = fs.readFileSync(SRC, 'utf8'); }
    catch (e) { console.error('采不到真值：读不到 ' + SRC + ' —— ' + e.message); res.exit = 2; return; }

    const sites = staticSites(src);
    const runRes = parseLog(text);
    const recRes = reconcile(sites, runRes.obs);
    const missing = sites.filter((s) => !s.ran);
    /* 分组键：字面 label 用它本身；**动态标签用它的字面前缀**。为什么不能一律用 `(动态标签)` 当键：
     * 那样所有动态站点会被并成一坨，"这个标签出现 N 次"里的 N 会把互不相干的站点算进来 —— 实测过，
     * 那是一条**假线索**（本想指出"同标签多站点"，结果指了一堆无关行）。 */
    const labelKey = (s) => (s.label !== null ? '标签:' + s.label : '动态标签前缀:' + s.labelPrefix);
    const byLabel = {};
    sites.forEach((s) => { const k = labelKey(s); (byLabel[k] = byLabel[k] || []).push(s); });

    console.log('');
    console.log('静态（`^\\s*check\\(`，与 doc-facts.js 同口径） = ' + sites.length);
    console.log('实跑（日志 [PASS]+[FAIL] 行）                     = ' + runRes.obs.length
      + '   （汇总行 ' + (runRes.summary || '(无)') + '）');
    console.log('差（静态 − 实跑）                                = ' + (sites.length - runRes.obs.length));
    console.log('');
    /* ⚠️ "差" 与下面那个"没被消费到的站点数"**不是同一个数**（只有孤儿观测 = 0 时才恰好相等）：
     *     差 = 没被消费到的站点数 − 对不上任何静态站点的实跑行数（行中调用、动态前缀对不上的那些）。
     * 两个数**各自都对**；并排印出来 + 把账目写清，省得读者以为本工具自相矛盾（这一条是被判别力
     * 证明里的那次注入逼出来的：两个数并排成了不同的值，第一眼就是"工具自己报错了" ✗）。 */
    console.log('【静态有、实跑里没被消费到的站点：' + missing.length + ' 条】'
      + (recRes.orphanObs.length
        ? '（账目：' + missing.length + ' 条未消费 − ' + recRes.orphanObs.length + ' 条对不上的实跑行 = 差 '
          + (sites.length - runRes.obs.length) + '）'
        : ''));
    missing.forEach((s) => {
      const same = byLabel[labelKey(s)] || [];
      console.log('  L' + s.line + '  ' + (s.label !== null ? '标签: ' + s.label : '动态标签（字面前缀）: ' + s.labelPrefix));
      if (s.label === null) console.log('        源码: ' + s.raw);
      if (same.length > 1) {
        const ran = same.filter((x) => x.ran).map((x) => 'L' + x.line);
        console.log('        ⚠ 这个标签在源码里出现 ' + same.length + ' 次（L' + same.map((x) => x.line).join(' / L')
          + (ran.length ? '；其中实跑的是 ' + ran.join(' / ') : '') + '）—— 判定依据 = ' + (s.via || '未被消费'));
      }
    });
    if (runRes.skips.length) {
      console.log('');
      console.log('【日志里的 SKIP 行（响亮"没跑"，不是通过）：' + runRes.skips.length + ' 条】');
      runRes.skips.forEach((l) => console.log('  ' + l));
    }
    if (recRes.orphanObs.length) {
      console.log('');
      console.log('【实跑里有、静态行首口径对不上的标签（行中调用等）：' + recRes.orphanObs.length + ' 条】');
      recRes.orphanObs.forEach((o) => console.log('  [' + o.kind + '] ' + o.rest.slice(0, 110)));
    }

    // 采不到真值 ⇒ 判红（A5/B8）：没有汇总行就没有"实跑总数"这条独立读数，静止于此不算"读到了"
    if (runRes.summaryTotal === null) {
      console.error('\n采不到真值（日志里没有汇总行）⇒ 判红：读不到"实跑总数"这条独立读数，'
        + '对账结果不能自称已校验（日志被截断 / 不是 UTF-8 / 子进程半路死掉）');
      res.exit = 2; return;
    }
    if (runRes.summaryTotal !== runRes.obs.length) {
      problems.push('口径不一致：汇总行 M=' + runRes.summaryTotal + ' ≠ 日志 [PASS]/[FAIL] 行数 ' + runRes.obs.length
        + '（日志可能被截断或不是 UTF-8）⇒ 这条读数作废，别拿它当"差几条"的依据');
    }
    if (runRes.obs.some((o) => o.kind === 'FAIL')) {
      problems.push('日志里有 [FAIL] —— 集成断言本身红了，先修它再看对账（`node scripts/cli-integration.js`）');
    }
  } finally {
    /* 自收尾：**整段 finally**（正常跑完与崩在半路都走这里）—— 它跑集成，收尾就不能只在 happy path 上。
     * ⚠️ 异常照旧上抛：下面这段只做"清 + 报数"，不 catch 掉任何真异常。 */
    res.sweepRemoved = sweepThisRun(before);
    const leftDirs = probeDirs();
    const leftThisRun = leftDirs.filter((n) => !before.has(n));
    const leftLogs = visitFiles().filter((f) => PROBE_PREFIX.test(f));
    const allVisits = visitFiles();
    console.log('');
    console.log('【自收尾（整段 finally；前缀表 = PROBE_PREFIX 一处）' + (res.ran ? '' : '｜--log 模式：本轮没跑集成') + '】');
    console.log('  本次清掉 = ' + res.sweepRemoved.length + ' 个'
      + (res.sweepRemoved.length ? '（' + res.sweepRemoved.join(', ') + '）' : '')
      + '；开工前就在的探针项目 = ' + before.size + ' 个（只报数不删：可能是并发跑的另一份集成持有的）');
    console.log('  残留（projects/ 下 it-* / imp-probe*）     = ' + leftThisRun.length + ' 个'
      + (leftThisRun.length ? '（' + leftThisRun.join(', ') + '）' : '')
      + '；其中开工前就在的 = ' + (leftDirs.length - leftThisRun.length) + ' 个（不计入本次残留）');
    console.log('  projects/.visits/ 文件数                  = ' + allVisits.length
      + '（其中探针日志 = ' + leftLogs.length + (allVisits.length - leftLogs.length ? '；另有 ' + (allVisits.length - leftLogs.length)
        + ' 条非探针日志 = 真项目的使用痕迹，不碰也不计入判定' : '') + '）');
    if (res.ran) {
      if (leftThisRun.length) problems.push('本次跑完还留着探针项目：' + leftThisRun.join(', ') + '（收尾没清掉 —— 先看是不是权限/占用）');
      if (leftLogs.length) problems.push('本次跑完还留着探针访问日志：' + leftLogs.join(', ') + '（收尾没清掉）');
    }
    /* ⚠️ 异常汇报与退出码**必须在 finally 里落定**：上面每一条"采不到真值"都是 `return`，
     * 而 `return` 会跳过 finally **之后**的语句 ⇒ 把这段留在外面会让"采不到真值"静默 exit 0 ✗
     * （实测踩到：写完之后用 `--log` 指一个不存在的文件试退出码，才发现它 exit 0 —— 见交付说明）。 */
    if (problems.length) {
      console.log('');
      problems.forEach((p) => console.log('✗ ' + p));
      if (!res.exit) res.exit = 1;
    }
    process.exitCode = res.exit;   // 用 exitCode 而不是 process.exit()：后者会跳过 finally（收尾就不执行了 ✗）
  }
}

if (require.main === module) main();   // 照 B6：`require` 本模块零副作用（纯函数便于单测/复用）
module.exports = { splitArgs, evalStatic, staticSites, parseLog, reconcile };
