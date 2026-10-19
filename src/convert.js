/* ============================================================
 * src/convert.js — HTML ⇄ Markdown 转换（UMD）
 * ------------------------------------------------------------
 * 用于节点 detail（HTML）与导出 Markdown / 导入时互为转换。
 * 只覆盖本工程常用的语义化标签：
 *   h1-h6 / p / ul / ol / li / table / code / pre / a / img / strong / em / br / hr
 *
 * 往返约定（导入导出必须成对）：
 *   - 导出带 detail 时写成引用块（每行前缀 "> "），导入时先剥掉该前缀再转 HTML
 *   - 表格导出为 GFM 表格，导入时反向还原为 <table>
 *     （**导入认 `\|` 转义**：那是单元格里的**字面竖线**，不是分隔符；见 `splitRow()` 头顶那段）
 *     **导出也写 `\|`**：单元格文本里的每个 `|` 都写成 `\|`（否则导出件再导入会**多切出一格**）。
 *     ⚠️ 相邻的反斜杠按 `2k+1` 规则加，别只转义竖线 —— 细节与反证见 `escapeCellText()` 头顶那段。
 *     边界（**没做，也不打算做**）：单元格里的**行内格式**导出时被压平（`stripTags()`），
 *     `<code>a | b</code>` 出去是字面 `a \| b`、回来是 `<td>a | b</td>` —— 内容不丢、格式不保。
 *     这是改动前就有的行为（`<strong>` / `<em>` 同样压平），本文件不处理表格内的行内语法。
 *   - 分隔线 `---` / `***` / `___`（独占一行）导入成 `<hr>`；**导出成 `---`**（`<hr>` ⇒ `\n---\n`，
 *     由 `htmlToMarkdown()` 的「分隔线」那一步做）—— 两边成对，往返后 `<hr>` 还在。
 *   - **已知缺口（既有行为，本文件不修，只记录）**：GFM 表格里"表头 / 数据行"的身份由**位置**决定
 *     （第一行是表头、第二行是分隔行、其余是数据行），而 `htmlToMarkdown()` 是拿 `rows[0]` 当表头导出的。
 *     ⇒ 只有一行 `<td>` 的表导出再导入，回来是 **`<th>`**（`<td>` 数 0）：**内容不丢、格数不变，
 *     但"数据格"变成了"表头格"**。要多行才看得出差别（两行表的第二行仍是 `<td>`，实测见
 *     `tests/convert.test.js` 的目标 B 用例）。要么在导出时补一行占位表头，要么在导入时按原语义还原 ——
 *     两者都会改动现有导出件形状，**需要单独一批**（本批只做逆映射，不动这条）。
 *     同一类的第二处边界：单元格里的**行内格式**（`<code>` / `<strong>`）导出时被 `stripTags()` 压平，
 *     这是改动前就有的行为（见上）。
 *   - markdownToHtml 会先做 HTML 转义再套用行内语法，避免 md 里的裸标签被当 HTML 注入
 *   - **行内代码区（反引号 / 字面 <code>·<pre>）在套行内语法前先占位保护**：
 *     代码里的 `*` 是**内容**（通配符 / 指针星号 / 乘号），不许被强调解析吃掉
 *     （判据与现场见 `inline()` 头顶那段注释）
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
        while ((c = cellRe.exec(tr[1]))) cells.push(escapeCellText(stripTags(c[2].replace(/<br[^>]*>/gi, ' '))));
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
    // 分隔线：`<hr>` ⇒ `---`（**与 `markdownToHtml()` 的 `HR_LINE` 分支成对**，见文件头「往返约定」）
    //
    // 改前没有这一步 ⇒ 导出方向把 `<hr>` **整行丢掉**（`<hr>` 落到下面"去掉残留标签"被当标签删掉），
    // 而导入方向早就认 `---` ⇒ 往返一次分隔线就没了。实测现场：`卖点讨论/bl-3`（detail 以 `<hr>` 开头）。
    // ⚠️ 前后各留一个 `\n` 是为了**借块级换行拼出"独占一行"**：`<p>a</p><hr><p>b</p>` 这里产出的是
    //    `…a\n\n---\n\nb…`（下面的 `</p>` / `<p>` → `\n` 各出一个），与段落间距**同一口径**，
    //    既不会把 `---` 粘到前一段尾巴上（`a---` 不成标记），也不会多出第三连空行（`\n{3,}` 会折成两个）。
    // ⚠️ 位置在 `<pre>` / `<code>` 之后：代码区里的字面 `<hr>` 早已被那些分支吃掉，这里不会误伤代码。
    s = s.replace(/<hr\b[^>]*\/?>/gi, '\n---\n');
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

  /**
   * ⚠️⚠️ **代码区必须先占位保护、再跑强调替换**（2026-10-20 根治；现场与判据见 `tests/convert.test.js`）：
   *  这三条行内替换以前是**顺序裸跑**的 —— 反引号先变成 `<code>…</code>`，而 `*` → `<em>` 的替换
   *  **随后**在**整行**上按"两个星号配一对"扫，它**不认识 code 边界** ⇒ 同一行里的两个 `*`
   *  （通配符 / C 指针星号 / 乘号）会**跨 code 区**配对，把 `<code>` 劈成两半。实测产物：
   *    · `` `src/*.js` 与 `lib/*.js` `` ⇒ `<code>src/<em>.js</code>`、`<code>lib/</em>.js</code>`（开闭落在两个区里）；
   *    · `` `handler(int, siginfo_t*, void*)` `` ⇒ `<code>siginfo_t<em>, void</em>)</code>`
   *      —— **`siginfo_t*` 少了 `*` 就不是那个类型**，这是把「知识」改错，不是排版难看；
   *    · `` `linux-netfilter-tc-*` 与 `qos-*` `` ⇒ `<code>linux-netfilter-tc-<em></code>` / `<code>qos-</em></code>`
   *      （全库实测存量 **16 处 / 10 个节点**，且**任何门禁以前都抓不到** —— 产物形状完全合法）；
   *    · `` `**强调**` `` ⇒ `<code><strong>强调</strong></code>`（代码里套了强调标签）。
   *  **修法不是"遇到 `<code>` 就跳过"的正则**（那治不了跨段配对、嵌套、也管不到反引号形式），
   *  而是**占位**三步：① 代码区挖成不参与任何替换的占位符 ② 跑强调/链接/图片 ③ 把占位符**还原**。
   *  代码区 = 反引号行内代码 + Markdown 里混写的 `<code>` / `<pre>` 字面标签（此时已被 `escapeHtml`
   *  转成 `&lt;code&gt;…&lt;/code&gt;` —— 它仍然是"代码区"，其内的 `*` 同样不许吃）。
   *  **合法正文强调的渲染结果一个字节都不许变**（`**粗**` / `*斜*` / `` `c` `` 都有单测钉住）。
   *  ❌ `2R*8` 这类**不在代码区**的星号与真强调**字面无法区分** ⇒ 本函数**不承诺**处理（`a*b*c` 仍出 `<em>`）。 */
  function inline(s) {
    let x = String(s);
    const sent = codeSentinel(x);             // ②-0 选一个"正文里一定没有"的哨兵（见 codeSentinel）
    const st = stashCode(x, sent);            // ②-1 代码区先占位（此后它不参与下面的任何替换）
    x = st.text;
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
    return restoreCode(x, st.stash, sent);    // ②-2 还原（单趟：还原进去的字节不会再被扫）
  }

  /* ---------- 代码区占位保护（`inline()` 用；纯函数、无状态、无随机数） ---------- */

  /** 占位符的哨兵。**必须不可能与正文冲突** ⇒ 只有在输入里**真的找不到**它时才算数：
   *  撞一次就把它撑长一格再看（`\u0001MM\u0002` → `\u0001\u0001MM\u0002\u0002` → …）⇒
   *  输入长度有限 ⇒ 循环必终止，且终止时那个哨兵一定**不在**输入里 ⇒ 占位符不可能与正文撞车。
   *  **不用随机数**：同一份输入必须产出同一份结果（否则快照、门禁读数、逐字节 diff 全都不可比）。
   *  字符选择：只要没有 `*` `!` `[` `]` `(` `)` 反引号这几类字符，上面的强调/图片/链接正则就消费不到占位符。 */
  function codeSentinel(s) {
    let sent = '\u0001MM\u0002';
    while (s.indexOf(sent) >= 0) sent = '\u0001' + sent + '\u0002';
    return sent;
  }

  /** 把「代码区」挖成占位符，返回 `{ text, stash }`。
   *  代码区两族：① 反引号行内代码 `` `…` ``（反引号不参与 `escapeHtml`，此时仍是原文）
   *             ② Markdown 里混写的 `<code>` / `<pre>` 字面标签（此时已被转义成 `&lt;code&gt;…&lt;/code&gt;`）
   *  一次左到右扫描、**取最先开始的那一个**（外层优先）⇒ 嵌套与"代码里有反引号"都不会走样。 */
  function stashCode(s, sent) {
    const stash = [];
    // 注入证明按**本行**打（去掉第二个分支 ⇒ 字面 `<code>` 区不再受保护；见 tests/convert.test.js 的判别力用例）
    const re = /`([^`]+)`|&lt;(code|pre)(?:\s[^&<>]*)?&gt;([\s\S]*?)&lt;\/\2&gt;/g;
    let text = '';
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      text += s.slice(last, m.index) + sent + stash.length + sent;
      // 反引号 ⇒ 产物与改前**逐字节相同**（`x` → `<code>x</code>`）；字面标签区 ⇒ 原样（它已经是转义文本）
      stash.push(m[1] === undefined ? m[0] : '<code>' + m[1] + '</code>');
      last = re.lastIndex;
    }
    return { text: text + s.slice(last), stash: stash };
  }

  /** 还原占位符（`哨兵+序号+哨兵`）。单趟替换：还原进去的字节**不再**被扫描 ⇒ 不可能套娃。 */
  function restoreCode(s, stash, sent) {
    if (!stash.length) return s;      // 没有代码区 ⇒ 原样返回（零改动路径）
    const parts = s.split(sent);      // 偶数位是正文、奇数位是序号
    let out = parts[0];
    for (let k = 1; k + 1 < parts.length; k += 2) {
      const v = stash[Number(parts[k])];
      // 兜底：序号对不上（不该发生）就把占位符**原样留下** —— 响亮地坏，绝不静默丢代码
      out += (v === undefined ? sent + parts[k] + sent : v) + parts[k + 1];
    }
    return out;
  }

  function isTableRow(t) {
    return /^\|.*\|$/.test(t) && t.split('|').length >= 3;
  }
  function isTableSep(t) {
    return /^\|?[\s:|-]+\|?$/.test(t) && t.indexOf('-') >= 0;
  }

  /* ---------- 表格单元格切分：`\|` 是**字面竖线**，不是单元格分隔 ----------
   * 现场（`NOTE_RESIDUE` 欠账册里 3 条 / 5 处，**全是这一个形状**；2026-10-20 根治）：
   *     | 命令 | 说明 |
   *     | --- | --- |
   *     | `dmesg \| tail` | 看尾部 |
   * 改前：`split('|')` **不认转义** ⇒ 那个 `\|` 被当成单元格分隔 ⇒ 一格切成两格，
   *   留下**两个孤立反引号**与**一个字面 `\`**；门禁 ⑥ 的 `code-span` 抓的就是那两个反引号
   *   （`comnet::12-mumupmmew2f0` / `comnet::3-4-ebtables-mark-mv6idkjcv0r3` /
   *   `comnet::1-6-21-02-22-03-23-05-mv6idoy0lb9a`）。
   *
   * 修法 = 与 `inline()` 的 `codeSentinel()` **同一套路**：占位 → 切分 → 还原。
   *   ① `\|`   ⇒ 占位符（不参与切分），切完还原成 `|`；
   *   ② `\\|`  ⇒ **字面反斜杠 + 真·单元格分隔**（GFM：`\\` 是一个转义的反斜杠，其后的 `|`
   *      **不再**被转义）。这个边界**必须判** —— 把它也当成"转义竖线"会让 `| x \\| y |` 少切一格；
   *      更一般地按**连续反斜杠个数的奇偶**判：偶数个 ⇒ 全都成对（每个 `\\` 出一个字面 `\`），
   *      `|` 是分隔符；奇数个 ⇒ 最后一对之后剩下的那个 `\` 逃逸掉 `|` ⇒ 它是**字面竖线**；
   *   ③ 其余 `\x`（含**不紧跟 `|` 的** `\\`）**原样保留** —— 本转换器不处理其它反斜杠转义，
   *      改前行为一个字不动（`tests/convert.test.js` 的"不吞掉反斜杠文本"用例钉住这一点）。
   *
   * 占位符怎么选（与 `codeSentinel()` 同一口径，两件事必须同时成立）：
   *   · **不可能与正文冲突**：只有输入里真的找不到这个哨兵时才算数，撞一次就把它撑长一格
   *     （`\u0001CELL\u0002` → `\u0001\u0001CELL\u0002\u0002` → …）⇒ 输入长度有限 ⇒ 循环必终止；
   *   · **零随机、零时钟**：同一份输入必须产出同一份结果（快照 / 门禁读数 / 逐字节 diff 都要可比）。
   * ⚠️ 占位符**在 `splitRow()` 内部一次还原干净**（这些字节要落进 detail）：漏一个就会在界面上
   *   显示成一串 `\u0001CELL\u0002P…`；还原之后才交给 `escapeHtml()` / `inline()`。
   * --------------------------------------------------------------- */

  /** 单元格占位符的哨兵（确定性；撞了就撑长一格 ⇒ 必终止） */
  function cellSentinel(s) {
    let sent = '\u0001CELL\u0002';
    while (s.indexOf(sent) >= 0) sent = '\u0001' + sent + '\u0002';
    return sent;
  }

  /**
   * 切分一个表格行（GFM 口径的 `\|` / `\\|`，见上面那段注释）。
   * 导出侧的逆映射是 `escapeCellText()` —— **两处必须成对**（只改一侧 ⇒ 导出件再导入就多切一格）。
   * @returns {string[]} 已 trim 的单元格；占位符**已还原**，可直接交给 `escapeHtml()` / `inline()`
   */
  function splitRow(t) {
    const row = String(t);
    const sent = cellSentinel(row);
    const PIPE = sent + 'P' + sent;        // ⇒ `|`
    const BSLASH = sent + 'B' + sent;      // ⇒ `\`
    let stashed = '';
    let k = 0;
    while (k < row.length) {
      const ch = row[k];
      if (ch !== '\\') { stashed += ch; k++; continue; }
      let n = 0;
      while (row[k + n] === '\\') n++;             // 连续反斜杠的个数
      if (row[k + n] !== '|') {                    // 不紧跟 `|` ⇒ 原样保留（改前行为）
        stashed += row.slice(k, k + n);
        k += n;
        continue;
      }
      stashed += BSLASH.repeat(Math.floor(n / 2)); // 成对的反斜杠 ⇒ 每对一个字面 `\`
      if (n % 2 === 1) stashed += PIPE;            // 余下一个 ⇒ 它逃逸掉 `|` ⇒ 字面竖线
      else stashed += '|';                         // 偶数个 ⇒ `|` 是**真分隔符**
      k += n + 1;
    }
    return stashed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      .map((c) => c.split(PIPE).join('|').split(BSLASH).join('\\'));
  }

  /**
   * **导出**方向：把一个单元格的纯文本转成 GFM 单元格文本（`splitRow()` 的逆）。
   *
   *  规则只有一条 —— **连续 k 个反斜杠紧跟 `\|` 时，写成 `2k+1` 个反斜杠再跟 `|`**：
   *    · k = 0（正文里就是一个竖线）：`|` ⇒ `\|`                     ← 这就是"单元格里的竖线要转义"
   *    · k = 1（正文里是 `\` + `|`）：⇒ `\\\|`（3 个反斜杠 + `|`）    ← 只转竖线会写坏，见下
   *    · 一般：`'\\'.repeat(2 * k + 1) + '|'`
   *  为什么不能"只把 `|` 换成 `\|`"：`splitRow()` 按**连续反斜杠个数的奇偶**解（GFM 也是这个口径）——
   *  正文 `\` + `|` 若只转竖线会写成本 2 个反斜杠 + `|`，偶数 ⇒ 导入时那个 `|` 被当成**真分隔符**，
   *  于是导出→导入后**多切一格**（正是这次要根除的那类坏字）。写成 3 个 ⇒ 解回来是"1 个 `\` + 1 个字面 `|`"。
   *  反证：不含竖线的单元格**一个字节都不动**（正则要求以 `|` 收尾；`C:\temp` 这类原样出）。
   * ⚠️ 本函数只处理竖线；单元格里的 `<code>` / `<strong>` 等**行内格式在调用点已被 `stripTags()` 压平**
   *  （改动前的既有行为，见文件头「往返约定」的边界）。
   * @param {string} t 已 `stripTags()` 的单元格纯文本
   * @returns {string} 可直接 `join(' | ')` 的单元格文本
   */
  function escapeCellText(t) {
    return String(t).replace(/\\*\|/g, (m) => '\\'.repeat(2 * m.length - 1) + '|');
  }

  /** 分隔行（thematic break）：整行**只有同一种**标记符 `-` / `*` / `_`，三个及以上，可**夹空格**。
   *  入参 `t` 已 `trim()` ⇒ 首尾空白不必处理。
   *  · 三种符号**不许混用**（`-*-` 不是分隔线）⇒ 三个分支各自锚定，不是"含 `[-*_]` 就算"。
   *  · `- -` / `**` 只有两个 ⇒ **不**是分隔线（`- -` 是列表项，`**` 是强调片段）。 */
  const HR_LINE = /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

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
      // 分隔线（`---` / `***` / `___`：三个及以上、可夹空格、**独占一行**）⇒ `<hr>`
      //
      // 改前没有这一支：`---` 不命中围栏/表格/标题/无序列表 ⇒ 落进段落 ⇒ 产出 `<p>---</p>`，
      // 界面上就是**三个字面短横**（与 `**` 显示成星号是同一类坏字）。实测现场：`卖点讨论` 的 `bl-3`。
      // ⚠️ `---` 在 Markdown 里是**标记**（分隔线）不是文字 ⇒ 转成 `<hr>` **不算丢内容**。
      // ⚠️ **必须排在「无序列表」之前**（位置动了就出事故，两个方向都撞）：
      //    · `- - -` 会先命中 `/^[-*]\s+/` ⇒ 被吃成 `<ul><li>- -</li></ul>`（分隔线变列表项）；
      //    · `* * *` 同理（`***` 本身不撞列表，但 `* * *` 撞）；
      //    · `***` 排在列表**之后**也不撞列表，但它在段落之前必须被拦下，否则 `<p>***</p>`。
      // ⚠️ 判据**窄**：整行只许出现同一种标记符（可夹空格）—— `***x***`（强调+粗体）与
      //    `| --- | --- |`（表格分隔行，已被上面的表格分支吃掉）都**不**走这一支。
      // ⚠️ `hr` 在 `src/html-whitelist.js` 的 `ALLOW_TAGS` 里**已经有了**（渲染层消毒不会剥掉它），
      //    所以本支**不需要**动白名单 —— 见 `tests/convert.test.js` 的 `hr 在白名单里` 断言。
      if (HR_LINE.test(t)) {
        out.push('<hr>');
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
