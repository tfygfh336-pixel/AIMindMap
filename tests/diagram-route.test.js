/* ============================================================
 * tests/diagram-route.test.js —— **MS2 布线判据**（判据 1/2/3/4/7 都在这里）
 * ------------------------------------------------------------
 * 每条判据都从 **SVG 字符串**重新读几何（`tests/diagram-svg-reader.js`，它**不 require**
 * `src/diagram/route.js`）—— 这就是"独立 recount"：实现与判据不共用任何几何函数。
 *
 * 判据与"该红"（判别力注入见 `.review/20261060-MS2布局布线/inject-red.js`）：
 *   ① 边穿框 = 0                      ← 去掉/关掉避障 ⇒ 红
 *   ② 非预期交叉 ≤ 3 **且逐点 overpass** ← 只统计不画白描/不断开 ⇒ 红
 *   ③ `report.routing.crossings` == 独立 recount ← 自报一个偏小的数 ⇒ 红
 *   ④ 同通道相邻线中心距 ≥ 8px         ← `LANE_GAP` 改 4 ⇒ 红
 *   ⑦ 标签不压线不压框（含"到别的路径的净空"）← 允许压框 ⇒ 红
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { autoDoc, autoMinimal } from './diagram-auto-fixture.js';
import {
  readNodes, readEdges, readSegments, readHalos, readEdgeLabels, readNodeTextLines,
  segmentsOf, interiorCross, segEntersRect, rectsOverlap, distRectSeg
} from './diagram-svg-reader.js';

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

/** 基准渲染（每次一份新的 doc；渲染不许改数据，但夹具也每次新造，防"某条用例污染下一条"） */
function run() { return D.renderAuto(autoDoc()); }

/* ==================================================================
 * 判据 ① 边穿框 = 0
 * ================================================================== */
describe('判据 1：边穿框 = 0（每条线段 × 每个非端点节点矩形）', () => {
  it('逐边 × 逐节点：没有任何线段进入**非端点**节点的矩形内部', () => {
    const { svg, report } = run();
    const nodes = readNodes(svg);
    const edges = readEdges(svg);
    expect(edges.length).toBe(autoDoc().graph.edges.length);        // 每条边都真的画了（没被静默丢掉）

    let checked = 0;
    edges.forEach((e) => {
      const segs = segmentsOf(e.points);
      expect(segs.length).toBeGreaterThan(0);
      segs.forEach((seg, si) => {
        nodes.forEach((n) => {
          // 端点所属的节点**豁免**（线本来就从它的边上出发/进入）；豁免面单独计数，不许扩大
          if (n.id === e.from || n.id === e.to) return;
          expect(segEntersRect(seg, n.rect), 'edge ' + e.id + ' seg#' + si + ' 穿进了节点 ' + n.id)
            .toBe(false);
          checked++;
        });
      });
    });
    expect(checked).toBeGreaterThan(50);                            // 判据真的逐对跑过（不是空转）
    // 端点节点也要"只有在端口附近才碰边"：线段不许横穿自己端点的框
    edges.forEach((e) => {
      segmentsOf(e.points).forEach((seg) => {
        nodes.filter((n) => n.id === e.from || n.id === e.to).forEach((n) => {
          const r = n.rect;
          const mid = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2];
          const inside = mid[0] > r.x + 1 && mid[0] < r.x + r.w - 1 && mid[1] > r.y + 1 && mid[1] < r.y + r.h - 1;
          expect(inside, 'edge ' + e.id + ' 的线段中点在端点节点 ' + n.id + ' 的内部').toBe(false);
        });
      });
    });
    // 报告里"兜底路径"必须是 0：兜底 = 拿不到网格解时画的 L，它不是正常路径
    expect(report.problems.filter((p) => p.indexOf('E_ROUTE_MARGIN') === 0)).toEqual([]);
  });

  it('正交性：每条折线的每一段都与轴平行（没有斜线混进来）', () => {
    const { svg } = run();
    let checked = 0;
    readEdges(svg).forEach((e) => {
      segmentsOf(e.points).forEach((seg) => {
        const horizontal = Math.abs(seg[0][1] - seg[1][1]) < 1e-6;
        const vertical = Math.abs(seg[0][0] - seg[1][0]) < 1e-6;
        expect(horizontal || vertical, 'edge ' + e.id + ' 有一段不是轴向: ' + JSON.stringify(seg)).toBe(true);
        checked++;
      });
    });
    expect(checked).toBeGreaterThan(20);
  });

  it('折点坐标都是 `grid` 的整数倍（`C-F3-06`）', () => {
    const doc = autoDoc();
    const grid = doc.graph.grid;
    const { svg } = run();
    readEdges(svg).forEach((e) => {
      e.points.forEach((p) => {
        expect(Math.abs(p[0] / grid - Math.round(p[0] / grid)), 'x=' + p[0]).toBeLessThan(1e-9);
        expect(Math.abs(p[1] / grid - Math.round(p[1] / grid)), 'y=' + p[1]).toBeLessThan(1e-9);
      });
    });
  });
});

