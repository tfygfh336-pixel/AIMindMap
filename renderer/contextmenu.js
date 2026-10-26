/* ============================================================
 * AI MindMap — 右键菜单 + 双击编辑（contextmenu.js）
 * ------------------------------------------------------------
 * 人用交互增强（参考 XMind / FreeMind 等开源导图习惯）：
 *   - 双击节点      → 有子节点 = 展开/收起；无子节点（叶子 / 只连边的节点）= 打开详情框（R5-3）
 *   - 右键节点      → 编辑 / 新增子节点 / 新增同级 / 删除 /
 *                     展开 / 收起 / 添加图片
 *                    ＋ 节点带**本机链接**（`localPath`）时**恰好四项**：
 *                      打开 / 打开方式 / 在文件资源管理器中打开 / 取消链接
 *                      （用户 2026-10-31 的裁定；唯一实现在本文件的 `localPathItems`，
 *                        详情框里那条链接的右键也用它 —— 两处一份，别各写一遍）
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
      /* 悬停说明（可选）：本机链接那四项用它带上**完整路径** ——
       * 标签必须逐字是"打开 / 打开方式 / 在文件资源管理器中打开 / 取消链接"
       * （用户原话的那四项），长路径塞进标签会把菜单横向撑爆，所以走 title。 */
      if (it.title) el.title = it.title;
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
  /* 【2026-10-33 批4 · 收敛拖动模式入口】用户 2026-10-31 说「移除拖动模式」。
   * 第一期**只摘入口**：下面四条菜单项从这里整体删掉了（连同它们的构造函数）——
   *   · 拖动树（`dragModeItem`，v0.15 起的「移动单位 = 整棵顶层主题树」）
   *   · 拖动此子树（`subtreeDragItem`，R2 期 1 的节点级一档）
   *   · 拖动到同级第几位（`reorderDragItem`，R2 期 3 的同级重排）
   *   · 挂到别的父节点下（`reparentItem`，R2 期 4 的重挂父）
   * 四条都是"进拖动模式"的**入口**（都只是调 `MMApp.setDragMode(...)`），不是那个 API 本身。
   * ⚠️ `setDragMode` / `dragModeActive` / `dragModeKind` / `getDragTreeRoot` 那一族
   *    **一个字节都没删**（`renderer/app-view.js` 的实现 + `renderer/app.js` 的四个转发都在）——
   *    它们是 `scripts/smoke/` 多个域的前置夹具，且"摘入口 ≠ 摘 API"这件事本身有断言钉着。
   * ⚠️ 右键**清除**拖动模式那一段（本文件 `onContextMenu` 里）也保留：模式本体还在，
   *    只是不再有菜单入口。要恢复入口，从版本库里把上面四个函数取回来即可。 */

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

  /* ---------------- 本机链接（节点字段 `localPath`）的右键四项 ----------------
   * 用户 2026-10-31 的原话：「右键文件链接的时候右键内容**只需要**打开、打开方式、
   * 文件资源管理器中打开、取消链接四个功能」。
   * ⇒ **恰好四项**，顺序照用户写的那个顺序；**不许**再多第五项（"复制路径"之类确实有用，
   *   但用户说的是"只需要" ⇒ 要加先问，别自己加）。
   * ⇒ 这一族**只有这一份**：节点右键（`nodeMenu`）与详情框里那条链接的右键
   *   （`renderer/app-detail-content.js` 的 `.fd-localpath-link`）都调它 ——
   *   两处各写一遍 = 下一个改这四项的人只会改到一处。
   * ⇒ 四项**各自真的做那件事**：
   *   ① 打开      = **与左键同一个函数**（`MM.openLocalPath`，缺省 mode ⇒ 系统默认程序；
   *                  没有默认关联时 Windows 自己弹「打开方式」）
   *   ② 打开方式  = `mode:'openAs'` ⇒ 主进程起 `rundll32 shell32.dll,OpenAs_RunDLL`
   *                  （**不是**"再打开一次"—— 那件事 `shell.openPath` 做不到）
   *   ③ 在文件资源管理器中打开 = `mode:'reveal'` ⇒ 文件走 `showItemInFolder`（选中它）、
   *                  目录走 `openPath`（打开该目录）
   *   ④ 取消链接  = 把 `localPath` 从**数据**里删掉并走既有保存通道（`MM.clearLocalPath`）
   * 标签**逐字**就是用户说的那四个（不加 emoji、不把路径拼进标签 —— 标签变了就不再是
   * "用户说的那四项"）；完整路径放在 `title` 上（悬停可见，菜单宽度也不会被长路径撑爆）。
   * @param {string} lp 本机绝对路径（节点数据里的 localPath，已由 path-chain 判过形状）
   * @param {string} nodeId 这个链接属于哪个节点（④ 要用它定位数据）
   * @returns {Array<object>} 恰好四项（可直接交给 `openMenu`）
   */
  function localPathItems(lp, nodeId) {
    const app = () => window.MMApp;
    const run = (mode) => () => {
      if (!app().openLocalPath) { app().setStatus('打开入口没接线：MMApp.openLocalPath', true); return; }
      app().openLocalPath(lp, mode ? { mode: mode } : undefined);
    };
    return [
      { label: '打开', title: lp, action: run('') },
      { label: '打开方式', title: '用系统「打开方式」选择栏打开：' + lp, action: run('openAs') },
      { label: '在文件资源管理器中打开', title: lp, action: run('reveal') },
      {
        label: '取消链接',
        title: '把这个节点的本机路径（localPath）清掉并保存',
        danger: true,
        action: () => {
          if (!app().clearLocalPath) { app().setStatus('取消链接没接线：MMApp.clearLocalPath', true); return; }
          app().clearLocalPath(nodeId);
        }
      }
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
    /* 本机链接（节点字段 `localPath`，见 `docs/DATA-FORMAT.md` §2.1）：有才显示，
     * 且**恰好四项**（打开 / 打开方式 / 在文件资源管理器中打开 / 取消链接）——
     * 用户 2026-10-31 明确说"只需要"这四个。
     * ⚠️ 这里**不是**第五项：改前的「📁 打开文件夹：<末级名>」已被这四项**取代**
     *   （它是"打开"那一个动作的旧说法，不是另一件事）。 */
    const lp = (node.data && node.data.localPath) || '';
    if (lp) {
      items.push('---');
      localPathItems(lp, nodeId).forEach((it) => items.push(it));
    }
    if (!isRoot) items.push({ label: '删除节点', danger: true, action: () => app().deleteNode(nodeId) });
    // 手工位置的"清回去" + 顶层主题的左右分侧（这两条都不是拖动模式的入口 ✓）
    // ⚠️ 2026-10-33 批4：四条**拖动模式入口**（拖动树 / 拖动此子树 / 拖动到同级第几位 /
    //    挂到别的父节点下）已从这里摘除（见上面那段说明）；`setDragMode` 那套 API 一个字节没删。
    const clearOff = clearOffsetItem(nodeId);
    const sideItems = themeSideItems(nodeId);
    if (clearOff || sideItems.length) {
      items.push('---');
      if (clearOff) items.push(clearOff);
      sideItems.forEach((it) => items.push(it));
    }
    openMenu(lastX, lastY, items);
  }

  /** 【R5 · R2 期 5】结构轴菜单项（树结构 / 复杂结构）——**这是独立的一条轴**：
   *  与「主题模式」（`setRootMode`：容器根显隐 + `meta.rootMode` 持久化）并列而互不相干 ——
   *  把两件事合并进一个键 = 一次改动写两件事 ✗。文案照既有风格；复杂档的呈现走既有关系层
   *  （唯一入口 `MM.showRelated`，见 `renderer/app-view.js` 的 setStructureMode）。
   *  `setStructureMode` 返回 Promise ⇒ 失败要**响亮说**（照 themeSideItems 的写法，不静默 ✗）。 */
  function structureModeItem() {
    const app = () => window.MMApp;
    const cur = app().structureMode ? app().structureMode() : 'tree';
    const act = (mode) => () => {
      let p = null;
      try { p = app().setStructureMode(mode); }
      catch (e) {                                     // 动作里抛异常必须**响亮**，不许静默消失 ✗
        app().setStatus('切换结构模式没生效：' + ((e && e.message) || e), true);
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then((r) => {
          if (r && r.ok === false) app().setStatus('切换结构模式没生效：' + (r.reason || '未知原因'), true);
        }).catch((e) => app().setStatus('切换结构模式没生效：' + ((e && e.message) || e), true));
      } else if (!p) {
        app().setStatus('切换结构模式没生效：没有 setStructureMode 入口', true);
      }
    };
    return cur === 'complex'
      ? { label: '回到树结构模式（只画父子骨架）', action: act('tree') }
      : { label: '开启复杂结构模式（画节点之间的自由边）', action: act('complex') };
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
      /* 【R5 · R2 期 5】另一条轴：**结构轴 = 树结构 / 复杂结构**（边从哪来）。
       * 与上面那条"主题模式"并列而**不是**同一件事：那条管容器根显隐、写 meta.rootMode；
       * 这条会话级（不写盘），复杂档把当前选中节点的自由边交给既有关系层呈现。
       * 复用既有入口的写法（`app().setXxx`）；返回 Promise，失败了要**响亮说**（照 themeSideItems）。 */
      structureModeItem(),
      { label: '还原视图（找回导图）', action: () => app().resetView() },
      '---',
      { label: '展开全部', action: () => app().expandAll() },
      { label: '收起全部', action: () => app().collapseAll() }
      // 导入/导出 Markdown 仅保留「文件」菜单入口（v0.16 起工具栏与右键入口移除）
      // 拖动模式那四条入口 2026-10-33 批4 已从**节点菜单**摘除（右键背景本来就没有它们）
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
    if (!isNodeEl(target)) return;
    const id = getBindedNodeId(target);
    if (!id) return;
    const jm = window.MMApp && window.MMApp.getState && window.MMApp.getState().jm;
    const node = jm && MM.adapter ? MM.adapter.getNode(jm, id) : null;
    if (!node) {
      // 拿不到节点 = 采不到真值 ⇒ **响亮说**，不许静默什么都不干 ✗
      if (window.MM && window.MM.setStatus) {
        window.MM.setStatus('双击：拿不到节点 ' + id + '（树是不是刚重载过？）', true);
      }
      return;
    }
    /* 【R5-3 · R2 期 5】双击按「**有没有父子关系**」分岔：
     *   有子节点 ⇒ 展开 / 折叠（用户 2026-10-08 定，一字不改）；
     *   没有子节点（叶子 / 复杂结构里只连边、无子的节点 / 孤立节点）⇒ 打开**详情框**。
     * ⚠️「有没有父子」必须**现算子节点数**（`node.children.length`），**不许读 `expanded`**：
     *   真数据里两种形状都有 —— 光杆节点标着 expanded:false（假折叠）、叶子标着 expanded:true；
     *   读 expanded 会把**折叠着的父节点**误判成叶子、把带展开标记的叶子误判成父节点
     *   （域 51 的注入取证：把这一行改成读 expanded ⇒ 那两条判据必红）。
     * ⚠️ 开详情**只经 `MM.showDetail`** —— 它是"打开详情框"的唯一入口（点线的"记访问"也挂在它里面）；
     *   这里**不许**新开第二条开详情的路。R1 的两击配对判别（app-detail-content.js 的 pendingClick /
     *   300ms 窗口 / `clickJudgeState`）本批一个字都没动：这条分岔只在 dblclick 这一拍上**选一个动作**。 */
    const hasChildren = !!(node.children && node.children.length);
    if (!hasChildren) {
      if (typeof MM.showDetail === 'function') {
        e.preventDefault();
        MM.showDetail(node);
        return;
      }
      // 缺 showDetail ⇒ 不许静默（与下面缺 toggleNodeExpanded 同一条纪律）
      if (window.MM && window.MM.setStatus) {
        window.MM.setStatus('双击开详情还没接线（缺 MM.showDetail）', true);
      }
      return;
    }
    const fn = (window.MM && window.MM.toggleNodeExpanded)
      || (window.MMApp && window.MMApp.toggleNodeExpanded);
    if (fn) {
      e.preventDefault();
      fn(id);
    } else if (window.MM && window.MM.setStatus) {
      window.MM.setStatus('双击展开/收起还没接线（缺 toggleNodeExpanded）', true);   // 不静默 ✗
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
    window.MMContextMenu = { openMenu, closeMenu, isNodeEl, getBindedNodeId, localPathItems };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
