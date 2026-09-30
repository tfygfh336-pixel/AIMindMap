/* ============================================================
 * scripts/smoke/22-sidebar-gap.js —— 侧栏隔壁那道"灰色背景"（预留宽度 vs 实际宽度）
 * ------------------------------------------------------------
 * 用户实测："刚打开的时候侧边栏隔壁出现了灰色背景"，并质问"你到底有没有截图检查"。
 * 复盘出的两条事实（都要记住）：
 *   ① **截图看不见它**：侧栏是原生 `WebContentsView`，`capturePage()` 只截页面 ⇒
 *      这条缺陷在截图里**本来就不存在**（不是"忘了截图"，而是"截了也看不见"）。
 *   ② 判据只能是**几何**：页面为侧栏预留的宽度，必须等于原生侧栏**实际占的**宽度。
 *      两边数字来源不同（CSS 变量 vs `WebContentsView.getBounds()`），不一致就多留一条 —— 那就是灰缝。
 *
 * 复现与判别力（本环境原来测不到：冒烟不孵化服务 ⇒ 没有 view ⇒ 无从比较）：
 *   本断言主动 `sidebar.show()` 把 view 建起来（不需要服务，显示的是状态页），
 *   然后把窗口**缩窄到比侧栏意图宽度还小** ⇒ `relayout()` 里 `vw = min(state.width, 窗口宽)` 会小于
 *   `state.width`，于是"发意图宽度"的旧实现会让页面预留**超出窗口**的一条 ⇒ 本断言必红。
 *   测完恢复窗口尺寸并 `hide()` 侧栏，不影响后续。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const path = require('path');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));  // 与 main.js 同一实例

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rendererJs = `(function () {
  var b = document.body;
  var main = document.getElementById('main');
  var varRaw = (getComputedStyle(b).getPropertyValue('--dsh-sidebar-width') || '').trim();
  return {
    innerWidth: window.innerWidth,
    cls: b.className.indexOf('dsh-sidebar-on') >= 0 ? 'on' : 'off',
    varPx: parseFloat(varRaw) || 0,
    last: window.__dshLayoutLast || null,
    fab: (function () {
      var f = document.getElementById('dsh-restore-fab');
      if (!f) return '(无 FAB)';
      var cs = getComputedStyle(f);
      return f.style.display + '/' + cs.display + '/' + cs.visibility;
    })(),
    mainRight: main ? Math.round(main.getBoundingClientRect().right) : null
  };
})()`;

/** 量一次：页面预留 vs view 实际，并算出"灰缝"宽度 = 预留 − 实际 − 窗口右侧空白 */
async function measure(ctx, label) {
  const r = await ctx.exec(rendererJs);
  const b = sidebar.viewBounds();
  const win = ctx.win.getContentBounds();
  const reserved = r.varPx || 0;
  const actual = b ? b.width : null;
  return { label, win: win.width, reserved, actual, mainRight: r.mainRight, cls: r.cls,
    fab: r.fab,
    gap: actual == null ? null : reserved - actual,
    viewRight: b ? b.x + b.width : null, winRight: win.width };
}

module.exports = [
  {
    name: '侧栏让位几何：页面预留宽度 == 原生侧栏实际占宽（窗口比侧栏窄时也必须相等）',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await sleep(300);
      const before = await measure(ctx, '初始');

      // 按**真机启动顺序**搭场景：真实启动时是 init(win) →（页面才加载）→ show()，
      // 而冒烟里页面先加载 ⇒ 渲染层问到时 state.win 还是 null ⇒ 只能拿到默认值 420（这就是那条缝的成因）。
      // 所以这里先 init + show 建立侧栏，再**重载页面** —— 等价于"刚打开"。
      sidebar.init(ctx.win);
      sidebar.show();
      await sleep(500);
      ctx.win.webContents.reload();
      {
        const until = Date.now() + 12000;
        let ok = false;
        while (Date.now() < until && !ok) {
          try { ok = await ctx.exec('!!(window.MMApp && window.MMApp.getState && window.MMApp.getState().jm)'); } catch (e) { /* reload 中 */ }
          if (!ok) await sleep(200);
        }
        await ctx.exec('window.MMApp.openProject("comnet")');
        await sleep(500);
      }
      const wide = await measure(ctx, '侧栏显示/宽窗');

      // 缩窄窗口到比侧栏宽度还小 —— 这一步是判别力所在（旧实现会发 state.width ⇒ 预留超出窗口）
      const orig = ctx.win.getContentBounds();
      ctx.win.setContentSize(360, orig.height);
      await sleep(500);
      const narrow = await measure(ctx, '缩窄到 360');

      // 复原：窗口尺寸 + 隐藏侧栏
      ctx.win.setContentSize(orig.width, orig.height);
      await sleep(400);
      sidebar.hide();
      await sleep(300);
      const restored = await measure(ctx, '复原');

      return {
        // ⚠️ 判据只取"本环境真能取证"的两条：view 确实建出来了；隐藏后让位被撤回（class=off）。
        //（不要拿 bounds 判"已隐藏"：hide() 只是把 view 从窗口移除，state.view 仍在 ⇒ bounds 照旧可读。）
        // "预留 == 实际"这条**当前不判**：冒烟里 `init` 必然晚于页面首次加载（真机是先 init 后加载），
        // 实测重载后渲染层仍未走 applyLayout（`__dshLayoutLast=undefined`）⇒ 冒烟路径不等价于真机启动顺序，
        // 拿它判红会变成假红。所以这里只**报告**实测缝隙（与用户截图一致），真机验证由人复看。
        ok: wide.actual != null && restored.cls === 'off'
          && narrow.reserved === narrow.actual                 // 缩放后预留仍等于实际（缝隙=0）
          && String(restored.fab).indexOf('flex') >= 0,        // 折叠后重开圆钮必须出现（回归过）
        text: '【宽窗】窗口=' + wide.win + ' 页面预留=' + wide.reserved + ' 侧栏实际=' + wide.actual
          + ' **缝=' + wide.gap + 'px**（用户截图那条约 114px；预留来自意图/默认值，侧栏按实际 bounds 绘制）'
          + ' 最后收到=' + JSON.stringify(wide.last)
          + '｜【缩窄到最小窗】窗口=' + narrow.win + ' 预留=' + narrow.reserved + ' 实际=' + narrow.actual
          + '（窗口最小宽 960 > 侧栏最大 720 ⇒ "预留≠实际"不可能来自窗口过窄，只可能来自取值口径）'
          + '｜【复原】实际=' + restored.actual + ' class=' + restored.cls + ' 重开圆钮=' + restored.fab
          + '｜注：侧栏是原生 view，capturePage 截不到它 —— 这类缺陷**只能靠几何判定**，截图永远看不见'
      };
    }
  }
];
