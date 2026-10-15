/* ============================================================
 * tests/rules-consistency.test.js — G9「规则文件自洽」的判别力锁
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么门禁还要配测试：G9 守的是 `docs/RULES.md` 自己。若 G9 的实现有 bug，
 * 它会**永远通过** —— 而"规则文件看起来没问题"正是它要防的那种假象。
 * 这与 `tests/docs-registry.test.js` 对 G8 做的是同一件事（范式照抄）。
 *
 * 本文件做两件事：
 *   ① 逐条**注入违规**，确认每条判定真的会红（证明判别力，而不是"永远通过"）；
 *   ② 断言**真实的 `docs/RULES.md` 当前零问题** —— 这样谁把规则文件改崩了，
 *      `npm test` 会先红，不必等到 verify 链跑到第 3 步。
 *
 * 特别锁住一个**我自己犯过的错**：第一版把"全部 ID 行一起比相邻行号"，
 * 于是 §2 的 G 表与 §3 的 R 表之间正常的章节间隔被报成"表格被打断"（2 处假红）。
 * 正确做法是**按章节分组**后再比。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rc = require('../scripts/rules-consistency.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 拼一份假的 RULES.md（行数组 → 文本） */
const md = (...lines) => lines.join('\n') + '\n';

describe('G9 判定一：声明条数 == 表格行数', () => {
  it('不符 → 报「条数不符」', () => {
    const src = md(
      '## 3. 铁律（共 5 条）', '',
      '| ID | 铁律 |', '|----|------|',
      '| **R1** | a |', '| **R2** | b |', '| **R3** | c |'
    );
    const p = rc.analyze(src, {}).filter((x) => x.kind === 'count');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('共 5 条');
    expect(p[0].msg).toContain('表格实际 3 行');
  });

  it('相符 → 不报', () => {
    const src = md(
      '## 3. 铁律（共 3 条）', '',
      '| ID | 铁律 |', '|----|------|',
      '| **R1** | a |', '| **R2** | b |', '| **R3** | c |'
    );
    expect(rc.analyze(src, {}).filter((x) => x.kind === 'count')).toEqual([]);
  });

  it('声明了条数却没有表 → 报', () => {
    const src = md('## 3. 铁律（共 3 条）', '', '本段没有表格。');
    expect(rc.analyze(src, {}).filter((x) => x.kind === 'count').length).toBe(1);
  });
});

describe('G9 判定二：表格结构（ID 行必须留在表内）', () => {
  it('被引用块打断 → 报，并点名掉出去的那一行', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 |', '|----|------|',
      '| **G1** | a |', '| **G2** | b |',
      '',
      '> 插进表格中间的旁注（markdown 表格一断即结束）',
      '| **G3** | c |'
    );
    const t = rc.analyze(src, {}).filter((x) => x.kind === 'table');
    expect(t.length).toBe(1);
    expect(t[0].msg).toContain('G2');
    expect(t[0].msg).toContain('G3');
    expect(t[0].msg).toContain('引用块');
  });

  it('被空行打断 → 报，并说明是空行', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 |', '|----|------|',
      '| **G1** | a |',
      '',
      '| **G2** | b |'
    );
    const t = rc.analyze(src, {}).filter((x) => x.kind === 'table');
    expect(t.length).toBe(1);
    expect(t[0].msg).toContain('空行');
  });

  it('连续 → 不报', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 |', '|----|------|',
      '| **G1** | a |', '| **G2** | b |', '| **G3** | c |'
    );
    expect(rc.analyze(src, {}).filter((x) => x.kind === 'table')).toEqual([]);
  });

  it('缺表头 → 报「表头」', () => {
    const src = md('## 2. 门禁', '', '| **G1** | a |', '| **G2** | b |');
    const t = rc.analyze(src, {}).filter((x) => x.kind === 'table');
    expect(t.length).toBe(1);
    expect(t[0].msg).toContain('表头');
  });

  it('**跨章节的两张表不算被打断**（这是第一版的真实误报，必须锁住）', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 |', '|----|------|', '| **G1** | a |',
      '',
      '> 章节之间的正常说明',
      '',
      '## 3. 铁律', '',
      '| ID | 铁律 |', '|----|------|', '| **R1** | b |'
    );
    expect(rc.analyze(src, {}).filter((x) => x.kind === 'table')).toEqual([]);
  });
});

