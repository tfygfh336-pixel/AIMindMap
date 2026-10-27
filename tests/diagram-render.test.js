/* ============================================================
 * tests/diagram-render.test.js —— MS1 渲染内核的**判据**（每条都带"该红"的注入位）
 * ------------------------------------------------------------
 * 判据来源 = `docs/DIAGRAM-MODES.md` §2 的编号 + 父批 §三 的验收表。这里逐条对上：
 *   `C-F1-01` 六形状 / `C-F1-02` 三段式 / `C-F1-04` 缩字号 / `C-F1-05` 溢出为 0 /
 *   `C-F2-01`…`C-F2-06` 容器与层带 / `C-F3-02` 端口 / `C-F3-04` straight / `C-F3-07`/`08` 箭头 /
 *   `C-F8-01` 无外链 / `C-F9-02` 逐字节稳定 / 父批 §一 第 7 条 z-order / 第 10 条确定性。
 *
 * ⚠️ 本文件**刻意不**断言"看起来像一张图"：全部断言都是**可量的读数**（坐标、顺序、字号、
 *    宽度、sha256、错误码）。判别力怎么证明：`.review/20261056-MS1渲染内核/inject-red.js`
 *    逐条把被测行为改坏一档，跑本文件必须红（读数存在那个目录的 `inject-red.txt`）。
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { netfilterDoc, sixShapesDoc, minimalDoc } from './diagram-fixture.js';

/* ---------------- 解析小工具（只读 SVG 字符串，不碰 DOM） ---------------- */

/** 取某个 `<g data-node="id" ...>` 的开标签属性 */
function groupAttrs(svg, attr, value) {
  const re = new RegExp('<g data-' + attr + '="' + value + '"[^>]*>');
  const m = svg.match(re);
  if (!m) return null;
  const out = {};
  m[0].replace(/data-([a-z-]+)="([^"]*)"/g, (all, k, v) => { out[k] = v; });
  return out;
}

/** 取某节点分组内部的片段（到下一个 `</g>` 为止；节点内部没有嵌套 g） */
function groupBody(svg, attr, value) {
  const start = svg.indexOf('<g data-' + attr + '="' + value + '"');
  if (start < 0) return null;
  const end = svg.indexOf('</g>', start);
  return svg.slice(start, end);
}

/** 把 `x="1"` 这类属性读成数字表 */
function numAttrs(tag, names) {
  const out = {};
  names.forEach((n) => {
    const m = tag.match(new RegExp('\\b' + n + '="(-?[0-9.]+)"'));
    out[n] = m ? Number(m[1]) : NaN;
  });
  return out;
}

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

/** 六种形状的期望（`C-F1-01` 的"圆角半径按类型取固定 token"） */
const SHAPES = ['rect', 'round', 'diamond', 'pill', 'cylinder', 'row'];

