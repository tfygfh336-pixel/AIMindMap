/* ============================================================
 * AI MindMap — 手动编辑交互（editor.js）
 * ------------------------------------------------------------
 * 本文件是**可复用模块**：`MM.Editor.create(host)` 造一个编辑器实例，
 * **主窗与草稿图窗（`DM`）共用这同一份实现**（台账 `W11 a–e` 的 `b「允许完整编辑」`）。
 *
 * ## 为什么要改成宿主注入（定题：`.review/20261020-editor-复用/00-定题.md`）
 * 改前的本文件是一个 IIFE，直接够 `window.MMApp` 的 14 个方法 + 18 个固定 id。
 * 那 14 个方法里**有一半是"主窗的项目语义"**（保存/撤销/关联剪枝/浮层/素材），
 * 另一半才是"编辑器自己的事"（对话框字段、校验、快捷键路由、造 id、增删改）。
 * 把一个窗口的东西塞给另一个窗口，只有两条烂路：搬整套 DOM、或写第二份编辑器。
 * ⇒ 第三条：**把"人怎么表达一次编辑"留在本文件，"这次编辑落到哪里"由宿主注入。**
 *
 * ## 分界线（一句话）
 *   **编辑器负责「人怎么表达一次编辑」，宿主负责「这次编辑落到哪里」。**
 *   · 本文件里：对话框的字段与校验 · 快捷键 → 意图的路由 · id 生成 · 根节点守卫 ·
 *     能力拒绝的**报文** · 落定后的 `onCommit` 调用。
 *   · 宿主（`host`）：树在哪（`getJm`）· 状态栏 · 撤销栈 · 保存 · 项目 · 素材 · 浮层 ·
 *     删除前的项目级预检 · 移动的后端。
 *
 * ## 能力分层是**显式**的（不是运行时 `if (isDraft)` 散在各处）
 *   `host.capabilities` 每一位默认 **false**（少给 = 不能做，fail-closed）。
 *   没有的能力**不是把按钮藏起来就算**——调用点会返回一条**点名理由**的拒绝
 *   （`CAP_NOTES`：为什么草稿窗不能做这件事）。理由写在模块里，一处，不散落。
 *
 * ## 主窗行为必须逐字节不变
 *   · 本文件**不改** `index.html` 的对话框骨架：有骨架就**沿用**（adopt），
 *     没有骨架才**现造**（create）—— 所以主窗的 `#edit-dialog` 等 id、class、HTML 一个字节没变；
 *   · 每个原方法的**调用顺序**（addNode → recordHistory → select → 开框 / removeNode → recordHistory → 状态栏）
 *     与改前逐条对齐，证据见 `.review/20261020-editor-复用/01-验收读数.md` 的逐字节比对。
 * ============================================================ */
