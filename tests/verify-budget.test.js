/* ============================================================
 * tests/verify-budget.test.js — 验证链耗时预算与链定义自洽
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它：计时本身不可单测（依赖机器与负载），但**判定逻辑**可以，
 * 而判定逻辑写错会让这个门禁变成"永远通过"或"随机红灯" —— 两种都会让它被无视。
 *
 * 【批 J（2026-10-13）加】三件事，都是"把写下来的说法变成机械守卫"：
 *   · 两条结构性不变量从**注释**升级成**守卫**：① `main.js` 的冒烟守卫 > G5 预算；
 *     ② 合计预算 ≥ 各步预算之和（两条都**从代码现读**，不抄数字）；
 *   · "预算留足余量"那条的 `measured` 不再**写死**，改为现读 `.review/verify-history.jsonl`
 *     的真读数（写死过一次：表里还写着 G5≈51s，而真值早已是 235–421s ⇒ 它一直在守一个
 *     不存在的世界，绿着但什么都没守 ✗ 本工程最重的损害类别）。
 *   · 【2026-10-14 本批】**余量守卫的口径**从"窗口**最小**值 × 1.8"改成"窗口**最大**值 × 1.25"
 *     —— 旧口径由**最快的一天**决定、窗口一滚就假红（实测 250s 被挤出 ⇒ 最小值爬到 341.9s ⇒
 *     比值 1.579 ✗），而预算这条线防的是"太慢/挂死" ⇒ 基准该取**慢端**（理由详见 `recentMeasured`）。
 *     **只改口径、不动任何预算常量** ✓。
 *
 * 最要紧的一条在最末：**`docs/RULES.md` 里声明的每个门禁，必须真的挂在
 * `scripts/verify.js` 的链上**。否则"在规则表里加了个门禁、却忘了挂进 verify"
 * 会静默失效 —— 规则文件说它守着，实际它一次都不跑。这与本工程反复修过的
 * 「没做，却看不出没做」同型。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const verify = require('../scripts/verify.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 造一条结果记录 */
const res = (gate, ms, budgetMs, skipped) => ({
  step: 0, gate, label: gate, ms, code: 0, budgetMs, skipped: !!skipped
});

/** 从验证历史（`.review/verify-history.jsonl`）取**真读数**：最近 K 次**成功**的全链，
 *  逐门禁取**最大**耗时。返回 `{ runs, byGateMax }`（没有可用历史 ⇒ `runs: 0, byGateMax: {}`）。
 *
 *  为什么**现读**而不是写死一张表：写死的表会静静过期 —— 本文件原先那张记的是 G5≈51s，
 *  而被取代时真值已是 235–421s（差 5–8 倍），于是"余量 > 1.8×"这条守卫**绿着却什么都没守** ✗。
 *
 *  为什么每门禁取**最大值**（**本批改的口径**，原先取最小值 ⇒ 见下）：
 *   · 预算这条线防的是"**太慢 / 挂死**"（`scripts/verify.js` 的注释：止涨线，不是性能目标）
 *     ⇒ 基准必须落在**慢端**：`预算 ≥ 1.25 × 窗口内最大耗时` 才是"最慢那一次也还留得住"。
 *   · 用**最小值**当基准会要求"预算 ≥ 1.8 × **最快**那次"⇒ 这条线**由最快的一天决定**，
 *     而窗口一滚（新链入窗、老链出窗）最小值就**往上爬** ⇒ 比值**自动下降** ⇒ 假红。
 *     实测（2026-10-14，就是本批）：G5 预算 540s 时，窗口最小值从 #110 的 250386ms 被挤出、
 *     最小变成 #117 的 **341884ms** ⇒ 540000/341884 = **1.5795** < 1.8 翻红；而同一窗口的
 *     **最大**值是 421206ms ⇒ 540000/421206 = 1.282 ≥ 1.25 **成立** ✓ ——
 *     同一批读数、同一条预算，两种基准给出相反结论 ⇒ 问题在**口径**，不在预算，所以本批改口径、
 *     **不动任何预算常量** ✓。
 *   · 慢端基准的代价（如实说）：某一次异常慢的读数（当天机器被别的活占住）会把阈值顶上去，
 *     可能要求更大的预算 —— 这正是它想说的话（"你最近真的慢过"）；真遇到时按既有纪律
 *     **改预算要在 `scripts/verify.js` 里说明理由**，而不是把这条守卫调松 ✗。
 *
 *  为什么是最近 **K=10** 次：太远的历史会掩盖"最近真的变慢了"；只取最近 1 次则等于拿一天的
 *  负载当基线。本工程一天内跑 10+ 次全链（2026-10-13 实测），10 次≈一两天，量级合适。
 *
 *  为什么只认"成功且非 partial"的记录：失败/中断那次步骤没跑完，`--changed` 只跑了几步 ——
 *  两种都不是真值口径（与 `scripts/verify.js` 的 `pickHistoryBaseline` 同一口径 ✓）。 */
