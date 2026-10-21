/* ============================================================
 * tests/import-grade.test.js — 「导入分档（`IG` · 台账 `W15`）」的判据回归
 * 运行：npx vitest run tests/import-grade.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261020-W15-import/00-定题.md` §2.2 / §3.4 / §5.2 / §5.3，
 * 判别力证明的实物版本：`.review/20261020-W15-import/probe-power.js`（内存注入 7/7 条翻转）。
 *
 * ## 本文件钉住的判据（每条都能红）
 *   A. **双端（UMD）**：浏览器沙箱（只有 `self`、没有 `module`/`require`）里能加载、
 *      全局名 `MMImportGrade` 在、**纯算术能跑**（`gradeOne` / `summarize`）。
 *   B. **重放是围栏感知的**（这是整条判据的地基）：``` 里的 `# …` **不许**被算成标题。
 *      为什么单独立一条：`src/doc-import.js` 的 `finishOutline` 统计 `stats.headings` 用的是
 *      **朴素正则**（不看围栏），实测同一批文件用朴素分母算 recall **0.7957**、围栏感知 **0.9712** ——
 *      差的不是数据，是判据写错了。分档一旦跟着朴素口径走，整批读数就是假的。
 *   C. **占位节点被剔掉且如实计数**：`markdownToTree` 在层级跳跃处插 `（层级N）`，
 *      它是节点不是标题 ⇒ 剔掉 + `placeholders` 报数（既不静默丢，也不让它把文件误判成 `rewritten`）。
 *   D. **重复标题保重数**：同一个标题出现两次 ⇒ `E` 是 2；少落一个 ⇒ `rewritten` 且 `recall` 下降。
 *   E. **六档各自可达**：clean / rewritten / grown / src-gone / unreadable / unknown-tool。
 *   F. **`origin` 节点自己算不算产物按 `origin.tool` 判**（`docs/DATA-FORMAT.md` §2.8）：
 *      `import-md` ⇒ 算；`import-project` / `import-dir` / `bind-sync` ⇒ 不算；不认识/缺失 ⇒ **不猜**（null）。
 *   G. **`grown` 档不出分**：`|A| > |E|` 时 `precision`/`recall` 必须是 `null`（不是 0，也不是估算值）。
 *   H. **汇总用微平均**，且没有可判行时两个数都是 `null`（`null` = 没得判，`0` = 全错，两件事）。
 *   I. **探针前缀表与 `scripts/cli-integration.js` 的 `PROBE_PREFIX` 同源**：本表的真值在脚本里，
 *      而 `cli/`+`src/` **不许** require `scripts/`（S1 单向依赖）⇒ 只能抄一份。
 *      抄了就一定会漂 ⇒ 这条用例**直接读那个源文件、把两张表逐条对齐**，漂了就红。
 *   J. **确定性**：同一输入两次 `JSON.stringify` 相同；且模块源码里**没有** `Date.now` / `Math.random` / `new Date`
 *      （判据不能自己引入时变源 —— 否则"`--json` 两跑逐字节相同"永远过不了）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const grade = require('../src/import-grade.js');
const markdown = require('../src/markdown.js');
const mentions = require('../src/mentions.js');

/** 造一个"浏览器端"沙箱：只有 `self`，没有 `module` / `exports` / `require`（形态照 tests/g15-umd-dual.test.js） */
function browserSandbox(files) {
  const sandbox = { console: console };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  files.forEach((f) => {
    const abs = path.join(REPO, 'src', f);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

describe('A · 双端（UMD）：import-grade 在浏览器沙箱里能加载、纯算术能用', () => {
  it('能加载且全局名在；gradeOne / summarize 在浏览器端给出同一份读数', () => {
    const sb = browserSandbox(['convert.js', 'markdown.js', 'import-grade.js']);
    expect(sb.MMImportGrade, 'MMImportGrade 全局名不见了（UMD 的浏览器分支坏了）').toBeTruthy();
    expect(typeof sb.MMImportGrade.gradeOne).toBe('function');

    const row = sb.MMImportGrade.gradeOne({
      project: 'p', src: 'a.md', tool: 'import-md',
      replayTopics: ['A', 'B'], actualTopics: ['A', 'B']
    });
    expect(row.klass).toBe('clean');
    expect(row.precision).toBe(1);
    expect(row.recall).toBe(1);

    // Node 侧与浏览器侧对同一份入参必须给出**逐字节相同**的行（否则两端读数是两份口径）
    const nodeRow = grade.gradeOne({
      project: 'p', src: 'a.md', tool: 'import-md',
      replayTopics: ['A', 'B'], actualTopics: ['A', 'B']
    });
    expect(JSON.stringify(row)).toBe(JSON.stringify(nodeRow));
  });
});

describe('B · 重放必须围栏感知（判据的地基）', () => {
  const md = [
    '# 第一章',
    '正文一',
    '',
    '```bash',
    '# 这行是 shell 注释，不是标题',
    'echo hi',
    '```',
    '',
    '## 1.1 小节',
    '正文二',
    '',
    '```',
    '# 这段也是代码',
    '```',
    '',
    '# 第二章'
  ].join('\n');

  it('围栏里的 `#` 不算标题；围栏外的照旧', () => {
    const r = grade.replayTopics(md);
    expect(r.topics).toEqual(['第一章', '1.1 小节', '第二章']);
    expect(r.topics.indexOf('这行是 shell 注释，不是标题')).toBe(-1);
    expect(r.topics.indexOf('这段也是代码')).toBe(-1);
  });

  it('对照：朴素正则数出来的是 5 条 —— 判据若走朴素口径，recall 会被算成 3/5', () => {
    const naive = md.split('\n').filter((l) => /^#{1,6}\s+\S/.test(l)).length;
    expect(naive).toBe(5);                                  // 围栏里那两条也数进去了
    expect(grade.replayTopics(md).topics.length).toBe(3);
  });
});

describe('C · 占位节点「（层级N）」剔掉并计数', () => {
  it('层级跳跃（# 直接到 ###）会插占位节点：它不进标题序列，但被如实计数', () => {
    const md = ['# 顶级', '', '### 跳了一级', ''].join('\n');
    const r = grade.replayTopics(md);
    expect(r.placeholders).toBeGreaterThanOrEqual(1);
    expect(r.topics.indexOf('（层级2）')).toBe(-1);
    expect(r.topics).toEqual(['顶级', '跳了一级']);
  });

  it('主题串恰好是「（层级2）」的哨兵也按占位算（判据是形状，不是来源）', () => {
    expect(grade.isPlaceholder('（层级2）')).toBe(true);
    expect(grade.isPlaceholder('（层级 2）')).toBe(false);   // 中间有空格 = 不是那个形状
    const s = grade.stripPlaceholders(['A', '（层级3）', 'B']);
    expect(s).toEqual({ topics: ['A', 'B'], removed: 1 });
  });
});

describe('D · 重复标题保重数（E 是多重集，不能去重）', () => {
  it('源文里同一个标题出现两次 ⇒ E=2；只落一个 ⇒ rewritten 且 recall=0.5', () => {
    const Y = ['同名', '同名'];
    const row = grade.gradeOne({
      project: 'p', src: 'a.md', tool: 'import-md',
      replayTopics: Y, actualTopics: ['同名']
    });
    expect(row.E).toBe(2);
    expect(row.A).toBe(1);
    expect(row.matched).toBe(1);
    expect(row.klass).toBe('rewritten');
    expect(row.recall).toBe(0.5);
    expect(row.missingInTree).toEqual(['同名']);
  });

  it('两边都保重 ⇒ clean', () => {
    const row = grade.gradeOne({
      project: 'p', src: 'a.md', tool: 'import-md',
      replayTopics: ['同名', '同名'], actualTopics: ['同名', '同名']
    });
    expect(row.klass).toBe('clean');
    expect(row.matched).toBe(2);
  });
});

describe('E · 六档各自可达（判据不许有一条走不到的路）', () => {
  const base = { project: 'p', src: 'a.md', tool: 'import-md' };

  it('clean：逐条全等', () => {
    expect(grade.gradeOne(Object.assign({}, base, {
      replayTopics: ['A', 'B'], actualTopics: ['A', 'B']
    })).klass).toBe('clean');
  });

  it('rewritten：树上有一个标题源文里没有', () => {
    const row = grade.gradeOne(Object.assign({}, base, {
      replayTopics: ['A', 'B'], actualTopics: ['A', 'B（补范围 1.1–1.3）']
    }));
    expect(row.klass).toBe('rewritten');
    expect(row.extraInTree).toEqual(['B（补范围 1.1–1.3）']);
    expect(row.missingInTree).toEqual(['B']);
    expect(row.precision).toBe(0.5);
  });

  it('grown：树上比源文还多（导入后长过节点）', () => {
    const row = grade.gradeOne(Object.assign({}, base, {
      replayTopics: ['A'], actualTopics: ['A', '后来加的']
    }));
    expect(row.klass).toBe('grown');
  });

  it('src-gone：源文件不在盘上（不崩、不猜；原因照传 —— CLI 那边传的是"哪个路径不在"）', () => {
    const row = grade.gradeOne(Object.assign({}, base, {
      srcState: 'src-gone', reason: '源文件不在盘上：/tmp/x/a.md'
    }));
    expect(row.klass).toBe('src-gone');
    expect(row.E).toBe(null);
    expect(row.precision).toBe(null);
    expect(row.reason).toBe('源文件不在盘上：/tmp/x/a.md');
    // 不传原因时**如实写 null**，不编一句"源文件丢失"（编一句就是伪造证据）
    expect(grade.gradeOne(Object.assign({}, base, { srcState: 'src-gone' })).reason).toBe(null);
  });

  it('unreadable：读得进但解析不了 ⇒ 带原因', () => {
    const row = grade.gradeOne(Object.assign({}, base, {
      srcState: 'unreadable', reason: '这个 docx 里没有 word/document.xml'
    }));
    expect(row.klass).toBe('unreadable');
    expect(row.reason).toBe('这个 docx 里没有 word/document.xml');
  });

  it('unknown-tool：`origin.tool` 缺失 ⇒ 连"origin 节点算不算产物"都不确定，不猜', () => {
    const row = grade.gradeOne({ project: 'p', src: 'a.md', tool: null, replayTopics: ['A'], actualTopics: ['A'] });
    expect(row.klass).toBe('unknown-tool');
    expect(row.E).toBe(null);
    expect(grade.originNodeCountsAsProduct(null)).toBe(null);
    expect(grade.originNodeCountsAsProduct('')).toBe(null);
    expect(grade.originNodeCountsAsProduct('some-future-tool')).toBe(null);
  });

  it('点名有上限且如实标 truncated（不许静默截断）', () => {
    const many = [];
    for (let i = 0; i < grade.MAX_NAMES + 5; i++) many.push('节点' + i);
    const row = grade.gradeOne(Object.assign({}, base, { replayTopics: [], actualTopics: many }));
    expect(row.extraInTree.length).toBe(grade.MAX_NAMES);
    expect(row.namesTruncated).toBe(true);
  });
});

describe('F · origin 节点自己算不算产物（按 origin.tool）', () => {
  const node = { id: 'r', topic: '源文第一个一级标题', children: [{ id: 'c', topic: '子' }] };

  it('import-md ⇒ 算（origin 挂在 1 级标题子树根上）', () => {
    expect(grade.originNodeCountsAsProduct('import-md')).toBe(true);
    expect(grade.topicsOfOrigin(node, 'import-md').topics).toEqual(['源文第一个一级标题', '子']);
  });

  it('import-project / import-dir / bind-sync ⇒ 不算（那是项目根 / 文件节点，标题不是源文标题）', () => {
    ['import-project', 'import-dir', 'bind-sync'].forEach((tool) => {
      expect(grade.originNodeCountsAsProduct(tool)).toBe(false);
      expect(grade.topicsOfOrigin(node, tool).topics).toEqual(['子']);
    });
  });

  it('文件节点（标题=文件名）不参与对齐 ⇒ 该文件自己的子树要按"不含自己"算', () => {
    const fileNode = { id: 'f', topic: '2026-08-26-HH505N-加密上报.md', children: [{ id: 'h1', topic: '现象' }] };
    const got = grade.topicsOfOrigin(fileNode, 'import-dir');
    expect(got.topics).toEqual(['现象']);
    expect(got.topics.indexOf('2026-08-26-HH505N-加密上报.md')).toBe(-1);
  });
});

describe('G · grown 档不出分（分数必须缺席，不是 0）', () => {
  it('precision / recall 都是 null，且行里仍有 E / A / matched（读数不全丢）', () => {
    const row = grade.gradeOne({
      project: 'p', src: 'a.md', tool: 'import-md',
      replayTopics: ['A', 'B'], actualTopics: ['A', 'B', 'C', 'D']
    });
    expect(row.klass).toBe('grown');
    expect(row.precision).toBe(null);
    expect(row.recall).toBe(null);
    expect(row.E).toBe(2);
    expect(row.A).toBe(4);
    expect(row.matched).toBe(2);
  });
});

describe('H · 汇总：微平均 + 没得判时是 null', () => {
  const rows = [
    { klass: 'clean', E: 10, A: 10, matched: 10, placeholders: 0 },
    { klass: 'rewritten', E: 10, A: 10, matched: 5, placeholders: 0 },
    { klass: 'grown', E: 1, A: 9, matched: 1, placeholders: 0 },   // 不参与分母
    { klass: 'src-gone', E: null, A: null, matched: null, placeholders: 0 },
    { klass: 'unknown-tool', E: null, A: null, matched: null, placeholders: 0 }
  ];

  it('微平均：matched 合计 15 / A 合计 20 = 0.75；/ E 合计 20 = 0.75', () => {
    const s = grade.summarize(rows);
    expect(s.totals.judgeable).toBe(2);
    expect(s.totals.A).toBe(20);
    expect(s.totals.E).toBe(20);
    expect(s.precision).toBe(0.75);
    expect(s.recall).toBe(0.75);
    expect(s.totals.grown).toBe(1);
    expect(s.totals.srcGone).toBe(1);
    expect(s.totals.unknownTool).toBe(1);
  });

  it('一行都不可判 ⇒ precision / recall 都是 null（不是 0）', () => {
    const s = grade.summarize([{ klass: 'src-gone', E: null, A: null, matched: null }]);
    expect(s.precision).toBe(null);
    expect(s.recall).toBe(null);
    expect(s.totals.judgeable).toBe(0);
  });

  it('空输入不炸', () => {
    const s = grade.summarize([]);
    expect(s.totals.sources).toBe(0);
    expect(s.precision).toBe(null);
  });
});

describe('I · 探针前缀表与 scripts/cli-integration.js 的 PROBE_PREFIX 同源', () => {
  it('两张表逐条对齐（抄一份就必须被检查，否则迟早漂）', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'cli-integration.js'), 'utf8');
    const line = src.split(/\r?\n/).filter((l) => l.indexOf('const PROBE_PREFIX') >= 0)[0];
    expect(line, 'cli-integration.js 里找不到 PROBE_PREFIX 那一行 —— 本判据需要它').toBeTruthy();
    const m = /\/\^\(([^)]*)\)\//.exec(line);
    expect(m, 'PROBE_PREFIX 的形状变了（本判据用的正则提取不再成立）').toBeTruthy();

    const parts = m[1].split('|').map((s) => s.trim()).filter(Boolean);
    const plain = parts.filter((p) => p.indexOf('[') < 0).sort();
    const series = parts.filter((p) => p.indexOf('[') >= 0);

    expect(plain, 'src/import-grade.js 的 PROBE_PREFIX_LIST 与脚本里的前缀表不一致')
      .toEqual(grade.PROBE_PREFIX_LIST.slice().sort());
    expect(series, '系列前缀（it-s<N>-）的形状变了').toEqual(['it-s[1-9]-']);
  });

  it('行为面：表里每条都真的被判成探针；真实项目名一个都不误伤', () => {
    grade.PROBE_PREFIX_LIST.forEach((p) => {
      expect(grade.isProbeProject(p + 'x'), p + ' 没被判成探针').toBe(true);
    });
    for (let i = 1; i <= 9; i++) expect(grade.isProbeProject('it-s' + i + '-x')).toBe(true);
    ['comnet', 'book-linux-net', '卖点讨论', '学习链路-7书', 'it', 'probe-foo'].forEach((n) => {
      expect(grade.isProbeProject(n), n + ' 被误判成探针了').toBe(false);
    });
  });
});

