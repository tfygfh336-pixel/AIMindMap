/* ============================================================
 * src/palette-rank.js — 命令面板的检索与排序（UMD 纯逻辑，无 DOM）
 * ------------------------------------------------------------
 * 从 renderer/app-palette.js 抽出：**排序是纯计算**，不该和 DOM 焊在一起。
 * 抽出的直接动因是一次真实缺陷：空查询时 `fuzzy('', x)` 对所有项都返回 0，
 * 节点因额外加权排满前 50 名，命令被 `slice(0,50)` 全部截掉 —— 面板打开后
 * 一个命令都看不到。该缺陷由冒烟断言发现（"含命令=false"），
 * 修好后这里用单测锁死，不依赖 Electron 即可回归。
 *
 * 排序规则（有明确的理由，不是随手写的）：
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
   * 子序列模糊匹配。
   *
   * **返回 null 表示不匹配**（而不是返回 -1）。这一点是必须的：
   * 词首加分会让**合法命中得到负分**（例：'tcp' 命中 'tcp 连接管理' 得 -1.92，
   * 因为首字符命中就 -2）。曾用 `>= 0` 当"是否命中"的判据，
   * 结果是**以关键词开头的节点反被丢掉**（分数为负），而关键词出现在中段的却保留 ——
   * 完全反直觉。该缺陷由 tests/palette-rank.test.js 发现（冒烟断言没抓到）。
   *
   * @returns 分数（越小越优，**可为负**）；不匹配返回 null；空 needle 返回 0。
   */
  function fuzzyScore(needle, hay) {
    const n = String(needle === undefined || needle === null ? '' : needle).toLowerCase();
    const h = String(hay === undefined || hay === null ? '' : hay).toLowerCase();
    if (!n) return 0;
    let hi = 0;
    let score = 0;
    let last = -1;
    for (let i = 0; i < n.length; i++) {
      const idx = h.indexOf(n[i], hi);
      if (idx < 0) return null;
      score += idx - (last + 1);                    // 跳过的字符越少越优
      if (idx === 0 || WORD_HEAD.test(h[idx - 1])) score -= 2;   // 词首命中加分
      last = idx;
      hi = idx + 1;
    }
    return score + h.length * 0.01;                 // 同分时短串优先
  }

  /** 命令优先于节点（空查询与同分两种情况都用它） */
  function kindRank(entry) {
    return entry && entry.kind === 'cmd' ? 0 : 1;
  }

  /**
   * 排序并截断候选列表。
   * @param entries [{kind:'cmd'|'node', label, ...}] 其余字段原样透传
   * @param query   用户输入
   * @param limit   0/负值表示不限；缺省 50
   * @returns 排序后的 entries（同一批对象引用，未克隆）
   */
  function rankPalette(entries, query, limit) {
    const q = String(query === undefined || query === null ? '' : query).trim();
    const lim = limit === undefined ? DEFAULT_LIMIT : Number(limit);
    const list = entries || [];
    const empty = q === '';

    const scored = [];
    list.forEach((entry, index) => {
      const s = fuzzyScore(q, entry && entry.label);
      if (s === null) return;            // null = 不匹配（分数可为负，不能用 >=0 判定）
      scored.push({ entry: entry, score: s, index: index });
    });

    scored.sort((a, b) => {
      if (!empty && a.score !== b.score) return a.score - b.score;   // 空查询下分数无意义
      const k = kindRank(a.entry) - kindRank(b.entry);
      if (k !== 0) return k;                                        // 命令优先
      return a.index - b.index;                                     // 保持原顺序（稳定）
    });

    const ordered = scored.map((x) => x.entry);
    return lim > 0 ? ordered.slice(0, lim) : ordered;
  }

  return { fuzzyScore, rankPalette, DEFAULT_LIMIT };
});