describe('G9 判定三：编号引用闭合', () => {
  const base = md('## 2. 门禁', '', '| ID | 门禁 |', '|----|------|', '| **G1** | a |');

  it('引用了未定义的编号 → 报「悬挂引用」并指出文件与行号', () => {
    const p = rc.analyze(base, { 'some.md': '第一行\n见 G9 与 G1\n' })
      .filter((x) => x.kind === 'ref');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('G9');
    expect(p[0].rel).toBe('some.md:2');
  });

  it('已定义的编号不报', () => {
    const p = rc.analyze(base, { 'some.md': '见 G1\n' }).filter((x) => x.kind === 'ref');
    expect(p).toEqual([]);
  });

  it('引用收集：能抓 `**G8**` 与 `` `G5` `` 这两种本工程最常用的写法', () => {
    expect([...rc.collectReferences('**G8** 与 `G5`').keys()].sort()).toEqual(['G5', 'G8']);
  });

  it('引用收集：不误抓 Group2 / R2D2 / IMG1 这类普通词', () => {
    expect([...rc.collectReferences('Group2 R2D2 IMG1').keys()]).toEqual([]);
  });

  it('引用收集：R3a 这种带后缀的能识别', () => {
    expect([...rc.collectReferences('见 R3a 与 R5').keys()].sort()).toEqual(['R3a', 'R5']);
  });
});

describe('G9 判定四：实现列点名的脚本必须存在', () => {
  it('点名了不存在的脚本 → 报「实现缺失」', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 | 实现 |', '|----|------|------|',
      '| **G1** | a | `scripts/绝不存在的脚本.js` |'
    );
    const p = rc.analyze(src, {}).filter((x) => x.kind === 'impl');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('绝不存在的脚本.js');
  });

  it('点名了真实存在的脚本 → 不报', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 | 实现 |', '|----|------|------|',
      '| **G1** | a | `scripts/encoding-check.js` |'
    );
    expect(rc.analyze(src, {}).filter((x) => x.kind === 'impl')).toEqual([]);
  });

  it('通配写法（含 *）跳过，不当成路径', () => {
    const src = md(
      '## 2. 门禁', '',
      '| ID | 门禁 | 实现 |', '|----|------|------|',
      '| **G1** | a | `scripts/smoke/NN-*.js` |'
    );
    expect(rc.analyze(src, {}).filter((x) => x.kind === 'impl')).toEqual([]);
  });
});

/* ============================================================
 * G9 判定六：门禁声明的「（N 条判定）」== 实现脚本里 ①…⑳ 标记的去重个数
 * ------------------------------------------------------------
 * 真实事故（本工程自己犯的）：某门禁加到第 13 条判定时只更新了架构文档一处，于是
 * **同一个门禁的条数在四个地方四种说法**（规则文件 12 且只列 11 项 / 架构文档 13 /
 * 脚本头注释"三条" / 代码 13）。而旧的「转述条数」判定要求「共 N 条」字样，**抓不到它**。
 * ============================================================ */
