/* ============================================================
 * cli/commands/edit.js — 节点编辑命令
 * ------------------------------------------------------------
 *   add / add-root / edit / move / remove / clone / expand-depth
 *   **apply** —— 一批改动在**一次事务**里做完（S7，见本文件末尾那一段）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const markdown = require('../../src/markdown.js');
const convert = require('../../src/convert.js');
const assoc = require('../../src/assoc.js');
const links = require('../../src/links.js');
const relations = require('../../src/relations.js');   // 条目级边：`itemKey` / `targetHasItem` 的唯一实现
const tree = require('../../src/tree-utils.js');
const itemIndex = require('../../src/item-index.js');   // 全项目条目 id 集合（§5.1 唯一性口径，一处实现）
const concurrency = require('../../src/concurrency.js');
const { SKIP_WRITE } = require('../core.js');

/**
 * 取本次命令要写入的 detail。
 * 存储格式是 **HTML**（渲染层以 innerHTML 注入，见 docs/DATA-FORMAT.md §2.4），
 * 但 AI 天然写 Markdown —— 故提供 `--detail-md`：显式声明"我给的是 Markdown"，
 * 由命令转换为 HTML 落盘。两个选项互斥，避免"我以为是 Markdown 其实是 HTML"的静默歧义。
 */
function detailFromArgs(ctx) {
  const html = ctx.args.detail;
  const md = ctx.args.detailMd;
  if (html !== undefined && md !== undefined) {
    ctx.error('--detail 与 --detail-md 不能同时使用（前者按 HTML 原样存，后者按 Markdown 转换）');
  }
  if (md !== undefined) {
    if (typeof md !== 'string' || !md.trim()) ctx.error('--detail-md 内容为空');
    return convert.markdownToHtml(md);
  }
  return html;
}

/**
 * 取本次命令要写入的**本机文件夹路径**（`localPath`，见 docs/DATA-FORMAT.md §2.5）。
 *
 * 它是什么：节点对应的目录在本机的绝对路径，界面上点击即用系统文件管理器打开
 * （从文件夹结构建树时，每个结构节点都挂一条，于是"导图 ↔ 真目录"随时互跳）。
 * `--local-path <绝对路径>` 设置；`--clear-local-path` 清除；两者互斥。
 *
 * 为什么必须**绝对**：相对路径会随"当前工作目录"漂移，而点击打开的是操作系统，
 * 它没有"项目根"这个概念 —— 放行相对路径只会得到一个看似合法、点了打不开的值。
 * 为什么**不校验存在**：目标盘可能没挂载、目录可能还没建；存在性在**点击时**判（主进程 shell.openPath
 * 会返回明确错误），而数据校验只管形状（否则换台机器连 validate 都红）。
 */
function localPathFromArgs(ctx) {
  const p = ctx.args.localPath;
  const clear = ctx.args.clearLocalPath;
  if (p !== undefined && clear) ctx.error('--local-path 与 --clear-local-path 不能同时使用');
  if (clear) return { set: true, value: undefined };
  if (p === undefined) return { set: false };
  const s = String(p).trim();
  if (!s) ctx.error('--local-path 内容为空（要清除请用 --clear-local-path）');
  if (!/^[A-Za-z]:[\\/]/.test(s) && !/^\\\\/.test(s)) {
    ctx.error('--local-path 必须是**绝对路径**（如 E:\\markdown\\M1 或 \\\\服务器\\共享\\目录）：' + s);
  }
  return { set: true, value: s };
}

/**
 * 取 `--expanded` 的布尔值（`add` / `add-root` / `edit` 共用）。
 *
 * 只认 `true` / `false`（裸写 `--expanded` 等价于 true，保留历史写法）；**别的值一律报错**。
 *
 * 为什么不能沿用"非 false 即 true"（实测缺陷，2026-10-10）：`--expanded=nonsense` 以前
 * 连键都解析不出来，于是**静默落成默认值 true** —— 调用方以为"我关掉了展开"，
 * 盘上写的却是展开（反之亦然）。这类"看起来生效、其实没生效"的设置比直接报错危险得多，
 * 因为它会一路带到下一轮调试里。判定收窄到 true/false 两个字面量后，写错就当场红。
 */
function expandedFromArgs(ctx) {
  const v = ctx.args.expanded;
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  ctx.error('--expanded 只能是 true 或 false（收到 ' + JSON.stringify(v) + '）');
}

/* ============================================================
 * 「同父同题」语义去重（S7）—— **重试安全**的第一道闸（第二道是 `--idem`）
 * ------------------------------------------------------------
 * ## 要修的问题（已实测）
 * `add` 的 id 由 `src/markdown.js` 的 `idGen` 生成（**含时间 + 随机**）⇒ 同一条命令重跑一次，
 * 得到的是**另一个 id 的另一个节点**：`add x root --topic 甲` 跑两遍就是两个「甲」，
 * 而调用方看到的是两次"已添加"（退出码 0）。AI 重试 / 脚本重跑 / 手工再敲一遍都会撞上它。
 *
 * ## 判据（三个都要相同才算"同一件事"）
 *   父节点 id ＋ 标题（去首尾空白后逐字）＋ 内容指纹（detail 的 sha1 前 16 位；没有 detail = 空）
 * 为什么标题要**逐字**（不做大小写折叠、不做空格折叠）：折叠会引入"什么算一样"的第二套口径，
 * 而本判据的用途是"这次是不是上一次的重放" —— 那要求**宁窄勿宽**：
 * 漏判（放行一次真的重复）比误判（拒绝一次真的新增）轻得多，后者会把正常的新增堵死。
 * 为什么内容也算：同父下"同标题不同正文"是**正常的**（同名条目在不同来源里内容不同），
 * 只看标题会把它误判成重复。
 *
 * ## 命中之后
 * **默认拒绝**并**指名那条**（id + 完整路径），而不是静默跳过 —— 静默跳过会让调用方
 * 以为"我新加的那个节点在哪"，而实际上它根本没被创建。`--force` 是"我真的要第二份"的显式出口。
 * ============================================================ */

/** 标题归一：只去首尾空白（理由见上：不做折叠，避免引入第二套"什么算一样"的口径） */
function normTopic(v) { return String(v === undefined || v === null ? '' : v).trim(); }

/** 内容指纹：与 data-store 的版本指纹同源（`concurrency.hash` 是同一算法的唯一实现） */
function contentFingerprint(v) {
  return (v === undefined || v === null || v === '') ? '' : concurrency.hash(String(v));
}

/**
 * 在 `parentNode.children` 里找**语义重复**的那个孩子。
 * @returns {{id:string, topic:string, path:string}|null}
 */
function findDuplicateChild(ctx, data, parentNode, topic, detail) {
  const wantTopic = normTopic(topic);
  const wantFp = contentFingerprint(detail);
  const kids = parentNode.children || [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k) continue;
    if (normTopic(k.topic) !== wantTopic) continue;
    if (contentFingerprint(k.detail) !== wantFp) continue;
    return { id: k.id, topic: k.topic, path: safePath(ctx, data, k.id) };
  }
  return null;
}

/** 节点路径（`root / 甲 / 乙`）；取不到就回落成 id —— 报错里**必须**能定位到那一条 */
function safePath(ctx, data, id) {
  try {
    const p = ctx.tree.pathTo(data.data, id);
    if (Array.isArray(p) && p.length) {
      return p.map((n) => (n && n.topic) || (n && n.id)).join(' / ');
    }
  } catch (e) { /* 纯展示信息，取不到就算了 */ }
  return id;
}

/** 「已有一条相同的」拒绝文案（**点名那条**：id + 路径 + 两条出路） */
function dupRefusal(what, dup) {
  return '已存在同父同题同内容的' + what + '：' + dup.id + '（路径 ' + dup.path + '）。\n'
    + '这是一次**重复新增**（重试/重跑最常见的形态）—— 默认拒绝，以免同一个知识点进两遍。\n'
    + '两条出路：\n'
    + '  · 想**加第二份**：加 --force（那是有意的重复，不是手滑）；\n'
    + '  · 想**改那一条**：用 edit <项目> ' + dup.id + ' …，别再加一条。';
}

/**
 * `add` 的**数据面**：解析参数 → 定位父节点 → 语义去重 → 挂节点。
 * 返回一个**可重复执行**的改动函数（并发重放会再调它一次，所以闭包外的东西只读不写）。
 *
 * 为什么抽成函数：`apply`（本文件末尾那段）要复用**同一份**新增语义（含去重与 `--force`），
 * 复制一份必然漂移（本工程最忌讳的"同一事实两处表达"）。
 */
function makeAddOp(ctx, parent, opts) {
  const topic = opts.topic;
  const detail = opts.detail;
  const exp = opts.expanded;
  const lp = opts.localPath;                  // `{set:boolean, value?:string}`
  // 结果用**闭包对象**带出（不是"返回 null 表示拒绝"）：`ctx.mutate` 的返回值就是**要写盘的数据**，
  // 返回 null 会让写入与 changedKeys 直接崩（实测形态：`校验失败: 顶层必须是对象`）。
  // ⇒ 拒绝的做法是"盘上零改动地把 data 原样交回去"，由调用方读 `state.dup` 决定怎么报错。
  const state = { id: null, dup: null };
  const fn = (data, index) => {
    const parentNode = ctx.tree.find(data.data, parent);
    if (!parentNode) ctx.error(opts.what + '父节点不存在: ' + parent);
    const hit = findDuplicateChild(ctx, data, parentNode, topic, detail);
    if (hit && !opts.force) { state.dup = hit; return SKIP_WRITE; }   // 拒绝：**一次盘都不写**
    const id = opts.id || markdown.idGen(topic, index);
    if (ctx.tree.find(data.data, id)) ctx.error('id 已存在: ' + id);
    const node = { id: id, topic: topic, expanded: exp === undefined ? true : exp, children: [] };
    if (detail) node.detail = detail;
    if (lp.set && lp.value) node.localPath = lp.value;
    parentNode.children = (parentNode.children || []).concat(node);
    state.id = id;
    state.dup = hit || null;                                          // --force 下的有意重复
    return data;
  };
  fn.state = state;
  return fn;
}

