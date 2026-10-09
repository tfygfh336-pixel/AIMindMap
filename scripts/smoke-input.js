/* ============================================================
 * scripts/smoke-input.js —— 冒烟专用「真输入 + 截图证据」驱动（唯一实现）
 * ------------------------------------------------------------
 * ## 为什么需要它
 * 合成事件 `el.dispatchEvent(new MouseEvent('click'))` 是**直接派发到某个已知元素**的，
 * 它**整条绕过** Chromium 的输入管线：命中测试（这个坐标此刻到底压着谁）、修饰键处理、
 * hover、指针捕获、拖拽阈值、浮层遮挡 —— 一概不走。于是"真机才复现、合成事件永远绿"的
 * 缺陷（真机反馈的 Ctrl+加选、浮层盖住点击、拖过头脱手…）**天然测不到**。
 * 本工程已有一次同型的真实记录：`scripts/smoke/25-related-view.js` 里写着
 * 「真事件永远落在节点层上；而 `dispatchEvent` 直接派到 path 上会**绕过命中测试**
 *  ⇒ 断言绿、功能坏 ✗。sendInputEvent 走 Chromium 的真实命中测试 ✓」。
 * `webContents.sendInputEvent()` 是 Electron 内置 API（**零新增依赖** ✓），走真实输入管线 ✓。
 *
 * ## 为什么**不是**一条 IPC 通道（与最初设计的偏离，理由在这里）
 * 最初的设计写的是"加一条 isSmoke 守卫的测试专用 IPC（`smoke:input` / `smoke:capture`）"。
 * 那条设计的前提是「冒烟断言跑在渲染层，只能经 IPC 请主进程代发」—— **这个前提在本工程不成立**：
 *   ・冒烟断言是**主进程里的模块**（`main.js` → `require('./scripts/smoke-assertions.js')`，
 *     每条断言的 `run(ctx)` 在主进程执行）；`ctx.exec` 只是它**主→渲染**的桥
 *     （`scripts/smoke-assertions.js:8` 就写着 `ctx.exec(js)` 封装 `executeJavaScript`）。
 *   ・而 `sendInputEvent` / `capturePage` **本身就是主进程 API** ⇒ 直接挂在 `ctx` 上即可。
 * 中间再插一条 IPC，只会多出一个**没有调用方的通道**（还得为它写守卫、写负向断言 ✗）。
 * **"非冒烟模式下完全不可用"这条要求仍然满足、而且更强**（三重保证）：
 *   ① **结构性**：驱动只在 `runSmoke()` 里构造，而 `runSmoke` 只有 `--smoke` 才会进入
 *      ⇒ 正常启动的进程里**根本不存在**这个对象；
 *   ② **运行期**：`createDriver()` 见到 `isSmoke !== true` **直接抛**（哪怕有人把 require 搬到别处也不生效）；
 *   ③ **机械可查**：`tests/smoke-input.test.js` 既有单测（守卫必须抛），又有**源码级接线检查**
 *      （main.js 里每一处 `createDriver(` 都必须出现在 `isSmoke` 判定附近）—— 照
 *      `tests/smoke-flags.test.js` 对 `smoke-flags.js` 的做法 ✓。
 *
 * ## 用法（下一轮会话直接抄）
 *   ```js
 *   // scripts/smoke/NN-*.js 的 run(ctx) 里：
 *   const pt = await pickPoint(ctx);                 // 几何最好在渲染层算（getBoundingClientRect）
 *   await ctx.input.click(pt, ['control']);          // 真 Ctrl+点击（走命中测试 ✓）
 *   await ctx.input.settle();                        // 等渲染稳定（2 帧 + 默认 200ms）
 *   const img = await ctx.input.capture();           // 全页截图（主进程 API）
 *   const shot = await ctx.input.shot('NN-a.png', img);   // 落 .review/…/shots/ 并回 {file,bytes,sha256,...}
 *   ```
 *   `ctx.input` 在**非冒烟模式**下不存在；断言里先判 `if (!ctx.input) return { ok: false, text: '…' }`，
 *   不要静默跳过（采不到底座 = 红 ✓）。
 *
 * ## 边界（别以为它比实际更强 ✓）
 *   ・隐藏窗口的 `capturePage()` **可能给旧帧**（`scripts/smoke/17-ui-polish.js` 有实测记录：
 *     "实测拍到过上一个项目"）⇒ **像素判据一律做成前后差分**（同一 ROI 在"动手前 / 动手后"
 *     各读一次）：旧帧只会造成**假红**、不会造成假绿 ✓；
 *   ・`capturePage(rect)`（带矩形）在隐藏窗口下实测**只能拿到空白** ⇒ 一律**全页** capture，
 *     再自己按 ROI 数像素（`scripts/vision/frame-stats.js`）✓；
 *   ・`settle()` 的默认 200ms 是给 CSS 过渡留的（`.float-detail { transition: opacity .12s }`）
 *     —— 有更长动画时自己传更大的 `delayMs` ✓。
 * ============================================================ */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 截图产物目录（相对工程根）。`.review/` 整目录已 gitignore ⇒ 图片**不进版本库** ✓ */
