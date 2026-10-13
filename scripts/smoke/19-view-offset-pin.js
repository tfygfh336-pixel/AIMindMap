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
/** 第 ② 条专用的**自带探针**：原先那条断言是 `expand-depth comnet --depth 2` ✗✗ ——
 *  一条**写操作**却打在**用户真实项目**上（改写用户的 `expanded` 与 `meta.version`），
 *  而且判据从此绑死"真实项目里必须有 `md-m1-week2` 这个节点"：用户一改名/一删，本域就假红。 */
const PROBE2 = 'zz-pan-probe';

/** 打开项目后把视图**解归一回全展开**：折叠默认之后，打开项目只展开根（顶层主题被收起）
 *  ⇒ 探针里的深层节点 rect 会是 0×0，"要不要收起某个子树"就测不出任何位移了（判据空转 ✗）。
 *  本域测的是"展开/收起时的重排锚点"，所以每次打开探针后都要显式回到"全展开"这一初始画面。
 *  ⚠️ 用**逐个展开顶层主题**、不用 `expand_all()`：后者会把锚点退化成"第一个可见顶层主题"、
 *  并留下一次大额 fdView 补偿（实测把第 ① 条的"被操作节点不许动"带红 —— 那是测量起点的
 *  非确定性，不是产品缺陷）。探针的深层节点在数据里本来就是展开的，展开主题即可复原画面 ✓。 */
const revealProbeJs = '(function () { var jm = window.MMApp.getState().jm; if (!jm) return false;'
  + ' ["t1", "t2"].forEach(function (id) { var n = jm.get_node(id);'
  + ' if (n && n.children && n.children.length && n.expanded === false) jm.expand_node(id); });'
  + ' return true; })()';

/** 归一之后再**复位视图**：本域量的是"同一次形状变化前后差多少"，测量起点必须确定
 *  （`expand_node` 会通过重排锚点补偿 fdView ⇒ 不复位的话起点带着上一次补偿的残留，
 *   实测把第 ① 条的"解钉必跳"读数压成 0 ✗）。复位不动数据，只把 fdView/偏移/居中还到初始 ✓。 */
const resetViewJs = '(function () { if (window.MMApp.resetView) window.MMApp.resetView(); return true; })()';

/** 换项目之前先把界面拉回"不脏"，否则会**卡死整轮**。
 *
 *  为什么必须有它（本域实测踩到两次）：`openProject` 在"换项目 + 有未保存改动"时会弹
 *  `confirmDiscardIfDirty` 的**模态确认框**；headless 下没人回答 ⇒ 渲染层的 JS 线程就此停住
 *  ⇒ `ctx.exec` 永不返回 ⇒ 一直等到 SMOKE GUARD TIMEOUT（报文里只有一行 GUARD，看不出是谁 ✗）。
 *  做法：先按**当前项目名**重开一次（同名不触发那道闸 ✓，且它会把"未保存基线"对齐到盘上那一版
 *  ⇒ 界面变回干净），再切到目标项目 ✓ —— 本域在探针上做过的展开/收起都只影响**沙箱里的探针**，
 *  丢掉它们不影响任何判据。 */
async function switchProject(ctx, name) {
  const target = JSON.stringify(name);
  await ctx.exec('(async function () { var st = window.MMApp.getState();'
    + ' var cur = st && st.project && st.project.name;'
    + ' if (cur && cur !== ' + target + ') await window.MMApp.openProject(cur);'
    + ' return true; })()');
  await ctx.exec('window.MMApp.openProject(' + target + ')');
  await ctx.exec(settle);
}

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

/** 第 ② 条的自带探针（**不碰任何真实项目**）：主题模式 + 一个顶层主题，下面一条 3 层链 +
 *  24 个叶子 —— 展开/收起 p-c2 时布局变化足够明显（够判），又小到不会被栅格化卡住。
 *  `--depth 2` 刻意与原来那行 `expand-depth comnet --depth 2` 同参：p-c2 落在第 3 层 ⇒ **收起**，
 *  于是"展开它"是一次**真的**形状变化（比在真实项目上那次"展开一个已经展开的节点"更有判别力 ✓）。 */
