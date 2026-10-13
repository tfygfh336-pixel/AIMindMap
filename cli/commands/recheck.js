/* ============================================================
 * cli/commands/recheck.js — 条目复校（S4）：`recheck <项目> …`
 * ------------------------------------------------------------
 * 一句话：**让"库里这条还成不成立"能被机器判出来，并给出可执行的下一步。**
 *
 * ## 契约（`docs/ITEM-MODEL.md`）
 *   · §1：`verified` 是 **`{at,by,how}` 三字段全必填**的记录，**缺失 = 未核**（不是布尔、不写 null）。
 *   · §12（S4 那一句）：`verified` 是"**怎么核的**"的记录 ⇒ 复校**不猜**内容对不对，只判两件事：
 *       ① 出处（`src`）今天还指得着吗；② 有没有留下"怎么核的"的记录。
 *   · §3 通用约定：失败退出码 1 且 stdout 以 `error: ` 开头；`--json` 是**一份**可解析 JSON。
 *   · `--src` 的过滤口径与本工程其它面**同一条**：**空 needle 不是过滤条件**（契约句的唯一权威在
 *     `src/item-index.js` 的 `srcMatches()` 注释里；检索面 `passItemFilters` 的 `if (f.src)` 同理）
 *     ⇒ `--src=`（显式空串）与不给 `--src` 同义，`--json` 回显 `filteredBySrc: null`
 *     （收准前回显的是 `""` —— 那会被读成"给了一个空过滤器"，与 `search` 面同一个输入两种口径）。
 *     判定与读数细节写在下面 `srcFilter` 那一段上（**动作现场**，别只活在这段文件头里）。
 *
 * ## 三个判定类（**= `src/item-src.js` 的 VERDICTS，别处不许另立一套**）
 *   · `ok`            —— 条目有出处、出处判得过（或本身没有文件型出处），**且有核验记录**
 *   · `needs-recheck` —— 需要人或模型看一眼：没核过 / 没出处 / 行号漂了 / 核验后源文件改过 /
 *                        URL·命令型出处不可机核 / 认不出的出处形状 / `supersededBy` 悬挂
 *   · `src-gone`      —— 出处**失效**：文件没了、读不了，或引文在那份文件里找不到了
 *
 * 三类之外还有一组**计数**（`noSrc` / `unverified` / `stale` / `superseded` / `dangling`）——
 * 它们与三类**不是**同一维的东西（前者是"这条为什么被点名"，后者是"点到的条落在哪一类"）。
 * 每个数字的判据都印在 `--json` 的 `criteria` 里，避免"读数被当成约定"。
 *
 * ## 只读是**默认**，写回要**显式**要
 * 不带 `--write-verified` 时：**一次盘都不写**（连 `.changes.jsonl` 也不动 —— 工程纪律：
 * 只读命令不该在盘上留痕）。确认之后用：
 *     recheck <项目> --write-verified --how "读了 src 指向的源码行"
 * **写回范围（两条规则，别猜）**：
 *   · 不带 `--only`：给**出处这一维判得过**的条目写 —— 即"除『还没核验记录』外没有别的问题"的那些。
 *     ⚠️ 判据刻意**不是**"当前是 `ok`"：迁移刚落地时**所有**条目都没核过 ⇒ `ok` 恒为 0 ⇒
 *     若按 `ok` 取，本功能最该工作的场景（大批补核验记录）永远无事可做。
 *     出处失效 / 引文找不到 / 行号越界 / 源文件改过 / 无出处 / 不可机核 / 形状认不出 ⇒ **不写**
 *     （**逐条点名 + 给出路**，不许静默少写）：先修出处，或核完用 `--only` 逐条点名。
 *   · 带 `--only <itemIds>`：按点名写（我逐条核过、逐条负责）。
 * `--how` 是**必填**的：取不到"怎么核的"就不写 —— 空核验记录会让"已核"永远为真（本工程最忌的假绿）。
 *
 * ## 为什么写回**默认拒绝**碰 `src-gone` 的条目
 * 给出处已经失效的条目写"我核过了"，就是记下一条假话。确认真核过（例如源码确实不在本机、
 * 你按别的方式核了）⇒ 显式加 `--force`，且回显会说出来。
 *
 * ## `verified` 写进去以后 `detail` **一个字节都不动**
 * `renderDetail` 不看 `verified` ⇒ 派生缓存不该因为核验记录变化（本命令也**不**顺手"修"
 * `detail` —— 那属于 `render-detail` 的活，混进来就有"核验时悄悄改了内容"的风险）。
 *
 * ## 与 `health` 的分工（别把两者做成两份实现）
 * 本文件导出的 `scanProject()` 是**条目层复校判定的唯一实现处**；
 * `cli/commands/health.js` 直接 require 它做聚合（读数），不重新判一遍。
 * ============================================================ */
