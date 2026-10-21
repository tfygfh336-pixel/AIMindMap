/* ============================================================
 * tests/pdf-text.test.js — PDF 文字层 → 行/段/标题层级（P0）
 * 运行：npx vitest run tests/pdf-text.test.js
 * ------------------------------------------------------------
 * 这一层守什么（都是"错了会静默给出错误结果"的地方 ✗）：
 *   ① **字号只能取 `transform[3]`** —— `TextItem` 没有 fontSize 字段；用 height 会得到别的数 ✗；
 *   ② 基准字号必须**按字符数**取众数（按行数会被标题行带偏）；
 *   ③ 标题候选的三条判据各自都要**能挡住实测抓到的假阳性**（正文残行 / 命令步骤列表 / 表格行）；
 *   ④ 文字层闸门与"一个标题都没认出来"都必须**响亮**（带数字），不许静默给半棵树。
 * 数据来源：真样本 `projects/comnet/attachments/mumuhe9jafs5.pdf`（30 页无书签）与调研留下的中文真值 PDF，
 *   实测过程见 `.review/20261009-PDF方案调研与计划/probe-*.mjs` 与 `probe-*.txt`。
 * 夹具：`tests/pdf-fixture.js` 的 `buildUnlabeledChinesePdf()`（**纯代码生成**，不引二进制样本 ✓）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pt = require('../src/pdf-text.js');
const fx = require('./pdf-fixture.js');

/** 造一个 TextItem。⚠️ 故意让 `height` 与 `transform[3]` **不同**：
 *  字号若被写成读 height，下面的断言会立刻变红 ✓（判别力）。 */
function item(str, size, x, y, extra) {
  const it = {
    str: str, width: String(str).length * size, height: size * 0.77,
    fontName: 'g_d0_f1', hasEOL: false, transform: [size, 0, 0, size, x, y]
  };
  return Object.assign(it, extra || {});
}
/** 一页（A4）：items + 页宽页高 */
function page(items, no) { return { page: no || 1, width: fx.PAGE_W, height: fx.PAGE_H, rotation: 0, items: items }; }
/** 用合成 items 跑完整流程 */
function outline(pages) { return pt.buildOutline(pages); }
/** 取标题文本/层级，便于断言 */
const hs = (r) => r.headings.map((h) => '#' .repeat(h.level) + ' ' + h.text);

describe('行合并（LINE_FACTOR = 0.2）', () => {
  it('同一基线的多个片段合成一行，按 x 排序；空串项（pdf.js 的换行标记）被丢掉', () => {
    const lines = pt.itemsToLines([
      item('世界', 10, 120, 700),
      item('', 10, 0, 700),                      // 换行标记：没有字形 ⇒ 丢掉
      item('你好', 10, 60, 700)
    ], { page: 1, pageWidth: fx.PAGE_W });
    expect(lines.length).toBe(1);
    expect(lines[0].text).toBe('你好世界');       // 按 x 排好序 ✓
  });

  it('基线差 ≥ 20% 字高 ⇒ 分成两行', () => {
    const lines = pt.itemsToLines([
      item('第一行', 10, 60, 700),
      item('第二行', 10, 60, 697.9)               // Δy = 2.1 > 0.2×10 ✓ 两行
    ], { page: 1, pageWidth: fx.PAGE_W });
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe('第一行');          // y 大的在前（PDF 原点在左下）
  });

  it('★ 字号只取 transform[3]：height 与 width 再怎么不同都不影响（判别力：改用 height ⇒ 红）', () => {
    const lines = pt.itemsToLines([
      item('标题', 21, 60, 700, { height: 9.9, width: 1 })   // height/width 故意是错的
    ], { page: 1, pageWidth: fx.PAGE_W });
    expect(lines[0].size).toBe(21);
  });

  it('行内大间距补一个空格；CJK 之间**不**补（补了会把中文标题正则弄脏）', () => {
    const lines = pt.itemsToLines([
      item('Hello', 10, 60, 700), item('World', 10, 110, 700),      // 前一个正好接上（60+50=110）⇒ 不补
      item('你好', 10, 300, 660), item('世界', 10, 340, 660)          // 间距 20（很大）但两侧 CJK ⇒ 不补
    ], { page: 1, pageWidth: fx.PAGE_W });
    expect(lines.find((l) => l.y === 700).text).toBe('HelloWorld');
    expect(lines.find((l) => l.y === 660).text).toBe('你好世界');
  });

  it('非 CJK 之间的大间距要补空格（否则英文相邻词会粘成一个词）', () => {
    const lines = pt.itemsToLines([
      item('Hello', 10, 60, 700), item('World', 10, 130, 700)       // 间距 20 > 25% 字高 ⇒ 补
    ], { page: 1, pageWidth: fx.PAGE_W });
    expect(lines[0].text).toBe('Hello World');
  });

  it('pdf.js 合成的空格项（str=" "）**不能丢** —— 丢了会把 "标题 副标题" 粘成一个词', () => {
    const lines = pt.itemsToLines([
      item('深入理解', 21, 60, 700),
      item(' ', 21, 144, 700),                   // 真空格项
      item('计算机', 21, 165, 700)
    ], { page: 1, pageWidth: fx.PAGE_W });
    expect(lines[0].text).toBe('深入理解 计算机');
  });
});

