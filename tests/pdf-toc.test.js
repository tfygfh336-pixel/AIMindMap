/* ============================================================
 * tests/pdf-toc.test.js — 目录块（点线 + 打印页码）的抽取判据（P1-b）
 * 运行：npx vitest run tests/pdf-toc.test.js
 * ------------------------------------------------------------
 * ⚠️ 先承认一件事（别把这份绿读成"能用于真实 PDF"）：
 *   这一档在**真实语料上零命中** —— 两份真实 PDF（30 页 / 25 页）都是
 *   `全书命中「点线+页码」的行数 = 0`（`.review/20261026-PDF-P1P4方案/out-mumuhe9jafs5.txt:9`、
 *   `out-mumuhmbscjfs.txt:9`），它们真正的目录是 `1.任务背景` 这种**无页码、无点线**的形态。
 *   ⇒ 本文件的夹具**全部是纯代码合成**（不造真 PDF、不读二进制样本），它只回答
 *   "给定这种行，抽得对不对"，**回答不了**"真书排版会不会走到这条路上"。
 *
 * 两侧判据（缺一边这批就不算数）：
 *   该有的：① 四种点线形态 + 页码（35 / 12 / 7 / 3）
 *          ② 无点线无页码的编号行 ⇒ printedPage === null，**但仍是条目**
 *          ③ buildOutline 的 toc：目录页 1 个 / 条目数与 stats 一致 / 每条的 page
 *   不该有的：④ 正文省略号　⑤ 只有间距没有点线　⑥ 目录标记之前的大标题仍参与
 *            ⑦ 更大字号的行即结束目录块
 *   回归：⑧ tests/pdf-text.test.js 38 例全绿（在门禁那条命令里，不重复放这里）
 *        ⑨ buildOutline 的返回键 = 改前那套 + toc（键名逐个还在，**不写深度快照**）
 *        另加两条"抽函数时最容易顺手改坏"的标记语义：页眉页脚行跳过但**不**结束目录块；
 *        没给条目判据 ⇒ **响亮抛错**（不许猜一套自己的判据）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pt = require('../src/pdf-text.js');
const fx = require('./pdf-fixture.js');

/** 造一个 TextItem（与 tests/pdf-text.test.js 同一形态：`height` 故意与 `transform[3]` 不同 ⇒ 读错字段会红） */
function item(str, size, x, y) {
  return {
    str: str, width: String(str).length * size, height: size * 0.77,
    fontName: 'g_d0_f1', hasEOL: false, transform: [size, 0, 0, size, x, y]
  };
}
/** 一页（A4） */
function page(items, no) { return { page: no || 1, width: fx.PAGE_W, height: fx.PAGE_H, rotation: 0, items: items }; }
/** 直接造"行"：字段形状与 `itemsToLines()` 的产出一致（喂 `extractTocEntries` 用，省掉造 TextItem） */
function line(text, size, no, extra) {
  return Object.assign({ page: (no || 1), text: text, size: (size || 10.5), repeated: false, tocEntry: false }, extra || {});
}
/** 与 `buildOutline` 传给 `extractTocEntries` 的**同一条**判据（**在调用方**，不是产品里的第二套）：
 *  「编号成立，且字号没超过基准×1.05」—— 超过就说明它是真标题、不是目录条目。 */
function entryByNumbering(l, ctx) {
  const base = ctx && ctx.baseFontSize;
  const num = pt.numbering(l.text);
  return !!num && !(base && l.size > base * 1.05);
}
/** 取标题文本/层级，便于断言 */
const hs = (r) => r.headings.map((h) => '#'.repeat(h.level) + ' ' + h.text);

/** 一本 2 页的合成书：p1 = 大标题 + 目录 + 4 条点线条目 + **一个更大字号的真标题**；p2 = 纯正文。
 *  为什么第 5 行要更大字号：目录块"遇到更大字号即结束"是既有语义（`tests/pdf-text.test.js` 的
 *  「目录页守卫」钉着），本文件用同一个形状证明抽函数之后它**没变**。 */
