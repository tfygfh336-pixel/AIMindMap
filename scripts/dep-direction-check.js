#!/usr/bin/env node
/* ============================================================
 * scripts/dep-direction-check.js — 单向依赖门禁（门禁编号 S1）
 * ------------------------------------------------------------
 * 它守的那条约束（**声明早就有，检查一直没建**）：
 *   `docs/ARCHITECTURE.md` §4 设计原则 2 逐字写着
 *   「**分层单向**：renderer → main(IPC) → CLI → src → data；不反向依赖。」
 *
 * 为什么必须有这条门禁（不是"更严谨"，是**已经发生过的形状**）：
 *   · 这条性质**现在成立**：全量列过 `src/*.js` 的 `require`，25 个模块**零回边**、
 *     全都不指向 `renderer/` / `cli/` / `main*.js`；
 *   · 但它**没有任何东西守着** —— 任何一个会话顺手写一行
 *     `require('../renderer/app-core.js')` 就能破，而**全链照样全绿**
 *     （G1/G8/G9/V1/V2/G3/G6/G7/G4/G2/G5 没有一条扫依赖方向）。
 *   ⇒ 这正是 E6 分析稿 §3.1 甲类点名的头号缺口（判据 `A-02` / 缺口 `G-12`）：
 *     **"性质成立、检查没建"** —— 声明在文档里，等于一句愿望。
 *   它与 skill `architecture-for-ai` `A2` 的实测观察同形：`A2` 把"这条约束本身要有机械检查"
 *   写在**括号里**，于是没人建（本工程就是那个反例的现场）。
 *
 * 分层图的**唯一权威就在本文件的 `LAYERS`**（工程规矩：一份事实一处实现）。
 *   `docs/ARCHITECTURE.md` §4 只讲"为什么这么分层"，本文件是**机器可读**的那一份；
 *   两处不复制方向表（复制就是第二份会漂的副本 ✗）。改分层 = 改 `LAYERS` 一处。
 *   规则一句话：**依赖只允许朝 rank 小的方向**（同 rank 互不判）。
 *
 * 判定清单见 `analyze()` 里的 ①…③ 标记（此处刻意不写死条数：写死了就会漂）。
 *
 * 边界（诚实标注，别以为它包住一切）：
 *   · 只认**字面量**路径：`require('./x')` / `require('../a/b')` / `import x from './y'`。
 *     **动态** require（`require(path.join(__dirname, name))`、变量、模板）判不了方向 ——
 *     本门禁把它们**数出来并打印**（跳过必须可见，不许伪装成"查过且干净"）；
 *   · 只判**第一方相对路径**：裸包名（`require('fs')` / `require('electron')`）不在分层图内；
 *   · `tests/` **不在分层图内**（它天然要 require 各层，且 `scripts/cli-integration.js` 反过来
 *     要用它的 fixture）⇒ 指向 `tests/` 的边由 `EXEMPT_TARGETS` 逐条登记（带原因）；
 *   · 它查的是 `require`/`import` **边**，查不了"运行时通过 IPC / 全局对象反向调用"
 *     （那一类不在这条判据的范围内）。
 *
 * 用法：
 *   node scripts/dep-direction-check.js          判红/判绿（挂 `npm run verify` 的 S1 步）
 *   node scripts/dep-direction-check.js --list   打印分层图 + 全量边 + 在册豁免 + 动态 require 计数
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ---------------------------------------------------------------
 * 分层图（**唯一权威**）：rank 越大越靠上；依赖只允许朝 rank 小的方向；同 rank 互不判。
 *
 * 为什么 `scripts/` 与 `main` **同 rank（3）**：`docs/ARCHITECTURE.md` §1 把两者都归"接入层"
 *   （A. 人 → 界面 = renderer + main + preload；B. AI → CLI ← MCP 包装在 `scripts/`），
 *   而实现上两者**互相**有真实边：`main.js` 在冒烟路径 require `scripts/smoke-*` / `scripts/vision/*`，
 *   `scripts/dsh-prefill-stub.js` 又 require `main-dsh-sidebar.js`（一次性宿主进程复用主进程侧栏模块）。
 *   把它们判成上下级会造**必然假红**；同层（互不判方向）才是如实描述。
 * --------------------------------------------------------------- */