describe('正文基准字号：按**字符数**取众数', () => {
  it('★ 按字符数而不是按行数（判别力：改成按行数 ⇒ 红）', () => {
    // 5 行小字号（6 字）+ 3 行大字号（14 字）：按行数 ⇒ 大字号赢；按字符数 ⇒ 小字号赢 ✓
    const parts = [];
    for (let i = 0; i < 5; i++) parts.push({ size: 18, text: '一二三四五六' });
    for (let i = 0; i < 3; i++) parts.push({ size: 10.5, text: '一二三四五六七八九十一二三四' });
    expect(pt.bodyFontSize(parts)).toBe(10.5);
  });

  it('票数相同时取小字号；一个带字号的字符都没有 ⇒ null', () => {
    expect(pt.bodyFontSize([{ size: 12, text: '一二' }, { size: 20, text: '三四' }])).toBe(12);
    expect(pt.bodyFontSize([])).toBe(null);
    expect(pt.bodyFontSize([{ size: 0, text: 'x' }])).toBe(null);
  });
});

describe('段（PARA_FACTOR = 1.8）', () => {
  const mk = (text, y, size) => ({ page: 1, text: text, size: size || 10.5, y: y, repeated: false, tocEntry: false, heading: null, paraIndex: -1 });

  it('行距 ≤ 1.8× 并成一段；CJK 直接拼、非 CJK 补空格', () => {
    const paras = pt.linesToParagraphs([
      mk('中文第一行', 700), mk('中文第二行', 684),        // 16 / 10.5 = 1.52 ✓ 同段
      mk('latin line one', 600), mk('latin line two', 584)
    ]);
    expect(paras.length).toBe(2);
    expect(paras[0].text).toBe('中文第一行中文第二行');
    expect(paras[1].text).toBe('latin line one latin line two');
    expect(paras[0].lineCount).toBe(2);
  });

  it('行距 > 1.8× 字高 ⇒ 新段', () => {
    const paras = pt.linesToParagraphs([mk('第一段', 700), mk('第二段', 680)]);   // 20 > 18.9 ✓
    expect(paras.length).toBe(2);
  });

  it('标题行不算正文段（段在标题处断开）', () => {
    const head = mk('第一章 概述', 700, 15.75); head.heading = { reasons: ['size'], numberDepth: 1, sizeHit: true };
    const paras = pt.linesToParagraphs([mk('正文甲', 740), head, mk('正文乙', 660)]);
    expect(paras.length).toBe(2);
    expect(paras.map((p) => p.text)).toEqual(['正文甲', '正文乙']);
  });
});

