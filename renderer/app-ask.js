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
    const n = MM.adapter.available(jm) ? MM.adapter.getNode(jm, id) : null;
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
    // ⚠️ 挂在**与详情框同级**的卫星浮层里（不是 document.body 的 fixed 顶层）：位置才能由框的几何
    //    推导，且拖动框时与框同一次合成 ⇒ 零滞后（"用户报过浮动"那条教训的解法 ✓）。
    //    拿不到浮层（没有打开的项目/没有面板）才退回 body —— **不静默**：data-anchor 会写出来 ✓
    const satLayer = MM.fdSatLayer ? MM.fdSatLayer() : null;
    (satLayer || document.body).appendChild(barEl);
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

  /** 工具条当前作用的**节点集合**（**唯一判据**；改前它的显隐散在 5 处 ✗）：
   *   ① 有选区 ⇒ 整个选区（④"把所有被框选的都给 AI" ✓，用**原始命中集**未裁剪 ✓）；
   *   ② 否则**以框池为准**：当前最上面的节点详情框挂的是谁就是谁 —— 这正是"和节点详情严格绑定"：
   *      框一出现它就有目标、框一关目标就空（自动收起 ✓），于是不再需要包 MM.showDetail /
   *      MM.closeFdBox 那两条猴子补丁 ✗；
   *   ③ 再没有 ⇒ 用显式指定的目标（MM.showNodeToolbar(id) 这条既有 API；它只在**没有可见节点
   *      详情框**时生效 ⇒ 不会出现"过期的显式目标压过真实框"这种漂移 ✓）。 */
  function barTargets() {
    if (MM.hasSelection && MM.hasSelection()) {
      const raw = MM.getSelectionRaw ? MM.getSelectionRaw() : (MM.getSelection ? MM.getSelection() : []);
      return raw.filter(Boolean);
    }
    const box = MM.fdPrimaryNodeBox ? MM.fdPrimaryNodeBox() : null;
    if (box && box.node) return [box.node.id];
    return forcedTargets ? forcedTargets.slice() : [];
  }

  /** 显式目标（`MM.showNodeToolbar(id)` 设置）。为什么需要：既有 API 与冒烟会在**没有详情框**时
   *  直接点它（scripts/smoke/26-ai-ask.js 的「⇥ 侧栏」那条）。hideBar() 会清掉它 ✓ */
  let forcedTargets = null;

  /** 显示工具条。
   *  · 单节点：贴在该节点上方 ✓
   *  · **有选区（框选/Ctrl+多选）**：贴在选区**外接矩形**上方，按钮上显示节点数 ✓
   *    （用户反馈④：框选之后就想要"把这些都给 AI 看"，所以这里**不再**回避选区 ✗→✓） */
  /** 显式指定工具条的目标（既有 API）。**只记目标**，显隐与位置一律由唯一的 layoutNodeToolbar 算 ✓ */
  function showBarFor(nodeId) {
    forcedTargets = nodeId ? [nodeId] : null;
    return syncNodeToolbarNow();
  }

  /** 立即按唯一判据重算一次（薄壳：真正的实现在 layoutNodeToolbar，由 MM.syncFdSatellites 调用） */
  function syncNodeToolbarNow() {
    if (MM.syncFdSatellites) MM.syncFdSatellites();
    return lastBarPos;
  }

  /** **工具条落位的唯一实现**（由 MM.syncFdSatellites 调用；别在别处再算一遍 ✗）。
   *  两种锚，规则不同，但都从**同一批几何**推导：
   *   ① **框锚**（有节点详情框、且未上大小锁）：贴框**下缘外侧**、水平居中于框 ——
   *      默认档位是框 frame 的纯函数 ⇒ 拖动框时相对坐标恒定（"不许浮动或滞后"✓）。
   *      为什么默认放下方而不是上方：框出现在"节点下方 +8px"处，放上方会**整个盖住节点** ✗
   *      （节点底边 = 框顶边 − 8，而工具条约 30px 高 ⇒ 会压住节点 22px）；下方是空画布 ✓。
   *      ⚠️ **有兜底档位**：下方放不下就翻到框**上缘外侧**，上下都放不下才**夹进面板**
   *      —— 档位按 below → above → clamp 依次退化，并写进 `data-place`（断言读它 ⇒ 不静默 ✗）。
   *      为什么必须有兜底：框可以很高（实测内容多的节点框底到 1025px，而面板只有 795px）⇒
   *      "只放下方、放不下就让它被裁掉"会把工具条推到面板外 = **看不见**（与圆钮那个真 bug
   *      同一类损害 ✗）。本工程已有实测教训"翻转 ⇒ 上下区间跳"，所以**只有真的放不下时才翻** ✓。
   *      水平方向同理：**每一档都**夹进 `[4, viewW - bw - 4]`（不夹会让它跑出视口被裁掉）。
   *   ② **节点锚**（只有选区、没有详情框）：沿用原规则（贴选区外接矩形上方 + 夹进视口），
   *      仍走既有的纯函数 computeBarPos（单测覆盖不变 ✓）—— 这是它的"各自规则"，
   *      scripts/smoke/29-multiselect.js ④ 明确要求"有选区时工具条必须出现并写明整批"✓。
   *  大小锁 ⇒ 目标框的 plan.toolbar=false ⇒ **收起工具条**（圆钮不受影响，由 layoutRelShowBtn 管 ✓）。 */
  function layoutNodeToolbar(layer, frames, view) {
    const list = frames || [];
    const bar = ensureBar();
    const ids = barTargets();
    if (!ids.length) { hideBar(); return null; }
    curNodeId = ids.length === 1 ? ids[0] : null;
    curNodes = ids.slice();
    const n = ids.length;
    let host = null;
    if (curNodeId) {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (f.box && f.box.kind === 'node' && f.box.node && f.box.node.id === curNodeId) { host = f; break; }
      }
      if (host && !host.plan.toolbar) { hideBar(); return null; }   // ★ 大小锁：关工具栏（保留圆钮）
    }
    const explain = bar.querySelector('.mm-tb-explain'), ask = bar.querySelector('.mm-tb-ask');
    if (explain) explain.textContent = n > 1 ? ('💡 解释 ' + n + ' 个') : '💡 解释';
    if (ask) ask.textContent = n > 1 ? ('💬 问这 ' + n + ' 个') : '💬 问问AI';
    bar.style.display = 'flex';
    // ⚠️ 必须先显示再量 offsetWidth（display:none 时量到 0，兜底值会让位置偏 ✗）
    const bw = bar.offsetWidth || 150, bh = bar.offsetHeight || 30;
    let pos;
    if (host && host.frame) {
      const fr = host.frame;
      // ★ 贴框**下缘外侧**、水平居中于框；**放不下就翻到框上缘外侧**，再放不下才夹进面板。
      //   为什么必须有兜底：框可以很高（实测内容多的节点框底到 1025px，而面板只有 795px）⇒
      //   "只放下方"会把工具条推到面板外被裁掉 = **看不见**（与圆钮那个真 bug 同一类损害 ✗）。
      //   为什么默认放下方：框出现在"节点下方 +8px"处，放上方会**整个盖住节点** ✗
      //   （节点底边 = 框顶边 − 8，而工具条约 30px 高 ⇒ 会压住节点）。
      //   为什么默认档**竖向**不夹取：本工程已有实测教训"翻转 ⇒ 上下区间跳"（见 app-detail.js 的 positionFdBox），
      //   故**只有真的放不下时才翻**，并把档位写进 data-place（断言读它 ⇒ 不静默 ✗）。
      const wantLeft = Math.round(fr.x + fr.w / 2 - bw / 2);
      const below = Math.round(fr.y + fr.h + 6);
      const above = Math.round(fr.y - bh - 6);
      const viewH = (view && view.h) || window.innerHeight;
      const viewW = (view && view.w) || window.innerWidth;
      let place;
      if (below + bh <= viewH - 4) { pos = { left: wantLeft, top: below }; place = 'below'; }
      else if (above >= 4) { pos = { left: wantLeft, top: above }; place = 'above'; }
      else {
        // 上下都放不下（框比面板还高）⇒ 夹进面板（宁可压住框边，也不能看不见 ✓）
        pos = { left: wantLeft, top: Math.max(4, Math.min(below, viewH - bh - 4)) };
        place = 'clamp';
      }
      // 水平方向**每一档都夹**进 `[4, viewW - bw - 4]`：竖档位换来的是"跟着框走"，
      //  而水平越界只有一个后果 —— 跑到面板外被裁掉 = 看不见（与竖档位为它让步的那件事同源）。
      //  （代价如实写：框贴着面板左右缘时，工具条的横向相对位置会被钉在边上；
      //    这是有意的取舍 —— 宁可位置"不完全跟随"，也不能让它消失 ✗）
      if (pos.left < 4) pos.left = 4;
      if (pos.left + bw > viewW - 4) pos.left = Math.max(4, viewW - bw - 4);
      bar.setAttribute('data-place', place);
      bar.setAttribute('data-anchor', 'box');
      bar.setAttribute('data-anchor-box', (host.box.el && host.box.el.dataset.boxId) || '');
    } else {
      const lr = layer.getBoundingClientRect();
      const rects = ids.map((id) => {
        const el = nodeEl(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left - lr.left, top: r.top - lr.top, right: r.right - lr.left, bottom: r.bottom - lr.top };
      }).filter(Boolean);
      if (!rects.length) { hideBar(); return null; }
      const u = rects.reduce((a, r) => ({
        left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
        right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom)
      }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      pos = computeBarPos({ left: u.left, top: u.top, right: u.right, bottom: u.bottom,
        width: u.right - u.left, height: u.bottom - u.top },
        bw, bh, { w: view ? view.w : window.innerWidth, h: view ? view.h : window.innerHeight });
      bar.setAttribute('data-anchor', 'nodes');
      bar.removeAttribute('data-anchor-box');
    }
    bar.style.left = pos.left + 'px';
    bar.style.top = pos.top + 'px';
    bar.setAttribute('data-node', ids.join(','));
    bar.setAttribute('data-count', String(n));
    lastBarPos = pos;
    return pos;
  }
  let lastBarPos = null;

  /** 唯一的"收起"原语。**同时清掉显式目标**（否则收起之后下一次同步又把它拉回来 ✗）。 */
  function hideBar() {
    if (barEl) {
      barEl.style.display = 'none';
      barEl.setAttribute('data-anchor', 'off');
    }
    curNodeId = null;
    curNodes = [];
    forcedTargets = null;
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
    box.node = (nodes.length === 1 && state().jm) ? MM.adapter.getNode(state().jm, nodes[0]) : null;
    box.ask = { kind: kind, log: (box.ask && box.ask.log) || [] };
    box.el.style.display = 'flex';
    MM.bringFdBoxToFront(box);
    // R6⑤「下次会话展示」：这次**打开**只读一次本机反馈库（摘要条长在框顶）。
    //   为什么每次打开都读：重开会话 = 新框 = 再读 ⇒ 摘要对得上的永远是库里的最新 ✓；
    //   为什么打开后不再读：摘要是"会话开场"的信息，读到什么就展示什么（域 50 有"改读内存必红"的判别力）。
    if (!box.__fbLoaded) { box.__fbLoaded = true; loadFeedbackSummary(box); }
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
    // 落盘结果（A）：**必须留在框里**，因为状态栏那句会被下一条动作覆盖 ——
    // 用户与断言都要能回答"这条回答到底有没有写进去"（只在 setStatus 里说 = 说过就没了 ✗）。
    const writeNote = st.lastWrite || null;
    // R6⑤：摘要条的内容 = 打开这个会话时从反馈库读到的那一份（box.__fbSummary，见 loadFeedbackSummary）。
    //   没有反馈记录 ⇒ 返回空串 ⇒ 这一段对最终 HTML 零贡献（默认档逐字节同从前 ✓）。
    let html = feedbackSummaryHtml(box.__fbSummary)
      + '<div class="ask-hint">每问一次都是一次独立会话（答完即止，不延续上下文）。'
      + '想接着聊，就在下面再问一句。</div>'
      + (writeNote
        ? '<div class="ask-write-note' + (writeNote.ok ? '' : ' ask-write-err') + '">'
          + esc(writeNote.text) + '</div>'
        : '');
    // ⚠️ 空框**不能**显示"正在生成…"：那看着像"AI 已经先开口了"（用户实测反馈 ✗）。
    //    只有真的发出去了（有 pending 条目）才显示；空框给一句"请你先问" ✓
    if (!st.log.length) {
      html += st.kind === 'explain'
        ? '<div class="ask-item ask-pending"><span class="ask-who">AI</span>正在生成…</div>'
        : '<div class="ask-item ask-empty">在下面输入你的问题，按 Enter 发送（我只会回答你问的 ✓）。</div>';
    }
    const raw = null;   // （占位已弃用，见下）
    st.log.forEach((e, i) => {
      if (e.q) html += '<div class="ask-item ask-q"><span class="ask-who">你</span>' + md(e.q) + '</div>';
      if (e.pending) html += '<div class="ask-item ask-a ask-pending"><span class="ask-who">AI</span>正在生成…</div>';
      // AI 的回答按 **Markdown 整段**渲染（加粗/列表/代码都出来）—— 用户反馈"全局 ** 不渲染"的根因就在这 ✓
      else if (e.a) html += '<div class="ask-item ask-a"><span class="ask-who">AI</span>' + md(e.a) + '</div>';
      if (e.err) html += '<div class="ask-item ask-err"><span class="ask-who">!</span>' + esc(e.err) + '</div>';
      if (e.stub) html += '<div class="ask-stub">（冒烟桩：未调用模型，仅验证链路）</div>';
      // ★ A（用户要求）：**AI 产出直接落到节点与详情** —— 每条回答下面两个动作。
      //   只对有回答、没出错的条目出现（"正在生成"时不该给按钮 = 不许把没生成完的东西写进数据 ✗）。
      //   两个动作都**只发意图**，真正的写盘在 `app:ask-apply` ⇒ CLI `ask-apply`（渲染层不直接改盘 ✓）。
      if (e.a && !e.pending && !e.err) {
        html += '<div class="ask-acts" data-act-index="' + i + '">'
          + '<button type="button" class="ask-act ask-act-detail" data-act="detail"'
          + ' title="把这条回答追加到本节点详情末尾（带来源标记与时间；写盘走 CLI，写后回读）">'
          + '📥 写入本节点详情</button>'
          + '<button type="button" class="ask-act ask-act-child" data-act="child"'
          + ' title="用这条回答在本节点下新建一个子节点（标题取首行，详情放全文）">'
          + '🌱 新建子节点</button>'
          // R6①：五星评价（星 = 抽象的满意/不满意评价 ✗ 不是"多少详细"的旋钮）。
          //   只在有真回答的条目出现 ✓；点星即刻落库，随后弹反馈框（可关 = 这次不反馈 ✗ 不强制）。
          + askStarsHtml(e, i)
          + '</div>';
      }
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
    // ★ A：两个落盘动作的事件接线（**委托**到容器：renderAskPage 每次重渲染都会重建按钮，
    //   逐个绑监听会漏掉重建后的那些 ⇒ 只有委托是稳的 ✓）
    dc.querySelectorAll('.ask-acts').forEach((row) => {
      row.addEventListener('click', (e) => {
        // R6① 星标先分流（星长在同一动作行里，但它不是落盘动作 ⇒ 别落到下面 .ask-act 的分支 ✗）
        const starBtn = e.target && e.target.closest ? e.target.closest('.ask-star') : null;
        if (starBtn && row.contains(starBtn)) {
          e.preventDefault();
          e.stopPropagation();
          handleStarClick(box, Number(row.getAttribute('data-act-index')), Number(starBtn.getAttribute('data-star')));
          return;
        }
        const btn = e.target && e.target.closest ? e.target.closest('.ask-act') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        writeBack(box, Number(row.getAttribute('data-act-index')), btn.getAttribute('data-act'));
      });
    });
    // R6⑤ 摘要条的「✕ 收起」（可关 ✗ 不强制看；只收这一条显示，不删库里的任何记录 ✓）
    const sumClose = dc.querySelector('.ask-fb-sum-close');
    if (sumClose) {
      sumClose.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        box.__fbSummary = null;                    // 收起 ⇒ 本次打开内不再回来（重开会话会照库里再展示 ✓）
        const strip = dc.querySelector('.ask-fb-summary');
        if (strip && strip.parentElement) strip.parentElement.removeChild(strip);
      });
    }
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

  /* ================= A：把 AI 回答落到节点上（详情 / 子节点） =================
   * 用户的立场（原话）：**AI 产出直接落到节点与详情** ⇒ 这里做的正是那半截。
   *
   * 三条纪律（每条都有理由，别省）：
   *   ① **写操作只经 CLI**：渲染层只发意图（`app:ask-apply` → `cli ask-apply`），
   *      闸门校验 / 原子写 / 并发版本闸门 / 写后回读全在那一边 —— 渲染层不碰盘 ✗；
   *   ② **一次动作一次原子写**：qa 记录与 detail 追加、以及子节点，都在**同一条 CLI 命令**里
   *      完成（分两次写盘会留下"记了流水没写详情"这种自相矛盾的数据）；
   *   ③ **写到哪就同步到哪**：拿主进程回读回来的真值（`qa` / `detail`）覆盖内存里的那一份，
   *      再请渲染层按磁盘重读一次（新子节点要出现在导图上）——
   *      少了这一步，下一次界面保存会拿旧内存把刚落盘的问答抹掉 ✓（与 assoc-edit 同一条纪律）。
   *      ⚠️ 这一步有三个不能省的细节（写错对象 / 基线没说名字 / 子节点没搬上树），
   *      每一条都对应一个实测缺陷 ⇒ 实现只有一处：`syncMemoryAfterWriteBack`（见它头顶的说明）。
   *
   * 失败一律**说出来**（状态栏 + 框里留痕）✗ 不许静默。
   * 空回答也在这里挡住（按钮只在有回答时出现，这是第二道）。
   */
  function writeBack(box, index, act) {
    // ⚠️ 一次性把"当前这条"解析出来（**不要**把 `box.ask` 存成局部量再用到异步之后 —— 见下）
    const st0 = box.ask || (box.ask = { kind: 'ask', log: [] });
    const entry = (st0.log || [])[index];
    const api = window.desktop && window.desktop.app && window.desktop.app.askApply;
    if (!api) { MM.setStatus('这个版本没有把问答落盘的通道（preload 没接上 app:askApply）', true); return null; }
    const project = state().project && state().project.name;
    if (!project) { MM.setStatus('没有打开的项目，写不进去', true); return null; }
    if (!box.node || !box.node.id) {
      // 项目级/多节点提问**不指定节点**：落盘必须说清"落到哪个节点" ⇒ 如实拒绝，不猜一个 ✗
      MM.setStatus('这条问答不属于某一个节点（项目级或多节点提问）—— 先在导图上选一个节点再问，就能写入它', true);
      box.ask.lastWrite = { ok: false, text: '没有落到任何节点：这条问答没有明确的节点目标' };
      renderAskPage(box);
      return null;
    }
    if (!entry || !entry.a || entry.pending || entry.err) {
      MM.setStatus('这条还没有可落盘的回答', true);
      return null;
    }
    /** ⚠️ 落痕必须**每次重新取 `box.ask`**，不能把上面那个 `st` 一直用下去 ✗
     *  真因（本文件实测踩到）：`showAskBox` 每次都会把 `box.ask` **换成一个新对象**
     *  （`box.ask = { kind, log: (box.ask && box.ask.log) || [] }`）。而写盘是**异步**的，
     *  这中间只要 `showAskBox` 被调一次（本工程里它被冒烟、被工具栏同步、被"重开同一个节点的框"
     *  各调一次），`st` 就指向一个**已经不属于这个框**的孤儿对象 —— 于是"已落盘"被写进孤儿，
     *  界面按新的 `box.ask` 渲染 ⇒ **盘上写了、界面上看不见**（正是最该避免的那种"看起来没做"）。
     *  ⇒ 判定与赋值都走这个取用函数，拿到的一定是当前那份。 */
    const live = () => (box.ask || (box.ask = { kind: 'ask', log: [] }));
    const asChild = act === 'child';
    const at = new Date().toISOString();
    const payload = {
      answer: entry.a, question: entry.q || '', at: at,
      // 模型名：一次问答里界面上知道的就是"思考强度"那一档（主进程 app:ask 的返回里没带 model）
      // ⇒ 不编一个模型名 ✗（编出来的元数据比没有更坏：后人会以为那是真的）
      asChild: asChild
    };
    MM.setStatus(asChild ? '正在把回答落成一个子节点…' : '正在把回答写进节点详情…');
    return Promise.resolve(api(project, box.node.id, payload)).then((r) => {
      if (!r || !r.ok) {
        const why = (r && r.error) || '未知原因';
        live().lastWrite = { ok: false, text: '没写进去：' + why };
        MM.setStatus('没写进去：' + why, true);
        renderAskPage(box);
        return null;
      }
      // R6 信号：这条回答已被用户落进导图（反馈候选要能指回 mapWrite 这个信号 ✓；
      //   log 数组在 box.ask 换对象时原样保留 ⇒ 记在条目上是稳的，见 live() 处的说明）
      entry.written = true;
      // ③ 内存对齐 + 基线推进（**两条必须一起做**，只做一条都会留下一个实测缺陷）：
      //    只写内存不推基线 ⇒ 紧接着的按盘重读以"界面脏着"为由拒绝采纳 ⇒ 新子节点不出现
      //      （判别力证据：只把下面 ① 那两行改成写 node.data ⇒ 冒烟 38 的 ② 红、⑤ 绿）；
      //    只想推基线不写内存（在 node 级赋值）⇒ 内存永远没对齐 ⇒ 下一次整树写回把刚落盘的
      //      qa/详情静默抹掉，save() 还返回 true（冒烟 38 的 ⑤ 专治这一条）。
      //    ⚠️ 顺序要紧：**先对齐（含把新子节点搬上树），再 requestReread()** ——
      //       否则那次重读拿到的还是"界面脏着"的结论。
      return syncMemoryAfterWriteBack(project, box.node.id, r, asChild).then((sync) => {
        const childId = r.child && r.child.id;
        const qaCount = (r.qa || []).length;
        const done = asChild
          ? ('已落盘：新建子节点 ' + (childId || '?') + '（标题取回答首行，详情放全文）；'
            + '这条问答也记进了本节点（共 ' + qaCount + ' 条）')
          : ('已落盘：回答已追加到本节点详情末尾（带来源标记与时间）；'
            + '问答记录共 ' + qaCount + ' 条');
        // 对齐成了就照旧；**没对齐就响亮说**（界面没对齐 = 现在保存会少内容，不许静默 ✗）
        live().lastWrite = {
          ok: true,   // 落盘本身是成功的（这条留痕说的是"写盘成不成功"）
          text: done + (sync.aligned ? '' : '｜⚠ 界面内存没跟上这次落盘：' + sync.why
            + (sync.kept
              ? '。这次写进去的内容已经在内存里（对应的节点已对齐）—— 保存时两边的改动都在'
              : '。**先别保存**：盘上那一版还没有进内存，现在保存会把刚写的内容抹掉；'
                + '请关掉再打开这个项目（或走菜单「重新加载思维导图页」）让界面读回盘上那一版'))
        };
        MM.setStatus(live().lastWrite.text, !sync.aligned);
        renderAskPage(box);
        // 导图上要出现新子节点 / 详情要跟上：请渲染层按磁盘重读一次（复用既有的脏冲突保护）
        if (MM.requestReread) { try { MM.requestReread(); } catch (e) { /* 重读失败不改变"已写进盘"这个事实 */ } }
        return r;
      }, (err) => {
        // 对齐那段自己抛了（不该发生）：落盘是成功的，但内存没跟上 ⇒ 如实说 ✗ 不假装
        const why = (err && err.message) || String(err);
        live().lastWrite = { ok: true, text: '已落盘（盘上内容已写入），但界面内存没跟上：' + why
          + '｜⚠ 先别保存：现在保存会把刚写的内容抹掉；请关掉再打开这个项目' };
        MM.setStatus(live().lastWrite.text, true);
        renderAskPage(box);
        return r;
      });
    }).catch((err) => {
      const why = (err && err.message) || String(err);
      live().lastWrite = { ok: false, text: '没写进去：' + why };
      MM.setStatus('没写进去：' + why, true);
      renderAskPage(box);
      return null;
    });
  }

  /* ================= 落盘之后的**内存对齐**（唯一实现：三条缺一条就对应一个实测缺陷） =================
   * 落盘走的是 CLI（`ask-apply`：闸门校验 + 原子写都在那边），所以"界面内存"必须自己跟上。
   * 三条都是实测过的（判据在 scripts/smoke/38-ai-落盘.js 的 ② ③ ④ ⑤）：
   *
   *   ① **写对对象**：jsMind 的节点自定义字段只活在**可序列化袋** `node.data` 上
   *      （库的 `_extract_data()`；`serializeTree` 读的正是 `n.data.detail/qa/items` ——
   *      见 app-core.js 的平铺白名单，editor.js 也写在 `node.data.detail`）。
   *      写到 node 级（`target.detail`）**对序列化完全不可见** ⇒ 界面内存永远没对齐 ⇒
   *      用户随后按一次保存（整树写回）就把刚落盘的 qa 与追加的详情**静默抹掉**，
   *      而 save() 返回 true、界面还显示"已保存" ✗✗。
   *
   *   ② **对齐要有名字**（`MM.markAlignedBaseline()`）：AI 落盘是**外部**改盘，
   *      于是"把内存对齐到盘上那一版"这件事本身会被 isDirty() 判成**人的编辑** ⇒
   *      紧接着的按盘重读会以"有未保存改动、不许覆盖人的编辑"为由**拒绝采纳** ⇒
   *      新子节点不出现在导图上、详情也不更新；而保存闸门那边又认为"没有外部改动" ⇒
   *      下一次整树写回抹盘 ✗。⚠️ 只在"界面本来没有**别的**未保存改动"时才敢声称对齐：
   *      用户自己那份还没落盘的改动只能靠保存时的三方合并保住 —— 声称对齐会让随后的重读
   *      拿盘上那份盖掉人的编辑（比少合并一次坏得多 ✗）。
   *
   *   ③ **新建子节点**那次内存里还没有这个节点（id / 标题取回答首行 / 详情放全文这三条规则
   *      都在 CLI 那边，渲染层**不重算** ✗）⇒ 用只读探视（`project:peek`，无副作用）把盘上
   *      那一份取回来，**只把这一个节点**按盘上的数据接进内存（数据整份来自磁盘 = 一个真源）。
   *      少了它：界面有未保存改动时重读会（正确地）拒绝采纳，而盘上那个新子节点不在内存里
   *      ⇒ 下一次保存把它抹掉 ✗。
   *
   * 任何一条没做到都**不留白**：返回 `{aligned:false, why}`，调用方把 why 原样留在浮窗里
   * （"界面没对齐 = 现在保存会少内容"这件事必须有人看得见 ✗ 不许静默）。
   * @returns {Promise<{aligned:boolean, why:string, kept?:boolean}>} */
  function syncMemoryAfterWriteBack(project, nodeId, r, asChild) {
    const childId = (r.child && r.child.id) || null;
    /** 真正改内存的那一段 —— **同步做完**（中间不留 await）：判脏与改内存之间若夹着一个 await，
     *  用户在这期间敲进去的字会被基线说成"已保存"，随后的重读就会把它盖掉 ✗。 */
    function apply(childFromDisk) {
      const jm = state().jm;
      const node = (jm && MM.adapter.available(jm)) ? MM.adapter.getNode(jm, nodeId) : null;
      if (!node) return { aligned: false, why: '内存里没有这个节点（导图已重建 / 项目已切走）' };
      // 判脏必须在**改内存之前**：这正是"界面还有没有别的未保存改动"的判据
      const hadOwnEdits = (typeof MM.isDirty === 'function') ? MM.isDirty() : true;
      try {
        node.data = node.data || {};                      // ① 可序列化袋（AI 结果的真源）
        node.data.detail = r.detail || '';
        // 深拷贝：后面界面保存会整树写回，共享引用会把主进程那边的对象形状带进内存树
        node.data.qa = JSON.parse(JSON.stringify(r.qa || []));
      } catch (e) {
        return { aligned: false, why: '写进节点数据袋失败：' + ((e && e.message) || e) };
      }
      if (childId && !MM.adapter.getNode(jm, childId)) {   // ③ 把盘上那个新子节点接进内存
        if (!childFromDisk) return { aligned: false, why: '读不回盘上那一版 ⇒ 新子节点没能接进导图' };
        try {
          const data = Object.assign({}, childFromDisk);
          // id / 标题 / children 走 add_node 的位置参数 —— 别塞进数据袋（塞了就是同一件事两处表达）
          delete data.id; delete data.topic; delete data.children;
          const added = MM.adapter.addNode(jm, nodeId, childId, childFromDisk.topic || childId, data);
          if (!added) return { aligned: false, why: '新子节点没能挂到「' + (node.topic || nodeId) + '」上' };
        } catch (e) {
          return { aligned: false, why: '新子节点接进内存失败：' + ((e && e.message) || e) };
        }
      }
      // ④ 自检：序列化出来的那一份里必须**真的**带上刚写进去的东西（写错对象在这里立刻红）
      const bad = verifySerialized(childId);
      if (bad) return { aligned: false, why: '对齐自检没过：' + bad + '（写入点错了对象 / 没接上树？）' };
      if (hadOwnEdits) {
        // 用户还有别的未保存改动 ⇒ 不许声称"界面已与盘上一致"（那会让随后的重读盖掉人的编辑）。
        // 但这次落盘的内容**已经进了内存** ⇒ 保存时两边都在（界面基线没动，闸门走三方合并）✓
        return { aligned: false, kept: true, why: '界面还有别的未保存改动 —— 没有整树对齐（不覆盖你的编辑）' };
      }
      if (!(MM.markAlignedBaseline && MM.markAlignedBaseline())) {
        return { aligned: false, why: '没有可推进的保存基线（项目可能还没载入完）' };
      }
      return { aligned: true, why: '' };
    }
    /** 自检（**机械判据，不是装饰**）：`serializeTree()` 出的那一份里必须真的带上刚写进去的
     *  detail / qa（新建子节点时还要有那个节点）—— 这正是"写对对象"的判据：写到 node 级
     *  （或压根没接上树）时序列化里看不见它们。返回 '' = 通过；否则是一句能留在浮窗里的原因。
     *  ⚠️ 它把"写得看不见 ⇒ 下一次保存静默抹盘"挡在**落盘那一刻**，不必等用户按了保存才发现。 */
    function verifySerialized(childIdToCheck) {
      try {
        const snap = MM.findJsonNode(MM.serializeTree(), nodeId);
        if (!snap) return '序列化出来的那一份里没有这个节点';
        if (String(snap.detail || '') !== String(r.detail || '')) return '序列化里没有刚写进去的 detail';
        const want = (r.qa || []).length;
        const got = Array.isArray(snap.qa) ? snap.qa.length : 0;
        if (got !== want) return '序列化里没有刚写进去的 qa（期望 ' + want + ' 条，实得 ' + got + ' 条）';
        if (childIdToCheck && !MM.findJsonNode(MM.serializeTree(), childIdToCheck)) {
          return '序列化里没有刚建出来的子节点 ' + childIdToCheck;
        }
        return '';
      } catch (e) {
        return '自检跑不起来：' + ((e && e.message) || e);
      }
    }
    // 子节点还不在树上 ⇒ 先去盘上把它取回来（**只读**：peek 不推进任何基线，取不到也不留后遗症）
    const jm0 = state().jm;
    const childInTree = !!(jm0 && childId && MM.adapter.getNode(jm0, childId));
    if (!asChild || !childId || childInTree) return Promise.resolve(apply(null));
    const api = window.desktop && window.desktop.project;
    if (!api || typeof api.peek !== 'function') return Promise.resolve(apply(null));
    return Promise.resolve(api.peek(project))
      .then((pr) => apply((pr && pr.ok && MM.findJsonNode) ? MM.findJsonNode(pr.data, childId) : null))
      .catch(() => apply(null));
  }

  /* ================= R6 五星评价 + 反馈闭环（会话级最小档） =================
   * 需求（用户 2026-10-14 逐字口径）：星星是**抽象的用户评价**（"满意/不满意"这一维），
   *   不是"多少详细"的旋钮；点星**自动弹框**："这次会话哪点让您不满意/满意？"，
   *   下面几个选项 + 「其他」（其他可展开输入）；**选项由本地算法从这次回答的信号得出**
   *   （AI 辅助的候选裁剪/补全 = 下一期 ✗ 本批如实只做本地，不假装有 AI ✗）。
   *   分析结果在**下次会话展示**（本批最小形态 = 打开会话时把已存反馈摘要展示出来；AI 深度分析 = 下一期 ✗）。
   *
   * 三条硬边界（每条都有判据，冒烟域 50）：
   *   ① **打分只落库，不改任何数据** ✗✗ —— 这里只调 desktop.app.feedbackAppend（主进程把记录
   *      只追加进应用级 JSONL），不触发任何编辑/重排/删除命令，绝不写 projects/**（路径渲染层根本拿不到）；
   *   ② **零网络** ✗ —— 全程没有模型调用（省 token 纪律：日常点星零调用；AI 批量分析 = 下一期 ✗）；
   *   ③ **默认档零噪声** ✗ —— 没有回答就没有星标；本机没有反馈记录 ⇒ 打开会话与从前逐字节相同 ✓。
   *
   * 落库契约（`%APPDATA%/AI MindMap/mm-feedback.jsonl`，**一行一条、只追加 ✗ 不覆盖**；可随时删，
   *   删了界面如实回到"没有反馈"✗ 不说"满意度 0"）：一行 = 一个 JSON 对象，键白名单：
   *   {"schema":1,"id":"f-<时间base36><随机>","at":ISO,"stars":1–5|null,"text":"…","target":{…},"src":"ask-box"}
   *   —— 只点星（text=''）与只写字不点星（stars=null）都必须合法 ✓；
   *   —— target 三种形状：{kind:'node',project,nodeId,itemId:null} | {kind:'nodes',project,nodeIds[]} | {kind:'project',project}；
   *   —— **路径由主进程独占推导**（渲染层不传、不采信任何路径 ✗✓，主进程侧还有字段白名单把多余键就地拒绝）；
   *   —— 渲染层 0 处 localStorage（工程纪律 ✓ 保持）。
   *
   * 本地信号 → 候选（**每条候选都能指回信号名** ✗ 否则退化成随机推荐；候选数有常量上限）：
   *   len（回答长度：短<200 / 长>1200 字符）· kind（类型：解释|问答）·
   *   mapWrite（这条回答是否已被用户落进导图）· code（是否含代码块或命令行样子的话）。
   *   stars≥4 ⇒ 出"满意"档候选（同一批信号换正面措辞）；≤3 ⇒ 出"不满意"档候选 ✓。 */

  /** 候选数上限（常量；省 token 纪律的本地半边：候选先按信号出，超了就地截断） */
  const ASK_FB_MAX_CANDIDATES = 4;

  /** 信号采集（**纯函数**，冒烟经 MM.askCollectAnswerSignals 直接调）。只用界面上本来有的信息 ✓ */
  function collectAnswerSignals(entry, st) {
    const a = String((entry && entry.a) || '');
    let hasCode = /```/.test(a);
    if (!hasCode) {
      hasCode = /(^|\n)[ \t]{0,8}(npm|npx|node|git|curl|wget|pip|python|cd|mkdir|cp|mv|rm|copy|del|dir|ls|cat|echo|set|export)\s+\S/.test(a);
    }
    return {
      len: a.length,
      lenBucket: a.length > 1200 ? 'long' : (a.length < 200 ? 'short' : 'mid'),
      kind: ((st && st.kind) === 'explain') ? 'explain' : 'ask',
      mapWritten: !!(entry && entry.written),
      hasCode: hasCode
    };
  }

  /** 星标行 HTML（**纯函数**）：5 颗星 + aria-label + 填充态（e.stars = 这条已点过的星）。
   *  ⚠️ 它长在 .ask-acts 动作行**末尾**（同一行 ⇒ "给这条回答打分"的归属一眼可辨 ✓）。 */
  function askStarsHtml(e, i) {
    const cur = (e && e.stars) || 0;
    let s = '<span class="ask-stars" role="group" aria-label="给这条回答打分" data-star-index="' + i + '">';
    for (let n = 1; n <= 5; n++) {
      s += '<button type="button" class="ask-star' + (cur >= n ? ' on' : '')
        + '" data-star="' + n + '" aria-label="' + n + ' 星"'
        + ' title="' + n + ' 星（' + (n <= 3 ? '不满意/一般' : '满意')
        + '；点星即刻记下，随后可补一句具体反馈）">★</button>';
    }
    return s + '</span>';
  }

  /** 信号 → 候选（**纯函数**）。每条 {text, signal}，signal 就是产生它的信号名 ✓ */
  function deriveFeedbackCandidates(sig, stars) {
    const bad = !(stars >= 4);
    const out = [];
    if (sig.lenBucket === 'long') out.push(bad
      ? { text: '太长太啰嗦，重点不突出', signal: 'len' }
      : { text: '够详细、覆盖面全', signal: 'len' });
    if (sig.lenBucket === 'short') out.push(bad
      ? { text: '太简略，信息量不够', signal: 'len' }
      : { text: '简短直接，不绕弯', signal: 'len' });
    if (sig.kind === 'explain') out.push(bad
      ? { text: '解释不够生动具体', signal: 'kind' }
      : { text: '解释清楚易懂', signal: 'kind' });
    else out.push(bad
      ? { text: '答非所问，没答到点上', signal: 'kind' }
      : { text: '正面回答了我的问题', signal: 'kind' });
    if (sig.hasCode) out.push(bad
      ? { text: '代码/命令有错或有坑', signal: 'code' }
      : { text: '代码/命令可直接照做', signal: 'code' });
    if (sig.mapWritten) out.push(bad
      ? { text: '写进导图后发现内容不合适', signal: 'mapWrite' }
      : { text: '落进导图的内容正合适', signal: 'mapWrite' });
    return out.slice(0, ASK_FB_MAX_CANDIDATES);   // 常量上限：截断发生在"候选"这一层 ✓
  }

  /** 反馈记录拼装（**形状纯函数**）。id 照 `f-` + 时间戳 base36 + 随机后缀的先例（与节点 id 区分 ✓） */
  function makeFeedbackRecord(box, index, stars, text) {
    const project = (state().project && state().project.name) || null;
    const ids = (box && box.nodes) || [];
    let target;
    if (ids.length > 1) target = { kind: 'nodes', project: project, nodeIds: ids.slice() };
    else if (box && box.node && box.node.id) target = { kind: 'node', project: project, nodeId: box.node.id, itemId: null };
    else target = { kind: 'project', project: project };
    return {
      schema: 1,
      id: 'f-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      stars: (stars >= 1 && stars <= 5) ? stars : null,   // 只写字不点星 = null（两种都合法 ✓）
      text: String(text || ''),
      target: target,
      src: 'ask-box'
    };
  }

  /** 反馈存取（渲染层**唯一**落点）。通道不在（旧版 preload）⇒ **响亮失败** ✗ 不静默假装存上了；
   *  路径永远不经过渲染层 ✗✓（主进程独占推导 + 字段白名单）。绝不碰 localStorage ✓。 */
  const askFeedbackStore = {
    append: function (record) {
      const api = window.desktop && window.desktop.app && window.desktop.app.feedbackAppend;
      if (!api) return Promise.resolve({ ok: false, error: '没有 desktop.app.feedbackAppend（preload 没接上）—— 这条反馈没有落盘' });
      return Promise.resolve(api(record));
    },
    read: function () {
      const api = window.desktop && window.desktop.app && window.desktop.app.feedbackRead;
      if (!api) return Promise.resolve({ ok: false, error: '没有 desktop.app.feedbackRead（preload 没接上）' });
      return Promise.resolve(api());
    }
  };

  /** 点一颗星：① **星即刻落库**（只点星也是一条合法记录 ✓ ⇒ 关掉弹框也不丢）；② 原地更新填充态
   *  （不整框重渲染 ⇒ 不打断可能开着的反馈框）；③ 在这条回答的动作行下面弹出反馈框。 */
  function handleStarClick(box, index, n) {
    if (!(n >= 1 && n <= 5)) return null;
    const st = box.ask || (box.ask = { kind: 'ask', log: [] });
    const entry = (st.log || [])[index];
    if (!entry || !entry.a || entry.pending || entry.err) return null;   // 只有真回答可评 ✓
    entry.stars = n;
    const dc = MM.fdQ(box, '.fd-detail-content');
    const row = dc && dc.querySelector('.ask-acts[data-act-index="' + index + '"]');
    if (row) {
      row.querySelectorAll('.ask-star').forEach((b) => {
        b.classList.toggle('on', Number(b.getAttribute('data-star')) <= n);
      });
    }
    // 多次点星 = 多条记录（只追加 ✗ 不覆盖；判据：重复点 4 星 ⇒ 库里两行、id 各自不同 ✓）
    askFeedbackStore.append(makeFeedbackRecord(box, index, n, '')).then((r) => {
      if (!r || !r.ok) MM.setStatus('这条评分没有落盘：' + ((r && r.error) || '未知原因'), true);
    });
    if (row) return openFeedbackPanel(box, row, index);
    return null;
  }

  /** 反馈框：长在被点那条回答的动作行下面（同一个浮层之内 ⇒ 不新开窗口 ✗ 复用既有视觉 ✓）。
   *  一次只开一个（再点别条 ⇒ 挪过去）；可关 = 这次不反馈 ✗ 不强制（星已落库 ✓）。 */
  function openFeedbackPanel(box, rowEl, index) {
    const dc = MM.fdQ(box, '.fd-detail-content');
    if (!dc) return null;
    const prev = dc.querySelector('.ask-fb-panel');
    if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
    const st = box.ask || (box.ask = { kind: 'ask', log: [] });
    const entry = (st.log || [])[index];
    if (!entry || !entry.a || entry.pending || entry.err) return null;
    const stars = entry.stars || 0;
    const cands = deriveFeedbackCandidates(collectAnswerSignals(entry, st), stars);
    const el = document.createElement('div');
    el.className = 'ask-fb-panel';
    el.setAttribute('data-fb-index', String(index));
    el.setAttribute('data-fb-star', String(stars));
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '这次会话哪点让您不满意/满意？');
    el.innerHTML = '<div class="ask-fb-head"><span class="ask-fb-title">这次会话哪点让您不满意/满意？</span>'
      + '<button type="button" class="ask-fb-close" aria-label="关闭（这次不反馈）"'
      + ' title="关掉＝这次不反馈；星已经记下了">✕</button></div>'
      + '<div class="ask-fb-opts">'
      + cands.map((c) => '<button type="button" class="ask-act ask-fb-opt" data-signal="' + c.signal
        + '" data-text="' + esc(c.text) + '">' + esc(c.text) + '</button>').join('')
      + '<button type="button" class="ask-act ask-fb-other" data-signal="other">其他…</button>'
      + '</div>'
      + '<div class="ask-fb-otherrow" hidden><input class="ask-input ask-fb-other-input" type="text"'
      + ' placeholder="具体说一句（可空）" /></div>'
      + '<div class="ask-fb-actions"><button type="button" class="ask-send ask-fb-submit">提交反馈</button>'
      + '<span class="ask-fb-note"></span></div>';
    rowEl.insertAdjacentElement('afterend', el);
    // 选项 = 多选（点了亮、再点灭）；每颗按钮的 data-signal 指回产生它的信号 ✓
    el.addEventListener('click', (e) => {
      const opt = e.target && e.target.closest ? e.target.closest('.ask-fb-opt') : null;
      if (opt && el.contains(opt)) opt.classList.toggle('on');
    });
    const note = el.querySelector('.ask-fb-note');
    const otherInput = el.querySelector('.ask-fb-other-input');
    otherInput.addEventListener('keydown', (e) => {
      e.stopPropagation();                          // 别让导图快捷键吃掉输入（与 ask-input 同一条纪律 ✓）
      if (e.key === 'Enter') { e.preventDefault(); el.querySelector('.ask-fb-submit').click(); }
    });
    el.querySelector('.ask-fb-close').addEventListener('click', () => {
      if (el.parentElement) el.parentElement.removeChild(el);   // 关 = 不反馈（星已落库 ✓）
    });
    el.querySelector('.ask-fb-other').addEventListener('click', () => {
      el.querySelector('.ask-fb-otherrow').hidden = false;      // 「其他」展开输入 ✓
      try { otherInput.focus(); } catch (e2) { /* 聚焦失败不影响展开 ✓ */ }
    });
    el.querySelector('.ask-fb-submit').addEventListener('click', () => {
      const picked = [];
      el.querySelectorAll('.ask-fb-opt.on').forEach((b) => { picked.push(b.getAttribute('data-text')); });
      const other = String(otherInput.value || '').trim();
      if (other) picked.push('其他：' + other);
      if (!picked.length) {
        note.textContent = '选一项或写一句；也可以直接关掉（星已经记下了）';
        return;
      }
      askFeedbackStore.append(makeFeedbackRecord(box, index, stars || null, picked.join('；'))).then((r) => {
        if (r && r.ok) {
          note.textContent = '已记下，谢谢 ✓';
          setTimeout(() => { if (el.parentElement) el.parentElement.removeChild(el); }, 700);
        } else {
          note.textContent = '没存上：' + ((r && r.error) || '未知原因');   // 响亮 ✗ 不静默
        }
      });
    });
    return el;
  }

  /** 摘要一行的显示文本：星数 + 选项/其他文本（任务书口径 ✓）；只点星的如实说，不编内容 ✗ */
  function feedbackLineText(line) {
    const n = Number(line.stars);
    const starStr = (line.stars === null || line.stars === undefined || !(n >= 1 && n <= 5))
      ? '☆' : '★★★★★'.slice(0, n);
    const raw = String(line.text || '');
    const textStr = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
    return starStr + ' ' + (textStr || '（只点星，没写文字）');
  }

  /** 摘要条 HTML（空库 ⇒ 空串 ⇒ 默认档这段对 HTML 零贡献 ✓）。最多展示最近 5 条，共几条如实说 ✓ */
  function feedbackSummaryHtml(fbSum) {
    if (!fbSum || !fbSum.lines || !fbSum.lines.length) return '';
    const show = fbSum.lines.slice(-5);
    const skipped = fbSum.skipped ? ('，另有 ' + fbSum.skipped + ' 条读不出已跳过') : '';
    return '<div class="ask-fb-summary" role="note" aria-label="上次会话的反馈">'
      + '<div class="ask-fb-sum-head"><span>上次会话的反馈（本机共 ' + fbSum.total + ' 条' + skipped
      + '，最近 ' + show.length + ' 条）</span>'
      + '<button type="button" class="ask-fb-sum-close" aria-label="收起这条摘要"'
      + ' title="收起（不影响已存的反馈）">✕</button></div>'
      + show.map((ln) => '<div class="ask-fb-sum-line">' + esc(feedbackLineText(ln)) + '</div>').join('')
      + '</div>';
  }

  /** 打开会话时读一次反馈库（**每次打开都从库读** ✗ 不吃跨打开的内存缓存 ——
   *  判别力：把这里改成读内存 ⇒ 域 50 的"重开后看到库里新一行"必红 ✓）。
   *  文件不存在（missing）⇒ 如实当"没有"，不出任何 UI ✓；读不动 ⇒ 响亮说 ✗ 不静默；
   *  坏行跳过并计数 ✗ 不静默吞。 */
  function loadFeedbackSummary(box) {
    box.__fbSummary = null;
    askFeedbackStore.read().then((r) => {
      if (!r) return;
      if (r.ok === false) { MM.setStatus('反馈记录读不出来：' + (r.error || '未知原因'), true); return; }
      const lines = [];
      let skipped = 0;
      String(r.text || '').split('\n').forEach((ln) => {
        const t = ln.trim();
        if (!t) return;
        try {
          const o = JSON.parse(t);
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            lines.push({ stars: (o.stars === undefined ? null : o.stars), text: String(o.text || '') });
          } else skipped++;
        } catch (e2) { skipped++; }
      });
      if (!lines.length) return;                    // 本机还没有反馈 ⇒ 不出现任何 UI（默认档零噪声 ✓）
      box.__fbSummary = { lines: lines, total: lines.length, skipped: skipped };
      if (box.el && box.el.parentElement) renderAskPage(box);   // 已开着 ⇒ 补渲染（摘要条长出来）
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
    const nodes = ids.map((id) => {
      const n = MM.adapter.getNode(jm, id);
      if (!n) return null;
      const plain = conv.stripHtml ? String(conv.stripHtml(n.detail || '')).trim() : String(n.detail || '');
      return { topic: n.topic, tags: Array.isArray(n.tags) ? n.tags : [], detailText: plain };
    }).filter(Boolean);
    // 文本拼装在 **src/sidebar-context.js**（纯函数 ⇒ node 里能单测 ✓）—— 见那里的说明 ✓
    const body = (window.MMSidebarContext && window.MMSidebarContext.buildSidebarText)
      ? window.MMSidebarContext.buildSidebarText(project, nodes)
      : ('【来自 AI MindMap·' + project + '】' + nodes.map((n) => '\n' + n.topic).join('')
        + '\n\n（这些是我这边的上下文；接着我想问 —— 你按需回答即可。）');
    const api = (window.desktop && window.desktop.dsh && window.desktop.dsh.prefill);
    if (!api) { MM.setStatus('这个版本没有侧栏通道', true); return Promise.resolve(null); }
    MM.setStatus('正在送进侧栏…');
    return Promise.resolve(api(body)).then((r) => {
      if (r && r.ok) MM.setStatus('已把 ' + ids.length + ' 个节点送进侧栏输入框（' + (r.textLen || 0) + ' 字）—— 到右边按发送 ✓');
      else MM.setStatus('没送进侧边栏：' + ((r && r.reason) || '未知原因'), true);
      return r;
    }).catch((err) => {
      MM.setStatus('没送进侧边栏：' + ((err && err.message) || err), true);
      return null;
    });
  }

  MM.showNodeToolbar = showBarFor;
  MM.sendNodesToSidebar = sendNodesToSidebar;   // ⑨ 供拖拽收尾复用（app-view 的树拖动松手处 ✓）
  MM.hideNodeToolbar = hideBar;
  MM.isNodeToolbarVisible = isBarVisible;
  MM.layoutNodeToolbar = layoutNodeToolbar;     // 工具条落位的**唯一实现**（MM.syncFdSatellites 调它）
  MM.syncNodeToolbarNow = syncNodeToolbarNow;   // 薄壳：立即按唯一判据重算一次
  MM.computeBarPos = computeBarPos;          // 纯几何（单测）
  MM.showAskBox = showAskBox;
  MM.renderAskPage = renderAskPage;
  MM.askBoxes = () => askBoxes.filter((b) => b.el && b.el.parentElement);
  // A：把一条回答落到节点上（**按钮与实际写盘共用这一个入口** ⇒ 断言点得到、人点得到）
  MM.askWriteBack = writeBack;
  // R6 五星评价：冒烟与单测的接缝（纯函数与入口；真正的判定在冒烟域 50 —— 断言只吃公开面 ✓）
  MM.askCollectAnswerSignals = collectAnswerSignals;   // 信号采集（纯函数）
  MM.askDeriveFeedbackCandidates = deriveFeedbackCandidates; // 信号→候选（纯函数，每条指回信号名）
  MM.askMakeFeedbackRecord = makeFeedbackRecord;       // 记录形状（纯函数，6+1 键契约）
  MM.askFeedbackStore = askFeedbackStore;              // append/read（通道不在 ⇒ 响亮失败 ✗ 不静默）
  MM.askOpenFeedbackPanel = openFeedbackPanel;         // 反馈框（真鼠标点星也会走到这里）
  MM.askHandleStarClick = handleStarClick;             // 点星（落库 + 填充态 + 弹框的唯一入口）
  MM.askLoadFeedbackSummary = loadFeedbackSummary;     // 会话开场读库（每次打开都读 ✗ 不吃内存缓存）
  MM.askFeedbackSummaryHtml = feedbackSummaryHtml;     // 摘要条 HTML（空库 = 空串 ⇒ 默认档零噪声）
  MM.ASK_FB_MAX_CANDIDATES = ASK_FB_MAX_CANDIDATES;    // 候选数常量上限

  /* ================= 接在"选中节点"这件事上 =================
   * 钩子点选择与理由：本工程里"选中一个节点"的**唯一标志**是它有了详情框（`MM.showDetail`），
   * 单击节点、命令行面板跳转、关联页面点成员、命令面板跳转……最后都走它 ✓
   * ⇒ 包住这一个入口就覆盖了所有"选中"路径（不必去每个调用点加代码，那种做法必漏 ✗）。
   * 关框同理包 `MM.closeFdBox`（工具条不该在节点已取消选中后还杵着）。
   * ⚠️ 包之前先存原函数，包之后**必须**把返回值原样透传（有调用方依赖它的返回值）。 */
  /* 改前这里是**两条猴子补丁**（包 MM.showDetail 显示、包 MM.closeFdBox 隐藏）—— 那正是
   * "同一判据两处表达"：只包住"开框那一刻"，于是拖动框、改大小、切节点、关框之后它都停在原地
   * （用户报的"浮动/滞后"）。现在**不再包任何东西**：
   *   · 目标由框池推导（见 barTargets ②）；显隐与位置由唯一的 layoutNodeToolbar 算；
   *   · 触发时机与框同一批事件：app-detail.js 的 MM.syncFdSatellites 会在 positionFdBox /
   *     syncFdBoxes / 拖动·改大小 mousemove 三处调用（窗口 resize 汇入 syncFdBoxes）✓。
   * ⇒ 开框、切节点、拖动、缩放、关框**全部自动跟上**，没有需要记得去打的补丁 ✓ */

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
    // 工具条自己 / AI 浮窗内部 / **卫星浮层里的圆钮** ⇒ 都不算"点别处"
    //（点圆钮不能先把工具条收掉；浮层是 pointer-events:none，命中的只会是它里面的元素 ✓）
    // ⚠️ 这里**故意不含** `.float-detail`：点"节点详情框"本来就该关掉 AI 浮窗（既有语义 ✓）
    if (t.closest && (t.closest('#mm-node-toolbar') || t.closest('.fd-ask-box')
      || (MM.fdIsSatelliteTarget && MM.fdIsSatelliteTarget(t)))) return;
    if (!askBoxes.some((b) => b.el && b.el.parentElement)) {
      if (isBarVisible()) hideBar();     // 只开着的工具条：点别处也收起 ✓
      return;
    }
    closeAskBoxes();
    hideBar();
  }, true);
})();
