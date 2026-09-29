/* ============================================================
 * src/mentions.js — 「未链接提及」计算（UMD）
 * ------------------------------------------------------------
 * 解决的问题：笔记正文里提到了某个知识点，却没有为它建立 links 关系。
 * 这是「关系发现」缺失的另一半 ——
 *   - orphans（cli/commands/relations.js）：节点**完全没有**任何引用关系（横向）
 *   - mentions（本模块）：正文**提到了**却没声明关系（纵向，目标可能已有别的入边）
 * 两者互补且不可互替。实例：comnet 中 `switch`（交换机）被 4 个节点正文提到，
 * 但只有 1 个（ethernet）真的链接了它 —— 它**不是** orphans 报出的孤立节点
 * （有 1 条入边），却是被提及最多、链接最少的中枢。orphans 抓不到它。
 *
 * 纯逻辑 + 无 IO：CLI、MCP、单测共用。节点形如
 *   { id, topic, detail?, links?: [{project, id, caption?}], children?: [] }
 *
 * 对上层调用者的两个提醒：
 *   1. 结果只覆盖传入的树；跨项目扫描由调用方把多个项目的节点合并传入（本模块不读盘）。
 *   2. 本模块刻意**不生成** links，只报告候选 —— 加链接是写操作，必须由用户在
 *      CLI/界面确认后执行（自动改写用户笔记内容的风险远大于收益）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./convert.js'));
  else root.MMMentions = factory(root.MMConvert);
})(typeof self !== 'undefined' ? self : this, function (convert) {
  'use strict';

  /** 扁平化树，同时记录每个节点的父 id（用于判断"结构上已相邻"） */
  function flattenWithParents(root) {
    const nodes = [];
    const parentOf = {};
    (function walk(n, parentId) {
      if (!n || typeof n !== 'object') return;
      nodes.push(n);
      if (parentId) parentOf[n.id] = parentId;
      (n.children || []).forEach((c) => walk(c, n.id));
    })(root, null);
    return { nodes, parentOf };
  }

  /** 主题是否适合作为匹配目标。
   *  章节号主题（"7.1 概述" / "2. 应用层"）默认排除：这类主题常出现在目录式 detail 里，
   *  一次罗列就会产生几十条同质命中，把真正的信号淹没。
   *
   *  **判据必须靠数据定，不能只看"以数字开头"**：本项目真实数据里章节号一律是
   *  `N.` 或 `N.M`（章号 1–2 位），而误伤的是
   *    「802.11 体系结构与 AP」（首位 3 位）、「2024 年度总结」（无点）、「2 层交换」（无点）。
   *  故规则收紧为：**1–2 位数字 + 点**，点后是数字（N.M）或空白（N. 标题）。
   *  这样 802.11/2024/「2 层交换」都不再被误排除（曾实测这三个被误剔出候选池）。 */
  function usableTopic(topic, minTopicLength, excludeChapterNumbered) {
    const t = String(topic === undefined || topic === null ? '' : topic).trim();
    if (t.length < minTopicLength) return false;
    if (excludeChapterNumbered && /^\d{1,2}\.(?=\d|\s)/.test(t)) return false;
    return true;
  }

  /**
   * 找出「正文提到但未建链接」的候选。
   * @param root 项目根节点（node_tree 的 data 子树）
   * @param opts {
   *   minTopicLength:       3,     // 短于此长度的主题不作为匹配目标（降低误报）
   *   includeStructural:    false, // true = 把"结构上已相邻(祖先/后代)"也算命中
   *   excludeChapterNumbered: true,// 排除章节号式主题作为目标
   *   snippetRadius:        30,    // 命中处的上下文半径（字符）
   *   limit:                0      // 0 = 不限条数
   *   selfProject:          ''     // 本项目目录名。**建议必传**：links[].project
   *                                // 指向本项目时才代表"已引用本树中的该节点"；
   *                                // 不传时退化为只比 id（保守，宁少报不多报）
   * }
   * @returns { items: [{from, fromTopic, to, toTopic, snippet}], sources, candidates,
   *            structuralSkipped, raw }
   *   raw = 未做"结构相邻"过滤前的命中数（用于观测过滤强度）
   */
  function findMentions(root, opts) {
    const o = opts || {};
    const minTopicLength = o.minTopicLength === undefined ? 3 : Number(o.minTopicLength);
    const includeStructural = !!o.includeStructural;
    const excludeChapterNumbered = o.excludeChapterNumbered !== false;
    const radius = o.snippetRadius === undefined ? 30 : Number(o.snippetRadius);
    const limit = o.limit === undefined ? 0 : Number(o.limit);

    const { nodes, parentOf } = flattenWithParents(root);

    // 判断 b 是否为 a 的祖先（含自身）
    const isAncestorOrSelf = (a, b) => {
      let x = a;
      while (x) { if (x === b) return true; x = parentOf[x]; }
      return false;
    };
    // 结构上已相邻：父子/祖孙关系已由树表达，再声明 links 属冗余噪音
    const structurallyRelated = (a, b) => isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a);

    const candidates = nodes.filter((n) => usableTopic(n.topic, minTopicLength, excludeChapterNumbered));
    const items = [];
    const seen = new Set();
    let raw = 0;
    let structuralSkipped = 0;
    const sources = new Set();

    nodes.forEach((src) => {
      const text = convert.stripHtml(src.detail);
      if (!text) return;
      // 已声明的出边。**必须**拼上 project 再比 —— links 的形状是
      // {project, id}，只比 id 会永远匹配不上，从而把"已链接"错报成"漏链接"。
      const linkedIds = new Set((src.links || []).filter(Boolean).map((l) => l.id));
      const linkedSelf = new Set((src.links || [])
        .filter((l) => l && o.selfProject && l.project === o.selfProject)
        .map((l) => l.id));
      const alreadyLinked = (id) => (o.selfProject ? linkedSelf.has(id) : linkedIds.has(id));
      candidates.forEach((t) => {
        if (!t.id || t.id === src.id) return;
        if (alreadyLinked(t.id)) return;                 // 已声明关系 → 不算漏
        const at = text.indexOf(t.topic);
        if (at < 0) return;                              // 正文没提到
        raw++;
        if (!includeStructural && structurallyRelated(src.id, t.id)) { structuralSkipped++; return; }
        const key = src.id + '|' + t.id;                 // 同源同目标多次提及只报一次
        if (seen.has(key)) return;
        seen.add(key);
        sources.add(src.id);
        items.push({
          // direction 让本项目内与跨项目的项形状统一（cross 的项为 'out'/'in'）。
          // 属**附加字段**、不改变既有字段语义（docs/EXTENSIONS.md 允许"演进中"命令增补字段）。
          direction: 'same',
          from: src.id,
          fromTopic: src.topic,
          to: t.id,
          toTopic: t.topic,
          snippet: text.slice(Math.max(0, at - radius), at + t.topic.length + radius)
        });
      });
    });

    items.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : (a.from < b.from ? -1 : 1)));
    const out = limit > 0 ? items.slice(0, limit) : items;
    return {
      items: out,
      sources: sources.size,
      candidates: candidates.length,
      structuralSkipped,
      raw,
      truncated: limit > 0 && items.length > out.length
    };
  }

  /**
   * 跨项目「未链接提及」。
   *
   * 两个方向（对应链接的两个指向，与 related 的 out/in 同一套直觉）：
   *   out —— **本项目**的正文提到了**其他项目**的节点 → 可补一条指向外部的链接
   *   in  —— **其他项目**的正文提到了**本项目的**节点 → 可从外部补一条指向本项目的链接
   *
   * 「同名歧义」是跨项目才会真正出现的问题：同一句「概述」在不同项目里都有同名节点时，
   * 光凭正文无法判断指的是哪一个。本模块**不猜**，而是照报所有候选、并给每条打上
   * `ambiguous: true`，同时汇总 `ambiguousTopics`，让调用方去问用户。
   * 这比"猜一个"或"悄悄丢掉"都更安全：猜错会写出错误的链接，丢掉则永远发现不了。
   *
   * 注意：本函数的"结构相邻"过滤**不适用** —— 树是每个项目独立的，跨项目不存在
   * 父子关系，故不做该过滤（这也是它必须与 findMentions 分开的原因）。
   *
   * @param projects     [{ name, data:{data:root} }] 全部项目
   * @param selfProject  本项目目录名
   * @param opts         { minTopicLength, excludeChapterNumbered, snippetRadius, limit }
   * @returns { items, outCount, inCount, ambiguousTopics, sources }
   *   items 每项 { direction, fromProject, from, fromTopic, toProject, to, toTopic, snippet, ambiguous }
   */
  function findCrossMentions(projects, selfProject, opts) {
    const o = opts || {};
    const minTopicLength = o.minTopicLength === undefined ? 3 : Number(o.minTopicLength);
    const excludeChapterNumbered = o.excludeChapterNumbered !== false;
    const radius = o.snippetRadius === undefined ? 30 : Number(o.snippetRadius);
    const limit = o.limit === undefined ? 0 : Number(o.limit);
    const ok = (n) => usableTopic(n.topic, minTopicLength, excludeChapterNumbered);

    // 1) 展开全部项目：项目名 → { nodes, parentOf }
    const P = {};
    (projects || []).forEach((p) => {
      if (!p || !p.name || !p.data || !p.data.data) return;
      P[p.name] = flattenWithParents(p.data.data);
    });
    const empty = { items: [], outCount: 0, inCount: 0, ambiguousTopics: [], sources: 0, truncated: false };
    if (!P[selfProject]) return empty;

    // 2) 两个目标池：本项目的可匹配节点 / 其他项目的可匹配节点
    const selfTargets = P[selfProject].nodes.filter(ok).map((n) => ({ project: selfProject, node: n }));
    const otherTargets = [];
    Object.keys(P).forEach((name) => {
      if (name === selfProject) return;
      P[name].nodes.filter(ok).forEach((n) => otherTargets.push({ project: name, node: n }));
    });

    // 3) 同名歧义：按**全部项目**统计同一 topic 对应的节点数。
    //    必须全局统计，不能只看目标池 —— 否则"来源项目自己也有一个同名节点"时
    //    会漏标歧义。那样的提示是**误导性的**：面板/CLI 会以"无歧义"的口吻建议
    //    "从外部补一条链接"，而正文里那个名字很可能指的是来源项目自己的节点。
    //    （曾实测：other/o1 正文写「参见 被提及者」，而 other 内另有 o2 也叫这个名字，
    //      结果 ambiguous=false、ambiguousTopics=[]。）
    const amb = Object.create(null);   // null 原型：topic 恰为 `__proto__` 时计数也必须生效
    Object.keys(P).forEach((name) => {
      P[name].nodes.forEach((n) => {
        if (!usableTopic(n.topic, minTopicLength, excludeChapterNumbered)) return;
        const k = String(n.topic === undefined || n.topic === null ? '' : n.topic);
        amb[k] = (amb[k] || 0) + 1;
      });
    });

    // 4) 自指守卫所需的索引：项目 → 主题名 → 该项目内所有同名节点的 id。
    //    用来区分"正文提到自己的名字（自指）"与"提到对方项目里的同名节点（真关系）"。
    const sameTopicIds = {};
    Object.keys(P).forEach((name) => {
      const m = Object.create(null);
      P[name].nodes.forEach((n) => {
        const t = String(n.topic === undefined || n.topic === null ? '' : n.topic);
        (m[t] = m[t] || []).push(n.id);
      });
      sameTopicIds[name] = m;
    });

    const items = [];
    const seen = new Set();
    const sources = new Set();

    /** 以 sourceProject 的节点为源，扫描 targets 里的节点主题是否被正文提到却没建链接 */
    const scan = (sourceProject, targets, direction) => {
      const { nodes } = P[sourceProject];
      nodes.forEach((src) => {
        const text = convert.stripHtml(src.detail);
        if (!text) return;
        // 已声明的出边（跨项目也要拼 project 比对，否则本项目的同 id 会掩盖跨项目漏链）
        const linked = new Set((src.links || []).filter(Boolean).map((l) => l.project + '|' + l.id));
        targets.forEach((t) => {
          const tp = t.project;
          const tn = t.node || t;                 // selfTargets 已解包为 {project,node}
          if (!tn.id) return;
          if (linked.has(tp + '|' + tn.id)) return;               // 已声明关系
          const at = text.indexOf(tn.topic);
          if (at < 0) return;
          const key = sourceProject + '|' + src.id + '|' + tp + '|' + tn.id;
          if (seen.has(key)) return;
          seen.add(key);
          sources.add(sourceProject + '|' + src.id);
          items.push({
            direction,
            fromProject: sourceProject, from: src.id, fromTopic: src.topic,
            toProject: tp, to: tn.id, toTopic: tn.topic,
            snippet: text.slice(Math.max(0, at - radius), at + tn.topic.length + radius),
            // 歧义 = 全文（含来源项目）里有多个同名节点，无法凭名字判定指的是谁。
            // 含来源项目自己的同名节点：那种情况下正文很可能就是在讲自己，
            // 必须标出来让人判断，否则提示会误导（见上方 §3 注释）。
            ambiguous: amb[tn.topic] > 1
          });
        });
      });
    };

    // in：其他项目为源 → 本项目节点为目标
    Object.keys(P).forEach((name) => { if (name !== selfProject) scan(name, selfTargets, 'in'); });
    // out：本项目为源 → 其他项目节点为目标
    scan(selfProject, otherTargets, 'out');

    items.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
      if (a.fromProject !== b.fromProject) return a.fromProject < b.fromProject ? -1 : 1;
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      return a.to < b.to ? -1 : (a.to > b.to ? 1 : 0);
    });
    const out = limit > 0 ? items.slice(0, limit) : items;
    // 汇总的歧义主题：只收**实际报出来的项**涉及的主题，而不是所有重名主题 ——
    // 否则会把与本次结果无关的重名也列出来，变成噪音。
    const ambiguousTopics = [];
    items.forEach((x) => {
      if (x.ambiguous && ambiguousTopics.indexOf(x.toTopic) < 0) ambiguousTopics.push(x.toTopic);
    });

    return {
      items: out,
      outCount: items.filter((x) => x.direction === 'out').length,
      inCount: items.filter((x) => x.direction === 'in').length,
      ambiguousTopics,
      sources: sources.size,
      truncated: limit > 0 && items.length > out.length
    };
  }

  return { findMentions, findCrossMentions, flattenWithParents, usableTopic };
});
