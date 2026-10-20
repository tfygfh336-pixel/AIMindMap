/* ============================================================
 * tests/tag-view.test.js — 「标签视图」的成员派生（vitest）
 * ------------------------------------------------------------
 * 覆盖对象：`src/tree-utils.js` 的 `nodesByTag`（`W9` / 功能代号 `TV`）。
 *
 * 这些用例守的不是"函数能返回数组"，而是 `W9` 台账里的那三条硬要求：
 *   ① **成员是派生的**：树里多一个带该标签的节点 ⇒ 成员自己多出来，
 *      不需要任何人去更新一份清单（**没有**可忘的东西 = 零同步问题）；
 *   ② **口径与 `search --tag` 一致**：逐字相等，不是前缀/包含/小写化
 *      （否则"点标签看到的"与"`--tag` 查到的"会分成两份事实）；
 *   ③ **脏数据跳过而不抛**：坏数据由 `validate` 报，渲染层不该整屏炸掉。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import * as tree from '../src/tree-utils.js';

function mk() {
  return {
    id: 'root', topic: '根', children: [
      { id: 'a', topic: 'A', tags: ['工具', '调试'], children: [
        { id: 'b', topic: 'B', tags: ['工具'], children: [] }
      ] },
      { id: 'c', topic: 'C', children: [
        { id: 'd', topic: 'D', tags: ['工作工具'], children: [] }
      ] },
      { id: 'e', topic: 'E', tags: ['工具'], children: [] }
    ]
  };
}

describe('tree-utils.nodesByTag（W9 标签视图的成员来源）', () => {
  it('按树序返回全部成员（先父后子）', () => {
    expect(tree.nodesByTag(mk(), '工具').map((n) => n.id)).toEqual(['a', 'b', 'e']);
  });

  it('成员是**派生**的：树里加一个带该标签的节点，成员自己就多一个', () => {
    const t = mk();
    const before = tree.nodesByTag(t, '工具').length;
    // 模拟"用户新加了一个带该标签的节点"——**除了树本身，没有任何清单被更新**
    t.children[1].children.push({ id: 'f', topic: 'F', tags: ['工具'], children: [] });
    const after = tree.nodesByTag(t, '工具').map((n) => n.id);
    expect(after.length).toBe(before + 1);
    expect(after).toContain('f');
  });

  it('口径与 search --tag 一致：逐字相等，前缀/子串都不算', () => {
    // `工作工具` 含"工具"两个字，但它是**另一个标签** —— 不许被算进来
    expect(tree.nodesByTag(mk(), '工作工具').map((n) => n.id)).toEqual(['d']);
    expect(tree.nodesByTag(mk(), '工').length).toBe(0);
  });

  it('大小写敏感（与 item-index 的 hasTag 同为 indexOf 口径）', () => {
    const t = { id: 'r', topic: 'R', children: [{ id: 'x', topic: 'X', tags: ['TCP连接管理'], children: [] }] };
    expect(tree.nodesByTag(t, 'TCP连接管理').length).toBe(1);
    expect(tree.nodesByTag(t, 'tcp连接管理').length).toBe(0);
  });

  it('脏数据跳过而不抛：tags 非数组 / 节点为 null / 标签为空', () => {
    const t = {
      id: 'r', topic: 'R', children: [
        { id: 'x', topic: 'X', tags: '工具', children: [] },   // 形状坏（不是数组）
        { id: 'y', topic: 'Y', children: [] },                 // 没有 tags
        { id: 'z', topic: 'Z', tags: ['工具'], children: [] }
      ]
    };
    expect(() => tree.nodesByTag(t, '工具')).not.toThrow();
    expect(tree.nodesByTag(t, '工具').map((n) => n.id)).toEqual(['z']);
    expect(tree.nodesByTag(t, '')).toEqual([]);
    expect(tree.nodesByTag(t, null)).toEqual([]);
    expect(tree.nodesByTag(null, '工具')).toEqual([]);
  });

  it('不改动传入的树（只读派生）', () => {
    const t = mk();
    const snapshot = JSON.stringify(t);
    tree.nodesByTag(t, '工具');
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});