/* ==================================================================
 * 判据 ② 非预期交叉 ≤ 3，且**逐点** overpass
 * 判据 ③ crossings == 独立 recount
 * ================================================================== */
describe('判据 2/3：交叉数（独立复算）与逐点 overpass', () => {
  /** **独立 recount**：从 SVG 里的 `data-points` 重新算交叉（与实现不共用任何变量） */
  function recount(svg) {
    const edges = readEdges(svg);
    const out = [];
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const a = segmentsOf(edges[i].points);
        const b = segmentsOf(edges[j].points);
        for (let x = 0; x < a.length; x++) {
          for (let y = 0; y < b.length; y++) {
            const pt = interiorCross(a[x], b[y]);
            if (!pt) continue;
            const ea = edges[i];
            const eb = edges[j];
            const shared = ea.from === eb.from || ea.from === eb.to || ea.to === eb.from || ea.to === eb.to;
            out.push({ x: pt.x, y: pt.y, a: ea.id, b: eb.id, shared: shared, edges: [ea, eb] });
          }
        }
      }
    }
    // 同一交点去重（一对边可能被多个线段对重复发现）
    const seen = new Set();
    return out.filter((c) => {
      const k = c.x.toFixed(3) + ',' + c.y.toFixed(3) + ',' + c.a + ',' + c.b;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  it('判据 3：`report.routing.crossings` **等于**独立复算的交叉数', () => {
    const { svg, report } = run();
    const mine = recount(svg);
    expect(report.routing.enabled).toBe(true);
    expect(report.routing.crossings).toBe(mine.length);
    // 逐点也要对得上：报告里的坐标集合 == 复算出来的坐标集合
    const key = (x, y) => Number(x).toFixed(3) + ',' + Number(y).toFixed(3);
    const mineKeys = mine.map((c) => key(c.x, c.y)).sort();
    const repKeys = report.routing.crossingPoints.map((c) => key(c.x, c.y)).sort();
    expect(repKeys).toEqual(mineKeys);
    expect(mine.length).toBeGreaterThan(0);                          // 这张图**真的有**交叉（否则判据空转）
  });

  it('判据 2：非预期交叉 ≤ 3（回边与共端点的交叉不计入），且分类可复查', () => {
    const { svg, report } = run();
    const mine = recount(svg);
    const reversed = new Set(report.layout.reversed);
    expect(reversed.size).toBeGreaterThan(0);                        // 这张图**真的有**回边（去环被用了）

    const classified = mine.map((c) => {
      const shared = c.shared;
      const back = reversed.has(c.a) || reversed.has(c.b);
      return { ...c, why: shared ? 'shared-endpoint' : (back ? 'back-edge' : 'interleave') };
    });
    const interleave = classified.filter((c) => c.why === 'interleave');
    expect(interleave.length, '非预期交叉: ' + JSON.stringify(interleave.map((c) => [c.a, c.b, c.x, c.y])))
      .toBeLessThanOrEqual(3);
    // 报告的分类必须与判据自己算的一致（分类是**结构性的**，不是"我们算过"）
    expect(report.routing.unexpected).toBe(interleave.length);
    expect(report.routing.expected).toBe(classified.length - interleave.length);
    report.routing.crossingPoints.forEach((p) => {
      const want = p.why;
      const got = classified.find((c) => Math.abs(c.x - p.x) < 1e-6 && Math.abs(c.y - p.y) < 1e-6);
      expect(got, '报告里的交叉点在复算里找不到: ' + p.x + ',' + p.y).toBeTruthy();
      expect(got.why).toBe(want);
    });
  });

  it('判据 2（下半条）：**每个交叉点**都做了 overpass —— 低优先级断开 4px + 高优先级白描', () => {
    const { svg, report } = run();
    const mine = recount(svg);
    const segs = readSegments(svg);
    const halos = readHalos(svg);
    expect(mine.length).toBeGreaterThan(0);

    mine.forEach((c) => {
      const rep = report.routing.crossingPoints.find((p) => Math.abs(p.x - c.x) < 1e-6 && Math.abs(p.y - c.y) < 1e-6);
      expect(rep, '复算出来的交叉点不在报告里: ' + c.x + ',' + c.y).toBeTruthy();
      const lowEdge = rep.low;
      const highEdge = rep.high;

      // (a) 高优先级线：必须有白色描边覆盖这个点
      const haloHit = halos.some((h) => h.edge === highEdge
        && Math.abs(h.width - D.HALO_WIDTH) < 1e-9
        && pointOnSegment([c.x, c.y], [h.a, h.b]));
      expect(haloHit, '交叉点 ' + c.x + ',' + c.y + ' 上高优先级线 ' + highEdge + ' 没有白描').toBe(true);

      // (b) 低优先级线：在这个点两侧**断开**，缺口 ≥ 4px（用"投影区间"算，不看实现）
      const own = segs.filter((s) => s.edge === lowEdge);
      const axis = Math.abs(haloOf(halos, highEdge, c).x1 - haloOf(halos, highEdge, c).x2) < 1e-9 ? 'v' : 'h';
      // 缺口：沿低优先级线在交点处把"被覆盖的区间"取出来，求点左右两侧的最近端点
      const gaps = gapAround(own, c);
      expect(gaps.covered, '交叉点 ' + c.x + ',' + c.y + ' 上低优先级线 ' + lowEdge + ' 仍被覆盖（没断开）').toBe(false);
      expect(gaps.gap, '交叉点 ' + c.x + ',' + c.y + ' 处低优先级线 ' + lowEdge + ' 的缺口 = ' + gaps.gap + 'px')
        .toBeGreaterThanOrEqual(2 * D.GAP_HALF - 1e-6);
      expect(axis).toBeTruthy();
    });
    // 逐点都要有白描 ⇒ 白描条数 ≥ 交叉点数（一条白描只服务一个交点；多于此是允许的）
    expect(halos.length).toBeGreaterThanOrEqual(mine.length);
    expect(report.routing.overpasses).toBe(halos.length);
  });
});

/** 点是否落在线段上（含端点） */
function pointOnSegment(p, seg) {
  const horizontal = Math.abs(seg[0][1] - seg[1][1]) < 1e-6;
  const vertical = Math.abs(seg[0][0] - seg[1][0]) < 1e-6;
  if (horizontal) {
    return Math.abs(p[1] - seg[0][1]) < 1e-6
      && p[0] >= Math.min(seg[0][0], seg[1][0]) - 1e-6 && p[0] <= Math.max(seg[0][0], seg[1][0]) + 1e-6;
  }
  if (vertical) {
    return Math.abs(p[0] - seg[0][0]) < 1e-6
      && p[1] >= Math.min(seg[0][1], seg[1][1]) - 1e-6 && p[1] <= Math.max(seg[0][1], seg[1][1]) + 1e-6;
  }
  return false;
}

/** 某条边的白描（取第一条即可：判据只要"这一条覆盖了交点"） */
function haloOf(halos, edge, c) {
  const h = halos.find((x) => x.edge === edge && pointOnSegment([c.x, c.y], [x.a, x.b]));
  return h || halos.find((x) => x.edge === edge) || { x1: 0, y1: 0, x2: 0, y2: 0, a: [0, 0], b: [0, 0] };
}

/** 交叉点处：低优先级线**是否被覆盖**（缺口多少） */
function gapAround(segs, c) {
  // 找出所有经过该点、且"垂直于该点"的线段：分别按水平/垂直投影算左右最近的端点
  const vertical = segs.filter((s) => Math.abs(s.a[0] - s.b[0]) < 1e-6 && Math.abs(s.a[0] - c.x) < 1e-6);
  const horizontal = segs.filter((s) => Math.abs(s.a[1] - s.b[1]) < 1e-6 && Math.abs(s.a[1] - c.y) < 1e-6);
  const pick = (list, along) => {
    let covered = false;
    let lo = -Infinity;
    let hi = Infinity;
    list.forEach((s) => {
      const p1 = along === 'y' ? s.a[1] : s.a[0];
      const p2 = along === 'y' ? s.b[1] : s.b[0];
      const a = Math.min(p1, p2);
      const b = Math.max(p1, p2);
      const at = along === 'y' ? c.y : c.x;
      if (at >= a - 1e-6 && at <= b + 1e-6) covered = true;
      if (b <= at + 1e-6) lo = Math.max(lo, b);
      if (a >= at - 1e-6) hi = Math.min(hi, a);
    });
    return { covered: covered, lo: lo, hi: hi };
  };
  // 交点落在低优先级线的哪一段上，就用那个方向
  if (vertical.length) {
    const r = pick(vertical, 'y');
    return { covered: r.covered, gap: r.hi - r.lo };
  }
  const r = pick(horizontal, 'x');
  return { covered: r.covered, gap: r.hi - r.lo };
}

/* ==================================================================
 * 判据 ④ 同通道 ≥ 8px
 * ================================================================== */
describe('判据 4：同一条正交通道内相邻两条线中心距 ≥ 8px', () => {
  it('逐对量：不同边的平行重叠线段，中心距 ≥ LANE_GAP（8px）', () => {
    const { svg, report } = run();
    const segs = readSegments(svg);
    let pairs = 0;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].edge === segs[j].edge) continue;
        const a = segs[i];
        const b = segs[j];
        const aH = Math.abs(a.a[1] - a.b[1]) < 1e-6;
        const bH = Math.abs(b.a[1] - b.b[1]) < 1e-6;
        if (aH !== bH) continue;                                     // 一横一竖不算"同通道"
        const ca = aH ? a.a[1] : a.a[0];
        const cb = bH ? b.b[1] : b.b[0];
        // 投影是否重叠（不重叠的两条平行线不需要间距）
        const pa = aH ? [Math.min(a.a[0], a.b[0]), Math.max(a.a[0], a.b[0])] : [Math.min(a.a[1], a.b[1]), Math.max(a.a[1], a.b[1])];
        const pb = bH ? [Math.min(b.a[0], b.b[0]), Math.max(b.a[0], b.b[0])] : [Math.min(b.a[1], b.b[1]), Math.max(b.a[1], b.b[1])];
        if (Math.min(pa[1], pb[1]) - Math.max(pa[0], pb[0]) <= 1e-6) continue;
        expect(Math.abs(ca - cb), '边 ' + a.edge + ' 与 ' + b.edge + ' 在同通道上相距 ' + Math.abs(ca - cb) + 'px')
          .toBeGreaterThanOrEqual(D.LANE_GAP - 1e-6);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(10);                              // 这条判据真的量到了成对的线
  });

  it('通道读数与几何对得上：报告里的每两条相邻 lane，几何距离 == `LANE_GAP`', () => {
    const { report } = run();
    const multi = report.routing.lanes.filter((l) => l.count >= 2);
    expect(multi.length, '没有一个通道放了两条以上的线 ⇒ 这条判据无从验证').toBeGreaterThan(0);
    multi.forEach((l) => {
      const xs = l.lanes.map((x) => x.at).slice().sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i++) {
        expect(xs[i + 1] - xs[i], '通道 ' + JSON.stringify(l.band) + ' 的相邻 lane 间距').toBeCloseTo(D.LANE_GAP, 6);
      }
    });
  });

  it('同侧多支线确定性展开：同一节点同侧的多条边端口互不相同且间距 ≥ 8px', () => {
    const { svg, report } = run();
    const edges = readEdges(svg);
    const byKey = new Map();
    edges.forEach((e) => {
      const k1 = e.from + '|' + e.fromPort;
      if (!byKey.has(k1)) byKey.set(k1, []);
      byKey.get(k1).push({ id: e.id, p: e.points[0] });
      const k2 = e.to + '|' + e.toPort;
      if (!byKey.has(k2)) byKey.set(k2, []);
      byKey.get(k2).push({ id: e.id, p: e.points[e.points.length - 1] });
    });
    let multi = 0;
    byKey.forEach((list, k) => {
      if (list.length < 2) return;
      multi++;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const d = Math.hypot(list[i].p[0] - list[j].p[0], list[i].p[1] - list[j].p[1]);
          expect(d, k + ' 上 ' + list[i].id + ' 与 ' + list[j].id + ' 的端口间距').toBeGreaterThanOrEqual(8 - 1e-6);
        }
      }
    });
    expect(multi).toBeGreaterThan(0);
    expect(report.routing.enabled).toBe(true);
  });
});

