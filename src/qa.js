/* ============================================================
 * src/qa.js — AI 问答落盘：问答记录（`node.qa`）与落盘文本的形状（纯函数、无 IO）
 * ------------------------------------------------------------
 * 需求（用户原话）：「AI 产出直接落到节点与详情」+ 卖点 5 点名的「AI 问答记录」。
 * 这一份是**唯一实现**：渲染层把"哪一问、哪一答、哪个模型、什么时候"交下来，
 * 追加进 `detail` 与 `qa` 两处的**文本形状**全在这里定 —— 否则界面与 CLI 各写一套，
 * 迟早出现"界面追加的没有来源标记""CLI 追加的时间戳格式不同"（本工程的"同一事实两处表达"病）。
 *
 * 两个契约：
 *   ① `qa` 是**可选字段**（无则兼容、不升 formatVersion，见 docs/DATA-FORMAT.md §2.7）：
 *      `[{ q, a, at, model? }]`，`q` 可为空串（"解释这个节点"就是一种没有提问文本的问答）。
 *   ② `detail` 追加的是 **HTML**（存储格式就是 HTML，渲染层以 innerHTML 注入）——
 *      调用方给 Markdown，本模块负责转换与转义 ✓。
 *
 * 为什么**追加**而不是覆盖（用户要求"重复写入不覆盖历史"）：问答是流水，
 * 第二次写入把第一次抹掉 = 把 AI 产出变成"只有最后一次"，那是本工程最重的损害类别（静默丢失）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./convert.js'));
  } else {
    root.MMQa = factory(root.MMConvert);
  }
})(typeof self !== 'undefined' ? self : this, function (convert) {
  'use strict';

  /** 子节点标题的目标长度（超出截断并加省略号）。为什么是 40：导图画布上节点的可视宽度约 8–14 个中文字，
   *  40 字已能表达"这是一句完整的话"，再长只会让画布被一个节点撑开（用户反馈过的"节点太宽"）。 */
  const TITLE_MAX = 40;
  /** 来源标记：写进 detail 的那一行。**必须能一眼看出这段是 AI 生成的、什么时候生成的**。 */
  const MARK = '🤖 AI 问答';

  /** ISO 时间 → 人读的本地时间串（写进 detail 给人看）。取不到就回原串（不静默编一个时间 ✗）。 */
  function fmtAt(at) {
    const d = new Date(String(at));
    if (isNaN(d.getTime())) return String(at);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 由回答派生子节点标题：取**首个非空行**、去掉标题井号/列表符/强调标记，再截断。 */
  function deriveTitle(answer, max) {
    const limit = Number.isInteger(max) && max > 0 ? max : TITLE_MAX;
    const lines = String(answer == null ? '' : answer).split(/\r?\n/);
    let first = '';
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      first = t;
      break;
    }
    first = first
      .replace(/^#{1,6}\s+/, '')     // ATX 标题的井号
      .replace(/^[-*+]\s+/, '')       // 列表符号
      .replace(/^\d+[.)]\s+/, '')     // 有序列表
      .replace(/^>\s*/, '')           // 引用块
      .replace(/\*\*/g, '')           // 强调标记（不渲染成标题里的一堆星号）
      .replace(/`/g, '')
      .trim();
    if (!first) first = 'AI 回答';
    return first.length > limit ? (first.slice(0, limit) + '…') : first;
  }

  /** 来源标记行（HTML，给 detail 用） */
  function markerHtml(entry) {
    const when = fmtAt(entry.at);
    const who = entry.model ? (' · ' + escapeHtml(entry.model)) : '';
    return '<p><strong>' + MARK + '</strong> · ' + escapeHtml(when) + who + '</p>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 本次要追加进 detail 的那一段 HTML（**带来源标记与时间** —— 用户要求） */
  function appendHtml(entry) {
    const parts = [markerHtml(entry)];
    const q = String(entry.q == null ? '' : entry.q).trim();
    if (q) {
      const qHtml = convert.markdownToHtml(q);
      parts.push('<p><em>问：</em></p>');
      parts.push(qHtml);
    } else {
      parts.push('<p><em>（解释这个节点，我没有提问文本）</em></p>');
    }
    const aHtml = convert.markdownToHtml(String(entry.a == null ? '' : entry.a));
    parts.push('<p><em>答：</em></p>');
    parts.push(aHtml);
    return parts.join('\n');
  }

  /**
   * 追加一段问答到 detail（**返回新串，不改入参**）。
   * 分隔符用 `<hr>`：它是"这一段是后来追加的"的可见边界，也让重复写入**必然堆叠**而不互相覆盖 ✓
   */
  function appendToDetail(existing, entry) {
    const block = appendHtml(entry);
    const cur = String(existing == null ? '' : existing);
    if (!cur.trim()) return block;
    return cur.replace(/\s+$/, '') + '\n<hr>\n' + block;
  }

  /** 造一条 qa 记录（字段顺序固定 ⇒ 落盘 diff 稳定） */
  function entryOf(input) {
    const i = input || {};
    const e = { q: String(i.q == null ? '' : i.q), a: String(i.a == null ? '' : i.a), at: String(i.at || '') };
    if (i.model) e.model = String(i.model);
    return e;
  }

  /** 子节点对象（id 由调用方给：主进程生成，避免渲染层自己造 id ✗） */
  function childNodeOf(answer, id) {
    return {
      id: id,
      topic: deriveTitle(answer),
      expanded: true,
      detail: convert.markdownToHtml(String(answer == null ? '' : answer)),
      children: []
    };
  }

  return { TITLE_MAX, MARK, fmtAt, deriveTitle, appendHtml, appendToDetail, entryOf, childNodeOf, escapeHtml };
});
