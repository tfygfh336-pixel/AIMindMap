#!/usr/bin/env node
/* ============================================================
 * scripts/doc-facts.js — 文档事实基线（防漂移守护）
 * ------------------------------------------------------------
 * 存在的唯一理由：本工程的「易腐事实」（命令数 / MCP 工具数 / 单测用例数 /
 * 集成断言数 / 冒烟断言数）曾经在 README、AI-GUIDE、ARCHITECTURE、DEEP-REVIEW
 * 四个文件共 6 处各写一份，且 README 自己内部就自相矛盾（38/44/21 与 52/46/43
 * 并存）。只要同一事实有多个副本，漂移就必然发生——与作者是否勤奋无关。
 *
 * 本脚本把这类事实收敛为「机器可算 + 机器可校验」：
 *   node scripts/doc-facts.js          打印权威事实（人/文档引用）
 *   node scripts/doc-facts.js --check  扫描全部 .md，与真值比对；不一致则 exit 1
 *   node scripts/doc-facts.js --write  生成 docs/VERIFY.md（验证基线单源）
 *
 * --check 已接入 `npm run verify` 末端：任何未来的文档数字漂移会在 verify 阶段
 * 直接变红，而不是靠人自觉维护。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// 验证链的**唯一定义**在 scripts/verify.js（顺序/命令/耗时预算）；本文件只渲染它，不另抄一份。
const verifyChain = require(path.join(__dirname, 'verify.js'));
// 受管生成物的写盘出口：**原子写 + 并发版本闸门**（比较与报错**只有** `src/data-store.js` 的 `versionGate` 一处）。
// 为什么必须走它：本文件是 `docs/VERIFY.md` 的**整文件重写**者，而一次 `--write` 要跑一遍 vitest（数十秒）——
// 那正是别人可能改这份生成物的窗口。原先"读全文 → 改 → 写全文"中间**没有指纹比对**，
// 后写者会整份覆盖先写者的改动，**没有任何东西能检出**（这正是 2026-10 那次 `docs/ARCHITECTURE.md`
// 三行被两批各改一次冲掉的机器侧根因）。⇒ 只调 `data-store` 那一对函数，本文件**不写第二份比较逻辑**。
const { readManagedText, writeManagedText } = require(path.join(__dirname, '..', 'src', 'data-store.js'));

/* ---------------- 事实采集 ---------------- */
function facts() {
  const registry = require(path.join(ROOT, 'cli', 'registry.js'));
  const mcp = require(path.join(ROOT, 'scripts', 'mcp-server.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

  // 单测用例数：跑一次 vitest 并**从其摘要行解析**（"Tests  65 passed (65)"）。
  // 不用 --reporter=json + --outputFile：那条路径依赖临时文件落盘后再读，
  // 实测偶发读到旧值/空值（竞态），会让 VERIFY.md 出现 null。
  // 用例文件数直接数磁盘，不用 vitest 的 numTotalTestSuites ——
  // 那个值把 describe 块也计入（实测 7 文件会报 17）。
  const testsDir = path.join(ROOT, 'tests');
  const unitFiles = fs.existsSync(testsDir)
    ? fs.readdirSync(testsDir).filter((f) => /\.test\.js$/.test(f)).length
    : null;

  let unitTests = null;
  let unitTestsError = null;
  let unitTestsSource = '本进程现跑 vitest';
  // ---- 优先采用验证链第 4 步（npm test）传来的用例数：整条链只跑一次 vitest ----
  // 为什么可以信它：`scripts/verify.js` 会**先删掉上一次的结果文件**再跑 `npm test`，
  // 跑完立刻读回并通过环境变量交给本步 —— 所以这个值只可能是**本次**链产生的，
  // 不存在"读到上次结果"的陈旧风险。
  // 本文件单独运行时（`npm run facts:write` / `node scripts/doc-facts.js --check`
  // / 测试）没有该变量，照旧自己跑 vitest，行为与从前完全一致。
  // 另加一道防呆：数量不得少于测试文件数 —— 明显不合理的值一律不采信，宁可真跑一遍。
  const fromChainRaw = process.env.AI_MINDMAP_UNIT_TESTS;
  const fromChain = /^\d+$/.test(String(fromChainRaw === undefined ? '' : fromChainRaw).trim())
    ? Number(String(fromChainRaw).trim()) : null;
  if (fromChain !== null && (unitFiles === null || fromChain >= unitFiles)) {
    unitTests = fromChain;
    unitTestsSource = '验证链本次 npm test（verify.js 传入，已省去重跑 vitest）';
  } else {
    const runVitest = () => execFileSync(process.execPath, [
      path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--pool=threads'
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024 }); // 显式抬高：默认 1 MB 一旦超限就 ENOBUFS → 真值缺失 → 误红
    const tryOnce = () => {
      try {
        return parseVitestCount(runVitest());
      } catch (e) {
        // vitest 有失败用例时退出码非 0，但摘要仍在输出里 —— 仍尝试解析
        return parseVitestCount((e && e.stdout) || '');
      }
    };
    unitTests = tryOnce();
    if (unitTests === null) {
      // **自动重试一次**：本工程已记录一类已知假失败 —— 验证期间有并发写入时，
      // vitest 会以 `3221225477`（0xC0000005 原生崩溃）收场且**不产出摘要**
      // （见 `docs/VERIFY.md`「本机受限环境注意」）。文档给的处置就是"让它单独重跑一次"，
      // 那就让机器自己重跑，而不是让人对着一句"取不到真值"去猜。
      console.log('ℹ️ vitest 首次未产出可解析摘要（已知假失败：并发写入会导致原生崩溃）—— 自动重试一次…');
      unitTests = tryOnce();
      if (unitTests === null) {
        unitTestsError = 'vitest 两次都未能运行或输出不可解析 —— 可能是并发写入导致的假失败'
          + '（见 docs/VERIFY.md「本机受限环境注意」）：确认没有别的会话在写文件后重跑一次';
      }
    }
  }

  // 用例数解析见文件顶部的 `parseVitestCount` —— **它取总数，不取 passed**（有失败用例时两者不同）

  // 断言数：CLI 集成是**脚本**（require 会直接执行断言），只能数源码；
  // 冒烟断言是**纯数据模块**（入口只 require + 拼接），故直接 require 取 `.length` ——
  // 精确真值，不受缩进/注释/换行影响（原先用正则 `^\s{4}name: '` 数，
  // 而 `\s` 可跨行匹配，属"近似"；门禁的数字必须是精确的）。
  const cliSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'cli-integration.js'), 'utf8');
  let smokeAssertions = null;
  try {
    smokeAssertions = require(path.join(ROOT, 'scripts', 'smoke-assertions.js')).length;
  } catch (e) {
    // 载入失败说明冒烟断言文件本身坏了 —— 这必须响亮地失败，而不是回退到正则给个"看起来正常"的数字
    throw new Error('无法加载 scripts/smoke-assertions.js 以统计冒烟断言数：' + ((e && e.message) || e));
  }

  // 视觉断言（L2 关键区域）：与冒烟同款口径 —— `scripts/vision/roi-assertions.js` 导出
  // `ROIS` 数组，而 `run()` 的返回条数**恒等于 `ROIS.length`** ⇒ 取它就是**运行时真值**，
  // 不是源码正则的近似。**为什么单独计数**：它要能单独被判"少了没"。
  // 若并进冒烟断言数（115），删掉一条 ROI 只会让总数从 117 变 116，**看不出少了什么**。
  let visionAssertions = null;
  try {
    visionAssertions = require(path.join(ROOT, 'scripts', 'vision', 'roi-assertions.js')).ROIS.length;
  } catch (e) {
    // 与冒烟同一条纪律：载入失败说明断言模块本身坏了 ⇒ 响亮失败，不回退成"看起来正常"的数字
    throw new Error('无法加载 scripts/vision/roi-assertions.js 以统计视觉断言数：' + ((e && e.message) || e));
  }

  return {
    commands: registry.list().length,
    mcpTools: mcp.TOOLS.length,
    cliAssertions: (cliSrc.match(/^\s*check\(/gm) || []).length,
    smokeAssertions: smokeAssertions,
    visionAssertions: visionAssertions,
    unitTests: unitTests,
    unitTestsError: unitTestsError,
    unitFiles: unitFiles,
    unitTestsSource: unitTestsSource,
    version: pkg.version,
    configVersion: (cfgSrc.match(/APP_VERSION:\s*'([^']*)'/) || [])[1] || null,
    lockVersion: lock.version,
    lockRootVersion: lock.packages && lock.packages[''] ? lock.packages[''].version : null
  };
}

/* ---------------- 文档扫描：找出所有形如「N 条命令 / N 个工具 / N 用例 / N 断言」的数字 ----------------
 * 关键点：必须排除两类**误报**来源
 *   1) markdown 标题里的章节号（"### 1.2 CLI 命令" 会被读成 "2 CLI 命令"）→ 整行跳过标题；
 *   2) 小数/版本号的一部分（"0.14 命令"）→ 用负向后顾 (?<![\d.]) 保证数字是独立整数。
 */
const NB = '(?<![\\d.])';
const RE_CMD = new RegExp(NB + '(\\d+)\\s*(?:条|个)?\\s*(?:CLI\\s*)?命令', 'g');
const RE_TOOL = new RegExp(NB + '(\\d+)\\s*(?:个|条)?\\s*(?:MCP\\s*)?工具', 'g');
const RE_UNIT = new RegExp(NB + '(\\d+)\\s*个?\\s*用例', 'g');
// 「N 条断言」：**数字与「断言」之间允许夹一个类别词**（视觉 / 冒烟 / 集成 / CLI）。
// 为什么必须允许：中文的自然写法正是「**2 条视觉断言**」（类别词夹在中间），
// 而原先的正则要求数字**紧邻**「断言」⇒ **扫不到这类句子**。
// 这是被判别力证明抓出来的：注入一行「共 99 条视觉断言」时门禁**没有变红**。
const RE_ASSERT = new RegExp(NB + '(\\d+)\\s*(?:条)?\\s*(视觉|冒烟|集成|CLI\\s*)?\\s*断言', 'g');

/* ---------------- 第三类扫描：体量/行数类「易腐数字」 ----------------
 * 为什么需要：`RULES.md` §4 早有一条约定「体量/行数类数字不手写」，但**没有门禁守它** ——
 * 实测已过期 5 处（"CHANGELOG 已 230+ KB" ×4、主文件"280 KB" ×1），清完还会复发。
 * 判据（可机械化）：受管文档里出现 `N KB/MB` 或 `N 行`（三位数以上）即**要求可追溯**：
 * 同一行必须带**锚**（版本号 `vX.Y.Z`、或 `快照` / `原记` / `当时` / `曾` 这类明确的历史标记），
 * 否则判红 —— 因为读者会把它当现状。
 * 与 G6 既有数字共用同一条"标题行跳过"规则（标题里的章节号不是声明）。 */
const RE_SIZE_MB = new RegExp(NB + '(\\d+)\\s*[+＋~～]?\\s*(KB|MB)\\b');
const RE_SIZE_LINES = new RegExp(NB + '(\\d{3,})\\s*行');
const SIZE_ANCHOR = /(v\d+\.\d+\.\d+|快照|原记|当时|曾)/;

/** 在一行文本里找"体量/行数类数字"（纯函数；导出给单测） */
function findSizeClaim(line) {
  const m = RE_SIZE_MB.exec(line) || RE_SIZE_LINES.exec(line);
  if (!m) return null;
  if (SIZE_ANCHOR.test(line)) return null;              // 带锚 → 可追溯，放行
  return { got: m[1], unit: RE_SIZE_MB.exec(line) ? 'size' : 'lines' };
}

/* ---------------- 第四类扫描：比发布版本更高的 `vX.Y.Z` ----------------
 * 为什么需要：**零上下文的接手演练实测** —— README 写「三条操作语义（v0.16.6 起）」、
 * ARCHITECTURE 的 ADR 写「服务驻留与单窗口假设（v0.16.2）」，而 `package.json` 是 0.16.1。
 * 演练者原话："我无法判断这是笔误还是另一套命名空间" —— 交接面上最不该有的歧义。
 * 约定（`docs/RULES.md` §4）：**`vX.Y.Z` 只表示发布版本**；内部迭代/批次写成「v0.16 系列」/「迭代 N」。
 * 放行条件：同行含 计划/拟/将/目标/预计/未来（那是在说未来版本，合理）。
 * `CHANGELOG.md` 与归档族不在扫描范围（历史里出现旧编号是正常的）。 */
const PLAN_ANCHOR = /(计划|拟|将|目标|预计|未来|尚未)/;

/** 一行里是否出现了"高于当前发布版本"的 `vX.Y.Z`（纯函数；导出给单测） */
function findFutureVersion(line, cur) {
  const m = /v(\d+)\.(\d+)\.(\d+)/.exec(line);
  if (!m) return null;
  if (PLAN_ANCHOR.test(line)) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [x, y, z] = String(cur).split('.').map(Number);
  const higher = a > x || (a === x && b > y) || (a === x && b === y && c > z);
  return higher ? { got: 'v' + m[1] + '.' + m[2] + '.' + m[3], cur: 'v' + cur } : null;
}

/** 收集仓库内所有 .md（跳过依赖、构建产物、数据与临时目录） */
function markdownFiles() {
  const out = [];
  // `.review/` 是工作产物区（AI 的分析/汇报稿、读图记录）：里面的数字是"当时随手写的"，
  // 不承担"权威事实副本"的责任 —— 纳入扫描只会把 G6 变成噪音源（假红）。
  // `changelog/` 是 `docs/changelog/`（滚动归档的历史版本段）：历史事实同样退出"当前事实"口径。
  // 与 `docs/archive/`（历史快照）同理：三者都不参与 G6 比对。
  const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-portable', 'build', 'backups', '.tmp-img', '.tmp-svg', 'projects', 'vendor', '.review', 'changelog']);
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  })(ROOT);
  return out.sort();
}

