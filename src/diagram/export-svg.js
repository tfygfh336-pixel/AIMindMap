/* ============================================================
 * src/diagram/export-svg.js — **导出（SVG 那一档）+ 导出前的自检 + 能力清单**
 * ------------------------------------------------------------
 * 这个模块只做三件事，每件都能被独立判：
 *   ① `exportSVG(doc, opts)`：跑一次渲染（含主题）→ 交付前自检 → 返回 `{svg, bytes, checks}`。
 *      **自检不过就不交产物**（`ok:false` + `problems[]`），这是 `C-F5-04` 的"导出前检测"。
 *   ② `checkStandalone(svg)`：产物是否**自足**（0 个 `<link rel=stylesheet>`、0 个 `@import`、
 *      0 个 `http(s)://` 外链、0 个 `url(` 外部引用）—— `C-F6-04` / `C-F8-01` 的判据就是这四个 0。
 *   ③ `exportCapabilities()`：**如实**说明 PNG / PDF 能不能做、缺什么。这一条是本工程的规矩：
 *      "没做"必须写在代码里，不许靠读者猜（`docs/DIAGRAM-MODES.md` §8 / 本批缺口登记）。
 *
 * 边界（与 `src/diagram/**` 其余模块同一条铁律）：
 *   ❌ 零 I/O：不读盘、不写盘、不碰进程、不碰 DOM。落盘是 CLI 层的事（本批不许改 `cli/`）。
 *   ❌ 零时钟、零随机：同输入两跑逐字节相同（含主题与 overpass 开关）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./render-svg.js'), require('./tokens.js'));
  } else {
    root.MMDiagramExport = factory(root.MMDiagramRender, root.MMDiagramTokens);
  }
})(typeof self !== 'undefined' ? self : this, function (render, tokens) {
  'use strict';

  /** 字节数（UTF-8）—— `Buffer` 是 Node 专有，浏览器侧退回手算，**语义一致**：
   *  这里存在的意义是"交付时能说清产物有多大"，而不是"精确到某个平台的编码器"。 */
  function utf8Bytes(s) {
    const str = String(s === undefined || s === null ? '' : s);
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) { n += 4; i++; }   // 代理对
      else n += 3;
    }
    return n;
  }

  /**
   * 产物是否**自足**（导出这一个文件就能看，不依赖任何外部资源）。
   * 四个 0：`<link rel="stylesheet">` / `@import` / `http(s)://` 外链 / `url(…)` 外部引用。
   * ⚠️ `xmlns="http://www.w3.org/2000/svg"` 是**命名空间声明**，不是外链 —— 它被单独豁免，
   * 且那条正则只在"属性值里出现的 http(s)"上判（见下）。
   */
  function checkStandalone(svg) {
    const s = String(svg || '');
    const linkRel = (s.match(/<link\b[^>]*rel\s*=\s*["']?stylesheet/gi) || []).length;
    const imports = (s.match(/@import\b/gi) || []).length;
    // 外链：出现在**属性值**里的 http(s)（`xlink:href="https://…"` / `href="http://…"` / `src=…`）
    const attrUrls = (s.match(/\b(?:href|xlink:href|src)\s*=\s*["']https?:\/\//gi) || []).length;
    // `url(...)` 引用（`url(#id)` 是本文件的片段引用，允许；`url(https://…)` / `url(data:…)` 以外一律算外链）
    const urlRefs = (s.match(/url\(\s*["']?(?!\s*#)[^)]*\)/gi) || []).length;
    const problems = [];
    if (linkRel) problems.push('E_EXPORT_LINK: 导出里有 ' + linkRel + ' 个 <link rel="stylesheet">（不依赖外部 CSS 是判据）');
    if (imports) problems.push('E_EXPORT_IMPORT: 导出里有 ' + imports + ' 处 @import');
    if (attrUrls) problems.push('E_EXPORT_EXTERNAL: 导出里有 ' + attrUrls + ' 个 http(s) 外链属性');
    if (urlRefs) problems.push('E_EXPORT_URL: 导出里有 ' + urlRefs + ' 处非片段 url(…) 引用');
    return {
      ok: problems.length === 0,
      linkRelStylesheet: linkRel,
      imports: imports,
      externalUrls: attrUrls,
      urlRefs: urlRefs,
      problems: problems
    };
  }

  /**
   * 把**一次渲染的结果**包成"可交付的导出"（自检 + 字节数 + 读数）。
   * 与 `exportSVG` 的分工：这一个是**纯包装**（不渲染），所以自动布局那一档（`renderAuto`）
   * 也能用同一个交付口径 —— 两条坐标来源不该有两套自检。
   *
   * @param {{svg:string, report:object}} res 渲染结果
   * @returns {{ok:boolean, svg:string, bytes:number, theme:string, checks:object, report:object, problems:string[]}}
   */
  function exportOf(res) {
    const r = res || {};
    const svg = String(r.svg || '');
    const report = r.report || {};
    const standalone = checkStandalone(svg);
    const problems = [];
    // ① 自足（`C-F6-04` / `C-F8-01`）
    standalone.problems.forEach((p) => problems.push(p));
    // ② 溢出（`C-F5-04`）：`renderDiagram` 在放不下时**已经抛错**，所以这里读到非 0 就是实现缺陷
    if (report.overflowCount !== 0) {
      problems.push('E_EXPORT_OVERFLOW: 导出前溢出计数 = ' + report.overflowCount + '（必须为 0）');
    }
    // ③ 主题（`C-F6-02`/`03`）：正文对的对比度必须 ≥ 4.5:1
    const contrast = report.theme ? report.theme.contrast : [];
    contrast.forEach((c) => {
      if (!(c.ratio >= 4.5)) {
        problems.push('E_EXPORT_CONTRAST: ' + c.theme + ' 主题的 ' + c.fg + ' on ' + c.bg
          + ' 对比度 = ' + (Number.isFinite(c.ratio) ? c.ratio.toFixed(2) : 'NaN') + ':1（要求 ≥ 4.5）');
      }
    });
    return {
      ok: problems.length === 0,
      svg: svg,
      bytes: utf8Bytes(svg),
      theme: report.theme ? report.theme.name : 'light',
      checks: standalone,
      report: report,
      problems: problems
    };
  }

  /**
   * 导出 SVG（唯一**已实现**的导出档）—— **手写坐标**那条入口（MS1）。
   *
   * @param {object} doc `{ graph, nodes }`
   * @param {object} [opts] 透传给 `render.renderDiagram`：`measureText` / `layout` / `routing` /
   *   `routePenalty` / `reversedEdgeIds` / `theme`（`light`|`dark`）/ `overpass`
   * @returns {{ok:boolean, svg:string, bytes:number, theme:string, checks:object, report:object, problems:string[]}}
   */
  function exportSVG(doc, opts) {
    return exportOf(render.renderDiagram(doc, Object.assign({}, opts || {})));
  }

  /**
   * **能力清单**（如实）：哪一档能导出、哪一档不能、缺什么、缺的那个东西叫什么。
   *
   * PNG / PDF 为什么是 `ok:false`（这不是"还没写"，是"这个仓里做不到"）：
   *   仓里的依赖只有 `electron` / `jsmind` / `vitest` / `pdfjs-dist`（PDF **解析**器）/
   *   `@napi-rs/system-ocr`（OCR）。**没有任何光栅器**：没有 `canvas` / `sharp` /
   *   `@resvg/resvg-js` / `pureimage`。纯 JS 自写光栅化的硬点是**字形**（没有字体轮廓就没有文字），
   *   而没有文字的图不是图。本批禁 `npm install`、禁起 Electron ⇒ **做不到，如实登记**。
   *   PDF 还多一层：要让文字**可提取**，中文必须嵌 CID 字体子集，同样要字体解析。
   *   ⇒ 宁可 `ok:false` + 写清缺什么，也不输出一张坏图（父批 §八 第 3 条）。
   */
  function exportCapabilities() {
    return {
      svg: {
        ok: true,
        implemented: true,
        note: '内联样式（元素属性）· 0 外链 · 两跑逐字节相同（`C-F8-01` / `C-F9-02`）'
      },
      png: {
        ok: false,
        implemented: false,
        scale: null,
        needs: ['canvas', 'sharp', '@resvg/resvg-js', 'pureimage'],
        reason: '仓里没有任何 SVG 光栅器（依赖只有 electron / jsmind / vitest / pdfjs-dist / system-ocr）；'
          + '纯 JS 自写光栅化的硬点是字形轮廓解析（没有文字就不是图）⇒ 不做，也不输出坏图',
        registeredIn: ['.review/20261061-参考archify与graphify/提取.md', 'docs/DIAGRAM-MODES.md']
      },
      pdf: {
        ok: false,
        implemented: false,
        needs: ['字体子集嵌入（CID）', '或 canvas/sharp 之类光栅器'],
        reason: '判据要求"文字可提取"，中文必须嵌 CID 字体子集 ⇒ 要字体解析；'
          + '设计 §9 第 3 条也已裁定本期不做（判据面最贵的一档）',
        registeredIn: ['.review/20261061-参考archify与graphify/提取.md', 'docs/DIAGRAM-MODES.md']
      }
    };
  }

  return {
    exportSVG: exportSVG,
    exportOf: exportOf,
    exportCapabilities: exportCapabilities,
    checkStandalone: checkStandalone,
    utf8Bytes: utf8Bytes,
    THEME_NAMES: tokens.THEME_NAMES
  };
});
