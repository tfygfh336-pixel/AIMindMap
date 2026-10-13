/* ============================================================
 * AI MindMap — 绑定工作区文件夹（界面侧，R4 · 第④步「界面（最小可用）」）
 * ------------------------------------------------------------
 * 用户原话：「绑定工作区文件夹，选择好了之后就会定时更新文件夹内容到思维导图」。
 * 引擎（第①②③步）已经落地：项目数据里的 `bindings` 契约 + 主进程 `fs.watch` 守护 + CLI `bind-sync`。
 * **本文件只做三件事，一行同步逻辑都没有**（判定与写盘全在 CLI 那一侧）：
 *   ① **入口**：工具栏「📁 绑定文件夹」⇒ 主进程原生选目录（`showOpenDialog({properties:['openDirectory']})`）
 *      ⇒ **先预览**（复用既有 `--dry-run` 读法：新增 N / 更新 M / 未转换 K）⇒ **人确认才真的绑定**；
 *   ② **状态区**：`守护中/已暂停 · 已收录 N 个文件 · 上次同步 hh:mm:ss · 本次 +N 改 M · 待确认删 K · 未转换 K`
 *      ＋ 三个按钮（暂停/继续 · 立即同步 · 解绑）；
 *   ③ **变更播报**：每次同步真改过树 ⇒ 复用**并发可见性那一批**的同一套 banner/面板视觉与**同一个渲染器**
 *      （`MM.renderConcPanel`），面板里逐条列出"这次加进来的是哪些节点"，点一条跳到它。
 *
 * 三条纪律（各对应用户最在意的三件事，也是本批的判据）：
 *   · **绝不静默覆盖人的编辑**：界面脏时引擎会把这一轮停住并报 `blocked-dirty`，界面**照原话**显示原因；
 *     界面自己不写盘 —— 它只调 CLI ⇒ 版本闸门/并发重放/三方合并/冲突面板全都还是既有那一套。
 *   · **读状态不写数据**：状态探针只用 `bind-sync --dry-run`（引擎里唯一"只报告、不写盘"的读法）。
 *     ⚠️ **不许**用 `--list` 当只读查询：它其实**会同步**（计划里 targets 仍是全部绑定）——
 *     拿它刷新状态会让"暂停"名存实亡 ✗（详见 main.js 的 app:bind-probe 注释）。
 *   · **未绑定 = 零噪声**：没有任何绑定时，状态条/播报/面板一律 `display:none`（不占布局、不进命中测试）。
 *     工具栏上只多**一个**入口按钮（设计 §五 要求的"一处入口"）。
 *
 * ⚠️ 界面里的每一个数都来自 CLI 的报告字段（`bindings[]` 与 `sync[]`），界面**不自己算**任何数；
 *    唯一"界面自己算"的东西是"这次同步前后树里哪些对象变了"，而那也是主进程用 **`src/concurrency.js`**
 *    （渲染层差异预览用的**同一个函数**）算好送过来的键，本文件只负责显示与跳转。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});
  const $ = (id) => document.getElementById(id);
  const app = () => (window.desktop && window.desktop.app) || null;
  const currentProject = () => {
    const st = MM.getState ? MM.getState() : null;
    return (st && st.project && st.project.name) ? st.project.name : '';
  };

  /* ---------------- 只存"要显示的东西"（判定不在这里） ---------------- */
  let probe = null;            // 最近一次**只读探针**（`--dry-run` 的整份报告：bindings[] / sync[]）
  let probeSeq = 0;            // 探针序号：迟到的旧结果不许覆盖新的（切项目时尤其明显）
  let lastSync = null;         // 最近一次**真的同步过**的那一行（自动的 / 人点的）
  let lastSyncWhy = '';        // 那次同步是谁引起的（fs.watch / sweep / manual）
  let lastReadings = null;     // 主进程算的"这次动了哪些对象"（键 + 人话名；见 runBindSyncCli）
  let busy = '';               // 正在跑的动作（防重复点击；也是可读读数）
  let lastError = '';          // 最近一次失败的**原话**（不吞）
  let previewTarget = null;    // 预览对话框当前目标 {dir, mode, include, stub}
  let previewPlan = null;      // 预览读数（CLI 的 plan 行）
  let previewError = '';
  let previewBusy = false;
  let bannerText = '';         // 播报 banner 的那一句（断言也读它）
  let diskTimer = null;        // 盘上变更后的状态刷新防抖

  /* ---------------- 小工具（只做显示层的格式化，不改任何判定） ---------------- */
  /** ISO 时间 → 本地 `hh:mm:ss`（给人看的那一份；读不出来就**原样显示**，不假装知道时间） */
  function hms(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleTimeString();
    } catch (e) { return String(iso); }
  }
  function baseNameOf(p) {
    const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const seg = s.split('/');
    return seg[seg.length - 1] || s;
  }
  const whyText = (why) => (why === 'sweep' ? '兜底巡检（每 10 分钟一次，零 token）'
    : why === 'fs.watch' ? '文件夹有变化（事件驱动，零 token）'
      : why === 'manual' ? '你点的「立即同步」' : '自动同步');
  const ACT_LABEL = { pause: '暂停', resume: '继续', sync: '立即同步', unbind: '解绑' };

  /* ================= ② 状态区（唯一渲染入口） ================= */
  /**
   * 把状态条画出来。**每一个数都从 CLI 报告里直接取**：
   *   · `bindings[0]`：`active/status`（守护中/已暂停，判定在 CLI）、`files`、`pending`（待确认删）、
   *     `unconverted`、`lastSyncAt`、`note`（引擎给的"为什么停住了"原话）；
   *   · `lastSync`（最近一次真同步那一行）：`added / modified` ⇒ "本次 +N 改 M"。
   * 没有任何绑定 ⇒ **整条 `display:none`**（不占布局、不进命中测试 ⇒ 未绑定时界面零噪声 ✓）。
   */
  function renderBar() {
    const bar = $('bind-bar');
    if (!bar) return { shown: false, reason: 'no-element' };
    const name = currentProject();
    const rows = (probe && probe.project === name && Array.isArray(probe.bindings)) ? probe.bindings : [];
    const text = $('bind-bar-text');
    const btnToggle = $('bind-btn-toggle');
    const btnSync = $('bind-btn-sync');
    const btnUnbind = $('bind-btn-unbind');
    if (!name || !rows.length) {
      bar.style.display = 'none';
      bar.setAttribute('data-bind-showing', '0');
      bar.setAttribute('data-bind-count', '0');
      if (text) text.textContent = '';
      bar.removeAttribute('data-bind-state');
      if (btnToggle) { btnToggle.style.display = 'none'; }
      if (btnSync) { btnSync.style.display = 'none'; }
      if (btnUnbind) { btnUnbind.style.display = 'none'; }
      return { shown: false, count: 0 };
    }
    const b = rows[0];
    const state = b.active ? '守护中'
      : (b.status === 'paused' ? '已暂停' : (b.status === 'blocked' ? '受阻' : String(b.status || '未知')));
    const parts = [
      '「' + baseNameOf(b.dir) + '」',
      state,
      '已收录 ' + b.files + ' 个文件',
      '上次同步 ' + (b.lastSyncAt ? hms(b.lastSyncAt) : '还没同步过'),
      '本次 ' + (lastSync ? ('+' + lastSync.added + ' 改 ' + lastSync.modified) : '—'),
      '待确认删 ' + b.pending,
      '未转换 ' + b.unconverted
    ];
    if (b.note) parts.push('（' + b.note + '）');
    if (rows.length > 1) parts.push('（另有 ' + (rows.length - 1) + ' 条绑定：这一版界面只操作第一条）');
    if (text) text.textContent = parts.join(' · ');
    // 机器可读的那一份（与上面**同一批读数**，给断言/排查用；不是第二份计算）
    bar.setAttribute('data-bind-showing', '1');
    bar.setAttribute('data-bind-count', String(rows.length));
    bar.setAttribute('data-bind-state', b.status || (b.active ? 'watching' : 'unknown'));
    bar.setAttribute('data-bind-active', b.active ? '1' : '0');
    bar.setAttribute('data-bind-files', String(b.files));
    bar.setAttribute('data-bind-pending', String(b.pending));
    bar.setAttribute('data-bind-unconverted', String(b.unconverted));
    bar.setAttribute('data-bind-last-sync', b.lastSyncAt || '');
    bar.setAttribute('data-bind-binding', b.binding || '');
    bar.setAttribute('data-bind-dir', b.dir || '');
    bar.setAttribute('data-bind-added', String(lastSync ? lastSync.added : ''));
    bar.setAttribute('data-bind-modified', String(lastSync ? lastSync.modified : ''));
    if (btnToggle) {
      btnToggle.style.display = '';
      btnToggle.textContent = b.active ? '暂停' : '继续';
      // 同一个按钮两个语义 ⇒ `data-bind-act` 必须跟着状态走（否则"继续"会打到 `--pause` 上）
      btnToggle.setAttribute('data-bind-act', b.active ? 'pause' : 'resume');
      btnToggle.title = b.active
        ? '暂停这个绑定的自动同步（已导入的节点一个都不动；引擎会先把当前待同步的变化同步一次再暂停）'
        : '继续自动同步（点下去会立刻同步一次）';
      btnToggle.disabled = !!busy || rows.length > 1;
    }
    if (btnSync) {
      btnSync.style.display = '';
      btnSync.title = '立刻同步一次（人点的动作；暂停中也能手动同步）';
      btnSync.disabled = !!busy || rows.length > 1;
    }
    if (btnUnbind) {
      btnUnbind.style.display = '';
      btnUnbind.title = '解绑这个文件夹（**已导入的节点全部保留**；只是不再盯着它）';
      btnUnbind.disabled = !!busy || rows.length > 1;
    }
    bar.style.display = 'flex';
    return { shown: true, count: rows.length, row: b, state: state };
  }

  /** 只读探针：拿一份**当前**读数回来重画状态条。失败**响亮**（状态栏说原话），不静默留旧数据。 */
  async function refreshBar() {
    const name = currentProject();
    if (!name) { probe = null; renderBar(); return { ok: false, reason: 'no-project' }; }
    const api = app();
    if (!api || !api.bindProbe) {
      lastError = '这个版本没有绑定状态通道（preload 少了 desktop.app.bindProbe）';
      renderBar();
      return { ok: false, error: lastError };
    }
    const seq = ++probeSeq;
    let r = null;
    try { r = await api.bindProbe(name); } catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
    if (seq !== probeSeq) return { ok: false, reason: 'superseded' };     // 迟到的旧探针不覆盖新的
    if (r && r.ok && r.report) { probe = r.report; lastError = ''; }
    else {
      lastError = (r && r.error) || '状态读取失败';
      if (MM.setStatus) MM.setStatus('绑定状态读取失败：' + lastError, true);
    }
    const out = renderBar();
    return { ok: !!(r && r.ok), state: out, error: lastError };
  }

  /* ================= ③ 变更播报（复用并发可见性那套视觉与渲染器） ================= */
  /**
   * banner 的**唯一渲染**（只在真的同步过、而且树真变了的时候亮）。
   * 文案里带条数与来源：别让人去猜"这次到底加了什么、是谁动的"。
   */
  function showBindBanner(text) {
    const b = $('bind-banner');
    if (!b) return false;
    const t = $('bind-banner-text');
    bannerText = text;
    if (t) t.textContent = text;
    b.style.display = 'flex';
    return true;
  }
  function closeBindBanner() {
    const b = $('bind-banner');
    if (b) b.style.display = 'none';
  }
  function bindBannerShown() {
    const b = $('bind-banner');
    return !!b && b.style.display !== 'none';
  }

  /** 这次同步的读数（主进程在起 CLI 前后各读一次算的键）里，**节点级**的那些 */
  const nodeKeys = (list) => (Array.isArray(list) ? list.filter((k) => typeof k === 'string' && k.indexOf('node:') === 0) : []);
  /** 键→人话名：**主进程给的映射**（它才知道键与名怎么配对；界面不自己按顺序去对） */
  const labelMapOf = () => {
    const m = (lastReadings && lastReadings.labels) || {};
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  };

  /** 只读取盘上这一版（**不推进任何基线** —— 与「外部改动预览」同一条通道 `project:peek`）。
   *  为什么必须用 peek 而不是 read：read 会把主进程的"界面读到哪一版"推进到盘上这一版 ⇒
   *  之后保存就会被判成"没有外部改动"⇒ 静默覆盖（本工程最重的损害类别 ✗）。 */
  function peekProject(name) {
    const api = window.desktop && window.desktop.project;
    if (!api || typeof api.peek !== 'function') return Promise.resolve({ ok: false, error: '这个版本没有只读探视通道' });
    return Promise.resolve().then(() => api.peek(name))
      .then((r) => ((r && r.ok && r.data) ? { ok: true, data: r.data, version: r.version } : { ok: false, error: (r && r.error) || '探视没有返回内容' }))
      .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
  }

  /**
   * **播报面板**：这次的变更逐条摆出来（点一条跳到那个节点）。
   * 与「外部改动预览」/「冲突面板」**共用同一个卡片渲染器**（`MM.renderConcPanel`）与同一个差异行构造
   * （`src/concurrency.js` 的 `diffRows`）—— 界面里**没有**第三套"哪里不一样"的实现 ✓。
   */
  async function showBindPanel() {
    const name = currentProject();
    const cc = window.MMConcurrency;
    if (!cc || typeof cc.diffRows !== 'function' || !MM.renderConcPanel) {
      if (MM.setStatus) MM.setStatus('变更播报不可用：渲染层没有加载 src/concurrency.js 或共用面板渲染器', true);
      return false;
    }
    const read = lastReadings || { keys: [], added: [], removed: [], modified: [], labels: [] };
    const p = await peekProject(name);
    const data = p.ok ? p.data : null;
    const labels = labelMapOf();
    const sides = [{ label: '盘上现状（同步之后）', data: data || {} }];
    const rowsOf = (keys) => cc.diffRows(sides, keys, { labels: labels });
    const added = nodeKeys(read.added);
    const modified = nodeKeys(read.modified);
    const removed = nodeKeys(read.removed);
    const synced = lastSync;
    const noNodes = !added.length && !modified.length && !removed.length;
    if (!synced && noNodes) {
      if (MM.setStatus) MM.setStatus('这次同步没有节点级变化可看（可能只是记录了同步时间）');
      return false;
    }
    const jump = (key) => {
      const id = key.slice('node:'.length);
      if (MM.jumpToNode) { MM.jumpToNode(id); return; }
      if (MM.setStatus) MM.setStatus('界面没有 jumpToNode，跳不过去：' + id, true);
    };
    return MM.renderConcPanel({
      title: '工作区文件夹同步：这次加进来的节点',
      meta: '来自 ' + whyText(lastSyncWhy)
        + (synced ? (' · CLI 报告：新增 ' + synced.added + ' 个文件 / 更新 ' + synced.modified + ' 个'
          + (synced.pending ? (' / 待确认删 ' + synced.pending + ' 个') : '')
          + (synced.unconverted ? (' / 未转换 ' + synced.unconverted + ' 个') : '')) : '')
        + ' · 下面每一行是**节点**（一个文件会带进它文档里的层级节点）',
      hint: '这一层**只看不写**：点一行只是跳到那个节点（不改数据、不写盘）。'
        + '"哪些节点变了"由主进程在起 CLI 前后各读一次项目、用 src/concurrency.js 现算（与差异预览同一个函数）；'
        + '条数由 CLI 的报告给出 —— 两个来源不一致时，界面照实分别显示，不合并、不粉饰。',
      groups: [
        { title: '这次**新出现**的节点（' + added.length + ' 个，点一条跳到它）',
          rows: rowsOf(added), empty: '（这次没有新增节点）', onRowClick: jump },
        { title: '这次**内容被改到**的节点（' + modified.length + ' 个）',
          rows: rowsOf(modified), empty: '（这次没有更新已有节点）', onRowClick: jump },
        { title: '这次**消失**的节点（' + removed.length + ' 个；只有"人确认过的删除提议"才会走到这里）',
          rows: rowsOf(removed), empty: '（没有节点被删 —— 删除只提议，见状态区"待确认删 K"）' }
      ],
      buttons: [{ label: '收起', act: 'close-bind-broadcast', onClick: () => { if (MM.closeConcPanel) MM.closeConcPanel(); } }]
    });
  }

  /**
   * 自动/手动同步之后的统一收尾：记读数 → 状态条 → 播报 banner + 状态栏。
   * `res` = 主进程给的那一份（`{report, changedKeys, addedKeys, removedKeys, modifiedKeys, labels}`）。
   */
  function applyReadings(res, why) {
    const report = res && res.report;
    if (report && Array.isArray(report.bindings)) probe = report;      // 报告自带最新 bindings[] ⇒ 同一批读数
    const rows = (report && Array.isArray(report.sync)) ? report.sync : [];
    const synced = rows.filter((r) => r && r.status === 'synced')[0] || null;
    if (synced) { lastSync = synced; lastSyncWhy = why; }
    lastReadings = {
      keys: (res && res.changedKeys) || [],
      added: (res && res.addedKeys) || [],
      removed: (res && res.removedKeys) || [],
      modified: (res && res.modifiedKeys) || [],
      labels: (res && res.labels) || {}
    };
    const blocked = rows.filter((r) => r && (r.status === 'blocked-dirty' || r.status === 'dir-missing'))[0] || null;
    if (blocked) {
      // 引擎**如实报**为什么会停（界面脏 / 目录读不到）：界面照原话转述，绝不静默跳过 ✗
      const reason = blocked.status === 'blocked-dirty'
        ? '界面有未保存编辑 ⇒ 这一轮没写（先保存，下一轮自己会再来）'
        : '绑定的目录现在读不到（删了？盘没挂？）⇒ 盘上零改动';
      if (MM.setStatus) MM.setStatus('工作区文件夹这轮没有同步：' + reason + (blocked.note ? '｜' + blocked.note : ''), true);
      renderBar();
      return { synced: null, blocked: blocked.status, reason: reason };
    }
    if (!synced) { renderBar(); return { synced: null }; }
    const text = '工作区文件夹' + (why === 'manual' ? '已同步（' + whyText(why) + '）' : '自动同步（' + whyText(why) + '）')
      + '：新增 ' + synced.added + ' 个文件 / 更新 ' + synced.modified + ' 个'
      + (synced.pending ? ' · 待确认删 ' + synced.pending + ' 个（**节点一个都没删**）' : '')
      + ' · 未转换 ' + synced.unconverted + ' 个';
    showBindBanner(text + ' —— 点开看这次加进来的是哪些节点');
    if (MM.setStatus) MM.setStatus(text);
    renderBar();
    return { synced: synced, text: text };
  }

  /** 主进程发来的"自动同步真的写过盘"事件（事件驱动 / 兜底巡检两条自动路都会来） */
  function onBindSynced(payload) {
    if (!payload || !payload.project) return;
    if (payload.project !== currentProject()) return;    // 别的项目的一批 ⇒ 不往当前页面播报（防串页）
    const res = applyReadings(payload, payload.why || 'auto');
    if (res.synced && MM.requestReread) MM.requestReread();   // 让新节点出现在导图上（既有重读路径：有脏则拒绝覆盖）
  }

  /* ================= ① 入口：选目录 → 预览 → 确认 ================= */
  function openPreview(dir, stub) {
    previewTarget = { dir: dir, mode: 'flat', include: null, stub: !!stub };
    previewPlan = null; previewError = '';
    const box = $('bind-preview');
    const dirLine = $('bind-preview-dir');
    if (dirLine) {
      dirLine.textContent = '目录：' + dir + (stub ? '（⚠ 这一跳是**冒烟脚本化的答案**，不是你亲手选的）' : '');
    }
    const flat = $('bind-mode-flat');
    const mirror = $('bind-mode-mirror');
    if (flat) flat.checked = true;
    if (mirror) mirror.checked = false;
    const incDefault = $('bind-include-default');
    const incMd = $('bind-include-md');
    if (incDefault) incDefault.checked = true;
    if (incMd) incMd.checked = false;
    renderPreview();
    if (box) box.style.display = 'flex';
    return true;
  }
  function closePreview() {
    const box = $('bind-preview');
    if (box) box.style.display = 'none';
    previewTarget = null;
  }
  function previewShown() {
    const box = $('bind-preview');
    return !!box && box.style.display !== 'none';
  }

  /** 预览读数**唯一渲染入口**：数字与逐条清单都直接来自 CLI 的 `plan` 行（界面不估算） */
  function renderPreview() {
    const box = $('bind-preview-plan');
    const ok = $('bind-preview-ok');
    if (ok) ok.disabled = previewBusy;
    if (!box) return;
    box.textContent = '';
    box.className = 'bind-plan';
    if (previewBusy) {
      box.className = 'bind-plan busy';
      box.textContent = '正在按既有 `--dry-run` 读法算"将要做什么"…（在一份演练副本上算，你的项目一个字节都没动）';
      return;
    }
    if (previewError) {
      box.className = 'bind-plan err';
      box.textContent = '预览失败：' + previewError;
      return;
    }
    const p = previewPlan;
    if (!p) { box.textContent = '（还没有预览读数）'; return; }
    box.setAttribute('data-plan-added', String(p.added));
    box.setAttribute('data-plan-modified', String(p.modified));
    box.setAttribute('data-plan-unconverted', String(p.unconverted));
    box.setAttribute('data-plan-scanned', String(p.scanned));
    box.setAttribute('data-plan-kept', String(p.kept));
    const line = document.createElement('div');
    line.className = 'bind-plan-line';
    line.textContent = '将要做什么：新增 ' + p.added + ' 个文件 · 更新 ' + p.modified + ' 个 · 未转换 '
      + p.unconverted + ' 个（范围内 ' + p.scanned + ' 个文件，命中收录规则 ' + p.kept + ' 个）';
    box.appendChild(line);
    const note = document.createElement('div');
    note.className = 'bind-plan-note';
    note.textContent = '确认后立刻同步一次；**不会删除任何节点**（盘上少了的文件只记一条"待确认删"，'
      + '由你在状态区看到 K，删不删由人定）。';
    box.appendChild(note);
    if (p.unconvertedList && p.unconvertedList.length) {
      const ul = document.createElement('div');
      ul.className = 'bind-plan-unconv';
      ul.textContent = '转不了的 ' + p.unconvertedList.length + ' 个文件（**逐个点名**，不静默跳过）：';
      p.unconvertedList.slice(0, 12).forEach((u) => {
        const li = document.createElement('div');
        li.className = 'bind-plan-unconv-item';
        li.textContent = '· ' + (u.rel || '') + ' —— ' + (u.label || u.reason || '');
        ul.appendChild(li);
      });
      if (p.unconvertedList.length > 12) {
        const li = document.createElement('div');
        li.className = 'bind-plan-unconv-item';
        li.textContent = '· …另有 ' + (p.unconvertedList.length - 12) + ' 个';
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  }

  function previewOpts() {
    const mirror = $('bind-mode-mirror');
    const md = $('bind-include-md');
    return {
      mode: (mirror && mirror.checked) ? 'mirror' : 'flat',
      include: (md && md.checked) ? '*.md' : null
    };
  }

  /** 算一次预览（**零写入**：主进程在一份演练副本上跑既有 `--dry-run`，见 app:bind-preview） */
  async function runPreview() {
    if (!previewTarget) return { ok: false, error: '没有预览目标' };
    const api = app();
    const name = currentProject();
    if (!api || !api.bindPreview) { previewError = '这个版本没有预览通道（preload 少了 desktop.app.bindPreview）'; renderPreview(); return { ok: false, error: previewError }; }
    if (!name) { previewError = '先打开一个项目'; renderPreview(); return { ok: false, error: previewError }; }
    const o = previewOpts();
    previewTarget.mode = o.mode;
    previewTarget.include = o.include;
    previewBusy = true; previewError = ''; renderPreview();
    let r = null;
    try { r = await api.bindPreview(name, previewTarget.dir, o); }
    catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
    previewBusy = false;
    if (!r || !r.ok) {
      previewPlan = null;
      previewError = (r && r.error) || '预览失败';
      renderPreview();
      if (MM.setStatus) MM.setStatus('绑定前预览失败：' + previewError, true);
      return { ok: false, error: previewError };
    }
    previewPlan = r.plan || null;
    previewError = previewPlan ? '' : '预览没有拿到计划行';
    renderPreview();
    return { ok: !!previewPlan, plan: previewPlan };
  }

  /** 入口：工具栏按钮 / 冒烟断言 / 命令面板都走它（**一条实现**） */
  async function bindWorkspace() {
    const name = currentProject();
    if (!name) { if (MM.setStatus) MM.setStatus('先打开一个项目，再绑定工作区文件夹', true); return { ok: false, error: '没有当前项目' }; }
    if (busy) { if (MM.setStatus) MM.setStatus('上一个绑定动作还在跑（' + busy + '），这一步没执行', true); return { ok: false, error: '忙' }; }
    const api = app();
    if (!api || !api.bindPickDir) {
      if (MM.setStatus) MM.setStatus('绑定通道没接上（preload 少了 desktop.app.bindPickDir）', true);
      return { ok: false, error: '没有通道' };
    }
    let pick = null;
    try { pick = await api.bindPickDir(); } catch (err) { pick = { ok: false, error: (err && err.message) || String(err) }; }
    if (!pick || !pick.ok) {
      if (pick && pick.canceled) { if (MM.setStatus) MM.setStatus('已取消：没有选目录'); return { ok: false, canceled: true }; }
      const e = (pick && pick.error) || '选目录失败';
      if (MM.setStatus) MM.setStatus('选目录失败：' + e, true);
      return { ok: false, error: e };
    }
    openPreview(pick.dir, pick.stub);
    const r = await runPreview();
    return { ok: true, dir: pick.dir, stub: !!pick.stub, preview: r };
  }

  /** 确认绑定：写记录 + 立刻同步一次（都在 CLI 侧）⇒ 关预览 ⇒ 报数 ⇒ 让界面重读 */
  async function bindPreviewConfirm() {
    if (!previewTarget || previewBusy) return { ok: false, error: '没有可确认的预览' };
    const api = app();
    const name = currentProject();
    if (!api || !api.bindApply) { previewError = '这个版本没有绑定通道（preload 少了 desktop.app.bindApply）'; renderPreview(); return { ok: false, error: previewError }; }
    const o = previewOpts();
    previewBusy = true; previewError = ''; renderPreview();
    let r = null;
    try { r = await api.bindApply(name, previewTarget.dir, o); }
    catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
    previewBusy = false;
    if (!r || !r.ok) {
      previewError = (r && r.error) || '绑定失败';
      renderPreview();
      if (MM.setStatus) MM.setStatus('绑定失败：' + previewError, true);
      return { ok: false, error: previewError };
    }
    const dir = previewTarget.dir;
    closePreview();
    const res = applyReadings(r, 'manual');
    await refreshBar();
    if (res.synced && MM.requestReread) MM.requestReread();   // 新节点进导图（既有重读路径）
    return { ok: true, dir: dir, readings: res };
  }

  /* ================= 三个按钮（暂停/继续 · 立即同步 · 解绑） ================= */
  /** 动作入口（**一条实现**：状态条的按钮、冒烟断言、命令面板都走它）。
   *  每个动作只打到 `bind-sync` 的一个**既有**开关上（main.js 的 app:bind-cmd），界面不判任何事。 */
  async function bindAct(action) {
    const name = currentProject();
    if (!name) return { ok: false, error: '没有当前项目' };
    if (!ACT_LABEL[action]) return { ok: false, error: '不认识的动作：' + action };
    if (busy) { if (MM.setStatus) MM.setStatus('上一个绑定动作还在跑（' + busy + '），这一步没执行', true); return { ok: false, error: '忙' }; }
    const api = app();
    if (!api || !api.bindCmd) {
      if (MM.setStatus) MM.setStatus('绑定通道没接上（preload 少了 desktop.app.bindCmd）', true);
      return { ok: false, error: '没有通道' };
    }
    busy = action; renderBar();
    try {
      let r = null;
      try { r = await api.bindCmd(name, action); }
      catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
      if (!r || !r.ok) {
        lastError = (r && r.error) || (ACT_LABEL[action] + '失败');
        if (MM.setStatus) MM.setStatus('绑定动作「' + ACT_LABEL[action] + '」失败：' + lastError, true);
        await refreshBar();
        return { ok: false, error: lastError };
      }
      lastError = '';
      const res = applyReadings(r, 'manual');
      await refreshBar();
      if (res.synced && MM.requestReread) MM.requestReread();
      const tail = res.synced ? ('（本次 +' + res.synced.added + ' 改 ' + res.synced.modified + '）') : '';
      if (MM.setStatus) {
        MM.setStatus('已' + ACT_LABEL[action] + (action === 'unbind' ? '：绑定的目录不再被盯，**已导入的节点全部保留**' : tail));
      }
      return { ok: true, action: action, readings: res };
    } finally { busy = ''; renderBar(); }
  }

  /* ================= 接线 ================= */
  function bind() {
    const entry = $('btn-bind-workspace');
    if (entry) entry.addEventListener('click', () => { bindWorkspace(); });

    const t = $('bind-btn-toggle');
    if (t) t.addEventListener('click', () => {
      const act = (t.getAttribute('data-bind-act') === 'pause') ? 'pause' : 'resume';
      bindAct(act);
    });
    const s = $('bind-btn-sync');
    if (s) s.addEventListener('click', () => { bindAct('sync'); });
    const u = $('bind-btn-unbind');
    if (u) u.addEventListener('click', () => { bindAct('unbind'); });

    const open = $('bind-banner-open');
    if (open) open.addEventListener('click', () => { showBindPanel(); });
    const close = $('bind-banner-close');
    if (close) close.addEventListener('click', () => {
      closeBindBanner();
      if (MM.setStatus) MM.setStatus('已收起这条播报（节点都在导图上；再点「立即同步」不会重复统计）');
    });

    const cancel = $('bind-preview-cancel');
    if (cancel) cancel.addEventListener('click', () => {
      // 取消**什么都不会留**：预览全程零写入（演练副本），此刻用户项目里连绑定记录都还没有
      closePreview();
      if (MM.setStatus) MM.setStatus('已取消：没有绑定任何东西（你的项目一个字节都没动）');
    });
    const ok = $('bind-preview-ok');
    if (ok) ok.addEventListener('click', () => { bindPreviewConfirm(); });
    ['bind-mode-flat', 'bind-mode-mirror', 'bind-include-default', 'bind-include-md'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => { runPreview(); });   // 换形态/收录范围 ⇒ 重新算
    });

    /* 主进程的"自动同步真写过盘"事件：变更播报 + 状态区（事件驱动 / 兜底巡检两条路都来） */
    if (window.desktop && window.desktop.onBindSynced) {
      window.desktop.onBindSynced((payload) => {
        try { onBindSynced(payload); } catch (e) { if (MM.setStatus) MM.setStatus('同步播报渲染失败：' + ((e && e.message) || e), true); }
      });
    }
    /* 盘上变了（外部 CLI / 我自己的同步 / 绑定记录被改）⇒ 状态条跟着刷新。
     * 防抖 400ms：一次同步会连着来好几条（project:disk-changed + app:bind-synced），
     * 以免每次都起一条 CLI 探针（那是真子进程，不是空转）。 */
    if (window.desktop && window.desktop.onProjectDiskChange) {
      window.desktop.onProjectDiskChange(() => {
        if (diskTimer) clearTimeout(diskTimer);
        diskTimer = setTimeout(() => { diskTimer = null; refreshBar(); }, 400);
      });
    }
    /* 切项目 ⇒ 状态条必须跟着换（它显示的永远是"当前项目"的绑定）。
     * 为什么用包装而不是新造一个 project-opened 事件：项目切换已有**唯一**入口
     * `MM.openProject`（工具栏下拉、菜单、导入后打开、每域隔离的重载都走它）⇒ 挂一次全覆盖；
     * 再发明一个事件就是"同一件事两处表达"。包装是**叠加**的：原函数照原样跑、原返回值照原样返回。 */
    const orig = MM.openProject;
    if (typeof orig === 'function' && !MM.__bindOpenProjectWrapped) {
      MM.__bindOpenProjectWrapped = true;
      MM.openProject = function () {
        const r = orig.apply(this, arguments);
        Promise.resolve(r).then((ok) => { if (ok !== false) refreshBar(); })
          .catch(() => { refreshBar(); });
        return r;
      };
    }
    refreshBar();
  }

  /* ---------------- 对外 API（断言/排查用；判据仍然读**内容与命中测试**） ---------------- */
  MM.bindWorkspace = bindWorkspace;
  MM.bindRefresh = refreshBar;
  MM.bindAct = bindAct;
  MM.bindPreviewRun = runPreview;
  MM.bindPreviewCancel = closePreview;
  MM.bindPreviewConfirm = bindPreviewConfirm;
  MM.bindPreviewShown = previewShown;
  MM.onBindSynced = onBindSynced;
  MM.showBindPanel = showBindPanel;
  MM.closeBindBanner = closeBindBanner;
  MM.bindBannerShown = bindBannerShown;
  MM.bindBannerText = () => bannerText;
  MM.renderBar = renderBar;
  /** 读数快照（**只读**；给冒烟断言与排查看"界面这一侧记的是什么"） */
  MM.bindState = () => {
    const bar = $('bind-bar');
    return {
      project: currentProject(),
      busy: busy,
      lastError: lastError,
      barShown: !!(bar && bar.style.display !== 'none'),
      barText: (bar && $('bind-bar-text')) ? String($('bind-bar-text').textContent || '') : '',
      barAttrs: bar ? {
        showing: bar.getAttribute('data-bind-showing'),
        count: bar.getAttribute('data-bind-count'),
        state: bar.getAttribute('data-bind-state'),
        active: bar.getAttribute('data-bind-active'),
        files: bar.getAttribute('data-bind-files'),
        pending: bar.getAttribute('data-bind-pending'),
        unconverted: bar.getAttribute('data-bind-unconverted'),
        lastSyncAt: bar.getAttribute('data-bind-last-sync'),
        binding: bar.getAttribute('data-bind-binding'),
        added: bar.getAttribute('data-bind-added'),
        modified: bar.getAttribute('data-bind-modified')
      } : null,
      probe: probe ? { project: probe.project, dryRun: probe.dryRun === true, bindings: probe.bindings || [], sync: probe.sync || [] } : null,
      lastSync: lastSync,
      lastSyncWhy: lastSyncWhy,
      readings: lastReadings,
      banner: { shown: bindBannerShown(), text: bannerText },
      preview: {
        shown: previewShown(),
        target: previewTarget,
        busy: previewBusy,
        error: previewError,
        plan: previewPlan
      }
    };
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