/** 参与「当前事实」校验的文档：CHANGELOG 记历史值、archive / changelog 为历史快照，均排除 */
function trackedFiles() {
  return markdownFiles().filter((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    return rel !== 'CHANGELOG.md'
      && !rel.startsWith('docs/archive/')
      && !rel.startsWith('docs/changelog/');   // 滚动归档的历史版本段
  });
}

/**
 * 从**一行**文本里解析出全部「事实声明」，返回 `[{kind, label, value}]`。
 * **纯函数、无 IO** —— 因此可以被单测直接调用（见 `tests/doc-facts.test.js`）。
 *
 * 为什么专门把它抽出来：这里曾经出过一个**永不生效的门禁** ——
 * 断言正则要求数字**紧邻**「断言」，而中文的自然写法是「**2 条视觉断言**」
 * （类别词夹在数字与「断言」之间）⇒ **匹配不到** ⇒ 把这个数写进任何 markdown 都**不进判定**。
 * 它是被**判别力证明**抓出来的：注入一行"共 N 条视觉断言"（N≠真值）时门禁**没有变红**。
 * 这段逻辑现在是本工程少数**有单测兜着的门禁逻辑**之一。
 */
function parseClaims(line) {
  // 标题行只含章节号（1.2 / 3.1），不可能是事实声明 → 整行跳过，避免把章节号当数字
  if (/^\s*#{1,6}\s/.test(line)) return [];
  const out = [];
  const collect = (re, kind, label) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) out.push({ kind, label, value: Number(m[1]) });
  };
  collect(RE_CMD, 'commands', 'CLI 命令数');
  collect(RE_TOOL, 'mcpTools', 'MCP 工具数');
  collect(RE_UNIT, 'unitTests', '单测用例数');

  // 「N 断言」按行内就近的上下文关键词归属：视觉 / 冒烟 / CLI 集成。
  // 不能无差别匹配，否则冒烟行（"冒烟自检…44 条断言"）会被误标为集成断言。
  //   ① 优先用**数字与「断言」之间**的类别词（新写法：「2 条视觉断言」）；
  //   ② 没有才回退到"**数字之前**最近的类别词"（旧写法：「冒烟自检…44 条断言」「45 冒烟断言」）；
  //   ③ 一个类别词都没有 ⇒ **不判定**（避免误报）。
  RE_ASSERT.lastIndex = 0;
  let m;
  while ((m = RE_ASSERT.exec(line))) {
    const inline = (m[2] || '').trim();
    let kind = null;
    if (inline === '视觉') kind = 'visionAssertions';
    else if (inline === '冒烟') kind = 'smokeAssertions';
    else if (inline === '集成' || inline === 'CLI') kind = 'cliAssertions';
    else {
      const before = line.slice(0, m.index);
      const iVision = before.lastIndexOf('视觉');
      const iSmoke = before.lastIndexOf('冒烟');
      const iCli = Math.max(before.lastIndexOf('集成'), before.lastIndexOf('CLI'));
      const best = Math.max(iVision, iSmoke, iCli);
      if (best < 0) continue;
      kind = best === iVision ? 'visionAssertions'
        : (best === iSmoke ? 'smokeAssertions' : 'cliAssertions');
    }
    const label = kind === 'visionAssertions' ? '视觉断言数'
      : (kind === 'smokeAssertions' ? '冒烟断言数' : 'CLI 集成断言数');
    out.push({ kind, label, value: Number(m[1]) });
  }
  return out;
}

