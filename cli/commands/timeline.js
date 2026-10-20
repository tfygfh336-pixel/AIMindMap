/* ============================================================
 * cli/commands/timeline.js — 「时间线」（只读）：哪些笔记最近被改过
 * ------------------------------------------------------------
 * 产品名册里它叫 `TL`「时间线」（`docs/FEATURES.md` §3），台账编号 `W2`。
 * 命令名照既有先例取代号的中文能力名（`SC`→`source-chain`、`LP`→`learn-path`、`DM`→`draft-map`）。
 *
 * ## 它答的问题，以及它**不**答什么（与 `changes` 的分工）
 *   · `changes`  —— "自我这个锚点以来**谁**动过**哪些对象**"（写入事件；按 `rev` 排；为了并发避让）
 *   · `timeline` —— "**哪些笔记**最近被改过"（节点；按**时间**排；为了"看看最近做了什么"）
 * 两者读的是**同一份** `.changes.jsonl`，也共用**同一份**投影实现（`src/changes.js` 的
 * `lastTouchedByNode`）—— 本文件只负责读盘、排序与回显，不自己拆日志键。
 *
 * ## 时间从哪来（**这道题的全部难点**）
 * 节点上**没有** `createdAt`/`updatedAt`（`src/schema.js` 的 `NODE_FIELDS` 15 项里没有这一类），
 * 条目层的 `at` 在全库又是空集（10 个项目 2310 个节点全是 v2、0 个条目）。
 * ⇒ 唯一可用的真值是**变更日志**（`src/changes.js` 文件头：它由唯一写盘出口顺带产生，
 * GUI 保存那条路径也调它）。三种结局**必须可分辨**，本命令的三档就是它：
 *   · `changes`       —— 窗口内出现过 ⇒ **精确**的最后改动时间；
 *   · `before-window` —— 日志在、但这条没出现 ⇒ 只知"**早于**窗口起点"（给上界，不给假时间）；
 *   · `unknown`       —— 这个项目**没有日志** ⇒ 一条时间都给不出（不是"时间 = 0"）。
 * ⚠️ **不用 `origin.at` 冒充改动时间**：它是**导入**那一刻，导入后又被改过（而那次改动已滑出窗口）
 *    的节点会因此报出一个更早的假时间。它只作 `importedAt` 信息列随行。
 *
 * ## 两条硬纪律
 *   · **不读时钟**：相对的 `--since 7d` 需要一个显式的 `--now <ISO>`，不给就**报错**
 *     （读墙钟 ⇒ 同一条命令两跑的界不同 ⇒ `--json` 的"两跑 sha256 相同"当场破）；
 *   · **零写盘**：不进 `cli/core.js` 的 `WRITE_COMMANDS`、**不记热度**（照 `source-chain` 的纪律：
 *     "零写盘（不记热度 ⇒ `--json` 两跑逐字节相同）"）。
 *
 * ## 排序为什么有唯一答案（判据靠它）
 * 键 = `at` 降序 → `project` 升序 → `nodeId` 升序。`(project, nodeId)` **全库唯一**
 * ⇒ 任意两行都有确定的先后，**同时间戳也有唯一答案且能手算复算**。
 * 这不是洁癖：实测 1785 条有精确时间的行里 **1187 条（66.5%）落在只有 28 个并列组里**，
 * 最大一组 **364 个节点**同在一毫秒（一次写盘改了很多节点，`at` 逐字相同）。
 * 项目名比较**不用 `localeCompare`**（它按运行环境的 locale/collation 定序 ⇒ 换机器顺序就变；
 * 与 `cli/commands/project.js` 的 `compareProjectNames` 同一条理由）。
 * 没有精确时间的行一律排在**有时间的行之后**（`before-window` 与 `unknown` 各按 `project, nodeId`），
 * 它们**永远不插进**有时间的序列里 —— 那是"不编造位置"。
 * ============================================================ */
'use strict';

const fs = require('fs');
const changes = require('../../src/changes.js');
const itemIndex = require('../../src/item-index.js');

