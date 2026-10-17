#!/usr/bin/env node
/* ============================================================
 * scripts/encoding-check.js — 文件编码完整性门禁
 * ------------------------------------------------------------
 * 存在理由：本工程第二次全损事故的成因是「用 PowerShell 的
 * Get-Content/Set-Content 读写 UTF-8 文档」——PS 5.1 默认按 GBK 解码，
 * 写回时就把中文变成乱码。事后只在 README 加了一条禁令（散文），
 * 零强制：规则写得再重，也没人能在写坏文件的那一刻被拦住。
 *
 * 本脚本把那条规定变成**结果门禁**。判据清单见代码里的 ①…⑳ 标记
 * （本条刻意不在这里数一遍 —— 条数只有一个权威：`docs/RULES.md` §2 的门禁行，
 *  由 G9 与实现里的标记机械对齐）。任一判据命中即 exit 1。已接入 `npm run verify`。
 *
 * ★ 本脚本会被自己扫描，因此**源码里不允许出现乱码字面量**（特征一律用码点构造，
 *   注释也只描述不举例）—— 否则第一次运行就会把自己报成损坏文件。
 *   这条约束同时也证明了门禁确实在工作：它能抓到自己的输入。
 *
 * ★★ 扫描面（**本文件最容易误读的一处；2026-10-18 按实测订正**）：
 *   它**不是**"扫描全部文本文件"（那句话在本文件里挂了很久，而它从来没做到）。
 *   实际是**两份输入之并**：
 *     (a) **受管文本资产** = `git ls-files --eol` 里 git 自己判为文本（`i/lf` / `i/crlf`）的**跟踪文件**。
 *         **不看扩展名** —— 这样"新增了一种文本资产类型"（例如本次补上的 `.vbs`、
 *         以及根本没有扩展名的 `.gitignore`）**自动纳入**，不需要谁记得去改名单。
 *     (b) **白名单 `TEXT_EXT`** = 只用来覆盖工作树里的**非受管**文件（`.review/` 下的读数转储、临时物）。
 *   白名单之外、又没被跟踪的文件**不扫描**；但每次运行都会把它们的读数**打印出来**
 *   （见输出里的"未扫描"一行）⇒ 边界必须可见，**不许静默**。
 *
 *   ⚠️ 为什么**不**把 `.log` 加进白名单（2026-10-18 实测，读数见
 *      `.review/20261016-门禁边界订正/readings-measure-boundary.log`）：
 *      全仓 181 个 `.log` **100% 未跟踪**、全部落在 `.review/` 下（`.gitignore` 同时忽略
 *      `.review/` 与 `*.log`）⇒ 它们是**运行转储**，不是资产，一个受管资产都覆盖不到
 *      （`.review/` 之外 `.log` 计数 = 0）。而其中 71 个是 PowerShell 重定向写出的 UTF-16LE
 *      （`FF FE` 在 UTF-8 下必然解成 U+FFFD）、另有 30 个 UTF-8 但已含 U+FFFD ⇒
 *      一旦纳入就**立刻永久红 101 个**，而它们全是历史取证转储：**不能重编码**（等于改证据）、
 *      也**不能删**。那会把门禁变成一片假红，与 T5 批的教训同形。
 *   ⇒ **触发条件（什么时候该动这个口径）**：某个白名单外的扩展名**出现了受管实例**时。
 *      受管文本已由 (a) 自动覆盖 ⇒ 真正的信号是"未扫描那行里出现 tracked 文件"或
 *      "该扩展名在 `.review/` 之外出现"。**不要**为了"看起来更全"而扩名单。
 *
 * ★ 能力边界（必须说清，避免误以为它万能）：
 *   1) 它检查的是**损坏的结果**，不是**违规的动作**。只读地误用 Get-Content（不写盘）
 *      不会留下任何痕迹，本脚本无法发现。真正会造成数据损坏的是写入路径，那部分能被抓住。
 *   2) 行尾那条判的是 **index（提交面）**，**不是工作树**。本仓 `core.autocrlf` 是 **system 级 true**
 *      且仓内**没有 `.gitattributes`** ⇒ git checkout 出来的是 CRLF、node 脚本写的是 LF
 *      ⇒ **工作树必然是混合的**（实测 `w/crlf` 11 个、`w/mixed` 1 个）。
 *      所以：**不要以工作树行尾作判据**，也不存在"唯一纯 CRLF 的文件"这种表述。
 *   3) 行尾那条在 `core.autocrlf=true` 下近乎一个**配置漂移哨兵**：`git add` 会按规则把 CRLF
 *      归一成 LF ⇒ 正常路径本来就进不了 CRLF 条目。它能抓到的是**绕过归一**的路径
 *      （`git update-index --cacheinfo` 这类水管提交、`core.autocrlf` 被关掉后提交、
 *      `.gitattributes` 加了 `-text`）。它的价值是让 `docs/RULES.md` 那句口径**可判定**，
 *      而不是假装它拦得住所有行尾问题。
 *
 * 用法：
 *   node scripts/encoding-check.js          检查（有发现则 exit 1）
 *   node scripts/encoding-check.js --list   同时列出每个被检查的文件
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** 不检查的目录：依赖、VCS、可再生产物、本地备份与临时工作区
 *  vendor/ = 打包进应用的第三方运行时（DSH 独立运行包，2.6万文件；
 *  其内容由 scripts/vendor-dsh.js 以哈希清单锁定，编码完整性由该清单负责） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'dist-portable',
  'backups', '.tmp-img', '.tmp-svg', 'vendor'
]);

/** 参与检查的文本扩展名。
 *  ⚠️ 它**只作用于非受管文件**（见文件头"扫描面"）：受管文本不论扩展名一律检查。
 *  二进制文件一律不在内，避免把图片误判为乱码（实测：若按内容嗅探纳进 `.png`，
 *  70 个 PNG 会因为"字节不构成合法 UTF-8"全部变红 —— 那是误判，不是损坏）。 */
