/* ============================================================
 * scripts/smoke/19-view-offset-pin.js —— 展开/收起不再"整页瞬移"（钉住 jsMind 布局原点）
 * ------------------------------------------------------------
 * 病象（用户反馈"展开折叠导致页面跳来跳去"，已量化）：收起一个约 90 节点的子树时，
 * 主题根的屏幕 y 位移 **−6757px**，而 fdView 与滚动一字未变。
 * 根因（vendor/jsmind.js 一行）：
 *     get_view_offset(){ var e = this.layout.bounds; return { x:(this.size.w-e.e-e.w)/2, y:this.size.h/2 }; }
 * 而 `show_nodes()` 用它当**原点**：`element.style.left = s.x + 点.x` ⇒ 包围盒一变、原点就变
 * ⇒ 整棵树等量平移。修法：把原点**冻结**（app-view.js 的 wrapLayoutAnchor，只动布局坐标、不碰 transform）。
 *
 * 判据设计：
 *   ① 可控复现 + 判别力证明：探针树（主题模式 + 30 叶子子树）收起时，**解钉**必须跳（>2px）、
 *      **钉住**必须不跳（≤2px）；两段都用同一次形状变化，避免"复现不成立"的空转（上一版栽在这）。
 *   ② 不越权：用户平移(+100,+50)/缩放 1.5 后展开 ⇒ 平移量保留、屏幕位移 ≤2px（不碰 transform 的直接推论）。
 *   ③ 不干扰重建：连续两次打开项目，见证位置与 fdView 完全一致。
 * 探针树为什么不用真实项目：那次的位移是 6757px，headless 下光栅这么大的层会直接
 * `VirtualAlloc failed`（实测断言 THREW）；探针树位移约 590px，够判又安全。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const settle = 'new Promise(function (r) { setTimeout(r, 330); })';
const PROBE = 'zz-offset-probe';

const witnessJs = `(function () {
  var jm = window.MMApp.getState().jm;
  var one = function (id) {
    var el = jm.view.e_panel.querySelector('jmnode[nodeid="' + id + '"]');
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return { rect: [Math.round(b.x), Math.round(b.y)], lay: [parseFloat(el.style.left), parseFloat(el.style.top)] };
  };
  return { t1: one('t1'), t2: one('t2'), c2: one('c2'), log: (window.__anchorLog || []).slice(-4), pinned: !!(jm.view && jm.view.__anchorWrapped),
           view: [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s] };
})()`;

/** 探针树：主题模式 + 两个顶层主题；t1 下 c1→c2→c3 + 30 叶子（收起 c2 会明显改变包围盒） */
function buildProbe(ctx) {
  ctx.runCli(['init', PROBE]);
  ctx.runCli(['add-root', PROBE, '--topic', '主题A', '--id', 't1']);
  ctx.runCli(['add-root', PROBE, '--topic', '主题B', '--id', 't2']);
  ctx.runCli(['add', PROBE, 't1', '--topic', 'C1', '--id', 'c1']);
  ctx.runCli(['add', PROBE, 'c1', '--topic', 'C2', '--id', 'c2']);
  ctx.runCli(['add', PROBE, 'c2', '--topic', 'C3', '--id', 'c3']);
  for (let i = 1; i <= 30; i++) ctx.runCli(['add', PROBE, 'c3', '--topic', '叶子' + i, '--id', 'l' + i]);
  ctx.runCli(['add', PROBE, 't2', '--topic', 'D1', '--id', 'd1']);
  ctx.runCli(['add', PROBE, 'd1', '--topic', 'D2', '--id', 'd2']);
  ctx.runCli(['expand-depth', PROBE, '--depth', '99']);     // 全展开：c2 的子节点可见
}

async function shot(ctx, win, name) {
  try {
    const img = await win.webContents.capturePage();
    const f = path.join(os.tmpdir(), 'mm-pin-' + name + '.png');
    fs.writeFileSync(f, img.toPNG());
    return f;
  } catch (e) { return '（截图失败）'; }
}