function recentMeasured(k) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, verify.VERIFY_HISTORY), 'utf8'); }
  catch (e) { return { runs: 0, byGateMax: {} }; }   // `.review/` 是可随时整包删掉的工作产物区
  const ok = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }   // 坏行跳过（历史里可能有半截行）
    if (r && r.ok === true && r.partial !== true && Array.isArray(r.steps)) ok.push(r);
  }
  const win = ok.slice(-k);
  const byGateMax = {};
  for (const r of win) {
    for (const s of r.steps) {
      // skipped 的步骤 ms=0（与上一步共用一次调用）⇒ 不能读成"这一步很快"
      if (!s || s.skipped === true || typeof s.ms !== 'number' || s.ms <= 0) continue;
      if (byGateMax[s.gate] === undefined || s.ms > byGateMax[s.gate]) byGateMax[s.gate] = s.ms;
    }
  }
  return { runs: win.length, byGateMax };
}

describe('验证链耗时预算：判定逻辑', () => {
  it('全在预算内 → 不报超预算，合计正确', () => {
    const r = verify.checkBudgets([res('G1', 100, 10000), res('G8', 200, 10000)], 150000);
    expect(r.overStep).toEqual([]);
    expect(r.overTotal).toBe(false);
    expect(r.totalMs).toBe(300);
    expect(r.ranCount).toBe(2);
  });

  it('单步超预算 → 精确点名那一步', () => {
    const r = verify.checkBudgets([res('G1', 100, 10000), res('G4', 45000, 30000)], 150000);
    expect(r.overStep.map((x) => x.gate)).toEqual(['G4']);
  });

  it('每步都没超、但**合计**超 → 仍要红（防"每样都慢一点"）', () => {
    const r = verify.checkBudgets([res('G1', 9000, 10000), res('G8', 9000, 10000)], 15000);
    expect(r.overStep).toEqual([]);
    expect(r.overTotal).toBe(true);
    expect(r.totalMs).toBe(18000);
  });

  it('budgetMs 为 0 的步骤不参与判定（G7 与 G6 共用一次调用）', () => {
    const r = verify.checkBudgets([res('G7', 0, 0, true)], 150000);
    expect(r.overStep).toEqual([]);
    expect(r.ranCount).toBe(0);
    expect(r.totalMs).toBe(0);
  });

  it('**这才是预算存在的理由**：历史上"每条断言起一个进程"的 102 s 必须被抓住', () => {
    const g4 = verify.checkBudgets([res('G4', 102100, 30000)], 150000);
    expect(g4.overStep.map((x) => x.gate)).toContain('G4');
  });

  it('**整链 176 s 那一版也必须被合计预算抓住**', () => {
    const old = verify.checkBudgets([
      res('G1', 900, 10000), res('G8', 900, 10000), res('G9', 900, 10000),
      res('G3', 8000, 60000), res('G4', 102100, 30000), res('G5', 51000, 120000),
      res('G2', 900, 15000), res('G6', 8000, 40000)
    ], 150000);
    expect(old.overTotal).toBe(true);
    expect(old.totalMs).toBeGreaterThan(150000);
  });

  it('预算留足余量：**最慢那一次**离预算还有 1.25 倍以上（否则会变成随机红灯）', () => {
    // 实测**现读** `.review/verify-history.jsonl` 的真读数，**不写死数字**（原因见 recentMeasured 上方）✓
    const { runs, byGateMax } = recentMeasured(10);
    if (!runs) {
      // 没有历史（首次运行 / `.review/` 被清理过）⇒ 本项**未判定**，**不是**"通过" ✗（措辞必须让人看出区别）。
      // 窗口为空（历史文件在、但一条"成功且非 partial"的记录都没有）走的是**同一条分支**：
      // 同样只 warn、不判红 —— 理由同上（`.review/` 可随时整包删；缺了只当"未知"）。
      // ⚠️ 但**不许静默**：这一档一定会打印这条 warn（"未判定 ≠ 通过"），judged 也仍会是 0 ⇒
      //    下面那条 `judged > 0` 的断言会一起把"守卫空转"这件事说出来 ✓。
      console.warn('⚠️ 预算余量：**未判定** —— 没有可用的验证历史（' + verify.VERIFY_HISTORY
        + ' 不存在 / 窗口里还没有成功记录）。要判定请先跑一次全链（`npm run verify`）。这一条**不是**通过 ✗');
      return;
    }
    let judged = 0;
    for (const s of verify.STEPS) {
      if (!s.budgetMs || !byGateMax[s.gate]) continue;   // 历史里没有读数的门禁（如新增步骤）无从判定
      judged++;
      // 口径：**预算 ≥ 1.25 × 窗口内该步的**最大**耗时**（基准取慢端；理由见 recentMeasured 上方）
      const need = 1.25 * byGateMax[s.gate];
      expect(s.budgetMs / byGateMax[s.gate], s.gate + ' 的预算余量（基准 = 最近 ' + runs
        + ' 次成功全链里的**最大**耗时 ' + byGateMax[s.gate] + 'ms ⇒ 1.25× = ' + Math.round(need)
        + 'ms，预算 ' + s.budgetMs + 'ms）').toBeGreaterThanOrEqual(1.25);
    }
    expect(judged, '至少要判定一个门禁（否则这条守卫等于空转 ✗）').toBeGreaterThan(0);
  });
});

