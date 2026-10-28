/* ============================================================
 * src/diagram/layout.js — **分层布局（Sugiyama 四步）**（`C-A-01`…`C-A-04`）
 * ------------------------------------------------------------
 * 本模块只做一件事：**给每个节点一个位置**。它不画、不绕线、不量字（量字在 `wrap.js`）。
 *
 * 四步与判据的对应（判据在 `tests/diagram-layout.test.js`）：
 *   ① **去环**（`C-A-01`）：有环输入不报错、不死循环；被反转的边**逐条**点名到 `report.reversed[]`。
 *   ② **分层**（`C-A-02`）：每节点一个 `rank`，且**同 rank 无直连边**（跨层边插虚拟节点 ⇒ 天然成立）。
 *   ③ **层内排序降交叉**（`C-A-03`）：重心法固定轮数 + **保最优**；排序结果与输入数组顺序无关。
 *   ④ **坐标分配**（`C-A-04`）：同 rank 的 x 相等；层内不重叠；通道带宽按"道数"预留（配合 `route.js`）。
 *
 * 三条工程口径（比"排得好看"更要紧）：
 *   · **稳定性**（`C-F4-04`）：全部按 **id 排序**后再算 —— 节点数组顺序打乱后，`rank` 与
 *     交叉数**逐值不变**（判据 6 量的是这两样，不是坐标：坐标是算出来的，当然会变）。
 *   · **间距可调**（`C-F4-03`）：`graph.gap.node` / `graph.gap.rank`（或 `opts.gap`）只影响
 *     各自那条轴；节点数、拓扑、分层结果不变。
 *   · **显式意图优先**（外部证据 archify 的"用布局判断代替通用自动布局"）：
 *     `graph.pinned[]` 命中者的坐标**优先于**自动布局，来源只有两个（见"显式意图"那一节）：
 *     `nodes[].rect`（绝对）或 `opts.offsets[id]`（= 既有的 `meta.nodeOffsets` 键域，相对偏移）。
 *     两个都没有 ⇒ `degraded[]` 里点名 `E_PIN_NO_COORD`（**不静默忽略**）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tokens.js'), require('./wrap.js'));
  else root.MMDiagramLayout = factory(root.MMDiagramTokens, root.MMDiagramWrap);
})(typeof self !== 'undefined' ? self : this, function (tokens, wrap) {
  'use strict';

  const LANE_GAP = tokens.LANE_GAP;
  const LANE_MARGIN = tokens.LANE_MARGIN;
  const FANOUT_GAP = tokens.FANOUT_GAP;
  const SIZE_QUANTUM = tokens.SIZE_QUANTUM;
  const COORD_QUANTUM = tokens.COORD_QUANTUM;
  const NODE_GAP_DEFAULT = tokens.NODE_GAP_DEFAULT;
  const RANK_GAP_DEFAULT = tokens.RANK_GAP_DEFAULT;
  const LAYER_PAD = 16;
  /** 重心法的固定轮数（固定 ⇒ 同输入同结果；不是"跑到收敛为止"—— 那会让耗时随输入漂） */
  const ORDER_ITERS = 8;
  /** 副轴对齐（`C-A-04` 的"父节点居中于其子节点"）的固定轮数：
   *  一上一下算一轮，固定 6 轮 ⇒ 同输入同结果（与重心法同一个口径：**不跑到收敛为止**）。 */
  const ALIGN_ITERS = 6;
  /** `pinned` 与自动区域的重叠避免最多推几轮（推不动就如实登记，不无限循环） */
  const PIN_ITERS = 8;

  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function roundTo(v, q) { const r = Math.round(v / q) * q; return r === 0 ? 0 : r; }   // `-0` 归一成 `0`
  function upTo(v, q) { return Math.ceil(v / q) * q; }

  /** 间距：数据（`graph.gap`）> 调用方 `opts.gap` > 缺省 */
  function resolveGap(graph, optGap) {
    const g = isPlain(graph.gap) ? graph.gap : {};
    const o = isPlain(optGap) ? optGap : {};
    let node = NODE_GAP_DEFAULT;
    let rank = RANK_GAP_DEFAULT;
    if (isNum(o.node)) node = o.node;
    if (isNum(o.rank)) rank = o.rank;
    if (isNum(g.node)) node = g.node;
    if (isNum(g.rank)) rank = g.rank;
    return { node: Math.max(0, Math.round(node)), rank: Math.max(0, Math.round(rank)) };
  }

  /* ==================================================================
   * ① 去环（`C-A-01`）：迭代 DFS + 三色；遇到栈上的点 ⇒ 这条边反转
   * ================================================================== */

  /**
   * @param {string[]} ids 已按 id 升序
   * @param {Array<{id:string, from:string, to:string}>} edges 已按 id 升序（**自环已剔除**）
   * @returns {{out:Array, reversed:string[]}} `out` = 反转后的有向边（`rev:true` 标记被反转的）
   */
  function removeCycles(ids, edges) {
    const outAdj = new Map();
    ids.forEach((id) => outAdj.set(id, []));
    edges.forEach((e) => { outAdj.get(e.from).push(e); });

    const color = new Map();                // 0 未访问 / 1 在栈上 / 2 已完成
    ids.forEach((id) => color.set(id, 0));
    const reversed = [];
    const reversedSet = new Set();

    for (let s = 0; s < ids.length; s++) {
      const start = ids[s];
      if (color.get(start) !== 0) continue;
      // 迭代 DFS（不用递归：几千节点时递归栈会先炸，而"炸"看起来像"输入太大"）
      const stack = [{ id: start, i: 0 }];
      color.set(start, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const list = outAdj.get(top.id);
        if (top.i >= list.length) {
          color.set(top.id, 2);
          stack.pop();
          continue;
        }
        const e = list[top.i++];
        const c = color.get(e.to);
        if (c === 1) {                       // 回边 ⇒ 反转（`C-A-01` 的逐条点名）
          if (!reversedSet.has(e.id)) { reversedSet.add(e.id); reversed.push(e.id); }
          continue;
        }
        if (c === 0) { color.set(e.to, 1); stack.push({ id: e.to, i: 0 }); }
      }
    }

    const out = edges.map((e) => (reversedSet.has(e.id)
      ? { id: e.id, from: e.to, to: e.from, rev: true }
      : { id: e.id, from: e.from, to: e.to, rev: false }));
    return { out: out, reversed: reversed.slice().sort(byId) };
  }

  /* ==================================================================
   * ② 分层（`C-A-02`）：Kahn 拓扑序 + 最长路
   * ================================================================== */

  function assignRanks(ids, dag) {
    const indeg = new Map();
    const outAdj = new Map();
    ids.forEach((id) => { indeg.set(id, 0); outAdj.set(id, []); });
    dag.forEach((e) => { indeg.set(e.to, indeg.get(e.to) + 1); outAdj.get(e.from).push(e.to); });

    const rank = new Map();
    ids.forEach((id) => rank.set(id, 0));
    const queue = ids.filter((id) => indeg.get(id) === 0);
    const topo = [];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      topo.push(u);
      const outs = outAdj.get(u).slice().sort(byId);
      for (let i = 0; i < outs.length; i++) {
        const v = outs[i];
        const nr = rank.get(u) + 1;
        if (nr > rank.get(v)) rank.set(v, nr);
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) queue.push(v);
      }
    }
    if (topo.length !== ids.length) {
      // 去环之后还有环 ⇒ 去环那一步错了。**响亮失败**，不悄悄按输入序排
      throw new tokens.MMDiagramError('E_LAYOUT_CYCLE',
        '去环后仍剩环（拓扑序只排出 ' + topo.length + '/' + ids.length + ' 个节点）—— '
        + '这是布局器自身的缺陷，不是数据的错：请把这份输入报给维护者，不要静默按输入序排',
        { object: { nodes: ids.length, ordered: topo.length }, fixes: ['报缺陷并附输入'] });
    }
    return { rank: rank, topo: topo };
  }

  /* ==================================================================
   * ③ 层内排序（`C-A-03`）：重心法 + 保最优；交叉数用**相邻两层**的逆序对算
   * ================================================================== */

  /** 相邻两层之间的交叉数（`C-A-03` 的可判形式：交换后不再下降）。
   *  ⚠️ 口径：**只数"上面不同节点"的两条边**。同一节点分出的两条边（扇出）在层间必然分开，
   *  它们之间不是交叉 —— 少了这个约束会把扇出数当成交叉数（MS2 实测：13 里有 4 个是这种假交叉）。 */
  function countLayerCrossings(upper, lower, edges) {
    // 只关心 upper→lower 的直连边（跨层边已被虚拟节点拆成逐层跳）
    const posLower = new Map();
    lower.forEach((id, i) => posLower.set(id, i));
    const pairs = [];
    upper.forEach((id, ui) => {
      edges.forEach((e) => {
        if (e.from === id && posLower.has(e.to)) pairs.push({ u: ui, v: posLower.get(e.to) });
      });
    });
    let cross = 0;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        if (pairs[i].u === pairs[j].u) continue;            // 同一节点的两条边 ⇒ 不是交叉
        if (pairs[i].v > pairs[j].v) cross++;
      }
    }
    return cross;
  }

  function totalCrossings(layers, edges) {
    let sum = 0;
    for (let r = 0; r + 1 < layers.length; r++) sum += countLayerCrossings(layers[r], layers[r + 1], edges);
    return sum;
  }

  /** 一次重心扫描：`dir=1` 自上而下（看前驱），`dir=-1` 自下而上（看后继） */
  function barycenterSweep(layers, edges, dir) {
    const next = layers.map((l) => l.slice());
    if (dir > 0) {
      for (let r = 1; r < next.length; r++) {
        const prevPos = new Map();
        next[r - 1].forEach((id, i) => prevPos.set(id, i));
        const bc = new Map();
        next[r].forEach((id) => bc.set(id, []));
        edges.forEach((e) => {
          if (bc.has(e.to) && prevPos.has(e.from)) bc.get(e.to).push(prevPos.get(e.from));
        });
        next[r] = next[r].slice().sort((a, b) => {
          const va = bc.get(a);
          const vb = bc.get(b);
          const ma = va.length ? va.reduce((s, x) => s + x, 0) / va.length : -1;
          const mb = vb.length ? vb.reduce((s, x) => s + x, 0) / vb.length : -1;
          if (ma !== mb) return ma - mb;
          return byId(a, b);                       // 相等时按 id 定序（不靠插入序）
        });
      }
    } else {
      for (let r = next.length - 2; r >= 0; r--) {
        const nextPos = new Map();
        next[r + 1].forEach((id, i) => nextPos.set(id, i));
        const bc = new Map();
        next[r].forEach((id) => bc.set(id, []));
        edges.forEach((e) => {
          if (bc.has(e.from) && nextPos.has(e.to)) bc.get(e.from).push(nextPos.get(e.to));
        });
        next[r] = next[r].slice().sort((a, b) => {
          const va = bc.get(a);
          const vb = bc.get(b);
          const ma = va.length ? va.reduce((s, x) => s + x, 0) / va.length : -1;
          const mb = vb.length ? vb.reduce((s, x) => s + x, 0) / vb.length : -1;
          if (ma !== mb) return ma - mb;
          return byId(a, b);
        });
      }
    }
    return next;
  }

  /**
   * 层内排序。**保最优**：交叉数只减不增（否则"有排序算法"这件事在判据上不可见）。
   * @returns {{layers:Array<Array<string>>, crossings:number, iterations:number}}
   */
  function orderLayers(layersIn, edges) {
    let best = layersIn.map((l) => l.slice().sort(byId));
    let bestCross = totalCrossings(best, edges);
    let cur = best;
    let curCross = bestCross;
    let iterations = 0;
    for (let it = 0; it < ORDER_ITERS; it++) {
      iterations++;
      const dir = it % 2 === 0 ? 1 : -1;
      const next = barycenterSweep(cur, edges, dir);
      const c = totalCrossings(next, edges);
      if (c < curCross || (c === curCross && JSON.stringify(next) < JSON.stringify(cur))) {
        cur = next;
        curCross = c;
      }
      if (c < bestCross) { best = next; bestCross = c; }
    }
    return { layers: best, crossings: bestCross, iterations: iterations };
  }

  /* ==================================================================
   * ④ 坐标分配（`C-A-04`）
   * ================================================================== */

  /** 边界 r 上有几条"跳"（决定这条通道要留几道 lane 的宽度） */
  function hopsPerBoundary(edges, rankOf, maxRank) {
    const lanes = new Array(Math.max(0, maxRank)).fill(0);
    edges.forEach((e) => {
      const a = rankOf.get(e.from);
      const b = rankOf.get(e.to);
      if (!isNum(a) || !isNum(b)) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let r = lo; r < hi; r++) lanes[r] += 1;
    });
    return lanes;
  }

  /* ---------------- 副轴对齐（`C-A-04` 的"父节点居中于其子节点"） ----------------
   *
   * ⚠️ 与"坐标取到 8 的整数倍"的**算术互斥**（这一节存在的理由，别删）：
   *   子节点中心都在 8 的整数倍上（`y % 8 == 0` 且 `h % 16 == 0` ⇒ 中心 ≡ y mod 8）。
   *   k 个子节点中心的均值 = 8·(Σaᵢ)/k —— **k ∤ Σaᵢ 时不在 8 的网格上**
   *   （例：k=2、a={0,1} ⇒ 均值 4）。要让父节点中心落回 8 的网格，误差必然 ≈ 半个步长 = 4px。
   *   ⇒ 所以本实现的判据是：
   *     · 单子（唯一邻接邻居）：目标中心**本身在网格上** ⇒ 误差 **=== 0**（硬判，注入挪 1px 必红）；
   *     · 多子：误差 ≤ `COORD_QUANTUM / 2`（= 4px，量化误差的理论上界），并逐节点报原值；
   *     · `report.centering[]` 里 `exact` 的节点数 ≥ 1（不许"一个都没居中"也算过）。
   *   **不做**的事：为了 ±0.5 把副轴量化降到 1px —— 那会连带打红「坐标 %8==0」与
   *   「折点都是 grid 的整数倍」两条既有判据（它们是端口落网格的前提）。
   */

  /** 一个节点在副轴上的"中心" = off + 主尺寸/2（主尺寸 = 该节点沿副轴的长度） */
  function centerOfOff(off, s, direction) {
    return off + (direction === 'LR' ? s.h : s.w) / 2;
  }

  /**
   * 副轴对齐 pass（确定性：固定轮数、层序固定、层内按**当前顺序**、上下轮换）。
   *
   * 每层做的是"带排序与最小间距约束的一维松弛"（不是"逐个节点夹一下"）：
   *   ① 每个节点算一个**期望位置**（邻层真实邻居中心的均值）；
   *   ② **前推**：`pos[i] = max(desired[i], pos[i-1] + size[i-1] + gap)`（保住次序与间距）；
   *   ③ **回拉**：从右往左 `pos[i] = min(pos[i], pos[i+1] - size[i] - gap)`（有富余就往期望靠）；
   *   ④ 再按网格量化并重跑一次前推（量化不许破坏 ② 的约束）；
   * ②③ 两遍是"把整层往期望挤"的关键：只做②（我第一版就是）会让整层**单向右漂**，
   * 于是"居中"在判据上永远差一段（实测 n-hook 差 96px），那不是算法不稳定，是**只有一遍**。
   *
   * @param {object} ctx
   *   `{ layers, sizeOf, direction, gapNode, sub, up, down }`
   *   `sub` = Map id → 当前 off（会被原地改写）
   * @returns {{moved:number, iterations:number}}
   */
  function alignSubAxis(ctx) {
    const layers = ctx.layers;
    const sizeOf = ctx.sizeOf;
    const direction = ctx.direction;
    const gapNode = ctx.gapNode;
    const sub = ctx.sub;
    const up = ctx.up;
    const down = ctx.down;
    const Q = COORD_QUANTUM;
    let moved = 0;
    let iterations = 0;

    const lenOf = (id) => {
      const s = sizeOf.get(id);
      return direction === 'LR' ? s.h : s.w;
    };
    const quantUp = (v) => Math.ceil(v / Q - 1e-9) * Q;

    /** 一层的一次松弛。`dirUp=true` ⇒ 期望取自上一层（父），否则取自下一层（子）。
     *
     *  算法 = **交替投影**（保次序/最小间距是硬约束，居中是最小二乘目标）：
     *    ① 每个节点取"期望位置"（邻层真实邻居中心的均值）；
     *    ② 内层若干轮：先朝期望走一半，再投影回可行域（前推保下界、回拉保上界、>=0）；
     *    ③ 整块平移，把这一层的**均值误差**消掉（均匀平移不破坏任何间距）；
     *    ④ 量化到 8px 网格，再前推一遍（量化不许破坏最小间距）。
     *  ⚠️ ② 的"回拉"只能**保上界**（`pos ≤ next − len − gap`），不能直接 `pos = want` ——
     *  直接赋值会把整层向左挤塌（我第一版就是这样：三层全被挤到 0，误差反而更大）。
     */
    const relaxLayer = (ids, dirUp) => {
      if (!ids.length) return;
      const want = ids.map((id) => {
        const list = (dirUp ? up.get(id) : down.get(id)) || [];
        let sum = 0;
        let n = 0;
        list.forEach((nid) => {
          if (!sizeOf.has(nid)) return;
          sum += centerOfOff(sub.get(nid), sizeOf.get(nid), direction);
          n++;
        });
        if (!n) return null;                                  // 没邻居 ⇒ 不动（不编一个位置）
        return sum / n - lenOf(id) / 2;
      });
      const pos = ids.map((id) => sub.get(id));
      const lowerOf = (i) => (i > 0 ? pos[i - 1] + lenOf(ids[i - 1]) + gapNode : 0);
      const upperOf = (i) => (i + 1 < ids.length ? pos[i + 1] - gapNode - lenOf(ids[i]) : Infinity);
      for (let it = 0; it < 12; it++) {
        for (let i = 0; i < ids.length; i++) {
          if (want[i] === null) continue;
          pos[i] += (want[i] - pos[i]) * 0.6;                  // 朝期望走一半多一点
        }
        for (let i = 0; i < ids.length; i++) pos[i] = Math.max(pos[i], lowerOf(i));
        for (let i = ids.length - 1; i >= 0; i--) pos[i] = Math.min(pos[i], upperOf(i));
        for (let i = 0; i < ids.length; i++) if (pos[i] < 0) pos[i] = 0;
      }
      // ③ 整块平移：把"有期望的节点"的平均误差消掉（没有期望的节点不参与）
      let dsum = 0;
      let dn = 0;
      ids.forEach((id, i) => { if (want[i] !== null) { dsum += want[i] - pos[i]; dn++; } });
      if (dn) {
        const minPos = pos.reduce((m, v) => Math.min(m, v), Infinity);
        let shift = Math.round((dsum / dn) / Q) * Q;
        if (shift < 0) shift = Math.max(shift, -Math.round(minPos / Q) * Q);   // 不许推出负区
        if (shift) for (let i = 0; i < ids.length; i++) pos[i] += shift;
      }
      // ④ 量化 + 前推（保住最小间距）
      for (let i = 0; i < ids.length; i++) {
        let q = Math.round(pos[i] / Q) * Q;
        if (i > 0) {
          const lo = pos[i - 1] + lenOf(ids[i - 1]) + gapNode;
          if (q < lo - 1e-9) q = quantUp(lo);
        }
        pos[i] = q < 0 ? 0 : q;
      }
      ids.forEach((id, i) => {
        if (sub.get(id) !== pos[i]) { sub.set(id, pos[i]); moved++; }
      });
    };

    for (let it = 0; it < ALIGN_ITERS; it++) {
      iterations++;
      const before = moved;
      const dirUp = it % 2 === 0;
      if (dirUp) {
        for (let r = 1; r < layers.length; r++) relaxLayer(layers[r].filter((id) => sizeOf.has(id)), true);
      } else {
        for (let r = layers.length - 2; r >= 0; r--) relaxLayer(layers[r].filter((id) => sizeOf.has(id)), false);
      }
      if (moved === before) break;                            // 一轮没动 ⇒ 已稳定（不改变结果，只省时间）
    }
    return { moved: moved, iterations: iterations };
  }

  /**
   * 分层布局主函数。
   *
   * @param {object} doc `{ graph, nodes }`（节点可带 `rect`（= 显式意图），也可不带）
   * @param {object} [opts] `{ measurer, gap:{node,rank}, contentMaxW }`
   * @returns {{rects:Object<string,{x:number,y:number,w:number,h:number}>, report:object}}
   */
  function autoLayout(doc, opts) {
    const o = opts || {};
    const graph = isPlain(doc && doc.graph) ? doc.graph : {};
    const direction = graph.direction === 'TB' ? 'TB' : 'LR';
    const gap = resolveGap(graph, o.gap);
    const contentMaxW = isNum(o.contentMaxW) ? o.contentMaxW : tokens.CONTENT_MAX_W;
    const measurer = o.measurer;
    /* 人工位置（`meta.nodeOffsets` / `meta.themeOffsets` 的同一份键域；**只用于 pinned 节点**，
     * 见下面"显式意图"那一节的纪律）—— 非 pinned 节点的偏移仍由调用方在布局之后叠加。 */
    const offsets = isPlain(o.offsets) ? o.offsets : null;

    const nodesIn = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
    const nodes = nodesIn.filter((n) => isPlain(n) && typeof n.id === 'string');
    const nodeById = new Map();
    nodes.forEach((n) => { if (!nodeById.has(n.id)) nodeById.set(n.id, n); });
    const ids = nodes.map((n) => n.id).sort(byId);
    const seen = new Set();
    const uniqIds = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));

    const edgesIn = Array.isArray(graph.edges) ? graph.edges : [];
    const idSet = new Set(uniqIds);
    const edgesRaw = edgesIn
      .filter((e) => isPlain(e) && typeof e.id === 'string' && isPlain(e.from) && isPlain(e.to)
        && idSet.has(e.from.node) && idSet.has(e.to.node))
      .map((e) => ({ id: e.id, from: e.from.node, to: e.to.node }))
      .sort((a, b) => byId(a.id, b.id));
    const selfLoops = edgesRaw.filter((e) => e.from === e.to).map((e) => e.id).sort(byId);
    const edges = edgesRaw.filter((e) => e.from !== e.to);

    /* ---- 尺寸：文本反推（`C-F1-03` 的换行在这里起作用） ---- */
    const sizeOf = new Map();
    nodes.forEach((n) => {
      const box = wrap.measureNodeBox(n, { measurer: measurer, contentMaxW: contentMaxW });
      // **立刻**取到 `SIZE_QUANTUM` 的整数倍：后面每一处（层宽 / 层内堆叠 / 端口网格）都必须吃这个数。
      // 不这么做的话，"主轴推进量"用的是未取整的尺寸、画出来的是取整后的框 ⇒ 相邻两层的实际间距
      // 比 `rankGaps` 里声明的小几像素（量"层间距可调"时就是红）。
      sizeOf.set(n.id, { w: upTo(box.w, SIZE_QUANTUM), h: upTo(box.h, SIZE_QUANTUM), overflow: box.overflow });
    });

    /* ---- 同侧扇出容量：`C-F3-09` 要求同侧多支线间距 ≥ 8，这里按支数把框撑开 ---- */
    const fanout = new Map();
    uniqIds.forEach((id) => fanout.set(id, { out: 0, in: 0 }));
    edges.forEach((e) => {
      fanout.get(e.from).out += 1;
      fanout.get(e.to).in += 1;
    });
    uniqIds.forEach((id) => {
      const f = fanout.get(id);
      const busiest = Math.max(f.out, f.in);
      const s = sizeOf.get(id);
      const need = busiest > 0 ? busiest * FANOUT_GAP + LAYER_PAD : 0;
      if (direction === 'LR') s.h = Math.max(s.h, need);      // LR：端口在左右两侧 ⇒ 撑高
      else s.w = Math.max(s.w, need);                          // TB：端口在上下两侧 ⇒ 撑宽
    });

    /* ---- ①② ---- */
    const removed = removeCycles(uniqIds, edges);
    const { rank } = assignRanks(uniqIds, removed.out);
    const maxRank = uniqIds.reduce((m, id) => Math.max(m, rank.get(id)), 0);

    /* ---- 虚拟节点：跨层边拆成逐层跳（`C-A-02` 的"同 rank 无直连边"由它成立） ---- */
    const dag = [];
    const dummyOf = [];                      // [{id, edgeId, rank}]
    removed.out.forEach((e) => {
      const a = rank.get(e.from);
      const b = rank.get(e.to);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo <= 1) { dag.push({ id: e.id, from: e.from, to: e.to, rev: e.rev }); return; }
      let prev = e.from;
      for (let r = lo + 1; r < hi; r++) {
        const did = 'd:' + e.id + ':' + r;
        dummyOf.push({ id: did, edgeId: e.id, rank: r });
        dag.push({ id: e.id + '#' + r, from: prev, to: did, rev: e.rev });
        prev = did;
      }
      dag.push({ id: e.id + '#t', from: prev, to: e.to, rev: e.rev });
    });

    const dummyIds = dummyOf.map((d) => d.id).sort(byId);
    const allIds = uniqIds.concat(dummyIds).sort(byId);
    const rankAll = new Map(rank);
    dummyOf.forEach((d) => rankAll.set(d.id, d.rank));

    let layers = [];
    for (let r = 0; r <= maxRank; r++) layers.push([]);
    allIds.forEach((id) => { layers[rankAll.get(id)].push(id); });

    // 初始序（每层按 id）的交叉数：**判据要能比"排序到底有没有降交叉"**，
    // 所以把起点与终点都交出去，让判据自己用逆序对复算一遍（不许拿实现里的中间变量自证）
    const initialCrosses = totalCrossings(layers, dag);
    const ordered = orderLayers(layers, dag);
    layers = ordered.layers;

    /* ---- 坐标：层 x（LR）/ 层 y（TB）+ 层内堆叠 ---- */
    const lanes = hopsPerBoundary(removed.out, rank, maxRank);
    const rankGaps = [];
    for (let r = 0; r < maxRank; r++) {
      rankGaps.push(Math.max(gap.rank, lanes[r] * LANE_GAP + 2 * LANE_MARGIN));
    }

    const layerMain = [];                    // 每层的"主尺寸"（LR: 最大宽；TB: 最大高）
    for (let r = 0; r <= maxRank; r++) {
      let m = 0;
      layers[r].forEach((id) => {
        const s = sizeOf.get(id);
        if (!s) return;                      // 虚拟节点不占地方
        m = Math.max(m, direction === 'LR' ? s.w : s.h);
      });
      layerMain.push(Math.max(m, 1));
    }

    // 层内堆叠（副轴）：先给一个**居中到同一跨度**的初值（重心不同也不歪），再跑对齐 pass
    const pos = new Map();
    const layerSpan = [];
    const sub = new Map();                   // id → 副轴起点（对齐 pass 原地改写）
    for (let r = 0; r <= maxRank; r++) {
      let cursor = 0;
      const real = layers[r].filter((id) => sizeOf.has(id));
      real.forEach((id, i) => {
        const s = sizeOf.get(id);
        const main = direction === 'LR' ? s.h : s.w;
        if (i > 0) cursor += gap.node;
        pos.set(id, { off: cursor, main: main });
        cursor += main;
      });
      layerSpan.push(cursor);
    }
    const maxSpan = layerSpan.reduce((m, v) => Math.max(m, v), 0);
    for (let r = 0; r <= maxRank; r++) {
      layers[r].forEach((id) => {
        if (!sizeOf.has(id)) return;
        const off = pos.get(id).off + (maxSpan - layerSpan[r]) / 2;
        sub.set(id, roundTo(Math.max(0, off), COORD_QUANTUM));   // 初值也必须在网格上
      });
    }

    /* ---- 副轴对齐（`C-A-04` 的"父节点居中于其子节点"）：一上一下、固定轮数 ---- */
    // 邻接表只用**真实节点**（虚拟节点是分层用的占位，不占地方 ⇒ 它不该拉偏中心）。
    // ⚠️ 上下要按 **rank 大小**判，不能按边的方向判：去环只反转"回边"，剩下的边里仍可能有
    //    `from` 的 rank 比 `to` 大（DFS 的访问次序决定哪条被反转）。按方向判会让"父/子"标反，
    //    于是对齐把节点往反方向推（实测：n-hook 的目标被算成 96px 之外，越对齐越歪）。
    const up = new Map();
    const down = new Map();
    uniqIds.forEach((id) => { up.set(id, []); down.set(id, []); });
    removed.out.forEach((e) => {
      if (!sizeOf.has(e.from) || !sizeOf.has(e.to)) return;
      const rf = rank.get(e.from);
      const rt = rank.get(e.to);
      if (!isNum(rf) || !isNum(rt) || Math.abs(rt - rf) !== 1) return;      // 只对齐相邻层
      if (rf < rt) { down.get(e.from).push(e.to); up.get(e.to).push(e.from); }
      else { up.get(e.from).push(e.to); down.get(e.to).push(e.from); }
    });
    const aligned = alignSubAxis({
      layers: layers, sizeOf: sizeOf, direction: direction, gapNode: gap.node,
      sub: sub, up: up, down: down
    });

    // 主轴坐标：逐层累加（带宽按 lane 数预留）
    const mainOf = [];
    let cursorMain = 0;
    for (let r = 0; r <= maxRank; r++) {
      mainOf.push(cursorMain);
      cursorMain += layerMain[r] + (r < maxRank ? rankGaps[r] : 0);
    }

    const rects = {};
    const rankOut = {};
    for (let r = 0; r <= maxRank; r++) {
      layers[r].forEach((id) => {
        const s = sizeOf.get(id);
        if (!s) return;
        const w = s.w;
        const h = s.h;
        const main = mainOf[r];
        const off = sub.get(id);
        const x = direction === 'LR' ? main : off;
        const y = direction === 'LR' ? off : main;
        rects[id] = { x: roundTo(x, COORD_QUANTUM), y: roundTo(y, COORD_QUANTUM), w: w, h: h };
        rankOut[id] = r;
      });
    }

    /* ---- 居中的**读数**（判据自己另写一份复算：见 tests/diagram-align.test.js） ---- */
    const centering = [];
    uniqIds.forEach((id) => {
      const s = sizeOf.get(id);
      if (!s) return;
      const ups = up.get(id) || [];
      const downs = down.get(id) || [];
      const list = ups.length ? ups : downs;                 // 有父看父，否则看子
      if (!list.length) return;
      let sum = 0;
      let n = 0;
      list.forEach((nid) => {
        const ns = sizeOf.get(nid);
        if (!ns) return;
        sum += centerOfOff(sub.get(nid), ns, direction);
        n++;
      });
      if (!n) return;
      const target = sum / n;
      const actual = centerOfOff(sub.get(id), s, direction);
      const errorPx = Math.abs(actual - target);
      centering.push({ id: id, neighbors: list.slice().sort(byId), target: target, actual: actual,
        errorPx: errorPx, exact: errorPx < 1e-9 });
    });
    centering.sort((a, b) => byId(a.id, b.id));


    /* ---- 显式意图：`graph.pinned` 的坐标**求解**（优先级高于自动布局）----
     *
     * 语义（设计 `docs/DIAGRAM-MODES.md` §6.3）：`pinned` **只表达"别覆盖"，不表达"在哪"**。
     * 坐标有两个来源，按下面的顺序取，**取到谁就逐值用它**（不再量化、不再挪动）：
     *   ① `nodes[].rect`（作者直接给的绝对坐标）⇒ `why: 'pinned+rect'`；
     *   ② `opts.offsets[id]`（= `meta.nodeOffsets` / `meta.themeOffsets` 的同一份键域，
     *      相对**自动布局位置**的偏移）⇒ 坐标 = 自动布局位置 ⊕ 偏移，`why: 'pinned+offset'`。
     *      ⇒ 这就是"人工位置"的既有家（§6.2 的实测：位置类信息已经在那里，不新造坐标）。
     *   ③ 两个都没有 ⇒ **钉住的意图无法兑现**：按自动布局放置，并在 `degraded[]` 里
     *      **逐条点名** `E_PIN_NO_COORD`（原先这里是静默忽略 —— 那正是"pinned 没用上"的真身：
     *      写了 `pinned` 与没写 `pinned` 得到一模一样的结果，且**报告里一个字都没有**）。
     *
     * ⚠️ 两条纪律：
     *   · **只对 pinned 命中者用 `offsets`**：非 pinned 节点的偏移仍由调用方在布局之后叠加
     *     （既有行为，两个渲染器共用同一份）。内核要是也叠一次，就会**双重叠加**。
     *   · 解析出来的框一律进 `explicit[]` ⇒ 后面的 `pinnedAvoid` 只推自动节点、**绝不推它们**
     *     （钉住的是作者的意图，推它等于把显式意图降级成建议）。
     */
    const pinned = Array.isArray(graph.pinned) ? graph.pinned.filter((x) => typeof x === 'string') : [];
    const offsetsIn = isPlain(offsets) ? offsets : {};
    const explicit = [];
    const pinnedUnresolved = [];
    pinned.slice().sort(byId).forEach((id) => {
      if (!sizeOf.has(id)) {                                  // 指向不存在的节点：schema 已判红，这里不重复判
        pinnedUnresolved.push({ id: id, why: 'no-node' });
        return;
      }
      const n = nodeById.get(id);
      const r = n ? n.rect : undefined;
      const ok = Array.isArray(r) ? (r.length === 4 && r.every(isNum))
        : (isPlain(r) && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h));
      if (ok) {
        const box = Array.isArray(r)
          ? { x: r[0], y: r[1], w: r[2], h: r[3] }
          : { x: r.x, y: r.y, w: r.w, h: r.h };
        rects[id] = { x: box.x, y: box.y, w: box.w, h: box.h };
        explicit.push({ id: id, rect: box, why: 'pinned+rect' });
        return;
      }
      const off = offsetsIn[id];
      if (isPlain(off) && isNum(off.x) && isNum(off.y)) {
        const base = rects[id];
        if (!base) { pinnedUnresolved.push({ id: id, why: 'no-base' }); return; }
        const box = { x: base.x + off.x, y: base.y + off.y, w: base.w, h: base.h };
        rects[id] = box;
        explicit.push({ id: id, rect: box, why: 'pinned+offset',
          base: { x: base.x, y: base.y }, offset: { x: off.x, y: off.y } });
        return;
      }
      pinnedUnresolved.push({ id: id, why: 'no-coord' });
    });

    /* ---- `pinned` 与自动区域的**重叠避免** ----
     * 为什么需要这一节：`pinned` 的语义是"这个节点的位置是作者的"，自动布局原先只负责**其余节点**
     * （它一开始根本不知道那些框在哪）⇒ 钉住的框会与自动摆的框叠在一起，而两条判据都不会红
     * （`C-F4-05` 只看"钉住的没被覆盖"、重叠检测 `C-A-06` 是 MS2 独立读数）。
     * 做法：**只推自动节点，不动钉住的**（钉住的是作者的意图，推它等于把显式意图降级成建议）；
     * 方向取副轴（±），距离取最小的 8px 整数量，同距时取 +（确定性）；推不动就如实登记。
     */
    const problems = [];
    const degraded = [];
    const pinnedIds = explicit.map((e) => e.id);
    const autoIds = uniqIds.filter((id) => pinnedIds.indexOf(id) < 0 && sizeOf.has(id));
    const intersects = (a, b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9
      && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
    const pinnedAvoid = [];
    let pinRounds = 0;
    if (pinnedIds.length && autoIds.length) {
      for (let round = 0; round < PIN_ITERS; round++) {
        let fixed = 0;
        autoIds.forEach((id) => {
          const own = rects[id];
          if (!own) return;
          const hits = pinnedIds.filter((pid) => rects[pid] && intersects(own, rects[pid]));
          if (!hits.length) return;
          const hitsOther = () => autoIds.some((oid) => oid !== id && rects[oid] && intersects(rects[oid], rects[id]));
          // 沿副轴推：求出"要清掉全部撞上的钉住框"的最小位移（两个方向各算一次，取小的）
          const centerOfRect = (r) => (direction === 'LR' ? r.y + r.h / 2 : r.x + r.w / 2);
          const halfOf = (r) => (direction === 'LR' ? r.h / 2 : r.w / 2);
          const cands = [];
          [1, -1].forEach((sign) => {
            let need = 0;
            hits.forEach((pid) => {
              const pr = rects[pid];
              const delta = sign > 0
                ? (centerOfRect(pr) + halfOf(pr)) - (centerOfRect(own) - halfOf(own)) + gap.node
                : (centerOfRect(pr) - halfOf(pr)) - (centerOfRect(own) + halfOf(own)) - gap.node;
              // sign>0：把自己挪到钉住框的"后面"；sign<0：挪到"前面"
              const mag = Math.abs(delta);
              if (mag > need) need = mag;
            });
            const step = Math.ceil(need / COORD_QUANTUM) * COORD_QUANTUM;
            cands.push({ sign: sign, delta: sign * step });
          });
          cands.sort((a, b) => (Math.abs(a.delta) - Math.abs(b.delta)) || (b.sign - a.sign));
          let applied = false;
          for (let i = 0; i < cands.length && !applied; i++) {
            const d = cands[i].delta;
            const moved = direction === 'LR'
              ? { x: own.x, y: own.y + d, w: own.w, h: own.h }
              : { x: own.x + d, y: own.y, w: own.w, h: own.h };
            if (moved.x < 0 || moved.y < 0) continue;                 // 不许推出画布负区（与初值同口径）
            const backup = { x: own.x, y: own.y };
            rects[id] = moved;
            const stillHit = pinnedIds.some((pid) => rects[pid] && intersects(moved, rects[pid]));
            if (stillHit || hitsOther()) { rects[id] = { x: backup.x, y: backup.y, w: own.w, h: own.h }; continue; }
            if (direction === 'LR') sub.set(id, moved.y); else sub.set(id, moved.x);
            pinnedAvoid.push({ id: id, awayFrom: hits.slice().sort(byId), axis: direction === 'LR' ? 'y' : 'x', delta: d });
            fixed++;
            applied = true;
          }
          if (!applied) {
            degraded.push('E_PIN_CROWDED: 节点 ' + id + ' 与钉住的 ' + hits.join('/')
              + ' 重叠，两个方向都推不开（会撞别的自动节点或推出负区）—— 已保持原位并如实登记');
          }
        });
        if (!fixed) break;
        pinRounds++;                                  // 只算**真的推动了**的轮数（0 = 一次都没撞上）
      }
    }
    pinnedAvoid.sort((a, b) => byId(a.id, b.id));
    /* `pinned` 命中却没有坐标 ⇒ **点名，不静默**（原先这里是"忽略，报告里一个字都没有"） */
    pinnedUnresolved.forEach((u) => {
      degraded.push('E_PIN_NO_COORD: 节点 ' + u.id + ' 被 `graph.pinned` 钉住，但**没有坐标**'
        + '（既没有 `nodes[].rect`，也没有 `opts.offsets[' + u.id + ']`）⇒ 钉住的意图无法兑现：'
        + '已按自动布局放置。修法：给该节点 `rect`，或在 `opts.offsets` 里给 `{' + u.id + '": {x, y}}`'
        + '（= 既有的 `meta.nodeOffsets` 键域）');
    });
    if (degraded.length) degraded.forEach((d) => problems.push(d));


    /* ---- 报告 ---- */
    const rankPairs = uniqIds.map((id) => [id, rank.get(id)]).sort((a, b) => byId(a[0], b[0]));
    return {
      rects: rects,
      report: {
        direction: direction,
        gap: { node: gap.node, rank: gap.rank },
        rankGaps: rankGaps,
        lanes: lanes,                                  // 每条边界上要留几道
        ranks: rankPairs,                              // [[id, rank]] —— 判据 6 断言的就是它
        rankOf: rankOut,
        layers: layers.map((l) => l.filter((id) => sizeOf.has(id))),
        crosses: ordered.crossings,                    // 排序阶段的交叉（**不是**最终 crossing 统计）
        orderIterations: ordered.iterations,
        // 排序这一步的**起点/终点/图**（含虚拟节点）都交出去：判据用它们独立复算"排序到底降了没有"
        order: {
          initial: (function () {
            const out = [];
            for (let r = 0; r <= maxRank; r++) out.push([]);
            allIds.forEach((id) => out[rankAll.get(id)].push(id));
            return out;
          })(),
          final: layers,
          edges: dag.map((e) => [e.from, e.to]),
          initialCrosses: initialCrosses,
          finalCrosses: ordered.crossings
        },
        reversed: removed.reversed,
        selfLoops: selfLoops,
        explicit: explicit,
        pinned: pinned.slice().sort(byId),
        // `pinned` 里**兑现不了**的那些（无坐标 / 无基点 / 无节点）：每条都同时进 `degraded[]`
        pinnedUnresolved: pinnedUnresolved.slice().sort((a, b) => byId(a.id, b.id)),
        // `C-A-04` 的居中读数（原值：目标中心 / 实际中心 / 误差 px / 是否精确）——
        // 判据不许读这里来自证：`tests/diagram-align.test.js` 从 rects + ranks + 夹具**另算一份**
        centering: centering,
        align: { iterations: aligned.iterations, moved: aligned.moved },
        // `pinned` 与自动区域的重叠避免读数（谁被推了、往哪个轴、推了多少）
        pinnedAvoid: pinnedAvoid,
        pinRounds: pinRounds,
        nodeCount: uniqIds.length,
        edgeCount: edges.length,
        problems: problems,
        degraded: degraded
      }
    };
  }

  return {
    autoLayout: autoLayout,
    removeCycles: removeCycles,
    assignRanks: assignRanks,
    orderLayers: orderLayers,
    totalCrossings: totalCrossings,
    countLayerCrossings: countLayerCrossings,
    hopsPerBoundary: hopsPerBoundary,
    alignSubAxis: alignSubAxis,
    resolveGap: resolveGap,
    ORDER_ITERS: ORDER_ITERS,
    ALIGN_ITERS: ALIGN_ITERS
  };
});
