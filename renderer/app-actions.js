/* ============================================================
 * AI MindMap — 编辑操作与数据访问（app-actions.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 保存闸门 save（经 desktop.project.save → 主进程 CLI validate）
 *   2) 快照式撤销/重做：snapshot / recordHistory / undo / redo / updateHistoryButtons
 *   3) 编辑操作：addNode / addSiblingNode / addTopic / editNode / deleteNode
 *   4) 全文搜索：runSearch / renderSearchResults / jumpToNode
 *   5) 项目加载与切换：loadProjects / openProject / switchProject
 *   6) Markdown 导入导出入口：importMarkdown / exportMarkdown
 * 边界（本文件不负责）：
 *   · 序列化与渲染 → app-core.js；视图缩放/主题模式 → app-view.js
 *   · 详情框 → app-detail*.js；灯箱与预览 → app-media.js；UI 接线 → app.js
 * 所有搬迁的函数体与拆分前逐字相同；本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const $ = MM.$;
  const state = MM.state;
  const UndoStack = MM.UndoStack;

  /* ================= 全文搜索（标题/详情/图片备注/标签） ================= */
  async function runSearch(keyword) {
    const project = state.project;
    if (!project) { setStatus('请先打开项目'); return; }
    const kw = keyword || $('#search-box').value.trim();
    if (!kw) return;
    try {
      const r = await window.desktop.app.search(project.name, kw);
      renderSearchResults(r);
    } catch (err) {
      setStatus('搜索失败：' + ((err && err.message) || err), true);
    }
  }

  function renderSearchResults(r) {
    const el = $('#search-results');
    const hits = (r && r.hits) || [];
    let html = '<div class="sr-head"><span>搜索「' + escHtml(r.keyword || '') + '」共 ' + hits.length + ' 个结果</span><button class="sr-close" id="sr-close" title="关闭">✕</button></div>';
    if (!hits.length) {
      html += '<div class="sr-empty">无匹配节点（搜索范围：标题/详情/图片备注/标签）</div>';
    }
    hits.forEach((h) => {
      html += '<div class="sr-item" data-id="' + escHtml(h.id) + '">'
        + '<div class="sr-topic">' + escHtml(h.topic) + '</div>'
        + (h.matchIn ? '<div class="sr-meta">匹配：' + escHtml(h.matchIn) + '</div>' : '')
        + (h.snippet ? '<div class="sr-snippet">…' + escHtml(h.snippet) + '…</div>' : '')
        + '</div>';
    });
    el.innerHTML = html;
    el.style.display = 'block';
    el.querySelectorAll('.sr-item').forEach((item) => {
      item.addEventListener('click', () => {
        jumpToNode(item.dataset.id);
        el.style.display = 'none';
      });
    });
    const closeBtn = document.getElementById('sr-close');
    if (closeBtn) closeBtn.addEventListener('click', () => { el.style.display = 'none'; });
  }

  /* ================= 【R2 期 3 · e】同级重排的**唯一写入路径**（渲染层） =================
   * 用户原话（R2 需求 e）：**拖到第 k 位 ⇒ 改上下顺序**。
   *
   * 这条路是**唯一**的写口，形状与 `main.js:1692-1726` 既有的两个写入口逐条同源（不发明新形状）：
   *   渲染层（松手）→ `window.desktop.app.moveNodeSibling(…)`（preload 一行 invoke）
   *     → `ipcMain.handle('app:move-node-sibling')`（main.js，紧挨同族的写口）
   *     → `runCli(['move', <项目>, <id>, <父id>, '--index', k])`（**唯一实现**：
   *        `cli/commands/edit.js` 的 move → `src/tree-utils.js` 的 `moveNode`）
   *     → 写盘闸门（校验 + 原子写 + 并发重放，全在 CLI 侧）
   *     → **回读**（新顺序 + 整份项目数据）→ 渲染层 `rebuildFromJson(回读的那一份)`。
   *
   * ⚠️ 渲染层**一个字节的项目 JSON 都不写、也不自己动内存树的顺序**：
   *   · 不写盘 —— 写口只有上面那一条（不变式②）；
   *   · **也不就地 splice 内存树**：那就是**第二份 move 实现**，而且"界面上看到的新顺序"会与
   *     "盘上真的写成的顺序"分成两份可以各自漂的事实。这里一律拿**回读的那一份**重建
   *     （与 `openProject` / 撤销重做同一条路：`renderMind` 是唯一入口）⇒ 界面顺序 ≡ 盘上顺序
   *     是**构造性**的，不是"两边各算一遍碰巧一样"。
   * ⚠️ `index` 由调用方（拖动路径）**clamp 到合法区间**后再发；非法档仍由 CLI **响亮拒绝**
   *   （`--index` 上界是 P3 落地的契约校验，渲染层不复制那条判定 —— 见 main.js 该 handler 的注释）。
   * ⚠️ 回读失败（`res.data` 缺失）⇒ **明说"盘上已写、界面未同步"**，不静默重载也不假装成功
   *   （照 `app:unlink-nodes` 的 `links=null` 先例）。 */

  /** 同级重排：把 `id` 移到父 `parentId` 下的第 `index` 位（0 基、**移动完成后**的下标）。
   *  @returns {Promise<{ok:boolean, text:string, order?:string[], index?:number, topic?:string, unsynced?:boolean}>}
   *    失败一律 `ok:false` + `text` 里**带原因**（不静默 ✗）。 */
  async function reorderNodeChild(id, parentId, index) {
    const jm = state.jm;
    if (!jm || !state.project) return { ok: false, text: '还没打开项目' };
    const n = MM.adapter.getNode(jm, id);
    if (!n) return { ok: false, text: '节点不在当前视图：' + id };
    const pid = parentId || (n.parent ? n.parent.id : null);
    if (!pid) return { ok: false, text: '该节点没有父节点，无法同级重排：' + id };
    if (!(window.desktop && window.desktop.app && window.desktop.app.moveNodeSibling)) {
      return { ok: false, text: '这个版本没有写口（preload 少了 app.moveNodeSibling）—— 未改动任何数据' };
    }
    const topic = String(n.topic == null ? '' : n.topic);
    // 写前的内存快照（撤销回到这一版）；**只在写入真的成功之后**才进撤销栈 ——
    // 写失败时盘上零改动，撤销栈里多一条就等于凭空多一次"可撤销的动作"。
    const before = snapshot();
    let res;
    try {
      res = await window.desktop.app.moveNodeSibling(state.project.name, id, pid, index);
    } catch (err) {
      return { ok: false, text: '重排失败（IPC）：' + ((err && err.message) || err) };
    }
    /* 留痕：**每一次真正发出去的 (id, 父, k)**。为什么需要它（不是调试残留）：
     *   "落位预览算出来的 k" 与 "真发出去的 k" 必须**是同一个读数** —— 少了这份留痕，
     *   一条"预览说 4、发出去 0"的分叉只能靠推测，而它正是"同一逻辑两处表达"的典型形状。
     *   域 48 的乙 用它断言两次拖动发出的下标就是预览算出来的那一个（4 与 0）。
     *   ⚠️ 只增一个数组、只读，不影响任何行为；三个入口（clamp 版 / 原样版）共用这一处。 */
    MM.__reorderCalls = MM.__reorderCalls || [];
    MM.__reorderCalls.push({ id: id, parent: pid, index: index, ok: !!(res && res.ok) });
    return finishReorder(res, id, index, topic, before);
  }

  /** 【只给冒烟域 48 的取证用】**绕过界面 clamp**，把一个原样的 k 直接交给写通道。
   *  为什么需要这一个口子：本批有两件必须分开判的事 ——
   *    · **渲染层 clamp**（体验：拖出列表 ⇒ 贴到首/末）—— 由拖动路径判（域 48 丙的拖动那一段）；
   *    · **CLI 的上界校验仍是契约**（非法档必须**响亮失败**、盘上零改动）—— 它只在"真发一个越界值"
   *      的时候才看得见，而 clamp 之后的界面**永远发不出越界值** ⇒ 光靠拖动**判不到**它。
   *  ⇒ 这个函数是那条判据的**唯一注入点**，语义与 `reorderNodeChild` 逐字相同（同一处收尾逻辑
   *  `finishReorder`、同一处写通道），只是**不做 clamp**。它不是产品入口（UI 里没有任何调用点）。
   *  ⚠️ 与 `app-view.js` 的 `setLineEndpointScheme` 同一个性质：**判别力证明用**，不是第二条实现。 */
  async function reorderNodeChildRaw(id, parentId, index) {
    const jm = state.jm;
    if (!jm || !state.project) return { ok: false, text: '还没打开项目' };
    const n = MM.adapter.getNode(jm, id);
    if (!n) return { ok: false, text: '节点不在当前视图：' + id };
    if (!(window.desktop && window.desktop.app && window.desktop.app.moveNodeSibling)) {
      return { ok: false, text: '这个版本没有写口（preload 少了 app.moveNodeSibling）' };
    }
    const topic = String(n.topic == null ? '' : n.topic);
    const before = snapshot();
    let res;
    try {
      res = await window.desktop.app.moveNodeSibling(state.project.name, id, parentId, index);
    } catch (err) {
      return { ok: false, text: '重排失败（IPC）：' + ((err && err.message) || err) };
    }
    return finishReorder(res, id, index, topic, before);
  }

  /** 写通道回来之后的**共用的**那一半：判定 ok / 回读缺失 / 按回读的那一份重建 ＋ 撤销。
   *  ⚠️ 只有这一处 —— 两个入口（clamp 版 / 原样版）都在这里收尾，判据与行为不可能分叉。 */
  function finishReorder(res, id, index, topic, before) {
    if (!res || res.ok !== true) {
      return { ok: false, text: (res && res.text) || '重排失败（CLI 拒绝了这次移动）' };
    }
    if (!res.data) {
      // 盘上已经写成功了，只是回读没取到 ⇒ 如实说，并**给出重开的出路**（不静默重载 ✗）
      return { ok: true, unsynced: true, topic: topic, order: res.children || null,
        text: '盘上已写入，但**回读没取到整份数据** ⇒ 界面未同步（重开项目即可看到新顺序）' };
    }
    // 回读的那一份就是真值：整树按它重建（顺序、以及其余任何字段，都取自盘上那一份）
    rebuildFromJson(res.data);
    state.history.push(before);      // 撤销回到重排之前那一版
    updateHistoryButtons();
    // 挪过位置节点可能跑到视野外 ⇒ 选中并带回来（已在视口内时 centerOnNode 不动视野）
    if (MM.adapter.getNode(state.jm, id)) {
      MM.adapter.selectNode(state.jm, id);
      if (MM.centerOnNode) MM.centerOnNode(id);
    }
    return { ok: true, text: String(res.text || '').trim(), order: (res.children || []).slice(),
      index: index, topic: topic };
  };

  /* ================= 【R2 期 4 · f】重挂父的**唯一写入路径**（渲染层） =================
   * 用户原话（R2 需求 f）：**重挂父 —— 把 a 的子节点树变成 b 的**。
   *
   * 形状与期 3 的 `reorderNodeChild` 同族（不发明新形状），写口只有一条：
   *   渲染层（松手落到目标节点上）→ `window.desktop.app.moveNodeParent(…)`（preload 一行 invoke）
   *     → `ipcMain.handle('app:move-node-parent')`（main.js）
   *     → **先** `apply --dry-run` 预检（不过 ⇒ 一条都不写）→ `apply --ops-file`（move op →
   *        `src/tree-utils.js` 的 `moveNode` **唯一实现**，防环内建）→ 写盘闸门（CLI 侧）
   *     → **回读整份项目数据** → 渲染层 `rebuildFromJson(回读的那一份)`。
   *
   * 三道闸（设计稿 §7-P2 的定版）：
   *   ① **落位预览**（`reparentPreview`，演练副本法）：预览跑在临时副本上 ⇒ 用户项目零写入；
   *      拒绝（成环 / 父不存在）带 **CLI 的具体理由**回来，确认框给的是那段原话。
   *   ② **写前 `--dry-run` 预检**：在 main.js 的 handler 里（真实项目、本身零写入）——
   *      就算调用方绕过预览（`reparentNodeRaw`，只给域 49 取证用）也拦得住。
   *   ③ **回读重建**：`res.data` 是盘上那份真值，整树按它重建 ⇒ 界面 ≡ 盘上（构造性）。
   * ⚠️ 渲染层**一个字节的项目 JSON 都不写、也不自己动内存树的父子关系**（那就是第二份 move 实现）。
   * ⚠️ 回读失败（`res.data` 缺失）⇒ **明说"盘上已写、界面未同步"**（照 finishReorder 的先例）。 */

  /** 重挂父：把 `id`（连同它的子树）挂到 `newParentId` 下（末尾；同父内换位请走同级重排）。
   *  @returns {Promise<{ok:boolean, text:string, canceled?:boolean, unsynced?:boolean}>} */
  async function reparentNode(id, newParentId) {
    const jm = state.jm;
    if (!jm || !state.project) return { ok: false, text: '还没打开项目' };
    const n = MM.adapter.getNode(jm, id);
    if (!n) return { ok: false, text: '节点不在当前视图：' + id };
    if (!newParentId) return { ok: false, text: '没有目标父节点（落点必须是另一个节点）' };
    if (newParentId === id) return { ok: false, text: '落点就是它自己 —— 没有动任何数据' };
    const p = n.parent ? MM.adapter.getNode(jm, n.parent.id) : null;
    if (p && p.id === newParentId) {
      return { ok: false, text: '「' + String(n.topic == null ? '' : n.topic) + '」已经在「' + p.topic + '」下了 —— 要换同级位置请用「拖动到同级第几位」' };
    }
    if (!(window.desktop && window.desktop.app && window.desktop.app.reparentPreview)) {
      return { ok: false, text: '这个版本没有预览口（preload 少了 app.reparentPreview）—— 未改动任何数据' };
    }
    const topic = String(n.topic == null ? '' : n.topic);
    // ── 第一道闸：落位预览（演练副本上跑既有 --dry-run ⇒ 用户项目零写入）──
    let preview;
    try {
      preview = await window.desktop.app.reparentPreview(state.project.name, id, newParentId);
    } catch (err) {
      return { ok: false, text: '落位预览失败（IPC）：' + ((err && err.message) || err) };
    }
    if (!preview || preview.ok !== true) {
      const why = (preview && (preview.error || preview.text)) || '预览读不出"会不会成功"（三态：不假装成功）';
      return { ok: false, text: '重挂被拒绝（落位预览，未写盘）：' + why };
    }
    // ── 确认（**唯一出口 confirmFn** —— 与切项目守卫同一个打桩口）：给用户看的是 CLI 原话 ──
    const target = MM.adapter.getNode(jm, newParentId);
    const targetTopic = target ? String(target.topic == null ? '' : target.topic) : newParentId;
    const summary = '把「' + topic + '」（含 ' + subtreeCount(jm, id) + ' 个节点）挂到「'
      + targetTopic + '」下（放在末尾）。\n\n预检回执（跑在演练副本上，你的项目没有动）：\n'
      + String(preview.text || '').trim() + '\n\n确定挂过去吗？';
    if (!confirmFn(summary)) {
      return { ok: false, canceled: true, text: '已在落位预览处取消 —— 没有写入任何数据' };
    }
    // ── 第二 / 三道闸在写通道里（--dry-run 预检 + 回读重建，见 main.js 的 handler）──
    if (!(window.desktop && window.desktop.app && window.desktop.app.moveNodeParent)) {
      return { ok: false, text: '这个版本没有写口（preload 少了 app.moveNodeParent）—— 未改动任何数据' };
    }
    const before = snapshot();
    let res;
    try {
      res = await window.desktop.app.moveNodeParent(state.project.name, id, newParentId);
    } catch (err) {
      return { ok: false, text: '重挂失败（IPC）：' + ((err && err.message) || err) };
    }
    /* 留痕（与 `MM.__reorderCalls` 同一条理由）：预览/确认放行的那一对 (id, 目标父) 与真发出去的
     * 必须是同一个读数；域 49 用它对拍"确认的就是发出去的"。只增数组、只读，不影响行为。 */
    MM.__reparentCalls = MM.__reparentCalls || [];
    MM.__reparentCalls.push({ id: id, parent: newParentId, ok: !!(res && res.ok) });
    return finishReparent(res, id, newParentId, topic, before);
  }

  /** 【只给冒烟域 49 的取证用】**绕过预览与确认**，把这一对 (id, 目标父) 直接交给写通道。
   *  为什么需要这一个口子：三道闸里有两道在渲染层（预览 + 确认），一道在主进程（--dry-run 预检）。
   *  "成环必须被拒 + 盘上零改动"与"预检失败一条都不写"这两条判据要打的是**主进程那一道**，
   *  而预览在成环那一档本来就会拦下 ⇒ 光走 UI 永远看不到写通道自己的拒绝 ✗。
   *  ⇒ 这个函数是那条判据的**唯一注入点**：跳过预览/确认，直通 `moveNodeParent`（里面仍有
   *  `--dry-run` 预检）。它不是产品入口（UI 里没有任何调用点），性质与 `reorderNodeChildRaw` 相同。 */
  async function reparentNodeRaw(id, newParentId) {
    const jm = state.jm;
    if (!jm || !state.project) return { ok: false, text: '还没打开项目' };
    if (!(window.desktop && window.desktop.app && window.desktop.app.moveNodeParent)) {
      return { ok: false, text: '这个版本没有写口（preload 少了 app.moveNodeParent）' };
    }
    const n = MM.adapter.getNode(jm, id);
    const topic = n ? String(n.topic == null ? '' : n.topic) : String(id);
    const before = snapshot();
    let res;
    try {
      res = await window.desktop.app.moveNodeParent(state.project.name, id, newParentId);
    } catch (err) {
      return { ok: false, text: '重挂失败（IPC）：' + ((err && err.message) || err) };
    }
    return finishReparent(res, id, newParentId, topic, before);
  }

  /** 子树规模（确认框里那句"含 N 个节点"）—— 纯**视图数据**的计数（jsMind 节点树自带的 parent/children），
   *  不是第二份 move 实现（不碰任何字段、不写任何东西）；数不出来 ⇒ '?'（不假装知道）。 */
  function subtreeCount(jm, id) {
    const root = MM.adapter.getNode(jm, id);
    if (!root) return '?';
    let c = 0;
    (function w(n) { if (!n) return; c++; (n.children || []).forEach(w); })(root);
    return String(c);
  }

  /** 写通道回来之后的**共用的**那一半（与 finishReorder 同构）：判定 ok / 回读缺失 / 重建 ＋ 撤销。
   *  ⚠️ 只有这一处 —— 确认版与 raw 版都在这里收尾，判据与行为不可能分叉。 */
  function finishReparent(res, id, newParentId, topic, before) {
    if (!res || res.ok !== true) {
      return { ok: false, text: (res && res.text) || '重挂失败（CLI 拒绝了这次移动）' };
    }
    if (!res.data) {
      // 盘上已经写成功了，只是回读没取到 ⇒ 如实说，并**给出重开的出路**（不静默重载 ✗）
      return { ok: true, unsynced: true, topic: topic, parent: newParentId,
        text: '盘上已写入，但**回读没取到整份数据** ⇒ 界面未同步（重开项目即可看到新挂点）' };
    }
    // 回读的那一份就是真值：整树按它重建（父子关系、以及其余任何字段，都取自盘上那一份）
    rebuildFromJson(res.data);
    state.history.push(before);      // 撤销回到重挂之前那一版
    updateHistoryButtons();
    // 挪过去的节点可能跑到视野外 ⇒ 选中并带回来（已在视口内时 centerOnNode 不动视野）
    if (MM.adapter.getNode(state.jm, id)) {
      MM.adapter.selectNode(state.jm, id);
      if (MM.centerOnNode) MM.centerOnNode(id);
    }
    return { ok: true, text: String(res.text || '').trim(), parent: newParentId,
      order: (res.children || []).slice(), topic: topic };
  }

  /** 只展开目标节点的**祖先链**，而不是整棵树。
   *  原先这里用 `expand_to_depth(20)` 把所有节点一次性展开：跳到一个搜索结果后，
   *  整张图的折叠状态就没了（用户 2026-09-29 反馈"子节点应该是折叠状态"）。
   *  折叠状态是**存在数据里**的（`expanded`），导航动作不该越权把它全改掉。
   *  注：展开祖先链本身会把这条链的 expanded 置为 true（jsMind 的语义）——这是必要的，
   *  否则目标节点在视图里看不见；但它只影响这条链，不再是"全树"。 */
  function expandAncestors(jm, id) {
    const n = jm && MM.adapter.getNode(jm, id);
    if (!n) return false;
    const chain = [];
    for (let p = n.parent; p; p = p.parent) chain.push(p);
    chain.reverse().forEach((a) => { try { MM.adapter.expandNode(jm, a.id); } catch (e) { /* 容器根不支持展开 */ } });
    return true;
  }

  function jumpToNode(id) {
    const jm = state.jm;
    if (!jm || !id) return;
    expandAncestors(jm, id);
    const n = MM.adapter.getNode(jm, id);
    if (n) { MM.adapter.selectNode(jm, id); showDetail(n); }
    else setStatus('节点不在当前视图：' + id);
  }

  async function switchProject(name, selectId) {
    if (!name || name === state.project.name) return;
    await openProject(name);
    if (selectId) {
      const jm = state.jm;
      expandAncestors(jm, selectId);
      const n = MM.adapter.getNode(jm, selectId);
      if (n) { MM.adapter.selectNode(jm, selectId); showDetail(MM.adapter.getSelected(jm)); }
    }
  }

  /* ================= 「点开一条站内链接」——**全工程唯一一处**实现（`R7-0`） =================
   * 为什么必须有这一处（★真实事故，写在 `docs/RULES.md` 的 R5 行里）：详情框/关系区曾经渲染一行
   * 「🔗 跳转到 <项目>/<id>」，同项目链接**一律**走 `switchProject()`，而它开头就是
   * `name === state.project.name → return` ⇒ **点了毫无反应**：实测 `comnet` **47 条链接全是死链**。
   * 当时的处置是把那一行**删掉**（改成只由「相关知识点」承担），而"同项目要能跳"这件事**从来没有实现过**
   * —— 于是各调用点各写一份同项目分支（`app-media.js` 的「相关知识点」、`app-assoc.js` 的成员列表，
   * 两处是同一段手抄），谁也不滚到目标：目标在视野外时点一下**看起来仍然什么都没发生** ✗。
   *
   * ⇒ 落法（一处，复用既有两处实现，不新造第三套）：
   *   · **同项目**：`jumpToNode(id)`（= 既有的"选中 + 展开祖先链"唯一实现）
   *     ＋ `MM.centerOnNode(id)`（= 既有的"把节点摆进视口"唯一实现；**已完整可见时不动视野**）
   *     —— **绝不切项目**（切了对同项目是个 no-op，正是死链的根因）。
   *   · **跨项目**：`MM.switchProject(project, id)`（**既有那一处**，行为一个字节都不改）。
   * 调用点（`renderer/app-media.js` / `renderer/app-assoc.js` 的链接行点击）只调这一个函数，
   * 别再在调用点写第二份分支（结构断言见 `tests/detail-html-contract.test.js`）。
   * @param {string} project 目标节点所在项目名（空串 = 本项目）
   * @param {string} id 目标节点 id
   * @returns {boolean} 认下这次跳转 = true；参数不全 = false
   */
  function followNodeRef(project, id) {
    if (!id) return false;
    const sameProject = !project || project === (state.project && state.project.name);
    if (!sameProject) {
      MM.switchProject(project, id);      // 跨项目：既有实现（切项目 + 选中 + 展开祖先链）
      return true;
    }
    jumpToNode(id);                       // 同项目：选中 + 展开祖先链（既有实现）
    if (MM.centerOnNode) MM.centerOnNode(id);   // 且把它带进视野（已在视口内 ⇒ 不动，见 app-view.js）
    return true;
  }

  /* ================= 保存 =================
   * 「未保存改动」用**快照比对**判定，而不是到处埋 dirty 标记：
   * 只要当前序列化结果与上次落盘/载入时不同，就是有未保存改动。
   * 这样增删改、编辑详情、补链接……任何路径都自动被覆盖，不会漏挂标记点。
   */
  let lastSavedSnapshot = null;

  function isDirty() {
    if (!state.jm || lastSavedSnapshot === null) return false;
    return snapshot() !== lastSavedSnapshot;
  }

  /** 「界面已与盘上内容对齐」——把"未保存改动"的基线推进到**当前内存**。
   *
   *  "盘上变了"这件事本来有三种来源，语义必须分开：**外部改动**（别人写的）、**人的编辑**
   *  （界面上改的）、**界面已与盘上对齐**（界面自己改成了盘上那一版）。这个入口就是第三种
   *  —— 它是唯一没有名字的那个，所以单立出来 ✓。唯一调用方：AI 落盘之后按 CLI 回读的真值
   *  对齐内存（app-ask.js 的 syncMemoryAfterWriteBack）。
   *
   *  为什么必须有它（缺了就是一条实测缺陷，判据见 scripts/smoke/38-ai-落盘.js 的 ②）：
   *  AI 落盘走的是 CLI（渲染层**外部**改盘），于是"把内存对齐到盘上那一版"这件事本身会被
   *  isDirty() 判成**人的编辑** ⇒ 紧接着的按盘重读会以"有未保存改动、不许覆盖人的编辑"为由
   *  **拒绝采纳** ⇒ 新子节点不出现在导图上、详情也不更新；而保存闸门那边（版本号已经由
   *  `refreshVersionIfOwnWrite` 推进到落盘后那一版）又认为"没有外部改动" ⇒ 下一次整树写回
   *  把刚落盘的 qa / 详情 / 子节点**静默抹掉**，save() 还返回 true。
   *
   *  ⚠️ 调用方**必须先确认当前内存真的等于盘上那一版**（同步完成、且界面本来没有别的未保存改动）：
   *  用户的未保存改动一旦被这一步说成"已保存"，随后的重读就会拿盘上那份盖掉人的编辑 ——
   *  那比"少合并一次"坏得多 ✗。 */
  function markAlignedBaseline() {
    if (!state.jm || lastSavedSnapshot === null) return false;
    lastSavedSnapshot = snapshot();
    reportUiState();   // dirty 归零要立刻让侧栏 AI 看到（与 save() 同一口径）
    return true;
  }

  /** 未决的并发冲突：等用户选择（headless 下没人能选 ⇒ 只报状态、不弹模态框） */
  let pendingConflict = null;
  const conflictWho = (res) => ((res.detail && res.detail.length)
    ? res.detail.join('、') : (res.conflicts || []).join('、') || '（未指名）');

  /**
   * 保存。`opts.onConflict === 'theirs'` 用于"用磁盘上的版本"这个选择（见 `resolveConflict`）。
   *
   * 并发（多路同时编辑）时分三种：
   *   · 两边改的对象**不相交** ⇒ 主进程**自动合并**，这里把内存同步到"实际落盘的那份"；
   *   · **相交** ⇒ 主进程不写盘、回报冲突对象名 ⇒ **记下未决冲突**并报状态；
   *     交互环境再弹一次确认让用户二选一（**只丢弃冲突对象上的改动**，或干脆不保存）；
   *   · 保存期间又被插队 ⇒ 主进程未写盘（`RACE_RETRY`），让用户再点一次。
   * 关键：**不再"一律拒绝并要求重开项目"** —— 那会把用户的全部未保存改动一起丢掉。
   *
   * ⚠️ **headless（冒烟/自动化）下绝不弹 `window.confirm`**：模态框没人回答会**把整轮卡死**
   * （实测踩过：`SMOKE GUARD TIMEOUT — force exit`）。所以主进程会回一个 `headless` 标志。
   */
  async function save(opts) {
    const epoch0 = projectEpoch;   // 保存期间项目被切走 ⇒ 合并回来的那份数据不再用于重建内存
    const data = serializeTree();
    if (!data) return false;
    try {
      const res = await window.desktop.project.save(state.project.file, data, opts);
      if (res && res.ok === false) {
        if (res.code === 'MERGE_CONFLICT') {
          pendingConflict = res;
          const who = conflictWho(res);
          /* v0.20：不再用"二选一 confirm"（它只给**对象名**，看不到内容 —— 用户原话
           * "就算打架也要可以预览冲突内容"）⇒ 换成**冲突面板**：逐对象显示两边内容 + 同一组两个选择。
           * ⚠️ headless（冒烟/自动化）下**绝不弹模态框**：没人回答会把整轮卡死（实测踩过
           * `SMOKE GUARD TIMEOUT — force exit`）。面板照常亮出内容（那正是"看得见"的证据），
           * 只是不拦着程序化的 `MMApp.resolveConflict()` —— 选择语义一个字没变。 */
          showConflictPanel(res);
          setStatus('并发冲突：已拦下未写盘（冲突对象：' + who + '）'
            + (res.headless
              ? ' —— 自动化环境不弹确认框，用 resolveConflict() 选择'
              : ' —— 见冲突面板：用盘上 / 保留我的'), true);
          return false;
        }
        setStatus('保存失败：' + ((res && res.message) || '未知原因'), true);
        return false;
      }
      pendingConflict = null;
      closeConcPanel();                    // 保存成功 ⇒ 冲突面板没有存在的理由了
      if (res && res.merged) {
        // 内存必须跟上**实际落盘的那份**（合并后，冲突对象上取的是盘上版本）
        if (res.data && epoch0 === projectEpoch) rebuildFromJson(res.data);
        if (res.version && epoch0 === projectEpoch && state.project) state.project.version = res.version;
        lastSavedSnapshot = snapshot();
        /* 合并结果是**主进程合成的**，而回执不带 `data` ⇒ 内存**不一定**等于盘上（外部那几个对象
         * 还没进内存）⇒ 清掉"自己写的"收据：随后那条 `project:disk-changed` 必须照旧走采纳路径，
         * 否则外部的新节点不会出现在导图上，而下一次保存会把盘上那份**静默抹掉** ✗✗
         * （见 `selfWrittenVersion` 头顶那一段）。 */
        selfWrittenVersion = '';
        setStatus('已保存 ' + new Date().toLocaleTimeString() + '（已与外部改动自动合并）');
      } else {
        if (res && res.version && state.project) state.project.version = res.version;
        lastSavedSnapshot = JSON.stringify(data);
        /* 【保存后不再折回】落盘的就是**这份内存**（`data` 就是上面 `serializeTree()` 出来的那份）
         * ⇒ 记下收据：随后那条 `project:disk-changed` 若报的就是这个指纹，说明"盘上 = 内存"，
         * 没有任何东西要采纳 ⇒ 不重渲染（视图归一）⇒ 展开态/偏移/位置留在原处 ✓ */
        selfWrittenVersion = (res && res.version) || '';
        setStatus('已保存 ' + new Date().toLocaleTimeString());
      }
      closeConcBanner();                   // 保存把两边都落盘了 ⇒ 外部改动提示也该消失
      diskDiff = null;
      reportUiState(); // 保存 = dirty 归零，必须让侧栏 AI 知道（否则它会一直以为界面脏着）
      return true;
    } catch (err) {
      setStatus('保存失败：' + ((err && err.message) || err), true);
      return false;
    }
  }

  /**
   * 解决未决的并发冲突 —— 界面按钮与冒烟断言都走它（同一份语义）。
   *   `'theirs'` ⇒ 用磁盘上的版本重试保存（冲突对象取盘上那份，**其它改动照样落盘**）；
   *   其它值     ⇒ 保留我的改动，本次不保存（清掉未决状态）。
   *   v0.20：冲突面板的两个按钮点下去就走这里（面板自己不写盘 —— 写盘仍然只有 save 那一条路）。
   */
  async function resolveConflict(choice) {
    closeConcPanel();                    // 选择即意味着这次未决状态到此为止（面板不该再挂着）
    if (!pendingConflict) return false;
    if (choice !== 'theirs') {
      setStatus('已保留你的改动，未保存', true);
      pendingConflict = null;
      return false;
    }
    return await save({ onConflict: 'theirs' });
  }
  function hasPendingConflict() { return !!pendingConflict; }

  /* ================= 关导图页（**真关**：交给主进程把这一页从内存里卸掉） =================
   * 核心纪律：**先拦未保存编辑**（不许省 —— 丢改动是本工程最重的损害类别）。
   * 顺序（每一步都有理由）：
   *   ① 有脏改动 ⇒ 弹「保存后关闭 / 取消」；
   *   ② 选「保存后关闭」⇒ 走**既有** `save()`（含并发冲突保护：撞同一对象时它自己会再问一次，
   *      或回报 RACE_RETRY）⇒ **只有真保存成功**才继续；否则留在导图页（宁可不关，也不丢 ✗）；
   *   ③ 然后才让主进程卸载这一页（`desktop.dsh.closeMapPage()` ⇒ 主窗口导航到占位页）。
   * 主进程做不了这个判断：脏标记只活在渲染层内存里（页面一卸载连它一起没了）⇒ 必须在这之前问。
   * ⚠️ headless（冒烟/自动化）下**不能真弹 `window.confirm`**：没人回答会把整轮卡死（实测踩过）
   *    ⇒ `setConfirmStub()` 给自动化换掉确认框（默认就是 window.confirm ✓）。
   *
   * ⚠️⚠️ **本模块里每一处"同步确认框"都必须走 `confirmFn`，不许直接写 `window.confirm`**（一处实现）：
   *   2026-10-14 实测踩到过一次 —— 切项目的守卫（`confirmDiscardIfDirty`）当时直接调 `window.confirm` 本体，
   *   而 `setConfirmStub` 只换掉了这个文件里另一个调用点 ⇒ 配了桩也没用，无头跑里"界面脏 + 切项目"
   *   把**渲染层的 JS 线程整个卡住**（`executeJavaScript` 永不返回、整轮冒烟连守卫到期前的输出都没有，
   *   只能强杀 ✗✗）。桩是给自动化用的**唯一**入口，漏掉一处 = 那个入口在无头下不可用。 */
  let confirmFn = (msg) => window.confirm(msg);
  function setConfirmStub(fn) { confirmFn = (typeof fn === 'function') ? fn : ((msg) => window.confirm(msg)); }

  async function closeMapPage() {
    if (isDirty()) {
      const saveFirst = confirmFn(
        '有未保存的编辑：关闭导图页会把这一页从内存里卸掉。\n\n'
        + '点「确定」= 先保存，然后关闭（保存被拦下就不关）\n'
        + '点「取消」= 取消关闭，导图页留着');
      if (!saveFirst) { setStatus('已取消关闭导图页（改动还在）'); return false; }
      const saved = await save();
      if (!saved) { setStatus('保存未完成 ⇒ 导图页没有关闭（避免丢改动）', true); return false; }
    }
    const r = await window.desktop.dsh.closeMapPage();
    if (!r || !r.ok) {
      setStatus('关闭导图页失败：' + ((r && r.reason) || '未知原因'), true);
      return false;
    }
    return true;
  }

  /** 有未保存改动时询问用户；返回 false 表示用户选择取消。
   *  ⚠️ 走 `confirmFn`（**不是** `window.confirm` 本体）：这是"切项目/重开项目会丢掉未保存改动"那道
   *  守卫，无头跑里同样没人回答模态 —— 直接调本体就会把渲染层 JS 线程卡死（见上面那一大段说明）。
   *  真机行为一个字没变：`confirmFn` 的缺省实现就是 `(msg) => window.confirm(msg)`。 */
  function confirmDiscardIfDirty(actionLabel) {
    if (!isDirty()) return true;
    // Electron 渲染层可用同步 confirm（本项目无对话框封装，且这是打断性确认，同步更简单可靠）
    return confirmFn('当前有未保存的改动，' + (actionLabel || '继续') + '将丢失这些改动。\n\n要放弃改动吗？\n（点「取消」返回并先保存）');
  }

  /* ================= 撤销/重做（快照式） =================
   * 语义：每次结构修改**之后**把新状态压入历史栈（push 修改后快照）；
   * undo() 弹出栈顶返回"上一个状态"，redo() 从重做栈恢复。
   */
  function snapshot() { return JSON.stringify(serializeTree()); }

  function recordHistory() { state.history.push(snapshot()); updateHistoryButtons(); }

  function undo() {
    const prev = state.history.undo();
    if (prev !== null) { rebuildFromJson(JSON.parse(prev)); updateHistoryButtons(); setStatus('已撤销'); }
  }
  function redo() {
    const next = state.history.redo();
    if (next !== null) { rebuildFromJson(JSON.parse(next)); updateHistoryButtons(); setStatus('已重做'); }
  }
  function updateHistoryButtons() {
    $('#btn-undo').disabled = !state.history.canUndo();
    $('#btn-redo').disabled = !state.history.canRedo();
    reportUiState();
  }

  /* ================= 界面状态上报（v0.16.6「写前协调」的可执行版本） =================
   * 侧栏 AI 没有 Electron 桥，唯一能力面是 shell —— 所以"界面有没有未保存编辑"
   * 这个信号必须落到它能读的地方：主进程把它写成 projects/<项目>/.ui-state.json，
   * 侧栏 AI 用 `node cli/mm-cli.js ui-state --json` 读（src/ui-state.js 有完整来龙去脉）。
   *
   * 上报口径：只在**结论变化**时推（项目名 / dirty / **所见版本**变化）。dirty 本身要 snapshot()
   * 全量序列化一次，逐次编辑都上报会把序列化翻倍；而调用点 updateHistoryButtons()
   * 已经覆盖了所有会改变结论的路径（编辑→recordHistory、保存、撤销重做、开项目、
   * 外部磁盘变更重读）。
   *
   * v0.20：多上报一个 `seenVersion`（界面**所见内容**对应的盘上版本）——
   * 主进程把它与闸门基线一起写进 `.ui-state.json`，读方（侧栏 AI/CLI `ui-state --json`）
   * 于是能答"界面所见落后盘上多少"。**为什么键里也要带它**：静默同步（外部改盘、界面不脏）
   * 之后 dirty 没变、项目没变，但所见内容换了一版 —— 不带它这次上报会被"去重"吞掉 ✗。 */
  let lastReportedUiState = null;
  function reportUiState() {
    if (!state.project) return;
    const dirty = isDirty();
    const seenVersion = state.project.version || '';
    const key = state.project.name + '|' + dirty + '|' + seenVersion;
    if (key === lastReportedUiState) return;
    lastReportedUiState = key;
    if (window.desktop && window.desktop.app && window.desktop.app.uiState) {
      window.desktop.app.uiState({ project: state.project.name, dirty, seenVersion });
    }
  }

  /* ================= 编辑操作（供 editor.js / 菜单调用） =================
   * ⚠️ 本段的四个"结构操作"（加子 / 加同级 / 删 / 改）**实现在 `renderer/editor.js`**，
   *    它们是**主窗与草稿图窗（`DM`）共用的同一份代码**（台账 `W11 a–e` 的 `b`）；
   *    本文件只保留**主窗才有的那部分**：撤销栈（`recordHistory`）、项目级删除预检
   *    （关联成员 / 入边链接 / CLI 剪枝）、顶层主题模式切换。两者之间的接线在文件末尾的
   *    `mainEditorHost()`（**宿主接口**：模块问"这次编辑落到哪里"，本文件回答）。
   *    定题见 `.review/20261020-editor-复用/00-定题.md`。 */

  /** 取编辑器实例（**唯一入口**）：没有就**响亮**说，不静默什么都不做。 */
  function editor() {
    const e = window.MMEditor;
    if (!e) { setStatus('编辑器模块还没就绪（window.MMEditor 不存在）—— 请重开界面', true); return null; }
    return e;
  }

  /** 在 `parentId` 下加一个子节点（不给 = 当前选中）。实现见 `renderer/editor.js` 的 `addChild`。 */
  function addNode(parentId) {
    const e = editor();
    if (!e) return null;
    return e.addChild(parentId);
  }

  /** 加同级。实现见 `renderer/editor.js` 的 `addSibling`（那里记着"落点插不进去"的已知缺陷）。 */
  function addSiblingNode(id) {
    const e = editor();
    if (!e) return null;
    return e.addSibling(id);
  }

  /** 新增顶层主题：「凭空」加一个不选父节点的节点，直接挂在根节点下。
   *  同时开启主题模式 —— 于是它与其它顶层主题互相独立（容器根隐藏、连线跳过）。
   *  ⚠️ 主题模式这一跳是**主窗特有**的（草稿窗没有结构轴）⇒ 留在本文件；
   *     节点本身仍然由 `editor.js` 的 `addChild` 造（同一个实现、同一套顺序）。 */
  function addTopic() {
    const jm = state.jm;
    const root = jm && MM.adapter.getNode(jm, 'root');
    if (!root) { setStatus('导图尚未就绪'); return; }
    if (state.rootMode !== 'themes') {
      state.rootMode = 'themes'; // 顶层主题 = 独立主题
      applyRootModeVisual(jm, true);
    }
    const e = editor();
    if (!e) return;
    e.addChild('root', { topic: '新主题' });
  }

  function editNode(id) {
    const e = editor();
    if (!e) return;
    return e.editNode(id);
  }

  /** 收集一棵 jsMind 子树里的全部节点 id（删除时要用它找出被引用的关联成员/链接目标） */
  function subtreeIds(node) {
    const out = [];
    (function walk(n) { if (!n) return; out.push(n.id); (n.children || []).forEach(walk); })(node);
    return out;
  }

  /** 同项目里指向这些节点的链接（谁指向我）。数据在树里，读一下即可；
   *  真正的"清理"仍由 CLI 决定与执行，这里只为确认框给出准确的影响面。 */
  function inboundLinks(ids, proj) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      (n.links || []).forEach((l) => {
        if (l && l.project === proj && ids.indexOf(l.id) >= 0) out.push({ node: n.id, target: l.project + '/' + l.id, caption: l.caption });
      });
      (n.children || []).forEach(walk);
    };
    walk(MM.adapter.getRoot(state.jm));
    return out;
  }

  /**
   * 删节点**之前**的项目级预检 —— 这是**主窗独有**的那一半（草稿窗没有项目、契约上也不可能带引用），
   * 模块（`renderer/editor.js`）通过 `host.beforeDelete(node)` 问它。契约（与模块里的 `deleteNode` 成对）：
   *   `{allow:true, statusText}`         ⇒ 可以删（`statusText` 是删完要显示的那句）
   *   `{allow:false, statusText, isErr}` ⇒ 不许删（模块负责显示这句，且**不删**）
   * 每一步顺序都不能动：先读盘上的 assoc / 入边 → 有引用就**问一句** → CLI 在**磁盘上**剪 →
   * 再同步**内存树**里的入边链接 → 最后才允许删节点。剪失败就不删（绝不留下"保存不了"的中间状态）。
   *
   * 关联笔记：被删（子）树可能是关联成员。若照原样保存，落盘数据就带"悬挂成员"，
   * 而 project:save 是**校验闸门**（写盘前跑 CLI validate）→ 保存会被拒；
   * 界面又没有改成员的入口，等于把用户卡死。所以先问一句。
   *
   * 关键：清理必须**在磁盘上**做（走 IPC → CLI assoc-prune），不能在内存里剪完
   * 指望保存一起写回 —— `project:save` 在载荷里没有 assoc 时会从磁盘取回
   * （那是为了防止 AI 刚写的笔记被界面保存抹掉），于是内存里剪掉的成员会**原地复活**，
   * 悬挂成员依旧存在、保存照样被拒（实测）。assoc 的作者是 CLI，写就只经 CLI。
   */
  function deletePrecheck(node) {
    return new Promise((resolve) => {
      const proj = state.project && state.project.name;
      if (!proj || !(window.desktop.app && window.desktop.app.assoc && window.desktop.app.assocPrune)) {
        resolve({ allow: true });
        return;
      }

      window.desktop.app.assoc(proj).then((r) => {
        const list = (r && r.raw) || [];
        state.assoc = list;                    // 顺带与磁盘对齐（assoc 的真值在磁盘）
        const ids = subtreeIds(node);
        const affected = list.filter((a) => (a.members || []).some((m) => m && m.project === proj && ids.indexOf(m.id) >= 0));
        const inLinks = inboundLinks(ids, proj);
        if (!affected.length && !inLinks.length) { resolve({ allow: true }); return; }

        const lines = ['「' + node.topic + '」被别处引用：'];
        if (affected.length) lines.push('· ' + affected.length + ' 篇关联笔记：' + affected.map((a) => a.title || a.id).join('、'));
        if (inLinks.length) lines.push('· ' + inLinks.length + ' 条指向它的链接：' + inLinks.map((x) => x.node).join('、'));
        lines.push('');
        lines.push('删除节点会留下悬空引用（保存会被校验闸门拒绝），故需一并清理'
          + (affected.length ? '（清到只剩一个成员的关联会整篇删除）' : '') + '。');
        lines.push('要一起清理吗？点「取消」则先不删。');
        // 同一处实现（见 `confirmFn` 那一段）：这里**也不许**直接调 `window.confirm` 本体
        if (!confirmFn(lines.join('\n'))) {
          resolve({ allow: false,
            statusText: '已取消删除：「' + node.topic + '」被 ' + (affected.length + inLinks.length) + ' 处引用' });
          return;
        }

        // 先清理磁盘，成功后再删节点。清理失败就不删 —— 否则会留下保存不了的坏状态。
        window.desktop.app.assocPrune(proj, ids).then((p) => {
          if (!p || !p.ok) {
            resolve({ allow: false, isErr: true,
              statusText: '引用清理失败，已取消删除：' + ((p && p.text) || '未知错误')
                + '（也可在命令行执行 assoc-prune / links-prune ' + proj + ' --nodes ' + ids.join(',') + '）' });
            return;
          }
          if (Array.isArray(p.raw)) state.assoc = p.raw;   // 用磁盘结果同步内存
          // 同步**内存树**里的链接（与 app-audit.js 补链后的同步是同一个道理，方向相反）：
          // 节点树由渲染层拥有，磁盘上刚被 CLI 剪掉的链接若不从内存里也剪掉，
          // 下一次 `save()`（serializeTree 写内存树）会把悬挂链接原样写回磁盘 ——
          // 保存又被校验闸门拒绝（实测）。只删内存里指向被删节点的链接，不碰其他。
          const dead = new Set(ids);
          const stripInbound = (n) => {
            if (!n) return;
            if (Array.isArray(n.data && n.data.links) && n.data.links.length) {
              const kept = n.data.links.filter((l) => !(l && l.project === proj && dead.has(l.id)));
              if (kept.length !== n.data.links.length) {
                if (kept.length) n.data.links = kept; else delete n.data.links;
              }
            }
            (n.children || []).forEach(stripInbound);
          };
          stripInbound(MM.adapter.getRoot(state.jm));
          /* 只把"清理了多少"交回去，**文案由模块自己拼** —— 这样"删前要先取好标题"这件事
           * 只有一个责任点（`renderer/editor.js` 的 `deleteNode`：它把 `topic` 在 removeNode
           * **之前**取好，见那里的注释）。改前这里写着"那样才与改前逐字节一致"，而改前那一版
           * 正是先删再拼、拼出 `已删除：undefined` 的版本（2026-10-22 修掉并补了冒烟断言）。 */
          resolve({ allow: true, cleanup: { affected: affected.length, inLinks: inLinks.length } });
        }).catch((err) => {
          resolve({ allow: false, isErr: true, statusText: '引用清理失败，已取消删除：' + ((err && err.message) || err) });
        });
      }).catch((err) => {
        // 关联读不出来就不敢删：磁盘上可能有引用，删了会留下保存不了的坏状态
        resolve({ allow: false, isErr: true,
          statusText: '关联笔记读取失败，已取消删除：' + ((err && err.message) || err)
            + '（若确认无引用，可用 remove ' + proj + ' ' + node.id + ' --clean-assoc --clean-links）' });
      });
    });
  }

  /** 删节点：根节点守卫与"真的删"在 `renderer/editor.js`（两窗同一份实现），
   *  项目级预检在本文件（`deletePrecheck`）—— 模块删之前会**先问它**。 */
  function deleteNode(id) {
    const e = editor();
    if (!e) return null;
    return e.deleteNode(id);
  }

  /* ================= 项目加载 ================= */
  async function loadProjects() {
    try {
      const projects = await window.desktop.projects();
      const sel = $('#project-select');
      sel.innerHTML = '';
      projects.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + (p.meta && p.meta.name ? '（' + p.meta.name + '）' : '');
        sel.appendChild(opt);
      });
      if (projects.length) {
        // ⚠️ 这里**不能**无条件跳到第一个项目：本函数同时服务于"启动时装载"和
        // "外部改动后刷新列表"（`menu:project-changed`）。原来的 `sel.value = projects[0]; openProject(...)`
        // 会在**任何一次列表刷新**时把界面拽回第一个项目 ✗ —— 实测：导入新项目后刚切过去，
        // 1.5 秒内又被拽回旧项目（时间线：`openProject 返回 true cur=两本书` → `1.5s 后 cur=comnet`）。
        // ⇒ 保留当前选中的项目；**只有当前没有项目**时才自动打开第一个 ✓
        const keep = state.project && projects.some((p) => p.name === state.project.name)
          ? state.project.name : null;
        // 「导图页被卸载后重开」这条路上，主进程会武装一个 **boot 项目**（上次那个）——
        // 页面自己不知道原来是哪个项目（内存随页面一起没了 ⇒ 只能问主进程 ✓）。
        // 正常启动时它是 null ⇒ 仍然开 projects[0]（**启动行为不变** ✓）；
        // 记着的项目已经不存在时同样退回 projects[0]（不报错、不假装成功 ✓）。
        let bootName = null;
        try {
          const b = (window.desktop.dsh && window.desktop.dsh.bootProject)
            ? await window.desktop.dsh.bootProject() : null;
          bootName = (b && b.project) ? b.project : null;
        } catch (e) { bootName = null; }
        const fallback = (bootName && projects.some((p) => p.name === bootName))
          ? bootName : projects[0].name;
        sel.value = keep || fallback;
        if (!keep) await openProject(fallback);
      } else {
        $('#empty-hint').style.display = 'flex';
      }
    } catch (err) {
      setStatus('项目加载失败：' + ((err && err.message) || err), true);
    }
  }

  /** 载入世代：**切换项目开始时** +1。
   *  为什么需要：两处异步路径（外部改盘自动重读、保存后被自动合并的重建）都是
   *  "先 await 读盘、再 renderMind"，中间那个窗口里项目可能已经切走 ⇒ 迟到的 renderMind
   *  会把**旧项目的树**盖到新项目上（全量冒烟实测：project.name 已是 layout-probe，
   *  内存树/metaLayout 却还是 comnet 的 ✗ ⇒ 再保存就会把错树写进新项目 ⇒ 数据安全）。
   *  判据：await 之前记下世代，回来时不一致 ⇒ 丢弃这份过期数据（等价于"这次自动重读没发生"）。*/
  let projectEpoch = 0;

  async function openProject(name) {
    // 打开**另一个**项目会从磁盘重建内存树 + 重置撤销栈 → 未保存的改动会丢。
    // 守卫放在这里而不是 switchProject：工具栏下拉框是直接调 openProject 的，
    // 只守一个入口会漏掉另一个（两条路径都必须过这道确认）。
    if (state.project && state.project.name !== name && isDirty()) {
      if (!confirmDiscardIfDirty('切换项目')) {
        const sel = $('#project-select');
        if (sel) sel.value = state.project.name;   // 选择框回退，避免界面与实际不一致
        return false;
      }
    }
    try {
      projectEpoch++;   // 切换开始 ⇒ 在途的旧读盘结果一律作废（见 projectEpoch 说明）
      const r = await window.desktop.project.read(name);
      state.project = { name, file: r.file, version: r.version };
      /* 【R5 · R2 期 5】结构轴（树 / 复杂）是**会话级**的：启动 / 切项目一律回树结构。
       * 只复位那一个内存读数（app-view.js 的 resetStructureMode）—— 不写盘、不碰关系层状态。 */
      if (MM.resetStructureMode) MM.resetStructureMode();
      state.history = new UndoStack(50);
      renderMind(r.data);
      state.history.push(snapshot()); // 初始状态入栈（撤销栈基座）
      lastSavedSnapshot = snapshot();  // 刚载入 = 与磁盘一致（未保存改动基线）
      updateHistoryButtons();
      // 命令面板缓存的是「上一个项目的节点清单」，切项目必须失效，
      // 否则会搜到已关闭项目的节点、点了也定位不到（跨项目缓存错配）。
      if (MM.invalidatePaletteCache) MM.invalidatePaletteCache();
      // 同步工具栏下拉框（程序化打开时保持界面一致）
      const sel = $('#project-select');
      if (sel && Array.prototype.some.call(sel.options, (o) => o.value === name)) sel.value = name;
      // 「边聊边编辑」：订阅该项目文件的磁盘变更（侧栏 AI 经 CLI 改盘后实时感知）
      if (window.desktop && window.desktop.project && window.desktop.project.watch) {
        window.desktop.project.watch(r.file);
      }
      return true;
    } catch (err) {
      setStatus('打开失败：' + ((err && err.message) || err), true);
      return false;
    }
  }

  /* ================= 外部编辑实时感知（v0.16.1「边聊边编辑」） =================
   * 侧栏 AI 经 CLI 改盘上 JSON → 主进程 fs.watch 防抖通知（或**窗口获得焦点时**由主进程
   * 只读比对后补发同一条事件，见 main.js 的 onWatcherFocus）→ 这里重读。
   * 冲突规则（数据安全第一）：
   *   · 界面**无**未保存改动 → 静默重读重建（AI 的编辑实时出现在导图上）；
   *   · 界面**有**未保存改动 → **绝不覆盖人的编辑**（不重读、不写盘），但 v0.20 起
   *     **不再只打一行状态**：只读探视盘上（`project:peek`，无副作用）→ 亮出常驻可点的
   *     banner「外部已改盘上内容（N 处）—— 点这里看差异」→ 打开**只读**两侧差异面板。
   *     用户原话："AI 编辑的我看不到 ✗ … 就算打架也要可以预览冲突内容 ✓"。
   *     ⚠️ 保存**不再**是"覆盖外部"：保存走三方合并（`project:save` 的 mergeTrees），
   *     只有撞在同一对象上才会拦下。旧注释写的"保存=覆盖外部 / 还原视图手动重开=采纳外部"
   *     与实现矛盾（用户 2026-10-13 报的就是这类过时文案），已按实现改正。 */
  let reloadingFromDisk = false;

  /* ================= 「盘上这一版就是界面内存的那一份」（保存后不再折回） =================
   *
   * `selfWrittenVersion` = 本界面**整树写回**成功时记下的那个盘上版本指纹。它与 `project:peek`
   * 回来的 `version`、保存闸门比的那一版**同一个值空间**（`src/data-store.js` 的 `versionOfText`）。
   *
   * 它要回答的问题只有一个：随后那条 `project:disk-changed` **有没有东西要采纳**？
   * 判据 = `peek` 回来的盘上指纹 === 它（见 `onProjectDiskChange`）—— 相等即"盘上这些字节就是本界面
   * 自己从内存里写下去的那一份" ⇒ 内存与盘上**同一份内容**（同一个内容指纹）⇒ 采纳 = 把同一份东西
   * 再渲染一遍；而 `renderMind` 会**重建** jsMind（视图归一 = 只展开根 · `fdView` 复位 ·
   * 偏移两桶清空 · 撤销栈重置）⇒ 用户刚摆好的展开态与位置当场折回 ✗（实测：写域 46 时探针量到
   * "目标节点本身不在屏上"）。
   *
   * 为什么不拿 `state.project.version`（上报给侧栏的 seenVersion）当判据：**自动合并**那一档
   * （`res.merged`）的落盘内容是**主进程合成的**，渲染层没有把它装回内存（`project:save` 的回执
   * 不带 `data` ⇒ 下面 `if (res.data …)` 那一跳不成立）⇒ 那一刻 seen == 盘上，而**内存 ≠ 盘上**
   * ⇒ 拿 seen 当判据就会把"外部新节点还没进内存"这件事一起跳过去 ✗✗（紧接着的一次保存会把盘上
   * 那份静默抹掉 —— 本工程最重的损害类别）。所以只认"内存**真的就是**落盘那一份"的写回：
   * 非合并保存**写**它、自动合并保存**清空**它（清空 ⇒ 随后的按盘重读照旧走既有采纳路径 ✓）。
   *
   * 别的来源一律**不写**它 —— 尤其 AI 落盘那条路（`app-ask.js` 对齐内存后 `MM.requestReread()`：
   * 它的盘上版本会与闸门基线相等，但**不等于**这里记的收据）必须照旧采纳，否则新子节点不会出现 ✗。
   * 它也不需要"过期清理"：任何外部写入都会让 peek 回来的指纹 ≠ 它 ⇒ 判据自然失效 ✓。 */
  let selfWrittenVersion = '';

  /** 最近一次 `project:disk-changed` 的**判定留痕**（`{seq, filename, kind, seen, onDisk}`；仅排查/断言用）。
   *
   *  为什么留痕：判据"视图没折回"有一条**空转形态** —— 那条事件要是根本没来（或没走到那一档），
   *  "视图没变"照样为真，看着全绿、其实什么都没验 ✗。留痕让断言能区分
   *  `own-write`（自己写的 ⇒ 不重渲染）与 `adopted`（真外部改动 ⇒ 照旧采纳），
   *  并且能证明"这一次判定真的发生过"（`seq` 前进）。`kind` 的取值：
   *    `own-write` 自己写的那一份（不重渲染）· `adopted` 采纳了盘上这一版（重渲染）·
   *    `dirty` 有未保存编辑（只提示、不覆盖）· `switch` 期间切了项目（丢弃）·
   *    `unreadable` 探视不到盘上内容 · `busy` 上一次重读还没跑完。 */
  let lastDiskChange = null;
  let diskChangeSeq = 0;
  function noteDiskChange(filename, kind, onDisk) {
    lastDiskChange = {
      seq: ++diskChangeSeq, filename: String(filename || ''), kind: kind,
      seen: (state.project && state.project.version) || '', onDisk: onDisk || null
    };
    return lastDiskChange;
  }
  function getLastDiskChange() { return lastDiskChange ? Object.assign({}, lastDiskChange) : null; }

  /**
   * 脏分支的可见性（v0.20）：**只读**落一份差异快照 + 亮 banner。
   * 三条不许越的线：
   *   ① **不重读树、不写盘、不动内存**（有未保存编辑时"绝不覆盖人的编辑"这条安全声明不变）；
   *   ② 只用 `project:peek`（无副作用）取盘上内容 —— **不许用 `project:read`**：那条会把主进程
   *      "界面读到哪一版"推进到盘上这一版，界面随后保存就会被判成"没有外部改动"⇒
   *      **静默覆盖** AI 刚写的内容（本工程最重的损害类别 ✗）；
   *   ③ 盘上内容与基线**一致**时不亮 banner（fs.watch 会把点文件/重写/噪声都报上来）——
   *      没有真差异就必须说"一致"，否则是制造假警报 ✗。
   * @returns {Promise<object|null>} 差异快照；`null` = 读不到（调用方要**如实**说不确定）
   */
  async function refreshDiskDiff() {
    const name = state.project && state.project.name;
    const api = window.desktop && window.desktop.project;
    if (!name || !api || !api.peek) return null;
    let r = null;
    try { r = await api.peek(name); } catch (err) { r = null; }
    if (!r || !r.ok || !r.base) return null;
    const cc = window.MMConcurrency;
    if (!cc || typeof cc.diffRows !== 'function') {
      // 响亮：渲染层没加载并发核心时**不许**退回"自己算一套差异"（那等于第二份实现）
      setStatus('差异预览不可用：渲染层没有加载 src/concurrency.js（index.html 的脚本清单）', true);
      return null;
    }
    const base = r.base;                                    // 界面读到的那一份（与保存闸门同一份基线）
    const mine = cc.inheritAssoc(serializeTree(), base);     // assoc 缺省规则与 mergeTrees 同一实现
    const theirsChanged = cc.changedKeys(base, r.data);      // 外部在盘上改了什么
    const mineChanged = cc.changedKeys(base, mine);          // 我在界面上改了什么
    diskDiff = {
      project: name, version: r.version, baseVersion: r.baseVersion,
      seenVersion: (state.project && state.project.version) || '',
      mine: mine, theirs: r.data,
      mineKeys: Array.from(mineChanged).sort(),
      theirsKeys: Array.from(theirsChanged).sort(),
      clashes: cc.intersection(mineChanged, theirsChanged)
    };
    return diskDiff;
  }

  /** banner 的**唯一渲染**（只在真有外部改动时亮；文案里带条数，别让人去猜） */
  function showConcBanner(text) {
    const b = document.getElementById('conc-banner');
    if (!b) return false;
    document.getElementById('conc-banner-text').textContent = text;
    b.style.display = 'flex';
    return true;
  }
  function closeConcBanner() {
    const b = document.getElementById('conc-banner');
    if (b) b.style.display = 'none';
  }

  /* ---------------- 只读面板（差异预览与冲突面板**共用**：只差"行从哪来 + 底部按钮"） ----------------
   * 两处都要的东西一模一样（标题/来源与版本前缀/逐对象两边内容/底部按钮），所以只有这一个渲染入口；
   * 行内容一律由 `src/concurrency.js` 的 `diffRows` 产出 —— 界面里**不许**再写一套"哪里不一样"。
   * 面板**只读**：它自己不写盘、不调 save（按钮走的是既有的 resolveConflict/save 语义）。 */
  let diskDiff = null;        // 最近一次外部改动差异（脏分支用；null = 没有/已过期）
  let conflictView = null;    // 最近一次的冲突（保存被拦下时；null = 没有未决冲突）

  function concEl(id) { return document.getElementById(id); }
  function concPanelOpen() { const p = concEl('conc-panel'); return !!p && p.style.display !== 'none'; }
  function closeConcPanel() { const p = concEl('conc-panel'); if (p) p.style.display = 'none'; }

  /** 面板**唯一渲染入口**。`view` = {title, meta, hint, groups:[{title, rows, empty}], buttons:[{label, act, primary, onClick}]} */
  function renderConcPanel(view) {
    const panel = concEl('conc-panel');
    if (!panel) return false;
    concEl('conc-title').textContent = view.title;
    concEl('conc-meta').textContent = view.meta || '';
    const body = concEl('conc-body');
    const actions = concEl('conc-actions');
    body.textContent = '';
    actions.textContent = '';
    if (view.hint) {
      const p = document.createElement('p'); p.className = 'conc-hint'; p.textContent = view.hint;
      body.appendChild(p);
    }
    (view.groups || []).forEach((g) => {
      const box = document.createElement('div'); box.className = 'conc-group';
      const h = document.createElement('h3'); h.textContent = g.title; box.appendChild(h);
      if (!g.rows || !g.rows.length) {
        const e = document.createElement('p'); e.className = 'conc-hint'; e.textContent = g.empty || '（无）';
        box.appendChild(e);
      }
      (g.rows || []).forEach((row) => {
        const r = document.createElement('div'); r.className = 'conc-row';
        r.setAttribute('data-key', row.key);          // 判据点名用（断言读**内容**，不读样式 ✓）
        /* 可点的行（v0.20 起只有绑定播报用它）：点一行跳到那个节点 —— 面板仍然是**只读**的，
         * "跳转"只改视图（不改数据、不写盘），与差异面板"只看不写"的声明不矛盾 ✓ */
        if (typeof g.onRowClick === 'function') {
          r.classList.add('clickable');
          r.setAttribute('title', '点这里跳到这个节点');
          r.addEventListener('click', () => {
            try { g.onRowClick(row.key); }
            catch (e) { setStatus('跳转失败：' + ((e && e.message) || e), true); }
          });
        }
        const rh = document.createElement('div'); rh.className = 'conc-row-head'; rh.textContent = row.label;
        r.appendChild(rh);
        const sides = document.createElement('div'); sides.className = 'conc-sides';
        row.sides.forEach((s, i) => {
          const sd = document.createElement('div');
          sd.className = 'conc-side ' + (i === 0 ? 'mine' : 'theirs');
          const lb = document.createElement('div'); lb.className = 'conc-side-label'; lb.textContent = s.label;
          const pre = document.createElement('pre'); pre.textContent = s.text;
          sd.appendChild(lb); sd.appendChild(pre); sides.appendChild(sd);
        });
        r.appendChild(sides); box.appendChild(r);
      });
      body.appendChild(box);
    });
    (view.buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.setAttribute('data-conc-act', b.act);       // 程序化/断言走它点名（不靠文案 ✓）
      if (b.primary) btn.className = 'primary';
      btn.addEventListener('click', () => {
        try { b.onClick(); } catch (e) { setStatus('操作失败：' + ((e && e.message) || e), true); }
      });
      actions.appendChild(btn);
    });
    panel.style.display = 'flex';
    return true;
  }

  /** 差异行两侧的**同一套标签**（两处面板不许各起一套名字） */
  const sideLabels = () => ({ mine: '我的改动（界面内存）', theirs: '盘上现状（外部写的）', base: '基线（我读到的那一版）' });
  const vshort = (v) => String(v || '').slice(0, 8) || '未上报';

  /** ② 「外部改动预览」：脏分支点的那个 banner 打开的就是它（**纯只读**） */
  function showDiskDiffPanel() {
    const d = diskDiff;
    if (!d) { setStatus('没有可预览的外部改动（可能已被同步或已切换项目）'); return false; }
    const cc = window.MMConcurrency;
    if (!cc) { setStatus('差异预览不可用：渲染层没有加载 src/concurrency.js', true); return false; }
    const L = sideLabels();
    // 两侧顺序 = 面板左右：左"我的改动"、右"盘上现状"（**同一条 diffRows**，内容不重复写）
    const sides = [{ label: L.mine, data: d.mine }, { label: L.theirs, data: d.theirs }];
    return renderConcPanel({
      title: '外部改动预览（只读）',
      meta: '界面所见 ' + vshort(d.seenVersion) + ' · 盘上 ' + vshort(d.version)
        + ' · 保存闸门基线 ' + vshort(d.baseVersion),
      hint: '这一段**只看不写**：不写盘、不重读树、不动你的未保存编辑。'
        + '分组与保存闸门用同一条基线与同一个判定（src/concurrency.js），'
        + '所以"撞在同一对象上"那几处，就是保存时会被拦下的那些。',
      groups: [
        { title: '外部改了（' + d.theirsKeys.length + ' 处）',
          rows: cc.diffRows(sides, d.theirsKeys), empty: '（外部这一版没有改动）' },
        { title: '我在界面上改了（' + d.mineKeys.length + ' 处）',
          rows: cc.diffRows(sides, d.mineKeys), empty: '（界面上还没有改动）' },
        { title: '撞在同一对象上（' + d.clashes.length + ' 处）',
          rows: cc.diffRows(sides, d.clashes),
          empty: '（没有相撞：保存时会自动三方合并，两边都保留）' }
      ]
    });
  }

  /** ③ 冲突面板：保存撞在同一对象上被拦下时（逐对象两边内容 + 同一组两个选择，语义照现行） */
  function showConflictPanel(res) {
    const conflicts = (res && res.conflicts) || [];
    const detail = (res && res.detail) || conflicts;
    const snaps = (res && res.snapshots) || { base: {}, mine: {}, theirs: {} };
    const L = sideLabels();
    const labels = {};
    conflicts.forEach((k, i) => { labels[k] = detail[i] || k; });
    // 三侧都摆出来：**基线**是"我们俩各自从哪一版改的"—— 只看两边会看不出"到底谁改了什么"
    const sides = [
      { label: L.mine, values: snaps.mine || {} },
      { label: L.theirs, values: snaps.theirs || {} },
      { label: L.base, values: snaps.base || {} }
    ];
    const cc = window.MMConcurrency;
    const rows = (cc && typeof cc.diffRows === 'function')
      ? cc.diffRows(sides, conflicts, { labels: labels })
      : conflicts.map((k) => ({ key: k, label: labels[k] || k, sides: [] }));
    conflictView = { conflicts: conflicts, detail: detail };
    return renderConcPanel({
      title: '保存被拦下：这些对象你和别人都改了',
      meta: '冲突对象 ' + conflicts.length + ' 处 · 盘上内容**一个字节都没动**',
      hint: '只有下面这些对象上的改动需要你选一边；**其它改动不受影响**（选"用盘上"时它们照常写入）。'
        + '本次不做"逐对象各挑一边"（留作后续），两个按钮的语义与从前一致。',
      groups: [{ title: '逐对象：两边 + 基线内容', rows: rows, empty: '（冲突细节未能取到）' }],
      buttons: [
        { label: '用盘上（只丢弃这些对象上的改动）', act: 'theirs', primary: true,
          onClick: () => { closeConcPanel(); resolveConflict('theirs'); } },
        { label: '保留我的（本次不保存，盘上未变）', act: 'mine',
          onClick: () => { closeConcPanel(); resolveConflict('mine'); } }
      ]
    });
  }

  /* 接线（脚本在 </body> 前，元素一定已在 DOM 里 ✓）：banner 的两个按钮 + 面板的 ✕。
   * 为什么不用"委托到 document"：这两处是**固定元素**，直接挂载更不容易漏（也没有动态后代）。 */
  (function wireConcUi() {
    const openBtn = concEl('conc-banner-open');
    if (openBtn) openBtn.addEventListener('click', () => { showDiskDiffPanel(); });
    const closeBtn = concEl('conc-banner-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        closeConcBanner();
        setStatus('已收起提示（盘上的改动仍在；再点保存会走三方合并）');
      });
    }
    const panelClose = concEl('conc-close');
    if (panelClose) panelClose.addEventListener('click', () => { closeConcPanel(); });
  })();

  /** 脏分支的统一处置：探视 → banner（+ 状态栏）。`pre` = 已经探过的那一份（不想再探一次时传入） */
  async function noteExternalChange(pre) {
    const d = pre || await refreshDiskDiff();
    if (!d) {
      setStatus('⚠ 收到外部变更通知，但这次**读不到盘上内容** —— 差异预览不可用；'
        + '保存仍走三方合并（撞同一对象才会拦）', true);
      return null;
    }
    if (!d.theirsKeys.length && !d.clashes.length) {
      // 盘上这一版与界面读到的基线**内容一致**（点文件/同内容重写/防抖噪声）⇒ 不制造假警报
      setStatus('已收到外部变更通知，但盘上内容与界面读到的那一版一致 —— 无需处理');
      return d;
    }
    showConcBanner('外部（AI/CLI）已改盘上内容（' + d.theirsKeys.length + ' 处'
      + (d.clashes.length ? '，其中 ' + d.clashes.length + ' 处与你的改动相撞' : '')
      + '）—— 点这里看差异');
    setStatus('⚠ 外部已改盘上内容（' + d.theirsKeys.length + ' 处'
      + (d.clashes.length ? '，' + d.clashes.length + ' 处与你的改动撞在同一对象上' : '')
      + '）：**没有**覆盖你的编辑；保存时走三方合并（撞同一对象才会拦）', true);
    return d;
  }

  /** 只读取盘上这一版（**不推进任何基线** —— 这正是它必须用 `project:peek` 的原因，
   *  见 `onProjectDiskChange` 里那段说明）。返回 `{ok:true, data, version}` 或
   *  `{ok:false, error}`：拿不到就**如实说不确定**，绝不退回去用会推进基线的 `project:read` ✗
   *  （那等于把"界面读过这一版"记到账上，随后保存就会静默覆盖盘上那份）。 */
  function peekProject(name) {
    const api = window.desktop && window.desktop.project;
    if (!api || typeof api.peek !== 'function') {
      return Promise.resolve({ ok: false, error: '这个版本没有只读探视通道（preload 少了 project.peek）' });
    }
    return Promise.resolve()
      .then(() => api.peek(name))
      .then((r) => ((r && r.ok && r.data) ? { ok: true, data: r.data, version: r.version } : { ok: false, error: (r && r.error) || '探视没有返回内容' }))
      .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
  }

  async function onProjectDiskChange(filename) {
    if (!state.project || !state.jm) return;
    if (filename && !String(filename).includes(state.project.name)) return; // 只关心当前项目
    if (isDirty()) {
      // 有未保存编辑 ⇒ 树不重读、内存不改（安全声明），但**差异要看得见** ✓
      noteDiskChange(filename, 'dirty', null);
      await noteExternalChange();
      return;
    }
    if (reloadingFromDisk) { noteDiskChange(filename, 'busy', null); return; }
    const epoch0 = projectEpoch;
    const name0 = state.project.name;
    reloadingFromDisk = true;
    try {
      /* 取盘上这一版**只能走只读探视**（`project:peek`）✗ 不许用 `project:read`：
       * 那条会把主进程的保存/合并基线（`versionAtRead`/`baseAtRead`）推进到盘上这一版，
       * 而这条路**可能读了却不采纳**（下面两道拒绝：期间切了项目 / 期间又变脏）——
       * 基线一旦记成"界面见过盘上这一版"，`project:save` 的闸门就判"没有外部改动"⇒ 下一次保存
       * 把内存里那份旧树直接写下去，把盘上（AI/CLI 刚写的）那份**静默抹掉**
       * （本工程最重的损害类别 ✗）。peek 没有任何副作用 ⇒ **"读了却不采纳"永远不会让基线前进** ✓；
       * 基线只在真采纳处前进（openProject 的读 / editor 的读 / 保存成功）。
       * 顺带一个好处：取数与判脏之间不再夹着一次会推进基线的写记录读取 —— 拒绝那条路干净了。 */
      const pr = await peekProject(name0);
      // 读盘期间项目被切走 ⇒ 这份数据已过期，丢弃（否则会把旧项目的树盖到新项目上 ✗）
      if (epoch0 !== projectEpoch) {
        noteDiskChange(filename, 'switch', pr.version);
        setStatus('已忽略一次过期的自动重读（期间已切换项目）');
        return;
      }
      // 读盘期间用户又有了未保存改动 ⇒ **同样不许覆盖** ✓（读盘前判一次、回来再判一次：
      // 只判前面那一次会漏掉这个窗口，实测会把盘上那份的旧树偏移带回内存 ✗）。
      // 这条拒绝**不需要回滚什么**：上面那次探视一个基线都没碰 ✓
      if (isDirty()) {
        noteDiskChange(filename, 'dirty', pr.version);
        await noteExternalChange();   // 差异照算：界面基线没被推进过，算出来的与保存闸门同一份口径 ✓
        return;
      }
      if (!pr.ok) {
        // 拿不到盘上那一版 ⇒ **不采纳**、内存一个字都不改，但必须**说出来**（不静默 ✗）：
        // 内存是旧的、界面基线也是旧的 ⇒ 之后的保存仍会走三方合并（两边的改动都保住）✓
        noteDiskChange(filename, 'unreadable', null);
        setStatus('同步外部修改失败：读不到盘上这一版（' + (pr.error || '未知原因') + '）'
          + ' —— 界面内存与基线都没动；保存时会走三方合并', true);
        return;
      }
      /* ===== 【保存后不再折回】这一份是**本界面自己刚写下的**那一份吗？ =====
       *
       * 判据（**复用既有那套**，不新造第二份）：`project:peek` 回来的盘上内容指纹
       * === `selfWrittenVersion`（本界面整树写回成功时从 `project:save` 回执记下的那一个 ——
       * 见它头顶的说明；同一个值空间 = 保存闸门比的那一版）。
       * 相等 ⇒ 盘上这些字节就是本界面从内存里写下去的那一份 ⇒ **没有任何东西要采纳**
       * （`peek` 已经把盘上这一份**读过、比过**了 ⇒ "重读"这一步照旧发生、数据一致性照旧校验 ✓），
       * 而 `renderMind` 只会把同一份东西**重建**一遍并把视图**归一**（只展开根 + 偏移清空 + 撤销栈重置）
       * ⇒ 用户刚摆好的展开态/偏移/位置当场折回 ✗。所以这里**只是不重建视图**，别的什么都不做：
       * 不写盘、不推基线、不动内存、不动撤销栈、不碰状态栏（保存成功那句留在原处）。
       * 不相等 ⇒ 真外部改动（或自动合并那次合成结果）⇒ 照旧走下面的采纳路径，一个字节都不改 ✓。 */
      if (pr.version && selfWrittenVersion && pr.version === selfWrittenVersion) {
        noteDiskChange(filename, 'own-write', pr.version);
        return;
      }
      renderMind(pr.data);
      state.history = new UndoStack(50);
      state.history.push(snapshot());
      lastSavedSnapshot = snapshot();
      state.project.version = pr.version;   // 界面所见内容 = 盘上这一版（→ 上报 seenVersion）
      closeConcBanner();                   // 已经采纳盘上这一版 ⇒ 那条提示该消失了
      diskDiff = null;
      updateHistoryButtons();
      if (MM.invalidatePaletteCache) MM.invalidatePaletteCache();
      noteDiskChange(filename, 'adopted', pr.version);
      setStatus('已同步外部修改（侧栏 AI 编辑已出现在导图上）');
    } catch (err) {
      setStatus('同步外部修改失败：' + ((err && err.message) || err), true);
    } finally {
      reloadingFromDisk = false;
    }
  }

  /* ================= 导入/导出 Markdown ================= */
  async function importMarkdown() {
    // 主进程弹出文件选择 → 渲染层用路径交给 CLI（经主进程）
    // 简化：通过 menu:import-md 事件 → editor.js 处理文件选择
    window.MMEditor && window.MMEditor.pickAndImportMd();
  }
  async function exportMarkdown() {
    window.MMEditor && window.MMEditor.pickExportMd();
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);  const escHtml = (s) => MM.escHtml(s);
  const serializeTree = () => MM.serializeTree();
  const rebuildFromJson = (json) => MM.rebuildFromJson(json);
  const renderMind = (data) => MM.renderMind(data);
  const applyRootModeVisual = (jm, themed) => MM.applyRootModeVisual(jm, themed);
  const showDetail = (node) => MM.showDetail(node);

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.runSearch = runSearch;
  MM.renderSearchResults = renderSearchResults;
  /** 双击节点的语义（用户 2026-10-08 定）：**展开 / 收起**子层 ✓（不再弹编辑框 ✗）。
   *  编辑走右键菜单「编辑（F2）」✓ —— 能力没丢，只是入口换了 ✓。
   *  边界如实说：根节点没有可展开子层、叶子节点没有子节点 ⇒ 给一句状态说明（不静默 ✗）。 */
  function toggleNodeExpanded(id) {
    const jm = state.jm;
    const n = MM.adapter.available(jm) ? MM.adapter.getNode(jm, id) : null;
    if (!n) { setStatus('节点不存在：' + id, true); return false; }
    if (n.isroot) { setStatus('根节点没有可展开的子层'); return false; }
    if (!(n.children && n.children.length)) { setStatus('「' + n.topic + '」没有子节点'); return false; }
    if (n.expanded) { MM.adapter.collapseNode(jm, id); setStatus('已收起：' + n.topic); }
    else { MM.adapter.expandNode(jm, id); setStatus('已展开：' + n.topic); }
    return true;
  }
  MM.toggleNodeExpanded = toggleNodeExpanded;
  MM.jumpToNode = jumpToNode;
  MM.switchProject = switchProject;
  MM.followNodeRef = followNodeRef;       // 点开站内链接的唯一入口（同项目选中/滚到目标，不切项目）
  MM.expandAncestors = expandAncestors;   // 单源：跳转到某节点的三个入口（搜索/关联/媒体）共用
  MM.save = save;
  MM.resolveConflict = resolveConflict;
  MM.hasPendingConflict = hasPendingConflict;
  MM.snapshot = snapshot;
  MM.recordHistory = recordHistory;
  MM.undo = undo;
  MM.redo = redo;
  MM.updateHistoryButtons = updateHistoryButtons;
  MM.addNode = addNode;
  MM.addSiblingNode = addSiblingNode;
  MM.addTopic = addTopic;
  MM.editNode = editNode;
  MM.deleteNode = deleteNode;
  MM.deletePrecheck = deletePrecheck;   // 删前预检（关联成员 / 入边链接 / CLI 剪枝）—— 模块的 beforeDelete 钩子
  /* ================= 编辑器的**宿主接口**（`renderer/editor.js` 的 `create(host)`） =================
   * 为什么这段在本文件：**只有本文件的闭包里有主窗的项目语义** —— `recordHistory`（撤销栈）、
   * `deletePrecheck`（关联/链接剪枝）、`state.project`/`state.jm`。`renderer/editor.js` 从
   * `W11 a–e` 的 `b` 起是**主窗与草稿图窗共用的一份实现**，它不再直接够 `MMApp`；
   * 谁想知道"这次编辑落到哪里"，就由谁在这里回答（定题 `.review/20261020-editor-复用/00-定题.md`）。
   * 能力位全 true：主窗**能**做全部这些事（与改前"编辑器只有主窗有"等价）。
   * ⚠️ `onCommit` 只对 `add`/`delete`/`move` 记撤销栈 —— **改标题/正文不进栈**、
   *    导入图片/附件也不进栈，这是改前的语义（三条都有逐字节基线取证，别顺手"修"）。 */
  MM.mainEditorHost = function mainEditorHost() {
    return {
      adapter: MM.adapter,
      getJm: () => state.jm,
      setStatus: (text, isErr) => setStatus(text, isErr),
      getProject: () => state.project,
      showDetail: (node) => MM.showDetail(node),
      reloadProject: (name) => openProject(name),
      capabilities: {
        editTopic: true, editDetail: true, editTags: true, editExpanded: true,
        addChild: true, addSibling: true, deleteNode: true, moveNode: false,
        undoRedo: true, save: true, assets: true, markdown: true, crossProject: true, overlays: true
      },
      history: { undo: () => undo(), redo: () => redo() },
      onSave: () => save(),
      onCommit: (kind) => { if (kind === 'add' || kind === 'delete' || kind === 'move') recordHistory(); },
      beforeDelete: (node) => deletePrecheck(node),
      overlays: {
        closeLightbox: () => MM.closeLightbox(),
        closeFilePreview: () => MM.closeFilePreview(),
        hideFloatDetail: () => MM.hideFloatDetail(),
        paletteIsOpen: () => MM.paletteIsOpen()
      },
      applyTopicMarkup: (jm) => MM.applyTopicMarkup(jm)
    };
  };
  MM.reorderNodeChild = reorderNodeChild;   // 【R2 期 3 · e】同级重排的**唯一写口**（→ IPC → CLI move）
  MM.reorderNodeChildRaw = reorderNodeChildRaw;   // 同上但**绕过 clamp**，只给域 48 的"越界必红"取证
  MM.reparentNode = reparentNode;           // 【R2 期 4 · f】重挂父的**唯一写口**（预览→确认→IPC→CLI→回读重建）
  MM.reparentNodeRaw = reparentNodeRaw;     // 同上但**绕过预览/确认**，只给域 49 的"预检必红"取证
  MM.loadProjects = loadProjects;
  MM.openProject = openProject;
  MM.isDirty = isDirty;
  MM.markAlignedBaseline = markAlignedBaseline;   // "界面已与盘上内容对齐"（见函数说明；AI 落盘用）
  MM.confirmDiscardIfDirty = confirmDiscardIfDirty;
  MM.closeMapPage = closeMapPage;      // **真关**导图页：先拦未保存编辑（保存成功才卸页）

  /* ================= 一次收干净所有"模态"（自动化前置 / 隔离用） =================
   * 为什么需要它（真实事故，2026-10-10）：`renderer/editor.js` 的 `openEditDialog` 是**纯 DOM**
   * 模态 —— 它不在任何"每域隔离"的还原范围内（隔离只还原项目数据文件 + 重载项目），
   * 于是「编辑节点」框会**跨域存活**：域 16 的 `addNode()` 顺手打开它、`undo()` 不关它，
   * 下一个域（36/37，全是真鼠标输入 + `elementFromPoint` 命中测试）整片变红 ——
   * 报文是 `点不到 comp-net …→DIV.dialog-box` 与 `命中测试命中圆钮=false（命中=overlay）`，
   * 而那个文件**一行都没改过** ✗。实测：`SMOKE_ONLY='16,36,37'` 12/23。
   * 全量运行之所以仍绿，只是因为后面的域**顺手**替别人擦了桌子（12-dsh-drag.js 的 `strays`、
   * 27-import-doc.js 的 `edit-cancel` 点击）—— 那属于运气，不属于隔离 ✗。
   *
   * 口径（三层，缺一层就不算解决）：
   *   ① 只收**真正打开着**的（`display !== 'none'`）⇒ 幂等，重复调用无副作用；
   *   ② 走**产品自己的关闭路径**（`closeEditDialog` / `closePalette` / …），不新发明一套；
   *   ③ **返回列表而不是静默关掉** ⇒ 调用方（冒烟框架）能把"谁留的"报出来；
   *      静默收干净的后果是"下一个域莫名奇妙地红/绿"，与本工程最忌讳的那类缺陷同型。
   * 边界（别以为它比实际更强）：只覆盖**模态/浮层**（`.overlay` 一族 + 命令面板 + 审计面板）
   *   **加上 v0.20 的并发 banner**（它不是模态，但会占布局 ⇒ 一样会跨域泄漏）；
   *   浮动详情框、选区块、大小锁是**另一类**状态（不遮挡输入），不在本函数的责任内。 */
  function closeAllDialogs() {
    const open = [];
    const log = (name, el, close) => {
      if (!el || el.style.display === 'none') return;   // 没开着 ⇒ 不动（幂等）
      open.push({ name: name, html: String(el.innerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
      try { close(); } catch (e) { /* 单个关不掉不阻断：整个函数是"尽力收干净"，收不掉的那条已经进了 open ✓ */ }
    };
    // 「编辑节点」：走**用户点取消**同一条路（editor.js 的 closeEditDialog 挂在 #edit-cancel 上）
    log('edit-dialog', elemById('edit-dialog'), () => { elemById('edit-cancel').click(); });
    // 图片 / 附件对话框：产品自己没有独立的 close 入口（只有各自的取消按钮）
    log('image-dialog', elemById('image-dialog'), () => { elemById('image-cancel').click(); });
    log('file-dialog', elemById('file-dialog'), () => { elemById('file-cancel').click(); });
    // 关联笔记编辑框：产品有闭包级 closeAssocEditor（app-assoc.js 导出到 MM）
    log('assoc-dialog', elemById('assoc-dialog'), () => { if (MM.closeAssocEditor) MM.closeAssocEditor(); });
    // 灯箱 / 文件预览：MM 上本来就有公开关闭口
    log('lightbox', elemById('lightbox'), () => { if (MM.closeLightbox) MM.closeLightbox(); });
    log('file-preview', elemById('file-preview'), () => { if (MM.closeFilePreview) MM.closeFilePreview(); });
    // 纯 JS 面板（不是 DOM 模态）：关掉它们要走各自的 API
    if (MM.paletteIsOpen && MM.paletteIsOpen()) { open.push({ name: 'palette', html: '' }); MM.closePalette(); }
    const au = elemById('audit-panel');
    if (au && au.style.display !== 'none') { open.push({ name: 'audit-panel', html: '' }); MM.closeAudit(); }
    // v0.20 并发差异/冲突面板：也是 `.overlay` 一族（同一条关闭口，别再各写一套）
    if (concPanelOpen()) { open.push({ name: 'conc-panel', html: '' }); closeConcPanel(); }
    /* banner 不是模态，但它是**会占布局的一层**：域末留着会让后面的域看到非预期的几何
     * （每域隔离只重载项目、不重载页面 ⇒ 它会**跨域存活**）⇒ 一并收，并如实报出来。
     * 【R4 界面侧】绑定工作区文件夹那两条同理由同一处理：
     *   · `bind-preview` 是**真模态**（挡输入）⇒ 走产品自己的取消路径（`MM.bindPreviewCancel`）；
     *   · `bind-banner` 是会占布局的 banner ⇒ 收起（与 conc-banner 同款）。
     * ⚠️ **状态条 `bind-bar` 故意不在这一族里**：它不是"开着/关着"的东西，而是**当前项目有无绑定的派生显示** ——
     *   把它"收起来"会变成一句谎话（绑着却显示没有）。它由项目重载自己纠正（每域隔离会重载项目 ⇒ 自动收起）✓。 */
    if (elemById('bind-preview') && elemById('bind-preview').style.display !== 'none') {
      open.push({ name: 'bind-preview', html: '' });
      if (MM.bindPreviewCancel) MM.bindPreviewCancel();
      else elemById('bind-preview').style.display = 'none';
    }
    const bb = elemById('bind-banner');
    if (bb && bb.style.display !== 'none') { open.push({ name: 'bind-banner', html: '' }); if (MM.closeBindBanner) MM.closeBindBanner(); }
    const cb = elemById('conc-banner');
    if (cb && cb.style.display !== 'none') { open.push({ name: 'conc-banner', html: '' }); closeConcBanner(); }
    /* 【W13】界面侧导入入口那两处，理由与上面 bind-* 两条逐字相同：
     *   · `import-preview` 是**真模态**（挡输入）⇒ 走产品自己的取消路径（`MM.importPreviewCancel`）；
     *   · `import-banner` 是**会占布局的 banner**（每域隔离只重载项目、不重载页面 ⇒ 会跨域存活）⇒ 收起。 */
    const ip = elemById('import-preview');
    if (ip && ip.style.display !== 'none') {
      open.push({ name: 'import-preview', html: '' });
      if (MM.importPreviewCancel) MM.importPreviewCancel();
      else ip.style.display = 'none';
    }
    const ib = elemById('import-banner');
    if (ib && ib.style.display !== 'none') { open.push({ name: 'import-banner', html: '' }); if (MM.importCloseBanner) MM.importCloseBanner(); }
    return open;
  }
  MM.closeAllDialogs = closeAllDialogs;
  /* 并发可见性（v0.20）：面板与 banner 的公开入口 —— 冒烟断言/自动化用它驱动同一条产品路径
   * （判据仍然读**内容与命中测试**，不靠这些 getter 自证 ✓）。 */
  MM.showDiskDiffPanel = showDiskDiffPanel;
  MM.showConflictPanel = showConflictPanel;
  /* 【R4 界面侧】只读面板的**唯一渲染器**：绑定同步的"变更播报"复用它（同一张卡片、同一套行、
   * 同一个 src/concurrency.js 差异行构造）—— 界面里**不许**再写第二套"哪里不一样"的渲染 ✓。
   * 行点击是**可选**能力（`group.onRowClick`）：差异预览/冲突面板不传 ⇒ 行不可点（行为与从前一致）。 */
  MM.renderConcPanel = renderConcPanel;
  MM.closeConcPanel = closeConcPanel;
  MM.concPanelOpen = concPanelOpen;
  MM.closeConcBanner = closeConcBanner;
  MM.refreshDiskDiff = refreshDiskDiff;

  /** 局部小工具：按 id 取元素（本文件其余地方走 MM.$，这里只为让上面的 `log(...)` 读起来不被选择器噪音淹没） */
  function elemById(id) { return document.getElementById(id); }
  MM.setConfirmStub = setConfirmStub;  // 自动化用：换掉确认框（默认 window.confirm）
  MM.onProjectDiskChange = onProjectDiskChange;
  /** 最近一次"盘上变了"的判定留痕（**只给断言与排查用**：判据本身读可见集合/偏移/几何/盘上字节）。
   *  见 `noteDiskChange` 头顶：没有它，"视图没折回"这条判据分不清"真的没折回"与"那次事件根本
   *  没来"（后者是空转，看着全绿却什么都没验 ✗）。 */
  MM.getLastDiskChange = getLastDiskChange;
  /** 请求一次"按磁盘重读"（**不经过 fs.watch 的 300ms 防抖**）。
   *  谁需要它：主进程写完盘、并且**已经知道**渲染层内存落后了的时候
   *  （A 的问答落盘：`app:ask-apply` 写完立刻发 `app:project-reread`）——
   *  被动等 fs.watch 会让界面上"晚一拍"才看见新子节点，而断言要判的正是"界面侧也变了"。
   *  判定**仍然是 onProjectDiskChange 那一套**（有脏改动则拒绝覆盖、世代不一致则丢弃）：
   *  这里只是把"该重读了"说出口，**不新增第二套冲突规则** ✓ */
  function requestReread() {
    return onProjectDiskChange(state.project ? state.project.name : null);
  }
  MM.requestReread = requestReread;
  MM.importMarkdown = importMarkdown;
  MM.exportMarkdown = exportMarkdown;
})();
