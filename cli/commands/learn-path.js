/* ============================================================
 * cli/commands/learn-path.js — `learn-path <项目…>`（产品代号 **LP**，学习链路）
 * ------------------------------------------------------------
 * 一句话：**若干本已入库的书 ⇒ 一条有序的学习链路 ⇒ 落成一个新项目**。
 * 判定与排序**全部**在 `src/learn-path.js`（纯逻辑、零 I/O，见那里的文件头）；
 * 本文件只做四件事：**读参数 → 读盘（并给输入拍快照）→ 调它 → 落盘/回显**。
 *
 * ## 为什么这条命令**必须**是"新项目"，而不是往书里加点东西
 * 判据"生成前后对原书逐字节相同"是硬要求（设计 §4 判据 4）⇒ 产物不能落在输入里。
 * 于是这里有一条纪律：**输入项目一律只读**，本文件里没有任何一处对输入调 `store.write` /
 * `ctx.mutate`；读完之后还会**再算一次**输入的 sha256 与读之前对拍（`sourceIntegrity`），
 * 把"我没写"从承诺变成读数。
 *
 * ## 产物为什么"零新增字段"
 * 步骤节点的顺序由 `children` 数组顺序表达（`docs/DATA-FORMAT.md` §2.1 —— 数据里**唯一**
 * 有序的表达），出处由既有跨项目 `links[]` 指回原书节点（§2.5），依据写在 `detail`（§2.4）
 * 与 `links[].caption` 里。⇒ `src/schema.js` 一个字不用改、`meta.formatVersion` 不升。
 *
 * ## `--dry-run` 走**中央短路**（`cli/core.js` 的 `DRY_RUN_COMMANDS`）
 * 本文件里**没有**任何 `if (dryRun)` 分支（`tests/w8-dry-run.test.js` 静态把守这一点）：
 * 计划与真跑用的是**同一份**数据 + 同一份写盘前校验 ⇒ 预览说能成，真跑必能成。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const lp = require('../../src/learn-path.js');
const MMConfig = require('../../src/config.js');

/** 文本档默认显示多少步（全量走 `--json`；545 步全打到终端没人读） */
const TEXT_STEPS = 20;

/** `links[].caption` 的上限（截断只为可读；**截断会带省略号**，不冒充原文） */
const CAPTION_MAX = 200;

