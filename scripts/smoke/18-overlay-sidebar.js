/* ============================================================
 * scripts/smoke/18-overlay-sidebar.js —— 弹窗让位给 DSH 侧边栏 + PDF 缩放控制
 * ------------------------------------------------------------
 * 背景（用户实测"PDF 预览与侧栏打架"）：DSH 侧栏是主进程的 **WebContentsView（原生控件）**，
 * 永远画在网页之上 —— 页面里 z-index 再大也盖不住。原先 `.overlay { inset: 0 }` 让弹窗按
 * **整窗**居中，右缘必然伸到侧栏底下（8 个弹窗同病）。修法：`.overlay` 右侧扣掉
 * `--dsh-sidebar-width`（该变量早就有，JS 在 dsh-sidebar:layout 里写权威值）。
 *
 * 本文件用**直接改 body class + CSS 变量**的方式模拟侧栏布局事件：headless 下不起真的侧栏 view，
 * 而让位逻辑消费的正是这两个东西，所以这样既能判定、又不需要拉起 DSH 运行时。
 * ⚠️ 本文件注释不要写成行内判定标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const settle = 'new Promise(function (r) { setTimeout(r, 260); })';
const SIDE_W = 420;

/** 模拟侧栏布局事件（与 app-core.js 里 dsh-sidebar:layout 的处理一致） */
const sideOn = '(function () { document.body.classList.add("dsh-sidebar-on");'
  + ' document.body.style.setProperty("--dsh-sidebar-width", "' + SIDE_W + 'px"); return true; })()';
const sideOff = '(function () { document.body.classList.remove("dsh-sidebar-on");'
  + ' document.body.style.removeProperty("--dsh-sidebar-width"); return true; })()';

/** 找到带 pdf 附件的节点并打开预览，返回容器与 iframe 的几何 */
const openPdf = `(async () => {
  var jm = window.MMApp.getState().jm;
  var node = null, rel = '';
  Object.keys(jm.mind.nodes || {}).forEach(function (id) {
    var n = jm.mind.nodes[id];
    if (node || !n || !n.data || !n.data.files) return;
    n.data.files.forEach(function (f) { if (!node && /\\.pdf$/i.test(f.file)) { node = n; rel = f.file; } });
  });
  if (!node) return { found: false };
  window.MM.openFilePreview(node, rel);
  await new Promise(function (r) { setTimeout(r, 420); });
  var box = document.getElementById('file-preview');
  var b = box.getBoundingClientRect();
  return { found: true, nodeId: node.id, hasLocalPath: !!(node.data && node.data.localPath),
           left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
           vw: window.innerWidth, boxRight: getComputedStyle(box).right,
           src: String(document.getElementById('fp-pdf').getAttribute('src') || '') };
})()`;

