/* ============================================================
 * scripts/smoke/36-real-input.js — 真输入域：**模拟人类操作** + 截图证据
 * ------------------------------------------------------------
 * ## 这个域为什么存在（用户原话）
 *   「你有没有做模拟人类操作的可视化测试？！！」
 * 在它之前，冒烟里的"点击"绝大多数是 `dispatchEvent(new MouseEvent(...))` —— 那是
 * **直接派发到已知元素**，整条绕过 Chromium 的输入管线（命中测试 / 修饰键 / hover /
 * 指针捕获 / 拖拽阈值 / 浮层遮挡）。于是"真机才复现"的缺陷（真机反馈的 Ctrl+加选虚线框、
 * 「💬 问这 N 个」的 N）**天然测不到**：合成事件永远点得到，而真人永远点不到。
 * 本域全部用 `ctx.input.*`（= `webContents.sendInputEvent`，走真实输入管线 ✓；
 * 实现与用法见 `scripts/smoke-input.js` 文件头），并且**每条断言都留一张可判读的截图**
 * （落 `.review/20261009-真输入可视测试/shots/`，不进版本库 ✓）。
 *
 * ## 截图判据不是"有图就行"（用户要求：要读出可判据）
 *   ・**像素级**：`frameStats.scanRegion` 在节点**外圈带**上数"高饱和强调蓝"（`#1664ff`）像素。
 *     为什么不能只读 DOM：类名加上、`getComputedStyle` 也说是 dashed，**画面上仍可能什么都没有**
 *     （被祖先裁掉 / 被浮层盖住 / 颜色被改成透明 / 帧没更新）—— 证明见下方 `invisible-outline` 注入 ✓。
 *   ・**前后差分**：同一 ROI 在"动手前 / 动手后"各读一次，判**增量/回落**。隐藏窗口的 `capturePage`
 *     可能给旧帧（`scripts/smoke/17-ui-polish.js` 有实测记录）⇒ 旧帧只会造成**假红**、不会造成假绿 ✓。
 *   ・判定用的那张帧**就是**落盘的那张（`captureUntil` 把 frame 一起返回）⇒ 数字与图片同源可复核 ✓。
 *
 * ## 判别力证明（工程纪律：新断言先注入一次违规、确认变红、再撤销）
 * `MM_SMOKE_INJECT=<key>` 只在本域生效（默认空 ⇒ 正常跑不受影响 ✓）：
 *   ・`miss-click`        → ①里把点击坐标挪出节点 ⇒ ①必红（证明"点中"这件事真被判了）
 *   ・`invisible-outline` → ②里给选中节点加 `outline-color: transparent`（DOM/计算样式全绿、**像素没了**）
 *                          ⇒ ②必红（证明像素判据有 DOM 判据没有的判别力）
 *   ・`big-box`           → ②里把大虚线框画出来 ⇒ ②必红
 *   ・`ask-count`         → ④里把工具条数量文案改成错的 ⇒ ④必红
 *   ・`stale-raw`         → ⑤里造出"清选区后描边残留"的旧缺陷态 ⇒ ⑤必红
 * 注入是**测试侧**的（只改本域的动作、不动产品代码 ✓），撤销 = 本域收尾复位 ✓。
 *
 * ## 真输入的三个坑（都实测踩过，写在现场免得后人再踩）
 *   ・**工具条会盖住下一个候选点**：第一次 Ctrl+点击之后工具条出现，原先验过的点可能落在它下面
 *     ⇒ 每次点击**前**都要重新用 `elementFromPoint` 复核坐标（`pointFor` ✓）。29-域记过同款坑。
 *   ・**状态的落定是异步的**：事件进管线 → 渲染层处理 → DOM 更新有几帧延迟 ⇒ 读状态用 `waitFor`；
 *     读像素用 `captureUntil`（重拍直到出现期望，或试完为止 ⇒ 真的没画出来时怎么拍都读不到 ✓）。
 *   ・**键盘输入只发 ASCII**：`type:'char'` + 非 ASCII keyCode 依赖输入法，属于**未验证**区间；
 *     中文输入法不在本域覆盖范围内（如实标注，不冒充已测 ✗）。
 *
 * ## 边界（别以为它比实际更强 ✓）
 *   ・本域验的是**渲染层行为 + 画面上真的画出来了**；"人手摸起来的手感"仍只有真人能判（R5 残差）。
 *   ・窗口是无头离屏（`--smoke`），鼠标走**真实输入管线**但**不是真实硬件**：真·驱动级差异
 *     （高 DPI 缩放、系统鼠标加速、多显示器）仍测不到 ✓。
 * ============================================================ */
'use strict';

const frameStats = require('../vision/frame-stats.js');
const TH = require('../vision/thresholds.js');
const WAIT = require('./_wait.js');   // 等真帧/等条件：理由见该文件头部第 5 条

/** 判别力证明开关（见文件头；默认空 ⇒ 正常跑完全不生效 ✓） */
const INJECT = process.env.MM_SMOKE_INJECT || '';

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** 轮询到"状态已落定"（真输入是异步的：事件进管线 → 渲染层处理 → DOM 更新，中间有帧延迟）。
 *  ⚠️ 只用于等**状态**，不用于等**画面** —— 像素有它自己的重拍逻辑（`captureUntil`）✓ */
async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 12); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

/* ---------------- 铺场：每个断言自建前置（不依赖别的断言/别的域留下的状态 ✓） ---------------- */

/** 关浮窗、**清选区（含原始集）**、收起工具条、展开全树、把根居中。
 *  ⚠️ 清"原始集"必须用 `applySelection([], [], {hideBox:true})`：`clearSelection()` 只清裁剪集，
 *     而描边画的是原始集 ⇒ 只调它会在**铺场阶段**就留下上一条断言的残影（本域⑤正是这条的判据 ✓）。 */
async function prep(ctx) {
  const r = await execJson(ctx, `(function () {
    var MM = window.MM;
    if (!MM || !window.MMApp) return JSON.stringify({ ok: false, text: '渲染层没就绪（MM / MMApp 缺失）' });
    var st = window.MMApp.getState();
    if (!st || !st.jm) return JSON.stringify({ ok: false, text: '没有打开的项目（jm 缺失）' });
    if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    if (MM.askBoxes) MM.askBoxes().forEach(function (b) { if (MM.closeFdBox) MM.closeFdBox(b); });
    if (MM.applySelection) MM.applySelection([], [], { hideBox: true });
    if (MM.paintRawSelection) MM.paintRawSelection();
    if (MM.hideNodeToolbar) MM.hideNodeToolbar();
    // 把树收成**紧凑的两层**（这是唯一一个能在 729x714 面板里同时看见"父+子"的取景，实测）：
    //   · 只 collapseAll()（收起到顶层主题）不够：jsMind 每个节点各自记着展开态，
    //     子孙的展开态还在 ⇒ 再展开主题时孙辈一起冒出来，父与子的间距被撑到 1500+ 逻辑像素 ✗；
    //   · 所以先 jm.collapse_all()（把**每个节点**的展开态清掉）再 expand_to_depth(2)
    //     ⇒ 主题的子节点全是叶子 ⇒ 间距只有几十像素 ✓（collapse_all 会把合成根也折进去，
    //     但紧随其后的 expand_to_depth(2) 会把它重新展开 ✓，正是 app-view 注释里提过的那件事）。
    if (MM.collapseAll) MM.collapseAll();
    if (st.jm.collapse_all) st.jm.collapse_all();
    if (st.jm.expand_to_depth) st.jm.expand_to_depth(2);
    return JSON.stringify({ ok: true, text: '铺场完成（项目 ' + (st.project && st.project.name) + '）' });
  })()`);
  await WAIT.frames(ctx, { delayMs: 320 });   // 展开/居中后等 jsMind 重排（实测要留几百 ms）
  return r;
}

/** 扫一遍**当前视口内**的节点（含"这个点能不能真的点到"的命中测试结果）。
 *  为什么不写死 id：节点 id 属易腐事实（数据一改就失效），而"视口内、点得中"才是本域的前提 ✓。 */
async function scanNodes(ctx) {
  return execJson(ctx, `(function () {
    var jm = window.MMApp.getState().jm;
    if (!jm) return JSON.stringify({ ok: false, text: '没有 jm' });
    var root = jm.get_root();
    if (!root) return JSON.stringify({ ok: false, text: '取不到 jsMind 根（get_root 缺失）' });
    function hitPoint(el) {
      var r = el.getBoundingClientRect();
      var cands = [
        { x: Math.round(r.left + 6), y: Math.round(r.top + Math.round(r.height / 2)) },
        { x: Math.round(r.right - 6), y: Math.round(r.top + Math.round(r.height / 2)) },
        { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.bottom - 4) },
        { x: Math.round(r.left + 6), y: Math.round(r.bottom - 6) },
        { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + 3) }
      ];
      for (var k = 0; k < cands.length; k++) {
        var p = cands[k];
        if (p.x < 2 || p.y < 2 || p.x > window.innerWidth - 2 || p.y > window.innerHeight - 2) continue;
        var at = document.elementFromPoint(p.x, p.y);
        if (at && at.closest && at.closest('jmnode[nodeid]') === el) return p;
      }
      return null;
    }
    var out = [], off = [];
    (function walk(n, depth) {
      if (!n) return;
      if (!n.isroot && out.length < 80) {
        var el = document.querySelector('jmnode[nodeid="' + n.id + '"]');
        if (el) {
          var r = el.getBoundingClientRect();
          var inVp = r.width > 20 && r.height > 12 && r.left > 2 && r.top > 2
            && r.right < window.innerWidth - 2 && r.bottom < window.innerHeight - 2;
          if (inVp) {
            out.push({ id: n.id, pid: (n.parent ? n.parent.id : null), depth: depth,
              kids: (n.children || []).length, pt: hitPoint(el),
              rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
          } else if (off.length < 6) {
            off.push(n.id + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ' '
              + Math.round(r.width) + 'x' + Math.round(r.height));
          }
        }
      }
      (n.children || []).forEach(function (c) { walk(c, n.isroot ? 0 : depth + 1); });
    })(root, 0);
    return JSON.stringify({ ok: true, vp: { w: window.innerWidth, h: window.innerHeight },
      nodes: out, offscreenSample: off, jmnodeTotal: document.querySelectorAll('jmnode[nodeid]').length });
  })()`);
}

