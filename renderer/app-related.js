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
  /* ⑦c 性能：拖动/缩放时 `scheduleRedraw` 每帧都会跑 applyHighlight —— 原实现每帧对**全部**节点
   * （实测 556 个）做 2 次 classList.toggle ⇒ 每帧 ~1600 次 DOM 写 ⇒ 卡 ✓。
   * 现在用 **WeakSet 记账**：同一个高亮状态里，已经标过的元素直接跳过 ⇒ 每帧只处理"新出现"的元素
   * （jsMind 重排/展开会重建元素，新元素不在账上 ⇒ 自动补类 ✓ 不会静默丢高亮 ✓）。
   * 状态一变（换节点 / 退出 / 成员集变化）就清账重来 ✓。 */
  let hlSig = '';
  let hlSeen = new WeakSet();
  function applyHighlight() {
    const hit = active ? active.members : null;
    const sig = active ? (active.nodeId + '|' + (hit ? hit.size : 0)) : '';
    if (sig !== hlSig) { hlSig = sig; hlSeen = new WeakSet(); }
    for (const el of allNodeEls()) {
      if (hlSeen.has(el)) continue;
      hlSeen.add(el);
      const id = el.getAttribute('nodeid');
      const on = !!(hit && (hit.has(id) || id === active.nodeId));
      el.classList.toggle(CLS_HIT, on);
      el.classList.toggle(CLS_DIM, !!(hit && !on));
    }
  }

  function clearHighlight() {
    hlSig = ''; hlSeen = new WeakSet();          // 清账：下次展示会重新逐元素标一遍 ✓
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
    const node = jm && active ? MM.adapter.getNode(jm, active.nodeId) : null;
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

  /** 把视口缩放到"刚好框住这些节点"（一趟算完：逻辑坐标 ↔ 屏幕是纯仿射 ✓）
   *
   * `insetTop` = 顶部被别的界面元素占掉的高度（关联信息编辑条）。**必须让出来**：
   * 编辑条就压在面板顶部，若还把节点居中到面板正中，最上面那排节点会被它盖住 ——
   * "缩放至刚好框住"就名不副实了（这条与"按钮不遮挡详情内容"是同一条纪律）。 */
  function fitToNodes(ids, insetTop) {
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
    const top0 = Math.max(0, Number(insetTop) || 0);
    const H = Math.max(1, (p.clientHeight || p.offsetHeight || 1) - top0);
    const padX = Math.max(24, W * 0.12), padY = Math.max(24, H * 0.12);
    const bw = Math.max(1, right - left), bh = Math.max(1, bottom - top);
    const s = Math.max(0.15, Math.min(4, Math.min((W - 2 * padX) / bw, (H - 2 * padY) / bh)));
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    if (MM.setViewTransform) MM.setViewTransform({ s: s, x: W / 2 - cx * s, y: top0 + H / 2 - cy * s });
    return { s: s, box: { left, top, right, bottom }, count: rects.length };
  }

  /** 编辑条当前占掉的顶部高度（没有条就返回 0） */
  function barInsetTop() {
    const el = barEl();
    return el ? (el.offsetHeight || 0) : 0;
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
    const inTreeAll = rel.members.filter((m) => !!MM.adapter.getNode(jm, m.id));
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
      // 用户 2026-10-08：**没有关联节点的也要能进这个视图** ✓（它是人工编辑关联信息的入口 ✓）
      // ⇒ 不再"早退什么都不做"：只高亮中心节点自身、给一句明确状态（不静默 ✗）
      MM.setStatus(rel.crossProject
        ? '这个节点只有跨项目的关联（' + rel.crossProject + ' 个不在当前图上）：已进入关联视图，可在下面添加本图内的关联'
        : '这个节点还没有关联节点（关联笔记：' + rel.assocCount + ' 篇）：已进入关联视图，可在下面添加关联', true);
      active = { nodeId, members: new Set([nodeId]), edges: [], model: rel };
      ensureLayer();
      bindEsc();
      openBar(nodeId);          // ★ 没有关联节点也能编辑关联信息 ⇒ 编辑条**照常出现**（不是"早退就什么都不做"）
      applyHighlight();
      fitToNodes([nodeId], barInsetTop());
      redrawLines();
      return { members: [], drawn: 0, fit: null, crossProject: rel.crossProject, unrendered: 0, assocCount: rel.assocCount, empty: true };
    }
    active = { nodeId, members: new Set(inTree.map((m) => m.id)), edges: rel.edges, model: rel };
    ensureLayer();
    bindEsc();
    openBar(nodeId);            // ★ 三个入口（详情框圆钮 / 右键菜单 / 命令面板）都汇到这里
    applyHighlight();
    const fit = fitToNodes([nodeId].concat(inTree.map((m) => m.id)), barInsetTop());
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

  /** 退出：清类、清线、清状态（幂等）。**编辑条与视图同生命周期** —— 一起收掉。 */
  function clearRelated() {
    active = null;
    window.__mmAssocItems = null;
    closeBar();
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

  /* ================= 内存同步：链接改动只有这一份实现 =================
   * 磁盘上的链接由 CLI 写（校验闸门 + 原子写），但**渲染层的内存树**才是下一次「保存」的载荷
   * （`serializeTree` 读 `node.data.links`）⇒ 内存不跟着变，那次保存就把刚做的改动原样抹掉。
   * 这正是 `app-audit.js`「补链接」踩过一次的坑（当时用 `openProject()` 重载项目，
   * 顺手把用户未保存的编辑和撤销栈丢了 —— 见那个函数的长注释），故这里把
   * "怎么改内存"抽成**唯一一份**，补链接 / 摘链接都走它，别在调用点各写一遍。
   *
   * @param opts { project, fromId, toProject, toId, caption?, remove?, set? }
   *   · set  —— 用**回读到的权威清单**整份替换（摘链接走这条：磁盘说什么就是什么）；
   *   · 否则 —— 按 project+id 在内存那份里就地增删（补链接走这条：CLI 只回"成功"，没有整份清单）。
   * @returns 'ok' | 'other-project'（不在当前项目里 ⇒ 内存里没有它，无从同步）| 'no-node'（树里找不到）
   */
  function applyLinkToMemory(opts) {
    const st = MM.getState && MM.getState();
    const jm = st && st.jm;
    const cur = (st && st.project && st.project.name) || '';
    if (!opts || opts.project !== cur) return 'other-project';
    const node = MM.adapter.available(jm) ? MM.adapter.getNode(jm, opts.fromId) : null;
    if (!node) return 'no-node';
    node.data = node.data || {};
    let list;
    if (Array.isArray(opts.set)) {
      list = opts.set.slice();
    } else {
      list = Array.isArray(node.data.links) ? node.data.links.slice() : [];
      const i = list.findIndex((l) => l && l.project === opts.toProject && l.id === opts.toId);
      if (opts.remove) { if (i >= 0) list.splice(i, 1); }
      else if (i < 0) {
        list.push(opts.caption
          ? { project: opts.toProject, id: opts.toId, caption: opts.caption }
          : { project: opts.toProject, id: opts.toId });
      } else if (!opts.remove && opts.caption) {
        list[i] = { project: opts.toProject, id: opts.toId, caption: opts.caption };
      }
    }
    // 空清单就删键：`serializeTree` 只在非空时写回，留个空数组等于制造与旧格式的差异噪音
    if (list.length) node.data.links = list; else delete node.data.links;
    return 'ok';
  }
  MM.applyLinkToMemory = applyLinkToMemory;

  /* ================= 「关联信息」编辑条（人工编辑关联信息） =================
   * 用户需求（原话）："进入关联视图后能人工编辑关联信息"。已确认范围 = **加/删链接 + 新建关联笔记**。
   * 这三件事此前在界面里都够不到：补链接只有关系审计面板有、删链接只有 CLI、
   * 关联笔记只能改 AI 已经写好的那篇（界面**没有创建入口**）✗。
   *
   * 位置与形态：**面板顶部的固定条**（`#mindmap-container` 的子元素、position:absolute）——
   *   · 不进 `fdViewEls()`：它不是图的一部分，不该跟着 translate+scale 走；
   *   · 不做成对话框：它与关联视图**同生命周期**（三个入口：详情框圆钮 / 右键菜单 / 命令面板），
   *     进视图就出现、Esc 或再点一次就消失；
   *   · 打开期间把容器角标 `#mm-root-label` 藏起来 —— 两者占同一位置，与其让谁莫名被盖住，
   *     不如显式让位（一条 CSS 规则 + 容器类，见 style.css 的 `.mm-rele-open`）。
   *
   * 三条纪律：
   *  ① **写操作一律经 CLI**（IPC → CLI 的校验闸门 + 原子写 + 并发重放），渲染层不直接改盘；
   *  ② **写后回读 + 同步内存**（applyLinkToMemory）—— 否则下一次界面保存会把改动覆盖回去；
   *  ③ **搜索复用** `desktop.app.nodes` + `src/palette-rank.js` 的 `rankPalette`
   *     （不在渲染层另写一套模糊排序：那正是"同一逻辑两处表达"）。
   *
   * 链接清单**两个方向都列**：出边来自 `related` 的 dir=out/both、入边来自 `backlinks` 的
   * within+cross —— 判定一律在 CLI 侧，渲染层不自己遍历树算边。
   * 互指的 A↔B 会显示**两行**（→ 一行、← 一行）：它们本来就是两条独立的边，每行各自可删。
   */
  const BAR_ID = 'mm-rel-edit';
  const BAR_OPEN_CLS = 'mm-rele-open';   // 挂在 #mindmap-container 上（让位角标 + 便于断言）

  const bar = {
    nodeId: null,
    pane: '',            // '' | 'link' | 'assoc'
    q: '', sel: 0,       // 「添加链接」的搜索词与当前高亮项
    mq: '', msel: 0,     // 「新建关联笔记」的成员搜索
    members: [],         // [{ project, id, topic }]，中心节点预置在第 0 位
    title: '', note: '',
    edges: { out: [], in: [], loading: true, error: '' },
    rows: [],            // 出边 + 入边的合并清单（行的下标就是它的下标）
    cands: [],
  };

  const curProject = () => {
    const st = MM.getState && MM.getState();
    return (st && st.project && st.project.name) || '';
  };
  const jmOf = () => {
    const st = MM.getState && MM.getState();
    return (st && st.jm) || null;
  };
  const barEl = () => document.getElementById(BAR_ID);

  /** 中心节点：**从内存树现取**（节点被删/换项目 ⇒ 树里找不到就该退出，不留一个指向空气的编辑条） */
  function barNode() {
    const jm = jmOf();
    return (MM.adapter.available(jm) && bar.nodeId) ? MM.adapter.getNode(jm, bar.nodeId) : null;
  }

  /** 候选排序：唯一真源是 src/palette-rank.js（与命令面板同一份，别在这儿再写一套 ✗） */
  function rankCands(entries, q, limit) {
    if (!window.MMPaletteRank || !window.MMPaletteRank.rankPalette) {
      throw new Error('src/palette-rank.js 没加载：检查 index.html 的 script 标签');
    }
    return window.MMPaletteRank.rankPalette(entries, q, limit);
  }

  /** 扁平节点清单（切项目失效；与命令面板同一条 IPC `app:nodes`） */
  let nodesCache = null;
  async function nodeList() {
    const p = curProject();
    if (nodesCache && nodesCache.project === p) return nodesCache.nodes;
    if (!p || !window.desktop || !window.desktop.app || !window.desktop.app.nodes) return [];
    try {
      const r = await window.desktop.app.nodes(p);
      const nodes = (r && r.nodes) || [];
      nodesCache = { project: p, nodes: nodes };
      return nodes;
    } catch (err) { nodesCache = { project: p, nodes: [] }; return []; }
  }

  /** 拉链接清单（两个方向）。CLI 侧过滤 —— 渲染层不自己遍历树算边。 */
  async function loadEdges() {
    const p = curProject();
    const id = bar.nodeId;
    bar.edges = { out: [], in: [], loading: true, error: '' };
    bar.rows = [];
    if (!p || !id || !window.desktop || !window.desktop.app) return;
    const out = [];
    const inc = [];
    try {
      const rel = window.desktop.app.related ? await window.desktop.app.related(p, id) : { items: [] };
      if (rel && rel.error) throw new Error(String(rel.error));
      ((rel && rel.items) || []).forEach((x) => {
        if (!x || x.depth !== 1) return;
        if (x.dir !== 'out' && x.dir !== 'both') return;
        out.push({ dir: 'out', fromProject: p, fromId: id, toProject: x.project, toId: x.node, topic: x.topic, caption: x.caption || '' });
      });
    } catch (err) { bar.edges.error = '出边读取失败：' + ((err && err.message) || err); }
    try {
      const bl = window.desktop.app.backlinks ? await window.desktop.app.backlinks(p, id) : null;
      if (bl && bl.error) throw new Error(String(bl.error));
      ((bl && bl.within) || []).forEach((x) => inc.push({ dir: 'in', fromProject: p, fromId: x.node, toProject: p, toId: id, topic: x.topic, caption: x.caption || '' }));
      ((bl && bl.cross) || []).forEach((x) => inc.push({ dir: 'in', fromProject: x.project, fromId: x.node, toProject: p, toId: id, topic: x.topic, caption: x.caption || '' }));
    } catch (err) { bar.edges.error = (bar.edges.error ? bar.edges.error + '；' : '') + '入边读取失败：' + ((err && err.message) || err); }
    bar.edges.out = out;
    bar.edges.in = inc;
    // 行的下标统一按 **out 在前、in 在后** 的合并顺序编号 —— ✕ 按钮只带一个下标，
    // 两种方向共用一套删除路径（出边与入边的差别只在"那条边写在谁的项目里"）。
    bar.rows = out.concat(inc);
    bar.edges.loading = false;
  }

  /** 打开编辑条（进关联视图时调用；幂等） */
  function openBar(nodeId) {
    const host = document.getElementById('mindmap-container');
    if (!host || !nodeId) return null;
    const jm = jmOf();
    const node = MM.adapter.available(jm) ? MM.adapter.getNode(jm, nodeId) : null;
    if (!node) return null;
    let el = barEl();
    if (!el) {
      el = document.createElement('div');
      el.id = BAR_ID;
      el.className = 'mm-rele';
      el.setAttribute('data-role', 'related-edit-bar');
      host.appendChild(el);
      bindBar(el);                                  // 事件委托：只绑一次（内容会整块重绘）
    }
    const same = bar.nodeId === nodeId;
    bar.nodeId = nodeId;
    if (!same) {
      bar.pane = ''; bar.q = ''; bar.sel = 0; bar.mq = ''; bar.msel = 0;
      bar.title = ''; bar.note = '';
      bar.members = [{ project: curProject(), id: nodeId, topic: node.topic || nodeId }];
      nodesCache = null;                            // 每次进视图都重取（新增/删除节点后立刻能搜到）
    }
    host.classList.add(BAR_OPEN_CLS);
    paint();
    loadEdges().then(() => paint());
    return el;
  }

  function closeBar() {
    const el = barEl();
    if (el && el.parentElement) el.parentElement.removeChild(el);
    const host = document.getElementById('mindmap-container');
    if (host) host.classList.remove(BAR_OPEN_CLS);
    bar.nodeId = null;
    bar.edges = { out: [], in: [], loading: true, error: '' };
  }

  const esc = (s) => MM.escHtml(s);

  /** 一行链接（出边 / 入边）。`i` 是它在 `bar.rows` 里的合并下标（✕ 按钮按它找边）。 */
  function linkRow(e, i) {
    const arrow = e.dir === 'out' ? '→' : '←';
    const dirText = e.dir === 'out' ? '出边' : '入边';
    // 这条边**写在谁的项目里**：出边写在中心节点所在项目上；入边写在**来源节点**所在项目上
    const owner = e.dir === 'out' ? e.fromProject : e.fromProject;
    const other = e.dir === 'out' ? (e.toProject + '/' + e.toId) : (e.fromProject + '/' + e.fromId);
    const label = e.topic || other;
    return '<div class="rele-link" data-i="' + i + '" data-dir="' + e.dir + '">'
      + '<span class="rele-arrow rele-arrow--' + e.dir + '" title="' + dirText + '">' + arrow + '</span>'
      + '<span class="rele-dir">' + dirText + '</span>'
      + '<span class="rele-link-label" title="' + esc(other) + '">' + esc(label) + '</span>'
      + (e.dir === 'in' && owner !== curProject() ? '<span class="rele-where">[' + esc(owner) + ']</span>' : '')
      + (e.caption ? '<span class="rele-caption">' + esc(e.caption) + '</span>' : '')
      + '<button type="button" class="rele-del" data-i="' + i + '" title="删除这条链接'
        + (owner !== curProject() ? '（该边写在项目 ' + esc(owner) + ' 上，会写那个项目的文件）' : '') + '">✕</button>'
      + '</div>';
  }

  function paint(focus) {
    const el = barEl();
    if (!el) return;
    const node = barNode();
    if (!node) { clearRelated(); return; }           // 节点没了（删了/换了项目）⇒ 视图与编辑条一起退出
    const out = bar.edges.out || [];
    const inc = bar.edges.in || [];
    const outHtml = out.map((e, i) => linkRow(e, i)).join('');
    const inHtml = inc.map((e, i) => linkRow(e, out.length + i)).join('');
    const group = (title, body, n) => '<div class="rele-group"><span class="rele-group-title">' + title
      + '（' + n + '）</span>' + (n ? '' : '<span class="rele-empty">无</span>') + body + '</div>';
    el.innerHTML =
      '<div class="rele-head">'
      + '<span class="rele-title">🔗 关联信息 · <b>' + esc(node.topic || node.id) + '</b></span>'
      + '<button type="button" class="rele-add' + (bar.pane === 'link' ? ' on' : '') + '">➕ 添加链接</button>'
      + '<button type="button" class="rele-new' + (bar.pane === 'assoc' ? ' on' : '') + '">📝 新建关联笔记</button>'
      + '<span class="rele-hint">写操作经 CLI（校验闸门 + 原子写）</span>'
      + '<button type="button" class="rele-close" title="退出关联视图（Esc）">✕</button>'
      + '</div>'
      + '<div class="rele-links">'
      + (bar.edges.loading ? '<span class="rele-empty">正在读取链接…</span>'
        : (bar.edges.error ? '<span class="rele-err">' + esc(bar.edges.error) + '</span>'
          : group('出边 · 我引用谁', outHtml, out.length) + group('入边 · 谁引用我', inHtml, inc.length)))
      + '</div>'
      + paneHtml()
      + '<div class="rele-status"></div>';
    if (focus) restoreFocus(focus, el);
  }

  function paneHtml() {
    if (bar.pane === 'link') {
      const rows = (bar.cands || []).map((c, i) =>
        '<div class="rele-cand' + (i === bar.sel ? ' on' : '') + '" data-id="' + esc(c.id) + '" data-i="' + i + '">'
        + '<span class="rele-cand-topic">' + esc(c.label) + '</span>'
        + '<span class="rele-cand-id">' + esc(c.id) + '</span></div>').join('');
      return '<div class="rele-pane rele-pane--link">'
        + '<input class="rele-q" type="text" autocomplete="off" placeholder="输入即搜节点…（↑↓ 选择，Enter 建立链接，Esc 收起）" value="' + esc(bar.q) + '">'
        + '<div class="rele-cands">' + (bar.q.trim() === '' ? '<div class="rele-empty">输入关键词开始搜索（同一项目内的节点）</div>'
          : (rows || '<div class="rele-empty">没有匹配的节点</div>')) + '</div>'
        + '</div>';
    }
    if (bar.pane === 'assoc') {
      const chips = bar.members.map((m, i) =>
        '<span class="rele-chip' + (i === 0 ? ' rele-chip--center' : '') + '" data-i="' + i + '" title="' + esc(m.project + '/' + m.id) + '">'
        + (i === 0 ? '◎ ' : '') + esc(m.topic || m.id)
        + (i === 0 ? '<span class="rele-chip-note">中心节点</span>'
          : '<button type="button" class="rele-mdel" data-i="' + i + '" title="移出成员">✕</button>')
        + '</span>').join('');
      const crows = (bar.mcands || []).map((c, i) =>
        '<div class="rele-cand' + (i === bar.msel ? ' on' : '') + '" data-mid="' + esc(c.id) + '" data-i="' + i + '">'
        + '<span class="rele-cand-topic">' + esc(c.label) + '</span>'
        + '<span class="rele-cand-id">' + esc(c.id) + '</span></div>').join('');
      const ok = bar.members.length >= 2;
      return '<div class="rele-pane rele-pane--assoc">'
        + '<div class="rele-chips">' + chips + '</div>'
        + '<input class="rele-mq" type="text" autocomplete="off" placeholder="再加一个成员：输入即搜…（成员 ≥2 才能新建）" value="' + esc(bar.mq) + '">'
        + '<div class="rele-cands">' + (bar.mq.trim() === '' ? '' : (crows || '<div class="rele-empty">没有匹配的节点</div>')) + '</div>'
        + '<input class="rele-title" type="text" placeholder="标题（可选；留空则用成员主题拼接）" value="' + esc(bar.title) + '">'
        + '<textarea class="rele-note" rows="4" placeholder="笔记内容（Markdown；命令内转 HTML 后存储）">' + esc(bar.note) + '</textarea>'
        + '<div class="rele-actions">'
        + '<span class="rele-count">成员 ' + bar.members.length + ' 个' + (ok ? '' : '（至少再加 1 个）') + '</span>'
        + '<button type="button" class="rele-cancel">取消</button>'
        + '<button type="button" class="rele-submit"' + (ok ? '' : ' disabled') + '>新建关联笔记</button>'
        + '</div>'
        + '</div>';
    }
    return '';
  }

  /** 重绘会重建输入框 ⇒ 把焦点与光标还回去（否则每敲一个字就失去焦点，完全没法打字 ✗） */
  function restoreFocus(sel, el) {
    const input = el.querySelector(sel);
    if (!input) return;
    input.focus();
    try {
      const v = input.value || '';
      input.setSelectionRange(v.length, v.length);
    } catch (e) { /* 不是文本类输入框（如 textarea 也支持；失败就算了） */ }
  }

  /** 搜索候选：排除中心节点自身与"已经链接过"的目标（避免点一下只换来一句 CLI 报错） */
  async function refreshCands() {
    if (bar.pane !== 'link') { bar.cands = []; return; }
    const nodes = await nodeList();
    const linked = new Set((bar.edges.out || []).map((e) => e.toProject + '|' + e.toId));
    const p = curProject();
    const entries = nodes
      .filter((n) => n && n.id && n.id !== bar.nodeId && !linked.has(p + '|' + n.id))
      .map((n) => ({ kind: 'node', id: n.id, label: n.topic || n.id }));
    bar.cands = rankCands(entries, bar.q, 8);
    if (bar.sel >= bar.cands.length) bar.sel = 0;
  }

  async function refreshMemberCands() {
    if (bar.pane !== 'assoc') { bar.mcands = []; return; }
    const nodes = await nodeList();
    const taken = new Set(bar.members.map((m) => m.project + '|' + m.id));
    const p = curProject();
    const entries = nodes
      .filter((n) => n && n.id && !taken.has(p + '|' + n.id))
      .map((n) => ({ kind: 'node', id: n.id, label: n.topic || n.id }));
    bar.mcands = rankCands(entries, bar.mq, 8);
    if (bar.msel >= bar.mcands.length) bar.msel = 0;
  }

  function setStatusOfBar(text, isErr) {
    const el = barEl();
    const box = el ? el.querySelector('.rele-status') : null;
    if (box) box.textContent = text || '';
    MM.setStatus(text, isErr);
  }

  /** 建立链接：写操作经 CLI ⇒ 回读（内存同步）⇒ 刷新清单与详情框 */
  async function addLinkTo(toId) {
    const p = curProject();
    const from = bar.nodeId;
    if (!p || !from || !toId) return;
    try {
      const r = await window.desktop.app.linkNodes(p, from, p, toId, '关联视图内添加');
      if (!r || !r.ok) { setStatusOfBar('添加链接失败：' + ((r && r.text) || '未知错误'), true); return; }
      const mem = applyLinkToMemory({ project: p, fromId: from, toProject: p, toId: toId, caption: '关联视图内添加' });
      bar.q = ''; bar.sel = 0;
      await loadEdges();
      await refreshCands();
      paint();
      setStatusOfBar('已添加链接：' + from + ' → ' + toId + (mem === 'ok' ? '（磁盘与内存都已更新）' : '（磁盘已写；内存未同步：' + mem + '）'), mem !== 'ok');
      if (MM.refreshNodeDetailBox) MM.refreshNodeDetailBox(from);
      // 关系线要跟着变（关联模型里 links 是模型的一半）
      if (active) refreshModel();
    } catch (err) { setStatusOfBar('添加链接失败：' + ((err && err.message) || err), true); }
  }

  /** 删除一条链接（出边/入边统一走同一条 IPC；入边时 from 是**它所在的项目**）
   *
   * **自证 + 自清**（需求原话）：
   *  · 自证 —— 删完**重拉一遍清单**（不是"把内存里那行删掉"就完事）：界面这一侧必须能读回"它没了"；
   *  · 自清 —— 用 CLI 回读的**权威清单**整份同步进内存树（`applyLinkToMemory` 的 set 分支），
   *    这样下一次界面保存不会把刚删掉的边又写回去。
   */
  async function removeLink(edge) {
    if (!edge) { setStatusOfBar('这条链接对应的行已过期（清单可能刚被刷新过），请重试', true); return; }
    try {
      const r = await window.desktop.app.unlinkNodes(edge.fromProject, edge.fromId, edge.toProject, edge.toId);
      if (!r || !r.ok) { setStatusOfBar('删除链接失败：' + ((r && r.text) || '未知错误'), true); return; }
      const synced = Array.isArray(r.links)
        ? applyLinkToMemory({ project: edge.fromProject, fromId: edge.fromId, set: r.links })
        : applyLinkToMemory({ project: edge.fromProject, fromId: edge.fromId, toProject: edge.toProject, toId: edge.toId, remove: true });
      const how = Array.isArray(r.links) ? '按回读的权威清单' : '按"摘掉这一条"（未回读到清单）';
      await loadEdges();
      paint();
      const where = edge.fromProject + '/' + edge.fromId + ' → ' + edge.toProject + '/' + edge.toId;
      setStatusOfBar('已删除链接：' + where + '（' + how + '同步内存：' + synced + '）', synced !== 'ok');
      if (MM.refreshNodeDetailBox) MM.refreshNodeDetailBox(bar.nodeId);
      if (active) refreshModel();
    } catch (err) { setStatusOfBar('删除链接失败：' + ((err && err.message) || err), true); }
  }

  /** 退出关联视图后重算模型的成员集与线（改完链接，图上的关系线不该还停在旧状态 ✗） */
  function refreshModel() {
    const p = curProject();
    if (!p || !active) return;
    const nodeId = bar.nodeId;
    Promise.all([
      window.desktop.app.assoc(p, nodeId).catch(() => ({ items: [] })),
      window.desktop.app.related ? window.desktop.app.related(p, nodeId).catch(() => ({ items: [] })) : Promise.resolve({ items: [] })
    ]).then((res) => {
      if (!active || active.nodeId !== nodeId) return;    // 期间退出了/换了节点 ⇒ 丢掉这次结果
      window.__mmAssocItems = (res[0] && res[0].items) || [];
      const rel = model()({ nodeId: nodeId, project: p, assocItems: window.__mmAssocItems, relatedItems: (res[1] && res[1].items) || [] });
      const jm = jmOf();
      const inTree = rel.members.filter((m) => !!MM.adapter.getNode(jm, m.id) && !!rectOf(m.id));
      active.members = new Set(inTree.map((m) => m.id));
      active.edges = rel.edges;
      applyHighlight();
      redrawLines();
    }).catch(() => { /* 模型刷新失败不影响已完成的写操作；线停在旧状态，不静默改成空 */ });
  }

  /** 新建关联笔记：成员 ≥2（CLI 侧还会再判一次）⇒ 写盘 + 同步内存 ⇒ 开那篇新笔记的二级页面。
   *  **写盘与内存同步都在 `app-assoc.js` 的 `MM.assocAddFromView`**（assoc 域的唯一落点）——
   *  这里只管"表单 → 调用 → 把结果呈现出来"。 */
  async function createAssoc() {
    const p = curProject();
    if (!p) return;
    const ids = bar.members.map((m) => m.id);
    if (ids.length < 2) { setStatusOfBar('至少要有 2 个成员（中心节点已预置，请再加一个）', true); return; }
    const btn = barEl() ? barEl().querySelector('.rele-submit') : null;
    if (btn) { btn.disabled = true; btn.textContent = '正在新建…'; }
    try {
      const r = await MM.assocAddFromView(p, bar.nodeId, ids, bar.title.trim(), bar.note);
      if (!r || !r.ok) { setStatusOfBar('新建关联笔记失败：' + ((r && r.text) || '未知错误'), true); return; }
      bar.pane = ''; bar.mq = ''; bar.msel = 0; bar.title = ''; bar.note = '';
      await loadEdges();
      paint();
      // 刷新中心节点详情框里那份「关联笔记（N）」清单（需求里"列表里出现"指的就是这一处）
      if (MM.refreshNodeDetailBox) MM.refreshNodeDetailBox(bar.nodeId);
      const opened = !!(r.item && MM.showAssocPage(r.item, barNode()));
      if (active) refreshModel();
      setStatusOfBar('已新建关联笔记' + (r.id ? '：' + r.id : '') + '（' + ids.length + ' 个成员）'
        + (opened ? '，已打开它的二级页面' : '；二级页面未能自动打开（可点详情框里的关联条目）')
        + (r.readBack ? '' : ' —— 注意：回读失败，界面内存未同步，保存前请先刷新'), !opened || !r.readBack);
    } catch (err) {
      setStatusOfBar('新建关联笔记失败：' + ((err && err.message) || err), true);
    } finally {
      const b2 = barEl() ? barEl().querySelector('.rele-submit') : null;
      if (b2) { b2.disabled = bar.members.length < 2; b2.textContent = '新建关联笔记'; }
    }
  }

  /** 事件委托：内容整块重绘，故监听只绑在容器上（与 app-palette / app-audit 同规矩）。
   *  绑定标记写在**元素自己**身上而不是模块变量上：退出视图会把整条 DOM 摘掉，下次进来是**新元素**
   *  —— 用模块级布尔量守着的话，第二次进来就再也绑不上了（"点了没反应"，本工程治过多次的静默失效 ✗）。 */
  function bindBar(el) {
    if (el.__releBound) return;
    el.__releBound = true;
    el.addEventListener('click', async (e) => {
      const t = e.target;
      const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
      if (closest('.rele-close')) { clearRelated(); MM.setStatus('已退出关联节点展示'); return; }
      if (closest('.rele-add')) {
        bar.pane = bar.pane === 'link' ? '' : 'link';
        bar.q = ''; bar.sel = 0;
        paint(bar.pane === 'link' ? '.rele-q' : null);
        if (bar.pane === 'link') { await refreshCands(); paint('.rele-q'); }
        return;
      }
      if (closest('.rele-new')) {
        bar.pane = bar.pane === 'assoc' ? '' : 'assoc';
        bar.mq = ''; bar.msel = 0;
        paint(bar.pane === 'assoc' ? '.rele-mq' : null);
        if (bar.pane === 'assoc') { await refreshMemberCands(); paint('.rele-mq'); }
        return;
      }
      if (closest('.rele-del')) {
        const i = Number(closest('.rele-del').getAttribute('data-i'));
        await removeLink((bar.rows || [])[i]);
        return;
      }
      const cand = closest('.rele-cand');
      if (cand) {
        if (cand.getAttribute('data-mid')) {
          const id = cand.getAttribute('data-mid');
          const hit = (bar.mcands || []).find((c) => c.id === id);
          if (hit && !bar.members.some((m) => m.id === id)) bar.members.push({ project: curProject(), id: id, topic: hit.label });
          bar.mq = ''; bar.msel = 0;
          await refreshMemberCands();
          paint('.rele-mq');
          if (bar.members.length >= 2) setStatusOfBar('成员 ' + bar.members.length + ' 个 —— 可以新建了（标题与正文可选）');
        } else if (cand.getAttribute('data-id')) {
          await addLinkTo(cand.getAttribute('data-id'));
        }
        return;
      }
      if (closest('.rele-mdel')) {
        const i = Number(closest('.rele-mdel').getAttribute('data-i'));
        if (i > 0) bar.members.splice(i, 1);
        await refreshMemberCands();
        paint();
        return;
      }
      if (closest('.rele-cancel')) { bar.pane = ''; paint(); return; }
      if (closest('.rele-submit')) { await createAssoc(); return; }
    });
    el.addEventListener('input', async (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('rele-q')) {
        bar.q = t.value; bar.sel = 0;
        await refreshCands();
        paint('.rele-q');
      } else if (t.classList.contains('rele-mq')) {
        bar.mq = t.value; bar.msel = 0;
        await refreshMemberCands();
        paint('.rele-mq');
      } else if (t.classList.contains('rele-title')) {
        bar.title = t.value;                       // 不打重绘：光标在标题里，重绘会把它顶掉
      } else if (t.classList.contains('rele-note')) {
        bar.note = t.value;
      }
    });
    el.addEventListener('keydown', (e) => {
      const t = e.target;
      const inQ = t && t.classList && t.classList.contains('rele-q');
      const inMq = t && t.classList && t.classList.contains('rele-mq');
      if (!inQ && !inMq) return;
      const list = inQ ? (bar.cands || []) : (bar.mcands || []);
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.length) { if (inQ) bar.sel = (bar.sel + 1) % list.length; else bar.msel = (bar.msel + 1) % list.length; } paint(inQ ? '.rele-q' : '.rele-mq'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.length) { if (inQ) bar.sel = (bar.sel - 1 + list.length) % list.length; else bar.msel = (bar.msel - 1 + list.length) % list.length; } paint(inQ ? '.rele-q' : '.rele-mq'); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        // 选中的必须是**当前高亮那一项**（按下标找），按"第一个候选"会静默改成别的目标 ✗
        const idx = inQ ? bar.sel : bar.msel;
        const hit = list[idx];
        if (!hit) return;
        const attr = inQ ? 'data-id' : 'data-mid';
        const row = barEl() ? barEl().querySelector('.rele-cand[' + attr + '="' + hit.id + '"]') : null;
        if (row) row.click();
      } else if (e.key === 'Escape') {
        // 输入框里的 Esc 只收起当前面板（**别冒泡出去退出整个关联视图**，那会很意外 ✗）
        e.preventDefault(); e.stopPropagation();
        bar.pane = ''; paint();
      }
    });
  }

  MM.openRelatedEditBar = openBar;
  MM.closeRelatedEditBar = closeBar;
  MM.isRelatedEditBarOpen = () => !!barEl();
  MM.relatedEditBarEdges = () => ({ out: (bar.edges.out || []).slice(), in: (bar.edges.in || []).slice() });
  MM.relatedEditBarMembers = () => bar.members.map((m) => ({ project: m.project, id: m.id, topic: m.topic }));

  MM.showRelated = showRelated;
  MM.clearRelated = clearRelated;
  /* 「缩放到刚好框住这批节点」——**唯一一份几何实现**。
   * 标签视图（`renderer/app-tag-view.js`）也用它：同一件事（算包围盒 → 一趟出 s/x/y）两处各写一份
   * 必然漂移，而这条一旦漂，"框住"就成了两种视觉口径。`insetTop` 是给顶部条带让出的高度。 */
  MM.fitToNodes = fitToNodes;
  MM.redrawRelatedLines = redrawLines;
  MM.scheduleRelatedRedraw = scheduleRedraw;
  MM.isRelatedActive = isActive;
  MM.relatedMembers = activeMembers;
  MM.REL_CLASSES = { HIT: CLS_HIT, DIM: CLS_DIM, LAYER_ID, BAR_ID: BAR_ID };
})();
