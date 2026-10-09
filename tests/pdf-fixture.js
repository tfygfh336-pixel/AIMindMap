/* ============================================================
 * tests/pdf-fixture.js —— **自己生成**的 PDF 夹具（不引二进制样本 ✓）
 * ------------------------------------------------------------
 * 两个夹具，各管一段路：
 *   ① `buildPdf({outline})`  —— **书签**夹具（P8 最小切片用）：有/无书签两种 PDF。
 *   ② `buildTextPdf(pages)`  —— **文字层**夹具（P0 用）：纯代码造"有中文文字层、无书签"的 PDF。
 *
 * 为什么要生成而不是塞样本进来（调研稿 06 §测试建议 ✓）：二进制进 git 会烂在库里、
 * 且没人知道它怎么来的；用代码生成 ⇒ 每一页/每个书签都能按参数造，测什么造什么 ✓。
 *
 * ① 默认造出来的结构（P8 最小切片要用到的全部信号）：
 *   书签：Book One（→ 第 1 页）└ Chapter 1（→ 第 2 页）
 *   页面：2 页，各一段极短文本流（只要能过 pdf.js 解析 ✓）
 * `buildPdf({ outline: [] })` 可造"**没有书签**"的 PDF（P0 起：无书签会走文字层回退 ✓）。
 *
 * ② 文字层夹具怎么造中文（**没有内嵌字体**）：
 *   Type0 复合字体 + `/Encoding /Identity-H` + **ToUnicode CMap**（CID → Unicode）。
 *   为什么不用内嵌字体子集：那要手工写 FontFile2/CIDToGIDMap，几百行且易错 ✗；
 *   而 pdf.js 抽文本走的就是 ToUnicode ⇒ **没有字体程序也能取到正确文本**（实测 ✓，只有渲染才需要字形）。
 *   实测（2026-10-09，见 `.review/20261009-PDF方案调研与计划/probe-cn-fixture.mjs`）：
 *   pdf.js 取回的 `str` / `transform[3]` / `width` 与写进去的完全一致，含 CJK 与空格切分 ✓。
 *   ⚠️ 只支持 BMP 字符（CJK 常规字都在 BMP；给代理对会**抛错**而不是静默写坏 ✗）。
 * ============================================================ */
'use strict';

function contentStream(text) {
  return 'BT /F1 12 Tf 20 150 Td (' + String(text).replace(/[()\\]/g, '') + ') Tj ET';
}

/** 书签节点 → PDF 对象（先分号、后拼串：/Parent 必须在拼串前就确定 ✓） */
function collectNodes(outline) {
  const used = new Set([1, 2, 3, 4, 5, 7, 9, 10]);   // 固定占用：catalog/pages/2 页/2 内容流/outlines/font
  let next = 6;
  const alloc = () => { while (used.has(next)) next++; used.add(next); return next++; };
  const nodes = [];
  function walk(items, parentNum) {
    const made = [];
    (items || []).forEach((it) => {
      const node = { num: alloc(), title: String(it.title == null ? '' : it.title), page: (it.page === 2 ? 9 : 3), parent: parentNum, kids: [], next: null, prev: null };
      node.kids = walk(it.children, node.num);
      nodes.push(node); made.push(node);
    });
    // ⚠️ 同级书签在 PDF 里是**链表**（/Next /Prev）—— 少了它，pdf.js 只看得到第一个同级项 ✗
    //（本夹具第一版就踩了：两个顶层书签只解析出第一个 ⇒ 实测抓出来的 ✓）
    for (let i = 0; i + 1 < made.length; i++) { made[i].next = made[i + 1].num; made[i + 1].prev = made[i].num; }
    return made;
  }
  const top = walk(outline, 5);
  return { nodes: nodes, top: top };
}

function descendants(nodes) {
  let n = 0;
  (nodes || []).forEach((x) => { n += 1 + descendants(x.kids); });
  return n;
}

/**
 * @param {{outline?: Array<{title:string, page?:number, children?:Array}>}} opts
 * @returns {Buffer}
 */
