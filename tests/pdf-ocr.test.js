/* ============================================================
 * tests/pdf-ocr.test.js —— P4 Tier0（`src/pdf-ocr.js`）的两侧判据：**该红的**与**不该红的**
 * ------------------------------------------------------------
 * 为什么这份测试必须存在（本批最容易做假的两处，正是它唯二不能省的判据）：
 *   ① 把"未装组件"写成**抛错** —— 一道 `MODULE_NOT_FOUND` 漏给调用方，整份 PDF 导入会以
 *      "异常"形态失败，而调用方拿不到"该提示什么"。⇒ `P4-R2`：**loader 抛错时 loadComponent /
 *      componentInfo / recognizeWith 一个都不许抛**，必须是结构化失败。
 *   ② 质量报告里塞一个 `avgConfidence: 1.0` —— 那是 F4 点名的**假数**
 *      （`@napi-rs/system-ocr@1.2.0` 的 `index.d.ts:22`：「Always 1.0 on Windows.」）。
 *      ⇒ `P4-G5`：报告里除了那张 `confidence:{used:false, why:…}` 说明卡，
 *      **一个带 confidence 字样的键都不许有**（连字符串 `avgConfidence` 都不许出现在报告里）。
 *
 * 两条语言事实（都不是本测试能验的，写在这里防止下一个人误读绿色）：
 *   · **Windows 的 confidence 恒 1.0**（F4）⇒ 本文件里没有任何"置信度阈值"断言；
 *   · **模块只用第一个 preferredLangs**（F5）⇒ `P4-F5` 断言"只传了一个语言"，而不是"中英都认"。
 *     英文串的质量**本机未验证**（本批只验了 zh-Hans-CN）。
 *
 * 注入形态（`loader` 是 `pdf-ocr.js` 的 IO 壳）：全部用**假 loader**，不真 require 原生包
 * （真机那一条在 `.review/20261022-r2E-OCR随包/probe-ocr-real.js`，它才是端到端证据）。
 * 判别力：`P4-R4` 的注入证明做的是"删掉 `loadComponent` 的 try/catch ⇒ 本文件必须变红"，
 * 读数记在 `.review/20261022-r2E-OCR随包/README.md`（**不留在代码里**）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OCR = require('../src/pdf-ocr.js');

const { EXPECTED_VERSION, MODULE_NAME } = OCR;

/* ---------- 假 loader 与小工具 ---------- */

/** 一个"版本对、recognize 由测试给定"的假模块 */
function stubMod(recognize, version) {
  return { version: version === undefined ? EXPECTED_VERSION : version, recognize: recognize };
}

/** 模拟"没装"：Node 的 require 真会抛这个 code */
function throwingLoader() {
  const err = new Error("Cannot find module '" + MODULE_NAME + "'");
  err.code = 'MODULE_NOT_FOUND';
  throw err;
}

/** 把一个对象的**所有键**摊平（用来证明"报告里没有假置信度字段"） */
function allKeys(value, acc) {
  const out = acc || [];
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out);
    return out;
  }
  for (const k of Object.keys(value)) {
    out.push(k);
    allKeys(value[k], out);
  }
  return out;
}

/** 报告里所有"带 confidence 字样"的键 */
function confidenceKeys(value) {
  return allKeys(value).filter((k) => /confidence/i.test(k));
}

const BANNED_CONFIDENCE_KEYS = ['avgConfidence', 'confidenceAverage', 'meanConfidence', 'avg_confidence'];

