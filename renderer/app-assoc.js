/* ============================================================
 * AI MindMap — 「关联笔记」二级页面（app-assoc.js）
 * ------------------------------------------------------------
 * 这是一个**关联（N 元实体）的页面**，不是节点详情：
 *   · 只能从节点详情的「相关知识点」区进入（它不是节点、不在树里、命令面板也搜不到）
 *   · 界面与节点详情**完全一致**（复用同一个浮动详情框组件）→ 拖动 / 四边四角改大小 /
 *     📌 小锁 / 🖥 大锁 / 多框并存 / 随导图缩放，全部与节点详情相同
 *   · 内容 = 作者专门写的「这些节点之间是什么关系」的笔记
 *
 * 版式复用详情框模板的既有区块，语义映射如下：
 *   .fd-title            「关联笔记：<标题>」
 *   .fd-tags             成员数徽标（N 方）
 *   .fd-detail-content   笔记正文（HTML；空则提示尚未写）
 *   .fd-images-content   固定为空（关联没有图片）
 *   .fd-assoc            固定为空（不在此页再列关联入口，避免自指）
 *   .fd-related          **成员列表**：这一页涉及哪些节点，点击即跳过去看那个节点
 *   .fd-files-content    操作区：编辑笔记
 * 边界：定位/锁定/拖动由 app-detail.js 与 app-detail-drag.js 负责；本文件只管内容。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  // 跨模块转发（**必须写显式形参**：箭头函数没有自己的 arguments）
  const fdQ = (box, sel) => MM.fdQ(box, sel);
  const escHtml = (s) => MM.escHtml(s);
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const jumpToNode = (id) => MM.jumpToNode(id);
  const positionFdBox = (box) => MM.positionFdBox(box);
  const getState = () => MM.getState();

  /** 成员的可读标签：优先已解析的 topic，回退 项目/id */
  function labelOf(m) {
    return m.topic || (m.project + '/' + m.id);
  }

  /* ================= assoc 的内存同步：**唯一一份实现** =================
   * 界面保存写回的是**内存里**的那份 assoc（`serializeTree` 的 `out.assoc`），而 assoc 的作者
   * 一直是 AI/CLI ⇒ 磁盘上随时可能有界面没见过的笔记。所以规则是：
   *   ① **必须按 id 合并**，**不能整体替换** —— 详情框调的是 `assoc-list --node <当前节点>`，
   *      返回的 raw 只是**该节点所属的子集**；早先整份替换过一次子集 ⇒ 用户随后一点保存
   *      就把其他所有关联笔记从磁盘上删掉了（实测：6 篇 → 打开一次详情后剩 2 篇）；
   *   ② 空清单**不动内存**（"读不到"与"读到了空的"不能混为一谈）。
   * 这条纪律的落点只有本函数：详情框、编辑保存、新建三处都走它。
   * @returns 合并进去的条数（0 = 没动内存）
   */
  function syncAssocRaw(list) {
    const st = getState();
    if (!st || !Array.isArray(list) || !list.length) return 0;
    if (!Array.isArray(st.assoc)) st.assoc = [];
    let n = 0;
    list.forEach((fresh) => {
      if (!fresh || !fresh.id) return;
      const i = st.assoc.findIndex((a) => a && a.id === fresh.id);
      if (i >= 0) st.assoc[i] = fresh; else st.assoc.push(fresh);
      n++;
    });
    return n;
  }
  MM.syncAssocRaw = syncAssocRaw;

  /** 在关联视图的编辑条里**新建**一篇关联笔记（成员由那个表单给，中心节点已预置）。
   *  写操作经 IPC → CLI `assoc-add`（成员数 ≥2、成员存在性、id 规范全在 CLI 侧判定）；
   *  写完**回读**并同步内存（见 syncAssocRaw），再把**视图**那一份（含成员标题与
   *  `effectiveTitle`）取回来 —— 调用方可以直接拿它开二级页面。 */
  async function assocAddFromView(project, centerId, members, title, noteMd) {
    if (!project || !window.desktop || !window.desktop.app || !window.desktop.app.assocAdd) {
      return { ok: false, text: '拿不到 assocAdd 通道（preload 没暴露？）' };
    }
    let r;
    try { r = await window.desktop.app.assocAdd(project, members, title, noteMd); }
    catch (err) { return { ok: false, text: (err && err.message) || String(err) }; }
    if (!r || !r.ok) return { ok: false, text: (r && r.text) || '未知错误' };
    const merged = syncAssocRaw(r.raw);          // 磁盘已由 CLI 写好 ⇒ 内存必须跟上
    const id = (r.created && r.created.id) || null;
    let item = null;
    if (id) {
      try {
        const res = await window.desktop.app.assoc(project, centerId);
        item = ((res && res.items) || []).find((a) => a && a.id === id) || null;
      } catch (err) { /* 取视图失败不影响"已写入磁盘"这个事实（调用方会如实报告） */ }
    }
    return { ok: true, text: String(r.text || ''), id: id, item: item, merged: merged, readBack: !!r.raw };
  }
  MM.assocAddFromView = assocAddFromView;

  /** 渲染关联页面（box.kind === 'assoc'） */
  function renderAssocPage(box, assoc, anchorNode) {
    const st = getState();
    const selfProject = (st && st.project && st.project.name) || '';
    const members = Array.isArray(assoc.members) ? assoc.members : [];
    const title = assoc.effectiveTitle || assoc.title || ('关联 ' + assoc.id);

    fdQ(box, '.fd-title').textContent = '关联笔记：' + title;

    // 成员数徽标（复用 tags 区）
    const tc = fdQ(box, '.fd-tags');
    tc.innerHTML = '<span class="tag-chip">' + members.length + ' 方关联</span>'
      + '<span class="tag-chip" title="关联 id（CLI 里用它引用）">' + escHtml(assoc.id) + '</span>';

    // 笔记正文（与节点 detail 同约定：HTML）
    const dc = fdQ(box, '.fd-detail-content');
    const note = assoc.note || '';
    dc.innerHTML = note.trim()
      ? '<div class="assoc-note">' + note + '</div>'
      : '<span class="placeholder">这篇关联笔记还没有内容。点下方「编辑笔记」写入，'
        + '或用 CLI：<code>assoc-edit ' + escHtml(selfProject) + ' ' + escHtml(assoc.id)
        + ' --note-md "…"</code></span>';

    // 关联没有图片
    fdQ(box, '.fd-images-content').innerHTML = '';

    // 不在此页再列"关联入口"（避免自指）
    fdQ(box, '.fd-assoc').innerHTML = '';

    // 成员列表（这一页涉及哪些节点）
    const rl = fdQ(box, '.fd-related');
    let html = '<div class="bl-title">关联的节点（' + members.length + '）</div>';
    members.forEach((m) => {
      const isAnchor = anchorNode && m.project === selfProject && m.id === anchorNode.id;
      const ext = m.project && m.project !== selfProject;
      html += '<div class="bl-item" data-node="' + escHtml(m.id) + '" data-project="' + escHtml(m.project) + '"'
        + ' title="' + (ext ? '在项目 ' + escHtml(m.project) + ' 中打开该节点' : '打开该节点详情') + '">'
        + '<span class="bl-dir">' + (isAnchor ? '◎' : '·') + '</span>'
        + escHtml(labelOf(m))
        + (ext ? ' <span class="bl-caption">[' + escHtml(m.project) + ']</span>' : '')
        + (isAnchor ? ' <span class="bl-caption">— 当前节点</span>' : '')
        + '</div>';
    });
    rl.innerHTML = html;
    rl.querySelectorAll('.bl-item[data-node]').forEach((item) => {
      item.addEventListener('click', () => {
        const p = item.dataset.project;
        const nid = item.dataset.node;
        if (!p || p === selfProject) {
          const jm = getState() && getState().jm;
          if (!jm) return;
          // 只展开该节点的祖先链（同 app-media.js：跳转不该摊开整棵树）
          if (MM.expandAncestors) MM.expandAncestors(jm, nid);
          const nn = MM.adapter.getNode(jm, nid);
          if (nn) { MM.adapter.selectNode(jm, nid); MM.showDetail(nn); }
          else setStatus('节点不在当前视图：' + nid);
        } else {
          MM.switchProject(p, nid);
        }
      });
    });

    // 操作区：编辑笔记（写操作走 CLI，见 app-assoc 的 saveAssocNote）
    const fc = fdQ(box, '.fd-files-content');
    fc.innerHTML = '<div class="assoc-actions">'
      + '<button class="assoc-edit-btn">编辑笔记</button>'
      + '<span class="fd-hint">写操作经 CLI（校验闸门 + 原子写）；保存后本页与磁盘一致。</span>'
      + '</div>';
    const btn = fc.querySelector('.assoc-edit-btn');
    if (btn) btn.addEventListener('click', () => openAssocEditor(assoc, box));

    positionFdBox(box);
  }

  /** 在「相关知识点」区渲染关联入口（这是进入二级页面的**唯一**入口）
   *  ＋「展示关联节点」按钮（功能 2）：**恒常渲染** —— 一个节点可能没有关联笔记但**有链接**
   *  （那种情况一样能展示关联节点），所以按钮不能挂在"有关联笔记"这个条件里 ✗
   *  （契约：`.assoc-entry` 的条数语义**不变**，冒烟断言数的是它 ✓ 按钮是另一个类名） */
  /** 圆形「关联节点」按钮：**每次详情渲染都刷新一遍** ✓（用户 2026-10-08 第二批：
   *  「出现一次就消失了」「应该固定每次和节点详情一起刷新并绑定在节点详情框左边」「没有关联节点的也要有」）。
   *  与关联数据**无关** ⇒ 不放在 assoc 查询回调里（那正是「消失」与「无关联就没有」的真因 ✗）。 */
  function refreshRelShowBtn(boxEl, node) {
    if (!boxEl) return null;
    let btn = boxEl.querySelector('.rel-show-btn');
    let created = false;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rel-show-btn rel-show-btn-round';
      created = true;
      boxEl.appendChild(btn);
    }
    btn.setAttribute('data-rel-node', node && node.id ? node.id : '');
    btn.innerHTML = '<span class="rsb-icon">🔗</span>';
    btn.title = '关联节点：在导图上高亮它的关联节点、缩放至刚好框住并画出关系虚线；再点一次或 Esc 退出';
    btn.setAttribute('aria-label', '关联节点（高亮展示）');
    btn.classList.toggle('is-on', !!(MM.isRelatedActive && MM.isRelatedActive()));
    // ⚠️ 点击处理**必须在这里绑**（跟着圆钮一起 ✓）：旧版绑在 renderAssocEntries 里，
    //    那要等 assoc IPC 回来（几百 ms ✗）⇒ 打开节点后立刻点圆钮 = 什么都没发生 ✓（探针实测 ✗）
    if (!btn.__relBound) {
      btn.__relBound = true;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id2 = btn.getAttribute('data-rel-node');
        // 再点一次 = 退出（按钮就是开关；Esc 也退 ✓）
        if (MM.isRelatedActive && MM.isRelatedActive()) {
          MM.clearRelated();
          MM.setStatus('已退出关联节点展示');
        } else if (id2) {
          MM.showRelated(id2);
        }
        const on = !!(MM.isRelatedActive && MM.isRelatedActive());
        (MM.fdPanel ? MM.fdPanel() : document).querySelectorAll('.rel-show-btn').forEach((b) => b.classList.toggle('is-on', on));
      });
    }
    // 位置**只在新建时定一次** ✓（用户 2026-10-09："应该和节点详情一起渲染、不要浮动"）
    // 之后它就是框的子元素，跟着框走 ✓；拖动中不再重判（旧版每次 style 变化都重判 ⇒ 贴边就来回跳 ✗）
    if (created && MM.placeRelShowBtn) {
      MM.placeRelShowBtn(btn, boxEl);
      if (!window.__relBtnResizeBound) {
        window.__relBtnResizeBound = true;
        window.addEventListener('resize', function () {
          var b3 = document.querySelector('.float-detail .rel-show-btn');
          var owner = b3 && b3.closest ? b3.closest('.float-detail') : null;
          if (b3 && owner && MM.placeRelShowBtn) MM.placeRelShowBtn(b3, owner);
        });
      }
    }
    // 框一动（拖动/缩放改 style）就重判贴哪边 —— 否则贴到面板边上会被 overflow:hidden 裁掉 ✗
    if (!boxEl.__relBtnObserved && window.MutationObserver) {
      boxEl.__relBtnObserved = true;
      try {
        new MutationObserver(function () {
          var b2 = boxEl.querySelector('.rel-show-btn');
          if (b2 && MM.placeRelShowBtn) MM.placeRelShowBtn(b2, boxEl);
        }).observe(boxEl, { attributes: true, attributeFilter: ['style'] });
      } catch (e0) { /* 观察器建不起来不影响主流程 ✓ */ }
    }
    return btn;
  }
  MM.refreshRelShowBtn = refreshRelShowBtn;

  function renderAssocEntries(el, res, node) {
    const items = (res && res.items) || [];
    // ⑦「展示关联节点」按钮：用户反馈"应该再明显再大一点，让它**独立出现在节点详情框的左侧**"✓
    // 位置（贴左缘外侧 / 左边没空间时镜像到右缘外侧）由 MM.placeRelShowBtn 用**实测矩形**决定 ✓：
    // 绝不放进框内（会遮住详情内容 ✗ 用户 2026-10-08 第二批明确）。
    // 圆钮由 refreshRelShowBtn() 负责（每次详情渲染都调 ✓，且与关联数据无关 ✓）；这里只管关联笔记列表 ✓
    let html = '';
    if (items.length) {
      html += '<div class="bl-title">关联笔记（' + items.length + '）</div>';
      items.forEach((a, i) => {
        const title = a.effectiveTitle || a.title || a.id;
        html += '<div class="assoc-entry" data-i="' + i + '" title="打开这篇关联笔记（介绍这些节点之间的关系）">'
          + '<span class="ae-icon">📝</span>'
          + '<span class="ae-title">' + escHtml(title) + '</span>'
          + '<span class="bl-caption">' + (a.members || []).length + ' 方'
          + (a.hasNote ? '' : ' · 尚未写') + '</span>'
          + '</div>';
      });
    }
    el.innerHTML = html;
    el.querySelectorAll('.assoc-entry').forEach((row) => {
      row.addEventListener('click', (e) => {
        e.preventDefault();
        const a = items[Number(row.getAttribute('data-i'))];
        if (a) MM.showAssocPage(a, node);
      });
    });
    const boxOwner = el.closest ? el.closest('.float-detail') : null;   // 可能为空（el 已脱离文档 ✗）
    const btn = boxOwner ? boxOwner.querySelector('.rel-show-btn') : null;
    // （点击处理已搬到 refreshRelShowBtn：跟着圆钮建 ⇒ 不必等 assoc 数据 ✓ 也避免绑两次 ✗）
  }

  /* ================= 编辑笔记 =================
   * 复用编辑对话框的交互习惯（标题 + 正文 + 取消/保存），但写入走 CLI：
   * 渲染层不直接改盘，也不自己拼 HTML —— Markdown→HTML 的转换在 CLI 侧（--note-md）。
   */
  let editing = null;   // { assoc, box }

  function openAssocEditor(assoc, box) {
    editing = { assoc: assoc, box: box };
    const dlg = document.getElementById('assoc-dialog');
    if (!dlg) return;
    document.getElementById('assoc-title').value = assoc.title || '';
    document.getElementById('assoc-note').value = noteToEditable(assoc.note || '');
    dlg.style.display = 'flex';
    const t = document.getElementById('assoc-title');
    if (t) t.focus();
  }

  function closeAssocEditor() {
    editing = null;
    const dlg = document.getElementById('assoc-dialog');
    if (dlg) dlg.style.display = 'none';
  }

  /** 把已存的 HTML 笔记转成可编辑文本。
   *  存储是 HTML，但人写的时候更想要纯文本/Markdown —— 用 HTML→Markdown 还原
   *  （src/convert.js 已在页面加载，与导出 md 用的是同一个转换，行为一致）。 */
  function noteToEditable(html) {
    if (!html) return '';
    try {
      if (window.MMConvert && window.MMConvert.htmlToMarkdown) {
        return window.MMConvert.htmlToMarkdown(html) || '';
      }
    } catch (e) { /* 转换失败就退化为原样给用户看 */ }
    return String(html);
  }

  /** 保存：经 IPC → CLI `assoc-edit`（校验闸门 + 原子写），成功后同步内存并重绘本页 */
  async function saveAssocEditor() {
    if (!editing) return;
    const st = getState();
    if (!st || !st.project) { setStatus('请先打开项目', true); return; }
    const title = document.getElementById('assoc-title').value.trim();
    const noteMd = document.getElementById('assoc-note').value;
    const id = editing.assoc.id;
    const box = editing.box;
    try {
      const r = await window.desktop.app.assocEdit(st.project.name, id, title, noteMd);
      if (!r || !r.ok) { setStatus('保存关联笔记失败：' + ((r && r.text) || '未知错误'), true); return; }
      // **同步内存**（与"补链接"同一原则）：磁盘已由 CLI 写好，内存必须跟上，
      // 否则之后任何一次界面保存都会把刚写的笔记覆盖掉。
      // 用 CLI 回读的那份为准（它带 HTML 形式与解析后的成员标题），避免自己拼。
      const fresh = r.assoc;
      if (fresh) syncAssocRaw([fresh]);
      closeAssocEditor();
      setStatus('关联笔记已保存');
      // 重绘本页（用回读到的数据）
      if (box && box.el && box.el.parentElement) {
        const cur = fresh || (st.assoc || []).find((a) => a && a.id === id) || editing.assoc;
        box.assoc = cur;
        renderAssocPage(box, cur, box.node);
      }
      // 刷新锚定节点详情里的入口（可能从"尚未写"变成已写）
      if (box && box.node && MM.refreshNodeDetailBox) MM.refreshNodeDetailBox(box.node.id);
    } catch (err) {
      setStatus('保存关联笔记失败：' + ((err && err.message) || err), true);
    }
  }

  /** 绑定编辑对话框（只绑一次） */
  let bound = false;
  function bindAssocDialog() {
    const dlg = document.getElementById('assoc-dialog');
    if (!dlg || bound) return;
    bound = true;
    const ok = document.getElementById('assoc-ok');
    const cancel = document.getElementById('assoc-cancel');
    if (ok) ok.addEventListener('click', () => { saveAssocEditor(); });
    if (cancel) cancel.addEventListener('click', closeAssocEditor);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeAssocEditor(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveAssocEditor(); }
    });
  }

  MM.renderAssocPage = renderAssocPage;
  MM.renderAssocEntries = renderAssocEntries;
  MM.openAssocEditor = openAssocEditor;
  MM.closeAssocEditor = closeAssocEditor;
  MM.saveAssocEditor = saveAssocEditor;
  MM.bindAssocDialog = bindAssocDialog;
})();
