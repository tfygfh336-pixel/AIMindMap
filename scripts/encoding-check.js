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
 *   2) **行尾是两条判定，方向相反、互补**（2026-10-21 订正；旧表述只有 ④，于是"今天全绿"
 *      与"新克隆必红"能同时成立 —— 见 `.review/20261022-G1-行尾判据/`）：
 *      · ④ 判 **index（提交面）**：进仓库的文本一律 LF。
 *      · ⑤ 判 **工作树（签出面）**：`core.autocrlf` 只影响"签出成什么"。本仓它是 **system 级 true**、
 *        仓内没有 `.gitattributes` ⇒ 有 12 个受管文本签出后带 CR（实测 `w/crlf` 11 + `w/mixed` 1，
 *        正是 `docs/RULES.md` §3 `R1a` 的「11+1」口径）。新克隆里 **400+ 个文本全是 CRLF**，
 *        而 index 一个 CR 都没有 ⇒ 只守 ④ 时那道门禁看不出这件事。⑤ 补的就是这一格。
 *   3) ④ 在 `core.autocrlf=true` 下近乎一个**配置漂移哨兵**：`git add` 会按规则把 CRLF
 *      归一成 LF ⇒ 正常路径本来就进不了 CRLF 条目。它能抓到的是**绕过归一**的路径
 *      （`git update-index --cacheinfo` 这类水管提交、`core.autocrlf` 被关掉后提交、
 *      `.gitattributes` 加了 `-text`）。它的价值是让 `docs/RULES.md` 那句口径**可判定**，
 *      而不是假装它拦得住所有行尾问题。
 *   4) ⑤ 的能力边界（**三档都打印在输出里**，不许静默；照 `testing-for-ai` `B8`）：
 *      · **判红档** = 受管文本里出现**未在册**的 CR；另两种同档：在册条目**悬挂**（路径已不在
 *        index/盘上）、在册条数**≠ 上限**（`WORKTREE_CR_DEBT_MAX`：多一条是"超额"、少一条是
 *        "**富余额度**" —— 两侧都判，唯一合法状态是"上限 == 在册条数"）。
 *        修法**一处**：加 `.gitattributes`（`* text=auto eol=lf`）或 `git config core.autocrlf false`
 *        （后者只改本机）。**不要**用 `git checkout --` 去"还原行尾"（`R1a`：它写回的是 CRLF，
 *        不是你以为的那份字节，且**不报错**）。
 *      · **只报告档** = `WORKTREE_CR_DEBT` 在册的那些（上限只减不增）。它们不是损坏，是
 *        `core.autocrlf=true` 的**签出产物**（index 里纯 LF、git 判 clean）⇒ 不判红，
 *        但**每条都把"为什么在册"打印出来**；已无 CR 的条目打印"可销账"。
 *      · **跳过档** = `.vbs` / `.bat` / `.cmd`（Windows 脚本宿主按 CRLF 存）与二进制
 *        （git 判 `-text`，**根本不做行尾转换**）。跳过**逐条打印对象与计数**，与"通过"分开。
 *      ⚠️ ⑤ **只判受管文本**（`git ls-files --eol` 判为文本的**跟踪**文件）。白名单里的
 *      **非受管**文件（`.review/` 的读数转储、`projects/` 的笔记）不受 `core.autocrlf` 影响，
 *      **不判** —— 实测其中已有 110 个含 CR（全是历史取证转储、被 `.gitignore` 定性为运行转储），
 *      把它们纳入等于一上线就永久红 110 处（那是假红，不是门禁）。
 *      ⚠️ **形态随 `.gitattributes` 自动升级**（判据不依赖它存在，两种形态都能跑）：
 *      无 catch-all 的 `eol=lf` 行 ⇒ **过渡态**（只判增量，在册 12 条只报告）；
 *      有 ⇒ **终态**（签出方向已确定 ⇒ 工作树必须全 LF，在册上限降到只剩脚本宿主那几条）。
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

/** ⑤ 的**跳过档**：这些扩展名按 CRLF 存是**预期**的（Windows 脚本宿主 `wscript` 吃 CRLF），不判。
 *  二进制（git 判 `-text`）另行跳过 —— 它根本不做行尾转换。
 *  ⚠️ 跳过**必须打印被跳过的对象**（照 `testing-for-ai` `B8`：只写条件不写对象等于没声明）。 */
