/* ============================================================
 * tests/tree-utils.test.js — 树操作单元测试（vitest）
 * 覆盖：moveNode 防环（历史严重 bug）、find、removeNode、pathTo
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import * as tree from '../src/tree-utils.js';

function mkTree() {
  return {
    id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', children: [
        { id: 'b', topic: 'B', children: [
          { id: 'c', topic: 'C', children: [] }
        ] }
      ] },
      { id: 'd', topic: 'D', children: [] }
    ]
  };
}

describe('tree-utils', () => {
  it('find 按 id 定位节点', () => {
    const t = mkTree();
    expect(tree.find(t, 'c').topic).toBe('C');
    expect(tree.find(t, 'nope')).toBeNull();
  });

  it('count / flatten / pathTo 正确', () => {
    const t = mkTree();
    expect(tree.count(t)).toBe(5);
    expect(tree.flatten(t).map((n) => n.id)).toEqual(['root', 'a', 'b', 'c', 'd']);
    expect(tree.pathTo(t, 'c')).toEqual(['root', 'a', 'b', 'c']);
    expect(tree.pathTo(t, 'nope')).toBeNull();
  });

  it('moveNode 正常移动（默认末尾与指定 index）', () => {
    const t = mkTree();
    expect(tree.moveNode(t, 'c', 'd')).toBe(true);
    expect(tree.find(t, 'd').children.map((n) => n.id)).toEqual(['c']);
    expect(tree.find(t, 'b').children.length).toBe(0);
  });

  it('moveNode 拒绝移动到自身或自身子孙（防环，历史严重 bug）', () => {
    const t = mkTree();
    // 移动到自身
    expect(tree.moveNode(t, 'b', 'b')).toBe(false);
    // 移动到自身子孙 c —— 修复前会把 b 移进 c 形成环，子树从树中断开丢失
    expect(tree.moveNode(t, 'b', 'c')).toBe(false);
    // 树结构未被破坏
    expect(tree.pathTo(t, 'c')).toEqual(['root', 'a', 'b', 'c']);
    expect(tree.count(t)).toBe(5);
  });

  it('moveNode 拒绝不存在的节点/父节点', () => {
    const t = mkTree();
    expect(tree.moveNode(t, 'nope', 'root')).toBe(false);
    expect(tree.moveNode(t, 'a', 'nope')).toBe(false);
  });

  it('removeNode 移除子树并返回', () => {
    const t = mkTree();
    const removed = tree.removeNode(t, 'b');
    expect(removed.id).toBe('b');
    expect(tree.find(t, 'c')).toBeNull();
    expect(tree.count(t)).toBe(3);
  });

  it('pathTo 返回真实层级路径（get 命令的 path 字段依赖它）', () => {
    const t = mkTree();
    expect(tree.pathTo(t, 'c')).toEqual(['root', 'a', 'b', 'c']);
    expect(tree.pathTo(t, 'root')).toEqual(['root']);
    expect(tree.pathTo(t, 'nope')).toBeNull();
  });

  it('pathTo 不残留 DFS 访问过的旁支（缺 pop 会返回全树）', () => {
    // 历史 bug：cli `get` 曾内联手写 DFS 而漏掉回溯 pop，
    // 返回"遍历过的所有节点"而非路径。这里用多分支树锁住正确行为。
    const t = { id: 'root', children: [
      { id: 'x', children: [{ id: 'x1' }, { id: 'x2' }] },
      { id: 'y', children: [{ id: 'y1' }] }
    ] };
    expect(tree.pathTo(t, 'y1')).toEqual(['root', 'y', 'y1']);   // 不得包含 x/x1/x2
    expect(tree.pathTo(t, 'x2')).toEqual(['root', 'x', 'x2']);
  });
});
