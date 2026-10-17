/* ============================================================
 * AI MindMap — 图片灯箱 / 文件预览 / 相关知识点（app-media.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 图片灯箱：双击放大 + 滚轮缩放（openLightbox / closeLightbox / lightboxZoom）
 *   2) 附件预览：md 内渲染、pdf 内嵌 iframe、其他交系统打开
 *      （attachmentPath / attachmentAbsPath / imageLinkOf / openByChain / openFilePreview / closeFilePreview）
 *      ⚠️ 「路径 → 打开 / 预览」的**判据不在这里**：唯一实现在 `src/path-chain.js`（UMD 纯函数，
 *         零 Electron、零 I/O，可 headless 单测）；本文件只**调**它，出口也只有一个 = 既有 IPC
 *         `app:open-file`（**不新开 IPC 名字**；外部链接出口批只给它多收一个可选参数 `opts.kind`）。
 *         三段式契约与该模块的六条判据见它的文件头。
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
  /* ⭐ 判据的**唯一实现**在 `src/path-chain.js`（UMD 纯函数：零 Electron、零 I/O、可 headless 单测）。
   *   本文件**不许**再拼路径、也不许再判一次"能不能开" —— 那就是第二份判据，必然与它各漂一格
   *   （本工程同类事故的墓志铭就在下面 renderRelated 那段注释里）。
   *   模块缺失 ⇒ **加载期响亮抛错**（不静默退化）；本守卫是渲染层唯一的一处，
   *   其余调用点直接调 `window.MMPathChain.decide`。 */
  if (!window.MMPathChain || typeof window.MMPathChain.decide !== 'function') {
    throw new Error('路径判据模块没加载：src/path-chain.js（renderer/index.html 的 <script> 漏了？）');
  }

  /** 附件（节点 `files[].file`）的判据结果：`{ok, abs, reason, action, code}` */
  function attachmentPath(rel) {
    return window.MMPathChain.decide({ kind: 'attachment', raw: rel, project: state.project });
  }

  /** 旧名字保留，但**只作薄转发**（`MM.attachmentAbsPath` 是既有导出面）：判不了给 null，
   *  与改动前的返回形状一致（改动前只有"没有项目路径"能给 null，现在**任何**不合法都算）。 */
  function attachmentAbsPath(rel) {
    const d = attachmentPath(rel);
    return d.ok ? d.abs : null;
  }

  /** 图片（节点 `images[].file`）的判据结果 + **页面相对地址**（`<img src>` 用的就是这一形态）。
   *  通过 ⇒ `url` 与改动前**逐字节相同**（串由 `src/path-chain.js` 的 `rendererUrlOf` 给，
   *  本文件与 `app-detail-content.js` 都不许自己拼）；不通过 ⇒ `url:null` + 非空 `reason`
   *  —— 调用方据此画"坏引用"提示（改前那是一颗**静默的裂图**）。 */
  function imageLinkOf(project, file) {
    const d = window.MMPathChain.decide({ kind: 'image', raw: file, project: project });
    if (!d.ok) return { ok: false, url: null, reason: d.reason, code: d.code };
    return { ok: true, url: window.MMPathChain.rendererUrlOf(project, file), reason: '', code: '' };
  }

  /* ---------------- 【本批】"打开一个已判过的绝对路径"的唯一入口 ----------------
   * 用户 2026-10-16 的追加要求是：「打开的时候给一个可选项」。**选择与"记住它"都在主进程**：
   * 探测结果、选择弹窗、"上次选的是哪个"（`<userData>/editor-prefs.json`，写盘走既有 `writeFileAtomic`）
   * 全在 `main.js` 那一侧。
   * ⚠️ **渲染层不许留影子状态**：这里**没有** localStorage —— 这不是风格问题，而是冒烟域 50 的
   *   结构断言（"渲染层 0 处 localStorage"）在守的一条规则（本批第一版就是那样被它判红的 ✗）；
   *   那个偏好文件也**只有一个写者**（`main.js`），没有从别处再写一份。
   * 渲染层只做两件事：把可选参数递过去、把主进程**如实回报**的结果显示出来
   * （`jumped:false` + `note` = "只能打开，没跳行" 那种情形，必须让人看见 ✗ 不许静默）。
   */
  function requestOpen(abs, opts) {
    if (!window.desktop || !window.desktop.app || !window.desktop.app.openFile) {
      return Promise.resolve({ ok: false, err: '当前环境不支持打开文件（无主进程通道）' });
    }
    return Promise.resolve(window.desktop.app.openFile(abs, opts || {})).then((r) => {
      const res = r || { ok: false, err: '未知原因' };
      if (res.ok === false) {
        setStatus('打不开：' + (res.err || '未知原因') + '｜' + abs, true);
        return res;
      }
      if (res.note) setStatus(res.note + '｜' + abs, false);
      return res;
    }).catch((err) => {
      const msg = (err && err.message) || err;
      setStatus('打不开：' + msg + '｜' + abs, true);
      return { ok: false, err: msg };
    });
  }

  /** 链的**唯一出口**：既有 IPC `app:open-file`（签名只多收可选参数、**不新增平行通道**）。
   *  ⚠️ 打不开**必须让人看见**（判据 3）：判据不通过显示 `reason`，主进程失败显示 `err` ——
   *  绝不"点了没反应"（本工程反复治过的静默失效类）。
   *  【外部链接出口批】`opts.kind` 把**判据判出来的那一档**原样递给出口（`d.kind`）：
   *  出口据此选"交系统关联"还是"交系统浏览器"。⚠️ 这里**不是**在判，只是把判据的结论搬过去
   *  （取值表过滤仍在主进程用 `pathChain.EXIT_KINDS` 做，本文件不列候选）。 */
  function openByChain(input) {
    const d = window.MMPathChain.decide({
      kind: input.kind, raw: input.raw, project: state.project, force: input.force
    });
    if (!d.ok) { setStatus('打不开：' + d.reason + '｜' + String(input.raw), true); return Promise.resolve(false); }
    if (!window.MM.requestOpen) { setStatus('打开入口没加载：renderer/app-media.js 的 requestOpen', true); return Promise.resolve(false); }
    // 行号：调用方给了就带（详情正文里的 `file:line` 引用走这条），没给就只打开文件。
    return MM.requestOpen(d.abs, { line: input.line, col: input.col, kind: d.kind }).then((r) => r && r.ok !== false);
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
    const decision = attachmentPath(rel);
    $('#fp-open').onclick = null;
    // 「系统打开」= 调用方**明确**要交系统（force）⇒ 判据照走，只把 preview 改判成 system（压不过 reject）
    $('#fp-open').onclick = () => { openByChain({ kind: 'attachment', raw: rel, force: 'system' }); };
    // 节点带本机文件夹（localPath）时给一个直达按钮 —— 把"附件预览"与"文件夹链接"两件事接起来
    const lp = node.localPath || (node.data && node.data.localPath) || '';
    const fbtn = $('#fp-folder');
    if (fbtn) {
      fbtn.style.display = lp ? 'inline-block' : 'none';
      fbtn.onclick = lp ? () => { if (MM.openLocalPath) MM.openLocalPath(lp); } : null;
    }
    bindPdfControls();
    /* 判据不通过 ⇒ **当场显式报错**（判据 3）。改前这里三条分支各按"abs 有没有值"走：
     * md 会显示"读取失败：无项目路径"、pdf 会留下一个**空 iframe**、其余什么都不显示 ⇒
     * 现在三档共用这一处，报的是链给的**具体原因**（逃逸 / UNC / 绝对路径当附件 / 缺项目路径…）。*/
    if (!decision.ok) {
      $('#fp-md').style.display = 'block';
      $('#fp-md').innerHTML = '<span class="placeholder">打不开这个附件：'
        + escHtml(decision.reason) + '</span>';
      $('#fp-pdf').style.display = 'none';
      $('#fp-pdf').src = 'about:blank';
      pdfView.abs = '';
      $('#fp-zoom').style.display = 'none';
      $('#file-preview').style.display = 'flex';
      return;
    }
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
      // 其他类型：系统默认应用打开（XMind 附件交互模式）—— 判据与出口都走链（失败会显示原因）
      openByChain({ kind: 'attachment', raw: rel });
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
  MM.attachmentPath = attachmentPath;      // 判据结果（含 reason）—— 本文件唯一一处向链取判据的入口
  MM.imageLinkOf = imageLinkOf;            // 图片区（app-detail-content.js）用它：判据 + 页面相对地址
  MM.openByChain = openByChain;            // 链的唯一出口（既有 app:open-file，失败必显示原因）
  MM.requestOpen = requestOpen;            // 【本批】"打开一个已判过的绝对路径"的唯一入口（选择与记忆都在主进程）
  MM.openFilePreview = openFilePreview;
  MM.closeFilePreview = closeFilePreview;
  MM.renderRelated = renderRelated;
})();