const TEXT_EXT = ['.md', '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.txt', '.svg'];

/** 经典乱码特征。命名清楚是为了报错时能直接告诉人「这是怎么坏的」。
 *
 *  ⚠️ 全部用**码点构造**而非字面量：本脚本自身也要被自己扫描（检测器不应污染
 *  自己的输入）。若把这些乱码字面写进源码，第一次运行就会把自己报成损坏文件。 */
const cp = (...codes) => codes.map((c) => String.fromCharCode(c)).join('');
const MOJIBAKE = [
  { name: 'GBK 解码残留（' + cp(0x9539, 0x65A4, 0x62F7) + '）', re: new RegExp(cp(0x9539, 0x65A4, 0x62F7)) },
  { name: '未初始化内存（' + cp(0x70EB, 0x70EB, 0x70EB) + '）', re: new RegExp(cp(0x70EB, 0x70EB, 0x70EB)) },
  { name: '未初始化内存（' + cp(0x5C6F, 0x5C6F, 0x5C6F) + '）', re: new RegExp(cp(0x5C6F, 0x5C6F, 0x5C6F)) },
  {
    name: 'UTF-8 被按 Latin-1 读（' + cp(0x00E2, 0x20AC) + ' / ' + cp(0x00C3) + '）',
    re: new RegExp(cp(0x00E2, 0x20AC) + '|' + cp(0x00C3) + '[\u00a0-\u00bf\u0080-\u009f]')
  }
];

/* ---------------------------------------------------------------
 * 纯函数区（无 I/O —— 单测只打这里，见 `tests/encoding-check.test.js`）
 * --------------------------------------------------------------- */

/** 扫一份 buffer 的编码判据。返回 { bom, fffd, mojibake: [特征名] }。
 *  只看 buffer 本身 ⇒ 可以被单测直接喂字节，不需要造文件。 */
function scanText(buf) {
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  // toString('utf8') 会把非法字节序列替换成 U+FFFD —— 顺带验证了「能否按 UTF-8 解码」
  const s = buf.toString('utf8');
  return {
    bom: bom,
    fffd: s.indexOf('\uFFFD') >= 0,
    mojibake: MOJIBAKE.filter((m) => m.re.test(s)).map((m) => m.name)
  };
}

