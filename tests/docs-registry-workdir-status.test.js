/* ============================================================
 * tests/docs-registry-workdir-status.test.js — G8 第 ⑨ 条与第 ⑦ 条的**收紧**（2026-10-20）
 * ------------------------------------------------------------
 * 这两条判定以前是"规则宽、实现窄"的假守护，各有确切的实测形状：
 *
 *   · 第 ⑨ 条：规则说「`README.md` **声明状态**（在飞 / 已收口 / 已废弃）」，
 *     实现只判 `fs.existsSync(README.md)` ⇒ **任意空文件都能变绿**。
 *     实测：`.review/` 的受判直接子目录**全部**有 README ⇒ 全绿，而其中一批通篇不含状态词
 *     ⇒ "接手者能不能删"从来没被判过一次。（存量按 `B4` 进封闭欠账册，不一次全判红。）
 *   · 第 ⑦ 条：规则说「代码文件必须**登记**」，实现是 `arch.includes(文件名)` —— **全文子串**，
 *     一句散文（或**别人那一行的职责列**）提到名字就判已登记。
 *
 * 本文件的断言分三类（缺一类就会重演"结论对、根因错"）：
 *   1) **词表边界**：认哪些词、不认哪些词（`已完成` 是实测加进来的；`收口` 刻意不认）；
 *   2) **四个方向的判别力**：不在册无词 ⇒ 红 · 补词 ⇒ 绿 · 在册 ⇒ 放过且计数可见 ·
 *      **在册却已修好 ⇒ 红（修好忘销账）** · 在册但目录已被删 ⇒ 只报告不判红；
 *   3) **真实工程回归**：真仓现在零问题，且读数分母 > 0（防"扫了个空集却报 ✓"）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import checker from '../scripts/docs-registry-check.js';

const {
  checkWorkDirStatus, checkModuleCoverage, readmeStatusWords, registrationRows, nameHit,
  WORKDIR_STATUS_VOCAB, README_STATUS_DEBT, README_STATUS_DEBT_MAX, README_STATUS_DEBT_CLOSE
} = checker;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个假工程根（只放本用例关心的文件）。 */
function fakeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-workdir-status-'));
  Object.entries(files).forEach(([rel, body]) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  });
  return [root, () => fs.rmSync(root, { recursive: true, force: true })];
}

describe('G8 ⑨ · 词表边界（认哪些词、不认哪些词）', () => {
  it('词表 = 规则原文三词 + 实测的 `已完成`（不多不少，防止现场发明新词）', () => {
    expect(WORKDIR_STATUS_VOCAB).toEqual(['在飞', '已收口', '已废弃', '已完成']);
  });

  it('四个词各自都能被 `readmeStatusWords` 认出来', () => {
    for (const w of WORKDIR_STATUS_VOCAB) {
      expect(readmeStatusWords('# t\n状态：' + w + '\n')).toEqual([w]);
    }
  });

  it('**不认**近义写法：`收口` 是动词、`未收口` 是反向、`已落地`/`已交付` 让接手者靠猜', () => {
    // `收口` 单独出现不算 —— 75 个目录里有"全链收口"这类叙述，认它会把反向状态也读成正向
    expect(readmeStatusWords('# t\n全批收口\n')).toEqual([]);
    expect(readmeStatusWords('# t\n状态：未收口\n')).toEqual([]);
    expect(readmeStatusWords('# t\n状态：已落地\n')).toEqual([]);
    expect(readmeStatusWords('# t\n状态：已交付\n')).toEqual([]);
  });

  it('读不出 / 空内容 ⇒ 空数组（不是"默认通过"）', () => {
    expect(readmeStatusWords('')).toEqual([]);
    expect(readmeStatusWords(null)).toEqual([]);
  });
});

