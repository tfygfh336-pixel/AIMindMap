/* ============================================================
 * scripts/smoke/17-ui-polish.js —— 体验四项（2026-09-29 用户反馈）
 * ------------------------------------------------------------
 *   ① 节点标题里的行内 Markdown（`**加粗**`）应**渲染成粗体**，且**绝不写回数据**；
 *   ② 折叠默认：打开项目**只展开根**（数据说前两层展开也得收起）—— "视图归一、不写数据"；
 *   ③ 展开/收起按钮要大（原来 jsMind 默认 11×11px，按不准）；
 *   ④ 文件预览（PDF/md）铺满大画布，且 PDF 带 `#zoom=page-width`。
 * 每条都附一条**截图落盘**（$TEMP），便于人眼复核视觉类改动 —— 视觉缺陷靠断言只能挡一半。
 * ⚠️ 本文件里的注释不要写成 `// ①` 这种**行内标记形态**：G9 会把它当成判定条数去数。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 冒烟共用工具（收尾纪律与用法见 scripts/smoke-assertions.js 顶部）：本域第 ④ 条会打开文件预览，
// 收尾必须关掉（跨域存活会盖住后面域的命中测试）
const mm = require('../smoke-assertions.js');

const settle = 'new Promise(function (r) { setTimeout(r, 260); })';

/** 沙箱项目 JSON 的**盘上原文**（第 ② 条要判"打开项目不写数据"，只能对着原文比 —— 命令回显是第二份表述）
 *  `AI_MINDMAP_PROJECTS_DIR` 由 main.js 在 --smoke 下指向临时副本；取不到就抛（采不到真值 ⇒ 红） */
