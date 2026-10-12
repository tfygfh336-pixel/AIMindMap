/* ============================================================
 * cli/commands/health.js — 条目层体检（S4）：`health [<项目>] [--json]`
 * ------------------------------------------------------------
 * 一句话：**条目层健康度的"真值出口"**（契约 `docs/ITEM-MODEL.md` §11 明写：
 * 迁移规模一类的数字**不写进文档**，由 `health --json` 报）。
 *
 * ## 它是**读数，不是门禁**（契约 §11 / §12 的 S4 那一句）
 * 不红、不拦写、退出码恒为 0（除非命令自己出错）：该不该拦写由 G2（`validate` / `validate-all`）判。
 * 它回答的是"现在什么状况"，并把每个数字的**判据**一起印出来（`criteria`），
 * 免得读者把某个计数当成约定用。
 *
 * ## 确定性是硬要求（契约 §10 AC14）
 * 同状态连跑两次 ⇒ **逐字节相同**。为此：
 *   · 不打印任何时间戳（"最后核验时间"取的是**数据里**的 `verified.at` 最大值，不是 now）；
 *   · 所有列表按 DFS 顺序（`recheck.scanProject` 的顺序）+ 悬挂清单按 `at` 排序；
 *   · 所有计数块的键按**固定数组**出（不靠对象遇到顺序）；`--all` 按项目名排序。
 *
 * ## 判定只有一处实现
 * 条目级的"就绪 / 需复核 / 出处失效"直接用 `cli/commands/recheck.js` 的 `scanProject()`
 * （那是这一层的唯一实现处）—— 本文件**不重新判一遍**，只做聚合与点名。
 *
 * ## 报什么（都是"能照着动手"的形态）
 *   · 条目化节点数 / 总节点数（含富文本节点与 v2 节点）
 *   · 条目数（按 type 分）+ 无出处 / 未核 / 需复核 / 出处失效 / 核验后源文件改过 / 被取代 / 最后核验时间
 *   · `items ↔ detail` **不一致的节点（逐节点点名）** + 修法（`render-detail`）
 *   · 悬挂引用（**条目级**：`links[].item` / `assoc.members[].item` / `supersededBy`，逐处点名）
 *   · `qa` 残留（条目化节点上仍有 `qa[]`，契约 §2 判红项；逐节点点名）
 *   · 迁移（契约 §6）：**可迁移 / 已条目化 / 无内容 / 不在范围（无 `<li>`）/ 跳过**五档分开报，
 *     跳过的**逐节点点名 + 原因分布** —— 底线是"不许用『跳过』把『不可迁移』伪装成『没有要迁的』"。
 * ============================================================ */
'use strict';

const path = require('path');
const itemModel = require('../../src/item-model.js');
const recheck = require('./recheck.js');

/** 迁移**跳过**的封闭原因表（顺序 = 分布表的键顺序 ⇒ 读数确定性） */
const SKIP_REASONS = Object.freeze([
  'not-lossless',              // parseDetail 判"这段回放不了"（返回 null）
  'not-lossless-roundtrip',    // 能切成条目，但 renderDetail 拼不回原文（逐字节不等）
  'unknown'                    // 兜底：itemizeNode 给了没见过的原因（出现即该查，不许静默吞）
]);

/** 条目 type 的封闭取值表（契约 §1；顺序 = 输出键顺序） */
const TYPES = Object.freeze(['text', 'rich', 'qa']);

/** "判据/契约类" 的判据（只用于**响亮提示**，不参与任何计数口径）：条目或节点带上这些标签 */
const CRITERIA_TAGS = Object.freeze(['判据', '契约']);