describe('G9 判定六：门禁声明的判定条数必须与实现脚本的标记数一致', () => {
  const withMarks = (n) => {
    const marks = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬'.slice(0, n);
    return ['function checkRegistry() {', ...marks.split('').map((m) => '  // ' + m + ' 某条判定'), '}'].join('\n');
  };
  /* 【2026-10-16 修一条既有并发假红】探针**落点**重新定过（唯一实现）：
   *  原先写进 `scripts/`，而 `tests/w8-dry-run.test.js` 的 D4、`tests/heat-{bars,sensor}.test.js`、
   *  `tests/changed-plan.test.js` 都会**遍历树并逐个 readFileSync**；vitest 又并行跑测试文件
   *  ⇒ 它们会"列到刚写好的探针、读时已被这里的 finally 删掉" ⇒ `ENOENT … scripts/.probe-*.js`
   *  （**实测**：全链第 9 步 G3 连红两次，两次撞的文件不同，而两边代码都没错）。
   *  新落点 = `.review/` 下的**散落文件**：那些 walker 都不扫它；G8 对 `.review/` 的散落文件
   *  **豁免**（只有子目录才要求 README）⇒ 万一崩了留残也不会造新红；名字带进程号 ⇒ 并发不互踩 ✓。 */
  const probePath = (name) => '.review/.probe-' + process.pid + '-' + name;
  const fakeScript = (rel, body) => {
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  };
  const cleanup = (rel) => { try { fs.unlinkSync(path.join(ROOT, rel)); } catch (e) { /* 忽略 */ } };
  const gateRow = (declared, impl) => md(
    '## 2. 门禁', '',
    '| ID | 门禁 | 防的损害 | 实现 | 挂载点 |', '|----|------|---------|------|--------|',
    '| **G8** | 文档体系完整性（' + declared + ' 条判定） | 防漂移 | `' + impl + '` | verify |'
  );

  it('声明 12 条、实现只有 11 个标记 → 报「判定条数不符」', () => {
    fakeScript(probePath("marks-11.js"), withMarks(11));
    try {
      const p = rc.analyze(gateRow(12, probePath("marks-11.js")), {}).filter((x) => x.kind === 'gate-count');
      expect(p.length).toBe(1);
      expect(p[0].msg).toContain('声明「12 条判定」');
      expect(p[0].msg).toContain('实际有 11 条');
    } finally { cleanup(probePath("marks-11.js")); }
  });

  it('声明与实现一致 → 不报', () => {
    fakeScript(probePath("marks-3.js"), withMarks(3));
    try {
      expect(rc.analyze(gateRow(3, probePath("marks-3.js")), {}).filter((x) => x.kind === 'gate-count')).toEqual([]);
    } finally { cleanup(probePath("marks-3.js")); }
  });

  it('标记重复（① 用了两次）→ 报「判定标记重复」（否则"数一遍"会得到偏大的数）', () => {
    fakeScript(probePath("marks-dup.js"), '// ① 甲\n// ② 乙\n// ① 丙\n');
    try {
      const p = rc.analyze(gateRow(2, probePath("marks-dup.js")), {}).filter((x) => x.kind === 'gate-count');
      expect(p.some((x) => /判定标记重复/.test(x.msg))).toBe(true);
    } finally { cleanup(probePath("marks-dup.js")); }
  });

  it('测试文件不算"实现"（`tests/*.test.js` 里没有标记，纳入会误报）', () => {
    fakeScript(probePath("marks-2.js"), withMarks(2));
    try {
      const row = md(
        '## 2. 门禁', '',
        '| ID | 门禁 | 防的损害 | 实现 | 挂载点 |', '|----|------|---------|------|--------|',
        `| **G8** | 文档体系完整性（2 条判定） | 防漂移 | \`${probePath('marks-2.js')}\`（+ \`tests/docs-registry.test.js\` 锁判别力） | verify |`
      );
      expect(rc.analyze(row, {}).filter((x) => x.kind === 'gate-count')).toEqual([]);
    } finally { cleanup(probePath("marks-2.js")); }
  });

  it('没写「（N 条判定）」的门禁行不判（本判定只对齐声明的条数）', () => {
    const row = md(
      '## 2. 门禁', '',
      '| ID | 门禁 | 防的损害 | 实现 | 挂载点 |', '|----|------|---------|------|--------|',
      '| **G1** | 编码完整性 | 乱码 | `scripts/encoding-check.js` | verify |'
    );
    expect(rc.analyze(row, {}).filter((x) => x.kind === 'gate-count')).toEqual([]);
  });

  it('真实工程：G8 的声明条数与实现标记数一致（回归守护）', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'docs', 'RULES.md'), 'utf8');
    const docTexts = { 'docs/ARCHITECTURE.md': fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8') };
    expect(rc.analyze(rules, docTexts).filter((x) => x.kind === 'gate-count')).toEqual([]);
  });

  it('**声明写成加粗也必须被识别**（旧正则静默失配过一次，整个计数比对被悄悄停用）', () => {
    fakeScript(probePath("marks-bold.js"), withMarks(2));
    try {
      const boldRow = md(
        '## 2. 门禁', '',
        '| ID | 门禁 | 防的损害 | 实现 | 挂载点 |', '|----|------|---------|------|--------|',
        `| **G8** | 文档体系完整性（**3 条判定**，分五类） | 防漂移 | \`${probePath('marks-bold.js')}\` | verify |`
      );
      const p = rc.analyze(boldRow, {}).filter((x) => x.kind === 'gate-count');
      expect(p.length).toBe(1);                       // 声明 3、实际 2 ⇒ 必须报（若正则失配则 0 条，静默通过）
      expect(p[0].msg).toContain('声明「3 条判定」');
    } finally { cleanup(probePath("marks-bold.js")); }
  });

  it('实现脚本的注释里写死条数 → 报（第二轮的形状：门禁自己的头注释就写死过）', () => {
    fakeScript(probePath("comment-count.js"), '// 本脚本共 5 条判定（写在注释里）\n// ① 甲\n// ② 乙\n');
    try {
      const p = rc.analyze(gateRow(2, probePath("comment-count.js")), {}).filter((x) => x.kind === 'gate-count');
      expect(p.some((x) => /写死了判定条数/.test(x.msg))).toBe(true);
    } finally { cleanup(probePath("comment-count.js")); }
  });

  it('"加一条判定"这类汉语动宾搭配不算条数声明（不误报）', () => {
    fakeScript(probePath("addone.js"), '// ① 甲\n// ② 乙（将来可能加一条判定）\n');
    try {
      const p = rc.analyze(gateRow(2, probePath("addone.js")), {}).filter((x) => x.kind === 'gate-count');
      expect(p).toEqual([]);
    } finally { cleanup(probePath("addone.js")); }
  });

  it('续写标记用「（承 ⑥）」不会被算成重复标记（`⑥b` 会被算成第二个 ⑥）', () => {
    fakeScript(probePath("cont.js"), '// ① 甲\n// ② 乙\n// （承 ②）乙的第二个分支\n');
    try {
      const p = rc.analyze(gateRow(2, probePath("cont.js")), {}).filter((x) => x.kind === 'gate-count');
      expect(p).toEqual([]);
    } finally { cleanup(probePath("cont.js")); }
  });
});

