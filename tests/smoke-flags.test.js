/* ============================================================
 * tests/smoke-flags.test.js — 冒烟保帧开关的纯函数契约与**接线检查**
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它：
 *   ① 开关清单本身要稳定（改动了要有测试说话，不能靠注释）；
 *   ② **接线**要有人守：这些开关只在 `--smoke` 路径加。若有人把守卫去掉、
 *      改成"永远加"，真实用户进程的功耗与后台行为就被改了 —— 而**没有任何
 *      运行期断言会变红**（冒烟里加着开关，正常启动没人测）。这正是本工程
 *      反复修过的「没做/做错了，却看不出」同型，故照 tests/verify-budget.test.js
 *      对 `RULES.md → verify 链` 的做法，用一条**源码级接线检查**守住。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { keepAliveSwitches, KEEP_ALIVE_SWITCHES } = require('../scripts/smoke-flags.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 主进程源码（接线检查用；main.js 依赖 electron，不能在单测里 require） */
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

describe('冒烟保帧开关（纯函数）', () => {
  it('正常启动：**一个都不加**（不改变真实用户进程的行为）', () => {
    expect(keepAliveSwitches(false)).toEqual([]);
    expect(keepAliveSwitches(undefined)).toEqual([]);
    expect(keepAliveSwitches(0)).toEqual([]);
  });

  it('冒烟路径：加上三个 disable-* 与截图 surface 开关，顺序稳定', () => {
    const got = keepAliveSwitches(true).map((p) => p[0]);
    expect(got).toEqual([
      'disable-backgrounding-occluded-windows',
      'disable-renderer-backgrounding',
      'disable-background-timer-throttling',
      'enable-features'
    ]);
  });

  it('enable-features 的值是 CDPScreenshotNewSurface（抓帧路径）', () => {
    const pairs = keepAliveSwitches(true);
    const ef = pairs.find((p) => p[0] === 'enable-features');
    expect(ef).toBeTruthy();
    expect(ef[1]).toBe('CDPScreenshotNewSurface');
  });

  it('无值开关用空串（判定必须走 hasSwitch —— getSwitchValue 区分不了"没值"与"没有"）', () => {
    const pairs = keepAliveSwitches(true).filter((p) => p[0] !== 'enable-features');
    expect(pairs.length).toBe(3);
    for (const [, value] of pairs) expect(value).toBe('');
  });

  it('返回的是副本：调用方改它不会污染模块常量', () => {
    const a = keepAliveSwitches(true);
    a[0][0] = '被改坏了';
    a.push(['extra', '']);
    expect(keepAliveSwitches(true)).toEqual(KEEP_ALIVE_SWITCHES);
    expect(KEEP_ALIVE_SWITCHES.length).toBe(4);
  });
});

describe('接线：开关只许加在冒烟路径（源码级检查）', () => {
  it('main.js 里每一处 keepAliveSwitches 调用都在 isSmoke 守卫内', () => {
    const callSites = [...mainSrc.matchAll(/keepAliveSwitches\s*\(/g)].map((m) => m.index);
    // 至少有一处接线（否则功能根本没接上）
    expect(callSites.length).toBeGreaterThan(0);
    for (const at of callSites) {
      const before = mainSrc.slice(Math.max(0, at - 400), at);
      expect(before).toMatch(/isSmoke/);
    }
  });

  it('main.js 的开关应用发生在窗口创建之前（Chromium 只认启动前的开关）', () => {
    const applyAt = mainSrc.indexOf('keepAliveSwitches(');
    const firstWindowAt = mainSrc.indexOf('new BrowserWindow');
    expect(applyAt).toBeGreaterThan(-1);
    expect(firstWindowAt).toBeGreaterThan(-1);
    expect(applyAt).toBeLessThan(firstWindowAt);
  });
});