/** 内容嗅探（**只**为"未扫描"那行读数服务，不参与任何判据）。
 *  返回 'utf16' | 'binary' | 'text'。
 *  ⚠️ 只看**头部**即可可靠区分这三档（UTF-16 BOM 在前两字节、NUL 在二进制里必然早出现），
 *  但**不能**用头部去判"是否已损坏"—— 实测：按头部判会把"U+FFFD 出现在 8 KiB 之后"的文件
 *  算成干净，于是"若纳入会红几个"这个读数会少报（本文件开发时先写成头部口径，实测少报 30 个）。
 *  ⇒ 是否"会红"一律交给 `scanText`（判据本身）算，见 main 里的 probeSkipped。 */
function sniffKind(head) {
  const h = head.subarray(0, Math.min(head.length, 8192));
  if ((h[0] === 0xff && h[1] === 0xfe) || (h[0] === 0xfe && h[1] === 0xff)) return 'utf16';
  if (h.includes(0)) return 'binary';
  return 'text';
}

/** 把"未扫描"的 [{ext, kind, red}] 聚成读数。纯函数。
 *  `red` 必须是**判据本身**（`scanText`）算出来的，不是这里猜的 —— 这样才能保证
 *  "若纳入白名单会红 N 个"与"纳入后真的会红"是同一套口径（否则就是又一份会漂移的副本）。 */
function aggregateSkipped(entries) {
  const byExt = new Map();
  let textLike = 0;
  let red = 0;
  let redUtf16 = 0;
  for (const e of entries) {
    const g = byExt.get(e.ext) || { total: 0, textLike: 0, binary: 0, red: 0 };
    g.total++;
    if (e.kind === 'binary') g.binary++;
    else { g.textLike++; textLike++; }
    if (e.red) { g.red++; red++; if (e.kind === 'utf16') redUtf16++; }
    byExt.set(e.ext, g);
  }
  const textExts = [...byExt.entries()].filter(([, g]) => g.textLike > 0)
    .sort((a, b) => b[1].textLike - a[1].textLike);
  return { total: entries.length, textLike: textLike, red: red, redUtf16: redUtf16, byExt: byExt, textExts: textExts };
}

/** 渲染"未扫描"那行。纯函数（单测锁住"不许静默"：文本类 > 0 时必须点名扩展名）。
 *  设计意图：**门禁自己把没看的东西说出来**。边界写在注释里会被忽略，印在输出里不会。 */
function describeSkipped(agg) {
  if (!agg.total) return '  ⚪ 未扫描（白名单外且未受管）: 0 个 —— 白名单已覆盖全部非受管文件';
  const parts = agg.textExts.slice(0, 6).map(([ext, g]) => ext + ' ' + g.textLike);
  const rest = agg.textExts.length - parts.length;
  const restN = agg.textExts.slice(6).reduce((n, [, g]) => n + g.textLike, 0);
  const line1 = '  ⚪ 未扫描（白名单外且未受管）: ' + agg.total + ' 个文件，其中文本类 ' + agg.textLike + ' 个'
    + (agg.textExts.length ? '：' + parts.join(' · ') + (rest > 0 ? ' · 另 ' + rest + ' 种 ' + restN + ' 个' : '') : '');
  if (!agg.red) return line1;
  return line1 + '\n      若把它们纳入白名单会**立刻红 ' + agg.red + ' 个**'
    + '（UTF-16LE ' + agg.redUtf16 + ' 个 · 其余 ' + (agg.red - agg.redUtf16) + ' 个）'
    + ' ⇒ 故不纳入；这是**判据本身**算出来的数，理由与触发条件见文件头';
}

/** 从 `git ls-files --eol -z` 的输出里解析出"git 判为文本的受管文件"与"index 行尾违规"。纯函数。 */
function parseEolListing(raw) {
  const files = new Map();
  for (const rec of String(raw || '').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const head = rec.slice(0, tab);
    const rel = rec.slice(tab + 1).replace(/\\/g, '/');
    const mi = /(?:^|\s)i\/(\S+)/.exec(head);
    const mw = /(?:^|\s)w\/(\S+)/.exec(head);
    files.set(rel, { index: mi ? mi[1] : '?', work: mw ? mw[1] : '?' });
  }
  const text = [];
  const binary = [];
  const bad = [];
  for (const [rel, e] of files) {
    if (e.index === 'lf') { text.push(rel); continue; }
    if (e.index === 'crlf' || e.index === 'mixed') { text.push(rel); bad.push({ rel: rel, index: e.index }); continue; }
    binary.push(rel);
  }
  return { files: files, text: text, binary: binary, bad: bad };
}