function readRaw(name) {
  const dir = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!dir) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到盘上真值');
  return fs.readFileSync(path.join(dir, name, name + '.json'), 'utf8');
}
/** 盘上某节点的展开态：**连键一起**（缺键 = 展开 ⇒ 只查值会把缺键读成"折叠" ✗） */
function expansionOf(name, id) {
  const proj = JSON.parse(readRaw(name));
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (n.id === id) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(proj && proj.data);
  if (!hit) return { found: false };
  return { found: true, hasKey: Object.prototype.hasOwnProperty.call(hit, 'expanded'), value: hit.expanded };
}

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
    name: '② 折叠默认：打开项目**只展开根**（数据说前两层展开也得收起；可见性用 elementFromPoint 判，不用 getComputedStyle）',
    run: async (ctx) => {
      // **自带数据**：不依赖前序断言留在沙箱里的展开状态（实测读到过它们的残留，判据会假红）。
      ctx.runCli(['init', 'zz-expand-probe']);
      ctx.runCli(['add', 'zz-expand-probe', 'root', '--topic', 'L1', '--id', 'p1']);
      ctx.runCli(['add', 'zz-expand-probe', 'p1', '--topic', 'L2', '--id', 'p2']);
      ctx.runCli(['add', 'zz-expand-probe', 'p2', '--topic', 'L3', '--id', 'p3']);
      ctx.runCli(['add', 'zz-expand-probe', 'p3', '--topic', 'L4', '--id', 'p4']);
      // 盘上基线：**故意**让前两层展开（`expand-depth --depth 2` ⇒ p1/p2 = true，见集成 §45）。
      // 这正是"以数据为准"那条旧口径会照单全收的形态；新口径（折叠默认）要求打开项目时把它们收起来。
      const norm = ctx.runCli(['expand-depth', 'zz-expand-probe', '--depth', '2']);
      const rawBefore = readRaw('zz-expand-probe');
      const diskP1Before = expansionOf('zz-expand-probe', 'p1');

      await ctx.exec('window.MMApp.openProject("zz-expand-probe")');
      await ctx.exec(settle);
      const r = await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        /* 可见性判据 = **命中测试**：elementFromPoint(节点中心) 必须命中它自己或它的后代。
         * 为什么不用 getComputedStyle(el).display !== 'none'：那是本工程点名的**盲判据** ——
         * 被父框裁切、被浮层盖住的节点它照样说"可见"（scripts/visibility-judge-check.js 的判据）。
         * 先看 rect：display:none 的节点 rect 是 0×0 ⇒ 直接判不可见（不必进命中测试）；
         * 再排掉视口外（那种情况下 elementFromPoint 会给 null，但那属"没在观察范围内"）。 */
        var visible = function (id) {
          var el = jm.view.e_panel.querySelector('jmnode[nodeid="' + id + '"]');
          if (!el) return null;
          var b = el.getBoundingClientRect();
          if (!(b.width > 0 && b.height > 0)) return false;
          var x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
          var at = document.elementFromPoint(x, y);
          return !!(at && (at === el || el.contains(at) || at.closest('jmnode[nodeid]') === el));
        };
        var visCount = 0, all = 0;
        Array.prototype.forEach.call(jm.view.e_panel.querySelectorAll('jmnode'), function (x) {
          all++;
          if (visible(x.getAttribute('nodeid'))) visCount++;
        });
        var exp = function (id) { var n = jm.get_node(id); return n ? n.expanded !== false : null; };
        return { p1: exp('p1'), p2: exp('p2'), p3: exp('p3'), root: exp('root'),
                 p1Visible: visible('p1'), p2Visible: visible('p2'),
                 p3Visible: visible('p3'), p4Visible: visible('p4'),
                 visCount: visCount, all: all };
      })()`);
      const shotFile = await shot(ctx, ctx.win, '2-collapse-default');
      // "**不写数据**"：打开项目前后，盘上那份必须**逐字节相同**（视图归一不是数据归一）
      const rawAfter = readRaw('zz-expand-probe');
      const diskP1After = expansionOf('zz-expand-probe', 'p1');
      await ctx.exec('window.MMApp.openProject("comnet")');   // 复原，别影响后续断言
      await ctx.exec(settle);
      return {
        ok: /改写/.test(String(norm))
          && r.root === true && r.p1 === false                       // 打开 ⇒ 只展开根（顶层主题被收起）
          && r.p1Visible === true                                    // 被收起的是它的子节点，不是它自己
          && r.p2Visible === false && r.p3Visible === false && r.p4Visible === false
          && r.visCount < r.all && r.visCount <= 2
          && rawAfter === rawBefore                                  // 视图归一**不写盘**
          && diskP1After.value === true && diskP1Before.value === true
          && diskP1After.hasKey === true,
        text: '规范化=' + JSON.stringify(String(norm).slice(0, 36))
          + ' · 打开后 根/顶层主题 p1=' + r.root + '/' + r.p1 + '（须 true/false = 只展开根）'
          + ' · 可见 L1/L2/L3/L4=' + [r.p1Visible, r.p2Visible, r.p3Visible, r.p4Visible].join('/')
          + '（须 true/false/false/false）· 命中测试可见 ' + r.visCount + '/' + r.all
          + ' · 盘上未变=' + (rawAfter === rawBefore)
          + '（盘上 p1 仍 = ' + diskP1After.value + '，键在=' + diskP1After.hasKey + '）'
          + ' · 截图（headless 可能旧帧，仅参考）' + shotFile
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
      // 收尾：本断言把**文件预览**打开了 ⇒ 当场关掉（它跨域存活会盖住后面域的命中测试 ——
      // 实测：不关它 ⇒ 域 18 开始时框架的干净前置收到 file-preview 并判红 ✗）。
      // 顺序刻意放在截图**之后**（截图要的就是"预览打开着"的画面）。
      const closed = await mm.closeDialogs(ctx);
      const big = r.found && r.w >= r.vw * 0.6 && r.h >= r.vh * 0.6;
      const filled = r.found && r.pdfW >= r.bodyW * 0.95;
      return {
        ok: big && filled && /zoom=page-width/.test(String(r.srcTail)),
        text: r.found
          ? '预览框 ' + r.w + '×' + r.h + '（视口 ' + r.vw + '×' + r.vh + '）· fp-body ' + r.bodyW + '(' + r.bodyDisplay + ')'
            + ' · PDF 框 ' + r.pdfW + '×' + r.pdfH + ' [flex=' + r.pdfFlex + ' width=' + r.pdfW2 + ' display=' + r.pdfDisplay + ']'
            + ' · src 尾=' + JSON.stringify(r.srcTail) + ' · 截图 ' + file
            + ' · 收尾关掉的浮层=' + closed.n
          : '没找到 pdf 附件（comnet 应有 2 个）'
      };
    }
  }
];

module.exports = assertions;
