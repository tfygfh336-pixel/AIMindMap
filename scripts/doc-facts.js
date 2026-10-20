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

/* ---------------- 第六类扫描：真值出口唯一（`FACT_OUTLET` / 缺口 `G-09`） ----------------
 * 它补的是本文件**前面五类扫描都没有覆盖的那一半**（先读清楚再动手，别造第二份）：
 *   · 前五类管的是「**生成物 vs 源**」与「**值对不对**」——命令数 / 工具数 / 用例数 / 断言数 /
 *     版本号 / 步骤数，它们的真值都能从代码现算，所以任何副本写错都能被比出来；
 *   · 它管的是「**两份手写文档各写一个数**」——当这个事实的真值**算不出来**时（受管文档份数之外的
 *     那些、随数据变化的读数），`scan()` 无从比对，**两份副本各写一个数谁都不会红**。
 *     ★实测（本批清点）：`docs/VERIFY.md` 里由生成器守护的十来个事实中，只有 4 类进了 `scan()`；
 *     其余（受管文档份数 / 归档族份数 / 单测**文件**数 / 标签词表条数）**只有 VERIFY.md 那一份，
 *     别处一旦手抄就没有任何守卫**。
 *
 * 判定（**同一事实只准有一个手抄副本** —— 与 `B1`「易腐数字由脚本生成、其它文档只引用」同一条）：
 *   ① 出口文件**自己**不算副本（它就是权威）；
 *   ② 别处命中时，**同一行**必须带「指针」——把真值推给出口（行内有出口路径 / `doc-facts` /
 *      「现场取」「现算」），或已标成历史（`当时` / `快照` / `原记` / `曾` / `vX.Y.Z`）；
 *   ③ 同一事实的**手抄副本若出现两个不同的值** ⇒ 红，并把两个数逐处点名 ——
 *      这正是台账上那句话「**避免一句话里两个数**」的机械形态；
 *   ④ 出口文件**不存在** ⇒ 红（采不到真值 = 红，`A5`；不许把"没找到出口"读成"没有副本"）。
 *
 * 边界（诚实标注，别以为它包住一切）：
 *   · 事实表是**显式常量**（`FACT_OUTLETS`），因为"哪些数字算同一件事"是人的判断（与
 *     `SCHEMA_FIELDS` / `COLLATERAL` 同一个设计取舍）。**没进表的事实它一无所知** ✓；
 *   · 它判的是"**有没有第二份手抄**"，判不了"这一份写得对不对"（那是 `scan()` 的事）；
 *   · **口径类**事实（例：`comnet` 节点数，`list --json` 含根 = 889 / 不含根 = 888）走
 *     `needQualifier`：命中行必须带口径或历史标记。这是它能做到的那一半 ——
 *     "**该用哪个口径**"仍是人的判断（已写进 `docs/RULES.md` 的 `G-09` 边界栏）。
 */
const NB2 = '(?<![\\d.])';
const FACT_OUTLETS = [
  { id: 'managed-docs', label: '受管文档份数', outlet: 'docs/VERIFY.md',
    res: [new RegExp(NB2 + '(\\d+)\\s*份\\s*受管文档', 'g'),
      new RegExp('受管文档[^\\d\\n|]{0,10}' + NB2 + '(\\d+)\\s*份', 'g')],
    why: '§5 登记表的登记数（生成物现场算）—— 抄一份就等于给"文档体系有多少份"造第二个答案' },
  { id: 'archive-count', label: '归档族份数', outlet: 'docs/VERIFY.md',
    res: [new RegExp('docs/(?:archive|changelog)/?[^\\n|]{0,14}' + NB2 + '(\\d+)\\s*份', 'g'),
      new RegExp('归档族[^\\n|]{0,24}' + NB2 + '(\\d+)\\s*份', 'g')],
    why: '归档族份数由磁盘现场统计；手抄一份就会在"又归档了一段"之后静默变错' },
  { id: 'unit-files', label: '单测用例 / 文件（`docs/VERIFY.md` 那一行的形状）', outlet: 'docs/VERIFY.md',
    res: [new RegExp(NB2 + '(\\d+)\\s*用例\\s*[/／]\\s*' + NB2 + '(\\d+)\\s*文件', 'g')],
    why: '用例数已由 scan() 守；但**文件数**（新增一个 tests/*.test.js 就会变）没人守' },
  { id: 'tag-count', label: '标签词表条数', outlet: 'docs/TAGS.md',
    res: [new RegExp(NB2 + '(\\d+)\\s*个标签', 'g')],
    why: '`docs/TAGS.md` 自述是词表的唯一权威；别处再写一遍条数就是第二份会漂的口径' },
  { id: 'node-readings', label: '随数据变化的节点读数（口径类）', outlet: '现场取（`list --json` / `read --json`）',
    needQualifier: true,
    res: [new RegExp(NB2 + '(\\d{2,5})\\s*个节点', 'g')],
    key: (line) => /comnet|--json|`list`|`read`/.test(line),
    why: '★台账原话的现场：同一个项目两个数（含根 / 不含根）—— 读数随数据变，**必须带口径或历史锚**' }
];