/** 人类可读的时间（本地时区，秒精度）—— **只用于文本档**；`--json` 一律 ISO（可复现） */
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '?');
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 项目名升序（**不用 `localeCompare`**：见文件头"排序"那段） */
function compareNames(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * 行间比较器 = 本命令的**唯一**排序口径（判据直接钉它）。
 * ① 有精确时间的行恒在没时间的行之前；② 有时间的按 `at` 降序；
 * ③ 其余（并列 / 没时间）按 `project` 升序 → `nodeId` 升序 ⇒ 全序，无并列。
 */
function compareRows(a, b) {
  const am = a.ms;
  const bm = b.ms;
  if (am !== null && bm !== null) {
    if (am !== bm) return bm - am;
  } else if (am !== null) {
    return -1;
  } else if (bm !== null) {
    return 1;
  }
  if (a.project !== b.project) return compareNames(a.project, b.project);
  return compareNames(a.nodeId, b.nodeId);
}

/**
 * 把一个项目折成"节点行"（**纯函数**：不读盘、不读时钟）。
 * @param {string} project 项目名
 * @param {*} root 树的根（`data.data`）
 * @param {object} touched `src/changes.js` 的 `lastTouchedByNode` 返回值
 * @param {boolean} hasLog 这个项目**有没有**变更日志（没有 ⇒ 整项目进 `unknown`）
 */
function rowsOfProject(project, root, touched, hasLog) {
  const rows = [];
  (function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    const here = path.concat([node.id]);
    const hit = hasLog ? touched.byNode.get(node.id) : null;
    let atSource = 'changes';
    let at = null;
    let ms = null;
    let rev = null;
    let before = null;
    if (hit) {
      at = hit.at; ms = hit.ms; rev = hit.rev;
    } else if (hasLog && touched.windowFrom) {
      atSource = 'before-window';
      before = touched.windowFrom;
    } else {
      atSource = 'unknown';
    }
    rows.push({
      project: project,
      nodeId: String(node.id),
      topic: String(node.topic === undefined || node.topic === null ? '' : node.topic),
      path: here,
      at: at,
      atSource: atSource,
      rev: rev,
      before: before,
      // 导入来源的**时刻**（`origin.at`）：只是信息列，**不参与排序、不参与 --since 判定**
      importedAt: (node.origin && typeof node.origin.at === 'string') ? node.origin.at : null,
      ms: ms
    });
    (node.children || []).forEach((c) => walk(c, here));
  })(root, []);
  return rows;
}

