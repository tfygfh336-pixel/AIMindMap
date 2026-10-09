/* ============================================================
 * tests/doc-import.test.js — 大文档 → 提纲的三种前端（功能 5a）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 最要紧的两条契约：
 *   ① **不丢内容**：txt 的启发式只决定"哪些行进结构"，其余行必须原样进正文
 *      （宁可少一层结构，也不许把用户的文字吃掉 ✗）；
 *   ② **读不了就说读不了**：docx 不支持 ZIP64/加密、缺 document.xml ⇒ 一律**响亮抛错**，
 *      不许静默给一个空树（"没做，却看不出没做"是本工程最重的损害类别）。
 * docx 的测试**在测试里手工造 zip**（不是用被测代码造）⇒ 读取器面对的是独立实现，
 * 否则就是自己验自己 ✓。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const di = require('../src/doc-import.js');

/** 手工造一个 zip：entries = [{name, text, deflate:boolean}] */
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.text, 'utf8');
    const data = e.deflate === false ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.deflate === false ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.deflate === false ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([Buffer.concat(locals), cenBuf, eocd]);
}

const DOC_XML = '<?xml version="1.0"?><w:document><w:body>'
  + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 绪论</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">这一章讲的是 </w:t></w:r><w:r><w:t>&lt;A&gt; &amp; B</w:t></w:r></w:p>'
  + '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1 背景</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>正文一段。</w:t></w:r></w:p>'
  + '<w:p/>'
  + '</w:body></w:document>';