/** 指针标记：这一行把真值推给唯一出口，或已明确标成历史/口径 ⇒ 不算"手抄"。
 *  ⚠️ **不许**为了让它变绿而放宽这里（`B5`）：每加一个词都会让一整类手抄副本免检。 */
const FACT_POINTER = new RegExp([
  'docs/VERIFY\\.md', 'docs/TAGS\\.md', 'docs/RULES\\.md',
  'doc-facts', '现场取', '现算',
  '当时', '快照', '原记', '曾', 'v\\d+\\.\\d+\\.\\d+',
  '含根', '不含根', '以[^。\\n]{0,20}为准'
].join('|'));

/* 封闭欠账册：判据上线那一刻的存量副本（只减不增；每条 why / close）。
 * 机器侧三条判定（与 `NOTE_RESIDUE` / `WRITE_OUTLET` 同一口径）：
 *   在册 ⇒ 放过并计入"在册欠账"；**册上那条已不再命中 ⇒ 红**（修好忘销账）；
 *   **册上那处文件已不存在 ⇒ 红**（悬挂登记）。
 * 键 = `文件::值`（**不按行号**：行号一漂就全册假红，本工程真吃过这个亏）。
 *
 * 2026-10-20（门禁B2）**销掉 1 条**（`docs/ARCHITECTURE.md` 的 `node-readings` 889）：
 *   §7 那两句里 **733 本来就带「当时」**（合法指针），真正的手抄只有 **683** 那句；
 *   已在同一批改成带历史锚 + 指针（"`comnet` 那 889 个节点（**快照**读数，见 §7.2 那张表）"）⇒
 *   该事实在册副本归零。按本册的机器侧规则，"修好忘销账"要判红，所以**销账必须与修好同批**
 *   （与 `ARTIFACT_BATCH_DEBT` / `DUP_ROW_EXEMPT` 的那句「销账要和修好同批」是同一条纪律）。 */
const FACT_OUTLET_DEBT = [
  // 空册：`node-readings` 那一条已于 2026-10-20 修好并销账（见上）。
  // 加新条目之前先问：这处副本**真的没法**写成指针或历史锚吗？→ 册只减不增，别把"修文档"变成"记账"。
];

/** 从一行文本里取该事实命中的**全部**读数（纯函数；`key` 存在时先过一遍行级前置条件） */
function factReadingsInLine(fact, line) {
  if (fact.key && !fact.key(line)) return [];
  const out = [];
  fact.res.forEach((re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      // 正则里可能有多个捕获组：取**第一个非空**的那个（顺序即优先）
      const val = [m[1], m[2]].map((x) => (x === undefined ? NaN : Number(x))).find((x) => !Number.isNaN(x));
      if (!Number.isNaN(val)) out.push(val);
    }
  });
  return out;
}

/**
 * 扫描「同一事实的手抄副本」。**纯函数 + 可注入扫描根**（`B6`：`require` 零副作用、判定可单测）。
 * @param {string} [rootDir] 扫描根（默认仓库根）—— 单测 / 判别力证明指向夹具用
 * @param {{outlets?:Array, debt?:Array, files?:string[]}} [opts]
 *   `files` = 直接给文件清单（相对 rootDir 的 posix 路径）；不给就递归扫 `*.md`
 * @returns {{problems:Array, notes:Array, facts:Array}}
 */
