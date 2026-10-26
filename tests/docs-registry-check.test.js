/* ============================================================
 * tests/docs-registry-check.test.js — G8 判定⑪「数据契约必须覆盖 schema 字段」的**判据本体**
 * ------------------------------------------------------------
 * 为什么必须新建这个文件（它此前**不存在**）：那条判定的老判法是
 *   `new RegExp('\\b' + leaf + '\\b').test(整份 docs/DATA-FORMAT.md)`
 * 即「**这个词**在文档里出现过」，而报文说的是「**契约缺字段**」—— 这两件事不是一回事。
 * 实测（父代理真跑）：删掉契约表里 `| meta.author |` 或 `| background |` 的**整行**，`G8` 仍 exit 0，
 * 因为这两个词还在 JSON 示例里出现。⇒ 判据在空转，而且**只靠跑一遍门禁看不出来**（它永远绿）。
 *
 * 所以本文件的断言分四类（缺任何一类都证明不了修好了）：
 *   1) **红的方向**：表行删掉 ⇒ 必须红，且报文点名"哪一处没有"（`DATA-FORMAT` / `ITEM-MODEL`）；
 *   2) **绿的方向**：只改同一行的**措辞**（字段名不动）⇒ 必须绿（防"改个文案就红"的误伤）；
 *   3) **★旧判据骗得过、新判据骗不过的那一种注入**：在 JSON 示例里再写一句含该字段的注释 ⇒ **仍绿；
 *      可一旦把表行删掉（同一次注入里两件事都做）⇒ 必须红** —— 这一条是本文件的核心；
 *   4) **真实工程回归**：真仓 24 条全绿且读数分母 = 24（22 表行 + 1 ITEM-MODEL 表行 + 1 prose），
 *      并且**用真文档做内存内注入**（不写盘）验证红/绿两侧 —— 注入的对象是禁改文档，故只在内存里切。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import checker from '../scripts/docs-registry-check.js';

const {
  judgeContractCoverage, contractTableCells, normContractCell,
  SCHEMA_FIELDS, PROSE_EXEMPT, PROSE_EXEMPT_MAX,
  CONTRACT_WHERE_KINDS, checkContractCoverage
} = checker;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一份"契约表 + JSON 示例"的假 DATA-FORMAT（形状照真文档：表行三列、示例在别的段落）。 */
function fakeDataFormat(rows, exampleLines) {
  return [
    '# 假数据格式',
    '',
    '## 1. 项目级字段',
    '',
    '| 字段 | 校验 | 说明 |',
    '|------|------|------|'
  ].concat(rows, ['', '## 2. 示例', '', '```json', '{']
    .concat(exampleLines || [], ['}', '```', ''])).join('\n');
}

/** 一份假 ITEM-MODEL（形状照 §7：第一列写 `items[]`）。 */
function fakeItemModel(rows) {
  return ['## 7. 与既有字段的边界（终态）', '', '| 字段 | 终态定位 | 冻结点 |', '|------|---------|--------|']
    .concat(rows, ['']).join('\n');
}

const dfRows = [
  '| `meta.name` | ✓ | 项目名 |',
  '| `background` | - | 节点底色（**本行可以被删掉**） |',
  '| `qa` | - | 问答记录 |'
];
const dfExample = ['  "meta": { "name": "演示" },', '  "background": "#f5f5f5",', '  "qa": []'];

