/* ============================================================
 * src/pdf-ocr.js —— P4 · Tier0：**系统 OCR 组件的唯一入口 + 质量口径**（Node 侧，纯逻辑 + 注入式 IO 壳）
 * ------------------------------------------------------------
 * 它是什么：把「本机到底有没有 OCR 组件、能不能用、认出来什么、认得好不好」这四件事收成一处：
 *   `componentInfo(loader)` / `loadComponent(loader)` / `recognizeWith(loader, img, opts)`
 *   / `joinLines(lines)` / `qualityReport(pages, opts)` / `shouldSuggestOcr(textLayer)`。
 * 它不是什么：
 *   · **本模块不接线** —— 不认识 PDF、不认识界面。「扫描页要不要 OCR、按钮怎么出现、几时调」
 *     属于 **P4 界面层（另批）**；本批只交「判据 + 质量口径」，接线是另一批的事。
 *   · **不做任何写盘**：全文件没有 `fs`、没有 `writeFileSync`、没有临时文件 —— 临时图由调用方管
 *     （本批的真图探针在 `.review/20261022-r2E-OCR随包/probe-ocr-real.js`，它自己 `finally` 删图）。
 *   · 不是 UMD 双端：与 `src/doc-import.js` / `src/item-src.js` 同一类 **Node-only**（`docs/ARCHITECTURE.md`
 *     §8.4 已承认这一类）。理由很硬：它运行时 `require` 一个 **N-API 原生包**，浏览器端根本没有这条路。
 *
 * 为什么要有它（依据 `.review/20261026-PDF-P1P4方案/拍板.md`）：
 *   拍板 ① = **随包** `@napi-rs/system-ocr@1.2.0`（3.1 MB），不用「点了才下载」；
 *   Tier1（ONNX 8–15 人日）**不做**。而随包之后，"装没装"不再是产品决定，而是一个**运行时读数**
 *   ⇒ 必须有一处把它读出来并**响亮**地说，否则"没装"会以"抛错"的形态炸掉整条导入链 ✗。
 *
 * 三条已知实测事实（照它们设计，**别凭直觉改**）：
 *   F4 · **Windows 上 `confidence` 恒 1.0**（`@napi-rs/system-ocr/index.d.ts:22` 原文
 *        「Always 1.0 on Windows.」；`:31` 再写一次）⇒ 计划里的「平均置信度」是**假数**。
 *        ⇒ 本模块的质量报告**只有** `confidence:{used:false, why:…}`，**一个聚合置信度字段都没有**
 *          （`avgConfidence` / `confidenceAverage` 这类键在本文件里连字符串都不出现），
 *          质量改用可复核的**结构量**：字符数 / 行数 / CJK 与非 CJK 占比 / 空行数 / 空页 / 与文字层字符数之比。
 *   F5 · 它**只用第一个 `preferredLangs`**（`index.d.ts:46`：「On Windows, only the first language is used.」）
 *        ⇒ 不能"中英同时要"。本模块默认 `['zh-cn']`，并**如实回传** `langsUsed` / `langsIgnored`
 *          —— 被忽略的那些语言，质量**没有验证过**，调用方要照实显示。
 *   F7 · `powershell.exe` 冷启 261 ms —— 本路线**不走** PowerShell 桥（直接调 N-API），
 *        所以那 261 ms 在成本表里**不存在**；这条只在报告里提一句，不进本文件的任何常量。
 *
 * 可注入的 IO 壳（判据必须能被假读数打红）：
 *   `loader` 是个**函数**，返回"像 `@napi-rs/system-ocr` 的模块对象"。默认值 `defaultLoader()` 才是真
 *   `require`（**惰性**：只有真调到才 require）。单测注入 `() => ({version:'0.9.9'})` 或
 *   `() => { throw new Error(...) }` 就能分别证明"版本不符"与"没装"两条路径 —— 这正是本模块唯一的
 *   判别力来源：**抛错不许漏到调用方**（`P4-R2`）。
 *
 * 边界（如实写明，别当已实现）：
 *   · **Windows 的 `confidence` 不可用**（F4）⇒ 不报、不算、不做阈值；
 *   · **单语言**（F5）⇒ 选 `zh-cn` 时**英文串质量未验证**（本机只验了 `zh-Hans-CN`；英文一行只做"非空"级核对）；
 *   · `accuracy` 在 Windows 上被忽略（`index.d.ts:45`）⇒ 传下去但**不据此推断质量**；
 *   · 一张图 = 一页。多页 PDF 的逐页驱动在界面层（本批不接线）。
 * ============================================================ */
