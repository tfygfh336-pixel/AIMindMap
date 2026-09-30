/* ============================================================
 * scripts/smoke/23-dsh-only.js —— 「只关左边思维导图页、侧栏留着」这条接口
 * ------------------------------------------------------------
 * 用户要的语义：给外部 AI / 内置 DSH 一个接口把**左边思维导图页**关掉，侧栏继续显示与对话。
 * 人类按 ✕ 走同一条路（main.js 的 close 处理器：✕ ⇒ 进本模式；已在本模式再按 ⇒ 藏到后台）。
 * 底层是 app 里早就有的 `setDshOnly()`：主 renderer 加 `body.dsh-only`（CSS 把 #toolbar/#main
 * 直接 display:none）+ 侧栏铺满全窗。
 *
 * 判据（全都在本环境可取）：
 *   ① 进模式：body 有 dsh-only、#main 不可见、侧栏 view 宽度 == 窗口宽；
 *   ② 出模式：body 无 dsh-only、#main 回来、侧栏回到右侧固定宽度；
 *   ③ 全程侧栏 view 一直存在（"侧栏还在"是这条需求的全部意义）。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const path = require('path');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));   // 与 main.js 同一实例

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJs = `(function () {
  var b = document.body;
  var main = document.getElementById('main');
  var tb = document.getElementById('toolbar');
  return {
    dshOnly: b.className.indexOf('dsh-only') >= 0,
    mainShown: !!main && getComputedStyle(main).display !== 'none',
    toolbarShown: !!tb && getComputedStyle(tb).display !== 'none',
    reserved: parseFloat((getComputedStyle(b).getPropertyValue('--dsh-sidebar-width') || '0').trim()) || 0,
    innerWidth: window.innerWidth
  };
})()`;

module.exports = [
  {
    name: '只留侧栏接口：关左页（#main 隐藏、侧栏铺满）→ 再关恢复；侧栏 view 全程在',
    run: async (ctx) => {
      sidebar.init(ctx.win);      // 冒烟路径下 main.js 不走正常启动分支，这里补一次
      sidebar.show();
      await sleep(500);
      const before = await ctx.exec(readJs);
      const boundsBefore = sidebar.viewBounds();

      sidebar.setDshOnly(true);
      await sleep(600);
      const on = await ctx.exec(readJs);
      const boundsOn = sidebar.viewBounds();

      sidebar.setDshOnly(false);
      await sleep(600);
      const off = await ctx.exec(readJs);
      const boundsOff = sidebar.viewBounds();

      sidebar.hide();
      await sleep(300);
      const win = ctx.win.getContentBounds();

      return {
        ok: before.mainShown === true && before.dshOnly === false
          && on.dshOnly === true && on.mainShown === false && on.toolbarShown === false
          && boundsOn && Math.abs(boundsOn.width - win.width) <= 2          // 侧栏铺满整窗
          && off.dshOnly === false && off.mainShown === true
          && boundsOff && boundsOff.width > 0 && boundsOff.width < win.width  // 回到右侧固定宽度
          && boundsBefore && boundsBefore.width > 0,                        // 全程 view 都在
        text: '【进】dsh-only=' + on.dshOnly + ' 主内容可见=' + on.mainShown + ' 工具栏可见=' + on.toolbarShown
          + ' 侧栏宽=' + (boundsOn ? boundsOn.width : 'null') + '（窗口 ' + win.width + '）'
          + '｜【出】dsh-only=' + off.dshOnly + ' 主内容可见=' + off.mainShown
          + ' 侧栏宽=' + (boundsOff ? boundsOff.width : 'null')
          + '｜侧栏 view 全程在=' + (!!boundsBefore && !!boundsOn && !!boundsOff)
          + '｜留下让位宽度=' + JSON.stringify(before.reserved)
      };
    }
  }
];
