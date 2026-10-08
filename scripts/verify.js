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
 *   ② 预算取实测的 **2–3 倍**，是**止涨线**而不是性能目标。刻意留足余量：CI 与本机负载
 *      差异很大，紧贴实测值会变成随机红灯，而随机红灯的下场是被人无视或直接删掉。
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

const ROOT = path.resolve(__dirname, '..');

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
 * 或普通文本工具就能读，不需要任何依赖（工程零运行时依赖）。
 * 为什么带 node / host / freeMemMB：这三点是"同一份代码、结果不同"时最先要排除的变量
 * （node 版本差异、换机器、当时内存压力）。
 * 为什么写失败不能影响结论：它只是**旁证**（与 `last-verify.json` 同一性质）。为了一条日志把一次
 * 真实验证判成失败，属于"辅助设施反过来打断主流程"，得不偿失 ⇒ 只打印一行警告。
 * 落在 `.review/`（工程既定的**唯一杂物区**：可随时整目录删除、已 gitignore、不进 G6 数字扫描）。 */
const VERIFY_HISTORY = '.review/verify-history.jsonl';

/** 一条历史记录（除 `envIn` 外都是纯计算：便于单测"字段映射"那一半） */
function buildVerifyHistory(run, results, envIn) {
  const env = envIn || { node: process.version, host: os.hostname(), freeMemMB: Math.round(os.freemem() / 1048576) };
  return {
    at: run.finishedAt,                       // ISO 时间（与 last-verify.json 同一个时刻，便于两份记录对齐）
    ok: run.ok,
    failedGate: run.failedGate === undefined ? null : run.failedGate,
    totalMs: run.totalMs,
    // 每步：门禁 / 耗时 / 退出码 / 是否超预算。另外带上 skipped（G7 与 G6 共用一次调用时 ms=0）——
    // 免得事后看历史时把"这一步没单独跑"误读成"耗时 0 秒、很健康"。
    steps: results.map((r) => ({
      gate: r.gate,
      ms: r.ms,
      code: r.code,
      overBudget: r.budgetMs > 0 && r.ms > r.budgetMs,
      skipped: r.skipped === true
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
    covers: '文件编码完整性：UTF-8 BOM / U+FFFD / 经典乱码特征',
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
    step: 4, gate: 'G3', label: '单元测试',
    // 与 `npm test` 等价，**外加** JSON reporter：把用例数交给第 6 步（doc-facts），
    // 于是整条链只需要跑**一次** vitest（以前 doc-facts 会再跑一次：慢约 5 s，
    // 而且正是那一次在负载高时偶发取不到真值、把 G6 判红）。
    // `--reporter=default` 保留人看的输出，故这一步的观感与 `npm test` 一致。
    cmd: 'node node_modules/vitest/vitest.mjs run --pool=threads --reporter=default '
      + '--reporter=json --outputFile=' + TEST_RESULTS,
    shown: '`npm test`（附加 JSON reporter 把用例数交给 G6，省一次 vitest 重跑）',
    covers: '共享核心 `src/` 各模块（含 data-store 原子写、BOM 容错与并发版本闸门）',
    budgetMs: 60000,
    resultsFile: TEST_RESULTS
  },
  {
    step: 5, gate: 'G6', label: '文档数字与版本一致',
    cmd: 'node scripts/doc-facts.js --check', shown: '`node scripts/doc-facts.js --check`',
    covers: '文档数字与真值一致、版本号四处一致',
    // 20 s：正常情况（采用链上用例数）约 0.7 s；**交接失效退化为自跑 vitest 时约 9.2 s**
    // 仍容得下，但更严重的退化会被抓住。
    budgetMs: 20000,
    useUnitTests: true // 由第 4 步传入用例数，省掉这里的 vitest 重跑
  },
  {
    step: 6, gate: 'G7', label: '生成物未过期',
    cmd: null, shown: '同上（重算比对）',
    covers: '生成物是否过期（`docs/CLI.md` 与 registry 一致）',
    budgetMs: 0 // 与 G6 同一次调用，单独不占预算
  },
  {
    step: 7, gate: 'G4', label: 'CLI 集成断言',
    cmd: 'node scripts/cli-integration.js', shown: '`node scripts/cli-integration.js`',
    covers: '全部 CLI 命令端到端（**进程内调用**，临时项目，自动清理）',
    budgetMs: 30000
  },
  {
    step: 8, gate: 'G2', label: '数据校验',
    cmd: 'node cli/mm-cli.js validate-all', shown: '`node cli/mm-cli.js validate-all`',
    covers: '全部项目结构 + 悬挂链接 + 环',
    budgetMs: 15000
  },
  {
    step: 9, gate: 'G5', label: '冒烟（Electron 无头）',
    cmd: 'npm run smoke', shown: '`npm run smoke`',
    covers: '渲染层（Electron 无头，含监听器泄漏回归）+ **真实数据隔离**',
    // 预算调整史（每次都带实测依据 ✓）：
    //   · 2026-09-29：22-* / 23-* 要**真建原生侧栏 view**，实测 130.7s ⇒ 120s 不成立 ⇒ 150s。
    //   · 2026-09-30：查明那三条断言的耗时大头是**顺手孵化了一个真的内置 DSH 服务**
    //     （40–60s，且随负载抖到 172.7s ⇒ 同代码 94.9s 绿 / 172.7s 被守卫掐红 ✗）；
    //     冒烟模式改 `setNoSpawn(true)`（不孵化、也不接管用户的服务 ✓）后只要 11.5s ✓
    //     ⇒ 预算收回 150s（仍是实测的 2 倍余量）。
    budgetMs: 150000
  }
];

/** 整链预算（止涨线）。2026-09-30 实测 ~100–120 s。
 *  关键修复记录：侧栏那三条断言（22-、23-、24-）原先会顺手**孵化一个真的内置 DSH 服务**
 *  （40–60 s，且随机器负载抖到 172.7 s ⇒ 同一份代码 94.9 s 绿 / 172.7 s 被守卫掐红 ✗）；
 *  冒烟模式改成 `setNoSpawn(true)`（既不孵化也不接管用户的服务 ✓）后，它们只要 11.5 s ✓。
 *  取 180 s：留足余量但不再把负载抖动算成回归。 */
const TOTAL_BUDGET_MS = 180000;

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
  console.log('');
  for (const s of STEPS) {
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
    const r = spawnSync(s.cmd, opts);
    const ms = Date.now() - t0;
    const code = r.status === null ? 1 : r.status;
    results.push({ step: s.step, gate: s.gate, label: s.label, ms, code, budgetMs: s.budgetMs });

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

  // ---- 耗时表（每次都打印：时间花在哪，一眼可见）----
  console.log('== 耗时 ==');
  console.log('  步  门禁   耗时      预算      余量      步骤');
  for (const r of results) {
    if (r.skipped) {
      console.log('  ' + String(r.step).padEnd(3) + r.gate.padEnd(6)
        + '（与上一步同一次调用）'.padEnd(10) + ' '.repeat(8) + ' '.repeat(10) + r.label);
      continue;
    }
    const over = r.budgetMs > 0 && r.ms > r.budgetMs;
    const pad = (v, n) => String(v).padEnd(n);
    console.log('  ' + pad(r.step, 3) + pad(r.gate, 6)
      + pad(fmt(r.ms), 9) + pad(fmt(r.budgetMs), 9)
      + pad(over ? '⚠ 超出' : fmt(r.budgetMs - r.ms), 9)
      + r.label + (r.code === 0 ? '' : '  ← exit ' + r.code));
  }
  console.log('  ' + '合计'.padEnd(9) + fmt(chk.totalMs).padEnd(9) + fmt(chk.totalBudgetMs).padEnd(9)
    + (chk.overTotal ? '⚠ 超出' : fmt(chk.totalBudgetMs - chk.totalMs)));
  console.log('');

  if (failed) {
    console.error('验证失败：步骤 ' + failed.step.step + '（' + failed.step.gate + '）退出码 ' + failed.code);
    const run = {
      finishedAt: new Date().toISOString(), ok: false, failedGate: failed.step.gate,
      totalMs: chk.totalMs, version: pkgVersion(),
      steps: results.map((r) => ({ gate: r.gate, ms: r.ms, code: r.code }))
    };
    writeLastVerify(run);      // 交接面：只剩一条（供下一次运行开头报"上次全链"）
    writeVerifyHistory(run, results);   // 历史：追加一条（可疑的偶发 / 变慢，事后靠它判）
    backupHint();
    process.exitCode = 1;
    return;
  }

  // ---- 预算判定 ----
  if (chk.overStep.length || chk.overTotal) {
    console.error('验证链超出耗时预算（' + chk.overStep.length + ' 步 + '
      + (chk.overTotal ? '合计' : '0') + '）：');
    for (const r of chk.overStep) {
      console.error('  [超预算] ' + r.gate + ' ' + r.label + ' 用 ' + fmt(r.ms)
        + '，预算 ' + fmt(r.budgetMs) + '（超 ' + fmt(r.ms - r.budgetMs) + '）');
    }
    if (chk.overTotal) {
      console.error('  [超预算] 合计 ' + fmt(chk.totalMs) + '，预算 ' + fmt(chk.totalBudgetMs)
        + '（超 ' + fmt(chk.totalMs - chk.totalBudgetMs) + '）');
    }
    console.error('');
    console.error('这不一定是错：预算的作用是**防止耗时悄悄涨回去**（本链曾从 176 s 压到 77 s）。');
    console.error('若这次增长是合理的（新增了断言/功能/步骤），请改 scripts/verify.js 的');
    console.error('STEPS 预算或 TOTAL_BUDGET_MS **并说明理由**；否则先查清为什么变慢。');
    process.exitCode = 1;
    return;
  }

  console.log('验证通过（' + chk.ranCount + ' 步 / ' + fmt(chk.totalMs)
    + '，预算内）');
  const run = {
    finishedAt: new Date().toISOString(), ok: true, failedGate: null,
    totalMs: chk.totalMs, version: pkgVersion(),
    steps: results.map((r) => ({ gate: r.gate, ms: r.ms, code: r.code }))
  };
  writeLastVerify(run);      // 交接面：只剩一条（供下一次运行开头报"上次全链"）
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
  // 验证历史（追加入口 + 组记录那一半是纯函数，便于单测）
  VERIFY_HISTORY, buildVerifyHistory, writeVerifyHistory,
  // 兜底提示的两半：取数（I/O）与组文（纯函数）分开，便于单测组文那一半
  gitCommitCount, backupHintText
};

if (require.main === module) main();