/** `add-root` 的数据面：挂在 `root` 下，并开启「主题模式」（与 add 的区别只有这两点） */
function makeAddRootOp(ctx, opts) {
  const topic = opts.topic;
  const detail = opts.detail;
  const lp = opts.localPath;
  const state = { id: null, dup: null, themed: false };               // 同 makeAddOp：结果走闭包，不走返回值
  const fn = (data, index) => {
    const rootNode = ctx.tree.find(data.data, 'root');
    if (!rootNode) ctx.error('找不到根节点 root');
    const hit = findDuplicateChild(ctx, data, rootNode, topic, detail);
    if (hit && !opts.force) { state.dup = hit; return SKIP_WRITE; }   // 拒绝：**一次盘都不写**
    const id = opts.id || markdown.idGen(topic, index);
    if (ctx.tree.find(data.data, id)) ctx.error('id 已存在: ' + id);
    const node = { id: id, topic: topic, expanded: true, children: [] };
    if (detail) node.detail = detail;
    if (lp.set && lp.value) node.localPath = lp.value;
    rootNode.children = (rootNode.children || []).concat(node);
    data.meta = data.meta || {};
    state.themed = data.meta.rootMode === 'themes';
    data.meta.rootMode = 'themes';
    state.id = id;
    state.dup = hit || null;
    return data;
  };
  fn.state = state;
  return fn;
}

/** 通用：在指定父节点下新增一个子节点（`add` / `add-root` 共用前段参数校验） */
function addUnder(ctx, parent) {
  const topic = ctx.args.topic;
  if (!topic) ctx.error('缺少 --topic 标题');
  const detail = detailFromArgs(ctx);
  const lp = localPathFromArgs(ctx);                    // 形状校验在写盘之前（错了就别动数据）
  const exp = expandedFromArgs(ctx);                    // 同上：非法值在写盘之前就报错
  if (lp.set && lp.value && !fs.existsSync(lp.value)) {
    // 只是**警告**：目标可能还没建 / 盘没挂。数据照写，让用户自己看到风险（不静默、也不武断拒绝）
    ctx.out('⚠ 这个路径当前不存在（仍已记录，点击时会报错）：' + lp.value);
  }
  const op = makeAddOp(ctx, parent, {
    what: '', topic: topic, detail: detail, expanded: exp, localPath: lp,
    id: ctx.args.id, force: !!ctx.args.force
  });
  ctx.mutate(op);
  const st = op.state;
  if (st.dup && !st.id) ctx.error(dupRefusal('节点', st.dup));   // 默认拒绝 —— 但**指名**是那一条
  if (st.dup) {
    ctx.out('⚠ 已存在同父同题的节点 ' + st.dup.id + '，本次是 --force 下的**有意重复**');
  }
  ctx.out('已添加: ' + st.id + '（父 ' + parent + '）');
}

/* ============================================================================
 * 节点复制（`clone` 命令与 `apply` 的 `clone` op **共用同一份实现**）
 * ----------------------------------------------------------------------------
 * ## 为什么是一张表，而不是一串 if
 * 这个函数**第五次**踩在同一个坑上：**手挑字段清单漏一个** ⇒ 那个字段被静默抹掉
 * （没有门禁会红、事后极难发现）。前四次：`qa` / `localPath` / `origin` /
 * 界面的 `items`+`detailMode`（`renderer/app-core.js` 的 `walk()`）。
 * 2026-10-12 实测的形态：`clone` 一个条目化节点（有 `items`）⇒ 副本退回 v2；
 * 带 `localPath` / `origin` 的节点 ⇒ 副本上两者消失，而 `validate` 副本**照样通过**。
 * ⇒ 改成"**契约字段表**驱动"：字段清单只有一处（`src/schema.js` 的 `NODE_FIELDS`），本表逐行对齐它，
 *    并由 `scripts/cli-integration.js` 的「节点复制写回的字段清单」判据**机械核对**。
 *
 * ## 写法约定（判据靠它把"表"与"代码"对上，改这里要看那条判据）
 * 每行一项：`行号 / 档位 / 字段名 / 写法 / 说明`。档位两档：
 *   [必] = 每个节点都写（`id` / `topic` / `expanded` / `children`）；
 *   [选] = **只在有值时写**（`undefined` 不产生键）。
 * 后者是硬要求，不是风格：它对**不含这些字段的旧数据（v2）**保证
 * **克隆结果与从前逐字节相同** —— 拿"顺手补个默认值"去动它，会改掉老数据的形状。
 *
 * ## 边界
 *   · `expanded` 是唯一"缺省即 true"的字段 ⇒ 写出来与省略在语义上等价（都表示展开），
 *     故它一直写在"必"档里（**不是**静默丢失：没有信息被丢掉）。
 *   · `items` 整块**原样搬运**：含空数组与 `_` 起头的内部键（`_container` / `_groupStart` 等）
 *     都照搬，不在这一层解释条目语义（那是 `src/item-model.js` 的事）。
 *   · 但**条目 id 不能原样搬**：契约 §5.1 要求条目 id **全项目唯一**
 *     （`supersededBy` / `links[].item` 只带条目 id ⇒ 不唯一则引用有歧义），
 *     而写盘闸门真的会拦（实测：`clone` 条目化节点 ⇒ `error: 校验失败: [n1] 重复条目 id: …`）。
 *     ⇒ 副本人每条条目**换新 id、其余字段逐字不动**；`detail` 是派生缓存、里面不含 id，
 *       故 `detail === renderDetail(items)` 这条不变量照样成立（探针里 `validate` 复绿）。
 *   · `links[].item` **不在这里动**：副本上的条目级边**逐字仍指原物**（引用语义，原物还在、不是悬挂）。
 *     要改指"副本自己那份条目"是**另一档语义**（`--repoint-items`），由命令层显式做、对不上就拒绝
 *     —— 口径与判据见下面「条目级边（`links[].item`）在克隆时的三态语义」那一段。
 *
 * @param {object} n 源节点
 * @param {(base:string)=>string} mint 新**节点** id 生成器（注入：命令与 op 两条路径策略不同）
 * @param {boolean} deep 是否连子树一起复制
 * @param {(oldItemId:string)=>string} [mintItem] 新**条目** id 生成器；节点有 `items` 时**必需**
 *   （缺了就连条目的唯一性都保证不了 ⇒ 宁可响亮报错，也不静默照搬旧 id 让闸门去拦）
 * @returns {object} 副本节点（新 id）
 * ========================================================================== */
function cloneNode(n, mint, deep, mintItem) {
  const node = {};
  /* ---- 甲档：字段表（判据逐行解析这里；下面每一条赋值都要与它的加注对齐）----
   * 只增字段 + 只在有值时写 ⇒ 不含这些字段的旧数据克隆结果与从前逐字节相同。 */
  /*  1 [必] id          必写（无条件）     新 id（mint 注入：命令与 op 两条路径的去重策略不同） */
  /*  2 [必] topic       必写（无条件）     标题原样搬运 */
  /*  3 [必] expanded    必写（无条件）     缺省即 true，故写 `n.expanded !== false` */
  /*  4 [必] children    必写（无条件）     先占位空数组（键序固定），deep 时在末尾递归填充 */
  /*  5 [选] detail      条件设值（非空串）     正文 HTML */
  /*  6 [选] background  条件设值（非空串）     节点底色（透传字段） */
  /*  7 [选] detailMode  条件设值（非空串）     富文本节点标记 */
  /*  8 [选] localPath   条件设值（非空串）     本机文件夹绝对路径 */
  /*  9 [选] tags        必带长度闸门  标签数组（空数组不写键） */
  /* 10 [选] images      必带长度闸门  图片引用（空数组不写键） */
  /* 11 [选] files       必带长度闸门  附件引用（空数组不写键） */
  /* 12 [选] links       必带长度闸门  跨项目链接（空数组不写键） */
  /* 13 [选] qa          必带长度闸门  问答记录（v2 节点级） */
  /* 14 [选] items       必带长度闸门  条目层真源（**含空数组**：这是"有它即条目化"，故这里判的只是 非数组） */
  /* 15 [选] origin      条件设值（非空串）     来源指纹 */
  /* ---- 乙档：赋值正文（注释在上、赋值只写一次 —— 判据会逐项比对两边的字段名）----
   * 前四行的**键序**不要动：`id/topic/expanded/children` 依次先写，是"旧形状逐字节相同"的一半
   * （另一半是下面那些"只在有值时写"）。 */
  node.id = mint(n.id);
  node.topic = n.topic;
  node.expanded = n.expanded !== false;
  node.children = [];
  if (n.detail !== undefined) node.detail = n.detail;
  if (n.background !== undefined) node.background = n.background;
  if (n.detailMode !== undefined) node.detailMode = n.detailMode;
  if (n.localPath !== undefined) node.localPath = n.localPath;
  if (Array.isArray(n.tags) && n.tags.length) node.tags = n.tags.slice();
  if (Array.isArray(n.images) && n.images.length) node.images = JSON.parse(JSON.stringify(n.images));
  if (Array.isArray(n.files) && n.files.length) node.files = JSON.parse(JSON.stringify(n.files));
  if (Array.isArray(n.links) && n.links.length) node.links = JSON.parse(JSON.stringify(n.links));
  if (Array.isArray(n.qa) && n.qa.length) node.qa = JSON.parse(JSON.stringify(n.qa));
  if (Array.isArray(n.items)) node.items = cloneItems(n.items, mintItem);
  if (n.origin !== undefined) node.origin = JSON.parse(JSON.stringify(n.origin));
  if (deep) node.children = (n.children || []).map((c) => cloneNode(c, mint, true, mintItem));
  return node;
}

/**
 * 全项目**条目 id** 集合 —— 签发新条目 id 时的查重集（ITEM-MODEL §5.1 的唯一性口径）。
 * 用 `src/item-index.js` 的那份索引（`cli/commands/project.js` / `recheck.js` 同一处实现），
 * **不在这里再走一遍树**：一类事实一处实现，是本工程的硬规矩。
 */