/** 扫描全部受管 markdown，返回与真值不符的条目 */
function scan(values) {
  const hits = [];
  const push = (rel, lineNo, label, got, want, text) => {
    if (want === null || want === undefined) return;
    if (Number(got) === Number(want)) return;
    hits.push({ rel, line: lineNo, label, got: Number(got), want: Number(want), text: text.trim() });
  };

  for (const file of trackedFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const c of parseClaims(line)) push(rel, i + 1, c.label, c.value, values[c.kind], line);
    });
  }
  return hits;
}

/** 扫描"体量/行数类易腐数字"（无版本锚/历史标记即命中） */
function scanSizeClaims() {
  const hits = [];
  for (const file of trackedFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*#{1,6}\s/.test(line)) return;            // 与 parseClaims 同口径：标题行跳过
      const claim = findSizeClaim(line);
      if (claim) {
        hits.push({
          rel, line: i + 1,
          label: claim.unit === 'size' ? '体量数字（KB/MB）' : '行数声明',
          text: line.trim()
        });
      }
    });
  }
  return hits;
}

/** 扫描"比发布版本更高的 vX.Y.Z"（交接面歧义：分不清笔误还是另一套命名空间） */
function scanFutureVersions(currentVersion) {
  const hits = [];
  for (const file of trackedFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*#{1,6}\s/.test(line)) return;
      const hit = findFutureVersion(line, currentVersion);
      if (hit) hits.push({ rel, line: i + 1, label: '未来版本号', text: line.trim(), got: hit.got });
    });
  }
  return hits;
}

/* ---------------- 第五类扫描：第一屏自报的验证链「步骤数」 ----------------
 * 为什么需要（实测缺陷，2026-10-10）：`SKILL.md` 是 `docs-for-ai` 钦定的「**第一屏**」
 * （新会话最先读的那一页），而它上面那句"9 条步骤"是**手写**的 —— 于是同一件事在两个地方
 * 有两种命运：`docs/VERIFY.md` 是**生成物**（跟着 `scripts/verify.js` 的 `STEPS` 自动走 ✓），
 * 第一屏那处**漂了两轮没人察** ✗（10-08 是 9 步、10-09 加 V1 变 10 步、10-10 加 V2 变 11 步）。
 * 它附带的那句"实跑 8 步"更彻底：全仓 grep 不到任何实现 ⇒ 旧措辞连对应代码都没有了。
 * ⇒ **最需要准确的同一页，恰好是唯一没有守卫的一页。** 这里给它一条机械判定：
 *   第一屏里的步骤数声明（形如「步骤数 N 步」）必须等于 `verifyChain.STEPS.length`。
 *
 * 两个设计取舍（都是"防静默失效"，不是风格问题）：
 *   ① 用**固定字样**「步骤数」锚定，而不是无差别扫所有「N 步」—— 第一屏还有「接手 5 步」，
 *      那是"读几份文档"的步数，与验证链步数不是一回事，混扫会造**假红**（而假红的结局是被无视）。
 *   ② **字样缺失也判红**（不是"没写就不检查"）—— 否则把这句话删掉/改写一下就**静默关掉了守卫**
 *      （`testing-for-ai` B8：与声明无关的检查必须无条件跑，守卫自己要落在受检范围内）。
 */
const RE_STEP_CLAIM = /步骤数[^\d\n]{0,8}?(\d+)\s*步/g;

