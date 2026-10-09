/* ============================================================
 * AI MindMap — 浮动详情框：内容渲染与容器接线（app-detail-content.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) renderFdBox：渲染某个框的内容（标题/标签/详情/图片/引用关系/附件）
 *   2) bindContainerControls：导图容器点击（选中节点→刷新详情、点空白→隐藏）与 resize
 *      —— 全局只绑一次，避免重复建图时监听器累积
 *   3) observeNodeLayer：节点层 MutationObserver（每次重建先 disconnect 再 observe）
 * 边界（本文件不负责）：
 *   · 框池与定位算法 → app-detail.js；拖动/改大小 → app-detail-drag.js
 *   · 灯箱与文件预览 → app-media.js；搜索与项目切换 → app-actions.js
 * 所有搬迁的函数体与拆分前逐字相同；本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const $ = MM.$;
  const state = MM.state;

  let fdContainerBound = false;
  let fdNodesObserver = null;

  /** 导图容器点击：选中节点→刷新详情；点空白→隐藏浮动详情。
   *
   *  **为什么在 DOM 层接管，而不是听 jsMind 的 select 事件** —— 2026-10-09 实测
   *  （探针与原始报文：`.review/20261009-jsMind事件派发探针/`；
   *   内部符号清单：`renderer/vendor/JSMIND-INTERNALS.md`）：
   *
   *  ① 先钉死一个容易读错的事实：jsMind 0.9.1 **是派发的**。vendor bundle 里共 **12 个**
   *     `invoke_event_handle` 派发点，`select` 那个是第 **[11]** 个，而它就写在**公开方法
   *     `jm.select_node(…)` 的函数体里**。实测：**编程调用一次**（`jm.select_node(…)`）
   *     派发 **1** 次；**真点一下 `<jmnode>`** 也派发 **1** 次，`code/evt` 完全相同
   *     ⇒ **两条路径命中的是同一个派发点**，点击最终也是调这个方法。
   *     所以"编程调用不派发、只有用户点击才派发"**不成立** ✗。
   *     会看混的是**同名**的 `view.select_node(…)` —— 只有那一层是"只改 selected 样式、不派发"。
   *
   *     （本文里的 API 名一律写成 `f(…)` 带省略号：**不是**可执行形状，
   *      免得以"数 renderer 里还剩几处库调用"为口径的脚本/复核把注释算成耦合点。）
   *
   *  ② 但这条事件**仍然不够用**，四条实测：· **点空白根本不派发** —— 空白走 `select_clear()`，
   *     全链 0 派发，而本函数必须先知道"点了空白"才能隐藏详情框；· 派发是**异步**的
   *     （内部 `setTimeout(...,0)`，收到时已是下一拍）；· 节点**不可见就不派发**
   *     （`layout.is_visible` 守卫，收起分支里的节点拿不到）；· 载荷只有 `{evt,data,node}`，
   *     **没有 Ctrl/Cmd**，而 Ctrl+点击在本工程是"加选"语义（见下方守卫）。
   *
   *  ③ 真正的理由：本工程要的是 jsMind **库里没有的模型** —— 多选 / 框选 / 非选中节点虚化 /
   *     关联高亮（jsMind 只有**单个** `mind.selected`，库层面表达不了"一组选中节点"）。
   *     选中的**事实**因此由 DOM 层自己判定（本函数 + `app-view.js` 的选区模型）；
   *     这里的 `jm.select_node(…)` 只负责把 jsMind 自己的**单选游标**同步过去。
   *
   *  **全局只绑一次**；每次操作都用 state.jm 取当前实例，避免重复建图时重复注册。 */
  function bindContainerControls() {
    if (fdContainerBound) return;
    const container = document.getElementById('mindmap-container');
    if (!container) return;
    fdContainerBound = true;

    container.addEventListener('click', (e) => {
      // ② 真机反馈：Ctrl/Cmd + 点击 = 加选，不该弹详情框 ✓（加选语义由 app-view.js 的捕获阶段
      //   mousedown 处理 ✓ 这里只负责「单击节点 → 开详情」）。用户实机确认：不拦就会弹 ✓。
      if (e.ctrlKey || e.metaKey) return;
      const jm = state.jm;
      if (!jm) return;
      // **判定「点击是否来自详情框内部」必须用 composedPath()**，不能只看 e.target.closest()。
      // 原因：详情框内的按钮/条目常常在自己的 click 处理里重建 innerHTML
      // （「移除该图」重渲染本框、点「相关知识点」条目会 showDetail 另一个节点），
      // 这会让**被点的元素当场从 DOM 脱离**（parentNode 变 null）。
      // 事件随后继续冒泡到这里时，`e.target.closest('.float-detail')` 就返回 null，
      // 守卫失效 → 被误判为"点了空白" → hideFloatDetail() 把框关掉。
      // 实测后果：点「相关知识点」条目跳到目标节点后，详情框立即消失（跳转看起来没生效）。
      // composedPath() 记录的是**事件派发当时**的路径，不受后续 DOM 变动影响。
      const path = (typeof e.composedPath === 'function' && e.composedPath()) || [];
      for (let i = 0; i < path.length; i++) {
        const el = path[i];
        if (el && el.classList && el.classList.contains('float-detail')) return;
      }
      if (e.target.closest && e.target.closest('.float-detail')) return; // 兜底（老环境无 composedPath）
      let el = e.target;
      while (el && el !== container) {
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'jmnode') {
          const id = el.getAttribute('nodeid');
          if (id) {
            MM.adapter.selectNode(jm, id);
            const n = MM.adapter.getNode(jm, id);
            if (n) showDetail(n);
          }
          return;
        }
        if (tag === 'jmnodes') break;
        el = el.parentElement;
      }
      hideFloatDetail(); // 点击空白 → 隐藏浮动详情
    });

    window.addEventListener('resize', () => positionFloatDetail());
  }

  /** 节点位置变化（展开/收起/编辑/重排）后重定位浮动详情。
   *  jsMind 每次渲染都会新建 <jmnodes> 元素，因此观察者必须
   *  **先 disconnect 旧的、再 observe 新的** —— 否则观察者随每次重建累积。 */
  function observeNodeLayer(jm) {
    if (fdNodesObserver) { fdNodesObserver.disconnect(); fdNodesObserver = null; }
    const nodesEl = jm && jm.view && jm.view.e_panel ? jm.view.e_panel.querySelector('jmnodes') : null;
    if (!nodesEl) return;
    // 节点层任何样式变化（展开/收起/重排/树偏移）→ 20ms 后：
    // ① 重定位浮动详情；② 重算框选虚线框（跟随节点新位置，大小自适应）
    fdNodesObserver = new MutationObserver(() => setTimeout(() => {
      positionFloatDetail();
      if (MM.refreshSelectionOutline) MM.refreshSelectionOutline();
    }, 20));
    fdNodesObserver.observe(nodesEl, { attributes: true, attributeFilter: ['style'], subtree: true });
  }

  /** 渲染某个框的内容（标题/标签/详情/图片/引用关系/附件） */
  function renderFdBox(box, node) {
    const detail = node.detail || (node.data && node.data.detail) || '';
    fdQ(box, '.fd-title').textContent = '节点详情：' + node.topic;
    const dc = fdQ(box, '.fd-detail-content');
    dc.innerHTML = detail || '<span class="placeholder">（该节点无详情）</span>';
    // 标签 chips（点击 → 按标签全文搜索）
    const tc = fdQ(box, '.fd-tags');
    const tags = (node.tags || (node.data && node.data.tags)) || [];
    tc.innerHTML = '';
    (tags || []).forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = '#' + t;
      chip.addEventListener('click', () => { $('#search-box').value = '#' + t; runSearch(t); });
      tc.appendChild(chip);
    });
    // 本机文件夹链接（可选字段 localPath，见 docs/DATA-FORMAT.md §2.5）：
    // 点击 → 主进程 `shell.openPath` → 系统文件管理器打开该目录。
    // 复用**既有的** `app:open-file` 通道（它本来就是 shell.openPath；目录同样适用），
    // 不新造一条 IPC —— 同一件事一种写法（工程规矩）。
    const lpc = fdQ(box, '.fd-localpath');
    if (lpc) {
      lpc.innerHTML = '';
      const lp = node.localPath || (node.data && node.data.localPath) || '';
      if (lp) {
        const a = document.createElement('span');
        a.className = 'fd-localpath-link';
        a.textContent = '📁 ' + lp;
        a.title = '点击用文件管理器打开这个文件夹';
        a.addEventListener('click', (e) => { e.stopPropagation(); MM.openLocalPath(lp); });
        lpc.appendChild(a);
      }
    }
    // 图片区
    // 这里**只放图片**：节点声明的 links 不再在此重复展示。
    // 原先此区还渲染一行「🔗 跳转到 <项目> / <id>」，但它对本项目内链接是**死链接**
    // ——点击一律走 switchProject()，而后者开头就 `name === state.project.name → return`，
    // 于是同项目链接点了毫无反应（实测 comnet 的 47 条链接全属本项目内 → 47 个死链接）。
    // 关系展示已由下方「相关知识点」完整承担，且它做得更对：区分同项目/跨项目、
    // 带方向箭头与 caption、显示解析后的标题而非裸 id。故删除本区的链接行，避免
    // 同一框内同一条关系出现两次（其中一次还是坏的）。
    const ic = fdQ(box, '.fd-images-content');
    const imgs = nodeImages(node);
    if (!imgs.length) {
      ic.innerHTML = '<span class="placeholder">该节点暂无图片</span>';
    } else {
      let html = '';
      imgs.forEach((img, i) => {
        // 相对路径基于 renderer/ 目录解析（index.html 所在目录）
        const full = state.project ? ('../projects/' + state.project.name + '/' + img.file) : img.file;
        html += '<div class="img-block">'
          + '<img data-full="' + escHtml(full) + '" data-file="' + escHtml(img.file) + '" src="' + escHtml(full) + '" alt="' + escHtml(img.caption || '') + '">'
          + (img.caption ? '<div class="img-caption">' + escHtml(img.caption) + '</div>' : '')
          + (img.source ? '<div class="img-src">来源：' + escHtml(img.source) + '</div>' : '')
          + '<button class="img-remove" data-i="' + i + '">移除该图</button>'
          + '</div>';
      });
      html += '<div class="fd-hint">双击图片可放大预览（预览中滚轮缩放）</div>';
      ic.innerHTML = html;
    }
    // 移除图片
    ic.querySelectorAll('.img-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.i);
        const imgs2 = nodeImages(node).slice();
        imgs2.splice(idx, 1);
        const d = node.data || (node.data = {});
        d.images = imgs2;
        setStatus('图片已移除，点击保存生效');
        renderFdBox(box, node); positionFdBox(box); // 刷新本框
      });
    });
    // 双击图片 → 灯箱放大预览；悬停 → 鼠标旁显示"双击浏览"
    ic.querySelectorAll('img[data-full]').forEach((img) => {
      img.addEventListener('dblclick', () => openLightbox(img.getAttribute('data-full')));
      img.addEventListener('mouseenter', showFdImgTip);
      img.addEventListener('mousemove', moveFdImgTip);
      img.addEventListener('mouseleave', hideFdImgTip);
    });
    // 相关知识点（我引用谁 + 谁引用我）——异步经主进程 CLI（跨项目反查后双向合并）
    // 圆钮：**每次详情渲染都刷新** ✓（用户要求「固定每次和节点详情一起刷新」）
    // 与关联数据无关 ⇒ 没有关联笔记 / 没有链接的节点也一定有一颗 ✓
    if (MM.refreshRelShowBtn) MM.refreshRelShowBtn(box.el, node);
    const rl = fdQ(box, '.fd-related');
    rl.innerHTML = '<div class="bl-title">相关知识点（加载中…）</div>';
    const projectName = state.project && state.project.name;
    // 关联笔记入口（二级页面）—— **这是进入关联页面的唯一入口**。
    // 单独一个容器，不与「相关知识点」的异步渲染互相覆盖（两者都是异步 IPC）。
    // 注意：必须放在 `const projectName` **之后** —— 放前面会因 TDZ 直接抛
    // ReferenceError（Cannot access 'projectName' before initialization），
    // 导致每次渲染详情框都失败（实测把所有详情框断言一起打红）。
    const al = fdQ(box, '.fd-assoc');
    al.innerHTML = '';
    if (projectName && window.desktop.app.assoc) {
      window.desktop.app.assoc(projectName, node.id).then((r) => {
        if (box.node !== node || !box.el.parentElement) return;   // 防串台
        // 顺带把磁盘上的 assoc 同步进内存：磁盘是 AI/CLI 写的**真值**，
        // 而界面保存会把内存里的 assoc 写回去 —— 不同步就会用旧内存覆盖掉新笔记。
        syncAssocToState(r);
        renderAssocEntries(al, r, node);
        setTimeout(() => positionFdBox(box), 20);
      }).catch(() => {
        if (box.node === node) al.innerHTML = '';
      });
    }
    if (projectName && window.desktop.app.related) {
      window.desktop.app.related(projectName, node.id).then((r) => {
        if (box.node !== node || !box.el.parentElement) return; // 防串台：本框已换节点/已关闭
        renderRelated(rl, r);
        setTimeout(() => positionFdBox(box), 20);
      }).catch(() => {
        if (box.node === node) rl.innerHTML = '<div class="bl-title">相关知识点</div><div class="bl-item">（查询失败）</div>';
      });
    } else {
      rl.innerHTML = '';
    }
    // 附件（文件）区：点击卡片预览，md/pdf 内预览，其他系统打开
    const fc = fdQ(box, '.fd-files-content');
    const files = nodeFiles(node);
    if (!files.length) {
      fc.innerHTML = '';
    } else {
      let html = '<div class="files-title">附件（点击预览 · 移除需保存后生效）</div>';
      files.forEach((f, i) => {
        const name = String(f.file).split('/').pop();
        const ext = name.split('.').pop().toLowerCase();
        const kind = (ext === 'md' || ext === 'markdown') ? 'md' : (ext === 'pdf' ? 'pdf' : 'oth');
        html += '<div class="file-card" data-file="' + escHtml(f.file) + '" data-caption="' + escHtml(f.caption || '') + '" title="点击预览：' + escHtml(f.caption || '') + '">'
          + '<span class="fc-icon k-' + kind + '">' + (kind === 'md' ? 'MD' : kind === 'pdf' ? 'PDF' : 'FILE') + '</span>'
          + '<span class="fc-body">'
          + '<span class="fc-caption">' + escHtml(f.caption || '') + '</span>'
          + '<span class="fc-name">' + escHtml(name) + '</span>'
          + '</span>'
          + '<span class="fc-open">预览 ↗</span>'
          + '<button class="img-remove" data-file-i="' + i + '">移除</button>'
          + '</div>';
      });
      fc.innerHTML = html;
      fc.querySelectorAll('.file-card').forEach((card) => {
        card.addEventListener('click', (ev) => {
          if (ev.target.classList && ev.target.classList.contains('img-remove')) return;
          openFilePreview(node, card.dataset.file);
        });
      });
      fc.querySelectorAll('.img-remove[data-file-i]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const idx = Number(btn.dataset.fileI);
          const files2 = nodeFiles(node).slice();
          files2.splice(idx, 1);
          const d = node.data || (node.data = {});
          d.files = files2;
          setStatus('附件已移除，点击保存生效');
          renderFdBox(box, node); positionFdBox(box); // 刷新本框
        });
      });
    }

  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const fdQ = (box, sel) => MM.fdQ(box, sel);
  const escHtml = (s) => MM.escHtml(s);
  const nodeImages = (node) => MM.nodeImages(node);
  const nodeFiles = (node) => MM.nodeFiles(node);
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const showDetail = (node) => MM.showDetail(node);
  const hideFloatDetail = () => MM.hideFloatDetail();
  const positionFloatDetail = () => MM.positionFloatDetail();
  const positionFdBox = (box) => MM.positionFdBox(box);
  const runSearch = (keyword) => MM.runSearch(keyword);
  const openLightbox = (src) => MM.openLightbox(src);
  const showFdImgTip = (e) => MM.showFdImgTip(e);
  const moveFdImgTip = (e) => MM.moveFdImgTip(e);
  const hideFdImgTip = () => MM.hideFdImgTip();
  const openFilePreview = (node, rel) => MM.openFilePreview(node, rel);
  const renderRelated = (el, r) => MM.renderRelated(el, r);
  const renderAssocEntries = (el, r, node) => MM.renderAssocEntries(el, r, node);
  /** 把 CLI 返回的**原始实体**同步进内存。
   *  必要性：界面保存写回的是内存里的 assoc；而 assoc 的作者是 AI/CLI，
   *  磁盘可能已有界面没见过的新笔记 —— 不同步就会用旧内存把新笔记覆盖掉。
   *
   *  ⚠️ **实现只有一份**：`MM.syncAssocRaw`（app-assoc.js，那里写了"必须按 id 合并、
   *  不能整体替换"的实测根因 —— 整份替换过一个子集，用户一点保存就删掉了其他笔记）。
   *  这里只做"该节点有没有笔记"的前置判断，不再自己抄一遍合并逻辑。
   */
  const syncAssocToState = (r) => {
    if (!MM.syncAssocRaw) return 0;
    // 该节点没有笔记 ⇒ 不动内存（"读到了空的"与"读不到"必须可区分，别把内存清空 ✗）
    if (!r || !Array.isArray(r.raw) || !r.raw.length) return 0;
    return MM.syncAssocRaw(r.raw);
  };

  /**
   * 用系统文件管理器打开一个**本机目录**（节点字段 `localPath`）。
   *
   * 走主进程既有的 `app:open-file`（内部就是 `shell.openPath`）—— 目录同样适用，
   * 且**失败必须让人看见**：路径不存在 / 盘没挂 / 权限不足时 `shell.openPath` 会返回错误串，
   * 这里把它显示在状态栏（绝不"点了没反应"—— 那是本工程反复治过的"静默失效"）。
   */
  async function openLocalPath(p) {
    if (!p) return;
    if (!window.desktop || !window.desktop.app || !window.desktop.app.openFile) {
      setStatus('当前环境不支持打开文件夹（无主进程通道）', true);
      return;
    }
    try {
      const r = await window.desktop.app.openFile(p);
      if (!r || r.ok === false) {
        setStatus('打不开这个文件夹：' + ((r && r.err) || '未知原因') + '｜' + p, true);
      } else {
        setStatus('已打开文件夹：' + p);
      }
    } catch (e) {
      setStatus('打不开这个文件夹：' + ((e && e.message) || e) + '｜' + p, true);
    }
  }

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.bindContainerControls = bindContainerControls;
  MM.observeNodeLayer = observeNodeLayer;
  MM.renderFdBox = renderFdBox;
  MM.openLocalPath = openLocalPath;
})();
