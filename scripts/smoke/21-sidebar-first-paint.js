/* ============================================================
 * scripts/smoke/21-sidebar-first-paint.js —— 刚打开时工具栏不被侧栏盖住
 * ------------------------------------------------------------
 * 用户实测："刚打开的时候菜单栏还是会被侧边栏遮盖，但是稍微拖动一下侧边栏就恢复了。"
 * 机制（读代码 + 复现）：侧栏是原生 WebContentsView，页面靠 CSS 变量让位：
 *     body.dsh-sidebar-on { --dsh-sidebar-width: 420px }
 *     body:not(.dsh-sidebar-on) { --dsh-sidebar-width: 0px }
 *     body.dsh-sidebar-on #toolbar { padding-right: calc(var(--dsh-sidebar-width) + 8px) }
 * 而**类与变量只在收到 `dsh-sidebar:layout` 事件时才设**，主进程首次发送发生在
 * `init(win)`（页面加载完成之前）⇒ 渲染层订阅还不存在 ⇒ 消息丢掉 ⇒ body 上两个类都没有
 * ⇒ `calc(var(--dsh-sidebar-width) + 8px)` 整条失效（变量未定义）⇒ 工具栏右端不 reserve
 * ⇒ 被原生侧栏盖住。拖一下侧栏 → setWidth → 再发一次事件 → 恢复正常。
 *
 * 判据两段（都可量化）：
 *   ① 机制取证：把类与变量清掉（等价于"没收到事件"），工具栏 padding-right 必须**不**等于
 *      宽度+8 —— 这就是用户看到的"被盖住"；
 *   ② 修复验证：整页重载（复现"刚打开"，且主进程的首次发送同样会丢）后，
 *      **不必拖任何东西**，类/变量/工具栏内边距就应当已经正确。
 * ② 的判别力：去掉渲染层的"主动问一次"或主进程的"加载后补发"，这条立刻变红。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJs = `(async function () {
  var b = document.body;
  var t = document.getElementById('toolbar');
  var st = null;
  try { st = await window.desktop.dsh.status(); } catch (e) { st = null; }
  return {
    cls: b.className.indexOf('dsh-sidebar-on') >= 0,
    inline: b.style.getPropertyValue('--dsh-sidebar-width') || '(未设)',
    eff: (getComputedStyle(b).getPropertyValue('--dsh-sidebar-width') || '').trim() || '(未定义)',
    pad: t ? getComputedStyle(t).paddingRight : '(无工具栏)',
    ref: window.__dshSidebarW,
    authoritative: st ? { visible: !!st.visible, width: st.width } : null
  };
})()`;

/** 等渲染层真正加载完（reload 期间 exec 会抛，必须容错） */
async function waitForBoot(ctx, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const ok = await ctx.exec('!!(window.MMApp && window.MMApp.getState && window.MMApp.getState().jm)');
      if (ok) return true;
    } catch (e) { /* reload 中 */ }
    await sleep(200);
  }
  return false;
}

module.exports = [
  {
    name: '侧栏让位：清掉类与变量会盖住工具栏（机制取证）；整页重载后**不必拖**就已正确',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec('new Promise(function (r) { setTimeout(r, 400); })');
      // 保证侧栏处于"显示"状态（若前面某条断言把它收起来了，这里先展开），否则本条无意义
      const pre = await ctx.exec(readJs);
      if (pre.authoritative && pre.authoritative.visible === false) {
        await ctx.exec('window.desktop.dsh.toggle()');
        await sleep(900);
      }
      const before = await ctx.exec(readJs);
      const W = (before.authoritative && before.authoritative.width) || 420;

      // ---- ① 机制取证：清掉类与变量 ⇒ 工具栏不 reserve（用户看到的"被盖住"）----
      const cleared = await ctx.exec(`(function () {
        document.body.classList.remove('dsh-sidebar-on');
        document.body.style.removeProperty('--dsh-sidebar-width');
        var t = document.getElementById('toolbar');
        return { pad: getComputedStyle(t).paddingRight,
                 eff: (getComputedStyle(document.body).getPropertyValue('--dsh-sidebar-width') || '').trim() || '(未定义)' };
      })()`);
      const clearedReserves = parseInt(cleared.pad, 10) >= W + 8;

      // ---- ② 修复验证：整页重载（"刚打开"）后，第一帧就应当已经让位 ----
      ctx.win.webContents.reload();
      const booted = await waitForBoot(ctx, 12000);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await sleep(500);
      const after = await ctx.exec(readJs);
      const W2 = (after.authoritative && after.authoritative.width) || W;
      const afterPad = parseInt(after.pad, 10);
      const reserves = afterPad >= W2 + 8;

      return {
        ok: before.authoritative && before.authoritative.visible === true   // 前置：侧栏确实是显示的
          && clearedReserves === false                                      // ① 清掉后确实不 reserve
          && booted === true                                                // 重载完成
          && after.cls === true                                             // ② 类已加
          && after.eff === W2 + 'px'                                        // ② 变量已定义（不是"未定义"）
          && reserves,                                                      // ② 工具栏已让位
        text: '权威布局 visible=' + (before.authoritative && before.authoritative.visible) + ' width=' + W
          + '｜① 清掉类+变量后：工具栏 padding-right=' + cleared.pad + '（须 <' + (W + 8) + '，即不 reserve）'
          + ' 变量=' + cleared.eff
          + '｜② 重载后（未拖任何东西）：class=' + after.cls + ' 变量=' + after.eff
          + ' 工具栏 padding-right=' + after.pad + '（须 ≥' + (W2 + 8) + '）'
          + ' __dshSidebarW=' + after.ref
      };
    }
  }
];
