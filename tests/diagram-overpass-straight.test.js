/* ============================================================
 * tests/diagram-overpass-straight.test.js —— **直连边的 overpass（`C-F3-18` 的手写坐标那一档）**
 * ------------------------------------------------------------
 * 这一条有两个**互相拉扯**的要求，所以必须是同一个文件里的两组用例：
 *   ① **补上**：直连边（没有跑布线、只有一条线段）也要逐点断开 4px + 高优先级白描；
 *   ② **别动基线**：MS1 的"手写坐标 → SVG"是**逐字节契约**，缺省产物一个字节都不许变。
 * ⇒ 做法：`render(doc, { overpass: true })` 才是 ①；缺省仍是 ②。
 * ⇒ 判据：同一份 fixture，**缺省**的 sha256 必须等于**录下来的 MS1 基线**，**开了**才多出白描/断线。
 *
 * 基线哈希的来历（不是"跑一遍抄下来"）：
 *   用 `git show 9037c4b:src/diagram/{index,schema,measure,render-svg}.js` 取 **MS1 提交当时的源码**，
 *   在 `%TEMP%` 里渲染同样三份 fixture，与本文件的三条哈希逐值比对 —— 三条全 SAME（见
 *   `.review/20261061-参考archify与graphify/读数.md` 的「MS1 基线」一节）。
 *   ⇒ 所以这三条哈希**不是**"当前实现的自我快照"，而是"MS1 提交时就是这样"。
 *
 * 判别力（该红）：
 *   · 缺省里出现 `data-halo` / `data-seg` ⇒ 基线判据红；
 *   · 开了却没有白描 / 缺口 ≠ 4px / 只断一处 ⇒ 逐点判据红；
 *   · 开了之后坐标变了（overpass 只该改"画法"）⇒ 几何判据红。
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { netfilterDoc, sixShapesDoc, minimalDoc } from './diagram-fixture.js';

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

/** **MS1 提交（9037c4b）时的产物哈希** —— 缺省路径必须逐字节复现它们 */
const MS1_BASELINE = {
  netfilterDoc: { sha: 'eed1b69f6a7815254c81ac9e8e5c8a6ea3f1ad12a2be343ca81f298cf1b712c9', bytes: 12203 },
  sixShapesDoc: { sha: '56bb46510cfd1f3189efe758eab224933c5162c6e5ba5b01c007e80c18fe0daa', bytes: 5442 },
  minimalDoc: { sha: 'd9e9ab1c93b9886610d2e8562709e9532dad75e360006f3ea9136369d0533e21', bytes: 1844 }
};

/** 读某条边的 `data-seg` 段（实际画出来的段） */
function segsOf(svg, edgeId) {
  const out = [];
  const re = new RegExp('<line data-edge="' + edgeId + '" data-seg="(\\d+)" x1="([-\\d.]+)" y1="([-\\d.]+)" x2="([-\\d.]+)" y2="([-\\d.]+)"', 'g');
  let m;
  while ((m = re.exec(svg)) !== null) {
    out.push({ i: Number(m[1]), a: [Number(m[2]), Number(m[3])], b: [Number(m[4]), Number(m[5])] });
  }
  return out;
}

/** 两条**斜线**交叉的最小图（斜线是最容易"只处理轴向"的漏洞） */
function crossDoc() {
  const node = (id, x, y) => ({ id: id, type: 'rect', rect: [x, y, 96, 48], title: id, subtitle: 's' });
  return {
    graph: {
      version: 1, direction: 'LR', grid: 8,
      edges: [
        // 用**显式端口**把两条边逼成斜线：a.s → b.n 与 c.e → d.w
        { id: 'x1', from: { node: 'a', port: 's' }, to: { node: 'b', port: 'n' } },
        { id: 'x2', from: { node: 'c', port: 'e' }, to: { node: 'd', port: 'w' } }
      ]
    },
    nodes: [node('a', 0, 0), node('b', 240, 240), node('c', 0, 240), node('d', 240, 0)]
  };
}

/* ==================================================================
 * ① 基线：缺省产物 = MS1 提交时的字节
 * ================================================================== */
