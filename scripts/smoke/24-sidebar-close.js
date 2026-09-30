/* ============================================================
 * scripts/smoke/24-sidebar-close.js —— 「保留主界面、独立关掉侧栏 DSH」（反方向那条）
 * ------------------------------------------------------------
 * 用户要的对称能力：
 *   · 导图页右上角 ✕  ⇒ 只关左边导图页、留侧栏（`sidebar-only`，断言在 23-*）
 *   · 侧栏右上角 ✕（在「—」**下面**）⇒ 保留主界面、关掉侧栏 DSH（本文件）
 * 还钉住两条用户实测反馈：
 *   ① 两个按钮**不能重叠**，且 ✕ 必须在「—」下面；
 *   ② 「—」不能再钉在 y=4（会压住 DSH 页面自己的头部 UI）⇒ 断言 y 有下移量。
 * 安全性：断言用 `closeSidebar({ keepService: true })` —— 冒烟进程可能正接管着用户的真实
 * 服务，断言绝不能把它杀掉 ✗（只验 view/几何那一半）。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const path = require('path');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJs = `(function () {
  var b = document.body;
  var main = document.getElementById('main');
  return {
    reserved: parseFloat((getComputedStyle(b).getPropertyValue('--dsh-sidebar-width') || '0').trim()) || 0,
    mainShown: !!main && getComputedStyle(main).display !== 'none',
    innerWidth: window.innerWidth
  };
})()`;

module.exports = [
  {
    name: '独立关侧栏：控制栏与 DSH 页面零重叠、✕ 在「—」下面；关掉后主界面铺满、可再打开；「⤢」真能恢复',
    run: async (ctx) => {
      sidebar.init(ctx.win);
      sidebar.show();
      await sleep(500);

      const bb = await sidebar.buttonBounds();
      const dom = await sidebar.buttonProbe();
      const view = sidebar.viewBounds();
      const win = ctx.win.getContentBounds();
      const before = await ctx.exec(readJs);

      // 「⤢ 恢复导图页」曾经是**死键**（页面发 [dsh-restore]、主进程根本没这个分支 ✗）——
      // 现在点一下真按钮验它：进仅侧栏模式 → 点「—」（此时它是 ⤢）→ 必须回到正常模式。
      sidebar.setDshOnly(true);
      await sleep(400);
      const onlyOn = sidebar.isDshOnly();
      await sidebar.clickButton('collapse');
      await sleep(500);
      const onlyOff = sidebar.isDshOnly();
      sidebar.setDshOnly(false);
      await sleep(300);

      // 关侧栏（只收 view，不动服务 —— 见文件头说明）
      sidebar.closeSidebar({ keepService: true });
      await sleep(500);
      const closed = await ctx.exec(readJs);
      const afterClose = sidebar.getStatus();

      // 再打开（人走的那条路：主界面右缘的 🤖）
      sidebar.show();
      await sleep(500);
      const reopened = sidebar.getStatus();
      sidebar.hide();
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
      // DOM 门禁：两个按钮**真的存在**、都有可点内容，且页面里恰好 2 个 button
      //（① 之后 −/✕ 同处**一个**控制栏页面 ⇒ 计数是 2，不是 1）。
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
      //   ① 状态机：需要就加宽到目标宽度、幂等、关掉还原（只在我们还在自动宽度时还原 ✓）
      //   ② 注入契约：观察器脚本必须靠**官方属性**判事实、并且**必须有意图信号**
      //      （宽度不够时官方属性不会变 ⇒ 光看属性检测不到用户点击 ✗ —— 这是实测踩到的坑）
      sidebar.setWidth(694);
      await sleep(200);
      const wide1 = sidebar.ensureRightbarRoom();          // view 664 < 756 ⇒ 应加宽
      await sleep(200);
      const w1 = sidebar.getStatus().width;
      const wide2 = sidebar.ensureRightbarRoom();          // 已在自动状态 ⇒ 幂等
      await sleep(100);
      const w2 = sidebar.getStatus().width;
      const released = sidebar.releaseRightbarRoom();      // 关掉 ⇒ 还原
      await sleep(200);
      const w3 = sidebar.getStatus().width;
      sidebar.setWidth(900);
      await sleep(100);
      const alreadyWide = sidebar.ensureRightbarRoom();    // 已经够宽 ⇒ 不动
      await sleep(100);
      await sidebar.releaseRightbarRoom();
      const js = sidebar.RIGHTBAR_WATCHER_JS || '';
      const watcherOk = ['data-rightbar-collapsed', 'dsh-rightbar-request', 'dsh-rightbar-open',
        'dsh-rightbar-closed', 'Ctrl', 'Open sidebar'].every((k) => js.indexOf(k) >= 0)
        && sidebar.RIGHTBAR_AUTO_WIDTH > sidebar.RIGHTBAR_PAGE_MIN;

      // 【真机 bug 的回归门禁】"观察器装不上"这件事，只验状态机是发现不了的 ✗：
      // 注入时机撞上页面自身加载时 `executeJavaScript` 会**永不返回** ⇒ state.rightbarWatcher
      // 停在 null ⇒ 观察器永远不装 ⇒「打开侧边栏」永远不触发自动加宽 ✗（用户截图那次全靠运气）。
      // 判据：调用必须**有终态**（超时也算 ✓），且状态里能看到它 —— 不许停在 null ✓。
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

      return {
        ok: noOverlap && sep && totalOk && domOk && cssOk && autoOk && watcherOk && installOk
          && onlyOn === true && onlyOff === false                      // 「⤢」点了真管用
          && closed.mainShown === true && closed.reserved === 0        // 主界面铺满（让位宽度归零）
          && before.reserved > 0                                       // 关之前确实让过位
          && afterClose.visible === false                              // view 已收
          && reopened.visible === true,                                // 能再打开
        text: '【结构】控制栏 x=' + (bb.rail ? bb.rail.x : 'null') + ' w=' + (bb.rail ? bb.rail.width : 'null')
          + ' 与页面零重叠=' + noOverlap + ' 让位=控制栏+内容=' + totalOk + '（' + bb.occupiedWidth + '）'
          + '｜【几何】— y=' + (bb.collapse ? bb.collapse.y : 'null')
          + ' ✕ y=' + (bb.close ? bb.close.y : 'null')
          + ' 同列=' + (bb.collapse && bb.close ? bb.collapse.x === bb.close.x : 'null')
          + ' 都在栏内=' + (inRail(bb.collapse) && inRail(bb.close))
          + '｜【DOM】— ' + JSON.stringify(dom && dom.collapse) + ' ✕ ' + JSON.stringify(dom && dom.close)
          + '｜【⤢】进=' + onlyOn + ' 点击后=' + onlyOff
          + '｜【③ 注入规则】必备项齐全=' + cssOk
          + '｜【右栏自动加宽】加宽=' + wide1 + '/' + w1 + ' 幂等=' + (wide2 === false)
          + ' 还原=' + released + '/' + w3 + ' 已够宽不动=' + (alreadyWide === false)
          + ' 契约=' + watcherOk
          + ' 安装有终态=' + installOk + '（' + installMs + 'ms，状态=' + JSON.stringify(watcherState) + '）'
          + '｜【关后】主内容可见=' + closed.mainShown + ' 让位宽度=' + closed.reserved
          + ' visible=' + afterClose.visible
          + '｜【重开】visible=' + reopened.visible
          + '｜窗口 ' + win.width
      };
    }
  }
];
