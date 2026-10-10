/* ============================================================
 * tests/relations.test.js — 引用关系计算单元测试（vitest）
 * 覆盖：flatten、backlinksAll（within/cross/去重）、
 *       relatedAll（出边/入边双向合并、跨项目标题解析、both 标注）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { flatten, backlinksAll, relatedAll, backlinkIndex, backlinksFrom, nodeIndex, buildIndexes } from '../src/relations.js';

function mkRoot() {
  return {
    id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', tags: ['协议'], links: [{ project: 'self', id: 'b', caption: 'ab' }] },
      { id: 'b', topic: 'B', tags: ['协议', '核心'], links: [{ project: 'other', id: 'x', caption: '跨项目' }] },
      { id: 'c', topic: 'C', children: [] }
    ]
  };
}

const projects = [
  { name: 'self', data: { data: mkRoot() } },
  { name: 'other', data: { data: { id: 'r2', topic: 'R2', children: [
    { id: 'p1', topic: 'P1', links: [{ project: 'self', id: 'b', caption: '指回 b' }] },
    { id: 'p2', topic: 'P2', links: [{ project: 'self', id: 'nope', caption: '目标不存在' }] }
  ] } } }
];

describe('relations.flatten', () => {
  it('深度优先收集全部节点（含根）', () => {
    expect(flatten(mkRoot()).map((n) => n.id)).toEqual(['root', 'a', 'b', 'c']);
  });

  it('空节点安全', () => {
    expect(flatten(null)).toEqual([]);
  });
});

describe('relations.backlinksAll', () => {
  it('within 收集本项目引用；cross 收集其他项目指向本项目的引用', () => {
    const r = backlinksAll('self', 'b', projects);
    expect(r.within.map((x) => x.node)).toEqual(['a']);
    expect(r.cross.map((x) => ({ p: x.project, n: x.node }))).toEqual([{ p: 'other', n: 'p1' }]);
  });

  it('目标无引用时返回空数组', () => {
    const r = backlinksAll('self', 'c', projects);
    expect(r.within).toEqual([]);
    expect(r.cross).toEqual([]);
  });

  it('includeSelf=false 时排除本项目来源', () => {
    const r = backlinksAll('self', 'b', projects, { includeSelf: false });
    expect(r.within).toEqual([]);
    expect(r.cross.length).toBe(1);
  });

  it('同节点多条同目标链接去重', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'm', topic: 'M', links: [{ project: 'self', id: 't', caption: 'c1' }, { project: 'self', id: 't', caption: 'c1' }] }
    ] } } }];
    const r = backlinksAll('self', 't', projs);
    expect(r.within.length).toBe(1);
  });
});

describe('relations.relatedAll', () => {
  it('合并出边与入边，并解析出目标标题', () => {
    const b = mkRoot().children[1];
    const r = relatedAll('self', b, projects);
    // 出边：b → other/x（other 里没有 x，标题回退为 id）
    const out = r.items.find((x) => x.dir === 'out');
    expect(out).toMatchObject({ project: 'other', node: 'x', topic: 'x', caption: '跨项目' });
    // 入边：本项目 a 引用 b
    expect(r.items.find((x) => x.node === 'a')).toMatchObject({ project: 'self', topic: 'A', dir: 'in', caption: 'ab' });
    // 入边：其他项目 other/p1 引用 b
    expect(r.items.find((x) => x.node === 'p1')).toMatchObject({ project: 'other', topic: 'P1', dir: 'in' });
    expect(r.items.length).toBe(3);
    expect(r.outCount).toBe(1);
    expect(r.inCount).toBe(2);
  });

  it('出边目标在本项目时标题解析为 topic', () => {
    const a = mkRoot().children[0];
    const r = relatedAll('self', a, projects);
    const out = r.items.find((x) => x.node === 'b');
    expect(out).toMatchObject({ project: 'self', topic: 'B', caption: 'ab', dir: 'out' });
  });

  it('互相引用去重后标注 both', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'm', topic: 'M', links: [{ project: 'self', id: 'n', caption: 'm→n' }] },
      { id: 'n', topic: 'N', links: [{ project: 'self', id: 'm', caption: 'n→m' }] }
    ] } } }];
    const m = projs[0].data.data.children[0];
    const r = relatedAll('self', m, projs);
    expect(r.items.length).toBe(1);
    expect(r.items[0]).toMatchObject({ node: 'n', topic: 'N', dir: 'both' });
    expect(r.outCount).toBe(1);
    expect(r.inCount).toBe(1);
  });

  it('无出边也无入边时为空', () => {
    const c = mkRoot().children[2];
    const r = relatedAll('self', c, projects);
    expect(r.items).toEqual([]);
    expect(r.outCount).toBe(0);
    expect(r.inCount).toBe(0);
  });

  it('depth 字段：默认全为一跳，via 为 null', () => {
    const b = mkRoot().children[1];
    const r = relatedAll('self', b, projects);
    expect(r.items.every((x) => x.depth === 1 && x.via === null)).toBe(true);
    expect(r.depth1Count).toBe(3);
    expect(r.depth2Count).toBe(0);
  });
});

/* —— 两跳邻域（对应 Obsidian 的 local graph；docs/ROADMAP.md 的 related --depth 2）—— */
describe('relations.relatedAll depth=2', () => {
  /** 链：self/a → self/b → self/c，另加 other/z 指向 c；d 无任何关系 */
  const chain = () => [{
    name: 'self',
    data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'self', id: 'b', caption: 'a→b' }] },
      { id: 'b', topic: 'B', links: [{ project: 'self', id: 'c', caption: 'b→c' }] },
      { id: 'c', topic: 'C' },
      { id: 'd', topic: 'D' }
    ] } }
  }];

  it('从 a 出发：一跳含 b，二跳含 c（经由 b）', () => {
    const projs = chain();
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 2 });
    const b = r.items.find((x) => x.node === 'b');
    const c = r.items.find((x) => x.node === 'c');
    expect(b).toMatchObject({ node: 'b', depth: 1, dir: 'out', via: null });
    expect(c).toMatchObject({ node: 'c', depth: 2, via: { project: 'self', node: 'b', topic: 'B' } });
  });

  it('二跳项的数量与分层计数自洽', () => {
    const projs = chain();
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 2 });
    expect(r.depth1Count + r.depth2Count).toBe(r.items.length);
    expect(r.depth1Count).toBe(1);
    expect(r.depth2Count).toBe(1);
    // outCount / inCount 仍只统计**一跳**（保持既有语义：直接引用数）
    expect(r.outCount).toBe(1);
    expect(r.inCount).toBe(0);
  });

  it('不绕回自身（a 在 b 的入边里，但不得作为 a 的二跳出现）', () => {
    const projs = chain();
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 2 });
    expect(r.items.filter((x) => x.node === 'a')).toEqual([]);
  });

  it('一跳已出现的节点不重复作为二跳（近者优先）', () => {
    // a ⇄ b（互相引用）：b 的入边是 a，a 已是一跳来源，不得再以二跳出现
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'self', id: 'b' }] },
      { id: 'b', topic: 'B', links: [{ project: 'self', id: 'a' }] }
    ] } } }];
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 2 });
    expect(r.items.filter((x) => x.node === 'b')).toHaveLength(1);
    expect(r.items.find((x) => x.node === 'b').depth).toBe(1);
  });

  it('二跳可跨项目到达，并用 via 指明经由哪个节点', () => {
    const projs = [
      { name: 'self', data: { data: { id: 'root', topic: 'R', children: [
        { id: 'a', topic: 'A', links: [{ project: 'other', id: 'p1' }] }
      ] } } },
      { name: 'other', data: { data: { id: 'root', topic: 'R2', children: [
        { id: 'p1', topic: 'P1', links: [{ project: 'other', id: 'p2' }] },
        { id: 'p2', topic: 'P2' }
      ] } } }
    ];
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 2 });
    const p2 = r.items.find((x) => x.node === 'p2');
    expect(p2).toMatchObject({ project: 'other', depth: 2, via: { project: 'other', node: 'p1', topic: 'P1' } });
  });

  it('无关系的节点在 depth 2 下仍为空', () => {
    const projs = chain();
    const d = projs[0].data.data.children[3];
    const r = relatedAll('self', d, projs, { depth: 2 });
    expect(r.items).toEqual([]);
    expect(r.depth2Count).toBe(0);
  });

  it('depth 任意：3 跳真能到达第 3 层（旧行为是"非 1/2 一律退化成 1"，已按新语义改）', () => {
    // 旧断言是 `depth:3 ⇒ depth2Count === 0`（因为 3 被静默当成 1）—— 那正是被修的缺陷：
    // 用户要"多跳关系可查"，而 --depth 3 看起来成功、给的却是另一件事（只有直接关联）。
    const projs = chain();
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 3 });
    expect(r.items.map((x) => x.node + '@' + x.depth).sort()).toEqual(['b@1', 'c@2']);
    expect(r.byDepth[1]).toBe(1);
    expect(r.byDepth[2]).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('depth 非法（0 / 负数 / 小数 / 文字）在模型层退化为 1（判定与报错由 CLI 负责，见 cli/commands/relations.js）', () => {
    const projs = chain();
    const a = projs[0].data.data.children[0];
    [0, -3, 1.5, 'x'].forEach((bad) => {
      const r = relatedAll('self', a, projs, { depth: bad });
      expect(r.items.every((x) => x.depth === 1)).toBe(true);
      expect(r.depth2Count).toBe(0);
    });
  });
});

