#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-assembly-probe.js — 「这个 id 能不能被 profile patch 打到？」
 * ------------------------------------------------------------
 * **存在的唯一理由**：DSH 的装配是**多层 patch 叠出来的**，而"能不能改到某个插件"
 * 这件事**看装配文件是看不出来的** —— 有三条实测踩出来的坑：
 *
 *   1. **profile patch 穿不透 agent preset 的 isolate realm**。`mountPreset` 只传 `{ path }`、
 *      **没有 `patches` 键**（`dsh-agent-presets/lib/types/mount.js:343-360`），
 *      而 `Include` 施加 patch 只读 `this.config.patches`（`cordis-plugin-include/src/index.ts:315-321`）。
 *   2. **同名死行会静默吞掉补丁**：host 树里有一行 `compaction-basic`，**本来就是 `disabled: true`**
 *      （`dsh-base/cordis.patch.yml:320` insert、`dsh-web-app/cordis.patch.yml:420-431` disable），
 *      而活实例在 preset 里。补丁按 id 会命中**那行死的** —— 因为 id 存在，**连 warn 都不会有**。
 *   3. **host 树给 preset 的 id 留了"占位死行"**：`tool-goal` / `tool-workflow` 等在合成树里存在且 disabled，
 *      而 `persona` 这类 preset 独有的 id **完全不在树里**。两者"补丁打不到"的表象相同、原因不同。
 *
 * ⇒ 本探针**不问装配文件怎么写的**，而是**问运行时的合成结果**：它在一个**隔离 home** 里
 * 让 `dsh --profile <name> --dump-config` 把「合成后的 host 装配树」打出来，据此回答：
 *   · 这个 id 在合成树里吗？（不在 ⇒ patch 打不到，只 warn）
 *   · 在的话它是 host 行还是"preset 的占位死行"？（人工对照 preset 文件即可判定）
 *   · 打上一条补丁后，**合成树到底变了哪几行**？（这是"补丁生效范围"的唯一硬证据）
 *
 * ⚠️ **为什么必须在隔离 home 里跑**：`--dump-config` 会**无条件重写** `profiles/<name>/cordis.yml`
 * （`profile-boot-*.js:206-211` 的 `prepareProfile`）。实测**直接对真实 home 跑会 EPERM**
 * —— 同一路径同一时刻 **PowerShell 能写、vendor 的 `node.exe` 不能**，是**子进程**受到的写限制。
 * 隔离 home 放在**工作区内**（默认 `.review/dsh-probe/`）⇒ 子进程可写、**用户实例零写入**、回滚=删目录。
 *
 * 用法：
 *   node scripts/dsh-assembly-probe.js                          # 汇总合成树（行数/disabled 数/preset 独有 id）
 *   node scripts/dsh-assembly-probe.js --probe compaction-basic # 这个 id 能不能被打到？它是不是死行？
 *   node scripts/dsh-assembly-probe.js --patch <file.yml>       # 打补丁，报"合成树到底变了哪几行"
 *   node scripts/dsh-assembly-probe.js --profile web --json --keep
 * 退出码：0 = 探针跑通；1 = 环境/参数问题（vendor 缺失、dump 失败、路径错）。
 *         **"某 id 打不到"不是失败** —— 那是探针要报告的**结论**，仍 exit 0。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'dsh');
