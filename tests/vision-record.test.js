/* ============================================================
 * tests/vision-record.test.js — 读图留痕（阶段 4 / L4）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * L4 的定义性弱点是"**无法自动判定**"（判定阶梯的定义），所以它唯一能靠的就是
 * **结论与当时那张图绑定**。本文件锁住这条绑定，以及另外两条设计主张：
 *   ① **哈希不符 ⇒ 拒绝写入**（否则"绑定"是空话：图换过、结论还是旧的，没人能发现）；
 *   ② **记录里零手打数字** —— 断言计数/分辨率一律从 `smoke-frame.json` 取；
 *   ③ `missing` 必须注明是"不适用"还是"不见了"（否则读图退化成猜）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rec = require('../scripts/vision/record.js');

const FRAME = { width: 1424, height: 835, bytes: 100, sha256: 'a'.repeat(64), smokeAssertions: 115, visionAssertions: 2 };
const okCheck = (k) => rec.parseCheck(k + '=ok');

const build = (over) => rec.buildRecord(Object.assign({
  frame: FRAME, topic: '详情框改版', verdict: 'ok',
  checks: [okCheck('工具栏'), okCheck('导图')], note: '', pngSha256: FRAME.sha256
}, over || {}));

describe('parseCheck：格式与判定枚举', () => {
  it('标准形式', () => {
    expect(rec.parseCheck('工具栏=ok')).toEqual({ key: '工具栏', verdict: 'ok', why: '' });
  });

  it('带说明的形式（missing 必须带）', () => {
    expect(rec.parseCheck('详情框=missing:本次未打开'))
      .toEqual({ key: '详情框', verdict: 'missing', why: '本次未打开' });
  });

  it('**missing 不带说明 ⇒ 报错**（否则"missing"到底是"不适用"还是"不见了"没人知道）', () => {
    expect(rec.parseCheck('详情框=missing').error).toMatch(/必须注明/);
  });

  it('未支持的判定 ⇒ 报错（枚举只有 ok / unexpected / missing）', () => {
    expect(rec.parseCheck('工具栏=maybe').error).toMatch(/只允许/);
    expect(rec.VERDICTS).toEqual(['ok', 'unexpected', 'missing']);
  });

  it('缺 = 或区域名为空 ⇒ 报错', () => {
    expect(rec.parseCheck('工具栏ok').error).toMatch(/格式/);
    expect(rec.parseCheck('=ok').error).toMatch(/格式|为空/);
  });
});

describe('**哈希绑定：不符就拒绝写入**（这是 L4 唯一的防伪机制）', () => {
  it('取景记录的 sha256 与当前 PNG 不一致 ⇒ 拒绝，并说清原因', () => {
    const r = build({ pngSha256: 'b'.repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/哈希不符/);
    expect(r.problems.join(' ')).toMatch(/过期的图/);
    expect(r.problems.join(' ')).toMatch(/拒绝写入/);
  });

  it('一致 ⇒ 通过，且记录里的 sha256 就是取景记录里那个', () => {
    const r = build();
    expect(r.ok).toBe(true);
    expect(r.record.sha256).toBe(FRAME.sha256);
  });

  it('取景记录本身缺 sha256/分辨率 ⇒ 拒绝（不能"绑了个空"）', () => {
    expect(build({ frame: { width: 1, height: 1 } }).ok).toBe(false);
    expect(build({ frame: { sha256: 'a'.repeat(64) } }).ok).toBe(false);
  });
});

describe('**零手打数字**：计数与分辨率一律来自取景记录', () => {
  it('分辨率/冒烟断言/视觉断言都从 frame 取，不接受调用方另传', () => {
    const r = build();
    expect(r.record.resolution).toBe('1424x835');
    expect(r.record.smokeAssertions).toBe(115);
    expect(r.record.visionAssertions).toBe(2);
  });

  it('frame 里没有计数时记为 null（而不是猜一个 0 —— 0 会被读成"真的一条都没有"）', () => {
    const r = build({ frame: { width: 1424, height: 835, sha256: 'a'.repeat(64) } });
    expect(r.record.smokeAssertions).toBe(null);
    expect(r.record.visionAssertions).toBe(null);
  });
});

describe('buildRecord：必填项与文件名', () => {
  it('缺 topic / verdict 非法 / 无 check ⇒ 拒绝', () => {
    expect(build({ topic: '' }).ok).toBe(false);
    expect(build({ verdict: 'maybe' }).ok).toBe(false);
    expect(build({ checks: [] }).ok).toBe(false);
  });

  it('文件名 = 时间戳 + 主题 slug，且是 .json', () => {
    const r = rec.buildRecord({
      frame: FRAME, topic: '详情框 改版/v2', verdict: 'ok', checks: [okCheck('工具栏')],
      pngSha256: FRAME.sha256, now: new Date(2026, 8, 26, 15, 30)
    });
    expect(r.name).toMatch(/^20260926-1530-/);
    expect(r.name).toMatch(/\.json$/);
    expect(r.name).not.toMatch(/[\\/:*?"<>|\s]/);   // 文件名安全
  });

  it('checklist 保留每项的 verdict 与 why', () => {
    const r = build({ checks: [okCheck('工具栏'), rec.parseCheck('详情框=missing:本次未打开')] });
    expect(r.record.checklist['工具栏']).toBe('ok');
    expect(r.record.checklist['详情框']).toEqual({ verdict: 'missing', why: '本次未打开' });
  });

  it('记录自述它是"本次迭代的证据"而非跨迭代比对键（防止被误当成门禁输入）', () => {
    expect(build().record._comment).toMatch(/不是跨迭代比对键/);
    expect(build().record._comment).toMatch(/不进门禁/);
  });
});

describe('slug', () => {
  it('保留中英文数字，其余折成连字符，且不产生空名', () => {
    expect(rec.slug('详情框 改版/v2')).toBe('详情框-改版-v2');
    expect(rec.slug('   ')).toBe('unnamed');
    expect(rec.slug('a'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});
