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
 *     `graph.pinned[]` 里且在数据里带 `rect` 的节点**位置不被覆盖**（自动布局只负责其余节点）。
 *     留这个入口是为了将来接"作者给布局意图"时不用推翻本模块。
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

  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function roundTo(v, q) { return Math.round(v / q) * q; }
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

    const nodesIn = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
    const nodes = nodesIn.filter((n) => isPlain(n) && typeof n.id === 'string');
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

    // 层内堆叠（副轴）
    const pos = new Map();
    const layerSpan = [];
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
        const p = pos.get(id);
        const w = s.w;
        const h = s.h;
        const main = mainOf[r];
        const off = p.off + (maxSpan - layerSpan[r]) / 2;    // 各层副轴居中（重心不同也不歪）
        const x = direction === 'LR' ? main : roundTo(off, COORD_QUANTUM);
        const y = direction === 'LR' ? roundTo(off, COORD_QUANTUM) : main;
        rects[id] = { x: roundTo(x, COORD_QUANTUM), y: roundTo(y, COORD_QUANTUM), w: w, h: h };
        rankOut[id] = r;
      });
    }

    /* ---- 显式意图：pinned + 带 rect 的节点位置不被覆盖 ---- */
    const pinned = Array.isArray(graph.pinned) ? graph.pinned.filter((x) => typeof x === 'string') : [];
    const explicit = [];
    nodes.forEach((n) => {
      if (pinned.indexOf(n.id) < 0) return;
      const r = n.rect;
      const ok = Array.isArray(r) ? (r.length === 4 && r.every(isNum))
        : (isPlain(r) && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h));
      if (!ok) return;
      const box = Array.isArray(r)
        ? { x: r[0], y: r[1], w: r[2], h: r[3] }
        : { x: r.x, y: r.y, w: r.w, h: r.h };
      rects[n.id] = { x: box.x, y: box.y, w: box.w, h: box.h };
      explicit.push({ id: n.id, rect: box, why: 'pinned+rect' });
    });

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
        nodeCount: uniqIds.length,
        edgeCount: edges.length,
        problems: [],
        degraded: []
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
    resolveGap: resolveGap,
    ORDER_ITERS: ORDER_ITERS
  };
});
