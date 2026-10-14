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

  // 适配层命名空间（与其余 renderer 模块同一写法）：
  // 本文件此前只用 window.MMApp / window.MMEditor，没有 MM 绑定 —— 走 MM.adapter 就必须
  // 显式持有它，不能依赖"window.MM 恰好能当裸标识符解析"这种隐式全局（换个加载方式就崩 ✗）。
  const MM = window.MM || (window.MM = {});

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
    /* 定位：**先让它显示出来、量到真实尺寸，再定位置**（不超出视口）。
     *
     * 改前的形状是 `offsetWidth || 160` / `offsetHeight || 40` —— 而此刻菜单还是
     * `display:none`（上一次 closeMenu 留下的）⇒ 两个 offset 都是 0 ⇒ **宽高恒按 160×40 估**
     * （实测节点菜单 12 条 ≈ 428px 高）⇒ 菜单开在靠下位置时，最后 8 条落到窗口可视区之外：
     * `document.elementFromPoint` 直接返回 **null**（点不到；菜单不受 scroll 影响，滚也没用 ✗）。
     *
     * 现在的四段（顺序即语义，别调换）：
     *   ① 先摆到游标处并 `display:block`（`visibility:hidden` 挡住这一帧 —— 全是同一批 JS，
     *      量完就复位，浏览器不会画出中间态）；
     *   ② 量**真实**尺寸；
     *   ③ 夹进视口：右边放不下 ⇒ 左移；下边放不下 ⇒ **上翻**（右键菜单的常规行为，
     *      上翻也放不下才贴住视口下缘）；
     *   ④ 极矮窗口（菜单比视口还高）时才给一个滚动上限 —— 保证**每一条都点得到**。
     * 判据（`scripts/smoke/46-节点级拖动.js` 丙）：面板下部的节点右键后，
     * **每一条菜单项**（含最后一条）的中心都被 `elementFromPoint` 命中，且真鼠标点最后一条真的生效。 */
    const pad = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.maxHeight = '';          // 复位上一次可能为了塞进矮窗口设过的上限（否则量到的是被压过的高度）
    menu.style.overflowY = '';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.visibility = 'hidden';
    menu.style.display = 'block';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = x;
    let top = y;
    if (left + mw + pad > vw) left = vw - mw - pad;
    if (left < pad) left = pad;
    if (top + mh + pad > vh) top = (y - mh >= pad) ? (y - mh) : (vh - mh - pad);
    if (top < pad) top = pad;
    if (mh > vh - pad * 2) {            // 视口比菜单还矮：给滚动上限，否则尾部仍然点不到
      menu.style.maxHeight = (vh - pad * 2) + 'px';
      menu.style.overflowY = 'auto';
    }
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
  }

  /* ================= 菜单内容 ================= */
  /** 拖动树菜单项：进入/退出拖动模式（文案随当前模式切换）。
   *  进入时锁定 nodeId 所在**顶层主题树**（root 直接子节点）为拖动目标：
   *  此后左键按住拖动 = 只移动该棵树，其他树不动（视图操作，偏移随保存持久化）。
   *  仅节点菜单使用（右键树内任意节点都拖其所属整棵树）；root 无所属树，不显示。
   *  ⚠️ 这一条是**既有语义**（v0.15 起，一字未改）—— 「移动单位 = 整棵顶层主题树」。
   *  R2 期 1 新增的**更细**那一档在同文件的 `subtreeDragItem`（两者并列，不是替换）。 */
  function dragModeItem(nodeId) {
    const app = () => window.MMApp;
    const active = !!(app().dragModeActive && app().dragModeActive());
    if (active) {
      return { label: '退出拖动模式（Esc）', action: () => app().setDragMode(false) };
    }
    const treeRoot = app().treeRootOf ? app().treeRootOf(nodeId) : null;
    if (!treeRoot) return null;
    const jm = app().getState().jm;
    const topic = jm && MM.adapter.getNode(jm, treeRoot) ? MM.adapter.getNode(jm, treeRoot).topic : treeRoot;
    return {
      label: '拖动树：移动「' + topic + '」',
      action: () => app().setDragMode(true, treeRoot)
    };
  }

  /** 【R2 期 1 · b（位置可调）】拖动**这个子树**（nodeId 及其后代，不是整棵顶层主题树）。
   *  只有**更深的节点**才显示：顶层主题那一档已由 `dragModeItem` 覆盖（同一个目标不必两条入口 ✗），
   *  root 无所属子树（它是容器）。
   *  拖动本身仍走既有那一套（`setDragMode(true, 任意节点id)` ⇒ treeOffsets 键域已扩到任意子树根），
   *  本项只是**入口**。偏移随保存进 `meta.nodeOffsets`（契约见 docs/DATA-FORMAT.md §1）。 */
  function subtreeDragItem(nodeId) {
    const app = () => window.MMApp;
    if (app().dragModeActive && app().dragModeActive()) return null;  // 已在拖动模式：只留"退出"那一条
    const jm = app().getState().jm;
    const n = jm && MM.adapter.getNode(jm, nodeId);
    if (!n || n.isroot || !n.parent) return null;
    if (n.parent.isroot) return null;                                  // 顶层主题：走 dragModeItem
    return {
      label: '拖动此子树：只移动「' + n.topic + '」及其子节点',
      action: () => app().setDragMode(true, nodeId)
    };
  }

  /** 【R2 期 1】「把这个子树移回自动布局」：只清**这个节点自己**那一项偏移
   *  （拖动结果会保存 ⇒ 必须给一条清回去的路，否则用户拖远了只能靠改数据文件；
   *   既有先例：框选菜单里那条"把这棵树移回自动布局"）。
   *  只有它**自己**有偏移时才显示 —— 祖先（如顶层主题）的偏移归祖先那条入口管 ✓ */
  function clearOffsetItem(nodeId) {
    const app = () => window.MMApp;
    if (!app().hasOwnOffset || !app().hasOwnOffset(nodeId)) return null;
    const jm = app().getState().jm;
    const n = jm && MM.adapter.getNode(jm, nodeId);
    return {
      label: '移回自动布局：清掉「' + (n ? n.topic : nodeId) + '」的手工位置',
      action: () => {
        app().clearTreeOffsets(nodeId);
        app().setStatus('已把「' + (n ? n.topic : nodeId) + '」移回自动布局（记得保存）');
      }
    };
  }

  /** 【R2 期 1 · a（方向）】顶层主题的左右分侧入口 —— **只把已有语义变成可点**：
   *  改的是 `meta.layout`（唯一真源），落地走"打开项目那一套"重渲染（见 app-view 的 setThemeSide）。
   *  只有**顶层主题**显示：jsMind 只认 root 直接子节点的 `direction`，给更深的节点用是骗人
   *  （实测探针见设计稿 §2.2.1）⇒ 深层节点不显示这一项，而不是显示了却不起作用 ✗ */
  function themeSideItems(nodeId) {
    const app = () => window.MMApp;
    const jm = app().getState().jm;
    const n = jm && MM.adapter.getNode(jm, nodeId);
    if (!n || n.isroot || !n.parent || !n.parent.isroot) return [];
    const cur = app().themeSideOf ? app().themeSideOf(nodeId) : null;
    const act = (side) => () => {
      let p = null;
      try { p = app().setThemeSide(nodeId, side); }
      catch (e) {                                  // 动作里抛异常必须**响亮**，不许静默消失 ✗
        app().setStatus('分侧没生效：' + ((e && e.message) || e), true);
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then((r) => { if (r && !r.ok) app().setStatus('分侧没生效：' + r.reason, true); })
          .catch((e) => app().setStatus('分侧没生效：' + ((e && e.message) || e), true)); // 不静默 ✗
      } else if (!p) {
        app().setStatus('分侧没生效：没有 setThemeSide 入口', true);
      }
    };
    return [
      { label: '摆到左侧（整支）' + (cur === 'left' ? '（当前）' : ''), action: act('left') },
      { label: '摆到右侧（整支）' + (cur === 'right' ? '（当前）' : ''), action: act('right') }
    ];
  }

  function nodeMenu(nodeId) {
    const app = () => window.MMApp;
    const jm = app().getState().jm;
    const node = jm ? MM.adapter.getNode(jm, nodeId) : null;
    if (!node) return;
    const isRoot = node.id === 'root';
    const items = [
      { label: '编辑（F2）', action: () => app().editNode(nodeId) },
      // 2026-10-09：用户「找不到关联视图」⇒ 右键菜单是找节点操作的第一落点 ✓
      // （与详情框左缘那颗圆形 🔗 按钮等价 ✓，多一个入口只为好找 ✓）
      { label: '🔗 关联节点（高亮展示）', action: () => { if (window.MM && window.MM.showRelated) window.MM.showRelated(nodeId); } },
      { label: '新增子节点', action: () => app().addNode(nodeId) },
      { label: '新增同级节点', action: () => app().addSiblingNode(nodeId) },
      '---',
      { label: '展开', action: () => { MM.adapter.expandNode(jm, nodeId); app().setStatus('已展开：' + node.topic); } },
      { label: '收起', action: () => { MM.adapter.collapseNode(jm, nodeId); app().setStatus('已收起：' + node.topic); } },
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
    // R2 期 1：更细的一档（拖动此子树）+ 手工位置的"清回去" + 顶层主题的左右分侧
    const subDrag = subtreeDragItem(nodeId);
    const clearOff = clearOffsetItem(nodeId);
    const sideItems = themeSideItems(nodeId);
    if (subDrag || clearOff || sideItems.length) {
      items.push('---');
      if (subDrag) items.push(subDrag);
      if (clearOff) items.push(clearOff);
      sideItems.forEach((it) => items.push(it));
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
      if (jm && id) MM.adapter.selectNode(jm, id); // 先选中，保证菜单操作作用于该节点
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
            let n = MM.adapter.getNode(jm, ids[0]);
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
      // 双击 = **展开 / 收起**（用户 2026-10-08 定 ✓）。编辑改从右键菜单「编辑（F2）」进 ✓
      //（那条本来就在，见本文件顶部的 nodeItems）——所以这里不再弹编辑框 ✗。
      const fn = (window.MM && window.MM.toggleNodeExpanded)
        || (window.MMApp && window.MMApp.toggleNodeExpanded);
      if (id && fn) {
        e.preventDefault();
        fn(id);
      } else if (id && window.MM && window.MM.setStatus) {
        window.MM.setStatus('双击展开/收起还没接线（缺 toggleNodeExpanded）', true);   // 不静默 ✗
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