/* —— 多跳邻域（用户卖点原话"多跳关系可查"）：任意深度 + 防环 + 结果上限 ——
 * 修前实测（2026-10-10）：`--depth` 只认 1/2，其它值静默退化成 1。 */
describe('relations.relatedAll 任意深度（多跳）', () => {
  /** 一条 8 节点的链：n1 → n2 → … → n8（每层恰好 1 个新节点） */
  const longChain = () => {
    const kids = [];
    for (let i = 1; i <= 8; i++) {
      kids.push({ id: 'n' + i, topic: 'N' + i, links: i < 8 ? [{ project: 'self', id: 'n' + (i + 1) }] : [] });
    }
    return [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: kids } } }];
  };

  it('深 3 跳的正例：n1 --depth 3 恰好到 n2/n3/n4，且每层一个', () => {
    const projs = longChain();
    const n1 = projs[0].data.data.children[0];
    const r = relatedAll('self', n1, projs, { depth: 3 });
    expect(r.items.map((x) => x.node + '@' + x.depth).sort()).toEqual(['n2@1', 'n3@2', 'n4@3']);
    expect(r.byDepth).toMatchObject({ 1: 1, 2: 1, 3: 1 });
    // 深 3 项必须带 via 指向上一个节点（否则读不出"经由谁"）
    expect(r.items.find((x) => x.node === 'n4').via).toMatchObject({ node: 'n3' });
    // 一跳的引用计数语义不变（只统计直接引用）
    expect(r.outCount).toBe(1);
    expect(r.inCount).toBe(0);
  });

  it('深 6 跳：链一直展开到 n7，`depth2Count` 仍是**正好二跳**的条数（不合并 3+ 跳）', () => {
    const projs = longChain();
    const n1 = projs[0].data.data.children[0];
    const r = relatedAll('self', n1, projs, { depth: 6 });
    expect(r.items.map((x) => x.node).sort()).toEqual(['n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
    expect(r.depth1Count).toBe(1);
    expect(r.depth2Count).toBe(1);
    expect(r.byDepth[6]).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('防环：成环的图（a → b → c → a）不会死循环，也不把起点算回邻域', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'self', id: 'b' }] },
      { id: 'b', topic: 'B', links: [{ project: 'self', id: 'c' }] },
      { id: 'c', topic: 'C', links: [{ project: 'self', id: 'a' }] }
    ] } } }];
    const a = projs[0].data.data.children[0];
    // 深度给到 100（上限）：若没有访问集合，这里会一直转下去。
    // 期望集说明：a 的出边是 b（一跳），而入边是 c（c→a）⇒ c 也是**一跳**；
    // 再往外的 a（经 b→c 回到起点）被"不绕回自身 + 访问集合"双双挡住。
    const r = relatedAll('self', a, projs, { depth: 100 });
    expect(r.items.map((x) => x.node + '@' + x.depth).sort()).toEqual(['b@1', 'c@1']);
  });

  it('自环（节点引用自己）不把自身塞进邻域', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'self', id: 'a' }, { project: 'self', id: 'b' }] },
      { id: 'b', topic: 'B' }
    ] } } }];
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 3 });
    expect(r.items.map((x) => x.node)).toEqual(['b']);
  });

  it('结果上限：撞到 maxItems 就停并置 truncated（**由调用方报错**，模块自己绝不静默截断）', () => {
    const kids = [];
    for (let i = 1; i <= 20; i++) kids.push({ id: 'n' + i, topic: 'N' + i });
    for (let i = 1; i < 20; i++) kids[i - 1].links = [{ project: 'self', id: 'n' + (i + 1) }];
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: kids } } }];
    const n1 = projs[0].data.data.children[0];
    const capped = relatedAll('self', n1, projs, { depth: 19, maxItems: 5 });
    expect(capped.items).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    const full = relatedAll('self', n1, projs, { depth: 19, maxItems: 100 });
    expect(full.items).toHaveLength(19);
    expect(full.truncated).toBe(false);
    // 同一个图：默认上限（MAX_ITEMS=500）下不会被截断
    expect(relatedAll('self', n1, projs, { depth: 19 }).truncated).toBe(false);
  });

  it('最短跳数优先：同一节点既可二跳也可三跳到 ⇒ 只以二跳出现（一次）', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'self', id: 'b' }, { project: 'self', id: 'c' }] },
      { id: 'b', topic: 'B', links: [{ project: 'self', id: 'd' }] },
      { id: 'c', topic: 'C', links: [{ project: 'self', id: 'x' }] },
      { id: 'x', topic: 'X', links: [{ project: 'self', id: 'd' }] },
      { id: 'd', topic: 'D' }
    ] } } }];
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, { depth: 3 });
    const ds = r.items.filter((it) => it.node === 'd');
    expect(ds).toHaveLength(1);
    expect(ds[0].depth).toBe(2);       // 经 b 两跳到，而不是经 c→x 三跳
  });
});