const assertions = [
  {
    name: '弹窗让位：侧栏展开时预览框不伸到侧栏底下，且在可用区域内居中',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      await ctx.exec(sideOn);
      await ctx.exec(settle);
      const r = await ctx.exec(openPdf);
      if (!r.found) return { ok: false, text: '没找到 pdf 附件' };
      const avail = r.vw - SIDE_W;
      const gapL = r.left;
      const gapR = avail - r.right;
      const file = path.join(os.tmpdir(), 'mm-ui-5-sidebar.png');
      try { const img = await ctx.win.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); } catch (e) { /* 截图仅参考 */ }
      return {
        ok: r.right <= avail + 1 && Math.abs(gapL - gapR) <= 3 && /420px/.test(r.boxRight),
        text: '视口=' + r.vw + ' 侧栏=' + SIDE_W + ' 可用=' + avail
          + ' · 预览框 left=' + r.left + ' right=' + r.right + '（右缘须 ≤' + avail + '）'
          + ' · 左右留白=' + gapL + '/' + gapR + ' · 容器 right=' + r.boxRight + ' · 截图 ' + file
      };
    }
  },

  {
    name: '让位覆盖全部弹窗（.overlay 一族）且侧栏折叠后恢复原样',
    run: async (ctx) => {
      const r = await ctx.exec(`(function () {
        var ids = ['edit-dialog', 'image-dialog', 'file-dialog', 'assoc-dialog', 'audit-panel', 'palette', 'lightbox', 'file-preview', 'conc-panel'];
        document.body.style.removeProperty('--dsh-sidebar-width');
        document.body.classList.remove('dsh-sidebar-on');
        var off = ids.map(function (id) {
          var el = document.getElementById(id);
          return el ? getComputedStyle(el).right : 'missing';
        });
        // 展开态读一次（⚠️ 必须在 class 还在时读计算样式：计算值随 class 变化，
        // 先摘 class 再读会读到折叠后的值 —— 我第一版就是这么写错的）
        document.body.classList.add('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '420px');
        var on = ids.map(function (id) {
          var el = document.getElementById(id);
          return el ? getComputedStyle(el).right : 'missing';
        });
        var dlg = document.querySelector('#edit-dialog .dialog-box') || document.querySelector('.dialog-box');
        var dlgMax = dlg ? parseFloat(getComputedStyle(dlg).maxWidth) : null;
        document.body.classList.remove('dsh-sidebar-on');
        document.body.style.removeProperty('--dsh-sidebar-width');
        return { on: on, off: off, dlgMax: dlgMax, vw: window.innerWidth };
      })()`);
      const allOn = r.on.every((v) => /^4[12]\d(\.\d+)?px$/.test(v));
      const allOff = r.off.every((v) => /^0(\.\d+)?px$/.test(v));
      const capOk = r.dlgMax !== null && r.dlgMax <= r.vw - SIDE_W - 32 + 1;
      return {
        ok: allOn && allOff && capOk,
        text: '侧栏展开时 right=' + JSON.stringify(r.on) + ' · 折叠后 right=' + JSON.stringify(r.off)
          + ' · 编辑框 max-width=' + r.dlgMax + 'px（须 ≤ ' + (r.vw - SIDE_W - 32) + '）'
      };
    }
  },

  {
    name: 'PDF 缩放：默认页宽、可切整页/100%（`#zoom=` 只在设 src 时生效，故切换=重设 src）',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var zoom = document.getElementById('fp-zoom');
        var before = document.getElementById('fp-pdf').getAttribute('src') || '';
        var vis = zoom ? getComputedStyle(zoom).display : 'missing';
        var btns = zoom ? Array.prototype.map.call(zoom.querySelectorAll('.fp-zoom-btn'), function (b) {
          return b.dataset.zoom + (b.classList.contains('on') ? '(当前)' : '');
        }) : [];
        var fit = zoom && zoom.querySelector('.fp-zoom-btn[data-zoom="page-fit"]');
        if (fit) fit.click();
        await new Promise(function (r) { setTimeout(r, 220); });
        var after = document.getElementById('fp-pdf').getAttribute('src') || '';
        var onNow = zoom ? Array.prototype.filter.call(zoom.querySelectorAll('.fp-zoom-btn'), function (b) {
          return b.classList.contains('on');
        }).map(function (b) { return b.dataset.zoom; }) : [];
        return { vis: vis, btns: btns, before: before.slice(-30), after: after.slice(-30), onNow: onNow };
      })()`);
      return {
        ok: r.vis !== 'none' && /zoom=page-width$/.test(r.before) && /zoom=page-fit$/.test(r.after)
          && r.onNow.length === 1 && r.onNow[0] === 'page-fit',
        text: '控件显示=' + r.vis + '（flex item 会被块化，故 computed 是 flex 而非 inline-flex）'
          + ' · 按钮=' + JSON.stringify(r.btns)
          + ' · 切换前 src 尾=' + JSON.stringify(r.before) + ' → 切换后=' + JSON.stringify(r.after)
          + ' · 高亮=' + JSON.stringify(r.onNow)
      };
    }
  },

  {
    name: '预览头：节点带 localPath 时出现「🔗 本机」按钮，点击走 openLocalPath',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var btn = document.getElementById('fp-folder');
        if (!btn) return { missing: true };
        var calls = [];
        var orig = window.MM.openLocalPath;
        window.MM.openLocalPath = function (p) { calls.push(p); return orig(p); };
        btn.click();
        await new Promise(function (r) { setTimeout(r, 160); });
        window.MM.openLocalPath = orig;
        window.MM.closeFilePreview();
        return { shown: getComputedStyle(btn).display !== 'none', calls: calls, label: btn.textContent.trim() };
      })()`);
      return {
        ok: r.missing !== true && r.shown === true && r.calls.length === 1 && /^[A-Za-z]:[\\/]/.test(String(r.calls[0])),
        text: '按钮=' + JSON.stringify(r.label || '') + ' 可见=' + r.shown + ' · 点击调用 openLocalPath=' +
          JSON.stringify(r.calls.map((p) => String(p).slice(0, 40)))
      };
    }
  }
];

module.exports = assertions;