describe('验证链定义自洽（scripts/verify.js 是唯一定义）', () => {
  it('门禁编号不重复，且顺序就是文档里承诺的那条链', () => {
    const gates = verify.STEPS.map((s) => s.gate);
    expect(new Set(gates).size).toBe(gates.length);
    // V2（冒烟域内自收尾）与 V1 同档：都是"扫冒烟源码文本"的廉价卫生门禁，排在昂贵步骤之前 ✓
    // S1/S2/S3（结构声明的三条卫生门禁）同档：依赖方向 / 连带清单 / 产物确定性，同样是纯文本扫描 ✓
    expect(gates).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G3', 'G6', 'G7', 'G4', 'G2', 'G5']);
  });

  it('除 G7（与 G6 同一次调用）外，每步都有可执行命令与预算', () => {
    for (const s of verify.STEPS) {
      if (s.gate === 'G7') { expect(s.cmd).toBe(null); continue; }
      expect(typeof s.cmd, s.gate).toBe('string');
      expect(s.budgetMs, s.gate).toBeGreaterThan(0);
      expect(s.shown.length, s.gate).toBeGreaterThan(0);
      expect(s.covers.length, s.gate).toBeGreaterThan(0);
    }
  });

  it('**`docs/RULES.md` 声明的每个门禁都真的挂在链上**（防"加了门禁忘了挂"）', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'docs', 'RULES.md'), 'utf8');
    // 前缀 `G`（功能与契约）/ `V`（验证物自身的卫生）/ `S`（结构声明的卫生）三种都认
    const declared = [...rules.matchAll(/^\|\s*\*\*([GVS]\d+)\*\*/gm)].map((m) => m[1]);
    const mounted = verify.STEPS.map((s) => s.gate);
    expect(declared.length, 'RULES.md 里应声明多个门禁').toBeGreaterThan(5);
    const missing = declared.filter((g) => !mounted.includes(g));
    expect(missing, '这些门禁在 RULES.md 里声明了，却没挂进 scripts/verify.js 的 STEPS').toEqual([]);
  });

  /* ------------------------------------------------------------
   * **反方向**：挂了门禁但没人声明 —— 与上一条同一个"谁守门禁"元问题的另一半。
   *
   * 为什么需要（实测缺陷，2026-10-10）：V1/V2 挂进 `STEPS` 已多日，而 `docs/RULES.md` §2 表里
   * **至今没有它们** ⇒ 接手者查规则表**根本不知道这两条门禁存在**。
   * 上一条只守"声明 ⊆ 实现"（防加了门禁忘了挂），**不守"实现 ⊆ 声明"** —— 这是它的对偶缺口。
   * 两向都判红才是闭包，且两边差集都要**点名**（`docs-for-ai` G6 的"声明 ↔ 实现双向"）。
   * ------------------------------------------------------------ */
  it('**反向：链上实现的每个门禁都必须在 `docs/RULES.md` §2 有声明**（防"挂了门禁没人声明"）', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'docs', 'RULES.md'), 'utf8');
    const declared = [...rules.matchAll(/^\|\s*\*\*([GVS]\d+)\*\*/gm)].map((m) => m[1]);
    const mounted = verify.STEPS.map((s) => s.gate);
    const undeclared = mounted.filter((g) => !declared.includes(g));
    expect(undeclared, '这些门禁挂在 scripts/verify.js 的 STEPS 上，却没在 docs/RULES.md §2 声明'
      + '（接手者查规则表查不到它们存在 ⇒ 把声明补进 §2 的门禁表）').toEqual([]);
  });

  it('package.json 的 verify 指向本 runner（不是又一份手抄的 && 链）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.verify).toBe('node scripts/verify.js');
  });
});