describe('C-F1-01 六种形状几何', () => {
  it('六种形状各画出一个节点，且元素类型与类型对得上', () => {
    const { svg, report } = D.render(sixShapesDoc());
    SHAPES.forEach((t) => {
      expect(svg, '缺形状: ' + t).toContain('data-shape="' + t + '"');
    });
    expect(report.counts.nodes).toBe(6);
    // diamond 必须是 polygon（画成 rect 就红 —— 这就是"把 diamond 画成 rect"的注入位）
    expect(groupBody(svg, 'node', 'shape-diamond')).toContain('<polygon');
    // round / pill / rect 都是 rect，但圆角不同（只看**形状那一枚** rect：徽标 chip 也是 rect）
    const shapeRect = (id) => (groupBody(svg, 'node', id).match(/<rect[^>]*>/) || [''])[0];
    expect(shapeRect('shape-round')).toMatch(/\brx="8"/);
    expect(shapeRect('shape-rect')).not.toMatch(/\brx="/);
    // pill 的圆角 = 高的一半
    const pill = groupAttrs(svg, 'node', 'shape-pill');
    expect(shapeRect('shape-pill')).toContain('rx="' + Number(pill.h) / 2 + '"');
    // cylinder 是柱体 path + 顶部椭圆弧
    expect(groupBody(svg, 'node', 'shape-cylinder')).toMatch(/<path d="M /);
    // row 是 rect + 底部分隔线（表行）
    expect(groupBody(svg, 'node', 'shape-row')).toContain('data-row-divider="1"');
  });

  it('diamond 的四个顶点 = 其 rect 四条边的中点（±0.5px）', () => {
    const { svg } = D.render(sixShapesDoc());
    const g = groupAttrs(svg, 'node', 'shape-diamond');
    const body = groupBody(svg, 'node', 'shape-diamond');
    const m = body.match(/<polygon points="([^"]+)"/);
    expect(m).toBeTruthy();
    const pts = m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    expect(pts).toHaveLength(4);
    const x = Number(g.x);
    const y = Number(g.y);
    const w = Number(g.w);
    const h = Number(g.h);
    const want = [
      [x + w / 2, y],               // 上
      [x + w, y + h / 2],           // 右
      [x + w / 2, y + h],           // 下
      [x, y + h / 2]                // 左
    ];
    pts.forEach((p, i) => {
      expect(Math.abs(p[0] - want[i][0]), 'p' + i + '.x').toBeLessThanOrEqual(0.5);
      expect(Math.abs(p[1] - want[i][1]), 'p' + i + '.y').toBeLessThanOrEqual(0.5);
    });
  });
});

describe('C-F1-02 三段式（主标题 / 副标题 / 徽标，字号各自独立）', () => {
  it('三段都在，字号互不相同，基线 y 互不相等且顺序固定', () => {
    const { svg } = D.render(minimalDoc());
    const body = groupBody(svg, 'node', 'n-a');
    const parts = {};
    body.replace(/<text class="mm-node-(\w+)" x="(-?[0-9.]+)" y="(-?[0-9.]+)"[^>]*font-size="([0-9.]+)"[^>]*data-text="(\w+)"/g,
      (all, cls, x, y, size, kind) => { parts[kind] = { x: Number(x), y: Number(y), size: Number(size) }; return all; });
    expect(Object.keys(parts).sort()).toEqual(['badge', 'subtitle', 'title']);
    // 字号各自独立（三段同一字号 ⇒ 红）
    expect(new Set([parts.title.size, parts.subtitle.size, parts.badge.size]).size).toBe(3);
    // 基线互不相等且 title < subtitle < badge
    expect(parts.title.y).toBeLessThan(parts.subtitle.y);
    expect(parts.subtitle.y).toBeLessThan(parts.badge.y);
  });

  it('任一段缺失时其余两段的位置**不变**（槽位恒定预留，不塌陷）', () => {
    const full = D.render(minimalDoc()).svg;
    const doc = minimalDoc();
    delete doc.nodes[0].subtitle;                       // 只删副标题
    const less = D.render(doc).svg;
    const yOf = (svg, kind) => {
      const body = groupBody(svg, 'node', 'n-a');
      const m = body.match(new RegExp('<text class="mm-node-' + kind + '"[^>]*y="(-?[0-9.]+)"'));
      return m ? Number(m[1]) : null;
    };
    expect(yOf(less, 'subtitle')).toBeNull();            // 确实没画
    expect(yOf(less, 'title')).toBe(yOf(full, 'title')); // 标题位置不动
    expect(yOf(less, 'badge')).toBe(yOf(full, 'badge')); // 徽标位置不动
  });
});

describe('父批 §一 第 7 条：z-order 逐字 = layers, containers, nodes, edges, edgeLabels, annotations', () => {
  it('SVG 里 6 个 g[data-z] 的**元素顺序**逐字相同', () => {
    const { svg, report } = D.render(netfilterDoc());
    const zs = Array.from(svg.matchAll(/data-z="([^"]+)"/g)).map((m) => m[1]);
    expect(zs).toEqual(D.Z_ORDER);
    expect(zs).toEqual(['layers', 'containers', 'nodes', 'edges', 'edgeLabels', 'annotations']);
    expect(report.zOrder).toEqual(zs);
    // 顺序判据 = **文件里的偏移量**（"看起来在下面"不算证据）
    const at = (z) => svg.indexOf('data-z="' + z + '"');
    for (let i = 1; i < zs.length; i++) expect(at(zs[i - 1])).toBeLessThan(at(zs[i]));
  });

  it('层带确实在节点之前（把层带放到节点之后 ⇒ 这条红）', () => {
    const { svg } = D.render(netfilterDoc());
    expect(svg.indexOf('data-z="layers"')).toBeLessThan(svg.indexOf('data-z="nodes"'));
    expect(svg.indexOf('data-layer="l-core"')).toBeLessThan(svg.indexOf('data-node="n-ct"'));
  });
});

describe('C-F2-04 / C-F2-06 层带与水印', () => {
  it('每条层带的 rect 与其 fill 都按数据画出来', () => {
    const { svg, report } = D.render(netfilterDoc());
    expect(report.counts.layers).toBe(3);
    const g = groupAttrs(svg, 'layer', 'l-core');
    expect([Number(g.x), Number(g.y), Number(g.w), Number(g.h)]).toEqual([0, 250, 1200, 300]);
    expect(svg).toContain('fill="#f4f7f2"');
  });

  it('水印落在**留白区**：水印矩形与任何节点/容器矩形零相交，且 opacity < 1', () => {
    const { svg, report } = D.render(netfilterDoc());
    expect(report.watermarks.length).toBe(2);
    // 属性按**逐个读**的方式取（不假设属性顺序 —— 那是给判据埋一个会随排版漂的雷）
    const boxes = [];
    (svg.match(/<text class="mm-watermark"[^>]*>/g) || []).forEach((tag) => {
      const box = tag.match(/data-box="(-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+)"/);
      const op = tag.match(/fill-opacity="([0-9.]+)"/);
      boxes.push({ x: Number(box[1]), y: Number(box[2]), w: Number(box[3]), h: Number(box[4]),
        opacity: op ? Number(op[1]) : 1 });
    });
    expect(boxes.length).toBe(2);
    // 节点/容器矩形从 SVG 里**独立**读一遍（不复用渲染器的内部状态）
    const rects = [];
    (svg.match(/<g data-(?:node|container)="[^"]+"[^>]*>/g) || []).forEach((tag) => {
      const r = numAttrs(tag, ['data-x', 'data-y', 'data-w', 'data-h']);
      rects.push({ x: r['data-x'], y: r['data-y'], w: r['data-w'], h: r['data-h'] });
    });
    expect(rects.length).toBeGreaterThan(0);
    boxes.forEach((b) => {
      expect(b.opacity).toBeLessThan(1);
      rects.forEach((r) => {
        const hit = b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h;
        expect(hit, '水印压到框: ' + JSON.stringify(b) + ' vs ' + JSON.stringify(r)).toBe(false);
      });
    });
  });

  it('层带重叠 ⇒ 响亮报错（背景分区说同一块地是谁的）', () => {
    const doc = minimalDoc();
    doc.graph.layers = [
      { id: 'l-a', rect: [0, 0, 400, 200], watermark: { text: 'A' } },
      { id: 'l-b', rect: [200, 100, 400, 200] }
    ];
    expect(() => D.render(doc)).toThrow(/重叠/);
  });
});

