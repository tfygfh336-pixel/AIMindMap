/* ============================================================
 * cli/commands/item.js — 条目级写原语（S2）
 * ------------------------------------------------------------
 *   item-add / item-edit / item-remove / item-move / item-order / render-detail
 *
 * 目标（S2 的一句话）：让 AI 能"改一条"而不用重写整块 detail。
 *
 * ## 契约
 * 全部按 `docs/ITEM-MODEL.md` §3（写命令签名表）**逐字**实现：
 *   · 参数名、回显文案、`--json` 字段、必错情形与"指路"文案都在那一节里冻结；
 *   · 语义/回显/判据以该文为准（用法串以 `docs/CLI.md` 为准）。
 * 本文件**不重新设计**任何一条语义。
 *
 * ## 依赖（S1 的文件，本流不改）
 * 四个纯函数来自 `src/item-model.js`（`docs/ITEM-MODEL.md` §5.1 的冻结签名）：
 *   parseDetail(html, opts?) -> items / renderDetail(items) -> html
 *   validateItems(items) -> errors（字符串数组） / newItemId() -> string
 * 它由 S1 实现，**可能此刻还不存在**（并行开发）。故：
 *   1) 本文件**不在加载时 require 它**，而是第一次用到时才取（`model()`）；
 *   2) 取不到时**响亮报错并说明它归谁**，绝不自己实现一份（那是 S1 的文件，
 *      两份实现必然漂移 —— 本工程最重的损害类别之一）；
 *   3) 唯一实现 = `require('../../src/item-model.js')`；`setItemModel()` 是**测试注入缝**
 *      （见 tests/item-commands.test.js 的文件头：S1 未落地时用它注入一份**契约等价**的
 *      参照实现，好让本流自己的语义断言现在就能跑出真值；真模块一落地，测试自动切回真模块）。
 *
 * ## 三条实现纪律（本文件每处都照它写）
 *   1) **所有写命令走 `ctx.mutate`**；改动函数**纯** —— 不做 I/O、不读时钟、不打印
 *      （`ctx.mutate` 在并发冲突时会**再调用它一次**：打印会重复、副作用会做两遍）。
 *      时间戳 / 写入者 / 新条目 id 一律在**进 mutate 之前**算好（或由纯数据导出）。
 *   2) **每改完一个节点的 items，立刻重渲染它的 detail** —— detail 是派生缓存，
 *      由门禁保证 `detail === renderDetail(items)`（ITEM-MODEL §2）。半路返回 = 数据非法。
 *   3) **回显点名 itemId**；拒绝要**点名对象**（哪个条目、属于哪个节点）并给出**出路**。
 *
 * ## 与 `edit --detail` 的关系（S2 只关两扇门）
 * 条目化节点只关掉 `edit` 的 `--detail` / `--detail-md` **两扇门**；
 * `--topic` / `--tags` / `--expanded` / `--local-path` 照常可用（ITEM-MODEL §12）。
 * 那两扇门的拒绝**落在 `cli/commands/edit.js`**（S7 的所有权，不在本文件）⇒
 * 本流把它作为"要 I 协调的改动"写进交付，不自己动手（越界 = 交付拒收）。
 * ============================================================ */
'use strict';

const convert = require('../../src/convert.js');
const links = require('../../src/links.js');
const assoc = require('../../src/assoc.js');
const concurrency = require('../../src/concurrency.js');
const { SKIP_WRITE } = require('../core.js');

/* ============================================================================
 * 一、`src/item-model.js` 的取用（S1 的文件）
 * ========================================================================== */

/** 注入的替身（只有测试会用；`null` = 用真模块） */
let injectedModel = null;

function model() {
  const m = injectedModel || require('../../src/item-model.js');
  ['parseDetail', 'renderDetail', 'validateItems', 'newItemId'].forEach((k) => {
    if (typeof m[k] !== 'function') {
      throw new Error('src/item-model.js 缺少契约函数 ' + k
        + '（docs/ITEM-MODEL.md §5.1 的冻结签名；该文件由 S1 拥有并交付）');
    }
  });
  return m;
}

/** 测试注入缝（生产代码不要用；见文件头"依赖"第 3 条） */
function setItemModel(m) { injectedModel = m || null; }

/* ============================================================================
 * 二、小工具（全部纯函数）
 * ========================================================================== */

/** 时间戳：**在进 mutate 之前**算好（`fn` 里不许读时钟 —— 并发重放会读到另一个时刻） */
function nowIso() { return new Date().toISOString(); }

