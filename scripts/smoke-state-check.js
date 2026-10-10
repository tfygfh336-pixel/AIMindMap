#!/usr/bin/env node
/* ============================================================
 * scripts/smoke-state-check.js — 冒烟"域内自收尾"门禁（门禁编号 V2）
 * ------------------------------------------------------------
 * 真实事故（本门禁存在的唯一理由，2026-10-10）：
 *   用户要求"让你重新测试是为了修 bug，不是降低产品要求"，于是按域过滤重跑冒烟
 *   （`SMOKE_ONLY='16,36,37'`）⇒ **12/23**，报文 `点不到 comp-net …→DIV.dialog-box`
 *   与 `命中测试命中圆钮=false（命中=overlay）`。
 *   查下来：域 16 的 `app.addNode('overview')` **顺手打开了**「编辑节点」模态（产品行为，没错），
 *   而 `undo()` 只撤节点、**撤不掉那个框**；"每域隔离"只还原**项目数据文件 + 重开项目**，
 *   DOM 模态不在其中 ⇒ 那个框**跨域存活**、盖住画布 ⇒ 域 36/37 整片假红，
 *   而那两个文件**一行都没改过** ✗。全量跑当时还绿，只是因为后面的域**各自顺手**擦了桌子。
 *
 * 门禁要保的那条纪律（一句话）：
 *   **冒烟断言里凡是"打开会留下浮层/模态"的动作，同一段断言体里必须给出关闭动作**
 *   （或写一条显式豁免 `收尾-豁免: <原因>`，留给"它确实会在别处被关掉且已有运行时判据兜底"的情形）。
 *   关闭动作一律用**共用入口**：`require('../smoke-assertions.js').closeDialogs(ctx)`
 *   （渲染层侧的唯一实现在 `renderer/app-actions.js` 的 `closeAllDialogs`）。
 *
 * 为什么不能只靠运行时判据（`main.js` 的"域开始的干净前置"）：那一层**只在下一个域真的跑**时才触发 ——
 *   单独跑一个漏收尾的域（`SMOKE_ONLY=16`）时它什么都不会说。两层分工：
 *     · 运行时判据 = 兜底（真的漏了，谁也跑不了假绿）；
 *     · 本静态门禁 = 早红（没跑就知道哪一条没写收尾，且**判据本身可单测**）。
 *
 * 判定清单见 `analyze()` 里的 ①…③ 标记（此处刻意不写死条数：写死了就会漂）。
 *
 * 边界（诚实标注，别以为它能包住一切）：
 *   · 它查的是**有没有收尾动作**，查不了"收尾动作到底关没关掉那个东西"
 *     （`closeDialogs` 也可能因为选择器写错而关不掉）—— 那一层靠运行时判据与真机复核；
 *   · 它按**调用点所在的那一段**看（每个 `{ name, run }` 入口为一段）。跨段共享的关闭动作
 *     会被判红 —— 那是有意的：合并成一段、或写明豁免，都比"靠后面的段顺手关"安全 ✗；
 *   · 它**不做重活**：纯文本扫描，不起 Electron、不起服务（判据都是字符串匹配）。
 *
 * 用法：
 *   node scripts/smoke-state-check.js          判红/判绿（挂 `npm run verify` 的 V2 步）
 *   node scripts/smoke-state-check.js --list   打印每一条"打开动作"所在段与它的收尾来源
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SMOKE_REL = 'scripts/smoke';
const SMOKE_ABS = path.join(ROOT, SMOKE_REL);

/* ---------------------------------------------------------------
 * ① 打开动作：调了这些 API 就会**在画布上留下东西**（模态/浮层/面板），而
 *    "每域隔离"收不掉它们（它只还原项目数据文件 + 重开项目）。
 *    词表短而准：只列**已实测**会留下浮层的那些；`showDetail`（浮动详情框）不在列 ——
 *    它是另一类状态，且各域普遍用 `closeAllFloatDetail` 自理，纳进来只会制造噪音 ✗。
 * --------------------------------------------------------------- */
