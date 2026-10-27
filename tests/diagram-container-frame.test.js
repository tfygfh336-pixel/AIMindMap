/* ============================================================
 * tests/diagram-container-frame.test.js —— **容器框是"框架"，不是"障碍"**（`C-F2-01` 的语义那半）
 * ------------------------------------------------------------
 * 这条能力在 MS2 里只做了"框住节点"，**语义没定**（MS2 报告如实登记过）。本文件把它定下来：
 *
 *   允许：连线**垂直穿过**容器框（组内 ↔ 组外的边必须穿框，否则这类边永远无解）
 *   允许：连线在容器框的**顶点相触**（只碰一个点）
 *   禁止：连线**沿容器边框共线跑**（读者会把边框当成那条线；archify 叫 Clear Container Corridor）
 *
 * 判据分两层，**都不依赖"看起来对不对"**：
 *   ① 纯函数层：直接喂合成折线 + 合成框架，验"共线且重叠 > 1px 才点名"（注入一次偏移 ⇒ 红）；
 *   ② 渲染层：带容器的图能画出来，`report.routing.frameBorders` 是数组，且 `problems` 里
 *      没有 `E_ROUTE_MARGIN` / `E_ROUTE_FAILED`（= 容器没有被当障碍，边没有被逼到兜底路径）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';

const FRAME = { x: 100, y: 100, w: 200, h: 160 };

describe('容器当"框架"：沿边框共线跑要点名，垂直穿过/顶点相触放行', () => {
  it('水平段与上边框**共线且重叠** ⇒ 被点名（含重叠长度与区间）', () => {
    const runs = D.frameBorderRuns({ e1: [[60, 100], [180, 100]] }, [FRAME]);
    expect(runs.length).toBe(1);
    expect(runs[0].edge).toBe('e1');
    expect(runs[0].side).toBe('top');
    expect(runs[0].overlap).toBeCloseTo(80, 6);              // 100…180 与边框 100…300 的重叠
    expect(runs[0].from).toBe(100);
    expect(runs[0].to).toBe(180);
  });

  it('垂直穿过框心 ⇒ **不**点名（组内 ↔ 组外的边本来就要穿框）', () => {
    const runs = D.frameBorderRuns({ e1: [[200, 40], [200, 320]] }, [FRAME]);
    expect(runs).toEqual([]);
  });

  it('在顶点相触（只碰一个点，重叠 = 0） ⇒ 不点名', () => {
    // 段从左边过来，正好停在上边框的左顶点
    const runs = D.frameBorderRuns({ e1: [[40, 100], [100, 100]] }, [FRAME]);
    expect(runs).toEqual([]);
  });

  it('重叠不足 1px 也不算（判据是"跑"，不是"擦"）', () => {
    const runs = D.frameBorderRuns({ e1: [[40, 100], [100.5, 100]] }, [FRAME]);
    expect(runs).toEqual([]);
  });

  it('四条边都认（上/下/左/右），不是只认上边', () => {
    const sides = [
      { pts: [[120, 100], [220, 100]], side: 'top' },
      { pts: [[120, 260], [220, 260]], side: 'bottom' },
      { pts: [[100, 120], [100, 220]], side: 'left' },
      { pts: [[300, 120], [300, 220]], side: 'right' }
    ];
    sides.forEach((s) => {
      const runs = D.frameBorderRuns({ e1: s.pts }, [FRAME]);
      expect(runs.length, s.side + ' 边没被认出来').toBe(1);
      expect(runs[0].side).toBe(s.side);
    });
  });

  it('多个框架、多条边：逐条点名且**按 edge/frame/side 定序**（确定性）', () => {
    const f2 = { x: 400, y: 100, w: 120, h: 120 };
    const runs = D.frameBorderRuns({
      b: [[420, 100], [500, 100]],
      a: [[100, 120], [100, 200]]
    }, [FRAME, f2]);
    expect(runs.map((r) => [r.edge, r.frame, r.side])).toEqual([['a', 0, 'left'], ['b', 1, 'top']]);
  });
});

describe('渲染层：带容器的图**能画出来**（容器没被当障碍）', () => {
  function containerDoc() {
    return {
      graph: {
        version: 1, direction: 'LR', grid: 8,
        containers: [{ id: 'c1', label: '组', rect: [0, 0, 320, 240], layout: 'free', children: ['a', 'b'] }],
        edges: [
          { id: 'e1', from: { node: 'a' }, to: { node: 'c' } },
          { id: 'e2', from: { node: 'b' }, to: { node: 'c' } }
        ]
      },
      nodes: [
        { id: 'a', type: 'rect', title: '组内甲', subtitle: 'a' },
        { id: 'b', type: 'rect', title: '组内乙', subtitle: 'b' },
        { id: 'c', type: 'rect', title: '组外丙', subtitle: 'c' }
      ]
    };
  }

  it('容器里外的边能布出来：没有兜底路径、没有"贴着边框跑"', () => {
    const { svg, report } = D.renderAuto(containerDoc());
    expect(report.routing.enabled).toBe(true);
    expect(report.routing.frameBorders).toEqual([]);          // 没有边沿着边框跑
    expect(report.problems.filter((p) => p.indexOf('E_ROUTE_MARGIN') === 0)).toEqual([]);
    expect(report.problems.filter((p) => p.indexOf('E_ROUTE_FAILED') === 0)).toEqual([]);
    expect(svg).toContain('data-container="c1"');
  });

  it('容器**不参与避障**：两条边都真的画出来了（不是"绕不过去就丢掉"）', () => {
    const { svg, report } = D.renderAuto(containerDoc());
    const groups = svg.match(/<g data-edge="e\d"/g) || [];
    expect(groups.length).toBe(2);
    expect(report.routing.crossings).toBeGreaterThanOrEqual(0);
  });

  it('没有容器时 `frameBorders` 是空数组（不是 undefined —— 读数要给出来，不是省略）', () => {
    const doc = containerDoc();
    delete doc.graph.containers;
    const { report } = D.renderAuto(doc);
    expect(Array.isArray(report.routing.frameBorders)).toBe(true);
    expect(report.routing.frameBorders).toEqual([]);
  });
});
