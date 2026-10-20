/* ============================================================
 * scripts/smoke/54-标签视图.js — 标签视图（功能代号 `TV` · 台账 `W9`）
 * ------------------------------------------------------------
 * 覆盖六条，全部是**机制/几何**判据（不是"看起来做了"）：
 *   1) 成员由 `tags` **现算**：视图标了 `mm-tag-hit` 的 id 集，逐 id 等于**断言自己**在页面里
 *      独立算出来的成员集（两个独立来源 —— 若视图改成"读某份存下来的清单"，这条必红）；
 *   2) **新加一个带该标签的节点 ⇒ 成员自己多一个**（内存里加，不保存）：这是台账 `W9`
 *      点名的核心难点"新加了带该标签的节点，怎么让 AI 不忘记更新标签笔记"的正解 ——
 *      靠机制（派生）不靠记忆（清单）。任何人把成员改成落盘清单，这条立刻红；
 *   3) 缩放到**刚好框住**：每个高亮节点都落在面板可视区内、并集贴合度足够（只判"都在里面"
 *      会被"缩得太小"骗过），且**不被顶部面板遮挡** —— 后者用 `elementFromPoint` 命中自身
 *      （`V1` 要求的真判据；rect 对遮挡/裁切是盲的，这是本工程 2026-10-08 那条事故的教训）；
 *   4) Esc 退出 ⇒ 两类标记归零、面板收起（**不留残影**）；
 *   5) 入口接线：详情框的标签 chip 点击 ⇒ 进视图；清单第一项点击 ⇒ 选中该节点；
 *   6) 零成员的标签 ⇒ 如实说 0（不冒充、不抛）。
 *
 * ⚠️ 本域**不跑**（`R7`：本批不许 `npm run smoke`）—— 状态是"已写、未执行"，
 *    见 `.review/20261020-W9-tag-view/00-定题.md` §8 偏差第 1 条。
 * ============================================================ */
'use strict';

const PROJ = 'book-wifi7';
/** 本域开始时界面开着的那个项目（**跑完还原**：全链最后的收尾截图/视觉断言看的还是它） */
let ENTRY_PROJECT = '';
/** 运行时挑出来的标签与其成员（由第 1 条断言挑，供后面几条复用） */
let TAG = '';
let MEMBERS = [];
/** 挑样本时的退让档位（`lca-deep` = 成员挤在同一个深祖先下 ⇒ 第 3 条的"框住"才可能成立）*/
let PICK_BRANCH = '';

function execJson(ctx, js) {
  return ctx.exec(js).then((raw) => {
    try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
  });
}

async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 40); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/** 入口前置：本域要有"一棵**框得住**的树"。为什么不是 comnet（`01-core.js` 预热打开的它）：
 *  `comnet` 有 **889 个节点**，任何标签的成员都会在图的两端 ⇒ 拟合需要的 s≈0.05，
 *  被 `fitToNodes` 的下界 **0.15** 夹住 ⇒ **永远走"框不住"分支**。实测踩到：加域第一天跑出来的
 *  报文是 `越界=4 被遮挡=4 占比=3.60 s=0.15`，那条断言因此**只在判"有没有如实告知"**，
 *  `elementFromPoint` 那半成了**永不执行的死判据**（本工程最忌讳的形状 ✗）。
 *  ⇒ 换成 7 本书里的 `book-wifi7`（**89 个节点**、10 个标签、每标签 8–14 个成员）：图窄，
 *  标签成员真的框得住，几何判据才真的被判到一次。**跑完还原**到本域开始时那个项目。
 *  切项目会撞"界面脏"确认框，headless 里没人应答会挂死（域 43 记过同款坑）⇒ 按产品自己的打桩口回答。 */
