/* ============================================================
 * AI MindMap — 节点悬浮工具条 + AI 问答浮窗（app-ask.js，功能 1 的界面层）
 * ------------------------------------------------------------
 * 需求（用户原话）：「选中/框选节点后弹类豆包悬浮工具栏；有『解释』按钮，点了弹出一个小浮窗，
 *   浮窗里的对话框就是内置 DSH 的对话框，视觉与节点详情的对话框一致；还有一个『问问AI』按钮。」
 *
 * 三个关键取舍（都有理由，写在现场免得后人重做一遍）：
 *   ① **浮窗直接复用节点详情框组件**（`MM.createFdBox()` + `.float-detail`）——
 *      "视觉与节点详情一致"这条需求**照抄组件就是最省力的达成方式**，而不是新建一个窗口
 *      （不引入 `WebContentsView`、不引入第二套拖拽/改大小/锁/让位逻辑 ✓）。
 *      ⇒ 它自动获得：可拖动、可改大小、📌/🖥 锁、与 DSH 侧栏的让位 —— 全是既有能力 ✓；
 *   ② **后端是一次性问答**（`window.desktop.app.ask` → `cli ask` → `dsh headless`），
 *      ⇒ 每问一次是一个**新会话**（没有上下文延续）。界面上**明说**这一点（`ask-hint`），
 *      不假装是连续对话 ✗；真正多轮要 `--resume`，属后续步；
 *   ③ 工具条挂 `position: fixed` 的顶层覆盖物（不是画布内的元素，避免被变换层缩放/裁剪 ✗）。
 *
 * 冒烟里 `ask` 返回的是**桩**（`stub:true`，见 main.js 的 app:ask）—— 门禁不烧额度、不依赖网络。
 * 本文件的断言只验"链路通不通"，模型质量不在门禁范围 ✓。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});
  const esc = (s) => MM.escHtml(s);
  const state = () => (MM.getState ? MM.getState() : {});

  const BAR_ID = 'mm-node-toolbar';
  let barEl = null;
  let curNodeId = null;

  function topicOf(id) {
    const jm = state().jm;
    const n = jm && jm.get_node ? jm.get_node(id) : null;
    return n && n.topic ? n.topic : id;
  }

  function nodeEl(id) {
    const jm = state().jm;
    const p = MM.fdPanel ? MM.fdPanel() : null;
    if (!jm || !p) return null;
    return p.querySelector('jmnode[nodeid="' + id + '"]');
  }

  /** 工具条位置：贴在被选节点**上方**，并夹进视口（越界就翻到下方/贴边）—— 纯几何，可单测 */
  function computeBarPos(rect, barW, barH, view) {
    const v = view || { w: 800, h: 600 };
    const cx = rect.left + rect.width / 2;
    let left = Math.round(cx - barW / 2);
    left = Math.max(8, Math.min(left, v.w - barW - 8));
    let top = Math.round(rect.top - barH - 8);
    if (top < 8) top = Math.round(rect.bottom + 8);              // 上方放不下 ⇒ 翻到下方
    top = Math.max(8, Math.min(top, v.h - barH - 8));
    return { left: left, top: top };
  }

  function ensureBar() {
    if (barEl && barEl.parentElement) return barEl;
    barEl = document.createElement('div');
    barEl.id = BAR_ID;
    barEl.className = 'mm-tb';
    barEl.setAttribute('data-role', 'node-toolbar');
    barEl.innerHTML = '<button type="button" class="mm-tb-btn mm-tb-explain" data-act="explain"'
      + ' title="让内置 AI 解释这个节点（在浮窗里给出答案）">💡 解释</button>'
      + '<button type="button" class="mm-tb-btn mm-tb-ask" data-act="ask"'
      + ' title="向内置 AI 提问（浮窗里输入问题）">💬 问问AI</button>';
    document.body.appendChild(barEl);
    barEl.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('.mm-tb-btn') : null;
      if (!btn || !curNodeId) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.getAttribute('data-act');
      showAskBox(curNodeId, { kind: act === 'explain' ? 'explain' : 'ask', focus: act !== 'explain' });
    });
    return barEl;
  }

  /** 显示工具条（多选框选时不显示 —— 见文件头取舍③的边界说明） */
  function showBarFor(nodeId) {
    if (!nodeId) { hideBar(); return null; }
    if (MM.hasSelection && MM.hasSelection()) { hideBar(); return null; }   // 框选中：先不打扰
    const el = nodeEl(nodeId);
    if (!el) { hideBar(); return null; }
    curNodeId = nodeId;
    const bar = ensureBar();
    bar.style.display = 'flex';
    const r = el.getBoundingClientRect();
    const bw = bar.offsetWidth || 150, bh = bar.offsetHeight || 30;
    const pos = computeBarPos(r, bw, bh, { w: window.innerWidth, h: window.innerHeight });
    bar.style.left = pos.left + 'px';
    bar.style.top = pos.top + 'px';
    bar.setAttribute('data-node', nodeId);
    return pos;
  }

  function hideBar() {
    if (barEl) barEl.style.display = 'none';
    curNodeId = null;
    return true;
  }

  const isBarVisible = () => !!(barEl && barEl.style.display !== 'none' && barEl.parentElement);

  /* ================= AI 问答浮窗（复用详情框组件） ================= */
  let askBoxes = [];

  function showAskBox(nodeId, opts) {
    const o = opts || {};
    const project = state().project && state().project.name;
    if (!project) return null;   // 项目级提问也需要有个项目（情境里有它 ✓）
    const kind = o.kind === 'explain' ? 'explain' : 'ask';
    // 同一个节点（或同一个"项目级"）复用同一个框：再点「解释」不会堆出一摞框 ✓
    const key = nodeId || '__project__';
    let box = askBoxes.find((b) => (b.node ? b.node.id : '__project__') === key && b.el && b.el.parentElement);
    if (!box) {
      box = MM.createFdBox();
      box.kind = 'ask';
      box.el.setAttribute('data-kind', 'ask');
      box.el.classList.add('fd-ask-box');   // CSS 里据此**隐藏大小锁**（悬浮窗不需要锁 ✓ 用户反馈⑧）
      askBoxes.push(box);
    }
    box.node = nodeId && state().jm ? state().jm.get_node(nodeId) : null;   // 项目级：无节点 ✓
    box.ask = { kind: kind, log: (box.ask && box.ask.log) || [] };
    box.el.style.display = 'flex';
    MM.bringFdBoxToFront(box);
    renderAskPage(box);
    MM.positionFdBox(box);
    // ⑧「绑定在第一次显示的位置」：首次显示时定好位置，然后上**大锁**（相对屏幕锁死 ⇒ 之后不跟导图跑 ✓）。
    // 界面上**不显示**锁按钮（用户明确说不需要）—— 行为有、按钮无 ✓
    const newlyShown = !box.__placed;
    if (newlyShown) {
      box.__placed = true;
      // 摆在一个"舒服"的默认位置（右侧偏上，避开工具条与详情框）
      const pw = window.innerWidth, ph = window.innerHeight;
      const bw = box.el.offsetWidth || 380, bh = box.el.offsetHeight || 320;
      box.el.style.left = Math.max(12, Math.round(pw * 0.52) - Math.round(bw / 2)) + 'px';
      box.el.style.top = Math.max(12, Math.round(ph * 0.18)) + 'px';
      if (box.lock !== MM.FD_LOCK.SCREEN) MM.setFdBoxLock(box, MM.FD_LOCK.SCREEN);
    }
    setTimeout(() => { if (box.el.parentElement) MM.positionFdBox(box); }, 40);
    if (kind === 'explain') send(box, '', 'explain');
    else if (o.focus) setTimeout(() => { const i = box.el.querySelector('.ask-input'); if (i) i.focus(); }, 60);
    return box;
  }

  /** 渲染整个问答框（标题 + 问答流水 + 输入行）。**同一次问答的流水只在这里长出来** ✓ */
  function renderAskPage(box) {
    if (!box || !box.el) return null;
    const project = (state().project && state().project.name) || '?';
    const node = box.node || { id: null, topic: '「' + project + '」' };
    const st = box.ask || (box.ask = { kind: 'ask', log: [] });
    MM.fdQ(box, '.fd-title').textContent = box.node
      ? ((st.kind === 'explain' ? 'AI 解释：' : 'AI 问答：') + node.topic)
      : ('AI 助手 · ' + project);
    // 只留正文容器（详情框模板里的其它容器对本框无意义 ⇒ 清空，免得出现"图片（0）"这类空壳）
    ['fd-tags', 'fd-localpath', 'fd-images-content', 'fd-files-content'].forEach((c) => {
      const el = MM.fdQ(box, '.' + c); if (el) el.innerHTML = '';
    });
    const dc = MM.fdQ(box, '.fd-detail-content');
    const md = MM.mdBlock || ((t) => (MM.escHtml(t) || ''));
    let html = '<div class="ask-hint">每问一次都是一次独立会话（答完即止，不延续上下文）。'
      + '想接着聊，就在下面再问一句。</div>';
    // ⚠️ 空框**不能**显示"正在生成…"：那看着像"AI 已经先开口了"（用户实测反馈 ✗）。
    //    只有真的发出去了（有 pending 条目）才显示；空框给一句"请你先问" ✓
    if (!st.log.length) {
      html += st.kind === 'explain'
        ? '<div class="ask-item ask-pending"><span class="ask-who">AI</span>正在生成…</div>'
        : '<div class="ask-item ask-empty">在下面输入你的问题，按 Enter 发送（我只会回答你问的 ✓）。</div>';
    }
    const raw = null;   // （占位已弃用，见下）
    st.log.forEach((e) => {
      if (e.q) html += '<div class="ask-item ask-q"><span class="ask-who">你</span>' + md(e.q) + '</div>';
      if (e.pending) html += '<div class="ask-item ask-a ask-pending"><span class="ask-who">AI</span>正在生成…</div>';
      // AI 的回答按 **Markdown 整段**渲染（加粗/列表/代码都出来）—— 用户反馈"全局 ** 不渲染"的根因就在这 ✓
      else if (e.a) html += '<div class="ask-item ask-a"><span class="ask-who">AI</span>' + md(e.a) + '</div>';
      if (e.err) html += '<div class="ask-item ask-err"><span class="ask-who">!</span>' + esc(e.err) + '</div>';
      if (e.stub) html += '<div class="ask-stub">（冒烟桩：未调用模型，仅验证链路）</div>';
    });
    html += '<div class="ask-inputrow">'
      + '<input class="ask-input" type="text" placeholder="问一句…（Enter 发送）" />'
      + '<button type="button" class="ask-send">发送</button></div>';
    dc.innerHTML = html;
    const input = dc.querySelector('.ask-input');
    const sendBtn = dc.querySelector('.ask-send');
    const fire = () => { const q = input.value.trim(); if (!q) return; input.value = ''; send(box, q, 'ask'); };
    sendBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fire(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fire(); }
      else e.stopPropagation();   // 别让导图的快捷键吃掉输入
    });
    const rl = MM.fdQ(box, '.fd-related'); if (rl) rl.innerHTML = '';
    const al = MM.fdQ(box, '.fd-assoc'); if (al) al.innerHTML = '';
    return dc;
  }

  /** 发一次提问：先落 Q（pending），成功后补 A；失败**如实显示**错误 ✓ */
  function send(box, question, kind) {
    const project = state().project && state().project.name;
    const nodeId = box && box.node ? box.node.id : null;   // null = 项目级提问（消息栏那条 ✓）
    if (!project) return Promise.resolve(null);
    const st = box.ask || (box.ask = { kind: kind, log: [] });
    st.kind = kind === 'explain' ? 'explain' : st.kind;
    const entry = { q: question || '', pending: true };
    st.log.push(entry);
    renderAskPage(box);
    const api = window.desktop && window.desktop.app && window.desktop.app.ask;
    if (!api) { entry.pending = false; entry.err = '没有 desktop.app.ask（preload 没接上）'; renderAskPage(box); return Promise.resolve(null); }
    return Promise.resolve(api(project, nodeId, { kind: kind, question: question || undefined }))
      .then((r) => {
        entry.pending = false;
        if (r && r.ok) { entry.a = r.text; entry.stub = !!r.stub; entry.ms = r.ms; }
        else entry.err = (r && r.error) || '未知错误';
        renderAskPage(box);
        return r;
      })
      .catch((err) => {
        entry.pending = false;
        entry.err = (err && err.message) || String(err);
        renderAskPage(box);
        return null;
      });
  }

  /* ================= 下方消息栏（功能 5a 入口③） =================
   * 用户原话：「在下方消息栏上方有一些虚体字，写『或者你可以直接向我描述要导入什么』，
   * 如果用户向里输入，就认为用户在向内嵌 DSH 发送提示词，自动补充情境信息」✓
   * ⇒ 这里只做"把文字送出去 + 把答案放回浮窗"；**情境由 CLI 侧补齐**（当前项目、可用 CLI、
   *    没有选中节点这件事 —— 见 src/dsh-ask.js 的 buildContextBlock）✓ 单一真源。 */
  function bindMsgBar() {
    const input = document.getElementById('msg-input');
    const btn = document.getElementById('msg-send');
    if (!input || !btn) return false;
    const fire = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      const box = showAskBox(null, { kind: 'ask' });   // 项目级（无节点）浮窗 ✓
      if (box) send(box, q, 'ask');
      else if (MM.setStatus) MM.setStatus('没有打开的项目，发不出去', true);
    };
    btn.addEventListener('click', (e) => { e.preventDefault(); fire(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fire(); }
      else e.stopPropagation();   // 别让导图快捷键吃掉输入
    });
    return true;
  }
  bindMsgBar();

  MM.showNodeToolbar = showBarFor;
  MM.hideNodeToolbar = hideBar;
  MM.isNodeToolbarVisible = isBarVisible;
  MM.computeBarPos = computeBarPos;          // 纯几何（单测）
  MM.showAskBox = showAskBox;
  MM.renderAskPage = renderAskPage;
  MM.askBoxes = () => askBoxes.filter((b) => b.el && b.el.parentElement);

  /* ================= 接在"选中节点"这件事上 =================
   * 钩子点选择与理由：本工程里"选中一个节点"的**唯一标志**是它有了详情框（`MM.showDetail`），
   * 单击节点、命令行面板跳转、关联页面点成员、命令面板跳转……最后都走它 ✓
   * ⇒ 包住这一个入口就覆盖了所有"选中"路径（不必去每个调用点加代码，那种做法必漏 ✗）。
   * 关框同理包 `MM.closeFdBox`（工具条不该在节点已取消选中后还杵着）。
   * ⚠️ 包之前先存原函数，包之后**必须**把返回值原样透传（有调用方依赖它的返回值）。 */
  const origShowDetail = MM.showDetail;
  if (origShowDetail) {
    MM.showDetail = function (node) {
      const r = origShowDetail.apply(this, arguments);
      try { if (node && node.id) showBarFor(node.id); } catch (e) { /* 工具条失败不该影响详情框 */ }
      return r;
    };
  }
  const origCloseFdBox = MM.closeFdBox;
  if (origCloseFdBox) {
    MM.closeFdBox = function (box) {
      const r = origCloseFdBox.apply(this, arguments);
      try {
        // 关掉的是**当前工具条对应**的节点、或所有详情框都关了 ⇒ 收起工具条。
        // ⚠️ AI 问答框（kind==='ask'）**不算**：它关掉不该连带收起工具条（用户还要继续点「解释」✓）
        const stillOpen = (MM.getFloatDetailState ? MM.getFloatDetailState().boxes : 0) > 0;
        if (!stillOpen) hideBar();
        else if (box && box.kind !== 'ask' && box.node && curNodeId && box.node.id === curNodeId) hideBar();
      } catch (e) { /* 同上 */ }
      return r;
    };
  }

  /* ⑧ 点击**其它地方** ⇒ 关掉 AI 浮窗（并收起工具条）。用户原话：
   *    "应该是点击其他地方之后那个悬浮窗就消失了而不是像现在这样一直显示" ✓
   * 两个必须排除的区域：工具条自己（否则点「问问AI」会先把框关掉 ✗）与浮窗内部 ✓ */
  function closeAskBoxes() {
    let n = 0;
    askBoxes.slice().forEach((b) => {
      if (b.el && b.el.parentElement) { MM.closeFdBox(b); n++; }
    });
    return n;
  }
  document.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.closest && (t.closest('#mm-node-toolbar') || t.closest('.fd-ask-box'))) return;
    if (!askBoxes.some((b) => b.el && b.el.parentElement)) {
      if (isBarVisible()) hideBar();     // 只开着的工具条：点别处也收起 ✓
      return;
    }
    closeAskBoxes();
    hideBar();
  }, true);
})();
