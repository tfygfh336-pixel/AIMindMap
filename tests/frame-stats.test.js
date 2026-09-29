/* ============================================================
 * tests/frame-stats.test.js — 帧像素统计（视觉断言 L1/L2 的输入）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个模块是"AI 说画面没问题"的**机器依据**，所以它的统计口径错一点，
 * 判定就会静默偏掉。本文件锁住四件事：
 *   ① 统计量的定义（unique / mean / variance / range）；
 *   ② **对通道顺序不变** —— 这是本模块存在的核心理由。Electron 声明
 *      `toBitmap()` 的格式"**platform-dependent**"，所以按固定通道序读必然是错的赌注；
 *      旧实现用加权亮度 `0.299R+0.587G+0.114B` 对 R/B 互换**敏感**（本文件有断言证明），
 *      改成三通道均值后任何排列都不变。
 *   ③ `toBitmap()` 优先于 `getBitmap()`（后者自 Electron 44 起是已弃用别名）。
 *   ④ 阈值**单源**：判定函数不许自己写数字。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('../scripts/vision/frame-stats.js');
const TH = require('../scripts/vision/thresholds.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 造一个假 NativeImage（BGRA buffer）。`swap` 为真时交换 R/B 两通道。 */
function fakeImage(w, h, fill, swap) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const px = fill ? fill(i) : [10 + i * 7, 200 - i * 3, 50 + i * 11];
    b[o] = px[0]; b[o + 1] = px[1]; b[o + 2] = px[2]; b[o + 3] = 255;
  }
  if (swap) for (let i = 0; i < w * h; i++) { const o = i * 4; const t = b[o]; b[o] = b[o + 2]; b[o + 2] = t; }
  return { toBitmap: () => b, getSize: () => ({ width: w, height: h }) };
}

describe('analyzeFrame：统计量定义', () => {
  it('px / unique / mean / variance / range 都能算出来', () => {
    const s = fs.analyzeFrame(fakeImage(8, 2));
    expect(s.px).toBe(16);
    expect(s.n).toBe(16);
    expect(s.unique).toBe(16);                 // 每像素不同色
    expect(s.range).toBeGreaterThan(0);
    expect(s.variance).toBeGreaterThan(0);
  });

  it('纯色帧：unique=1、range=0（这正是 L1 要抓的黑屏/白屏）', () => {
    const s = fs.analyzeFrame(fakeImage(8, 2, () => [128, 128, 128]));
    expect(s.unique).toBe(1);
    expect(s.range).toBe(0);
    expect(s.variance).toBe(0);
  });

  it('空图（0 像素）安全，不抛异常', () => {
    const s = fs.analyzeFrame({ toBitmap: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) });
    expect(s.px).toBe(0);
    expect(s.unique).toBe(0);
  });
});

describe('**对通道顺序不变**（本模块存在的核心理由）', () => {
  it('交换 R/B 后 four 统计量完全相同', () => {
    const a = fs.analyzeFrame(fakeImage(8, 4, null, false));
    const b = fs.analyzeFrame(fakeImage(8, 4, null, true));
    expect(b.unique).toBe(a.unique);
    expect(b.mean).toBeCloseTo(a.mean, 10);
    expect(b.variance).toBeCloseTo(a.variance, 10);
    expect(b.range).toBeCloseTo(a.range, 10);
  });

  it('作为对照：旧的**加权亮度**公式对 R/B 互换是敏感的（所以旧口径不能留）', () => {
    const lum = (r, g, bl) => 0.299 * r + 0.587 * g + 0.114 * bl;
    expect(lum(10, 200, 50)).not.toBeCloseTo(lum(50, 200, 10), 3);
  });
});

describe('bitmapOf：优先 toBitmap（getBitmap 已弃用）', () => {
  it('有 toBitmap 就用它，不碰 getBitmap', () => {
    let used = null;
    const img = { toBitmap: () => { used = 'to'; return Buffer.alloc(4); }, getBitmap: () => { used = 'get'; return Buffer.alloc(4); } };
    fs.bitmapOf(img);
    expect(used).toBe('to');
  });

  it('只有 getBitmap 时才回退（兼容旧 Electron）', () => {
    let used = null;
    const img = { getBitmap: () => { used = 'get'; return Buffer.alloc(4); } };
    fs.bitmapOf(img);
    expect(used).toBe('get');
  });

  it('两者都没有 → 抛错（响亮，不静默返回空）', () => {
    expect(() => fs.bitmapOf({})).toThrow(/toBitmap|getBitmap/);
  });
});

describe('passValidFrame / passRegion：阈值单源', () => {
  it('黑屏判红、有内容的帧判绿', () => {
    const black = fs.analyzeFrame(fakeImage(8, 2, () => [0, 0, 0]));
    expect(fs.passValidFrame(black).ok).toBe(false);
    const rich = fs.analyzeFrame(fakeImage(8, 2));
    expect(fs.passValidFrame(rich).ok).toBe(true);
  });

  it('判定不自己写数字：改单源阈值即改判定（证明它真的读了单源）', () => {
    const rich = fs.analyzeFrame(fakeImage(8, 2));
    expect(fs.passValidFrame(rich).ok).toBe(true);
    expect(fs.passValidFrame(rich, { minUnique: 9999, minRange: 9999, minVariance: 9999 }).ok).toBe(false);
  });

  it('单源文件导出的阈值就是判定用的那一套', () => {
    expect(TH.validFrame).toMatchObject({ minUnique: 8, minRange: 40, minVariance: 4 });
    expect(TH.roi).toMatchObject({ minUnique: 4, minRange: 24, minVariance: 2 });
    expect(TH.sampleCap).toBeGreaterThan(0);
  });
});

describe('analyzeRegion：ROI 裁剪与越界钳制', () => {
  it('裁剪出正确的矩形，且统计只覆盖该区域', () => {
    const img = fakeImage(8, 4);
    const r = fs.analyzeRegion(img, { x: 1, y: 0, width: 3, height: 2 });
    expect(r.rect).toEqual({ x: 1, y: 0, width: 3, height: 2 });
    expect(r.px).toBe(6);
    expect(r.n).toBeGreaterThan(0);
  });

  it('越界矩形被钳制在图像内（不抛异常、不出负宽高）', () => {
    const r = fs.analyzeRegion(fakeImage(8, 4), { x: -5, y: -5, width: 999, height: 999 });
    expect(r.rect.width).toBeLessThanOrEqual(8);
    expect(r.rect.height).toBeLessThanOrEqual(4);
    expect(r.rect.x).toBeGreaterThanOrEqual(0);
  });

  it('区域全白 ⇒ passRegion 判红（这正是 L2 要抓的"整图有效但关键区空白"）', () => {
    const img = fakeImage(8, 4, () => [255, 255, 255]);
    const r = fs.analyzeRegion(img, { x: 0, y: 0, width: 8, height: 4 });
    expect(fs.passRegion(r).ok).toBe(false);
  });
});
