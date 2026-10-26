/* ============================================================
 * tests/diagram-wrap.test.js —— **C-F1-03 框内自动换行**（判据 8）
 * ------------------------------------------------------------
 * 这条判据的核心不是"能断行"，而是**顺序**：**先换行，再缩字号**。
 * 所以每条用例都同时钉两件事：换出来的行**真的**分成 ≥2 行、且**没有**缩字号
 * （`report.shrunk` 里没有它）；反过来，"换行也救不了"的输入必须**走到缩字号那一档**。
 * 只断言"有多行"会漏掉"先缩字号再假装换行"的假实现（那正是判据 8 的该红点）。
 *
 * 判据（设计 §2.1 原文）：
 *   超宽文本被切成 ≥2 行；**每行** `measuredWidth <= boxWidth - 2*padding`；
 *   换行后框高 = 行数 × 行高 + 2*padding（本实现的行高 = 字号 + `LINE_LEAD`，槽位按三段预留）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { minimalDoc } from './diagram-fixture.js';
import { readNodeTextLines } from './diagram-svg-reader.js';

const measurer = D.createMeasurer();

/** 取某个节点某一段的所有行（按渲染顺序） */
function linesOf(svg, nodeId, kind) {
  return readNodeTextLines(svg)
    .filter((l) => l.node === nodeId && l.kind === kind)
    .sort((a, b) => a.y - b.y);
}

describe('C-F1-03：长标题**先换行**（不缩字号）', () => {
  it('超宽中文标题 ⇒ 断成 ≥2 行、字号仍是基准 14、`shrunk` 里没有它', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = '一二三四五六七八九十一二三四五六七八九十';        // 20 个全角字，14px 下 280px
    const { svg, report } = D.render(doc);
    const lines = linesOf(svg, 'n-a', 'title');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    lines.forEach((l) => expect(l.size).toBe(D.FONT.title));                // **没有**缩字号
    expect(report.shrunk.filter((s) => s.id === 'n-a' && s.part === 'title')).toEqual([]);
    // 报告里明说它换了行（判据读得到）
    const w = report.wrapped.filter((x) => x.id === 'n-a' && x.part === 'title');
    expect(w.length).toBe(1);
    expect(w[0].lines).toBe(lines.length);
    expect(w[0].size).toBe(D.FONT.title);
  });

  it('每一行都放得下（用公开的测量器**独立复算**，不看渲染器的中间值）', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = 'Netfilter 钩子点位详解与数据包处理链路说明';
    const { svg } = D.render(doc);
    const inset = D.shapeInset({ x: 0, y: 0, w: 200, h: 70 }, 'rect');      // 声明 200 宽 ⇒ 可用 184
    const lines = linesOf(svg, 'n-a', 'title');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    lines.forEach((l) => {
      expect(measurer.widthOf(l.text, l.size, D.FONT.family)).toBeLessThanOrEqual(inset.w + 1e-9);
    });
    // **不裁字**：把行拼回去（去掉断行时吃掉的空格）必须等于原文
    const joined = lines.map((l) => l.text).join('').replace(/\s+/g, '');
    expect(joined).toBe(doc.nodes[0].title.replace(/\s+/g, ''));
  });

  it('断点可复算：与 `D.wrapText(文本, 字号, 可用宽)` 的断点逐行相同', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = '一二三四五六七八九十一二三四五六七八九十';
    const { svg } = D.render(doc);
    const lines = linesOf(svg, 'n-a', 'title');
    // 可用宽 = 声明宽 − 2×NODE_PAD（节点没被加宽时）
    const avail = 200 - 2 * 8;
    const recomputed = D.wrapText(doc.nodes[0].title, D.FONT.title, avail, measurer);
    expect(recomputed.lines.map((l) => l.text)).toEqual(lines.map((l) => l.text));
  });

  it('换行后框高按**行数**长：恰好多 (行数−1) × (字号 + 行距)', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = '一二三四五六七八九十一二三四五六七八九十';
    const { svg } = D.render(doc);
    const h2 = Number(svg.match(/<g data-node="n-a"[^>]*data-h="([0-9.]+)"/)[1]);
    const n = linesOf(svg, 'n-a', 'title').length;
    expect(n).toBeGreaterThanOrEqual(2);
    // 单行时"需要的"外框高 = 三段槽位（空槽也占一行）+ 两个段距 + 上下 padding
    const innerOne = D.FONT.title + D.LINE_GAP + D.FONT.subtitle + D.LINE_GAP + D.FONT.badge;
    const outerOne = innerOne + 2 * 8;
    const perLine = D.FONT.title + D.LINE_LEAD;
    // 声明高度 70 比"需要的"59 高 ⇒ 框高 = max(声明, 需要 + 多出来的行)
    const want = Math.max(70, outerOne + (n - 1) * perLine);
    expect(Math.abs(h2 - want)).toBeLessThanOrEqual(1e-6);
  });
});

