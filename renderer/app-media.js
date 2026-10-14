/* ============================================================
 * AI MindMap — 图片灯箱 / 文件预览 / 相关知识点（app-media.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 图片灯箱：双击放大 + 滚轮缩放（openLightbox / closeLightbox / lightboxZoom）
 *   2) 附件预览：md 内渲染、pdf 内嵌 iframe、其他交系统打开
 *      （attachmentAbsPath / openFilePreview / closeFilePreview）
 *   3) 相关知识点渲染 renderRelated（我引用谁 + 谁引用我，点击开新详情框）
 * 边界（本文件不负责）：
 *   · 详情框本身的创建/定位 → app-detail*.js（本文件只经 MM 转发 showDetail）
 *   · 项目切换/搜索等数据操作 → app-actions.js
 *   · 灯箱与预览层的事件接线在 app.js 的 wireUI() 中
 * 所有搬迁的函数体与拆分前逐字相同；本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const $ = MM.$;
  const state = MM.state;

  /* ================= 图片灯箱（双击预览 + 滚轮缩放） ================= */
  let lightboxScale = 1;

  function openLightbox(src) {
    const img = $('#lightbox-img');
    img.src = src;
    lightboxScale = 1;
    img.style.transform = 'scale(1)';
    $('#lightbox').style.display = 'flex';
  }

  function closeLightbox() {
    $('#lightbox').style.display = 'none';
  }

  function lightboxZoom(delta) {
    lightboxScale = Math.min(8, Math.max(0.2, lightboxScale * (delta < 0 ? 1.15 : 1 / 1.15)));
    $('#lightbox-img').style.transform = 'scale(' + lightboxScale + ')';
  }

  /* ================= 文件预览（md/pdf 内预览，其他系统打开） ================= */
  function attachmentAbsPath(rel) {
    // state.project.file = 项目 JSON 绝对路径；附件在项目目录下
    if (!state.project || !state.project.file) return null;
    const base = state.project.file.replace(/[\\/][^\\/]+$/, '');
    return base + '/' + rel.split('/').join('/');
  }

  /* PDF 缩放：Chromium viewer 的 `#zoom=` **只在设置 src 那一刻生效** ——
   * 所以「换模式」与「预览框尺寸变化」两条路都必须重设 src，否则"页宽"永远按打开时的宽度算
   * （实测症状：把预览框放大后，页面仍按旧宽度排版、右边被裁）。
   * 重设 src 会回到第 1 页并丢滚动位置，故只在宽度**实质变化**（>24px）时才重设。 */
  const pdfView = { abs: '', mode: 'page-width', lastW: 0, applied: '' };

  function setPdfSrc() {
    const el = $('#fp-pdf');
    if (!el) return;
    if (!pdfView.abs) {
      pdfView.applied = '';
      el.removeAttribute('src');
      el.src = 'about:blank';
      return;
    }
    const url = 'file://' + pdfView.abs + '#zoom=' + pdfView.mode;
    if (pdfView.applied === url) return;          // 同一 URL 不重复加载（打开同页 PDF 时不闪）
    pdfView.applied = url;
    // ⚠️ 只改 URL 的 hash 属"**同文档导航**"：Chromium 的 PDF 查看器不会重新读 `#zoom`，
    // 于是三个缩放按钮点了毫无反应（用户反馈"只有打开文件夹/系统打开能用"）。
    // 实测取证：直接把 src 换成同 URL 异 hash —— iframe **不触发 load**、视图不变。
    // 所以要"先卸载（about:blank）再挂上"，这才是真正的重新导航。
    el.removeAttribute('src');
    el.src = 'about:blank';
    setTimeout(() => { el.src = url; }, 0);
  }

  function syncZoomButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#fp-zoom .fp-zoom-btn'), (b) => {
      b.classList.toggle('on', b.dataset.zoom === pdfView.mode);
    });
  }

  /** 接线只绑一次（工程规矩：渲染层反复重建，监听器不能在每次打开预览时累积） */
  function bindPdfControls() {
    if (bindPdfControls.done) return;
    bindPdfControls.done = true;
    const zoom = $('#fp-zoom');
    if (zoom) {
      zoom.addEventListener('click', (e) => {
        const b = e.target.closest ? e.target.closest('.fp-zoom-btn') : null;
        if (!b || !pdfView.abs) return;
        pdfView.mode = b.dataset.zoom;
        syncZoomButtons();
        setPdfSrc();
      });
    }
    // ✕ 关闭：此前**从未接线**（机械扫描：19 个带 id 的按钮里只有它是"代码里找不到任何引用"的），
    // 用户只能靠 Esc 关预览。现在补上，并按惯例交给唯一入口 closeFilePreview。
    const close = $('#fp-close');
    if (close) {
      close.addEventListener('click', () => { if (MM.closeFilePreview) MM.closeFilePreview(); });
    }
    let timer = null;
    window.addEventListener('resize', () => {
      if (!pdfView.abs || $('#file-preview').style.display === 'none') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const w = $('#file-preview').getBoundingClientRect().width;
        if (Math.abs(w - pdfView.lastW) < 24) return;
        pdfView.lastW = w;
        setPdfSrc();
      }, 260);
    });
  }

  function openFilePreview(node, rel) {
    if (!node || !rel) return;
    const f = (node.files || (node.data && node.data.files) || []).find((x) => x.file === rel);
    const caption = (f && f.caption) || rel;
    const name = String(rel).split('/').pop();
    const ext = name.split('.').pop().toLowerCase();
    $('#fp-title').textContent = name;
    $('#fp-caption').textContent = caption;
    const abs = attachmentAbsPath(rel);
    $('#fp-open').onclick = null;
    $('#fp-open').onclick = () => { window.desktop.app.openFile(abs || rel); };
    // 节点带本机文件夹（localPath）时给一个直达按钮 —— 把"附件预览"与"文件夹链接"两件事接起来
    const lp = node.localPath || (node.data && node.data.localPath) || '';
    const fbtn = $('#fp-folder');
    if (fbtn) {
      fbtn.style.display = lp ? 'inline-block' : 'none';
      fbtn.onclick = lp ? () => { if (MM.openLocalPath) MM.openLocalPath(lp); } : null;
    }
    bindPdfControls();
    if (ext === 'md' || ext === 'markdown') {
      $('#fp-zoom').style.display = 'none';
      $('#fp-pdf').style.display = 'none';
      $('#fp-pdf').src = 'about:blank';
      pdfView.abs = '';
      $('#fp-md').style.display = 'block';
      $('#fp-md').innerHTML = '<span class="placeholder">正在读取…</span>';
      $('#file-preview').style.display = 'flex';
      (abs ? window.desktop.app.readFile(abs) : Promise.reject(new Error('无项目路径')))
        .then((res) => {
          // IPC `app:read-file` 解析为 **{ok, text}**（失败也是 resolve，不 reject）。
          // 曾直接把它当字符串用 → markdownToHtml({ok,text}) 产出 "<p>[object Object]</p>"，
          // 而且 .catch 分支永远不会因"读取失败"触发。故这里必须解构并判 ok。
          const ok = res && res.ok;
          const text = res && typeof res.text === 'string' ? res.text : '';
          if (!ok) {
            // 主进程失败时返回 { ok:false, err: '<原因>' }（键名是 err，不是 error）
            const msg = (res && (res.err || res.error)) || '未知错误';
            $('#fp-md').innerHTML = '<span class="placeholder">读取失败：' + escHtml(String(msg)) + '</span>';
            return;
          }
          $('#fp-md').innerHTML = window.MMConvert.markdownToHtml(text) || '<span class="placeholder">（空文件）</span>';
        })
        .catch((err) => {
          $('#fp-md').innerHTML = '<span class="placeholder">读取失败：'
            + escHtml(err && err.message ? err.message : String(err)) + '</span>';
        });
    } else if (ext === 'pdf') {
      $('#fp-md').style.display = 'none';
      $('#fp-md').innerHTML = '';
      $('#fp-pdf').style.display = 'block';
      $('#file-preview').style.display = 'flex';
      // 默认「页宽」（Chromium viewer 支持 #zoom=page-width|page-fit|<数字>）。
      // 不加 #zoom 时 viewer 按 100% 显示，大画布上也只是一小页（用户反馈过）。
      // `lastW` 记下当前预览框宽度，供 resize 时判断"是否真的需要重排"。
      pdfView.abs = abs || '';
      pdfView.mode = 'page-width';
      pdfView.lastW = $('#file-preview').getBoundingClientRect().width;
      $('#fp-zoom').style.display = 'inline-flex';
      syncZoomButtons();
      setPdfSrc();
    } else {
      // 其他类型：系统默认应用打开（XMind 附件交互模式）
      if (abs) window.desktop.app.openFile(abs);
      else setStatus('无法打开附件（缺少项目路径）');
    }
  }

  function closeFilePreview() {
    $('#file-preview').style.display = 'none';
    $('#fp-pdf').src = 'about:blank';
    $('#fp-md').innerHTML = '';
    // 清掉 PDF 会话状态：否则关掉预览后 resize 仍会去重设一个已经关掉的 iframe
    pdfView.abs = '';
    pdfView.lastW = 0;
    pdfView.applied = '';        // 下次打开同一份 PDF 必须重新导航（否则沿用旧 #zoom 不刷新）
    const zoom = $('#fp-zoom');
    if (zoom) zoom.style.display = 'none';
  }

  /* ================= 相关知识点渲染（我引用谁 + 谁引用我；点击开新详情框） ================= */
  function renderRelated(el, r) {
    const items = (r && r.items) || [];
    const arrow = (d) => (d === 'out' ? '→' : d === 'in' ? '←' : '↔');
    const tip = (d) => (d === 'out' ? '本节点引用它' : d === 'in' ? '它引用本节点' : '互相引用');
    if (!items.length) {
      el.innerHTML = '<div class="bl-title">相关知识点</div><div class="bl-item">（暂无相关知识点）</div>';
      return;
    }
    let html = '<div class="bl-title">相关知识点（' + items.length + '）</div>';
    items.forEach((x) => {
      const ext = x.project && x.project !== state.project.name;
      html += '<div class="bl-item" data-node="' + escHtml(x.node) + '" data-project="' + escHtml(x.project || '') + '"'
        + ' title="' + escHtml(tip(x.dir)) + '">'
        + '<span class="bl-dir">' + arrow(x.dir) + '</span>'
        + escHtml(x.topic)
        + (x.caption ? ' <span class="bl-caption">— ' + escHtml(x.caption) + '</span>' : '')
        + (ext ? ' <span class="bl-caption">[' + escHtml(x.project) + ']</span>' : '')
        + '</div>';
    });
    el.innerHTML = html;
    el.querySelectorAll('.bl-item[data-node]').forEach((item) => {
      item.addEventListener('click', () => {
        const p = item.dataset.project;
        const nid = item.dataset.node;
        /* ⚠️ 这一跳**只有一个实现**：`MM.followNodeRef`（`renderer/app-actions.js`）——
         *   同项目 ⇒ 选中 + 展开祖先链 + **把目标带进视野**（视野外时点一下才有反应），**不切项目**；
         *   跨项目 ⇒ 既有 `switchProject`。
         *   为什么不在调用点写分支（★真实事故）：这里曾手抄一份"同项目就 selectNode"，而**没有**
         *   滚到目标 ⇒ 目标在视野外时点了"什么都没发生"（与 `comnet` 47 死链同一种观感）；
         *   而详情框/关联页/审计面板各抄一份 ⇒ 三份必然各漂一格 ✗。 */
        if (MM.followNodeRef) { MM.followNodeRef(p, nid); return; }
        // 兜底：只有渲染层没加载 app-actions.js 时才可能走到这里（正常绝不发生）
        setStatus('界面没有 followNodeRef，跳不过去：' + nid, true);
      });
    });
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）——
   * ⚠️ 这里**没有** `switchProject` 的转发了（`R7-0` 起）：「相关知识点」的跳转一律走
   *   `MM.followNodeRef`（唯一实现，见上面那段注释）⇒ 本文件里不再有第二处项目切换入口 ✓ */
  const escHtml = (s) => MM.escHtml(s);
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const showDetail = (node) => MM.showDetail(node);

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.openLightbox = openLightbox;
  MM.closeLightbox = closeLightbox;
  MM.lightboxZoom = lightboxZoom;
  MM.attachmentAbsPath = attachmentAbsPath;
  MM.openFilePreview = openFilePreview;
  MM.closeFilePreview = closeFilePreview;
  MM.renderRelated = renderRelated;
})();