module.exports = {
  /**
   * `timeline [<项目>] [--since <ISO|Nd|Nh|Nm|Nw>] [--now <ISO>] [--limit n] [--json]`
   *
   * 不给项目名 ⇒ 全库（与 `changes [<项目>]` 同一形态：省略 = 汇总）。
   */  timeline(ctx) {
    /* ---------- 参数闸门（全部在碰盘之前判：写错的时间串不许静默变成"0 命中"）---------- */
    const limit = ctx.intOption('limit', { min: 0, def: 20 });
    const nf = itemIndex.parseNow(ctx.args.now);
    if (!nf.ok) ctx.error(nf.reason);
    const sf = itemIndex.parseSince(ctx.args.since, nf.value);
    if (!sf.ok) ctx.error('--since ' + sf.reason);

    /* ---------- 扫哪些项目 ---------- */
    const names = ctx.projectName ? [ctx.projectName] : ctx.store.list().map((p) => p.name).sort(compareNames);
    if (ctx.projectName && !fs.existsSync(ctx.store.projectFile(ctx.projectName))) {
      ctx.error('项目不存在: ' + ctx.projectName);
    }

    const rows = [];
    const skipped = [];
    const scanned = [];
    let badLines = 0;
    let entries = 0;
    let windowFrom = null;
    let windowTo = null;
    let unparsable = 0;
    let unresolvedKeys = 0;

    names.forEach((name) => {
      let data = null;
      try {
        data = ctx.store.read(name).data;
      } catch (err) {
        // 读不动的项目**跳过但看得见**（与 `search-all` 的 `skipped` 同一条纪律：不许静默少扫）
        skipped.push({ project: name, reason: String((err && err.message) || err) });
        return;
      }
      // 日志：路径的唯一推导处是 `store.changeLogFile`（别处不许自己拼）；解析的唯一实现在 `src/changes.js`
      let text = '';
      let hasLog = true;
      try { text = fs.readFileSync(ctx.store.changeLogFile(name), 'utf8'); } catch (e) { hasLog = false; }
      const parsed = changes.parseLog(text);
      const touched = changes.lastTouchedByNode(parsed.entries);
      scanned.push(name);
      badLines += parsed.badLines.length;
      entries += touched.entries;
      unparsable += touched.unparsable;
      unresolvedKeys += touched.unresolvedKeys;
      if (touched.windowFrom && (!windowFrom || touched.windowFrom < windowFrom)) windowFrom = touched.windowFrom;
      if (touched.windowTo && (!windowTo || touched.windowTo > windowTo)) windowTo = touched.windowTo;
      rows.push.apply(rows, rowsOfProject(name, data && data.data, touched, hasLog));
    });

    /* ---------- 排序 + 过滤 + 截断（三步都不含时钟）---------- */
    rows.sort(compareRows);
    const since = sf.value;
    const qualified = [];
    let excludedOld = 0;
    let excludedNoTime = 0;
    rows.forEach((r) => {
      if (since === null) { qualified.push(r); return; }
      if (r.ms === null) { excludedNoTime++; return; }
      if (r.ms >= since) qualified.push(r); else excludedOld++;
    });
    const shown = (limit > 0 && qualified.length > limit) ? qualified.slice(0, limit) : qualified;
    const truncated = shown.length < qualified.length;

    const countOf = (src) => rows.filter((r) => r.atSource === src).length;
    const summary = {
      projects: scanned.length,
      nodes: rows.length,
      withTime: countOf('changes'),
      beforeWindow: countOf('before-window'),
      unknown: countOf('unknown'),
      qualified: qualified.length,
      excludedOld: excludedOld,
      excludedNoTime: excludedNoTime,
      shown: shown.length,
      truncated: truncated
    };

    const sinceOut = (since === null) ? null : {
      raw: String(ctx.args.since),
      at: new Date(since).toISOString(),
      ms: since,
      relativeMs: sf.relative ? sf.relative.ms : null
    };
    const nowIso = (nf.value === null) ? null : new Date(nf.value).toISOString();

    /* ---------- `--json`：键序字面量固定、无时钟参与、排序是全序 ⇒ 两跑 sha256 相同 ---------- */
    if (ctx.args.json) {
      ctx.outJson({
        scope: ctx.projectName || null,
        now: nowIso,
        since: sinceOut,
        order: ['at desc', 'project asc', 'nodeId asc'],
        rows: shown.map((r) => ({
          project: r.project,
          nodeId: r.nodeId,
          topic: r.topic,
          path: r.path,
          at: r.at,
          atSource: r.atSource,
          rev: r.rev,
          before: r.before,
          importedAt: r.importedAt
        })),
        summary: summary,
        window: { from: windowFrom, to: windowTo, entries: entries, badLines: badLines },
        scanned: scanned,
        skipped: skipped,
        notes: {
          unparsableEntries: unparsable,
          unresolvedKeys: unresolvedKeys,
          timeUnknownRule: '没出现在日志窗口里的节点不给时间：日志在 ⇒ 只知"早于窗口起点"（before-window）；'
            + '没有日志 ⇒ 时间未知（unknown）。两者都不进 --since 的命中，但都在 summary 里计数。',
          whyNoOrigin: 'origin.at 是**导入**时刻，不是改动时刻 ⇒ 只作 importedAt 信息列，不参与排序与判定。'
        }
      });
      return;
    }

    /* ---------- 文本档 ---------- */
    ctx.out('时间线' + (ctx.projectName ? '（项目 ' + ctx.projectName + '）' : '（全库 ' + scanned.length + ' 个项目）')
      + ' · 节点 ' + summary.nodes + ' 条：有精确时间 ' + summary.withTime
      + ' · 只有上界 ' + summary.beforeWindow + ' · 时间未知 ' + summary.unknown);
    if (since !== null) {
      ctx.out('界：' + new Date(since).toISOString() + '（--since ' + ctx.args.since
        + (sf.relative ? ' = ' + sf.relative.ms + ' ms 前' : '')
        + (nowIso ? '，--now ' + nowIso : '') + '）⇒ 命中 ' + qualified.length + ' 条'
        + (excludedOld ? '，另有 ' + excludedOld + ' 条早于界' : '')
        + (excludedNoTime ? '，另有 ' + excludedNoTime + ' 条**时间未知/只有上界**故无法判定（不是"没命中"）' : ''));
    }
    if (skipped.length) {
      ctx.out('⚠ 有 ' + skipped.length + ' 个项目读不出来，本次没算它们：'
        + skipped.map((s) => s.project).join('、'));
    }
    if (badLines) ctx.out('⚠ 日志有 ' + badLines + ' 行无法解析 —— 下面只含可解析的部分。');
    if (unparsable) ctx.out('⚠ 有 ' + unparsable + ' 条日志的时间戳读不出来，它们没有参与派生。');

    if (!shown.length) {
      ctx.out(summary.nodes ? '（没有符合条件的节点）' : '（没有节点）');
      return;
    }
    shown.forEach((r) => {
      if (r.atSource === 'changes') {
        ctx.out(fmtTime(r.at) + '  [' + r.project + '] ' + r.nodeId + '  ' + r.topic
          + '（rev ' + r.rev + '）');
      } else if (r.atSource === 'before-window') {
        ctx.out('（早于 ' + fmtTime(r.before) + '）  [' + r.project + '] ' + r.nodeId + '  ' + r.topic);
      } else {
        ctx.out('（时间未知）  [' + r.project + '] ' + r.nodeId + '  ' + r.topic);
      }
    });
    ctx.out('显示 ' + shown.length + ' / ' + qualified.length + ' 条'
      + (truncated ? '（已截断：--limit ' + limit + '，给 0 表示不截断）' : '')
      + '｜排序：at 降序 → 项目名升序 → nodeId 升序（同时间戳也有唯一答案）');
  },

  /* 两个纯函数单独导出，**只为单测能直接钉住它们**（与 `src/item-index.js` 导出 `factOf` 同一个理由：
   * 端到端只看得见合成后的顺序，看不见"并列时谁在前"这条口径本身）。
   * ⚠️ 命令层以外**不许**调它们 —— 它们不是对外契约（不进 `docs/EXTENSIONS.md` 的稳定性表）。 */
  compareRows: compareRows,
  rowsOfProject: rowsOfProject
};