const WORKTREE_EOL_SKIP_EXT = ['.vbs', '.bat', '.cmd'];

/** `.gitattributes` 的路径（**只读，不创建**：那是另一批的决定）。它的存在把 ⑤ 从过渡态升到终态。 */
const ATTR_FILE = '.gitattributes';

/** ⑤ 工作树行尾方向的**封闭欠账册**（形状照 `WRITE_OUTLET_DEBT` / `MCP_GAP_DEBT`）。
 *
 *  为什么需要这本册：本仓 `core.autocrlf` 是 **system 级 `true`**、仓内没有 `.gitattributes`
 *  ⇒ 一批文本签出后就是 CRLF（`docs/RULES.md` §3 `R1a` 的「11+1」口径）。它们**不是损坏**
 *  （index 里纯 LF、`git` 判 clean），但也**不该无声无息**：每条写清"它是哪一类产物"。
 *
 *  ⚠️ `cr` 是**登记当天的读数**（2026-10-21 实测），**不作判据** —— 判据是"有没有 CR"，
 *  "CR 几条"会随着任何一次编辑而变（每加一行就 +1），拿它当判据等于每次改文件都假红。
 *  运行时会把"现在几条"与它并排打印，差值自己看得出来。
 *
 *  **只减不增**由**两条**机械判定守（两侧都判，唯一合法状态是"上限 == 在册条数"）：
 *  ① 未在册的 CR ⇒ 判红；② 在册条数 **≠** 上限 ⇒ 判红（多于上限 = 超额；少于上限 = **富余额度**）。
 *  ②的后一条防的是"先把额度开好、下一批再拆细往里塞"，前一条防"拆细了不抬上限" ——
 *  「把一条欠账拆成两条换额度」是这个上限唯一防得住的姿势。销账 = 删条目 + **同批**把上限调小。 */
const WORKTREE_CR_DEBT = [
  { path: 'scripts/smoke/29-multiselect.js', cr: 518, why: '**签出产物**（blob 纯 LF）—— 而该文件此刻是**别人未提交的改动**（+275/−168）⇒ **不能刷新它**（刷新 = 销毁那批活）⇒ 保留在册，等那个会话提交或放弃后再销账（届时 2 → 1）' },
  { path: '启动AI MindMap.vbs', cr: 9, why: 'Windows 脚本宿主按 CRLF 存（与跳过档同一语义；留在册里是为了让"在册条数"与 R1a 的 11+1 **一一对拍**）' }
];

/* 2026-10-22 销账记录（12 → 2）：原册有 12 条，其中 **10 条已用 blob 的原始字节刷成 LF**
 * （`refresh-cr.js`：`git checkout --` 对它们无效 —— `core.autocrlf=true` 下「LF blob ↔ CRLF 工作树」
 * 被 git 判 clean，checkout 是 no-op；而 `pwsh >` 会写 UTF-16LE，违 `R1b`）。
 * ⇒ 那 10 条**不是欠账了**，删条目 + 上限同批 12 → 2（销账 = 删条目 + 同批调小上限）。
 * ⇒ 剩的 2 条各有硬理由：一个动不得、一个是脚本宿主。
 * ⚠️ `.gitattributes` **尚未落地**：提案文件在 `.review/20261022-gitattributes-定题/gitattributes.proposed`。
 *   **它不能现在落地** —— 一旦有 catch-all，⑤ 就升到终态，而终态上限 = 在册里"脚本宿主扩展名"的条数
 *   （`judgeWorktreeEol` 的 `cap` 是**现算**的，不是常量）⇒ `.js` 那条留着就是"超额"、删了就是"未在册的含 CR"
 *   ⇒ **在 `29-multiselect.js` 还带 CR 且脏的时候，终态没有任何合法态**。等它落定，2 → 1，再上 `.gitattributes`。 */

