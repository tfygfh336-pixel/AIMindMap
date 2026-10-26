/* ============================================================
 * src/concurrency.js — 并发编辑的"可安全重放"核心（纯逻辑，无 I/O）
 * ------------------------------------------------------------
 * 存在的唯一理由：`src/data-store.js` 的版本闸门只会**拒绝**并发写，而拒绝之后
 * 调用方只有"重读再整树写回"一条路 —— 那会把对方刚写的那部分**静默覆盖掉**。
 * 于是多路同时编辑的现状是：要么被拒（工作白做），要么把它改成"最后写者赢"（静默丢）。
 * 本模块给"拒绝"补一条**有安全论证的出路**：
 *
 *   · 两路改动的**对象集合不相交** ⇒ 允许在新底座上重放（自动合并，双方改动都保留）；
 *   · 相交 ⇒ 拒绝，并**指名叫出冲突对象**（`node:<id>` / `children:<父id>` / `assoc:<id>` / `meta`）。
 *
 * 安全论证（本模块的全部价值就在这里，**别弱化它**）：
 *   要写入的是 `fn(cur)`；它相对 `cur` 的改动集合若与"对方相对 base 的改动集合"不相交，
 *   则这次写入**不会覆盖对方的任何改动** —— 因为 `fn(cur)` 是在 `cur`（已含对方改动）之上构造的。
 *   ⚠️ 判据必须用**重放后实测的差集**，不是"重放前的预测"：`fn` 可能依赖数据内容
 *   （例如"父节点不存在就报错"），两次调用的改动集合未必相同。故本实现**只写它证明过的那一份数据**，
 *   绝不"证明一份、写另一份"。
 *   ⚠️ 这也是为什么 `fn` 必须是**可重复执行的**：非幂等的动作（依赖当前时间、生成随机 id 等）
 *   要么改写成幂等，要么显式声明 `replayable:false`（那样冲突时直接拒绝，不重放）。
 *
 * 指纹粒度（与 `docs/DATA-FORMAT.md` 的结构对齐，不是拍脑袋）：
 *   `node:<id>`     该节点**自身字段**（topic/tags/images/files/links/background…，**不含 children**；
 *                   `items` 一律排除，条目化节点的 `detail` 也排除 —— 见下）
 *   `children:<id>` 该节点的**子 id 列表**（兄弟顺序有意义 ⇒ 顺序算改动）
 *   `items:<id>`    该节点**条目 id 的有序列表**（顺序算改动；增删条目在这里可见）
 *   `item:<节点id>#<条目id>`  **单个条目**（按 id，不看数组顺序）
 *   `assoc:<id>`    顶层关联笔记的**单个条目**（按 id，不看数组顺序）
 *   `meta` / `format` 项目级字段
 *   ⇒ 两个会话分别往**不同父节点**加内容、或改**不同节点**的详情，天然不相交 ⇒ 自动合并；
 *     同一父节点下同时加子节点（顺序会歧义）或改同一节点的同一字段 ⇒ 相交 ⇒ 指名拒绝。
 *
 * ## 条目层（v3）为什么必须有独立键（`docs/ITEM-MODEL.md` §8，**冻结**）
 * 把 `items` 留在 `node:<id>` 里，"两个会话各改**同一节点的不同条目**"就会被判成同一个对象冲突 ⇒
 * 自动合并失效 —— 而那正是"多会话同时补条目"最常见的形态。故：
 *   · `node:<id>` 排除 `items`；**条目化节点（有 `items`）上还要排除 `detail`** ——
 *     `detail` 是"`items` 的落盘派生缓存"，由门禁保证 `detail === renderDetail(items)`；
 *     把它算进指纹会让"同一节点的不同条目"永远相撞。
 *   · `item:<节点id>#<条目id>` 的**节点 id 必须进键**：条目移动（`item-move`）是"键改名 + 旧键消失"，
 *     只用条目 id 会让移动**完全不可见**（条目自身内容一个字节都没变）。
 *
 * ⚠️ **安全论证（别弱化）**：上面两条排除成立，只因为"有 `items` ⇒ `detail === renderDetail(items)`"
 * 是**门禁保证的不变量**（`src/schema.js` 判红、`render-detail` 是唯一修法）。若某天把那条门禁去掉，
 * 这两个排除就变成**静默丢数据的通道**（对方改的 detail 会被无声丢掉）。改这里前先看门禁还在不在。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('crypto'), require('./item-model.js'));
  } else {
    // 浏览器侧：条目层的**唯一渲染实现**由 `src/item-model.js` 提供（UMD 全局 `MMItemModel`）。
    // 没加载它时**不是**"降级合并"，而是合并条目化节点时**响亮拒绝**（见 renderItemsOf）——
    // 宁可当场失败，也不写一份 `detail` 与 `items` 不一致的数据（那会被 G2 判红，且是静默变质）。
    root.MMConcurrency = factory(null, root.MMItemModel || null);
  }
})(typeof self !== 'undefined' ? self : this, function (crypto, itemModel) {
  'use strict';

  /** data-store 抛出的版本冲突错误码；判定**只认错误码，不认错误文本**（文本会漂） */
  const VERSION_CONFLICT = 'VERSION_CONFLICT';
  /** 重放到最新版仍与他人改动相交时抛出的错误码 */
  const REPLAY_CONFLICT = 'REPLAY_CONFLICT';

  function hash(x) {
    const s = JSON.stringify(x === undefined ? null : x);
    if (!crypto) return 'n' + s.length;
    return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
  }

  /** JSON 深拷贝：数据契约保证是纯 JSON（见 docs/DATA-FORMAT.md §1） */
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /** 这个节点条目化了吗（**含空数组**都算：ITEM-MODEL §2 的判定规则） */
  function isItemized(node) { return !!node && Array.isArray(node.items); }

  /**
   * 节点自身字段的指纹。
   * **排除三样**（各有理由，别合并成"排除 children/detail/items"一句话）：
   *   · `children` —— 结构另由 `children:<id>` 键承载；
   *   · `items`    —— 另由 `items:<id>` / `item:<id>#<条目>` 键承载；
   *   · `detail`   —— **仅当节点条目化时**（它是 items 的落盘派生缓存，见文件头"安全论证"）。
   */
  function nodeOwnHash(node) {
    const o = {};
    const itemized = isItemized(node);
    Object.keys(node || {}).forEach((k) => {
      if (k === 'children' || k === 'items') return;
      if (k === 'detail' && itemized) return;
      o[k] = node[k];
    });
    return hash(o);
  }

  /** 逐节点/字段指纹表（**派生值，不落盘** —— 落盘就要维护它不过期） */
  function fingerprint(data) {
    const fp = {};
    const d = data || {};
    fp.meta = hash(d.meta);
    fp.format = hash(d.format);
    /* 图附加层（`graph`，`docs/DATA-FORMAT.md` §1.6）：**项目级**一层，与 `data` 平级、不在节点树里。
     * ⚠️ 它必须进指纹，否则「两边的图不同」这件事**根本不构成冲突** —— 而 `mergeTrees` 的输出是
     * `clone(theirs)`，于是我的图会被**静默丢掉**（MS1 实测：当时能"侥幸保住"只因为对方那侧没动它，
     * 不是判据在守）。`undefined` 时不建键：这样"我删掉了整层图"与"我没有意见"能分辨
     * （与下面逐条 `assoc:` 键同形）。 */
    if (d.graph !== undefined) fp.graph = hash(d.graph);
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.id) {
        fp['node:' + node.id] = nodeOwnHash(node);
        fp['children:' + node.id] = hash((node.children || []).map((c) => c && c.id));
        // 条目层（ITEM-MODEL §8）：有序 id 表 + 逐条目（按 id，不看数组顺序）
        if (isItemized(node)) {
          fp['items:' + node.id] = hash(node.items.map((it) => it && it.id));
          node.items.forEach((it) => {
            if (it && it.id) fp['item:' + node.id + '#' + it.id] = hash(it);
          });
        }
      }
      (node.children || []).forEach(walk);
    })(d.data);
    (d.assoc || []).forEach((a) => { if (a && a.id) fp['assoc:' + a.id] = hash(a); });
    return fp;
  }

  /** 两份数据之间被改动的键集合（只出现/只消失的键也算改动） */
  function changedKeys(a, b) {
    const fa = fingerprint(a), fb = fingerprint(b);
    const keys = new Set(Object.keys(fa).concat(Object.keys(fb)));
    const out = new Set();
    keys.forEach((k) => { if (fa[k] !== fb[k]) out.add(k); });
    return out;
  }

  /** 相交即冲突；返回排序后的冲突键（**报错要指名对象**，别只说"有冲突"） */
  function intersection(mine, theirs) {
    const out = [];
    mine.forEach((k) => { if (theirs.has(k)) out.push(k); });
    return out.sort();
  }

  function conflictError(conflicts, baseVersion, curVersion) {
    const err = new Error('并发写入冲突：这些对象在你读取之后被其他写入者改过 —— '
      + conflicts.join('、')
      + '（你读到 ' + String(baseVersion).slice(0, 8) + '，盘上 ' + String(curVersion).slice(0, 8) + '）。'
      + '写入已中止，以免静默覆盖对方的改动。'
      + '处理办法：重新读取该项目（`read <项目> --json`），或只改别的对象后再试。');
    err.code = REPLAY_CONFLICT;
    err.conflicts = conflicts;
    return err;
  }

  /**
   * 读 → 改 → 写，并在**可证明安全**时自动重放到最新版。
   *
   * @param {{read: Function, write: Function}} io
   *        `read()` → `{ data, version }`；`write(data, { expectVersion })` → 冲突时抛 `code==='VERSION_CONFLICT'`
   * @param {(data:any)=>any} fn 改动函数：**纯函数、可重复执行**，返回改好的数据（不改原对象）
   * @param {{maxAttempts?:number, replayable?:boolean, onRetry?:Function}} [opts]
   *        `replayable:false` ⇒ 冲突时**不重放**，直接抛（给"不可重复执行"的动作用）
   * @returns {{data:any, attempts:number, merged:boolean}}
   * @throws 版本冲突且**不可安全重放**时：`code==='REPLAY_CONFLICT'`，带 `conflicts` 列表
   */
  function withReplay(io, fn, opts) {
    const o = opts || {};
    const max = Math.max(1, o.maxAttempts || 3);
    const replayable = o.replayable !== false;

    let base = io.read();
    let attempts = 1;
    let first = fn(clone(base.data));
    try {
      io.write(first, { expectVersion: base.version });
      return { data: first, attempts: attempts, merged: false };
    } catch (err) {
      if (!err || err.code !== VERSION_CONFLICT) throw err;
      if (!replayable) throw err;                       // 显式声明不可重放 ⇒ 原样拒绝
    }

    /* ---- 合并路径：证明"我的改动"与"对方的改动"不相交，再写 ---- */
    let lastConflicts = null;
    for (let i = 0; i < max - 1; i++) {
      attempts++;
      const cur = io.read();
      const theirs = changedKeys(base.data, cur.data);
      let next;
      try {
        next = fn(clone(cur.data));                     // ⚠️ 只调用一次，且**只写这一份**
      } catch (fnErr) {
        // 重放到最新版时失败：多为并发改动删掉了 `fn` 依赖的对象 ⇒ 把原因说清楚（报错即教程）
        const e = new Error('并发重放失败：把你的改动套用到最新版时出错（可能是并发改动动了它所依赖的对象）—— '
          + ((fnErr && fnErr.message) || String(fnErr)));
        e.code = REPLAY_CONFLICT;
        e.cause = fnErr;
        throw e;
      }
      const mine = changedKeys(cur.data, next);
      const inter = intersection(mine, theirs);
      if (inter.length) throw conflictError(inter, base.version, cur.version);
      try {
        io.write(next, { expectVersion: cur.version });
        return { data: next, attempts: attempts, merged: true };
      } catch (err2) {
        if (!err2 || err2.code !== VERSION_CONFLICT) throw err2;
        lastConflicts = changedKeys(cur.data, io.read().data);   // 第三位写者插队 ⇒ 再来一轮
        base = { data: cur.data, version: cur.version };
      }
    }
    const err = new Error('并发写入冲突：连续 ' + attempts + ' 次尝试都被其他写入者插队，'
      + '本次未写入（盘上内容未变）。竞争激烈时请稍后重试，或缩小改动范围。');
    err.code = REPLAY_CONFLICT;
    err.conflicts = [];
    err.lastTheirs = lastConflicts ? Array.from(lastConflicts).sort() : [];
    throw err;
  }

  /**
   * 把项目数据摊平成"按 id 取节点自身字段 / 按父取子 id 列表 / 按 id 取 assoc 条目 / 按节点取条目表"。
   * 三方合并要按 id 取用某一方的节点 —— 树是嵌套的，摊平后才能逐对象挑来源。
   *
   * 条目层（ITEM-MODEL §8）：`items` 是**按节点取条目表**（`Map<节点id, Map<条目id, 条目>>`），
   * `itemIds` 是**有序 id 表**（`Map<节点id, string[]>`）—— 顺序也要能逐方取用（顺序算改动）。
   * ⚠️ 表里存的是**原对象引用**（不拷贝）：摊平只用来"取用"，拷贝由调用方做（免得每方拷两遍）。
   */
  function flattenProject(data) {
    const nodes = new Map(), childIds = new Map(), assoc = new Map();
    const items = new Map(), itemIds = new Map();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.id) {
        const o = {};
        Object.keys(n).forEach((k) => { if (k !== 'children') o[k] = n[k]; });
        nodes.set(n.id, o);
        childIds.set(n.id, (n.children || []).map((c) => c && c.id));
        if (Array.isArray(n.items)) {
          const table = new Map();
          n.items.forEach((it) => { if (it && it.id) table.set(it.id, it); });
          items.set(n.id, table);
          itemIds.set(n.id, n.items.map((it) => it && it.id));
        }
      }
      (n.children || []).forEach(walk);
    })(data && data.data);
    ((data && data.assoc) || []).forEach((a) => { if (a && a.id) assoc.set(a.id, a); });
    return {
      nodes, childIds, assoc, items, itemIds,
      meta: data ? data.meta : undefined,
      format: data ? data.format : undefined,
      graph: data ? data.graph : undefined,   // 图附加层（项目级，整层取用；指纹键 `graph`）
      rootId: data && data.data ? data.data.id : null
    };
  }

  /** 条目的**可读名**：id + 一小段纯文本（报错要指名对象 —— 只给内部 id 人/调用方不认识） */
  function itemLabel(it, itemId) {
    if (!it || typeof it !== 'object') return String(itemId);
    const raw = (it.type === 'qa')
      ? String((it.qa && (it.qa.q || it.qa.a)) || '')
      : String(it.html == null ? '' : it.html);
    const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return String(itemId) + (text ? '：' + text : '');
  }

  /** 把指纹键翻译成人能读的对象名（报错要**指名叫对象**，不是只说"有冲突"） */
  function describeKeys(data, keys) {
    const F = flattenProject(data);
    const nodeName = (id) => { const n = F.nodes.get(id); return '节点「' + ((n && n.topic) || id) + '」'; };
    return keys.map((k) => {
      if (k === 'meta') return '项目元信息（meta）';
      if (k === 'format') return '数据格式标记（format）';
      if (k === 'graph') return '图附加层（graph：层带 / 容器 / 边 / 注释）';
      let m = /^node:(.+)$/.exec(k);
      if (m) { const n = F.nodes.get(m[1]); return '节点「' + ((n && n.topic) || m[1]) + '」'; }
      m = /^children:(.+)$/.exec(k);
      if (m) { const n = F.nodes.get(m[1]); return '节点「' + ((n && n.topic) || m[1]) + '」的子节点列表'; }
      m = /^items:(.+)$/.exec(k);
      if (m) return nodeName(m[1]) + '的条目顺序';
      m = /^item:([^#]+)#(.+)$/.exec(k);
      if (m) {
        const table = F.items.get(m[1]);
        const it = table ? table.get(m[2]) : null;
        return nodeName(m[1]) + '的条目「' + itemLabel(it, m[2]) + '」';
      }
      m = /^assoc:(.+)$/.exec(k);
      if (m) { const a = F.assoc.get(m[1]); return '关联笔记「' + ((a && a.title) || m[1]) + '」'; }
      return k;
    });
  }

  /**
   * 渲染层载荷的 **assoc 缺省规则**（唯一实现，`mergeTrees` 与差异预览共用）。
   *
   * ⚠️ 渲染层的载荷**不含 assoc**（`renderer/app-core.js` 的 `serializeTree()` 只在非空时才带）
   * ⇒ 缺这个键必须当作"界面没有意见"（从 base 继承），**不是**"界面把 assoc 删光了"。
   * 少了这一步，"界面保存"会被算成删掉全部关联笔记 —— 那正是本工程最重的损害类别。
   */
  function inheritAssoc(mine, base) {
    return (mine && mine.assoc === undefined && base && base.assoc !== undefined)
      ? Object.assign({}, mine, { assoc: base.assoc })
      : mine;
  }

  /* ---------------- 只读差异视图（v0.20「让 AI 的编辑看得见」） ----------------
   * 这一组**只读**：产出"某指纹键在某一方的值"与"两/三方的可读差异行"，
   * 一行都不写、一个对象都不改（唯一写盘出口仍是 `data-store.write` + `mergeTrees` 的结果）。
   * 用途只有一个：把"外部改了什么 / 我改了什么 / 撞在哪"变成界面上看得见的内容
   * （`renderer/app-actions.js` 的差异预览与冲突面板都从这里取内容 ⇒ 单一实现）。
   */

  /**
   * 某一方数据里，某个指纹键的**值**（不存在 → `undefined`）。
   * 摊平口径只走 `flattenProject`（与 `changedKeys`/`describeKeys` 同一份），不另写一套解析。
   */
  function snapshotOf(data, key) {
    const F = flattenProject(data);
    if (key === 'meta') return F.meta;
    if (key === 'format') return F.format;
    if (key === 'graph') return F.graph;
    let m = /^node:(.+)$/.exec(key);
    if (m) return F.nodes.get(m[1]);
    m = /^children:(.+)$/.exec(key);
    if (m) return F.childIds.get(m[1]);
    m = /^items:(.+)$/.exec(key);
    if (m) return F.itemIds.get(m[1]);
    m = /^item:([^#]+)#(.+)$/.exec(key);
    if (m) { const t = F.items.get(m[1]); return t ? t.get(m[2]) : undefined; }
    m = /^assoc:(.+)$/.exec(key);
    if (m) return F.assoc.get(m[1]);
    return undefined;
  }

  /**
   * **三方只读快照**（保存冲突时给渲染层看的内容）。
   * ⚠️ 只取 `keys` 点名的那些对象 —— **绝不把整棵树塞过去**（那是"预览"变成"第二份数据副本"）。
   * 返回纯 JSON（能过 IPC / 能落报告）：`{ base:{键:值}, mine:{…}, theirs:{…} }`。
   */
  function conflictSnapshots(base, mine, theirs, keys) {
    const mineN = inheritAssoc(mine, base);
    const out = { base: {}, mine: {}, theirs: {} };
    (keys || []).forEach((k) => {
      const b = snapshotOf(base, k), m = snapshotOf(mineN, k), t = snapshotOf(theirs, k);
      if (b !== undefined) out.base[k] = b;
      if (m !== undefined) out.mine[k] = m;
      if (t !== undefined) out.theirs[k] = t;
    });
    return out;
  }

  /** 值 → 可读文本。字符串原样（正文/标题这类本来就是文本）；其余走缩进 JSON。
   *  **有界**：超过 `maxChars` 截断，但**如实回报** `truncated:true`（静默截断 = 静默骗人 ✗） */
  function valueToText(value, maxChars) {
    const cap = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : 4000;
    if (value === undefined) return { text: '（这一侧没有这个对象）', truncated: false, missing: true };
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const s = String(raw === undefined ? '' : raw);
    if (s.length <= cap) return { text: s, truncated: false, missing: false };
    return { text: s.slice(0, cap) + '\n…（已截断，原长 ' + s.length + ' 字符）', truncated: true, missing: false };
  }

  /**
   * **差异行的唯一构造**（脏分支的「外部改动预览」与保存冲突面板共用）。
   *
   * @param {Array<{label:string, data?:object, values?:object}>} sides 两侧/三侧（顺序 = 面板上的左右顺序）。
   *   一侧二选一：给 `data`（整棵树，逐键现取）或给 `values`（**键→值**的表，来自
   *   `conflictSnapshots`——保存冲突那条路主进程只把冲突对象递过来，这里**不还原整棵树**）。
   * @param {string[]} keys  指纹键（来自 `changedKeys` / `intersection`，这里**不自己算差异**）
   * @param {{maxChars?:number, labels?:object}} [opts] `labels` = 主进程已给过对象名时用它（键→名）
   * @returns {Array<{key:string, label:string, sides:Array<{label:string, text:string, truncated:boolean, missing:boolean}>}>}
   *   命名只走 `describeKeys`（报错与面板**同一套对象名**，别在界面里另起一套）；
   *   某一侧没有这个对象时**如实说"这一侧没有"**，不拿空串冒充内容。
   */
  function diffRows(sides, keys, opts) {
    const o = opts || {};
    const list = Array.isArray(sides) ? sides.filter((s) => s && (s.data || s.values)) : [];
    const maxChars = o.maxChars;
    /** 某一侧、某个键的值（两条取用路径都只经 `snapshotOf` / `values`，不另写解析） */
    const valueOf = (s, k) => {
      if (s.values) return Object.prototype.hasOwnProperty.call(s.values, k) ? s.values[k] : undefined;
      return snapshotOf(s.data, k);
    };
    // 对象名：① 调用方给过就用它（保存冲突那条路主进程已算好）；② 否则取"真的有这个对象"的那一侧
    const labelOf = (k) => {
      if (o.labels && o.labels[k]) return o.labels[k];
      const withIt = list.filter((s) => valueOf(s, k) !== undefined);
      const picked = withIt.length ? withIt[withIt.length - 1] : list[list.length - 1];
      if (!picked || !picked.data) return k;
      const named = describeKeys(picked.data, [k]);
      return (named && named[0]) || k;
    };
    return (keys || []).map((k) => ({
      key: k,
      label: labelOf(k),
      sides: list.map((s) => {
        const v = valueToText(valueOf(s, k), maxChars);
        return { label: s.label, text: v.text, truncated: v.truncated, missing: v.missing };
      })
    }));
  }

  /**
   * **三方合并**（给 GUI 用：渲染层不能"重放用户操作"，只能把两棵树合起来）。
   *
   * 与 CLI 侧重放同一条前提：`base` = 界面读到的那一版，`mine` = 界面内存，`theirs` = 盘上最新。
   * 做法：摊平后**逐对象挑来源** —— 某对象只有一方改过就取那一方；两边都没改就都一样。
   *
   * @param {object} [opts] `{ onConflict: 'refuse' | 'theirs' }`（默认 `refuse`）
   *   `refuse`：相交即返回 `{ok:false}`，**不产生数据、不写盘**；
   *   `theirs`：相交的对象**取盘上那一版**（渲染层用它实现"用磁盘上的版本" —— 非冲突对象上
   *            用户的改动**仍然保留**，这正是本功能的意义）。
   * @returns `{ok:true, data, merged:true, conflicts, lostOn}` 或 `{ok:false, conflicts, detail}`
   */
  function mergeTrees(base, mine, theirs, opts) {
    const onConflict = (opts && opts.onConflict) || 'refuse';
    // ⚠️ 渲染层的载荷**不含 assoc** ⇒ 缺这个键当"界面没有意见"（规则与理由只有一处：
    //    `inheritAssoc` 的注释）。少了这一步，"界面保存"会被算成删掉全部关联笔记。
    const mineN = inheritAssoc(mine, base);
    const mineChanged = changedKeys(base, mineN);
    const theirsChanged = changedKeys(base, theirs);
    const conflicts = intersection(mineChanged, theirsChanged);
    if (conflicts.length && onConflict !== 'theirs') {
      return { ok: false, conflicts: conflicts, detail: describeKeys(theirs, conflicts) };
    }
    const conflictSet = new Set(conflicts);
    // 取用规则：我改过的键取"我的"；与对方撞上的键，在 `theirs` 模式下改取"对方的"
    const useMine = (k) => mineChanged.has(k) && !conflictSet.has(k);

    const Fb = flattenProject(base), Fm = flattenProject(mineN), Ft = flattenProject(theirs);
    const out = clone(theirs);

    if (useMine('meta')) out.meta = clone(mineN.meta);
    if (useMine('format')) out.format = clone(mineN.format);
    /* ---- 图附加层 `graph`（项目级一层，整层挑来源；不拆到层带/容器/边那一级）----
     * 为什么不拆细：`graph` 是一份**手写坐标的图文档**，层带与容器互相引用、边指向节点 id ——
     * 逐对象合并会造出"几何互不相容"的图（层带重叠、容器里的子项被挪走），而那类坏形态
     * 面板上看不出来、G2 却可能判红。整层挑来源的代价是"两边都动了图 ⇒ 判冲突"，
     * 而这正是本判据要的：**不许静默丢一边的图**（缺口成因见 `fingerprint` 里那段注释）。
     * `useMine('graph')` 为真只可能是"我改了、对方没改"（相交的键要么在 refuse 档已被拒绝，
     * 要么在 theirs 档里被 `conflictSet` 排除）—— 两种档位都由上面的 `conflicts` 决定。 */
    if (useMine('graph')) {
      if (mineN.graph === undefined) delete out.graph;   // 我删掉了整层 ⇒ 合并后也不该留
      else out.graph = clone(mineN.graph);
    }

    /* ---- assoc：逐条目（按 id，不看数组顺序） ---- */
    const outAssoc = [];
    ((theirs && theirs.assoc) || []).forEach((a) => {
      if (useMine('assoc:' + a.id)) {
        const m = Fm.assoc.get(a.id);
        if (m) outAssoc.push(clone(m));            // 我改了它 ⇒ 用我的；我删了它 ⇒ 不推
      } else {
        outAssoc.push(clone(a));                   // 没我什么事 ⇒ 保持盘上那份
      }
    });
    ((mineN && mineN.assoc) || []).forEach((a) => {
      if (!useMine('assoc:' + a.id)) return;
      if (Fb.assoc.has(a.id)) return;              // 改已有条目：上面已处理
      if (outAssoc.some((x) => x.id === a.id)) return;
      outAssoc.push(clone(a));                     // 我新增的
    });
    if (outAssoc.length) out.assoc = outAssoc; else delete out.assoc;

    /* ---- 节点树：逐节点挑"自身字段"、逐父挑"子 id 列表"，再按选定结构重建 ---- */
    const own = (id) => (useMine('node:' + id) ? Fm.nodes.get(id) : Ft.nodes.get(id));
    const kids = (id) => (useMine('children:' + id) ? Fm.childIds.get(id) : Ft.childIds.get(id));

    /**
     * **条目层：逐条目挑来源**（照 `assoc` 的先例），返回 `null` = 两侧都没有条目层。
     *
     * 三条规则（ITEM-MODEL §8 的"同批要动的实现"第 3 条）：
     *   ① **顺序**（`items:<id>`）：哪一侧改过顺序表就取哪一侧（顺序算改动）；
     *   ② **单条**（`item:<节点>#<条目>`）：按 id 挑来源 —— 只有一方改过就取那一方，
     *      我删掉的那条不推，我新增的那条补在后面；
     *   ③ **`detail` 谁都不要**：它是被排除的派生字段 ⇒ 合并后由 `renderDetail` 当场重建。
     *      ⚠️ 若让某一侧的 `detail` "赢"，写盘的缓存就会与 `items` 不一致 ⇒ G2 立刻判红。
     */
    function mergedItemsOf(id) {
      const myHas = Fm.itemIds.has(id), thHas = Ft.itemIds.has(id);
      if (!myHas && !thHas) return null;                    // 两侧都没条目层 ⇒ 不做条目层合并
      const myOrder = Fm.itemIds.get(id) || [];
      const thOrder = Ft.itemIds.get(id) || [];
      // 顺序取"改过 `items:<id>` 的那一方"；那一方没有顺序表（未条目化）才退回另一方
      const useMyOrder = useMine('items:' + id) && myHas;
      const order = useMyOrder ? myOrder : (thHas ? thOrder : myOrder);
      const myTable = Fm.items.get(id), thTable = Ft.items.get(id);
      const outItems = [];
      const seen = new Set();
      const take = (itemId) => {
        if (!itemId || seen.has(itemId)) return;
        seen.add(itemId);
        const key = 'item:' + id + '#' + itemId;
        if (useMine(key)) {                                 // 我改过 / 我加过 / 我删过 ⇒ 以我为准
          if (myTable && myTable.has(itemId)) outItems.push(clone(myTable.get(itemId)));
          return;
        }
        if (thTable && thTable.has(itemId)) outItems.push(clone(thTable.get(itemId)));
        else if (myTable && myTable.has(itemId)) outItems.push(clone(myTable.get(itemId)));  // 兜底：我这边有就带上
      };
      order.forEach(take);
      // 我新增、而顺序表取自对方那一侧的条目 —— 照 assoc 的"我新增的"分支补在后面
      myOrder.forEach(take);
      return outItems;
    }

    /**
     * 合并后重建 `detail` 派生缓存。
     * ⚠️ **没有渲染实现就抛错**：浏览器侧若没加载 `src/item-model.js`，宁可不合并，
     * 也不写一份 `detail` 与 `items` 不一致的数据（那会被 G2 判红，而且是"静默变质"那一类损害）。
     */
    function renderItemsOf(items) {
      const f = itemModel && typeof itemModel.renderDetail === 'function' ? itemModel.renderDetail : null;
      if (!f) {
        throw new Error('并发合并失败：合并条目化节点需要 `src/item-model.js` 的 renderDetail'
          + '（浏览器侧请先加载它）—— 没有它就无法重建派生缓存 detail，'
          + '而写一份与 items 不一致的 detail 会被 gate G2 判红、且属于静默变质。');
      }
      const html = f(items);
      return typeof html === 'string' ? html : '';
    }

    const build = (id) => {
      const o = own(id);
      if (!o) return null;                         // 该来源里没有它 ⇒ 被那一方删了
      const node = clone(o);
      const merged = mergedItemsOf(id);
      if (merged !== null) {
        node.items = merged;
        const html = renderItemsOf(merged);        // 丢弃两侧的 detail，当场重建（见 mergedItemsOf ③）
        if (html === '') delete node.detail; else node.detail = html;
      }
      const list = (kids(id) || []).map(build).filter(Boolean);
      if (list.length) node.children = list;
      return node;
    };
    const rootId = Ft.rootId || Fm.rootId || Fb.rootId;
    const rootNode = rootId ? build(rootId) : null;
    if (!rootNode) {
      return { ok: false, conflicts: ['node:' + rootId],
        detail: ['根节点（两侧对它的改动相互冲突，无法合并）'] };
    }
    out.data = rootNode;
    return {
      ok: true, data: out, merged: true,
      conflicts: conflicts,
      lostOn: conflicts.length ? describeKeys(theirs, conflicts) : []
    };
  }

  return {
    VERSION_CONFLICT, REPLAY_CONFLICT,
    fingerprint, changedKeys, intersection, withReplay,
    mergeTrees, flattenProject, describeKeys, itemLabel,
    hash, clone, nodeOwnHash, isItemized,
    // v0.20 只读差异视图（「让 AI 的编辑看得见」；一行都不写盘）
    inheritAssoc, snapshotOf, conflictSnapshots, valueToText, diffRows
  };
});
