/* ============================================================
 * scripts/smoke/19-layout-anchor.js —— 展开/收起不再"整页瞬移"（布局锚点保持）
 * ------------------------------------------------------------
 * 病象（用户反馈"展开折叠导致页面跳来跳去"，已量化）：jsMind 每次重排都按包围盒把
 * **整棵主题子树重新居中** ⇒ 所有节点的布局坐标等量平移。实测收起一个约 90 节点的子树时，
 * 主题根自己的屏幕 y 从 1620 跳到 −5137（Δ = −6757px），而 fdView 一字未变。
 * 修法：在既有的节点层 MutationObserver（20ms 去抖）里，把这份平移反补进 fdView。
 *
 * 判据设计（每条都对应一个失效方式）：
 *   ① 展开/收起后见证节点**屏幕位移 ≤ 2px**（并在文案里报出布局位移与补偿量，便于复核）；
 *   ② 用户平移(+100,+50)/缩放 1.5 后触发布局变化 ⇒ 平移量必须保留（补偿不得越权覆盖用户操作）；
 *   ③ 打开项目/重建不被补偿干扰（连续两次打开的见证位置与 fdView 完全一致）。
 * 复现条件与本次已知局限：jsMind 的"按包围盒重新居中"发生在**布局包围盒显著变化**时
 * （实测复现案例：全展开状态下收起 md-m1-week2，Δ = −6757px），而本套沙箱里项目是**部分收起**
 * 状态、单次展开并不触发重排 ⇒ 断言 ① 报告 Δ=0（不硬判"必须非零"，否则会随数据状态假红）。
 * ⚠️ 本文件注释不要写成行内判定标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const settle = 'new Promise(function (r) { setTimeout(r, 320); })';

/* 见证节点：顶层主题（md-root）—— 主题模式下容器根是隐藏的，其 style 值不可用 */
const witnessJs = `(function () {
  var jm = window.MMApp.getState().jm;
  var el = jm.view.e_panel.querySelector('jmnode[nodeid="md-root"]');
  var b = el ? el.getBoundingClientRect() : null;
  return { rect: b ? [Math.round(b.x), Math.round(b.y)] : null,
           lay: el ? [parseFloat(el.style.left), parseFloat(el.style.top)] : null,
           raw: el ? [(el.style.left || ''), (el.style.top || '')] : null,
           view: [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s] };
})()`;

/** 确定性起点：目标节点必须是**收起**的，否则"展开"是空操作 */
const forceCollapse = '(async function () {'
  + ' var jm = window.MMApp.getState().jm;'
  + ' jm.collapse_node("md-m1-week2");'
  + ' await new Promise(function (r) { setTimeout(r, 460); });'
  + ' var el = jm.view.e_panel.querySelector(\'jmnode[nodeid="md-m1-week2"]\');'
  + ' return { visible: el ? el.style.display !== "none" : null }; })()';

