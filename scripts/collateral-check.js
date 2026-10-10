#!/usr/bin/env node
/* ============================================================
 * scripts/collateral-check.js — 「改动即连带清单」门禁（门禁编号 S2）
 * ------------------------------------------------------------
 * 它守的那件事（E6 分析稿 `A-17` / 缺口 `G-16`）：
 *   本工程早就有一张**强登记面**（G8 的十五条判定、G8 第 ⑮ 条稳定性表、`SCHEMA_FIELDS` 契约字段…），
 *   但"**做这一类改动时，一共有哪几处要跟着改**"这件事**只活在人的记忆里** ——
 *   漏一处可能只是少一条文档，也可能**静默漂移**（谁都不知道哪一侧过期了）。
 *
 * 形态：**一张表 + 从表里派生的断言**（单源，不重做已机制化的部分）。
 *   `COLLATERAL` = 「改动类型 → 连带处」的**唯一权威**（本文件一处）。
 *   每一项连带处只有两种身份：
 *     · `gate: '<门禁号>'` —— **已经有人守**（G6/G7/G8/V2/MCP…）⇒ 本门禁只**校验那个门禁真的挂在链上**
 *       （指过去复用，**不重做** ✗；skill `H1`：不因为"AI 好写"就堆第二份实现）；
 *     · `gate: null` —— **残差**（当前不可机械化，如"该不该给这条命令加集成断言"是人的判断），
 *       如实写下来，不许假装有守卫。
 *   另外：凡是 `gate: 'S2'` 的那几处，**本门禁自己断言**（下面 `CHECKS`）——
 *   而 `S2` 那几处的集合与 `CHECKS` 的键必须**双向相等**（声明 ⊆ 实现 且 实现 ⊆ 声明）：
 *   表里写了没人实现 ⇒ 红；实现了没写进表 ⇒ 也红（对偶缺口，`E6` 第三条路 2）。
 *
 * 判定清单见 `analyze()` 里的 ①…④ 标记（此处刻意不写死条数：写死了就会漂）。
 *
 * 边界（诚实标注）：
 *   · 它**不**看 `git status`（易变的工作区状态当判据 ⇒ 新建/删除一个工作目录就能让链变色 ✗，
 *     本工程真吃过这个假红）。要看"这次新增了哪些文件、各自还有哪几处没同步"，跑
 *     `node scripts/collateral-check.js --list` **人工**照着表核；进链的只有下面那几条**确定性**断言；
 *   · 它查的是"**某一处有没有同步**"，查不了"这处内容写对没有"（那是各自的判据）；
 *   · 动态派发（命令名不是字面量）扫不到 —— 输出里如实计数、不假装查过。
 *
 * 用法：
 *   node scripts/collateral-check.js          判红/判绿（挂 `npm run verify` 的 S2 步）
 *   node scripts/collateral-check.js --list   打印「改动类型 → 连带处」全表（报错即指路）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ===============================================================
 * 单源表：「改动类型 → 连带处」
 *   每项：{ id, when（什么改动）, places: [{ at, role, gate?, check?, note }] }
 *   `role` 只有四种取值（**每一处连带都必须有身份**，不许含糊）：
 *     · `'body'`     本体 —— 这一处本身就是"发生这类改动"（如命令注册表）
 *     · `'gate'`     已经有人守 —— 必须同时写 `gate: '<门禁号>'`（本门禁只校验它挂在链上）
 *     · `'self'`     由**本门禁**直接断言 —— 必须同时写 `check: '<键>'`（键 ∈ `CHECKS`）
 *     · `'residual'` 残差 —— 当前不可机械化，如实写下来（不许假装有守卫）
 *   新增一类改动时**只改这张表**，并给该类的每一处一个身份。
 * =============================================================== */