function projectItemIds(root) {
  return new Set(Object.keys(itemIndex.buildIndexes(root).itemById));
}

/**
 * 复制一整份条目集：**内容逐字照搬、身份重新签发**（条目 id 换新，见 `cloneNode` 的边界说明）。
 * `_` 起头的内部键（`_container` / `_groupStart` / `_gap` / `_tail`）随深拷贝原样带走 ——
 * 判据与需求都明确要求"原样搬运"，这里**不筛键**。
 * @param {Array} items 源节点的 `items`
 * @param {(oldId:string)=>string} mintItem 新条目 id 生成器（必需：全项目唯一由调用方查重）
 */
function cloneItems(items, mintItem) {
  if (typeof mintItem !== 'function') {
    throw new Error('复制条目化节点必须提供 mintItem：条目 id 是**全项目唯一**的（ITEM-MODEL §5.1），'
      + '原样照搬会造出重复 id ⇒ 写盘闸门直接拒绝。');
  }
  return items.map((it) => {
    const copy = JSON.parse(JSON.stringify(it));
    if (copy && typeof copy === 'object' && !Array.isArray(copy)) copy.id = mintItem(it.id);
    return copy;
  });
}

/* ============================================================================
 * 条目级边（`links[].item`）在克隆时的**三态语义**
 * ----------------------------------------------------------------------------
 * 岔口在哪：副本上的条目 **id 是重新签发的**（全项目唯一，ITEM-MODEL §5.1），于是副本上那些
 * 条目级边要回答一个问题 —— **它们该指哪一条条目？** 本工程的口径（`docs/EXTENSIONS.md` §1.2）：
 *
 *   ① 默认（不给 `--repoint-items`）⇒ **引用语义**：边**逐字仍指原物**，克隆**不改它**。
 *      理由：`links[].item` 表达的是"与**那一条**有关"，那是**边自己的意思**，不等于"副本内部的指涉"；
 *      静默改掉 = 改掉数据的意思，而回显还会说"已复制"（本工程最重的一类损害）。
 *      ⚠️ 但"没被重指向"必须**看得见**：`--json` 的 `itemEdges.kept` 逐条点名（副本节点 / 边下标 /
 *      目标 / 源条目 id），文本档**仅当副本上真有这类边**时多一行 —— 没有 ⇒ 输出与从前**逐字相同**
 *      （不许给不含这类边的数据加噪音）。
 *   ② `--repoint-items` ⇒ **显式**改指**副本自己那份新条目**的对应条目。对应关系 = **同序号**：
 *      目标节点里那条条目的下标 k → 那个目标节点的**副本**里的第 k 条（`cloneItems` 保序 ⇒ 下标一一对应）。
 *      ⚠️ 改的是**两端**：边上的 `id`（目标**节点**）也要一起换成**那个节点的副本 id** ——
 *      只换 `item` 会立刻变成**悬挂**（新条目 id 挂在旧节点上，`validate` 判红；实测踩过）。
 *      换完这条边就真的成了"副本内部指涉"（两端都在副本子树里）。这是**语义改变**
 *      （引用原物 → 副本内部指涉），故回显明写"语义改变"、registry 的 desc 同步写明。
 *   ③ 对不上 ⇒ **拒绝并点名**（目标在别的项目 / 目标节点不在被复制范围 / 那个节点里没有这条条目）：
 *      `--repoint-items` 是"整条做成，或整条不做"，**不许按序号猜一个位置对齐上去** ——
 *      猜错就是把边指到了**另一条**条目上，而回显看起来是成功的。
 *
 * 判据（可执行）：`tests/clone-item-links.test.js` 的 ①②③⑤ + 注入证明 ④；`apply` 的 clone op 走
 *   **同一对函数**（判据在同文件的"apply 的 clone op"那一段：对得上 / 对不上 / 别名等价）。
 * 边界（如实登记）：`apply` 的 clone op 的**回显面**只有"逐条 op 回执"—— 它**不**给条目级边的清单
 *   （默认档不说"哪几条边仍指原物"）⇒ 想看清"哪些边没被重指向"要用 `clone --json` 看 `itemEdges`。
 *   重指向**是**支持的（op 里 `"repointItems": true`，别名 `repoint_items`）：走的就是下面这一对
 *   函数，对不上同样**整份 ops 拒绝**（见 `OPS.clone.run`）。
 * ========================================================================== */

/** 源子树 ↔ 副本子树**逐节点配对**（同形同序：`cloneNode` 的 children 就是按下标递归复制的）。
 *  ⚠️ `--deep` 不给时副本的 `children` 是**空的** ⇒ 只按**副本真的有的**那一份往下走
 *  （拿源的下标去索引副本 = 越界取到 `undefined`，那会让"克隆一个没深拷的节点"直接崩在半路）。 */
function pairSubtree(src, copy, out) {
  out.push({ src: src, copy: copy });
  (src.children || []).forEach((c, i) => {
    const cc = copy.children[i];
    if (cc) pairSubtree(c, cc, out);
  });
  return out;
}

/**
 * 扫出副本上**全部条目级边**，并逐条算出"重指向会指到哪一条 / 为什么指不了"。
 * **纯计算：一个字节都不改**（改不改由调用方定）—— 默认档只拿它出清单，
 * `--repoint-items` 档拿 `unmatched` 决定"拒"还是"改"，两档的读数来自**同一次计算**。
 *
 * @param {Array} pairs `pairSubtree(源, 副本, [])` 的结果
 * @param {string} project 本次项目名（条目级边的 `project` 与它不同 ⇒ 这条边没有副本可指）
 * @returns {{edges:Array, unmatched:Array}} `edges[]` 每项
 *   `{node, at, targetNode, item, target, link, toNode, to, ordinal, reason}`：
 *   `node`/`at` = 副本上的**哪个节点、哪条边**（点名用）；`targetNode`/`item`/`target` = 它**现在**指的那一条；
 *   `toNode`/`to` = 重指向后会变成的那一条（`null` = 对不上，`reason` 说明为什么）。
 */
function planItemEdges(pairs, project) {
  const bySrcId = new Map();
  pairs.forEach((p) => { if (!bySrcId.has(p.src.id)) bySrcId.set(p.src.id, p); });
  const edges = [];
  pairs.forEach((p) => {
    (Array.isArray(p.copy.links) ? p.copy.links : []).forEach((l, i) => {
      if (!l || typeof l !== 'object') return;
      const item = relations.itemKey(l.item);         // 归一（`undefined`/`null`/`''` = 没有条目层）
      if (!item) return;                              // 节点级边：三态语义与它无关，一个字节都不动
      const e = {
        node: p.copy.id,
        at: 'links[' + i + ']',
        targetNode: String(l.id),
        item: item,
        target: String(l.project) + '/' + String(l.id) + '#' + item,
        link: l, toNode: null, to: null, ordinal: null, reason: ''
      };
      if (l.project !== project) {
        e.reason = '目标是**别的项目**（' + l.project + '）—— 本次复制不可能造出它的副本';
      } else if (!bySrcId.has(l.id)) {
        e.reason = '目标节点 ' + l.id + ' 不在本次复制的子树里（不存在"副本自己那份条目"可指）';
      } else {
        const t = bySrcId.get(l.id);
        // "目标节点里有没有这条条目" = `relations.targetHasItem`（条目级悬挂的**唯一判据**，一处实现）
        const has = relations.targetHasItem(t.src, item);
        if (!has.ok) {
          e.reason = '目标节点 ' + l.id + ' 里没有这条条目'
            + (has.ids.length ? '（它现有：' + has.ids.join(', ') + '）' : '（它现在没有条目层）');
        } else {
          const k = t.src.items.findIndex((it) => it && it.id === item);   // 同序号：源下标 = 副本下标
          const copied = (Array.isArray(t.copy.items) ? t.copy.items : [])[k];
          // 构造上到不了（`cloneItems` 逐项 1:1 保序）—— 留着是为了"宁可点名拒绝，也不要半路 TypeError"
          if (!copied || typeof copied.id !== 'string' || !copied.id) {
            e.reason = '副本上同序号（第 ' + (k + 1) + ' 条）的位置没有条目 —— **序号对不上**';
          } else {
            e.toNode = t.copy.id;                     // ← 两端一起换：目标**节点**也要换成那个节点的副本
            e.to = copied.id;
            e.ordinal = k + 1;
          }
        }
      }
      edges.push(e);
    });
  });
  return { edges: edges, unmatched: edges.filter((e) => !e.to) };
}

/** `--repoint-items` 对不上 ⇒ 一句**可照着处置**的拒绝文本（逐条点名 + 两条出口）。 */
function repointRefusal(unmatched, srcId) {
  return '--repoint-items 对不上：副本上有 ' + unmatched.length + ' 条条目级链接在"副本自己那份新条目"里'
    + '找不到对应条目 ⇒ **本次复制整条拒绝**（盘上零改动）：\n'
    + unmatched.map((e) => '    · ' + e.at + '（副本节点 ' + e.node + '，源 ' + srcId + '）→ '
      + e.target + '：' + e.reason).join('\n')
    + '\n**不许按序号猜一个位置对齐上去**：猜错就是把边指到**另一条**条目上，而回显还会说成功。\n'
    + '两条出口：① 去掉 --repoint-items（默认档：边逐字仍指原物，属引用语义）；'
    + '② 让目标节点一起被复制（--deep 覆盖到它）—— 那时才存在"副本自己那份条目"。';
}

