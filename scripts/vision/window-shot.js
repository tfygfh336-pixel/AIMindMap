/* ============================================================
 * scripts/vision/window-shot.js —— 整窗截图合成（**纯函数**，可单测）
 * ------------------------------------------------------------
 * 由来：侧栏是原生 `WebContentsView`，`capturePage()` 只截**页面** ⇒ 截图里永远没有侧栏 ✗。
 * 用户问"截图不能截大一点 / 自适应吗"，更本质的需求是：**要一张能看到全部东西的图**。
 * 做法：分别截「主页面」与「侧栏 view」，再按侧栏的真实 `getBounds()` 把后者贴进前者，
 * 尺寸取**窗口内容的实际大小**（自适应，不写死 1424×795）。
 *
 * 纯函数边界：出入都是 `{ width, height, pixels }`（BGRA，与 Electron `nativeImage.getBitmap()` 同格式），
 * 所以本文件**不 require electron**，能被 vitest 直接测（合成本身是纯像素搬运，值得有单测）。
 * ============================================================ */
'use strict';

/** 校验一个位图描述是否可用 */
function okBitmap(b) {
  return !!b && b.width > 0 && b.height > 0
    && b.pixels && b.pixels.length >= b.width * b.height * 4;
}

/**
 * 把 overlay 贴到 base 上（左上角在 (at.x, at.y)），返回新的 `{width,height,pixels}`。
 * 越界部分**裁剪**，不报错（真实场景：侧栏可能正好铺到右缘）。
 * 都不合法时返回 base（调用方自己决定是否算失败）。
 */
function composeWindowShot(base, overlay, at) {
  if (!okBitmap(base)) return base;
  const out = Buffer.alloc(base.width * base.height * 4);
  base.pixels.copy(out, 0, 0, out.length);
  if (!okBitmap(overlay)) return { width: base.width, height: base.height, pixels: out };
  const x0 = Math.max(0, Math.round(at && at.x ? at.x : 0));
  const y0 = Math.max(0, Math.round(at && at.y ? at.y : 0));
  const w = Math.min(overlay.width, base.width - x0);
  const h = Math.min(overlay.height, base.height - y0);
  for (let row = 0; row < h; row++) {
    const src = row * overlay.width * 4;
    const dst = ((y0 + row) * base.width + x0) * 4;
    overlay.pixels.copy(out, dst, src, src + w * 4);
  }
  return { width: base.width, height: base.height, pixels: out };
}

module.exports = { composeWindowShot };
