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

  it('★ 目录入参：说清"这是目录不是文件" + 指向**已实现**的 import-dir + 给出**可执行**的出路', () => {
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'mm-dirgate-'));
    try {
      const p = di.describeImportSourceProblem(dir);
      expect(p).not.toBe(null);
      expect(p.code).toBe('is-dir');
      expect(p.message).toContain('目录');
      expect(p.message).toContain('不是文件');
      expect(p.message).toContain('import-dir');
      // 批 5 之前这句写的是"尚未实现"；`import-dir` 落地后它必须**指给真实的命令**，
      // 并且把用法整句写出来（"提示去看某命令"和"能照着敲"是两回事 ✓）
      expect(p.message).not.toContain('尚未实现');
      expect(p.message).toContain('node cli/mm-cli.js import-dir');
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

/* ============================================================
 * 整库导入（`import-dir`，批 5）：目录树 → 节点树的映射
 * ------------------------------------------------------------
 * 为什么这些必须是单测（而不是只靠集成）：转换与拼装是**纯逻辑 + 文件系统读**，
 * 集成里一旦红了，分不清是"跳过分类算错""容器拼错层"还是"命令装错了"。
 * 集成那边另有一条端到端（沙箱临时项目根）：导入后 `read --brief` 的结构、跳过计数、
 * 幂等拒绝、`--dry-run` 不建项目 —— 两边各管一半，互不替代 ✓
 *
 * ⚠️ 本组**只读**：所有探针目录都建在系统临时目录里，用完立刻删（本工程对探针的一贯要求 ✓）
 * ============================================================ */
describe('doc-import：整库导入 —— 目录走查、跳过分类、容器拼装', () => {
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const osx = require('node:os');

  /** 造一棵探针目录树（返回根路径）；`spec` 是 `{ 相对路径: 内容 }`，值为 `null` 表示建空目录 */
  const makeTree = (spec) => {
    const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'mm-dirit-'));
    Object.keys(spec).forEach((rel) => {
      const p = pathx.join(root, rel);
      if (spec[rel] === null) { fsx.mkdirSync(p, { recursive: true }); return; }
      fsx.mkdirSync(pathx.dirname(p), { recursive: true });
      fsx.writeFileSync(p, spec[rel], 'utf8');
    });
    return root;
  };
  /** 把一个节点树压成 `主题(子主题…)` 的字符串 —— 结构断言的**唯一**写法（免得每处各写一套遍历） */
  const shape = (n) => n.topic + ((n.children || []).length
    ? '(' + n.children.map(shape).join(' ') + ')' : '');

  it('★ 结构映射：**每一级子目录 = 一个容器节点**、每个文件 = 一个文件节点（标题取文件名去扩展名）', () => {
    const root = makeTree({
      'note-a.md': '# 甲的标题\n正文 A\n',
      '笔记/第一章.md': '# 第一章\n正文一\n',
      '笔记/深/更深处.txt': '没有可识别标题的一行\n第二行\n'
    });
    try {
      const scan = di.scanImportDir(root, {});
      expect(scan.counts).toEqual({});                       // 三类干扰项都没有 ⇒ 一个都不许跳
      expect(scan.files.map((f) => f.rel).sort())
        .toEqual(['note-a.md', '笔记/深/更深处.txt', '笔记/第一章.md']);   // 排序按码位：'深' < '第'
      const built = di.buildDirImportTree(scan, { at: 'T' });
      expect(built.containers).toBe(2);                       // `笔记` + `笔记/深`
      expect(built.files).toBe(3);
      // 目录在前、文件在后；目录层级**不许被拍平**（拍平就丢了"镜像文件夹"这个唯一的卖点 ✗）
      expect(built.children.map(shape)).toEqual([
        '笔记(深(更深处) 第一章(第一章))',
        'note-a(甲的标题)'
      ]);
      // 文件节点的标题 = 文件名去扩展名（**不是**文档首个标题）—— 与原文件名一一对得上
      expect(built.entries.map((e) => e.topic).sort()).toEqual(['note-a', '更深处', '第一章']);
      expect(built.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('★ 一个标题都没有的文件**不许丢内容**：退到文件节点自己的 detail（实测缺口：markdownToTree 只在有标题时才收正文）', () => {
    const root = makeTree({ '无标题.txt': '这行不是标题\n这行也不是\n' });
    try {
      const built = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
      expect(built.files).toBe(1);
      const fileNode = built.children[0];
      expect(fileNode.children).toEqual([]);
      expect(typeof fileNode.detail).toBe('string');
      expect(fileNode.detail).toContain('这行不是标题');       // 内容真的在，不是"导了个空节点"
      expect(built.skipped).toEqual([]);
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('★【W14】有标题的文件：第一个标题**之前**的正文落"文件节点"detail（原先被静默丢掉）', () => {
    const root = makeTree({ '带前言.md': '前言第一行\n\n前言第二段\n\n# 标题甲\n甲正文\n' });
    try {
      const built = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
      expect(built.files).toBe(1);
      const fileNode = built.children[0];
      // 标题照旧建节点（这条修复**不改**原来的建树行为）
      expect(fileNode.children.length).toBeGreaterThan(0);
      expect(fileNode.children[0].topic).toBe('标题甲');
      // 前导正文不许丢：落到文件节点自己的 detail（与"无标题"那条**同一个落点规则**）
      expect(typeof fileNode.detail).toBe('string');
      expect(fileNode.detail).toContain('前言第一行');
      expect(fileNode.detail).toContain('前言第二段');
      // 且不与标题后正文串味
      expect(fileNode.detail).not.toContain('甲正文');
      // 逐文件计数可查（报告要用）
      expect(built.preambles).toBe(1);
      expect(built.skipped).toEqual([]);
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });


  it('★ 跳过逐类计数：隐藏 / 依赖目录 / 空目录 / 无可用文件 / 不支持的扩展名 / 符号链接 —— **每一类都点名**', () => {
    const root = makeTree({
      'ok.md': '# 好\n',
      '.hidden.md': '# 藏\n',
      '.git/config': 'x',
      'node_modules/dep.md': '# 依赖\n',
      '空目录': null,
      '只有图片/img.png': 'binary',
      '图.png': 'binary',
      '笔记.markdown': '# markdown 后缀\n'
    });
    try {
      // 造一个指向自己的 junction（Windows 上不需要管理员权限；Node 把 junction 也报成符号链接）
      // ⇒ 环**不可能**造成死循环：符号链接一律不跟随 ✓
      let linked = true;
      try { fsx.symlinkSync(root, pathx.join(root, '自引用'), 'junction'); }
      catch (e) { linked = false; }
      const scan = di.scanImportDir(root, {});
      const c = scan.counts;
      expect(c.hidden).toBe(2);                    // .hidden.md + .git
      expect(c['skip-dir']).toBe(1);               // node_modules
      expect(c['empty-dir']).toBe(1);              // 空目录
      expect(c['no-importable']).toBe(1);          // 只有图片/（里面有 png 但都不可导）
      expect(c['unsupported-ext']).toBe(3);        // 图.png + 只有图片/img.png + 笔记.markdown（默认集合不含 .markdown）
      if (linked) expect(c.symlink).toBe(1);       // 自引用 junction ⇒ 跳过且**没有死循环**
      expect(di.skippedTotal(scan)).toBe(scan.skipped.length);
      // 每一类都必须有"为什么"（报告里要打出来，不许只给个数字）
      Object.keys(c).forEach((k) => { expect(di.SKIP_LABEL[k]).toBeTruthy(); });
      // 被 `--ext` 排除、但本来能导的扩展名要单独记 + 给一句出路
      expect(scan.otherImportableExt).toEqual({ '.markdown': 1 });
      // 只导 .md/.markdown ⇒ 那个被排除的 .markdown 变成可导（同一个判据，不是两套）
      const scan2 = di.scanImportDir(root, { ext: di.normalizeExtList('md,markdown').ext });
      expect(scan2.files.map((f) => f.rel).sort()).toEqual(['ok.md', '笔记.markdown']);
      expect(scan2.otherImportableExt).toEqual({});
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('跳过判据是**一个纯函数**（`entrySkipReason`）：六种形态各判一次，报告与走查不会各有一套', () => {
    expect(di.entrySkipReason({ name: '.git', isDirectory: () => true })).toBe('hidden');
    expect(di.entrySkipReason({ name: 'node_modules', isDirectory: () => true })).toBe('skip-dir');
    expect(di.entrySkipReason({ name: 'link', isSymbolicLink: () => true, isDirectory: () => true })).toBe('symlink');
    expect(di.entrySkipReason({ name: 'a.md', isFile: () => true })).toBe(null);
    expect(di.entrySkipReason({ name: '笔记', isDirectory: () => true })).toBe(null);
    expect(di.entrySkipReason({ name: 'dev', isDirectory: () => false, isFile: () => false })).toBe('not-regular-file');
    expect(di.entrySkipReason({ name: '' })).toBe('unreadable');
  });

  it('空文件（0 字节）**单独计一类**（不是"静默导出一个空节点"，也不是混进"读失败"）', () => {
    const root = makeTree({ 'a.md': '# 有\n', 'b.md': '', 'c.txt': '   \n\n' });
    try {
      const built = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
      expect(built.files).toBe(1);
      expect(built.skipped.map((s) => s.rel).sort()).toEqual(['b.md', 'c.txt']);
      expect(built.skipped.every((s) => s.reason === 'empty-file')).toBe(true);
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('★ 目录清单指纹：**确定**（两次一样）、对增删改文件敏感、对文件改名敏感', () => {
    const e1 = [{ rel: 'a.md', sha256: 'a'.repeat(64) }, { rel: 'b/c.md', sha256: 'b'.repeat(64) }];
    const e2 = [{ rel: 'b/c.md', sha256: 'b'.repeat(64) }, { rel: 'a.md', sha256: 'a'.repeat(64) }];
    const h = di.dirManifestSha256(e1);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(di.dirManifestSha256(e2)).toBe(h);                       // 顺序无关（先排序再算）
    expect(di.dirManifestSha256(e1.slice(0, 1))).not.toBe(h);       // 少一个文件 ⇒ 变
    expect(di.dirManifestSha256([{ rel: 'a.md', sha256: 'c'.repeat(64) }, e1[1]])).not.toBe(h);  // 内容改 ⇒ 变
    expect(di.dirManifestSha256([{ rel: 'a2.md', sha256: 'a'.repeat(64) }, e1[1]])).not.toBe(h);  // 改名 ⇒ 变
    // 目录级 origin 与文件级 origin **同一个形状**（schema 只认这一套）
    const o = di.makeDirOrigin({ dir: 'some/dir', entries: e1, at: 'T' });
    expect(Object.keys(o).sort()).toEqual(['at', 'kind', 'sha256', 'src', 'tool']);
    expect(o.kind).toBe('import');
    expect(o.sha256).toBe(h);
    expect(o.tool).toBe('import-dir');
  });

  it('originKey 与 originMatches **同一口径**（索引表按 key 查，逐个比对按 matches 判 ⇒ 两条路必须同结论）', () => {
    const base = { kind: 'import', src: 'a/b.md', sha256: 'x'.repeat(64), at: 'T' };
    const cases = [
      [base, { src: 'a/b.md', sha256: 'x'.repeat(64) }],
      [base, { src: 'a/other.md', sha256: 'x'.repeat(64) }],
      [base, { src: 'a/b.md', sha256: 'y'.repeat(64) }],
      [base, { sha256: 'x'.repeat(64) }],          // 缺 src（不是字符串）
      [{ src: 'a/b.md' }, base],                   // 缺 sha256
      [null, base], [base, undefined]
    ];
    cases.forEach(([a, b]) => {
      const byKey = di.originKey(a) !== '' && di.originKey(a) === di.originKey(b);
      expect(byKey).toBe(di.originMatches(a, b));
    });
  });

  it('`--ext`：带不带点都行、去重、非法/导不了的**当场给出理由与支持集**（不静默退成默认）', () => {
    expect(di.normalizeExtList('md,.txt,md')).toEqual({ ok: true, ext: ['.md', '.txt'] });
    expect(di.normalizeExtList('.docx')).toEqual({ ok: true, ext: ['.docx'] });
    const bad = di.normalizeExtList('py, epub');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('py');
    expect(bad.reason).toContain('.md');                 // 支持集整份打出来
    expect(di.normalizeExtList('').ok).toBe(false);       // 裸写 `--ext`（没给值）
    expect(di.IMPORT_EXT_DEFAULT).toEqual(['.md', '.txt', '.docx', '.pdf']);
    // 默认集合必须是"真的导得进来"的子集（否则默认就会把文件全判成读失败）
    di.IMPORT_EXT_DEFAULT.forEach((e) => expect(di.IMPORTABLE_EXT).toContain(e));
  });

  it('★ 上限报文：**说准哪个上限 + 给出路**（不是"文件坏了/内存不够"），且体量上限与单文件**共用一份常量**', () => {
    const many = di.describeTooManyFiles(9999, 200, 'D:/lib');
    expect(many).toContain('超过整库导入上限');
    expect(many).toContain('9999');
    expect(many).toContain('200');
    expect(many).toContain('没有读它们');
    expect(many).toContain('--max-files');            // 出路必须可执行
    expect(many).toContain('--ext md');
    expect(many).not.toMatch(/坏了|损坏|内存不足/);
    const big = di.describeDirOversize('D:/lib', (di.MAX_SOURCE_MB + 40) * 1048576, di.MAX_SOURCE_BYTES);
    expect(big).toContain('超过整库导入上限');
    expect(big).toContain('没有读它们');
    expect(big).toMatch(new RegExp(String(di.MAX_SOURCE_MB)));   // 数字来自常量本身，文档不另抄一份
    expect(big).toContain('import-dir');
  });

  it('目录里没有可导入的文件 ⇒ 响亮拒绝 + 把逐类计数摆出来 + 给出路（**不建空项目**）', () => {
    const root = makeTree({ 'a.png': 'x', 'sub': null });
    try {
      const scan = di.scanImportDir(root, {});
      expect(scan.totals.files).toBe(0);
      const msg = di.describeNoImportableFiles(root, scan);
      expect(msg).toContain('没有一个可导入的文件');
      expect(msg).toContain('没有写任何东西');
      expect(msg).toContain('扩展名不支持');            // 逐类计数摆出来了（不是只说"没有"）
      expect(msg).toContain('--ext');
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('`import-dir` 的目录入参闸门：给**文件** ⇒ 说清"这是文件不是目录" + 点名两条单文件命令', () => {
    const root = makeTree({ 'a.md': '# x\n' });
    try {
      const f = pathx.join(root, 'a.md');
      const p = di.describeImportDirProblem(f);
      expect(p).not.toBe(null);
      expect(p.code).toBe('not-dir');
      expect(p.message).toContain('文件');
      expect(p.message).toContain('不是目录');
      expect(p.message).toContain('import-project');
      expect(p.message).toContain('import-md');
      expect(di.describeImportDirProblem(root)).toBe(null);           // 目录 ⇒ 放行
      // 不存在的路径：原因准确（目录不存在），不是权限问题
      const ghost = di.describeImportDirProblem(pathx.join(osx.tmpdir(), 'mm-none-' + Date.now()));
      expect(ghost.code).toBe('missing');
      expect(ghost.message).toContain('目录不存在');
      expect(ghost.message).not.toMatch(/权限/);
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('★ 走查与建树**都不写盘**（`--dry-run` 的"绝不写盘"靠的就是这一层：它们只读）', () => {
    const root = makeTree({ 'a.md': '# 甲\n', 'sub/b.txt': '正文\n' });
    try {
      const before = [];
      const snap = (dir) => fsx.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = pathx.join(dir, e.name);
        before.push(p + '|' + (e.isDirectory() ? 'd' : fsx.readFileSync(p).length + ':' + fsx.statSync(p).mtimeMs));
        if (e.isDirectory()) snap(p);
      });
      snap(root);
      const scan = di.scanImportDir(root, {});
      di.buildDirImportTree(scan, { at: 'T' });
      const after = [];
      const snap2 = (dir) => fsx.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = pathx.join(dir, e.name);
        after.push(p + '|' + (e.isDirectory() ? 'd' : fsx.readFileSync(p).length + ':' + fsx.statSync(p).mtimeMs));
        if (e.isDirectory()) snap2(p);
      });
      snap2(root);
      expect(after).toEqual(before);          // 条目、字节数、mtime 全不变 ⇒ 没写过任何东西
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });

  it('uniqueIdGen：同一个中文主题连摇 5000 次**一次都不重**（`idGen` 把中文整段压成同一个 base，只剩 4 位随机在区分）', () => {
    const g = di.uniqueIdGen();
    const ids = new Set();
    for (let i = 0; i < 5000; i++) ids.add(g('中文主题'));
    expect(ids.size).toBe(5000);
    expect(g('中文主题')).toMatch(/^[a-z0-9][a-z0-9-]*$/);   // 仍然合 schema 的 id 规范
  });

  it('★ 整库建树整条路上也不重号（真目录夹具；只 20 个目录 —— 强度由上一条纯函数负责，这里只验"这条路真的接上了 uniqueIdGen"）', () => {
    const spec = {};
    for (let i = 0; i < 20; i++) spec['目录' + i + '/第' + i + '章.md'] = '# 第' + i + '章\n正文\n';
    const root = makeTree(spec);
    try {
      const built = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
      const ids = [];
      const collect = (n) => { ids.push(n.id); (n.children || []).forEach(collect); };
      built.children.forEach(collect);
      expect(ids.length).toBe(20 * 3);             // 20 个文件 × (容器 + 文件节点 + 文档标题)
      expect(new Set(ids).size).toBe(ids.length);  // 一个都不许重
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  });
});