describe('J · 确定性：判据自己不许引入时变源', () => {
  it('同一输入两次 → 逐字节相同的 JSON', () => {
    const o = { project: 'p', src: 'a.md', tool: 'import-md', replayTopics: ['A', 'B'], actualTopics: ['A'] };
    expect(JSON.stringify(grade.gradeOne(o))).toBe(JSON.stringify(grade.gradeOne(o)));
  });

  it('模块源码里没有 Date.now / Math.random / new Date（静态把守）', () => {
    const src = fs.readFileSync(path.join(REPO, 'src', 'import-grade.js'), 'utf8');
    // 注释里可以提到这些词（本文档就要解释"为什么不读时钟"）⇒ 只扫**代码行**（去掉行注释与块注释后）
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(/Date\.now/.test(code), 'src/import-grade.js 的代码里出现了 Date.now').toBe(false);
    expect(/Math\.random/.test(code), 'src/import-grade.js 的代码里出现了 Math.random').toBe(false);
    expect(/new Date\b/.test(code), 'src/import-grade.js 的代码里出现了 new Date').toBe(false);
  });

  it('markdownToTree 的重放用确定性 id 桩：同一份 md 两次重放给出同一序列', () => {
    const md = '# A\n## B\n# C\n';
    expect(JSON.stringify(grade.replayTopics(md))).toBe(JSON.stringify(grade.replayTopics(md)));
    // 反向对照：真 idGen 会读时钟+随机（那是既有事实，不是本模块的问题）
    const t1 = markdown.markdownToTree(md, '__x__');
    const t2 = markdown.markdownToTree(md, '__x__');
    expect(t1.data.children[0].id).not.toBe(t2.data.children[0].id);
  });
});