async function ensureProject(ctx) {
  const r = await ctx.exec(`(async function () {
    try {
      var st = window.MMApp.getState();
      var before = (st && st.project) ? st.project.name : '';
      if (before === ${JSON.stringify(PROJ)}) return JSON.stringify({ ok: true, text: 'already', before: before });
      var MM = window.MM;
      if (MM && MM.setConfirmStub) MM.setConfirmStub(function () { return true; });
      var r2 = await Promise.race([
        Promise.resolve(window.MMApp.openProject(${JSON.stringify(PROJ)})).then(function () { return 'opened'; },
          function (e) { return 'rejected:' + ((e && e.message) || e); }),
        new Promise(function (res) { setTimeout(function () { res('timeout'); }, 15000); })
      ]);
      if (MM && MM.setConfirmStub) MM.setConfirmStub(null);
      return JSON.stringify({ ok: r2 === 'opened' || r2 === 'already', text: r2, before: before });
    } catch (e) { return JSON.stringify({ ok: false, text: 'err:' + ((e && e.message) || e), before: '' }); }
  })()`);
  await new Promise((r2) => setTimeout(r2, 350));
  let o = { ok: false, text: r };
  try { o = JSON.parse(r); } catch (e) { /* 报文留在 text 里 */ }
  if (o.before) ENTRY_PROJECT = o.before;
  return o;
}

/** 页面里**独立**算一遍成员集（自己的遍历 + 自己的 tags 判定；不调 MMTree.nodesByTag，
 *  否则拿被测实现去验被测实现 —— 那就是一条永远绿的空断言） */
function expectedIdsJs(tag) {
  return `(function () {
    var jm = window.MMApp.getState().jm;
    var ids = [];
    (function walk(n) {
      if (!n) return;
      var list = (n.data && n.data.tags) || [];
      if (Array.isArray(list) && list.indexOf(${JSON.stringify(tag)}) >= 0) ids.push(n.id);
      (n.children || []).forEach(walk);
    })(jm.get_node('root'));
    return JSON.stringify({ ok: true, text: JSON.stringify(ids) });
  })()`;
}

