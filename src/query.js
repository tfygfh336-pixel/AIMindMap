/* ============================================================
 * src/query.js — 查询与视图构造（UMD 纯逻辑，无 IO）
 * ------------------------------------------------------------
 * 从 cli/commands/project.js 下沉而来。这些函数决定了 **AI 看到什么**：
 * read --json 的视图、list、get、search、stats。此前它们是命令文件里的
 * 私有函数，命令层零单测 —— 只能靠端到端断言间接覆盖。
 * 下沉到 src/ 后可直接单测（见 tests/query.test.js）。
 *
 * 全部函数对输入只读、不改树；不读盘、不写盘。
 *
 * 条目层（v3）起有一处**依赖方向**要记住：条目级的命中形状、长度/预算常量、条目视图与
 * `qa` 派生化都实现在 `src/item-index.js`（契约 `docs/ITEM-MODEL.md` §3.1/§3.4/§7），
 * 本模块只做视图组装与兼容转发（`searchNodes` / `getItemView` / `readItemsView`）——
 * 两份实现会在"命中片段多长""什么算一条命中"上各说一套，那是本工程最贵的病。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tree-utils.js'), require('./convert.js'), require('./item-index.js'));
  } else {
    root.MMQuery = factory(root.MMTree, root.MMConvert, root.MMItemIndex);
  }
})(typeof self !== 'undefined' ? self : this, function (tree, convert, itemIndex) {
  'use strict';

  /**
   * `qa` 的**视图派生**（条目层契约 `docs/ITEM-MODEL.md` §7）：
   *   · 条目化节点（有 `items`）⇒ 由 items 里 `type:'qa'` 的条目**按条目序**取 `item.qa`
   *     —— 老消费者（界面、MCP）读的还是同一个字段，且迁移前后 `read --json` 逐字节不变；
   *   · 未条目化节点 ⇒ 照旧读 `node.qa`（v2 读兼容）。
   * 没有 qa 面时返回 `null`（调用方据此**不产生噪音键**）。
   * 为什么条目化节点上**不再看** `node.qa`：契约 §2 判红"有 items 却有 qa[]"
   * （同一事实两处表达）⇒ 读视图不能给这种数据第二个出口。
   */
  function qaView(node) {
    if (node && Array.isArray(node.items)) return itemIndex.qaFromItems(node);
    return (node && Array.isArray(node.qa) && node.qa.length) ? node.qa : null;
  }

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
      const qa = withLinks ? qaView(n) : null;
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
        // ⚠️ 条目层（v3）起这里是**派生的**：条目化节点上由 items 现场算（见 qaView），
        // 不是因为节点上不再存 qa[] 就少给东西 —— 形状与 v2 逐字段相同。
        qa: qa || undefined,
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
    // 条目化节点上它是**派生**的（见 qaView），形状与 v2 逐字段相同 ⇒ 老消费者不用改。
    const qa = qaView(node);
    if (qa) out.qa = qa;
    // 条目**摘要数组**（契约 §3.3）：条目化节点额外带一份 `{itemId,type,src,verified,at,bytes}`，
    // **不含正文** —— 正文是长文本，取回它请走 `get --item` / `read --items`（那是条目层的定点入口）。
    // 0 条的条目化节点不产生这个键（照"空数组不产生噪音键"的既有策略）。
    if (Array.isArray(node.items) && node.items.length) {
      out.items = node.items.map((it) => itemIndex.itemSummary(it));
    }
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
   * 搜索（**内容已整体下沉到 `src/item-index.js`**；这里保留 v2 的名字当兼容入口，
   * 老调用方与 `tests/query.test.js` 用的都是它）。
   *
   * 口径（契约 `docs/ITEM-MODEL.md` §3.4，**2026-10 起默认口径改了**）：
   *   · 默认搜**条目**：节点 topic ∪ 条目正文；`--topic-only` 退回 v2（只搜标题）
   *   · `--full` 在默认口径之上再并上 v2 的额外面（图片 caption / 节点级标签 / 链接说明）
   *   · 命中形状与长度/预算的常量**只在 `src/item-index.js`**（别在这里再写一份）
   * 返回 `{ok, mode, hits, hitCount, truncated, budget}`；`ok:false` 时 `message` 可直接打印。
   */
  function searchNodes(root, opts) {
    return itemIndex.searchItems(root, opts);
  }

  /** `get <项目> <节点id> --item <itemId>` 的条目视图（契约 §3.1）—— 实现见 src/item-index.js */
  function getItemView(root, nodeId, itemId, indexes) {
    return itemIndex.getItemView(root, nodeId, itemId, indexes);
  }

  /** `read <项目> --items <i-a,i-b>` 的视图（契约 §3.3，任一 id 缺失 ⇒ 整体失败）—— 实现同上 */
  function readItemsView(data, idsRaw, opts) {
    return itemIndex.readItemsView(data, idsRaw, opts);
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

  return { collectImages, buildReadView, buildNodeList, getNodeView, computeStats, searchNodes, treeLines,
    getItemView, readItemsView };
});
