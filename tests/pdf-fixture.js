/* ============================================================
 * tests/pdf-fixture.js —— **自己生成**的最小 PDF 夹具（不引二进制样本 ✓）
 * ------------------------------------------------------------
 * 为什么要生成而不是塞样本进来（调研稿 06 §测试建议 ✓）：二进制进 git 会烂在库里、
 * 且没人知道它怎么来的；用代码生成 ⇒ 每一页/每个书签都能按参数造，测什么造什么 ✓。
 *
 * 默认造出来的结构（P8 最小切片要用到的全部信号）：
 *   书签：Book One（→ 第 1 页）└ Chapter 1（→ 第 2 页）
 *   页面：2 页，各一段极短文本流（只要能过 pdf.js 解析 ✓）
 * `buildPdf({ outline: [] })` 可造"**没有书签**"的 PDF —— 那正是 5b 里尚未批准的那条路 ✗，
 * 它必须**响亮拒绝**（不许静默失败，也不许当文本读进去 ✗）。
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

module.exports = { buildPdf, contentStream };
