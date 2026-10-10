/* ============================================================
 * cli/commands/changes.js — 「谁在什么时候改了什么」（只读）
 * ------------------------------------------------------------
 * 多路同时编辑的**事前避让**依据（阶段 3）。阶段 1/2 管的是"撞上之后"（自动合并 / 指名拒绝）；
 * 本命令让会话在动手前就能看见"自它读取以来，谁改过哪些对象"，从而避开或先重读。
 *
 * 与 `ui-state` 的分工：
 *   · `ui-state` 答"**人的界面**现在有没有未保存编辑"（写前协调）；
 *   · `changes`  答"**这个项目的文件**最近被写过什么"（覆盖全部写入者：CLI / MCP / 界面 / 侧栏）。
 *
 * ## 一条硬口径（本命令存在的主要理由）
 * **"答不了"与"没有变更"必须可分辨**。`--since` 给了锚点却答不出来时**一律报错、退出码非 0**
 * （例如锚点已滑出有界窗口、或本机根本没有日志）。因为调用方是 AI，它会把静默的空结果当成
 * "没人动过，放心写" —— 那正是本工程最重的损害类别（静默）在"可见性"上的翻版。
 * 反过来，不带 `--since` 只是"看看现状"，缺日志就在输出里明说缺日志，不报错。
 *
 * ## 锚点从哪来
 * `changes <项目> --json` 输出里的 `version`（内容指纹）或 `rev`（第几次写入）。
 * ⚠️ **`read --json` 不含 version**（实测过）—— 别在文档里写"用 read 的 version 当锚点"。
 * 典型用法（事前避让）：开工前 `changes <项目> --json` 记下 rev → 动手 → 写前再问
 * `changes <项目> --since <rev>`：为空 ⇒ 确实没人动过；报错 ⇒ 答不了，重新取锚点。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const changes = require('../../src/changes.js');
const concurrency = require('../../src/concurrency.js');

/** 人类可读的时间（本地时区，秒精度足够 —— 日志用途是"刚才是谁动的"） */
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '?');
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 读日志；不存在 → 空文本（不抛，由调用方决定口径） */
function readLog(ctx, name) {
  const file = ctx.store.changeLogFile(name);
  let text = '';
  let exists = true;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { exists = false; }
  const parsed = changes.parseLog(text);
  return { file, exists, entries: parsed.entries, badLines: parsed.badLines, text };
}

/** 把条目补上"人能读的对象名"（用**当前**数据解析 id → 名字；已删的 id 回落成 id 本身） */
function decorate(entries, data) {
  return entries.map((e) => ({
    rev: e.rev, at: e.at, writer: e.writer, version: e.version, created: e.created,
    changed: e.changed,
    labels: e.created ? ['（新建项目）'] : concurrency.describeKeys(data, e.changed)
  }));
}

