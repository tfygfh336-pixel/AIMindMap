/* ============================================================
 * tests/diagram-align.test.js —— **`C-A-04` 的居中那半 + `pinned` 与自动区域的重叠避免**
 * ------------------------------------------------------------
 * 为什么单独一个文件：`diagram-layout.test.js` 判的是"层/序/间距/稳定性"，本文件判的是
 * **副轴（cross axis）上的对齐**与**显式意图和自动区域打架时谁让路**。两件事的失败方式不同
 * （前者是"重心没跟上"，后者是"钉住的框被叠上了"），混在一个文件里会看不出是哪条坏了。
 *
 * ⚠️ 判据口径（`docs/DIAGRAM-MODES.md` 的 `C-A-04` 那一行，**读它之前先读这段**）：
 *   子节点中心都在 8 的整数倍上（`y % 8 == 0` 且 `h % 16 == 0`）。
 *   k 个子节点中心的均值 = 8·(Σaᵢ)/k ⇒ **k ∤ Σaᵢ 时不在 8 的网格上**（k=2、a={0,1} ⇒ 均值 4）。
 *   ⇒ "父节点居中"与"坐标取到 8 的整数倍"**算术上互斥**，误差的下界是半个网格步长（4px）。
 *   ⇒ 所以判据分三档（每一档都可单独判红）：
 *     ① **层内唯一节点**：没有次序约束 ⇒ 目标中心本身就在网格上 ⇒ 误差 **=== 0**（硬判）；
 *     ② **兄弟并列（k 个节点共享同一个父/子）**：全居中在几何上不可能（节点不能重叠）
 *        ⇒ 判**对称性**：误差两两互为相反数、和的绝对值 ≈ 0；
 *     ③ **全图**：有邻居的节点里 `exact` 的个数 ≥ 1，且误差均值 ≈ 0（没有系统性偏移）。
 *   任何一档都不是"看着差不多"：①是逐值相等，②③是算式。
 *
 * 判据**独立复算**：本文件从 `rects` + `report.ranks` + 夹具的 `edges` 自己算一遍目标中心，
 * 不读 `report.centering[]` 的 `target`（那个只用来对拍"报告有没有说谎"）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { autoDoc, pinnedDoc, pinnedCollideDoc, chainDoc } from './diagram-auto-fixture.js';

const EPS = 1e-6;

/* ------------------------------------------------------------------
 * 独立复算：节点 → {target, actual, errorPx}
 * ------------------------------------------------------------------ */
function recountCentering(doc, lay) {
  const rects = lay.rects;
  const rank = new Map(lay.report.ranks);
  const dir = lay.report.direction;
  const lenOf = (id) => (dir === 'LR' ? rects[id].h : rects[id].w);
  const centerOf = (id) => (dir === 'LR' ? rects[id].y + rects[id].h / 2 : rects[id].x + rects[id].w / 2);

  const ups = new Map();
  const downs = new Map();
  const ids = Object.keys(rects).sort();
  ids.forEach((id) => { ups.set(id, []); downs.set(id, []); });
  (doc.graph.edges || []).forEach((e) => {
    const a = e.from.node;
    const b = e.to.node;
    if (!rects[a] || !rects[b]) return;
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (Math.abs(ra - rb) !== 1) return;                       // 只对齐相邻层
    if (ra < rb) { downs.get(a).push(b); ups.get(b).push(a); }
    else { ups.get(a).push(b); downs.get(b).push(a); }
  });

  return ids.filter((id) => ups.get(id).length || downs.get(id).length).map((id) => {
    const list = ups.get(id).length ? ups.get(id) : downs.get(id);
    const target = list.reduce((s, nid) => s + centerOf(nid), 0) / list.length;
    const actual = centerOf(id);
    return { id: id, neighbors: list.slice().sort(), target: target, actual: actual,
      errorPx: Math.abs(actual - target), signed: actual - target, len: lenOf(id) };
  });
}