describe('G8 ⑨ · 四个方向的判别力（每个方向都必须动）', () => {
  const one = { debt: [], debtMax: 0 };   // 用例里显式注入空册：不受真仓那本册影响

  it('方向①：README 存在但**没有状态词** ⇒ 判红并点名那个目录', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-无词/README.md': '# t\n\n主题：x\n' });
    try {
      const { problems, stats } = checkWorkDirStatus(root, one);
      expect(problems.map((p) => p.kind)).toEqual(['workdir-status']);
      expect(problems[0].rel).toBe('.review/20260101-无词/');
      expect(stats.dirs).toBe(1);
      expect(stats.declared).toBe(0);
    } finally { clean(); }
  });

  it('方向②：同一份 README **补上状态词** ⇒ 绿（且计入 declared）', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-有词/README.md': '# t\n状态：在飞\n' });
    try {
      const { problems, stats } = checkWorkDirStatus(root, one);
      expect(problems).toEqual([]);
      expect(stats.declared).toBe(1);
    } finally { clean(); }
  });

  it('方向③：**在册**的存量 ⇒ 放过，但计数可见（`debt` 与 `debtTotal` 都要有读数）', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-存量/README.md': '# t\n（没有状态词）\n' });
    try {
      const { problems, stats } = checkWorkDirStatus(root,
        { debt: [{ dir: '20260101-存量', why: 'x' }], debtMax: 1 });
      expect(problems).toEqual([]);
      expect(stats.debt).toBe(1);
      expect(stats.debtTotal).toBe(1);
      expect(stats.debtMax).toBe(1);
    } finally { clean(); }
  });

  it('方向④：在册、但 README **已经声明了状态** ⇒ 判红（修好忘销账）', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-已修好/README.md': '# t\n状态：已收口\n' });
    try {
      const { problems, stats } = checkWorkDirStatus(root,
        { debt: [{ dir: '20260101-已修好', why: 'x' }], debtMax: 1 });
      expect(problems.map((p) => p.kind)).toEqual(['workdir-debt-stale']);
      expect(problems[0].rel).toBe('.review/20260101-已修好/');
      expect(stats.debtStale).toBe(1);
      expect(stats.debt).toBe(0);
      expect(problems[0].msg).toContain('忘销账');
      expect(README_STATUS_DEBT_CLOSE).toContain('删掉这个已废弃的目录');  // 销账动作要有出处
    } finally { clean(); }
  });

  it('方向⑤：在册、但**目录已被删**（删目录 = `.review/` 的合法结清）⇒ 只报告、不判红', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-还活着/README.md': '# t\n状态：在飞\n' });
    try {
      const { problems, stats } = checkWorkDirStatus(root,
        { debt: [{ dir: '20260101-早就删了', why: 'x' }], debtMax: 1 });
      expect(problems).toEqual([]);
      expect(stats.debtDangling).toEqual(['20260101-早就删了']);
    } finally { clean(); }
  });

  it('老红仍在：README 根本不存在 ⇒ `workdir`（这条没被新判据取代）', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-只有笔记/notes.md': '# 无 README\n' });
    try {
      const { problems } = checkWorkDirStatus(root, one);
      expect(problems.map((p) => p.kind)).toEqual(['workdir']);
    } finally { clean(); }
  });

  it('工具自建目录（`vision/`）仍然豁免、且计入 exempt 读数', () => {
    const [root, clean] = fakeRoot({ '.review/vision/.keep': '' });
    try {
      const { problems, stats } = checkWorkDirStatus(root, one);
      expect(problems).toEqual([]);
      expect(stats.exempt).toBe(1);
      expect(stats.dirs).toBe(0);
    } finally { clean(); }
  });

  it('欠账条数超上界 ⇒ 判红（加欠账 = 放宽判定，不许静默变多）', () => {
    const [root, clean] = fakeRoot({ '.review/20260101-a/README.md': '# t\n状态：在飞\n' });
    try {
      const { problems } = checkWorkDirStatus(root, {
        debt: [{ dir: 'a', why: 'x' }, { dir: 'b', why: 'x' }], debtMax: 1
      });
      expect(problems.some((p) => p.kind === 'workdir' && /超上界/.test(p.msg))).toBe(true);
    } finally { clean(); }
  });

  it('拿别的根跑时**不套用**真仓那本册（否则 fixture 里的同名目录会被当欠账放过）', () => {
    // 真册第一条的目录名 —— 若被误用，这个 fixture 目录就会被放过
    const first = README_STATUS_DEBT[0].dir;
    const [root, clean] = fakeRoot({ ['.review/' + first + '/README.md']: '# t\n（无状态词）\n' });
    try {
      const { problems } = checkWorkDirStatus(root);      // 不传 opts ⇒ 走生产册判断
      expect(problems.map((p) => p.kind)).toEqual(['workdir-status']);
    } finally { clean(); }
  });

  it('真册本身自洽：条数不超上界、每条都有 dir 与非空 why', () => {
    expect(README_STATUS_DEBT.length).toBeLessThanOrEqual(README_STATUS_DEBT_MAX);
    expect(README_STATUS_DEBT.length).toBeGreaterThan(0);
    for (const d of README_STATUS_DEBT) {
      expect(typeof d.dir).toBe('string');
      expect(d.dir.length).toBeGreaterThan(0);
      expect(typeof d.why).toBe('string');
      expect(d.why.length).toBeGreaterThan(0);
    }
    // 目录名不许重复（重复会让"还剩多少欠账"多算/少算）
    expect(new Set(README_STATUS_DEBT.map((d) => d.dir)).size).toBe(README_STATUS_DEBT.length);
  });
});