describe('标题候选：三条判据', () => {
  it('★ 中文样例：21 / 15.75 / 12.28pt 三个字号桶 ⇒ 1 / 2 / 3 级，正文不成标题', () => {
    const r = outline([page([
      item('学习笔记', 21, 60, 760),
      item('第一章 概述', 15.75, 60, 700),
      item('1.1 研究背景', 12.28, 60, 670),
      item('这是一段中文正文，它既没有编号、字号也等于基准，因此不能成为标题。', 10.5, 60, 640)
    ])]);
    expect(r.baseFontSize).toBe(10.5);
    expect(hs(r)).toEqual(['# 学习笔记', '## 第一章 概述', '### 1.1 研究背景']);
    expect(r.headings[0].reasons).toContain('size');
  });

  it('与正文**同字号**的 `2.1 xxx` 靠编号成立，层级 = 编号深度（计划点名的精度陷阱）', () => {
    const r = outline([page([
      item('第二章 线性表', 21, 60, 760),
      item('背景说明文字，故意放长一点，让正文的字符数占优。', 10.5, 60, 700),
      item('2.1 顺序存储结构', 10.5, 60, 660),        // 与正文同字号（10.5）！
      item('正文继续，描述顺序存储。', 10.5, 60, 630)
    ])]);
    const h = r.headings.find((x) => x.text === '2.1 顺序存储结构');
    expect(h).toBeTruthy();
    expect(h.level).toBe(2);                         // 编号深度 2（没有字号信号 ⇒ 用编号）
    expect(h.reasons).toEqual(['number']);
  });

  it('★ 裸 `1./2./3.` 命令步骤（弱编号、正文同字号、左对齐）**不是**标题（判别力：把弱编号当强编号 ⇒ 红）', () => {
    const r = outline([page([
      item('第一章 概述', 15.75, 60, 760),
      item('1. 先把依赖装好，这一步很长，属于步骤说明。', 10.5, 60, 700),
      item('2. 然后编译内核模块。', 10.5, 60, 680),
      item('3. 最后运行程序看输出。', 10.5, 60, 660)
    ])]);
    // 这一页只有一个标题字号 ⇒ 它的层级就是 1 级（顶层主题）✓
    expect(hs(r)).toEqual(['# 第一章 概述']);
    expect(r.headings.length).toBe(1);
  });

  it('★ 正文残行 `5.6才引入）`（强编号但在段中、不孤立）**不是**标题（判别力：去掉孤立条件 ⇒ 红）', () => {
    const r = outline([page([
      item('第一章 概述', 15.75, 60, 760),
      item('/* 4.15必须用file_operations，若用proc_ops 则要高版本内核 */', 10.5, 60, 700),
      item('5.6才引入）', 10.5, 60, 683.5)            // 上间距 1.57× ⇒ 段落内的续行
    ])]);
    expect(hs(r)).toEqual(['# 第一章 概述']);
  });

  it('页脚 `1 / 30`、"点线 + 页码"的目录条目形态都不是标题', () => {
    expect(pt.headingShape('1 / 30')).toBe(false);
    expect(pt.headingShape('第二章 线性表 …… 45')).toBe(false);
    expect(pt.numbering('1 / 30')).toBe(null);
  });

  it('行太长 / 句末标点 / 列表项 / 表格行 都不是标题形状', () => {
    expect(pt.headingShape('这一句话非常长，长到超过四十个字符以后就不再可能是标题了，因为它读起来就是一句完整的话')).toBe(false);
    expect(pt.headingShape('这是问句吗？')).toBe(false);
    expect(pt.headingShape('- 列表项')).toBe(false);
    expect(pt.headingShape('| 表格 | 行 |')).toBe(false);
    expect(pt.headingShape('标题')).toBe(true);
  });

  it('★ 「居中」= 左右边距近似相等 **且** 行不宽（判别力：改成"行中心贴页中心" ⇒ 整行正文变标题）', () => {
    // 整行正文：x=57、宽 482 ⇒ 中心正好在页中心（595/2），但左右边距各 57/56、行宽占 81% ⇒ 不算居中
    const full = item('线性表的顺序存储结构是指用一段地址连续的存储单元依次存储线性表的数据元素，因此可以直接按下标访问。', 10.5, 57, 760, { width: 482 });
    const narrow = item('参考文献', 10.5, 267.5, 700, { width: 60 });     // 真居中：左右边距各 267.5
    const r = outline([page([full, narrow])]);
    expect(r.lines.find((l) => l.y === 760).centered).toBe(false);
    expect(r.lines.find((l) => l.y === 700).centered).toBe(true);
    expect(r.headings.map((h) => h.text)).toEqual(['参考文献']);
  });

  it('「页首」= 本页前两个内容行：第三行的居中短句不算（否则每页第一句都会变标题）', () => {
    const r = outline([page([
      item('第一行正文，用来占住页首。', 10.5, 60, 780),
      item('第二行正文，也占住页首。', 10.5, 60, 764),
      item('居中的短句', 10.5, 267.5, 700, { width: 60 })
    ])]);
    expect(r.headings.length).toBe(0);
    expect(r.ok).toBe(false);
  });
});

