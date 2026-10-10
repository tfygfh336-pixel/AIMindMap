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

  it('格式认不出 ⇒ 错误信息里点名支持哪些、并说清 PDF 的两条路（不许含糊）', () => {
    expect(() => di.docToOutline('x.epub', { buf: Buffer.from('x') })).toThrow(/\.md \/ \.txt \/ \.docx/);
    expect(() => di.docToOutline('x.epub', { buf: Buffer.from('x') })).toThrow(/无书签走文字层/);
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
      expect(r.source).toBe('outline');        // 如实标注来源（书签）✓
      expect(r.md).toBe('# Book One\n## Chapter 1\n# Book Two');
      expect(r.stats.levelCounts['1']).toBe(2);     // 两个顶层 = 两棵树 ✓
    } finally { try { fsx.unlinkSync(p); } catch (e) { /* 清理失败不影响判定 */ } }
  });

  it('★ P0：PDF **无书签但有文字层** ⇒ 自动回退文字层并建成骨架（用户的真实样本就是这种）', () => {
    const { buildUnlabeledChinesePdf } = require('./pdf-fixture.js');
    const os = require('os'), path = require('path'), fsx = require('fs');
    const p = path.join(os.tmpdir(), 'mm-di-textlayer-' + Date.now() + '.pdf');
    fsx.writeFileSync(p, buildUnlabeledChinesePdf());
    try {
      const r = di.docToOutline(p);            // 同步入口（命令体不变量 ✓）：异步全在小进程里
      expect(r.format).toBe('pdf');
      expect(r.source).toBe('text');           // 来源 = 文字层（使用者看得见 ✓）
      expect(r.stats.levelCounts).toEqual({ 1: 1, 2: 2, 3: 2 });
      expect(r.md.split('\n').filter((l) => /^#/.test(l))).toEqual([
        '# 深入理解计算机系统 学习笔记',
        '## 第一章 概述', '### 1.1 研究背景',
        '## 第二章 方法', '### 2.1 顺序存储'
      ]);
      expect(r.md).toContain('这是一段中文正文');        // 正文没丢 ✓
      expect(r.md).not.toContain('AI MindMap 文字层夹具');  // 页眉没混进来 ✓
      expect(Array.isArray(r.notes) && r.notes.join(' ')).toContain('剔除');   // 如实报告了剔除的页眉页脚 ✓
    } finally { try { fsx.unlinkSync(p); } catch (e) { /* ignore */ } }
  }, 30000);

  it('PDF：无书签且文字层也用不上（每页才 13 个字符）⇒ **响亮拒绝**，理由里带数字与出路', () => {
    const { buildPdf } = require('./pdf-fixture.js');
    const os = require('os'), path = require('path'), fsx = require('fs');
    const no = path.join(os.tmpdir(), 'mm-di-nobook-' + Date.now() + '.pdf');
    const badp = path.join(os.tmpdir(), 'mm-di-bad-' + Date.now() + '.pdf');
    fsx.writeFileSync(no, buildPdf({ outline: [] }));
    fsx.writeFileSync(badp, Buffer.from('not a pdf'));
    // ⚠️ 每次都起一个小进程（spawnSync）⇒ **只调用一次**、把消息抓下来再断言，
    // 别为每条断言各起一次（全量跑时进程调度会让 4 次调用超过 vitest 的默认 5s 超时 ✗，实测踩到）
    const msgOf = (f) => { try { di.docToOutline(f); return ''; } catch (e) { return e.message; } };
    try {
      const noMsg = msgOf(no);
      expect(noMsg).toMatch(/没有书签/);
      expect(noMsg).toMatch(/文字层/);
      expect(noMsg).toMatch(/出路/);
      expect(noMsg).toMatch(/20 个字符/);            // 理由必须**带数字** ✓
      expect(msgOf(badp)).toMatch(/打不开/);
    } finally {
      try { fsx.unlinkSync(no); } catch (e) { /* ignore */ }
      try { fsx.unlinkSync(badp); } catch (e) { /* ignore */ }
    }
  }, 30000);
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

