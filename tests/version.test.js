/* ============================================================
 * tests/version.test.js — 版本号纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * 下沉自 cli/commands/release.js。重点覆盖两个曾经的实际错误：
 *   1) --minor 不把 patch 归零（0.14.3 → 0.15.3，应为 0.15.0）
 *   2) 完全没有 --major
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import version from '../src/version.js';

const { isValid, parse, bump, compare } = version;

describe('version.isValid', () => {
  it('接受 x.y.z，拒绝其余形式', () => {
    expect(isValid('1.2.3')).toBe(true);
    expect(isValid('0.0.0')).toBe(true);
    expect(isValid('1.2')).toBe(false);
    expect(isValid('v1.2.3')).toBe(false);
    expect(isValid('1.2.3-beta')).toBe(false);
    expect(isValid('')).toBe(false);
    expect(isValid(null)).toBe(false);
    expect(isValid(undefined)).toBe(false);
  });
});

describe('version.parse', () => {
  it('拆出三段数字', () => {
    expect(parse('0.14.0')).toEqual({ major: 0, minor: 14, patch: 0 });
    expect(parse(' 10.20.30 ')).toEqual({ major: 10, minor: 20, patch: 30 });
  });
  it('非法返回 null', () => {
    expect(parse('x')).toBeNull();
    expect(parse('1.2')).toBeNull();
  });
});

describe('version.bump', () => {
  it('patch 递增', () => {
    expect(bump('0.14.0', 'patch')).toBe('0.14.1');
    expect(bump('1.2.9', 'patch')).toBe('1.2.10');
  });

  it('minor 递增并把 patch 归零（此前是 0.14.3 → 0.15.3 的错误）', () => {
    expect(bump('0.14.3', 'minor')).toBe('0.15.0');
    expect(bump('0.14.0', 'minor')).toBe('0.15.0');
  });

  it('major 递增并把 minor/patch 归零（此前完全不支持）', () => {
    expect(bump('0.14.3', 'major')).toBe('1.0.0');
    expect(bump('1.2.3', 'major')).toBe('2.0.0');
  });

  it('kind 缺省或非法时按 patch 处理', () => {
    expect(bump('0.14.0')).toBe('0.14.1');
    expect(bump('0.14.0', 'nonsense')).toBe('0.14.1');
  });

  it('入参非法返回 null（不抛异常，由调用方决定如何报错）', () => {
    expect(bump('not-a-version', 'minor')).toBeNull();
    expect(bump('1.2', 'patch')).toBeNull();
    expect(bump(null, 'patch')).toBeNull();
  });
});

describe('version.compare', () => {
  it('逐段比较', () => {
    expect(compare('0.14.0', '0.14.0')).toBe(0);
    expect(compare('0.14.1', '0.14.0')).toBe(1);
    expect(compare('0.14.0', '0.15.0')).toBe(-1);
    expect(compare('1.0.0', '0.99.99')).toBe(1);
    expect(compare('0.9.0', '0.10.0')).toBe(-1);   // 数值比较，不是字符串比较
  });
  it('任一非法返回 null', () => {
    expect(compare('1.0.0', 'x')).toBeNull();
    expect(compare(null, '1.0.0')).toBeNull();
  });
});
