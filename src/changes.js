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
 *
 * ## 顺带承载"写命令的幂等键"（S7，可选字段）
 * 每条记录可多带两个**可选**字段：`idem`（调用方给的幂等键）与 `out`（首次执行的**回显**）。
 * 为什么放在这里而不是项目文件里：项目 JSON 是**当前事实的唯一真源**，塞进幂等键等于给它加
 * 第二套语义；而日志是**旁路产物**（可随时删、不进 export-json）⇒ 删掉即"忘了这个键"，
 * 代价明确且可接受（窗口 `MAX_ENTRIES` 条 + 删日志，见 `cli/core.js` 的幂等契约）。
 * 字段是**可选**的：不给键的写入路径落盘字节与从前完全一致，`ENTRY_VERSION` **不升**。详见 `buildEntry`。
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
   * 单条日志里 `out`（回显摘要）的字符上限。
   *
   * 为什么要截断：`out` 是给**幂等重放**原样复述的（见下），而日志是**有界窗口**的
   * 辅助产物（`MAX_ENTRIES`），不该因为它变成一份体量不可控的账本。
   * 取 400 的理由：本工程各写命令的回显都只有一两行（最长的 `apply` 逐条回执也在几十行内，
   * 而那条回执本身会被摘要成一行统计）—— 400 字够原样复述，超出部分只影响"重放时少显一点"，
   * **不影响幂等判定**（判定只认 `idem` 键）。
   */
  const OUT_MAX = 400;

  /**
   * 构造一条日志条目。**字段名只在这里定义**（单一真源）。
   * `rev` 由 `appendLog` 分配（单调递增），不接受调用方指定 —— 否则会出现两种编号口径。
   *
   * ## `idem` / `out` 两个**可选字段**（为什么不升 `ENTRY_VERSION`）
   * 它们是**写管道流（S7）的幂等键**：`idem` = 调用方给的键，`out` = 首次执行的**回显**。
   * 照 `origin`（DATA-FORMAT §2.8）的先例办：**可选字段、不升版本号** ——
   *   · 旧日志（没有这两个键）照旧解析 ✓ 新日志被旧读者读到也只是多两个不认识的键 ✓
   *   · `looksLikeEntry` 的判据一个字没动 ⇒ 不存在"新旧不兼容"的迁移面
   * 只有真的给了键才写进去（`buildEntry` 里判空），**不给键的老写入路径字节不变** ✓
   *
   * ⚠️ 幂等键**落在这里**而不是项目文件里：项目 JSON 是**当前事实的唯一真源**，
   * 把"这次是谁第几次重试"塞进去等于给数据加第二套语义（本工程最忌的两处表达）。
   * 日志是旁路产物（可随时删、不进 export-json），键放这里**删掉即"忘了"** ✓ 代价写在 core.js。
   */
  function buildEntry(o) {
    const e = o || {};
    const entry = {
      v: ENTRY_VERSION,
      rev: Number(e.rev) || 0,
      at: e.at || new Date().toISOString(),
      writer: String(e.writer || 'unknown'),
      version: String(e.version || ''),
      created: !!e.created,
      changed: Array.isArray(e.changed) ? e.changed.slice().sort() : []
    };
    if (e.idem !== undefined && e.idem !== null && String(e.idem) !== '') {
      entry.idem = String(e.idem);
    }
    if (e.out !== undefined && e.out !== null && String(e.out) !== '') {
      entry.out = String(e.out).slice(0, OUT_MAX);
    }
    return entry;
  }

  /**
   * 按幂等键找**最近一条**用那个键写成功的记录。
   * 返回 `null` = 没见过这个键（调用方该真执行）；否则返回 `{rev, version, at, writer, out}`。
   *
   * 为什么取**最后一条**而不是第一条：日志是有界窗口，同键只该出现一次（core 的守卫保证）；
   * 万一出现过两次（例如窗口裁剪后键被遗忘又重放了一次），"最近那次"才是与当前盘上数据对应的结果。
   */
  function idemLookup(entries, key) {
    const k = (key === undefined || key === null) ? '' : String(key);
    if (!k) return null;
    const list = Array.isArray(entries) ? entries : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e && e.idem === k) {
        return { rev: e.rev, version: e.version, at: e.at, writer: e.writer, out: entryResult(e) };
      }
    }
    return null;
  }

  /** 该条目记下的**首次回显**（没有就返回空串 —— 绝不编造一个"看起来像回显"的东西） */
  function entryResult(entry) {
    return entry && entry.out !== undefined && entry.out !== null ? String(entry.out) : '';
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

  /* ==========================================================================
   * 「这个节点最后一次被写是什么时候」—— 日志的**第二种投影**（时间线 `TL`·台账 `W2`）
   * --------------------------------------------------------------------------
   * 为什么必须住在这个文件里：日志的键（`node:<id>` 这些）**只在这里定义**（`buildEntry` 之上、
   * `concurrency.fingerprint` 之下，两处是同一张表的两面）。任何一个调用方要按节点读日志，
   * 都得先把 key 拆回节点 id —— 那就是**第二份解析**，必然与指纹那一份漂移。
   * 于是拆键与投影都放这里，命令层只消费 `byNode`。
   *
   * 与 `groupByObject` 的分工（**别拿错**）：那个给"某个对象被谁碰过"的流水（并发避让），
   * 这个只给每个节点的**最后一次**（时间线的候选集）。两者都从同一批 entries 现算。
   *
   * ⚠️ 投影**不做 I/O、不读时钟**：`at` 来自日志条目本身，窗口边界（`windowFrom`）也是日志自带的。
   * ======================================================================== */

  /** 一条 `changed` 键属于**哪个节点**（唯一解析处；解析不出来返回 `null`）。
   *
   *  键的四种节点形态（与 `src/concurrency.js` 的 `fingerprint` 逐字对应）：
   *   `node:<id>`（节点自身字段）· `children:<id>`（它的子表顺序）· `items:<id>`（它的条目 id 表）
   *   · `item:<id>#<条目id>`（它的某一条条目）。
   *  `assoc:<id>` / `meta` 不是节点（那是项目级对象）⇒ `null`（时间线不认它们，**不静默归给根节点**）。 */
  function nodeIdOfKey(key) {
    const k = String(key === undefined || key === null ? '' : key);
    let m = /^(?:node|children|items):(.+)$/.exec(k);
    if (m) return m[1];
    m = /^item:([^#]+)#/.exec(k);
    if (m) return m[1];
    return null;
  }

  /**
   * 每个节点"**最后一次有记录的改动**"。
   *
   * 返回 `{byNode, windowFrom, windowTo, entries, unparsable, unresolvedKeys}`：
   *   · `byNode: Map<nodeId, {at, ms, rev}>` —— 窗口内出现过就取**最晚那条**（`at` 用毫秒比，ISO 串原样留着给输出）；
   *   · `windowFrom` / `windowTo` —— 日志窗口的起止（**窗口外节点的唯一上界**：没出现在日志里 ⇒ 更早）；
   *   · `unparsable` —— `at` 不是可解析时间的条目数（**如实计数**，不把它当成"这条没改过"）；
   *   · `unresolvedKeys` —— 拆不回节点 id 的键（`assoc:` / `meta` 这类，**正常存在**，只报数不多说）。
   *
   * ⚠️ **窗口外 ≠ 时间未知**：日志存在 ⇒ 窗口外节点的改动时间有一个**可靠上界**（`windowFrom`），
   *    因为日志只追加、只在超窗口时从头部裁（`appendLog`），而每次写盘都记一条
   *    （`src/data-store.js` 的 `recordChange`，GUI 保存那条路径也调它）。所以"没出现"⇒"早于窗口起点"。
   *    这条推理是**时间线敢给 `before-window` 这一档**的全部依据，改动本文件时别把它拆了。
   */
  function lastTouchedByNode(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const byNode = new Map();
    let windowFrom = null;
    let windowTo = null;
    let unparsable = 0;
    let unresolvedKeys = 0;
    list.forEach((e) => {
      const iso = String(e.at);
      const parsed = Date.parse(iso);
      const ms = Number.isFinite(parsed) ? parsed : null;
      if (ms === null) { unparsable++; return; }
      // 窗口起止按**时间**取（不是按数组首尾）：日志是有界窗口，但不保证外部没往里手工追加过行
      if (windowFrom === null || ms < windowFrom.ms) { windowFrom = { at: iso, ms: ms }; }
      if (windowTo === null || ms > windowTo.ms) { windowTo = { at: iso, ms: ms }; }
      (e.changed || []).forEach((k) => {
        const id = nodeIdOfKey(k);
        if (id === null) { unresolvedKeys++; return; }
        const cur = byNode.get(id);
        if (!cur || ms > cur.ms) byNode.set(id, { at: iso, ms: ms, rev: e.rev });
      });
    });
    return {
      byNode: byNode,
      windowFrom: windowFrom ? windowFrom.at : null,
      windowTo: windowTo ? windowTo.at : null,
      entries: list.length,
      unparsable: unparsable,
      unresolvedKeys: unresolvedKeys
    };
  }

  return {
    FILE_NAME, ENTRY_VERSION, MAX_ENTRIES, OUT_MAX,
    buildEntry, serializeEntry, parseLog, appendLog, since, groupByObject, lastEntry,
    // ---- 写管道流（S7）：幂等键的读面 ----
    idemLookup, entryResult,
    // ---- 时间线（`TL`·`W2`）：日志的第二种投影（按节点取"最后一次改动"）----
    nodeIdOfKey, lastTouchedByNode
  };
});