/** 每个数字的判据（写进 `--json`；读数最容易被当约定，所以把它写死在输出里） */
const CRITERIA = Object.freeze({
  nodes: '{total 总节点, itemized 有 items（含空数组）, rich detailMode==="rich", v2 两者都没有}'
    + ' —— 三档封闭，判据见契约 §2',
  items: '条目层面的读数（判定唯一来源：`cli/commands/recheck.js` 的 scanProject）',
  'items.unverified': '没有 `verified` 字段（契约 §1：缺失 = 未核）',
  'items.needsRecheck': '判定为 `needs-recheck` 的条目数（含未核、无出处、源已改、不可机核的那些）',
  'items.srcGone': '判定为 `src-gone` 的条目数（出处文件没了 / 引文找不到）',
  'items.lastVerifiedAt': '数据里所有 `verified.at` 的**最大值**（不是本命令的运行时刻 ⇒ 确定性）',
  'inconsistent': '条目化节点上 `detail` **逐字节不等于** `renderDetail(items)`（契约 §2 的不变量；'
    + '修法是 `render-detail <项目> <节点id>`）',
  'dangling': '`links[].item` / `assoc.members[].item` / `supersededBy` 指向一条不存在的条目（逐处点名；'
    + '节点级悬挂由 G2 的 `validate` 负责，这里只报契约 §7 新增的**条目级**）',
  'qaResidue': '条目化节点上仍有 `qa[]`（契约 §2：有 items 不得有 qa[]；属于"两处表达"，必判红）',
  'detailModeResidue': '条目化节点上出现 `detailMode`（契约 §2：两者互斥）',
  'migration.eligible': '按契约 §6 的准入门槛**现在算**能迁移的节点数'
    + '（无 items、无 detailMode、detail 含 `<li>`、且 `renderDetail(parseDetail(detail)) === detail`）',
  'migration.skipped': '在迁移范围内（有内容、含 `<li>`）但**回放不了** ⇒ 契约 §6 规定整节点跳过、'
    + '一个字节都不动（逐节点点名 + 原因分布）',
  'migration.noContent': '既没有 detail 也没有 `qa[]` ⇒ 没有可条目化的内容（**不算跳过**）',
  'migration.outOfScope': 'detail 里没有 `<li>` 且没有 `qa[]` ⇒ 契约 §6 的迁移**只处理列表类**，'
    + '这类不在范围内（**不算跳过**）',
  'warnings': '只做**响亮提示**、不判红的东西（如"判据/契约类条目的未核数"）'
});

/* ============================================================================
 * 一、读数（纯函数 + 读盘缓存；`opts.model` 是测试注入口，生产代码不给它）
 * ========================================================================== */

function detailTextOf(node) {
  return (node && typeof node.detail === 'string') ? node.detail : '';
}

/** 节点三档分类（契约 §2 的判定规则；封闭） */
function classifyNodes(data) {
  const out = { total: 0, itemized: 0, rich: 0, v2: 0 };
  recheck.walkNodes(data && data.data, (n) => {
    out.total++;
    if (Array.isArray(n.items)) out.itemized++;
    else if (n.detailMode === 'rich') out.rich++;
    else out.v2++;
  });
  return out;
}

/**
 * `items ↔ detail` 一致性（契约 §2 的不变量）——**逐节点点名**。
 * 只有条目化节点参与：没有 items 的节点 detail 是**真源**，不存在"派生不一致"这件事。
 */
function consistencyOf(data, opts) {
  const model = opts.model;
  const list = [];
  recheck.walkNodes(data && data.data, (n) => {
    if (!Array.isArray(n.items)) return;
    let expect = '';
    let err = null;
    try { expect = model.renderDetail(n.items); } catch (e) { err = (e && e.message) || String(e); }
    const actual = detailTextOf(n);
    if (err !== null) {
      list.push({
        nodeId: n.id, topic: n.topic || null, items: n.items.length,
        problem: 'renderDetail 抛错', detail: err,
        fix: '该节点的 items 可能不合契约：先 `recheck <项目> --json` 看它，再决定改 items 还是改 detail'
      });
      return;
    }
    if (expect !== actual) {
      list.push({
        nodeId: n.id, topic: n.topic || null, items: n.items.length,
        problem: 'detail ≠ renderDetail(items)',
        expectedBytes: byteLen(expect), actualBytes: byteLen(actual),
        detail: '按 items 应当 ' + byteLen(expect) + ' 字节，盘上 ' + byteLen(actual) + ' 字节'
          + (actual === '' ? '（detail 缺失/为空 —— 契约 §2：与空串等价）' : ''),
        fix: 'render-detail <项目> ' + n.id + '（**G2 判红时的唯一修法**）'
      });
    }
  });
  return list;
}

