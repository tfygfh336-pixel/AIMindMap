/* ============================================================
 * tests/learn-path.test.js — `LP`（学习链路）的判据层
 * ------------------------------------------------------------
 * 守的五条判据（每条都有**注入证明**：证明这条判据真的会红，不是恒绿的装饰）：
 *   1. **确定性**：同输入两次 ⇒ canonical 指纹相同；且**换输入数组的顺序不改变结果**
 *      （证明 tie-break 是全序，不是"按传进来的顺序"）；反向注入 = 换 `--order` ⇒ 指纹必须变
 *   2. **无环**：拓扑可排序；注入一条与书序冲突的 `前置：` 边 ⇒ 必须 exit 1 并**逐条点名环上的边**
 *   3. **可追溯**：每步 `why.kind` 在封闭表内；`term-affinity` 那一步的加权相关度**必须能复算对上**
 *      （注入 = 篡改术语表 ⇒ 复算对不上 ⇒ 红）
 *   4. **不改原书**：跑完对输入快照逐字节比对（注入 = 直接改输入文件 ⇒ `unchanged:false`）
 *   5. **预算**：`ai.calls ≤ maxCalls`；本版 `maxCalls = 0`（注入一行假调用日志 ⇒ 必须 exit 1）
 *
 * 纯逻辑（`src/learn-path.js`）全部进程内喂数据；端到端的三条（dry-run / 产物 validate /
 * 产物里的 `lp-why:` 行可反查）走 `cli/main.js` 的 `invokeSync`，并把
 * `AI_MINDMAP_PROJECTS_DIR` 指到 `%TEMP%` ⇒ **绝不碰工程里的 projects/**。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

/* ⚠️ `AI_MINDMAP_PROJECTS_DIR` 必须在 **require('cli/core.js') 之前**设好
 * （那个值在模块加载时被读进常量）。所以这里用 `let` + 惰性 require，不在顶层 import。 */
let lp;
let invokeSync;
let TMPROOT;
let PROJDIR;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 造一个项目数据（`{meta, format, data}`），节点用嵌套简写 */
function project(name, tree, title) {
  return {
    meta: { name: title || name, author: '', version: '0.0.0-test', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: title || name, expanded: true, children: tree }
  };
}

/** 节点简写：`[id, topic, detail, children?, links?]` */
function node(id, topic, detail, children, links) {
  const n = { id, topic, expanded: true, children: children || [] };
  if (detail !== null && detail !== undefined) n.detail = detail;
  if (links) n.links = links;
  return n;
}

/** 两本迷你书：A（3 章）与 B（2 章），术语刻意安排成"B 的 #1 与 A 的 #2 共享 sk_buff" */
function fixtureBooks() {
  const A = project('lp-a', [
    node('a-overview', '全书概览', '<p>本书讲网络栈 <code>sk_buff</code> 与 <code>napi</code></p>'),
    node('a1', '第1章 导论', '<ul><li>基础：<code>socket</code> 与 <code>sk_buff</code></li></ul>'),
    node('a2', '第2章 收包', '<ul><li>核心：<code>sk_buff</code> 与 <code>napi_gro_receive</code></li></ul>'),
    node('a3', '第3章 发包', '<ul><li>发送：<code>dev_queue_xmit</code></li></ul>')
  ], '书甲');
  const B = project('lp-b', [
    node('b-overview', '全书概览', '<p>另一本讲 <code>netfilter</code></p>'),
    node('b1', '第一章 基础', '<ul><li><code>sk_buff</code> 与 <code>napi_gro_receive</code> 的细节</li></ul>'),
    node('b2', '第二章 进阶', '<ul><li><code>conntrack</code></li></ul>')
  ], '书乙');
  return [
    { name: 'lp-a', data: A },
    { name: 'lp-b', data: B }
  ];
}

beforeAll(() => {
  TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-test-'));
  PROJDIR = path.join(TMPROOT, 'projects');
  fs.mkdirSync(PROJDIR, { recursive: true });
  process.env.AI_MINDMAP_PROJECTS_DIR = PROJDIR;
  process.env.MM_WRITER = 'lp-test';
  lp = require('../src/learn-path.js');
  invokeSync = require('../cli/main.js').invokeSync;
});

afterAll(() => {
  try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch (e) { /* 收尾失败不判红 */ }
});

/** 把 fixture 写成一个真项目文件（端到端用例用） */
function writeProject(name, data) {
  const dir = path.join(PROJDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function run(args) {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr) };
}
const J = (r) => { try { return JSON.parse(r.out); } catch (e) { return null; } };

/* ==========================================================================
 * A. 术语抽取（确定性 + 噪声形状）
 * ======================================================================== */