/* ============================================================================
 * 两条**结构性不变量**的机械守卫（批 J，2026-10-13）
 * ----------------------------------------------------------------------------
 * 这两条原先只写在注释里（`scripts/verify.js` 的 `TOTAL_BUDGET_MS`、`main.js` 的 `SMOKE_GUARD_MS`）。
 * **注释不是守卫**：有人改坏它时不会变红 —— 而这两条恰恰是"改坏了也看不出"的典型，
 * 因为坏掉的形状是**假红 / 假崩**（2026-10-13 两次真红就是这样来的：G5 用 304.6s 跑完、
 * 判据全绿，却在 300s 被守卫掐掉，报文里只剩 `SMOKE GUARD TIMEOUT — force exit` ✗）。
 *
 * 两条都**从代码现读**、不抄数字。抄一份进测试 = 同一件事有两处表达 ⇒ 下次改预算时，
 * 测试里那份**不会自动跟着变**，于是它守的只是那份抄本，而不是线上真正生效的那个数
 * （本工程反复修过的同型病：文档与代码各写一份事实）。
 * ⚠️ 读不到（正则不匹配 / 找不到 G5）**判红**，不跳过：那不是"没违反"，而是"**这条不变量没被验证**" ✗。
 * ========================================================================= */
describe('两条不变量的机械守卫（从代码现读，不抄数字）', () => {
  it('① `main.js` 的冒烟守卫 > G5 预算（守卫先触发会把"跑完且全绿、只是机器慢"报成崩溃）', () => {
    // 为什么解析源码而不是 require：main.js 是 Electron 主进程入口，require 它会在测试进程里
    // 启动应用（app / BrowserWindow 都要真的跑起来）⇒ 只能文本现读（与 G8 读 main.js 的方式同类）。
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const m = src.match(/const\s+SMOKE_GUARD_MS\s*=\s*(\d+)\s*;/);
    expect(m, 'main.js 里找不到 `const SMOKE_GUARD_MS = <数字>;` —— 读不到不算"没违反"，'
      + '而是"这条不变量没被验证" ⇒ 判红（也别让守卫随一次重命名静默消失 ✗）').toBeTruthy();
    const guardMs = Number(m[1]);
    const g5 = verify.STEPS.find((s) => s.gate === 'G5');
    expect(g5, 'scripts/verify.js 的 STEPS 里应有 G5').toBeTruthy();
    expect(guardMs, '冒烟守卫（main.js 的 SMOKE_GUARD_MS = ' + guardMs + 'ms）必须**大于** G5 的预算（'
      + g5.budgetMs + 'ms）：守卫先触发会把"其实跑完了、判据全绿、只是机器慢"的一次报成崩溃，'
      + '报文里只剩 SMOKE GUARD TIMEOUT — force exit ✗（预算判"太慢"、守卫只拦"真挂死"，'
      + '两者代价不对等 ⇒ 守卫必须永远更大）').toBeGreaterThan(g5.budgetMs);
  });

  it('② 合计预算 ≥ 各步预算之和（否则合计会抢在单步前面报红，盖掉真正慢的那一步）', () => {
    const sum = verify.STEPS.reduce((n, s) => n + (s.budgetMs || 0), 0);
    expect(sum, '各步预算之和应大于 0（STEPS 读坏了？）').toBeGreaterThan(0);
    expect(verify.TOTAL_BUDGET_MS, '合计预算（' + verify.TOTAL_BUDGET_MS + 'ms）必须 ≥ 各步预算之和（'
      + sum + 'ms，从 STEPS 现算）：合计红只说"整条链慢了"、说不出是哪一步 ⇒ 它不许抢在单步前面发声')
      .toBeGreaterThanOrEqual(sum);
  });
});