function byteLen(s) { return Buffer.byteLength(String(s), 'utf8'); }

/** `qa` 残留 / `detailMode` 残留（契约 §2 的两条判红项；逐节点点名） */
function residueOf(data) {
  const qa = [];
  const dm = [];
  recheck.walkNodes(data && data.data, (n) => {
    if (!Array.isArray(n.items)) return;                  // 未条目化节点的 qa[] 是 v2 兼容，不是残留
    if (Array.isArray(n.qa) && n.qa.length) {
      qa.push({
        nodeId: n.id, topic: n.topic || null, qa: n.qa.length,
        detail: '条目化节点上仍有 qa[' + n.qa.length + ']（契约 §7：收敛成 type:\'qa\' 条目后应删掉 '
          + 'node.qa，不留只读副本 —— 两处表达必漂移）',
        fix: '`migrate items <项目>` 的收敛分支会处理它（未落地前：人工把它并成条目）'
      });
    }
    if (n.detailMode !== undefined) {
      dm.push({
        nodeId: n.id, topic: n.topic || null, detailMode: n.detailMode,
        detail: '条目化节点上出现 detailMode=' + JSON.stringify(n.detailMode) + '（契约 §2：两者互斥）',
        fix: '`edit <项目> ' + n.id + ' --clear-detail-mode`（或删掉 items —— 只能留一个真源）'
      });
    }
  });
  return { qa: qa, detailMode: dm };
}

/**
 * 迁移（契约 §6）的五档读数。
 * **准入门槛的判据在 `src/item-model.js` 的 `itemizeNode()` 里**（装配点，唯一实现处）；
 * 这里只补上契约 §6 的**逐字节回放**那一半：`itemizeNode` 只保证"能切成条目"，
 * 而迁移还要求 `renderDetail(那些条目) === detail` **逐字节**成立。
 */
function migrationOf(data, opts) {
  const model = opts.model;
  const out = {
    itemized: 0, eligible: 0, noContent: 0, outOfScope: 0,
    skipped: [], reasonCounts: {}
  };
  SKIP_REASONS.forEach((r) => { out.reasonCounts[r] = 0; });
  recheck.walkNodes(data && data.data, (n) => {
    let r = null;
    try { r = model.itemizeNode(n); } catch (e) {
      r = { ok: false, reason: 'unknown', message: (e && e.message) || String(e) };
    }
    if (r && r.ok) {
      // qa[] 收敛是"**内容增加**"（契约 §6：收敛后 detail 重渲染），不参与逐字节门槛；
      // ⇒ 只核 detail 解析出来的那一部分（`itemizeNode` 把 qa 条目**保序追加在末尾**）
      const qa = r.qaItems || 0;
      const parsed = qa && r.items.length >= qa ? r.items.slice(0, r.items.length - qa) : r.items;
      let rendered = null;
      let err = null;
      try { rendered = model.renderDetail(parsed); } catch (e) { err = (e && e.message) || String(e); }
      const detail = detailTextOf(n);
      if (err === null && rendered === detail) { out.eligible++; return; }
      out.skipped.push(skipRecord(n, 'not-lossless-roundtrip', err
        ? ('renderDetail 抛错：' + err)
        : ('能切成 ' + parsed.length + ' 条，但回放 ' + byteLen(rendered) + ' 字节 ≠ 原文 '
          + byteLen(detail) + ' 字节 —— 逐字节不成立')));
      return;
    }
    const reason = (r && r.reason) || 'unknown';
    if (reason === 'itemized') { out.itemized++; return; }
    if (reason === 'no-detail') { out.noContent++; return; }
    if (reason === 'not-list') { out.outOfScope++; return; }
    out.skipped.push(skipRecord(n, SKIP_REASONS.indexOf(reason) >= 0 ? reason : 'unknown',
      (r && r.message) || '含 `<li>` 但切不开（parseDetail 判"这段回放不了"）'));
  });
  out.skipped.forEach((s) => { out.reasonCounts[s.reason] = (out.reasonCounts[s.reason] || 0) + 1; });
  return out;
}

