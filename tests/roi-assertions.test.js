/* ============================================================
 * tests/roi-assertions.test.js — L2「关键区域」视觉断言
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * L2 存在的理由是"**L1 抓不到的一类**"：整图是个有效帧（不黑不白），
 * 但某个关键区域是空白（导图没画出来、工具栏没渲染）。所以本文件最重要的一条断言是
 * **增量判别力**：把导图区涂白后，**只有那一条 ROI 变红，工具栏仍绿** ——
 * 若两条同红或同绿，L2 就没有存在价值。
 *
 * 全部用 fake ctx（假 exec + 假 NativeImage）验证 ⇒ **不需要 Electron**，任何机器可跑。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roi = require('../scripts/vision/roi-assertions.js');

const W = 40, H = 20;

/** 假 NativeImage：按 paint(x,y) 返回的三通道值填一张 BGRA 图。 */
function fakeImage(paint) {
  const b = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const c = paint(x, y);
      b[o] = c[0]; b[o + 1] = c[1]; b[o + 2] = c[2]; b[o + 3] = 255;
    }
  }
  return { toBitmap: () => b, getSize: () => ({ width: W, height: H }) };
}

/** 假 exec：返回指定的 ROI 矩形与 dpr。 */
const fakeExec = (rects, dpr) => async () => ({ rects, dpr: dpr === undefined ? 1 : dpr });

const RECTS_OK = {
  toolbar: { x: 0, y: 0, width: W, height: 6 },
  'mindmap-container': { x: 0, y: 6, width: W, height: 14 }
};

/** 有内容的图：每个像素都不同 ⇒ 任何区域都是"有效"的 */
const RICH = () => fakeImage((x, y) => [x * 6 % 256, (y * 12 + x) % 256, (x + y) % 256]);

describe('run()：条数与形态', () => {
  it('返回条数**恒等于** ROI 清单长度（阶段 5 靠这个数进真值）', async () => {
    const r = await roi.run({ exec: fakeExec(RECTS_OK), img: RICH() });
    expect(r.length).toBe(roi.ROIS.length);
    expect(r.every((x) => typeof x.name === 'string' && typeof x.ok === 'boolean')).toBe(true);
  });

  it('ROI 清单是数据驱动的（加一个区域只改清单）', () => {
    expect(Array.isArray(roi.ROIS)).toBe(true);
    expect(roi.ROIS.length).toBeGreaterThan(0);
    expect(roi.ROIS.every((r) => r.id && r.label)).toBe(true);
  });

  it('**#status-text 不在 ROI 里** —— 它被阶段 2 刻意清空，测它必然永远判红', () => {
    expect(roi.ROIS.some((r) => r.id === 'status-text')).toBe(false);
  });
});

describe('**增量判别力**（L2 的存在理由）', () => {
  it('把导图区涂白 ⇒ **只有导图区那条红，工具栏仍绿**', async () => {
    // 工具栏区域（y<6）保持有内容；导图区（y>=6）涂成纯白
    const img = fakeImage((x, y) => (y < 6 ? [x * 6 % 256, (y * 12 + x) % 256, (x + y) % 256] : [255, 255, 255]));
    const r = await roi.run({ exec: fakeExec(RECTS_OK), img });
    const byName = (kw) => r.find((x) => x.name.indexOf(kw) >= 0);
    expect(byName('工具栏').ok).toBe(true);
    expect(byName('导图区').ok).toBe(false);
    expect(byName('导图区').text).toMatch(/导图没画出来/);   // 报错要说清"这空了意味着什么"
  });

  it('反过来：工具栏涂白、导图区有内容 ⇒ 只有工具栏那条红', async () => {
    const img = fakeImage((x, y) => (y < 6 ? [255, 255, 255] : [x * 6 % 256, (y * 12 + x) % 256, (x + y) % 256]));
    const r = await roi.run({ exec: fakeExec(RECTS_OK), img });
    const byName = (kw) => r.find((x) => x.name.indexOf(kw) >= 0);
    expect(byName('工具栏').ok).toBe(false);
    expect(byName('导图区').ok).toBe(true);
  });

  it('整图全白（L1 也会红）时两条都红 —— 说明 L2 与 L1 不是替代关系而是叠加', async () => {
    const r = await roi.run({ exec: fakeExec(RECTS_OK), img: fakeImage(() => [255, 255, 255]) });
    expect(r.every((x) => !x.ok)).toBe(true);
  });
});

describe('采不到真值 = 红（不许跳过再宣称通过）', () => {
  it('某 ROI 取不到矩形（null）⇒ 该条红，且说明原因', async () => {
    const rects = { toolbar: RECTS_OK.toolbar, 'mindmap-container': null };
    const r = await roi.run({ exec: fakeExec(rects), img: RICH() });
    const mm = r.find((x) => x.name.indexOf('导图区') >= 0);
    expect(mm.ok).toBe(false);
    expect(mm.text).toMatch(/取不到可见矩形/);
  });

  it('渲染进程执行失败 ⇒ **全部** ROI 红（不是跳过）', async () => {
    const r = await roi.run({ exec: async () => { throw new Error('页面没加载好'); }, img: RICH() });
    expect(r.length).toBe(roi.ROIS.length);
    expect(r.every((x) => !x.ok)).toBe(true);
    expect(r[0].text).toMatch(/页面没加载好/);
  });

  it('ROI 统计失败（img 不可用）⇒ 该条红，不抛穿整个冒烟', async () => {
    const r = await roi.run({ exec: fakeExec(RECTS_OK), img: {} });
    expect(r.length).toBe(roi.ROIS.length);
    expect(r.every((x) => !x.ok)).toBe(true);
  });
});

describe('devicePixelRatio 缩放（截图是设备像素、rect 是 CSS 像素）', () => {
  it('dpr=2 时矩形被放大 2 倍（否则会测错区域）', async () => {
    const css = { toolbar: { x: 1, y: 1, width: 5, height: 3 }, 'mindmap-container': { x: 1, y: 5, width: 5, height: 10 } };
    const r = await roi.run({ exec: fakeExec(css, 2), img: RICH() });
    expect(r.length).toBe(roi.ROIS.length);
    expect(r.every((x) => x.text.indexOf('dpr=2') >= 0)).toBe(true);
  });
});
