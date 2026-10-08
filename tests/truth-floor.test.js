/* ============================================================
 * tests/truth-floor.test.js — 防挖空地板：验证规模**不得静默下降**
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它（本工程最重的损害类别是"静默"）：
 *   断言数是本工程唯一"覆盖规模"的机械真值。**删掉一批断言**不会让任何门禁变红 ——
 *   G6 只查"文档与代码一致"（删完重跑 `facts:write` 就又一致了 ✗），G5 只查"跑没跑过"。
 *   于是一次"为了让它绿"的清理，就能把覆盖悄悄削掉，而所有人都以为还在守。
 *   ⇒ 用地板卡住：**当前规模 < 上一次提交的规模 ⇒ 红**。
 *
 * 地板从哪来：`git show HEAD:docs/VERIFY.md`（**已提交**的真值）。
 *   · 为什么不写在测试文件里当常量：那是第二份会漂移的副本（每次加断言都要手改两处 ✗）；
 *   · 为什么不用当前工作区的 `docs/VERIFY.md`：它是**生成物**，删掉断言后重跑
 *     `facts:write` 它自己就变小了 ⇒ 拿它当地板等于没地板 ✗。
 *
 * 降级：**没有 git（或 HEAD 里没有该文件）⇒ 响亮跳过**，不当假红。
 *   理由：这是"安全网"而不是门禁；网撒不下去时必须说一声，但不能因此拦住合法环境
 *   （同 `scripts/verify.js` 的 `backupHint()` 对"本地 Git 有没有"的处理风格）。
 *
 * 允许合法的下降：真的合并/删除了断言时，**同一次提交里**改这里不要用 ——
 *   正确做法是本次改动就把门槛显式写进提交信息并在评审里说清；地板本身不做豁免开关，
 *   免得"豁免"变成习惯性动作（本工程的历史证明：能顺手绕过的门禁最后都被绕过）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = path.join(ROOT, 'docs', 'VERIFY.md');

/** 从 VERIFY.md 的表格里抽"规模类"数字：标签 → 数字（按**行标签**取，不靠行号/顺序 ✓） */
function parseScale(text) {
  const out = {};
  const grab = (label, re, key) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith('| ' + label + ' |'));
    if (!line) return;
    const m = line.match(re);
    if (m) out[key] = Number(m[1]);
  };
  grab('CLI 命令数', /\|\s*(\d+)\s*\|/, 'commands');
  grab('MCP 工具数', /\|\s*(\d+)\s*\|/, 'mcpTools');
  grab('单元测试', /\|\s*(\d+)\s*用例/, 'unitTests');
  grab('单元测试', /\/\s*(\d+)\s*文件/, 'unitFiles');
  grab('CLI 集成断言', /\|\s*(\d+)\s*\|/, 'cliAssertions');
  grab('冒烟断言', /\|\s*(\d+)\s*\|/, 'smokeAssertions');
  grab('视觉断言（L2 关键区域）', /\|\s*(\d+)\s*\|/, 'visionAssertions');
  return out;
}

/** 已提交的那份（取不到就返回 null —— 由调用方决定怎么降级） */
function committedVerifyText() {
  try {
    return execFileSync('git', ['show', 'HEAD:docs/VERIFY.md'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  }
}

describe('防挖空：验证规模不得静默下降', () => {
  const committed = committedVerifyText();
  const current = fs.existsSync(VERIFY) ? fs.readFileSync(VERIFY, 'utf8') : null;

  it('当前 docs/VERIFY.md 必须存在（它是权威基线；缺了就是采不到真值）', () => {
    expect(current, 'docs/VERIFY.md 不存在：跑 `npm run facts:write` 生成').toBeTruthy();
  });

  it('地板：当前每一项都不得低于已提交的那份', () => {
    if (committed === null) {
      // 响亮跳过（不是静默绿）：能看到这行说明"这次没在守"
      console.warn('[防挖空] 取不到 `git show HEAD:docs/VERIFY.md`（无 git 历史？）⇒ 本次跳过地板核对，未在守护');
      return;
    }
    const floor = parseScale(committed);
    const now = parseScale(current);
    const keys = Object.keys(floor);
    expect(keys.length, '已提交的 VERIFY.md 里一个规模数字都没解析出来（表格格式变了？）').toBeGreaterThan(3);
    const drops = [];
    for (const k of keys) {
      if (now[k] === undefined) { drops.push(k + '：当前文件里没有这一项（表格格式变了？）'); continue; }
      if (now[k] < floor[k]) drops.push(k + '：' + floor[k] + ' → ' + now[k] + '（少 ' + (floor[k] - now[k]) + '）');
    }
    expect(drops, '验证规模下降了 —— 若是真的合并/删除，请在提交信息里说明；否则这就是"为了绿而删断言" ✗\n'
      + drops.map((d) => '  · ' + d).join('\n')).toEqual([]);
  });

  it('解析器本身不能悄悄失效（用一份人造文本验证它能抓到下降）', () => {
    const fake = ['| 单元测试 | 10 用例 / 3 文件 | `tests/*.test.js`（vitest） |',
      '| 冒烟断言 | 5 | `scripts/smoke-assertions.js` |'].join('\n');
    const p = parseScale(fake);
    expect(p.unitTests).toBe(10);
    expect(p.unitFiles).toBe(3);
    expect(p.smokeAssertions).toBe(5);
    expect(p.commands).toBeUndefined();   // 没有的行就是 undefined（调用方据此报"格式变了"）
  });
});
