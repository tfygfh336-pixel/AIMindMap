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
 * 判定清单见 `analyze()` 里的 ①②③④ 标记（此处刻意不写死条数：写死了就会漂）。
 *
 * 【本门禁还实现第五条判定：⑤ 写盘出口（`WRITE_OUTLET`）—— 见文件下部"⑤"那一节】
 * 它守的那条规则**声明早就有、检查一直没建**：`docs/ARCHITECTURE.md` §6 横切规矩 ① 与
 * `docs/RULES.md` §1 都逐字写着「新增写盘路径一律复用 `writeFileAtomic`（禁止裸 `writeFileSync`）」，
 * 实测**没有任何门禁扫过它**（G1/G8/G9/V1/V2/G3/G6/G7/G4/G2/G5/S1 全是别的对象）。
 * 这正是本文件 `COLLATERAL` 里 `data-field · src/data-store.js 的写盘闸门` 那处**残差**——
 * 本批把它从"残差（未机械化）"升级成"本门禁直接断言"，形态照 `E2`：**能写成门禁的现场规则
 * 就不要只写成提示**。判据与欠账册都在那一节，别在别处再写一份。
 *
 * 边界（诚实标注）：
 *   · 它**不**看 `git status`（易变的工作区状态当判据 ⇒ 新建/删除一个工作目录就能让链变色 ✗，
 *     本工程真吃过这个假红）。要看"这次新增了哪些文件、各自还有哪几处没同步"，跑
 *     `node scripts/collateral-check.js --list` **人工**照着表核；进链的只有下面那几条**确定性**断言；
 *   · 它查的是"**某一处有没有同步**"，查不了"这处内容写对没有"（那是各自的判据）；
 *   · 动态派发（命令名不是字面量）扫不到 —— 输出里如实计数、不假装查过。
 *
 * 用法：
 *   node scripts/collateral-check.js               判红/判绿（挂 `npm run verify` 的 S2 步）
 *   node scripts/collateral-check.js --list        打印「改动类型 → 连带处」全表 + 判定 ⑤ 的逐条读数
 *   node scripts/collateral-check.js --root=<dir>  只把**判定 ⑤ 的扫描根**指向别处（判别力证明用）
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
      { at: 'src/data-store.js 的写盘闸门', role: 'gate', gate: 'S2',
        note: '复用 S2 的 WRITE_OUTLET（本批把"新字段不新开写盘路径"从残差升级成判定）：'
          + '新字段的写调用点若落在受管资产上又没走出口，本门禁直接红' }
    ]
  },
  {
    id: 'write-path',
    when: '新增 / 改动一条**写盘路径**（谁把字节落到受管资产上）',
    places: [
      { at: 'src/data-store.js 的 writeFileAtomic / writeManagedText（唯一写盘出口）', role: 'body',
        note: '写盘出口的唯一实现；原子写（tmp + fsync + rename）与版本闸门 `versionGate` 都在这里' },
      { at: '受管资产（文档 / 登记表 / 生成物 / 变更日志 / 项目数据）的写调用点', role: 'self', check: 'WRITE_OUTLET',
        note: '本门禁直接断言：解析得到的写目标落在受管资产上、又没走出口 ⇒ 红（判据与欠账册在文件下部"⑤"）' },
      { at: '自造的 tmp + rename（第二份"原子写"）', role: 'self', check: 'WRITE_OUTLET',
        note: '判定的另一半：新出现第三个自造实现 ⇒ 红；存量逐条在册（带 why / close）' }
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
const CHECKS = ['MCP', 'SMOKE_INDEX', 'WRITE_OUTLET'];

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
function analyze(opts) {
  const o = opts || {};
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

  // (e) ⑤ 写盘出口：受管资产的裸写 + 自造第二份原子写 + 欠账册四条机械判定
  //    `writeOutletRoot` 只给**判别力证明**用（把同一个判据指向 %TEMP% 副本 ⇒ 真仓一个字节不动）；
  //    不给就是真仓，输出与从前逐字节相同（H3）。
  const writeOutlet = analyzeWriteOutlet(o.writeOutletRoot || ROOT);
  writeOutlet.problems.forEach((p) => problems.push(p));
  writeOutlet.notes.forEach((n) => notes.push(n));

  return { problems, notes, dispatched, domains, mounted, checks: CHECKS.slice(), writeOutlet: writeOutlet };
}

/* ===============================================================
 * ⑤ 写盘出口（WRITE_OUTLET）—— 受管资产的字节只允许从一个函数落盘
 * ---------------------------------------------------------------
 * 它守的那条规则（**声明早就有、检查一直没建**）：
 *   `docs/ARCHITECTURE.md` §6 横切规矩 ①：「加写盘路径 → 复用 `src/data-store.js` 的
 *   `writeFileAtomic`（禁止裸 `writeFileSync`）」；`docs/RULES.md` §1 同一句。
 *   实测：这条规则**没有任何门禁扫过**，而"写盘出口只有一个函数"这条不变式实际上有 **4 份**
 *   （1 份闸门 + 3 份自造/绕过；其中 2 份已经由 T2/T3 收口，2 份存量在册）。
 *
 * 两条判定（互补，缺一条就漏一半）：
 *   ① **裸写受管资产**：写调用点的**目标路径**（按字面量求值解析出来的）落在受管资产上、
 *      且这一处没走 `writeFileAtomic` / `writeManagedText` ⇒ 红。
 *   ② **自造第二份原子写**：文件里同时出现 `fs.writeFileSync(` 与 `fs.renameSync(`（tmp + rename
 *      的签名）⇒ 它就是"第二份写盘出口"⇒ 红（出口本体 `src/data-store.js` 除外）。
 *
 * 为什么要**解析路径**而不是像 T3 那样按调用行的文本猜（那版实测两个方向都不准）：
 *   · 猜不准的**漏**：`fs.writeFileSync(p, …)` 里 `p = path.join(ROOT,'docs','VERIFY.md')` ——
 *     调用行上没有 `docs`，规则不命中 ⇒ 真违规静默通过（任务书点名的"静态扫描会低估"）。
 *   · 猜不准的**假**：`fs.writeFileSync(path.join(pw,'package.json'), …)` 里 `pw` 是 %TEMP% 探针目录，
 *     调用行上有 `package.json` ⇒ 判成受管资产（T3 那版 4 条"受管"里 3 条是这种假阳性）。
 *   ⇒ 本判据**先把目标表达式求值成路径**（只支持可判定的写法，见 `evalPathExpr` 的能力边界），
 *     求不出来就记"判不了"并**逐条打印**（F1：跳过必须可见，不许伪装成"查过且干净"）。
 *
 * 能力边界（诚实标注，别以为它包住一切）：
 *   · 只认**字面量可求值**的目标：字符串 / 模板串 / `path.join|resolve` / `__dirname` / 同文件的
 *     常量绑定（≤4 跳）/ `+` 拼接。**函数参数、运行时拼出来的路径、从 argv 来的路径一律判不了**
 *     （输出里计数 + 逐条列出，不判红也不假装查过）；
 *   · 只扫第一方源码（`src/` · `cli/` · `scripts/` · 工程根 `*.js`），不扫 `tests/`（它的夹具天然
 *     要造坏数据、绕过闸门正是被验的对象）、不扫依赖与产物目录；
 *   · 判据是"**谁写**"，判不了"**写得对不对**"（那是 G2 数据校验 / G6·G7 生成物的事）。
 * =============================================================== */

/** 受管资产族：**唯一一处**（路径解析成功后按仓库相对 POSIX 路径匹配）。
 *  文档族从 G8 的登记表 `docs/ARCHITECTURE.md` §5 **现取**（不手抄一份会漂的清单 —— A3）。 */
const WO_DOC_PREFIXES = ['docs/', 'docs/archive/', 'docs/changelog/'];
const WO_ROOT_DOCS = ['SKILL.md', 'README.md', 'CHANGELOG.md'];

/** 扫描面 */
const WO_SCAN_DIRS = ['src', 'cli', 'scripts'];
const WO_SKIP_DIRS = new Set(['node_modules', 'vendor', 'dsh-home', 'projects', 'dist', 'dist-portable',
  'build', 'backups', '.review', '.git']);

/** 认作"写调用"的 API 名字（**唯一一处**口径）。`renameSync` 单独归到判定 ②，不算"写内容"。 */
const WO_WRITE_NAMES = ['writeFileSync', 'appendFileSync', 'appendFile', 'writeFile', 'createWriteStream'];

/**
 * 在一行里找写调用（**线性 indexOf 扫描，不用正则**）。
 *
 * ⚠️ 为什么不用正则（实测）：上一版是
 *   `/(?:^|[^\w$])(?:fs|fsp|fsPromises|promises)?\s*\.?\s*(writeFileSync|…)\s*\(/g`
 *   —— 可选组 + 两处 `\s*` + 可选 `.` 在**长行**上大量回溯：`cli/registry.js` 只有 489 行、
 *   **0 处命中**，却花了 **768 ms**（S2 因此从 0.3 s 涨到 10.6 s，撞穿 10 s 预算 ✗）。
 *   改成扫描后同一文件 0 命中、耗时接近 0。
 *
 * 命中条件：名字**前一个字符不是标识符字符**（`fs.` 的 `.` 可以；`mywriteFileSync` 不行），
 * 名字后跳过空白必须是 `(`（所以 `writeFileAtomic(` **不会**被当成 `writeFile(`）。
 * @returns {Array<{index:number, call:string}>}
 */
function findWriteCalls(line) {
  const out = [];
  const seen = new Set();
  for (let k = 0; k < WO_WRITE_NAMES.length; k++) {
    const name = WO_WRITE_NAMES[k];
    let from = 0;
    for (;;) {
      const i = line.indexOf(name, from);
      if (i < 0) break;
      from = i + name.length;
      if (i > 0 && /[\w$]/.test(line[i - 1])) continue;          // 嵌在别的标识符里
      let j = i + name.length;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
      if (line[j] !== '(') continue;                             // `writeFileAtomic(` / `writeFile.end` 之类
      if (seen.has(i)) continue;
      seen.add(i);
      out.push({ index: i, call: name });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 唯一写盘出口的本体文件（它自己当然要有 `fs.writeFileSync` 与 `fs.renameSync`） */
const WO_OUTLET_FILE = 'src/data-store.js';

/* ---------------------------------------------------------------
 * 欠账册（**封闭**：上限只减不增；每条必写 `why` 与 `close`；工具当场核三条）
 *   每条：{ at, kind, verdict, why, close }
 *     · `at`      —— 仓库相对路径（POSIX）
 *     · `kind`    —— `'file'`（整文件的写调用点豁免）/ `'self-atomic'`（自造 tmp+rename）
 *     · `verdict` —— `'keep'`（**有据的降级**：语义与出口不同，且写清了升级触发条件）
 *                   / `'debt'`（**欠账**：应当收口，只是不在本批）
 *   三条机械判定（见 `analyzeWriteOutlet`）：**在册算欠账**（有条目没违例 ⇒ 修好忘销账 ⇒ 红）·
 *   **条数 ≤ cap**（只减不增）· **册上的文件必须存在**（改名/删 ⇒ 红）。
 * --------------------------------------------------------------- */
const WRITE_OUTLET_CAP = 8;
const WRITE_OUTLET_DEBT = [
  {
    at: 'main.js',
    kind: 'file',
    verdict: 'keep',
    why: '6 处判不了目标的裸写，**逐个人工核过**（行号会漂，按符号找 —— `--list` 逐条打印）：'
      + '`res.filePath`（导出图片时用户在保存对话框选的路径）· `feedbackFile()`（`<userData>/feedback.jsonl`）· '
      + '`path.join(SMOKE_PROJECTS_DIR, …)`（冒烟沙箱副本）· `process.env.MM_SMOKE_TIMING_OUT` 指定的计时 JSON · '
      + '`out` 两处（截图/合成图的输出路径，`--out` 或沙箱）—— **全部落在仓库之外或用户输出目录，非受管**。'
      + '另有 1 处**受管资产裸写**（`path.join(REAL_PROJECTS_DIR, "_leak-inject-probe.json")`），它只在 '
      + '`MM_SMOKE_LEAK_INJECT=1` 下生效、是**判别力证明用**的故意注入（跑完复核必须判红）⇒ 本条给它的整文件豁免。'
      + ' **`.validate` 校验探针写进 `projects/<项目>/` 的那一处已偿（2026-10-19）**：那是本条唯一的真欠账，现在保存闸门改成'
      + '**进程内**校验（`src/data-store.js` 的 `createProjectValidator`，与 CLI 写路径同一个工厂）⇒ 不再有临时文件。'
      + '于是本条从 `debt` 降为 `keep`（照原 `close` 栏的写法："清掉之后本条降为 keep"）。',
    close: '升级触发条件（命中任一条就回来收口）：① 上面任何一处写目标改成**工程内**路径'
      + '（例如导出默认落到工程根、冒烟沙箱改到 `projects/` 下）；② 那个泄漏注入探针从 '
      + '`MM_SMOKE_LEAK_INJECT` 门控变成默认路径（那时它就不再是"判别力证明"而是真违规）。'
  },
  {
    at: 'src/control.js',
    kind: 'self-atomic',
    verdict: 'keep',
    why: '`writeJsonAtomic`（第 78 行起）是**有据的第二份**：该通道承载"界面控制命令/回执"，'
      + '它的记录口径是**「没有回执就等于没生效」**（丢掉一条 = 调用方判失败、重下一次，这是已声明且'
      + '接受的结局）⇒ `writeFileAtomic` 的 **fsync**（换"断电后不丢"）对它没有语义收益；而它是'
      + '"纯文件读写、零依赖"的通道（main 进程轮询热路径），收口会连带 require '
      + '`concurrency/changes/heat` 三个模块。',
    close: '升级触发条件（命中任一条就回来收口）：① 该通道开始承载**不可丢**的东西'
      + '（例如保存编辑结果）；② 出现"槽文件写到一半被读到"的真事故；③ `writeFileAtomic` 被要求成为'
      + '**所有** tmp+rename 的唯一实现。⚠️ 收口时**只许**换"写内容"那一步 —— `claim()` 里的 '
      + '`fs.renameSync` 必须保持"失败即互斥"的语义，**不许**换成带重试的版本'
      + '（重试会把"别人已认领"变成"我也认领"）。'
  },
  {
    at: 'scripts/cli-integration.js',
    kind: 'file',
    verdict: 'keep',
    why: '集成断言必须在**真实** `projects/` 下造"读不出来的项目 / 坏 JSON / 悬挂成员"这类夹具 —— '
      + '它验的正是 `store` 对坏数据的反应，走出口（会先校验）就**造不出**这些前置条件。'
      + '其余夹具写在 %TEMP% 沙箱（md/pdf/png 输入）。全部自建自删。',
    close: '升级触发条件：若 CLI 提供一个 **test-only 的原始写入口**（如 `mm-cli raw-write --for-test`），'
      + '就改用它。在此之前保持整文件豁免（写目标逐条见 `node scripts/collateral-check.js --list`）。'
  },
  {
    at: 'main-dsh-sidebar.js',
    kind: 'file',
    verdict: 'keep',
    why: '3 处判不了的写目标：`162 path.join(dir, "SKILL.md")`（`dir` = 用户选的**技能目录**，'
      + '这是内置侧栏往用户目录写说明书，不是本仓的 `SKILL.md`）· `349 serviceInfoFile()` / '
      + '`1657 prefsFile()`（都 = `path.join(userDataPath(), …)`，即**应用数据目录**）。'
      + '三者都在仓库之外。',
    close: '升级触发条件：① 若"写 SKILL.md"的目标目录被默认为工程根；② 若 `userDataPath()` 被改成'
      + '工程内路径（例如便携模式把它放到仓库里）—— 那时就变成写受管资产。'
  },
  {
    at: 'scripts/mutate-gates.js',
    kind: 'file',
    verdict: 'keep',
    why: '5 处判不了的写目标全部落在 **%TEMP% 的镜像副本**（`abs(rel)` = 副本根相对路径、'
      + '`path.join(top, "README.md")` = 副本里的存根）与 **`--out=` 指定的报告文件**。'
      + '注入与还原都只动副本（`M.write` / 原始 Buffer 还原），**真仓一个字节不动**。',
    close: '升级触发条件：若变异体检改成"直接在真仓注入"（那会破坏 `repoUnchanged` 前提），'
      + '就必须重新裁决。'
  },
  {
    at: 'scripts/smoke/40-heat-bars.js',
    kind: 'self-atomic',
    verdict: 'keep',
    why: '冒烟域要把 `<项目根>/.visits` **整个目录**改名/占位来造"日志路径不可用"的失败档'
      + '（`fs.renameSync(<目录>)`，实测在本机间歇 EPERM，见该文件第 917 行起的注释）；'
      + '它改的是 %TEMP% 沙箱里的日志目录，不是受管资产，也不是"写内容"的原子写。',
    close: '升级触发条件：若这些"造故障"的探针搬到真项目目录上跑，必须重新裁决'
      + '（沙箱前提一消失，它就是真违规）。'
  },
  {
    at: 'scripts/register-batch-writer.js',
    kind: 'file',
    verdict: 'keep',
    why: '`104 fs.writeFileSync(file, …)` 里的 `file = path.join(dir, reg.batchId + ".json")`，'
      + '`dir` = **`.review/batches/`**（工作产物区里的"批登记面"）—— 它写的是本机协作登记，'
      + '不是受管资产（`.review/` 可整目录删、不进扫描、不进版本库）。它"提得到受管资产名"'
      + '只是因为在参数说明里写了 `\'projects\'`。',
    close: '升级触发条件：若"批登记面"从 `.review/` 搬进 `docs/`（变成受管登记表），就必须重新裁决。'
  },
  {
    at: 'scripts/smoke/50-五星评价.js',
    kind: 'file',
    verdict: 'keep',
    why: '`468 fs.appendFileSync(FEEDBACK_FILE, …)` 里的 `FEEDBACK_FILE = feedbackFile()` = '
      + '`<userData>/feedback.jsonl`（**应用数据目录**）。这一行是冒烟故意"绕开渲染层直接写库"，'
      + '为的是证明摘要条读的是**文件**而不是内存。',
    close: '升级触发条件：若反馈库被挪进工程内（例如随项目保存），就必须改为走写盘出口。'
  }
];

/** 受管资产族（**唯一一处**判据）。`rel` = 仓库相对 POSIX 路径 */
function woManagedFamily(rel) {
  const r = String(rel || '');
  if (WO_ROOT_DOCS.includes(r)) return { id: 'root-doc', label: '根文档（§5 登记的入口文档）' };
  if (r === 'docs/ARCHITECTURE.md') return { id: 'registry', label: '登记表（§5 是生成物）' };
  if (WO_DOC_PREFIXES.some((p) => r.startsWith(p))) return { id: 'doc', label: '受管文档 / 生成物（docs/**）' };
  if (r.startsWith('projects/')) return { id: 'project-data', label: '项目数据（写盘必经 store.write）' };
  // 版本单源（G6 判"四处一致"）：这三个文件一处漂了就是版本口径分叉
  if (r === 'package.json' || r === 'package-lock.json' || r === 'src/config.js') {
    return { id: 'version-source', label: '版本单源（package.json / src/config.js）' };
  }
  return null;
}

/** 受管资产的**名字**（判定 ③ 的输入：一个文件"提得到"受管资产吗）。
 *  与 `woManagedFamily` 同源：根文档名 + 登记文档的路径/basename + `docs` / 两个归档前缀 / `projects`。
 *  ⚠️ **必须是"整条字符串就是这个名字"**（`'docs'` / `'docs/RULES.md'` / `'CHANGELOG.md'`），
 *  不是"文本里出现过这个词"。理由（实测）：`scripts/encoding-check.js` 里有一句
 *  `console.error('恢复指引见 docs/INCIDENTS.md（事故二）')` —— 按"出现过就算"会把这个
 *  **只读文档、只印提示的检查器**判成"可能在写受管资产"（假红）。路径字面量总是整条字符串。 */
function woAssetNameMatchers() {
  const names = new Set(['docs', 'docs/archive', 'docs/changelog', 'projects']);
  WO_ROOT_DOCS.forEach((d) => names.add(d));
  WO_DOC_PREFIXES.forEach((p) => names.add(p.slice(0, -1)));
  try {
    const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const { parseRegistryTable } = require(path.join(ROOT, 'scripts', 'docs-registry-check.js'));
    const table = parseRegistryTable(arch);
    table.exact.forEach((d) => { const b = d.split('/').pop(); if (b) names.add(b); });
  } catch (e) { /* 读不到就只用常量那几条（不静默：`--list` 的 tokens 读数会体现出来） */ }
  const out = [];
  names.forEach((n) => {
    out.push({ label: n, needle: "'" + n + "'" });
    out.push({ label: n, needle: '"' + n + '"' });
  });
  return out;
}

/* ---------------------------------------------------------------
 * 路径表达式求值（纯函数；返回绝对路径串或 null）
 *   能力边界逐条写在 `evalPathExpr` 的注释里；**判不了就返回 null**，不猜。
 * --------------------------------------------------------------- */
/** 把 `expr` 的顶层按 `sep` 切开（跳过括号与字符串内部的 `sep`） */
function splitTopLevel(expr, sep) {
  const text = String(expr);
  const out = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') { if (i + 1 < text.length) { cur += text[i + 1]; i += 2; continue; } }
      else if (c === quote) quote = null;
      i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 找 `expr` 里最外层的第一个函数调用 → `{ name, argsText }`；不是"整串就是一个调用" ⇒ null */
function wholeCall(expr) {
  const m = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(expr);
  if (!m) return null;
  const open = m[0].length - 1;
  let depth = 0;
  let quote = null;
  for (let i = open; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        if (expr.slice(i + 1).trim() !== '') return null;   // 调用后面还跟着东西 ⇒ 不是整串
        return { name: m[1], argsText: expr.slice(open + 1, i) };
      }
    }
  }
  return null;
}

/**
 * 求值一个"路径表达式"。**能力边界（判不了就 null，绝不猜）**：
 *   · 字符串字面量 `'a/b'` / `"a/b"`（支持 `\\` 与 `\'` 这类简单转义）
 *   · 模板字符串，且每个 `${…}` 递归可求值
 *   · `path.join(…)` / `path.resolve(…)`（参数递归求值）
 *   · `__dirname`（= 该文件所在目录）/ `__filename`
 *   · 同文件里的标识符绑定（`const X = …` / `let X = …` / `X = …`，≤ `depth` 跳，防环）
 *   · `a + b`（两侧都可求值时拼接）
 *   其余（函数参数、`argv`、`os.tmpdir()`、`require(…)` 结果…）一律 null。
 */
function evalPathExpr(expr, ctx) {
  const e = String(expr == null ? '' : expr).trim();
  if (!e) return null;
  const depth = ctx.depth || 0;
  if (depth > 4) return null;

  // 去掉整体包裹的括号
  if (e[0] === '(' && e[e.length - 1] === ')') return evalPathExpr(e.slice(1, -1), Object.assign({}, ctx, { depth: depth + 1 }));

  // 字符串字面量
  const q = /^(['"])([\s\S]*)\1$/.exec(e);
  if (q) return q[2].replace(/\\(['"\\])/g, '$1').replace(/\\\\/g, '\\');

  // 模板字符串（无插值直接当字面量；有插值则逐段求值）
  const tpl = /^`([\s\S]*)`$/.exec(e);
  if (tpl) {
    const body = tpl[1];
    if (body.indexOf('${') < 0) return body;
    let out = '';
    let rest = body;
    while (rest.length) {
      const at = rest.indexOf('${');
      if (at < 0) { out += rest; break; }
      out += rest.slice(0, at);
      // 找配对的 }
      let d = 0; let end = -1; let quote = null;
      for (let i = at + 2; i < rest.length; i++) {
        const c = rest[i];
        if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') d++;
        else if (c === '}') { if (d === 0) { end = i; break; } d--; }
      }
      if (end < 0) return null;
      const inner = evalPathExpr(rest.slice(at + 2, end), Object.assign({}, ctx, { depth: depth + 1 }));
      if (inner == null) return null;
      out += inner;
      rest = rest.slice(end + 1);
    }
    return out;
  }

  // 顶层 `+` 拼接（结果**归一化**：`__dirname + '/../docs/x'` 要能变成 `…/docs/x`）
  const plus = splitTopLevel(e, '+');
  if (plus.length > 1) {
    const parts = plus.map((p) => evalPathExpr(p, Object.assign({}, ctx, { depth: depth + 1 })));
    if (parts.some((p) => p == null)) return null;
    return path.normalize(parts.join('')).replace(/\\/g, '/');
  }

  // 函数调用
  const call = wholeCall(e);
  if (call) {
    const name = call.name.replace(/\s+/g, '');
    if (name === 'path.join') {
      const args = splitTopLevel(call.argsText, ',').map((a) => evalPathExpr(a, Object.assign({}, ctx, { depth: depth + 1 })));
      if (args.some((a) => a == null)) return null;
      return path.join.apply(path, args).replace(/\\/g, '/');
    }
    if (name === 'path.resolve') {
      const args = splitTopLevel(call.argsText, ',').map((a) => evalPathExpr(a, Object.assign({}, ctx, { depth: depth + 1 })));
      if (args.some((a) => a == null)) return null;
      return path.resolve.apply(path, args).replace(/\\/g, '/');
    }
    // 同文件的**零参函数**（如 `verifyDocPath()`）⇒ 追它第一个 return 的表达式
    if (ctx.returns && ctx.returns.has(name) && call.argsText.trim() === '') {
      if (ctx.seen && ctx.seen.has('fn:' + name)) return null;
      const seen = new Set(ctx.seen || []);
      seen.add('fn:' + name);
      return evalPathExpr(ctx.returns.get(name), Object.assign({}, ctx, { depth: depth + 1, seen: seen }));
    }
    return null;
  }

  // 标识符
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (e === '__dirname') return String(ctx.dir || '').replace(/\\/g, '/');
    if (e === '__filename') return String(ctx.file || '').replace(/\\/g, '/');
    const bound = ctx.bindings && ctx.bindings.get(e);
    if (bound === undefined) return null;
    if (ctx.seen && ctx.seen.has(e)) return null;           // 防环
    const seen = new Set(ctx.seen || []);
    seen.add(e);
    return evalPathExpr(bound, Object.assign({}, ctx, { depth: depth + 1, seen: seen }));
  }
  return null;
}

/** 同文件里的**零参函数**：`function name() { … return <expr>; … }` ⇒ name → 第一个 `return` 的表达式。
 *  为什么要这一档：`doc-facts.js` 那种写法是 `fs.writeFileSync(verifyDocPath(), …)`（T2 之前的真实形状）——
 *  路径不在调用行上，而在同文件的一个零参函数里。不追这一跳就**漏掉真违规**。
 *  ⚠️ 必须先拿到**函数块表**（`collectFunctionBlocks`，一次扫描），不许每个函数各自配平一遍括号 ——
 *  实测那样在大文件上是 O(函数数 × 文件长)，S2 因此撞穿 10s 预算。 */
function collectZeroArgReturns(code, blocks) {
  const map = new Map();
  const bl = blocks || collectFunctionBlocks(code);
  const byStart = new Map();
  bl.forEach((b) => byStart.set(b.start, b));
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    const block = byStart.get(m.index + m[0].length - 1);
    if (!block) continue;
    const r = /\breturn\s+([^;\n]+)/.exec(code.slice(block.start + 1, block.end));
    if (r) map.set(m[1], r[1].trim());
  }
  return map;
}

/**
 * 把注释 / 字符串的**内容**抹成空格（**保持长度与行号**）。
 *   · `comments:true` ⇒ `//` 与 `/* *\/` 的内容抹掉；`strings:true` ⇒ 引号内的内容抹掉。
 *   · 为什么不能复用 `dep-direction-check.js` 的 `stripComments()`：那个**丢弃**注释，
 *     于是"抹过注释后的文本"与原文**偏移不同**，没法与另一个视图对齐取实参；
 *     本判据要同时看两个视图（检测视图抹字符串、取参视图留字符串）⇒ 必须**等长**。
 *     （同一件事、**不同契约**；若将来两边都只需要一种契约，就合并成一处。）
 *   · 为什么需要"抹字符串"这个视图：注释与**字符串里的示例写法不是实现**（`B4b`）。
 *     实测：本门禁的失败报文里写着「同时有 `fs.writeFileSync(` 与 `fs.renameSync(`」这句人话，
 *     不抹字符串它就把**自己**判成了"第二份原子写"（门禁把自己判红 ✗）。
 */
function blankQuoted(src, opts) {
  const o = opts || {};
  const text = String(src);
  const out = [];
  let i = 0;
  let quote = null;
  /** 上一个"有意义的代码字符"：用来判 `/` 是**正则字面量**还是除号。
   *  ⚠️ 实测教训（本批）：不认正则字面量时，`replace(/\u001b\[[0-9;]*m/g, '')` 这种写法会把
   *  后面的 `'` 状态机带跑偏 ⇒ 之后整段代码被当成"在字符串里"抹掉 ⇒
   *  **真违规（`fs.writeFileSync(path.join(ROOT,'docs','VERIFY.md'), …)`）静默漏过**。
   *  这不是理论：判别力证明里 甲1 就是这么漏的（门禁 exit 0 而注入明明成功）。 */
  let prevSig = '';
  const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^';
  while (i < text.length) {
    const c = text[i];
    const c2 = text[i + 1];
    if (quote) {
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === quote) { out.push(c); quote = null; i++; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i++; continue;
    }
    if (o.comments !== false && c === '/' && c2 === '/') {
      while (i < text.length && text[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (o.comments !== false && c === '/' && c2 === '*') {
      out.push(' ', ' '); i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out.push(text[i] === '\n' ? '\n' : ' '); i++;
      }
      if (i < text.length) { out.push(' ', ' '); i += 2; }
      continue;
    }
    // 正则字面量：`/` 跟在"运算符/开括号/行首/return 之后" ⇒ 是正则，不是除号
    if (c === '/' && (prevSig === '' || REGEX_PREV.indexOf(prevSig) >= 0
      || /(?:^|[^\w$])(return|typeof|case|in|of)$/.test(out.slice(-12).join('')))) {
      out.push(c); i++;
      let inClass = false;
      while (i < text.length) {
        const d = text[i];
        if (d === '\\') { out.push(' ', ' '); i += 2; continue; }
        if (d === '\n') break;                                  // 正则不跨行：保险起见到此为止
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { out.push(d); i++; break; }
        out.push(' '); i++;
      }
      prevSig = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c; out.push(c); i++;
      // strings:false ⇒ 字符串内容原样保留（只借用状态机跳过转义）
      if (o.strings === false) {
        while (i < text.length) {
          const d = text[i];
          if (d === '\\') { out.push(d); if (i + 1 < text.length) { out.push(text[i + 1]); i += 2; continue; } i++; continue; }
          out.push(d);
          if (d === c) { quote = null; i++; break; }
          i++;
        }
      }
      prevSig = c;
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '\n') prevSig = c;
    out.push(c); i++;
  }
  return out.join('');
}

/** 同文件里的 `X = <expr>` 绑定，**带位置**（`const` / `let` / `var` / 裸赋值都收）。
 *  实测教训（本批，两条都要记住）：
 *   ① 只按"同名取最后一处"会张冠李戴 —— `scripts/verify.js` 里三个函数各有一个 `p`，
 *      全局取最后一处就把 `path.join(ROOT,'.review/last-verify.json')` 认成了别的函数的表达式
 *      ⇒ 绑定必须**带位置**，由 `bindingsAt()` / `buildScopeIndex()` 按作用域挑；
 *   ② 正则**必须锚在声明关键字上**。上一版写成 `(?:^|[^\w$.])(?:const|let|var)?\s*(NAME)\s*=`
 *      （关键字可选）⇒ 它在 `scripts/smoke-assertions.js` 上**633 ms 只换来 18 条绑定**
 *      （每个位置都试着起配 + 回溯）⇒ S2 撞穿 10 s 预算。现在拆成两条**都带锚**的正则。
 */
function collectBindingList(code) {
  const out = [];
  const push = (name, posForScope, exprStart) => {
    const nl = code.indexOf('\n', exprStart);
    let expr = code.slice(exprStart, nl < 0 ? code.length : nl);
    const semi = expr.indexOf(';');
    if (semi >= 0) expr = expr.slice(0, semi);
    out.push({ name: name, expr: expr.trim(), pos: posForScope });
  };
  let m;
  const reDecl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  while ((m = reDecl.exec(code))) push(m[1], m.index, reDecl.lastIndex);
  const reAssign = /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  while ((m = reAssign.exec(code))) push(m[1], m.index, reAssign.lastIndex);
  return out;
}

/** 同文件里的 `X = <expr>` 绑定（Map 形态：同名取最后一处；**只用于不需要精确定位的场合**） */
function collectBindings(code) {
  const map = new Map();
  collectBindingList(code).forEach((b) => map.set(b.name, b.expr));
  return map;
}

/** 函数体块（`function name(…) { … }` / 箭头函数 / 方法简写）→ [{ start, end }]，pos 指向 `{` 与 `}`。
 *
 *  ⚠️ **必须一次扫描**（实测：S2 曾因这里超预算 —— 10.7s > 10s，而判据本身只值几十毫秒）：
 *  上一版对**每个** `function` 都从它自己往文件末尾扫一遍配平括号 ⇒ 大文件（`cli-integration.js`
 *  500 KB / 600+ 个函数）是 O(函数数 × 文件长) ≈ 3 亿次字符比较。现在：
 *   ① 只在候选点**近处**（≤4 KB）找函数体的 `{`；
 *   ② 用**一遍**括号栈把所有函数体配对（内层函数一并收进来）。
 */
function collectFunctionBlocks(code) {
  const bodyOpens = new Set();
  const re = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(|\bfunction\s*\(|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[0].slice(-1) === '{') { bodyOpens.add(m.index + m[0].length - 1); continue; }
    // 先配平参数表的 `(` `)`，再取紧随的 `{`
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let quote = null;
    for (; i < code.length && i - m.index < 4000; i++) {
      const c = code[i];
      if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    let found = -1;
    for (; i < code.length && i - m.index < 4000; i++) {
      const c = code[i];
      if (c === '{') { found = i; break; }
      if (c === ';') break;
    }
    if (found >= 0) bodyOpens.add(found);
  }
  const blocks = [];
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '{') stack.push(i);
    else if (c === '}' && stack.length) {
      const open = stack.pop();
      if (bodyOpens.has(open)) blocks.push({ start: open, end: i });
    }
  }
  return blocks;
}

/** 某文件的**作用域索引**：一次建好，之后每个写调用点只花 O(绑定数) 建一个 Map。
 *  （上一版 `bindingsAt` 对每个站点都遍历"全部绑定 × 全部块"⇒ 大文件上是 O(n³) 量级的浪费。）
 */
function buildScopeIndex(bindingList, blocks) {
  const sorted = blocks.slice().sort((a, b) => a.start - b.start);
  const globals = [];
  const perBlock = new Map();                       // block.start → [{name, expr, pos}]
  const innermostOf = (pos) => {
    let best = null;
    for (let k = 0; k < sorted.length; k++) {
      const b = sorted[k];
      if (b.start > pos) break;                     // 已排序：起点超过 pos 就不可能再包含它
      if (pos <= b.end && (!best || b.start > best.start)) best = b;
    }
    return best;
  };
  bindingList.slice().sort((a, b) => a.pos - b.pos).forEach((b) => {
    const inn = innermostOf(b.pos);
    if (!inn) { globals.push(b); return; }
    if (!perBlock.has(inn.start)) perBlock.set(inn.start, []);
    perBlock.get(inn.start).push(b);
  });
  return {
    blocks: sorted,
    globals: globals,
    perBlock: perBlock,
    /** 该偏移处的可见绑定：全局 ∪ 最内层函数块里"位置在我之前"的那些（同名者后写的覆盖先写的） */
    at: function (offset) {
      const map = new Map();
      globals.forEach((b) => map.set(b.name, b.expr));
      const inn = innermostOf(offset);
      if (inn) (perBlock.get(inn.start) || []).forEach((b) => { if (b.pos <= offset) map.set(b.name, b.expr); });
      return map;
    }
  };
}

/** 某个偏移处的可见绑定（保留这个签名给单测用；实现走 `buildScopeIndex`）。 */
function bindingsAt(list, blocks, offset) {
  return buildScopeIndex(list, blocks).at(offset);
}

function firstArgAt(code, at) {
  let i = code.indexOf('(', at);
  if (i < 0) return null;
  let depth = 0;
  let quote = null;
  let start = i + 1;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (quote) { if (c === '\\') { j++; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return code.slice(start, j); }
    else if (c === ',' && depth === 1) return code.slice(start, j);
  }
  return null;
}

/** 扫一个文件的写调用点（**纯函数**：入参是源码文本，出参是站点数组）
 *  两个**等长**视图（见 `blankQuoted` 的注释）：
 *    · `detectView` = 抹掉注释 + 字符串 ⇒ 只在这里认"写调用"，免得把报文里的示例写法当实现；
 *    · `argView`    = 只抹注释、保留字符串 ⇒ 在**同一偏移**上取实参原文（要读出路径字面量）。 */
function scanWriteSites(rel, rawSrc, root) {
  return scanViews(rel, blankQuoted(rawSrc, { comments: true, strings: true }),
    blankQuoted(rawSrc, { comments: true, strings: false }), root);
}

/** 用一个**已经抹好的两个视图**扫写调用点（给 `analyzeWriteOutlet` 复用 ——
 *  它每个文件本来就要建这两个视图（判定 ②/③ 都要看），再让 `scanWriteSites` 建一遍是纯浪费：
 *  实测 S2 因此从 ~0.3s 涨到 10.6s（把 10s 预算撞穿）。 */
function scanViews(rel, detectView, argView, root) {
  const base = root || ROOT;
  const blocks = collectFunctionBlocks(argView);
  const scope = buildScopeIndex(collectBindingList(argView), blocks);
  const returns = collectZeroArgReturns(argView, blocks);
  const dir = path.dirname(path.join(base, rel)).replace(/\\/g, '/');
  const lines = detectView.split('\n');
  const lineStarts = [];
  let acc = 0;
  lines.forEach((l) => { lineStarts.push(acc); acc += l.length + 1; });
  const sites = [];
  lines.forEach((line, idx) => {
    findWriteCalls(line).forEach((hit) => {
      const abs = lineStarts[idx] + hit.index;
      const arg = firstArgAt(argView, abs + hit.call.length);
      const target = arg == null ? null : arg.trim();
      const ctx = { bindings: scope.at(abs), returns: returns,
        dir: dir, file: path.join(base, rel), depth: 0, seen: new Set() };
      const resolved = target == null ? null : evalPathExpr(target, ctx);
      // "走了出口"：同一行（注释/字符串已抹掉的检测视图）里出现出口函数名
      const through = /writeFileAtomic\s*\(|writeManagedText\s*\(/.test(line);
      sites.push({ rel: rel, line: idx + 1, call: hit.call, target: target, resolved: resolved, through: through });
    });
  });
  return sites;
}

/** 收集扫描面（仓库相对 POSIX 路径） */
function woScanTargets(root) {
  const base = root || ROOT;
  const out = [];
  (function walk(relDir) {
    const abs = path.join(base, relDir);
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!WO_SKIP_DIRS.has(e.name)) walk(rel); }
      else if (/\.(js|mjs)$/.test(e.name)) out.push(rel);
    }
  })('');
  // 只看第一方：扫描目录 + 工程根的 *.js
  return out.filter((rel) => {
    if (rel.indexOf('/') < 0) return true;                       // 工程根文件
    return WO_SCAN_DIRS.some((d) => rel.startsWith(d + '/'));
  }).sort();
}

/** 自造 tmp+rename 的签名（判定 ②）：剥注释后同时有 writeFileSync 与 renameSync */
function hasSelfAtomicSignature(code) {
  return /fs\s*\.\s*writeFileSync\s*\(/.test(code) && /fs\s*\.\s*renameSync\s*\(/.test(code);
}

/**
 * ⑤ 写盘出口：判定 + 读数（纯函数；`root` 可指向副本 —— 判别力证明就是这么做的）
 * @returns {{ problems: Array, notes: Array, sites: Array, selfAtomic: Array, unmanaged: Array,
 *             unresolved: Array, ledger: Array, cap: number, readings: object }}
 */
function analyzeWriteOutlet(root) {
  const base = root || ROOT;
  const { stripComments } = require(path.join(ROOT, 'scripts', 'dep-direction-check.js'));
  const problems = [];
  const ledger = WRITE_OUTLET_DEBT.map((e) => e);
  const ledgerFiles = new Set(ledger.filter((e) => e.kind === 'file').map((e) => e.at));

  const files = woScanTargets(base);
  const matchers = woAssetNameMatchers();
  const all = [];
  const selfAtomic = [];
  const unmanaged = [];
  const unresolved = [];
  /** 判定 ③ 的对象：文件"提得到"受管资产名、又有**判不了**的裸写 ⇒ 它可能在写受管资产 */
  const suspects = new Map();
  let writeSites = 0;
  files.forEach((rel) => {
    let raw;
    try { raw = fs.readFileSync(path.join(base, rel), 'utf8'); } catch (e) { return; }
    const codeView = blankQuoted(raw, { comments: true, strings: true });   // 只看代码，不看报文/注释
    const pathView = blankQuoted(raw, { comments: true, strings: false });  // 保留字符串（路径都是字面量）
    if (rel !== WO_OUTLET_FILE && hasSelfAtomicSignature(codeView)) selfAtomic.push(rel);
    const namesAsset = matchers.some((m) => pathView.indexOf(m.needle) >= 0);
    const sites = scanViews(rel, codeView, pathView, base);                 // ← 复用上面那两个视图
    writeSites += sites.length;
    sites.forEach((s) => {
      if (s.through) return;                                     // 走出口：不是裸写
      if (s.resolved == null) {
        unresolved.push(s);                                       // 判不了：可见计数，不判红（判定 ③ 兜底）
        if (namesAsset) {
          if (!suspects.has(rel)) suspects.set(rel, []);
          suspects.get(rel).push(s);
        }
        return;
      }
      const relOfTarget = path.relative(base, s.resolved).replace(/\\/g, '/');
      const inside = relOfTarget && relOfTarget.indexOf('..') !== 0 && !path.isAbsolute(relOfTarget);
      if (!inside) { unmanaged.push(s); return; }                 // 仓库之外（%TEMP% 沙箱等）
      const fam = woManagedFamily(relOfTarget);
      if (!fam) { unmanaged.push(s); return; }
      all.push(Object.assign({}, s, { targetRel: relOfTarget, family: fam }));
    });
  });

  // ---- 判定 ①：受管资产上的裸写（整文件在册豁免除外）----
  all.forEach((s) => {
    if (ledgerFiles.has(s.rel)) return;
    problems.push({
      kind: 'write-outlet',
      msg: '受管资产上有**裸写**：`' + s.rel + ':' + s.line + '` 写的是 `' + s.targetRel + '`'
        + '（' + s.family.label + '）—— 写盘出口只有 `src/data-store.js` 的 '
        + '`writeFileAtomic` / `writeManagedText`（声明见 `docs/ARCHITECTURE.md` §6 横切规矩 ①）'
    });
  });

  // ---- 判定 ②：自造第二份原子写 ----
  selfAtomic.forEach((rel) => {
    if (ledger.some((e) => e.at === rel && e.kind === 'self-atomic')) return;
    problems.push({
      kind: 'write-outlet',
      msg: '`' + rel + '` 里同时有 `fs.writeFileSync(` 与 `fs.renameSync(` ⇒ 这是**第二份原子写实现**'
        + '（tmp + rename）；写盘出口只有一个函数（`src/data-store.js` 的 `writeFileAtomic`）'
    });
  });

  // ---- 判定 ③：覆盖面（文件级封闭）——
  //   一个文件**提得到**受管资产名、又有判不了目标的裸写 ⇒ 它可能在写受管资产 ⇒ 必须在册
  //   （人工核实过"它其实写的是 %TEMP% / .review 证据"才算过关）。这一条兜的正是
  //   "目标路径来自变量"那个天然盲区：`docs-registry-check.js` T2 之前就是这种形状
  //   （写在 `writeRegistryTable(root)` 里，调用行上根本没有 `docs/`）。
  Array.from(suspects.keys()).sort().forEach((rel) => {
    if (ledgerFiles.has(rel)) return;
    problems.push({
      kind: 'write-outlet',
      msg: '`' + rel + '` 既提得到受管资产名、又有 ' + suspects.get(rel).length
        + ' 处**判不了目标**的裸写（行 '
        + suspects.get(rel).slice(0, 6).map((s) => s.line).join(', ')
        + (suspects.get(rel).length > 6 ? ' …' : '')
        + '）⇒ 它可能在写受管资产 —— 要么改成走出口，要么连同"人工核实结论"登记进'
        + ' `WRITE_OUTLET_DEBT`（`kind: file`）'
    });
  });

  // ---- 欠账册四条机械判定（在册算欠账 / 只减不增 / 册上文件必须存在 / 每条 why+close）----
  const managedFiles = new Set(all.map((s) => s.rel));
  ledger.forEach((e) => {
    if (!fs.existsSync(path.join(base, e.at))) {
      problems.push({ kind: 'ledger', msg: '欠账册上写着 `' + e.at + '`，但磁盘上没这个文件（改名/删了？）' });
      return;
    }
    if (e.kind === 'file') {
      const still = managedFiles.has(e.at) || suspects.has(e.at);
      if (!still) {
        problems.push({ kind: 'ledger', msg: '欠账册把 `' + e.at + '` 整文件登记在册，但它**当前既不写受管资产、'
          + '也没有判不了目标的裸写** —— 修好了就销账（照 cap 只减不增：同批把 cap 也调小）' });
      }
    }
    if (e.kind === 'self-atomic' && !selfAtomic.includes(e.at)) {
      problems.push({ kind: 'ledger', msg: '欠账册写着 `' + e.at + '` 有自造 tmp+rename，但它**已经没有了**'
        + ' —— 修好了就销账（同批把 cap 也调小）' });
    }
    if (e.kind !== 'file' && e.kind !== 'self-atomic') {
      problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 的 `kind` 只能是 `file` 或 `self-atomic`' });
    }
    if (e.verdict !== 'keep' && e.verdict !== 'debt') {
      problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 的 `verdict` 只能是 `keep`（有据降级）'
        + ' 或 `debt`（欠账）—— "没裁决"不许混过去' });
    }
    if (!e.why || !e.close) {
      problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 缺 `why` 或 `close`'
        + '（每条都要写清"为什么现在还这样"与"何时清 / 何时升级"）' });
    }
  });
  if (ledger.length > WRITE_OUTLET_CAP) {
    problems.push({ kind: 'ledger', msg: '欠账册有 ' + ledger.length + ' 条，超过上限 ' + WRITE_OUTLET_CAP
      + '（cap **只减不增**：新增一条须同批抬 cap 并写明为什么这一条短期清不掉）' });
  }

  const readings = {
    files: files.length,
    writeSites: writeSites,
    managedSites: all.length,
    unmanagedSites: unmanaged.length,
    unresolvedSites: unresolved.length,
    suspectFiles: suspects.size,
    selfAtomic: selfAtomic.length,
    ledger: ledger.length,
    cap: WRITE_OUTLET_CAP,
    debt: ledger.filter((e) => e.verdict === 'debt').length,
    keep: ledger.filter((e) => e.verdict === 'keep').length,
    exemptedSites: all.filter((s) => ledgerFiles.has(s.rel)).length,
    tokens: new Set(matchers.map((m) => m.label)).size
  };
  if (readings.writeSites !== readings.managedSites + readings.unmanagedSites + readings.unresolvedSites) {
    problems.push({ kind: 'closure', msg: '写调用点分档不平：总数 ' + readings.writeSites + ' ≠ 受管 '
      + readings.managedSites + ' + 非受管 ' + readings.unmanagedSites + ' + 判不了 ' + readings.unresolvedSites });
  }

  const notes = [
    '写盘出口：扫描面 ' + readings.files + ' 个第一方文件 / ' + readings.writeSites + ' 个写调用点'
      + ' —— 受管资产 ' + readings.managedSites + '（其中 ' + readings.exemptedSites + ' 处在册豁免）· '
      + '非受管 ' + readings.unmanagedSites + ' · **判不了 ' + readings.unresolvedSites + '**（目标来自参数/运行时，'
      + '本判据算不出来 —— 逐条列在 `--list` 里，不假装查过；判定 ③ 按**文件**兜底，'
      + '提得到受管资产名又有判不了裸写的文件有 ' + readings.suspectFiles + ' 个）',
    '自造 tmp+rename：' + readings.selfAtomic + ' 个文件（'
      + (selfAtomic.join(' / ') || '无') + '）—— 出口本体 `' + WO_OUTLET_FILE + '` 除外',
    '欠账册：' + readings.ledger + ' 条 / 上限 ' + readings.cap + '（欠账 ' + readings.debt
      + ' · 有据降级 ' + readings.keep + '）；受管资产名 tokens ' + readings.tokens + ' 个（从 §5 登记表现取）'
  ];
  return {
    problems, notes, sites: all, selfAtomic: selfAtomic, unmanaged: unmanaged,
    unresolved: unresolved, suspects: suspects, ledger: ledger, cap: WRITE_OUTLET_CAP, readings: readings
  };
}

function main() {
  const list = process.argv.includes('--list');
  // `--root=<dir>`：**只影响判定 ⑤ 的扫描根**（判别力证明把判据指向 %TEMP% 副本用；
  // 不加这个开关时输出与从前逐字节相同 —— H3：新能力走 opt-in 开关，不给默认路径加成本）。
  const rootArg = (process.argv.slice(2).find((a) => a.startsWith('--root=')) || '').slice(7);
  const r = analyze(rootArg ? { writeOutletRoot: path.resolve(rootArg) } : {});

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
    console.log('');
    console.log('== ⑤ 写盘出口：受管资产上的裸写（逐条）==');
    if (!r.writeOutlet.sites.length) console.log('  （无：所有落在受管资产上的写调用点都走了出口或在册豁免）');
    r.writeOutlet.sites.forEach((s) => {
      const exempt = r.writeOutlet.ledger.some((e) => e.kind === 'file' && e.at === s.rel);
      console.log('  ' + (exempt ? '[在册豁免] ' : '') + s.rel + ':' + s.line + '  [' + s.call + '] → '
        + s.targetRel + '   ' + s.family.label);
    });
    console.log('');
    console.log('== ⑤ 写盘出口：判不了的目标（目标来自参数/运行时 —— 如实计数，不假装查过）==');
    if (!r.writeOutlet.unresolved.length) console.log('  （无）');
    const byFile = new Map();
    r.writeOutlet.unresolved.forEach((s) => {
      if (!byFile.has(s.rel)) byFile.set(s.rel, []);
      byFile.get(s.rel).push(s.line);
    });
    Array.from(byFile.keys()).sort().forEach((f) => {
      console.log('  ' + f + '  ×' + byFile.get(f).length + '（行 ' + byFile.get(f).slice(0, 12).join(', ')
        + (byFile.get(f).length > 12 ? ' …' : '') + '）');
    });
    console.log('');
    console.log('== ⑤ 欠账册（封闭：cap 只减不增；每条 why / close）==');
    r.writeOutlet.ledger.forEach((e) => {
      console.log('  · ' + e.at + '  [' + e.kind + ' · ' + e.verdict + ']');
      console.log('      why  ：' + e.why);
      console.log('      close：' + e.close);
    });
    console.log('  合计 ' + r.writeOutlet.ledger.length + ' 条 / 上限 ' + r.writeOutlet.cap);
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
  missingFromIndex, declaredChecks, referencedGates, mountedGates, analyze,
  // ⑤ 写盘出口（判定与读数都在这里，别在别处再写一份）
  WRITE_OUTLET_CAP, WRITE_OUTLET_DEBT, WO_OUTLET_FILE, WO_WRITE_NAMES, findWriteCalls,
  woManagedFamily, evalPathExpr,
  splitTopLevel, wholeCall, collectBindings, collectBindingList, collectFunctionBlocks, bindingsAt,
  collectZeroArgReturns,
  blankQuoted, firstArgAt, scanWriteSites, scanViews, woScanTargets, woAssetNameMatchers,
  buildScopeIndex,
  hasSelfAtomicSignature, analyzeWriteOutlet
};

if (require.main === module) main();
