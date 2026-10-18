/* ============================================================
 * tests/panel-geometry.test.js — 主窗口右侧让位带几何的单元测试（vitest，**零 Electron**）
 * ------------------------------------------------------------
 * 锁住 `src/panel-geometry.js` 的几何事实。三条纪律（决定这些用例怎么写）：
 *   ① **期望值手算写死**（不调产品同一个函数去推期望）—— 本工程踩过"两侧同源 ⇒ 恒等 ⇒ 判据抓不住
 *      语义被写坏"的坑（见 `docs/ARCHITECTURE.md` §2.3 `feedback-candidates.js` 那一行）。
 *      所以下面出现的 644 / 1004 / 780 / 644 这些数字都是**拿纸算的**，不是算出来的。
 *   ② **每个用例对准一条可破的不变式**（贴接 / 锚右 / 让位守恒 / 夹取优先序 / 侧栏隐藏后只剩面板），
 *      并写明"改哪一行会让它红"—— 这就是判别力。
 *   ③ 外加**结构断言**（"只有一处计算处"）：`main-dsh-sidebar.js` 里 `setBounds(` 只许出现在
 *      `relayout()` 内，`computeGeometry(` 只许被调一次 —— 防止有人日后另开第二条几何出口（A1）。
 * 场景基座（除非用例里另说）：窗口 1424×900 · 侧栏带 420（含 30 控制栏）· 面板 360 · 页面地板 400。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS, computeGeometry } from '../src/panel-geometry.js';

const ROOT = path.resolve(__dirname, '..');
const RAIL = 30;                    // 控制栏宽（唯一真源在 main-dsh-sidebar.js；测试里显式传，不依赖默认值）

/** 场景基座：宽窗 1424×900，侧栏可见且宽 420（整条带 = 控制栏 30 + 内容 390），面板打开 360 */
function base(over) {
  return computeGeometry(Object.assign({
    winWidth: 1424, winHeight: 900,
    sidebarVisible: true, sidebarWidth: 420,
    railWidth: RAIL, dshOnly: false,
    panelOpen: true, panelWidth: 360
  }, over || {}));
}

describe('panel-geometry ① 形态：右侧二阶并列（面板在内、侧栏锚右缘）', () => {
  it('宽窗 1424 · 侧栏 420 · 面板 360 ⇒ 三个矩形的**每个数字**都对得上手算值', () => {
    const g = base();
    // 手算：侧栏带 420 ⇒ bandX = 1424 − 420 = 1004
    //       面板 360 贴 bandX 左边 ⇒ panel.x = 1004 − 360 = 644
    expect(g.rail).toEqual({ x: 1004, y: 0, width: 30, height: 900 });
    expect(g.view).toEqual({ x: 1034, y: 0, width: 390, height: 900 });
    expect(g.panel).toEqual({ x: 644, y: 0, width: 360, height: 900 });
    expect(g.sidebarBandWidth).toBe(420);
    expect(g.occupiedWidth).toBe(780);      // 面板 360 + 侧栏带 420
    expect(g.pageWidth).toBe(644);          // 1424 − 780
    expect(g.clamped).toBe(null);
    expect(g.notes).toEqual([]);
  });

  it('不变式 1 贴接：panel 右缘 == rail 左缘（中间不许有缝、也不许重叠）', () => {
    const g = base();
    expect(g.panel.x + g.panel.width).toBe(g.rail.x);
    // 判别力：把 panel.x 写成 bandX（贴窗口右缘、盖住侧栏）⇒ 上面那行必红
    expect(g.panel.x + g.panel.width).not.toBe(g.view.x);
  });

  it('不变式 2 锚右：DSH 内容右缘 == 窗口宽（面板不许把侧栏推离右缘）', () => {
    const g = base();
    expect(g.view.x + g.view.width).toBe(1424);
    // 对照：**关掉面板**时侧栏带的位置一模一样 —— 这就是"锚右不漂移"的读数
    const off = base({ panelOpen: false });
    expect(off.rail).toEqual(g.rail);
    expect(off.view).toEqual(g.view);
  });

  it('不变式 3 让位守恒：occupied == panel + rail + view，且 page == 窗口宽 − occupied', () => {
    const g = base();
    expect(g.occupiedWidth).toBe(g.panel.width + g.rail.width + g.view.width);
    expect(g.pageWidth).toBe(g.windowWidth - g.occupiedWidth);
  });

  it('面板关着 ⇒ 与"没有这块面板"逐像素相同（既有几何一个字没动）', () => {
    const g = base({ panelOpen: false });
    expect(g.panel).toBe(null);
    expect(g.panelWidth).toBe(0);
    expect(g.occupiedWidth).toBe(420);
    expect(g.rail).toEqual({ x: 1004, y: 0, width: 30, height: 900 });
    expect(g.view).toEqual({ x: 1034, y: 0, width: 390, height: 900 });
  });
});