/** 步骤节点的 id 前缀与位宽（`lp-0001`；确定性 ⇒ 判据 1） */
const STEP_ID_PREFIX = 'lp-';
const STEP_ID_WIDTH = 4;

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sha256Of(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** 项目 JSON 的绝对路径（推路径只有这一处；与 `store.read` 读的是同一份文件） */
function projectFileOf(ctx, name) {
  return path.join(ctx.PROJECTS_DIR, name, name + '.json');
}

/**
 * 给一份项目文件拍快照（**判据 4 的量具**）：字节数 + sha256。
 * 读不到 ⇒ 如实记 `missing`（不把"读不到"当成"没变"）。
 */
function snapshotOf(ctx, name) {
  const file = projectFileOf(ctx, name);
  try {
    const buf = fs.readFileSync(file);
    return { project: name, file: file, sha256: sha256Of(buf), bytes: buf.length };
  } catch (e) {
    return { project: name, file: file, sha256: null, bytes: null, error: (e && e.message) || String(e) };
  }
}

/** 逐字节对拍两份快照（**判据 4 的读数**，唯一一处） */
function integrityOf(before, after) {
  const files = before.map(function (b, i) {
    const a = after[i] || {};
    return {
      project: b.project,
      sha256Before: b.sha256, sha256After: a.sha256,
      bytesBefore: b.bytes, bytesAfter: a.bytes,
      unchanged: b.sha256 !== null && b.sha256 === a.sha256 && b.bytes === a.bytes
    };
  });
  return { unchanged: files.every(function (f) { return f.unchanged; }), files: files };
}

/** `<--out>` 的缺省名（确定性；不含时钟） */
function defaultOutName(bookNames) {
  return '学习链路-' + bookNames.length + '书';
}

/**
 * 行内 Markdown ⇒ HTML（**唯一**实现处）：先转义，再把成对 `**…**` 转成 `<strong>`、
 * 成对 `` `…` `` 转成 `<code>`。
 *
 * 为什么需要它：`detail` 是 **HTML**（渲染层 `dc.innerHTML = detail` ⇒ 星号会原样显示），而
 * `why.text` 是人话、由 `src/learn-path.js` 产出、**自带行内 `**` 强调**（`**这是机械序，不是学出来的顺序**`）。
 * 直接拼进 detail ⇒ 界面上显示成星号，且 `collateral-check`（S2）的 `NOTE_RESIDUE` 判红
 * （本次实测：`学习链路-7书` 里 **25 个**节点 = 12 个 term-affinity + 13 个 mechanical，正好对上）。
 *
 * 为什么在**这一侧**转：`src/learn-path.js` 的 `why.text` 是"给人读的原文"，它的 `**` 不是数据形状问题，
 * 不该为了渲染去改 `src/`（同一份 text 还要进 `--json`）；**呈现层**负责把它变成 HTML。
 *
 * 为什么只认这两种定界符：它们的**误判面最小**（单星 `*斜体*` 与 `2*a*b` 同形、`__x__` 与 `__init__` 同形，
 * S2 自己也只把它们放在"只报告"档）；这里不做通用 Markdown 渲染器。
 */
function mdInline(s) {
  return esc(s)
    .replace(/\*\*(?=\S)([^\n]*?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!`)`(?!`)(?=\S)([^\n]*?)(?<=\S)`(?!`)/g, '<code>$1</code>');
}

/** 把一步渲染成节点 `detail`（人读 + 一行机器可读的 `lp-why:`）
 *  ⚠️ 本函数里**一律用真 HTML 标签**（`<strong>` / `<code>`），不写 `**` 也不写反引号 ——
 *  否则星号会原样显示在界面上（S2 判红）；动态文本（`why.text` 等）走 `mdInline()`。 */
function detailOfStep(step) {
  const w = step.why || {};
  const ev = w.evidence || {};
  const li = [];
  li.push('<li><strong>排在这的依据</strong>：' + mdInline(w.text || '') + '</li>');
  li.push('<li><strong>依据类型</strong>：' + mdInline(w.kind || '') + '（置信档 ' + mdInline(w.confidence || '') + '）</li>');
  li.push('<li><strong>来自</strong>：' + mdInline(step.project) + ' › ' + mdInline(step.chapter || '（顶层主题）')
    + ' › 第 ' + String(step.spineIndex + 1) + ' 个单元（本书）</li>');
  if (ev.sharedTerms && ev.sharedTerms.length) {
    li.push('<li><strong>与上一步共享的术语</strong>：' + mdInline(ev.sharedTerms.join('、')) + '</li>');
  }
  if (ev.prereqs && ev.prereqs.length) {
    li.push('<li><strong>已满足的显式前置</strong>：'
      + mdInline(ev.prereqs.map(function (p) { return p.from.replace('\u0000', '/'); }).join('、')) + '</li>');
  }
  li.push('<li><strong>机器可读</strong>：<code>' + esc(lp.whyTokenOf(w)) + '</code></li>');
  return '<ul>' + li.join('') + '</ul>';
}

/** 根节点 `detail`：把生成参数与三条读数写成封面（**人读**；机读走 `--json`）
 *  ⚠️ 同 `detailOfStep`：强调一律写真 HTML（`<strong>`），不写 `**`。 */
function detailOfRoot(report, opts) {
  const o = opts || {};
  const li = [];
  li.push('<li><strong>这条链路是怎么来的</strong>：<code>' + esc(o.commandLine || '') + '</code></li>');
  li.push('<li><strong>书序（T4 兜底序）</strong>：'
    + report.books.map(function (b, i) { return (i + 1) + '. ' + mdInline(b.project) + '（' + b.units + ' 个单元）'; }).join('；')
    + '</li>');
  li.push('<li><strong>步数</strong>：' + report.steps.length
    + (report.truncated ? '（<strong>被 --limit 截断</strong>，不是全部）' : '') + '</li>');
  li.push('<li><strong>图的读数</strong>：单元 ' + report.graph.nodes + ' 个、边 ' + report.graph.edges
    + ' 条（书内骨架 ' + report.graph.spineEdges + '、显式前置 ' + report.graph.explicitEdges.length
    + '、未解析 ' + report.graph.unresolvedEdges.length + '）｜拓扑可排序：'
    + (report.graph.acyclic ? '是（无环）' : '<strong>否</strong>') + '</li>');
  li.push('<li><strong>每一步的依据类型分布</strong>：' + mdInline(JSON.stringify(countWhy(report.steps))) + '</li>');
  li.push('<li><strong>前置未覆盖（跳级）</strong>：' + report.gaps.count + ' 条'
    + (report.gaps.count ? '（' + mdInline(JSON.stringify(report.gaps.byKind)) + '）' : '') + '</li>');
  li.push('<li><strong>AI 预算</strong>：本版<strong>一次也不调模型</strong> —— 调用 ' + report.ai.calls
    + ' 次 / 上界 ' + report.ai.maxCalls + ' 次（单位 = ' + mdInline(report.ai.unit) + '）</li>');
  li.push('<li><strong>依据类型的含义</strong>：chapter-order = 本书内章序（权威）；'
    + 'explicit-prereq = 人工标注的显式前置（权威）；term-affinity = 术语共现导航（<strong>弱</strong>，不宣布前置）；'
    + 'mechanical = 确定性兜底序（<strong>机械序</strong>，不是学出来的顺序）</li>');
  return '<ul>' + li.join('') + '</ul>';
}

function countWhy(steps) {
  const out = {};
  lp.WHY_KIND_NAMES.forEach(function (k) { out[k] = 0; });
  (steps || []).forEach(function (s) { out[s.why.kind] = (out[s.why.kind] || 0) + 1; });
  return out;
}

/**
 * `learn-path <项目…> [--out <新项目名>] [--order 项目,…] [--limit n] [--title 标题] [--force] [--json] [--dry-run]`
 *
 * `--order` 明说"哪本书先"：它只影响**同分时的优先**（T4 兜底序），**不覆盖**书内章序与显式前置
 * —— 那两条是权威档（设计 §3.7）。名单里的项目不在输入里 ⇒ **响亮拒绝**（不静默忽略）。
 */
function learnPath(ctx) {
  const books = ctx.args._.filter(function (x) { return typeof x === 'string' && x.trim(); }).map(String);
  if (!books.length) {
    ctx.error('用法: node cli/mm-cli.js learn-path <项目…> [--out <新项目名>] [--order 项目,…] '
      + '[--limit n] [--title 标题] [--force] [--json] [--dry-run]\n'
      + '例：node cli/mm-cli.js learn-path book-linux-net book-linux-proc-mem --out 学习链路-2书');
  }
  const dup = books.filter(function (b, i) { return books.indexOf(b) !== i; });
  if (dup.length) ctx.error('项目重复给了：' + dup.join('、') + '（每个项目只能出现一次）');

  // ---- `--order` ------------------------------------------------------------------
  let order = [];
  if (ctx.args.order !== undefined) {
    if (ctx.args.order === true) ctx.error('--order 需要一个项目名清单（如 --order book-a,book-b）');
    order = String(ctx.args.order).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!order.length) ctx.error('--order 的清单是空的');
    const unknown = order.filter(function (n) { return books.indexOf(n) < 0; });
    if (unknown.length) {
      ctx.error('--order 里的项目不在本次输入里：' + unknown.join('、')
        + '（书序只能排本次选中的书；本次输入：' + books.join('、') + '）');
    }
    const dupOrder = order.filter(function (n, i) { return order.indexOf(n) !== i; });
    if (dupOrder.length) ctx.error('--order 里同一个项目给了两次：' + dupOrder.join('、'));
  }

  // ---- `--out` / 产物项目名的闸门（**在写盘之前**）------------------------------------
  const out = (ctx.args.out === undefined || ctx.args.out === true)
    ? defaultOutName(books) : String(ctx.args.out).trim();
  if (!out) ctx.error('--out 的名字不能为空');
  if (/[\\/:*?"<>|]/.test(out)) ctx.error('--out 的名字不能含 \\ / : * ? " < > | —— ' + JSON.stringify(out));
  if (books.indexOf(out) >= 0) {
    ctx.error('--out 不能与输入项目同名（' + out + '）—— 产物必须是新项目，否则就改了原书');
  }
  const outFile = projectFileOf(ctx, out);
  const outExists = fs.existsSync(outFile);
  if (outExists && !ctx.args.force) {
    ctx.error('产物项目已存在: ' + out + '（' + outFile + '）。'
      + '换个名字（--out <新名字>），或者确认要覆盖就加 --force'
      + '（覆盖 = 用这次的结果整体替换它，旧内容不会留）');
  }

  // ---- 读盘（**输入只读**；读之前先拍快照）---------------------------------------------
  const before = books.map(function (b) { return snapshotOf(ctx, b); });
  const missing = before.filter(function (s) { return s.sha256 === null; });
  if (missing.length) {
    ctx.error('项目读不了：' + missing.map(function (m) { return m.project + '（' + m.error + '）'; }).join('；'));
  }
  const projects = books.map(function (name) {
    const r = ctx.store.read(name);
    const raw = fs.readFileSync(projectFileOf(ctx, name), 'utf8');
    return {
      name: name,
      // meta.name 只用于**显示**（书名）；项目目录名才是唯一键（照 `merge-project` 的口径）
      data: r.data,
      bytes: Buffer.byteLength(raw, 'utf8')
    };
  });

  // ---- 判定与排序（**全部**在 src/learn-path.js）--------------------------------------
  const limit = ctx.args.limit === undefined ? undefined : ctx.intOption('limit', { min: 1 });
  const report = lp.planPath(projects, { order: order, limit: limit });
  if (!report.ok) ctx.error(report.message);

  // ---- 落盘数据（**一次 ctx.write** ⇒ 一次原子写；dry-run 由中央短路）-------------------
  const stepNodes = report.steps.map(function (s, i) {
    const id = STEP_ID_PREFIX + String(i + 1).padStart(STEP_ID_WIDTH, '0');
    return {
      id: id,
      topic: stepTopicOf(report, s, i),      // 显示名的**唯一**拼装处（含两处去重/脱壳，见函数头）
      expanded: false,                       // 新节点默认折叠（`add` 的同一条口径）
      detail: detailOfStep(s),
      links: [{ project: s.project, id: s.nodeId, caption: captionOfStep(s) }]
    };
  });
  const rootDetail = detailOfRoot(report, {
    commandLine: 'learn-path ' + books.join(' ') + (ctx.args.order ? ' --order ' + order.join(',') : '')
      + ' --out ' + out + (limit === undefined ? '' : ' --limit ' + limit)
  });
  const data = {
    meta: {
      // 版本号单源：src/config.js 的 APP_VERSION
      name: (ctx.args.title === undefined || ctx.args.title === true)
        ? ('学习链路：' + books.length + ' 本书 / ' + report.steps.length + ' 步')
        : String(ctx.args.title),
      author: '',
      version: MMConfig.APP_VERSION,
      formatVersion: 2
    },
    format: 'node_tree',
    data: {
      id: 'root',
      topic: '学习链路：' + books.length + ' 本书 / ' + report.steps.length + ' 步',
      expanded: true,
      detail: rootDetail,
      children: stepNodes
    }
  };

  // 写盘作用域切到产物项目（`ctx.write` / dry-run 的计划都按 `projectName` 算）
  ctx.useProject(out);
  if (outExists && ctx.args.force) ctx.read();     // 覆盖：先把版本指纹读进来（并发闸门要它）
  ctx.write(data);

  // ---- 判据 4：**写完再拍一次快照**，逐字节对拍 --------------------------------------
  const after = books.map(function (b) { return snapshotOf(ctx, b); });
  const integrity = integrityOf(before, after);
  if (!integrity.unchanged) {
    // 走到这里说明真书被改了 —— 这不是"警告"，是本功能最重的红线，必须响亮失败
    const bad = integrity.files.filter(function (f) { return !f.unchanged; })
      .map(function (f) { return f.project + '（' + f.sha256Before + ' → ' + f.sha256After + '）'; });
    ctx.error('输入的书籍项目被改动了（判据 4 破）：' + bad.join('、')
      + ' —— 产物必须落在新项目里，输入一个字节都不该动。请先查这个批次的写入路径');
  }

  if (ctx.args.json) {
    ctx.outJson({
      ok: true,
      command: 'learn-path',
      out: out,
      outFile: outFile,
      overwritten: outExists && !!ctx.args.force,
      books: report.books,
      units: report.units,
      graph: {
        nodes: report.graph.nodes,
        edges: report.graph.edges,
        spineEdges: report.graph.spineEdges,
        explicitEdges: report.graph.explicitEdges,
        unresolvedEdges: report.graph.unresolvedEdges,
        cycles: report.graph.cycles,
        acyclic: report.graph.acyclic
      },
      steps: report.steps,
      stepCount: report.steps.length,
      truncated: report.truncated,
      gaps: report.gaps,
      ai: report.ai,
      sourceIntegrity: integrity,
      determinism: { canonical: report.determinism.canonical, sha256: sha256Of(Buffer.from(report.determinism.canonical, 'utf8')) },
      whyKinds: countWhy(report.steps),
      criteria: CRITERIA
    });
    return;
  }

  // ---- 文本档（只打读数 + 前 N 步；全量走 --json）-------------------------------------
  ctx.out('已生成学习链路: ' + out + '（' + report.steps.length + ' 步；新项目，输入逐字节未动 ✓）');
  ctx.out('  书序：' + report.books.map(function (b, i) { return (i + 1) + '. ' + b.project + '(' + b.units + ')'; }).join(' → '));
  ctx.out('  单元 ' + report.graph.nodes + ' 个 ｜ 边 ' + report.graph.edges + ' 条（书内骨架 '
    + report.graph.spineEdges + '、显式前置 ' + report.graph.explicitEdges.length + '、未解析 '
    + report.graph.unresolvedEdges.length + '）｜ 拓扑可排序：' + (report.graph.acyclic ? '是（无环）' : '否'));
  ctx.out('  依据类型分布：' + JSON.stringify(countWhy(report.steps)));
  ctx.out('  前置未覆盖（跳级）：' + report.gaps.count + ' 条'
    + (report.gaps.count ? '（' + JSON.stringify(report.gaps.byKind) + '）' : ''));
  ctx.out('  AI 预算：调用 ' + report.ai.calls + ' 次 / 上界 ' + report.ai.maxCalls + ' 次（' + report.ai.unit + '）');
  if (report.units.spineErrors) {
    ctx.out('  ⚠ 树序与章号/节号冲突 ' + report.units.spineErrors + ' 处（**排序仍按树序**，'
      + '冲突只如实报出，逐条见 --json 的 books[].spineErrors）');
  }
  ctx.out('');
  const show = Math.min(TEXT_STEPS, report.steps.length);
  ctx.out('前 ' + show + ' 步（全量 ' + report.steps.length + ' 步用 --json 取）：');
  report.steps.slice(0, show).forEach(function (s) {
    ctx.out('  ' + String(s.seq).padStart(3) + '. 【' + s.why.kind + '】' + s.project + ' › '
      + (s.chapter || '（顶层主题）') + ' › ' + s.topic);
    ctx.out('       ' + s.why.text);
  });
  if (report.steps.length > show) ctx.out('  …… 还有 ' + (report.steps.length - show) + ' 步（--json 取全部）');
  ctx.out('');
  ctx.out('产物：projects/' + out + '/' + out + '.json（步骤顺序 = children 顺序；每步 links 指回原书节点）');
  ctx.out('（AI 预算的单位与上界公式见 src/learn-path.js 的 AI_BUDGET；本版 PROGRAM_ONLY，一次也不调模型）');
}

/* ---------------------------------------------------------------------------
 * 显示名（节点 `topic` / `links[].caption`）的拼装
 * ---------------------------------------------------------------------------
 * 这一块只做**呈现**：`src/learn-path.js` 的 `chapter` / `topic` 两个字段一个都不动
 * （它们的区别在别处有用 —— 比如 `detail` 里的「来自：书 › 章 › 第 N 个单元」用的就是 `chapter`）。
 * 曾经的两处格式 bug（545/545 步全中，见 CHANGELOG 本批）都出在这里：
 *   ① 书名按"首尾字符"脱壳 ⇒ 书根 topic 是 `《书名》+ 后缀` 时，中间那个 `》` 删不掉（多一个 `》`）；
 *   ② 章节点自己也是学习单元 ⇒ 章名与步骤名是同一个字符串，拼出来重复两段。
 * ------------------------------------------------------------------------- */

/**
 * 书根 topic ⇒ **书名本身**：取开头那一对 `《…》` **里面**的字符；没有这样的开头就不动。
 *
 * 真数据（7 本全同形，已逐本 dump 核对）：
 *   `《802.11无线网络权威指南（第2版）》知识点大纲` ⇒ 书名 `802.11无线网络权威指南（第2版）`
 *   `《深入理解Linux网络》知识点大纲`               ⇒ 书名 `深入理解Linux网络`
 * 也就是说：书根 topic 的形状是「`《真书名》` + 后缀」，**后缀 `知识点大纲` 不是书名的组成部分**。
 *
 * 三个候选实现，为什么选"提取"：
 *   - 改前 `/^《|》$/g`（按首尾字符删）：只删开头 `《` 与**结尾** `》`，而这个串以「纲」结尾 ⇒
 *     中间那个 `》` 留着 ⇒ 拼出 `《…》知识点大纲》`（多一个 `》`，545/545 步全中）。
 *   - 中间版（脱掉配对的那**一对**，留下后缀）：得到 `802.11…（第2版）知识点大纲`，包装后是
 *     `《802.11…（第2版）知识点大纲》` —— **`知识点大纲` 被包进了书名号里**，读起来像"这本书叫
 *     《…知识点大纲》"。所以"只脱壳"不够：要**把后缀甩掉**，而不只是把括号去掉。
 *   - `replaceAll('《','').replaceAll('》','')`：连**书名里合法出现的书名号**一起删（见下方反证），更不行。
 *
 * 判据（窄，可陈述）：
 *   ① 不以 `《` 开头 ⇒ **原样返回**（那些书名号属于书名本身，如 `Linux 内核漫谈：《…》读后感`）；
 *   ② 以 `《` 开头但没有配对的 `》` ⇒ **原样返回**（不猜"到哪儿结束"）；
 *   ③ 否则取**第一个 `《` 与第一个 `》` 之间**的内容。
 *
 * 已知边界（如实登记，不掩饰）：`《X》后缀` 形态下**后缀一律丢弃** —— 当前 7 本的后缀全是
 * `知识点大纲`（已逐本核对，没有别的形态）；若将来出现「`《X》读书笔记`」这种"后缀也是信息"的根 topic，
 * 这里会把 `读书笔记` 丢掉，届时应改数据或改本函数（但**不猜**：不在没有证据时替用户保留）。
 *
 * @param {string} t 书根 topic / `meta.name`
 * @returns {string}
 */
function bookNameOf(t) {
  const s = String(t === undefined || t === null ? '' : t);
  if (s.charAt(0) !== '《') return s;     // ① 不带书名号开头 ⇒ 一个字都不动
  const close = s.indexOf('》', 1);        // 与开头那个 `《` 配对的第一个 `》`
  if (close < 0) return s;                 // ② 没有配对 ⇒ 原样
  return s.slice(1, close);                // ③ 书名 = 《》**里面**那一段（后缀不属于书名）
}

/** 项目名 → 书名（取 `meta.name`；没有就退回项目名）。**只用于显示**。 */
function bookTitleOf(report, project) {
  const hit = (report.books || []).filter(function (b) { return b.project === project; })[0];
  const t = hit && hit.title ? String(hit.title) : String(project);
  // 取《》里面的真书名（判据与三个候选实现的比较见 `bookNameOf`）；
  // 取不到（没有书名号开头）就原样用 —— 拼成 `《…》` 时不会出现 `《《`，也不会多一个 `》`
  return bookNameOf(t);
}

/**
 * 一步的显示名：`NN. 《书名》· 章名· 步骤名`（**唯一**拼装处）。
 *
 * 去重判据（窄）：当**这一步本身就是章节点**时（`chapter === topic`），章名与步骤名是同一个字符串，
 * 只留**一段** ⇒ `05. 《802.11无线网络权威指南（第2版）》· 第一章 无线网络导论`。
 *
 * 为什么留 `topic` 而不是 `chapter`：`topic` 是节点**自己的名字**（读者要认的是它），`chapter` 只是它的
 * **上下文**；两者相同时丢掉上下文、留下本体。反过来（留 chapter 丢 topic）在"章名恰好等于步骤名"时
 * 会把**节点自己的名字**从显示名里抹掉 —— 那才是真的丢信息。
 *
 * 为什么不是"两段都留、只加个标记"（如 `· 第一章 无线网络导论（本章）`）：那是**新造**第三种形态，
 * 545 步里 105 步会变成它，读的人得先学这套标记；而这里要表达的只是"同一件事不必说两遍"。
 *
 * @param {{books:Array}} report `planPath` 的报告（只为取书名）
 * @param {{project:string, chapter:string, topic:string}} s 一步
 * @param {number} i 步下标（0 起；序号按 2 位补零）
 * @returns {string}
 */
function stepTopicOf(report, s, i) {
  const head = String(i + 1).padStart(2, '0') + '. 《' + bookTitleOf(report, s.project) + '》';
  const chapter = s.chapter === undefined || s.chapter === null ? '' : String(s.chapter);
  const topic = s.topic === undefined || s.topic === null ? '' : String(s.topic);
  const label = chapter || '（顶层主题）';
  // 章节点：章名与步骤名同源 ⇒ 只留一段（步骤名）
  if (topic.trim() && topic.trim() === label.trim()) return head + '· ' + topic;
  return head + '· ' + label + '· ' + topic;
}

/**
 * 一步的 `links[].caption`（出处说明，截断只为可读）。与 `stepTopicOf` **同一条去重判据**：
 * `chapter === topic` 时只写一段（否则会出现「来源：全书概览 · 全书概览」）；
 * 章名为空时不再留一个孤零零的 ` › `。
 */
function captionOfStep(s) {
  const chapter = s.chapter === undefined || s.chapter === null ? '' : String(s.chapter);
  const topic = s.topic === undefined || s.topic === null ? '' : String(s.topic);
  const src = (!chapter || chapter.trim() === topic.trim()) ? topic : (chapter + ' › ' + topic);
  return ('来源：' + src).slice(0, CAPTION_MAX);
}

/** 每个数字的判据（写进 `--json` 的 `criteria`：读数最容易被当约定用，所以把口径印在输出里） */
const CRITERIA = Object.freeze({
  steps: '顺序 = children 数组顺序（数据里唯一有序的表达）；每一维依据见 steps[].why',
  'steps[].why.kind': '封闭取值表 src/learn-path.js 的 WHY_KINDS：chapter-order / explicit-prereq（权威）、'
    + 'term-affinity（弱：共现是对称的，只导航不宣布前置）、mechanical（机械序，不是学出来的顺序）',
  'steps[].why.evidence.affinity': '与上一步共享术语的 **IDF 加权和**（整数）：'
    + 'weight(term) = round(10000 * ln(N / df))，N = 单元总数、df = 出现过该术语的单元数 ⇒ df === N 的术语权重 0',
  graph: '边只有两种：spine（书内相邻单元，T1）与 explicit（links[].caption 以「前置：」开头，T2）'
    + ' —— 共现与兜底序**不产生边**，所以它们不可能造出环',
  'graph.unresolvedEdges': '显式前置指向的节点不是学习单元 / 不存在 / 项目不在输入里 ⇒ **逐条点名**，'
    + '绝不静默丢边（静默丢边 = 用户以为约束生效了、其实没生效）',
  gaps: '「跳级」= 这一步引用了路径外的知识点：linked-outside-path（目标项目不在输入）/ '
    + 'linked-later（在输入里但排在后面）/ linked-not-a-unit（目标节点没有正文）',
  ai: '单位 = **AI 调用次数**；计数来自 ai.log 的**条数**（不是自报计数器）；'
    + '上界 = src/learn-path.js 的 AI_BUDGET.maxCalls；本版 PROGRAM_ONLY ⇒ maxCalls = 0',
  sourceIntegrity: '生成前后各算一次输入项目 JSON 的 sha256 + 字节数，逐字节对拍；'
    + '任一字节不同 ⇒ 命令**响亮失败**（不是警告）',
  determinism: 'determinism.canonical = 每步 (seq, project, nodeId, why.kind, affinity, prev) 的规范化串；'
    + '同输入两次运行必须是同一个 sha256（判据 1）'
});

/* 导出面（测试要用）：命令体 + 判据文案 + **判据 4 的量具**（`snapshotOf` / `integrityOf`）
 * + **显示名的纯函数**（`bookNameOf` / `bookTitleOf` / `stepTopicOf` / `captionOfStep`）。
 * 量具导出是刻意的：判据 4 的判别力必须能**单独注入**（"改一个字节 ⇒ unchanged:false"），
 * 否则那条断言只能靠"跑一遍没报错"来自证 —— 那正是本工程最忌的假绿。
 * 显示名同理：它们的判据（书名取《》里面 / 章节点只留一段）必须能**逐形态单独喂**，
 * 否则只能靠"看产物顺不顺眼"自证。 */
module.exports = {
  learnPath: learnPath,
  CRITERIA: CRITERIA,
  TEXT_STEPS: TEXT_STEPS,
  snapshotOf: snapshotOf,
  integrityOf: integrityOf,
  sha256Of: sha256Of,
  STEP_ID_PREFIX: STEP_ID_PREFIX,
  bookNameOf: bookNameOf,
  bookTitleOf: bookTitleOf,
  stepTopicOf: stepTopicOf,
  captionOfStep: captionOfStep
};