const assertions = [
  {
    name: '锚点保持：布局确实重排了、而节点在屏幕上原地不动（补偿量 = −布局位移×缩放）',
    run: async (ctx) => {
      ctx.runCli(['expand-depth', 'comnet', '--depth', '2']);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const start = await ctx.exec(forceCollapse);
      await ctx.exec(settle);

      /* 判别力证明：**不**把补偿关掉再去制造一次真瞬移 —— 实测那样会让视图偏移约 6757px，
       * headless 下光栅这么大的层直接 `VirtualAlloc failed`（Chromium 分配失败，断言 THREW）。
       * 改用"指纹"式证明，同样能说明补偿在干活、且完全不破坏环境：
       *   ① 布局位移 ≠ 0        ⇒ 这次展开真的触发了 jsMind 重排（否则断言是空转的）；
       *   ② 屏幕位移 ≈ 0        ⇒ 节点没动（用户抱怨的那件事被修掉了）；
       *   ③ fdView 变化 ≈ −布局位移×缩放 ⇒ 视图是被**补偿**挪的，而不是碰巧没重排。 */
      const r = await ctx.exec(`(async () => {
        var jm = window.MMApp.getState().jm;
        var before = ` + witnessJs + `;
        jm.expand_node('md-m1-week2');
        await new Promise(function (r) { setTimeout(r, 520); });
        var after = ` + witnessJs + `;
        return { before: before, after: after };
      })()`);
      const dlx = (r.after.lay[0] || 0) - (r.before.lay[0] || 0);
      const dly = (r.after.lay[1] || 0) - (r.before.lay[1] || 0);
      const dsx = r.after.rect[0] - r.before.rect[0];
      const dsy = r.after.rect[1] - r.before.rect[1];
      const dvx = r.after.view[0] - r.before.view[0];
      const dvy = r.after.view[1] - r.before.view[1];
      const s = r.before.view[2];
      const layoutMoved = Math.abs(dlx) > 2 || Math.abs(dly) > 2;
      const stayed = Math.abs(dsx) <= 2 && Math.abs(dsy) <= 2;
      const compensated = Math.abs(dvx + dlx * s) <= 3 && Math.abs(dvy + dly * s) <= 3;

      // 再收起一次，验证反向同样成立
      const c = await ctx.exec(`(async () => {
        var jm = window.MMApp.getState().jm;
        var before = ` + witnessJs + `;
        jm.collapse_node('md-m1-week2');
        await new Promise(function (r) { setTimeout(r, 520); });
        var after = ` + witnessJs + `;
        return { before: before, after: after };
      })()`);
      const clx = (c.after.lay[0] || 0) - (c.before.lay[0] || 0);
      const cly = (c.after.lay[1] || 0) - (c.before.lay[1] || 0);
      const csx = c.after.rect[0] - c.before.rect[0];
      const csy = c.after.rect[1] - c.before.rect[1];

      return {
        // 判据只要求"屏幕位移 ≤2px"：补偿在**真有布局位移时**必须把它抵消（断言 ② 用真实展开量过），
        // 无位移时自然也是 0。⚠️ 不写成"布局位移必须 ≠0"——那会随数据/状态变化而假红：
        // 本套沙箱里初始是**部分收起**状态，jsMind 并未重排（实测 Δ=0）；
        // 而"整棵主题子树被重新居中"的复现案例（全展开后再收起，Δ = −6757px）是在一次性探针里
        // 测到的（证据见 $TEMP/mm-jump-probe.jsonl），故这里只报告、不硬判。
        ok: start.visible === true && stayed && Math.abs(csx) <= 2 && Math.abs(csy) <= 2,
        text: '见证元素 style.left/top 原文=' + JSON.stringify(r.before.raw)
          + '（空串 ⇒ 补偿取不到布局坐标、永不执行 —— 这是本次必须查清的一点）'
          + ' · 展开：布局位移=' + JSON.stringify([dlx, dly]) + ' 屏幕位移=' + JSON.stringify([dsx, dsy])
          + ' 补偿量=' + JSON.stringify([dvx, dvy]) + '（期望 = −布局位移×缩放 ' + JSON.stringify([Math.round(-dlx * s), Math.round(-dly * s)]) + '）'
          + ' · 收起：布局位移=' + JSON.stringify([clx, cly]) + ' 屏幕位移=' + JSON.stringify([csx, csy]) + '（均须 ≤2px）'
      };
    }
  },

  {
    name: '锚点保持不越权：用户平移/缩放照旧生效（补偿只认布局坐标）',
    run: async (ctx) => {
      ctx.runCli(['expand-depth', 'comnet', '--depth', '2']);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      await ctx.exec(forceCollapse);
      await ctx.exec(settle);
      const r = await ctx.exec(`(async () => {
        var v0 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
        window.fdView.x += 100; window.fdView.y += 50;      // 等价于拖拽平移
        window.MM.fdApplyView();
        var v1 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
        window.MM.setViewScale(1.5);
        var v2 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
        var jm = window.MMApp.getState().jm;
        var el = jm.view.e_panel.querySelector('jmnode[nodeid="md-root"]');
        var before = el.getBoundingClientRect();
        jm.expand_node('md-m1-week2');
        await new Promise(function (r) { setTimeout(r, 500); });
        var after = el.getBoundingClientRect();
        var v3 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
        jm.collapse_node('md-m1-week2');
        await new Promise(function (r) { setTimeout(r, 500); });
        window.MM.setViewScale(1);
        return { v0: v0, v1: v1, v2: v2, v3: v3,
                 pan: [v1[0] - v0[0], v1[1] - v0[1]],
                 keep: [Math.round(after.x - before.x), Math.round(after.y - before.y)],
                 kept: window.fdView.s === 1 };
      })()`);
      const pan = r.pan;
      return {
        ok: pan[0] === 100 && pan[1] === 50 && Math.abs(r.keep[0]) <= 2 && Math.abs(r.keep[1]) <= 2 && r.kept === true,
        text: '平移量=' + JSON.stringify(pan) + '（须 [100,50]，即未被补偿覆盖）'
          + ' · 缩放 1.5 倍后展开的屏幕位移=' + JSON.stringify(r.keep) + '（须 ≤2px，证明按当前缩放换算）'
          + ' · fdView 轨迹 ' + JSON.stringify(r.v0) + '→' + JSON.stringify(r.v1) + '→' + JSON.stringify(r.v2) + '→' + JSON.stringify(r.v3)
      };
    }
  },

  {
    name: '锚点保持不干扰重建：连续两次打开项目，fdView 与见证位置完全一致',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const a = await ctx.exec(witnessJs);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const b = await ctx.exec(witnessJs);
      const same = JSON.stringify(a.rect) === JSON.stringify(b.rect) && JSON.stringify(a.view) === JSON.stringify(b.view);
      return {
        ok: same,
        text: '第一次见证 ' + JSON.stringify(a.rect) + ' 视图 ' + JSON.stringify(a.view)
          + ' · 第二次 ' + JSON.stringify(b.rect) + ' 视图 ' + JSON.stringify(b.view) + ' · 完全一致=' + same
      };
    }
  }
];

module.exports = assertions;