module.exports = {
  /**
   * `changes [<项目>] [--since <rev|版本号>] [--json] [--limit N]`
   *
   * 不带项目名 → 汇总**所有**项目最近一次写入（"现在谁在动哪个项目"）。
   */
  changes(ctx) {
    // --limit：非法值当场报错（`--limit abc` 以前会静默变成 NaN，而 NaN > 0 为假 ⇒ 悄悄退回"全量"）
    const limit = ctx.intOption('limit', { min: 0, def: 20 });
    const show = (list) => (limit > 0 ? list.slice(Math.max(0, list.length - limit)) : list);

    /* ---------- 不带项目名：汇总 ---------- */
    if (!ctx.projectName) {
      const names = ctx.store.list().map((p) => p.name);
      const rows = names.map((n) => {
        const r = readLog(ctx, n);
        const last = changes.lastEntry(r.entries);
        return {
          project: n, hasLog: r.exists, rev: last ? last.rev : 0,
          lastAt: last ? last.at : null, lastWriter: last ? last.writer : null,
          lastChanged: last ? last.changed : [], entries: r.entries.length,
          badLines: r.badLines.length
        };
      });
      if (ctx.args.json) { ctx.outJson({ projects: rows }); return; }
      if (!rows.length) { ctx.out('（没有项目）'); return; }
      rows.forEach((r) => {
        ctx.out(r.lastAt
          ? r.project + ': 最近写入 ' + fmtTime(r.lastAt) + ' by ' + r.lastWriter
            + ' · 改了 ' + r.lastChanged.length + ' 个对象 · 窗口内 ' + r.entries + ' 条'
          : r.project + ': 本机无变更日志（未被本机写入过，或日志已删）');
      });
      return;
    }

    /* ---------- 带项目名 ---------- */
    const projFile = ctx.store.projectFile(ctx.projectName);
    if (!fs.existsSync(projFile)) ctx.error('项目不存在: ' + ctx.projectName);
    const { data, version } = ctx.read();
    const log = readLog(ctx, ctx.projectName);
    const last = changes.lastEntry(log.entries);

    // 锚点：`--since <rev|版本号>`。**答不出来就是错误**（见文件头那条硬口径）。
    let resolved = null;
    if (ctx.args.since !== undefined) {
      const r = changes.since(log.entries, ctx.args.since);
      if (!r.ok) {
        const why = r.reason === 'no-log'
          ? '本项目在本机没有变更日志（从未被写入过，或日志已被删除）'
          : '锚点 ' + r.anchor + ' 不在日志窗口内（窗口 rev ' + (r.window ? r.window.from + '–' + r.window.to : '?')
            + '，共 ' + (r.window ? r.window.count : 0) + ' 条）';
        ctx.error('无法回答「自 ' + ctx.args.since + ' 以来改了什么」：' + why + '。'
          + '这不等于"没有变更" —— 请重新取锚点（changes ' + ctx.projectName + ' --json 会给当前 version 与 rev）再问。');
      }
      resolved = r;
    }

    const entries = resolved ? resolved.entries : log.entries;
    const view = show(entries);
    const decorated = decorate(view, data);

    if (ctx.args.json) {
      ctx.outJson({
        project: ctx.projectName,
        version: version,                      // 当前版本指纹（读方拿它当下次的 --since 锚点）
        rev: last ? last.rev : 0,              // 当前 rev（0 = 本机无日志）
        hasLog: log.exists,
        window: { max: changes.MAX_ENTRIES, entries: log.entries.length, badLines: log.badLines.length },
        since: resolved
          ? { anchor: ctx.args.since, matchedRev: resolved.matchedRev || null, count: entries.length }
          : null,
        changes: decorated
      });
      return;
    }

    ctx.out('项目 ' + ctx.projectName + ' · 当前版本 ' + String(version).slice(0, 8)
      + (last ? '（第 ' + last.rev + ' 次写入）' : ''));

    if (!log.exists) {
      ctx.out('⚠ 本机没有变更日志 —— **答不了"改过什么"**（不等于"没有变更"）。'
        + '日志由唯一写盘出口顺带产生，可能是本项目从未在本机被写过，或日志已被删除。');
      return;
    }
    if (log.badLines.length) {
      ctx.out('⚠ 日志有 ' + log.badLines.length + ' 行无法解析（第 ' + log.badLines.join(', ') + ' 行）—— '
        + '下面列出的只是可解析的部分。');
    }

    if (resolved) {
      if (!entries.length) {
        ctx.out('自 ' + ctx.args.since + ' 以来**没有变更**（锚点就是当前版本 ' + String(version).slice(0, 8) + '）。');
        return;
      }
      ctx.out('自 ' + ctx.args.since + ' 以来有 ' + entries.length + ' 次写入：');
    } else {
      ctx.out('最近写入：' + (last ? fmtTime(last.at) + ' by ' + last.writer : '（无）'));
      ctx.out('窗口内共 ' + log.entries.length + ' 条，下面显示最近 ' + view.length + ' 条：');
    }

    decorated.forEach((e) => {
      ctx.out('  [rev ' + e.rev + ' ' + fmtTime(e.at) + '] ' + e.writer
        + ' → ' + (e.labels.length ? e.labels.join('、') : '（无对象变化）'));
    });

    // 「谁在改」的汇总：多路同时编辑时，一眼看出是不是有别的会话在活跃
    const byWriter = new Map();
    log.entries.forEach((e) => byWriter.set(e.writer, (byWriter.get(e.writer) || 0) + 1));
    if (byWriter.size > 1) {
      ctx.out('窗口内写入者：' + [...byWriter.entries()].map(([w, n]) => w + ' ×' + n).join('、'));
    }
    ctx.out('提示：改之前先确认你要动的对象不在上面 —— 撞上同一对象的并发改动只能由人决定（阶段 1/2 的合并闸门会拦）。');
  }
};