/* ============================================================
 * 目录条目（点线 + 页码）的判据（F3）—— **两侧**
 *   现场：`.review/20261026-PDF-P1P4方案/out-toc-fixture.txt:43-46`
 *     `"2.1 顺序存储结构 … 35"  leader=false` —— 单个 U+2026 不命中 `[.·․…]{2,}`
 *     （`…` 这个字形本身就是三个点 ⇒ "至少两个字符"的门槛是错的）；
 *     另一条更少被提到但同样错：`. . .` 也不命中（真实 PDF 的点线常是"每个点一个 TextItem"，
 *     行重建会在点之间补空格）。改前读数见 `.review/20261028-P1a/out-前置.txt` 的 ②。
 *   另一侧同样重要：**正文里的省略号不是目录行** —— 否则整段正文会被排除出标题候选。
 * ============================================================ */
describe('目录条目判据（F3）：四种点线写法都命中，正文省略号不命中', () => {
  it('★ 单个 … / ... / . . . / ···· 四种都算点线（判别力：量词退回 {2,} ⇒ 第 1、3 条红）', () => {
    const leaders = [
      '2.1 顺序存储结构 … 35',          // 单个 U+2026（字形本身就是三个点）
      '第三章 栈与队列 ... 58',          // 三个 ASCII 点
      '附录A 术语表 . . . . . 99',       // 点与点之间被行重建插了空格
      '第四章 树 ···· 77'                // 四个中间点（U+00B7）
    ];
    // 四条都是"目录条目" ⇒ 不是标题形状
    expect(leaders.map((t) => pt.headingShape(t))).toEqual([false, false, false, false]);
  });

  it('★ 正文里的省略号**不**算目录行（少了"行尾纯数字页码"就不是点线+页码）', () => {
    const bodyTexts = [
      '这段话说来话长……',                // 省略号在行尾、后面没有页码
      '他数了数……',
      '一共有十二个…… 个',               // 省略号后面是量词，不是页码
      '……详见 3.5 节',
      '2.1 顺序存储结构 35'               // **只有间距、没有点线**：不许因为"数字结尾"就命中
    ];
    expect(bodyTexts.map((t) => pt.headingShape(t))).toEqual([true, true, true, true, true]);
  });
});

describe('页眉页脚：两档计数', () => {
  /** n 页，每页都有 9pt 页眉 + 页号页脚；第 mid 页额外多一行"有时出现"的句子 */
  function pagesWithEdges(n, opts) {
    const o = opts || {};
    const out = [];
    for (let i = 1; i <= n; i++) {
      const items = [item('AI MindMap 夹具页眉', 9, 60, 810)];
      if (o.partialHeader && i <= Math.floor(n / 3)) items.push(item('偶尔出现的行', 9, 60, 795));
      items.push(item('第' + i + '页的正文内容，长度足够。', 10.5, 60, 700));
      items.push(item(i + ' / ' + n, 9, 285, 24));
      out.push(page(items, i));
    }
    return out;
  }

  it('半数十页以上重复的行被剔（含页号形态，各页文字不同也能按形态剔）', () => {
    const lines = [];
    pagesWithEdges(4).forEach((p) => lines.push(...pt.itemsToLines(p.items, { page: p.page, pageWidth: p.pageWidth })));
    const rep = pt.markRepeatedLines(lines, 4);
    expect(rep.pageNumber).toBe(true);
    expect(rep.texts).toEqual(['AI MindMap 夹具页眉']);
    // 4 页 × (页眉 + 页脚) = 8 行被剔 ✓
    expect(rep.marked).toBe(8);
  });

  it('只在少数页出现的行**不**剔（阈值是"超过半数十页"）', () => {
    const lines = [];
    pagesWithEdges(4, { partialHeader: true }).forEach((p) => lines.push(...pt.itemsToLines(p.items, { page: p.page, pageWidth: p.pageWidth })));
    const rep = pt.markRepeatedLines(lines, 4);
    expect(rep.texts).toEqual(['AI MindMap 夹具页眉']);
    expect(rep.marked).toBe(8);
  });

  it('页数 < 2 判不出页眉页脚（如实返回 0，不硬猜）', () => {
    const lines = pt.itemsToLines(pagesWithEdges(1)[0].items, { page: 1, pageWidth: fx.PAGE_W });
    const rep = pt.markRepeatedLines(lines, 1);
    // 形状：`marked/texts` 之外还有 `pageNumber` 与 `sizeGuard`（只增字段不删字段 ⇒ 调用方不用改）
    expect(rep.marked).toBe(0);
    expect(rep.texts).toEqual([]);
    expect(rep.pageNumber).toBe(false);          // 页数 < 2 ⇒ 页号形态也判不出来
    expect(rep.sizeGuard).toEqual({ rejected: 0, minRatio: null });   // 守卫没参与（不是"判了但没剔"）
    expect(lines.every((l) => !l.repeated)).toBe(true);              // 一行都没被标
  });
});