module.exports = [
  {
    name: '标签视图：mm-tag-hit 的 id 集 = 页面里独立算出的成员集（成员是派生的，不是存的清单）',
    run: async (ctx) => {
      const entry = await ensureProject(ctx);
      if (!entry.ok) {
        return { ok: false, text: '入口前置失败（拿不到 ' + PROJ + ' 这棵树 ⇒ 本域后面的判据都不成立）：' + entry.text };
      }
      // ① 运行时挑一个标签：**优先"成员聚在同一个顶层主题下"且 3–12 个成员**的那一档里最大的一个。
      //   两个约束都来自实测，不是为了放宽判据：
      //   · **3–12 个成员**：`comnet` 成员最多的标签有 177 个成员，本域要跑 6 条断言、每条都重开视图
      //     （展开 + 全树布局）⇒ 实测软件渲染下能把本域拖成分钟级，而判据一条都没变强；
      //   · **同一顶层主题下**：第 3 条判的是"缩放到刚好框住"。若成员散在整张 889 个节点的图两端，
      //     需要的 s≈0.05 会被 `fitToNodes` 的下界 0.15 夹住 ⇒ **框不住是产品已如实告知的合法结果**
      //     （`showTagView` 返回 `clamped:true` + 状态栏明说，实测 `comnet` 的 `补充` 就是这种）。
      //     判"框住"必须先挑一个**框得住是可能的**样本，否则判的就不是这件事。
      //   取不到这一档才逐级退回（保底不空转），并把退到哪一档写进报文。
      const pick = await execJson(ctx, `(function () {
        var jm = window.MMApp.getState().jm, of = {};
        // 每个节点的 id 路径（root → 自己）；成员之间的**最近公共祖先越深**，它们在图上就越挤，
        // "缩放到刚好框住"才可能真的框得住（comnet 是 889 个节点的单中心图，只判"同一顶层主题"
        // 还不够：实测那一档仍需 s≈0.05，被下界 0.15 夹住 ⇒ 只能走"如实告知"分支）。
        (function walk(n, path) {
          if (!n) return;
          var p2 = path.concat([n.id]);
          var list = (n.data && n.data.tags) || [];
          if (Array.isArray(list)) list.forEach(function (g) {
            if (!g) return;
            (of[g] = of[g] || []).push(p2);
          });
          (n.children || []).forEach(function (c) { walk(c, p2); });
        })(jm.get_node('root'), []);
        function lcaDepth(paths) {
          if (!paths.length) return 0;
          var base = paths[0], d = 0;
          for (var i = 0; i < base.length - 1; i++) {
            for (var j = 1; j < paths.length; j++) {
              if (paths[j][i] !== base[i]) return d;
            }
            d = i + 1;
          }
          return d;
        }
        var best = null, any = null;
        Object.keys(of).forEach(function (k) {
          var paths = of[k], n = paths.length;
          if (n > (any ? any.n : 0)) any = { tag: k, n: n, lca: lcaDepth(paths) };
          if (n < 3 || n > 12) return;
          var cand = { tag: k, n: n, lca: lcaDepth(paths) };
          if (!best || cand.lca > best.lca || (cand.lca === best.lca && cand.n > best.n)) best = cand;
        });
        var use = best || (any && any.n >= 3 ? any : null);
        if (!use) return JSON.stringify({ ok: false, text: 'no-tag', n: 0, lca: 0 });
        return JSON.stringify({ ok: true, text: use.tag, n: use.n, lca: use.lca,
          branch: best ? 'lca-deep' : 'biggest-fallback' });
      })()`);
      if (!pick.ok) return { ok: false, text: '挑不到成员 ≥3 的标签（本域无内容可验）：' + JSON.stringify(pick).slice(0, 200) };
      PICK_BRANCH = pick.branch + '（' + pick.n + ' 个成员 · 公共祖先深度 ' + pick.lca + '）';
      TAG = pick.text;
      MEMBERS = JSON.parse((await execJson(ctx, expectedIdsJs(TAG))).text);
      // ② 打开视图
      const shown = await execJson(ctx, `(function () {
        var r = window.MM.showTagView(${JSON.stringify(TAG)});
        return JSON.stringify({ ok: !!r && r.count > 0, text: JSON.stringify(r) });
      })()`);
      if (!shown.ok) return { ok: false, text: '打开标签视图失败：' + shown.text };
      // ③ 逐 id 比对（DOM 上的标记集 vs 独立算出来的成员集）
      const chk = await waitFor(ctx, `(function () {
        var hits = Array.prototype.slice.call(document.querySelectorAll('jmnode.mm-tag-hit'))
          .map(function (el) { return el.getAttribute('nodeid'); }).sort();
        var dims = document.querySelectorAll('jmnode.mm-tag-dim').length;
        var all = document.querySelectorAll('jmnode[nodeid]').length;
        var expect = ${JSON.stringify(JSON.stringify(MEMBERS))};
        var want = JSON.parse(expect).slice().sort();
        var same = hits.length === want.length && hits.every(function (id, i) { return id === want[i]; });
        var panelEl = document.getElementById('tag-view-panel');
        var countAttr = panelEl ? panelEl.getAttribute('data-count') : null;
        return JSON.stringify({
          ok: same && dims === all - want.length && String(countAttr) === String(want.length),
          text: '标记=' + hits.length + ' 期望=' + want.length + ' 虚化=' + dims + '/非成员=' + (all - want.length)
            + ' 面板计数=' + countAttr + ' 全同=' + same + ' 标签=' + ${JSON.stringify(TAG)}
            + ' 样本=' + ${JSON.stringify(PICK_BRANCH)}
            + (same ? '' : ' 实得=' + hits.join(',') + ' 期望集=' + want.join(','))
        });
      })()`);
      const o = JSON.parse(chk);
      if (!o.ok) return { ok: false, text: o.text };
      // ④ 收尾：不留视图给下一条（下一条自己开）
      await ctx.exec(`(function () { window.MM.closeTagView(); return 1; })()`);
      return { ok: true, text: o.text };
    }
  },
  {
    name: '标签视图：内存里给一个原本不带该标签的节点加上标签 ⇒ 成员自己多一个（没有任何清单被更新）',
    run: async (ctx) => {
      if (!TAG) return { ok: false, text: '上一条没有挑出标签（本域顺序依赖）' };
      const chk = await execJson(ctx, `(function () {
        var MM = window.MM, jm = window.MMApp.getState().jm;
        var before = MM.showTagView(${JSON.stringify(TAG)}).count;
        // 挑一个**本来不带**这个标签的节点（只要它不在成员里）
        var victim = null;
        (function walk(n) {
          if (!n || victim) return;
          var list = (n.data && n.data.tags) || [];
          if (n.id !== 'root' && (!Array.isArray(list) || list.indexOf(${JSON.stringify(TAG)}) < 0)) victim = n;
          (n.children || []).forEach(walk);
        })(jm.get_node('root'));
        if (!victim) return JSON.stringify({ ok: false, text: '每个节点都带这个标签，无法造"新成员"' });
        var had = victim.data && victim.data.tags;
        var hadCopy = had ? had.slice() : null;
        victim.data = victim.data || {};
        victim.data.tags = (hadCopy || []).concat([${JSON.stringify(TAG)}]);
        // ★ 这里**只改了树本身**：没有任何"成员清单"被更新 —— 视图必须自己跟上
        var after = MM.showTagView(${JSON.stringify(TAG)}).count;
        var hits = Array.prototype.slice.call(document.querySelectorAll('jmnode.mm-tag-hit'))
          .map(function (el) { return el.getAttribute('nodeid'); });
        var inView = hits.indexOf(victim.id) >= 0;
        // 还原内存（**不保存**：本域一个字节都不写盘）
        if (hadCopy) victim.data.tags = hadCopy; else delete victim.data.tags;
        var back = MM.showTagView(${JSON.stringify(TAG)}).count;
        MM.closeTagView();
        return JSON.stringify({
          ok: after === before + 1 && inView && back === before,
          text: '前=' + before + ' 加标签后=' + after + ' 新节点进视图=' + inView + ' 还原后=' + back
            + ' 节点=' + victim.id
        });
      })()`);
      return { ok: !!chk.ok, text: chk.text };
    }
  },
  {
    name: '标签视图：缩放到刚好框住（高亮节点都落在面板可视区、贴合度足够），且不被顶部条遮挡（elementFromPoint 命中自身）',
    run: async (ctx) => {
      if (!TAG) return { ok: false, text: '上一条没有挑出标签（本域顺序依赖）' };
      /* ⚠️ 本断言**自己建前置**（上一条结束时把视图关掉了 —— 实测第一次跑就是这里红：
       *   报"没有 mm-tag-hit"，那是**前置缺失**，不是几何判据红。域 25 的文件头记过同款教训）。 */
      const opened = await execJson(ctx, `(function () {
        var r = window.MM.showTagView(${JSON.stringify(TAG)});
        return JSON.stringify({ ok: !!r && r.count > 0, text: JSON.stringify(r) });
      })()`);
      if (!opened.ok) return { ok: false, text: '前置（打开标签视图）失败：' + opened.text };
      const chk = await waitFor(ctx, `(function () {
        var MM = window.MM;
        var opened2 = MM.tagViewState();
        var panel = MM.fdPanel ? MM.fdPanel() : null;
        var p = panel ? panel.getBoundingClientRect() : null;
        var bar = document.getElementById('tag-view-panel');
        var br = bar ? bar.getBoundingClientRect() : null;
        var hits = Array.prototype.slice.call(document.querySelectorAll('jmnode.mm-tag-hit'));
        if (!p || !br) return JSON.stringify({ ok: false, text: '拿不到面板/条带矩形' });
        if (!hits.length) return JSON.stringify({ ok: false, text: '没有 mm-tag-hit（高亮没生效）' });
        /* ⚠️ **两个分支都判，但判的不是同一件事**（不许"框不住就放过"）：
         *   · 能框住（s 未被下界夹住）⇒ 真的判几何：都在可视区内 + 并集贴合 + 中心命中自身；
         *   · 框不住（s 被夹在 0.15，showTagView 返回 clamped:true）⇒ 判**它有没有如实说出来**：
         *     状态栏必须明确讲"散得比最小缩放还开"，且高亮照旧在 —— 静默地假装框住会在这里红。
         *   实测 comnet 的「补充」（4 个成员分在图两端）就是被夹住的那一档。 */
        var clamped = false;
        if (window.MM && MM.tagViewState) {
          var re = MM.showTagView(${JSON.stringify(TAG)});     // 取一次返回值的 clamped 读数
          clamped = !!(re && re.clamped);
        }
        if (clamped) {
          var st = (document.getElementById('status-text') || {}).textContent || '';
          var said = st.indexOf('最小缩放') >= 0;
          return JSON.stringify({
            ok: said && hits.length > 0,
            text: '分支=框不住（s 被下界夹住）｜ 状态栏有没有如实说=' + said + ' ｜ 台面=' + st.slice(0, 90)
          });
        }
        // 条带占掉的顶部高度 = 它在面板坐标系里的相对位置 + 高度
        var insetTop = (br.bottom - p.top) + 4;
        var out = 0, occluded = 0, L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
        hits.forEach(function (el) {
          var r = el.getBoundingClientRect();
          L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom);
          if (r.left < p.left - 2 || r.right > p.right + 2 || r.top < p.top + insetTop - 2 || r.bottom > p.bottom + 2) out++;
          // ★ 真判据：中心点上到底是谁 —— 被条带/别的元素盖住时这里命中的不是它
          var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
          if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) { occluded++; return; }
          var at = document.elementFromPoint(cx, cy);
          var self = !!(at && at.closest && at.closest('jmnode[nodeid]') === el);
          if (!self) occluded++;
        });
        var freeH = Math.max(1, p.height - insetTop);
        var span = Math.max((R - L) / p.width, (B - T) / freeH);
        var st2 = MM.getPanState();
        return JSON.stringify({
          ok: out === 0 && occluded === 0 && (span >= 0.55 || st2.s >= 3.9),
          text: '分支=框住了 ｜ 高亮=' + hits.length + ' 越界=' + out + ' 被盖住=' + occluded
            + ' 占比=' + span.toFixed(2) + ' s=' + st2.s.toFixed(2)
            + ' 面板=' + Math.round(p.width) + 'x' + Math.round(p.height)
            + ' 条带让出=' + Math.round(insetTop)
        });
      })()`);
      const o = JSON.parse(chk);
      await ctx.exec(`(function () { window.MM.closeTagView(); return 1; })()`);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: '标签视图：Esc 退出后 mm-tag-hit / mm-tag-dim 归零、面板收起（不留残影）',
    run: async (ctx) => {
      if (!TAG) return { ok: false, text: '上一条没有挑出标签（本域顺序依赖）' };
      const chk = await execJson(ctx, `(function () {
        var MM = window.MM;
        var r = MM.showTagView(${JSON.stringify(TAG)});
        if (!r || !r.count) return JSON.stringify({ ok: false, text: '进不了视图' });
        var lit = document.querySelectorAll('jmnode.mm-tag-hit').length
          + document.querySelectorAll('jmnode.mm-tag-dim').length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        var el = document.getElementById('tag-view-panel');
        return JSON.stringify({
          ok: lit > 0 && document.querySelectorAll('jmnode.mm-tag-hit').length === 0
            && document.querySelectorAll('jmnode.mm-tag-dim').length === 0
            && !!el && el.style.display === 'none' && MM.isTagViewActive() === false,
          text: '进视图时标记数=' + lit + ' 退出后命中/虚化='
            + document.querySelectorAll('jmnode.mm-tag-hit').length + '/'
            + document.querySelectorAll('jmnode.mm-tag-dim').length
            + ' 面板 display=' + (el ? el.style.display : '无') + ' 仍活跃=' + MM.isTagViewActive()
        });
      })()`);
      return { ok: !!chk.ok, text: chk.text };
    }
  },
  {
    name: '标签视图入口：详情框的标签 chip 点击 ⇒ 进视图；清单第一项点击 ⇒ 选中该节点',
    run: async (ctx) => {
      const chk = await execJson(ctx, `(function () {
        var MM = window.MM, app = window.MMApp, jm = app.getState().jm;
        // 找一个**带标签**的节点（从树里挑，不写死 —— 写死会顺序依赖）
        var pick = null;
        (function walk(n) {
          if (!n || pick) return;
          var list = (n.data && n.data.tags) || [];
          if (n.id !== 'root' && Array.isArray(list) && list.length) pick = n;
          (n.children || []).forEach(walk);
        })(jm.get_node('root'));
        if (!pick) return JSON.stringify({ ok: false, text: '这棵树没有带标签的节点' });
        var want = pick.data.tags[0];
        app.showDetail(pick);
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail'));
        var boxEl = null;
        for (var i = 0; i < boxes.length; i++) {
          var q = boxes[i].getBoundingClientRect();
          if (boxes[i].style.display !== 'none' && q.width > 40 && q.height > 40) { boxEl = boxes[i]; break; }
        }
        var chips = boxEl ? Array.prototype.slice.call(boxEl.querySelectorAll('.fd-tags .tag-chip')) : [];
        var chip = null;
        for (var j = 0; j < chips.length; j++) {
          if ((chips[j].textContent || '').replace(/^#/, '') === want) { chip = chips[j]; break; }
        }
        if (!chip) return JSON.stringify({ ok: false, text: '详情框里没有 ' + want + ' 的 chip（chips=' + chips.length + '）' });
        chip.click();
        var st = MM.tagViewState();
        var entered = !!st && st.tag === want && st.count > 0;
        // 清单第一项点击 ⇒ 选中它
        var item = document.querySelector('#tag-view-panel .tv-item[data-node]');
        if (!item) return JSON.stringify({ ok: false, text: '清单里没有 .tv-item（进入=' + entered + '）' });
        var wantId = item.getAttribute('data-node');
        item.click();
        var sel = MM.adapter && MM.adapter.getSelected ? MM.adapter.getSelected(jm) : null;
        var selId = sel && sel.id ? sel.id : (sel && sel[0] ? sel[0].id : '');
        MM.closeTagView();
        return JSON.stringify({
          ok: entered && selId === wantId,
          text: 'chip 标签=' + want + ' 进视图=' + entered + ' 清单首项=' + wantId + ' 点后选中=' + selId
        });
      })()`);
      return { ok: !!chk.ok, text: chk.text };
    }
  },
  {
    name: '标签视图：没有节点带的标签 ⇒ 如实说 0（面板计数 0、正文说明，不抛不冒充）',
    run: async (ctx) => {
      const chk = await execJson(ctx, `(function () {
        var MM = window.MM;
        var r = MM.showTagView('这个标签肯定不存在-zzz');
        var el = document.getElementById('tag-view-panel');
        var body = document.getElementById('tag-view-body');
        var txt = body ? body.textContent : '';
        var ok = !!r && r.count === 0 && !!el && el.getAttribute('data-count') === '0'
          && txt.indexOf('没有节点带这个标签') >= 0;
        MM.closeTagView();
        return JSON.stringify({ ok: ok, text: '返回=' + JSON.stringify(r) + ' 面板计数='
          + (el ? el.getAttribute('data-count') : '无') + ' 正文=' + txt.slice(0, 60) });
      })()`);
      // 收尾：**还原到本域开始时那个项目**（全链最后的收尾截图/视觉断言看的还是它）
      let restored = '（本域开始时就是 ' + PROJ + '，无需还原）';
      if (ENTRY_PROJECT && ENTRY_PROJECT !== PROJ) {
        const back = await ctx.exec(`(async function () {
          try {
            var MM = window.MM;
            if (MM && MM.setConfirmStub) MM.setConfirmStub(function () { return true; });
            var r2 = await Promise.race([
              Promise.resolve(window.MMApp.openProject(${JSON.stringify(ENTRY_PROJECT)})).then(function () { return 'opened'; },
                function (e) { return 'rejected:' + ((e && e.message) || e); }),
              new Promise(function (res) { setTimeout(function () { res('timeout'); }, 15000); })
            ]);
            if (MM && MM.setConfirmStub) MM.setConfirmStub(null);
            var now = window.MMApp.getState().project;
            return JSON.stringify({ ok: r2 === 'opened' && !!now && now.name === ${JSON.stringify(ENTRY_PROJECT)},
              text: r2 + ' / 现在开着=' + (now ? now.name : '') });
          } catch (e) { return JSON.stringify({ ok: false, text: 'err:' + ((e && e.message) || e) }); }
        })()`);
        await new Promise((r) => setTimeout(r, 350));
        let ob = null;
        try { ob = JSON.parse(back); } catch (e) { /* 报文留下 */ }
        restored = ob ? ob.text : String(back).slice(0, 120);
      }
      return { ok: !!chk.ok, text: chk.text + ' ｜ 还原项目=' + restored };
    }
  }
];