const SHOT_DIR_REL = path.join('.review', '20261009-真输入可视测试', 'shots');

/** 允许的修饰键（Electron `sendInputEvent` 的 `modifiers` 取值；**拼错要响亮失败**，不许静默忽略 ✗） */
const MODIFIERS = Object.freeze([
  'shift', 'control', 'alt', 'meta', 'cmd', 'command',
  'isKeypad', 'isAutoRepeat', 'capsLock', 'numLock', 'left', 'right'
]);

/** 别名归一：常见写法 `ctrl` → Electron 文档里的 `control`（本工程既有的 29-域用的也是 `control` ✓） */
const MODIFIER_ALIAS = Object.freeze({ ctrl: 'control' });

/** 修饰键归一 + 校验（纯函数）。不认识的键**抛错**（打错字变成"没按 Ctrl"是最坏的静默 ✗） */
function normalizeModifiers(mods) {
  if (mods === undefined || mods === null) return [];
  const list = Array.isArray(mods) ? mods : [mods];
  const out = [];
  for (const m of list) {
    if (typeof m !== 'string' || !m) {
      throw new TypeError('smoke-input: 修饰键必须是非空字符串（收到 ' + JSON.stringify(m) + '）');
    }
    const key = MODIFIER_ALIAS[m] || m;
    if (MODIFIERS.indexOf(key) < 0) {
      throw new TypeError('smoke-input: 不认识的修饰键 "' + m + '"（允许：' + MODIFIERS.join(' / ') + '）');
    }
    if (out.indexOf(key) < 0) out.push(key);
  }
  return out;
}

/** 坐标归一（纯函数）：取整 + 有限性校验（NaN 坐标会被 Electron 静默丢掉 ⇒ 必须先拦住 ✗） */
function normalizePoint(pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
    throw new TypeError('smoke-input: 坐标必须是有限数（收到 ' + JSON.stringify(pt) + '）');
  }
  return { x: Math.round(pt.x), y: Math.round(pt.y) };
}

/* ---------------- 纯构造函数：事件序列的唯一来源（可单测，无副作用） ---------------- */

/** 一次真实鼠标移动 */
function moveEvents(pt, modifiers) {
  return [Object.assign({ type: 'mouseMove' }, normalizePoint(pt),
    { modifiers: normalizeModifiers(modifiers) })];
}

/** 一次真实左键点击 = 移动 + 按下 + 抬起（三段都要发：只有 down/up 时 Chromium 的 hover 态不更新） */
function clickEvents(pt, modifiers) {
  const p = normalizePoint(pt);
  const mods = normalizeModifiers(modifiers);
  return [
    { type: 'mouseMove', x: p.x, y: p.y, modifiers: mods },
    { type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mods },
    { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mods }
  ];
}