/* ============================================================
 * 字号守卫（F2）—— 两侧，缺一条就会把"剔太多"换成"不剔"（两者在 21pt 那张读数上看不出区别）
 *   现场：`.review/20261026-PDF-P1P4方案/out-toc-fixture.txt:48/50/51`
 *     "书名 = 封面 21pt 大标题 + 每页 9pt 页眉同文" ⇒ 旧实现只看文本相同 ⇒ 封面标题被当页眉剔掉，
 *     标题桶只剩 15.75（21pt 那一级整个消失）。
 *   本批读数：`.review/20261028-P1a/out-改动后.txt` 的 ①（改前对照：`out-前置.txt` 的 ①）
 * ============================================================ */
describe('字号守卫（F2）：同文不同字号的大标题不许当页眉剔掉', () => {
  const COVER = '数据结构笔记';
  /** 3 页：封面 21pt 书名 + **每页 9pt 页眉同文** + `N / 100` 页脚 + 章标题 + 正文（正文各行都唯一） */
  function coverFixture() {
    return [
      page([
        item(COVER, 21, 234.5, 760),                                  // 居中（宽 126，页宽 595）
        item('第一页的正文第一行，长度足够让基准字号按字符数胜出。', 10.5, 60, 700),
        item('第一页的正文第二行，紧跟上一行，属于同一段。', 10.5, 60, 683.5)
      ], 1),
      page([
        item(COVER, 9, 269, 810),                                     // ← 与书名逐字相同的页眉
        item('第一章 概述', 15.75, 60, 720),
        item('第二页的正文第一行，同一段里的续行，长度足够。', 10.5, 60, 690),
        item('第二页的正文第二行，仍然落在首尾候选面里。', 10.5, 60, 673.5),
        item('13 / 100', 9, 285, 24)
      ], 2),
      page([
        item(COVER, 9, 269, 810),
        item('第二章 方法', 15.75, 60, 720),
        item('第三页的正文第一行，同样长一点，让 10.5 占优。', 10.5, 60, 690),
        item('第三页的正文第二行，仍然落在首尾候选面里。', 10.5, 60, 673.5),
        item('14 / 100', 9, 285, 24)
      ], 3)
    ];
  }

  it('★ 判据①：21pt 那一级**在**（sizeBuckets[0] 与 headings 都有它）', () => {
    const r = outline(coverFixture());
    expect(r.baseFontSize).toBe(10.5);
    expect(r.sizeBuckets).toEqual([{ level: 1, size: 21, count: 1 }, { level: 2, size: 15.75, count: 2 }]);
    expect(hs(r)).toEqual(['# 数据结构笔记', '## 第一章 概述', '## 第二章 方法']);
    // 守卫**必须出声**：静默保留会让人以为"页眉页脚本来就这样"
    expect(r.notes.join(' ')).toContain('字号守卫');
    expect(r.notes.join(' ')).toContain('0.43');       // 9/21 = 0.43（诊断读数）
  });

  it('★ 判据②：9pt 页眉**仍被剔**（这是本批唯一的防线：只做①就成了"什么都不剔"）', () => {
    const r = outline(coverFixture());
    // 2 条 9pt 页眉 + 2 条页脚（各页文字不同 ⇒ 按形态剔）
    expect(r.stats.repeatedLines).toBe(4);
    const cover = r.lines.find((l) => l.size === 21 && l.text === COVER);
    expect(cover.repeated).toBe(false);                                  // 大标题没被标
    const headers = r.lines.filter((l) => l.size === 9 && l.text === COVER);
    expect(headers.length).toBe(2);
    expect(headers.every((l) => l.repeated)).toBe(true);                 // 9pt 页眉一条不剩地被标
    expect(r.paragraphs.some((p) => p.text === COVER)).toBe(false);       // 页眉没混进正文段
  });

  it('直接看 markRepeatedLines 的读数：命中簇照旧剔，被拒的那一行进 sizeGuard.rejected', () => {
    const lines = [];
    coverFixture().forEach((p) => lines.push(...pt.itemsToLines(p.items, { page: p.page, pageWidth: p.pageWidth })));
    const rep = pt.markRepeatedLines(lines, 3);
    expect(rep.texts).toEqual([COVER]);                   // 这一句**确实**是页眉/页脚那一类
    expect(rep.pageNumber).toBe(true);
    expect(rep.marked).toBe(4);                           // 2 页眉 + 2 页脚
    expect(rep.sizeGuard).toEqual({ rejected: 1, minRatio: 0.43 });   // 21pt 那一行被拒 1 次
  });

  it('★ 守卫不是"大字号永不剔"：同一段文本在过半页的首尾出现时，21pt 也照旧剔', () => {
    const pages = [];
    for (let i = 1; i <= 4; i++) {
      pages.push(page([
        item('大字号页眉', 21, 60, 800),
        item('第' + i + '页的正文，长度足够让基准字号按字符数胜出。', 10.5, 60, 700),
        item('第' + i + '页的正文第二行，文本唯一。', 10.5, 60, 683.5)
      ], i));
    }
    const lines = [];
    pages.forEach((p) => lines.push(...pt.itemsToLines(p.items, { page: p.page, pageWidth: p.pageWidth })));
    const rep = pt.markRepeatedLines(lines, 4);
    expect(rep.marked).toBe(4);                            // 4 页 × 1 条大字号页眉，全部剔掉
    expect(rep.sizeGuard.rejected).toBe(0);                // 一条都没被"字号不同"挡下来
  });
});


