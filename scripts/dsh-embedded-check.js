#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-embedded-check.js —— 内置 DSH 升级后自检（**只读**，不起 Electron）
 * ------------------------------------------------------------
 * 用途：换了运行包 / 重跑了插件导入之后，一条命令回答"哪些改动还在" ✓。
 * 为什么不做成 verify 的一步：它要读 %APPDATA%（机器本地状态）✗ —— 塞进验证链会
 * 破坏"验证可移植"这条前提 ✓。它是 skill `embedded-dsh-maintain` 的必跑项 ✓。
 *
 * 判据口径（PASS / FAIL / UNKNOWN 三态 ✓）：
 *   · FAIL  = 与台账/回执记录不一致（真问题）
 *   · UNKNOWN = 本脚本**判不了**（例如需要真实点击、需要跑重命令）—— **不许**把 UNKNOWN 当 PASS ✗
 *
 * 用法：node scripts/dsh-embedded-check.js [--home <dsh-home>] [--json]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = (() => {
  const i = process.argv.indexOf('--home');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const base = process.env.AI_MINDMAP_USERDATA || path.join(process.env.APPDATA || '', 'AI MindMap');
  return path.join(base, 'dsh-home');
})();
const USERDATA = path.dirname(HOME);
/** 「正在运行的那个实例」的 userData —— 只用来判断被自检的实例与它是不是同一个（见第 8 项） */
const LIVE_USERDATA = process.env.AI_MINDMAP_USERDATA || path.join(process.env.APPDATA || '', 'AI MindMap');
const PROFILE = path.join(HOME, 'profiles', 'web');
const REPO = path.resolve(__dirname, '..');
const results = [];
const add = (no, name, state, detail) => results.push({ no, name, state, detail });
/** `--json` 模式：stdout 必须**只有**那一个 JSON 数组（子进程输出要改道，见第 6 项） */
const JSON_MODE = process.argv.includes('--json');

function walk(dir) {
  let files = 0, bytes = 0, reparse = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink && e.isSymbolicLink()) { reparse++; continue; }
      if (e.isDirectory()) { stack.push(p); continue; }
      files++;
      try { bytes += fs.statSync(p).size; } catch (err) { /* ignore */ }
    }
  }
  return { files, bytes, reparse };
}

/* 1 运行包版本 */
const manifestPath = path.join(REPO, 'vendor', 'dsh', 'manifest.json');
try {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  add(1, '运行包版本', 'PASS', (m.dshVersion || m.id || '?') + '（完整哈希核验请跑 npm run dsh:maint -- verify）');
} catch (e) { add(1, '运行包版本', 'FAIL', '读不到 ' + manifestPath); }

/* 2 运行包零补丁：重命令，交给 dsh:maint；这里只提示 */
add(2, '运行包零补丁', 'UNKNOWN', '需跑 `npm run dsh:maint -- verify`（较重，本脚本不代跑 ✗）');

/* 回执（迁移时留的），用于 3/4/5/10 的对照真值
 *
 * ⚠️ 真实结构（2026-09-30 实测 receipt-migrate-45242730bc15.json）：顶层键只有
 *   schemaVersion / opId / at / packageDir / backupDir / dshHome / source / deployed /
 *   conflicts / rewrites / refNames / externalRefs / gates / nextSteps
 *   —— **没有** bundles / files / bytes ✗。上一版按 `receipt.bundles`（第 3 项）与
 *   `receipt.files`+`receipt.bytes`（第 4 项）取真值，于是**永远取不到** ⇒ 两项恒为 UNKNOWN ✗。
 *   回执的 deployed[] 也只有 `{ path, action }`（7553 项），**不按 kind 分组** ✗。
 *
 * 真值其实在回执**指向的投递包**里：`<packageDir>\manifest.json`
 *   · `manifest.files['payload/<rel>'] = { size, sha256 }` —— 投递后的载荷清单（7553 项）；
 *   · `manifest.units[].files[].size` —— **源机**尺寸，**不能**用来核载荷（见下）；
 *   · `manifest.totalBytes` / `manifest.units[]` / `manifest.files` 都是真实字段名 ✓。
 */