describe('P4 · 两侧判据（该红的：认错就红）', () => {
  it('P4-R1 · 假 OCR 吐「第 二 章 引言」⇒ joinLines 不留 CJK 之间的空格，行数 = 桩给的行数', async () => {
    // ① 纯函数这一层：CJK 之间（含行内、含行间）都不补空格；非 CJK 之间补一个
    expect(OCR.joinLines([ '第 二 章 引言' ])).toBe('第二章引言');
    expect(OCR.joinLines([ '第 二 章', '引言' ])).toBe('第二章引言');
    expect(OCR.joinLines([ 'proc_fops', 'netlink' ])).toBe('proc_fops netlink');
    expect(OCR.joinLines([ '第二章', 'proc_fops' ])).toBe('第二章 proc_fops');

    // ② 端到端这一层：桩给 1 行 ⇒ 结果就是 1 行，且文本里**一个空白都没有**
    const mod = stubMod(async () => ({
      text: '',
      confidence: 1, // ← 桩故意给 1.0：如果实现把它搬进结果，下面的断言会抓到
      lines: [ { text: '第 二 章 引言', confidence: 1, boundingBox: { x: 0, y: 0, width: 1, height: 1 } } ]
    }));
    const r = await OCR.recognizeWith(() => mod, 'fake.png');
    expect(r.ok).toBe(true);
    expect(r.available).toBe(true);
    expect(r.lines.length).toBe(1);                    // 行数 = 桩给的行数（不是 0、不是按空格切出来的 4）
    expect(r.lines[0].text).toBe('第 二 章 引言');      // 行本身原样保留（规范化发生在拼文本那一层）
    expect(r.text).toBe('第二章引言');
    expect(/[ \t]/.test(r.text)).toBe(false);          // 「第 二」这种 CJK 间空格必须消失
    expect(/第\s+二/.test(r.text)).toBe(false);
    expect(r.pages.length).toBe(1);
    expect(r.pages[0].lines.length).toBe(1);
  });

  it('P4-R2 · loader 抛 MODULE_NOT_FOUND ⇒ 三条入口都不抛，且理由说清"没装"', async () => {
    // ① componentInfo：结构化 + reason 非空
    const info = OCR.componentInfo(throwingLoader);
    expect(info.available).toBe(false);
    expect(typeof info.reason).toBe('string');
    expect(info.reason.length).toBeGreaterThan(0);
    expect(info.reason).toContain('未安装 OCR 组件（3.1 MB）');
    expect(info.reason).toContain(MODULE_NAME);
    expect(info.version).toBe(null);
    expect(info.expected).toBe(EXPECTED_VERSION);

    // ② recognizeWith：**不许抛**（`resolves` 本身就是判据），且是结构化失败
    const pending = OCR.recognizeWith(throwingLoader, 'fake.png');
    await expect(pending).resolves.toBeTruthy(); // 「不抛」这一条判据
    const r = await pending;                     // 再把结果取回来做真断言
    expect(r.ok).toBe(false);
    expect(r.available).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(r.reason).toContain('未安装 OCR 组件（3.1 MB）');
    expect(r.text).toBe('');
    expect(Array.isArray(r.lines)).toBe(true);
    expect(r.lines.length).toBe(0);

    // ③ 组件不可用时"该不该提示 OCR"仍能给出结论（提示判据不依赖组件）
    const g = OCR.shouldSuggestOcr({ ok: false, reason: '扫描页' });
    expect(g.suggest).toBe(true);
    expect(typeof g.reason).toBe('string');
  });

  it('P4-R3 · loader 给 version 0.9.9 ⇒ available false，理由**同时点名** 1.2.0 与 0.9.9', () => {
    const info = OCR.componentInfo(() => ({ version: '0.9.9', recognize: async () => ({}) }));
    expect(info.available).toBe(false);
    expect(info.version).toBe('0.9.9');
    expect(info.expected).toBe('1.2.0');
    expect(info.reason).toContain('1.2.0'); // 期望
    expect(info.reason).toContain('0.9.9'); // 实测
    // 版本不符时连 recognizeWith 也必须是"不可用"，而不是"试试看"
    const lc = OCR.loadComponent(() => ({ version: '0.9.9', recognize: async () => ({}) }));
    expect(lc.ok).toBe(false);
    expect(lc.version).toBe('0.9.9');
  });

  it('P4-G3 · 桩返回空 lines ⇒ 该页标「未识别出文字」、整体继续、ok 仍真', async () => {
    const mod = stubMod(async () => ({ text: '', confidence: 1, lines: [] }));
    const r = await OCR.recognizeWith(() => mod, 'blank.png');
    expect(r.ok).toBe(true);              // 空页不是失败
    expect(r.lines.length).toBe(0);
    expect(r.confidence.used).toBe(false); // 也不许因为有 confidence:1 就去报置信度

    const report = OCR.qualityReport(r.pages);
    expect(report.ok).toBe(true);
    expect(report.pageCount).toBe(1);
    expect(report.pages[0].chars).toBe(0);
    expect(report.pages[0].note).toBe('该页未识别出文字');
    expect(report.emptyPages).toBe(1);
    expect(report.recognizedPages).toBe(0);

    // "整体继续"：空页后面的那一页照样统计，不许整批失败
    const two = OCR.qualityReport([
      { index: 0, text: '', lines: [] },
      { index: 1, text: '第二章', lines: [ '第二章' ] }
    ]);
    expect(two.ok).toBe(true);
    expect(two.pages[0].note).toBe('该页未识别出文字');
    expect(two.pages[1].chars).toBe(3);
    expect(two.pages[1].note).toBe(undefined);
    expect(two.emptyPages).toBe(1);
    expect(two.recognizedPages).toBe(1);
    expect(two.avgCharsPerPage).toBe(1.5); // 3 个非空白字符 / 2 页
  });
});

