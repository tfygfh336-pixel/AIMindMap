/* ============================================================
 * src/merge-project.js — 「把一个项目整棵并进另一个项目」的**纯逻辑**（UMD，无 IO）
 * ------------------------------------------------------------
 * 分工：本模块只回答"能不能合、合出来长什么样、合并后每条边指向谁"；
 * 读盘 / 写盘 / 回显全在 `cli/commands/merge.js`（与 `src/links.js` ↔ `cli/commands/links.js`
 * 同一个分工）。
 *
 * ## 一、为什么不是"把源项目的 children 平铺到父节点下"
 * 实测（2026-10-19，7 本 `book-*`）：每本的一级主题数 **9–17 个**（合计 85），
 * 平铺进同一个父节点 ⇒ 这个父节点下立刻多出 85 个**来源不可分辨**的子节点，
 * 而且每本自己的那个根（带书名的容器）没了。所以**每个源项目 = 一个分组节点**，
 * 而且这个分组节点**就是源项目的根节点本身**（见第二节）—— 不是新造一个容器再搬内容。
 *
 * ## 二、id 到底怎么处理（这是本命令唯一的"判断"，读数在 `.review/20261019-merge-project/`）
 * 三件实测事实决定了结论：
 *   ① 全库 9 个项目的根节点 id **都是 `root`**，而它的节点上**只有**
 *      `{id, topic, expanded, children}` 四个键（7 本逐本核对：detail 长度 0 · 无 origin ·
 *      无 tags/items/images/links）⇒ `root` 是**项目级容器占位 id**，不是内容；
 *   ② 除根之外，7 本的 466 个 id 与目标项目 `comnet` 的 889 个 id **交集为 0**
 *      （源之间互撞也只有那 7 个 `root`）⇒ 逐字带过去就天然不撞；
 *   ③ 全库 **0 条** `links[].id` / `assoc.members[].id` / `assoc.anchors[].id` 指向 `id==='root'`
 *      ⇒ 换掉根的那一个 id，**不可能**让任何边改指（这条是"重签发安全"的**全部依据**）。
 * 结论：
 *   · **除根以外的每一个 id 一律逐字带走，绝不重签发**。理由不是"省事"：节点 id 是
 *     `links[]`（本次语料 149 条）与 `assoc.members[]` 的**唯一键**，重签发就是把这些边
 *     静默改指或改悬空 —— 正是 `clone --repoint-items` 踩过的那一类（"猜错就是换了一条边，
 *     而回显还说成功"）。
 *   · **只有源根那一个 id 被换成确定性的 `merge-<源项目名>`**（=`groupIdOf`）。
 *     一箭三雕：容器 id 在目标里全局唯一 / 分组节点天然可溯源 / **幂等的判定键**（见下）。
 *   · 撞号的其余情形一律 **拒绝并点名**（id + 源里的 topic + 目标里的 topic + 路径），
 *     **不提供"自动改名"**：自动改名与重签发是同一件事，只是看起来更省心。
 *
 * ## 三、幂等（同一个源合并两次）
 * 判定键**不是** `import-md` 那套 `origin.src + sha256`：合并的输入是**一个项目**而不是一份文件，
 * 它没有"来源路径"，而它**有比指纹更硬的东西** —— 携带的 id 是逐字的。
 * 于是判据是两件事，都从数据现算、无需新字段：
 *   ① 分组节点 `merge-<源项目名>` 在目标里存在（确定性 ⇒ 认得出是**哪一次**合并落下的）；
 *   ② 该源**全部**非根节点 id 都已经在目标里（`carried ⊆ target`）⇒ 内容确实进过了。
 * 两条都中 ⇒ **拒绝并指名上一次落到哪个节点**（连主题一起报）。
 * 只中②（分组节点被人改名或删掉了）⇒ 照样拒绝，报"这些节点已经在目标项目里"，出路是
 *   "先把残留删掉再合并"。
 * 只中① ⇒ 拒绝并说"这个分组 id 已被占用"（可能是上一次的残留，也可能只是撞名）。
 * **没有 `--force`**：与 `import-md --force`（造第二棵不相交的树，安全）不同，
 *   "再来一份"在这里**没有安全的实现** —— 副本的 471 个 id 与原件逐字相同，要写下去只能
 *   重签发，而重签发就是第二节禁止的那件事。真想要第二份：`clone` 目标项目里的那个分组节点。
 *
 * ## 四、跨项目边（`links[]`）
 * 三种去向，分开报，**默认一个字节都不改**：
 *   · 指向目标项目（`{project: 目标}`）—— 合并后就是普通自指边，无需动（本次 137 条）；
 *   · 指向**本次也一起合并的另一个源项目** —— 目标里现在有一份同名 id 的副本，而**源项目默认保留**
 *     ⇒ 不改指也**不会悬挂**，只是"往项目外跳"。要改成项目内自指必须显式 `--links repoint`；
 *   · 指向本次合并之外的第三个项目 —— 与合并无关，原样保留（本次 0 条）。
 * `--links repoint` 的每一条都**逐条核验**：边的 `id` 必须是那个源项目里**真的存在**的节点
 *   （根例外：指 root 的边改指那个源的分组节点）。任一条核验不过（指向别的项目 / 那个源里
 *   根本没有这个 id）⇒ **整条命令拒绝并点名那条边**，绝不许"按序号猜一个最近的"。
 * 只改**本次合并进来的子树内部**的边：目标项目其余部分一个字节都不动（合并不该顺手重写无关笔记），
 *   而"子树之外有没有边指向本次合并的源"单独计数报到回显里（本次 0 条），不许静默。
 *
 * ## 五、入口层搬不动的三样（一律**拒绝并点名**，绝不静默丢）
 *   · `data.assoc`（关联笔记实体）：它是**项目级**集合，成员按 `project+id` 指过来；
 *     合并要另定"成员改指哪一份副本"的语义（本次 7 本全是 0 条，没有可依据的读数 ⇒ 不写没读数的语义）。
 *   · `data.bindings`（绑定工作区文件夹）：它是**活的守护进程配置**，跟着项目走；
 *     复制进目标等于开第二个守护者同步同一个目录。
 *   · 节点上的**未知字段**（不在 `src/schema.js` 的 `NODE_FIELD_NAMES` 里）：本模块会把它带过去，
 *     但"带过去"和"带对了"是两件事 —— 未知字段要么是实现漏登记，要么是外部工具写的，两种都该先看清。
 * 另有一条整体拒绝：源的 `meta.formatVersion` 与目标不同（v2 ↔ v3 混在一棵树里没有契约）。
 *
 * ## 六、一次原子写
 * 本模块在**全部源都验过之后**才动 `target.data`（任何一个源不过 ⇒ `target.data` 一个键都没变），
 * 回传给 `ctx.mutate` 的是同一棵树 ⇒ 命令层一次 `store.write`（`writeFileAtomic`）落地。
 * `--dry-run` 走的是**同一个函数、同一份输入形状**（命令层把克隆当目标传进来）⇒
 * "预览说能成、真跑被拒"在这里是构造上不可能的。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tree-utils.js'), require('./schema.js'));
  } else {
    // 浏览器侧没有 schema（本模块只用它做"字段名表 / id 规则"两件事）⇒ 见入口处的响亮拒绝
    root.MMMergeProject = factory(root.MMTree, root.MMSchema);
  }
})(typeof self !== 'undefined' ? self : this, function (tree, schema) {
  'use strict';

  /** `--links` 的两个取值（唯一取值表）。`keep` = 原样带走（默认）；`repoint` = 改指目标项目 */
  const LINKS_MODES = Object.freeze(['keep', 'repoint']);

  /** 分组节点 id 的前缀（唯一一处） */
  const GROUP_PREFIX = 'merge-';

  /** 默认分组节点 id：`merge-<源项目名>`（确定性 —— 幂等判定键就靠它） */
  function defaultGroupIdOf(name) {
    return GROUP_PREFIX + String(name);
  }

  /** 纯 JSON 深拷贝（键序不变；项目数据契约保证是纯 JSON，见 `src/concurrency.js` 的 clone 同款理由） */
  function cloneTree(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function fail(code, message) {
    return { ok: false, code: code, message: message };
  }

  /** 点名一个节点：`id（主题前 40 字）` —— 报错只说 id 时，读者还得自己去查它是什么 */
  function describeNode(node) {
    if (!node) return '（节点不存在）';
    const t = String(node.topic === undefined || node.topic === null ? '' : node.topic);
    return node.id + (t ? '（' + (t.length > 40 ? t.slice(0, 40) + '…' : t) + '）' : '');
  }

  /** 树里全部节点（含根，DFS 序） */
  function allNodes(rootNode) {
    const out = [];
    tree.walk(rootNode, (n) => out.push(n));
    return out;
  }

  /** 树里全部 id（Set） */
  function idSet(rootNode) {
    const s = new Set();
    tree.walk(rootNode, (n) => { if (n && typeof n.id === 'string') s.add(n.id); });
    return s;
  }

  /** 树里全部条目 id → 所属节点 id（条目 id 是**全项目唯一**的，见 docs/ITEM-MODEL.md §5.1） */
  function itemIdMap(rootNode) {
    const m = new Map();
    tree.walk(rootNode, (n) => {
      if (!Array.isArray(n.items)) return;
      n.items.forEach((it) => { if (it && typeof it.id === 'string') m.set(it.id, n.id); });
    });
    return m;
  }

  /** 项目的 `meta.formatVersion`（缺 `meta` 或缺这个键都返回 `null` —— 不抛、也不假装是 2） */
  function formatVersionOf(data) {
    const meta = data && data.meta;
    if (!meta || typeof meta !== 'object') return null;
    return meta.formatVersion === undefined ? null : meta.formatVersion;
  }

  /**
   * **把若干源项目并进目标项目**（纯计算；`target.data` 只在**全部校验通过后**才被改）。
   *
   * @param {object} o
   *   · `target`      = `{name, data}` —— `data` 是目标项目的 JSON 根（会被**就地修改**并回传；
   *                     校验不过时**一个键都不动**）
   *   · `sources`     = `[{name, data}]` —— 源项目，顺序 = 命令行顺序（分组节点的挂载顺序）
   *   · `parentId`    = 分组节点挂到目标的哪个节点下（默认 `root`）
   *   · `linksMode`   = `'keep'`（默认）| `'repoint'`
   *   · `groupIdOf`   = `(源项目名) => 分组节点 id`（默认 `merge-<源项目名>`；`--group-id` 由命令层注入）
   * @returns {{ok:true, data:object, groups:Array, totals:object}
   *          |{ok:false, code:string, message:string}}
   */
  function mergeProjectData(o) {
    const opt = o || {};
    const target = opt.target;
    const sources = Array.isArray(opt.sources) ? opt.sources : [];
    const linksMode = (opt.linksMode === undefined || opt.linksMode === null) ? 'keep' : String(opt.linksMode);
    const groupIdOf = typeof opt.groupIdOf === 'function' ? opt.groupIdOf : defaultGroupIdOf;

    /* ---- ⓪ 入参闸门（编程错误 ⇒ 也走 fail，不抛：命令层一律把它转成 `error:` 一行） ---- */
    if (!target || !target.name || !target.data || !target.data.data || typeof target.data.data !== 'object') {
      return fail('bad-target', '需要一个目标项目（`{name, data}`）—— merge-project 不能凭空建项目');
    }
    if (!schema) {
      return fail('no-schema', 'src/merge-project.js 需要 `src/schema.js`（节点字段表 + id 规则）'
        + '—— 浏览器分支拿不到它，本模块只在 Node 侧可用；缺了它"未知字段"与"id 合法"两道判据'
        + '会静默失效，所以这里响亮拒绝而不是降级');
    }
    if (LINKS_MODES.indexOf(linksMode) < 0) {
      return fail('bad-links-mode', '--links 只认两个取值：' + LINKS_MODES.join(' / ')
        + '（收到 ' + JSON.stringify(linksMode) + '）—— keep = 边原样带走（默认；源项目默认保留 ⇒ 不悬挂）；'
        + 'repoint = 把"指向本次合并进来的源项目"的边改指到目标项目（逐条核验，不过就整条命令拒绝）');
    }
    if (!sources.length) {
      return fail('no-source', '没有源项目 —— 用法：merge-project <目标项目> <源项目…> [--parent <id>] '
        + '[--links keep|repoint] [--dry-run] [--json]');
    }

    const targetName = String(target.name);
    const targetRoot = target.data.data;
    const parentId = (opt.parentId === undefined || opt.parentId === null || String(opt.parentId) === '')
      ? 'root' : String(opt.parentId);
    const idRe = schema.ID_RE;
    const allowedFields = new Set(schema.NODE_FIELD_NAMES);

    /* ---- ① 目标侧：父节点必须在（报错早于任何计算，且给出路） ---- */
    const parent = tree.find(targetRoot, parentId);
    if (!parent) {
      return fail('no-parent', '父节点不存在: ' + parentId + '（目标项目 ' + targetName + ' 里没有这个 id）'
        + ' —— 用 `list ' + targetName + '` 看现有 id，或去掉 --parent（默认挂到 root；'
        + '多源合并时每本书会成为 root 下的一个顶层主题）');
    }
    /* 注：`--parent` 缺省就是 `root`，而"挂到根下"是本命令最常用的形态
     *（每本书成为目标项目的一个顶层主题）⇒ 这里没有额外的特判，root 与别的父节点走同一条路。 */

    /* ---- ② 目标已有 id / 条目 id（一次遍历建表，后面所有比对都查它） ---- */
    const targetIds = idSet(targetRoot);
    const targetItemIds = itemIdMap(targetRoot);
    const targetNodesBefore = allNodes(targetRoot).length;

    const srcNames = sources.map((s) => String(s && s.name));
    const srcNameSet = new Set(srcNames);
    const seenSrc = new Set();

    /* ---- ③ 逐源预检：**一个字节都不改**（全部通过后才进第 ④ 步组装） ---- */
    const plans = [];                   // 每个源一份 {name, groupId, group, carried, ...}
    const batchIds = new Map();         // 本批将要占用的 id → 出处（源项目名）
    const batchItemIds = new Map();     // 本批将要占用的条目 id → 出处

    for (const src of sources) {
      const srcName = String(src && src.name);
      if (!src || !src.data || !src.data.data || typeof src.data.data !== 'object') {
        return fail('bad-source', '源项目 ' + JSON.stringify(srcName) + ' 的数据读不出来（`{name, data}` 形状不对）');
      }
      if (srcName === targetName) {
        return fail('self-merge', '源项目不能是目标项目本身（' + targetName + '）—— 把项目并进自己会让每一个 id '
          + '都撞上自己；要"再造一枝"请用 `clone ' + targetName + ' <源节点id> <新父节点id> --deep`');
      }
      if (seenSrc.has(srcName)) {
        return fail('dup-source', '源项目重复给了: ' + srcName + ' —— 同一个项目在一次合并里只能出现一次');
      }
      seenSrc.add(srcName);

      /* ⑤-a 格式版本：v2 ↔ v3 混在一棵树里没有契约 ⇒ 拒绝并给出路 */
      const srcFv = formatVersionOf(src.data);
      const tgtFv = formatVersionOf(target.data);
      if (srcFv !== tgtFv) {
        return fail('format-version-mismatch', '源项目 ' + srcName + ' 的 `meta.formatVersion`=' + JSON.stringify(srcFv)
          + '，目标项目 ' + targetName + ' 的是 ' + JSON.stringify(tgtFv)
          + ' —— 条目层的两种格式混在一棵树里没有契约（`validate` 认两个值，但它不判"混没混"）。'
          + '出路：先把两边统一到同一版（`migrate items <项目>` 迁到 v3）再合并');
      }

      /* ⑤-b 入口层搬不动的两样：拒绝并点名（不许静默丢） */
      if (Array.isArray(src.data.assoc) && src.data.assoc.length) {
        return fail('source-has-assoc', '源项目 ' + srcName + ' 有 ' + src.data.assoc.length
          + ' 条关联笔记（`data.assoc`）：本命令**不合并关联笔记实体**（成员按 `project+id` 指过来，'
          + '合并后要另定"成员改指哪一份副本"的语义，而本工程现有语料里没有一条可作读数）'
          + '—— 出路：先在目标项目用 `assoc-add` 重建这 ' + src.data.assoc.length + ' 条，'
          + '或先在源项目 `assoc-remove` 掉它们再合并。本次**盘上零改动**');
      }
      if (Array.isArray(src.data.bindings) && src.data.bindings.length) {
        return fail('source-has-bindings', '源项目 ' + srcName + ' 有 ' + src.data.bindings.length
          + ' 条工作区绑定（`data.bindings`）：它是**活的守护进程配置**，复制进目标等于让第二个守护者'
          + '同步同一个目录 —— 出路：先在源项目 `bind-sync --unbind` 解绑再合并。本次**盘上零改动**');
      }

      const srcRootNode = src.data.data;
      const srcAll = allNodes(srcRootNode);
      const carriedNodes = srcAll.filter((n) => n !== srcRootNode);

      /* ⑤-c 未知字段：带过去 ≠ 带对了 ⇒ 先看清 */
      for (const n of srcAll) {
        for (const k of Object.keys(n)) {
          if (!allowedFields.has(k)) {
            return fail('unknown-field', '源项目 ' + srcName + ' 的节点 ' + describeNode(n) + ' 上有字段 `' + k
              + '`，它不在 `src/schema.js` 的 `NODE_FIELD_NAMES` 里 —— 本命令不搬运看不懂的字段'
              + '（要么是实现漏登记字段，要么是外部工具写的，两种都该先查清楚）。本次**盘上零改动**');
          }
        }
      }

      /* ⑤-d id 撞号（含"上一次合并留下的残留"这一种，报文分开） */
      const carriedIds = carriedNodes.map((n) => n.id);
      const groupId = String(groupIdOf(srcName));
      if (!idRe.test(groupId)) {
        return fail('bad-group-id', '分组节点 id ' + JSON.stringify(groupId) + ' 不合规范'
          + '（规则 ' + String(idRe) + '：小写字母/数字/连字符）。源项目名 ' + JSON.stringify(srcName)
          + ' 拼不出合法 id 时用 `--group-id <id>` 显式指定（一次只能合并一个源项目时可用）');
      }

      const collisions = carriedIds.filter((id) => targetIds.has(id));
      const fullContainment = carriedIds.length > 0 && collisions.length === carriedIds.length;
      const prevGroupNode = tree.find(targetRoot, groupId);

      if (fullContainment) {
        return fail('already-merged', '这份来源已经合并过了：源项目 ' + srcName + ' 的 ' + carriedIds.length
          + ' 个节点**全都在**目标项目 ' + targetName + ' 里'
          + (prevGroupNode ? '，上一次合并落在节点 ' + describeNode(prevGroupNode) + ' 下' : '（分组节点 ' + groupId + ' 已不在，可能被改名或删过）')
          + ' —— 本命令**没有 --force**：再写一份要把这 ' + carriedIds.length + ' 个 id 全部重签发，'
          + '而 id 正是 links/assoc 的唯一键（重签发 = 静默改指边）。要第二份请 `clone ' + targetName + ' '
          + groupId + ' <新父节点id> --deep`（在项目内复制，条目级边有专门口径）');
      }
      if (collisions.length) {
        const sample = collisions.slice(0, 20).map((id) => {
          const inSrc = carriedNodes.find((n) => n.id === id);
          const inTgt = tree.find(targetRoot, id);
          return '· `' + id + '` —— 源里是 ' + describeNode(inSrc) + '，目标里已有 ' + describeNode(inTgt);
        }).join('\n  ');
        return fail('id-collision', 'id 撞号 ' + collisions.length + ' 个（源项目 ' + srcName
          + ' ↔ 目标项目 ' + targetName + '）：\n  ' + sample
          + (collisions.length > 20 ? '\n  …（还有 ' + (collisions.length - 20) + ' 个）' : '')
          + '\n本命令**不替你重签发 id**（id 是 links/assoc 的唯一键，重签发 = 静默改指或改悬空）'
          + '—— 出路：先 `edit` 改名 / `remove` 删掉目标里那 ' + collisions.length + ' 个节点，或换个目标项目。'
          + '本次**盘上零改动**'
          + (prevGroupNode ? '（注：目标里已经有分组节点 ' + describeNode(prevGroupNode)
            + '，撞的这些 id 很可能是上一次合并的残留 —— 先把残留删掉再合并）' : ''));
      }
      if (targetIds.has(groupId) || batchIds.has(groupId)) {
        const holder = tree.find(targetRoot, groupId);
        return fail('group-id-taken', '分组节点 id `' + groupId + '` 已被占用'
          + (holder ? '：目标项目里已有节点 ' + describeNode(holder) : '（同一批的另一个源要了同一个 id）')
          + ' —— 它可能是上一次合并的残留，也可能只是撞名；本命令不猜。'
          + '出路：核实 `get ' + targetName + ' ' + groupId + '`；要合并就换个分组 id（单源时 `--group-id <id>`）。'
          + '本次**盘上零改动**');
      }
      const batchHit = carriedIds.find((id) => batchIds.has(id));
      if (batchHit) {
        return fail('batch-collision', 'id 在同一批源项目之间撞号: `' + batchHit + '`（' + batchIds.get(batchHit)
          + ' 与 ' + srcName + ' 都有它）—— 本命令不替你重签发 id；出路：先把其中一个源项目里的那个节点改名，'
          + '或分两次合并。本次**盘上零改动**');
      }

      /* ⑤-e 条目 id：**全项目唯一**（ITEM-MODEL §5.1）⇒ 跨源合并会撞，必须逐条核验 */
      const srcItems = itemIdMap(srcRootNode);
      const itemClash = [];
      srcItems.forEach((ownerId, itemId) => {
        if (targetItemIds.has(itemId)) itemClash.push('`' + itemId + '`（目标项目节点 ' + targetItemIds.get(itemId) + ' 上已有）');
        else if (batchItemIds.has(itemId)) itemClash.push('`' + itemId + '`（' + batchItemIds.get(itemId) + '）');
      });
      if (itemClash.length) {
        return fail('item-id-collision', '条目 id 撞号 ' + itemClash.length + ' 条（源项目 ' + srcName
          + '）：' + itemClash.slice(0, 10).join('、')
          + (itemClash.length > 10 ? ' …（还有 ' + (itemClash.length - 10) + ' 条）' : '')
          + ' —— 条目 id 必须**全项目唯一**（`links[].item` / `assoc.members[].item` 只带条目 id，'
          + '不唯一则引用有歧义）。本命令不替你重签发条目 id（同一个陷阱，见 `clone --repoint-items`）'
          + '—— 出路：先在源项目里把撞号的那些条目换掉再合并。本次**盘上零改动**');
      }
      srcItems.forEach((ownerId, itemId) => batchItemIds.set(itemId, srcName));

      /* 记账（还没组装；组装在全部源都验过之后） */
      carriedIds.forEach((id) => batchIds.set(id, srcName));
      batchIds.set(groupId, srcName);

      const linkStats = countLinks(carriedNodes.concat([srcRootNode]), srcNameSet, targetName);
      plans.push({
        name: srcName,
        groupId: groupId,
        srcRootId: String(srcRootNode.id),
        rootExpanded: srcRootNode.expanded === true,
        groupTopic: String(srcRootNode.topic === undefined || srcRootNode.topic === null ? '' : srcRootNode.topic),
        carried: carriedIds.length,
        nodes: srcAll.length,
        items: srcItems.size,
        originNodes: srcAll.filter((n) => n && n.origin && typeof n.origin === 'object').length,
        linkStats: linkStats
      });
    }

    /* ---- ④ 组装：全部源都验过了，这里才开始动 target.data ---- */
    const groups = [];
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const srcRootNode = sources[i].data.data;
      /* 分组节点 **就是源根**（深拷贝，键序与原字段逐字相同），只把 id 换成确定性分组 id。
       * ⇒ 源根的 topic / expanded / 以及任何（已验过白名单的）字段都原样带走 —— 不是"新建一个
       *   容器再把内容塞进去"（那样会多一层、且源根的字段要有第二份搬运规则）。 */
      const group = cloneTree(srcRootNode);
      group.id = plan.groupId;
      groups.push({ plan: plan, node: group });
    }

    /* ---- ⑤ 边改指（只在 `--links repoint` 时；逐条核验，任一条不过 ⇒ 整体拒绝、盘面未改） ---- */
    const repointedByName = {};      // 源项目名 → 改了指的边数（报告要用，别只报总数）
    if (linksMode === 'repoint') {
      const planByName = new Map(plans.map((p) => [p.name, p]));
      const bad = [];
      groups.forEach((g) => {
        allNodes(g.node).forEach((n) => {
          const links = Array.isArray(n.links) ? n.links : null;
          if (!links) return;
          links.forEach((l, idx) => {
            if (!l || typeof l !== 'object') return;
            const proj = (l.project === undefined || l.project === null) ? '' : String(l.project);
            if (!planByName.has(proj)) return;          // 指向别的项目 / 已经指向目标 ⇒ 不动
            const owner = planByName.get(proj);
            const wantId = String(l.id);
            /* 逐条核验：那个源里**真的**有这条边指的那个节点（根例外 ⇒ 改指分组节点） */
            let newId = null;
            if (wantId === owner.srcRootId) newId = owner.groupId;
            else if (sourceHasNode(sources, proj, wantId)) newId = wantId;
            if (newId === null) {
              bad.push('· `' + n.id + '` 的 links[' + idx + '] → ' + proj + '/' + wantId
                + '（那个源项目里没有这个 id；根是 ' + owner.srcRootId + '）');
              return;
            }
            l.project = targetName;
            l.id = newId;
            repointedByName[proj] = (repointedByName[proj] || 0) + 1;
          });
        });
      });
      if (bad.length) {
        return fail('unprovable-link', '--links repoint 有 ' + bad.length + ' 条边**核验不过**：\n  '
          + bad.slice(0, 20).join('\n  ')
          + (bad.length > 20 ? '\n  …（还有 ' + (bad.length - 20) + ' 条）' : '')
          + '\n本命令**绝不按序号猜一个"最近的"目标**（猜错就是换了一条边，而回显还说成功）'
          + '—— 出路：不加 `--links repoint`（默认 keep：边原样带走，源项目默认保留 ⇒ 不悬挂），'
          + '或先修好源项目里那几条边再合并。本次**盘上零改动**');
      }
    }

    /* ---- ⑥ 挂上去（一次 append；顺序 = 命令行顺序） ---- */
    const kids = Array.isArray(parent.children) ? parent.children : [];
    groups.forEach((g) => kids.push(g.node));
    parent.children = kids;

    /* ---- ⑦ 自检：节点数必须**逐条相符**（判据①的机械形态，写盘前就判） ---- */
    const expectedAfter = targetNodesBefore + plans.reduce((a, p) => a + p.nodes, 0);
    const actualAfter = allNodes(targetRoot).length;
    if (actualAfter !== expectedAfter) {
      return fail('count-mismatch', '内部自检失败：合并后应有 ' + expectedAfter + ' 个节点，实际算出 ' + actualAfter
        + '（目标原有 ' + targetNodesBefore + ' + 源共 ' + plans.reduce((a, p) => a + p.nodes, 0) + '）'
        + '—— 这说明"分组的子节点 = 源根的子节点"这条不变量被破坏了，写盘已中止（本次**盘上零改动**）');
    }

    /* ---- ⑧ 子树之外的边：**单独计数报到回显**（本次不动它们，但绝不静默） ---- */
    const mergedSet = new Set();
    groups.forEach((g) => allNodes(g.node).forEach((n) => mergedSet.add(n)));
    const outsideEdges = [];
    tree.walk(targetRoot, (n) => {
      if (mergedSet.has(n)) return;
      (Array.isArray(n.links) ? n.links : []).forEach((l) => {
        const proj = l && l.project === undefined ? '' : String(l && l.project);
        if (srcNameSet.has(proj)) outsideEdges.push({ node: n.id, project: proj, id: String(l && l.id) });
      });
    });

    const totals = {
      target: targetName,
      parent: parentId,
      linksMode: linksMode,
      targetNodesBefore: targetNodesBefore,
      targetNodesAfter: actualAfter,
      addedNodes: actualAfter - targetNodesBefore,
      sourceNodes: plans.reduce((a, p) => a + p.nodes, 0),
      sources: plans.length,
      items: plans.reduce((a, p) => a + p.items, 0),
      originNodes: plans.reduce((a, p) => a + p.originNodes, 0),
      links: {
        toTarget: plans.reduce((a, p) => a + p.linkStats.toTarget, 0),
        toMerged: plans.reduce((a, p) => a + p.linkStats.toMerged, 0),
        toOutside: plans.reduce((a, p) => a + p.linkStats.toOutside, 0),
        noProject: plans.reduce((a, p) => a + p.linkStats.noProject, 0),
        repointed: Object.keys(repointedByName).reduce((a, k) => a + repointedByName[k], 0),
        repointedByProject: repointedByName,
        outsideProjects: mergeCounts(plans.map((p) => p.linkStats.outsideProjects))
      },
      outsideSubtreeEdgesIntoMergeSet: outsideEdges
    };

    return {
      ok: true,
      data: target.data,
      groups: groups.map((g) => ({
        name: g.plan.name,
        groupId: g.plan.groupId,
        groupTopic: g.plan.groupTopic,
        rootExpanded: g.plan.rootExpanded,
        nodes: g.plan.nodes,
        carried: g.plan.carried,
        items: g.plan.items,
        originNodes: g.plan.originNodes,
        links: g.plan.linkStats
      })),
      totals: totals
    };
  }

  /** 那个源项目里有没有这个 id 的节点（`--links repoint` 的**逐条核验**用；绝不按序号猜） */
  function sourceHasNode(sources, srcName, id) {
    for (let i = 0; i < sources.length; i++) {
      if (String(sources[i].name) !== String(srcName)) continue;
      const ids = idSet(sources[i].data.data);
      return ids.has(String(id));
    }
    return false;
  }

  /** 一组节点上的 links 按去向分类计数（唯一实现 —— 报告与判据都吃它） */
  function countLinks(nodes, srcNameSet, targetName) {
    const r = { toTarget: 0, toMerged: 0, toOutside: 0, noProject: 0, outsideProjects: {} };
    nodes.forEach((n) => {
      (Array.isArray(n.links) ? n.links : []).forEach((l) => {
        if (!l || typeof l !== 'object') return;
        const proj = (l.project === undefined || l.project === null) ? '' : String(l.project);
        if (!proj) { r.noProject++; return; }
        if (proj === targetName) { r.toTarget++; return; }
        if (srcNameSet.has(proj)) { r.toMerged++; return; }
        r.toOutside++;
        r.outsideProjects[proj] = (r.outsideProjects[proj] || 0) + 1;
      });
    });
    return r;
  }

  /** 合并多份"项目名 → 条数"计数表 */
  function mergeCounts(list) {
    const out = {};
    (list || []).forEach((m) => {
      Object.keys(m || {}).forEach((k) => { out[k] = (out[k] || 0) + m[k]; });
    });
    return out;
  }

  return {
    LINKS_MODES: LINKS_MODES,
    GROUP_PREFIX: GROUP_PREFIX,
    defaultGroupIdOf: defaultGroupIdOf,
    mergeProjectData: mergeProjectData
  };
});
