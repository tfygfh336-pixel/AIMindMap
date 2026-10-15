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

/* ------------------------------------------------------------
 * 真输入域用的像素判据（`bitmapInfo` / `isAccentBlue` / `scanRegion`）
 * —— `scripts/smoke/36-real-input.js` 的"描边真的画出来了 / 大虚线框真的没画"全靠它们。
 * 这里锁三件事：① 通道序无关（与文件头那条契约一致）；② 区域/挖除/连续长度的口径；
 * ③ **采不到真值必须能被看见**（位图与 getSize 不一致 ⇒ ok:false，绝不许按猜的尺寸数像素 ✗）。
 * ------------------------------------------------------------ */
describe('真输入域的像素判据：scanRegion / isAccentBlue', () => {
  /** 造一张"全白 + 一个指定颜色的矩形块"的图（块用 compare 里的颜色） */
  const blockImage = (w, h, block, color) => fakeImage(w, h, (i) => {
    const x = i % w, y = Math.floor(i / w);
    const inside = x >= block.x && x < block.x + block.width && y >= block.y && y < block.y + block.height;
    return inside ? color : [255, 255, 255];
  });

  it('强调蓝 #1664ff：**任何通道排列**都命中（这是本模块对通道序的承诺 ✓）', () => {
    const blue = [22, 100, 255];                     // #1664ff
    const perms = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1]];
    for (const p of perms) {
      expect(fs.isAccentBlue(blue[p[0]], blue[p[1]], blue[p[2]])).toBe(true);
    }
  });

  it('白 / 浅灰 / 纯红 / 浅蓝底纹（大框的 6% 底色）都不算"描边蓝"', () => {
    expect(fs.isAccentBlue(255, 255, 255)).toBe(false);
    expect(fs.isAccentBlue(128, 128, 128)).toBe(false);
    expect(fs.isAccentBlue(255, 0, 0)).toBe(false);          // 纯红：min/max 与蓝一样极端 ⇒ 靠 mid 分辨 ✓
    expect(fs.isAccentBlue(20, 20, 20)).toBe(false);
    expect(fs.isAccentBlue(241, 246, 255)).toBe(false);      // rgba(22,100,255,.06) 铺在白底上的实测值
  });

  it('scanRegion：只数区域内的命中像素，并给出单行最长连续段', () => {
    const img = blockImage(20, 8, { x: 5, y: 2, width: 6, height: 2 }, [22, 100, 255]);
    const s = fs.scanRegion(img, { x: 0, y: 0, width: 20, height: 8 });
    expect(s.ok).toBe(true);
    expect(s.hits).toBe(6 * 2);            // 6x2 的块
    expect(s.longestRun).toBe(6);          // 单行连续 6px
    expect(s.rect).toEqual({ x: 0, y: 0, width: 20, height: 8 });
  });

  it('scanRegion：exclude 把浮层那块挖掉（工具条上的蓝按钮不许混进"描边"计数）', () => {
    const img = blockImage(20, 8, { x: 5, y: 2, width: 6, height: 2 }, [22, 100, 255]);
    const withoutExclude = fs.scanRegion(img, { x: 0, y: 0, width: 20, height: 8 });
    const withExclude = fs.scanRegion(img, { x: 0, y: 0, width: 20, height: 8 },
      { exclude: [{ x: 5, y: 0, width: 20, height: 8 }] });
    expect(withoutExclude.hits).toBe(12);
    expect(withExclude.hits).toBe(0);
  });

  it('scanRegion：越界的矩形被钳制（不抛异常、也不越界读）', () => {
    const img = blockImage(20, 8, { x: 0, y: 0, width: 20, height: 8 }, [22, 100, 255]);
    const s = fs.scanRegion(img, { x: -5, y: -5, width: 999, height: 999 });
    expect(s.ok).toBe(true);
    expect(s.rect.width).toBe(20);
    expect(s.rect.height).toBe(8);
    expect(s.hits).toBe(20 * 8);
  });

  it('★ 采不到真值 = ok:false（位图长度与 getSize 对不上 ⇒ 不许按猜的尺寸继续判）', () => {
    const bad = { toBitmap: () => Buffer.alloc(4 * 3 * 4), getSize: () => ({ width: 10, height: 10 }) };
    const info = fs.bitmapInfo(bad);
    expect(info.ok).toBe(false);
    const s = fs.scanRegion(bad, { x: 0, y: 0, width: 2, height: 2 });
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/不一致/);
  });

  it('bitmapInfo：正常图 ok:true，并把尺寸与像素数一起给出', () => {
    const info = fs.bitmapInfo(fakeImage(4, 3));
    expect(info.ok).toBe(true);
    expect(info.width).toBe(4);
    expect(info.height).toBe(3);
    expect(info.px).toBe(12);
    expect(info.expected).toBe(12);
  });

  it('单源阈值：判定用的 dashStroke 就在 thresholds.js（本文件不写数字）', () => {
    // 大框判据三键（2026-10-16 换口径，理由见 `scripts/smoke/36-real-input.js` 的 `boxPixelDiff`）：
    //  · `boxDiffTol` = "这一像素变了"的强差分门槛（挡掉大框那片 6% 底色，只认 2px 虚线描边）
    //  · `maxBoxDrift` = 产品判据（当前状态 vs 已知无框参照，必须 ≈ 0）
    //  · `minBoxSig` = 判据自检（强制画框时这条判据必须看得见；**必须 > maxBoxDrift**，否则它分不出两态）
    // `maxRingHits` = 「描边那一圈掉干净了」的判据（域 36 ③⑤；原名叫 maxBoxHits，名字与用途不符已改名）
    expect(TH.dashStroke).toMatchObject({ minHits: 20, maxRun: 24, maxRingHits: 24,
      boxDiffTol: 40, maxBoxDrift: 12, minBoxSig: 60 });
    expect(TH.dashStroke.minBoxSig).toBeGreaterThan(TH.dashStroke.maxBoxDrift);   // 两档是一把尺子，不是两个孤立数字
    // 传别的阈值即改判定 ⇒ 证明它真的读了单源 ✓
    expect(fs.isAccentBlue(22, 100, 255, { minMax: 300, maxMin: 0, minMid: 0, maxMid: 300 })).toBe(false);
  });
});