/* ---------------------------------------------------------------
 * I/O 区
 * --------------------------------------------------------------- */

/** 读 `git ls-files --eol -z`：**一次进程**同时供两处用（H3：不给高频动作加成本）——
 *  ① 扫描面的扩展（哪些跟踪文件是 git 眼里的文本）；② 行尾判据的输入（`i/` 列）。
 *  ⚠️ 必须带 `-z`：默认输出会把非 ASCII 路径 C-quote 成 `"\345\220\257…"`，
 *  与磁盘路径对不上（实测：`启动AI MindMap.vbs` 就长这样）。 */
function readManagedEol() {
  let raw;
  try {
    raw = execFileSync('git', ['ls-files', '--eol', '-z'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    });
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : '';
    const reason = e && e.code === 'ENOENT' ? '找不到 git 可执行文件'
      : (stderr || (e && e.message) || String(e));
    return { ok: false, reason: reason, files: new Map(), text: [], binary: [], bad: [] };
  }
  return Object.assign({ ok: true, reason: '' }, parseEolListing(raw));
}

/** 遍历工作树，按白名单切成两堆：命中白名单的 / 其余。 */
function collectFiles(dir, whitelisted, other) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(path.join(dir, e.name), whitelisted, other);
    } else if (TEXT_EXT.some((x) => e.name.toLowerCase().endsWith(x))) {
      whitelisted.push(path.join(dir, e.name));
    } else {
      other.push(path.join(dir, e.name));
    }
  }
}

const relOf = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');
const extOf = (rel) => { const b = path.basename(rel); const i = b.lastIndexOf('.'); return i <= 0 ? '(无扩展名)' : b.slice(i).toLowerCase(); };
const underSkipDir = (rel) => rel.split('/').slice(0, -1).some((s) => SKIP_DIRS.has(s));

/** 探一个"未扫描"文件：先读头 8 KiB 判是不是二进制（二进制**不读全文** —— 实测 54 个 PNG
 *  占 4.88 MiB，占未扫描总量的三分之一）；确实像文本才读全文，并用**判据本身**算它会不会红。 */
function probeSkipped(rel) {
  const abs = path.join(ROOT, rel);
  const ext = extOf(rel);
  let head;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const b = Buffer.alloc(8192);
      const n = fs.readSync(fd, b, 0, 8192, 0);
      head = b.subarray(0, n);
    } finally { fs.closeSync(fd); }
  } catch (e) { return { ext: ext, kind: 'binary', red: false }; }
  const kind = sniffKind(head);
  if (kind === 'binary') return { ext: ext, kind: kind, red: false };
  let red = false;
  try { const r = scanText(fs.readFileSync(abs)); red = r.bom || r.fffd || r.mojibake.length > 0; }
  catch (e) { red = false; }                       // 读不到不算数（不影响任何判据）
  return { ext: ext, kind: kind, red: red };
}