describe('C-F2-02 / C-F2-03 容器：stack 高度是算式，free 坐标是声明值', () => {
  it('stack 容器高 = 子项高之和 + padding×2 + gap×(n−1)，子项纵向等距', () => {
    const { svg, report } = D.render(netfilterDoc());
    const c = groupAttrs(svg, 'container', 'c-rows');
    const pad = Number(c.pad);
    const gap = Number(c.gap);
    expect(pad).toBe(12);
    expect(gap).toBe(8);
    const a = groupAttrs(svg, 'node', 'n-log');
    const b = groupAttrs(svg, 'node', 'n-log2');
    const hSum = Number(a.h) + Number(b.h);
    // **算式**（高度写死 ⇒ 这条红：数据里声明的是 120）
    expect(Number(c.h)).toBe(hSum + pad * 2 + gap * (2 - 1));
    expect(Number(c.h)).not.toBe(120);
    // 子项纵向等距：间距两两相等（±0.5px），且第一个子项贴着上内边距
    const spacing = Number(b.y) - (Number(a.y) + Number(a.h));
    expect(Math.abs(spacing - gap)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Number(a.y) - (Number(c.y) + pad))).toBeLessThanOrEqual(0.5);
    expect(Number(a.x)).toBe(Number(c.x) + pad);
    // 容器宽不窄于子项 + 两侧内边距
    expect(Number(c.w)).toBeGreaterThanOrEqual(Number(a.w) + pad * 2);
    expect(report.counts.containers).toBe(2);
  });

  it('free 容器：子项坐标逐个等于声明值，容器高 = 子项包围盒 + 内边距', () => {
    const { svg } = D.render(netfilterDoc());
    const c = groupAttrs(svg, 'container', 'c-free');
    const a = groupAttrs(svg, 'node', 'n-ct');
    const b = groupAttrs(svg, 'node', 'n-filter');
    // 声明值就是最终值（`C-F2-03`）
    expect([Number(a.x), Number(a.y)]).toEqual([110, 300]);
    expect([Number(b.x), Number(b.y)]).toEqual([370, 300]);
    const pad = Number(c.pad);
    const maxBottom = Math.max(Number(a.y) + Number(a.h), Number(b.y) + Number(b.h));
    expect(Math.abs(Number(c.h) - (maxBottom + pad - Number(c.y)))).toBeLessThanOrEqual(0.5);
    expect(Number(c.y)).toBe(260);                      // = min(声明 y, 子项顶 − pad)
  });
});