/** 在册条数上界（**只减不增**；改成更大的数 = 放宽判定，必须同批写理由）。
 *  ⚠️ 写成字面量而**不是** `WORKTREE_CR_DEBT.length`：后者会跟着册一起涨，于是"抬上限"就等于
 *  改一行数组、没有任何痕迹 —— 与 `WRITE_OUTLET_CAP` / `MCP_GAP_DEBT_MAX` 同一个理由。 */
const WORKTREE_CR_DEBT_MAX = 2;

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

/** 数一份 buffer 的行尾：`cr` = 0x0D 总数 · `crlf` = 成对的 · `lone` = 孤立的。
 *  纯函数。**判据只看 `cr > 0`**，另两个只用于把"这份文件是怎么带 CR 的"打印清楚
 *  （`lone > 0` 说明它还混着别的来源，不是单纯签出产物）。 */
function eolStats(buf) {
  let cr = 0;
  let crlf = 0;
  let lone = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0D) continue;
    cr++;
    if (buf[i + 1] === 0x0A) crlf++; else lone++;
  }
  return { cr: cr, crlf: crlf, lone: lone };
}

/** 判 `.gitattributes` 把 ⑤ 放进哪一形态（纯函数）。
 *
 *  **判据 = 有没有一行 catch-all（模式就是 `*`）同时声明 `text` 与 `eol=lf`**。
 *  为什么只认 catch-all：只有"所有路径默认按 LF 签出"这一句才能推出"工作树必须全 LF"。
 *  逐类写（`*.md text eol=lf`）**不算终态** —— 它盖不全，没写到的路径仍然回落到
 *  `core.autocrlf`（`docs/RULES.md` §3 `R1a` 的实测就是这个坑）。
 *
 *  返回 `{ mode: 'terminal'|'transition', reason, line, detail }`：
 *  `reason` = `catch-all-lf`（终态）/ `no-file` / `no-catch-all`（有属性文件但不是终态）。
 *  ⚠️ **本函数绝不创建/修改 `.gitattributes`** —— 只读。文件在不在由调用方传 `null` 表达。 */
function parseAttrMode(attrText) {
  if (attrText == null) {
    return { mode: 'transition', reason: 'no-file', line: 0, detail: '本仓没有 ' + ATTR_FILE };
  }
  const lines = String(attrText).split('\n');
  const seen = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^\s+/, '').replace(/\s+$/, '');
    if (!l || l[0] === '#') continue;
    const sp = l.indexOf(' ');
    const pattern = sp < 0 ? l : l.slice(0, sp);
    const attrs = sp < 0 ? '' : l.slice(sp + 1);
    const parts = attrs.split(/\s+/).filter(Boolean);
    const hasText = parts.some((p) => p === 'text' || p.indexOf('text=') === 0);
    const hasLf = parts.some((p) => p.toLowerCase() === 'eol=lf');
    if (seen.length < 3) seen.push(l.slice(0, 60));
    if (pattern === '*' && hasText && hasLf) {
      return { mode: 'terminal', reason: 'catch-all-lf', line: i + 1, detail: l.slice(0, 80) };
    }
  }
  return {
    mode: 'transition', reason: 'no-catch-all', line: 0,
    detail: '有 ' + ATTR_FILE + ' 但没有 catch-all（模式 `*`）的 `text` + `eol=lf` 行：'
      + (seen.length ? seen.join(' / ') : '（空文件）')
  };
}