module.exports = {
  add(ctx) {
    const parent = ctx.args._[1];
    if (!parent) ctx.error('缺少父节点 id');
    addUnder(ctx, parent);
  },

  /** 新增顶层主题：不选父节点，直接挂在根节点下，并开启「主题模式」
   *  —— 主题模式下渲染层会隐藏容器根、跳过它的连线，于是各顶层主题互相独立。
   *  这样同一个项目里可以放多个不同方面的笔记。
   *  ⚠️ 与 `add` 同款**语义去重**（父 = root、标题、内容三项都同 ⇒ 默认拒绝并指名那一条）：
   *     "重跑一遍 add-root" 是重复新增最常见的形态之一，两种新增都得防住。 */
  addRoot(ctx) {
    const topic = ctx.args.topic;
    if (!topic) ctx.error('缺少 --topic 标题');
    const detail = detailFromArgs(ctx);
    const lp = localPathFromArgs(ctx);           // 顶层主题同样可挂本机文件夹（建树时根节点最需要它）
    if (lp.set && lp.value && !fs.existsSync(lp.value)) {
      ctx.out('⚠ 这个路径当前不存在（仍已记录，点击时会报错）：' + lp.value);
    }
    const op = makeAddRootOp(ctx, {
      topic: topic, detail: detail, localPath: lp, id: ctx.args.id, force: !!ctx.args.force
    });
    ctx.mutate(op);
    const st = op.state;
    if (st.dup && !st.id) ctx.error(dupRefusal('顶层主题', st.dup));
    if (st.dup) {
      ctx.out('⚠ 已存在同题同内容的顶层主题 ' + st.dup.id + '，本次是 --force 下的**有意重复**');
    }
    ctx.out('已添加顶层主题: ' + st.id + '（父 root）' + (st.themed ? '' : '，并已开启主题模式'));
  },

  edit(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    const detailGiven = ctx.args.detail !== undefined || ctx.args.detailMd !== undefined;
    const detail = detailGiven ? detailFromArgs(ctx) : undefined;
    const lp = localPathFromArgs(ctx);
    const exp = expandedFromArgs(ctx);                    // 非法值在写盘之前报错（见该函数注释）
    if (lp.set && lp.value && !fs.existsSync(lp.value)) {
      ctx.out('⚠ 这个路径当前不存在（仍已记录，点击时会报错）：' + lp.value);
    }
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      // 条目化节点（有 items）上，detail 是**派生缓存**、items 才是真源（docs/ITEM-MODEL.md §2）
      // ⇒ 整块改 detail 会把条目层冲掉（G2 会立刻判红）。这里只关 `--detail` / `--detail-md`
      // 这两扇门：`--topic` / `--tags` / `--expanded` / `--local-path` 照常可用（§12）。
      if (detailGiven && Array.isArray(node.items)) {
        ctx.error('节点 ' + id + ' 已**条目化**（items 为真源）—— 整块改 detail 会把条目层冲掉。'
          + '\n请用条目级命令：item-add / item-edit / item-remove / item-move / item-order；'
          + '要整块重建 detail 用 `render-detail <项目> ' + id + '`。'
          + '（`--topic` / `--tags` / `--expanded` / `--local-path` 照常可用。）');
      }
      if (ctx.args.topic) node.topic = ctx.args.topic;
      if (detailGiven) node.detail = detail;
      if (ctx.args.clearDetail) delete node.detail;
      // 标签：--tags "a,b" 覆盖设置；--clear-tags 清空
      if (ctx.args.tags !== undefined) {
        const tags = String(ctx.args.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (tags.length) node.tags = tags; else delete node.tags;
      }
      if (ctx.args.clearTags) delete node.tags;
      // 本机文件夹路径：--local-path 设置；--clear-local-path 清除
      if (lp.set) { if (lp.value) node.localPath = lp.value; else delete node.localPath; }
      if (exp !== undefined) node.expanded = exp;
      return data;
    });
    ctx.out('已更新: ' + id);
  },

  /** 按深度**规范化展开状态**（持久化到数据）。
   *
   *  为什么需要：展开状态是**数据里的字段**（`expanded`），而渲染层已经不再无条件展开
   *  （见 renderer/app-core.js 的 renderMind）⇒ 数据说展开就展开、说收起就收起。
   *  但历史上 CLI 建树/早期导入一律写 `expanded: true`，于是"打开就是一片全展开、要滚很久"。
   *  本命令把一棵（子）树按深度统一成"前 N 层展开、更深的收起"，**一次原子写**完成
   *  —— 逐节点 `edit --expanded false` 要写几百次盘，那是另一种毛病（写放大）。
   *  方向可逆：`--depth 0` 全收起，`--depth` 给足够大的值就是全展开。
   */
  expandDepth(ctx) {
    const proj = ctx.args._[0];
    if (!proj) ctx.error('缺少项目名');
    const raw = ctx.args.depth;
    const keep = raw === undefined ? 2 : Number(raw);
    if (!Number.isInteger(keep) || keep < 0) ctx.error('--depth 必须是非负整数（0 = 全收起）');
    const subId = ctx.args.id;
    let changed = 0, seen = 0, targetId = null;
    ctx.mutate((data) => {
      const target = subId ? ctx.tree.find(data.data, subId) : ctx.tree.find(data.data, 'root');
      if (!target) ctx.error('节点不存在: ' + (subId || 'root'));
      targetId = target.id;
      const walk = (n, d) => {
        if (!n) return;
        const kids = n.children || [];
        if (kids.length) {
          seen++;
          const want = d < keep;
          if ((n.expanded !== false) !== want) { n.expanded = want; changed++; }
        }
        kids.forEach((c) => walk(c, d + 1));
      };
      // 深度从**目标节点的子节点**算起（目标自身记 -1）：容器根 root 在主题模式下是隐藏的，
      // 若把它算作第 0 层，"--depth 2" 实际只展开到第 1 层，与"前两层展开"的说法不符（实测踩到）。
      walk(target, -1);
      return data;
    });
    ctx.out('已按 --depth ' + keep + ' 规范化展开状态（子树根 ' + targetId + '）：'
      + '检查 ' + seen + ' 个带子节点的节点，改写 ' + changed + ' 个');
  },

  move(ctx) {
    const id = ctx.args._[1];
    const parent = ctx.args._[2];
    if (!id || !parent) ctx.error('用法: move <项目> <id> <新父id> [--index n]');
    // `--index` 必须显式校验：tree.moveNode 对非法索引（NaN / 负数 / 越界）**静默退化成末尾插入**
    // ⇒ `move x y --index abc` 会"成功"地插到末尾，调用方却以为插到了第 abc 位。
    let idx;
    if (ctx.args.index !== undefined) {
      idx = Number(ctx.args.index);
      if (!Number.isInteger(idx) || idx < 0) {
        ctx.error('--index 必须是非负整数（收到 ' + JSON.stringify(ctx.args.index) + '）');
      }
    }
    ctx.mutate((data) => {
      const ok = ctx.tree.moveNode(data.data, id, parent, idx);
      if (!ok) ctx.error('移动失败（节点不存在 / 目标非法 / 移动到自身子树 / 索引越界）');
      return data;
    });
    ctx.out('已移动: ' + id + ' → ' + parent);
  },

  remove(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    if (id === 'root') ctx.error('根节点不可删除');
    // 清理结果是"给人看的输出"，必须带出 fn 之外 —— fn 可能被并发重放，在里面 out() 会打印两次
    let removedKids = 0, assocMsg = null, linkMsg = null;
    ctx.mutate((data) => {
      const target = ctx.tree.find(data.data, id);
      if (!target) ctx.error('节点不存在: ' + id);

      // 关联笔记：被删（子）树可能是某些关联的成员。删掉而不处理 = 造出"悬挂成员"，
      // 而写盘闸门会拿**这份待写数据**判同项目成员 → 不处理的删除会被判红。
      // 不用"先 prune 再删"来回避：prune 只能清已经悬空的成员，删之前它还悬不了，
      // 所以这里必须自己提供清理路径（--clean-assoc），否则用户无路可走。
      const ids = new Set();
      (function collect(n) { if (!n) return; ids.add(n.id); (n.children || []).forEach(collect); })(target);
      const list = Array.isArray(data.assoc) ? data.assoc : [];
      const hit = list.filter((a) => (a.members || []).some((m) => m && m.project === ctx.projectName && ids.has(m.id)));

      // 链接：**同项目**里指向被删（子）树的有向边同样会悬空 → 同样的锁死问题。
      // （跨项目引用者没法在这里便宜地发现：要扫全部项目。那个方向由引用者自己跑
      //   `links-prune` 修好 —— 提示里会说明。）
      const inbound = [];
      ids.forEach((nid) => links.inbound(data.data, ctx.projectName, nid).forEach((x) => inbound.push(x)));

      const removed = ctx.tree.removeNode(data.data, id);
      if (!removed) ctx.error('节点不存在: ' + id);
      removedKids = ctx.tree.count(removed) - 1;

      if (hit.length || inbound.length) {
        const need = [];
        if (hit.length) need.push('--clean-assoc');
        if (inbound.length) need.push('--clean-links');
        const flagsOk = (!hit.length || ctx.args.cleanAssoc) && (!inbound.length || ctx.args.cleanLinks);
        if (!flagsOk) {
          const lines = ['删除 ' + id + ' 会影响已被引用的关系，若原样删除，本项目**所有**写命令都会被闸门挡住:'];
          if (hit.length) {
            lines.push('  · ' + hit.length + ' 篇关联笔记引用了它（' + hit.map((a) => a.id).join(', ') + '）');
          }
          if (inbound.length) {
            lines.push('  · ' + inbound.length + ' 条链接指向它（'
              + inbound.map((x) => x.node + ' → ' + x.link.project + '/' + x.link.id).join(', ') + '）');
          }
          lines.push('二选一：');
          lines.push('  · remove ' + ctx.projectName + ' ' + id + ' ' + need.join(' ') + '    （删节点并同步清理）');
          lines.push('  · 先摘引用再单独删：assoc-prune / links-prune ' + ctx.projectName + ' --nodes ' + id);
          lines.push('  注：若**别的项目**里有链接指向它，那些项目请各自跑 links-prune 修好。');
          ctx.error(lines.join('\n'));
        }
        if (hit.length) {
          const pruned = assoc.pruneMembers(list, (m) => m.project === ctx.projectName && ids.has(m.id));
          if (pruned.empty) delete data.assoc; else data.assoc = pruned.list;
          assocMsg = '已同步清理关联：' + pruned.touched.map((t) => t.id + '（- ' + t.removed + ' 成员）').join(', ')
            + (pruned.dropped.length ? '；整篇删除（只剩一个成员）: ' + pruned.dropped.join(', ') : '');
        }
        if (inbound.length) {
          const lr = links.pruneLinks(data.data, (l) => l.project === ctx.projectName && ids.has(String(l.id)));
          linkMsg = '已同步清理链接：' + lr.removed.map((x) => x.node + ' → ' + x.target).join(', ');
        }
      }
      return data;
    });
    if (assocMsg) ctx.out(assocMsg);
    if (linkMsg) ctx.out(linkMsg);
    ctx.out('已删除: ' + id + '（含 ' + removedKids + ' 个子节点）');
  },

  clone(ctx) {
    const id = ctx.args._[1];
    const parent = ctx.args._[2];
    if (!id || !parent) ctx.error('用法: clone <项目> <源id> <新父id> [--deep] [--repoint-items] [--json]');
    // `--repoint-items` 是**纯开关**（不带值），已进 `cli/core.js` 的纯布尔登记表（`--deep` 就在那里）
    // ⇒ 裸写恒为 `true`，且 `clone 项目 --repoint-items 源 新父` 与 `--deep` **同待遇**（三个位置参数
    // 各就各位，不会被吞成 repointItems 的值）。
    // ⚠️ 仍然保留下面这道闸门：带 `=` 的写法（`--repoint-items=yes`）走的是**通用 `=` 分支**，
    // 登记表管不到它 ⇒ 那种形态在这里**响亮拒绝**（`tests/clone-item-links.test.js` 钉着它），
    // 而不是让 `repointItems='yes'` 这种值悄悄流进"只认布尔"的地方。
    const repointRaw = ctx.args.repointItems;
    if (repointRaw !== undefined && repointRaw !== true) {
      ctx.error('--repoint-items 是**纯开关**（不带值）：写法 '
        + '`clone <项目> <源id> <新父id> [--deep] --repoint-items`（收到 '
        + JSON.stringify(repointRaw) + '）');
    }
    const repoint = repointRaw === true;
    let copyId = null;
    let edges = [];
    ctx.mutate((data) => {
      const src = ctx.tree.find(data.data, id);
      if (!src) ctx.error('源节点不存在: ' + id);
      const parentNode = ctx.tree.find(data.data, parent);
      if (!parentNode) ctx.error('父节点不存在: ' + parent);

      // 新 id 生成：时间戳 + 序号，并对照全树现有 id 去重。
      // （原实现只用 Date.now().toString(36).slice(-3)，--deep 复制同层多个节点时
      //   极易撞号 → validate 报「重复 id」直接失败。）
      const used = new Set(ctx.tree.flatten(data.data).map((n) => n.id));
      const stamp = Date.now().toString(36).slice(-4);
      let seq = 0;
      const mintId = (base) => {
        let candidate;
        do { candidate = base + '-c' + stamp + (seq++ ? '-' + seq : ''); } while (used.has(candidate));
        used.add(candidate);
        return candidate;
      };
      // 条目 id 也要换新（全项目唯一，§5.1）—— 与节点 id 同一套「基名 + 后缀 + 查重」写法
      const usedItems = projectItemIds(data.data);
      let itemSeq = 0;
      const mintItemId = (base) => {
        let candidate;
        do { candidate = base + '-c' + stamp + (itemSeq++ ? '-' + itemSeq : ''); } while (usedItems.has(candidate));
        usedItems.add(candidate);
        return candidate;
      };

      // ⚠️ 复制走**模块级** `cloneNode`（唯一实现，字段表见那里）：本处曾有一份**手挑字段**的
      //    局部深拷贝 —— 它漏掉 `items` / `detailMode` / `localPath` / `origin`，
      //     于是"复制一个条目化节点"会把整层条目静默抹掉 —— 本工程**同一形态第 5 次**（qa → localPath → origin → 界面 items/detailMode → clone）。
      //     别再就地写第二份：两份必然漂，而漂的那个方向是**静默丢字段**。
      const copy = cloneNode(src, mintId, !!ctx.args.deep, mintItemId);
      // 条目级边：**先把话说清楚，再决定改不改**（口径见上面「三态语义」那一段）。
      // 默认档 ⇒ 一个字节都不动，只把"没被重指向"这件事带出去；
      // 重指向档 ⇒ 对不上就**在这里拒绝**（`ctx.error` 抛出 ⇒ 盘上零改动），对得上才逐条改指向。
      const plan = planItemEdges(pairSubtree(src, copy, []), ctx.projectName);
      if (repoint && plan.unmatched.length) ctx.error(repointRefusal(plan.unmatched, id));
      // ← 本条命令里唯一的写点：**两端一起换**（只换 item 会立刻悬挂，见上面那段注释）
      if (repoint) plan.edges.forEach((e) => { e.link.id = e.toNode; e.link.item = e.to; });
      parentNode.children = (parentNode.children || []).concat(copy);
      copyId = copy.id;
      edges = plan.edges;
      return data;
    });
    const kept = repoint ? [] : edges;
    const repointed = repoint ? edges : [];
    if (ctx.args.json) {
      ctx.outJson({
        ok: true, project: ctx.projectName, sourceId: id, parent: parent, copyId: copyId,
        deep: !!ctx.args.deep, repointItems: repoint,
        itemEdges: {
          count: edges.length,
          keptCount: kept.length,
          // "未被重指向的条目级边"逐条点名（默认档 = 全部条目级边）：
          // `repointable` 说这条边**能不能**被 --repoint-items 重指向，能的话 `wouldBe` 给出目标 id。
          kept: kept.map((e) => {
            const o = { node: e.node, at: e.at, item: e.item, target: e.target, repointable: !!e.to };
            if (e.to) o.wouldBe = e.toNode + '#' + e.to; else o.reason = e.reason;
            if (e.to) o.ordinal = e.ordinal;
            return o;
          }),
          repointedCount: repointed.length,
          repointed: repointed.map((e) => ({
            node: e.node, at: e.at, from: e.targetNode + '#' + e.item,
            to: e.toNode + '#' + e.to, ordinal: e.ordinal, target: e.target
          }))
        }
      });
      return;
    }
    ctx.out('已复制: ' + id + ' → ' + parent + '（新 id ' + copyId + '）');
    // ⚠️ 下面两行**只在副本上真有条目级边时**才出现（没有 ⇒ 输出与从前逐字相同，不许加噪音）
    if (repoint && repointed.length) {
      ctx.out('已重指向 ' + repointed.length + ' 条条目级链接（**语义改变**：原先指副本外的"原物"，'
        + '现在指副本自己的节点与条目）：'
        + repointed.map((e) => e.node + ' ' + e.at + ' ' + e.targetNode + '#' + e.item
          + ' → ' + e.toNode + '#' + e.to + '（同序号 ' + e.ordinal + '）').join('；'));
    } else if (!repoint && kept.length) {
      ctx.out('⚠ 副本上 ' + kept.length + ' 条条目级链接**仍指原物**（引用语义，克隆不改它）：'
        + kept.map((e) => e.node + ' ' + e.at + ' → ' + e.target).join('；')
        + '（要改指副本自己的条目：加 --repoint-items）');
    }
  },

  /** `apply <项目> --ops-file ops.json [--dry-run] [--idem 键]` —— 见下方 apply 段 */
  apply,

  /** ⚠️ 导出给**单测**（`tests/clone-field-copy.test.js` 与 `tests/clone-item-links.test.js`）直接调用
   *  —— 它们是本文件里"复制一个节点"与"算条目级边的重指向"的**唯一实现**
   *  （`clone` 命令与 `apply` 的 clone op 共用）。
   *  直接测它、而不是只测命令回显，是为了让"`undefined` 不产生键"这类**对象级**性质可断言
   *  （写盘后的 JSON 看不见 `undefined`）。命令面照旧只认 registry 里登记的那几个键：
   *  `cli/registry.js` 只按下标取具名函数，没有任何地方枚举本对象的键。 */
  cloneNode: cloneNode,
  cloneItems: cloneItems,
  pairSubtree: pairSubtree,
  planItemEdges: planItemEdges
};