function skipRecord(n, reason, why) {
  return {
    nodeId: n.id, topic: n.topic || null, reason: reason,
    detailBytes: byteLen(detailTextOf(n)), detail: why,
    action: '契约 §6 规定：整节点跳过、一个字节都不动（不许"修一下再写"）。要动它：'
      + '① 用 `edit <项目> ' + n.id + ' --detail-mode rich` 显式声明它是富文本；'
      + '② 或人工把 detail 改成能无损切分的形状（那是一次内容改动，要有意为之）'
  };
}

/**
 * 一个项目的体检读数（**确定**：不读时钟、不排序随机、键序固定）。
 * @param {object} data 项目数据
 * @param {{project:string, root?:string, projectIndex?:Function, model?:object, cache?:object}} opts
 */
function readingOf(data, opts) {
  const o = opts || {};
  const model = o.model || itemModel;
  const scan = recheck.scanProject(data, {
    root: o.root, project: o.project, projectIndex: o.projectIndex, cache: o.cache
  });
  const nodes = classifyNodes(data);
  const inconsistent = consistencyOf(data, { model: model });
  const residue = residueOf(data);
  const migration = migrationOf(data, { model: model });

  const byType = {};
  TYPES.forEach((t) => { byType[t] = 0; });
  scan.entries.forEach((e) => {
    const t = (e.type === undefined || e.type === null) ? 'unknown' : String(e.type);
    byType[t] = (byType[t] || 0) + 1;
  });

  let lastVerifiedAt = null;
  scan.entries.forEach((e) => {
    if (!e.verifiedAt) return;
    if (lastVerifiedAt === null || e.verifiedAt > lastVerifiedAt) lastVerifiedAt = e.verifiedAt;
  });

  // "判据/契约类条目"的未核数：只做**响亮提示**（按条目/节点标签判定；不参与任何计数口径）
  const critUnverified = scan.entries.filter((e) => {
    if (e.verified) return false;
    const tags = Array.isArray(e._item && e._item.tags) ? e._item.tags : [];
    const node = scan.indexes.byNodeId[e.nodeId];
    const nTags = (node && Array.isArray(node.node.tags)) ? node.node.tags : [];
    return CRITERIA_TAGS.some((t) => tags.indexOf(t) >= 0 || nTags.indexOf(t) >= 0);
  }).length;

  const warnings = [];
  if (critUnverified) {
    warnings.push('⚠ 判据/契约类条目未核 ' + critUnverified + ' 条（标签含 '
      + CRITERIA_TAGS.map((t) => '「' + t + '」').join('/') + '）—— 这类条目最该留下"怎么核的"的记录：'
      + '`recheck ' + o.project + ' --src ' + CRITERIA_TAGS[0] + '` 之类先定位，再 `--write-verified --how "…"`');
  }
  if (inconsistent.length) {
    warnings.push('⚠ `items ↔ detail` 不一致 ' + inconsistent.length + ' 个节点 —— 契约 §2 的不变量破了，'
      + '写盘闸门（G2）会判红：修法 `render-detail ' + o.project + ' <节点id>`');
  }
  if (migration.skipped.length) {
    warnings.push('⚠ 迁移会**跳过** ' + migration.skipped.length + ' 个节点（在范围内但回放不了）—— '
      + '如实登记，别当成"没有要迁的"：逐节点见 migration.skipped');
  }

  return {
    project: o.project,
    root: scan.root,
    nodes: nodes,
    items: {
      total: scan.counts.items,
      byType: byType,
      noSrc: scan.counts.noSrc,
      unverified: scan.counts.unverified,
      needsRecheck: scan.counts.needsRecheck,
      srcGone: scan.counts.srcGone,
      ok: scan.counts.ok,
      stale: scan.counts.stale,
      superseded: scan.counts.superseded,
      lastVerifiedAt: lastVerifiedAt
    },
    reasonCounts: scan.reasonCounts,
    inconsistent: { count: inconsistent.length, nodes: inconsistent },
    dangling: { count: scan.dangling.length, list: scan.dangling },
    qaResidue: { count: residue.qa.length, nodes: residue.qa },
    detailModeResidue: { count: residue.detailMode.length, nodes: residue.detailMode },
    migration: migration,
    warnings: warnings,
    criteria: CRITERIA
  };
}

