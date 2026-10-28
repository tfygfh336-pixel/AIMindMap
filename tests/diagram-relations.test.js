/* ============================================================
 * tests/diagram-relations.test.js —— **关系层端点落在节点矩形边界上**（收口批 · 丙）
 * ------------------------------------------------------------
 * 病象（`renderer/app-related.js:152` 的原实现）：关系线画的是**节点中心到中心**
 * （`M ra.cx,ra.cy L rb.cx,rb.cy`），而图渲染器的边端点是**节点边界上的端口点**
 * （`route.autoPorts` + `route.portPoint`）。两套规则 ⇒「端点落在节点矩形边界上（±1px）」恒不成立。
 * 实测（`.review/20261068-图能力收尾/读数.md`，真实项目 24 对）：改前 **48/48 个端点越界，
 * 32–56px**；改后 **0/48，max 0px**。
 *
 * 本文件判的是**内核里那一份规则**（`D.relationsOf`），因为规则只能有一份：
 * 渲染层（jsMind 坐标系）与图渲染层（SVG 坐标系）各给自己的节点矩形，端点就都落在**各自的**边界上
 * —— 这就是"两套坐标系"这件事的解法：不是把坐标换算来换算去，而是让规则与坐标系无关。
 *
 * 判据独立复算：端点偏差由本文件**自己写一份**点→矩形距离（不调 `D.boundaryDev`），
 * 报告里的 `maxDevPx` 只用来对拍"报告有没有说谎"。
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** **独立**的一份：点到矩形边界的距离（在边界上 ⇒ 0；内部 ⇒ 到最近边；外部 ⇒ 到矩形） */
function devOf(rect, p) {
  const eps = 1e-9;
  const inX = p.x >= rect.x - eps && p.x <= rect.x + rect.w + eps;
  const inY = p.y >= rect.y - eps && p.y <= rect.y + rect.h + eps;
  if (!inX || !inY) {
    const dx = Math.max(rect.x - p.x, p.x - (rect.x + rect.w), 0);
    const dy = Math.max(rect.y - p.y, p.y - (rect.y + rect.h), 0);
    return Math.hypot(dx, dy);
  }
  return Math.min(Math.abs(p.x - rect.x), Math.abs(p.x - (rect.x + rect.w)),
    Math.abs(p.y - rect.y), Math.abs(p.y - (rect.y + rect.h)));
}

/* 夹具：两套坐标系各一份（**同一批节点、不同原点**）—— 规则必须与坐标系无关 */
const POS = [
  { id: 'a', rect: [0, 0, 120, 40] },
  { id: 'b', rect: [200, 100, 80, 40] },
  { id: 'c', rect: [40, 260, 160, 64] }
];
const NEG = POS.map((n) => ({ id: n.id, rect: [n.rect[0] - 320, n.rect[1] - 200, n.rect[2], n.rect[3]] }));
const PAIRS = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }];

const rectMap = (nodes) => new Map(nodes.map((n) => [n.id, { x: n.rect[0], y: n.rect[1],
  w: n.rect[2], h: n.rect[3] }]));