describe('G8 ⑪ · 表行判据：红的方向（旧判据在这儿空转）', () => {
  it('删掉 `| background |` 整行，但 JSON 示例里还有 `background` ⇒ **必须红**，并点名"契约表里没有"', () => {
    const df = fakeDataFormat(dfRows.filter((r) => !r.includes('background')), dfExample);
    const r = judgeContractCoverage({ fields: [['background', false, 'DATA-FORMAT']], dfText: df, itemText: '' });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].kind).toBe('contract');
    expect(r.problems[0].msg).toContain('background');
    expect(r.problems[0].msg).toContain('契约表');
    expect(r.problems[0].msg).toContain('没有');
  });

  it('词只出现在散文里（契约行被删、散文提了一句）⇒ 仍必须红 —— "词出现过 ≠ 有表行"', () => {
    const df = fakeDataFormat(dfRows.filter((r) => !r.includes('background')), dfExample)
      + '\n补充：`background` 是历史字段，解析方应容忍它。\n';
    const r = judgeContractCoverage({ fields: [['background', false, 'DATA-FORMAT']], dfText: df, itemText: '' });
    expect(r.problems.length).toBe(1);
  });

  it('字段名只**作为别的字段的前缀**出现不算契约（`detail` 的行不能让 `detailMode` 变绿）', () => {
    const df = fakeDataFormat(['| `detail` | - | HTML |'], []);
    const r = judgeContractCoverage({ fields: [['detailMode', true, 'DATA-FORMAT']], dfText: df, itemText: '' });
    expect(r.problems.map((p) => p.kind)).toEqual(['contract']);
  });

  it('ITEM-MODEL 那张表里的 `items[]` 行被删（同一份文档别处仍提到 items）⇒ **必须红**', () => {
    const item = fakeItemModel(['| `qa[]` | 退役 | 禁止出现 |'])
      + '\n正文：条目化的节点以 items 为唯一真源。\n';
    const r = judgeContractCoverage({ fields: [['items', true, 'ITEM-MODEL#346']], dfText: '', itemText: item });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].kind).toBe('contract');
    expect(r.problems[0].msg).toContain('items');
    expect(r.problems[0].msg).toContain('ITEM-MODEL');
    expect(r.problems[0].msg).toContain('没有');
  });

  it('声明了 `ITEM-MODEL` 但那份文档读不出 ⇒ 采不到真值＝红（不许静默当绿）', () => {
    const r = judgeContractCoverage({ fields: [['items', true, 'ITEM-MODEL#346']], dfText: '', itemText: '' });
    expect(r.problems.map((p) => p.kind)).toEqual(['unreadable']);
  });
});

describe('G8 ⑪ · 表行判据：绿的方向（只改措辞必须绿）', () => {
  it('表行在、且只改说明列的**措辞**（字段名不动）⇒ 绿', () => {
    const rows = ['| `background` | - | 改过的措辞：底色字段，无写入入口，解析方须容忍 |'];
    const df = fakeDataFormat(rows, dfExample);
    const r = judgeContractCoverage({ fields: [['background', false, 'DATA-FORMAT']], dfText: df, itemText: '' });
    expect(r.problems).toEqual([]);
    expect(r.stats.byWhere['DATA-FORMAT']).toBe(1);
  });

  it('`items` 在 ITEM-MODEL 表里写作 `items[]` ⇒ 绿（规范化去掉列表后缀，但**只**去后缀）', () => {
    const item = fakeItemModel(['| `items[]` | **文本型知识条目的唯一真源** | 有它即条目化 |']);
    const r = judgeContractCoverage({ fields: [['items', true, 'ITEM-MODEL#346']], dfText: '', itemText: item });
    expect(r.problems).toEqual([]);
    expect(r.stats.byWhere['ITEM-MODEL']).toBe(1);
  });

  it('表头行与分隔行不参与判定（`| 字段 | … |` 不会被当成字段名 `字段`）', () => {
    const rows = ['| `字段` | - | 这里讲的是字段本身 |'];
    const r = judgeContractCoverage({ fields: [['字段', false, 'DATA-FORMAT']], dfText: fakeDataFormat(rows, []), itemText: '' });
    // `| 字段 | 校验 | 说明 |` 是表头 ⇒ 结构性排除；`| `字段` |` 那一行是数据行 ⇒ 命中
    expect(r.problems).toEqual([]);
  });
});

describe('G8 ⑪ · ★旧判据唯一骗得过、新判据骗不过的那种注入', () => {
  /* 这一组就是 SPEC 里第 4 条注入的**单元版**：
   *   甲）在 JSON 示例里加一句含 `background` 的注释 —— 字段名没有表行，**只看词**的旧判据会判绿；
   *   乙）表行**也**还在 ⇒ 新判据绿（不能误伤"示例里提到字段"这种正当写法）；
   *   丙）表行被删、示例里仍有该词 ⇒ 新判据**红**（旧判据在这里会绿 = 缺陷本体）。 */
  const dfWithComment = (rows) => fakeDataFormat(rows,
    ['  // background 是历史字段，示例里保留一句', '  "background": "#f5f5f5"']);

  it('甲+乙：示例里有该词、表行也在 ⇒ 绿（对"示例里提到字段"不误伤）', () => {
    const r = judgeContractCoverage({
      fields: [['background', false, 'DATA-FORMAT']], dfText: dfWithComment(dfRows), itemText: ''
    });
    expect(r.problems).toEqual([]);
  });

  it('丙：示例里加了含该词的注释、**表行却被删** ⇒ 红（缺陷本体的最小复现）', () => {
    const rowsNoBg = dfRows.filter((r) => !r.includes('background'));
    const r = judgeContractCoverage({
      fields: [['background', false, 'DATA-FORMAT']], dfText: dfWithComment(rowsNoBg), itemText: ''
    });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].msg).toContain('background');
  });
});

