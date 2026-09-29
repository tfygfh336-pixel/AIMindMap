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
 *   `node:<id>`     该节点**自身字段**（topic/detail/tags/images/files/links/background…，**不含 children**）
 *   `children:<id>` 该节点的**子 id 列表**（兄弟顺序有意义 ⇒ 顺序算改动）
 *   `assoc:<id>`    顶层关联笔记的**单个条目**（按 id，不看数组顺序）
 *   `meta` / `format` 项目级字段
 *   ⇒ 两个会话分别往**不同父节点**加内容、或改**不同节点**的详情，天然不相交 ⇒ 自动合并；
 *     同一父节点下同时加子节点（顺序会歧义）或改同一节点的同一字段 ⇒ 相交 ⇒ 指名拒绝。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('crypto'));
  else root.MMConcurrency = factory(null);
})(typeof self !== 'undefined' ? self : this, function (crypto) {
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

  /** 节点自身字段的指纹（**排除 children** —— 结构另由 children: 键承载） */
  function nodeOwnHash(node) {
    const o = {};
    Object.keys(node || {}).forEach((k) => { if (k !== 'children') o[k] = node[k]; });
    return hash(o);
  }

  /** 逐节点/字段指纹表（**派生值，不落盘** —— 落盘就要维护它不过期） */
  function fingerprint(data) {
    const fp = {};
    const d = data || {};
    fp.meta = hash(d.meta);
    fp.format = hash(d.format);
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.id) fp['node:' + node.id] = nodeOwnHash(node);
      if (node.id) fp['children:' + node.id] = hash((node.children || []).map((c) => c && c.id));
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
   * 把项目数据摊平成"按 id 取节点自身字段 / 按父取子 id 列表 / 按 id 取 assoc 条目"。
   * 三方合并要按 id 取用某一方的节点 —— 树是嵌套的，摊平后才能逐对象挑来源。
   */
  function flattenProject(data) {
    const nodes = new Map(), childIds = new Map(), assoc = new Map();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.id) {
        const o = {};
        Object.keys(n).forEach((k) => { if (k !== 'children') o[k] = n[k]; });
        nodes.set(n.id, o);
        childIds.set(n.id, (n.children || []).map((c) => c && c.id));
      }
      (n.children || []).forEach(walk);
    })(data && data.data);
    ((data && data.assoc) || []).forEach((a) => { if (a && a.id) assoc.set(a.id, a); });
    return {
      nodes, childIds, assoc,
      meta: data ? data.meta : undefined,
      format: data ? data.format : undefined,
      rootId: data && data.data ? data.data.id : null
    };
  }

  /** 把指纹键翻译成人能读的对象名（报错要**指名叫对象**，不是只说"有冲突"） */
  function describeKeys(data, keys) {
    const F = flattenProject(data);
    return keys.map((k) => {
      if (k === 'meta') return '项目元信息（meta）';
      if (k === 'format') return '数据格式标记（format）';
      let m = /^node:(.+)$/.exec(k);
      if (m) { const n = F.nodes.get(m[1]); return '节点「' + ((n && n.topic) || m[1]) + '」'; }
      m = /^children:(.+)$/.exec(k);
      if (m) { const n = F.nodes.get(m[1]); return '节点「' + ((n && n.topic) || m[1]) + '」的子节点列表'; }
      m = /^assoc:(.+)$/.exec(k);
      if (m) { const a = F.assoc.get(m[1]); return '关联笔记「' + ((a && a.title) || m[1]) + '」'; }
      return k;
    });
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
    // ⚠️ 渲染层的载荷**不含 assoc**（`renderer/app-core.js` 的 `serializeTree()` 只产 meta/format/data）⇒
    //    缺这个键必须当作"界面没有意见"（从 base 继承），**不是**"界面把 assoc 删光了"。
    //    少了这一步，"界面保存"会被算成删掉全部关联笔记 —— 那正是本工程最重的损害类别。
    const mineN = (mine && mine.assoc === undefined && base && base.assoc !== undefined)
      ? Object.assign({}, mine, { assoc: base.assoc })
      : mine;
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
    const build = (id) => {
      const o = own(id);
      if (!o) return null;                         // 该来源里没有它 ⇒ 被那一方删了
      const node = clone(o);
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
    mergeTrees, flattenProject, describeKeys,
    hash, clone, nodeOwnHash
  };
});
