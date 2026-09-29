/* ============================================================
 * AI MindMap — 关系审计面板（app-audit.js）
 * ------------------------------------------------------------
 * 职责：把 CLI 的 `orphans` 与 `mentions` 两个审计能力呈现到界面上，
 *       并让 `mentions` 的发现**可一键补链接**（点击即写，走 CLI 闸门）。
 * 边界（本文件不负责）：
 *   · 判定逻辑一律在 CLI/sender —— 本文件只渲染与派发（分层铁律：渲染层不复制业务逻辑）
 *   · 命令面板（Ctrl+P）→ app-palette.js
 *   · 节点编辑与保存 → app-actions.js
 *
 * 为什么要把审计搬进界面：`orphans`/`mentions` 原先只有 CLI 有，
 * AI 能发现"该补哪条链接"而人却看不到 —— 规则在动作现场缺失等于没有（RULES M3）。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  // 跨模块转发（定义在别处的函数）。**必须写显式形参**：
  // 箭头函数没有自己的 `arguments`，`() => f.apply(null, arguments)` 会捕获外层 IIFE
  // 的空 arguments，等于"无参调用"（曾使状态栏静默失效；同类写法在 app-palette.js
  // 导致命令面板列表恒为空，由冒烟断言抓出）。
  const getState = () => MM.getState();
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const showDetail = (n) => MM.showDetail(n);

  let auditData = null;   // 最近一次审计结果（缓存，供重新渲染）

  function panel() { return document.getElementById('audit-panel'); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function closeAudit() {
    const p = panel();
    if (!p) return;
    p.style.display = 'none';
  }

  /** 渲染一张清单（orphans 用；mentions 另有补链接按钮，故单独渲染） */
  function renderOrphans(list) {
    if (!list || !list.items) return '<div class="audit-empty">（无法读取孤立节点清单）</div>';
    if (!list.items.length) return '<div class="audit-empty">没有"有内容却无人引用"的节点 — 关系很完整。</div>';
    return '<ul class="audit-list">' + list.items.map((x) =>
      '<li data-node="' + esc(x.id) + '">'
      + '<span class="audit-id">' + esc(x.id) + '</span>'
      + '<span class="audit-topic">' + esc(x.topic) + '</span>'
      + (x.tags && x.tags.length ? '<span class="audit-tag">' + esc(x.tags.join(' ')) + '</span>' : '')
      + '</li>').join('') + '</ul>';
  }

  function renderMentions(list) {
    if (!list || !list.items) return '<div class="audit-empty">（无法读取未链接提及）</div>';
    if (!list.items.length) {
      return '<div class="audit-empty">没有发现"正文提到却没建链接"的地方。</div>'
        + (list.structuralSkipped
          ? '<div class="audit-note">另有 ' + list.structuralSkipped + ' 处因结构上已相邻（父子/祖孙）被跳过 —— 树已表达该关系。</div>'
          : '');
    }
    return '<ul class="audit-list">' + list.items.map((x) =>
      '<li>'
      + '<div class="audit-mention">'
      + '<button class="audit-link-btn" data-from="' + esc(x.from) + '" data-to="' + esc(x.to) + '"'
      + ' title="为这两点建立链接">补链接</button>'
      + '<span class="audit-pair"><b>' + esc(x.fromTopic) + '</b> 提到了 <b>' + esc(x.toTopic) + '</b></span>'
      + '</div>'
      + (x.snippet ? '<div class="audit-snippet">…' + esc(x.snippet) + '…</div>' : '')
      + '</li>').join('') + '</ul>'
      + (list.structuralSkipped
        ? '<div class="audit-note">另有 ' + list.structuralSkipped + ' 处因结构上已相邻（父子/祖孙）被跳过。</div>'
        : '');
  }

  function render() {
    const p = panel();
    if (!p) return;
    const d = auditData || {};
    const o = d.orphans;
    const m = d.mentions;
    p.querySelector('#audit-body').innerHTML =
      '<h3>无引用但有内容（' + (o && o.contentOrphans !== undefined ? o.contentOrphans : '?') + '）</h3>'
      + '<p class="audit-hint">这些节点有实质内容，却没有任何引用关系 —— 通常是漏挂了链接。</p>'
      + renderOrphans(o)
      + '<h3>正文提到却没建链接（' + (m && m.mentions !== undefined ? m.mentions : '?') + '）</h3>'
      + '<p class="audit-hint">点「补链接」即建立关系（写操作走 CLI 校验闸门 + 原子写）。</p>'
      + renderMentions(m);
  }

  async function openAudit() {
    const p = panel();
    if (!p) return;
    const st = getState();
    if (!st || !st.project) { setStatus('请先打开一个项目', true); return; }
    p.style.display = 'flex';
    p.querySelector('#audit-body').innerHTML = '<div class="audit-empty">正在分析…</div>';
    try {
      auditData = await window.desktop.app.audit(st.project.name);
    } catch (err) {
      auditData = null;
      p.querySelector('#audit-body').innerHTML = '<div class="audit-empty">分析失败：' + esc((err && err.message) || err) + '</div>';
      return;
    }
    render();
    setStatus('关系审计：完成');
  }

  /** 补链接：写操作只经 CLI（拿校验闸门 + 原子写）。
   *
   *  **不要在这里重新加载项目**（曾经这么做，是一个真实缺陷）：
   *  `openProject()` 会从磁盘重建内存树并**重置撤销栈**，而本工程的编辑
   *  （改节点、加节点…）只存在于内存中，要用户点「保存」才落盘
   *  （见 editor.js 的提示"节点已更新，点击保存生效"）。于是"补链接"会**静默丢弃
   *  用户未保存的编辑**、并清空本次会话的撤销历史。
   *
   *  现在改为**就地补链**：磁盘已经由 CLI 写好，这里只把同一条链接追加到内存节点上，
   *  使内存与磁盘一致 —— 这样后续 `save()`（serializeTree 读 `node.data.links`）
   *  不会把这个新链接覆盖掉。既不丢用户编辑，也不丢撤销栈。
   *
   *  注意：**不能**只刷新面板而不动内存 —— 那样用户在补链后一旦保存，
   *  反而会把自己刚补的链接从磁盘上抹掉（serializeTree 写的是内存树）。
   */
  async function addLinkFromAudit(fromId, toId) {
    const st = getState();
    if (!st || !st.project) return;
    const name = st.project.name;
    const caption = '由关系审计补链';
    try {
      const r = await window.desktop.app.linkNodes(name, fromId, name, toId, caption);
      if (!r || !r.ok) { setStatus('补链接失败：' + ((r && r.text) || '未知错误'), true); return; }

      // 同步到内存树（磁盘已由 CLI 写好）
      const jm = st.jm;
      const node = jm && jm.get_node ? jm.get_node(fromId) : null;
      if (!node) {
        // 面板里的清单可能已过期（例如节点被删/改名）。磁盘已写入，但界面无法反映，
        // 需如实告知并刷新清单，而不是假装成功。
        setStatus('链接已写入磁盘，但当前视图找不到节点 ' + fromId + '（清单可能已过期，已刷新）', true);
        await openAudit();
        return;
      }
      node.data = node.data || {};
      const links = Array.isArray(node.data.links) ? node.data.links : (node.data.links = []);
      const dup = links.some((l) => l && l.project === name && l.id === toId);
      if (!dup) links.push({ project: name, id: toId, caption: caption });

      setStatus('已补链接：' + fromId + ' → ' + toId + '（已写入磁盘；如需撤销请用 CLI unlink）');
      // 刷新详情框里的「相关知识点」，让新链接立即可见
      if (MM.showDetail && jm.get_selected_node && jm.get_selected_node() === node) showDetail(node);
      await openAudit();
    } catch (err) {
      setStatus('补链接失败：' + ((err && err.message) || err), true);
    }
  }

  /** 面板内的点击派发（只绑一次，用事件委托 —— 内容会被重渲染） */
  let bound = false;
  function bindAudit() {
    const p = panel();
    if (!p) return;
    if (bound) return;          // 幂等：重复调用不叠加监听（与 bindContainerControls 同规矩）
    bound = true;
    const body = p.querySelector('#audit-body');
    body.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('audit-link-btn')) {
        e.preventDefault();
        const f = t.getAttribute('data-from');
        const to = t.getAttribute('data-to');
        if (f && to) addLinkFromAudit(f, to);
        return;
      }
      const li = t && t.closest ? t.closest('li[data-node]') : null;
      if (li) {
        const st = getState();
        const jm = st && st.jm;
        if (jm) {
          const node = jm.get_node(li.getAttribute('data-node'));
          if (node) { jm.select_node(node); showDetail(node); }
        }
      }
    });
    const closeBtn = p.querySelector('#audit-close');
    if (closeBtn) closeBtn.addEventListener('click', closeAudit);
  }

  MM.openAudit = openAudit;
  MM.closeAudit = closeAudit;
  MM.addLinkFromAudit = addLinkFromAudit;
  MM.bindAudit = bindAudit;
})();
