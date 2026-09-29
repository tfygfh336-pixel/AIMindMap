/* ============================================================
 * src/tree-utils.js — 纯树函数（UMD）
 * ------------------------------------------------------------
 * 无副作用、无外部依赖；对 node_tree 的 data 子树操作。
 * 节点形如 { id, topic, expanded, children: [], detail?, images?, links? }
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 深度优先遍历（先父后子）。fn 收到 (node, depth)，depth 从 1 起（根为 1）。
   *  —— 第二个参数使本函数可替代各处手写的递归 walk（原先 5+ 处各写一份带 depth 的遍历）。 */
  function walk(node, fn, depth) {
    if (!node) return;
    const d = depth || 1;
    fn(node, d);
    (node.children || []).forEach((c) => walk(c, fn, d + 1));
  }

  /** 按 id 查找节点 */
  function find(root, id) {
    let out = null;
    walk(root, (n) => { if (n.id === id) out = n; });
    return out;
  }

  /** 统计节点总数 */
  function count(root) {
    let n = 0;
    walk(root, () => { n++; });
    return n;
  }

  /** 收集全部节点（扁平数组） */
  function flatten(root) {
    const out = [];
    walk(root, (n) => out.push(n));
    return out;
  }

  /** 收集某节点下所有叶子 id（用于删除确认/级联） */
  function leafIds(root) {
    const out = [];
    walk(root, (n) => { if (!n.children || !n.children.length) out.push(n.id); });
    return out;
  }

  /** 从树中移除节点（含子树），返回被移除的子树或 null */
  function removeNode(root, id) {
    if (!root) return null;
    if (root.id === id) return root;
    const children = root.children || [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].id === id) {
        return children.splice(i, 1)[0];
      }
      const r = removeNode(children[i], id);
      if (r) return r;
    }
    return null;
  }

  /** 把节点移动到新父节点（index 可选，默认末尾）；返回是否成功 */
  function moveNode(root, id, newParentId, index) {
    const node = find(root, id);
    if (!node) return false;
    const parent = find(root, newParentId);
    if (!parent || parent.id === id) return false;
    // 防环：目标新父不能在自身子树内（pathTo 到 newParent 的路径若含 id，
    // 说明 newParent 是 id 的后代）。
    const p = pathTo(root, newParentId);
    if (!p || p.indexOf(id) >= 0) return false;
    // 从原父移除
    removeNode(root, id);
    parent.children = parent.children || [];
    const idx = (typeof index === 'number' && index >= 0 && index <= parent.children.length) ? index : parent.children.length;
    parent.children.splice(idx, 0, node);
    return true;
  }

  /** 节点路径（root → 该节点）的 id 数组；找不到返回 null。
   *  这是唯一的"带层级的定位"原语 —— 全树遍历一律用 walk/flatten。 */
  function pathTo(root, id) {
    const out = [];
    let found = false;
    (function dfs(n) {
      if (found) return;
      out.push(n.id);
      if (n.id === id) { found = true; return; }
      (n.children || []).forEach(dfs);
      if (!found) out.pop();
    })(root);
    return found ? out : null;
  }

  // 注：曾有 linkParents（就地补 parent 指针）与 depth（按 parent 链计深度）两个函数，
  // 但全工程无任何调用方（仅被单测引用，制造了"在用"的假象），已删除。
  // 需要层级时用 walk(root, (node, depth) => ...) 或 pathTo(root, id).length。

  return { walk, find, count, flatten, leafIds, removeNode, moveNode, pathTo };
});