/* ============================================================
 * 来源指纹 origin（§2.8）与导入源闸门 —— 批量导入**幂等**的前提
 * ------------------------------------------------------------
 * 为什么这些必须是单测而不是只靠集成：判据本身是**纯函数**（指纹/规范化/匹配），
 * 集成里一旦红了，分不清是"指纹算错"还是"命令装错了"。
 * ============================================================ */
describe('doc-import：来源指纹 origin', () => {
  it('指纹对**内容**敏感：改一个字节就变（否则"改过没有"永远判不出来）', () => {
    const a = di.outlineSha256('# 标题\n正文\n');
    const b = di.outlineSha256('# 标题\n正文!\n');       // 只多一个字符
    const c = di.outlineSha256('# 标题\n正文 \n');       // 只多一个空格
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });

  it('指纹对**换行风格/BOM**不敏感：同一份内容存成 CRLF / 带 BOM 仍是同一个指纹', () => {
    const lf = di.outlineSha256('# 标题\n正文\n');
    expect(di.outlineSha256('# 标题\r\n正文\r\n')).toBe(lf);
    expect(di.outlineSha256('\uFEFF# 标题\n正文\n')).toBe(lf);
  });

  /* ★ 规范化本身（`normalizeOutline`）—— 为什么单列一条：它是**导入正文与指纹共用的那一份**
   * 转换，而 `import-md` 曾经漏调它（只拿它算指纹、把**原文**喂给建树）⇒ 带 BOM 的文件
   * 导入后第一个标题被静默吃掉（实测：只剩「第二本书」）。所以这里钉住它的**全部**行为，
   * 防止有人"顺手"往里加别的规范化（那会把指纹口径一起改掉，两处不一致又变成新的静默缺陷 ✗）。 */
  it('normalizeOutline 只做两件事：CRLF/CR→LF、剥 BOM（不多做 —— 它的行为就是指纹口径）', () => {
    expect(di.normalizeOutline('\uFEFF# 甲\r\n乙\r丙\n')).toBe('# 甲\n乙\n丙\n');
    // 只剥**开头**那一个 BOM；正文中间出现的 U+FEFF 是内容，不许动
    expect(di.normalizeOutline('甲\uFEFF乙')).toBe('甲\uFEFF乙');
    // 不做 trim / 不去空行 / 不动全角空格（那些若被"顺手"加进来，指纹口径会与正文口径一起静默改变）
    expect(di.normalizeOutline('  # 甲  \n\n')).toBe('  # 甲  \n\n');
    // null/undefined 当空串（resolveOrigin 那条路上的旧数据可能是 undefined）
    expect(di.normalizeOutline(null)).toBe('');
    expect(di.normalizeOutline(undefined)).toBe('');
  });

  it('originMatches：src 与 sha256 **都要**相同才算同一份来源', () => {
    const a = { kind: 'import', src: 'docs/a.md', sha256: 'x'.repeat(64), at: 'T', tool: 't' };
    expect(di.originMatches(a, { src: 'docs/a.md', sha256: 'x'.repeat(64) })).toBe(true);
    // 内容同、来源不同 ⇒ **不是**同一份（那是另一份文件，导它不该被拒）
    expect(di.originMatches(a, { src: 'docs/b.md', sha256: 'x'.repeat(64) })).toBe(false);
    // 来源同、内容改过 ⇒ 也不是（这正是最该拦住"我以为导过了"的那种）
    expect(di.originMatches(a, { src: 'docs/a.md', sha256: 'y'.repeat(64) })).toBe(false);
    expect(di.originMatches(null, a)).toBe(false);
    expect(di.originMatches(a, undefined)).toBe(false);
    expect(di.originMatches({ src: 'docs/a.md' }, a)).toBe(false);   // 缺 sha256（截断的旧记录）不匹配
  });

  it('makeOrigin：形状固定（kind/src/sha256/at/tool），且 src 与内容指纹都由它一处算', () => {
    const o = di.makeOrigin({ file: 'a/b.md', md: '# T\n', tool: 'import-md', at: '2026-10-10T00:00:00.000Z' });
    expect(o).toEqual({
      kind: 'import',
      src: di.sourceRef('a/b.md'),
      sha256: di.outlineSha256('# T\n'),
      at: '2026-10-10T00:00:00.000Z',
      tool: 'import-md'
    });
    expect(o.sha256).toMatch(/^[0-9a-f]{64}$/);
    // at 默认取当前时间（调用方不给时也不能是空串 —— schema 会判红）
    expect(typeof di.makeOrigin({ file: 'a.md', md: 'x' }).at).toBe('string');
  });

  it('describeOrigin：给人看的一句里必须含来源与指纹片段（报错文案与 --dry-run 共用它）', () => {
    const s = di.describeOrigin({ src: 'docs/a.md', sha256: 'abcdef'.repeat(11) + 'ab', at: 'T', tool: 'import-md' });
    expect(s).toContain('docs/a.md');
    expect(s).toContain('abcdef');
    expect(di.describeOrigin(null)).toContain('无来源');
  });
});