const receiptsDir = path.join(USERDATA, 'dsh-migrate');
let receipt = null;
try {
  const cands = fs.readdirSync(receiptsDir).filter((f) => /^receipt-migrate-.*\.json$/.test(f))
    .map((f) => path.join(receiptsDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (cands.length) receipt = JSON.parse(fs.readFileSync(cands[0], 'utf8'));
} catch (e) { /* 没有回执 ⇒ 下面的项判 UNKNOWN ✓ */ }

/** 回执指向的投递包清单（第 3/4 项的真值）；读不到 ⇒ null（下面的项判 UNKNOWN ✓） */
let manifest = null;
try {
  if (receipt && receipt.packageDir) manifest = JSON.parse(fs.readFileSync(path.join(receipt.packageDir, 'manifest.json'), 'utf8'));
} catch (e) { /* 投递包被清理/字段名变了 ⇒ 判 UNKNOWN，不猜 ✗ */ }

/** dsh-home 内的相对路径，**统一正斜杠**（manifest.files 的键是 `payload/<正斜杠 rel>`） */
const relOf = (p) => path.relative(HOME, p).split(path.sep).join('/');

/** 载荷清单：rel → size（剥掉 `payload/` 前缀）
 *  为什么不用 units[].files[].size：实测同一份 manifest 里两者差 868 字节
 *  （node_modules：files 208683311 / units 208682443）—— 差源是 28 个 `.bin\*` 垫片，
 *  它们在 staging 阶段被**改写过**（写进去的是目标机路径），所以 units 记的是**源机**尺寸 ✗。
 *  只有 manifest.files 与现网实际遍历**逐字节**相等（2026-09-30 实测 7543 / 208683311，容差 0）✓。
 *  **取不到就返回 null，不返回空 Map** —— 空 Map 会被当成"载荷为空"而判成 FAIL ✗。 */
function payloadFileSizes(m) {
  if (!m || !m.files || typeof m.files !== 'object') return null;
  const out = new Map();
  for (const k of Object.keys(m.files)) {
    const size = m.files[k] && m.files[k].size;
    if (typeof size === 'number') out.set(k.replace(/^payload\//, ''), size);
  }
  return out.size ? out : null;
}

/** 把载荷清单按目录前缀汇总成 { files, bytes }（prefix 末尾要带 `/`） */
function tally(files, prefix) {
  let n = 0, b = 0;
  for (const [rel, size] of files) if (rel.startsWith(prefix)) { n++; b += size; }
  return { files: n, bytes: b };
}

/** want 是 got 的**有序子序列**？
 *  迁移的 profile package.json 合并语义是"目的侧顺序保留，再按源顺序追加缺失项"，
 *  所以现网允许比投递包**多**项（目的侧既有 ✓），但投递包那几项的**相对顺序**必须保持
 *  （bundles 顺序就是 composeProfile 的层叠顺序 = 语义 ✓）。
 *  用"逐字相等"会把合法的目的侧既有项判成 FAIL ✗。 */
function isOrderedSubset(want, got) {
  let i = 0;
  for (const g of got) if (i < want.length && g === want[i]) i++;
  return i === want.length;
}

/* 3 profile 清单 —— 真值 = 投递包里那份 profile package.json 的**原样留档**
 * （回执自己不带 bundles ✗；源侧 `~/.dsh` 会漂移，不能当对照 ✗） */
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
  const got = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  let want = null;
  try {
    const copy = JSON.parse(fs.readFileSync(path.join(receipt.packageDir, 'payload', relOf(PROFILE), 'package.json'), 'utf8'));
    if (Array.isArray(copy.dsh && copy.dsh.profile && copy.dsh.profile.bundles)) want = copy.dsh.profile.bundles;
  } catch (e) { /* 投递包副本不在 ⇒ want 仍是 null ⇒ 判 UNKNOWN ✓ */ }
  if (!want) add(3, 'profile 清单', 'UNKNOWN', '有 ' + got.length + ' 个 bundle，但找不到投递包副本可对照（' + got.join(', ') + '）');
  else if (got.join(',') === want.join(',')) add(3, 'profile 清单', 'PASS', got.length + ' 个 bundle 与投递包副本逐字一致 ✓');
  else if (isOrderedSubset(want, got)) add(3, 'profile 清单', 'PASS', '投递包 ' + want.length + ' 项全在且顺序不变 ✓（现网 ' + got.length + ' 项，多出的是目的侧既有 —— 合并语义 = 目的侧优先 + 源缺项追加）');
  else add(3, 'profile 清单', 'FAIL', '期望（投递包副本，' + want.length + ' 项）' + want.join(',') + '，实际（' + got.length + ' 项）' + got.join(','));
} catch (e) { add(3, 'profile 清单', 'FAIL', '读不到 profile package.json：' + e.message); }

/* 4 载荷完整 + 7 独立性（同一次遍历拿两个结论 ✓） */
const nm = path.join(PROFILE, 'node_modules');
if (fs.existsSync(nm)) {
  const s = walk(nm);
  const sizes = payloadFileSizes(manifest);
  const want = sizes ? tally(sizes, relOf(nm) + '/') : null;
  const src = '真值 = 投递包 manifest.files（opId=' + ((receipt && receipt.opId) || '?') + '）';
  if (want && want.files && s.files === want.files && s.bytes === want.bytes) {
    add(4, '载荷完整', 'PASS', s.files + ' 文件 / ' + (s.bytes / 1048576).toFixed(2) + ' MB，与投递包清单**逐字节**一致 ✓（' + src + '）');
  } else if (want && want.files) {
    add(4, '载荷完整', 'FAIL', '期望 ' + want.files + ' 文件 / ' + (want.bytes / 1048576).toFixed(2) + ' MB，实际 '
      + s.files + ' 文件 / ' + (s.bytes / 1048576).toFixed(2) + ' MB（' + src + '）');
  } else {
    add(4, '载荷完整', 'UNKNOWN', '实际 ' + s.files + ' 文件 / ' + (s.bytes / 1048576).toFixed(2) + ' MB'
      + '（无投递包清单可对照：回执缺 packageDir 或包已被清理 ✗）');
  }
  add(7, '独立性（无 reparse 点）', s.reparse === 0 ? 'PASS' : 'FAIL', 'payload 内 reparse 点 = ' + s.reparse);
} else { add(4, '载荷完整', 'FAIL', '没有 node_modules：' + nm); add(7, '独立性', 'UNKNOWN', '跳过'); }

/* 5 模式声明（agent preset）—— 判据是「**被声明**」，不是「目录里有没有文件」（2026-10-08 更正）
 * 旧版核对 `.agent-presets/` 的文件数 ⇒ **校的是错的东西** ✗：内核已不再读那个目录
 *   （内核自带 skill `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` 原文：
 *    "Nothing reads that directory any more"），模式真正生效靠**声明** —— 本工程的 aimindmap
 *   走 `$presets` 生成块；第三方的梁神走它自己插件的声明（`declare = enabled`）。
 * 这里只做**机械可判**的那一半：overrides 里每个 `$presets` 都要在 patch 里找到对应的
 * `- id: preset-<id>` 行。**内容级**核对（生成块逐行比对）在第 6 项 —— 不在这里重复表达。
 * 遗留目录只作为**信息**附带报告：它不影响生效，别再把它当"模式可用"的证据 ✓ */
try {
  const ovsPath = path.join(HOME, '.embedded-overrides.json');
  const ovs = fs.existsSync(ovsPath) ? JSON.parse(fs.readFileSync(ovsPath, 'utf8')) : {};
  const want = Object.keys(ovs.$presets || {});
  let legacy = '';
  try {
    const names = fs.readdirSync(path.join(HOME, '.agent-presets'));
    legacy = '；遗留 .agent-presets: ' + (names.join(', ') || '（空）') + '（内核已不读，仅留档）';
  } catch (e) { legacy = '；无遗留 .agent-presets 目录'; }
  if (!want.length) {
    add(5, '模式声明', 'UNKNOWN', 'overrides 里没有 $presets（本工程没有声明任何模式）' + legacy);
  } else {
    const patchPath = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml');
    if (!fs.existsSync(patchPath)) {
      add(5, '模式声明', 'FAIL', '声明了 ' + want.join(', ') + ' 但找不到 patch 文件：' + patchPath + legacy);
    } else {
      const patchText = fs.readFileSync(patchPath, 'utf8');
      const missing = want.filter((id) => !new RegExp('^\\s*-\\s+id:\\s+preset-' + id + '\\s*$', 'm').test(patchText));
      add(5, '模式声明', missing.length ? 'FAIL' : 'PASS',
        (missing.length ? '声明了但 patch 里没有对应行: ' + missing.join(', ') : '已声明且在 patch 里: ' + want.join(', ')) + legacy);
    }
  }
} catch (e) { add(5, '模式声明', 'FAIL', '核对失败：' + e.message); }

/* 6 本地覆盖生效（调用渲染器的 check；stdio: inherit 避开管道 ✓）
 * ⚠️ `--json` 模式下**不能** inherit：check 的"✗ 期望/实际"会直接打在 stdout 上、
 *    和 JSON 混在一起 ⇒ 机器侧 `JSON.parse(stdout)` 必失败（实测：stdout 首行变成
 *    `✗ permission.defaultPreset：…` ✗）。故 JSON 模式把子进程的 stdout 改道到父进程的
 *    **stderr**（仍是 fd 复用、不开管道 ✓）：人看的那份明细一点不少，只是走 stderr。 */
try {
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'dsh-embedded-overrides.js'), 'check', '--home', HOME],
    { stdio: JSON_MODE ? ['ignore', 2, 2] : 'inherit' });
  add(6, '本地覆盖生效', 'PASS', 'overrides 与 patch 文件一致 ✓');
} catch (e) {
  add(6, '本地覆盖生效', fs.existsSync(path.join(HOME, '.embedded-overrides.json')) ? 'FAIL' : 'UNKNOWN',
    fs.existsSync(path.join(HOME, '.embedded-overrides.json'))
      ? (JSON_MODE ? '见 stderr 上 check 的明细' : '见上面 check 的明细')
      : '没有 overrides 文件（= 没有本地覆盖要核对 ✓）');
}

