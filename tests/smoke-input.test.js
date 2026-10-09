/* ============================================================
 * tests/smoke-input.test.js — 真输入底座（`scripts/smoke-input.js`）的纯函数契约 + **接线检查**
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它（三条，都是本工程踩过的同一类病）：
 *   ① **事件序列要稳定**：`sendInputEvent` 的参数形状（type / button / clickCount / modifiers）
 *      是本模块与 Chromium 的唯一接口。它不靠"看起来对"守着 —— 一条断言把它钉住，
 *      改错了这条会红（而不是等到"真机上点了没反应"才发现 ✗）。
 *   ② **"非冒烟模式完全不可用"必须有机械判据**：`createDriver` 的 isSmoke 守卫既要**单测**
 *      （传 false 必须抛），也要**源码级接线检查**（main.js 里每一处 `createDriver(` 都必须出现在
 *      isSmoke 判定附近）—— 照 `tests/smoke-flags.test.js` 对 `scripts/smoke-flags.js` 的做法 ✓。
 *      只写注释说"只有冒烟才构造"是没有守护力的（本工程的老教训：没做，却看不出没做 ✗）。
 *   ③ **判别力**：`shot()` 的读数（bytes / sha256 / 尺寸）要真的来自写下去的那张图，
 *      否则"截图证据"就是空话 ⇒ 用假 NativeImage 断言落盘内容与读数一致 ✓。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const S = require('../scripts/smoke-input.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke-input.js'), 'utf8');

/** 假窗口：记录 sendInputEvent 的每一次调用（形状与真实调用完全一致 ✓） */
function fakeWin() {
  const sent = [];
  return {
    sent,
    webContents: {
      sendInputEvent: (ev) => { sent.push(ev); },
      executeJavaScript: async () => 1,
      capturePage: async () => fakeImage()
    }
  };
}

/** 假 NativeImage：toPNG 给一段可预测的字节，getSize 给尺寸 */
function fakeImage(w = 4, h = 3) {
  const bmp = Buffer.alloc(w * h * 4, 7);
  return {
    toBitmap: () => bmp,
    toPNG: () => Buffer.from([137, 80, 78, 71, 1, 2, 3]),
    getSize: () => ({ width: w, height: h })
  };
}

describe('修饰键与坐标：拼错必须响亮失败（不许静默降级成"没按 Ctrl"）', () => {
  it('control/shift/alt/meta 原样通过；ctrl 归一成 control；去重', () => {
    expect(S.normalizeModifiers(['control'])).toEqual(['control']);
    expect(S.normalizeModifiers(['ctrl'])).toEqual(['control']);
    expect(S.normalizeModifiers(['ctrl', 'control'])).toEqual(['control']);
    expect(S.normalizeModifiers(['shift', 'meta'])).toEqual(['shift', 'meta']);
    expect(S.normalizeModifiers(undefined)).toEqual([]);
    expect(S.normalizeModifiers('control')).toEqual(['control']);   // 单个字符串也收 ✓
  });

  it('不认识的键抛错（打错字 = 最坏的静默：会变成"没按 Ctrl"）', () => {
    expect(() => S.normalizeModifiers(['ctl'])).toThrow(/不认识的修饰键/);
    expect(() => S.normalizeModifiers(['Control'])).toThrow(/不认识的修饰键/);
    expect(() => S.normalizeModifiers([''])).toThrow(/非空字符串/);
  });

  it('坐标必须有限（NaN 会被 Electron 静默丢掉）', () => {
    expect(S.normalizePoint({ x: 1.4, y: 2.6 })).toEqual({ x: 1, y: 3 });
    expect(() => S.normalizePoint({ x: NaN, y: 1 })).toThrow(/有限数/);
    expect(() => S.normalizePoint(null)).toThrow(/有限数/);
  });
});

