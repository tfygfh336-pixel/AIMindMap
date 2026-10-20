/* ============================================================
 * src/draft-map.js — 草稿图（临时导图窗口）的纯函数（UMD）
 * ------------------------------------------------------------
 * 功能代号 `DM`「草稿图」· 台账 `W11`（规格 = `projects/卖点讨论` 的 `bl-3-3-8` 与 `bl-3-3-8-1` 的 a–e 决议）
 * 定题：`.review/20261020-W11-temp-map/00-定题.md`
 *
 * 这个模块只做**从"一棵AI/人给的树"到"四样东西"**的换算，四样东西都有明确的消费者：
 *   · `normalize`    → 形状校验 + 规范化（**越界就响亮拒绝**，绝不静默截断）
 *                      消费者：`main.js` 的 createDraftWindow（开窗前）+ CLI（下命令前）
 *   · `canonical`    → 内容的规范化文本 ⇒ 指纹的**输入**（a–e 的 `d`：同一份内容的更新要更新到原来那张窗）
 *                      消费者：`main.js` 的 fingerprintOf（指纹本身在 main.js 用 sha256 算，本模块不引 node 内置）
 *   · `toOps`        → `apply --ops-file` 的 ops 数组（**一次原子写**的全部内容）
 *                      消费者：`main.js` 的并入流程（经 CLI `apply`，不新开写盘路）
 *   · `toMarkdown` / `toJsMind` → 导出 md / 页面渲染数据
 *                      消费者：`main.js` 的导出、`renderer/draft-map.js` 的渲染
 *
 * 为什么是 `src/` 而不是写在渲染层（与 `src/sidebar-context.js` 立下的先例同一条理由）：
 * `renderer/*.js` 是 IIFE，**node 里 require 不了** ⇒ 形状校验与 ops 生成就会变成**没有单测的路径**。
 * 放这里则"主进程"与"单测"拿到的是**同一份**实现（`renderer/draft-map.js` 也 `<script>` 进来共用）。
 *
 * 纯函数纪律：零 I/O、零 DOM、不读全局、不调 Date/Math.random
 * ⇒ 同一份输入永远得同一份输出（`toOps` 的 id 是**决定性**的，这是"重启后仍能挡住重复并入"的前提）。
 *
 * 草稿**能带什么**（写死，别悄悄扩 —— 理由见定题 §2 的表）：
 *   带：`topic` / `children` / `detail`
 *   不带：`images` / `files` / `tags` / `links` / `items` / `qa` / `localPath`
 *   为什么：前两个要落进 `assets/`、`attachments/`（草稿不落盘 ⇒ 带了就是断链）；
 *   后五个是与**家项目**相关的语义（链接指向别的项目、条目属于这个节点、标签要进词表）——
 *   草稿没有家项目，带了就是在草稿里**编造关系**。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./convert.js'));
  else root.MMDraft = factory(root.MMConvert);
})(typeof self !== 'undefined' ? self : this, function (convert) {
  'use strict';

  /* ---------------- 上限（越界 = 拒绝，不是截断） ----------------
   * 为什么要有上限，而不是"多大都收"：
   *   ① 草稿窗是给人**看一眼**的窗口 —— 上千节点的树那个窗口里什么也看不清，
   *      而"看不清"会诱使人直接点并入 ⇒ 反而害了主图；
   *   ② 一次并入 = 一次 `apply` 事务，ops 体积随节点数线性增长，**没有上界**就是给 CLI 留了一个
   *      可以被一份 JSON 撑爆的入口。
   * 上界取值的依据：本工程实际笔记里最大的单棵树是 `comnet`（889 个节点）—— 那是**整本书**。
   * 一份 AI 输出要"先看一眼"，一个分支几十到上百节点是正常档，500 已经是很宽松的上限。
   * ⚠️ 这两条上界**同时**是两条判据：越界必须点名拒绝（单测 `tests/draft-map.test.js` 钉着）。 */
  const MAX_NODES = 500;
  const MAX_DEPTH = 12;

  /** 只留契约允许的三个字段（`children` 单独走）；其余一律丢弃，并**记账**让调用方能如实报"丢了什么" */
  const KEEP = ['topic', 'detail'];

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  /**
   * 形状校验 + 规范化。
   *
   * 规范化做三件事（都是**必要**的，不是顺手）：
   *   ① `topic` 去首尾空白、压掉换行（jsMind 的节点标题是单行）；
   *   ② `detail` 原样保留（HTML 片段，渲染走 `renderer/sanitize.js`；本模块**不消毒**，
   *      因为草稿不渲染进主图、并入后由 CLI 与渲染层各自把关）；
   *   ③ **id 一律重编**：按前序（先父后子）给 `d0`/`d1`/… 。
   *      为什么不沿用调用方给的 id：草稿是**临时对象**，id 不承担任何跨会话语义；
   *      重编能一次消掉"重名 id""id 带怪字符""id 与主图撞车"三类问题（三类都会在并入时炸）。
   *
   * @param {*} input 调用方给的树（形如 `{topic, detail?, children?}`）
   * @returns {{ok:boolean, tree:object|null, errors:string[], stats:object, dropped:string[]}}
   *   `ok:false` ⇒ `tree` 为 `null`，`errors` 逐条点名（**调用方必须把它原样报出去**，
   *   不许吞成"草稿打不开"这种不给原因的失败）。
   */
  function normalize(input) {
    const errors = [];
    const dropped = [];
    const stats = { nodes: 0, depth: 0, leaves: 0 };

    if (!isObj(input)) {
      return { ok: false, tree: null, errors: ['草稿必须是一个对象（形如 {topic:"根", children:[…]}），收到 ' + typeOf(input)], stats: stats, dropped: dropped };
    }
    if (input.id !== undefined) dropped.push('id');
    Object.keys(input).forEach((k) => {
      if (KEEP.indexOf(k) < 0 && k !== 'children') dropped.push(k);
    });

    /** 前序重编 + 递归校验（深度/条数都现场累计，超了立刻停 —— 别把整棵巨树先走完再报错） */
    let seq = 0;
    function walk(node, depth, pathText) {
      if (stats.nodes >= MAX_NODES) {
        if (errors.indexOf('节点数超过上限 ' + MAX_NODES) < 0) errors.push('节点数超过上限 ' + MAX_NODES);
        return null;
      }
      if (!isObj(node)) { errors.push(pathText + ' 不是一个对象（收到 ' + typeOf(node) + '）'); return null; }
      if (depth > MAX_DEPTH) {
        const msg = '深度超过上限 ' + MAX_DEPTH + '（在 ' + pathText + '）';
        if (errors.indexOf(msg) < 0) errors.push(msg);
        return null;
      }
      const topic = node.topic === undefined || node.topic === null ? '' : String(node.topic);
      const flat = topic.replace(/[\r\n\t]+/g, ' ').trim();
      if (!flat) errors.push(pathText + ' 的 topic 是空的（草稿的每个节点都要有标题）');
      const out = { id: 'd' + seq, topic: flat, children: [] };
      seq += 1;
      stats.nodes += 1;
      if (depth > stats.depth) stats.depth = depth;
      Object.keys(node).forEach((k) => {
        if (KEEP.indexOf(k) < 0 && k !== 'children' && dropped.indexOf(k) < 0) dropped.push(k);
      });
      const detail = node.detail === undefined || node.detail === null ? '' : String(node.detail);
      if (detail.trim()) out.detail = detail;
      const kids = Array.isArray(node.children) ? node.children : [];
      if (node.children !== undefined && !Array.isArray(node.children)) {
        errors.push(pathText + ' 的 children 不是数组（收到 ' + typeOf(node.children) + '）');
      }
      for (let i = 0; i < kids.length; i++) {
        const c = walk(kids[i], depth + 1, (flat || pathText) + ' › 第 ' + (i + 1) + ' 个子节点');
        if (c) out.children.push(c);
      }
      if (!kids.length) stats.leaves += 1;
      return out;
    }

    const tree = walk(input, 1, '根节点');
    if (errors.length) return { ok: false, tree: null, errors: errors, stats: stats, dropped: dropped };
    return { ok: true, tree: tree, errors: [], stats: stats, dropped: dropped };
  }

  function typeOf(x) {
    if (x === null) return 'null';
    if (Array.isArray(x)) return '数组';
    return typeof x === 'object' ? '对象' : typeof x;
  }

  /**
   * 内容的**规范化文本**（指纹的输入）。
   *
   * 三条性质，逐条都是判据（`tests/draft-map.test.js` 钉着）：
   *   ① **忽略 id**：同一份内容换个 id 生成方式仍是"同一份内容"（a–e 的 `d` 要的正是这个）；
   *   ② **字段顺序无关**：只按 `topic` → `detail` → 子节点序 拼，不 `JSON.stringify` 原对象
   *      （后者会让 `{topic,detail}` 与 `{detail,topic}` 得出不同指纹 ⇒ 同一份内容被当成两份）；
   *   ③ **省略空 detail**：`detail:''` 与没有 detail 是同一份内容。
   *
   * @param {object} tree `normalize()` 出来的树（也接受形状合法的原始树）
   * @returns {string}
   */
  function canonical(tree) {
    if (!isObj(tree)) return '';
    const parts = [];
    (function walk(n, depth) {
      if (!isObj(n)) return;
      const topic = n.topic === undefined || n.topic === null ? '' : String(n.topic).replace(/[\r\n\t]+/g, ' ').trim();
      const detail = n.detail === undefined || n.detail === null ? '' : String(n.detail).trim();
      /* 用长度前缀而不是分隔符拼接：任何分隔符都可能出现在标题里（`|`、`\u0000` 都可能），
       * 长度前缀是唯一不会撞的写法。深度也进串 —— `a>b` 与 `a` 带子 `b` 不是同一棵树。 */
      parts.push(depth + ':' + topic.length + ':' + topic + (detail ? '|' + detail.length + ':' + detail : ''));
      (n.children || []).forEach((c) => walk(c, depth + 1));
    })(tree, 1);
    return parts.join('\n');
  }

  /**
   * 草稿 ⇒ `apply --ops-file` 的 ops 数组（**前序**：先父后子 —— `apply` 的预检用一棵模拟树，
   * 子节点引用父 id 时父必须已经在本批里出现过）。
   *
   * id 的生成规则：`<idPrefix>-<前序序号>`。
   *   · **决定性**（不含时间/随机）⇒ 同一份草稿重算得同一批 id ⇒ 重启后重复并入会在
   *     `apply` 的预检处撞上"新增的 id 已被占用"⇒ **整份拒绝、盘上零改动**（幂等的第二层，见定题 §5）；
   *   · `idPrefix` 由调用方给（`main.js` 用指纹的前 8 位）⇒ "同一份内容"与"不同内容"的 id 空间天然分开。
   *
   * @param {object} tree `normalize()` 出来的树
   * @param {{parent:string, idPrefix:string}} opts `parent` = 落点（主图里的节点 id 或 `'root'`）
   * @returns {Array<object>} ops（空数组 = 没东西可并，调用方应拒绝而不是写空事务）
   */
  function toOps(tree, opts) {
    const o = opts || {};
    const parent = o.parent === undefined || o.parent === null || o.parent === '' ? '' : String(o.parent);
    const prefix = o.idPrefix === undefined || o.idPrefix === null ? 'dm' : String(o.idPrefix);
    if (!parent) throw new Error('toOps 需要给出落点 parent（主图里的节点 id，或 "root"）');
    const ops = [];
    let seq = 0;
    (function walk(n, parentId) {
      if (!isObj(n)) return;
      const id = prefix + '-' + seq;
      seq += 1;
      const op = { op: 'add', parent: parentId, id: id, topic: String(n.topic === undefined || n.topic === null ? '' : n.topic) };
      if (n.detail) op.detail = String(n.detail);   // apply 的 add op 收 `detail`（HTML 原样）
      ops.push(op);
      (n.children || []).forEach((c) => walk(c, id));
    })(tree, parent);
    return ops;
  }

  /**
   * 草稿 ⇒ Markdown 嵌套列表（a–e 的 `c`「导出 md，复用现成序列化」）。
   * detail 那一半走 `src/convert.js` 的 `detailToMarkdown` —— **不自己写第二份 HTML→Markdown**
   * （那是本工程明令禁止的"同一逻辑两处表达"）。
   *
   * @param {object} tree
   * @returns {string} 以换行结尾；空草稿返回说明性一行（不返回空串，免得导出出个 0 字节文件还看不出为什么）
   */
  function toMarkdown(tree) {
    if (!isObj(tree)) return '（草稿是空的）\n';
    const lines = [];
    (function walk(n, depth) {
      if (!isObj(n)) return;
      const pad = new Array(depth).join('  ');
      const topic = String(n.topic === undefined || n.topic === null ? '' : n.topic).replace(/[\r\n]+/g, ' ').trim();
      lines.push(pad + '- ' + (topic || '(无标题)'));
      if (n.detail) {
        const md = String(convert && convert.detailToMarkdown ? convert.detailToMarkdown(n.detail) : n.detail).replace(/\s+$/, '');
        if (md) {
          lines.push('');
          md.split(/\r?\n/).forEach((l) => lines.push(l ? pad + '  ' + l : ''));
          lines.push('');
        }
      }
      (n.children || []).forEach((c) => walk(c, depth + 1));
    })(tree, 1);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  /**
   * 草稿 ⇒ jsMind 的 node_tree 数据（`renderer/draft-map.js` 只用这一个函数建视图）。
   * 形状 `{meta:{name}, format:'node_tree', data:{id,topic,children}}` —— 与主图 `renderer/app-core.js`
   * 给 `MM.adapter.loadTree` 的形态一致（同一个库、同一套约定）。
   */
  function toJsMind(tree, name) {
    function conv(n) {
      const out = { id: String(n.id), topic: String(n.topic === undefined || n.topic === null ? '' : n.topic), children: [] };
      (n.children || []).forEach((c) => out.children.push(conv(c)));
      return out;
    }
    return {
      meta: { name: name ? String(name) : '草稿图' },
      format: 'node_tree',
      data: isObj(tree) ? conv(tree) : { id: 'd0', topic: '（空草稿）', children: [] }
    };
  }

  return {
    MAX_NODES: MAX_NODES, MAX_DEPTH: MAX_DEPTH,
    normalize: normalize, canonical: canonical, toOps: toOps,
    toMarkdown: toMarkdown, toJsMind: toJsMind
  };
});