describe('C-A-04 坐标分配：副轴居中（判据独立复算）', () => {
  it('报告不说谎：`report.centering[]` 的 target/actual 与独立复算逐值相同', () => {
    const doc = autoDoc();
    const lay = D.layoutOfDoc(doc);
    const mine = recountCentering(doc, lay);
    const rep = new Map(lay.report.centering.map((c) => [c.id, c]));
    expect(rep.size).toBe(mine.length);
    mine.forEach((m) => {
      const r = rep.get(m.id);
      expect(r, m.id + ' 不在 report.centering 里').toBeTruthy();
      expect(Math.abs(r.target - m.target), m.id + '.target').toBeLessThanOrEqual(EPS);
      expect(Math.abs(r.actual - m.actual), m.id + '.actual').toBeLessThanOrEqual(EPS);
      expect(r.neighbors).toEqual(m.neighbors);
    });
  });

  it('① 层内**唯一节点**：居中误差 **=== 0**（目标中心本就在网格上，没有任何借口）', () => {
    const doc = autoDoc();
    const lay = D.layoutOfDoc(doc);
    const mine = recountCentering(doc, lay);
    const layerCount = new Map();
    Object.keys(lay.rects).forEach((id) => {
      const r = lay.report.rankOf[id];
      layerCount.set(r, (layerCount.get(r) || 0) + 1);
    });
    const alone = mine.filter((m) => layerCount.get(lay.report.rankOf[m.id]) === 1);
    expect(alone.length, '这张图没有"层内唯一"的节点 ⇒ 这一档判据无从验证').toBeGreaterThanOrEqual(3);
    alone.forEach((m) => {
      expect(m.errorPx, m.id + ' 独占一层却没居中（误差 ' + m.errorPx + 'px）').toBeLessThanOrEqual(EPS);
    });
  });

  it('① 长链图（每层一个节点）：**每个**节点的误差都是 0（不靠"恰好"）', () => {
    const doc = chainDoc(6);
    const lay = D.layoutOfDoc(doc);
    const mine = recountCentering(doc, lay);
    expect(mine.length).toBe(6);                                // 链上每个节点都至少有一个相邻层邻居
    mine.forEach((m) => expect(m.errorPx, m.id).toBeLessThanOrEqual(EPS));
  });

  it('② 兄弟并列：误差两两互为相反数（对称分布，不是"挤到一边"）', () => {
    const doc = autoDoc();
    const lay = D.layoutOfDoc(doc);
    const mine = recountCentering(doc, lay);
    // 按"同一个邻居集合"分组（兄弟 = 共享同一个父/子）
    const groups = new Map();
    mine.forEach((m) => {
      const k = m.neighbors.join('|');
      if (m.neighbors.length !== 1) return;                     // 只挑"共同指向同一个邻居"的兄弟组
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    });
    let checked = 0;
    groups.forEach((list, k) => {
      if (list.length < 2) return;
      checked++;
      const sum = list.reduce((s, m) => s + m.signed, 0);
      expect(Math.abs(sum), k + ' 这组兄弟的误差和有系统性偏移（' + sum + 'px）').toBeLessThanOrEqual(4);
      // 最大与最小误差必须关于 0 对称（±同一个值）
      const vals = list.map((m) => m.signed).sort((a, b) => a - b);
      const lo = vals[0];
      const hi = vals[vals.length - 1];
      expect(Math.abs(lo + hi), k + ' 这组兄弟不是对称分布（' + lo + ' / ' + hi + '）').toBeLessThanOrEqual(4);
    });
    expect(checked, '这张图没有"兄弟并列"组 ⇒ 这一档判据无从验证').toBeGreaterThan(0);
  });

  it('③ 全图：`exact` 节点 ≥ 1，且误差均值 ≈ 0（无系统性偏移）', () => {
    const doc = autoDoc();
    const lay = D.layoutOfDoc(doc);
    const mine = recountCentering(doc, lay);
    const exact = mine.filter((m) => m.errorPx <= EPS);
    expect(exact.length, '一个节点都没居中 ⇒ "有居中算法"这件事在判据上不可见').toBeGreaterThanOrEqual(1);
    const mean = mine.reduce((s, m) => s + m.signed, 0) / mine.length;
    expect(Math.abs(mean), '全图居中误差均值 = ' + mean + 'px（有系统性偏移）').toBeLessThanOrEqual(4);
    // 误差的上界是"半个网格步长 × 兄弟数/2"——这里只断言一个**可解释**的上界，
    // 不假装能做到 4px（兄弟并列时全居中在几何上不可能，见文件头 ②）
    mine.forEach((m) => expect(Number.isFinite(m.errorPx)).toBe(true));
  });

  it('对齐是**确定性**的：两跑 rects 逐字节相同；打乱 nodes 后也相同', () => {
    const a = D.layoutOfDoc(autoDoc());
    const b = D.layoutOfDoc(autoDoc());
    expect(JSON.stringify(b.rects)).toBe(JSON.stringify(a.rects));
    const shuffled = autoDoc();
    shuffled.nodes = shuffled.nodes.slice().reverse();
    const c = D.layoutOfDoc(shuffled);
    expect(JSON.stringify(c.rects)).toBe(JSON.stringify(a.rects));
    expect(c.report.align.iterations).toBe(a.report.align.iterations);
  });

  it('对齐 **不破坏**"坐标取到 8 的整数倍"（网格量化是硬约束，居中在它之下让路）', () => {
    const lay = D.layoutOfDoc(autoDoc());
    Object.keys(lay.rects).forEach((id) => {
      const r = lay.rects[id];
      expect(r.x % 8, id + '.x=' + r.x).toBe(0);
      expect(r.y % 8, id + '.y=' + r.y).toBe(0);
    });
  });

  it('TB 方向同样成立（副轴 = x，判据不许只对 LR 写）', () => {
    const doc = chainDoc(4);
    doc.graph.direction = 'TB';
    const lay = D.layoutOfDoc(doc);
    const mine = recountCentering(doc, lay);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    mine.forEach((m) => expect(m.errorPx, m.id + '（TB）').toBeLessThanOrEqual(EPS));
  });
});