/** 等导图面板矩形**稳定**下来。
 *  为什么必须有这一步（实测）：冒烟里 DSH 侧栏视图是**后建**的，面板会从 1424x789 变成 729x714，
 *  这一变会把导图里的节点整体推走（实测推了 ~324px，把节点推到下方消息栏底下 ⇒ 一个点都点不到 ✗）。
 *  取景必须等它停下来，否则"刚摆好就被推走"。
 *  采不到面板 ⇒ 视为不稳定（返回 ok:false，由调用方响亮报错 ✓ 不许拿旧值继续算）。 */
async function waitPanelStable(ctx, tries) {
  let prev = null, same = 0, last = null;
  const n = tries || 8;
  for (let i = 0; i < n; i++) {
    const r = await execJson(ctx, `(function () {
      var p = window.MM && window.MM.fdPanel ? window.MM.fdPanel() : null;
      if (!p) return JSON.stringify({ ok: false, text: '没有导图面板' });
      var b = p.getBoundingClientRect();
      return JSON.stringify({ ok: true, rect: { x: b.left, y: b.top, width: b.width, height: b.height } });
    })()`);
    if (!r.ok) return r;
    last = r.rect;
    if (prev && prev.x === last.x && prev.y === last.y
      && prev.width === last.width && prev.height === last.height) {
      same++;
      if (same >= 2) {   // 连续 3 次读数一致才算稳（一次相同可能只是还没开始变 ✓）
        return { ok: true, rect: last, tries: i + 1,
          text: '面板稳定在 ' + Math.round(last.width) + 'x' + Math.round(last.height)
            + ' @(' + Math.round(last.x) + ',' + Math.round(last.y) + ')（读了 ' + (i + 1) + ' 次）' };
      }
    } else same = 0;
    prev = last;
    await new Promise((r2) => setTimeout(r2, 180));
  }
  return { ok: false, text: '面板矩形一直没稳定（最后读到 ' + JSON.stringify(last) + '）——'
    + '布局还在动，这时摆好的取景会被推走，不能拿它当真值 ✗' };
}

/** 三个节点此刻是否都点得中（每个节点都要有一个真的落在自己身上的坐标 ✓） */
async function verifyPoints(ctx, ids) {
  const pts = [];
  for (const id of ids) {
    const p = await pointFor(ctx, id);
    if (!p.ok) return { ok: false, text: '点不到 ' + id + '：' + p.text };
    pts.push(id + '@' + p.pt.x + ',' + p.pt.y);
  }
  return { ok: true, text: pts.join(' ') };
}

/** 诊断用（**只在失败路径调用** ✓）：把"这段时间里节点到底怎么漂的"记下来，
 *  连同工程自带的「重排锚点补偿」留痕（`window.__anchorLog`，见 app-view 的 wrapLayoutAnchor）。
 *  为什么值得留着：`取景后又被推走` 这类"环境在动"的失败最难查 —— 没有时间序列就只能猜 ✗。 */
async function dumpDrift(ctx, id) {
  return execJson(ctx, `(async function () {
    var panel = window.MM.fdPanel ? window.MM.fdPanel() : null;
    var sel = 'jmnode[nodeid="' + ${JSON.stringify(String(id))} + '"]';
    var samples = [];
    for (var i = 0; i < 6; i++) {
      var el = document.querySelector(sel);
      var r = el ? el.getBoundingClientRect() : null;
      var v = window.MM.getPanState ? window.MM.getPanState() : null;
      var pr = panel ? panel.getBoundingClientRect() : null;
      samples.push((r ? Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : 'null')
        + '|pan=' + (v ? Math.round(v.x) + ',' + Math.round(v.y) + ',s=' + v.s.toFixed(2) : '?')
        + '|panel=' + (pr ? Math.round(pr.left) + ',' + Math.round(pr.top) + ' ' + Math.round(pr.width) + 'x' + Math.round(pr.height) : '?'));
      await new Promise(function (res) { setTimeout(res, 150); });
    }
    return JSON.stringify({ ok: true, samples: samples,
      copies: document.querySelectorAll(sel).length,
      anchorLog: (window.__anchorLog || []).slice(-4) });
  })()`);
}

/** 挑三个节点并**把它们摆进视口**，再逐个用命中测试复核：**P**（顶层主题）→ **C**、**X**（P 的两个子节点）。
 *
 *  ① 为什么"P + C"这一对是复现的关键：`trimSelection` 的**剔父冗余**会把 C 从**裁剪集**里剔掉
 *     （父 P 也在选区里）⇒ 此后"裁剪集 ⊊ 原始集"。真机上"按住 Ctrl 点选节点的虚线框有问题"
 *     正是在这个状态之后再点第三个节点时发生的（第三个节点会把 C 的描边冲掉 ✓）。
 *  ② 为什么要"摆进视口"：本工程样本项目 551 个节点，**全展开**时视口 1424x795 里只剩 1 个节点
 *     （其余在 y=-1669 这类坐标上，实测诊断报文见提交信息）⇒ 真输入根本点不到第二个 ✗。
 *     真人遇到这种情况也会**先把要操作的节点拖进视野** ⇒ 这一步是复刻人的动作，不是给测试开小灶 ✓。
 *     摆法用 `MM.setViewTransform({s,x,y})`（精确设变换，语义见 app-view.js 的注释）。
 *  ③ 为什么最后还要复核：摆进去≠点得到（可能被工具条/详情框盖住）⇒ 每个节点都要有一个
 *     `elementFromPoint` 真的落在它自己身上的坐标（`pointFor` ✓），否则**响亮报错**（不猜 ✗）。 */
