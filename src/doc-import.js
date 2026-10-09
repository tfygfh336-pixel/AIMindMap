/* ============================================================
 * src/doc-import.js —— 大文档 → 新项目树的**转换前端**（功能 5a）
 * ------------------------------------------------------------
 * 设计：**一个建树入口，三种前端**。md / txt / docx 都先变成"带 `#` 的 Markdown 提纲"，
 * 再统一交给 `src/markdown.js` 的 `markdownToTree` 建树 —— 只有一套树构建逻辑，
 * 不会出现"txt 导入的树和 md 导入的树结构规则不一样"这种漂移 ✓
 *
 * ⚠️ **本文件不许出现异步 API**：它挂在 CLI 命令的依赖闭包里，而
 * `tests/cli-sync-invariant.test.js` 要求 CLI 命令同步完成（`cli/main.js` 的 invokeSync 依赖它）。
 *
 * docx 为什么自己解（不引依赖）：本工程**零运行时依赖**是硬约束（见 RULES / 08 的 D1）。
 * docx 就是一个 zip + 一份 `word/document.xml`：zip 的 deflate 用 node 自带的 zlib 就能解 ✓
 * ⇒ 大约 100 行换掉一个依赖，划算；且**边界要写明**（见 §docx 注释）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ================= ① 格式识别 ================= */
/** **认识但不支持**的格式：必须响亮拒绝，绝不落到"当 txt 读"的兜底里 ✗
 *（否则二进制的原文会被当正文导进树 —— 看着"导入成功"、内容全是乱码，
 *  正是本工程最忌讳的"静默给出错误结果"。.doc/.epub 等的真支持要新增解析器，仍未批准 ✗） */
const UNSUPPORTED = ['.doc', '.epub', '.rtf', '.odt', '.xlsx', '.xls', '.pptx', '.ppt', '.html', '.htm'];

/** 按扩展名 + 内容眉眼识别（返回 'md' | 'txt' | 'docx' | null；**不认识就 null**，由调用方响亮报错 ✓） */
function detectFormat(filePath, buf) {
  const ext = String(path.extname(filePath || '')).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';   // PDF：有书签走书签、无书签走文字层（见 §④）✓
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt' || ext === '.text') return 'txt';
  if (UNSUPPORTED.indexOf(ext) >= 0) return null;      // 认识但不管 ⇒ null（调用方按扩展名给出更准的提示）
  // 没有/不认识扩展名：看内容（zip 魔数 PK\x03\x04 ⇒ docx；`#` 开头 ⇒ md；其余当 txt）
  const b = buf || Buffer.alloc(0);
  if (b.length > 4 && b.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';   // 没扩展名也认得出来 ✓
  if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'docx';
  if (/^\s*#{1,6}\s+\S/m.test(b.toString('utf8', 0, Math.min(b.length, 4096)))) return 'md';
  if (b.length) return 'txt';
  return null;
}

/* ================= ② txt → 提纲（启发式，边界写在这里） =================
 * 判据（全部满足才算标题）：短（≤40 字）、**前后是空行**（或文件开头）、不以句末标点结尾、
 * 不像列表项/网址、且**不带逗号**（一句话里带逗号的通常是正文 ✗）。
 * 层级来自编号样式：`第一章`/`1.`/`一、` ⇒ 1 级；`1.1`/`（一）` ⇒ 2 级；`1.1.1` ⇒ 3 级；其余 2 级。
 * ⚠️ 这是**尽力而为**的启发式：认不出的标题就是正文（不会丢内容，只会少一层结构）。
 *    使用者不满意可以直接改树，或者用"或者你可以直接向我描述要导入什么"那条路让 AI 重新组织 ✓
 */
const RE_HEAD_CN_CHAPTER = /^(第\s*[0-9一二三四五六七八九十百]+\s*[章篇部卷节])/;
const RE_NUM_DOTTED = /^(\d+(?:\.\d+){0,3})[.、）)]?\s+\S/;
const RE_CN_NUM = /^([一二三四五六七八九十]+)[、.）)]\s*\S/;
const RE_PAREN_NUM = /^[（(]\s*(\d+|[一二三四五六七八九十]+)\s*[）)]\s*\S/;
const RE_LIST_OR_URL = /^(\s*[-*+•]\s|https?:\/\/|\|)/;

function looksLikeHeading(line, prevBlank, nextBlank, atStart) {
  const t = String(line || '').trim();
  if (!t || t.length > 40) return false;
  if (!(prevBlank || atStart) || !nextBlank) return false;
  if (/[。！？!?；;：:,，]$/.test(t)) return false;      // 句末标点/逗号 ⇒ 正文
  if (RE_LIST_OR_URL.test(t)) return false;
  // 必须有"标题相"：编号、或很短（≤ 24 字）且不带句读
  if (RE_HEAD_CN_CHAPTER.test(t) || RE_NUM_DOTTED.test(t) || RE_CN_NUM.test(t) || RE_PAREN_NUM.test(t)) return true;
  return t.length <= 24 && !/[，。；：]/.test(t);
}

