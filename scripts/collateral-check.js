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
 * 判定清单（编号只在下面正文与 `--list` 里出现，本行不写条数 —— 条数只有一个权威）：
 *   ①②③④ 是**连带清单**那几条，⑤ 那一节自己有若干条（写盘出口），各自的编号与能力边界只在那一节写一次。
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
        note: '判定的另一半：新出现第三个自造实现 ⇒ 红；存量逐条在册（带 why / close）' },
      { at: '`src/data-store.js` 的 `writeFileAtomic` 的**原子语义**（写 tmp → fsync → rename）', role: 'self',
        check: 'WRITE_OUTLET',
        note: '判定 ③（2026-10-19 补）：三条腿任一条掉了、或内容被直接写到目标 ⇒ 红。'
          + '实测（`e0f992c` 的 I3）：把原子实现换成一把裸写，旧的四道判据**全绿** —— 降级方向以前没人看' }
    ]
  },
  {
    id: 'note-detail',
    when: '新增 / 编辑一条笔记的 `detail`（正文；语义 = innerHTML）',
    places: [
      { at: '`projects/<项目>/<项目>.json` 里的 `node.detail`', role: 'body',
        note: '正文的落点：`detail` 是 **HTML 片段**（契约 `docs/DATA-FORMAT.md` §2.4），'
          + '渲染层 `renderer/app-detail-content.js` 直接 `dc.innerHTML = detail`' },
      { at: 'Markdown → HTML 的**唯一转换出口**（`--detail-md` / `import-md` → `markdownToHtml`）', role: 'body',
        note: '要写 Markdown 就走这条出口；手写 HTML 时**别把 Markdown 语法抄进 detail**（那会字面显示）' },
      { at: '`detail` 里的**成对 Markdown 定界符**（`**…**` / 成对反引号 / 围栏 / `[字](链)` / 行首 `#`）',
        role: 'self', check: 'NOTE_RESIDUE',
        note: '本门禁直接断言：命中即成**坏字**（`ada00407` 实测一批里写进数十处 `**粗体**` + 反引号，'
          + '而 `validate-all` 全绿 —— 数据闸门只校结构、不校呈现）。判据与三档边界见文件下部"⑥"' },
      { at: '「这条 detail 写得对不对」（内容是否覆盖要点）', role: 'residual',
        note: '残差：内容好不好是人的判断 —— 未机械化，别假装有守卫' }
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
const CHECKS = ['MCP', 'SMOKE_INDEX', 'WRITE_OUTLET', 'NOTE_RESIDUE'];

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

  // (f) ⑥ 笔记正文残留：`detail` 里不许留 Markdown 定界符（契约 §2.4 的另一半守卫）
  //    `noteResidueRoot` 同样只给**判别力证明**用（把同一份判据指向夹具 ⇒ 真仓一个字节不动）。
  //    ⚠️ 换了扫描根就**不拿真仓那本册去核**：`NOTE_RESIDUE_DEBT` 声明的是**真仓 `projects/` 的存量**，
  //    指向夹具副本时它必然"悬挂登记"（那会变成证明过程自己造假红）。要核册就用默认根；
  //    夹具侧要册请显式传 `noteResidueLedger`。
  const noteResidue = analyzeNoteResidue(o.noteResidueRoot || path.join(ROOT, NOTE_RESIDUE_ROOT),
    o.noteResidueRoot ? (o.noteResidueLedger || null) : NOTE_RESIDUE_DEBT);
  noteResidue.problems.forEach((p) => problems.push(p));
  noteResidue.notes.forEach((n) => notes.push(n));

  return { problems, notes, dispatched, domains, mounted, checks: CHECKS.slice(),
    writeOutlet: writeOutlet, noteResidue: noteResidue };
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
 * 互补的几条判定（**缺任何一条就漏一个方向**；编号见下）：
 *   ① **裸写受管资产**：写调用点的**目标路径**（按字面量求值解析出来的）落在受管资产上、
 *      且这一处没走 `writeFileAtomic` / `writeManagedText` ⇒ 红。
 *   ② **自造第二份原子写**：文件里同时出现 `fs.writeFileSync(` 与 `fs.renameSync(`（tmp + rename
 *      的签名）⇒ 它就是"第二份写盘出口"⇒ 红（出口本体 `src/data-store.js` 除外）。
 *   ③ **出口本体不许被降级**（2026-10-19 本批补）：`src/data-store.js` 的 `writeFileAtomic` 必须仍然
 *      "写 tmp → fsync → rename"，三条腿任一条掉了、或内容被直接写到目标 ⇒ 红。
 *      为什么必须有这一条（★实测 `e0f992c` 的 I3）：**降级方向**以前判不出来 —— 换成一把裸写后
 *      ② 的签名（两个名字同时出现）反而**不成立**，① 的目标是形参、④ 要文件"提得到受管资产名"
 *      而出口本体提不到 ⇒ **四道全盲**。判据与能力边界见 `outletAtomicVerdict` 的头注。
 *   ④ **按调用点兜底**（本批从"按文件"改成"按调用点"）：一处裸写**判不了目标**、而它所在文件
 *      **提得到受管资产名** ⇒ 这一处必须在册。按文件兜底时，整文件豁免会**先短路**（`main.js`
 *      就是这个形状：实测 I1 因此 exit 0），改了粒度之后新增的第 8 处会红。
 *
 * 豁免（`B8`：豁免是一等公民，但**不由被检查方决定**）：登记在门禁侧的 `WRITE_OUTLET_DEBT`，
 *   两种粒度 —— `kind: 'file'`（整文件）与 `kind: 'site'`（逐调用点，按**第一实参签名**匹配，
 *   带 `n` = 处数）。**两道 cap**：条数 `WRITE_OUTLET_CAP` + 面 `WRITE_OUTLET_SITE_CAP`（见册头）。
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
 *   每条：{ at, kind, verdict, why, close }，`kind` 三档：
 *     · `'file'`      —— **整文件**的写调用点豁免（该文件里所有写调用点都算在册）
 *     · `'site'`      —— **逐调用点**豁免：另带 `sites: [{ sig, n, what }]`，
 *                        `sig` = 该写调用的**第一实参原文**（折行归一成单空格）⇒ 行号漂移不影响匹配；
 *                        `n` = 册上记的**处数**（同一文件里同签名的写可能不止一处）
 *     · `'self-atomic'` —— 自造 tmp+rename（判定 ② 的对象）
 *   为什么要有 `'site'`（本批收窄的依据）：整文件豁免挡掉的是"**这个文件以后新增的**"写，
 *   而 `main.js` 是今天最容易回潮的文件（W1 就回潮在它身上）⇒ 照 `B8` 的 ③"豁免要有数量上界"
 *   把它从"整个文件"缩到"7 个已知调用点"：**已知 7 处仍豁免，第 8 处判红**。
 *   代价（如实说，`R6`）：签名是**第一实参原文** ⇒ 有人把它重命名（`out` → `captureOut`）就会报红。
 *   这一档**故意保留**这种红 —— 被豁免的裸写本来就应该在改动时被重新看一眼；报文会直接给出
 *   "册上是哪个签名、现在看到的是什么"，改册是一行的事。
 * --------------------------------------------------------------- */
const WRITE_OUTLET_CAP = 8;
/** 「豁免**面**」的上界（分子：被在册豁免覆盖的写调用点数，现测 82）。
 *  为什么必须有第二条 cap：`WRITE_OUTLET_CAP` 数的是**例外单元**（条目数），这一条数的是
 *  **被藏起来的调用点**。把 1 条「整文件豁免」拆成 N 条「逐调用点豁免」，条目数涨、**面一点没小**
 *  ⇒ 只卡条数就等于允许"拆细换额度"（`A3`：数字要能表达它声称表达的那件事）。
 *  面**只减不增**：要新增一处豁免就必须先还掉一处旧的（或同批把这条 cap 抬起来并写清为什么）。 */
const WRITE_OUTLET_SITE_CAP = 82;
const WRITE_OUTLET_DEBT = [
  {
    at: 'main.js',
    // 2026-10-19：`file` → `site`（本批）。**豁免面没变小（还是这 7 处），变的是"第 8 处会不会红"** ——
    // 原来的整文件豁免让判定 ①/④ 对这个文件**整体短路**：实测把 W1 的探针写回 `projects/` ⇒ S2 exit 0；
    // 关掉豁免才 exit 1（点名 `main.js` 里那两处）。收窄后同样的注入**直接判红**，而 7 处已知的仍豁免。
    kind: 'site',
    sites: [
      { sig: 'res.filePath', n: 1,
        what: '导出图片：用户在**保存对话框**里选的路径（`res` 来自 `dialog.showSaveDialog`）⇒ 仓库外' },
      { sig: 'feedbackFile()', n: 1,
        what: '`<userData>/mm-feedback.jsonl`（正式档）或沙箱里的 `mm-feedback.jsonl`（冒烟档）⇒ 两支都在仓库外。'
          + '求值器追不进去的真因：`feedbackFile()` 有**两个** `return`，而 `collectZeroArgReturns` 只取第一个' },
      { sig: 'p', n: 1,
        what: '`p = path.join(SMOKE_PROJECTS_DIR, rel)` —— 冒烟"沙箱副本还原"写回；`SMOKE_PROJECTS_DIR` = '
          + '`fs.mkdtempSync(path.join(os.tmpdir(), …))` ⇒ 仓库外' },
      { sig: 'dumpTo', n: 1,
        what: '`process.env.MM_SMOKE_TIMING_OUT` 指定的计时 JSON（**默认一个字节都不写**）。⚠️ 这是 7 处里'
          + '**唯一"目标不由我们定"**的一处：环境变量原则上可以指进仓库 ⇒ 它的 `close` 比别的更该盯' },
      { sig: 'out', n: 2,
        what: '`--out` 指定的截图 / 合成图输出路径（两个 CLI 入口各一处，都来自 argv）⇒ 仓库外' },
      { sig: "path.join(REAL_PROJECTS_DIR, '_leak-inject-probe.json')", n: 1,
        what: '**这 7 处里唯一的真裸写**：受管资产 `projects/_leak-inject-probe.json`。它只在 '
          + '`MM_SMOKE_LEAK_INJECT=1` 下生效、是**判别力证明用**的故意注入（跑完复核必须判红）' }
    ],
    verdict: 'keep',
    why: '**7 处逐一人工核过**（2026-10-19 现算的签名见 `sites[].sig` / `--list` 逐条打印）：6 处**判不了**'
      + '（目标来自保存对话框 / `<userData>` / `%TEMP%` 沙箱 / argv，求值器算不出来，人工核实 5 处在仓库外、'
      + '`dumpTo` 那处由环境变量定）+ 1 处**真裸写**（`projects/_leak-inject-probe.json`，判别力注入，门控）。'
      + ' **`.validate` 校验探针写进 `projects/<项目>/` 的那一处已偿（2026-10-19）**：保存闸门改成**进程内**校验'
      + '（`src/data-store.js` 的 `createProjectValidator`，与 CLI 写路径同一个工厂）⇒ 不再有临时文件。'
      + ' 本批把 `kind` 从 `file` 收窄成 `site`：**已知 7 处仍豁免，新增的第 8 处判红**。',
    close: '升级触发条件（命中任一条就回来收口）：① 上面任何一处写目标改成**工程内**路径'
      + '（例如导出默认落到工程根、冒烟沙箱改到 `projects/` 下；`dumpTo` 那条环境变量指进仓库也算）；'
      + '② 那个泄漏注入探针从 `MM_SMOKE_LEAK_INJECT` 门控变成默认路径（那时它就不再是"判别力证明"而是真违规）；'
      + '③ `feedbackFile()` / `SMOKE_PROJECTS_DIR` 改成工程内路径（那时 `sig` 就能求值了，也就该走出口）。'
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
    why: '**为什么仍是整文件豁免（本批未逐点收窄）**：这个文件今天有 **64 处**判不了目标的裸写（夹具造坏数据），'
      + '逐点登记 64 条签名不可维护、且每次加夹具都要改门禁 —— 照 `R6` 先量价值：它没有回潮史，'
      + '而 main.js 有（W1）。**代价如实说**：这个文件里新增的裸写今天不会被判红（豁免面 64 处在册）。'
      + '原始理由：集成断言必须在**真实** `projects/` 下造"读不出来的项目 / 坏 JSON / 悬挂成员"这类夹具 —— '
      + '它验的正是 `store` 对坏数据的反应，走出口（会先校验）就**造不出**这些前置条件。'
      + '其余夹具写在 %TEMP% 沙箱（md/pdf/png 输入）。全部自建自删。',
    close: '升级触发条件：若 CLI 提供一个 **test-only 的原始写入口**（如 `mm-cli raw-write --for-test`），'
      + '就改用它。在此之前保持整文件豁免（写目标逐条见 `node scripts/collateral-check.js --list`）。'
  },
  {
    at: 'main-dsh-sidebar.js',
    kind: 'file',
    verdict: 'keep',
    why: '**为什么仍是整文件豁免（本批未逐点收窄）**：3 处、无回潮史；收窄只是把"整个文件"换成 3 条签名，'
      + '收益（挡"第 4 处"）小于签名漂移带来的假红面 —— 本批只收窄了有回潮史的 `main.js`。'
      + '原始理由：3 处判不了的写目标：`162 path.join(dir, "SKILL.md")`（`dir` = 用户选的**技能目录**，'
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
    why: '**为什么仍是整文件豁免（本批未逐点收窄）**：6 处里有 2 对同名签名（`outArg` ×2 / `p`），'
      + '逐点登记挡不住"同签名新增一处"，收益小；无回潮史。原始理由：5 处判不了的写目标全部落在 '
      + '**%TEMP% 的镜像副本**（`abs(rel)` = 副本根相对路径、'
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
    why: '**为什么仍是整文件豁免（本批未逐点收窄）**：只有 1 处（`sig=file`），收窄与整文件等价、'
      + '没有额外收益。原始理由：`104 fs.writeFileSync(file, …)` 里的 `file = path.join(dir, reg.batchId + ".json")`，'
      + '`dir` = **`.review/batches/`**（工作产物区里的"批登记面"）—— 它写的是本机协作登记，'
      + '不是受管资产（`.review/` 可整目录删、不进扫描、不进版本库）。它"提得到受管资产名"'
      + '只是因为在参数说明里写了 `\'projects\'`。',
    close: '升级触发条件：若"批登记面"从 `.review/` 搬进 `docs/`（变成受管登记表），就必须重新裁决。'
  },
  {
    at: 'scripts/smoke/50-五星评价.js',
    kind: 'file',
    verdict: 'keep',
    why: '**为什么仍是整文件豁免（本批未逐点收窄）**：只有 1 处（`sig=FEEDBACK_FILE`），'
      + '收窄与整文件等价、没有额外收益。原始理由：`468 fs.appendFileSync(FEEDBACK_FILE, …)` 里的 '
      + '`FEEDBACK_FILE = feedbackFile()` = '
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

/** 受管资产的**名字**（判定 ④ 的输入：一个文件"提得到"受管资产吗）。
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
 *  它每个文件本来就要建这两个视图（判定 ①/②/④ 都要看），再让 `scanWriteSites` 建一遍是纯浪费：
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

/** 自造 tmp+rename 的签名（判定 ②）：剥注释后同时有 writeFileSync 与 renameSync
 *  ⚠️ 这条签名**只挡"第二份实现"**，挡不住"把唯一的实现降级"—— 降级后 rename 那条腿没了，
 *  签名反而**不成立** ⇒ 越弱越不红。那一半由判定 ③（`outletAtomicVerdict`）兜。 */
function hasSelfAtomicSignature(code) {
  return /fs\s*\.\s*writeFileSync\s*\(/.test(code) && /fs\s*\.\s*renameSync\s*\(/.test(code);
}

/* ---------------------------------------------------------------
 * 判定 ③：出口本体的原子写**不许降级**（`tmp → fsync → rename` 三条腿必须都在）
 * ---------------------------------------------------------------
 * ★为什么需要这一条（实测，`e0f992c` 的 I3 注入）：把 `writeFileAtomic` 的原子实现换成**一把裸写**
 * （无 tmp / 无 fsync / 无 rename）⇒ 旧判据 **exit 0（绿）**。机制是四道全盲：
 *   ① 判定 ② 的签名要求"`writeFileSync` 与 `renameSync` **同时出现**"—— 降级把 rename 那条腿删了，
 *      签名反而不成立 ⇒ **越弱越不红**（方向性缺陷，不是覆盖率不足）；
 *   ② 判定 ② 按文件名排除出口本体（它本来就必须同时有那两个名字，不排除就恒红）；
 *   ③ 出口本体的写调用点第一实参是**函数形参** ⇒ 路径求值器判不了 ⇒ 落在"判不了"那一档；
 *   ④ 按文件兜底（判定 ④）要"文件提得到受管资产名"—— `src/data-store.js` 提不到。
 *   ⇒ **出口本体在四道判据里全是盲区**，而它正是"断电留半截文件"这一族风险的**唯一**防线。
 *      "并发/写坏"那一族的守卫如果可以被悄悄换成更弱的东西而没人红，那它守的就不是它声称的东西。
 *
 * 判据形态（源码**形状**断言；输入是**剥注释 + 抹字符串**的代码 —— `B4b`：报文与注释里的示例写法
 * 不是实现，本文件自己的失败报文里就写着那两个名字）：
 *   `writeFileAtomic` 的函数体必须同时成立三条腿 ——
 *     · `write`  ：有写调用，且**没有**一处把内容直接写到它自己的第一个形参（= 写 tmp，不写目标）；
 *     · `fsync`  ：有 fsync（`fsyncSync` / `fsync` / `.sync()` / `.datasync()`）；
 *     · `rename` ：有 rename（`renameSync` / `renameWithRetry` / `.rename()`）。
 *   任一条不成立 ⇒ **红**，报文点名缺哪条腿。**定义找不到 / 出现两份 ⇒ 也红**（采不到真值 = 红，`A5`）。
 *
 * 能力边界（诚实标注，别以为它包住一切）：
 *   · 它判"**形状在不在**"，判不了"**语义对不对**"（例如把 rename 的目标换成同一目录下的错文件，
 *     形状仍成立）；
 *   · 它只钉**出口本体**这一个函数。**调用点**被换成裸写（I3 的真实形状是
 *     `fs.writeFileSync(activePath(userDataPath), …)`，裸写的是 `<userData>` 下的运行包指针）
 *     这一条**抓不到** —— 那处目标既不是受管资产、也求值不出来；要抓它得让求值器认更多写法
 *     （见 `evalPathExpr` 的能力边界），那是另一批。
 */

/** 出口本体里那个函数的名字（判定 ③ 的扫描靶；**唯一一处**） */
const WO_OUTLET_FN = 'writeFileAtomic';

/** 三条腿的人话（报文与 `--list` 都从这里取，别在别处再写一份） */
const WO_ATOMIC_LEG_TEXT = {
  write: '写 tmp（先写同目录临时文件，不直接写目标）',
  fsync: 'fsync（先落盘，再替换）',
  rename: 'rename（原子替换目标）',
  param: '第一个形参（没有它判不了"写的是不是目标" ⇒ 判不了 = 红）'
};

/**
 * 判定 ③ 的判据本体（**纯函数**：入参是源码文本）。
 * @returns {{ok:boolean, defs:number, line:(number|null), param:(string|null),
 *            write:boolean, fsync:boolean, rename:boolean,
 *            direct:string[], missing:string[]}} `missing` ∈ `WO_ATOMIC_LEG_TEXT` 的键（+ `'def'`）
 */
function outletAtomicVerdict(src) {
  const code = blankQuoted(src, { comments: true, strings: true });
  const re = new RegExp('function\\s+' + WO_OUTLET_FN + '\\s*\\(', 'g');
  const defs = [];
  let m;
  while ((m = re.exec(code))) defs.push(m.index);
  const out = { ok: false, defs: defs.length, line: null, param: null,
    write: false, fsync: false, rename: false, direct: [], missing: [] };
  // 0 份 = 函数没了（改名/搬走）；2 份 = 说不清哪一份是出口 ⇒ 两种都"采不到真值"
  if (defs.length !== 1) { out.missing.push('def'); return out; }
  const def = defs[0];
  out.line = code.slice(0, def).split('\n').length;

  // 形参表的第一个形参（= "目标文件"）
  const open = code.indexOf('(', def);
  if (open < 0) { out.missing.push('def'); return out; }
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) { out.missing.push('def'); return out; }
  const params = splitTopLevel(code.slice(open + 1, close), ',');
  out.param = params.length && params[0] ? params[0].trim() : null;

  // 函数体
  const bodyOpen = code.indexOf('{', close);
  if (bodyOpen < 0) { out.missing.push('def'); return out; }
  let d2 = 0;
  let bodyClose = -1;
  for (let i = bodyOpen; i < code.length; i++) {
    if (code[i] === '{') d2++;
    else if (code[i] === '}') { d2--; if (d2 === 0) { bodyClose = i; break; } }
  }
  if (bodyClose < 0) { out.missing.push('def'); return out; }
  const body = code.slice(bodyOpen + 1, bodyClose);

  out.rename = /\brenameSync\s*\(|\brenameWithRetry\s*\(|\.rename\s*\(/.test(body);
  out.fsync = /\bfsyncSync\s*\(|\bfsync\s*\(|\.sync\s*\(|\.datasync\s*\(/.test(body);

  // 写调用：有几处、有没有一处直接写目标（= 第一个形参）
  let writes = 0;
  let acc = 0;
  body.split('\n').forEach((line) => {
    const lineStart = acc;
    acc += line.length + 1;
    findWriteCalls(line).forEach((hit) => {
      writes++;
      const arg = firstArgAt(body, lineStart + hit.index + hit.call.length);
      const a = arg == null ? null : arg.trim();
      if (a && out.param && a === out.param) out.direct.push(a);
    });
  });
  out.write = writes > 0 && out.direct.length === 0;
  if (writes === 0) out.missing.push('write');
  else if (out.direct.length) out.missing.push('write');       // 直接写目标 ⇒ 没写 tmp
  if (!out.fsync) out.missing.push('fsync');
  if (!out.rename) out.missing.push('rename');
  if (!out.param) out.missing.push('param');                   // 读不出形参 ⇒ "写的是不是目标"判不了
  out.ok = out.missing.length === 0;
  return out;
}

/** 把 `outletAtomicVerdict` 的结论译成一句人话（`--list` 与判红报文共用） */
function describeAtomicVerdict(v) {
  if (v.missing.indexOf('def') >= 0) {
    return v.defs === 0
      ? '找不到 `' + WO_OUTLET_FN + '` 的定义（改名/搬走了？）⇒ **采不到真值 = 红**'
      : '`' + WO_OUTLET_FN + '` 有 ' + v.defs + ' 份定义 ⇒ 说不清哪一份是出口 ⇒ **采不到真值 = 红**';
  }
  const why = v.direct.length
    ? '内容被**直接写到目标** `' + v.direct[0] + '`（没有先写同目录临时文件）'
    : (v.write ? '' : '函数体里**一次写调用都没有**');
  const lost = v.missing.map((k) => WO_ATOMIC_LEG_TEXT[k]).filter(Boolean);
  return (why ? why + '；' : '') + (lost.length ? '缺：' + lost.join(' / ') : '三条腿都在');
}

/** 写调用点「签名」的归一（`B8` ③ 逐调用点豁免的匹配口径，**唯一一处**）：
 *  = 该写调用的**第一实参原文**，折行/多个空白归一成单空格后去首尾。
 *  为什么用签名而不是行号（实测）：册上写着的行号已经漂过 —— 上批的报文点名 `main.js:1664`,
 *  而现测那一处（真裸写注入探针）在 `main.js:3139`；按行号登记等于给门禁装一个**必红**的时钟。
 *  代价：重命名实参（`out` → `captureOut`）会报红 —— 这一档**故意保留**（见册头注释）。
 */
function normSig(target) {
  return String(target == null ? '' : target).replace(/\s+/g, ' ').trim();
}

/**
 * 由欠账册建一个「**这一处写调用点是否在册**」的判定器（**纯函数** —— 可以单独喂一本假册，
 * 于是"逐调用点豁免到底怎么匹配"这件事能被单测钉住，`B6`）。
 *   两种粒度：
 *     · `kind: 'file'` ⇒ 该文件里**所有**写调用点都算在册（按文件跳过）；
 *     · `kind: 'site'` ⇒ 只有 `sites[].sig` 命中**这一处**的第一实参才在册（按调用点跳过）。
 *   `sig` 匹配走 `normSig`（折行/多余空白归一）⇒ 调用行换行不必改册。
 */
function makeExemptMatcher(ledger) {
  const fileExempt = new Set();
  const sigExempt = new Map();                     // 文件 → Set(签名)
  (ledger || []).forEach((e) => {
    if (!e || !e.at) return;
    if (e.kind === 'file') { fileExempt.add(e.at); return; }
    if (e.kind !== 'site') return;
    const set = sigExempt.get(e.at) || new Set();
    (e.sites || []).forEach((x) => { if (x && x.sig) set.add(normSig(x.sig)); });
    sigExempt.set(e.at, set);
  });
  return {
    fileExempt: fileExempt,
    sigExempt: sigExempt,
    /** 这个写调用点是否**在册**（`target` = 第一实参原文） */
    isExempt: (rel, target) => fileExempt.has(rel)
      || (sigExempt.has(rel) && sigExempt.get(rel).has(normSig(target)))
  };
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
  // 豁免的**两种粒度**（`B8` ①：豁免登记在门禁侧，被检查方在自己文件里写一行不算）
  const exempt = makeExemptMatcher(ledger);
  const ledgerFiles = exempt.fileExempt;
  const sigExempt = exempt.sigExempt;
  const isExempt = exempt.isExempt;

  const files = woScanTargets(base);
  const matchers = woAssetNameMatchers();
  const all = [];
  const selfAtomic = [];
  const unmanaged = [];
  const unresolved = [];
  /** 每个文件的**全部裸写调用点**（`through === false`）—— 逐调用点豁免的"处数"核对要用 */
  const byFile = new Map();
  /** 判定 ④ 的对象：文件"提得到"受管资产名、又有**判不了**的裸写 ⇒ 它可能在写受管资产 */
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
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(s);
      if (s.resolved == null) {
        unresolved.push(s);                                       // 判不了：可见计数，判定 ④ 兜底
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

  // ---- 判定 ①：受管资产上的裸写（在册豁免除外 —— 整文件在册 / 逐调用点在册两种粒度都算）----
  all.forEach((s) => {
    if (isExempt(s.rel, s.target)) return;
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

  // ---- 判定 ③：出口本体的原子写**不许降级**（治 I3：把唯一实现换成更弱的裸写）----
  //   为什么是这一条而不是"再加一条受管资产裸写判红"：I3 的注入点在**调用点**、目标在 `<userData>`
  //   ⇒ 它既不是受管资产、也求值不出来；能机械判定的只有**出口本体本身**的原子形状。
  const outletSrc = (() => {
    try { return fs.readFileSync(path.join(base, WO_OUTLET_FILE), 'utf8'); } catch (e) { return null; }
  })();
  const atomic = outletSrc == null
    ? { ok: false, defs: 0, line: null, param: null, write: false, fsync: false, rename: false,
      direct: [], missing: ['def'], unreadable: true }
    : outletAtomicVerdict(outletSrc);
  if (!atomic.ok) {
    problems.push({
      kind: 'outlet-atomic',
      msg: '出口本体 `' + WO_OUTLET_FILE + (atomic.line ? ':' + atomic.line : '') + '` 的 `' + WO_OUTLET_FN
        + '` **被降级成非原子写了**：' + describeAtomicVerdict(atomic)
        + ' —— 原子写（同目录 tmp → fsync → rename）是"断电/进程中断不留半截文件"的唯一防线，'
        + '把它换成更弱的写法就是**把守卫删掉而不报红**（实测：`e0f992c` 的 I3 注入正是这样绿着通过的）'
    });
  }

  // ---- 判定 ④：覆盖面（**逐调用点**封闭）——
  //   一处裸写**判不了目标**、而它所在的文件**提得到**受管资产名 ⇒ 它可能在写受管资产 ⇒ 这一处必须在册
  //   （人工核实过"它其实写的是 %TEMP% / `<userData>` / argv"才算过关）。这一条兜的正是
  //   "目标路径来自变量"那个天然盲区：`docs-registry-check.js` T2 之前就是这种形状
  //   （写在 `writeRegistryTable(root)` 里，调用行上根本没有 `docs/`）。
  //   ⚠️ 本批把粒度从**文件**改成**调用点**：文件级那一版遇到整文件豁免就**先短路**，
  //   而 `main.js` 正是整文件在册的那一个 ⇒ 判定 ④ 对 main.js 从来没机会看一眼（实测 I1 因此 exit 0）。
  Array.from(suspects.keys()).sort().forEach((rel) => {
    if (ledgerFiles.has(rel)) return;                    // 整文件在册：这一档仍是文件粒度（明写在案）
    suspects.get(rel).forEach((s) => {
      if (isExempt(rel, s.target)) return;               // 这一处逐调用点登记过
      problems.push({
        kind: 'write-outlet',
        msg: '`' + rel + ':' + s.line + '` 的裸写**目标判不了**（第一实参 `' + normSig(s.target) + '`），'
          + '而该文件**提得到受管资产名** ⇒ 它可能在写受管资产 —— 要么改成走出口，'
          + '要么把**这一处**连同"人工核实结论"登记进 `WRITE_OUTLET_DEBT`'
          + '（`kind: "site"` + `sites: [{ sig: "' + normSig(s.target) + '", n: 1, what: "…" }]`）'
      });
    });
  });

  // ---- 欠账册的机械判定 ----
  //   · 册上的文件必须存在（改名/删 ⇒ 红）
  //   · `file`：当前既没写受管资产、也没判不了的裸写 ⇒ 修好忘销账 ⇒ 红
  //   · `site`：逐签名的**处数**必须**双向相等** —— 少了 = 修好忘销账；多了 = **新增的裸写**（本批要抓的）
  //   · `self-atomic`：签名没了 ⇒ 修好忘销账 ⇒ 红
  //   · kind / verdict 枚举 · 每条 why+close · 条目数 ≤ cap · 豁免面 ≤ siteCap
  const managedFiles = new Set(all.map((s) => s.rel));
  const countSig = (rel, sig) => (byFile.get(rel) || []).filter((s) => normSig(s.target) === sig).length;
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
    if (e.kind === 'site') {
      if (!Array.isArray(e.sites) || !e.sites.length) {
        problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 是逐调用点豁免（`kind: "site"`），'
          + '却没有任何 `sites: [{ sig, n, what }]` —— 没有签名就等于整文件豁免，那要写成 `kind: "file"` 并说明理由' });
      } else {
        e.sites.forEach((x) => {
          if (!x || !x.sig || !normSig(x.sig)) {
            problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 有一处 `sites[]` 没写 `sig`' });
            return;
          }
          if (!x.what) {
            problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 的 `sig: "' + x.sig
              + '"` 没写 `what`（每一处都要说清"这处目标到底是什么、为什么落在仓库外"）' });
          }
          const want = x.n === undefined ? 1 : x.n;
          if (!Number.isInteger(want) || want < 1) {
            problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 的 `sig: "' + x.sig
              + '"` 的 `n` 必须是 ≥1 的整数（它是"这一签名记几处"的口径）' });
            return;
          }
          const got = countSig(e.at, normSig(x.sig));
          if (got < want) {
            problems.push({ kind: 'ledger', msg: '欠账册在 `' + e.at + '` 的 `sig: "' + x.sig + '"` 上记了 '
              + want + ' 处，实际只有 ' + got + ' 处 —— 改走出口了 / 删了？那就**销账**（cap 只减不增：同批调小）' });
          } else if (got > want) {
            problems.push({ kind: 'ledger', msg: '欠账册在 `' + e.at + '` 的 `sig: "' + x.sig + '"` 上只记了 '
              + want + ' 处，实际有 ' + got + ' 处 ⇒ **多出来的那处是新增的裸写**：改成走出口，'
              + '要么重新裁决并把 `n` 加一（逐调用点豁免的意义就在这里：新增一处不该被旧签名带过去）' });
          }
        });
      }
    }
    if (e.kind === 'self-atomic' && !selfAtomic.includes(e.at)) {
      problems.push({ kind: 'ledger', msg: '欠账册写着 `' + e.at + '` 有自造 tmp+rename，但它**已经没有了**'
        + ' —— 修好了就销账（同批把 cap 也调小）' });
    }
    if (e.kind !== 'file' && e.kind !== 'site' && e.kind !== 'self-atomic') {
      problems.push({ kind: 'ledger', msg: '欠账册条目 `' + e.at + '` 的 `kind` 只能是 `file` / `site` / '
        + '`self-atomic`（整文件豁免 / 逐调用点豁免 / 自造 tmp+rename）' });
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

  const exemptSites = all.filter((s) => isExempt(s.rel, s.target)).length
    + unresolved.filter((s) => isExempt(s.rel, s.target)).length;
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
    siteCap: WRITE_OUTLET_SITE_CAP,
    debt: ledger.filter((e) => e.verdict === 'debt').length,
    keep: ledger.filter((e) => e.verdict === 'keep').length,
    exemptedSites: all.filter((s) => isExempt(s.rel, s.target)).length,   // 兼容旧读数口径：受管命中里的在册数
    exemptSites: exemptSites,                                             // 分子：被豁免覆盖的**全部**调用点
    fileExemptFiles: ledgerFiles.size,
    siteExemptFiles: sigExempt.size,
    siteExemptSignatures: [...sigExempt.values()].reduce((n, s) => n + s.size, 0),
    atomicOk: atomic.ok,
    tokens: new Set(matchers.map((m) => m.label)).size
  };
  if (readings.writeSites !== readings.managedSites + readings.unmanagedSites + readings.unresolvedSites) {
    problems.push({ kind: 'closure', msg: '写调用点分档不平：总数 ' + readings.writeSites + ' ≠ 受管 '
      + readings.managedSites + ' + 非受管 ' + readings.unmanagedSites + ' + 判不了 ' + readings.unresolvedSites });
  }
  if (exemptSites > WRITE_OUTLET_SITE_CAP) {
    problems.push({ kind: 'ledger', msg: '豁免**面**涨了：被在册豁免覆盖的写调用点 ' + exemptSites
      + ' 处 > 上限 ' + WRITE_OUTLET_SITE_CAP + '（`WRITE_OUTLET_SITE_CAP` 只减不增 —— '
      + '把整文件豁免拆成逐调用点豁免**不会**缩小面，只卡条数就等于允许"拆细换额度"）' });
  }

  const notes = [
    '写盘出口：扫描面 ' + readings.files + ' 个第一方文件 / ' + readings.writeSites + ' 个写调用点'
      + ' —— 受管资产 ' + readings.managedSites + '（其中 ' + readings.exemptedSites + ' 处在册豁免）· '
      + '非受管 ' + readings.unmanagedSites + ' · **判不了 ' + readings.unresolvedSites + '**（目标来自参数/运行时，'
      + '本判据算不出来 —— 逐条列在 `--list` 里，不假装查过；判定 ④ 按**调用点**兜底，'
      + '提得到受管资产名又有判不了裸写的文件有 ' + readings.suspectFiles + ' 个）',
    '豁免面（分子）：**' + readings.exemptSites + ' 处**写调用点被在册豁免覆盖 / 上限 ' + readings.siteCap
      + ' —— 整文件豁免 ' + readings.fileExemptFiles + ' 个文件 · 逐调用点豁免 ' + readings.siteExemptFiles
      + ' 个文件（' + readings.siteExemptSignatures + ' 条签名）',
    '自造 tmp+rename：' + readings.selfAtomic + ' 个文件（'
      + (selfAtomic.join(' / ') || '无') + '）—— 出口本体 `' + WO_OUTLET_FILE + '` 除外',
    '出口本体原子性（判定 ③）：' + (atomic.ok ? '三条腿都在 ✓' : '**被降级 ✗**') + ' —— '
      + describeAtomicVerdict(atomic),
    '欠账册：' + readings.ledger + ' 条 / 上限 ' + readings.cap + '（欠账 ' + readings.debt
      + ' · 有据降级 ' + readings.keep + '）；受管资产名 tokens ' + readings.tokens + ' 个（从 §5 登记表现取）'
  ];
  return {
    problems, notes, sites: all, selfAtomic: selfAtomic, unmanaged: unmanaged,
    unresolved: unresolved, suspects: suspects, ledger: ledger, cap: WRITE_OUTLET_CAP,
    siteCap: WRITE_OUTLET_SITE_CAP, atomic: atomic, byFile: byFile,
    exemptSites: exemptSites, readings: readings
  };
}

/* ===============================================================
 * ⑥ 笔记正文残留（NOTE_RESIDUE）—— `detail` 里不许留 Markdown 定界符
 * ---------------------------------------------------------------
 * 它守的那条规则（**契约早就有、检查一直没建**）：
 *   `docs/DATA-FORMAT.md` §2.4 / §2.4.1：`detail` 的语义是 **HTML 片段**，正文的**唯一**渲染点是
 *   `renderer/app-detail-content.js` 的 `dc.innerHTML = detail`，**不做任何转换**（不解析、不重排、
 *   不转义）⇒ 写进 detail 的 `**粗体**` / 反引号会**原样显示**成字面量。
 *   实测（`ada00407`）：同一批手写原生 HTML 时把 `**粗体**` 与反引号写了进去（ch01 / ch07 / ch08 /
 *   ch05 / ch10 共数十处），而 `--dry-run` 与 `validate-all` **全绿** —— 数据闸门只校结构、不校呈现。
 *   上一批（`.review/20261019-PDF正文核对/check-html.mjs`）只补了「标签开闭」那一半，
 *   **Markdown 残留仍然没有任何机器门禁**。本判据补的就是这另一半。
 *
 * 为什么落在 S2 而不是新开一步（第 15 步）：
 *   同族缺陷。⑤ 管的是"受管资产的字节只允许从**一个函数**落盘"；本判据管的是
 *   "**绕过唯一转换出口**（`--detail-md` / `import-md` → `markdownToHtml`）手写字节之后，
 *   数据里留下的指纹"。两者都是"唯一出口被绕过"，只是 ⑤ 看**谁写**、⑥ 看**写出来的是什么**。
 *   骨架也是现成的、不用造第二份：封闭欠账册（`why` / `close`）+ **两道 cap**（条数 + 面）
 *   + 悬挂登记判红 + 已偿未销账判红 + 声明↔实现双向闭包（`CHECKS`）+ `--note-root` 证明口。
 *
 * 判据（**窄**：只抓「成对定界符」与「已被吃成强调标签」这两种形态，**不抓单个 `*`**）：
 *   判红档 `fail`  ：① 成对 `**粗体**` ② 成对反引号 ③ 围栏 ``` ④ `[文字](链接)` ⑤ **行首** `# 标题`
 *                   ⑥ `tag-in-code` —— **`<em>` / `<strong>` 跑进 `<code>` / `<pre>` 的内容区**
 *                      （=「源头标记已经被转换器吃掉」的那一半，判据本体见下面 `scanEmphasisInCode`）
 *   只报告档 `report`（不判红，但**必须连理由打印**）：`__下划线__`（与 `__init__` 同形）·
 *                    单星斜体 `*斜体*`（与 `2*a*b` 同形）· `#` 前有块标签（行首判据看不到，误判率高）·
 *                    代码区里的 `<b>` / `<i>` / `<u>` / `<mark>` / `<span>`（转换器不产这些，推不出来源）
 *   跳过档 `skip`（逐项计数并打印）：`<pre>…</pre>` / `<code>…</code>` 里的**标记**（**代码本来就该写在这里**，
 *                    ——只对 ①–⑤ 成立；⑥ 恰恰只看代码区**内部**）/
 *                    `<!-- … -->` 注释 / 正文里不在代码区的 `<em>`、`<strong>`（正常强调）/
 *                    无 detail 的节点 / 读不出的项目文件（并发写在读的那一刻）
 *
 * ⚠️ **为什么不许"含 `*` 就判红"**：`int *p;` / `a*b` / `2*a*b` / 正则 / shell 通配都含 `*`，那样会
 *   **假红一片**，而假红会让读者连真红也不看。实测边界（下面三条都有单测守着）：
 *     · `int *p;` 只有**一个** `*`（不成对）⇒ 本判据**看不见它** ⇒ 必绿；
 *     · `2*a*b` 成对，但 `*a*` 与乘号**无法机械分辨** ⇒ 只报告，不判红；
 *     · 成对 `` `…` `` / `**…**` 没有这种歧义 ⇒ 判红。
 *
 * 合法例外的出路（两条，都不必放宽判据）：
 *   ① **内容侧**：代码/通配放进 `<code>` / `<pre>` —— 那本来就是工程约定的写法，本判据先把它挖掉；
 *   ② **门禁侧**：登记进 `NOTE_RESIDUE_DEBT`（`B8`：**不由被检查方决定** —— 在被检查的数据文件里
 *      写一行"这是示例"**不算**豁免），每条带 `why` / `close`，且有**两道 cap**（条数 + 面，只减不增）。
 * =============================================================== */

/** 数据扫描根（默认 `projects/`；`--note-root=` 只给**判别力证明**指向夹具用） */
const NOTE_RESIDUE_ROOT = 'projects';

/** 「跳过档」的三类区块：代码与注释里的 `*` / 反引号是**内容**，不是残留。等长掩掉（保留换行 ⇒ 行号不漂） */
const NOTE_RESIDUE_MASKERS = [
  { id: 'pre', re: /<pre\b[^>]*>[\s\S]*?<\/pre>/gi },
  { id: 'code', re: /<code\b[^>]*>[\s\S]*?<\/code>/gi },
  { id: 'comment', re: /<!--[\s\S]*?-->/g }
];

/* ---------------------------------------------------------------
 * 第 6 条规则的判据本体：**「标记已经被转换器吃掉」的痕迹**（`tag-in-code`）
 * ---------------------------------------------------------------
 * 缺口（第 2 次实证，两次都有现场）：
 *   上面 ①–⑤ 抓的是**源头的标记**（`**` / 反引号 / 围栏 / `[]()` / 行首 `#`）；
 *   它们**抓不到"标记已经被 Markdown 转换器吃掉之后的产物"** —— 那个产物形状**完全合法**。
 *     · 批 `b3a53636`：`2R*8` 经 `markdownToHtml` 变成 `2R<em>8</em>`（人工发现，改成 `2R×8`）；
 *     · 批 `02d26501` 在 `book-linux-net::n-mv9d1vbzgjni` 实测到
 *       `<code>linux-netfilter-tc-<em></code>` 与 `<code>qos-</em></code>`：两个**通配 `*`**
 *       被配对成 `<em>…</em>`，把 `<code>` 劈成两半。该批原话：「该坏字任何门禁都抓不到」。
 *   成因在 `src/convert.js` 的 `inline()`：`*` → `<em>` 的替换**在 `<code>` 已经成形之后**才跑，
 *   它按"整行"配对、不认识 code 边界 ⇒ 同一行里的两个 `*` 会**跨 code 区**配对。
 *
 * 判据（**窄**：只认"强调标签跑进代码区"，绝不"见 `<em>` 就红"）：
 *   对原文做**一次线性标签扫描**，用 depth 记 `<code>` / `<pre>` 的开闭；凡 `<em>` / `<strong>` 的
 *   **开标签或闭标签**落在代码区里 ⇒ 命中。四种形状一网打尽，而且**不需要给标签配对**：
 *   判的是**位置**，不是配对 —— 这正是"别把 A 段的开标签和 B 段的闭标签配成一对"那条边界的解法
 *   （实测两段不串：`<code>a <em>b</em></code> … <code>c</code>` 只报 A 段那 2 处）。
 *     · 全长在里：`<code><em>x</em></code>`（开闭都在里 ⇒ 2 处）
 *     · 开在里、闭在外：`<code>linux-netfilter-tc-<em></code>`（= `02d26501` 现场的一半）
 *     · 开在外、闭在里：`<code>qos-</em></code>`（= 同一现场的另一半）
 *     · 只开没闭 / 只闭没开：`<code>fixtures/<strong></code>`（全库现存就有一处这种）
 *
 * ⚠️ 为什么**嵌套也判红**（`<code><strong>x</strong></code>`）—— 两条都是实证，不是口味：
 *   ① **它同样是转换器产物**：`<code>siginfo_t*, void*</code>` 里两个 `*` 会在**同一个** code 区内
 *      配对成 `<em>…</em>`（现存 `comnet::10-4-api-mumupmmdwqc8` 实测就是这一形状，共 2 处）
 *      ⇒ 若把它放成"只报告"，这一类坏字就**永久免疫**；
 *   ② **`<code>` 里没有强调的正当用途**：要强调一段代码，标签放在**外面**——
 *      `<em><code>x</code></em>` 不在本判据的命中面里（实测必绿），出口是敞着的。
 *
 * 不判的（跳过档，逐项计数打印）：
 *   · `<em>` / `<strong>` **不在**代码区里 —— 正文强调本来就合法（全库实测 13,700 处）；
 *   · `&lt;em&gt;` 这种**转义后的字面量** —— 它不是标签，扫描器看不见（`<` 已被转义）；
 *   · `<!-- … -->` 注释里的 —— 先等长抹掉（保留换行 ⇒ 行列号不漂）。
 *
 * 只报告档（不判红）：代码区里的 `<b>` / `<i>` / `<u>` / `<mark>` / `<span>` ——
 *   转换器只产 `<em>` / `<strong>`（`src/convert.js` 的行内映射只有这两条），这些**推不出来源**，
 *   更像人工高亮 ⇒ 判红会误伤。
 * --------------------------------------------------------------- */

/** `<code>` / `<pre>` 的内容区 = "字面代码"，强调标签不该出现在里面 */
const NOTE_CODE_TAGS = new Set(['code', 'pre']);
/** 转换器**会产**的两个强调标签（`src/convert.js` 的 `inline()`：`**x**`→`<strong>` / `*x*`→`<em>`） */
const NOTE_EMPHASIS_TAGS = new Set(['em', 'strong']);
/** 转换器**不产**的行内标签：出现在代码区里推不出来源 ⇒ 只报告 */
const NOTE_OTHER_INLINE_TAGS = new Set(['b', 'i', 'u', 'mark', 'span']);

/** 抹掉注释（等长替换、保留换行 ⇒ 行号列号不漂）。`tag-in-code` 与 maskers 用同一口径。 */
function noteBlankComments(text) {
  return String(text == null ? '' : text).replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));
}

/**
 * 数一遍「强调标签跑进代码区」（**纯函数**：同一输入两次结果一致；喂字符串即可单测）。
 * 属性段认引号 ⇒ `<span title="a>b">` 不会被那个 `>` 截断（`&lt;` / `&gt;` 本来就不是 `<`，天然不受干扰）。
 * @returns {{emphasis:Array<{tag:string,idx:number}>, other:Array<{tag:string,idx:number}>,
 *            codeOpens:number, outside:number}}
 *   `emphasis` / `other` 按**标签**计（开、闭各一条 —— 判红时挨个点名"哪一个边界跑进了代码区"）；
 *   `outside` 按**开标签**计（= 正文里强调**元素**的个数，跳过档读数用这个口径更好读）。
 */
function scanEmphasisInCode(text) {
  const src = noteBlankComments(text);
  const out = { emphasis: [], other: [], codeOpens: 0, outside: 0 };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClose = /\/\s*$/.test(m[3]);
    if (NOTE_CODE_TAGS.has(name)) {
      // 逐段配对：只看**位置**（depth > 0 = 在某个代码区里），不给跨段标签配对
      if (closing) { if (depth > 0) depth--; } else if (!selfClose) { depth++; out.codeOpens++; }
      continue;
    }
    const isEmph = NOTE_EMPHASIS_TAGS.has(name);
    if (!isEmph && !NOTE_OTHER_INLINE_TAGS.has(name)) continue;
    if (depth > 0) {
      const rec = { tag: (closing ? '</' : '<') + name + '>', idx: m.index };
      (isEmph ? out.emphasis : out.other).push(rec);
    } else if (isEmph && !closing) {
      out.outside++;          // 正文里的正常强调：跳过档，**按开标签计**（= 强调元素的个数）
    }
  }
  return out;
}

/** 判据表（**唯一一份**；tier 只有 fail / report 两档，第三档"跳过"由 maskers + 无 detail 承担） */
const NOTE_RESIDUE_RULES = [
  { id: 'fence', tier: 'fail', label: '围栏代码块 `' + '```' + '`',
    why: 'detail 是 HTML：围栏在这里只是三个字面反引号（代码请写 <pre><code>）',
    re: /```/g },
  { id: 'bold-pair', tier: 'fail', label: '成对 `**粗体**`',
    why: '`**` 会原样显示（HTML 的粗体是 <strong> / <b>）',
    re: /\*\*(?=\S)[^\n]{1,200}?(?<=\S)\*\*/g },
  { id: 'code-span', tier: 'fail', label: '成对反引号 `代码`',
    why: '反引号会原样显示（行内代码请写 <code>）',
    // 首尾都要求"不是 ``` 的一段"：围栏已由上面的 `fence` 判，别再重复报一遍同样的三个字符
    re: /(?<!`)`(?!`)(?=\S)[^\n]{1,200}?(?<=\S)`(?!`)/g },
  { id: 'link', tier: 'fail', label: 'Markdown 链接 `[文字](链接)`',
    why: '会原样显示成方括号（链接请写 <a href>）',
    re: /\[[^\]\n]{1,80}\]\([^()\s\n]{1,200}\)/g, needLetter: true },
  { id: 'heading-raw', tier: 'fail', label: '行首 `# 标题`',
    why: '`#` 会原样显示（标题请写 <h1>…<h6>）', scan: 'heading-raw' },
  { id: 'tag-in-code', tier: 'fail', label: '代码区里的强调标签 `<em>` / `<strong>`',
    why: '`<code>` / `<pre>` 的内容是**字面代码**：写一个 `*` 被转换器吃成 `<em>` 之后，形状完全合法、'
      + '渲染却把代码劈成两半（`<code>qos-</em></code>`）—— 正常写作绝不会在代码里套强调；'
      + '要强调一段代码请把标签放在外面（`<em><code>x</code></em>` 不判红）',
    scan: 'emphasis-in-code', bucket: 'emphasis' },
  { id: 'underline-pair', tier: 'report', label: '成对 `__下划线__`',
    why: '与 Python 的 `__init__` 同形 ⇒ 只报告不判红（逃逸：放进 <code>）',
    re: /(?<![A-Za-z0-9_])__(?=\S)[^\n]{1,200}?(?<=\S)__(?![A-Za-z0-9_])/g },
  { id: 'italic-pair', tier: 'report', label: '单星斜体 `*斜体*`',
    why: '与 `2*a*b` 同形 ⇒ 只报告不判红（逃逸：放进 <code>）',
    // 只排除"与 `**` 相邻"这种情形：前后再排除 `\w` 就会把 `2*a*b` 这类**真正该报告的**也漏掉
    re: /(?<!\*)\*(?=[^\s*])[^*\n]{1,200}?(?<=\S)\*(?!\*)/g },
  { id: 'heading-in-tag', tier: 'report', label: '`# 标题` 紧跟块标签',
    why: '行首判据看不到它（`#` 前面是标签），误判率高 ⇒ 只报告不判红',
    re: /<(?:p|li|h[1-6]|div|td|th)\b[^>]*>[ \t]*#{1,6}[ \t]+\S/g },
  { id: 'other-inline-in-code', tier: 'report', label: '代码区里的其它行内标签 `<b>` / `<i>` / `<span>`…',
    why: '转换器只产 `<em>` / `<strong>`（`src/convert.js` 的行内映射），这些推不出来源、更像人工高亮'
      + '⇒ 判红会误伤（逃逸：要去掉标签，要么把强调放到 `<code>` 外面）',
    scan: 'emphasis-in-code', bucket: 'other' }
];

/** 掩掉"代码 / 注释"区块（等长替换，保留换行）。返回{ masked, counts } */
function noteResidueMask(text) {
  let out = String(text == null ? '' : text);
  const counts = { pre: 0, code: 0, comment: 0 };
  NOTE_RESIDUE_MASKERS.forEach((m) => {
    m.re.lastIndex = 0;
    out = out.replace(m.re, (s) => { counts[m.id]++; return s.replace(/[^\n]/g, ' '); });
  });
  return { masked: out, counts };
}

/**
 * 扫一条 detail（**纯函数**：同一输入两次结果一致；喂字符串即可单测）。
 * @returns {{hits: Array<{rule:string,tier:string,line:number,col:number,snippet:string}>, masked: object}}
 */
function scanDetailResidue(text) {
  const src = String(text == null ? '' : text);
  const m = noteResidueMask(src);
  const masked = m.masked;
  const hits = [];
  const push = (rule, idx, len) => {
    const before = masked.slice(0, idx);
    const nl = before.lastIndexOf('\n');
    hits.push({
      rule: rule.id, tier: rule.tier,
      line: before.split('\n').length, col: idx - nl,
      snippet: src.slice(Math.max(0, idx - 20), Math.min(src.length, idx + len + 20)).replace(/\s+/g, ' ')
    });
  };
  // ⑥ `tag-in-code` / `other-inline-in-code` 看的是**原文**（不是 masked）：
  // 其余五条要**跳过**代码区（代码里的 `*` 是内容），它俩恰恰**只看代码区内部** ——
  // 一个是"源头的标记"，一个是"标记被转换器吃掉之后的痕迹"，方向相反故不能共用同一份文本。
  const inCode = scanEmphasisInCode(src);
  NOTE_RESIDUE_RULES.forEach((rule) => {
    if (rule.scan === 'heading-raw') {
      // 行首 `#` 标题：前面**不许有标签**（`<p># x` 归只报告档，见 heading-in-tag）
      let off = 0;
      masked.split('\n').forEach((line) => {
        const h = /^[ \t]*#{1,6}[ \t]+\S/.exec(line);
        if (h) push(rule, off + line.length - line.replace(/^[ \t]*/, '').length, h[0].trim().length);
        off += line.length + 1;
      });
      return;
    }
    if (rule.scan === 'emphasis-in-code') {
      (inCode[rule.bucket] || []).forEach((x) => push(rule, x.idx, x.tag.length));
      return;
    }
    if (!rule.re) return;
    rule.re.lastIndex = 0;
    let mm;
    while ((mm = rule.re.exec(masked)) !== null) {
      if (mm[0].length === 0) { rule.re.lastIndex++; continue; }
      if (rule.needLetter && !/\p{L}/u.test(mm[0])) continue;   // `[0](x)` 这类不是链接
      push(rule, mm.index, mm[0].length);
    }
  });
  return { hits: hits, masked: Object.assign({}, m.counts,
    { codeOpens: inCode.codeOpens, emphasisOutside: inCode.outside }) };
}

/** 项目数据文件清单：`<root>/<名>/<名>.json`（与 CLI 的口径一致；点号开头的目录跳过） */
function noteResidueProjects(root) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  const out = [];
  ents.forEach((d) => {
    if (!d.isDirectory() || d.name.startsWith('.')) return;
    const f = path.join(root, d.name, d.name + '.json');
    if (fs.existsSync(f)) out.push({ project: d.name, file: f });
  });
  return out.sort((a, b) => (a.project < b.project ? -1 : 1));
}

/** 册上键：项目 + 节点 id（一条节点 = 一个例外单元） */
function noteResidueKey(project, node) { return String(project) + '::' + String(node); }

/* ---------------------------------------------------------------
 * 欠账册（**封闭**：条数只减不增；每条必写 why / close）
 *   每条：{ project, node, rules: { <规则id>: 处数 }, why, close }
 *   —— 为什么按「节点 × 规则」记处数：同一节点里残留可能混着几条规则（实测 `卖点讨论/bl-3`
 *   是 `bold-pair` 与 `code-span` 混排），只记"这个节点有残留"就会让**新增的另一种残留**
 *   用旧条目吞掉。处数**只减不增**：少了 ⇒ 请销账（判红逼人改册）；多了 ⇒ 是新增残留（判红）。
 * --------------------------------------------------------------- */
const NOTE_RESIDUE_CAP = 7;
/** 「豁免**面**」的上界（分子：被在册条目覆盖的**判红命中数**）。
 *  与 `WRITE_OUTLET_SITE_CAP` 同形：把 1 条节点条目拆成 N 条规则条目，条目数涨而**面一点没小**
 *  ⇒ 只卡条数就等于允许"拆细换额度"。面**只减不增**。 */
const NOTE_RESIDUE_HIT_CAP = 29;
/* 存量 14 条 / 42 处，由**两批**构成（两个数都是**时点读数**，现值跑 `--list`）：
 *   · 4 条 / 26 处（2026-10-19 上线读数，①–⑤ 那五条规则抓到的）；
 *   · **10 条 / 16 处（2026-10-20，第 6 条规则 `tag-in-code` 上线那一刻的存量）** ——
 *     ⚠️ 这是本工程唯一一次**抬 cap**（条数 4→14、面 26→42），性质是**新规则上线时的一次性存量入册**，
 *     不是放宽判据：三档判据一个字没松（同批实测：两个真实现场 `必红`、`<code>struct Qdisc *q</code>`
 *     与正文 `<em>强调</em>` 两个无害对照 `必绿`，全库 16 处全是**真缺陷**、逐处有片段为证）。
 *     不抬 cap 就只剩两条路 —— 放宽判据（不许）或改 `projects/**` 真数据（不许）——
 *     所以只有"如实入册 + 写清为什么"这一条。**本批之后两本 cap 恢复只减不增**。
 * **本批不许改 `projects/**`** ⇒ 如实登记成欠账，不为了让门禁变绿而放宽判据。
 * 三类根因**不同**，修法也不同（见各条 `why` / `close`）：
 *   · 3 条 `comnet` 是**转换器缺陷**（Markdown 表格里的 `\|` 被当成单元格分隔 ⇒ 孤立反引号）；
 *   · 1 条 `卖点讨论/bl-3` 是**手写 Markdown 进了 detail**（= `ada00407` 那一类）；
 *   · 10 条（第 6 条规则）= **转换器把 `*` 吃成 `<em>` 的痕迹**（`src/convert.js` 的 `inline()`
 *     按整行配对 `*`、不认识 code 边界）—— 其中 9 条是"跨 code 区配对"，1 条是"同一 code 区内配对"
 *     （`comnet::10-4-api-mumupmmdwqc8` 的 `siginfo_t*, void*`，这也是"嵌套形状也必须判红"的实证）。
 * ⚠️ 这里**不写死"现在还剩几处"**：`projects/` 会被并发会话改写（`docs/DATA-FORMAT.md` §2.4 的
 *   ⚠️ 那段就是为此写的）⇒ 要看现在的数就跑 `node scripts/collateral-check.js --list`，
 *   写成散文的数一定会漂。 */
const NOTE_RESIDUE_DEBT = [
  {
    project: 'comnet',
    node: '12-mumupmmew2f0',
    rules: { 'code-span': 1 },
    why: '表格单元格里的行内代码 `` `dmesg \\| tail` `` 在 Markdown→HTML 时被**单元格分隔**切断'
      + '（转义管道 `\\|` 没被当成字面量），留下两个孤立反引号与一个字面 `\\`（实测片段见 `--list`）。'
      + '**这不是"手写 Markdown 残留"，是表格解析的转换缺陷** —— 所以修法**不是**再跑一次 '
      + '`--detail-md`（会原样复现）。',
    close: '先定修哪一侧：① 修转换器（`src/convert.js` 的表格单元格切分要认 `\\|` 转义，'
      + '同批补一条 `tests/convert.test.js` 用例，再重跑 `import`/`--detail-md` 覆盖这三条节点）；'
      + '② 或者直接手修这三个节点的 detail（把两侧的孤立反引号与 `\\` 去掉/补成 `<code>`）。'
      + '两条都做完就删本条并同批把 `NOTE_RESIDUE_HIT_CAP` 减掉对应处数。'
  },
  {
    project: 'comnet',
    node: '3-4-ebtables-mark-mv6idkjcv0r3',
    rules: { 'code-span': 1 },
    why: '同 `comnet::12-mumupmmew2f0` 的根因：`` `mark \\| = V` `` 这类"行内代码里带管道"的单元格'
      + '被切成两格，反引号变成字面量。',
    close: '与 `comnet::12-mumupmmew2f0` 同批处理（修转换器后重跑，或手修 detail）。'
  },
  {
    project: 'comnet',
    node: '1-6-21-02-22-03-23-05-mv6idoy0lb9a',
    rules: { 'code-span': 3 },
    why: '同一张对照表里有 3 个单元格是同一形状（`` `dumpe2fs … \\| grep …` `` / `` `opkg list \\| grep ntfs` `` / '
      + '`` `testparm -s \\| grep "min protocol"` ``）⇒ 根因同上，是这个**转换缺陷**在一个节点里的三处显现。',
    close: '与前两条同批处理。⚠️ 修转换器时**要一起复核**这张表：3 处都命中说明这是系统性的切分问题，'
      + '不是偶发手滑。'
  },
  {
    project: '卖点讨论',
    node: 'bl-3',
    rules: { 'bold-pair': 17, 'code-span': 4 },
    why: '整条 detail 是**手写 Markdown**（`- ` 列表 + `**粗体**` + 反引号 + `---` 分隔线），'
      + '渲染层 `innerHTML` 会把它原样显示成 `**W1 / W3 / W4 / W6**` 这种坏字 —— '
      + '这就是 `ada00407` 那一类缺陷（数据闸门只校结构、不校呈现）。',
    close: '用唯一转换出口重写一遍：`node cli/mm-cli.js edit 卖点讨论 bl-3 --detail-md "<这条正文的 Markdown>"`'
      + '（先把现在的 detail 取出、按 Markdown 重排，再走 `--detail-md`）⇒ 复跑本门禁应见这条从册上消失，'
      + '同批删掉本条并把 `NOTE_RESIDUE_HIT_CAP` 减 21。'
  },
  /* ---- 下面 10 条 = 第 6 条规则（`tag-in-code`）上线那一刻的全库存量（2026-10-20，共 16 处）。
   *  **全是同一个根因**：`src/convert.js` 的 `inline()` 先产出 `<code>…</code>`、**之后**才跑
   *  `*x*` → `<em>` 的整行配对 ⇒ 同一行里两个 `*` 会跨 code 边界配对（或同一 code 区内配对），
   *  原文里的 `*` 是**通配/指针**，被吃掉之后代码就断了。
   *  共同的 `close`：① 修转换器（在 `inline()` 里先把 `<code>…</code>` / `<pre>…</pre>` 段占位保护起来
   *  再跑强调替换，同批补 `tests/convert.test.js` 用例），修完这些节点**重跑一次** `--detail-md`
   *  即可复原成字面 `*`；② 或者逐条手修：`node cli/mm-cli.js edit <项目> <节点> --detail "<修好的 HTML>"`
   *  （`--detail` 不转换、原样存 ⇒ 不会再被吃掉）。**改完一处就把该条的处数减掉，整条清零就删整条。** */
  {
    project: 'comnet',
    node: 'b-mv6idoy2ufk4',
    rules: { 'tag-in-code': 1 },
    why: '`<em>` 开在正文、`</em>` 闭在 `<code>kmod-*</code>` 里 ⇒ 实测 `*<em>内核态驱动（<code>kmod-</em></code>）`，'
      + '强调标签**跨出**了 code 边界（本判据要处理的那条边界，它就是现场之一）。',
    close: '按册头 ①/② 修；注意这一条正文里还有成对的 `**`（另归 `bold-pair`，本册未覆盖该节点的其他规则）。'
  },
  {
    project: '卖点讨论',
    node: 'bl-3-3-9',
    rules: { 'tag-in-code': 1 },
    why: '`<em>` 开在正文（`*导入指标` 那一处）、`</em>` 闭在 `<code>import-*</code>` 里 ⇒ '
      + '实测 `*<em><code>import-</em></code> 的 <code>--report</code>`。',
    close: '按册头 ①/② 修；⚠️ 同一节点正文里还有大量手写 `**` 残留（不在本册的规则范围内），'
      + '整条重写时一并处理，别只修这一处。'
  },
  {
    project: '卖点讨论',
    node: 'bl-38-1',
    rules: { 'tag-in-code': 1 },
    why: '`<code>fixtures/*</code>` 的星号与同一行后面某个 `*` 配对 ⇒ 实测 `<code>fixtures/<strong></code>`：'
      + '`<strong>` 只有开、没有闭。',
    close: '按册头 ①/② 修（删掉 `<strong>`、补回 `*`）。'
  },
];

/** 判据的能力边界（**逐档打印**，不许把"没判"说成"过了"） */
const NOTE_RESIDUE_TIERS = {
  fail: '判红',
  report: '只报告（不判红，理由随命中一起打印）',
  skip: '跳过（①–⑤ 的**标记**在 `<pre>`/`<code>`/注释里是内容，不是残留 —— '
    + '第 6 条 `tag-in-code` 恰恰只判代码区**内部**：它抓的不是 `*`，是 `*` 已经被吃成 `<em>` 之后的痕迹）'
};

/**
 * ⑥ 的判定（读磁盘 → 问题清单）。`root` 是**数据扫描根**（默认 `projects/`；
 * 给夹具目录就是判别力证明，真仓一个字节不动 —— 与 ⑤ 的 `--root=` 同一形状）。
 * @returns {{problems:Array, notes:Array, reports:Array, readings:object, hits:Map}}
 */
function analyzeNoteResidue(root, ledger) {
  const problems = [];
  const notes = [];
  const reports = [];
  // `ledger === null` ⇒ **册不参与**（扫描根被指到别处时的显式选择，见 analyze 的注释）
  const book = Array.isArray(ledger) ? ledger : (ledger === null ? [] : NOTE_RESIDUE_DEBT);
  const ledgerInScope = Array.isArray(ledger) || ledger !== null;
  const readings = {
    root: root, projects: 0, nodes: 0, withDetail: 0,
    failHits: 0, reportHits: 0, maskedHits: 0, ledgerInScope: ledgerInScope,
    masked: { pre: 0, code: 0, comment: 0, codeOpens: 0, emphasisOutside: 0 },
    inCodeFail: 0, inCodeReport: 0,
    unverified: 0, unverifiedFiles: [],
    bookEntries: book.length, exemptHits: 0
  };
  const found = new Map();      // key => { project, node, topic, byRule, fails }
  const list = noteResidueProjects(root);
  if (!list) {
    problems.push({ kind: 'note-residue',
      msg: '取不到笔记数据的扫描根 `' + root + '` —— **采不到真值 = 红**（`A5`），本判据不能自称已校验' });
    return { problems, notes, reports, readings, found };
  }

  list.forEach((p) => {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p.file, 'utf8')); }
    catch (e) {
      // 未验证档（`A5` 第三条路）：别的人/批正在写这个文件时读不出来 ≠ 我们没做到。
      // **响亮打印 + 不参与计数 + 不阻断**，绝不把"没判"说成"过了"。
      readings.unverified++;
      readings.unverifiedFiles.push(p.project + '（' + String((e && e.message) || e).slice(0, 60) + '）');
      return;
    }
    readings.projects++;
    (function walk(children) {
      (children || []).forEach((n) => {
        readings.nodes++;
        const d = typeof n.detail === 'string' ? n.detail : '';
        if (d.trim()) {
          readings.withDetail++;
          const r = scanDetailResidue(d);
          readings.masked.pre += r.masked.pre;
          readings.masked.code += r.masked.code;
          readings.masked.comment += r.masked.comment;
          // 第 6 条规则的"面"读数：扫了多少代码区 / 正文里有多少处合法强调（跳过档）
          // `|| 0`：负对照变体会把 `scanDetailResidue` 整体钝化成一个不含新字段的空壳，
          // 那时读数要显示 0 而不是 NaN（读数也是契约）。
          readings.masked.codeOpens += (r.masked.codeOpens || 0);
          readings.masked.emphasisOutside += (r.masked.emphasisOutside || 0);
          r.hits.forEach((h) => {
            if (h.tier === 'fail') readings.failHits++; else readings.reportHits++;
            if (h.rule === 'tag-in-code') readings.inCodeFail++;
            if (h.rule === 'other-inline-in-code') readings.inCodeReport++;
            const k = noteResidueKey(p.project, n.id);
            if (!found.has(k)) {
              found.set(k, { project: p.project, node: n.id, topic: n.topic,
                items: Array.isArray(n.items), byRule: {}, fails: [] });
            }
            const ent = found.get(k);
            if (h.tier === 'fail') {
              ent.byRule[h.rule] = (ent.byRule[h.rule] || 0) + 1;
              ent.fails.push(h);
            } else {
              reports.push({ project: p.project, node: n.id, topic: n.topic, ...h });
            }
          });
        }
        walk(n.children);
      });
    })((raw.data && raw.data.children) || []);
  });

  /* ---- 判定：判红档逐条点名；只报告档只进 reports ---- */
  const onBook = new Map();
  book.forEach((e) => onBook.set(noteResidueKey(e.project, e.node), e));

  found.forEach((ent, k) => {
    if (!ent.fails.length) return;                   // 只有只报告档命中 ⇒ 不判
    const e = onBook.get(k);
    const where = '`' + ent.project + '` 节点 **' + ent.node + '**'
      + (ent.topic ? '「' + String(ent.topic).slice(0, 24) + '」' : '');
    if (!e) {
      ent.fails.slice(0, 6).forEach((h) => {
        const rule = NOTE_RESIDUE_RULES.find((x) => x.id === h.rule) || { label: h.rule, why: '' };
        problems.push({ kind: 'note-residue',
          msg: where + ' 的 detail 有 Markdown 残留：' + rule.label + '（规则 `' + h.rule + '`，第 ' + h.line
            + ' 行第 ' + h.col + ' 列）—— 片段：`' + h.snippet + '`。' + rule.why
            + '。修法：`node cli/mm-cli.js edit <项目> ' + ent.node + ' --detail-md "<Markdown>"`（走唯一转换出口），'
            + '或把代码/通配放进 <code>；确实不该改的登记进本文件的 `NOTE_RESIDUE_DEBT`（带 why / close）' });
      });
      if (ent.fails.length > 6) {
        problems.push({ kind: 'note-residue',
          msg: where + ' 还有 ' + (ent.fails.length - 6) + ' 处同类残留（本行只印前 6 处，全量跑 `--list`）' });
      }
      return;
    }
    // 在册：逐规则核对处数（**只减不增**）
    Object.keys(e.rules || {}).forEach((ruleId) => {
      const want = e.rules[ruleId];
      const got = ent.byRule[ruleId] || 0;
      if (got === want) { readings.exemptHits += got; return; }
      if (got === 0) {
        problems.push({ kind: 'ledger',
          msg: '欠账册条目的 `' + ruleId + '` 已偿：' + where + ' 实测 0 处，但册上记着 ' + want
            + ' 处 ⇒ **请销账**（把该规则从 `NOTE_RESIDUE_DEBT` 的那一条 `rules` 里删掉；整条清零就删整条）' });
        return;
      }
      if (got < want) {
        problems.push({ kind: 'ledger',
          msg: '欠账册处数偏大：' + where + ' 的 `' + ruleId + '` 册上 ' + want + ' 处、实测 ' + got
            + ' 处 ⇒ **请把册上改成 ' + got + '**（处数只减不增，改了就是销账）' });
        readings.exemptHits += got;
        return;
      }
      problems.push({ kind: 'note-residue',
        msg: where + ' 的 `' + ruleId + '` 残留**比在册的多**（册上 ' + want + ' 处、实测 ' + got
          + ' 处）⇒ 这是**新增残留**，不许用旧条目吞 —— 先把新增的修掉（`--detail-md`），'
          + '确实要留就同批把册上处数改大并写清为什么' });
      readings.exemptHits += got;
    });
    Object.keys(ent.byRule).forEach((ruleId) => {
      if (e.rules && Object.prototype.hasOwnProperty.call(e.rules, ruleId)) return;
      const rule = NOTE_RESIDUE_RULES.find((x) => x.id === ruleId) || { label: ruleId };
      problems.push({ kind: 'note-residue',
        msg: where + ' 出现了**册上没有的**残留规则 ' + rule.label + '（' + ent.byRule[ruleId]
          + ' 处）—— 册只覆盖已登记的规则，新增规则一律判红' });
    });
  });

  /* ---- 册自身的四条机械判定：悬挂登记 / 条数 cap / 面 cap / 形状 ---- */
  book.forEach((e) => {
    const k = noteResidueKey(e.project, e.node);
    if (found.has(k)) return;
    const unreadable = readings.unverifiedFiles.some((f) => f.indexOf(e.project + '（') === 0);
    if (unreadable) {
      notes.push('欠账册条目 `' + e.project + '::' + e.node + '` 这次**未验证**（项目文件读不出，见"未验证"一栏）');
      return;
    }
    problems.push({ kind: 'ledger',
      msg: '欠账册**悬挂登记**：`' + e.project + '::' + e.node + '` 在数据里已找不到（改删名 / 删节点）'
        + ' ⇒ 请销账（删掉这一条）' });
  });
  if (book.length > NOTE_RESIDUE_CAP) {
    problems.push({ kind: 'ledger',
      msg: '笔记正文残留欠账册有 ' + book.length + ' 条，超过上限 `NOTE_RESIDUE_CAP` = ' + NOTE_RESIDUE_CAP
        + '（只减不增 —— 要新增必须先还掉一条，或同批抬 cap 并写清为什么）' });
  }
  if (readings.exemptHits > NOTE_RESIDUE_HIT_CAP) {
    problems.push({ kind: 'ledger',
      msg: '豁免面 ' + readings.exemptHits + ' 处判红命中 > 上限 `NOTE_RESIDUE_HIT_CAP` = '
        + NOTE_RESIDUE_HIT_CAP + '（拆细条目换不来额度：面只减不增）' });
  }
  book.forEach((e) => {
    if (!e.project || !e.node || !e.rules || !Object.keys(e.rules).length) {
      problems.push({ kind: 'ledger', msg: '欠账册有条目缺 project / node / rules —— ' + JSON.stringify(e).slice(0, 80) });
    }
    if (!e.why || !e.close) {
      problems.push({ kind: 'ledger', msg: '欠账册 `' + e.project + '::' + e.node + '` 缺 why 或 close（欠账必须写清为什么 + 怎么还）' });
    }
  });

  /* ---- 读数与三档边界（放行理由要印出来，`B8`） ---- */
  readings.bookEntries = book.length;
  notes.push('笔记正文残留（⑥）：扫描根 `' + path.basename(root) + '/` —— '
    + readings.projects + ' 个项目 / ' + readings.nodes + ' 个节点（有 detail ' + readings.withDetail + '）· '
    + '判红档 ' + readings.failHits + ' 命中 · 只报告档 ' + readings.reportHits + ' 命中 · '
    + (ledgerInScope
      ? '在册欠账 ' + book.length + ' 条覆盖 ' + readings.exemptHits + ' 处命中 / 面上限 ' + NOTE_RESIDUE_HIT_CAP
      : '**欠账册不参与**（扫描根不是真仓 `projects/` —— 那本册声明的是真仓的存量）'));
  notes.push('  ↳ 跳过档：<pre> ' + readings.masked.pre + ' 段 / <code> ' + readings.masked.code
    + ' 段 / 注释 ' + readings.masked.comment + ' 段（①–⑤ 的**标记**在代码与注释里是内容，不判）· '
    + '正文里不在代码区的 `<em>` / `<strong>` ' + readings.masked.emphasisOutside + ' 处'
    + '（按开标签计 = 强调元素个数；正常强调，永不判红 —— 这是第 6 条规则的**主边界**）· '
    + '未验证 ' + readings.unverified + ' 个'
    + (readings.unverified ? '（' + readings.unverifiedFiles.join(' / ') + ' —— 读不出就不算过，也不判红）' : ''));
  notes.push('  ↳ 第 6 条 `tag-in-code` 的扫描面：逐段扫了 ' + readings.masked.codeOpens
    + ' 个 `<code>` / `<pre>` 内容区 —— 其中命中强调标签 ' + readings.inCodeFail + ' 处（判红）· '
    + '命中其它行内标签 ' + readings.inCodeReport + ' 处（只报告）· '
    + '（代码区里的 `*` 是字面量，**不**由本条判；本条判的是"`*` 已经被吃成 `<em>`"的痕迹）');
  notes.push('  ↳ 只报告档的放行理由：' + NOTE_RESIDUE_RULES.filter((r) => r.tier === 'report')
    .map((r) => r.id + '（' + r.why + '）').join('；'));
  if (reports.length) {
    notes.push('  ↳ 只报告档命中明细（**不判红**，共 ' + reports.length + ' 处，先看前 10）：');
    reports.slice(0, 10).forEach((x) => {
      notes.push('      [只报告] ' + x.project + '/' + x.node + ' 第 ' + x.line + ' 行 ' + x.rule
        + ' —— `' + String(x.snippet).slice(0, 60) + '`');
    });
  }
  return { problems, notes, reports, readings, found };
}

function main() {
  const list = process.argv.includes('--list');
  // `--root=<dir>`：**只影响判定 ⑤ 的扫描根**（判别力证明把判据指向 %TEMP% 副本用；
  // 不加这个开关时输出与从前逐字节相同 —— H3：新能力走 opt-in 开关，不给默认路径加成本）。
  const rootArg = (process.argv.slice(2).find((a) => a.startsWith('--root=')) || '').slice(7);
  // `--note-root=<dir>`：**只影响判定 ⑥ 的扫描根**（把同一份判据指向夹具 / `%TEMP%` 副本用 ⇒ 真仓一个字节不动；
  // 不加这个开关时输出与从前逐字节相同 —— H3：新能力走 opt-in 开关，不给默认路径加成本）。
  const noteRootArg = (process.argv.slice(2).find((a) => a.startsWith('--note-root=')) || '').slice(12);
  const opts = {};
  if (rootArg) opts.writeOutletRoot = path.resolve(rootArg);
  if (noteRootArg) opts.noteResidueRoot = path.resolve(noteRootArg);
  const r = analyze(opts);

  if (list) {
    console.log('== 改动类型 → 连带处（**唯一权威 = 本文件 COLLATERAL**）==');
    COLLATERAL.forEach((row) => {
      console.log('');
      console.log('▸ ' + row.when + '   [' + row.id + ']');
      row.places.forEach((p) => {
        // ⚠️ 这条分支以前按 `p.gate` 挑，于是 `role: 'self'`（本门禁直接断言）的连带处
        // 被印成"残差（未机械化）"—— 输出把"有人守"说成"没人守"，本批一并修（`D1`：输出也是契约）。
        const who = p.role === 'self' ? '本门禁直接断言（' + p.check + '）'
          : p.role === 'body' ? '本体（发生这类改动的地方）'
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
    console.log('== ⑤ 判定 ③：出口本体 ' + WO_OUTLET_FILE + ' 的 `' + WO_OUTLET_FN + '` 三条腿 ==');
    const a = r.writeOutlet.atomic;
    console.log('  ' + (a.ok ? '✓ 三条腿都在' : '✗ 被降级') + '（定义 ' + a.defs + ' 份'
      + (a.line ? '，第 ' + a.line + ' 行起' : '') + (a.param ? '，目标形参 `' + a.param + '`' : '') + '）');
    ['write', 'fsync', 'rename'].forEach((k) => {
      console.log('    ' + (a[k] ? '✓' : '✗') + ' ' + WO_ATOMIC_LEG_TEXT[k]);
    });
    if (a.direct.length) console.log('    ✗ 直接把内容写到 `' + a.direct[0] + '`（没有 tmp）');
    console.log('');
    console.log('== ⑤ 写盘出口：受管资产上的裸写（逐条）==');
    if (!r.writeOutlet.sites.length) console.log('  （无：所有落在受管资产上的写调用点都走了出口或在册豁免）');
    const listFileExempt = new Set(r.writeOutlet.ledger.filter((e) => e.kind === 'file').map((e) => e.at));
    const listSigExempt = new Map();
    r.writeOutlet.ledger.filter((e) => e.kind === 'site').forEach((e) => {
      (e.sites || []).forEach((x) => {
        if (!listSigExempt.has(e.at)) listSigExempt.set(e.at, new Set());
        listSigExempt.get(e.at).add(x.sig);
      });
    });
    const listExempt = (rel, target) => listFileExempt.has(rel)
      || (listSigExempt.has(rel) && listSigExempt.get(rel).has(normSig(target)));
    r.writeOutlet.sites.forEach((s) => {
      console.log('  ' + (listExempt(s.rel, s.target) ? '[在册豁免] ' : '') + s.rel + ':' + s.line
        + '  [' + s.call + '] → ' + s.targetRel + '   ' + s.family.label);
    });
    console.log('');
    console.log('== ⑤ 写盘出口：判不了的目标（目标来自参数/运行时 —— 如实计数，不假装查过）==');
    if (!r.writeOutlet.unresolved.length) console.log('  （无）');
    const byFile = new Map();
    r.writeOutlet.unresolved.forEach((s) => {
      if (!byFile.has(s.rel)) byFile.set(s.rel, []);
      byFile.get(s.rel).push(s);
    });
    // 逐条打出**签名**（第一实参原文）：一是让"判不了"可审计，二是**逐调用点豁免要照着它写 sig**
    // （以前只打行号，而册上的行号已经漂过一次 ⇒ 照着行号登记必红）。
    Array.from(byFile.keys()).sort().forEach((f) => {
      const arr = byFile.get(f);
      console.log('  ' + f + '  ×' + arr.length
        + (listFileExempt.has(f) ? '  [整文件在册豁免]' : ''));
      arr.slice(0, 14).forEach((s) => {
        console.log('      ' + (listExempt(f, s.target) ? '[在册] ' : '       ') + '行 ' + s.line
          + '  [' + s.call + ']  sig=' + (normSig(s.target) || '(取不到)'));
      });
      if (arr.length > 14) console.log('      … 还有 ' + (arr.length - 14) + ' 处（只印前 14 处）');
    });
    console.log('');
    console.log('== ⑤ 欠账册（封闭：cap 只减不增；每条 why / close）==');
    r.writeOutlet.ledger.forEach((e) => {
      console.log('  · ' + e.at + '  [' + e.kind + ' · ' + e.verdict + ']');
      if (e.kind === 'site') {
        (e.sites || []).forEach((x) => {
          console.log('      site：sig=' + x.sig + '  ×' + (x.n === undefined ? 1 : x.n)
            + ' —— ' + (x.what || '（缺 what）'));
        });
      }
      console.log('      why  ：' + e.why);
      console.log('      close：' + e.close);
    });
    console.log('  合计 ' + r.writeOutlet.ledger.length + ' 条 / 上限 ' + r.writeOutlet.cap
      + '；豁免面（被覆盖的写调用点）' + r.writeOutlet.exemptSites + ' 处 / 上限 ' + r.writeOutlet.siteCap);
    console.log('');
    console.log('== ⑥ 笔记正文残留（NOTE_RESIDUE）判据表与三档边界 ==');
    NOTE_RESIDUE_RULES.forEach((x) => {
      console.log('  [' + NOTE_RESIDUE_TIERS[x.tier] + '] ' + x.id + ' —— ' + x.label + '（' + x.why + '）');
    });
    console.log('  [' + NOTE_RESIDUE_TIERS.skip + ']');
    console.log('');
    console.log('== ⑥ 欠账册（封闭：条数 ' + r.noteResidue.readings.bookEntries + ' / 上限 ' + NOTE_RESIDUE_CAP
      + '；面 ' + r.noteResidue.readings.exemptHits + ' / 上限 ' + NOTE_RESIDUE_HIT_CAP + '）==');
    if (!r.noteResidue.readings.bookEntries) console.log('  （空册：全库零残留，或残留都写成了只报告档）');
    NOTE_RESIDUE_DEBT.forEach((e) => {
      console.log('  · ' + e.project + '::' + e.node + '  规则处数 ' + JSON.stringify(e.rules));
      console.log('      why  ：' + e.why);
      console.log('      close：' + e.close);
    });
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
  WRITE_OUTLET_CAP, WRITE_OUTLET_SITE_CAP, WRITE_OUTLET_DEBT, WO_OUTLET_FILE, WO_WRITE_NAMES, findWriteCalls,
  woManagedFamily, evalPathExpr, normSig,
  splitTopLevel, wholeCall, collectBindings, collectBindingList, collectFunctionBlocks, bindingsAt,
  collectZeroArgReturns,
  blankQuoted, firstArgAt, scanWriteSites, scanViews, woScanTargets, woAssetNameMatchers,
  buildScopeIndex,
  hasSelfAtomicSignature, analyzeWriteOutlet,
  // 判定 ③：出口本体的原子写不许降级（判据本体是纯函数，可单独喂源码）
  WO_OUTLET_FN, WO_ATOMIC_LEG_TEXT, outletAtomicVerdict, describeAtomicVerdict,
  // ⑥ 笔记正文残留（`detail` 里不许留 Markdown 定界符，判定与三档都在这里，别在别处再写一份）
  NOTE_RESIDUE_ROOT, NOTE_RESIDUE_RULES, NOTE_RESIDUE_TIERS, NOTE_RESIDUE_CAP, NOTE_RESIDUE_HIT_CAP,
  NOTE_RESIDUE_DEBT, NOTE_RESIDUE_MASKERS, noteResidueMask, scanDetailResidue, noteResidueProjects,
  noteResidueKey, analyzeNoteResidue,
  // 第 6 条规则（`tag-in-code`）：判据本体 + 它认的两组标签表（单测直接喂字符串）
  scanEmphasisInCode, noteBlankComments, NOTE_CODE_TAGS, NOTE_EMPHASIS_TAGS, NOTE_OTHER_INLINE_TAGS,
  makeExemptMatcher
};

if (require.main === module) main();
