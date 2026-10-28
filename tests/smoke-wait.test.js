/* ============================================================
 * tests/smoke-wait.test.js —— `scripts/smoke/_wait.js` 的单测（本批「甲」的判据自己也要被验）
 * ------------------------------------------------------------
 * 这份等待**换掉了 200 多处的 `ctx.input.settle`**，所以它自己的两条性质必须被钉住，
 * 否则"快"就是从"不再等真帧"偷来的：
 *   ① `frames()` 的**语义与 `settle()` 同一**：渲染层那两个 `requestAnimationFrame` 真的都要等，
 *      而且 `delayMs` 的默认值**逐字等于** `settle()` 的 200（不许悄悄变小）；
 *   ② 逼帧能力**缺失时必须退化**为"等那两个 rAF"（慢但一样严），**不许**退化成"直接返回"；
 *   ③ `until()` 是**条件等待**：成立就返回、不成立才等到截止点，`timeoutMs` 就是原口径的墙钟窗口。
 * 还有一条**源码级**的门禁（同 `tests/smoke-flags.test.js` 的做法）：`scripts/smoke/**` 里
 * 允许留下的 `ctx.input.settle(` **调用**处数必须 ≤ 6 —— 那 6 处是"判据依赖真实墙钟"的名单
 * （见 `scripts/smoke/_wait.js` 头部第 5 条）。新增一处就会红，逼下一个人先读那份口径。
 * ============================================================ */
'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
const fs = require('fs');
const path = require('path');

const WAIT = require('../scripts/smoke/_wait.js');

const ROOT = path.join(__dirname, '..');

/** 造一个"渲染层立刻完成"的假 ctx（`exec` 记下被执行的脚本 = 判据能看它到底等了什么） */
function fakeCtx(opts) {
  const o = opts || {};
  const execs = [];
  const ctx = {
    execs: execs,
    captures: 0,
    exec: async (js) => { execs.push(js); return o.execResult === undefined ? 1 : o.execResult; }
  };
  if (o.capture !== false) {
    ctx.input = {
      capture: async () => {
        ctx.captures++;
        if (o.captureThrows) throw new Error('UnknownVizError');
        return { fake: true };
      }
    };
  }
  return ctx;
}

