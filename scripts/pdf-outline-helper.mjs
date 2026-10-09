/* scripts/pdf-outline-helper.mjs —— 读 PDF 书签的**独立小进程**（P8 最小切片）
 *
 * 为什么单独一个进程（**这是被工程不变量逼出来的** ✗）：
 *   `cli/commands/*` 有一条硬不变量——**命令体必须同步完成**（scripts/cli-integration.js 的进程内
 *   断言序列依赖它；由 tests/cli-sync-invariant.test.js 静态把守，cli/main.js 还会在运行时报
 *   "CLI 命令未同步完成（Promise 仍是 pending）" ✗）。而 pdf.js 的 getDocument()/getOutline()
 *   是**异步** API ✗ ⇒ 不能在命令体里 await。于是：**主进程同步**（spawnSync）地跑这个小进程，
 *   由它去 await ✓ —— 命令体自己仍然是同步的 ✓✓。
 *
 * 用法：node scripts/pdf-outline-helper.mjs <pdf 路径>
 * 输出：stdout 一行 JSON —— {ok:true, md, pages} 或 {ok:false, error}
 *   （**任何失败都必须是 ok:false + 一句能读懂的原因** ✗ 不许静默 ✓；退出码：成功 0 / 失败 1）
 * 依赖：pdfjs-dist（Apache-2.0，已进 package.json ✓）；Node ≥22.12 的 require(ESM) 也可用，
 *   但这里直接用 import ✓ 更直白。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = process.argv[2];

function out(o, code) { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; }

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
    let doc = null;
    try {
      const buf = fs.readFileSync(path);
      doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    } catch (e) {
      out({ ok: false, error: '这份 PDF 打不开（pdf.js 报：' + ((e && e.message) || e) + '）⇒ 可能是加密或损坏的文件' }, 1);
    }
    if (doc) {
      const outline = await doc.getOutline().catch(() => null);
      if (!outline || !outline.length) {
        out({
          ok: false,
          error: '这份 PDF 没有书签（大纲）：P8 最小切片只做"有书签的 PDF"✓；无书签的字号启发式 / 目录页正则 / '
            + '多书自动判定尚未批准（5b 的其余部分 ✗）⇒ 不猜、不静默降级。出路：① 用带书签的 PDF（多数电子书与官方手册都有）；'
            + '② 先转成 .md/.txt 再导入；③ 把 PDF 目录贴给内置 AI，让它整理成 Markdown 后再导入'
        }, 1);
      } else {
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
        else out({ ok: true, md: md, pages: pages }, 0);
      }
    }
  }
}
