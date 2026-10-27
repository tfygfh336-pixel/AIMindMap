/* ============================================================
 * tests/diagram-curve.test.js —— **`C-F3-05` 路由 curve**
 * ------------------------------------------------------------
 * 为什么 curve 要单独一个文件：它的判据不是"画了一条像曲线的线"，而是
 * **控制点能由两端端口法向**逐值复算出来（无随机、无拟合）。所以本文件的中心是
 * `recountCurve()`：它只吃 SVG 里的 `data-c1 / data-c2 / data-curve-k / data-from-port /
 * data-to-port / data-points`，**不 require** `src/diagram/route.js` 的任何几何函数 ——
 * 实现与判据不共用一份算式，才叫复算（判据 1 的"独立 recount"同一个口径）。
 *
 * 判据（每条都单独可红）：
 *   ① 控制点 = p0 + normal(fromPort)·k、p3 + normal(toPort)·k（逐值，容差见 `TOL`：产物 3 位小数的量级）
 *   ② k = max(CURVE_MIN_K, |p3 − p0| / CURVE_K_DIV)（k 不许是"随手一个数"）
 *   ③ 画出来的是 `C` 命令（矢量），**不是**采样折线，也不是直线
 *   ④ 两跑逐字节相同（隔 5ms —— 同毫秒两次跑测不出"加时间戳"这种坏法）
 *   ⑤ 采样折线的首尾 == 端口坐标（曲线真的从端口出、回到端口）
 *   ⑥ 曲线**不被断开**（`data-cuts=0`）：断开贝塞尔要按参数切分，那是另一件事，
 *      所以曲线的 overpass 语义是"它当高优先级、正交线让路"，读数里 `curveUncut` 原值报出
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { autoDoc, autoMinimal } from './diagram-auto-fixture.js';

// 产物把数字归一成 **3 位小数**（`render-svg.js` 的 `fmt`）⇒ 从 SVG 复算的一致性是 1e-3 量级。
// 想要更严只能改 `fmt`，那会动 MS1 的逐字节基线 —— 所以容差取 2e-3 并在判据里写明来源。
const TOL = 2e-3;

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

/** 端口外法向（判据自己写一份，不 require 实现里的 `SIDE_NORMAL`） */
const NORMAL = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** 从 SVG 里把曲线边的属性读出来（不依赖 `diagram-svg-reader.js` 之外的任何实现） */
function readCurves(svg) {
  const out = [];
  const re = /<g data-edge="([^"]+)" data-route="curve"[^>]*data-from-port="([^"]*)" data-to-port="([^"]*)" data-points="([^"]*)" data-c1="([^"]+)" data-c2="([^"]+)" data-curve-k="([^"]+)" data-curve-samples="([^"]+)" data-cuts="([^"]*)">/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const pts = m[4].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    out.push({
      id: m[1], fromPort: m[2], toPort: m[3], points: pts,
      c1: m[5].split(',').map(Number), c2: m[6].split(',').map(Number),
      k: Number(m[7]), samples: Number(m[8]), cuts: Number(m[9])
    });
  }
  return out;
}

/** **独立复算**：由两端端口与法向重算控制点与 k */
function recountCurve(c) {
  const p0 = c.points[0];
  const p3 = c.points[c.points.length - 1];
  const k = Math.max(D.CURVE_MIN_K, Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / D.CURVE_K_DIV);
  const n0 = NORMAL[c.fromPort];
  const n3 = NORMAL[c.toPort];
  return {
    k: k,
    c1: [p0[0] + n0[0] * k, p0[1] + n0[1] * k],
    c2: [p3[0] + n3[0] * k, p3[1] + n3[1] * k]
  };
}

/** 三条边的图：一条曲线 + 两条正交（曲线要能跟正交边共存，且不与它们抢通道） */
function curveDoc() {
  const doc = autoDoc();
  doc.graph.edges.forEach((e) => { if (e.id === 'e2' || e.id === 'e9') e.route = 'curve'; });
  return doc;
}