/** 逗号分隔的多值参数 → 数组（中文逗号也认，与本工程既有的 `--tags` 写法一致） */
function splitList(v) {
  return String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

/** 多值选项：含逗号就当列表，否则当单个字符串（`src` 允许 string 或 string[]，ITEM-MODEL §1） */
function listOrString(v) {
  return String(v).indexOf(',') >= 0 ? splitList(v) : String(v);
}

/** 条目的 type 取值表（封闭）。`qa` 不在写命令的面上：它由 `ask-apply` 产出（ITEM-MODEL §7）。 */
function typeFromArgs(ctx, key) {
  const raw = ctx.args[key];
  if (raw === undefined) return undefined;
  const t = String(raw).trim();
  if (t === 'qa') {
    ctx.error('--type qa 不能在这里写：`qa` 条目由 `ask-apply` 产出（正文由 src/qa.js 渲染）—— '
      + '请用 `ask-apply <项目> <节点id> --answer "…"`，别用 item-* 手写问答条目。');
  }
  if (t !== 'text' && t !== 'rich') {
    ctx.error('--type 只能是 text 或 rich（收到 ' + JSON.stringify(ctx.args[key]) + '）');
  }
  return t;
}

/**
 * 取本次要写入的**条目正文**（HTML）。与 `edit` 的 `--detail`/`--detail-md` 同一规矩：
 * 两个选项互斥、显式声明"我给的是哪一种"。
 *
 * ⚠️ `--md` 走 `markdownToHtml`，会把**裸 HTML 标签转义**（docs/DATA-FORMAT.md §2.4）；
 * 而 `type:'rich'` 的条目里**就是**表格/代码块 ⇒ 把迁移产物写回去只能用 `--html`。
 * 两个选项都留（ITEM-MODEL §3 表格底下那一段冻结了这一点）。
 * @returns {{given:boolean, html?:string}}
 */
function bodyFromArgs(ctx) {
  const md = ctx.args.md;
  const html = ctx.args.html;
  if (md !== undefined && html !== undefined) {
    ctx.error('--md 与 --html 不能同时给（前者按 Markdown 转 HTML，后者按 HTML 原样存）');
  }
  if (md !== undefined) {
    if (md === true || typeof md !== 'string' || !md.trim()) ctx.error('--md 内容为空');
    return { given: true, html: convert.markdownToHtml(md) };
  }
  if (html !== undefined) {
    if (html === true || typeof html !== 'string' || !html.trim()) ctx.error('--html 内容为空');
    return { given: true, html: html };
  }
  return { given: false };
}

/** 节点的 `detail` 与"空"等价（契约：缺 `detail` 与空串等价，ITEM-MODEL §2） */
function detailOf(node) {
  return (node && typeof node.detail === 'string') ? node.detail : '';
}

/** 这个节点条目化了吗（**含空数组**都算：ITEM-MODEL §2 的判定规则） */
function isItemized(node) { return Array.isArray(node && node.items); }

/** 节点可读名（报错里宁可给标题，不只给 id） */
function label(node) {
  const topic = node && node.topic ? String(node.topic) : '';
  return topic ? (node.id + '（' + topic + '）') : String(node && node.id);
}

/** 全项目条目 id → 所在节点（`supersededBy` / `links[].item` 只带条目 id、不带节点 id ⇒
 *  只有全项目唯一，引用才无歧义：ITEM-MODEL §5.1。这里用它做**查重**与**指名**。） */
function itemIndex(data) {
  const map = new Map();
  (function walk(n) {
    if (!n) return;
    (n.children || []).forEach(walk);
    (Array.isArray(n.items) ? n.items : []).forEach((it) => {
      if (it && it.id && !map.has(it.id)) map.set(it.id, n);
    });
  })(data.data);
  return map;
}

/**
 * 找一个**全项目唯一**的新条目 id。
 * 契约要求：`newItemId()` 只产候选，唯一性由调用方在全项目集合里查重，**不许靠概率**。
 */
function mintItemId(data) {
  const used = itemIndex(data);
  const M = model();
  for (let i = 0; i < 1000; i++) {
    const id = M.newItemId();
    if (typeof id === 'string' && id && !used.has(id)) return id;
  }
  throw new Error('生成条目 id 连续 1000 次都撞号 —— 请检查 src/item-model.js 的 newItemId()'
    + '（它应当含时间戳 + 随机后缀）');
}

/** 校验**单个节点**的 items（契约 §5.1：返回字符串数组，空数组 = 合法） */
function assertItemsOk(ctx, node) {
  const errors = model().validateItems(node.items) || [];
  if (errors.length) {
    ctx.error('节点 ' + label(node) + ' 的条目集不合法（写盘前被拦下，盘上零改动）：\n  · '
      + errors.join('\n  · '));
  }
}

/**
 * **重渲染**：items 改完之后，把派生缓存 `detail` 重新算出来（ITEM-MODEL §2）。
 *
 * 为什么必须就地做（而不是"写完之后再跑 render-detail"）：有 `items` ⇒
 * `detail === renderDetail(items)` 是**门禁保证的不变量**，半途返回 = 立刻写出一份
 * G2 判红的数据。空串不留键：契约里"缺 detail"与"空串"等价（否则删空条目的节点过不了闸门）。
 */
function rerender(node) {
  const expect = model().renderDetail(node.items);
  const want = (typeof expect === 'string') ? expect : '';
  if (want === '') delete node.detail; else node.detail = want;
}

/** 定位条目；找不到就**指名它实际属于哪个节点**（契约 §3.2 的 item-edit 一行） */
function findItem(ctx, data, node, itemId) {
  const list = Array.isArray(node.items) ? node.items : [];
  const i = list.findIndex((x) => x && x.id === itemId);
  if (i >= 0) return { index: i, item: list[i] };
  const owner = itemIndex(data).get(itemId);
  if (owner) {
    ctx.error('条目 ' + itemId + ' 不在节点 ' + label(node) + ' 上 —— 它在节点 ' + label(owner)
      + '。请把节点 id 改成 ' + owner.id + '（或先 `item-move` 把它移过来）。');
  }
  ctx.error('条目不存在: ' + itemId + '（节点 ' + label(node) + ' 现有 ' + list.length + ' 条'
    + (list.length ? '：' + list.map((x) => x.id).join(', ') : '') + '）');
}

/** 对象按"键排序后的 JSON"做逐值比较（纯函数；键序不参与判定 —— 它只影响可读性） */
function stableJson(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o === undefined ? null : o);
  if (Array.isArray(o)) return '[' + o.map(stableJson).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
}

