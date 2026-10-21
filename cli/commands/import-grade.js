/* ============================================================
 * cli/commands/import-grade.js — `import-grade [<项目>] [--project 名] [--all] [--only 子串] [--limit n] [--include-probe] [--json]`
 * ------------------------------------------------------------
 * 一句话：**导入分档（`IG` · 台账 `W15`）的读数出口** —— 每份"导入过的源文件"判它是
 * `clean`（保真）/ `rewritten`（有改写）/ `grown`（导入后长过节点）/ `src-gone` / `unreadable` / `unknown-tool`，
 * 并给出可复算的 precision / recall。
 *
 * ## 它是**读数，不是门禁**（与 `health` 同一条口径：`docs/ITEM-MODEL.md` §11）
 * 退出码恒为 0（除非命令自己出错）。"该不该拦"是别人的事；本命令只回答"现在什么状况、判据是什么"。
 *
 * ## 判定只有一处实现
 * 分级与打分**全部**在 `src/import-grade.js`（`grade.replayTopics` / `gradeOne` / `summarize`）。
 * 本文件只做四件事：**定扫描面 → 读盘 → 调它 → 排输出**。一行判据都不在这里重写。
 *
 * ## 判据的形状（为什么是"重放"，见 `src/import-grade.js` 的模块头）
 *     Y = 把源文重新跑一遍导入器（`docToOutline` → `markdownToTree`）得到的"本该长成的标题序列"
 *     X = 盘上 `origin` 子树里实际长成的那棵树的标题序列
 *     precision = |多重集交| / |X| · recall = |多重集交| / |Y|
 *   ⚠️ **对齐单位是"源文件"**（一个 1 级标题一条 `origin` ⇒ 必须先按 `(项目, src)` 归并，
 *   拿单条 `origin` 的子树去比整份源文，多标题文件必然被判 `rewritten`）。
 *
 * ## 扫描面必须"显式"而不是"扫 `projects/` 有什么算什么"（本批实测的环境事实）
 * 别的批跑 `scripts/cli-integration.js` 会在 `projects/` 下**瞬时**造 `it-probe-*` / `imp-probe-*`
 * 并可能残留 `.visits/*.jsonl` ⇒ 任何"全库统计"的读数会**在两跑之间变化**（`W3` / `W7` 都撞过）。
 * ⇒ 本命令：**默认排除探针项目**（并**打印排除了几个**，不静默）、`--only` / `--project` 把扫描面**锁死**、
 * `--json` 里带一份 `scope` 记录"这份读数覆盖了谁"。`--include-probe` 是显式逃生门。
 *
 * ## 确定性（`--json` 两跑 sha256 相同）
 * 零时钟（不打印任何"现在几点"）、零随机、零墙钟；所有列表按 `(项目名, src)` 升序；
 * 逐条点名有上限且**超出时置 `namesTruncated`**（静默截断过的点名会被当成完整的点名）；
 * 计数的键按固定数组出（不靠对象遍历顺序）。
 * ⚠️ **前提**：扫描面本身没被别人改（并发写库时没有命令能保证"两跑相同"）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../core.js');
const docImport = require('../../src/doc-import.js');
const grade = require('../../src/import-grade.js');

/** 默认每行最多列几份源文件（`--limit` 覆盖；`0` = 不限）。只影响**打印**，不影响 totals。 */
const DEFAULT_LIST = 40;

/** 文本档的档位标签（键 = 内部 klas，值 = 面向人的中文；顺序 = 汇总行的打印顺序） */
const KLASS_LABEL = Object.freeze({
  clean: '保真',
  rewritten: '有改写',
  grown: '长过了',
  'src-gone': '源文件不在',
  unreadable: '读不了',
  'unknown-tool': '工具未知'
});
const KLASS_ORDER = Object.freeze(['clean', 'rewritten', 'grown', 'src-gone', 'unreadable', 'unknown-tool']);

/** `origin.src` → 盘上绝对路径。规则同 `docs/DATA-FORMAT.md` §2.8：相对工程根的 POSIX 路径，跨盘时是绝对路径。 */
function resolveSrc(src) {
  const s = String(src || '');
  if (!s) return '';
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(core.REPO_ROOT, s);
}