/* ============================================================================
 * apply —— 一批改动在**一次事务**里做完（S7）
 * ----------------------------------------------------------------------------
 * ## 它解决什么
 * 一次"改 N 个节点"的意图，若逐条敲命令就是 **N 次原子写**：中途失败留下**半成品**
 * （前 k 条生效、k+1 条没做），而调用方拿不到"做到哪了"—— 要么整批重跑（前 k 条重复生效），
 * 要么手工查盘上现在是什么样。`apply` 把整批收进**一次 `ctx.mutate`**：
 *   · **一个 rev**、**一次原子写**、**一条日志**（`.changes.jsonl` 只多 1 条，不是 N 条）；
 *   · **全成或全不动**：任何一条非法 ⇒ 在写盘之前响亮拒绝（并**指名第几条**），盘上零改动；
 *   · 逐条回执（应用了几条、跳过哪条、为什么）。
 *
 * ## 三条硬边界（写清楚，免得被当成"万能批处理"）
 *   ① **只允许数据面操作**：本文件里那张 `OPS` 表就是全部（新增/编辑/移动/复制节点 +
 *      关联的增改）。**外部副作用一律留在事务外** —— 复制物理文件（add-image/add-file）、
 *      调外部进程（ask）、碰界面（sidebar-only / dsh-*）都**不在** `OPS` 里，写到 ops 文件里
 *      会被**指名拒绝**（不是静默忽略）。理由：`ctx.mutate` 的改动函数在并发冲突时会被
 *      **再调用一次**（自动重放到最新版）⇒ 里面做物理副作用的动作会**做两遍**
 *      （留下孤儿文件/重复调用外部服务）。这条约束是架构口径（ARCHITECTURE §4b 的
 *      "fn 里禁止 I/O"）在命令面上的直接体现。
 *   ② **`remove` 与 `assoc-remove` 故意不在表里**：删节点要处理"被关联/链接引用"的连带清理
 *      （`--clean-assoc` / `--clean-links`，见 remove 的注释），那是**判断+清理**，批处理里
 *      无法安全表达 ⇒ 报文直接指向那两条命令，别在这里静默半做。
 *   ③ **`ops` 数组没有嵌套事务**：它本身就是事务的粒度。
 *
 * ## ops 文件格式（版本 1）
 * ```json
 * { "version": 1,
 *   "ops": [
 *     { "op": "add",  "parent": "root", "id": "k1", "topic": "标题",
 *       "detailMd": "## 小节\n正文", "expanded": true, "localPath": "E:\\资料" },
 *     { "op": "edit", "id": "k1", "tags": "a,b", "clearDetail": true },
 *     { "op": "move", "id": "k1", "parent": "root", "index": 0 },
 *     { "op": "clone", "id": "k1", "parent": "root", "deep": true },
 *     { "op": "clone", "id": "k1", "parent": "root", "deep": true, "repointItems": true },
 *     { "op": "assoc-add", "members": "k1,k2", "title": "关联", "noteMd": "…", "id": "a-k1k2" },
 *     { "op": "assoc-edit", "id": "a-k1k2", "clearNote": true }
 *   ] }
 * ```
 * 也接受**裸数组**（`[ {op:…}, … ]`，没有 version 包裹）—— 少一层包装更省事，两种都认。
 * 字段名与各命令的**选项键**一致（camelCase），于是"命令怎么写、ops 里就怎么填"。
 * clone op 的 `repointItems`（别名 `repoint_items`，见 `repointFlagOf`）与 `clone --repoint-items`
 * 是**同一个开关、同一份判定**：对不上 ⇒ 这一条 op 抛错 ⇒ **整份 ops 拒绝、盘上零改动**并点名第几条
 * （与 move 的"移到自身子树"同一形状；`--dry-run` 里同样看得见）。
 * `--ops-file` 也接受**内联 JSON 文本**（以 `{` 或 `[` 开头即视为文本）—— 给脚本与 AI 用。
 *
 * ## 幂等
 * `--idem <键>` 与别的写命令同一套（机制在 `cli/core.js`）：同键重放 ⇒ 不重复执行、
 * 回放首次回执。**注意**：`apply` 自己还有一层**免费的**幂等 —— `add` 的语义去重
 * （同父/同题/同内容）会让"重跑同一份 ops"里的新增条目被拒，但那样整批会**报错**（而不是静默跳过）。
 * 想要"重跑即无事发生"，就带 `--idem`。
 * ========================================================================== */

