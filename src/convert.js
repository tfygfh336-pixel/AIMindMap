/* ============================================================
 * src/convert.js — HTML ⇄ Markdown 转换（UMD）
 * ------------------------------------------------------------
 * 用于节点 detail（HTML）与导出 Markdown / 导入时互为转换。
 * 只覆盖本工程常用的语义化标签：
 *   h1-h6 / p / ul / ol / li / table / code / pre / a / img / strong / em / br
 *
 * 往返约定（导入导出必须成对）：
 *   - 导出带 detail 时写成引用块（每行前缀 "> "），导入时先剥掉该前缀再转 HTML
 *   - 表格导出为 GFM 表格，导入时反向还原为 <table>
 *   - markdownToHtml 会先做 HTML 转义再套用行内语法，避免 md 里的裸标签被当 HTML 注入
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMConvert = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stripTags(s) {
    return String(s).replace(/<[^>]+>/g, '').trim();
  }

  /** HTML → 纯文本（供全文搜索与「未链接提及」匹配使用）
   *
   *  两个容易写错的细节：
   *   1. **先剥标签、后解实体**。反过来的话，正文里被转义成 `&lt;b&gt;` 的字面文本
   *      会在解实体后变成 `<b>`，再被当成标签剥掉 —— 丢失用户真实内容。
   *   2. **`&amp;` 必须最后解**。否则 `&amp;lt;` 会先变成 `&lt;`，再被解成 `<`，发生二次解码。
   *  标签替换为**空格**（而非空串），避免 `<b>交换机</b>协议` 粘成「交换机协议」而破坏匹配边界。 */
  function stripHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** HTML → Markdown（轻量、语义化） */
  function htmlToMarkdown(html) {
    if (!html) return '';
    let s = String(html);
    // 顺序关键：先做语义转换（此时标签完整），再处理块级换行与残留标签。
    // 若先替换 </h2></li> 为换行，后面的标题/列表正则将永远匹配不上（历史 bug）。
    // 表格 → GFM（必须在「去残留标签」之前，否则行列结构丢失）
    s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (m, inner) => {
      const rows = [];
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let tr;
      while ((tr = trRe.exec(inner))) {
        const cells = [];
        const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
        let c;
        while ((c = cellRe.exec(tr[1]))) cells.push(stripTags(c[2].replace(/<br[^>]*>/gi, ' ')));
        rows.push(cells);
      }
      if (!rows.length) return '';
      const head = rows[0];
      let md = '\n| ' + head.join(' | ') + ' |\n| ' + head.map(() => '---').join(' | ') + ' |';
      rows.slice(1).forEach((r) => { md += '\n| ' + r.join(' | ') + ' |'; });
      return md + '\n';
    });
    // 标题
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, inner) => '\n' + '#'.repeat(Number(lv)) + ' ' + inner.trim() + '\n');
    // 列表项
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- ' + '$1');
    // 代码块
    s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => '\n```\n' + inner.replace(/<[^>]+>/g, '') + '\n```\n');
    // 行内代码
    s = s.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    // 链接
    s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    // 图片
    s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)');
    // 加粗 / 斜体
    s = s.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
    s = s.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
    s = s.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
    s = s.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
    // 换行
    s = s.replace(/<br[^>]*>/gi, '\n');
    // 块级标签 → 换行
    s = s.replace(/<\/(p|div|ul|ol|blockquote|h[1-6]|li|pre|table|tr)>/gi, '\n');
    s = s.replace(/<(p|div|ul|ol|blockquote|h[1-6]|li|pre|table|tr)[^>]*>/gi, '\n');
    // 去掉残留标签
    s = s.replace(/<[^>]+>/g, '');
    // HTML 实体还原（否则 &amp; 会被原样导出，再导入变成 &amp;amp;）
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    // 清理多余空行（保留至多一个连续空行）
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  /** 行内语法（链接/图片/代码/加粗）——输入须已转义
   *
   *  ⚠️ **URL 位置必须过 scheme 白名单**（R7 起；判据表在 `src/html-whitelist.js`，**只有那一份**）：
   *  原先这里把 URL **原样**写进 `href`/`src`、零过滤 —— 于是 `markdownToHtml('[x](javascript:alert(1))')`
   *  会产出**活的** `<a href="javascript:alert(1)">`。`escapeHtml` 只作用于**文本节点**，管不到 URL 位置。
   *  （CSP 的 `script-src` 理论上会拦 `javascript:` URL，但**不该把安全押在 CSP 上** —— 设计稿 §⑫-6.4。）
   *  处置：不安全的地址**降级成纯文本**（丢掉链接/图片本身，文字一个不丢），**不静默保留**。 */
  function whitelistMod() {
    if (typeof module === 'object' && module.exports) return require('./html-whitelist.js');
    return (typeof self !== 'undefined' ? self : {}).MMHtmlWhitelist || null;
  }

  function safeUrl(raw, where) {
    const w = whitelistMod();
    if (!w || typeof w.classifyUrl !== 'function') return { ok: true, raw: String(raw) };  // 表没加载：按原样（渲染层的消毒仍会拦）
    // `'convert'` 档 = **转换期**：只拦危险 scheme，`http(s)` 照旧落盘（理由见 `src/html-whitelist.js`）
    const c = w.classifyUrl(raw, where, 'convert');
    return c.ok ? { ok: true, raw: String(raw) } : { ok: false, reason: c.reason };
  }

  function inline(s) {
    let x = String(s);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    x = x.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    x = x.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
      const u = safeUrl(url, 'img');
      return u.ok ? '<img src="' + u.raw + '" alt="' + alt + '">' : alt;
    });
    x = x.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
      const u = safeUrl(url, 'a');
      return u.ok ? '<a href="' + u.raw + '">' + text + '</a>' : text;
    });
    return x;
  }

  function isTableRow(t) {
    return /^\|.*\|$/.test(t) && t.split('|').length >= 3;
  }
  function isTableSep(t) {
    return /^\|?[\s:|-]+\|?$/.test(t) && t.indexOf('-') >= 0;
  }
  function splitRow(t) {
    return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  /** Markdown → HTML（轻量，逆映射；用于导入时把 detail 转 HTML） */
  function markdownToHtml(md) {
    if (!md) return '';
    const lines = String(md).split(/\r?\n/);
    const out = [];
    const deQuote = (l) => String(l).replace(/^>\s?/, '');
    let i = 0;
    while (i < lines.length) {
      const t = deQuote(lines[i]).trim();
      if (!t) { i++; continue; }
      // 围栏代码块
      if (/^```/.test(t)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(deQuote(lines[i]).trim())) { code.push(deQuote(lines[i])); i++; }
        i++;
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }
      // 表格（GFM：表头 + 分隔行 + 数据行）
      if (isTableRow(t) && i + 1 < lines.length && isTableSep(deQuote(lines[i + 1]).trim())) {
        const head = splitRow(t);
        const body = [];
        i += 2;
        while (i < lines.length && isTableRow(deQuote(lines[i]).trim())) {
          body.push(splitRow(deQuote(lines[i]).trim()));
          i++;
        }
        let html = '<table><tr>' + head.map((c) => '<th>' + inline(escapeHtml(c)) + '</th>').join('') + '</tr>';
        body.forEach((r) => { html += '<tr>' + r.map((c) => '<td>' + inline(escapeHtml(c)) + '</td>').join('') + '</tr>'; });
        out.push(html + '</table>');
        continue;
      }
      // 标题
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        const lv = h[1].length;
        out.push('<h' + lv + '>' + inline(escapeHtml(h[2].trim())) + '</h' + lv + '>');
        i++;
        continue;
      }
      // 无序列表（连续 - / * 合并为一个 <ul>）
      if (/^[-*]\s+/.test(t)) {
        const items = [];
        while (i < lines.length) {
          const m = /^[-*]\s+(.*)$/.exec(deQuote(lines[i]).trim());
          if (!m) break;
          items.push('<li>' + inline(escapeHtml(m[1])) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      // 段落
      out.push('<p>' + inline(escapeHtml(t)) + '</p>');
      i++;
    }
    return out.join('\n');
  }

  /** 节点 detail（HTML）→ 导出用的 Markdown 引用块 */
  function detailToMarkdown(html) {
    const md = htmlToMarkdown(html);
    if (!md) return '';
    return '> ' + md.split('\n').map((l) => l.trim()).filter(Boolean).join('\n> ');
  }

  return { htmlToMarkdown, markdownToHtml, detailToMarkdown, escapeHtml, stripHtml, stripTags };
});