function headingLevelOf(line) {
  const t = String(line || '').trim();
  const m1 = t.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*[章篇部卷]/);
  if (m1) return 1;
  const m2 = t.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*节/);
  if (m2) return 2;
  const m3 = t.match(RE_NUM_DOTTED);
  if (m3) return Math.min(4, m3[1].split('.').length + (t.indexOf('.') > 0 ? 0 : 0));   // 1 → 1 级；1.1 → 2 级
  if (RE_CN_NUM.test(t)) return 1;
  if (RE_PAREN_NUM.test(t)) return 2;
  return 2;
}

/** txt → 提纲 Markdown（标题前加 `#`，正文原样保留在标题下） */
function textToOutline(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const prevBlank = i === 0 ? true : raw[i - 1].trim() === '';
    const nextBlank = i === raw.length - 1 ? true : raw[i + 1].trim() === '';
    if (looksLikeHeading(line, prevBlank, nextBlank, i === 0)) {
      const lv = Math.max(1, Math.min(6, headingLevelOf(line)));
      out.push('#'.repeat(lv) + ' ' + line.trim());
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/* ================= ③ docx → 提纲 =================
 * 最小 zip 读取器：只支持**无加密、非 ZIP64** 的条目（Word 产出的小文件都在此列），
 * 支持 stored(0) 与 deflate(8) 两种压缩。遇 ZIP64/加密 ⇒ **响亮抛错**（不猜、不静默给空 ✓）。
 */
const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

function zipFindEntry(buf, wantName) {
  if (!buf || buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error('这个 docx 用了 ZIP64（本工程的最小 zip 读取器不支持）⇒ 请另存为普通 docx');
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wantName) {
      if (buf.readUInt16LE(off + 8) & 0x1) throw new Error('这个 docx 的条目是加密的（读不了）');
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOC) throw new Error('docx 的 zip 结构不对（本地头找不到）');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('docx 里用了不支持的压缩方法: ' + method);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

function decodeEnt(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** document.xml → [{text, level}]（level=0 表示正文段） */
function docxParagraphs(xml) {
  const out = [];
  const paras = String(xml).split(/<w:p[ >]/).slice(1);
  for (const p of paras) {
    const styleM = p.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    let level = 0;
    if (styleM) {
      const v = styleM[1];
      const hm = v.match(/^(?:Heading|heading|\u6807\u9898)\s*([1-9])$/);
      if (hm) level = Math.min(6, Number(hm[1]));
      else if (/^(?:Heading|heading)/.test(v)) level = 1;
    }
    let text = '';
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(p))) text += decodeEnt(m[1]);
    text = text.replace(/\s+$/, '');
    if (text.trim() || level) out.push({ text: text, level: level });
  }
  return out;
}

/** docx 段落 → 提纲 Markdown */
function docxToOutline(paras) {
  const out = [];
  for (const p of paras) {
    const t = p.text.trim();
    if (!t) { out.push(''); continue; }
    out.push(p.level ? ('#'.repeat(p.level) + ' ' + t) : t);
  }
  return out.join('\n');
}

/* ================= ④ 统一入口：文件 → 提纲 + 统计 ================= */
/**
 * @returns {{format:string, md:string, stats:{chars:number, lines:number, headings:number, levelCounts:object}}}
 */
function docToOutline(filePath, opts) {
  const o = opts || {};
  const buf = o.buf || fs.readFileSync(filePath);
  const format = detectFormat(filePath, buf);
  if (!format) {
    const ext = String(path.extname(filePath || '')).toLowerCase();
    if (UNSUPPORTED.indexOf(ext) >= 0) {
      throw new Error('暂不支持 ' + ext + '：现在支持 .md / .txt / .docx / .pdf'
        + '（PDF 有书签走书签、**无书签走文字层**；目录页页码树 / 多书自动判定 / OCR 仍未做）'
        + '；也可以先把文件转成 .md/.txt 再导入，或把内容贴给内置 AI 让它整理后导入');
    }
    throw new Error('认不出这个文件的格式（支持 .md / .txt / .docx / .pdf）：' + filePath
      + '；PDF 有书签走书签、**无书签走文字层**（.pdf 里的目录页页码树 / 多书自动判定 / OCR 仍未做）');
  }
  let md;
  let pdfInfo = null, pdfPages = null;
  if (format === 'md') md = buf.toString('utf8');
  else if (format === 'pdf') {
    const r = pdfOutlineViaHelper(filePath);
    md = r.md;
    // 如实标注这份 PDF 走的是哪条路（书签 / 文字层）+ 沿途的如实报告（疑似扫描页、剔掉的页眉页脚…）——
    // 使用者必须能看见"这份树是从哪来的" ✓ 不许静默 ✗
    pdfInfo = { source: r.pdfSource, notes: r.notes };
    pdfPages = r.pages;
  }
  else if (format === 'txt') md = textToOutline(buf.toString('utf8'));
  else {
    const xml = zipFindEntry(buf, 'word/document.xml');
    if (!xml) throw new Error('这个 docx 里没有 word/document.xml（不是 Word 文档？）');
    md = docxToOutline(docxParagraphs(xml.toString('utf8')));
  }
  md = md.replace(/\r\n?/g, '\n');
  // ⚠️ **剥掉 BOM**：Windows 上编出来的 md/txt 极常带 BOM，而它会让**首行的 `#` 匹配不上**
  // ⇒ 第一个标题被当成正文吞掉、整棵树少一层（实测踩到：一个带 BOM 的 md 导入后
  //    顶层主题变成合成的「（层级2）」✗）。用户导入的文件不在我们的编码门禁范围内，
  //    所以这里必须自己容错 ✓
  if (md.charCodeAt(0) === 0xfeff) md = md.slice(1);
  return finishOutline(format, md, pdfPages, pdfInfo);
}

/** 提纲收口（md → {format, md, stats}）：两条入口（同步 / 异步）共用同一套统计口径 ✓ */
function finishOutline(format, md, pages, extra) {
  const lines = md.split('\n');
  const levelCounts = {};
  let headings = 0;
  for (const l of lines) {
    const m = l.match(/^(#{1,6})\s+\S/);
    if (m) { headings++; levelCounts[m[1].length] = (levelCounts[m[1].length] || 0) + 1; }
  }
  const out = { format: format, md: md, stats: { chars: md.length, lines: lines.length, headings: headings, levelCounts: levelCounts } };
  if (Array.isArray(pages)) out.pages = pages;
  // PDF 专有：来源（书签 / 文字层）与如实报告，交给命令层打印（不静默 ✗）
  if (extra && extra.source) for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

/* ================= ④ PDF → 提纲（P8 书签 ✓ / P0 文字层 ✓） =================
 * 两条路，**先书签后文字层**（都在同一个小进程里做，见下）：
 *   ① `getOutline()` 有书签 ⇒ 书签树 → `#` 标题提纲（P8 ✓；顶层书签多于一个 = 一个文件多棵树 ✓）；
 *   ② 没有书签 ⇒ 回退到**文字层**（P0 ✓）：`src/pdf-text.js` 把 TextItem 变成行/段/标题层级，
 *      再拼成同一份 `#` 提纲 ⇒ 建树仍然只有一处（`src/markdown.js`）✓。
 * 明确不做（仍未批准 ✗）：目录页 → 页码树 / 页码 ↔ 物理页偏移（P2）、多书自动判定（P3）、OCR（P4）。
 * 两样都拿不到 ⇒ **响亮拒绝**（带数字 + 出路），绝不静默给半棵树 ✗。

/** 同步读 PDF 提纲：**起一个小进程**（scripts/pdf-outline-helper.mjs）去 await ✓ ——
 *  为什么不在本进程里 await：`cli/commands/*` 有硬不变量"命令体必须同步完成"（见 cli/main.js 的守卫与
 *  tests/cli-sync-invariant.test.js），而 pdf.js 的 API 是异步的 ✗。小进程把异步收在它自己那边 ✓。
 *  失败一律**响亮**（把子进程给出的原因原样抛出 ✓ 不静默、不返回半棵树 ✗）。 */
function pdfOutlineViaHelper(filePath) {
  const helper = path.join(__dirname, '..', 'scripts', 'pdf-outline-helper.mjs');
  const r = require('child_process').spawnSync(process.execPath, [helper, filePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out.split('\n').pop()); } catch (e) { parsed = null; }
  if (!parsed) throw new Error('读 PDF 的子进程没有给出结果（exit=' + r.status + '）：' + (out || String(r.stderr || '').trim()).slice(0, 200));
  if (!parsed.ok) throw new Error(parsed.error || '读 PDF 失败（未说明原因）');
  return { md: parsed.md, pages: parsed.pages, pdfSource: parsed.source === 'text' ? 'text' : 'outline', notes: parsed.notes || [] };
}
module.exports = {
  detectFormat, textToOutline, looksLikeHeading, headingLevelOf,
  zipFindEntry, docxParagraphs, docxToOutline, docToOutline, finishOutline
};