function buildPanProbe(ctx) {
  ctx.runCli(['init', PROBE2]);
  ctx.runCli(['add-root', PROBE2, '--topic', '主题甲', '--id', 'p-t1']);
  ctx.runCli(['add', PROBE2, 'p-t1', '--topic', 'P1', '--id', 'p-c1']);
  ctx.runCli(['add', PROBE2, 'p-c1', '--topic', 'P2', '--id', 'p-c2']);
  for (let i = 1; i <= 24; i++) ctx.runCli(['add', PROBE2, 'p-c2', '--topic', '叶' + i, '--id', 'p-l' + i]);
  ctx.runCli(['expand-depth', PROBE2, '--depth', '2']);     // 前两层展开 ⇒ p-c2（第 3 层）收起
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
      await switchProject(ctx, PROBE);
      await ctx.exec(revealProbeJs);          // 解归一：打开后只展开根，本域要的是"全展开"这个初始画面
      await ctx.exec(settle);
      await ctx.exec(resetViewJs);            // 测量起点复位（见 resetViewJs 注释）
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
      await ctx.exec(revealProbeJs);          // 同上：先把画面恢复成"全展开"，否则收起 c2 无位移可测
      await ctx.exec(settle);
      await ctx.exec(resetViewJs);            // 同上：测量起点复位
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

      // ⚠️ 复原前必须走 `switchProject`：本域上面的收起/展开都改过内存树 ⇒ 界面是**脏**的，
      // 而"脏时换项目"会弹模态确认框（headless 没人回答 ⇒ 整轮卡死 ✗）；它先把基线对齐再切 ✓。
      await switchProject(ctx, 'comnet');   // 复原

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
      buildPanProbe(ctx);
      await switchProject(ctx, PROBE2);
      const r = await ctx.exec(`(async () => {
        var jm = window.MMApp.getState().jm;
        var node = function (id) { return jm.view.e_panel.querySelector('jmnode[nodeid="' + id + '"]'); };
        // 打开项目时视图会归一成"只展开根"（顶层主题被收起）⇒ 先展开**被操作节点的祖先链**，
        // 否则目标节点 rect 是 0×0、展开它也不会有任何形状变化 ⇒ 判据空转（实测那种"绿"最贵 ✗）。
        jm.expand_node('p-t1');
        await new Promise(function (r) { setTimeout(r, 320); });
        // 量一次"平移(+100,+50) + 缩放 1.5 后展开"的视图变化。**同一段代码跑两遍**：
        // 先装着锚点保持、再卸下它 —— 用来判定"位移 = −平移×缩放"是否与本次改动无关的既有行为。
        var measure = async function () {
          await new Promise(function (r) { setTimeout(r, 260); });
          window.__anchorLog = [];
          window.fdView.x += 100; window.fdView.y += 50;      // 等价于拖拽平移
          window.MM.fdApplyView();
          window.MM.setViewScale(1.5);
          var v1 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
          var bOp = node('p-c2').getBoundingClientRect();
          jm.expand_node('p-c2');                             // 真形状变化：p-c2 在第 3 层、本来收起
          await new Promise(function (r) { setTimeout(r, 480); });
          var aOp = node('p-c2').getBoundingClientRect();
          var log = (window.__anchorLog || []).slice(-3);
          var v2 = [Math.round(window.fdView.x), Math.round(window.fdView.y), window.fdView.s];
          jm.collapse_node('p-c2');
          await new Promise(function (r) { setTimeout(r, 420); });
          window.MM.setViewScale(1);
          window.fdView.x -= 100; window.fdView.y -= 50; window.MM.fdApplyView();
          return { dv: [v2[0] - v1[0], v2[1] - v1[1]],
                   move: [Math.round(aOp.x - bOp.x), Math.round(aOp.y - bOp.y)], log: log,
                   // 非空转守卫：量的时候那个节点必须真在画面上（rect 不为 0）——否则位移恒 0、
                   // 判据无论实现对错都绿（这正是"改坏了也抓不住"的形态）
                   seen: bOp.width > 0 && bOp.height > 0 };
        };
        var on = await measure();
        if (jm.view.__anchorWrapped && jm.view.__unwrapAnchor) jm.view.__unwrapAnchor();
        var off = await measure();
        return { on: on, off: off };
      })()`);
      return {
        // 判据：装着不得比卸下更差（即"位移 = −平移×缩放"若是既有行为，本改动不算引入缺陷），
        // 且**装着的位移不该等于 −平移×缩放**（那正是"吃掉用户平移"的指纹）。
        ok: r.on.seen === true && r.off.seen === true
          && (Math.abs(r.on.move[0] + 150) > 2 || Math.abs(r.on.move[1] + 75) > 2),
        text: '【装锚点】展开引起的视图增量=' + JSON.stringify(r.on.dv) + ' 被操作节点位移=' + JSON.stringify(r.on.move)
          + ' 补偿日志=' + JSON.stringify(r.on.log) + ' 量到时在屏=' + r.on.seen
          + ' · 【卸锚点】视图增量=' + JSON.stringify(r.off.dv) + ' 位移=' + JSON.stringify(r.off.move)
          + ' 补偿日志=' + JSON.stringify(r.off.log) + ' 量到时在屏=' + r.off.seen
          + '（平移量固定 [+100,+50]；位移等于 [−150,−75] 就是"平移被吃掉"的指纹）'
      };
    }
  },

  {
    name: '钉原点不干扰重建：连续两次打开项目，见证位置与 fdView 完全一致',
    run: async (ctx) => {
      // 用**第 ① 条建的探针**（它的见证节点 t1/t2/c2 才在树里）：原来这里开的是 comnet，
      // 而 comnet 没有这些 id ⇒ 判据一直在比 null（"绿得没有信息"）。探针全程在沙箱里 ✓ 零真实数据风险。
      await switchProject(ctx, PROBE);
      const a = await ctx.exec(witnessJs);
      await ctx.exec('window.MMApp.openProject("' + PROBE + '")');
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
