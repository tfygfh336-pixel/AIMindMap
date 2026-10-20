/* ============================================================
 * renderer/draft-map.js — 草稿图窗口的页面脚本 · 功能代号 `DM` · 台账 `W11`
 * ------------------------------------------------------------
 * 职责只有四件（本批**刻意不做**编辑 —— 理由见 `draft-map.html` 顶部与定题 §7 偏差 1）：
 *   ① 把主进程给的草稿树画出来（`MMDraft.toJsMind` → `MM.adapter.loadTree`）
 *   ② 量出内容的真实 bbox 报给主进程（a–e 的 `a`：**按内容决定显示范围与窗口大小**）
 *   ③ 「并入主导图」两步：先要落点候选、再带着落点提交（落点由**人**选，不由 AI 猜）
 *   ④ 「导出 md / json」「丢弃」两个按钮转发给主进程
 *
 * 三条纪律（都是本工程踩过的坑，不是新发明）：
 *   · 渲染库调用**只经** `MM.adapter.*`（`renderer/mindmap-adapter.js` 是唯一出口；
 *     本文件里不出现 jsMind 的公共方法名）—— 换库时只改那个文件的口径继续成立。
 *   · **页面不持有数据的唯一副本**：树的权威副本在主进程内存里（关窗即弃的语义在那边），
 *     页面只拿到一份用于显示的副本 ⇒ "界面偷偷改一下草稿"这条路结构上不存在。
 *   · **失败必须说话**：拿不到草稿 / 合并被拒 / 导出失败都写进 `#status`（带原因），
 *     绝不出现"点了没反应"。本工程最重的损害类别是静默。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});
  const D = window.MMDraft;          // src/draft-map.js（纯函数：形状 / 渲染数据 / 导出）

  /** 内容四周留白（px）：让最外圈的节点不贴着窗口边 */
  const PAD = 28;
  /** 内容尺寸上报的收敛阈值（px）：小于它就当"没变"，免得 setContentSize 与 resize 事件互相追 */
  const EPS = 4;

  let state = null;      // 主进程给的草稿 {id, source, tree, stats, fp}
  let jm = null;         // 本次的 jsMind 实例
  let lastSent = null;   // 上一次报给主进程的 {w,h}
  let fitTries = 0;      // 上报次数上限（防振荡；正常 1 次就收敛）

  function $(id) { return document.getElementById(id); }

  function setStatus(text, isErr) {
    const el = $('status');
    if (!el) return;
    el.textContent = String(text === undefined || text === null ? '' : text);
    el.className = isErr ? 'err' : '';
  }

  function api() {
    const d = window.desktop && window.desktop.draft;
    return d || null;
  }

  /* ---------------- ② 内容 bbox → 主进程 ---------------- */

  /** 内容在视觉上的真实外接框（用 `getBoundingClientRect` 逐节点取并集）。
   *  为什么不用 jsMind 内部的 `view.size`：那是**库的内部字段**（本工程对内部符号的态度是
   *  "主动接管、列进 JSMIND-INTERNALS.md"，能不用就不用）⇒ 从 DOM 量，换库也不用改这一处。 */
  function contentBox() {
    const cont = $('jsmind_container');
    const els = cont ? Array.prototype.slice.call(cont.querySelectorAll('jmnode[nodeid]')) : [];
    if (!els.length) return { w: 480, h: 320, nodes: 0 };
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;         // 收起的节点：没有几何，不参与
      L = Math.min(L, r.left); T = Math.min(T, r.top);
      R = Math.max(R, r.right); B = Math.max(B, r.bottom);
    }
    if (!isFinite(L)) return { w: 480, h: 320, nodes: els.length };
    return { w: Math.ceil(R - L) + PAD * 2, h: Math.ceil(B - T) + PAD * 2, nodes: els.length };
  }

  /** 把"按内容算出来的窗口内容尺寸"报给主进程（由它钳制到屏幕工作区后 `setContentSize`）。
   *  换算：`innerWidth - 画布可视宽` = 页面自身的横向装潢（本页是 0，因为画布是 inset:0）；
   *  同理纵向装潢 = 顶栏 + 状态栏。这样主进程拿到的是**窗口内容区**的尺寸，可直接用。
   *
   *  ⚠️ **改完尺寸必须重排一次**（`MM.adapter.resize`）：本库的布局坐标是跟着**容器尺寸**走的
   *  （`view.expand_size()` 把内容尺寸取成 `max(容器, 内容最小尺寸)`）。不重排的话，窗口改小之后
   *  节点还停在**旧尺寸**下算出的坐标上 —— 实测一张 360×240 的小窗里根节点落在 (372,267)，
   *  **在视口外**（"按内容定大小"反而把内容弄丢了）。重排之后坐标回到新容器中心。
   *  代价是可能要多报一轮（重排后内容 bbox 会变一点点）⇒ 由 `fitTries` 与 EPS 两道闸收敛。 */
  function reportFit(force) {
    const d = api();
    const cont = $('jsmind_container');
    if (!d || !d.fit || !cont) return;
    const box = contentBox();
    const chromeW = Math.max(0, window.innerWidth - cont.clientWidth);
    const chromeH = Math.max(0, window.innerHeight - cont.clientHeight);
    const want = { w: Math.round(box.w + chromeW), h: Math.round(box.h + chromeH) };
    if (lastSent && Math.abs(lastSent.w - want.w) <= EPS && Math.abs(lastSent.h - want.h) <= EPS) return;
    if (!force && fitTries >= 3) return;          // 收敛保护：绝不出现"窗口自己抖个不停"
    fitTries += 1;
    lastSent = want;
    Promise.resolve(d.fit(want)).then((r) => {
      if (r && r.ok === false) { setStatus('窗口尺寸没调成：' + (r.reason || '未知原因'), true); return; }
      /* 主进程**夹住了**（内容比屏幕工作区还大）⇒ 如实说出来，并告诉人怎么办。
       * 这一档对应 `W9` 的 `clamped:true` 口径：做不到就明说，不硬撑一个假的"刚好"。 */
      if (r && r.clamped) {
        setStatus('内容比屏幕可用区还大（' + want.w + '×' + want.h + ' → ' + r.w + '×' + r.h
          + '）：请拖动/缩放查看；「并入」不受影响');
      }
      // 尺寸变了 ⇒ 按新容器重排（理由见本函数头），然后**再量一次**（重排会改变内容 bbox）
      if (jm && MM.adapter && MM.adapter.resize) {
        MM.adapter.resize(jm);
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(() => { if (fitTries < 3) reportFit(false); }));
        }
      }
    }, (e) => setStatus('窗口尺寸没调成：' + ((e && e.message) || e), true));
  }

  /* ---------------- ① 画出来 ---------------- */

  function render(payload) {
    if (!payload || !payload.ok) {
      setStatus('拿不到草稿：' + ((payload && payload.reason) || '未知原因'), true);
      return;
    }
    state = payload;
    const t = payload.tree;
    const st = payload.stats || {};
    $('title').textContent = '草稿图：' + ((t && t.topic) || '(无标题)');
    $('src').textContent = payload.source ? '（来自 ' + payload.source + '）' : '';
    $('stat').textContent = (st.nodes || 0) + ' 个节点 · 深度 ' + (st.depth || 0)
      + (payload.dropped && payload.dropped.length ? ' · 已丢弃字段 ' + payload.dropped.join('/') : '');
    document.title = '草稿图 · ' + ((t && t.topic) || 'AI MindMap');

    const view = D.toJsMind(t, (t && t.topic) || '草稿图');
    if (jm) {
      // 同一张窗被"更新到"（a–e 的 d）：**换内容不换窗** ⇒ 直接重载这棵树
      MM.adapter.loadTree(jm, view);
    } else {
      jm = new window.jsMind({
        container: 'jsmind_container',
        editable: false,          // ★ 只读（本批不做编辑，见文件头）
        theme: null,
        mode: 'full',
        support_html: false,      // 草稿正文不进节点（topic 是纯文本）⇒ 关掉 HTML，少一个注入面
        view: { engine: 'canvas', hmargin: 40, vmargin: 30, line_width: 2, draggable: true },
        layout: { hspace: 40, vspace: 16, pspace: 10 },
        shortcut: { enable: false }
      });
      MM.adapter.loadTree(jm, view);
    }
    MM.adapter.expandAll(jm);
    // 布局是异步落 DOM 的（jsMind 的 show_nodes 之后元素才带几何）⇒ 等两帧再量
    const after = () => { reportFit(false); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(after));
    else setTimeout(after, 60);
    setStatus('这是**临时**的：不落 projects/、不参与检索/校验/统计；关掉窗口就没了。');
  }

  /* ---------------- ③ 并入（两步：问落点 → 提交） ---------------- */

  function openPick() {
    const d = api();
    if (!d || !d.candidates) { setStatus('并入不可用：桌面接口没接上', true); return; }
    setStatus('正在取落点候选…');
    Promise.resolve(d.candidates()).then((r) => {
      if (!r || r.ok === false) {
        setStatus('取不到落点候选：' + ((r && r.reason) || '未知原因'), true);
        return;
      }
      const sel = $('pick-parent');
      sel.innerHTML = '';
      const add = (val, text) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = text; sel.appendChild(o);
        return o;
      };
      add('root', '作为新顶层主题（挂在项目根下）');
      (r.items || []).forEach((it) => {
        add(String(it.id), (it.depth === 1 ? '' : new Array(Math.min(it.depth, 6)).join('　'))
          + (it.topic || it.id) + (it.depth === 1 ? '（顶层主题）' : ''));
      });
      if (r.current && r.current.id) {
        // 默认落在"当前选中的那个节点"下 —— 这是人此刻正在看的位置，最省一次点击
        sel.value = String(r.current.id);
        if (sel.value !== String(r.current.id)) sel.value = 'root';
      }
      $('pick').classList.add('on');
      setStatus('选一个落点：并入会在主图里**新建**一棵子树（一次原子写），不会改动已有的节点。');
    }, (e) => setStatus('取不到落点候选：' + ((e && e.message) || e), true));
  }

  function doMerge() {
    const d = api();
    const sel = $('pick-parent');
    const parent = sel && sel.value ? sel.value : 'root';
    const okBtn = $('pick-ok');
    if (okBtn) okBtn.disabled = true;
    setStatus('正在并入（一次原子写 + 回读）…');
    Promise.resolve(d.merge({ parent: parent })).then((r) => {
      if (okBtn) okBtn.disabled = false;
      if (!r || r.ok === false) {
        /* 幂等拒绝也走这条路：报文由主进程给（它必须**指名**"已经并入过哪一份"），
         * 本页只如实转述 —— 不吞成"失败"、也不改写成成功。 */
        setStatus('没有并入：' + ((r && r.reason) || '未知原因'), true);
        return;
      }
      $('pick').classList.remove('on');
      setStatus('已并入「' + (r.project || '?') + '」：新增 ' + r.added + ' 个节点（落点 ' + parent
        + '，回读 ' + (r.readback === true ? '通过' : '未做') + '）。再点「并入」会被幂等挡下。');
    }, (e) => {
      if (okBtn) okBtn.disabled = false;
      setStatus('并入出错：' + ((e && e.message) || e), true);
    });
  }

  /* ---------------- ④ 导出 / 丢弃 ---------------- */

  function doExport(kind) {
    const d = api();
    if (!d || !d.exportAs) return;
    setStatus('正在导出 ' + kind + '…');
    Promise.resolve(d.exportAs(kind)).then((r) => {
      if (!r || r.ok === false) { setStatus('没有导出：' + ((r && r.reason) || '未知原因'), true); return; }
      setStatus('已导出：' + r.path + '（' + r.bytes + ' 字节）');
    }, (e) => setStatus('导出出错：' + ((e && e.message) || e), true));
  }

  function doDiscard() {
    const d = api();
    setStatus('已丢弃这份草稿（一个字节都没写进任何项目）');
    if (d && d.close) setTimeout(() => { Promise.resolve(d.close()); }, 120);
    else window.close();
  }

  /* ---------------- 接线 ---------------- */

  function bind() {
    $('btn-merge').addEventListener('click', openPick);
    $('pick-ok').addEventListener('click', doMerge);
    $('pick-cancel').addEventListener('click', () => {
      $('pick').classList.remove('on');
      setStatus('已取消并入（草稿还在）');
    });
    $('btn-md').addEventListener('click', () => doExport('md'));
    $('btn-json').addEventListener('click', () => doExport('json'));
    $('btn-discard').addEventListener('click', doDiscard);
    // 同一张窗被更新内容时（a–e 的 d：同一份内容更新到原来那张）主进程会推一次
    const d = api();
    if (d && d.onUpdate) d.onUpdate((p) => { lastSent = null; fitTries = 0; render(p); });
    if (typeof window !== 'undefined') window.addEventListener('resize', () => reportFit(false));
  }

  function boot() {
    bind();
    const d = api();
    if (!d || !d.get) {
      setStatus('桌面接口没接上（window.desktop.draft 缺失）：本页只能由应用打开', true);
      return;
    }
    Promise.resolve(d.get()).then(render, (e) => setStatus('拿不到草稿：' + ((e && e.message) || e), true));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给断言用的**只读**读数出口（不含任何写操作；冒烟域 55 用它在草稿页里做真判据） */
  MM.draftPageState = function draftPageState() {
    const cont = $('jsmind_container');
    const els = cont ? Array.prototype.slice.call(cont.querySelectorAll('jmnode[nodeid]')) : [];
    return {
      id: state ? state.id : null,
      fp: state ? state.fp : null,
      source: state ? state.source : null,
      rootTopic: state && state.tree ? state.tree.topic : null,
      nodes: state && state.stats ? state.stats.nodes : 0,
      rendered: els.length,
      jm: !!jm,
      pickOpen: !!($('pick') && $('pick').classList.contains('on')),
      want: lastSent ? { w: lastSent.w, h: lastSent.h } : null,
      status: ($('status') || {}).textContent || ''
    };
  };
})();