/** 一次真实拖拽：移动→按下→分段移动（默认 3 段，给"拖动阈值/实时预览"留出中间帧）→抬起。
 *  `steps` 是**中间移动点数**（1 = 直接到终点）；拖拽类交互必须留中间帧，
 *  否则像"框选橡皮筋"这种实时跟随逻辑根本不会被走到 ✓ */
function dragEvents(from, to, modifiers, opts) {
  const o = opts || {};
  const steps = Math.max(1, Number.isFinite(o.steps) ? Math.round(o.steps) : 3);
  const a = normalizePoint(from);
  const b = normalizePoint(to);
  const mods = normalizeModifiers(modifiers);
  const button = o.button || 'left';
  const out = [
    { type: 'mouseMove', x: a.x, y: a.y, modifiers: mods },
    { type: 'mouseDown', x: a.x, y: a.y, button: button, clickCount: 1, modifiers: mods }
  ];
  for (let i = 1; i <= steps; i++) {
    out.push({
      type: 'mouseMove',
      x: Math.round(a.x + (b.x - a.x) * (i / steps)),
      y: Math.round(a.y + (b.y - a.y) * (i / steps)),
      modifiers: mods
    });
  }
  out.push({ type: 'mouseUp', x: b.x, y: b.y, button: button, clickCount: 1, modifiers: mods });
  return out;
}

/** 滚轮（缩放那类交互） */
function wheelEvents(pt, deltaY, deltaX, modifiers) {
  const p = normalizePoint(pt);
  return [{
    type: 'mouseWheel', x: p.x, y: p.y,
    deltaX: Number.isFinite(deltaX) ? deltaX : 0,
    deltaY: Number.isFinite(deltaY) ? deltaY : 0,
    modifiers: normalizeModifiers(modifiers)
  }];
}

/** 逐字输入（`type:'char'` 才能进输入框；`keyDown` 不会产生字符 ✗） */
function typeTextEvents(text) {
  const s = String(text == null ? '' : text);
  return Array.from(s).map((ch) => ({ type: 'char', keyCode: ch }));
}

/** 一次按键（keyDown + keyUp）：Enter / Escape 这类"被 keydown 处理器接住"的键用它。
 *  ⚠️ 它**不产生字符** —— 要往输入框里写字请用 `typeTextEvents` ✓ */
function keyEvents(keyCode, modifiers) {
  const mods = normalizeModifiers(modifiers);
  return [
    { type: 'keyDown', keyCode: String(keyCode), modifiers: mods },
    { type: 'keyUp', keyCode: String(keyCode), modifiers: mods }
  ];
}

/* ---------------- 驱动：把事件送进真实输入管线 + 截图留证 ---------------- */

/**
 * 造一个真输入驱动。
 * @param {{
 *   isSmoke?:boolean,            // **必须是 true**（否则抛：非冒烟模式完全不可用 ✓）
 *   win:object,                  // BrowserWindow（要有 webContents）
 *   exec?:Function,              // 渲染层执行器（等待稳定用；默认 win.webContents.executeJavaScript）
 *   capture?:Function,           // 截图（默认 win.webContents.capturePage；main.js 传 captureRetry 以复用重试）
 *   root?:string,                // 工程根（截图目录的相对基准）
 *   shotDir?:string,             // 覆盖截图目录（单测用）
 *   wait?:Function,              // 延时器（单测可注入假计时器）
 * }} opts
 * @returns {object} 驱动（`isSmoke: true` 为证）
 */