describe('缺省（不传 overpass）⇒ 产物与 MS1 **逐字节相同**（基线判据）', () => {
  const cases = [['netfilterDoc', netfilterDoc], ['sixShapesDoc', sixShapesDoc], ['minimalDoc', minimalDoc]];
  cases.forEach(([name, make]) => {
    it(name + '：sha256 与字节数都等于 MS1 提交时的读数', () => {
      const { svg } = D.render(make());
      expect(svg.length, name + ' 的字节数变了').toBe(MS1_BASELINE[name].bytes);
      expect(sha256(svg), name + ' 的 sha256 变了（MS1 基线被动了）').toBe(MS1_BASELINE[name].sha);
    });
  });

  it('缺省里**没有**白描、没有断段、边还是 `<line>`（不是"改成了分组"）', () => {
    const { svg, report } = D.render(netfilterDoc());
    expect(svg).not.toContain('data-halo');
    expect(svg).not.toContain('data-seg=');
    expect(svg).toMatch(/<line data-edge="/);
    expect(report.overpass).toEqual({ enabled: false });     // "没有"要说出来，不是沉默
  });

  it('显式 `overpass: false` 与不传完全等价（开关是二值的，不许有第三态）', () => {
    const a = D.render(netfilterDoc()).svg;
    const b = D.render(netfilterDoc(), { overpass: false }).svg;
    expect(sha256(b)).toBe(sha256(a));
  });
});

/* ==================================================================
 * ② 补上：开了就逐点断开 + 白描
 * ================================================================== */
describe('`overpass: true` ⇒ 直连边也逐点断开 4px + 高优先级白描', () => {
  it('netfilter 这张图真的有交叉：每个交叉点一条白描、低优先级边被断', () => {
    const { svg, report } = D.render(netfilterDoc(), { overpass: true });
    expect(report.overpass.enabled).toBe(true);
    expect(report.overpass.crossings, '这张 fixture 没有交叉 ⇒ 判据空转').toBeGreaterThan(0);
    const halos = (svg.match(/data-halo="1"/g) || []).length;
    expect(halos).toBe(report.overpass.crossings);           // **逐点**一条
    expect(report.overpass.edgesCut.length).toBeGreaterThan(0);
    // 被断的那条边，段数 > 1（一条直线被切成两段 = 中间有缺口）
    report.overpass.edgesCut.forEach((id) => {
      expect(segsOf(svg, id).length, id + ' 被点名为"断过"，却仍然只有一段').toBeGreaterThan(1);
    });
  });

  it('缺口 = 2 × `GAP_HALF`（判据原文"断开 4px"），沿**边自己的方向**量', () => {
    const { svg, report } = D.render(netfilterDoc(), { overpass: true });
    const cp = report.overpass.crossingPoints[0];
    const low = cp.low;
    const segs = segsOf(svg, low);
    // 交点把该边切成两段：取交点两侧最近的端点，量它们之间的距离（沿边方向）
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const ends = [];
    segs.forEach((s) => { ends.push(s.a, s.b); });
    ends.sort((p, q) => dist(p, [cp.x, cp.y]) - dist(q, [cp.x, cp.y]));
    // 最近的四个端点里，两侧各取一个离交点最近的点，它们之间的距离就是缺口
    const near = ends.slice(0, 2);
    const gap = dist(near[0], near[1]);
    expect(Math.abs(gap - 2 * D.GAP_HALF), '缺口 = ' + gap + 'px（要求 ' + (2 * D.GAP_HALF) + 'px）')
      .toBeLessThanOrEqual(0.5);
  });

  it('斜线交叉也处理（正交那套 `cutPolyline` 只管轴向 ⇒ 这里必须另走一条）', () => {
    const { svg, report } = D.render(crossDoc(), { overpass: true });
    expect(report.overpass.crossings, '斜线 fixture 没有交叉 ⇒ 这一档没验到').toBeGreaterThan(0);
    const halos = (svg.match(/data-halo="1"/g) || []).length;
    expect(halos).toBe(report.overpass.crossings);
    const low = report.overpass.crossingPoints[0].low;
    const segs = segsOf(svg, low);
    expect(segs.length).toBe(2);                             // 一条斜线被切成两段
    segs.forEach((s) => {
      const dx = Math.abs(s.b[0] - s.a[0]);
      const dy = Math.abs(s.b[1] - s.a[1]);
      expect(dx > 1e-6 && dy > 1e-6, '切口附近的段不是斜线了（被改成了轴向）').toBe(true);
    });
  });

  it('开了也**只改画法、不改几何**：每条边的两端坐标与缺省逐值相同', () => {
    const off = D.render(netfilterDoc());
    const on = D.render(netfilterDoc(), { overpass: true });
    const endsOf = (svg) => {
      const out = {};
      const re = /<line data-edge="([^"]+)" data-from-port="[^"]*" data-to-port="[^"]*" x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g;
      let m;
      while ((m = re.exec(svg)) !== null) out[m[1]] = [m[2], m[3], m[4], m[5]];
      return out;
    };
    const a = endsOf(off.svg);
    // 开了之后：分组里的 `data-points` 给出端点，两者必须一致
    const pointsOf = (svg) => {
      const out = {};
      const re = /<g data-edge="([^"]+)"[^>]*data-points="([^"]*)"/g;
      let m;
      while ((m = re.exec(svg)) !== null) out[m[1]] = m[2].trim().split(/\s+/).map((p) => p.split(','));
      return out;
    };
    const b = pointsOf(on.svg);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    Object.keys(a).forEach((id) => {
      expect(b[id][0]).toEqual([a[id][0], a[id][1]]);
      expect(b[id][b[id].length - 1]).toEqual([a[id][2], a[id][3]]);
    });
  });

  it('开了以后也是确定的：两跑逐字节相同（隔 5ms）', async () => {
    const a = D.render(netfilterDoc(), { overpass: true }).svg;
    await new Promise((r) => setTimeout(r, 5));
    const b = D.render(netfilterDoc(), { overpass: true }).svg;
    expect(sha256(b)).toBe(sha256(a));
  });

  it('自动布线那一档**不受**这个开关影响（它本来就有 overpass，别被双重处理）', () => {
    const doc = { graph: { version: 1, direction: 'LR', grid: 8,
      edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }] },
    nodes: [{ id: 'a', type: 'rect', title: '甲' }, { id: 'b', type: 'rect', title: '乙' }] };
    const a = D.renderAuto(doc);
    const b = D.renderAuto(doc, { overpass: true });
    expect(sha256(b.svg)).toBe(sha256(a.svg));
  });
});
