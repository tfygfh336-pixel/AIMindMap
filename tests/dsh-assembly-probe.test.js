/* ============================================================
 * tests/dsh-assembly-probe.test.js — 装配探针的纯逻辑
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个探针回答的是「**这个 id 能不能被 profile patch 打到？**」—— 而这件事**看装配文件看不出来**，
 * 只有运行时的**合成结果**能回答。它的解析错一点，结论就反过来。
 *
 * 本文件锁住三件事：
 *   ① 行解析（`- id:` + 其后 `name:` / `disabled:`）—— 与 `src/dsh-capabilities.js` 同一套规则；
 *   ② 逐行 diff（"补丁到底改了什么"的唯一硬证据）；
 *   ③ **用真实保存的基线 dump 回归**：`compaction-basic` 必须是 `disabled: true`（死行），
 *      而 `persona` 必须**不在**合成树里（preset 独有 ⇒ 补丁打不到）。
 *      这两条一旦被上游改掉，测试先红 —— 而不是让探针给出反向结论。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const probe = require('../scripts/dsh-assembly-probe.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// **证据随测试走**：基线 dump 放在 `tests/fixtures/`，**不是** `.review/` ——
// 后者是工作产物区、**不参与 C:/D: 同步**，放那儿会让这几条断言在另一个盘上**静默 skip**（实测踩到：
// D 盘上 10 条里 skip 了 4 条而套件仍报"通过"）。工程明令禁止"跳过伪装成一致"。
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'dsh-composed-tree-web.txt');

const SAMPLE = [
  '# == @deepseek-ai/dsh-base',
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  disabled: true',
  '# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
  '- id: token-meter',
  "  name: '@deepseek-ai/dsh-token-meter'",
  '  config:',
  '    ratio: 1'
].join('\n');

describe('parseComposed：解析合成树', () => {
  it('取出 id / name / disabled，并统计 disabled 数', () => {
    const c = probe.parseComposed(SAMPLE);
    expect(c.rows.map((r) => r.id)).toEqual(['timer', 'compaction-basic', 'token-meter']);
    expect(c.rows[0].disabled).toBe(false);
    expect(c.rows[1].disabled).toBe(true);
    expect(c.disabledCount).toBe(1);
  });

  it('收集层标签（`# ==` 行），用于分辨某行被哪一层最后写过', () => {
    expect(probe.parseComposed(SAMPLE).layerLabels).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app'
    ]);
  });

  it('空输入安全（不抛异常）', () => {
    expect(probe.parseComposed('').rows).toEqual([]);
    expect(probe.parseComposed(null).rows).toEqual([]);
  });
});

describe('diffLines：补丁生效范围的证据', () => {
  it('只报真正新增/消失的行（同内容多行用计数处理）', () => {
    const d = probe.diffLines('a\nb\nc', 'a\nb\nc\nd\ne');
    expect(d.added.sort()).toEqual(['d', 'e']);
    expect(d.removed).toEqual([]);
  });

  it('同值行重复出现时不误报（计数而非集合）', () => {
    const d = probe.diffLines('x\nx\ny', 'x\ny');
    expect(d.removed).toEqual(['x']);   // 只少了一行 x
    expect(d.added).toEqual([]);
  });

  it('空 diff 表示补丁没改任何一行', () => {
    const d = probe.diffLines('a\nb', 'a\nb');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe('真实基线 dump 的回归断言（上游若改了装配，这里先红）', () => {
  it('**基线证据必须存在** —— 缺它就红，绝不静默 skip（否则真回归会被"通过"掩盖）', () => {
    expect(fs.existsSync(BASELINE), '缺 ' + BASELINE + '：这几条回归断言没有真值就不能假装通过').toBe(true);
  });

  it('**compaction-basic 在合成树里且是 disabled 死行** —— P3-2 那条陷阱的前提', () => {
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    const row = c.rows.find((r) => r.id === 'compaction-basic');
    expect(row, 'compaction-basic 应出现在合成树里').toBeTruthy();
    expect(row.disabled, '它必须是 disabled —— 否则"补丁打在死行上"这个结论就不成立了').toBe(true);
    expect(row.name).toBe('@deepseek-ai/dsh-compaction-basic');
  });

  it('**persona 不在合成树里** —— preset 独有 id 的代表，补丁打不到', () => {
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    expect(c.rows.some((r) => r.id === 'persona')).toBe(false);
  });

  it('合成树里有相当数量的 disabled 死行（实测 26 行）', () => {
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    expect(c.disabledCount).toBeGreaterThan(10);
  });

  it('层标签能区分"base 层"与"被 web-app 补过的 base 层"', () => {
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    expect(c.layerLabels.some((l) => /patched by @deepseek-ai\/dsh-web-app/.test(l))).toBe(true);
  });
});
