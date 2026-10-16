/* ============================================================
 * src/html-whitelist.js — 「正文 HTML 子集」的**唯一一份白名单表**（UMD 纯数据 + 纯判定，零 DOM、零 IO）
 * ------------------------------------------------------------
 * ## 为什么它住在 `src/`（而不是渲染层）
 * 这张表有三个消费者，分属三层：
 *   ① **消毒模块** `renderer/sanitize.js`（渲染层：先解析成 DOM 再按表遍历删）；
 *   ② **语料读数** `scripts/detail-census.js`（脚本层："这段 detail 有没有 HTML 结构"的量具）；
 *   ③ **Markdown→HTML** `src/convert.js` 的行内链接/图片（**URL 那一档**：`[x](javascript:…)`
 *      一度会产出**活的** `href`，见 §⑫-6.4）。
 * ⇒ 表**只能有一份**：放 `src/` 是唯一能让三层都 `require` 到、又不破单向依赖（S1）的位置
 *   （`renderer` → `src` 合法；`scripts` → `src` 合法；反向不合法）。
 *   `scripts/detail-census.js` 的文件头原本就写着"R7 消毒模块落地后这份正则要改成从模块里取"——
 *   本文件就是那个模块，`TAG_RE` 由它导出，那份自写的正则已删除 ✓。
 *
 * ## 与设计稿的关系（**以订正批 §⑫ 为准**）
 *   · 白名单档位 = 用户拍板的 **A 档**（§⑫-5.2）：允许 `details/summary`、`table`、`img`、`a`；
 *     **禁** `style` / `on*` / `script` / `iframe` / `svg`。
 *   · `img` 的 URL scheme = **用户 2026-10-16 裁决：允许 `https:`**（`file:` / `data:` / 工程内相对路径照旧）。
 *     ⚠️ 这条**推翻了设计稿 §⑫-5.2(b)** 当初"收敛到 file:/data:"的处置，理由是那条处置据以成立的
 *     "离线优先 / 内容不出本机"**从来不是本工程的规矩**（`docs/` 零命中；`src/**` 里零 http 请求；
 *     真正的联网面在 `main.js` / DSH 问答那条链上，本应用本来就是联网的）。
 *     ⇒ **本表只做「安全」收敛，不做「联网」收敛**：拒的是**可执行档**（`javascript:` / `vbscript:` /
 *     链接上的 `data:`）与**明文 `http:` 图片**（现代引擎里多被当混合内容拦下，等于坏图 ⇒ 不如显式说清楚）；
 *     不拒"会不会发外部请求"。相应地 `renderer/index.html:5` 的 `img-src` 已由用户裁决加 `https:`
 *     （**只放宽这一档**：`script-src` / `style-src` / `default-src` / `frame-src` 一律不动）。
 *
 * ## ⚠️ 两个 CSP 真空档（§⑫-2.4）—— 本表**必须自己管**，不能只靠"标签名不在白名单里"
 *   | 真空档 | 为什么 CSP 拦不住 | 本表的落法 |
 *   |---|---|---|
 *   | `style-src 'self' 'unsafe-inline'` | `'unsafe-inline'` **放行** `<style>` 与 `style=` | `STYLE_LIKE` 显式列（`style` 标签、`style` 属性、`link[rel=stylesheet]`）|
 *   | 未声明 `frame-src` ⇒ 回落 `default-src … data:` | `data:` **放行** | `FRAME_LIKE` 显式列（`iframe`/`frame`/`frameset`/`object`/`embed`/`portal`），且 `data:` 在**任何** URL 位置上仍被 URL 判据拦下 |
 *   另有两处 CSP 管不到的：`<meta http-equiv=refresh>`（导航）与 `<base href>`（劫持相对地址）
 *   ⇒ `META_LIKE` 显式列。四类都**有名有姓地出现在表里**，不是"反正不在白名单里"的副作用。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMHtmlWhitelist = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 允许保留的标签（= 设计稿 §② 判定表的"允许"档；用户拍板 A 档 §⑫-5.2）。 */
  const ALLOW_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'kbd', 'mark', 'small',
    'code', 'pre', 'blockquote', 'details', 'summary', 'a', 'img', 'div', 'span'
  ];

  /** **整棵子树删掉**的标签：可执行 / 可外联 / 可劫持文档 / 可提交数据 / 已知脚本宿主。 */
  const DROP_SUBTREE_TAGS = [
    // ⚠️ 真空档 ①（`style-src 'unsafe-inline'`）
    'style',
    // ⚠️ 真空档 ②（未声明 `frame-src` ⇒ 回落 `default-src … data:`）
    'iframe', 'frame', 'frameset', 'object', 'embed', 'portal',
    // ⚠️ CSP 管不到的导航/基址档
    'meta', 'base', 'link', 'title',
    'script', 'noscript', 'template',
    'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'fieldset', 'legend', 'output',
    'svg', 'math', 'applet', 'audio', 'video', 'source', 'track', 'canvas', 'marquee'
  ];

  /** 属性白名单：`'*'` = 所有允许标签通用；其余按标签给。**表外属性一律删**（含 `on*`、`style`）。 */
  const ATTR_ALLOW = {
    '*': ['class', 'id', 'title', 'lang', 'dir', 'align'],
    a: ['href', 'target', 'rel', 'name', 'hreflang'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
    td: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
    th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
    ol: ['start', 'type', 'reversed'],
    li: ['value'],
    details: ['open', 'name'],
    code: ['data-lang'],
    pre: []
  };

  /** `data-*` 只放行**本工程已知的键**（条目层靠它归属，任意键则可能被别处脚本当输入）。 */
  const DATA_ATTR_ALLOW = ['data-item-id', 'data-item-no', 'data-lang'];

  /** 站内链接的自定义 scheme（正文里的 `aimm://项目/节点id[#条目id]`）。落盘仍是 `links[]`，不是第二套存储。 */
  const AIM_SCHEME = 'aimm';

  /** URL scheme 白名单（**按位置分**）：`a` 放行外链三档 + 站内 scheme；`img` 放行 `https:` / `file:` / `data:`
   *  ⚠️ **不放行明文 `http:` 图片**（用户裁决只放宽 `https:`）：现代引擎里 http 图多被当混合内容拦下，
   *  等于一张静默坏图 ⇒ 拦下它并"可见占位 + 说明改 https"比默认坏图清楚。这一档**不是**联网收敛。
   *  ⚠️ `SCHEME_ALLOW_CONVERT` 是**转换期**（`markdownToHtml`）那一档，**故意比渲染期宽**：
   *  转换期的产物是**要落盘的 `detail`** —— 在那里把远程图换成 alt 文本 = **静默改用户的导入数据**
   *  （本工程最重的损害类）。所以转换期只拦**危险 scheme**（`javascript:`/`vbscript:`/`blob:`…），
   *  `http(s)` 照旧落盘；"这图在界面上怎么显示"是**渲染期**的策略。
   *  判据表仍是**这一份**（两档只在"放行名单"上差两项，不是第二套判定）。 */
  const SCHEME_ALLOW = {
    a: ['http', 'https', 'mailto', AIM_SCHEME],
    img: ['file', 'data', 'https']
  };
  const SCHEME_ALLOW_CONVERT = {
    a: ['http', 'https', 'mailto', AIM_SCHEME],
    img: ['file', 'data', 'http', 'https']
  };

  /** `code` 上标出 mermaid 图源的类名（`markdownToHtml` 与手写 HTML 都可能用；探测只认这几种写法） */
  const MERMAID_LANG = ['mermaid'];

  const ALLOW_SET = ALLOW_TAGS.reduce((m, t) => (m[t] = true, m), {});
  const DROP_SET = DROP_SUBTREE_TAGS.reduce((m, t) => (m[t] = true, m), {});
  const DATA_SET = DATA_ATTR_ALLOW.reduce((m, a) => (m[a] = true, m), {});

  /** 含白名单标签的正则（**语料读数用**：`scripts/detail-census.js` 的 `TAG_RE` 就是它，不再自写一份） */
  const TAG_RE = new RegExp('</?(?:' + ALLOW_TAGS.join('|') + ')\\b', 'i');

  /* ---------------- 拒绝文案（**唯一一处**；调用方只显示，不许自己拼） ---------------- */
  const REASONS = {
    'html-drop-tag': '标签被白名单拦下并整棵子树删除',
    'html-unwrap-tag': '标签不在白名单里：只保留它的文字，元素本身删掉',
    'html-drop-attr': '属性不在白名单里（含 style / on* 一律删）',
    'html-style': '样式被禁（style 标签与 style 属性都可能盖到详情框之外做遮挡钓鱼）',
    'html-frame': '内嵌框架被禁（frame-src 未声明时会经回落链放行 data:，等于一个自带脚本上下文的子文档）',
    'html-meta': '文档级 meta/base 被禁（meta refresh 能导航，base 能劫持相对地址）',
    'html-svg': 'svg 被禁（已知的 on* 与脚本宿主）',
    'url-blocked-scheme': '这个协议不在放行名单里',
    'url-http-img': '明文 http 图片被拦下（图片只放行 https: / file: / data: 与工程内相对路径；改成 https 即可显示）',
    'url-empty': '空地址',
    'url-control-char': '地址含控制字符',
    'url-protocol-relative': '协议相对地址（//host/…）指向外域，被拦下'
  };

  function reasonText(code) { return REASONS[code] || code; }

  function isAllowedTag(tag) { return !!ALLOW_SET[String(tag || '').toLowerCase()]; }
  function isDropTag(tag) { return !!DROP_SET[String(tag || '').toLowerCase()]; }
  /** 事件属性：**按前缀判**（不靠枚举 —— 枚举一定会漏掉新的 `on*`） */
  function isEventAttr(name) { return /^on/i.test(String(name || '')); }

  /** 属性是否放行。`null`/`'*'` 之外一律按"通用 + 该标签"两张表判。 */
  function attrAllowed(tag, name) {
    const t = String(tag || '').toLowerCase();
    const n = String(name || '').toLowerCase();
    if (!n || isEventAttr(n)) return false;                 // ⚠️ 这条就是"脚本执行本身"
    if (n === 'style') return false;                        // ⚠️ 真空档 ①
    if (DATA_SET[n]) return true;
    if ((ATTR_ALLOW['*'] || []).indexOf(n) >= 0) return true;
    return (ATTR_ALLOW[t] || []).indexOf(n) >= 0;
  }

  /* ---------------- URL 判据（**唯一一处**；`renderer/sanitize.js` 与 `src/convert.js` 都调它） ---------------- */

  function hasControlChar(raw) { return /[\u0000-\u001f\u007f]/.test(String(raw)); }

  /** 相对路径（工程内）：不以 scheme / 盘符 / 斜杠 / `//` 开头 */
  function isRelativeUrl(raw) {
    const s = String(raw).trim();
    if (!s) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;   // 有 scheme
    if (/^[\\/]/.test(s)) return false;                      // 前导斜杠（含 `//host`）
    if (/^[A-Za-z]:/.test(s)) return false;                  // 盘符
    return true;
  }

  /** 本机绝对路径（`E:\…` / `E:/…`）——正文里写绝对路径是**允许**的（走同一条"系统打开"出口）。 */
  function isDrivePath(raw) { return /^[A-Za-z]:[\\/]/.test(String(raw).trim()); }

  function schemeOf(raw) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(raw).trim());
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * 正文里一个 URL（`a[href]` / `img[src]`）的**归属判定**。
   *
   * @param {string} raw 原始地址（不 trim、不改写）
   * @param {string} where `'a'` 或 `'img'`（**按位置分档**：img 在渲染期不放行外链）
   * @param {string} [mode] `'render'`（缺省，消毒期）| `'convert'`（`markdownToHtml` 的转换期，见上）
   * @returns {{kind:string, scheme:string, ok:boolean, code:string, reason:string}}
   *   `kind` ∈ `relative`（工程内相对）· `drivepath`（本机绝对）· `fragment`（页内 `#x`）
   *          · `scheme`（放行的 scheme）· `blocked`（拦下）
   */
  function classifyUrl(raw, where, mode) {
    const w = (where === 'img') ? 'img' : 'a';
    const allowList = (mode === 'convert' ? SCHEME_ALLOW_CONVERT : SCHEME_ALLOW)[w] || [];
    const s = (raw === undefined || raw === null) ? '' : String(raw);
    const bad = (kind, code) => ({ kind: kind, scheme: '', ok: false, code: code, reason: reasonText(code) });
    if (!s.trim()) return bad('blocked', 'url-empty');
    if (hasControlChar(s)) return bad('blocked', 'url-control-char');
    if (/^[\\/]{2}/.test(s.trim())) return bad('blocked', s.trim().charAt(0) === '/' ? 'url-protocol-relative' : 'html-frame');
    if (s.trim().charAt(0) === '#') return { kind: 'fragment', scheme: '', ok: true, code: '', reason: '' };
    if (isDrivePath(s)) return { kind: 'drivepath', scheme: '', ok: true, code: '', reason: '' };
    if (isRelativeUrl(s)) return { kind: 'relative', scheme: '', ok: true, code: '', reason: '' };
    const sc = schemeOf(s);
    const allowed = allowList.indexOf(sc) >= 0;
    if (!allowed) {
      // ⚠️ `data:` 在 `img` 上是**放行**的（本工程图片区既有形态），但在 `a` 上与
      //     `javascript:`/`vbscript:`/`blob:` 同档拦下 —— 点一下就跑的东西不进正文链接。
      // ⚠️ `img` 的 `https:` **放行**（用户裁决）；只拦明文 `http:` 图。
      return bad('blocked', (w === 'img' && sc === 'http') ? 'url-http-img' : 'url-blocked-scheme');
    }
    return { kind: 'scheme', scheme: sc, ok: true, code: '', reason: '' };
  }

  /** 站内链接 `aimm://<项目>/<节点id>[#<条目id>]` 的解析（**唯一一处**；渲染层的点击分支调它）。 */
  function parseAimUrl(raw) {
    const s = String(raw || '').trim();
    const m = new RegExp('^' + AIM_SCHEME + '://([^/#?]+)/([^#?]+)(?:#([^#?]+))?$').exec(s);
    if (!m) return { ok: false, code: 'aimm-bad-shape', reason: '站内链接形状不对（应为 aimm://项目/节点id[#条目id]）' };
    const project = decodeURIComponent(m[1]);
    const id = decodeURIComponent(m[2]);
    const item = m[3] ? decodeURIComponent(m[3]) : '';
    if (!project || !id) return { ok: false, code: 'aimm-bad-shape', reason: '站内链接缺少项目名或节点 id' };
    return { ok: true, project: project, id: id, item: item };
  }

  /** 一个类名串里有没有标注 mermaid 语言 */
  function isMermaidLang(className) {
    const s = String(className || '');
    return MERMAID_LANG.some((l) => new RegExp('(^|\\s)(?:language-|lang-)' + l + '($|\\s)', 'i').test(s));
  }

  return {
    // 表（唯一一份）
    ALLOW_TAGS, DROP_SUBTREE_TAGS, ATTR_ALLOW, DATA_ATTR_ALLOW, SCHEME_ALLOW, AIM_SCHEME,
    MERMAID_LANG, TAG_RE,
    // 判定
    isAllowedTag, isDropTag, isEventAttr, attrAllowed,
    classifyUrl, parseAimUrl, isMermaidLang, schemeOf, isRelativeUrl, isDrivePath, hasControlChar,
    // 文案
    REASONS, reasonText
  };
});