describe('端点落在节点矩形边界上（±1px）', () => {
  it('三个端点对逐个 ≤ 1px（判据独立复算，不读 report.maxDevPx 自证）', () => {
    const out = D.relationsOf({ nodes: POS, relations: PAIRS });
    expect(out.lines.length).toBe(PAIRS.length);
    const rm = rectMap(POS);
    out.report.endpoints.forEach((e) => {
      expect(devOf(rm.get(e.from), e.a), e.id + ' 的 from 端点不在边界上').toBeLessThanOrEqual(1);
      expect(devOf(rm.get(e.to), e.b), e.id + ' 的 to 端点不在边界上').toBeLessThanOrEqual(1);
    });
    expect(out.report.maxDevPx).toBe(0);                 // 与独立复算对拍：报告没夸张也没缩小
    expect(out.report.onBoundary).toBe(true);
  });

  it('**与坐标系无关**：整批矩形平移 (−320, −200) ⇒ 偏差仍然 0，端点也整体平移这么多', () => {
    const pos = D.relationsOf({ nodes: POS, relations: PAIRS });
    const neg = D.relationsOf({ nodes: NEG, relations: PAIRS });
    expect(neg.report.maxDevPx).toBe(0);
    expect(neg.report.onBoundary).toBe(true);
    pos.report.endpoints.forEach((e, i) => {
      expect(neg.report.endpoints[i].a.x).toBe(e.a.x - 320);
      expect(neg.report.endpoints[i].a.y).toBe(e.a.y - 200);
    });
  });

  it('"线不飞到画布外"：所有端点在"节点矩形并集"之内（现算，不靠论证）', () => {
    const out = D.relationsOf({ nodes: POS, relations: PAIRS });
    expect(out.report.outOfCanvas.count).toBe(0);
    expect(out.report.outOfCanvas.maxPx).toBe(0);
    expect(out.report.canvas).toEqual({ x: 0, y: 0, w: 280, h: 324 });
  });

  it('端点确实落在**该节点自己的**边界上，而不是"两个节点中间"', () => {
    const out = D.relationsOf({ nodes: POS, relations: [{ from: 'a', to: 'b' }] });
    const rm = rectMap(POS);
    const e = out.report.endpoints[0];
    const ra = rm.get('a');
    const rb = rm.get('b');
    // 端点必须同时满足"在该矩形边界上" —— 用两个方向各验一次
    const onA = e.a.x === ra.x + ra.w || e.a.x === ra.x || e.a.y === ra.y || e.a.y === ra.y + ra.h;
    const onB = e.b.x === rb.x + rb.w || e.b.x === rb.x || e.b.y === rb.y || e.b.y === rb.y + rb.h;
    expect(onA && onB).toBe(true);
    expect(e.a).toEqual({ x: 120, y: 20 });              // a 的东侧中点
    expect(e.b).toEqual({ x: 200, y: 120 });             // b 的西侧中点
    expect(out.lines[0].d).toBe('M120,20 L200,120');
  });

  it('确定性：两次调用逐字节相同（纯函数，无时钟 / 随机）', () => {
    const one = D.relationsOf({ nodes: POS, relations: PAIRS });
    const two = D.relationsOf({ nodes: POS, relations: PAIRS });
    expect(sha(JSON.stringify(one))).toBe(sha(JSON.stringify(two)));
  });
});

describe('不许静默丢线 / 静默猜端点', () => {
  it('端点指向不存在的节点 ⇒ 进 `skipped[]` 并写清为什么（不静默丢）', () => {
    const out = D.relationsOf({ nodes: POS, relations: [{ from: 'a', to: 'gone' }] });
    expect(out.lines).toEqual([]);
    expect(out.report.skipped.length).toBe(1);
    expect(out.report.skipped[0].why).toBe('to 不在图上');
    expect(out.report.skipped[0].from).toBe('a');
  });

  it('自关系（from === to）⇒ 进 `skipped[]` 并点名（零长线段没有几何，但不许"悄悄没了"）', () => {
    const out = D.relationsOf({ nodes: POS, relations: [{ from: 'a', to: 'a' }] });
    expect(out.report.skipped.length).toBe(1);
    expect(out.report.skipped[0].why).toContain('自关系');
  });

  it('节点矩形不合法 ⇒ `E_RELATION_REF`（稳定码 + 指向对象），不许静默跳过', () => {
    let err = null;
    try {
      D.relationsOf({ nodes: [{ id: 'a', rect: [0, 0, 120] }, { id: 'b', rect: [1, 1, 2, 2] }],
        relations: [{ from: 'a', to: 'b' }] });
    } catch (e) { err = e; }
    expect(err && err.code).toBe('E_RELATION_REF');
    expect(err.detail.object.nodes.length).toBe(1);
    expect(err.detail.fixes.length).toBeGreaterThan(0);
  });
});

describe('判别力：改前（中心到中心）在这条判据上**必须红**', () => {
  it('中心端点的偏差 = 中心到边界 → 三个对全部 > 1px（证明这条判据有靶子）', () => {
    const rm = rectMap(POS);
    let worst = 0;
    let over = 0;
    PAIRS.forEach((p) => {
      const a = rm.get(p.from);
      const b = rm.get(p.to);
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      [devOf(a, ca), devOf(b, cb)].forEach((d) => {
        worst = Math.max(worst, d);
        if (d > 1) over++;
      });
    });
    expect(over).toBe(PAIRS.length * 2);                 // 6 个端点全越界
    expect(worst).toBeGreaterThan(20);                   // 最坏 > 20px（夹具里最窄的节点是 40 高）
  });
});