const COLLATERAL = [
  {
    id: 'cli-command',
    when: '新增 / 改名 / 删除一条 CLI 命令',
    places: [
      { at: 'cli/registry.js（命令注册表）', role: 'body',
        note: '命令名与选项声明的唯一权威（改这里本身就是"发生这类改动"）' },
      { at: 'scripts/mcp-server.js（MCP 透传）', role: 'self', check: 'MCP',
        note: 'MCP 只转发 CLI：它派发到的每条命令都必须存在（改名/删命令时最容易漏这一处）' },
      { at: 'docs/EXTENSIONS.md §1.2 稳定性表', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ⑮ 条：每条命令至少要落在稳定性的一级里（"能不能依赖它"的契约）' },
      { at: 'docs/CLI.md（生成物）', role: 'gate', gate: 'G7',
        note: '复用 G7：用同一渲染函数重算并逐字比对，忘了 docs-gen 就红' },
      { at: 'docs/VERIFY.md 的「CLI 命令数」', role: 'gate', gate: 'G6',
        note: '复用 G6：真值由 `registry.list().length` 现算，不同步就红' },
      { at: 'scripts/cli-integration.js（集成断言）', role: 'residual',
        note: '残差（R3 铁律）："这条新命令值不值得加断言"是人的判断 —— 未机械化，别假装有守卫' }
    ]
  },
  {
    id: 'smoke-domain',
    when: '新增一个冒烟域 scripts/smoke/NN-*.js',
    places: [
      { at: 'scripts/smoke-assertions.js 的「分域文件（仅索引）」', role: 'self', check: 'SMOKE_INDEX',
        note: '断言注册面：域是自动发现的（不会漏跑），但**索引里没有它** ⇒ 接手者不知道它存在' },
      { at: '域末自收尾（closeDialogs / 产品自己的关闭口）', role: 'gate', gate: 'V2',
        note: '复用 V2：会留下浮层/模态的动作必须在域末收尾（实测漏一处 ⇒ 后面两个域连锁红 11 条）' },
      { at: '可见性断言的判据来源', role: 'gate', gate: 'V1',
        note: '复用 V1：名字里声称"可见"的断言必须有真判据（`elementFromPoint` / 真帧像素）' },
      { at: 'docs/VERIFY.md 的「冒烟断言」', role: 'gate', gate: 'G6',
        note: '复用 G6：断言数是真值，忘了 `npm run facts:write` 就红' },
      { at: 'main.js 的域清单 / 顺序', role: 'body',
        note: '无需改：域由 `readdirSync` 按文件名序自动发现（"顺序即契约"由 01-* 预热保证）—— 记下来免得下一个人去改' }
    ]
  },
  {
    id: 'src-module',
    when: '新增一个 src/ 模块',
    places: [
      { at: 'docs/ARCHITECTURE.md §2.3 模块表', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ⑦ 条：代码文件必须被架构文档提到（来源目录 = src/ / cli/commands/ / scripts/）' },
      { at: '依赖方向（只能朝下：renderer → main/scripts → cli → src）', role: 'gate', gate: 'S1',
        note: '复用 S1：新模块的 require 边立刻参与方向判定' },
      { at: 'tests/*.test.js（单测）', role: 'residual',
        note: '残差（R3 铁律）："改核心加单测"靠自觉 —— 未机械化' }
    ]
  },
  {
    id: 'data-field',
    when: '新增 / 改名一个数据字段',
    places: [
      { at: 'docs/DATA-FORMAT.md（契约字段表）', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ⑪ 条：契约必须覆盖 `SCHEMA_FIELDS` 清单（缺字段 = 照契约改就会漏）' },
      { at: 'src/schema.js（校验 + 版本演进）', role: 'gate', gate: 'G2',
        note: '复用 G2：`validate-all` 在链上兜结构（字段非法/成环/悬挂链接）' },
      { at: 'src/data-store.js 的写盘闸门', role: 'residual',
        note: '残差（约定，§6 横切规矩 ①）：新字段不新开写盘路径，一律走 `writeFileAtomic` —— 未机械化' }
    ]
  },
  {
    id: 'doc',
    when: '新增一份受管文档（docs/*.md）',
    places: [
      { at: '文档自己的头部元信息块（层/作用/不该写/更新方式）', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ①/⑬ 条：没有元信息块 = 非法文档；登记表是**生成物**' },
      { at: 'docs/ARCHITECTURE.md §5 登记表（`npm run docs:registry` 重生成）', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ⑬ 条：手改表格或改了元信息没重生成都会红' },
      { at: 'SKILL.md 的导航（第一屏可达）', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ⑩ 条：受管文档必须能从 `SKILL.md` 找到（找不到 = 等于没有这份文档）' },
      { at: 'docs/VERIFY.md 的「受管文档」计数', role: 'gate', gate: 'G7',
        note: '复用 G7：快照由生成器现场算，变了就得重生成' }
    ]
  },
  {
    id: 'script-or-gate',
    when: '新增一个 scripts/*.js（尤其是门禁）',
    places: [
      { at: 'docs/ARCHITECTURE.md §2.6 脚本表', role: 'gate', gate: 'G8',
        note: '复用 G8 第 ⑦ 条：`scripts/` 下每个文件都要在 §2.6 出现（没登记的脚本会让 G8 红）' },
      { at: 'docs/RULES.md §2 门禁表（含能力边界）', role: 'residual',
        note: '残差：若是门禁就必须在 §2 声明 —— 由 `tests/verify-budget.test.js` 的**双向**用例守'
          + '（声明↔实现），但那不是链上的门禁（跑 `npm test` 才会红）' },
      { at: 'scripts/verify.js 的 STEPS（挂链 + 预算）', role: 'residual',
        note: '残差：若是门禁，没挂链就等于没有 —— 同样由 `tests/verify-budget.test.js` 的双向用例守' }
    ]
  }
];

/* ===============================================================
 * 本门禁自己实现的那几处断言（键 = 表里 `gate: 'S2'` 引用的名字）
 * =============================================================== */
const CHECKS = ['MCP', 'SMOKE_INDEX'];

/* ===============================================================
 * ① 从源码里取"MCP 派发到的 CLI 命令"（纯函数）
 *    两种形状（本工程现状）：`runCli(['read', …])` 与 `const c = ['read', …]; … runCli(c)`
 * =============================================================== */
function extractMcpCommands(src) {
  const text = String(src);
  const out = [];
  const add = (cmd, idx) => {
    const line = text.slice(0, idx).split('\n').length;
    if (!out.some((o) => o.cmd === cmd)) out.push({ cmd, line });
  };
  text.replace(/runCli\(\[\s*'([^']+)'/g, (m, c) => { add(c, text.indexOf(m)); return m; });
  text.replace(/const c = \[\s*'([^']+)'/g, (m, c) => { add(c, text.indexOf(m)); return m; });
  return out.sort((a, b) => a.line - b.line);
}

/** `runCli(` 调用点数与"取到命令名"的调用点数（数字只用于**告知**：扫不到的边界要可见） */
function mcpCallSites(src) {
  const text = String(src);
  const sites = (text.match(/runCli\(/g) || []).length;
  const defs = (text.match(/function runCli\(/g) || []).length;
  return { sites, defs };
}

/* ===============================================================
 * ② 冒烟域 ↔ 入口索引（纯函数）
 * =============================================================== */
function smokeDomains(dir) {
  return fs.readdirSync(dir).filter((f) => /^\d+-.+\.js$/.test(f)).sort();
}

/** 索引里没有提到的域文件（入口文件全文中出现文件名即算登记） */
function missingFromIndex(domains, entryText) {
  return domains.filter((f) => String(entryText).indexOf(f) < 0);
}

/* ===============================================================
 * ③ 表自身的两条一致性（纯函数）
 * =============================================================== */
/** 表里 `role: 'self'` 的那几处声明的检查键（顺序即表序，便于点名） */
function declaredChecks(table) {
  const out = [];
  table.forEach((row) => row.places.forEach((p) => {
    if (p.role === 'self') out.push({ key: p.check, row: row.id, at: p.at });
  }));
  return out;
}

/** 表里 `role: 'gate'` 引用的门禁号：这些应当**已经有人守** */
function referencedGates(table) {
  const out = [];
  table.forEach((row) => row.places.forEach((p) => {
    if (p.role === 'gate') out.push({ gate: p.gate, at: p.at, row: row.id });
  }));
  return out;
}

/** 挂在链上的门禁（读 `scripts/verify.js` 的 STEPS —— 那是链的唯一定义） */
function mountedGates() {
  try { return require(path.join(ROOT, 'scripts', 'verify.js')).STEPS.map((s) => s.gate); }
  catch (e) { return null; }
}

/* ===============================================================
 * ④ 判定（读磁盘 → 问题清单）
 * =============================================================== */
function analyze() {
  const problems = [];
  const notes = [];

  // (a) MCP 派发到的命令必须存在（↔ 表 cli-command · MCP 透传）
  const mcpRel = 'scripts/mcp-server.js';
  const mcpSrc = fs.readFileSync(path.join(ROOT, mcpRel), 'utf8');
  const dispatched = extractMcpCommands(mcpSrc);
  const registry = require(path.join(ROOT, 'cli', 'registry.js')).list().map((c) => c.name);
  const sites = mcpCallSites(mcpSrc);
  dispatched.forEach((d) => {
    if (!registry.includes(d.cmd)) {
      problems.push({
        kind: 'mcp',
        msg: 'MCP 透传指向了一条**不存在的 CLI 命令**：`' + d.cmd + '`'
          + '（' + mcpRel + ':' + d.line + '）'
      });
    }
  });
  notes.push('MCP 透传：' + dispatched.length + ' 条派发命令（调用点 ' + sites.sites + ' 处，'
    + (registry.length - dispatched.length) + ' 条 CLI 命令未做 MCP 工具 —— 那是人的判断，不是缺陷）');

  // (b) 冒烟域必须在入口索引里（↔ 表 smoke-domain · 断言注册面）
  const entryRel = 'scripts/smoke-assertions.js';
  const entryText = fs.readFileSync(path.join(ROOT, entryRel), 'utf8');
  const domains = smokeDomains(path.join(ROOT, 'scripts', 'smoke'));
  const missing = missingFromIndex(domains, entryText);
  missing.forEach((f) => {
    problems.push({
      kind: 'smoke-index',
      msg: '冒烟域没有登记进断言注册面：`scripts/smoke/' + f + '` 在 ' + entryRel + ' 里找不到'
    });
  });
  notes.push('冒烟域：' + domains.length + ' 个域文件，索引里没有的 ' + missing.length + ' 个');

  // (c) 表里引用的门禁必须**真的挂在链上**（"指过去复用"不许指向不存在的东西）
  const mounted = mountedGates();
  if (!mounted) {
    problems.push({ kind: 'mount', msg: '读不到 `scripts/verify.js` 的 STEPS ⇒ 采不到真值 = 红' });
  } else {
    referencedGates(COLLATERAL).forEach((r) => {
      if (!mounted.includes(r.gate)) {
        problems.push({
          kind: 'mount',
          msg: '连带表把 `' + r.at + '` 指给门禁 **' + r.gate + '**，但它**没有挂在 verify 链上**'
            + '（改动类型：' + r.row + '）—— 指过去复用的前提是那边真的有人守'
        });
      }
    });
    notes.push('连带表引用的门禁：' + [...new Set(referencedGates(COLLATERAL).map((r) => r.gate))].join(' / ')
      + '（全部已挂链 ✓）');
  }

  // (d) S2 自己那几处：声明 ↔ 实现双向闭包（表里写了没人实现 ⇒ 红；实现了没写进表 ⇒ 也红）
  const decl = declaredChecks(COLLATERAL);
  decl.forEach((d) => {
    if (!d.key) {
      problems.push({ kind: 'closure', msg: '连带表里 `' + d.at + '`（' + d.row
        + '）标了 `gate: S2`，却没写 `check` 键 —— 说不清是哪条断言在守' });
    } else if (!CHECKS.includes(d.key)) {
      problems.push({ kind: 'closure', msg: '连带表把 `' + d.at + '`（' + d.row + '）指给本门禁的断言 `'
        + d.key + '`，但本文件**没有实现**它 —— 表是空头承诺' });
    }
  });
  CHECKS.forEach((k) => {
    if (!decl.some((d) => d.key === k)) {
      problems.push({ kind: 'closure', msg: '本门禁实现了断言 `' + k
        + '`，但连带表里没有任何一处指向它 —— 表漏了一行（实现了没人知道的守卫）' });
    }
  });

  return { problems, notes, dispatched, domains, mounted, checks: CHECKS.slice() };
}

function main() {
  const list = process.argv.includes('--list');
  const r = analyze();

  if (list) {
    console.log('== 改动类型 → 连带处（**唯一权威 = 本文件 COLLATERAL**）==');
    COLLATERAL.forEach((row) => {
      console.log('');
      console.log('▸ ' + row.when + '   [' + row.id + ']');
      row.places.forEach((p) => {
        const who = p.gate === 'S2' ? '本门禁直接断言（S2）'
          : p.gate ? '已有门禁 ' + p.gate + '（复用，不重做）' : '残差（未机械化）';
        console.log('    · ' + p.at);
        console.log('        ' + who + ' —— ' + p.note);
      });
    });
    console.log('');
    console.log('== 现场事实 ==');
    r.notes.forEach((n) => console.log('  · ' + n));
    console.log('  · 本门禁自己实现的断言：' + CHECKS.join(' / '));
    return;
  }

  console.log('== 连带清单门禁（S2）==');
  r.notes.forEach((n) => console.log('  · ' + n));
  if (!r.problems.length) {
    console.log('✓ 连带清单成立：表里每一处都有主（' + (r.mounted ? '门禁全部挂链' : '门禁读不到') + '），'
      + '本门禁自己那几处断言也过了');
    console.log('  （全表：`node scripts/collateral-check.js --list`；改一类改动只改那张表）');
    return;
  }
  console.log('✗ 连带清单有 ' + r.problems.length + ' 处没同步：');
  r.problems.forEach((p) => console.log('   [' + p.kind + '] ' + p.msg));
  console.log('   → 修法：按上面点名的**那一处**补齐。整张表（哪类改动要连带哪几处、谁在守）见');
  console.log('     `node scripts/collateral-check.js --list`；规则分级见 `docs/RULES.md` §2。');
  process.exit(1);
}

module.exports = {
  COLLATERAL, CHECKS, extractMcpCommands, mcpCallSites, smokeDomains,
  missingFromIndex, declaredChecks, referencedGates, mountedGates, analyze
};

if (require.main === module) main();