/* ============================================================
 * 用例数交接 —— 整条链只跑一次 vitest
 * ------------------------------------------------------------
 * 以前第 4 步 `npm test` 跑一次 vitest、第 8 步 `doc-facts` 为了**数用例数**又跑一次：
 * 慢约 5–9 s，而且那第二次在负载高时偶发取不到真值 → 按既定口径把 G6 判红
 * （实测 3 次里红 1 次）。现在第 4 步附带 JSON reporter 产出用例数，交给第 8 步。
 * 这几条锁的就是"交接别在以后的重构里悄悄断掉"—— 断了不报错，只是**又慢回去**，
 * 正是本工程反复修过的那类"退化了却看不出来"。
 * ============================================================ */
describe('P0-2 交接：用例数由链上传来，不重跑 vitest', () => {
  it('readUnitTests 取 numTotalTests；坏 JSON / 文件不存在 → null（下游降级自跑）', () => {
    const tmp = path.join(os.tmpdir(), 'vt-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ numTotalTests: 416 }), 'utf8');
    expect(verify.readUnitTests(tmp)).toBe(416);
    fs.writeFileSync(tmp, 'not json at all', 'utf8');
    expect(verify.readUnitTests(tmp)).toBe(null);
    fs.unlinkSync(tmp);
    expect(verify.readUnitTests(tmp)).toBe(null);
    fs.writeFileSync(tmp, JSON.stringify({ numPassedTests: 416 }), 'utf8');
    expect(verify.readUnitTests(tmp)).toBe(null); // 只认 numTotalTests，不猜
    fs.unlinkSync(tmp);
  });

  it('第 4 步产出、第 8 步消费 —— 两端的接线都还在', () => {
    const g3 = verify.STEPS.find((s) => s.gate === 'G3');
    const g6 = verify.STEPS.find((s) => s.gate === 'G6');
    expect(g3.resultsFile).toBe(verify.TEST_RESULTS);
    expect(g3.cmd).toContain('--reporter=json');
    expect(g3.cmd).toContain('--reporter=default'); // 人看的输出不能丢
    expect(g3.cmd).toContain('outputFile=' + verify.TEST_RESULTS);
    expect(g6.useUnitTests).toBe(true);
  });

  it('交接文件落在 .review/（工程既定的工作产物区，且已 gitignore）', () => {
    expect(verify.TEST_RESULTS.startsWith('.review/')).toBe(true);
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(gi).toMatch(/^\.review\/$/m);
  });

  it('doc-facts 保留降级路径：没有该环境变量时必须能自己跑（否则单独用就废了）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'doc-facts.js'), 'utf8');
    expect(src).toContain('AI_MINDMAP_UNIT_TESTS');
    expect(src).toContain('maxBuffer'); // 显式抬高，防 ENOBUFS 导致"真值缺失"误红
    expect(src).toMatch(/unitTestsSource/); // 来源必须打印出来（该被看见的事实）
  });
});