describe('P4 · 不该红（本来对的行为，别被顺手改坏）', () => {
  it('P4-G1 · 有文字层 ⇒ 永不提示 OCR（即使字符数很大或很小）', () => {
    const a = OCR.shouldSuggestOcr({ ok: true, chars: 3000, pageCount: 30 });
    expect(a.suggest).toBe(false);
    expect(a.reason).toContain('永不提示');
    // 小样本也一样：只要 ok:true 就是"有文字层"
    const b = OCR.shouldSuggestOcr({ ok: true, chars: 5, pageCount: 1 });
    expect(b.suggest).toBe(false);
    // 页数/字符数没给也不许变成 suggest
    expect(OCR.shouldSuggestOcr({ ok: true }).suggest).toBe(false);
  });

  it('P4-G2 · ok:false ⇒ 提示；拿不到判据（undefined / 非布尔 ok）⇒ 不提示 + 说清为什么', () => {
    const broken = OCR.shouldSuggestOcr({ ok: false });
    expect(broken.suggest).toBe(true);
    expect(typeof broken.reason).toBe('string');

    const missing = OCR.shouldSuggestOcr(undefined);
    expect(missing.suggest).toBe(false);
    expect(typeof missing.reason).toBe('string');
    expect(missing.reason.length).toBeGreaterThan(0);
    expect(missing.reason).toContain('不假装能判');

    expect(OCR.shouldSuggestOcr(null).suggest).toBe(false);
    expect(OCR.shouldSuggestOcr('有文字').suggest).toBe(false);
    const noBool = OCR.shouldSuggestOcr({ chars: 100 }); // ok 字段都没有 = 判不了
    expect(noBool.suggest).toBe(false);
    expect(noBool.reason.length).toBeGreaterThan(0);
  });

  it('P4-G4 · 质量报告数值现算对得上（两页已知字符/CJK 数）', () => {
    const pages = [
      { index: 0, text: '中文abc', lines: [ '中文abc' ] },      // 5 个非空白字符，2 个 CJK
      { index: 1, text: '网络协议栈', lines: [ '网络协议栈', '' ] } // 5 个，5 个 CJK，1 个空行
    ];
    const rep = OCR.qualityReport(pages);

    // 期望值在测试里**自己算**（不调产品同一个函数去算期望）
    expect(rep.ok).toBe(true);
    expect(rep.pageCount).toBe(2);
    expect(rep.chars).toBe(10);
    expect(rep.cjk).toBe(7);
    expect(rep.nonCjk).toBe(3);
    expect(rep.lineCount).toBe(3);
    expect(rep.blankLines).toBe(1);
    expect(rep.recognizedPages).toBe(2);
    expect(rep.emptyPages).toBe(0);
    expect(rep.cjkRatio).toBeCloseTo(7 / 10, 12);
    expect(rep.nonCjkRatio).toBeCloseTo(3 / 10, 12);
    expect(rep.avgCharsPerPage).toBe(5);           // 10 / 2

    expect(rep.pages[0].chars).toBe(5);
    expect(rep.pages[0].cjk).toBe(2);
    expect(rep.pages[0].cjkRatio).toBeCloseTo(2 / 5, 12);
    expect(rep.pages[0].nonCjkRatio).toBeCloseTo(3 / 5, 12);
    expect(rep.pages[0].lineCount).toBe(1);
    expect(rep.pages[0].blankLines).toBe(0);

    expect(rep.pages[1].chars).toBe(5);
    expect(rep.pages[1].cjkRatio).toBeCloseTo(1, 12);
    expect(rep.pages[1].lineCount).toBe(2);
    expect(rep.pages[1].blankLines).toBe(1);

    // 分母口径必须自己说出来（否则"占比"是个没法复核的数）
    expect(rep.basis).toContain('非空白字符');
  });

  it('P4-G5 · 与文字层字符数之比只在给了才算；报告里没有假置信度字段', () => {
    const pages = [ { index: 0, text: '中文abc', lines: [ '中文abc' ] } ];

    const noLayer = OCR.qualityReport(pages);
    expect(noLayer.textLayer).toBe(null); // 没给 ⇒ 不假装比过

    const withLayer = OCR.qualityReport(pages, { textLayerChars: 100 });
    expect(withLayer.textLayer.chars).toBe(100);
    expect(withLayer.textLayer.ocrChars).toBe(5);
    expect(withLayer.textLayer.ratio).toBeCloseTo(5 / 100, 12); // 现算 0.05

    // 文字层 0 字符 ⇒ 比值没有意义，不编一个 0 出来
    const zeroLayer = OCR.qualityReport(pages, { textLayerChars: 0 });
    expect(zeroLayer.textLayer.ratio).toBe(null);

    // ⭐ F4：报告里只能有那张"为什么没有置信度"的说明卡
    expect(withLayer.confidence.used).toBe(false);
    expect(withLayer.confidence.why).toContain('恒 1.0');
    expect(withLayer.confidence.why).toContain('index.d.ts:22');
    expect(confidenceKeys(withLayer)).toEqual([ 'confidence' ]); // 除它以外一个都没有
    for (const bad of BANNED_CONFIDENCE_KEYS) {
      expect(JSON.stringify(withLayer)).not.toContain(bad);
    }
  });

  it('P4-F5 · opts.langs 只把第一个传给组件（F5），其余如实回传为"被忽略"', async () => {
    const calls = [];
    const mod = stubMod(async (img, accuracy, langs) => {
      calls.push({ img, accuracy, langs });
      return { text: '第二章', lines: [ { text: '第二章' } ] };
    });
    const r = await OCR.recognizeWith(() => mod, 'fake.png', { langs: [ 'zh-cn', 'en-US' ] });
    expect(r.ok).toBe(true);
    expect(r.langsUsed).toEqual([ 'zh-cn' ]);
    expect(r.langsIgnored).toEqual([ 'en-US' ]);
    expect(calls.length).toBe(1);
    expect(calls[0].langs).toEqual([ 'zh-cn' ]); // 模块只收到一个语言
    expect(r.langsNote).toContain('未验证');      // 被忽略的语言 = 质量未验证，必须说

    // 默认语言就是 zh-cn（不传 opts 时）
    const r2 = await OCR.recognizeWith(() => mod, 'fake.png');
    expect(r2.langsUsed).toEqual([ 'zh-cn' ]);
    expect(r2.langsIgnored).toEqual([]);
  });

  it('P4-S1 · 无参 componentInfo() 走真 loader：形状固定，且绝不抛', () => {
    // 不给 loader ⇒ 真机现读。**只断言形状**（装没装是环境事实，不在这里断言，
    // 真机读数在 .review/20261022-r2E-OCR随包/probe-ocr-real.js）。
    const info = OCR.componentInfo();
    expect(typeof info.available).toBe('boolean');
    expect(typeof info.reason).toBe('string');
    expect(info.reason.length).toBeGreaterThan(0);
    expect(info.expected).toBe(EXPECTED_VERSION);
    expect(info.version === null || typeof info.version === 'string').toBe(true);
  });
});
