/* scripts/pdf-outline-helper.mjs —— 读 PDF 的**独立小进程**（P8 书签 / P0 文字层）
 *
 * 为什么单独一个进程（**这是被工程不变量逼出来的** ✗）：
 *   `cli/commands/*` 有一条硬不变量——**命令体必须同步完成**（scripts/cli-integration.js 的进程内
 *   断言序列依赖它；由 tests/cli-sync-invariant.test.js 静态把守，cli/main.js 还会在运行时报
 *   "CLI 命令未同步完成（Promise 仍是 pending）" ✗）。而 pdf.js 的 getDocument()/getOutline()/
 *   getTextContent() 是**异步** API ✗ ⇒ 不能在命令体里 await。于是：**主进程同步**（spawnSync）地跑
 *   这个小进程，由它去 await ✓ —— 命令体自己仍然是同步的 ✓✓。
 *
 * 走的两条路（先书签、后文字层）：
 *   ① `getOutline()` 有书签 ⇒ 书签树 → `#` 标题提纲（P8 最小切片 ✓，顶层多于一个 = 多棵树 ✓）。
 *   ② 没有书签 ⇒ **回退到文字层**（P0 ✓）：逐页 getTextContent() → `src/pdf-text.js` 的纯逻辑
 *      ⇒ 行/段/标题层级 → 同一份 `#` 提纲（建树逻辑仍然只有一处 ✓）。
 *      ⚠️ 两样都拿不到（扫描件 / 一个标题都认不出）⇒ **响亮拒绝**，理由里必须带数字与出路 ✓。
 *
 * 用法：node scripts/pdf-outline-helper.mjs <pdf 路径>
 * 输出：stdout 一行 JSON ——
 *   成功 {ok:true, source:'outline'|'text', md, pages, notes?, stats?}
 *   失败 {ok:false, error}
 *   （**任何失败都必须是 ok:false + 一句能读懂的原因** ✗ 不许静默 ✓；退出码：成功 0 / 失败 1）
 * 依赖：pdfjs-dist（Apache-2.0，已进 package.json ✓）+ src/pdf-text.js（工程内纯函数 ✓）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = process.argv[2];

function out(o, code) { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; }

/** 文字层这条路彻底走不通时的说法：**带数字 + 三条出路**（照 P8 的写法，别只说"不支持" ✗） */
function noTextLayerError(why) {
  return '这份 PDF 没有书签，走文字层也不行：' + why + '。出路：'
    + '① 用带书签的 PDF（多数电子书与官方手册都有）；'
    + '② 先转成 .md/.txt 再导入（`import-project` 支持），或用能导出 Markdown 的工具转一遍；'
    + '③ 把 PDF 目录贴给内置 AI，让它整理成 Markdown 后再导入；'
    + '④ 扫描件（整页是图片）需要 OCR —— 计划里属 P4，尚未实现（见 .review/20261009-PDF方案调研与计划/计划.md）';
}

if (!path) { out({ ok: false, error: '用法: node scripts/pdf-outline-helper.mjs <pdf 路径>' }, 1); }
else {
  let pdfjs;
  try {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    out({ ok: false, error: '读 PDF 需要 pdfjs-dist（已在 package.json 的 dependencies 里）—— 当前加载失败：' + ((e && e.message) || e) }, 1);
  }
  if (pdfjs) {
    const fs = require('node:fs');
    const pdfText = require('../src/pdf-text.js');
    let doc = null;
    try {
      const buf = fs.readFileSync(path);
      doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    } catch (e) {
      out({ ok: false, error: '这份 PDF 打不开（pdf.js 报：' + ((e && e.message) || e) + '）⇒ 可能是加密或损坏的文件' }, 1);
    }
    if (doc) {
      const outline = await doc.getOutline().catch(() => null);

      /* ---------------- ① 有书签：书签树 → 提纲（P8 最小切片） ---------------- */
      if (outline && outline.length) {
        const MAX = 6;
        const mdOf = (items, level) => {
          const lv = Math.min(level || 1, MAX);
          const lines = [];
          (items || []).forEach((it) => {
            const title = String((it && it.title) || '').replace(/\s+/g, ' ').trim();
            if (title) lines.push('#'.repeat(lv) + ' ' + title);
            if (it && it.items && it.items.length) lines.push(mdOf(it.items, lv + 1));
          });
          return lines.filter(Boolean).join('\n');
        };
        const pageOf = async (dest) => {
          try {
            const ref = (typeof dest === 'string') ? await doc.getDestination(dest) : dest;
            if (!ref || !ref[0]) return null;
            return (await doc.getPageIndex(ref[0])) + 1;   // 1 起（对外口径 ✓）
          } catch (e) { return null; }
        };
        const pages = [];
        for (const it of outline) pages.push(await pageOf(it.dest));
        const md = mdOf(outline, 1);
        if (!md) out({ ok: false, error: '这份 PDF 的书签里没有可用标题（都是空标题？）⇒ 请换带文字书签的 PDF，或先转 Markdown' }, 1);
        else out({ ok: true, source: 'outline', md: md, pages: pages }, 0);
      }

      /* ---------------- ② 没有书签：回退到文字层（P0 ✓） ----------------
       * 每页取 viewport（页宽/页高/旋转）与 getTextContent()，剩下的全交给
       * `src/pdf-text.js` 的纯函数（它可以被单测直接喂合成数据 ⇒ 这里只负责"取"）。
       * 任何一页取失败都**响亮报出是第几页**（不许跳过去当没这页 ✗）。
       */
      else {
        const pages = [];
        try {
          for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const vp = page.getViewport({ scale: 1 });
            const tc = await page.getTextContent();
            pages.push({ page: n, width: vp.width, height: vp.height, rotation: vp.rotation, items: tc.items });
          }
        } catch (e) {
          out({ ok: false, error: '这份 PDF 没有书签，取文字层时在第 ' + (pages.length + 1) + ' 页失败（pdf.js 报：'
            + ((e && e.message) || e) + '）⇒ 不能只读一半就建树' }, 1);
        }
        if (pages.length) {
          const r = pdfText.buildOutline(pages);
          if (!r.ok) {
            out({ ok: false, error: noTextLayerError(r.reason) }, 1);
          } else {
            out({
              ok: true, source: 'text', md: r.md,
              // 每个标题在第几页（与书签那条路的 `pages` 同一口径：1 起）—— P2 做页偏移时会用上
              pages: r.headings.map((h) => h.page),
              notes: r.notes,
              stats: r.stats
            }, 0);
          }
        }
      }
    }
  }
}