describe('C-F1-04 / C-F1-05 文本永不溢出（缩字号 → 加宽 → 响亮报错）', () => {
  const measurer = D.createMeasurer();

  // ⚠️ **MS2 改了这三条的输入，不是改了它们要保的东西**：
  //   阶梯从 MS1 的"缩字号 → 加宽 → 报错"变成"**换行** → 缩字号 → 加宽 → 报错"（`C-F1-03`）。
  //   于是"能被换行救下"的长中文标题不再走缩字号 —— 那正是本批要的行为。
  //   为了继续钉住缩字号/加宽/报错三档，这里的用例改用**不可断的词**
  //   （ASCII 标识符：断行规则里"词内不断"，所以它只能靠缩字号/加宽/报错解决）。
  //   "换行优先"那条判据由 `tests/diagram-wrap.test.js` 单独钉（判据 8）。
  it('不可断的超宽标题先**缩字号**（逐档下调，仍 ≥ 8.5）', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = 'A'.repeat(30);               // 30 个 ASCII 字符 ⇒ 14px 下 231px > 184px 可用
    const { svg, report } = D.render(doc);
    expect(report.widened.length).toBe(0);              // 这一档还没动用加宽
    expect(report.shrunk.length).toBe(1);
    const s = report.shrunk[0];
    expect(s.part).toBe('title');
    expect(s.from).toBe(D.FONT.title);
    expect(s.to).toBeLessThan(D.FONT.title);
    expect(s.to).toBeGreaterThanOrEqual(D.MIN_FONT_SIZE);
    const body = groupBody(svg, 'node', 'n-a');
    expect(body).toContain('data-text="title" data-font-size="' + s.to + '"');
    // 换算可复算：缩到的那一档确实放得下
    expect(measurer.widthOf(doc.nodes[0].title, s.to, D.FONT.family))
      .toBeLessThanOrEqual(Number(groupAttrs(svg, 'node', 'n-a').w) - 2 * 8 + 1e-9);
  });

  it('最小字号仍放不下 ⇒ **加宽节点**（并重排该容器），不裁字', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = 'B'.repeat(40);               // 不可断词：8.5px 下 187px > 184px ⇒ 只能加宽
    const { svg, report } = D.render(doc);
    expect(report.widened.length).toBe(1);
    const g = groupAttrs(svg, 'node', 'n-a');
    expect(Number(g.w)).toBeGreaterThan(200);           // 声明 200，被加宽
    expect(Number(g.w)).toBeGreaterThanOrEqual(40 * 0.55 * D.MIN_FONT_SIZE);
    // 加宽后照样放得下（**不裁**：文本仍是全的）
    const body = groupBody(svg, 'node', 'n-a');
    expect(body).toContain('B'.repeat(40));
  });

  it('加宽有上界：超长文案 ⇒ 响亮报错（不许无限加宽，也不许裁字）', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = 'C'.repeat(500);              // 8.5px 下 2337px > 2000px 上限（且词内不可断）
    let err = null;
    try { D.render(doc); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('E_TEXT_OVERFLOW');
    expect(err.message).toMatch(/最小字号/);
  });

  it('全图逐节点自检：每段文本宽度 ≤ 可用宽度（溢出计数必须为 0）', () => {
    const { svg, report } = D.render(netfilterDoc());
    expect(report.overflowCount).toBe(0);
    // **独立复算**：从 SVG 读数 + 公开的测量器重新量一遍，不看渲染器内部的中间值
    let checked = 0;
    (svg.match(/<g data-node="[^"]+"[^>]*>[\s\S]*?<\/g>/g) || []).forEach((group) => {
      const open = group.match(/<g data-node="([^"]+)" data-shape="([^"]+)"[^>]*>/);
      const id = open[1];
      const shape = open[2];
      const r = numAttrs(open[0], ['data-x', 'data-y', 'data-w', 'data-h']);
      const box = { x: r['data-x'], y: r['data-y'], w: r['data-w'], h: r['data-h'] };
      const inset = D.shapeInset(box, shape);
      (group.match(/<text class="mm-node-(?:title|subtitle|badge)"[^>]*>/g) || []).forEach((tag) => {
        const kind = tag.match(/data-text="(\w+)"/)[1];
        const size = Number(tag.match(/\sfont-size="([0-9.]+)"/)[1]);
        const body = group.slice(group.indexOf(tag) + tag.length);
        const text = body.slice(0, body.indexOf('<')).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const need = measurer.widthOf(text, size, D.FONT.family);
        expect(need, id + '/' + kind).toBeLessThanOrEqual(inset.w + 1e-9);
        expect(size).toBeGreaterThanOrEqual(D.MIN_FONT_SIZE - 1e-9);
        checked++;
      });
    });
    expect(checked).toBeGreaterThanOrEqual(9 * 3);      // 9 个节点 × 三段（缺段不计）
  });
});