/** 项目文档 → 树根。盘上的形状是 `{meta, format, data:<根节点>, assoc}`（`docs/DATA-FORMAT.md` §2.1），
 *  `ctx.store.read(name).data` 给的是**整份文档**（不是根节点）⇒ 这里必须先脱一层。
 *  取不到 `data` 时退回文档本身（坏数据时宁可少报，也不许在命令层抛形状错）。 */
function rootOf(doc) {
  if (doc && typeof doc === 'object' && doc.data && typeof doc.data === 'object') return doc.data;
  return doc;
}

/** 前序收集所有挂了 `origin` 的节点（顺序 = 磁盘上的 DFS 顺序 ⇒ 确定性）。 */
function originNodesOf(root) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.origin && typeof n.origin === 'object' && n.origin.src) out.push(n);
    const kids = Array.isArray(n.children) ? n.children : [];
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  })(root);
  return out;
}

/**
 * 一个项目里所有 `origin` 按 **(项目, 源文件)** 归并。一个 src 可能对应多条 origin
 * （`import-md` 给每个 1 级标题写一条）⇒ 必须先归并再比。
 */
function groupsOf(project, data) {
  const groups = new Map();
  const nodes = originNodesOf(rootOf(data));
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const abs = resolveSrc(n.origin.src);
    const key = project + '\u0000' + abs;
    if (!groups.has(key)) {
      groups.set(key, {
        project: project,
        src: String(n.origin.src),          // 原样回报（相对/绝对都照数据写的那样）
        abs: abs,
        nodes: [],
        tools: []
      });
    }
    const g = groups.get(key);
    g.nodes.push(n);
    const t = n.origin.tool === undefined || n.origin.tool === null ? '' : String(n.origin.tool);
    if (g.tools.indexOf(t) < 0) g.tools.push(t);
  }
  return [...groups.values()];
}

/** 判一组：读源文 → 重放 → 取实际 → 交给 `src/import-grade.js` 判。 */
function gradeGroup(g, memo) {
  /* 工具口径（三档，全都**不猜**）：
   *   · 恰好一种 tool ⇒ 用它（是否算 origin 节点自己由 `src/` 的 `originNodeCountsAsProduct` 判）
   *   · 一条都没写 / 同源出现两种以上 ⇒ **tool = null** ⇒ `gradeOne` 落 `unknown-tool`
   *     （同一份源文里出现两种工具是数据异常：`includeSelf` 到底算不算无从判断）
   *   · 混合的情况把"混了哪几种"记进 reason —— 原因不许丢 */
  const mixed = g.tools.length > 1;
  const tool = g.tools.length === 1 ? g.tools[0] : null;

  let actualTopics = [];
  let placeholders = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    const got = grade.topicsOfOrigin(g.nodes[i], tool);
    actualTopics = actualTopics.concat(got.topics);
    placeholders += got.placeholders;
  }

  // 源文：先判存在，再读、再解析（三种失败分开报，别用一个 catch 糊成"失败"）
  let srcState = 'ok';
  let srcReason = null;
  let replay = { topics: [], placeholders: 0 };
  if (!fs.existsSync(g.abs)) {
    srcState = 'src-gone';
    srcReason = '源文件不在盘上：' + g.abs;
  } else {
    if (memo.has(g.abs)) {
      replay = memo.get(g.abs);
    } else {
      try {
        const conv = docImport.docToOutline(g.abs);
        replay = grade.replayTopics(conv.md);
      } catch (e) {
        srcState = 'unreadable';
        srcReason = (e && e.message) || String(e);
        replay = { topics: [], placeholders: 0 };
      }
      memo.set(g.abs, replay);
    }
  }

  const row = grade.gradeOne({
    project: g.project,
    src: g.src,
    tool: tool,
    srcState: srcState,
    reason: srcReason,
    replayTopics: replay.topics,
    actualTopics: actualTopics,
    placeholders: placeholders + replay.placeholders
  });
  // 混合工具：`gradeOne` 只会给 `unknown-tool` + 空 reason；"混了哪几种"只有这里知道 ⇒ 补上
  if (mixed && row.klass === 'unknown-tool') row.reason = 'mixed-tools: ' + g.tools.join(' + ');
  return row;
}