/** 从一段文本里解析「步骤数 N 步」（纯函数，无 IO —— 便于单测）。标题行跳过，与 parseClaims 同口径。 */
function parseStepCountClaims(text) {
  const out = [];
  String(text === undefined || text === null ? '' : text).split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#{1,6}\s/.test(line)) return;
    RE_STEP_CLAIM.lastIndex = 0;
    let m;
    while ((m = RE_STEP_CLAIM.exec(line))) out.push({ line: i + 1, value: Number(m[1]) });
  });
  return out;
}

/** 读第一屏（`SKILL.md`）并解析步骤数声明。
 *  传了 textIn 就用它（便于单测注入）；读不到文件时 `claims: null` = **采不到真值**，
 *  下游必须判红 —— 不能把"没读到"当成"没声明"再放行。 */
function scanStepCount(textIn) {
  const rel = 'SKILL.md';
  const want = verifyChain.STEPS.length;
  if (textIn !== undefined && textIn !== null) return { rel, claims: parseStepCountClaims(textIn), want };
  try {
    return { rel, claims: parseStepCountClaims(fs.readFileSync(path.join(ROOT, rel), 'utf8')), want };
  } catch (e) {
    return { rel, claims: null, want, error: (e && e.message) || String(e) };
  }
}

/** 纯判定：通过 ⇒ null，否则返回**指路**的报文（F4 报错即教程）。
 *  @param {{line:number,value:number}[]|null} claims
 *  @param {number} want 真值 = `scripts/verify.js` 的 `STEPS.length`
 */
function stepCountProblem(claims, want) {
  if (claims === null) {
    return '无法读取第一屏 `SKILL.md`（采不到真值 ⇒ 门禁不能自称已校验）—— 确认文件存在且编码正常';
  }
  if (!claims.length) {
    return '`SKILL.md` 里找不到步骤数声明（形如「步骤数 N 步」）—— 删掉/改写这句话就等于**静默关掉**'
      + '这条判定，故判红。请在「接手 5 步」第 4 步写回：**步骤数 ' + want + ' 步**';
  }
  const bad = claims.filter((c) => c.value !== want);
  if (!bad.length) return null;
  return bad.map((c) => '`SKILL.md` 第 ' + c.line + ' 行写的是「步骤数 ' + c.value + ' 步」，应为 **' + want
    + ' 步**（= `scripts/verify.js` 的 `STEPS.length`）').join('；')
    + ' —— 第一屏是手写的、没有生成器守着它，改 `STEPS` 必须同批改这一句 ✗';
}

/* ---------------- 输出 ---------------- */
function printFacts(v) {
  console.log('AI MindMap 文档事实基线（权威值，直接来自代码/测试）');
  console.log('─────────────────────────────────────────────');
  console.log('  CLI 命令数      :', v.commands);
  console.log('  MCP 工具数      :', v.mcpTools);
  // 用例数**来源**也打印出来：是"本次链传进来的"还是"这里又跑了一遍 vitest"——
  // 这直接决定了这一步要花 5 秒还是 0.1 秒，属于该被看见的事实。
  console.log('  单测用例 / 文件  :', v.unitTests, '/', v.unitFiles,
    v.unitTestsSource ? '（来源：' + v.unitTestsSource + '）' : '');
  console.log('  CLI 集成断言数   :', v.cliAssertions);
  console.log('  冒烟断言数      :', v.smokeAssertions);
  console.log('  视觉断言数（L2） :', v.visionAssertions);
  console.log('─────────────────────────────────────────────');
  console.log('  版本号（须四处一致）:');
  console.log('    package.json      :', v.version);
  console.log('    src/config.js     :', v.configVersion);
  console.log('    package-lock.json :', v.lockVersion, '/ packages[""]:', v.lockRootVersion);
}

function checkVersions(v, fail) {
  const all = [v.version, v.configVersion, v.lockVersion, v.lockRootVersion];
  const uniq = [...new Set(all)];
  if (uniq.length !== 1) {
    console.error('✗ 版本号不一致：package.json=' + v.version + ' config.js=' + v.configVersion
      + ' lock=' + v.lockVersion + ' lock[root]=' + v.lockRootVersion);
    fail();
  } else {
    console.log('✓ 版本号四处一致：' + uniq[0]);
  }
}

/** 生成物是否已过期：用同一渲染函数重算，与磁盘上的文件逐字比对。
 *  覆盖 docs/CLI.md（由 registry 生成）。原来"改了 registry 要记得跑 docs-gen"
 *  只是 README 里的一句话，零强制；现在忘跑就直接红。 */
function checkGeneratedDocs(v, fail) {
  const targets = [
    {
      file: 'docs/CLI.md',
      render: () => require(path.join(ROOT, 'cli', 'commands', 'release.js')).renderCliDoc(),
      fix: 'node cli/mm-cli.js docs-gen'
    },
    {
      // VERIFY.md 也能被逐字校验 —— 前提是它**不含时间等易变内容**：
      // 生成日期已换成版本号、"上次全链结果"只留**指针**（值由 verify / check:docs 现场打印）。
      // 这样"有人手改 VERIFY.md"与"忘记 facts:write"都会变成红（实测：加这条之前手改快照无人抓）。
      file: 'docs/VERIFY.md',
      render: () => renderVerifyDoc(v),
      fix: 'npm run facts:write'
    }
  ];
  targets.forEach((t) => {
    const abs = path.join(ROOT, t.file);
    if (!fs.existsSync(abs)) {
      console.error('✗ 生成物缺失：' + t.file + '（请运行 `' + t.fix + '`）');
      fail();
      return;
    }
    let want;
    try { want = t.render(); } catch (e) {
      console.error('✗ 无法重算 ' + t.file + '：' + (e && e.message));
      fail();
      return;
    }
    const got = fs.readFileSync(abs, 'utf8');
    if (got === want) {
      console.log('✓ 生成物与源一致：' + t.file);
      return;
    }
    // 给出第一处差异的位置，便于直接定位
    const gl = got.split('\n');
    const wl = want.split('\n');
    let at = 0;
    while (at < gl.length && at < wl.length && gl[at] === wl[at]) at++;
    console.error('✗ 生成物已过期：' + t.file + '（第 ' + (at + 1) + ' 行起不一致）');
    console.error('    磁盘: ' + String(gl[at] === undefined ? '(文件结束)' : gl[at]).slice(0, 100));
    console.error('    应为: ' + String(wl[at] === undefined ? '(文件结束)' : wl[at]).slice(0, 100));
    console.error('    → 运行 `' + t.fix + '` 重生成');
    fail();
  });
}