/** 条目**按 id** 找（不看数组顺序 —— 与并发指纹 `item:<节点>#<条目>` 同口径） */
function itemById(node, id) {
  return (Array.isArray(node.items) ? node.items : []).find((x) => x && x.id === id) || null;
}

/* ============================================================================
 * 三、语义去重（复用 S7 的机制，不另造一套）
 * ==========================================================================
 * S7 在 `cli/commands/edit.js` 给 `add` 定了判据：**父 + 标题 + 内容指纹** ⇒ 命中默认拒绝并
 * **指名那一条**，`--force` 放行。这里的对应物是"同节点 + 同 type + 同正文指纹"。
 *
 * 为什么用**内容指纹**而不是"渲染后 HTML 逐字节相等"：契约给 `renderDetail` 定的硬约束是
 * `renderDetail(parseDetail(detail)) === detail`（回放逐字节），据此"渲染再切一遍"必然还原成
 * 同一段 HTML ⇒ 两种判据在契约下**等价**；而指纹比对还顺带忽略 `at`/`by` 这类**旁路字段**
 * （同一条知识在不同时刻重写，仍是同一条知识）。
 * 指纹算法复用 `src/concurrency.js` 的 `hash`（与 data-store 的版本指纹同源，别另写一份）。
 * ========================================================================== */

/** 正文的内容指纹（与 S7 的 `contentFingerprint` 同一算法、同一来源） */
function contentFingerprint(html) {
  return (html === undefined || html === null || html === '') ? '' : concurrency.hash(String(html));
}

/** 同节点里"同 type + 同正文"的那一条（语义重复） */
function findDuplicateItem(node, type, html) {
  const want = contentFingerprint(html);
  return (Array.isArray(node.items) ? node.items : [])
    .find((x) => x && x.type === type && contentFingerprint(x.html) === want) || null;
}

/** 「已有一条相同的」拒绝文案：**点名那条** + 两条出路（与 S7 的 dupRefusal 同口径） */
function dupRefusal(node, dup) {
  return '节点 ' + label(node) + ' 上已有一条同类型同正文的条目：' + dup.id + '。\n'
    + '这是一次**重复新增**（重试 / 重跑最常见的形态）—— 默认拒绝，以免同一件事进两遍。\n'
    + '两条出路：\n'
    + '  · 想**加第二份**：加 --force（那是有意的重复，不是手滑）；\n'
    + '  · 想**改那一条**：用 item-edit ' + node.id + ' ' + dup.id + ' …，别再加一条。';
}

/* ============================================================================
 * 四、条目化前置校验（本流被 F0 点名的那个点）
 * ==========================================================================
 * `item-add` 既要能落在**已条目化**的节点上，也要能让**未条目化**的节点**自动条目化**
 * （ITEM-MODEL §11 第 8 条：F0 新增的冻结项）。自动条目化必须守住那条**逐字节回放前置校验**：
 *
 *   1) 节点**没有** `items` 也没有 `detailMode` ⇒ 它的 `detail` 是**真源**（v2 节点）。
 *      要把真源换成 items，唯一安全的做法是"能把这段 detail 逐字节回放出来"：
 *         renderDetail(parseDetail(detail)) === detail
 *      成立 ⇒ 换一种真源表达**同一份**内容（可逆），安全；
 *      不成立 ⇒ **拒绝**（绝不"先解析、再按 items 重渲染"地写回去 ——
 *      那会让 detail 悄悄变样，正是契约 §6 里迁移那条"不许修一下再写"的同一类损害）。
 *   2) 节点有 `detailMode:'rich'` ⇒ 它是**富文本节点**、与 items **互斥**（ITEM-MODEL §2）。
 *      不替它自动条目化（那要删掉一个**显式写下的标记** ⇒ 属于 `edit` 的语义）⇒ 拒绝并指路。
 * ========================================================================== */

/**
 * 把节点条目化（节点原本没有 `items` 时），并返回"这次是不是新建了条目层"。
 *
 * ## 为什么要先**逐字节回放前置校验**
 * 节点没有 `items` 也没有 `detailMode` ⇒ 它的 `detail` 是**真源**（v2 节点）。要把真源换成 items，
 * 唯一安全的做法是"能把这段 detail **逐字节回放**出来"：
 *
 *     renderDetail(parseDetail(detail)) === detail
 *
 * 成立 ⇒ 换一种真源表达**同一份**内容（可逆），安全；不成立 ⇒ **拒绝**
 * （绝不"先解析、再按 items 重渲染"地写回去 —— 那会让 detail 悄悄变样，
 * 正是契约 §6 里迁移那条"不许修一下再写"的同一类损害）。
 *
 * ⚠️ **解析只做一次**（解析产物直接用来建条目层）：`parseDetail(detail, {at})` 会给每条写上
 * `at`/`by`，解析两次会得到两份不同的产物 ⇒ 拿 A 份去回放校验、再把 B 份写进项目，
 * 就是在校验一份、写另一份（本工程最忌的那种"证明的是这个、落盘的是那个"）。
 * 校验与写入共用同一份产物 ⇒ 两者不可能不一致。
 *
 * ## 另一扇门：富文本节点
 * 节点有 `detailMode:'rich'` ⇒ 它与条目层**互斥**（ITEM-MODEL §2）。不替它自动条目化
 * （那要删掉一个**显式写下的标记** ⇒ 属于 `edit` 的语义）⇒ 拒绝并指路。
 *
 * @returns {boolean} `true` = 本次是"自动条目化"（节点原本没有 items）
 */