/* ==================================================================
 * 判据 ⑦ 标签不压线不压框（含"到别的路径的净空"）
 * ================================================================== */
describe('判据 7：边标签不压框、不压线、不压别的标签', () => {
  it('逐个标签：与任何节点矩形零相交、与任何线段零相交、与别的标签零相交', () => {
    const { svg } = run();
    const labels = readEdgeLabels(svg);
    const nodes = readNodes(svg);
    const segs = readSegments(svg);
    expect(labels.length).toBeGreaterThanOrEqual(4);                 // 这张图有 5 条带标签的边
    const graph = autoDoc().graph;

    labels.forEach((l) => {
      expect(graph.edges.some((e) => e.id === l.edge && e.label === l.text), '标签文字与数据不符: ' + l.text).toBe(true);
      nodes.forEach((n) => {
        expect(rectsOverlap(l.box, n.rect), '标签 ' + l.edge + ' 压住了节点 ' + n.id).toBe(false);
      });
      segs.forEach((s) => {
        const d = distRectSeg(l.box, [s.a, s.b]);
        expect(d, '标签 ' + l.edge + ' 压到了线（边 ' + s.edge + '）').toBeGreaterThan(0.5);
      });
      labels.forEach((other) => {
        if (other.edge === l.edge) return;
        expect(rectsOverlap(l.box, other.box), '标签 ' + l.edge + ' 与 ' + other.edge + ' 压在一起').toBe(false);
      });
    });
  });

  it('"到**别的路径**的净空"这一档：标签到非自身线段的最小距离 ≥ LABEL_PATH_CLEARANCE', () => {
    const { svg, report } = run();
    const labels = readEdgeLabels(svg);
    const segs = readSegments(svg);
    let minAll = Infinity;
    labels.forEach((l) => {
      segs.forEach((s) => {
        if (s.edge === l.edge) return;
        const d = distRectSeg(l.box, [s.a, s.b]);
        minAll = Math.min(minAll, d);
      });
    });
    expect(Number.isFinite(minAll)).toBe(true);
    expect(minAll, '标签到别的路径的净空 = ' + minAll + 'px（要求 ≥ ' + D.LABEL_PATH_CLEARANCE + '）')
      .toBeGreaterThanOrEqual(D.LABEL_PATH_CLEARANCE - 1e-6);
    expect(report.routing.labels.length).toBe(labels.length);
  });
});

