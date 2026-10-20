/* ============================================================
 * tests/draft-map.test.js — 草稿图纯函数（`src/draft-map.js`）的单测
 * ------------------------------------------------------------
 * 为什么这些判据必须在这里（而不是只在冒烟域 55 里）：
 *   冒烟域只能判"界面上看起来对不对"，判不了**纯函数的语义**——本工程已经栽过一次
 *   （`W9` 的候选生成：两侧调同一个函数 ⇒ 比对恒等、改坏了也全绿，见
 *   `docs/ARCHITECTURE.md` §2.3 的 `feedback-candidates.js` 行）。
 *   所以这一层用**手算的期望值**钉死，期望值**不调产品同一个函数**。
 *
 * 覆盖四组：
 *   ① 形状校验与上限（越界必须**点名拒绝**，不许静默截断）
 *   ② 指纹输入 `canonical()` 的三条性质（忽略 id / 字段顺序无关 / 空 detail 等价）
 *   ③ `toOps()` 的决定性（同输入同输出、含时间也不变）+ 前序顺序 + 落点
 *   ④ 导出 `toMarkdown()` 的形状（嵌套列表、detail 走 convert 的既有序列化）
 * ============================================================ */
'use strict';

import { describe, it, expect } from 'vitest';
import * as draft from '../src/draft-map.js';

/** 一棵正常的草稿：1 根 + 2 子 + 1 孙 = 4 节点 */
function sample() {
  return {
    topic: '  周报提纲  ',
    children: [
      { topic: '本周进展', children: [{ topic: '修好了 A' }] },
      { topic: '下周计划', detail: '<p>先做 <b>B</b></p>' }
    ]
  };
}

describe('草稿图 · 形状校验与上限', () => {
  it('正常的树：规范化出 4 个节点、深度 3、叶子 2，topic 去空白', () => {
    const r = draft.normalize(sample());
    expect(r.ok).toBe(true);
    expect(r.stats.nodes).toBe(4);
    expect(r.stats.depth).toBe(3);
    expect(r.stats.leaves).toBe(2);
    expect(r.tree.topic).toBe('周报提纲');
    expect(r.tree.children[0].children[0].topic).toBe('修好了 A');
  });

  it('id 一律按前序重编（d0/d1/…），原 id 被丢弃且记账', () => {
    const r = draft.normalize({ id: 'whatever', topic: 'a', children: [{ topic: 'b' }, { topic: 'c' }] });
    expect(r.ok).toBe(true);
    expect(r.tree.id).toBe('d0');
    expect(r.tree.children.map((n) => n.id)).toEqual(['d1', 'd2']);
    expect(r.dropped).toContain('id');
  });

  it('节点数超上界 ⇒ ok:false 且**点名**上限（不截断成 500 个就放行）', () => {
    const root = { topic: 'root', children: [] };
    for (let i = 0; i < draft.MAX_NODES; i++) root.children.push({ topic: 'n' + i });
    const r = draft.normalize(root);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' / ')).toContain('节点数超过上限 ' + draft.MAX_NODES);
    expect(r.tree).toBe(null);
  });

  it('深度超上界 ⇒ ok:false 且点名（在哪个路径上断的）', () => {
    let n = { topic: 'leaf' };
    for (let i = 0; i < draft.MAX_DEPTH; i++) n = { topic: 'lvl' + i, children: [n] };
    const r = draft.normalize(n);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' / ')).toContain('深度超过上限 ' + draft.MAX_DEPTH);
  });

  it('空 topic ⇒ 点名（草稿每个节点都要有标题），不吃成空节点', () => {
    const r = draft.normalize({ topic: 'ok', children: [{ topic: '   ' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' / ')).toContain('topic 是空的');
  });

  it('children 不是数组 ⇒ 点名（不静默当成没有孩子）', () => {
    const r = draft.normalize({ topic: 'ok', children: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' / ')).toContain('children 不是数组');
  });

  it('非对象输入 ⇒ 点名类型', () => {
    expect(draft.normalize(null).ok).toBe(false);
    expect(draft.normalize([]).errors[0]).toContain('数组');
    expect(draft.normalize('x').errors[0]).toContain('收到 string');
  });

  it('超限时必须**留读数**：stats 仍然给出走到了多少节点（不是 0）', () => {
    const root = { topic: 'root', children: [] };
    for (let i = 0; i < draft.MAX_NODES + 5; i++) root.children.push({ topic: 'n' + i });
    const r = draft.normalize(root);
    expect(r.stats.nodes).toBeGreaterThan(0);
    expect(r.stats.nodes).toBeLessThanOrEqual(draft.MAX_NODES + 1);
  });
});

