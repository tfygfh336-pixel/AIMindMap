/* ============================================================
 * tests/sidebar-drop-basis.test.js — 「同一个落点判定被喂了**两种窗口矩形基准**」的源码级判据
 * 运行：npx vitest run tests/sidebar-drop-basis.test.js
 * ------------------------------------------------------------
 * 它抓的结构病（bug ①-B，2026-10-33 批2）：
 *   `main.js` 的选区拖放判定段里，`dshSidebar.viewBounds()` 返的是侧栏 `WebContentsView` 的
 *   bounds —— 相对**窗口客户区**；而同一段里曾用 `BrowserWindow.getBounds()`（含框架 + 菜单栏的外层
 *   矩形）当平移锚点。两种基准一混，判定矩形在窗口有菜单栏时整体**上移 57px、左移 8px**
 *   （实测 Δ = (-8, -57, 16, 65)，见 `.review/20261033-U验证/log-u3.txt` 的 U3 读数），于是：
 *     · 侧栏**底部 57px / 右侧 8px** 成了盲带（真在侧栏里却判 hit=false ⇒ 送不进侧栏）
 *     · 侧栏**上缘之上 57px / 左缘之外 8px** 成了假命中带（在导图页松手却判 hit=true）
 *   这类病的共同形态是「**同一件事在一处用了两个来源**」——它不会在 DOM 上显形，也不会让
 *   任何"命令没报错"式断言变红，只能靠**源码里的口径**钉住。
 *
 * 为什么是源码级（而不是行为级）：
 *   行为级判据（冒烟域 30 的 P3/P6/对照/假命中带四点）已经存在，但它要跑 Electron；这条是
 *   **最便宜的那一层**：不依赖 Electron、不依赖几何、毫秒级，改坏了立刻红。
 *   两层同向 ⇒ 只删一层也不会让这个口径失去守护（两层各自独立成立）。
 *
 * 判据口径（**逐字**，别用"大概"读它）：
 *   · 被测区域 = `main.js` 里从 `ipcMain.on('dsh-sidebar:sel-drag-start'` 起到
 *     `ipcMain.on('dsh-sidebar:toggle'` 之前的那一段（"选区拖放判定段"）；
 *   · **只看整行不是注释的行**（`//` / `*` / `/*` 开头的行不计）—— 注释里提醒"别再用外层矩形"
 *     是好事，不该因此判红；行内尾注释里的名字同样不算（本判据不解析字符串，口径就这样，
 *     谁要写进尾注释就自己改这条口径并说明理由）；
 *   · 判据一：区域内 `getBounds()` 出现 **0 次**；
 *   · 判据二：区域内 `getContentBounds()` 出现 **≥2 次**（取值实现 + 使用点）；
 *   · 判据三：整份 `main.js` 里 `getBounds()` **确实存在**（否则"区域内 0 次"可能只是因为全文件
 *     都没有它 ⇒ 这条判据就变成恒绿的空转 —— 本工程最反对的那种）；
 *   · 判据四：**判别力自检** —— 把区域内每一处 `getContentBounds()` 机械替换成 `getBounds()`
 *     （= 模拟"把基准改错"），同一组判据必须**判红**。它保证这套判据不是无论输入都绿的摆设。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');

const START = "ipcMain.on('dsh-sidebar:sel-drag-start'";
const END = "ipcMain.on('dsh-sidebar:toggle'";

/** 取出"选区拖放判定段"；定位失败返回 null（下面第一条就会红，绝不静默跳过） */
function selDragRegion(src) {
  const a = src.indexOf(START);
  if (a < 0) return null;
  const b = src.indexOf(END, a + START.length);
  if (b < 0 || b <= a) return null;
  return src.slice(a, b);
}

/** 只留"整行不是注释"的行（判据口径见文件头） */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

const count = (hay, needle) => hay.split(needle).length - 1;

/** 一次把三条判据都算出来（注入自检要用同一个实现 ⇒ 不许写第二份） */
function measure(regionCode) {
  return {
    outerRect: count(regionCode, 'getBounds()'),
    contentRect: count(regionCode, 'getContentBounds()')
  };
}

const mainSrc = fs.readFileSync(MAIN, 'utf8');
const regionRaw = selDragRegion(mainSrc);
const regionCode = regionRaw === null ? '' : codeOnly(regionRaw);

describe('选区拖放判定段：窗口矩形只许有一种基准（客户区）', () => {
  it('区域能唯一定位，且不是"空壳"（防止判据在空串上恒绿）', () => {
    expect(regionRaw, '找不到 ipcMain.on(sel-drag-start) … ipcMain.on(toggle) 这一段').not.toBeNull();
    expect(mainSrc.split(START).length - 1, '起点标记在 main.js 里必须只出现一次').toBe(1);
    expect(regionCode.length).toBeGreaterThan(1500);
    // 区域必须真的包含那三条终点路/判定的实现，否则"区域内 0 次外层矩形"毫无意义
    ['dsh-sidebar:sel-drag-end', 'isPointInSidebar', 'dsh-sidebar:sel-drop', 'selDragFinish', 'selDragFeed']
      .forEach((marker) => expect(regionCode, '区域里少了 ' + marker + ' ⇒ 区域边界变了，判据要跟着改').toContain(marker));
  });

  it('区域内不出现外层矩形 getBounds()（同一判定不许被喂两种矩形基准）', () => {
    const m = measure(regionCode);
    expect(m.outerRect, '判定段里出现了外层矩形；窗口有菜单栏时它比客户区大 (-8,-57,16,65) ⇒ 底部 57px 盲带 + 上缘之上 57px 假命中带')
      .toBe(0);
  });

  it('区域内以客户区矩形 getContentBounds() 为基准（至少 2 处：取值实现 + 使用点）', () => {
    const m = measure(regionCode);
    expect(m.contentRect).toBeGreaterThanOrEqual(2);
  });

  it('外层矩形 getBounds() 在整份 main.js 里确实存在 ⇒ 上一条的"0 次"不是恒绿空转', () => {
    // 认侧栏视图时要比 `view.getBounds()`；别处也可能有合法的视图矩形读取。
    // 这一条只证明"这个串不是在本文件里根本不出现"，从而让区域内的 0 次成为一条有内容的判据。
    expect(count(codeOnly(mainSrc), 'getBounds()')).toBeGreaterThan(0);
  });

  it('判别力自检：把区域内客户区基准换成外层矩形 ⇒ 同一组判据必须判红（不是无论输入都绿）', () => {
    const mutated = regionCode.split('getContentBounds()').join('getBounds()');
    expect(mutated).not.toBe(regionCode);        // 替换真的发生了
    const m = measure(mutated);
    expect(m.outerRect, '注入后外层矩形次数必须 > 0，否则这套判据抓不住基准错').toBeGreaterThan(0);
    expect(m.contentRect, '注入后客户区次数必须 < 2，否则这套判据抓不住基准错').toBeLessThan(2);
    // 两条判据的"该红"条件都成立 ⇒ 上面那两条 it() 在同样的输入下会红
    const wouldFail = m.outerRect !== 0 || m.contentRect < 2;
    expect(wouldFail).toBe(true);
  });
});