/* ============================================================================
 * 二、命令体
 * ========================================================================== */

/** 库级聚合（键固定、顺序固定） */
function totalOf(readings) {
  const t = {
    projects: readings.length,
    nodesTotal: 0, nodesItemized: 0, nodesRich: 0, nodesV2: 0,
    items: 0, noSrc: 0, unverified: 0, needsRecheck: 0, srcGone: 0, stale: 0, superseded: 0,
    inconsistent: 0, dangling: 0, qaResidue: 0, detailModeResidue: 0,
    migrationEligible: 0, migrationSkipped: 0
  };
  readings.forEach((r) => {
    t.nodesTotal += r.nodes.total; t.nodesItemized += r.nodes.itemized;
    t.nodesRich += r.nodes.rich; t.nodesV2 += r.nodes.v2;
    t.items += r.items.total; t.noSrc += r.items.noSrc; t.unverified += r.items.unverified;
    t.needsRecheck += r.items.needsRecheck; t.srcGone += r.items.srcGone;
    t.stale += r.items.stale; t.superseded += r.items.superseded;
    t.inconsistent += r.inconsistent.count; t.dangling += r.dangling.count;
    t.qaResidue += r.qaResidue.count; t.detailModeResidue += r.detailModeResidue.count;
    t.migrationEligible += r.migration.eligible; t.migrationSkipped += r.migration.skipped.length;
  });
  return t;
}

