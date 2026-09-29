/* ============================================================
 * scripts/smoke/17-ui-polish.js —— 体验四项（2026-09-29 用户反馈）
 * ------------------------------------------------------------
 *   ① 节点标题里的行内 Markdown（`**加粗**`）应**渲染成粗体**，且**绝不写回数据**；
 *   ② 展开状态以数据为准：深层节点默认收起（不再无条件 expand_to_depth(3)）；
 *   ③ 展开/收起按钮要大（原来 jsMind 默认 11×11px，按不准）；
 *   ④ 文件预览（PDF/md）铺满大画布，且 PDF 带 `#zoom=page-width`。
 * 每条都附一条**截图落盘**（$TEMP），便于人眼复核视觉类改动 —— 视觉缺陷靠断言只能挡一半。
 * ⚠️ 本文件里的注释不要写成 `// ①` 这种**行内标记形态**：G9 会把它当成判定条数去数。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const settle = 'new Promise(function (r) { setTimeout(r, 260); })';

/** 截图落盘（headless 下 capturePage 仍出有效帧，见 14-headless-window.js） */
async function shot(ctx, win, name) {
  try {
    const img = await win.webContents.capturePage();
    const file = path.join(os.tmpdir(), 'mm-ui-' + name + '.png');
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch (e) { return '（截图失败：' + (e && e.message) + '）'; }
}

const assertions = [
  {
    name: '① 标题行内 Markdown：**加粗**渲染成 <strong>，数据里仍是原文（不写回 HTML）',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const r = await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        var bold = 0, rawCount = 0, rawKept = 0, sampleId = '', sampleTopic = '', sampleHtml = '';
        Object.keys(jm.mind.nodes || {}).forEach(function (id) {
          var n = jm.mind.nodes[id];
          if (!n) return;
          if (/\\*\\*[^*]+\\*\\*/.test(n.topic || '')) {
            rawCount++;                                   // 数据模型里带字面 ** 的节点
            if (n.topic.indexOf('<strong>') < 0) rawKept++;
          }
        });
        document.querySelectorAll('jmnode').forEach(function (el) {
          if (/<strong>/.test(el.innerHTML)) {
            bold++;
            if (!sampleId) { sampleId = el.getAttribute('nodeid') || ''; sampleHtml = el.innerHTML.slice(0, 60); }
          }
        });
        var node = sampleId && jm.get_node(sampleId);
        sampleTopic = node ? node.topic : '';
        return { bold: bold, rawCount: rawCount, rawKept: rawKept, sampleId: sampleId, sampleTopic: sampleTopic, sampleHtml: sampleHtml };
      })()`);

      // 再补一张**确定性**的截图：自建小树（只有一个 `**加粗**` 子节点，打开即居中），
      // 顺便验证"用户自己编辑标题写 `**x**` 也会变粗"（走 editor 的 update_node 路径）。
      ctx.runCli(['init', 'zz-bold-probe']);
      ctx.runCli(['add', 'zz-bold-probe', 'root', '--topic', '**粗体标题**与普通字', '--id', 'b1']);
      await ctx.exec('window.MMApp.openProject("zz-bold-probe")');
      await ctx.exec(settle);
      // 让视图复位到根（探针树只有 root → b1 两个节点，复位后必然在视口内）——
      // 不复位时节点可能在视口外，裁出来的截图是白的（实测踩过：白图当证据比没图更糟）。
      await ctx.exec('(function(){ try { window.MMApp.resetView && window.MMApp.resetView(); } catch (e) {} })()');
      // 关掉前序断言遗留的遮罩层：它们会盖住截图区域（实测"裁剪出来全白"就是被「编辑节点」弹窗盖住）
      await ctx.exec('Array.prototype.forEach.call(document.querySelectorAll(".overlay"), function (el) { el.style.display = "none"; })');
      await ctx.exec(settle);
      const shot1 = await ctx.exec(`(function () {
        // 按**内容**选元素：第一个 jmnode 是容器根（topic = 项目名），不是我要的加粗节点
        var el = Array.prototype.filter.call(document.querySelectorAll('jmnode'), function (x) {
          return /<strong>粗体标题<\\/strong>/.test(x.innerHTML);
        })[0];
        if (!el) return null;
        var b = el.getBoundingClientRect();
        var onScreen = b.width > 0 && b.x + b.width > 0 && b.y + b.height > 0
          && b.x < window.innerWidth && b.y < window.innerHeight;
        return { hasStrong: /<strong>/.test(el.innerHTML), html: el.innerHTML, onScreen: onScreen,
                 rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
                 crop: { x: Math.max(0, Math.round(b.x - 30)), y: Math.max(0, Math.round(b.y - 16)),
                         width: Math.round(b.width + 60), height: Math.round(b.height + 32) } };
      })()`);
      let file = '（无节点）';
      if (shot1 && shot1.onScreen) {
        try {
          // 用**整页**截图：隐藏窗口下 `capturePage(rect)` 裁出来是空白（实测 387 字节全白），
          // 整页则正常（见 14-headless-window.js）。节点矩形已在上面的 rect 里报出，便于按坐标核对。
          // 隐藏窗口的 capturePage **可能给旧帧**（实测拍到过上一个项目），故这张图只作参考、
          // 不作为判据；判定只认上面的 innerHTML（那才是"节点渲染成什么样"的直接证据）。
          // ⚠️ 不要在这里调 webContents.invalidate()：实测它会让隐藏窗口的 GPU 上下文崩掉
          // （GPU process exited unexpectedly: exit_code=3 → 卡到 SMOKE GUARD TIMEOUT）。
          await new Promise((r) => setTimeout(r, 220));
          const img = await ctx.win.webContents.capturePage();
          file = path.join(os.tmpdir(), 'mm-ui-1-bold.png');
          fs.writeFileSync(file, img.toPNG());
        } catch (e) { file = '（截图失败：' + (e && e.message) + '）'; }
      } else { file = '（节点不在视口内，跳过截图）'; }
      await ctx.exec('window.MMApp.openProject("comnet")');    // 复原
      await ctx.exec(settle);

      return {
        ok: r.rawCount > 0 && r.bold > 0 && r.rawKept === r.rawCount && r.sampleTopic.indexOf('**') >= 0
          && shot1 && shot1.hasStrong === true && shot1.html.indexOf('<strong>粗体标题</strong>') >= 0,
        text: '真实项目：带 ** 的节点=' + r.rawCount + '（未含 HTML=' + r.rawKept + '）· DOM 粗体=' + r.bold
          + ' · 例：' + JSON.stringify(r.sampleTopic.slice(0, 20)) + ' → ' + JSON.stringify(r.sampleHtml.slice(0, 40))
          + ' · 探针渲染=' + JSON.stringify(shot1 ? shot1.html.slice(0, 40) : null)
          + ' 视口内=' + (shot1 ? shot1.onScreen : null) + ' rect=' + JSON.stringify(shot1 ? shot1.rect : null)
          + ' · 参考截图（headless 下可能是旧帧，不作判据）' + file
      };
    }
  },

  {
    name: '② 展开状态以数据为准：深层节点收起、其子节点隐藏（不再无条件展开）',
    run: async (ctx) => {
      // **自带数据**：不依赖前序断言留在沙箱里的展开状态（实测读到过它们的残留，判据会假红）。
      ctx.runCli(['init', 'zz-expand-probe']);
      ctx.runCli(['add', 'zz-expand-probe', 'root', '--topic', 'L1', '--id', 'p1']);
      ctx.runCli(['add', 'zz-expand-probe', 'p1', '--topic', 'L2', '--id', 'p2']);
      ctx.runCli(['add', 'zz-expand-probe', 'p2', '--topic', 'L3', '--id', 'p3']);
      ctx.runCli(['add', 'zz-expand-probe', 'p3', '--topic', 'L4', '--id', 'p4']);
      const norm = ctx.runCli(['expand-depth', 'zz-expand-probe', '--depth', '2']);   // 前两层展开、更深的收起

      await ctx.exec('window.MMApp.openProject("zz-expand-probe")');
      await ctx.exec(settle);
      const r = await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        var vis = function (id) {
          var el = document.querySelector('jmnode[nodeid="' + id + '"]');
          return el ? window.getComputedStyle(el).display !== 'none' : null;
        };
        var visCount = 0, all = 0;
        document.querySelectorAll('jmnode').forEach(function (x) {
          all++;
          if (window.getComputedStyle(x).display !== 'none') visCount++;
        });
        var p2 = jm.get_node('p2'), p3 = jm.get_node('p3');
        return {
          p1: jm.get_node('p1').expanded !== false,
          p2: p2 ? p2.expanded !== false : null,
          p3: p3 ? p3.expanded !== false : null,
          p3Visible: vis('p3'), p4Visible: vis('p4'),
          visCount: visCount, all: all
        };
      })()`);
      await ctx.exec('window.MMApp.openProject("comnet")');   // 复原，别影响后续断言
      await ctx.exec(settle);
      return {
        ok: /改写/.test(String(norm)) && r.p1 === true && r.p2 === true && r.p3 === false
          && r.p3Visible === true && r.p4Visible === false && r.visCount < r.all,
        text: '规范化=' + JSON.stringify(String(norm).slice(0, 40)) + ' · L1/L2/L3 展开=' + r.p1 + '/' + r.p2 + '/' + r.p3
          + ' · L3 可见=' + r.p3Visible + '、L4 隐藏=' + r.p4Visible + ' · 可见 ' + r.visCount + '/' + r.all
      };
    }
  },

  {
    name: '③ 展开/收起按钮够大（≥16px 圆钮，原来 jsMind 默认 11×11px）',
    run: async (ctx) => {
      const r = await ctx.exec(`(function () {
        var els = document.querySelectorAll('jmexpander');
        var out = [], shown = 0;
        els.forEach(function (el) {
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none') return;
          shown++;
          if (out.length < 3) {
            var b = el.getBoundingClientRect();
            out.push({ w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10,
                       fs: cs.fontSize, radius: cs.borderRadius, color: cs.color, bg: cs.backgroundColor, text: el.textContent });
          }
        });
        return { total: els.length, shown: shown, samples: out };
      })()`);
      const s = r.samples[0] || { w: 0, h: 0, fs: '0', radius: '', color: '', bg: '', text: '' };
      const file = await shot(ctx, ctx.win, '3-expander');
      return {
        ok: r.shown > 0 && s.w >= 16 && s.h >= 16 && parseFloat(s.fs) >= 12,
        text: '可见按钮=' + r.shown + '/' + r.total + ' · 实测 ' + s.w + '×' + s.h + 'px 字号=' + s.fs
          + ' 圆角=' + s.radius + ' 文字=' + JSON.stringify(s.text) + ' · 截图 ' + file
      };
    }
  },

  {
    name: '④ 文件预览：大画布（≥60% 视口）+ PDF 铺满 + #zoom=page-width',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var jm = window.MMApp.getState().jm;
        var node = null, rel = '';
        Object.keys(jm.mind.nodes || {}).forEach(function (id) {
          var n = jm.mind.nodes[id];
          if (node || !n || !n.data || !n.data.files) return;
          n.data.files.forEach(function (f) { if (!node && /\\.pdf$/i.test(f.file)) { node = n; rel = f.file; } });
        });
        if (!node) return { found: false };
        window.MM.openFilePreview(node, rel);
        await new Promise(function (r) { setTimeout(r, 500); });
        var box = document.getElementById('file-preview');
        var body = document.getElementById('fp-body');
        var pdf = document.getElementById('fp-pdf');
        var b = box.getBoundingClientRect(), bb = body.getBoundingClientRect(), pb = pdf.getBoundingClientRect();
        var cs = window.getComputedStyle(pdf);
        return { found: true, rel: rel,
                 w: Math.round(b.width), h: Math.round(b.height), vw: window.innerWidth, vh: window.innerHeight,
                 bodyW: Math.round(bb.width), bodyDisplay: window.getComputedStyle(body).display,
                 pdfW: Math.round(pb.width), pdfH: Math.round(pb.height),
                 pdfFlex: cs.flex, pdfW2: cs.width, pdfDisplay: cs.display,
                 srcTail: String(pdf.getAttribute('src') || '').slice(-46) };
      })()`);
      const file = r.found ? await shot(ctx, ctx.win, '4-preview') : '（未打开）';
      const big = r.found && r.w >= r.vw * 0.6 && r.h >= r.vh * 0.6;
      const filled = r.found && r.pdfW >= r.bodyW * 0.95;
      return {
        ok: big && filled && /zoom=page-width/.test(String(r.srcTail)),
        text: r.found
          ? '预览框 ' + r.w + '×' + r.h + '（视口 ' + r.vw + '×' + r.vh + '）· fp-body ' + r.bodyW + '(' + r.bodyDisplay + ')'
            + ' · PDF 框 ' + r.pdfW + '×' + r.pdfH + ' [flex=' + r.pdfFlex + ' width=' + r.pdfW2 + ' display=' + r.pdfDisplay + ']'
            + ' · src 尾=' + JSON.stringify(r.srcTail) + ' · 截图 ' + file
          : '没找到 pdf 附件（comnet 应有 2 个）'
      };
    }
  }
];

module.exports = assertions;
