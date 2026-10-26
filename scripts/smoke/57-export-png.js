/* ============================================================
 * scripts/smoke/57-export-png.js — 「导出导图 PNG = 渲染整棵树」域
 * ------------------------------------------------------------
 * 用户原话（2026-10-26）：「导出当前导图为 png 功能也有问题，**它是直接截图窗口而不是渲染导图**」。
 *
 * 改前的病（代码可证）：菜单项与 `--export-image` 各写了一份 `expand_to_depth(999)` +
 * `capturePage()`（**不带 rect**）⇒ 只截窗口可视区域 ⇒ 高 20000px 的导图导出来只有窗口那么高。
 * 本域钉的是**可观测副作用**（不是"函数被调过"）：
 *   ① 高树：PNG 的**像素高度** ≥ 整树包围盒高度，且**远大于窗口内容高**（防退回"截图窗口"）；
 *      —— 尺寸从**落盘的 PNG 文件头**里读（内存图对、落盘错也能抓住）
 *   ② 宽树：PNG 的**像素宽度** ≥ 整树包围盒宽度（只按高度算 ⇒ 宽度被裁，这条会红）
 *   ③ 底部内容真的在图上：最低节点的框内**墨占比 > 阈值**（像素证据），
 *      且**树底之外那条带子是空白**（对照组：证明墨确实来自树，不是整幅噪声）
 *      ⚠️ 强度的如实标注：这是"最低节点框内非白像素"的**像素证据**，
 *      **不是 OCR**（没有把底部节点的文字识别出来）—— 文字层面的"在图上"仍属几何+像素推断。
 *   ④ 导出不动用户的窗口：`win.getBounds()` 前后**逐字段相同**（改前的"resize 用户窗口"修法
 *      必须还原；本实现干脆不碰用户窗口，这条照样钉住，防以后有人改成 resize）
 *   ⑤ 上限与守卫：守卫报文仍在（代码里恰一处）—— 这条是静态判据（读 main.js 源码），
 *      因为真跑一次超时要把 G5 拖到 90 s 以上。同一份静态判据也钉「只有一份实现」（细则在
 *      `tests/export-png-single-path.test.js`，那边是纯 node，跑得快）。
 *
 * 夹具怎么来（**不碰真实数据**）：冒烟模式下 `AI_MINDMAP_PROJECTS_DIR` 指向沙箱副本
 * （main.js 模块加载期建的临时根），本域直接往**沙箱**里写两个项目 JSON（域内直写是为了快：
 * 一棵高树要 100+ 个节点，逐个 `ctx.runCli` 每个都要起一个进程），随后用 CLI `validate`
 * 证明这份夹具本身是合法项目（不是"随便写的 JSON"）。
 *
 * 产物：`MM_EXPORT_PNG_DIR`（默认 `%TEMP%/mm-export-png`）下的 PNG —— 可以肉眼看，也可以拿去做
 * 读图证据。冒烟沙箱退出时清空，故产物**故意不写在沙箱里**。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TALL = 'zz-export-png-tall';
const WIDE = 'zz-export-png-wide';
/* 60 个主题 × 2 个子项 ≈ 180 个节点 ≈ 7k px 高（窗口内容高只有 ~800px ⇒ 判别力足够，
 * 而整轮 G5 只多花 ~9 s）。19.7k px 那一档也验过（PNG 19748 高、底部节点墨占比 0.357、
 * 14.0 s），但那一档要 14 s 以上，不适合放进每次 verify 的常跑集 —— 读数留在
 * `.review/20261044-导出PNG/` 的探针记录里。 */
const TALL_THEMES = 45;
const WIDE_DEPTH = 14;       // 一条深度 14 的链 ≈ 6.3k px 宽

function projectsDir() { return process.env.AI_MINDMAP_PROJECTS_DIR || ''; }
/** 产物目录：默认用 `mkdtempSync` 造**唯一名**（并行两轮冒烟不会互相覆盖 —— 判据在
 *  `tests/temp-run-root.test.js`：`scripts/smoke/` 里不许出现固定名的临时**目录**）。
 *  想留住产物做肉眼复核/读图证据时，显式给 `MM_EXPORT_PNG_DIR`。 */
let shotDirCache = '';
function shotDir() {
  if (!shotDirCache) {
    shotDirCache = process.env.MM_EXPORT_PNG_DIR
      || fs.mkdtempSync(path.join(os.tmpdir(), 'mm-export-png-'));
    // 产物路径**打印出来**：默认目录是唯一名（人要知道去哪看）；设了 `MM_EXPORT_PNG_DIR` 就落在那里
    console.log('[smoke] 导出 PNG 产物目录：' + shotDirCache
      + (process.env.MM_EXPORT_PNG_DIR ? '（来自 MM_EXPORT_PNG_DIR）' : '（临时，可整目录删）'));
  }
  fs.mkdirSync(shotDirCache, { recursive: true });
  return shotDirCache;
}