describe('C-F3-02 / C-F3-04 / C-F3-07 / C-F3-08 端口、直线、两端独立箭头', () => {
  it('指定端口 ⇒ 端点 = 该端口坐标（±0.5px）', () => {
    const { svg } = D.render(netfilterDoc());
    const from = groupAttrs(svg, 'node', 'n-nic');
    const to = groupAttrs(svg, 'node', 'n-hook');
    const line = svg.match(/<line data-edge="e1"[^>]*>/)[0];
    const n = numAttrs(line, ['x1', 'y1', 'x2', 'y2']);
    expect(Math.abs(n.x1 - (Number(from.x) + Number(from.w)))).toBeLessThanOrEqual(0.5);   // e 端口
    expect(Math.abs(n.y1 - (Number(from.y) + Number(from.h) / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(n.x2 - Number(to.x))).toBeLessThanOrEqual(0.5);                        // w 端口
    expect(Math.abs(n.y2 - (Number(to.y) + Number(to.h) / 2))).toBeLessThanOrEqual(0.5);
  });

  it('未指定端口 ⇒ 自动选边：选的是**代价最小**的一对，相等时按 n<e<s<w 定序', () => {
    const { svg } = D.render(netfilterDoc());
    const line = svg.match(/<line data-edge="e5"[^>]*>/)[0];
    // **独立复算**：从 SVG 里的两个 rect 自己算 4×4 距离（不调渲染器的 autoPorts）
    const rectOf = (id) => {
      const g = groupAttrs(svg, 'node', id);
      return { x: Number(g.x), y: Number(g.y), w: Number(g.w), h: Number(g.h) };
    };
    const port = (r, p) => (p === 'n' ? [r.x + r.w / 2, r.y]
      : p === 's' ? [r.x + r.w / 2, r.y + r.h]
        : p === 'e' ? [r.x + r.w, r.y + r.h / 2] : [r.x, r.y + r.h / 2]);
    const order = ['n', 'e', 's', 'w'];
    const a = rectOf('n-log2');
    const b = rectOf('n-egress');
    let best = null;
    order.forEach((pf) => {
      order.forEach((pt) => {
        const p1 = port(a, pf);
        const p2 = port(b, pt);
        const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        if (!best || d < best.d - 1e-9) best = { pf: pf, pt: pt, d: d };   // 严格小于 ⇒ 先到先得 = n<e<s<w
      });
    });
    expect(line).toContain('data-from-port="' + best.pf + '"');
    expect(line).toContain('data-to-port="' + best.pt + '"');
    // 同一份数据再跑一次：端口选择不许变
    const again = D.render(netfilterDoc()).svg.match(/<line data-edge="e5"[^>]*>/)[0];
    expect(again).toBe(line);
  });

  it('只指定一端端口 ⇒ **指定端不变**，另一端按剩余四个里的最小代价选', () => {
    const doc = minimalDoc({ graph: { edges: [{ id: 'e1', from: { node: 'n-a', port: 'e' }, to: { node: 'n-b' } }] } });
    const { svg } = D.render(doc);
    const line = svg.match(/<line data-edge="e1"[^>]*>/)[0];
    expect(line).toContain('data-from-port="e"');            // 用户指定的端口不许被自动选边改掉
    const a = groupAttrs(svg, 'node', 'n-a');
    const b = groupAttrs(svg, 'node', 'n-b');
    const port = (g, p) => (p === 'n' ? [Number(g.x) + Number(g.w) / 2, Number(g.y)]
      : p === 's' ? [Number(g.x) + Number(g.w) / 2, Number(g.y) + Number(g.h)]
        : p === 'e' ? [Number(g.x) + Number(g.w), Number(g.y) + Number(g.h) / 2]
          : [Number(g.x), Number(g.y) + Number(g.h) / 2]);
    const from = port(a, 'e');
    let best = null;
    ['n', 'e', 's', 'w'].forEach((pt) => {
      const q = port(b, pt);
      const d = Math.hypot(q[0] - from[0], q[1] - from[1]);
      if (!best || d < best.d - 1e-9) best = { pt: pt, d: d };
    });
    expect(line).toContain('data-to-port="' + best.pt + '"');
  });

  it('straight 路由 = 一条线段（没有中间折点）', () => {
    const { svg } = D.render(netfilterDoc());
    const lines = svg.match(/<line data-edge="[^"]+"[^>]*>/g) || [];
    expect(lines.length).toBe(6);
    lines.forEach((l) => expect(l).not.toMatch(/\bL\b|\bpath\b/));
  });

  it('arrow.start && arrow.end ⇒ **两端**都有箭头；只开 end ⇒ 起点没有', () => {
    const { svg } = D.render(netfilterDoc());
    const arrows = (id) => Array.from(svg.matchAll(new RegExp('<polygon data-arrow="(start|end)" data-edge="' + id + '"', 'g')))
      .map((m) => m[1]).sort();
    expect(arrows('e4')).toEqual(['end', 'start']);     // 双向
    expect(arrows('e1')).toEqual(['end']);              // 单向（缺省只要末端）
  });

  it('起点箭头尖端 = 路径起点（±0.5px）：两端的箭头都是**独立**的', () => {
    const { svg } = D.render(netfilterDoc());
    const line = numAttrs(svg.match(/<line data-edge="e4"[^>]*>/)[0], ['x1', 'y1', 'x2', 'y2']);
    const poly = (kind) => {
      const m = svg.match(new RegExp('<polygon data-arrow="' + kind + '" data-edge="e4" points="([^"]+)"'));
      return m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    };
    const end = poly('end');
    const start = poly('start');
    expect(Math.abs(end[0][0] - line.x2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(end[0][1] - line.y2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(start[0][0] - line.x1)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(start[0][1] - line.y1)).toBeLessThanOrEqual(0.5);
  });
});

describe('路由三档：`curve` 已实现，未实现的取值仍**响亮拒绝**', () => {
  // 2026-10-26：`curve` 补上（`C-F3-05`）。这条用例因此从"必须抛"翻成"必须**真的画出曲线**"，
  // 但**红线没变**：静默画成直线 = 把"没做"说成"做了"，所以判据是"产物里有 `C` 命令 + 控制点"。
  it('route = curve ⇒ 真的画三次贝塞尔（`C` 命令 + data-c1/data-c2），不是直线', () => {
    const doc = netfilterDoc();
    doc.graph.edges[0].route = 'curve';
    const { svg, report } = D.render(doc);
    const g = svg.match(/<g data-edge="e1"[^>]*data-route="curve"[^>]*data-c1="([^"]+)" data-c2="([^"]+)"/);
    expect(g, 'route=curve 的边没有控制点属性').toBeTruthy();
    const path = svg.match(/<path data-curve="1" data-edge="e1" d="M ([^"]+)"/);
    expect(path, 'route=curve 的边没有画成 path').toBeTruthy();
    expect(path[1]).toContain('C');                        // 三次贝塞尔命令
    expect(svg).not.toMatch(/<line data-edge="e1"/);       // 不许退化成直线
    expect(report.notImplemented).not.toContain('route:curve');
  });

  it('未实现的取值（`spline`）⇒ 数据层**判红**（`E_GRAPH`，报错文案列出合法三档）', () => {
    // ⚠️ 分两层判，别混：**数据非法**由 `validateGraph` 挡（`E_GRAPH`）；
    //    `E_ROUTE_UNSUPPORTED` 是"规范里有、这批没实现"那一档（今天规范与实现相等 ⇒ 走不到），
    //    它是**守门员**，下面一条用例直接喂给它验 —— 否则那不是判据，是死代码。
    const doc = netfilterDoc();
    doc.graph.edges[0].route = 'spline';
    let err = null;
    let out = null;
    try { out = D.render(doc); } catch (e) { err = e; }
    expect(err, 'route=spline 被静默接受了').not.toBeNull();
    expect(err.code).toBe('E_GRAPH');
    expect(err.message).toContain('spline');
    expect(out).toBeNull();                            // 不许"报错还给出图"
  });

  it('守门员：`resolveEdge` 遇到未实现的 route ⇒ `E_ROUTE_UNSUPPORTED`，并列出已实现的三档', () => {
    const views = new Map([['n-a', { rect: { x: 0, y: 0, w: 80, h: 40 } }],
      ['n-b', { rect: { x: 200, y: 0, w: 80, h: 40 } }]]);
    let err = null;
    try {
      D.resolveEdge({ id: 'ex', from: { node: 'n-a' }, to: { node: 'n-b' }, route: 'bspline' }, views, null);
    } catch (e) { err = e; }
    expect(err, '守门员没拦住').not.toBeNull();
    expect(err.code).toBe('E_ROUTE_UNSUPPORTED');
    expect(err.detail.implemented).toEqual(['straight', 'orthogonal', 'curve']);
    expect(err.message).toContain('bspline');
  });

  // 反过来的一半：`orthogonal` **MS2 起真的做了** ⇒ 它必须**不再**拒绝，而且真的绕线。
  // （判定标准从"抛不抛"变成了"有没有折点/有没有 `data-points`"—— 否则"接受了但画成直线"看不出来。）
  it('route = orthogonal ⇒ 不再拒绝，且在**给定坐标**上真的绕线（不是静默直线）', () => {
    const doc = netfilterDoc();
    doc.graph.edges.forEach((e) => delete e.route);      // 先全清成缺省
    doc.graph.edges[0].route = 'orthogonal';
    const { svg, report } = D.render(doc, { routing: 'orthogonal' });
    expect(report.routing.enabled).toBe(true);
    const g = svg.match(/<g data-edge="e1"[^>]*data-from-port="[^"]*"[^>]*data-points="([^"]*)"/);
    expect(g, 'orthogonal 边没有折线数据（被画成直线了）').toBeTruthy();
    const pts = g[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    expect(pts.length).toBeGreaterThanOrEqual(3);          // 直连只需 2 个点；≥3 = 真的有折点
    // 每一段都与轴平行（手写坐标不在 8px 网格上，所以这里**不**断言网格对齐 ——
    // 网格那条判据属于自动布局的产物，见 tests/diagram-route.test.js）
    for (let i = 0; i + 1 < pts.length; i++) {
      const horizontal = Math.abs(pts[i][1] - pts[i + 1][1]) < 1e-6;
      const vertical = Math.abs(pts[i][0] - pts[i + 1][0]) < 1e-6;
      expect(horizontal || vertical, '第 ' + i + ' 段不是轴向: ' + JSON.stringify([pts[i], pts[i + 1]])).toBe(true);
    }
  });

  it('route 缺省 = straight（不是 orthogonal）—— 否则没写 route 的老数据会变产物', () => {
    const doc = minimalDoc({ graph: { edges: [{ id: 'e1', from: { node: 'n-a' }, to: { node: 'n-b' } }] } });
    const { svg } = D.render(doc);
    expect(svg).toContain('data-edge="e1"');
    expect(D.ROUTE_IMPLEMENTED).toEqual(['straight', 'orthogonal', 'curve']);
    // 缺省这条边仍是**一条直线**（没有折点、没有 data-points 属性）
    expect(svg).toMatch(/<line data-edge="e1"/);
    expect(svg).not.toContain('data-points=');
  });
});

describe('父批 §一 第 10 条：确定性', () => {
  it('同一份 JSON 两跑 ⇒ SVG 逐字节相同（sha256 相同），**且两跑之间隔着时间**', async () => {
    const a = D.render(netfilterDoc()).svg;
    // ⚠️ 必须**跨过毫秒边界**再跑第二次：两次紧挨着跑时，`Date.now()` 恰好相同 ⇒
    // "输出带时间戳"这种坏法会**偶尔**被抓到（实测：第一次跑红、第二次跑绿 —— 那是判据在空转）。
    await new Promise((r) => setTimeout(r, 5));
    const b = D.render(netfilterDoc()).svg;
    expect(sha256(a)).toBe(sha256(b));
    expect(a).toBe(b);
    // 输出里不许出现时间戳 / 随机量 / 绝对路径（"两跑相同"的第二种坏法：靠运气相同）
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);       // ISO 时间
    expect(a).not.toMatch(/\b1[5-9]\d{11}\b/);               // epoch 毫秒（13 位）
    expect(a).not.toMatch(/[A-Za-z]:\\\\|%TEMP%|\.review/);   // 绝对路径 / 工作目录
  });

  it('节点数组顺序打乱 ⇒ **每个节点的最终坐标不变**（防偷偷排序）', () => {
    const base = D.render(netfilterDoc()).svg;
    const rectsOf = (svg) => {
      const out = {};
      svg.replace(/<g data-node="([^"]+)"[^>]*data-x="(-?[0-9.]+)" data-y="(-?[0-9.]+)" data-w="(-?[0-9.]+)" data-h="(-?[0-9.]+)"/g,
        (all, id, x, y, w, h) => { out[id] = [x, y, w, h].map(Number); return all; });
      return out;
    };
    const want = rectsOf(base);
    // 三种打乱：完全反转、把末尾搬到开头、按 id 的哈希序（与数据序无关）
    const shuffles = [
      (a) => a.slice().reverse(),
      (a) => a.slice(-3).concat(a.slice(0, -3)),
      (a) => a.slice().sort((p, q) => (sha256(p.id) < sha256(q.id) ? -1 : 1))
    ];
    shuffles.forEach((fn, i) => {
      const doc = netfilterDoc();
      doc.nodes = fn(doc.nodes);
      const got = rectsOf(D.render(doc).svg);
      expect(Object.keys(got).sort(), 'shuffle#' + i).toEqual(Object.keys(want).sort());
      Object.keys(want).forEach((id) => {
        expect(got[id], 'shuffle#' + i + ' / ' + id).toEqual(want[id]);
      });
    });
  });

  it('容器 stack 的子项顺序由 children[] 决定（与 nodes 数组顺序无关）', () => {
    const doc = netfilterDoc();
    doc.nodes = doc.nodes.slice().reverse();
    const { svg } = D.render(doc);
    const a = groupAttrs(svg, 'node', 'n-log');
    const b = groupAttrs(svg, 'node', 'n-log2');
    expect(Number(a.y)).toBeLessThan(Number(b.y));       // n-log 在 children[0]，永远在上面
  });
});

describe('C-F8-01 导出即完整：0 个外链 / 0 个外链样式', () => {
  it('SVG 里没有 http(s) 外链、没有 url(、没有 @import', () => {
    const { svg } = D.render(netfilterDoc());
    const withoutXmlns = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
    expect(withoutXmlns).not.toMatch(/https?:\/\//);
    expect(svg).not.toContain('url(');
    expect(svg).not.toContain('@import');
    expect(svg).not.toContain('<link');
    expect(svg).not.toContain('<script');
  });

  it('文本与属性都做了 XML 转义（标题里的尖括号/与号不许把 SVG 弄坏）', () => {
    const doc = minimalDoc();
    doc.nodes[0].title = 'a & b < c > d';
    const { svg } = D.render(doc);
    expect(svg).toContain('a &amp; b &lt; c &gt; d');
    expect(svg).not.toMatch(/<text[^>]*>a & b/);
  });
});

describe('布局接口（为 MS2 留位，不实现自动布局）', () => {
  it('缺省 layoutOf = 直接用 JSON 里的 rect（按 id 查表，不按下标）', () => {
    const doc = minimalDoc();
    const map = D.layoutOf(doc);
    expect(map['n-a']).toEqual({ x: 0, y: 0, w: 200, h: 70 });
    const shuffled = minimalDoc();
    shuffled.nodes.reverse();
    expect(D.layoutOf(shuffled)).toEqual(map);
  });

  it('render 接受注入的布局函数（MS2 换的就是它，渲染与判据不动）', () => {
    const doc = minimalDoc();
    const seen = [];
    const { svg } = D.render(doc, {
      layout: (d) => {
        seen.push(d.nodes.length);
        const out = {};
        d.nodes.forEach((n) => { out[n.id] = { x: n.rect[0], y: n.rect[1] + 100, w: n.rect[2], h: n.rect[3] }; });
        return out;
      }
    });
    expect(seen).toEqual([2]);
    expect(Number(groupAttrs(svg, 'node', 'n-a').y)).toBe(100);
  });
});

describe('报告（"没做"必须写在报告里，不许靠读者猜）', () => {
  it('report 含溢出计数、缩/加宽读数、未实现清单、测量档（近似 or 注入）', () => {
    const { report } = D.render(netfilterDoc());
    expect(report.ok).toBe(true);
    expect(report.overflowCount).toBe(0);
    expect(Array.isArray(report.shrunk)).toBe(true);
    expect(Array.isArray(report.widened)).toBe(true);
    expect(report.measure.approximate).toBe(true);
    expect(report.measure.note).toContain('近似');
    // MS2 起 orthogonal 与 layout:auto 都做了 ⇒ 未实现清单只剩 curve（曲线）与界面那两档
    expect(report.notImplemented).not.toContain('route:orthogonal');
    expect(report.notImplemented).not.toContain('layout:auto');
    expect(report.notImplemented).not.toContain('route:curve');   // 2026-10-26 补上了
    // 没跑布线时，布线读数必须是"未启用"而不是"0 个交叉"（后者会被读成"查过了，没有交叉"）
    expect(report.routing.enabled).toBe(false);
    expect(Array.isArray(report.wrapped)).toBe(true);
  });

  it('注入真 measureText ⇒ 报告标 approximate:false，且宽度真的按注入值算', () => {
    const { report, svg } = D.render(minimalDoc(), {
      measureText: (text, o) => text.length * o.fontSize * 2      // 假字体：每字 2 倍宽
    });
    expect(report.measure.approximate).toBe(false);
    // 甲（1 个全角字）在 2 倍宽下 = 28px > 声明内接宽 184？ 不，28 够小 ⇒ 不缩字号；断言宽度读数被用上了：
    expect(report.measure.cache.misses).toBeGreaterThan(0);
    expect(svg).toContain('data-text="title"');
  });

  it('注入的 measureText 返回非法值 ⇒ 响亮失败（量不出宽度不许当 0）', () => {
    expect(() => D.render(minimalDoc(), { measureText: () => NaN })).toThrow(/非法宽度/);
    expect(() => D.render(minimalDoc(), { measureText: () => -1 })).toThrow(/非法宽度/);
  });
});