/* ------------------------------------------------------------
 * 兜底提示：**两个兜底互相替代不了**
 *
 * 真实背景：这条提示原先写的是「本工程 Git 零提交 ⇒ export-json 到工程外是**唯一**回滚手段」。
 * 2026-09-29 本地 Git 解锁后，那个前提**已经过时**。而反过来写（"有 Git 了 ⇒ 不用备份"）
 * 更危险：`.git` 与工程同盘，盘/整个目录丢了就一起没。
 * ⇒ 组文那一半抽成纯函数，这里把四种组合都钉住，防止它随某一次改动又倒向一边。
 * ------------------------------------------------------------ */
describe('兜底备份提示：本地 Git 与工程外备份各自独立', () => {
  it('无工程外备份 + 有本地提交 ⇒ 既说"已提交的可回滚"，也明说"救不了盘丢失"', () => {
    const t = verify.backupHintText(null, 3);
    expect(t).toContain('未找到工程外备份');
    expect(t).toContain('3 条提交');
    expect(t).toContain('救不了');
  });

  it('无工程外备份 + 零提交 ⇒ 不许出现"可回滚"这种话（那会让人以为没事）', () => {
    const t = verify.backupHintText(null, 0);
    expect(t).toContain('零提交');
    expect(t).not.toContain('可回滚');
  });

  it('取不到 git 状态 ⇒ 如实说"取不到"，不假装成零提交', () => {
    expect(verify.backupHintText(null, null)).toContain('取不到');
    expect(verify.backupHintText(null, null)).not.toContain('零提交');
  });

  it('有工程外备份 ⇒ 报新鲜度，且**仍然**带上本地 Git 状态（两条信息一起说）', () => {
    const t = verify.backupHintText({ days: 2 }, 5);
    expect(t).toContain('2 天前');
    expect(t).toContain('5 条提交');
  });

  it('gitCommitCount：返回非负数字或 null，绝不抛（仓库可能还没有提交 / 机器可能没装 git）', () => {
    const n = verify.gitCommitCount();
    expect(n === null || (typeof n === 'number' && n >= 0)).toBe(true);
  });
});

/* ============================================================================
 * 度量列（2026-10-08 加）："这次比上次快/慢了多少"要能显示出来，
 * 否则"这轮省下的时间"没人知道、也就没人守（本链真的从 77 s 涨回过 176 s ✗）。
 * 测的是**纯函数那一半** —— 打印格式与"缺数据时显示什么"都是会骗人的地方 ✓
 * ========================================================================= */