/* 8 注入链完好（问正在运行的应用；没运行 ⇒ UNKNOWN ✓）
 * ⚠️ 只在"被自检的这个实例**就是**正在跑的那个"时才问 ✗：`mm-cli dsh-status` 走的
 *    是**真实 userData**（并且会往那里写一条 `mm-control.json` 命令，见 src/control.js），
 *    与 `--home` 无关 ⇒ 拿别的 home 跑（比如单测的临时目录）会 ① 把**别人**的状态
 *    报成本实例的状态、② 顺手写真实 userData。两者都不是我们要的，故此时直接判 UNKNOWN ✓。 */
if (path.resolve(USERDATA) !== path.resolve(LIVE_USERDATA)) {
  add(8, '注入链完好', 'UNKNOWN', '--home 指向的实例不是正在运行的那个（userData=' + USERDATA
    + '）⇒ dsh-status 只会答**别人的**状态 ✗，故不问（去掉 --home 才对现网实例有意义）');
} else try {
  const out = execFileSync(process.execPath, [path.join(REPO, 'cli', 'mm-cli.js'), 'dsh-status', '--json'], { encoding: 'utf8', timeout: 15000 });
  const st = JSON.parse(out);
  const okChain = st.narrow && st.narrow.mode && st.rightbarWatcher;
  add(8, '注入链完好', okChain ? 'PASS' : 'FAIL',
    'narrow.mode=' + (st.narrow && st.narrow.mode) + ' rightbarWatcher=' + st.rightbarWatcher
    + '（任一为 null = 注入链断了 ✗，不是"没开右栏"）');
} catch (e) { add(8, '注入链完好', 'UNKNOWN', '应用没在运行或 dsh-status 取不到（未跑 ≠ 通过 ✗）'); }

