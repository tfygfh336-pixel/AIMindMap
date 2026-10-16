/* ============================================================
 * renderer/sanitize.js — 正文 HTML 的**消毒实现**（唯一一处；表在 `src/html-whitelist.js`）
 * ------------------------------------------------------------
 * ## 它守的是什么（威胁模型，照 §⑫-2.2 改写过的口径）
 * 页面主世界**没有** `require` / `process`（`nodeIntegration:false` + `contextIsolation:true`），
 * 所以这不是"Node RCE"。真正要守的是 **`window.desktop` 这条 IPC 桥的授权面**：
 * 渲染层里任何能跑起来的代码都能写项目数据（`project.save`）、读任意绝对路径（`app.readFile`）、
 * 起外部程序（`app.openFile`）⇒ **正文一旦能变成活动代码，等于把整条授权面交出去**。
 * 而正文可以来自**别人仓库导入的 `.md`**（`import-md`）或外部库直进 ⇒ 不是"用户自己敲的"。
 *
 * ## 手法（纪律：**先解析成 DOM、再遍历删**，绝不正则处理 HTML）
 * 解析用 **`DOMParser`**（不是 `div.innerHTML`）：`DOMParser` 产出的文档**没有浏览上下文**
 * ⇒ 里面的 `<img src=https://…>` **不会发请求**、`<iframe src=data:…>` **不会加载**。
 * 若改用 detached `div.innerHTML`，远程图片会在消毒**之前**就把请求发出去（那正是本模块要防的泄漏）。
 *
 * ## CSP 的两个真空档（§⑫-2.4）：本模块**显式**拒，不靠"标签名不在白名单里"
 *   ① `style-src 'unsafe-inline'` 放行 `<style>` 与 `style=` ⇒ 表里 `style` 在 `DROP_SUBTREE_TAGS`、
 *      `style` 属性在 `attrAllowed` 里**点名**拒绝（两处都有名字，不是副作用）；
 *   ② 未声明 `frame-src` ⇒ 按回落链 `frame-src → child-src → default-src` 吃 `default-src … data:`
 *      ⇒ `iframe` 等**框架类**同样是**点名**列在 `DROP_SUBTREE_TAGS` 里（`FRAME_LIKE` 一族）。
 *   另有 CSP **管不到**的两处：`<meta http-equiv=refresh>`（导航）与 `<base href>`（劫持相对地址）
 *   ⇒ `meta` / `base` 也在表里，且**文档级元素**（被解析器搬进 `head` 的那些）整体不进注入
 *   （见下面的 `headDropped`：只要输入里出现文档级标签，就计 `changed` 并丢弃）。
 *
 * ## ⚠️ 本模块**管不到**的一条路（如实登记，见 §⑫-2.5）
 * mermaid **一定会往文档里插 `<style>`**，而 `style-src 'unsafe-inline'` 放行它。
 * 时序上**消毒在前、mermaid 渲染在后**（`renderer/app-md.js` 在消毒之后才懒加载并渲染）
 * ⇒ 本节的白名单**管不到 mermaid 自己产出的 DOM**。这是已知边界，不是漏做：
 * 兜底靠 ①`securityLevel:'strict'`（图源里的 HTML 标签与点击回调被它禁掉）
 * ②mermaid 产物只落在它自己的容器里（`data-mm-mermaid`）。
 * ============================================================ */
