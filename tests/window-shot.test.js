/* ============================================================
 * tests/window-shot.test.js —— 整窗截图合成单测（vitest）
 * ------------------------------------------------------------
 * 合成本身是纯像素搬运（scripts/vision/window-shot.js），所以能被单测直接 require。
 * 为什么值得测：它是"能不能看到侧栏"的唯一离线手段 —— 贴错位置/裁错边界，
 * 出来的图会**看起来正常**但内容错位（正是本工程最怕的"没做，却看不出没做"）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { composeWindowShot } = require(path.resolve(__dirname, '..', 'scripts', 'vision', 'window-shot.js'));

/** 造一张纯色位图（BGRA） */
function solid(w, h, b, g, r, a = 255) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = b; px[i * 4 + 1] = g; px[i * 4 + 2] = r; px[i * 4 + 3] = a;
  }
  return { width: w, height: h, pixels: px };
}
const at = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
};

describe('整窗截图合成', () => {
  it('把侧栏贴到指定位置，其余像素保持主页面原样', () => {
    const base = solid(6, 3, 255, 255, 255);        // 白
    const sb = solid(2, 3, 0, 0, 255);              // 红
    const out = composeWindowShot(base, sb, { x: 4, y: 0 });
    expect([out.width, out.height]).toEqual([6, 3]);
    expect(at(out, 0, 0)).toEqual([255, 255, 255]);  // 左侧仍是主页面
    expect(at(out, 4, 0)).toEqual([0, 0, 255]);      // 贴上的侧栏
    expect(at(out, 5, 2)).toEqual([0, 0, 255]);
  });

  it('越界部分被裁剪，不报错也不越写', () => {
    const base = solid(4, 2, 255, 255, 255);
    const sb = solid(3, 2, 0, 0, 255);
    const out = composeWindowShot(base, sb, { x: 3, y: 0 });   // 只有 1 列放得下
    expect(at(out, 2, 0)).toEqual([255, 255, 255]);
    expect(at(out, 3, 0)).toEqual([0, 0, 255]);
  });

  it('没有侧栏截图时原样返回主页面（拿不到侧栏不算失败）', () => {
    const base = solid(3, 2, 10, 20, 30);
    const out = composeWindowShot(base, null, { x: 0, y: 0 });
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(at(out, 0, 0)).toEqual([10, 20, 30]);
  });

  it('主页面不可用时不抛异常（调用方自己决定是否算失败）', () => {
    expect(composeWindowShot(null, solid(1, 1, 1, 1, 1), { x: 0, y: 0 })).toBe(null);
  });
});
