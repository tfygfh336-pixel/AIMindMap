/* ============================================================
 * AI MindMap — 标签视图（app-tag-view.js）· 功能代号 `TV` · 台账 `W9`
 * ------------------------------------------------------------
 * 用户 2026-10-10 的设计（`.review/20261010-卖点与功能-常驻讨论/待做清单.md:133`）原话：
 *   「**标签不进关联视图** —— 另做一个**平行视图**（独立按钮、形态仿关联视图：
 *     高亮带该标签的节点 / 虚化其它 / 画连线）」
 * 本文件的定题（`.review/20261020-W9-tag-view/00-定题.md`）对它做了两处**收窄**，都有实测读数：
 *   · **不画成员之间的连线**：那等于两两连线 C(n,2) —— 7 本书里最大的标签 21 个成员 ⇒ 210 条，
 *     `comnet` 的 `协议` 177 个成员 ⇒ 15,576 条；而"同标签"只说明同一件事，连线会宣称
 *     **不存在的两两关系**（高亮已经把"它们都带这个标签"说完了）。
 *   · **不做手写的「标签笔记」**：含义那一半已在 `docs/TAGS.md` §4（39/39 行都有「一句话定义」），
 *     注解那一半 85.0% 能从命中词派生，且输入面为 0（全库 10 篇 assoc 里标签锚点 0 篇）。
 *
 * 三条实现纪律（都抄自关联视图踩过的坑，不是新发明）：
 *   ① **成员是派生的，不存**：每次渲染都从 `MM.serializeTree()` + `MMTree.nodesByTag` 现算
 *      ⇒ 新加一个带该标签的节点**自动**出现在视图里（台账点名的核心难点，靠机制不靠记忆）。
 *      判断"派生"真的被守住的那条断言在 `scripts/smoke/54-标签视图.js`：**页面里独立算一遍**再逐 id 比。
 *   ② **高亮只写类、不写内联样式**：jsMind 每次 `show_nodes` 都会重写内联 background/color
 *      （`renderer/app-related.js` 文件头第 ② 条同一个坑）⇒ 类名 + CSS 才是稳的。
 *      类名与关联视图**分开**（`mm-tag-hit`/`mm-tag-dim` vs `mm-rel-hit`/`mm-rel-dim`）：两个视图
 *      可以同时开着，互不误清。
 *   ③ **几何只认一个真源**：缩放用 `MM.fitToNodes`（`renderer/app-related.js` 那一份），
 *      本文件**不自己算第二套坐标**；顶部让位用面板自己的 offset 高度。
 *
 * 边界（本文件不负责）：
 *   · 树遍历/成员判定 → `src/tree-utils.js` 的 `nodesByTag`（纯函数，有单测 `tests/tag-view.test.js`）
 *   · 视图变换（translate+scale）→ `renderer/app-view.js`；跳转 → `MM.jumpToNode`（既有唯一实现）
 *   · 搜索 → `MM.runSearch`（面板里的「用搜索看」只是把旧入口指回去，不复制检索逻辑）
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const PANEL_ID = 'tag-view-panel';
  const CLS_HIT = 'mm-tag-hit';     // 带该标签的节点
  const CLS_DIM = 'mm-tag-dim';     // 其余（轻微虚化）

  /** 当前视图状态；`null` = 没开。**只存 tag 与派生出的 id 集**（不存成员清单的副本）。 */
  let active = null;
  let bound = false;

  function panel() { return document.getElementById(PANEL_ID); }
  function jm() { const st = MM.getState && MM.getState(); return st ? st.jm : null; }
  function stateOf() { return MM.getState ? MM.getState() : null; }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 导图面板里所有节点元素（与 `app-related.js` 同一个选择器口径） */
  function allNodeEls() {
    const p = MM.fdPanel ? MM.fdPanel() : null;
    return p ? Array.prototype.slice.call(p.querySelectorAll('jmnode[nodeid]')) : [];
  }

  /** 高亮/虚化：**只写类**（纪律 ②）。返回本次标成 hit 的元素数（供断言取读数）。 */
  function paint() {
    const ids = active ? active.ids : null;
    const set = new Set(ids || []);
    let hit = 0;
    for (const el of allNodeEls()) {
      const id = el.getAttribute('nodeid');
      const on = !!set.has(id);
      el.classList.toggle(CLS_HIT, on);
      el.classList.toggle(CLS_DIM, !!(active && !on));
      if (on) hit += 1;
    }
    return hit;
  }

  function clearPaint() {
    for (const el of allNodeEls()) el.classList.remove(CLS_HIT, CLS_DIM);
  }

  /** 面板占掉的顶部高度（让位给清单，别把最上面那排节点压在条底下 —— 与关联视图 `barInsetTop` 同一条纪律） */
  function panelInsetTop() {
    const el = panel();
    if (!el) return 0;
    return (el.offsetTop || 0) + (el.offsetHeight || 0) + 8;
  }

  /** 渲染清单（成员按**树序**，与导图上的位置一一对应） */
  function renderPanel(tag, members) {
    const el = panel();
    if (!el) return;
    const title = el.querySelector('#tag-view-title');
    const count = el.querySelector('#tag-view-count');
    const body = el.querySelector('#tag-view-body');
    if (title) title.textContent = '#' + tag;
    if (count) count.textContent = members.length + ' 个节点';
    if (!body) return;
    el.setAttribute('data-tag', tag);
    el.setAttribute('data-count', String(members.length));
    if (!members.length) {
      body.innerHTML = '<div class="tv-empty">没有节点带这个标签（标签只来自节点的 <code>tags</code> 字段 —— '
        + '视图不自己造标签，也不从正文里猜）</div>';
      return;
    }
    body.innerHTML = members.map((m) =>
      '<span class="tv-item" data-node="' + esc(m.id) + '" title="' + esc(m.id) + ' · 点它跳到该节点">'
      + esc(m.topic || m.id) + '</span>').join('');
  }

  /** 打开/刷新标签视图。
   *  @param {string} tag 标签名（**逐字相等**匹配，与 CLI `search --tag` 同一口径）
   *  @returns {{tag:string, count:number, ids:string[]}|null} `null` = 前置不满足（状态栏已说明理由） */
  function showTagView(tag) {
    const st = stateOf();
    const j = jm();
    const t = String(tag === undefined || tag === null ? '' : tag).trim();
    if (!st || !st.project || !j) { MM.setStatus('请先打开一个项目', true); return null; }
    if (!t) { MM.setStatus('标签名是空的', true); return null; }
    if (!window.MMTree || typeof window.MMTree.nodesByTag !== 'function') {
      // 响亮：缺了它就等于"成员从哪来"说不清（不静默退化成空视图）
      MM.setStatus('src/tree-utils.js 没加载：检查 index.html 的 script 标签', true);
      return null;
    }
    // ⚠️ `MM.serializeTree()` 返回的是**整份工程对象**（`{meta, format, data}`），
    //    不是一棵节点树 —— 成员遍历必须落在 `.data` 上（写错过一次：拿整份对象去 walk，
    //    一个成员都找不到，视图静默变成"0 个节点"，而它看起来完全正常）。
    const proj = MM.serializeTree ? MM.serializeTree() : null;
    const root = proj && proj.data ? proj.data : null;
    if (!root) { MM.setStatus('拿不到当前树（还没渲染）', true); return null; }

    // ★ 成员**现场派生**（纪律 ①）：这里没有任何"读清单"的分支
    const members = window.MMTree.nodesByTag(root, t);
    active = { tag: t, ids: members.map((m) => m.id) };

    // 成员常在被收起的子树里 —— 收起的节点没有几何，"缩放到刚好框住"就无从谈起。
    // ⚠️ 展开必须**按需且去重**：`MM.expandAncestors` 每次都会把整条祖先链展开一遍，而
    //    jsMind 的 `expand_node` 每次都会**重排整棵树**（"幂等"不等于"免费"）。实测：
    //    `comnet` 成员最多的标签有 177 个成员，逐个展开 ⇒ 177 次全树布局，软件渲染下
    //    一次"点标签"能拖成分钟级（本批冒烟跑到这里卡住就是这么发现的 ✗）。
    //    ⇒ 先看这条链**是不是已经全展开**，是就一次都不调用；只对真的收着的链展开
    //    （同一条链只排一次 ⇒ 代价从"成员数"降到"未展开的祖先数"）。
    const expandAncestors = MM.expandAncestors;
    const getNode = MM.adapter && MM.adapter.getNode;
    const chainExpanded = (id) => {
      if (!getNode) return true;
      let n = null;
      try { n = getNode(j, id); } catch (e) { return true; }
      for (let p = n && n.parent; p; p = p.parent) {
        if (p.expanded === false) return false;
      }
      return true;
    };
    if (typeof expandAncestors === 'function') {
      for (const id of active.ids) {
        if (chainExpanded(id)) continue;                 // 已经看得见 ⇒ 一次布局都不付
        try { expandAncestors(j, id); } catch (e) { /* 单个失败不影响其余 */ }
      }
    }

    renderPanel(t, members);
    bindOnce();
    const el = panel();
    if (el) el.style.display = 'flex';
    // 展开会重建节点元素 ⇒ 先刷一次类，再框一次
    paint();
    const fit = MM.fitToNodes ? MM.fitToNodes(active.ids, panelInsetTop()) : null;
    /* `fitToNodes` 的缩放下界是 **0.15**（与全图缩放同一个下界）。若成员散得比它还开，
     * "刚好框住"就**做不到** —— 这时**必须说出来**（不静默地假装框住了）：
     * 实测 `comnet` 的 `补充`（4 个成员分在整张 889 个节点的图两端）需要 s≈0.05，
     * 被夹到 0.15 ⇒ 并集是面板的 3.6 倍，四个成员全在视野外。
     * 语义只有一条：**能框住就框住，框不住就明确告知，高亮照旧**。 */
    const clamped = !!(fit && fit.s <= 0.1501);
    // 展开/重排是异步落 DOM 的（jsMind 的 show_nodes 之后元素才带几何）⇒ 下一帧再刷一次，
    // 否则"展开了但没上色"的节点会一直是灰的（关联视图同一处理：scheduleRedraw）
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (active && active.tag === t) { paint(); } });
    }

    MM.setStatus('标签视图：#' + t + ' · ' + members.length + ' 个节点'
      + (members.length ? '' : '（这个标签还没有任何节点）')
      + (clamped ? '（这些节点散得比最小缩放还开，已按最小缩放显示 —— 有一部分会落在视野外；'
        + '用下面的清单逐条点过去）' : ''));
    return { tag: t, count: members.length, ids: active.ids.slice(), fitted: !!fit, clamped: clamped };
  }

  /** 关掉视图：清类 + 藏面板 + 清状态（**不留残影**） */
  function closeTagView() {
    clearPaint();
    active = null;
    const el = panel();
    if (el) { el.style.display = 'none'; el.removeAttribute('data-tag'); el.setAttribute('data-count', '0'); }
  }

  function isTagViewActive() { return !!active; }
  function tagViewState() {
    return active ? { tag: active.tag, ids: active.ids.slice(), count: active.ids.length } : null;
  }
  /** 树变了（展开/收起/编辑后）重新上色 —— 幂等；视图没开时什么都不做 */
  function repaintTagView() { return active ? paint() : 0; }

  /** 面板内交互（只绑一次；内容会重渲染 ⇒ 用事件委托） */
  function bindOnce() {
    if (bound) return;
    const el = panel();
    if (!el) return;
    bound = true;
    const body = el.querySelector('#tag-view-body');
    if (body) {
      body.addEventListener('click', (e) => {
        const it = e.target && e.target.closest ? e.target.closest('.tv-item[data-node]') : null;
        if (!it) return;
        const id = it.getAttribute('data-node');
        if (id && MM.jumpToNode) MM.jumpToNode(id);   // 跳转的唯一实现（选中 + 展开祖先 + 详情）
        /* 跳转会展开祖先链 ⇒ jsMind 重建那些节点元素（新元素不带我们的类）。
         * 下一帧补一次上色，否则"点了一条成员之后，视图里少了一块绿色"这种半掉色会留下
         * （与 app-related.js 的 scheduleRelatedRedraw 同一个理由）。 */
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => { if (active) paint(); });
        }
      });
    }
    const close = el.querySelector('#tag-view-close');
    if (close) close.addEventListener('click', closeTagView);
    // 旧入口保留：点「用搜索看」= 回到改造前那条路（关键词检索），能力不删
    const sbtn = el.querySelector('#tag-view-search');
    if (sbtn) {
      sbtn.addEventListener('click', () => {
        const t = active ? active.tag : el.getAttribute('data-tag');
        if (!t || !MM.runSearch) return;
        closeTagView();
        const box = document.getElementById('search-box');
        if (box) box.value = '#' + t;
        MM.runSearch(t);
      });
    }
    // Esc 退出（与关联视图同一个键；只关视图，不动数据）
    document.addEventListener('keydown', (e) => {
      if (!active) return;
      if (e.key === 'Escape' || e.key === 'Esc') { closeTagView(); }
    });
  }

  MM.showTagView = showTagView;
  MM.closeTagView = closeTagView;
  MM.isTagViewActive = isTagViewActive;
  MM.tagViewState = tagViewState;
  MM.repaintTagView = repaintTagView;
  MM.TAG_VIEW_CLASSES = { HIT: CLS_HIT, DIM: CLS_DIM, PANEL_ID: PANEL_ID };
})();