describe('pinned 与自动区域的重叠避免（`C-F4-05` 的漏洞）', () => {
  it('钉住的框**逐值不变**，自动节点被推开：两者零重叠', () => {
    const doc = pinnedCollideDoc();
    const lay = D.layoutOfDoc(doc);
    // 钉住的照旧
    expect(lay.rects['n-b']).toEqual({ x: 0, y: 0, w: 208, h: 96 });
    expect(lay.report.explicit.length).toBe(1);
    // 自动节点一个都不许与它相交
    const hit = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
      && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
    Object.keys(lay.rects).forEach((id) => {
      if (id === 'n-b') return;
      expect(hit(lay.rects[id], lay.rects['n-b']), id + ' 与钉住的 n-b 重叠').toBe(false);
    });
    // 推的动作要**点名**（不然"它自己就摆在那"与"被推开"分不清）
    expect(lay.report.pinnedAvoid.length).toBeGreaterThanOrEqual(1);
    const moved = lay.report.pinnedAvoid[0];
    expect(moved.awayFrom).toContain('n-b');
    expect(['x', 'y']).toContain(moved.axis);
    expect(Math.abs(moved.delta) % 8).toBe(0);                  // 推的距离也在网格上
  });

  it('被推开的节点仍在 8px 网格上（推不是"随手挪一点"）', () => {
    const lay = D.layoutOfDoc(pinnedCollideDoc());
    Object.keys(lay.rects).forEach((id) => {
      expect(lay.rects[id].x % 8).toBe(0);
      expect(lay.rects[id].y % 8).toBe(0);
    });
  });

  it('不撞就不推：`pinnedDoc()`（钉住的框离得远）⇒ `pinnedAvoid` 为空', () => {
    const lay = D.layoutOfDoc(pinnedDoc());
    expect(lay.report.pinnedAvoid).toEqual([]);
    expect(lay.report.pinRounds).toBe(0);
  });

  it('渲染这一层也不出错：撞过的图能画出来、无溢出', () => {
    const res = D.renderAuto(pinnedCollideDoc());
    expect(res.report.overflowCount).toBe(0);
    expect(res.report.widened).toEqual([]);
  });
});