/** 解析并校验 `--ops-file`：接受文件路径或**内联 JSON 文本**；错误一律带出路 */
function readOpsFile(ctx) {
  const raw = ctx.args.opsFile;
  if (raw === undefined || raw === true || raw === '') {
    ctx.error('缺少 --ops-file（一个 JSON 文件路径，或**内联 JSON 文本**，如 --ops-file \'{"ops":[…]}\'）');
  }
  const text0 = String(raw).trim();
  const inline = text0.charAt(0) === '{' || text0.charAt(0) === '[';
  let text = text0;
  const file = inline ? '(内联 JSON)' : path.resolve(text0);
  if (!inline) {
    if (!fs.existsSync(file)) {
      ctx.error('--ops-file 指向的文件不存在: ' + file
        + '（相对路径按**当前工作目录**解析；也可以直接内联 JSON 文本）');
    }
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { ctx.error('--ops-file 读不了: ' + file + '（' + ((e && e.message) || e) + '）'); }
  }
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (e) { ctx.error('--ops-file 不是合法 JSON（' + file + '）：' + ((e && e.message) || e)); }
  if (Array.isArray(parsed)) parsed = { version: 1, ops: parsed };
  if (!parsed || typeof parsed !== 'object') ctx.error('--ops-file 的顶层必须是对象或数组（收到 ' + typeof parsed + '）');
  if (parsed.version !== undefined && Number(parsed.version) !== 1) {
    ctx.error('--ops-file 的 version 只支持 1（收到 ' + JSON.stringify(parsed.version) + '）');
  }
  if (!Array.isArray(parsed.ops)) ctx.error('--ops-file 里缺少 ops 数组（形如 {"version":1,"ops":[{"op":"edit",…}]}）');
  if (!parsed.ops.length) ctx.error('--ops-file 的 ops 是空的（一次事务至少要有一条操作）');
  return { file: file, ops: parsed.ops };
}

/**
 * 逐条预检：任何一条非法 ⇒ 返回 `{error, index}`（**在写盘之前**，所以盘上零改动）。
 *
 * ⚠️ 预检带着一棵**模拟树**（从盘上这份数据拷贝出来、随每条 op 在内存里推演）——
 * 于是"第 2 条 add 出来、第 4 条 edit 引用它"这种**同一批内部的前后引用**能被正确接受，
 * 而"引用一个这条事务里凭空捏造的 id"仍会被点名拒绝。没有模拟树就只能两种坏选择：
 * 要么放行（错误推迟到执行期，报错就说不清第几条），要么误杀（合法的批内引用被拒 ✗）。
 */
function precheckOps(ctx, ops, root) {
  const sim = tree.clone ? tree.clone(root) : JSON.parse(JSON.stringify(root));
  const prepared = [];
  for (let i = 0; i < ops.length; i++) {
    const raw = ops[i];
    const at = '第 ' + (i + 1) + ' 条操作';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: at + ' 不是对象（每条形如 {"op":"edit","id":"x","topic":"新标题"}）', index: i };
    }
    if (typeof raw.op !== 'string' || !raw.op) return { error: at + ' 缺少 op 字段（这条操作是什么）', index: i };
    const def = OPS[raw.op];
    if (!def) {
      return { error: at + '：不认识的 op「' + raw.op + '」。只允许**数据面**操作：'
        + Object.keys(OPS).join(' / ')
        + '。需要外部副作用的（图片/附件/导出/界面控制）与需要连带清理的（remove / assoc-remove）'
        + '请用各自的命令单独做（见 docs/CLI.md）—— 它们**不在**事务里，别指望回滚。', index: i };
    }
    let checked;
    try { checked = def.v(ctx, raw, sim); }
    catch (e) { return { error: at + '（' + raw.op + '）：' + ((e && e.message) || e), index: i }; }
    // 没给 id 的新增：id 由 `(标题, 本条序号)` 决定（可复现），这里按同一规则算出来进模拟树，
    // 于是"同一标题新增两条"会在预检期就报「id 已存在」（而不是落盘时才炸）。
    if (checked.simAdd === null && def === OPS.add) checked.simAdd = { parent: checked.parent, id: markdown.idGen(checked.topic, i + 1) };
    if (checked.simAdd === null && def === OPS['add-root']) checked.simAdd = { parent: 'root', id: markdown.idGen(checked.topic, i + 1) };
    if (checked.simAdd) {
      if (tree.find(sim, checked.simAdd.id)) {
        return { error: at + '（' + raw.op + '）新增的 id 已被占用: ' + checked.simAdd.id
          + '（同一批里同标题的新增要各自给 id，或改标题）', index: i };
      }
      const p = tree.find(sim, checked.simAdd.parent);
      if (p) p.children = (p.children || []).concat({ id: checked.simAdd.id, topic: '', children: [] });
    } else if (checked.simMove) {
      const n = tree.find(sim, checked.simMove.id);
      const p = tree.find(sim, checked.simMove.parent);
      if (n && p) p.children = (p.children || []).concat({ id: n.id, topic: n.topic, children: n.children || [] });
    }
    prepared.push({ index: i, op: raw.op, def: def, args: checked });
  }
  return { prepared: prepared };
}

/** 存在性检查（模拟树优先 —— 它代表"这一批做完之后"的树） */
function needNode(sim, id, what) {
  if (!tree.find(sim, id)) throw new Error((what || '节点') + '不存在: ' + id);
}

/** 收尾（关联 id 校验等"写盘后不该失败"的判定，与逐个执行前的最后一道检查合二为一） */
function checkAssocId(val) {
  if (String(val).length > 0 && !assoc.ID_RE.test(String(val))) {
    return '关联 id 不合规范（小写字母/数字/连字符）: ' + val;
  }
  return null;
}

/** detail / note 的取值（与 edit.js 的 detailFromArgs、assoc.js 的 noteFromArgs 同一规矩：互斥 + 显式声明） */
function detailOf(ctx, raw) {
  const hasHtml = raw.detail !== undefined;
  const hasMd = raw.detailMd !== undefined;
  if (hasHtml && hasMd) ctx.error('detail 与 detailMd 不能同时给（前者 HTML 原样存、后者 Markdown 转）');
  if (hasMd) {
    if (typeof raw.detailMd !== 'string' || !raw.detailMd.trim()) ctx.error('detailMd 内容为空');
    return convert.markdownToHtml(raw.detailMd);
  }
  return hasHtml ? raw.detail : undefined;
}

function noteOf(ctx, raw) {
  const hasHtml = raw.note !== undefined;
  const hasMd = raw.noteMd !== undefined;
  if (hasHtml && hasMd) ctx.error('note 与 noteMd 不能同时给（前者 HTML 原样存、后者 Markdown 转）');
  if (hasMd) {
    if (typeof raw.noteMd !== 'string' || !raw.noteMd.trim()) ctx.error('noteMd 内容为空');
    return convert.markdownToHtml(raw.noteMd);
  }
  return hasHtml ? raw.note : undefined;
}

/**
 * **数据面操作表**（`apply` 的全部能力面 —— 也是"只允许数据面"这句断言的实现）。
 * 每条三件事：`v(ctx, raw)` 预检并返回规范化参数（**不碰数据**）、`run(data, a, index)` 改动、
 * `summary(a, out)` 回执文案。新增一条 op 时要同时想清楚：它在并发重放里被**再调一次**安全吗？
 * （不安全 = 它不该进这张表，见文件头边界 ①）
 */