function itemizeNode(ctx, node, at, by) {
  if (isItemized(node)) return false;
  if (node.detailMode !== undefined) {
    if (node.detailMode === 'rich') {
      ctx.error('节点 ' + label(node) + ' 是**富文本节点**（detailMode:\'rich\'）—— 它与条目层互斥，'
        + '不能直接加条目。两条出路：\n'
        + '  · 真要按条目标：先 `edit <项目> ' + node.id + ' --clear-detail-mode`（确认这块富文本可拆），再 item-add；\n'
        + '  · 只是补富文本：`edit <项目> ' + node.id + ' --detail …`（富文本节点上它照常可用）。');
    }
    ctx.error('节点 ' + label(node) + ' 的 detailMode 取值非法：' + JSON.stringify(node.detailMode)
      + '（唯一合法取值是 \'rich\'，见 docs/ITEM-MODEL.md §2）');
  }
  const detail = detailOf(node);
  if (detail === '') { node.items = []; return true; }     // 空 detail：没有内容要回放
  let parsed = null;                                       // 解析产物**只有这一份**
  try { parsed = model().parseDetail(detail, { at: at, by: by }); }
  catch (e) {
    ctx.error('节点 ' + label(node) + ' 自动条目化失败：它的 detail 解析时出错（'
      + ((e && e.message) || e) + '）。该节点请交给 `migrate items` 处理（它会逐条报告跳过项）。');
  }
  let replay = null;
  try { replay = model().renderDetail(parsed); }
  catch (e) {
    ctx.error('节点 ' + label(node) + ' 自动条目化失败：解析产物回放时出错（'
      + ((e && e.message) || e) + '）。该节点请交给 `migrate items` 处理（它会逐条报告跳过项）。');
  }
  if (replay !== detail) {
    ctx.error('节点 ' + label(node) + ' 的 detail **无法逐字节回放**，拒绝自动条目化'
      + '（否则 detail 会在"解析 → 重渲染"中被悄悄改写，那是本工程最重的损害类别）。\n'
      + '三条出路：\n'
      + '  · 走 `migrate items <项目>`：它会把这个节点逐条写进 skipped 报告，**一个字节都不动**；\n'
      + '  · 显式声明它是富文本：`edit <项目> ' + node.id + ' --detail-mode rich`；\n'
      + '  · 或换一个**空 detail** 的节点开始条目层（空节点没有旧内容要回放）。');
  }
  node.items = parsed;
  assertItemsOk(ctx, node);
  return true;
}

/* ============================================================================
 * 五、位置参数（`--after` / `--before`）
 * ========================================================================== */

/**
 * 把条目插到锚点之前 / 之后；没给锚点就追加到末尾。
 * 锚点必须**在本节点的 items 里**（契约 §3.2 的 item-add 一行："`--after/--before` 的条目不在该节点"）。
 */
function insertAt(ctx, list, item, node, what) {
  const before = ctx.args.before;
  const after = ctx.args.after;
  if (before !== undefined && after !== undefined) {
    ctx.error('--before 与 --after 不能同时给（二选一）');
  }
  const flag = before !== undefined ? '--before' : '--after';
  const anchor = before !== undefined ? before : after;
  if (anchor === undefined) { list.push(item); return; }
  if (anchor === true) ctx.error(flag + ' 需要一个条目 id（不能裸写）');
  const i = list.findIndex((x) => x && x.id === anchor);
  if (i < 0) {
    ctx.error(flag + ' 的条目 ' + anchor + ' 不在节点 ' + label(node) + ' 上'
      + '（' + what + '只在**同一个节点内**定位）。该节点现有条目：'
      + (list.length ? list.map((x) => x.id).join(', ') : '（空）'));
  }
  list.splice(before !== undefined ? i : i + 1, 0, item);
}

/* ============================================================================
 * 六、六条命令
 * ========================================================================== */

/** 统一回显：`--json` 给对象（**一份可解析 JSON**），否则给文本（ITEM-MODEL §3 通用约定）。
 *  同时用 `setIdemResult` 声明"这次执行的回显" ⇒ `--idem` 重放时原样复述。 */
function emit(ctx, obj, text) {
  if (ctx.args.json) { ctx.outJson(obj); ctx.setIdemResult(obj); return; }
  ctx.out(text);
  ctx.setIdemResult(text);
}

