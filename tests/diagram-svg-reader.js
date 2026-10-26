/* ============================================================
 * tests/diagram-svg-reader.js —— 从**SVG 字符串**里读几何（判据的独立读数口）
 * ------------------------------------------------------------
 * 为什么判据要自己从 SVG 里读一遍，而不直接看 `report`：
 *   `report` 是**被测对象自己写的**。判据若只读它，"自证"就成立了
 *   （本批最容易做假的地方就是判据 3：用布局器自己的中间数当"独立数"）。
 *   所以这里的规矩是：**几何一律从产出的字符串重新解析**，只用 `report` 做"两边比一比"。
 *
 * 本文件**刻意不 require `src/diagram/route.js`**（不共用任何几何函数）：
 *   交叉数、穿框、间距都由本文件的实现重算 —— 与实现共用函数就等于没验。
 * ============================================================ */

const EPS = 1e-6;

/** 数字属性 */
export function num(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="(-?[0-9.]+)"'));
  return m ? Number(m[1]) : NaN;
}

/** 取 `<g data-node=...>`：`{id, shape, x, y, w, h}` */
export function readNodes(svg) {
  const out = [];
  const re = /<g data-node="([^"]+)" data-shape="([^"]+)" data-x="(-?[0-9.]+)" data-y="(-?[0-9.]+)" data-w="(-?[0-9.]+)" data-h="(-?[0-9.]+)">/g;
  let m;
  while ((m = re.exec(svg))) {
    out.push({ id: m[1], shape: m[2], rect: { x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: Number(m[6]) } });
  }
  return out;
}

/** 取每条**布线边**的分组：`{id, points, from, to, cuts, route, fromPort, toPort, tag}` */
export function readEdges(svg) {
  const out = [];
  const re = /<g data-edge="([^"]+)" data-route="([^"]*)" data-from="([^"]*)" data-to="([^"]*)" data-from-port="([^"]*)" data-to-port="([^"]*)" data-points="([^"]*)" data-cuts="([^"]*)">/g;
  let m;
  while ((m = re.exec(svg))) {
    out.push({
      id: m[1], route: m[2], from: m[3], to: m[4], fromPort: m[5], toPort: m[6],
      points: parsePoints(m[7]), cuts: Number(m[8]), tag: m[0]
    });
  }
  return out;
}

/** `"x,y x,y"` → `[[x,y], ...]` */
export function parsePoints(s) {
  if (!s) return [];
  return s.trim().split(/\s+/).map((p) => p.split(',').map(Number));
}

/** 取所有**画出来的**线段（`data-seg`）：`[{edge, seg, a:[x,y], b:[x,y]}]` */
export function readSegments(svg) {
  const out = [];
  const re = /<line data-edge="([^"]+)" data-seg="([0-9]+)" x1="(-?[0-9.]+)" y1="(-?[0-9.]+)" x2="(-?[0-9.]+)" y2="(-?[0-9.]+)"/g;
  let m;
  while ((m = re.exec(svg))) {
    out.push({ edge: m[1], seg: Number(m[2]), a: [Number(m[3]), Number(m[4])], b: [Number(m[5]), Number(m[6])] });
  }
  return out;
}

/** 取所有 overpass 白描：`[{edge, a, b}]` */
export function readHalos(svg) {
  const out = [];
  const re = /<line data-halo="1" data-edge="([^"]+)" x1="(-?[0-9.]+)" y1="(-?[0-9.]+)" x2="(-?[0-9.]+)" y2="(-?[0-9.]+)" stroke="#ffffff" stroke-width="([0-9.]+)"/g;
  let m;
  while ((m = re.exec(svg))) {
    out.push({ edge: m[1], a: [Number(m[2]), Number(m[3])], b: [Number(m[4]), Number(m[5])], width: Number(m[6]) });
  }
  return out;
}

/** 取边标签：`{edge, box:{x,y,w,h}, x, y, text}` */
export function readEdgeLabels(svg) {
  const out = [];
  const re = /<text class="mm-edge-label"[^>]*data-edge="([^"]+)" data-box="(-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+)"[^>]*>([^<]*)<\/text>/g;
  let m;
  while ((m = re.exec(svg))) {
    out.push({
      edge: m[1],
      box: { x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) },
      text: m[6]
    });
  }
  return out;
}

/** 节点的三段文本行（`data-text="title|subtitle|badge"`，含多行）：`[{node, kind, line, size, text, x, y}]` */
export function readNodeTextLines(svg) {
  const out = [];
  (svg.match(/<g data-node="[^"]+"[^>]*>[\s\S]*?<\/g>/g) || []).forEach((group) => {
    const id = group.match(/<g data-node="([^"]+)"/)[1];
    const re = /<text class="mm-node-(title|subtitle|badge)" x="(-?[0-9.]+)" y="(-?[0-9.]+)"[^>]*font-size="([0-9.]+)"[^>]*data-text="(title|subtitle|badge)" data-font-size="[0-9.]+"(?: data-line="([0-9]+)\/([0-9]+)")?[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(group))) {
      out.push({
        node: id, kind: m[1], x: Number(m[2]), y: Number(m[3]), size: Number(m[4]),
        line: m[6] === undefined ? 0 : Number(m[6]),
        lines: m[7] === undefined ? 1 : Number(m[7]),
        text: m[8]
      });
    }
  });
  return out;
}