'use strict';

const path = require('path');
const itemSrc = require('../../src/item-src.js');
const itemIndex = require('../../src/item-index.js');
const { SKIP_WRITE } = require('../core.js');

/** 工程根：`src` 里相对路径出处的**默认**根（`CHANGELOG.md:713` 指的就是工程根下那份） */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 列表的缺省上限（**只是打印的条数**，不是判定的范围：计数永远是全量的） */
const DEFAULT_LIST = 50;

/** 「这次要写什么」没得写时，为什么（回显里说出来，别静默 0） */
const NO_WRITE_HINT = '（只给判定为 `ok` 的条目写核验记录；要指定具体条目用 `--only i-a,i-b`）';

/* ============================================================================
 * 一、小工具
 * ========================================================================== */

function nowIso() { return new Date().toISOString(); }

/** 节点标题的安全展示（回显点名要能认人；不是判定，只是可读性） */
function labelOf(nodeId, topic) {
  return topic ? (nodeId + '「' + topic + '」') : String(nodeId);
}

/** kebab 的 `--only` 值 → 条目 id 数组（**复用 S3 的归一实现**，别在别处再切一遍） */
function onlyFromArgs(ctx) {
  if (ctx.args.only === undefined) return [];
  if (ctx.args.only === true) {
    ctx.error('--only 需要一个或多个条目 id（逗号分隔）：--only i-a,i-b');
  }
  return itemIndex.normalizeItemIds(ctx.args.only);
}

/** 每个 reason 对应的**可执行下一步**（封闭映射；没有映射的 reason ⇒ 开发期错误，不是数据问题） */
const NEXT_STEP = Object.freeze({
  'no-src': (project, e) => '补出处：`item-edit ' + project + ' ' + e.nodeId + ' ' + e.itemId
    + ' --src "文件:行::引文"`，或按别的凭据核完写回：`recheck ' + project + ' --only ' + e.itemId
    + ' --write-verified --how "怎么核的"`',
  'src-gone': (project, e) => '出处失效 —— 换一条现在指得着的：`item-edit ' + project + ' ' + e.nodeId
    + ' ' + e.itemId + ' --src "文件:行::引文"`（内容已随源头消失就 `item-remove ' + project + ' '
    + e.nodeId + ' ' + e.itemId + '`，或以 `--supersededBy` 指过去）',
  'quote-missing': (project, e) => '引文不在那份文件里了 —— 先确认内容是否还成立，再改引文或改内容：'
    + '`item-edit ' + project + ' ' + e.nodeId + ' ' + e.itemId + ' --src "文件:行::新引文"`',
  'line-out-of-range': (project, e) => '行号漂了（文件短了）—— 重新定位后改 `--src`：'
    + '`item-edit ' + project + ' ' + e.nodeId + ' ' + e.itemId + ' --src "文件:新行::引文"`',
  'file-changed': (project, e) => '核验之后源文件改过 —— 重新读一遍出处，再写回新记录：`recheck '
    + project + ' --only ' + e.itemId + ' --write-verified --how "读了改动后的 <文件>:<行>"`',
  'unverifiable-url': (project, e) => 'URL 出处要人/模型去看（复校不发起网络访问）；核完写回：`recheck '
    + project + ' --only ' + e.itemId + ' --write-verified --how "看了 <URL>（什么时候、看到的什么）"`',
  'unverifiable-command': (project, e) => '命令型出处要人/模型去跑（复校不代跑）；核完写回：`recheck '
    + project + ' --only ' + e.itemId + ' --write-verified --how "跑了 <命令>，输出 …"`',
  'unrecognized-src': (project, e) => '出处形状认不出来 —— 改成契约 §1 认的形状（`file:line` / URL / 命令），'
    + '带引文写 `file:line::引文`：`item-edit ' + project + ' ' + e.nodeId + ' ' + e.itemId + ' --src "…"`',
  'unverified': (project, e) => '没有核验记录 —— 核完写回：`recheck ' + project + ' --only ' + e.itemId
    + ' --write-verified --how "怎么核的"`',
  'superseded-unknown': (project, e) => '`supersededBy` 悬挂 —— 指向一条现在不存在的条目：改指向，'
    + '或补上那条（`item-edit ' + project + ' ' + e.nodeId + ' ' + e.itemId + ' --md "…"` 之外请用'
    + ' `item-*` 系列新建后再改指）'
});

