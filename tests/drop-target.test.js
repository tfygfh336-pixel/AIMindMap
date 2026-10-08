/* ============================================================
 * tests/drop-target.test.js — P7 落点判定的单测（四类边界 ✓）
 * 这些用例就是"判别力证明"的载体 ✓：把 isPointInSidebar 改成恒真，
 * 第 2、3、4 组会立刻红 ✓（而不是"跑过了"就算 ✓）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPointInSidebar, isPointInRect, toScreenRect } = require('../src/drop-target.js');

// 典型几何：窗口在屏幕 (100, 50)，宽 1400；侧栏视图在窗口内的 x=980、宽 420、高 800
const WIN = { x: 100, y: 50 };
const VIEW = { x: 980, y: 0, width: 420, height: 800 };

describe('P7 落点判定：窗口偏移换算', () => {
  it('窗口内矩形 + 窗口原点 = 屏幕矩形', () => {
    expect(toScreenRect(VIEW, WIN)).toEqual({ x: 1080, y: 50, width: 420, height: 800 });
  });

  it('点在侧栏内（屏幕坐标）⇒ true', () => {
    expect(isPointInSidebar({ x: 1200, y: 400 }, WIN, VIEW)).toBe(true);
  });

  it('忽略窗口偏移就会判错 —— 用窗口内坐标直接判必须为 false（防"忘了换算"✗）', () => {
    expect(isPointInSidebar({ x: 1000, y: 400 }, WIN, VIEW)).toBe(false);
  });
});

describe('P7 落点判定：边界情形', () => {
  it('左边界：正好在 x=1080 ⇒ 算命中；左边界外侧 1px（1079）⇒ 不算 ✓', () => {
    expect(isPointInSidebar({ x: 1080, y: 100 }, WIN, VIEW)).toBe(true);
    expect(isPointInSidebar({ x: 1079, y: 100 }, WIN, VIEW)).toBe(false);
  });

  it('右边界：x = 1080+420 ⇒ 算外面（左闭右开 ✓，避免和"侧栏右边的空白"混为一谈）', () => {
    expect(isPointInSidebar({ x: 1500, y: 100 }, WIN, VIEW)).toBe(false);
    expect(isPointInSidebar({ x: 1499, y: 100 }, WIN, VIEW)).toBe(true);
  });

  it('上边界：y=50 命中、y=49 不命中 ✓', () => {
    expect(isPointInSidebar({ x: 1200, y: 50 }, WIN, VIEW)).toBe(true);
    expect(isPointInSidebar({ x: 1200, y: 49 }, WIN, VIEW)).toBe(false);
  });
});

describe('P7 落点判定：侧栏不存在时的退化', () => {
  it('侧栏没打开（view=null）⇒ 永远 false ✓（此时不该投喂）', () => {
    expect(isPointInSidebar({ x: 1200, y: 400 }, WIN, null)).toBe(false);
  });

  it('侧栏宽度为 0（收起）⇒ false ✓（零宽矩形不算命中）', () => {
    expect(isPointInSidebar({ x: 1200, y: 400 }, WIN, { x: 980, y: 0, width: 0, height: 800 })).toBe(false);
    expect(toScreenRect({ x: 980, y: 0, width: 0, height: 800 }, WIN)).toBe(null);
  });

  it('窗口原点缺失或坐标非数字 ⇒ false ✓（不抛异常，静默退化但**不误判**）', () => {
    expect(isPointInSidebar({ x: 1200, y: 400 }, null, VIEW)).toBe(false);
    expect(isPointInSidebar({ x: NaN, y: 400 }, WIN, VIEW)).toBe(false);
  });
});

describe('P7 落点判定：基础矩形工具', () => {
  it('isPointInRect 对 null 入参返回 false（不抛）✓', () => {
    expect(isPointInRect(null, null)).toBe(false);
    expect(isPointInRect({ x: 1, y: 1 }, null)).toBe(false);
  });
});