/* ==================================================================
 * 判据 ⑤ 同输入两跑逐字节一致（两次之间 `await 5ms`）
 * ================================================================== */
describe('判据 5：两跑逐字节一致（判定前隔 5ms，防同毫秒空转）', () => {
  it('同一份 JSON 两次渲染 ⇒ sha256 相同（含布局 + 布线 + overpass + 标签）', async () => {
    const a = D.renderAuto(autoDoc());
    await new Promise((r) => setTimeout(r, 5));
    const b = D.renderAuto(autoDoc());
    expect(sha256(a.svg)).toBe(sha256(b.svg));
    expect(a.svg.length).toBe(b.svg.length);
    expect(a.report.routing.crossings).toBe(b.report.routing.crossings);
    expect(JSON.stringify(a.report.layout.ranks)).toBe(JSON.stringify(b.report.layout.ranks));
    expect(a.report.routing.crossingPoints).toEqual(b.report.routing.crossingPoints);
  });
});

/* ==================================================================
 * 判据 ⑥ 节点数组顺序打乱 ⇒ `rank` 与 `crossings` 不变（**不是**只测坐标）
 * ================================================================== */
describe('判据 6：节点数组打乱后 `rank` 与 `crossings` 逐值不变', () => {
  it('打乱 nodes（含边的数组顺序不动）⇒ rank 表与 crossings 完全相同', () => {
    const doc = autoDoc();
    const a = D.renderAuto(doc);
    const shuffled = autoDoc();
    // 确定性打乱（不用随机：用固定置换，判据才可复跑）
    shuffled.nodes = shuffled.nodes.slice().reverse();
    const b = D.renderAuto(shuffled);
    expect(JSON.stringify(b.report.layout.ranks)).toBe(JSON.stringify(a.report.layout.ranks));
    expect(b.report.routing.crossings).toBe(a.report.routing.crossings);
    expect(b.report.routing.crossingPoints).toEqual(a.report.routing.crossingPoints);
    // 坐标也应当不变（坐标是按 id 查表算出来的）
    const rectsA = JSON.stringify(a.layout);
    const rectsB = JSON.stringify(b.layout);
    expect(rectsB).toBe(rectsA);
  });

  it('打乱 nodes **与** edges ⇒ 分层与交叉数仍然不变（边的顺序同样不许影响结果）', () => {
    const doc = autoDoc();
    const a = D.renderAuto(doc);
    const shuffled = autoDoc();
    shuffled.nodes = shuffled.nodes.slice().reverse();
    shuffled.graph.edges = shuffled.graph.edges.slice().reverse();
    const b = D.renderAuto(shuffled);
    expect(JSON.stringify(b.report.layout.ranks)).toBe(JSON.stringify(a.report.layout.ranks));
    expect(b.report.routing.crossings).toBe(a.report.routing.crossings);
    expect(b.report.layout.reversed).toEqual(a.report.layout.reversed);
  });
});