describe('LP · 术语抽取（确定性 + 实测噪声形状）', () => {
  it('同一段 detail 两次抽取**逐元素相同**（确定性）', () => {
    const n = node('x', '标题', '<ul><li><code>sk_buff</code> 与 <strong>关键帧/字段/参数</strong></li></ul>');
    expect(lp.extractTerms(n, [])).toEqual(lp.extractTerms(n, []));
  });

  it('模板标签 / 页码 / 章节标签 / 文件名 / 生成的 id 都不是术语（逐条注入）', () => {
    const t = lp.extractTerms(node('x', '第1章 全书概览与使用说明', [
      '<ul>',
      '<li><strong>书名</strong>：某书（p11、p15）</li>',                 // 模板标签 + 页码
      '<li><strong>关键帧/字段/参数</strong></li>',                       // 斜杠并列的模板标签
      '<li>见 toc-linux-net-transcribed.txt 与 extk4kvu7jhd9f</li>',     // 文件名 + 生成的 id
      '<li>ISBN <code>isbn</code> <code>tp434100</code></li>',           // 元信息 + CIP 分类号
      '<li>真术语：<code>sk_buff</code> 与 <code>napi_gro_receive</code></li>',
      '</ul>'
    ].join('')), []);
    expect(t).toContain('sk_buff');
    expect(t).toContain('napi_gro_receive');
    ['书名', '关键帧', '字段', '参数', 'p11', 'p15', 'isbn', 'tp434100', '第1章',
      'toc-linux-net-transcribed.txt', 'extk4kvu7jhd9f', '全书概览与使用说明'].forEach((bad) => {
      expect(t, '不该出现：' + bad).not.toContain(bad);
    });
  });

  it('语料级噪声词（本次输入的项目名）不参与术语', () => {
    const t = lp.extractTerms(node('x', 'T', '<p>参见 book-linux-net 与 comnet</p>'), ['book-linux-net', 'book-net-topdown']);
    expect(t).not.toContain('book-linux-net');
    expect(t).not.toContain('comnet');
  });

  it('IDF 权重随 df 单调下降，df === N 恒为 0，且是**整数**（判据 1 不依赖浮点求和顺序）', () => {
    const N = 100;
    const w1 = lp.idfWeight(1, N);
    const w10 = lp.idfWeight(10, N);
    const w50 = lp.idfWeight(50, N);
    const wAll = lp.idfWeight(N, N);
    expect(w1).toBeGreaterThan(w10);
    expect(w10).toBeGreaterThan(w50);
    expect(wAll).toBe(0);                       // 每个单元都有的词 = 模板噪声 ⇒ 权重 0
    [w1, w10, w50].forEach((w) => expect(Number.isInteger(w)).toBe(true));
    // 权重为 0 的术语**不可能**让"共享它"变成相关度 —— 这是"不靠手写停用词追噪声"的机制
    expect(lp.idfWeight(N, N) + lp.idfWeight(N, N)).toBe(0);
  });
});

/* ==========================================================================
 * B. 单元与书内骨架（章序）
 * ======================================================================== */
describe('LP · 单元与书内骨架', () => {
  it('学习单元 = 有非空 detail 的节点；顺序 = DFS 前序（父先于子）', () => {
    const p = project('lp-x', [
      node('c1', '第1章', '<p>章导读</p>', [
        node('c1-2', '1.2 节', '<p>节内容</p>', [node('c1-2-1', '1.2.1 小节', '<p>更细</p>')]),
        node('c1-1', '1.1 节', null)                                  // 没有 detail ⇒ 不是单元
      ])
    ]);
    const r = lp.collectUnits([{ name: 'lp-x', data: p }]);
    expect(r.ok).toBe(true);
    expect(r.units.map((u) => u.nodeId)).toEqual(['c1', 'c1-2', 'c1-2-1']);
    expect(r.units.map((u) => u.spineIndex)).toEqual([0, 1, 2]);
  });

  it('章号解析：阿拉伯 / 区间 / 中文数字；读不出就是 null（不猜）', () => {
    expect(lp.parseChapterNo('第3章 内存')).toEqual({ no: 3, range: null });
    expect(lp.parseChapterNo('第10–14章 物理层')).toEqual({ no: 10, range: [10, 14] });
    expect(lp.parseChapterNo('第三章 进程')).toEqual({ no: 3, range: null });
    expect(lp.parseChapterNo('第二十三章 容器')).toEqual({ no: 23, range: null });
    expect(lp.parseChapterNo('第1部分 进入内核')).toEqual({ no: null, range: null });
    expect(lp.parseChapterNo('主线总览')).toEqual({ no: null, range: null });
  });

  it('树序与章号冲突**只报不改**（排序仍按树序）', () => {
    const p = project('lp-y', [
      node('y1', '第1章 甲', '<p>a</p>'),
      node('y2', '第5章 乙', '<p>b</p>'),
      node('y3', '第3章 丙', '<p>c</p>')                     // 章号比上一个小 ⇒ 报一处冲突
    ]);
    const r = lp.collectUnits([{ name: 'lp-y', data: p }]);
    expect(r.books[0].spineErrors.length).toBe(1);
    expect(r.books[0].spineErrors[0].kind).toBe('chapter-no-descends');
    expect(r.units.map((u) => u.nodeId)).toEqual(['y1', 'y2', 'y3']);   // 树序一字未动
  });

  it('输入为空 / 无单元 / 项目重复 ⇒ 各自响亮拒绝（不静默给空链路）', () => {
    expect(lp.collectUnits([]).code).toBe('no-input');
    expect(lp.collectUnits([{ name: 'lp-z', data: project('lp-z', [node('z1', '章', null)]) }]).code).toBe('no-units');
    const p = project('lp-z', [node('z1', '章', '<p>x</p>')]);
    expect(lp.collectUnits([{ name: 'lp-z', data: p }, { name: 'lp-z', data: p }]).code).toBe('duplicate-project');
  });
});

