/* ============================================================
 * tests/vocab-gate.test.js — 标签词表契约门禁（S4）的判定逻辑
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * ## 这个文件守什么
 * 门禁 `S4` = `node scripts/doc-facts.js --vocab`，它答的是一句话：
 * **`docs/TAGS.md` 的「适用范围」清单与 `projects/` 里的真实标签，还对得上吗？**
 *
 * 拆成两半，各自可注入（`testing-for-ai` B6：判定必须是可注入输入的纯函数）：
 *   A. `parseTagScope(md)` —— **纯函数**：文档全文进、清单出，零 IO。
 *      A1 真实 `docs/TAGS.md` 解析得动，且清单里的每个名字都是 `projects/` 下**真实存在的目录**
 *         （"逐字一致"这件事在这里被机械核对，不靠人抄）
 *      A2 「适用范围」节被删 ⇒ `ok:false`（**删声明 = 静默关掉门禁**）
 *      A3 表里一行都没有 ⇒ `ok:false`（清单为空 = 一个项目都不判 = 关掉，不是通过）
 *      A4 两句声明（`未列出的项目不受约束` / `必须同批复核`）缺一句就记进 `missingMarkers`
 *      A5 节体只到下一个 `#` / `##` 标题（`###` 不截断）· 不是表格行的文字不算项目
 *      A6 标题里的计数声明读得到就读，读不到返回 `null`（由判定层决定"只报告"）
 *   B. `judgeVocabContract(input)` —— **纯函数**：值进、判定出，零 IO。
 *      B1 干净 ⇒ 绿（且 `reds` 为空、三个读数数组都空）
 *      B2 **闭集**：`inVocab:false` 的标签 ⇒ `closed-set` 红
 *      B3 **落点下限**：`belowFloor` 非空 ⇒ `floor` 红（读数原样透出，不在这一层重算下限）
 *      B4 **词表空转**：`unused` 非空 ⇒ `unused` 红
 *      B5 **采不到真值三种形状都红**：CLI 跑不通 / `vocab` 读数缺席 / `inVocab` 位缺席
 *      B6 扫描面与清单不符 / 模式不是 `named` ⇒ 红（门禁不许替调用方认定适用范围）
 *      B7 清单点名了盘上不存在的项目 ⇒ `scope-dangling` 红；取不到项目清单 ⇒ `no-truth` 红
 *      B8 标题计数声明 ↔ 清单条数：不符 ⇒ 红；**读不到声明 ⇒ 只报告、仍绿**（三档可见）
 *   C. `runVocabGate(opts)` 的**整链**（依赖全注入，不碰真仓）：
 *      C1 红的情况下返回 `false`；绿的情况返回 `true`
 *      C2 它就是"范围在起作用"的那一跳：**同一个越界标签**，进清单 ⇒ 红，不进清单 ⇒ 绿
 *
 * ## 不测什么（边界）
 *   ① 不测 `tags --vocab` 的三条判据本身（那是 `tests/tag-census.test.js` 的 B3，本批不重复验）；
 *   ② 不测真实 `projects/` 的标签是否合规 —— 那是门禁自己在 `npm run verify` 里对**当前数据**跑的事，
 *      写进单测就把"某天有人打了个越界标签"变成单测红（单测不该依赖易变的用户数据）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const df = require('../scripts/doc-facts.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAGS_MD = fs.readFileSync(path.join(ROOT, 'docs', 'TAGS.md'), 'utf8');

/** 造一份最小可解析的文档（节标题 + 表 + 两句声明 + 一个后续 `##` 节） */
function synth(projects, opts) {
  const o = opts || {};
  const rows = (projects || []).map((p) => '| `' + p + '` | 说明 |').join('\n');
  // 标题里的计数**与清单条数一致**（不一致就是另一条判据 scope-count 的红，别在无关用例里踩它）
  const title = o.title !== undefined ? o.title : '# 词表（' + (projects || []).length + ' 本书共用）';
  return [
    title,
    '',
    '## 适用范围（清单是唯一权威）',
    o.markers === false ? '' : '**未列出的项目不受约束**；加项目**必须同批复核**。',
    '',
    '| 项目 | 说明 |',
    '|---|---|',
    rows,
    '',
    o.next || '## 0. 下一节',
    '本节的文字里有个 `假项目` 不算清单（不是表格行）。'
  ].join('\n');
}