/** 一个条目的下一步（按 reason 顺序去重） */
function nextStepsOf(entry, project) {
  const out = [];
  entry.reasons.forEach((r) => {
    const fn = NEXT_STEP[r.code];
    if (!fn) return;
    const step = fn(project, entry);
    if (out.indexOf(step) < 0) out.push(step);
  });
  return out;
}

/** 对外的条目记录形状（**唯一投影处**：内部记录带 `_item` 引用，绝不能进 JSON） */
function publicEntry(e, project) {
  const out = {
    nodeId: e.nodeId,
    nodeTopic: e.nodeTopic,
    path: e.path.slice(),
    itemId: e.itemId,
    type: e.type,
    verdict: e.verdict,
    reasons: e.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    refs: e.refs,
    src: e.src.slice(),
    verified: e.verified,
    nextSteps: nextStepsOf(e, project)
  };
  if (e.verifiedAt) out.verifiedAt = e.verifiedAt;
  if (e.stale) out.stale = true;
  if (e.superseded) out.superseded = true;
  return out;
}

/* ============================================================================
 * 二、全项目扫描（**条目层复校判定的唯一实现处**；health 复用）
 * ========================================================================== */

/** 深度优先收集节点（判定顺序 = 这一份 DFS 顺序 ⇒ 读数确定性的前提） */
function walkNodes(root, fn) {
  (function dfs(n) {
    if (!n) return;
    fn(n);
    (n.children || []).forEach(dfs);
  })(root);
}

/** 一个项目数据的「节点 id 集合 + 条目 id 集合」（跨项目悬挂检测用；纯函数） */
function indexOf(data) {
  const nodes = new Set();
  const items = new Set();
  walkNodes(data && data.data, (n) => {
    nodes.add(n.id);
    (Array.isArray(n.items) ? n.items : []).forEach((it) => {
      if (it && it.id !== undefined && it.id !== null) items.add(String(it.id));
    });
  });
  return { nodes: nodes, items: items };
}

/**
 * 悬挂引用扫描（**条目级**）：`links[].item` / `assoc.members[].item` 指到一条不存在的条目。
 *
 * 判定顺序（与 `src/schema.js` 的节点级悬挂同一套口径，但**不重复实现节点级**那一条 ——
 * 节点级悬挂由 G2 的 `validate` 负责，本命令只补上契约 §7 新增的**条目级**那一档）：
 *   项目读不到 ⇒ `project-unreadable`；节点不存在 ⇒ `node-missing`；条目不存在 ⇒ `item-missing`
 *
 * @param opts.projectIndex `(项目名) => {nodes:Set, items:Set} | null`（调用方注入；纯函数里不做 I/O）
 */
function scanDangling(data, opts) {
  const o = opts || {};
  const projectIndex = o.projectIndex;
  const out = [];
  if (!projectIndex) return out;
  const shard = (name) => { try { return projectIndex(name) || null; } catch (e) { return null; } };

  const check = (kind, at, from, fromTopic, ref) => {
    if (!ref || ref.item === undefined || ref.item === null || ref.item === '') return;
    if (!ref.project || !ref.id) return;                       // 结构问题由 validate 报，这里不重复
    const idx = shard(ref.project);
    const target = ref.project + '/' + ref.id + '#' + ref.item;
    let reason = null;
    if (!idx) reason = 'project-unreadable';
    else if (!idx.nodes.has(ref.id)) reason = 'node-missing';
    else if (!idx.items.has(String(ref.item))) reason = 'item-missing';
    if (!reason) return;
    out.push({
      kind: kind, at: at, from: from, fromTopic: fromTopic || null,
      project: ref.project, id: ref.id, item: ref.item, reason: reason,
      detail: reason === 'project-unreadable' ? ('目标项目读不到：' + ref.project + '（悬挂无法判定，'
        + '不等于没问题）')
        : reason === 'node-missing' ? ('目标节点不存在：' + ref.project + '/' + ref.id)
          : ('条目不存在：' + target + '（悬挂引用；出口 `links-prune` / `assoc-prune`）')
    });
  };

  walkNodes(data && data.data, (n) => {
    (Array.isArray(n.links) ? n.links : []).forEach((l, i) => {
      check('link', labelOf(n.id, n.topic) + ' links[' + i + ']', n.id, n.topic, l);
    });
  });
  (Array.isArray(data && data.assoc) ? data.assoc : []).forEach((a) => {
    if (!a || !Array.isArray(a.members)) return;
    a.members.forEach((m, i) => {
      check('assoc', '关联「' + (a.title || a.id) + '」members[' + i + ']', a.id || null, a.title || null, m);
    });
  });
  return out;
}