function createDriver(opts) {
  const o = opts || {};
  // ★ 守卫②（运行期）：非冒烟模式**完全不可用** —— 真输入只允许在 --smoke 路径下构造
  if (o.isSmoke !== true) {
    throw new Error('smoke-input: 非冒烟模式不可用（createDriver 需要 isSmoke === true）'
      + '—— 真输入能力只在 `--smoke` 路径下构造，正常启动的进程里不存在它 ✓');
  }
  const win = o.win;
  if (!win || !win.webContents || typeof win.webContents.sendInputEvent !== 'function') {
    throw new Error('smoke-input: 需要一个可用的窗口（win.webContents.sendInputEvent 不存在）');
  }
  const exec = typeof o.exec === 'function' ? o.exec : (js) => win.webContents.executeJavaScript(js);
  const capture = typeof o.capture === 'function' ? o.capture : () => win.webContents.capturePage();
  const wait = typeof o.wait === 'function' ? o.wait : (ms) => new Promise((r) => setTimeout(r, ms));
  const shotDir = o.shotDir || path.join(o.root || process.cwd(), SHOT_DIR_REL);

  let sent = 0;          // 送出去的输入事件条数（断言文本里报它：证明确实走了真输入 ✓）
  const shots = [];      // 本次落盘的截图（便于断言末尾一次性报出）

  function send(ev) {
    win.webContents.sendInputEvent(ev);
    sent++;
    return ev;
  }

  /** 逐条发一串事件（可选每条之间留 delayMs —— 拖拽/框选的中间帧需要它 ✓） */
  async function sendList(list, delayMs) {
    for (const ev of list) {
      send(ev);
      if (delayMs) await wait(delayMs);
    }
    return list.length;
  }

  /** 等渲染稳定：≥2 帧（rAF）+ 默认 200ms（覆盖 CSS 过渡） */
  async function settle(opts2) {
    const delayMs = (opts2 && Number.isFinite(opts2.delayMs)) ? opts2.delayMs : 200;
    try {
      await exec('new Promise(function (res) { requestAnimationFrame(function () {'
        + ' requestAnimationFrame(function () { res(1); }); }); })');
    } catch (e) { /* 窗口没了：交给调用方的断言去报红，不在这里吞掉真相 ✗ */ }
    if (delayMs) await wait(delayMs);
    return true;
  }

  /** 落一张截图证据（返回可写进断言文本的读数；`img` 可复用已截好的帧，省一次 GPU 合成 ✓） */
  async function shot(name, imgIn) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(name))) {
      throw new Error('smoke-input: 截图文件名只允许 [A-Za-z0-9._-]（收到 ' + name + '）');
    }
    const img = imgIn || await capture();
    const png = img.toPNG();
    fs.mkdirSync(shotDir, { recursive: true });
    const file = path.join(shotDir, String(name));
    fs.writeFileSync(file, png);
    const size = typeof img.getSize === 'function' ? img.getSize() : { width: 0, height: 0 };
    const rec = {
      name: String(name), file: file, bytes: png.length,
      sha256: crypto.createHash('sha256').update(png).digest('hex').slice(0, 16),
      width: size.width, height: size.height
    };
    shots.push(rec);
    return rec;
  }

  return {
    isSmoke: true,
    shotDir: shotDir,
    send: send,
    sendList: sendList,
    sentCount: () => sent,
    shots: () => shots.slice(),
    settle: settle,
    capture: capture,
    shot: shot,
    // 语义化入口（都走真实输入管线 ✓）
    moveTo: (pt, mods) => sendList(moveEvents(pt, mods), 0),
    mouseDown: (pt, mods) => sendList(clickEvents(pt, mods).slice(1, 2), 0),
    mouseUp: (pt, mods) => sendList(clickEvents(pt, mods).slice(2, 3), 0),
    click: (pt, mods) => sendList(clickEvents(pt, mods), 0),
    drag: (from, to, mods, o2) => sendList(dragEvents(from, to, mods, o2),
      (o2 && Number.isFinite(o2.stepDelayMs)) ? o2.stepDelayMs : 60),
    wheel: (pt, deltaY, deltaX, mods) => sendList(wheelEvents(pt, deltaY, deltaX, mods), 0),
    typeText: (text) => sendList(typeTextEvents(text), 0),
    pressKey: (keyCode, mods) => sendList(keyEvents(keyCode, mods), 0)
  };
}

module.exports = {
  SHOT_DIR_REL, MODIFIERS, MODIFIER_ALIAS,
  normalizeModifiers, normalizePoint,
  moveEvents, clickEvents, dragEvents, wheelEvents, typeTextEvents, keyEvents,
  createDriver
};
