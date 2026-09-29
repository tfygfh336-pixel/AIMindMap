/* ============================================================
 * AI MindMap — 命令面板（app-palette.js）
 * ------------------------------------------------------------
 * Ctrl+P（macOS 为 Cmd+P）打开：一个输入框里同时模糊搜索
 *   · 节点（回车/点击 → 定位并打开详情）
 *   · 命令（展开全部、关系审计、导出…）
 * 边界：只做「检索 + 派发」，不实现任何业务逻辑；命令的实现仍在原有模块/CLI。
 *
 * 为什么需要它：节点上百之后，靠树里点找目标很慢；而本工程的命令已 30+ 条，
 * 只有 CLI 有、界面没有 → 人在界面里够不到 AI 能做的事（与审计面板同一动机）。
 * 这是 Obsidian 的标志性交互，也是"少即是多"的典型：不新增功能，只新增入口。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  // 跨模块转发
  const getState = () => MM.getState();
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const jumpToNode = (id) => MM.jumpToNode(id);

  let items = [];        // 当前可选项 [{kind,id,label,hint,run}]
  let sel = 0;           // 当前高亮索引
  let nodesCache = null; // 节点清单缓存（按项目名缓存，切项目时失效）

  function el() { return document.getElementById('palette'); }
  function inputEl() { return document.getElementById('palette-input'); }
  function listEl() { return document.getElementById('palette-list'); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 可执行的界面命令（与工具栏/菜单等价，只是多了一个入口） */
  const COMMANDS = [
    { id: 'expand-all', label: '展开全部', hint: '命令', run: () => MM.expandAll() },
    { id: 'collapse-all', label: '收起全部', hint: '命令', run: () => MM.collapseAll() },
    { id: 'reset-view', label: '还原视图', hint: '命令', run: () => MM.resetView() },
    { id: 'add-node', label: '新增子节点', hint: '命令', run: () => MM.addNode() },
    { id: 'add-topic', label: '新增顶层主题', hint: '命令', run: () => MM.addTopic() },
    { id: 'edit-node', label: '编辑当前节点', hint: '命令', run: () => MM.editNode() },
    { id: 'delete-node', label: '删除当前节点', hint: '命令', run: () => MM.deleteNode() },
    { id: 'audit', label: '关系审计（孤立 / 漏链接）', hint: '命令', run: () => MM.openAudit() },
    { id: 'undo', label: '撤销', hint: '命令', run: () => MM.undo() },
    { id: 'redo', label: '重做', hint: '命令', run: () => MM.redo() }
  ];

  /** 极简模糊匹配与排序已下沉到 src/palette-rank.js（纯函数、有单测）。
   *  原先此处内联实现里有一个真实缺陷：用 `score >= 0` 判定"是否命中"，
   *  而词首加分会让**合法命中得到负分** —— 于是"以关键词开头"的节点反而被丢掉。
   *  该缺陷由 tests/palette-rank.test.js 发现并锁死。
   *
   *  注意：这里**必须写显式形参**，不能用 `(…) => f.apply(null, arguments)` ——
   *  箭头函数没有自己的 `arguments`，那样写会捕获外层 IIFE 的空 arguments，
   *  实际变成"无参调用"（曾导致命令面板列表恒为空，由冒烟断言抓出）。 */
  const rankPalette = (entries, query, limit) => window.MMPaletteRank.rankPalette(entries, query, limit);

  async function loadNodes() {
    const st = getState();
    if (!st || !st.project) return [];
    if (nodesCache && nodesCache.project === st.project.name) return nodesCache.nodes;
    try {
      const r = await window.desktop.app.nodes(st.project.name);
      const nodes = (r && r.nodes) || [];
      nodesCache = { project: st.project.name, nodes };
      return nodes;
    } catch (err) {
      nodesCache = { project: st.project.name, nodes: [] };
      return [];
    }
  }

  /** 项目切换后让缓存失效（由 openProject 调用） */
  function invalidate() { nodesCache = null; }

  function render() {
    const l = listEl();
    if (!l) return;
    if (!items.length) { l.innerHTML = '<div class="palette-empty">没有匹配项</div>'; return; }
    l.innerHTML = items.map((it, i) =>
      '<div class="palette-item' + (i === sel ? ' on' : '') + '" data-i="' + i + '">'
      + '<span class="palette-label">' + esc(it.label) + '</span>'
      + (it.hint ? '<span class="palette-hint">' + esc(it.hint) + '</span>' : '')
      + '</div>').join('');
    const cur = l.querySelector('.palette-item.on');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  async function refresh() {
    const q = (inputEl() && inputEl().value) || '';
    const nodes = await loadNodes();
    const entries = [];
    nodes.forEach((n) => entries.push({ kind: 'node', id: n.id, label: n.topic, hint: '节点' }));
    COMMANDS.forEach((c) => entries.push({ kind: 'cmd', label: c.label, hint: c.hint, run: c.run }));
    // 排序/截断交给纯函数：空查询时命令在前（否则 131 个节点会把命令全挤出前 50 名）
    items = rankPalette(entries, q, 50);
    sel = 0;
    render();
  }

  function closePalette() {
    const p = el();
    if (p) p.style.display = 'none';
  }

  function isOpen() {
    const p = el();
    return !!(p && p.style.display !== 'none');
  }

  async function openPalette() {
    const p = el();
    const i = inputEl();
    if (!p || !i) return;
    const st = getState();
    if (!st || !st.project) { setStatus('请先打开一个项目', true); return; }
    // 每次打开都重新拉取节点清单：缓存在"输入时复用"是有价值的（避免每敲一个字就
    // spawn 一次 CLI），但**跨打开复用会过期** —— 新增/删除节点后立刻按 Ctrl+P
    // 就会搜不到新节点（或搜到已删除的）。打开那一刻刷新是正确性与开销的平衡点。
    nodesCache = null;
    p.style.display = 'flex';
    i.value = '';
    await refresh();
    i.focus();
  }

  function activate(idx) {
    const it = items[idx];
    if (!it) return;
    closePalette();
    if (it.kind === 'node') { jumpToNode(it.id); setStatus('已定位：' + it.label); return; }
    if (typeof it.run === 'function') it.run();
  }

  function move(delta) {
    if (!items.length) return;
    sel = (sel + delta + items.length) % items.length;
    render();
  }

  /** 面板内的键盘处理。**必须 stopPropagation**：否则会在文档级再触发一遍
   *  editor.js 的 Delete/Backspace（→ 删节点）与 app.js 的 Esc（→ 连带关掉审计面板）。
   *  面板里按 Esc 只应关面板本身。 */
  let bound = false;
  function bindPalette() {
    const p = el();
    const i = inputEl();
    const l = listEl();
    if (!p || !i || !l) return;
    if (bound) return;          // 幂等：重复调用不叠加监听（与 bindContainerControls 同规矩）
    bound = true;
    i.addEventListener('input', () => { refresh(); });
    i.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); activate(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
      else if (e.key === 'Backspace' || e.key === 'Delete') {
        // 输入框内改字：绝不能冒泡成"删除节点"
        e.stopPropagation();
      }
    });
    l.addEventListener('click', (e) => {
      const it = e.target && e.target.closest ? e.target.closest('.palette-item') : null;
      if (it) activate(Number(it.getAttribute('data-i')));
    });
    // 点击遮罩关闭
    p.addEventListener('mousedown', (e) => { if (e.target === p) closePalette(); });
  }

  MM.openPalette = openPalette;
  MM.closePalette = closePalette;
  MM.paletteIsOpen = isOpen;
  MM.bindPalette = bindPalette;
  MM.invalidatePaletteCache = invalidate;
})();
