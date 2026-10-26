/* ============================================================
 * src/sidebar-context.js — ⑨ 把"选中了哪些节点"编成**投喂单位**（每个节点一行 `项目/标题`）
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
 *   现在**每个节点只产出一样东西**：一行 —— 无抬头、无编号、无正文、无结尾句。
 *
 * ── 2026-10-40 改口径：**`@` 是那个输入框自己的触发符，所以文案里一个 `@` 都不留** ──────
 *   真机现象（用户截图，逐字）：拖 2 个节点进内置 DSH 的对话栏，框里变成
 *     `@book-80211-guide/@book-80211-guide/ 全书概览与使用说明`
 *     `@book-80211-guide/ 第一章 无线网络导论 @book-80211-guide/全书概览与使用说明`
 *     `@book-80211-guide/ 第一章 无线网络导论全书概览与使用说明 @book-80211-guide/第一章 无线网络导论`
 *   —— 前缀重复、两标题粘成一行、整段叠三遍。
 *   而**文案本身是对的**（`node -e` 直调本函数 ⇒ 56 字 / 2 行，逐字正确）
 *   ⇒ 问题不在拼装，在于**那段文本的形状**：`@名字/` 正好是 composer 的引用触发形状。
 *
 *   ★ 这条不是猜的，`vendor/dsh` **只读**源码里能读到判据
 *     （`vendor/dsh/app/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`，
 *      包版本 0.1.7-rc.2；行号是一次性取证，别当长期契约）：
 *       · 第 12632 行 `const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g;`
 *       · 第 12633 行 `const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g;`
 *       · 第 12749 `registerTextRefDecoration(...)` 把命中的区间替换成 `TextRefNode`
 *         （第 12688 行；`isTextEntity()===true` ⇒ 原子、不与相邻文本合并的**实体节点**）。
 *     ⇒ `@book-80211-guide/` 在"行首或空白之后"**正好命中 FOLDER_REF_RE**
 *       ⇒ composer 会把它当引用实体去改造（视觉上描边/成块），而我们在框外**读不回**那层改造。
 *     ⇒ 去掉 `@` 之后：`book-80211-guide/全书概览与使用说明` 里那个 `/` **前面是字母不是空白/行首**
 *       ⇒ `TEXT_REF_RE` 不命中；没有 `@` ⇒ `FOLDER_REF_RE` 也不命中
 *       ⇒ **文案对 composer 变成纯正文，一个字都不会被改写** ✓（这才是本批真正的修法）
 *   ⚠️ 反向约束（**护栏**）：`/` 也是触发符（占位文字：「/ 调用指令」）⇒
 *      **行首也不许是 `/`**，`@` 更是一个都不许有。单测里那条"逐行不含 @、不以 / 开头"就是护栏，
 *      谁把 `@` 加回来它就立刻红 ✓。
 *
 * ── ⚠️ 这**不是** chip（别把短文字写成 chip 已实现）──────────────────────────────
 *   DSH 的 `@` 引用是 Lexical 的 `ReferenceChipNode`（原子 decorator），只能由
 *   **已注册的 `inputTriggers` source** 经 `slash/input-insert-reference` 事件插入；
 *   页面侧（`executeJavaScript`）拿不到 cordis 根 ctx，本仓也没有给内置实例投客户端插件。
 *   ⇒ 这里产出的是**纯文本**：目标框不会给它描边、不会给它删除按钮、提交时也不会被
 *     `serializeReference` 处理。详见 `.review/20261040-@触发与换行/` 与 CHANGELOG。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMSidebarContext = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 单行引用的字符上限（标题极端长时截断；**引用必须是一行** —— 换行会把一个单位劈成两个） */
  const REF_MAX = 200;

  /** composer 的触发符：`@`（引用）与 `/`（指令）。两者都是"行首或空白之后"才触发
   *  （见文件头引的 TEXT_REF_RE / FOLDER_REF_RE）⇒ 拼装时**行首一律不许出现**，`@` 干脆一个不留。 */
  const TRIGGER_CHARS = '@/';

  /** 把标题压成"一行"：连续空白（含换行/制表）折成单个空格；空标题给占位词。
   *  `@` 一律删掉（它是触发符，不是内容）—— 删完是空的就走占位词 ✓ */
  function oneLine(topic) {
    const t = String(topic == null ? '' : topic)
      .replace(/\s+/g, ' ')
      .replace(/@/g, '')
      .trim();
    return t || '(无标题)';
  }

  /** 一行"投喂单位"是否安全：**不含 `@`** 且 **不以 `/` 或 `@` 开头**。
   *  为什么把它导出来：单测要用它做**判别力证明**（"把 `@` 加回去 ⇒ 这个判据必须红"），
   *  而不是在断言里手抄一遍判定规则（手抄＝第二份副本，规则一改就漂 ✗）。 */
  function isSafeUnit(line) {
    const t = String(line == null ? '' : line);
    if (t.indexOf('@') >= 0) return false;                       // @ 一个都不许有
    return TRIGGER_CHARS.indexOf(t.charAt(0)) < 0;               // 行首不许是触发符
  }

  /**
   * @param {string} projectName 项目名（进 `<项目>/` 那一段；缺省 ⇒ 只输出 `<标题>`）
   * @param {Array<{topic?:string}>} nodes 选中的节点（其余字段一律**不再**进文本）
   * @returns {string} 每个节点一行 `<项目>/<标题>`；没有节点 ⇒ 空串（**由调用方报"没有内容"**）
   */
  function buildSidebarText(projectName, nodes) {
    const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
    if (!list.length) return '';          // 空 ⇒ 空串：`prefillComposer` 自己会报"没有要送过去的内容"
    const proj = String(projectName == null ? '' : projectName).replace(/@/g, '').trim();
    const head = proj ? (proj + '/') : '';
    return list.map((n) => {
      let line = head + oneLine(n && n.topic);
      /* 行首护栏：项目名为空且标题以 `/`（或上面漏网的 `@`）开头时，第一步就不让它站在触发位上 */
      if (!isSafeUnit(line)) line = line.replace(/^[@/]+/, '');
      if (!line) line = '(无标题)';
      /* 截断**只截标题段**：`<项目>/` 一定留着（否则那一行就不再像一个引用单位了） */
      if (line.length <= REF_MAX) return line;
      return line.slice(0, REF_MAX - 1) + '…';
    }).join('\n');
  }

  return { buildSidebarText, isSafeUnit, oneLine, REF_MAX, TRIGGER_CHARS };
}));
