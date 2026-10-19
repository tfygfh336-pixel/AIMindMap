/* ============================================================
 * scripts/smoke/53-sidebar-width-budget.js —— 「测量驱动的动态侧栏宽度」批（2026-10-16）
 * ------------------------------------------------------------
 * 本批把**早就采到、却只进诊断**的读数接回宽度控制：`state.narrow.metrics.overflow`
 * （= 内容是否横向溢出）从本批起决定侧栏要不要继续加宽，到上界仍装不下就**如实上报**。
 *
 * 六条断言，各自的判别力（每条都要能被打红 ⇒ 注释里写明"删掉哪一行它会红"）：
 *   ① 状态机（纯函数 `budgetTargetWidth`）：溢出才加一步 / 清零就停 / 到上界就上报；
 *   ② 闭环端到端（真编排 `runContentBudget` + 读数接缝）：读数序列 不清零→清零 与
 *      "到上界仍溢出"两条都要如实 —— **删掉 `runContentBudget` 里的上报分支 ⇒ ②必红**；
 *   ③ 到上界必须上报（编排结论 + 状态出口 + 备注点名上限）——
 *      **删掉 `budgetTargetWidth` 的 `at-ceiling` 分支 ⇒ ③必红**；
 *   ④ 手动拖宽 ⇒ 自动档让位 —— **删掉 `beginWidthDrag` 里的 `userTookOver = true` ⇒ ④必红**；
 *   ⑤ 宽度变化全程可回退（`prev` 有记录、右栏关掉一步回到底）——
 *      **删掉 `releaseRightbarRoom` 的还原分支 ⇒ ⑤必红**；
 *   ⑥ 读数不可信时**不做决定**（真页面视口 / 同源判据）——
 *      **删掉 `runContentBudget` 的同源判据两问 ⇒ ⑥必红**。
 *
 * ⚠️ **一条实测出来的环境事实**（决定了 ②③ 为什么用"读数接缝"而不是真页面）：
 *   本仓库冒烟/离屏窗口里 `WebContentsView.setBounds()` **不保证**页面视口跟着重排 ——
 *   实测（`.review/20261016-侧栏动态宽度/probe-budget.js`、`diag-viewport.js`）：连续 6 次改宽，
 *   `getBounds()` 每次都变、页面 `documentElement.offsetWidth` 一直停在 390；同一次运行里
 *   对**裸** WebContentsView 直调 `setBounds()` 又能同步 ⇒ 环境事实，不是产品 bug。
 *   于是"内容装不下 ⇒ 加宽 ⇒ 再测"这条链在门禁里**跑不到**（页面视口不动 ⇒ 读数恒为溢出）。
 *   两条处置一起上，缺一不可：
 *     · 产品侧**同源判据**：三条边（页面视口 / innerWidth / 要求的边）对不上就不做决定、
 *       记 note、补排一次测量（`rejectStaleMeasurement`）—— 这是断言 ⑥ 钉的东西；
 *     · 门禁侧**读数接缝**（`__setMeasureProbeForTest`，产品路径不调用）把读数换成可控的桩，
 *       好让 ②③ 真的跑到"到上界上报"那一步 —— 不这么办，这两条断言就永远不判 = 空转 ✗。
 *   真机（有窗口、页面真的重排）那半边的读数见 `.review/20261016-侧栏动态宽度/README.md`。
 *
 * 收尾：本域**不动**用户宽度偏好（冒烟跑在沙箱 userData 下）；结束时把读数接缝撤掉、
 * 释放预算会话、还原宽度并隐藏侧栏（不影响后面可能追加的域）。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAIL = sidebar.RAIL_WIDTH;       // **就是** main-dsh-sidebar.js 的 RAIL_WIDTH（不再手抄 30）

/** 装一条**可控读数**：`decide(页面视口宽)` 返回 `{scrollWidth, overflow}`。
 *  页面视口报"**这条宽度本应画成的边**"（`state.width − 控制栏`，窗口更窄时取实际占宽）——
 *  为什么不用真页面的 `offsetWidth`：本环境里 `setBounds()` 不重排页面（见文件头那条实测），
 *  真视口永远停在旧值 ⇒ 产品的同源判据（页面视口 == 要求的边）必然拒绝 ⇒ 门禁里**跑不到**闭环。
 *  这一句就是本文件头说的"读数接缝"：它替换**读数**，不替换任何判断与出口；
 *  "读数不可信时会不会乱动"由断言 ⑥ 用**真**页面读数单独钉 ✓。 */