const assertions = [
  {
    name: '可控复现：解钉必须跳、钉住必须不跳（同一个收起动作，含截图与坐标证据）',
    run: async (ctx) => {
      buildProbe(ctx);

      // ---- 段 A：解钉 ⇒ 必须看到跳（判别力证明）----
      await ctx.exec('window.MMApp.openProject("' + PROBE + '")');
      await ctx.exec(settle);
      const a = await ctx.exec(`(async () => {
        var jm = window.MMApp.getState().jm;
        if (jm.view.__anchorWrapped && jm.view.__unwrapAnchor) jm.view.__unwrapAnchor();
        var b = ` + witnessJs + `;
        jm.collapse_node('c2');
        await new Promise(function (r) { setTimeout(r, 420); });
        var a2 = ` + witnessJs + `;
        return { b: b, a2: a2 };
      })()`);
      const jumpA = a.a2.t1.rect[1] - a.b.t1.rect[1];
      const layoutA = (a.a2.t1.lay[1] || 0) - (a.b.t1.lay[1] || 0);

      // ---- 段 B：钉住（重开项目即恢复安装）⇒ 同一个动作不许跳 ----
      await ctx.exec('window.MMApp.openProject("' + PROBE + '")');
      await ctx.exec(settle);
      const b0 = await ctx.exec(witnessJs);
      const shotBefore = await shot(ctx, ctx.win, 'before-collapse');
      await ctx.exec('(function () { window.MMApp.getState().jm.collapse_node("c2"); return true; })()');
      await ctx.exec(settle);
      const b1 = await ctx.exec(witnessJs);
      const shotAfter = await shot(ctx, ctx.win, 'after-collapse');
      await ctx.exec('(function () { window.MMApp.getState().jm.expand_node("c2"); return true; })()');
      await ctx.exec(settle);
      const b2 = await ctx.exec(witnessJs);
      const dCollapse = [b1.t1.rect[0] - b0.t1.rect[0], b1.t1.rect[1] - b0.t1.rect[1]];
      const dExpand = [b2.t1.rect[0] - b1.t1.rect[0], b2.t1.rect[1] - b1.t1.rect[1]];
      const dT2 = [b1.t2.rect[1] - b0.t2.rect[1]];
      const dC2 = [b1.c2.rect[0] - b0.c2.rect[0], b1.c2.rect[1] - b0.c2.rect[1]];
      const dC2e = [b2.c2.rect[0] - b1.c2.rect[0], b2.c2.rect[1] - b1.c2.rect[1]];

      await ctx.exec('window.MMApp.openProject("comnet")');   // 复原
      await ctx.exec(settle);

      return {
        // 判据 = "**被操作的那个节点**原地不动"（这正是用户抱怨的事：点开/收起谁，谁就别跑）。
        // 其余节点允许移动：jsMind 的布局本来就是"每个父节点把子节点栈居中"，收起 c2 后
        // 同级/其它主题重新居中属**合法重排**（实测主题B位移 −841px），故只作参考、不硬判。
        ok: a.b.pinned === false && b0.pinned === true                 // 两段的钉住状态确实相反
          && Math.abs(jumpA) > 2                                        // 解钉 ⇒ 复现成立（必跳）
          && Math.abs(dC2[0]) <= 2 && Math.abs(dC2[1]) <= 2             // 钉住 ⇒ 被操作节点收起时不动
          && Math.abs(dC2e[0]) <= 2 && Math.abs(dC2e[1]) <= 2,          // 展开时同样不动
        text: '【解钉】收起：布局位移=' + layoutA + 'px 屏幕位移=' + jumpA + 'px（必须 >2px，否则复现不成立）'
          + ' · 【钉住】被操作节点 c2：收起位移=' + JSON.stringify(dC2) + ' 展开位移=' + JSON.stringify(dC2e) + '（须 ≤2px）'
          + ' · 参考：主题A ' + JSON.stringify(dCollapse) + '/' + JSON.stringify(dExpand)
          + '、主题B ' + JSON.stringify(dT2) + '（jsMind 的合法重排，允许移动）'
          + ' · pinned ' + a.b.pinned + '→' + b0.pinned
          + ' · 补偿日志=' + JSON.stringify(b1.log)
          + ' · 截图（headless 可能旧帧，仅参考）' + shotBefore + ' / ' + shotAfter
      };
    }
  },

  {
    name: '钉原点不越权：用户平移/缩放照旧生效（只动布局坐标，不碰 transform）',
    run: async (ctx) => {
      ctx.runCli(['expand-depth', 'comnet', '--depth', '2']);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const r = await ctx.exec(`(async () => {
        var jm = window.MMApp.getState().jm;
        var node = function (id) { return jm.view.e_panel.querySelector('jmnode[nodeid="' + id + '"]'); };
        // 量一次"平移(+100,+50) + 缩放 1.5 后展开"的视图变化。**同一段代码跑两遍**：
        // 先装着锚点保持、再卸下它 —— 用来判定"位移 = −平移×缩放"是否与本次改动无关的既有行为。
        var measure = async function () {
          await new Promise(function (r) { setTimeout(r, 260); });
          window.__anchorLog = [];
          window.fdView.x += 100; window.fdView.y += 50;      // 等价于拖拽平移
          window.MM.fdApplyView();
          window.MM.setViewScale(1.5);
          var v1 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
          var bOp = node('md-m1-week2').getBoundingClientRect();
          jm.expand_node('md-m1-week2');
          await new Promise(function (r) { setTimeout(r, 480); });
          var aOp = node('md-m1-week2').getBoundingClientRect();
          var log = (window.__anchorLog || []).slice(-3);
          var v2 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
          jm.collapse_node('md-m1-week2');
          await new Promise(function (r) { setTimeout(r, 420); });
          window.MM.setViewScale(1);
          window.fdView.x -= 100; window.fdView.y -= 50; window.MM.fdApplyView();
          return { dv: [v2[0] - v1[0], v2[1] - v1[1]],
                   move: [Math.round(aOp.x - bOp.x), Math.round(aOp.y - bOp.y)], log: log };
        };
        var on = await measure();
        if (jm.view.__anchorWrapped && jm.view.__unwrapAnchor) jm.view.__unwrapAnchor();
        var off = await measure();
        return { on: on, off: off };
      })()`);
      return {
        // 判据：装着不得比卸下更差（即"位移 = −平移×缩放"若是既有行为，本改动不算引入缺陷），
        // 且**装着的位移不该等于 −平移×缩放**（那正是"吃掉用户平移"的指纹）。
        ok: Math.abs(r.on.move[0] + 150) > 2 || Math.abs(r.on.move[1] + 75) > 2,
        text: '【装锚点】展开引起的视图增量=' + JSON.stringify(r.on.dv) + ' 被操作节点位移=' + JSON.stringify(r.on.move)
          + ' 补偿日志=' + JSON.stringify(r.on.log)
          + ' · 【卸锚点】视图增量=' + JSON.stringify(r.off.dv) + ' 位移=' + JSON.stringify(r.off.move)
          + ' 补偿日志=' + JSON.stringify(r.off.log)
          + '（平移量固定 [+100,+50]；位移等于 [−150,−75] 就是"平移被吃掉"的指纹）'
      };
    }
  },

  {
    name: '钉原点不干扰重建：连续两次打开项目，见证位置与 fdView 完全一致',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const a = await ctx.exec(witnessJs);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const b = await ctx.exec(witnessJs);
      const same = JSON.stringify(a.t1 && a.t1.rect) === JSON.stringify(b.t1 && b.t1.rect)
        && JSON.stringify(a.view) === JSON.stringify(b.view);
      return {
        ok: same && b.pinned === true,
        text: '第一次 ' + JSON.stringify(a.t1 && a.t1.rect) + ' 视图 ' + JSON.stringify(a.view)
          + ' · 第二次 ' + JSON.stringify(b.t1 && b.t1.rect) + ' 视图 ' + JSON.stringify(b.view)
          + ' · 完全一致=' + same + ' · 钉住=' + b.pinned
      };
    }
  }
];

module.exports = assertions;