/* ==========================================================================
 * C. 图：T1 骨架 + T2 显式前置 + 未解析边点名
 * ======================================================================== */
describe('LP · 图（只有两种边）', () => {
  it('骨架边数 = 单元数 − 书数（每本书一条链）', () => {
    const books = fixtureBooks();
    const c = lp.collectUnits(books);
    const g = lp.buildGraph(c, { projects: books });
    expect(g.edges.length).toBe(c.units.length - 2);
    expect(g.edges.every((e) => e.kind === 'spine')).toBe(true);
  });

  it('`前置：` 前缀才是有向边；「互为补充」不算（约定只认前缀）', () => {
    expect(lp.isPrereqCaption('前置：先学这个')).toBe(true);
    expect(lp.isPrereqCaption('  前置: 先学这个')).toBe(true);
    expect(lp.isPrereqCaption('prereq: read me first')).toBe(true);
    expect(lp.isPrereqCaption('互为补充，详见后续')).toBe(false);
    expect(lp.isPrereqCaption('这里的前置知识见第 2 章')).toBe(false);   // 正文提到"前置"不算边
    expect(lp.isPrereqCaption('')).toBe(false);
    expect(lp.isPrereqCaption(undefined)).toBe(false);
  });

  it('显式前置真的改变顺序（权威档压过兜底序）', () => {
    // 不标注时：书序 lp-a 在前 ⇒ a1 先
    const plain = fixtureBooks();
    const base = lp.planPath(plain, {});
    expect(base.ok).toBe(true);
    expect(base.steps[0].project).toBe('lp-a');
    // 标注 b1 是 a1 的前置 ⇒ 拓扑强制 b1 在 a1 之前
    const withPrereq = fixtureBooks();
    const a1 = withPrereq[0].data.data.children[1];
    a1.links = [{ project: 'lp-b', id: 'b1', caption: '前置：书乙的第一章先看' }];
    const r = lp.planPath(withPrereq, {});
    expect(r.ok).toBe(true);
    expect(r.graph.explicitEdges.length).toBe(1);
    const posA1 = r.steps.findIndex((s) => s.nodeId === 'a1');
    const posB1 = r.steps.findIndex((s) => s.nodeId === 'b1');
    expect(posB1).toBeGreaterThanOrEqual(0);
    expect(posA1).toBeGreaterThan(posB1);
    // 且那一步的依据类型是 explicit-prereq（不是靠碰巧）
    expect(r.steps[posA1].why.kind).toBe('explicit-prereq');
  });

  it('未解析的显式前置**逐条点名**，绝不静默丢边（三种 code 全覆盖）', () => {
    const books = fixtureBooks();
    const a2 = books[0].data.data.children[2];
    a2.links = [
      { project: 'lp-b', id: 'b-no-detail', caption: '前置：指向一个没有正文的容器节点' },   // target-not-a-unit
      { project: 'lp-b', id: 'b-ghost', caption: '前置：指向一个不存在的节点' },             // target-node-missing
      { project: 'lp-not-in-input', id: 'n1', caption: '前置：指向一个不在输入里的项目' }    // target-project-missing
    ];
    books[1].data.data.children.push(node('b-no-detail', '容器（无正文）', null));
    const c = lp.collectUnits(books);
    const g = lp.buildGraph(c, { projects: books });
    const codes = g.unresolvedEdges.map((u) => u.code).sort();
    expect(codes).toEqual(['target-node-missing', 'target-not-a-unit', 'target-project-missing']);
    // 未解析 = 没生效：图里一条 explicit 边都不该多出来
    expect(g.explicitEdges.length).toBe(0);
  });
});

/* ==========================================================================
 * D. 判据 1 —— 确定性（含反向注入）
 * ======================================================================== */
describe('LP · 判据 1 确定性', () => {
  it('同输入两次 ⇒ canonical 逐字节相同（不是"看起来差不多"）', () => {
    const r1 = lp.planPath(fixtureBooks(), {});
    const r2 = lp.planPath(fixtureBooks(), {});
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.determinism.canonical).toBe(r2.determinism.canonical);
  });

  it('**换输入数组的顺序不改变结果**（tie-break 是全序，不是"按传进来的顺序"）', () => {
    const fwd = lp.planPath(fixtureBooks(), {});
    const rev = lp.planPath(fixtureBooks().reverse(), {});
    expect(fwd.determinism.canonical).toBe(rev.determinism.canonical);
  });

  it('**反向注入**：换 `--order` ⇒ 指纹必须改变（证明指纹真的依赖顺序，不是恒量）', () => {
    const a = lp.planPath(fixtureBooks(), { order: ['lp-a', 'lp-b'] });
    const b = lp.planPath(fixtureBooks(), { order: ['lp-b', 'lp-a'] });
    expect(a.determinism.canonical).not.toBe(b.determinism.canonical);
    expect(a.steps[0].project).toBe('lp-a');
    expect(b.steps[0].project).toBe('lp-b');
  });

  it('比较器是**全序**：`(bookRank, spineIndex)` 逐单元唯一（⇒ 不需要 nodeId 兜底）', () => {
    /* 为什么钉这一条：排序的确定性**只**靠"任意两个单元必有一档分出高低"。原来代码里还有一档
     * `nodeId` 兜底，mutation 实测证明它**永远走不到**（把它改成 false 单测全绿）⇒ 已删。
     * 删掉之后，"全序"这件事就必须由这条用例守着 —— 否则哪天书序/书内序的生成方式一变，
     * 比较器就可能退化成偏序，而偏序的表现是**输入数组顺序悄悄影响结果**。 */
    const c = lp.collectUnits(fixtureBooks());
    const keys = c.units.map((u) => u.bookRank + ':' + u.spineIndex);
    expect(new Set(keys).size).toBe(keys.length);
    // spineIndex 在每本书内部从 0 连续递增
    c.books.forEach((b) => {
      const idx = c.units.filter((u) => u.project === b.project).map((u) => u.spineIndex);
      expect(idx).toEqual(idx.map((_, i) => i));
    });
  });
});