async function chooseTriple(ctx) {
  // ① **先用手头这张取景**（完全不改视图）：在视口里找"父子都点得中"的一对 + 第三个点得中的节点。
  //    为什么先试这个：真人不就是打开界面直接点吗（不先折腾视图）✓；能拿到就别动视图。
  //    本工程已有先例：29-域就是这么点的（它注释里明确写着"resetView 实测拉不回坐标，已弃用"）。
  const scan = await scanNodes(ctx);
  if (scan.ok) {
    const live = (scan.nodes || []).filter((n) => n.pt);
    let P0 = null, C0 = null;
    for (const n of live) {
      const kid = live.find((m) => m.pid === n.id && m.id !== n.id);
      if (kid) { P0 = n; C0 = kid; break; }
    }
    if (P0) {
      const X0 = live.find((n) => n.id !== P0.id && n.id !== C0.id);
      if (X0) {
        return { ok: true, P: P0, C: C0, X: X0, ids: [P0.id, C0.id, X0.id],
          diag: '沿用手头取景（未改视图）｜视口内候选 ' + scan.nodes.length + ' 个（点得中 ' + live.length + '）'
            + '｜取 P=' + P0.id + ' C=' + C0.id + '（P 的子）X=' + X0.id };
      }
    }
  }
  // ② 手头取景里没有可用的父子对 ⇒ 才动视图（收起到顶层主题 + **只展开要操作的那一个** + 取景 + 复核重试）
  const tri = await execJson(ctx, `(function () {
    var jm = window.MMApp.getState().jm;
    if (!jm) return JSON.stringify({ ok: false, text: '没有 jm' });
    // ⚠️ **不要 expandAll()，也不要 expand_to_depth(3)**（两条都实测过 ✗）：
    //    · expandAll：551 个节点全铺开 ⇒ 视口 1424x795 里只剩 1 个节点，其余在 -1669 这类坐标上；
    //    · expand_to_depth(3)：每个主题的子节点各自拖着一整棵子树 ⇒ 父与子间距被撑到 1587 逻辑像素以上
    //      （实测 spanY≥1587）⇒ 面板 729x714 连 s=0.45 都放不下，最下面那个被推到**消息栏底下**
    //      （实测节点落在 [369,762]，而 #msg-input 覆盖 [10,758 648x31]）⇒ 一个候选点都点不到 ✗。
    //    ⇒ 先收起到顶层主题，再**只展开要操作的那一个**（间距紧凑、重排次数可控 ✓）
    if (window.MM.collapseAll) window.MM.collapseAll();
    var root = jm.get_root();
    if (!root) return JSON.stringify({ ok: false, text: '取不到 jsMind 根（get_root 缺失）' });
    var topics = (root.children || []);
    var diag = [], P = null;
    for (var i = 0; i < topics.length; i++) {
      var kids = (topics[i].children || []);
      diag.push(topics[i].id + ':' + kids.length);
      if (!P && kids.length >= 2) P = { node: topics[i], kids: kids };
    }
    if (!P) return JSON.stringify({ ok: false, text: '没有"子节点 ≥2 个"的顶层主题（' + diag.join(' ') + '）' });
    // 只展开这一个主题：它的子节点才可见 ⇒ 三者相邻、间距小 ✓（expand_node 是 jsMind 的 API，
    // 且被 app-view 的"重排锚点保持"包住 ⇒ 会顺带补偿一次视图，所以取景必须放在这之后 ✓）
    if (typeof jm.expand_node === 'function') jm.expand_node(P.node.id);
    return JSON.stringify({ ok: true, P: { id: P.node.id }, C: { id: P.kids[0].id }, X: { id: P.kids[1].id },
      ids: [P.node.id, P.kids[0].id, P.kids[1].id],
      diag: '顶层主题（子节点数） ' + diag.join(' ') });
  })()`);
  if (!tri.ok) {
    // 失败要把"现场"一起报出来（本工程的老规矩：红色必须能自己解释自己 ✓）
    const scan = await scanNodes(ctx);
    const extra = scan.ok
      ? ' ｜ 视口内可见节点 ' + scan.nodes.length + ' 个（其中点得中 ' + scan.nodes.filter((n) => n.pt).length
        + '）样本=' + scan.nodes.slice(0, 6).map((n) => n.id + (n.pt ? '✓' : '✗')).join(' ')
        + ' ｜ 视口外样本=' + (scan.offscreenSample.join(' ') || '无')
      : ' ｜ 扫描也失败：' + scan.text;
    return { ok: false, text: tri.text + extra };
  }
  // 展开一个主题会触发一次 jsMind 重排（并被"重排锚点保持"补偿一次视图）⇒ 先让它落定再取景 ✓
  await WAIT.frames(ctx, { delayMs: 420 });
  // ②′ 布局本身会动（侧栏后建把面板从 1424x789 改成 729x714）⇒ 等它稳下来再取景 ✓
  const stab = await waitPanelStable(ctx);
  if (!stab.ok) return stab;
  // ③ 取景 + 命中复核：**重试**到"三点都点得中"为止（布局可能在取景后又微微动一次 ⇒ 再摆一次即可）
  // ② 摆进视口：先按跨度定缩放，再按**实测落点**做纯平移把它挪到面板中心。
  //    ⚠️ 为什么用"测量式平移"而不是自己算 (x,y)：变换的原点取决于被变换元素的布局原点
  //    （连线层还有 dataset.ox/oy 的自定义原点 —— 见 app-view 的 fdApplyView），
  //    自己推公式曾经把节点送到了 y=762（**压在下方消息栏下**，实测报文见提交信息 ✗）。
  //    而**平移是可加的**：屏幕落点想右移 Δ 就把 x 加 Δ ⇒ 不依赖任何原点假设 ✓
  let fit = null, ver = null, tries = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
  tries++;
  fit = await execJson(ctx, `(function () {
    var MM = window.MM, ids = ${JSON.stringify(tri.ids)};
    if (!MM.getPanState || !MM.setViewTransform) {
      return JSON.stringify({ ok: false, text: '视图 API 缺失（getPanState / setViewTransform）' });
    }
    var panel = MM.fdPanel();
    if (!panel) return JSON.stringify({ ok: false, text: '没有导图面板' });
    var pr = panel.getBoundingClientRect();
    function rects() {
      return ids.map(function (id) {
        var el = document.querySelector('jmnode[nodeid="' + id + '"]');
        return el ? el.getBoundingClientRect() : null;
      });
    }
    function centerOf(rs) {
      var xs = [], ys = [];
      rs.forEach(function (r) { if (r && r.width > 0 && r.height > 0) { xs.push(r.left + r.width / 2); ys.push(r.top + r.height / 2); } });
      if (!xs.length) return null;
      return { x: (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2,
        y: (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2 };
    }
    var r0 = rects();
    for (var i = 0; i < r0.length; i++) {
      if (!r0[i] || !(r0[i].width > 0 && r0[i].height > 0)) {
        return JSON.stringify({ ok: false, text: '节点 ' + ids[i] + ' 不可见（没展开？布局把它藏了？）' });
      }
    }
    var v0 = MM.getPanState();
    var c0 = centerOf(r0);
    var xs0 = r0.map(function (r) { return r.left + r.width / 2; });
    var ys0 = r0.map(function (r) { return r.top + r.height / 2; });
    // 跨度换算回**逻辑**坐标（除以当前缩放）；留出节点自身宽度/高度与工具条的余量
    var spanX = (Math.max.apply(null, xs0) - Math.min.apply(null, xs0)) / v0.s + 280;
    var spanY = (Math.max.apply(null, ys0) - Math.min.apply(null, ys0)) / v0.s + 160;
    var s = Math.max(0.45, Math.min(1, Math.min(pr.width / spanX, pr.height / spanY)));
    MM.setViewTransform({ s: s, x: v0.x, y: v0.y });          // 先只改缩放
    var c1 = centerOf(rects());
    if (!c1) return JSON.stringify({ ok: false, text: '缩放后取不到三点落点' });
    var tx = pr.left + pr.width / 2, ty = pr.top + pr.height / 2;
    MM.setViewTransform({ s: s, x: v0.x + (tx - c1.x), y: v0.y + (ty - c1.y) });   // 再纯平移
    var c2 = centerOf(rects());
    return JSON.stringify({ ok: true, s: s, scaled: c0, before: c1, after: c2,
      text: '视图 s=' + s.toFixed(2) + '；三点落点 (' + Math.round(c1.x) + ',' + Math.round(c1.y) + ') → 平移 '
        + Math.round(tx - c1.x) + ',' + Math.round(ty - c1.y) + ' → (' + Math.round(c2 ? c2.x : -1) + ','
        + Math.round(c2 ? c2.y : -1) + ')，面板中心 (' + Math.round(tx) + ',' + Math.round(ty) + ')' });
  })()`);
  if (!fit.ok) return fit;
  await WAIT.frames(ctx, { delayMs: 380 });
  ver = await verifyPoints(ctx, tri.ids);
  if (ver.ok) break;
  }
  if (!ver || !ver.ok) {
    // 重试三次仍点不到 ⇒ 响亮报红（可能是真的被浮层挡住，也可能是取景没法稳定 —— 两种都要看见 ✓）
    const drift = await dumpDrift(ctx, tri.ids[0]);
    return { ok: false, text: '取景 + 命中复核试了 ' + tries + ' 次仍点不到：' + (ver ? ver.text : '（无复核结果）')
      + ' ｜ ' + tri.diag + ' ｜ ' + (fit ? fit.text : '')
      + (drift.ok ? ' ｜ 漂移采样(节点|pan|panel)：' + drift.samples.join(' → ')
        + ' ｜ 同名 jmnode 元素数=' + drift.copies + ' ｜ 锚点补偿留痕=' + JSON.stringify(drift.anchorLog)
        : ' ｜ 漂移采样失败：' + drift.text) };
  }
  return { ok: true, P: tri.P, C: tri.C, X: tri.X, ids: tri.ids,
    diag: tri.diag + ' ｜ ' + (fit ? fit.text : '') + ' ｜ 命中复核 ' + ver.text + '（取景尝试 ' + tries + ' 次）' };
}

/** 取一个**此刻真的命中该节点**的坐标（每次点击前都要重取 —— 工具条/详情框会盖住旧候选 ✗）。
 *  `elementFromPoint` 是"命中测试"的直接证据：它返回的就是真人点到时会拿到事件的那个元素 ✓ */
async function pointFor(ctx, id) {
  return execJson(ctx, `(function () {
    var el = document.querySelector('jmnode[nodeid="' + ${JSON.stringify(String(id))} + '"]');
    if (!el) return JSON.stringify({ ok: false, text: '找不到节点元素' });
    var r = el.getBoundingClientRect();
    var cands = [
      { x: Math.round(r.left + 6), y: Math.round(r.top + Math.round(r.height / 2)) },
      { x: Math.round(r.right - 6), y: Math.round(r.top + Math.round(r.height / 2)) },
      { x: Math.round(r.left + 6), y: Math.round(r.bottom - 6) },
      { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.bottom - 4) },
      { x: Math.round(r.left + Math.round(r.width / 2)), y: Math.round(r.top + 3) }
    ];
    var rej = [];
    for (var k = 0; k < cands.length; k++) {
      var p = cands[k];
      if (p.x < 2 || p.y < 2 || p.x > window.innerWidth - 2 || p.y > window.innerHeight - 2) { rej.push('越界'); continue; }
      var at = document.elementFromPoint(p.x, p.y);
      if (at && at.closest && at.closest('jmnode[nodeid]') === el) return JSON.stringify({ ok: true, pt: p });
      var who = at ? (at.tagName + (at.id ? '#' + at.id : '') + (at.className && typeof at.className === 'string' ? '.' + at.className.split(' ')[0] : '')) : 'null';
      var ar = at ? at.getBoundingClientRect() : null;
      rej.push('(' + p.x + ',' + p.y + ')→' + who + (ar ? '[' + Math.round(ar.left) + ',' + Math.round(ar.top) + ' '
        + Math.round(ar.width) + 'x' + Math.round(ar.height) + ']' : ''));
    }
    return JSON.stringify({ ok: false, text: '该节点此刻没有可命中点（1 个点都没通过命中测试）；节点矩形 ['
      + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
      + ']；各候选：' + rej.join(' '),
      covering: rej });
  })()`);
}

