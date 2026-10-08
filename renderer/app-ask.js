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
  let curNodes = [];      // 工具条当前作用的节点集合（单节点 ⇒ 1 个；有选区 ⇒ 整批 ✓）

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
      + ' title="向内置 AI 提问（浮窗里输入问题）">💬 问问AI</button>'
      // ⑨ 把所选节点的上下文**直接送进右侧 DSH 侧栏输入框**（不代替你发送 ✗ —— 那边按了发送才进它的会话历史 ✓）
      + '<button type="button" class="mm-tb-btn mm-tb-side" data-act="side"'
      + ' title="把所选节点的上下文送进右侧 DSH 侧栏输入框（到那边按发送；发了就进它的会话历史）">⇥ 侧栏</button>';
    document.body.appendChild(barEl);
    barEl.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('.mm-tb-btn') : null;
      if (!btn || !curNodes.length) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.getAttribute('data-act');
      if (act === 'side') { sendNodesToSidebar(curNodes.slice()); return; }   // ⑨
      // 单节点 ⇒ 走原来的单节点问答；多节点（框选/Ctrl+多选）⇒ 把**整批**交给 AI ✓（反馈④）
      showAskBox(curNodes.length === 1 ? curNodes[0] : null, {
        kind: act === 'explain' ? 'explain' : 'ask',
        nodes: curNodes.slice(),
        focus: act !== 'explain'
      });
    });
    return barEl;
  }

  /** 工具条当前作用的**节点集合**：单节点详情 ⇒ [该节点]；有选区 ⇒ 整个选区（④"把所有被框选的都给 AI"✓） */
  function barTargets() {
    if (MM.hasSelection && MM.hasSelection()) {
      // ④ 用**原始命中集**（未裁剪）：用户框住几个，AI 就看几个 ✓
      const raw = MM.getSelectionRaw ? MM.getSelectionRaw() : (MM.getSelection ? MM.getSelection() : []);
      return raw.filter(Boolean);
    }
    return curNodeId ? [curNodeId] : [];
  }

  /** 显示工具条。
   *  · 单节点：贴在该节点上方 ✓
   *  · **有选区（框选/Ctrl+多选）**：贴在选区**外接矩形**上方，按钮上显示节点数 ✓
   *    （用户反馈④：框选之后就想要"把这些都给 AI 看"，所以这里**不再**回避选区 ✗→✓） */
  function showBarFor(nodeId) {
    const sel = barTargets();
    const ids = sel.length ? sel.filter(Boolean) : (nodeId ? [nodeId] : []);
    if (!ids.length) { hideBar(); return null; }
    curNodeId = ids.length === 1 ? ids[0] : null;
    curNodes = ids.slice();
    const bar = ensureBar();
    const rects = ids.map((id) => {
      const el = nodeEl(id);
      return el ? el.getBoundingClientRect() : null;
    }).filter(Boolean);
    if (!rects.length) { hideBar(); return null; }
    const box = rects.reduce((a, r) => ({
      left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
      right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
      width: 0, height: 0
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    bar.style.display = 'flex';
    const explain = bar.querySelector('.mm-tb-explain'), ask = bar.querySelector('.mm-tb-ask');
    const n = ids.length;
    if (explain) explain.textContent = n > 1 ? ('💡 解释 ' + n + ' 个') : '💡 解释';
    if (ask) ask.textContent = n > 1 ? ('💬 问这 ' + n + ' 个') : '💬 问问AI';
    const bw = bar.offsetWidth || 150, bh = bar.offsetHeight || 30;
    const pos = computeBarPos({ left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      width: box.right - box.left, height: box.bottom - box.top },
      bw, bh, { w: window.innerWidth, h: window.innerHeight });
    bar.style.left = pos.left + 'px';
    bar.style.top = pos.top + 'px';
    bar.setAttribute('data-node', ids.join(','));
    bar.setAttribute('data-count', String(n));
    return pos;
  }

  function hideBar() {
    if (barEl) barEl.style.display = 'none';
    curNodeId = null;
    curNodes = [];
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
    // ④ 多节点：一次可以对**整批选中**提问（`opts.nodes` = id 数组 ✓）
    const nodes = Array.isArray(o.nodes) ? o.nodes.filter(Boolean) : (nodeId ? [nodeId] : []);
    const key = nodes.length > 1 ? ('__multi__' + nodes.slice().sort().join(',')) : (nodes[0] || '__project__');
    let box = askBoxes.find((b) => b.__key === key && b.el && b.el.parentElement);
    if (!box) {
      box = MM.createFdBox();
      box.kind = 'ask';
      box.__key = key;
      box.el.setAttribute('data-kind', 'ask');
      box.el.classList.add('fd-ask-box');   // CSS 里据此**隐藏大小锁**（悬浮窗不需要锁 ✓ 用户反馈⑧）
      askBoxes.push(box);
    }
    box.nodes = nodes.slice();
    box.node = (nodes.length === 1 && state().jm) ? state().jm.get_node(nodes[0]) : null;
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
    const nCount = (box.nodes || []).length;
    const st = box.ask || (box.ask = { kind: 'ask', log: [] });
    const titleText = nCount > 1
      ? ((st.kind === 'explain' ? 'AI 解释：' : 'AI 问答：') + nCount + ' 个节点')
      : (box.node
        ? ((st.kind === 'explain' ? 'AI 解释：' : 'AI 问答：') + node.topic)
        : ('AI 助手 · ' + project));
    box.title = titleText;                     // ⑩ 送去侧栏时要带上"这是在谈哪个节点" ✓
    MM.fdQ(box, '.fd-title').textContent = titleText;
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
      // 思考强度（用户反馈③："对话栏里要可以手动设置"）：解释默认low、问答默认medium；改了就影响**下一次**提问 ✓
      + '<select class="ask-effort" title="思考强度：越高越慢但更细致；改完对下一次提问生效">'
      + '<option value="low">思考：低（快）</option><option value="medium">思考：中</option>'
      + '<option value="high">思考：高</option><option value="xhigh">思考：很高</option></select>'
      + '<button type="button" class="ask-send">发送</button>'
      // ⑩「在侧边栏打开」：把这段对话（含 AI 的回答）预填进侧栏输入框，之后由你在侧栏按发送 ✓
      //    ⇒ 那段对话就落进侧栏那个会话的工作区历史里 ✓（这里**不代替你发送** ✗）
      + '<button type="button" class="ask-to-sidebar" title="把这段对话送进右边的 DSH 侧栏输入框（由你在那边按发送；发了就进它的会话历史）">⇥ 侧边栏</button>'
      + '</div>';
    dc.innerHTML = html;
    const input = dc.querySelector('.ask-input');
    const sendBtn = dc.querySelector('.ask-send');
    const sideBtn = dc.querySelector('.ask-to-sidebar');
    if (sideBtn) {
      sideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const st1 = box.ask || {};
        const lines = ['【来自 AI MindMap 的对话】'];
        if (box.title) lines.push('节点：' + box.title);
        (st1.log || []).forEach((it) => {
          if (it.q) lines.push('我：' + it.q);
          if (it.a) lines.push('AI：' + it.a);
        });
        lines.push('（接着上面这段继续 —— 这是从 AI MindMap 的对话窗口送过来的上下文。）');
        const api = (window.desktop && window.desktop.dsh && window.desktop.dsh.prefill);
        if (!api) { MM.setStatus('这个版本没有侧栏通道', true); return; }
        sideBtn.disabled = true;
        Promise.resolve(api(lines.join('\n'))).then((r) => {
          sideBtn.disabled = false;
          if (r && r.ok) MM.setStatus('已送进侧栏输入框（' + (r.textLen || 0) + ' 字）—— 到右边按发送即可 ✓');
          else MM.setStatus('没送进侧边栏：' + ((r && r.reason) || '未知原因'), true);
        }).catch((err) => {
          sideBtn.disabled = false;
          MM.setStatus('没送进侧边栏：' + ((err && err.message) || err), true);
        });
      });
    }
    const effortSel = dc.querySelector('.ask-effort');
    if (effortSel) {
      effortSel.value = st.effort || MM.DEFAULT_ASK_EFFORT || 'low';
      effortSel.addEventListener('change', () => { st.effort = effortSel.value; });
    }
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
    const ids = (box && box.nodes) || [];
    const nodeId = (box && box.node) ? box.node.id : (ids.length === 1 ? ids[0] : null);   // null = 项目级提问
    if (!project) return Promise.resolve(null);
    const st = box.ask || (box.ask = { kind: kind, log: [] });
    st.kind = kind === 'explain' ? 'explain' : st.kind;
    // 思考强度默认：解释 low（"解释的时候自动降低思考强度增加速度"✓）、问答 medium；界面可改 ✓
    if (!st.effort) st.effort = (kind === 'explain' || st.kind === 'explain') ? 'low' : 'medium';
    const entry = { q: question || '', pending: true };
    st.log.push(entry);
    renderAskPage(box);
    const api = window.desktop && window.desktop.app && window.desktop.app.ask;
    if (!api) { entry.pending = false; entry.err = '没有 desktop.app.ask（preload 没接上）'; renderAskPage(box); return Promise.resolve(null); }
    return Promise.resolve(api(project, nodeId, {
      kind: kind, question: question || undefined, effort: st.effort,
      nodes: ids.length > 1 ? ids : undefined          // ④ 多节点：整批交给 AI ✓
    }))
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

  /** ⑨ 把所选节点（单节点也可）的上下文送进侧栏输入框。
   *  ⚠️ **不代替你发送** ✗：谁按发送谁负责 —— 那边按下去，这段才真正进入该会话的工作区历史 ✓。
   *  失败一律**说出来**（侧栏没开 / 服务没跑 / 找不到输入框 ✓ 由主进程给原因）✓ */
  function sendNodesToSidebar(ids) {
    const jm = state().jm;
    const st = (MMApp && MMApp.getState) ? MMApp.getState() : null;
    const project = (st && st.project && st.project.name) || '?';
    if (!jm || !ids || !ids.length) return Promise.resolve(null);
    const conv = window.MMConvert || {};
    const lines = ['【来自 AI MindMap·' + project + '】' + (ids.length > 1 ? ('以下 ' + ids.length + ' 个节点') : '以下节点') + '：'];
    ids.forEach((id, k) => {
      const n = jm.get_node(id);
      if (!n) return;
      lines.push('');
      lines.push((ids.length > 1 ? ((k + 1) + '. ') : '') + (n.topic || '(无标题)'));
      const tags = Array.isArray(n.tags) ? n.tags : [];
      if (tags.length) lines.push('   标签：' + tags.join('、'));
      const plain = conv.stripHtml ? String(conv.stripHtml(n.detail || '')).replace(/\s+/g, ' ').trim() : '';
      if (plain) lines.push('   正文：' + plain.slice(0, 600));
    });
    lines.push('');
    lines.push('（这些是我这边的上下文；接着我想问 —— 你按需回答即可。）');
    const api = (window.desktop && window.desktop.dsh && window.desktop.dsh.prefill);
    if (!api) { MM.setStatus('这个版本没有侧栏通道', true); return Promise.resolve(null); }
    MM.setStatus('正在送进侧栏…');
    return Promise.resolve(api(lines.join('\n'))).then((r) => {
      if (r && r.ok) MM.setStatus('已把 ' + ids.length + ' 个节点送进侧栏输入框（' + (r.textLen || 0) + ' 字）—— 到右边按发送 ✓');
      else MM.setStatus('没送进侧边栏：' + ((r && r.reason) || '未知原因'), true);
      return r;
    }).catch((err) => {
      MM.setStatus('没送进侧边栏：' + ((err && err.message) || err), true);
      return null;
    });
  }

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
