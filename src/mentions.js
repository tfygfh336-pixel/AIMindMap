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

  /* ==========================================================================
   * 【W16 · 功能代号 `CC`「概念目录」】概念清单与「概念索引」分支
   * --------------------------------------------------------------------------
   * 要解决的问题：一棵书树里只有「章节容器」和「叶子知识点」两种节点，读者想问
   *   「**这本书讲了哪些概念**」时，只能自己从几百个节点里挑一遍。
   *   本段把树**聚合成一份按书内出现顺序排的概念清单**（同名合并、每条带落点 id），
   *   同一份清单也用于「一键补成节点」（生成「概念索引」分支）。
   *
   * ## 为什么住在 `mentions.js` 而不是新开一个模块（这条是设计决定，不是图省事）
   *   `docs/FEATURES.md` 的 `CC` 行写着硬要求「**必须与 `mentions` 共用命中计算**」。
   *   共用最彻底的形态就是**同一个文件、同一个 `findMentions()` 实现** —— 于是
   *   `count` 的后一半（"被提到几次"）与 `mentions` 命令逐条同源，本文件**不新增任何
   *   HTML/Markdown 解析**（清洗仍走 `convert.stripHtml`）。另开模块就会立刻出现第二份
   *   "什么算提到"的口径，那种漂移在别处已发生过。
   *
   * ## 「概念目录」与「标签」是什么关系（**这两件事不许互相顶替**）
   *   · `tags` 是**跨书共享的受控词表**（39 个、闭集、判定靠标题命中词，权威 = `docs/TAGS.md`）：
   *     它的用途是**筛选/聚合**，与某本书的目录顺序无关，且 `TAGS.md` §2 第 4 条**明令**
   *     "不许造只有 1–4 个节点会用的标签" ⇒ 标签**故意**不是"一个知识点"的粒度。
   *   · 「概念目录」是**本书内的开放词表**：名字就是书里的标题（规范化后），顺序就是书里的
   *     顺序，粒度是"一个知识点"。一本书的概念数远超 39（实测 `comnet` 数百）。
   *   ⇒ 概念清单**不从 `tags` 派生**（派生了就只剩 39 行，且 7 本书被压成同一张表，
   *     答不了"**这本书**讲了哪些"）；`tags` 只作为**附加列**随结果带出
   *     （每个概念的落点标签并集），供人按标签过滤 —— 既不重复造词表，也不假装标签能代替目录。
   *
   * ## 「什么算一个概念」的可复算判据（四条，全在这段代码里，没有自由裁量）
   *   1. **候选面**：从作用域根（`--parent` 指定的子树，缺省整棵树）按**前序遍历**（先父后子）
   *      取节点，**作用域根自身不算**（它是容器/锚点）。
   *   2. **承载体**（`isConceptCarrier`）：节点满足任一条即算 —— 有正文（`stripHtml(detail)` 非空）、
   *      有 `tags`、有 `links`、**是叶子**。⇒ 被排除的只有一种：**空正文 + 无标签 + 无链接 +
   *      有子节点的纯分组容器**（它不承载知识，只是结构）。
   *   3. **概念名**（`conceptNameOf`）：`stripHtml(topic)` → 去**章节号前缀**（`第3章` / `1.` / `1.2`）
   *      → 去残留分隔符；去完为空则保留原名。同名（ASCII 大小写折叠）的落点合并成一个概念。
   *      判据与 `usableTopic` 同调：只认 **1–2 位**数字 + 点 ⇒ `802.11 体系结构` / `2024 年度总结` /
   *      `2 层交换` 都不会被误吃（这三条是 `mentions` 当年收紧规则时的实测误伤样例）。
   *   4. **count** = **落点数 + 正文提及数**。前半是本概念在树里有几个落点，后半直接取
   *      `findMentions()` 里 `to` 命中本概念落点的条数（同一份命中计算，含它既有的
   *      "结构相邻不算 / 已建链接不算 / 章节号主题不作目标 / 主题短于 3 字不作目标"四条口径）。
   *      只数落点会把"被反复提及"这个信号抹平，而它正是 `--apply` 与读者关心的那一维。
   *
   * ## 边界（如实说）
   *   · 本段**只报告**，一个字都不写（写盘在 CLI 的 `--apply` 那一半，走 `ctx.mutate`）。
   *   · 「被反复提及却**没有自己页面**的概念」在**单棵树内算不出来**：概念名只可能来自树里的
   *     标题 ⇒ 每个概念天生有落点。那种"没有页面"的名字只能来自跨项目（`mentions --cross` 的
   *     已有职责）或外部术语表，本模块不猜、也不编一个词表出来。
   * ========================================================================== */

  /** 章节号前缀：`第3章` / `1.1` / `1.2.3` / `13.`。
   *  **必须有"第…章"或一个点**（与 `usableTopic` 同一条收紧理由）：`802.11`、`2024 年度总结`、
   *  `2 层交换` 因此都不会被当成章节号吃掉（这三条是当年的实测误伤样例）。 */
  const CHAPTER_PREFIX_RE = /^\s*(?:第\s*[0-9]{1,3}\s*[章节讲回部篇]\s*|[0-9]{1,2}(?:\.[0-9]{1,2}){1,3}\s*[.、:：]?\s*|[0-9]{1,2}\.\s*)/;
  /** 去掉章节号后可能残留的区间/分隔符（`7.5–7.7 移动管理` 会剩下 `–7.7 移动管理`） */
  const LEADING_SEPARATOR_RE = /^[\s\-–—~～、,，.。:：]+/;

  /** 概念名（**判据 3** 的唯一实现）：标题 → 可比对的短名。去完为空则保留原名（`第3章` 这种纯章号标题）。 */
  function conceptNameOf(topic) {
    const raw = convert.stripHtml(topic);
    if (!raw) return '';
    let s = raw;
    // 走两遍：`7.5–7.7 移动管理` 需要两次剥离（`7.5` 与随后的 `7.7`）
    for (let i = 0; i < 2; i++) {
      const cut = s.replace(CHAPTER_PREFIX_RE, '').replace(LEADING_SEPARATOR_RE, '').trim();
      if (!cut) break;
      s = cut;
    }
    return s || raw;
  }

  /** 承载体（**判据 2** 的唯一实现）：它承载知识吗？只有"空正文 + 无标签 + 无链接 + 有子节点"的纯分组容器不承载。 */
  function isConceptCarrier(node) {
    if (!node || typeof node !== 'object') return false;
    const hasDetail = convert.stripHtml(node.detail).length > 0;
    const hasTags = Array.isArray(node.tags) && node.tags.length > 0;
    const hasLinks = Array.isArray(node.links) && node.links.length > 0;
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    return hasDetail || hasTags || hasLinks || !hasChildren;
  }

  /**
   * 这个节点是不是「概念索引」的生成物（**判据的例外，必须有**）。
   *
   * 为什么必须把它从概念池里摘掉（**实测过的自指循环，不是假想**）：
   *   「概念索引」这一支本身有正文、有子节点 ⇒ 按承载体判据它**算概念**；它的子节点（概念条目）
   *   又是"以概念名为标题的节点"⇒ 每个概念凭空多出一个落点。于是：
   *     · 第一次 `--apply` 后，`contents` 的读数从 N 个概念变成 N+1（多出"概念索引"自己）；
   *     · 第二次 `--apply` 认为"清单变了"⇒ 覆盖写，读数是 7 个概念 / 14 条链接（实测读数）；
   *     · 而且"跑没跑过 `--apply`"会改变**只读**命令的输出 —— 那是最坏的一种耦合。
   *   ⇒ 生成物不参与"这棵树讲了哪些概念"的计算。判据（两条，任一即可认）：
   *     ① `id` 就是我们发的那个固定 id；② 主题是「概念索引」**且**子节点里有 `contents-…` 的生成 id
   *     （第 ② 条覆盖"用户先手建了一个同名节点、我们后来接管"的情形；只有主题同名、内容不像
   *      生成物的节点**不**被摘掉 —— 宁可多算一个概念，也不吃掉用户自己的节点）。
   */
  function isConceptIndexNode(node) {
    if (!node || typeof node !== 'object') return false;
    const id = String(node.id === undefined || node.id === null ? '' : node.id);
    // ① 固定 id（根作用域）或带作用域后缀的 id（`--parent` 生成的那几支）
    if (id === CONCEPT_INDEX_ID || /^contents-index-[0-9a-f]{8}$/.test(id)) return true;
    if (String(node.topic === undefined || node.topic === null ? '' : node.topic) !== CONCEPT_INDEX_TOPIC) return false;
    const kids = Array.isArray(node.children) ? node.children : [];
    return kids.some((c) => c && typeof c.id === 'string' && c.id.indexOf('contents-') === 0);
  }

  /** 浅拷贝一棵树，把「概念索引」生成物**连子树一起**摘掉（不改入参；`detail` 等字段按引用共享）。 */
  function withoutConceptIndex(root) {
    if (!root || typeof root !== 'object') return root;
    const clone = (n) => {
      const kids = Array.isArray(n.children) ? n.children : [];
      return Object.assign({}, n, { children: kids.filter((c) => !isConceptIndexNode(c)).map(clone) });
    };
    return clone(root);
  }

  /** 把作用域根的子节点按前序遍历列出（带深度与路径）。`maxDepth` 为 0/空 = 不限。
   *  作用域根自身**不入列**（判据 1）。 */
  function conceptHits(scopeRoot, maxDepth) {
    const out = [];
    if (!scopeRoot || typeof scopeRoot !== 'object') return out;
    const topIds = scopeRoot.id === undefined ? [] : [scopeRoot.id];
    const topNames = [String(scopeRoot.topic === undefined || scopeRoot.topic === null ? '' : scopeRoot.topic)];
    (function walk(n, d, ids, names) {
      const kids = Array.isArray(n.children) ? n.children : [];
      kids.forEach((c) => {
        if (!c || typeof c !== 'object') return;
        const cd = d + 1;
        const cIds = ids.concat([c.id]);
        const cNames = names.concat([String(c.topic === undefined || c.topic === null ? '' : c.topic)]);
        if (!maxDepth || cd <= maxDepth) out.push({ node: c, depth: cd, path: cIds, pathNames: cNames });
        if (!maxDepth || cd < maxDepth) walk(c, cd, cIds, cNames);
      });
    })(scopeRoot, 0, topIds, topNames);
    return out;
  }

  /** 把树剪到前 `maxDepth` 层（**不改入参**）：给"提及扫描面"与"落点池"用同一个作用域。 */
  function pruneToDepth(root, maxDepth) {
    if (!maxDepth || !root || typeof root !== 'object') return root;
    const clone = (n, d) => Object.assign({}, n, {
      children: d < maxDepth && Array.isArray(n.children) ? n.children.map((c) => clone(c, d + 1)) : []
    });
    return clone(root, 0);
  }

  /**
   * **概念清单**（`contents` 的只读那一半；纯函数、无 IO）。
   * @param scopeRoot 作用域根节点（`--parent` 的子树根，或整棵树的根）
   * @param opts {
   *   depth:     0,     // 0 = 不限；N = 只算前 N 层（落点池与提及扫描面**同一个**剪枝）
   *   minCount:  1,     // 只保留 count ≥ 它的概念（0 等价于 1）
   *   selfProject: ''   // 本项目名 —— 传给 findMentions 判"已建链接"，与 mentions 命令同参
   *   minTopicLength / excludeChapterNumbered: 原样透传给 findMentions（缺省与 mentions 相同）
   * }
   * @returns { scanned, carriers, concepts, shown, mentions, withMentions, duplicates, items[] }
   *   items 每项 { name, key, count, nodes, mentions, ids[], firstId, path[], pathNames[], depth, tags[] }
   *   顺序 = **概念第一次出现的树内顺序**（不是 count 排序：这份清单的意义就是"目录"）。
   */
  function conceptCatalog(scopeRoot, opts) {
    const o = opts || {};
    const maxDepth = o.depth === undefined || o.depth === null ? 0 : Number(o.depth);
    const minCount = o.minCount === undefined || o.minCount === null ? 1 : Number(o.minCount);
    // **先摘掉「概念索引」生成物**（自指循环的修法见 `isConceptIndexNode`）：
    // 落点池与提及扫描面都基于这份"干净视图"，于是"跑没跑过 --apply"不改变只读读数。
    const clean = withoutConceptIndex(scopeRoot);
    const hits = conceptHits(clean, maxDepth);

    const byKey = new Map();
    const ordered = [];
    let carriers = 0;
    hits.forEach((h, idx) => {
      if (!isConceptCarrier(h.node)) return;
      carriers++;
      const name = conceptNameOf(h.node.topic);
      if (!name) return;
      const key = name.toLowerCase();
      let c = byKey.get(key);
      if (!c) {
        c = {
          name: name, key: key, ids: [], topics: [], mentions: 0, firstId: h.node.id,
          path: h.path, pathNames: h.pathNames, depth: h.depth, tags: [], at: idx
        };
        byKey.set(key, c);
        ordered.push(c);
      }
      if (c.ids.indexOf(h.node.id) < 0) {
        c.ids.push(h.node.id);
        // 每个落点**自己的**标题（与 ids 一一对齐）：索引条的 caption 要写落点原名，
        // 而不是概念第一次出现时那个名字（同名合并后两者可能不同，如 `收包路径` / `2.1 收包路径`）。
        c.topics.push(String(h.node.topic === undefined || h.node.topic === null ? name : h.node.topic));
      }
      const tags = Array.isArray(h.node.tags) ? h.node.tags : [];
      tags.forEach((t) => { if (typeof t === 'string' && t && c.tags.indexOf(t) < 0) c.tags.push(t); });
    });

    // 提及数：**同一个** findMentions（判据 4 的后一半）。作用域与落点池相同。
    const scanned = maxDepth ? pruneToDepth(clean, maxDepth) : clean;
    const m = findMentions(scanned, {
      selfProject: o.selfProject || '',
      minTopicLength: o.minTopicLength,
      excludeChapterNumbered: o.excludeChapterNumbered
    });
    const byNodeId = new Map();
    ordered.forEach((c) => c.ids.forEach((id) => { if (!byNodeId.has(id)) byNodeId.set(id, c); }));
    let mentionTotal = 0;
    m.items.forEach((it) => {
      const c = byNodeId.get(it.to);
      if (!c) return;
      c.mentions += 1;
      mentionTotal += 1;
    });

    const items = ordered.map((c) => ({
      name: c.name,
      key: c.key,
      count: c.ids.length + c.mentions,
      nodes: c.ids.length,
      mentions: c.mentions,
      ids: c.ids.slice(),
      topics: c.topics.slice(),
      firstId: c.firstId,
      path: c.path.slice(),
      pathNames: c.pathNames.slice(),
      depth: c.depth,
      tags: c.tags.slice()
    })).filter((x) => x.count >= minCount);

    return {
      scanned: hits.length,
      carriers: carriers,
      concepts: ordered.length,
      shown: items.length,
      mentions: mentionTotal,
      withMentions: items.filter((x) => x.mentions > 0).length,
      duplicates: items.filter((x) => x.nodes > 1).length,
      items: items
    };
  }

  /** 「概念索引」分支的固定记号（**唯一一处**）：id 与 topic 都用来认"是不是已经有了"。 */
  const CONCEPT_INDEX_ID = 'contents-index';
  const CONCEPT_INDEX_TOPIC = '概念索引';

  /** FNV-1a → 8 位十六进制。**不用时间/随机**：同样的概念名必须永远得到同样的 id，
   *  否则第二次 `--apply` 会摇出一批新 id ⇒ "幂等"只剩"没多出一个分支"这半边。 */
  function shortHash(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /**
   * **作用域后缀**：同一条命令可以给不同的父节点各生成一支「概念索引」（`--parent`），
   * 而**节点 id 全项目唯一**（`src/schema.js` 会判 `重复 id`）⇒ 非根作用域的生成物必须带作用域后缀。
   *
   * 实测过的形状（不这么做就会这样红）：先在 `root` 下生成一支、再用 `--parent <子节点>` 生成第二支
   * ⇒ `校验失败: [contents-index] 重复 id: contents-index; …`，exit 1、一个字节都没写。
   * 根作用域（`root` / 空）**不加后缀** —— 那是文档里写的最常见形态，id 保持最简。
   */
  function scopeSuffix(scopeId) {
    const s = String(scopeId === undefined || scopeId === null ? '' : scopeId);
    if (!s || s === 'root') return '';
    return '-' + shortHash(s);
  }

  /**
   * 生成「概念索引」分支（**纯函数**：给定概念清单 → 那一支该长什么样，不读盘、不改入参）。
   *
   * 每个概念一个子节点：`topic` = 概念名；`links[]` 回指它的**落点**（同项目）。
   * ⚠️ caption **刻意不带任何 `X：` 形态的类型前缀**：`docs/TAGS.md` §11 的类型只有
   *   前置/对照/补充/出自/同义 **5 种**（"多一个都不许"），而"索引条目"不是其中任何一种；
   *   该节规则 2 明写"允许不带任何类型前缀"，故这里写成自由文本，避免被 `learn-path`
   *   或后来者读成第六种类型（更不许以「前置」二字开头 —— 那会让一条边静默变有向）。
   */
  function indexBranch(items, opts) {
    const o = opts || {};
    /* `o.scopeId` = **生成物的作用域**（目标父节点的 id）：非根作用域的 id 会带后缀。
     * 为什么必须有：节点 id 全项目唯一，先在 `root` 下生成一支、再 `--parent <子节点>` 生成第二支时
     * 会撞 id（实测报文 `校验失败: [contents-index] 重复 id: contents-index; …`，exit 1）。 */
    const project = String(o.project || '');
    const topic = o.topic || CONCEPT_INDEX_TOPIC;
    const suffix = scopeSuffix(o.scopeId);
    const list = Array.isArray(items) ? items : [];
    const used = Object.create(null);
    used[CONCEPT_INDEX_ID + suffix] = true;
    const children = list.map((c, i) => {
      let id = 'contents-' + shortHash(c.key) + suffix;
      let n = 2;
      while (used[id]) { id = 'contents-' + shortHash(c.key) + suffix + '-' + n; n++; }
      used[id] = true;
      return {
        id: id,
        topic: c.name,
        detail: '<p>概念索引条目（第 ' + (i + 1) + ' / ' + list.length + ' 个概念，按在本树中第一次出现的顺序）：'
          + '落点 ' + c.nodes + ' 处 · 正文提及 ' + c.mentions + ' 处。</p>',
        links: c.ids.map((x, k) => ({
          project: project,
          id: x,
          caption: '概念索引条目，落点 #' + (k + 1) + '「'
            + (Array.isArray(c.topics) && c.topics[k] !== undefined ? c.topics[k] : c.name) + '」'
        }))
      };
    });
    return {
      id: CONCEPT_INDEX_ID + suffix,
      topic: topic,
      expanded: false,
      detail: '<p>概念索引：' + children.length + ' 个概念，按在本树中第一次出现的顺序排列；'
        + '同名概念已合并（每个条目在 <code>links</code> 里回指它的落点）。</p>'
        + '<p>由 <code>contents &lt;项目&gt; --apply</code> 生成；重复跑只<strong>就地更新这一支</strong>，不会造第二份。</p>',
      links: [],
      children: children
    };
  }

  /** 只比"生成物关心的字段"（id / topic / detail / links / children）——
   *  用户在索引分支上手加的字段（如 `expanded` / `localPath`）不参与比较 ⇒
   *  第二次 `--apply` 才能认出"这一支已经是最新的"（幂等判定用，是纯函数、可单测）。 */
  function normalizeIndexNode(n) {
    if (!n || typeof n !== 'object') return null;
    const links = Array.isArray(n.links) ? n.links : [];
    return {
      id: n.id === undefined ? null : n.id,
      topic: n.topic === undefined ? null : n.topic,
      detail: n.detail === undefined ? null : n.detail,
      links: links.map((l) => ({
        project: l && l.project === undefined ? null : (l && l.project),
        id: l && l.id === undefined ? null : (l && l.id),
        caption: l && l.caption === undefined ? null : (l && l.caption)
      })),
      children: (Array.isArray(n.children) ? n.children : []).map(normalizeIndexNode)
    };
  }

  /** 这一支是不是已经和"该有的样子"逐字段相同（幂等判定的唯一判据）。 */
  function sameIndexBranch(a, b) {
    return JSON.stringify(normalizeIndexNode(a)) === JSON.stringify(normalizeIndexNode(b));
  }

  return {
    findMentions, findCrossMentions, flattenWithParents, usableTopic,
    // ---- 【W16 / `CC` 概念目录】----
    conceptCatalog, conceptNameOf, isConceptCarrier, conceptHits, indexBranch, sameIndexBranch,
    isConceptIndexNode, withoutConceptIndex, scopeSuffix,
    CONCEPT_INDEX_ID, CONCEPT_INDEX_TOPIC, shortHash
  };
});
