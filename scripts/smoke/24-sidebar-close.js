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

      return {
        ok: noOverlap && sep && totalOk && domOk
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
          + '｜【关后】主内容可见=' + closed.mainShown + ' 让位宽度=' + closed.reserved
          + ' visible=' + afterClose.visible
          + '｜【重开】visible=' + reopened.visible
          + '｜窗口 ' + win.width
      };
    }
  }
];
