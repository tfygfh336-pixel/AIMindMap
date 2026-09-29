/* ============================================================
 * src/changes.js — 变更日志（多路同时编辑的"事前避让"依据）
 * ------------------------------------------------------------
 * ## 为什么需要它（阶段 3）
 * 阶段 1/2 解决的是"撞上之后怎么办"（自动合并 / 指名拒绝）。但**更省事的是别撞上**：
 * 一个会话在动手前若能看见"自它读取以来，谁改过哪些对象"，它就能避开那些对象，
 * 或者干脆先重新读取。这正是 `RULES.md` M1 要的"有据"：没有可见性，会话只能靠
 * 事后冲突去发现自己白做了一轮。
 *
 * ## 为什么不把历史写进项目文件
 * 项目 JSON 是**当前事实的唯一真源**。把"改了什么"的序列也塞进去会造成：
 * ① 同一事实两处表达（当前状态 vs 变更序列）⇒ 必然漂移；② 文件无界增长。
 * 所以走**按项目的 sidecar**（与 `.ui-state.json` 同一惯例、同一个目录、同样是点文件）：
 *   `projects/<项目>/.changes.jsonl` —— 一行一条 JSON，**追加式**，**有界**（只留最近 N 条）。
 * 它不是数据、不进 `export-json`、可随时删（删掉后 `changes` 会明说"没有日志"，
 * **绝不把"采不到"说成"没有变更"**）。
 *
 * ## 单一来源（A3）
 * 日志由**唯一写盘出口**（`src/data-store.js` 的 `write`）产生，"改了什么"不是谁手写的，
 * 而是用**与冲突判定同一套**指纹（`src/concurrency.js` 的 `changedKeys`）当场算出来的 ——
 * 于是"哪里算冲突"和"哪里报变更"永远是同一份定义。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MMChanges = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 文件名固定带前导点：项目目录列举（store.list / 资源扫描）只认常规文件，点文件天然被忽略 */
  const FILE_NAME = '.changes.jsonl';
  const ENTRY_VERSION = 1;
  /** 有界窗口：日志回答的是"最近发生了什么"，不是永久账本（无界增长会变成第二种"数据"） */
  const MAX_ENTRIES = 200;

  /**
   * 构造一条日志条目。**字段名只在这里定义**（单一真源）。
   * `rev` 由 `appendLog` 分配（单调递增），不接受调用方指定 —— 否则会出现两种编号口径。
   */
  function buildEntry(o) {
    const e = o || {};
    return {
      v: ENTRY_VERSION,
      rev: Number(e.rev) || 0,
      at: e.at || new Date().toISOString(),
      writer: String(e.writer || 'unknown'),
      version: String(e.version || ''),
      created: !!e.created,
      changed: Array.isArray(e.changed) ? e.changed.slice().sort() : []
    };
  }

  function serializeEntry(entry) { return JSON.stringify(entry) + '\n'; }

  function looksLikeEntry(o) {
    return !!o && typeof o === 'object' && typeof o.rev === 'number' && o.rev > 0
      && Array.isArray(o.changed);
  }

  /**
   * 解析日志文本。**坏行不静默丢**：逐行记下坏行号，随结果一并回报
   * （"少了一条"和"本来就没有"必须能分辨 —— 否则读方会把残缺当完整）。
   */
  function parseLog(text) {
    const out = { entries: [], badLines: [], total: 0 };
    if (!text || typeof text !== 'string') return out;
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      out.total++;
      let raw;
      try { raw = JSON.parse(line); } catch (err) { out.badLines.push(i + 1); continue; }
      if (!looksLikeEntry(raw)) { out.badLines.push(i + 1); continue; }
      out.entries.push(buildEntry(raw));
    }
    return out;
  }

  /**
   * 追加一条（纯函数：进文本、出文本）。`rev` = 现有最大 rev + 1（**从日志自身推导**，
   * 不依赖项目文件里的任何字段 ⇒ 无需改数据格式）。
   * @returns `{ text, entry, trimmed }`：`trimmed` = 因超窗口被挤掉的条数
   */
  function appendLog(text, fields, max) {
    const limit = Number(max) > 0 ? Number(max) : MAX_ENTRIES;
    const parsed = parseLog(text);
    const lastRev = parsed.entries.reduce((m, e) => (e.rev > m ? e.rev : m), 0);
    const entry = buildEntry(Object.assign({}, fields, { rev: lastRev + 1 }));
    const all = parsed.entries.concat([entry]);
    const trimmed = Math.max(0, all.length - limit);
    const kept = trimmed ? all.slice(all.length - limit) : all;
    return { text: kept.map(serializeEntry).join(''), entry: entry, trimmed: trimmed };
  }

  /**
   * 「自锚点以来改了什么」。
   *
   * 锚点可以是 **rev**（`"42"`）或**版本指纹**（读项目时拿到的 `version`，见 `read --json`）。
   * ⚠️ 三种结局必须可分辨，**绝不能把"找不到锚点"说成"没有变更"**：
   *   · `ok:true, entries:[…]`   —— 确实有这些变更；
   *   · `ok:true, entries:[]`    —— 锚点就是最新版，**确实没有变更**；
   *   · `ok:false` + `reason`    —— 锚点不在窗口内 / 没有日志，**答不了**（调用方应重新读取）。
   */
  function since(entries, anchor) {
    const list = Array.isArray(entries) ? entries : [];
    const a = String(anchor === undefined || anchor === null ? '' : anchor).trim();
    if (!a) return { ok: true, entries: list, reason: 'no-anchor' };
    if (!list.length) return { ok: false, reason: 'no-log', anchor: a };
    const byRev = /^\d+$/.test(a) ? Number(a) : null;
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const hitRev = byRev !== null && list[i].rev === byRev;
      const hitVer = byRev === null && list[i].version && list[i].version.indexOf(a) === 0;
      if (hitRev || hitVer) { idx = i; break; }
    }
    if (idx < 0) {
      return {
        ok: false, reason: 'anchor-not-found', anchor: a,
        window: { from: list[0].rev, to: list[list.length - 1].rev, count: list.length }
      };
    }
    return { ok: true, entries: list.slice(idx + 1), reason: 'ok', matchedRev: list[idx].rev };
  }

  /**
   * 把多条条目按**对象**归并：`key → [rev, …]`。
   * 一个会话真正要问的是"我打算改的那个对象，最近被谁碰过"，所以按对象归并比按时间列流水有用。
   */
  function groupByObject(entries) {
    const map = new Map();
    (Array.isArray(entries) ? entries : []).forEach((e) => {
      (e.changed || []).forEach((k) => {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ rev: e.rev, at: e.at, writer: e.writer });
      });
    });
    return map;
  }

  /** 最近一次写入（谁、何时、改了什么）；空日志 → null */
  function lastEntry(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.length ? list[list.length - 1] : null;
  }

  return {
    FILE_NAME, ENTRY_VERSION, MAX_ENTRIES,
    buildEntry, serializeEntry, parseLog, appendLog, since, groupByObject, lastEntry
  };
});