function scanFactOutlets(rootDir, opts) {
  const o = opts || {};
  const root = path.resolve(rootDir || ROOT);
  const facts = o.outlets || FACT_OUTLETS;
  /* 欠账册只对**真仓**有意义（它声明的是真仓的存量）。
   * 扫描根被换成夹具时，拿真仓那本册去核必然判"悬挂登记" ⇒ 那是**证明过程自己造假红**
   * （与 `analyzeNoteResidue` 同一条处置）。夹具侧要核册请显式传 `debt`。 */
  const sameRoot = path.resolve(rootDir || ROOT) === path.resolve(ROOT);
  const debt = o.debt !== undefined ? o.debt : (sameRoot ? FACT_OUTLET_DEBT : []);
  const problems = [];
  const notes = [];

  const files = Array.isArray(o.files)
    ? o.files.slice()
    : (function walkMd(base) {
      const out = [];
      // 与 `markdownFiles()` 同一个 SKIP 面（依赖 / 构建产物 / 数据 / 工作产物区）
      const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-portable', 'build', 'backups',
        '.tmp-img', '.tmp-svg', 'projects', 'vendor', '.review']);
      (function rec(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (SKIP.has(e.name)) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) rec(p);
          else if (e.name.endsWith('.md')) out.push(path.relative(base, p).replace(/\\/g, '/'));
        }
      })(base);
      // 与 `trackedFiles()` **同一条口径**（历史记录里出现旧数值是正常的，不是第二份副本）：
      // `CHANGELOG.md` / `docs/archive/` / `docs/changelog/` 都不参与"当前事实"的判定。
      // ⚠️ 不许为了变绿去放宽扫描面（`B5`）—— 这里排除的是**历史区**，不是"难判的那一类"。
      return out.filter((rel) => rel !== 'CHANGELOG.md'
        && !rel.startsWith('docs/archive/') && !rel.startsWith('docs/changelog/')).sort();
    })(root);

  const result = [];
  facts.forEach((f) => {
    // ④ 出口文件必须真的在（采不到真值 = 红）
    if (f.outlet && /\.md$/.test(f.outlet) && files.indexOf(f.outlet) < 0
      && !fs.existsSync(path.join(root, f.outlet))) {
      problems.push({ kind: 'fact-outlet',
        msg: '事实「' + f.label + '」的出口 `' + f.outlet + '` 不存在 —— 采不到真值（`A5`）：'
          + '不能把"没找到出口"读成"没有副本"' });
    }
    const hits = [];
    files.forEach((rel) => {
      if (rel === f.outlet) return;                     // ① 出口自己不算副本
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) return;
      fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/^\s*#{1,6}\s/.test(line)) return;           // 标题行：章节号不是声明（与 parseClaims 同口径）
        factReadingsInLine(f, line).forEach((value) => {
          hits.push({ rel, line: i + 1, value, pointer: FACT_POINTER.test(line),
            text: line.trim().slice(0, 160), fact: f.id });
        });
      });
    });
    const copies = hits.filter((h) => !h.pointer);
    // ③ 同一事实两个数（"一句话里两个数"的机械形态）
    const distinct = [...new Set(copies.map((h) => h.value))];
    if (distinct.length > 1) {
      problems.push({ kind: 'fact-two-values',
        msg: '事实「' + f.label + '」的手抄副本出现 **' + distinct.length + ' 个不同的数**：'
          + copies.map((h) => h.value + ' @ ' + h.rel + ':' + h.line).join(' / ')
          + ' —— 同一件事只准有一个答案（其余写成指针，以 `' + f.outlet + '` 为准）' });
    }
    // ② 每一处手抄副本：在册 ⇒ 放过；否则判红
    copies.forEach((h) => {
      const inBook = debt.some((d) => d.fact === f.id && d.rel === h.rel && Number(d.value) === h.value);
      if (inBook) { h.state = 'debt'; return; }
      problems.push({ kind: 'fact-copy',
        msg: '事实「' + f.label + '」在 `' + h.rel + ':' + h.line + '` 又写了一份（值 ' + h.value
          + '）：' + f.why + ' —— 改成指针（行内写 `' + f.outlet + '`）或标成历史（`当时` / `vX.Y.Z`）' });
    });
    result.push({ fact: f.id, label: f.label, outlet: f.outlet, hits, copies,
      distinct, debt: copies.filter((h) => h.state === 'debt').length });
    notes.push('真值出口 · ' + f.label + '（出口 `' + f.outlet + '`）：出口之外命中 ' + hits.length
      + ' 处 → 指针 ' + (hits.length - copies.length) + ' · 手抄 ' + copies.length
      + '（其中在册欠账 ' + (copies.length - copies.filter((h) => h.state !== 'debt').length) + ' 条）');
  });

  // 欠账册的三条机械判定
  debt.forEach((d) => {
    const f = facts.find((x) => x.id === d.fact);
    if (!f) {
      problems.push({ kind: 'fact-debt', msg: '欠账册上那条指着一个**不存在的事实** `' + d.fact
        + '`（悬挂登记）—— 事实被改名/删掉时请同批改册' });
      return;
    }
    if (!fs.existsSync(path.join(root, d.rel))) {
      problems.push({ kind: 'fact-debt', msg: '欠账册上那条的文件 `' + d.rel
        + '` 已不存在（悬挂登记）—— 册上对象消失时必须同批销账' });
      return;
    }
    const still = result.find((r) => r.fact === d.fact);
    const hit = still && still.copies.some((h) => h.rel === d.rel && Number(h.value) === Number(d.value));
    if (!hit) {
      problems.push({ kind: 'fact-debt', msg: '欠账册上那条已不再命中：`' + d.rel + '` 里的 `'
        + d.fact + '` 读数 ' + d.value + ' 找不到了 —— 要么已经修好（请同批销账），'
        + '要么数值变了（请重看那处的口径并更新册）' });
    }
  });
  notes.push('真值出口：在册欠账 ' + debt.length + ' 条（封闭，只减不增；`--fact-list` 现场取逐条 why / close）');

  return { problems, notes, facts: result };
}