/** 一份干净的 `tags --vocab --json` 输出（形状照 `cli/commands/project.js` 的 ⑥ 段） */
function cleanPayload(projects, opts) {
  const o = opts || {};
  return {
    ok: true,
    mode: o.mode || 'named',
    projects: (projects || []).slice(),
    nodes: 100,
    taggedNodes: 90,
    untaggedNodes: 10,
    tagCount: 2,
    tags: o.tags || [
      { tag: '拥塞控制', nodes: 7, projects: [], inVocab: true },
      { tag: '队列与整形', nodes: 6, projects: [], inVocab: true }
    ],
    vocab: o.vocab || { source: 'docs/TAGS.md §4', count: 39, unused: [], belowFloor: [] }
  };
}

/** 判定层的公共入参 */
function input(over) {
  const base = {
    scopeProjects: ['book-a', 'book-b'],
    countClaim: 2,
    missingMarkers: [],
    payload: cleanPayload(['book-a', 'book-b']),
    payloadError: null,
    existingProjects: ['book-a', 'book-b', 'comnet'],
    vocabCount: 39
  };
  return Object.assign(base, over || {});
}

/* ========================================================================== */
describe('A. parseTagScope —— 「适用范围」清单的机械解析（纯函数）', () => {
  it('A1 真实 docs/TAGS.md 解析得动，且每个名字都是 projects/ 下真实存在的目录', () => {
    const r = df.parseTagScope(TAGS_MD);
    expect(r.ok, r.message).toBe(true);
    expect(r.projects.length).toBeGreaterThan(5);
    expect(r.missingMarkers, '两句声明必须在正文里').toEqual([]);
    // 名字必须与真实目录**逐字一致**（这条判据在门禁里也有一份，这里再钉一次"文档没手抄错"）
    const dirs = fs.readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
    const missing = r.projects.filter((p) => dirs.indexOf(p) < 0);
    expect(missing, '清单里这些名字在 projects/ 下不存在（改名了？还是手抄错了？）').toEqual([]);
    // 清单**不含**非书项目（它们不受约束）——这是本批的核心语义，别把 comnet 写进清单
    expect(r.projects).not.toContain('comnet');
  });

  it('A2 节被删 ⇒ ok:false（删声明 = 静默关掉门禁，故按红处理）', () => {
    const r = df.parseTagScope('# 标题\n\n## 0. 别的节\n没有适用范围。\n');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('适用范围');
  });

  it('A3 表里一行都没有 ⇒ ok:false（清单为空 = 一个项目都不判 = 关掉）', () => {
    const r = df.parseTagScope(synth([]));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('清单');
  });

  it('A4 两句声明缺一句 ⇒ 记进 missingMarkers（不在此判红，判定层才翻成红）', () => {
    const r = df.parseTagScope(synth(['book-a'], { markers: false }));
    expect(r.ok).toBe(true);
    expect(r.missingMarkers.length).toBe(2);
    expect(r.missingMarkers.join(' ')).toContain('未列出的项目不受约束');
    expect(r.missingMarkers.join(' ')).toContain('必须同批复核');
  });

  it('A5 节体只到下一个 # / ## 标题，且不是表格行的文字不算项目', () => {
    const r = df.parseTagScope(synth(['book-a', 'book-b']));
    expect(r.projects).toEqual(['book-a', 'book-b']);
    expect(r.projects).not.toContain('假项目');     // 下一节里的那段文字
    // `###` 属于本节内部 ⇒ 不截断；它下面的表格行照样收
    const withSub = synth(['book-a']).replace('## 0. 下一节',
      '### 2.1 子标题\n| `book-c` | 说明 |\n\n## 0. 下一节');
    expect(df.parseTagScope(withSub).projects).toEqual(['book-a', 'book-c']);
  });

  it('A6 标题计数声明：读得到就读，读不到返回 null（由判定层决定只报告）', () => {
    expect(df.parseTagScope(synth(['book-a', 'book-b'])).countClaim).toBe(2);
    const noClaim = synth(['book-a']).replace('（1 本书共用）', '');
    expect(df.parseTagScope(noClaim).countClaim).toBe(null);
  });

  it('A7 解析器与文档里的字样是**一处契约**：改节标题就得同批改解析器', () => {
    expect(df.SCOPE_HEADING_RE.test('## 适用范围（本节的清单是**唯一权威**）')).toBe(true);
    expect(df.SCOPE_HEADING_RE.test('## 8. 别的')).toBe(false);
    expect(df.SCOPE_REQUIRED_MARKERS.map((m) => m.key))
      .toEqual(['未列出的项目不受约束', '必须同批复核']);
  });
});