describe('目录页守卫', () => {
  it('目录标记之后、同字号、带编号的连续行 = 目录条目（不成标题）；遇到更大字号的行即结束目录块', () => {
    const r = outline([page([
      item('学习笔记', 21, 60, 790),
      item('目录', 15.75, 60, 750),
      item('1.任务背景', 10.5, 73, 720),
      item('2.环境准备', 10.5, 73, 703),
      item('第一章 概述', 15.75, 60, 650),            // 真标题：字号更大 ⇒ 结束目录块 ✓
      item('这一章的正文，放一点内容进来占字符数。', 10.5, 60, 620)
    ])]);
    expect(hs(r)).toEqual(['# 学习笔记', '## 目录', '## 第一章 概述']);
    const toc = r.lines.filter((l) => l.tocEntry).map((l) => l.text);
    expect(toc).toEqual(['1.任务背景', '2.环境准备']);
    // 目录条目**不丢内容**：逐行进正文段 ✓
    expect(r.paragraphs.map((p) => p.text)).toContain('1.任务背景');
  });
});

describe('文字层闸门（有没有文字层的第一道关）', () => {
  const pg = (chars, no) => page(chars ? [item('字'.repeat(chars), 10, 60, 700)] : [], no);

  it('★ 30 页里 29 页文字层 < 20 字符 ⇒ 判"没有可用文字层"，理由带数字（判别力：删掉这条判据 ⇒ 红）', () => {
    const pages = [];
    for (let i = 1; i <= 30; i++) pages.push(pg(i === 1 ? 200 : 5, i));
    const t = pt.assessTextLayer(pages);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain('29');
    expect(t.reason).toContain('30');
    expect(t.suspectPages.length).toBe(29);
  });

  it('1 页且字符数 < 20 ⇒ 按"单页判据"拒绝（页数 < 2 用不了过半页判据）', () => {
    const t = pt.assessTextLayer([pg(7, 1)]);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain('只有 1 页');
    expect(t.reason).toContain('7');
  });

  it('少数页文字层过少 ⇒ 仍然可用，但如实列出可疑页与字数（不静默 ✗）', () => {
    const t = pt.assessTextLayer([pg(300, 1), pg(5, 2), pg(300, 3), pg(300, 4)]);
    expect(t.ok).toBe(true);
    expect(t.suspectPages).toEqual([{ page: 2, chars: 5 }]);
    expect(t.reason).toContain('页 2:5字');
  });

  it('一页都没有 ⇒ 拒绝（不是返回 ok:true 的空结果）', () => {
    const t = pt.assessTextLayer([]);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain('一页都没有');
  });

  it('正常页数 ⇒ 可用，且字符数按**去空白后**计（页眉那种纯空白不算内容）', () => {
    const t = pt.assessTextLayer([pg(100, 1), pg(100, 2)]);
    expect(t.ok).toBe(true);
    expect(t.chars).toBe(200);
  });
});

