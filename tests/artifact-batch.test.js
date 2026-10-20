/* ============================================================
 * tests/artifact-batch.test.js — 「产物连带闭包」（`ARTIFACT_BATCH`，缺口 `G-16`）的契约 + **判别力**
 * 运行：npx vitest run tests/artifact-batch.test.js
 * ------------------------------------------------------------
 * 它守的那件事：R5「改动即连带」里**可以机械化的那一半** ——
 *   "新增一件产物时，那几处登记面必须**同批**跟着动"。
 *   那一批把这 6 处逐处在**镜像副本**上量过（`.review/20261020-门禁B/`）：4 处已有人守
 *   （G8 ⑦⑩⑬ / G7 / G6 / S2 的 SMOKE_INDEX），**当时 2 处没有**：
 *     ① `renderer/*.js` 的架构登记面（G8 ⑦ 的扫描面 `COVERED_DIRS` 不含 `renderer`）；
 *     ② 本表里"指过去复用"的**实现锚**（原先只核"那个门禁挂在链上"，那条**判定**被删掉也不会红）。
 *
 * ⚠️ **① 已经在 2026-10-20（门禁B2）收口**：`renderer` 已进 G8 ⑦ 的 `COVERED_DIRS`，
 *   §2.1 存量也补齐了 ⇒ 本门禁当时那条**临时兜底**（自建登记断言 + 封闭欠账册 + `archMentionsModule`）
 *   **连同欠账册一起删掉**，连带表里那一行改成 `role:'gate'` 指过去复用 G8 ⑦。
 *   两方向读数（不登记 ⇒ G8 红且点名 / 登记 ⇒ 绿，都带 exit code）见
 *   `.review/20261020-门禁B2/proof-g8-renderer.js`；判定本体的**常驻**单测在
 *   `tests/docs-registry-renderer.test.js`（这一份不再重复测它）。
 *   ⇒ 所以本文件现在**只剩 ②**：这是"一处判定只留一份实现"的直接结果，不是覆盖被砍。
 *
 * 为什么用例长这样：
 *   · 判定本体是**纯函数 + 可注入表**（`B6`），所以下面每一条"该红"都是**真注入**，
 *     真仓库一个字节不动 —— 这是"新门禁先证明它会红"的可重复版本（`B4`）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/collateral-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('ARTIFACT_BATCH：每一处「指过去复用」必须有实现锚，且锚真的在', () => {
  // 表是**注入的**：真仓 COLLATERAL 一个字节不动，但这几处的锚解析与文件读取走的是真实现。
  const place = (anchor) => ({ at: 'docs/VERIFY.md 的「CLI 命令数」', role: 'gate', gate: 'G6', anchor: anchor });

  it('真表：每一处「指过去复用」全部能在被指门禁的源码里找到锚', () => {
    const r = gate.checkGateAnchors(ROOT, gate.COLLATERAL);
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
    expect(r.total).toBeGreaterThan(5);       // 扫描面不是空的（空表会恒真）
    expect(r.ok).toBe(r.total);
  });

  it('★ 锚指向一个**不存在的标识符** ⇒ 红，并说明"那条判定可能被删/改名了"', () => {
    const r = gate.checkGateAnchors(ROOT, [{ id: 'x', places: [place('scripts/doc-facts.js#parseClaims__renamed')] }]);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].msg).toMatch(/找不到/);
    expect(r.problems[0].msg).toMatch(/parseClaims__renamed/);
  });

  it('★ 锚指向一个**不存在的脚本** ⇒ 红（改了文件名要同批改锚）', () => {
    const r = gate.checkGateAnchors(ROOT, [{ id: 'x', places: [place('scripts/zz-no-such-gate.js#parseClaims')] }]);
    expect(r.problems.some((p) => /不存在的脚本/.test(p.msg))).toBe(true);
  });

  it('★ 压根没写锚 ⇒ 红（只核"门禁挂在链上"是空头承诺）', () => {
    const r = gate.checkGateAnchors(ROOT, [{ id: 'x', places: [place(undefined)] }]);
    expect(r.problems.some((p) => /空头承诺/.test(p.msg))).toBe(true);
  });

  it('锚格式不对（没有 `#`）⇒ 红', () => {
    const r = gate.checkGateAnchors(ROOT, [{ id: 'x', places: [place('scripts/doc-facts.js')] }]);
    expect(r.problems.some((p) => /格式不对/.test(p.msg))).toBe(true);
  });
});

/* ---------------------------------------------------------------
 * 收口的**反向**守卫：别再让"自建断言"长回来
 * --------------------------------------------------------------- */
describe('renderer 入档已收口：连带表那一行必须「指过去复用 G8 ⑦」，不许再自建断言', () => {
  const row = gate.COLLATERAL.find((r) => r.id === 'renderer-module');

  it('`renderer-module` 那一行还在（连带面本身不能悄悄消失）', () => {
    expect(row, '连带表里没有 `renderer-module` 那一行').toBeTruthy();
    expect(row.places.length).toBeGreaterThanOrEqual(1);
  });

  it('★ 它是 `role:gate` 指向 G8，**不是** `role:self` 自建断言（后者 = 同一件事两份实现）', () => {
    const p = row.places[0];
    expect(p.role).toBe('gate');
    expect(p.gate).toBe('G8');
    expect(p.check).toBeUndefined();
  });

  it('★ 它的锚在 G8 源码里真的存在（不是"指过去"就算数）', () => {
    const anchor = row.places[0].anchor || '';
    const hi = anchor.indexOf('#');
    expect(hi, '锚格式不是 `<脚本>#<标识符>`：' + anchor).toBeGreaterThan(0);
    const file = anchor.slice(0, hi);
    const needle = anchor.slice(hi + 1);
    expect(fs.existsSync(path.join(ROOT, file)), '锚指向的脚本不存在：' + file).toBe(true);
    expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toContain(needle);
  });

  it('★ 本门禁不再导出那套兜底 API（删干净了才算搬走）', () => {
    ['ARTIFACT_BATCH_DEBT', 'ARTIFACT_BATCH_DIRS', 'archMentionsModule'].forEach((k) => {
      expect(gate[k], '`' + k + '` 还在导出 —— 兜底没删干净').toBeUndefined();
    });
  });
});