(function () {
  'use strict';

  const MM = window.MM || (window.MM = {});

  /* ================= 能力位（默认全 false） ================= */

  /** 每一位 = 一件"这个窗口能不能做"的事。**默认 false**：宿主少给一位就是不能做。 */
  const CAPS = ['editTopic', 'editDetail', 'editTags', 'editExpanded',
    'addChild', 'addSibling', 'deleteNode', 'moveNode',
    'undoRedo', 'save', 'assets', 'markdown', 'crossProject', 'overlays'];

  /** 没有某项能力时**必须点名理由**（一条一处；别让调用点各写一句会漂的话）。
   *  这些理由正是"草稿窗与主窗的差异"在接口上的表达（定题 §3 的 D2–D10）。 */
  const CAP_NOTES = {
    assets: '草稿不落盘 ⇒ 图片/附件会变断链（并入时才落 `projects/`）',
    markdown: '草稿没有家项目 ⇒ 没有可导入/导出的项目（导出用草稿窗自己的「导出 md/json」）',
    crossProject: '草稿没有家项目 ⇒ 编不出跨项目链接',
    save: '草稿不落盘：要留下就「并入主导图」或「导出」',
    undoRedo: '草稿没有撤销栈（它的出口是「丢弃」整份草稿）',
    overlays: '这个窗口没有灯箱 / 文件预览 / 浮动详情框',
    editTags: '草稿契约只带 topic/detail ⇒ 标签会在并入时被丢弃',
    editExpanded: '草稿契约只带 topic/detail ⇒ 展开状态会被丢弃（草稿一律全展开）',
    deleteNode: '宿主没有给「删节点」这项能力',
    moveNode: '宿主没有给「移动节点」这项能力',
    addChild: '宿主没有给「加子节点」这项能力',
    addSibling: '宿主没有给「加同级节点」这项能力',
    editTopic: '宿主没有给「改标题」这项能力',
    editDetail: '宿主没有给「改正文」这项能力'
  };

  /* ================= 对话框骨架 =================
   * adopt-or-create：主窗（`index.html` 静态带骨架）走 adopt —— **一个字节都不改**；
   * 草稿页走 create —— 用**同一套 id**（于是模块内部只有一套 id 常量，没有第二份 DOM 契约）。
   * 类名用 `mm-ed-*`：草稿页自己给它写样式（草稿页**不引用** `style.css`，那是主图那张表）。 */
  const MARKUP = {
    edit: '<div id="edit-dialog" class="mm-ed-overlay" style="display:none">'
      + '<div class="mm-ed-box">'
      + '<h3 id="edit-dialog-title">编辑节点</h3>'
      + '<label class="mm-ed-row" data-field="topic">标题 <input id="edit-topic" type="text"></label>'
      + '<label class="mm-ed-row" data-field="tags">标签（可选，逗号分隔）'
      + ' <input id="edit-tags" type="text" placeholder="标签1,标签2"></label>'
      + '<label class="mm-ed-row" data-field="detail">正文（HTML 片段，如 &lt;p&gt; &lt;b&gt; &lt;ul&gt;）'
      + ' <textarea id="edit-detail" rows="8"></textarea></label>'
      + '<label class="mm-ed-row mm-ed-chk" data-field="expanded">'
      + ' <input id="edit-expanded" type="checkbox"> 展开</label>'
      + '<div class="mm-ed-actions">'
      + '<button id="edit-cancel">取消</button>'
      + '<button id="edit-ok" class="mm-ed-primary">保存</button>'
      + '</div></div></div>',
    image: '<div id="image-dialog" class="mm-ed-overlay" style="display:none">'
      + '<div class="mm-ed-box"><h3>添加图片</h3>'
      + '<label class="mm-ed-row">图片文件 <input id="image-file" type="file" accept="image/*"></label>'
      + '<label class="mm-ed-row">内容备注（AI 阅读时凭此理解图片）'
      + '<textarea id="image-caption" rows="3"></textarea></label>'
      + '<label class="mm-ed-row">出处（可选）<input id="image-source" type="text"></label>'
      + '<label class="mm-ed-row">标签（可选，逗号分隔）<input id="image-tags" type="text"></label>'
      + '<div class="mm-ed-actions"><button id="image-cancel">取消</button>'
      + '<button id="image-ok" class="mm-ed-primary">添加</button></div></div></div>',
    file: '<div id="file-dialog" class="mm-ed-overlay" style="display:none">'
      + '<div class="mm-ed-box"><h3>添加附件</h3>'
      + '<label class="mm-ed-row">文件 <input id="file-file" type="file"></label>'
      + '<label class="mm-ed-row">内容备注（AI 阅读时凭此理解附件用途）'
      + '<textarea id="file-caption" rows="3"></textarea></label>'
      + '<label class="mm-ed-row">出处（可选）<input id="file-source" type="text"></label>'
      + '<div class="mm-ed-actions"><button id="file-cancel">取消</button>'
      + '<button id="file-ok" class="mm-ed-primary">添加</button></div></div></div>'
  };

  /** 造 id 的唯一实现（改前在 `app-actions.js` 里两处各写一遍，本批收到这里一处）。 */
  function genId() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 造一个编辑器实例。
   * @param {object} host 见定题 §4；必填 `adapter` / `getJm` / `setStatus`；
   *   `capabilities` 缺省全 false（**少给 = 不能做**）。
   * @returns {object} 实例（两个窗口拿到同一个形状，见定题 §4）
   */
  function create(host) {
    const h = host || {};
    if (!h.adapter) throw new Error('MM.Editor.create 需要 host.adapter（MM.adapter 是渲染库的唯一出口）');
    if (typeof h.getJm !== 'function') throw new Error('MM.Editor.create 需要 host.getJm()');
    if (typeof h.setStatus !== 'function') throw new Error('MM.Editor.create 需要 host.setStatus()');

    const doc = h.doc || window.document;
    const adapter = h.adapter;
    const caps = {};
    CAPS.forEach((k) => { caps[k] = !!(h.capabilities && h.capabilities[k]); });
    const setStatus = (t, e) => h.setStatus(t, e);

    const $ = (sel) => doc.querySelector(sel);
    const getJm = () => h.getJm();
    const getNode = (id) => {
      const jm = getJm();
      return jm ? adapter.getNode(jm, id) : null;
    };

    /** 能力拒绝的唯一实现：**点名理由**，绝不出现"点了没反应"。 */
    function refuse(cap) {
      setStatus('本窗口不做这件事：' + (CAP_NOTES[cap] || ('没有这项能力（' + cap + '）')), true);
      return false;
    }

    /** 改动落定后的唯一出口（主窗 = 记撤销栈；草稿窗 = 把树推给主进程）。
     *  宿主自己负责失败时的响亮提示与回滚（本模块不猜它的回滚语义）。 */
    function commit(kind, info) {
      if (typeof h.onCommit !== 'function') return;
      try { h.onCommit(kind, info); }
      catch (err) { setStatus('改动没能落定：' + ((err && err.message) || err), true); }
    }

    /* ================= 节点编辑对话框 ================= */
    let editingId = null;

    function openEditDialog(id) {
      const node = getNode(id);
      if (!node) return false;
      editingId = node.id;
      $('#edit-dialog-title').textContent = '编辑节点：' + node.topic;
      $('#edit-topic').value = node.topic;
      if (caps.editTags) $('#edit-tags').value = ((node.tags || (node.data && node.data.tags)) || []).join(',');
      /* 正文那一格：草稿窗的正文是**纯文本还是 HTML**？—— 两窗都用 detail 的原始字节，
       * 于是这里不需要分叉（主窗历来把 detail 当 HTML 原样给编辑框）。 */
      $('#edit-detail').value = node.detail || (node.data && node.data.detail) || '';
      if (caps.editExpanded) $('#edit-expanded').checked = node.expanded !== false;
      $('#edit-dialog').style.display = 'flex';
      $('#edit-topic').focus();
      $('#edit-topic').select();
      return true;
    }

    function closeEditDialog() {
      const d = $('#edit-dialog');
      if (d) d.style.display = 'none';
      editingId = null;
    }

    function saveEditDialog() {
      const node = getNode(editingId);
      if (!node) { closeEditDialog(); return false; }
      const topic = $('#edit-topic').value.trim();
      if (!topic) { window.alert('标题不能为空'); return false; }
      const tags = caps.editTags
        ? $('#edit-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : null;
      const detail = $('#edit-detail').value;
      const expanded = caps.editExpanded ? $('#edit-expanded').checked : null;

      // 记录快照后修改（快照那一步归宿主：主窗**改标题不进撤销栈**，这是改前的语义）
      const jm = getJm();
      if (node.topic !== topic) adapter.updateNode(jm, node.id, topic);
      // 标题里若含行内 Markdown（`**加粗**` / 反引号代码），在这里补一次渲染期转换 ——
      // jsMind 刚把原文写进节点元素，是唯一需要重转的时机（详见 app-core.js 的 applyTopicMarkup）。
      // 为什么经宿主：那是**主窗的渲染层**（草稿页不加载 app-core.js）。
      if (typeof h.applyTopicMarkup === 'function') h.applyTopicMarkup(jm);
      else if (window.MM && window.MM.applyTopicMarkup) window.MM.applyTopicMarkup(jm);
      node.data = node.data || {};
      node.data.detail = detail;
      if (tags) { if (tags.length) node.data.tags = tags; else delete node.data.tags; }
      if (expanded !== null && node.expanded !== expanded) {
        if (expanded) adapter.expandNode(jm, node.id); else adapter.collapseNode(jm, node.id);
      }
      setStatus('节点已更新，点击保存生效');
      closeEditDialog();
      commit('edit', { id: node.id });
      return true;
    }

    /* ================= 图片导入对话框 ================= */
    let imageTargetId = null;

    function openImageDialog(id) {
      if (!caps.assets) return refuse('assets');
      const node = getNode(id);
      if (!node) { setStatus('请先选中节点再添加图片'); return false; }
      imageTargetId = node.id;
      $('#image-file').value = '';
      $('#image-caption').value = '';
      $('#image-source').value = '';
      $('#image-tags').value = '';
      $('#image-dialog').style.display = 'flex';
      return true;
    }

    async function saveImageDialog() {
      if (!caps.assets) return refuse('assets');
      const node = getNode(imageTargetId);
      if (!node) { setStatus('目标节点不存在，请重新打开图片对话框', true); $('#image-dialog').style.display = 'none'; return false; }
      const fileInput = $('#image-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { window.alert('请选择图片文件'); return false; }
      const caption = $('#image-caption').value.trim();
      if (!caption) { window.alert('请填写内容备注 caption（AI 凭此理解图片）'); return false; }
      const source = $('#image-source').value.trim();
      const tags = $('#image-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const project = typeof h.getProject === 'function' ? h.getProject() : null;
      if (!project) { window.alert('未加载项目'); return false; }
      try {
        await window.desktop.asset.import(project.name, node.id, file.path, caption, source, tags);
        // 重读项目数据（CLI 已把图片写入 JSON 与 assets/）
        const r = await window.desktop.project.read(project.name);
        const reloaded = findNode(r.data.data, node.id);
        if (reloaded) {
          node.images = reloaded.images || [];
          node.data = node.data || {};
          node.data.images = node.images;
          if (typeof h.showDetail === 'function') h.showDetail(node);
        }
        setStatus('图片已添加，点击保存生效');
        commit('asset', { id: node.id, kind: 'image' });
      } catch (err) {
        setStatus('图片导入失败：' + ((err && err.message) || err), true);
      }
      $('#image-dialog').style.display = 'none';
      return true;
    }

    /* ================= 附件（文件）对话框 ================= */
    let fileTargetId = null;

    function openFileDialog(id) {
      if (!caps.assets) return refuse('assets');
      const node = getNode(id);
      if (!node) { setStatus('请先选中节点再添加附件'); return false; }
      fileTargetId = node.id;
      $('#file-file').value = '';
      $('#file-caption').value = '';
      $('#file-source').value = '';
      $('#file-dialog').style.display = 'flex';
      return true;
    }

    async function saveFileDialog() {
      if (!caps.assets) return refuse('assets');
      const node = getNode(fileTargetId);
      if (!node) { setStatus('目标节点不存在，请重新打开附件对话框', true); $('#file-dialog').style.display = 'none'; return false; }
      const fileInput = $('#file-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { window.alert('请选择附件文件'); return false; }
      const caption = $('#file-caption').value.trim();
      if (!caption) { window.alert('请填写内容备注 caption（AI 凭此理解附件用途）'); return false; }
      const source = $('#file-source').value.trim();
      const project = typeof h.getProject === 'function' ? h.getProject() : null;
      if (!project) { window.alert('未加载项目'); return false; }
      try {
        await window.desktop.asset.importFile(project.name, node.id, file.path, caption, source);
        // 重读项目数据（CLI 已把附件写入 JSON 与 attachments/）
        const r = await window.desktop.project.read(project.name);
        const reloaded = findNode(r.data.data, node.id);
        if (reloaded) {
          node.files = reloaded.files || [];
          node.data = node.data || {};
          node.data.files = node.files;
          if (typeof h.showDetail === 'function') h.showDetail(node);
        }
        setStatus('附件已添加，点击保存生效');
        commit('asset', { id: node.id, kind: 'file' });
      } catch (err) {
        setStatus('附件导入失败：' + ((err && err.message) || err), true);
      }
      $('#file-dialog').style.display = 'none';
      return true;
    }

    function findNode(root, id) {
      if (!root) return null;
      if (root.id === id) return root;
      for (const c of (root.children || [])) {
        const r = findNode(c, id);
        if (r) return r;
      }
      return null;
    }

    /* ================= Markdown 导入/导出（经隐藏 file input + 主进程） ================= */
    function pickAndImportMd() {
      if (!caps.markdown) return refuse('markdown');
      const node = getJm() && adapter.getSelected(getJm());
      const parent = node ? node.id : 'root';
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const project = typeof h.getProject === 'function' ? h.getProject() : null;
          setStatus('导入中…');
          const res = await window.desktop.app.importMd(project.name, f.path, parent);
          if (res && res.ok) {
            if (typeof h.reloadProject === 'function') await h.reloadProject(project.name);
            setStatus('导入完成');
          } else {
            setStatus('导入失败', true);
          }
        } catch (err) {
          setStatus('导入失败：' + ((err && err.message) || err), true);
        }
      };
      input.click();
      return true;
    }

    async function pickExportMd() {
      if (!caps.markdown) return refuse('markdown');
      const project = typeof h.getProject === 'function' ? h.getProject() : null;
      if (!project) { setStatus('未加载项目'); return false; }
      try {
        const r = await window.desktop.app.exportMdDialog(project.name);
        if (!r || r.canceled) return false;
        setStatus(r.ok ? '已导出：' + r.file : '导出失败：' + r.err, !r.ok);
        return !!r.ok;
      } catch (err) {
        setStatus('导出失败：' + ((err && err.message) || err), true);
        return false;
      }
    }

    /* ================= 结构操作（两窗同一份代码） ================= */

    /** 在 `parentId` 下加一个子节点（不给 `parentId` = 当前选中节点，与改前的 `addNode()` 同义）。
     *  顺序照改前：add → 记栈（宿主）→ 选中 → 开「编辑节点」框。 */
    function addChild(parentId, opts) {
      if (!caps.addChild) { refuse('addChild'); return null; }
      const o = opts || {};
      const jm = getJm();
      const parent = parentId ? adapter.getNode(jm, parentId) : adapter.getSelected(jm);
      if (!parent) { setStatus('请先选中一个节点作为父节点'); return null; }
      const id = genId();
      adapter.addNode(jm, parent.id, id, o.topic || '新节点', { detail: '' });
      commit('add', { id: id, parent: parent.id });     // 主窗：recordHistory()（修改后压快照）
      adapter.selectNode(jm, id);
      openEditDialog(id);
      return id;
    }

    /** 加同级：插到所选节点所在父的**末尾**。
     *  ⚠️ **已知缺陷**（`W11` 之前就存在，本批**纯重构按原样保留**，没有顺手"修"）：
     *  jsMind 0.9.1 的公开 `add_node(parent, id, topic, data, direction)` **只有 5 个形参、没有 index**
     *  ⇒ 它拿不到"插到所选节点之后"这个落点，新节点实际**追加**在父节点末尾。
     *  早先 `app-actions.js` 里为此多传了一个 `sel.index + 1`（被静默丢弃），
     *  本批把那段调用收到模块里，**刻意不再传第 6/7 个实参** —— 传了也不会被用到，
     *  只会让下一个人以为"这里有落点控制"。要修它是**行为变更**（换新节点落点），
     *  须另开一次改动并补一条"落点"断言。取证：`.review/20261009-jsMind事件派发探针/` 与
     *  `renderer/mindmap-adapter.js` 头部。 */
    function addSibling(id) {
      if (!caps.addSibling) return refuse('addSibling');
      const jm = getJm();
      const sel = id ? adapter.getNode(jm, id) : adapter.getSelected(jm);
      if (!sel) { setStatus('请先选中要插入的节点'); return null; }
      if (sel.id === 'root') { setStatus('根节点无法新增同级'); return null; }
      const newId = genId();
      adapter.addNode(jm, sel.parent.id, newId, '新节点', { detail: '' });
      commit('add', { id: newId, parent: sel.parent.id });
      adapter.selectNode(jm, newId);
      openEditDialog(newId);
      return newId;
    }

    /** 删除：根节点守卫 + （宿主的）项目级预检 ⇒ 真的删 ⇒ 记栈 ⇒ 状态栏。
     *  预检为什么在宿主：它要读关联笔记与入边链接、并让 **CLI 在磁盘上**先剪干净
     *  （`project:save` 是校验闸门，悬挂引用会让保存被拒 ⇒ 界面自己把自己卡死）。
     *  草稿窗没有项目 ⇒ 没有预检（契约上草稿也不可能带引用）。 */
    function deleteNode(id) {
      if (!caps.deleteNode) return refuse('deleteNode');
      const jm = getJm();
      const node = id ? adapter.getNode(jm, id) : adapter.getSelected(jm);
      if (!node) { setStatus('请先选中要删除的节点'); return null; }
      if (node.id === 'root') { setStatus('根节点不可删除'); return null; }

      /* ⚠️ **要在删之前取好的两个字段**（`topic` / `id`），理由不是洁癖，是库的行为：
       *    jsMind 0.9.1 的 `remove_node(id)` 末尾对**这个节点对象本身**做了
       *      `for (var a in (delete this.nodes[e.id], e)) delete e[a];`
       *    —— 把节点的**每一个自有字段逐个删掉**（压缩源码见 `node_modules/jsmind/es6/jsmind.js`
       *    的 `remove_node` 方法体；本批的探针读数在 `.review/20261022-deleted-undefined/`）。
       *    ⇒ 删完再读 `node.topic` / `node.id` 一律是 `undefined`。
       *    改前这里就是"先删再拼文案" ⇒ 状态栏一直是 `已删除：undefined`，活到 2026-10-22
       *    **不是因为难修**，而是因为当时**没有任何冒烟域判过这条文案**（现在有了：
       *    `scripts/smoke/10-assoc.js` 与 `scripts/smoke/56-草稿图编辑.js` 各判一条**页面状态栏的
       *    真实文本**）。⇒ 想再"优化"这段时：凡是在 removeNode 之后会用到节点字段的，
       *    都必须先在这里取出来，别再读 `node.*`。 */
      const topic = node.topic;
      const nodeId = node.id;

      const finish = (res) => {
        adapter.removeNode(jm, nodeId);
        commit('delete', { id: nodeId });
        let text = '已删除：' + topic;
        if (res && res.cleanup) {
          text += '（并清理 ' + res.cleanup.affected + ' 篇关联 / ' + res.cleanup.inLinks + ' 条链接的引用）';
        }
        setStatus(text, !!(res && res.isErr));
      };
      if (typeof h.beforeDelete !== 'function') { finish(null); return nodeId; }
      let pre;
      try { pre = h.beforeDelete(node); }
      catch (err) { setStatus('删除前的检查失败，已取消删除：' + ((err && err.message) || err), true); return null; }
      Promise.resolve(pre).then((res) => {
        if (res && res.allow === false) {
          setStatus((res && res.statusText) || ('已取消删除：' + topic), !!(res && res.isErr));
          return;
        }
        finish(res);
      }, (err) => {
        setStatus('删除前的检查失败，已取消删除：' + ((err && err.message) || err), true);
      });
      return nodeId;
    }

    /** 移动：**意图**在这里，**后端**由宿主给（主窗 = IPC→CLI `move`；草稿窗 = 内存重排）。 */
    function moveNode(id, parentId, index) {
      if (!caps.moveNode) return refuse('moveNode');
      const mb = h.moveBackend;
      if (!mb || typeof mb.move !== 'function') {
        setStatus('本窗口没有配移动的后端（host.moveBackend）', true);
        return false;
      }
      let r;
      try { r = mb.move(id, parentId, index); }
      catch (err) { setStatus('移动失败：' + (((err && err.message)) || err), true); return false; }
      return Promise.resolve(r).then((res) => {
        if (res && res.ok === false) {
          setStatus('没有移动：' + ((res && res.reason) || '未知原因'), true);
          return false;
        }
        commit('move', { id: id, parent: parentId, index: index });
        setStatus('已移动：' + ((res && res.text) || ''));
        return true;
      }, (err) => {
        setStatus('移动失败：' + ((err && err.message) || err), true);
        return false;
      });
    }

    /* ================= 键盘快捷键 ================= */
    /** 事件是否来自可输入控件（输入框/文本域/可编辑元素）。
     *
     *  **必须判断**：Delete/Backspace 在本工程是"删除选中节点（含整棵子树）"的破坏性快捷键。
     *  曾只把三个对话框算作"在输入中"，于是命令面板 `#palette-input` 与工具栏搜索框
     *  `#search-box` 里按退格改字 → 直接删掉当前选中节点（内存态，Ctrl+Z 能救，
     *  但若中途触发保存即落盘）。凡是"能打字的地方"都不该触发破坏性快捷键。 */
    function inTextInput(e) {
      const t = e.target;
      if (!t) return false;
      if (t.isContentEditable) return true;
      const tag = String(t.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') {
        const type = String(t.type || 'text').toLowerCase();
        // 这些 input 类型不接受自由文本，快捷键照常生效
        if (['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color'].indexOf(type) >= 0) return false;
        return true;
      }
      return false;
    }

    /** 三个对话框里**本实例真的造过/沿用**的那几个（草稿窗没有图片/附件框）。 */
    function dialogOpen(which) {
      const el = $('#' + which + '-dialog');
      return !!(el && el.style.display === 'flex');
    }

    function anyDialogOpen() {
      return dialogOpen('edit') || dialogOpen('image') || dialogOpen('file');
    }

    /** 没有撤销栈的窗口：Ctrl+Z 不许静默（静默 = 让人以为撤销成功）。 */
    function doUndo() {
      if (!caps.undoRedo) return refuse('undoRedo');
      if (h.history && typeof h.history.undo === 'function') h.history.undo();
      return true;
    }
    function doRedo() {
      if (!caps.undoRedo) return refuse('undoRedo');
      if (h.history && typeof h.history.redo === 'function') h.history.redo();
      return true;
    }
    function doSave() {
      if (!caps.save) return refuse('save');
      if (typeof h.onSave === 'function') h.onSave();
      return true;
    }

    function onKey(e) {
      if (anyDialogOpen()) {
        if (e.key === 'Escape') {
          closeEditDialog();
          const im = $('#image-dialog'); if (im) im.style.display = 'none';
          const fm = $('#file-dialog'); if (fm) fm.style.display = 'none';
        }
        if (e.key === 'Enter' && !e.shiftKey && dialogOpen('edit')) { saveEditDialog(); }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      // 命令面板自身处理 ↑↓/Enter/Esc；这里不要重复响应（Esc 由 app.js 统一收口）
      const paletteOpen = !!(caps.overlays && h.overlays && typeof h.overlays.paletteIsOpen === 'function'
        && h.overlays.paletteIsOpen());
      if (e.key === 'Escape' && (inTextInput(e) || paletteOpen)) return;
      if (e.key === 'Escape' && caps.overlays && h.overlays) {
        // 依次关闭：灯箱 → 文件预览 → 浮动详情
        const lb = $('#lightbox');
        if (lb && lb.style.display === 'flex') { h.overlays.closeLightbox(); return; }
        const fp = $('#file-preview');
        if (fp && fp.style.display === 'flex') { h.overlays.closeFilePreview(); return; }
        if (doc.querySelector('.float-detail')) { h.overlays.hideFloatDetail(); return; }
      }
      // 在输入框里打字时，除撤销/重做/保存外一律不响应快捷键（尤其 Delete/Backspace）
      if (inTextInput(e)) {
        if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); doUndo(); }
        else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); }
        else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSave(); }
        return;
      }
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSave(); }
      else if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); doUndo(); }
      else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); }
      else if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); if (caps.addChild) addChild(); else refuse('addChild'); }
      else if (e.key === 'F2') { e.preventDefault(); editSelected(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        const jm = getJm();
        const sel = jm && adapter.getSelected(jm);
        if (sel && sel.id !== 'root') { e.preventDefault(); if (caps.deleteNode) deleteNode(sel.id); else refuse('deleteNode'); }
      }
    }

    /** F2 / 「编辑节点」入口：不给 id ⇒ 当前选中（与改前 `editNode()` 同义）。 */
    function editSelected(id) {
      if (!caps.editTopic) return refuse('editTopic');
      const jm = getJm();
      const node = id ? adapter.getNode(jm, id) : (jm && adapter.getSelected(jm));
      if (!node) { setStatus('请先选中要编辑的节点'); return false; }
      return openEditDialog(node.id);
    }

    /* ================= 接线 ================= */
    let wired = false;
    const wiredKeys = [];

    function mount(markupKey) {
      const existing = $('#' + markupKey + '-dialog');
      if (existing) return existing;                       // ★ adopt：主窗走这条，一个字节都不改
      const hostEl = h.mount || doc.body;
      if (!hostEl) return null;
      const tmp = doc.createElement('div');
      tmp.innerHTML = MARKUP[markupKey];
      const el = tmp.firstChild;
      hostEl.appendChild(el);                              // ★ create：草稿窗走这条
      return el;
    }

    /** 字段那一行（adopt 来的骨架没有 `data-field` ⇒ 用 id 反查它所在的 `<label>`）。 */
    function fieldRow(name) {
      const d = $('#edit-dialog');
      if (!d) return null;
      const byAttr = d.querySelector('[data-field="' + name + '"]');
      if (byAttr) return byAttr;
      const input = $('#edit-' + name);
      return input && input.closest ? input.closest('label') : null;
    }

    /** 按能力位把对话框骨架准备好（没有的能力**不造框** —— 连按钮都不存在）。 */
    function ensureDialogs() {
      const edit = mount('edit');
      if (edit) {
        // 能力关掉的字段**从框里摘掉**（否则人会以为能改，而契约会把它丢掉）
        if (!caps.editTags) { const r = fieldRow('tags'); if (r) r.style.display = 'none'; }
        if (!caps.editExpanded) { const r = fieldRow('expanded'); if (r) r.style.display = 'none'; }
        if (!caps.editDetail) { const r = fieldRow('detail'); if (r) r.style.display = 'none'; }
      }
      if (caps.assets) { mount('image'); mount('file'); }
      return edit;
    }

    function bind(sel, evt, fn) {
      const el = $(sel);
      if (!el) return;
      el.addEventListener(evt, fn);
      wiredKeys.push([el, evt, fn]);
    }

    function wire() {
      if (wired) return;
      wired = true;
      bind('#edit-cancel', 'click', closeEditDialog);
      bind('#edit-ok', 'click', saveEditDialog);
      bind('#image-cancel', 'click', () => { const d = $('#image-dialog'); if (d) d.style.display = 'none'; });
      bind('#image-ok', 'click', saveImageDialog);
      bind('#file-cancel', 'click', () => { const d = $('#file-dialog'); if (d) d.style.display = 'none'; });
      bind('#file-ok', 'click', saveFileDialog);
      doc.addEventListener('keydown', onKey);
      wiredKeys.push([doc, 'keydown', onKey]);
    }

    function destroy() {
      wiredKeys.forEach(([el, evt, fn]) => { try { el.removeEventListener(evt, fn); } catch (e) { /* 已摘 */ } });
      wiredKeys.length = 0;
      wired = false;
    }

    ensureDialogs();
    wire();

    /** 只读读数（给冒烟断言；**不含任何写操作**）。 */
    function openDialogState() {
      const d = $('#edit-dialog');
      const field = (id) => { const el = $('#' + id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
      return {
        open: !!(d && d.style.display === 'flex'),
        title: (($('#edit-dialog-title') || {}).textContent) || '',
        topic: field('edit-topic'),
        tags: caps.editTags ? field('edit-tags') : null,
        detail: caps.editDetail ? field('edit-detail') : null,
        expanded: caps.editExpanded ? field('edit-expanded') : null,
        visibleFields: ['topic', 'tags', 'detail', 'expanded'].filter((k) => {
          const row = fieldRow(k);
          return !!row && row.style.display !== 'none';
        }),
        capabilities: Object.assign({}, caps)
      };
    }

    const api = {
      // 编辑（五项验收就是这五个）
      editNode: editSelected,
      addChild: addChild,
      addSibling: addSibling,
      deleteNode: deleteNode,
      moveNode: moveNode,
      // 对话框
      closeEdit: closeEditDialog,
      openDialogState: openDialogState,
      // 能力（只读副本）
      capabilities: Object.assign({}, caps),
      capabilityNotes: Object.assign({}, CAP_NOTES),
      // 改前就有的五个入口名（主窗的 `window.MMEditor` 逐字沿用）
      openImageDialog: openImageDialog,
      openFileDialog: openFileDialog,
      pickAndImportMd: pickAndImportMd,
      pickExportMd: pickExportMd,
      // 其它
      host: h,
      destroy: destroy
    };
    return api;
  }

  MM.Editor = { create: create, CAPS: CAPS, CAP_NOTES: CAP_NOTES, genId: genId };

  /* ================= 主窗启动 =================
   * 只在"本页自带对话框骨架"的页面里造实例 —— 判据就是 `#edit-dialog` 在静态 HTML 里存不存在：
   *   · 主窗（`index.html`）有 ⇒ 造一个**全能力**实例，挂到 `window.MMEditor`（改前的同一个名字）；
   *   · 草稿页（`draft-map.html`）没有 ⇒ 本文件只发布 `MM.Editor`，由草稿页自己
   *     `MM.Editor.create({…草稿的能力位…})`（草稿页的差异写在**它**那一侧，不写进本文件）。
   * 为什么用"骨架存在"而不是一个开关变量：草稿页是 `script-src 'self'` 的 CSP 页面，
   * **不能**写内联 `<script>` 去设开关；而"这一页有没有主图的对话框骨架"是静态可判的事实。 */
  function bootMain() {
    if (!doc_hasEditDialog()) return;
    const host = (MM.mainEditorHost && MM.mainEditorHost()) || fallbackMainHost();
    if (!host) return;
    window.MMEditor = MM.Editor.create(host);
  }
  function doc_hasEditDialog() {
    return !!(document.getElementById('edit-dialog'));
  }

  /** 兜底宿主（`app-actions.js` 没提供 `MM.mainEditorHost` 时才用）：只够还原改前的行为。
   *  ⚠️ 它**不是**第二份编辑器：能力位与调用顺序都由本模块决定，这里只填"落到哪里"。 */
  function fallbackMainHost() {
    const app = () => window.MMApp;
    if (!app()) return null;
    if (window.console && console.warn) {
      console.warn('[editor] 没有 MM.mainEditorHost：用了兜底宿主（撤销栈/删除预检会退化为不记栈、不预检）');
    }
    return {
      adapter: MM.adapter,
      getJm: () => app().getState().jm,
      setStatus: (t, e) => app().setStatus(t, e),
      getProject: () => app().getState().project,
      showDetail: (n) => app().showDetail(n),
      reloadProject: (name) => app().openProject(name),
      capabilities: { editTopic: true, editDetail: true, editTags: true, editExpanded: true,
        addChild: true, addSibling: true, deleteNode: true, moveNode: false,
        undoRedo: true, save: true, assets: true, markdown: true, crossProject: true, overlays: true },
      history: { undo: () => app().undo(), redo: () => app().redo() },
      onSave: () => app().save(),
      overlays: {
        closeLightbox: () => app().closeLightbox(),
        closeFilePreview: () => app().closeFilePreview(),
        hideFloatDetail: () => app().hideFloatDetail(),
        paletteIsOpen: () => app().paletteIsOpen()
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootMain);
  else bootMain();
})();
