/* ============================================================
 * src/item-index.js — 条目级索引 / 检索 / 取回（UMD 纯逻辑，无 I/O）
 * ------------------------------------------------------------
 * 契约（**已冻结，别改口径**）：`docs/ITEM-MODEL.md`
 *   §3.1 条目视图 · §3.4 命中形状与预算 · §7 qa 派生化 · §5.1 条目 id 全项目唯一。
 *
 * 本模块是**这一类事实的唯一实现处**（照工程"一份事实只写一处"的规矩）：
 *   · 命中形状 {id,topic,nodeId,nodeTopic,itemId,type,itemized,matchIn,snippet,src,verified,score}
 *   · 命中长度与预算的**全套常量**（snippet 上界 / `--limit` / `--max-bytes` / token 估算口径）
 *     —— 契约 §3.4 明写"本文不抄数值"，所以命令层、文档、测试里都不许再写一份数字。
 *   · 条目视图（§3.1）、`get` 的条目摘要数组（§3.3）、`qa` 的派生化（§7）。
 *
 * ⚠️ **它不实现"什么算命中、谁排前面"**（【W6】，2026-10-13）：那是 `src/palette-rank.js` 的
 * `fuzzyMatch` + `rankRows`，命令面板与这里**共用同一份**（判据"同一查询在 UI 与 CLI 一致顺序"）。
 * 本模块只负责"把哪些面喂给它"（标题 / 正文 / 条目正文 / 图片说明 / 链接说明）与"命中的形状"。
 *
 * 三条纪律：
 *   ① **不落盘**：只读查询**不生成索引文件**（工程既有纪律 —— 给最频繁的动作新增一道强制
 *      重生成步骤是净成本）。索引只在内存里：`buildIndexes(root)` 建一次，批量/多次查询的
 *      调用方把它经 `opts.indexes` 传回来复用（照 `src/relations.js` 的 buildIndexes 先例）。
 *   ② **纯函数**：不改树、不读盘、不读时钟（`--since` 只比较给定的时间串，不取 now）。
 *   ③ 本模块**不认识"项目名"**：顶层 `{project}` 由命令层附加（同 `src/query.js` 的 computeStats 先例）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tree-utils.js'), require('./convert.js'), require('./palette-rank.js'));
  } else {
    // ⚠️ 浏览器侧要 `root.MMPaletteRank` 先在场（`src/palette-rank.js` 先 `<script>` 载入）——
    // 单个谓词/打分实现只有那一份（W6：命令面板与 AI 侧检索同一份，见那边文件头）。
    root.MMItemIndex = factory(root.MMTree, root.MMConvert, root.MMPaletteRank);
  }
})(typeof self !== 'undefined' ? self : this, function (tree, convert, paletteRank) {
  'use strict';

  /* ---------------- 常量（唯一实现处：别在别处再写一份数字） ---------------- */

  /** snippet 的**长度上界**（字符）。契约 §3.4：「长度上界只有一处实现」。 */
  const SNIPPET_MAX = 120;
  /** 关键词前后的取窗（沿用 v2 的 pos-20 … pos+60 口径，再统一上界到 SNIPPET_MAX）。 */
  const SNIPPET_LEFT = 20;
  const SNIPPET_RIGHT = 60;

  /** `--limit` 的缺省与上界：**有界缺省**（契约 §3.4「两者缺省值都有界」）。 */
  const DEFAULT_LIMIT = 200;
  const LIMIT_MAX = 1000;

  /** `--max-bytes` 的缺省与上界（字节）。 */
  const DEFAULT_MAX_BYTES = 65536;
  const MAX_BYTES_MAX = 4 * 1024 * 1024;
  /**
   * `--max-bytes` 的**下界**。为什么不让它小到 1：hits 全被截光时返回的是 `[]`，
   * 光那个空数组就有 2 字节 —— 上界比它小的话，"实际返回字节 ≤ 上界"这条承诺**永远做不到**，
   * 于是那个参数值本身是自相矛盾的。给一个能容纳空结果的下界，承诺才无条件成立
   * （命令层拿它当 `ctx.intOption('maxBytes', {min: MIN_MAX_BYTES})`，越界当场报错）。
   */
  const MIN_MAX_BYTES = 16;

  /**
   * 【W1 · `search-all` 跨项目检索】的**两条硬上限**：越限 ⇒ **响亮报错**（不返回半份结果），
   * 与 `--limit` / `--max-bytes` 的"截断可见"是**两件事**，别互相冒充：
   *   · `--limit` / `--max-bytes` = **调用方给的预算** ⇒ 截断 + 非静默地报出来（`truncated` / `budget.resume`）；
   *   · 这两条 = **能力上限**（调用方改不了）⇒ 整次检索**被拒绝**，报文里给读数与出路。
   * 为什么上限必须"拒绝"而不是"截断"：跨项目检索的调用方是 AI，`hitCount` 会被它当成
   * "库里关于这个关键词的全部" —— 悄悄少给一部分，它后面所有推理都建立在一个虚假的完整上 ✗。
   *
   * 值为什么在这里：本模块是"检索预算与长度上界"这一类事实的**唯一实现处**（见文件头），
   * 这两条与 `DEFAULT_LIMIT` 同族 ⇒ 命令层、文档、测试都不许再写一份数字（`cli/registry.js`
   * 的 desc 也是从本模块**现取**这两个数）。
   */
  /** 全库命中总数上界（超过 ⇒ 报错：让人收窄关键词 / 用 `--scope` 收窄项目） */
  const SCAN_MAX_HITS = 2000;
  /** 全库扫描耗时上界（毫秒；超过 ⇒ 报错 —— 越过它意味着这次检索已不适合"顺手扫一遍"） */
  const SCAN_MAX_MS = 3000;

  /**
   * 预算报告里 "估算 token" 的换算口径：`ceil(bytes / 4)`。
   * 为什么是 4：照本机 DSH 的既有启发式（`CHARS_PER_TOKEN = 4`，见
   * `docs/changelog/v0.16.0.md`）—— 一份口径好过两份。
   * ⚠️ **它不是计费真值**：中文一字 3 字节 ÷ 4 ≈ 0.75，而实际通常 ≥ 1 token ⇒ 中文场景会**低报**。
   * 它的用途是"这次比上次大多少""还塞不塞得进上下文"这类**相对**判断。
   */
  const BYTES_PER_TOKEN = 4;

  /** `--since` 的续取提示（截断时才出现，`budget.resume`）。 */
  const RESUME_ADVICE = '续取方式：① 收窄关键词（更长的词命中更少）；② 加 --since <ISO> 只看新条目；'
    + '③ 用 --limit <n> 接着取（本次已取满）；④ 用 get <项目> <节点id> --item <itemId> 只取某一条正文。';

  /**
   * `matchIn` 的取值表（**封闭**，契约 §3.4）。
   * `detail` 是**v2 兼容值**：`--full` 下"未条目化节点的正文命中"从 v2 起就报它，
   * 而 `tests/query.test.js` 钉着这个字面量 ⇒ 不能改（改了要动别人的文件，那是越界）。
   * `item-tag` / `node-tag` 只出现在 mode='items'；mode='topic-only' 一律用 v2 那五个值。
   */
  const MATCH_IN = Object.freeze(['topic', 'item', 'item-tag', 'node-tag', 'caption', 'tag', 'link', 'detail']);

  /** `type` 的取值表（封闭，契约 §1）：别的值判红。 */
  const TYPES = Object.freeze(['text', 'rich', 'qa']);

  /* ---------------- 基础口径（字节 / 文本 / 列归一） ---------------- */

  /**
   * UTF-8 字节数 —— **唯一的字节口径**：`--max-bytes`、`budget.bytes`、条目摘要的 `bytes` 都走它。
   * 三层兜底的理由：本模块是 UMD（Node + 浏览器双端）。Node 有 `Buffer`、浏览器有
   * `TextEncoder`；两者都没有时按码点手算（代理对算 4 字节）。**别在别处再写一份字节数**。
   */
  function utf8Bytes(s) {
    const str = (s === undefined || s === null) ? '' : String(s);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str).length;
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(str, 'utf8');
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  /** 预算报告里的 token 粗估（口径见 BYTES_PER_TOKEN）。 */
  function estTokens(bytes) {
    return Math.ceil((Number(bytes) || 0) / BYTES_PER_TOKEN);
  }

  /**
   * 条目的**检索面纯文本**（也是 `get` 摘要里 `bytes` 的口径 —— 两处只有这一份实现）。
   *   · `text` / `rich`：`convert.stripHtml(item.html)`（剥标签 + 解实体 + 压空白）
   *   · `qa`：`q + ' ' + a` —— 正文由 `src/qa.js` 渲染，这里只要"可搜的文本"，
   *     所以**不**去复制那段渲染逻辑（复制它就会有两份会漂移的问答渲染）
   */
  function itemText(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'qa') {
      const qa = item.qa || {};
      const q = (qa.q === undefined || qa.q === null) ? '' : String(qa.q);
      const a = (qa.a === undefined || qa.a === null) ? '' : String(qa.a);
      return [q, a].filter((x) => x).join(' ');
    }
    return convert.stripHtml(item.html);
  }

  /**
   * `item.src` 归一成字符串数组（§1 允许"字符串或字符串数组"；读命令面统一成数组形状）。
   *
   * ⚠️ **`src` 归一化的唯一实现就在这里** —— 谓词只写这一遍：只留**非空字符串**、保序、
   * **不去重**（同一个出处写两遍是数据的事，不是归一化该修的）。
   * `src/item-src.js` 的 `normalizeSrc(v)` 是它的**薄适配**（把"值"包成条目形状再调这里），
   * 两处因此是"同一份实现的两个用法"，不再是"两份同口径的实现互证"。
   * 方向为什么是那一侧来调这一侧：本模块按 **UMD 双端**写（浏览器侧本可 `<script>` 直载；
   * 今天 `renderer/index.html` 还没载它），那边是 **Node-only**（要读盘）—— 双端模块依赖
   * Node-only 模块，浏览器侧会**静默失效**；
   * 详见 `src/item-src.js` 里 `normalizeSrc` 的注释（含同层不成环的实测依据）。
   */
  function srcList(item) {
    if (!item || item.src === undefined || item.src === null) return [];
    const raw = Array.isArray(item.src) ? item.src : [item.src];
    return raw.filter((s) => typeof s === 'string' && s.length > 0);
  }

  /** 标签命中判定：**精确相等**（v2 口径，不做模糊/大小写折叠 —— 折叠会引入第二套"什么算命中"） */
  function hasTag(list, tag) {
    if (!tag) return false;
    return Array.isArray(list) && list.indexOf(tag) >= 0;
  }

  /**
   * 【W6】关键词命中（**这一维的判定与打分的唯一入口**）：走 `src/palette-rank.js` 的
   * `fuzzyMatch` —— 命令面板筛的命令/节点用的就是它。
   *
   * 口径（判据见待做清单 W6 一节）：
   *   · 命中 = **非连续子序列**（于是"子串命中"是它的特例，不是第二条判据 —— 旧实现那些
   *     `indexOf(kw) >= 0` 全被它取代）；
   *   · 大小写不敏感（与面板一致）；
   *   · 分数越小越优（可为负），`start` = 命中首字符位置（取 snippet 窗口用）。
   * ⚠️ 本模块**不 trim** 关键词（`cli` 层给什么就用什么）：判定与定序必须用**同一个** needle。
   */
  function faceMatch(kw, text) {
    return paletteRank.fuzzyMatch(kw, text);
  }

  /** 第一个命中关键词的图片说明（`--full` 的额外面之一）；形状与 `faceMatch` 同源：{text, start} | null */
  function firstCaption(node, kw) {
    const imgs = node.images || [];
    for (let i = 0; i < imgs.length; i++) {
      const c = imgs[i] && imgs[i].caption;
      const m = c ? faceMatch(kw, c) : null;
      if (m) return { text: c, start: m.start };
    }
    return null;
  }

  /** 第一个命中关键词的节点级标签（`--full` 的额外面之一） */
  function firstTag(tags, kw) {
    const list = tags || [];
    for (let i = 0; i < list.length; i++) {
      const t = typeof list[i] === 'string' ? list[i] : null;
      const m = t ? faceMatch(kw, t) : null;
      if (m) return { text: t, start: m.start };
    }
    return null;
  }

  /** 第一个命中关键词的跨项目链接说明（`--full` 的额外面之一） */
  function firstLinkCaption(node, kw) {
    const links = node.links || [];
    for (let i = 0; i < links.length; i++) {
      const c = links[i] && links[i].caption;
      const m = c ? faceMatch(kw, c) : null;
      if (m) return { text: c, start: m.start };
    }
    return null;
  }

  /** 关键词在文本里出现的次数（`score` 的口径；至少 1 —— 能被调用的前提就是已命中） */
  function countOccurrences(text, kw) {
    if (!kw) return 1;
    let n = 0;
    let i = 0;
    for (;;) {
      const p = text.indexOf(kw, i);
      if (p < 0) break;
      n++;
      i = p + kw.length;
    }
    return n || 1;
  }

  /**
   * snippet：没有位置（纯标签命中）就取**正文头部**；有位置就取关键词周围的窗口。
   * 最后统一 `slice(0, SNIPPET_MAX)` —— 于是"命中片段有多长"只有这一个上界。
   */
  function clip(text, pos) {
    const s = (text === undefined || text === null) ? '' : String(text);
    if (!s) return '';
    if (pos === undefined || pos === null || pos < 0) return s.slice(0, SNIPPET_MAX);
    const from = Math.max(0, pos - SNIPPET_LEFT);
    return s.slice(from, pos + SNIPPET_RIGHT).slice(0, SNIPPET_MAX);
  }

  /* ---------------- 选项解析（纯函数；命令层只负责把 reason 变成 ctx.error） ---------------- */

  /**
   * 布尔开关（`--verified`）：只认 true/false 两个字面量 + 裸写（= true）。
   * 为什么收窄（照 `cli/commands/edit.js` 的 `--expanded` 先例）：`--verified=nonsense`
   * 若按"非 false 即 true"处理，会**静默按错误的方向过滤** —— 那种"看起来生效、其实没生效"
   * 比直接报错危险得多。
   */
  function parseFlag(v) {
    if (v === undefined || v === null) return { ok: true, value: false, reason: '' };
    if (v === true || v === 'true' || v === '') return { ok: true, value: true, reason: '' };
    if (v === false || v === 'false') return { ok: true, value: false, reason: '' };
    return { ok: false, value: false, reason: '只能是 true 或 false（收到 ' + JSON.stringify(v) + '）' };
  }

  /**
   * `--since <ISO>`：**当场判非法**。契约只对 `--limit`/`--max-bytes` 明说"非法值要报错"，
   * 但一个写错的时间串会静默变成"0 命中"，而"0 命中"与"条件写错"在回显上分不开 ——
   * 同一个坑（静默退化）就同一套处理。返回 `{ok, value(毫秒|null), reason}`；**不取 now**。
   */
  function parseSince(v) {
    if (v === undefined || v === null || v === '') return { ok: true, value: null, reason: '' };
    const ms = Date.parse(String(v));
    if (!Number.isFinite(ms)) {
      return { ok: false, value: null,
        reason: '需要一个能解析的时间（如 2026-10-11 或 2026-10-11T04:00:00Z），收到 ' + JSON.stringify(v) };
    }
    return { ok: true, value: ms, reason: '' };
  }

  /** `--type <t>`：取值表封闭（§1），非法值当场报错并给出允许集。 */
  function parseType(v) {
    if (v === undefined || v === null || v === '') return { ok: true, value: '', reason: '' };
    const t = String(v);
    if (TYPES.indexOf(t) < 0) {
      return { ok: false, value: '', reason: '只能是 ' + TYPES.join(' / ') + ' 之一（收到 ' + JSON.stringify(v) + '）' };
    }
    return { ok: true, value: t, reason: '' };
  }

  /** `--items i-a,i-b` / `--item i-a` 归一：逗号或空白分隔 → 去空、**去重保序**。 */
  function normalizeItemIds(v) {
    if (v === undefined || v === null) return [];
    const raw = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
    const out = [];
    raw.forEach((x) => {
      const s = String(x === undefined || x === null ? '' : x).trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  /* ---------------- 索引（内存，一次建、多次用；不落盘） ---------------- */

  /**
   * **一次建索引，多次复用**（照 `src/relations.js` 的 buildIndexes 先例）。
   * 批量/多次查询的调用方务必把返回值经 `opts.indexes` 传回 —— 否则每次查询都要重跑一遍
   * `stripHtml`（那是检索里唯一的重活）。
   *
   * 三张表：
   *   · `entries`  深度优先的节点条目表（**命中顺序就是它**），每条条目带**预计算的纯文本**
   *   · `byNodeId` 节点 id → entry（O(1) 定位）
   *   · `itemById` 条目 id → `{node, item, path}`（**项目级反查**：§5.1 保证条目 id 全项目唯一，
   *                所以 `get --item`/`read --items` 与"这个 itemId 属于哪个节点"的报错都靠它）
   *
   * **为什么正文维不建词表倒排**（如实说明，别以为漏了）：本模块做的是**子串**检索（`indexOf`），
   * 词表倒排服务不了子串；要用它就得先定义"什么算一个词"（中文还要分词或二元组）——
   * 那是第二套口径，收益不抵复杂度。预计算纯文本已经消掉了唯一的重活。
   */
  function buildIndexes(root) {
    const entries = [];
    const byNodeId = Object.create(null);   // null 原型：防 `__proto__` 这类 id 污染索引
    const itemById = Object.create(null);

    (function dfs(node, depth, path, seq) {
      if (!node || typeof node !== 'object') return;
      const here = path.concat([node.id]);
      const itemized = Array.isArray(node.items);
      const items = [];
      if (itemized) {
        node.items.forEach((item, i) => {
          if (!item || typeof item !== 'object') return;
          const rec = { item: item, text: itemText(item), seq: seq + ':' + i };
          items.push(rec);
          if (item.id !== undefined && item.id !== null && !(item.id in itemById)) {
            itemById[item.id] = { node: node, item: item, path: here };
          }
        });
      }
      const entry = { node: node, depth: depth, path: here, itemized: itemized, items: items, seq: entries.length };
      entries.push(entry);
      byNodeId[node.id] = entry;
      (node.children || []).forEach((c) => dfs(c, depth + 1, here, seq));
    })(root, 0, [], '0');

    return { entries: entries, byNodeId: byNodeId, itemById: itemById };
  }

  /** 项目级按条目 id 定位（`get --item` / `read --items` 用）：找不到返回 null。 */
  function findItem(root, itemId, indexes) {
    if (!itemId) return null;
    const idx = indexes || buildIndexes(root);
    return idx.itemById[itemId] || null;
  }

  /* ---------------- 视图形状（契约 §3.1 / §3.3） ---------------- */

  function nodePathOf(root, nodeId, path) {
    if (Array.isArray(path) && path.length) return path.slice();
    return tree.pathTo(root, nodeId) || [nodeId];
  }

  /**
   * 条目视图（契约 §3.1）：**空值不产生噪音键**（`src`/`tags`/`at`/`by`/`verified`/`supersededBy`/`qa`
   * 缺省即不出现）。`html` 原样带出（保真，便于原地改写）；`type:'qa'` **禁止**出现 `html`
   *（同一事实两处表达），由 `qa` 子对象承载。
   * 键顺序照契约逐字：nodeId,nodeTopic,path,itemId,type,html,src,tags,at,by,verified,supersededBy,qa。
   */
  function itemView(node, item, path) {
    const out = {
      nodeId: node.id,
      nodeTopic: node.topic,
      path: Array.isArray(path) ? path.slice() : [node.id],
      itemId: item.id,
      type: item.type
    };
    if (item.type !== 'qa' && item.html !== undefined) out.html = item.html;
    const src = srcList(item);
    if (src.length) out.src = src;
    if (Array.isArray(item.tags) && item.tags.length) out.tags = item.tags.slice();
    if (item.at) out.at = item.at;
    if (item.by) out.by = item.by;
    if (item.verified && typeof item.verified === 'object') out.verified = item.verified;
    if (item.supersededBy) out.supersededBy = item.supersededBy;
    if (item.type === 'qa' && item.qa && typeof item.qa === 'object') out.qa = item.qa;
    return out;
  }

  /**
   * `get` 的条目**摘要**（契约 §3.3）：`{itemId,type,src,verified:<bool>,at,bytes}` —— **不含正文**。
   * `verified` 是**布尔**（"核过没有"），不是 §1 的三字段对象（整份记录走 `get --item`）。
   * `bytes` 的口径 = 该条目**检索面纯文本**的 UTF-8 字节数（与 snippet/预算同源，见 itemText）。
   */
  function itemSummary(item) {
    const out = { itemId: item.id, type: item.type };
    const src = srcList(item);
    if (src.length) out.src = src;
    out.verified = !!item.verified;
    if (item.at) out.at = item.at;
    out.bytes = utf8Bytes(itemText(item));
    return out;
  }

  /**
   * 条目化节点的 `qa` **视图派生**（契约 §7）：由 items 里 `type:'qa'` 的条目**按条目序**取
   * `item.qa`（形状/字段顺序与 v2 一致）⇒ 老消费者照常可用，且 `read --json` 迁移前后逐字节不变。
   * 返回 `null` 表示"没有 qa 面"（调用方据此不产生噪音键）。
   */
  function qaFromItems(node) {
    if (!node || !Array.isArray(node.items)) return null;
    const out = [];
    node.items.forEach((it) => {
      if (it && it.type === 'qa' && it.qa && typeof it.qa === 'object') out.push(it.qa);
    });
    return out.length ? out : null;
  }

  /* ---------------- 检索（契约 §3.4） ---------------- */

  /**
   * 造一条命中（形状 = 契约 §3.4 逐字）。
   * `id`/`topic` 是 **v2 兼容别名**（老消费者：MCP `search_nodes`、渲染层都读这两个键）。
   * 空值不产生噪音键：`snippet` 取不到就不出现、`src` 为空就不出现。
   * `itemId`/`type` 为 `null` = 这次命中不在条目面上（节点级命中，或未条目化节点）；
   * `itemized` 如实反映"该节点有没有 items"（**注意**：topic-only 口径下条目化节点的
   * itemId 也是 null —— 契约 AC9 就是这么钉的）。
   */
  function hitOf(entry, item, matchIn, extra) {
    const n = entry.node;
    const out = {
      id: n.id,
      topic: n.topic,
      nodeId: n.id,
      nodeTopic: n.topic,
      itemId: item ? item.id : null,
      type: item ? (item.type === undefined ? null : item.type) : null,
      itemized: !!entry.itemized,
      matchIn: matchIn
    };
    const snippet = extra && extra.snippet;
    if (snippet) out.snippet = snippet;
    if (item) {
      const src = srcList(item);
      if (src.length) out.src = src;
    }
    out.verified = !!(item && item.verified);
    out.score = (extra && extra.score) ? extra.score : 1;
    return out;
  }

  /**
   * `--src` 的**子串匹配**（契约 §3.4：「只命中 `src` 含**子串**的条目」）。
   *
   * ⚠️ **这一维的匹配只有这一处实现**：`src/item-src.js` 的 `matchesSrc()` 是它的**薄转发**。
   * 改前是两份同口径实现（那份与 `passItemFilters` 里那行 `list.some(s => s.indexOf(f.src) >= 0)`）
   * ⇒ 第五批收成一处（方向与理由同第四批的 `normalizeSrc`）：本模块是 **UMD 双端**，
   * `src/item-src.js` 是 **Node-only**（要读盘）—— 双端模块依赖 Node-only 模块，浏览器那一侧
   * 会**静默失效**（那边既没有 `MMItemSrc` 可注入、也没有 `root.MMItemSrc` 可传）。
   *
   * ## 契约（**两层分工，别把两层的判据混起来**）
   *   · **空 needle 不是过滤条件 —— 判断"有没有过滤"归过滤层；匹配函数的契约是 needle 非空**。
   *     "这一维到底过滤没过滤"由 `passItemFilters` 开头的 `if (f.src)` 回答（命令层的
   *     `--src` 有没有**出现**同理），判的是"**参数出现没出现**"，**不是**它的真值；
   *   · 所以本函数只回答"命中不命中"，**不回答**"要不要过滤"。`needle` 为空串 / `null` /
   *     `undefined` 属**契约外**输入，这里按"**不命中**"返回 `false` 兜底（与收口前
   *     `matchesSrc` 的读数**逐字一致**）—— 这里的 `false` 意思是"没命中"，
   *     **不是**"没给过滤"：后者只有过滤层能答（把 `false` 读成"有过滤且不通过"是误读）。
   *
   * @param {object|string[]} itemOrSrc 条目（读 `.src`）或 `src` 数组本身
   * @param {string} needle 非空子串（契约要求；空值走上面的兜底）
   */
  function srcMatches(itemOrSrc, needle) {
    if (needle === undefined || needle === null || needle === '') return false;
    const list = Array.isArray(itemOrSrc) ? srcList({ src: itemOrSrc }) : srcList(itemOrSrc);
    const q = String(needle);
    return list.some((s) => s.indexOf(q) >= 0);
  }

  /**
   * 条目级过滤（契约 §3.4 的 `--src`/`--verified`/`--type`/`--since`）。
   *
   * **这四维只有条目有** ⇒ 给了它们就**只返回条目级命中**（未条目化节点、以及"节点级命中"
   * 一律不返回）。契约对 `--since` 明说了这条（"给了它就不返回未条目化的节点命中"），
   * 本实现把同一条规矩扩到另外三个：否则 `--type qa` 会连"没有 type 的节点命中"一起返回，
   * 那是同一类"过滤了却没真的过滤"的坑。
   *
   * **这一层就是"过滤层"**（`srcMatches` 的契约注释里的那两层分工）：四维各自用
   * "**参数有没有给**"判有没有过滤 —— `if (f.type)` / `if (f.verified)` / `if (f.src)` /
   * `if (f.since !== null)`。所以 `src` 为空串 ⇒ **这条过滤不存在**（不是"过滤条件是一个空串"）⇒
   * 跳过这一段、任何条目都通过；**匹配本身**（needle 非空那个前提）一律走 `srcMatches`，
   * 本函数里不许再写一遍子串判定。
   *
   * `--since` 的两个细节：① 比较 `item.at >= since`（ISO → 毫秒）；② **没有 `at` 的条目
   * 不返回** —— `at` 在契约 §1 里是可选字段，而"取不到时间"不能满足"新于某时刻"。
   */
  function passItemFilters(item, f) {
    if (!item) return false;
    if (f.type && item.type !== f.type) return false;
    if (f.verified && !item.verified) return false;
    if (f.src) {
      if (!srcMatches(item, f.src)) return false;
    }
    if (f.since !== null) {
      const t = item.at ? Date.parse(item.at) : NaN;
      if (!Number.isFinite(t) || t < f.since) return false;
    }
    return true;
  }

  /**
   * **热度向量的排序**（热度条第二件）—— 命中顺序**最后一道**重排（全工程唯一一处）。
   *
   * ⚠️ 它是**最后一道**、不是唯一一道：入参 `hits` 已经是**字面匹配**排好的顺序
   * （【W6】`src/palette-rank.js` 的 `rankRows`：模糊分升序、同分保持 DFS+条目序）。
   * 分工写清楚，免得两处打架：字面匹配决定**基线顺序**，热度只在这个基线上做**封顶**的微调。
   *
   * 为什么它在这里、数值却在 `src/heat.js`：
   *   · **数值与口径**（人 / AI / 合并三条上限、名次→档位）只有一处 = `src/heat.js` 的
   *     `SEARCH_RANK` + `searchBoost`（那里把"两条榜"折成一个已封顶的加数 + 它占总分的份额）；
   *   · **排序**只有一处 = 本函数。它只认两个数，**不认识任何热度取值**（所以本模块仍是纯逻辑、
   *     不读盘、不认识项目名 —— 见文件头三条纪律）。
   *
   * 公式（`scale` = 热度项占总分的份额上限，由 `heat.js` 给）：
   *   总分(i) = (1 − scale) × 基础分(i) + 热度项[命中.nodeId]
   *   基础分(i) = (n − i) / n —— i 是**既有顺序**（深度优先 + 条目序）里的位置。
   * 三条性质（判据靠它们）：
   *   ① **零热度 ⇒ 顺序逐字不变**：热度项全 0 时总分随 i 严格递减 ⇒ 排序结果与不排序相同；
   *   ② **热度只是重排，不增删命中**：入参与出参是同一批对象（同一个数组元素），
   *      `hitCount`（=截断前命中总数）与 `hits` 的内容都不受影响；
   *   ③ **确定性**：同分按原位置（`a - b`）—— 不依赖 Array.sort 的稳定性，也不按 id 抢位。
   *
   * @param {Array} hits `searchItems` 收上来的命中（既有顺序）
   * @param {{scale:number, byNode:Map}} [heat] `src/heat.js` 的 `searchBoost()` 产物；
   *        不给 ⇒ 原样返回（既有调用方与 `--topic-only` 等路径行为不变）
   */
  function orderByHeat(hits, heat) {
    const arr = Array.isArray(hits) ? hits : [];
    if (!heat || arr.length < 2) return arr;
    const raw = Number(heat.scale);
    if (!Number.isFinite(raw) || raw <= 0) return arr;
    const scale = Math.min(1, raw);            // 份额 >1 夹到 1（= 顺序全由热度决定，注入证明走这条）
    const byNode = heat.byNode;
    const boost = (h) => {
      if (!byNode || typeof byNode.get !== 'function') return 0;
      const v = byNode.get(h.nodeId);
      return Number.isFinite(v) ? v : 0;
    };
    const n = arr.length;
    const key = (i) => (1 - scale) * ((n - i) / n) + boost(arr[i]);
    const order = arr.map((h, i) => i).sort((a, b) => (key(b) - key(a)) || (a - b));
    return order.map((i) => arr[i]);
  }

  /** 卡预算：先按 `--limit` 截，再按 `--max-bytes` 逐条回退（**不许静默少给**：截了就给 truncated） */
  function applyBudget(hits, limit, maxBytes) {
    let out = (limit > 0 && hits.length > limit) ? hits.slice(0, limit) : hits.slice();
    let truncated = out.length < hits.length;
    let bytes = utf8Bytes(JSON.stringify(out));
    while (out.length && bytes > maxBytes) {
      out = out.slice(0, out.length - 1);
      truncated = true;
      bytes = utf8Bytes(JSON.stringify(out));
    }
    return { hits: out, truncated: truncated, bytes: bytes };
  }

  /**
   * **卡预算 + 组预算报告**（唯一实现处）：`searchItems` 与 `search-all` 都走它。
   *
   * 为什么把它单列并导出：跨项目检索（`search-all`）要在**合并后的整批命中**上卡同一套预算 ——
   * 若命令层自己再拼一个 `budget` 对象，那"截断时给续取方式"这条口径就有两份会漂的副本 ✗
   * （本工程的老病：同一份清单多副本）。数字仍是 `applyBudget` 算的那一份，这里只补 token 估算与 resume。
   *
   * @returns {hits, truncated, budget:{bytes,estTokens,limit,maxBytes,resume?}}（`resume` 只在截断时出现）
   */
  function budgeted(hits, limit, maxBytes) {
    const arr = Array.isArray(hits) ? hits : [];
    const b = applyBudget(arr, limit, maxBytes);
    const budget = { bytes: b.bytes, estTokens: estTokens(b.bytes), limit: limit, maxBytes: maxBytes };
    if (b.truncated) budget.resume = RESUME_ADVICE;     // 只增字段：截断时才出现
    return { hits: b.hits, truncated: b.truncated, budget: budget };
  }

  /**
   * 【W1】`search-all` 的**扫描闸门**（唯一实现处）：把"扫到现在"的读数交进来 ⇒ 放行 / 拦下。
   *
   * 三条性质（`tests/search-all.test.js` 靠它们判，别改口径）：
   *   ① 两条上限**各自独立**判：命中越限与耗时越限是两种失败，`code` 分别是 `scan-hits` / `scan-time`
   *      （调用方据此分辨"改关键词"还是"改范围/换时间"）；
   *   ② 边界口径是 `>` 不是 `>=`：**等于上限放行**、**大于上限**才拦（"上限"= 允许的最大值）；
   *   ③ 报文三件套：**读数**（命中 / 项目 / 毫秒）+ 越过的是**哪一条**（含上限值）+ **出路**
   *      （`--scope` 收窄项目 / `--tag`、更长关键词 收窄命中）—— 只说"超限了"等于没说（F1 响亮）。
   *
   * ⚠️ 本函数**不读时钟**（本模块三条纪律之一）：`elapsedMs` 由命令层读 `Date.now()` 算好送进来
   * —— 纯函数 ⇒ 越限判定可被单测直接钉，不必靠"跑得够慢"。
   *
   * @param {{hits?:number, projects?:number, elapsedMs?:number, project?:string}} reading
   * @returns {{ok:true, hits, projects, elapsedMs}} 或 {ok:false, code:'scan-hits'|'scan-time', message, …读数}
   */
  function scanGate(reading) {
    const o = reading || {};
    const hits = Number(o.hits) || 0;
    const projects = Number(o.projects) || 0;
    const ms = Number(o.elapsedMs) || 0;
    const out = { hits: hits, projects: projects, elapsedMs: ms };
    const at = projects
      ? '（扫到第 ' + projects + ' 个项目' + (o.project ? '「' + o.project + '」' : '') + '时）'
      : '';
    const ways = '出路三条（任选）：① `--scope 项目名,项目名` 只扫某几个项目；'
      + '② `--tag` 或**更长**的关键词（越长命中越少）；③ 逐个项目 `search` 分开取。';
    if (hits > SCAN_MAX_HITS) {
      return Object.assign({ ok: false, code: 'scan-hits',
        message: '跨项目检索被**上限**拦下：命中 ' + hits + ' 条 > 上限 ' + SCAN_MAX_HITS + ' 条' + at
          + '。这不是截断 —— 本次**一条都不返回**（少给一部分会让"库里关于它的全部"变成假话）。' + ways }, out);
    }
    if (ms > SCAN_MAX_MS) {
      return Object.assign({ ok: false, code: 'scan-time',
        message: '跨项目检索被**上限**拦下：已扫 ' + ms + ' ms > 上限 ' + SCAN_MAX_MS + ' ms' + at
          + '。这不是截断 —— 本次**一条都不返回**。' + ways
          + '④ 若库本来就大，请把"全库扫一遍"改成按项目的 `search`（单项目有它自己的预算口径）。' }, out);
    }
    return Object.assign({ ok: true }, out);
  }

  /**
   * 检索条目（契约 §3.4）。**默认口径 = 搜条目**（节点 topic ∪ 条目正文）；
   * `topicOnly:true` 退回 v2（只搜标题）。
   *
   * 【W6】**命中与顺序**：命中 = 关键词是命中面的**非连续子序列**（大小写不敏感），
   * 顺序 = 那份模糊打分升序、同分保持 DFS+条目序 —— 判定与定序都在
   * `src/palette-rank.js`（命令面板同一份实现，判据"同一查询在 UI 与 CLI 一致顺序"）。
   * 纯 `--tag`（无关键词）**不排序**（没有可打分的东西）。热度在**那之后**才重排（封顶）。
   *
   * @param root 树根（`data.data`）
   * @param opts {
   *   keyword, tag, full, topicOnly,
   *   src, verified, type, since,        // 条目级过滤（见 passItemFilters）
   *   limit, maxBytes,                   // 缺省值有界（常量在上方）；**合法性由调用方挡**（core.intOption）
   *   heat,                              // 热度向量：{scale, byNode} —— 由 src/heat.js 的 searchBoost 造
   *                                      // （本模块不认识"热度"的任何数值；不给 ⇒ 顺序 = 模糊分序）
   *   indexes                            // buildIndexes(root) 的结果（多次查询务必传）
   * }
   * @returns {ok, message?, mode, hits, hitCount, truncated, budget}
   *   · `hitCount` = **截断前的命中总数**（"全量命中数"）；`hits.length` 才是本次返回数
   *   · `budget` = `{bytes, estTokens, limit, maxBytes}`，截断时另加 `resume`（续取方式）
   *   · `ok:false` 时 `hits` 为空数组，`message` 是**完整可打印**的报错（命令层只需 `ctx.error(r.message)`）
   */
  function searchItems(root, opts) {
    const o = opts || {};
    const mode = o.topicOnly ? 'topic-only' : 'items';
    const kw = (o.keyword === undefined || o.keyword === null) ? '' : String(o.keyword);
    const tag = (o.tag === undefined || o.tag === null) ? '' : String(o.tag);
    const full = !!o.full;

    const fail = (code, message) => ({ ok: false, code: code, message: message, mode: mode,
      hits: [], hitCount: 0, truncated: false, budget: null });

    // 参数闸门（不静默退化：写错的过滤条件必须当天红，而不是变成"0 命中"）
    const vf = parseFlag(o.verified);
    if (!vf.ok) return fail('bad-option', '--verified ' + vf.reason);
    const tf = parseType(o.type);
    if (!tf.ok) return fail('bad-option', '--type ' + tf.reason);
    const sf = parseSince(o.since);
    if (!sf.ok) return fail('bad-option', '--since ' + sf.reason);
    if (!kw && !tag) return fail('no-criteria', '缺少关键词（或用 --tag 按标签搜索）');

    // 条目级过滤 × topic-only：**两种口径不混**（同 `read --items` × `--brief` 的纪律）
    const itemOnly = [];
    if (o.src) itemOnly.push('--src');
    if (vf.value) itemOnly.push('--verified');
    if (tf.value) itemOnly.push('--type');
    if (sf.value !== null) itemOnly.push('--since');
    if (mode === 'topic-only' && itemOnly.length) {
      return fail('mode-clash', '--topic-only 与 ' + itemOnly.join(' / ') + ' 不能同给：'
        + '这几个是**条目级**过滤，而 --topic-only 是回到 v2 的"只搜标题"口径（没有条目面）。'
        + '去掉 --topic-only，或去掉它们。');
    }

    const f = { src: o.src ? String(o.src) : '', verified: vf.value, type: tf.value, since: sf.value };
    const onlyItems = !!(f.src || f.verified || f.type || f.since !== null);
    const limit = (typeof o.limit === 'number' && o.limit > 0) ? o.limit : DEFAULT_LIMIT;
    const maxBytes = (typeof o.maxBytes === 'number' && o.maxBytes > 0) ? o.maxBytes : DEFAULT_MAX_BYTES;

    const idx = o.indexes || buildIndexes(root);
    const raw = [];
    /* 【W6】与命中**逐条平行**的"命中面原文"：定序时拿它重算分数（`rankRows` 自己算，
     * 本模块不写第二遍打分）。为什么不把这段文本挂到命中对象上：命中形状是**冻结契约**
     * （契约 §3.4，`tests/item-index.test.js` 与集成断言都逐键数过 —— 恰好 12 个键），
     * 挂上去就是加键；挂成不可枚举属性又是"看不见的字段"，比平行数组更难查。
     * ⚠️ 两个数组**必须同时 push** ⇒ 统一走下面的 `addHit`（手写 `raw.push` 会漏掉同步）。 */
    const faceTexts = [];
    const addHit = (hit, faceText) => { raw.push(hit); faceTexts.push(faceText); };

    idx.entries.forEach((entry) => {
      const n = entry.node;
      if (!n) return;
      const nodeTag = tag ? hasTag(n.tags, tag) : false;
      const anyItemTag = tag ? entry.items.some((rec) => hasTag(rec.item.tags, tag)) : false;

      // ---------------- 纯标签检索（无关键词） ----------------
      if (!kw) {
        if (!tag) return;
        if (entry.itemized) {
          entry.items.forEach((rec) => {
            const itemTag = hasTag(rec.item.tags, tag);
            if (!itemTag && !nodeTag) return;
            if (!passItemFilters(rec.item, f)) return;
            addHit(hitOf(entry, rec.item, itemTag ? 'item-tag' : 'node-tag',
              { snippet: clip(rec.text, -1), score: 1 }), rec.text);
          });
          return;
        }
        // 未条目化节点：节点级标签命中，报 v2 的 `tag`（`tests/query.test.js` 钉着这个字面量）
        if (!nodeTag) return;
        if (onlyItems) return;
        addHit(hitOf(entry, null, 'tag', {}), '');
        return;
      }

      // ---------------- 关键词检索 ----------------
      // `--tag` 与关键词是 **AND**（v2 口径：两者都要满足）
      if (tag && !nodeTag && !anyItemTag) return;

      /* 【W6】命中判定 = 非连续子序列（`faceMatch` ⇒ `src/palette-rank.js` 的 `fuzzyMatch`）。
       * 改前这里是 `n.topic.indexOf(kw) >= 0` 一类**字面子串**判定 —— 于是"tcp"在 CLI 能命中
       * "T 类 C 协议 P"，而"tp"（跳过 c）在面板能命中、在 CLI 不能。现在两边同一个谓词。
       * `m.start` 是命中首字符位置：snippet 窗口照它取（**不**再另算一次 indexOf ——
       * 那样"命中在哪"与"窗口开在哪"就会有两套口径）。 */
      const mTopic = faceMatch(kw, n.topic);
      const detailText = full ? convert.stripHtml(n.detail) : '';
      const mDetail = (full && (mode === 'topic-only' || !entry.itemized)) ? faceMatch(kw, detailText) : null;
      const captionHit = full ? firstCaption(n, kw) : null;
      const tagHitText = full ? firstTag(n.tags, kw) : null;
      const linkHit = full ? firstLinkCaption(n, kw) : null;

      // 节点级面，按优先级取**最强的那一个**（v2 是逗号连成一串；现在是封闭取值表的单值）：
      // topic > item/detail > caption > tag|node-tag > link
      const faces = [];
      if (mTopic) faces.push({ m: 'topic', text: n.topic, start: mTopic.start });
      // 正文面（v2 的 `--full` 面，**不能丢**：`tests/query.test.js` 钉着它）：
      //   · topic-only ⇒ v2 逐字口径，所有节点的 detail 都搜（条目化节点的 detail 是派生缓存，
      //     在 v2 里它就是那个 detail）；
      //   · 默认口径（items）⇒ **只对未条目化节点**搜 detail。条目化节点的正文由"条目面"承载，
      //     再搜一遍派生 detail 会让同一段文字既出条目命中又出节点命中（重复命中）。
      // 命中仍报 v2 的 `detail`（matchIn 取值表里的兼容值，契约 §3.4 的封闭表含它）。
      if (mDetail) faces.push({ m: 'detail', text: detailText, start: mDetail.start });
      if (captionHit !== null) faces.push({ m: 'caption', text: captionHit.text, start: captionHit.start });
      if (tagHitText !== null) {
        faces.push({ m: (mode === 'items' && entry.itemized) ? 'node-tag' : 'tag',
          text: tagHitText.text, start: tagHitText.start });
      }
      if (linkHit !== null) faces.push({ m: 'link', text: linkHit.text, start: linkHit.start });

      // 节点级命中：条目级过滤给了就不返回（那几维只描述条目）
      if (!onlyItems && faces.length) {
        const face = faces[0];
        addHit(hitOf(entry, null, face.m, {
          snippet: clip(face.text, face.start),
          // `score` 的口径**没变**（契约 §3.4 的示例就是"出现次数"，`>= 1`）：模糊命中取不到子串
          // 出现次数，`countOccurrences` 会回落成 1 —— 它不是排序键（排序键是上面那份打分）
          score: countOccurrences(face.text, kw)
        }), face.text);
      }

      // 条目面（**只有默认口径才有**：--topic-only 是"回到 v2 的只搜标题"）
      if (mode === 'items') {
        entry.items.forEach((rec) => {
          const m = faceMatch(kw, rec.text);
          if (!m) return;
          if (tag && !hasTag(rec.item.tags, tag) && !nodeTag) return;
          if (!passItemFilters(rec.item, f)) return;
          addHit(hitOf(entry, rec.item, 'item',
            { snippet: clip(rec.text, m.start), score: countOccurrences(rec.text, kw) }), rec.text);
        });
      }
    });

    /* ---- 【W6】定序：**唯一实现** = `src/palette-rank.js` 的 `rankRows`（命令面板吃的就是它）----
     * 排的是"字面匹配"这一路：分数升序、同分保持上面那段扫出来的顺序（DFS + 条目序）。
     * 判据"同一查询在 UI 与 CLI 得到一致顺序"就靠这一行与 `rankPalette` 里那一行是同一个函数。
     * · 空关键词（纯 `--tag` 检索）⇒ **不排**：没有可打分的东西，就不假装排过（顺序照旧）。
     * · 排名在**热度之前**：热度（H1）是**最后一道**重排、且封顶，它把这里的顺序当作基线 ——
     *   于是 `--no-heat` / 本机没有热度日志时，CLI 顺序与命令面板**逐条相同**。 */
    const ranked = kw ? paletteRank.rankRows(raw, kw, (h, i) => faceTexts[i]) : raw;
    const ordered = orderByHeat(ranked, o.heat);   // 热度：**只重排**，不增删命中（不改变"命中/不命中"）
    // 预算与预算报告只有一处实现（`budgeted`）：`search-all` 的合并批走的是同一个函数
    const b = budgeted(ordered, limit, maxBytes);
    return {
      ok: true, mode: mode, hits: b.hits, hitCount: raw.length,
      truncated: b.truncated, budget: b.budget
    };
  }

  /* ---------------- 取回（契约 §3.1 / §3.3 的读命令面） ---------------- */

  /**
   * `get <项目> <节点id> --item <itemId>` 的条目视图（契约 §3.1）。
   * **报文也在这里定**（单源）：调用方只做 `if (!r.ok) ctx.error(r.message)`，
   * 不再自己拼一句话（否则"条目不在这个节点"与"条目不存在"两种情况的措辞会各写一份）。
   *
   * @returns {ok:true, code:'ok', view} 或 {ok:false, code, message}
   *   code: 'node-missing' | 'item-missing' | 'item-elsewhere'
   */
  function getItemView(root, nodeId, itemId, indexes) {
    const node = tree.find(root, nodeId);
    if (!node) return { ok: false, code: 'node-missing', message: '节点不存在: ' + nodeId };
    const id = (itemId === undefined || itemId === null) ? '' : String(itemId).trim();
    if (!id) {
      return { ok: false, code: 'item-missing',
        message: '缺少条目 id（用法: get <项目> <节点id> --item <itemId>）' };
    }
    const items = Array.isArray(node.items) ? node.items : null;
    if (items) {
      const hit = items.filter((it) => it && it.id === id)[0];
      if (hit) {
        return { ok: true, code: 'ok', view: itemView(node, hit, nodePathOf(root, nodeId, null)) };
      }
    }
    // 不在该节点 ⇒ **指名它实际属于哪个节点**（契约 §3.3 的必错情形）
    const elsewhere = findItem(root, id, indexes);
    if (elsewhere) {
      return { ok: false, code: 'item-elsewhere',
        message: '节点 ' + nodeId + ' 下没有条目 ' + id + '（它在节点 ' + elsewhere.node.id
          + (elsewhere.node.topic ? '「' + elsewhere.node.topic + '」' : '') + ' 下）' };
    }
    return { ok: false, code: 'item-missing',
      message: '条目不存在: ' + id + (items
        ? '（节点 ' + nodeId + ' 下共 ' + items.length + ' 条，逐个 id 见 get --json 的 items 摘要）'
        : '（节点 ' + nodeId + ' 未条目化：它没有 items）') };
  }

  /**
   * `read <项目> --items <i-a,i-b,…>`（契约 §3.3）：只取这几条的**正文**。
   *   · 任何一个 id 不存在 ⇒ **整体失败**并逐个点名（**不给半份**：调用方会把"缺失"当"空"）
   *   · 与 `--brief`/`--skeleton`/`--subtree` 同给 ⇒ 拒绝（两种口径不混）
   * 顺序 = 调用方给的顺序；重复的 id 只取一次（重复写同一个 id 不等于"要两份"）。
   * @returns {ok:true, view:{meta, project, itemCount, items}} 或 {ok:false, code, message, missing?}
   */
  function readItemsView(data, idsRaw, opts) {
    const o = opts || {};
    const ids = normalizeItemIds(idsRaw);
    if (!ids.length) {
      return { ok: false, code: 'no-ids', missing: [],
        message: '--items 需要一个或多个条目 id：read <项目> --items i-a,i-b（逗号分隔）' };
    }
    const clash = [];
    if (o.brief) clash.push('--brief');
    if (o.skeleton) clash.push('--skeleton');
    if (o.subtree !== undefined && o.subtree !== null && o.subtree !== false) clash.push('--subtree');
    if (clash.length) {
      return { ok: false, code: 'mode-clash', missing: [],
        message: '--items 与 ' + clash.join(' / ') + ' 不能同给：前者只取指定条目的正文，'
          + '后者是整棵树的视图口径（两种口径不混）' };
    }
    const root = data && data.data;
    const idx = buildIndexes(root);
    const missing = ids.filter((id) => !idx.itemById[id]);
    if (missing.length) {
      return { ok: false, code: 'item-missing', missing: missing,
        message: '条目不存在: ' + missing.join(' / ') + '（**整份都不返回** —— 半份会让调用方把"缺失"当"空"；'
          + '先用 search 拿到存在的 id）' };
    }
    const items = ids.map((id) => {
      const r = idx.itemById[id];
      return itemView(r.node, r.item, r.path);
    });
    return { ok: true, code: 'ok', view: {
      meta: (data && data.meta) || null,
      project: (o.project === undefined || o.project === null) ? null : o.project,
      itemCount: items.length,
      items: items
    } };
  }

  return {
    // 常量（唯一实现处）
    SNIPPET_MAX: SNIPPET_MAX, DEFAULT_LIMIT: DEFAULT_LIMIT, LIMIT_MAX: LIMIT_MAX,
    DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES, MIN_MAX_BYTES: MIN_MAX_BYTES, MAX_BYTES_MAX: MAX_BYTES_MAX,
    BYTES_PER_TOKEN: BYTES_PER_TOKEN, MATCH_IN: MATCH_IN, TYPES: TYPES,
    RESUME_ADVICE: RESUME_ADVICE,
    // 口径
    utf8Bytes: utf8Bytes, estTokens: estTokens, itemText: itemText, srcList: srcList,
    // 【W6】关键词命中判定（= 非连续子序列）的**唯一入口**：本体是 `src/palette-rank.js` 的
    // `fuzzyMatch`（命令面板同一份）。导出它，好让"这一维的谓词只有一处"能被直接钉住。
    faceMatch: faceMatch,
    // `--src` 这条边界的**两层分工**（见 `srcMatches` 的契约注释：空 needle 不是过滤条件，
    // "有没有给过滤"归过滤层）：`srcMatches` = 唯一匹配实现，`passItemFilters` = 过滤层。
    // 两者都导出，是因为这条边界要能被**直接钉住**（`src/item-src.js` 的 `matchesSrc` 只是薄转发）。
    srcMatches: srcMatches, passItemFilters: passItemFilters,
    // 选项解析
    parseFlag: parseFlag, parseSince: parseSince, parseType: parseType, normalizeItemIds: normalizeItemIds,
    // 索引
    buildIndexes: buildIndexes, findItem: findItem,
    // 视图
    itemView: itemView, itemSummary: itemSummary, qaFromItems: qaFromItems,
    // 检索与取回
    searchItems: searchItems, getItemView: getItemView, readItemsView: readItemsView,
    // 热度向量的**排序**唯一实现处（数值/口径在 src/heat.js：这里一个热度数字都没有）
    orderByHeat: orderByHeat,
    // 预算与预算报告的**唯一实现处**（`searchItems` 自己走的就是它；`search-all` 的合并批也走它）
    budgeted: budgeted,
    /** 【W1】全库检索的两条硬上限 + 扫描闸门（唯一实现处；命令层与登记表都不许再写一份数字） */
    scanGate: scanGate, SCAN_MAX_HITS: SCAN_MAX_HITS, SCAN_MAX_MS: SCAN_MAX_MS
  };
});
