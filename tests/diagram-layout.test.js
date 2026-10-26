/* ============================================================
 * tests/diagram-layout.test.js —— **MS2 布局判据**（`C-A-01`…`C-A-04` + `C-F4-03`/`C-F4-04`）
 * ------------------------------------------------------------
 * 这一层只测"位置怎么来"，不测"线怎么绕"（那是 `diagram-route.test.js`）。
 * 判据与"该红"（注入见 `.review/20261060-MS2布局布线/inject-red.js`）：
 *   `C-A-01` 去环：有环不崩、被反转的边**逐条点名**
 *   `C-A-02` 分层：同 rank 无直连边；边的 rank 单调（回边反向单调）
 *   `C-A-03` 层内排序：交叉数不高于初始顺序；节点数组打乱后交叉数不变
 *   `C-A-04` 坐标：同 rank 的 x 相等（±0.5px）
 *   `C-F4-03` 间距可调：只影响该轴，拓扑与分层不变
 *   `C-F4-04` 稳定：两跑逐字节相同；**打乱后 rank 与 crossings 不变**（判据 6 的地基）
 * ============================================================ */
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { autoDoc, pinnedDoc, autoMinimal } from './diagram-auto-fixture.js';
import { readNodes } from './diagram-svg-reader.js';

function layoutOf(doc, opts) { return D.layoutOfDoc(doc, opts); }

describe('C-A-01 去环（cycle removal）', () => {
  it('有环的输入不崩，被反转的边**逐条点名**，且反转后 rank 单调', () => {
    const doc = autoDoc();
    const lay = layoutOf(doc);
    expect(lay.report.reversed.length).toBeGreaterThan(0);            // 这张图**有**环（否则判据空转）
    const rank = new Map(lay.report.ranks);
    const reversed = new Set(lay.report.reversed);
    doc.graph.edges.forEach((e) => {
      const a = rank.get(e.from.node);
      const b = rank.get(e.to.node);
      if (reversed.has(e.id)) {
        // 回边：**原始方向**上 rank 递减（说明它被反转了，仍然参与分层）
        expect(a, e.id + ' 被点名为回边，但 rank 没递减').toBeGreaterThan(b);
      } else {
        expect(a, e.id + ' 是正向边，但 rank 没有严格递增').toBeLessThan(b);
      }
    });
  });

  it('`removeCycles` 纯函数：三节点成环 ⇒ 恰好反转一条，且返回的边集不变', () => {
    const ids = ['a', 'b', 'c'];
    const edges = [
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'c' },
      { id: 'e3', from: 'c', to: 'a' }
    ];
    const out = D.removeCycles(ids, edges);
    expect(out.reversed.length).toBe(1);
    expect(out.out.length).toBe(3);
    expect(out.out.filter((e) => e.rev).length).toBe(1);
    // 反转之后：每个节点都能排出拓扑序（无环）
    const dag = out.out;
    const rank = D.assignRanks(ids, dag);
    expect(rank.topo.length).toBe(3);
  });
});

describe('C-A-02 分层（rank assignment）', () => {
  it('每节点都有 rank；同 rank **没有直连边**（跨层边被虚拟节点拆开）', () => {
    const doc = autoDoc();
    const lay = layoutOf(doc);
    expect(lay.report.ranks.length).toBe(doc.nodes.length);
    const rank = new Map(lay.report.ranks);
    doc.nodes.forEach((n) => expect(rank.has(n.id), n.id).toBe(true));
    doc.graph.edges.forEach((e) => {
      expect(rank.get(e.from.node), e.id + ' 的 from/to 落在同一个 rank').not.toBe(rank.get(e.to.node));
    });
  });

  it('同 rank 的节点 x 相等（±0.5px，`C-F4-01`）', () => {
    const lay = layoutOf(autoDoc());
    const byRank = new Map();
    Object.keys(lay.rects).forEach((id) => {
      const r = lay.report.rankOf[id];
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push({ id: id, x: lay.rects[id].x });
    });
    byRank.forEach((list) => {
      list.forEach((it) => {
        expect(Math.abs(it.x - list[0].x), it.id + ' 与 ' + list[0].id + ' 不同列').toBeLessThanOrEqual(0.5);
      });
    });
    expect(byRank.size).toBeGreaterThanOrEqual(4);
  });
});