/** ⑤ 的**纯函数**判据（无 I/O，单测只打这里）。三档在这里一次分完。
 *
 *  `rows` = 受管文本的 CR 读数 `[{ rel, cr }]`（只含 `git ls-files --eol` 判为文本的**跟踪**文件）。
 *  `opts` = `{ debt, max, mode, known, skipExt }`：
 *    `debt` = 在册册 · `max` = 过渡态的上界 · `mode` = `parseAttrMode().mode` ·
 *    `known` = index 里有的路径（判"悬挂登记"用，Set）· `skipExt` = 跳过档扩展名。
 *
 *  三档的**归属规则**（顺序就是优先级，改顺序 = 改判定）：
 *  1. `cr === 0` ⇒ 不进任何档（它是 LF，正常）。
 *  2. **在册**（路径在册上）⇒ **只报告档**，连 `why` 一起交出去（脚本宿主那一个也在册，
 *     所以它走这一档而不是跳过档 —— 见册里那条的 `why`）。
 *  3. 不在册 + 扩展名在 `skipExt` ⇒ **跳过档**（打印对象）。
 *  4. 其余 ⇒ **判红档**。
 *  另外两种**判红**：在册路径已不在 index/盘上（`hanging`，改名/删了却还挂在册上）、
 *  在册条数 **≠** 上界（`capMismatch`：`kind='over'` = 多于上限，`kind='slack'` = **富余额度**，
 *  即"抬了上限却没有对应欠账"）。两侧都判才防得住"拆细换额度"。
 *  终态（`mode === 'terminal'`）下把上界压到"只剩脚本宿主那几条"—— 属性已把签出方向定死，
 *  再留着 11 条签出产物就是没销账。
 *
 *  返回 `{ red, debt, stale, skipScript, skipBinary, hanging, capMismatch, cap, debtCount, mode }`。
 *  `skipBinary` 由调用方填（它来自 `i/-text`，不在 `rows` 里）。 */
