/* ============================================================
 * AI MindMap — 手动编辑交互（editor.js）
 * ------------------------------------------------------------
 * 职责：
 *   1) 节点编辑对话框（标题 / 详情 HTML / 展开状态）
 *   2) 图片导入对话框（文件选择 → desktop.asset.import →
 *      更新节点 images → 提示保存）
 *   3) 键盘快捷键（F2 编辑 / Delete 删除 / Ctrl+Z / Ctrl+Y / Ctrl+N）
 *   4) 导入 / 导出 Markdown 的路径选择与调用
 * 依赖 window.MMApp（app.js）的状态与方法。
 * ============================================================ */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = () => window.MMApp;
  const getNode = (id) => {
    const jm = app().getState().jm;
    return jm ? jm.get_node(id) : null;
  };

  /* ================= 节点编辑对话框 ================= */
  let editingId = null;

  function openEditDialog(id) {
    const node = getNode(id);
    if (!node) return;
    editingId = node.id;
    $('#edit-dialog-title').textContent = '编辑节点：' + node.topic;
    $('#edit-topic').value = node.topic;
    $('#edit-tags').value = ((node.tags || (node.data && node.data.tags)) || []).join(',');
    $('#edit-detail').value = node.detail || (node.data && node.data.detail) || '';
    $('#edit-expanded').checked = node.expanded !== false;
    $('#edit-dialog').style.display = 'flex';
    $('#edit-topic').focus();
    $('#edit-topic').select();
  }

  function closeEditDialog() {
    $('#edit-dialog').style.display = 'none';
    editingId = null;
  }

  function saveEditDialog() {
    const node = getNode(editingId);
    if (!node) { closeEditDialog(); return; }
    const topic = $('#edit-topic').value.trim();
    if (!topic) { alert('标题不能为空'); return; }
    const tags = $('#edit-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const detail = $('#edit-detail').value;
    const expanded = $('#edit-expanded').checked;

    // 记录快照后修改
    const jm = app().getState().jm;
    if (node.topic !== topic) jm.update_node(node.id, topic);
    // 标题里若含行内 Markdown（`**加粗**` / 反引号代码），在这里补一次渲染期转换 ——
    // jsMind 刚把原文写进节点元素，是唯一需要重转的时机（详见 app-core.js 的 applyTopicMarkup）。
    if (window.MM && window.MM.applyTopicMarkup) window.MM.applyTopicMarkup(jm);
    node.data = node.data || {};
    node.data.detail = detail;
    if (tags.length) node.data.tags = tags; else delete node.data.tags;
    if (node.expanded !== expanded) {
      if (expanded) jm.expand_node(node.id); else jm.collapse_node(node.id);
    }
    app().setStatus('节点已更新，点击保存生效');
    closeEditDialog();
  }

  /* ================= 图片导入对话框 ================= */
  let imageTargetId = null; // 图片对话框的独立目标（与编辑对话框 editingId 互不干扰）

  function openImageDialog(id) {
    const node = getNode(id);
    if (!node) { app().setStatus('请先选中节点再添加图片'); return; }
    imageTargetId = node.id;
    $('#image-file').value = '';
    $('#image-caption').value = '';
    $('#image-source').value = '';
    $('#image-tags').value = '';
    $('#image-dialog').style.display = 'flex';
  }

  async function saveImageDialog() {
    const node = getNode(imageTargetId);
    if (!node) { app().setStatus('目标节点不存在，请重新打开图片对话框', true); $('#image-dialog').style.display = 'none'; return; }
    const fileInput = $('#image-file');
    const file = fileInput.files && fileInput.files[0];
    if (!file) { alert('请选择图片文件'); return; }
    const caption = $('#image-caption').value.trim();
    if (!caption) { alert('请填写内容备注 caption（AI 凭此理解图片）'); return; }
    const source = $('#image-source').value.trim();
    const tags = $('#image-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const project = app().getState().project;
    if (!project) { alert('未加载项目'); return; }
    try {
      await window.desktop.asset.import(project.name, node.id, file.path, caption, source, tags);
      // 重读项目数据（CLI 已把图片写入 JSON 与 assets/）
      const r = await window.desktop.project.read(project.name);
      const reloaded = findNode(r.data.data, node.id);
      if (reloaded) {
        node.images = reloaded.images || [];
        node.data = node.data || {};
        node.data.images = node.images;
        app().showDetail(node);
      }
      app().setStatus('图片已添加，点击保存生效');
    } catch (err) {
      app().setStatus('图片导入失败：' + ((err && err.message) || err), true);
    }
    $('#image-dialog').style.display = 'none';
  }

  /* ================= 附件（文件）对话框 ================= */
  let fileTargetId = null;

  function openFileDialog(id) {
    const node = getNode(id);
    if (!node) { app().setStatus('请先选中节点再添加附件'); return; }
    fileTargetId = node.id;
    $('#file-file').value = '';
    $('#file-caption').value = '';
    $('#file-source').value = '';
    $('#file-dialog').style.display = 'flex';
  }

  async function saveFileDialog() {
    const node = getNode(fileTargetId);
    if (!node) { app().setStatus('目标节点不存在，请重新打开附件对话框', true); $('#file-dialog').style.display = 'none'; return; }
    const fileInput = $('#file-file');
    const file = fileInput.files && fileInput.files[0];
    if (!file) { alert('请选择附件文件'); return; }
    const caption = $('#file-caption').value.trim();
    if (!caption) { alert('请填写内容备注 caption（AI 凭此理解附件用途）'); return; }
    const source = $('#file-source').value.trim();
    const project = app().getState().project;
    if (!project) { alert('未加载项目'); return; }
    try {
      await window.desktop.asset.importFile(project.name, node.id, file.path, caption, source);
      // 重读项目数据（CLI 已把附件写入 JSON 与 attachments/）
      const r = await window.desktop.project.read(project.name);
      const reloaded = findNode(r.data.data, node.id);
      if (reloaded) {
        node.files = reloaded.files || [];
        node.data = node.data || {};
        node.data.files = node.files;
        app().showDetail(node);
      }
      app().setStatus('附件已添加，点击保存生效');
    } catch (err) {
      app().setStatus('附件导入失败：' + ((err && err.message) || err), true);
    }
    $('#file-dialog').style.display = 'none';
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
    const node = app().getState().jm && app().getState().jm.get_selected_node();
    const parent = node ? node.id : 'root';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        const project = app().getState().project;
        app().setStatus('导入中…');
        const res = await window.desktop.app.importMd(project.name, f.path, parent);
        if (res && res.ok) {
          await app().openProject(project.name);
          app().setStatus('导入完成');
        } else {
          app().setStatus('导入失败', true);
        }
      } catch (err) {
        app().setStatus('导入失败：' + ((err && err.message) || err), true);
      }
    };
    input.click();
  }

  async function pickExportMd() {
    const project = app().getState().project;
    if (!project) { app().setStatus('未加载项目'); return; }
    try {
      const r = await window.desktop.app.exportMdDialog(project.name);
      if (!r || r.canceled) return;
      app().setStatus(r.ok ? '已导出：' + r.file : '导出失败：' + r.err, !r.ok);
    } catch (err) {
      app().setStatus('导出失败：' + ((err && err.message) || err), true);
    }
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

  function onKey(e) {
    const inDialog = $('#edit-dialog').style.display === 'flex' || $('#image-dialog').style.display === 'flex' || $('#file-dialog').style.display === 'flex';
    if (inDialog) {
      if (e.key === 'Escape') { closeEditDialog(); $('#image-dialog').style.display = 'none'; $('#file-dialog').style.display = 'none'; }
      if (e.key === 'Enter' && !e.shiftKey && $('#edit-dialog').style.display === 'flex') { saveEditDialog(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    // 命令面板自身处理 ↑↓/Enter/Esc；这里不要重复响应（Esc 由 app.js 统一收口）
    if (e.key === 'Escape' && (inTextInput(e) || (window.MMApp && window.MMApp.paletteIsOpen && window.MMApp.paletteIsOpen()))) return;
    if (e.key === 'Escape') {
      // 依次关闭：灯箱 → 文件预览 → 浮动详情
      const lb = $('#lightbox');
      if (lb && lb.style.display === 'flex') { app().closeLightbox(); return; }
      const fp = $('#file-preview');
      if (fp && fp.style.display === 'flex') { app().closeFilePreview(); return; }
      if (document.querySelector('.float-detail')) { app().hideFloatDetail(); return; }
    }
    // 在输入框里打字时，除撤销/重做/保存外一律不响应快捷键（尤其 Delete/Backspace）
    if (inTextInput(e)) {
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); app().undo(); }
      else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); app().redo(); }
      else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); app().save(); }
      return;
    }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); app().save(); }
    else if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); app().undo(); }
    else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); app().redo(); }
    else if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); app().addNode(); }
    else if (e.key === 'F2') { e.preventDefault(); app().editNode(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const jm = app().getState().jm;
      const sel = jm && jm.get_selected_node();
      if (sel && sel.id !== 'root') { e.preventDefault(); app().deleteNode(sel.id); }
    }
  }

  /* ================= 接线 ================= */
  function wire() {
    // 编辑对话框
    $('#edit-cancel').addEventListener('click', closeEditDialog);
    $('#edit-ok').addEventListener('click', saveEditDialog);
    // 图片对话框
    $('#image-cancel').addEventListener('click', () => { $('#image-dialog').style.display = 'none'; });
    $('#image-ok').addEventListener('click', saveImageDialog);
    // 附件对话框
    $('#file-cancel').addEventListener('click', () => { $('#file-dialog').style.display = 'none'; });
    $('#file-ok').addEventListener('click', saveFileDialog);
    // 图片入口：工具栏"编辑"对话框内无按钮，提供全局函数供 app.js 调用
    window.MMEditor = {
      editNode: openEditDialog,
      openImageDialog,
      openFileDialog,
      pickAndImportMd,
      pickExportMd
    };
    document.addEventListener('keydown', onKey);
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
