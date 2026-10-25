/* ============================================================
 * src/sidebar-context.js — ⑨ 把"选中了哪些节点"编成**投喂单位**（每个节点一行 `@项目/标题`）
 * ------------------------------------------------------------
 * 为什么单独一个 src 模块（而不是写在 renderer/app-ask.js 里 ✗）：
 *   · renderer/*.js 是 IIFE，**在 node 里没法 require** ⇒ 那段文本拼装逻辑**无法单测** ✗；
 *   · 放 src/ 就同时被"渲染层（script 标签）"和"node 单测"拿到 ⇒ **一份实现、两处用** ✓。
 * 纯函数：不碰 DOM、不读全局 ⇒ 输入输出都能钉死 ✓。
 * ⚠️ 这里的文本**只送给侧栏输入框**，不代替用户发送 ✓（见 renderer 侧调用点）。
 *
 * ── 2026-10-39 改口径（用户原话，逐字）─────────────────────────────────────────
 *   「拖过去两个节点直接弹这么多。不可以直接在对话栏里显示两个"节点链接"吗？
 *     就好像 cursor 里面把文件拖进对话里一样」
 * ⇒ 旧实现（抬头句 + 编号 + 路径 + 标签 + 正文各 600 字 + 结尾模板句）**整段作废**。
 *   现在**每个节点只产出一样东西**：一行 `@<项目>/<标题>` —— 无抬头、无编号、无正文、无结尾句。
 *
 * ── 为什么是 `@<项目>/<标题>` 而不是正文搬运 ────────────────────────────────────
 *   · 形态：目标框的占位文字就写着「@ 文件或对话」⇒ 那个位置上的"一条引用"在视觉上就是
 *     `@xxx`。用户要的"节点链接"只能是这个形状（**但它不是真 chip**，见下）。
 *   · 语义：`<项目>/<标题>` 是**指针而不是内容** —— 对面那个 AI 有本工程的指针 skill 与
 *     `mm-cli`（内置实例的 cwd 就是工程根）⇒ 它拿标题就能 `search` / `read --subtree` 取到
 *     正文、路径、标签。搬运正文反而把上下文预算花在了"AI 自己能查到的东西"上。
 *   · 代价（如实，别当卖点）：**不再自带正文**。若对面不是本工程的 AI（或 CLI 不可用），
 *     它就只拿到两个标题。这是这次改口径**主动**换来的轻量。
 *
 * ── ⚠️ 这**不是** chip（别把短文字写成 chip 已实现）──────────────────────────────
 *   DSH 的 `@` 引用是 Lexical 的 `ReferenceChipNode`（原子 decorator），只能由
 *   **已注册的 `inputTriggers` source** 经 `slash/input-insert-reference` 事件插入；
 *   页面侧（`executeJavaScript`）拿不到 cordis 根 ctx，本仓也没有给内置实例投客户端插件。
 *   ⇒ 这里产出的是**纯文本**：目标框不会给它描边、不会给它删除按钮、提交时也不会被
 *     `serializeReference` 处理。详见 `.review/20261039-投喂形态/` 的取证与 CHANGELOG。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMSidebarContext = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 单行引用的字符上限（标题极端长时截断；**引用必须是一行** —— 换行会把一个单位劈成两个） */
  const REF_MAX = 200;

  /** 把标题压成"一行"：连续空白（含换行/制表）折成单个空格；空标题给占位词。 */
  function oneLine(topic) {
    const t = String(topic == null ? '' : topic).replace(/\s+/g, ' ').trim();
    return t || '(无标题)';
  }

  /**
   * @param {string} projectName 项目名（进 `<项目>/` 那一段；缺省 ⇒ 只输出 `@<标题>`）
   * @param {Array<{topic?:string}>} nodes 选中的节点（其余字段一律**不再**进文本）
   * @returns {string} 每个节点一行 `@<项目>/<标题>`；没有节点 ⇒ 空串（**由调用方报"没有内容"**）
   */
  function buildSidebarText(projectName, nodes) {
    const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
    if (!list.length) return '';          // 空 ⇒ 空串：`prefillComposer` 自己会报"没有要送过去的内容"
    const proj = String(projectName == null ? '' : projectName).trim();
    const head = proj ? (proj + '/') : '';
    return list.map((n) => {
      const line = '@' + head + oneLine(n && n.topic);
      /* 截断**只截标题段**，`@` 与 `<项目>/` 一定留着（否则那一行就不再像一个引用单位了） */
      if (line.length <= REF_MAX) return line;
      return line.slice(0, REF_MAX - 1) + '…';
    }).join('\n');
  }

  return { buildSidebarText, REF_MAX };
}));
