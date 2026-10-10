/* ============================================================
 * src/query.js — 查询与视图构造（UMD 纯逻辑，无 IO）
 * ------------------------------------------------------------
 * 从 cli/commands/project.js 下沉而来。这些函数决定了 **AI 看到什么**：
 * read --json 的视图、list、get、search、stats。此前它们是命令文件里的
 * 私有函数，命令层零单测 —— 只能靠端到端断言间接覆盖。
 * 下沉到 src/ 后可直接单测（见 tests/query.test.js）。
 *
 * 全部函数对输入只读、不改树；不读盘、不写盘。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tree-utils.js'), require('./convert.js'));
  } else {
    root.MMQuery = factory(root.MMTree, root.MMConvert);
  }
})(typeof self !== 'undefined' ? self : this, function (tree, convert) {
  'use strict';

  /** 收集全部图片引用（扁平清单，附所属节点 id/topic） */
  function collectImages(root) {
    const out = [];
    tree.walk(root, (n) => {
      (n.images || []).forEach((img) => out.push({ node: n.id, topic: n.topic, ...img }));
    });
    return out;
  }

  /**
   * read --json 的可读视图（树 + 节点详情 + 资源清单）。
   * opts:
   *   brief    —— 只要结构不要长文本：省略 detail / images / files（AI 省 token）
   *   skeleton —— **更窄一档**：在 brief 之上**连 tags / links 也省掉**，只留 id/topic/depth/expanded/children。
   *               实测（187 节点的 comnet）：`--brief --compact` 43,963 B，
   *               其中 links 占 9,776 B + tags 占 2,333 B ⇒ skeleton 再省 **27.5%**（到 31,854 B）。
   *               为什么会缺这一档：`--brief` 保留 tags/links（导航信息），而 `list --json` 是**扁平**的
   *               （没有 children 嵌套）—— 「**有嵌套但只有结构**」原本没有入口。
   *   detail   —— false 时省略 detail（默认保留）
   *   images   —— false 时省略 images / files 与顶层资源清单（默认保留）
   *
   * 注意两个**对外契约**，改形状会破坏消费者：
   *   1. `children` 是「浅摘要数组」（{id, topic, children: 子数}），不是数字也不是全量嵌套；
   *   2. `depth` 从 **0** 起（tree.walk 的 depth 从 1 起，故此处减 1）。
   */
  function buildReadView(data, opts) {
    const o = opts || {};
    const brief = !!o.brief;
    const skeleton = !!o.skeleton;                 // skeleton ⊃ brief：更窄的一档
    const lean = brief || skeleton;                // 省略长文本与资源的共同条件
    const withDetail = !lean && o.detail !== false;
    const withImages = !lean && o.images !== false;
    const withTags = !skeleton;                    // 只有 skeleton 会砍掉 tags/links
    const withLinks = !skeleton;
    const nodes = [];
    tree.walk(data.data, (n, depth) => {
      nodes.push({
        id: n.id,
        topic: n.topic,
        depth: depth - 1,
        expanded: n.expanded !== false,
        detail: withDetail && n.detail ? n.detail : undefined,
        tags: withTags && Array.isArray(n.tags) && n.tags.length ? n.tags : undefined,
        images: withImages && Array.isArray(n.images) && n.images.length ? n.images : undefined,
        files: withImages && Array.isArray(n.files) && n.files.length ? n.files : undefined,
        links: withLinks && Array.isArray(n.links) && n.links.length ? n.links : undefined,
        // 本机文件夹路径（可选）：从文件夹结构建的树，每个结构节点挂一条。
        // 与 tags/links 同一档：skeleton（最窄那档）才省掉它 —— AI 靠它知道"这个节点对应哪个真目录"。
        localPath: withLinks && n.localPath ? n.localPath : undefined,
        // AI 问答记录（可选）：与 tags/links 同一档（skeleton 才省掉）。**brief 不省** ——
        // 它是"这段结论是哪次 AI 交流得来的"，属于导航信息而不是长文本（answer 可能长，
        // 所以真嫌大就上 skeleton，别用 brief 半省）。
        qa: withLinks && Array.isArray(n.qa) && n.qa.length ? n.qa : undefined,
        // 来源指纹（可选，§2.8）：与 qa 同一档（skeleton 才省掉，brief 不省）。
        // 它只挂在**一次导入产生的那几棵子树的根**上，条数 ≈ 导入次数（不是节点数）⇒ 代价极低，
        // 而"这个文件导过没有"正是批量导入必须先看得见的东西 ✓
        origin: withLinks && n.origin && typeof n.origin === 'object' ? n.origin : undefined,
        children: (n.children || []).map((c) => ({
          id: c.id, topic: c.topic, children: (c.children || []).length
        }))
      });
    });
    const out = { meta: data.meta, nodeCount: nodes.length, nodes };
    // 标记互斥：skeleton 更窄，就不要再声称 brief（否则消费者会以为 tags/links 只是恰好为空）
    if (skeleton) out.skeleton = true;
    else if (brief) out.brief = true;
    if (withImages) out.images = collectImages(data.data);
    return out;
  }

  /** list --json 的扁平节点表（depth 从 0 起，与 buildReadView 同口径） */
  function buildNodeList(root) {
    const nodes = [];
    tree.walk(root, (n, depth) => {
      nodes.push({
        id: n.id, topic: n.topic, depth: depth - 1,
        expanded: n.expanded !== false, childCount: (n.children || []).length
      });
    });
    return nodes;
  }

  /**
   * get 的节点视图。
   * opts: { detail, images } —— 仅在需要时才带上长文本/资源（省 token）
   * 始终带 `path`（root → 该节点的真实层级 id 数组）。找不到返回 null。
   */
  function getNodeView(root, id, opts) {
    const o = opts || {};
    const node = tree.find(root, id);
    if (!node) return null;
    const out = { id: node.id, topic: node.topic, expanded: node.expanded !== false };
    if (node.tags && node.tags.length) out.tags = node.tags;
    if (o.detail && node.detail) out.detail = node.detail;
    // 与 files/links 同样的"空数组不产生噪音键"策略：原来 images 只判真值不判长度，
    // 于是 `get --json` 会出现 `"images": []`，与同类字段不一致。
    if (o.images && Array.isArray(node.images) && node.images.length) out.images = node.images;
    if (node.files && node.files.length) out.files = node.files;
    if (node.links && node.links.length) out.links = node.links;
    if (node.localPath) out.localPath = node.localPath;   // 本机文件夹路径（界面点击即打开该目录）
    // AI 问答记录（可选，§2.7）：**总是带出**，不挂在 `opts.detail` 下 ——
    // `get --json` 是"这个节点的实况"，而"这段详情是哪次 AI 交流写的"属于实况的一部分；
    // 挂到 detail 下会让 `get --json`（不带 --detail）看不出它，而 MCP 的 get_node 正带 --detail，
    // 两条路读到的字段集就会分叉（本工程反复治的"同一件事两处表达"）。
    if (Array.isArray(node.qa) && node.qa.length) out.qa = node.qa;
    // 来源指纹（可选，§2.8）：与 qa 同一条策略 —— **总是带出**。理由也一样：它是"这个节点
    // 的实况"（这份内容是从哪个文件导进来的）的一部分，挂到 `opts.detail` 下会让
    // `get --json`（不带 --detail）看不见它，而幂等判定正需要它 ✓
    if (node.origin && typeof node.origin === 'object') out.origin = node.origin;
    out.path = tree.pathTo(root, id) || [id];
    return out;
  }

  /** 项目统计。project 字段由调用方附加（本函数不认识"项目名"）。 */
  function computeStats(root) {
    let nodes = 0, images = 0, files = 0, links = 0, detailedNodes = 0, taggedNodes = 0, maxDepth = 0;
    let originNodes = 0;                      // 带来源指纹的**节点**数（= 有几次导入留了痕）
    const tagSet = new Set();
    const originSet = new Set();              // 不同的**(来源, 指纹)**组合数（同一次导入只算一个）
    tree.walk(root, (n, d) => {
      nodes++;
      images += (n.images || []).length;
      files += (n.files || []).length;
      links += (n.links || []).length;
      if ((n.tags || []).length) { taggedNodes++; n.tags.forEach((t) => tagSet.add(t)); }
      if (typeof n.detail === 'string' && n.detail.trim()) detailedNodes++;
      // 来源指纹（§2.8）：排查"这个项目里哪些内容是从文件导进来的、导过几份"用。
      // 两个数都报：`originNodes` 答"有多少节点带来源"，`originSources` 答"涉及几份不同来源"
      //（同一个文件被 --force 导两次 ⇒ 节点数涨、来源数不涨 —— 一眼能看出那是重复导的）。
      if (n.origin && typeof n.origin === 'object') {
        originNodes++;
        if (n.origin.src) originSet.add(n.origin.src + '#' + n.origin.sha256);
      }
      if (d > maxDepth) maxDepth = d;
    });
    return { nodes, maxDepth, images, files, links, detailedNodes, taggedNodes, tags: tagSet.size,
      originNodes: originNodes, originSources: originSet.size };
  }

  /**
   * 搜索节点。
   * opts: { keyword, tag, full }
   *   - keyword 为空且有 tag → 按标签过滤，matchIn 恒为 'tag'
   *   - full 为真 → 额外匹配 detail 正文 / 图片 caption / 标签 / 链接说明
   *     （默认只匹配 topic）
   * 返回 { hits: [{id, topic, matchIn, snippet}] }，命中顺序为深度优先。
   */
  function searchNodes(root, opts) {
    const o = opts || {};
    const kw = o.keyword;
    const tag = o.tag;
    const full = !!o.full;
    const hits = [];
    tree.walk(root, (n) => {
      const tagPass = !tag || (Array.isArray(n.tags) && n.tags.indexOf(tag) >= 0);
      if (!tagPass) return;                    // 只跳过本节点，walk 仍会继续其子树
      if (kw) {
        const detailText = convert.stripHtml(n.detail);
        const inTopic = !!(n.topic && n.topic.indexOf(kw) >= 0);
        const inDetail = full && detailText.indexOf(kw) >= 0;
        const inCaption = full && (n.images || []).some((i) => i.caption && i.caption.indexOf(kw) >= 0);
        const inTag = full && (n.tags || []).some((t) => t.indexOf(kw) >= 0);
        const inLinkCaption = full && (n.links || []).some((l) => l.caption && l.caption.indexOf(kw) >= 0);
        if (inTopic || inDetail || inCaption || inTag || inLinkCaption) {
          const matchIn = [
            inTopic ? 'topic' : '', inDetail ? 'detail' : '', inCaption ? 'caption' : '',
            inTag ? 'tag' : '', inLinkCaption ? 'link' : ''
          ].filter(Boolean);
          const pos = inTopic ? n.topic.indexOf(kw) : (inDetail ? detailText.indexOf(kw) : -1);
          hits.push({
            id: n.id, topic: n.topic, matchIn: matchIn.join(','),
            snippet: pos >= 0 ? (inTopic ? n.topic : detailText).slice(Math.max(0, pos - 20), pos + 60) : undefined
          });
        }
      } else {
        hits.push({ id: n.id, topic: n.topic, matchIn: 'tag', snippet: undefined });
      }
    });
    return { hits };
  }

  /** 树形文本（read/list 的非 JSON 输出用）：返回字符串数组，由调用方逐行输出。
   *  根节点缩进为 0（与历史 printTree 的 depth=0 口径一致）。 */
  function treeLines(root) {
    const lines = [];
    (function walk(n, depth) {
      const pad = '  '.repeat(depth);
      const imgs = (n.images && n.images.length) ? '  [' + n.images.length + '图]' : '';
      lines.push(pad + (n.expanded === false ? '▸ ' : '▾ ') + n.id + '  ' + n.topic + imgs);
      (n.children || []).forEach((c) => walk(c, depth + 1));
    })(root, 0);
    return lines;
  }

  return { collectImages, buildReadView, buildNodeList, getNodeView, computeStats, searchNodes, treeLines };
});