'use strict';

/** 组件名（唯一一处；`require`、报错文案、文档都指它） */
const MODULE_NAME = '@napi-rs/system-ocr';

/** 随包锁定的版本（`package.json` 的 `dependencies` 必须恰好是这个值 —— 见 `.review/20261022-r2E-OCR随包/README.md`） */
const EXPECTED_VERSION = '1.2.0';

/**
 * F4 的唯一表达：**报告里没有置信度这个数**，只有这句话。
 * 冻结它（不许调用方改写）—— `why` 原文就是 `index.d.ts:22` 那句话的中文直译 + 出处。
 */
const CONFIDENCE_NOTE = Object.freeze({
  used: false,
  why: 'Windows 上恒 1.0（index.d.ts:22）—— 报它等于撒谎',
  source: '@napi-rs/system-ocr@1.2.0 index.d.ts:22「/** Always 1.0 on Windows. */」',
  instead: '改用可复核的结构量：字符数 / 行数 / CJK 与非 CJK 占比 / 空行数 / 空页 / 与文字层字符数之比'
});

/* ---------- 字符分类（CJK 判据的唯一一处）----------
 * 只认"中日韩文字与全角标点"这几段；拉丁/数字/半角标点一律算非 CJK。
 * 为什么不用 `\p{Script=Han}`：本工程要在最朴素的 node 上跑，且**范围表是可读的一行一行**，
 * 谁想加一段（比如日文假名已经有了）都能直接看出改的是哪一段。 */
const CJK_RANGES = Object.freeze([
  [0x2e80, 0x2eff], // CJK 部首补充
  [0x3000, 0x303f], // CJK 符号与标点（、。「」《》等）
  [0x3040, 0x30ff], // 平假名 / 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xff00, 0xff60], // 全角 ASCII / 全角标点
  [0xffe0, 0xffe6]  // 全角符号
]);

/** 这个码点算不算 CJK（判据唯一实现；`countStats` 与 `collapseCjkSpaces` 都调它） */
function isCjk(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  for (let i = 0; i < CJK_RANGES.length; i++) {
    if (cp >= CJK_RANGES[i][0] && cp <= CJK_RANGES[i][1]) return true;
  }
  return false;
}

/** 空白（含全角空格 U+3000 与不换行空格 U+00A0 —— OCR 都吐过） */
function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
    || ch === '\u00a0' || ch === '\u3000' || ch === '\ufeff';
}

/**
 * 把一段文本里的空白**规范化**：
 *   · 连续空白压成一个半角空格；
 *   · **CJK 与 CJK 之间的空白整段删掉** —— 中文本来不用空格分词，
 *     而系统 OCR 会在字间吐空格（实测形态：`第 二 章 引言`）⇒ 不删就是错字。
 *   · CJK 与拉丁/数字之间**保留**一个空格（`中文 abc` 该有空格，删了反而粘连）。
 */
function collapseCjkSpaces(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!isSpaceChar(ch)) {
      out += ch;
      continue;
    }
    let j = i;
    while (j < s.length && isSpaceChar(s[j])) j++;
    const prev = out.length ? out[out.length - 1] : '';
    const next = j < s.length ? s[j] : '';
    if (prev && next && isCjk(prev) && isCjk(next)) {
      i = j - 1; // 整段空白丢掉
      continue;
    }
    out += ' ';
    i = j - 1;
  }
  return out.trim();
}

/** 一行可能是 `'文本'` 也可能是模块给的 `{text, confidence, boundingBox}` —— 两种都认 */
function textOfLine(line) {
  if (typeof line === 'string') return line;
  if (line && typeof line.text === 'string') return line.text;
  return '';
}

/**
 * `joinLines(lines) → string`
 *   · 行内：走 `collapseCjkSpaces`（CJK 之间的空格删掉）；
 *   · 行间：**两侧端点都是 CJK 就不补空格**，否则补**一个**空格；
 *   · 空行直接跳过（它不是一个字）。
 * 为什么行间也要判：OCR 按行切，`第 二 章` 与 `引言` 常常被切成两行 —— 补空格就是"第二章 引言"，
 * 而正确形态是"第二章引言"（中文标题里没有这个空格）。
 */
function joinLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const parts = [];
  for (let i = 0; i < arr.length; i++) {
    const t = collapseCjkSpaces(textOfLine(arr[i]));
    if (t) parts.push(t);
  }
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) { out = parts[i]; continue; }
    const prev = out[out.length - 1];
    const next = parts[i][0];
    out += (isCjk(prev) && isCjk(next) ? '' : ' ') + parts[i];
  }
  return out;
}

/**
 * 结构量统计（**质量指标的唯一实现** —— 分母口径写死在这里，报告里也回传 `basis`）：
 *   `chars` = **非空白字符**数（空格不做分母：OCR 的空格形态本来就不可靠）
 *   `cjk` / `nonCjk` 按 `isCjk` 分；`charsRaw` 是含空白的长度（只作对照）。
 */
function countStats(text) {
  const s = String(text == null ? '' : text);
  let chars = 0;
  let cjk = 0;
  for (const ch of s) { // 按码点走（代理对不会被拆成两个）
    if (isSpaceChar(ch)) continue;
    chars++;
    if (isCjk(ch)) cjk++;
  }
  return { chars: chars, cjk: cjk, nonCjk: chars - cjk, charsRaw: s.length };
}

/* ---------- IO 壳：真 loader 与版本解析 ---------- */

/**
 * 真 loader：**惰性** `require`。
 * 单独成函数是为了让"它被调到"这件事可注入、可替换（单测永不走到这里）。
 * 它**不 try/catch** —— 守卫在 `loadComponent` 那一层（**唯一一处**，`P4-R4` 的注入点就是它）。
 */
function defaultLoader() {
  return require(MODULE_NAME);
}

/**
 * 版本解析：模块对象自己有 `version` 就用它；否则**现读它自己的 `package.json`**。
 * ⚠️ 实测事实：`@napi-rs/system-ocr@1.2.0` 的 `index.js` **只导出** `recognize` / `OcrAccuracy` /
 *    `RecognizeTask`，**没有 `version`**（本批 `node … backup-pkg.js verify` 现读）。
 *    ⇒ "只看 `mod.version`"会在这台机器上读出 `null`，把"装好了"误判成"没装" ✗。
 *    所以第二条路必须存在；但它**只在第一条路没有时**才走（注入 `{version:'0.9.9'}` 的测试不会走到这里）。
 */
function resolveVersion(mod) {
  if (mod && typeof mod.version === 'string' && mod.version) return mod.version;
  const pkg = require(MODULE_NAME + '/package.json');
  if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  throw new Error('模块与它的 package.json 都没有 version 字段');
}

function missingReason(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : String(err);
  return '未安装 OCR 组件（3.1 MB）：找不到 ' + MODULE_NAME
    + '（随包分发，`dependencies` 里锁定 ' + EXPECTED_VERSION + '，`npm install` 之后才在盘上）。'
    + '原始错误：' + (code ? code + ' / ' : '') + msg;
}

function mismatchReason(version, note) {
  return 'OCR 组件版本不符：期望 ' + EXPECTED_VERSION + '（随包锁定），实测 '
    + (version ? version : '读不到' + (note ? '（' + note + '）' : ''))
    + '。本模块只按 ' + EXPECTED_VERSION + ' 的接口写（recognize(path, accuracy, langs)）'
    + ' ⇒ 版本不对时**宁可不可用**，也不猜接口能不能用。';
}

/**
 * `loadComponent(loader) → {ok, mod, reason, version}`
 * 内部用；**绝不抛**。三条失败路径各自有话说：没装 / 版本不符 / 装了但没有 `recognize`。
 * 「不许抛」是 `P4-R2` 的判据：一道 `require` 的 `MODULE_NOT_FOUND` 若漏到调用方，
 * 整份导入会以"异常"形态失败，而调用方拿不到"该提示什么"。
 */