describe('K · 概念覆盖率（台账 E5-4：contents 的输出进 W15 的指标）', () => {
  /* 判据（本组钉的就是它）：**源文里的概念，有多少在盘上的树里有对应落点节点**。
   * 为什么需要这一维：`precision / recall` 比的是**标题序列**，概念覆盖率比的是**概念序列** ——
   * 标题被改写成更长的形式时前者掉分、后者不掉分（反过来，真的丢了一章时两者都掉）。 */
  const tree = {
    id: 'root', topic: 'R',
    children: [
      { id: 'a', topic: '1.2 收包路径', detail: '正文' },
      { id: 'b', topic: '进程调度', detail: '正文' }
    ]
  };

  it('概念名：去章节号、同名合并、保留第一次出现的显示名、排序确定', () => {
    const names = grade.conceptNamesOf(['1.2 收包路径', '收包路径', '第3章 进程调度', 'Socket API']);
    expect(names.map((x) => x.key)).toEqual(['socket api', '收包路径', '进程调度']);
    expect(names.map((x) => x.name)).toEqual(['Socket API', '收包路径', '进程调度']);
    expect(JSON.stringify(grade.conceptNamesOf(['a', 'b']))).toBe(JSON.stringify(grade.conceptNamesOf(['b', 'a'])));
  });

  it('分母 = 源文概念数、分子 = 其中落成节点的；**没落成的逐条点名**（不给百分比了事）', () => {
    const cov = grade.conceptCoverage(tree, [grade.conceptNamesOf(['收包路径', '没落成的概念'])]);
    expect(cov.conceptsInSources).toBe(2);
    expect(cov.matched).toBe(1);
    expect(cov.coverage).toBe(0.5);
    expect(cov.missingCount).toBe(1);
    expect(cov.missing).toEqual(['没落成的概念']);
  });

  it('判别力（正对照）：同一棵树，源文换成两份**都落成**的 ⇒ coverage = 1', () => {
    const cov = grade.conceptCoverage(tree, [
      grade.conceptNamesOf(['1.2 收包路径']),
      grade.conceptNamesOf(['进程调度'])
    ]);
    expect(cov.conceptsInSources).toBe(2);      // 两份源文取并集，不重复计
    expect(cov.matched).toBe(2);
    expect(cov.coverage).toBe(1);
    expect(cov.missing).toEqual([]);
  });

  it('它答的是 precision/recall 答不了的那一问（标题对不上、概念落成了）', () => {
    // 标题层面：源文写「1.1 收包路径」、树上写成「收包路径」⇒ 多重集交 = 0 ⇒ recall = 0
    const row = grade.gradeOne({
      project: 'p', src: 'a.md', tool: 'import-md',
      replayTopics: ['1.1 收包路径'], actualTopics: ['收包路径']
    });
    expect(row.recall).toBe(0);
    // 概念层面：两条标题折叠成同一个概念 ⇒ 100% 落成
    expect(grade.conceptCoverage(tree, [grade.conceptNamesOf(['1.1 收包路径'])]).coverage).toBe(1);
  });

  it('没得判时是 null，不是 0（源文概念 0 个 ≠ 一个都没落成）', () => {
    const cov = grade.conceptCoverage(tree, []);
    expect(cov.conceptsInSources).toBe(0);
    expect(cov.coverage).toBe(null);
    expect(cov.missing).toEqual([]);
  });

  it('「什么算一个概念」共用一处实现：盘上那一侧逐字来自 mentions.conceptCatalog', () => {
    const direct = mentions.conceptCatalog(tree, { selfProject: '' });
    const cov = grade.conceptCoverage(tree, [], { selfProject: '' });
    expect(cov.concepts).toBe(direct.concepts);
    expect(cov.scanned).toBe(direct.scanned);
    expect(cov.carriers).toBe(direct.carriers);
    expect(cov.mentions).toBe(direct.mentions);
    expect(cov.duplicates).toBe(direct.duplicates);
  });

  it('汇总走微平均（概念数相加），没得判时 null', () => {
    const s = grade.summarizeConceptCoverage([
      { conceptsInSources: 10, matched: 10, concepts: 20, mentions: 3 },
      { conceptsInSources: 10, matched: 5, concepts: 8, mentions: 1 }
    ]);
    expect(s.conceptsInSources).toBe(20);
    expect(s.matched).toBe(15);
    expect(s.coverage).toBe(0.75);          // 0.75 而不是 (1 + 0.5) / 2 = 0.75 恰好相同，故另给一条分母不等的
    const s2 = grade.summarizeConceptCoverage([
      { conceptsInSources: 1, matched: 1, concepts: 1, mentions: 0 },
      { conceptsInSources: 99, matched: 0, concepts: 9, mentions: 0 }
    ]);
    expect(s2.coverage).toBe(0.01);         // 各行平均会是 0.5 ⇒ 微平均确实不是"平均"
    expect(grade.summarizeConceptCoverage([]).coverage).toBe(null);
  });

  it('浏览器端没加载 src/mentions.js ⇒ 概念相关函数**响亮报**，纯算术那半照旧（不静默返回空）', () => {
    const sb = browserSandbox(['convert.js', 'markdown.js', 'import-grade.js']);   // 刻意不加载 mentions.js
    expect(typeof sb.MMImportGrade.conceptCoverage).toBe('function');
    expect(() => sb.MMImportGrade.conceptCoverage(tree, [])).toThrow(/需要 src\/mentions\.js/);
    expect(() => sb.MMImportGrade.conceptNamesOf(['a'])).toThrow(/需要 src\/mentions\.js/);
    // 对照：加载了 mentions.js 的沙箱里同一调用能用（否则上面那条只是"永远抛"，不分辨）
    const sb2 = browserSandbox(['convert.js', 'markdown.js', 'mentions.js', 'import-grade.js']);
    expect(sb2.MMImportGrade.conceptNamesOf(['1.2 收包路径'])[0].key).toBe('收包路径');
  });

  it('确定性：同一入参两次 → 逐字节相同（本模块不许引入时变源）', () => {
    const one = () => JSON.stringify(grade.conceptCoverage(tree, [grade.conceptNamesOf(['收包路径', 'X', 'Y'])]));
    expect(one()).toBe(one());
  });
});