(function (root) {
  'use strict';

  const MM = root.MM = root.MM || {};
  const W = () => root.MMHtmlWhitelist;
  const S = () => root.MMSanitizeState;

  /** 一次性读数（最近一次消毒的账；冒烟断言与排查读它，**不是**判据本身）。
   *  ⚠️ 两套命名空间**必须分开**（计数器 vs `*ByTag` 明细），这是本批实测踩过的一个真 bug：
   *  早期版本让 `note()` 直接写 `st.attrsRemoved` —— 而它同时是**数字计数器** ⇒
   *  第一次 `note` 就把数字换成了对象，随后 `st.attrsRemoved += report.attrs` 做的是
   *  `String({}) + 0 = '[object Object]0'`，再几轮变成 `'[object Object]2000…'`，
   *  最后 `note` 往这个**字符串**上写属性 ⇒ `TypeError: Cannot create property 'border' on string …`
   *  （在真实语料第 1327 条上才炸出来；是冒烟域 52 的"全量语料"那条判据抓到的）。 */
  root.MMSanitizeState = root.MMSanitizeState || {
    runs: 0, changed: 0, unwrapped: 0, attrsRemoved: 0, urlsBlocked: 0, remoteImgs: 0, headDropped: 0,
    droppedByTag: {}, unwrappedByTag: {}, attrsRemovedByTag: {}, urlsBlockedByTag: {}
  };

  /** 往**明细桶**里记一笔（桶名一律以 `ByTag` 结尾，与计数器分开 ✓） */
  function note(tag, bucket) {
    const st = S();
    if (!st[bucket]) st[bucket] = {};
    const key = String(tag);
    st[bucket][key] = (st[bucket][key] || 0) + 1;
  }

  function removeEl(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  /** 拆壳：保留子节点，元素本身删掉（文字不丢 —— 用户的内容比"结构合法性"重要） */
  function unwrapEl(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  /** 被拦下的远程图片 ⇒ **可见占位**（不许静默留白：用户得知道"这里原本有张图"） */
  function blockedImgPlaceholder(doc, src, reason) {
    const span = doc.createElement('span');
    span.className = 'fd-img-blocked';
    span.setAttribute('data-blocked-src', String(src).slice(0, 300));
    span.setAttribute('title', reason + '：' + String(src).slice(0, 300));
    span.textContent = '🖼 ' + reason;
    return span;
  }

  /**
   * 消毒一段正文 HTML。
   * @param {string} html 原始 `detail` / `assoc.note` 字节
   * @param {{project?:{file?:string,name?:string}}} opts 相对路径的基准（`state.project`）
   * @returns {{html:string, changed:boolean, report:object}}
   *   ⚠️ `changed === false` ⇒ 调用方**必须原样注入 `html` 入参**（默认档逐字节不变的保证：
   *   我们的遍历一个字节都没动，重序列化只会带来无意义的差异）。
   */
  function sanitize(html, opts) {
    const w = W();
    const o = opts || {};
    const raw = (html === undefined || html === null) ? '' : String(html);
    const report = { dropped: [], unwrapped: [], attrs: 0, urls: [], imgs: 0, head: false, docAttrs: false };
    if (!raw) return { html: raw, changed: false, report: report };

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    /* 文档级元素（`meta` / `base` / `style` / `link` / `title` …）被解析器搬进了 `head`
     * ⇒ 它们**本来就不在** `body` 里，注入时自然消失。但"消失"必须计 `changed`，
     * 否则调用方会走"原样注入"那条路、把它们又带回来 ✗（`<meta refresh>` 就是这么活下来的）。 */
    const headEls = doc.head ? Array.prototype.slice.call(doc.head.children) : [];
    report.head = headEls.length > 0;
    if (report.head) headEls.forEach((el) => note(String(el.tagName || '').toLowerCase(), 'droppedByTag'));
    /* `<body onload=…>` 这类**文档级属性**同样不进注入 —— 也要计 `changed`。 */
    report.docAttrs = !!(doc.body && doc.body.attributes && doc.body.attributes.length);
    if (report.docAttrs) {
      Array.prototype.slice.call(doc.body.attributes).forEach((a) => {
        note('body@' + String(a.name), 'droppedByTag');
        report.dropped.push('body@' + String(a.name));
      });
    }

    let mutated = false;
    const project = o.project || null;

    function judgeUrl(el, tag, name, value) {
      const c = w.classifyUrl(value, tag === 'img' ? 'img' : 'a');
      if (c.ok) {
        if (tag === 'img' && c.kind === 'relative') {
          // 相对路径 ⇒ 换成**页面相对地址**（唯一算式的拥有者仍是 `src/path-chain.js` 的 `rendererUrlOf`）。
          const d = (root.MMPathChain ? root.MMPathChain.decide({ kind: 'image', raw: value, project: project }) : null);
          if (d && !d.ok) {
            el.setAttribute('data-blocked-src', String(value).slice(0, 300));
            el.setAttribute('title', d.reason);
            el.setAttribute('src', 'about:blank');
            report.urls.push({ tag: tag, code: d.code, reason: d.reason, raw: String(value) });
            return;
          }
          const url = (root.MMPathChain && project) ? root.MMPathChain.rendererUrlOf(project, value) : value;
          if (el.getAttribute(name) !== url) { el.setAttribute(name, url); mutated = true; }
          return;
        }
        return;
      }
      report.urls.push({ tag: tag, code: c.code, reason: c.reason, raw: String(value) });
      if (tag === 'img') {
        report.imgs += 1;
        if (c.code === 'url-http-img' || c.code === 'url-blocked-scheme') note('img-blocked', 'urlsBlocked');
        el.parentNode.replaceChild(blockedImgPlaceholder(doc, value, c.reason), el);
        return;
      }
      // `a`：**去掉 href**（点了也不会导航）+ 可见标记 + `title` 给原因。文字保留 ✓
      el.removeAttribute('href');
      el.classList.add('fd-link-blocked');
      el.setAttribute('title', c.reason + '：' + String(value).slice(0, 300));
      mutated = true;
    }

    function walk(node) {
      const kids = Array.prototype.slice.call(node.childNodes);
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === 3) continue;                       // 文本：内容本身不是问题
        if (child.nodeType !== 1) {                               // 注释 / PI / CDATA：删
          removeEl(child); mutated = true; note('#' + child.nodeType, 'droppedByTag'); continue;
        }
        const tag = String(child.tagName || '').toLowerCase();
        if (w.isDropTag(tag)) {
          removeEl(child); mutated = true; note(tag, 'droppedByTag'); report.dropped.push(tag); continue;
        }
        if (!w.isAllowedTag(tag)) {
          // 表外的普通标签（如 `<video>`）⇒ 拆壳保留文字（删整棵会把用户内容吃掉）
          unwrapEl(child); mutated = true;
          note(tag, 'unwrappedByTag'); report.unwrapped.push(tag); continue;
        }
        // 属性：白名单之外一律删（`on*` 按前缀、`style` 点名 —— 两条都在 attrAllowed 里）
        Array.prototype.slice.call(child.attributes).forEach((a) => {
          if (!w.attrAllowed(tag, a.name)) {
            child.removeAttribute(a.name); mutated = true; report.attrs += 1; note(String(a.name), 'attrsRemovedByTag');
          }
        });
        // 本工程不用新窗口：`target` 一律摘掉（点了由我们自己的出口处理，见 app-md.js）
        if (tag === 'a' && child.hasAttribute('target')) { child.removeAttribute('target'); mutated = true; }
        if (tag === 'a' && child.hasAttribute('rel')) { child.removeAttribute('rel'); mutated = true; }
        if (tag === 'a' && child.hasAttribute('href')) judgeUrl(child, 'a', 'href', child.getAttribute('href'));
        if (tag === 'img') {
          if (child.hasAttribute('src')) judgeUrl(child, 'img', 'src', child.getAttribute('src'));
          else { child.parentNode.replaceChild(blockedImgPlaceholder(doc, '(无 src)', '图片地址为空'), child); mutated = true; }
        }
        // 上一行可能已经把 img 换掉了 ⇒ 换掉后不要再往里走
        if (child.parentNode === node) walk(child);
      }
    }

    walk(doc.body);
    const changed = mutated || report.head || report.docAttrs;
    const st = S();
    st.runs += 1;
    if (changed) st.changed += 1;
    st.unwrapped += report.unwrapped.length;
    st.attrsRemoved += report.attrs;
    st.urlsBlocked += report.urls.length;
    st.remoteImgs += report.imgs;
    if (report.head) st.headDropped += 1;
    return { html: doc.body.innerHTML, changed: changed, report: report };
  }

  /**
   * 把消毒后的正文注入容器（**正文唯一渲染点**的入口）。
   * `changed === false` ⇒ 注入**原始字节**（默认档逐字节不变）。
   * @returns {{changed:boolean, injected:string, report:object}}
   */
  function inject(dc, html, opts) {
    const r = sanitize(html, opts);
    dc.innerHTML = r.changed ? r.html : ((html === undefined || html === null) ? '' : String(html));
    return { changed: r.changed, injected: dc.innerHTML, report: r.report };
  }

  MM.Sanitize = {
    sanitize: sanitize,
    inject: inject,
    /** 表与判定（只读出口：判据不复制产品事实，需要就到这里取） */
    rules: function () { return W(); },
    state: function () { return Object.assign({}, S()); },
    resetState: function () {
      root.MMSanitizeState = { runs: 0, changed: 0, unwrapped: 0, attrsRemoved: 0, urlsBlocked: 0,
        remoteImgs: 0, headDropped: 0, droppedByTag: {}, unwrappedByTag: {}, attrsRemovedByTag: {}, urlsBlockedByTag: {} };
      return true;
    }
  };
})(typeof window !== 'undefined' ? window : this);