describe('relations 索引函数', () => {
  it('backlinkIndex 一次建索引，结果与 backlinksAll 一致', () => {
    const idx = backlinkIndex(projects);
    const viaIdx = backlinksFrom(idx, 'self', 'b', true);
    const viaFn = backlinksAll('self', 'b', projects);
    expect(viaIdx.within.length).toBe(viaFn.within.length);
    expect(viaIdx.cross.length).toBe(viaFn.cross.length);
  });

  it('backlinkIndex 去重同源同目标的重复链接', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [
        { project: 'self', id: 'b', caption: 'x' },
        { project: 'self', id: 'b', caption: 'x' }
      ] },
      { id: 'b', topic: 'B' }
    ] } } }];
    expect(backlinksFrom(backlinkIndex(projs), 'self', 'b', true).within).toHaveLength(1);
  });

  it('backlinkIndex 忽略残缺链接（缺 project 或 id）', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ id: 'b' }, { project: 'self' }, null] },
      { id: 'b', topic: 'B' }
    ] } } }];
    expect(backlinksFrom(backlinkIndex(projs), 'self', 'b', true).within).toEqual([]);
  });

  it('nodeIndex 可按 项目|id 取到节点对象', () => {
    const nIdx = nodeIndex(projects);
    expect(nIdx.self.b.topic).toBe('B');
    expect(nIdx.other.p1.topic).toBe('P1');
    expect(nIdx.nope).toBeUndefined();
  });

  it('传入 indexes 时结果与自动建索引**完全一致**（批量复用的正确性前提）', () => {
    const idx = buildIndexes(projects);
    const self = projects[0].data.data.children[0];   // a
    const auto = relatedAll('self', self, projects, { depth: 2 });
    const reused = relatedAll('self', self, projects, { depth: 2, indexes: idx });
    const key = (x) => [x.project, x.node, x.direction || x.dir, x.depth, x.caption].join('|');
    expect(reused.items.map(key)).toEqual(auto.items.map(key));
    expect(reused.outCount).toBe(auto.outCount);
    expect(reused.inCount).toBe(auto.inCount);
    expect(reused.depth2Count).toBe(auto.depth2Count);
  });

  it('回归：自链接不出现在自己的 related 里（手工编辑/导入可造出）', () => {
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'self', id: 'a', caption: '自指' }] }
    ] } } }];
    const a = projs[0].data.data.children[0];
    const r = relatedAll('self', a, projs, {});
    expect(r.items.some((x) => x.node === 'a')).toBe(false);
    expect(r.items).toEqual([]);
  });

  it('已知差异：backlinksAll 按 caption 去重、relatedAll 按节点去重（服务不同视图）', () => {
    // 同一来源对同一目标写两条不同说明的链接时：
    //   backlinks 保留两行（如实展示作者写的每条说明）
    //   related   只留一条（关系清单里同一关系重复无意义）
    // 两者口径不同是有意的，此处固定下来避免被误当 bug。
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'm', topic: 'M', links: [
        { project: 'self', id: 't', caption: '第一次提到' },
        { project: 'self', id: 't', caption: '第二次，说明不同' }
      ] },
      { id: 't', topic: 'T' }
    ] } } }];
    const bl = backlinksAll('self', 't', projs);
    expect(bl.within).toHaveLength(2);
    const m = projs[0].data.data.children[0];
    expect(relatedAll('self', m, projs, {}).items).toHaveLength(1);
  });

  it('buildIndexes 返回三类索引', () => {
    const idx = buildIndexes(projects);
    expect(Object.keys(idx).sort()).toEqual(['blIdx', 'nIdx', 'tIdx']);
    expect(idx.tIdx.self.b).toBe('B');
    expect(idx.nIdx.self.b.id).toBe('b');
    expect(idx.blIdx['self|b']).toBeTruthy();
  });

  it('回归：id 为 __proto__/constructor 时索引不被污染（topic 仍是字符串）', () => {
    // 普通对象上 `idx['__proto__'] = x` 不会建属性（会改原型），
    // 于是 topic 会解析成 Object.prototype 那个对象。索引改用 null 原型后修好。
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: '__proto__', topic: '污染', links: [{ project: 'self', id: 'constructor' }] },
      { id: 'constructor', topic: '构造' }
    ] } } }];
    const self = projs[0].data.data.children[0];
    const r = relatedAll('self', self, projs, {});
    expect(r.items.length).toBeGreaterThan(0);
    r.items.forEach((x) => expect(typeof x.topic).toBe('string'));
    expect(r.items.some((x) => x.node === 'constructor' && x.topic === '构造')).toBe(true);
  });

  it('已知行为：depth=2 时 includeSelf 对二跳不生效（一跳仍严格生效）', () => {
    // 二跳展开时 selfProject 换成了中间节点所在项目，传 includeSelf=false 会连
    // "中间节点自己项目内的来源"一起屏蔽，把二跳邻域挖掉一大块。
    // 故这里把该行为**固定下来**（并在 relations.js 注释里说明理由），避免被误当 bug 改坏。
    // 链：p → q → w → x（q 为中心；p 是"本项目来源"，x 是二跳）
    const projs = [{ name: 'self', data: { data: { id: 'root', topic: 'R', children: [
      { id: 'p', topic: 'P', links: [{ project: 'self', id: 'q' }] },
      { id: 'q', topic: 'Q', links: [{ project: 'self', id: 'w' }] },
      { id: 'w', topic: 'W', links: [{ project: 'self', id: 'x' }] },
      { id: 'x', topic: 'X' }
    ] } } }];
    const q = projs[0].data.data.children[1];
    const one = relatedAll('self', q, projs, { depth: 1, includeSelf: false });
    expect(one.items.map((z) => z.node).sort()).toEqual(['w']);   // 一跳：本项目来源 p 被排除
    const two = relatedAll('self', q, projs, { depth: 2, includeSelf: false });
    expect(two.items.some((z) => z.node === 'x')).toBe(true);     // 二跳仍能展开到 x
  });
});