const OPENERS = [
  { token: 'addNode(', leaves: '「编辑节点」模态（app-actions.js 的 addNode 末尾调 MMEditor.editNode）' },
  { token: 'addSiblingNode(', leaves: '「编辑节点」模态（同上）' },
  { token: 'addTopic(', leaves: '「编辑节点」模态（同上）' },
  { token: 'MMEditor.editNode', leaves: '「编辑节点」模态' },
  { token: 'openFilePreview', leaves: '文件预览浮层（#file-preview）' },
  { token: 'openLightbox', leaves: '图片灯箱（#lightbox）' },
  { token: 'openAudit', leaves: '关系审计面板（#audit-panel）' },
  { token: 'openPalette', leaves: '命令面板（#palette）' },
  { token: 'openAssocEditor', leaves: '关联笔记编辑框（#assoc-dialog）' },
  { token: 'openImageDialog', leaves: '图片对话框（#image-dialog）' },
  { token: 'openFileDialog', leaves: '附件对话框（#file-dialog）' }
];

/* ---------------------------------------------------------------
 * ② 收尾动作：这些出现即算"给了收尾"。
 *    第一项是**共用入口**（推荐）；其余是产品自己已有的关闭口 —— 它们都在
 *    `window.MMApp.closeAllDialogs` 内部被调用（见 renderer/app-actions.js），
 *    所以写哪一个都是"走产品自己的路"，只是共用入口最不容易漏 ✗。
 * --------------------------------------------------------------- */
const CLOSERS = [
  { token: 'closeDialogs', kind: '共用入口 closeDialogs(ctx)' },
  { token: 'closeAllDialogs', kind: 'MMApp.closeAllDialogs' },
  { token: 'closeFilePreview', kind: 'MM.closeFilePreview' },
  { token: 'fp-close', kind: '点预览的 ✕（#fp-close）' },
  { token: 'closeLightbox', kind: 'MM.closeLightbox' },
  { token: 'closeAudit', kind: 'MMApp.closeAudit' },
  { token: 'closePalette', kind: 'MMApp.closePalette' },
  { token: 'closeAssocEditor', kind: 'MM.closeAssocEditor' },
  { token: 'closeEditDialog', kind: 'editor.js closeEditDialog（用户点取消那条路）' },
  { token: 'edit-cancel', kind: '点 #edit-cancel（走产品自己的取消路径）' }
];

/** 显式豁免标记（与 V1 的 `判据-豁免:` 同一形状）：写了它就不再判这一段的收尾。
 *  只留给"确实会在别处被关掉、且**已经有运行时判据兜底**"的情形 —— 豁免必须写原因。 */
const EXEMPT = /收尾-豁免:\s*\S/;

/** 从源码里切出"段"：每个 `{ name: …, run: … }` 的断言入口。
 *  纯文本切分（不做语法分析）：从 `name:` 行开始，到下一个同层 `name:` 或文件末为止。
 *  为什么不用 AST：本工程零依赖，而这里要的只是"这一段里有没有那个词" ✓ */