function main() {
  const args = process.argv.slice(2);
  // ---- `--write` 是整文件重写受管生成物 ⇒ **先把"我读到的是哪一版"带走**，再干那件几十秒的活 ----
  // 顺序本身就是判据：句柄必须在 `facts()` **之前**读。反过来说，"写前才读一下、紧接着写"是
  // **假闸门**（恒等放行，比没有更坏：它看起来在守）—— 理由逐字写在 `readVerifyDocHandle` 上。
  const writeHandle = args.includes('--write') ? readVerifyDocHandle() : null;
  const v = facts();

  if (writeHandle) {
    // 用 `exitCode` 而不是 `process.exit()`：退出码一样，但不会在 stdout 还有未落盘的缓冲时把输出截断
    // （本工程在"提前关闭管道"上踩过一次，见 docs/VERIFY.md「本机受限环境注意」）。
    if (!writeVerifyDoc(v, writeHandle)) process.exitCode = 1;
    return;
  }

  if (!args.includes('--check')) { printFacts(v); return; }

  console.log('== doc-facts --check ==');
  printFacts(v);
  console.log('');

  let bad = false;
  const fail = () => { bad = true; };
  checkVersions(v, fail);
  checkGeneratedDocs(v, fail);

  // 真值算不出来时必须**响亮地失败**，不能静默跳过再宣称"一致"。
  // 原先 unitTests 为 null 时，scan() 会跳过该条比对，而末尾仍打印
  // "命令数/工具数/用例数/断言数均与真值一致"并以 0 退出 —— 那是**假的守护**
  // （实测：受限环境下 vitest 子进程 EPERM → unitTests=null，门禁照样绿，
  //  而当时 docs/VERIFY.md 写的用例数已经过期）。
  if (v.unitTestsError) {
    console.error('✗ 无法取得单测用例数真值，门禁不能自称"已校验"：' + v.unitTestsError);
    bad = true;
  }

  const hits = scan(v);
  const tracked = trackedFiles();
  if (hits.length) {
    console.log('✗ 文档中的数字与真值不符（' + hits.length + ' 处）：');
    hits.forEach((h) => console.log('   ' + h.rel + ':' + h.line + '  [' + h.label + '] 写的是 ' + h.got + '，应为 ' + h.want
      + '\n      ' + h.text.slice(0, 110)));
    bad = true;
  } else if (!v.unitTestsError) {
    console.log('✓ 已扫描 ' + tracked.length + ' 个 markdown 文件，命令数/工具数/用例数/断言数均与真值一致');
  } else {
    console.log('（已扫描 ' + tracked.length + ' 个 markdown 文件，但用例数真值缺失，故不作"一致"结论）');
  }

  // 体量/行数类易腐数字（RULES §4 的约定，本门禁把它落地）：无版本锚/历史标记即红
  const sizeHits = scanSizeClaims();
  if (sizeHits.length) {
    console.log('✗ 体量/行数类数字没有版本锚或历史标记（' + sizeHits.length + ' 处，会被读成现状）：');
    sizeHits.forEach((h) => console.log('   ' + h.rel + ':' + h.line + '  [' + h.label + '] ' + h.text.slice(0, 110)));
    console.log('   → 二选一：改写成不带数字的表述；或标注为历史（同行的 `vX.Y.Z` / 「快照」/「原记」/「当时」）。');
    bad = true;
  } else {
    console.log('✓ 体量/行数类数字都带版本锚或历史标记（或未出现）');
  }

  // 交接面歧义：文档里出现比发布版本更高的 vX.Y.Z（分不清笔误 / 另一套命名空间）
  const futHits = scanFutureVersions(v.version);
  if (futHits.length) {
    console.log('✗ 文档里出现高于当前发布版本（v' + v.version + '）的版本号（' + futHits.length + ' 处）：');
    futHits.forEach((h) => console.log('   ' + h.rel + ':' + h.line + '  [' + h.label + '] ' + h.got
      + '  |  ' + h.text.slice(0, 90)));
    console.log('   → `vX.Y.Z` 只表示**发布版本**（`package.json`）；内部迭代写成「v0.16 系列」或「迭代 N」。');
    console.log('     若确实在说未来版本，同行加「计划 / 拟 / 目标 / 预计」等字样即可放行。');
    bad = true;
  } else {
    console.log('✓ 文档里的版本号都不高于当前发布版本（或已标明是计划/迭代）');
  }

  // 第一屏（`SKILL.md`）自报的验证链步骤数 —— **手写第一屏是唯一没有生成器守着的关键页**
  // （实测：它漂了两轮没人察，而 docs/VERIFY.md 那处是生成物、自动跟着 STEPS 走）
  const stepScan = scanStepCount();
  const stepMsg = stepCountProblem(stepScan.claims, stepScan.want);
  if (stepMsg) {
    console.log('✗ 第一屏的验证链步骤数与 `scripts/verify.js` 不一致：');
    console.log('   ' + stepMsg);
    bad = true;
  } else {
    console.log('✓ 第一屏 `SKILL.md` 自报的步骤数与 `STEPS` 一致（' + stepScan.want + ' 步）');
  }

  // 交接面提示（**只提示不判红**）：[Unreleased] 太长说明该发版了 —— 它不受滚动窗口约束
  try {
    const cl = path.join(ROOT, 'CHANGELOG.md');
    if (fs.existsSync(cl)) {
      const idx = require(path.join(ROOT, 'src', 'changelog.js')).indexChangelog(fs.readFileSync(cl, 'utf8'));
      const un = idx.sections.find((s) => s.version === 'Unreleased');
      if (un && un.lines > 400) {
        console.log('ℹ️ 提示：`[Unreleased]` 已有 ' + un.lines + ' 行 —— 它不受滚动窗口约束，'
          + '越长越占接手者的上下文；建议发一版收口（`node cli/mm-cli.js release --minor`）。');
      }
    }
  } catch (e) { /* 提示失败不影响门禁结论 */ }

  if (bad) { console.error('\ndoc-facts 校验失败'); process.exit(1); }
  console.log('\ndoc-facts 校验通过');
}

/** `docs/VERIFY.md` 的绝对路径（**只在这里算一次** —— 别的函数不许自己拼这条路） */
function verifyDocPath() {
  return path.join(ROOT, 'docs', 'VERIFY.md');
}

/**
 * `--write` 的**先读**：把"我读到的是哪一版"在读的那一刻带走，写回时交给闸门。
 *
 * ⚠️ 调用点必须在 `facts()` **之前**（见 `main()` 的注释）：`facts()` 会真跑一遍 vitest（数十秒），
 * 那正是别人可能改这份生成物的窗口；等到"写之前"才读、读完立刻写，闸门**恒等放行** ——
 * 那是假闸门，与 `src/data-store.js` 的 `writeManagedText` 注释里点名的失效形态是同一种。
 *
 * `optional:true` 的理由：**首次生成**时 `docs/VERIFY.md` 还不存在（`version = null` ⇒ 闸门按"新建"放行，
 * 与本文件从前的行为一致）；其余情况读不到就是真问题，闸门会按"盘上已不存在"拒写。
 * @param {string} [file] 仅单测用（默认 = 仓库里的 `docs/VERIFY.md`）
 * @returns {{file:string, text:(string|null), version:(string|null)}}
 */
function readVerifyDocHandle(file) {
  return readManagedText(file || verifyDocPath(), { optional: true });
}