describe('_wait.frames：与 settle 同语义（两个真帧 + 同一个 delayMs 默认值）', () => {
  beforeEach(() => WAIT.resetStats());

  it('渲染层那段脚本**逐字等着两个 rAF**（一次不够：settle 的语义就是两个）', async () => {
    const ctx = fakeCtx();
    await WAIT.frames(ctx, { delayMs: 0 });
    expect(ctx.execs.length, 'frames() 必须只发一次等待脚本（不是轮询）').toBe(1);
    expect(ctx.execs[0]).toContain('requestAnimationFrame(function () { requestAnimationFrame(');
  });

  it('真的调用截图**逼帧**（否则等于把两个真帧换成了一个一拍）', async () => {
    const ctx = fakeCtx();
    await WAIT.frames(ctx, { delayMs: 0 });
    expect(ctx.captures, '一次 frames() 至少逼一帧').toBeGreaterThanOrEqual(1);
  });

  it('delayMs 默认值必须**等于 settle 的 200**（不许自己变小：那是放松）', () => {
    expect(WAIT.DEFAULT_DELAY_MS).toBe(200);
  });

  it('delayMs 是真的等（设了就等，不是"记一笔"）', async () => {
    const ctx = fakeCtx();
    const t0 = Date.now();
    await WAIT.frames(ctx, { delayMs: 120 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it('**没有截图能力时退化**：仍然等那两个 rAF（慢，但不许更弱），并记进 stats', async () => {
    const ctx = fakeCtx({ capture: false });
    await WAIT.frames(ctx, { delayMs: 0 });
    expect(ctx.execs.length).toBe(1);
    expect(ctx.execs[0]).toContain('requestAnimationFrame');
    expect(WAIT.stats().degraded, '退化必须被计数（不许静默）').toBeGreaterThanOrEqual(1);
  });

  it('截图一直抛 ⇒ 不卡死、不无限循环，仍然把两个 rAF 等到', async () => {
    const ctx = fakeCtx({ captureThrows: true });
    const t0 = Date.now();
    await WAIT.frames(ctx, { delayMs: 0 });
    expect(ctx.execs[0]).toContain('requestAnimationFrame');
    expect(Date.now() - t0).toBeLessThan(WAIT.PUMP_CAP_MS + 2000);
  });
});

describe('_wait.pump：一段渲染层工作正在跑时，从主进程逼帧把它推快', () => {
  beforeEach(() => WAIT.resetStats());

  it('执行期间反复截图，并把原 promise 的值**原样**返回', async () => {
    const ctx = fakeCtx();
    let release;
    const work = new Promise((r) => { release = r; });
    const p = WAIT.pump(ctx, work);
    await new Promise((r) => setTimeout(r, 60));
    release(42);
    expect(await p).toBe(42);
    expect(ctx.captures, '60ms 里应该逼了好几帧').toBeGreaterThan(1);
  });

  it('promise 抛错时**原样透传**（等待不许把真相吞掉）', async () => {
    const ctx = fakeCtx();
    await expect(WAIT.pump(ctx, Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe('_wait.until：条件一成立就返回，`timeoutMs` 是**原口径的墙钟窗口**', () => {
  it('第 3 次读到时成立 ⇒ tries=3，且用时远小于 timeoutMs', async () => {
    let n = 0;
    const t0 = Date.now();
    const r = await WAIT.until(null, async () => { n++; return n >= 3; },
      { timeoutMs: 5000, intervalMs: 10 });
    expect(r.ok).toBe(true);
    expect(r.tries).toBe(3);
    expect(Date.now() - t0, '成立就返回（不是睡满窗口）').toBeLessThan(2000);
  });

  it('永不成立 ⇒ `ok:false` + 用时 ≈ timeoutMs（超时是**读数**，不是异常）', async () => {
    const r = await WAIT.until(null, async () => false, { timeoutMs: 150, intervalMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(140);
  });

  it('`done` 按值的形状判定（不是简单真值）—— 用它的地方判的是"哪一档"，不是"有没有"', async () => {
    let n = 0;
    const r = await WAIT.until(null, async () => ({ seq: ++n, kind: 'other' }),
      { done: (v) => v.seq >= 2 && v.kind === 'adopt', timeoutMs: 50, intervalMs: 5 });
    expect(r.ok, 'kind 不对时**不许**当成成立').toBe(false);
    const r2 = await WAIT.until(null, async () => ({ seq: ++n, kind: 'adopt' }),
      { done: (v) => v.kind === 'adopt', timeoutMs: 1000, intervalMs: 5 });
    expect(r2.ok).toBe(true);
  });
});

/* ---------------- 源码级门禁：运行期等待不许再回到 `settle` ---------------- */
describe('scripts/smoke/**：运行期等待必须走 `_wait.js`（剩下的 settle 调用是**名单**）', () => {
  /** 只数**调用语句**（`await ctx.input.settle(` 及行内花括号形态）；注释里的提及不算 */
  function settleCallsInSmoke() {
    const dir = path.join(ROOT, 'scripts', 'smoke');
    const out = [];
    for (const f of fs.readdirSync(dir).filter((x) => /^\d+-.+\.js$/.test(x))) {
      const arr = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      arr.forEach((l, i) => {
        if (l.indexOf('ctx.input.settle(') < 0) return;
        const slash = l.indexOf('//');
        if (slash >= 0 && slash < l.indexOf('ctx.input.settle(')) return;   // 行尾注释里的提及
        if (!/(await|return|\{)\s*ctx\.input\.settle\(/.test(l)) return;    // 只认调用语句
        out.push(f + ':' + (i + 1));
      });
    }
    return out;
  }

  it('调用处 ≤ 6（= "判据依赖真实墙钟"的名单：45×2 / 48×2 / 49×2）', () => {
    const calls = settleCallsInSmoke();
    expect(calls.length,
      '`scripts/smoke/**` 里又出现了 `ctx.input.settle(` 调用：\n    ' + calls.join('\n    ')
      + '\n  运行期等待请用 `require(\'./_wait.js\')` 的 frames/pump/until（理由见该文件头部）；'
      + '真要"等一段真实墙钟"，先在 `scripts/smoke/_wait.js` 头部第 5 条那份名单里登记').toBeLessThanOrEqual(6);
  });

  it('每个用到 `WAIT.` 的域都真的 require 了 `_wait.js`（少一行就是运行期 TypeError）', () => {
    const dir = path.join(ROOT, 'scripts', 'smoke');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => /^\d+-.+\.js$/.test(x))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (text.indexOf('WAIT.') < 0) continue;
      if (text.indexOf("require('./_wait.js')") < 0) bad.push(f);
    }
    expect(bad, '这些域用了 WAIT. 却没 require：' + bad.join('、')).toEqual([]);
  });
});
