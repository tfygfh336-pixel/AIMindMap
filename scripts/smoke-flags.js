/* ============================================================
 * scripts/smoke-flags.js —— 冒烟/离屏路径额外的 Chromium 开关（**纯函数，可单测**）
 * ------------------------------------------------------------
 * 为什么需要它：G5 的 L1 断言依赖"**隐藏窗口仍然出帧**"（见 scripts/smoke/14-headless-window.js）。
 * 但 Chromium 对**不可见 / 被遮挡**的窗口会做后台化与定时器节流，抑制合成与定时器 ——
 * 典型表现就是"要么截图是黑/白帧，要么断言里的 setTimeout 不走"，即**假红**。
 * 而假红的终点是有人把断言关掉（本工程已发生过门禁退化与数字漂移）。
 *
 * 开关清单的来源：**Playwright 给 Chromium 的默认启动参数**（官方源码
 * `packages/playwright-core/src/server/chromium/chromiumSwitches.ts`，Apache-2.0）。
 * 本工程只**照搬开关名**，不引入它的代码、也不引入它的任何依赖：
 *   disable-backgrounding-occluded-windows   窗口被遮挡时不后台化
 *   disable-renderer-backgrounding           渲染进程不被降级为后台优先级
 *   disable-background-timer-throttling      后台定时器不降频（本工程断言大量依赖 setTimeout）
 *   enable-features=CDPScreenshotNewSurface  抓帧走新的截图 surface
 *
 * ⚠️ 能力边界（诚实标注，别当承诺）：
 *   ① 本模块只保证"**在冒烟路径里真的加上了这些开关**"，由冒烟断言机械核对（不是靠注释声称）；
 *   ② 这些开关在 **Electron 44** 上的实际效力**未经验证** —— 来源是 Chromium/Playwright 的用法，
 *      不是 Electron 文档。真正的判据是**长期指标**：`verify-history.jsonl` 里 G5 的假红率与耗时趋势；
 *   ③ 所以只允许在 `--smoke` 路径加。**正常启动带这些开关会改变真实用户进程的功耗与后台行为**，
 *      `tests/smoke-flags.test.js` 有一条接线检查守着这件事（同 tests/verify-budget.test.js 的做法）。
 * ============================================================ */
'use strict';

/** [开关名, 值]；无值开关用空串表示（判定该用 hasSwitch，见冒烟断言） */
const KEEP_ALIVE_SWITCHES = [
  ['disable-backgrounding-occluded-windows', ''],
  ['disable-renderer-backgrounding', ''],
  ['disable-background-timer-throttling', ''],
  ['enable-features', 'CDPScreenshotNewSurface']
];

/**
 * 本次启动该额外追加哪些 Chromium 开关。
 * @param {boolean} isSmoke 是否冒烟/离屏路径；**正常启动必须传 false ⇒ 返回空数组**
 * @returns {Array<[string,string]>} 每项都是新数组（调用方可安全修改，不会污染本模块常量）
 */
function keepAliveSwitches(isSmoke) {
  if (!isSmoke) return [];
  return KEEP_ALIVE_SWITCHES.map((pair) => [pair[0], pair[1]]);
}

module.exports = { keepAliveSwitches, KEEP_ALIVE_SWITCHES };
