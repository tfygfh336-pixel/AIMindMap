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
        setStatus('已保存 ' + new Date().toLocaleTimeString() + '（已与外部改动自动合并）');
      } else {
        if (res && res.version && state.project) state.project.version = res.version;
        lastSavedSnapshot = JSON.stringify(data);
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
   *    ⇒ `setConfirmStub()` 给自动化换掉确认框（默认就是 window.confirm ✓）。 */
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

  /** 有未保存改动时询问用户；返回 false 表示用户选择取消 */
  function confirmDiscardIfDirty(actionLabel) {
    if (!isDirty()) return true;
    // Electron 渲染层可用同步 confirm（本项目无对话框封装，且这是打断性确认，同步更简单可靠）
    return window.confirm('当前有未保存的改动，' + (actionLabel || '继续') + '将丢失这些改动。\n\n要放弃改动吗？\n（点「取消」返回并先保存）');
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

  /* ================= 编辑操作（供 editor.js / 菜单调用） ================= */
  function addNode(parentId) {
    const jm = state.jm;
    const parent = parentId ? MM.adapter.getNode(jm, parentId) : MM.adapter.getSelected(jm);
    if (!parent) { setStatus('请先选中一个节点作为父节点'); return; }
    const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    MM.adapter.addNode(jm, parent.id, id, '新节点', { detail: '' });
    recordHistory(); // 修改后压入快照（撤销时恢复修改前状态）
    MM.adapter.selectNode(jm, id);
    window.MMEditor && window.MMEditor.editNode(id);
  }

  function addSiblingNode(id) {
    const jm = state.jm;
    const sel = id ? MM.adapter.getNode(jm, id) : MM.adapter.getSelected(jm);
    if (!sel) { setStatus('请先选中要插入的节点'); return; }
    if (sel.id === 'root') { setStatus('根节点无法新增同级'); return; }
    const newId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // ⚠️ 已知缺陷（**本次纯重构按原样保留**，没有顺手"修"）：jsMind 0.9.1 的公开
    // `add_node(parent, id, topic, data, direction)` **只有 5 个形参、没有 index** ——
    // 这里多传的 `sel.index + 1`（本意"插到所选节点之后"）**一直被静默丢弃**，新节点
    // 实际追加在**父节点末尾**。取证：`.review/20261009-jsMind事件派发探针/` 与
    // `renderer/mindmap-adapter.js` 头部。适配层的 addNode 形参也只到 direction 为止 ⇒
    // 那个第 7 个实参同样不会被用到，留着只为让"这里曾想插到所选节点之后"在代码里看得见。
    // 要改它是**行为变更**（换了新节点落点），应另开一次改动并补一条"落点"断言。
    MM.adapter.addNode(jm, sel.parent.id, newId, '新节点', { detail: '' }, undefined, sel.index + 1);
    recordHistory();
    MM.adapter.selectNode(jm, newId);
    window.MMEditor && window.MMEditor.editNode(newId);
  }

  /** 新增顶层主题：「凭空」加一个不选父节点的节点，直接挂在根节点下。
   *  同时开启主题模式 —— 于是它与其它顶层主题互相独立（容器根隐藏、连线跳过）。 */
  function addTopic() {
    const jm = state.jm;
    const root = jm && MM.adapter.getNode(jm, 'root');
    if (!root) { setStatus('导图尚未就绪'); return; }
    if (state.rootMode !== 'themes') {
      state.rootMode = 'themes'; // 顶层主题 = 独立主题
      applyRootModeVisual(jm, true);
    }
    const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    MM.adapter.addNode(jm, 'root', id, '新主题', { detail: '' });
    recordHistory();
    MM.adapter.selectNode(jm, id);
    window.MMEditor && window.MMEditor.editNode(id);
  }

  function editNode(id) {
    const jm = state.jm;
    const node = id ? MM.adapter.getNode(jm, id) : MM.adapter.getSelected(jm);
    if (!node) { setStatus('请先选中要编辑的节点'); return; }
    window.MMEditor && window.MMEditor.editNode(node.id);
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

  function deleteNode(id) {
    const jm = state.jm;
    const node = id ? MM.adapter.getNode(jm, id) : MM.adapter.getSelected(jm);
    if (!node) { setStatus('请先选中要删除的节点'); return; }
    if (node.id === 'root') { setStatus('根节点不可删除'); return; }

    const finish = () => {
      MM.adapter.removeNode(jm, node.id);
      recordHistory(); // 修改后压入快照
      setStatus('已删除：' + node.topic);
    };

    // 关联笔记：被删（子）树可能是关联成员。若照原样保存，落盘数据就带"悬挂成员"，
    // 而 project:save 是**校验闸门**（写盘前跑 CLI validate）→ 保存会被拒；
    // 界面又没有改成员的入口，等于把用户卡死。所以先问一句。
    //
    // 关键：清理必须**在磁盘上**做（走 IPC → CLI assoc-prune），不能在内存里剪完
    // 指望保存一起写回 —— `project:save` 在载荷里没有 assoc 时会从磁盘取回
    // （那是为了防止 AI 刚写的笔记被界面保存抹掉），于是内存里剪掉的成员会**原地复活**，
    // 悬挂成员依旧存在、保存照样被拒（实测）。assoc 的作者是 CLI，写就只经 CLI。
    const proj = state.project && state.project.name;
    if (!proj || !(window.desktop.app && window.desktop.app.assoc && window.desktop.app.assocPrune)) {
      finish();
      return;
    }

    window.desktop.app.assoc(proj).then((r) => {
      const list = (r && r.raw) || [];
      state.assoc = list;                    // 顺带与磁盘对齐（assoc 的真值在磁盘）
      const ids = subtreeIds(node);
      const affected = list.filter((a) => (a.members || []).some((m) => m && m.project === proj && ids.indexOf(m.id) >= 0));
      const inLinks = inboundLinks(ids, proj);
      if (!affected.length && !inLinks.length) { finish(); return; }

      const lines = ['「' + node.topic + '」被别处引用：'];
      if (affected.length) lines.push('· ' + affected.length + ' 篇关联笔记：' + affected.map((a) => a.title || a.id).join('、'));
      if (inLinks.length) lines.push('· ' + inLinks.length + ' 条指向它的链接：' + inLinks.map((x) => x.node).join('、'));
      lines.push('');
      lines.push('删除节点会留下悬空引用（保存会被校验闸门拒绝），故需一并清理'
        + (affected.length ? '（清到只剩一个成员的关联会整篇删除）' : '') + '。');
      lines.push('要一起清理吗？点「取消」则先不删。');
      if (!window.confirm(lines.join('\n'))) {
        setStatus('已取消删除：「' + node.topic + '」被 ' + (affected.length + inLinks.length) + ' 处引用');
        return;
      }

      // 先清理磁盘，成功后再删节点。清理失败就不删 —— 否则会留下保存不了的坏状态。
      window.desktop.app.assocPrune(proj, ids).then((p) => {
        if (!p || !p.ok) {
          setStatus('引用清理失败，已取消删除：' + ((p && p.text) || '未知错误')
            + '（也可在命令行执行 assoc-prune / links-prune ' + proj + ' --nodes ' + ids.join(',') + '）', true);
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
        finish();
        setStatus('已删除：' + node.topic + '（并清理 ' + affected.length + ' 篇关联 / '
          + inLinks.length + ' 条链接的引用）');
      }).catch((err) => {
        setStatus('引用清理失败，已取消删除：' + ((err && err.message) || err), true);
      });
    }).catch((err) => {
      // 关联读不出来就不敢删：磁盘上可能有引用，删了会留下保存不了的坏状态
      setStatus('关联笔记读取失败，已取消删除：' + ((err && err.message) || err)
        + '（若确认无引用，可用 remove ' + proj + ' ' + node.id + ' --clean-assoc --clean-links）', true);
    });
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
      await noteExternalChange();
      return;
    }
    if (reloadingFromDisk) return;
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
      if (epoch0 !== projectEpoch) { setStatus('已忽略一次过期的自动重读（期间已切换项目）'); return; }
      // 读盘期间用户又有了未保存改动 ⇒ **同样不许覆盖** ✓（读盘前判一次、回来再判一次：
      // 只判前面那一次会漏掉这个窗口，实测会把盘上那份的旧树偏移带回内存 ✗）。
      // 这条拒绝**不需要回滚什么**：上面那次探视一个基线都没碰 ✓
      if (isDirty()) {
        await noteExternalChange();   // 差异照算：界面基线没被推进过，算出来的与保存闸门同一份口径 ✓
        return;
      }
      if (!pr.ok) {
        // 拿不到盘上那一版 ⇒ **不采纳**、内存一个字都不改，但必须**说出来**（不静默 ✗）：
        // 内存是旧的、界面基线也是旧的 ⇒ 之后的保存仍会走三方合并（两边的改动都保住）✓
        setStatus('同步外部修改失败：读不到盘上这一版（' + (pr.error || '未知原因') + '）'
          + ' —— 界面内存与基线都没动；保存时会走三方合并', true);
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