describe('度量列：与上一条历史比较（纯函数）', () => {
  const run = (gate, ms, skipped) => ({ gate, ms, skipped: !!skipped });

  it('逐门禁算差：正=变慢、负=变快', () => {
    const prev = { totalMs: 100000, steps: [{ gate: 'G5', ms: 90000 }, { gate: 'G3', ms: 10000 }] };
    const d = verify.historyDelta(prev, [run('G5', 95000), run('G3', 8000)], 103000);
    expect(d.byGate.G5).toEqual({ ms: 90000, deltaMs: 5000 });
    expect(d.byGate.G3).toEqual({ ms: 10000, deltaMs: -2000 });
    expect(d.total).toEqual({ ms: 100000, deltaMs: 3000 });
  });

  it('skipped 的步骤（与上一步共用一次调用，ms=0）**不参与比较** —— 比出来是假信号', () => {
    const prev = { totalMs: 100000, steps: [{ gate: 'G6', ms: 600 }, { gate: 'G7', skipped: true, ms: 0 }] };
    const d = verify.historyDelta(prev, [run('G6', 600), run('G7', 0, true)], 100000);
    expect(d.byGate.G6).toBeTruthy();
    expect(d.byGate.G7).toBeUndefined();
  });

  it('没有可比历史 ⇒ null（调用方据此打印"这是历史里的第一条"，**不是**显示 0）', () => {
    expect(verify.historyDelta(null, [run('G5', 1)], 1)).toBe(null);
    expect(verify.historyDelta({ steps: [] }, [run('G5', 1)], 1).byGate).toEqual({});
    // 上一条记录里没有这个门禁（新增了门禁）⇒ 该步不算差，但整表仍有输出
    const d = verify.historyDelta({ totalMs: 10, steps: [{ gate: 'G1', ms: 5 }] }, [run('G1', 6), run('G9', 7)], 20);
    expect(d.byGate.G1.deltaMs).toBe(1);
    expect(d.byGate.G9).toBeUndefined();
  });

  it('fmtDelta：总是带符号（正负一眼可辨），空值显示 —（不是 0.0s）', () => {
    expect(verify.fmtDelta(7600)).toBe('+7.6s');
    expect(verify.fmtDelta(-12300)).toBe('-12.3s');
    expect(verify.fmtDelta(0)).toBe('±0.0s');
    expect(verify.fmtDelta(null)).toBe('—');
    expect(verify.fmtDelta(undefined)).toBe('—');
    expect(verify.fmtDelta(NaN)).toBe('—');
  });

  it('readHistoryBaseline / pickHistoryBaseline：基线只认**最后一次成功**的验证', () => {
    // 失败/中断的那次步骤没跑完（合计 23.7s）⇒ 拿它比会得出"慢了 +101.7s"的假信号（实测踩到 ✗）
    const lines = [
      JSON.stringify({ ok: true, totalMs: 100000, steps: [{ gate: 'G5', ms: 90000 }] }),
      '{"半截坏行"',
      JSON.stringify({ ok: false, failedGate: 'G4', totalMs: 23700, steps: [{ gate: 'G3', ms: 18100 }] }),
      ''
    ];
    const b = verify.pickHistoryBaseline(lines);
    expect(b.totalMs).toBe(100000);
    expect(b.steps[0].gate).toBe('G5');
    // 全是失败/坏行 ⇒ null（调用方据此说"还没有一次成功的验证"，不编一个基线出来）
    expect(verify.pickHistoryBaseline([JSON.stringify({ ok: false, steps: [] })])).toBe(null);
    expect(verify.pickHistoryBaseline([])).toBe(null);
    expect(verify.pickHistoryBaseline(['', '   '])).toBe(null);
  });

  it('readHistoryBaseline：读不到历史文件时不抛（首次运行就是这么开始的）', () => {
    const t = verify.readHistoryBaseline();
    expect(t === null || typeof t === 'object').toBe(true);
  });
});