/**
 * 生成并写回 `docs/VERIFY.md`：**原子写 + 版本闸门**（写盘出口只有 `writeManagedText` 一处）。
 *
 * @param {object} v `facts()` 的返回值
 * @param {{file:string, version:(string|null)}} handle **必须**是 `readVerifyDocHandle()` 的返回值。
 *   ⇒ 本函数**不接受"不传句柄"**：不传就等于把闸门静默关掉，而"静默关掉"正是本批要消灭的形态
 *   （宁可抛出来，也不许悄悄退回裸写）。
 * @returns {boolean} 是否真的写了。`false` = 拒绝（真值缺失 / 并发冲突），两种情况都已打印原因与出路。
 */
function writeVerifyDoc(v, handle) {
  if (!handle || typeof handle !== 'object' || !handle.file || !('version' in handle)) {
    throw new Error('writeVerifyDoc 需要一个来自 readVerifyDocHandle() 的句柄 —— '
      + '不带版本的整文件写回会把别人的改动静默抹掉（本工程不允许第二条无闸门的写路径）');
  }
  // 取不到真值就**不要写**：VERIFY.md 是权威基线，写进一个 `null` 比不写更糟
  // （实测：vitest 一时跑不起来 → 生成出「null 用例」，而 --check 路径是拒绝的 —— 两条路必须一致）。
  if (v.unitTests === null || v.unitTests === undefined) {
    console.error('✗ 取不到单测用例数真值，**拒绝生成** docs/VERIFY.md：'
      + (v.unitTestsError || '未知原因'));
    console.error('  → 先让 `npm test` 能正常跑完（或直接 `npm run verify`，它会带着 G3 的结果调本步），再重试。');
    return false;   // 退出码由 main() 统一给（同一份代码在单测里被调用，不能用 process.exit 杀掉 worker）
  }
  fs.mkdirSync(path.dirname(handle.file), { recursive: true });
  const content = renderVerifyDoc(v);
  try {
    writeManagedText(handle, content, {
      // `label` / `hint` 只影响**报错文案**（比较逻辑不可配）；hint 是"被报的那一方真做得到的那一句"。
      label: '生成物「' + path.relative(ROOT, handle.file).split(path.sep).join('/') + '」',
      hint: '请重跑 `npm run facts:write`（它会重新读最新一版再生成）'
    });
  } catch (err) {
    // **绝不允许静默**：报出两侧版本，并给出出路（F1：死指针不算出路）。
    console.error('✗ 拒绝写入 ' + relOf(handle.file) + '：并发写入冲突 —— 盘上已不是本次读到的那个版本。');
    console.error('    ' + ((err && err.message) || err));
    if (err && err.code === 'VERSION_CONFLICT') {
      console.error('    读到的版本（本次生成开始时）: ' + String(err.expectVersion));
      console.error('    盘上的版本（写回时）:        '
        + (err.actualVersion === null ? '（文件已不存在）' : String(err.actualVersion)));
      console.error('  → 重跑 `npm run facts:write`：它会重新读取最新一版再生成。'
        + '（磁盘上的内容**一个字节都没被改**，这次的生成结果被丢弃。）');
    }
    return false;
  }
  console.log('已生成 docs/VERIFY.md（' + v.commands + ' 命令 / ' + v.mcpTools + ' 工具 / '
    + v.unitTests + ' 用例 / ' + v.cliAssertions + ' 集成断言 / ' + v.smokeAssertions + ' 冒烟断言 / '
    + v.visionAssertions + ' 视觉断言）');
  return true;
}

/** 报错文案里用的相对路径（绝对路径对读日志的人没有信息量） */
function relOf(file) {
  return path.relative(ROOT, file).split(path.sep).join('/') || String(file);
}

