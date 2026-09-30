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
    name: '独立关侧栏：✕ 在「—」下方且不重叠、「—」已下移；关掉后主界面铺满、可再打开',
    run: async (ctx) => {
      sidebar.init(ctx.win);
      sidebar.show();
      await sleep(500);

      const bb = sidebar.buttonBounds();
      const view = sidebar.viewBounds();
      const win = ctx.win.getContentBounds();
      const before = await ctx.exec(readJs);

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

      const sep = bb.collapse && bb.close
        && bb.close.y >= bb.collapse.y + bb.collapse.height        // ✕ 在「—」下面，不重叠
        && bb.collapse.y >= 24                                     // 已下移（原先是 4）
        && bb.collapse.x === bb.close.x;                            // 同一列
      const inside = bb.collapse && view
        && bb.collapse.x + bb.collapse.width <= view.x + view.width + 2;

      return {
        ok: !!sep && !!inside
          && closed.mainShown === true && closed.reserved === 0       // 主界面铺满（让位宽度归零）
          && before.reserved > 0                                      // 关之前确实让过位
          && afterClose.visible === false                             // view 已收
          && reopened.visible === true,                               // 能再打开
        text: '【几何】— y=' + (bb.collapse ? bb.collapse.y : 'null')
          + ' ✕ y=' + (bb.close ? bb.close.y : 'null')
          + ' 同列=' + (bb.collapse && bb.close ? bb.collapse.x === bb.close.x : 'null')
          + ' 在侧栏内=' + !!inside
          + '｜【关后】主内容可见=' + closed.mainShown + ' 让位宽度=' + closed.reserved
          + ' visible=' + afterClose.visible
          + '｜【关前让位】' + before.reserved
          + '｜【重开】visible=' + reopened.visible
          + '｜侧栏宽=' + (view ? view.width : 'null') + '（窗口 ' + win.width + '）'
      };
    }
  }
];