describe('G8 ⑪ · prose 档（弱判据）必须两侧都判', () => {
  const proseField = [['detailMode', true, 'DATA-FORMAT:prose']];
  const dfProse = '显式二选一：detailMode 取 rich 或 list。\n';

  it('在册 + 词出现在散文里 ⇒ 绿，且读数把"prose 承载"计进来（不是悄悄放过）', () => {
    const r = judgeContractCoverage({ fields: proseField, dfText: dfProse, itemText: '',
      proseExempt: ['detailMode'], proseMax: 1 });
    expect(r.problems).toEqual([]);
    expect(r.stats.byWhere['DATA-FORMAT:prose']).toBe(1);
    expect(r.stats.prose).toEqual(['detailMode']);
    expect(r.stats.proseExcess).toBe(0);
  });

  it('不在册 ⇒ 红（否则"标成 prose"就成了绕过表行判定的后门）', () => {
    const r = judgeContractCoverage({ fields: proseField, dfText: dfProse, itemText: '',
      proseExempt: [], proseMax: 1 });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].kind).toBe('contract-stale');
    expect(r.problems[0].msg).toContain('PROSE_EXEMPT');
  });

  it('连词都没出现 ⇒ 红（prose 档的最低要求是出现 ≥1 次）', () => {
    const r = judgeContractCoverage({ fields: proseField, dfText: '什么也没写。\n', itemText: '',
      proseExempt: ['detailMode'], proseMax: 1 });
    expect(r.problems.map((p) => p.kind)).toEqual(['contract']);
  });

  it('册超上界 ⇒ 红（只减不增）', () => {
    const r = judgeContractCoverage({ fields: proseField, dfText: dfProse, itemText: '',
      proseExempt: ['detailMode', 'qa'], proseMax: 1 });
    expect(r.problems.map((p) => p.kind)).toContain('contract-stale');
    expect(r.stats.proseExcess).toBe(1);
  });

  it('册上已结清（不再有字段声明 prose）⇒ 只报告、不判红（删登记是合法结清方式）', () => {
    const r = judgeContractCoverage({ fields: [['qa', true, 'DATA-FORMAT']],
      dfText: fakeDataFormat(dfRows, []), itemText: '', proseExempt: ['detailMode'], proseMax: 1 });
    expect(r.problems).toEqual([]);
    expect(r.stats.proseDangling).toEqual(['detailMode']);
  });
});

describe('G8 ⑪ · 第三列是**封闭取值**（拼错 = 没判，不许静默绿）', () => {
  it('缺第三列 ⇒ 红', () => {
    const r = judgeContractCoverage({ fields: [['qa', true]], dfText: fakeDataFormat(dfRows, []), itemText: '' });
    expect(r.problems.map((p) => p.kind)).toEqual(['contract-stale']);
    expect(r.problems[0].msg).toContain('第三列');
  });

  it('第三列拼错（`DATA-FORMAT:proses`）⇒ 红，报文列出封闭三档', () => {
    const r = judgeContractCoverage({ fields: [['qa', true, 'DATA-FORMAT:proses']],
      dfText: fakeDataFormat(dfRows, []), itemText: '' });
    expect(r.problems.map((p) => p.kind)).toEqual(['contract-stale']);
    CONTRACT_WHERE_KINDS.forEach((k) => expect(r.problems[0].msg).toContain(k));
  });
});

describe('G8 ⑪ · 规范化只做三件事（去反引号 / 去空白 / 去 `[]` 后缀）', () => {
  it('`items[]` ⇒ `items`；`images[] / files[]` 仍是合并行（不会替单字段变绿）', () => {
    expect(normContractCell('`items[]`')).toBe('items');
    expect(normContractCell('images[] / files[]')).not.toBe('images');
    expect(normContractCell('`meta.name`')).toBe('meta.name');
  });

  it('`contractTableCells` 排掉表头/分隔行，并给出真实行号（供人定位）', () => {
    const cells = contractTableCells(fakeDataFormat(dfRows, []));
    expect(cells.map((c) => c.cell)).toEqual(['meta.name', 'background', 'qa']);
    expect(cells[0].line).toBe(7);          // 表头 5 / 分隔 6 / 第一条数据行 7
  });
});