describe('panel-geometry ② 侧栏隐藏：面板独立存在（不是侧栏的子状态）', () => {
  it('侧栏隐藏 + 面板开 ⇒ 面板贴到窗口右缘，控制栏/侧栏内容都不在屏上', () => {
    const g = base({ sidebarVisible: false });
    // 手算：侧栏带 0 ⇒ bandX = 1424 ⇒ panel.x = 1424 − 360 = 1064
    expect(g.rail).toBe(null);
    expect(g.view).toBe(null);
    expect(g.panel).toEqual({ x: 1064, y: 0, width: 360, height: 900 });
    expect(g.sidebarBandWidth).toBe(0);
    expect(g.occupiedWidth).toBe(360);
    expect(g.pageWidth).toBe(1064);
  });

  it('侧栏隐藏 + 面板关 ⇒ 页面一点不让（让位量 0）', () => {
    const g = base({ sidebarVisible: false, panelOpen: false });
    expect(g.rail).toBe(null);
    expect(g.view).toBe(null);
    expect(g.panel).toBe(null);
    expect(g.occupiedWidth).toBe(0);
    expect(g.pageWidth).toBe(1424);
  });
});

describe('panel-geometry ③ 夹取优先序：面板永远先让（页面地板优先于面板）', () => {
  it('窗口 960（最小窗）· 侧栏 900 · 面板 360 ⇒ 面板夹到 0 并**如实记 clamped**', () => {
    const g = base({ winWidth: 960, sidebarWidth: 900 });
    // 手算：bandX = 960 − 900 = 60 ⇒ 60 − 400 = −340 ⇒ room = 0 ⇒ 面板 0
    expect(g.panel).toBe(null);
    expect(g.panelWidth).toBe(0);
    expect(g.clamped).toEqual({ want: 360, got: 0, reason: 'no-room' });
    expect(g.notes.length).toBe(1);
    expect(g.pageWidth).toBe(60);   // ⚠️ 页面被压扁是**侧栏 900** 造成的（既有行为），不是面板
  });

  it('窗口 1100 · 侧栏 420 ⇒ 面板最多 280（不是 360）：夹到页面地板并上报 page-floor', () => {
    const g = base({ winWidth: 1100 });
    // 手算：bandX = 680 ⇒ 680 − 400 = 280 ⇒ min(360, 280) = 280
    expect(g.panelWidth).toBe(280);
    expect(g.panel).toEqual({ x: 400, y: 0, width: 280, height: 900 });
    expect(g.clamped).toEqual({ want: 360, got: 280, reason: 'page-floor' });
    expect(g.pageWidth).toBe(400);  // 恰好等于页面地板
  });

  it('面板宽度低于下限 ⇒ 抬到下限 260（不是原样放行）', () => {
    const g = base({ panelWidth: 100 });
    expect(g.panelWidth).toBe(260);
    expect(g.clamped).toBe(null);   // 抬到下限不算"被夹小"，不报 clamped
  });

  it('面板宽度超上限 ⇒ 压到上限 720', () => {
    const g = base({ winWidth: 1800, panelWidth: 5000 });
    expect(g.panelWidth).toBe(720);
  });

  it('面板下限 260 与侧栏下限 280 可以同时在**最小窗 960** 里成立（页面还剩 420 ≥ 地板）', () => {
    const g = base({ winWidth: 960, sidebarWidth: 280, panelWidth: 260 });
    expect(g.sidebarBandWidth).toBe(280);
    expect(g.panelWidth).toBe(260);
    expect(g.pageWidth).toBe(960 - 280 - 260);      // = 420
    expect(g.clamped).toBe(null);                   // 夹都没夹 ⇒ 这条几何在小窗里也自洽
  });
});

describe('panel-geometry ④ 既有语义不许被这块面板改变', () => {
  it('仅侧栏模式（dshOnly）⇒ 侧栏铺满整窗、面板没有位置（如实记 note）', () => {
    const g = base({ winWidth: 1200, dshOnly: true });
    expect(g.rail).toEqual({ x: 0, y: 0, width: 30, height: 900 });
    expect(g.view).toEqual({ x: 30, y: 0, width: 1170, height: 900 });
    expect(g.panel).toBe(null);
    expect(g.occupiedWidth).toBe(1200);   // 让位 = 整窗（既有 dsh-only 语义）
    expect(g.notes.join('|')).toContain('dsh-only');
  });

  it('窗口比侧栏还窄 ⇒ 侧栏带被收到窗口宽（既有 `min(width, w)` 语义原样保留）', () => {
    const g = base({ winWidth: 360 });
    expect(g.sidebarBandWidth).toBe(360);
    expect(g.view).toEqual({ x: 30, y: 0, width: 330, height: 900 });
    expect(g.panel).toBe(null);
    expect(g.pageWidth).toBe(0);
  });

  it('侧栏带窄于控制栏 ⇒ 控制栏被收到侧栏带宽、内容 0 宽（"极窄时先保内容"那条的下界）', () => {
    const g = base({ sidebarWidth: 12 });
    expect(g.rail).toEqual({ x: 1412, y: 0, width: 12, height: 900 });
    expect(g.view).toBe(null);
    expect(g.sidebarBandWidth).toBe(12);
  });

  it('窗口尺寸非法（0 / NaN / 缺失）⇒ 安全退化，绝不产生负宽矩形', () => {
    const g = computeGeometry({ winWidth: 0, winHeight: NaN, railWidth: RAIL, sidebarVisible: true, sidebarWidth: 420, panelOpen: true, panelWidth: 360 });
    expect(g.windowWidth).toBe(0);
    expect(g.windowHeight).toBe(0);
    expect(g.panel).toBe(null);
    expect(g.rail).toBe(null);
    expect(g.view).toBe(null);
    expect(g.occupiedWidth).toBe(0);
    expect(g.pageWidth).toBe(0);
  });

  it('控制栏宽没传 ⇒ 按 0 处理（不偷偷回退一个默认 30；唯一真源必须由调用方给）', () => {
    const g = computeGeometry({ winWidth: 1000, winHeight: 800, sidebarVisible: true, sidebarWidth: 400, panelOpen: true, panelWidth: 360 });
    expect(g.sidebarBandWidth).toBe(400);   // 整条带都是"内容"（控制栏 0）
    expect(g.view.x).toBe(600);
    expect(g.view.width).toBe(400);
  });
});