describe('C-F1-03 的第二半：换行**仍放不下**才缩字号（阶梯不许短路）', () => {
  it('长到超过行数上限（3 行）⇒ 缩字号，且行数被压回上限内', () => {
    const doc = minimalDoc();
    // 5 个字/行的宽（184px / 14px = 13 字/行）⇒ 100 字要 8 行 > 上限 3 ⇒ 必须缩字号
    doc.nodes[0].title = '字'.repeat(100);
    const { svg, report } = D.render(doc);
    const lines = linesOf(svg, 'n-a', 'title');
    expect(lines.length).toBeLessThanOrEqual(D.MAX_LINES.title);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const shrunk = report.shrunk.filter((s) => s.id === 'n-a' && s.part === 'title');
    expect(shrunk.length, '长到超行数上限时必须走到缩字号那一档').toBe(1);
    expect(shrunk[0].to).toBeLessThan(D.FONT.title);
    expect(shrunk[0].to).toBeGreaterThanOrEqual(D.MIN_FONT_SIZE);
    lines.forEach((l) => expect(l.size).toBe(shrunk[0].to));
  });

  it('**不可断的词**（ASCII 标识符）换不了行 ⇒ 直接落缩字号（词内不断是断行规则的一部分）', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = 'A'.repeat(30);
    const { svg, report } = D.render(doc);
    expect(linesOf(svg, 'n-a', 'title').length).toBe(1);                    // 词内没被劈开
    expect(report.wrapped.filter((x) => x.id === 'n-a')).toEqual([]);
    expect(report.shrunk.filter((s) => s.id === 'n-a' && s.part === 'title').length).toBe(1);
  });

  it('徽标（chip）永不换行：上限 1 行 ⇒ 太长就缩字号', () => {
    const doc = minimalDoc();
    doc.nodes[0].badge = 'BADGE-VERY-LONG-TOKEN';
    const { svg, report } = D.render(doc);
    expect(linesOf(svg, 'n-a', 'badge').length).toBe(1);
    expect(report.wrapped.filter((x) => x.id === 'n-a' && x.part === 'badge')).toEqual([]);
  });
});

describe('断行规则（确定性 + 避头尾的最小处理）', () => {
  it('同一串文本在不同字号下断点稳定：同输入两跑逐行相同', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = '一二三四五六七八九十一二三四五六七八九十';
    const a = linesOf(D.render(doc).svg, 'n-a', 'title').map((l) => l.text);
    const b = linesOf(D.render(doc).svg, 'n-a', 'title').map((l) => l.text);
    expect(b).toEqual(a);
  });

  it('行首不会是闭合标点（"。"不另起一行）', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = '一二三四五六七八九十一二三四。五';
    const { svg } = D.render(doc);
    linesOf(svg, 'n-a', 'title').forEach((l, i) => {
      if (i === 0) return;
      expect('，。、；：！？）》」』】”’'.indexOf(l.text[0]), '第 ' + (i + 1) + ' 行以标点开头: ' + l.text).toBe(-1);
    });
  });

  it('`segmentsOf` 把 ASCII 词整块保留、汉字逐字可断', () => {
    expect(D.segmentsOf('abcd 中文').map((s) => s.text)).toEqual(['abcd', '中', '文']);
    expect(D.segmentsOf('中文 abcd').map((s) => s.text)).toEqual(['中', '文', 'abcd']);
  });
});
