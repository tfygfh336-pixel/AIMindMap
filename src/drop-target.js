/* ============================================================
 * src/drop-target.js — 跨视图拖放的**落点判定**（纯函数 ✓ 可单测 ✓）
 * ------------------------------------------------------------
 * 背景（P7，用户 C）：把选中节点拖到**侧栏那块原生视图**上松手也要生效 ✓。
 *   侧栏是主进程的原生 WebContentsView ⇒ 指针进入它的矩形后，渲染层收不到
 *   mousemove/mouseup ✗ ⇒ 必须由**主进程**在拖拽期间轮询屏幕坐标 ✓ 并判定落点 ✓。
 * 本模块只做判定，不碰 Electron（便于单测与复用 ✓）。
 *
 * 坐标约定（**这是最容易搞错的地方** ✗）：
 *   - `pt`      ：屏幕坐标（Electron `screen.getCursorScreenPoint()` ✓）
 *   - `winBounds`：窗口的**屏幕**矩形（`BrowserWindow.getBounds()` ✓）
 *   - `viewBounds`：视图的**窗口内**矩形（`WebContentsView.getBounds()` ✓，x/y 相对窗口客户区 ✓）
 *   ⇒ 判定前必须把 viewBounds 平移到屏幕坐标：`x + winBounds.x`, `y + winBounds.y` ✓
 * ============================================================ */
'use strict';

/**
 * 把一个"窗口内坐标的矩形"换算成"屏幕坐标的矩形"。
 * @param {{x:number,y:number,width:number,height:number}} rect  窗口内矩形（可为 null）
 * @param {{x:number,y:number}} winBounds  窗口的屏幕原点
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function toScreenRect(rect, winBounds) {
  if (!rect || !winBounds) return null;
  const w = Number(rect.width), h = Number(rect.height);
  if (!(w > 0) || !(h > 0)) return null;             // 零宽/负宽（侧栏收起 ✗）⇒ 视为不存在 ✓
  return {
    x: Number(rect.x) + Number(winBounds.x),
    y: Number(rect.y) + Number(winBounds.y),
    width: w,
    height: h
  };
}

/** 点是否落在矩形内（左闭右开；与"贴边"这种边界的约定见单测 ✓）。 */
function isPointInRect(pt, rect) {
  if (!pt || !rect) return false;
  const x = Number(pt.x), y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * 落点是否在**侧栏视图**内。
 * @param {{x:number,y:number}} pt  屏幕坐标
 * @param {{x:number,y:number}} winBounds  窗口屏幕原点
 * @param {{x:number,y:number,width:number,height:number}|null} viewBounds  侧栏视图（窗口内坐标）
 * @returns {boolean}  true ⇒ 松手应把选中内容投喂进侧栏 ✓
 */
function isPointInSidebar(pt, winBounds, viewBounds) {
  const r = toScreenRect(viewBounds, winBounds);
  if (!r) return false;                              // 侧栏没开 / 宽度为 0 ⇒ 不可能命中 ✓
  return isPointInRect(pt, r);
}

/**
 * 跨视图拖放的**兜底判据**：光标落在侧栏视图内、并持续 ≥ thresholdMs ⇒ 判为"就是在这儿松的手"。
 * 为什么需要它：指针进了原生 WebContentsView 之后，渲染层收不到 mouseup ✗ ⇒ 没人上报终点；
 *   而主进程在 Windows 下**拿不到全局鼠标按键状态** ✗ ⇒ 只能按"悬停时长"近似（400ms、离开即复位 ✓）。
 * 纯函数（时间由调用方传入）⇒ 边界可单测 ✓；侧栏没开 / 时间戳缺失 ⇒ false ✓。
 * @param {{x:number,y:number}} pt 屏幕坐标（最近一次采样的光标位置）
 * @param {{x:number,y:number}} winBounds 窗口屏幕原点
 * @param {object|null} viewBounds 侧栏视图（窗口内坐标）
 * @param {number|null} overSinceMs 光标**开始**停留在侧栏内的时刻（毫秒；离开侧栏时调用方需复位为 null）
 * @param {number} nowMs 当前时刻（毫秒）
 * @param {number} thresholdMs 判定阈值（毫秒）
 * @returns {boolean}
 */
function shouldDropByDwell(pt, winBounds, viewBounds, overSinceMs, nowMs, thresholdMs) {
  if (!isPointInSidebar(pt, winBounds, viewBounds)) return false;
  if (!overSinceMs || !nowMs) return false;
  return (nowMs - overSinceMs) >= Number(thresholdMs || 0);
}

module.exports = { isPointInSidebar, isPointInRect, toScreenRect, shouldDropByDwell };