module.exports = {
  /**
   * `health [<项目>] [--project 项目名] [--all] [--root 目录] [--json]`
   * 不给项目名（也不给 `--all`）= **整个库**（库里有哪些项目由 `ctx.store.list()` 决定，按名字排序）。
   * `--root` = `src` 里相对路径出处的根（与 `recheck` 同一个语义；默认工程根）。
   */
  health(ctx) {
    const positional = ctx.args._[0];
    if (ctx.args.project === true) ctx.error('--project 需要一个项目名：health --project <项目名>');
    const named = ctx.args.project === undefined ? null : String(ctx.args.project);
    if (positional && named && positional !== named) {
      ctx.error('项目名给了两个且不一致：位置参数 ' + positional + ' vs --project ' + named
        + '（二选一）');
    }
    const one = positional || named;
    const all = !!ctx.args.all;
    // ⚠️ 裸 `--all` 后面跟位置参数会被参数解析器当成"它的值"（core 的 parseArgs 只把登记过的纯布尔
    // 开关当开关）⇒ 项目名被静默吃掉。那种写法**响亮拒绝**（宁可报错，也不按另一个口径跑）。
    if (typeof ctx.args.all === 'string') {
      ctx.error('`--all` 不带值：`health --all ' + ctx.args.all + '` 会把 "' + ctx.args.all
        + '" 当成 --all 的值吃掉。要指定项目就 `health ' + ctx.args.all + '`（或 `--project '
        + ctx.args.all + '`）；要整个库就 `health --all` 或干脆 `health`（不给项目名 = 整个库）。');
    }
    if (all && one) ctx.error('--all 与项目名不能同时给（二选一）：`health` 不带项目名就是整个库');
    const root = ctx.args.root === undefined
      ? recheck.REPO_ROOT : path.resolve(String(ctx.args.root));

    // 跨项目悬挂检测：按需读别的项目（读一次、memo 住）；**只读**，不写盘
    const memo = new Map();
    const selfCache = new Map();                       // 已经读过的项目数据（库级模式复用）
    const dataOf = (name) => {
      if (selfCache.has(name)) return selfCache.get(name);
      const d = ctx.store.read(name).data;
      selfCache.set(name, d);
      return d;
    };
    const projectIndex = (name) => {
      if (memo.has(name)) return memo.get(name);
      let v = null;
      try { v = recheck.indexOf(dataOf(name)); } catch (e) { v = null; }
      memo.set(name, v);
      return v;
    };

    const names = one ? [one] : ctx.store.list().map((p) => p.name).sort();
    if (!names.length) {
      ctx.error('库里一个项目都没有（`projects/` 下没有 <名字>/<名字>.json）—— 先 `init <项目>`。');
    }
    // 库级模式下**单个项目读不了不该让整个读数消失**（例如崩溃留下的坏探针项目）：
    // 如实登记进 `unreadable` 并响亮提示 —— 读数命令的职责是"报告现状"，不是"被一个坏文件挡住"。
    const unreadable = [];
    const readings = [];
    names.forEach((name) => {
      let d = null;
      try { d = dataOf(name); } catch (e) {
        if (one) ctx.error('项目读不了：' + name + '（' + ((e && e.message) || e) + '）');
        unreadable.push({ project: name, error: (e && e.message) || String(e) });
        return;
      }
      readings.push(readingOf(d, { project: name, root: root, projectIndex: projectIndex }));
    });

    if (one) {
      const r = readings[0];
      if (ctx.args.json) { ctx.outJson(Object.assign({ ok: true, scope: 'project' }, r)); return; }
      printReading(ctx, r, { verbose: true });
      ctx.out('');
      ctx.out('（这是**读数不是门禁**：红/绿由 `validate-all`（G2）判；本命令不改任何东西）');
      return;
    }
    const total = totalOf(readings);
    if (ctx.args.json) {
      ctx.outJson({
        ok: true, scope: 'library', projects: readings, total: total,
        unreadable: unreadable, criteria: CRITERIA
      });
      return;
    }
    ctx.out('# 体检（全库 ' + total.projects + ' 个项目，按项目名排序）');
    readings.forEach((r) => { ctx.out(''); printReading(ctx, r, { verbose: false }); });
    if (unreadable.length) {
      ctx.out('');
      ctx.out('⚠ 读不了的项目 ' + unreadable.length + ' 个（**不计入上面的合计** —— 合计里没有它们，'
        + '"没有"与"读不到"不是一回事）：');
      unreadable.forEach((u) => ctx.out('  · ' + u.project + '：' + u.error));
    }
    ctx.out('');
    ctx.out('全库合计：节点 ' + total.nodesTotal + '（条目化 ' + total.nodesItemized + '）｜'
      + '条目 ' + total.items + '（未核 ' + total.unverified + '、需复核 ' + total.needsRecheck
      + '、出处失效 ' + total.srcGone + '）｜detail 不一致节点 ' + total.inconsistent
      + '｜悬挂引用 ' + total.dangling + '｜qa 残留 ' + total.qaResidue
      + '｜迁移可迁 ' + total.migrationEligible + '、会跳过 ' + total.migrationSkipped);
    ctx.out('');
    ctx.out('（这是**读数不是门禁**：红/绿由 `validate-all`（G2）判；本命令不改任何东西）');
  },

  // 导出给测试与将来的调用方（判定仍在 recheck.js；这里只是聚合）
  readingOf: readingOf,
  totalOf: totalOf,
  CRITERIA: CRITERIA,
  SKIP_REASONS: SKIP_REASONS
};