describe('C-A-03 层内排序降交叉（barycenter，保最优）', () => {
  /** 判据自己的交叉计数（相邻两层逆序对）—— 不复用 `layout.js` 的中间变量 */
  function bilinearCross(layers, edges) {
    const pos = new Map();
    layers.forEach((l, r) => l.forEach((id, i) => pos.set(id, { r: r, i: i })));
    const adj = [];                                        // 只数"相邻两层"的直连边
    edges.forEach((e) => {
      const a = pos.get(e[0]);
      const b = pos.get(e[1]);
      if (a && b && Math.abs(a.r - b.r) === 1) adj.push({ upper: a, lower: b });
    });
    let cross = 0;
    for (let i = 0; i < adj.length; i++) {
      for (let j = i + 1; j < adj.length; j++) {
        const A = adj[i];
        const B = adj[j];
        if (A.upper.r !== B.upper.r) continue;
        if (A.upper.i < B.upper.i && A.lower.i > B.lower.i) cross++;
        if (A.upper.i > B.upper.i && A.lower.i < B.lower.i) cross++;
      }
    }
    return cross;
  }

  it('排序后的交叉数**不大于**起点（id 序），且与实现自报的读数一致', () => {
    const lay = layoutOf(autoDoc());
    const o = lay.report.order;
    const initial = bilinearCross(o.initial, o.edges);
    const final = bilinearCross(o.final, o.edges);
    expect(initial).toBeGreaterThan(0);                                   // 起点真的有交叉（否则看不出降没降）
    expect(final).toBeLessThan(initial);                                  // **真的降了**（不是"没搞坏"就算过）
    expect(final).toBeLessThanOrEqual(initial);
    expect(final).toBe(o.finalCrosses);                                   // 自报 == 独立复算
    expect(initial).toBe(o.initialCrosses);
    expect(lay.report.crosses).toBe(final);
    expect(lay.report.orderIterations).toBeGreaterThan(0);
  });

  it('节点数组打乱后 `crosses` 与 `layers` 逐值不变（排序与输入序无关）', () => {
    const a = layoutOf(autoDoc());
    const shuffled = autoDoc();
    shuffled.nodes = shuffled.nodes.slice().reverse();
    const b = layoutOf(shuffled);
    expect(b.report.crosses).toBe(a.report.crosses);
    expect(JSON.stringify(b.report.layers)).toBe(JSON.stringify(a.report.layers));
    expect(JSON.stringify(b.report.ranks)).toBe(JSON.stringify(a.report.ranks));
  });
});

describe('C-A-04 坐标分配', () => {
  it('同 rank 的节点在副轴上不重叠（同层节点不压在一起）', () => {
    const lay = layoutOf(autoDoc());
    const byRank = new Map();
    Object.keys(lay.rects).forEach((id) => {
      const r = lay.report.rankOf[id];
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(Object.assign({ id: id }, lay.rects[id]));
    });
    byRank.forEach((list) => {
      const sorted = list.slice().sort((p, q) => p.y - q.y);
      for (let i = 0; i + 1 < sorted.length; i++) {
        expect(sorted[i].y + sorted[i].h, sorted[i].id + ' 与 ' + sorted[i + 1].id + ' 重叠')
          .toBeLessThanOrEqual(sorted[i + 1].y + 0.5);
      }
    });
  });

  it('节点尺寸取到 16 的整数倍、坐标取到 8 的整数倍（端口落在网格上的前提）', () => {
    const lay = layoutOf(autoDoc());
    Object.keys(lay.rects).forEach((id) => {
      const r = lay.rects[id];
      expect(r.w % 16, id + '.w=' + r.w).toBe(0);
      expect(r.h % 16, id + '.h=' + r.h).toBe(0);
      expect(r.x % 8, id + '.x=' + r.x).toBe(0);
      expect(r.y % 8, id + '.y=' + r.y).toBe(0);
    });
  });
});

describe('C-F4-03 间距可调（节点间距 / 层间距只影响各自那条轴）', () => {
  it('调大 `gap.node` ⇒ 同层节点在副轴上更散开，主轴与拓扑不变', () => {
    const base = layoutOf(autoDoc());
    const doc = autoDoc();
    doc.graph.gap = { node: 96, rank: base.report.gap.rank };         // 数据里改（数据 > opts，见下一条）
    const wide = layoutOf(doc);
    expect(wide.report.gap.node).toBe(96);
    expect(wide.report.ranks).toEqual(base.report.ranks);              // 分层不变
    expect(wide.report.crosses).toBe(base.report.crosses);             // 拓扑不变
    Object.keys(base.rects).forEach((id) => {
      expect(wide.rects[id].x, id + ' 的主轴坐标不该被 gap.node 改变').toBe(base.rects[id].x);
    });
    // 至少有一层的节点在副轴上被推远了
    const byRank = new Map();
    Object.keys(base.rects).forEach((id) => {
      const r = base.report.rankOf[id];
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(id);
    });
    let moved = 0;
    byRank.forEach((ids) => {
      if (ids.length < 2) return;
      ids.forEach((id) => { if (wide.rects[id].y !== base.rects[id].y) moved++; });
    });
    expect(moved).toBeGreaterThan(0);
  });

  it('调大 `gap.rank` ⇒ 层与层更远，同层内相对位置不变', () => {
    const base = layoutOf(autoDoc());
    const doc = autoDoc();
    doc.graph.gap = { node: base.report.gap.node, rank: 200 };
    const wide = layoutOf(doc);
    expect(wide.report.gap.rank).toBe(200);
    expect(wide.report.ranks).toEqual(base.report.ranks);
    // 主轴跨度变大（LR ⇒ x 方向）
    const span = (lay) => Math.max.apply(null, Object.keys(lay.rects).map((id) => lay.rects[id].x))
      - Math.min.apply(null, Object.keys(lay.rects).map((id) => lay.rects[id].x));
    expect(span(wide)).toBeGreaterThan(span(base));
    // 同层的副轴（y）相对位置不变
    Object.keys(base.rects).forEach((id) => {
      expect(wide.rects[id].y, id + ' 的副轴坐标不该被 gap.rank 改变').toBe(base.rects[id].y);
    });
  });

  it('两档来源的优先级：**数据里的 `graph.gap` 先生效**，数据没写时才用 `opts.gap`', () => {
    const yOf = (lay) => Object.keys(lay.rects).sort().map((id) => lay.rects[id].y).join(',');
    const withData = autoDoc();
    withData.graph.gap = { node: 200, rank: 64 };
    const a = layoutOf(withData, { gap: { node: 20 } });               // opts 被数据压住
    expect(a.report.gap.node).toBe(200);
    const noData = autoDoc();
    delete noData.graph.gap;
    const b = layoutOf(noData);
    const c = layoutOf(noData, { gap: { node: 200 } });
    expect(b.report.gap.node).toBe(D.NODE_GAP_DEFAULT);
    expect(c.report.gap.node).toBe(200);
    expect(yOf(c)).not.toBe(yOf(b));                                  // opts 这一档真的被读了
  });
});