describe('G8 ⑪ · 真实文档回归（含内存注入；两份契约文档**只读**，一字节不写）', () => {
  const dfPath = path.join(ROOT, 'docs', 'DATA-FORMAT.md');
  const itemPath = path.join(ROOT, 'docs', 'ITEM-MODEL.md');
  const dfReal = fs.readFileSync(dfPath, 'utf8');
  const itemReal = fs.readFileSync(itemPath, 'utf8');

  it('真仓 24 条全绿，且读数分母 = 24（22 表行 + 1 ITEM-MODEL 表行 + 1 prose）', () => {
    const stats = {};
    const problems = checkContractCoverage(ROOT, stats);
    expect(problems).toEqual([]);
    expect(stats.fields).toBe(24);
    expect(stats.byWhere['DATA-FORMAT'] + stats.byWhere['ITEM-MODEL']
      + stats.byWhere['DATA-FORMAT:prose']).toBe(24);
    expect(stats.byWhere['DATA-FORMAT']).toBe(22);
    expect(stats.byWhere['ITEM-MODEL']).toBe(1);
    expect(stats.prose).toEqual(['detailMode']);
    expect(stats.proseMax).toBe(PROSE_EXEMPT_MAX);
    expect(PROSE_EXEMPT).toEqual(['detailMode']);
  });

  it('清单形状：每条都是三列，且第三列在封闭取值内（`ITEM-MODEL#<行号>` 那种收）', () => {
    expect(SCHEMA_FIELDS.length).toBe(24);
    SCHEMA_FIELDS.forEach((row) => {
      expect(row.length).toBe(3);
      const where = row[2];
      const ok = CONTRACT_WHERE_KINDS.includes(where) || /^ITEM-MODEL#\d+$/.test(where);
      expect(ok, '第三列非法：' + row[0] + ' ⇒ ' + where).toBe(true);
    });
  });

  it('真 DATA-FORMAT 里删掉 `| background |` 整行（**内存内**）⇒ 红，点名 background', () => {
    const inject = dfReal.split('\n').map((l) => l)
      .filter((l) => !/^\|\s*`?background`?\s*\|/.test(l)).join('\n');
    expect(inject.length).toBeLessThan(dfReal.length);        // 注入确实删到了东西
    const r = judgeContractCoverage({ fields: [['background', false, 'DATA-FORMAT']],
      dfText: inject, itemText: itemReal });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].msg).toContain('background');
  });

  it('真 DATA-FORMAT 里删掉 `| graph |` 整行（**内存内**）⇒ 红，点名 graph', () => {
    // 缺口 ②（本批）：`graph` 写在 `docs/DATA-FORMAT.md` 的契约表里，而门禁的 `SCHEMA_FIELDS`
    // 曾经没有它 ⇒ 删掉那一行**不会红**（判据扫不到它）。这条守的是"它现在真的被扫了"：
    // 删行后 `graph` 这个词仍出现在 §1 引言 / §1.6 标题 / JSON 示例 / `version` 行说明里，
    // 所以它同时证明了判据走的是**表行第一列**，不是"词在文档里出现过"。
    const inject = dfReal.split('\n').filter((l) => !/^\|\s*`?graph`?\s*\|/.test(l)).join('\n');
    expect(inject.length).toBeLessThan(dfReal.length);        // 注入确实删到了东西
    expect(inject).toContain('graph');                        // 词还在（散文/示例里都有）
    const r = judgeContractCoverage({ fields: [['graph', true, 'DATA-FORMAT']],
      dfText: inject, itemText: itemReal });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].msg).toContain('graph');
  });

  it('真 ITEM-MODEL 里删掉 `| `items[]` |` 整行（**内存内**）⇒ 红，点名 items', () => {
    const inject = itemReal.split('\n')
      .filter((l) => !/^\|\s*`?items\[\]`?\s*\|/.test(l)).join('\n');
    expect(inject.length).toBeLessThan(itemReal.length);
    const r = judgeContractCoverage({ fields: [['items', true, 'ITEM-MODEL#346']],
      dfText: dfReal, itemText: inject });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].msg).toContain('items');
    expect(r.problems[0].msg).toContain('ITEM-MODEL');
  });

  it('真 DATA-FORMAT 里给 `| background |` 行改措辞（字段名不动）⇒ 绿', () => {
    const inject = dfReal.replace(/^(\|\s*`?background`?\s*\|)(.*)$/m, '$1 措辞已改 |');
    expect(inject).not.toBe(dfReal);
    const r = judgeContractCoverage({ fields: [['background', false, 'DATA-FORMAT']],
      dfText: inject, itemText: itemReal });
    expect(r.problems).toEqual([]);
  });
});