/* ---------------- 几何（独立实现：不 require 被测模块） ---------------- */

/** 折线 → 线段 */
export function segmentsOf(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i], points[i + 1]]);
  return out;
}

/** 两条线段的**内部-内部**交点（端点相碰不算） */
export function interiorCross(a, b) {
  const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cr(b[0], b[1], a[0]);
  const d2 = cr(b[0], b[1], a[1]);
  const d3 = cr(a[0], a[1], b[0]);
  const d4 = cr(a[0], a[1], b[1]);
  const opp = (x, y) => (x > EPS && y < -EPS) || (x < -EPS && y > EPS);
  if (!opp(d1, d2) || !opp(d3, d4)) return null;
  const t = d1 / (d1 - d2);
  return {
    x: a[0][0] + (a[1][0] - a[0][0]) * t,
    y: a[0][1] + (a[1][1] - a[0][1]) * t
  };
}

/** 线段是否穿进矩形的**内部**（边界接触不算；判据 1 的口径就是"零相交"里的"穿"） */
export function segEntersRect(seg, rect) {
  const x1 = Math.min(seg[0][0], seg[1][0]);
  const x2 = Math.max(seg[0][0], seg[1][0]);
  const y1 = Math.min(seg[0][1], seg[1][1]);
  const y2 = Math.max(seg[0][1], seg[1][1]);
  const rx1 = rect.x;
  const rx2 = rect.x + rect.w;
  const ry1 = rect.y;
  const ry2 = rect.y + rect.h;
  // 轴对齐与斜线分开：斜线用"两端点是否在矩形同侧 + 与四条边是否相交"判
  const horizontal = Math.abs(seg[0][1] - seg[1][1]) < EPS;
  const vertical = Math.abs(seg[0][0] - seg[1][0]) < EPS;
  if (horizontal) {
    if (y1 <= ry1 + EPS || y1 >= ry2 - EPS) return false;       // 与矩形上下边齐平/在外 ⇒ 不进内部
    return x1 < rx2 - EPS && x2 > rx1 + EPS;                    // 横向跨度与矩形横向内部有交
  }
  if (vertical) {
    if (x1 <= rx1 + EPS || x1 >= rx2 - EPS) return false;
    return y1 < ry2 - EPS && y2 > ry1 + EPS;
  }
  // 斜线：与矩形四边的四条线段求内部交点，任一条有 ⇒ 穿
  const sides = [
    [[rx1, ry1], [rx2, ry1]], [[rx2, ry1], [rx2, ry2]],
    [[rx2, ry2], [rx1, ry2]], [[rx1, ry2], [rx1, ry1]]
  ];
  let inside = false;
  if (seg[0][0] > rx1 && seg[0][0] < rx2 && seg[0][1] > ry1 && seg[0][1] < ry2) inside = true;
  if (seg[1][0] > rx1 && seg[1][0] < rx2 && seg[1][1] > ry1 && seg[1][1] < ry2) inside = true;
  if (inside) return true;
  return sides.some((s) => interiorCross(seg, s) !== null);
}

/** 两个矩形是否相交（严格内部有重叠） */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS
    && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** 点到线段的最短距离（轴对齐闭式解 + 斜线投影） */
export function distPointSeg(p, seg) {
  const [ax, ay] = seg[0];
  const [bx, by] = seg[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return Math.hypot(p[0] - ax, p[1] - ay);
  let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
}

/** 矩形到线段的最短距离（四个角点 + 线段两端点到矩形，取最小 —— 判断"净空"够用） */
export function distRectSeg(rect, seg) {
  const corners = [
    [rect.x, rect.y], [rect.x + rect.w, rect.y],
    [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]
  ];
  if (rectsOverlap(rect, { x: Math.min(seg[0][0], seg[1][0]), y: Math.min(seg[0][1], seg[1][1]),
    w: Math.abs(seg[1][0] - seg[0][0]), h: Math.abs(seg[1][1] - seg[0][1]) })) return 0;
  let d = Infinity;
  corners.forEach((c) => { d = Math.min(d, distPointSeg(c, seg)); });
  // 线段端点在矩形"边上/内部"也算 0
  [seg[0], seg[1]].forEach((p) => {
    if (p[0] >= rect.x - EPS && p[0] <= rect.x + rect.w + EPS
      && p[1] >= rect.y - EPS && p[1] <= rect.y + rect.h + EPS) d = 0;
  });
  return d;
}

export { EPS };
