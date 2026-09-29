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
    if (ext === 'md' || ext === 'markdown') {
      $('#fp-pdf').style.display = 'none';
      $('#fp-pdf').src = 'about:blank';
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
      // Chromium 内置 PDF viewer 直接内嵌 file:// PDF（借鉴 Electron Web Embeds）
      $('#fp-pdf').src = abs ? ('file://' + abs) : '';
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
        if (!p || p === state.project.name) {
          // 同项目：选中并开一个详情框（未锁定的框会被复用，锁定框保留）
          const jm = state.jm;
          jm.expand_to_depth(20);
          const nn = jm.get_node(nid);
          if (nn) { jm.select_node(nid); showDetail(nn); }
          else setStatus('节点不在当前视图：' + nid);
        } else {
          switchProject(p, nid);
        }
      });
    });
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const escHtml = (s) => MM.escHtml(s);
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);
  const showDetail = (node) => MM.showDetail(node);
  const switchProject = (name, selectId) => MM.switchProject(name, selectId);

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.openLightbox = openLightbox;
  MM.closeLightbox = closeLightbox;
  MM.lightboxZoom = lightboxZoom;
  MM.attachmentAbsPath = attachmentAbsPath;
  MM.openFilePreview = openFilePreview;
  MM.closeFilePreview = closeFilePreview;
  MM.renderRelated = renderRelated;
})();
