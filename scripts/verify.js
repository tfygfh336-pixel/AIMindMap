#!/usr/bin/env node
/* ============================================================
 * scripts/verify.js — 验证链运行器（含**耗时预算**门禁）
 * ------------------------------------------------------------
 * 为什么把 `&&` 链换成这个脚本：
 *   本工程花了很大力气把 `npm run verify` 从 **176 s 压到 ~77 s**（单是把集成断言从
 *   "每条起一个 Node 进程"改成就地调用就省下 98 s）。但这种收益**没有任何东西守得住** ——
 *   下一个人以"多加一条断言""多挂一个脚本"的名义，很轻松就能把它一点点涨回去，
 *   而且**每次只涨一点点，没人会注意到**。这与本工程反复修过的那类病同型：没做坏事，
 *   却也让坏事看不出发生。
 *   ⇒ 把耗时的**数量级**变成红，并让每次运行都打印耗时表（时间花在哪，一眼可见）。
 *
 * 两个设计要点：
 *   ① **stdio: 'inherit'，不用管道**。受限环境（企业 EDR / 沙箱）禁止管道 stdio，
 *      用管道收集输出会让整条链假失败 —— 本工程的 `docs/VERIFY.md`「本机受限环境注意」
 *      记着这个坑。inherit 还顺带让子步骤的输出**实时**可见（而不是跑完才吐）。
 *   ② 预算 = **止涨线**，不是性能目标。⚠️ 它**不是"实测的 2–3 倍"** —— 本文件原先这么写，
 *      实测不成立（本批订正）：倍数**按两类来源定，且每步都不一样**：
 *        · **廉价门禁**（G1/G6/G8/G9/V1/V2/S1/S2/S3/G2）取整档 10 / 15 / 20 s，而实测只有 0.1–3 s
 *          ⇒ 实际远大于 2 倍（这类步骤的预算是"廉价档"的取整，不是对实测乘一个倍数）；
 *        · **昂贵步骤**（G3 / G4 / G5）由 `tests/verify-budget.test.js` 的余量守卫定：
 *          **预算 ≥ 1.25 × 窗口（最近 10 次）的 median** ⇒ 实际倍数只有 **1.25–1.43**。
 *      每一步的**当前真实倍数不抄在这里**（抄一份就会漂：`docs-for-ai` C1 / `B1`）：要读数就跑
 *      `npx vitest run tests/verify-budget.test.js`（守卫判红时的报文会打印该步的 median 与 1.25× 门槛）
 *      或从 `.review/verify-history.jsonl` 现算。
 *      刻意留足余量：CI 与本机负载差异很大，紧贴实测值会变成随机红灯，而随机红灯的下场是被人无视或直接删掉。
 *
 * 覆盖面（一条事实只写一处）：本文件的 `STEPS` 同时是
 *   · `npm run verify` 的执行顺序；· `docs/VERIFY.md` 里那张验证链表的数据源
 *   （由 `scripts/doc-facts.js` 渲染）。改步骤只改这里。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// 改动面 → 必跑集的映射（纯函数 + 单测；本文件只负责取清单、跳过与留痕）
const changedPlan = require('./changed-plan.js');

const ROOT = path.resolve(__dirname, '..');

/* ================================================================
 * ⚠️ **非确定性产物**（生成器就是本文件）—— 下面这几个**不得当真值**读：
 *   · `.review/verify-tests.json`     vitest 报告（含每个文件的耗时），只是"用例数"的交接文件
 *   · `.review/last-verify.json`      每次运行都不同（finishedAt / totalMs / freeMemMB / version）
 *   · `.review/verify-history.jsonl`  **追加式**历史（同上 + node / host / freeMemMB）
 *   它们是**留痕**，回答的是"上次绿没绿、比上次慢了没有"；要**当前真值**就现场取：
 *   `node scripts/doc-facts.js`（命令数 / 工具数 / 用例数 / 断言数）。
 *   差异来源属于「时间戳 / 耗时 / 路径」三类 —— 逐类的"为什么可以不确定"见门禁 **S3**
 *   （`node scripts/determinism-check.js --list`）。**判定**：标注缺了、或标注没点名产物，都会判红。
 * ================================================================ */

/** 第 4 步额外产出的用例数（供第 6 步取用，省掉它重跑一次 vitest）。
 *  落在 `.review/` —— 工程既定的**工作产物区**（已 gitignore，G8 豁免）。 */
const TEST_RESULTS = '.review/verify-tests.json';

/** 从 vitest 的 JSON reporter 输出里取用例总数；读不到就返回 null（下游会自己跑一遍） */
function readUnitTests(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(j.numTotalTests) ? j.numTotalTests : null;
  } catch (e) { return null; }
}

/* ---------------- 交接面留痕：上一次全链的结果 ----------------
 * 为什么需要：零上下文的接手演练（只读文档、不跑重命令）**无法回答"上一次验证绿没绿"** ——
 * 工程里没有任何落盘痕迹。这对"AI 独立接手"是直接缺口：新会话要么盲跑一次全链（50 s+），
 * 要么在不知道基线的情况下改代码。
 * 落在 `.review/`（工作产物区：已 gitignore、不进 G6、G8 豁免）——**丢了就当"未知"**，不判红。
 * 注意：它只是"上一次跑过"的记录，**不是**"当前代码已验证"的证明（代码可能又改过了）。 */
const LAST_VERIFY = '.review/last-verify.json';

function readLastVerify() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, LAST_VERIFY), 'utf8'));
    return (j && typeof j.finishedAt === 'string') ? j : null;
  } catch (e) { return null; }
}

function writeLastVerify(run) {
  try {
    const p = path.join(ROOT, LAST_VERIFY);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n', 'utf8');
  } catch (e) { /* 写不进去不影响验证结论 */ }
}

/* ---------------- 验证历史：**追加**，不覆盖 ----------------
 * 为什么需要：`last-verify.json` 每次运行都被**覆盖**，只剩最后一条记录。而验证链的真实故障
 * 恰恰多是"可疑的偶发 / 变慢"：2026-09-30 一晚连跑 6 次，症状每次都不一样。跑完只剩最后一条 ⇒
 * **事后无从查证**"是偶发还是真的变慢了"（几次记录摆在一起，规律一眼可见；只剩一条就什么都看不出）。
 * 为什么用 JSON Lines：一行一条、追加不覆盖、坏一行不毁前面所有行，用 `Get-Content | ConvertFrom-Json`
 * 或普通文本工具就能读，不需要任何依赖（工程**零必需运行时依赖**，唯一例外是 PDF 解析用的
 * `pdfjs-dist` —— 它只在 `scripts/pdf-outline-helper.mjs` 那个子进程里载入）。
 * 为什么带 node / host / freeMemMB：这三点是"同一份代码、结果不同"时最先要排除的变量
 * （node 版本差异、换机器、当时内存压力）。
 * 为什么写失败不能影响结论：它只是**旁证**（与 `last-verify.json` 同一性质）。为了一条日志把一次
 * 真实验证判成失败，属于"辅助设施反过来打断主流程"，得不偿失 ⇒ 只打印一行警告。
 * 落在 `.review/`（工程既定的**唯一杂物区**：可随时整目录删除、已 gitignore、不进 G6 数字扫描）。 */
const VERIFY_HISTORY = '.review/verify-history.jsonl';

/** 一条历史记录（除 `envIn` 外都是纯计算：便于单测"字段映射"那一半） */
function buildVerifyHistory(run, results, envIn) {
  const env = envIn || { node: process.version, host: os.hostname(), freeMemMB: Math.round(os.freemem() / 1048576) };
  const g5 = (results || []).filter((x) => x && x.gate === 'G5')[0] || null;
  return {
    at: run.finishedAt,                       // ISO 时间（与 last-verify.json 同一个时刻，便于两份记录对齐）
    ok: run.ok,
    failedGate: run.failedGate === undefined ? null : run.failedGate,
    totalMs: run.totalMs,
    // `--changed` 的部分验证要标出来：它**不能**当耗时基线（只跑了几步，比出来是假信号 ✗）
    partial: run.partial === true,
    /* G5 本轮跑的是哪一档（`full` / `fast` / `subset` / `skipped`）。
     * 为什么必须落盘：`readLastFullG5()` 靠它判"全量档有没有过期"（分层抽样的触发条件是机械可判的），
     * 而 `tests/verify-budget.test.js` 的余量守卫要**只用全量档读数**——快档读数会让它空转。
     * 老记录没有这个字段 ⇒ 按 `'full'` 读（分层之前 G5 跑的就是全部域）。 */
    g5Tier: !g5 ? 'skipped' : (g5.skipped === true ? 'skipped' : (g5.tier || 'full')),
    // 每步：门禁 / 耗时 / 退出码 / 是否超预算。另外带上 skipped（G7 与 G6 共用一次调用时 ms=0）——
    // 免得事后看历史时把"这一步没单独跑"误读成"耗时 0 秒、很健康"。
    steps: results.map((r) => ({
      gate: r.gate,
      ms: r.ms,
      code: r.code,
      overBudget: r.budgetMs > 0 && r.ms > r.budgetMs,
      skipped: r.skipped === true,
      // G5 的档位（`full` / `fast` / `subset`）：**快档读数不能当全量档的基线**
      // （`tests/verify-budget.test.js` 的余量守卫与 `readLastFullG5` 都靠这个字段区分）
      tier: r.gate === 'G5' ? (r.tier || 'skipped') : undefined
    })),
    node: env.node,
    host: env.host,
    freeMemMB: env.freeMemMB
  };
}

/** 追加写一条历史（失败只警告，绝不让 verify 因此失败）。 */
function writeVerifyHistory(run, results) {
  try {
    const p = path.join(ROOT, VERIFY_HISTORY);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(buildVerifyHistory(run, results)) + '\n', 'utf8');
  } catch (e) {
    console.warn('⚠️ 验证历史写入失败（不影响本次验证结论）：'
      + VERIFY_HISTORY + ' —— ' + (e.message || e));
  }
}

/* ---------------- 度量列：这次比上次快了多少（2026-10-08 加） ----------------
 * 为什么加：本链有过一次真实的教训 —— 从 176 s 压到 77 s 之后**又慢慢涨回去**
 *（`01` 里记的 70 s 与后来的 118 s 就是同一件事的两个时点）。只打印"本次耗时"看不出趋势，
 * 于是"这轮省下的"没人知道、也就没人守 ⇒ 每次运行时直接把**与上一条历史的差**打出来 ✓。
 * 读历史必须在**追加本次记录之前**（就在打印耗时表那一刻）✓ 否则比的是自己。
 * 阈值只提示不判红：耗时受负载影响（本机实测同一份代码能差 20%+），判红交给预算 ✓。 */

/** 从历史行里挑**对比基线**：最后一次 `ok:true` 的那条（纯函数，便于单测）。
 *  ⚠️ 为什么不能拿"最后一条"：**失败/中断的那次步骤压根没跑完** ⇒ 逐门禁比出来是假信号。
 *  实测踩到：一次在 G4 中断的运行（合计 23.7s）让下一次全链显示"比上次慢了 +101.7s" ✗。 */
function pickHistoryBaseline(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!String(lines[i]).trim()) continue;
    try {
      const r = JSON.parse(lines[i]);
      // `partial`（--changed 的部分验证）同样不能当基线 —— 它只跑了几步，比出来是假信号 ✗
      if (r && r.ok === true && r.partial !== true && Array.isArray(r.steps)) return r;
    } catch (e) { /* 坏行跳过：历史上可能有半截行 */ }
  }
  return null;
}

/** 读历史文件的对比基线（读不到/没有成功的记录 ⇒ null，绝不因此让 verify 失败） */
function readHistoryBaseline() {
  try {
    const text = fs.readFileSync(path.join(ROOT, VERIFY_HISTORY), 'utf8');
    return pickHistoryBaseline(text.split(/\r?\n/));
  } catch (e) {
    return null;
  }
}

/* ---------------- `--changed`（改动面 → 必跑集，2026-10-08 加） ----------------
 * 映射规则在 `scripts/changed-plan.js`（纯函数、有单测）；这里只做三件事：
 *   ① 取改动清单（git 的 I/O）；② 按计划**跳过**不在计划里的步骤；
 *   ③ 把"这是**部分**验证"写进**另一个**记录位 —— **绝不覆盖** `last-verify.json`
 *      （那句话回答的是"上一次**全链**绿没绿"，被一条只跑了 4 步的记录覆盖就变成假事实 ✗）。 */
const LAST_VERIFY_CHANGED = '.review/last-verify-changed.json';

/** 工作区改动（含未跟踪文件）；取不到 git ⇒ null（调用方退回全量） */
function changedFiles() {
  const run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  try {
    const diff = run(['diff', '--name-only', 'HEAD']);
    if (diff.status !== 0) return null;
    const untracked = run(['ls-files', '--others', '--exclude-standard']);
    const files = String(diff.stdout || '').split(/\r?\n/)
      .concat(String(untracked.stdout || '').split(/\r?\n/));
    return files.map((f) => f.trim()).filter(Boolean);
  } catch (e) { return null; }
}

/** 批次越界检查的输入（T1 批）：读**别的在飞批次**的登记 + 把判定交给纯函数。
 *  为什么 I/O 在这层：`scripts/changed-plan.js` 的 `planBoundary` 是**纯函数**（可单测、可注入），
 *  读 `.review/claim-*.json` 这一步才需要 fs —— 与 `surfaceSelfCheck`（域号由调用方现算传进来）
 *  同一分工：**判定与取数分开**（B6）。 */
function evaluateBoundary(files, sel) {
  const { claims, errors } = changedPlan.readClaims(path.join(ROOT, '.review'));
  if (errors.length) {
    console.log('   ⚠️ 有读不懂的「别批在飞登记」（**不计入** ⇒ 它认领的文件可能被误判成无人认领）：');
    errors.forEach((e) => console.log('      · ' + e));
  }
  return changedPlan.planBoundary(files, { claimed: sel.claimed, claims });
}

/** 部分验证的记录（单独一格：不覆盖"上次全链"） */
function writeLastVerifyChanged(run) {
  try {
    const p = path.join(ROOT, LAST_VERIFY_CHANGED);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n', 'utf8');
  } catch (e) { /* 记录写失败不影响结论 */ }
}

/** 读部分验证那格（供开头一句"另有上次部分验证"） */
function readLastVerifyChanged() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, LAST_VERIFY_CHANGED), 'utf8')); }
  catch (e) { return null; }
}

