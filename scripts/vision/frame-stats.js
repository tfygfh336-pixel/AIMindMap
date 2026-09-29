/* ============================================================
 * scripts/vision/frame-stats.js — 帧像素统计（**唯一实现**）
 * ------------------------------------------------------------
 * **存在的唯一理由**：原先像素统计内联在 `scripts/smoke/14-headless-window.js` 里，
 * 而当时另一份参考实现里**另有一份**。
 * 两份对同一个 Buffer 的**通道解读相反**（本工程按 `R,G,B` 读，那份按 `B,G,R` 读），
 * 而 **Electron 自己说这个格式是平台相关的**：
 *
 *   `electron.d.ts` → `createFromBitmap()`:
 *   "…raw bitmap pixel data returned by `toBitmap()`. **The specific format is platform-dependent.**"
 *
 * ⇒ 所以"哪一份对"**没有可依赖的答案**，而**依赖通道身份本身就是设计缺陷**：
 * 一旦将来有人写"判断这个区域是不是红的"这类断言，就会在一个未定义的假设上做判定。
 *
 * **本模块的解法：让统计量与通道顺序无关。**
 *   · `unique` —— 去重色数的**计数**。任何通道排列都是双射 ⇒ **计数不变**（只用 `.size`，不用打包值）。
 *   · `mean` / `variance` / `range` —— 改用**三通道均值**（`(c0+c1+c2)/3`）而不是加权亮度。
 *     原先用 `0.299r+0.587g+0.114b`：那个权重**对 R/B 互换是敏感的**（0.299 vs 0.114），
 *     于是"读错通道序"会**静默改变判定输入**。改成三通道均值后，权重相等 ⇒ 对任何排列都不变。
 *
 * ⚠️ 这是**与「按固定通道序读」的有意偏离**（常见参考实现硬编 BGRA）。偏离理由已在上面写清；
 * 回归到"按某个固定通道序读"就等于把这个坑重新埋回去。
 *
 * ⚠️ 一个必须承认的代价：换成三通道均值后，`mean/variance/range` 的**数值会与旧实现有差异**。
 * 判断它是否安全：旧阈值是 `range>40 / variance>4`，而实测真实帧 `range≈225 / variance≈4000`
 * —— **差一两个数量级**，所以不构成误判风险。若将来阈值收紧到接近实测值，必须重新标定。
 * ============================================================ */
'use strict';

const THRESHOLDS = require('./thresholds.js');

/**
 * 取 NativeImage 的原始位图 Buffer。
 * 优先 `toBitmap()`：`getBitmap()` 自 Electron 44 起是**已弃用的别名**（`electron.d.ts`：
 * "Legacy alias for `image.toBitmap()`"），继续用它会在每次冒烟打 DeprecationWarning。
 */
function bitmapOf(img) {
  if (!img) throw new TypeError('frame-stats: 需要一个 NativeImage');
  const fn = typeof img.toBitmap === 'function' ? img.toBitmap : img.getBitmap;
  if (typeof fn !== 'function') throw new TypeError('frame-stats: 该对象既无 toBitmap 也无 getBitmap');
  return fn.call(img);
}

/**
 * 像素统计。**与通道顺序无关**（见文件头）。
 * @param {object} img NativeImage
 * @param {{cap?:number}} [opts]
 * @returns {{px:number, unique:number, mean:number, variance:number, range:number, n:number, sampled:boolean}}
 */
