/* ============================================================
 * tests/smoke-select.test.js —— 冒烟「单跑」选择器单测（vitest）
 * ------------------------------------------------------------
 * 选择器是纯函数（scripts/smoke-select.js，不碰文件系统、不 require Electron），
 * 所以这里能直接 require 它 —— 这正是"门禁/工具必须可单测"那条纪律的落地。
 *
 * 重点不是"能选中"，而是**选不中时会不会静默放过**：
 * 一个筛错名字却跑出 "0/0 passed" 的选择器，是本工程最怕的那种"没做，却看不出没做"。
 * 所以下面第 2 条是判别力注入：故意给一个不存在的名字，必须**抛错**而不是返回空集。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const select = require(path.join(ROOT, 'scripts', 'smoke-select.js'));

const FILES = ['01-core.js', '05-pan-lock.js', '19-layout-anchor.js', '20-preview-buttons.js', '21-sidebar-first-paint.js'];

describe('冒烟单跑选择器', () => {
  it('空选择串 = 全量（原样返回，且不改变顺序）', () => {
    expect(select.parseSpec('')).toBe(null);
    expect(select.parseSpec('   ')).toBe(null);
    expect(select.parseSpec(undefined)).toBe(null);
    expect(select.selectFiles(FILES, '')).toEqual(FILES);
  });

  it('判别力注入：选择串一项都不匹配时必须抛错（不许返回空集）', () => {
    expect(() => select.selectFiles(FILES, 'zz-no-such-file')).toThrow(/没匹配到任何断言文件/);
    // 多项里只要有一项落空 ⇒ 也抛错（否则"我以为跑了 20 和 21，其实只跑了 20"）
    expect(() => select.selectFiles(FILES, '20,zz-no-such')).toThrow(/zz-no-such/);
  });

  it('按前缀选中，并**永远并入 01-***（预热：它负责加载渲染层并打开 comnet）', () => {
    expect(select.selectFiles(FILES, '20')).toEqual(['01-core.js', '20-preview-buttons.js']);
    expect(select.selectFiles(FILES, '19-layout')).toEqual(['01-core.js', '19-layout-anchor.js']);
    // 多选：逗号分隔、去空白、保持**原文件顺序**
    expect(select.selectFiles(FILES, ' 21 , 05 ')).toEqual(['01-core.js', '05-pan-lock.js', '21-sidebar-first-paint.js']);
  });

  it('真工程：选中的文件确实存在，且真值是"全量条数"而不是"选中条数"', () => {
    const smokeDir = path.join(ROOT, 'scripts', 'smoke');
    const real = fs.readdirSync(smokeDir).filter((f) => /^\d+-.+\.js$/.test(f)).sort();
    const picked = select.selectFiles(real, '20');
    expect(picked.length).toBeGreaterThan(0);
    picked.forEach((f) => expect(fs.existsSync(path.join(smokeDir, f))).toBe(true));
    // 全量条数（docs/VERIFY.md 的冒烟真值来源）必须等于全部文件拼起来，与单跑无关
    const all = require(path.join(ROOT, 'scripts', 'smoke-assertions.js'));
    expect(all.length).toBeGreaterThan(0);
    expect(all.files).toEqual(real);
    expect(typeof all.groups).toBe('object');
  });
});