/* ========================================================================== */
describe('B. judgeVocabContract —— 三条判据的收口（纯函数）', () => {
  it('B1 干净 ⇒ 绿，且三个读数数组都空', () => {
    const v = df.judgeVocabContract(input());
    expect(v.reds).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.outOfVocab).toEqual([]);
    expect(v.belowFloor).toEqual([]);
    expect(v.unused).toEqual([]);
  });

  it('B2 闭集：inVocab:false ⇒ closed-set 红（读数带标签名与落点数）', () => {
    const p = cleanPayload(['book-a', 'book-b'], {
      tags: [
        { tag: '拥塞控制', nodes: 7, projects: [], inVocab: true },
        { tag: '协议', nodes: 177, projects: [], inVocab: false }
      ]
    });
    const v = df.judgeVocabContract(input({ payload: p }));
    expect(v.ok).toBe(false);
    expect(v.reds.map((r) => r.code)).toContain('closed-set');
    expect(v.outOfVocab).toEqual([{ tag: '协议', nodes: 177 }]);
  });

  it('B3 落点下限：belowFloor 非空 ⇒ floor 红（下限本身不在这一层重算）', () => {
    const p = cleanPayload(['book-a', 'book-b'], {
      vocab: { source: 'docs/TAGS.md §4', count: 39, unused: [],
        belowFloor: [{ tag: '可靠传输', nodes: 4, floor: 5 }] }
    });
    const v = df.judgeVocabContract(input({ payload: p }));
    expect(v.ok).toBe(false);
    expect(v.reds.map((r) => r.code)).toContain('floor');
    expect(v.belowFloor[0]).toEqual({ tag: '可靠传输', nodes: 4, floor: 5 });
  });

  it('B4 词表空转：unused 非空 ⇒ unused 红', () => {
    const p = cleanPayload(['book-a', 'book-b'], {
      vocab: { source: 'docs/TAGS.md §4', count: 39, unused: ['启动与引导'], belowFloor: [] }
    });
    const v = df.judgeVocabContract(input({ payload: p }));
    expect(v.ok).toBe(false);
    expect(v.reds.map((r) => r.code)).toContain('unused');
    expect(v.unused).toEqual(['启动与引导']);
  });

  it('B5 采不到真值的三种形状都红（不许读成"0 个问题"）', () => {
    expect(df.judgeVocabContract(input({ payload: null, payloadError: 'exit 1：boom' }))
      .reds.map((r) => r.code)).toContain('no-truth');
    const noVocab = cleanPayload(['book-a', 'book-b']);
    delete noVocab.vocab;
    expect(df.judgeVocabContract(input({ payload: noVocab })).reds.map((r) => r.code))
      .toContain('no-truth');
    const noFlag = cleanPayload(['book-a', 'book-b'], {
      tags: [{ tag: '拥塞控制', nodes: 7, projects: [] }]      // 缺 inVocab 位
    });
    expect(df.judgeVocabContract(input({ payload: noFlag })).reds.map((r) => r.code))
      .toContain('no-truth');
  });

  it('B6 扫描面 / 模式不对 ⇒ 红（门禁不替调用方认定适用范围）', () => {
    const wrongSet = cleanPayload(['book-a']);
    expect(df.judgeVocabContract(input({ payload: wrongSet })).reds.map((r) => r.code))
      .toContain('scope-mismatch');
    const libMode = cleanPayload(['book-a', 'book-b'], { mode: 'library' });
    expect(df.judgeVocabContract(input({ payload: libMode })).reds.map((r) => r.code))
      .toContain('no-truth');
  });

  it('B7 清单点名了盘上不存在的项目 ⇒ scope-dangling 红；取不到项目清单 ⇒ no-truth 红', () => {
    const v = df.judgeVocabContract(input({ existingProjects: ['book-a', 'comnet'] }));
    expect(v.ok).toBe(false);
    expect(v.reds.map((r) => r.code)).toContain('scope-dangling');
    expect(v.reds[0].msg).toContain('book-b');
    expect(df.judgeVocabContract(input({ existingProjects: null })).reds.map((r) => r.code))
      .toContain('no-truth');
  });

  it('B8 标题计数声明：不符 ⇒ 红；读不到 ⇒ **只报告、仍绿**（"跳过/只报告"必须与通过可区分）', () => {
    const mismatch = df.judgeVocabContract(input({ countClaim: 7 }));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reds.map((r) => r.code)).toContain('scope-count');

    const noClaim = df.judgeVocabContract(input({ countClaim: null }));
    expect(noClaim.ok).toBe(true);
    expect(noClaim.reds).toEqual([]);
    expect(noClaim.reports.length).toBe(1);
    expect(noClaim.reports[0]).toContain('未对账');
  });

  it('B9 缺声明 ⇒ scope-marker 红（两句各一条）', () => {
    const v = df.judgeVocabContract(input({ missingMarkers: ['未列出的项目不受约束（理由）'] }));
    expect(v.ok).toBe(false);
    expect(v.reds.map((r) => r.code)).toContain('scope-marker');
  });
});