/* 9 内核事实：右栏真能开 —— 需要真实点击，判不了 ✓ */
add(9, '内核事实（右栏真能开）', 'UNKNOWN', '人工：把侧栏拖到 900 ⇒ 点「打开侧边栏」⇒ 再读 dsh-status 看 rightbarOpen/autoWide');

/* 10 状态未被污染 —— 真实字段是 `path`（旧代码取 `d.target || d.rel`，两个都不存在 ✗）
 * 两处**实测**修正：
 *  ① 字段名：旧写法对真回执恒取到 undefined ⇒ 恒判 PASS，是个**空转的绿** ✗；
 *  ② 只认**首段**目录：载荷里本来就有 `@linxin666/dsh-client-ui-task-board/`、
 *     `.bin/dsh-cost-meter-repair-sessions*` 这类"名字里带状态目录字样"的插件文件
 *     （按子串匹配实测命中 191 项）⇒ 子串匹配会把**正常载荷**判成污染 ✗。
 *  本项问的是"dsh-home 根下这几个状态目录有没有被搬进载荷"，故判据 = 相对路径的**首段**
 *  （与台账第 10 项同一口径）✓。`skin-center` 没写在台账那一行里，就不纳入 ——
 *  判据必须与台账逐字对齐，否则又多一份会漂移的副本 ✗。 */