describe('buildOutline 端到端（合成 items）', () => {
  it('2 页中文：层级、文档序 blocks、段、notes 全对', () => {
    const r = outline([
      page([
        item('学习笔记', 21, 60, 780),
        item('第一章 概述', 15.75, 60, 720),
        item('1.1 研究背景', 12.28, 60, 690),
        item('正文第一行，写长一点。', 10.5, 60, 660),
        item('正文第二行，紧跟上一行。', 10.5, 60, 643.5)
      ], 1),
      page([
        item('第二章 方法', 15.75, 60, 720),
        item('第二章的正文。', 10.5, 60, 690)
      ], 2)
    ]);
    expect(r.ok).toBe(true);
    expect(r.stats.levelCounts).toEqual({ 1: 1, 2: 2, 3: 1 });
    expect(r.md.split('\n').filter((l) => /^#/.test(l))).toEqual([
      '# 学习笔记', '## 第一章 概述', '### 1.1 研究背景', '## 第二章 方法'
    ]);
    expect(r.md).toContain('正文第一行，写长一点。正文第二行，紧跟上一行。');       // 段已合并 ✓
    // blocks 必须**按文档序**：标题在前、正文在后，不能按类型排 ✗
    expect(r.blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'heading', 'text', 'heading', 'text']);
  });

  it('★ 一个标题都认不出来 ⇒ ok:false 且理由说清（不许静默给一棵没骨架的树）', () => {
    const r = outline([page([
      item('这里只有正文，没有任何标题形状的行：它既没有编号，字号也与基准一致，而且左对齐。', 10.5, 60, 700)
    ])]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('一个标题都没认出来');
    expect(r.md).toBe('');
  });

  it('第一个标题之前的正文不进 md（建树时无处可挂），但**如实报**多少字没进树', () => {
    const r = outline([page([
      item('封面上的说明文字，不长。', 10.5, 60, 780),
      item('第一章 概述', 15.75, 60, 700),
      item('这一章的正文，长度足够让文字层闸门放行。', 10.5, 60, 670)
    ])]);
    expect(r.md.startsWith('# 第一章 概述')).toBe(true);
    expect(r.notes.join(' ')).toContain('第一个标题之前有');
  });
});

describe('夹具自检：纯代码生成的中文 PDF 经真 pdf.js 读回来', () => {
  it('文字层、字号、层级与夹具设计一致（夹具不成立的话，端到端断言就是假的）', async () => {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
    const buf = fx.buildUnlabeledChinesePdf();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false
    }).promise;
    expect(doc.numPages).toBe(2);
    expect(await doc.getOutline().catch(() => null)).toBe(null);          // 无书签 ✓（要测的就是这条回退）
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      const vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      pages.push({ page: n, width: vp.width, height: vp.height, rotation: vp.rotation, items: tc.items });
    }
    const r = pt.buildOutline(pages);
    expect(r.baseFontSize).toBe(10.5);
    expect(hs(r)).toEqual([
      '# 深入理解计算机系统 学习笔记',
      '## 第一章 概述', '### 1.1 研究背景',
      '## 第二章 方法', '### 2.1 顺序存储'
    ]);
    expect(r.stats.repeatedLines).toBe(4);                                // 两页的页眉 + 页脚 ✓
    expect(r.md).not.toContain('AI MindMap 文字层夹具');                    // 页眉没混进正文 ✓
    expect(r.paragraphs[0].lineCount).toBe(2);                            // 同段两行并起来了 ✓
  });
});