const LAYERS = [
  { id: 'renderer', rank: 4, name: '渲染层', re: /^renderer\// },
  { id: 'main', rank: 3, name: '主进程', re: /^(main|preload)(-[A-Za-z0-9_-]+)*\.js$/ },
  { id: 'scripts', rank: 3, name: '脚本层（工具/接入：MCP 包装、验证链、冒烟驱动）', re: /^scripts\// },
  { id: 'cli', rank: 2, name: 'CLI 层', re: /^cli\// },
  { id: 'src', rank: 1, name: '共享核心', re: /^src\// }
];

/* ---------------------------------------------------------------
 * 在册豁免（**登记在门禁侧**，不由被检查方在自己文件里写一行了事）：
 *   指向"不在分层图内"的路径必须逐条登记 + 写原因 + 在输出里可见。
 *   为什么要开这个口：不留出口 ⇒ 真合法的边会把门禁变成**必然假红**，而必然假红等于没有门禁。
 * --------------------------------------------------------------- */
const EXEMPT_TARGETS = [
  { label: 'package.json', re: /^package\.json$/, why: '`cli/main.js` 读版本号（require JSON，没有分层可言）' },
  { label: 'tests/**', re: /^tests\//, why: '`tests/` 不在分层图内：集成断言与单测**共用**的 fixture（如 tests/pdf-fixture.js）'
    + '必须能被 scripts/ 引用，而 tests/ 又要 require 各层 ⇒ 任何上下级判定都会成环' }
];

/** 允许被扫描的源码文件（第一方、非生成物） */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'vendor', 'backups', 'dist', 'dist-portable', '.git', '.review', 'projects', 'docs', 'build']);

/* ===============================================================
 * ① 去注释：门禁的输入必须是**代码**，不是散文
 *   实测教训（skill `B4` 成因②）：判据写在名字/注释里时，把代码里的判据抹掉，门禁照样绿。
 *   本门禁的对应风险反过来也要防：`src/history.js` 的文件头注释里就写着
 *   `const { UndoStack } = require('./history.js');`（用法示例）—— 不剥注释就会凭空
 *   造出一条**自指边**（假红）。所以：剥掉注释、**保留字符串**（待会儿要读路径字面量）。
 * =============================================================== */
function stripComments(src) {
  const text = String(src);
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 'code';       // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;          // 保行号：块注释里的换行照样输出
      i++; continue;
    }
    // 字符串内部：原样保留（含转义），只负责找到结束引号
    out += c;
    if (c === '\\') { if (i + 1 < n) { out += text[i + 1]; i += 2; continue; } i++; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    i++;
  }
  return out;
}

/* ===============================================================
 * ② 取边（纯函数）：字面量 require / import ⇒ { line, spec, kind }
 *    非字面量（动态）⇒ { line, kind: 'dynamic' }，只用于"数出来并打印"
 *    ⚠️ **一行里可以有多条边**：本工程的 UMD 工厂写法就是这么写的 ——
 *       `module.exports = factory(require('./tree-utils.js'), require('./convert.js'));`
 *       （实测：早期版本"每行只取第一条"漏了 5 条边，其中恰好包括 `src/schema.js → src/assoc.js`）
 * =============================================================== */
function parseEdges(src) {
  const code = stripComments(src);
  const lines = code.split(/\r?\n/);
  const out = [];
  const RE_REQ = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  const RE_IMP = /(?:^|[^\w.])import\s+(?:[\w*{},\s$]+\s+from\s+)?(['"])([^'"]+)\1/g;
  const RE_CALL = /require\s*\(|(?:^|[^\w.])import\s*\(/g;
  lines.forEach((line, idx) => {
    let found = 0;
    let m;
    RE_REQ.lastIndex = 0;
    while ((m = RE_REQ.exec(line))) { out.push({ line: idx + 1, spec: m[2], kind: 'require' }); found++; }
    RE_IMP.lastIndex = 0;
    while ((m = RE_IMP.exec(line))) { out.push({ line: idx + 1, spec: m[2], kind: 'import' }); found++; }
    RE_CALL.lastIndex = 0;
    let calls = 0;
    while (RE_CALL.exec(line)) calls++;
    // 调了 require/import 但没解析出那么多**字面量** ⇒ 至少一处是动态的（判不了方向，但要可见）
    if (calls > found) out.push({ line: idx + 1, spec: null, kind: 'dynamic' });
  });
  return out;
}

/** 一层里的文件清单（递归；只收 .js / .mjs），返回仓库相对路径（`/` 分隔） */
function collectFiles(dir, acc) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(e.name)) continue;
      collectFiles(dir + '/' + e.name, acc);
    } else if (/\.(js|mjs)$/.test(e.name)) {
      acc.push(dir + '/' + e.name);
    }
  }
  return acc;
}

/** 扫描面 = 分层图覆盖到的第一方源码（工程根本身的主进程文件 + 各层目录） */
function scanTargets() {
  const files = [];
  fs.readdirSync(ROOT, { withFileTypes: true }).forEach((e) => {
    if (e.isFile() && /\.(js|mjs)$/.test(e.name) && layerOf(e.name)) files.push(e.name);
  });
  LAYERS.forEach((l) => {
    if (l.id === 'main') return;                     // 主进程文件已在工程根收过
    collectFiles(l.id, files);
  });
  return [...new Set(files)].sort();
}

/** 某个仓库相对路径属于哪一层（不在任何层 ⇒ null） */
function layerOf(rel) {
  const r = String(rel).replace(/\\/g, '/');
  return LAYERS.filter((l) => l.re.test(r))[0] || null;
}

/** 把 require 的路径字面量解析成仓库相对路径（像 Node 一样补 .js / /index.js；不存在也照算） */
function resolveSpec(fromRel, spec) {
  if (!spec) return null;
  if (!spec.startsWith('.')) return null;            // 裸包名：不在分层图内
  const base = path.posix.dirname(String(fromRel).replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(base, spec));
  const cands = [joined, joined + '.js', joined + '.mjs', joined + '/index.js'];
  for (const c of cands) {
    if (fs.existsSync(path.join(ROOT, c))) {
      try { if (fs.statSync(path.join(ROOT, c)).isFile()) return c; } catch (e) { /* 读不到就按原样算 */ }
    }
  }
  return joined;
}

/* ===============================================================
 * ③ 判定（纯函数，便于单测）
 * =============================================================== */
/** 反向边：目标层比来源层**更靠上**（rank 更大）即违反"依赖只朝下" */
function findReverseEdges(edges) {
  const bad = [];
  edges.forEach((e) => {
    const a = layerOf(e.from);
    const b = layerOf(e.to);
    if (!a || !b) return;
    if (b.rank > a.rank) bad.push({ ...e, fromLayer: a, toLayer: b });
  });
  return bad;
}

/** 同一个 rank 里成环（跨 rank 的环在"只朝下"成立时不可能；同层可能） */
function findCycles(edges) {
  const adj = new Map();
  edges.forEach((e) => {
    const a = layerOf(e.from);
    const b = layerOf(e.to);
    if (!a || !b || a.rank !== b.rank) return;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  });
  const cycles = [];
  const seen = new Set();
  const stack = [];
  const inStack = new Set();
  const walk = (node) => {
    if (inStack.has(node)) {
      const at = stack.indexOf(node);
      const cyc = stack.slice(at).concat(node);
      // 去重：同一个环从任一节点起步都会被走到 ⇒ 用"环上节点集合"当键（末尾那个是起点重复）
      const key = cyc.slice(0, -1).slice().sort().join('>');
      if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
      return;
    }
    if (stack.includes(node)) return;
    stack.push(node); inStack.add(node);
    (adj.get(node) || []).forEach(walk);
    stack.pop(); inStack.delete(node);
  };
  [...adj.keys()].sort().forEach(walk);
  return cycles;
}

/** 目标不在分层图内且没登记豁免 ⇒ 判红（不许静默放过：谁都得有个家） */
function findUnownedTargets(edges, targets) {
  const out = [];
  edges.forEach((e) => {
    if (layerOf(e.to)) return;
    if (targets.some((t) => t.re.test(e.to))) return;
    out.push(e);
  });
  return out;
}

/** 汇总：读磁盘 → 边 → 三类问题 */
function analyze() {
  const files = scanTargets();
  const edges = [];
  const dynamic = [];
  const unreadable = [];
  files.forEach((rel) => {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
    catch (e) { unreadable.push({ rel, why: e.code || e.message }); return; }
    parseEdges(src).forEach((ed) => {
      if (!ed.spec) { dynamic.push({ from: rel, line: ed.line, kind: ed.kind }); return; }
      const to = resolveSpec(rel, ed.spec);
      if (!to) return;                                // 裸包名：不在图内
      edges.push({ from: rel, to, line: ed.line, spec: ed.spec, kind: ed.kind });
    });
  });
  return {
    files,
    edges,
    dynamic,
    unreadable,
    reverse: findReverseEdges(edges),
    cycles: findCycles(edges),
    unowned: findUnownedTargets(edges, EXEMPT_TARGETS)
  };
}

function layerLine(l) {
  return '  rank ' + l.rank + '  ' + l.id.padEnd(9) + l.name;
}

function main() {
  const list = process.argv.includes('--list');
  const r = analyze();
  if (list) {
    console.log('== 分层图（唯一权威 = 本文件 LAYERS）==');
    LAYERS.slice().sort((a, b) => b.rank - a.rank).forEach((l) => console.log(layerLine(l)));
    console.log('');
    console.log('== 边（' + r.edges.length + ' 条，来自 ' + r.files.length + ' 个文件）==');
    r.edges.forEach((e) => console.log('  ' + e.from + ':' + e.line + ' → ' + e.to
      + '  [' + (layerOf(e.from) || { id: '?' }).id + ' → ' + (layerOf(e.to) || { id: '(图外)' }).id + ']'));
    console.log('');
    console.log('== 在册豁免的目标（' + EXEMPT_TARGETS.length + ' 条）==');
    EXEMPT_TARGETS.forEach((t) => console.log('  ' + t.label + ' —— ' + t.why));
    console.log('');
    console.log('== 动态 require / import（非字面量，本门禁判不了方向）==');
    r.dynamic.forEach((d) => console.log('  ' + d.from + ':' + d.line + '  [' + d.kind + ']'));
    console.log('  合计 ' + r.dynamic.length + ' 处');
    return;
  }

  console.log('== 单向依赖门禁（S1）==');
  const bad = r.reverse.length + r.cycles.length + r.unowned.length + r.unreadable.length;
  console.log('  扫描面：' + r.files.length + ' 个第一方文件 / ' + r.edges.length + ' 条相对依赖边'
    + '（不含裸包名）；动态 require ' + r.dynamic.length + ' 处（非字面量，判不了方向 —— 如实计数）');
  r.unreadable.forEach((u) => console.log('  ✗ 读不出来：' + u.rel + '（' + u.why + '）—— 采不到真值 = 红'));

  if (r.reverse.length) {
    console.log('✗ 反向依赖 ' + r.reverse.length + ' 条（依赖只允许朝 rank 小的方向）：');
    r.reverse.forEach((e) => {
      console.log('   [S1-反向] ' + e.from + ':' + e.line + ' → ' + e.to);
      console.log('             ' + e.fromLayer.name + '（rank ' + e.fromLayer.rank + '）依赖了更靠上的 '
        + e.toLayer.name + '（rank ' + e.toLayer.rank + '）—— 声明见 `docs/ARCHITECTURE.md` §4 原则 2');
    });
  }
  if (r.cycles.length) {
    console.log('✗ 同层成环 ' + r.cycles.length + ' 组：');
    r.cycles.forEach((c) => console.log('   [S1-环] ' + c.join(' → ')));
  }
  if (r.unowned.length) {
    console.log('✗ 指向"分层图之外"的依赖 ' + r.unowned.length + ' 条（谁都得有个家）：');
    r.unowned.forEach((e) => console.log('   [S1-图外] ' + e.from + ':' + e.line + ' → ' + e.to));
    console.log('   → 二选一：把它归进某个层（改本文件的 LAYERS）；或登记进 EXEMPT_TARGETS（要写原因）');
  }
  console.log('  在册豁免：' + EXEMPT_TARGETS.length + ' 条'
    + '（指向 ' + EXEMPT_TARGETS.map((t) => t.label).join(' / ') + '）');

  if (!bad) {
    console.log('✓ 依赖方向成立：' + r.edges.length + ' 条相对边全部朝下（或同层），无环、无图外边');
    console.log('  （分层图的唯一权威是本文件 LAYERS；改分层只改那一处）');
    return;
  }
  console.log('   → 修法：把依赖**倒过来** —— 底层需要上层的信息时用**注入**（传参 / 回调），不要反向 require；');
  console.log('     确实需要一个新层，就改 `scripts/dep-direction-check.js` 的 LAYERS（唯一权威）并同批更新'
    + ' `docs/ARCHITECTURE.md` §4 原则 2 的说明。');
  process.exit(1);
}

module.exports = {
  LAYERS, EXEMPT_TARGETS, stripComments, parseEdges, layerOf, resolveSpec,
  findReverseEdges, findCycles, findUnownedTargets, analyze
};

if (require.main === module) main();
