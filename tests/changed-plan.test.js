/* ============================================================
 * tests/changed-plan.test.js — 「改动面 → 必跑集」映射的纯函数契约
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么这个映射值得有单测：它是**唯一会"少跑东西"的地方** —— 映射写错，
 * 表现是"验证通过了"，而实际上该跑的那一步压根没跑（本工程最重的损害类别：静默 ✗）。
 * 所以这里锁的不是"能省多少"，而是**保守性**：
 *   ① 认不出的路径一律全量；
 *   ② 只有"G5 的唯一来源是已知冒烟域"时才收窄冒烟；
 *   ③ 干净工作树一步都不跑（不许跑两件卫生门禁假装验证过）；
 *   ④ 测试/冒烟域改动必须带上 G6（用例数/断言数会变，忘了 facts:write 要红）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { planForFiles, describePlan, FULL_STEPS } = require('../scripts/changed-plan.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** verify.js 的源码：接线检查用（它的 main() 跑起来就是整条链，没法在单测里调） */
const verifySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');

/** 便捷断言：某类改动 ⇒ 预期步骤集合 */
const plan = (...files) => planForFiles(files);

describe('映射：已知范围内的改动只跑相关步骤', () => {
  it('只改文档 ⇒ 卫生三件 + G3 + G6（**G3 必须带上**：不带时 G6 会自跑 vitest，耗时一样但单测没跑）', () => {
    const p = plan('docs/ARCHITECTURE.md', 'CHANGELOG.md', 'README.md');
    expect(p.full).toBe(false);
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'G3', 'G6']);
    expect(p.steps).not.toContain('G5');
    expect(p.smokeOnly).toBe(null);
  });

  it('只改单测 ⇒ 卫生三件 + G3 + G6（用例数变 ⇒ G6 必须看）', () => {
    const p = plan('tests/schema.test.js');
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'G3', 'G6']);
  });

  it('只改一个冒烟域 ⇒ 卫生三件 + G5（**收窄到该域**）+ G6', () => {
    const p = plan('scripts/smoke/22-sidebar-gap.js');
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'G6', 'G5']);
    expect(p.smokeOnly).toEqual(['22']);
  });

  it('改两个冒烟域 ⇒ 收窄到这两个（去重 + 排序，输出稳定）', () => {
    const p = plan('scripts/smoke/24-sidebar-close.js', 'scripts/smoke/09-save-persistence.js', 'scripts/smoke/09-save-persistence.js');
    expect(p.smokeOnly).toEqual(['09', '24']);
  });

  it('文档 + 单测混着改 ⇒ 取并集（保守：宁多跑）', () => {
    const p = plan('docs/RULES.md', 'tests/truth-floor.test.js');
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'G3', 'G6']);
  });

  it('backslash 路径与前后空格照样识别（git 在 Windows 上给的是 /，但别赌）', () => {
    expect(plan('docs\\RULES.md').full).toBe(false);
    expect(plan('  tests/x.test.js  ').full).toBe(false);
  });
});

describe('保守性：认不出的一律全量（这是这个模块唯一允许"多跑"的方向）', () => {
  const MUST_BE_FULL = [
    'renderer/app-view.js',                 // 渲染层：直接影响 G5
    'main.js', 'main-dsh-sidebar.js', 'preload.js',
    'src/schema.js', 'src/data-store.js',   // 数据层：CLI 与界面共用
    'cli/mm-cli.js', 'scripts/mcp-server.js',
    'scripts/verify.js', 'scripts/doc-facts.js',   // 门禁自己
    'scripts/changed-plan.js',              // 本模块自己（改了就全量 —— 别让"改映射"绕过验证）
    'scripts/smoke-flags.js',               // 冒烟公共件（不是"域文件"）
    'scripts/smoke/util.js',                // 域目录里的**非域文件** ⇒ 全量 ✓（关键保守性）
    'package.json', 'vitest.config.js',
    'projects/comnet/comnet.json',          // 真实数据
    'some/unknown/path.txt'
  ];
  for (const f of MUST_BE_FULL) {
    it(f + ' ⇒ 全量', () => {
      const p = plan(f);
      expect(p.full).toBe(true);
      expect(p.steps).toEqual(FULL_STEPS);
      expect(p.smokeOnly).toBe(null);
    });
  }

  it('已知 + 未知混着 ⇒ 全量（未知那条说了算）', () => {
    const p = plan('docs/RULES.md', 'renderer/app.js');
    expect(p.full).toBe(true);
    expect(p.byRule.some((g) => g.rule.includes('兜底'))).toBe(true);
  });
});

describe('干净工作树与摘要输出', () => {
  it('没有改动 ⇒ 一步都不跑，且理由说清"没有验证任何东西"', () => {
    const p = planForFiles([]);
    expect(p.steps).toEqual([]);
    expect(p.full).toBe(false);
    expect(p.reason).toContain('没有验证任何东西');
  });

  it('describePlan 打出计划与理由（人看一眼就知道为什么选了这些）', () => {
    const lines = describePlan(plan('scripts/smoke/13-ui-state.js'));
    expect(lines.join('\n')).toContain('计划：');
    expect(lines.join('\n')).toContain('冒烟收窄到域：13');
    expect(lines.join('\n')).toContain('个文件');
  });
});

/* ============================================================================
 * 接线检查（源码级）：映射算得对不够，**verify.js 得真的照着做** ——
 * 同上位文件 tests/verify-budget.test.js 守"RULES.md 里声明的门禁必须真挂在链上"的做法。
 * 这两条一旦断了，表现是"看起来跑了部分验证"，实际是**跳过没跑**或**冒充全链结论** ✗
 * ========================================================================= */
describe('接线：verify.js 真的按计划跳过、收窄、分格记录', () => {
  it('收窄冒烟时把 SMOKE_ONLY 传给 G5（走既有机制，不另造一套）', () => {
    expect(verifySrc).toMatch(/plan\.smokeOnly/);
    expect(verifySrc).toMatch(/SMOKE_ONLY:/);
    const at = verifySrc.indexOf('SMOKE_ONLY:');
    expect(verifySrc.slice(Math.max(0, at - 320), at)).toContain("s.gate === 'G5'");
  });

  it('计划外的步骤被跳过，且标出**为什么**跳过（不能只是 ms=0 让人误会成"很快"）', () => {
    expect(verifySrc).toContain("skippedBy: 'changed'");
    expect(verifySrc).toContain('计划外');
  });

  it('部分验证**不覆盖** last-verify.json（那句"上次全链"不能被 4 步的记录改写）', () => {
    // 两处收尾（失败/成功）都必须是"partial ? 另一格 : last-verify"
    const hits = verifySrc.match(/if \(partial\) writeLastVerifyChanged\(run\); else writeLastVerify\(run\);/g) || [];
    expect(hits.length).toBe(2);
    expect(verifySrc).toContain('LAST_VERIFY_CHANGED');
  });

  it('历史记录标 partial，且耗时基线不认它（与"失败/中断不当基线"同一个理由）', () => {
    expect(verifySrc).toContain('partial: run.partial === true');
    expect(verifySrc).toMatch(/r\.partial !== true/);
  });

  it('横幅必须说清"这不是全量真值"（部分验证最危险的用法就是被当成验收）', () => {
    expect(verifySrc).toContain('这不是全量真值');
    expect(verifySrc).toContain('没有验证任何东西');
  });
});