const NODE_EXE = path.join(VENDOR, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const BIN_JS = path.join(VENDOR, 'app', 'lib', 'bin.js');
const PRESETS_DIR = path.join(VENDOR, 'app', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets');

/** 与 `src/dsh-capabilities.js` 同一套行规则：`- id:` 起行，其后 `name:` / `disabled:` 归它 */
const ROW_RE = /^(\s*)- id:\s*(\S.*?)\s*$/;
const NAME_RE = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/;
const DISABLED_RE = /^\s*disabled:\s*true\s*$/;

/** 解析 dump 出来的合成树（纯函数）。返回 {rows, disabledCount, layerLabels} */
function parseComposed(text) {
  const lines = String(text || '').split('\n');
  const rows = [];
  const layerLabels = [];
  let cur = null;
  for (const line of lines) {
    if (/^#\s*==/.test(line)) layerLabels.push(line.replace(/^#\s*==\s*/, '').trim());
    const m = ROW_RE.exec(line);
    if (m) {
      if (cur) rows.push(cur);
      cur = { id: m[2].replace(/^['"]|['"]$/g, ''), name: null, disabled: false };
      continue;
    }
    if (!cur) continue;
    const n = NAME_RE.exec(line);
    if (n && cur.name === null) { cur.name = n[1]; continue; }
    if (DISABLED_RE.test(line)) cur.disabled = true;
  }
  if (cur) rows.push(cur);
  return { rows, disabledCount: rows.filter((r) => r.disabled).length, layerLabels };
}

/** 逐行 diff（纯函数）：返回只在新侧出现的行与只在旧侧出现的行 */
function diffLines(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const count = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m; };
  const ma = count(a), mb = count(b);
  const removed = [], added = [];
  for (const [l, n] of ma) { const d = n - (mb.get(l) || 0); for (let i = 0; i < d; i++) removed.push(l); }
  for (const [l, n] of mb) { const d = n - (ma.get(l) || 0); for (let i = 0; i < d; i++) added.push(l); }
  return { removed, added };
}

/** 读全部 preset 文件里的 id（纯函数之外的部分由调用方喂 text） */
function collectPresetIds(presetTexts) {
  const ids = new Set();
  for (const t of presetTexts) for (const r of parseComposed(t).rows) ids.add(r.id);
  return ids;
}

/** 造隔离 home（只写三个必需文件；**必须无 BOM** —— PS 的 utf8 会带 BOM 让 JSON.parse 崩） */
function makeIsolatedHome(dir, profile, bundles) {
  const pw = path.join(dir, 'profiles', profile);
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + profile, private: true, dependencies: {},
    dsh: { profile: { bundles, patchReload: 'live' } }
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(pw, 'cordis.patch.yml'), '[]\n', 'utf8');
  fs.writeFileSync(path.join(pw, 'cordis.yml'), '[]\n', 'utf8');
  return pw;
}

function dumpConfig(home, profile) {
  const r = spawnSync(NODE_EXE, [BIN_JS, '--profile', profile, '--dump-config'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { DSH_HOME: home })
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function main() {
  const argv = process.argv.slice(2);
  const args = { profile: 'web', probe: null, patch: null, json: false, keep: false, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--probe') args.probe = argv[++i];
    else if (a === '--patch') args.patch = argv[++i];
    else if (a === '--home') args.home = argv[++i];
    else { console.error('error: 未知参数 ' + a); process.exit(1); }
  }
  if (!fs.existsSync(BIN_JS) || !fs.existsSync(NODE_EXE)) {
    console.error('error: 找不到 DSH 运行包（' + VENDOR + '）\n' +
      '（vendor/dsh 是本地运行包、被 git 忽略；本探针需要它）');
    process.exit(1);
  }

  const home = args.home ? path.resolve(args.home)
    : path.join(ROOT, '.review', 'dsh-probe', 'home');   // 工作区内 ⇒ 子进程可写、用户实例零写入
  // 清理判据：**用户没指定 --home**（那是我们自己的临时目录）且没要求 --keep。
  // 不能只看"是不是我创建的" —— 上一次跑留下的目录会让 `created` 为 false，于是它永远不被清掉（实测踩到）。
  const isTemp = !args.home;
  try {
    // 只读地推断 bundles（照抄真实 profile 的两层 host bundle；探针不猜用户的 profile）
    const realPkg = path.join(process.env.APPDATA || '', 'AI MindMap', 'dsh-home', 'profiles', args.profile, 'package.json');
    let bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    try {
      const j = JSON.parse(fs.readFileSync(realPkg, 'utf8'));
      const b = j && j.dsh && j.dsh.profile && j.dsh.profile.bundles;
      if (Array.isArray(b) && b.length) bundles = b;
    } catch (e) { /* 读不到就用默认两层 */ }
    makeIsolatedHome(home, args.profile, bundles);

    const base = dumpConfig(home, args.profile);
    if (base.code !== 0) {
      console.error('error: --dump-config 失败（exit ' + base.code + '）\n' + base.out.split('\n').slice(0, 8).join('\n'));
      process.exit(1);
    }
    const composed = parseComposed(base.out);

    let patched = null, diff = null;
    if (args.patch) {
      const p = path.resolve(args.patch);
      if (!fs.existsSync(p)) { console.error('error: --patch 文件不存在: ' + p); process.exit(1); }
      fs.writeFileSync(path.join(home, 'profiles', args.profile, 'cordis.patch.yml'), fs.readFileSync(p));
      const r = dumpConfig(home, args.profile);
      if (r.code !== 0) { console.error('error: 打完补丁后 --dump-config 失败\n' + r.out.split('\n').slice(0, 8).join('\n')); process.exit(1); }
      patched = parseComposed(r.out);
      diff = diffLines(base.out, r.out);
    }

    // preset 独有 id：出现在 preset 文件里、但不在合成树里 ⇒ 补丁**打不到**
    let presetOnly = [];
    try {
      const texts = fs.readdirSync(PRESETS_DIR)
        .map((n) => path.join(PRESETS_DIR, n, 'agent.cordis.yml'))
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p, 'utf8'));
      const inTree = new Set(composed.rows.map((r) => r.id));
      presetOnly = [...collectPresetIds(texts)].filter((id) => !inTree.has(id)).sort();
    } catch (e) { /* preset 目录缺失不致命 */ }

    const probeRow = args.probe ? composed.rows.find((r) => r.id === args.probe) || null : null;

    if (args.json) {
      process.stdout.write(JSON.stringify({
        profile: args.profile, home, bundles,
        composedRows: composed.rows.length, disabledCount: composed.disabledCount,
        layerLabels: composed.layerLabels.slice(0, 8),
        presetOnlyIds: presetOnly,
        probe: args.probe ? { id: args.probe, inComposedTree: !!probeRow, row: probeRow } : null,
        patchDiff: diff ? { added: diff.added.length, removed: diff.removed.length, addedLines: diff.added, removedLines: diff.removed } : null
      }, null, 2) + '\n');
      return;
    }

    const out = [];
    out.push('DSH 装配探针（隔离 home：' + home + '）');
    out.push('  profile=' + args.profile + '  bundles=' + bundles.join(', '));
    out.push('');
    out.push('合成后的 host 装配树：' + composed.rows.length + ' 行，其中 disabled ' + composed.disabledCount + ' 行');
    if (composed.layerLabels.length) out.push('  层标签（前几个）：' + composed.layerLabels.slice(0, 3).join('  |  '));
    out.push('');
    out.push('**preset 独有 id**（在 preset 文件里有、但**不在**合成树里 ⇒ profile patch **打不到**，只有 warn）：');
    out.push(presetOnly.length ? '   ' + presetOnly.join(', ') : '   （无）');
    out.push('  注：合成树里**存在但 disabled** 的 id（如 compaction-basic / tool-goal）属另一种情况 ——');
    out.push('      补丁会命中那行**死行**，**同样改不到 preset 里的活实例**，且连 warn 都不会有。');
    if (args.probe) {
      out.push('');
      out.push('探针 --probe ' + args.probe + '：');
      if (probeRow) {
        out.push('  在合成树里 ✓  name=' + (probeRow.name || '(按 id 覆盖，无 name)')
          + '  disabled=' + probeRow.disabled);
        out.push('  ⇒ 补丁**会命中这一行**；' + (probeRow.disabled
          ? '但它是 **disabled 死行** ⇒ 改它对活实例**零影响**（这正是 compaction-basic 的处境）'
          : '它是启用行 ⇒ 补丁会真的改到它'));
      } else {
        out.push('  不在合成树里 ✗ ⇒ 补丁**打不到**（loader 只会 warn `patch: entry … not found`）');
      }
    }
    if (diff) {
      out.push('');
      out.push('补丁生效范围（与基线逐行 diff）：');
      out.push('  +' + diff.added.length + ' 行  -' + diff.removed.length + ' 行');
      diff.removed.forEach((l) => out.push('  - ' + l));
      diff.added.forEach((l) => out.push('  + ' + l));
      out.push('  ⇒ 这就是"补丁到底改了什么"的**唯一硬证据**（合成结果，不是装配文件的推断）');
    }
    console.log(out.join('\n'));
  } finally {
    if (isTemp && !args.keep) {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* 清理失败不致命 */ }
      // 顺手收掉空的父目录（否则 `.review/dsh-probe/` 会一直留着一个空壳）——
      // 只在它确实为空时删，不碰任何别的东西。
      try {
        const parent = path.dirname(home);
        if (path.basename(parent) === 'dsh-probe' && fs.existsSync(parent)
          && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      } catch (e) { /* 同上 */ }
    } else if (args.keep) {
      console.error('（已保留隔离 home：' + home + '）');
    }
  }
}

if (require.main === module) main();

module.exports = { parseComposed, diffLines, collectPresetIds, makeIsolatedHome };
