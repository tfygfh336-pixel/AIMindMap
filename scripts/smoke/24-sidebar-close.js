/* ============================================================
 * scripts/smoke/24-sidebar-close.js —— 「保留主界面、独立关掉侧栏 DSH」+ 侧栏 ✕ = **真销毁视图**
 * ------------------------------------------------------------
 * 用户要的对称能力（两条都是"真关"，见 README「只改一边，不用全部重启」）：
 *   · 导图页右上角 ✕  ⇒ **卸载导图页**、留侧栏（断言在 23-*）
 *   · 侧栏右上角 ✕（在「—」**下面**）⇒ 保留主界面、关掉侧栏 DSH（本文件）
 * 本文件钉住三层：
 *   ① 结构：控制栏与 DSH 页面零重叠、✕ 在「—」下面；让位宽度 = 控制栏 + 内容；DOM 里真有按钮；
 *   ② **真关**：关掉之后那 30px 之外的 WebContentsView **被销毁**（不是摘下来挂着 ✗）——
 *      判据 `hasView=false` / `viewId=null` / `lastDestroyedViewId=旧 id` / `webContents.fromId(旧 id)`
 *      已经取不到；重开必须是**新视图**（`viewEpoch` +1、id 变了 ⇒ 不是把旧的又挂回来 ✓）；
 *   ③ 回去的路：「⤢」真能恢复导图页（曾是和 ✕ 一样的死键 ✗）—— 现在它 = 重新加载导图页。
 * 安全性：关的那半用 `closeSidebar({ keepService: true })` —— 冒烟进程可能正接管着用户的真实
 * 服务，断言绝不能把它杀掉 ✗（只验 view/几何那一半）。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const path = require('path');
const { webContents } = require('electron');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJs = `(function () {
  var b = document.body;
  var main = document.getElementById('main');
  return {
    reserved: parseFloat((getComputedStyle(b).getPropertyValue('--dsh-sidebar-width') || '0').trim()) || 0,
    mainShown: !!main && getComputedStyle(main).display !== 'none',
    hasMMApp: typeof window.MMApp !== 'undefined',
    innerWidth: window.innerWidth
  };
})()`;

/** 等一个"页面已经能跑 JS"的状态（重开后要重新加载 ⇒ 不能立刻 exec） */
async function waitPageBack(ctx, timeoutMs) {
  const until = Date.now() + (timeoutMs || 9000);
  while (Date.now() < until) {
    try {
      const r = await ctx.exec(readJs);
      if (r && r.hasMMApp) return r;
    } catch (e) { /* 导航中：等下一轮 */ }
    await sleep(300);
  }
  return null;
}