/** 挑一个**真的落在空白画布上**的点（清选区要求起点是背景） */
async function pickBlankPoint(ctx, avoidRects) {
  return execJson(ctx, `(function () {
    var avoid = ${JSON.stringify(avoidRects || [])};
    var p = window.MM.fdPanel();
    var r = p.getBoundingClientRect();
    function ok(pt) {
      if (pt.x < r.left + 4 || pt.x > r.right - 4 || pt.y < r.top + 4 || pt.y > r.bottom - 4) return false;
      for (var i = 0; i < avoid.length; i++) {
        var a = avoid[i];
        if (pt.x >= a.x - 6 && pt.x <= a.x + a.width + 6 && pt.y >= a.y - 6 && pt.y <= a.y + a.height + 6) return false;
      }
      var at = document.elementFromPoint(pt.x, pt.y);
      if (!at) return false;
      if (at.closest && at.closest('jmnode[nodeid]')) return false;          // 不能点在节点上
      if (at.closest && at.closest('.float-detail')) return false;           // 也不能点在浮窗上
      if (at.closest && at.closest('#mm-node-toolbar')) return false;
      return !!(at.closest && at.closest('jmnodes, canvas.jsmind'));         // 与实现的"能起框选"判据同款
    }
    for (var gx = 0.06; gx <= 0.95; gx += 0.11) {
      for (var gy = 0.1; gy <= 0.95; gy += 0.11) {
        var pt = { x: Math.round(r.left + r.width * gx), y: Math.round(r.top + r.height * gy) };
        if (ok(pt)) return JSON.stringify({ ok: true, pt: pt });
      }
    }
    return JSON.stringify({ ok: false, text: '找不到落在空白画布上的点（面板 ' + Math.round(r.width) + 'x'
      + Math.round(r.height) + '，可见节点占满？）' });
  })()`);
}

/* ---------------- 读数：选区 / 描边 / 工具条 / 大虚线框（一次读全，便于写进断言文本） ---------------- */

function snapshot(ctx, ids) {
  return execJson(ctx, `(function () {
    var MM = window.MM;
    var ids = ${JSON.stringify(ids)};
    var cls = (MM.rawSelectionClass && MM.rawSelectionClass()) || 'mm-sel-raw';
    var nodes = ids.map(function (id) {
      var el = document.querySelector('jmnode[nodeid="' + id + '"]');
      if (!el) return { id: id, found: false };
      var r = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      return {
        id: id, found: true,
        cls: el.classList.contains(cls),
        outline: cs.outlineStyle + ' ' + cs.outlineWidth,
        dashed: cs.outlineStyle === 'dashed' && parseFloat(cs.outlineWidth) >= 1.5,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height }
      };
    });
    // 实际带描边类的节点（**不看 ids 白名单** ⇒ 能抓到"多出来的残影" ✓）
    var painted = Array.prototype.slice.call(document.querySelectorAll('jmnode.' + cls))
      .map(function (el) { return el.getAttribute('nodeid'); });
    var box = document.getElementById('dsh-selection-outline');
    var bar = document.getElementById('mm-node-toolbar');
    var barVisible = !!(bar && bar.parentElement && bar.style.display !== 'none');
    var askEl = bar ? bar.querySelector('.mm-tb-ask') : null;
    var expEl = bar ? bar.querySelector('.mm-tb-explain') : null;
    // 浮层矩形（像素判据里要**挖掉**它们：工具条上的蓝色按钮、详情框都会污染计数 ✗）
    var overlays = [];
    if (barVisible) {
      var br = bar.getBoundingClientRect();
      if (br.width > 0) overlays.push({ x: br.left, y: br.top, width: br.width, height: br.height });
    }
    Array.prototype.slice.call(document.querySelectorAll('.float-detail')).forEach(function (b) {
      var r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) overlays.push({ x: r.left, y: r.top, width: r.width, height: r.height });
    });
    return JSON.stringify({
      raw: MM.getSelectionRaw ? MM.getSelectionRaw() : [],
      kept: MM.getSelection ? MM.getSelection().ids : [],
      painted: painted,
      nodes: nodes,
      boxVisible: !!box && box.style.display !== 'none',
      barVisible: barVisible,
      barCount: bar ? bar.getAttribute('data-count') : null,
      barNodes: bar ? bar.getAttribute('data-node') : null,
      askText: askEl ? askEl.textContent : null,
      explainText: expEl ? expEl.textContent : null,
      overlays: overlays,
      dpr: window.devicePixelRatio || 1
    });
  })()`);
}

/* ---------------- 像素判据（截图读数的实现在这里） ---------------- */

/** CSS 像素矩形 → 设备像素（截图是设备像素，`getBoundingClientRect` 是 CSS 像素；
 *  与 `scripts/vision/roi-assertions.js` 同一口径 ✓） */
function toDev(rect, dpr) {
  return { x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) };
}
function inflate(rect, n) {
  return { x: rect.x - n, y: rect.y - n, width: rect.width + 2 * n, height: rect.height + 2 * n };
}
/** 节点外圈带上的"强调蓝"像素（描边就画在这条带上：`outline` + `outline-offset:2px` + 2px 宽）
 *  `exclude` = 节点自身内部 + 浮层 ⇒ 只数"露在画面上的那一圈" ✓ */
function ringScan(img, node, dpr, overlays) {
  if (!node || !node.rect) return { ok: false, reason: '节点没有矩形（找不到 DOM 或不可见）', hits: 0, longestRun: 0 };
  const outer = toDev(inflate(node.rect, 6), dpr);
  const ex = [toDev(node.rect, dpr)].concat((overlays || []).map((o) => toDev(o, dpr)));
  return frameStats.scanRegion(img, outer, { exclude: ex });
}

/** 矩形（CSS px）按 dpr 换算到设备像素，并**裁到导图面板内**。
 *  为什么必须裁（这是 2026-10-16 那条红的成因之一）：大框挂在 `jmnodes` 里 ⇒ 面板的
 *  `overflow` 会把它超出面板的部分裁掉；DOM 给的 rect 是**未裁**的（可能 x<0 或伸进 DSH 侧栏）。
 *  ROI 不裁就会把工具栏 / 侧栏的像素算进来 ⇒ 判的是别处的东西（假红/假绿都可能有）。
 *  裁没了 ⇒ `null`：调用方按"这块不可判"如实报，**不许**按 0 命中算（采不到真值 = 红，见 A5）。 */
function clipToPanelDev(rectCss, panelCss, dpr) {
  const x0 = Math.max(rectCss.x, panelCss.x), y0 = Math.max(rectCss.y, panelCss.y);
  const x1 = Math.min(rectCss.x + rectCss.width, panelCss.x + panelCss.width);
  const y1 = Math.min(rectCss.y + rectCss.height, panelCss.y + panelCss.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return toDev({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, dpr);
}

/** 大框的**四条边框带**（CSS px）。大框的墨只画在边框上（`ensureSelOutline`：`border:2px dashed
 *  #1664ff`）；框内的底色 `rgba(22,100,255,.06)` **不是**"框画出来了"的证据（画面看上去仍是白底，
 *  实测整块只把像素抬 ~9–14）。`t` = 外扩量（CSS px）：2px 边框 + 抗锯齿 + 亚像素落点都吃得下。 */
function boxBands(r, t) {
  return [
    { x: r.x - t, y: r.y - t, width: r.width + 2 * t, height: 2 * t },              // 上边沿
    { x: r.x - t, y: r.y + r.height - t, width: r.width + 2 * t, height: 2 * t },  // 下边沿
    { x: r.x - t, y: r.y + t, width: 2 * t, height: r.height - 2 * t },            // 左边沿
    { x: r.x + r.width - t, y: r.y + t, width: 2 * t, height: r.height - 2 * t }   // 右边沿
  ];
}

/** 两帧在一个 ROI（若干矩形的**并集**）里的**强差分**像素数：任一分通道差 ≥ `tol` 才算"这一像素变了"。
 *
 *  为什么是**差分**：ROI 里必然有地图自己的东西（节点、连线、文字、expander），它们在两帧里
 *  逐字节相同 ⇒ 差分把它们**消掉**，剩下的才是"这一档动作自己画出来的" ✓（`testing-for-ai` H3
 *  的"判据自身也要做对照实验"：被测对象有两种状态（框画了 / 没画），判据必须能分辨它们）。
 *  为什么是**强**差分（阈值而不是"不相等"）：大框的底色整块只抬 ~9–14（见 `boxBands`）⇒ 拿
 *  "不相等"会把**底色**当成"框画出来了" ✗；2px 虚线描边差 100+ ⇒ 只有它算数 ✓
 *  为什么在并集上数：四条带在角上会重叠 ⇒ 用 `inBands` 判一次，避免角上像素被数两遍。 */
function diffPx(imgA, imgB, rectsDev, excludeDev, tol) {
  const ia = frameStats.bitmapInfo(imgA), ib = frameStats.bitmapInfo(imgB);
  if (!ia.ok || !ib.ok || ia.width !== ib.width || ia.height !== ib.height) {
    return { ok: false, hits: 0, px: 0, reason: '两帧位图与尺寸对不上 ⇒ 采不到真值（不许按 0 算）' };
  }
  const rs = (rectsDev || []).filter(Boolean);
  if (!rs.length) return { ok: false, hits: 0, px: 0, reason: 'ROI 被裁空了（大框不在面板里？）' };
  const ex = (excludeDev || []).filter(Boolean);
  const hit = (list, x, y) => list.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  rs.forEach((r) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height); });
  let hits = 0, px = 0;
  for (let y = Math.max(0, y0); y < Math.min(ia.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(ia.width, x1); x++) {
      if (!hit(rs, x, y) || hit(ex, x, y)) continue;
      px++;
      const o = (y * ia.width + x) * 4;
      const d = Math.max(Math.abs(ia.bmp[o] - ib.bmp[o]),
        Math.abs(ia.bmp[o + 1] - ib.bmp[o + 1]), Math.abs(ia.bmp[o + 2] - ib.bmp[o + 2]));
      if (d >= tol) hits++;
    }
  }
  return { ok: true, hits: hits, px: px };
}