/* ---------------- 第七类扫描：验证链「总预算」的手写数字 ----------------
 * 为什么需要（实测，`.review/20261020-声明对齐/`）：`SKILL.md` 曾写「总预算 700s」，
 * 而真值 `verifyChain.TOTAL_BUDGET_MS` = 1770000 ⇒ **1770s** —— **差 2.5 倍、涨了四轮没人发现**；
 * 同一批还发现 `docs/ARCHITECTURE.md` 的同一句也写着 700s（上一批只改了第一屏，漏了这一处）。
 * 它是「易腐数字」里**唯一没有判据**的那一类：命令数 / 工具数 / 用例数 / 断言数 / 体量 / 未来版本号 /
 * 步骤数都已各有判定，**预算数字什么门禁都没有**。⇒ 补的正是这半张网。
 *
 * 判据（照第二类 `findSizeClaim` 的形状：纯函数 + 逐行命中 + 历史锚；**不是**新写一套口径）：
 *   · 扫描面 = `trackedFiles()`（与 `scan()` / `scanSizeClaims()` 同一条口径：`CHANGELOG.md` /
 *     `docs/archive/` / `docs/changelog/` 是历史区，不参与"当前事实"的判定）；
 *   · 命中形状 = **数字与「总预算 / 合计预算」相距 ≤ 8 字**，单位认 `s / 秒 / ms / 毫秒 / min / 分钟`，
 *     **两个方向都认**（「总预算 1770s」与「1770 秒总预算」人类都会写）；归一化成秒后比；
 *   · **判红** = 值 ≠ 真值、且该行**没有历史锚**。⚠️ **带指针也判红** —— "指向对了但数字还留着"
 *     本身就是自相矛盾，而且这一档**最会腐**（读者看见"既然指过去了应该没问题"就不会去核）。
 *     这一条与 `FACT_OUTLET`（第六类）**刻意不同**：那一类的真值**算不出来**，只能要求"只留一处手抄"；
 *     本类的真值**现算得出**（`TOTAL_BUDGET_MS`），所以按"比值"判 —— 与 `scan()` 对命令数/工具数同一条纪律；
 *   · **放行**：① 值 == 真值；② 同行有历史锚（`当时` / `快照` / `原记` / `曾` / `vX.Y.Z`）——
 *     那是"当时是多少"，不是对现状的声明（实测例子：`SKILL.md` 记"这里曾写「总预算 700s」"）。
 *
 * 刻意**不做**（边界，如实标注；别把"没查"读成"查过了没问题"）：
 *   · **只认「总预算 / 合计预算」**，不认**单项**预算 —— `docs/VERIFY.md` 表里 G5 那一格的 `1300s`
 *     是 `STEPS` 里那一步的**止涨线**，与 `TOTAL_BUDGET_MS` 不是同一件事，混扫就是**假红**；
 *     （单项预算的真值同样是 `scripts/verify.js` 的 `STEPS[].budgetMs`，但它要能把"这一行在说哪一步"
 *     认出来 —— 那是语义判断，本类不做。）
 *   · 认不出"这句话里的预算是不是指验证链"：`docs/AI-GUIDE.md` 的「重试预算太小」这类**别的**预算
 *     只要不写数字就不会命中；真写了数字又没锚，会被判红 —— 那时要么加锚要么改写（见报文指路）。
 *   · 它判不了"`TOTAL_BUDGET_MS` 这个真值本身该不该改"—— 那是 `docs/RULES.md` §3 `R6`（先量成本）。
 */
const RE_BUDGET_SEC = [
  // 「总预算 1770s」/「合计预算 1770 秒」
  new RegExp(NB2 + '(?:总|合计)预算[^\\d\\n]{0,8}(\\d+(?:\\.\\d+)?)\\s*(ms|毫秒|min|分钟|s|秒)', 'g'),
  // 「1770s 总预算」（反向写法）
  new RegExp(NB2 + '(\\d+(?:\\.\\d+)?)\\s*(ms|毫秒|min|分钟|s|秒)[^\\n]{0,4}(?:总|合计)预算', 'g')
];

/** 「这一行已经明确标成历史」的锚 —— 与 `SIZE_ANCHOR` 同一套词（`当时`/`快照`/`原记`/`曾`/`vX.Y.Z`），
 *  另加 `docs/RULES.md` §4「真值出口唯一」行里点名的历史标记口径。**不许为变绿放宽**（`B5`）。 */
