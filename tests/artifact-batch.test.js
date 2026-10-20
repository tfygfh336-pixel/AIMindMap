/* ============================================================
 * tests/artifact-batch.test.js — 「产物连带闭包」（`ARTIFACT_BATCH`，缺口 `G-16`）的契约 + **判别力**
 * 运行：npx vitest run tests/artifact-batch.test.js
 * ------------------------------------------------------------
 * 它守的那件事：R5「改动即连带」里**可以机械化的那一半** ——
 *   "新增一件产物时，那几处登记面必须**同批**跟着动"。
 *   本批把这 6 处逐处在**镜像副本**上量过（`.review/20261020-门禁B/`）：4 处已有人守
 *   （G8 ⑦⑩⑬ / G7 / G6 / S2 的 SMOKE_INDEX），**2 处没有**：
 *     ① `renderer/*.js` 的架构登记面（G8 ⑦ 的扫描面 `COVERED_DIRS` 不含 `renderer`）；
 *     ② 本表里"指过去复用"的**实现锚**（原先只核"那个门禁挂在链上"，那条**判定**被删掉也不会红）。
 *
 * 为什么用例长这样：
 *   · 判定本体是**纯函数 + 可注入根目录/表**（`B6`），所以下面每一条"该红"都是**真注入**，
 *     真仓库一个字节不动 —— 这是"新门禁先证明它会红"的可重复版本（`B4`）。
 *   · 欠账册那三条是**封闭册的通用形态**（在册放过 / 修好忘销账红 / 悬挂登记红），
 *     与 `NOTE_RESIDUE` / `WRITE_OUTLET` 同一口径，别处不许再造第四种写法。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/collateral-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* 夹具目录带 pid + 随机段（`E5`）：并发跑不会互相删，收尾只清自己那一个。 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-artifact-batch-' + process.pid + '-'));
afterAll(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const ARCH_HEAD = '# ARCH\n\n### 2.1 渲染层（renderer/）\n\n| 模块 | 职责 |\n|------|------|\n';
/** 造一个"只够判这句"的最小根：`docs/ARCHITECTURE.md` + `renderer/*.js` */
function makeRoot(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(HOME, 'r-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
  (o.modules || []).forEach((f) => fs.writeFileSync(path.join(dir, 'renderer', f), "'use strict';\n", 'utf8'));
  fs.writeFileSync(path.join(dir, 'docs', 'ARCHITECTURE.md'), ARCH_HEAD + (o.archRows || []).join(''), 'utf8');
  return dir;
}
const row = (f, what) => '| `' + f + '` | ' + (what || 'x') + ' |\n';

describe('ARTIFACT_BATCH 断言①：渲染层模块必须有架构登记面（G8 ⑦ 扫不到的那一类）', () => {
  it('未登记 ⇒ 红，并在报文里点名文件与"这是 G8 的扫描缺口"', () => {
    const root = makeRoot({ modules: ['app-z.js'], archRows: [] });
    const r = gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: [] });
    const hit = r.problems.filter((p) => p.kind === 'artifact');
    expect(hit.length, JSON.stringify(r.problems)).toBe(1);
    expect(hit[0].msg).toMatch(/renderer\/app-z\.js/);
    expect(hit[0].msg).toMatch(/COVERED_DIRS/);
  });

  it('同一批把它登记进 §2.1 ⇒ 绿（文件名整串出现即算登记）', () => {
    const root = makeRoot({ modules: ['app-z.js'], archRows: [row('app-z.js')] });
    const r = gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: [] });
    expect(r.problems).toEqual([]);
  });

  it('★ 判别力：把注入点挪一个字符（写成 `app-z2.js`）就重新变红 —— 防"判定恒绿"', () => {
    const root = makeRoot({ modules: ['app-z.js'], archRows: [row('app-z2.js')] });
    expect(gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: [] }).problems.length).toBe(1);
  });

  it('★ 登记口径带词边界：裸 `includes` 会把 `app-z` 判成已登记（它出现在 `app-z2.js` 里）', () => {
    expect(gate.archMentionsModule('| `app-z2.js` |', 'app-z.js')).toBe(false);
    expect(gate.archMentionsModule('| `app-z.js` |', 'app-z.js')).toBe(true);
    expect(gate.archMentionsModule('散文里只写 `app-z` 也算', 'app-z.js')).toBe(true);
    expect(gate.archMentionsModule('`my-app-z` 不算', 'app-z.js')).toBe(false);
  });

  it('读不到 `docs/ARCHITECTURE.md` ⇒ 红（采不到真值 = 红，`A5`）', () => {
    const root = makeRoot({ modules: ['app-z.js'] });
    fs.rmSync(path.join(root, 'docs', 'ARCHITECTURE.md'), { force: true });
    const r = gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: [] });
    expect(r.problems.some((p) => /采不到真值/.test(p.msg))).toBe(true);
  });
});