describe('草稿图 · 指纹输入 canonical()', () => {
  it('忽略 id：换一套 id 仍是同一份内容', () => {
    const a = draft.normalize({ id: 'x', topic: 'a', children: [{ id: 'y', topic: 'b' }] }).tree;
    const b = draft.normalize({ topic: 'a', children: [{ topic: 'b' }] }).tree;
    expect(draft.canonical(a)).toBe(draft.canonical(b));
  });

  it('字段顺序无关：{topic,detail} 与 {detail,topic} 同串', () => {
    const a = draft.normalize({ topic: 'a', detail: '<p>x</p>' }).tree;
    const b = draft.normalize({ detail: '<p>x</p>', topic: 'a' }).tree;
    expect(draft.canonical(a)).toBe(draft.canonical(b));
  });

  it('空 detail 与没有 detail 等价；但**有** detail 就不同', () => {
    const a = draft.normalize({ topic: 'a', detail: '' }).tree;
    const b = draft.normalize({ topic: 'a' }).tree;
    const c = draft.normalize({ topic: 'a', detail: '<p>z</p>' }).tree;
    expect(draft.canonical(a)).toBe(draft.canonical(b));
    expect(draft.canonical(c)).not.toBe(draft.canonical(b));
  });

  it('层级不同 ⇒ 串不同（`a>b` 与 `a` 带子 `b` 不是同一棵树）', () => {
    const a = draft.normalize({ topic: 'a b' }).tree;
    const b = draft.normalize({ topic: 'a', children: [{ topic: 'b' }] }).tree;
    expect(draft.canonical(a)).not.toBe(draft.canonical(b));
  });

  it('长度前缀挡住"分隔符进标题"的撞车：`a|1:b` 与 `a`+`b` 不会同串', () => {
    const a = draft.normalize({ topic: 'a|1:b' }).tree;
    const b = draft.normalize({ topic: 'a', children: [{ topic: 'b' }] }).tree;
    expect(draft.canonical(a)).not.toBe(draft.canonical(b));
  });
});

describe('草稿图 · toOps()', () => {
  it('前序：父先于子；id = <prefix>-<序号>；detail 跟着进 op', () => {
    const t = draft.normalize(sample()).tree;
    const ops = draft.toOps(t, { parent: 'root', idPrefix: 'dmABC' });
    expect(ops.length).toBe(4);
    expect(ops.map((o) => o.topic)).toEqual(['周报提纲', '本周进展', '修好了 A', '下周计划']);
    expect(ops.map((o) => o.id)).toEqual(['dmABC-0', 'dmABC-1', 'dmABC-2', 'dmABC-3']);
    // 落点：根挂 parent（'root'），其余挂各自的父 id
    expect(ops.map((o) => o.parent)).toEqual(['root', 'dmABC-0', 'dmABC-1', 'dmABC-0']);
    expect(ops.every((o) => o.op === 'add')).toBe(true);
    expect(ops[3].detail).toBe('<p>先做 <b>B</b></p>');
    expect(ops[0].detail).toBe(undefined);   // 没有 detail 就不写这个键（免得写进空串）
  });

  it('**决定性**：同一棵树重复算得**逐字节相同**的 ops（幂等的第二层靠它）', () => {
    const t1 = draft.normalize(sample()).tree;
    const t2 = draft.normalize(sample()).tree;
    expect(JSON.stringify(draft.toOps(t1, { parent: 'p', idPrefix: 'k' })))
      .toBe(JSON.stringify(draft.toOps(t2, { parent: 'p', idPrefix: 'k' })));
  });

  it('不同的落点 ⇒ 只有根的 parent 变，id 不变', () => {
    const t = draft.normalize(sample()).tree;
    const a = draft.toOps(t, { parent: 'root', idPrefix: 'k' });
    const b = draft.toOps(t, { parent: 'node-42', idPrefix: 'k' });
    expect(b[0].parent).toBe('node-42');
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
  });

  it('没给落点 ⇒ 抛错（不默认挂 root：落点是人的决定）', () => {
    const t = draft.normalize(sample()).tree;
    expect(() => draft.toOps(t, {})).toThrow(/落点/);
  });
});

describe('草稿图 · 导出', () => {
  it('toMarkdown：嵌套列表，按前序、缩进逐层 +2 空格', () => {
    const t = draft.normalize(sample()).tree;
    const md = draft.toMarkdown(t);
    const lines = md.split('\n');
    expect(lines[0]).toBe('- 周报提纲');
    expect(lines).toContain('  - 本周进展');
    expect(lines).toContain('    - 修好了 A');
    // detail 那一半走 src/convert.js 的既有序列化 ⇒ 粗体要变成 Markdown 粗体，不是留着 <b>
    expect(md).toContain('先做 **B**');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('toMarkdown：空草稿给出可读的一行（不是 0 字节文件）', () => {
    expect(draft.toMarkdown(null)).toContain('（草稿是空的）');
  });

  it('toJsMind：node_tree 形状 + id 唯一（jsMind 的硬要求）', () => {
    const t = draft.normalize(sample()).tree;
    const d = draft.toJsMind(t, '某草稿');
    expect(d.format).toBe('node_tree');
    expect(d.meta.name).toBe('某草稿');
    const ids = [];
    (function walk(n) { ids.push(n.id); (n.children || []).forEach(walk); })(d.data);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
    expect(d.data.topic).toBe('周报提纲');
  });

  it('toJsMind：空树也给一个能渲染的根（页面不该因此白屏）', () => {
    const d = draft.toJsMind(null, 'x');
    expect(d.data.id).toBe('d0');
    expect(d.data.topic).toContain('空草稿');
  });
});
