/* ============================================================
 * src/control-poll.js —— 界面侧的**轮询消费器**（纯逻辑，不 require electron ⇒ 可单测）
 * ------------------------------------------------------------
 * 为什么把它从 `main.js` 里抽出来（本工程实测教训：批 1 的报告 ⑦-2）：
 *   · 控制通道的**单槽**与**重复派发**两个缺陷都长在那段内联在 `main.js` 里的轮询上 ——
 *     `main.js` 需要 Electron 才能加载 ⇒ 那段逻辑**从来没有单测**，只能靠"真跑起来看"，
 *     而"两个 CLI 进程同时下命令"这种竞态**恰恰是跑一次看不出来的**（要撞运气）。
 *   · 抽成这里之后，"认领去重""并发两条命令各自回执""孤儿清理"三件事都能在单测里
 *     **确定性地**复现 ✓（注入 `handle`，用注入的时钟）。
 *
 * 契约：
 *   `pollOnce()` —— 扫一遍 pending，把还没被认领的命令**认领后**交给 `handle`。
 *     · 返回**本次派发**的 token 数组（供断言/日志）；
 *     · **同一 token 至多派发一次**：认领靠 `src/control.js` 的 `claim()`（rename 只有一个赢家）。
 *       即使 `handle` 是慢的（异步、要花几秒），下一次轮询也**不会再看到它** ——
 *       这就是"重复派发"的根治点，而不是靠"记得在异步结束时清文件"（那种写法必然会漏：
 *       异步期间每一次轮询都会再读一遍同一条命令）。
 *   `handle(claim, reply)` —— 执行命令；`claim` = `{token, cmd, …}`，`reply(result)` 写回执
 *     （自动带上 token）。可以返回 Promise（慢命令：起服务、executeJavaScript）——
 *     **派发与收尾是分开的**：先认领、立刻返回，收尾由回调完成。
 *   ⚠️ `accept` 之后**必须**自己调 `reply`：否则就是欠调用方的回执（调用方会超时判失败 ——
 *     那是**可见**的失败，不是静默通过 ✓）。
 */
'use strict';

/* ---------- UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3；对照模块 `src/palette-rank.js`）----------
 * 修复前（2026-10-20 实测）：`require('./control.js')` 裸露在模块顶层、末尾直接 `module.exports`
 * ⇒ 浏览器端加载抛 `ReferenceError: require is not defined`（纯 (b) 类：只是头写错）。
 * 依赖 `control.js` 本身要读写盘 ⇒ 浏览器分支拿到的是它那份**已加守卫**的导出（函数在、
 * 调用即抛"需要 Node 环境"）⇒ 本模块能加载，误用时借它的报错说话。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./control.js'));
  } else {
    root.MMControlPoll = factory(root.MMControl);
  }
})(typeof self !== 'undefined' ? self : this, function (control) {

/**
 * @param {{dir:string, handle:Function, log?:Function, now?:()=>number, sweepEveryMs?:number}} opts
 *   `handle` 必填；`dir` 不给时 pollOnce 直接返回空（调用方在"还没拿到底层目录"时可以这样停用）
 */
function createControlPoller(opts) {
  const o = opts || {};
  const dir = o.dir;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const sweepEveryMs = Number.isFinite(o.sweepEveryMs) ? o.sweepEveryMs : 30000;
  let lastSweep = 0;
  let timer = null;
  let stopped = false;
  /** 派发历史（本进程内）：诊断用，也是"重复派发"断言的直接读口 */
  const dispatched = [];

  /** 一次清扫（孤儿认领位 + 超量 pending + 过期回执）。**如实告警**，绝不静默丢东西。 */
  function maybeSweep(force) {
    if (!dir) return null;
    const t = now();
    if (!force && t - lastSweep < sweepEveryMs) return null;
    lastSweep = t;
    const r = control.sweep(dir, { now: t });
    if (r.orphans.length) {
      log('控制通道：清掉 ' + r.orphans.length + ' 个孤儿认领位（认领后没有回执，可能进程被杀）：' + r.orphans.join(', '));
    }
    if (r.dropped.length) {
      log('⚠ 控制通道：pending 超过 ' + control.MAX_PENDING + '，丢掉最老的 ' + r.dropped.length + ' 条：' + r.dropped.join(', '));
    }
    if (r.donePruned) log('控制通道：清掉 ' + r.donePruned + ' 份过期回执');
    return r;
  }

  /** 走一遍：认领 → 执行 → 回执。返回**本次**真正派发出去的 token 数组。 */
  function pollOnce() {
    if (!dir) return [];
    maybeSweep(false);
    const mine = [];
    // 坏文件（半截 / 坏 JSON / 没有 token）被当作"没有命令"丢掉时必须**说出来**：
    // 静默丢掉的表现是"调用方一直等到超时，而日志里什么都没有"（最难的排查现场）✗
    for (const cmd of control.listPending(dir, (dropped) => {
      log('⚠ 控制通道：丢掉 ' + dropped.length + ' 个读不出来的命令文件（当作没有命令）：' + dropped.join(', '));
    })) {
      // ★ 认领：rename 只有一个赢家 ⇒ 同一条命令不会被派发第二次（哪怕上一拍还在干活）
      const claimed = control.claim(dir, cmd.token);
      if (!claimed) continue;
      dispatched.push({ token: claimed.token, cmd: claimed.cmd, at: now() });
      mine.push(claimed.token);
      let replied = false;
      const reply = (result) => {
        // ⚠️ 必须**真的**忽略后一次：只打日志就接着往下写 = 后一次把前一次的回执覆盖掉。
        //   而那正是"回执说的是假的"的现场 —— 第一份回执（真干完的那次）才是调用方该读到的
        //   （本文件第一版就漏了这个 return：日志说"忽略后一次"，行为却是"后一次赢"，比不打日志更坏）
        if (replied) { log('控制通道：同一命令回了两次回执（忽略后一次）：' + claimed.token); return; }
        replied = true;
        try { control.writeResult(dir, claimed.token, Object.assign({ at: new Date().toISOString() }, result)); }
        catch (err) { log('控制通道：回执写不进去（' + ((err && err.message) || err) + '）—— 调用方会超时 ⇒ 判"没生效" ✓'); }
      };
      try {
        const ret = o.handle(claimed, reply);
        if (ret && typeof ret.then === 'function') {
          // 慢命令：**先认领、后干活**，收尾交给回调（这就是"取走后写已消费标记"的落地 ✓）
          ret.catch((err) => {
            reply({ ok: false, err: '命令执行异常：' + ((err && err.message) || err) });
          });
        }
      } catch (err) {
        // 同步抛（坏命令 / 未知命令）⇒ 当场给回执：**不允许**让调用方等一个永远不会来的东西
        reply({ ok: false, err: '命令执行异常：' + ((err && err.message) || err) });
      }
    }
    return mine;
  }

  function start(intervalMs) {
    if (timer || stopped || !dir) return false;
    maybeSweep(true);
    timer = setInterval(() => {
      try { pollOnce(); } catch (err) { log('控制通道轮询异常：' + ((err && err.message) || err)); }
    }, Number.isFinite(intervalMs) ? intervalMs : 400);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }
  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    return true;
  }

  return { pollOnce, maybeSweep, start, stop, dispatched, dir: dir };
}

return { createControlPoller };
});