describe('doc-import：导入源闸门（原因准确 + 给出路）', () => {
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const osx = require('node:os');

  it('★ 目录入参：说清"这是目录不是文件" + 如实说 import-dir 未实现 + 给出**可执行**的出路', () => {
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'mm-dirgate-'));
    try {
      const p = di.describeImportSourceProblem(dir);
      expect(p).not.toBe(null);
      expect(p.code).toBe('is-dir');
      expect(p.message).toContain('目录');
      expect(p.message).toContain('不是文件');
      expect(p.message).toContain('import-dir');
      expect(p.message).toContain('尚未实现');
      // 出路必须是**现在就能跑**的真实命令（不是"敬请期待"）
      expect(p.message).toContain('import-md');
      expect(p.message).toContain('import-project');
      // 不许露出 Node 的原始 errno 文本（那正是本条的病根）
      expect(p.message).not.toContain('EISDIR');
      expect(di.directoryMessage(dir)).toBe(p.message);
    } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
  });

  it('不存在的路径：报文写"文件不存在"并说清相对路径按哪个目录解析（不冒充权限问题）', () => {
    const ghost = pathx.join(osx.tmpdir(), 'mm-nope-' + Date.now() + '.md');
    const p = di.describeImportSourceProblem(ghost);
    expect(p.code).toBe('missing');
    expect(p.message).toContain('文件不存在');
    expect(p.message).not.toMatch(/权限/);
  });

  it('正常文件返回 null（探针**不许**误杀可读文件 —— 否则导入全线变红）', () => {
    const f = pathx.join(osx.tmpdir(), 'mm-ok-' + Date.now() + '.md');
    fsx.writeFileSync(f, '# ok\n', 'utf8');
    try {
      expect(di.describeImportSourceProblem(f)).toBe(null);
    } finally { fsx.unlinkSync(f); }
  });
});

/* ============================================================
 * 体量闸门（⓪′）—— 几百 MB 的 txt/docx 不许整份读进内存
 * ------------------------------------------------------------
 * 为什么必须有单测：这条判据的**后果**只有两种，而两种都不能靠集成方便地验 ——
 *   ① 判太松：`fs.readFileSync` 把几百 MB 读进来 ⇒ 进程被系统杀掉 ⇒ **什么都不打印**
 *      （集成里只会看到"命令莫名退出"，分不清是上限没生效还是别的原因 ✗）；
 *   ② 判太紧：正常文档被拒 ⇒ 导入全线变红。
 * 所以判据本身（阈值、报文、边界）用单测钉住；真实文件只在集成里验"真的一份大文件会被拦"。
 * ============================================================ */