module.exports = {
  importGrade(ctx) {
    const positional = ctx.args._[0];
    if (ctx.args.project === true) ctx.error('--project 需要一个项目名：import-grade --project <项目名>');
    const named = ctx.args.project === undefined ? null : String(ctx.args.project);
    if (positional && named && positional !== named) {
      ctx.error('项目名给了两个且不一致：位置参数 ' + positional + ' vs --project ' + named + '（二选一）');
    }
    if (typeof ctx.args.all === 'string') {
      ctx.error('`--all` 不带值：`import-grade --all ' + ctx.args.all + '` 会把 "' + ctx.args.all
        + '" 当成 --all 的值吃掉。要指定项目就 `import-grade ' + ctx.args.all + '`；要整个库就 `import-grade --all`。');
    }
    const one = positional || named;
    if (one && ctx.args.all) ctx.error('--all 与项目名不能同时给（二选一）：`import-grade` 不带项目名就是整个库');
    if (ctx.args.only === true) ctx.error('--only 需要一个子串：import-grade --only book-');
    const only = ctx.args.only === undefined ? null : String(ctx.args.only);
    const limit = ctx.intOption('limit', { min: 0, max: grade.MAX_SOURCES, def: DEFAULT_LIST });
    const includeProbe = !!ctx.args.includeProbe;

    // ---- 扫描面：显式、可锁、排除探针并**报数** ----
    const allNames = ctx.store.list().map((p) => p.name).sort();
    const excludedProbe = includeProbe ? [] : allNames.filter((n) => grade.isProbeProject(n));
    let names = includeProbe ? allNames : allNames.filter((n) => !grade.isProbeProject(n));
    if (one) {
      if (names.indexOf(one) < 0) {
        // 点名了一个被排除的探针项目，或项目不存在 —— 两种都响亮拒绝并说清
        if (allNames.indexOf(one) >= 0) {
          ctx.error('项目 ' + one + ' 是**探针项目**（测试脚本造起来、跑完自己删的那种），本命令默认排除它。'
            + '真要读它就加 --include-probe（读数会随别人跑测试而变）。');
        }
        ctx.error('项目不存在：' + one + '（库里现有：' + names.join(', ') + '）');
      }
      names = [one];
    }
    if (!names.length) {
      ctx.error('库里一个项目都没有（`projects/` 下没有 <名字>/<名字>.json）—— 先 `init <项目>`。');
    }
    if (names.length > grade.MAX_SOURCES) {
      ctx.error('扫描面 ' + names.length + ' 个项目，超过上限 ' + grade.MAX_SOURCES
        + '（整库读数会把一次命令变成一次跑盘）—— 用 --project 或 --only 缩小范围。');
    }

    // ---- 读盘 + 判定 ----
    const memo = new Map();          // 同一份源文只读一次（多个项目引用同一文件时复用）
    const rows = [];
    const projectErrors = [];
    const readOne = (name) => {
      let data = null;
      try { data = ctx.store.read(name).data; } catch (e) {
        if (one) ctx.error('项目读不了：' + name + '（' + ((e && e.message) || e) + '）');
        projectErrors.push({ project: name, error: (e && e.message) || String(e) });
        return;
      }
      groupsOf(name, data).forEach((g) => rows.push(gradeGroup(g, memo)));
    };
    names.forEach(readOne);

    // ---- `--only`：按 src 子串过滤（**只影响这一份读数，不改判据**）----
    let kept = rows;
    let excludedByOnly = 0;
    if (only !== null) {
      kept = rows.filter((r) => r.src.indexOf(only) >= 0);
      excludedByOnly = rows.length - kept.length;
      if (!kept.length) {
        ctx.error('--only "' + only + '" 一份源文件都没匹配上（扫过的 ' + rows.length + ' 行里有 '
          + excludedByOnly + ' 行不含这个子串）。去掉 --only，或换一个子串。');
      }
    }
    // 排序：项目名升序 → src 升序（**唯一全序** ⇒ 同输入两跑顺序相同）
    kept = kept.slice().sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1
      : (a.src < b.src ? -1 : a.src > b.src ? 1 : 0)));

    const sum = grade.summarize(kept);
    const shown = limit > 0 ? kept.slice(0, limit) : kept;
    const truncated = shown.length < kept.length;

    const scope = {
      mode: one ? 'project' : 'library',
      projects: names,
      excludedProbeProjects: excludedProbe,
      includeProbe: includeProbe,
      only: only,
      limit: limit,
      projectErrors: projectErrors
    };

    // ---- 输出：JSON 的键序就是这里的字面量顺序 ----
    if (ctx.args.json) {
      ctx.outJson({
        ok: true,
        command: 'import-grade',
        scope: scope,
        totals: sum.totals,
        precision: sum.precision,
        recall: sum.recall,
        rowsShown: shown.length,
        rowsTotal: kept.length,
        truncated: truncated,
        excludedByOnly: excludedByOnly,
        rows: shown.map((r) => ({
          project: r.project,
          src: r.src,
          tool: r.tool,
          klass: r.klass,
          E: r.E,
          A: r.A,
          matched: r.matched,
          precision: r.precision,
          recall: r.recall,
          placeholders: r.placeholders,
          extraInTree: r.extraInTree,
          missingInTree: r.missingInTree,
          namesTruncated: r.namesTruncated,
          reason: r.reason
        }))
      });
      return;
    }

    // ---- 文本档 ----
    const t = sum.totals;
    ctx.out('导入分档（IG）—— **读数，不是门禁**（不改任何东西；红/绿由别的判据管）');
    ctx.out('扫描面：' + (scope.mode === 'project' ? '单项目 ' + names[0] : '整个库 ' + names.length + ' 个项目')
      + (includeProbe ? '（**含探针项目**）' : '，已排除探针项目 ' + excludedProbe.length + ' 个')
      + (only !== null ? '，--only "' + only + '" 过滤掉 ' + excludedByOnly + ' 行' : ''));
    if (projectErrors.length) {
      ctx.out('⚠ 有 ' + projectErrors.length + ' 个项目读不了（已跳过，逐条列在 --json 的 scope.projectErrors）：'
        + projectErrors.map((e) => e.project).join(', '));
    }
    ctx.out('源文件 ' + t.sources + ' 份：' + KLASS_ORDER.map((k) => KLASS_LABEL[k] + ' ' + t[k === 'src-gone' ? 'srcGone'
      : k === 'unknown-tool' ? 'unknownTool' : k]).join(' · '));
    if (t.judgeable) {
      ctx.out('可判 ' + t.judgeable + ' 份：precision ' + sum.precision + ' · recall ' + sum.recall
        + '（E ' + t.E + ' · A ' + t.A + ' · 交 ' + t.matched + '）');
    } else {
      ctx.out('可判 0 份 ⇒ precision / recall 都是 null（null = 没得判，0 = 全错，两件事）');
    }
    if (t.placeholders) {
      ctx.out('占位节点「（层级N）」剔除 ' + t.placeholders + ' 个（层级跳跃处由建树器插入，不算标题）');
    }
    if (!t.sources) {
      ctx.out('（这个扫描面里**一份导入都没有**：没有节点带 `origin`。要么没导过，要么是 `import-json`/老数据。）');
    }
    ctx.out('');
    shown.forEach((r) => {
      const pct = (r.precision === null ? '—' : r.precision) + '/' + (r.recall === null ? '—' : r.recall);
      ctx.out('  ' + (KLASS_LABEL[r.klass] || r.klass).padEnd(6, '　')
        + (r.project + '：').padEnd(18, '　')
        + ' E=' + (r.E === null ? '—' : r.E) + ' A=' + (r.A === null ? '—' : r.A) + '  ' + pct
        + '  ' + path.basename(r.src));
      if (r.klass === 'rewritten' || r.klass === 'grown') {
        r.extraInTree.slice(0, 3).forEach((x) => ctx.out('      + 树上多出来的：「' + x + '」'));
        r.missingInTree.slice(0, 3).forEach((x) => ctx.out('      - 源文里没落成的：「' + x + '」'));
        if (r.namesTruncated) ctx.out('      …点名已截断（每类最多 ' + grade.MAX_NAMES + ' 条，完整清单加 --json）');
      }
      if (r.reason) ctx.out('      原因：' + r.reason);
    });
    if (truncated) {
      ctx.out('');
      ctx.out('…另有 ' + (kept.length - shown.length) + ' 行没打印（--limit ' + limit + '；**totals 仍按全部 ' + kept.length
        + ' 行算**，不受 --limit 影响）。');
    }
    ctx.out('');
    ctx.out('口径：`clean` = 标题序列与"重放导入"逐条全等；`rewritten` = 有节点在源文里找不到；'
      + '`grown` = 导入后又长了节点（**本次导入的产物边界不可分 ⇒ 不出分**）。');
    ctx.out('判据唯一实现在 `src/import-grade.js`；本命令只做"定扫描面 → 读盘 → 调它 → 排输出"。');
  }
};