function main() {
  const listOnly = process.argv.includes('--list');

  const whitelisted = [];
  const other = [];
  collectFiles(ROOT, whitelisted, other);

  const managed = readManagedEol();

  // 扫描集 = 白名单（工作树里的非受管文件）∪ 受管文本（不看扩展名）
  const scan = new Set(whitelisted.map(relOf));
  const extra = [];
  if (managed.ok) {
    for (const rel of managed.text) {
      if (scan.has(rel) || underSkipDir(rel)) continue;
      scan.add(rel);
      extra.push(rel);
    }
  }
  const files = [...scan].sort();
  const notScanned = other.map(relOf).filter((rel) => !scan.has(rel));

  const bom = [];
  const replacement = [];
  const mojibake = [];
  let unreadable = 0;

  files.forEach((rel) => {
    if (listOnly) console.log('  ' + rel);
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, rel)); }
    catch (e) { unreadable++; return; }          // 在 index 里但不在工作树（暂存删除等）——不是本门禁的事
    const r = scanText(buf);
    // ① UTF-8 BOM：EF BB BF
    if (r.bom) bom.push(rel);
    // ② U+FFFD 替换字符（解码失败的典型残留）
    if (r.fffd) replacement.push(rel);
    // ③ 经典乱码特征
    r.mojibake.forEach((name) => mojibake.push(rel + '（' + name + '）'));
  });

  const skippedAgg = aggregateSkipped(notScanned.map(probeSkipped));

  console.log('== encoding-check ==');
  console.log('  已检查文本文件: ' + files.length + ' 个'
    + '（白名单 ' + whitelisted.length + ' + 受管文本追加 ' + extra.length + '）');
  if (extra.length) {
    console.log('  受管文本追加（白名单外、git 判为文本的跟踪文件）: '
      + extra.slice(0, 8).join(' · ') + (extra.length > 8 ? ' · 另 ' + (extra.length - 8) + ' 个' : ''));
  }
  console.log(describeSkipped(skippedAgg));
  if (unreadable) console.log('  ⚪ 在 index 里但读不到（不在工作树）: ' + unreadable + ' 个');
  console.log('');

  // 健全性：一个都没扫到说明 SKIP/EXT 配错了，不能算「通过」
  if (!files.length) {
    console.error('✗ 未扫描到任何文本文件 —— 配置有误，拒绝通过');
    process.exit(1);
  }

  let bad = false;
  const report = (label, arr, hint) => {
    if (!arr.length) { console.log('  ✓ ' + label + '：无'); return; }
    bad = true;
    console.error('  ✗ ' + label + '：' + arr.length + ' 处');
    arr.forEach((x) => console.error('      ' + x));
    if (hint) console.error('      → ' + hint);
  };

  report('① UTF-8 BOM', bom, '铁律要求无 BOM；请以 UTF-8（无 BOM）重新保存这些文件');
  report('② U+FFFD 替换字符', replacement, '说明存在无法按 UTF-8 解码的字节，文件很可能已被破坏');
  report('③ 经典乱码特征', mojibake, '多由 PowerShell 5.1 默认 GBK 读写造成；请从备份/轨迹恢复该文件');

  // ④ 提交进 index 的行尾一律 LF（判的是**提交面**，不是工作树 —— 见文件头能力边界第 2 条）
  if (!managed.ok) {
    bad = true;
    console.error('  ✗ ④ index 行尾一律 LF：无法判定');
    console.error('      git 读不到（' + managed.reason + '）');
    console.error('      → 本工程口径是"采不到真值不算通过"（静默跳过会被当成通过）；'
      + '要么装好 git、要么在有 .git 的副本里跑');
  } else {
    console.log('  ④ 读数：受管文本 ' + managed.text.length + ' 个（i/lf）· 二进制 ' + managed.binary.length + ' 个（i/-text，不做行尾转换）');
    report('④ index 行尾一律 LF', managed.bad.map((x) => x.rel + '（i/' + x.index + '）'),
      '提交进仓库的文本文件一律 LF（本仓 core.autocrlf 会把工作树的 CRLF 归一，能进 index 的是绕过归一的路径）；'
      + '请按 LF 重新加入 index：`git add --renormalize <path>`');
  }

  if (bad) {
    console.error('\nencoding-check 失败：存在编码损坏或 BOM');
    console.error('恢复指引见 docs/INCIDENTS.md（事故二）');
    process.exit(1);
  }
  console.log('  ✓ 全部文件为 UTF-8 无 BOM，未发现乱码特征');
  console.log('\nencoding-check 通过');
}

if (require.main === module) main();

module.exports = {
  scanText: scanText,
  sniffKind: sniffKind,
  aggregateSkipped: aggregateSkipped,
  describeSkipped: describeSkipped,
  parseEolListing: parseEolListing,
  TEXT_EXT: TEXT_EXT,
  SKIP_DIRS: SKIP_DIRS
};