module.exports = [
  {
    name: '侧栏 ✕ 是真关：视图被销毁（取不到旧 id）+ 主界面铺满；重开重建**新**视图；「⤢」真能恢复导图页',
    run: async (ctx) => {
      sidebar.init(ctx.win);
      sidebar.show();
      await sleep(500);

      // ── ① 结构（关之前就取，避免后面重载页面影响取样）─────────────────────────────
      const bb = await sidebar.buttonBounds();
      const dom = await sidebar.buttonProbe();
      const view = sidebar.viewBounds();
      const win = ctx.win.getContentBounds();
      const before = await ctx.exec(readJs);
      const st0 = sidebar.getStatus();

      // ── ② 真关：收 view + **销毁**它（服务用 keepService 保住）─────────────────────
      sidebar.closeSidebar({ keepService: true });
      let destroyed = false;
      const oldId = st0.viewId;
      for (let i = 0; i < 10 && !destroyed; i++) {
        await sleep(200);
        const live = (oldId === null || oldId === undefined) ? null : webContents.fromId(oldId);
        destroyed = !live || live.isDestroyed();
      }
      const closed = await ctx.exec(readJs);
      const st1 = sidebar.getStatus();
      const viewGone = sidebar.viewBounds() === null;      // 视图**真的不在**（不是"占宽数字变小"）
      const occupiedClosed = sidebar.occupiedWidth();      // ⚠️ 控制栏的旧 bounds 还留着 ⇒ 这里会报 30，
                                                          // 只当参考；"关掉了"的判据是上面那条 viewGone ✓

      // ── ③ 重开（人走的那条路：主界面右缘的 🤖）：必须是**新视图** ────────────────
      sidebar.show();
      await sleep(600);
      const st2 = sidebar.getStatus();
      const view2 = sidebar.viewBounds();

      // ── ④ 回去的路：「⤢ 恢复导图页」= 重新加载导图页（真卸载之后没有"挂回来"这回事）──
      await sidebar.closeMapPage({ confirmed: true });
      await sleep(500);
      const railOnly = await sidebar.buttonProbe();      // 仅侧栏模式下「—」的字形换成「⤢」
      const onlyOn = sidebar.isDshOnly();
      await sidebar.clickButton('collapse');
      const back = await waitPageBack(ctx, 9000);
      const onlyOff = sidebar.isDshOnly();
      const mapClosed = sidebar.getStatus().mapPageClosed;
      await sidebar.hide();
      await sleep(300);

      // ① 的结构判据：**控制栏整体在 DSH 页面左边**（零重叠）—— 这是"以后装什么插件都不会被挡"的依据 ✓
      const noOverlap = !!(bb.rail && view && bb.rail.x + bb.rail.width <= view.x + 1);
      // 两个按钮都在控制栏里、✕ 在 − 下面不重叠、同一列
      const inRail = (r) => !!(r && bb.rail
        && r.x >= bb.rail.x - 1 && r.x + r.width <= bb.rail.x + bb.rail.width + 1
        && r.y >= bb.rail.y - 1 && r.y + r.height <= bb.rail.y + bb.rail.height + 1);
      const sep = !!(bb.collapse && bb.close)
        && bb.close.y >= bb.collapse.y + bb.collapse.height
        && bb.collapse.x === bb.close.x
        && inRail(bb.collapse) && inRail(bb.close);
      // 让位宽度 = 控制栏 + 内容（只报 view 会少一条 ⇒ 又出灰缝 ✗）
      const totalOk = bb.occupiedWidth === (bb.rail ? bb.rail.width : 0) + (view ? view.width : 0);
      // DOM 门禁：两个按钮**真的存在**、都有可点内容，且页面里恰好 2 个 button。
      // 这条是冲着一个真机 bug 来的：data: URL 页里属性少写一个引号 ⇒ `<button>` 被吞进属性值，
      // 页面照常加载（有底色）但**没有按钮、点了没反应** ✗ —— 只查几何永远发现不了。
      const domOk = ['collapse', 'close'].every((k) => {
        const d = dom && dom[k];
        return d && d.hasEl === true && d.buttons === 2 && d.text && d.text.length > 0;
      });

      // ③ 的注入规则**内容**本身也要钉住：空 CSS / 少了关键规则同样是"没做"，但外观上
      // 谁也看不出来（DSH 页面照样能跑 ✗）⇒ 机械检查这几条必备规则在不在。
      const css = sidebar.NARROW_CSS || '';
      const cssOk = ['min-width:0', '.dsh-narrow', '.dsh-narrow-xs', 'overflow-x:hidden']
        .every((k) => css.indexOf(k) >= 0);

      // 右栏 ⇄ 自动加宽（用户要求）：几何状态机 + 注入契约
      sidebar.setWidth(694);
      await sleep(200);
      const wide1 = sidebar.ensureRightbarRoom();
      await sleep(200);
      const w1 = sidebar.getStatus().width;
      const wide2 = sidebar.ensureRightbarRoom();
      await sleep(100);
      const w2 = sidebar.getStatus().width;
      const released = sidebar.releaseRightbarRoom();
      await sleep(200);
      const w3 = sidebar.getStatus().width;
      sidebar.setWidth(900);
      await sleep(100);
      const alreadyWide = sidebar.ensureRightbarRoom();
      await sleep(100);
      await sidebar.releaseRightbarRoom();
      const js = sidebar.RIGHTBAR_WATCHER_JS || '';
      const watcherOk = ['data-rightbar-collapsed', 'dsh-rightbar-request', 'dsh-rightbar-open',
        'dsh-rightbar-closed', 'Ctrl', 'Open sidebar'].every((k) => js.indexOf(k) >= 0)
        && sidebar.RIGHTBAR_AUTO_WIDTH > sidebar.RIGHTBAR_PAGE_MIN;

      // 【真机 bug 的回归门禁】"观察器装不上"这件事，只验状态机是发现不了的 ✗：
      // 注入时机撞上页面自身加载时 `executeJavaScript` 会**永不返回** ⇒ state.rightbarWatcher
      // 停在 null ⇒ 观察器永远不装 ⇒「打开侧边栏」永远不触发自动加宽 ✗（用户截图那次全靠运气）。
      const tInstall = Date.now();
      await sidebar.installRightbarWatcher().catch(() => {});
      const installMs = Date.now() - tInstall;
      const watcherState = sidebar.getStatus().rightbarWatcher;
      const installOk = installMs < 6000
        && typeof watcherState === 'string' && watcherState.length > 0;
      const autoOk = wide1 === true && w1 === sidebar.RIGHTBAR_AUTO_WIDTH
        && wide2 === false && w2 === w1                       // 幂等
        && released === true && w3 === 694                    // 还原到用户原宽度
        && alreadyWide === false;                             // 够宽就别动
      sidebar.setWidth(694);
      await sleep(200);

      // ② 的判据：**销毁**了（不是摘下来挂着）—— 五件事一起看，缺一件就是"看起来关了"
      const destroyOk = st1.hasView === false && st1.viewId === null
        && oldId !== null && st1.lastDestroyedViewId === oldId && destroyed
        && viewGone;
      // ③ 的判据：重开是**新**视图（epoch +1、id 变了）—— 旧的又挂回来会同时踩着这两条 ✗
      const rebuildOk = st2.hasView === true && st2.viewId !== null && st2.viewId !== oldId
        && st2.viewEpoch === st0.viewEpoch + 1
        && !!view2 && view2.width > 0;
      // ④ 的判据：「⤢」真的把导图页带回来（曾是和 ✕ 一样的死键 ✗）
      const restoreOk = onlyOn === true && onlyOff === false && mapClosed === false
        && !!back && back.hasMMApp === true
        && !!(railOnly && railOnly.collapse && railOnly.collapse.text === '⤢');

      return {
        ok: noOverlap && sep && totalOk && domOk && cssOk && autoOk && watcherOk && installOk
          && destroyOk && rebuildOk && restoreOk
          && closed.mainShown === true && closed.reserved === 0        // 主界面铺满（让位宽度归零）
          && before.reserved > 0                                       // 关之前确实让过位
          && st0.visible === true && st1.visible === false,            // view 已收 + 能再打开
        text: '【结构】控制栏 x=' + (bb.rail ? bb.rail.x : 'null') + ' w=' + (bb.rail ? bb.rail.width : 'null')
          + ' 与页面零重叠=' + noOverlap + ' 让位=控制栏+内容=' + totalOk + '（' + bb.occupiedWidth + '）'
          + '｜【几何】— y=' + (bb.collapse ? bb.collapse.y : 'null')
          + ' ✕ y=' + (bb.close ? bb.close.y : 'null')
          + '｜【DOM】按钮齐全=' + domOk
          + '｜【真关】旧 view id=' + oldId + ' ⇒ hasView=' + st1.hasView + ' viewId=' + st1.viewId
          + ' lastDestroyedViewId=' + st1.lastDestroyedViewId + ' 旧 id 已取不到=' + destroyed
          + ' 视图已不在=' + viewGone + '（occupiedWidth 仍会报控制栏旧 bounds ' + occupiedClosed + '，只作参考）'
          + '｜【重开】新 id=' + st2.viewId + ' epoch ' + st0.viewEpoch + '→' + st2.viewEpoch
          + ' w=' + (view2 ? view2.width : 'null')
          + '｜【⤢】进=' + onlyOn + '（字形 ' + (railOnly && railOnly.collapse && railOnly.collapse.text) + '）'
          + ' 点击后=' + onlyOff + ' mapClosed=' + mapClosed + ' 页面回来=' + !!(back && back.hasMMApp)
          + '｜【③ 注入】必备项齐全=' + cssOk + ' 契约=' + watcherOk + ' 安装有终态=' + installOk + '（' + installMs + 'ms）'
          + '｜【右栏自动加宽】加宽=' + wide1 + '/' + w1 + ' 还原=' + released + '/' + w3 + '＝' + autoOk
          + '｜【关后】主内容可见=' + closed.mainShown + ' 让位=' + closed.reserved
          + '｜窗口 ' + win.width
      };
    }
  }
];