function mountProbe(decide) {
  sidebar.__setMeasureProbeForTest(() => {
    const st = sidebar.getStatus();
    // ⚠️ 第 4 面板底座批改了**这一条读数口径**（判据本身一字未动）：
    //    原先写 `Math.min(st.width, sidebar.occupiedWidth()) - RAIL`，而 `occupiedWidth()` 自那批起
    //    = **页面让位总量**（控制栏 + 侧栏 + 停靠面板），且侧栏收起时是 0 ⇒ 侧栏不可见时这里会算出 0，
    //    把产品的"同源判据"逼进 stale-skip（实测：本域三条红，备注写"页面视口 0 ≠ 要求的边 726"）。
    //    现在按"这条宽度**本应画成的边**"取 = `state.width − 控制栏`：侧栏可见时与旧式**完全相同**
    //    （那时 occupiedWidth == state.width），侧栏收起时也仍然有定义 ✓。
    const vw = Math.max(0, st.width - RAIL);
    const d = decide(vw);
    return { pageViewportWidth: vw, innerWidth: vw, scrollWidth: d.scrollWidth, overflow: d.overflow };
  });
}

/** 复位到"没有右栏会话"的干净前提（本域自己的前置，不依赖别的域留下的状态）。 */
function resetBudget(width) {
  sidebar.releaseRightbarRoom();
  sidebar.setWidth(width === undefined ? 694 : width);
}

/** 步进一次并把预算**走到稳定**：`runContentBudget` 直接调、并重试到"预算不再需要动手"为止。
 *  为什么必须轮询而不是调一次或 sleep 固定时长：`setWidth()` 会排一次注入，而那次注入在
 *  **读数还没跟上新宽度**时会走 `stale-skip`（产品刻意的"不做决定"）⇒ 固定 sleep 会跑在窗口里
 *  假红。轮询的是**产品自己的状态**（settled / 宽度变了），不是等时间 ✓。 */
async function driveBudget(reason, opts) {
  const o = opts || {};
  const maxSteps = o.maxSteps || 10;
  let last = null;
  for (let i = 0; i < maxSteps; i++) {
    last = await sidebar.runContentBudget(reason + '-' + i);
    await sleep(220);
    const st = sidebar.getStatus();
    const b = st.contentBudget || {};
    // ⚠️ 只有 `settled` / `overflowAtCeiling` 才算走完。**别**拿"到达某个宽度"当出口：加宽之后
    //   还要一次"复查"读数才会判定"清零/到上界"，提前退出会截掉那条关键读数 ——
    //   那正是本断言真正要证明的东西（实测踩到：序列停在"溢出@900"、`清零=false` ✗）。
    if (b.settled || b.overflowAtCeiling) return { result: last, state: st, budget: b, steps: i + 1 };
    // `untilSteps`：**只走几步**就停 —— 给"验一步"的断言用（到达某个宽度不算停住：溢出时还会继续走）
    if (o.untilSteps !== undefined && b.stepUps >= o.untilSteps) {
      return { result: last, state: st, budget: b, steps: i + 1 };
    }
  }
  const st = sidebar.getStatus();
  return { result: last, state: st, budget: st.contentBudget || {}, steps: maxSteps };
}