function analyzeFrame(img, opts) {
  const bmp = bitmapOf(img);
  const px = Math.floor(bmp.length / 4);
  const cap = (opts && opts.cap) || THRESHOLDS.sampleCap;
  if (!px) return { px: 0, unique: 0, mean: 0, variance: 0, range: 0, n: 0, sampled: false };
  const step = Math.max(1, Math.floor(px / cap));
  const seen = new Set();
  let sum = 0, sumSq = 0, min = 255, max = 0, n = 0;
  for (let i = 0; i < px; i += step) {
    const o = i * 4;
    const c0 = bmp[o], c1 = bmp[o + 1], c2 = bmp[o + 2];
    // 打包值只用于**去重计数**；通道语义不参与任何判定（见文件头）
    seen.add((c0 << 16) | (c1 << 8) | c2);
    const v = (c0 + c1 + c2) / 3;          // ← 三通道均值：对任何通道排列都不变
    sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    n++;
  }
  const mean = n ? sum / n : 0;
  return {
    px, unique: seen.size, mean,
    variance: n ? (sumSq / n) - mean * mean : 0,
    range: max - min,
    n,
    sampled: step > 1
  };
}

/** L1 判定：整图是否"有效帧"（非空、非纯色）。阈值取单源。 */
function passValidFrame(stats, th) {
  const t = th || THRESHOLDS.validFrame;
  return {
    ok: !!stats && stats.px > 0 && stats.unique > t.minUnique
      && stats.range > t.minRange && stats.variance > t.minVariance,
    text: 'px=' + (stats ? stats.px : 0) + ' unique=' + (stats ? stats.unique : 0)
      + ' range=' + (stats ? stats.range.toFixed(1) : 0)
      + ' variance=' + (stats ? stats.variance.toFixed(1) : 0)
      + '（阈值 unique>' + t.minUnique + ' range>' + t.minRange + ' variance>' + t.minVariance + '）'
  };
}

/**
 * L2 判定：**区域**（ROI）是否有效。与 L1 同一套统计量，只是作用在裁剪出的矩形上。
 * @param {object} img NativeImage
 * @param {{x:number,y:number,width:number,height:number}} rect 设备像素坐标
 */
function analyzeRegion(img, rect, opts) {
  const bmp = bitmapOf(img);
  const size = typeof img.getSize === 'function' ? img.getSize() : null;
  if (!size || !size.width || !size.height) {
    throw new TypeError('frame-stats: 取不到图像尺寸（需要 NativeImage）');
  }
  const W = size.width, H = size.height;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(rect.y)));
  const x1 = Math.max(x0 + 1, Math.min(W, Math.floor(rect.x + rect.width)));
  const y1 = Math.max(y0 + 1, Math.min(H, Math.floor(rect.y + rect.height)));
  const cap = (opts && opts.cap) || THRESHOLDS.sampleCap;
  const total = (x1 - x0) * (y1 - y0);
  const step = Math.max(1, Math.floor(total / cap));
  const seen = new Set();
  let sum = 0, sumSq = 0, min = 255, max = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (((y - y0) * (x1 - x0) + (x - x0)) % step) continue;
      const o = (y * W + x) * 4;
      const c0 = bmp[o], c1 = bmp[o + 1], c2 = bmp[o + 2];
      seen.add((c0 << 16) | (c1 << 8) | c2);
      const v = (c0 + c1 + c2) / 3;
      sum += v; sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  return {
    px: (x1 - x0) * (y1 - y0), unique: seen.size, mean,
    variance: n ? (sumSq / n) - mean * mean : 0,
    range: n ? max - min : 0, n, sampled: step > 1, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  };
}

/** L2 判定：区域是否"有效"（非空、非纯色），阈值取单源 `roi`。 */
function passRegion(stats, th) {
  const t = th || THRESHOLDS.roi;
  return {
    ok: !!stats && stats.px > 0 && stats.unique > t.minUnique
      && stats.range > t.minRange && stats.variance > t.minVariance,
    text: 'rect=' + (stats && stats.rect ? JSON.stringify(stats.rect) : '-')
      + ' unique=' + (stats ? stats.unique : 0)
      + ' range=' + (stats ? stats.range.toFixed(1) : 0)
      + ' variance=' + (stats ? stats.variance.toFixed(1) : 0)
      + '（ROI 阈值 unique>' + t.minUnique + ' range>' + t.minRange + ' variance>' + t.minVariance + '）'
  };
}

module.exports = { THRESHOLDS, bitmapOf, analyzeFrame, passValidFrame, analyzeRegion, passRegion };
