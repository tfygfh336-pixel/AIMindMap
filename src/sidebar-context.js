/* ============================================================
 * src/sidebar-context.js — ⑨ 把节点上下文编成"送给 DSH 侧栏"的文本
 * ------------------------------------------------------------
 * 为什么单独一个 src 模块（而不是写在 renderer/app-ask.js 里 ✗）：
 *   · renderer/*.js 是 IIFE，**在 node 里没法 require** ⇒ 那段文本拼装逻辑**无法单测** ✗；
 *   · 放 src/ 就同时被"渲染层（script 标签）"和"node 单测"拿到 ⇒ **一份实现、两处用** ✓。
 * 纯函数：不碰 DOM、不读全局 ⇒ 输入输出都能钉死 ✓（正文截断、空值、多节点编号都在单测里钉 ✓）。
 * ⚠️ 这里的文本**只送给侧栏输入框**，不代替用户发送 ✓（见 renderer 侧调用点）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMSidebarContext = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 单节点正文的字符上限（多节点时**每个**都按它截 ✓ —— 侧栏输入框里塞太多反而难用） */
  const DETAIL_MAX = 600;

  /**
   * @param {string} projectName 项目名（写进抬头，让对面的 AI 知道上下文来自哪 ✓）
   * @param {Array<{topic?:string,tags?:string[],detailText?:string,pathText?:string}>} nodes
   * @returns {string} 直接可投喂的文本
   */
  function buildSidebarText(projectName, nodes) {
    const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
    const proj = projectName ? String(projectName) : '?';
    const head = list.length > 1
      ? ('【来自 AI MindMap·' + proj + '】以下 ' + list.length + ' 个节点：')
      : ('【来自 AI MindMap·' + proj + '】以下节点：');
    const lines = [head];
    list.forEach((n, k) => {
      const topic = (n && n.topic) ? String(n.topic) : '(无标题)';
      lines.push('');
      lines.push(list.length > 1 ? ((k + 1) + '. ' + topic) : topic);
      if (n && n.pathText) lines.push('   路径：' + String(n.pathText));
      const tags = (n && Array.isArray(n.tags)) ? n.tags : [];
      if (tags.length) lines.push('   标签：' + tags.join('、'));
      const plain = (n && n.detailText) ? String(n.detailText).replace(/\s+/g, ' ').trim() : '';
      if (plain) {
        const cut = plain.length > DETAIL_MAX;
        lines.push('   正文' + (cut ? '（截断）' : '') + '：' + plain.slice(0, DETAIL_MAX));
      }
    });
    if (!list.length) lines.push('（没有选中任何节点）');
    lines.push('');
    lines.push('（这些是我这边的上下文；接着我想问 —— 你按需回答即可。）');
    return lines.join('\n');
  }

  return { buildSidebarText, DETAIL_MAX };
}));
