/* ============================================================
 * src/palette-rank.js — 模糊检索的**打分与定序核心**（UMD 纯逻辑，无 DOM）
 * ------------------------------------------------------------
 * 从 renderer/app-palette.js 抽出：**排序是纯计算**，不该和 DOM 焊在一起。
 * 抽出的直接动因是一次真实缺陷：空查询时 `fuzzy('', x)` 对所有项都返回 0，
 * 节点因额外加权排满前 50 名，命令被 `slice(0,50)` 全部截掉 —— 面板打开后
 * 一个命令都看不到。该缺陷由冒烟断言发现（"含命令=false"），
 * 修好后这里用单测锁死，不依赖 Electron 即可回归。
 *
 * ## 【W6】本模块是"**什么算命中、谁排在前面**"这一件事的**唯一实现处**
 * 命令面板（`renderer/app-palette.js` / `app-related.js`）与 **AI 侧检索**
 * （`src/item-index.js` 的 `searchItems`，即 CLI `search` / `search-all` 与 MCP `search_nodes`）
 * 都调这里的 `fuzzyMatch` + `rankRows`：
 *   · 判据①"查询词是**非连续子序列**时 CLI 也能命中"靠 `fuzzyMatch`（两边同一个谓词）；
 *   · 判据②"同一查询在 UI 与 CLI 得到**一致顺序**"靠 `rankRows`（两边同一条定序规则：
 *     分数升序 → 同分保持各自入参顺序）。
 * 两边的**差异**只有"候选集与喂什么文本"，写在这里免得后人以为是一套：
 *   · 命令面板：候选 = 命令 + 节点，文本 = `entry.label`（标题）；空查询时**命令在前**、
 *     末尾按 `limit` 截断（那是面板的显示口径，不是排序口径，故由 `rankPalette` 传 `tieBreak`/`limit`）；
 *   · AI 侧检索：候选 = 命中，文本 = **命中面的原文**（标题 / 正文 / 条目正文 / 图片说明 / 链接说明），
 *     没有"命令"这种东西 ⇒ 不给 `tieBreak`；纯 `--tag`（无关键词）时**不排序**（没有可打分的东西）。
 * 打分口径一个字都不许在别处再写一份 —— `tests/search-fuzzy.test.js` 有结构断言把守。
 *
 * 面板自己的排序规则（有明确的理由，不是随手写的）：
 *   1. 空查询 → **命令在前、节点在后**：还没打字时人最可能想"执行一个动作"，
 *      而 131 个节点里盲找没有意义。两组各自保持原顺序。
 *   2. 有查询 → 模糊分升序（越小越优）；同分时命令优先，再次按原顺序。
 *      "同分命令优先"是因为命令名短、更像是精确想找的东西。
 *   3. limit 截断（默认 50），避免一次渲染上千项。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMPaletteRank = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_LIMIT = 50;
  const WORD_HEAD = /[\s\-/_.:：、]/;   // 命中这些字符之后的字符算"词首"，加分

  /**
   * 子序列模糊匹配 —— **全工程唯一的打分实现**（命令面板与 AI 侧检索都从这里拿）。
   *
   * **返回 null 表示不匹配**（而不是返回 -1）。这一点是必须的：
   * 词首加分会让**合法命中得到负分**（例：'tcp' 命中 'tcp 连接管理' 得 -1.92，
   * 因为首字符命中就 -2）。曾用 `>= 0` 当"是否命中"的判据，
   * 结果是**以关键词开头的节点反被丢掉**（分数为负），而关键词出现在中段的却保留 ——
   * 完全反直觉。该缺陷由 tests/palette-rank.test.js 发现（冒烟断言没抓到）。
   *
   * 别把"子串"和"子序列"当两套口径：**任何子串都是子序列** ⇒ 只留这一个谓词就够
   * （旧实现里那些 `indexOf(kw) >= 0` 是它的特例，不是第二条判据）。
   *
   * @returns {{score:number, start:number}|null}
   *   `score` 越小越优，**可为负**；`start` = 贪婪对齐里**首字符**落在 hay 的下标
   *   （取片段窗口用；空 needle ⇒ `start = -1`，意思是"没有位置"，与"从头部取"同义）；
   *   不匹配 ⇒ null；空 needle ⇒ `{score: 0, start: -1}`（于是"空查询一行不丢、一分不差"）。
   */
  function fuzzyMatch(needle, hay) {
    const n = String(needle === undefined || needle === null ? '' : needle).toLowerCase();
    const h = String(hay === undefined || hay === null ? '' : hay).toLowerCase();
    if (!n) return { score: 0, start: -1 };
    let hi = 0;
    let score = 0;
    let last = -1;
    let start = -1;
    for (let i = 0; i < n.length; i++) {
      const idx = h.indexOf(n[i], hi);
      if (idx < 0) return null;
      if (i === 0) start = idx;
      score += idx - (last + 1);                    // 跳过的字符越少越优
      if (idx === 0 || WORD_HEAD.test(h[idx - 1])) score -= 2;   // 词首命中加分
      last = idx;
      hi = idx + 1;
    }
    return { score: score + h.length * 0.01, start: start };      // 同分时短串优先
  }

  /** 只要分数的那一档（`fuzzyScore('', x) === 0` 的老口径逐字保留：空查询一切同分） */
  function fuzzyScore(needle, hay) {
    const m = fuzzyMatch(needle, hay);
    return m === null ? null : m.score;
  }

  /** 命令优先于节点（空查询与同分两种情况都用它） */
  function kindRank(entry) {
    return entry && entry.kind === 'cmd' ? 0 : 1;
  }

  /**
   * **用上面那一份打分定序**（唯一实现处）：分数升序 → `tieBreak` → 保持入参顺序（稳定）。
   * 不匹配的行被丢掉（那是"命中判定"的另一半，与打分同一个谓词 —— 两边不许各判一次）。
   *
   * 为什么"同分保持入参顺序"写在这里而不靠 `Array.prototype.sort` 的稳定性：
   * 排序规则要对**两个消费者**同时成立（面板的 `label` 序 / 检索的 DFS+条目序），
   * 显式带在比较器里，谁改都不需要靠"引擎恰好稳定"这条隐性前提。
   *
   * ⚠️ 本函数**不 trim** `query`：needle 原样交给 `fuzzyMatch`。
   * 要 trim 是**调用方**的事（`rankPalette` 就是这么做的：输入框里敲的空格不该算查询词），
   * 而检索侧**不能** trim —— 命令层拿到的关键词若带空格，trim 之后"命中判定"与"定序"
   * 用的就不是同一个 needle，会**静默丢命中**（判了命中却又在排序时被丢掉）。
   *
   * @param {Array} rows 待排序的行（原样返回同一批对象引用，不克隆）
   * @param {string} query 查询词（**原样**，见上）
   * @param {function} textOf `(row, index) => string`：这一行拿哪段文本参与打分
   * @param {function} [tieBreak] `(a, b) => number`：同分时的二级定序（默认 0 = 保持原序）
   * @returns {Array} 命中的行（按上面的规则排序）
   */
  function rankRows(rows, query, textOf, tieBreak) {
    const list = Array.isArray(rows) ? rows : [];
    const text = typeof textOf === 'function' ? textOf : (r) => (r && r.label);
    const scored = [];
    list.forEach((row, index) => {
      const m = fuzzyMatch(query, text(row, index));
      if (m === null) return;            // null = 不匹配（分数可为负，不能用 >=0 判定）
      scored.push({ row: row, score: m.score, index: index });
    });
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (typeof tieBreak === 'function') {
        const k = tieBreak(a.row, b.row);
        if (k) return k;
      }
      return a.index - b.index;          // 保持原顺序（稳定）
    });
    return scored.map((x) => x.row);
  }

  /**
   * 排序并截断**命令面板的候选列表**（面板专用的那一层：命令优先 + limit）。
   * 打分与定序一律走 `rankRows`（与 AI 侧检索同一份实现）—— 这里只多两件面板自己的事：
   * 同分时命令优先（`tieBreak`）、末尾截断（`limit`）。
   *
   * @param entries [{kind:'cmd'|'node', label, ...}] 其余字段原样透传
   * @param query   用户输入（**这里会 trim**：输入框里的空白不算查询词）
   * @param limit   0/负值表示不限；缺省 50
   * @returns 排序后的 entries（同一批对象引用，未克隆）
   */
  function rankPalette(entries, query, limit) {
    const q = String(query === undefined || query === null ? '' : query).trim();
    const lim = limit === undefined ? DEFAULT_LIMIT : Number(limit);
    const ordered = rankRows(entries, q, (e) => e && e.label, (a, b) => kindRank(a) - kindRank(b));
    return lim > 0 ? ordered.slice(0, lim) : ordered;
  }

  return { fuzzyMatch, fuzzyScore, rankRows, rankPalette, DEFAULT_LIMIT };
});
