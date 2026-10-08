/* ============================================================
 * tests/related-model.test.js — 「关联节点」模型的口径契约（功能 2）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这里的每一条都是**口径**，不是实现细节 —— 口径错了的后果是"图上少画了东西、还不报错"，
 * 属于本工程最重的损害类别（静默）。锁四件事：
 *   ① 并集：关联笔记成员 ∪ 链接两端；
 *   ② **跨项目只标不画**：别的项目的节点不进 members，只计 crossProject（**不许静默丢掉**）；
 *   ③ 去重与"为什么相关"：同一节点被两处提到 ⇒ 一个成员、两种 why，边只出一条（kind=both）；
 *   ④ 毛线球上限：成员 > CLIQUE_MAX 时只画星形，不画成员之间的两两线。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildRelationModel, CLIQUE_MAX } = require('../src/related-model.js');

const A = (id, members, extra) => Object.assign({
  id: id, title: '笔记' + id,
  members: members.map((m) => (typeof m === 'string' ? { project: 'comnet', id: m } : m)),
  hasNote: true
}, extra || {});
const L = (id, dir, project, topic) => ({ node: id, project: project || 'comnet', dir: dir || 'out', topic: topic || ('节点' + id) });

describe('并集与去重', () => {
  it('只有关联笔记 ⇒ 成员来自 assoc，边是星形 + 成员之间的两两线', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [A('a1', ['n1', 'n2', 'n3'])], relatedItems: []
    });
    expect(m.members.map((x) => x.id).sort()).toEqual(['n2', 'n3']);
    // 星形 2 条（n1↔n2, n1↔n3）+ 成员之间 1 条（n2↔n3）
    const star = m.edges.filter((e) => e.a === 'n1');
    const inner = m.edges.filter((e) => e.a !== 'n1');
    expect(star.length).toBe(2);
    expect(inner.length).toBe(1);
    expect(star[0].kind).toBe('assoc');
    expect(star[0].assocIds).toEqual(['a1']);
    expect(inner[0].assocIds).toEqual(['a1']);
  });

  it('只有链接 ⇒ 成员来自 related，边是 link（topic 用链接给的标题）', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [], relatedItems: [L('n2', 'in', 'comnet', '无线信道')]
    });
    expect(m.members).toHaveLength(1);
    expect(m.members[0].topic).toBe('无线信道');
    expect(m.edges[0].kind).toBe('link');
    expect(m.edges[0].assocIds).toEqual([]);
  });

  it('两处都提到同一个节点 ⇒ **一个成员**、why 两种、边只有一条（kind=both）', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [A('a1', ['n1', 'n2'])], relatedItems: [L('n2', 'out', 'comnet', '同一节点')]
    });
    expect(m.members).toHaveLength(1);
    expect(m.members[0].why.assoc).toEqual(['a1']);
    expect(m.members[0].why.link).toBe(true);
    expect(m.edges.filter((e) => e.b === 'n2')).toHaveLength(1);
    expect(m.edges[0].kind).toBe('both');
  });

  it('同一节点出现在两篇关联笔记里 ⇒ assoc 记两个 id，why 不重复', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [A('a1', ['n1', 'n2']), A('a2', ['n1', 'n2'])], relatedItems: []
    });
    expect(m.members).toHaveLength(1);
    expect(m.members[0].why.assoc).toEqual(['a1', 'a2']);
  });

  it('自己不出现在成员里（哪怕数据里写了自己）', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [A('a1', ['n1', 'n1', 'n2'])], relatedItems: [L('n1')]
    });
    expect(m.members.map((x) => x.id)).toEqual(['n2']);
  });
});

describe('跨项目只标不画（★不许静默丢掉）', () => {
  it('别的项目的成员/链接 ⇒ 不进 members，但要计入 crossProject', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [A('a1', ['n1', 'n2', { project: 'other', id: 'x1' }])],
      relatedItems: [L('x2', 'out', 'other')]
    });
    expect(m.members.map((x) => x.id)).toEqual(['n2']);
    expect(m.crossProject).toBe(2);
    expect(m.edges.every((e) => e.a === 'n1' || e.b === 'n1' || e.b === 'n2')).toBe(true);
  });

  it('成员没写 project ⇒ 当成当前项目（旧数据兼容，别把老数据判成跨项目）', () => {
    const m = buildRelationModel({
      nodeId: 'n1', project: 'comnet',
      assocItems: [{ id: 'a1', members: [{ id: 'n9' }] }], relatedItems: []
    });
    expect(m.members.map((x) => x.id)).toEqual(['n9']);
    expect(m.crossProject).toBe(0);
  });
});

describe('毛线球上限与空数据', () => {
  // 注意 project 必须与夹具 A() 里写的项目一致，否则成员会被"跨项目只标不画"过滤掉
  //（这条规则实测咬过我一次：写成 'p' 时 members 为空 ⇒ 正好反证过滤在工作 ✓）
  const P = 'comnet';

  it(`成员只有 ${CLIQUE_MAX} 个 ⇒ 画成员之间的线`, () => {
    const ids = ['n1'].concat(Array.from({ length: CLIQUE_MAX }, (_, i) => 'm' + i));
    const m = buildRelationModel({ nodeId: 'n1', project: P, assocItems: [A('a1', ids)], relatedItems: [] });
    expect(m.members).toHaveLength(CLIQUE_MAX);
    expect(m.edges.filter((e) => e.a !== 'n1').length).toBe(CLIQUE_MAX * (CLIQUE_MAX - 1) / 2);
  });

  it(`成员超过 ${CLIQUE_MAX} 个 ⇒ **只画星形**（线一多就盖住图，反而看不清）`, () => {
    const ids = ['n1'].concat(Array.from({ length: CLIQUE_MAX + 1 }, (_, i) => 'm' + i));
    const m = buildRelationModel({ nodeId: 'n1', project: P, assocItems: [A('a1', ids)], relatedItems: [] });
    expect(m.members).toHaveLength(CLIQUE_MAX + 1);
    expect(m.edges.filter((e) => e.a !== 'n1').length).toBe(0);
    expect(m.edges.filter((e) => e.a === 'n1').length).toBe(CLIQUE_MAX + 1);
  });

  it('空数据 / 缺字段 ⇒ 空模型，绝不抛（按钮点了没关联时走的就是这条路）', () => {
    for (const input of [{ nodeId: 'n1' }, { nodeId: 'n1', project: 'p', assocItems: [], relatedItems: [] }, {}]) {
      const m = buildRelationModel(input);
      expect(m.members).toEqual([]);
      expect(m.edges).toEqual([]);
      expect(m.crossProject).toBe(0);
    }
    // 脏成员（null / 无 id）也要跳过，不能把 undefined 塞进图里
    const m2 = buildRelationModel({ nodeId: 'n1', project: 'p', assocItems: [{ id: 'a1', members: [null, {}, { id: 'ok' }] }] });
    expect(m2.members.map((x) => x.id)).toEqual(['ok']);
  });
});
