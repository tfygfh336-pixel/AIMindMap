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

/* ============================================================
 * 以下三件是**真输入域**（`scripts/smoke/36-real-input.js`）用的：从帧里读出
 * "某个描边**真的画出来了** / 那个大虚线框**真的没画**"这类**像素级判据**。
 *
 * 与上面 L1/L2 的分工：L1/L2 只回答"这块区域是不是有效帧（非空、非纯色）"，
 * 它**回答不了**"这块区域里有没有那条虚线" —— 注入一次"描边透明"就能证明
 * （DOM 类名与 `getComputedStyle` 全都正常，只有像素没了 ✓）。
 *
 * 两条纪律照旧：**采不到真值 = 红**（`scanRegion` 返回 `ok:false` 而不是一个猜出来的尺寸）；
 * **阈值单源**（`thresholds.js` 的 `dashStroke`，本文件不写数字）。
 * ============================================================ */

/**
 * 位图几何真值：`getSize()` 与位图长度**互相校验**（两者不一致说明"我按错的尺寸在数像素"⇒ 必须能被看见 ✗）。
 * @param {object} img NativeImage
 * @returns {{bmp:Buffer, width:number, height:number, px:number, ok:boolean, expected:number}}
 */
function bitmapInfo(img) {
  const bmp = bitmapOf(img);
  const size = typeof img.getSize === 'function' ? img.getSize() : null;
  const width = size && size.width ? size.width : 0;
  const height = size && size.height ? size.height : 0;
  const px = Math.floor(bmp.length / 4);
  const expected = width * height;
  return { bmp: bmp, width: width, height: height, px: px, expected: expected, ok: px > 0 && expected === px };
}

/** 通道序无关的「高饱和强调蓝」判据（见 `thresholds.js` 的 `dashStroke` 与理由）。
 *  只对排序后的 (min, mid, max) 判 ⇒ 对任何通道排列都一样 ✓ */
function isAccentBlue(c0, c1, c2, th) {
  const t = th || THRESHOLDS.dashStroke;
  const lo = Math.min(c0, c1, c2);
  const hi = Math.max(c0, c1, c2);
  const mid = (c0 + c1 + c2) - lo - hi;
  return hi >= t.minMax && lo <= t.maxMin && mid >= t.minMid && mid <= t.maxMid;
}

/**
 * 扫一个矩形区域，数"命中判据"的像素（**全量扫描，不采样**：2px 宽的描边会被采样整条漏掉 ✗）。
 * @param {object} img NativeImage
 * @param {{x:number,y:number,width:number,height:number}} rect 设备像素坐标
 * @param {{predicate?:Function, exclude?:Array<object>, th?:object}} [opts]
 *   `exclude`：要从统计里**挖掉**的矩形（用来排除浮层：工具条上的蓝色按钮、详情框…）
 * @returns {{ok:boolean, hits:number, longestRun:number, rowsWithHits:number, px:number, rect?:object, reason?:string}}
 *   `longestRun` = 单行里连续命中像素的最大长度（"虚线"是短段、"实心大边框/整条色带"是长段 —— 用它分辨）
 */
function scanRegion(img, rect, opts) {
  const o = opts || {};
  const info = bitmapInfo(img);
  if (!info.ok) {
    return {
      ok: false, hits: 0, longestRun: 0, rowsWithHits: 0, px: 0,
      reason: '位图与 getSize 不一致（位图 ' + info.px + ' px vs ' + info.width + 'x' + info.height
        + ' = ' + info.expected + ' px）⇒ 采不到真值，不能按猜出来的尺寸数像素'
    };
  }
  const W = info.width, H = info.height;
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const x0 = clampI(Math.floor(rect.x), 0, W - 1);
  const y0 = clampI(Math.floor(rect.y), 0, H - 1);
  const x1 = clampI(Math.floor(rect.x + rect.width), x0 + 1, W);
  const y1 = clampI(Math.floor(rect.y + rect.height), y0 + 1, H);
  const pred = typeof o.predicate === 'function' ? o.predicate : ((a, b, c) => isAccentBlue(a, b, c, o.th));
  const ex = (o.exclude || []).map((r) => (r ? {
    x0: Math.floor(r.x), y0: Math.floor(r.y),
    x1: Math.floor(r.x + r.width), y1: Math.floor(r.y + r.height)
  } : null)).filter(Boolean);
  const excluded = (x, y) => ex.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);

  let hits = 0, longestRun = 0, rowsWithHits = 0, px = 0;
  for (let y = y0; y < y1; y++) {
    let run = 0, rowHits = 0;
    for (let x = x0; x < x1; x++) {
      if (excluded(x, y)) { run = 0; continue; }
      px++;
      const off = (y * W + x) * 4;
      if (pred(info.bmp[off], info.bmp[off + 1], info.bmp[off + 2])) {
        hits++; rowHits++; run++;
        if (run > longestRun) longestRun = run;
      } else run = 0;
    }
    if (rowHits) rowsWithHits++;
  }
  return { ok: true, hits: hits, longestRun: longestRun, rowsWithHits: rowsWithHits, px: px,
    rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

module.exports = {
  THRESHOLDS, bitmapOf, analyzeFrame, passValidFrame, analyzeRegion, passRegion,
  bitmapInfo, isAccentBlue, scanRegion
};
