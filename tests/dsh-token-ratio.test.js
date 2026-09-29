/* ============================================================
 * tests/dsh-token-ratio.test.js — token 折算比实测工具（脚本纯逻辑）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个工具产出的数字会被用来判断"DSH 的 token 估计偏多少"，而它**改不了**那个常量
 * （`CHARS_PER_TOKEN = 4` 硬编码且配置面封死）—— 所以它偏多少这件事只能靠这个工具说。
 * 因此它的解析错一点，结论就错一片。
 *
 * 本文件**专门锁住执行中真实踩到的三个坑**（不是假想的边界）：
 *   ① 字段路径是 `record.rows.contextPressure.val`，**不是**顶层 `contextPressure.val` ——
 *      按后者扫会得出"249 个文件、0 个样本"的**假结论**；
 *   ② 有 `pressureTokens: 0` 的**退化样本**（provider 报 0 而启发式 >0），
 *      不排除会让 min 变成 0、把分布拉到无意义（实测 249 个里有 18 个）；
 *   ③ 内嵌实例目录名是 **`AI MindMap`**（"AI" 后一个空格、MindMap 一个词）——
 *      写成 `AI Mind Map` 会 `existsSync` 为 false，把**正确的 home 误报成路径错误**。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ratio = require('../scripts/dsh-token-ratio.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 造一个与真实 projcache 同形的记录 */
const rec = (pressureTokens, surfaceTokens, sampled) => ({
  version: 2,
  record: {
    identity: { sessionId: 'sess-x' },
    rows: { contextPressure: { ver: 5, seq: 229, val: { surfaceTokens, contextPressure: 1000000, pressureTokens, sampledSurfaceTokens: sampled } } }
  }
});

describe('sampleFromRecord：字段路径与退化样本', () => {
  it('从 record.rows.contextPressure.val 取成对样本（**不是**顶层 —— 踩过）', () => {
    const s = ratio.sampleFromRecord(rec(145761, 92926, 92520));
    expect(s).not.toBe(null);
    expect(s.real).toBe(145761);
    expect(s.heuristic).toBe(92926);
    expect(s.sampled).toBe(92520);
    expect(s.ratio).toBeCloseTo(1.569, 3);
  });

  it('**顶层放 contextPressure 不算数**：必须嵌在 record.rows 里', () => {
    expect(ratio.sampleFromRecord({ contextPressure: { val: { pressureTokens: 1, surfaceTokens: 1 } } })).toBe(null);
  });

  it('**退化样本被排除**：provider 报 0 而启发式 >0（实测 249 里有 18 个）', () => {
    expect(ratio.sampleFromRecord(rec(0, 92926, 92520))).toBe(null);
  });

  it('heuristic 为 0 或负数也不可比（防除零）', () => {
    expect(ratio.sampleFromRecord(rec(100, 0, 0))).toBe(null);
    expect(ratio.sampleFromRecord(rec(100, -5, 0))).toBe(null);
  });

  it('缺 contextPressure / 字段非数字 → null，不抛异常', () => {
    expect(ratio.sampleFromRecord({ record: { rows: {} } })).toBe(null);
    expect(ratio.sampleFromRecord(rec('x', 1, 1))).toBe(null);
    expect(ratio.sampleFromRecord(null)).toBe(null);
  });
});

describe('summarize：只给分布与中位（单样本不可外推）', () => {
  const mk = (rs) => rs.map((r, i) => ({ sessionId: 's' + i, real: r * 1000, heuristic: 1000, sampled: null, ratio: r }));

  it('比值可以 < 1 —— "启发式总是低估"这句话本身是错的', () => {
    const s = ratio.summarize(mk([0.995, 1.2, 1.5]));
    expect(s.min).toBeCloseTo(0.995, 3);
    expect(s.belowOne).toBe(1);
    expect(s.underPct).toBeLessThan(100);
  });

  it('中位与均值都给出，且 minReal 可过滤小样本', () => {
    const all = mk([1, 2, 3, 4]);
    expect(ratio.summarize(all, {}).n).toBe(4);
    expect(ratio.summarize(all, { minReal: 2000 }).n).toBe(3);   // real = ratio*1000
    expect(ratio.summarize(all, { minReal: 99999 }).n).toBe(0);
  });

  it('空输入 → 各统计量为 null（**不是 0**：0 会被误读成"偏差为零"）', () => {
    const s = ratio.summarize([]);
    expect(s.n).toBe(0);
    expect(s.median).toBe(null);
    expect(s.mean).toBe(null);
    expect(s.underPct).toBe(null);
  });

  it('quantile 端点与中位', () => {
    expect(ratio.quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(ratio.quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(ratio.quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
});

describe('renderReport：无样本时必须**响亮说清**，不能静默', () => {
  const base = { home: 'H', dir: 'H/d', files: 0, samples: [], degenerate: 0, unreadable: 0 };

  it('home 不存在 → 明确说"路径给错了"，并把两套 home 都列出来', () => {
    const t = ratio.renderReport('H', Object.assign({}, base, { homeExists: false, dirExists: false }));
    expect(t).toMatch(/home 目录不存在/);
    expect(t).toMatch(/路径给错了/);
    expect(t).toMatch(/\.dsh/);
  });

  it('**home 存在但没有 projcache → 是"有效结论"，不是路径错误**（内嵌实例正是这种状态）', () => {
    const t = ratio.renderReport('H', Object.assign({}, base, { homeExists: true, dirExists: false }));
    expect(t).toMatch(/有效结论/);
    expect(t).toMatch(/不得.*宣称.*启发式准确|无样本 ≠ 偏差为 1/);
    expect(t).toMatch(/跨实例推断/);
    expect(t).not.toMatch(/路径给错了/);
  });

  it('有文件但全都算不出 → 说"可算比值的样本 = 0"，并禁止据此宣称准确', () => {
    const t = ratio.renderReport('H', Object.assign({}, base, { homeExists: true, dirExists: true, files: 9, degenerate: 9 }));
    expect(t).toMatch(/可算比值的样本 = 0/);
    expect(t).toMatch(/退化样本 9 个已排除/);
    expect(t).toMatch(/不得/);
  });

  it('有样本时输出中位与"请勿当成万能倍数"的告警', () => {
    const samples = [{ sessionId: 'a', real: 1290, heuristic: 1000, sampled: null, ratio: 1.29 }];
    const t = ratio.renderReport('H', Object.assign({}, base, { homeExists: true, dirExists: true, files: 1, samples }));
    expect(t).toMatch(/中位 1\.290/);
    expect(t).toMatch(/请勿当成万能倍数/);
    expect(t).toMatch(/record\.rows\.contextPressure\.val/);   // 口径必须写在输出里
  });
});

describe('embeddedHome：目录名拼写的回归守卫', () => {
  it('是 `AI MindMap`（"AI" 后一个空格、MindMap 一个词），**不是** `AI Mind Map`', () => {
    const h = ratio.embeddedHome();
    expect(path.basename(path.dirname(h))).toBe('AI MindMap');
    expect(h).not.toMatch(/AI Mind Map/);   // 踩过：这个拼写让 existsSync 为 false
    expect(path.basename(h)).toBe('dsh-home');
  });
});
