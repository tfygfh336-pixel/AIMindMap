/* ============================================================
 * scripts/smoke/20-preview-buttons.js —— PDF 预览的三个缩放按钮与 ✕ 关闭
 * ------------------------------------------------------------
 * 用户反馈："pdf 预览里除了打开文件夹和系统打开，其他按钮都有问题"。
 * 只读定位到的两处：
 *   ① ✕ 关闭**从未接线**（机械扫描：19 个带 id 的按钮里只有它没有任何引用）；
 *   ② 页宽/整页/100% 接了线，但 `setPdfSrc()` 只改 URL 的 **hash** ——
 *      那是"同文档导航"，Chromium 的 PDF 查看器不会重新读 `#zoom` ⇒ 点了没反应。
 * 判据（都对着"我们自己的可观测契约"，不依赖 PDF 插件真的渲染出来）：
 *   ① 机制取证：直接把 src 换成"同 URL 异 hash" ⇒ iframe **不触发 load**（这就是 ② 的病根）；
 *   ② 三个按钮：点一下要**真正重新导航**（src 先到 about:blank 再到目标）+ 目标带正确的 #zoom；
 *   ③ ✕：点一下预览要关掉。
 * ②③ 的判别力：把修复回退（不经过 about:blank / 不绑 ✕），这两条立刻变红。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const PROBE = 'zz-pdf-probe';
const REL = 'assets/probe.pdf';

/** 一份"够被认成 PDF"的最小文件（PDFium 容错，能打开就够我们验按钮） */
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF', ''
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记录"哪一步抛错"：冒烟的 THREW 只给一句笼统错误，没有步名就很难定位（本轮在这上面花了两轮） */
function tracer() {
  const log = [];
  return {
    log,
    async run(ctx, name, js) {
      try { const v = await ctx.exec(js); log.push(name + '=ok'); return v; } catch (e) {
        log.push(name + '=THREW(' + String(e && e.message).slice(0, 60) + ')');
        return null;
      }
    }
  };
}

function makeFixture(ctx) {
  ctx.runCli(['init', PROBE]);
  ctx.runCli(['add', PROBE, 'root', '--topic', 'PDF 预览探针', '--id', 'pdf-node']);
  const dir = process.env.AI_MINDMAP_PROJECTS_DIR;
  const assets = path.join(dir, PROBE, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'probe.pdf'), MINIMAL_PDF, 'utf8');
}

/** 在页面里装好探针：iframe 的 load 计数 + src 变化轨迹（含是否经过 about:blank） */
const installProbeJs = `(function () {
  var el = document.getElementById('fp-pdf');
  window.__pdfProbe = { loads: 0, trace: [] };
  el.addEventListener('load', function () { window.__pdfProbe.loads++; });
  new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      var v = el.getAttribute('src') || '';
      window.__pdfProbe.trace.push(v.indexOf('about:blank') >= 0 ? 'blank' : (v ? 'url' : 'none'));
    });
  }).observe(el, { attributes: true, attributeFilter: ['src'] });
  return true;
})()`;

const stateJs = `(function () {
  var el = document.getElementById('fp-pdf');
  var p = window.__pdfProbe || { loads: 0, trace: [] };
  var fp = document.getElementById('file-preview');
  return { src: el.getAttribute('src') || '', loads: p.loads, trace: p.trace.slice(-6),
           visible: !!(fp && fp.style.display !== 'none') };
})()`;

// 注意引号：选择器里带 `data-zoom="x"`，外层必须用单引号包，否则渲染层直接 SyntaxError
const clickJs = (sel) => "(function () { var b = document.querySelector('" + sel + "');"
  + ' if (!b) return false; b.click(); return true; })()';

module.exports = [
  {
    name: 'PDF 预览按钮：机制取证（同 URL 异 hash 不会重新加载）+ 三个缩放按钮真重载 + ✕ 能关',
    run: async (ctx) => {
      makeFixture(ctx);
      const T = tracer();
      await ctx.exec('window.MMApp.openProject("' + PROBE + '")');
      await ctx.exec('new Promise(function (r) { setTimeout(r, 400); })');
      // 直接调预览入口：不依赖"数据里真有一个 PDF 附件"
      await T.run(ctx, 'openPreview', '(function () { window.MM.openFilePreview({ files: [{ file: "' + REL + '", caption: "探针 PDF" }] }, "' + REL + '"); return true; })()');
      await ctx.exec('new Promise(function (r) { setTimeout(r, 500); })');
      await T.run(ctx, 'installProbe', installProbeJs);
      const opened = (await T.run(ctx, 'stateOpen', stateJs)) || { src: '', loads: 0, trace: [], visible: false };

      // ① 机制取证：同 URL 只换 hash ⇒ 不许触发 load（正是旧实现的病根）
      await T.run(ctx, 'hashOnly', `(function () {
        var el = document.getElementById('fp-pdf');
        el.src = el.src.indexOf('#zoom=') >= 0 ? el.src.replace(/#zoom=.*$/, '#zoom=page-fit') : el.src + '#zoom=page-fit';
        return true;
      })()`);
      await ctx.exec('new Promise(function (r) { setTimeout(r, 600); })');
      const afterHashOnly = (await T.run(ctx, 'stateHashOnly', stateJs)) || { loads: -1, trace: [] };
      await ctx.exec('window.__pdfProbe.loads = 0; window.__pdfProbe.trace = []; true');

      // ② 三个缩放按钮：都要真重载（经过 about:blank）且带上正确的 #zoom
      const results = [];
      for (const [sel, want] of [['.fp-zoom-btn[data-zoom="page-fit"]', 'page-fit'],
        ['.fp-zoom-btn[data-zoom="100"]', '100'],
        ['.fp-zoom-btn[data-zoom="page-width"]', 'page-width']]) {
        await T.run(ctx, 'click_' + want, clickJs(sel));
        await ctx.exec('new Promise(function (r) { setTimeout(r, 420); })');
        const st = (await T.run(ctx, 'state_' + want, stateJs)) || { src: '', trace: [], loads: -1 };
        results.push({ want: want, src: st.src, trace: st.trace, loads: st.loads,
          hit: st.src.indexOf('#zoom=' + want) >= 0 && st.trace.indexOf('blank') >= 0 });
      }

      // ③ ✕ 关闭
      const closed = await T.run(ctx, 'click_close', clickJs('#fp-close'));
      await ctx.exec('new Promise(function (r) { setTimeout(r, 260); })');
      const afterClose = (await T.run(ctx, 'stateClosed', stateJs)) || { visible: true };

      return {
        ok: opened.visible === true
          && opened.src.indexOf('#zoom=page-width') >= 0            // 默认页宽
          && afterHashOnly.loads === 0                              // 机制取证：hash-only 不重载
          && results.every((r) => r.hit)                            // 三个按钮都真重载且参数正确
          && closed === true && afterClose.visible === false,       // ✕ 真的关掉了
        text: '打开默认 #zoom=page-width=' + (opened.src.indexOf('#zoom=page-width') >= 0)
          + '｜机制取证：同 URL 异 hash 触发的 load 次数=' + afterHashOnly.loads + '（应为 0，正是旧实现失效的原因）'
          + '｜三个按钮 ' + results.map((r) => r.want + '→' + (r.hit ? 'OK' : '✗') + '(trace=' + JSON.stringify(r.trace) + ')').join(' ')
          + '｜✕点击=' + closed + ' 关闭后预览可见=' + afterClose.visible
          + '｜步迹 ' + T.log.join(',')
      };
    }
  }
];