/** 写一份合法项目（`projects/<name>/<name>.json`）到**沙箱**根。id 用 `ID_RE` 允许的字符集。 */
function writeProject(name, data) {
  const root = projectsDir();
  if (!root) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不在冒烟沙箱里，拒绝写项目）');
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const version = (() => { try { return require('../../package.json').version; } catch (e) { return '0.0.0'; } })();
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({
    meta: { name: name, author: '', version: version, formatVersion: 2 },
    format: 'node_tree',
    data: data
  }, null, 2), 'utf8');
}

function node(id, topic, children) {
  return { id: id, topic: topic, expanded: true, children: children || [] };
}

/** 高树：root + N 个主题（每个 2 个子项）—— 竖向远超窗口 */
function tallTree(n) {
  const kids = [];
  for (let i = 1; i <= n; i++) {
    kids.push(node('t-' + i, '第 ' + i + ' 个主题（高树夹具）', [
      node('t-' + i + '-a', '主题 ' + i + ' 的子项 A'),
      node('t-' + i + '-b', '主题 ' + i + ' 的子项 B')
    ]));
  }
  return node('root', '整树导出（高树）', kids);
}

/** 宽树：一条深度 d 的链，每层标题都很长 —— 横向远超窗口 */
function wideTree(d) {
  let cur = node('w-' + d, '第 ' + d + ' 层：最右端的节点（宽度判据的点名对象）');
  for (let i = d - 1; i >= 1; i--) {
    cur = node('w-' + i, '第 ' + i + ' 层：一条很长的标题，用来把整棵树的宽度撑开', [cur]);
  }
  return node('root', '整树导出（宽树）', [cur]);
}