/** 纯渲染：`docs/VERIFY.md` 的全文（G7 用同一个函数重算并逐字比对，所以**不能含时间等易变内容**） */
function renderVerifyDoc(v) {
  const body = [
    '# 验证基线（VERIFY）',
    '',
    // 头部元信息（§5 登记表的数据源）——必须由生成器产出，否则每次重生成都会抹掉它
    '<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）',
    '层: 契约',
    '作用: 验证基线（各类计数 + 验证链）',
    '不该写: 被测功能说明',
    '更新方式: `doc-facts --write` 生成',
    '-->',
    '',
    '> 本文件由 `node scripts/doc-facts.js --write` **自动生成**，请勿手改。',
    '> 作用：本工程「易腐事实」的唯一权威副本（命令数 / 工具数 / 用例数 / 断言数 / 版本号）。',
    '> 其他文档**不要**再抄写这些数字，改为引用本文件，或直接运行 `node scripts/doc-facts.js`。',
    '',
    '## 权威值',
    '',
    '| 事实 | 值 | 来源 |',
    '|------|----|------|',
    '| CLI 命令数 | ' + v.commands + ' | `cli/registry.js`（`registry.list().length`） |',
    '| MCP 工具数 | ' + v.mcpTools + ' | `scripts/mcp-server.js`（导出的 `TOOLS.length`） |',
    '| 单元测试 | ' + v.unitTests + ' 用例 / ' + v.unitFiles + ' 文件 | `tests/*.test.js`（vitest） |',
    '| CLI 集成断言 | ' + v.cliAssertions + ' | `scripts/cli-integration.js` |',
    '| 冒烟断言 | ' + v.smokeAssertions + ' | `scripts/smoke-assertions.js` |',
  '| 视觉断言（L2 关键区域） | ' + v.visionAssertions + ' | `scripts/vision/roi-assertions.js`（`ROIS.length`） |',
    '| 版本号 | ' + v.version + ' | `package.json` / `src/config.js` / `package-lock.json`（须一致） |',
    '',
    '## 验证链',
    '',
    '> **执行顺序、每步命令与耗时预算的唯一定义在 `scripts/verify.js`**；本表由它渲染，勿手改。',
    '',
    '```bash',
    'npm run verify    # ' + verifyChain.STEPS.filter((s) => s.cmd).map((s) => s.label).join(' → ')
      + '（合计预算 ' + (verifyChain.TOTAL_BUDGET_MS / 1000) + 's）',
    '```',
    '',
    '每步可单独运行；下表即 `docs/RULES.md` §2 的**门禁表**（`G1–G9` 与 `V1`/`V2`），顺序与 verify 链一致：',
    '',
    '| 步 | 门禁 | 命令 | 耗时预算 | 覆盖 |',
    '|----|------|------|---------|------|',
    ...verifyChain.STEPS.map((s) => '| ' + s.step + ' | ' + s.gate + ' | ' + s.shown + ' | '
      + (s.budgetMs > 0 ? (s.budgetMs / 1000) + 's' : '（与 G6 同一次调用）') + ' | ' + s.covers + ' |'),
    '',
    '> **只改了某一条冒烟断言时不必跑全链**：`SMOKE_ONLY=<文件前缀> npm run smoke`',
    '> （等价写法 `electron . --smoke-only=<文件前缀>`）只跑选中的那几个断言文件，',
    '> **永远并入 `01-*`**（预热：它负责加载渲染层并打开 comnet，后面的断言都假设这个前提）。',
    '> 过滤运行**不产截图/取景记录/视觉断言**，其计数也**不代表本文件的冒烟真值** ——',
    '> 真值只由全量运行代表（`npm run verify` 或 `npm run smoke` 不带选择串时）。',
    '> 选择规则、以及"筛错名字必须响亮失败（采不到真值 = 红）"见 `scripts/smoke-select.js`。',
    '',
    '> 耗时预算是**止涨线**，不是性能目标 —— 它防的是「每次只涨一点点、没人注意到」。',
    '> 倍数**不是**"实测的 2–3 倍"（本文件原先这么写，实测不成立，已订正）：口径 = `tests/verify-budget.test.js`',
    '> 的余量守卫「**预算 ≥ 1.25 × 窗口（最近 10 次）的 median**」，昂贵步骤（G3/G4/G5）实际只有 1.25–1.43 倍；',
    '> 廉价门禁取 10/15/20 s 的整档，倍数远大于 2 但不具可比性。median 在 n=10 时取**第 5/6 个值的均值**',
    '> ⇒ 单次负载尖峰抬不动线（要 **6 条**读数变慢才会动），代价是"持续慢化滞后 6–9 条读数"（有界）；',
    '> 它**不会**被「一半慢一半快」的混合掩盖：混合窗口 `1.25×median ≥ 慢档` 只要慢档 ≤ 1.667×快档成立。',
    '> 本链曾从 176 s 压到约 77 s（集成断言由"每条起一个进程"改为进程内调用），预算是让这个成果守得住。',
    '> 超预算时 `npm run verify` 会红，并提示"若增长合理就改 `scripts/verify.js` 的预算**并说明理由**"。',
    '',
    '> 门禁的分级、强制方式与"为什么这些不需要记住"，见 **`docs/RULES.md`**。',
    '',
    '## 本机受限环境注意',
    '',
    '- `npm test` 已固定 `--pool=threads`：默认 `forks` 池会 fork 子进程并用**管道 stdio** 收集结果，',
    '  在禁止管道 stdio 的环境（企业 EDR / 沙箱）下报 `spawn EPERM` 与 "no tests" —— 那是**假失败**。',
    '- `scripts/cli-integration.js` 已改为**进程内调用**（`cli/main.js` 的 `invokeSync`），不再依赖管道 stdio，',
    '  上面那条历史假失败已消除；文件末尾保留 4 条**真子进程**对照断言（那 4 条仍需能 spawn 子进程）。',
    '- ⚠️ **跑 `scripts/cli-integration.js` 时，别用会"提前关闭管道"的方式取输出**',
    '  （PowerShell 的 `Select-Object -First N`、`head`、`| more` 都是这一类）。',
    '  管道被提前关闭会**杀掉脚本** ⇒ 它**文件末尾的收尾清理不执行** ⇒ 留下一批 `it-probe-*` 探针项目',
    '  （其中 `…-assoc` 是**故意注入过悬挂成员**的 fixture）⇒ 下一步 **G2 `validate-all` 把这些探针当项目验，报假红**。',
    '  `[实测]` 2026-09-29：一次这样的运行留下 5 个探针，全链在 G2 报 `it-probe-…-assoc 悬挂关联成员`。',
    '  处置：删掉 `projects/it-probe-*` 后重跑；**要看部分输出就先把结果存进变量或文件，再截取**。',
    '  （脚本自己也防了一手：开工前清扫**超过 10 分钟**没动过的探针 —— 但刚被中断的那批太新，扫不掉。）',
    '- **`npm run smoke`（G5）要求 Electron 能真正启动**：在部分受限路径 / 环境下 Chromium 进程',
    '  会**立即死亡**（实测 `node_modules\\.bin\\electron.cmd --version` 也零输出、退出码',
    '  `-2147483645` = `0x80000003` STATUS_BREAKPOINT），此时 G5 **假失败且没有任何断言输出**。',
    '  判据：**先单独跑 `electron --version`** —— 它都出不来就是环境问题，与工程内容无关；',
    '  实测同一份工程内容换一个能启动的 Electron 二进制即得 **112/112**。',
    '- ⚠️ **验证期间不要在工程内并发写文件**（例如另一个 AI 子代理正在改文件、或编辑器正在保存）。',
    '  `[实测]` 2026-09-26：同一份内容，**有并发写入的 3 次全链里 2 次失败**（一次 G2「数据校验」报红 —— 它正在读那些被改的文件；',
    '  一次 G3 `npm test` 以退出码 `3221225477` = `0xC0000005` 访问违例**原生崩溃** —— 测试进程脚下的文件被改），',
    '  而**停止并发写入后连跑 6 次全部通过**（可用内存 6.5–7.1 GB 几乎不变，故**不是内存压力**）。',
    '  这类红是**假失败**，属本文档第一类失败模式（"把测量环境的限制当成被测对象的缺陷"）的新实例。',
    '  判据：**先看那次失败发生在哪一步** —— G2/G3 这类"读或跑工程文件"的步骤，最可能被并发写入污染；',
    '  处置：**让它单独重跑一次**（`npm run verify`），不要直接当成"我改坏了"。',
    '',
    '## 文档体系快照',
    '',
    '> 由本生成器**现场计算**（不是抄写）：接手者想一眼看清"文档体系现在长什么样"，看这一节即可。',
    '> 规则与判定见 `docs/ARCHITECTURE.md` §5，判定实现见 `scripts/docs-registry-check.js`（G8）。',
    '',
    ...docSystemSnapshot(v),
    '',
    '---',
    '',
    '*本文件由 `scripts/doc-facts.js` 生成（勿手改）；对应版本 v' + v.version + '。*',
    ''
  ].join('\n');
  return body;
}

/* ---------------- 文档体系快照（生成物的一节） ----------------
 * 为什么放进生成物：接手者需要"一眼看清文档体系现状"（几份文档、归档多少、工作目录哪些还在飞、
 * 上次全链结果），而**手写这类清单必然漂移**（本工程吃过"清单多副本"的亏）。
 * 这里全部**现场计算**；上次全链结果**引用** `.review/last-verify.json`（丢了就写"无记录"）。
 * 注意：本节的数字都会进 G6 扫描范围（VERIFY.md 是受管文档），所以措辞刻意避开
 * 「N 条命令 / N 个用例 / N 条断言」这些**保留字**，否则会把自己算成事实声明。 */