const STATE_DIRS = ['sessions', 'storages', 'dsh-usage', 'task-board', 'skills'];
if (receipt && Array.isArray(receipt.deployed)) {
  const rels = receipt.deployed.map((d) => (d && typeof (d.path || d.target || d.rel) === 'string' ? String(d.path || d.target || d.rel) : '')).filter(Boolean);
  if (!rels.length) {
    add(10, '状态未被污染', 'UNKNOWN', '回执 deployed[] 里没有可读的 path 字段（回执结构变了 ⇒ **判不了**，不许当通过 ✗）');
  } else {
    const bad = rels.filter((r) => STATE_DIRS.includes(r.replace(/\\/g, '/').split('/')[0]));
    add(10, '状态未被污染', bad.length ? 'FAIL' : 'PASS', bad.length
      ? '被写入了状态目录：' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' 等 ' + bad.length + ' 项' : '')
      : '回执 ' + rels.length + ' 项里没有首段为状态目录（' + STATE_DIRS.join(' / ') + '）的 ✓');
  }
} else { add(10, '状态未被污染', 'UNKNOWN', '没有回执可查'); }

/* 汇总 */
if (JSON_MODE) { console.log(JSON.stringify(results, null, 2)); }
else {
  const icon = { PASS: '✓', FAIL: '✗', UNKNOWN: '?' };
  console.log('== 内置 DSH 升级后自检（只读）==');
  console.log('  dsh-home: ' + HOME);
  for (const r of results) console.log('  ' + icon[r.state] + ' [' + r.state + '] ' + r.no + '. ' + r.name + ' —— ' + r.detail);
  const f = results.filter((r) => r.state === 'FAIL').length;
  const u = results.filter((r) => r.state === 'UNKNOWN').length;
  console.log('  ---- PASS ' + (results.length - f - u) + ' / FAIL ' + f + ' / UNKNOWN ' + u
    + (u ? '（UNKNOWN ≠ 通过 ✗）' : '') + ' ----');
}
process.exit(results.some((r) => r.state === 'FAIL') ? 1 : 0);