function bookWithToc() {
  return [
    page([
      item('数据结构笔记', 21, 234.5, 790),
      item('目录', 15.75, 60, 750),
      item('1.1 顺序存储结构………35', 10.5, 73, 720),
      item('1.2 链式存储…… 12', 10.5, 73, 703),
      item('1.3 索引….7', 10.5, 73, 686),
      item('1.4 散列. . . . 3', 10.5, 73, 669),
      item('第一章 概述', 15.75, 60, 620),                                  // 更大字号 ⇒ 结束目录块
      item('这一章讲线性表的两种存储方式，正文内容要够长。', 10.5, 60, 600)
    ], 1),
    page([
      item('顺序存储把元素放在连续的内存里，链式存储则用指针把它们连起来。', 10.5, 60, 700),
      item('两种方式各有取舍，正文继续写一些字让基准字号站稳。', 10.5, 60, 683.5)
    ], 2)
  ];
}

describe('① 该有的：四种点线形态 + 页码 ⇒ 35 / 12 / 7 / 3', () => {
  /* 四种形态各对应一个实现细节（改坏任意一个都会让这条红）：
   *   ① 三个 U+2026（`…` 这个字形本身就是三个点）
   *   ② 点线后面带空格（真实 PDF 的点线常被行重建插空格）
   *   ③ `…` 与 `.` **混排**（`….` —— 本批把尾部点线放宽到"点线接点线"就是为了它）
   *   ④ 每个点各是一个 TextItem ⇒ 行重建后是 `. . . .`（点间有空格）
   */
  const LEADERS = [
    '1.1 顺序存储结构………35',
    '1.2 链式存储…… 12',
    '1.3 索引….7',
    '1.4 散列. . . . 3'
  ];

  it('★ tocLeader 直接读：四种都给出整数页码（这条不依赖目录标记，是最小判据）', () => {
    expect(LEADERS.map((t) => pt.tocLeader(t))).toEqual([35, 12, 7, 3]);
    // 返回的是**数字**，不是字符串（下游要拿它算页偏移）
    LEADERS.forEach((t) => expect(typeof pt.tocLeader(t)).toBe('number'));
  });

  it('extractTocEntries：4 条条目、页码依次 35/12/7/3、title 里不含点线与页码', () => {
    const r = pt.extractTocEntries([line('目录', 15.75)].concat(LEADERS.map((t) => line(t, 10.5))),
      { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(r.entries.length).toBe(4);
    expect(r.entries.map((e) => e.printedPage)).toEqual([35, 12, 7, 3]);
    // 行首编号**保留**（`1.1` 不许被当成"点线"切掉）
    expect(r.entries.map((e) => e.title)).toEqual([
      '1.1 顺序存储结构', '1.2 链式存储', '1.3 索引', '1.4 散列'
    ]);
    r.entries.forEach((e) => {
      // title 已经不是"点线 + 页码"的形态（注意：**行首编号 `1.1` 里的点要保留**，
      // 所以判据不能写成"title 里一个点都没有"，只能判"结尾不再是点线/页码"）
      expect(pt.tocLeader(e.title)).toBe(null);
      expect(e.title.slice(-1)).not.toMatch(/[\d.·․…]/);
      expect(e.title.length).toBeLessThan(e.raw.length);       // 确实切掉了点线 + 页码
      expect(e.hasLeader).toBe(true);
      expect(e.page).toBe(1);                                  // 每条都记着自己所在的那一页
      expect(e.raw).toContain(e.title);                        // raw 是原行（审计用，不做二次加工）
    });
    expect(r.pages).toEqual([1]);
    expect(r.stats).toEqual({ lines: 4, withLeader: 4, withoutLeader: 0 });
  });
});

describe('② 该有的：无点线无页码的编号行 ⇒ printedPage === null，但仍是条目', () => {
  it('★ `1.任务背景` 这种形态（**真书目录的真实形状**）不许被编一个 0 / -1 / 行号', () => {
    const r = pt.extractTocEntries([
      line('目录', 15.75),
      line('1.任务背景', 10.5),
      line('2.环境准备', 10.5)
    ], { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(r.entries.map((e) => e.title)).toEqual(['1.任务背景', '2.环境准备']);
    expect(r.entries.map((e) => e.printedPage)).toEqual([null, null]);
    expect(r.entries.every((e) => e.hasLeader === false)).toBe(true);
    expect(r.stats).toEqual({ lines: 2, withLeader: 0, withoutLeader: 2 });
  });
});

describe('③ 该有的：buildOutline 的 toc（目录页 / 条目数 / 每条的 page）', () => {
  it('★ 目录页 1 个、条目数与 stats 一致、每条 page 都等于它所在的那一页', () => {
    const r = pt.buildOutline(bookWithToc());
    expect(r.ok).toBe(true);
    expect(r.toc.tocPages).toBe(1);
    expect(r.toc.pages).toEqual([1]);
    expect(r.toc.entries.length).toBe(4);
    expect(r.toc.entries.length).toBe(r.toc.stats.withLeader + r.toc.stats.withoutLeader);
    expect(r.toc.entries.map((e) => e.page)).toEqual([1, 1, 1, 1]);
    expect(r.toc.entries.map((e) => e.printedPage)).toEqual([35, 12, 7, 3]);
    // 标记语义仍落在**行对象**上（抽函数前后用的是同一个字段）
    expect(r.lines.filter((l) => l.tocEntry).length).toBe(r.toc.entries.length);
    // p2 的正文里没有编号行 ⇒ 不会被误标成目录条目
    expect(r.toc.entries.every((e) => e.page === 1)).toBe(true);
  });

  it('目录页码的读数**如实进 notes**（抽到 0 条也要说，不许静默）', () => {
    const r = pt.buildOutline(bookWithToc());
    const note = r.notes.join(' / ');
    expect(note).toContain('4 行带「点线 + 页码」');
    expect(note).toContain('0 行只有编号没有点线');
    expect(note).toContain('认出 1 个目录页 / 4 行目录条目');
  });
});

describe('④ 不该有的：正文省略号（行尾不是纯数字）', () => {
  it('★ `他说来话长……` / `…… 个` ⇒ tocLeader 返回 null（判别力：去掉"行尾纯数字"⇒ 红）', () => {
    expect(pt.tocLeader('他说来话长……')).toBe(null);
    expect(pt.tocLeader('…… 个')).toBe(null);
    expect(pt.tocLeader('这段话说来话长……')).toBe(null);
    expect(pt.tocLeader('……详见 3.5 节')).toBe(null);
  });

  it('★ 带编号的正文行也是：省略号后面没有页码 ⇒ printedPage === null（**不许编一个数**）', () => {
    const r = pt.extractTocEntries([
      line('目录', 15.75),
      line('1.2 他说来话长……', 10.5),
      line('他说来话长……', 10.5)          // 没有编号 ⇒ 条目判据说它不是条目 ⇒ 目录块到此为止
    ], { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].printedPage).toBe(null);
    expect(r.entries[0].hasLeader).toBe(false);
    expect(r.entries[0].title).toBe('1.2 他说来话长……');   // 省略号留在 title 里（它本来就不是页码）
    expect(r.stops.map((s) => s.text)).toEqual(['他说来话长……']);
  });
});

describe('⑤ 不该有的：只有间距、没有点线', () => {
  it('★ `2.1 顺序存储结构 35` 不当点线：printedPage === null，行尾那个 35 **不**被当成页码切掉', () => {
    // SPEC §1.1 ③ 点名的坑：把点线写成 `[\s.·․…]{2,}` 就会让"纯间距"假命中
    expect(pt.tocLeader('2.1 顺序存储结构 35')).toBe(null);
    const r = pt.extractTocEntries([
      line('目录', 15.75),
      line('2.1 顺序存储结构 35', 10.5)
    ], { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].printedPage).toBe(null);
    expect(r.entries[0].hasLeader).toBe(false);
    expect(r.entries[0].title).toBe('2.1 顺序存储结构 35');
  });
});

describe('⑥ 不该有的：目录标记之前的大标题不许被整页排除', () => {
  it('★ 同页"大标题 + 目录"时，大标题仍在 headings 里（整页排除会白丢一级标题）', () => {
    const r = pt.buildOutline(bookWithToc());
    expect(hs(r)).toContain('# 数据结构笔记');
    expect(hs(r)).toEqual(['# 数据结构笔记', '## 目录', '## 第一章 概述']);
    // 目录条目**不进** headings（它们是目录，不是结构）
    expect(hs(r).some((h) => h.indexOf('1.1 顺序存储结构') >= 0)).toBe(false);
  });
});

describe('⑦ 不该有的：目录块遇到更大字号的行即结束', () => {
  it('★ 那一行不进 entries，且 stats / stops 里读得出"在哪结束"', () => {
    const r = pt.buildOutline(bookWithToc());
    expect(r.toc.entries.map((e) => e.title)).not.toContain('第一章 概述');
    expect(r.toc.stops.length).toBe(1);
    expect(r.toc.stops[0].text).toBe('第一章 概述');
    expect(r.toc.stops[0].page).toBe(1);
    // 扫过 5 行（4 条条目 + 1 行把块结束掉）、只成 4 条 ⇒ 差 1 就是"在哪结束"的读数
    expect(r.toc.stats.lines).toBe(5);
    expect(r.toc.stats.lines - r.toc.entries.length).toBe(1);
    // 同一行的直接读数（不经过 buildOutline 的合成）：判据在调用方，模块只按它走
    const one = pt.extractTocEntries([
      line('目录', 15.75),
      line('1.任务背景', 10.5),
      line('第一章 概述', 15.75)
    ], { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(one.entries.map((e) => e.title)).toEqual(['1.任务背景']);
    expect(one.stats).toEqual({ lines: 2, withLeader: 0, withoutLeader: 1 });
    expect(one.stops.map((s) => s.text)).toEqual(['第一章 概述']);
  });
});

describe('回归：抽函数时最容易顺手改坏的几处', () => {
  /* 改前 `buildOutline` 里只有两样东西会"跳过但不结束"目录块：页眉页脚（`repeated`）与
   * `continue`。抽函数后必须仍是"跳过、不结束"—— 改成 `break` 会让一个页眉把整页目录截断。 */
  it('页眉页脚行：跳过、**不**结束目录块（语义与改前的 `continue` 逐条等价）', () => {
    const r = pt.extractTocEntries([
      line('目录', 15.75),
      line('内部资料 请勿外传', 9, 1, { repeated: true }),
      line('1.任务背景', 10.5),
      line('2.环境准备', 10.5)
    ], { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(r.entries.map((e) => e.title)).toEqual(['1.任务背景', '2.环境准备']);
    expect(r.stats.lines).toBe(3);         // 扫过 3 行（含被跳过的页眉）
    expect(r.stats.withLeader + r.stats.withoutLeader).toBe(2);
  });

  it('没有目录标记行 ⇒ 空结果（不猜块起点：猜出来的"目录"会把正文编号行整片吞掉）', () => {
    const r = pt.extractTocEntries([
      line('1.任务背景', 10.5),
      line('2.环境准备', 10.5)
    ], { baseFontSize: 10.5, isEntry: entryByNumbering });
    expect(r.entries).toEqual([]);
    expect(r.pages).toEqual([]);
    expect(r.stops).toEqual([]);
    expect(r.stats).toEqual({ lines: 0, withLeader: 0, withoutLeader: 0 });
  });

  it('★ 没给条目判据 ⇒ **响亮抛错**（不许模块自己发明一套判据，也不许静默返回空）', () => {
    expect(() => pt.extractTocEntries([line('目录', 15.75), line('1.任务背景', 10.5)], {}))
      .toThrow(/isEntry/);
  });

  it('⑨ buildOutline 的返回键 = 改前那套 + toc（键名**逐个**断言，不写深度快照）', () => {
    const r = pt.buildOutline(bookWithToc());
    // 改前就有这 12 个键（`src/pdf-text.js` 的 buildOutline 返回值；一个都不许少、也不许改名）
    const BEFORE = ['ok', 'reason', 'md', 'baseFontSize', 'sizeBuckets', 'headings', 'paragraphs',
      'lines', 'blocks', 'textLayer', 'stats', 'notes'];
    BEFORE.forEach((k) => expect(Object.prototype.hasOwnProperty.call(r, k)).toBe(true));
    expect(Object.prototype.hasOwnProperty.call(r, 'toc')).toBe(true);
    // 也没有多出别的键（多了就是"顺手改了返回形状"）
    expect(Object.keys(r).slice().sort()).toEqual(BEFORE.concat(['toc']).sort());
    // 失败路径也带 toc，且形状齐全（调用方不必按 ok 分支去猜键在不在）
    const bad = pt.buildOutline([page([item('字'.repeat(5), 10, 60, 700)], 1)]);
    expect(bad.ok).toBe(false);
    expect(bad.toc).toEqual({ entries: [], pages: [], tocPages: 0,
      stats: { lines: 0, withLeader: 0, withoutLeader: 0 }, stops: [] });
  });
});