/* ==================================================================
 * 主方向 LR / TB 两档都要能布线（`C-F4-02` 的布线段）
 * ================================================================== */
describe('C-F4-02：`LR` 与 `TB` 两档都正交、都有标签、都不穿框', () => {
  function tiny(dir) {
    return {
      graph: { version: 1, direction: dir, grid: 8, gap: { node: 28, rank: 64 },
        edges: [
          { id: 'e1', from: { node: 'a' }, to: { node: 'b' }, label: '甲' },
          { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
          { id: 'e3', from: { node: 'a' }, to: { node: 'c' }, label: '长' },
          { id: 'e4', from: { node: 'c' }, to: { node: 'a' } }
        ] },
      nodes: [
        { id: 'a', type: 'rect', title: '甲', subtitle: 'a' },
        { id: 'b', type: 'diamond', title: '乙', subtitle: 'b' },
        { id: 'c', type: 'rect', title: '丙', subtitle: 'c' }
      ]
    };
  }

  ['LR', 'TB'].forEach((dir) => {
    it(dir + '：每条边都是轴向折线、标签放得下、穿框 0', () => {
      const { svg, report } = D.renderAuto(tiny(dir));
      const nodes = readNodes(svg);
      const edges = readEdges(svg);
      expect(edges.length).toBe(4);
      edges.forEach((e) => {
        segmentsOf(e.points).forEach((seg) => {
          const horizontal = Math.abs(seg[0][1] - seg[1][1]) < 1e-6;
          const vertical = Math.abs(seg[0][0] - seg[1][0]) < 1e-6;
          expect(horizontal || vertical, dir + '/' + e.id + ' 有斜段').toBe(true);
          nodes.forEach((n) => {
            if (n.id === e.from || n.id === e.to) return;
            expect(segEntersRect(seg, n.rect), dir + '/' + e.id + ' 穿进 ' + n.id).toBe(false);
          });
        });
      });
      expect(readEdgeLabels(svg).length).toBe(2);
      expect(report.layout.direction).toBe(dir);
    });
  });
});

/* ==================================================================
 * 其它：折点数与拐弯惩罚（`C-A-05` 的"调高拐弯惩罚 ⇒ 折点数不增"）
 * ================================================================== */
describe('C-A-05：四项代价可读 + 调高拐弯惩罚折点数不增', () => {
  it('报告里有长度/拐弯/交叉/贴边四个读数，且它们都是数', () => {
    const { report } = run();
    const c = report.routing.cost;
    ['length', 'bends', 'crossings', 'hugs'].forEach((k) => {
      expect(typeof c[k], 'cost.' + k).toBe('number');
      expect(Number.isFinite(c[k])).toBe(true);
    });
    expect(c.length).toBeGreaterThan(0);
  });

  it('调高 `BEND_PENALTY` ⇒ 总折点数不增（不是"调了没反应"）', () => {
    const base = D.renderAuto(autoDoc());
    const more = D.renderAuto(autoDoc(), { routePenalty: { bendPenalty: D.BEND_PENALTY * 40 } });
    expect(more.report.routing.cost.bends).toBeLessThanOrEqual(base.report.routing.cost.bends);
  });

  it('只给一条边的最小图：一定是"端口 → 一折 → 端口"这种最省折的形态', () => {
    const doc = autoMinimal({ edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' }, label: '一条' }] });
    const { svg, report } = D.renderAuto(doc);
    const edges = readEdges(svg);
    expect(edges.length).toBe(1);
    expect(report.routing.crossings).toBe(0);
    expect(edges[0].points.length).toBeLessThanOrEqual(4);           // 最多 3 段（e/w 端口直连只需 1~3 段）
    expect(readEdgeLabels(svg).length).toBe(1);
    expect(readNodeTextLines(svg).length).toBeGreaterThanOrEqual(6); // 两个节点 × 三段
  });
});

/* ==================================================================
 * 判据 2 的"逐点"那半**必须有自己的靶子**（2026-10-26 补）
 * ------------------------------------------------------------------
 * 起因是一次**真的失灵**：副轴对齐改了布局之后，基准图里每条被断的边只剩 1 个交叉点，
 * 于是"只断第一处"这条注入从红变绿 —— 判据本身没错，但它**没有靶子了**（统计上永远成立）。
 * 所以这里造一张**几何可控**的图：一条**短竖边同时穿过两条长横边** ⇒ 它必然被断**两处**。
 * 判据三件：
 *   ① 交叉 2 处、断 2 处、段 3 段（两处缺口都真的存在）；
 *   ② 两处缺口都 = 2×GAP_HALF（沿边自己的方向量）；
 *   ③ `data-cuts` == 该边作为 low 的交叉点数（"逐点"是**等式**，不是"≥1"）。
 * ================================================================== */
describe('判据 2（逐点）：一条边被断**两处**时，两处都得断（不只第一处）', () => {
  /** 短竖边 v1 穿过两条长横边 h1 / h2（长 ⇒ 高优先级 ⇒ 被断的是 v1，正好两次） */
  function twoCrossDoc() {
    return {
      graph: { version: 1, direction: 'LR', grid: 8,
        edges: [
          { id: 'h1', from: { node: 'a', port: 'e' }, to: { node: 'b', port: 'w' } },
          { id: 'h2', from: { node: 'c', port: 'e' }, to: { node: 'd', port: 'w' } },
          { id: 'v1', from: { node: 'e', port: 's' }, to: { node: 'f', port: 'n' } }
        ] },
      nodes: [
        { id: 'a', type: 'rect', rect: [0, 88, 64, 32], title: 'A' },
        { id: 'b', type: 'rect', rect: [400, 88, 64, 32], title: 'B' },
        { id: 'c', type: 'rect', rect: [0, 184, 64, 32], title: 'C' },
        { id: 'd', type: 'rect', rect: [400, 184, 64, 32], title: 'D' },
        { id: 'e', type: 'rect', rect: [192, 0, 64, 32], title: 'E' },
        { id: 'f', type: 'rect', rect: [192, 280, 64, 32], title: 'F' }
      ]
    };
  }

  it('① 这张图真的有"一条边两处交叉"（否则下面两条是空转）', () => {
    const { report } = D.render(twoCrossDoc(), { routing: 'orthogonal' });
    const lows = report.routing.crossingPoints.filter((c) => c.low === 'v1');
    expect(lows.length, 'v1 作为低优先级的交叉点数').toBe(2);
    expect(report.routing.crossings).toBe(2);
  });

  it('② + ③ 两处缺口都在、且 `data-cuts` == 交叉点数（逐点是等式，不是 ≥1）', () => {
    const { svg, report } = D.render(twoCrossDoc(), { routing: 'orthogonal' });
    const m = svg.match(/<g data-edge="v1"[^>]*data-cuts="(\d+)"/);
    expect(m, 'v1 没有 data-cuts').toBeTruthy();
    const lowCount = report.routing.crossingPoints.filter((c) => c.low === 'v1').length;
    expect(Number(m[1]), 'v1 的 data-cuts 与"它是低优先级的交叉点数"不一致').toBe(lowCount);
    // v1 被两处缺口切成 3 段
    const segs = (svg.match(/<line data-edge="v1" data-seg="\d+"/g) || []).length;
    expect(segs, 'v1 只被断了一处（段数 = ' + segs + '，两处缺口应为 3 段）').toBe(3);
    // 沿 y（v1 是竖的）量：每段之间的空白 = 2×GAP_HALF
    const ys = [];
    const re = /<line data-edge="v1" data-seg="\d+" x1="[-\d.]+" y1="([-\d.]+)" x2="[-\d.]+" y2="([-\d.]+)"/g;
    let g;
    while ((g = re.exec(svg)) !== null) ys.push([Number(g[1]), Number(g[2])]);
    ys.sort((p, q) => p[0] - q[0]);
    const gaps = [];
    for (let i = 0; i + 1 < ys.length; i++) gaps.push(Math.abs(ys[i + 1][0] - ys[i][1]));
    expect(gaps.length).toBe(2);
    gaps.forEach((gap, i) => {
      expect(Math.abs(gap - 2 * D.GAP_HALF), '第 ' + i + ' 处缺口 = ' + gap + 'px').toBeLessThanOrEqual(0.5);
    });
  });
});
