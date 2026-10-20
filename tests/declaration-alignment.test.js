/* ============================================================
 * tests/declaration-alignment.test.js
 * ------------------------------------------------------------
 * 锁住本批（`.review/20261020-声明对齐/`）补的两个「声明与实现对不上」的洞：
 *
 *   ① `docs/RULES.md` §4（约定与架构决策）**没有任何条数声明** ⇒ `G9` 对它**一无所知**：
 *      删掉表里一行、甚至删掉整节，`G9` 照样 exit 0。实测基线见
 *      `.review/20261020-声明对齐/proof-rules4.log`（实验 A/B/C）。
 *   ② `scripts/doc-facts.js` 的六类事实里**没有「预算」** ⇒ `SKILL.md` 曾写「总预算 700s」
 *      而真值 `TOTAL_BUDGET_MS` 是 1770s（差 2.5 倍、涨了四轮没人发现），**没有任何门禁守它**。
 *
 * 这里只测**纯函数**（不读临时目录、不写盘 —— 照 `tests/_tmp-cleanup.js` 的纪律：
 * 测试本身不许留副作用；`.review/` 探针的 `%TEMP%` 残留事故就是这么来的）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const rc = require('../scripts/rules-consistency.js');
const df = require('../scripts/doc-facts.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 拼一段合成规则文本（每行一个参数，末尾统一换行） */
const md = (...lines) => lines.join('\n') + '\n';

/* ---------------- ① §4 的条数声明（G9 判定 ① 的「承」） ---------------- */
describe('G9 判定 ① 之「承」：必须声明条数的章节（§4 约定与架构决策）', () => {
  const HEAD_NO_CLAIM = '## 4. 约定与架构决策（低损害或一次性决策，**不是**铁律）';
  const HEAD_CLAIM = '## 4. 约定与架构决策（共 2 条 —— 低损害或一次性决策，**不是**铁律）';
  const TABLE = ['| 事项 | 性质 | 正确的家 |', '|------|------|---------|',
    '| 甲 | 约定 | `docs/AI-GUIDE.md` |', '| 乙 | 约定 | `docs/AI-GUIDE.md` |'];

  it('章节在、但标题里**没有**「共 N 条」⇒ 判红（删掉声明 = 静默关掉判定 ①）', () => {
    const p = rc.analyze(md(HEAD_NO_CLAIM, '', ...TABLE), {}).filter((x) => x.kind === 'count');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('没有');
    expect(p[0].msg).toContain('判定 ①');
    expect(p[0].rel).toBe(rc.RULES + ':1');
  });

  it('章节在、声明 == 表格行数 ⇒ 不判红', () => {
    const p = rc.analyze(md(HEAD_CLAIM, '', ...TABLE), {}).filter((x) => x.kind === 'count');
    expect(p).toEqual([]);
  });

  it('章节在、声明与表格行数**不符** ⇒ 判红（声明 2 条、表 1 行）', () => {
    const oneRow = ['| 事项 | 性质 | 正确的家 |', '|------|------|---------|', '| 甲 | 约定 | `docs/AI-GUIDE.md` |'];
    const p = rc.analyze(md(HEAD_CLAIM, '', ...oneRow), {}).filter((x) => x.kind === 'count');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('共 2 条');
    expect(p[0].msg).toContain('实际 1 行');
  });

  it('章节**不在**这段文本里 ⇒ 此处不判红（单测只喂片段；"章节消失"由 main() 的真门禁判红）', () => {
    const p = rc.analyze(md('## 3. 铁律（共 3 条）', '', '| **R1** | 甲 |',
      '| **R2** | 乙 |', '| **R3** | 丙 |'), {}).filter((x) => x.kind === 'count');
    expect(p).toEqual([]);
  });

  it('真实 `docs/RULES.md`：§4 有「共 N 条」声明，且 N == 该节表格数据行数', () => {
    const lines = fs.readFileSync(path.join(ROOT, rc.RULES), 'utf8').split('\n');
    const sec = rc.COUNT_REQUIRED_SECTIONS[0];
    const idx = lines.findIndex((l) => sec.re.test(l));
    expect(idx, '§4 的标题（含「约定与架构决策」）在真实 RULES.md 里找不到').toBeGreaterThan(-1);
    const claim = rc.parseCountClaims(lines).find((c) => c.line === idx + 1);
    expect(claim, '§4 标题里没有「共 N 条」声明 —— 本批就是为了把这条声明补上').toBeTruthy();
    expect(claim.claimed).toBe(rc.firstTableAfter(lines, claim.line).rows);
  });
});

