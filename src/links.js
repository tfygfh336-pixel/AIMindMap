/* ============================================================
 * src/links.js — 链接（节点上的 links[]）的纯逻辑：剪枝与描述（UMD，无 IO）
 * ------------------------------------------------------------
 * 为什么需要"剪链接"这件事：
 *   链接是**有向边**，可以指向别的项目。于是删掉一个节点后，指向它的链接就会悬空：
 *     · 同项目：A 里删掉 x，A 里某节点的 links 仍指向 A/x → A 的 validate 判红；
 *     · 跨项目：A 删掉 x，B 里指向 A/x 的链接悬空 → **B** 的 validate 判红。
 *   而 validate 是写盘闸门（`project:save` 与 CLI 的每次 ctx.write 都过它）→
 *   被判红的那个项目**所有**写操作都被挡住，且界面上没有"删链接"的入口。
 *   所以必须有一条明确的修法（CLI `links-prune`），删节点时也要能同步清干净。
 *
 * 与 src/assoc.js 的分工：那个管"关联笔记"实体（项目级集合），这个管节点上的
 * 有向边。两者都会因"删节点"而悬空，故剪枝的**思路一致、判定各自独立**。
 *
 * 本模块只做纯计算；读写盘由命令层负责。
 * 注意 pruneLinks **会就地修改**传入的树（与 tree-utils 的 removeNode/moveNode 同风格），
 * 因为 links 挂在树节点上，复制整棵树代价大且调用方本来就要写回这棵树。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 链接的可读标识（也是"同一目标"的判定键）：项目/节点id */
  function targetKey(link) {
    return link && link.project !== undefined && link.id !== undefined
      ? String(link.project) + '/' + String(link.id) : '';
  }

  /**
   * 就地剪掉树里符合条件的链接。
   * @param {object} root 根节点
   * @param {(link:object, node:object) => boolean} shouldRemove 命中即从该节点删掉这条链接
   * @returns {{ removed: Array<{node:string,target:string,caption?:string}>,
   *             nodes: string[], changed: boolean }}
   *   removed 每条被删链接（node=源节点 id，target=项目/节点id）；nodes=受影响的源节点 id；
   *   changed=false 表示一处都没改（调用方据此跳过写盘）。
   */
  function pruneLinks(root, shouldRemove) {
    const hit = typeof shouldRemove === 'function' ? shouldRemove : function () { return false; };
    const removed = [];
    const nodes = [];
    (function walk(n) {
      if (!n) return;
      if (Array.isArray(n.links) && n.links.length) {
        const keep = [];
        n.links.forEach((l) => {
          if (l && hit(l, n)) {
            const item = { node: n.id, target: targetKey(l) };
            if (l.caption !== undefined) item.caption = l.caption;
            // 条目层（v3）：被删的这条边若精确指到某一条条目，把 `item` 一并带出 ——
            // 与上面的 `caption` **同一策略**（可选字段，没有就不出现）。理由：报告要能写出
            // "剪掉的是哪一条"（"节点还在、条目已被删"这一档必须看得见剪的是哪一层）；
            // 让调用方拿标签文本反查是**错的**（同源同目标多条边时会配错，且看起来像"没标"）。
            if (l.item !== undefined) item.item = l.item;
            removed.push(item);
          } else keep.push(l);
        });
        if (keep.length !== n.links.length) {
          // 删空就把 links 键去掉：与 assoc 的约定一致，不留空数组噪音
          if (keep.length) n.links = keep; else delete n.links;
          nodes.push(n.id);
        }
      }
      (n.children || []).forEach(walk);
    })(root);
    return { removed: removed, nodes: nodes, changed: removed.length > 0 };
  }

  /** 树里全部链接（含源节点与目标），供统计与"谁指向我"这类查询 */
  function allLinks(root) {
    const out = [];
    (function walk(n) {
      if (!n) return;
      (n.links || []).forEach((l) => out.push({ node: n.id, topic: n.topic, link: l }));
      (n.children || []).forEach(walk);
    })(root);
    return out;
  }

  /** 指向某目标的链接（同项目内可据此提示"删掉这个节点会让谁悬空"） */
  function inbound(root, project, nodeId) {
    return allLinks(root).filter((x) => x.link && x.link.project === project && x.link.id === nodeId);
  }

  return { targetKey, pruneLinks, allLinks, inbound };
});