/* ========================================================================== */
describe('C. runVocabGate —— 依赖全注入的整链（不碰真仓）', () => {
  /** 造一个"只有我点名的项目在盘上"的注入面 */
  const mkOpts = (over) => Object.assign({
    mdText: synth(['book-a', 'book-b']),
    readText: () => { throw new Error('本用例不该读真仓'); },
    invoke: () => ({ code: 0, stdout: JSON.stringify(cleanPayload(['book-a', 'book-b'])), stderr: '' }),
    projectsDir: '/nonexistent（listProjects 被注入，不会真去读）',
    listProjects: () => ['book-a', 'book-b', 'comnet'],
    vocabCount: 39
  }, over || {});

  /** 静音：`runVocabGate` 是"打印 + 返回布尔"的门禁入口（打印是给人看的，这里只关心布尔） */
  const quiet = (fn) => {
    const log = console.log; const err = console.error;
    console.log = () => {}; console.error = () => {};
    try { return fn(); } finally { console.log = log; console.error = err; }
  };

  it('C1 干净 ⇒ true；任一判据红 ⇒ false', () => {
    expect(quiet(() => df.runVocabGate(mkOpts()))).toBe(true);
    const bad = mkOpts({
      invoke: () => ({ code: 0, stderr: '', stdout: JSON.stringify(cleanPayload(['book-a', 'book-b'], {
        tags: [{ tag: '协议', nodes: 9, projects: [], inVocab: false }]
      })) })
    });
    expect(quiet(() => df.runVocabGate(bad))).toBe(false);
    expect(quiet(() => df.runVocabGate(mkOpts({ invoke: () => ({ code: 1, stdout: 'error: x', stderr: '' }) }))))
      .toBe(false);
  });

  it('C2 **范围在起作用**：同一条越界标签 —— 进清单 ⇒ 红；不在清单的项目出现它 ⇒ 绿', () => {
    /* 场景一：清单里的 book-a 出现 `协议`（不在 §4 的闭集里）⇒ 必须红。
     * 这正是本批最关键的一条：判定不是"这个标签在不在 §4"，而是"**在受约束的项目里**在不在"。 */
    const inScope = mkOpts({
      invoke: () => ({ code: 0, stderr: '', stdout: JSON.stringify(cleanPayload(['book-a', 'book-b'], {
        tags: [
          { tag: '拥塞控制', nodes: 7, projects: [], inVocab: true },
          { tag: '协议', nodes: 177, projects: [], inVocab: false }
        ]
      })) })
    });
    expect(quiet(() => df.runVocabGate(inScope))).toBe(false);

    /* 场景二：同一个标签只出现在 comnet（**清单之外**）。
     * 门禁怎么知道？—— 它只把清单里的项目点给 `tags --vocab`，comnet 根本不在 argv 里。
     * 所以这里"注入了 comnet 的标签"这一事实表现为：`tags` 的输出**没有**那条标签 ⇒ 绿。 */
    const outOfScope = mkOpts({
      listProjects: () => ['book-a', 'book-b', 'comnet'],
      invoke: (argv) => {
        // 自证：门禁**没有**把 comnet 放进扫描面（这就是"范围"落到 argv 上的形态）
        expect(argv).not.toContain('comnet');
        expect(argv).toContain('book-a');
        return { code: 0, stderr: '', stdout: JSON.stringify(cleanPayload(['book-a', 'book-b'])) };
      }
    });
    expect(quiet(() => df.runVocabGate(outOfScope))).toBe(true);
  });
});