/**
 * 扫一个项目：逐条判、逐条点名、给出计数与原因分布（**纯函数 + 读盘缓存**）。
 *
 * @param {object} data 项目数据（`{meta, format, data, assoc?}`）
 * @param {{root?:string, cache?:object, itemIds?:(Set|undefined), project?:string,
 *          projectIndex?:Function, model?:object}} [opts]
 * @returns {{entries, dangling, counts, reasonCounts, indexes, root, cache}}
 *   `entries` 里的内部字段 `_item` 指向**原条目对象**（写回时用）；对外输出一律走 `publicEntry()`。
 */
function scanProject(data, opts) {
  const o = opts || {};
  const root = o.root || REPO_ROOT;
  const cache = o.cache || itemSrc.createCache();
  const indexes = itemIndex.buildIndexes(data && data.data);
  const itemIds = new Set(Object.keys(indexes.itemById));   // 全项目条目 id：`supersededBy` 悬挂的判据

  const entries = [];
  indexes.entries.forEach((entry) => {
    (entry.items || []).forEach((rec) => {
      const insp = itemSrc.inspect(rec.item, root, { cache: cache, itemIds: itemIds });
      entries.push({
        nodeId: entry.node.id,
        nodeTopic: entry.node.topic,
        path: entry.path.slice(),
        itemId: rec.item.id,
        type: rec.item.type,
        verdict: insp.verdict,
        reasons: insp.reasons,
        refs: insp.refs,
        src: insp.src,
        verified: insp.verified,
        verifiedAt: insp.verifiedAt,
        stale: insp.stale,
        superseded: insp.superseded,
        dangling: insp.dangling,
        _item: rec.item
      });
    });
  });

  // —— 悬挂引用：`supersededBy`（逐条，判定在 item-src.inspect 里）+ `links[].item` /
  //    `assoc.members[].item`（逐处，判定见 scanDangling）—— 一张清单、一个计数 ——
  const dangling = [];
  entries.forEach((e) => {
    e.dangling.forEach((d) => {
      dangling.push({
        kind: 'supersededBy', at: labelOf(e.nodeId, e.nodeTopic) + '#' + e.itemId,
        from: e.nodeId, fromTopic: e.nodeTopic || null,
        project: o.project || null, id: e.nodeId, item: String(e._item.supersededBy),
        reason: 'item-missing', detail: d.detail
      });
    });
  });
  scanDangling(data, o).forEach((d) => dangling.push(d));
  dangling.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));   // 确定性：同状态逐字节相同

  const counts = {
    nodes: indexes.entries.length,
    itemizedNodes: indexes.entries.filter((e) => e.itemized).length,
    items: entries.length,
    ok: entries.filter((e) => e.verdict === 'ok').length,
    needsRecheck: entries.filter((e) => e.verdict === 'needs-recheck').length,
    srcGone: entries.filter((e) => e.verdict === 'src-gone').length,
    noSrc: entries.filter((e) => e.src.length === 0).length,
    unverified: entries.filter((e) => !e.verified).length,
    stale: entries.filter((e) => e.stale === true).length,
    superseded: entries.filter((e) => e.superseded === true).length,
    dangling: dangling.length
  };

  // 原因分布：**按 REASONS 的固定顺序**出键（同状态两次运行逐字节相同，不靠遇到顺序）
  const reasonCounts = {};
  itemSrc.REASONS.forEach((code) => { reasonCounts[code] = 0; });
  entries.forEach((e) => e.reasons.forEach((r) => {
    if (reasonCounts[r.code] === undefined) reasonCounts[r.code] = 0;
    reasonCounts[r.code]++;
  }));

  return {
    entries: entries, dangling: dangling, counts: counts, reasonCounts: reasonCounts,
    indexes: indexes, root: root, cache: cache
  };
}

