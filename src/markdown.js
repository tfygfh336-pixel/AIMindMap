/* ============================================================
 * src/markdown.js — Markdown ⇄ 节点树（UMD）
 * ------------------------------------------------------------
 * 职责：
 *   - markdownToTree(md, parentId, idGen)：md → 子树，追加到 parent 下
 *     （CLI import-md 使用）。支持两种形态，自动识别：
 *       · heading 形态：`# 标题` / `## 子标题`（# 数量 = 层级）
 *       · list 形态：`- 标题`（每级缩进 2 空格）
 *     正文处理：
 *       · `> ...` 引用块 → 还原为节点 detail（HTML），与导出成对
 *       · `![图：备注](assets/x.png)` → 节点 images
 *       · `[📎 备注 — attachments/x.md](attachments/x.md)` → 节点 files
 *       · 其余非标题行 → 也转成 detail（HTML），保证 detail 始终是 HTML
 *   - treeToMarkdown(tree, {format, withDetail, withResources})：节点树 → 大纲
 *     （CLI export-md 使用）
 * 说明：导入是「追加为子树」，因此整份导出再导入会把顶层标题也变成一个节点
 *   （导出文档的第一行标题 = 文档标题，不是父节点本身）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./convert.js'));
  else root.MMMarkdown = factory(root.MMConvert);
})(typeof self !== 'undefined' ? self : this, function (convert) {
  'use strict';

  const H_RE = /^(#{1,6})\s+(.*)$/;
  const L_RE = /^(\s*)[-*]\s+(.*)$/;

  /** 生成符合 id 规范的 id */
  function idGen(seed) {
    const base = String(seed || 'n')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'n';
    return base + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 首行形态判定：heading 优先，其次 list；引用块不参与判定 */
  function detectMode(lines) {
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || /^>/.test(t)) continue;
      if (/^#{1,6}\s+/.test(t)) return 'heading';
      if (/^[-*]\s+/.test(t)) return 'list';
      return 'heading';
    }
    return 'heading';
  }

  /** 资源行（图片/附件）识别 —— 与 treeToMarkdown 的 withResources 输出成对 */
  function parseResource(t) {
    const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
    if (img) {
      const file = img[2].trim();
      const cap = img[1].replace(/^图：/, '').trim();
      return { kind: 'image', file, caption: cap || file };
    }
    const f = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
    if (f && f[1].indexOf('📎') >= 0) {
      const file = f[2].trim();
      let cap = f[1].replace(/^📎\s*/, '').trim();
      const suffix = ' — ' + file;
      if (cap.slice(-suffix.length) === suffix) cap = cap.slice(0, -suffix.length).trim();
      return { kind: 'file', file, caption: cap || file };
    }
    return null;
  }

  /**
   * Markdown 大纲 → 追加到 parent 下的节点树
   * @returns {{data, addedCount}} data 为新子树（根），addedCount 为新增节点数
   */
  function markdownToTree(md, parentId, genId) {
    const g = genId || idGen;
    const rawLines = String(md || '').split(/\r?\n/);
    const mode = detectMode(rawLines);
    // 栈：每层最近节点；栈底是 parent 占位
    const stack = [{ id: parentId, children: [] }];
    let addedCount = 0;
    let cur = null;
    let seg = null; // 期望写入 cur.detail 的连续片段 { kind, lines }

    function flushSeg() {
      if (seg && cur && seg.lines.length) {
        const html = convert.markdownToHtml(seg.lines.join('\n'));
        if (html) cur.detail = cur.detail ? cur.detail + '\n' + html : html;
      }
      seg = null;
    }

    function openNode(topic, level) {
      flushSeg();
      const node = { id: g(topic), topic, expanded: true, children: [] };
      // 调整栈深度：level-1 层为父
      while (stack.length > level) stack.pop();
      while (stack.length < level) {
        // 中间缺层：用占位节点兜底，避免结构损坏
        const holder = { id: g('层级' + (stack.length + 1)), topic: '（层级' + (stack.length + 1) + '）', expanded: true, children: [] };
        stack[stack.length - 1].children.push(holder);
        stack.push(holder);
        addedCount++;
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      cur = node;
      addedCount++;
    }

    /* ⚠️ 围栏代码块必须**整段原样**收集，这里用 `inFence` 显式隔绝三件事：
     *   ① 空行不得触发 flushSeg（否则跨空行的围栏被切成多段、各段独立转 HTML ⇒ 代码碎成 <p>/<li>）；
     *   ② 围栏内的 `# 标题` / `- 列表` / 图片附件语法**一律不解读**（C 的 `#include`、shell 的 `# 注释`
     *      都是代码，不是结构）；
     *   ③ 缩进与 `>` 前缀不做任何加工（`kind:'text'` 不 strip）。
     * 实测代价（本次导入 day3/day4 案例程序时才发现）：Makefile 源 7 行 → detail 只剩 1 行；
     * netlink_user.c 143 行 → 6 行 —— 属"静默损坏"类，比报错危险得多。
     * 收尾标记也要收进段里，`markdownToHtml` 才能把它渲染成 `<pre><code>`。 */
    let inFence = false;
    for (const raw of rawLines) {
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      const isFence = /^```/.test(trimmed);
      if (inFence) {
        seg.lines.push(line);
        if (isFence) { inFence = false; flushSeg(); }   // 收尾 ⇒ 整段立刻定格
        continue;
      }
      if (isFence) {                                     // 开围栏
        flushSeg();
        seg = { kind: 'text', lines: [line] };
        inFence = true;
        continue;
      }
      if (mode === 'heading') {
        const m = H_RE.exec(line);
        if (m) {
          const topic = m[2].trim();
          if (!topic) continue;
          openNode(topic, m[1].length);
          continue;
        }
      } else {
        const m = L_RE.exec(line);
        if (m && m[2].trim()) {
          const indent = m[1].replace(/\t/g, '  ').length;
          openNode(m[2].trim(), Math.floor(indent / 2) + 1);
          continue;
        }
      }
      const t = line.trim();
      if (!t) { flushSeg(); continue; }
      if (!cur) continue;
      const res = parseResource(t);
      if (res) {
        flushSeg();
        if (res.kind === 'image') (cur.images = cur.images || []).push({ file: res.file, caption: res.caption });
        else (cur.files = cur.files || []).push({ file: res.file, caption: res.caption });
        continue;
      }
      const kind = /^>/.test(t) ? 'quote' : 'text';
      if (!seg || seg.kind !== kind) { flushSeg(); seg = { kind, lines: [] }; }
      seg.lines.push(kind === 'quote' ? t.replace(/^>\s?/, '') : t);
    }
    flushSeg();
    return { data: stack[0], addedCount };
  }

  /**
   * 节点树 → Markdown 大纲
   * @param {object} root 根节点
   * @param {object} opts { format: 'heading'|'list', withDetail, withResources }
   * @returns {string}
   */
  function treeToMarkdown(root, opts) {
    const o = opts || {};
    const fmt = o.format === 'list' ? 'list' : 'heading';
    const out = [];
    const walk = (node, level) => {
      if (fmt === 'heading') {
        // Markdown 只支持 1–6 级标题（H_RE 也只认 1–6）。
        // 超过 6 层若继续 `'#'.repeat(level)`，会生成 `#######` —— 导入时**认不出来**，
        // 该节点被降级成父节点 detail 里的一行字面井号，即**静默丢节点**
        // （实测 8 层树往返后只剩 L1..L6）。故这里夹取到 6，并以缩进保留深度信息，
        // 使深层节点至少在视觉上可区分、且仍能被导入成节点。
        const lv = Math.min(6, Math.max(1, level));
        const extra = level > 6 ? '　'.repeat(level - 6) : '';
        out.push('#'.repeat(lv) + ' ' + extra + node.topic);
      } else {
        out.push('  '.repeat(Math.max(0, level - 1)) + '- ' + node.topic);
      }
      if (o.withDetail && node.detail) {
        const quote = convert.detailToMarkdown(node.detail);
        if (quote) out.push(quote);
      }
      // withResources：把节点挂载的图片/附件写成相对路径链接
      // （配合 export-md 文件夹导出：md 与 assets/、attachments/ 同目录，链接可用）
      if (o.withResources) {
        (node.images || []).forEach((img) => {
          out.push('![图：' + (img.caption || img.file) + '](' + img.file + ')');
        });
        (node.files || []).forEach((f) => {
          out.push('[📎 ' + (f.caption || f.file) + ' — ' + f.file + '](' + f.file + ')');
        });
      }
      (node.children || []).forEach((c) => walk(c, level + 1));
    };
    walk(root, 1);
    return out.join('\n');
  }

  return { markdownToTree, treeToMarkdown, idGen };
});
