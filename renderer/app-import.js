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

  function handleFiles(files) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (busy) { hint('正在导入上一个文件，请稍候…', 'err'); return; }
    const f = list[0];
    const name = f.name || '';
    const ext = extOf(name);
    if (OK_EXT.indexOf(ext) < 0) {
      hint('暂不支持 ' + (ext || '这种') + ' 格式：目前能导入 .md / .txt / .docx / 带书签的 .pdf'
        + '（无书签的 PDF 与"一个文件多本书"的自动判定是 5b 尚未批准的部分）', 'err');
      return;
    }
    const api = window.desktop && window.desktop.app;
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
      handleFiles(dt.files);
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

  MM.importDocFile = importDocFile;
  MM.importHandleFiles = handleFiles;      // 冒烟可直接喂 File 列表
  MM.importExtOk = (n) => OK_EXT.indexOf(extOf(n)) >= 0;
  MM.showDropHint = showOverlay;
  MM.hideDropHint = hideOverlay;
  bind();
})();