/** 每个数字的**判据**（写进 `--json`；"读数"最容易被当约定，所以把它写死在输出里） */
const CRITERIA = Object.freeze({
  ok: '条目有 `src`（或没有文件型出处）且每条出处都判得过，并且有 `verified` 记录',
  'needs-recheck': '没核过（`verified` 缺失）／没出处／行号越界／核验后源文件改过／URL·命令型不可机核／'
    + '出处形状认不出／`supersededBy` 悬挂 —— 需要人或模型看一眼',
  'src-gone': '出处文件不存在或读不了，或引文在那份文件里找不到（`file:line::引文`）',
  noSrc: '没有 `src` 字段（与"出处失效"不同：它从来就没有出处）',
  unverified: '没有 `verified` 字段（契约 §1：缺失 = 未核）—— 与 `needs-recheck` 有交集',
  stale: '出处文件的 mtime 晚于该条目的 `verified.at`（"核过之后源又改过"；无核验记录 ⇒ 判不了 ⇒ 不计）',
  superseded: '条目带 `supersededBy`（被取代；契约 §7：只增不减，保留）',
  dangling: '`links[].item` / `assoc.members[].item` / `supersededBy` 指向不存在的条目（逐处点名）'
});

/* ============================================================================
 * 三、命令体
 * ========================================================================== */