/** 读 PNG 文件头里的真实尺寸（不引任何图像库；判据要"文件里写着"的那个数） */
function pngHeader(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

/** 准备夹具（幂等：已存在就不重写） */
function ensureFixtures(ctx) {
  const tall = path.join(projectsDir(), TALL, TALL + '.json');
  if (!fs.existsSync(tall)) writeProject(TALL, tallTree(TALL_THEMES));
  const wide = path.join(projectsDir(), WIDE, WIDE + '.json');
  if (!fs.existsSync(wide)) writeProject(WIDE, wideTree(WIDE_DEPTH));
  // 夹具合法性：交给**产品自己的校验器**（CLI），不是我们说合法就合法
  const v1 = ctx.runCli(['validate', TALL]);
  const v2 = ctx.runCli(['validate', WIDE]);
  return { v1: String(v1 || '').trim().split('\n').slice(-1)[0], v2: String(v2 || '').trim().split('\n').slice(-1)[0] };
}

/** 准备夹具的**单次**入口（幂等；失败也缓存，避免每条断言各抛一次） */
let readiness = null;
function ready(ctx) {
  if (!readiness) {
    try { readiness = Promise.resolve(ensureFixtures(ctx)); }
    catch (e) { readiness = Promise.reject(e); }
  }
  return readiness;
}

/** 跑一次导出（读数直接带回）。**按 (项目, 标签) 缓存**：三条高树断言看的是**同一次导出**的
 *  同一份产物 —— 重复导出只会把 G5 拖慢，不会让判据更强。 */
const CAPTURES = new Map();
async function runExport(ctx, project, tag) {
  const key = project + '|' + tag;
  if (!CAPTURES.has(key)) {
    CAPTURES.set(key, (async () => {
      await ready(ctx);
      const out = path.join(shotDir(), 'export-' + tag + '.png');
      const r = await ctx.exportMapPng({ project: project, out: out });
      if (r && r.ok) r.fileSize = pngHeader(out);
      return r;
    })());
  }
  return CAPTURES.get(key);
}

const assertions = [
  {
    /* ⚠️ 本条**故意排在第一个**：高树那次导出就发生在 "before → after" 之间，
     * 后面三条高树断言直接复用同一次导出（`runExport` 按标签缓存）⇒ 少开一个离屏窗口、
     * 少截一张 7k px 的图（实测省约 7 s）。若把本条挪到后面，before/after 会变成
     * "导出早已发生" 的两次读数 —— 恒等、但失去判别力（那种绿是假的）。 */
    name: '导出 PNG：用户窗口没被动过（getBounds 前后逐字段相同；导出在离屏窗口里渲染）',
    run: async (ctx) => {
      const before = ctx.win.getBounds();
      const r = await runExport(ctx, TALL, 'tall');
      const after = ctx.win.getBounds();
      const same = ['x', 'y', 'width', 'height'].every((k) => before[k] === after[k]);
      if (!r.ok) return { ok: false, text: '导出失败: ' + r.reason + '（还原判据不适用，这不算绿）' };
      return {
        ok: same,
        text: 'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after)
          + '（导出那次真的撑大了**离屏**窗口：树 ' + r.bbox.w + '×' + r.bbox.h + '）'
          + (same ? '' : '（用户窗口被改了尺寸 ⇒ 必须还原）')
      };
    }
  },
  {
    name: '导出 PNG（高树）：PNG 像素高度 ≥ 整树包围盒高度（整棵树都进图，不是窗口那一条）',
    run: async (ctx) => {
      const fx = await ready(ctx);
      const r = await runExport(ctx, TALL, 'tall');
      if (!r.ok) return { ok: false, text: '导出失败: ' + r.reason + '（夹具校验：' + fx.v1 + '）' };
      const h = (r.fileSize && r.fileSize.height) || 0;
      const winH = ctx.win.getContentBounds().height;
      const ok = h >= r.bbox.h;
      return {
        ok: ok,
        text: 'PNG ' + (r.fileSize ? r.fileSize.width + '×' + r.fileSize.height : '(读不出尺寸)')
          + '｜整树 ' + r.bbox.w + '×' + r.bbox.h + '｜窗口内容高 ' + winH
          + '｜节点 ' + r.nodes + '｜' + r.ms + ' ms｜' + (r.bytes / 1024).toFixed(0) + ' KB'
          + (ok ? '' : '（PNG 比树矮 ⇒ 下面是丢的）')
      };
    }
  },
  {
    name: '导出 PNG（高树）：图高远大于窗口内容高（防退回"截图窗口"那条旧实现）',
    run: async (ctx) => {
      const r = await runExport(ctx, TALL, 'tall');
      if (!r.ok) return { ok: false, text: '导出失败: ' + r.reason };
      const h = (r.fileSize && r.fileSize.height) || 0;
      const winH = ctx.win.getContentBounds().height;
      // 判别力：旧口径的产物高度 == 窗口内容高（1424×835 那一档）；本判据要求至少 1.5 倍
      const ok = h > winH * 1.5;
      return { ok: ok, text: 'PNG 高 ' + h + ' vs 窗口内容高 ' + winH + '（阈值 > ' + Math.round(winH * 1.5) + '）' };
    }
  },
  {
    name: '导出 PNG（高树）：最低节点的框内真有像素（底部内容在图上）· 且树底之外是空白（对照）',
    run: async (ctx) => {
      const r = await runExport(ctx, TALL, 'tall');
      if (!r.ok) return { ok: false, text: '导出失败: ' + r.reason };
      const t = r.bottom.ink || {};
      const o = r.outsideInk || {};
      if (!t.ok) return { ok: false, text: '拿不到底部节点的像素读数: ' + (t.reason || '未知') + '（这不算绿）' };
      if (!o.ok) return { ok: false, text: '拿不到对照带读数: ' + (o.reason || '未知') };
      const INK_MIN = 0.01;    // 框里至少 1% 非白像素：文字/边框/底色任一存在就远超它；纯白 = 0
      const OUT_MAX = 0.01;    // 对照带（树底之下 12px）应当几乎全白
      const ok = t.ink >= INK_MIN && o.ink <= OUT_MAX;
      return {
        ok: ok,
        text: '最低节点「' + r.bottom.topic + '」框 @' + r.bottom.x + ',' + r.bottom.y
          + ' ' + r.bottom.w + '×' + r.bottom.h + ' 墨占比 ' + t.ink.toFixed(4)
          + '｜树底之外 墨占比 ' + o.ink.toFixed(4)
          + '（门槛 ≥' + INK_MIN + ' 且 ≤' + OUT_MAX + '）'
          + '｜⚠️ 强度：这是**像素证据**（框内非白像素），不是 OCR —— 文字层面的"在图上"仍是几何+像素推断'
      };
    }
  },
  {
    name: '导出 PNG（宽树）：PNG 像素宽度 ≥ 整树包围盒宽度（宽度不许只按高度算）',
    run: async (ctx) => {
      const r = await runExport(ctx, WIDE, 'wide');
      if (!r.ok) return { ok: false, text: '导出失败: ' + r.reason };
      const w = (r.fileSize && r.fileSize.width) || 0;
      const winW = ctx.win.getContentBounds().width;
      const ok = w >= r.bbox.w && w > winW;
      return {
        ok: ok,
        text: 'PNG ' + (r.fileSize ? r.fileSize.width + '×' + r.fileSize.height : '(读不出尺寸)')
          + '｜整树 ' + r.bbox.w + '×' + r.bbox.h + '｜窗口内容宽 ' + winW
          + '｜最右节点「' + r.right.topic + '」框 @' + r.right.x + ',' + r.right.y
          + ' 墨占比 ' + (r.right.ink && r.right.ink.ok ? r.right.ink.ink.toFixed(4) : 'n/a')
      };
    }
  },
  {
    name: '导出 PNG：90 s 守卫的报文仍在（代码里恰一处，且离屏入口仍 exit(1)）',
    run: async () => {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
      // 只数**代码行**：注释里提这个报文名是好事（它说明这条守卫为什么在），不该算"第二份实现"
      const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
      const codeHits = src.split('\n').filter((l) => l.indexOf('EXPORT-IMAGE GUARD TIMEOUT') >= 0 && !isComment(l)).length;
      const wired = /onGuardTimeout:\s*\(\)\s*=>\s*app\.exit\(1\)/.test(src);
      return {
        ok: codeHits === 1 && wired,
        text: '代码行里报文 ' + codeHits + ' 处（应恰 1）｜离屏入口接线 ' + (wired ? '在' : '✗ 丢了')
          + '｜说明：真跑一次超时会把 G5 拖过 90 s，故这条只判"守卫还在、且仍能让人退出"'
      };
    }
  }
];

module.exports = assertions;
