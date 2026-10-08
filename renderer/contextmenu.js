/* ============================================================
 * AI MindMap — 右键菜单 + 双击编辑（contextmenu.js）
 * ------------------------------------------------------------
 * 人用交互增强（参考 XMind / FreeMind 等开源导图习惯）：
 *   - 双击节点      → 打开完整编辑对话框（标题+详情+展开）
 *   - 右键节点      → 编辑 / 新增子节点 / 新增同级 / 删除 /
 *                     展开 / 收起 / 添加图片
 *   - 右键空白背景  → 新建子节点（根下）/ 展开全部 / 收起全部 /
 *                     导入 MD / 导出 MD
 * 节点判定：jsMind 节点 DOM 为自定义元素 <jmnode nodeid="...">，
 * 背景为 jmnodes/body 等（与 jsMind view.is_node 同规则）。
 * 依赖 window.MMApp 与 window.MMEditor。
 * ============================================================ */
(function () {
  'use strict';

  const MENU_ID = 'ctx-menu';

  function ensureMenu() {
    let menu = document.getElementById(MENU_ID);
    if (!menu) {
      menu = document.createElement('div');
      menu.id = MENU_ID;
      menu.className = 'ctx-menu';
      menu.style.display = 'none';
      document.body.appendChild(menu);
    }
    return menu;
  }

  function getBindedNodeId(el) {
    if (!el) return null;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'jmnode' || tag === 'jmexpander') return el.getAttribute('nodeid');
    if (tag === 'jmnodes' || tag === 'body' || tag === 'html') return null;
    return getBindedNodeId(el.parentElement);
  }

  function isNodeEl(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'jmnode') return true;
    if (tag === 'jmnodes' || tag === 'body' || tag === 'html') return false;
    return isNodeEl(el.parentElement);
  }

  function closeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu) menu.style.display = 'none';
  }

  /* 菜单项：{ label, action, danger? } */
  function openMenu(x, y, items) {
    const menu = ensureMenu();
    menu.innerHTML = '';
    items.forEach((it) => {
      if (it === '---') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.danger ? ' ctx-danger' : '');
      el.textContent = it.label;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        it.action();
      });
      menu.appendChild(el);
    });
    // 定位：不超出视口
    const pad = 4;
    const mw = menu.offsetWidth || 160;
    const mh = menu.offsetHeight || 40;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = Math.min(x, vw - mw - pad) + 'px';
    menu.style.top = Math.min(y, vh - mh - pad) + 'px';
    menu.style.display = 'block';
  }

  /* ================= 菜单内容 ================= */
  /** 拖动树菜单项：进入/退出拖动模式（文案随当前模式切换）。
   *  进入时锁定 nodeId 所在**顶层主题树**（root 直接子节点）为拖动目标：
   *  此后左键按住拖动 = 只移动该棵树，其他树不动（视图操作，不产生脏数据）。
   *  仅节点菜单使用（右键树内任意节点都拖其所属整棵树）；root 无所属树，不显示。 */
  function dragModeItem(nodeId) {
    const app = () => window.MMApp;
    const active = !!(app().dragModeActive && app().dragModeActive());
    if (active) {
      return { label: '退出拖动模式（Esc）', action: () => app().setDragMode(false) };
    }
    const treeRoot = app().treeRootOf ? app().treeRootOf(nodeId) : null;
    if (!treeRoot) return null;
    const jm = app().getState().jm;
    const topic = jm && jm.get_node(treeRoot) ? jm.get_node(treeRoot).topic : treeRoot;
    return {
      label: '拖动树：移动「' + topic + '」',
      action: () => app().setDragMode(true, treeRoot)
    };
  }

  function nodeMenu(nodeId) {
    const app = () => window.MMApp;
    const jm = app().getState().jm;
    const node = jm ? jm.get_node(nodeId) : null;
    if (!node) return;
    const isRoot = node.id === 'root';
    const items = [
      { label: '编辑（F2）', action: () => app().editNode(nodeId) },
      { label: '新增子节点', action: () => app().addNode(nodeId) },
      { label: '新增同级节点', action: () => app().addSiblingNode(nodeId) },
      '---',
      { label: '展开', action: () => { jm.expand_node(nodeId); app().setStatus('已展开：' + node.topic); } },
      { label: '收起', action: () => { jm.collapse_node(nodeId); app().setStatus('已收起：' + node.topic); } },
      '---',
      { label: '添加图片…', action: () => window.MMEditor && window.MMEditor.openImageDialog(nodeId) },
      { label: '添加附件文件…', action: () => window.MMEditor && window.MMEditor.openFileDialog(nodeId) }
    ];
    // 本机文件夹（节点字段 localPath，见 docs/DATA-FORMAT.md §2.5）：有才显示这一项。
    // 标签只放**末级目录名**（完整路径在详情框里，菜单项太长会横向撑爆）。
    const lp = (node.data && node.data.localPath) || '';
    if (lp) {
      const leaf = String(lp).split(/[\\/]/).filter(Boolean).pop() || lp;
      items.push('---');
      items.push({ label: '📁 打开文件夹：' + leaf, action: () => app().openLocalPath(lp) });
    }
    if (!isRoot) items.push({ label: '删除节点', danger: true, action: () => app().deleteNode(nodeId) });
    // 拖动树入口：root 无所属树（它是容器）→ 不显示；树内任意节点均拖其所属整棵树
    const dragItem = dragModeItem(nodeId);
    if (dragItem) {
      items.push('---');
      items.push(dragItem);
    }
    openMenu(lastX, lastY, items);
  }

  function backgroundMenu() {
    const app = () => window.MMApp;
    // 主题模式判定必须走 MMApp.isThemeMode()。
    // 历史 bug：这里读 app().getState().data，而 state 从来没有 data 字段
    // （getState().data 恒为 undefined）→ themed 永远 false → 即使在主题模式下，
    // 菜单也只显示"开启主题模式"，用户无法从右键关闭主题模式。
    const themed = !!(app().isThemeMode && app().isThemeMode());
    openMenu(lastX, lastY, [
      { label: '新增顶层主题（不选父节点）', action: () => app().addTopic() },
      { label: '在根节点下新建子节点', action: () => app().addNode('root') },
      '---',
      themed
        ? { label: '恢复单中心模式（显示中心节点）', action: () => app().setRootMode('tree') }
        : { label: '开启主题模式（顶层主题互相独立）', action: () => app().setRootMode('themes') },
      { label: '还原视图（找回导图）', action: () => app().resetView() },
      '---',
      { label: '展开全部', action: () => app().expandAll() },
      { label: '收起全部', action: () => app().collapseAll() }
      // 导入/导出 Markdown 仅保留「文件」菜单入口（v0.16 起工具栏与右键入口移除）
      // 拖动树只在节点菜单（右键背景无"目标树"，画布平移已有中键）
    ]);
  }

  /* ================= 事件接线 ================= */
  let lastX = 0;
  let lastY = 0;

  function onContextMenu(e) {
    const target = e.target;
    // 对话框 / 菜单自身区域内不拦截
    if (target.closest && target.closest('.overlay, #ctx-menu')) return;
    // 拖动模式下：**任何位置（节点 / 背景）右键 = 退出拖动模式**，不弹菜单（用户反馈④）
    if (window.MMApp && window.MMApp.dragModeActive && window.MMApp.dragModeActive()) {
      e.preventDefault();
      closeMenu();
      window.MMApp.setDragMode(false);
      return;
    }
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    // 框选菜单（v0.16.3）：右键落在**选区虚线框内**（或选中的节点上）→
    // 「拖动所选 / 收起所选 / 展开所选」专属菜单；框外 → 普通节点/背景菜单。
    if (window.MMApp && window.MMApp.hasSelection && window.MMApp.hasSelection()
      && window.MMApp.selectionHitTest
      && window.MMApp.selectionHitTest(e.clientX, e.clientY)) {
      selectionMenu();
      return;
    }
    if (isNodeEl(target)) {
      const id = getBindedNodeId(target);
      const jm = window.MMApp && window.MMApp.getState().jm;
      if (jm && id) jm.select_node(id); // 先选中，保证菜单操作作用于该节点
      nodeMenu(id);
    } else {
      backgroundMenu();
    }
  }

  /** 框选专属菜单：选区已在 applySelection 时筛选为同父同树组，直接提供操作 */
  function selectionMenu() {
    const app = () => window.MMApp;
    const sel = app().getSelection ? app().getSelection() : { ids: [], groups: [] };
    const items = [];
    if (sel.ids && sel.ids.length) {
      items.push({ label: '拖动所选（整棵所属树）', action: () => app().dragSelection() });
      // 「回到自动布局」：拖动结果现在会**保存**（meta.themeOffsets），所以必须给一条
      // 清回去的路 —— 否则用户拖远了只能靠撤销或重开项目（2026-10-08 加）。
      items.push({
        label: '把这棵树移回自动布局',
        action: () => {
          const ids = sel.ids || [];
          const jm = app().getState && app().getState().jm;
          let top = null;
          if (jm) {
            // 选区已保证同父同树 ⇒ 往上找到顶层主题即可
            let n = jm.get_node(ids[0]);
            while (n && n.parent && !n.parent.isroot) n = n.parent;
            if (n && n.parent && n.parent.isroot && !n.isroot) top = n.id;
          }
          if (top && app().clearTreeOffsets) app().clearTreeOffsets(top);
          else if (app().clearTreeOffsets) app().clearTreeOffsets();
        }
      });
      items.push('---');
    }
    items.push({ label: '收起所选', action: () => app().collapseSelection() });
    items.push({ label: '展开所选', action: () => app().expandSelection() });
    items.push('---');
    items.push({ label: '清除框选', action: () => app().clearSelection() });
    openMenu(lastX, lastY, items);
  }

  function onDblClick(e) {
    if (e.target.closest && e.target.closest('.overlay, #ctx-menu')) return;
    const target = e.target;
    if (isNodeEl(target)) {
      const id = getBindedNodeId(target);
      if (id && window.MMApp) {
        window.MMApp.editNode(id);
        e.preventDefault();
      }
    }
  }

  function wire() {
    const container = document.getElementById('mindmap-container');
    if (!container) return;
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('dblclick', onDblClick);
    // 点击其他区域 / ESC / 滚动关闭菜单
    document.addEventListener('click', (e) => {
      if (!(e.target.closest && e.target.closest('#ctx-menu'))) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
    document.addEventListener('wheel', closeMenu, { passive: true });
    window.addEventListener('blur', closeMenu);
    window.MMContextMenu = { openMenu, closeMenu, isNodeEl, getBindedNodeId };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
