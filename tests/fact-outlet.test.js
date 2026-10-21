/* ============================================================
 * tests/fact-outlet.test.js — 「真值出口唯一」（缺口 `G-09`）的契约 + **判别力**
 * 运行：npx vitest run tests/fact-outlet.test.js
 * ------------------------------------------------------------
 * 为什么这些用例长这样：
 *   ① 它守的那件事是「**同一事实只准有一个手抄副本**」——台账原话是"把真值出口统一到一处，
 *      避免**一句话里两个数**"。实机现场两处：`tests/cli-main.test.js` 曾把集成断言数写成早已漂了
 *      4 倍的旧值；`comnet` 的节点数 **889（`list --json` 含根）/ 888（不含根）** 同一个项目两个数。
 *   ② **先证明它会红**（`B4`）：下面每一条"该红"的用例都是把两个不同的数写进两份手写文档，
 *      再看判定是否点名 —— 而不是"读一遍源码觉得它应该能抓到"。
 *   ③ 顺带守住**不空转**：真仓库当前的读数必须是"零手抄副本 + 一条在册欠账"，
 *      哪天有人在文档里抄了一份数字，这条用例会先红（它比门禁更早跑）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const facts = require('../scripts/doc-facts.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* 夹具目录带 pid + 随机段（`E5`：并发跑不会互相删；收尾只清自己那一个）。 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fact-outlet-' + process.pid + '-'));
afterAll(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

let seq = 0;
/** 造一个扫描根：`files` = { 相对路径: 文本 }
 *  ⚠️ 默认补上**全部 `.md` 出口文件**（`docs/VERIFY.md` / `docs/TAGS.md` / `docs/ARCHITECTURE.md`）：
 *  少了任何一个，判定会如实报"出口不存在 ⇒ 采不到真值，红"（`A5`）—— 那不是要测的东西，别让它污染读数。
 *  （`docs/ARCHITECTURE.md` 是 2026-10-25 登记第 6 条事实族 `needs-disk` 之后才成为出口的；
 *   三个占位文件的内容**都不带数字**，免得给别的族造命中。） */
function fixture(files, opts) {
  const dir = path.join(HOME, 'f' + (++seq));
  const omit = (opts && opts.omit) || [];
  const all = Object.assign({
    'docs/VERIFY.md': OUTLET_VERIFY, 'docs/TAGS.md': '# 标签词表\n', 'docs/ARCHITECTURE.md': '# 架构\n'
  }, files);
  Object.entries(all).forEach(([rel, text]) => {
    if (omit.indexOf(rel) >= 0) return;
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const OUTLET_VERIFY = '# 验证基线\n\n| 事实 | 值 |\n|------|----|\n| 受管文档（登记表登记数） | 16 份 |\n';
const POINTER = '受管文档份数：以 `docs/VERIFY.md` 为准。\n';
const COPY_16 = '受管文档 16 份。\n';
const COPY_17 = '受管文档 17 份。\n';

describe('G-09 纯函数：一行里能取到哪些读数', () => {
  it('受管文档份数：两种自然语序都认（"N 份受管文档" / "受管文档 N 份"）', () => {
    const f = facts.FACT_OUTLETS.find((x) => x.id === 'managed-docs');
    expect(facts.factReadingsInLine(f, '共 16 份受管文档')).toEqual([16]);
    expect(facts.factReadingsInLine(f, '受管文档 16 份')).toEqual([16]);
  });

  it('口径类（`node-readings`）只认带读数字样的行 —— 否则"122 个节点"这类也会被算进来', () => {
    const f = facts.FACT_OUTLETS.find((x) => x.id === 'node-readings');
    expect(facts.factReadingsInLine(f, '`read --json` 对 889 个节点大概多大')).toEqual([889]);
    expect(facts.factReadingsInLine(f, '这本书里 889 个节点都打了标签')).toEqual([]);
  });

  it('标题行不参与（章节号不是事实声明，与 `parseClaims` 同口径）', () => {
    const f = facts.FACT_OUTLETS.find((x) => x.id === 'managed-docs');
    expect(facts.factReadingsInLine(f, '## 2. 受管文档 16 份')).toEqual([16]);  // 纯函数不看行首
    const r = facts.scanFactOutlets(fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': '## 受管文档 16 份\n' }));
    expect(r.problems.filter((p) => p.kind === 'fact-copy')).toEqual([]);
  });
});

describe('真值出口：判别力（每一处"该红"都是真注入，不是推理）', () => {
  it('★ 两份手写文档各写一个不同的数（16 / 17）⇒ 必红，并两个数逐处点名', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': COPY_16, 'SKILL.md': COPY_17 });
    const r = facts.scanFactOutlets(root);
    const two = r.problems.filter((p) => p.kind === 'fact-two-values');
    expect(two.length, JSON.stringify(r.problems)).toBe(1);
    expect(two[0].msg).toMatch(/16 @ README\.md/);
    expect(two[0].msg).toMatch(/17 @ SKILL\.md/);
  });

  it('只有一份手抄（不是"两个数"）也判红 —— 判据问的是"有没有第二份手抄"，不是"两个数一不一样"', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': COPY_16 });
    const r = facts.scanFactOutlets(root);
    expect(r.problems.some((p) => p.kind === 'fact-copy' && /README\.md:1/.test(p.msg))).toBe(true);
  });

  it('写成指针 ⇒ 绿（行内出现出口路径即算"推给权威"，不算手抄）', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': POINTER, 'SKILL.md': POINTER });
    expect(facts.scanFactOutlets(root).problems).toEqual([]);
  });

  it('同一份文档里出现两个数也算（"一句话里两个数"不限于跨文件）', () => {
    const root = fixture({ 'README.md': COPY_16 + COPY_17 });
    const r = facts.scanFactOutlets(root);
    const two = r.problems.filter((p) => p.kind === 'fact-two-values');
    expect(two.length, JSON.stringify(r.problems)).toBe(1);
    expect(two[0].msg).toMatch(/16 @ README\.md:1/);
    expect(two[0].msg).toMatch(/17 @ README\.md:2/);
  });

  it('出口文件自己不算副本（它就是权威）—— 同一句话在出口里写两遍不判红', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY + '受管文档份数 16 份。\n' });
    expect(facts.scanFactOutlets(root).problems).toEqual([]);
  });

  it('出口文件不存在 ⇒ 红（采不到真值 = 红，`A5`；不许读成"没有副本"）', () => {
    const root = fixture({ 'README.md': POINTER }, { omit: ['docs/VERIFY.md'] });
    const r = facts.scanFactOutlets(root);
    expect(r.problems.some((p) => /出口 .* 不存在/.test(p.msg))).toBe(true);
  });
});