/* ================================================================================
 * G5 **分层**：`core`（每轮全链）/ `deep`（按频率 + 放行点）—— 2026-10-18 加
 * --------------------------------------------------------------------------------
 * 为什么要有它（现算读数，不是估计）：G5 一项占全链 **93%**（最近 10 次成功全链 994–1174 s，
 * 合计 1100–1280 s），而**全链时长是每一次 AI 迭代都要付的固定成本**。每批"往 G5 里顺手多加
 * 一条断言"单看都合理，合起来就把验证推到"没人愿意跑"—— 而**跳过验证**是本工程最重的损害
 * 类别（"没做，却看不出没做"）的入口。
 *
 * 做法只有两条，且**都不动任何判据**（不删断言、不降阈值、不放松任何一条判定）：
 *   ① **分层**：`core` 域每轮都跑、`deep` 域按频率跑（表是单一权威，在
 *      `scripts/smoke-assertions.js` 的 `TIERS`；哪个域进哪一档由**实测耗时**决定，见那里的注释）；
 *   ② **抽样的触发条件可判定**：`decideG5Tier()` 是纯函数（`tests/verify-budget.test.js` 有
 *      逐条触发条件的判别力证明 —— 去掉任一输入，档位必须变）。
 *
 * ⚠️ 四条边界（如实写在这里；漏一条就会变成"看起来验过了"）：
 *   · **快档的绿不是全量真值**：它没跑 `deep` 域，也没有视觉断言 / 取景记录（快档走既有的
 *     `SMOKE_ONLY` 通道，那条路本来就"不产截图 / 取景记录 / 视觉断言"，见 `docs/VERIFY.md`）
 *     ⇒ 输出必须**逐个点名没跑什么**（域数与断言数都给出）。
 *   · **快档不能盖掉一次红色的全量档**：上次全量档红着 ⇒ 本轮强制全量（否则会拿"快档绿"
 *     把已知的 deep 缺陷洗掉 —— 本工程最重的损害类别）。
 *   · **全量档不许过期**：距上次**成功**的全量档 ≥ `G5_FULL_EVERY_MS`（24h）⇒ 本轮强制全量。
 *   · **放行点/交付前**：`--release` 强制全量；`--g5=fast|full` 是人手里的放大器（它能覆盖的
 *     只有"该轮到全量了"这一条周期触发，覆盖不了上面三条硬条件）。
 * ================================================================================ */
const G5_TIERS = ['fast', 'full'];
/** 全量档的最长间隔：距上次**成功**全量档 ≥ 此值 ⇒ 本轮强制全量（"每日一档"）。 */
const G5_FULL_EVERY_MS = 24 * 60 * 60 * 1000;
/** `core` 档的**独立止涨线**（实测 core 档墙钟的 1.25–2 倍；口径与各步预算一致：止涨线，不是性能目标）。
 *  ⚠️ 它与 `STEPS` 里 G5 的 `budgetMs`（全量档）是**两条线**：全量档的线不动。 */
const G5_FAST_BUDGET_MS = 420000;
/** 「冒烟底板 + 判据实现」：改了这些文件 ⇒ **每个域**的结论都可能变 ⇒ 必须全量档。
 *  ⚠️ 刻意**不**收 `renderer/**` 一类产品代码：那会让"每次改界面"都退化成全量、分层就白做了；
 *  产品侧的风险由「每日/放行点全量」这条频率兜住 —— **不假装它是可推导的**（这是抽样，不是证明）。 */
const G5_DEEP_FLOOR_RE = /^(scripts\/smoke\/|scripts\/smoke-[^/]*\.js$|main\.js$)/;

/** `--release` / `--g5=fast|full` 的解析（纯函数，入口只有这一处；非法值当场报错，不静默落回）。 */
function parseTierArgs(argv) {
  const args = (argv || []).slice(2);
  const pick = (name) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name) return args[i + 1] === undefined ? '' : args[i + 1];
      if (args[i].indexOf(name + '=') === 0) return args[i].slice(name.length + 1);
    }
    return null;
  };
  const release = args.indexOf('--release') >= 0;
  const raw = pick('--g5');
  let explicit = null;
  let error = null;
  if (raw !== null) {
    const v = String(raw).trim();
    if (G5_TIERS.indexOf(v) < 0) {
      error = '`--g5` 只认 ' + G5_TIERS.join(' / ') + '（收到 ' + JSON.stringify(v) + '）';
    } else explicit = v;
  }
  return { release: release, explicit: explicit, error: error };
}

/** 把毫秒说成人话（"36.2h"）—— 只用于打印，不参与判定 */
function fmtHours(ms) {
  return (Math.round((Number(ms) || 0) / 36000) / 100).toFixed(2) + 'h';
}

/**
 * 本轮 G5 该跑哪一档（**纯函数**：时钟 / 历史 / 改动清单都由调用方递进来 ⇒ 可单测、可注入坏输入做
 * 判别力证明 —— 与 `checkBudgets` / `planBoundary` 同一分工）。
 * @param {{explicit?:'fast'|'full'|null, release?:boolean, now?:number,
 *   lastFull?:{at:string,ok:boolean}|null, changedFiles?:string[]|null, fullEveryMs?:number}} input
 * @returns {{tier:'fast'|'full', hits:Array<{code:string,why:string}>, auto:Array,
 *   overrode:Array, explicit:string|null}}
 *   `hits` = **造成这一档的全部理由**（打印用；空数组 = 没有任何硬条件 ⇒ 快档）；
 *   `auto` = 自动条件（周期 / 历史 / 改动面）；`overrode` = 被**显式 fast** 覆盖掉的周期触发。
 */
function decideG5Tier(input) {
  const o = input || {};
  const now = Number.isFinite(o.now) ? o.now : 0;
  const everyMs = Number.isFinite(o.fullEveryMs) && o.fullEveryMs > 0 ? o.fullEveryMs : G5_FULL_EVERY_MS;
  const auto = [];
  const lastFull = o.lastFull || null;
  if (!lastFull) {
    // 没有记录 ⇒ 不知道 deep 档上次是什么时候跑的 ⇒ 按"未知"处理（未知不是绿，见 A5）
    auto.push({ code: 'no-full-record', hard: true,
      why: '历史里没有一条**跑过 G5 的全量档**记录（' + VERIFY_HISTORY + '）⇒ 不知道 deep 域上次是什么时候跑的' });
  } else if (lastFull.ok !== true) {
    auto.push({ code: 'last-full-red', hard: true,
      why: '上次全量档**是红的**（' + String(lastFull.at || '?') + '）⇒ 不许用快档把它盖过去' });
  } else {
    const at = Date.parse(lastFull.at);
    if (!Number.isFinite(at)) {
      auto.push({ code: 'last-full-unparsable', hard: true,
        why: '上次全量档的时间读不懂（' + JSON.stringify(lastFull.at) + '）⇒ 按"不知道"处理' });
    } else if (now - at >= everyMs) {
      auto.push({ code: 'stale', hard: false,
        why: '距上次成功全量档 ' + fmtHours(now - at) + '（阈值 ' + fmtHours(everyMs) + '）⇒ 该轮到全量了' });
    }
  }
  const files = o.changedFiles;
  if (files === null || files === undefined) {
    auto.push({ code: 'no-changes', hard: true,
      why: '取不到改动清单（没有 git / 不在仓库里）⇒ 抽样没有依据' });
  } else {
    const floor = (files || []).map((f) => String(f).trim().replace(/\\/g, '/'))
      .filter((f) => G5_DEEP_FLOOR_RE.test(f));
    if (floor.length) {
      auto.push({ code: 'floor', hard: true,
        why: '改动命中**冒烟底板 / 判据实现** ' + floor.length + ' 个（'
          + floor.slice(0, 3).join('、') + (floor.length > 3 ? ' 等' : '')
          + '）⇒ 每个域的结论都可能变' });
    }
  }
  const strong = [];
  if (o.release === true) strong.push({ code: 'release', why: '放行点 / 交付前（`--release`）：这一档不许省' });
  if (o.explicit === 'full') strong.push({ code: 'explicit-full', why: '显式要求全量档（`--g5=full`）' });
  if (strong.length) return { tier: 'full', hits: strong.concat(auto), auto: auto, overrode: [], explicit: 'full' };
  const hard = auto.filter((h) => h.hard !== false);
  if (o.explicit === 'fast') {
    // 显式 fast 只压过**周期触发**（"该轮到全量了"），压不过"未知 / 上次红 / 底板改动"这三条硬条件
    if (hard.length) {
      return { tier: 'full', hits: hard.concat(auto.filter((h) => h.hard === false)),
        auto: auto, overrode: [], explicit: 'fast' };
    }
    return { tier: 'fast', hits: [], auto: auto, overrode: auto.slice(), explicit: 'fast' };
  }
  return { tier: auto.length ? 'full' : 'fast', hits: auto, auto: auto, overrode: [], explicit: null };
}

/**
 * 历史里最近一条「**真的跑过 G5** 的全量档」记录（供 `decideG5Tier` 的周期 / 红色判定）。
 * 口径三条（都会被误读，所以写死）：
 *   ① 分层之前的老记录没有 `g5Tier` 字段 ⇒ **当时跑的就是全部域** ⇒ 按 `'full'` 读；
 *   ② `partial: true`（`--changed` / `--for` 的部分验证）**不算** —— 它本来就不是全量；
 *   ③ 记录里 G5 那一步必须**真的跑过**（`skipped` 或 `code === null` 都不算）：否则"失败在 G1"这种
 *      记录会把全量档的时钟重置掉 —— 而 deep 域其实一个都没跑 ✗。
 * @returns {{at:string|null, ok:boolean, totalMs:number|null}|null}
 */
function readLastFullG5() {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, VERIFY_HISTORY), 'utf8'); }
  catch (e) { return null; }                      // `.review/` 是可随时整包删掉的工作产物区
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!String(lines[i]).trim()) continue;
    let r;
    try { r = JSON.parse(lines[i]); } catch (e) { continue; }   // 坏行跳过（半截行是可能的）
    if (!r || r.partial === true) continue;
    const tier = r.g5Tier === undefined ? 'full' : r.g5Tier;
    if (tier !== 'full') continue;
    const g5 = Array.isArray(r.steps) ? r.steps.filter((s) => s && s.gate === 'G5')[0] : null;
    if (!g5 || g5.skipped === true || g5.code === null || g5.code === undefined) continue;
    return { at: r.at || null, ok: r.ok === true, totalMs: typeof r.totalMs === 'number' ? r.totalMs : null };
  }
  return null;
}


/** 与上一条历史逐门禁比较（纯函数，便于单测）。
 *  `skipped` 的步骤（与上一步共用一次调用）不参与比较 —— 它的 ms 是 0，比出来是假信号 ✗ */
function historyDelta(prev, results, currentTotalMs) {
  if (!prev || !Array.isArray(prev.steps)) return null;
  const byGate = {};
  for (const s of prev.steps) if (s && s.gate) byGate[s.gate] = s;
  const out = { byGate: {}, total: null };
  for (const r of results) {
    if (r.skipped) continue;
    const p = byGate[r.gate];
    if (!p || p.skipped || typeof p.ms !== 'number') continue;
    /* G5 **跨档比较是假信号**：快档（只跑 core 域）与全量档的耗时差一个数量级，
     * 拿它当"这轮快了 800s"会让人以为优化成功 ✗ ⇒ 档不同就只说读数、不给差。 */
    if (r.gate === 'G5' && r.tier !== undefined && p.tier !== undefined && p.tier !== r.tier) {
      out.byGate[r.gate] = { ms: p.ms, deltaMs: null, why: '档不同（上次 ' + p.tier + ' / 本次 ' + r.tier + '）' };
      continue;
    }
    out.byGate[r.gate] = { ms: p.ms, deltaMs: r.ms - p.ms };
  }
  if (typeof prev.totalMs === 'number' && typeof currentTotalMs === 'number') {
    out.total = { ms: prev.totalMs, deltaMs: currentTotalMs - prev.totalMs };
  }
  return out;
}

/** 差的显示形式：**总是带符号**（"+7.6s" / "-12.3s"），负=变快 ✓ */
function fmtDelta(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  const s = ms / 1000;
  return (s > 0 ? '+' : s < 0 ? '-' : '±') + Math.abs(s).toFixed(1) + 's';
}

/* ---------------- 兜底备份的新鲜度（只提示，不判红） ----------------
 * 为什么需要：**两件互相替代不了的事**必须都看着 ——
 *   ① **本地回滚**（本地 Git 有没有提交）：改了能回去；
 *   ② **工程外备份**（`D:/backup/...` 有没有东西）：磁盘/整个目录丢了还能起。
 * 2026-09-29 起 ① 已具备（`.git/objects` 的 EDR 拦截解除，见 `docs/INCIDENTS.md`），但 ② 仍然缺 ——
 * 而**本地提交救不了磁盘丢失**（`.git` 就在同一块盘上）。所以这条提示不能因为"有 Git 了"就删掉，
 * 只能把"零提交"那句**已经过时的前提**改对（它原先是"Git 零提交 ⇒ export-json 是唯一手段"，
 * 现在两者是**两个独立的兜底**，各自都要看）。
 * 这里只做"提醒"，因为"该不该现在备份"是人的判断（M1：损害高但动作可具体描述 ⇒ 提示 + 约定）。 */
const BACKUP_DIRS = ['D:/backup/ai-mind-map', 'D:/backup'];