describe('C-F3-05 路由 curve：控制点可复算（无随机）', () => {
  it('① + ② 逐条曲线：控制点与 k 与独立复算**逐值相同**', () => {
    const { svg, report } = D.renderAuto(curveDoc());
    const curves = readCurves(svg);
    expect(curves.length, '这张图没有曲线边 ⇒ 判据空转').toBe(2);
    expect(report.routing.curveEdges).toEqual(curves.map((c) => c.id).sort());
    curves.forEach((c) => {
      const mine = recountCurve(c);
      expect(Math.abs(c.k - mine.k), c.id + '.k').toBeLessThanOrEqual(TOL);
      expect(Math.abs(c.c1[0] - mine.c1[0]), c.id + '.c1.x').toBeLessThanOrEqual(TOL);
      expect(Math.abs(c.c1[1] - mine.c1[1]), c.id + '.c1.y').toBeLessThanOrEqual(TOL);
      expect(Math.abs(c.c2[0] - mine.c2[0]), c.id + '.c2.x').toBeLessThanOrEqual(TOL);
      expect(Math.abs(c.c2[1] - mine.c2[1]), c.id + '.c2.y').toBeLessThanOrEqual(TOL);
    });
  });

  it('② `k` 的下界真的被用上（短边上 k = CURVE_MIN_K，不是 |p3−p0|/3）', () => {
    // 两个节点靠得很近：距离 < 3 × CURVE_MIN_K ⇒ k 必须落在下界上
    const doc = autoMinimal({ edges: [{ id: 'e1', from: { node: 'a', port: 'e' }, to: { node: 'b', port: 'w' }, route: 'curve' }] });
    const { svg } = D.renderAuto(doc);
    const curves = readCurves(svg);
    expect(curves.length).toBe(1);
    const p0 = curves[0].points[0];
    const p3 = curves[0].points[curves[0].points.length - 1];
    const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    if (dist / D.CURVE_K_DIV < D.CURVE_MIN_K) expect(curves[0].k).toBe(D.CURVE_MIN_K);
    else expect(curves[0].k).toBeCloseTo(dist / D.CURVE_K_DIV, 6);
  });

  it('③ 画出来是 `C` 命令（矢量），不是采样折线、也不是直线', () => {
    const { svg } = D.renderAuto(curveDoc());
    const path = svg.match(/<path data-curve="1" data-edge="e2" d="([^"]+)"/);
    expect(path, '曲线边没有画成 path').toBeTruthy();
    expect(path[1]).toMatch(/^M [-\d.]+ [-\d.]+ C /);
    const lines = svg.match(/<line[^>]*data-edge="e2"/g) || [];
    expect(lines.length, '曲线边还在用 <line> 画（退化成折线了）').toBe(0);
  });

  it('④ 两跑逐字节相同（**隔 5ms**：同毫秒两次跑抓不到"带时间戳"这种坏法）', async () => {
    const a = D.renderAuto(curveDoc());
    await new Promise((r) => setTimeout(r, 5));
    const b = D.renderAuto(curveDoc());
    expect(sha256(a.svg)).toBe(sha256(b.svg));
    expect(a.svg).toContain('data-curve="1"');
    expect(JSON.stringify(a.report.routing.curveControlPoints))
      .toBe(JSON.stringify(b.report.routing.curveControlPoints));
  });

  it('⑤ 采样折线首尾 == 端口坐标，且采样数 = `CURVE_SAMPLES + 1`', () => {
    const { svg } = D.renderAuto(curveDoc());
    readCurves(svg).forEach((c) => {
      expect(c.samples).toBe(D.CURVE_SAMPLES);
      expect(c.points.length).toBe(D.CURVE_SAMPLES + 1);
    });
  });

  it('⑥ 曲线**不被断开**：`data-cuts=0`；有曲线参与的交叉记在 `curveUncut` 里（原值）', () => {
    const { svg, report } = D.renderAuto(curveDoc());
    readCurves(svg).forEach((c) => expect(c.cuts, c.id + ' 被断开了').toBe(0));
    expect(typeof report.routing.curveUncut).toBe('number');
    // 曲线参与交叉时，高优先级必须是曲线（否则"曲线不断开"会让交点被正交线盖住）
    report.routing.crossingPoints.forEach((p) => {
      const curveLow = report.routing.curveEdges.indexOf(p.low) >= 0;
      expect(curveLow, '交叉点 ' + p.x + ',' + p.y + ' 把曲线当成了低优先级（会被切断或被盖住）').toBe(false);
    });
  });

  it('手写坐标入口也能画曲线（`render()` 与 `renderAuto()` 两种坐标来源都要成立）', () => {
    const doc = autoDoc();
    doc.graph.edges.forEach((e) => { if (e.id === 'e2') e.route = 'curve'; });
    // 手写坐标：给每个节点补 rect（MS1 入口要求带 rect）
    const withRect = {
      graph: { version: 1, direction: 'LR', grid: 8, edges: doc.graph.edges },
      nodes: doc.nodes.map((n, i) => Object.assign({}, n, { rect: [i * 160, 0, 128, 64] }))
    };
    const { svg } = D.render(withRect);
    const curves = readCurves(svg);
    expect(curves.length).toBe(1);
    expect(curves[0].id).toBe('e2');
    const mine = recountCurve(curves[0]);
    expect(Math.abs(curves[0].c1[0] - mine.c1[0])).toBeLessThanOrEqual(TOL);
  });

  it('曲线与正交边**共存**：正交边仍是轴向折线（曲线不把整张图带成斜线）', () => {
    const { svg } = D.renderAuto(curveDoc());
    const ortho = svg.match(/<g data-edge="e1"[^>]*data-points="([^"]*)"/);
    expect(ortho, '正交边 e1 不见了').toBeTruthy();
    const pts = ortho[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    for (let i = 0; i + 1 < pts.length; i++) {
      const h = Math.abs(pts[i][1] - pts[i + 1][1]) < 1e-6;
      const v = Math.abs(pts[i][0] - pts[i + 1][0]) < 1e-6;
      expect(h || v, 'e1 第 ' + i + ' 段不是轴向（被曲线带歪了）').toBe(true);
    }
  });
});
