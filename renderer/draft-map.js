/* ============================================================
 * renderer/draft-map.js — 草稿图窗口的页面脚本 · 功能代号 `DM` · 台账 `W11`
 * ------------------------------------------------------------
 * 职责（六件）：
 *   ① 把主进程给的草稿树画出来（`MMDraft.toJsMind` → `MM.adapter.loadTree`）
 *   ② 量出内容的真实 bbox 报给主进程（a–e 的 `a`：**按内容决定显示范围与窗口大小**）
 *   ③ **编辑这棵树**（a–e 的 `b`「允许完整编辑」）—— 但编辑器**不是**本文件写的：
 *      它调 `renderer/editor.js` 的 `MM.Editor.create(host)`，与**主窗调的是同一份实现**。
 *      本文件只给"宿主该给的东西"：树在哪、状态栏、能力位（草稿窗不能做哪几件事）、
 *      以及**改动落定后的收口**（把树交回主进程 `draft:update`）。
 *   ④ 「并入主导图」两步：先要落点候选、再带着落点提交（落点由**人**选，不由 AI 猜）
 *   ⑤ 「导出 md / json」「丢弃」两个按钮转发给主进程
 *   ⑥ 两张只读读数口：`MM.draftPageState()`（给冒烟断言）与 `MM.draftEditor()`（同上，编辑面）
 *
 * 三条纪律（都是本工程踩过的坑，不是新发明）：
 *   · 渲染库调用**只经** `MM.adapter.*`（`renderer/mindmap-adapter.js` 是唯一出口；
 *     本文件里不出现 jsMind 的公共方法名）—— 换库时只改那个文件的口径继续成立。
 *   · **页面不持有"唯一的"数据副本**：权威副本在主进程内存里（关窗即弃的语义在那边），
 *     页面只拿一份显示副本；于是"界面改一下草稿"必须**显式交回**（`draft:update`），
 *     交不回去就**回滚 + 响亮**，绝不出现"改得挺欢、并入进去还是旧树"。
 *   · **失败必须说话**：拿不到草稿 / 合并被拒 / 导出失败 / 改动没交回，都写进 `#status`（带原因），
 *     绝不出现"点了没反应"。本工程最重的损害类别是静默。
 *
 * ★ 草稿窗**不能**做的事（能力位在 `capabilities` 里显式给，不在各调用点散 `if (isDraft)`）：
 *   写盘 · 记 `changes` · 撤销栈 · 标签 / 展开状态（契约只带 `topic`/`detail`，`normalize` 会丢）·
 *   图片 / 附件（不落盘 ⇒ 必断链）· 跨项目链接 · MD 导入导出（没有家项目）· 灯箱 / 详情框 / 预览。
 *   这些的**理由文案**在 `renderer/editor.js` 的 `CAP_NOTES` 一处，别在这里各写一句会漂的话。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});
  const D = window.MMDraft;          // src/draft-map.js（纯函数：形状 / 渲染数据 / 导出）

  /** 内容四周留白（px）：让最外圈的节点不贴着窗口边 */
  const PAD = 28;
  /** 内容尺寸上报的收敛阈值（px）：小于它就当"没变"，免得 setContentSize 与 resize 事件互相追 */
  const EPS = 4;
  /** 草稿树的契约字段（与 `src/draft-map.js` 的 `KEEP` 同一口径；多一个字段都是要 normalize 丢的） */
  const KEEP = ['topic', 'detail'];

  let state = null;      // 主进程给的草稿 {id, source, tree, stats, fp}
  let jm = null;         // 本次的 jsMind 实例
  let editor = null;     // 编辑器件（MM.Editor.create 的产物；与主窗**同一份实现**）
  let accepted = null;   // 主进程**已接受**的那一版树（交回失败时用它回滚）
  let selectedId = '';   // 当前选中的节点 id（草稿页自己的，不依赖库的选中态）
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

  /* ---------------- ③ 编辑：宿主那一半（编辑器在 renderer/editor.js） ---------------- */

  /** 从**渲染视图**现算草稿树（页面的显示副本 ⇒ 契约形状）。
   *  为什么从 jm 现算而不是维护一份并行的模型：并行的两份必然漂（本工程的老教训）；
   *  `detail` 挂在 jsMind 节点的 `data.detail` 上（载入时由 `attachDetail` 挂进去，见 `render`）。 */
  function draftTree() {
    const root = jm && MM.adapter.getRoot(jm);
    if (!root) return null;
    const conv = (n) => {
      const out = { topic: String(n.topic === undefined || n.topic === null ? '' : n.topic) };
      const detail = (n.data && n.data.detail) || '';
      if (String(detail).trim()) out.detail = String(detail);
      const kids = (n.children || []).map(conv);
      if (kids.length) out.children = kids;
      return out;
    };
    return conv(root);
  }

  /** 带 id 的普通树（移动时要在普通树上做手术，再整棵重建视图）。 */
  function draftTreeWithIds() {
    const root = jm && MM.adapter.getRoot(jm);
    if (!root) return null;
    const conv = (n) => {
      const out = { id: String(n.id), topic: String(n.topic === undefined || n.topic === null ? '' : n.topic) };
      const detail = (n.data && n.data.detail) || '';
      if (String(detail).trim()) out.detail = String(detail);
      out.children = (n.children || []).map(conv);
      return out;
    };
    return conv(root);
  }

  /** 整棵重建视图（**移动**这类结构变化走这条，与主窗 reorder/reparent 的"回读重建"同一思路：
   *  不在库里就地 splice —— 那等于在渲染层写第二套结构操作）。 */
  function reloadTree(plain, keepSelection) {
    if (!plain || !jm) return;
    const payload = {
      meta: { name: (state && state.tree && state.tree.topic) || '草稿图' },
      format: 'node_tree',
      data: stripForJsMind(plain)
    };
    MM.adapter.loadTree(jm, payload);
    MM.adapter.expandAll(jm);
    if (keepSelection) { try { MM.adapter.selectNode(jm, keepSelection); } catch (e) { /* 选不中就只丢选中 */ } }
    selectedId = keepSelection || '';
    if (MM.adapter.resize) MM.adapter.resize(jm);
    lastSent = null; fitTries = 0;
    reportFit(true);
  }

  /** 交给 jsMind 的数据形状：id/topic/children（+ detail 进 `data`，见 `attachDetail` 的理由）。 */
  function stripForJsMind(n) {
    const out = { id: String(n.id), topic: String(n.topic || ''), children: [] };
    if (n.detail) out.detail = String(n.detail);
    (n.children || []).forEach((c) => out.children.push(stripForJsMind(c)));
    return out;
  }

  /** 在普通树上找 id 的父节点与下标（移动用；纯数据，不碰库）。 */
  function locate(plain, id, parent) {
    if (!plain) return null;
    if (String(plain.id) === id) return { node: plain, parent: parent || null, index: parent ? parent.children.indexOf(plain) : 0 };
    for (let i = 0; i < (plain.children || []).length; i++) {
      const hit = locate(plain.children[i], id, plain);
      if (hit) return hit;
    }
    return null;
  }

  /** **移动的后端**（能力位 `moveNode` + `moveBackend:{kind:'memory'}`）。
   *  语义与主窗那条 CLI 路径一致：`(要移动的 id, 新父 id, 落在第几位)`。
   *  这里没有盘可写 ⇒ 在**普通树**上做手术，然后整棵重建视图并交回主进程（`onCommit('move')`）。 */
  function memoryMove(id, parentId, index) {
    const plain = draftTreeWithIds();
    if (!plain) return { ok: false, reason: '草稿是空的' };
    if (String(id) === String(plain.id)) return { ok: false, reason: '根节点不能移动' };
    const here = locate(plain, String(id), null);
    if (!here) return { ok: false, reason: '没有这个节点：' + id };
    const target = locate(plain, String(parentId), null);
    if (!target) return { ok: false, reason: '没有这个新父节点：' + parentId };
    /* 不能移进自己的子树（否则整棵子树从树上掉下来、数据还在、界面没了 —— 最难查的那类） */
    for (let p = target.node; p; p = (locate(plain, String(p.id), null) || {}).parent) {
      if (String(p.id) === String(id)) return { ok: false, reason: '不能把节点移到它自己或它的子树里' };
    }
    // 先在原位置摘下来（注意下标会因为摘除而移动，故**先摘再按新下标插入**）
    const from = here.parent.children.indexOf(here.node);
    here.parent.children.splice(from, 1);
    const kids = target.node.children = target.node.children || [];
    const at = (index === undefined || index === null || isNaN(index)) ? kids.length : Math.max(0, Math.min(kids.length, index));
    kids.splice(at, 0, here.node);
    reloadTree(plain, String(id));
    return { ok: true, text: '已挂到「' + (target.node.topic || parentId) + '」第 ' + (at + 1) + ' 位' };
  }

  /** 改动落定后的**唯一收口**：把树交回主进程。失败 ⇒ 回滚到 `accepted` + 响亮。
   *  （主进程那份是权威副本 —— 交不回去就必须让界面与它一致，否则「并入」会写进旧树。）
   *
   *  ⚠️ **必须串行**（`pushChain`）：连按两下「＋子节点」会让两次 `draft:update` 同时在飞，
   *  而**先发的可能后到** —— 后到的那份树里没有第二个节点 ⇒ 主进程那份会被旧内容覆盖。
   *  串行化 + 每次**在轮到时才现算树**，于是最后落地的一定是最新状态。 */
  let pushChain = Promise.resolve(true);

  function pushTree() {
    pushChain = pushChain.then(() => doPush(), () => doPush());
    return pushChain;
  }

  function doPush() {
    const d = api();
    if (!d || !d.update) {
      setStatus('改动的提交通道没接上（desktop.draft.update 缺失）：本页现在只能看', true);
      return Promise.resolve(false);
    }
    const tree = draftTree();
    if (!tree) { setStatus('草稿是空的，没有可提交的改动', true); return Promise.resolve(false); }
    return Promise.resolve(d.update(tree)).then((r) => {
      if (!r || r.ok === false) {
        rollback('改动没有交回主进程：' + ((r && r.reason) || '未知原因'));
        return false;
      }
      state.fp = r.fp;
      state.stats = r.stats;
      state.tree = tree;                 // 页面这一份（主进程那份已按 normalize 归一化）
      accepted = draftTreeWithIds() || tree;   // ★ 回滚基准换成**带 id 的**那一版（reloadTree 要 id）
      updateHead();
      return true;
    }, (e) => {
      rollback('改动没有交回主进程：' + ((e && e.message) || e));
      return false;
    });
  }

  /** 回滚到主进程已接受的那一版（**不留"界面与权威副本不一致"的中间态**）。 */
  function rollback(why) {
    setStatus(why + '（已回滚到上一次交回成功的那一版）', true);
    if (accepted) reloadTree(accepted, '');
  }

  /** 顶栏读数：标题 / 来源 / 节点数与深度（数字以**主进程回执**为准，不自算） */
  function updateHead() {
    const t = state && state.tree;
    const st = (state && state.stats) || {};
    $('title').textContent = '草稿图：' + ((t && t.topic) || '(无标题)');
    $('stat').textContent = (st.nodes || 0) + ' 个节点 · 深度 ' + (st.depth || 0);
    document.title = '草稿图 · ' + ((t && t.topic) || 'AI MindMap');
  }

  /** 造编辑器件（**同一份实现**；草稿窗与主窗的差别全在下面这个对象里） */
  function createEditor() {
    if (editor || !MM.Editor) return editor;
    editor = MM.Editor.create({
      adapter: MM.adapter,
      getJm: () => jm,
      setStatus: (text, isErr) => setStatus(text, isErr),
      getProject: () => null,                 // ★ 草稿窗没有项目（素材/导入导出/跨项目链接都没法做）
      mount: document.body,
      capabilities: {
        editTopic: true, editDetail: true,
        editTags: false, editExpanded: false,   // 契约只带 topic/detail ⇒ 这两格会被 normalize 丢掉
        addChild: true, addSibling: true, deleteNode: true, moveNode: true,
        undoRedo: false, save: false,           // 不落盘、没有撤销栈
        assets: false, markdown: false, crossProject: false, overlays: false
      },
      onCommit: () => { pushTree(); },
      moveBackend: { kind: 'memory', move: memoryMove }
    });
    return editor;
  }

  /** 工具栏上的一个动作：先要有一个选中节点（没有就**点名**要人选，不静默什么都不做） */
  function withSelection(label, fn) {
    const id = selectedId || ((jm && MM.adapter.getSelected(jm)) || {}).id;
    if (!id) {
      setStatus('请先在图上点一个节点，再点「' + label + '」', true);
      return;
    }
    fn(String(id));
  }

  function selectNode(id) {
    selectedId = id ? String(id) : '';
    if (jm && selectedId) { try { MM.adapter.selectNode(jm, selectedId); } catch (e) { /* 选不中不影响操作 */ } }
    const el = $('sel');
    if (el) el.textContent = selectedId ? '选中：' + selectedId : '选中：—';
  }

  /* ---------------- ① 画出来 ---------------- */

  /** 把 `detail` 挂到 jsMind 的 node_tree 数据上。
   *  为什么需要：`src/draft-map.js` 的 `toJsMind` 只输出 id/topic/children（那是**渲染**要的三个字段），
   *  而本批要能在草稿窗里**改正文** ⇒ 正文必须进视图。
   *  jsMind 的 node_tree 载入会把它没认出的字段原样放进 `node.data`（`_extract_data` 只排掉
   *  id/topic/children/direction/expanded）⇒ 挂上去之后 `node.data.detail` 就是正文，读写都走它。 */
  function attachDetail(viewNode, plainNode) {
    if (!viewNode || !plainNode) return;
    if (plainNode.detail) viewNode.detail = String(plainNode.detail);
    const kids = plainNode.children || [];
    (viewNode.children || []).forEach((c, i) => attachDetail(c, kids[i]));
  }

  function render(payload) {
    if (!payload || !payload.ok) {
      setStatus('拿不到草稿：' + ((payload && payload.reason) || '未知原因'), true);
      return;
    }
    state = payload;
    accepted = payload.tree;
    const t = payload.tree;
    const st = payload.stats || {};
    $('src').textContent = payload.source ? '（来自 ' + payload.source + '）' : '';
    $('dropped').textContent = (payload.dropped && payload.dropped.length)
      ? '已丢弃字段 ' + payload.dropped.join('/') : '';
    updateHead();

    const view = D.toJsMind(t, (t && t.topic) || '草稿图');
    attachDetail(view.data, t);     // ★ 正文进视图（`detail` 会落进节点的 `data`）
    if (jm) {
      // 同一张窗被"更新到"（a–e 的 d）：**换内容不换窗** ⇒ 直接重载这棵树
      MM.adapter.loadTree(jm, view);
    } else {
      jm = new window.jsMind({
        container: 'jsmind_container',
        /* ★ `editable` 必须是 **true**：库的 `update_node` / `add_node` / `remove_node` 都长这样 ——
         *   `if (this.get_editable()) { … } else s.error('fail, this mind map is not editable')`
         *   ⇒ 设成 false 时那些写操作**静默不执行**（只往 console 打一句）。实测踩过：
         *   草稿窗的「改标题」不生效而「改正文」生效（正文是直接写 `node.data.detail`，不经库），
         *   于是"半套编辑"以一种最难查的方式出现了。
         * ⚠️ 但**库自带的 inline 编辑入口必须挡住**：`default_event_handle.enable_dblclick_handle=false`
         *   （**公开选项**，不是改 vendor）⇒ 双击不会再开库那个 contenteditable 编辑器；
         *   双击由本页接过来，开**共用编辑器**的对话框。编辑入口只有一个实现。 */
        editable: true,
        default_event_handle: { enable_dblclick_handle: false },
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
    selectedId = '';
    selectNode('');
    // 布局是异步落 DOM 的（jsMind 的 show_nodes 之后元素才带几何）⇒ 等两帧再量
    lastSent = null; fitTries = 0;
    const after = () => { reportFit(false); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(after));
    else setTimeout(after, 60);
    setStatus('这是**临时**的：不落 projects/、不参与检索/校验/统计；关掉窗口就没了。'
      + '（可以改：双击节点 / 用上面那排按钮；改完的树会立刻交回主进程，「并入」用的是改后那份）');
  }

  /* ---------------- ④ 并入（两步：问落点 → 提交） ---------------- */

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

  /* ---------------- ⑤ 导出 / 丢弃 ---------------- */

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

    /* ---- 编辑入口（人那半）：每个按钮只做"取选中 + 调共用编辑器"两件事 ---- */
    $('btn-edit').addEventListener('click', () => withSelection('编辑节点', (id) => editor.editNode(id)));
    $('btn-add-child').addEventListener('click', () => withSelection('加子节点', (id) => editor.addChild(id)));
    $('btn-add-sibling').addEventListener('click', () => withSelection('加同级', (id) => {
      const r = editor.addSibling(id);
      if (r === null && id === 'root') setStatus('根节点无法新增同级（要加顶层就点「加子节点」）', true);
    }));
    $('btn-del').addEventListener('click', () => withSelection('删除', (id) => editor.deleteNode(id)));
    $('btn-up').addEventListener('click', () => moveWithinSiblings(-1));
    $('btn-down').addEventListener('click', () => moveWithinSiblings(1));
    $('btn-move').addEventListener('click', openMovePanel);
    $('move-ok').addEventListener('click', doMoveTo);
    $('move-cancel').addEventListener('click', () => {
      $('move').classList.remove('on');
      setStatus('已取消移动（草稿还在）');
    });

    /* 选中：**自己记**（不依赖库的选中态 —— 收起/重排都会让它丢）。
     * 点节点 = 选中并开详情？草稿页没有详情框 ⇒ 只选中；双击 = 开编辑框（与主窗 F2 同义）。 */
    const cont = $('jsmind_container');
    if (cont) {
      cont.addEventListener('click', (ev) => {
        const el = ev.target && ev.target.closest ? ev.target.closest('jmnode[nodeid]') : null;
        if (!el) return;
        selectNode(el.getAttribute('nodeid'));
      });
      cont.addEventListener('dblclick', (ev) => {
        const el = ev.target && ev.target.closest ? ev.target.closest('jmnode[nodeid]') : null;
        if (!el) return;
        selectNode(el.getAttribute('nodeid'));
        editor.editNode(el.getAttribute('nodeid'));
      });
    }

    // 同一张窗被更新内容时（a–e 的 d：同一份内容更新到原来那张）主进程会推一次
    const d = api();
    if (d && d.onUpdate) d.onUpdate((p) => { lastSent = null; fitTries = 0; render(p); });
    if (typeof window !== 'undefined') window.addEventListener('resize', () => reportFit(false));
  }

  /** 同级上移 / 下移（`delta` = −1 / +1）。越界**明说**，不静默。 */
  function moveWithinSiblings(delta) {
    withSelection(delta < 0 ? '上移' : '下移', (id) => {
      const node = jm && MM.adapter.getNode(jm, id);
      if (!node || !node.parent) { setStatus('根节点没有同级可换', true); return; }
      const siblings = node.parent.children || [];
      const i = siblings.indexOf(node);
      const to = i + delta;
      if (to < 0 || to >= siblings.length) {
        setStatus((delta < 0 ? '已经是第一个同级了' : '已经是最后一个同级了'), true);
        return;
      }
      editor.moveNode(id, node.parent.id, to);
    });
  }

  /** 「移到…」：列草稿树里**除自己子树以外**的候选父（落点由人挑，不由脚本猜）。 */
  function openMovePanel() {
    withSelection('移到…', (id) => {
      const plain = draftTreeWithIds();
      const here = plain ? locate(plain, String(id), null) : null;
      if (!here) { setStatus('拿不到这棵树，移动不可用', true); return; }
      const banned = {};
      (function mark(n) { if (!n) return; banned[String(n.id)] = 1; (n.children || []).forEach(mark); })(here.node);
      const sel = $('move-parent');
      sel.innerHTML = '';
      const add = (val, text) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = text; sel.appendChild(o);
      };
      // 候选 = 整棵树里**不在自己子树里**的那些节点（落点由人挑；自己/自己的子树不是合法落点）
      (function walk(n, depth) {
        if (!n) return;
        if (!banned[String(n.id)]) add(String(n.id), new Array(depth + 1).join('　') + (n.topic || n.id));
        (n.children || []).forEach((c) => walk(c, depth + 1));
      })(plain, 0);
      if (!sel.options.length) { setStatus('这棵树里没有别的落点可移（只能往自己的子树里移，不允许）', true); return; }
      $('move').classList.add('on');
      setStatus('选一个新上级：移动只改**父子关系**，不改任何节点内容。');
    });
  }

  function doMoveTo() {
    const sel = $('move-parent');
    const parentId = sel && sel.value ? sel.value : '';
    if (!parentId) { setStatus('没选新上级', true); return; }
    withSelection('移到…', (id) => {
      $('move').classList.remove('on');
      editor.moveNode(id, parentId, null);
    });
  }

  function boot() {
    bind();
    createEditor();                 // ★ 编辑器件（与主窗**同一份实现**）
    const d = api();
    if (!d || !d.get) {
      setStatus('桌面接口没接上（window.desktop.draft 缺失）：本页只能由应用打开', true);
      return;
    }
    Promise.resolve(d.get()).then(render, (e) => setStatus('拿不到草稿：' + ((e && e.message) || e), true));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给断言用的**只读**读数出口（不含任何写操作；冒烟域 55/56 用它们在草稿页里做真判据） */
  MM.draftPageState = function draftPageState() {
    const cont = $('jsmind_container');
    const els = cont ? Array.prototype.slice.call(cont.querySelectorAll('jmnode[nodeid]')) : [];
    return {
      id: state ? state.id : null,
      fp: state ? state.fp : null,
      source: state ? state.source : null,
      rootTopic: state && state.tree ? state.tree.topic : null,
      nodes: state && state.stats ? state.stats.nodes : 0,
      depth: state && state.stats ? state.stats.depth : 0,
      rendered: els.length,
      jm: !!jm,
      selected: selectedId,
      pickOpen: !!($('pick') && $('pick').classList.contains('on')),
      moveOpen: !!($('move') && $('move').classList.contains('on')),
      want: lastSent ? { w: lastSent.w, h: lastSent.h } : null,
      status: ($('status') || {}).textContent || ''
    };
  };

  /** 编辑面的只读读数（给冒烟域 56：能力位、对话框状态、页面自己数出来的节点数）。 */
  MM.draftEditor = function draftEditor() {
    if (!editor) return null;
    const st = editor.openDialogState();
    let pageNodes = 0;
    const t = draftTree();
    const ids = draftTreeWithIds();
    (function walk(n) { if (!n) return; pageNodes += 1; (n.children || []).forEach(walk); })(t);
    /* 同级那条链的**页面现算读数**：每个节点的 id + 标题（冒烟据此判"顺序真的变了"，
     * 不用 DOM 顺序猜 —— DOM 顺序既受布局影响，也不该被当成数据顺序）。 */
    const flat = [];
    (function walk(n, depth, parentId) {
      if (!n) return;
      flat.push({ id: String(n.id), topic: String(n.topic || ''), depth: depth, parent: parentId ? String(parentId) : '' });
      (n.children || []).forEach((c) => walk(c, depth + 1, n.id));
    })(ids, 0, '');
    return {
      capabilities: st.capabilities,
      dialog: st,
      pageNodes: pageNodes,
      pageRootTopic: t ? t.topic : null,
      rootId: ids ? String(ids.id) : '',
      nodesFlat: flat,
      selected: selectedId
    };
  };

  /** 给断言读"页面现算的草稿树"（例如某个节点的正文到底是多少） */
  MM.draftPageTree = function draftPageTree() { return draftTree(); };
})();