describe('真值出口：封闭欠账册的三条机械判定', () => {
  const DEBT = [{ rel: 'README.md', fact: 'managed-docs', value: 16, why: 'w', close: 'c' }];

  it('在册 ⇒ 放过，并计入"在册欠账"（不判红）', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': COPY_16 });
    const r = facts.scanFactOutlets(root, { debt: DEBT });
    expect(r.problems).toEqual([]);
    expect(r.facts.find((x) => x.fact === 'managed-docs').debt).toBe(1);
  });

  it('★ 修好忘销账 ⇒ 红（不能靠"把册留着"永远绿）', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': POINTER });
    const r = facts.scanFactOutlets(root, { debt: DEBT });
    expect(r.problems.some((p) => /修好（请同批销账）|请同批销账/.test(p.msg))).toBe(true);
  });

  it('★ 册上那条的文件已不存在 ⇒ 红（悬挂登记）', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY });
    const r = facts.scanFactOutlets(root, { debt: DEBT });
    expect(r.problems.some((p) => /悬挂登记/.test(p.msg))).toBe(true);
  });

  it('⚠️ 换了扫描根就**不拿真仓那本册去核**（否则证明过程自己造假红）', () => {
    const root = fixture({ 'docs/VERIFY.md': OUTLET_VERIFY, 'README.md': COPY_16 });
    // 不传 debt ⇒ 夹具根下不核真仓的册
    expect(facts.scanFactOutlets(root).problems.some((p) => /悬挂登记|请同批销账/.test(p.msg))).toBe(false);
  });
});

describe('真值出口：真仓库当前读数（防"门禁在空转"）', () => {
  it('每条被声明的事实都要**有出口**，且事实表本身不含重复 id', () => {
    const ids = facts.FACT_OUTLETS.map((f) => f.id);
    expect([...new Set(ids)].sort()).toEqual(ids.slice().sort());
    facts.FACT_OUTLETS.forEach((f) => expect(String(f.outlet || '').length, f.id).toBeGreaterThan(0));
  });

  it('真仓库：没有任何未在册的手抄副本（`node scripts/doc-facts.js --check` 为绿的机器侧证据）', () => {
    const r = facts.scanFactOutlets(ROOT);
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
  });

  it('★ 判别力不空转：真仓库里**确实有命中**（指针或副本都算）—— 一条都没命中说明判据在空转', () => {
    const r = facts.scanFactOutlets(ROOT);
    const total = r.facts.reduce((n, f) => n + f.hits.length, 0);
    expect(total, '真仓库一条命中都没有 ⇒ 判据的识别面可能已经失效（`B4` ④）').toBeGreaterThan(0);
  });
});
