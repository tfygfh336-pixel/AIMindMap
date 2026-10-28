/* ============================================================
 * tests/verify-tier-delta.test.js —— 「比上次慢了 15%」必须**按档比较**（本批 ②）
 * ------------------------------------------------------------
 * 治的那条真实假警报（历史 `.review/verify-history.jsonl` 里两次相邻记录）：
 *     fast 档 396.5s → full 档 1296.1s
 *     ⇒ 脚本打印「比上次慢了 **+893.4s**（超过上次的 15%）」，而它自己在同一张表上标着「（档不同）」。
 *   fast 档只跑 core 域、full 档跑全部域 ⇒ 两个**合计**根本是两件事；把它当"变慢"会训练读者
 *   忽略这条警告（下一次真的变慢就没人看了）。
 *
 * 判据两侧（**都要**，缺一条就是"把警告关掉"而不是"修好"）：
 *   ① 换档（fast→full / full→fast / 部分验证）⇒ `delta.total.deltaMs === null` 且**不再**出现
 *      「比上次慢了」那一行 —— 同时要**明说**「本次换档，不做增速判定」；
 *   ② **同档**真的变慢（+20%）⇒ **仍然**报（`slowWarningText()` 必须给出那句话）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const verify = require('../scripts/verify.js');

/** 造一份"历史记录"形状（只保留这条判据要读的字段） */
function run(opts) {
  const o = opts || {};
  const step = { gate: 'G5', ms: o.g5Ms === undefined ? 900000 : o.g5Ms, code: 0 };
  if (o.tier !== undefined) step.tier = o.tier;
  if (o.g5Skipped) { step.skipped = true; step.ms = 0; step.code = null; }
  return { at: '2026-10-28T00:00:00.000Z', ok: true, totalMs: o.totalMs, steps: [step] };
}

describe('totalComparable：合计能不能与上次比（三类不可比，各自的 why 要能印给人看）', () => {
  it('**跨档**（fast 396.5s → full 1296.1s）⇒ 不可比，why 点名两档', () => {
    const prev = run({ tier: 'fast', totalMs: 396500 });
    const cur = [{ gate: 'G5', ms: 1296090, tier: 'full', code: 0 }];
    const tc = verify.totalComparable(prev, cur, {});
    expect(tc.comparable, '跨档必须判"不可比"——这就是 +893.4s 那条假警报的根').toBe(false);
    expect(tc.why).toContain('fast');
    expect(tc.why).toContain('full');
  });

  it('反方向（full → fast）同样不可比（不许只在"变慢"那一侧生效）', () => {
    const prev = run({ tier: 'full', totalMs: 1296090 });
    const cur = [{ gate: 'G5', ms: 396500, tier: 'fast', code: 0 }];
    expect(verify.totalComparable(prev, cur, {}).comparable).toBe(false);
  });

  it('**同档** ⇒ 可比（full → full / fast → fast）', () => {
    expect(verify.totalComparable(run({ tier: 'full', totalMs: 1000000 }),
      [{ gate: 'G5', ms: 900000, tier: 'full', code: 0 }], {}).comparable).toBe(true);
    expect(verify.totalComparable(run({ tier: 'fast', totalMs: 400000 }),
      [{ gate: 'G5', ms: 380000, tier: 'fast', code: 0 }], {}).comparable).toBe(true);
  });

  it('老记录**没有 tier 字段** ⇒ 合计仍然可比（没声明就不能断言"它们不同"）', () => {
    const prev = run({ totalMs: 1000000 });          // 不写 tier（= 分层之前的老记录）
    expect(verify.totalComparable(prev, [{ gate: 'G5', ms: 950000, tier: 'full', code: 0 }], {}).comparable)
      .toBe(true);
    /* 与逐门禁那一列同一口径（那条只比两处**都写了** tier 的情况）；
     * "缺字段=full" 是 `readLastFullG5()` 的**时钟**口径（回答"该轮到全量了没有"），不是这一条。 */
    expect(verify.totalComparable(prev, [{ gate: 'G5', ms: 200000, tier: 'fast', code: 0 }], {}).comparable)
      .toBe(true);
  });

  it('轻量夹具缺 `code` 字段 ⇒ **不许**被当成"没跑"（真实记录里 `code` 必有，缺它只出现在单测夹具里）', () => {
    const prev = { totalMs: 100000, steps: [{ gate: 'G5', ms: 90000 }] };
    const tc = verify.totalComparable(prev, [{ gate: 'G5', ms: 95000 }], {});
    expect(tc.comparable, '把"缺字段"当"没跑"就是假红').toBe(true);
  });

  it('本次是**部分验证** ⇒ 不可比（合计与全链不是同一件事）', () => {
    const tc = verify.totalComparable(run({ tier: 'full', totalMs: 1000000 }),
      [{ gate: 'G5', ms: 950000, tier: 'full', code: 0 }], { partial: true, planLabel: '--changed' });
    expect(tc.comparable).toBe(false);
    expect(tc.why).toContain('部分验证');
    expect(tc.why).toContain('--changed');
  });

  it('上次 G5 **没跑**（skipped）⇒ 不可比（上次合计少一大块）', () => {
    const prev = run({ tier: 'full', totalMs: 1000000, g5Skipped: true });
    const tc = verify.totalComparable(prev, [{ gate: 'G5', ms: 950000, tier: 'full', code: 0 }], {});
    expect(tc.comparable).toBe(false);
    expect(tc.why).toContain('没跑');
  });

  it('本次 G5 skipped / 本次记录里没有 G5 ⇒ 前者不可比、后者维持老行为（不拦）', () => {
    const prev = run({ tier: 'full', totalMs: 1000000 });
    expect(verify.totalComparable(prev, [{ gate: 'G5', ms: 0, tier: 'full', code: null, skipped: true }], {}).comparable)
      .toBe(false);
    expect(verify.totalComparable(prev, [{ gate: 'G3', ms: 80000, code: 0 }], {}).comparable).toBe(true);
  });
});

