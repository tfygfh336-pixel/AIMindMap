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

  it('depth 只认 1 与 2（其他值退化为 1，避免无界展开）', () => {
    const projs = chain();
    const a = projs[0].data.data.children[0];
    expect(relatedAll('self', a, projs, { depth: 3 }).depth2Count).toBe(0);
    expect(relatedAll('self', a, projs, { depth: 0 }).depth2Count).toBe(0);
    expect(relatedAll('self', a, projs, { depth: 'x' }).depth2Count).toBe(0);
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

