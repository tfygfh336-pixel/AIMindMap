/* ============================================================
 * src/source-chain.js — 「经验来源链（Source Chain，产品代号 `SC`）」的**判据唯一实现处**
 * ------------------------------------------------------------
 * UMD 纯逻辑：**零 I/O、零时钟、零随机、零 Electron**（Node 侧命令与单测共用一份；
 * 浏览器侧没有消费者，但双端加载必须成立 —— 见 `docs/ARCHITECTURE.md` §2.3 / §8.4）。
 *
 * ## 它回答什么（台账 `W17`，代号 `SC`）
 * 「**一条经验的出处链是哪几跳**」——沿 `links[].caption` 以「出自：」开头的边**多跳**追溯，
 * 并回答反方向「谁把我当出处」。它**不新增字段**：`docs/FEATURES.md` 的 `SC` 行早就写明
 * 「'链'指**边走**（就是既有的 `links[]`），不是新字段」。
 *
 * ## 与既有模块的分工（别在别处再写一遍）
 *   · `src/relations.js` —— **无类型区分**的双向邻域（`backlinks` / `related`：所有 `links` 都算边）。
 *     它连 `caption` 都不看，只原样透传 ⇒ **判不出"出处"**，也不报环（它的"防环"是
 *     "每节点只以最短跳数入表一次"的**遍历去重**，那不是错误判定）。
 *   · `src/learn-path.js` —— 只认 `前置：`（`PREREQ_PREFIXES`），`出自：` 它一条都不看。
 *   · **本文件** —— 只认 `出自：` 这**一**种前缀，且有向、要报环。
 *   ⇒ 三者的前缀**故意不是同一张表**：各自只认自己那一档，谁都不持有"5 种类型"的副本
 *      （词表唯一权威是 `docs/TAGS.md` §11，那是**文档**，不是代码里的第二份清单）。
 *
 * ## 方向规则（**唯一答案**，与 `docs/TAGS.md:347` 给 `前置：` 立的那句同构）
 *   **「出自：」写在"下游（后来）"的节点上，它的 `links[]` 目标就是"上游（来源）"。**
 *   ⇒ 沿出边走 = 溯源（越来越原始）；沿入边走 = 反查（越来越下游）。
 *   注意本模块**只走一个方向**：`edgesOf` 由调用方给。方向是调用方的事（命令层按 `--reverse`
 *   决定喂出边还是入边），这样"环检测"只有一份实现、两个方向共用。
 *
 * ## 环（`G-16` 教训：方向要有唯一答案，遇环要**响亮拒绝并逐条点名**）
 *   ⚠️ 绝不用"随便断一条边"或"每节点只入表一次"来假装无环 —— 那会让调用方
 *   拿到一份**看着正常的残缺链**，然后去改本来没坏的数据（`src/learn-path.js` 的
 *   `--limit` 曾被误报成"成环 540 个单元"，同一个病）。
 *   本模块的做法：DFS 时维护**当前路径**；"下一步"已在当前路径上 ⇒ 记一条环（含路径与 caption），
 *   **继续探索其它分支**（撞到第一个就停会让调用方修一轮又撞下一个），最后 `ok:false` 交给命令层拒。
 *
 * ## 上限（不许静默截断）
 *   `MAX_DEPTH` / `MAX_HOPS` / `MAX_CHAINS` 三档只有**这一处**定义。
 *   撞上限 ⇒ `{ok:false, code:'too-many'}` ⇒ 命令层**响亮报错**并给缩小范围的办法
 *   （照 `related` 撞 `MAX_ITEMS` 的既有口径：静默截断后的"链"会被当成完整的链来读 ✗）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMSourceChain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==========================================================================
   * 0. 取值表（**唯一一处**）
   * ======================================================================== */

  /**
   * 出处边的 caption 前缀。**只认 `docs/TAGS.md` §11 写下的那一个写法**。
   *
   * ⚠️ 真实数据里还有 **560 条** `来源：` 开头的 caption（由 `cli/commands/learn-path.js` 的
   *    `captionOfStep` 生成，语义就是"这一步出自原书哪个节点"）。**本模块有意不认它**：
   *    词表（`docs/TAGS.md` §11）说"5 种，多一个都不许"，在代码里替它认第 6 种写法等于
   *    让代码成为词表的第二份真相。⇒ 改成**如实报读数**（`otherPrefixes`），由人/词表裁决。
   *    交接写在 `.review/20261020-W17-provenance/00-定题.md` §9：词表收下之后在这里加一项即可。
   */
  const SOURCE_PREFIXES = Object.freeze(['出自：']);

  /** 近失写法的**识别起点**（含 `出自：` 本身；用来抓 `出自:` / `出自 ：` / 裸 `出自`） */
  const SOURCE_LOOKALIKE_HEAD = '出自';

  /** 深度上限：只用来挡离谱输入（真撞上的是 `MAX_HOPS`/`MAX_CHAINS`） */
  const MAX_DEPTH = 100;

  /** 一次调用最多走多少条边（跨全部链合计） */
  const MAX_HOPS = 500;

  /** 一次调用最多返回多少条链（菱形结构会让"路径条数"指数膨胀） */
  const MAX_CHAINS = 200;

  /** 读报时一条 caption 的显示上限（**截断必带省略号**，不冒充原文） */
  const CAPTION_MAX = 120;

  /** `otherPrefixes` 里"这一跳没有类型前缀"的桶名 */
  const NO_PREFIX_BUCKET = '（无前缀）';

  /**
   * 前缀桶**最多看几个字符**（冒号前的长度）。
   * 取值理由：中文类型前缀都是 2 字；英文写法 `prereq` 是 6 字 ⇒ 取 8 才能把
   * `docs/TAGS.md` §11 里 `前置` 的**三个**写法（`前置：`/`前置:`/`prereq:`）都分进各自的桶，
   * 同时仍然把"一整句话里恰好有个冒号"的 caption 挡在桶外（那种进 `（无前缀）`，不猜）。
   */
  const PREFIX_MAX_CHARS = 8;

  /* ==========================================================================
   * 1. 判据
   * ======================================================================== */

  /** caption 归一（非字符串一律读成空串 —— 与 `src/learn-path.js` 的 `isPrereqCaption` 同口径） */
  function capOf(caption) {
    return typeof caption === 'string' ? caption : '';
  }

  /**
   * 这条边是不是**出处边**。
   * 识别口径 = `indexOf(prefix) === 0`（紧贴开头），**与 `isPrereqCaption` 逐字同一条**。
   * 唯一差异是 trim：`isPrereqCaption` 先 `trim()` 再判（`tests/learn-path.test.js` 的
   * `'  前置: 先学这个'` 断言为 `true`）；本函数照它，否则 `前置：` 与 `出自：` 会在
   * "前面多了空格算不算"这一件事上给出**两个答案**。
   * ⚠️ `docs/TAGS.md:313` 那句"前面多一个空格就不算"与代码/单测**不一致**（本批禁区，只报不改，
   *    见 `.review/20261020-W17-provenance/00-定题.md` §8 第 3 条）。
   */
  function isSourceCaption(caption) {
    const s = capOf(caption).trim();
    if (!s) return false;
    for (let i = 0; i < SOURCE_PREFIXES.length; i++) {
      if (s.indexOf(SOURCE_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /**
   * 「看起来像出处、实际不被识别」的写法（`出自:` / `出自 ：` / 裸 `出自`）。
   * 存在的理由 = `docs/TAGS.md:315` 对 `前置知识：` 立的规矩：这类写法会让一条声明**静默失效**
   * （作者以为写了出处，代码根本没看见）⇒ **报出来**，别让它悄悄消失。
   * @returns {string} '' = 不是近失（要么是合法出处边、要么与出处无关）
   */
  function sourceNearMiss(caption) {
    const s = capOf(caption).trim();
    if (!s) return '';
    if (isSourceCaption(s)) return '';
    if (s.indexOf(SOURCE_LOOKALIKE_HEAD) !== 0) return '';
    return s;
  }

  /**
   * caption 的**前缀读数**（用于 `otherPrefixes`：如实告诉调用方"这些边我没跟，因为它们不是出处边"）。
   * 口径**不预设词表**：取第一个「：」/「:」之前的 ≤`PREFIX_MAX_CHARS` 字**连同那个冒号本身**；
   * 取不到就是 `（无前缀）`。
   * ⚠️ 冒号**原样保留**（`出自:` 与 `出自：` 是两个桶）：桶名若把半角冒号归一成全角，
   *    近失写法 `出自:` 就会和真正的 `出自：` 撞进同一个桶，读数看起来像"有一条出处边没跟"。
   */
  function prefixOf(caption) {
    const s = capOf(caption).trim();
    if (!s) return NO_PREFIX_BUCKET;
    const a = s.indexOf('：');
    const b = s.indexOf(':');
    let idx = -1;
    if (a >= 0 && b >= 0) idx = Math.min(a, b);
    else if (a >= 0) idx = a;
    else if (b >= 0) idx = b;
    if (idx <= 0 || idx > PREFIX_MAX_CHARS) return NO_PREFIX_BUCKET;
    return s.slice(0, idx + 1);
  }

  /** 显示用截断（**带省略号**，绝不把截断后的串冒充原文） */
  function clipCaption(caption) {
    const s = capOf(caption);
    if (s.length <= CAPTION_MAX) return s;
    return s.slice(0, CAPTION_MAX) + '…';
  }

  /** 节点键（跨项目唯一）。用 `\u0000` 分隔：项目名与 id 都不允许出现它，故不会撞键 */
  function nodeKey(project, id) {
    return String(project) + '\u0000' + String(id);
  }

  /** 键还原成 `项目:节点`（报错用） */
  function keyLabel(key) {
    return String(key).split('\u0000').join(':');
  }

  /* ==========================================================================
   * 2. 走链
   * ======================================================================== */

  /**
   * 从 `start` 出发沿出处边走，收集**每一条根→叶的链**。
   *
   * @param {object} opts
   *   @param {{project:string,id:string,topic:string|null}} opts.start 起点（必须有 project/id）
   *   @param {(project:string, id:string) => Array|undefined} opts.edgesOf
   *     给定节点，返回它的**全部边**（形如 `{project, id, topic, caption}`；`topic` 为 `null`
   *     = 目标节点解析不到）。**方向由调用方决定**：反向查时喂的就是"谁指向我"的入边。
   *     本函数自己按 caption 分流：`出自：` ⇒ 进链；其余 ⇒ 进 `otherPrefixes` / `nearMiss` 读数。
   *   @param {number} [opts.maxDepth] 最多几跳（≥1 生效，超过 MAX_DEPTH 按 MAX_DEPTH 算）
   *   @returns {{ok:true, chains:Array, hopCount:number, otherPrefixes:object,
   *              nearMiss:Array, truncated:boolean}
   *           | {ok:false, code:'cycle', cycles:Array}
   *           | {ok:false, code:'too-many', reason:string, chains:number, hops:number}}
   */
  function walk(opts) {
    const o = opts || {};
    const start = o.start;
    if (!start || typeof start.project !== 'string' || typeof start.id !== 'string') {
      throw new Error('walk: start 必须是 {project, id}');
    }
    if (typeof o.edgesOf !== 'function') throw new Error('walk: edgesOf 必须是函数');
    const maxDepth = (Number.isInteger(o.maxDepth) && o.maxDepth >= 1) ? Math.min(o.maxDepth, MAX_DEPTH) : MAX_DEPTH;

    const chains = [];
    const cycles = [];
    const otherPrefixes = Object.create(null);
    const nearMiss = [];

    const startHop = {
      project: start.project,
      id: start.id,
      topic: (start.topic === undefined ? null : start.topic),
      caption: null
    };
    const path = [startHop];
    const pathKeys = Object.create(null);
    pathKeys[nodeKey(start.project, start.id)] = true;
    let hopCount = 0;
    let depthCapped = false;
    let tooMany = '';

    /** 把一次 `edgesOf` 的结果归成 [{project,id,topic,caption}]，脏项丢掉 */
    function edgesFrom(project, id) {
      const raw = o.edgesOf(project, id);
      const list = Array.isArray(raw) ? raw : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || typeof e.project !== 'string' || typeof e.id !== 'string') continue;
        out.push({
          project: e.project,
          id: e.id,
          topic: (e.topic === undefined ? null : e.topic),
          caption: capOf(e.caption)
        });
      }
      return out;
    }

    /** 收一条链（并守住 MAX_CHAINS ⇒ 撞了就响亮失败，不静默截断） */
    function pushChain() {
      chains.push(path.slice());
      if (chains.length > MAX_CHAINS) tooMany = 'chains';
    }

    function dfs(cur, depth) {
      if (tooMany) return;
      const curKey = nodeKey(cur.project, cur.id);

      // 1) 该节点的**全部**边：出处边进链，其余进读数 / 近失表（只访问一次 edgesOf）
      const all = edgesFrom(cur.project, cur.id);
      const edges = [];
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (isSourceCaption(e.caption)) {
          edges.push(e);
          continue;
        }
        const p = prefixOf(e.caption);
        otherPrefixes[p] = (otherPrefixes[p] || 0) + 1;
        const nm = sourceNearMiss(e.caption);
        if (nm) {
          nearMiss.push({
            node: keyLabel(curKey),
            caption: clipCaption(nm),
            why: '以「出自」开头但不是「出自：」⇒ 不算出处边（照 docs/TAGS.md:315 对「前置知识：」的处置：'
              + '这种写法会让一条声明静默失效，所以报出来，不静默吞）'
          });
        }
      }

      // 2) 到底了（没有出处边）⇒ 这一条链结束
      if (!edges.length) {
        pushChain();
        return;
      }
      // 3) 到深度上限（还有出处边没走）⇒ 这一条链**按用户给的界**截止，并如实置 truncated
      if (depth >= maxDepth) {
        depthCapped = true;
        pushChain();
        return;
      }

      let advanced = false;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const k = nodeKey(e.project, e.id);
        if (pathKeys[k]) {
          // 环：不走进去，但**记下来并继续看别的分支**（撞到第一个就停会让调用方修一轮又撞下一个）
          cycles.push({
            from: { project: cur.project, id: cur.id, topic: cur.topic },
            to: { project: e.project, id: e.id, topic: e.topic },
            caption: clipCaption(e.caption),
            path: path.map(function (h) { return h.project + ':' + h.id; }).concat([e.project + ':' + e.id])
          });
          continue;
        }
        advanced = true;
        hopCount++;
        if (hopCount > MAX_HOPS) { tooMany = 'hops'; return; }
        path.push({ project: e.project, id: e.id, topic: e.topic, caption: e.caption });
        pathKeys[k] = true;
        dfs(path[path.length - 1], depth + 1);
        delete pathKeys[k];
        path.pop();
        if (tooMany) return;
      }

      // 4) 所有出处边都指回了当前路径（全成环）⇒ 这条链也到头了，别把它吞掉
      if (!advanced) pushChain();
    }

    dfs(startHop, 0);

    if (tooMany === 'chains') {
      return { ok: false, code: 'too-many', reason: 'chains', chains: chains.length, hops: hopCount };
    }
    if (tooMany === 'hops') {
      return { ok: false, code: 'too-many', reason: 'hops', chains: chains.length, hops: hopCount };
    }
    if (cycles.length) {
      cycles.sort(function (a, b) {
        const ka = a.from.project + '/' + a.from.id + '->' + a.to.project + '/' + a.to.id;
        const kb = b.from.project + '/' + b.from.id + '->' + b.to.project + '/' + b.to.id;
        return ka < kb ? -1 : (ka > kb ? 1 : 0);
      });
      return { ok: false, code: 'cycle', cycles: cycles };
    }

    // 排序：链长升序 → 逐跳 project/id 字典序（与数据里的数组顺序无关地可复现）
    chains.sort(function (a, b) {
      if (a.length !== b.length) return a.length - b.length;
      const ka = a.map(function (h) { return h.project + '/' + h.id; }).join('\u0001');
      const kb = b.map(function (h) { return h.project + '/' + h.id; }).join('\u0001');
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });
    nearMiss.sort(function (a, b) {
      const ka = a.node + '\u0001' + a.caption;
      const kb = b.node + '\u0001' + b.caption;
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });

    // otherPrefixes 按码点序重建（键序固定 = `--json` 可复现的一部分）
    const prefixOut = {};
    Object.keys(otherPrefixes).sort().forEach(function (k) { prefixOut[k] = otherPrefixes[k]; });

    return {
      ok: true,
      chains: chains,
      hopCount: hopCount,
      otherPrefixes: prefixOut,
      nearMiss: nearMiss,
      truncated: depthCapped
    };
  }

  /* ==========================================================================
   * 3. 报错报文（命令层的**唯一**文案来源：环 / 撞上限）
   * ======================================================================== */

  /** 环的点名报文：**逐条**给边、给路径、给出路 */
  function cycleMessage(cycles) {
    const list = Array.isArray(cycles) ? cycles : [];
    const lines = list.map(function (c, i) {
      return '  ' + (i + 1) + ') ' + c.from.project + ':' + c.from.id
        + '  --出自:-->  ' + c.to.project + ':' + c.to.id
        + '\n     路径：' + c.path.join('  →  ')
        + (c.caption ? '\n     caption：' + JSON.stringify(c.caption) : '');
    });
    return '出处链成环（沿「出自：」走回了当前路径上已经出现过的节点）——'
      + '**一条边都没有被丢掉**，也不替你挑一条断掉，下面逐条点名环上的边（共 ' + list.length + ' 条）：\n'
      + lines.join('\n')
      + '\n出路（改数据，不是改参数）：把其中一条边的 `links[].caption` 改成不带类型前缀的'
      + '自由文本（如「互为补充：…」），或把它改指另一个节点。'
      + '判据见 `docs/TAGS.md` §11 规则 5「一个 caption 只写一个类型前缀」。';
  }

  /** 撞上限的报文：**不许静默截断** */
  function tooManyMessage(r) {
    const which = (r && r.reason === 'chains')
      ? '链的**条数**超过上限 ' + MAX_CHAINS + '（当前已凑到 ' + (r.chains || 0) + ' 条）'
      : '边的**条数**超过上限 ' + MAX_HOPS + '（当前已走 ' + (r.hops || 0) + ' 条）';
    return '出处链' + which + ' —— 不会静默截断（截断后的链会被当成完整的链来读）。'
      + '缩小范围的办法：把 `--depth` 调小（如 --depth 2）｜从更靠"叶子"的那个节点开始｜'
      + '`--reverse` 与默认方向各看一半（两个方向的上限分开算）';
  }

  return {
    SOURCE_PREFIXES: SOURCE_PREFIXES,
    MAX_DEPTH: MAX_DEPTH,
    MAX_HOPS: MAX_HOPS,
    MAX_CHAINS: MAX_CHAINS,
    CAPTION_MAX: CAPTION_MAX,
    NO_PREFIX_BUCKET: NO_PREFIX_BUCKET,
    PREFIX_MAX_CHARS: PREFIX_MAX_CHARS,
    isSourceCaption: isSourceCaption,
    sourceNearMiss: sourceNearMiss,
    prefixOf: prefixOf,
    clipCaption: clipCaption,
    nodeKey: nodeKey,
    walk: walk,
    cycleMessage: cycleMessage,
    tooManyMessage: tooManyMessage
  };
});
