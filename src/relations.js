/* ============================================================
 * src/relations.js — 引用关系计算（UMD）：反向链接 + 相关知识点
 * ------------------------------------------------------------
 * 纯逻辑 + 依赖注入：CLI、单测、渲染层（经 IPC）三方共用。
 * 节点形如 { id, topic, tags?, links?: [{project, id, caption?}] }。
 * 链接约定：links[].project 是目标项目目录名（=自身项目时表示同项目引用）。
 *
 * 三个查询的区别：
 *   - backlinksAll：单向 —— 谁引用了我（给「被引用」用）
 *   - relatedAll  ：双向聚合 —— 出边（我引用谁）+ 入边（谁引用我），
 *                   去重后标注方向（out / in / both），供「相关知识点」面板
 *   - relatedAll({depth:N})：把邻域向外扩到 **N 跳**（N 任意正整数，逐层 BFS）。
 *                   Obsidian 的局部图（local graph）默认就是两跳：
 *                   一跳只能看到直接关联，二跳才能看出"知识簇"；更远的多跳用于追一条链
 *                   （"这个结论是从哪一路引来的"）。
 *                   防环靠全局访问集合（每个节点只以**最短跳数**入表一次），
 *                   规模靠 MAX_ITEMS 上限（到了就停并置 truncated ⇒ 调用方响亮报错）。
 *                   注意它**不是**全量图谱（那条路已被否决，见 docs/ROADMAP.md）：
 *                   它是"以某节点为心"的固定半径邻域，规模可控、信噪比高。
 *
 * 性能：反向链接用**一次建索引**（backlinkIndex）后复用，而不是每个节点扫一遍全库 ——
 * 逐层展开时每层只对**该层新增节点**求一次邻域，避免逐次全量扫描的 O(N·M)。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMRelations = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 邻域展开的**结果上限**（条数）：到了就停并置 `truncated:true`。
   * 为什么必须有：深度是**任意**的（用户要的"多跳关系可查"），而图可以是稠密的 ——
   * 没有上限时 `--depth 50` 会把整张图拉进来（实测 comnet 规模下足够慢到不可用）。
   * 本模块只负责"停下来并如实报告"，**要不要报错由调用方决定**（CLI 选择响亮报错）。
   */
  const MAX_ITEMS = 500;

  /** 深度上限：只用来挡离谱输入（图规模早已先撞上 MAX_ITEMS）；1–MAX_DEPTH 的整数合法 */
  const MAX_DEPTH = 100;

  /** 深度归一：正整数 → 原样；其它一律退回 1（**判定与报错在 CLI**，本模块只保证不炸） */
  function normDepth(v) {
    const n = Number(v);
    return (Number.isInteger(n) && n >= 1) ? n : 1;
  }

  /** 深度优先收集全部节点 */
  function flatten(root) {
    const out = [];
    (function w(n) { if (!n) return; out.push(n); (n.children || []).forEach(w); })(root);
    return out;
  }

  /** 建立 项目名 → { 节点id: topic } 索引，用于把链接目标解析成可读标题 */
  function topicIndex(projects) {
    // 用 null 原型对象：节点 id 来自数据，若恰为 `__proto__`/`constructor`，
    // 普通对象上的赋值会被静默忽略（读到的是 Object.prototype 的值）——
    // 表现为 topic 变成对象、或索引被污染。null 原型没有这些键，赋值一律生效。
    const idx = Object.create(null);
    (projects || []).forEach((p) => {
      if (!p || !p.name || !p.data || !p.data.data) return;
      idx[p.name] = Object.create(null);
      flatten(p.data.data).forEach((n) => { idx[p.name][n.id] = n.topic; });
    });
    return idx;
  }

  /** 建立 项目名 → { 节点id: 节点对象 } 索引（depth 2 展开时需要拿到邻居的 links） */
  function nodeIndex(projects) {
    const idx = Object.create(null);
    (projects || []).forEach((p) => {
      if (!p || !p.name || !p.data || !p.data.data) return;
      idx[p.name] = Object.create(null);
      flatten(p.data.data).forEach((n) => { idx[p.name][n.id] = n; });
    });
    return idx;
  }

  /**
   * 反向链接索引：`"项目名|节点id" → [{project, node, topic, caption}]`
   * 一次遍历全部项目建立，供任意多个目标复用（depth 2 必需）。
   *
   * **去重口径说明（与 relatedAll 不同，是有意的）**：这里按 `项目|节点|说明` 去重，
   * 因此"同一来源对同一目标写了两条不同说明的链接"会保留两行 —— 让 `backlinks` 能
   * 如实展示作者写的每条说明。而 `neighborhood1` 按 `项目|节点` 去重（只留一条），
   * 因为「相关知识点」是一份**关系清单**，同一关系重复出现没有意义。
   * 两者服务不同视图，故口径不同；若将来要统一，需同步改 CLI 输出契约。
   */
  function backlinkIndex(projects) {
    const idx = Object.create(null);   // null 原型：同上，防 `__proto__` 类 id 污染索引
    (projects || []).forEach((p) => {
      if (!p || !p.name || !p.data || !p.data.data) return;
      flatten(p.data.data).forEach((n) => {
        (n.links || []).forEach((l) => {
          if (!l || !l.project || !l.id) return;   // 残缺链接忽略（validate 会另报）
          const k = l.project + '|' + l.id;
          (idx[k] = idx[k] || []).push({ project: p.name, node: n.id, topic: n.topic, caption: l.caption });
        });
      });
    });
    // 去重（同源同目标多次链接）
    Object.keys(idx).forEach((k) => {
      const seen = new Set();
      idx[k] = idx[k].filter((x) => {
        const u = x.project + '|' + x.node + '|' + (x.caption || '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      });
    });
    return idx;
  }

  /** 按反向链接索引取「谁引用了我」 —— within=同项目，cross=其他项目 */
  function backlinksFrom(index, selfProject, targetId, includeSelf) {
    const hits = (index && index[selfProject + '|' + targetId]) || [];
    const within = [];
    const cross = [];
    hits.forEach((x) => {
      if (x.project === selfProject) {
        if (includeSelf !== false) within.push({ node: x.node, topic: x.topic, caption: x.caption });
      } else {
        cross.push({ project: x.project, node: x.node, topic: x.topic, caption: x.caption });
      }
    });
    return { within, cross };
  }

  /**
   * 计算某节点的反向链接（谁引用了我）。
   * @param selfProject 本项目目录名
   * @param targetId    目标节点 id（位于 selfProject 内）
   * @param projects    [{ name, data }] 全部项目（含本项目）
   * @param opts        { includeSelf: 是否包含本项目内来源（默认 true） }
   * @returns { within:[{node,topic,caption}], cross:[{project,node,topic,caption}] }
   *   within = 本项目内引用 targetId 的节点；cross = 其他项目里指向本项目 targetId 的节点。
   */
  function backlinksAll(selfProject, targetId, projects, opts) {
    const o = opts || {};
    return backlinksFrom(backlinkIndex(projects), selfProject, targetId, o.includeSelf);
  }

  /**
   * 计算「以某节点为心、半径 1」的邻域（出边 + 入边合并去重）。
   * 不返回计数 —— 计数由 relatedAll 按深度分层统计。
   * @returns [{project, node, topic, caption, dir}]  dir: out/in/both（相对 selfNode）
   */
  function neighborhood1(selfProject, selfNode, tIdx, blIdx, includeSelf) {
    const items = [];
    const seen = Object.create(null);   // null 原型：键含 `__proto__` 时也能正确去重
    const push = (project, node, topic, caption, dir) => {
      // 自链接防御：数据若声明"某节点引用自己"（CLI link 会拒，但手工编辑/导入可造出），
      // 该节点会以 dir:'both' 出现在**自己的**相关知识点里。跳过它。
      if (selfNode && selfNode.id && project === selfProject && node === selfNode.id) return;
      const k = project + '|' + node;
      if (seen[k]) {
        const prev = seen[k];
        if (prev.dir !== dir) prev.dir = 'both';
        if (!prev.caption && caption) prev.caption = caption;
        return;
      }
      const it = { project, node, topic: topic || node, caption: caption || '', dir };
      seen[k] = it;
      items.push(it);
    };
    // 出边：本节点声明的链接
    ((selfNode && selfNode.links) || []).forEach((l) => {
      if (!l || !l.project || !l.id) return;
      push(l.project, l.id, (tIdx[l.project] && tIdx[l.project][l.id]) || l.id, l.caption, 'out');
    });
    // 入边：谁引用了本节点
    if (selfNode && selfNode.id) {
      const bl = backlinksFrom(blIdx, selfProject, selfNode.id, includeSelf);
      bl.within.forEach((x) => push(selfProject, x.node, x.topic, x.caption, 'in'));
      bl.cross.forEach((x) => push(x.project, x.node, x.topic, x.caption, 'in'));
    }
    return items;
  }

  /** 一次构建全部索引（供"对许多节点反复求邻域"的调用方复用，避免 O(N²)） */
  function buildIndexes(projects) {
    return {
      tIdx: topicIndex(projects),
      blIdx: backlinkIndex(projects),
      nIdx: nodeIndex(projects)
    };
  }

  /**
   * 计算某节点的「相关知识点」：出边（我引用谁）+ 入边（谁引用我）合并去重。
   * @param selfProject 本项目目录名
   * @param selfNode    当前节点对象（需含 id 与 links）
   * @param projects    [{ name, data }] 全部项目（含本项目）
   * @param opts {
   *   includeSelf: 反查入边时是否含本项目（默认 true）,
   *   withBacklinks: 是否计算入边（默认 true）,
   *   depth: 邻域半径，**任意正整数**（默认 1）—— 逐层 BFS，不是"只支持两跳",
   *   maxItems: 结果条数上限（默认 MAX_ITEMS）：到了就停并置 `truncated:true`
   *             （**由调用方决定**是"报错"还是"照给"—— 本模块只保证不无限膨胀）,
   *   indexes: buildIndexes(projects) 的结果。**批量调用时务必传入** ——
   *            否则每次调用都重建 topicIndex/backlinkIndex/nodeIndex，
   *            对 N 个节点逐个调用就是 O(N²)（实测 1200 节点 729ms；
   *            传入索引后只建一次）。单次调用可省略。
   * }
   * @returns { items, outCount, inCount, depth1Count, depth2Count, byDepth, truncated }
   *   items 每项 {project, node, topic, caption, dir, depth, via}
   *     - depth=1：dir 为 out / in / both（**相对传入的 selfNode**），via=null
   *     - depth>=2：dir 为该邻居与**上一跳节点**的方向，via={project,node,topic} 指明经由谁到达
   *       （深度 ≥2 的方向不是相对 self 的，故必须用 via 才能正确解读）
   *     - 每个节点**只以最短跳数入表一次**（`项目|节点` 去重）⇒ 深度=最短距离
   *   byDepth：{ 1: n, 2: m, … } 每层条数；depth2Count = byDepth[2]（保持既有语义：**正好二跳**的条数）
   *   outCount / inCount 只统计**一跳**（保持既有语义：直接引用数）
   *
   * **防环**（为什么任意深度是安全的）：`seen` 是全展开过程的访问集合，A→B→A、自环、
   *   多路径汇聚都不会让同一节点再次入表 ⇒ 展开必然终止，且深度 = 最短距离 ✓。
   * 性能：逐层展开每层只对**该层新增节点**求一次邻域，且复用索引 ⇒ O(半径 × 层内节点数)，
   *   不是 O(深度 × 全库)。
   */
  function relatedAll(selfProject, selfNode, projects, opts) {
    const o = opts || {};
    const depth = normDepth(o.depth);
    const maxItems = Number.isInteger(o.maxItems) && o.maxItems > 0 ? o.maxItems : MAX_ITEMS;
    const idx = o.indexes || {};
    const tIdx = idx.tIdx || topicIndex(projects);
    const blIdx = idx.blIdx || backlinkIndex(projects);
    const withBacklinks = o.withBacklinks !== false;

    const items = [];
    const seen = Object.create(null);   // null 原型：键含 `__proto__` 时也能正确去重
    const add = (project, node, topic, caption, dir, d, via) => {
      const k = project + '|' + node;
      if (seen[k]) return false;
      seen[k] = true;
      items.push({ project, node, topic: topic || node, caption: caption || '', dir, depth: d, via: via || null });
      return true;
    };

    // —— 第 1 跳 ——
    const base = withBacklinks
      ? neighborhood1(selfProject, selfNode, tIdx, blIdx, o.includeSelf)
      : neighborhood1(selfProject, { id: null, links: selfNode && selfNode.links }, tIdx, blIdx, false);
    const d1 = base.slice();
    // 上限对**第 1 跳同样生效**：一个高度数节点（实测星形 519 条出边）一跳就能超限，
    // 只在"第 2 跳以后"设卡会让 depth=1 照样把整颗星吐出来（"上限"就形同虚设）。
    let truncated = false;
    d1.forEach((it) => {
      if (items.length >= maxItems) { truncated = true; return; }
      add(it.project, it.node, it.topic, it.caption, it.dir, 1, null);
    });

    const depth1Count = items.length;
    const byDepth = { 1: depth1Count };

    // —— 第 2..depth 跳：**逐层 BFS**（depth=2 时与历史实现逐字等价）——
    if (depth > 1) {
      const nIdx = idx.nIdx || nodeIndex(projects);
      const selfKey = selfProject + '|' + (selfNode && selfNode.id);
      let frontier = d1.map((x) => ({ project: x.project, node: x.node, topic: x.topic }));
      for (let d = 2; d <= depth && frontier.length; d++) {
        const next = [];
        frontier.forEach((b) => {
          if (truncated) return;
          const bNode = nIdx[b.project] && nIdx[b.project][b.node];
          if (!bNode) return;
          // 展开中间节点时 includeSelf 恒为 true：这里的 selfProject 换成了**中间节点所在项目**，
          // 传 o.includeSelf 会连"中间节点自己项目内的来源"一起屏蔽，把邻域挖掉一大块。
          // 故 `{depth:N, includeSelf:false}` 对第 ≥2 跳不生效（一跳仍严格生效）——
          // 这是有意的：includeSelf 的语义是"反查入边时是否含本项目"，
          // 而第 ≥2 跳的"本项目"是相对的，硬套会给出反直觉的结果。
          neighborhood1(b.project, bNode, tIdx, blIdx, true).forEach((it) => {
            if (it.project + '|' + it.node === selfKey) return;   // 不绕回自身
            if (items.length >= maxItems) { truncated = true; return; }
            const okAdd = add(it.project, it.node, it.topic, it.caption, it.dir, d,
              { project: b.project, node: b.node, topic: b.topic });
            if (okAdd) next.push({ project: it.project, node: it.node, topic: it.topic });
          });
        });
        byDepth[d] = next.length;
        frontier = next;
      }
    }

    let outCount = 0;
    let inCount = 0;
    items.slice(0, depth1Count).forEach((i) => {
      if (i.dir !== 'in') outCount++;
      if (i.dir !== 'out') inCount++;
    });
    return {
      items, outCount, inCount, depth1Count,
      depth2Count: byDepth[2] || 0,
      byDepth, truncated
    };
  }

  return { flatten, topicIndex, nodeIndex, backlinkIndex, backlinksFrom, backlinksAll, relatedAll, buildIndexes, normDepth, MAX_ITEMS, MAX_DEPTH };
});