const OPS = {
  add: {
    v(ctx, raw, sim) {
      if (!raw.topic) ctx.error('缺少 topic（新增节点必须有标题）');
      const parent = raw.parent === undefined ? 'root' : String(raw.parent);
      needNode(sim, parent, '父节点');
      const id = raw.id === undefined ? null : String(raw.id);
      if (id && tree.find(sim, id)) ctx.error('id 已存在: ' + id);
      return {
        parent: parent, topic: raw.topic, id: id,
        detail: detailOf(ctx, raw), expanded: raw.expanded, localPath: raw.localPath,
        force: !!raw.force,
        // 供预检的**模拟树**推演（参数里那段"这一批做完之后"的世界）；null = id 自动生成，由预检补算
        simAdd: id ? { parent: parent, id: id } : null
      };
    },
    run(ctx, data, a, index) {
      const op = makeAddOp(ctx, a.parent, {
        what: '', topic: a.topic, detail: a.detail, expanded: a.expanded,
        localPath: { set: a.localPath !== undefined, value: a.localPath },
        id: a.id, force: a.force
      });
      a._fn = op;
      const out = op(data, index + 1);
      const st = op.state;
      if (st.dup && !st.id) {
        throw new Error('已存在同父同题同内容的节点 ' + st.dup.id + '（路径 ' + st.dup.path + '）——'
          + '要么删掉那条，要么给这条 op 加 "force": true');
      }
      a._newId = st.id;
      return out;
    },
    summary(a) { return '新增 ' + a._newId + '（父 ' + a.parent + '）'; }
  },

  'add-root': {
    v(ctx, raw, sim) {
      if (!raw.topic) ctx.error('缺少 topic（新增顶层主题必须有标题）');
      needNode(sim, 'root', '根节点');
      const id = raw.id === undefined ? null : String(raw.id);
      if (id && tree.find(sim, id)) ctx.error('id 已存在: ' + id);
      return {
        topic: raw.topic, id: id, detail: detailOf(ctx, raw), localPath: raw.localPath, force: !!raw.force,
        simAdd: id ? { parent: 'root', id: id } : null
      };
    },
    run(ctx, data, a, index) {
      const op = makeAddRootOp(ctx, {
        topic: a.topic, detail: a.detail,
        localPath: { set: a.localPath !== undefined, value: a.localPath },
        id: a.id, force: a.force
      });
      const out = op(data, index + 1);
      const st = op.state;
      if (st.dup && !st.id) {
        throw new Error('已存在同题同内容的顶层主题 ' + st.dup.id + '（路径 ' + st.dup.path + '）——'
          + '要么删掉那条，要么给这条 op 加 "force": true');
      }
      a._newId = st.id;
      return out;
    },
    summary(a) { return '新增顶层主题 ' + a._newId; }
  },

  edit: {
    v(ctx, raw, sim) {
      if (!raw.id) ctx.error('缺少 id（改哪个节点）');
      needNode(sim, String(raw.id));
      const k = ['topic', 'tags', 'expanded', 'localPath', 'clearDetail', 'clearTags', 'clearLocalPath']
        .filter((x) => raw[x] !== undefined);
      const hd = raw.detail !== undefined || raw.detailMd !== undefined;
      if (!k.length && !hd) {
        ctx.error('什么也没改（可用字段：topic / detail / detailMd / clearDetail / tags / '
          + 'clearTags / localPath / clearLocalPath / expanded）');
      }
      return {
        id: String(raw.id), topic: raw.topic, detail: detailOf(ctx, raw),
        clearDetail: !!raw.clearDetail, tags: raw.tags, clearTags: !!raw.clearTags,
        localPath: raw.localPath, clearLocalPath: !!raw.clearLocalPath, expanded: raw.expanded
      };
    },
    run(ctx, data, a) {
      const node = tree.find(data.data, a.id);
      if (!node) throw new Error('节点不存在: ' + a.id);
      const changed = [];
      if (a.topic !== undefined && String(node.topic) !== String(a.topic)) { node.topic = a.topic; changed.push('topic'); }
      if (a.detail !== undefined && node.detail !== a.detail) { node.detail = a.detail; changed.push('detail'); }
      if (a.clearDetail && node.detail !== undefined) { delete node.detail; changed.push('-detail'); }
      if (a.tags !== undefined) {
        const tags = String(a.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (tags.length) node.tags = tags; else delete node.tags;
        changed.push('tags');
      }
      if (a.clearTags && node.tags !== undefined) { delete node.tags; changed.push('-tags'); }
      if (a.localPath !== undefined) { node.localPath = String(a.localPath); changed.push('localPath'); }
      if (a.clearLocalPath && node.localPath !== undefined) { delete node.localPath; changed.push('-localPath'); }
      if (a.expanded !== undefined) { node.expanded = !!a.expanded; changed.push('expanded'); }
      a._changed = changed;
      return data;
    },
    summary(a) { return '改写 ' + a.id + '：' + (a._changed.join(' ') || '（无实际变化）'); }
  },

  move: {
    v(ctx, raw, sim) {
      if (!raw.id) ctx.error('缺少 id（移哪个节点）');
      if (!raw.parent) ctx.error('缺少 parent（移到哪个父节点下）');
      needNode(sim, String(raw.id));
      needNode(sim, String(raw.parent), '父节点');
      if (String(raw.id) === String(raw.parent)) ctx.error('不能把节点移到它自己下面: ' + raw.id);
      if (String(raw.id) === 'root') ctx.error('根节点不可移动');
      let idx;
      if (raw.index !== undefined) {
        idx = Number(raw.index);
        if (!Number.isInteger(idx) || idx < 0) ctx.error('index 必须是非负整数（收到 ' + JSON.stringify(raw.index) + '）');
      }
      return {
        id: String(raw.id), parent: String(raw.parent), index: idx,
        simMove: { id: String(raw.id), parent: String(raw.parent) }
      };
    },
    run(ctx, data, a) {
      const ok = tree.moveNode(data.data, a.id, a.parent, a.index);
      if (!ok) throw new Error('移动失败（目标非法 / 移到自身子树 / 索引越界）: ' + a.id + ' → ' + a.parent);
      return data;
    },
    summary(a) { return '移动 ' + a.id + ' → ' + a.parent + (a.index === undefined ? '' : '（第 ' + a.index + ' 位）'); }
  },

  clone: {
    v(ctx, raw, sim) {
      if (!raw.id) ctx.error('缺少 id（复制哪个节点）');
      if (!raw.parent) ctx.error('缺少 parent（复制到哪个父节点下）');
      needNode(sim, String(raw.id), '源节点');
      needNode(sim, String(raw.parent), '父节点');
      // `repointItems`（别名 `repoint_items`，解析只有一处 = repointFlagOf）：与命令面
      // `clone --repoint-items` 是**同一个开关**、同一份判定 —— 改指"副本自己那份条目"。
      // ⚠️ 这里只做**参数形状**校验；"对得上对不上"要等副本造出来才知道 ⇒ 在 `run()` 里判（见那里）。
      return { id: String(raw.id), parent: String(raw.parent), deep: !!raw.deep,
        repointItems: repointFlagOf(ctx, raw) };
    },
    run(ctx, data, a, index) {
      const src = tree.find(data.data, a.id);
      if (!src) throw new Error('源节点不存在: ' + a.id);
      const parentNode = tree.find(data.data, a.parent);
      if (!parentNode) throw new Error('父节点不存在: ' + a.parent);
      const used = new Set(tree.flatten(data.data).map((n) => n.id));
      let seq = 0;
      // 新 id 由 `(源 id, 本条 op 的序号, 树内序号)` 决定 ⇒ **可复现**（同一份 ops 重跑得同一份数据）
      const mint = () => {
        let c;
        do { c = a.id + '-c' + (index + 1) + (seq++ ? '-' + seq : ''); } while (used.has(c));
        used.add(c);
        return c;
      };
      // 条目 id 也要换新（全项目唯一，§5.1）；`index + 1` 让它**可复现**（同上游 id 的写法）
      const usedItems = projectItemIds(data.data);
      let itemSeq = 0;
      const mintItem = (base) => {
        let c;
        do { c = base + '-c' + (index + 1) + (itemSeq++ ? '-' + itemSeq : ''); } while (usedItems.has(c));
        usedItems.add(c);
        return c;
      };
      // ⚠️ 与 `clone` 命令**同一份**实现（模块级 `cloneNode`）：这里原先另写了一份手挑字段的
      //     深拷贝，同样漏 `items` / `detailMode` / `localPath` / `origin` —— `apply` 的 clone op
      //     也会静默抹掉整层条目。两处必须共用一个实现，否则总有一处会漂。
      const copy = cloneNode(src, mint, a.deep, mintItem);
      /* 条目级边：与命令面**同一对函数**（`planItemEdges` / `repointRefusal`），**不在这里另写一份** ✗：
       *   · 默认档（不给 repointItems）⇒ **引用语义**：边逐字仍指原物，一个字节都不动
       *     （`apply` 的回显面是"逐条 op 回执"，本就不给条目级边的清单 —— 与命令面一致）；
       *   · `repointItems: true` ⇒ 改指**副本自己那份新条目**的同序号条目（两端一起换）；
       *   · 对不上 ⇒ **在这里抛**：`apply` 的 `ctx.mutate` 会把**整份 ops 拒绝、盘上零改动**，
       *     与别的 op 的执行期失败（如 move 的"移动到自己子树"）**同一形状** ✓ ——
       *     绝不"做一半"、也绝不按序号猜一个位置对齐上去（猜错等于把边指到另一条条目上，回显还说成功）。 */
      const plan = planItemEdges(pairSubtree(src, copy, []), ctx.projectName);
      if (a.repointItems && plan.unmatched.length) {
        // ⚠️ 报文**不重复 ops 的下标**（与 `move` 的执行期失败同一形状）—— 下标由 `apply` 自己
        //    在 `--dry-run`/执行期报错里加（"第 N 条操作会失败：clone op（源 …）：…"）。
        throw new Error('clone op（源 ' + a.id + '）：' + repointRefusal(plan.unmatched, a.id));
      }
      if (a.repointItems) plan.edges.forEach((e) => { e.link.id = e.toNode; e.link.item = e.to; });
      parentNode.children = (parentNode.children || []).concat(copy);
      a._newId = copy.id;
      a._repointed = a.repointItems ? plan.edges.length : 0;
      return data;
    },
    summary(a) { return '复制 ' + a.id + ' → ' + a.parent + '（新 id ' + a._newId + '）'
      + (a._repointed
        ? '，并把 ' + a._repointed + ' 条条目级链接改指副本自己的条目（**语义改变**）'
        : ''); }
  },

  'assoc-add': {
    v(ctx, raw) {
      if (raw.members === undefined) ctx.error('缺少 members（如 "a,b" 或 ["a","b"]；跨项目写 项目/节点id）');
      const parsed = assoc.parseMembers(raw.members, ctx.projectName);
      if (!parsed.ok) ctx.error(parsed.error);
      parsed.members.forEach((m) => {
        const r = nodeExistsIn(ctx, m.project, m.id);
        if (!r.ok) ctx.error(r.reason);
      });
      const id = raw.id === undefined ? null : String(raw.id);
      if (id) { const bad = checkAssocId(id); if (bad) ctx.error(bad); }
      return {
        members: parsed.members, id: id, title: raw.title, note: noteOf(ctx, raw),
        force: !!raw.force
      };
    },
    run(ctx, data, a) {
      if (!Array.isArray(data.assoc)) data.assoc = [];
      const candidate = { members: a.members };
      if (a.title !== undefined) candidate.title = a.title;
      if (a.note !== undefined) candidate.note = a.note;
      const key = assocKeyOf(candidate);
      const hit = data.assoc.find((x) => x && assocKeyOf(x) === key);
      if (hit && !a.force) throw new Error('已存在成员/标题/正文完全相同的关联笔记 ' + hit.id
        + ' —— 要么改那一条（assoc-edit），要么给这条 op 加 "force": true');
      const id = a.id || assoc.genId(data.assoc);
      if (data.assoc.some((x) => x && x.id === id)) throw new Error('关联 id 已存在: ' + id);
      const item = { id: id, members: a.members };
      if (candidate.title !== undefined) item.title = candidate.title;
      if (candidate.note !== undefined) item.note = candidate.note;
      data.assoc.push(item);
      a._id = id;
      return data;
    },
    summary(a) { return '新增关联 ' + a._id + '（' + a.members.length + ' 个成员）'; }
  },

  'assoc-edit': {
    v(ctx, raw, sim) {
      if (!raw.id) ctx.error('缺少 id（改哪一篇关联）');
      const any = raw.title !== undefined || raw.members !== undefined
        || raw.note !== undefined || raw.noteMd !== undefined || raw.clearNote;
      if (!any) ctx.error('什么也没改（可用字段：title / members / note / noteMd / clearNote）');
      let members;
      if (raw.members !== undefined) {
        const parsed = assoc.parseMembers(raw.members, ctx.projectName);
        if (!parsed.ok) ctx.error(parsed.error);
        // 改成员要能引用**这条 op 之前刚建出来的**节点 ⇒ 用模拟树判存在性
        // （列表里没有它，但树里可能有）
        parsed.members.forEach((m) => {
          if (m.project !== ctx.projectName) {
            const r = nodeExistsIn(ctx, m.project, m.id);
            if (!r.ok) ctx.error(r.reason);
          } else if (!tree.find(sim, m.id)) {
            ctx.error('节点不存在: ' + m.project + '/' + m.id);
          }
        });
        members = parsed.members;
      }
      return {
        id: String(raw.id), title: raw.title, members: members,
        note: noteOf(ctx, raw), clearNote: !!raw.clearNote
      };
    },
    run(ctx, data, a) {
      const list = Array.isArray(data.assoc) ? data.assoc : [];
      const item = list.find((x) => x && x.id === a.id);
      if (!item) throw new Error('关联不存在: ' + a.id);
      const changed = [];
      if (a.title !== undefined) { item.title = a.title; changed.push('title'); }
      if (a.members !== undefined) { item.members = a.members; changed.push('members'); }
      if (a.clearNote && item.note !== undefined) { delete item.note; changed.push('-note'); }
      if (a.note !== undefined) { item.note = a.note; changed.push('note'); }
      a._changed = changed;
      return data;
    },
    summary(a) { return '改写关联 ' + a.id + '：' + a._changed.join(' '); }
  }
};

/**
 * `apply <项目> --ops-file ops.json [--dry-run]`
 *
 * 事务性由两件事共同保证（**双层**，不是一层）：
 *   ① 全部 op **先逐条预检**（参数形状 / 成员是否存在 / 引用的项目能不能读）——
 *      任何一条不合法就**在写盘之前**返回，因而盘上零改动；
 *   ② 执行阶段在**一份深拷贝**上做，全部成功才把结果交回 `ctx.mutate` ⇒ 即便执行期
 *      出了预检看不出的事（如"移动到自己子树"要看树才知道），原数据对象也**没被碰过**，
 *      抛错即整体不动。日志只有一条（一个 `ctx.mutate` = 一次写盘 = 一个 rev）。
 */
function apply(ctx) {
  // ---- F0 冻结的接口纪律：**写盘前**要做任何盘面动作（读 ops 文件、预读项目、看别的项目）之前
  //      先过幂等守卫 —— 命中时连那些读都不做（省掉真正的外部成本），且行为与别的写命令一致。
  //      `ctx.mutate` / `ctx.write` 里还会各调一次 replayCheck（同一次调用只判一次，见那里的守卫）----
  ctx.replayCheck();
  if (!ctx.projectName) ctx.error('用法: apply <项目> --ops-file ops.json [--dry-run] [--idem 键]');
  const rf = readOpsFile(ctx);
  const pre = ctx.read();                     // 预读：项目不存在在这里就响亮报；预检也要读树/读成员
  // ⚠️ `pre.data` 是**整个项目对象**（`{meta, format, data}`），要传给预检的是**根节点** `pre.data.data`
  //    —— 传错这一层的形态很隐蔽：模拟树变成一个"id 为 undefined 的空根"，于是批里**每一条** edit
  //    都被判「节点不存在」（实测踩到过；报错看起来像数据真的缺节点，实则是调用方少写一层）。
  const checked = precheckOps(ctx, rf.ops, pre.data && pre.data.data);
  if (checked.error) {
    ctx.error('ops 文件里' + checked.error + '（文件：' + rf.file + '）——**整体未执行**，盘上零改动。');
  }
  const prepared = checked.prepared;

  /* ---------- --dry-run：只预览（连 mutate 都不进） ---------- */
  if (ctx.dryRun) {
    ctx.out('（--dry-run：只预览，**没有写盘** ✓）');
    const work = cloneJson(pre.data);
    prepared.forEach((p) => {
      try {
        p.def.run(ctx, work, p.args, p.index);
        ctx.out('  [' + (p.index + 1) + '/' + prepared.length + '] 将要 ' + p.def.summary(p.args));
      } catch (e) {
        ctx.out('  [' + (p.index + 1) + '/' + prepared.length + '] ✗ 第 ' + (p.index + 1)
          + ' 条操作会失败：' + ((e && e.message) || e));
      }
    });
    ctx.out('共 ' + prepared.length + ' 条操作；--dry-run 未写盘。去掉 --dry-run 才会真的应用。');
    ctx.setIdemResult('apply --dry-run：' + prepared.length + ' 条操作（未写盘）');
    return;
  }

  /* ---------- 执行：深拷贝上跑完，全成才交给 mutate（一次原子写） ---------- */
  let results = null;
  const line = 'apply 完成：' + prepared.length + ' 条操作在**一次事务**里应用（一个 rev、一条日志），'
    + '全部成功、没有跳过';
  // 幂等重放时原样复述这一行（逐条回执太长，日志是**有界产物**；回执在首次执行的 stdout 里，
  // 由 cli/main.js 的 dispatch 一并记进 `idem` 那条日志的 `out`）。
  // ⚠️ 必须在 `ctx.mutate` **之前**声明 —— 写盘那一刻要读它（写后才声明就永远是空的，实测踩到过）。
  ctx.setIdemResult(line);
  ctx.mutate((data) => {
    const work = cloneJson(data);
    results = prepared.map((p) => {
      p.def.run(ctx, work, p.args, p.index);          // 抛错 ⇒ 整体不动（work 被丢弃，原 data 未被碰）
      return { index: p.index, op: p.op, status: 'applied', detail: p.def.summary(p.args) };
    });
    // 把改好的**数据面**搬回原对象（只动 data.data，meta 保持原样 —— 与各命令的粒度一致）
    data.data = work.data;
    return data;
  });

  results.forEach((r) => {
    ctx.out('  [' + (r.index + 1) + '/' + results.length + '] 已应用 ' + r.op + '：' + r.detail);
  });
  ctx.out(line);
}

/** 深拷贝（项目数据保证是纯 JSON，见 docs/DATA-FORMAT.md §1） */
function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }

/**
 * `apply` 的 clone op 里"要不要重指向条目级边"这**一个**开关的**唯一解析处**。
 *
 * 两种拼写都收（**输入别名**，归一之后判定与执行只有一份 —— 就是 `clone` 命令用的那对
 * `planItemEdges` / `repointRefusal`，绝不在这里另写一份重指向逻辑 ✗）：
 *   · `repointItems`  —— 规范写法：ops 的字段名与**命令选项键**一一对应（camelCase），
 *                        与同表里的 `detailMd` / `localPath` / `clearDetail` 同一套；
 *   · `repoint_items` —— snake_case 别名（照 MCP 参数名写的调用方会顺手这么写）。
 * 两个都给且**冲突** ⇒ 响亮拒绝（同一件事两种说法不一致时，选哪个都是猜 ✗）。
 * 值必须是**布尔**：写成 `"true"` 这种字符串会让"要不要改语义"变成一个看不懂的开关。
 */
function repointFlagOf(ctx, raw) {
  const a = raw.repointItems;
  const b = raw.repoint_items;
  if (a !== undefined && b !== undefined && !!a !== !!b) {
    ctx.error('repointItems 与 repoint_items 同时给了且**不一致**（' + JSON.stringify(a) + ' / '
      + JSON.stringify(b) + '）：它们指的是同一个开关，只写一个（或写成同一个值）');
  }
  const v = (a !== undefined) ? a : b;
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') {
    ctx.error('repointItems 必须是布尔（收到 ' + JSON.stringify(v) + '）—— 它是"要不要把副本上的'
      + '条目级链接改指副本自己那份条目"的开关（**语义改变**），不是值');
  }
  return v;
}