function loadComponent(loader) {
  const ld = typeof loader === 'function' ? loader : defaultLoader;
  let mod = null;
  /* [R2-守卫] 下面这个 try/catch 是 P4-R2 的注入点：删掉它，loader 抛错就会漏给调用方。
   * `P4-R4` 的注入证明做的正是这件事（删 ⇒ 变红 ⇒ 用 Buffer 逐字节还原）。 */
  try {
    mod = ld();
  } catch (err) {
    return { ok: false, mod: null, version: null, reason: missingReason(err) };
  }
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
    return {
      ok: false, mod: null, version: null,
      reason: 'OCR 组件加载器没有返回模块对象（拿到 ' + (mod === null ? 'null' : typeof mod) + '）'
    };
  }
  let version = null;
  let versionNote = '';
  try {
    version = resolveVersion(mod);
  } catch (err) {
    version = null;
    versionNote = err && err.message ? String(err.message) : String(err); // 响亮：下面会带进 reason
  }
  if (version !== EXPECTED_VERSION) {
    return { ok: false, mod: mod, version: version, reason: mismatchReason(version, versionNote) };
  }
  if (typeof mod.recognize !== 'function') {
    return {
      ok: false, mod: mod, version: version,
      reason: 'OCR 组件 ' + MODULE_NAME + '@' + version + ' 版本对，但没有导出 `recognize` 函数'
        + '（拿到 ' + typeof mod.recognize + '）⇒ 不能按本模块的接口调它'
    };
  }
  return {
    ok: true, mod: mod, version: version,
    reason: 'OCR 组件可用：' + MODULE_NAME + '@' + version + '（随包 3.1 MB，走系统 OCR，不经 PowerShell 桥）'
  };
}

/**
 * `componentInfo(loader) → {available, reason, version, expected}`
 * 给界面/CLI 的一句读数。**无参时用真 loader（真机现读）**。
 * 版本不符 ⇒ `available:false`，且 reason **同时点名**期望版本与实测版本（`P4-R3`）。
 */
function componentInfo(loader) {
  const r = loadComponent(loader);
  return {
    available: r.ok === true,
    reason: r.reason,
    version: r.version == null ? null : r.version,
    expected: EXPECTED_VERSION
  };
}

/* ---------- 识别 ---------- */

function recognizeFailure(reason, extra) {
  const out = {
    ok: false,
    available: extra && extra.available === true,
    reason: reason,
    text: '',
    rawText: '',
    lines: [],
    pages: [],
    langsUsed: extra && extra.langsUsed ? extra.langsUsed : ['zh-cn'],
    langsIgnored: extra && extra.langsIgnored ? extra.langsIgnored : [],
    version: extra && extra.version != null ? extra.version : null,
    confidence: Object.assign({}, CONFIDENCE_NOTE)
  };
  return out;
}

/**
 * `recognizeWith(loader, imagePathOrBuffer, opts) → Promise<{ok, available, reason, text, lines, pages, …}>`
 *
 *   · 内部调 `mod.recognize(path, accuracy, langs)`（**3 个位置参数**，与 `index.d.ts:49` 一致）；
 *   · `opts.langs` 默认 `['zh-cn']`，**只用第一个**（F5），其余如实回传在 `langsIgnored`；
 *   · **失败/不可用一律返回结构化失败**（`ok:false` + 非空 `reason`），**绝不抛**；
 *   · `opts.accuracy` 只在是数字时透传（Windows 上被忽略 —— F4 的邻居事实，`index.d.ts:45`）。
 *
 * 返回里**没有**任何置信度数字：`confidence` 那个键是一张"为什么没有置信度"的说明卡（F4）。
 */
async function recognizeWith(loader, imagePathOrBuffer, opts) {
  const o = opts || {};
  const langs = Array.isArray(o.langs) && o.langs.length
    ? o.langs.filter((x) => typeof x === 'string' && x)
    : [ 'zh-cn' ];
  const useLangs = langs.length ? langs : [ 'zh-cn' ];
  const langsUsed = [ useLangs[0] ];
  const langsIgnored = useLangs.slice(1);

  const info = loadComponent(loader);
  if (!info.ok) {
    return recognizeFailure(info.reason, {
      available: false, version: info.version, langsUsed: langsUsed, langsIgnored: langsIgnored
    });
  }
  if (!imagePathOrBuffer) {
    return recognizeFailure('没有给图片：需要一个文件路径或 Buffer（相对路径也行，但本模块不解析它）', {
      available: true, version: info.version, langsUsed: langsUsed, langsIgnored: langsIgnored
    });
  }

  const accuracy = typeof o.accuracy === 'number' ? o.accuracy : undefined;
  let res = null;
  try {
    res = await info.mod.recognize(imagePathOrBuffer, accuracy, langsUsed);
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const msg = err && err.message ? String(err.message) : String(err);
    return recognizeFailure('OCR 调用失败（组件可用，是这一次识别没成）：'
      + (code ? code + ' / ' : '') + msg, {
      available: true, version: info.version, langsUsed: langsUsed, langsIgnored: langsIgnored
    });
  }

  const rawLines = res && Array.isArray(res.lines) ? res.lines : [];
  const lines = rawLines.map((l) => ({
    text: textOfLine(l),
    // ⚠️ **不搬 confidence**（F4）：搬过来只会让人以为它是"质量"
    box: l && l.boundingBox ? l.boundingBox : null
  }));
  const lineTexts = lines.map((l) => l.text);
  const rawText = res && typeof res.text === 'string' ? res.text : '';
  const text = lineTexts.length ? joinLines(lineTexts) : collapseCjkSpaces(rawText);
  const pages = [ { index: 0, text: text, lines: lineTexts } ];

  const out = {
    ok: true,
    available: true,
    reason: lineTexts.length
      ? '识别完成：' + lineTexts.length + ' 行 / ' + countStats(text).chars + ' 个非空白字符'
      : '识别完成，但这一页没有识别出任何文字（空页，不算失败）',
    text: text,
    rawText: rawText,
    lines: lines,
    pages: pages,
    langsUsed: langsUsed,
    langsIgnored: langsIgnored,
    version: info.version,
    confidence: Object.assign({}, CONFIDENCE_NOTE)
  };
  if (langsIgnored.length) {
    out.langsNote = '只用第一个语言（index.d.ts:46「On Windows, only the first language is used.」）'
      + ' ⇒ ' + langsIgnored.join(' / ') + ' 被忽略，它们的识别质量**未验证**';
  }
  return out;
}