const BUDGET_ANCHOR = /(当时|快照|原记|曾|v\d+\.\d+\.\d+)/;

/** 把「数字 + 单位」归一化成**秒**（纯函数） */
function budgetSecs(num, unit) {
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  if (unit === 'ms' || unit === '毫秒') return n / 1000;
  if (unit === 'min' || unit === '分钟') return n * 60;
  return n;
}

/** 从**一行**里取「总预算」读数的秒数（纯函数，导出给单测；一行可能有多处，全取） */
function budgetReadingsInLine(line) {
  const s = String(line === undefined || line === null ? '' : line);
  const out = [];
  RE_BUDGET_SEC.forEach((re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const v = budgetSecs(m[1], m[2]);
      if (v !== null) out.push(v);
    }
  });
  return out;
}

/** 判一行的三态：`history`（历史锚，放行）/ `pass`（值就是真值）/ `red`（值不对且无锚）。
 *  纯函数，`wantSec` = `verifyChain.TOTAL_BUDGET_MS / 1000`。 */
function budgetVerdict(secs, historical, wantSec) {
  if (historical) return 'history';
  const want = Number(wantSec);
  if (!Number.isFinite(want)) return 'red';
  return secs.every((v) => Math.abs(v - want) < 1e-9) ? 'pass' : 'red';
}

/** 扫描**一段文本**里的「总预算」手写数字（**纯函数**：不读盘、不打印 —— 便于单测与判别力证明）。
 *  @param {string} text 待扫文本
 *  @param {number} [wantSec] 真值秒数（默认 `verifyChain.TOTAL_BUDGET_MS / 1000`）
 *  @param {string} [rel] 报告里显示的文件名
 *  @returns {{rel:string, line:number, secs:number[], verdict:string, text:string}[]}
 *  标题行与非「总预算」行直接跳过（与 `parseClaims` / `scanSizeClaims` 同口径）。
 */
function scanBudgetText(text, wantSec, rel) {
  const want = Number(wantSec === undefined || wantSec === null ? verifyChain.TOTAL_BUDGET_MS / 1000 : wantSec);
  const out = [];
  String(text === undefined || text === null ? '' : text).split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#{1,6}\s/.test(line)) return;              // 标题行：章节号不是预算声明
    const secs = budgetReadingsInLine(line);
    if (!secs.length) return;
    out.push({
      rel: rel || '(文本)', line: i + 1, secs,
      verdict: budgetVerdict(secs, BUDGET_ANCHOR.test(line), want),
      text: line.trim()
    });
  });
  return out;
}

/** 在**全部受管文档**上跑第七类，返回 `{wantSec, hits, reds, history}`。 */
function scanBudgetClaims(wantSec) {
  const want = Number(wantSec === undefined || wantSec === null ? verifyChain.TOTAL_BUDGET_MS / 1000 : wantSec);
  const hits = [];
  for (const file of trackedFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    hits.push(...scanBudgetText(fs.readFileSync(file, 'utf8'), want, rel));
  }
  return {
    wantSec: want, hits,
    reds: hits.filter((h) => h.verdict === 'red'),
    history: hits.filter((h) => h.verdict === 'history')
  };
}

/* ---------------- 报告型读数：`%TEMP%/mm-*` 残留（**恒 exit 0，不判红**） ----------------
 * 为什么要它（实测，`.review/20261020-声明对齐/`）：`%TEMP%/mm-*` 积到 **141 个 / 190.9 MB**，
 * 最老的来自**一个月前**；分类后 **168.7 MB 是 `.review/` 里的**一次性探针脚本**造的
 * （`scripts/cli-integration.js` 有自己的 `sweepOwnTempRoots`，那部分确实清了）。
 * ⇒ 「`.review/` 可整目录删除」这条规矩**清不掉工作区外的副作用**（`docs/RULES.md` §4 因此单列一行）。
 *
 * ⚠️ **为什么只报告、不做判红**（M1：误报率高的门禁比没有更坏 —— 假红的结局是被无视）：
 *   ① **主人判不了**：从进程外看，`mm-*` 目录里没有任何"谁造的"标记（没有落盘的所有者信息）；
 *   ② **"此刻在用"和"该清的残留"在文件系统上长得一模一样**：并行的会话 / 正在跑的测试这一刻就有一个
 *      `mm-*` 目录，它的 mtime 与"刚泄漏"没有区别 ⇒ 任何按数量/体量判红的阈值都会在"正好在跑测试"时误红
 *      （本工程已定过 R7：全链必须独占跑，正因为"有没有别人在用"从文件内容里看不见）；
 *   ③ **前缀没有强制力**：`mm-` 只是 `tests/_tmp-cleanup.js` 的**约定**，别的工具/别的 checkout 也能叫这个名字；
 *   ④ **阈值说不出道理**：跑一次全量单测就会瞬时造出几十个 `mm-*`，"超过 N 个就红"的 N 没有可辩护的来源。
 *   ⇒ 只做**报告**（数量 / 体量 / 最老年龄 / 最老与最大的若干条 / 按前缀分组），**恒 exit 0**；
 *      清理的唯一可靠办法仍是**源头**：脚本自己在 `finally` 里删（`tests/_tmp-cleanup.js` 的 `makeTmp`/`cleanupAll`）。
 *      报告型读数照 `R1c`：**打印档不是判据**，别把它当门禁。
 */
