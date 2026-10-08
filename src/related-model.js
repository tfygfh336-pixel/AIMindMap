/* ============================================================
 * src/related-model.js — 「关联节点」模型（纯函数，UMD）
 * ------------------------------------------------------------
 * 无副作用、无外部依赖；把两处既有 IPC 的返回**合成**成一个"关联节点图"：
 *   assocItems   = window.desktop.app.assoc(项目, 节点)   → { items: [{id, title, effectiveTitle, members:[{project,id}], hasNote}] }
 *   relatedItems = window.desktop.app.related(项目, 节点) → { items: [{node, project, topic, dir:'out'|'in'|'both', caption}] }
 * 输出：{ nodeId, project, members:[{id, topic, why:{assoc:[ids], link:bool}}], edges:[{a,b,kind,assocIds,label}],
 *         crossProject, assocCount }
 *
 * 口径（本工程已定，见 .review/20261008-DSH深度集成调研/03-功能2-关联节点可视化.md）：
 *   · **关联节点 = 并集**：节点参与的「关联笔记」成员 ∪ 「相关知识点」两端；
 *   · **跨项目只标不画**：别的项目的节点不在当前图上 —— 画不出线，只计数并如实告知
 *     （★不许静默丢掉：用户会以为"没有关联"，而事实是"有，但不在本图"）；
 *   · 线两类：**当前节点 ↔ 每个成员**（星形，带"为什么相关"：哪篇关联笔记 / 哪条链接），
 *     外加**同一篇关联笔记成员之间**的虚线（"它们彼此相关"是事实本身）。成员超过 8 个只画星形
 *     —— 线一多就盖住图，反而看不清"哪些是关联节点"（宁可少画，不可画糊）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMRelated = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 成员多于这个数量就不画"成员之间"的线（只画星形） */
  const CLIQUE_MAX = 8;

  function buildRelationModel(input) {
    const nodeId = input && input.nodeId;
    const project = (input && input.project) || '';
    const assocItems = (input && input.assocItems) || [];
    const relatedItems = (input && input.relatedItems) || [];
    const byId = new Map();
    let crossProject = 0;

    const add = (id, topic, patch) => {
      if (!id || id === nodeId) return;
      let m = byId.get(id);
      if (!m) { m = { id, topic: topic || id, why: { assoc: [], link: false } }; byId.set(id, m); }
      if (topic && m.topic === m.id) m.topic = topic;      // 后来有真标题就补上
      if (patch && patch.assoc && m.why.assoc.indexOf(patch.assoc) < 0) m.why.assoc.push(patch.assoc);
      if (patch && patch.link) m.why.link = true;
    };

    for (const a of assocItems) {
      for (const mem of (a.members || [])) {
        if (!mem || !mem.id) continue;
        if (mem.project && mem.project !== project) { crossProject++; continue; }   // 跨项目：只计数
        add(mem.id, null, { assoc: a.id });
      }
    }
    for (const x of relatedItems) {
      if (!x || !x.node) continue;
      if (x.project && x.project !== project) { crossProject++; continue; }
      add(x.node, x.topic, { link: true });
    }

    const members = Array.from(byId.values());
    const inSet = new Set(members.map((m) => m.id));
    const edges = [];
    for (const m of members) {
      edges.push({
        a: nodeId, b: m.id,
        kind: m.why.assoc.length && m.why.link ? 'both' : (m.why.assoc.length ? 'assoc' : 'link'),
        assocIds: m.why.assoc.slice(),
        label: m.why.assoc.length ? ('关联笔记：' + m.why.assoc.join('、')) : ''
      });
    }
    if (members.length <= CLIQUE_MAX) {
      for (const a of assocItems) {
        const ms = (a.members || []).filter((x) => x && inSet.has(x.id)).map((x) => x.id);
        for (let i = 0; i < ms.length; i++) {
          for (let j = i + 1; j < ms.length; j++) {
            edges.push({ a: ms[i], b: ms[j], kind: 'assoc', assocIds: [a.id], label: '关联笔记：' + a.id });
          }
        }
      }
    }
    return { nodeId, project, members, edges, crossProject, assocCount: assocItems.length };
  }

  return { buildRelationModel, CLIQUE_MAX };
});