/** 一个项目的可读读数（`verbose` 时逐条点名） */
function printReading(ctx, r, opts) {
  const verbose = !!(opts && opts.verbose);
  ctx.out('# 体检 ' + r.project);
  ctx.out('节点 ' + r.nodes.total + ' 个：条目化 ' + r.nodes.itemized + ' ｜ 富文本(detailMode) '
    + r.nodes.rich + ' ｜ v2 ' + r.nodes.v2);
  ctx.out('条目 ' + r.items.total + ' 条：'
    + TYPES.map((t) => t + ' ' + (r.items.byType[t] || 0)).join(' ｜ '));
  ctx.out('  无出处 ' + r.items.noSrc + ' ｜ 未核 ' + r.items.unverified + ' ｜ 需复核 '
    + r.items.needsRecheck + ' ｜ 出处失效 ' + r.items.srcGone + ' ｜ 核验后源文件改过 '
    + r.items.stale + ' ｜ 被取代 ' + r.items.superseded + ' ｜ 已是就绪态 ' + r.items.ok);
  ctx.out('  最后核验时间：' + (r.items.lastVerifiedAt || '（从未核过 —— 没有任何 verified.at）'));
  const dist = Object.keys(r.reasonCounts).filter((k) => r.reasonCounts[k] > 0);
  if (dist.length) ctx.out('  复核原因分布：' + dist.map((k) => k + ' ' + r.reasonCounts[k]).join(' ｜ '));

  ctx.out('detail 一致性（契约 §2 的不变量）：' + (r.inconsistent.count
    ? '不一致 ' + r.inconsistent.count + ' 个节点' : '全部一致'));
  if (verbose) {
    r.inconsistent.nodes.forEach((x) => {
      ctx.out('  · ' + x.nodeId + (x.topic ? '「' + x.topic + '」' : '') + ' items ' + x.items + ' 条 → '
        + x.detail);
      ctx.out('      修法：' + x.fix);
    });
  }

  ctx.out('qa 残留（条目化节点上仍有 qa[]，契约 §2 判红）：' + (r.qaResidue.count
    ? r.qaResidue.count + ' 个节点' : '无'));
  if (verbose) {
    r.qaResidue.nodes.forEach((x) => {
      ctx.out('  · ' + x.nodeId + (x.topic ? '「' + x.topic + '」' : '') + ' → ' + x.detail);
      ctx.out('      修法：' + x.fix);
    });
  }
  ctx.out('detailMode 残留（条目化节点上出现 detailMode，契约 §2 互斥）：'
    + (r.detailModeResidue.count ? r.detailModeResidue.count + ' 个节点' : '无'));
  if (verbose) {
    r.detailModeResidue.nodes.forEach((x) => {
      ctx.out('  · ' + x.nodeId + (x.topic ? '「' + x.topic + '」' : '') + ' → ' + x.detail);
      ctx.out('      修法：' + x.fix);
    });
  }

  ctx.out('悬挂引用（条目级）：' + (r.dangling.count ? r.dangling.count + ' 处' : '无'));
  if (verbose) {
    r.dangling.list.forEach((d) => {
      ctx.out('  · ' + d.at + ' → ' + d.project + '/' + d.id + '#' + d.item + '（' + d.reason + '）');
      ctx.out('      ' + d.detail);
    });
  }

  const m = r.migration;
  ctx.out('迁移（契约 §6）：可迁移 ' + m.eligible + ' ｜ 已条目化 ' + m.itemized + ' ｜ 无内容 '
    + m.noContent + ' ｜ 不在范围（无 <li>）' + m.outOfScope + ' ｜ **跳过 ' + m.skipped.length + '**');
  if (m.skipped.length) {
    ctx.out('  跳过原因分布：' + SKIP_REASONS.map((k) => k + ' ' + (m.reasonCounts[k] || 0)).join(' ｜ '));
    ctx.out('  ⚠ 跳过 = 在范围内但**回放不了**（契约 §6 要求整节点跳过、一个字节都不动）——'
      + '不是"没有需要迁移的"');
    if (verbose) {
      m.skipped.forEach((s) => {
        ctx.out('  · ' + s.nodeId + (s.topic ? '「' + s.topic + '」' : '') + '  ' + s.reason
          + '：' + s.detail);
        ctx.out('      ' + s.action);
      });
    }
  }
  r.warnings.forEach((w) => ctx.out(w));
}
