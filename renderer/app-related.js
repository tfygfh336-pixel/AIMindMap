/* ============================================================
 * AI MindMap — 关联节点可视化（app-related.js）
 * ------------------------------------------------------------
 * 需求（用户原话）：「节点详情的「关联笔记」栏目增加按钮『展示关联节点』；点击后
 *   ① 缩放导图至**刚好展示所有关联节点**的范围；② 高亮关联节点并**轻微虚化**其他节点；
 *   ③ 关联节点之间出现**虚线连接线**；④ 点击连接线也能弹出现有的关联笔记，
 *      且**显示位置取决于鼠标点击位置**（区别于原位打开）。」
 *
 * 口径（本工程已定，见 .review/20261008-DSH深度集成调研/03-功能2-关联节点可视化.md）：
 *   · **关联节点 = 并集**：某节点参与的「关联笔记」成员 ∪ 「相关知识点」（链接）两端；
 *   · **跨项目只标不画**：别的项目里的节点不在当前图上，画不出线 —— 只计数并如实告知；
 *   · 线有两类：**当前节点 ↔ 每个成员**（星形，带"为什么相关"：哪篇关联笔记 / 哪条链接），
 *     以及**同一篇关联笔记成员之间**的虚线（那是"它们彼此相关"的事实；成员 > 8 时不画，
 *     免得变成一团毛线）。
 *
 * 三条实现纪律（都来自本工程踩过的坑）：
 *   ① **坐标只认一个真源**：端点一律用 `MM.nodeBorderRect()`（e_panel 逻辑坐标，已含 view offset
 *      与树偏移）⇒ 与父节点连线同一个坐标系，缩放/平移靠变换层，**不自己算第二套坐标**；
 *   ② **高亮只写类，不写内联样式**：jsMind 的 `_reset_node_custom_style()` 会在每次 show_nodes
 *      重写内联的 background/color ⇒ 用类（CSS）才是稳的（本文件已有一个先例：`mm-rubber-hit`）；
 *   ③ **关系层挂进 `fdViewEls()`**：它跟着同一个 translate+scale 走 ⇒ 平移缩放**零重算**
 *      （只有"树被拖动/重排"才需要重画端点，那个用 rAF 合并）。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const LAYER_ID = 'mm-rel-layer';
  const HIT_LAYER_ID = 'mm-rel-hit-layer';
  const CLS_HIT = 'mm-rel-hit';     // 关联节点（高亮）
  const CLS_DIM = 'mm-rel-dim';     // 其余节点（轻微虚化）
  const ROLE = 'relation';          // 线图层路径的角色标记（断言据此认出来）

  /* ================= 关联模型：**唯一真源在 src/related-model.js** =================
   * （纯函数，可被 node 直接 require ⇒ 有单测 tests/related-model.test.js。这里只取用它，
   *  不在渲染层再写一份 —— 同一件事两处表达必然漂移 ✓） */
  function model() {
    if (!window.MMRelated || !window.MMRelated.buildRelationModel) {
      throw new Error('src/related-model.js 没加载：检查 index.html 的 script 标签');
    }
    return window.MMRelated.buildRelationModel;
  }

  /* ================= 视图层 ================= */
  let active = null;      // { nodeId, members:Set, edges }
  let rafId = 0;
  let escBound = false;

  function panel() { return MM.fdPanel && MM.fdPanel(); }

  /** 关系层：挂在变换层里（与 canvas/节点层同一个 translate+scale）⇒ 平移缩放零重算 ✓ */
  function ensureLayer() {
    const p = panel();
    if (!p) return null;
    let svg = p.querySelector('#' + LAYER_ID);
    if (svg) return svg;
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', LAYER_ID);
    svg.setAttribute('data-role', ROLE);
    // 逻辑坐标可能是负的（原点被 jsMind 平移过）⇒ 必须 overflow:visible，否则线被裁掉
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:1';
    const canvas = p.querySelector('canvas.jsmind');
    // 放在 canvas 之后：DOM 顺序让它在树边之上；节点层 z-index 更高 ⇒ 节点仍压在最上面 ✓
    if (canvas && canvas.nextSibling) p.insertBefore(svg, canvas.nextSibling);
    else p.appendChild(svg);
    return svg;
  }

  /** 命中层：**必须单独一层且盖在节点之上** ✗✗ —— 这是"点线打不开笔记"的真根因：
   *  视觉线在节点层**下面**（不然会压在节点上），而节点层是整块 DOM ⇒ 真鼠标事件永远落在节点层上，
   *  到不了线 ✗。（我最初的断言用 `dispatchEvent` 直接派到 path 上 ⇒ **绕过了命中测试** ⇒ 断言绿、
   *  功能坏 ✓✓ 教训记这里：验点击必须发**真鼠标事件**（`sendInputEvent`），不能用 DOM 派发。）
   *  所以：视觉层在下（pointer-events:none ✓），命中层在上（透明、只有 stroke 可点 ✓）。 */
  function ensureHitLayer() {
    const p = panel();
    if (!p) return null;
    let svg = p.querySelector('#' + HIT_LAYER_ID);
    if (svg) return svg;
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', HIT_LAYER_ID);
    svg.setAttribute('data-role', ROLE + '-hit-layer');
    // z-index 3 > 节点层（jsMind 给 jmnodes 的 2）⇒ 真点击先落到这里；根元素本身不吃事件 ✓
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:3';
    p.appendChild(svg);
    return svg;
  }

  /** 节点元素的逻辑矩形（唯一坐标真源） */
  function rectOf(id) {
    const jm = MM.getState && MM.getState().jm;
    if (!jm) return null;
    const el = jm.view && jm.view.e_panel
      ? jm.view.e_panel.querySelector('jmnode[nodeid="' + id + '"]')
      : null;
    if (!el) return null;
    const b = MM.nodeBorderRect(el, MM.treeRootOf ? MM.treeRootOf(id) : null);
    if (!b) return null;
    // ⚠️ 折叠/隐藏的节点**元素还在、几何是 0×0**（实测：冒烟里 5 个目标节点全如此）⇒
    //    必须当"没渲染"：否则缩放会算出一个退化框（s 直接飙到上限 4）、线端点全错 ✗。
    //    逻辑坐标下真实节点的尺寸是几十像素量级，所以 <1px 只可能是没渲染 ✓
    if (Math.abs(b.right - b.left) < 1 && Math.abs(b.bottom - b.top) < 1) return null;
    return b;
  }

  function allNodeEls() {
    const p = panel();
    return p ? Array.from(p.querySelectorAll('jmnode[nodeid]')) : [];
  }

  /** 高亮/虚化：**只写类**（jsMind 会重写内联样式，见文件头 ②） */
  function applyHighlight() {
    const hit = active ? active.members : null;
    for (const el of allNodeEls()) {
      const id = el.getAttribute('nodeid');
      const on = !!(hit && (hit.has(id) || id === active.nodeId));
      el.classList.toggle(CLS_HIT, on);
      el.classList.toggle(CLS_DIM, !!(hit && !on));
    }
  }

  function clearHighlight() {
    for (const el of allNodeEls()) el.classList.remove(CLS_HIT, CLS_DIM);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** 重画所有线（端点现取 ⇒ 树被拖动/重排后依然贴合）。
   *  同时维护**两层**：视觉层（节点下面）+ 命中层（节点上面，见 ensureHitLayer 的说明）✓ */
  function redrawLines() {
    const svg = ensureLayer();
    const hitSvg = ensureHitLayer();
    if (!svg) return 0;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (hitSvg) while (hitSvg.firstChild) hitSvg.removeChild(hitSvg.firstChild);
    if (!active) { svg.dataset.count = '0'; if (hitSvg) hitSvg.dataset.count = '0'; return 0; }
    let n = 0;
    for (const e of active.edges) {
      const ra = rectOf(e.a), rb = rectOf(e.b);
      if (!ra || !rb) continue;                       // 端点不在树上（折叠/跨项目）⇒ 不画
      const d = 'M' + ra.cx + ',' + ra.cy + ' L' + rb.cx + ',' + rb.cy;
      const line = document.createElementNS(SVG_NS, 'path');
      line.setAttribute('d', d);
      line.setAttribute('class', 'mm-rel-line mm-rel-line--' + e.kind);
      line.setAttribute('data-rel-a', e.a);
      line.setAttribute('data-rel-b', e.b);
      line.setAttribute('data-role', ROLE + '-line');
      svg.appendChild(line);
      // 命中热区：透明加粗 + pointer-events:stroke，放在**上层**才真的点得到 ✓
      if (hitSvg) {
        const hit = document.createElementNS(SVG_NS, 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('class', 'mm-rel-hitpath');
        hit.setAttribute('data-role', ROLE + '-hit');
        hit.setAttribute('data-rel-a', e.a);
        hit.setAttribute('data-rel-b', e.b);
        hit.setAttribute('data-assoc', (e.assocIds || []).join(','));
        hit.addEventListener('click', (ev) => { ev.stopPropagation(); onLineClick(e, ev); });
        hitSvg.appendChild(hit);
      }
      n++;
    }
    svg.dataset.count = String(n);
    if (hitSvg) hitSvg.dataset.count = String(n);
    return n;
  }

  /** 树被拖动 / 重排 ⇒ 端点变了，重画（rAF 合并：拖动时每帧只画一次） */
  function scheduleRedraw() {
    if (!active || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      redrawLines();
      applyHighlight();     // 重排可能重建了节点元素 ⇒ 类要补（见文件头 ②）
    });
  }

  /** 点线 ⇒ 打开那篇关联笔记，**位置取决于鼠标点击位置**（大锁 = 不跟导图跑） */
  function onLineClick(edge, ev) {
    const assocId = (edge.assocIds || [])[0];
    const items = (window.__mmAssocItems || []);
    let assoc = assocId ? items.find((a) => a.id === assocId) : null;
    if (!assoc && items.length === 1) assoc = items[0];      // 只有一篇（星形线常见）就直接开它
    const jm = MM.getState && MM.getState().jm;
    const node = jm && active ? jm.get_node(active.nodeId) : null;
    if (!assoc) { MM.setStatus('这条线没有对应的关联笔记（它是链接关系）', true); return; }
    const box = MM.showAssocPage(assoc, node);
    if (!box) return;
    // 大锁 + 写一次坐标：这就是"位置取决于鼠标点击位置"（且此后不再跟导图跑）
    if (box.lock !== MM.FD_LOCK.SCREEN) MM.setFdBoxLock(box, MM.FD_LOCK.SCREEN);
    const p = panel();
    const r = p ? p.getBoundingClientRect() : { left: 0, top: 0 };
    const w = box.el.offsetWidth || 360, h = box.el.offsetHeight || 240;
    const maxX = Math.max(8, window.innerWidth - w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    box.el.style.left = Math.min(Math.max(8, (ev ? ev.clientX : r.left) - 40), maxX) + 'px';
    box.el.style.top = Math.min(Math.max(8, (ev ? ev.clientY : r.top) - 24), maxY) + 'px';
    MM.setStatus('已按点击位置打开关联笔记（大锁 🔒 钉住，不跟导图跑）');
  }

  /** 把视口缩放到"刚好框住这些节点"（一趟算完：逻辑坐标 ↔ 屏幕是纯仿射 ✓） */
  function fitToNodes(ids) {
    const p = panel();
    if (!p) return null;
    const rects = ids.map(rectOf).filter(Boolean);
    if (!rects.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left); right = Math.max(right, r.right);
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
    }
    const W = p.clientWidth || p.offsetWidth || 1;
    const H = p.clientHeight || p.offsetHeight || 1;
    const padX = Math.max(24, W * 0.12), padY = Math.max(24, H * 0.12);
    const bw = Math.max(1, right - left), bh = Math.max(1, bottom - top);
    const s = Math.max(0.15, Math.min(4, Math.min((W - 2 * padX) / bw, (H - 2 * padY) / bh)));
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    if (MM.setViewTransform) MM.setViewTransform({ s: s, x: W / 2 - cx * s, y: H / 2 - cy * s });
    return { s: s, box: { left, top, right, bottom }, count: rects.length };
  }

  /** 展示关联节点（按钮入口） */
  async function showRelated(nodeId) {
    const st = MM.getState && MM.getState();
    const project = st && st.project ? st.project.name : null;
    const jm = st && st.jm;
    if (!project || !jm || !nodeId) { MM.setStatus('拿不到当前项目/节点', true); return null; }
    if (!window.desktop || !window.desktop.app || !window.desktop.app.assoc) return null;
    const [assocRes, relatedRes] = await Promise.all([
      window.desktop.app.assoc(project, nodeId).catch(() => ({ items: [] })),
      window.desktop.app.related ? window.desktop.app.related(project, nodeId).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] })
    ]);
    const assocItems = (assocRes && assocRes.items) || [];
    // 供"点线开笔记"复用（同一份数据，不再多打一次 IPC）
    window.__mmAssocItems = assocItems;
    const relationOf = model();      // src/related-model.js 的纯函数（唯一真源）
    const rel = relationOf({
      nodeId, project, assocItems, relatedItems: (relatedRes && relatedRes.items) || []
    });
    // ★ 先把祖先展开：关联节点**常常在被收起的子树里**，而收起的节点没有几何
    // （实测：冒烟里 5 个目标节点全是 0×0 矩形 ⇒ 缩放算成"退化框"、线端点全错 ✗）。
    // "缩放至刚好展示所有关联节点"的前提就是它们**可见** ⇒ 展开是这一步的一部分 ✓
    const inTreeAll = rel.members.filter((m) => !!jm.get_node(m.id));
    const expandable = [nodeId].concat(inTreeAll.map((m) => m.id));
    if (MM.expandAncestors) {
      for (const id of expandable) {
        try { MM.expandAncestors(jm, id); } catch (e) { /* 单个失败不影响其余 */ }
      }
    }
    // 展开之后仍没有元素的（比如在别的顶层主题里被整体隐藏）才算"画不出来"，如实计数
    const inTree = inTreeAll.filter((m) => !!rectOf(m.id));
    const unrendered = inTreeAll.length - inTree.length;
    if (!inTree.length) {
      MM.setStatus(rel.crossProject
        ? '这个节点只有跨项目的关联（' + rel.crossProject + ' 个不在当前图上，画不出线）'
        : '这个节点没有可展示的关联节点（关联笔记：' + rel.assocCount + ' 篇）', true);
      clearRelated();
      return null;
    }
    active = { nodeId, members: new Set(inTree.map((m) => m.id)), edges: rel.edges, model: rel };
    ensureLayer();
    bindEsc();
    applyHighlight();
    const fit = fitToNodes([nodeId].concat(inTree.map((m) => m.id)));
    const drawn = redrawLines();
    MM.setStatus('已展示 ' + inTree.length + ' 个关联节点（关系线 ' + drawn + ' 条'
      + (rel.crossProject ? '；另有 ' + rel.crossProject + ' 个跨项目节点不在本图' : '')
      + (unrendered ? '；' + unrendered + ' 个展开后仍未显示' : '')
      + '）· 按 Esc 或再点一次按钮退出');
    return { members: inTree, drawn, fit, crossProject: rel.crossProject, unrendered, assocCount: rel.assocCount };
  }

  function bindEsc() {
    if (escBound) return;
    escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && active) { clearRelated(); MM.setStatus('已退出关联节点展示'); }
    });
  }

  /** 退出：清类、清线、清状态（幂等） */
  function clearRelated() {
    active = null;
    window.__mmAssocItems = null;
    clearHighlight();
    [LAYER_ID, HIT_LAYER_ID].forEach((id) => {
      const p = panel();
      const svg = p ? p.querySelector('#' + id) : null;
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.dataset.count = '0';
    });
    return true;
  }

  const isActive = () => !!active;
  const activeMembers = () => (active ? Array.from(active.members) : []);

  MM.showRelated = showRelated;
  MM.clearRelated = clearRelated;
  MM.redrawRelatedLines = redrawLines;
  MM.scheduleRelatedRedraw = scheduleRedraw;
  MM.isRelatedActive = isActive;
  MM.relatedMembers = activeMembers;
  MM.REL_CLASSES = { HIT: CLS_HIT, DIM: CLS_DIM, LAYER_ID };
})();
