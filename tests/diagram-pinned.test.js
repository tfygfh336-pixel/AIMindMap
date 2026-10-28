/* ============================================================
 * tests/diagram-pinned.test.js —— **`graph.pinned` 真的被用上**（收口批 · 乙）
 * ------------------------------------------------------------
 * 病象（`.review/20261065-MS3接界面/README.md` 缺口 5 的原文）："`graph.pinned` 没被用：
 * 人工位置走的是「派生时把 `meta.nodeOffsets` 叠到自动布局坐标上」"。内核里更窄：
 * `layout.js` 只在"`pinned` 且节点**自己带 `rect`**"时才生效，其余情况**静默忽略**
 * （写了 `pinned` 与没写得到一模一样的结果，报告里一个字都没有）。
 *
 * 本文件钉住四件事：
 *   ① **坐标逐值**：pinned 命中者 = 数据给的值（`rect` 或 `offsets`），**容差 0**（不重新量化）；
 *   ② **不覆盖**：未 pinned 的节点被自动排布，且与 pinned 矩形**零相交**；
 *   ③ **不静默**：pinned 命中但没有坐标 ⇒ `report.pinnedUnresolved[]` + `degraded[]` **逐条点名**；
 *   ④ **确定性**：两跑分离 5ms，产物逐字节相同（sha256）。
 *
 * ⚠️ 判据的靶子（防"判据空转"）：每条判据都配一条**必须红**的反例（见 `describe('判别力')`）：
 *   把 pinned 的 rect 挪 1px ⇒ ①红；把自动节点硬塞进 pinned 框 ⇒ ②红；
 *   把 offsets 故意丢掉 ⇒ ③红。没有靶子的判据不算判据。
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { pinnedDoc, pinnedCollideDoc } from './diagram-auto-fixture.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 矩形相交（**与实现无关的一份**：严格重叠才算，边界相触不算） */
function hits(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
const bboxOf = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });

describe('① 坐标逐值（容差 0）', () => {
  it('`pinned + rect`：位置**逐值等于**声明的 rect（自动布局不许覆盖）', () => {
    const lay = D.layoutOfDoc(pinnedDoc());
    expect(lay.rects['n-b']).toEqual({ x: 600, y: 400, w: 208, h: 96 });
    expect(lay.report.explicit).toEqual([{ id: 'n-b', rect: { x: 600, y: 400, w: 208, h: 96 },
      why: 'pinned+rect' }]);
  });

  it('`pinned + offsets`：坐标 = 自动布局位置 ⊕ 偏移，**不重新量化**（小数也原样）', () => {
    const doc = pinnedDoc();
    doc.nodes.forEach((n) => { if (n.id === 'n-b') delete n.rect; });   // 没有 rect，只有 pinned + 偏移
    const baseLay = D.layoutOfDoc(doc);
    const base = baseLay.rects['n-b'];
    const off = { x: 40.5, y: -23.25 };
    const lay = D.layoutOfDoc(doc, { offsets: { 'n-b': off } });
    expect(lay.rects['n-b'].x).toBe(base.x + off.x);                   // === 逐值（不是 toBeCloseTo）
    expect(lay.rects['n-b'].y).toBe(base.y + off.y);
    expect(lay.rects['n-b'].x % 1).toBeCloseTo(0.5, 10);               // 证明没有取整回 8px 网格
    const one = lay.report.explicit.find((e) => e.id === 'n-b');
    expect(one.why).toBe('pinned+offset');
    expect(one.offset).toEqual(off);
    expect(one.base).toEqual({ x: base.x, y: base.y });
  });

  it('`pinned` 的声明顺序不影响结果（集合语义 ⇒ 逐字节稳）', () => {
    const a = pinnedCollideDoc();
    const b = pinnedCollideDoc();
    b.graph.pinned = a.graph.pinned.slice().reverse();
    expect(sha(JSON.stringify(D.layoutOfDoc(a).rects))).toBe(sha(JSON.stringify(D.layoutOfDoc(b).rects)));
  });
});