function segmentAssertions(src) {
  const lines = String(src).split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*name:\s*['"`]/.test(l)) starts.push(i); });
  if (!starts.length) return [{ name: '(整份文件)', from: 0, to: lines.length - 1 }];
  return starts.map((s, i) => ({
    name: (lines[s].match(/name:\s*(['"`])([\s\S]*?)\1/) || [])[2] || ('(第 ' + (s + 1) + ' 行起)'),
    from: s,
    to: (i + 1 < starts.length ? starts[i + 1] - 1 : lines.length - 1)
  }));
}

/* ---------------------------------------------------------------
 * ③ 判定（纯函数，便于单测）：给定"一个域文件的源码"，返回问题清单。
 *    口径（**域内接力是允许的，域末必须干净**）：
 *      · 域内断言是**有顺序**的（`{name, run}` 数组），后面的断言读前一条留下的画面是**常态**
 *        （实测：域 08 前四条读的就是第一条打开的审计面板 ⇒ 逐段要求"自己开自己关"会制造一堆
 *        无意义的改动与假红）；
 *      · 真正会**泄漏到下一个域**的只有一种：**域跑完时还有东西开着**。
 *    所以判据是：**最后一个"打开且此后再没关过"的动作，之后必须有收尾动作，或写一条豁免**。
 *    （域内的运行时判据另有一道兜底：main.js 的"域开始的干净前置"——有残留 ⇒ 下一个域判红并点名 ✓） */
function analyzeSource(src) {
  const text = String(src);
  const lines = text.split(/\r?\n/);
  const segs = segmentAssertions(text);
  const exempt = EXEMPT.test(lines.filter((l) => /^\s*(\*|\/\/)/.test(l)).join('\n'));
  if (exempt) return [];
  let dirty = null;   // { seg, from, opens:Set }
  segs.forEach((seg) => {
    const body = lines.slice(seg.from, seg.to + 1).join('\n');
    const opens = OPENERS.filter((o) => body.indexOf(o.token) >= 0);
    if (opens.length) {
      if (!dirty) dirty = { seg: seg.name, from: seg.from + 1, opens: new Set() };
      opens.forEach((o) => dirty.opens.add(o.token + ' → ' + o.leaves));
    }
    if (CLOSERS.some((c) => body.indexOf(c.token) >= 0)) dirty = null;   // 这一条里有收尾 ⇒ 回到干净
  });
  if (!dirty) return [];
  return [{ seg: dirty.seg, from: dirty.from, opens: [...dirty.opens] }];
}

/** 扫全部冒烟域文件（只认 `NN-名字.js`，与 smoke-assertions 同一发现规则） */
function scanAll(dir) {
  const abs = dir || SMOKE_ABS;
  const out = [];
  fs.readdirSync(abs).filter((f) => /^\d+-.+\.js$/.test(f)).sort().forEach((f) => {
    let src;
    try { src = fs.readFileSync(path.join(abs, f), 'utf8'); }
    catch (e) {
      out.push({ file: f, problems: [{ seg: '(整份文件)', from: 0, opens: ['读不出来：' + (e.code || e.message)] }] });
      return;
    }
    out.push({ file: f, problems: analyzeSource(src) });
  });
  return out;
}

function main() {
  const list = process.argv.includes('--list');
  const results = scanAll();
  const bad = results.filter((r) => r.problems.length);
  if (list) {
    results.forEach((r) => {
      if (!r.problems.length) { console.log('  ✓ ' + r.file + '（无打开动作，或有收尾）'); return; }
      r.problems.forEach((p) => console.log('  ✗ ' + r.file + ' :: ' + p.seg
        + '（第 ' + p.from + ' 行起）打开了 ' + p.opens.join('、') + ' —— 这一段里没有收尾动作'));
    });
    console.log('  合计 ' + results.length + ' 个域文件，' + bad.length + ' 个待修');
    return;
  }
  console.log('== 冒烟域内自收尾门禁（V2）==');
  if (!bad.length) {
    console.log('✓ ' + results.length + ' 个冒烟域文件：凡"会留下浮层"的动作都在同一段里给了收尾（或写了豁免）');
    console.log('  （对应的运行时兜底：main.js 的"域开始的干净前置"——域开始时有残留 ⇒ 该域判红并点名 ✓）');
    return;
  }
  console.log('✗ ' + bad.length + ' 个冒烟域文件里，有断言打开了浮层/模态却没写收尾：');
  bad.forEach((r) => r.problems.forEach((p) => {
    console.log('   [未收尾] ' + SMOKE_REL + '/' + r.file + ' :: ' + p.seg + '（第 ' + p.from + ' 行起）');
    console.log('             打开的：' + p.opens.join('；'));
  }));
  console.log('   → 两种修法（二选一）：');
  console.log('     ① 在同一段里给收尾：const mm = require(\'../smoke-assertions.js\');'
    + ' const closed = await mm.closeDialogs(ctx);（并把 closed.n 写进报文）');
  console.log('     ② 若它确实会在别处被关掉，且已有运行时判据兜底：在段内写一行 `收尾-豁免: <原因>`');
  console.log('   为什么必须收尾：模态跨域存活会盖住后面域的画布 —— 实测域 16 一处漏关'
    + ' ⇒ 域 36/37 连锁红 11 条（而那两个文件一行都没改过 ✗）');
  process.exit(1);
}

module.exports = { analyzeSource, segmentAssertions, scanAll, OPENERS, CLOSERS, EXEMPT };

if (require.main === module) main();
