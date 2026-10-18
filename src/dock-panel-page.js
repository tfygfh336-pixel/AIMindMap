/* ============================================================
 * src/dock-panel-page.js — 第 4 原生面板（停靠面板）**页面本体**的唯一实现
 * ------------------------------------------------------------
 * ## 为什么这张页面单独成模块（`main-dsh-sidebar.js` 只留一行 `dataUrl()`）
 * 页面里那段 JS **只有在真起一个 WebContentsView 之后才会被解析** —— 写完如果不跑冒烟，
 * 一句语法错的表现是"面板一片空白"，而不是任何一条判据变红。把它搬到这里之后：
 *   · node 单测可以直接 `scriptOf()` 取出页面脚本、`new Function()` 解析一遍 ⇒ **语法错当场红**；
 *   · 页面的"必须有的锚点"（行标记 / 接收函数 / 请求标记）可以逐条断言，不靠人眼；
 *   · `main-dsh-sidebar.js` 那个文件里**一行业务文本都没有**（面板底座与业务彻底分开）。
 *
 * ## 它做什么 / 不做什么
 * 做：画清单、**把口径逐字说出来**（相对 HEAD 的累计改动，不是「本回合」）、画不出来时说清为什么。
 * 不做：不做任何算术 —— 清单的行数、合计、去重全在 `src/change-log.js`；
 *       页面**拿不到 fs / IPC**（沙箱 + 无 preload）⇒ 它连"自己去读那个 jsonl"都做不到 ✓。
 *
 * ## 四种结局必须分开说（本工程最重的损害类别：把「采不到」说成「没有改动」）
 *   `ok` → 有行 ⇒ 列出来；`empty` → 真的读到了、确实没改动；
 *   `no-git` / `no-repo` / `error` → **响亮报错 + 原因**，绝不给一张空清单。
 *
 * ## 安全面
 * 一律 `createElement` + `textContent`（页内**没有一次** innerHTML）⇒ 文件名里的 `<`、`&`、
 * `</script>` 都不可能是结构。外层 `data:` URL 的 `encodeURIComponent` 只管壳。
 * 通信只有既有那条通道：页面 `console.log('[mm-changelog:req]')`，主进程 `executeJavaScript` 推回来。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDockPanelPage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 页面与主进程之间的**消息标记**（唯一一处；主进程按它们分派，页面按它们发） */
  const MARKERS = {
    req: '[mm-changelog:req]',
    reqForce: '[mm-changelog:req:force]',
    rendered: '[mm-changelog:rendered]',
    close: '[dock-close]'
  };

  /** 每行一条（数组拼行比一整条长 concat 好读，也让"哪一行坏了"一眼看得出） */
  const LINES = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;height:100%;background:#fff;color:#1f2329;',
    'font:12.5px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden;display:flex;flex-direction:column}',
    '#hd{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:8px 10px;',
    'border-bottom:1px solid #e4e7ec;background:#f7f8fa}',
    '#tt{flex:1 1 auto;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#hd button{flex:0 0 auto;width:24px;height:22px;border:none;border-radius:6px;background:transparent;',
    'cursor:pointer;font-size:13px;line-height:1;color:#4e5969}',
    '#rf:hover{background:#e8f3ff;color:#1668dc}',
    '#x:hover{background:#fdecec;color:#d93026}',
    '#meta{flex:0 0 auto;padding:6px 10px;border-bottom:1px solid #f0f1f3;color:#86909c;font-size:11.5px;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#list{flex:1 1 auto;overflow:auto;padding:2px 0}',
    '.row{display:flex;align-items:baseline;gap:6px;padding:3px 10px}',
    '.row:hover{background:#f7f8fa}',
    '.p{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;unicode-bidi:plaintext}',
    '.n{flex:0 0 auto;font-variant-numeric:tabular-nums;font-size:11.5px;color:#86909c}',
    '.a{color:#2c8c4a}',
    '.d{color:#d93026}',
    '.s{flex:0 0 auto;font-size:11px;color:#86909c;min-width:3.2em;text-align:right}',
    '#st{padding:14px 12px;color:#4e5969}',
    '#st b{color:#1f2329}',
    '#ft{flex:0 0 auto;padding:6px 10px;border-top:1px solid #e4e7ec;background:#fafbfc;',
    'color:#86909c;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.warn{color:#d93026}',
    '</style></head><body>',
    '<div id="hd"><span id="tt">AI 改了哪些文件</span>',
    '<button id="rf" title="重新采样（绕过复用窗口）">⟳</button>',
    '<button id="x" title="关闭停靠面板">✕</button></div>',
    '<div id="meta">读取中…</div>',
    '<div id="list"><div id="st">正在读取…</div></div>',
    '<div id="ft"></div>',
    '<script>(function () {',
    // ——— 下面这段是**页面自己的 JS**：字符串一律用双引号，"人话里的引号"用「」——
    //     为什么：这段 JS 本身住在上面这些单引号字符串里，页面里再出现 ASCII 双引号就会把
    //     主进程那份源码的字符串**提前截断**（本批第一版就是这么写坏的，被单测当场抓住）。
    '  var S = { payload: null, rendered: 0 };',
    '  window.__mmChangeLog = { state: S, receive: render };',
    '  function el(tag, cls, txt) {',
    '    var d = document.createElement(tag);',
    '    if (cls) d.className = cls;',
    '    if (txt !== undefined && txt !== null) d.textContent = String(txt);',
    '    return d;',
    '  }',
    '  function num(v) { return (v === null || v === undefined) ? "?" : String(v); }',
    '  function setMeta(t) { document.getElementById("meta").textContent = t; }',
    '  function setFoot(t, warn) {',
    '    var f = document.getElementById("ft");',
    '    f.textContent = t || "";',
    '    f.className = warn ? "warn" : "";',
    '  }',
    '  function notice(title, detail, warn) {',
    '    var box = document.getElementById("list");',
    '    box.textContent = "";',
    '    var d = el("div", null, "");',
    '    d.id = "st";',
    '    d.appendChild(el("b", warn ? "warn" : null, title));',
    '    if (detail) {',
    '      d.appendChild(document.createElement("br"));',
    '      d.appendChild(el("span", null, detail));',
    '    }',
    '    box.appendChild(d);',
    '  }',
    '  function echo(n) { try { console.log("[mm-changelog:rendered] " + n); } catch (e) {} }',
    '  function render(p) {',
    '    S.payload = p || null;',
    '    S.rendered = 0;',
    '    if (!p) {',
    '      setMeta("没有收到读数");',
    '      notice("没有收到读数", "主进程没有推数据过来", true);',
    '      setFoot("");',
    '      echo(0);',
    '      return;',
    '    }',
    '    var head = p.headShort ? ("HEAD " + p.headShort) : "HEAD 未知";',
    '    var at = p.atText || "未采样";',
    '    var cached = p.cached ? ("（复用 " + p.cachedAgeMs + "ms 前的读数）") : "";',
    '    if (p.state !== "ok" && p.state !== "empty") {',
    '      setMeta(at + "  ·  数据源不可用");',
    '      notice("取不到改动清单（这不是「没有改动」）", p.reason || p.state, true);',
    '      setFoot("数据源：" + (p.source || "未知") + " —— 采不到就是采不到，不许显示成空清单", true);',
    '      echo(0);',
    '      return;',
    '    }',
    '    setMeta(at + "  " + cached + "  ·  " + head + "  ·  " + (p.root || "—"));',
    '    var box = document.getElementById("list");',
    '    box.textContent = "";',
    '    var rows = (p.rows || []);',
    '    if (!rows.length) {',
    '      notice("确实没有改动", "工作树相对 " + head + " 是干净的（这是真的读到了，不是读失败）", false);',
    '    } else {',
    '      for (var i = 0; i < rows.length; i++) {',
    '        var r = rows[i];',
    '        var row = el("div", "row");',
    '        row.setAttribute("data-mm-cl-row", r.path);',
    '        var nm = el("span", "p", r.path);',
    '        nm.title = r.path + " | " + (r.statusText || r.status) + " | " + (r.srcText || "");',
    '        row.appendChild(nm);',
    '        row.appendChild(el("span", "s", r.statusText || r.status));',
    '        var n = el("span", "n");',
    '        n.appendChild(el("span", "a", "+" + num(r.add)));',
    '        n.appendChild(document.createTextNode(" "));',
    '        n.appendChild(el("span", "d", "−" + num(r.del)));',
    '        if (r.binary) n.title = "二进制：行数拿不到（不是 0 行）";',
    '        row.appendChild(n);',
    '        box.appendChild(row);',
    '        S.rendered++;',
    '      }',
    '    }',
    '    var t = p.totals || {};',
    '    var tail = (p.unitText || "") + "  ·  合计 " + (t.files || 0) + " 个文件 +" + (t.added || 0)',
    '      + " −" + (t.deleted || 0)',
    '      + (t.binary ? ("（含 " + t.binary + " 个二进制，行数不计）") : "")',
    '      + "  ·  追溯：" + (((p.trace || {}).argv) || "—");',
    '    setFoot(tail, false);',
    '    echo(S.rendered);',
    '  }',
    '  function req(force) { try { console.log(force ? "[mm-changelog:req:force]" : "[mm-changelog:req]"); } catch (e) {} }',
    '  document.getElementById("rf").addEventListener("click", function () { req(true); });',
    '  document.getElementById("x").addEventListener("click", function () {',
    '    try { console.log("[dock-close]"); } catch (e) {}',
    '  });',
    '  /* 面板关掉时视图 bounds 变 0、重新打开又是一个非零 resize ⇒ 在这里补一次请求：',
    '     页面的 JS 状态在关闭期间是活的、会过时，重开必须看到新采的读数。 */',
    '  window.addEventListener("resize", function () { if (window.innerWidth > 0) req(false); });',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", function () { req(false); });',
    '  } else { req(false); }',
    '})();</script></body></html>'
  ];

  function pageHtml() { return LINES.join('\n'); }

  /** 面板页的 `data:` URL（**唯一一处**拼这个前缀；`main-dsh-sidebar.js` 只调它） */
  function dataUrl() {
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml());
  }

  /**
   * 取出页面里那段 `<script>` 的**脚本体**（给单测用：`new Function(body)` 能当场判语法）。
   * 找不到脚本 ⇒ 返回 null（"页面里根本没有脚本"本身就该被断言抓住）。
   */
  function scriptOf(html) {
    const t = String(html === undefined || html === null ? pageHtml() : html);
    const m = /<script>([\s\S]*?)<\/script>/.exec(t);
    return m ? m[1] : null;
  }

  return { MARKERS: MARKERS, pageHtml: pageHtml, dataUrl: dataUrl, scriptOf: scriptOf, LINES: LINES };
});