describe('doc-import：体量闸门（上限只有一份常量 + 报文说准原因并给三条出路）', () => {
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const osx = require('node:os');

  it('上限是**一份常量**（CLI 与 docToOutline 共用；改一处就同时改两条路）', () => {
    expect(di.MAX_SOURCE_MB).toBeGreaterThanOrEqual(16);      // 正常文档（几千页纯文本）要过得去
    expect(di.MAX_SOURCE_BYTES).toBe(di.MAX_SOURCE_MB * 1024 * 1024);
  });

  it('★ 超限：报文**说准原因**（不是"文件坏了"）+ 三条出路（拆/转格式/取一段），且不读文件', () => {
    const tooBig = di.describeOversizeSize((di.MAX_SOURCE_MB + 40) * 1048576, 'D:/big/某本书.txt');
    expect(tooBig).not.toBe(null);
    expect(tooBig.code).toBe('too-big');
    expect(tooBig.message).toContain('超过导入上限');
    expect(tooBig.message).toContain('没有读它');               // 关键：明确"没有读"
    expect(tooBig.message).not.toMatch(/坏了|损坏|打不开|没有给出结果/);   // 不许把"超限"说成"文件坏了"
    // 出路必须**可执行**（与目录闸门同一标准：不许只说"请想办法"）
    expect(tooBig.message).toContain('拆成几份');
    expect(tooBig.message).toContain('import-md');
    expect(tooBig.message).toContain('docx');
  });

  it('边界（两个判据各自真在判文件/缓冲区的字节数）：-1 / 正好 / +1 三档', () => {
    const fsx2 = require('node:fs');
    const f = pathx.join(osx.tmpdir(), 'mm-edge-' + Date.now() + '.txt');
    fsx2.writeFileSync(f, 'x', 'utf8');
    try {
      const setSize = (n) => fsx2.truncateSync(f, n);
      setSize(di.MAX_SOURCE_BYTES - 1);
      expect(di.describeOversizeSource(f)).toBe(null);
      setSize(di.MAX_SOURCE_BYTES);
      expect(di.describeOversizeSource(f)).toBe(null);                 // 正好等于 ⇒ 放行
      setSize(di.MAX_SOURCE_BYTES + 1);
      expect(di.describeOversizeSource(f)).not.toBe(null);             // 多一个字节 ⇒ 拦
      // Buffer 那条入口同一口径（两个判据共用 MAX_SOURCE_BYTES，不许各写一份边界）
      expect(di.describeOversizeBuffer(Buffer.alloc(di.MAX_SOURCE_BYTES), 'x')).toBe(null);
      expect(di.describeOversizeBuffer(Buffer.alloc(di.MAX_SOURCE_BYTES + 1), 'x')).not.toBe(null);
    } finally { fsx2.unlinkSync(f); }
  });

  it('`docToOutline` 真在**读之前**判：给一个超限文件 ⇒ 抛错且报文就是体量报文（不是 readFileSync 的错）', () => {
    const f = pathx.join(osx.tmpdir(), 'mm-big-' + Date.now() + '.md');
    // 稀疏文件：不真的占盘（writeFileSync 只写 1 字节，再用 truncate 撑到上限以上）
    fsx.writeFileSync(f, 'x', 'utf8');
    fsx.truncateSync(f, di.MAX_SOURCE_BYTES + 1024);
    try {
      expect(() => di.docToOutline(f)).toThrow(/超过导入上限/);
      // 从内存 Buffer 那条入口（调用方已经读完）同样拦住 —— 判据只有一处，两条路都生效
      const buf = Buffer.alloc(di.MAX_SOURCE_BYTES + 1);
      expect(() => di.docToOutline('x.md', { buf: buf })).toThrow(/超过导入上限/);
    } finally { fsx.unlinkSync(f); }
  });

  it('正常大小的文件不误杀（回归：闸门不能把常规导入全拒掉）', () => {
    const f = pathx.join(osx.tmpdir(), 'mm-small-' + Date.now() + '.md');
    fsx.writeFileSync(f, '# 标题\n正文\n', 'utf8');
    try {
      expect(di.describeOversizeSource(f)).toBe(null);
      expect(di.describeOversizeBuffer(Buffer.from('# 标题\n', 'utf8'), f)).toBe(null);
      expect(di.docToOutline(f).format).toBe('md');
    } finally { fsx.unlinkSync(f); }
  });

  it('取不到 size（不存在的路径）⇒ 返回 null（报错归 ⓪ 的"文件不存在"，不双重报同一个问题）', () => {
    expect(di.describeOversizeSource(pathx.join(osx.tmpdir(), 'mm-ghost-' + Date.now() + '.md'))).toBe(null);
  });
});
