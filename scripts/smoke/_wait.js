/* ============================================================
 * scripts/smoke/_wait.js —— 冒烟域**唯一**的"等一拍 / 等真帧 / 等条件"实现
 * ------------------------------------------------------------
 * ## 为什么有这份文件（本批实测的机制证据，不是推理）
 * `ctx.input.settle()` 的实现是「等两个 `requestAnimationFrame` + 默认 200ms」。
 * 在**离屏窗口**里那条"帧时钟"被 Chromium 压到 ≈1 fps（探针实测，见
 * `.review/20261066-验证链性能/probe-读数.md`）：
 *
 *   把窗口按冒烟的参数造出来（`show:false` / `backgroundThrottling:false` /
 *   `paintWhenInitiallyHidden:true` + `scripts/smoke-flags.js` 那四个开关），测到：
 *     · 两个 `requestAnimationFrame`  = **2016ms**（连测 5 次：1647 / 2015 / 2016 / 2016 / 2033）
 *     · 空闲 2s 里 rAF 只跑了 **2 帧** ⇒ ≈1 fps
 *     · 渲染层里一次 `setTimeout(fn, 0)` = **0ms**；`setTimeout(fn, 40)` = **45ms**
 *     · 主进程 → 渲染层 `executeJavaScript` 往返 = **0–7ms**
 *     · **`capturePage()` = 23–29ms，且它会逼出 1–2 个真帧**（每次截图期间 rAF 帧数 +1~+2；
 *       连续截图时 rAF 恢复到 ≈31 fps：639ms 里 20 帧）
 *
 * ⇒ 结论：`settle()` 那 ≈2s **不是"渲染要两秒"**，是"在等一个被节流的帧时钟"。
 *   而**逼帧**（截图）比等帧**便宜 70 倍**，并且给出的保证更强：
 *   拿到的是**已经合成出来的当前帧**，而不是"帧时钟又走了一格"。
 *
 * ## 三个入口，各自等的是什么（选哪个只看"要等的依据"，不看"谁快"）
 *   ① `frames(ctx, opts)` —— **等 N 个真帧**（N=2，与 `settle()` **完全同语义**）：
 *      渲染层那两个 `requestAnimationFrame` 回调**真的都跑过了**（由截图逼出来），
 *      之后照旧再睡 `delayMs`（默认 200，与 `settle()` 的默认值一致）。
 *      ⇒ 所有"真输入之后要它落地"的地方都用它：输入事件的落地**只能靠帧来证明**
 *      （`sendInputEvent` 走的是 Chromium 输入管线，`setTimeout` 与它**没有**先后保证）。
 *   ② `pump(ctx, promise)` —— 一段渲染层工作**正在进行**时，从主进程逼帧把它的 `rAF` 推快
 *      （用例：域 25 那条"连续 13 帧不重复刷类"的判据，原来 13 帧要 13 秒）。
 *   ③ `until(ctx, probe, opts)` —— **等条件**（主进程计时，墙钟截止）。
 *      用在"判据本身就是某个条件成立"的地方（轮询到它成立为止），
 *      **不是固定睡眠**：条件一成立就返回，超时才等到截止点。
 *
 * ## 为什么**没有** `tick()`（有人会想拿它再省 25ms/处 —— 那不划算）
 * `frames()` 单次实测 30–60ms（截图 23–29ms + 两个真帧）。把它降成"一次 setTimeout"
 * 每处只省 ~50ms（全量 200 处合计 ≈10s，占 1300s 的 0.8%），却把"真帧"换成"一拍"——
 * 而"一拍"对**真输入之后的状态**不构成任何保证。⇒ 本批**一处都没有**降级；
 * `ctx.input.settle` 只保留给"判据依赖一段真实墙钟"的地方（见下面第 5 条）。
 *
 * ## 口径（改这里之前先读）
 *   ① `frames()` **不许**比 `settle()` 弱：逼帧失败 / 拿不到 `ctx.input.capture` 时，
 *      它**退化回"等那两个 rAF"**（就是 `settle()` 的原行为，慢但一样严），并记进 `stats()`。
 *   ② `frames()` 的 `delayMs` 默认值与 `settle()` **相同（200）**，调用点传多少就是多少，
 *      本批**没有一处**改小过它。
 *   ③ `pump()` 只影响"帧多久来一次"，不改渲染层那段代码在等什么。
 *   ④ `until()` 的 `timeoutMs` 一律按**原口径的墙钟窗口**算（例如"原来 12 次 ×（2 帧≈2s + 120ms）"
 *      ⇒ 25440ms），并在调用点把这个算式写出来 —— 窗口是**判据的一部分**，不许悄悄缩短。
 *   ⑤ 仍有 6 处调用点**保留 `ctx.input.settle`**：它们等的是一段**真实墙钟**
 *      （IPC → CLI 写盘 → 回读；或"晚到的写必须没有发生"这种负向判据），
 *      那 2s 不是被节流放大的、是判据要的。名单与理由写在各自的注释里。
 *
 * ## 边界（诚实标注）
 *   ・`capturePage()` 在隐藏窗口下**可能给旧帧**（`scripts/smoke-input.js` 头部的实测记录）——
 *     本模块只用它**逼帧**，不读它的像素，所以"给旧帧"不影响任何判据；
 *   ・逼帧有上限（`PUMP_CAP_MS`）：超过就退化成"等它自己"，绝不无限循环；
 *   ・`stats()` 只给单测与诊断用，不参与任何判据。
 * ============================================================ */