describe('ARTIFACT_BATCH 欠账册（封闭：只减不增）的三条机械判定', () => {
  const DEBT = [{ rel: 'renderer/app-old.js', why: 'w', close: 'c' }];

  it('在册且确实未登记 ⇒ 放过（输出里仍可见"在册欠账 N"）', () => {
    const root = makeRoot({ modules: ['app-old.js'], archRows: [] });
    const r = gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: DEBT });
    expect(r.problems).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/在册欠账 1/);
  });

  it('★ 修好忘销账 ⇒ 红（已登记却还挂在册上）', () => {
    const root = makeRoot({ modules: ['app-old.js'], archRows: [row('app-old.js')] });
    const r = gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: DEBT });
    expect(r.problems.some((p) => /修好忘销账/.test(p.msg))).toBe(true);
  });

  it('★ 册上那件文件已不存在 ⇒ 红（悬挂登记）', () => {
    const root = makeRoot({ modules: [], archRows: [] });
    const r = gate.analyzeArtifactBatch(root, { skipAnchors: true, debt: DEBT });
    expect(r.problems.some((p) => /悬挂登记/.test(p.msg))).toBe(true);
  });
});

describe('ARTIFACT_BATCH 断言②：每一处「指过去复用」必须有实现锚，且锚真的在', () => {
  // 表是**注入的**：真仓 COLLATERAL 一个字节不动，但这几处的锚解析与文件读取走的是真实现。
  const place = (anchor) => ({ at: 'docs/VERIFY.md 的「CLI 命令数」', role: 'gate', gate: 'G6', anchor: anchor });

  it('真表：16 处「指过去复用」全部能在被指门禁的源码里找到锚', () => {
    const r = gate.checkGateAnchors(ROOT, gate.COLLATERAL);
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
    expect(r.total).toBeGreaterThan(5);
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

describe('ARTIFACT_BATCH：真仓库当前读数（防"门禁在空转"）', () => {
  it('`renderer/` 下每个文件都被判过（扫描面不是空的 —— 空扫描面会恒真）', () => {
    const r = gate.analyzeArtifactBatch(ROOT, { skipAnchors: true });
    expect(r.seen.length).toBeGreaterThan(5);
    expect(r.dirs.map((d) => d.dir)).toContain('renderer');
  });

  it('真仓库的欠账册与现状一致（`node scripts/collateral-check.js` 为绿的机器侧证据）', () => {
    const r = gate.analyzeArtifactBatch(ROOT, { skipAnchors: true });
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
  });

  it('★ 判据不是"整目录一律放过"：真仓那 2 件在册之外，任何新文件都会被点名', () => {
    // 与上一条互补：册里只有 2 条，而扫描面有 20+ 个文件 ⇒ 覆盖率没有被豁免吃掉
    const r = gate.analyzeArtifactBatch(ROOT, { skipAnchors: true });
    expect(gate.ARTIFACT_BATCH_DEBT.length).toBeLessThan(r.seen.length);
  });
});
