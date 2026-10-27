/* ============================================================
 * src/diagram/route.js — **正交布线 / 通道 lane / 交叉 overpass / 边标签避让**
 * ------------------------------------------------------------
 * 这个模块把"节点已经摆好"变成"每条边是一条可量的折线"。它不画 SVG，只出几何 + 读数。
 *
 * 五件事，与判据一一对应（判据在 `tests/diagram-route.test.js`）：
 *   ① **端口与同侧多支线**（`C-F3-02` / `C-F3-09`）：端口坐标由矩形与端口名定；同一节点同一侧
 *      有多条边时按 **edge id 升序**做**确定性展开**（间距 `FANOUT_GAP`=16 ⇒ 永远 8 的整数倍）。
 *      外部证据（archify）："共享的自动端点会确定性展开，不再让多支箭头堆在同一个中点"。
 *   ② **网格障碍图上的 A***（`C-A-05`）：代价 = 长度 + 拐弯 + 交叉 + 贴边（四项都能在报告里读到）。
 *      障碍 = 所有节点矩形；路径**不许进入任何节点矩形的内部**（判据 1：边穿框 0）。
 *   ③ **通道 lane 分配**（`C-F3-19`）：同一条正交通道（两列节点之间的空白竖带）里的多条平行线，
 *      按 `LANE_GAP` **均匀分道**，相邻中心距 ≥ 8px（判据 4）。
 *   ④ **交叉检测 + overpass**（`C-F3-16`…`18`）：交叉点用**几何算法**在最终折线上数；
 *      低优先级线在交点两侧各断 `GAP_HALF`=2px（合计 4px），高优先级线在交点处画白色描边（`HALO_WIDTH`=4）。
 *      **逐点**都要处理 —— 只统计不画，等于没做。
 *   ⑤ **边标签避让**（`C-F3-14` / `15`）：候选位（沿线中点 / 上下偏移 / 两端偏移）逐个做矩形碰撞
 *      打分（压框 / 压线 / 压别的标签 / 到别的路径的净空 / 出界 / 离自然位多远），取最优。
 *      **压框 = 直接淘汰**（不是"扣点分"），因为判据 7 要求零压框。
 *
 * 确定性（判据 5/6）：零时钟、零随机；所有集合遍历前先按 id 排序；优先级只由**边长与 id** 定；
 * 网格邻域固定顺序（E/S/W/N）；堆的相等键按坐标字典序破平。两跑逐字节一致。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tokens.js'), require('./wrap.js'));
  else root.MMDiagramRoute = factory(root.MMDiagramTokens, root.MMDiagramWrap);
})(typeof self !== 'undefined' ? self : this, function (tokens, wrap) {
  'use strict';

  const LANE_GAP = tokens.LANE_GAP;
  const LANE_MARGIN = tokens.LANE_MARGIN;
  const FANOUT_GAP = tokens.FANOUT_GAP;
  const GAP_HALF = tokens.GAP_HALF;
  const HALO_WIDTH = tokens.HALO_WIDTH;
  const STEP_COST = tokens.STEP_COST;
  const BEND_PENALTY = tokens.BEND_PENALTY;
  const CROSS_PENALTY = tokens.CROSS_PENALTY;
  const HUG_PENALTY = tokens.HUG_PENALTY;
  const HUG_RANGE_CELLS = tokens.HUG_RANGE_CELLS;
  const OVERLAP_PENALTY = tokens.OVERLAP_PENALTY;
  const ROUTE_MARGIN = tokens.ROUTE_MARGIN;
  const ROUTE_MAX_STATES = tokens.ROUTE_MAX_STATES;
  const LABEL_FONT_SIZE = tokens.LABEL_FONT_SIZE;
  const LABEL_HEIGHT = tokens.LABEL_HEIGHT;
  const LABEL_CLEARANCE = tokens.LABEL_CLEARANCE;
  const LABEL_PATH_CLEARANCE = tokens.LABEL_PATH_CLEARANCE;
  const CURVE_MIN_K = tokens.CURVE_MIN_K;
  const CURVE_K_DIV = tokens.CURVE_K_DIV;
  const CURVE_SAMPLES = tokens.CURVE_SAMPLES;
  const MMDiagramError = tokens.MMDiagramError;
  const EPS = tokens.EPS;

  const PORTS_ORDER = ['n', 'e', 's', 'w'];
  const DIRS = [{ di: 1, dj: 0, name: 'E' }, { di: 0, dj: 1, name: 'S' },
    { di: -1, dj: 0, name: 'W' }, { di: 0, dj: -1, name: 'N' }];

  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  /* ==================================================================
   * 一、端口几何（`C-F3-02` / `C-F3-03`），MS1 的实现原样搬过来（判据两处共用一份）
   * ================================================================== */

  /** 端口坐标（未给自定义坐标时按矩形四边中点；给定 `ports` 时用声明值，±0.5px 判据就靠它） */
  function portPoint(node, port) {
    const custom = node.ports && node.ports[port];
    if (custom) return { x: custom[0], y: custom[1] };
    const r = node.rect;
    if (port === 'n') return { x: r.x + r.w / 2, y: r.y };
    if (port === 's') return { x: r.x + r.w / 2, y: r.y + r.h };
    if (port === 'e') return { x: r.x + r.w, y: r.y + r.h / 2 };
    return { x: r.x, y: r.y + r.h / 2 };                             // 'w'
  }

  /** 自动选边（`C-F3-03`）：4×4 个端口组合里取代价（欧氏距离）最小的一对；
   *  相等时按 `n<e<s<w` **定序**（先到先得 ⇒ 同输入同结果，不靠对象键序）。 */
  function autoPorts(fromNode, toNode, fixedFrom, fixedTo) {
    const fromCand = fixedFrom ? [fixedFrom] : PORTS_ORDER;
    const toCand = fixedTo ? [fixedTo] : PORTS_ORDER;
    let best = null;
    fromCand.forEach((pf) => {
      toCand.forEach((pt) => {
        const a = portPoint(fromNode, pf);
        const b = portPoint(toNode, pt);
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || d < best.d - EPS) best = { pf: pf, pt: pt, d: d };
      });
    });
    return { from: best.pf, to: best.pt };
  }

  /** 箭头三角（**不用 `<marker>`**：`url(#id)` 会被"0 个外链"的判据扫到 —— 多边形没这个问题） */
  function arrowPolygon(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < EPS) return null;                                     // 零长边不画箭头（也不编一个方向）
    const ux = dx / len;
    const uy = dy / len;
    const bx = x2 - ux * 10;
    const by = y2 - uy * 10;
    const px = -uy * 4.5;
    const py = ux * 4.5;
    return [[x2, y2], [bx + px, by + py], [bx - px, by - py]];
  }

  /* ==================================================================
   * 二½、曲线路由（`C-F3-05`）：三次贝塞尔，控制点**由端口法向导出**
   * ================================================================== */

  /** 端口的外法向（曲线控制点必须落在这条射线上 ⇒ "沿着端口方向进出"） */
  const SIDE_NORMAL = Object.freeze({
    n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0]
  });

  /**
   * 一条曲线边的控制点。**纯函数**（判据要按同一个式子独立复算一遍，见
   * `tests/diagram-curve.test.js` 的 `recountCurve`）：
   *   `k  = max(CURVE_MIN_K, |p3 − p0| / CURVE_K_DIV)`
   *   `c1 = p0 + normal(sideFrom) · k`
   *   `c2 = p3 + normal(sideTo)   · k`
   * 零随机、零时钟、零拟合 ⇒ 同输入同控制点。
   */
  function curveControl(p0, sideFrom, p3, sideTo) {
    const k = Math.max(CURVE_MIN_K, Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / CURVE_K_DIV);
    const n0 = SIDE_NORMAL[sideFrom] || [1, 0];
    const n3 = SIDE_NORMAL[sideTo] || [-1, 0];
    return { c1: [p0[0] + n0[0] * k, p0[1] + n0[1] * k], c2: [p3[0] + n3[0] * k, p3[1] + n3[1] * k], k: k };
  }

  /** 三次贝塞尔的**固定采样**（t = i/n，i = 0..n）：曲线参与"可量"的判据（交叉/穿框/标签）时用它。
   *  ⚠️ 采样只用于**判据侧的量**；画出来的是 `C` 命令（矢量、不抖），两者共用同一组控制点。 */
  function flattenCubic(p0, c1, c2, p3, n) {
    const count = Math.max(2, n || CURVE_SAMPLES);
    const out = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const u = 1 - t;
      const x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0];
      const y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1];
      out.push([x, y]);
    }
    return out;
  }

  /** 三次贝塞尔在参数 t 处的点（判据复算控制点用；也用于白描的切向） */
  function cubicAt(p0, c1, c2, p3, t) {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]
    ];
  }

  /* ==================================================================
   * 二、折线小工具（**判据与实现都要用，但判据自己再写一份几何**：见 tests 里的 recount）
   * ================================================================== */

  function dedupe(points) {
    const out = [];
    points.forEach((p) => {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) return;
      out.push([p[0], p[1]]);
    });
    return out;
  }

  /** 合并共线点（A* 输出的逐格台阶 ⇒ 折线；不合并的话"折点数"这个读数就全是噪声） */
  function simplify(points) {
    const p = dedupe(points);
    if (p.length <= 2) return p;
    const out = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
      const a = out[out.length - 1];
      const b = p[i];
      const c = p[i + 1];
      const sameX = Math.abs(a[0] - b[0]) < EPS && Math.abs(b[0] - c[0]) < EPS;
      const sameY = Math.abs(a[1] - b[1]) < EPS && Math.abs(b[1] - c[1]) < EPS;
      if (sameX || sameY) continue;
      out.push(b);
    }
    out.push(p[p.length - 1]);
    return out;
  }

  /** 折线 → 线段数组 */
  function segmentsOf(points) {
    const out = [];
    for (let i = 0; i + 1 < points.length; i++) {
      out.push([points[i], points[i + 1]]);
    }
    return out;
  }

  function isHorizontal(seg) { return Math.abs(seg[0][1] - seg[1][1]) < EPS; }
  function isVertical(seg) { return Math.abs(seg[0][0] - seg[1][0]) < EPS; }

  /** 线段的包围盒（判"贴不贴边""有没有重叠"用） */
  function segBox(seg) {
    return {
      x: Math.min(seg[0][0], seg[1][0]), y: Math.min(seg[0][1], seg[1][1]),
      w: Math.abs(seg[1][0] - seg[0][0]), h: Math.abs(seg[1][1] - seg[0][1])
    };
  }

  /** 两条线段的**内部-内部**交点（端点相碰不算：那是端口/转折，不是交叉）。
   *  为什么写通用版而不是只判"横×竖"：`route: straight` 的边是斜线，斜线与任何线相交也
   *  必须被数进 `crossings`（否则"直连边从别人身上穿过去"这件事在报告里是 0）。 */
  function properCross(a, b) {
    const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = cr(b[0], b[1], a[0]);
    const d2 = cr(b[0], b[1], a[1]);
    const d3 = cr(a[0], a[1], b[0]);
    const d4 = cr(a[0], a[1], b[1]);
    const opposite = (x, y) => (x > EPS && y < -EPS) || (x < -EPS && y > EPS);
    if (!opposite(d1, d2) || !opposite(d3, d4)) return null;
    // 参数式求交点（两条线都不退化：d1/d2 异号 ⇒ 端点不重合）
    const t = d1 / (d1 - d2);
    return { x: a[0][0] + (a[1][0] - a[0][0]) * t, y: a[0][1] + (a[1][1] - a[0][1]) * t };
  }

  /** 两条平行线段是否**重叠**（同一条线上且投影区间有重叠长度）—— lane 的判据就是"不许重叠" */
  function parallelOverlap(a, b) {
    const ha = isHorizontal(a);
    const hb = isHorizontal(b);
    if (ha !== hb) return null;
    const c1 = ha ? a[0][1] : a[0][0];
    const c2 = ha ? b[0][1] : b[0][0];
    if (Math.abs(c1 - c2) > EPS) return null;
    const p1 = ha ? [Math.min(a[0][0], a[1][0]), Math.max(a[0][0], a[1][0])]
      : [Math.min(a[0][1], a[1][1]), Math.max(a[0][1], a[1][1])];
    const p2 = ha ? [Math.min(b[0][0], b[1][0]), Math.max(b[0][0], b[1][0])]
      : [Math.min(b[0][1], b[1][1]), Math.max(b[0][1], b[1][1])];
    const lo = Math.max(p1[0], p2[0]);
    const hi = Math.min(p1[1], p2[1]);
    if (hi - lo <= EPS) return null;
    return { coord: c1, lo: lo, hi: hi };
  }

  /* ==================================================================
   * 三、A*（`C-A-05`）：网格障碍图 + 四项代价
   * ================================================================== */

  /** 确定性二叉堆：键 (f, h, tie)；相等时按 tie 字典序破平（不靠插入顺序） */
  class MinHeap {
    constructor() { this.a = []; }
    static less(x, y) {
      if (x.f !== y.f) return x.f < y.f;
      if (x.h !== y.h) return x.h < y.h;
      return x.tie < y.tie;
    }
    push(item) {
      const a = this.a;
      a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (MinHeap.less(a[i], a[p])) { const t = a[i]; a[i] = a[p]; a[p] = t; i = p; } else break;
      }
    }
    pop() {
      const a = this.a;
      if (!a.length) return null;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && MinHeap.less(a[l], a[m])) m = l;
          if (r < a.length && MinHeap.less(a[r], a[m])) m = r;
          if (m === i) break;
          const t = a[i]; a[i] = a[m]; a[m] = t;
          i = m;
        }
      }
      return top;
    }
    get size() { return this.a.length; }
  }

  /**
   * 一次 A*。起点/终点都是**格点**（world 坐标 = i·grid）。
   * @returns {{points:Array<[number,number]>, cost:object}} 或 `null`（无解）
   */
  function astar(grid, box, start, goal, startDir, occ, blockAt, opts) {
    const step = STEP_COST;
    const penaltyBend = opts && isNum(opts.bendPenalty) ? opts.bendPenalty : BEND_PENALTY;
    const penaltyCross = opts && isNum(opts.crossPenalty) ? opts.crossPenalty : CROSS_PENALTY;
    const penaltyHug = opts && isNum(opts.hugPenalty) ? opts.hugPenalty : HUG_PENALTY;
    const penaltyOverlap = opts && isNum(opts.overlapPenalty) ? opts.overlapPenalty : OVERLAP_PENALTY;
    const si = start.i;
    const sj = start.j;
    const gi = goal.i;
    const gj = goal.j;
    const key = (i, j, d) => i + ',' + j + ',' + d;
    const open = new MinHeap();
    const gScore = new Map();
    const from = new Map();
    const h0 = (Math.abs(gi - si) + Math.abs(gj - sj)) * step;
    const sKey = key(si, sj, startDir);
    gScore.set(sKey, 0);
    open.push({ i: si, j: sj, d: startDir, f: h0, g: 0, h: h0, tie: key(si, sj, startDir) });
    let states = 0;
    while (open.size) {
      const cur = open.pop();
      const curKey = key(cur.i, cur.j, cur.d);
      if (cur.g > (gScore.has(curKey) ? gScore.get(curKey) : Infinity) + EPS) continue;
      if (cur.i === gi && cur.j === gj) {
        // 回溯
        const pts = [];
        let k = curKey;
        for (;;) {
          const parts = k.split(',');
          pts.push([Number(parts[0]), Number(parts[1])]);
          const p = from.get(k);
          if (!p) break;
          k = p;
        }
        pts.reverse();
        // 四项代价的**读数**（路径定下来之后逐段量，不靠搜索过程中的累加器 —— 免得读数与实际路径不符）
        const rc = { length: (pts.length - 1) * grid, bends: 0, crossings: 0, hugs: 0 };
        for (let i = 1; i < pts.length; i++) {
          const dx = pts[i][0] - pts[i - 1][0];
          const dy = pts[i][1] - pts[i - 1][1];
          if (i >= 2) {
            const pdx = pts[i - 1][0] - pts[i - 2][0];
            const pdy = pts[i - 1][1] - pts[i - 2][1];
            if (dx !== pdx || dy !== pdy) rc.bends++;
          }
          if (occ.point.has(pts[i][0] + ',' + pts[i][1])) rc.crossings++;
          if (occ.nearBlocked(pts[i][0], pts[i][1], blockAt, HUG_RANGE_CELLS)) rc.hugs++;
        }
        return { points: pts, cost: rc };
      }
      for (let di = 0; di < DIRS.length; di++) {
        const d2 = di;
        const ni = cur.i + DIRS[di].di;
        const nj = cur.j + DIRS[di].dj;
        if (ni < box.i0 || ni > box.i1 || nj < box.j0 || nj > box.j1) continue;
        if (blockAt(ni, nj)) continue;
        let c = step;
        let bends = 0;
        if (d2 !== cur.d) { c += penaltyBend; bends = 1; }
        const nKey = key(ni, nj, d2);
        let crossings = 0;
        if (occ.point.has(ni + ',' + nj)) { c += penaltyCross; crossings = 1; }
        if (occ.dir.has(nKey)) c += penaltyOverlap;
        let hugs = 0;
        if (occ.nearBlocked(ni, nj, blockAt, HUG_RANGE_CELLS)) { c += penaltyHug; hugs = 1; }
        const ng = cur.g + c;
        if (ng < (gScore.has(nKey) ? gScore.get(nKey) : Infinity) - EPS) {
          gScore.set(nKey, ng);
          from.set(nKey, curKey);
          const h = (Math.abs(gi - ni) + Math.abs(gj - nj)) * step;
          open.push({ i: ni, j: nj, d: d2, f: ng + h, g: ng, h: h, tie: nKey });
          states++;
          if (states > ROUTE_MAX_STATES) return null;
        }
      }
    }
    return null;
  }

  /* ==================================================================
   * 四、主入口：`routeAll`
   * ================================================================== */

  /** 竖直空白带（LR）与水平空白带（TB）——通道就是"两列节点之间没有节点的那一段" */
  function emptyBands(intervals, minWidth) {
    const sorted = intervals.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const merged = [];
    sorted.forEach((iv) => {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + EPS) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    });
    const gaps = [];
    for (let i = 0; i + 1 < merged.length; i++) {
      const a = merged[i][1];
      const b = merged[i + 1][0];
      if (b - a >= minWidth) gaps.push([a, b]);
    }
    return gaps;
  }

  /** 贴边判据：点是否在任一节点矩形外扩 `pad` 之内（用于 A* 的"贴边惩罚"） */
  function makeNearBlocked(rects, pad) {
    return function near(i, j, grid) {
      const x = i * grid;
      const y = j * grid;
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
      }
      return false;
    };
  }

  /**
   * 布线主函数。
   *
   * @param {object} input
   *   `{ nodes: [{id, rect, ports}], edges: [{id, from:{node,port}, to:{node,port}, route, label}],
   *      direction, grid, measurer, canvas:{x,y,w,h}, penalty? }`
   * @returns {{edges:object, crossings:Array, touches:Array, labels:object, stats:object, problems:string[], degraded:string[]}}
   */
  function routeAll(input) {
    const inp = input || {};
    const grid = isNum(inp.grid) && inp.grid > 0 ? inp.grid : 8;
    const direction = inp.direction === 'TB' ? 'TB' : 'LR';
    const measurer = inp.measurer;
    const nodes = Array.isArray(inp.nodes) ? inp.nodes.filter((n) => isPlain(n) && typeof n.id === 'string' && isPlain(n.rect)) : [];
    const nodeById = new Map();
    nodes.forEach((n) => nodeById.set(n.id, n));
    const edgesIn = Array.isArray(inp.edges) ? inp.edges : [];
    const edges = edgesIn
      .filter((e) => isPlain(e) && typeof e.id === 'string' && isPlain(e.from) && isPlain(e.to)
        && nodeById.has(e.from.node) && nodeById.has(e.to.node))
      .slice()
      .sort((a, b) => byId(a.id, b.id));

    const problems = [];
    const degraded = [];
    const result = {
      edges: {}, crossings: [], touches: [], labels: {}, overlaps: [],
      stats: { crossings: 0, expected: 0, unexpected: 0, lanes: [], cost: { length: 0, bends: 0, crossings: 0, hugs: 0 } },
      problems: problems, degraded: degraded
    };
    if (!edges.length) return result;

    /* ---- ① 端口：方向偏好 + 同侧多支线确定性展开 ---- */
    const want = new Map();      // `${nodeId}|${side}` → [{edgeId, end}]
    const plan = new Map();      // edgeId → {fromSide, toSide}
    const rectOf = (id) => nodeById.get(id).rect;
    const centerOf = (id) => {
      const r = rectOf(id);
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    };
    edges.forEach((e) => {
      const a = centerOf(e.from.node);
      const b = centerOf(e.to.node);
      let fromSide;
      let toSide;
      if (e.from.port) fromSide = e.from.port;
      else if (direction === 'LR') fromSide = b.x >= a.x ? 'e' : 'w';
      else fromSide = b.y >= a.y ? 's' : 'n';
      if (e.to.port) toSide = e.to.port;
      else if (direction === 'LR') toSide = b.x >= a.x ? 'w' : 'e';
      else toSide = b.y >= a.y ? 'n' : 's';
      plan.set(e.id, { fromSide: fromSide, toSide: toSide });
      if (e.from.node !== e.to.node) {
        // 展开的**顺序键** = 另一端中心的投影（LR 看 y，TB 看 x）。
        // 为什么不是"按 edge id 排"：同侧几条边若按 id 排，它们的端口顺序与目标顺序无关，
        // 于是"两条边出同一侧、却要往相反方向排"⇒ 必然交叉一次。按目标顺序排就自然不交叉。
        // 顺序键仍**完全确定**（先比坐标、再比 edge id）⇒ 同输入同展开、两跑一致。
        const keyOf = (otherId) => {
          const c = centerOf(otherId);
          return direction === 'LR' ? c.y : c.x;
        };
        const k1 = e.from.node + '|' + fromSide;
        if (!want.has(k1)) want.set(k1, []);
        want.get(k1).push({ edgeId: e.id, end: 'from', key: keyOf(e.to.node) });
        const k2 = e.to.node + '|' + toSide;
        if (!want.has(k2)) want.set(k2, []);
        want.get(k2).push({ edgeId: e.id, end: 'to', key: keyOf(e.from.node) });
      }
    });
    const offsetOf = new Map();  // `${edgeId}|${end}` → offset
    Array.from(want.keys()).sort(byId).forEach((k) => {
      const list = want.get(k).slice().sort((x, y) => (x.key - y.key) || byId(x.edgeId, y.edgeId) || byId(x.end, y.end));
      const n = list.length;
      list.forEach((it, idx) => {
        // (2k − (n−1)) × (FANOUT_GAP/2) ⇒ 永远是 8 的整数倍（`C-F3-09` 的 ≥8px 由此可复算）
        offsetOf.set(it.edgeId + '|' + it.end, (2 * idx - (n - 1)) * (FANOUT_GAP / 2));
      });
    });

    const portAt = (edgeId, end) => {
      const e = edges.find((x) => x.id === edgeId);
      const p = end === 'from' ? e.from : e.to;
      const node = nodeById.get(p.node);
      const side = end === 'from' ? plan.get(edgeId).fromSide : plan.get(edgeId).toSide;
      const base = portPoint(node, side);
      const off = offsetOf.get(edgeId + '|' + end) || 0;
      if (side === 'n' || side === 's') return { side: side, x: base.x + off, y: base.y };
      return { side: side, x: base.x, y: base.y + off };
    };

    /* ---- 网格障碍图 ---- */
    const rects = nodes.map((n) => n.rect);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    rects.forEach((r) => {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    });
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = grid; maxY = grid; }
    const box = {
      i0: Math.floor((minX - ROUTE_MARGIN) / grid), i1: Math.ceil((maxX + ROUTE_MARGIN) / grid),
      j0: Math.floor((minY - ROUTE_MARGIN) / grid), j1: Math.ceil((maxY + ROUTE_MARGIN) / grid)
    };
    const blocked = new Set();
    for (let i = box.i0; i <= box.i1; i++) {
      for (let j = box.j0; j <= box.j1; j++) {
        const x = i * grid;
        const y = j * grid;
        for (let k = 0; k < rects.length; k++) {
          const r = rects[k];
          // **含边框**（区间闭合）：点在矩形边上也算占用 —— 否则会画出一条"贴着框边跑"的线，
          // 严格说它没进内部（判据 1 绿），但视觉上与框粘在一起，是"看着不对、判据却不红"的典型形态。
          if (x >= r.x - EPS && x <= r.x + r.w + EPS && y >= r.y - EPS && y <= r.y + r.h + EPS) {
            blocked.add(i + ',' + j);
            break;
          }
        }
      }
    }
    const blockAt = (i, j) => blocked.has(i + ',' + j);
    const nearBlocked = makeNearBlocked(rects, HUG_RANGE_CELLS * grid);

    const occ = {
      point: new Set(),      // 'i,j'：别的边已经用过的格点
      dir: new Set(),        // 'i,j,d'：别的边在这个方向上走过的格边（重叠惩罚）
      nearBlocked: (i, j) => nearBlocked(i, j, grid)
    };

    /** 从端口出发的**外侧格点**：沿端口法向外推，再吸到 8px 网格上。
     *  起点被占（旁边紧贴着另一个框）时**逐步外推**，最多试 6 步 —— 而不是直接画一条穿框的 L。 */
    function outward(port, step) {
      const d = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[port.side];
      for (let k = 1; k <= 6; k++) {
        const tx = port.x + d[0] * step * k;
        const ty = port.y + d[1] * step * k;
        const i = Math.round(tx / grid);
        const j = Math.round(ty / grid);
        if (!blockAt(i, j)) return { i: i, j: j, x: i * grid, y: j * grid };
      }
      const i = Math.round((port.x + d[0] * step) / grid);
      const j = Math.round((port.y + d[1] * step) / grid);
      return { i: i, j: j, x: i * grid, y: j * grid, stuck: true };
    }

    const polylines = new Map();
    const curves = new Map();          // edgeId → { p0, c1, c2, p3, samples }（曲线边的控制点：判据可复算）
    let costSum = { length: 0, bends: 0, crossings: 0, hugs: 0 };

    edges.forEach((e) => {
      const from = portAt(e.id, 'from');
      const to = portAt(e.id, 'to');
      if (e.from.node === e.to.node) {
        // 自环（`C-F3-10`）：固定形状（右出 → 上折 → 左进 → 下到 n 端口），不跑 A*
        const r = rectOf(e.from.node);
        const out = 16;
        const pts = simplify([
          [from.x, from.y],
          [from.x + out, from.y],
          [from.x + out, r.y - out],
          [r.x + r.w / 2, r.y - out],
          [r.x + r.w / 2, r.y]
        ]);
        polylines.set(e.id, pts);
        result.edges[e.id] = { route: 'orthogonal', fromPort: from.side, toPort: 'n', points: pts };
        return;
      }
      if (e.route === 'straight') {
        const pts = [[from.x, from.y], [to.x, to.y]];
        polylines.set(e.id, pts);
        result.edges[e.id] = { route: 'straight', fromPort: from.side, toPort: to.side, points: pts };
        return;
      }
      if (e.route === 'curve') {
        // 曲线（`C-F3-05`）：控制点由两端端口法向导出；折线 = 固定采样（只给判据量，画的是 `C` 命令）
        const p0 = [from.x, from.y];
        const p3 = [to.x, to.y];
        const cv = curveControl(p0, from.side, p3, to.side);
        const pts = flattenCubic(p0, cv.c1, cv.c2, p3, CURVE_SAMPLES);
        polylines.set(e.id, pts);
        const curve = { p0: p0, c1: cv.c1, c2: cv.c2, p3: p3, k: cv.k, samples: CURVE_SAMPLES };
        curves.set(e.id, curve);
        result.edges[e.id] = { route: 'curve', fromPort: from.side, toPort: to.side, points: pts, curve: curve };
        return;
      }
      const s = outward(from, grid);
      const g = outward(to, grid);
      if (blockAt(s.i, s.j) || blockAt(g.i, g.j)) {
        problems.push('E_ROUTE_MARGIN: 边 ' + e.id + ' 的端口外侧格点被节点框占用（外推 6 步仍被占）—— '
          + '这条边已按"端口外推 + 两折"兜底画出，报告里如实登记，不当作正常路径');
        const pts = simplify([[from.x, from.y], [s.x, from.y], [s.x, to.y], [to.x, to.y]]);
        polylines.set(e.id, pts);
        result.edges[e.id] = { route: 'orthogonal', fromPort: from.side, toPort: to.side, points: pts, fallback: true };
        return;
      }
      const startDir = from.side === 'e' ? 0 : (from.side === 's' ? 1 : (from.side === 'w' ? 2 : 3));
      const found = astar(grid, box, s, g, startDir, occ, blockAt, inp.penalty);
      if (!found) {
        throw new MMDiagramError('E_ROUTE_FAILED',
          '边 ' + e.id + ' 在网格障碍图上找不到通路（起点 ' + from.x + ',' + from.y + ' → 终点 '
          + to.x + ',' + to.y + '，网格 ' + grid + 'px，外扩 ' + ROUTE_MARGIN + 'px）—— '
          + '本内核**不把无解画成一条穿框的直线**：可以加大节点间距（`graph.gap.node` / `gap.rank`）'
          + '或减少穿过同一通道的边数后重试',
          { object: { edge: e.id, from: from, to: to }, fixes: ['增大 graph.gap', '拆分长边', '减少同通道边数'] });
      }
      // 端口 → 外侧格点 → A* 路径 → 终点外侧格点 → 端口
      const pts = simplify([[from.x, from.y], [s.x, s.y]]
        .concat(found.points.map((p) => [p[0] * grid, p[1] * grid]))
        .concat([[g.x, g.y], [to.x, to.y]]));
      polylines.set(e.id, pts);
      result.edges[e.id] = { route: 'orthogonal', fromPort: from.side, toPort: to.side, points: pts };
      costSum.length += found.cost.length;
      costSum.bends += (pts.length - 2);
      costSum.crossings += found.cost.crossings;
      costSum.hugs += found.cost.hugs;
      // 登记占用（两端各留一格不登记：共享端点的边不该被"占用"惩罚扭曲）
      for (let i = 0; i + 1 < found.points.length; i++) {
        occ.point.add(found.points[i][0] + ',' + found.points[i][1]);
        const dx = found.points[i + 1][0] - found.points[i][0];
        const dy = found.points[i + 1][1] - found.points[i][1];
        const d = dx > 0 ? 0 : (dy > 0 ? 1 : (dx < 0 ? 2 : 3));
        occ.dir.add(found.points[i][0] + ',' + found.points[i][1] + ',' + d);
      }
    });

    /* ---- ③ lane 分配：按"空白带"分道 ---- */
    const vBands = emptyBands(rects.map((r) => [r.x, r.x + r.w]), LANE_GAP + LANE_MARGIN);
    const hBands = emptyBands(rects.map((r) => [r.y, r.y + r.h]), LANE_GAP + LANE_MARGIN);
    const primaryBands = direction === 'LR' ? vBands : hBands;

    const laneReport = [];

    /** 数"当前几何"下的交叉数（lane 顺序的取舍靠它，不靠猜） */
    const geometricCrossings = () => {
      const ids = edges.map((e) => e.id).filter((id) => polylines.get(id));
      let n = 0;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const sa = segmentsOf(polylines.get(ids[i]));
          const sb = segmentsOf(polylines.get(ids[j]));
          for (let x = 0; x < sa.length; x++) for (let y = 0; y < sb.length; y++) if (properCross(sa[x], sb[y])) n++;
        }
      }
      return n;
    };

    primaryBands.forEach((band) => {
      const isV = direction === 'LR';
      const lo = band[0];
      const hi = band[1];
      // 收集落在该带内的"主方向段"（LR = 竖段；TB = 横段）
      const items = [];
      edges.forEach((e) => {
        if (curves.has(e.id)) return;                          // 曲线不参与通道分道（它的几何由控制点定死）
        const pts = polylines.get(e.id);
        for (let i = 0; i + 1 < pts.length; i++) {
          if (i === 0 || i === pts.length - 2) continue;      // 端口段**不许平移**（会改掉端点锚点）
          const seg = [pts[i], pts[i + 1]];
          const v = isVertical(seg);
          const h = isHorizontal(seg);
          if (isV && !v) continue;
          if (!isV && !h) continue;
          const coord = isV ? seg[0][0] : seg[0][1];
          if (coord <= lo + EPS || coord >= hi - EPS) continue;
          const from = isV ? Math.min(seg[0][1], seg[1][1]) : Math.min(seg[0][0], seg[1][0]);
          const to = isV ? Math.max(seg[0][1], seg[1][1]) : Math.max(seg[0][0], seg[1][0]);
          items.push({ edgeId: e.id, segIndex: i, coord: coord, from: from, to: to });
        }
      });
      if (!items.length) return;
      const n = items.length;
      const center = (lo + hi) / 2;
      const needSpan = (n - 1) * LANE_GAP;
      const usable = (hi - lo) - 2 * LANE_MARGIN;
      if (needSpan > usable + EPS) {
        degraded.push('E_LANE_OVERFLOW: 通道 [' + lo + ',' + hi + '] 要放 ' + n + ' 条线（需 '
          + needSpan + 'px），可用的 ' + usable + 'px 不够 —— 已按最小间距 ' + LANE_GAP + 'px 溢出排布');
      }
      const laneX = (idx, count) => Math.round((center + (idx - (count - 1) / 2) * LANE_GAP) / grid) * grid;

      // 两种**确定性**候选顺序：按起点升序 / 按起点降序。
      // 为什么要挑：lane 顺序决定了"谁在左谁在右"，同一组线换个顺序，与既有横线段的交叉数会不同。
      // 判据 2 要的是"交叉尽量少"，所以这里**用几何数一下再选**（不猜、不随机，两跑同选）。
      const orders = [
        items.slice().sort((x, y) => (x.from - y.from) || byId(x.edgeId, y.edgeId) || (x.segIndex - y.segIndex)),
        items.slice().sort((x, y) => (y.from - x.from) || byId(x.edgeId, y.edgeId) || (x.segIndex - y.segIndex))
      ];
      const saved = items.map((it) => {
        const pts = polylines.get(it.edgeId);
        return [[pts[it.segIndex][0], pts[it.segIndex][1]], [pts[it.segIndex + 1][0], pts[it.segIndex + 1][1]]];
      });
      const restore = () => {
        items.forEach((it, k) => {
          const pts = polylines.get(it.edgeId);
          pts[it.segIndex][0] = saved[k][0][0];
          pts[it.segIndex][1] = saved[k][0][1];
          pts[it.segIndex + 1][0] = saved[k][1][0];
          pts[it.segIndex + 1][1] = saved[k][1][1];
        });
      };
      let best = null;
      orders.forEach((order, oi) => {
        restore();
        order.forEach((it, idx) => {
          const target = laneX(idx, n);
          const pts = polylines.get(it.edgeId);
          if (isV) { pts[it.segIndex][0] = target; pts[it.segIndex + 1][0] = target; }
          else { pts[it.segIndex][1] = target; pts[it.segIndex + 1][1] = target; }
        });
        const c = geometricCrossings();
        if (!best || c < best.crossings) best = { order: oi, crossings: c };
      });
      // 落到胜出的那一种
      restore();
      orders[best.order].forEach((it, idx) => {
        const target = laneX(idx, n);
        const pts = polylines.get(it.edgeId);
        if (isV) { pts[it.segIndex][0] = target; pts[it.segIndex + 1][0] = target; }
        else { pts[it.segIndex][1] = target; pts[it.segIndex + 1][1] = target; }
      });
      laneReport.push({ band: [lo, hi], count: n, order: best.order,
        lanes: orders[best.order].map((it, idx) => ({ edge: it.edgeId, at: laneX(idx, n) })) });
    });

    // 平移后重新合并共线点（原来的转折可能已经对齐）
    edges.forEach((e) => {
      const pts = polylines.get(e.id);
      if (!pts) return;
      const s2 = simplify(pts);
      polylines.set(e.id, s2);
      result.edges[e.id].points = s2;
    });

    /* ---- ③½ lane 复核：不同边的平行线间距 < LANE_GAP 且重叠 ⇒ 推开（确定性，最多 4 轮） */
    const allSegs = () => {
      const out = [];
      edges.forEach((e) => {
        const pts = polylines.get(e.id);
        for (let i = 0; i + 1 < pts.length; i++) out.push({ edgeId: e.id, segIndex: i, seg: [pts[i], pts[i + 1]] });
      });
      return out;
    };
    let repairRounds = 0;
    /** 把一段平移到新坐标（垂直于自身方向平移 ⇒ 正交性不变；两端的垂直段自然伸缩） */
    const shiftSegTo = (it, coord) => {
      const pts = polylines.get(it.edgeId);
      const p1 = pts[it.segIndex];
      const p2 = pts[it.segIndex + 1];
      if (isHorizontal([p1, p2])) { p1[1] = coord; p2[1] = coord; } else { p1[0] = coord; p2[0] = coord; }
    };
    const isPortSeg = (it) => {
      const pts = polylines.get(it.edgeId);
      return it.segIndex === 0 || it.segIndex === pts.length - 2;
    };
    for (let round = 0; round < 6; round++) {
      const segs = allSegs();
      let fixed = 0;
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          if (segs[i].edgeId === segs[j].edgeId) continue;
          // 曲线段**不许被平移**：平移一个采样点会把 `C` 命令的几何改坏（控制点才是曲线的真身）
          if (curves.has(segs[i].edgeId) || curves.has(segs[j].edgeId)) continue;
          const a = segs[i].seg;
          const b = segs[j].seg;
          const ha = isHorizontal(a);
          const hb = isHorizontal(b);
          if (ha !== hb) continue;
          const ca = ha ? a[0][1] : a[0][0];
          const cb = ha ? b[0][1] : b[0][0];
          // 投影重叠才算"同通道"（不重叠的平行线不需要间距）
          const pa = ha ? [Math.min(a[0][0], a[1][0]), Math.max(a[0][0], a[1][0])] : [Math.min(a[0][1], a[1][1]), Math.max(a[0][1], a[1][1])];
          const pb = ha ? [Math.min(b[0][0], b[1][0]), Math.max(b[0][0], b[1][0])] : [Math.min(b[0][1], b[1][1]), Math.max(b[0][1], b[1][1])];
          if (Math.min(pa[1], pb[1]) - Math.max(pa[0], pb[0]) <= EPS) continue;
          const sameLine = Math.abs(ca - cb) < EPS;
          if (!sameLine && Math.abs(ca - cb) >= LANE_GAP - EPS) continue;
          // 端口段（首/尾）**不许平移**（平了就把端点从锚点挪开）⇒ 推另一条
          let mover = null;
          if (!isPortSeg(segs[j])) mover = segs[j];
          else if (!isPortSeg(segs[i])) mover = segs[i];
          if (!mover) {
            // **两条都是端口段**（各自贴着不同节点、却在同一个 8px 走廊上同道）：
            // 端口段不能平移（会丢锚点），但**与它相邻的那条垂直段可以整段平移** ——
            // 平移"一条线"只改它两个端点的对应坐标，两端的垂直段自然伸缩，正交性不变；
            // 效果 = "出端口后早一点/晚一点拐弯"，重叠就消失了。
            const it = segs[j];
            const pts = polylines.get(it.edgeId);
            const isFirst = it.segIndex === 0;
            const adj = isFirst ? 1 : pts.length - 3;
            if (adj < 0 || adj >= pts.length - 1 || adj === it.segIndex) {
              result.overlaps.push({ a: segs[i].edgeId, b: segs[j].edgeId, at: ca, why: 'both-port-segments' });
              continue;
            }
            const portPt = isFirst ? pts[0] : pts[pts.length - 1];
            const freePt = isFirst ? pts[1] : pts[pts.length - 2];
            const alongX = ha;                                  // 水平端口段 ⇒ 相邻段是竖的
            const portC = alongX ? portPt[0] : portPt[1];
            const freeC = alongX ? freePt[0] : freePt[1];
            const dir = freeC >= portC ? 1 : -1;
            const targetC = Math.round((freeC - dir * LANE_GAP) / grid) * grid;
            if (Math.abs(targetC - portC) < grid - EPS) {
              result.overlaps.push({ a: segs[i].edgeId, b: segs[j].edgeId, at: ca, why: 'both-port-segments' });
              continue;
            }
            shiftSegTo({ edgeId: it.edgeId, segIndex: adj }, targetC);
            fixed++;
            continue;
          }
          const moverCoord = mover === segs[j] ? cb : ca;
          const otherCoord = mover === segs[j] ? ca : cb;
          // 方向：让"被推的"离"不动的"更远（确定性；同分时取 +1）
          const dir = moverCoord >= otherCoord ? 1 : -1;
          const target = Math.round((otherCoord + dir * LANE_GAP) / grid) * grid;
          shiftSegTo(mover, target);
          fixed++;
        }
      }
      repairRounds++;
      if (!fixed) break;
      edges.forEach((e) => {
        const s2 = simplify(polylines.get(e.id));
        polylines.set(e.id, s2);
        result.edges[e.id].points = s2;
      });
    }

    /* ---- ③¾ 正交性保险：平移/回退之后若有段不再是轴向，就地拆成两段（绝不留斜线） ---- */
    let skewFixed = 0;
    edges.forEach((e) => {
      if (curves.has(e.id)) return;                  // 曲线的采样段**本来就是斜的**（拆它就不是曲线了）
      const pts = polylines.get(e.id);
      if (!pts || pts.length < 2) return;
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const prev = out[out.length - 1];
        const cur = pts[i];
        const dx = Math.abs(cur[0] - prev[0]);
        const dy = Math.abs(cur[1] - prev[1]);
        if (dx > EPS && dy > EPS) {
          // 斜段 ⇒ 插一个折点（先走 x 再走 y），并记一笔（正常情况不该发生）
          out.push([cur[0], prev[1]]);
          skewFixed++;
        }
        out.push(cur);
      }
      const s2 = simplify(out);
      polylines.set(e.id, s2);
      result.edges[e.id].points = s2;
    });
    if (skewFixed) problems.push('E_ROUTE_SKEW: 有 ' + skewFixed + ' 段在 lane/repair 之后不再是轴向，已就地拆成两段');
    result.stats.skewFixed = skewFixed;

    /* ---- ④ 交叉检测（在**最终折线**上，用几何算法数） ---- */
    const priorityOf = new Map();
    edges.forEach((e) => {
      const pts = polylines.get(e.id) || [];
      let len = 0;
      for (let i = 0; i + 1 < pts.length; i++) len += Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]);
      priorityOf.set(e.id, { len: len, edge: e });
    });
    const shareEndpoint = (a, b) => a.from.node === b.from.node || a.from.node === b.to.node
      || a.to.node === b.from.node || a.to.node === b.to.node;

    const crossings = [];
    const touches = [];
    // **交叉的"预期/非预期"怎么分**（判据 2 只约束非预期 ≤ 3）：
    //   ① `shared-endpoint`：两条边共端点（扇出/汇聚）⇒ 端点上必然相遇，**结构性**，不算非预期；
    //   ② `back-edge`：其中一条是**回边**（去环时被反转的边，`report.layout.reversed[]`）——
    //      回边逆流穿过层带，与正向边交叉是分层布局的结构性结果（`C-F3-11` 也承认回边要绕）；
    //   ③ `interleave`：两条都是正向边、又不共端点 ⇒ 这才是**该被布局/布线消掉**的交叉，
    //      判据 2 的"≤ 3"约束的就是这一类（也是唯一一类会被注入改坏的）。
    // 逐条写进 `why`，所以"为什么它算预期"是可复查的，不是一句"我们算过了"。
    const reversedSet = new Set(Array.isArray(inp.reversed) ? inp.reversed : []);
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const ea = edges[i];
        const eb = edges[j];
        const pa = polylines.get(ea.id);
        const pb = polylines.get(eb.id);
        if (!pa || !pb) continue;
        const sa = segmentsOf(pa);
        const sb = segmentsOf(pb);
        const shared = shareEndpoint(ea, eb);
        const backEdge = reversedSet.has(ea.id) || reversedSet.has(eb.id);
        const why = shared ? 'shared-endpoint' : (backEdge ? 'back-edge' : 'interleave');
        for (let x = 0; x < sa.length; x++) {
          for (let y = 0; y < sb.length; y++) {
            const pt = properCross(sa[x], sb[y]);
            if (!pt) continue;
            const A = priorityOf.get(ea.id);
            const B = priorityOf.get(eb.id);
            // 高优先级 = 更长的那条（等长按 edge id 升序）—— 长线保持连续，短线断开
            let high = ea.id;
            let low = eb.id;
            if (B.len > A.len + EPS || (Math.abs(B.len - A.len) < EPS && byId(eb.id, ea.id) < 0)) { high = eb.id; low = ea.id; }
            // **曲线永远不做"被断开"的那一方**：断开一条贝塞尔要按参数切分（de Casteljau），
            // 而"作者显式声明了一条平滑弧线"这件事本身说明他不接受它被切成一截一截。
            // ⇒ 曲线参与交叉时优先当高优先级（画白描、保持连续），正交线让路。
            // ⚠️ 两条都是曲线时无路可让：只给更长的那条画白描，**不断开任何一方**，
            //    在读数里单列 `curveUncut`（`C-F3-18` 的判据对这类点只要求"高优先级侧有白描"）。
            const ca = curves.has(ea.id);
            const cb = curves.has(eb.id);
            let noCut = false;
            if (ca !== cb) { high = ca ? ea.id : eb.id; low = ca ? eb.id : ea.id; }
            else if (ca && cb) { noCut = true; }
            crossings.push({ x: pt.x, y: pt.y, high: high, low: low, expected: why !== 'interleave',
              why: why, edges: [ea.id, eb.id], curvePair: noCut });
          }
        }
        // T 型接触（一条线端点落在另一条线段内部）：单独计数，不混进 crossings
        sa.forEach((s1) => {
          sb.forEach((s2) => {
            [[s1[0], s2], [s1[1], s2]].forEach((pair) => {
              const p = pair[0];
              const s = pair[1];
              const h = isHorizontal(s);
              const v = isVertical(s);
              if (h && Math.abs(p[1] - s[0][1]) < EPS
                && p[0] > Math.min(s[0][0], s[1][0]) + EPS && p[0] < Math.max(s[0][0], s[1][0]) - EPS) {
                touches.push({ x: p[0], y: p[1], a: ea.id, b: eb.id });
              }
              if (v && Math.abs(p[0] - s[0][0]) < EPS
                && p[1] > Math.min(s[0][1], s[1][1]) + EPS && p[1] < Math.max(s[0][1], s[1][1]) - EPS) {
                touches.push({ x: p[0], y: p[1], a: ea.id, b: eb.id });
              }
            });
          });
        });
      }
    }
    // 去重（同一交点可能被多条线段对重复发现）
    const seenCross = new Set();
    const crossOut = [];
    crossings.forEach((c) => {
      const k = c.x.toFixed(3) + ',' + c.y.toFixed(3) + ',' + c.high + ',' + c.low;
      if (seenCross.has(k)) return;
      seenCross.add(k);
      crossOut.push(c);
    });
    crossOut.sort((a, b) => (a.x - b.x) || (a.y - b.y) || byId(a.low, b.low));
    result.crossings = crossOut;
    result.touches = touches;
    result.stats.crossings = crossOut.length;
    result.stats.expected = crossOut.filter((c) => c.expected).length;
    result.stats.unexpected = crossOut.length - result.stats.expected;
    result.stats.lanes = laneReport;
    result.stats.cost = { length: costSum.length, bends: costSum.bends, crossings: costSum.crossings, hugs: costSum.hugs };
    result.stats.repairRounds = repairRounds;
    // 曲线边的清单（判据要知道"这张图里哪些边是曲线"，别去猜 route 字符串）
    result.stats.curveEdges = Array.from(curves.keys()).sort(byId);

    /* ---- ④½ 容器框：不是障碍，但不许"沿着边框跑" ---- */
    if (Array.isArray(inp.frames) && inp.frames.length) {
      const byEdge = {};
      edges.forEach((e) => { const pts = polylines.get(e.id); if (pts) byEdge[e.id] = pts; });
      result.frameBorders = frameBorderRuns(byEdge, inp.frames);
      result.frameBorders.forEach((b) => {
        degraded.push('E_ROUTE_ON_BORDER: 边 ' + b.edge + ' 的第 ' + b.segIndex + ' 段沿着容器框 #' + b.frame
          + ' 的 ' + b.side + ' 边共线跑了 ' + b.overlap + 'px（重叠区间 ' + b.from + '…' + b.to + '）—— '
          + '容器是**背景框架**：连可以垂直穿过它、可以在顶点相触，但"贴着边框跑"会被读成"边框就是这条线"');
      });
    } else {
      result.frameBorders = [];
    }

    /* ---- ⑤ overpass：低优先级断开 4px，高优先级画白色描边（**逐点**） ---- */
    const cutsByEdge = new Map();
    let curveUncut = 0;
    crossOut.forEach((c) => {
      if (curves.has(c.low)) { curveUncut++; return; }        // 曲线不被断开（理由见上面那段）
      if (!cutsByEdge.has(c.low)) cutsByEdge.set(c.low, []);
      cutsByEdge.get(c.low).push(c);
    });
    result.stats.curveUncut = curveUncut;
    const halos = [];
    crossOut.forEach((c) => {
      const hp = polylines.get(c.high);
      if (!hp) return;
      const ext = GAP_HALF + 2;
      if (curves.has(c.high)) {
        // 曲线上的白描：取离交点最近的那个采样段，沿它的切向画一小段（不假装它是轴向的）
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i + 1 < hp.length; i++) {
          const d = distPointSeg([c.x, c.y], hp[i], hp[i + 1]);
          if (d < bestD - EPS) { bestD = d; best = i; }
        }
        if (best < 0) return;
        const a = hp[best];
        const b = hp[best + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < EPS) return;
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        halos.push({ edge: c.high, x1: c.x - ux * ext, y1: c.y - uy * ext,
          x2: c.x + ux * ext, y2: c.y + uy * ext, curve: true });
        return;
      }
      // 高优先级线在交点处的那一小段（沿它自己的线段方向各外扩 GAP_HALF + 2）
      const hs = segmentsOf(hp);
      for (let i = 0; i < hs.length; i++) {
        const seg = hs[i];
        const h = isHorizontal(seg);
        const v = isVertical(seg);
        if (!h && !v) continue;
        if (h) {
          if (Math.abs(seg[0][1] - c.y) > EPS) continue;
          const lo = Math.min(seg[0][0], seg[1][0]);
          const hi = Math.max(seg[0][0], seg[1][0]);
          if (c.x <= lo + EPS || c.x >= hi - EPS) continue;
        } else {
          if (Math.abs(seg[0][0] - c.x) > EPS) continue;
          const lo = Math.min(seg[0][1], seg[1][1]);
          const hi = Math.max(seg[0][1], seg[1][1]);
          if (c.y <= lo + EPS || c.y >= hi - EPS) continue;
        }
        halos.push(h
          ? { edge: c.high, x1: c.x - ext, y1: c.y, x2: c.x + ext, y2: c.y }
          : { edge: c.high, x1: c.x, y1: c.y - ext, x2: c.x, y2: c.y + ext });
        break;
      }
    });
    result.halos = halos;

    // 把中间折线换成"被断开之后"的若干段（每段是 [[x,y],[x,y]]）
    edges.forEach((e) => {
      const pts = polylines.get(e.id);
      if (curves.has(e.id)) {
        // 曲线：**不切段**（画的是 `C` 命令；切段要按参数 de Casteljau，那是另一件事）
        result.edges[e.id].runs = [];
        result.edges[e.id].cuts = 0;
        return;
      }
      const cuts = cutsByEdge.get(e.id) || [];
      const runs = cutPolyline(pts, cuts);
      result.edges[e.id].runs = runs;
      result.edges[e.id].cuts = cuts.length;
    });

    /* ---- ⑥ 标签避让（候选位打分 + 矩形碰撞） ---- */
    const labelBoxes = [];
    edges.forEach((e) => {
      const text = typeof e.label === 'string' ? e.label : '';
      if (!text) return;
      const pts = polylines.get(e.id);
      if (!pts || pts.length < 2) return;
      const placed = placeLabel(e.id, text, pts, {
        measurer: measurer, nodes: rects, segs: (function () {
          const all = [];
          edges.forEach((x) => {
            const px = polylines.get(x.id);
            if (!px) return;
            segmentsOf(px).forEach((s) => all.push({ edge: x.id, seg: s }));
          });
          return all;
        })(),
        placed: labelBoxes
      });
      if (!placed) {
        throw new MMDiagramError('E_LABEL_NO_ROOM',
          '边 ' + e.id + ' 的标签「' + text + '」找不到**既不压框也不压线**的位置（试了 '
          + 'N 个候选位：沿线中点/两端/上下偏移/逐级外推）—— 本内核不把标签叠在框上或线上：'
          + '可以加宽节点间距（`graph.gap.node`）、缩短标签文字，或把这条边拆开',
          { object: { edge: e.id, label: text }, fixes: ['增大 graph.gap.node', '缩短标签', '拆分边'] });
      }
      result.edges[e.id].label = { x: placed.x, y: placed.y, w: placed.w, h: placed.h, anchor: 'middle' };
      labelBoxes.push({ edge: e.id, rect: placed.rect });
    });
    result.labels = labelBoxes;
    return result;
  }

  /* ==================================================================
   * 五½、直连边的 overpass（`C-F3-18` 的"手写坐标"那一档）
   * ------------------------------------------------------------------
   * 为什么单独一个函数、而不是让 `routeAll` 顺手做：`routeAll` 是"自动布局之后布线"，
   * 它同时管端口展开 / A* / 通道 / 标签；而**手写坐标**那一档（MS1 入口）根本没有这些步骤，
   * 它只有"一条线段"。硬塞进 `routeAll` 会让 MS1 的产物跟着变（逐字节基线就跑了）。
   *
   * 本函数**只做三件事**：数交叉（任意方向，斜线也算）、按优先级断线、给高优先级线出白描。
   * 它不碰任何坐标、不改任何边 —— 除了"把一条线段切成两段（中间留 4px）"。
   * ================================================================== */

  /** 一条折线的长度（优先级排序用：与 `routeAll` 里同一个口径 —— **长的当高优先级**） */
  function polylineLength(points) {
    let len = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      len += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    }
    return len;
  }

  /**
   * 直连边的 overpass。
   *
   * @param {Array<{id:string, points:Array<[number,number]>}>} geoms 边的折线（直连 ⇒ 每条只有一段）
   * @returns {{crossings:Array, halos:Array, runs:Object<string,Array>, edgesCut:string[], cost:object}}
   */
  function overpassOf(geoms) {
    const list = (geoms || []).filter((g) => g && typeof g.id === 'string'
      && Array.isArray(g.points) && g.points.length >= 2);
    const geomById = new Map();
    list.forEach((g) => geomById.set(g.id, g));
    const lenOf = (id) => polylineLength(geomById.get(id).points);

    const segs = [];
    list.slice().sort((a, b) => byId(a.id, b.id)).forEach((g) => {
      segmentsOf(g.points).forEach((s, i) => segs.push({ edge: g.id, i: i, seg: s }));
    });

    const found = [];
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].edge === segs[j].edge) continue;
        const pt = properCross(segs[i].seg, segs[j].seg);
        if (!pt) continue;
        const ea = segs[i].edge;
        const eb = segs[j].edge;
        // 优先级：**长的当高优先级**（与 `routeAll` 同一条规则：长线连续、短线断开）
        let high = ea;
        let low = eb;
        const la = lenOf(ea);
        const lb = lenOf(eb);
        if (lb > la + EPS || (Math.abs(lb - la) < EPS && byId(eb, ea) < 0)) { high = eb; low = ea; }
        found.push({ x: pt.x, y: pt.y, high: high, low: low, edges: [ea, eb],
          highSeg: high === ea ? segs[i] : segs[j] });
      }
    }
    // 去重（同一交点可能被同一对边发现多次）
    const seen = new Set();
    const crossings = found.filter((c) => {
      const k = c.x.toFixed(6) + ',' + c.y.toFixed(6) + ',' + c.high + ',' + c.low;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => (a.x - b.x) || (a.y - b.y) || byId(a.low, b.low));

    /* 白描：在高优先级线的**自己的方向**上取 ±(GAP_HALF+2) —— 斜线也要对（不许只画轴向的） */
    const halos = [];
    crossings.forEach((c) => {
      const seg = c.highSeg.seg;
      const dx = seg[1][0] - seg[0][0];
      const dy = seg[1][1] - seg[0][1];
      const len = Math.hypot(dx, dy);
      if (len < EPS) return;
      const ux = dx / len;
      const uy = dy / len;
      const ext = GAP_HALF + 2;
      halos.push({ edge: c.high, x1: c.x - ux * ext, y1: c.y - uy * ext,
        x2: c.x + ux * ext, y2: c.y + uy * ext });
    });

    /* 断开：低优先级线在交点两侧各退 GAP_HALF（**沿它自己的方向退**，所以斜线也对） */
    const cutsByEdge = new Map();
    crossings.forEach((c) => {
      if (!cutsByEdge.has(c.low)) cutsByEdge.set(c.low, []);
      cutsByEdge.get(c.low).push(c);
    });
    const runs = {};
    const edgesCut = [];
    list.forEach((g) => {
      const cuts = cutsByEdge.get(g.id) || [];
      if (cuts.length) edgesCut.push(g.id);
      runs[g.id] = cutPolylineGeneric(g.points, cuts);
    });
    edgesCut.sort(byId);

    return {
      crossings: crossings, halos: halos, runs: runs, edgesCut: edgesCut,
      cost: { crossings: crossings.length, overpasses: halos.length, cuts: crossings.length }
    };
  }

  /**
   * 任意方向折线的断开（斜线也算）。
   * 与 `cutPolyline` 的分工：那个只处理轴向段（正交布线的产物全是轴向）；
   * 直连边的段可能是斜的 ⇒ 按**参数投影**在段上找交点，退 `half` 像素留下缺口。
   */
  function cutPolylineGeneric(points, cuts) {
    if (!points || points.length < 2) return [];
    const out = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < EPS) continue;
      const ux = dx / len;
      const uy = dy / len;
      // 落在本段上的交点（参数 t ∈ (0,1)），按 t 排序
      const ts = [];
      cuts.forEach((c) => {
        const t = ((c.x - a[0]) * ux + (c.y - a[1]) * uy) / len;
        if (t <= EPS || t >= 1 - EPS) return;
        const px = a[0] + dx * t;
        const py = a[1] + dy * t;
        if (Math.hypot(px - c.x, py - c.y) > 1e-6) return;      // 这交点不在本段上（在延长线上）
        ts.push(t);
      });
      if (!ts.length) { out.push([[a[0], a[1]], [b[0], b[1]]]); continue; }
      ts.sort((p, q) => p - q);
      let cursor = 0;                                            // 参数 0 = a
      const at = (t) => [a[0] + dx * t, a[1] + dy * t];
      ts.forEach((t) => {
        const gap = GAP_HALF / len;                              // 4px 缺口的一半，换算成参数
        const end = t - gap;
        if (end - cursor > EPS) out.push([at(cursor), at(end)]);
        cursor = t + gap;
      });
      if (1 - cursor > EPS) out.push([at(cursor), at(1)]);
    }
    return out;
  }

  /* ==================================================================
   * 五¾、容器框的语义（`C-F2-01` 的"框"那半）
   * ------------------------------------------------------------------
   * **定案：容器是"框架"，不是"障碍"。** 理由（三条，任一条成立就够了）：
   *   ① 容器的用途是**框住一组节点**；组内节点与组外节点之间必然有连线，那条线**必须**穿框
   *      ⇒ 把容器当障碍 = 这类边永远无解（或被迫绕一个巨大的外圈，读起来像"没有关系"）。
   *   ② 分层布局已经把节点排成"层"，容器框与层带在几何上是**背景**（z-order 里也在节点之下）
   *      ⇒ 让背景参与避障，等于让"画框"改变"图画"：框一改，整张图重排。
   *   ③ 外部证据（archify 的 Clear Container Corridor）：权威口径是"连线可以**垂直穿过**框架、
   *      可以在顶点相触，但**不许沿着边框共线跑**" —— 前两条放开、第三条禁止，正好是"框架"的语义。
   * ⇒ 所以本内核：**容器不参与避障**（`blocked` 里只有节点矩形），但**沿着边框跑**要被点名。
   *    "沿边框跑"的判据：线与某条边框**共线**且**投影重叠 > 1px**（只碰一个点不算，垂直穿过不算）。
   * ================================================================== */

  /** "沿边框跑"的最小重叠长度：>1px 才算跑（只擦一下、只碰顶点都不算 —— 判据是"跑"，不是"擦"）
   *  1px 这个数不是随手取的：它是本工程几何判据里最小的可辨量（`C-F1-01` 的 ±0.5px 是半个）。 */
  const MIN_BORDER_RUN = 1;

  /** 一条线段是否沿着某个矩形框的某条边"共线跑"（返回重叠长度；null = 没有） */
  function borderOverlap(seg, frame) {
    const h = isHorizontal(seg);
    const v = isVertical(seg);
    const sides = [
      { side: 'top', y: frame.y, x0: frame.x, x1: frame.x + frame.w, horizontal: true },
      { side: 'bottom', y: frame.y + frame.h, x0: frame.x, x1: frame.x + frame.w, horizontal: true },
      { side: 'left', x: frame.x, y0: frame.y, y1: frame.y + frame.h, horizontal: false },
      { side: 'right', x: frame.x + frame.w, y0: frame.y, y1: frame.y + frame.h, horizontal: false }
    ];
    for (let i = 0; i < sides.length; i++) {
      const s = sides[i];
      if (s.horizontal) {
        if (!h || Math.abs(seg[0][1] - s.y) > EPS) continue;
        const lo = Math.max(Math.min(seg[0][0], seg[1][0]), s.x0);
        const hi = Math.min(Math.max(seg[0][0], seg[1][0]), s.x1);
        if (hi - lo > MIN_BORDER_RUN) return { side: s.side, overlap: hi - lo, from: lo, to: hi };
      } else {
        if (!v || Math.abs(seg[0][0] - s.x) > EPS) continue;
        const lo = Math.max(Math.min(seg[0][1], seg[1][1]), s.y0);
        const hi = Math.min(Math.max(seg[0][1], seg[1][1]), s.y1);
        if (hi - lo > MIN_BORDER_RUN) return { side: s.side, overlap: hi - lo, from: lo, to: hi };
      }
    }
    return null;
  }

  /**
   * 逐边 × 逐框架：找出"沿着边框共线跑"的段。
   * @param {Object<string, Array<[number,number]>>} polylinesById
   * @param {Array<{x:number,y:number,w:number,h:number}>} frames
   * @returns {Array<{edge:string, frame:number, side:string, overlap:number, from:number, to:number}>}
   */
  function frameBorderRuns(polylinesById, frames) {
    const out = [];
    const ids = Object.keys(polylinesById || {}).sort(byId);
    ids.forEach((id) => {
      const pts = polylinesById[id];
      if (!Array.isArray(pts) || pts.length < 2) return;
      segmentsOf(pts).forEach((seg, si) => {
        (frames || []).forEach((f, fi) => {
          const hit = borderOverlap(seg, f);
          if (!hit) return;
          out.push({ edge: id, segIndex: si, frame: fi, side: hit.side,
            overlap: hit.overlap, from: hit.from, to: hit.to });
        });
      });
    });
    out.sort((a, b) => byId(a.edge, b.edge) || (a.frame - b.frame) || byId(a.side, b.side));
    return out;
  }

  /** 按交叉点把折线切成若干段（低优先级线在交点两侧各留 GAP_HALF 的缺口 ⇒ 缺口合计 4px） */
  function cutPolyline(points, cuts) {
    if (!points || points.length < 2) return [];
    const segs = segmentsOf(points);
    const out = [];
    segs.forEach((seg) => {
      const h = isHorizontal(seg);
      const v = isVertical(seg);
      if (!h && !v) { out.push([seg[0].slice(), seg[1].slice()]); return; }
      const lo = h ? Math.min(seg[0][0], seg[1][0]) : Math.min(seg[0][1], seg[1][1]);
      const hi = h ? Math.max(seg[0][0], seg[1][0]) : Math.max(seg[0][1], seg[1][1]);
      const fixed = h ? seg[0][1] : seg[0][0];
      const marks = [];
      cuts.forEach((c) => {
        const at = h ? c.x : c.y;
        const other = h ? c.y : c.x;
        if (Math.abs(other - fixed) > EPS) return;
        if (at <= lo + EPS || at >= hi - EPS) return;
        marks.push(at);
      });
      if (!marks.length) { out.push([seg[0].slice(), seg[1].slice()]); return; }
      marks.sort((a, b) => a - b);
      const mk = (a, b2) => (h ? [[a, fixed], [b2, fixed]] : [[fixed, a], [fixed, b2]]);
      let cursor = lo;
      marks.forEach((m) => {
        const end = m - GAP_HALF;
        if (end - cursor > EPS) out.push(mk(cursor, end));
        cursor = m + GAP_HALF;
      });
      if (hi - cursor > EPS) out.push(mk(cursor, hi));
    });
    return out;
  }

  /* ==================================================================
   * 五、标签候选位与打分（`C-F3-14` / `C-F3-15` + "到其他路径的净空"）
   * ================================================================== */

  function rectsHit(a, b) {
    return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
  }

  /** 点到线段的距离（任向；曲线的白描取"离交点最近的采样段"靠它） */
  function distPointSeg(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  /** 标签矩形到一条线段的**最短距离**（净空判据用；轴对齐线段有闭式解） */
  function distToSeg(rect, seg) {
    const h = isHorizontal(seg);
    const v = isVertical(seg);
    if (h || v) {
      const fixed = h ? seg[0][1] : seg[0][0];
      const lo = h ? Math.min(seg[0][0], seg[1][0]) : Math.min(seg[0][1], seg[1][1]);
      const hi = h ? Math.max(seg[0][0], seg[1][0]) : Math.max(seg[0][1], seg[1][1]);
      // 矩形在固定轴上的投影与线段坐标的差
      const boxLo = h ? rect.y : rect.x;
      const boxHi = h ? rect.y + rect.h : rect.x + rect.w;
      let d = 0;
      if (fixed < boxLo) d = boxLo - fixed;
      else if (fixed > boxHi) d = fixed - boxHi;
      // 再算沿线段方向的重叠（不重叠时要算拐角距离）
      const oLo = h ? rect.x : rect.y;
      const oHi = h ? rect.x + rect.w : rect.y + rect.h;
      if (hi < oLo) return Math.hypot(d, oLo - hi);
      if (lo > oHi) return Math.hypot(d, lo - oHi);
      return d;
    }
    return 0;
  }

  /**
   * 给一条边挑标签位置。
   *
   * 打分是**分档**的（不是"一个分数里加加减减"）：因为判据 7 的要求是"零压框、零压线"，
   * 那是**硬约束**，不能靠"权重够大"来近似 —— 权重一大，某些输入下仍然会被别的小项翻盘。
   *   档 0：不压框 + 不压任何线 + 到别的路径的净空 ≥ `LABEL_PATH_CLEARANCE` + 到自己的线 ≥ `LABEL_CLEARANCE`
   *   档 1：不压框 + 不压任何线（到自己的线贴得可以更近）
   *   档 2：不压框 + 只与"别的路径"保持不重叠（净空不足）
   *   档 3：兜底（仍要求不压框；否则调用方报 `E_LABEL_NO_ROOM`）
   * 取"第一个有候选的档"里的最小代价；同分按候选生成序（确定性）。
   *
   * @returns {{x:number, y:number, w:number, h:number, rect:object, tier:number}|null}
   */
  function placeLabel(edgeId, text, points, ctx) {
    const measurer = ctx.measurer;
    const w = measurer ? measurer.widthOf(text, LABEL_FONT_SIZE, tokens.FONT.family) : text.length * LABEL_FONT_SIZE;
    const h = LABEL_HEIGHT;
    const segs = segmentsOf(points);
    const otherSegs = (ctx.segs || []).filter((s) => s.edge !== edgeId);
    const candidates = [];
    segs.forEach((seg, si) => {
      const horizontal = isHorizontal(seg);
      const len = horizontal ? Math.abs(seg[1][0] - seg[0][0]) : Math.abs(seg[1][1] - seg[0][1]);
      if (len < 12) return;
      [0.5, 0.32, 0.68].forEach((t) => {
        const px = seg[0][0] + (seg[1][0] - seg[0][0]) * t;
        const py = seg[0][1] + (seg[1][1] - seg[0][1]) * t;
        [1, -1].forEach((side) => {
          [0, 8, 16, 26, 38, 52].forEach((extra) => {
            const off = LABEL_CLEARANCE + h / 2 + extra;
            candidates.push(horizontal
              ? { x: px, y: py - side * off, dist: extra }
              : { x: px + side * off, y: py, dist: extra + 40 });   // 竖线上的标签天然难读 ⇒ 加权
          });
        });
      });
    });
    if (!candidates.length) return null;

    const tiers = [0, 1, 2, 3];
    let fallback = null;
    for (let ti = 0; ti < tiers.length; ti++) {
      const tier = tiers[ti];
      let best = null;
      candidates.forEach((cand, ci) => {
        const rect = { x: cand.x - w / 2, y: cand.y - h / 2, w: w, h: h };
        // 压框 ⇒ **任何档都不接受**（判据 7 的第一条）
        for (let i = 0; i < ctx.nodes.length; i++) {
          if (rectsHit(rect, ctx.nodes[i])) return;
        }
        let ownMin = Infinity;
        segs.forEach((s) => { ownMin = Math.min(ownMin, distToSeg(rect, s)); });
        let otherMin = Infinity;
        otherSegs.forEach((s) => { otherMin = Math.min(otherMin, distToSeg(rect, s.seg)); });
        let hitLabel = false;
        (ctx.placed || []).forEach((p) => { if (rectsHit(rect, p.rect)) hitLabel = true; });

        const passes = (function () {
          if (tier === 0) return ownMin >= LABEL_CLEARANCE && otherMin >= LABEL_PATH_CLEARANCE && !hitLabel;
          if (tier === 1) return ownMin >= 1 && otherMin >= 1 && !hitLabel;
          if (tier === 2) return otherMin >= 1 && !hitLabel;
          return !hitLabel;
        })();
        if (!passes) return;

        let score = cand.dist;
        score += (Number.isFinite(otherMin) ? Math.max(0, LABEL_PATH_CLEARANCE - otherMin) : 0) * 20;
        score += ci * 0.001;                                        // 同分按候选序定序（确定性）
        if (!best || score < best.score) best = { x: cand.x, y: cand.y, w: w, h: h, rect: rect, score: score, tier: tier };
      });
      if (best) return best;
    }
    return fallback;
  }

  /* ==================================================================
   * 六、交叉的**独立复算**（判据自己另写一份，不共用这里的变量；这里只给内部自检用）
   * ================================================================== */

  /** 从"折线表"数交叉（判据在测试里另写一份：两条路不许共用同一个变量） */
  function countCrossings(polylines) {
    const ids = Object.keys(polylines).sort(byId);
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const sa = segmentsOf(polylines[ids[i]]);
        const sb = segmentsOf(polylines[ids[j]]);
        sa.forEach((a) => { sb.forEach((b) => { if (properCross(a, b)) n++; }); });
      }
    }
    return n;
  }

  return {
    routeAll: routeAll,
    portPoint: portPoint,
    autoPorts: autoPorts,
    arrowPolygon: arrowPolygon,
    curveControl: curveControl,
    flattenCubic: flattenCubic,
    cubicAt: cubicAt,
    SIDE_NORMAL: SIDE_NORMAL,
    distPointSeg: distPointSeg,
    simplify: simplify,
    segmentsOf: segmentsOf,
    properCross: properCross,
    parallelOverlap: parallelOverlap,
    cutPolyline: cutPolyline,
    cutPolylineGeneric: cutPolylineGeneric,
    overpassOf: overpassOf,
    polylineLength: polylineLength,
    borderOverlap: borderOverlap,
    frameBorderRuns: frameBorderRuns,
    placeLabel: placeLabel,
    countCrossings: countCrossings,
    emptyBands: emptyBands,
    distToSeg: distToSeg,
    MinHeap: MinHeap,
    DIRS: DIRS
  };
});
