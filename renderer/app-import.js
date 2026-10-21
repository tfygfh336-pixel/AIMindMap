/* ============================================================
 * AI MindMap — 把文件拖进窗口 ⇒ 导入成新项目（app-import.js，功能 5a 的拖拽入口）
 * ------------------------------------------------------------
 * 与菜单入口的关系：**两条入口、一个实现** —— 真正干活的是主进程的 `app:import-doc`
 * （菜单走 `importDocDialog`，拖拽走这里，两者最后都调 `importDocToNewProject` ✓）。
 * 本文件只做三件事：显示投放提示、取到文件路径、把结果如实说出来（失败也要说清 ✗不静默）。
 *
 * ⚠️ 取路径必须走 `desktop.app.pathForFile()`：Electron ≥32 起 `File.path` 已被移除，
 *    而 `webUtils` 只有 preload 能拿到 —— 这是"渲染层拿不到路径"这个坑的唯一正解 ✓。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});
  const OK_EXT = ['.md', '.markdown', '.txt', '.text', '.docx', '.pdf'];
  const OVERLAY_ID = 'mm-drop-hint';
  let overlay = null;
  let busy = false;

  function hint(text, tone) {
    if (MM.setStatus) MM.setStatus(text, tone === 'err');
    else console.log('[import] ' + text);
  }

  function showOverlay(name) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.className = 'mm-drop-hint';
      document.body.appendChild(overlay);
    }
    overlay.textContent = name
      ? ('松手即导入为新项目：' + name)
      : '松手即把文件导入为新项目（.md / .txt / .docx）';
    overlay.style.display = 'flex';
  }

  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }

  /** 支持的扩展名判据（不认识 ⇒ 说清楚，**不要**让导入悄悄失败 ✗） */
  function extOf(name) {
    const m = String(name || '').toLowerCase().match(/\.[^.\\/]+$/);
    return m ? m[0] : '';
  }

  /* ================= `r26`：拖目录 ≠ 不认识的格式（判据是**文件系统事实**，不是文件名） =================
   * 修前实测：`extOf()` 的输入只有文件名字符串 ⇒ 目录算出的 ext 是空串 ⇒ 走进「暂不支持 这种 格式」；
   * 而**无扩展名的文件**（`README`）得到**一字不差**的答复 ⇒ 两件事被混成了一件 ✗。
   * 判据只有两个来源，按顺序取：
   *   ① **首选**：`DataTransferItem.webkitGetAsEntry().isDirectory === true`（Chromium 自带的判据）。
   *      ⚠️ **必须在 `drop` 监听里同步取** —— `DataTransferItemList` 在事件返回后失效，挪到 `await`
   *      之后取恒为 `null` ⇒ 修了等于没修，而且**不会有任何报错**（本工程把这叫"失败伪装成没发生"）；
   *   ② **fallback**：问主进程要真判据（`desktop.app.pathKind` → IPC `app:path-kind` →
   *      `fs.statSync().isDirectory()`）。**只有 `ok === true && kind === 'dir'` 才算目录**，
   *      任何失败 / 通道不存在 ⇒ 当文件（与 ① "取不到就当文件"同一条口径）。
   * 三条否定式（防的就是"改了个措辞"）：
   *   ⓐ **禁止** `!ext ⇒ 目录` —— `README` 是实测反例（无扩展名的**文件**）；
   *   ⓑ **禁止** `f.size === 0 ⇒ 目录` —— 空 `README` / 空 `.md` 同样是 0 字节；
   *   ⓒ **禁止** 只改文案不改判据 —— 那样 `README` 也会被告知"这是目录"。
   * 判别力由 `tests/import-drop-dir.test.js` 钉住（3 条注入：退回 `!ext` / 删分支 / 把判据挪到
   * `await` 之后 —— 每条都必须红）。 */
  function itemIsDirectory(item) {
    if (!item || typeof item.webkitGetAsEntry !== 'function') return false;
    try {
      const e = item.webkitGetAsEntry();
      return !!(e && e.isDirectory === true);        // 只认 === true（`!!e` 会把文件也读成目录 ✗）
    } catch (err) { return false; }
  }

  /** ② fallback：问主进程要真判据。返回 `'dir'` / `'file'` / `''`（取不到一律 `''` ⇒ 当文件）。 */
  function pathKindOf(api, p) {
    if (!api || typeof api.pathKind !== 'function' || !p) return Promise.resolve('');
    return Promise.resolve()
      .then(() => api.pathKind(p))
      .then((r) => ((r && r.ok === true) ? String(r.kind || '') : ''))
      .catch(() => '');
  }

  /* ---------------- 目录这一档要说的话（**措辞不在渲染层**） ----------------
   * 能拿到真实路径时，把这件事交给产品**既有**的那一条通道
   * （`importDocFile` → `app:import-doc` → CLI `import-project`），由 `src/doc-import.js` 的
   * `directoryMessage()` 说出「这是一个**目录**，不是文件 … 用**整库导入** `import-dir` ✓」，
   * 本文件**原样转述** ⇒ "这是目录"这句判据只有一处实现（本文件里**没有**那句原话，
   * `tests/import-drop-dir.test.js` 会对源码做这一条断言）。
   * ⚠️ 通道拿不到路径时（例如冒烟桩喂的假 `File`）退化成一句**只报告事实 + 指向界面入口**的话，
   * 并**如实说明**取不到 Node 侧原话 —— 不许把那句判据在这里手写一遍 ✗。 */
  const DIR_UI_EXIT = '（界面入口：文件 → 导入文件夹成新项目…（整库，先看预览））';
  const DIR_FACT_ONLY = '拖进来的这一项是**目录**（判据 = 文件系统事实，不是扩展名）：拖拽入口只导入单个文件；';

  function sayDirectory(p) {
    if (!p) {
      hint(DIR_FACT_ONLY + DIR_UI_EXIT
        + '。⚠️ 拿不到这个目录的真实路径 ⇒ 取不到 Node 侧那条判据的原话（`directoryMessage`）', 'err');
      return;
    }
    let pr;
    try { pr = importDocFile(p); } catch (err) { pr = Promise.reject(err); }
    pr.then((r) => {
      const said = String((r && r.error) || '').trim();
      if (r && r.ok) {
        /* 正常不该发生（目录进不来）。真发生了就必须说出来，而不是假装导成功了 ✓ */
        hint(DIR_FACT_ONLY + '而它被当成文件导入了（不该发生）⇒ 请上报这一条。' + DIR_UI_EXIT, 'err');
        return;
      }
      hint((said ? said + ' ' : DIR_FACT_ONLY) + DIR_UI_EXIT, 'err');
    }).catch((err) => {
      hint(DIR_FACT_ONLY + DIR_UI_EXIT + '（取 Node 侧原话失败：' + ((err && err.message) || err) + '）', 'err');
    });
  }

  async function handleFiles(files, opts) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (busy) { hint('正在导入上一个文件，请稍候…', 'err'); return; }
    const api = window.desktop && window.desktop.app;
    const f = list[0];
    const name = f.name || '';
    const p0 = (api && api.pathForFile) ? String(api.pathForFile(f) || '') : '';

    /* ① 目录 ≠ 不认识的格式：**排在 ext 判据之前**（否则目录永远先撞上"暂不支持" ✗）。
     *    `opts.dirItem` 由 `drop` 监听**同步**算好传进来（那一步没有 await）；没有它才去问主进程。
     *    这一支走的是**同步**路径（`sayDirectory` 只发一次 hint，不 await）⇒ 拖拽当场就能说话 ✓ */
    if (opts && opts.dirItem) {
      const di = (typeof opts.dirIndex === 'number' && opts.dirIndex >= 0) ? opts.dirIndex : 0;
      const df = list[di] || f;
      sayDirectory((api && api.pathForFile) ? String(api.pathForFile(df) || '') : '');
      return;
    }
    if ((await pathKindOf(api, p0)) === 'dir') { sayDirectory(p0); return; }

    /* ② 以下原样不动 */
    const ext = extOf(name);
    if (OK_EXT.indexOf(ext) < 0) {
      hint('暂不支持 ' + (ext || '这种') + ' 格式：目前能导入 .md / .txt / .docx / 带书签的 .pdf'
        + '（无书签的 PDF 与"一个文件多本书"的自动判定是 5b 尚未批准的部分）', 'err');
      return;
    }
    if (!api || !api.importDoc) { hint('导入通道没接上（preload 缺少 desktop.app.importDoc）', 'err'); return; }
    const p = api.pathForFile ? api.pathForFile(f) : '';
    if (!p) { hint('拿不到这个文件的真实路径（Electron 需要 webUtils.getPathForFile）', 'err'); return; }
    busy = true;
    hint('正在导入「' + name + '」…（大文件要几秒）');
    MM.importDocFile(p).then((r) => {
      busy = false;
      if (!r || !r.ok) hint('导入失败：' + ((r && r.error) || '未知错误'), 'err');
      // 成功时主进程会发 app:toast（含项目名），这里不再重复说一遍（状态栏只留一句）
    }).catch((err) => { busy = false; hint('导入失败：' + ((err && err.message) || err), 'err'); });
  }

  /** 供冒烟断言/其它模块调用（**同一条实现**：拖拽入口也走它 ⇒ 断言验的就是真路径 ✓） */
  function importDocFile(filePath) {
    const api = window.desktop && window.desktop.app;
    if (!api || !api.importDoc) return Promise.resolve({ ok: false, error: '没有 desktop.app.importDoc' });
    return Promise.resolve(api.importDoc(filePath));
  }

  function bind() {
    // 必须有 dragover 的 preventDefault，否则 drop 根本不触发（HTML5 的老规矩）
    document.addEventListener('dragover', (e) => {
      const dt = e.dataTransfer;
      if (!dt || Array.prototype.indexOf.call(dt.types || [], 'Files') < 0) return;
      e.preventDefault();
      if (dt.dropEffect) dt.dropEffect = 'copy';
      // 注意：dragover 阶段**拿不到文件名**（浏览器故意不给），所以提示只能泛化 ✓
      showOverlay();
    });
    document.addEventListener('dragleave', (e) => {
      if (e.clientX <= 0 || e.clientY <= 0
        || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) hideOverlay();
    });
    document.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      e.preventDefault();
      hideOverlay();
      /* ⚠️ 目录判据**必须在这一拍（同步）算出来**：`DataTransferItemList` 在事件返回后失效
       *   ⇒ 把它交给 `handleFiles` 里"`await` 之后再取"就等于恒 `false`（修了等于没修，还不报错）。
       *   `dt.files` 不受这个失效影响 ⇒ 路径照旧从 `File` 取（`pathForFile`）✓。
       *   `dirIndex` 与 `dt.files` 逐项对齐（Chromium 的 `items` / `files` 两个列表同序）⇒
       *   混投（文件 + 目录）时也能点名**那一个目录**，而不是把第一个文件说成目录 ✗。 */
      let dirItem = null;
      let dirIndex = -1;
      if (dt.items) {
        const items = Array.prototype.slice.call(dt.items);
        for (let i = 0; i < items.length; i += 1) {
          if (itemIsDirectory(items[i])) { dirItem = items[i]; dirIndex = i; break; }
        }
      }
      /* `handleFiles` 现在是 async（fallback 那一路要问主进程）⇒ 拒绝必须**说出来**，不许静默 ✗ */
      handleFiles(dt.files, { dirItem: dirItem, dirIndex: dirIndex })
        .catch((err) => { hint('拖拽导入失败：' + ((err && err.message) || err), 'err'); });
    });
    // 导入成功后主进程要"打开新项目"：事件在这里接（openProject 是既有能力 ✓）
    // ⚠️ 失败必须**说出来**：`openProject` 是 async，被拒（例如当前项目有未保存改动时的确认被拒）
    //    在旧写法里就是一个静默的 unhandled rejection ✗ —— 实测踩到过：事件到了、项目却没打开，
    //    而界面上一点提示也没有（查了半天）。现在两条路都报出来 ✓
    if (window.desktop && window.desktop.on) {
      window.desktop.on('menu:open-project', (name) => {
        if (!name) return;
        if (!MM.openProject) { hint('导入成功，但界面没有 openProject（打不开新项目）', 'err'); return; }
        Promise.resolve(MM.openProject(name)).then((r) => {
          if (r === false) hint('项目「' + name + '」已创建；当前项目有未保存改动，确认后才会切换过去');
        }).catch((err) => {
          hint('打开新项目「' + name + '」失败：' + ((err && err.message) || err), 'err');
        });
      });
    }
  }

  /* ============================================================
   * 【W13】界面侧导入入口：选文件 / 选目录 → 预览（演练副本上跑既有 --dry-run）→ 真导入（既有 CLI）→ 播报
   * ------------------------------------------------------------
   * **一处实现**：原生菜单两条 + 命令面板两条 = 四条入口，都调 `MM.importIntoMap({kind})`（本段末尾导出）。
   * 这里**不解析 md、不建树、不数"该导几个"** —— 判定与写盘全在 CLI（`import-md` / `import-dir` 两条
   * 既有命令），界面只做四件事：取路径 → 显示主进程转交的 CLI 读数 → 确认后调既有命令 → 把结果说清。
   *
   * 为什么预览必须跑在**演练副本**上（主进程 `app:import-preview`）：那是"预览"与"零写入"能同时成立的
   * 唯一做法 —— 打开这一层时用户的项目**一个字节都没动**，取消也什么都不留（域 43 判据 ② 有逐字节断言）。
   *
   * 视觉**不另造**：预览层复用绑定预览那套类（`.dialog-box` / `.bind-card` / `.bind-plan` / `.bind-hint`），
   * 播报复用 `.mm-banner` + 共用面板渲染器 `MM.renderConcPanel`（与绑定批、并发可见性是同一套 ⇒
   * 点一行跳到那个节点）。没在导入时，这三处全是 `display:none`：不占布局、不进命中测试、工具栏零变化。
   * ============================================================ */
  let impPreview = null;   // 当前预览 {kind, project, parent, parentTopic, files, dir, name, title, stub, preview, copy, error}
  let impBusy = false;     // 正在算预览 / 正在导
  let impLast = null;      // 最近一次**真导入**的结果（播报面板与冒烟断言都读它）
  let impBanner = '';      // 播报 banner 的那一句（断言也读它）

  const impEl = (id) => document.getElementById(id);
  function impCurProject() {
    const st = MM.getState ? MM.getState() : null;
    return (st && st.project && st.project.name) || '';
  }
  /** 路径 → 给人看的名字（只取最后一段，两种分隔符都认） */
  const impNameOf = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || String(p || '');
  /** **落点**：当前选中的节点（没选中 ⇒ 根）。选择器里就要说清"导到哪" ⇒ id 与人话名都要。
   *  ⚠️ 两套"选中"别混：`MM.adapter.getSelected(jm)` = 图上点中的那一个（落点用它）；
   *  `MM.getSelection()` 是**框选/多选**（返回 `{count, ids, groups}` —— 没有 `[0]` ✗，这里按 `ids[0]` 读）。 */
  function impParent() {
    const st = MM.getState ? MM.getState() : null;
    let node = null;
    try {
      node = (st && st.jm && MM.adapter && MM.adapter.getSelected) ? MM.adapter.getSelected(st.jm) : null;
    } catch (e) { node = null; }
    if (!node && st && st.selectedNode) node = st.selectedNode;
    let id = (node && node.id) || '';
    let topic = '';
    if (node) {
      const raw = (node.topic !== undefined && node.topic !== null) ? node.topic : ((node.data && node.data.topic) || '');
      topic = String(raw).replace(/<[^>]*>/g, '').trim();
    }
    if (!id && MM.getSelection) {
      try {
        const s2 = MM.getSelection();
        id = (s2 && Array.isArray(s2.ids) && s2.ids[0]) || '';
      } catch (e) { id = ''; }
    }
    if (!id) return { id: 'root', topic: '根节点' };
    return { id: String(id), topic: topic || String(id) };
  }

  /* ---------- ① 预览浮层（读数全部来自主进程转交的 CLI 报告，界面一个数都不自己算） ---------- */
  function importPreviewShown() {
    const b = impEl('import-preview');
    return !!b && b.style.display !== 'none';
  }
  function openImportPreview(info) {
    impPreview = info;
    const b = impEl('import-preview');
    if (b) b.style.display = 'flex';
    renderImportPreview();
  }
  function closeImportPreview() {
    const b = impEl('import-preview');
    if (b) b.style.display = 'none';
    impBusy = false;
    renderImportPreview();
  }
  /** 预览层**唯一渲染入口**：三个数（新增 / 更新 / 未转换）+ 未转换的**逐条点名** */
  function renderImportPreview() {
    const box = impEl('import-preview-plan');
    const okBtn = impEl('import-preview-ok');
    const what = impEl('import-what');
    const info = impPreview;
    /* 【W12】认出一个库时多说一句（读数来自 CLI 的 `--vault` 报告；**没在导库 ⇒ 这一格 display:none**）。 */
    const vn = impEl('import-vault-note');
    if (vn) {
      const v = (info && info.preview && info.preview.vault) || null;
      vn.style.display = v ? '' : 'none';
      vn.textContent = v
        ? ('这是一个 Obsidian 库：导入会顺带解析 `[[wikilink]]`（接成关联）、frontmatter 标签与别名 —— '
          + '**零 LLM 调用、零 token**（纯本地字符串处理）。断链与同名多篇会逐条点名，且不会写悬空链接。')
        : '';
    }
    if (what) {
      if (!info) what.textContent = '';
      else {
        what.textContent = (info.kind === 'dir'
          ? ('整库导入：「' + impNameOf(info.dir) + '」会镜像成**新项目**「' + (info.name || '（名字等预览给）') + '」')
          : ('导到：项目「' + info.project + '」的节点「' + info.parentTopic + '」下 · 选了 ' + info.files.length + ' 个文件'))
          + (info.stub ? '　⚠ 这一跳是**冒烟脚本化的答案**，不是你亲手选的' : '');
      }
    }
    if (!box) return;
    box.textContent = '';
    box.className = 'bind-plan';
    if (!info) return;
    if (impBusy) {
      box.className = 'bind-plan busy';
      box.textContent = '正在算预览…（在**演练副本**上跑既有 --dry-run 读法：你的项目此刻一个字节都没动）';
      if (okBtn) okBtn.disabled = true;
      return;
    }
    if (info.error) {
      box.className = 'bind-plan err';
      const l = document.createElement('div');
      l.className = 'bind-plan-line';
      l.textContent = '这一步没成：' + info.error;
      box.appendChild(l);
      if (okBtn) okBtn.disabled = true;
      return;
    }
    const pr = info.preview || {};
    const added = (pr.added === null || pr.added === undefined) ? null : pr.added;
    const line = document.createElement('div');
    line.className = 'bind-plan-line';
    line.textContent = '将新增 ' + (added === null ? '？' : added) + ' 个节点 / 更新 ' + (pr.updated || 0) + ' 个 / 未转换 '
      + (pr.unconverted || 0) + ' 条'
      + (pr.addedUnreadable ? ('（另有 ' + pr.addedUnreadable + ' 个文件的读数读不出来 —— **不当成 0**）') : '');
    box.appendChild(line);
    if (pr.updatedNote) {
      const n = document.createElement('div');
      n.className = 'bind-plan-note';
      n.textContent = pr.updatedNote;
      box.appendChild(n);
    }
    if (pr.wouldRefuse) {
      const w = document.createElement('div');
      w.className = 'bind-plan-unconv';
      w.textContent = '⚠ CLI 说这一步会被拒（原话：' + (pr.refuseReason || '未给原因') + '）—— 预览与真跑是**同一份判据**，'
        + '真跑也会被拒；先按上面的原因处理再导。';
      box.appendChild(w);
    }
    /* 【W12】Obsidian 库那一路：读数**全部来自 CLI 的报告**（界面一条都不自己算），
     * 断链/同名/附件没落成**逐条点名**。没开 vault 时这一段一个元素都不建 ⇒ 默认档逐字节不变 ✓ */
    if (pr.vault) {
      const h = document.createElement('div');
      h.className = 'bind-plan-line';
      h.textContent = '📓 认出一个 Obsidian 库' + (pr.vault.auto ? '（目录里有 .obsidian/）' : '')
        + '：' + pr.vault.files + ' 篇笔记 ｜ 链接 ' + pr.vault.linkTotal + ' 条 → 接成关联 ' + pr.vault.linked
        + '（落标题 ' + pr.vault.headingLinks + ' / 带别名 ' + pr.vault.aliasLinks + '）'
        + ' ｜ 断链与认不出 ' + pr.vault.danglingTotal + ' 条'
        + (pr.vault.taggedFiles ? ' ｜ frontmatter 标签 ' + pr.vault.taggedFiles + ' 篇' : '');
      box.appendChild(h);
      if (pr.vault.tags.length) {
        const t = document.createElement('div');
        t.className = 'bind-plan-note';
        t.textContent = '标签会落到那些笔记的节点上（与 --tags 同一套标签机制）：' + pr.vault.tags.join(' / ')
          + (pr.vault.aliases.length ? '；别名（能当链接目标）' + pr.vault.aliases.join(' / ') : '');
        box.appendChild(t);
      }
      const named = []
        .concat(pr.vault.dangling.map((d) => d.file + ' · ' + d.raw + ' —— ' + (d.why || '没接上')))
        .concat(pr.vault.ambiguous.map((d) => d.file + ' · ' + d.raw + ' —— 同名多篇：' + (d.hits || []).join('、')));
      if (named.length) {
        const u = document.createElement('div');
        u.className = 'bind-plan-unconv';
        u.textContent = '没接成关联的 ' + named.length + ' 条（**逐条点名**；一条悬空链接都没写）：';
        box.appendChild(u);
        named.forEach((s) => {
          const it = document.createElement('div');
          it.className = 'bind-plan-unconv';
          it.textContent = '  · ' + s;
          box.appendChild(it);
        });
      }
      if (pr.vault.resourceUnresolved.length || pr.vault.embedNotes.length) {
        const e = document.createElement('div');
        e.className = 'bind-plan-note';
        e.textContent = (pr.vault.embedNotes.length
          ? '笔记嵌入 ' + pr.vault.embedNotes.length + ' 条按"链接"处理（本批不做正文合并）' : '')
          + (pr.vault.resourceUnresolved.length
            ? '；附件/图片 ' + pr.vault.resourceUnresolved.length + ' 条没落成项目内文件（内容按正文保留，没丢）' : '');
        box.appendChild(e);
      }
    }
    if (pr.unconvertedList && pr.unconvertedList.length) {
      const h = document.createElement('div');
      h.className = 'bind-plan-unconv';
      h.textContent = '未转换 ' + pr.unconverted + ' 条（**没有静默跳过**，逐条点名）：';
      box.appendChild(h);
      pr.unconvertedList.forEach((u) => {
        const it = document.createElement('div');
        it.className = 'bind-plan-unconv-item';
        it.textContent = '· ' + (u.name || '（没有名字）') + ' —— ' + (u.how || '') + '：' + (u.reason || '');
        box.appendChild(it);
      });
    } else {
      const n2 = document.createElement('div');
      n2.className = 'bind-plan-note';
      n2.textContent = '未转换 0 条：这批里没有转不了的东西。';
      box.appendChild(n2);
    }
    if (okBtn) okBtn.disabled = false;
  }

  /* ---------- ② 播报（既有 banner 视觉 + 既有面板渲染器；点一行跳到那个节点） ---------- */
  function showImportBanner(text) {
    impBanner = String(text || '');
    const b = impEl('import-banner');
    const t = impEl('import-banner-text');
    if (t) t.textContent = impBanner;
    if (b) b.style.display = 'flex';
  }
  function closeImportBanner() {
    const b = impEl('import-banner');
    if (b) b.style.display = 'none';
  }
  function importBannerShown() {
    const b = impEl('import-banner');
    return !!b && b.style.display !== 'none';
  }
  /** 这次导入动了哪些节点 —— 逐条摆出来（**与绑定播报同一个卡片渲染器**，界面里没有第二套"哪里不一样"） */
  async function showImportPanel() {
    const last = impLast;
    if (!last) { if (MM.setStatus) MM.setStatus('这次导入的读数还没有（先导一次再看）', true); return false; }
    const cc = window.MMConcurrency;
    if (!cc || typeof cc.diffRows !== 'function' || !MM.renderConcPanel) {
      if (MM.setStatus) MM.setStatus('导入播报不可用：渲染层没有加载 src/concurrency.js 或共用面板渲染器', true);
      return false;
    }
    const name = last.project || impCurProject();
    const api = window.desktop && window.desktop.project;
    let data = null;
    if (api && api.peek) {
      // 与绑定播报同一条只读通道（peek 不推进任何基线：探视不该影响保存闸门）
      try { const p = await api.peek(name); data = (p && p.ok && p.data) || null; } catch (e) { data = null; }
    }
    const labels = last.labels || {};
    const sides = [{ label: last.kind === 'dir' ? '新建的项目（导入之后）' : '盘上现状（导入之后）', data: data || {} }];
    const rowsOf = (keys) => cc.diffRows(sides, keys, { labels: labels });
    const nodeKeys = (list) => (Array.isArray(list) ? list.filter((k) => typeof k === 'string' && k.indexOf('node:') === 0) : []);
    const added = nodeKeys(last.addedKeys);
    const mod = nodeKeys(last.modifiedKeys);
    const jump = (key) => {
      const id = key.slice('node:'.length);
      if (MM.jumpToNode) { MM.jumpToNode(id); return; }
      if (MM.setStatus) MM.setStatus('界面没有 jumpToNode，跳不过去：' + id, true);
    };
    const bad = (last.preview && last.preview.unconvertedList) || [];
    return MM.renderConcPanel({
      title: last.kind === 'dir' ? '导入文件夹：这次建出来的节点' : '导入 Markdown：这次加进来的节点',
      meta: '要导的 ' + (last.kind === 'dir' ? ('目录「' + impNameOf(last.dir) + '」')
        : (((last.items || []).length || 0) + ' 个文件'))
        + ' · CLI 读数：成功 ' + (last.kind === 'dir' ? 1 : last.succeeded) + ' / 失败 ' + (last.failed || 0)
        + ' · 下面每一行是**节点**（一个文件会带进它文档里的层级节点）',
      hint: '这一层**只看不写**：点一行只是跳到那个节点（不改数据、不写盘）。"哪些节点变了"由主进程在起 CLI '
        + '前后各读一次项目、用 src/concurrency.js 现算（与差异预览同一个函数）；条数由 CLI 的报告给出 —— '
        + '两个来源不一致时，界面照实分别显示，不合并、不粉饰。',
      groups: [
        { title: '这次**新出现**的节点（' + added.length + ' 个，点一条跳到它）',
          rows: rowsOf(added), empty: '（这次没有新增节点）', onRowClick: jump },
        { title: '这次**内容被改到**的节点（' + mod.length + ' 个）',
          rows: rowsOf(mod), empty: '（这次没有更新已有节点）', onRowClick: jump },
        { title: '**没导进来**的条目（' + bad.length + ' 条，逐条点名；内容都在源文件里，修好可以再导）',
          rows: bad.map((u) => ({ key: 'skip:' + (u.path || u.name), label: (u.name || '（没有名字）') + ' —— ' + (u.how || ''),
            sides: [{ label: u.path || '', text: u.reason || '' }] })),
          empty: '（这批没有转不了的条目）' }
      ],
      buttons: [{ label: '收起', act: 'close-import-broadcast',
        onClick: () => { if (MM.closeConcPanel) MM.closeConcPanel(); } }]
    });
  }

  /* ---------- ③ 一处实现：四条入口都走它 ---------- */
  /** 入口（**唯一实现**）：`{kind:'files'|'dir'}` ⇒ 选 → 预览 → （人确认后）真导入。
   *  ⚠️ 界面**脏**就不导：这是渲染层唯一知道的事（CLI 那一侧看不见"你正在编辑什么"）。
   *  与绑定同步"界面脏就不写"同一条纪律 —— 否则用户随后一保存就撞上冲突，而他不知道是谁动的盘 ✗。 */
  async function importIntoMap(plan) {
    const kind = (plan && plan.kind === 'dir') ? 'dir' : 'files';
    const project = impCurProject();
    if (!project) {
      hint('先打开一个项目，再导入', 'err');
      return { ok: false, error: '没有当前项目' };
    }
    if (MM.isDirty && MM.isDirty()) {
      const msg = '界面有未保存改动：先保存（💾 保存 / Ctrl+S）再导入 —— 导入会改盘，界面脏时不写'
        + '（否则你保存时会撞上冲突）';
      hint(msg, 'err');
      return { ok: false, error: msg };
    }
    const api = window.desktop && window.desktop.app;
    if (!api || !api.importPick || !api.importPreview || !api.importApply) {
      const msg = '导入通道没接上（preload 少了 desktop.app.importPick / importPreview / importApply）';
      hint(msg, 'err');
      return { ok: false, error: msg };
    }
    const par = (kind === 'files') ? impParent() : { id: 'root', topic: '' };
    // 落点在**选择器**里就说清（对话框标题）：导到哪个项目的哪个节点下 / 会新建一个项目
    const where = (kind === 'files')
      ? ('　（导到：' + project + ' → 节点「' + par.topic + '」下）')
      : '　（整库镜像成一个新项目）';
    let pick = null;
    try { pick = await api.importPick(kind, { where: where }); }
    catch (err) { pick = { ok: false, error: (err && err.message) || String(err) }; }
    if (!pick || !pick.ok) {
      if (pick && pick.canceled) { hint('已取消：没有选' + (kind === 'dir' ? '目录' : '文件')); return { ok: false, canceled: true }; }
      const e = (pick && pick.error) || '选择失败';
      hint('选择失败：' + e, 'err');
      return { ok: false, error: e };
    }
    const paths = pick.paths || [];
    const info = {
      kind: kind, project: project, stub: !!pick.stub,
      parent: par.id, parentTopic: par.topic === '' ? '根节点' : par.topic,
      files: (kind === 'files') ? paths : [], dir: (kind === 'dir') ? (paths[0] || '') : '',
      name: '', title: '', preview: null, copy: null, error: ''
    };
    openImportPreview(info);
    const r = await runImportPreview(info);
    return { ok: true, kind: kind, paths: paths, stub: !!pick.stub, preview: r };
  }

  /** 算一次预览（**零写入**：主进程在一份演练副本上跑既有 `--dry-run`，见 main.js 的 app:import-preview） */
  async function runImportPreview(info) {
    const api = window.desktop && window.desktop.app;
    if (!info || !api || !api.importPreview) { if (info) { info.error = '没有预览通道'; renderImportPreview(); } return null; }
    impBusy = true; info.error = '';
    renderImportPreview();
    let r = null;
    try {
      r = await api.importPreview(info.project, (info.kind === 'dir')
        ? { kind: 'dir', dir: info.dir }
        : { kind: 'files', files: info.files, parent: info.parent });
    } catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
    impBusy = false;
    if (!r || !r.ok) {
      info.error = (r && r.error) || '预览失败';
      renderImportPreview();
      hint('预览失败：' + info.error, 'err');
      return null;
    }
    info.preview = r.preview || null;
    info.copy = r.copy || null;
    // 新项目名由**主进程**给（项目名清洗只有一处：main.js 的 sanitizeProjectName）—— 界面不自己造名字
    if (info.kind === 'dir') { info.name = r.project || ''; info.title = info.name; }
    renderImportPreview();
    return r;
  }

  /** **真导入**（人点了「确认导入」）：只调既有 CLI；文件那一路一个坏文件不拖垮整批（部分成功 ✓） */
  async function importConfirm() {
    if (!impPreview || impBusy) return { ok: false, error: '没有可确认的预览' };
    const info = impPreview;
    const api = window.desktop && window.desktop.app;
    if (!api || !api.importApply) {
      info.error = '这个版本没有导入通道（preload 少了 desktop.app.importApply）';
      renderImportPreview();
      return { ok: false, error: info.error };
    }
    // 预览开着的时候人可能又改了东西 ⇒ 确认那一刻**再判一次**脏（同一份纪律，两处都要）
    if (MM.isDirty && MM.isDirty()) {
      info.error = '界面有未保存改动：先保存（💾 保存 / Ctrl+S）再导入（这一步盘上零改动）';
      renderImportPreview();
      hint(info.error, 'err');
      return { ok: false, error: info.error };
    }
    const plan = (info.kind === 'dir')
      ? { kind: 'dir', dir: info.dir, name: info.name, title: info.title }
      : { kind: 'files', files: info.files, parent: info.parent };
    impBusy = true;
    info.error = '';
    renderImportPreview();
    let r = null;
    try { r = await api.importApply(info.project, plan); }
    catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
    impBusy = false;
    if (!r || !r.ok) {
      // 失败也要**看得见**：这条命令的原话照搬（绝不静默）；逐条原因留在预览层里
      if (r && r.preview) info.preview = r.preview;
      if (r && r.items) info.items = r.items;
      info.error = (r && r.error) || '这批全都没导进来（逐条看下面的原因）';
      renderImportPreview();
      const why = (r && r.preview && r.preview.unconvertedList && r.preview.unconvertedList[0])
        ? (' —— 第一条原因：' + r.preview.unconvertedList[0].reason) : '';
      hint('导入失败：' + info.error + why, 'err');
      return { ok: false, error: info.error, result: r };
    }
    impLast = r;
    closeImportPreview();
    const text = impResultText(r);
    showImportBanner(text);
    hint(text);
    await afterImport(r);
    return { ok: true, result: r };
  }

  /** 导入成功后的那一句：数字全部来自 CLI 的读数（界面不自己算），"没导进来的"点明条数 */
  function impResultText(r) {
    const pr = (r && r.preview) || {};
    const addTxt = (pr.added === undefined || pr.added === null) ? '新增数读不出来' : ('新增 ' + pr.added + ' 个节点');
    const unconv = pr.unconverted || 0;
    const head = (r.kind === 'dir')
      ? ('导入完成：新建项目「' + r.createdProject + '」（' + addTxt + '）')
      : ('导入完成：' + r.succeeded + ' / ' + r.items.length + ' 个文件成功（' + addTxt + '）');
    const warn = unconv ? (' · ' + unconv + ' 条没导进来（**逐条点名**，见下面那份面板）') : ' · 没有未转换的条目';
    return head + warn + ' —— 点开看这次加进来的是哪些节点';
  }

  /** 导入之后让新节点出现在导图上：**走既有重读路径**（有脏则拒绝覆盖、世代不一致则丢弃 ⇒ 绝不覆盖人的编辑） */
  async function afterImport(r) {
    if (!r || r.kind === 'dir') return;      // 目录那一路由主进程发 menu:open-project（既有事件，本文件已接）
    if (MM.requestReread) {
      try { await MM.requestReread(); } catch (e) { /* 那条路自己会报；这里不吞成一个假成功 */ }
    }
  }

  /** 读数快照（**只读**；给冒烟断言与排查看"界面这一侧记的是什么"） */
  function importState() {
    const b = impEl('import-banner');
    const pv = impEl('import-preview');
    const bar = impEl('bind-bar');
    const tb = impEl('toolbar');
    return {
      previewShown: importPreviewShown(),
      previewDisplay: pv ? getComputedStyle(pv).display : '',
      previewData: impPreview,
      busy: impBusy,
      bannerShown: importBannerShown(),
      bannerDisplay: b ? getComputedStyle(b).display : '',
      bannerText: impBanner,
      bindBarDisplay: bar ? getComputedStyle(bar).display : '',
      // 「默认档工具栏零变化」的机械读数：我的入口**不进工具栏**（一个元素都不加）
      toolbarImportEls: tb ? tb.querySelectorAll('[id^=import]').length : -1,
      last: impLast ? {
        kind: impLast.kind, succeeded: impLast.succeeded, failed: impLast.failed,
        createdProject: impLast.createdProject || '', project: impLast.project || '',
        addedKeys: impLast.addedKeys || [], modifiedKeys: impLast.modifiedKeys || [],
        preview: impLast.preview || null
      } : null
    };
  }

  /* ---------- 接线（预览层的两个按钮 + 播报的两个按钮 + 遮罩/Esc 关闭） ---------- */
  function bindImportEntry() {
    const ok = impEl('import-preview-ok');
    if (ok) ok.addEventListener('click', () => { importConfirm(); });
    const cancel = impEl('import-preview-cancel');
    if (cancel) cancel.addEventListener('click', () => { closeImportPreview(); });
    const box = impEl('import-preview');
    if (box) box.addEventListener('mousedown', (e) => { if (e.target === box) closeImportPreview(); });
    const bo = impEl('import-banner-open');
    if (bo) bo.addEventListener('click', () => {
      /* 面板渲染是 async ⇒ 失败必须**说出来**：静默的 unhandled rejection 会让"点了没反应"
       * 变成查不出原因的哑弹（本工程把这一类叫"失败伪装成没发生" ✗） */
      Promise.resolve(showImportPanel()).catch((err) => {
        if (MM.setStatus) MM.setStatus('打开导入播报面板失败：' + ((err && err.message) || err), true);
      });
    });
    const bc = impEl('import-banner-close');
    if (bc) bc.addEventListener('click', () => { closeImportBanner(); });
  }

  MM.importIntoMap = importIntoMap;
  MM.importConfirm = importConfirm;
  MM.importPreviewShown = importPreviewShown;
  MM.importPreviewData = () => impPreview;
  MM.importPreviewCancel = closeImportPreview;
  MM.importBannerShown = importBannerShown;
  MM.importBannerText = () => impBanner;
  MM.importCloseBanner = closeImportBanner;
  MM.showImportPanel = showImportPanel;
  MM.importLast = () => impLast;
  MM.importState = importState;
  bindImportEntry();

  MM.importDocFile = importDocFile;
  MM.importHandleFiles = handleFiles;      // 冒烟可直接喂 File 列表
  /* 单测（`tests/import-drop-dir.test.js`）直接验判据本体 —— 它是 `drop` 监听里用的**同一份**实现
   * （导出的是函数引用，不是第二份判断 ⇒ 不构成"两处表达"）✓ */
  MM.importItemIsDirectory = itemIsDirectory;
  MM.importPathKindOf = pathKindOf;
  MM.importExtOk = (n) => OK_EXT.indexOf(extOf(n)) >= 0;
  MM.showDropHint = showOverlay;
  MM.hideDropHint = hideOverlay;
  bind();
})();