module.exports = {
  /**
   * `recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json]
   *          [--write-verified --how "…"] [--dry-run]`
   */
  recheck(ctx) {
    const project = ctx.projectName;
    if (!project) {
      ctx.error('用法: recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--json] '
        + '[--write-verified --how "怎么核的"] [--dry-run]');
    }
    // ---- 参数形状（一律在写盘之前判；验收口径见文件头）----
    const writeVerified = !!ctx.args.writeVerified;
    const how = ctx.args.how;
    if (how !== undefined && !writeVerified) {
      ctx.error('--how 只在 --write-verified 时才有意义（`verified` 是三字段全必填的记录：at/by/how）。'
        + '要清掉某条的核验记录请用 `item-edit <项目> <节点id> <itemId> --clear-verified`。');
    }
    if (writeVerified && (how === undefined || how === true || !String(how).trim())) {
      ctx.error('--write-verified 必须同时给 --how "…"：一句话说清**怎么核的**。'
        + '取不到就不写 —— 空核验记录会让"已核"永远为真（本工程最忌的假绿）。');
    }
    const only = onlyFromArgs(ctx);
    /* `--src` 的**两层分工**（契约句的**唯一权威**在 `src/item-index.js` 的 `srcMatches()` 注释里：
     * **空 needle 不是过滤条件 —— 判断"有没有过滤"归过滤层**；检索面 `passItemFilters` 开头的
     * `if (f.src)` 判的就是"**给了没有**"，判的不是它的真值）。本命令层同一语义：
     *   · `--src=`（**显式空串**）与不给 `--src` 同义 ⇒ `filteredBySrc: null`（**不是 `""`** ——
     *     空串会被读成"给了一个空过滤器"，与检索面**同一个输入两种口径**，正是第五批收掉的那类漂移）；
     *   · 裸写 `--src`（没有值）解析成 `true` ⇒ 同样按"没给过滤"（`parseArgs` 的行 101）；
     *   · 非空才真过滤（`listed` 与文本面的"过滤后 N 条"都据此）。
     * ⚠️ 只认**字面空串**、**不 trim**：检索面对 `--src "  "` 是按"给了过滤"走的（`"  "` 为真值），
     * 两边必须同口径 —— 想统一宽度口径就得连检索面一起改，不许只在这里 trim ✗。 */
    const rawSrc = ctx.args.src;
    const srcFilter = (rawSrc === undefined || rawSrc === true || rawSrc === '') ? null : String(rawSrc);
    const limit = ctx.intOption('limit', { min: 1, max: itemIndex.LIMIT_MAX, def: DEFAULT_LIST });
    const root = ctx.args.root === undefined
      ? REPO_ROOT : path.resolve(String(ctx.args.root));

    const { data } = ctx.read();                       // 只读一次：判定与写回都以同一份快照为据

    // 跨项目悬挂检测要读别的项目的 JSON —— **在 mutate 之外**做（fn 内禁止 I/O）
    const memo = new Map();
    const self = indexOf(data);
    const projectIndex = (name) => {
      if (name === project) return self;
      if (memo.has(name)) return memo.get(name);
      let v = null;
      try { v = indexOf(ctx.store.read(name).data); } catch (e) { v = null; }
      memo.set(name, v);
      return v;
    };

    const scan = scanProject(data, { root: root, project: project, projectIndex: projectIndex });
    let listed = scan.entries.filter((e) => !srcFilter || itemSrc.matchesSrc({ src: e.src }, srcFilter));
    if (only.length) {
      const have = new Set(listed.map((e) => e.itemId));
      const missing = only.filter((id) => !have.has(id));
      if (missing.length) {
        ctx.error('--only 里的条目不存在（或不在 --src 过滤范围里）: ' + missing.join(', ')
          + ' —— 去掉 --only / 放宽 --src，或先看这个项目有哪些条目：`recheck ' + project
          + ' --json` 的 byVerdict 里逐个列着 itemId（也可 `get <项目> <节点id> --json` 看 items 摘要）。');
      }
      listed = listed.filter((e) => only.indexOf(e.itemId) >= 0);
    }

    const byVerdict = (v) => listed.filter((e) => e.verdict === v);
    const needs = byVerdict('needs-recheck');
    const gone = byVerdict('src-gone');
    const okList = byVerdict('ok');

    /* ---------------------------------------------------------------- 写回分支 */
    if (writeVerified) {
      // 目标集（**两条规则，都在这里说清**）：
      //   · 不带 `--only`：给"**出处这一维判得过**"的条目写（= 除"没核验记录"外没有别的问题）。
      //     为什么不是"只给 ok 写"：迁移刚落地时**所有**条目都没核过 ⇒ ok 恒为 0 ⇒ 批量写回永远无事可做
      //     （那正是本功能最该工作的场景）。⇒ 判据取"有没有**必须先修**的问题"，不是"当前是不是绿的"。
      //   · 带 `--only <itemIds>`：按点名写（我逐条核过、逐条负责）。
      // 被排除掉的那些**逐条点名 + 给原因**（不许静默少写）。
      const writable = (e) => e.reasons.every((r) => r.code === 'unverified' || r.code === 'superseded-unknown')
        && e.verdict !== 'src-gone';
      const targets = only.length ? listed : listed.filter(writable);
      const blocked = targets.filter((e) => e.verdict === 'src-gone');
      if (blocked.length && !ctx.args.force) {
        ctx.error('这些条目的出处**已经失效**（src-gone），给它们写"我核过了"就是记下一条假话 —— 默认拒绝：\n'
          + blocked.slice(0, 10).map((e) => '  · ' + labelOf(e.nodeId, e.nodeTopic) + '#' + e.itemId
            + ' ← ' + (e.reasons.map((r) => r.code).join('/') || '出处失效')).join('\n')
          + '\n出路：① 先修出处（`item-edit … --src "…"`）再复校；② 真核过（例如源码确实不在本机、'
          + '你按别的方式核了）⇒ 显式加 `--force`（回显会说明这是一次强写）。');
      }
      const skippedWhy = only.length ? [] : listed.filter((e) => targets.indexOf(e) < 0);
      const whyCounts = {};
      skippedWhy.forEach((e) => e.reasons.forEach((r) => {
        whyCounts[r.code] = (whyCounts[r.code] || 0) + 1;
      }));
      if (ctx.dryRun) {
        ctx.out('--dry-run：将给 ' + targets.length + ' 条写 verified{at,by,how:'
          + JSON.stringify(String(how)) + '}，**不写盘**');
        targets.slice(0, limit).forEach((e) => ctx.out('  · ' + labelOf(e.nodeId, e.nodeTopic) + '#'
          + e.itemId + '  [' + e.verdict + ']'));
        if (targets.length > limit) ctx.out('  …另有 ' + (targets.length - limit) + ' 条（--limit 调整显示；'
          + 'dry-run 的写回是**全量**的）');
        if (!targets.length) ctx.out('  没有可写回的条目' + NO_WRITE_HINT);
        if (skippedWhy.length) {
          ctx.out('  另有 ' + skippedWhy.length + ' 条**不写**（出处这一维判不过，先修再核）：'
            + Object.keys(whyCounts).map((k) => k + ' ' + whyCounts[k]).join(' ｜ ')
            + ' —— 逐条见 `recheck ' + project + '` 的三类清单');
        }
        return;
      }
      const at = nowIso();                              // ⚠️ 进 mutate 之前算好（fn 里不许读时钟）
      const by = ctx.writer;                            // 与 .changes.jsonl 的 writer 同源
      const plan = new Map();                           // nodeId → itemId[]
      targets.forEach((e) => {
        if (!plan.has(e.nodeId)) plan.set(e.nodeId, []);
        plan.get(e.nodeId).push(e.itemId);
      });
      let changed = [];
      ctx.mutate((d) => {
        changed = [];
        walkNodes(d.data, (n) => {
          const ids = plan.get(n.id);
          if (!ids) return;
          (Array.isArray(n.items) ? n.items : []).forEach((it) => {
            if (!it || ids.indexOf(it.id) < 0) return;
            it.verified = { at: at, by: by, how: String(how) };
            // 「这一次写」发生在何时、由谁：与 `item-edit` 同一口径（只有真的改了才刷新）
            it.at = at; it.by = by;
            changed.push({ nodeId: n.id, itemId: it.id });
          });
        });
        // 盘上一条都没找到（例如并发下被删了）⇒ **一次都不写**，绝不落一条空日志
        if (!changed.length) return SKIP_WRITE;
        return d;
      });
      if (!changed.length) {
        ctx.error('没有写回任何条目：计划里的 ' + plan.size + ' 个节点在当前数据里都找不到那些条目'
          + '（可能刚被别处删掉）。项目盘上**零改动**。');
      }
      const payload = {
        ok: true, project: project, write: 'verified', how: String(how), at: at, by: by,
        written: changed.length, itemIds: changed.map((c) => c.itemId),
        targetsRule: only.length ? '--only 点名的条目（逐条负责）'
          : '出处这一维判得过的条目（除"没核验记录"外没有别的问题）',
        notWritten: {
          count: skippedWhy.length,
          reasonCounts: whyCounts,
          itemIds: skippedWhy.map((e) => e.itemId)
        },
        counts: scan.counts, criteria: CRITERIA
      };
      if (ctx.args.json) ctx.outJson(payload);
      else {
        ctx.out('已写回核验记录 ' + changed.length + ' 条（verified{at,by,how}）：'
          + changed.slice(0, limit).map((c) => c.itemId).join(', ')
          + (changed.length > limit ? ' …（共 ' + changed.length + ' 条）' : ''));
        ctx.out('  怎么核的：' + String(how));
        ctx.out('  写回范围：' + payload.targetsRule);
        if (skippedWhy.length) {
          ctx.out('  另有 ' + skippedWhy.length + ' 条**没写**（出处这一维判不过，先修再核）：'
            + Object.keys(whyCounts).map((k) => k + ' ' + whyCounts[k]).join(' ｜ ')
            + ' —— 逐条见 `recheck ' + project + '`');
        }
        ctx.out('  下一步：`recheck ' + project + '` 复查一遍（写回的那些应当转成「已就绪」）');
      }
      return;
    }

    /* ---------------------------------------------------------------- 只读分支 */
    const json = {
      ok: true,
      project: project,
      root: root,
      scanned: { nodes: scan.counts.nodes, itemizedNodes: scan.counts.itemizedNodes, items: scan.counts.items },
      counts: scan.counts,
      reasonCounts: scan.reasonCounts,
      criteria: CRITERIA,
      // `filteredBySrc`：`null` = **没给过滤**（判据见上面 `srcFilter` 那段的两层分工契约句）；
      // 只有非空子串才是"真的过滤了"，读数与 `search --src` 同一口径。
      listed: { limit: limit, filteredBySrc: srcFilter, filteredByOnly: only, truncated: needs.length > limit || gone.length > limit },
      byVerdict: {
        ok: okList.slice(0, limit).map((e) => publicEntry(e, project)),
        needsRecheck: needs.slice(0, limit).map((e) => publicEntry(e, project)),
        srcGone: gone.slice(0, limit).map((e) => publicEntry(e, project))
      },
      dangling: scan.dangling,
      nextSteps: globalNextSteps(project, scan)
    };
    if (ctx.args.json) { ctx.outJson(json); return; }

    // ---- 文本：三类 + 计数 + 逐条点名 + 可执行下一步 ----
    const c = scan.counts;
    ctx.out('# 复校 ' + project + '（条目 ' + c.items + ' 条 / 条目化节点 ' + c.itemizedNodes
      + ' 个 / 总节点 ' + c.nodes + ' 个）');
    ctx.out('三类：已就绪 ' + c.ok + ' ｜ 需复核 ' + c.needsRecheck + ' ｜ 出处失效 ' + c.srcGone
      + (srcFilter ? '（--src ' + JSON.stringify(srcFilter) + ' 过滤后：' + listed.length + ' 条）' : ''));
    ctx.out('计数（与三类有交集的另几维）：无出处 ' + c.noSrc + ' ｜ 未核 ' + c.unverified
      + ' ｜ 核验后源文件改过 ' + c.stale + ' ｜ 被取代 '
      + c.superseded + ' ｜ 引用悬挂 ' + c.dangling);
    const dist = Object.keys(scan.reasonCounts).filter((k) => scan.reasonCounts[k] > 0);
    if (dist.length) {
      ctx.out('原因分布：' + dist.map((k) => k + ' ' + scan.reasonCounts[k]).join(' ｜ '));
    }

    const dump = (title, list) => {
      if (!list.length) return;
      ctx.out('');
      ctx.out(title + ' ' + list.length + ' 条'
        + (list.length > limit ? '（下列前 ' + limit + ' 条；计数是全量的 —— --limit 调整）' : '') + '：');
      list.slice(0, limit).forEach((e) => {
        ctx.out('  · ' + labelOf(e.nodeId, e.nodeTopic) + '#' + e.itemId + '  [' + e.type + ']'
          + (e.verified ? '' : ' 未核') + (e.stale ? ' 源已改' : ''));
        e.reasons.forEach((r) => ctx.out('      原因 ' + r.code + '：' + r.detail));
        nextStepsOf(e, project).forEach((s) => ctx.out('      下一步：' + s));
      });
    };
    dump('需复核', needs);
    dump('出处失效', gone);
    if (okList.length) {
      ctx.out('');
      ctx.out('已就绪 ' + okList.length + ' 条：无需动作'
        + (c.ok > limit && !srcFilter ? '（例如 ' + okList.slice(0, 3).map((e) => e.itemId).join(', ') + ' …）' : ''));
    }
    if (scan.dangling.length) {
      ctx.out('');
      ctx.out('引用悬挂 ' + scan.dangling.length + ' 处：');
      scan.dangling.forEach((d) => ctx.out('  · ' + d.at + ' → ' + d.project + '/' + d.id
        + '#' + d.item + '　' + d.detail));
    }
    const steps = globalNextSteps(project, scan);
    ctx.out('');
    ctx.out('下一步（可执行）：');
    steps.forEach((s) => ctx.out('  · ' + s));
  },

  // 导出给 health 复用（**判定只有一处实现**）
  scanProject: scanProject,
  scanDangling: scanDangling,
  indexOf: indexOf,
  publicEntry: publicEntry,
  nextStepsOf: nextStepsOf,
  walkNodes: walkNodes,
  CRITERIA: CRITERIA,
  REPO_ROOT: REPO_ROOT,
  DEFAULT_LIST: DEFAULT_LIST
};