describe('G9 判定五：其他文档转述的条数必须与实际一致', () => {
  // 2 个门禁 + 1 条铁律
  const base = md(
    '## 2. 门禁', '', '| ID | 门禁 |', '|----|------|', '| **G1** | a |', '| **G2** | b |',
    '', '## 3. 铁律', '', '| ID | 铁律 |', '|----|------|', '| **R1** | x |', ''
  );

  it('转述条数不符 → 报「转述条数」，并给出文件与行号', () => {
    const p = rc.analyze(base, { 'OTHER.md': '门禁（自动强制，共 5 条）\n' })
      .filter((x) => x.kind === 'restate');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('共 5 条');
    expect(p[0].msg).toContain('实际有 2 条');
    expect(p[0].rel).toBe('OTHER.md:1');
  });

  it('转述的条数正确 → 不报', () => {
    const p = rc.analyze(base, { 'OTHER.md': '铁律（无法机械化，共 1 条；详见 §3）\n' })
      .filter((x) => x.kind === 'restate');
    expect(p).toEqual([]);
  });

  it('RULES.md 自己的声明不在这里重复报（交给判定一，避免一问题两报）', () => {
    const p = rc.analyze(base, { [rc.RULES]: '铁律（共 99 条）\n' })
      .filter((x) => x.kind === 'restate');
    expect(p).toEqual([]);
  });

  it('**真实缺陷复刻**：README §九 曾写「铁律…共 5 条」而实际 6 条', () => {
    const six = md(
      '## 3. 铁律', '', '| ID | 铁律 |', '|----|------|',
      '| **R1** | a |', '| **R2** | b |', '| **R3** | c |',
      '| **R3a** | d |', '| **R4** | e |', '| **R5** | f |', ''
    );
    const p = rc.analyze(six, { 'README.md': '**铁律（无法机械化，共 5 条；详见 `docs/RULES.md` §3）**\n' })
      .filter((x) => x.kind === 'restate');
    expect(p.length).toBe(1);
    expect(p[0].msg).toContain('实际有 6 条');
  });
});

describe('G9 对真实工程：docs/RULES.md 当前必须零问题', () => {
  it('真实 docs/RULES.md + 全部被扫描文档 → 零问题', () => {
    const rulesText = fs.readFileSync(path.join(ROOT, rc.RULES), 'utf8');
    const docs = {};
    for (const rel of rc.SCAN_DOCS) {
      const p = path.join(ROOT, rel);
      if (fs.existsSync(p)) docs[rel] = fs.readFileSync(p, 'utf8');
    }
    // 失败信息要能直接指出是哪条判定、哪个文件、哪一行
    const problems = rc.analyze(rulesText, docs);
    expect(problems.map((p) => '[' + p.kind + '] ' + p.rel + ' ' + p.msg)).toEqual([]);
  });

  it('真实 RULES.md 解析出 9 个门禁 / 6 条铁律 / 4 条元规则', () => {
    const lines = fs.readFileSync(path.join(ROOT, rc.RULES), 'utf8').split('\n');
    const ids = rc.findIdRows(lines).map((r) => r.id);
    expect(ids.filter((i) => i[0] === 'G')).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9']);
    expect(ids.filter((i) => i[0] === 'R')).toEqual(['R1', 'R2', 'R3', 'R3a', 'R4', 'R5']);
    expect(ids.filter((i) => i[0] === 'M')).toEqual(['M1', 'M2', 'M3', 'M4']);
  });

  it('真实 RULES.md 里声明的条数与表格行数一致（§3 曾写 5 条、表却有 6 行）', () => {
    const lines = fs.readFileSync(path.join(ROOT, rc.RULES), 'utf8').split('\n');
    for (const c of rc.parseCountClaims(lines)) {
      const t = rc.firstTableAfter(lines, c.line);
      expect(t, '§' + c.section + ' 声明了条数却找不到表').toBeTruthy();
      expect(t.rows, '§' + c.section).toBe(c.claimed);
    }
  });
});
