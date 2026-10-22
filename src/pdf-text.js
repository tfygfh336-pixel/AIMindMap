/* ============================================================
 * src/pdf-text.js — PDF 文字层 → 行 / 段 / 标题层级（纯函数，零依赖）
 * ------------------------------------------------------------
 * 它是什么：吃 pdf.js `page.getTextContent()` 给的 `TextItem[]`，出去三样 ——
 *   `lines`（行）/ `paragraphs`（段）/ `headings`（标题 + 层级），外加 `md`（提纲 Markdown，
 *   直接喂 `src/markdown.js` 的 `markdownToTree` 走**同一条**建树路 ✓）。
 * 它不是什么：不做 I/O、不 await、不认识 pdf.js 的其它 API ⇒ 单测喂合成数据即可（不必造真 PDF ✓）。
 *
 * 为什么要有它（实测，见 `.review/20261009-PDF方案调研与计划/计划.md` §0.2）：
 *   用户自己的样本 `projects/comnet/attachments/mumuhe9jafs5.pdf`（30 页，Chromium/Skia 生成）
 *   **没有书签** ⇒ 只支持书签的那条路会直接拒绝导入 ✗；而它的文字层完好
 *   （实测 30 页 / 30077 字符：21pt 标题 ×24 字、15.75pt 章 ×152、12.28pt 节 ×487、
 *    10.5pt 正文 ×28583、9pt 页眉页脚 ×831）⇒ 走文字层完全能建树 ✓。
 *
 * 三条来自实测/上游源码的硬事实（别凭直觉改）：
 *   ① **字号只能取 `transform[3]`**：`TextItem` **没有** fontSize 字段 ✗；
 *      `height` 是渲染视角下的量（含旋转/缩放），跟字号不是一回事 ⇒ 一律 `Math.abs(transform[3])`。
 *   ② `styles[fontName].fontFamily` **不能用来判断字体**：Chromium/Skia 出的 PDF 里一律是
 *      `"sans-serif"`（实测：真样本 5 个 fontName 全报同一个 family ✗）⇒ 只能用 `fontName`。
 *   ③ 行/段阈值照 **Calibre 的方法**（`LINE_FACTOR=0.2` / `PARA_FACTOR=1.8`），但**只抄方法不抄代码**
 *      （Calibre 是 GPLv3 ✗）。它那套标题判据与正则**全是英文**（其源码注释自己写着中文完全没处理）
 *      ⇒ 本文件的中文判据（`第X章` / `N.N` / `附录A` …）全部自己写 ✓。
 *
 * 标题候选（三条并行，计划 §1#3 的三判据 ✓；每条阈值都有实测依据，别凭直觉放宽）：
 *   ① **字号**：行字号 ≥ 基准字号 × 1.15
 *      —— 为什么是 1.15 而不是 Calibre 的 1.3：实测样本的节标题 12.28pt / 正文 10.5pt = **1.17 倍**，
 *         按 1.3 会整级漏掉 ✗。
 *   ② **位置**：居中 **且** 在本页前两个内容行内 **且** ≤ 24 字。
 *      「居中」= **左右页边距近似相等**（相对差 ≤ 25%）**且行宽 ≤ 65% 页宽** ——
 *      为什么不是"行中心贴近页中心"：实测样本按那个宽松判据有 **74 行**命中（全是左边距 43–61、
 *      右边距 100+ 的正文/代码行，它们的"中心"只是被行宽推到页中心附近 ✗）；换成左右边距相等后全部落空 ✓。
 *   ③ **中文/编号正则**：**无歧义**编号（`第X章|篇|部|卷`、`第X节`、`附录A`、`N.N(.N)`）**且"孤立"**。
 *      「孤立」= 与上一行的间距 > 1.8× 两者中较小的字号（或它是本页第一个内容行）。
 *      实测依据：真样本 p4 的正文残行 `5.6才引入）` 命中 `N.N` 正则，但上间距只有 1.57 倍 ⇒ 不是标题 ✓；
 *      而 12 个章标题的上间距都在 2.2 倍以上 ✓（HTML 标题自带 margin ⇒ 这个判据对"HTML 转出的文档"稳）。
 *      **有歧义**编号（裸 `1.`、`一、`、`（一）`）**不单独成立候选** —— 它们同时是列表项的形状：
 *      实测样本 p26 有 `1./2./3./4.` 四条命令步骤列表，按"编号即候选"会凭空多出 2 个顶层主题 ✗；
 *      这类编号仍然参与**层级**判定（真样本与调研样本的 `2.1 xxx` 都在用）✓。
 *
 * 失败一律**响亮**：`buildOutline` 给 `{ok:false, reason}`（reason 带数字），**绝不返回半棵树** ✗。
 *
 * 边界（如实写明，别当已实现）：
 *   · 只做"文字层 → 提纲"：**页码 ↔ 物理页偏移**（P2）、**多书自动判定**（P3）、**OCR**（P4）
 *     都不在本文件（分阶段见计划 §5）；**目录页 → `{title, printedPage}`** 已在 ⑤b 做（P1-b ✓）。
 *   · 页眉页脚做**两档计数 + 字号守卫**（每页首尾各 2 行）：①"逐字相同"（同一**字号簇**内才算，
 *     见 `SIZE_GUARD_TOL`）②页号形态，两者都要求出现 > 半数十页才认。
 *     **P1 的第三档（固定前缀 + 变化数字）没做** —— 实测后果：页眉若逐章变号（`第N章 xxx 27`），
 *     现有两档一条都剔不掉，它会以"第X章"形态进 headings（读数 `.review/20261028-P1a/out-前置.txt` ③）。
 *     另：不做上面这两档的后果是真样本每页的 9pt 页眉与 `1 / 30` 页脚会混进每个节点正文，
 *     且页脚会命中 `^\d+…` 编号正则 ✗。
 *   · 目录条目（点线 + 页码）：**P1-b 已做**（`tocLeader` / `extractTocEntries`，见 ⑤b）—— 既做
 *     "不是标题"的排除，也抽出 `{title, printedPage}`。点线允许单个 `…` 与点间空白，
 *     且行尾必须是页码数字 ⇒ 正文省略号不会命中。
 *     ⚠️ **真书未验**：两份真实 PDF 的全书「点线 + 页码」行数 = **0**（读数见 ⑤b 的注释）⇒
 *     这一档只有**合成夹具**的判据，**不许**把它说成"能用于真实 PDF"。
 *   · 旋转页（rotation ≠ 0）不做"居中"判据（实测样本与 Chromium/Skia 产出都是 0）。
 *   · 段只在本页内合并，**跨页的段不做合并**（P1）。
 *   · 目录页守卫是**最小**的：整行恰为"目录/目次/Contents"才认，且只把该行**及其后**的行排除出标题
 *     （目录之前的行仍参与 —— 实测样本第 1 页是"大标题 + 目录"同页，整页排除会白丢一个一级标题 ✗）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMPdfText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================= 常量（每个都写"值从哪来"） ================= */
  /** 同一行：基线 y 之差 < 20% 字高（Calibre 的 LINE_FACTOR：抄方法 ✓ 没抄代码 ✗） */
  const LINE_FACTOR = 0.2;
  /** 段中断 / "孤立"：间距 > 1.8× 字高（Calibre 的 PARA_FACTOR）。
   *  实测样本段内行距 ≈16.5pt / 字号 10.5pt = 1.57 倍 ⇒ 1.8 能把"段内换行"与"换段/标题"分开 ✓ */
  const PARA_FACTOR = 1.8;
  /** 「居中」的左右边距相对差上限（实测：真样本 74 行假居中全部落空的那个阈值） */
  const CENTER_MARGIN_TOL = 0.25;
  /** 「居中」的行宽上限（占页宽比例）：正文整行天然"中心贴页中心"，必须靠这一条排除 ✗ */
  const MAX_CENTER_WIDTH = 0.65;
  /** 只靠"居中 + 页首"命中的标题更严：更短才算（否则每页第一行长句都会变标题 ✗） */
  const POS_HEADING_CHARS = 24;
  /** 「页首」= 本页**前两个内容行**（0 起下标 ≤ 1）。为什么不是"y ≥ 75% 页高"：
   *  实测样本那样算页面顶部 25% 有 5–6 行正文，全部落进"页首" ⇒ 位置判据形同虚设 ✗ */
  const TOP_LINES = 1;
  /** "字号显著大于基准"的门槛（见文件头①：实测样本节标题只有 1.17 倍） */
  const MIN_TITLE_FACTOR = 1.15;
  /** 字号分桶容差（相对）：同桶视为"同一级"（浮点噪声不该造出一级来） */
  const SIZE_BUCKET_TOL = 0.02;
  /** 标题最长多少字（超过就是正文句子，不是标题） */
  const MAX_HEADING_CHARS = 40;
  /** 层数封顶：Markdown 的 `#` 最多 6 个 ⇒ 树最多 6 层 */
  const MAX_DEPTH = 6;
  /** 文字层闸门：单页字符数 < 20 且页数 > 1 ⇒ 疑似扫描页（计划 §0.1 的判据 ✓） */
  const MIN_PAGE_CHARS = 20;
  /** 同一行内两个片段之间：间距 > 25% 字高 **且**两侧不是 CJK ⇒ 补一个空格 */
  const SAME_SPACE_FACTOR = 0.25;
  /** 页眉/页脚：只扫每页首尾各 2 行；出现次数 > 半数十页才认（Calibre 的"超过扫描页一半才认" ✓） */
  const EDGE_LINES = 2;
  /** CJK（含全角标点/假名/兼容汉字）：判"要不要补空格"与"段内换行要不要直接拼" */
  const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

  /* ================= 中文/编号正则（自己写的 —— Calibre 那套全是英文） ================= */
  // 无歧义（几乎不会出现在正文句首/列表里 ⇒ 配"孤立"就够）
  const RE_CHAPTER = /^第\s*[0-9一二三四五六七八九十百千]+\s*[章篇部卷]/;       // 第3章 / 第一篇 / 第 2 部
  const RE_APPENDIX = /^附录\s*(?:[A-Z]|[0-9]|[一二三四五六七八九十])?/;          // 附录A / 附录 3 / 附录
  const RE_SECTION = /^第\s*[0-9一二三四五六七八九十百千]+\s*[节讲条]/;           // 第3节
  const RE_DOTTED = /^(\d{1,3}(?:[.．]\d{1,3}){1,3})(?![\d.．])/;                 // 1.1 / 3.5 / 1.2.3
  // 有歧义（同时是列表项形状 ⇒ 只参与层级，不单独成立候选）
  const RE_NUM_SIMPLE = /^\d{1,3}\s*[.、．]\s*\S/;                                // 1. 前言 / 1.任务背景
  const RE_PAREN_NUM = /^[（(]\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[）)]/;  // （一）/ (2)
  const RE_CN_NUM = /^[一二三四五六七八九十]{1,3}\s*[、.．]/;                      // 一、背景
  // 反例形态
  const RE_PAGE_NUMBER = /^\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*$/;                     // 1 / 30（页脚形态）
  /** 目录条目：**点线 + 页码**（计划 §2；F3 修的就是这一处）。三件事必须一起说清：
   *   ① 点线可以是一串 ASCII 点 / 中间点 / 一字节点，**也可以是一个 U+2026 `…`**
   *      —— `…` 这个字形**本身就是三个点**，旧写法 `[.·․…]{2,}` 却要求"至少两个字符"⇒ 排版上的
   *      单个省略号**不命中**（实测 `.review/20261026-PDF-P1P4方案/out-toc-fixture.txt:45`：
   *      4 条目录行只命中 3 条）；
   *   ② 点与点之间**允许空白**：真实 PDF 的点线常常是"每个点一个 `TextItem`"，`itemsToLines` 会在
   *      它们之间补空格 ⇒ 同一个符形会变成 `. . . . .`；允许空白后 `. . .` 才算命中
   *      （实测读数见 `.review/20261028-P1a/out-前置.txt` 的 ②：改前 `…` 与 `. . .` 两种都漏）。
   *      ⚠️ 不写成 `[\s.·․…]{2,}` —— 那会把"纯空白"当点线，`2.1 顺序存储结构 35` 这种
   *      **只有间距、没有点线**的行会假命中 ✗（SPEC §1.1 ③ 点名过这个坑）；
   *   ③ **正文里的省略号不命中**：这一档永远要求"行尾就是页码数字" ⇒ `他说来话长……`、
   *      `…… 个` 都不成立；只有"省略号 + 纯数字结尾"才进这一档。
   *   ④ **页码捕获组只有一个**：`(\d{1,4})` 是本工程里"目录行尾的页码"的**唯一**取法 ——
   *      `tocLeader()`（⑤b）就靠它取值，别在别处再写一份 `/(\d+)\s*$/`（两份就会漂）。
   *   ⑤ **尾部允许"点线接着点线"**（`(?:[.·․…]\s*)*`）：真实排版会把 `…` 与 `.` 连用
   *      （本批夹具 `1.3 索引….7` 就是这个形态）—— 只认"整段同一个符形"会在这种混排上整条漏掉。
   *      这一档只放宽"点线的符形",**没有**放宽"行尾必须是纯数字"（那条是 ③ 的防线）。
   */
  const RE_TOC_LEADER = /(?:(?:[.·․]\s*){2,}|(?:…\s*)+)(?:[.·․…]\s*)*(\d{1,4})\s*$/;
  const RE_SENT_END = /[。；！？!?]$/;                                             // 句末标点 ⇒ 正文（逗号不算）
  const RE_LIST_OR_URL = /^(?:[-*+•·]\s|https?:\/\/|\|)/;                         // 列表 / 网址 / 表格行
  const RE_TOC_MARKER = /^(目\s*录|目\s*次|contents|table\s+of\s+contents)$/i;     // 目录页标记

  /* ================= 小工具 ================= */
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function isCJK(ch) { return !!ch && CJK.test(ch); }
  function normSpace(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* ================= ① TextItem[] → 行 =================
   * 行的定义：**基线 y 之差 < 20% 字高** 就算同一行（Calibre 的方法 ✓）。
   * pdf.js 会给两种"看起来没用"的项，处理方式不同：`str === ''` 的换行标记项**丢掉**
   *（它没有字形），纯空格项**保留**（它是行内真空格，丢了会把 "深入理解 计算机" 粘成一个词 ✗）。
   * 产出里 `atTop` / `isolated` 是**false 占位**：它们要看"同页相邻行"，由后续两步（buildOutline）填 ✓。
   */
  function itemsToLines(items, opts) {
    const o = opts || {};
    const page = o.page || 1;
    const pageWidth = Number(o.pageWidth) || 0;
    const pageHeight = Number(o.pageHeight) || 0;
    // 位置判据只在未旋转页上做（实测样本与 Chromium/Skia 产出都是 rotation=0）
    const geomUsable = ((Number(o.rotation) || 0) % 360) === 0 && pageWidth > 0;

    const toks = [];
    for (const it of (items || [])) {
      // 丢掉 `str === ''` 的换行标记项（没有字形）；**保留纯空格项** —— pdf.js 检测到字间空隙时会
      // 额外发一个 `str: ' '` 的合成空格项，丢了会把 "深入理解 计算机" 粘成一个词 ✗（实测夹具里踩到）。
      // 重复空格由 normSpace 收敛，不会变成两个空格 ✓
      if (!it || typeof it.str !== 'string' || it.str === '') continue;
      const tr = it.transform || [];
      const size = Math.abs(Number(tr[3]) || 0);   // ← 硬事实①：字号只能取 transform[3]（TextItem 没有 fontSize）
      if (!size) continue;                          // 连字号都取不到 ⇒ 宁可丢这一项，也不猜
      toks.push({
        text: it.str, size: size,
        x: Number(tr[4]) || 0, y: Number(tr[5]) || 0,
        w: Number(it.width) || 0, fontName: it.fontName || ''
      });
    }
    // y 大的在前（PDF 原点左下）；同 y 按 x 小到大
    toks.sort((a, b) => (b.y - a.y) || (a.x - b.x));

    const groups = [];
    for (const t of toks) {
      let best = null, bestD = Infinity;
      for (const g of groups) {
        const d = Math.abs(g.y - t.y);
        if (d < LINE_FACTOR * Math.max(g.size, t.size) && d < bestD) { best = g; bestD = d; }
      }
      if (!best) { best = { y: t.y, size: t.size, n: 0, parts: [] }; groups.push(best); }
      best.parts.push(t);
      best.n++;
      best.y += (t.y - best.y) / best.n;            // 行基线取**增量均值**：抗同行的轻微基线抖动
      if (t.size > best.size) best.size = t.size;   // 行字号 = 行内**最大**字号（标题行里混了小字时取大的才对）
    }

    const lines = groups.map((g) => {
      const parts = g.parts.slice().sort((a, b) => a.x - b.x);
      let text = '';
      let prev = null;
      for (const p of parts) {
        if (prev) {
          const gap = p.x - (prev.x + prev.w);
          const bigGap = gap > SAME_SPACE_FACTOR * Math.max(p.size, prev.size);
          // 空格只在"明显有间距且两侧不是 CJK"时补：CJK 之间补空格会把标题正则与正文都弄脏 ✗
          if (bigGap && !isCJK(prev.text.slice(-1)) && !isCJK(p.text[0])) text += ' ';
        }
        text += p.text;
        prev = p;
      }
      const x0 = parts[0].x;
      const x1 = parts.reduce((m, p) => Math.max(m, p.x + (p.w || 0)), x0);
      const left = x0, right = pageWidth - x1;
      const width = x1 - x0;
      // 「居中」= 左右边距近似相等 **且** 行不宽（见文件头②的实测）
      const centered = geomUsable && left > 0 && right > 0
        && Math.abs(left - right) <= CENTER_MARGIN_TOL * Math.max(left, right)
        && width <= MAX_CENTER_WIDTH * pageWidth;
      return {
        page: page, text: normSpace(text),
        size: round2(g.size), fontName: parts[0].fontName,
        x: round2(x0), y: round2(g.y), x0: round2(x0), x1: round2(x1), width: round2(width),
        left: round2(left), right: round2(right), pageWidth: round2(pageWidth), pageHeight: round2(pageHeight),
        centered: centered, atTop: false, isolated: false,
        repeated: false, tocEntry: false, heading: null, level: null, paraIndex: -1
      };
    });
    lines.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    return lines;
  }

  /** 字号守卫的容差（相对）：文本相同的两行，只有**字号彼此接近**时才允许被算成同一条重复行。
   *  依据（F2 现场，`.review/20261026-PDF-P1P4方案/out-toc-fixture.txt:41,48,50`）：
   *    "书名 = 封面 **21pt** 居中大标题 + 每页 **9pt** 页眉同文"时，两行文本逐字相同而字号差 133%
   *    ⇒ 旧实现把它们算成一类，**封面标题被当页眉剔掉、21pt 那一级整个消失**。
   *  为什么 0.10 够：真样本的页眉恒为 9pt（零抖动），而"书名做页眉"的典型比是 21/9 ≈ 2.3 倍
   *    ⇒ 0.10 与 2.3 之间有三个数量级余量，阈值不敏感（若换语料发现误杀，调到 0.05 即可，不影响结构）。
   *  ⚠️ 守卫是**两侧**的：它只挡"字号差得远的那个簇"，覆盖过半页的那个簇**照旧剔除**——
   *    只做"不剔"那一侧，页眉页脚就会重新混进正文（那是同一个 bug 的反面）。
   */
  const SIZE_GUARD_TOL = 0.10;

  /* ================= ② 页眉页脚（两档计数 + 字号守卫） =================
   * 只扫**每页首尾各 2 行**，两类计数都要求"出现次数 > 半数十页"：
   *   ① 去空白后逐字相同 ② 页号形态（`1 / 30`）
   * 为什么必须做：真样本 30 页每页都有 9pt 页眉（逐字相同 ✓）与 `1 / 30` 页脚（页号形态 ✓）。
   * 页数 < 2 判不出来（Calibre 同此边界 ⇒ 如实返回 0，不硬猜）。
   *
   * ① 的计数按 **字号簇** 分组（见 `SIZE_GUARD_TOL`）：同一段文本在首尾行里出现的字号先按
   * 相对差 ≤ SIZE_GUARD_TOL 聚成簇，**只有覆盖率过半页的那一簇**才是页眉/页脚；
   * 同一段文本的另一簇（典型：封面 21pt 书名）**原样保留**并计入 `sizeGuard.rejected`。
   * 标记也要**按簇**做（不是按文本做）：否则"9pt 页眉命中"会把同文本的 21pt 那一行一起标掉 ✗。
   */
  function markRepeatedLines(lines, pageCount) {
    const n = Number(pageCount) || 0;
    if (n < 2) return { marked: 0, texts: [], pageNumber: false, sizeGuard: { rejected: 0, minRatio: null } };
    const byPage = new Map();
    for (const l of lines) {
      if (!byPage.has(l.page)) byPage.set(l.page, []);
      byPage.get(l.page).push(l);
    }
    /** 两个字号是否"同一簇"（相对差 ≤ 容差；0 字号按"互不相干"处理，安全方向是**不剔**） */
    const sameSize = (a, b) => {
      const hi = Math.max(a, b);
      return hi > 0 && Math.abs(a - b) <= SIZE_GUARD_TOL * hi;
    };
    // ① 候选面（每页首尾各 EDGE_LINES 行）→ 文本 → 字号簇 → 簇里记"哪几页出现过"
    const byText = new Map();       // text -> [{ size, pages:Set<page> }]
    let numPages = 0;               // 出现"页号形态"的页数（各页文字不同，只能按形态计数 ✓）
    for (const arr of byPage.values()) {
      const edge = arr.slice(0, EDGE_LINES).concat(arr.slice(Math.max(EDGE_LINES, arr.length - EDGE_LINES)));
      let hasNum = false;
      for (const l of edge) {
        const t = normSpace(l.text);
        if (!t) continue;
        if (RE_PAGE_NUMBER.test(t)) hasNum = true;
        const size = Number(l.size) || 0;
        let clusters = byText.get(t);
        if (!clusters) { clusters = []; byText.set(t, clusters); }
        let c = null;
        for (const x of clusters) if (sameSize(x.size, size)) { c = x; break; }
        if (!c) { c = { size: size, pages: new Set() }; clusters.push(c); }
        c.pages.add(l.page);        // 同一页里同一句只算一票（Set 天然去重 ✓）
      }
      if (hasNum) numPages++;
    }
    // ② 逐簇判"过半页"：过了半数的簇才是页眉/页脚。`texts` 仍按**文本**报（人话是"这一句"),
    //    但标记阶段只在**命中簇**上标 ⇒ 未命中的簇一个字都不动 ✓
    const hit = new Map();          // text -> [命中的簇字号]
    const texts = [];
    for (const [t, clusters] of byText) {
      const sizes = clusters.filter((c) => c.pages.size > n / 2).map((c) => c.size);
      if (!sizes.length) continue;
      hit.set(t, sizes);
      texts.push(t);
    }
    const pageNumHit = numPages > n / 2;
    const sizeGuard = { rejected: 0, minRatio: null };
    let marked = 0;
    for (const arr of byPage.values()) {
      arr.forEach((l, idx) => {
        if (idx >= EDGE_LINES && idx < arr.length - EDGE_LINES) return;   // 只看首尾 2 行
        const t = normSpace(l.text);
        if (!t) return;
        const hitSizes = hit.get(t);
        if (hitSizes) {
          const size = Number(l.size) || 0;
          if (hitSizes.some((s) => sameSize(s, size))) { l.repeated = true; marked++; return; }
          // ★ 同一句文本、但字号对不上命中的那一簇 ⇒ **保留**（这就是封面大标题那一行）
          sizeGuard.rejected++;
          let near = hitSizes[0];
          for (const s of hitSizes) if (Math.abs(s - size) < Math.abs(near - size)) near = s;
          const ratio = round2(Math.min(size, near) / Math.max(size, near));
          if (sizeGuard.minRatio === null || ratio < sizeGuard.minRatio) sizeGuard.minRatio = ratio;
          return;
        }
        if (pageNumHit && RE_PAGE_NUMBER.test(t)) { l.repeated = true; marked++; }
      });
    }
    return { marked: marked, texts: texts, pageNumber: pageNumHit, sizeGuard: sizeGuard };
  }

  /* ================= ③ 行距判据：孤立（标题常有一条上空白）=================
   * 「孤立」= 与**上一个内容行**（跳过页眉页脚）的间距 > 1.8× 两者中**较小**的字号；
   * 本页第一个内容行天然算孤立（上面没有东西）。
   * 为什么用"较小"而不是本行字号：实测中文真值 PDF 的大章标题（22pt）上间距只有 25.5pt，
   * 用 22pt 算得 1.16 倍（判成"不孤立" ✗），而它上一行是 9pt 的页眉 ⇒ 25.5/9 = 2.8 倍 ✓。
   * 同时把「页首」（本页前 TOP_LINES+1 个内容行）标回行上。
   */
  function markLayout(lines) {
    const byPage = new Map();
    for (const l of lines) {
      if (!byPage.has(l.page)) byPage.set(l.page, []);
      byPage.get(l.page).push(l);
    }
    for (const arr of byPage.values()) {
      let contentIdx = 0;
      let prev = null;
      for (const l of arr) {
        if (l.repeated) continue;
        const gap = prev ? (prev.y - l.y) : Infinity;
        l.isolated = !prev || gap > PARA_FACTOR * Math.min(prev.size, l.size);
        l.atTop = contentIdx <= TOP_LINES;
        contentIdx++;
        prev = l;
      }
    }
    return lines;
  }

  /* ================= ④ 正文基准字号：按**字符数**取众数 =================
   * 为什么按字符数而不是按行数：一页里"标题行"与"正文行"的**行数**可能相当（30 页里标题行上百），
   * 但**字符数**上正文压倒性占优（实测样本 10.5pt 28583 字 vs 其余字号合计 1494 字 ✓）。
   * 为什么用 item 字号而不是行字号：一行里混了不同字号时，"一行一票"会偏向大字号 ✗。
   * parts: [{size, text}]；返回 null 表示一个带字号的字符都没有。
   */
  function bodyFontSize(parts) {
    const hist = new Map();
    for (const p of (parts || [])) {
      const s = round2(p.size);
      if (!s) continue;
      const n = String(p.text == null ? '' : p.text).replace(/\s+/g, '').length;
      if (n) hist.set(s, (hist.get(s) || 0) + n);
    }
    let best = null, bestN = -1;
    // 升序扫描 + 严格大于 ⇒ 票数相同时取**小**字号（正文更可能是小的那个）
    for (const s of [...hist.keys()].sort((a, b) => a - b)) {
      const c = hist.get(s);
      if (c > bestN) { bestN = c; best = s; }
    }
    return best;
  }

  /* ================= ⑤ 标题候选与层级 ================= */
  /**
   * 行文本 → { depth, strong } 或 null。
   * depth 1 = 最浅（章/篇/部/附录/裸 `1.`/`一、`）；strong = **无歧义**（可单独成立候选）。
   */
  function numbering(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (RE_CHAPTER.test(t) || RE_APPENDIX.test(t)) return { depth: 1, strong: true };
    if (RE_SECTION.test(t)) return { depth: 2, strong: true };
    const dotted = RE_DOTTED.exec(t);
    if (dotted) return { depth: clamp(dotted[1].split(/[.．]/).length, 1, MAX_DEPTH), strong: true };  // "1.1" → 2 段 → 2 级
    if (RE_PAREN_NUM.test(t)) return { depth: 2, strong: false };
    if (RE_CN_NUM.test(t)) return { depth: 1, strong: false };
    if (RE_NUM_SIMPLE.test(t)) return { depth: 1, strong: false };
    return null;
  }

  /** 行文本的"形状"够不够当标题（与字号无关的那半部分判据） */
  function headingShape(text) {
    const t = String(text || '').trim();
    if (t.length < 2 || t.length > MAX_HEADING_CHARS) return false;
    if (RE_SENT_END.test(t)) return false;      // 句末标点 ⇒ 正文句子
    if (RE_LIST_OR_URL.test(t)) return false;
    if (RE_PAGE_NUMBER.test(t)) return false;   // 页脚形态（`1 / 30` 会命中 `^\d+…` 编号正则 ✗）
    if (tocLeader(t) !== null) return false;    // 目录条目：点线 + 页码（判据在 ⑤b 的 tocLeader 里，只有一份）
    return true;
  }

  /** 单行的候选判定（三条判据**并行**取或 —— 见文件头）。`base` 为 null（一个带字号的字符都没有）⇒ 只剩强编号一条。 */
  function headingHit(line, base) {
    if (!headingShape(line.text)) return null;
    const num = numbering(line.text);
    const ratio = base ? line.size / base : 0;
    const reasons = [];
    if (base && ratio >= MIN_TITLE_FACTOR) reasons.push('size');
    // 位置判据：居中 + 页首两个内容行内 + 短（两个条件都要，见文件头②）
    if (base && line.centered && line.atTop && line.text.length <= POS_HEADING_CHARS && line.size >= base * 0.95) {
      reasons.push('pos');
    }
    // 无歧义编号还得"孤立"（见文件头③：正文残行 `5.6才引入）` 就是被这条挡住的）
    if (num && num.strong && line.isolated) reasons.push('number');
    if (!reasons.length) return null;
    return {
      reasons: reasons,
      numberDepth: num ? num.depth : null,
      strongNumber: !!(num && num.strong),
      sizeHit: reasons.indexOf('size') >= 0,
      ratio: round2(ratio)
    };
  }

  /** 给候选定层级。规则（每条都有实测依据）：
   *   ① 有"字号信号"（size ≥ 基准×1.15）的候选 ⇒ 按**字号桶排名**（大 = 浅）：
   *      实测样本 21 / 15.75 / 12.28 ⇒ 1 / 2 / 3 级，正是"标题 → 章 → 节"✓。
   *      —— 为什么不直接用编号深度：真样本的章写作 `3. 01-proc文件系统`（弱编号，深度 1）、
   *         节写作 `3.5数据流`（深度 2），而章字号(15.75) > 节字号(12.28) ⇒ 字号排名更符合原书层级 ✓。
   *   ② 同一个桶里编号深度不同的（"第X章" 与 "第X节" 同字号）⇒ 以桶内**最小深度**对齐，深的往下压一层 ✓。
   *   ③ 没有字号信号的候选（如调研样本的 `2.1 顺序存储结构` 若与正文同字号）⇒ 用**编号深度**定级 ✓。
   *   ④ 只有"居中+页首"命中、既无字号也无编号 ⇒ 放到最深一层（保守：宁可嵌在底下，也不冒充顶层主题 ✓）。
   */
  function assignLevels(cands, base) {
    const all = cands || [];
    const sized = all.filter((c) => c.heading.sizeHit);
    const sizes = [...new Set(sized.map((c) => c.size))].sort((a, b) => b - a);
    const buckets = [];
    for (const s of sizes) {
      const last = buckets[buckets.length - 1];
      if (last && Math.abs(last.size - s) <= SIZE_BUCKET_TOL * Math.max(last.size, s)) last.sizes.push(s);
      else buckets.push({ size: s, sizes: [s], count: 0 });
    }
    const bucketOf = new Map();                       // size → 桶序号（0 起，越大越深）
    buckets.forEach((b, i) => b.sizes.forEach((s) => bucketOf.set(s, i)));
    const depthOf = (c) => c.heading.numberDepth || 1;
    const minDepthIn = buckets.map(() => Infinity);
    for (const c of sized) {
      const i = bucketOf.get(c.size);
      buckets[i].count++;
      minDepthIn[i] = Math.min(minDepthIn[i], depthOf(c));
    }
    const posOnlyLevel = buckets.length ? Math.min(MAX_DEPTH, buckets.length + 1) : 1;
    for (const c of all) {
      let lv;
      if (c.heading.sizeHit) {
        const i = bucketOf.get(c.size);
        lv = (i + 1) + (depthOf(c) - minDepthIn[i]);
      } else if (c.heading.numberDepth) {
        lv = c.heading.numberDepth;
      } else {
        lv = posOnlyLevel;
      }
      c.level = clamp(lv, 1, MAX_DEPTH);
    }
    return buckets.map((b, i) => ({ level: i + 1, size: round2(b.size), count: b.count }));
  }

  /* ================= ⑤b 目录块（点线 + 打印页码）=================
   * 它是什么：把**原先内联在 `buildOutline` 里**的"目录页启发式"抽成可单测的纯函数，并**新抽**
   *   `{title, printedPage}` 结构（改前只做"这些行不是标题"的排除，一个页码都不抽）。
   *
   * ⚠️ 一条必须先承认的事实（别把它读成"已经能用于真实 PDF"）：**真实语料上零命中** ——
   *   两份真实 PDF（30 页 / 25 页）全书命中「点线 + 页码」的行数 **= 0**
   *   （读数原文 `全书命中「点线+页码」的行数 = 0`，见 `.review/20261026-PDF-P1P4方案/` 的
   *   `out-mumuhe9jafs5.txt` 与 `out-mumuhmbscjfs.txt`）；它们的目录实际是 `1.任务背景` 这种
   *   **无页码、无点线**的形态。⇒ 这一档的判据**只能靠合成夹具**（纯代码造 TextItem，不造真 PDF），
   *   而合成夹具**验不出**这套启发式在真书上灵不灵 ⇒ **不许声称它"能用于真实 PDF"**。
   *
   * 为什么抽出来（而不是继续内联）：内联时它只能被"整份 buildOutline"间接验 —— 要断言
   *   "第 3 条的 printedPage 是 35"就得造一整本书的 pages；抽成纯函数后一行文本就能测。
   *
   * 判据的单源（别在别处再写第二份）：
   *   · 「行尾是不是点线 + 页码」= 只有 `RE_TOC_LEADER` 这一条正则（`tocLeader` 是它唯一的解析入口，
   *     `headingShape` 也走它）；
   *   · 「哪些行算目录条目」= **调用方给的 `opts.isEntry`**（`buildOutline` 传"编号成立 + 字号没超过
   *     基准×1.05"）—— 本模块**不自己发明第二套**条目判据（两处定义 = 两处漂移）。
   *   · 块的**起点**仍由 `RE_TOC_MARKER`（`目录/目次/Contents` 整行）定义 —— 与改前同一判据；
   *     没有标记行 ⇒ **空结果**（不猜块起点：猜出来的"目录"会把正文编号行整片吞掉 ✗）。
   */

  /** 行尾是「点线 + 页码」⇒ 返回那个**打印页码（整数）**；否则 `null`。
   *  ⚠️ 三件"看起来像但不是"的形态全在这里挡住（判据只在 `RE_TOC_LEADER` 里，别另写一份）：
   *    ① 正文省略号（`他说来话长……` / `…… 个`）—— 行尾不是纯数字；
   *    ② 只有间距没有点线的行（`2.1 顺序存储结构 35`）—— 写成 `[\s.·․…]{2,}` 才会假命中；
   *    ③ 页码不在行尾（`……详见 3.5 节`）。
   *  返回 `null` 而不是 `0` / `-1` 是**有意**的：`null` 才把"没有页码"与"页码是 0"分开。
   *  编一个哨兵值会让下游把"没抽到"读成"页码 0"—— 这正是本档最容易做假的那一处。
   */
  function tocLeader(text) {
    const m = RE_TOC_LEADER.exec(String(text == null ? '' : text));
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  /** 一行文本 → 去掉「点线 + 页码」之后的标题文本（**保留行首编号**，例：`1.1 顺序存储结构`）。
   *  没有点线/页码 ⇒ 整行（规范化后）。 */
  function tocTitle(text) {
    const t = normSpace(text);
    const m = RE_TOC_LEADER.exec(t);
    return normSpace(m ? t.slice(0, m.index) : t);
  }

  /** 一组行（通常 = 同一页的行，y 降序）→ 目录块的结构化读数。
   *  @param {Array<{page?:number,text:string,size?:number,repeated?:boolean}>} lines
   *  @param {{isEntry:function, baseFontSize?:number|null}} opts
   *    `isEntry(line, ctx)` **必填** —— 条目判据由调用方给；`ctx.baseFontSize` 是**转达**给它的
   *    基准字号（本函数自己不拿它下判断，只把它递过去，省得调用方为了一个数去闭包）。
   *  @returns {{entries:Array<{title:string, printedPage:number|null, page:number|null,
   *    hasLeader:boolean, raw:string}>, pages:Array, stats:{lines:number, withLeader:number,
   *    withoutLeader:number}, stops:Array<{page:number|null, index:number, text:string}>}}
   *  · `stats.withLeader + stats.withoutLeader === entries.length` 恒成立；
   *  · `stats.lines` = 目录块**扫过**的行数（含被 `repeated` 跳过的页眉页脚行、含**把块结束掉的那一行**）
   *    ⇒ `stats.lines - entries.length` 就是"扫过却没成条目"的行数（= 判据"块在哪结束"的读数）。
   *  ⚠️ 顺手把 `line.tocEntry` 写回行上（与同文件 `linesToParagraphs` 写回 `line.paraIndex` 是
   *    **同一形态**）—— 这样 `buildOutline` 里"哪一行是目录条目"仍是同一批行对象上的同一个字段，
   *    抽函数前后**逐条等价**（`tests/pdf-text.test.js` 的「目录页守卫」钉着这件事）。
   */
  function extractTocEntries(lines, opts) {
    const o = opts || {};
    if (typeof o.isEntry !== 'function') {
      // 响亮拒绝：不给判据就**不猜**（猜出来的条目判据与调用方各写一套 = 两处定义）
      throw new Error('extractTocEntries 缺 opts.isEntry：目录条目的判据必须由调用方给（本模块不自己发明第二套）');
    }
    const arr = lines || [];
    const entries = [];
    const pages = [];
    const stops = [];
    const stats = { lines: 0, withLeader: 0, withoutLeader: 0 };
    const ctx = { baseFontSize: (o.baseFontSize == null ? null : o.baseFontSize) };
    const tocAt = arr.findIndex((l) => RE_TOC_MARKER.test(normSpace(l && l.text)));
    if (tocAt < 0) return { entries: entries, pages: pages, stats: stats, stops: stops };
    const marker = arr[tocAt];
    pages.push(marker && marker.page != null ? marker.page : null);   // 这一页是目录页（页号可能为 null）
    for (let i = tocAt + 1; i < arr.length; i++) {
      const l = arr[i];
      stats.lines++;
      // 页眉页脚：不算条目，也**不结束**目录块（与改前的 `continue` 逐条等价）
      if (l && l.repeated) continue;
      if (!o.isEntry(l, ctx)) {
        // 目录块到此为止 —— 这一行**不进** entries，但要记下"在哪结束"（判据要的就是这个读数）
        stops.push({ page: (l && l.page != null) ? l.page : null, index: i, text: normSpace(l && l.text) });
        break;
      }
      const printedPage = tocLeader(l.text);
      const page = (l && l.page != null) ? l.page : (marker && marker.page != null ? marker.page : null);
      entries.push({
        title: tocTitle(l.text), printedPage: printedPage, page: page,
        hasLeader: printedPage !== null, raw: normSpace(l && l.text)
      });
      stats[printedPage === null ? 'withoutLeader' : 'withLeader']++;
      if (l) l.tocEntry = true;
    }
    return { entries: entries, pages: pages, stats: stats, stops: stops };
  }

  /* ================= ⑥ 行 → 段 =================
   * 段中断的判据只有**行距 > 1.8× 字高**。为什么不加"缩进变化"（Calibre 有 SAME_INDENT）：
   * 实测样本的正文 x 从 43 到 84 都有（代码/表格缩进），加进去会把代码逐行拆成段 ✗。
   */
  function joinWrapped(prevText, nextText) {
    if (!prevText) return nextText || '';
    if (!nextText) return prevText;
    const a = prevText.slice(-1), b = nextText[0];
    return (isCJK(a) || isCJK(b)) ? prevText + nextText : prevText + ' ' + nextText;
  }

  /** 行 → 段（本页内）。**顺手把段号写回行上**（`line.paraIndex`，-1 = 不属于任何段），
   *  这样"按文档序拼 blocks"不用再去猜哪一行是段首（早先按 y 反查的写法又脆又难读 ✗）。 */
  function linesToParagraphs(lines) {
    const out = [];
    let cur = null, prev = null;
    for (const l of (lines || [])) {
      if (l.repeated) { cur = null; prev = null; continue; }        // 页眉页脚不进正文
      if (l.heading) { cur = null; prev = null; continue; }         // 标题行自成结构，不算正文段
      if (l.tocEntry) {
        // 目录条目：**逐行成段**（不并进正文段 —— 目录条目的行距本来就是"每条一行"，
        // 并起来会变成 "1.任务背景2.环境准备…" ✗）。内容不丢：它落在「目录」节点下 ✓
        out.push({ page: l.page, text: l.text, size: l.size, lineCount: 1, y: l.y, toc: true });
        l.paraIndex = out.length - 1;
        cur = null; prev = null;
        continue;
      }
      const gap = prev ? (prev.y - l.y) : Infinity;
      const broke = !cur || gap > PARA_FACTOR * Math.max(prev.size, l.size);
      if (broke) { cur = { page: l.page, text: l.text, size: l.size, lineCount: 1, y: l.y }; out.push(cur); }
      else { cur.text = joinWrapped(cur.text, l.text); cur.lineCount++; cur.size = Math.max(cur.size, l.size); }
      l.paraIndex = out.length - 1;
      prev = l;
    }
    return out;
  }

  /* ================= ⑦ 文字层闸门（"有没有文字层"的第一道关） ================= */
  /** pages: [{page?, items}] → 闸门结论（带数字，绝不静默 ✓） */
  function assessTextLayer(pages) {
    const list = pages || [];
    const charsByPage = list.map((p) => (p.items || []).reduce(
      (n, it) => n + (it && typeof it.str === 'string' ? it.str.replace(/\s+/g, '').length : 0), 0));
    const chars = charsByPage.reduce((a, b) => a + b, 0);
    const pageCount = list.length;
    const suspectPages = [];
    if (pageCount > 1) {
      charsByPage.forEach((c, i) => { if (c < MIN_PAGE_CHARS) suspectPages.push({ page: (list[i] && list[i].page) || (i + 1), chars: c }); });
    }
    let ok = true, reason = '';
    if (!pageCount) {
      ok = false; reason = '这份 PDF 一页都没有（读不到任何页）⇒ 不能建树';
    } else if (pageCount === 1 && charsByPage[0] < MIN_PAGE_CHARS) {
      ok = false;
      reason = '只有 1 页，且该页文字层只有 ' + charsByPage[0] + ' 个字符（判据 < ' + MIN_PAGE_CHARS
        + '）：页数 < 2 用不了"过半页"判据 ⇒ 按单页判据处理，疑似没有文字层（扫描件）';
    } else if (suspectPages.length > pageCount / 2) {
      ok = false;
      reason = pageCount + ' 页里有 ' + suspectPages.length + ' 页文字层不足 ' + MIN_PAGE_CHARS
        + ' 个字符（全书文字合计只有 ' + chars + ' 个字符）⇒ 疑似整本扫描件（没有可用的文字层）';
    } else {
      reason = pageCount + ' 页 / 文字层合计 ' + chars + ' 个字符';
      if (suspectPages.length) {
        reason += '；其中 ' + suspectPages.length + ' 页文字层过少（页 '
          + suspectPages.slice(0, 8).map((s) => s.page + ':' + s.chars + '字').join('、')
          + (suspectPages.length > 8 ? ' 等' : '') + '）—— 这些页可能是扫描图，本页内容不会进树';
      }
    }
    return { ok: ok, reason: reason, chars: chars, charsByPage: charsByPage, suspectPages: suspectPages, pageCount: pageCount };
  }

  /* ================= ⑧ 提纲拼装 ================= */
  /** 第一个标题之前的正文**不进提纲** —— markdownToTree 那时还没有任何节点可挂（`if (!cur) continue`），
   *  送进去也是白送；顺带保证 md 首行是标题 ⇒ markdownToTree 的 detectMode 一定判成 heading ✓
   *  （否则首行是 `- xxx` 的正文会把整篇当 list 形态解析 ✗）。丢了多少字要**如实说**（见 notes）。
   */
  function splitPreamble(blocks) {
    const i = (blocks || []).findIndex((b) => b.kind === 'heading');
    if (i < 0) return { preamble: blocks || [], body: [] };
    return { preamble: (blocks || []).slice(0, i), body: (blocks || []).slice(i) };
  }

  /** blocks → 提纲 Markdown（`#` 数 = 层级；正文段原样成段） */
  function toMarkdown(blocks) {
    const out = [];
    for (const b of splitPreamble(blocks).body) {
      if (b.kind === 'heading') out.push('#'.repeat(clamp(b.level || 1, 1, MAX_DEPTH)) + ' ' + b.text);
      else out.push(String(b.text || ''));
      out.push('');                       // 块之间空一行（markdownToTree 靠它切段）
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ================= ⑨ 主入口 ================= */
  /**
   * @param {Array<{page?:number,width?:number,height?:number,rotation?:number,items:Array}>} pages
   * @returns {{ok:boolean, reason:string, md:string, baseFontSize:number|null, sizeBuckets:Array,
   *            headings:Array, paragraphs:Array, lines:Array, blocks:Array,
   *            textLayer:object, stats:object, notes:string[], toc:object}}
   */
  function buildOutline(pages) {
    const list = (pages || []).map((p, i) => ({
      page: (p && p.page) || (i + 1),
      width: Number(p && p.width) || 0,
      height: Number(p && p.height) || 0,
      rotation: Number(p && p.rotation) || 0,
      items: (p && p.items) || []
    }));
    const textLayer = assessTextLayer(list);
    const notes = [];
    if (!textLayer.ok) {
      return { ok: false, reason: textLayer.reason, md: '', baseFontSize: null, sizeBuckets: [],
        headings: [], paragraphs: [], lines: [], blocks: [],
        textLayer: textLayer, stats: emptyStats(textLayer), notes: notes, toc: emptyToc() };
    }
    if (textLayer.suspectPages.length) notes.push(textLayer.reason);

    // ① 行（每页各自成行）+ 收集全部"带字号的字符"（基准字号用）
    const lines = [];
    const allParts = [];
    for (const p of list) {
      for (const l of itemsToLines(p.items, { page: p.page, pageWidth: p.width, pageHeight: p.height, rotation: p.rotation })) lines.push(l);
      for (const it of p.items) {
        if (it && typeof it.str === 'string' && it.str.trim()) {
          allParts.push({ size: Math.abs(Number((it.transform || [])[3]) || 0), text: it.str });
        }
      }
    }
    // ② 页眉页脚（重复行）—— 必须在"标题候选"与"段"之前，否则它们会被当成正文/标题 ✗
    const rep = markRepeatedLines(lines, list.length);
    if (rep.marked) {
      notes.push('剔除了页眉/页脚 ' + rep.marked + ' 行：' + rep.texts.map((t) => '"' + t + '"').join('、')
        + (rep.pageNumber ? '（含页号形态的行）' : ''));
    }
    // 字号守卫**必须出声**：被它保下来的行原本会被当成页眉剔掉（典型：与页眉同文的封面大标题）。
    // 静默保留会让人以为"页眉页脚本来就长这样"，而这一档恰恰是本批修的那个 bug 的两侧之一。
    if (rep.sizeGuard && rep.sizeGuard.rejected) {
      notes.push('字号守卫：有 ' + rep.sizeGuard.rejected + ' 行与页眉/页脚同文但字号不同（与命中那一簇的'
        + '最小字号比 ' + rep.sizeGuard.minRatio + '）⇒ 已保留、未当页眉剔除');
    }
    // ③ 行距布局（孤立 / 页首）—— 位置判据与"编号要孤立"都靠它
    markLayout(lines);
    const base = bodyFontSize(allParts);

    // ④ 标题候选。目录页里的目录条目**不是结构**（它们是目录）：
    //    实测样本第 1 页是"大标题 + 目录 + 第 1 章标题"同页 ⇒ **不能整页排除**（那样会白丢第 1 章 ✗），
    //    只排除**目录标记之后、带编号且字号不超过正文×1.05 的连续行**（= 目录条目）；
    //    一旦遇到不符合的行（如 15.75pt 的 `1.任务背景`）就结束目录块 ⇒ 真标题照常参与 ✓。
    //    ⚠️ 判据本体已抽到 ⑤b 的 `extractTocEntries`（这里只**给判据**、**读结果**）：
    //    标记语义仍是同一批行对象上的同一个 `line.tocEntry` 字段（⑤b 顺手写回），
    //    所以 `tocEntries` 计数、下面那条 notes、以及"遇到更大字号行即结束"与抽函数前逐条等价。
    const byPage = new Map();
    for (const l of lines) {
      if (!byPage.has(l.page)) byPage.set(l.page, []);
      byPage.get(l.page).push(l);
    }
    const cands = [];
    const toc = {
      entries: [], pages: [], tocPages: 0,
      stats: { lines: 0, withLeader: 0, withoutLeader: 0 }, stops: []
    };
    /** 目录条目的判据（**由调用方给** —— 模块不自己发明第二套）：编号成立，且字号没超过正文×1.05。
     *  超过就说明它是"真标题"而不是目录条目（实测样本 p1 那个 15.75pt 的 `第一章 概述` 就是被这条挡住的）。 */
    const isTocEntryLine = (l) => {
      const num = numbering(l.text);
      return !!num && !(base && l.size > base * 1.05);
    };
    for (const p of list) {
      const arr = byPage.get(p.page) || [];
      const one = extractTocEntries(arr, { baseFontSize: base, isEntry: isTocEntryLine });
      toc.tocPages += one.pages.length;
      one.pages.forEach((pg) => toc.pages.push(pg));
      one.entries.forEach((e) => toc.entries.push(e));
      one.stops.forEach((s) => toc.stops.push(s));
      toc.stats.lines += one.stats.lines;
      toc.stats.withLeader += one.stats.withLeader;
      toc.stats.withoutLeader += one.stats.withoutLeader;
      arr.forEach((l) => {
        if (l.repeated || l.tocEntry) return;
        const hit = headingHit(l, base);
        if (hit) { l.heading = hit; cands.push(l); }
      });
    }
    const tocEntries = toc.entries.length;
    if (toc.tocPages) {
      notes.push('认出 ' + toc.tocPages + ' 个目录页 / ' + tocEntries
        + ' 行目录条目：条目不计入标题，逐行作为正文保留在「目录」节点下 ✓');
      // P1-b 的如实读数：抽到几条带页码的？—— "没抽到"与"没有"是两件事，不许静默（SPEC P1-G1）
      notes.push('目录页码抽取：' + toc.stats.withLeader + ' 行带「点线 + 页码」（能抽出 printedPage）、'
        + toc.stats.withoutLeader + ' 行只有编号没有点线（printedPage = null，不猜）'
        + (toc.stops.length ? '；目录块在 ' + toc.stops.length + ' 处遇到非条目行即结束' : ''));
    }
    const sizeBuckets = assignLevels(cands, base);

    // ⑤ 段（必须在标题定级之后：标题行不算正文段）+ 按**文档序**拼 blocks
    const paragraphs = [];
    const blocks = [];
    const emitted = new Set();
    for (const p of list) {
      const arr = byPage.get(p.page) || [];
      const before = linesToParagraphs(arr);
      const off = paragraphs.length;
      before.forEach((par) => paragraphs.push(par));
      for (const l of arr) {
        if (l.heading) {
          blocks.push({ kind: 'heading', text: l.text, level: l.level, page: l.page, size: l.size, reasons: l.heading.reasons.slice() });
        } else if (l.paraIndex >= 0 && !emitted.has(off + l.paraIndex)) {
          emitted.add(off + l.paraIndex);
          const par = paragraphs[off + l.paraIndex];
          blocks.push({ kind: 'text', text: par.text, page: par.page, size: par.size });
        }
      }
    }

    const headings = blocks.filter((b) => b.kind === 'heading');
    const preChars = splitPreamble(blocks).preamble.reduce((n, b) => n + String(b.text || '').length, 0);
    if (preChars) notes.push('第一个标题之前有 ' + preChars + ' 个字符没有进树（建树时无处可挂 ⇒ 只留在本模块的 paragraphs 里）');
    const levelCounts = {};
    headings.forEach((h) => { levelCounts[h.level] = (levelCounts[h.level] || 0) + 1; });
    const stats = {
      pages: list.length, chars: textLayer.chars, headings: headings.length,
      paragraphs: paragraphs.length, levelCounts: levelCounts,
      suspectPages: textLayer.suspectPages.map((s) => s.page), repeatedLines: rep.marked
    };
    if (!headings.length) {
      return { ok: false, reason: noHeadingReason(textLayer), md: '', baseFontSize: base, sizeBuckets: sizeBuckets,
        headings: [], paragraphs: paragraphs, lines: lines, blocks: blocks,
        textLayer: textLayer, stats: stats, notes: notes, toc: toc };
    }
    return {
      ok: true, reason: '', md: toMarkdown(blocks), baseFontSize: base, sizeBuckets: sizeBuckets,
      headings: headings, paragraphs: paragraphs, lines: lines, blocks: blocks,
      textLayer: textLayer, stats: stats, notes: notes, toc: toc
    };
  }

  /** 文字层读得出来、却一个标题都没认出来 ⇒ 也是**响亮拒绝**（不许静默给一棵没骨架的树 ✗） */
  function noHeadingReason(textLayer) {
    return '文字层读得到 ' + textLayer.chars + ' 个字符（' + textLayer.pageCount + ' 页），但按三条判据'
      + '（字号 / 编号 / 居中+页首）**一个标题都没认出来** ⇒ 不做半棵树'
      + '（一棵没有骨架的树对使用者没有价值 ✗）。'
      + '若这份 PDF 的正文是**图片**（扫描件），或标题字号与正文完全一致且无编号、也不居中，请走 OCR / 先转 Markdown';
  }

  function emptyStats(textLayer) {
    return { pages: textLayer.pageCount, chars: textLayer.chars, headings: 0, paragraphs: 0,
      levelCounts: {}, suspectPages: textLayer.suspectPages.map((s) => s.page), repeatedLines: 0 };
  }

  /** 文字层都不可用时 `buildOutline` 的 `toc`：**结构齐全、条目为空** ——
   *  返回形状不许随失败路径变（否则调用方要按 ok 分支去猜有没有这个键 ✗）。 */
  function emptyToc() {
    return { entries: [], pages: [], tocPages: 0,
      stats: { lines: 0, withLeader: 0, withoutLeader: 0 }, stops: [] };
  }

  return {
    // 常量（单测与文档引用同一个值，别在别处再抄一份）
    LINE_FACTOR: LINE_FACTOR, PARA_FACTOR: PARA_FACTOR, CENTER_MARGIN_TOL: CENTER_MARGIN_TOL,
    MAX_CENTER_WIDTH: MAX_CENTER_WIDTH, POS_HEADING_CHARS: POS_HEADING_CHARS, TOP_LINES: TOP_LINES,
    MIN_TITLE_FACTOR: MIN_TITLE_FACTOR, MAX_HEADING_CHARS: MAX_HEADING_CHARS, MAX_DEPTH: MAX_DEPTH,
    MIN_PAGE_CHARS: MIN_PAGE_CHARS, EDGE_LINES: EDGE_LINES, SIZE_GUARD_TOL: SIZE_GUARD_TOL,
    // 纯函数
    itemsToLines: itemsToLines, markRepeatedLines: markRepeatedLines, markLayout: markLayout,
    linesToParagraphs: linesToParagraphs, bodyFontSize: bodyFontSize, numbering: numbering,
    headingShape: headingShape, headingHit: headingHit, assignLevels: assignLevels,
    // ⑤b 目录块（P1-b）：`tocLeader` 是「点线 + 页码」的唯一解析入口（正则在 `RE_TOC_LEADER` 里只有一份）；
    // `extractTocEntries` 的条目判据**由调用方给**（见它的注释：模块不自己发明第二套）
    tocLeader: tocLeader, extractTocEntries: extractTocEntries,
    assessTextLayer: assessTextLayer, joinWrapped: joinWrapped, splitPreamble: splitPreamble,
    toMarkdown: toMarkdown, buildOutline: buildOutline
  };
});