describe('panel-geometry ⑤ 常数：面板档位的唯一真源', () => {
  it('DEFAULTS 的四个数与文档/文档漂移无关地钉住（改这里就要同批改 README 与冒烟读数）', () => {
    expect(DEFAULTS).toEqual({ panelMinWidth: 260, panelWidth: 360, panelMaxWidth: 720, pageMinWidth: 400 });
  });

  it('页面地板 + 面板下限 + 侧栏下限 ≤ 最小窗 960（"小窗也装得下两块"这条可机械复核）', () => {
    // 960 是 main.js 的窗口 minWidth；280 是 main-dsh-sidebar.js 的 MIN_WIDTH
    expect(DEFAULTS.pageMinWidth + DEFAULTS.panelMinWidth + 280).toBeLessThanOrEqual(960);
  });
});

describe('panel-geometry ⑥ 结构断言：几何只许有一处计算、一处应用（A1）', () => {
  const SIDEBAR_SRC = readFileSync(path.join(ROOT, 'main-dsh-sidebar.js'), 'utf8');
  /** 剥注释（结构断言只关心**代码里**有没有；注释里提到函数名是文档，不算第二处实现） */
  const stripComments = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const CODE = stripComments(SIDEBAR_SRC);

  it('`computeGeometry(` 在 main-dsh-sidebar.js 的**代码里**只被调用一次（唯一计算处）', () => {
    const hits = CODE.split('computeGeometry(').length - 1;
    // 1 次 = 业务调用；若日后有人再加一处"顺手也算一下"，这里立刻红
    expect(hits).toBe(1);
  });

  it('`setBounds(` 只出现在 `relayout()` 的函数体里（唯一改几何出口）', () => {
    const lines = CODE.split('\n');
    const start = lines.findIndex((l) => /^function relayout\(\)/.test(l));
    expect(start).toBeGreaterThan(-1);
    // relayout 体 = 从函数声明到下一个顶层 `function ` 或 `/* ---- ` 之前
    let end = lines.length;
    for (let k = start + 1; k < lines.length; k++) {
      if (/^function \w+\(/.test(lines[k]) || /^\/\* -/.test(lines[k])) { end = k; break; }
    }
    const inside = [];
    const outside = [];
    lines.forEach((l, idx) => {
      if (!/setBounds\(/.test(l)) return;
      (idx >= start && idx < end ? inside : outside).push(idx + 1);
    });
    expect(outside).toEqual([]);
    expect(inside.length).toBeGreaterThanOrEqual(1);
    expect(inside.length).toBeLessThanOrEqual(3);   // 控制栏 / 侧栏内容 / 停靠面板 三条
  });

  it('`setGeometry(` 是唯一"改意图再重排"的入口：relayout 之外不许再出现"直接改 state.width 然后 relayout"', () => {
    // 反例形态：`state.width = ...; relayout();` 出现在 setGeometry 之外 ⇒ 就是第二套几何设置函数
    const offenders = CODE.split('\n').filter((l) => /state\.(width|dock\.width|dock\.open)\s*=/.test(l));
    // 允许的写入点：clampWidth 那处（relayout 里的夹取）、setGeometry 里的三行、openDockPanel 的 prev、
    // loadPrefs、closeMapPage 的 dockWidth 快照。⇒ 这里只钉"数量不许悄悄增长"这个事实。
    expect(offenders.length).toBeLessThanOrEqual(8);
  });

  it('`src/panel-geometry.js` 零 I/O、零 Electron（几何纯粹可测）', () => {
    const src = readFileSync(path.join(ROOT, 'src', 'panel-geometry.js'), 'utf8');
    expect(src.indexOf('require(')).toBe(-1);
    expect(src.indexOf('electron')).toBe(-1);
    expect(src.indexOf('fs.')).toBe(-1);
  });
});