describe('G8 ⑦ · 入档判定只认**登记表的第一列**（不再全文子串匹配）', () => {
  const arch = (body) => '# 架构\n\n## 2.6 脚本层\n\n| 文件 | 职责 |\n|------|------|\n' + body + '\n';

  it('名字出现在**表格第一列** ⇒ 算入档', () => {
    const [root, clean] = fakeRoot({
      'docs/ARCHITECTURE.md': arch('| `known.js` | 已登记 |'),
      'scripts/known.js': '// ok'
    });
    try { expect(checkModuleCoverage(root)).toEqual([]); } finally { clean(); }
  });

  it('名字**只在散文里** ⇒ 判红（旧实现的假绿：`arch.includes` 会放过它）', () => {
    const [root, clean] = fakeRoot({
      'docs/ARCHITECTURE.md': '# 架构\n\n正文里提一句「消毒 `newthing.js`」就够了。\n\n'
        + '| 文件 | 职责 |\n|------|------|\n| `known.js` | 已登记 |\n',
      'scripts/known.js': '// ok',
      'scripts/newthing.js': '// 只在散文里被提到'
    });
    try {
      expect(checkModuleCoverage(root).map((p) => p.rel)).toEqual(['scripts/newthing.js']);
    } finally { clean(); }
  });

  it('名字只出现在**别人那一行的职责列** ⇒ 判红（"被别人的职责提了一嘴"与散文同型）', () => {
    const [root, clean] = fakeRoot({
      'docs/ARCHITECTURE.md': arch('| `known.js` | 职责里提到 `sneaky.js` 也算提过？不算 |'),
      'scripts/known.js': '// ok',
      'scripts/sneaky.js': '// 只被别人的职责列提到'
    });
    try {
      expect(checkModuleCoverage(root).map((p) => p.rel)).toEqual(['scripts/sneaky.js']);
    } finally { clean(); }
  });

  it('名字边界：`app.js` 不会被 `app.jsx` / `app.js.bak` 蒙过去', () => {
    expect(nameHit('| `app.js` | x |', 'app.js')).toBe(true);
    expect(nameHit('| `app.jsx` | x |', 'app.js')).toBe(false);
    expect(nameHit('| `app.js.bak` | x |', 'app.js')).toBe(false);
    expect(nameHit('| `my-app.js` | x |', 'app.js')).toBe(false);
    expect(nameHit('| `renderer/app.js` | x |', 'app.js')).toBe(true);   // 路径写法照样命中
  });

  it('`registrationRows` 跳过表头与分隔行，只留数据行的第一列', () => {
    const rows = registrationRows('| 文件 | 职责 |\n|------|------|\n| `a.js` | x |\n');
    expect(rows.map((r) => r.cell)).toEqual(['a.js']);
    expect(rows[0].line).toBe(3);
  });

  it('真实工程：`docs/ARCHITECTURE.md` 里真能解析出一批登记行（防"解析为空 ⇒ 全绿"）', () => {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const rows = registrationRows(md);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.some((r) => r.cell.indexOf('verify.js') >= 0)).toBe(true);
  });
});

describe('G8 ⑨/⑦ · 真实工程当前合规（回归守护：谁再放一个无状态工作目录就红）', () => {
  it('真仓零问题，且**分母看得见**（受判目录数 > 0、已声明数 > 0、在册欠账数与册子长度一致）', () => {
    const { problems, stats } = checkWorkDirStatus(ROOT);
    expect(problems, '真仓有工作目录没声明状态').toEqual([]);
    expect(stats.dirs).toBeGreaterThan(0);
    expect(stats.declared).toBeGreaterThan(0);
    expect(stats.debt + stats.debtStale).toBe(README_STATUS_DEBT.length - stats.debtDangling.length);
  });

  it('真仓代码入档零问题（收紧到"表格第一列"之后仍然零问题 ⇒ 该口径不造假红）', () => {
    expect(checkModuleCoverage(ROOT), '有代码文件没进架构文档的登记表行').toEqual([]);
  });
});