/* ---------- 质量报告（F4：没有置信度这个数） ---------- */

function pageLinesOf(page) {
  if (page && Array.isArray(page.lines)) return page.lines.map(textOfLine);
  const t = page && typeof page.text === 'string' ? page.text : '';
  return t ? t.split('\n') : [];
}

function pageTextOf(page) {
  if (page && typeof page.text === 'string') return page.text;
  const ls = pageLinesOf(page);
  return ls.length ? joinLines(ls) : '';
}

/**
 * `qualityReport(pages, opts) → report`
 *
 * 每页：`chars`（非空白字符数）/ `lineCount`（行数）/ `cjkRatio` / `nonCjkRatio` / `blankLines`；
 *       0 字符的页 ⇒ `note:'该页未识别出文字'`，**并继续统计下一页**（`P4-G3`：不许整批失败）。
 * 整体：`pageCount` / `recognizedPages` / `emptyPages` / `avgCharsPerPage` /
 *       与文字层字符数之比（**只在 `opts.textLayerChars` 是数字时才有**，否则 `textLayer:null`）。
 * **没有**「平均置信度」这种字段 —— 只有 `confidence:{used:false, why:…}`（F4）。
 */
function qualityReport(pages, opts) {
  const o = opts || {};
  if (!Array.isArray(pages)) {
    return {
      ok: false,
      reason: 'qualityReport 需要 pages 数组（拿到 ' + (pages === null ? 'null' : typeof pages) + '）'
        + ' —— 一张图 = 一页，见 recognizeWith 返回的 pages',
      pages: [],
      confidence: Object.assign({}, CONFIDENCE_NOTE)
    };
  }

  const rows = [];
  let totalChars = 0;
  let totalLines = 0;
  let totalCjk = 0;
  let totalNonCjk = 0;
  let totalBlank = 0;
  let recognized = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const text = pageTextOf(page);
    const st = countStats(text);
    const ls = pageLinesOf(page);
    const blankLines = ls.filter((t) => !String(t).trim()).length;
    const row = {
      index: page && typeof page.index === 'number' ? page.index : i,
      chars: st.chars,
      lineCount: ls.length,
      blankLines: blankLines,
      cjk: st.cjk,
      nonCjk: st.nonCjk,
      cjkRatio: st.chars ? st.cjk / st.chars : 0,
      nonCjkRatio: st.chars ? st.nonCjk / st.chars : 0
    };
    if (st.chars === 0) {
      row.note = '该页未识别出文字';
    } else {
      recognized++;
    }
    totalChars += st.chars;
    totalLines += ls.length;
    totalCjk += st.cjk;
    totalNonCjk += st.nonCjk;
    totalBlank += blankLines;
    rows.push(row);
  }

  const pageCount = pages.length;
  const report = {
    ok: true,
    basis: '非空白字符（空白不做分母：OCR 的空格形态不可靠）',
    pageCount: pageCount,
    recognizedPages: recognized,
    emptyPages: pageCount - recognized,
    chars: totalChars,
    lineCount: totalLines,
    blankLines: totalBlank,
    cjk: totalCjk,
    nonCjk: totalNonCjk,
    cjkRatio: totalChars ? totalCjk / totalChars : 0,
    nonCjkRatio: totalChars ? totalNonCjk / totalChars : 0,
    avgCharsPerPage: pageCount ? totalChars / pageCount : 0,
    pages: rows,
    confidence: Object.assign({}, CONFIDENCE_NOTE)
  };

  if (typeof o.textLayerChars === 'number' && isFinite(o.textLayerChars)) {
    report.textLayer = {
      chars: o.textLayerChars,
      ocrChars: totalChars,
      // 比值 = OCR 字符数 / 文字层字符数：> 1 表示 OCR 比文字层还多（通常是噪声），
      // 接近 0 表示"这一页几乎没认出来"。文字层 0 字符时比值没有意义 ⇒ null，不编一个 0。
      ratio: o.textLayerChars > 0 ? totalChars / o.textLayerChars : null,
      note: o.textLayerChars > 0
        ? 'OCR 字符数 / 文字层字符数；越接近 0 越可能是没认出来'
        : '文字层 0 字符 ⇒ 比值没有意义（这就是该走 OCR 的那一页）'
    };
  } else {
    report.textLayer = null; // 没给文字层字符数 ⇒ 不假装比过
  }
  if (pageCount === 0) report.note = '没有页可统计';
  return report;
}