function judgeWorktreeEol(rows, opts) {
  const o = opts || {};
  const debt = Array.isArray(o.debt) ? o.debt : WORKTREE_CR_DEBT;
  const max = typeof o.max === 'number' ? o.max : WORKTREE_CR_DEBT_MAX;
  const mode = o.mode === 'terminal' ? 'terminal' : 'transition';
  const skipExt = Array.isArray(o.skipExt) ? o.skipExt : WORKTREE_EOL_SKIP_EXT;
  const known = o.known instanceof Set ? o.known : new Set((rows || []).map((r) => r.rel));

  const byPath = new Map();
  for (const d of debt) byPath.set(d.path, d);

  const red = [];
  const debtHit = [];
  const skipScript = [];
  for (const r of (rows || [])) {
    if (!r || !(r.cr > 0)) continue;
    if (byPath.has(r.rel)) {
      const d = byPath.get(r.rel);
      debtHit.push({ path: r.rel, why: String(d.why || '（册上这条没写 why —— 待补）'), cr: d.cr, now: r.cr });
      continue;
    }
    const ext = extOf(r.rel);
    if (skipExt.indexOf(ext) >= 0) { skipScript.push({ rel: r.rel, cr: r.cr, ext: ext }); continue; }
    red.push({ rel: r.rel, cr: r.cr, ext: ext });
  }

  const stale = [];
  const hanging = [];
  for (const d of debt) {
    if (!known.has(d.path)) { hanging.push({ path: d.path, why: String(d.why || '') }); continue; }
    const hit = (rows || []).find((r) => r.rel === d.path);
    if (!hit || !(hit.cr > 0)) stale.push({ path: d.path, why: String(d.why || ''), cr: d.cr, now: hit ? hit.cr : 0 });
  }

  const cap = mode === 'terminal'
    ? debt.filter((d) => skipExt.indexOf(extOf(d.path)) >= 0).length
    : max;
  // **两侧都判**（这是"防拆细换额度"的机械形态）：
  //   · 甲：册 > 上限 ⇒ 超额（加了一条没抬上限）；
  //   · 乙：册 < 上限 ⇒ **富余额度**（抬了上限却没有对应的欠账 = 先把口子开好、下一批再往里塞）。
  //   ⇒ 唯一合法状态是"上限 == 在册条数"：要动册就**同批**动上限，两处都留痕（一次显式提交）。
  const capMismatch = debt.length === cap
    ? null
    : {
      debtCount: debt.length,
      cap: cap,
      kind: debt.length > cap ? 'over' : 'slack',
      mustDelist: mode === 'terminal'
        ? debt.filter((d) => skipExt.indexOf(extOf(d.path)) < 0).map((d) => d.path)
        : []
    };

  return {
    red: red, debt: debtHit, stale: stale, skipScript: skipScript,
    skipBinary: Array.isArray(o.binary) ? o.binary : [],
    hanging: hanging, capMismatch: capMismatch, cap: cap, debtCount: debt.length, mode: mode
  };
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
  const crRows = [];                              // （承 ⑤）的输入：**受管文本**的 CR 读数
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
    // （承 ⑤）输入只取**受管文本**（非受管白名单文件不受 core.autocrlf 影响，见文件头边界第 4 条）
    if (managed.ok && managed.files.has(rel)) {
      const s = eolStats(buf);
      if (s.cr > 0) crRows.push({ rel: rel, cr: s.cr, crlf: s.crlf, lone: s.lone });
    }
  });
  crRows.sort((a, b) => (a.rel < b.rel ? -1 : 1));

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

  // ⑤ 工作树行尾方向（**签出面**，与 ④ 的**提交面**互补 —— 见文件头能力边界第 2 条）。
  //    三档都打印在输出里（判红 / 只报告 / 跳过）；"只报告"必须连理由一起打印，
  //    否则读者分不出"它真的过了"与"它没能力判"（照 skill `B8`）。
  if (!managed.ok) {
    console.log('  ⚪ ⑤ 跳过：git 读不到 ⇒ 取不到"受管文本"清单，无从判工作树方向'
      + '（已由 ④ 判红，不重复计红；采不到真值不假装通过）');
  } else {
    const attrPath = path.join(ROOT, ATTR_FILE);
    let attrText = null;
    try { attrText = fs.readFileSync(attrPath, 'utf8'); } catch (e) { attrText = null; }
    const attr = parseAttrMode(attrText);
    const wt = judgeWorktreeEol(crRows, {
      debt: WORKTREE_CR_DEBT, max: WORKTREE_CR_DEBT_MAX, mode: attr.mode,
      known: new Set(managed.files.keys()), skipExt: WORKTREE_EOL_SKIP_EXT,
      binary: managed.binary
    });
    console.log('  ⑤ 读数：形态 = ' + (wt.mode === 'terminal' ? '终态' : '过渡态')
      + '（' + (wt.mode === 'terminal'
        ? '第 ' + attr.line + ' 行 catch-all：' + attr.detail
        : '无 catch-all 的 eol=lf：' + attr.detail) + '）'
      + ' · 受管文本 ' + managed.text.length + ' 个 · 含 CR ' + crRows.length + ' 个'
      + ' · 在册 ' + wt.debtCount + ' 条 / 上限 ' + wt.cap + '（只减不增）');
    if (crRows.some((x) => x.lone > 0)) {
      console.log('     （其中带孤立 CR（不在 CRLF 里）的: '
        + crRows.filter((x) => x.lone > 0).map((x) => x.rel + ' ' + x.lone).join(' · ') + '）');
    }

    // —— 判红档 · 甲：未在册的含 CR 受管文本
    if (!wt.red.length) {
      console.log('     ✓ 判红档（未在册的含 CR 受管文本）：无');
    } else {
      bad = true;
      console.error('     ✗ 判红档（未在册的含 CR 受管文本）：' + wt.red.length + ' 处');
      wt.red.forEach((x) => console.error('         ' + x.rel + '（CR ' + x.cr + ' 处 · 类型 ' + x.ext + '）'));
      console.error('         → 这类文件签出来必须是 LF（新克隆里成百上千个都长这样，就是"新克隆必红"的来源）。'
        + '修法一处：加 .gitattributes（`* text=auto eol=lf`）或 `git config core.autocrlf false`（只改本机）；'
        + '**不要**用 `git checkout --` 去掉它（R1a：写回的是 CRLF，且不报错）');
    }
    // —— 判红档 · 乙：在册条目悬挂（改名 / 删了却还挂在册上）
    if (wt.hanging.length) {
      bad = true;
      console.error('     ✗ 判红档（在册欠账悬挂）：' + wt.hanging.length + ' 处');
      wt.hanging.forEach((h) => console.error('         ' + h.path + '（index 里没有这个路径）'));
      console.error('         → 册上的对象改名/删了却还挂着 ⇒ 销账（删条目）或改成现在的路径');
    }
    // —— 判红档 · 丙：在册条数与上限**必须相等**（多一条是超额，少一条是富余额度）
    if (wt.capMismatch) {
      bad = true;
      if (wt.capMismatch.kind === 'over') {
        console.error('     ✗ 判红档（在册条数超额）：' + wt.capMismatch.debtCount + ' 条 > 上限 '
          + wt.capMismatch.cap + '（'
          + (wt.mode === 'terminal'
            ? '终态：`.gitattributes` 已有 catch-all 的 `eol=lf` ⇒ 只允许跳过档那几条留着'
            : '`WORKTREE_CR_DEBT_MAX` 只减不增')
          + '）');
      } else {
        console.error('     ✗ 判红档（额度富余）：上限 ' + wt.capMismatch.cap + ' > 在册 '
          + wt.capMismatch.debtCount + ' 条 —— 抬了上限却没有对应的欠账（先把额度开好、下一批再往里塞）');
      }
      if (wt.capMismatch.mustDelist.length) {
        console.error('         终态下必须销账的条目（属性已把签出方向定死，签出面不该再有 CR）：'
          + wt.capMismatch.mustDelist.join(' · '));
      }
      console.error('         → 唯一合法状态是「上限 == 在册条数」：加一条欠账就同批抬上限并写明理由；'
        + '销一条账就同批把上限调小（两处都留痕 = 一次显式提交，不是顺手改个数字）');
    }
    // —— 只报告档：在册欠账（逐条打印理由）
    if (wt.debt.length) {
      console.log('     · 只报告档（在册欠账，不判红）：' + wt.debt.length + ' 条');
      wt.debt.forEach((d) => {
        console.log('         · ' + d.path + '　CR ' + d.now
          + (d.now !== d.cr ? '（登记时 ' + d.cr + '）' : '') + '　' + d.why);
      });
      console.log('         → 放行理由：这些是 **签出面** 的产物（index 里纯 LF、git 判 clean），'
        + '不是文件损坏；**不要**逐个改文件（改哪个文件就别动它的行尾，见 R1a）。'
        + '整批的修法是一处：.gitattributes');
    } else {
      console.log('     · 只报告档（在册欠账）：0 条（册是空的）');
    }
    if (wt.stale.length) {
      console.log('     · 只报告档（可销账）：' + wt.stale.length + ' 条在册但工作树里已无 CR —— '
        + '删掉这些条目，并把 `WORKTREE_CR_DEBT_MAX` 同批调小（销账不是删红，是删登记）');
      wt.stale.forEach((s) => console.log('         · ' + s.path + '（现在 CR ' + s.now + '）'));
    }
    // —— 跳过档（逐条打印被跳过的对象；跳过与通过分开计数）
    console.log('     ⚪ 跳过档：二进制 ' + wt.skipBinary.length + ' 个（git 判 i/-text，不做行尾转换）'
      + (wt.skipBinary.length ? '：' + wt.skipBinary.slice(0, 5).join(' · ')
        + (wt.skipBinary.length > 5 ? ' · 另 ' + (wt.skipBinary.length - 5) + ' 个' : '') : '')
      + ' · 脚本宿主扩展名（' + WORKTREE_EOL_SKIP_EXT.join('/') + '）**不在册**的 ' + wt.skipScript.length + ' 个'
      + (wt.skipScript.length ? '：' + wt.skipScript.map((s) => s.rel + '(' + s.cr + ')').join(' · ') : '')
      + ' —— 跳过理由：Windows 脚本宿主按 CRLF 存、二进制不做行尾转换；在册的那几个走"只报告"档');
  }

  if (bad) {
    console.error('\nencoding-check 失败：存在编码损坏、BOM，或工作树行尾方向不对');
    console.error('恢复指引见 docs/INCIDENTS.md（事故二）；行尾那两条（④ 提交面 / ⑤ 签出面）见文件头能力边界');
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
  eolStats: eolStats,
  parseAttrMode: parseAttrMode,
  judgeWorktreeEol: judgeWorktreeEol,
  WORKTREE_CR_DEBT: WORKTREE_CR_DEBT,
  WORKTREE_CR_DEBT_MAX: WORKTREE_CR_DEBT_MAX,
  WORKTREE_EOL_SKIP_EXT: WORKTREE_EOL_SKIP_EXT,
  ATTR_FILE: ATTR_FILE,
  TEXT_EXT: TEXT_EXT,
  SKIP_DIRS: SKIP_DIRS
};