module.exports = [

  {
    name: '侧栏宽度预算：状态机（纯函数）—— 溢出才加一步 / 清零就停 / 到上界就上报',
    run: async () => {
      /* ⚠️ 两个量必须分得清（2026-10-19 单位修复批）：
       *   PAGE_MIN = 756 = **页面视口**门槛（内核 computeColumns 算出来的）；
       *   BAND     = 786 = **侧栏带宽**下限 = PAGE_MIN + RAIL_WIDTH(30)。
       *   上一版拿 PAGE_MIN 当带宽 ⇒ 带 756 ⇒ 视口 726 ⇒ available 270 < 300 ⇒ 右栏仍算 0 宽，
       *   而当时的断言期望值也写的 756 ⇒ 门禁锁着缺陷、照样绿。下面这一半就是那个缺口的判据。 */
      const PAGE_MIN = sidebar.RIGHTBAR_PAGE_MIN;     // 756 = 内核右栏下限（**页面视口**口径）
      const BAND = sidebar.RIGHTBAR_MIN_BAND;         // 786 = 带宽口径 = PAGE_MIN + RAIL
      const RAILPX = sidebar.RAIL_WIDTH;              // 30 = 控制栏（导出的唯一真源）
      const MAX = sidebar.MAX_WIDTH;                  // 900 = 上界
      const STEP = sidebar.WIDTH_STEP_PX;
      const T = (cur, lastOverflow, rightbarOpen) => sidebar.budgetTargetWidth(
        cur, { lastOverflow: lastOverflow }, rightbarOpen === undefined ? true : rightbarOpen);
      // ① 右栏开着但侧栏**窄到垫得动**（这里 BAND−STEP = 732 < 786）⇒ 垫到**带宽下限本身**
      //   （不是一步到上界）—— 这是"预算档"最要紧的一条读数
      const atFloor = T(BAND - STEP, null);
      //    已经够宽（BAND*2 ≥ 786）⇒ 别动
      const b = T(BAND * 2, null);
      //    刚好在带宽下限上（786：垫不上去了）⇒ 这一支不该再回 below-floor
      //   （垫不动却照样 return 会吞掉"因溢出加一步" ⇒ 见 budgetTargetWidth 里的注释）
      const atExact = T(BAND, null);
      //    680（< 786）⇒ 必须垫到 786：这一条就是"756 那个旧值"的判别力所在
      const fromOld = T(PAGE_MIN, null);
      // ② 读到"装得下" ⇒ 停在原地（这就是"测量驱动"；若实现改成"一律加到上界" ⇒ 这里必红）
      const c = T(810, false);
      // ③ 仍溢出且没到上界 ⇒ 加一步
      const d = T(BAND, true);
      const d2 = T(810, true);
      // ④ 到上界仍溢出 ⇒ 不动（由编排如实上报；若实现"超上界继续加" ⇒ 这里必红）
      const e = T(MAX, true);
      // ⑤ 右栏关着时不算"下限"这条（宽度留给用户与既有语义）
      const f = T(BAND - 100, null, false);
      /* ── 单位 + 内核锚（本批新增的判据，零额外进程：都在本断言内现算）─────────────────
       * 三件事，缺一条这个 30px 缺口就会再次溜过门禁：
       *  a) 换算关系：BAND === PAGE_MIN + RAIL（两个名字不许退化成同一个数）；
       *  b) 内核现算：把 BAND 换成页面视口后，套 vendor 的 `computeColumns` 公式，available 必须 ≥ 300，
       *     而且**少一个步进就够不着**（786−54 ⇒ available 246 < 300）⇒ 这条不能让地板虚高；
       *  c) 内核源码锚：三个常数（56 / 400 / 300）是**内核私有事实**，直接回读 vendor 源码确认公式还在 ——
       *     内核升级改了预算 ⇒ 这里当场红，提示重新推导（而不是继续拿旧数字判）。 */
      const KERNEL = { rail: 56, center: 400, rightbarMin: 300 };   // 照抄 computeColumns
      const bandOk = BAND === PAGE_MIN + RAILPX;
      const viewportAtBand = BAND - RAILPX;                          // 786 − 30 = 756
      const availableAtBand = viewportAtBand - KERNEL.rail - KERNEL.center;
      const availableMinusStep = (BAND - STEP - RAILPX) - KERNEL.rail - KERNEL.center;
      const kernelMathOk = availableAtBand >= KERNEL.rightbarMin
        && availableMinusStep < KERNEL.rightbarMin;
      const kernelFile = path.join(__dirname, '..', '..', 'vendor', 'dsh', 'app', 'node_modules',
        '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js');
      let kernelSrc = '';
      try { kernelSrc = fs.readFileSync(kernelFile, 'utf8'); } catch (e) { kernelSrc = ''; }
      const kernelAnchorOk = !!kernelSrc
        && kernelSrc.indexOf('const available = viewport - s - 400;') >= 0
        && kernelSrc.indexOf('available < 300') >= 0
        && kernelSrc.indexOf('collapsedWidth = 56') >= 0;
      const ok = atFloor.width === BAND && atFloor.dir === 'below-floor'
        && b.width === BAND * 2 && b.dir === 'fits'
        && atExact.width === BAND && atExact.dir === 'fits'
        && fromOld.width === BAND && fromOld.dir === 'below-floor'
        && c.width === 810 && c.dir === 'fits'
        && d.width === BAND + STEP && d.dir === 'stepped'
        && d2.width === 810 + STEP && d2.dir === 'stepped'
        && e.width === MAX && e.dir === 'at-ceiling'
        && f.width === BAND - 100 && f.dir === 'fits'
        && bandOk && kernelMathOk && kernelAnchorOk;
      return {
        ok: ok,
        text: '带宽区间 ' + BAND + '…' + MAX + '（页面视口 ' + PAGE_MIN + ' + 控制栏 ' + RAILPX
          + '）步进 ' + STEP
          + '｜垫得动 ' + (BAND - STEP) + ' ⇒' + atFloor.width + '/' + atFloor.dir + '（不是一步到 ' + MAX + '）'
          + '｜旧值 ' + PAGE_MIN + '（= 上一版的地板）⇒' + fromOld.width + '/' + fromOld.dir + '（必须垫到 ' + BAND + '）'
          + '｜刚好在带宽下限 ' + atExact.width + '⇒' + atExact.dir
          + '｜已够 ' + (BAND * 2) + '⇒' + b.dir + '｜清零 810⇒' + c.dir
          + '｜溢出 810⇒' + d2.width + '/' + d2.dir + '｜溢出 ' + BAND + '⇒' + d.width + '/' + d.dir
          + '｜到上界 ' + MAX + '⇒' + e.dir + '｜右栏关着⇒' + f.dir
          + '｜【单位】带宽−控制栏=' + viewportAtBand + '≥ 视口门槛 ' + PAGE_MIN + '=' + bandOk
          + '｜【内核现算】' + viewportAtBand + '−' + KERNEL.rail + '−' + KERNEL.center + '='
          + availableAtBand + '≥' + KERNEL.rightbarMin + ' 且少一步=' + availableMinusStep + '<'
          + KERNEL.rightbarMin + ' ⇒ ' + kernelMathOk
          + '｜【内核源码锚】' + (kernelAnchorOk ? '56/400/300 公式仍在' : '⚠ 内核公式变了，需重新推导')
      };
    }
  },

  {
    name: '侧栏宽度预算：闭环端到端 —— 读数序列「不清零 → 清零」与「到上界仍溢出」都要如实',
    run: async () => {
      const orig = sidebar.getStatus().width;
      try {
        // ── 场景 A：内容**最终**装得下（越宽越不溢出）⇒ 序列必须出现"不清零 → 清零"
        resetBudget(694);
        mountProbe((vw) => ({ scrollWidth: 860, overflow: vw < 860 }));   // 860 宽的内容
        sidebar.ensureRightbarRoom();                 // 右栏开 ⇒ 垫到内核下限 756
        const startW = sidebar.getStatus().width;
        await driveBudget('smoke-A', { untilWidth: 864 });
        const stA = sidebar.getStatus();
        const bA = stA.contentBudget || { readings: [] };
        const seqA = (bA.readings || []).map((r) => (r.overflow ? '溢出' : '装下') + '@' + r.width);
        const firstOver = (bA.readings || []).some((r) => r.overflow === true);
        const lastFits = (bA.readings || []).length > 0
          && bA.readings[bA.readings.length - 1].overflow === false;
        const widthA = stA.width;                     // 应停在 900（内容 860 在 870 视口里装得下 ⇒ 到此为止）
        sidebar.releaseRightbarRoom();

        // ── 场景 B：内容**永远**装不下 ⇒ 必须走到上界并**如实上报**（不许静默挤）
        resetBudget(694);
        mountProbe((vw) => ({ scrollWidth: vw + 400, overflow: true }));
        sidebar.ensureRightbarRoom();
        await driveBudget('smoke-B', { untilWidth: sidebar.MAX_WIDTH });
        const stB = sidebar.getStatus();
        const bB = stB.contentBudget || { readings: [] };
        const seqB = (bB.readings || []).map((r) => (r.overflow ? '溢出' : '装下') + '@' + r.width);
        const okB = stB.width === sidebar.MAX_WIDTH && bB.overflowAtCeiling === true
          && bB.unresolved === true && typeof bB.note === 'string' && bB.note.length > 0
          && (bB.readings || []).length >= 2;
        sidebar.releaseRightbarRoom();

        /* 口径变更（2026-10-19 单位修复）：起手从「视口门槛 756」改成「带宽下限 786」⇒ 目标 864（内容 860）
         * 落在 894（= 786 + 54 + 54）而不是 900 —— 够用即止，不再多垫一步。 */
        const expectA = Math.min(sidebar.MAX_WIDTH, sidebar.RIGHTBAR_MIN_BAND + 2 * sidebar.WIDTH_STEP_PX);
        const ok = startW === sidebar.RIGHTBAR_MIN_BAND && firstOver && lastFits
          && widthA === expectA && okB;
        return {
          ok: ok,
          text: '【A 会清零】带宽起手 ' + startW + '（页面视口 ' + (startW - RAIL) + '）⇒ 序列=[' + seqA.join(' → ') + '] 收口=' + widthA
            + '（清零=' + lastFits + '）'
            + ' 明细A=' + JSON.stringify((bA.readings || []).map((r) => r.width + '/' + r.viewWidth + '/' + r.scrollWidth + '/' + (r.overflow ? '溢' : '好')))
            + '｜【B 永远溢出】序列=[' + seqB.join(' → ') + '] 末宽=' + stB.width
            + ' 到上界上报=' + bB.overflowAtCeiling + ' 未解决=' + bB.unresolved
            + ' tier=' + bB.tier + ' settled=' + bB.settled
            + ' 备注=「' + (bB.note || '') + '」'
        };
      } finally {
        sidebar.__setMeasureProbeForTest(null);
        sidebar.releaseRightbarRoom();
        sidebar.setWidth(orig);
      }
    }
  },

  {
    name: '侧栏宽度预算：到上界仍溢出必须**上报**（编排结论 + 状态出口 + 备注点名上限，不许静默挤）',
    run: async () => {
      const orig = sidebar.getStatus().width;
      try {
        /* 前提构造：`ensureRightbarRoom()` **只在没到内核下限时**才动手（那是产品语义 ✓），
         * 所以先落到"没到下限"的位置把**预算会话**武装起来，再放到上界 —— 否则下面那一步
         * 是"没有预算时调编排" = 空转（本工程明令禁止的那一类 ✗）。 */
        resetBudget(694);                            // view 664 < 756 ⇒ 下面这次必然动手
        mountProbe((vw) => ({ scrollWidth: vw + 400, overflow: true }));   // 永远溢出
        sidebar.ensureRightbarRoom();
        sidebar.setWidth(sidebar.MAX_WIDTH);         // 已在上界：不给任何加宽余地
        const armed = !!(sidebar.getStatus().contentBudget && sidebar.getStatus().contentBudget.active);
        const r = await sidebar.runContentBudget('smoke-ceiling');
        const b = sidebar.getStatus().contentBudget || {};
        // 四条缺一不可：① 这一步判成"到上界" ② 编排回报 reported ③ 状态出口带标志 ④ 备注点名上限
        const ok = armed && r.dir === 'at-ceiling' && r.reported === true
          && b.overflowAtCeiling === true && b.unresolved === true
          && typeof b.note === 'string' && b.note.indexOf(String(sidebar.MAX_WIDTH)) >= 0;
        return {
          ok: ok,
          text: '预算已武装=' + armed + '｜dir=' + r.dir + ' reported=' + r.reported
            + ' 宽度=' + sidebar.getStatus().width + '（未动）'
            + '｜到上界标志=' + b.overflowAtCeiling + ' 未解决=' + b.unresolved
            + '｜备注=「' + (b.note || '') + '」（必须点名上限 ' + sidebar.MAX_WIDTH + '）'
        };
      } finally {
        sidebar.__setMeasureProbeForTest(null);
        sidebar.releaseRightbarRoom();
        sidebar.setWidth(orig);
      }
    }
  },

  {
    name: '侧栏宽度预算：用户手动改过宽度 ⇒ 自动档让位（不再自动加宽，也不还原）',
    run: async () => {
      const orig = sidebar.getStatus().width;
      try {
        resetBudget(694);
        mountProbe((vw) => ({ scrollWidth: vw + 400, overflow: true }));   // 永远溢出
        sidebar.ensureRightbarRoom();                 // 先有一次自动加宽（记下 prev）
        const prev = sidebar.getStatus().autoWide && sidebar.getStatus().autoWide.prev;
        const widthAfterAuto = sidebar.getStatus().width;
        // 用户拖宽（真实入口 `beginWidthDrag()` —— 它同时是"用户改过宽度"的唯一写入点）
        sidebar.beginWidthDrag();
        sidebar.endWidthDrag();
        sidebar.setWidth(520);                        // 拖拽中的宽度落点
        // 再走一次预算：内容仍溢出，但自动档必须让位
        const r = await sidebar.runContentBudget('smoke-after-drag');
        const st = sidebar.getStatus();
        const b = st.contentBudget || {};
        const yielded = r.started === false && r.reason === 'user-takeover'
          && st.width === 520 && b.tier === 'user-takeover';
        // 而且**不还原**：右栏关掉后宽度仍是用户给的值
        const released = sidebar.releaseRightbarRoom();
        const after = sidebar.getStatus().width;
        const ok = yielded && released === false && after === 520 && prev === 694
          && widthAfterAuto === sidebar.RIGHTBAR_MIN_BAND;
        return {
          ok: ok,
          text: '自动加宽的 prev=' + prev + '（' + prev + '→' + widthAfterAuto + '）'
            + '｜拖宽后落 520 ⇒ 预算让位=' + yielded + '（' + r.reason + '，tier=' + b.tier + '）'
            + ' 宽度=' + st.width
            + '｜右栏关掉：还原=' + released + ' 宽度=' + after + '（应仍 520，不还原）'
        };
      } finally {
        sidebar.__setMeasureProbeForTest(null);
        sidebar.releaseRightbarRoom();
        sidebar.setWidth(orig);
      }
    }
  },

  {
    name: '侧栏宽度预算：宽度变化全程可回退（prev 有记录、右栏关掉一步回到原值）',
    run: async () => {
      const orig = sidebar.getStatus().width;
      try {
        resetBudget(694);
        mountProbe((vw) => ({ scrollWidth: vw + 400, overflow: true }));
        const widened = sidebar.ensureRightbarRoom();
        const st1 = sidebar.getStatus();
        const b1 = st1.contentBudget || {};
        // ① 起点被记下：`autoWide.prev` 与 `contentBudget.prev` 是同一条真值（694）
        const recorded = st1.autoWide && st1.autoWide.prev === 694 && b1.prev === 694;
        // ② 起手 = 内核下限（不是上界）
        const stepUp = st1.width === sidebar.RIGHTBAR_MIN_BAND;
        // ③ 再走一步（仍溢出）⇒ **回退点不变**（回退点是"用户原来的宽度"，不是"上一步"）
        await sleep(900);        // 等"加宽自己排的那次注入"过掉（它可能带一条 stale-skip）
        const stepTarget = sidebar.RIGHTBAR_MIN_BAND + sidebar.WIDTH_STEP_PX;
        await driveBudget('smoke-step', { untilSteps: 1 });
        const st2 = sidebar.getStatus();
        const b2 = st2.contentBudget || {};
        const prevStable = b2.prev === 694 && st2.autoWide && st2.autoWide.prev === 694;
        const stepped = st2.width === stepTarget;
        // ④ 右栏关掉 ⇒ 回到 694（**一步回到底**，不是回到上一步）
        const rel = sidebar.releaseRightbarRoom();
        const back = sidebar.getStatus();
        const ok = widened === true && recorded && stepUp && prevStable && stepped
          && rel === true && back.width === 694 && back.autoWide === null
          && back.contentBudget && back.contentBudget.active === false;
        return {
          ok: ok,
          text: '加宽=' + widened + '（694→' + st1.width + '）｜记下回退点=' + recorded
            + '（autoWide.prev=' + (st1.autoWide && st1.autoWide.prev) + '，budget.prev=' + b1.prev + '）'
            + '｜再走一步到 ' + st2.width + '（=' + sidebar.RIGHTBAR_MIN_BAND + '+'
            + sidebar.WIDTH_STEP_PX + ' ? ' + stepped + '）回退点仍=' + b2.prev
            + '｜右栏关掉还原=' + rel + ' ⇒ 宽度 ' + back.width + '（期望 694）'
            + '，预算会话 active=' + (back.contentBudget && back.contentBudget.active)
        };
      } finally {
        sidebar.__setMeasureProbeForTest(null);
        sidebar.releaseRightbarRoom();
        sidebar.setWidth(orig);
      }
    }
  },

  {
    name: '侧栏宽度预算：读数不可信时**不做决定**（真页面视口 / 同源判据 + 如实记原因）',
    run: async (ctx) => {
      const orig = sidebar.getStatus().width;
      try {
        /* 用**真** WebContentsView 走一遍测量链（**不装读数接缝**）：这条断言钉的是"同源判据"本身，
         * 与 ②③ 的受控读数互补 —— 一边证"读数可信时闭环成立"，一边证"不可信时不乱动"。
         * 为什么这条非有不可：本环境里页面视口**本来**就不跟着 setBounds 变（见文件头那条实测），
         * 所以它就是"读数不可信"的真实样本 —— 若同源判据被删掉，预算会照着旧读数凭空多垫一步，
         * 本条立刻红（这就是它的判别力）。 */
        sidebar.init(ctx.win);
        sidebar.show();
        await sleep(700);
        resetBudget(694);
        sidebar.ensureRightbarRoom();               // 右栏档：垫到内核下限（预算会话武装）
        await sleep(320);
        // 读**真**页面：`documentElement.offsetWidth` 与 `innerWidth`（这时还是同一条边 ✓）；
        // 再用**产品自己**的编排跑一次细档判定 —— 这一次它量到的"页面视口"与"要求的边"对不上
        // （本环境里 `setBounds` 不重排页面），于是必须走 `rejectStaleMeasurement`：不做决定、记原因。
        const real = sidebar.__viewForTest();
        const dom = JSON.parse(await real.webContents.executeJavaScript(
          'JSON.stringify({pageViewportWidth:document.documentElement.offsetWidth,'
          + 'innerWidth:window.innerWidth})'));
        // 直接走**产品自己的编排**（不是 `reviseWidthBudget`：那条在 `rightbarOpen` 为假时会
        // 早退 —— 本域没触发过右栏那两件事实信号，而"同源判据"是编排里的第一件事 ⇒ 从这里进）。
        await sidebar.runContentBudget('smoke-stale-direct');
        await sleep(200);
        // 判据用 `staleSkips`（"没判过几次"的**计数**）而不是 `tier`：tier 会被后续测量改写，
        // 而计数只增 —— 拿一个会被覆盖的字段当判据就是"读数与判据不是同一次取样"的同类错 ✗。
        let b = {};
        for (let i = 0; i < 16; i++) {
          b = sidebar.getStatus().contentBudget || {};
          if (b.staleSkips >= 1) break;
          await sleep(250);
        }
        const st = sidebar.getStatus();
        const want = Math.max(0, st.width - RAIL);
        const sameSource = Math.abs(dom.pageViewportWidth - dom.innerWidth) <= 2;
        // 判据要点：要求"页面**读了**、并且**读了也不信**"——
        //   `staleSkips >= 1` 是"同源判据真的拦下了一次测量"的**计数证据**（不是看 tier：
        //   tier 会被后续测量改写，拿它当判据就是"读数与判据不是同一次取样"的同类错 ✗）。
        //   ⚠️ 本环境的读数**必然**不一致（页面视口停在旧边），所以这里不会恒真；
        //   若有人把同源判据删掉 ⇒ 计数不增 ⇒ 本条**当场红**（见注入口径：注入 5）。
        const noBlindStep = st.width <= sidebar.RIGHTBAR_MIN_BAND;
        const told = b.staleSkips >= 1 && typeof b.note === 'string' && b.note.length > 0;
        const ok = sameSource && noBlindStep && told;

        /* 判据的第二半：**让引擎自己拿到一条自相矛盾的读数**（页面视口 ≠ innerWidth），
         * 看它会不会照样加宽。这里用读数接缝喂进矛盾值 —— 因为本环境里真页面**报不出**
         * 自相矛盾的读数（它只是停在旧边 ⇒ 那是"与要求的边不一致"那一支在拦）。
         * ⚠️ 喂的值必须让**第二支判据过不了它**：页面视口取"要求的边"本身（本域宽度 756 ⇒ 726），
         * 只把 innerWidth 改成 700 ⇒ 只有同源判据**第一问**抓得住它；
         * 若把第一问删掉（注入口径 5），它就会被当成正常读数 ⇒ `stepped` 加宽 ⇒ 本条必红 ✓
         * （第一版喂的是 700/640：两个问都拦得住 ⇒ 删一问答照样绿 = **没判别力**，已改）。 */
        sidebar.__setMeasureProbeForTest(() => ({
          pageViewportWidth: Math.max(0, sidebar.getStatus().width - RAIL),
          innerWidth: Math.max(0, sidebar.getStatus().width - RAIL) - 26,
          scrollWidth: 3000, overflow: true
        }));
        sidebar.setWidth(sidebar.RIGHTBAR_MIN_BAND);
        const w0 = sidebar.getStatus().width;
        await sidebar.runContentBudget('smoke-self-inconsistent');
        await sleep(150);
        const bInc = sidebar.getStatus().contentBudget || {};
        const wAfter = sidebar.getStatus().width;
        const noStepOnInconsistent = bInc.stepUps === 0 && wAfter === w0;
        sidebar.__setMeasureProbeForTest(null);
        const toldInc = bInc.staleSkips >= 1;
        const ok2 = noStepOnInconsistent && toldInc;
        return {
          ok: ok && ok2,
          text: '真页面读数 视口=' + dom.pageViewportWidth + ' innerWidth=' + dom.innerWidth
            + '（要求的边 ' + want + '，与要求一致=' + (Math.abs(dom.pageViewportWidth - want) <= 2) + '）'
            + '｜预算 tier=' + b.tier + ' 加宽步数=' + b.stepUps + ' 宽度=' + st.width
            + '（<= ' + sidebar.RIGHTBAR_MIN_BAND + '=' + noBlindStep + '）'
            + '｜同源判据拦下过一次=' + told + '（staleSkips=' + b.staleSkips + '）'
            + '｜喂矛盾读数（页面视口 = 要求的边、innerWidth 少 26）⇒ 不加宽=' + noStepOnInconsistent
            + '（' + w0 + '→' + wAfter + '，步数 ' + bInc.stepUps + '）且记了原因=' + toldInc
            + '｜备注=「' + (b.note || '') + '」'
        };
      } finally {
        sidebar.__setMeasureProbeForTest(null);
        sidebar.releaseRightbarRoom();
        sidebar.setWidth(orig);
        sidebar.hide();
      }
    }
  }
];