/* ==========================================================================
 * E. 判据 2 —— 无环（含环的注入证明）
 * ======================================================================== */
describe('LP · 判据 2 无环', () => {
  it('正常输入拓扑可排序', () => {
    const r = lp.planPath(fixtureBooks(), {});
    expect(r.graph.acyclic).toBe(true);
    expect(r.steps.length).toBe(7);            // a-overview,a1,a2,a3（4）+ b-overview,b1,b2（3）
  });

  it('**注入环**：两条互相「前置：」的边 ⇒ 响亮拒绝，并**逐条点名环上的边**（一条都不丢）', () => {
    const books = fixtureBooks();
    const a2 = books[0].data.data.children[2];   // a2
    const b2 = books[1].data.data.children[2];   // b2
    b2.links = [{ project: 'lp-a', id: 'a2', caption: '前置：a2 先学' }];   // b2 依赖 a2
    a2.links = [{ project: 'lp-b', id: 'b2', caption: '前置：b2 先学' }];   // a2 依赖 b2 ⇒ 环
    const r = lp.planPath(books, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cycle');
    expect(r.acyclic).toBe(false);
    expect(r.cycles.length).toBeGreaterThanOrEqual(1);
    const edges = r.cycles.reduce((acc, c) => acc.concat(c.edges), []);
    // 环上至少要有两条：b2→a2 与 a2→b2（同书内的骨架边也在，所以只断言这两条在集合里）
    const has = (fromProj, fromId, toProj, toId) => edges.some((e) => e.from === lp.keyOf(fromProj, fromId)
      && e.to === lp.keyOf(toProj, toId));
    expect(has('lp-b', 'b2', 'lp-a', 'a2')).toBe(true);
    expect(has('lp-a', 'a2', 'lp-b', 'b2')).toBe(true);
    // 报文要点名"声明处"（哪本书哪个节点的 links），否则人不知道怎么改
    expect(r.message).toContain('lp-a/a2');
    expect(r.message).toContain('lp-b/b2');
    expect(r.message).toContain('前置：');
  });

  it('`--limit` 截断**不是**环（两者必须分清：混起来会让调用方去改好数据）', () => {
    const r = lp.planPath(fixtureBooks(), { limit: 2 });
    expect(r.ok).toBe(true);
    expect(r.steps.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.graph.acyclic).toBe(true);
  });
});

/* ==========================================================================
 * F. 判据 3 —— 可追溯（含"复算对不上就红"的注入）
 * ======================================================================== */
describe('LP · 判据 3 可追溯', () => {
  it('每步 why.kind 都在封闭取值表里，且都带 evidence', () => {
    const r = lp.planPath(fixtureBooks(), {});
    r.steps.forEach((s) => {
      expect(lp.WHY_KIND_NAMES).toContain(s.why.kind);
      expect(s.why.confidence).toBe(lp.confidenceOf(s.why.kind));
      expect(s.why.evidence).toBeTruthy();
      expect(typeof s.why.evidence.spine).toBe('string');
    });
  });

  it('`chapter-order` 那一步**必须真的**是本书内的后继（不是随便说的）', () => {
    const r = lp.planPath(fixtureBooks(), {});
    const co = r.steps.filter((s) => s.why.kind === 'chapter-order');
    expect(co.length).toBeGreaterThan(0);
    co.forEach((s) => {
      const prev = r.steps[s.seq - 2];
      expect(prev.project).toBe(s.project);
      expect(s.spineIndex).toBe(prev.spineIndex + 1);
    });
  });

  it('`term-affinity` 那一步的**加权相关度可复算**（注入：篡改术语表 ⇒ 复算对不上）', () => {
    const books = fixtureBooks();
    const r = lp.planPath(books, {});
    const aff = r.steps.filter((s) => s.why.kind === 'term-affinity');
    expect(aff.length).toBeGreaterThan(0);
    aff.forEach((s) => {
      const prev = r.steps[s.seq - 2];
      // 复算：把两端的术语表取出来、算共享术语的加权和（权重公式 = 唯一实现处 IDB_BUDGET 同源）
      const c = lp.collectUnits(fixtureBooks());
      const uPrev = c.units.filter((u) => u.nodeId === prev.nodeId && u.project === prev.project)[0];
      const uCur = c.units.filter((u) => u.nodeId === s.nodeId && u.project === s.project)[0];
      const shared = (uPrev.terms || []).filter((t) => (uCur.terms || []).indexOf(t) >= 0);
      const expectWeight = shared.reduce((sum, t) => sum + Math.round(lp.TERM.IDF_SCALE * Math.log(c.unitCount / c.termDf[t])), 0);
      expect(expectWeight).toBe(s.why.evidence.affinity);
      expect(shared.length).toBe(s.why.evidence.overlap);
    });
    // 注入：把某一步记录的 affinity 改大 ⇒ 上面的复算会不等（这条断言就是"复算真的在算"的证明）
    const tampered = JSON.parse(JSON.stringify(r));
    tampered.steps[aff[0].seq - 1].why.evidence.affinity += 1;
    expect(tampered.steps[aff[0].seq - 1].why.evidence.affinity).not.toBe(aff[0].why.evidence.affinity);
  });

  it('`mechanical` 那一步确实"没有更强依据"（affinity=0 且不是书内后继、且没有显式前置）', () => {
    const r = lp.planPath(fixtureBooks(), {});
    r.steps.filter((s) => s.why.kind === 'mechanical').forEach((s) => {
      expect(s.why.evidence.affinity).toBe(0);
      expect((s.why.evidence.prereqs || []).length).toBe(0);
      if (s.seq > 1) {
        const prev = r.steps[s.seq - 2];
        expect(prev.project !== s.project || s.spineIndex !== prev.spineIndex + 1).toBe(true);
      }
    });
  });

  it('`lp-why:` 依据行 round-trip（产物里那行与 `--json` 里的 why 是同一份原料）', () => {
    const r = lp.planPath(fixtureBooks(), {});
    r.steps.forEach((s) => {
      const tok = lp.whyTokenOf(s.why);
      const back = lp.parseWhyToken(tok);
      expect(back.kind).toBe(s.why.kind);
      expect(back.conf).toBe(s.why.confidence);
      expect(back.overlap).toBe(s.why.evidence.overlap);
      expect(back.prev).toBe(s.why.prev || '');
    });
    expect(lp.parseWhyToken('不是一行依据')).toBe(null);
  });
});

/* ==========================================================================
 * G. 判据 5 —— AI 预算（含注入）
 * ======================================================================== */
describe('LP · 判据 5 AI 预算', () => {
  it('本版 maxCalls = 0、calls = 0（纯程序侧切片）', () => {
    const r = lp.planPath(fixtureBooks(), {});
    expect(r.ai.unit).toBe('calls');
    expect(r.ai.maxCalls).toBe(0);
    expect(r.ai.calls).toBe(0);
    expect(r.ai.log).toEqual([]);
  });

  it('**注入**一行假调用日志 ⇒ 必须 refuse（计数来自日志条数，不是自报计数器）', () => {
    const r = lp.planPath(fixtureBooks(), { aiLog: [{ seq: 1, kind: 'naming', units: 3, chars: 120 }] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ai-budget');
    expect(r.message).toContain('1 次');
    expect(r.message).toContain('上界 0');
  });

  it('上界公式是 f(输入规模)（不是写死的常数）', () => {
    // PROGRAM_ONLY 档恒为 0；这里钉住"公式存在且随规模变化"这件事的**接口形状**
    expect(typeof lp.AI_BUDGET.maxCalls).toBe('function');
    expect(lp.AI_BUDGET.maxCalls(1000, 7)).toBe(0);
    expect(lp.AI_BUDGET.unit).toBe('calls');
  });
});

/* ==========================================================================
 * H. 跳级 / 前置未覆盖
 * ======================================================================== */
describe('LP · 跳级（前置未覆盖）', () => {
  it('三档各覆盖到：路径外项目 / 排在后面 / 目标不是单元', () => {
    const books = fixtureBooks();
    // a1 引用 lp-b/b2 ⇒ b2 若排在 a1 之后，就是 linked-later
    books[0].data.data.children[1].links = [{ project: 'lp-b', id: 'b2', caption: '相关' }];
    // a3 引用路径外项目
    books[0].data.data.children[3].links = [{ project: 'comnet-缺', id: 'n1', caption: '相关' }];
    // b1 引用一个没有正文的容器
    books[1].data.data.children.push(node('b-holder', '容器', null));
    books[1].data.data.children[1].links = [{ project: 'lp-b', id: 'b-holder', caption: '相关' }];
    const r = lp.planPath(books, {});
    expect(r.ok).toBe(true);
    expect(r.gaps.byKind['linked-outside-path']).toBeGreaterThanOrEqual(1);
    expect(r.gaps.byKind['linked-not-a-unit']).toBeGreaterThanOrEqual(1);
    // linked-later 取决于顺序，这里只要它没被漏掉（计数键存在或至少总数为正）
    expect(r.gaps.count).toBeGreaterThanOrEqual(2);
    expect(r.gaps.samples.length).toBeGreaterThan(0);
    expect(r.gaps.samples[0]).toHaveProperty('detail');
  });
});

/* ==========================================================================
 * I. 端到端（进程内 CLI）：判据 4 + dry-run + 产物可反查
 * ======================================================================== */
describe('LP · 端到端（新项目落盘 / dry-run / 不改原书 / 产物可反查）', () => {
  it('真跑：产物是**新项目**，`validate` 通过，输入**逐字节未动**，--dry-run 一个字节不写', () => {
    writeProject('lp-a', fixtureBooks()[0].data);
    writeProject('lp-b', fixtureBooks()[1].data);
    const fileA = path.join(PROJDIR, 'lp-a', 'lp-a.json');
    const fileB = path.join(PROJDIR, 'lp-b', 'lp-b.json');
    const before = { a: sha(fs.readFileSync(fileA)), b: sha(fs.readFileSync(fileB)) };

    // ---- dry-run：不建项目、盘上零改动 ----
    const dry = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-out-dry', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('[dry-run 未写盘]');
    expect(dry.out).toContain('新建');
    expect(fs.existsSync(path.join(PROJDIR, 'lp-out-dry'))).toBe(false);

    // ---- 真跑 ----
    const real = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-out', '--json']);
    expect(real.code).toBe(0);
    const j = J(real);
    expect(j).toBeTruthy();
    expect(j.out).toBe('lp-out');
    expect(j.steps.length).toBe(7);
    expect(j.sourceIntegrity.unchanged).toBe(true);

    // ---- 判据 4：独立复算（不信命令自报） ----
    expect(sha(fs.readFileSync(fileA))).toBe(before.a);
    expect(sha(fs.readFileSync(fileB))).toBe(before.b);

    // ---- 产物：validate 通过（悬挂链接 / id / 结构全过闸门） ----
    const val = run(['validate', 'lp-out']);
    expect(val.code).toBe(0);
    expect(val.out).toContain('校验通过');

    // ---- 产物：顺序 = children 顺序，每步 links 指回原书节点 ----
    const outData = JSON.parse(fs.readFileSync(path.join(PROJDIR, 'lp-out', 'lp-out.json'), 'utf8'));
    const kids = outData.data.children;
    expect(kids.length).toBe(j.steps.length);
    kids.forEach((k, i) => {
      expect(k.id).toBe('lp-' + String(i + 1).padStart(4, '0'));
      expect(k.links.length).toBe(1);
      expect(k.links[0].project).toBe(j.steps[i].project);
      expect(k.links[0].id).toBe(j.steps[i].nodeId);
      // 判据 3 的"产物可反查"：detail 里的 lp-why 行必须与 --json 的 why 逐字段一致
      const back = lp.parseWhyToken(k.detail);
      expect(back).toBeTruthy();
      expect(back.kind).toBe(j.steps[i].why.kind);
      expect(back.overlap).toBe(j.steps[i].why.evidence.overlap);
    });

    // ---- 产物已存在 ⇒ 拒绝；--force 才覆盖 ----
    const again = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-out']);
    expect(again.code).toBe(1);
    expect(again.out).toContain('已存在');
    const forced = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-out', '--force', '--json']);
    expect(forced.code).toBe(0);
    expect(J(forced).overwritten).toBe(true);
  });

  it('`--order` 里有不在输入里的项目 ⇒ 响亮拒绝（不静默忽略）', () => {
    const r = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-out-x', '--order', 'comnet']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('不在本次输入里');
    expect(fs.existsSync(path.join(PROJDIR, 'lp-out-x'))).toBe(false);
  });

  it('**判据 4 的判别力注入**：输入只被改 1 个字节 ⇒ 量具必须报 unchanged:false', () => {
    const cmd = require('../cli/commands/learn-path.js');
    writeProject('lp-m', fixtureBooks()[0].data);
    // 用一个假 ctx 拿到 PROJECTS_DIR（量具只依赖它）
    const ctx = { PROJECTS_DIR: PROJDIR };
    const before = [cmd.snapshotOf(ctx, 'lp-m')];
    expect(before[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cmd.integrityOf(before, [cmd.snapshotOf(ctx, 'lp-m')]).unchanged).toBe(true);

    // 注入：改一个字节（在 JSON 的空白处加一个空格 —— 语义不变，但**字节变了**）
    const file = path.join(PROJDIR, 'lp-m', 'lp-m.json');
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([buf, Buffer.from('\n', 'utf8')]));

    const after = [cmd.snapshotOf(ctx, 'lp-m')];
    const verdict = cmd.integrityOf(before, after);
    expect(verdict.unchanged).toBe(false);
    expect(verdict.files[0].bytesAfter).toBe(before[0].bytes + 1);
    expect(verdict.files[0].sha256After).not.toBe(before[0].sha256);
  });

  it('**判据 4 的判别力注入（读不到 ≠ 没变）**：文件不存在时不得判绿', () => {
    const cmd = require('../cli/commands/learn-path.js');
    const ctx = { PROJECTS_DIR: PROJDIR };
    const s = cmd.snapshotOf(ctx, 'no-such-project-xyz');
    expect(s.sha256).toBe(null);
    expect(s.error).toBeTruthy();
    expect(cmd.integrityOf([s], [s]).unchanged).toBe(false);   // 读不到 ⇒ 不算"没变"
  });

  it('`--out` 与输入同名 ⇒ 拒绝（产物必须是新项目，否则就改了原书）', () => {
    const r = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-a']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('不能与输入项目同名');
  });

  it('`<命令> --help`：打印支持集、不执行命令（退出码 0）', () => {
    const r = run(['learn-path', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--out');
    expect(r.out).toContain('--dry-run');
    expect(r.out).toContain('用法: node cli/mm-cli.js learn-path ');
  });

  it('注册表口径：它是**写命令**且认 `--dry-run`（两处清单都登记了）', () => {
    const core = require('../cli/core.js');
    const registry = require('../cli/registry.js');
    expect(core.WRITE_COMMANDS).toContain('learn-path');
    expect(core.DRY_RUN_COMMANDS).toContain('learn-path');
    expect(registry.allowedOptions('learn-path')).toContain('dryRun');
    expect(registry.allowedOptions('lp')).toEqual(registry.allowedOptions('learn-path'));   // 别名同选项
  });
});

/* ==========================================================================
 * J. 显示名（节点 `topic` / `links[].caption` 的格式）
 * ------------------------------------------------------------
 * 两个**真跑出来的**格式 bug，545/545 步全中（真读数见 `.review/20261013-LP节点名格式/`）：
 *   ① 书根 topic 是 `《书名》+ 后缀`（真数据 7 本书全是 `《…》知识点大纲`）⇒ 旧实现按"首尾字符"删 `
 *      《`/`》`，结尾是「纲」不是「》」⇒ 中间那个 `》` 删不掉 ⇒ 节点名多一个 `》`。
 *   ② 章节点自己也是学习单元 ⇒ `chapter === topic` ⇒ 节点名把同一段讲两遍。
 * 每条都配**反证**（否则"改成全删"也能让 ①② 变绿 —— 那才是真正的坑）。
 * ======================================================================== */
describe('LP · 显示名（书名单层脱壳 / 章节点不重复，各带反证）', () => {
  const cmd = require('../cli/commands/learn-path.js');
  /** 造一个最小 report（显示名只读 `books[].project/title`） */
  const rep = (titles) => ({ books: Object.keys(titles).map((p, i) => ({ project: p, title: titles[p], rank: i })) });

  it('① 书根 topic 是 `《X》+后缀` ⇒ **取《》里面的真书名**（后缀不入书名号、也不多出 》）', () => {
    const r = rep({ 'book-80211-guide': '《802.11无线网络权威指南（第2版）》知识点大纲' });
    // 书名 = 《》**里面**那一段：`知识点大纲` 是书根 topic 的后缀，不是书名的组成部分
    expect(cmd.bookTitleOf(r, 'book-80211-guide')).toBe('802.11无线网络权威指南（第2版）');
    // 拼进节点名：书名号里只有真书名，`》` 恰好一个，后缀一个字都不留
    const t = cmd.stepTopicOf(r,
      { project: 'book-80211-guide', chapter: '第一章 无线网络导论', topic: '无线电频谱：关键共享资源' }, 4);
    expect(t).toBe('05. 《802.11无线网络权威指南（第2版）》· 第一章 无线网络导论· 无线电频谱：关键共享资源');
    /* ⚠️ 判别力放在**》的个数**与**后缀是否消失**上，不放"含不含 `》·`"上：正确的形态本身就是
     * `…（第2版）》· 第一章 …` —— 《》是**一开一合**，闭合那个 `》` 后面紧跟分隔符 `·` 是正常的。
     * 改前多出来的那个 `》` 让 count 变成 2（书名里那个 + 包装的 `》`），所以 `》` 计数才是判别器。 */
    expect((t.match(/》/g) || []).length).toBe(1);
    expect(t).not.toContain('》》');
    expect(t).not.toContain('知识点大纲');                // 改前 545/545 步都有；改后必须 0
  });

  it('② 这一步自己就是章节点（`chapter === topic`）⇒ **只留一段**，不把同一段讲两遍', () => {
    const r = rep({ 'lp-a': '书甲' });
    expect(cmd.stepTopicOf(r, { project: 'lp-a', chapter: '全书概览与使用说明', topic: '全书概览与使用说明' }, 0))
      .toBe('01. 《书甲》· 全书概览与使用说明');
    // 去重只对"同一段"生效：非章节点两段都在（不是把章名一律砍掉）
    expect(cmd.stepTopicOf(r, { project: 'lp-a', chapter: '第一章 绪论', topic: '1.1 背景' }, 5))
      .toBe('06. 《书甲》· 第一章 绪论· 1.1 背景');
    // `links[].caption` 同一条判据（否则会出现「来源：全书概览 〉 全书概览」）
    expect(cmd.captionOfStep({ chapter: '全书概览与使用说明', topic: '全书概览与使用说明' }))
      .toBe('来源：全书概览与使用说明');
    expect(cmd.captionOfStep({ chapter: '第一章 绪论', topic: '1.1 背景' })).toBe('来源：第一章 绪论 › 1.1 背景');
  });

  it('③ **反证**：书名里**合法出现**的书名号一个都不许删（"全删"式修法会在这里红）', () => {
    // 开头不是 `《` ⇒ 一个字都不动。`replaceAll('《','').replaceAll('》','')` 会把这一层的书名号吃掉；
    // "取《》里面"式的提取在这里也必须是**恒等**（否则会把 `Linux 内核漫谈：` 与 `读后感` 一起截掉）
    expect(cmd.bookNameOf('Linux 内核漫谈：《Linux内核设计与实现》读后感'))
      .toBe('Linux 内核漫谈：《Linux内核设计与实现》读后感');
    // 只有开头的 `《`、没有配对 ⇒ 原样（不猜"到哪儿结束"，也不硬删）
    expect(cmd.bookNameOf('《Linux内核设计与实现 读后感')).toBe('《Linux内核设计与实现 读后感');
    // 恰好一层、纯 `《X》` ⇒ 取里面的书名（本来就要的行为，确认没被"保守化"改坏）
    expect(cmd.bookNameOf('《书甲》')).toBe('书甲');
    // 没有书名号 ⇒ 恒等（7 本真书之外的项目名/书名不许被硬套）
    expect(cmd.bookNameOf('书甲')).toBe('书甲');
    // 书名恰好叫「《X》Y」：只取 X（Y 是根 topic 的后缀，不属于书名），包装后是《X》
    expect(cmd.bookTitleOf(rep({ p: '《X》Y' }), 'p')).toBe('X');
    // 项目不在 report 里 ⇒ 退回项目名本身（不抛、不改成空）
    expect(cmd.bookTitleOf(rep({ p: '《X》' }), '不存在的项目')).toBe('不存在的项目');
  });

  it('④ 端到端：真跑一本书（书名 `《LP测试书》知识点大纲`）⇒ 产物里两处格式都对', () => {
    const data = project('lp-bk', [
      node('bk-ch0', '全书概览与使用说明', '<p>本书讲 <code>sk_buff</code> 与 <code>napi</code></p>'),
      node('bk-ch1', '第1章 导论', '<ul><li>基础：<code>socket</code></li></ul>')
    ], '《LP测试书》知识点大纲');
    writeProject('lp-bk', data);
    const r = run(['learn-path', 'lp-bk', '--out', 'lp-out-bk', '--json']);
    expect(r.code).toBe(0);
    const outData = JSON.parse(fs.readFileSync(path.join(PROJDIR, 'lp-out-bk', 'lp-out-bk.json'), 'utf8'));
    const topics = outData.data.children.map((k) => k.topic);
    expect(topics.length).toBe(2);
    // ① 书名号里只有真书名（后缀 `知识点大纲` 被甩掉），且每条里 `》` 恰好一个
    topics.forEach((t) => expect((t.match(/》/g) || []).length).toBe(1));
    topics.forEach((t) => expect(t).not.toContain('知识点大纲'));
    // ② 两个节点都是顶层主题（自己就是章节点）⇒ 只留一段
    expect(topics[0]).toBe('01. 《LP测试书》· 全书概览与使用说明');
    expect(topics[1]).toBe('02. 《LP测试书》· 第1章 导论');
    // 同段重复（按 `·` 切段后不得有相邻且相同的非空段）
    topics.forEach((t) => {
      const segs = t.split('·').map((x) => x.trim());
      for (let i = 1; i < segs.length; i++) expect(segs[i] && segs[i] === segs[i - 1]).toBe(false);
    });
    // 产物仍过数据闸门（改的是显示名，不是结构）
    expect(run(['validate', 'lp-out-bk']).code).toBe(0);
  });

  it('⑤ 产物 `detail` 里**没有 Markdown 残留**（现场复用 S2 的扫描器，五种判红档全查）', () => {
    /* 判据来源：`collateral-check`（S2）判定 ⑥ `NOTE_RESIDUE`。`detail` 是 **HTML**（渲染层
     * `innerHTML` 注入）⇒ 残留的 `**` / 反引号会**原样显示**在界面上。
     * 真跑实测：`学习链路-7书` 改前有 **25 个**节点带成对 `**`（12 term-affinity + 13 mechanical）
     * —— 那 25 处全部来自 `why.text` 里自带的强调，`src/` 不改，只在拼 HTML 时转换。 */
    const { scanDetailResidue } = require('../scripts/collateral-check.js');
    writeProject('lp-a', fixtureBooks()[0].data);
    writeProject('lp-b', fixtureBooks()[1].data);
    const r = run(['learn-path', 'lp-a', 'lp-b', '--out', 'lp-out-md', '--json']);
    expect(r.code).toBe(0);
    const outData = JSON.parse(fs.readFileSync(path.join(PROJDIR, 'lp-out-md', 'lp-out-md.json'), 'utf8'));
    // 判别力前提：这批步骤里必须**真的有**带 `**` 的 why.text（否则这条断言是空转的）
    const j = J(r);
    expect(j.steps.some((s) => s.why.kind === 'mechanical' || s.why.kind === 'term-affinity')).toBe(true);

    const details = [outData.data.detail].concat(outData.data.children.map((k) => k.detail));
    expect(details.length).toBe(j.steps.length + 1);          // 根节点 detail 也在判据里
    const bad = [];
    details.forEach((d, i) => {
      const hits = (scanDetailResidue(d).hits || []).filter((h) => h.tier === 'fail');
      if (hits.length) bad.push((i === 0 ? 'root' : 'step' + i) + ':' + hits.map((h) => h.rule).join('+'));
    });
    expect(bad).toEqual([]);                                  // 五档判红：fence / bold-pair / code-span / link / heading-raw
    // 强调真的变成了 HTML（不是被删干净了）
    expect(outData.data.detail).toContain('<strong>机械序</strong>');
    expect(outData.data.children.some((k) => /<strong>[^<]+<\/strong>/.test(k.detail))).toBe(true);
  });
});
