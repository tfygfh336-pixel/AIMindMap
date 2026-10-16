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

  /* ================= 单击 / 双击判别（R1 双击防误触） =================
   * **用户 2026-10-13 亲报**：双击节点展开/折叠**照样发生**，但**单击的两个副作用也照跑** ——
   *   ① 被记一次「访问」（热度）✗ ② 详情框被打开、遮挡视野 ✗。
   *
   * **根因**（读代码定位，不猜）：浏览器里「真双击」就是三条事件
   *   `click(detail=1) → click(detail=2) → dblclick`；而本文件这条容器 click 处理器**一拍都不等**
   *   就跑了 `showDetail` —— 它同时是「记访问」的**唯一采样点**（`app-detail.js` 的
   *   `recordHumanOpen`：人打开详情框 = 人类唯一的访问动作）⇒ 双击必然先把单击副作用跑一遍。
   *   实测（`scripts/smoke/03` 的真输入探针，修前）：一次真双击 ⇒ `showDetail` 调 **2** 次、
   *   访问日志 **+4** 行（每次打开详情还带一条 `ai-related-hop`：相关知识点那次 AI 读）、
   *   详情框被打开 ✓。
   *
   * **为什么只能「推迟判别」、不能「事后撤销」**：访问日志是**只追加**的
   *   （`src/heat-sensor.js` 的 `appendEvent`：只有追加、没有删除口）⇒ 写进去就撤不回来
   *   ⇒ 判别必须发生在**写入之前** ⇒ 单击的这两个副作用必须等过双击窗口。
   *   **选中**不在此列：它是无副作用的即时反馈（点下去就该看见），仍然**立刻**做 ✓
   *   —— 双击时也照样选中，与从前一致 ✓。
   *
   * **口径**（四条，缺一不可）：
   *   · 窗口内**同一节点**又挨了一击（或收到 `dblclick`）⇒ 把这一对的单击副作用**整个撤掉**
   *     （不记访问、不弹详情 ✓；双击本身的展开/折叠在 `contextmenu.js`，不受影响 ✓）；
   *   · 窗口内**换了别的节点** ⇒ 上一击确属单击 ⇒ **立刻补跑**（单击语义一条都不丢 ✓）；
   *   · **点空白** ⇒ 先补跑再隐藏（净效果与从前逐字节相同：记一次访问 + 框关上 ✓）；
   *   · **合成事件**（`el.click()` / `dispatchEvent(new MouseEvent('click'))`，`detail === 0`）
   *     **不进判别**：它没有「点击计数」这回事、也不存在「前面还有一击」的语义 ⇒ 立即执行，
   *     与从前逐字节相同 ✓（冒烟域 01 的 `click node → float detail shows` 走的就是这条路径）。
   *
   * **窗口取 300ms**：真双击要等过它才能确认「是单击」，等得越久单击越钝。本机真双击的两击
   *   间隔实测 ~90ms（域 03 的真输入探针：`dblclick` 与首个 `click` 之间）⇒ 300ms 有 3 倍余量；
   *   残余（两击间隔 > 300ms 的「慢双击」）如实记在 CHANGELOG 的「未做/未核实」里 ✗
   *   —— 那一档里第一击的副作用已经发生，但**第二击与 dblclick 仍被抑制**，展开/折叠照旧 ✓
   *   （比修前「两击都照跑」已经好了，只是没到零）。 */
  const DBL_WINDOW_MS = 300;
  let pendingClick = null;      // { nodeId, timer }：窗口里正等着的那一击
  let lastSuppressed = null;    // 读数：最近一次被撤掉的那一击（冒烟断言读它）

  /** 跑掉那一击的单击副作用。**只经 `MM.showDetail`** —— 它是「打开详情框」的唯一入口，
   *  记访问就挂在它里面（`app-detail.js` 的 `recordHumanOpen`）⇒ 一处调用、两条副作用一起受控 ✓。 */
  function runSingleClick(nodeId) {
    const jm = state.jm;
    if (!jm || !MM.adapter || typeof MM.showDetail !== 'function') return false;
    const n = MM.adapter.getNode(jm, nodeId);
    if (!n) return false;      // 节点已经不在了（切了项目 / 被删）⇒ 不弹，也不假装成功 ✓
    MM.showDetail(n);
    return true;
  }

  function takePending() {
    const p = pendingClick;
    pendingClick = null;
    if (p && p.timer) clearTimeout(p.timer);
    return p;
  }
  /** 上一击确属单击 ⇒ 立刻补跑（换节点 / 点空白时用） */
  function flushPendingClick() {
    const p = takePending();
    if (p) runSingleClick(p.nodeId);
    return !!p;
  }
  /** 这一击属于双击 ⇒ 把这一对的单击副作用整个撤掉 */
  function cancelPendingClick(why) {
    const p = takePending();
    if (p) lastSuppressed = { nodeId: p.nodeId, why: why, at: Date.now() };
    return p;
  }

  /** 一次节点点击进判别（`detail` = 浏览器给的点击计数：真点击 1、2…；合成事件 0） */
  function noteNodeClick(node, detail) {
    const id = node.id;
    if (pendingClick && pendingClick.nodeId === id) {
      // 同一节点在窗口内又挨了一击 ⇒ 这是一次双击：这一对的副作用**整个**撤掉，
      // 第 2 击也不排新的（双击语义由 contextmenu.js 的 dblclick 处理 ✓）
      cancelPendingClick(detail >= 2 ? 'second-click' : 'same-node-again');
      return;
    }
    if (pendingClick) flushPendingClick();     // 换了节点 ⇒ 上一击确属单击，立刻补跑（不丢 ✓）
    if (!(detail >= 1)) { runSingleClick(id); return; }   // 合成事件：立即执行，与从前逐字节相同 ✓
    pendingClick = {
      nodeId: id,
      timer: setTimeout(() => { const p = takePending(); if (p) runSingleClick(p.nodeId); }, DBL_WINDOW_MS)
    };
  }

  /** 读数（冒烟断言用）：判别窗口 / 正等着的那一击 / 最近一次被撤掉的那一击 */
  function clickJudgeState() {
    return {
      windowMs: DBL_WINDOW_MS,
      pending: pendingClick ? pendingClick.nodeId : null,
      suppressed: lastSuppressed
    };
  }

  /** 事件目标属于哪个节点：**复用 `contextmenu.js` 的那一份判定**
   *  （`MMContextMenu.getBindedNodeId`，规则与它「右键命中的是哪个节点」同源）
   *  —— 本文件不再抄第二份「沿父链找 jmnode」的比较逻辑（两处表达必然漂移 ✗）。
   *  拿不到它（contextmenu.js 没加载 / 导出名改了）**不静默**：说出来（判别无法收口 ✓）。 */
  function nodeIdOfEventTarget(target) {
    const api = window.MMContextMenu;
    if (!api || typeof api.getBindedNodeId !== 'function') {
      if (MM.setStatus) {
        MM.setStatus('双击判别：拿不到 MMContextMenu.getBindedNodeId（见 contextmenu.js），本次没能抑制单击副作用', true);
      }
      return null;
    }
    return api.getBindedNodeId(target);
  }

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
        // 卫星浮层（圆钮 / 悬浮工具条）也是**详情框的 UI** ⇒ 点它不算"点空白"。
        // ⚠️ 圆钮原先就在 `.float-detail` 里，上面那条顺手挡住了；搬进浮层后不补这一条，
        //    点一下圆钮就会把未锁定的详情框关掉 ✗（scripts/smoke/37 的断言⑦守着）
        // ⚠️ 判定**只经 MM.fdIsSatelliteTarget**（不在调用点另写一遍 id/closest 比较）：
        //    两处表达会两处漂移，而且"注入一处就该失效"的判别力也拿不到（B4 的注入要真的能红 ✓）
        if (MM.fdIsSatelliteTarget && MM.fdIsSatelliteTarget(el)) return;
      }
      if (MM.fdIsSatelliteTarget && MM.fdIsSatelliteTarget(e.target)) return;
      if (e.target.closest && e.target.closest('.float-detail')) return; // 兜底（老环境无 composedPath）
      let el = e.target;
      while (el && el !== container) {
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'jmnode') {
          const id = el.getAttribute('nodeid');
          if (id) {
            MM.adapter.selectNode(jm, id);      // 选中：**立刻**（无副作用；双击时也照样选中 ✓）
            const n = MM.adapter.getNode(jm, id);
            // 详情 + 记访问：过单击/双击判别（双击的那一击会被撤掉，见 noteNodeClick ✓）
            if (n) noteNodeClick(n, e.detail);
          }
          return;
        }
        if (tag === 'jmnodes') break;
        el = el.parentElement;
      }
      flushPendingClick(); // 点空白：先把上一击补跑（净效果与从前相同）再收起
      hideFloatDetail(); // 点击空白 → 隐藏浮动详情
    });

    /* 双击 = 把这一对的单击副作用**撤掉**（判别窗口内的那一击还没跑 ⇒ 撤得掉 ✓）。
     * 本监听器与 `contextmenu.js` 的 `onDblClick`（双击 = 展开/收起）在**同一次事件派发**里
     * 同步执行：谁先谁后都不影响结论 —— 撤销发生在任何 `setTimeout` 回调之前 ✓。 */
    container.addEventListener('dblclick', (e) => {
      const id = nodeIdOfEventTarget(e.target);
      if (id && pendingClick && pendingClick.nodeId === id) cancelPendingClick('dblclick');
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
    /* ⚠️⚠️ **`detail` 的契约是「HTML 优先」——这一行就是它的唯一落点**（`R7-0` 起钉死）：
     *   · 契约：`detail` 是**HTML 片段**（不是 Markdown）——`docs/DATA-FORMAT.md` §2.4；
     *     先例读数：真实项目 `comnet` 的 **133 个含 detail 节点 100% 是 HTML**（同节）。
     *   · 所以正文走**裸 `innerHTML` 注入**：浏览器自己的解析器负责结构，**不做任何转换** ✓。
     *   · ✗✗ **不许**把这行改成"一律走会**转义裸 HTML** 的 `markdownToHtml`"
     *     （`src/convert.js` 文件头：它先整体转义再套行内语法）——那会把既有 HTML 节点
     *     全部显示成一堆**字面标签**（= 静默砸掉用户既有内容，本工程最重的损害类）。
     *     Markdown 是 R7 主体的**另一条**路径（按 `detailMode`/渲染期探测**显式选**），
     *     两条路径**互斥**、不在这里混（`docs/DATA-FORMAT.md` §2.4 的警告）。
     *   · 机械守卫有两处（都在本批）：结构断言 `tests/`（本模块**零** `markdownToHtml`/`mdBlock`/
     *     `mdInline` 调用）+ 冒烟真帧判据 `scripts/smoke/47-*.js`（HTML 夹具的标签**不当文字画出来**）。 */
    dc.innerHTML = detail || '<span class="placeholder">（该节点无详情）</span>';
    // 条目层（v3）：条目化节点额外给出「逐条」呈现（清单 + 正文归属）。
    // ⚠️ 正文的渲染路径**就在这里结束**：上面那一行 `dc.innerHTML = detail` 仍是**唯一**的正文来源
    //   （detail 是 renderDetail(items) 的落盘派生缓存，契约 §2）—— 本调用只加"条目级"的
    //   清单与属性标注，**不拼第二份 HTML**（见下方 renderFdItems 段落）。
    //   未条目化节点 ⇒ 这里只做"清掉上一位节点留下的清单"，**一个字节都不加**（回归判据）。
    renderFdItems(box, node);
    // 热度条（第三件·A）：**展示**两条热度（人 / AI），数据来自主进程 `app:heat`（= CLI `heat --json`）。
    // ⚠️ 它写在**另一个容器**（`.fd-heat`）里，与上面那行 `dc.innerHTML = detail` **无关** ——
    //   "正文只有一份"这条铁律不受影响（正文的字节一个都没变）；它**异步**刷新，不拖慢打开。
    // ⚠️ 它**不改内存、不触发保存**（改热度条不写盘 ⇒ 用户只是想看热度，不该留下任何写）。
    if (MM.heatBarsRefresh) MM.heatBarsRefresh(box, node);
    // 标签 chips（点击 → 按标签全文搜索）
    const tc = fdQ(box, '.fd-tags');    const tags = (node.tags || (node.data && node.data.tags)) || [];
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
        // 相对路径基于 renderer/ 目录解析（index.html 所在目录）—— 但**串不在这里拼**：
        // 判据与页面相对地址都由 `MM.imageLinkOf` 给（唯一实现在 `src/path-chain.js`）。
        const link = MM.imageLinkOf(state.project, img.file);
        if (!link.ok) {
          // 判据 3「打不开必须显式报错」：改前这里是一颗**静默的裂图**（`<img src>` 指向项目外/不存在）。
          // ⚠️ 「移除该图」按钮**照旧留着** —— 坏引用恰恰是最需要能被移除的那种。
          html += '<div class="img-block"><span class="placeholder">图片引用不可用：'
            + escHtml(link.reason) + '｜' + escHtml(img.file) + '</span>'
            + '<button class="img-remove" data-i="' + i + '">移除该图</button></div>';
        } else {
          const full = link.url;
          html += '<div class="img-block">'
            + '<img data-full="' + escHtml(full) + '" data-file="' + escHtml(img.file) + '" src="' + escHtml(full) + '" alt="' + escHtml(img.caption || '') + '">'
            + (img.caption ? '<div class="img-caption">' + escHtml(img.caption) + '</div>' : '')
            + (img.source ? '<div class="img-src">来源：' + escHtml(img.source) + '</div>' : '')
            + '<button class="img-remove" data-i="' + i + '">移除该图</button>'
            + '</div>';
        }
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

  /* ============================================================
   * 条目层（v3）：详情框里的「逐条」呈现（唯一实现）
   * ------------------------------------------------------------
   * 前提（契约 `docs/ITEM-MODEL.md` §2 与 §12 里点名给界面流的那一句）：
   *   **`detail` 仍是渲染产物**（由 `renderDetail(items)` 派生）⇒ 详情框的渲染路径**不改**：
   *   正文永远是 `dc.innerHTML = detail` 那一份字节。本段**绝不**用 items 拼第二份 HTML
   *   （同一事实两处表达 ⇒ 必漂移），只做两件事：
   *     ① 「条目清单」：一条一行（序号 / 类型 / 正文摘要 / id + 出处、标签、核验 + 复制键）——
   *        于是"这是一条一条的条目"在框里看得见（条数与逐条分隔都在这里）；
   *     ② 正文里的**条目归属**：只加属性（`data-item-id` / `data-item-no` / `class`），
   *        **不插任何元素、不改一个字**；条目的分隔线与序号由 CSS 画（`::before` 的生成内容
   *        不进 innerHTML）⇒ 正文与 `detail` 仍**逐字节同源**。
   *
   * ⚠️ 判据纪律（本段最要紧的一条）：**归属对不上就不贴**（fail-open）。
   *   对法：把 `item.html` 用浏览器自己解析一遍（detached `<div>` 的片段解析），再与正文里
   *   同序的元素做 `isEqualNode` 比较 —— 两侧过**同一个解析器**，故不受引号/大小写/实体归一等
   *   序列化差异影响。对不上（qa 条目、纯文本条目、detail 与 items 不一致…）⇒ **只出清单**，
   *   正文一字不动，并把 `aligned:false` + 原因写进读数（**不许猜、不许凑**）。
   *   正常数据都能对上（契约保证 `detail === renderDetail(items)`）；对不上本身就说明有东西不对。
   * ============================================================ */

  /** 正文摘要的长度上限（只影响清单里那一行字，不影响任何数据） */
  const FD_ITEM_SNIPPET = 60;

  /** 这个节点是不是**条目化**节点：`items` 在场且是数组（**含空数组** ⇒ 已条目化，契约 §2）。
   *  不是 ⇒ 返回 null —— 调用方据此**一个字节都不加**（未条目化节点的观感是回归判据）。 */
  function fdItemsOf(node) {
    const raw = (node && node.items !== undefined) ? node.items
      : ((node && node.data) ? node.data.items : undefined);
    return Array.isArray(raw) ? raw : null;
  }

  /** 清单容器（**唯一创建点**，插在正文之前）；已存在就复用（重绘不累积） */
  function fdItemsPanel(box) {
    const dc = fdQ(box, '.fd-detail-content');
    if (!dc || !dc.parentElement) return null;
    let el = fdQ(box, '.fd-items');
    if (!el) {
      el = document.createElement('div');
      el.className = 'fd-items';
      dc.parentElement.insertBefore(el, dc);
    }
    return el;
  }

  /** 清掉清单。**未条目化节点必须走这里**：详情框是**复用**的（一个跟随框先后显示多个节点），
   *  不清就会把上一位节点的条目挂在新节点上（那是"张冠李戴"，比不显示更糟）。 */
  function fdItemsClear(box) {
    if (!box || !box.el) return false;
    const el = fdQ(box, '.fd-items');
    if (el && el.parentElement) el.parentElement.removeChild(el);
    box.fdItems = null;
    return !!el;
  }

  /** 把一段 HTML 片段解析成**一个**元素（片段解析：上下文不可逃逸；**不挂进文档**）。
   *  返回 null = 这段不是一个单独元素（纯文本 / 多块 / 表格片段被解析器移出…）⇒ 放弃归属。
   *  ⚠️ 它**不是**"渲染正文"：产物只用于与正文 DOM 比对、取纯文本摘要，从不写回框里。 */
  function fdParseOne(html) {
    const s = String(html == null ? '' : html);
    if (!s.trim()) return null;
    const host = document.createElement('div');
    host.innerHTML = s;
    const els = Array.prototype.slice.call(host.children);
    return (els.length === 1) ? els[0] : null;
  }

  /** 一段 HTML 的纯文本（只用于清单里的摘要） */
  function fdTextOf(html) {
    const s = String(html == null ? '' : html);
    if (!s.trim()) return '';
    const host = document.createElement('div');
    host.innerHTML = s;
    return String(host.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 条目级 `src` → 字符串数组（契约：字符串或字符串数组；空 ⇒ 不显示） */
  function fdSrcList(it) {
    const s = it && it.src;
    if (typeof s === 'string' && s.trim()) return [s.trim()];
    if (Array.isArray(s)) return s.filter((x) => typeof x === 'string' && x.trim());
    return [];
  }

  /** 清单里那一行摘要：qa 条目用 `q`/`a`，其余用 `html` 的纯文本 */
  function fdItemSnippet(it) {
    if (!it) return '';
    if (it.type === 'qa' && it.qa && typeof it.qa === 'object') {
      const q = String(it.qa.q == null ? '' : it.qa.q).replace(/\s+/g, ' ').trim();
      const a = String(it.qa.a == null ? '' : it.qa.a).replace(/\s+/g, ' ').trim();
      return (q || a).slice(0, FD_ITEM_SNIPPET);
    }
    return fdTextOf(it.html).slice(0, FD_ITEM_SNIPPET);
  }

  /**
   * 把正文 DOM 里的元素按顺序认领给条目（**只比对，不渲染**）。
   * 规则：正文里的块按文档序与条目一一对应；`<ul>`/`<ol>` 外壳里的每个 `<li>` 各属一条
   * （条目可以共享一个外壳，见 `renderDetail` 的容器机制）。
   * @returns {{ok:boolean, owners:Array<Element|null>|null, reason:string}}
   */
  function fdAlignItems(dc, items) {
    const frags = items.map((it) => ((it && it.type === 'qa') ? null : fdParseOne(it && it.html)));
    const owners = new Array(items.length).fill(null);
    let i = 0;
    let fail = '';
    const kidsOf = (parent) => Array.prototype.slice.call(parent.children);
    const matchLevel = (parent) => {
      const kids = kidsOf(parent);
      for (let k = 0; k < kids.length; k++) {
        const el = kids[k];
        const tag = String(el.tagName || '').toLowerCase();
        if (i >= frags.length) { fail = '正文里多出没被认领的块 <' + tag + '>'; return false; }
        const f = frags[i];
        if (!f) {
          fail = '第 ' + (i + 1) + ' 条没有可比的 html（type='
            + ((items[i] && items[i].type) || '?') + '）';
          return false;
        }
        if (el.isEqualNode(f)) { owners[i] = el; i += 1; continue; }
        if ((tag === 'ul' || tag === 'ol') && el.children.length) {
          const lis = kidsOf(el);
          let j = 0;
          while (j < lis.length && i < frags.length && frags[i] && lis[j].isEqualNode(frags[i])) {
            owners[i] = lis[j]; i += 1; j += 1;
          }
          if (j === lis.length) continue;   // 外壳整块认领完 ⇒ 继续看同层的下一块
          fail = '外壳 <' + tag + '> 里的第 ' + (j + 1) + ' 个块与第 ' + (i + 1) + ' 条对不上';
          return false;
        }
        fail = '第 ' + (i + 1) + ' 条与正文里的 <' + tag + '> 对不上';
        return false;
      }
      return true;
    };
    const ok = matchLevel(dc) && i === frags.length;
    if (!ok && !fail) fail = '正文里的块比条目少（只认领了 ' + i + '/' + frags.length + ' 条）';
    return { ok: !!ok, owners: ok ? owners : null, reason: ok ? '' : fail };
  }

  /** 贴归属：**只加属性**（正文的元素、文字、结构一个都不动） */
  function fdDecorateItems(items, owners) {
    let n = 0;
    owners.forEach((el, idx) => {
      if (!el) return;
      el.classList.add('fd-item');
      el.setAttribute('data-item-id', String((items[idx] && items[idx].id) || ''));
      el.setAttribute('data-item-no', String(idx + 1));
      n += 1;
    });
    return n;
  }

  /** 选中一条：清单行 + 正文里那条各自高亮（两处同一状态，避免"点了没反应"） */
  function fdSelectItem(box, itemId, opts) {
    const st = box && box.fdItems;
    if (!st || !itemId) return false;
    if (!st.items.some((it) => it && it.id === itemId)) return false;
    st.selected = itemId;
    const panel = fdQ(box, '.fd-items');
    if (panel) {
      panel.querySelectorAll('.fd-item-row').forEach((row) => {
        row.classList.toggle('fd-item-active', row.getAttribute('data-item-id') === itemId);
      });
    }
    const dc = fdQ(box, '.fd-detail-content');
    if (dc) {
      dc.querySelectorAll('.fd-item-active').forEach((el) => el.classList.remove('fd-item-active'));
      const owner = dc.querySelector('[data-item-id="' + itemId + '"]');
      if (owner) {
        owner.classList.add('fd-item-active');
        if (!(opts && opts.silent) && owner.scrollIntoView) {
          try { owner.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老环境不支持对象参：忽略 */ }
        }
      }
    }
    if (!(opts && opts.silent)) setStatus('已选中条目 ' + itemId + '（' + (st.nodeId || '') + '#' + itemId + '）');
    return true;
  }

  /** 复制值：**唯一实现**（`节点id#条目id` —— 复制键、行的 data-copy、读数三处同源） */
  function fdCopyValue(box, itemId) {
    return String((box && box.fdItems && box.fdItems.nodeId) || '') + '#' + String(itemId || '');
  }

  function fdCopyFallback(value, done, why) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('aria-hidden', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return done(ok, ok ? 'execCommand' : 'execCommand-refused', why);
    } catch (e) {
      return done(false, 'no-clipboard:' + ((e && e.message) || e), why);
    }
  }

  /** 复制一条的 `节点id#条目id`；失败**不静默**（状态栏说清用了哪条路、为什么没成）
   *
   * ⚠️ **通道顺序是判据的一部分，别调换**：
   *   ① `window.desktop.app.writeClipboard` → **主进程**的 `clipboard.writeText`：进程级 OS 剪贴板
   *      API，**与窗口焦点无关** ✓ —— 离屏/隐藏窗口（冒烟窗口按纪律就是这种）里也能真的写进去；
   *   ②③ 浏览器那两条（`navigator.clipboard` / `execCommand('copy')`）：**要求文档有焦点**，在无焦点的
   *      隐藏窗口里实测"要么被拒（`Document is not focused`）、要么自报成功却什么都没写进系统剪贴板"✗。
   *      ⇒ 它们只为"渲染层跑在非 Electron 宿主里"（那时 `window.desktop` 不存在）保留；
   *      **冒烟域 39 的判据要求 `how === 'desktop-clipboard'`** ⇒ 一旦退回 ②③ 那条判据必红 ✓，
   *      "焦点依赖"也就不再有资格冒充成功（曾经正是它让域 39 只能降级成行为级判据）。
   * `lastCopy` 里的 `how` / `focus` / `why` / `readback` 是**诊断**字段：成功判定仍只看 `ok`，
   * 但"为什么只能走兜底"要看得见 —— 那正是"自报成功"与"真的写进去了"之间唯一的区别。 */
  function fdCopyItem(box, itemId) {
    const value = fdCopyValue(box, itemId);
    const done = (ok, how, why, extra) => {
      if (box && box.fdItems) {
        box.fdItems.lastCopy = Object.assign({
          value: value, ok: !!ok, how: how,
          focus: (typeof document.hasFocus === 'function') ? document.hasFocus() : null,
          why: why || ''
        }, extra || {});
      }
      setStatus(ok ? ('已复制 ' + value) : ('复制失败（' + how + '）：' + value), !ok);
      return !!ok;
    };
    let deskWhy = '';
    try {
      const desk = (window.desktop && window.desktop.app && window.desktop.app.writeClipboard)
        ? window.desktop.app.writeClipboard : null;
      if (desk) {
        // ① 主进程那条（默认路径）。`matched === false` = 主进程**写后回读**发现剪贴板里不是这段文本
        //   ⇒ 不算成功（宁可退回兜底也别自报 ✓）。
        return Promise.resolve(desk(value)).then((res) => {
          const r = res || {};
          if (r.ok === true && r.matched !== false) {
            return done(true, 'desktop-clipboard', '', { readback: r.readback });
          }
          return fdCopyFallback(value, done,
            'desktop: ' + (r.error || ('写后回读不一致：' + JSON.stringify(r.readback))));
        }).catch((e) => fdCopyFallback(value, done, 'desktop 通道抛错: ' + ((e && e.message) || e)));
      }
      deskWhy = '（没有 window.desktop ⇒ 只能走**要求焦点**的浏览器通道）';
    } catch (e) {
      deskWhy = 'desktop 通道同步抛错: ' + ((e && e.message) || e);
    }
    // ②③ 浏览器那两条（要焦点；只在非 Electron 宿主上才轮到它们）
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(value)
          .then(() => done(true, 'clipboard', deskWhy))
          .catch((e) => fdCopyFallback(value, done, 'navigator.clipboard: ' + ((e && e.message) || e)));
      }
      return fdCopyFallback(value, done, 'navigator.clipboard 不存在（非安全上下文？）' + deskWhy);
    } catch (e) {
      return fdCopyFallback(value, done, 'navigator.clipboard 抛错: ' + ((e && e.message) || e));
    }
  }

  /** 造一行（**DOM API 拼**，不用 innerHTML —— 清单里全是数据，转义漏一处就是注入） */
  function fdBuildRow(box, node, it, idx, st) {
    const itemId = (it && it.id) || '';
    const row = document.createElement('div');
    row.className = 'fd-item-row';
    row.setAttribute('data-item-id', itemId);
    row.setAttribute('data-item-no', String(idx + 1));
    row.setAttribute('data-copy', node.id + '#' + itemId);
    row.title = '点这条 ⇒ 在正文里定位并高亮；右侧 ⧉ 复制「节点id#条目id」';
    const add = (cls, text, title) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      if (title) s.title = title;
      row.appendChild(s);
      return s;
    };
    add('fd-item-no', String(idx + 1));
    add('fd-item-type', String((it && it.type) || '?'));
    add('fd-item-snippet', fdItemSnippet(it) || '（正文为空）');
    // 条目级标签 / 出处 / 核验：**有才显示**（没有就不显示，不造噪音字段）
    if (it && Array.isArray(it.tags) && it.tags.length) {
      const tags = it.tags.filter((t) => typeof t === 'string' && t.trim());
      if (tags.length) { add('fd-item-tags', tags.map((t) => '#' + t).join(' '), '条目级标签'); st.counts.tags += 1; }
    }
    const srcs = fdSrcList(it);
    if (srcs.length) { add('fd-item-src', '📄 ' + srcs.join(' · '), '出处：' + srcs.join(' · ')); st.counts.src += 1; }
    const v = it && it.verified;
    if (v && typeof v === 'object') {
      const how = String(v.how == null ? '' : v.how);
      const by = String(v.by == null ? '' : v.by);
      const at = String(v.at == null ? '' : v.at);
      add('fd-item-verified', '✔ 已核', '核验：' + how + (by ? '｜' + by : '') + (at ? '｜' + at : ''));
      st.counts.verified += 1;
    }
    const copy = document.createElement('button');
    copy.className = 'fd-item-copy';
    copy.type = 'button';
    copy.setAttribute('data-copy', node.id + '#' + itemId);
    copy.textContent = '⧉';
    copy.title = '复制 ' + node.id + '#' + itemId;
    copy.addEventListener('click', (e) => { e.stopPropagation(); fdCopyItem(box, itemId); });
    row.appendChild(copy);
    row.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.fd-item-copy')) return;  // 复制键自己处理
      fdSelectItem(box, itemId);
    });
    return row;
  }

  /** 清单（表头 + 每条一行） */
  function fdBuildPanel(box, node, items, st) {
    const panel = fdItemsPanel(box);
    if (!panel) return 0;
    panel.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'fd-items-head';
    const count = document.createElement('span');
    count.className = 'fd-items-count';
    count.textContent = '条目 ' + items.length + ' 条';
    head.appendChild(count);
    const hint = document.createElement('span');
    hint.className = 'fd-items-hint';
    hint.textContent = st.aligned
      ? '（下面正文里每条各自成段）'
      : '（正文与条目暂对不上，只列清单：' + st.reason + '）';
    head.appendChild(hint);
    panel.appendChild(head);
    items.forEach((it, idx) => panel.appendChild(fdBuildRow(box, node, it, idx, st)));
    return items.length;
  }

  /** 正文里的**点击选中**（挂在 `.fd-detail-content` 上，**只绑一次**：框是复用的） */
  function fdBindContentClick(box) {
    if (box.fdItemsClickBound) return false;
    const dc = fdQ(box, '.fd-detail-content');
    if (!dc) return false;
    box.fdItemsClickBound = true;
    dc.addEventListener('click', (e) => {
      const el = (e.target && e.target.closest) ? e.target.closest('[data-item-id]') : null;
      if (!el) return;
      fdSelectItem(box, el.getAttribute('data-item-id'));
    });
    return true;
  }

  /**
   * 详情框渲染的**条目层入口**（由 `renderFdBox` 调用，紧跟 `dc.innerHTML = detail` 之后）。
   * 未条目化节点 ⇒ 只清掉上一位节点留下的清单，**别的一个字节都不加**（回归判据）。
   * @param {object} box 详情框（`{el, node, …}`）
   * @param {object} node 节点（`items` 在 `node.items` 或 `node.data.items`）
   * @returns {object|null} 读数（条目化时）
   */
  function renderFdItems(box, node) {
    const items = fdItemsOf(node);
    const dc = fdQ(box, '.fd-detail-content');
    if (!items || !dc) { fdItemsClear(box); return null; }
    const prev = box.fdItems;
    const same = !!(prev && prev.nodeId === node.id);
    const st = {
      nodeId: node.id,
      items: items,
      aligned: false,
      reason: '尚未比对正文',
      selected: same ? (prev.selected || null) : null,
      lastCopy: same ? (prev.lastCopy || null) : null,
      counts: { tags: 0, src: 0, verified: 0 }
    };
    box.fdItems = st;
    // ① 正文归属（fail-open：对不上就一个字都不贴）
    const al = fdAlignItems(dc, items);
    st.aligned = al.ok;
    st.reason = al.reason;
    if (al.ok) fdDecorateItems(items, al.owners);
    // ② 清单
    st.rows = fdBuildPanel(box, node, items, st);
    // ③ 点击选中（正文 + 清单行两处同一状态）；重绘保留原来的选中（那一条还在才留）
    fdBindContentClick(box);
    if (st.selected && items.some((it) => it && it.id === st.selected)) {
      fdSelectItem(box, st.selected, { silent: true });
    } else {
      st.selected = null;
    }
    return fdItemsState(box);
  }

  /**
   * 读数（冒烟断言与排查用；**不是**判据本身）：条目数 / 清单行数 / 正文归属数 / 是否对齐 / 选中 / 上次复制。
   */
  function fdItemsState(box) {
    const st = box && box.fdItems;
    if (!st) return { itemized: false };
    const dc = fdQ(box, '.fd-detail-content');
    const panel = fdQ(box, '.fd-items');
    const attrs = (root, sel, name) => (root
      ? Array.prototype.map.call(root.querySelectorAll(sel), (el) => el.getAttribute(name)) : []);
    return {
      itemized: true,
      nodeId: st.nodeId,
      count: st.items.length,
      ids: st.items.map((it) => (it && it.id) || null),
      rows: panel ? panel.querySelectorAll('.fd-item-row').length : 0,
      rowIds: attrs(panel, '.fd-item-row', 'data-item-id'),
      aligned: !!st.aligned,
      reason: st.aligned ? '' : (st.reason || ''),
      decorated: dc ? dc.querySelectorAll('[data-item-id]').length : 0,
      contentIds: attrs(dc, '[data-item-id]', 'data-item-id'),
      marks: { tags: st.counts.tags, src: st.counts.src, verified: st.counts.verified },
      selected: st.selected || null,
      copyValue: st.selected ? fdCopyValue(box, st.selected) : null,
      lastCopy: st.lastCopy || null
    };
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
   * ⭐ 判据只有一处：`src/path-chain.js`（`kind:'localPath'` 是**单独一档** —— 它本来就是
   * 工作区外的绝对路径，`docs/DATA-FORMAT.md` §2.1 规定**只校验形状**（非空 / 无换行 / ≤500 字符）、
   * **不校验存在性** ⇒ **不许**拿"必须在项目内"去卡它，否则今天能打开的 `localPath` 会全部打不开）。
   * 本函数是**三处的共同入口**：详情框的 📁 链接（`renderFdBox`）、预览头的「📁 文件夹」
   * （`renderer/app-media.js`）、右键菜单（`renderer/contextmenu.js`）⇒ 判据接在这里，三处一次覆盖。
   * 模块存在性的守卫在 `app-media.js` 的加载期（渲染层唯一一处）；这里只调它，不再写第二份判据。
   *
   * 走主进程既有的 `app:open-file`（内部就是 `shell.openPath`）—— 目录同样适用，
   * 且**失败必须让人看见**：路径不存在 / 盘没挂 / 权限不足时 `shell.openPath` 会返回错误串，
   * 这里把它显示在状态栏（绝不"点了没反应"—— 那是本工程反复治过的"静默失效"）。
   */
  async function openLocalPath(p) {
    if (!p) return;
    if (!window.MMPathChain || typeof window.MMPathChain.decide !== 'function') {
      setStatus('路径判据模块没加载：src/path-chain.js', true);
      return;
    }
    const d = window.MMPathChain.decide({ kind: 'localPath', raw: p, project: state.project });
    if (!d.ok) {
      setStatus('打不开这个文件夹：' + d.reason + '｜' + p, true);
      return;
    }
    if (!window.desktop || !window.desktop.app || !window.desktop.app.openFile) {
      setStatus('当前环境不支持打开文件夹（无主进程通道）', true);
      return;
    }
    try {
      const r = await window.desktop.app.openFile(d.abs);
      if (!r || r.ok === false) {
        setStatus('打不开这个文件夹：' + ((r && r.err) || '未知原因') + '｜' + d.abs, true);
      } else {
        setStatus('已打开文件夹：' + d.abs);
      }
    } catch (e) {
      setStatus('打不开这个文件夹：' + ((e && e.message) || e) + '｜' + d.abs, true);
    }
  }

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.bindContainerControls = bindContainerControls;
  MM.clickJudgeState = clickJudgeState;      // 单击/双击判别读数（冒烟域 03 的判据读它）
  MM.observeNodeLayer = observeNodeLayer;
  MM.renderFdBox = renderFdBox;
  MM.openLocalPath = openLocalPath;
  // 条目层（v3）：清单/归属/选中/复制的对外入口（冒烟断言与关联视图跳转都用这四个）
  MM.renderFdItems = renderFdItems;
  MM.fdItemsState = fdItemsState;
  MM.fdItemsClear = fdItemsClear;
  MM.fdSelectItem = fdSelectItem;
  MM.fdCopyItem = fdCopyItem;
})();