const TEMP_REPORT_PREFIX = 'mm-';
const TEMP_REPORT_OLD_MS = 24 * 60 * 60 * 1000;    // 超过 24 小时 ⇒ 几乎不可能是"此刻在跑"
const TEMP_REPORT_ENTRY_CAP = 5000;                // 单目录最多数这么多条目（防病态目录把读数卡死）

/** 递归算一个目录的体量（**有上限**：条目数超 `TEMP_REPORT_ENTRY_CAP` 就停，返回值里标 truncated） */
function dirFootprint(abs, cap) {
  const limit = cap || TEMP_REPORT_ENTRY_CAP;
  let bytes = 0;
  let files = 0;
  let seen = 0;
  let truncated = false;
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (seen >= limit) { truncated = true; return; }
      seen += 1;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch (err) { /* 读不到就算 0，报告型不追求精确 */ }
      }
    }
  })(abs);
  return { bytes, files, truncated };
}

/** 扫 `%TEMP%` 下形如 `mm-*` 的目录，返回读数（**纯报告**：不删、不判红、不抛）。
 *  @param {{root?:string, now?:number, prefix?:string, cap?:number}} [opts] 仅单测用
 */
function tempResidueReport(opts) {
  const o = opts || {};
  const os = require('os');
  const root = o.root || os.tmpdir();
  const prefix = o.prefix === undefined ? TEMP_REPORT_PREFIX : o.prefix;
  const cap = o.cap || TEMP_REPORT_ENTRY_CAP;
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const entries = [];
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    return { root, error: (e && e.message) || String(e), entries, totalCount: 0, totalBytes: 0,
      oldCount: 0, oldBytes: 0, byPrefix: [] };
  }
  for (const e of names) {
    if (!e.name.startsWith(prefix)) continue;
    const abs = path.join(root, e.name);
    let st = null;
    try { st = fs.statSync(abs); } catch (err) { continue; }
    const fp = e.isDirectory() ? dirFootprint(abs, cap) : { bytes: st.size, files: 1, truncated: false };
    // 家族 = 前缀到第二个 `-` 为止（`mm-control-test-xxx` ⇒ `mm-control-test-`），用于"按 prefix 分组"
    const seg = e.name.split('-');
    const family = seg.length >= 2 ? seg.slice(0, 2).join('-') + '-' : prefix;
    entries.push({ name: e.name, path: abs, isDir: e.isDirectory(), mtimeMs: st.mtimeMs,
      ageMs: now - st.mtimeMs, bytes: fp.bytes, files: fp.files, truncated: fp.truncated, family });
  }
  const byFamily = new Map();
  for (const it of entries) {
    const r = byFamily.get(it.family) || { family: it.family, count: 0, bytes: 0 };
    r.count += 1;
    r.bytes += it.bytes;
    byFamily.set(it.family, r);
  }
  const old = entries.filter((it) => it.ageMs >= TEMP_REPORT_OLD_MS);
  return {
    root, error: null, entries,
    totalCount: entries.length,
    totalBytes: entries.reduce((a, it) => a + it.bytes, 0),
    oldCount: old.length,
    oldBytes: old.reduce((a, it) => a + it.bytes, 0),
    byPrefix: Array.from(byFamily.values()).sort((a, b) => b.bytes - a.bytes)
  };
}

/** 人类可读的体量 */
function fmtBytes(n) {
  const mb = Number(n) / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' MB' : (Number(n) / 1024).toFixed(1) + ' KB';
}