/** 【大框判据的**唯一**入口】三帧差分，ROI = **大框自己的四条边框带**。
 *  位置由 DOM 给（rect 只回答"去哪儿看"），**判"画没画"一律由像素回答** —— 设计稿 §3 明令可见性
 *  **不许 DOM 自证** ✗。
 *
 *  三帧（同一次跑、同一个几何，变量只有"框画不画"这一个）：
 *   · `cur` = 产品**当前**状态（Ctrl 加选 ⇒ 期望没有大框）
 *   · `off` = 与产品**同一跳**造出来的"已知无框"参照（`applySelection(ids, ids, {hideBox:true})`）
 *   · `on`  = "已知有框"的对照（`applySelection(ids, ids)`）
 *  两侧判据（缺一条这条判据就不成立，见 `thresholds.dashStroke` 里两个键的标定）：
 *   ① **产品**：`diff(off, cur) ≤ maxBoxDrift` —— 当前状态与"无框参照"在框的那条带上没有差别；
 *   ② **判据自检**：`diff(off, on) ≥ minBoxSig` —— 把框真的画出来时这条判据**必须看得见**
 *      （否则它空转：读数与"框画没画"无关 ⇒ **判红**，不许当通过 ✓）。
 *
 *  ⚠️ 这条判据的前身是"最上面节点上方 62px 的那条窄带"。2026-10-16 实测**证伪**（证据：
 *  `.review/20261014-导图交互重构/probe-box-frames-diff.out.json` 与 `-recheck.out.json`）：
 *  那条带按"最上面节点的 rect.top − 62"取，实测落在**应用工具栏那一层**（y 19–73）；而大框的
 *  可见区在 **y 81–643**（它被面板上沿裁掉，只剩一条下边沿 + 一片底色）⇒ 那条带与框**不相交**。
 *  注入 `big-box`（DOM 大框可见=true、与无框帧的强差分 1020 px / 松差分 361,363 px）之后，
 *  那条带的读数**一个像素都没变**（37 → 37）⇒ 它量的是工具栏、不是框（空转假绿）；而全链那次
 *  又因为框的一条边恰巧落进带里，被"`delta ≤ 40`"判红（69 > 40）⇒ **两个方向都是判据缺陷**，
 *  不是产品回归（产品侧另有 `boxVisible === false` 与读图证据）。
 *
 *  ⚠️ 收尾把选区**清空**（与调用方随后的 `cleanup(ctx)` 同口径），不给后面的断言留状态。 */
async function boxPixelDiff(ctx, dpr, overlays, ids, shotName) {
  const sel = (hide) => ctx.exec('(function () { window.MM.applySelection(' + JSON.stringify(ids || []) + ', '
    + JSON.stringify(ids || []) + ', { hideBox: ' + (hide ? 'true' : 'false') + ' }); return 1; })()');
  const cur = await ctx.input.capture();
  await sel(true);
  await WAIT.frames(ctx, { delayMs: 150 });
  const off = await ctx.input.capture();
  await sel(false);
  await WAIT.frames(ctx, { delayMs: 150 });
  const on = await ctx.input.capture();
  /* 框的 rect 只在**画着**的时候有意义（display:none 时 getBoundingClientRect 全是 0）⇒
   * 位置与"对照档到底画出来没有"一起在这一刻读；顺带把**这一刻**的浮层矩形也取回来并进挖除名单
   * （② 的 overlays 取自 snapshot 那一刻，⑤ 那一刻工具条是关着的 ⇒ 单用它会让工具条漏进 ROI）。 */
  const geo = await execJson(ctx, `(function () {
    var el = document.getElementById('dsh-selection-outline');
    var p = window.MM && window.MM.fdPanel ? window.MM.fdPanel() : null;
    if (!el || !p) return JSON.stringify({ ok: false, reason: '大框元素或导图面板取不到' });
    var r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
    var ov = [];
    var bar = document.getElementById('mm-node-toolbar');
    if (bar && bar.parentElement && bar.style.display !== 'none') {
      var br = bar.getBoundingClientRect();
      if (br.width > 0) ov.push({ x: br.left, y: br.top, width: br.width, height: br.height });
    }
    Array.prototype.slice.call(document.querySelectorAll('.float-detail')).forEach(function (b) {
      var q = b.getBoundingClientRect();
      if (q.width > 0 && q.height > 0) ov.push({ x: q.left, y: q.top, width: q.width, height: q.height });
    });
    return JSON.stringify({ ok: true, display: el.style.display, overlays: ov,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      panel: { x: pr.left, y: pr.top, width: pr.width, height: pr.height } });
  })()`);
  const rec = shotName ? await ctx.input.shot(shotName, on) : null;
  await ctx.exec('(function () { window.MM.applySelection([], [], { hideBox: true });'
    + ' if (window.MM.paintRawSelection) window.MM.paintRawSelection(); return 1; })()');
  await WAIT.frames(ctx, { delayMs: 150 });
  // 对照档必须**真的**把框画出来了：画不出来 ⇒ 这条判据没有可判的对象 ⇒ 按红计（不许当通过）
  if (!geo || !geo.ok || geo.display !== 'block' || !(geo.rect.width >= 1 && geo.rect.height >= 1)) {
    return { ok: false, sig: null, drift: null,
      text: '对照档没画出大框（display=' + JSON.stringify(geo && geo.display) + ' rect='
        + JSON.stringify(geo && geo.rect) + (geo && geo.reason ? ' ' + geo.reason : '')
        + '）⇒ 采不到真值，按红计（不许当通过）' };
  }
  const ex = (overlays || []).concat((geo.overlays || [])).map((o) => toDev(o, dpr));
  const bandsDev = boxBands(geo.rect, 3).map((b) => clipToPanelDev(b, geo.panel, dpr));
  const sig = diffPx(off, on, bandsDev, ex, TH.dashStroke.boxDiffTol);
  const drift = diffPx(off, cur, bandsDev, ex, TH.dashStroke.boxDiffTol);
  const ok = sig.ok === true && drift.ok === true
    && sig.hits >= TH.dashStroke.minBoxSig && drift.hits <= TH.dashStroke.maxBoxDrift;
  return { ok: ok, sig: sig, drift: drift, rect: geo.rect,
    text: '大框带（ROI=框四条边 ±3px、裁到面板内）｜ 对照(画框−无框)=' + (sig.ok ? sig.hits : ('采不到：' + sig.reason))
      + '（地板 ≥' + TH.dashStroke.minBoxSig + '）｜ 当前(当前−无框)=' + (drift.ok ? drift.hits : ('采不到：' + drift.reason))
      + '（上限 ≤' + TH.dashStroke.maxBoxDrift + '）｜ 框 rect=[' + Math.round(geo.rect.x) + ','
      + Math.round(geo.rect.y) + ' ' + Math.round(geo.rect.width) + 'x' + Math.round(geo.rect.height) + ']'
      + ' ｜ 强差分 tol=' + TH.dashStroke.boxDiffTol
      + (rec ? ' ｜ 对照帧证据 ' + rec.name + ' ' + rec.bytes + 'B' : '') };
}

/**
 * 截一张帧并按判据扫描，直到满足 `ok(scan)`（或试完次数的上限）。
 * **为什么允许重拍**：隐藏窗口的 `capturePage()` 可能给旧帧（`17-ui-polish.js` 实测记录），
 * 那时旧帧里"描边还没出现" —— 重拍能排除它；而**真的没画出来**时怎么拍都读不到（⇒ 判红 ✓）。
 * 返回的最后那一帧**同时也是落盘证据**（数字与图片同源 ✓）。
 */
async function captureUntil(ctx, scanFn, ok, tries) {
  let scan = null, img = null, attempts = 0;
  const n = tries || 3;
  for (let i = 0; i < n; i++) {
    attempts++;
    img = await ctx.input.capture();
    scan = scanFn(img);
    if (scan && scan.ok && (!ok || ok(scan))) break;
    if (i < n - 1) await new Promise((r) => setTimeout(r, 260));
  }
  return { scan: scan, img: img, attempts: attempts };
}

