/* ============================================================
 * scripts/smoke/view-stability.js —— `waitStableView` 的**共用实现**（三处使用了 ⇒ 提共用 ✓）
 * ------------------------------------------------------------
 * 为什么有这份文件：`waitStableView` 原先有两份拷贝（`46-节点级拖动.js` / `45-子树偏移与方向.js`，
 * 45 的拷贝处写着「第三次再撞上就提到共用处」）。域 37 的**链内时序假红修复**（效率批 3）撞上
 * 第三处使用 ⇒ 按那份承诺提到这里。
 * ⚠️ 45/46 的既有拷贝**本批不动**（那是别的批的文件 ✗）——它们迁到这里的这一步留给它们自己的
 * 下一批（记为**存量欠账**：两份旧拷贝与本实现同口径，不构成第二份会漂的判据——判据原文
 * 「连续三次同一个视图签名」在三个文件里逐字同源）。
 *
 * 判据（与 46 域逐字同口径）：**连续三次同一个**视图签名 ⇒ 这段时间里没人动过画布；
 * 每次之间隔 2 帧 + 70ms（`_wait.js` 的 `WAIT.frames`：两个真帧照等，只是那两帧由**主进程截图逼出来**，
 * 不再等那条被离屏窗口压到 ≈1fps 的帧时钟 —— 12 次轮询从 ≈24.8s 降到 ≈1.5s，**判据一个字没改**）；
 * 12 次仍不稳 ⇒ 返回最后一次读数
 * （**不假装稳定** ✗：调用方的断言照常判，该红就红——不许把"一直不稳"洗成"通过"）。
 *
 * ⚠️ 它只负责"等视图落定"，**不放宽任何判据**："整幅平移"照样要被两次读数之间的
 * 相对位移 / 逐项对比抓住 —— 那正是"整棵树一起动"这条**真缺陷**的形状 ✗。
 * ============================================================ */
'use strict';

const WAIT = require('./_wait.js');

/** 默认签名 = 画布 pan 状态（与 46 域同一条读数） */
const DEFAULT_SIG = 'JSON.stringify(window.MMApp.getPanState())';

/**
 * 等"视图签名"连续三次同一再返回（条件等待，**不是固定睡眠** ✗）。
 * @param {{exec:function, input:{capture?:function}}} ctx 冒烟上下文（有 `input.capture` 才逼得出真帧）
 * @param {string} [sigJs] 视图签名表达式（应返回稳定的 JSON 串）；缺省 = 画布 pan 状态
 * @param {{tries?:number, delayMs?:number}} [opts] 轮询次数（默认 12）与间隔（默认 70ms）
 * @returns {Promise<string>} 最后一次签名（稳定时 = 三连同一的那份）
 */
async function waitStableView(ctx, sigJs, opts) {
  const o = opts || {};
  const js = sigJs || DEFAULT_SIG;
  const tries = o.tries || 12;
  const delayMs = o.delayMs || 70;
  let last = null, same = 0;
  for (let i = 0; i < tries; i++) {
    const st = await ctx.exec(js);
    if (st === last) { same++; if (same >= 2) return st; } else { same = 0; last = st; }
    // 两次读数之间照旧等**两个真帧**（语义与 `settle({delayMs})` 同一，只是那两帧由逼帧拿到）
    await WAIT.frames(ctx, { delayMs: delayMs });
  }
  return last;
}

module.exports = { waitStableView, DEFAULT_SIG };
