/* ============================================================
 * tests/verify-budget.test.js — 验证链耗时预算与链定义自洽
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它：计时本身不可单测（依赖机器与负载），但**判定逻辑**可以，
 * 而判定逻辑写错会让这个门禁变成"永远通过"或"随机红灯" —— 两种都会让它被无视。
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

  it('预算留足余量：当前实测值不应逼近预算（否则会变成随机红灯）', () => {
    // 当前实测（本机）：G1~0.7s G8~0.7s G9~0.6s G3~6s G4~4.5s G5~51s G2~0.6s G6~7.3s
    const measured = { G1: 700, G8: 700, G9: 600, G3: 6000, G4: 4500, G5: 51000, G2: 600, G6: 7300 };
    for (const s of verify.STEPS) {
      if (!s.budgetMs || !measured[s.gate]) continue;
      expect(s.budgetMs / measured[s.gate], s.gate + ' 的预算余量').toBeGreaterThan(1.8);
    }
  });
});

describe('验证链定义自洽（scripts/verify.js 是唯一定义）', () => {
  it('门禁编号不重复，且顺序就是文档里承诺的那条链', () => {
    const gates = verify.STEPS.map((s) => s.gate);
    expect(new Set(gates).size).toBe(gates.length);
    expect(gates).toEqual(['G1', 'G8', 'G9', 'G3', 'G4', 'G5', 'G2', 'G6', 'G7']);
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
    const declared = [...rules.matchAll(/^\|\s*\*\*(G\d+)\*\*/gm)].map((m) => m[1]);
    const mounted = verify.STEPS.map((s) => s.gate);
    expect(declared.length, 'RULES.md 里应声明多个门禁').toBeGreaterThan(5);
    const missing = declared.filter((g) => !mounted.includes(g));
    expect(missing, '这些门禁在 RULES.md 里声明了，却没挂进 scripts/verify.js 的 STEPS').toEqual([]);
  });

  it('package.json 的 verify 指向本 runner（不是又一份手抄的 && 链）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.verify).toBe('node scripts/verify.js');
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