/** 打印 `%TEMP%/mm-*` 读数（**只打印**，不判红、不改退出码） */
function printTempResidue(r) {
  console.log('== `%TEMP%/mm-*` 残留读数（**报告型，恒 exit 0** —— 谁造的从进程外判不了，故不判红）==');
  if (r.error) {
    console.log('  读不到临时目录 ' + r.root + '：' + r.error + '（这不影响任何门禁结论）');
    return;
  }
  console.log('  扫描根：' + r.root + '   前缀：`' + TEMP_REPORT_PREFIX + '*`（约定，不是强制命名空间）');
  if (!r.totalCount) {
    console.log('  ✓ 0 个 —— 当前没有任何 `' + TEMP_REPORT_PREFIX + '*` 残留');
    return;
  }
  console.log('  合计 ' + r.totalCount + ' 个 · ' + fmtBytes(r.totalBytes)
    + ' ｜ 超过 24 小时的 ' + r.oldCount + ' 个 · ' + fmtBytes(r.oldBytes));
  // 目录 vs 单一文件**分开打印**：实测（2026-10-20 两次读数）累计下来的是**自由命名的文件**
  // （`mm-*.md` / `.diff` / `.tar` / `.json`）而不是 mkdtemp 出来的目录 —— 目录那部分
  // 由 `tests/_tmp-cleanup.js` 与 `cli-integration.js` 的 `sweepOwnTempRoots` 收着。
  // 这个拆分直接决定"要不要做门禁"：文件的主人**无从判定**（谁写的都没有标记），
  // 而目录至少有"谁 mkdtemp 的"这条约定可依。
  const dirs = r.entries.filter((it) => it.isDir);
  const plain = r.entries.filter((it) => !it.isDir);
  console.log('     其中目录 ' + dirs.length + ' 个 · ' + fmtBytes(dirs.reduce((a, it) => a + it.bytes, 0))
    + ' ｜ 单一文件 ' + plain.length + ' 个 · ' + fmtBytes(plain.reduce((a, it) => a + it.bytes, 0))
    + ' ｜ 超过 24 小时的目录 ' + dirs.filter((it) => it.ageMs >= TEMP_REPORT_OLD_MS).length + ' 个');
  if (r.byPrefix.length) {
    console.log('  按前缀分组（体量降序）：'
      + r.byPrefix.slice(0, 8).map((g) => g.family + '*：' + g.count + ' 个 / ' + fmtBytes(g.bytes)).join(' · '));
  }
  const show = r.entries.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  console.log('  最大的 10 个：');
  for (const it of show) {
    console.log('    ' + fmtBytes(it.bytes) + '  ' + Math.round(it.ageMs / 3600000) + ' 小时前  '
      + it.files + ' 个文件' + (it.truncated ? '（条目数到上限，体量是下限）' : '') + '  ' + it.name);
  }
  const oldest = r.entries.slice().sort((a, b) => b.ageMs - a.ageMs).slice(0, 5);
  console.log('  最老的 5 个：');
  for (const it of oldest) {
    console.log('    ' + Math.round(it.ageMs / 3600000) + ' 小时前  ' + fmtBytes(it.bytes) + '  ' + it.name);
  }
  console.log('  → 处置：**别按名字删**（可能正在被别的会话/正在跑的测试使用）。'
    + '可靠办法只有源头 —— 脚本自己在 `finally` 里删（`tests/_tmp-cleanup.js` 的 `makeTmp`/`cleanupAll`）。');
  console.log('  → 边界：`mm-` 只是约定前缀；别的工具/别的 checkout 也可能造同名目录；'
    + '本条因此**只报告**，不做判红（理由见 `doc-facts.js` 里 `TEMP_REPORT_PREFIX` 上方注释）。');
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
  // `--fact-list`：打印「真值出口」事实表与封闭欠账册（**只看不判**，恒 exit 0 —— 打印档不是判据，
  // 见 `R1c`）。与 `--check` 分开是为了让"这条判据到底认哪些事实"永远可当场取到，而不是去读源码。
  if (args.includes('--fact-list')) {
    console.log('== 真值出口（FACT_OUTLET）事实表 —— 唯一权威 = scripts/doc-facts.js 的 FACT_OUTLETS ==');
    FACT_OUTLETS.forEach((f) => {
      console.log('  · ' + f.id + '（' + f.label + '）出口 = ' + f.outlet
        + (f.needQualifier ? '  [口径类：命中必须带口径或历史锚]' : ''));
      console.log('      why：' + f.why);
    });
    console.log('');
    console.log('== 封闭欠账册（' + FACT_OUTLET_DEBT.length + ' 条；只减不增）==');
    if (!FACT_OUTLET_DEBT.length) console.log('  （空册）');
    FACT_OUTLET_DEBT.forEach((d) => {
      console.log('  · ' + d.rel + ' · ' + d.fact + ' = ' + d.value);
      console.log('      why  ：' + d.why);
      console.log('      close：' + d.close);
    });
    return;
  }
  // `--temp-report`：`%TEMP%/mm-*` 残留的**报告型**读数（**恒 exit 0** —— 打印档不是判据，见 `R1c`；
  // 为什么只报告、不做判红：理由逐条写在 `TEMP_REPORT_PREFIX` 上方那段注释里，别在这里再写一遍）。
  // 必须放在 `facts()` **之前**：`facts()` 会真跑一遍 vitest（几十秒），而看残留读数没有这个必要。
  if (args.includes('--temp-report')) {
    printTempResidue(tempResidueReport());
    return;
  }
  // `--fact-root=<dir>`：**只把第六类扫描（真值出口）的扫描根**指向别处（判别力证明 / 单测用）；
  // 不给就是真仓，`--check` 的其余五类读数与从前逐字节相同（H3：新能力走 opt-in）。
  const factRootArg = (args.find((a) => a.startsWith('--fact-root=')) || '').slice(12);
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

  // 第六类：真值出口唯一（`FACT_OUTLET`，缺口 `G-09`）—— 补的是前五类都不管的另一半：
  // 前五类比"值对不对"，这一类比"**同一事实有没有第二个手抄副本**"。
  const outlet = scanFactOutlets(factRootArg ? path.resolve(factRootArg) : ROOT);
  outlet.notes.forEach((n) => console.log(n));
  if (outlet.problems.length) {
    console.log('✗ 真值出口不唯一（' + outlet.problems.length + ' 处）：');
    outlet.problems.forEach((p) => console.log('   ' + p.msg));
    console.log('   → 事实表与在册欠账册：`node scripts/doc-facts.js --fact-list`；'
      + '规则边界见 `docs/RULES.md` §3 `R5` 与 §4「真值出口」那两行。');
    bad = true;
  } else {
    console.log('✓ 真值出口唯一：每条被声明的事实都只有一个手抄副本以外的表述（其余是指针或历史锚）');
  }

  // 第七类：验证链「总预算」的手写数字（`TOTAL_BUDGET_MS` 是唯一真值）——
  // 这一类的**判据与边界**见 `scanBudgetText()` 上方那一大段注释（含"带指针也判红"的理由）。
  const bud = scanBudgetClaims();
  if (bud.reds.length) {
    console.log('✗ 验证链「总预算」的手写数字与 `scripts/verify.js` 的 `TOTAL_BUDGET_MS` 不符（'
      + bud.reds.length + ' 处）：');
    bud.reds.forEach((h) => console.log('   ' + h.rel + ':' + h.line + '  写的是 ' + h.secs.join(' / ') + ' s，应为 '
      + bud.wantSec + ' s（差 ' + (Math.max(...h.secs) / bud.wantSec).toFixed(2) + ' 倍）'
      + '\n      ' + h.text.slice(0, 110)));
    console.log('   → 二选一：**别抄这个数**（写成「总预算以 `scripts/verify.js` 的 `TOTAL_BUDGET_MS` 为准」），'
      + '或改成真值 ' + bud.wantSec + ' s。\n'
      + '     ⚠️ 同一行**既有指针又有旧数字**也判红 —— 那是最会腐的一档（读者见"指过去了"就不去核）。');
    bad = true;
  } else {
    console.log('✓ 验证链「总预算」：受管文档里 ' + bud.hits.length + ' 处提到总预算，'
      + '其中手抄 ' + bud.hits.filter((h) => h.verdict === 'pass').length + ' 处（都等于真值 ' + bud.wantSec + ' s）'
      + ' · 历史锚 ' + bud.history.length + ' 处（`当时`/`快照`/`曾`/`vX.Y.Z` —— 那是历史现场，不是现状声明）');
    for (const h of bud.history) {
      console.log('   · ' + h.rel + ':' + h.line + ' 历史锚放行（读到 ' + h.secs.join(' / ')
        + ' s ≠ 真值 ' + bud.wantSec + ' s，但该行写明是"当时/曾"）');
    }
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
  parseStepCountClaims, scanStepCount, stepCountProblem,
  // 第六类：真值出口唯一（`FACT_OUTLET` / 缺口 `G-09`）—— 事实表与欠账册**只有这里一份**
  FACT_OUTLETS, FACT_OUTLET_DEBT, FACT_POINTER, factReadingsInLine, scanFactOutlets,
  // 第七类：验证链「总预算」的手写数字（真值 = `verifyChain.TOTAL_BUDGET_MS`；纯函数单独导出便于单测）
  budgetReadingsInLine, budgetVerdict, scanBudgetText, scanBudgetClaims, BUDGET_ANCHOR,
  // 报告型读数（**不判红**）：`%TEMP%/mm-*` 残留 —— 谁造的判不了，故只有打印（`--temp-report`）
  tempResidueReport, printTempResidue, TEMP_REPORT_PREFIX, TEMP_REPORT_OLD_MS
};
