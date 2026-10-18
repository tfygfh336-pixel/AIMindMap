#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-assembly-probe.js — 「这个 id 能不能被 profile patch 打到？」
 * ------------------------------------------------------------
 * **它能回答的四件事**（都是它真的算得出来的）：
 *   ① **id 在不在运行时合成树里** —— 不在 ⇒ patch 打不到，loader 只 warn `patch: entry … not found`。
 *   ② **它在不在补丁的命中面上** —— 命中面 = 顶层行 + 顶层可达的 `group: true` 行（其 `config` 是**列表**）
 *      递归下去的子行。依据是 `applyEntryPatches` 的 `buildMap`
 *      （`cordis-plugin-include/src/index.ts:57-70`：`entryMap` 只收顶层 entries，递归**仅当** `entry.group`
 *      且 `Array.isArray(entry.config)`）⇒ `preset-*.config.plugins[]` 这类内联行**不在命中面上**。
 *   ③ **这一行的 `disabled` 是字面量还是表达式** —— 三态：`literal-true` / `literal-false` / `expr`
 *      （+ `absent` = 没写这个键）。`expr` 时**逐字保留原文**，**不猜真假**（理由见下）。
 *   ④ **打上一条补丁后合成树到底变了哪几行** —— 唯一硬证据是**合成结果的逐行 diff**，
 *      不是对装配文件的推断（`--patch`）。
 *
 * ⚠️ **它明确不回答什么**（写在这里，免得被当成能回答 —— 这一节是本批补的）：
 *   · **`!!js` 表达式的运行期真假**。`disabled: !!js …` 由 cordis 在装载时求值，上下文是**运行期的
 *     loader ctx**（`cordis-plugin-loader/src/config/entry.ts:87-95` 的 `disabledOf()`：
 *     `isJsExpr(options.disabled) ? Boolean(this.evaluate(expr)) : Boolean(options.disabled)`）。
 *     本探针只拿到 `--dump-config` 的**原文**；在没有真 ctx 的情况下求值就是**猜**
 *     ⇒ 一律记 `expr` 并保留原文。**"给个明确答案"不是本探针的职责，把不确定伪装成确定才是真正的错。**
 *     运行期口径的**唯一**来源是运行期自己：`@deepseek-ai/dsh-agent-preset-registry` 的 composition
 *     inventory（`lib/types/composition-inventory.d.ts:4-8`：`CompositionRowEnablement = boolean | 'conditional'`
 *     —— 求值器一抛异常就记 `'conditional'`，**不猜**，与本探针同一套纪律）。
 *   · **有效 disabled（含祖先）**。loader 的 `get disabled()` 逐级向上（`entry.ts:73-79`：任何祖先 disabled
 *     ⇒ 整支 disabled）。本探针只报**该行自己**的三态 + 祖先链，不替运行期合并。
 *   · **请求的 bundle 是否真的挂上**。隔离 home 里没有 `node_modules`，第三方 bundle 解析不到会被
 *     `--dump-config` **跳过**（stderr 逐条说明）⇒ 树里只有层标签点名的那些层。本探针把
 *     「bundles(请求)」「真挂上的层」「被跳过的」**分三行**打印，不许把请求当覆盖。

 * **它为什么存在**：DSH 的装配是**多层 patch 叠出来的**，"能不能改到某个插件"看装配文件看不出来：
 *   1. **profile patch 穿不透 agent preset 的挂载面**：`mountPreset` 自己建一棵子树
 *      （`dsh-agent-preset-registry/lib/index.js:262`，调用点 `:534` 是 `scope.ctx.extend(...)`），
 *      而 patch 只作用在**声明行**（`preset-*` 那几行）上 —— 声明里的 `config.plugins[]` 不在 `buildMap` 的
 *      索引面上。⚠️ 旧注释引的 `dsh-agent-presets/lib/types/mount.js:343-360` **在本运行包里已不存在**
 *      （那是个不存在的包名，本批实测复核后改成上面这条）。
 *   2. **同名多行会让补丁命中"你以为的那行之外的一行"**：`buildMap` 用 `Map.set(id, entry)`
 *      ⇒ 同 id 多行时**最后被索引的那行**胜出（不是第一行）。典型代表：`compaction-basic` 在顶层是
 *      `disabled: true` 死行（`dsh-base/cordis.patch.yml:340` insert、`dsh-web-app/cordis.patch.yml:506-507`
 *      disable），而**活实例**在 preset 里 ⇒ 补丁命中的是那行死的，**连 warn 都不会有**。
 *   3. **preset 内联行与顶层行"打不到"的表象相同、原因不同**：本探针的 stdout 会**分开点名**。
 *
 * ⇒ 本探针**不问装配文件怎么写的**，而是**问运行时的合成结果**：在一个**隔离 home** 里让
 * `dsh --profile <name> --dump-config` 把合成后的 host 装配树打出来，据此回答上面①–④。
 *
 * ⚠️ **为什么必须在隔离 home 里跑**：`--dump-config` 会**无条件重写** `profiles/<name>/cordis.yml`
 * （`profile-boot-*.js:206-211` 的 `prepareProfile`）。实测**直接对真实 home 跑会 EPERM**
 * —— 同一路径同一时刻 **PowerShell 能写、vendor 的 `node.exe` 不能**，是**子进程**受到的写限制。
 * 隔离 home 放在**工作区内**（默认 `.review/dsh-probe/`）⇒ 子进程可写、**用户实例零写入**、回滚=删目录。
 *
 * 用法：
 *   node scripts/dsh-assembly-probe.js                          # 汇总（三态 / 命中面 / preset 内联行 / 表达式逐行）
 *   node scripts/dsh-assembly-probe.js --probe compaction-basic # 这个 id 打得到吗？同 id 有几行？disabled 是什么？
 *   node scripts/dsh-assembly-probe.js --patch <file.yml>       # 打补丁，报"合成树到底变了哪几行"
 *   node scripts/dsh-assembly-probe.js --profile web --json --keep
 * 退出码：0 = 探针跑通；1 = 环境/参数问题（vendor 缺失、dump 失败、路径错）。
 *         **"某 id 打不到"不是失败** —— 那是探针要报告的**结论**，仍 exit 0。
 *
 * 判定只写一处（H1）：行的**缩进口径**与 `disabled` **三态**只在 `parseRows` 里算；
 * `dsh-fixture-freshness.js` 的 `readRows` 是**它的薄适配器**（不再另抄一套正则）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'dsh');