function docSystemSnapshot(facts) {
  const out = [];
  let registry = null;
  try { registry = require(path.join(ROOT, 'scripts', 'docs-registry-check.js')); } catch (e) { registry = null; }
  // 各层文档数（来自 §5 登记表 —— 单一真源，不另抄一份）
  if (registry) {
    try {
      const md = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
      const reg = registry.parseRegistryTable(md);
      const layers = new Map();
      // 从 §5 表里抓「层 | 文档」两列的分布（section5 返回的是**行数组**，不是字符串）
      // 注意：§5 之下还有 5.0/5.1 子节（写作约定 / 接手演练）各自带表格 —— 遇到 `###` 即停，
      // 只统计**登记表**本身，否则会把子节的表格也算成"层"（实测第一版就把"只读理解/执行变体"算进去了）。
      const secLines = [];
      for (const l of (registry.section5(md) || [])) {
        if (/^###\s/.test(l)) break;
        if (/^\|/.test(l)) secLines.push(l);
      }
      secLines.forEach((l) => {
        const c = l.split('|').map((x) => x.trim());
        if (c.length < 4 || /^-+$/.test(c[1]) || c[1] === '层') return;
        const layer = c[1].replace(/\*\*/g, '');
        layers.set(layer, (layers.get(layer) || 0) + 1);
      });
      out.push('| 事实 | 值 | 来源 |', '|------|----|------|');
      out.push('| 受管文档（登记表登记数） | ' + reg.exact.size + ' 份 | `docs/ARCHITECTURE.md` §5 表 |');
      out.push('| 登记表分层的条目分布 | ' + [...layers.entries()].map(([k, n]) => k + ' ' + n).join(' · ')
        + ' | 同上（含归档族的前缀行） |');
      out.push('| 归档族 | `docs/archive/` ' + countFiles('docs/archive') + ' 份 · `docs/changelog/` '
        + countFiles('docs/changelog') + ' 份 | 磁盘现场统计（只增不改，不逐份登记） |');
    } catch (e) { out.push('（登记表解析失败：' + (e && e.message) + '）'); }
  }
  // 工作产物区（`.review/`）：**内容不进这份受管文档**。
  // 为什么（实测缺陷，2026-10-10）：这一行原先把 `.review/` 的**目录清单 + 各自状态**渲染进来，
  // 于是任何"只读仓库 + 只写 `.review/`"的核查任务 —— 而写 `.review/` 正是工作产物区的用途 ——
  // 都会让这份生成物与现场不一致，全链在 G6/G7 判红：
  //   `✗ 生成物已过期：docs/VERIFY.md（第 98 行起不一致）`
  // 收口判据：**易变、可随时整目录删的工作区，不得成为受管真值的一部分**（否则"用它"就等于"改真值"）。
  // 它真正的守卫是 G8（`scripts/docs-registry-check.js`）：`.review/<目录>/README.md` 必须声明
  // 死活（在飞 / 已收口 / 已废弃）—— 那条**保留** ✓：它管的是"可删性与状态"，不是这份目录清单。
  out.push('| 工作产物区（`.review/`） | 见 `.review/*/README.md` 的状态行（**目录清单刻意不进本文件**：'
    + '工作区可随时整目录删除，清单写进来会让"新建/删除一个工作目录"变成"生成物过期" ✗） | '
    + '各目录的 `README.md`，死活判定见 G8（`npm run check:docs`） |');
  // 上次全链（引用，不复制）
  // 上次全链：**只写指针**（值由 `verify` / `check:docs` 现场打印）——
  // 写值会让本文件变成"每天都不一样"，从而无法被 G7 逐字校验。
  out.push('| 上次全链结果 | 见 `.review/last-verify.json`（`npm run verify` 与 `npm run check:docs` 都会打印当前值） | 每次 `npm run verify` 写入 |');
  out.push('');
  out.push('> 交接面：「什么没做完」看 `docs/ROADMAP.md` 的「在飞 / 未收口」；');
  out.push('> 「最近改了什么」看 `CHANGELOG.md` 的 `[Unreleased]`；接手顺序见 `SKILL.md` 顶部「接手 5 步」。');
  return out;
}

function countFiles(rel) {
  try { return fs.readdirSync(path.join(ROOT, rel)).filter((f) => /\.(md|html?)$/i.test(f)).length; }
  catch (e) { return 0; }
}

// ⚠️ `require.main` 守卫 **不是**格式洁癖，它修的是一个真实后果：
// 本文件原先在此处**无条件**执行 `main()`，于是 `require('scripts/doc-facts.js')` 会**直接跑主流程**
// ⇒ 它**无法被单测引入** ⇒ 本工程的门禁里，**它的判定逻辑长期没有单测**。
// 而这个代价在 2026-09-26 体现过：断言正则认识不到中文自然写法（「2 条视觉断言」），
// 门禁因此在**空转**，只靠一次手动的判别力证明才发现。
// 加守卫后：`require` 只拿导出、不跑主流程；直接 `node scripts/doc-facts.js` 的行为**逐字不变**。
if (require.main === module) main();

/**
 * 从 vitest 输出里取**用例总数**。
 *
 * ⚠️ **为什么不能取 `passed`**：摘要有两种形态 ——
 *   全绿：`Tests  592 passed (592)`；
 *   有失败：`Tests  2 failed | 590 passed (592)`。
 * 取 `passed` 会在**有失败用例时静默记下一个偏小的数**，而它会被写进 `docs/VERIFY.md` 当"真值"，
 * G6 又拿它自比自 ⇒ **门禁永远发现不了**。
 * （实测：一次 `npm run facts:write` 正赶上 2 个测试红 ⇒ VERIFY.md 被写成 590，真实总数是 592。）
 * 故**优先取括号里的总数**；没有括号才退回 `passed`。
 */
function parseVitestCount(text) {
  const s = String(text || '').replace(/\u001b\[[0-9;]*m/g, '');   // 去 ANSI 色码
  // ⚠️ 必须**行首锚定 + 取最后一条**：vitest 有失败用例时会先打印测试树，
  //    测试名里也可能出现 "Tests …"（实测撞进过：解析成 null ⇒ facts:write 拒绝生成 ✗）。
  //    摘要行永远是最后一条 ✓。返回结构与 Array.prototype.exec 兼容（[0]=整行, [1]=捕获组）。
  const all = [...s.matchAll(/^\s*Tests\s+([^\n]*)$/gm)];
  const line = all.length ? all[all.length - 1] : null;
  if (!line) return null;
  const total = /\((\d+)\)/.exec(line[1]);        // `… (592)` ← 总数（**要这个**）
  if (total) return Number(total[1]);
  const passed = /(\d+)\s+passed/.exec(line[1]);  // 兜底：没有括号的形态
  return passed ? Number(passed[1]) : null;
}

module.exports = {
  parseClaims, scan, trackedFiles, markdownFiles,
  findSizeClaim, scanSizeClaims, SIZE_ANCHOR,
  findFutureVersion, scanFutureVersions, docSystemSnapshot, renderVerifyDoc,
  parseVitestCount,
  // 写档（`--write`）的**两条腿**分开导出，单测才能分别打红它们（`tests/doc-write-gate.test.js`）：
  //   `readVerifyDocHandle` = 读 + 带回版本；`writeVerifyDoc` = 渲染 + 过闸门写回（**必须**收到前者）
  verifyDocPath, readVerifyDocHandle, writeVerifyDoc,
  // 第一屏（`SKILL.md`）步骤数 ↔ `STEPS.length`（纯函数那一半单独导出，便于单测）
  parseStepCountClaims, scanStepCount, stepCountProblem
};