/* ---------------- ② 验证链「总预算」的手写数字（G6 第七类） ---------------- */
describe('G6 第七类：验证链「总预算」的手写数字必须等于 `TOTAL_BUDGET_MS`', () => {
  const TRUE_SEC = 1770;                      // = scripts/verify.js 的 TOTAL_BUDGET_MS / 1000

  it('认「总预算 N s」与「N 秒预算」两个方向，并归一化成秒（ms / 分钟）', () => {
    expect(df.budgetReadingsInLine('验证链**总预算 700s**（错的数）')).toEqual([700]);
    expect(df.budgetReadingsInLine('验证链 700 秒总预算（错数）')).toEqual([700]);
    expect(df.budgetReadingsInLine('总预算 1770000ms')).toEqual([TRUE_SEC]);
    expect(df.budgetReadingsInLine('合计预算 29.5 分钟')).toEqual([TRUE_SEC]);
  });

  it('不认：指针形态（没有数字）、单项预算（G5 那一格的止涨线）、标题行', () => {
    expect(df.budgetReadingsInLine('总预算以 `scripts/verify.js` 的 `TOTAL_BUDGET_MS` 为准')).toEqual([]);
    expect(df.budgetReadingsInLine('| 14 | G5 | `npm run smoke` | 1300s | 渲染层；耗时预算是止涨线 |')).toEqual([]);
    expect(df.scanBudgetText('# 总预算 700s 标题行不判', TRUE_SEC)).toEqual([]);
  });

  it('三态：值 == 真值 ⇒ pass；值错且无历史锚 ⇒ red；值错但写明「曾/当时/快照」⇒ history', () => {
    expect(df.budgetVerdict([TRUE_SEC], false, TRUE_SEC)).toBe('pass');
    expect(df.budgetVerdict([700], false, TRUE_SEC)).toBe('red');
    expect(df.budgetVerdict([700], true, TRUE_SEC)).toBe('history');
  });

  it('**判别力**：注入一行错的预算 ⇒ red；同一行写成历史锚 ⇒ 放行（"当时是多少"不是现状声明）', () => {
    const bad = df.scanBudgetText('README 里写：验证链总预算 700s。', TRUE_SEC, 'README.md');
    expect(bad.length).toBe(1);
    expect(bad[0].verdict).toBe('red');
    expect(bad[0].rel).toBe('README.md');

    const hist = df.scanBudgetText('2026-10-20 实测：这里曾写「总预算 700s」，真值早已是 1770s。', TRUE_SEC, 'SKILL.md');
    expect(hist.length).toBe(1);
    expect(hist[0].verdict).toBe('history');
  });

  it('同一行**既有指针又有旧数字**仍判红（"指过去了"不等于数是对的 —— 这一档最会腐）', () => {
    const r = df.scanBudgetText('总预算 700s（真值以 `scripts/verify.js` 的 `TOTAL_BUDGET_MS` 为准）', TRUE_SEC);
    expect(r.length).toBe(1);
    expect(r[0].verdict).toBe('red');
  });

  it('真实仓库：受管文档里**没有**一处与真值不符的总预算读数（红线为 0）', () => {
    const scan = df.scanBudgetClaims();
    expect(scan.wantSec).toBe(TRUE_SEC);
    expect(scan.reds.map((h) => h.rel + ':' + h.line + ' = ' + h.secs.join('/') + 's')).toEqual([]);
  });
});

/* ---------------- ③ `%TEMP%/mm-*` 残留：**只报告，不判红** ---------------- */
describe('报告型读数：`%TEMP%/mm-*` 残留（`tempResidueReport` 只在给定根上数，不删、不判红）', () => {
  /* 用工程自己的 `makeTmp` / `cleanupAll`（`tests/_tmp-cleanup.js`）—— 本文件**不许**自己 mkdtemp：
   * "创建即登记" 只认那一个入口（那条纪律的来源见 `tests/_tmp-cleanup.js` 头注释）。 */
  const tmp = makeTmp('mm-decl-align-test-');
  afterAll(cleanupAll);

  it('数得清：只认 `mm-` 前缀、能分开目录与单一文件、能按家族分组', () => {
    fs.mkdirSync(path.join(tmp, 'mm-alpha-1'));
    fs.writeFileSync(path.join(tmp, 'mm-alpha-1', 'x.txt'), 'abc');        // 3 字节
    fs.writeFileSync(path.join(tmp, 'mm-beta.json'), 'defgh');             // 5 字节
    fs.writeFileSync(path.join(tmp, 'not-ours.txt'), 'zzzzzzzzzz');        // 不认（前缀不符）
    const r = df.tempResidueReport({ root: tmp });
    expect(r.error).toBe(null);
    expect(r.entries.map((e) => e.name).sort()).toEqual(['mm-alpha-1', 'mm-beta.json']);
    expect(r.totalBytes).toBe(8);
    expect(r.entries.find((e) => e.name === 'mm-alpha-1').isDir).toBe(true);
    expect(r.entries.find((e) => e.name === 'mm-beta.json').isDir).toBe(false);
    expect(r.byPrefix.map((g) => g.family).sort()).toEqual(['mm-alpha-', 'mm-beta.json-']);
  });

  it('"超过 24 小时"按 mtime 与传入的 now 算（不判红、也不删任何东西）', () => {
    const r0 = df.tempResidueReport({ root: tmp });
    expect(r0.oldCount).toBe(0);                                            // 刚建的 ⇒ 不算旧
    const later = Date.now() + 25 * 3600 * 1000;
    const r1 = df.tempResidueReport({ root: tmp, now: later });
    expect(r1.oldCount).toBe(2);
    // 关键：**它没有删掉任何东西**（报告型读数不许有副作用）
    expect(fs.existsSync(path.join(tmp, 'mm-beta.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'mm-alpha-1'))).toBe(true);
  });

  it('读不到的根 ⇒ 返回 error 而不是抛异常（报告型读数不许把门禁搞崩）', () => {
    const r = df.tempResidueReport({ root: path.join(tmp, 'no-such-dir') });
    expect(r.error).toBeTruthy();
    expect(r.totalCount).toBe(0);
  });
});