describe('事件序列（与 Chromium 的唯一接口，形状钉死）', () => {
  it('click = mouseMove + mouseDown + mouseUp，左键 clickCount=1，修饰键跟着走', () => {
    const evs = S.clickEvents({ x: 10, y: 20 }, ['control']);
    expect(evs.map((e) => e.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp']);
    for (const e of evs) expect(e.modifiers).toEqual(['control']);
    for (const e of evs) { expect(e.x).toBe(10); expect(e.y).toBe(20); }
    expect(evs[1].button).toBe('left');
    expect(evs[1].clickCount).toBe(1);
    expect(evs[2].button).toBe('left');
    // mouseMove 不带 button（Chromium 不需要，带上反而会被当成拖动中间态）
    expect(evs[0].button).toBeUndefined();
  });

  it('drag 留中间帧（框选/实时预览这类交互必须有中间移动）且以 mouseUp 收尾', () => {
    const evs = S.dragEvents({ x: 0, y: 0 }, { x: 90, y: 30 }, [], { steps: 3 });
    expect(evs[0].type).toBe('mouseMove');
    expect(evs[1].type).toBe('mouseDown');
    expect(evs[evs.length - 1].type).toBe('mouseUp');
    expect(evs[evs.length - 1].x).toBe(90);
    const moves = evs.filter((e) => e.type === 'mouseMove').map((e) => e.x);
    expect(moves).toEqual([0, 30, 60, 90]);          // 分段线性，不跳变
  });

  it('键盘：char 才是"输入字符"，pressKey 只有 keyDown/keyUp（不产生字符）', () => {
    expect(S.typeTextEvents('ab').map((e) => e.type)).toEqual(['char', 'char']);
    expect(S.typeTextEvents('ab')[1].keyCode).toBe('b');
    const k = S.keyEvents('Enter');
    expect(k.map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
    expect(k[0].keyCode).toBe('Enter');
    expect(S.typeTextEvents('').length).toBe(0);
  });
});

describe('★ isSmoke 守卫：非冒烟模式完全不可用（运行期 + 源码级）', () => {
  it('isSmoke !== true ⇒ 直接抛（哪怕窗口是好的）', () => {
    const win = fakeWin();
    expect(() => S.createDriver({ isSmoke: false, win })).toThrow(/非冒烟模式不可用/);
    expect(() => S.createDriver({ win })).toThrow(/非冒烟模式不可用/);
    expect(() => S.createDriver({ isSmoke: 0, win })).toThrow(/非冒烟模式不可用/);
    expect(win.sent.length).toBe(0);                  // 抛之前一个事件都不该发出去 ✓
  });

  it('isSmoke=true 但没有可用窗口 ⇒ 抛（响亮，不静默退化成"没有真输入"）', () => {
    expect(() => S.createDriver({ isSmoke: true })).toThrow(/需要一个可用的窗口/);
    expect(() => S.createDriver({ isSmoke: true, win: {} })).toThrow(/需要一个可用的窗口/);
  });

  it('main.js 里每一处 createDriver( 调用都在 isSmoke 判定附近（接线检查）', () => {
    const callSites = [...mainSrc.matchAll(/createDriver\s*\(/g)].map((m) => m.index);
    expect(callSites.length).toBeGreaterThan(0);      // 至少有一处接线（否则功能根本没接上 ✗）
    for (const at of callSites) {
      const before = mainSrc.slice(Math.max(0, at - 400), at + 200);
      expect(before).toMatch(/isSmoke/);
    }
  });

  it('真输入模块只在 runSmoke（--smoke 路径）里被 require（正常启动的进程根本加载不到它 ✓）', () => {
    const reqs = [...mainSrc.matchAll(/require\(['"]\.\/scripts\/smoke-input\.js['"]\)/g)];
    expect(reqs.length).toBe(1);
    const at = reqs[0].index;
    // ① 它在 runSmoke 函数体内（不是模块顶层）② 同一次调用里带着 isSmoke 判定
    expect(at).toBeGreaterThan(mainSrc.indexOf('function runSmoke('));
    expect(mainSrc.slice(at, at + 200)).toMatch(/isSmoke/);
  });
});

describe('驱动：事件真的经 sendInputEvent 发出去，截图证据落盘且读数同源', () => {
  it('click 发 3 条、drag 发 6 条（移动+按下+3 段移动+抬起）、计数可读（断言文本里要报它）', async () => {
    const win = fakeWin();
    const d = S.createDriver({ isSmoke: true, win });
    expect(d.isSmoke).toBe(true);
    await d.click({ x: 5, y: 6 }, ['control']);
    expect(win.sent.length).toBe(3);
    expect(win.sent[0].modifiers).toEqual(['control']);
    await d.drag({ x: 0, y: 0 }, { x: 9, y: 9 });
    expect(win.sent.length).toBe(3 + 6);
    expect(d.sentCount()).toBe(9);
  });

  it('shot() 落盘内容 = 返回的读数（bytes / sha256 来自真正写下去的那张图 ✓）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-input-test-'));
    try {
      const win = fakeWin();
      const d = S.createDriver({ isSmoke: true, win, shotDir: dir });
      const rec = await d.shot('probe.png');
      expect(rec.name).toBe('probe.png');
      expect(rec.file).toBe(path.join(dir, 'probe.png'));
      const onDisk = fs.readFileSync(rec.file);
      expect(onDisk.length).toBe(rec.bytes);
      expect(onDisk.equals(Buffer.from([137, 80, 78, 71, 1, 2, 3]))).toBe(true);
      expect(rec.width).toBe(4);
      expect(rec.height).toBe(3);
      expect(rec.sha256.length).toBe(16);
      expect(d.shots().length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shot() 拒收带路径分隔符的名字（截图不许写到目录外）', async () => {
    const d = S.createDriver({ isSmoke: true, win: fakeWin(), shotDir: os.tmpdir() });
    await expect(d.shot('../evil.png')).rejects.toThrow(/只允许/);
    await expect(d.shot('a/b.png')).rejects.toThrow(/只允许/);
  });
});

describe('模块自述与工程约定一致（防"文档说能用、代码没有"）', () => {
  it('截图目录在 .review/ 工作产物区（不进版本库 ✓）', () => {
    expect(S.SHOT_DIR_REL.replace(/\\/g, '/')).toMatch(/^\.review\/.+\/shots$/);
  });

  it('文件头写清了两件必须留痕的事：为什么不用 IPC 通道、以及已知边界（旧帧 / capturePage 只拍页面）', () => {
    expect(moduleSrc).toMatch(/IPC/);
    expect(moduleSrc).toMatch(/旧帧/);
    expect(moduleSrc).toMatch(/边界/);
  });
});