'use strict';

/** 渲染层：等**两个** rAF（与 `ctx.input.settle` 里的那段逐字同源 —— 语义不许分叉） */
const JS_TWO_FRAMES = '(function () { return new Promise(function (res) {'
  + ' requestAnimationFrame(function () { requestAnimationFrame(function () { res(1); }); }); }); })()';

/** `frames()` 的默认 delayMs：**与 `ctx.input.settle` 的默认值一致**（200） */
const DEFAULT_DELAY_MS = 200;

/** 逼帧的上限：到点就退化成"等它自己"（实测两个真帧只要 30–60ms，2.5s 是给卡顿留的） */
const PUMP_CAP_MS = 2500;

/** 退化之后再等多久就放弃（原来的 `settle` 会**永远挂住**；这里响亮记一笔而不是静默） */
const HARD_CAP_MS = 4000;

/** 逼帧时两次截图之间的最小间隔（截图本身 20–30ms，正常情况下用不到它） */
const PUMP_MIN_GAP_MS = 0;

const stats = { calls: 0, pumps: 0, degraded: 0, timeouts: 0, hardTimeouts: 0 };

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();   // 不让一个"等"把进程吊住
  });
}

/** 单测与诊断用：计数快照（不参与任何判据） */
function statsOf() { return Object.assign({}, stats); }
function resetStats() {
  stats.calls = 0; stats.pumps = 0; stats.degraded = 0; stats.timeouts = 0; stats.hardTimeouts = 0;
}

/**
 * 从主进程**逼帧**，直到 `promise` 落地。
 * @param {{input?:{capture?:Function}}} ctx 冒烟上下文
 * @param {Promise} promise 渲染层那段正在跑的工作（通常是一个 `ctx.exec(...)`）
 * @returns {Promise} 原 promise 的结果/异常（**原样透传**，不吞错）
 */
async function pump(ctx, promise) {
  const p = Promise.resolve(promise);
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });   // 顺手挂上 handler：不留 unhandledRejection

  const canCapture = !!(ctx && ctx.input && typeof ctx.input.capture === 'function');
  if (canCapture && !settled) {
    const t0 = Date.now();
    while (!settled && Date.now() - t0 < PUMP_CAP_MS) {
      stats.pumps++;
      try {
        await ctx.input.capture();
      } catch (e) {
        await sleep(20);            // 截图偶发 UnknownVizError：不重试成死循环，下一拍再来
      }
      if (PUMP_MIN_GAP_MS) await sleep(PUMP_MIN_GAP_MS);
    }
  }
  if (!settled) {
    /* 没逼出来（截图能力缺失 / 截图一直抛 / 真的没有帧）⇒ **退化回原语义**：
     * 继续等那个 promise 自己落地，最多再等 HARD_CAP_MS。 */
    stats.degraded++;
    const outcome = await Promise.race([
      p.then(() => 'ok', () => 'err'),
      sleep(HARD_CAP_MS).then(() => 'timeout')
    ]);
    if (outcome === 'timeout') { stats.timeouts++; return undefined; }
  }
  return p;
}

/**
 * 等**两个真帧**（与 `ctx.input.settle` 同语义、同默认 delayMs），之后照旧睡 `delayMs`。
 * @param {object} ctx 冒烟上下文（需要 `exec`；有 `input.capture` 时走"逼帧"，没有则退化）
 * @param {{delayMs?:number}} [opts]
 * @returns {Promise<boolean>} 恒 `true`（与 `settle()` 的返回一致）
 */
async function frames(ctx, opts) {
  const o = opts || {};
  const delayMs = Number.isFinite(o.delayMs) ? o.delayMs : DEFAULT_DELAY_MS;
  stats.calls++;
  try {
    await pump(ctx, ctx.exec(JS_TWO_FRAMES));
  } catch (e) {
    /* 窗口没了 / 页面正在卸载：与 `settle()` 一样**不在这里吞掉真相**，
     * 交给调用方的断言去报红（下一句的 delayMs 照常给，别让调用方少等一个量级） */
    stats.hardTimeouts++;
  }
  if (delayMs) await sleep(delayMs);
  return true;
}

/**
 * 等条件（**条件一成立就返回**，超时才到截止点）。
 * @param {object} ctx 冒烟上下文（本函数不自己用，留给 `probe` 闭包用）
 * @param {() => Promise<any>} probe 取一次读数
 * @param {{done?:(v:any)=>boolean, timeoutMs?:number, intervalMs?:number}} [opts]
 *   `done` 缺省 = 真值判定；`timeoutMs` 缺省 60s；`intervalMs` 缺省 120ms
 * @returns {Promise<{ok:boolean, value:any, tries:number, ms:number}>} `ok:false` = **超时**（不是异常）
 */
async function until(ctx, probe, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 60000;
  const intervalMs = Number.isFinite(o.intervalMs) ? o.intervalMs : 120;
  const done = typeof o.done === 'function' ? o.done : (v) => !!v;
  const t0 = Date.now();
  let tries = 0;
  let value;
  for (;;) {
    tries++;
    value = await probe();
    if (done(value)) return { ok: true, value: value, tries: tries, ms: Date.now() - t0 };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, value: value, tries: tries, ms: Date.now() - t0 };
    await sleep(intervalMs);
  }
}

module.exports = {
  frames, pump, until,
  stats: statsOf, resetStats, sleep,
  JS_TWO_FRAMES, DEFAULT_DELAY_MS, PUMP_CAP_MS, HARD_CAP_MS
};