describe('C-F4-02 主方向 LR / TB（两档的包围盒按方向翻转）', () => {
  it('LR 的包围盒宽 > 高；TB 的包围盒高 > 宽', () => {
    const bbox = (lay) => {
      const ids = Object.keys(lay.rects);
      const xs = ids.map((id) => lay.rects[id].x);
      const ys = ids.map((id) => lay.rects[id].y);
      const ws = ids.map((id) => lay.rects[id].x + lay.rects[id].w);
      const hs = ids.map((id) => lay.rects[id].y + lay.rects[id].h);
      return { w: Math.max.apply(null, ws) - Math.min.apply(null, xs), h: Math.max.apply(null, hs) - Math.min.apply(null, ys) };
    };
    const lr = bbox(layoutOf(autoDoc()));
    const doc = autoDoc();
    doc.graph.direction = 'TB';
    const tb = bbox(layoutOf(doc));
    expect(lr.w).toBeGreaterThan(lr.h);
    expect(tb.h).toBeGreaterThan(tb.w);
  });
});

describe('显式意图优先（外部证据 archify：作者给的布局意图不该被自动布局覆盖）', () => {
  it('`pinned` + `rect` 的节点：位置**逐值等于声明值**，且 `explicit[]` 逐条点名', () => {
    const lay = layoutOf(pinnedDoc());
    expect(lay.rects['n-b']).toEqual({ x: 600, y: 400, w: 208, h: 96 });
    expect(lay.report.explicit.length).toBe(1);
    expect(lay.report.explicit[0].id).toBe('n-b');
    expect(lay.report.explicit[0].why).toBe('pinned+rect');
    // 其余节点照常自动布局（不是"整张图都不排了"）
    expect(lay.rects['n-a']).toBeTruthy();
    expect(lay.rects['n-c']).toBeTruthy();
    expect(lay.rects['n-a'].x).not.toBe(600);
  });

  it('`pinned` 指向没有 rect 的节点 ⇒ 不生效也不报错（只钉"有位置的"）', () => {
    const doc = pinnedDoc();
    doc.graph.pinned = ['n-a'];                        // n-a 没有 rect
    const lay = layoutOf(doc);
    expect(lay.report.explicit).toEqual([]);
    expect(lay.rects['n-a']).toBeTruthy();
  });
});

describe('布局给的框**刚好**放得下（渲染不再加宽 ⇒ 文字档与几何档同一份算式）', () => {
  it('`renderAuto` 的 `report.widened` 为空、无 `E_TEXT_OVERFLOW`', () => {
    const res = D.renderAuto(autoDoc());
    expect(res.report.widened).toEqual([]);
    expect(res.report.overflowCount).toBe(0);
    // 节点框仍满足"每行文本 ≤ 内接宽"（从 SVG 独立读）
    const nodes = readNodes(res.svg);
    expect(nodes.length).toBe(autoDoc().nodes.length);
    nodes.forEach((n) => {
      const inset = D.shapeInset(n.rect, n.shape);
      expect(inset.w).toBeGreaterThan(0);
    });
  });
});

describe('判据 6 的地基：布局层就把"顺序无关"钉住', () => {
  it('打乱 nodes 后：`ranks`（逐值）与 `crosses` 都不变，且 rects 也相同', () => {
    const a = layoutOf(autoDoc());
    const doc = autoDoc();
    doc.nodes = doc.nodes.slice().reverse();
    const b = layoutOf(doc);
    expect(b.report.ranks).toEqual(a.report.ranks);          // rank **数值**，不是坐标
    expect(b.report.crosses).toBe(a.report.crosses);
    expect(JSON.stringify(b.rects)).toBe(JSON.stringify(a.rects));
  });

  it('单节点最小图：布局不崩，rank = 0', () => {
    const lay = layoutOf(autoMinimal());
    expect(lay.report.ranks).toEqual([['a', 0], ['b', 0]]);
    expect(Object.keys(lay.rects).length).toBe(2);
  });
});