/* ---------- 提示判据（"该不该建议 OCR"） ---------- */

/**
 * `shouldSuggestOcr(textLayer) → {suggest, reason}`
 *
 * **唯一会 suggest 的情形是 `textLayer.ok === false`**（文字层不可用/采不到内容）——
 * 有文字层的 PDF **永不提示** OCR（它有更好的东西，OCR 只会更慢更差）。
 * 拿不到判据（`undefined` / 非对象 / `ok` 不是布尔）⇒ `suggest:false` + 说清"为什么判不了"，
 * **绝不假装能判**（"采不到真值 = 红"的同一条纪律，见 `docs/RULES.md` §2）。
 *
 * `textLayer` 的形状 = `src/pdf-text.js` 的 `assessTextLayer()` / `buildOutline()` 那一侧的 `{ok, reason, …}`。
 */
function shouldSuggestOcr(textLayer) {
  if (!textLayer || typeof textLayer !== 'object') {
    return {
      suggest: false,
      reason: '拿不到文字层判据（拿到 ' + (textLayer === null ? 'null' : typeof textLayer) + '）'
        + ' ⇒ 不假装能判；要么先跑一次文字层评估，要么按"没有 PDF 可扫"处理'
    };
  }
  if (textLayer.ok === false) {
    const why = typeof textLayer.reason === 'string' && textLayer.reason ? textLayer.reason : '没有给原因';
    return { suggest: true, reason: '文字层不可用（' + why + '）⇒ 建议对这一页走 OCR' };
  }
  if (textLayer.ok === true) {
    const chars = typeof textLayer.chars === 'number' ? textLayer.chars : null;
    const pages = typeof textLayer.pageCount === 'number' ? textLayer.pageCount : null;
    const how = (chars === null ? '字符数未给' : chars + ' 字符') + ' / ' + (pages === null ? '页数未给' : pages + ' 页');
    return { suggest: false, reason: '文字层可用（' + how + '）⇒ 有文字层的 PDF 永不提示 OCR' };
  }
  return {
    suggest: false,
    reason: '文字层判据的 ok 不是布尔（拿到 ' + (textLayer.ok === undefined ? 'undefined' : typeof textLayer.ok)
      + '）⇒ 拿不到判据，不假装能判'
  };
}

module.exports = {
  MODULE_NAME: MODULE_NAME,
  EXPECTED_VERSION: EXPECTED_VERSION,
  CONFIDENCE_NOTE: CONFIDENCE_NOTE,
  CJK_RANGES: CJK_RANGES,

  componentInfo: componentInfo,
  loadComponent: loadComponent,
  recognizeWith: recognizeWith,
  joinLines: joinLines,
  qualityReport: qualityReport,
  shouldSuggestOcr: shouldSuggestOcr,

  defaultLoader: defaultLoader,
  resolveVersion: resolveVersion,
  isCjk: isCjk,
  isSpaceChar: isSpaceChar,
  collapseCjkSpaces: collapseCjkSpaces,
  countStats: countStats
};