/** 本地 Git 有几条提交。0 = 没有可用历史；null = 取不到（没装 git / 不是仓库 / 超时） */
function gitCommitCount() {
  try {
    // stdio 用管道是安全的：这里只为读数，且不经过被测脚本（与文件头①那条"别用管道收集被测进程输出"无关）
    const r = spawnSync('git', ['rev-list', '--count', 'HEAD'],
      { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return 0;
    const n = parseInt(String(r.stdout || '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

function checkBackupFreshness() {
  let newest = 0;
  for (const d of BACKUP_DIRS) {
    try {
      for (const f of fs.readdirSync(d)) {
        const st = fs.statSync(path.join(d, f));
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch (e) { /* 目录不存在即跳过 */ }
  }
  return newest ? { at: newest, days: Math.round((Date.now() - newest) / 86400000) } : null;
}

/**
 * 验证链的唯一定义。字段：
 *   step    步号     gate 门禁编号（见 docs/RULES.md §2）  label 简称
 *   cmd     实际执行（给 runner）    shown 给人看的等价命令（写进 VERIFY.md）
 *   covers  覆盖什么（写进 VERIFY.md）
 *   budgetMs 该步预算（止涨线，见文件头②）
 *
 * 【2026-09-30 调整：数组顺序与门禁编号**不再一致**，这是有意的】
 * 执行顺序 = 数组顺序（runner 就是按这个数组跑的），门禁编号只是名字，不表示先后。
 * 为什么把"生成物类"检查提到前面（G8 → G9 → G3 → G6 → G7）：
 *   它们便宜（合计 < 3 s）、而且它们红了往往要**回头改文档 / 补元信息 / 重跑 `npm run facts:write`** ——
 *   放在链末，就意味着改了预算而忘了 `facts:write` 时，前面的测试与冒烟（90 s+）**全部白跑一遍才报错**
 *   （2026-09-30 真实发生：一晚上连跑 6 次，每次都要等链末那句"生成物已过期" ✗）。
 *   一句话：**最可能红、又最便宜、且决定要不要回头重做的检查，排最前**。
 * 为什么不能把 G6 再往前挪到 G3 之前：
 *   G6 必须用 **G3（vitest）产出的用例数**（经 `.review/verify-tests.json` 传入），否则它会退化去
 *   自己重跑一次 vitest（慢约 5–9 s，而且那一次在负载高时偶发取不到真值 ⇒ G6 假红）。
 *   ⇒ 顺序约束是"**G3 之后、但仍要早于昂贵步骤**"，所以落在第 5 位。
 * 改动本数组（顺序 / 命令 / 预算）时**必须同批**跑 `npm run facts:write`：
 *   `docs/VERIFY.md` 的链路表与合计预算由本数组渲染（`scripts/doc-facts.js`），不同批重生成
 *   ⇒ G6/G7 判"生成物已过期" ✗ —— 而按上面的新顺序，它会在**廉价步骤里就红**（这正是目的，
 *   不是故障；但**别把它当成可以留到下次的债**）。
 */
const STEPS = [
  {
    step: 1, gate: 'G1', label: '编码完整性',
    cmd: 'node scripts/encoding-check.js', shown: '`npm run check:encoding`',
    covers: '文件编码完整性：UTF-8 BOM / U+FFFD / 经典乱码特征；**提交进 index 的文本行尾一律 LF**（判的是**提交面** —— 工作树混合由 `core.autocrlf` 决定，**不判**）；扫描面 = **git 判为文本的跟踪文件（不看扩展名）** + `TEXT_EXT` 白名单只管非受管转储，**没扫什么每次运行都打印**',
    budgetMs: 10000
  },
  {
    step: 2, gate: 'G8', label: '文档登记与家门',
    cmd: 'node scripts/docs-registry-check.js', shown: '`npm run check:docs`',
    covers: '文档登记与家门：表外文档 / 散落文档 / 工程根与顶层目录乱放 / 悬挂登记'
      + '（登记表 = `docs/ARCHITECTURE.md` §5；工作产物区 = `.review/`）',
    budgetMs: 10000
  },
  {
    step: 3, gate: 'G9', label: '规则文件自洽',
    cmd: 'node scripts/rules-consistency.js', shown: '`npm run check:rules`',
    covers: '规则文件自洽：声明条数 == 表格行数 / 表格未被引用块或空行打断 / 编号引用闭合 / 实现列点名的脚本存在',
    budgetMs: 10000
  },
  {
    step: 4, gate: 'V1', label: '可见性判据',
    cmd: 'node scripts/visibility-judge-check.js', shown: '`node scripts/visibility-judge-check.js`',
    covers: '冒烟断言**判据的来源**：名字里声称"可见/看不见/遮挡/在框外/在面板内"的断言，'
      + '必须有真判据（`elementFromPoint` 命中测试 / `scanRegion` 等真帧像素）或一行显式豁免'
      + '（`判据-豁免: <原因>`）—— 只用 rect / 类名 / `style.display` 判"可见"的断言对**裁切与遮挡是盲的**'
      + '（实测：同一元素被 `overflow:hidden` 裁掉时 rect 读数与正常显示完全相同，而真帧像素 81 vs 768）',
    // 纯文本扫描（37 个冒烟域文件，实测 ≈0.3 s）⇒ 按本文件惯例取实测的十几倍仍是 10 s 档（廉价门禁）
    budgetMs: 10000
  },
  {
    step: 5, gate: 'V2', label: '冒烟域内自收尾',
    cmd: 'node scripts/smoke-state-check.js', shown: '`node scripts/smoke-state-check.js`',
    covers: '冒烟**域内自收尾**（跨域状态污染）：凡是会**留下浮层/模态**的动作（`addNode`/`addTopic` 会顺手'
      + '打开「编辑节点」框；`openFilePreview`/`openAudit`/`openPalette`/… 各自留下浮层），域末必须给出收尾'
      + '（共用入口 `closeDialogs(ctx)`，或产品自己的关闭口）或写一行豁免 —— 而"每域隔离"收不掉 DOM 模态'
      + '（它只还原项目数据 + 重开项目）⇒ 模态会跨域存活、盖住后面域的画布'
      + '（实测：域 16 一处漏关 ⇒ 域 36/37 连锁红 11 条，而那两个文件一行都没改过 ✗）。'
      + '运行时兜底是 main.js 的"域开始的干净前置"（有残留 ⇒ 该域判红并**点名是哪个域留下的**）',
    // 纯文本扫描（37 个文件，与 V1 同量级）⇒ 10 s 档
    budgetMs: 10000
  },
  {
    step: 6, gate: 'S1', label: '单向依赖',
    cmd: 'node scripts/dep-direction-check.js', shown: '`node scripts/dep-direction-check.js`',
    covers: '**单向依赖**（声明在 `docs/ARCHITECTURE.md` §4 原则 2：renderer → main/scripts → cli → src，'
      + '不反向依赖）：扫第一方源码的 `require`/`import` 边，按**单源分层图**（本门禁的 `LAYERS`，只写一处）'
      + '判方向 —— **反向边即红并指名 `A → B`**，同层成环与"指向分层图之外"也判红（在册豁免除外）。'
      + '它守的正是 skill 点名的"性质成立、检查没建"那一类：这条约束一直成立（实测零回边），'
      + '但**一次顺手 `require` 就能破而全链不红** ✗',
    // 纯文本扫描 + 一行 require 解析（实测 ≈0.1 s）⇒ 取十几倍仍是 10 s 档（廉价门禁）
    budgetMs: 10000
  },
  {
    step: 7, gate: 'S2', label: '连带清单',
    cmd: 'node scripts/collateral-check.js', shown: '`node scripts/collateral-check.js`',
    covers: '**改动即连带清单**：把"改动类型 → 连带处"做成**单源表**（本脚本的 `COLLATERAL`），'
      + '并对其中**尚未机制化**的那几处直接断言（① MCP 派发到的每条 CLI 命令都必须存在；'
      + '② 每个冒烟域都必须在断言注册面的索引里）；已机制化的那几处（G8 / G7 / G6 / V2 / V1 / G8 第 ⑮ 条…）'
      + '**指过去复用**，只校验那个门禁真的挂在链上 ✗ 不重做。`--list` 现场打印全表（报错即指路）',
    budgetMs: 10000
  },
  {
    step: 8, gate: 'S3', label: '确定性产物',
    cmd: 'node scripts/determinism-check.js', shown: '`node scripts/determinism-check.js`',
    covers: '**确定性产物**（判据 `A-08`）：产物登记表（声明面 = `docs/ARCHITECTURE.md` §5.2，双向闭包）里'
      + '**真值比**的产物必须"同一状态**连续两次**重算逐字节相同"（含时钟 / 随机 / 顺序 / 工作区四类扰动，'
      + '差异来源可分类）；**允许不确定**的产物必须在生成器里**点名标注**"非确定性、不得当真值"；'
      + '自述是生成物却没进表的一律判红。**乙档上线**：被当证据真值用、但判定尚不存在的那些住在'
      + '**门禁侧的封闭欠账册**里（`--debt` 现场取，只减不增，修好忘销账或册上对象不存在都判红）',
    budgetMs: 10000
  },
  {
    step: 9, gate: 'G3', label: '单元测试',
    // 与 `npm test` 等价，**外加** JSON reporter：把用例数交给第 10 步（doc-facts），
    // 于是整条链只需要跑**一次** vitest（以前 doc-facts 会再跑一次：慢约 5 s，
    // 而且正是那一次在负载高时偶发取不到真值、把 G6 判红）。
    // `--reporter=default` 保留人看的输出，故这一步的观感与 `npm test` 一致。
    cmd: 'node node_modules/vitest/vitest.mjs run --pool=threads --reporter=default '
      + '--reporter=json --outputFile=' + TEST_RESULTS,
    shown: '`npm test`（附加 JSON reporter 把用例数交给 G6，省一次 vitest 重跑）',
    covers: '共享核心 `src/` 各模块（含 data-store 原子写、BOM 容错与并发版本闸门）',
    /* 60s → **69s**（2026-10-17，外部链接出口批）。依据是**现算**、不抄数字：
     *   窗口（最近 10 次成功全链）G3 = 30954 / 40783 / 41469 / 31905 / 31203 / 31434 / 33622 / 31782 / 41293 / **54987**，
     *   Max = 54987ms ⇒ `tests/verify-budget.test.js` 的口径「预算 ≥ 1.25 × 窗口内**最大**耗时」要求 ≥ **68734ms**
     *   ⇒ 取整 69000（69000/54987 = **1.2549** ✓）。
     * ⚠️ **这不是"承认 G3 变慢了"**：54987 那一次的代码与上两次（41293 / 41469）**完全相同**，
     *   是负载浮动（同一次运行里 G5 也一起到了 994459ms）⇒ 抬预算抬的是**容错**，不是性能目标。
     * ⚠️ **升级触发条件（写给下一次）**：若在**代码不变**的情况下 G3 再出现 > 50s，**先查负载/并发**
     *   （同时段 G5、同机其它 Electron/vitest），**不要继续抬预算** —— 否则 1.25× 只是把红灯推迟，
     *   预算会一路漂上去而没人再看它。
     * ⚠️ 连带：各步预算之和 1535000 → **1544000** ≤ `TOTAL_BUDGET_MS` **1600000** ✓（余量 65000 → 56000）；
     *   `docs/VERIFY.md` 是生成物 ⇒ 同一批里 `npm run facts:write` 重生成（G6 的口径）。
     *   本步的用量守卫**不需要**改：`tests/verify-budget.test.js` 是 `require` 现读 `STEPS` 的、不抄数字。 */
    budgetMs: 69000,
    resultsFile: TEST_RESULTS
  },
  {
    step: 10, gate: 'G6', label: '文档数字与版本一致',
    cmd: 'node scripts/doc-facts.js --check', shown: '`node scripts/doc-facts.js --check`',
    covers: '文档数字与真值一致（含**第一屏 `SKILL.md` 自报的验证链步骤数** == `STEPS.length`）、版本号四处一致',
    // 20 s：正常情况（采用链上用例数）约 0.7 s；**交接失效退化为自跑 vitest 时约 9.2 s**
    // 仍容得下，但更严重的退化会被抓住。
    budgetMs: 20000,
    useUnitTests: true // 由第 9 步（G3）传入用例数，省掉这里的 vitest 重跑
  },
  {
    step: 11, gate: 'G7', label: '生成物未过期',
    cmd: null, shown: '同上（重算比对）',
    covers: '生成物是否过期（`docs/CLI.md` 与 registry 一致）',
    budgetMs: 0 // 与 G6 同一次调用，单独不占预算
  },
  {
    step: 12, gate: 'G4', label: 'CLI 集成断言',
    cmd: 'node scripts/cli-integration.js', shown: '`node scripts/cli-integration.js`',
    covers: '全部 CLI 命令端到端（**进程内调用**，临时项目，自动清理）',
    // 预算调整史（每次都带实测依据 ✓）：
    //   · 原值 30s：按 2026-09 的实测（≈4.5–11s）取 2–3 倍余量，当时很宽 ✓。
    //   · 2026-10-13：**30s→60s**。当天实测（`.review/verify-history.jsonl` 真读数）：
    //     两次失败运行里 G4 = 26.6s / 26.5s、另一次 29.3s；最近一次成功全链（15:28）**29.5s**
    //     ⇒ 距 30s 只剩 **0.5s** ✗。而当天全机同时慢 20–30%（同几轮读数：G3 30.8→38.9s），
    //     即"30s 预算在慢档里**必然假红**"（29.5×1.2 ≈ 35s）：判据全绿、只是机器慢，
    //     却以"CLI 集成断言太慢"的形状报出来 —— 那不是止涨线，是随机红灯 ✗（与 G5 那次同型）。
    //     60s = 快档基线 23.8s 的 **2.5×**、慢档 29.5s 的 **2.0×** ⇒ 先止住假红，
    //     再由"预算 = 止涨线"抓真正的变慢（真涨到 60s+ 仍然红 ✓）。
    //   · ⚠️ 只有**这一步**的预算动了：其余步骤原值不动，G5 的 450s 与 main.js 的守卫 540s 也未动 ✓。
    budgetMs: 60000
  },
  {
    step: 13, gate: 'G2', label: '数据校验',
    cmd: 'node cli/mm-cli.js validate-all', shown: '`node cli/mm-cli.js validate-all`',
    covers: '全部项目结构 + 悬挂链接 + 环',
    budgetMs: 15000
  },
  {
    step: 14, gate: 'G5', label: '冒烟（Electron 无头）',
    cmd: 'npm run smoke', shown: '`npm run smoke`',
    covers: '渲染层（Electron 无头，含监听器泄漏回归）+ **真实数据隔离**；'
      + '**分两档**（定档 = `scripts/verify.js` 的 `decideG5Tier`；名单与域数/断言数的**现算值** = '
      + '`scripts/smoke-assertions.js` 的 `TIERS` / `tierSummary()`，每次冒烟都会打印）：'
      + '`fast` = 只跑 `core` 域（**不产**截图 / 取景记录 / 视觉断言）、`full` = 全部域 + 视觉断言 + 取景记录；'
      + '**必须 full 的条件（可判定）**：`--release` 放行点 / `--g5=full` / 历史里没有全量档 / 上次全量档是红的 / '
      + '距上次成功全量档 ≥ 24h / 取不到改动清单 / 改动命中 `scripts/smoke/**`·`scripts/smoke-*.js`·`main.js`。'
      + '每次运行都打印**逐域耗时排行**（`summarizeTiming`），G5 预算按档取（快档 = `G5_FAST_BUDGET_MS`）',
    // 预算调整史（每次都带实测依据 ✓）：
    //   · 2026-09-29：22-* / 23-* 要**真建原生侧栏 view**，实测 130.7s ⇒ 120s 不成立 ⇒ 150s。
    //   · 2026-09-30：查明那三条断言的耗时大头是**顺手孵化了一个真的内置 DSH 服务**
    //     （40–60s，且随负载抖到 172.7s ⇒ 同代码 94.9s 绿 / 172.7s 被守卫掐红 ✗）；
    //     冒烟模式改 `setNoSpawn(true)`（不孵化、也不接管用户的服务 ✓）后只要 11.5s ✓
    //     ⇒ 预算收回 150s（仍是实测的 2 倍余量）。
    //   · 2026-10-08：每域隔离改为**默认开**（正确语义 ✓，见 main.js 的 smokeIsolate）⇒ 实测
    //     155.1s（另一次 164.7s；隔离让 12 个域各多一次"还原 + 重载"）⇒ 150s 已不成立 ✗。
    //     预算按本文件惯例（实测的 ~2 倍）设为 320s —— 仍是止涨线，不是性能目标 ✓。
    //     想临时跑快：MM_SMOKE_NO_ISOLATE=1（**只用于诊断** ✗，那时结果不再是全量真值口径）。
    //   · 2026-10-13：预算 320s→**450s**。当天两次全链都是
    //     **判据没错、被自己的守卫掐断**：G5 实测 **304.6s / 304.6s**（合计 375.0 / 377.0s），
    //     报文里只有 `SMOKE GUARD TIMEOUT — force exit`（无 FAIL/THREW），而 main.js 的守卫当时是 300s ✗。
    //     结构性原因：320s 对**同一天的绿链读数** 243.6 / 248.8 / 246.1 / 250.4s（07:32–09:42 四次）
    //     只有 1.28–1.31× 余量 ⇒ 那不是止涨线，是**随机红灯**；而当天全机同时慢 20–30%
    //     （同两次运行里 G3 30.8→38.9s、G4 23.8→26.5s，幅度同向同量级）⇒ 贴线必然偶发假红。
    //     450s = 基线 250s 的 **1.8×**，同时高于已实测到的 304.6s（1.48×）⇒ 慢机器不再假红，
    //     而"悄悄涨回 400s+"仍然会被抓住（本文件惯例：预算取实测 2 倍上下，是止涨线不是性能目标）。
    //     配套：`main.js` 的冒烟守卫同步 300s→**540s**（= 450 × 1.2）。
    //     **不变量：守卫 > 预算** —— 预算判"太慢"（止涨线、判红时带读数与差额），
    //     守卫只拦"真挂死"（没读数、只能强杀）；守卫先触发会把"跑完了、判据全绿、只是机器慢"
    //     报成崩溃（正是本次两红的形状）⇒ 两者代价不对等，守卫**必须永远大于本步预算** ✓。
    //   · 2026-10-14（R4 界面批）：预算 450s→**540s**，依据两条**实测**：
    //     ① 新增的域 42（绑定工作区文件夹的界面判据）给 G5 **净增 ≈40s**
    //        （实测量法：`SMOKE_ONLY=01` 5.7s vs `SMOKE_ONLY=01+42` 45.6s）；
    //     ② 最近 10 条成功链的 G5 是 **342–421s** ⇒ 加上这 40s 后中位约 400s、慢日会越过 450s ✗
    //        ⇒ 旧预算已从"止涨线"退化成"随机红灯"。
    //     540s ≈ 窗口最小读数 250.386s 的 **2.16×**（本文件惯例的 2 倍上下 ✓），
    //     同时给"悄悄涨回 500s+"留不住位置（`tests/verify-budget.test.js` 的余量守卫 >1.8× 仍在守 ✓）。
    //     配套：`main.js` 的冒烟守卫 540s→**660s**（= 540 × 1.22 ⇒ 不变量①继续成立 ✓）。
    //     ⚠️ 上面那句"余量守卫 >1.8×"是**当时的旧口径**；同日（2026-10-14）余量守卫已改成
    //     "预算 ≥ 1.25 × 窗口内**最大**耗时"（理由见 tests/verify-budget.test.js 文件头）——
    //     下面这一条 540→600s 就是被**新口径**抓出来的 ✓。
    //   · 2026-10-14（W13 批）：预算 540s→**600s**。依据两条**实测**（现算，不抄）：
    //     ① 新增的域 43（界面侧导入入口的 6 条判据）给 G5 **净增 36.5s**：
    //        上一批的 G5 = **400866ms**（2026-10-13T21:24:41 那一条成功链）→ 本批 = **437380ms**；
    //        域内量法同上一批：`SMOKE_ONLY=01` **6s** vs `SMOKE_ONLY=01,43` **36s**（本域自己 ~30s，
    //        大头是 14 次真 CLI 起子进程 + 真鼠标/真帧的等待 —— 判据不瘦身 ⇒ 这 36s 是**应该花**的 ✓）。
    //     ② **余量守卫（新口径）当场判红**：窗口最大耗时 = 437380ms ⇒ 1.25× = 546725ms > 540000ms
    //        ⇒ 比值 **1.2346 ✗**。也就是说：**"把 G5 干长了"这件事本身没错，错的是预算没跟着长**
    //        —— 守卫正是在说这句话。600000/437380 = **1.372** ✓（本批实测：全链 13/14 步绿、
    //        唯一红的就是这条余量守卫；调完预算后全链复跑 `ok=true` ✓）。
    //     配套：`main.js` 的冒烟守卫 660s→**720s**（= 600 × 1.2 ⇒ 不变量①继续成立 ✓）。
    //   · 2026-10-16（本批 = 热度条改版 / 血条形态 + 悬停浮层）：预算 600s→**700s**。依据**实测**（现算）：
    //     ① 热量条域（域 40）新增 **7 条**判据（⑦位置 ⑧形态+真帧调色板 ⑨比例随值变 ⑩条带无文字
    //        ⑪悬停三态（真鼠标）⑫文案现算对拍 ⑬无回归）：每条都要**真开一次详情框 + 真鼠标悬停 +
    //        真帧逐像素比对**（⑪ 一域内就 3 次真鼠标移动 + 3 次截图 + 逐像素差），本批全链实测
    //        G5 = **545609ms**（上一批 439583ms，本批**净增约 106s** —— 其中含域 45 同期在飞的那 8 条）。
    //     ② **余量守卫（口径：预算 ≥ 1.25 × 窗口内最大耗时）当场判红**：窗口最大 = 545609ms
    //        ⇒ 1.25× = **682011ms** > 600000ms ⇒ 比值 **1.0997 ✗**。这正是它想说的话：
    //        **"把 G5 干长了"没错，错的是预算没跟着长**（不许为了凑比值去砍真判据/压掉真鼠标等待 ✗）。
    //        700000/545609 = **1.283** ✓（留 1.25 的余量线，同时"悄悄涨回 650s+"仍会被抓住）。
    //     配套：`main.js` 的冒烟守卫 720s→**840s**（= 700 × 1.2 ⇒ 不变量①继续成立 ✓）；
    //     合计预算 900s→**1100s**（各步预算之和从 835s 变成 **935s**，从本数组现算 ⇒ 合计必须 ≥ 它，
    //     否则合计会抢在单步前面报红；1100 ≈ 935 × 1.18，让"单步先发声"继续成立 ✓）。
    //     **教训（写进提交正文）**：凡是让 G5 变长的批次，必须在**同一批**里把预算按 1.25×max 重算好
    //     —— 预算要跟着工作量走；**不许**为了凑比值去砍真判据或压掉真鼠标/真 CLI 的等待 ✗。
    //   · 2026-10-14（本批 = R2 期 2 / 拖动单个子树或节点 + 菜单溢出修复）：预算 700s→**750s**。
    //     依据**实测**（现算）：本批新增冒烟域 46（5 条断言，内含 3 次真鼠标拖动 + 六处现量 +
    //     1 次低位置右键菜单逐项命中），本批全链实测 G5 = **573400ms**（上一版 511600ms ⇒
    //     **净增约 62s**）。① 旧预算已不成立：700000/573400 = **1.221** < 1.25 ✗；
    //     ② 750000/573400 = **1.308** ✓（既过 1.25 的余量线，又让"悄悄涨回 620s+"被抓住）；
    //     ③ 本批还修掉域 46 甲在全链负载下的一处**假红**（`renderMind` 末尾的延后居中落在
    //     "量基线"与"按下"之间 ⇒ 11 个矩形被整体平移）—— 修法是等画布稳定，**不是**放宽判据。
    //     配套：`main.js` 的冒烟守卫 840s→**900s**（= 750 × 1.2 ⇒ 不变量①继续成立 ✓）；
    //     合计预算 **1100s 不动**（各步预算之和 935s→**985s**，从本数组现算 ⇒ 仍 ≤ 1100s ✓，
    //     1100/985 = 1.117，单步仍先发声）。**不许**为了凑比值去砍真判据 ✗。
    //   · 2026-10-14（本批 = 修「保存后视图折回只展开根」）：预算 750s→**800s**。
    //     依据**实测**（本批在**同一台机器、同一档负载**下跑的两轮**全量冒烟**）：
    //     `npm run smoke` 墙钟 **635667ms / 639170ms**（＝ G5 的同一条命令）。
    //     ① 旧预算已不成立：750000/639170 = **1.173** < 1.25 ✗（不是"慢"这个判断，是**余量线**不成立）；
    //     ② 800000/639170 = **1.252** ✓ 过线；③ 本批净增的分量是**域 46 三条新断言**
    //     （己/庚/辛：真鼠标拖一次 + 两次"等过 `project:disk-changed` 一拍" + 一次合并保存 + 一次
    //     经主进程 CLI 的写入），以及本批顺带修掉域 45 乙的一条**全链负载下必现的假红**
    //     （几何基线取在右键之前 ⇒ 右键选中触发的「重排锚点保持」补偿把非目标节点整体平移 33px
    //     ⇒ 两条判据一起红；修法是把基线挪到右键之后，**不是**放宽判据）。
    //     ⚠️ 另一条读数（同批）：把渲染层临时换回 HEAD 跑全量冒烟 ⇒ **> 900s 被守卫强杀**
    //     （报文只剩 `SMOKE GUARD TIMEOUT — force exit`）⇒ 守卫与预算**必须同批**抬，
    //     否则"跑完了却看不见读数"。配套：`main.js` 的守卫 900s→**960s**（= 800 × 1.2 ✓）；
    //     合计预算 **1100s 不动**（各步预算之和 985s→**1035s** ⇒ 仍 ≤ 1100s ✓，1100/1035 = 1.063）。
    //   · 2026-10-14（同批第二次现算，**依据换成了全链里的真读数**）：预算 800s→**820s**。
    //     依据：本批第一次全链的 G5 = **645600ms**（那一次红在域 45 乙那条既有假红上，见 CHANGELOG）。
    //     ① 800s 已不成立：800000/645600 = **1.239** < 1.25 ✗（余量线，不是"慢"这个判断）；
    //     ② 820000/645600 = **1.270** ✓（取整到 10s，并留一点给"同一档负载下的逐轮波动"）。
    //     配套：`main.js` 的守卫 960s→**985s**（= 820 × 1.2 ⇒ 不变量①继续成立 ✓）；
    //     合计预算 **1100s 不动**（各步预算之和 1035s→**1055s** ⇒ 1100/1055 = 1.043 ✓）。
    //   · 2026-10-16（**验证成本批 1**）：预算 820s→**830s**。依据**本批全链里的真读数**（现算，不抄）：
    //     本批全链 G5 = **656100ms** ⇒ ① 旧值已不成立：820000/656100 = **1.2498** < 1.25 ✗
    //     （余量线，不是"慢"这个判断）；② 830000/656100 = **1.265** ✓（留一点给同档负载的逐轮波动，
    //     同时"悄悄涨回 700s+"仍会被抓住）。本批**新增冒烟断言 0 条**（改的是验证侧：`--for` 选步、
    //     临时目录唯一化、真实数据三档）⇒ 这 +15.7s 属同档负载波动，**不是**工作量增长；
    //     但余量守卫是机械的 ⇒ 按同一条不变量**同批现算重算**（判据一条不砍 ✓）。
    //     配套：`main.js` 的冒烟守卫 985s→**996s**（= 830 × 1.2 ⇒ 不变量①继续成立 ✓）；
    //     合计预算 **1100s 不动**（各步预算之和 1055s→**1065s** ⇒ 1100/1065 = 1.033 ⇒ 单步仍先发声 ✓）。
    //   · 2026-10-16（R7-0 批）：预算 830s→**880s**。依据**现算**（不抄数字）：
    //     ① 本批**真的加了工作量**：新增冒烟域 47（详情正文/站内链接/笔记链接配色，6 条断言）
    //        ⇒ 域内量法同上一批（`SMOKE_ONLY=01` **5.3s** vs `SMOKE_ONLY=01,47` **18.5s** ⇒ 净增 ≈ **13.2s**）；
    //     ② 余量线按"最近 10 次成功全链的**最大** G5"现算：窗口最大 = **656100ms**（2026-10-14T09:35 那条）
    //        ⇒ 加上本批净增 ⇒ 约 **669.3s** ⇒ 1.25× = **836625ms** ⇒ 取整数档 **880s**（比值 ≈ **1.315** ✓，
    //        给同档负载的逐轮波动留出余量；"悄悄涨回 705s+"仍会被抓住）；
    //     ③ 本批**一条判据都没砍**（`testing-for-ai` A2 的止涨线是"不许涨"的守卫，不是性能目标 ⇒
    //        涨了工作量就同批抬线，别为了凑比值去砍真判据/压掉真鼠标等待 ✗）。
    //     配套：合计预算 **1100s→1150s**（各步预算之和 1065s→**1115s** ⇒ 1150/1115 = 1.031 ⇒ 单步仍先发声 ✓）；
    //     `main.js` 的冒烟守卫 996s **不动**（996 > 880 ⇒ 不变量①继续成立 ✓，余量 116s）。
    //   · 2026-10-16（R2 期 3 批 = 连线端点按子序分散 + 同级重排，接管收口）：预算 880s→**960s**。
    //     依据**现算**（不抄数字），含一条**被真读数证伪后再改口**的投影（如实记 ✗→✓）：
    //     ① 窗口最大 G5 = **688721ms**（最近 10 次成功全链里的最大，从
    //        `.review/verify-history.jsonl` 现读 —— 就是 R7-0 批那次全链落下的那条）；
    //     ② 先按"域内量法"估本批净增：`SMOKE_ONLY=01` **6.0s** vs `SMOKE_ONLY=01,48` **52.6s**
    //        ⇒ 新增冒烟域 48 量到 **46.6s** ⇒ 据此投影慢端 ≈ 741.3s；
    //     ③ ⚠️ **全链真读数把 ② 证伪了**：本批全链 G5 = **695.5s**、合计 **754.3s**
    //        ⇒ 链内边际其实只有 **+6.8s**。为什么域内量法偏高（别误用这一招）：过滤跑要为
    //        "01+48 两个文件"整套付掉启动/隔离/夹具的开销，而**链里那部分已被前面的域摊掉**；
    //        域内量法量的是"这个域自己的总耗时"，**不等于**它在链里的边际。
    //        ⇒ 教训（留给下一批）：新增域的**量级**可以用域内量法，**链内边际要看全链真读数**
    //        （`npm run verify` 的 G5 那一行 / `.review/last-verify.json`）。
    //     ④ 用真读数定线：1.25 × 695.5s = **869.4s** ⇒ 旧 880s 只比这条线高 **1.2%**
    //        （880/695.5 = 1.265 —— 数学上成立，但离"同档负载逐轮波动"太近）；
    //        960/695.5 = **1.380** ✓（与 R7-0 批"取整数档、给负载留位"同一做法），
    //        而"悄悄涨回 768s+"仍会被余量守卫抓住（960/768 = 1.25）。
    //     本批**一条判据都没砍**（涨了工作量就同批抬线，别为了凑比值去砍真判据 ✗）。
    //     配套：`main.js` 的冒烟守卫 996s **不动**（996 > 960 ⇒ 不变量①"守卫 > 预算"继续成立 ✓，
    //     余量 36s —— 比上一批薄；**再涨就必须同批抬它**，别让守卫先于预算把进程掐掉 ✗）；
    //     合计预算 **1150s→1230s**（各步预算之和 1115s→**1195s** ⇒ 1230/1195 = 1.029 ⇒ 单步仍先发声 ✓）。
    //     ⑤ 2026-10-16（R2 期 4 批）：960s→**1020s**。依据全链真读数 G5=**816.0s**
    //        （本批新增域 49 的 4 条 + 域 46 菜单多一项的连带；816s 这一轮同机有别的会话在跑，
    //        含负载成分 —— 按纪律**就高不就低**：1.25 × 816 = 1020 ⇒ 1020/816 = 1.25 ✓），
    //        960/816 = 1.176 < 1.25 ⇒ 旧线已从"止涨线"退化成"随机红灯" ✗。
    //        配套：`main.js` 的冒烟守卫 996s→**1080s**（1080 > 1020 ⇒ 不变量①继续成立 ✓）；
    //        合计 **1230s→1290s**（各步预算之和 1195s→**1255s** ⇒ 1290/1255 = 1.028 ⇒ 单步仍先发声 ✓）。
    //   · 2026-10-16（R2 期 5 批 = 结构轴：模式开关 / 双击分支 / 拖动口径 / 关系层画法）：1020s→**1140s**。
    //     依据**本批全链真读数**（现算，不抄）：G5 = **905482ms**（905.5s）。
    //     ① 旧预算已不成立：1020000/905482 = **1.1265** < 1.25 ✗（不是"慢"这个判断，是**余量线**不成立）；
    //     ② 按"预算 ≥ 1.25 × 窗口（最近 10 次成功全链）最大耗时"现算：1.25 × 905482 = 1131853
    //        ⇒ 取 **1140s**（1140000/905482 = **1.259** ✓，就高不就低）。
    //     本批工作量：新冒烟域 51 的 6 条（含 3 次真鼠标双击、1 次真鼠标拖动、2 轮关系视图两次 IPC、
    //     2 个夹具项目的读写）+ 同批**反转的两条既有断言**（域 03 的 R1 双击②、域 34 的用户路径④
    //     都要真鼠标 + 真帧 + 访问日志稳定等待）。**不为凑比值砍任何判据** ✗。
    //     配套：`main.js` 的冒烟守卫 1080s→**1370s**（1370 > 1140 ⇒ 不变量①「守卫 > 预算」成立 ✓，
    //     且 ≥ 1140×1.2 = 1368 ✓）；合计 **1290s→1430s**（各步预算之和 1255s→**1375s**
    //     ⇒ 1430/1375 = 1.04 ⇒ 单步仍先发声 ✓）。
    //   · 2026-10-16（R7 主体批 = 详情正文消毒 / Mermaid 懒加载 / 三类链接 / 笔记锚点）：1140s→**1300s**。
    //     依据**现算**（不抄数字）：窗口最大 G5 = **971595ms**（最近 10 次成功全链里的最大，
    //     从 `.review/verify-history.jsonl` 现读）⇒ ① 旧线已不成立：1140000/971595 = **1.173 < 1.25** ✗
    //     （余量守卫 `tests/verify-budget.test.js` 当场判红，报文里的 1.1733 就是它）；
    //     ② 本批**真的加了工作量**：新增冒烟域 52（10 条判据：真鼠标展开 / 真帧取色 / mermaid 三档 /
    //     出口调用账 / **全仓 detail 现算语料逐条消毒** / 2 次重开项目）；
    //     ③ 按纪律取"预算 ≥ 1.25 × 窗口最大"：1.25 × 971595 = **1214494** ⇒ 取整数档 **1300s**
    //     （1300000/971595 = **1.338** ✓，给同档负载的逐轮波动留位；"悄悄涨回 1040s+"仍会被抓住）。
    //     本批**一条判据都没砍**（涨了工作量就同批抬线，别为了凑比值去砍真判据 ✗）。
    //     配套：`main.js` 的冒烟守卫 1370s→**1560s**（1560 > 1300 ⇒ 不变量①「守卫 > 预算」成立 ✓，
    //     且 ≥ 1300×1.2 = 1560 ✓）；合计 **1430s→1600s**（各步预算之和 1375s→**1535s**
    //     ⇒ 1600/1535 = 1.042 ⇒ 单步仍先发声 ✓）。
    //   · 2026-10-18（本批 = **预算口径：`1.25×窗口最大` 换成 `1.25×窗口 P90`**）：1468s→**1300s**。
    //     依据**现算**（不抄数字）：窗口 = 跨全部历史最近 10 条 **full 档** G5 读数
    //     ⇒ `P90 = 1 034 564ms` ⇒ 1.25× = **1 293 205** ⇒ 取整 10s 档 **1300s**（1300000/1034564 = **1.2565** ✓）。
    //     ① **为什么不是 1.25×max**：窗口 max = 1 174 160ms 那一条已被上一批（`5a50d57`）坐实是**机器负载尖峰**
    //        —— 同一次 run 里 G3 涨 **1.267×**、G4 涨 **1.438×**，而这两个步骤与冒烟域 22 **毫无关系**
    //        （域 22 实测只有 15.4s / 3 条断言）⇒ 按 1.25×max 抬出来的 1468s 是**为一次尖峰付的钱**，
    //        而它把比值压到 **1.0002**（零余量）= 止涨线没有牙。换成 P90 后同样的 1.25 倍**只对慢端**生效。
    //     ② **为什么 P90 不会掩盖真实慢化**（本批逐条核过全历史，读数在 `.review/20261018-预算口径/`）：
    //        n=10 的 P90 是 nearest-rank **第 9 个值 = 第二大** ⇒ **只丢最大的那 1 条**：
    //        · 慢化只出现在 **1 条**读数里 ⇒ P90 不动 —— 这正是要的（单次尖峰不该永久抬线）；
    //        · 慢化出现在 **≥2 条**读数里 ⇒ P90 = 那两条里较低的一条；台阶式慢化（两条都停在新高度）下
    //          **与 max 口径的要求完全相同** ⇒ 持续变慢照样抬线；
    //        · 历史里 9 段"P90 连续上升"（最长 14 步、+118.9%）中 1.25×P90 **同步抬同样的百分比** ⇒ 没有漏判。
    //        **代价如实说**：台阶式慢化会**延迟 1 条读数**被发现（那一条还没进第 9 位）。
    //     ③ **升级触发条件（写给下一次）**：P90 涨到 **≥ 1 040 000ms**（= 1300000/1.25）⇒ 余量守卫判红。
    //        那时**先分辨「工作量增长 / 机器负载」**——分辨方法是看**同一次 run 的 G3、G4 是否同向同量级大涨**
    //        （那是负载的指纹：2026-10-18T05:43 那次 G3 1.267× / G4 1.438× / G5 只 1.135×）。
    //        **不许为了凑比值砍判据**，也**不许**再靠"抬到 1.25× 某一次读数"把线推上去。
    //     配套：`main.js` 的冒烟守卫 1560s **不动**（1560 > 1300 ⇒ 不变量①「守卫 > 预算」继续成立 ✓）；
    //     合计预算 1770000 **不动**（各步预算之和 1712000→**1544000** ⇒ 1770000/1544000 = **1.148** ⇒ 单步仍先发声 ✓）。
    //   · 2026-10-19（W5 空壳批，**父代理授权；性质 = 方差驱动的显式重校准**）：1300s→**1350s**。
    //     触发面（现算，不抄）：上一批 ③ 的升级条件命中了 —— 窗口 P90 = **1 045 412ms** ⇒ 1.25× = **1 306 765**
    //     > 1300000（比值 **1.2435**，差 **6 765ms / 0.52%**）。**剔除触发那一条就还是绿的**：
    //     同窗口 P90（剔掉 1 074 073ms 那一条）= **1 035 301** ⇒ 1.25× = 1 294 126 < 1 300 000（**1.2558** ✓）。
    //     ① **分辨「工作量增长 / 机器负载」的读数**（照 ③ 要求的方法）：触发那条 1 074 073ms 与窗口 max 是同一条；
    //        同一次 run 的 G3 = 52.9s（上一条 40.4s ⇒ 1.31×）、G4 = 31.5s（上一条 32.3s ⇒ 0.98×）⇒ 三个步骤**不同向**，
    //        且**紧接着的那一次 full 档冒烟单跑实测 966.2s**（比窗口里 10 条全部更快）⇒ **G5 没有变慢**，
    //        那一条是负载尖峰。产品侧新增的工作量在本批是"启动时一次 readdir + 一次 mkdir + 退出 rm 一个空目录"，
    //        实测清扫 **0 个 / 0 字节**（亚毫秒量级）。
    //     ② **抬多少**：1350s ÷ 1 045 412ms = **1.2914**，落在本文件头写明的 **1.25–1.43** 带内；
    //        不抬到"1.25×max（1 074 073）"的理由与 2026-10-18 ① 相同（那是为一次尖峰付钱）。
    //     ③ **判据一条都没砍**（本批不碰任何冒烟域文件、不减少断言：326 条不变）。
    //     ④ 配套不变式：`main.js` 冒烟守卫 **1560s 不动**（1560 > 1350 ✓）；
    //        各步预算之和 **1544s→1594s ≤ `TOTAL_BUDGET_MS` 1770s** ✓（1770/1594 = 1.110 ⇒ 单步仍先发声）。
    //     ⚠️ 如实登记一笔**症状层面的账**：`1.25×P90` 在 n=10 时 = 第 9 个值 = **第二大** ⇒ 只容忍**一条**尖峰，
    //        第二条就翻红；而同窗口 **median = 1 030 429 ⇒ 1.25× = 1 288 036 < 1 300 000（本就绿）**。
    //        ⇒ 更根本的修法是把统计量换成 median（对尖峰更稳、对持续变慢更敏感）——**那是独立一批，本次不做**。
    //   · 2026-10-19（本批 = **统计量 `1.25×窗口 P90` 换成 `1.25×窗口 median`**，并把上一批抬上去的那 50s 还回来）：
    //     1350s→**1300s**。依据**现算**（不抄数字，脚本与读数在 `.review/20261019-预算统计量/`）：
    //     ① **缺陷（现算确认）**：n=10 时 nearest-rank P90 = 第 9 个值 = **第二大** ⇒ **只容忍 1 条尖峰**
    //        （`b73c7ae` 换口径时的反例检查原话就是"只丢最大的那 1 条" —— 那句话描述的是缺陷，当时写成了优点）。
    //        当天已**两次实测**它不够：`3bf1586` 一条尖峰把线从 1300 顶到 **1468**（比值 1.0002 = 没有牙）；
    //        `550ed82`（上一批）又一次方差把线从 1300 顶到 **1350**（比值 1.2435）。
    //     ② **四口径在现预算上的判决**（13 条参与判定的门禁，G7 与 G6 共用一次调用不占预算）：
    //        `1.25×` max / P90 / P75 / median 在 1350000 下 **13/13 全绿**（判决全同）⇒ 单看判决分辨不出口径，
    //        分辨力在"**要求的最小预算**"上：G5 四者要求 1 350 000 / 1 310 000 / 1 300 000 / **1 290 000**。
    //        若降到 1300000：max **红**（差 42 591ms / 3.28%）· P90 **红**（差 6 765ms / 0.52%）·
    //        P75 绿（余量 5 874ms）· **median 绿（余量 11 964ms，比值 1.2616）**。
    //     ③ **反例检查四条（本批的核心，脚本 `counterexample.js`）**：
    //        · 连续变慢：历史里 12 段"典型水平连续上升"，median **12/12 同步抬**（0 段被误判成绿）；
    //        · 台阶式真变慢：6 处长台阶（平台 ≥6 条）上 median 滞后**中位 8.5 条**读数（P90 1.5 / P75 2.5 / max 0）
    //          ⚠️ **这是换 median 的真实代价，如实记**：它比 P90 **更慢**，不是更快；
    //          但它**有界**（构造上 6 条读数进入新高度即到位 ⇒ 界 ≤5 条；
    //          历史实测 8.5 条更多，是因为那段时期水平**还在继续往上走**，目标本身在抬 —— 两个数别混用）；
    //          且最新那条慢读数本身会被 `checkBudgets()` 的**逐步骤超预算判定**当场抓到
    //          ⇒ 滞后的是"该重校准"的提示，不是"慢化被发现"。
    //        · ⚠️「一半慢一半快」（5×1200 + 5×900）：median 读到 **1050**（落在两档之间），
    //          1.25×1050 = **1312 > 慢档 1200** ⇒ **慢档读数不会越过这条线**；代数边界：混合窗口
    //          `1.25×(S+F)/2 ≥ S ⇔ S ≤ 1.667×F` ⇒ 两档相差 >66.7% 才会真掩盖。
    //        · 掩盖核查（定义 = 守卫说绿、而窗口里有真读数越过预算）：**0 / 168 个历史窗口**。
    //     ④ **降预算的验收（判据一样：不许制造随机红灯）**：1300000 下逐窗口回溯全部历史
    //        ⇒ median 口径 **0 / 168 红**（最紧窗口 2026-10-18T15:04 要求 1 290 559，余量 9 441ms）；
    //        逐步骤判定 **0 / 177 条 run 越线**（历史最大读数 1 174 160，余量 125 840ms / 10.7%）；
    //        其余 12 条门禁在 median 口径下**全部 0 红**（不许顺手把别人弄红）。
    //     ⑤ **为什么不是 P75**（它是四者里判决最接近 median 的）：P75 在 1300000 下余量只有 5 874ms（0.45%），
    //        且实测有 4/167 个窗口出现"读数越过 1.25×P75"（median 是 20/167，但那些窗口的读数都远低于预算）
    //        ⇒ P75 既没有 median 的稳态，也没有 P90 的灵敏度，**折中的那一半没换来任何东西**。
    //     ⑥ 判据一条都没砍（本批不碰任何冒烟域文件，断言数不变）。
    //     配套不变式：`main.js` 冒烟守卫 **1560s 不动**（1560 > 1300 ✓）；
    //        各步预算之和 **1594s→1544s ≤ `TOTAL_BUDGET_MS` 1770s** ✓（1770/1544 = 1.146 ⇒ 单步仍先发声）。
    budgetMs: 1300000   // 2026-10-19（本批）：1350s→**1300s**；统计量换成 median（理由见上一条 ①–⑥）
  }
];

/** 整链预算（止涨线）。
 *  2026-09-30：实测 ~100–120 s ⇒ 取 180s。
 *  关键修复记录：侧栏那三条断言（22-、23-、24-）原先会顺手**孵化一个真的内置 DSH 服务**
 *  （40–60 s，且随机器负载抖到 172.7 s ⇒ 同一份代码 94.9 s 绿 / 172.7 s 被守卫掐红 ✗）；
 *  冒烟模式改成 `setNoSpawn(true)`（既不孵化也不接管用户的服务 ✓）后，它们只要 11.5 s ✓。
 *  2026-10-08：每域隔离改为**默认开**（正确语义 ✓；见 main.js 的 smokeIsolate）⇒ 全链实测
 *  197.8s ⇒ 180s 已不成立 ✗ ⇒ 按实测 ~2 倍取 400s。隔离买到的是「同一份代码稳定复现」，
 *  值这个时间 ✓（想临时跑快：MM_SMOKE_NO_ISOLATE=1，**只用于诊断** ✗）。
 *  2026-10-13：**400s→700s**，并补一条结构性依据（原先没人写下来）：
 *  **合计预算必须 ≥ 各步预算之和** —— 否则"每步都接近各自预算"的那一刻，会**先由合计报红**，
 *  把真正慢的那一步盖掉 ✗（合计红只说"整条链慢了"，说不出是哪一步）。
 *  新账：各步预算之和 = **685s**（G4 30→60s 之后；G5 一个就 450s）⇒ 旧 400s 连**一步**的预算
 *  都容不下（G5 顶到 450s ⇒ 必然同时触发合计红）；700s 才让"单步先发声"成立 ✓。
 *  实测依据：2026-10-13 全链实测 375.0 / 377.0s ⇒ 700s ≈ 1.86×；而"每步都顶到预算"的
 *  极端总和 685s < 700s ⇒ 合计不会抢在单步前面报红 ✓。
 *  ⚠️ 上面两条不变量**不只是注释**（批 J，2026-10-13）：`tests/verify-budget.test.js` 里各有一条
 *  **机械守卫** —— 它从 `main.js` 现读冒烟守卫、从本 `STEPS` 现算各步预算之和再断言（**不抄数字**）。
 *  ⇒ 以后改任何一步的预算，**必须同批**让这两条关系继续成立，否则单测直接红（而不是等下一批
 *  真的踩到时才发现 ✓）。
 *  2026-10-14（R4 界面批）：**700s→900s**。G5 预算 450→540s（理由见上面 G5 那一段）之后，
 *  各步预算之和变成 **775s**（G1 10 + G8 10 + G9 10 + V1 10 + V2 10 + S1 10 + S2 10 + S3 10
 *  + G3 60 + G6 40 + G4 60 + G2 15 + G5 540，从 STEPS 现算，不在注释里手抄 ✓）
 *  ⇒ 700s 已容不下"每步都顶到预算"的极端网格 ⇒ 合计会抢在单步前面报红 ✗ ⇒ 取 900s
 *  （= 775 × 1.16，仍让单步先发声 ✓）。这一条与 G5 那一条是**同一个决定的两半**：只调 G5 预算
 *  不动合计，就会把"合计抢声"这个已经修掉过的毛病重新装回来。
 *  2026-10-14（W13 批）：**900s 不动** ✓ —— G5 预算 540→600s 之后，各步预算之和从 **775s** 变成
 *  **835s**（从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 600 = 835s），
 *  仍 ≤ 900s ⇒ "合计不抢在单步前面报红"继续成立 ✓（900 / 835 = **1.078** 倍，余量比上一批的
 *  1.16 薄了，但**这一批只涨了 G5 一步**；真要再涨就按同一条不变量的要求同批抬合计 ✓）。
 *  2026-10-14（R2 期 2 批）：**1100s 不动** ✓ —— G5 预算 700→750s 之后，各步预算之和从 **935s**
 *  变成 **985s**（从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 750 = 985s），
 *  仍 ≤ 1100s ⇒ "合计不抢在单步前面报红"继续成立 ✓（1100 / 985 = **1.117** 倍）。
 *  2026-10-16（热度条改版批）：**900s→1100s**。G5 预算 600→700s（理由见上面 G5 那一段）之后，
 *  各步预算之和变成 **935s**（从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 700 = 935s）
 *  ⇒ 900s 已容不下"每步都顶到预算"的极端网格 ⇒ 合计会抢在单步前面报红 ✗ ⇒ 取 1100s
 *  （= 935 × 1.18，仍让单步先发声 ✓）。与 G5 那一条是**同一个决定的两半** ✓。
 *  ⚠️ 上一批那行手抄的清单里 G6 写成 40（实际 `budgetMs` = 20000 = 20s）—— 所以这一段只给**算式**，
 *  数字一律从 `STEPS` 现算（本文件与 `tests/verify-budget.test.js` 都是这个口径 ✓）。
 *  2026-10-14（保存视图修复批）：**1100s 不动** ✓ —— G5 预算 750→**820s**（同批两次现算：先按全量冒烟
 *  639170ms 定 800s，再按全链真读数 645600ms 定 820s）之后，各步预算之和从 **985s** 变成 **1055s**
 *  （从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 820 = 1055s），
 *  仍 ≤ 1100s ⇒ "合计不抢在单步前面报红"继续成立 ✓（1100 / 1055 = **1.043** 倍）。
 *  2026-10-16（验证成本批 1）：**1100s 不动** ✓ —— G5 预算 820→**830s**（依据本批全链真读数
 *  G5 = 656100ms ⇒ 820000/656100 = 1.2498 < 1.25 ✗ ⇒ 按余量守卫现算到 830s，比值 1.265 ✓）之后，
 *  各步预算之和从 **1055s** 变成 **1065s**（从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15
 *  + G5 830 = 1065s），仍 ≤ 1100s ⇒ "合计不抢在单步前面报红"继续成立 ✓（1100 / 1065 = **1.033** 倍）。
 *  与 G5 那一条是**同一个决定的两半**：预算涨了却没抬合计 ⇒ 合计会先于单步发声、盖掉真正慢的那一步 ✗。
 *  2026-10-16（R7-0 批）：**1100s→1150s**。G5 预算 830→**880s**（新增冒烟域 47 净增 ≈ 13.2s，理由见上面
 *  G5 那一段）之后，各步预算之和从 **1065s** 变成 **1115s**（从 `STEPS` **现算**：
 *  8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 880 = 1115s）⇒ 旧合计 1100s 已**容不下**一步的预算
 *  ⇒ 必须同批抬合计，否则合计会抢在单步前面报红、盖掉真正慢的那一步 ✗（1150 / 1115 = **1.031** 倍）。
 *  2026-10-16（R2 期 3 批）：**1150s→1230s**。G5 预算 880→**960s**（依据本批**全链真读数**
 *  G5=695.5s、合计 754.3s，以及"域内量法投影 741.3s 被证伪"这件事，理由见上面 G5 那一段）
 *  之后，各步预算之和从 **1115s** 变成 **1195s**（从 `STEPS` **现算**：8×10 + G3 60 + G6 20
 *  + G4 60 + G2 15 + G5 960 = 1195s）⇒ 同批抬合计，否则合计会抢在单步前面报红、盖掉真正慢的那一步 ✗
 *  （1230 / 1195 = **1.029** 倍 ⇒ 单步仍先发声 ✓）。
 *  2026-10-16（R2 期 4 批）：**1230s→1290s**。G5 预算 960→**1020s**（依据本批**全链真读数**
 *  G5=816.0s、合计 884.6s；本批新增域 49 的 4 条 + 域 46 菜单多一项，816s 里含同机负载成分 ——
 *  按纪律就高不就低，理由见上面 G5 那一段）之后，各步预算之和从 **1195s** 变成 **1255s**
 *  （从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 1020 = 1255s）
 *  ⇒ 同批抬合计，否则合计会抢在单步前面报红、盖掉真正慢的那一步 ✗
 *  （1290 / 1255 = **1.028** 倍 ⇒ 单步仍先发声 ✓）。
 *  2026-10-16（R2 期 5 批）：**1290s→1430s**。G5 预算 1020→**1140s**（依据本批**全链真读数**
 *  G5=905.482s ⇒ 1020/905.482 = 1.1265 < 1.25 ✗ ⇒ 按 1.25×max 现算到 1140s，理由见上面 G5 那一段）
 *  之后，各步预算之和从 **1255s** 变成 **1375s**（从 `STEPS` **现算**：
 *  8×10 + G3 60 + G6 20 + G4 60 + G2 15 + G5 1140 = 1375s）⇒ 同批抬合计，否则合计会抢在
 *  单步前面报红、盖掉真正慢的那一步 ✗（1430 / 1375 = **1.04** 倍 ⇒ 单步仍先发声 ✓）。
 *  2026-10-19（预算统计量批）：**1770s 不动** ✓ —— G5 预算 1350→**1300s**（统计量换 median，理由见上面 G5 那一段）
 *  之后，各步预算之和从 **1594s** 变成 **1544s**（从 `STEPS` **现算**：8×10 + G3 60 + G6 20 + G4 60 + G2 15
 *  + G5 1300 = 1544s），仍 ≤ 1770s ⇒ "合计不抢在单步前面报红"继续成立 ✓（1770 / 1544 = **1.146** 倍）。
 *  ⚠️ 这一批**第一次出现"预算往下走"**：抬线不是不可逆的 —— 统计量换对之后，多付的那 50s 就该还回去，
 *  但**必须同批给出"降了之后逐窗口回溯历史全绿"的读数**（`.review/20261019-预算统计量/lowered-budget.js`），
 *  否则降预算就是在制造随机红灯 ✗。 */
const TOTAL_BUDGET_MS = 1770000;

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

/**
 * 纯函数：把「实测结果」与「预算」比对，返回超预算项与汇总。
 * 抽成纯函数是为了能单测 —— 计时本身不可单测，但**判定逻辑**可以。
 * @param {Array<{step:number,gate:string,label:string,ms:number,code:number,budgetMs:number,skipped?:boolean}>} results
 * @param {number} totalBudgetMs
 */
function checkBudgets(results, totalBudgetMs) {
  const ran = results.filter((r) => !r.skipped);
  const totalMs = ran.reduce((n, r) => n + r.ms, 0);
  const overStep = ran.filter((r) => r.budgetMs > 0 && r.ms > r.budgetMs);
  const overTotal = totalMs > totalBudgetMs;
  return { totalMs, overStep, overTotal, totalBudgetMs, ranCount: ran.length };
}

/**
 * 打印「超预算」报表（**只打印，不决定退出码** —— 退出码归调用方）。
 *
 * 为什么抽成函数（批 J，2026-10-13）：原先这段**写在"某步失败已 return 之后"** ⇒
 * **失败步骤抢先返回，预算判定整段不执行** ✗（批 G 的两次红就是这个形状：报文里只剩
 * `SMOKE GUARD TIMEOUT — force exit`，没有任何"哪一步、超了多少"的读数）。而"某步失败"
 * 与"某步变慢"常常同源（跑到被守卫掐 / 超时 / 真挂死）⇒ 最需要看读数的那一次，恰恰没有读数。
 * 现在两条路径共用这份报表，**语义不变**：失败仍以失败报文与 exit 1 收口。
 *
 * @param {{overStep:Array,overTotal:boolean,totalMs:number,totalBudgetMs:number,ranCount:number}} chk checkBudgets 的返回
 * @param {{stepsOnly?:boolean, note?:string}} opts stepsOnly ⇒ **合计不作判定**（链没跑完时合计不是真值 ✗）
 * @returns {boolean} 是否打印了超预算内容（调用方据此说一句"没有一步超预算"）
 */
function printOverBudget(chk, opts) {
  const o = opts || {};
  const totalOver = o.stepsOnly ? false : chk.overTotal;
  if (!chk.overStep.length && !totalOver) return false;
  console.error('验证链超出耗时预算（' + chk.overStep.length + ' 步 + ' + (totalOver ? '合计' : '0') + '）：');
  for (const r of chk.overStep) {
    console.error('  [超预算] ' + r.gate + ' ' + r.label + ' 用 ' + fmt(r.ms)
      + '，预算 ' + fmt(r.budgetMs) + '（超 ' + fmt(r.ms - r.budgetMs) + '）');
  }
  if (totalOver) {
    console.error('  [超预算] 合计 ' + fmt(chk.totalMs) + '，预算 ' + fmt(chk.totalBudgetMs)
      + '（超 ' + fmt(chk.totalMs - chk.totalBudgetMs) + '）');
  }
  if (o.note) console.error(o.note);
  return true;
}

function main() {
  const results = [];
  let failed = null;
  let unitTestsFromChain = null; // 第 4 步产出、交给第 6 步（省一次 vitest 重跑）

  console.log('== 验证链（npm run verify）==');
  // 交接面留痕（读）：新接手的 AI 最想知道的一件事是"上一次全链到底绿没绿"
  // —— 零上下文的接手演练实测**答不出来**（没有任何落盘痕迹）。故每次运行都先报上一条。
  const prev = readLastVerify();
  console.log(prev
    ? '上次全链：' + prev.finishedAt.replace('T', ' ').slice(0, 16) + '  '
      + (prev.ok ? '✅ 通过' : '❌ 失败于 ' + (prev.failedGate || '?')) + '（' + fmt(prev.totalMs) + '）'
    : '上次全链：（无记录 —— 这是本机第一次跑，或 `.review/` 被清理过）');
  // 部分验证（--changed）单独一格：**不能**拿它当"上次全链"，但也不能完全不提（免得以为没跑过）
  const prevPartial = readLastVerifyChanged();
  if (prevPartial) {
    console.log('另有上次**部分**验证：' + String(prevPartial.finishedAt).replace('T', ' ').slice(0, 16) + '  '
      + (prevPartial.ok ? '✅ 通过' : '❌ 失败于 ' + (prevPartial.failedGate || '?'))
      + '（' + fmt(prevPartial.totalMs) + '，只跑计划内的步骤 —— **不是全链结论**）');
  }
  // 并发改动检测（只告知，不判红）：本工程**同时会有多个 AI 会话在改**（实测被回退过两次）。
  // 数据层有版本闸门（ADR），文档层没有 —— 这里至少把"最近有谁在动"摆到台面上。
  try {
    const rc = require('./docs-registry-check.js');
    const recent = rc.recentlyChanged(ROOT, rc.RECENT_WINDOW_MIN);
    if (recent.length) {
      console.log('ℹ️ 最近 ' + rc.RECENT_WINDOW_MIN + ' 分钟内有改动的受管文件：' + recent.length
        + ' 个（' + recent.slice(0, 5).join('、') + (recent.length > 5 ? ' 等' : '')
        + '）—— 若有另一个会话在写，跑完请复核自己的改动还在不在。');
    }
  } catch (e) { /* 检测失败不影响验证 */ }

  // ── 部分验证：`--changed`（按 git 改动清单自动选）/ `--for <改动面>`（人显式点名）──────
  // 两档共用**同一份**执行 / 跳过 / 留痕逻辑（下面 for (const s of STEPS) 与收尾只有一处）。
  // 设计要点：**它是提速工具，不是验收工具** —— 所有输出都带"部分验证"横幅，
  // 记录写进另一个格子（不覆盖 last-verify.json），历史标 partial（基线也不认它）。
  const sel = changedPlan.parseForArgs(process.argv);
  let plan = null;
  let planLabel = '';
  if (sel.error) {
    console.error('✗ ' + sel.error);
    process.exitCode = 1;
    return;
  }
  /* 工作区改动清单**只取一次**（≈几十 ms）：`--changed` 用它选步，G5 分层用它判"冒烟底板有没有被改"。
   * 取不到 ⇒ `null`（两边各自的语义：`--changed` 退回全量、分层**强制全量档**）。 */
  const cf = changedFiles();
  /* `--release` / `--g5=fast|full`（G5 分层的显式开关）。**非法值当场红**，不静默落回某一档 ——
   * 一个写错的开关值若被静默当成默认，等于"你以为在全量档里跑，其实没有"。 */
  const selTier = parseTierArgs(process.argv);
  if (selTier.error) {
    console.error('✗ ' + selTier.error);
    process.exitCode = 1;
    return;
  }
  if (sel.mode === 'for') {
    // **门禁自己核对这张表**（域号在 scripts/smoke/ 里真实存在 / 每个域恰好被一个面登记 /
    // 条数现算）——刻意放在**跑任何一步之前**：表坏了就该当场红，而不是先付十几分钟的链再发现。
    const table = changedPlan.surfaceSelfCheck(changedPlan.domainNumbersIn(path.join(ROOT, 'scripts', 'smoke')));
    const st = table.stats;
    console.log('改动面表自检：' + (table.ok ? '✓ 通过' : '✗ 不通过')
      + '（面 ' + st.surfaces + ' 个 · 冒烟域 ' + st.domainsInRepo + ' 个被登记 ' + st.domainClaims + ' 次'
      + ' · 全链 ' + st.stepsInChain + ' 步 · 层次 ' + st.layers + ' 格）');
    if (!table.ok) {
      console.error('✗ 改动面表自检不通过（表与真值分叉 ⇒ 判红；表只有一处实现，改它就对了）：');
      table.errors.forEach((e) => console.error('   · ' + e));
      process.exitCode = 1;
      return;
    }
    let p;
    try {
      p = changedPlan.planForSurface(sel.surface, { domains: sel.domains });
    } catch (e) {
      console.error('✗ ' + ((e && e.message) || e));
      process.exitCode = 1;
      return;
    }
    planLabel = '--for ' + sel.surface + (sel.domains ? ' --domains ' + sel.domains.join(',') : '');
    // `--for all` = 默认档 ⇒ **不进**"部分验证"那套（历史/记录位/输出与不带开关的默认档逐字节相同 ✓）
    plan = p.full ? null : p;
    if (p.full && process.argv.includes('--plan-only')) {
      console.log('计划：全量（`--for all`：一步都不省，与不带开关的默认档相同）');
      console.log('   （--plan-only：只报计划，本次一步都没跑 ✓）');
      return;
    }
    if (plan) {
      console.log('⚠️ == 部分验证（' + planLabel + '）== **这不是全量真值**，发版/交付前请跑 `npm run verify`');
      console.log('   ' + plan.reason);
      for (const l of changedPlan.describePlan(plan)) console.log('   ' + l);
      for (const l of changedPlan.describeNotRun(plan)) console.log('   ' + l);   // ★ 没跑什么也必须说出来
      if (process.argv.includes('--plan-only')) {
        console.log('   （--plan-only：只报计划，本次一步都没跑 ✓）');
        return;
      }
      console.log('');
    }
  } else if (sel.mode === 'changed') {
    const files = cf;
    if (files === null) {
      console.log('⚠️ --changed：取不到 git 改动清单（没有 git / 不在仓库里？）⇒ **退回全量**');
      console.log('');
    } else {
      plan = changedPlan.planForFiles(files);
      planLabel = '--changed';
      console.log('⚠️ == 部分验证（--changed）== **这不是全量真值**，发版/交付前请跑 `npm run verify`');
      console.log('   ' + plan.reason);
      for (const l of changedPlan.describePlan(plan)) console.log('   ' + l);
      for (const l of changedPlan.describeNotRun(plan)) console.log('   ' + l);   // ★ 没跑什么也必须说出来
      console.log('   改动文件 ' + files.length + ' 个：'
        + (files.length > 8 ? files.slice(0, 8).join('、') + ' 等' : files.join('、')));
      /* ★ **批次越界检查**（T1 批，2026-10-17）—— 挂点选在这里，理由三条：
       *   ① **清单已经取到了**（就是上面那份 `files`）⇒ 0 额外 I/O、0 额外耗时
       *      （`architecture-for-ai` H3：不给高频动作加新成本）；
       *   ② 默认全量档（`npm run verify` 不带开关）**一个字节都不多打** ⇒ 高频动作输出不变；
       *   ③ 本工程对"这类检查该不该在链上"已有**两次裁决**：输入是**活的**工作树的检查
       *      **不许成为卡点**（`scripts/pathchain-conformance.js:24-25` 的"它不许成为卡点"、
       *      `scripts/collateral-check.js:24-27` 的"它不看 git status —— 新建/删除一个工作目录就
       *      能让链变色 ✗，本工程真吃过这个假红"）⇒ 挂在 `--changed` 这一档正是它该在的地方。
       *   判据 = 「改动文件里有没有**既不属于本次声明面、也不是运行副产物**的」。
       *   三档（`testing-for-ai` B8，**跳过必须与通过可区分**）：
       *     无 `--claimed` ⇒ **未验证**（响亮说"本次没判"，绝不读成绿）；
       *     `--boundary=report`（默认，依据 = 实测误报率，见 changed-plan.js 的 BOUNDARY_DEFAULT）；
       *     `--boundary=strict` ⇒ **在跑任何一步之前**判红（越界是"这批的边界面不成立"，不是"慢"）。 */
      const boundary = evaluateBoundary(files, sel);
      for (const l of changedPlan.describeBoundary(boundary)) console.log('   ' + l);
      if (boundary.status === 'violation' && sel.boundaryMode === 'strict') {
        console.error('');
        console.error('✗ 批次越界（`--boundary=strict`）：声明面 [' + sel.claimed.join(', ') + '] 之外'
          + '还有 ' + boundary.unclaimed.length + ' 个**源码级**改动文件（见上）');
        console.error('  ⇒ 出路二选一：① 它们真属于本批 ⇒ 加进 `--claimed`；'
          + '② 它们在别的批手里 ⇒ 让那个批登记 `.review/claim-<批名>.json`（格式见 changed-plan.js 的 readClaims）');
        console.error('  ⇒ 本档在**任何一步之前**就判红：这不是"慢"，是"这批的边界面不成立"');
        process.exitCode = 1;
        return;
      }
      if (process.argv.includes('--plan-only')) {
        console.log('   （--plan-only：只报计划，本次一步都没跑 ✓）');
        return;
      }
      if (!plan.steps.length) {
        console.log('   ⇒ 计划里没有步骤：**本次没有验证任何东西** ✓（要全量请不传 --changed）');
        return;
      }
      console.log('');
    }
  }
  console.log('');
  /* ── G5 **定档**（在跑任何一步之前；档位的理由必须当场可见）──────────────────────────
   * 三档（`B8`：判定档数必须 ≥ 要区分的状态数）：
   *   `full`   = 全部域 + 视觉断言 + 取景记录（全量真值口径）
   *   `fast`   = 只跑 `core` 域（走既有 `SMOKE_ONLY` ⇒ **不产**截图/取景记录/视觉断言）
   *   `subset` = 人点名的改动面 / 域（`--for` / `--changed` 的 `smokeOnly`）—— 面自己声明的必跑集赢
   *   `skipped`= 本轮计划里没有 G5
   * ⚠️ 快档的"通过"**不是**全量真值 —— 下面必须逐个点名没跑多少（域数 + 断言数）。 */
  const g5Planned = !plan || plan.full === true || plan.steps.indexOf('G5') >= 0;
  let g5RunTier = 'skipped';
  let g5SmokeOnly = null;      // null = 全部域
  let g5TierInfo = null;       // 分层表的现算读数（域数 / 断言数）
  let g5Decision = null;
  if (g5Planned) {
    g5Decision = decideG5Tier({
      explicit: selTier.explicit, release: selTier.release,
      now: Date.now(), lastFull: readLastFullG5(), changedFiles: cf
    });
    const narrow = (plan && plan.smokeOnly && plan.smokeOnly.length) ? plan.smokeOnly : null;
    try { g5TierInfo = require('./smoke-assertions.js').tierSummary(); }
    catch (e) { g5TierInfo = { ok: false, error: String((e && e.message) || e) }; }
    if (narrow) {
      g5RunTier = 'subset';
      g5SmokeOnly = narrow;
    } else if (g5Decision.tier === 'fast') {
      if (g5TierInfo && g5TierInfo.ok && g5TierInfo.core && g5TierInfo.core.only.length) {
        g5RunTier = 'fast';
        g5SmokeOnly = g5TierInfo.core.only;
      } else {
        // 采不到 core 档清单 ⇒ **退回全量**（更多的覆盖总是更安全）+ 响亮说明（A5：采不到真值不能静默）
        g5RunTier = 'full';
        console.log('⚠️ G5 分层：本应跑 fast 档，但**采不到 core 域清单**（'
          + ((g5TierInfo && g5TierInfo.error) || 'scripts/smoke-assertions.js 的 tierSummary() 不可用')
          + '）⇒ **本轮退回全量档**（更多的覆盖总是更安全 ✓）');
      }
    } else {
      g5RunTier = 'full';
    }
    // ── 打印：这一档为什么是这一档 + 没跑什么（跳过必须与通过可区分）──
    console.log('== G5 分层：本轮 **' + g5RunTier + ' 档** ==');
    if (g5Decision.hits.length) {
      for (const h of g5Decision.hits) console.log('   · [' + h.code + '] ' + h.why);
    } else {
      console.log('   · 没有任何一条"必须全量"的条件成立（距上次成功全量档 '
        + (() => { const lf = readLastFullG5(); return lf && lf.at ? fmtHours(Date.now() - Date.parse(lf.at)) : '?'; })()
        + '，阈值 ' + fmtHours(G5_FULL_EVERY_MS) + '；改动清单取到了且没碰冒烟底板）');
    }
    if (g5Decision.overrode && g5Decision.overrode.length) {
      console.log('   ⚠️ 你显式要求了 fast 档（`--g5=fast`）⇒ **下面这条周期条件被覆盖了**：'
        + g5Decision.overrode.map((h) => h.why).join('；') + '（放行点/交付前请用 `--release`）');
    }
    if (g5RunTier === 'fast' && g5TierInfo && g5TierInfo.ok) {
      const deepN = g5TierInfo.deep.domains;
      const deepA = g5TierInfo.deep.assertions;
      const allA = g5TierInfo.all.assertions;
      console.log('   core 档：' + g5TierInfo.core.domains + ' 个域 / ' + g5TierInfo.core.assertions + ' 条断言（本轮会跑）');
      console.log('   ⚠️ **deep 档 ' + deepN + ' 个域 / ' + deepA + ' 条断言（占断言总数 '
        + (allA ? Math.round((deepA / allA) * 1000) / 10 : '?') + '%）本轮没跑**，且快档**不产**'
        + '截图 / 取景记录 / 视觉断言 —— 所以本轮"验证通过"**不是全量真值** ✗');
      console.log('   ⇒ 它们会在这些条件下跑（可判定的，见 `scripts/verify.js` 的 `decideG5Tier`）：'
        + '距上次成功全量档 ≥ 24h · 上次全量档是红的 · 冒烟底板/域文件被改 · 放行点 `--release` · `--g5=full`');
      console.log('   ⇒ 最近一次真跑了全量档：' + (() => {
        const lf = readLastFullG5();
        return lf ? (String(lf.at || '?').replace('T', ' ').slice(0, 19) + (lf.ok ? '（绿）' : '（红 ✗）'))
          : '（历史里没有 —— 这本身就是该跑全量的理由，下一轮会自动升档）';
      })());
    } else if (g5RunTier === 'subset') {
      console.log('   （走改动面/域的收窄集：' + g5SmokeOnly.join(', ') + ' —— 面自己声明的必跑集优先于分层）');
    }
    console.log('');
  }

  for (const s of STEPS) {
    // 计划外 ⇒ 跳过（G7 是"与 G6 共用一次调用"，G6 在计划里它就跟着跑 ✓）
    const inPlan = !plan || plan.full || plan.steps.indexOf(s.gate) >= 0
      || (s.gate === 'G7' && plan.steps.indexOf('G6') >= 0);    if (!inPlan) {
      results.push({ step: s.step, gate: s.gate, label: s.label, ms: 0, code: null,
        budgetMs: 0, skipped: true, skippedBy: 'changed' });
      continue;
    }
    if (!s.cmd) { // G7 与 G6 共用一次调用
      results.push({ step: s.step, gate: s.gate, label: s.label, ms: 0, code: null,
        budgetMs: 0, skipped: true });
      continue;
    }
    // 会产出「用例数」的步骤：先删掉上一次的结果文件。
    // 这一步是**交接可信的全部依据** —— 删过之后还读得到，就只可能是本次跑出来的。
    const resFile = s.resultsFile ? path.join(ROOT, s.resultsFile) : null;
    if (resFile) {
      fs.mkdirSync(path.dirname(resFile), { recursive: true });
      try { fs.unlinkSync(resFile); } catch (e) { /* 不存在即正常 */ }
    }

    console.log('── 步骤 ' + s.step + '／' + s.gate + '：' + s.label + ' —— ' + s.shown);
    const t0 = Date.now();
    const opts = { shell: true, stdio: 'inherit', cwd: ROOT }; // stdio: 'inherit' —— 不用管道，见文件头①
    if (s.useUnitTests && unitTestsFromChain !== null) {
      opts.env = Object.assign({}, process.env,
        { AI_MINDMAP_UNIT_TESTS: String(unitTestsFromChain) });
    }
    /* 冒烟收窄：走既有的 SMOKE_ONLY（选择器会"筛错名字响亮失败"，并自标"过滤运行不是全量真值" ✓）。
     * 两个来源，优先级见上面的定档块：① 改动面/域点名的 `plan.smokeOnly`（面自己声明的必跑集）；
     * ② 分层 fast 档的 `core` 域清单。两者都没有 ⇒ 不设 SMOKE_ONLY ⇒ 全量档。 */
    if (s.gate === 'G5' && g5SmokeOnly && g5SmokeOnly.length) {
      opts.env = Object.assign({}, opts.env || process.env, { SMOKE_ONLY: g5SmokeOnly.join(',') });
    }
    const r = spawnSync(s.cmd, opts);
    const ms = Date.now() - t0;
    const code = r.status === null ? 1 : r.status;
    // G5 的预算**按档取**：快档有独立的止涨线（`G5_FAST_BUDGET_MS`），全量档沿用 STEPS 里那条线。
    // ⚠️ 两条线都不许为了"过"而抬 —— 抬线要按 `tests/verify-budget.test.js` 的口径说明理由。
    const effBudget = (s.gate === 'G5' && g5RunTier === 'fast') ? G5_FAST_BUDGET_MS : s.budgetMs;
    const row = { step: s.step, gate: s.gate, label: s.label, ms, code, budgetMs: effBudget };
    if (s.gate === 'G5') { row.tier = g5RunTier; if (g5SmokeOnly) row.smokeOnly = g5SmokeOnly.slice(); }
    results.push(row);

    if (resFile) {
      unitTestsFromChain = readUnitTests(resFile);
      console.log(unitTestsFromChain === null
        ? '   （未能读到用例数 —— 第 6 步会自己再跑一次 vitest，属可接受的降级）'
        : '   （用例数 ' + unitTestsFromChain + '，已交给步骤 5（G6），省去重跑一次 vitest）');
    }
    console.log('');
    if (code !== 0) { failed = { step: s, code }; break; } // 与原 `&&` 链一致：首败即停
  }

  const chk = checkBudgets(results, TOTAL_BUDGET_MS);

  /* ---- 表与实跑分叉 ⇒ 判红（**运行时核对**）----
   * 为什么非有不可：`--for` 的全部风险就是"表说跑 A、实跑却跑了 B（或漏了 A）"，
   * 而那种失效的形状是**看起来验证过了**（本工程最重的损害类别）⇒ 表与实跑必须当场对账。
   * 边界（如实写明）：链**没跑完**（首败即停）时这一步不做判定 —— 那次的读数本来就不完整，
   * 真红是上面那条失败；这里只**响亮说没核对**（不许静默跳过 ✗）。 */
  let divergence = null;
  if (plan) {
    if (failed) {
      console.log('（表与实跑分叉的核对**本轮跳过**：链没跑完 ⇒ 读数不完整，本次以那条失败收口 ✓）');
      console.log('');
    } else {
      divergence = changedPlan.planDivergence(plan,
        results.map((r) => ({ gate: r.gate, skipped: r.skipped === true, code: r.code })));
      console.log('表与实跑对账（' + planLabel + '）：' + (divergence.ok ? '✓ 一致（计划内 ' + divergence.ranGates.length
        + ' 个门禁真的跑了，计划外一个都没跑）' : '✗ **分叉**'));
      if (!divergence.ok) divergence.errors.forEach((e) => console.error('   · ' + e));
      console.log('');
    }
  }

  // ---- 耗时表（每次都打印：时间花在哪 + 比上次差多少，一眼可见）----
  // 基线要在**写本次记录之前**读（下面 writeVerifyHistory 才追加）✓
  // 且只认"最后一次**成功**的验证"：失败/中断的那次步骤没跑完，拿来比是假信号 ✗（实测踩过）
  const prevRun = readHistoryBaseline();
  const delta = historyDelta(prevRun, results, chk.totalMs);
  console.log('== 耗时 ==' + (delta
    ? '（对比对象：' + (prevRun.at ? String(prevRun.at).replace('T', ' ').slice(0, 19) : '上一次成功验证')
      + '；若它不是紧邻的那次，说明中间有失败/中断的验证 ✓）'
    : '（无可比历史：历史里还没有一次成功的验证 ✓）'));
  console.log('  步  门禁   耗时      预算      余量      上次      差        步骤');
  for (const r of results) {
    const pad = (v, n) => String(v).padEnd(n);
    if (r.skipped) {
      const why = r.skippedBy === 'changed'
        ? '（' + (planLabel || '--changed') + ' 计划外：跳过）' : '（与上一步同一次调用）';
      console.log('  ' + pad(r.step, 3) + pad(r.gate, 6)
        + pad(why, 10) + ' '.repeat(8) + ' '.repeat(10) + pad('—', 10) + pad('—', 10) + r.label);
      continue;
    }
    const over = r.budgetMs > 0 && r.ms > r.budgetMs;
    const d = delta && delta.byGate[r.gate];
    console.log('  ' + pad(r.step, 3) + pad(r.gate, 6)
      + pad(fmt(r.ms), 9) + pad(fmt(r.budgetMs), 9)
      + pad(over ? '⚠ 超出' : fmt(r.budgetMs - r.ms), 9)
      + pad(d ? fmt(d.ms) : '—', 10)
      + pad(d ? (d.deltaMs === null ? '（档不同）' : fmtDelta(d.deltaMs)) : '—', 12)
      + r.label + (r.tier ? '  ［' + r.tier + ' 档' + (r.smokeOnly ? '：' + r.smokeOnly.length + ' 个域' : '') + '］' : '')
      + (r.code === 0 ? '' : '  ← exit ' + r.code));
  }
  console.log('  ' + '合计'.padEnd(9) + fmt(chk.totalMs).padEnd(9) + fmt(chk.totalBudgetMs).padEnd(9)
    + (chk.overTotal ? '⚠ 超出' : fmt(chk.totalBudgetMs - chk.totalMs)).padEnd(10)
    + (delta && delta.total ? fmt(delta.total.ms) : '—').padEnd(10)
    + (delta && delta.total ? fmtDelta(delta.total.deltaMs) : '—'));
  // 只提示不判红：耗时受负载影响（同一份代码实测能差 20%+），判红交给预算 ✓
  if (delta && delta.total && delta.total.deltaMs > 0 && delta.total.ms > 0
    && delta.total.deltaMs / delta.total.ms > 0.15) {
    console.log('  ⚠ 比上次慢了 ' + fmtDelta(delta.total.deltaMs) + '（超过上次的 15%）—— 看上面是哪一步涨的；'
      + '急涨先怀疑负载，稳涨要查根因 ✗');
  }
  console.log('');

  const partial = !!(plan && !plan.full);
  if (failed) {
    console.error((partial ? '部分验证失败（' + (planLabel || '--changed') + '）' : '验证失败')
      + '：步骤 ' + failed.step.step + '（' + failed.step.gate + '）退出码 ' + failed.code);
    /* 批 J 的账（批 G 实测）：这里原先紧接着就走记录与 return ⇒ **失败步骤抢先返回，预算判定
     * 整段不执行** ✗ —— 而"失败"与"变慢"常常同源（跑到被守卫掐 / 超时 / 真挂死），
     * 最需要看读数的那一次反而只有一句"退出码 1"。现在**失败也把预算读数打出来**；
     * 判定权仍归失败这一边，且合计**不作判定**（链没跑完 ⇒ 合计不是真值 ✓）。 */
    if (!printOverBudget(chk, {
      stepsOnly: true,
      note: '（以上是**读数**：本次以失败收口 ⇒ 预算不参与本次判定；链没跑完，合计也不作判定 ✓）'
    })) {
      console.log('预算读数：已跑的 ' + chk.ranCount + ' 步都没超过各自预算'
        + '（失败与"变慢"不同源 —— 先按上面的失败报文查原因 ✓）');
    }
    const run = {
      finishedAt: new Date().toISOString(), ok: false, failedGate: failed.step.gate,
      totalMs: chk.totalMs, version: pkgVersion(), partial, g5Tier: g5RunTier,
      steps: results.map((r) => ({ gate: r.gate, ms: r.ms, code: r.code }))
    };
    // 部分验证写**另一个**格子：`last-verify.json` 回答的是"上次**全链**绿没绿"，
    // 被一条只跑了几步的记录覆盖就变成假事实 ✗（这是本工程最重的损害类别：静默）
    if (partial) writeLastVerifyChanged(run); else writeLastVerify(run);
    writeVerifyHistory(run, results);   // 历史：追加一条（可疑的偶发 / 变慢，事后靠它判）
    backupHint();
    process.exitCode = 1;
    return;
  }

  // ---- 分叉判定（**先于预算**：结论本身不成立时，"太慢"不是要报的那件事）----
  if (divergence && !divergence.ok) {
    console.error('✗ 改动面表与实跑分叉 ⇒ 判红（' + planLabel + '）：每一步都绿，但"计划 = 实跑"不成立 ⇒');
    console.error('   这个"绿"不能当"这一面验过了"读 ✗（表只有一处实现：scripts/changed-plan.js 的 SURFACES）');
    process.exitCode = 1;
    return;
  }

  // ---- 预算判定 ----
  // 报表抽在 printOverBudget()（**只打印**），因为失败路径也要用它 —— 见那个函数上方的账 ✓
  if (printOverBudget(chk, {})) {
    console.error('');
    console.error('这不一定是错：预算的作用是**防止耗时悄悄涨回去**（本链曾从 176 s 压到 77 s）。');
    console.error('若这次增长是合理的（新增了断言/功能/步骤），请改 scripts/verify.js 的');
    console.error('STEPS 预算或 TOTAL_BUDGET_MS **并说明理由**；否则先查清为什么变慢。');
    process.exitCode = 1;
    return;
  }

  console.log((partial ? '部分验证通过' : '验证通过') + '（' + (partial ? '计划内 ' : '') + chk.ranCount + ' 步 / ' + fmt(chk.totalMs)
    + '，预算内）' + (partial ? ' —— **不是全量真值**；发版/交付前请跑 `npm run verify`' : '')
    /* ⚠️ 快档的"通过"必须当场降调：不写这一句，读者会把"core 域绿了"读成"全部域绿了"
     * （本工程最重的损害类别：没做，却看不出没做）。 */
    + (g5RunTier === 'fast'
      ? '\n⚠️ 但 G5 本轮是 **fast 档**（只跑 core 域，deep 域 + 视觉断言 + 取景记录都没跑）'
        + ' ⇒ 这次"通过"**不是全量真值**；放行点/交付前请 `npm run verify -- --release`'
      : ''));
  const run = {
    finishedAt: new Date().toISOString(), ok: true, failedGate: null,
    totalMs: chk.totalMs, version: pkgVersion(), partial, g5Tier: g5RunTier,
    steps: results.map((r) => ({ gate: r.gate, ms: r.ms, code: r.code }))
  };
  if (partial) writeLastVerifyChanged(run); else writeLastVerify(run);
  writeVerifyHistory(run, results);   // 历史：追加一条（可疑的偶发 / 变慢，事后靠它判）
  backupHint();
}

/** 当前发布版本（`.review/last-verify.json` 里带上它，接手者一眼知道这份记录对应哪版） */
function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { return null; }
}

/**
 * 兜底备份提示的**文本**（纯函数，便于单测）。
 *
 * 这段文案的要害是：**两个兜底互相替代不了**。写成"有 Git 了 ⇒ 不用备份"是危险的
 * （`.git` 与工程同盘，盘/目录丢了就一起没），写成"没备份 ⇒ 一切都完了"又忽略了
 * 本地提交已经把"改错能回去"解决了。所以两条信息**永远一起说**。
 *
 * @param {{days:number}|null} b 工程外备份的新鲜度（null = 没找到）
 * @param {number|null} n 本地提交数（null = 取不到，如没装 git / 不是仓库）
 */
function backupHintText(b, n) {
  const where = BACKUP_DIRS.join(' 或 ');
  const local = n === null ? '本地 Git 状态取不到（没装 git / 不是仓库）'
    : n > 0 ? '本地 Git 已有 ' + n + ' 条提交（**已提交**的内容可回滚）'
      : '本地 Git **零提交**（改错了回不去）';
  if (!b) {
    return 'ℹ️ 兜底备份：**未找到工程外备份**（查找 ' + where + '）｜' + local
      + '。⚠️ 本地提交**救不了**盘/目录丢失（`.git` 与工程同盘）—— 大改前建议 '
      + '`git bundle create <工程外路径> --all`（带完整历史）或 `node cli/mm-cli.js export-json`（只带当前数据）。';
  }
  if (b.days > 7) {
    return 'ℹ️ 兜底备份：最新一份在 ' + b.days + ' 天前（' + where + '）｜' + local
      + '—— 距上次备份已久，大改前建议再备一份。';
  }
  return 'ℹ️ 兜底备份：最新一份在 ' + (b.days === 0 ? '今天' : b.days + ' 天前') + '（' + where + '）｜' + local + '。';
}

/** 打印兜底备份新鲜度（只提示，不影响退出码） */
function backupHint() {
  console.log(backupHintText(checkBackupFreshness(), gitCommitCount()));
}

module.exports = {
  STEPS, TOTAL_BUDGET_MS, TEST_RESULTS, checkBudgets, readUnitTests,
  LAST_VERIFY, readLastVerify, checkBackupFreshness, BACKUP_DIRS,
  // G5 分层（2026-10-18）：档位判定是**纯函数**（可单测、可注入做判别力证明）+ 两条线 + 底板正则
  G5_TIERS, G5_FULL_EVERY_MS, G5_FAST_BUDGET_MS, G5_DEEP_FLOOR_RE,
  parseTierArgs, decideG5Tier, readLastFullG5, fmtHours,
  // 验证历史（追加入口 + 组记录那一半是纯函数，便于单测）
  VERIFY_HISTORY, buildVerifyHistory, writeVerifyHistory,
  // 度量列：与上一次**成功**的验证比较（纯函数 + 一个读取口，便于单测）
  pickHistoryBaseline, readHistoryBaseline, historyDelta, fmtDelta,
  // `--changed`：取改动清单、部分验证的独立记录位
  changedFiles, writeLastVerifyChanged, readLastVerifyChanged, LAST_VERIFY_CHANGED,
  // 兜底提示的两半：取数（I/O）与组文（纯函数）分开，便于单测组文那一半
  gitCommitCount, backupHintText
};

if (require.main === module) main();