/** 全局下一步（按当前读数挑出**真的能用**的那几条；零发现时明说"无需动作"） */
function globalNextSteps(project, scan) {
  const c = scan.counts;
  const steps = [];
  if (c.noSrc) {
    steps.push('补出处（' + c.noSrc + ' 条没有 `src`）：`item-edit ' + project
      + ' <节点id> <itemId> --src "文件:行::引文"` —— 出处是可复核的前提');
  }
  if (c.srcGone) {
    steps.push('救失效出处（' + c.srcGone + ' 条）：逐条看上面「出处失效」的 detail，改 `--src` 或删/取代该条');
  }
  if (c.stale) {
    steps.push('重核改过的源（' + c.stale + ' 条）：源文件在核验之后改过 —— 重读后写回新记录（见每条下一步）');
  }
  if (c.unverified) {
    steps.push('写核验记录（' + c.unverified + ' 条未核）：`recheck ' + project
      + ' --write-verified --how "读了 src 指向的源码行"`（只写判定为「已就绪」的那些）');
  }
  if (c.dangling) {
    steps.push('清悬挂引用（' + c.dangling + ' 处）：`links-prune ' + project + '` / `assoc-prune '
      + project + '`（条目级悬挂由它们收拾；`supersededBy` 那条要改指向）');
  }
  if (!steps.length) steps.push('三类全空 ⇒ 无需动作（项目里没有条目；先 `migrate items` 或 `item-add`）');
  return steps;
}
