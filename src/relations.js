/* ============================================================
 * src/relations.js — 引用关系计算（UMD）：反向链接 + 相关知识点
 * ------------------------------------------------------------
 * 纯逻辑 + 依赖注入：CLI、单测、渲染层（经 IPC）三方共用。
 * 节点形如 { id, topic, tags?, links?: [{project, id, item?, caption?}], items?: [{id,type,html?,tags?}] }。
 * 链接约定：links[].project 是目标项目目录名（=自身项目时表示同项目引用）。
 *
 * ---- 条目层（v3）升层：**形状只增字段，既有消费者零改动** ----
 * `links[].item`（可选，契约 ITEM-MODEL §7）把一条边从"节点 → 节点"细化为
 * "**某节点里的某一条条目** → 某节点里的某一条条目"。本模块对它的处理只有两条规矩：
 *   1) **`item` 是"更精确"而不是"另一回事"**：带 item 的边**仍然画在节点之间**
 *      （出边/入边/邻域的图结构一个节点都不多、一个都不少），只是多带一个 `item` 字段。
 *   2) **缺省即"没有这一层"**：v2 的边（没有 item）走的是**逐字节相同的**老路径 ——
 *      去重键、方向、计数、`via` 一个都没变。所以旧数据、旧断言、渲染层都不需要知道本层存在。
 *   3) **判据只有一处**：`refState()` 是"这个链接目标还在不在"的**唯一实现**，
 *      `link` 写入前的检查、`links-prune` 的自动清理、读口的报告都用它 ——
 *      绝不许在命令里另写一份"节点在不在 / 条目在不在"的判断（两处表达必漂移）。
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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./assoc.js'));
  else root.MMRelations = factory(root.MMAssoc || null);
})(typeof self !== 'undefined' ? self : this, function (assocMod) {
  'use strict';

  /** 锚点形状判据的唯一实现处是 `src/assoc.js`（`anchorKind`）；浏览器侧若没加载它，
   *  只影响"标签/片段锚点是不是恰好一种"这一维 —— 那就**响亮说判不了**，不猜。 */
  const anchorKindOf = (assocMod && typeof assocMod.anchorKind === 'function') ? assocMod.anchorKind : null;

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
   * 条目 id 的归一：`undefined` / `null` / `''` 一律读成 `''`（= **没有条目层**）。
   *
   * 为什么必须归一（而不是直接比 `===`）：契约给"清空这一层"留了**显式空串**这一档
   * （`--item ""`，与 K8 给 caption 定的 `--caption ""` 同一套词），而"省略 --item"
   * 读出来是 `undefined`。只比 `===` 会让这两个**同一个意思**的值走成两条路
   * （一条命中老边、一条造出一条新边）—— 那正是 K8 修掉的"用值的真假判意图"的老病。
   */
  function itemKey(x) { return typeof x === 'string' ? x : ''; }

  /** 两条边/两个引用是否为**同一层**（同项目同节点同条目）；`item` 缺省 = 节点级 */
  function sameRef(a, b) {
    if (!a || !b) return false;
    return a.project === b.project && a.id === b.id && itemKey(a.item) === itemKey(b.item);
  }

  /** 建立 项目名 → { 节点id: { 条目id: 条目对象 } } 索引（渲染 `item` 为可读标签时用） */
  function itemIndex(projects) {
    const idx = Object.create(null);
    (projects || []).forEach((p) => {
      if (!p || !p.name || !p.data || !p.data.data) return;
      idx[p.name] = Object.create(null);
      flatten(p.data.data).forEach((n) => {
        const box = Object.create(null);
        (Array.isArray(n.items) ? n.items : []).forEach((it) => {
          if (it && typeof it.id === 'string' && it.id) box[it.id] = it;
        });
        idx[p.name][n.id] = box;
      });
    });
    return idx;
  }

  /** HTML → 一行纯文本摘录（把条目的可读性交回给读者；不做富文本渲染） */
  function plainText(html) {
    return String(html === undefined || html === null ? '' : html)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 摘录上界（只做"够不够认出是哪一条"，不复制正文） */
  const EXCERPT_MAX = 24;

  /**
   * 把一条边上的 `item` 翻成**人能读的标注**（点名"是哪一条"，不止是 id）。
   * 取值优先级：条目标签 → 正文摘录 → 条目 id；都取不到就退回 id 本身
   * （**绝不返回空串** —— 空串会让"有 item"与"没有 item"在回显上不可分辨）。
   */
  function itemLabel(idx, project, nodeId, itemId) {
    const id = itemKey(itemId);
    if (!id) return '';
    const bag = (idx && idx[project] && idx[project][nodeId]) || null;
    const it = bag ? bag[id] : null;
    if (it) {
      if (Array.isArray(it.tags) && it.tags.length) return id + ' [' + it.tags.join(',') + ']';
      const txt = plainText(it.html);
      if (txt) {
        const cut = txt.length > EXCERPT_MAX ? txt.slice(0, EXCERPT_MAX) + '…' : txt;
        return id + ' 「' + cut + '」';
      }
      // qa 条目没有 html（正文在 qa 子对象里，见 ITEM-MODEL §1）⇒ 退回问题首句
      if (it.qa && typeof it.qa.q === 'string' && it.qa.q.trim()) {
        const q = it.qa.q.trim();
        return id + ' 「' + (q.length > EXCERPT_MAX ? q.slice(0, EXCERPT_MAX) + '…' : q) + '」';
      }
    }
    return id;
  }

  /** `item` 只在对**该对象**有意义时出现（照 get 的"空值不产生噪音键"策略） */
  function withItem(dst, itemId) {
    const v = itemKey(itemId);
    if (v) dst.item = v;
    return dst;
  }

  /**
   * **目标节点里有没有这一条条目** —— 条目级悬挂的**唯一判据**（第二处表达就是漂移的开始）。
   *
   * 谁用它：`refState()`（本模块，读口/清理口）；以及 `src/schema.js`（G2 的条目级悬挂判定）
   * 在**已经拿到目标节点对象**时直接调它 —— 那边只要注入节点对象，**判据本身仍只有这一份**。
   * 这也是契约 §12「悬挂检测与节点级**同一处逻辑**」的落法：判定 = 本函数 + `refState`，
   * 写入拒绝（`link --item`）、清理（`links-prune`）、闸门（G2）三处都只是**调用**它。
   *
   * @param {object} node 目标节点对象（调用方已解析出的那个）
   * @param {string} itemId 条目 id（空 / 缺省 ⇒ 节点级引用，**恒真**）
   * @returns {{ok:boolean, ids:string[]}} `ids` = 该节点现有条目 id（给**点名**用）
   */
  function targetHasItem(node, itemId) {
    const want = itemKey(itemId);
    const list = (node && Array.isArray(node.items)) ? node.items : [];
    const ids = list.filter((x) => x && typeof x.id === 'string').map((x) => x.id);
    if (!want) return { ok: true, ids };
    return { ok: ids.indexOf(want) >= 0, ids };
  }

  /**
   * 某个链接目标的**真实状态** —— 全工程**唯一**的"这个引用还在不在"判据。
   *
   * 契约要求（ITEM-MODEL §7/§12）：`links[].item` 的悬挂检测**与节点级同一处逻辑**。
   * 所以这里把两档合成**一次判定**，返回同一个词表；调用方（`link` 的前置检查、
   * `links-prune` 的自动清理、G2 的悬挂判定、读口的报告）**只许调它**，
   * 不许自己再 walk 一遍树、也不许另写一份"条目在不在"。
   *
   * @param {object} ref `{project, id, item?}`（或 `assoc.members[]` 的成员，形状相同）
   * @param {object} root 目标项目的数据根（`项目.json` 的 `data`），或 null/undefined（缺失/读不出来）
   * @param {string} project 目标项目名（只用于拼**可读的点名**）
   * @returns {{
   *   state: 'ok'|'bad-ref'|'no-project'|'no-node'|'no-item'|'unreadable',
   *   label: string, nodeTopic: string|null, itemLabel: string|null, hint: string
   * }}
   *   `label` 一律是 `项目/节点id[#条目id]` —— **点名**是硬要求（报错/清理报告都拿它当锚）。
   */
  function refState(ref, root, project) {
    const proj = String((ref && ref.project) || project || '');
    const nodeId = ref && ref.id !== undefined && ref.id !== null ? String(ref.id) : '';
    const itemId = itemKey(ref && ref.item);
    const label = proj + '/' + nodeId + (itemId ? '#' + itemId : '');
    const miss = (state, hint, extra) =>
      Object.assign({ state, label, nodeTopic: null, itemLabel: itemId || null, hint }, extra || {});
    if (ref === null || ref === undefined || typeof ref !== 'object'
      || !ref.project || !ref.id) {
      return miss('bad-ref', '引用缺少 project/id（结构问题，见 validate 的形状校验）');
    }
    if (root === null || root === undefined) {
      // "读不出来"与"不存在"是两回事：按工程规矩（采不到真值 = 红）**不确定就不猜**。
      return miss('unreadable', '目标项目读不出来（损坏/权限/被删）—— 不当作悬空处理，先修好项目再清理');
    }
    let node = null;
    (function find(n) {
      if (!n || node) return;
      if (n.id === ref.id) { node = n; return; }
      (n.children || []).forEach(find);
    })(root);
    if (!node) return miss('no-node', '目标节点不存在');
    // 节点在、条目不在 ⇒ 与"节点不在"**分开报**（报同一种会把修法指错：
    // 前者该剪链接，后者可能该恢复那条条目）。判据 = targetHasItem（同一份实现）。
    const has = targetHasItem(node, itemId);
    if (!has.ok) {
      return miss('no-item', '目标节点还在，但它已经没有条目 ' + itemId
        + (has.ids.length ? '（现有条目：' + has.ids.join(', ') + '）' : '（该节点现在没有条目层）'),
      { nodeTopic: node.topic });
    }
    return {
      state: 'ok',
      label,
      nodeTopic: node.topic === undefined ? null : node.topic,
      itemLabel: itemId || null,
      hint: ''
    };
  }

  /**
   * 一条**笔记锚点**（`assoc.anchors[]`）的真实状态 —— R7 新增的**唯一判据处**。
   *
   * 结构（**先复用既有两档，再补两个新词**）：
   *   · 先调 `refState()` —— "节点在不在 / 条目在不在 / 项目读不读得出来"**一个字不改**地复用；
   *   · `tag` 档补 `no-tag`（该标签还有没有节点带 —— **集合成员查询**，不是文本匹配，强判据）；
   *   · `text` 档补 `bad-anchor`（正文纯文本里还能不能匹配到关键词 —— **弱判据**：正文改写就失效）。
   *
   * ⚠️ 三档**都不静默**（§⑪-3.3）：
   *   · `no-tag` / `bad-anchor` 由 `validate`（G2）报、由 `assoc-prune --dry-run` **只报不剪**；
   *   · 界面侧靠"锚点声明是真源"——匹配不上**不是把笔记藏起来**，而是那篇笔记仍出现在
   *     「本页笔记」区、并把失效锚点画成坏引用态（判据见冒烟域 52）。
   *
   * @param {object} anchor `{tag}` | `{project,id,text}` | `{project,id,item}`（形状由 `src/assoc.js` 校验）
   * @param {{root:object|null, project:string}} target 目标项目的数据根与项目名（`root === null` ⇒ unreadable）
   * @param {{hasTag:(tag:string, project:string)=>boolean}|function} [tags] 标签索引
   * @returns {{state:string, label:string, nodeTopic:string|null, itemLabel:string|null, hint:string}}
   */
  function anchorState(anchor, target, tags) {
    const t = target || {};
    const proj = t.project || (anchor && anchor.project) || '';
    const miss = (state, label, hint) =>
      ({ state: state, label: label, nodeTopic: null, itemLabel: null, hint: hint });

    if (!anchor || typeof anchor !== 'object') {
      return miss('bad-ref', '(空锚点)', '锚点不是对象（结构问题，见 validate 的形状校验）');
    }
    if (!anchorKindOf) {
      return miss('unreadable', '', '浏览器侧没有加载 src/assoc.js（锚点形状判据缺一份实现）—— 不猜，先修好加载顺序');
    }
    const kind = anchorKindOf(anchor);
    if (!kind) {
      return miss('bad-ref', String(anchor.tag || anchor.text || anchor.item || ''),
        '锚点必须**恰好一种**（tag / text / item 三选一且非空）—— 结构问题，见 `assoc.validateAssoc`');
    }

    if (kind === 'tag') {
      const tag = String(anchor.tag);
      const where = anchor.project ? String(anchor.project) : proj;
      const has = (tags && typeof tags.hasTag === 'function') ? tags.hasTag
        : (typeof tags === 'function') ? tags : null;
      if (!has) {
        return miss('unreadable', '#' + tag, '没有拿到标签索引 ⇒ 判不了"这个标签还有没有节点带"（**采不到真值不许猜**）');
      }
      const got = has(tag, where);
      if (got === null || got === undefined) {
        return miss('unreadable', '#' + tag, '标签索引说读不出项目 ' + where + ' ⇒ 不当作悬空处理，先修好项目再判');
      }
      if (got) return { state: 'ok', label: '#' + tag, nodeTopic: null, itemLabel: null, hint: '' };
      return miss('no-tag', '#' + tag,
        '标签锚点失效：' + where + ' 里已经没有节点带 #' + tag
        + ' —— 修法：给节点加回该标签，或去掉这条锚点（`assoc-edit --anchor`）');
    }

    // 片段 / 条目两档：**先走 refState**（节点级与条目级的唯一判据），再补文本那一步
    const st = refState({ project: anchor.project, id: anchor.id, item: (kind === 'item' ? anchor.item : '') },
      t.root, proj);
    if (st.state !== 'ok') return st;
    if (kind !== 'text') {
      return { state: 'ok', label: st.label, nodeTopic: st.nodeTopic, itemLabel: st.itemLabel, hint: '' };
    }
    const want = String(anchor.text);
    // 取目标节点的正文纯文本：与 refState 走**同一段树遍历**（不另读一次盘）
    let node = null;
    (function find(n) {
      if (!n || node) return;
      if (n.id === anchor.id) { node = n; return; }
      (n.children || []).forEach(find);
    })(t.root);
    const text = plainText(node && node.detail);
    if (text.indexOf(want) >= 0) {
      return { state: 'ok', label: st.label + '#text:' + want, nodeTopic: st.nodeTopic, itemLabel: null, hint: '' };
    }
    return {
      state: 'bad-anchor',
      label: st.label + '#text:' + want,
      nodeTopic: st.nodeTopic,
      itemLabel: null,
      hint: '片段锚点失效：' + st.label + ' 的正文里已经匹配不到「' + want + '」'
        + '（正文被改写？）—— 修法：改锚点文本，或去掉这条锚点。**不许自动剪**'
        + '（剪掉可能让这篇笔记再无锚点；且"目标没了"与"词没了"是不同档）'
    };
  }

  /** 遍历某个项目根上**全部**引用（links 边 + assoc 成员），供批量判据/报告用（判据仍是 refState） */

  function allRefs(root, assocList) {
    const out = [];
    flatten(root).forEach((n) => {
      (n.links || []).forEach((l, i) => {
        if (!l || typeof l !== 'object') return;
        const r = {};
        if (l.project !== undefined) r.project = l.project;
        if (l.id !== undefined) r.id = l.id;
        if (itemKey(l.item)) r.item = l.item;
        if (l.caption !== undefined) r.caption = l.caption;
        out.push({ kind: 'link', from: n.id, at: 'links[' + i + ']', ref: r });
      });
    });
    (Array.isArray(assocList) ? assocList : []).forEach((a, ai) => {
      if (!a || !Array.isArray(a.members)) return;
      a.members.forEach((m, mi) => {
        if (!m || typeof m !== 'object') return;
        const r = {};
        if (m.project !== undefined) r.project = m.project;
        if (m.id !== undefined) r.id = m.id;
        if (itemKey(m.item)) r.item = m.item;
        out.push({ kind: 'assoc', from: a.id, at: 'assoc[' + ai + '].members[' + mi + ']', ref: r });
      });
    });
    return out;
  }

  /**
   * 反向链接索引：`"项目名|节点id" → [{project, node, topic, caption, item?, itemLabel?}]`
   * 一次遍历全部项目建立，供任意多个目标复用（depth 2 必需）。
   *
   * **去重口径说明（与 relatedAll 不同，是有意的）**：这里按 `项目|节点|条目|说明` 去重，
   * 因此"同一来源对同一目标写了两条不同说明的链接"会保留两行 —— 让 `backlinks` 能
   * 如实展示作者写的每条说明。而 `neighborhood1` 按 `项目|节点` 去重（只留一条），
   * 因为「相关知识点」是一份**关系清单**，同一关系重复出现没有意义。
   * 两者服务不同视图，故口径不同；若将来要统一，需同步改 CLI 输出契约。
   *
   * **条目层（v3）**：链接带 `item` 时，那一行的 `item` 与可读标注 `itemLabel` 一并带出
   * （**只增字段**）；去重键也含 `item` —— 同一节点里两条不同的条目各指一次同一目标，
   * 是**两条边**（少了 `item` 这一档，它们会被去重成一行，读口就"谁指了这一条"失真了）。
   * 老数据（没有 item）的去重键与从前**逐字节相同**。
   *
   * ⚠️ **`itemLabel` 要到"条目所在的那个节点"里去找** —— 而条目属于**目标节点**
   * （`l.project` / `l.id`），**不是**来源节点（`p.name` / `n.id`）。这两个坐标在建立索引时
   * 都是现成的：`itemLabel(iIdx, l.project, l.id, l.item)`。用来源坐标去查 ⇒ 查不到条目 ⇒
   * 标注静默退化成光秃秃的 id（"能读的那一半"丢了，而且看起来像"这条没写标签"）。
   */
  function backlinkIndex(projects) {
    const idx = Object.create(null);   // null 原型：同上，防 `__proto__` 类 id 污染索引
    const iIdx = itemIndex(projects);  // 只有真的遇到带 item 的边才会去查它
    (projects || []).forEach((p) => {
      if (!p || !p.name || !p.data || !p.data.data) return;
      flatten(p.data.data).forEach((n) => {
        (n.links || []).forEach((l) => {
          if (!l || !l.project || !l.id) return;   // 残缺链接忽略（validate 会另报）
          const k = l.project + '|' + l.id;
          const row = withItem(
            { project: p.name, node: n.id, topic: n.topic, caption: l.caption }, l.item);
          if (row.item) {
            const lab = itemLabel(iIdx, l.project, l.id, l.item);   // ← 目标坐标
            if (lab) row.itemLabel = lab;
          }
          (idx[k] = idx[k] || []).push(row);
        });
      });
    });
    // 去重（同源同目标同条目多次链接）
    Object.keys(idx).forEach((k) => {
      const seen = new Set();
      idx[k] = idx[k].filter((x) => {
        const u = x.project + '|' + x.node + '|' + itemKey(x.item) + '|' + (x.caption || '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      });
    });
    return idx;
  }

  /**
   * 按反向链接索引取「谁引用了我」 —— within=同项目，cross=其他项目。
   * 每行**只增字段**：带条目层的那一行多 `item`（+ `itemLabel`），节点级那行一个都不多。
   */
  function backlinksFrom(index, selfProject, targetId, includeSelf, itemId) {
    const hits = (index && index[selfProject + '|' + targetId]) || [];
    const want = itemKey(itemId);
    const rows = (x) => {
      // **只增字段**：v2 的边（没有 item）产出的对象键集合与从前**逐字相同**
      const r = withItem({ node: x.node, topic: x.topic, caption: x.caption }, x.item);
      if (x.itemLabel) r.itemLabel = x.itemLabel;
      return r;
    };
    const within = [];
    const cross = [];
    hits.forEach((x) => {
      // 给了 item ⇒ 只看**精确指到这一条**的边；不给 ⇒ 节点级与条目级**一起给**
      // （节点级的视图不该因为"有人精确指到某一条"而少掉那些边）。
      if (want && itemKey(x.item) !== want) return;
      if (x.project === selfProject) {
        if (includeSelf !== false) within.push(rows(x));
      } else {
        cross.push(Object.assign({ project: x.project }, rows(x)));
      }
    });
    return { within, cross };
  }

  /**
   * 计算某节点的反向链接（谁引用了我）。
   * @param selfProject 本项目目录名
   * @param targetId    目标节点 id（位于 selfProject 内）
   * @param projects    [{ name, data }] 全部项目（含本项目）
   * @param opts        { includeSelf: 是否包含本项目内来源（默认 true）,
   *                      item: 只取**精确指到这一条条目**的边（不给 = 节点级+条目级全给） }
   * @returns { within:[{node,topic,caption,item?}], cross:[{project,node,topic,caption,item?}] }
   *   within = 本项目内引用 targetId 的节点；cross = 其他项目里指向本项目 targetId 的节点。
   *   `item` 只在那一行真的带条目层时出现（老数据不产生这个键）。
   */
  function backlinksAll(selfProject, targetId, projects, opts) {
    const o = opts || {};
    return backlinksFrom(backlinkIndex(projects), selfProject, targetId, o.includeSelf, o.item);
  }

  /**
   * 计算「以某节点为心、半径 1」的邻域（出边 + 入边合并去重）。
   * 不返回计数 —— 计数由 relatedAll 按深度分层统计。
   *
   * **条目层（v3）**：`item` 与 `caption` 一样是**边上的注解**，不改变邻域的图结构 ——
   * 带 item 的边仍然画在**节点之间**（契约 §7 的 "渲染仍画在节点之间"，查询层才按条目过滤）。
   * 因此这里的去重仍然按 `项目|节点`，只把那一行的 `item` 带上（**只增字段**）。
   *
   * @param {string} selfProject
   * @param {object} selfNode 当前节点（需含 id 与 links）
   * @param {object} tIdx topicIndex
   * @param {object} blIdx backlinkIndex
   * @param {boolean} includeSelf
   * @param {object} [itemIdx] itemIndex（给了才能把 `item` 翻成可读标注；可选）
   * @param {object} [iIdxOf] `() => itemIndex`（惰性：v2 数据一次都不建）
   * @returns [{project, node, topic, caption, dir, item?, itemLabel?}] —— **只增字段**
   */
  function neighborhood1(selfProject, selfNode, tIdx, blIdx, includeSelf, itemIdx, iIdxOf) {
    const items = [];
    const seen = Object.create(null);   // null 原型：键含 `__proto__` 时也能正确去重
    // `itemLabel` 要到**条目所在的那个节点**里去找：出边 = 目标节点（`tProject`/`tNode`；
    // 条目属于目标 —— 契约 §7 的 `links[].item` 指的就是目标节点里的条目）；
    // 入边 = **来源节点**（那一条反向边上的 `x.itemLabel` 已经按它的目标坐标算好了，直接沿用）。
    // 查错坐标 ⇒ 标注静默退化成光秃秃的 id（看起来像"这条没写标签"）。
    const lab = (item, tProject, tNode) => {
      if (!itemKey(item)) return '';
      const idx = itemIdx || (iIdxOf ? iIdxOf() : null);
      return itemLabel(idx, tProject, tNode, item);
    };
    const push = (o) => {
      const project = o.project;
      const node = o.node;
      const caption = o.caption;
      const dir = o.dir;
      // 自链接防御：数据若声明"某节点引用自己"（CLI link 会拒，但手工编辑/导入可造出），
      // 该节点会以 dir:'both' 出现在**自己的**相关知识点里。跳过它。
      if (selfNode && selfNode.id && project === selfProject && node === selfNode.id) return;
      const k = project + '|' + node;
      const label = o.itemLabel || lab(o.item, o.tProject, o.tNode);
      if (seen[k]) {
        const prev = seen[k];
        if (prev.dir !== dir) prev.dir = 'both';
        if (!prev.caption && caption) prev.caption = caption;
        // 条目层同理"补不覆盖"：先到的那一行若没有 item，后来这一行有 ⇒ 补上
        // （否则"同一个邻居既有节点级边又有条目级边"时，条目层的证据会被丢掉）
        if (!itemKey(prev.item) && itemKey(o.item)) {
          withItem(prev, o.item);
          if (label) prev.itemLabel = label;
        }
        return;
      }
      const it = withItem(
        { project, node, topic: o.topic || node, caption: caption || '', dir }, o.item);
      if (label) it.itemLabel = label;
      seen[k] = it;
      items.push(it);
    };
    // 出边：本节点声明的链接（条目属于**目标**节点 ⇒ 标注查 tProject/tNode）
    ((selfNode && selfNode.links) || []).forEach((l) => {
      if (!l || !l.project || !l.id) return;
      push({
        project: l.project, node: l.id, topic: (tIdx[l.project] && tIdx[l.project][l.id]) || l.id,
        caption: l.caption, dir: 'out', item: l.item, tProject: l.project, tNode: l.id
      });
    });
    // 入边：谁引用了本节点（条目属于**来源**节点 ⇒ 沿用反向边算好的 `itemLabel`）
    if (selfNode && selfNode.id) {
      const bl = backlinksFrom(blIdx, selfProject, selfNode.id, includeSelf);
      bl.within.forEach((x) => push({
        project: selfProject, node: x.node, topic: x.topic, caption: x.caption,
        dir: 'in', item: x.item, itemLabel: x.itemLabel
      }));
      bl.cross.forEach((x) => push({
        project: x.project, node: x.node, topic: x.topic, caption: x.caption,
        dir: 'in', item: x.item, itemLabel: x.itemLabel
      }));
    }
    return items;
  }

  /**
   * 一次构建全部索引（供"对许多节点反复求邻域"的调用方复用，避免 O(N²)）。
   *
   * ⚠️ **仍然只返回三个索引**（`tIdx` / `blIdx` / `nIdx`）—— 条目层的 `itemIdx` **故意不加进来**：
   * 它是"把 `item` 翻成可读标注"才需要的**可选**索引，而 `buildIndexes` 的键集合被既有断言钉住
   * （`tests/relations.test.js`）。加键会让一个纯增量的升层变成"改既有读口形状"，
   * 于是改为：`relatedAll` 只在**真的遇到带 item 的边**时按需自建一次（见 itemIdxOf）。
   * 调用方若要自己复用，可显式传 `{indexes:{…, itemIdx: itemIndex(projects)}}`。
   */
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
   *   item: **只看挂在指定条目上的出边**（`links[].item === item`），入边不带这个过滤。
   *            不给 = 全部出边（**与从前逐字节相同**）。用途：从"某一条条目"出发看它引了谁；
   *            节点级的读口（不给 item）必须照旧看得见**全部**边，包括条目级的那些。
   * }
   * @returns { items, outCount, inCount, depth1Count, depth2Count, byDepth, truncated }
   *   items 每项 {project, node, topic, caption, dir, depth, via, item?, itemLabel?}
   *     - depth=1：dir 为 out / in / both（**相对传入的 selfNode**），via=null
   *     - depth>=2：dir 为该邻居与**上一跳节点**的方向，via={project,node,topic} 指明经由谁到达
   *       （深度 ≥2 的方向不是相对 self 的，故必须用 via 才能正确解读）
   *     - 每个节点**只以最短跳数入表一次**（`项目|节点` 去重）⇒ 深度=最短距离
   *     - `item` / `itemLabel` **只在该行真的带条目层时出现**（v2 数据不产生这两个键）；
   *       `itemLabel` 是 `item` 的可读标注（标签或正文摘录，见 itemLabel()）
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
    // itemIdx 只在**真的用到**（要翻 itemLabel）时才建 —— 免得"没人看条目层"的调用也付一次全项目遍历
    let itemIdx = idx.itemIdx || null;
    const itemIdxOf = () => { if (!itemIdx) itemIdx = itemIndex(projects); return itemIdx; };
    const wantItem = itemKey(o.item);
    // 出边过滤：只保留挂在指定条目上的那些边。**必须造新对象**（不许就地改调用方的节点）
    const baseNode = (selfNode && (wantItem || selfNode.links))
      ? Object.assign({}, selfNode, {
        links: wantItem
          ? ((selfNode.links) || []).filter((l) => l && itemKey(l.item) === wantItem)
          : selfNode.links
      })
      : selfNode;
    const selfId = selfNode && selfNode.id ? selfNode.id : null;

    const items = [];
    const seen = Object.create(null);   // null 原型：键含 `__proto__` 时也能正确去重
    const add = (project, node, topic, caption, dir, d, via, item) => {
      const k = project + '|' + node;
      if (seen[k]) return false;
      seen[k] = true;
      const rec = { project, node, topic: topic || node, caption: caption || '', dir, depth: d, via: via || null };
      withItem(rec, item);
      items.push(rec);
      return true;
    };

    // 一跳的 `itemLabel` 由 neighborhood1 自己算（它知道每条边是出边还是入边、条目属于哪一端）；
    // 这里传入 itemIdxOf 让它按需建索引。第 1 跳**不许**重算一遍（会盖掉正确的坐标归属）。
    const base = withBacklinks
      ? neighborhood1(selfProject, baseNode, tIdx, blIdx, o.includeSelf, itemIdx, itemIdxOf)
      : neighborhood1(selfProject,
        { id: null, links: baseNode && baseNode.links }, tIdx, blIdx, false, itemIdx, itemIdxOf);
    const d1 = base.slice();
    // 上限对**第 1 跳同样生效**：一个高度数节点（实测星形 519 条出边）一跳就能超限，
    // 只在"第 2 跳以后"设卡会让 depth=1 照样把整颗星吐出来（"上限"就形同虚设）。
    let truncated = false;
    d1.forEach((it) => {
      if (items.length >= maxItems) { truncated = true; return; }
      // 一跳的 itemLabel **已经算好且项目归属正确**（neighborhood1 区分了出边/入边），
      // 故这里不去重算一遍 —— 重算会用"邻居所在项目"覆盖掉"来源所在项目"，把标注搞错。
      const added = add(it.project, it.node, it.topic, it.caption, it.dir, 1, null, it.item);
      if (added && it.itemLabel) items[items.length - 1].itemLabel = it.itemLabel;
    });

    const depth1Count = items.length;
    const byDepth = { 1: depth1Count };

    // —— 第 2..depth 跳：**逐层 BFS**（depth=2 时与历史实现逐字等价）——
    if (depth > 1) {
      const nIdx = idx.nIdx || nodeIndex(projects);
      const selfKey = selfProject + '|' + selfId;
      let frontier = d1.map((x) => ({ project: x.project, node: x.node, topic: x.topic, item: x.item }));
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
          // 第 ≥2 跳：`via.item` 记的是**上一跳节点**把它引出来的那条条目（可读标注按
          // "上一跳节点所在的 b.project"归属，与一串边里的实际出处一致）
          neighborhood1(b.project, bNode, tIdx, blIdx, true, null, itemIdxOf).forEach((it) => {
            if (it.project + '|' + it.node === selfKey) return;   // 不绕回自身
            if (items.length >= maxItems) { truncated = true; return; }
            const okAdd = add(it.project, it.node, it.topic, it.caption, it.dir, d,
              withItem({ project: b.project, node: b.node, topic: b.topic }, b.item), it.item);
            if (okAdd) {
              // 这一跳的条目层标注由 neighborhood1 按"到了哪个节点"算好了，直接沿用
              if (it.itemLabel) items[items.length - 1].itemLabel = it.itemLabel;
              next.push({ project: it.project, node: it.node, topic: it.topic, item: it.item });
            }
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

  return {
    flatten, topicIndex, nodeIndex, itemIndex, backlinkIndex, backlinksFrom, backlinksAll,
    relatedAll, buildIndexes, normDepth, MAX_ITEMS, MAX_DEPTH, neighborhood1,
    // 条目层（v3）升层的判据与工具：`refState` / `targetHasItem` 是"链接目标还在不在"的**唯一实现**
    refState, allRefs, targetHasItem, itemKey, sameRef, withItem, itemLabel, plainText, EXCERPT_MAX,
    // 锚点（R7）：`anchorState` 是"这条笔记锚点还有没有效"的**唯一实现**（内部先调 refState，
    // 只对新维度补两个词：`no-tag` / `bad-anchor`；`refState` 的六词表一个字没动）
    anchorState
  };
});