/** 多节点外圈带的命中数一览（写进断言文本 ✓） */
const hitsLine = (rings) => (rings || []).map((r) => (r ? r.hits : -1)).join(',');
/** 一组节点矩形是否都"算出了 dashed 描边" */
const allDashed = (s) => (s.nodes || []).every((n) => n.found && n.cls && n.dashed);
/** 可读的 id 列表 */
const idLine = (ids) => '[' + (ids || []).join(',') + ']';
/** 工具条按钮文案里的数量（「💬 问这 N 个」→ N；「💬 问问AI」→ null） */
function countInLabel(text) {
  const m = /问这\s*(\d+)\s*个/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** 收尾复位：清选区（含原始集）+ 关浮窗 + 收起工具条。
 *  ⚠️ **不要在这里调 resetView()**：实测会把 s 拉回 1 并把合成根怼到面板中心 ⇒ 下一条断言
 *  （以及下一次跑）拿到的取景里只剩根附近一个节点，"父子都点得中"的一对直接不存在 ✗。
 *  最终那张整屏截图的取景由 `main.js` 的 `prepareCapture` 自己复位（它才是那件事的责任人 ✓）。 */
async function cleanup(ctx) {
  await ctx.exec(`(function () {
    var MM = window.MM;
    if (window.MMApp && window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    if (MM.askBoxes) MM.askBoxes().forEach(function (b) { if (MM.closeFdBox) MM.closeFdBox(b); });
    if (MM.applySelection) MM.applySelection([], [], { hideBox: true });
    if (MM.paintRawSelection) MM.paintRawSelection();
    if (MM.hideNodeToolbar) MM.hideNodeToolbar();
    return 1;
  })()`);
  await WAIT.frames(ctx, { delayMs: 200 });
}

/** 底座可用性：没有 `ctx.input` 时**必须红**（不许跳过再宣称通过 ✗） */
function noBase() {
  return { ok: false, text: '没有真输入底座（ctx.input 缺失：非 --smoke 路径 / createDriver 构造失败）'
    + '—— 本域不是"跳过"，是**红**：真输入能力缺失时这些契约一条都没被验过 ✗' };
}

/** 依次真 Ctrl+点击若干节点：**每次点击前重取命中点**（工具条会盖住旧点 ✗）并记录落定后的状态 */
async function ctrlClickAll(ctx, ids, stepLog) {
  for (const id of ids) {
    const pt = await pointFor(ctx, id);
    if (!pt.ok) return { ok: false, text: '点不到 ' + id + '：' + pt.text };
    await ctx.input.click(pt.pt, ['control']);
    await WAIT.frames(ctx, { delayMs: 150 });
    if (stepLog) {
      const s = await snapshot(ctx, []);
      stepLog.push('Ctrl+点 ' + id + '(' + pt.pt.x + ',' + pt.pt.y + ') ⇒ raw=' + idLine(s.raw) + ' 描边='
        + idLine(s.painted) + ' N=' + s.barCount);
    }
  }
  return { ok: true };
}

module.exports = [
  /* ============================ ① 真命中测试自证 ============================ */
  {
    name: '真输入①：真鼠标点中 <jmnode>（走 Chromium 命中测试）⇒ 按被点节点打开详情框（含点空处对照组）',
    run: async (ctx) => {
      if (!ctx.input) return noBase();
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: '铺场失败：' + pre.text };
      const pick = await chooseTriple(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const T = pick.P;
      const pt = await pointFor(ctx, T.id);
      if (!pt.ok) return { ok: false, text: '点不到 ' + T.id + '：' + pt.text };
      const before = await execJson(ctx, `(function () {
        var boxes = window.MM.getFloatDetailState ? window.MM.getFloatDetailState().boxes : -1;
        var at = document.elementFromPoint(${pt.pt.x}, ${pt.pt.y});
        var hit = at && at.closest ? at.closest('jmnode[nodeid]') : null;
        return JSON.stringify({ ok: true, boxes: boxes, hitId: hit ? hit.getAttribute('nodeid') : null,
          dpr: window.devicePixelRatio || 1 });
      })()`);
      // 判别力证明：miss-click ⇒ 故意点在节点**外侧** 60px 处（那里命中的是别人/背景）
      const clickPt = INJECT === 'miss-click'
        ? { x: Math.max(4, pt.pt.x - 60), y: pt.pt.y } : pt.pt;
      await ctx.input.click(clickPt, []);
      await WAIT.frames(ctx);
      const after = JSON.parse(await waitFor(ctx, `(function () {
        var st = window.MM.getFloatDetailState ? window.MM.getFloatDetailState() : null;
        if (!st) return JSON.stringify({ ok: false, text: '没有 getFloatDetailState' });
        // 详情框的属主读 getFloatDetailState(i).nodeId（app-detail.js 导出的唯一入口 ✓；
        // 别去读 data-node —— 那个属性只在工具条与反向链接项上 ✗ 实测栽过）
        var info = st.boxes > 0 ? window.MM.getFloatDetailState(0) : null;
        var b = document.querySelector('.float-detail');
        var r = b ? b.getBoundingClientRect() : null;
        return JSON.stringify({ ok: st.boxes > 0, boxes: st.boxes,
          nodeId: info ? info.nodeId : null,
          rect: r && r.width > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null });
      })()`, 8));
      // ★ 判据：① 点**前**该坐标命中就是 T（命中测试前提）② 点**后**详情框真的为 T 打开
      const hitOk = before.hitId === T.id;
      const openedOk = !!after.rect && after.nodeId === T.id;
      let shotTxt = '（点完没有详情框 ⇒ 没得截）';
      if (after.rect) {
        const cap = await captureUntil(ctx, (img) => {
          const st = frameStats.analyzeRegion(img, toDev(after.rect, before.dpr));
          const v = frameStats.passRegion(st, TH.roi);
          return { ok: v.ok, text: v.text };
        }, (s) => s.ok, 2);
        const rec = await ctx.input.shot('36-1-real-click-detail.png', cap.img);
        shotTxt = '详情框 ROI ' + (cap.scan && cap.scan.text ? cap.scan.text : '—')
          + '（重拍 ' + cap.attempts + ' 次）｜证据 ' + rec.name + ' ' + rec.width + 'x' + rec.height
          + ' ' + rec.bytes + 'B sha256=' + rec.sha256;
      }
      // 对照组：**真的点一下空白** ⇒ 不该出现"属于这个节点"的详情框（证明"点到什么"确实由命中测试决定 ✓）。
      // ⚠️ 判据不能写成"详情框数量不变"：点空白本身会**关掉**已开的详情框（那是既有行为 ✓），
      //    数量的变化不是缺陷；要判的是"没有凭空打开 T 的框" ✓
      const blank = await pickBlankPoint(ctx, after.rect ? [after.rect] : []);
      let controlTxt = '（对照组没跑：找不到空白点）';
      let controlOk = true;
      if (blank.ok) {
        await ctx.input.click(blank.pt, []);
        await WAIT.frames(ctx);
        const c = await execJson(ctx, `(function () {
          var st = window.MM.getFloatDetailState ? window.MM.getFloatDetailState() : null;
          if (!st) return JSON.stringify({ ok: true, boxes: -1, hasT: false });
          var hasT = false;
          for (var i = 0; i < st.boxes; i++) {
            var b = window.MM.getFloatDetailState(i);
            if (b && b.nodeId === ${JSON.stringify(T.id)}) hasT = true;
          }
          return JSON.stringify({ ok: true, boxes: st.boxes, hasT: hasT });
        })()`);
        controlOk = c.hasT !== true;
        controlTxt = '点空白(' + blank.pt.x + ',' + blank.pt.y + ') 后详情框=' + c.boxes
          + '、其中属于 ' + T.id + ' 的=' + c.hasT + '（必须 false ✓）';
      }
      await cleanup(ctx);
      return {
        ok: hitOk && openedOk && controlOk,
        text: '节点 ' + T.id + ' ｜ 点前 该坐标命中=' + before.hitId + '（应 ' + T.id + '）｜ 真输入事件 '
          + ctx.input.sentCount() + ' 条 ｜ 点后详情框=' + after.boxes + ' 属主=' + after.nodeId + '（应 ' + T.id + '）'
          + ' ｜ 点前详情框=' + before.boxes + ' ｜ 对照组：' + controlTxt + ' ｜ 截图：' + shotTxt
      };
    }
  },

  /* ============================ ② 三个都描边 + 没有大框 + N=3 ============================ */
  {
    name: '真输入②：Ctrl 依次加选 3 个（含父子）⇒ 3 个都真的有虚线描边（DOM+计算样式+像素）且没有大虚线框、N=3',
    run: async (ctx) => {
      if (!ctx.input) return noBase();
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: '铺场失败：' + pre.text };
      const pick = await chooseTriple(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const ids = [pick.P.id, pick.C.id, pick.X.id];
      const s0 = await snapshot(ctx, ids);
      const dpr = s0.dpr;
      // 基线帧（差分用：同一 ROI 前后各读一次 ⇒ 旧帧只会造成假红，不会假绿 ✓）
      const cap0 = await captureUntil(ctx, (img) => ({
        ok: true, rings: s0.nodes.map((n) => (n.rect ? ringScan(img, n, dpr, s0.overlays) : null))
      }), null, 1);
      const baseHits = (cap0.scan && cap0.scan.rings) || [];
      const log = [];
      const clicked = await ctrlClickAll(ctx, ids, log);
      if (!clicked.ok) { await cleanup(ctx); return { ok: false, text: clicked.text + ' ｜ 逐步：' + log.join(' ／ ') }; }
      const settled = await waitFor(ctx, `(function () {
        var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
        return JSON.stringify({ ok: raw.length === ${ids.length} });
      })()`, 8);
      // 判别力证明：big-box ⇒ 把大虚线框画出来（不传 hideBox）
      if (INJECT === 'big-box') {
        await ctx.exec('(function () { var r = window.MM.getSelectionRaw();'
          + ' window.MM.applySelection(r, r); return 1; })()');
        await WAIT.frames(ctx, { delayMs: 150 });
      }
      // 判别力证明：invisible-outline ⇒ DOM/计算样式全绿、**像素没了**
      if (INJECT === 'invisible-outline') {
        await ctx.exec("(function () { var cls = window.MM.rawSelectionClass ? window.MM.rawSelectionClass() : 'mm-sel-raw';"
          + " document.querySelectorAll('jmnode.' + cls).forEach(function (el) { el.style.outlineColor = 'transparent'; });"
          + ' return 1; })()');
        await WAIT.frames(ctx, { delayMs: 150 });
      }
      const s1 = await snapshot(ctx, ids);
      const cap1 = await captureUntil(ctx, (img) => ({
        ok: true,
        rings: s1.nodes.map((n) => (n.rect ? ringScan(img, n, dpr, s1.overlays) : null))
      }), (sc) => sc.rings.every((r) => r && r.hits >= TH.dashStroke.minHits),
        INJECT === 'invisible-outline' ? 2 : 3);
      const rec = await ctx.input.shot('36-2-ctrl-three-nodes.png', cap1.img);
      // 【大框判据】三帧差分，ROI = **框自己的四条边框带**（读 `boxPixelDiff` 与
      //   `thresholds.dashStroke` 里 `minBoxSig`/`maxBoxDrift` 的头注释 + 那条红的两份读图证据）。
      //   一句话：这条带按"框在哪儿"取，不按"最上面那个节点在哪儿"猜 —— 猜的那版实测落在**应用工具栏**
      //   那一层（y 19–73），而框在 y 81–643 ⇒ 注入把框画出来后读数一个像素没变（空转假绿）；
      //   全链那次又因框的一条边恰巧进带而被 `delta ≤ 40` 判红 ⇒ 判据本身是坏的，不是产品回归。
      //   ⚠️ 必须在**撤销注入之前**量：`big-box` 注入下"当前档"本来就画着框 ⇒ `当前−无框` 必然很大
      //   ⇒ 这条判据当场变红（判别力证明 ✓，与 `s1.boxVisible` 一起红）。
      const boxDiff = await boxPixelDiff(ctx, dpr, s1.overlays, s1.raw, '36-2b-box-control-on.png');
      // 撤销注入（别把违规态留给后面的断言 ✓）
      if (INJECT === 'invisible-outline') {
        await ctx.exec("(function () { document.querySelectorAll('jmnode').forEach(function (el) { el.style.outlineColor = ''; }); return 1; })()");
      }
      if (INJECT === 'big-box') {
        await ctx.exec('(function () { var r = window.MM.getSelectionRaw();'
          + ' window.MM.applySelection(r, r, { hideBox: true }); return 1; })()');
      }
      const rings = cap1.scan.rings;
      const ringOk = rings.every((r, i) => r && r.ok && r.hits - (baseHits[i] ? baseHits[i].hits : 0) >= TH.dashStroke.minHits
        && r.longestRun <= TH.dashStroke.maxRun);
      const rawOk = s1.raw.length === ids.length && ids.every((id) => s1.raw.indexOf(id) >= 0);
      const paintedOk = s1.painted.length === ids.length && ids.every((id) => s1.painted.indexOf(id) >= 0);
      const boxOk = !s1.boxVisible && boxDiff.ok === true;
      const nOk = s1.barVisible && String(s1.barCount) === String(ids.length)
        && countInLabel(s1.askText) === ids.length;
      await cleanup(ctx);
      return {
        ok: rawOk && paintedOk && allDashed(s1) && ringOk && boxOk && nOk,
        text: 'P=' + pick.P.id + ' C=' + pick.C.id + '（P 的子节点 ⇒ 会被"剔父冗余"移出裁剪集）X=' + pick.X.id + '（第三个节点）'
          + ' ｜ 逐步：' + log.join(' ／ ')
          + ' ｜ 终态 raw=' + idLine(s1.raw) + '（期望 ' + idLine(ids) + '）｜ 带描边类的节点=' + idLine(s1.painted)
          + ' ｜ 计算样式=' + s1.nodes.map((n) => n.id + ':' + n.outline).join(' ')
          + ' ｜ 像素 外圈带命中(基线→现在)=' + ids.map((id, i) => id + ':' + (baseHits[i] ? baseHits[i].hits : -1)
            + '→' + (rings[i] ? rings[i].hits : -1)).join(' ')
          + ' 最长连续=' + (rings || []).map((r) => (r ? r.longestRun : -1)).join(',')
          + '（阈值 命中≥' + TH.dashStroke.minHits + '、连续≤' + TH.dashStroke.maxRun + '）'
          + ' ｜ 大虚线框 DOM可见=' + s1.boxVisible + ' ｜ ' + boxDiff.text
          + ' ｜ 工具条 data-count=' + s1.barCount + ' 文案=' + JSON.stringify(s1.askText)
          + '（解释按钮=' + JSON.stringify(s1.explainText) + '）'
          + ' ｜ 重拍 ' + cap1.attempts + ' 次 ｜ 证据 ' + rec.name + ' ' + rec.width + 'x' + rec.height + ' ' + rec.bytes + 'B'
      };
    }
  },

  /* ============================ ③ 取消加选 + N 立即回落 ============================ */
  {
    name: '真输入③：Ctrl 再点一次那个"只进了原始集"的子节点 ⇒ 真的取消加选（描边与像素一起消失）且 N 立即回落',
    run: async (ctx) => {
      if (!ctx.input) return noBase();
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: '铺场失败：' + pre.text };
      const pick = await chooseTriple(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const ids = [pick.P.id, pick.C.id];
      const s1 = await (async () => {
        const clicked = await ctrlClickAll(ctx, ids, null);
        if (!clicked.ok) return { ok: false, text: clicked.text };
        return snapshot(ctx, ids);
      })();
      if (!s1 || !Array.isArray(s1.raw)) { await cleanup(ctx); return { ok: false, text: '加选失败：' + JSON.stringify(s1).slice(0, 200) }; }
      const dpr = s1.dpr;
      const cap1 = await captureUntil(ctx, (img) => ({
        ok: true, rings: s1.nodes.map((n) => (n.rect ? ringScan(img, n, dpr, s1.overlays) : null))
      }), (sc) => sc.rings[1] && sc.rings[1].hits >= TH.dashStroke.minHits, 3);
      // ★ 关键一步：再 Ctrl 点一次**子节点 C**（它在裁剪集里被剔掉了，只在原始集里）
      const ptC = await pointFor(ctx, pick.C.id);
      if (!ptC.ok) { await cleanup(ctx); return { ok: false, text: '点不到子节点：' + ptC.text }; }
      await ctx.input.click(ptC.pt, ['control']);
      await WAIT.frames(ctx, { delayMs: 150 });
      await waitFor(ctx, `(function () {
        var raw = window.MM.getSelectionRaw ? window.MM.getSelectionRaw() : [];
        return JSON.stringify({ ok: raw.indexOf(${JSON.stringify(pick.C.id)}) < 0 });
      })()`, 8);
      const s2 = await snapshot(ctx, ids);
      const cap2 = await captureUntil(ctx, (img) => ({
        ok: true, rings: s2.nodes.map((n) => (n.rect ? ringScan(img, n, dpr, s2.overlays) : null))
      }), (sc) => sc.rings[1] && sc.rings[1].ok && sc.rings[1].hits <= TH.dashStroke.maxRingHits, 3);
      const rec = await ctx.input.shot('36-3-ctrl-deselect.png', cap2.img);
      const wentOut = s2.raw.indexOf(pick.C.id) < 0 && s2.painted.indexOf(pick.C.id) < 0;
      const keepT = s2.raw.indexOf(pick.P.id) >= 0 && s2.painted.indexOf(pick.P.id) >= 0;
      const beforeC = cap1.scan.rings[1] ? cap1.scan.rings[1].hits : -1;
      const afterC = cap2.scan.rings[1] ? cap2.scan.rings[1].hits : -1;
      const ringGone = beforeC >= TH.dashStroke.minHits && afterC <= TH.dashStroke.maxRingHits;
      const nFell = String(s2.barCount) === '1' && countInLabel(s2.askText) === null
        && /问问AI/.test(String(s2.askText));
      await cleanup(ctx);
      return {
        ok: wentOut && keepT && ringGone && nFell,
        text: '加选两个（父 ' + pick.P.id + ' + 子 ' + pick.C.id + '）⇒ raw=' + idLine(s1.raw)
          + ' 描边=' + idLine(s1.painted) + ' N=' + s1.barCount + ' ｜ 再 Ctrl 点一次**子节点** ⇒ raw=' + idLine(s2.raw)
          + '（期望只剩 ' + pick.P.id + '）｜ 带描边类的节点=' + idLine(s2.painted)
          + ' ｜ 子节点外圈带像素 ' + beforeC + ' → ' + afterC + '（阈值 命中≥' + TH.dashStroke.minHits
          + '、之后应 ≤' + TH.dashStroke.maxRingHits + '）'
          + ' ｜ 工具条 data-count=' + s2.barCount + ' 文案=' + JSON.stringify(s2.askText) + '（应回落「💬 问问AI」）'
          + ' ｜ 重拍 ' + cap2.attempts + ' 次 ｜ 证据 ' + rec.name + ' ' + rec.bytes + 'B'
      };
    }
  },

  /* ============================ ④ 「💬 问这 N 个」 ============================ */
  {
    name: '真输入④：「💬 问这 N 个」的 N = 真的带描边的节点数 = 点击后真正送出去的节点数（桩回显）',
    run: async (ctx) => {
      if (!ctx.input) return noBase();
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: '铺场失败：' + pre.text };
      const pick = await chooseTriple(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      // ⚠️ 这里**故意**用"父 + 子 + 第三个"这条会踩到"剔父冗余"的路径（真机上的 Ctrl 加选），
      //    这样 N 才真的会与"用户实际点选的 3 个"不一致（修复前实测 N=2 ✗）—— 修复后应为 3 ✓。
      const ids = [pick.P.id, pick.C.id, pick.X.id];
      const clicked = await ctrlClickAll(ctx, ids, null);
      if (!clicked.ok) { await cleanup(ctx); return { ok: false, text: clicked.text }; }
      await waitFor(ctx, `(function () { var b = document.getElementById('mm-node-toolbar');
        return JSON.stringify({ ok: !!b && b.style.display !== 'none' && b.getAttribute('data-count') === '${ids.length}' }); })()`, 8);
      let s = await snapshot(ctx, ids);
      // 判别力证明：ask-count ⇒ 把工具条上的数量文案改成错的
      if (INJECT === 'ask-count') {
        await ctx.exec("(function () { var b = document.getElementById('mm-node-toolbar');"
          + " if (b) b.querySelector('.mm-tb-ask').textContent = '💬 问这 9 个'; return 1; })()");
        await WAIT.frames(ctx, { delayMs: 120 });
        s = await snapshot(ctx, ids);
      }
      const labelN = countInLabel(s.askText);
      const dashed = s.painted.length;
      // 真点「💬 问这 N 个」（浮层按钮：命中测试必须真的落在按钮上 —— 合成事件在这里是"作弊" ✗）
      const btn = await execJson(ctx, `(function () {
        var b = document.querySelector('#mm-node-toolbar .mm-tb-ask');
        if (!b) return JSON.stringify({ ok: false, text: '找不到「💬 问这 N 个」按钮' });
        var r = b.getBoundingClientRect();
        var pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        var at = document.elementFromPoint(pt.x, pt.y);
        var hitOk = !!at && (at === b || b.contains(at));
        return JSON.stringify({ ok: hitOk, pt: pt,
          text: '按钮中心命中=' + (at ? (at.className || at.tagName) : 'null') });
      })()`);
      if (!btn.ok) { await cleanup(ctx); return { ok: false, text: '按钮不可点：' + btn.text }; }
      await ctx.input.click(btn.pt, []);
      await WAIT.frames(ctx);
      const box = JSON.parse(await waitFor(ctx, `(function () {
        var bs = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        if (!bs.length) return JSON.stringify({ ok: false, text: '点了没有出问答浮窗' });
        var b = bs[bs.length - 1];
        var inp = b.querySelector('.ask-input');
        if (!inp) return JSON.stringify({ ok: false, text: '浮窗里没有输入框' });
        var focused = document.activeElement === inp;
        return JSON.stringify({ ok: focused, title: (b.querySelector('.fd-title') || {}).textContent, focused: focused });
      })()`, 12));
      // 真键盘：ASCII 逐字输入 + Enter（`type:'char'` 才会进输入框；Enter 走 input 的 keydown 处理器）
      await ctx.input.typeText('what do these two nodes say?');
      await ctx.input.pressKey('Enter');
      const echo = JSON.parse(await waitFor(ctx, `(function () {
        var bs = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        if (!bs.length) return JSON.stringify({ ok: false, text: '浮窗没了' });
        var b = bs[bs.length - 1];
        var t = b.textContent || '';
        var m = /收到节点数：(\\d+)/.exec(t);
        return JSON.stringify({ ok: !!m, echo: m ? Number(m[1]) : null, asked: /你问：/.test(t),
          title: (b.querySelector('.fd-title') || {}).textContent });
      })()`, 16));
      // 浮窗 ROI（L2：非空、非纯色）+ 同源截图
      const boxRect = await execJson(ctx, `(function () {
        var bs = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        if (!bs.length) return JSON.stringify({ ok: false, text: '浮窗没了' });
        var r = bs[bs.length - 1].getBoundingClientRect();
        return JSON.stringify({ ok: r.width > 0 && r.height > 0,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
      })()`);
      let roiTxt = '（没有浮窗矩形 ⇒ 未做 ROI 判据）', roiOk = true, shotName = '（无）';
      if (boxRect.ok) {
        const cap = await captureUntil(ctx, (img) => {
          const st = frameStats.analyzeRegion(img, toDev(boxRect.rect, s.dpr));
          const v = frameStats.passRegion(st, TH.roi);
          return { ok: v.ok, text: v.text };
        }, (sc) => sc.ok, 2);
        roiOk = !!cap.scan.ok;
        roiTxt = (cap.scan.text || '—') + '（重拍 ' + cap.attempts + ' 次）';
        const rec = await ctx.input.shot('36-4-ask-multi.png', cap.img);
        shotName = rec.name + ' ' + rec.width + 'x' + rec.height + ' ' + rec.bytes + 'B';
      }
      const echoN = echo.echo;
      const ok = s.barVisible && String(s.barCount) === String(dashed) && labelN === dashed
        && dashed === ids.length && echoN === dashed
        && /AI 问答：\d+ 个节点/.test(String(echo.title || '')) && roiOk;
      await cleanup(ctx);
      return {
        ok: ok,
        text: '选中 ' + idLine(s.raw) + ' ｜ 带描边的节点=' + dashed + ' ｜ 工具条 data-count=' + s.barCount
          + ' 文案=' + JSON.stringify(s.askText) + '（文案里的数=' + labelN + '）｜ data-node=' + JSON.stringify(s.barNodes)
          + ' ｜ 真点按钮（' + btn.text + '，点在 (' + btn.pt.x + ',' + btn.pt.y + ')）⇒ 浮窗标题=' + JSON.stringify(echo.title)
          + ' ｜ 桩回显「收到节点数」=' + echoN + '（应 ' + dashed + '）｜ 问题真的发出去了=' + echo.asked
          + ' ｜ 输入框自动获得焦点=' + box.focused
          + ' ｜ 浮窗 ROI ' + roiTxt + ' ｜ 证据 ' + shotName
      };
    }
  },

  /* ============================ ⑤ 清选区不留残影 ============================ */
  {
    name: '真输入⑤：点空白处清选区 ⇒ 虚线描边真的消失（不留残影）+ 没有大虚线框',
    run: async (ctx) => {
      if (!ctx.input) return noBase();
      const pre = await prep(ctx);
      if (!pre.ok) return { ok: false, text: '铺场失败：' + pre.text };
      const pick = await chooseTriple(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const ids = [pick.P.id, pick.C.id];
      const clicked = await ctrlClickAll(ctx, ids, null);
      if (!clicked.ok) { await cleanup(ctx); return { ok: false, text: clicked.text }; }
      const s1 = await snapshot(ctx, ids);
      const dpr = s1.dpr;
      const cap1 = await captureUntil(ctx, (img) => ({
        ok: true, rings: s1.nodes.map((n) => (n.rect ? ringScan(img, n, dpr, s1.overlays) : null))
      }), (sc) => sc.rings.every((r) => r && r.ok && r.hits >= TH.dashStroke.minHits), 3);
      const oldRaw = s1.raw.slice();
      // ★ 真点一下空白画布（既有行为：清选区）
      const blank = await pickBlankPoint(ctx, s1.nodes.filter((n) => n.rect).map((n) => n.rect));
      if (!blank.ok) { await cleanup(ctx); return { ok: false, text: blank.text }; }
      await ctx.input.click(blank.pt, []);
      await WAIT.frames(ctx, { delayMs: 150 });
      // 判别力证明：stale-raw ⇒ 造出旧缺陷态（原始集还留着、描边还画着，而裁剪集已空）
      if (INJECT === 'stale-raw') {
        await ctx.exec('(function () { var r = ' + JSON.stringify(oldRaw)
          + '; window.MM.applySelection([], r, { hideBox: true }); return 1; })()');
        await WAIT.frames(ctx, { delayMs: 150 });
      }
      const s2 = await snapshot(ctx, ids);
      // ⚠️ 这一档只判"**描边**有没有消失" ⇒ 判据必须是**差分**（`after ≤ before − minHits`）：
      //   `ringScan` 数的是"节点外圈带里的强调蓝"，而那条带里**必然**有地图自己的东西（连线边/
      //   expander）。R2 期 3 的"端点按子序分散"就改到了这层几何 —— 某条连线落在子边框更靠边的 y，
      //   该读数从 0 升到 100 上下（实测 wlan-01: 0 → 118）⇒ 拿**绝对**阈值（≤24）判就成了假红：
      //   判的是"带里有多少蓝"，而这一档要问的是"**描边画的那些蓝**掉了没有"。
      //   差分口径与 ② 的 `ringOk` 是同一条（那里判"描边出现了"= after ≥ before + minHits ✓）。
      const cap2 = await captureUntil(ctx, (img) => ({
        ok: true,
        rings: s2.nodes.map((n) => (n.rect ? ringScan(img, n, dpr, s2.overlays) : null))
      }), (sc) => sc.rings.every((r, i) => r && r.ok
        && r.hits <= (cap1.scan.rings[i] ? cap1.scan.rings[i].hits : 0) - TH.dashStroke.minHits), 3);
      const rec = await ctx.input.shot('36-5-after-clear.png', cap2.img);
      const rawCleared = s2.raw.length === 0 && s2.painted.length === 0;
      const pixelsGone = cap2.scan.rings.every((r, i) => r && r.ok
          && r.hits <= (cap1.scan.rings[i] ? cap1.scan.rings[i].hits : 0) - TH.dashStroke.minHits)
        && cap1.scan.rings.every((r) => r && r.hits >= TH.dashStroke.minHits);
      // 大框：同一条判据（见 `boxPixelDiff`）。⚠️ 这一档**当前状态是空选区** ⇒ 对照档得用
      //   **点空白之前**那批 id 来造（`oldRaw`）—— 空选区画不出框，拿它当对照等于"没有可判对象"。
      const boxDiff = await boxPixelDiff(ctx, dpr, s2.overlays, oldRaw, '36-5b-box-control-on.png');
      const boxOk = !s2.boxVisible && boxDiff.ok === true;
      await cleanup(ctx);
      return {
        ok: rawCleared && pixelsGone && boxOk,
        text: '真点空白=(' + blank.pt.x + ',' + blank.pt.y + ') ｜ 点前 raw=' + idLine(oldRaw) + ' 描边='
          + idLine(s1.painted) + ' ｜ 点后 raw=' + idLine(s2.raw) + ' 带描边类的节点=' + idLine(s2.painted)
          + '（两者都应空）｜ 像素 外圈带 ' + hitsLine(cap1.scan.rings) + ' → ' + hitsLine(cap2.scan.rings)
          + '（**差分**判据：每一条都要至少掉 ' + TH.dashStroke.minHits + ' —— 绝对阈值判不了这一档，'
          + '见该断言里的注释）｜ 大虚线框 DOM可见=' + s2.boxVisible + ' ｜ ' + boxDiff.text
          + ' ｜ 重拍 ' + cap2.attempts + ' 次 ｜ 证据 ' + rec.name + ' ' + rec.bytes + 'B'
      };
    }
  }
];