module.exports = {
  /* ------------------------------------------------------------------ item-add */
  itemAdd(ctx) {
    const nodeId = ctx.args._[1];
    if (!nodeId) {
      ctx.error('用法: item-add <项目> <节点id> --md "Markdown" | --html "HTML" '
        + '[--src …] [--tags a,b] [--type text|rich] [--after <itemId>|--before <itemId>]');
    }
    const body = bodyFromArgs(ctx);
    if (!body.given) {
      ctx.error('缺少正文：--md <Markdown> 或 --html <HTML>（互斥、必给其一）。'
        + '--md 会把裸 HTML 标签转义，要写表格 / 代码块这类富内容请用 --html。');
    }
    const type = typeFromArgs(ctx, 'type') || 'text';
    const src = ctx.args.src === undefined ? undefined : listOrString(ctx.args.src);
    const tags = ctx.args.tags === undefined ? undefined : splitList(ctx.args.tags);
    const force = !!ctx.args.force;
    const noDedup = !!ctx.args.noDedup;          // 注入开关（见文件末尾那段注释）
    const at = nowIso();                         // ⚠️ 进 mutate 之前算好（fn 里不许读时钟）
    const by = ctx.writer;                       // `<外壳>:<命令>`，与 .changes.jsonl 的 writer 同源
    const pr = { itemId: null, count: 0, dup: null, itemized: false, forceSkipped: null };

    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, nodeId);
      if (!node) ctx.error('节点不存在: ' + nodeId);
      const freshItems = itemizeNode(ctx, node, at, by);   // 必要时自动条目化（含逐字节回放前置校验）
      const list = node.items;
      const dup = findDuplicateItem(node, type, body.html);
      if (dup && !force && !noDedup) { pr.dup = { id: dup.id, type: dup.type }; return SKIP_WRITE; }
      if (dup && force) pr.forceSkipped = dup.id;       // --force：有意的重复，回显里说出来
      const item = { id: mintItemId(data), type: type, html: body.html };
      if (src !== undefined) item.src = src;
      if (tags !== undefined && tags.length) item.tags = tags;
      item.at = at;
      item.by = by;
      insertAt(ctx, list, item, node, '新条目');
      assertItemsOk(ctx, node);
      rerender(node);                          // items 改完立刻重渲染 detail（派生缓存）
      pr.itemId = item.id; pr.count = list.length; pr.itemized = freshItems;
      return data;
    });

    if (pr.dup) ctx.error(dupRefusal(ctx.find(nodeId), pr.dup));   // 默认拒绝 —— 但**指名**是那一条
    const extra = pr.forceSkipped ? '（已存在同正文条目 ' + pr.forceSkipped + '，本次是 --force 下的**有意重复**）' : '';
    emit(ctx, { ok: true, project: ctx.projectName, nodeId: nodeId, itemId: pr.itemId, items: pr.count },
      '已添加条目 ' + pr.itemId + '（节点 ' + nodeId + '，共 ' + pr.count + ' 条）' + extra);
  },

  /* ----------------------------------------------------------------- item-edit */
  itemEdit(ctx) {
    const nodeId = ctx.args._[1];
    const itemId = ctx.args._[2];
    if (!nodeId || !itemId) {
      ctx.error('用法: item-edit <项目> <节点id> <itemId> [--md …|--html …] [--src …|--clear-src] '
        + '[--tags a,b|--clear-tags] [--type text|rich] [--verified --how "…"|--clear-verified]');
    }
    const body = bodyFromArgs(ctx);
    const type = typeFromArgs(ctx, 'type');
    // ---- 参数形状校验（一律在写盘之前）----
    if (ctx.args.src !== undefined && ctx.args.clearSrc) ctx.error('--src 与 --clear-src 不能同时给');
    if (ctx.args.tags !== undefined && ctx.args.clearTags) ctx.error('--tags 与 --clear-tags 不能同时给');
    if (ctx.args.verified && ctx.args.clearVerified) ctx.error('--verified 与 --clear-verified 不能同时给');
    const how = ctx.args.how;
    if (how !== undefined && !ctx.args.verified) {
      // 口径：**取不到 `how` 就不写 verified** —— 它是三字段全必填的记录（ITEM-MODEL §1）
      ctx.error('--how 只在 --verified 时才有意义（verified 是三字段全必填的记录：at / by / how）。'
        + '要清掉已核标记请用 --clear-verified。');
    }
    if (ctx.args.verified && (how === undefined || how === true || !String(how).trim())) {
      ctx.error('--verified 必须同时给 --how "…"：一句话说清**怎么核的**。'
        + '取不到就不写 verified，别落一条空核验记录（那会让"已核"永远为真 —— 本工程最忌的假绿）。');
    }
    const anything = body.given || type !== undefined
      || ctx.args.src !== undefined || ctx.args.clearSrc
      || ctx.args.tags !== undefined || ctx.args.clearTags
      || ctx.args.verified || ctx.args.clearVerified;
    if (!anything) {
      ctx.error('什么也没改（可用：--md / --html / --src / --clear-src / --tags / --clear-tags / '
        + '--type / --verified --how / --clear-verified）');
    }
    const at = nowIso();
    const by = ctx.writer;
    const pr = { changed: [], count: 0 };
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, nodeId);
      if (!node) ctx.error('节点不存在: ' + nodeId);
      if (!isItemized(node)) {
        ctx.error('节点 ' + label(node) + ' **还没有条目层**（没有 items）—— item-edit 改的是**已有条目**。'
          + '先用 `item-add <项目> ' + node.id + ' --html "…"`（它会自动条目化）或 `migrate items <项目>`。');
      }
      const hit = findItem(ctx, data, node, itemId);
      const it = hit.item;
      const changed = [];
      const setIf = (k, v) => { if (stableJson(it[k]) !== stableJson(v)) { it[k] = v; changed.push(k); } };
      const delIf = (k) => { if (it[k] !== undefined) { delete it[k]; changed.push('-' + k); } };
      if (body.given) setIf('html', body.html);
      if (type !== undefined) setIf('type', type);
      if (ctx.args.src !== undefined) setIf('src', listOrString(ctx.args.src));
      if (ctx.args.clearSrc) delIf('src');
      if (ctx.args.tags !== undefined) {
        const v = splitList(ctx.args.tags);
        if (v.length) setIf('tags', v); else delIf('tags');
      }
      if (ctx.args.clearTags) delIf('tags');
      if (ctx.args.clearVerified) delIf('verified');
      if (ctx.args.verified) setIf('verified', { at: at, by: by, how: String(how) });
      // `at` / `by` = "**这一次写**发生在何时、由谁"：只有真的改了东西才刷新它。
      // 于是"同一条命令重放"逐字节无事发生（可断言），而每次真实改动都留痕。
      if (changed.length) { it.at = at; it.by = by; }
      assertItemsOk(ctx, node);
      rerender(node);
      pr.changed = changed;
      pr.count = node.items.length;
      return data;
    });
    const detail = pr.changed.length ? '：' + pr.changed.join(',') : '：无实际变化';
    emit(ctx, {
      ok: true, project: ctx.projectName, nodeId: nodeId, itemId: itemId,
      changed: pr.changed, items: pr.count
    }, '已更新条目 ' + itemId + '（节点 ' + nodeId + '）' + detail);
  },

  /* --------------------------------------------------------------- item-remove */
  itemRemove(ctx) {
    const nodeId = ctx.args._[1];
    const itemId = ctx.args._[2];
    if (!nodeId || !itemId) {
      ctx.error('用法: item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc]');
    }
    const pr = { left: 0, links: null, assoc: null };
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, nodeId);
      if (!node) ctx.error('节点不存在: ' + nodeId);
      if (!isItemized(node)) {
        ctx.error('节点 ' + label(node) + ' 没有条目层（没有 items）—— 没有条目可删。'
          + '要删整块内容用 `edit <项目> ' + node.id + ' --clear-detail`。');
      }
      const hit = findItem(ctx, data, node, itemId);

      // ---- 引用检查：**默认拒绝并逐个点名**，绝不许静默删出悬挂引用（契约 §3.2）----
      // 两类引用各按自己的形状查：`links[].item`（同项目内的有向边）与
      // `assoc.members[].item`（关联笔记的成员）。
      const inbound = [];
      (function walk(n) {
        if (!n) return;
        (n.links || []).forEach((l, i) => {
          if (l && l.item === itemId) {
            inbound.push('节点 ' + label(n) + ' 的 links[' + i + '] → ' + l.project + '/' + l.id);
          }
        });
        (n.children || []).forEach(walk);
      })(data.data);
      const assocHits = [];
      (Array.isArray(data.assoc) ? data.assoc : []).forEach((a) => {
        if (!a || !Array.isArray(a.members)) return;
        a.members.forEach((m, i) => {
          if (m && m.item === itemId) assocHits.push('关联笔记「' + (a.title || a.id) + '」的 members[' + i + ']');
        });
      });

      if (inbound.length || assocHits.length) {
        const flags = [inbound.length && ctx.args.cleanLinks ? '--clean-links' : null,
          assocHits.length && ctx.args.cleanAssoc ? '--clean-assoc' : null].filter(Boolean);
        if (flags.length !== (inbound.length ? 1 : 0) + (assocHits.length ? 1 : 0)) {
          const lines = ['条目 ' + itemId + ' 正被引用，直接删除会留下**悬挂引用**（该项目此后所有写命令都会被闸门挡住）—— 默认拒绝：'];
          if (inbound.length) lines.push('  · 被 ' + inbound.length + ' 条链接引用：' + inbound.join('；'));
          if (assocHits.length) lines.push('  · 被 ' + assocHits.length + ' 处关联成员引用：' + assocHits.join('；'));
          lines.push('两条出路：');
          lines.push('  · 连引用一起清：item-remove ' + ctx.projectName + ' ' + nodeId + ' ' + itemId + ' '
            + [inbound.length ? '--clean-links' : null, assocHits.length ? '--clean-assoc' : null].filter(Boolean).join(' '));
          lines.push('  · 事后再清：`links-prune ' + ctx.projectName + '` / `assoc-prune ' + ctx.projectName
            + '`（那时引用已悬空，它们专门收拾这个）；');
          lines.push('  · 若引用者**在别的项目**里，本项目看不见它 —— 那个项目只能自己跑 `links-prune` 修好。');
          ctx.error(lines.join('\n'));
        }
      }
      if (inbound.length && ctx.args.cleanLinks) {
        const lr = links.pruneLinks(data.data, (l) => l && l.item === itemId);
        // 存 `pruneLinks` 的**原始形状**（`{node, target, caption?, item?}`，见 src/links.js L36-38）：
        // 文本形态从它格式化、JSON 形态原样给 —— 一份数据两个出口，不各写一份（否则必漂移）。
        // `item` 那一项是 S6 加的：报告必须看得见"剪掉的是**哪一层**"（同源同目标多条边时，
        // 拿标签文本反查会配错）。
        pr.links = lr.removed;
      }
      if (assocHits.length && ctx.args.cleanAssoc) {
        const ar = assoc.pruneMembers(data.assoc, (m) => m && m.item === itemId);
        if (ar.empty) delete data.assoc; else data.assoc = ar.list;
        pr.assoc = { touched: ar.touched, dropped: ar.dropped };
      }

      node.items.splice(hit.index, 1);
      assertItemsOk(ctx, node);
      rerender(node);
      pr.left = node.items.length;
      return data;
    });
    // ---- 清理结果的**两个出口**（契约 §3：`--json` 下 stdout 必须是**一份**可解析 JSON）----
    // ⚠️ 为什么**不是**"把这两行 `ctx.out` 挪到 `emit()` 之后"（那是当初最省事的想法）：
    //    `ctx.out` 在 `--json` 下**照常写 stdout**（`cli/core.js` 的 `out` 不看 `args.json`，
    //    见那边 L459）⇒ 挪位置只是把"半截文本 + JSON"变成"JSON + 半截文本"，消费者**照样**
    //    解析失败（实测：S4 因此在 MCP 的 `item_remove` 上不敢传 `--json`）。
    //    本工程已有的口径在 render-detail 那一档（`tests/item-commands.test.js` §I）：
    //    **文本形态说人话、JSON 形态给字段**（"无需重建"只出现在文本里，JSON 下由 `changed:0`
    //    表达）。这里照同一条规矩办：文本照旧**分行**打印（行数与措辞一个字不变）；JSON 把
    //    **同一份结果**放进 `cleaned` —— 信息一条不少，只是换了容器（机器消费者要的正是
    //    "清理了哪几条"，那本来就是这条命令最该给出的事实）。
    const cleaned = {};
    if (pr.links && pr.links.length) cleaned.links = pr.links;
    if (pr.assoc) cleaned.assoc = pr.assoc;
    if (!ctx.args.json) {
      if (pr.links && pr.links.length) {
        ctx.out('已同步清理链接：' + pr.links.map((x) => x.node + ' → ' + x.target).join('；'));
      }
      if (pr.assoc) {
        const parts = [];
        if (pr.assoc.touched.length) {
          parts.push(pr.assoc.touched.map((t) => t.id + '（- ' + t.removed + ' 成员）').join(', '));
        }
        if (pr.assoc.dropped.length) parts.push('整篇删除（成员不足）：' + pr.assoc.dropped.join(', '));
        if (parts.length) ctx.out('已同步清理关联：' + parts.join('；'));
      }
    }
    const out = { ok: true, project: ctx.projectName, nodeId: nodeId, itemId: itemId, items: pr.left };
    // `cleaned` 只在**真清理了东西**时出现（空值不产生噪音键 —— 与 `withItem` 同一条策略）：
    // 不带 `--clean-*` 的老调用方看到的 JSON 逐字节不变，"没清理"与"清理了 0 条"也分得开。
    if (cleaned.links || cleaned.assoc) out.cleaned = cleaned;
    emit(ctx, out,
      '已删除条目 ' + itemId + '（节点 ' + nodeId + '，剩 ' + pr.left + ' 条）');
  },

  /* ----------------------------------------------------------------- item-move */
  itemMove(ctx) {
    const nodeId = ctx.args._[1];
    const itemId = ctx.args._[2];
    const to = ctx.args.to;
    if (!nodeId || !itemId || to === undefined) {
      ctx.error('用法: item-move <项目> <节点id> <itemId> --to <目标节点id> [--after <itemId>|--before <itemId>]');
    }
    if (to === true) ctx.error('--to 需要一个目标节点 id（不能裸写）');
    if (String(to) === String(nodeId)) {
      ctx.error('源节点与目标节点相同（' + nodeId + '）—— 只是要调整这个节点**内部**的顺序，请用 '
        + '`item-order <项目> ' + nodeId + ' --ids …`（item-move 只管"换节点"）。');
    }
    const pr = { count: 0 };
    ctx.mutate((data) => {
      const src = ctx.tree.find(data.data, nodeId);
      if (!src) ctx.error('节点不存在: ' + nodeId);
      const dst = ctx.tree.find(data.data, String(to));
      if (!dst) ctx.error('目标节点不存在: ' + to);
      if (!isItemized(src)) {
        ctx.error('节点 ' + label(src) + ' 没有条目层（没有 items）—— 没有条目可移。'
          + '要条目化先 `migrate items <项目>` 或 `item-add`。');
      }
      if (!isItemized(dst)) {
        ctx.error('目标节点 ' + label(dst) + ' **还没有条目层**（没有 items），item-move 不负责条目化它。\n'
          + '两条出路：\n'
          + '  · 先让它条目化：`item-add <项目> ' + dst.id + ' --html "…"`（会自动条目化）或 `migrate items <项目>`；\n'
          + '  · 或者改用 `move` 整节点搬（那是节点级命令，语义不同）。');
      }
      const hit = findItem(ctx, data, src, itemId);
      // `--after / --before` 指的是**目标节点里**的条目 —— 拿源节点的条目 id 当锚点是这一条
      // 最自然的误用；不拦就会静默追加到末尾（调用方以为插到了某条旁边）。
      const anchor = ctx.args.before !== undefined ? ctx.args.before : ctx.args.after;
      if (anchor !== undefined && !itemById(dst, anchor)) {
        ctx.error('--' + (ctx.args.before !== undefined ? 'before' : 'after') + ' 的条目 ' + anchor
          + ' 不在**目标节点** ' + label(dst) + ' 上（定位锚点要在目标节点里找）。'
          + '目标节点现有条目：' + (dst.items.length ? dst.items.map((x) => x.id).join(', ') : '（空）'));
      }
      const item = src.items.splice(hit.index, 1)[0];
      insertAt(ctx, dst.items, item, dst, '条目定位');
      assertItemsOk(ctx, src);
      assertItemsOk(ctx, dst);
      rerender(src);                     // **一次原子写同时重渲染两侧 detail**（一条日志、一个 rev）
      rerender(dst);
      pr.count = dst.items.length;
      return data;
    });
    emit(ctx, {
      ok: true, project: ctx.projectName, nodeId: nodeId, itemId: itemId, to: String(to), items: pr.count
    }, '已移动条目 ' + itemId + '：' + nodeId + ' → ' + String(to));
  },

  /* ---------------------------------------------------------------- item-order */
  itemOrder(ctx) {
    const nodeId = ctx.args._[1];
    const ids = ctx.args.ids;
    if (!nodeId || ids === undefined) {
      ctx.error('用法: item-order <项目> <节点id> --ids i-a,i-b,…（必须是该节点现有条目的**完整排列**）');
    }
    if (ids === true) ctx.error('--ids 需要一个逗号分隔的条目 id 列表（不能裸写）');
    const want = splitList(ids);
    const dupes = Array.from(new Set(want.filter((x, i) => want.indexOf(x) !== i)));
    const pr = { n: 0 };
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, nodeId);
      if (!node) ctx.error('节点不存在: ' + nodeId);
      if (!isItemized(node)) {
        ctx.error('节点 ' + label(node) + ' 没有条目层（没有 items）—— 没有条目可排。');
      }
      const have = node.items.map((x) => x.id);
      // ⚠️ 这几条**必须逐项点名**：只说"不是完整排列"会让调用方无从下手（契约 §3.2）。
      const missing = have.filter((x) => want.indexOf(x) < 0);
      const extra = want.filter((x) => have.indexOf(x) < 0);
      if (missing.length || extra.length || dupes.length) {
        const lines = ['--ids 不是节点 ' + nodeId + ' 现有条目的**一个完整排列**'
          + '（item-order 只重排、不增删条目）：'];
        if (missing.length) lines.push('  · 少了：' + missing.join(', '));
        if (extra.length) lines.push('  · 多了（该节点没有这些条目）：' + extra.join(', '));
        if (dupes.length) lines.push('  · 重复了：' + dupes.join(', '));
        lines.push('该节点现有条目（顺序即当前顺序）：' + (have.length ? have.join(', ') : '（空）'));
        lines.push('要增删 / 换节点请用 item-add / item-remove / item-move —— item-order 不改变条目的集合。');
        ctx.error(lines.join('\n'));
      }
      const byId = new Map(node.items.map((x) => [x.id, x]));
      node.items = want.map((id) => byId.get(id));
      assertItemsOk(ctx, node);
      rerender(node);
      pr.n = node.items.length;
      return data;
    });
    emit(ctx, { ok: true, project: ctx.projectName, nodeId: nodeId, items: pr.n, ids: want },
      '已重排 ' + pr.n + ' 条（节点 ' + nodeId + '）');
  },

  /* ------------------------------------------------------------- render-detail */
  renderDetail(ctx) {
    const nodeId = ctx.args._[1];
    const all = !!ctx.args.all;
    if (nodeId && all) ctx.error('<节点id> 与 --all 不能同时给（二选一）');
    if (!nodeId && !all) {
      ctx.error('用法: render-detail <项目> <节点id> 或 render-detail <项目> --all'
        + '（把 detail 按 items 重新渲染 —— 修掉 G2 判的"detail 与 items 不一致"）');
    }
    const pr = { scanned: 0, rebuilt: 0, changed: 0, seen: 0 };
    ctx.mutate((data) => {
      const targets = [];
      if (all) {
        (function walk(n) {
          if (!n) return;
          targets.push(n);
          (n.children || []).forEach(walk);
        })(data.data);
      } else {
        const node = ctx.tree.find(data.data, nodeId);
        if (!node) ctx.error('节点不存在: ' + nodeId);
        targets.push(node);
      }
      pr.seen = targets.length;
      targets.forEach((n) => {
        // 只处理**条目化**节点：有 items ⇒ detail 是派生缓存（有 items 即条目化，含空数组）。
        // 没有 items 的节点是 v2 节点或富文本节点 —— 它们的 detail 是**真源**（ITEM-MODEL §2），
        // 重建它们等于把真源改写成派生值，那是本条命令绝不该做的事。
        if (!isItemized(n)) return;
        pr.scanned++;
        pr.rebuilt++;
        const expect = model().renderDetail(n.items);
        const want = (typeof expect === 'string') ? expect : '';
        if (detailOf(n) === want) return;      // 已一致 ⇒ 不动（幂等：同状态两次运行逐字节相同）
        if (want === '') delete n.detail; else n.detail = want;
        pr.changed++;
      });
      return data;
    });
    const note = pr.changed ? '' : '（已一致，无需重建）';
    let skipNote = '';
    if (pr.scanned === 0) {
      skipNote = all
        ? '\n注意：本项目当前**没有任何条目化节点**（没有 items）⇒ 没有可重建的对象（要条目化先 `migrate items <项目>`）。'
        : '\n注意：节点 ' + nodeId + ' 没有 items ⇒ 它**不是条目化节点**，detail 是**真源**，本条命令**不会**碰它'
          + '（要条目化先 `migrate items <项目>` 或 `item-add`）。';
    }
    emit(ctx,
      { ok: true, project: ctx.projectName, scanned: pr.scanned, rebuilt: pr.rebuilt, changed: pr.changed },
      '已重建 detail：扫描 ' + pr.scanned + '，重建 ' + pr.rebuilt + '，实际变化 ' + pr.changed + note + skipNote);
  }
};

/**
 * `setItemModel` —— **测试注入缝**（见文件头"依赖"第 3 条）。
 *
 * 为什么必须有它：本流依赖的 `src/item-model.js` 属 S1，**可能此刻还没落地**；
 * 而本段代码的语义（去重、自动条目化、重渲染、回放校验）必须**现在就能被真断言钉住**。
 * 没有注入缝的话，测试只有两种坏选择：要么整份跳过（= 这段代码一行都没被证明过），
 * 要么在本文件里复制一份解析/渲染（= 两份实现，必然漂移）。
 * 交付里如实登记：**S1 落地前，本文件的语义断言跑在参照实现上**（契约等价），
 * 真模块一落地，测试自动切回真模块并把同一批断言再跑一遍。
 */
Object.defineProperty(module.exports, 'setItemModel', { value: setItemModel, enumerable: true });