const NODE_EXE = path.join(VENDOR, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const BIN_JS = path.join(VENDOR, 'app', 'lib', 'bin.js');
const DSH_HOME = path.join(process.env.APPDATA || '', 'AI MindMap', 'dsh-home');
/** preset 声明行的模块名（`- id: preset-* / name: '@deepseek-ai/dsh-agent-preset'`） */
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset';

/* ---------------- 行规则：**唯一实现**（缩进口径 + disabled 三态） ----------------
 * 口径三条（每条都对应一次实测踩坑）：
 *   1. `- id:` 起一行；`name:` / `disabled:` / `group:` / `config:` 只认**该行自己那一级**（缩进 = 行缩进+2）。
 *      嵌套行（`preset-*.config.plugins[]`）也带同名键，按"任意一条"读会张冠李戴。
 *   2. `disabled` 的值**分三态**：`true` / `false` 是字面量，其余一律 `expr`（含 `!!js …`、含 `"true"`）。
 *      旧实现只认 `/^\s*disabled:\s*true\s*$/` ⇒ `!!js` 行被读成**启用**（实测 18 行全读错）。
 *   3. **不看就不说**：`expr` 不猜真假，原文逐字保留。 */
const ROW_RE = /^(\s*)- id:\s*(\S.*?)\s*$/;
const NAME_RE = /^(\s*)name:\s*['"]?([^'"\s]+)['"]?\s*$/;
const DISABLED_RE = /^(\s*)disabled:\s*(.+?)\s*$/;
const GROUP_RE = /^(\s*)group:\s*true\s*$/;
const CONFIG_RE = /^(\s*)config:\s*$/;

/** `disabled` 原值 → 三态（纯函数；`null` = 没写这个键） */
function disabledStateOf(raw) {
  if (raw === null || raw === undefined) return 'absent';
  const s = String(raw).trim();
  if (s === 'true') return 'literal-true';
  if (s === 'false') return 'literal-false';
  return 'expr';
}

/**
 * 解析 entry-list 风格的 YAML 文本（合成树 dump 或 preset patch 文件）。
 * **纯函数**（无 I/O、无求值）。每个 `- id:` 一行，返回：
 * @returns {Array<{id:string, line:number, indent:number, depth:number, name:string|null,
 *   disabledState:'literal-true'|'literal-false'|'expr'|'absent', disabledRaw:string|null,
 *   group:boolean, configIndent:number|null, ancestors:string[], ancestorLines:number[],
 *   children:Array}>}  `depth` = 祖先行数（0 = 顶层）。
 */
function parseRows(text) {
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  const rows = [];
  const stack = [];                     // 当前祖先链 [{indent, row}]
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = ROW_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const id = m[2].replace(/^['"]|['"]$/g, '');
      cur = {
        id, line: i + 1, indent, depth: stack.length,
        name: null, disabledRaw: null, disabledState: 'absent',
        group: false, configIndent: null,
        ancestors: stack.map((s) => s.row.id),
        ancestorLines: stack.map((s) => s.row.line),
        children: []
      };
      if (stack.length) stack[stack.length - 1].row.children.push(cur);
      rows.push(cur);
      stack.push({ indent, row: cur });
      continue;
    }
    if (!cur) continue;
    const own = cur.indent + 2;         // ★ 只认该行自己那一级
    let k;
    if ((k = NAME_RE.exec(line)) && k[1].length === own && cur.name === null) { cur.name = k[2]; continue; }
    if ((k = DISABLED_RE.exec(line)) && k[1].length === own) {
      if (cur.disabledRaw === null) { cur.disabledRaw = k[2]; cur.disabledState = disabledStateOf(k[2]); }
      continue;
    }
    if ((k = GROUP_RE.exec(line)) && k[1].length === own) { cur.group = true; continue; }
    if ((k = CONFIG_RE.exec(line)) && k[1].length === own && cur.configIndent === null) { cur.configIndent = own; continue; }
  }
  return rows;
}

/** 该行的 `config:` 是不是**列表**（`config:` 下一层直接就是 `- id:`）—— 与 `buildMap` 的 `Array.isArray(entry.config)` 同义 */
function isConfigSequence(row) {
  return row.children.length > 0 && row.configIndent !== null && row.children[0].indent === row.indent + 4;
}

/**
 * 合成树 → 判定模型（纯函数）。**所有判定都在这里算一次**，输出（文本 / JSON）只负责排版。
 * @returns {{
 *   rows:Array, topLevel:Array, nested:Array, layerLabels:string[],
 *   indexOrder:Array, indexedIds:Set<string>, unreachable:Array, presetInline:Array,
 *   presetGroups:Array<{preset:string, ids:string[], rows:Array}>,
 *   counts:{rows:number, topLevel:number, nested:number,
 *     disabled:{'literal-true':number,'literal-false':number,expr:number,absent:number}}
 * }} `indexOrder` = `buildMap` 的**索引顺序**（同 id 多行时**最后一个**胜出 —— 补丁命中的是它）。
 */
function parseComposed(text) {
  const rows = parseRows(text);
  const layerLabels = [];
  for (const line of String(text === null || text === undefined ? '' : text).split(/\r?\n/)) {
    if (/^#\s*==/.test(line)) layerLabels.push(line.replace(/^#\s*==\s*/, '').trim());
  }
  const topLevel = rows.filter((r) => r.depth === 0);
  const nested = rows.filter((r) => r.depth > 0);

  // 补丁的命中面：顶层行 + 顶层可达的 group（config 为列表）递归子行。顺序与 buildMap 一致。
  const indexOrder = [];
  const walk = (list) => {
    for (const r of list) {
      indexOrder.push(r);
      if (r.group && isConfigSequence(r)) walk(r.children);
    }
  };
  walk(topLevel);
  const indexedIds = new Set(indexOrder.map((r) => r.id));
  const reachable = new Set(indexOrder.map((r) => r.line));

  const presetInline = rows.filter((r) => r.ancestorLines.some((ln) => {
    const a = rows.find((x) => x.line === ln);
    return a && a.name === PRESET_PLUGIN;
  }));
  const presetGroups = [];
  for (const r of presetInline) {
    const holder = r.ancestorLines
      .map((ln) => rows.find((x) => x.line === ln))
      .filter((a) => a && a.name === PRESET_PLUGIN)[0];
    const key = holder ? holder.id : '(未知 preset)';
    let g = presetGroups.filter((x) => x.preset === key)[0];
    if (!g) { g = { preset: key, ids: [], rows: [] }; presetGroups.push(g); }
    g.ids.push(r.id);
    g.rows.push(r);
  }

  const counts = {
    rows: rows.length, topLevel: topLevel.length, nested: nested.length,
    disabled: { 'literal-true': 0, 'literal-false': 0, expr: 0, absent: 0 }
  };
  for (const r of rows) counts.disabled[r.disabledState] += 1;

  return {
    rows, topLevel, nested, layerLabels, indexOrder, indexedIds,
    unreachable: rows.filter((r) => !reachable.has(r.line)),
    presetInline, presetGroups, counts
  };
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

/** 合成树层标签 → 真挂上的 layer 包名（`# == @scope/pkg` 或 `# == @scope/pkg, patched by @scope/other`） */
function layerPackages(layerLabels) {
  const set = new Set();
  for (const l of layerLabels || []) {
    const cleaned = String(l).replace(/,\s*patched by\s+.*$/, '');
    const m = /^\s*((?:@[\w.-]+\/)?[\w.-]+)\s*$/.exec(cleaned);
    if (m) set.add(m[1]);
  }
  return [...set];
}

/**
 * preset 声明 id 的分类（纯函数）。判定口径：
 *   · `patchable`   = preset 文件里**顶层**声明、且**在补丁命中面上**的 id（补丁打得到它）
 *   · `unreachable` = preset 文件里有、但**不在命中面上**的 id（打不到；其中嵌套声明的是常态）
 *   · `notInTreeAtAll` = 合成树里**连嵌套都没有**的（loader 只会 warn `patch: entry … not found`）
 * @param {Array<{file:string, text:string}>} presetDocs
 * @param {{indexedIds:Set<string>, rows:Array}} composed
 * @returns {{status:'ok'|'no-preset-files', files:string[], topLevelIds:string[], nestedIds:string[],
 *   patchable:string[], unreachable:string[], notInTreeAtAll:string[]}}
 *   ⚠️ `status:'no-preset-files'` **不是"没有独有 id"** —— 是一个文件都没读到（旧实现静默打成「（无）」）。
 */
function classifyPresetOnly(presetDocs, composed) {
  const files = (presetDocs || []).map((d) => d.rel || d.file);
  if (!files.length) {
    return { status: 'no-preset-files', files: [], topLevelIds: [], nestedIds: [],
      patchable: [], unreachable: [], notInTreeAtAll: [] };
  }
  const topLevelIds = new Set(), nestedIds = new Set();
  for (const doc of presetDocs) {
    for (const r of parseRows(doc.text)) (r.depth === 0 ? topLevelIds : nestedIds).add(r.id);
  }
  const indexed = (composed && composed.indexedIds) || new Set();
  const inTree = new Set(((composed && composed.rows) || []).map((r) => r.id));
  const all = [...new Set([...topLevelIds, ...nestedIds])].sort();
  return {
    status: 'ok', files,
    topLevelIds: [...topLevelIds].sort(), nestedIds: [...nestedIds].sort(),
    patchable: [...topLevelIds].filter((id) => indexed.has(id)).sort(),
    unreachable: all.filter((id) => !indexed.has(id)),
    notInTreeAtAll: all.filter((id) => !inTree.has(id))
  };
}

/** 发现 preset 文件：每个 layer 包目录下的 `presets/*.patch.yml`（vendor 侧 + 用户 home 侧）。
 *  ⚠️ 旧实现写死 `@deepseek-ai/dsh-agent-presets/presets/<preset>/agent.cordis.yml` —— 本运行包里
 *  **没有这个包**，`readdirSync` 抛 ENOENT 被静默吞掉 ⇒ 那段判定一直在空转。 */
function discoverPresetFiles(profile, layerPkgs) {
  const roots = [
    path.join(VENDOR, 'app', 'node_modules'),
    path.join(DSH_HOME, 'profiles', profile, 'node_modules')
  ];
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const pkg of layerPkgs) {
      const dir = path.join(root, pkg, 'presets');
      let names;
      try { names = fs.readdirSync(dir).sort(); } catch (e) { continue; }
      for (const n of names) {
        if (!/\.patch\.yml$/.test(n)) continue;
        const file = path.join(dir, n);
        if (seen.has(file)) continue;
        seen.add(file);
        out.push({ pkg, file, rel: path.relative(ROOT, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') });
      }
    }
  }
  return out;
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

/** 跑一次 `--dump-config`。**stdout 与 stderr 分开**：正文只解析 stdout
 *  （旧实现把 stderr 拼进正文 ⇒ diff 里会混进含临时目录路径的告警行）。 */
function dumpConfig(home, profile) {
  const r = spawnSync(NODE_EXE, [BIN_JS, '--profile', profile, '--dump-config'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { DSH_HOME: home })
  });
  const stderr = r.stderr || '';
  const skipped = (stderr.match(/skipping profile bundle "[^"]+"/g) || [])
    .map((s) => /"([^"]+)"/.exec(s)[1]);
  return { code: r.status, stdout: r.stdout || '', stderr, skipped };
}

/** `disabled` 三态的打印文案（**expr 只说"运行期决定"，绝不给真假**） */
function disabledLabel(row) {
  switch (row.disabledState) {
    case 'literal-true': return 'literal-true（**disabled**）';
    case 'literal-false': return 'literal-false（启用）';
    case 'expr': return '**expr（表达式，运行期决定）**';
    default: return 'absent（没写这个键 ⇒ 默认启用）';
  }
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
    // 只读地推断 bundles（照抄真实 profile 的 bundle 清单；探针不猜用户的 profile）
    const realPkg = path.join(DSH_HOME, 'profiles', args.profile, 'package.json');
    let bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    try {
      const j = JSON.parse(fs.readFileSync(realPkg, 'utf8'));
      const b = j && j.dsh && j.dsh.profile && j.dsh.profile.bundles;
      if (Array.isArray(b) && b.length) bundles = b;
    } catch (e) { /* 读不到就用默认两层 */ }
    makeIsolatedHome(home, args.profile, bundles);

    const base = dumpConfig(home, args.profile);
    if (base.code !== 0) {
      console.error('error: --dump-config 失败（exit ' + base.code + '）\n'
        + (base.stderr || base.stdout).split('\n').slice(0, 8).join('\n'));
      process.exit(1);
    }
    const composed = parseComposed(base.stdout);
    const startedLayers = layerPackages(composed.layerLabels);

    let patched = null, diff = null, patchRun = null;
    if (args.patch) {
      const p = path.resolve(args.patch);
      if (!fs.existsSync(p)) { console.error('error: --patch 文件不存在: ' + p); process.exit(1); }
      fs.writeFileSync(path.join(home, 'profiles', args.profile, 'cordis.patch.yml'), fs.readFileSync(p));
      const r = dumpConfig(home, args.profile);
      if (r.code !== 0) { console.error('error: 打完补丁后 --dump-config 失败\n' + (r.stderr || r.stdout).split('\n').slice(0, 8).join('\n')); process.exit(1); }
      patchRun = r;
      patched = parseComposed(r.stdout);
      diff = diffLines(base.stdout, r.stdout);
    }

    // preset 文件：按**层标签里的包名**发现（旧实现写死了一个不存在的目录）
    const presetDocs = discoverPresetFiles(args.profile, startedLayers);
    const presetReport = classifyPresetOnly(presetDocs, composed);

    const probeRows = args.probe ? composed.rows.filter((r) => r.id === args.probe) : [];
    const probeTarget = args.probe
      ? composed.indexOrder.filter((r) => r.id === args.probe).pop() || null : null;   // buildMap: 最后索引者胜出

    if (args.json) {
      process.stdout.write(JSON.stringify({
        profile: args.profile, home,
        bundles: {
          requested: bundles, started: startedLayers,
          startedFromLayerLabels: composed.layerLabels.filter((l, i, a) => a.indexOf(l) === i),
          skipped: base.skipped
        },
        composed: {
          rows: composed.counts.rows, topLevel: composed.counts.topLevel, nested: composed.counts.nested,
          disabled: composed.counts.disabled,
          patchReachableRows: composed.indexOrder.length,
          patchUnreachableRows: composed.unreachable.length
        },
        exprRows: composed.rows.filter((r) => r.disabledState === 'expr')
          .map((r) => ({ id: r.id, line: r.line, depth: r.depth, ancestors: r.ancestors, disabledRaw: r.disabledRaw })),
        presetInline: {
          count: composed.presetInline.length,
          byPreset: composed.presetGroups.map((g) => ({ preset: g.preset, count: g.rows.length, ids: g.ids }))
        },
        presetOnlyIds: presetReport,
        probe: args.probe ? {
          id: args.probe,
          inComposedTree: probeRows.length > 0,
          occurrences: probeRows.length,
          inPatchReach: !!probeTarget,
          patchTarget: probeTarget ? {
            line: probeTarget.line, indent: probeTarget.indent, depth: probeTarget.depth,
            ancestors: probeTarget.ancestors, name: probeTarget.name,
            disabledState: probeTarget.disabledState, disabledRaw: probeTarget.disabledRaw
          } : null,
          rows: probeRows.map((r) => ({
            line: r.line, indent: r.indent, depth: r.depth, ancestors: r.ancestors, name: r.name,
            disabledState: r.disabledState, disabledRaw: r.disabledRaw
          }))
        } : null,
        patchDiff: diff ? {
          added: diff.added.length, removed: diff.removed.length,
          addedLines: diff.added, removedLines: diff.removed,
          stderrSkippedBundles: patchRun ? patchRun.skipped : []
        } : null
      }, null, 2) + '\n');
      return;
    }

    const out = [];
    out.push('DSH 装配探针（隔离 home：' + home + '）');
    out.push('  profile = ' + args.profile);
    out.push('  bundles(请求, ' + bundles.length + ') = ' + bundles.join(', '));
    out.push('  真挂上的层(' + startedLayers.length + ', 来自层标签) = ' + (startedLayers.join(', ') || '（无）'));
    if (base.skipped.length) {
      out.push('  ⚠️ 跳过 ' + base.skipped.length + ' 个 bundle（隔离 home 里解析不到；`--dump-config` 的 stderr 逐条说明）：');
      base.skipped.forEach((b) => out.push('     · ' + b));
      out.push('     ⇒ 本树**不含**它们 —— 别把上面「请求」那行当覆盖面包。');
    }
    out.push('');
    out.push('合成后的装配树：' + composed.counts.rows + ' 行（顶层 ' + composed.counts.topLevel
      + ' / 嵌套 ' + composed.counts.nested + '）');
    out.push('  disabled 三态（**只看该行自己，不求值**）：');
    out.push('    literal-true  ' + String(composed.counts.disabled['literal-true']).padStart(4));
    out.push('    literal-false ' + String(composed.counts.disabled['literal-false']).padStart(4));
    out.push('    expr          ' + String(composed.counts.disabled.expr).padStart(4) + '   ← 运行期决定；本探针只保留原文');
    out.push('    未声明        ' + String(composed.counts.disabled.absent).padStart(4));
    if (composed.counts.disabled.expr) {
      out.push('  ⚠️ `expr` 行的**有效** disabled 还要看祖先（loader 的 `get disabled()` 逐级向上，'
        + '`cordis-plugin-loader/src/config/entry.ts:73-79`）—— 本探针只报该行自己，不替运行期合并。');
    }
    out.push('');
    out.push('一、补丁的命中面（`buildMap`：顶层行 + 顶层可达的 `group: true` 行里 `config` 列表的递归子行）');
    out.push('  命中面上：' + composed.indexOrder.length + ' 行 / ' + composed.indexedIds.size + ' 个不同 id');
    out.push('  不在命中面上：' + composed.unreachable.length + ' 行'
      + (composed.unreachable.length === composed.presetInline.length
        ? '（全部是 **preset 内联行**：`preset-*.config.plugins[]`）'
        : '（其中 preset 内联行 ' + composed.presetInline.length + ' 行）'));
    if (composed.presetGroups.length) {
      out.push('');
      out.push('二、preset 内联行（补丁**打不到**；按 id 打它只会"什么都没发生"，连 warn 都没有）');
      for (const g of composed.presetGroups) {
        out.push('  · ' + g.preset + '：' + g.rows.length + ' 行 —— ' + g.ids.join(', '));
      }
      out.push('  依据：`cordis-plugin-include/src/index.ts:57-70` 的 `buildMap` 只递归 `group: true` 且');
      out.push('        `config` 为**列表**的行；preset 声明行的 `config.plugins[]` 不在索引面上。');
    }
    out.push('');
    out.push('三、preset 文件里有、但**不在命中面上**的 id（补丁打不到）');
    if (presetReport.status === 'no-preset-files') {
      out.push('  ⚠️ **未判定** —— 一个 preset 文件都没读到（按层标签的包名找 `presets/*.patch.yml`）。');
      out.push('     **这不是「没有独有 id」**：缺证据时本探针不下这个结论（旧版在这里打成「（无）」）。');
    } else {
      out.push('  文件(' + presetReport.files.length + ') = ' + presetReport.files.join(', '));
      out.push('  顶层声明且可打：' + (presetReport.patchable.join(', ') || '（无）'));
      out.push('  打不到(' + presetReport.unreachable.length + ')：' + (presetReport.unreachable.join(', ') || '（无）'));
      out.push('  合成树里完全没有（loader 只会 warn `patch: entry … not found`）：'
        + (presetReport.notInTreeAtAll.join(', ') || '（无）'));
    }
    const exprRows = composed.rows.filter((r) => r.disabledState === 'expr');
    if (exprRows.length) {
      out.push('');
      out.push('四、`disabled: !!js …` 逐行（' + exprRows.length + ' 行，**原文照抄、不求值、不猜真假**）');
      for (const r of exprRows) {
        const where = r.depth === 0 ? '顶层' : '嵌套 depth=' + r.depth + ' 祖先 ' + r.ancestors.join(' › ');
        out.push('  · 行 ' + String(r.line).padStart(4) + '  ' + r.id + '（' + where + '）  disabled: ' + r.disabledRaw);
      }
    }
    if (args.probe) {
      out.push('');
      out.push('探针 --probe ' + args.probe + '：');
      if (!probeRows.length) {
        out.push('  不在合成树里 ✗ ⇒ 补丁**打不到**（loader 只会 warn `patch: entry … not found`）');
        if (presetReport.status === 'ok' && presetReport.unreachable.indexOf(args.probe) >= 0) {
          out.push('  （它在 preset 文件里有声明，但没进合成树 —— 属另一类：声明在、树里没有）');
        }
      } else {
        out.push('  在合成树里 ✓ 共 ' + probeRows.length + ' 行（顶层 ' + probeRows.filter((r) => r.depth === 0).length
          + ' / 嵌套 ' + probeRows.filter((r) => r.depth > 0).length + '）');
        const describe = (r) => '· 行 ' + String(r.line).padStart(4) + '  depth=' + r.depth
          + '  缩进 ' + r.indent + '  祖先 ' + (r.ancestors.join(' › ') || '—')
          + '  disabled: ' + (r.disabledRaw === null ? '未声明' : r.disabledRaw);
        if (!probeTarget) {
          out.push('  ⇒ 这 ' + probeRows.length + ' 行**都不在补丁命中面上** ⇒ 按 id 打补丁**改不到它**'
            + (composed.presetInline.some((r) => r.id === args.probe) ? '（它们是 preset 内联行：`preset-*.config.plugins[]`）' : '') + '：');
          probeRows.forEach((r) => out.push('     ' + describe(r)));
        } else {
          out.push('  ⇒ 补丁命中的是**第 ' + probeTarget.line + ' 行**（`buildMap` 同 id 多行时**最后索引者胜出**，'
            + '不是第一行）');
          out.push('     name=' + (probeTarget.name || '(按 id 覆盖，无 name)')
            + '  缩进 ' + probeTarget.indent + '  层级 ' + probeTarget.depth
            + (probeTarget.ancestors.length ? '  祖先 ' + probeTarget.ancestors.join(' › ') : ''));
          out.push('     disabled = ' + disabledLabel(probeTarget));
          if (probeTarget.disabledState === 'expr') {
            out.push('       原文：disabled: ' + probeTarget.disabledRaw);
            out.push('     ⇒ 补丁会命中这一行，但**它是否生效由那行表达式在运行期算出什么决定** ——');
            out.push('       本探针**不求值、不猜**（要运行期答案：见脚本头「它明确不回答什么」）。');
          } else if (probeTarget.disabledState === 'literal-true') {
            out.push('     ⇒ 它是 **disabled 死行**：补丁改得到这一行，但对活实例**零影响**'
              + '（`compaction-basic` / `tool-bash` 都是这个形状）。');
          } else {
            out.push('     ⇒ 它是启用行：补丁改得到这一行，且它当前是启用的。');
          }
          const otherLines = probeRows.filter((r) => r.line !== probeTarget.line);
          if (otherLines.length) {
            out.push('     另外 ' + otherLines.length + ' 行同名（都**不在**命中面上）：');
            otherLines.forEach((r) => out.push('       ' + describe(r)));
          }
        }
      }
    }
    if (diff) {
      out.push('');
      out.push('补丁生效范围（与基线逐行 diff，**只比 stdout**）：');
      out.push('  +' + diff.added.length + ' 行  -' + diff.removed.length + ' 行');
      diff.removed.forEach((l) => out.push('  - ' + l));
      diff.added.forEach((l) => out.push('  + ' + l));
      if (patchRun && patchRun.skipped.length) {
        out.push('  ⚠️ 打补丁后又有 ' + patchRun.skipped.length + ' 个 bundle 被跳过（不在 diff 里，见 stderr）');
      }
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

module.exports = {
  parseRows, parseComposed, diffLines, layerPackages, classifyPresetOnly,
  discoverPresetFiles, makeIsolatedHome, disabledStateOf, isConfigSequence,
  PRESET_PLUGIN
};