describe('格式识别', () => {
  it('按扩展名', () => {
    expect(di.detectFormat('a.md', Buffer.from('# x'))).toBe('md');
    expect(di.detectFormat('a.txt', Buffer.from('x'))).toBe('txt');
    expect(di.detectFormat('a.docx', Buffer.from('PK'))).toBe('docx');
  });

  it('没有/不认识扩展名时看内容：zip 魔数 ⇒ docx；`#` 开头 ⇒ md；其余 ⇒ txt', () => {
    expect(di.detectFormat('noext', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBe('docx');
    expect(di.detectFormat('noext', Buffer.from('  # 标题\n正文'))).toBe('md');
    expect(di.detectFormat('noext', Buffer.from('就是一段话'))).toBe('txt');
  });

  it('认不出（空文件）⇒ null（由调用方响亮报错，不是猜一个格式）', () => {
    expect(di.detectFormat('noext', Buffer.alloc(0))).toBe(null);
  });
});

describe('txt → 提纲：只决定结构，**不丢内容**', () => {
  const TXT = [
    '第一章 绪论',
    '',
    '这是正文第一段，里面有逗号，还有句末标点。',
    '',
    '1.1 研究背景',
    '',
    '这一节讲背景，句子比较长所以肯定不会变成标题，而且它带有逗号与句号。',
    '',
    '- 这是一个列表项',
    'https://example.com/a',
    '',
    '短标题',
    '',
    '一个非常非常非常非常非常非常非常非常非常非常长的句子不可能被当成标题'
  ].join('\n');

  it('章/节被识别成 1/2 级；正文段落不被当成标题', () => {
    const md = di.textToOutline(TXT);
    expect(md).toContain('# 第一章 绪论');
    expect(md).toContain('## 1.1 研究背景');
    expect(md).toContain('## 短标题');
    expect(md).toContain('这是正文第一段，里面有逗号，还有句末标点。');   // 原样保留 ✓
  });

  it('列表项 / 网址 / 长句 / 带句末标点的行都不算标题', () => {
    expect(di.looksLikeHeading('- 这是一个列表项', true, true, false)).toBe(false);
    expect(di.looksLikeHeading('https://example.com/a', true, true, false)).toBe(false);
    expect(di.looksLikeHeading('这是什么？', true, true, false)).toBe(false);
    expect(di.looksLikeHeading('一个非常非常非常非常非常非常非常非常非常非常长的句子不可能被当成标题', true, true, false)).toBe(false);
  });

  it('★ 内容零丢失：去掉标题标记后，提纲里的每个非空行都能在原文里找到', () => {
    const md = di.textToOutline(TXT);
    const src = new Set(TXT.split('\n').map((l) => l.trim()).filter(Boolean));
    for (const line of md.split('\n')) {
      const bare = line.replace(/^#{1,6}\s+/, '').trim();
      if (bare) expect(src.has(bare), '提纲里多出了原文没有的内容: ' + bare).toBe(true);
    }
    const srcBare = new Set(Array.from(src).map((l) => l.replace(/^#{1,6}\s+/, '')));
    for (const line of md.split('\n')) {
      const bare = line.replace(/^#{1,6}\s+/, '').trim();
      if (bare) expect(srcBare.has(bare)).toBe(true);
    }
    // 反过来：原文的每个非空行也必须还在（不许"吃行"✗）
    for (const line of src) {
      const bare = line.replace(/^#{1,6}\s+/, '');
      expect(md.split('\n').some((l) => l.replace(/^#{1,6}\s+/, '').trim() === bare),
        '原文这一行在提纲里丢了: ' + line).toBe(true);
    }
  });
});

describe('docx → 提纲（最小 zip 读取器）', () => {
  it('deflate 条目能读出来：段落文本 + 标题层级 + XML 实体解码', () => {
    const zip = makeZip([{ name: '[Content_Types].xml', text: '<x/>' }, { name: 'word/document.xml', text: DOC_XML }]);
    const xml = di.zipFindEntry(zip, 'word/document.xml');
    expect(xml).toBeTruthy();
    const paras = di.docxParagraphs(xml.toString('utf8'));
    const texts = paras.map((p) => p.text).filter(Boolean);
    expect(texts).toContain('第一章 绪论');
    expect(texts).toContain('这一章讲的是 <A> & B');       // 实体解码 ✓（跨 run 拼接 ✓）
    expect(paras.find((p) => p.text === '第一章 绪论').level).toBe(1);
    expect(paras.find((p) => p.text === '1.1 背景').level).toBe(2);
    expect(paras.find((p) => p.text === '正文一段。').level).toBe(0);
  });

  it('stored（不压缩）条目也能读（method 0）', () => {
    const zip = makeZip([{ name: 'word/document.xml', text: DOC_XML, deflate: false }]);
    expect(di.zipFindEntry(zip, 'word/document.xml').toString('utf8')).toContain('第一章 绪论');
  });

  it('docToOutline 走完整链路：zip → xml → 提纲 Markdown', () => {
    const zip = makeZip([{ name: 'word/document.xml', text: DOC_XML }]);
    const r = di.docToOutline('x.docx', { buf: zip });
    expect(r.format).toBe('docx');
    expect(r.md).toContain('# 第一章 绪论');
    expect(r.md).toContain('## 1.1 背景');
    expect(r.md).toContain('正文一段。');
    expect(r.stats.headings).toBe(2);
    expect(r.stats.levelCounts).toEqual({ 1: 1, 2: 1 });
  });
});

describe('读不了就说读不了（绝不给一个空树冒充成功）', () => {
  it('缺 word/document.xml ⇒ 抛错并说明原因', () => {
    const zip = makeZip([{ name: 'foo.txt', text: 'x' }]);
    expect(() => di.docToOutline('x.docx', { buf: zip })).toThrow(/没有 word\/document\.xml/);
  });

  it('ZIP64 ⇒ 响亮抛错（不猜、不静默给空）', () => {
    const zip = makeZip([{ name: 'word/document.xml', text: 'x' }]);
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16);   // 把 EOCD 里的中央目录偏移改成 ZIP64 标记
    expect(() => di.zipFindEntry(zip, 'word/document.xml')).toThrow(/ZIP64/);
  });

  it('这不是 zip ⇒ zipFindEntry 返回 null（不是抛），由调用方给出"认不出格式"的错', () => {
    expect(di.zipFindEntry(Buffer.from('这不是一个 zip 文件'), 'word/document.xml')).toBe(null);
  });

  it('格式认不出 ⇒ 错误信息里点名支持哪些、并说清 5b 的边界（不许含糊）', () => {
    expect(() => di.docToOutline('x.epub', { buf: Buffer.from('x') })).toThrow(/\.md \/ \.txt \/ \.docx/);
    expect(() => di.docToOutline('x.epub', { buf: Buffer.from('x') })).toThrow(/5b/);
    expect(() => di.docToOutline('x.epub', { buf: Buffer.from('x') })).toThrow(/暂不支持 \.epub/);
  });

  it('P8 最小切片：PDF 有书签 ⇒ 书签变成 `#` 标题（顶层多于一个 = 一个文件多棵树 ✓）', () => {
    const { buildPdf } = require('./pdf-fixture.js');
    const os = require('os'), path = require('path'), fsx = require('fs');
    const p = path.join(os.tmpdir(), 'mm-di-two-books-' + Date.now() + '.pdf');
    fsx.writeFileSync(p, buildPdf({ outline: [{ title: 'Book One', page: 1, children: [{ title: 'Chapter 1', page: 2 }] }, { title: 'Book Two', page: 2 }] }));
    try {
      const r = di.docToOutline(p);            // **同步入口**（命令体不变量要求 ✓）：内部起小进程读书签
      expect(r.format).toBe('pdf');
      expect(r.md).toBe('# Book One\n## Chapter 1\n# Book Two');
      expect(r.stats.levelCounts['1']).toBe(2);     // 两个顶层 = 两棵树 ✓
    } finally { try { fsx.unlinkSync(p); } catch (e) { /* 清理失败不影响判定 */ } }
  });

  it('P8 最小切片：无书签 / 坏 PDF 都**响亮拒绝**（5b 其余部分未批准 ⇒ 不猜、不静默降级 ✗）', () => {
    const { buildPdf } = require('./pdf-fixture.js');
    const os = require('os'), path = require('path'), fsx = require('fs');
    const no = path.join(os.tmpdir(), 'mm-di-nobook-' + Date.now() + '.pdf');
    const badp = path.join(os.tmpdir(), 'mm-di-bad-' + Date.now() + '.pdf');
    fsx.writeFileSync(no, buildPdf({ outline: [] }));
    fsx.writeFileSync(badp, Buffer.from('not a pdf'));
    try {
      expect(() => di.docToOutline(no)).toThrow(/没有书签/);
      expect(() => di.docToOutline(badp)).toThrow(/打不开/);
    } finally {
      try { fsx.unlinkSync(no); } catch (e) { /* ignore */ }
      try { fsx.unlinkSync(badp); } catch (e) { /* ignore */ }
    }
  });
  it('★ 带 BOM 的 md/txt 必须容忍：BOM 会让首行 `#` 匹配不上，把第一个标题吃成正文（实测踩到）', () => {
    const withBom = '\uFEFF# 第一本书\n\n## 第 1 章\n正文\n\n# 第二本书\n';
    const r = di.docToOutline('bom.md', { buf: Buffer.from(withBom, 'utf8') });
    expect(r.md.charCodeAt(0)).not.toBe(0xfeff);
    expect(r.md.startsWith('# 第一本书')).toBe(true);
    expect(r.stats.levelCounts).toEqual({ 1: 2, 2: 1 });
    // txt 同理（BOM 挡住的是第一行标题的识别）
    const t = di.docToOutline('bom.txt', { buf: Buffer.from('\uFEFF第一章 绪论\n\n正文。\n\n第二章 方法\n', 'utf8') });
    expect(t.md).toContain('# 第一章 绪论');
    expect(t.stats.levelCounts).toEqual({ 1: 2 });
  });
});