function buildPdf(opts) {
  const outline = (opts && Array.isArray(opts.outline)) ? opts.outline : [];
  const c = collectNodes(outline);
  const body = {};
  const c1 = contentStream('Page one text');
  const c2 = contentStream('Page two text');
  body[1] = '<< /Type /Catalog /Pages 2 0 R'
    + (c.top.length ? ' /Outlines 5 0 R /PageMode /UseOutlines' : '') + ' >>';
  body[2] = '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 >>';
  body[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
  body[4] = '<< /Length ' + c1.length + ' >>\nstream\n' + c1 + '\nendstream';
  body[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  body[9] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 10 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
  body[10] = '<< /Length ' + c2.length + ' >>\nstream\n' + c2 + '\nendstream';
  if (c.top.length) {
    body[5] = '<< /Type /Outlines /First ' + c.top[0].num + ' 0 R /Last ' + c.top[c.top.length - 1].num + ' 0 R /Count '
      + descendants(c.top) + ' >>';
  }
  c.nodes.forEach((n) => {
    const parts = ['<< /Title (' + n.title.replace(/[()\\]/g, '') + ')', '/Parent ' + n.parent + ' 0 R', '/Dest [' + n.page + ' 0 R /Fit]'];
    if (n.kids.length) parts.push('/First ' + n.kids[0].num + ' 0 R', '/Last ' + n.kids[n.kids.length - 1].num + ' 0 R /Count ' + descendants(n.kids));
    if (n.prev) parts.push('/Prev ' + n.prev + ' 0 R');
    if (n.next) parts.push('/Next ' + n.next + ' 0 R');
    parts.push('>>');
    body[n.num] = parts.join(' ');
  });

  // —— 序列化：对象按编号升序、记偏移、再写 xref ——
  let out = '%PDF-1.4\n';
  const offsets = {};
  const maxNum = Math.max(...Object.keys(body).map(Number));
  for (let i = 1; i <= maxNum; i++) {
    if (!body[i]) continue;
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += i + ' 0 obj\n' + body[i] + '\nendobj\n';
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (maxNum + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= maxNum; i++) out += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (maxNum + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

/* ================= ② 文字层夹具：纯代码造"有文字层的中文 PDF" ================= */

/** 一个 item = 一次绝对定位的文本（PDF 用户坐标：原点在**左下**，y 大 = 靠上） */
const PAGE_W = 595, PAGE_H = 842;

/**
 * @param {Array<Array<{text:string, size:number, x:number, y:number}>>} pages 每页一组定位文本
 * @returns {Buffer}
 */
function buildTextPdf(pages) {
  // 1) 全篇不同字符 → CID（从 1 起；0 留给"没有字形"）
  const cidOf = new Map();
  const chars = [];
  for (const page of pages) {
    for (const it of page) {
      for (const ch of String(it.text)) {
        if (ch.codePointAt(0) > 0xffff) throw new Error('文字层夹具只支持 BMP 字符（不要用 emoji/生僻扩展字）: ' + ch);
        if (!cidOf.has(ch)) { cidOf.set(ch, chars.length + 1); chars.push(ch); }
      }
    }
  }
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  // 2) ToUnicode CMap（bfchar 每块最多 100 条）
  const cmapLines = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange'
  ];
  for (let i = 0; i < chars.length; i += 100) {
    const chunk = chars.slice(i, i + 100);
    cmapLines.push(chunk.length + ' beginbfchar');
    for (const ch of chunk) cmapLines.push('<' + hex4(cidOf.get(ch)) + '> <' + hex4(ch.codePointAt(0)) + '>');
    cmapLines.push('endbfchar');
  }
  cmapLines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  const cmap = cmapLines.join('\n') + '\n';
  // 3) 每页内容流：字号变了才发 Tf，每行一次 BT/Td/Tj
  const streams = pages.map((page) => {
    const parts = [];
    let curSize = 0;
    for (const it of page) {
      if (it.size !== curSize) { parts.push('/F1 ' + it.size + ' Tf'); curSize = it.size; }
      parts.push('BT ' + it.x + ' ' + it.y + ' Td <'
        + Array.from(String(it.text)).map((ch) => hex4(cidOf.get(ch))).join('') + '> Tj ET');
    }
    return parts.join('\n');
  });

  // 对象号：1 catalog / 2 pages / 3 Type0 / 4 CIDFont / 5 描述符 / 6 ToUnicode / 7 起 页与内容流
  const firstPage = 7;
  const pageObjs = streams.map((s, i) => firstPage + i * 2);
  const contentObjs = streams.map((s, i) => firstPage + i * 2 + 1);
  const body = {};
  body[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  body[2] = '<< /Type /Pages /Kids [' + pageObjs.map((n) => n + ' 0 R').join(' ') + '] /Count ' + streams.length + ' >>';
  body[3] = '<< /Type /Font /Subtype /Type0 /BaseFont /MMFIX+FixtureSC /Encoding /Identity-H'
    + ' /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>';
  body[4] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MMFIX+FixtureSC'
    + ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>'
    + ' /FontDescriptor 5 0 R /DW 1000 /W [1 [' + chars.map(() => '1000').join(' ') + ']] >>';
  body[5] = '<< /Type /FontDescriptor /FontName /MMFIX+FixtureSC /Flags 4 /FontBBox [0 -200 1000 900]'
    + ' /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>';
  body[6] = '<< /Length ' + Buffer.byteLength(cmap, 'latin1') + ' >>\nstream\n' + cmap + 'endstream';
  streams.forEach((s, i) => {
    body[pageObjs[i]] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + ']'
      + ' /Contents ' + contentObjs[i] + ' 0 R /Resources << /Font << /F1 3 0 R >> >> >>';
    body[contentObjs[i]] = '<< /Length ' + Buffer.byteLength(s, 'latin1') + ' >>\nstream\n' + s + '\nendstream';
  });

  // 4) 序列化：对象按编号升序、记偏移、再写 xref（与 buildPdf 同一套写法）
  let out = '%PDF-1.4\n';
  const offsets = {};
  const maxNum = Math.max(...Object.keys(body).filter((k) => body[k]).map(Number));
  for (let i = 1; i <= maxNum; i++) {
    if (!body[i]) continue;
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += i + ' 0 obj\n' + body[i] + '\nendobj\n';
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (maxNum + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= maxNum; i++) out += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (maxNum + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

/** 把一行居中放在页宽中间（夹具里大量用它 —— 居中判据的输入必须是真居中 ✓） */
function centered(text, size, y) {
  const w = Array.from(String(text)).length * size;      // 夹具里每个字形 /DW=1000 ⇒ 宽度 = 字数 × 字号
  return { text: text, size: size, x: (PAGE_W - w) / 2, y: y };
}

/**
 * 现成的"无书签、有中文文字层"样例（集成断言与单测共用，结构固定 ⇒ 数字可写死核对）：
 *   第 1 页：21pt 居中大标题 + 15.75pt 章 + 12.28pt 节 + 10.5pt 正文两行（同一段）
 *   第 2 页：15.75pt 章 + 12.28pt 节 + 10.5pt 正文两行
 *   两页都有 **重复页眉**（9pt）与 **页号页脚**（`1 / 2`、`2 / 2`）⇒ 用来验证页眉页脚剔除 ✓
 * @param {{header?:boolean}} [opts] header:false 可造"没有页眉页脚"的版本（对照用）
 * @returns {Buffer}
 */
function buildUnlabeledChinesePdf(opts) {
  const withEdge = !(opts && opts.header === false);
  const edge = (pageNo, total) => withEdge
    ? [centered('AI MindMap 文字层夹具', 9, 810), centered(pageNo + ' / ' + total, 9, 24)]
    : [];
  const p1 = edge(1, 2).concat([
    centered('深入理解计算机系统 学习笔记', 21, 760),
    { text: '第一章 概述', size: 15.75, x: 60, y: 700 },
    { text: '1.1 研究背景', size: 12.28, x: 60, y: 670 },
    { text: '这是一段中文正文，用来验证文字层的段落合并是否把同一段的两行并起来。', size: 10.5, x: 60, y: 640 },
    { text: '第二行紧跟上一行，行距正常，因此它必须与上一行同属一段，而不是新起一段。', size: 10.5, x: 60, y: 623.5 }
  ]);
  const p2 = edge(2, 2).concat([
    { text: '第二章 方法', size: 15.75, x: 60, y: 720 },
    { text: '2.1 顺序存储', size: 12.28, x: 60, y: 690 },
    { text: '第二个正文段：这一页验证跨页之后的层级仍然正确，且顶层主题数不因跨页而变化。', size: 10.5, x: 60, y: 660 },
    { text: '第二段的第二行同样应当与上一行合并成一段。', size: 10.5, x: 60, y: 643.5 }
  ]);
  return buildTextPdf([p1, p2]);
}

module.exports = { buildPdf, contentStream, buildTextPdf, centered, buildUnlabeledChinesePdf, PAGE_W, PAGE_H };