describe('historyDelta：合计那一格要带着"为什么不可比"出来（不是只给个 null）', () => {
  it('换档 ⇒ `deltaMs: null` + `why` 有档名；**逐门禁**那一列也照样不给差', () => {
    const prev = run({ tier: 'fast', totalMs: 396500, g5Ms: 380000 });
    const cur = [{ gate: 'G5', ms: 1296090, tier: 'full', code: 0 }];
    const d = verify.historyDelta(prev, cur, 1296090, {});
    expect(d.total.deltaMs).toBe(null);
    expect(d.total.why).toContain('档不同');
    expect(d.total.ms, '不可比时"上次"那一列仍然要给读数').toBe(396500);
    expect(d.byGate.G5.deltaMs).toBe(null);
  });

  it('同档 ⇒ 算出真实的差（负 = 变快）', () => {
    const prev = run({ tier: 'full', totalMs: 1000000, g5Ms: 900000 });
    const d = verify.historyDelta(prev, [{ gate: 'G5', ms: 900000, tier: 'full', code: 0 }], 950000, {});
    expect(d.total.deltaMs).toBe(-50000);
  });

  it('部分验证 ⇒ 合计不可比（`--changed` 只跑了几步）', () => {
    const prev = run({ tier: 'full', totalMs: 1000000, g5Ms: 900000 });
    const d = verify.historyDelta(prev, [{ gate: 'G5', ms: 900000, tier: 'full', code: 0 }], 120000,
      { partial: true, planLabel: '--changed' });
    expect(d.total.deltaMs).toBe(null);
    expect(d.total.why).toContain('部分验证');
  });

  it('没有可比历史 ⇒ 整块 null（不伪造差）', () => {
    expect(verify.historyDelta(null, [{ gate: 'G5', ms: 1, tier: 'full', code: 0 }], 1, {})).toBe(null);
  });
});

describe('slowWarningText：「比上次慢了」**只在同档**说话（一侧修假警报、另一侧不许把警告关掉）', () => {
  it('① 换档（fast 396.5s → full 1296.1s）⇒ **不许**出现那条警告', () => {
    const prev = run({ tier: 'fast', totalMs: 396500, g5Ms: 380000 });
    const d = verify.historyDelta(prev, [{ gate: 'G5', ms: 1296090, tier: 'full', code: 0 }], 1296090, {});
    expect(verify.slowWarningText(d), '这就是那条假警报：+893.4s 是换档造成的，不是变慢').toBe(null);
  });

  it('② **同档**真的变慢 +20% ⇒ 仍然报（否则这个"修"就是把警告删了）', () => {
    const prev = run({ tier: 'full', totalMs: 1000000, g5Ms: 900000 });
    const d = verify.historyDelta(prev, [{ gate: 'G5', ms: 1080000, tier: 'full', code: 0 }], 1200000, {});
    const line = verify.slowWarningText(d);
    expect(line, '同档 +20% 必须报').toBeTruthy();
    expect(line).toContain('比上次慢了');
    expect(line).toContain('+200.0s');
  });

  it('同档但涨幅 ≤ 15% ⇒ 不报（阈值仍然是 15%，没有偷偷改小）', () => {
    // 1000s → 1140s = +14% ⇒ 不报；→ 1160s = +16% ⇒ 报（边界两侧各测一次）
    const mk = (nowMs) => verify.historyDelta(
      { at: 'x', ok: true, totalMs: 1000000, steps: [{ gate: 'G5', ms: 900000, tier: 'full', code: 0 }] },
      [{ gate: 'G5', ms: 900000, tier: 'full', code: 0 }], nowMs, {});
    expect(verify.slowWarningText(mk(1140000))).toBe(null);
    expect(verify.slowWarningText(mk(1160000))).toBeTruthy();
  });

  it('变快 ⇒ 不报；空输入 ⇒ 不炸也不报', () => {
    const prev = run({ tier: 'full', totalMs: 1000000, g5Ms: 900000 });
    const d = verify.historyDelta(prev, [{ gate: 'G5', ms: 900000, tier: 'full', code: 0 }], 900000, {});
    expect(verify.slowWarningText(d)).toBe(null);
    expect(verify.slowWarningText(null)).toBe(null);
    expect(verify.slowWarningText({})).toBe(null);
  });
});