describe('② 不覆盖：未 pinned 的自动排布，且与 pinned 矩形零相交', () => {
  it('`pinnedCollideDoc()`：钉住的框位置**逐值不变**，自动节点全被推出去（零相交）', () => {
    const doc = pinnedCollideDoc();
    const lay = D.layoutOfDoc(doc);
    const pinnedRect = { x: 0, y: 0, w: 208, h: 96 };
    expect(lay.rects['n-b']).toEqual(pinnedRect);                      // 一个像素都没动
    const others = doc.nodes.map((n) => n.id).filter((id) => id !== 'n-b');
    others.forEach((id) => {
      expect(lay.rects[id], id + ' 没被自动布局').toBeTruthy();
      expect(hits(bboxOf(lay.rects[id]), pinnedRect), id + ' 压在钉住的框上 ⇒ 覆盖').toBe(false);
    });
    expect(lay.report.pinnedAvoid.length).toBeGreaterThanOrEqual(1);   // 确实推过（不是"刚好不撞"）
  });

  it('两跑逐字节一致（隔 5ms）—— 布局是纯函数，没有时钟 / 随机', async () => {
    const doc = pinnedCollideDoc();
    const one = D.renderAuto(doc);
    await sleep(5);
    const two = D.renderAuto(pinnedCollideDoc());
    expect(sha(one.svg)).toBe(sha(two.svg));
    // `renderAuto().layout` **就是** rects 表（不是 {rects}）—— 两跑逐字节比
    expect(sha(JSON.stringify(one.layout))).toBe(sha(JSON.stringify(two.layout)));
    expect(sha(JSON.stringify(one.report.layout.pinnedAvoid)))
      .toBe(sha(JSON.stringify(two.report.layout.pinnedAvoid)));
  });
});

describe('③ 不静默：pinned 命中但**没有坐标** ⇒ 点亮名，不许忽略', () => {
  it('既没有 `rect` 也没有 `offsets` ⇒ `pinnedUnresolved[]` + `degraded[]` 点名该 id', () => {
    const doc = pinnedDoc();
    doc.graph.pinned = ['n-a'];                       // n-a 没有 rect
    const lay = D.layoutOfDoc(doc);
    expect(lay.report.explicit).toEqual([]);          // 兑现不了 ⇒ 不进 explicit（没有坐标可以兑现）
    expect(lay.report.pinnedUnresolved).toEqual([{ id: 'n-a', why: 'no-coord' }]);
    const degr = lay.report.degraded.filter((d) => d.indexOf('E_PIN_NO_COORD') >= 0);
    expect(degr.length).toBe(1);
    expect(degr[0]).toContain('n-a');
    expect(degr[0]).toContain('opts.offsets');        // 报文里给可用修法
    // 它仍被自动布局放了（不是"丢掉不画"）
    expect(lay.rects['n-a']).toBeTruthy();
  });

  it('给了 `offsets` 就兑现：不再进 `pinnedUnresolved`', () => {
    const doc = pinnedDoc();
    doc.nodes.forEach((n) => { if (n.id === 'n-a') delete n.rect; });
    doc.graph.pinned = ['n-a'];
    const lay = D.layoutOfDoc(doc, { offsets: { 'n-a': { x: 8, y: 16 } } });
    expect(lay.report.pinnedUnresolved).toEqual([]);
    expect(lay.report.explicit.map((e) => e.id)).toEqual(['n-a']);
    expect(lay.report.degraded.filter((d) => d.indexOf('E_PIN_NO_COORD') >= 0)).toEqual([]);
  });
});

describe('判别力：三条判据各自的靶子（删掉实现就必红）', () => {
  it('把 pinned 的 rect 挪 1px ⇒ ①的"逐值相等"必然红', () => {
    const doc = pinnedDoc();
    doc.nodes.forEach((n) => { if (n.id === 'n-b') n.rect = [601, 400, 208, 96]; });
    const lay = D.layoutOfDoc(doc);
    expect(lay.rects['n-b']).toEqual({ x: 601, y: 400, w: 208, h: 96 });
    expect(lay.rects['n-b']).not.toEqual({ x: 600, y: 400, w: 208, h: 96 });
  });

  it('把"不覆盖"的判据喂一个**确实相交**的对 ⇒ 同一个相交函数必须报 true', () => {
    expect(hits({ x: 0, y: 0, w: 100, h: 40 }, { x: 50, y: 20, w: 100, h: 40 })).toBe(true);
    expect(hits({ x: 0, y: 0, w: 100, h: 40 }, { x: 100, y: 0, w: 50, h: 40 })).toBe(false); // 相触不算
  });

  it('pinned 无坐标时若**不**报告 ⇒ ③必红（这里正向断言报告的非空性作为靶子）', () => {
    const doc = pinnedDoc();
    doc.graph.pinned = ['n-a'];
    const lay = D.layoutOfDoc(doc);
    expect(lay.report.pinnedUnresolved.length).toBe(1);
    expect(lay.report.pinnedUnresolved.length).not.toBe(0);           // 空数组会让上一条红
  });
});
