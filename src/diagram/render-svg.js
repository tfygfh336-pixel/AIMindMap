/* ============================================================
 * src/diagram/render-svg.js — **图内核的渲染层**：JSON → SVG 字符串
 * ------------------------------------------------------------
 * 分工（MS2 起，一个模块一件事；见 `docs/ARCHITECTURE.md` §2.3）：
 *   · 文本怎么放进框（含**换行**）⇒ `wrap.js`   · 节点摆在哪 ⇒ `layout.js`
 *   · 线怎么绕（正交 / 通道 / 交叉 / 标签位）⇒ `route.js`
 *   · **本模块只做"把已经定好的几何画成字符串"**，外加 z-order、溢出终检、报告。
 *
 * 边界（MS2 之后仍然不做）：
 *   ❌ 交互（缩放/平移/hover/高亮）  ❌ 导出 PNG/PDF（本模块只产 SVG 字符串）
 *   ❌ 任何 I/O（不读盘、不写盘、不碰进程、不碰 DOM）—— 吃 JSON、吐字符串
 *   ✅ 两个入口的差别只有"坐标从哪来"：`render()` 用手写 `rect`（MS1 基线，逐字节不变），
 *      `renderAuto()`（在 `index.js`）先跑 `layout.autoLayout` 再进这里。
 *   ✅ 未实现的路由**响亮拒绝**：`curve` ⇒ `E_ROUTE_UNSUPPORTED`（`orthogonal` 已实现，
 *      但若声明了它却没跑布线 ⇒ `E_ROUTE_FAILED`，**不会**静默画成直线）。
 *
 * 判据出处（设计 `docs/DIAGRAM-MODES.md` §2 的编号，改渲染前先对一遍）：
 *   `C-F1-01` 六形状 · `C-F1-02` 三段式 · `C-F1-03` 换行 · `C-F1-04` 缩字号（下限 8.5）·
 *   `C-F1-05`【必备】文本永不溢出 · `C-F2-01`…`C-F2-06` 容器/层带 · `C-F3-02` 端口锚点 ·
 *   `C-F3-04` 路由 straight · `C-F3-06` 正交 · `C-F3-07`/`08` 箭头两端独立 ·
 *   `C-F3-14`…`19` 标签/交叉/overpass/lane · `C-F9-02` SVG 结构稳定
 *
 * 三条**可量**的判据口径（"看起来像一张图"不算证据，父批 §七 第 1 条）：
 *   ① **z-order 判的是 SVG 里元素的顺序**（6 个 `g[data-z]` 逐字）：
 *      `layers, containers, nodes, edges, edgeLabels, annotations`；
 *   ② **容器 stack 的高度是算式**：子项高之和 + padding×2 + gap×（n−1），不是"看着差不多"；
 *   ③ **溢出前后的读取值**：每个文本元素都带 `data-font-size`，节点只要放过缩字号/加宽/换行，
 *      报告里就有 `shrunk[] / widened[] / wrapped[]` 的**前后读数**；溢出计数恒为 0（否则**响亮报错**）。
 *   ④ **布线档的产物自带"可复算的三样"**：`data-points`（理想折线，交叉数由它独立复算）、
 *      `data-seg`（实际画出的段，4px 缺口可量）、`data-halo`（白描，逐点 overpass）。
 *
 * 确定性（`C-F9-02` / `C-F4-04`）：零时钟、零随机、零 `Map` 迭代顺序依赖（一律按数据数组序；
 * 而且节点顺序被打乱时坐标不变 —— 坐标来自**按 id 的查表**，不来自"第几个"）。
 * 数字一律经 `fmt()` 归一（3 位小数、去尾零、`-0` 归一成 `0`）⇒ 同一份 JSON 两跑逐字节相同。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./measure.js'), require('./schema.js'),
      require('./tokens.js'), require('./wrap.js'), require('./route.js'));
  } else {
    root.MMDiagramRender = factory(root.MMDiagramMeasure, root.MMDiagramSchema,
      root.MMDiagramTokens, root.MMDiagramWrap, root.MMDiagramRoute);
  }
})(typeof self !== 'undefined' ? self : this, function (measure, diagramSchema, tokens, wrap, route) {
  'use strict';

  /* ==================================================================
   * 取值表（**唯一一处**：几何 token、字号阶梯、z-order 都只在这里定义）
   * ------------------------------------------------------------------
   * MS2 起，文本/布局/布线的数都搬到了 `tokens.js`（四个模块共用一份），
   * 本模块只**引用**、不再各写一套 —— 同一件事两处表达会漂，那是本工程反复治过的病。
   * ================================================================== */

  /** z-order **逐字**（父批 §一 第 7 条给的就是这一串，别改写法）。
   *  判据：SVG 里这 6 个 `g[data-z]` 的**元素顺序**必须与它逐字相同。 */
  const Z_ORDER = Object.freeze(['layers', 'containers', 'nodes', 'edges', 'edgeLabels', 'annotations']);

  const FONT = tokens.FONT;
  const MIN_FONT_SIZE = tokens.MIN_FONT_SIZE;
  const LINE_GAP = tokens.LINE_GAP;
  const LINE_LEAD = tokens.LINE_LEAD;
  const PARTS = tokens.PARTS;
  const MAX_LINES = tokens.MAX_LINES;
  const MAX_NODE_W = tokens.MAX_NODE_W;
  const MAX_FIT_ROUNDS = tokens.MAX_FIT_ROUNDS;
  const NODE_PAD = tokens.NODE_PAD;
  const RADIUS_ROUND = tokens.RADIUS_ROUND;
  const CYLINDER_CAP_RATIO = tokens.CYLINDER_CAP_RATIO;
  const CYLINDER_CAP_MAX = tokens.CYLINDER_CAP_MAX;
  const CONTAINER_PAD = 12;
  const CONTAINER_GAP = 8;
  const ARROW_LEN = 10;
  const ARROW_HALF = 4.5;
  const CANVAS_MARGIN = 16;
  const EPS = tokens.EPS;
  const GAP_HALF = tokens.GAP_HALF;
  const HALO_WIDTH = tokens.HALO_WIDTH;

  /** 几何 helper 全部来自 `wrap.js`（形状内接 / 外接换算 / 字号阶梯 / 三段基线） */
  const shapeInset = wrap.shapeInset;
  const requiredInnerHeight = wrap.requiredInnerHeight;
  const outerSizeFor = wrap.outerSizeFor;
  const fontLadder = wrap.fontLadder;
  const fitPart = wrap.fitPartInBox;

  /** 缺省配色（本批不接主题：`C-F6-*` 是 MS3 的事；这里给确定的常量，不引外部 CSS） */
  const THEME = Object.freeze({
    nodeFill: '#f7f9fc',
    nodeStroke: '#33415c',
    nodeText: '#1b2430',
    containerFill: 'none',
    containerStroke: '#8a94a6',
    containerText: '#4a5568',
    layerFill: '#eef2f7',
    layerText: '#4a5568',
    watermark: '#8a94a6',
    edge: '#33415c',
    edgeLabel: '#33415c',
    annotation: '#7a5c00'
  });

  /** 报错的**唯一**类型（带 `code`：调用方按码判，不按文案判 —— 与工程的错误码口径一致）。
   *  MS2 起这个类住在 `tokens.js`（`layout`/`route` 也要抛），这里只引用同一个类对象。 */
  const MMDiagramError = tokens.MMDiagramError;

  /* ==================================================================
   * 小工具（纯函数）
   * ================================================================== */

  /** 数字归一：3 位小数、去尾零、`-0` → `0`。
   *  为什么必须有它：`0.1+0.2` 这类浮点噪声会让"同输入同输出"在**逐字节**口径下不成立。 */
  function fmt(n) {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    const r = Math.round(v * 1000) / 1000;
    const s = String(r === 0 ? 0 : r);
    return s;
  }

  /** XML 转义（**所有**文本与属性值都过它：标题里出现 `&`/`<` 不该把 SVG 弄坏） */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  /** 一个节点的矩形读数（统一成 `{x,y,w,h}`；数组与对象两种写法都收，别让调用方记两种） */
  function rectOf(node) {
    const r = node && node.rect;
    if (Array.isArray(r) && r.length === 4 && r.every(isFiniteNum)) {
      return { x: r[0], y: r[1], w: r[2], h: r[3] };
    }
    if (isPlainObject(r) && ['x', 'y', 'w', 'h'].every((k) => isFiniteNum(r[k]))) {
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    return null;
  }

  function rectIntersects(a, b) {
    return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS
      && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
  }

  /* ==================================================================
   * 缺省布局：**直接用 JSON 里的 rect**（MS2 会换掉这个函数，渲染与判据不动）
   * ================================================================== */

  /**
   * 布局的**默认实现**（父批 §一："布局函数留一个 `layoutOf(graph)` 的默认实现（= 直接用 JSON 里的 `rect`）"）。
   *
   * 语义：把 `doc.nodes[].rect`／`doc.graph.nodes[].rect` 原样抄成 `{id: {x,y,w,h}}`。
   *   · **不许排序**、**不许按数组下标**：坐标只与 id 绑定 ⇒ 节点数组顺序打乱后每个节点的坐标不变
   *     （父批 §一 第 10 条的判据之一，防的就是"偷偷按序排"）。
   *   · 没有 `rect` 的节点 ⇒ 不进结果（由渲染层报错，不在这里编一个位置）。
   * @param {object} doc `{ graph, nodes }`（也接受只有 `nodes` 或只有 `graph.nodes`）
   * @returns {Object<string, {x:number,y:number,w:number,h:number}>}
   */
  function layoutOf(doc) {
    const d = isPlainObject(doc) ? doc : {};
    const nodes = Array.isArray(d.nodes) ? d.nodes
      : (isPlainObject(d.graph) && Array.isArray(d.graph.nodes) ? d.graph.nodes : []);
    const out = {};
    nodes.forEach((n) => {
      if (!isPlainObject(n) || typeof n.id !== 'string') return;
      const r = rectOf(n);
      if (r) out[n.id] = r;
    });
    return out;
  }

  /* ==================================================================
   * 输入归一 + 校验（**所有"不合法"都在这里响亮拒绝**，渲染函数里不再判）
   * ================================================================== */

  function normalizeDoc(doc) {
    if (!isPlainObject(doc)) {
      throw new MMDiagramError('E_DOC', '渲染输入必须是对象 { graph, nodes }（graph 可缺省 = 无附加结构）');
    }
    const graph = doc.graph === undefined ? {} : doc.graph;
    if (!isPlainObject(graph)) {
      throw new MMDiagramError('E_DOC', 'doc.graph 必须是对象（缺省 = 无附加结构；不要写 null/数组）');
    }
    const nodesIn = Array.isArray(doc.nodes) ? doc.nodes : (Array.isArray(graph.nodes) ? graph.nodes : []);
    if (!nodesIn.length) {
      throw new MMDiagramError('E_DOC', 'doc.nodes 必须是非空数组（MS1 画的是**手写坐标**：每个节点都要带 rect）');
    }
    const ids = new Set();
    const nodes = nodesIn.map((n, i) => {
      const at = 'doc.nodes[' + i + ']';
      if (!isPlainObject(n)) throw new MMDiagramError('E_NODE', at + ' 必须是对象');
      if (typeof n.id !== 'string' || !n.id) throw new MMDiagramError('E_NODE', at + '.id 必须是非空字符串');
      if (ids.has(n.id)) throw new MMDiagramError('E_NODE', at + '.id 重复: ' + n.id + '（节点 id 是全图唯一键）');
      ids.add(n.id);
      const rect = rectOf(n);
      if (!rect) throw new MMDiagramError('E_NODE', at + '.rect 必须是 [x, y, w, h] 或 {x,y,w,h}（MS1 不做自动布局）');
      if (!(rect.w > 0) || !(rect.h > 0)) {
        throw new MMDiagramError('E_NODE', at + '.rect 的宽高必须 > 0（收到 ' + fmt(rect.w) + '×' + fmt(rect.h) + '）');
      }
      const type = n.type === undefined ? 'rect' : n.type;
      if (diagramSchema.SHAPES.indexOf(type) < 0) {
        throw new MMDiagramError('E_NODE', at + '.type 必须是 ' + diagramSchema.SHAPES.join(' / ')
          + '（收到 ' + JSON.stringify(n.type) + '）');
      }
      // style 只有三档（fill / stroke / text）；未知键**不许静默透传**（那是"写了不生效"）
      const style = n.style === undefined ? {} : n.style;
      if (!isPlainObject(style)) throw new MMDiagramError('E_NODE', at + '.style 必须是对象 {fill,stroke,text}');
      diagramSchema.unknownKeys(style, ['fill', 'stroke', 'text']).forEach((k) => {
        throw new MMDiagramError('E_NODE', at + '.style 有未知字段 ' + JSON.stringify(k) + '（只认 fill / stroke / text）');
      });
      ['title', 'subtitle', 'badge'].forEach((k) => {
        if (n[k] !== undefined && typeof n[k] !== 'string') {
          throw new MMDiagramError('E_NODE', at + '.' + k + ' 必须是字符串（缺省 = 这一段不画，但槽位仍预留）');
        }
      });
      // 自定义端口（`C-F3-02` 的"或自定义坐标"）：{ n: [x, y], ... }，坐标是**绝对**画布坐标
      const ports = n.ports === undefined ? null : n.ports;
      if (ports !== null) {
        if (!isPlainObject(ports)) throw new MMDiagramError('E_NODE', at + '.ports 必须是对象 {n:[x,y]}');
        diagramSchema.unknownKeys(ports, diagramSchema.PORTS).forEach((k) => {
          throw new MMDiagramError('E_NODE', at + '.ports 有未知字段 ' + JSON.stringify(k)
            + '（只认 ' + diagramSchema.PORTS.join(' / ') + '）');
        });
        diagramSchema.PORTS.forEach((k) => {
          const p = ports[k];
          if (p === undefined) return;
          if (!Array.isArray(p) || p.length !== 2 || !p.every(isFiniteNum)) {
            throw new MMDiagramError('E_NODE', at + '.ports.' + k + ' 必须是 [x, y] 两个有限数字');
          }
        });
      }
      return {
        id: n.id, type: type, rect: rect, title: n.title, subtitle: n.subtitle, badge: n.badge,
        style: style, ports: ports
      };
    });

    // graph 的形状（与 `src/schema.js` 用的是**同一个**校验器 ⇒ 命令行/渲染两处判据不分叉）
    const gv = diagramSchema.validateGraph(graph);
    if (!gv.ok) {
      throw new MMDiagramError('E_GRAPH', 'graph 形状不合法（' + gv.errors.length + ' 条）：'
        + gv.errors.slice(0, 8).join('；') + (gv.errors.length > 8 ? ' …' : ''), { errors: gv.errors });
    }
    // 引用存在性（设计 §6.3：悬挂 id ⇒ 判红，与 links 的悬挂检测同型）
    const rv = diagramSchema.validateGraphRefs(graph, ids);
    if (!rv.ok) {
      throw new MMDiagramError('E_GRAPH_REF', 'graph 引用了不存在的节点（' + rv.errors.length + ' 条）：'
        + rv.errors.slice(0, 8).join('；'), { errors: rv.errors });
    }
    return { graph: graph, nodes: nodes };
  }

  /* ==================================================================
   * 节点文字的安置（三段 + 缩字号 + 加宽 + **溢出必须为 0**）
   * ================================================================== */

  /**
   * 给一个节点定稿（MS2：阶梯里**多了换行这一档**，且它排在缩字号**之前**）。
   *
   * 顺序（与 `wrap.js` 头注释里那张表逐条对上）：
   *   ① 单行放得下 → 基准字号；② 换行放得下 → 基准字号 + 多行；③ 行数超上限 → 缩字号再试；
   *   ④ 最小字号仍放不下 → **加宽/加高**；⑤ 加宽超 `MAX_NODE_W` → 响亮报错（不裁字、不叠字）。
   *
   * @returns {{rect:object, inset:object, parts:object, widened:boolean, shrunk:Array, wrapped:Array}}
   */
  function fitNode(node, measurer) {
    let rect = { x: node.rect.x, y: node.rect.y, w: node.rect.w, h: node.rect.h };
    let widened = false;
    let shrunk = [];
    let wrapped = [];
    let parts = null;
    let inset = null;

    for (let round = 0; round <= MAX_FIT_ROUNDS; round++) {
      inset = shapeInset(rect, node.type);
      // 宽高都不许为负（形状内接区可能被声明得比 padding 还小 ⇒ 那不是"排版问题"，是数据问题）
      const availW = Math.max(0, inset.w);
      const fitted = wrap.measureParts(node, availW, measurer);
      const roundShrunk = [];
      const roundWrapped = [];
      PARTS.forEach((key) => {
        const r = fitted[key];
        if (r.shrunk) roundShrunk.push({ part: key, from: tokens.BASE_SIZE[key], to: r.size });
        if (r.wrapped) roundWrapped.push({ part: key, lines: r.lines.length, size: r.size });
      });
      // 高度：三段槽位恒定预留（空段 = 1 行）⇒ 换行后按行数长高（这是"不裁字"的另一半）
      const needH = wrap.innerHeightOf(fitted);
      const needW = Math.max(1, wrap.innerWidthOf(fitted));
      const outer = outerSizeFor(node.type, needW, Math.max(needH, 1));
      if (outer.w > MAX_NODE_W + EPS) {
        // 加宽这个兜底也有上界：到这儿就是"文案太长"，不是"排版放不下" —— 响亮说不出来路
        throw new MMDiagramError('E_TEXT_OVERFLOW',
          '节点 ' + node.id + ' 的文本在最小字号 ' + MIN_FONT_SIZE + 'px 下需要 ' + fmt(outer.w)
          + 'px 宽，超过单节点上限 ' + MAX_NODE_W + 'px —— 本内核**不裁字、也不无限加宽**：'
          + '缩短文案，或把它拆成多个节点（裁决见 tests/diagram-render.test.js 的溢出用例）',
          { object: { node: node.id, part: 'width', width: outer.w }, maxNodeW: MAX_NODE_W,
            minFont: MIN_FONT_SIZE, fixes: ['缩短文案', '拆成多个节点', '显式给更大的 rect'] });
      }
      const grownW = Math.max(rect.w, outer.w);
      const grownH = Math.max(rect.h, outer.h);
      const changed = Math.abs(grownW - rect.w) > EPS || Math.abs(grownH - rect.h) > EPS;
      if (changed) {
        widened = widened || Math.abs(grownW - rect.w) > EPS;
        rect = { x: rect.x, y: rect.y, w: grownW, h: grownH };
        continue;                                                // 加宽/加高后重算一遍（最多 MAX_FIT_ROUNDS+1 轮）
      }
      parts = fitted;
      shrunk = roundShrunk;
      wrapped = roundWrapped;
      // 终局自检（渲染后那一道）：**每一行**都放得下 + 内接高放得下（`C-F1-05` 的判据是逐行的）
      let bad = null;
      PARTS.forEach((key) => {
        const r = fitted[key];
        if (!r || bad || !r.lines.length) return;
        r.lines.forEach((line, li) => {
          if (!bad && line.width > Math.max(0, inset.w) + EPS) {
            bad = { part: key, line: li, width: line.width, avail: inset.w };
          }
        });
        if (!bad && r.overflow > 0) bad = { part: key, width: r.needW, avail: inset.w };
      });
      if (!bad && inset.h + EPS < needH) {
        // 形状的内接高没跟上（`diamond`/`cylinder` 的内接高由外形定）⇒ 那是几何算错了，不是数据错
        bad = { part: 'height', width: needH, avail: inset.h };
      }
      if (bad) {
        throw new MMDiagramError('E_TEXT_OVERFLOW',
          '节点 ' + node.id + ' 的 ' + bad.part + ' 在最小字号 ' + MIN_FONT_SIZE + 'px 下仍放不下（需 '
          + fmt(bad.width) + 'px，可用 ' + fmt(bad.avail) + 'px）—— 本内核**不裁字**：'
          + '要么改数据里的 rect，要么缩短文案（裁决见 tests/diagram-render.test.js 的溢出用例）',
          { object: { node: node.id, part: bad.part, width: bad.width, avail: bad.avail },
            minFont: MIN_FONT_SIZE, fixes: ['改 rect', '缩短文案', '拆成多个节点'] });
      }
      return { rect: rect, inset: inset, parts: fitted, widened: widened, shrunk: shrunk, wrapped: wrapped };
    }
    throw new MMDiagramError('E_TEXT_FIT_ROUNDS',
      '节点 ' + node.id + ' 在 ' + MAX_FIT_ROUNDS + ' 轮重排后仍未定稿（排版不收敛 ⇒ 不写出一份"看着对"的图）',
      { object: { node: node.id }, fixes: ['检查 rect 与文本长度'] });
  }

  /* ==================================================================
   * 容器（`C-F2-02` / `C-F2-03`）
   * ================================================================== */

  /**
   * 容器定稿。两种 layout 的判据是**算式**（父批 §三 的"高度 = 子项和 + padding"）：
   *   · `stack`：子项按 `children[]` 顺序**纵向等距**；容器高 = Σ子项高 + 2·padding + gap·(n−1)；
   *   · `free` ：子项**坐标逐个等于声明值**；容器高 = 子项包围盒 + 2·padding。
   * 两档都**不改子项的尺寸**（子项自己的 rect 由 `fitNode` 定稿；容器只摆位置）。
   */
  function resolveContainers(graph, nodeRects) {
    const out = [];
    const containers = Array.isArray(graph.containers) ? graph.containers : [];
    containers.forEach((c) => {
      const pad = isFiniteNum(c.padding) ? c.padding : CONTAINER_PAD;
      const gap = isFiniteNum(c.gap) ? c.gap : CONTAINER_GAP;
      const declared = { x: c.rect[0], y: c.rect[1], w: c.rect[2], h: c.rect[3] };
      const childIds = c.children.slice();
      let rect;
      if (c.layout === 'stack') {
        let y = declared.y + pad;
        let maxW = 0;
        childIds.forEach((id) => {
          const r = nodeRects.get(id);
          r.x = declared.x + pad;
          r.y = y;
          y += r.h + gap;
          if (r.w > maxW) maxW = r.w;
        });
        const innerH = childIds.reduce((s, id) => s + nodeRects.get(id).h, 0) + gap * Math.max(0, childIds.length - 1);
        rect = {
          x: declared.x, y: declared.y,
          w: Math.max(declared.w, maxW + 2 * pad),
          h: innerH + 2 * pad
        };
      } else {
        // free：子项坐标不动（声明的值就是最终值），容器按包围盒 + padding 定高/宽
        let minY = Infinity;
        let maxY = -Infinity;
        let maxX = -Infinity;
        childIds.forEach((id) => {
          const r = nodeRects.get(id);
          minY = Math.min(minY, r.y);
          maxY = Math.max(maxY, r.y + r.h);
          maxX = Math.max(maxX, r.x + r.w);
        });
        const y0 = Math.min(declared.y, minY - pad);
        rect = {
          x: declared.x, y: y0,
          w: Math.max(declared.w, maxX + pad - declared.x),
          h: Math.max(pad * 2, maxY + pad - y0)
        };
      }
      out.push({ id: c.id, label: c.label, layout: c.layout, pad: pad, gap: gap, children: childIds, rect: rect, declared: declared });
    });
    return out;
  }

  /* ==================================================================
   * 层带（`C-F2-04` / `C-F2-05` / `C-F2-06`）
   * ================================================================== */

  /**
   * 水印的落点 = **留白区**（判据：水印矩形与任何节点/容器矩形**零相交**）。
   * 做法：沿层带的水平中线，从左边距开始每隔 `step` 试一个 x，取**第一个**不压任何框的位置。
   * 全是框（放不下）⇒ **响亮报错**（`E_WATERMARK_NO_ROOM`）—— 设计 §9 第 4 条的口径：
   * "放不下就报错，不静默叠上去"。
   */
  function placeWatermark(layer, obstacles, measurer, step) {
    const wm = layer.watermark;
    const size = Math.max(MIN_FONT_SIZE, 12);                       // 水印字号固定档（不参与节点阶梯）
    const textW = measurer.widthOf(wm.text, size, FONT.family);
    const rotate = isFiniteNum(wm.rotate) ? wm.rotate : -90;
    const vertical = Math.abs(rotate) % 180 === 90;
    const boxW = vertical ? size : textW;
    const boxH = vertical ? textW : size;
    const rect = { x: layer.rect.x, y: layer.rect.y, w: layer.rect.w, h: layer.rect.h };
    const y = rect.y + rect.h / 2 - boxH / 2;
    const startX = rect.x + 4;
    const endX = rect.x + rect.w - boxW - 4;
    const stride = Math.max(1, step || 4);
    for (let x = startX; x <= endX + EPS; x += stride) {
      const cand = { x: x, y: y, w: boxW, h: boxH };
      const hit = obstacles.some((o) => rectIntersects(cand, o));
      if (!hit) return { x: x, y: y, w: boxW, h: boxH, size: size, rotate: rotate, textW: textW };
    }
    throw new MMDiagramError('E_WATERMARK_NO_ROOM',
      '层带 ' + layer.id + ' 的水印「' + wm.text + '」放不进留白区（沿中线试了 '
      + Math.max(0, Math.floor((endX - startX) / stride) + 1) + ' 个位置，全部压到节点/容器）—— '
      + '本内核**不把水印叠在框上**：加宽层带留白（gutter）或去掉水印',
      { layer: layer.id, textW: textW, rotate: rotate });
  }

  /** 层带之间不许重叠（`C-F2-04` 的判据"层带之间不重叠"）：重叠 = 两个背景分区说同一块地是谁的 */
  function checkLayerOverlap(layers) {
    for (let i = 0; i < layers.length; i++) {
      for (let j = i + 1; j < layers.length; j++) {
        if (rectIntersects(layers[i].rect, layers[j].rect)) {
          throw new MMDiagramError('E_LAYER_OVERLAP',
            '层带 ' + layers[i].id + ' 与 ' + layers[j].id + ' 重叠（' + fmt(layers[i].rect.x) + ','
            + fmt(layers[i].rect.y) + ' ' + fmt(layers[i].rect.w) + '×' + fmt(layers[i].rect.h) + ' / '
            + fmt(layers[j].rect.x) + ',' + fmt(layers[j].rect.y) + ' ' + fmt(layers[j].rect.w) + '×'
            + fmt(layers[j].rect.h) + '）—— 层带是**背景分区**，同一块地只能属于一层');
        }
      }
    }
  }

  /* ==================================================================
   * 端口与边（`C-F3-02` / `C-F3-04` / `C-F3-07` / `C-F3-08`）
   * ================================================================== */

  /* 端口 / 自动选边 / 箭头三角：实现在 `route.js`（布线阶段要用**同一份**几何，
   * 两处各写一份必然漂 —— MS1 时它们在这里，MS2 搬走，判据两处共用） */
  const portPoint = route.portPoint;
  const autoPorts = route.autoPorts;
  const arrowPolygon = route.arrowPolygon;


  /**
   * 一条边的几何。
   *
   * 三档（MS2 起）：
   *   · route 缺省 = `ROUTE_IMPLEMENTED[0]`（`straight`）⇒ 与 MS1 **逐字节相同**的那条路；
   *   · `orthogonal` ⇒ 由**布线阶段**（`route.routeAll`）给的折线，这里只做"取几何 + 接线型"；
   *   · `curve` ⇒ 仍**响亮拒绝**（`E_ROUTE_UNSUPPORTED`；本批不做曲线，设计 §7.2 把它留在 MS3）。
   * ⚠️ 红线：`orthogonal` 若拿不到折线，**不许**静默画成直线 —— 那会把"没绕线"说成"绕了"。
   */
  function resolveEdge(edge, views, routed) {
    const routeName = edge.route === undefined ? diagramSchema.ROUTE_IMPLEMENTED[0] : edge.route;
    if (diagramSchema.ROUTE_IMPLEMENTED.indexOf(routeName) < 0) {
      throw new MMDiagramError('E_ROUTE_UNSUPPORTED',
        '边 ' + edge.id + ' 的 route = ' + JSON.stringify(routeName) + '：**本批未实现**'
        + '（实现了 ' + diagramSchema.ROUTE_IMPLEMENTED.join(' / ') + '）。'
        + '本内核**不会**把它静默画成直线 —— 要么把数据改成已实现的取值，要么等对应批次',
        { object: { edge: edge.id, route: routeName },
          implemented: diagramSchema.ROUTE_IMPLEMENTED.slice(),
          fixes: ['改成 ' + diagramSchema.ROUTE_IMPLEMENTED.join(' 或 '), '去掉 route 用缺省'] });
    }
    const fromNode = views.get(edge.from.node);
    const toNode = views.get(edge.to.node);
    const arrow = edge.arrow || {};
    const start = arrow.start === true;
    const end = arrow.end === undefined ? true : arrow.end === true;   // 缺省：末端有箭头、起点没有（`C-F3-07`）
    const style = edge.style === undefined ? 'solid' : edge.style;
    const base = {
      id: edge.id, start: start, end: end, style: style,
      from: edge.from.node, to: edge.to.node,
      dash: diagramSchema.DASH_TOKEN[style] || '',
      color: edge.color || THEME.edge,
      label: edge.label
    };

    // ① 布线阶段已经给了折线 ⇒ 用它（端口名、路径、断开后的段、标签位全在那边算好了）
    const g = routed && routed.edges ? routed.edges[edge.id] : null;
    if (g) {
      const pts = g.points || [];
      const first = pts[0] || [0, 0];
      const last = pts[pts.length - 1] || first;
      return Object.assign(base, {
        fromPort: g.fromPort, toPort: g.toPort, route: g.route,
        x1: first[0], y1: first[1], x2: last[0], y2: last[1],
        points: pts, runs: g.runs || [], cuts: g.cuts || 0, fallback: g.fallback === true,
        routedLabel: g.label || null
      });
    }
    if (routeName === 'orthogonal') {
      throw new MMDiagramError('E_ROUTE_FAILED',
        '边 ' + edge.id + ' 声明了 route: "orthogonal"，但这次渲染没有跑布线（拿不到折线）—— '
        + '本内核**不会**把它静默画成直线：用 `renderAuto()`（自动布局 + 正交布线），'
        + '或在 `render()` 里传 `routing: "orthogonal"`',
        { object: { edge: edge.id }, fixes: ['用 renderAuto()', '传 opts.routing: "orthogonal"', '改成 route: "straight"'] });
    }

    const ports = (edge.from.port && edge.to.port)
      ? { from: edge.from.port, to: edge.to.port }
      : autoPorts(fromNode, toNode, edge.from.port, edge.to.port);
    const fromPort = edge.from.port || ports.from;
    const toPort = edge.to.port || ports.to;
    const a = portPoint(fromNode, fromPort);
    const b = portPoint(toNode, toPort);
    return Object.assign(base, {
      fromPort: fromPort, toPort: toPort, route: 'straight',
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      points: [[a.x, a.y], [b.x, b.y]], runs: [], routedLabel: null
    });
  }

  /* ==================================================================
   * 渲染主体
   * ================================================================== */

  /**
   * 把一份**手写坐标的 JSON** 渲染成 SVG 字符串 + 报告。
   *
   * @param {object} doc `{ graph, nodes }`（见 `docs/DATA-FORMAT.md` 的 `graph` 一节）
   * @param {object} [opts]
   * @param {Function} [opts.measureText] 注入真测量：`(text, {fontSize, fontFamily, fontWeight}) => number`
   * @param {Function} [opts.layout] 覆盖布局：`(doc) => {id: {x,y,w,h}}`（缺省 = `layoutOf`，MS2 换这里）
   * @returns {{svg:string, report:object, layout:object}}
   */
  function renderDiagram(doc, opts) {
    const o = opts || {};
    const measurer = measure.createMeasurer({ measureText: o.measureText });
    const nd = normalizeDoc(doc);
    const graph = nd.graph;

    /* ---- ① 坐标：默认=声明值（按 id 查表，与数组下标无关）---- */
    // 注入的 `layout` 收的也是**原始 doc**（与 `layoutOf` 同一形状）：两个入口看到的输入形状必须一样，
    // 否则"换布局"这件事会在两种入参形状之间漂 —— 那是 MS2 最容易被绊倒的地方。
    const baseLayout = typeof o.layout === 'function' ? o.layout(doc) : layoutOf(nd);
    const nodeRects = new Map();
    const nodesById = new Map();
    nd.nodes.forEach((n) => {
      const r = baseLayout[n.id] || n.rect;
      nodesById.set(n.id, n);
      nodeRects.set(n.id, { x: r.x, y: r.y, w: r.w, h: r.h });
    });

    /* ---- ② 逐节点定稿（三段 / 缩字号 / 加宽）：先定尺寸，再让容器摆位置 ---- */
    const fit = new Map();
    const shrunkReport = [];
    const widenedReport = [];
    const wrappedReport = [];
    nd.nodes.forEach((n) => {
      const before = nodeRects.get(n.id);
      const f = fitNode(Object.assign({}, n, { rect: before }), measurer);
      nodeRects.set(n.id, f.rect);
      fit.set(n.id, f);
      if (f.widened) {
        widenedReport.push({ id: n.id, from: { w: before.w, h: before.h }, to: { w: f.rect.w, h: f.rect.h } });
      }
      f.shrunk.forEach((s) => shrunkReport.push({ id: n.id, part: s.part, from: s.from, to: s.to }));
      f.wrapped.forEach((s) => wrappedReport.push({ id: n.id, part: s.part, lines: s.lines, size: s.size }));
    });

    /* ---- ③ 容器：摆位置 + 定高（stack 的算式在这里，不在别处）---- */
    const containers = resolveContainers(graph, nodeRects);

    /* ---- ④ 节点最终 rect + 内接区（容器摆过的位置要写回同一个 ref；内接区必须重算，
     *      否则文字会按"容器摆之前"的 x/y 落 —— 那是"看着对、量出来错"的典型形态）---- */
    const views = new Map();
    nd.nodes.forEach((n) => {
      const r = nodeRects.get(n.id);
      const f = fit.get(n.id);
      f.rect = r;
      f.inset = shapeInset(r, n.type);
      views.set(n.id, { rect: r, ports: n.ports });
    });

    /* ---- ⑤ 层带：几何 + 水印落点（必须在节点/容器定稿之后，障碍物才是真的）---- */
    const layersIn = Array.isArray(graph.layers) ? graph.layers : [];
    const layers = layersIn.map((l) => ({ id: l.id, label: l.label, labelSide: l.labelSide || 'left',
      fill: l.fill || THEME.layerFill, rect: { x: l.rect[0], y: l.rect[1], w: l.rect[2], h: l.rect[3] },
      watermark: l.watermark }));
    checkLayerOverlap(layers);
    const obstacles = [];
    containers.forEach((c) => obstacles.push(c.rect));
    nd.nodes.forEach((n) => obstacles.push(nodeRects.get(n.id)));
    layers.forEach((l) => {
      if (!l.watermark) return;
      l.watermarkBox = placeWatermark(
        { id: l.id, rect: l.rect, watermark: l.watermark }, obstacles, measurer,
        isFiniteNum(graph.grid) ? graph.grid : 4
      );
    });

    /* ---- ⑥ 边：straight 直连；正交 ⇒ **整图布线**（`route.js`），端口/通道/交叉/标签都在那边算 ---- */
    const edgesIn = Array.isArray(graph.edges) ? graph.edges : [];
    const gridPx = isFiniteNum(graph.grid) ? graph.grid : 8;
    const wantRouting = o.routing === 'orthogonal' || o.routing === true
      || edgesIn.some((e) => isPlainObject(e) && e.route === 'orthogonal');
    // 端口坐标要吃**容器摆过之后**的 rect ⇒ `views` 里装的就是最终 rect（上面 ④ 造的）
    let routed = null;
    if (wantRouting && edgesIn.length) {
      routed = route.routeAll({
        nodes: nd.nodes.map((n) => ({ id: n.id, rect: nodeRects.get(n.id), ports: n.ports })),
        edges: edgesIn.map((e) => ({ id: e.id, from: e.from, to: e.to, route: e.route, label: e.label })),
        direction: graph.direction, grid: gridPx, measurer: measurer,
        penalty: o.routePenalty,
        // 回边清单（来自布局的去环）：交叉的"预期/非预期"分类要用它（判据 2 的口径在 `route.js`）
        reversed: Array.isArray(o.reversedEdgeIds) ? o.reversedEdgeIds : []
      });
    }
    const edges = edgesIn.map((e) => resolveEdge(e, views, routed));

    /* ---- ⑦ 注释 ---- */
    const annotationsIn = Array.isArray(graph.annotations) ? graph.annotations : [];
    const annotations = annotationsIn.map((a, i) => ({
      id: a.id || ('note-' + (i + 1)), text: a.text,
      x: a.at[0], y: a.at[1], style: a.style || 'note'
    }));

    /* ---- ⑧ 画布包围盒（固定值 ⇒ 同输入同 viewBox）---- */
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const eat = (r) => {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    };
    layers.forEach((l) => eat(l.rect));
    containers.forEach((c) => eat(c.rect));
    nd.nodes.forEach((n) => eat(nodeRects.get(n.id)));
    edges.forEach((e) => {
      if (e.points && e.points.length > 1) {
        // 布线的折线：包围盒按**全部折点**吃（只吃两端会把绕出去的那一段漏出画布）
        e.points.forEach((p) => eat({ x: p[0], y: p[1], w: 0, h: 0 }));
      } else {
        eat({ x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2),
          w: Math.abs(e.x2 - e.x1), h: Math.abs(e.y2 - e.y1) });
      }
      if (e.routedLabel) eat({ x: e.routedLabel.x - e.routedLabel.w / 2, y: e.routedLabel.y - e.routedLabel.h / 2,
        w: e.routedLabel.w, h: e.routedLabel.h });
    });
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    const vb = {
      x: minX - CANVAS_MARGIN, y: minY - CANVAS_MARGIN,
      w: (maxX - minX) + CANVAS_MARGIN * 2, h: (maxY - minY) + CANVAS_MARGIN * 2
    };

    /* ---- ⑨ 组装（**顺序 = Z_ORDER 逐字**）---- */
    const out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(vb.w) + '" height="' + fmt(vb.h)
      + '" viewBox="' + fmt(vb.x) + ' ' + fmt(vb.y) + ' ' + fmt(vb.w) + ' ' + fmt(vb.h) + '"'
      + ' data-mm="diagram" data-profile="' + esc(graph.profile || 'complex') + '">');

    // ---- layers（最底）----
    out.push('<g data-z="layers">');
    layers.forEach((l) => {
      out.push('<g data-layer="' + esc(l.id) + '" data-x="' + fmt(l.rect.x) + '" data-y="' + fmt(l.rect.y)
        + '" data-w="' + fmt(l.rect.w) + '" data-h="' + fmt(l.rect.h) + '">');
      out.push('<rect x="' + fmt(l.rect.x) + '" y="' + fmt(l.rect.y) + '" width="' + fmt(l.rect.w)
        + '" height="' + fmt(l.rect.h) + '" fill="' + esc(l.fill) + '" stroke="none"/>');
      if (l.label) {
        if (l.labelSide === 'top') {
          out.push('<text class="mm-layer-label" x="' + fmt(l.rect.x + 8) + '" y="' + fmt(l.rect.y + 14)
            + '" font-family="' + esc(FONT.family) + '" font-size="11" fill="' + THEME.layerText
            + '" data-text="layer-label">' + esc(l.label) + '</text>');
        } else {
          const cx = l.rect.x + 14;
          const cy = l.rect.y + l.rect.h / 2;
          out.push('<text class="mm-layer-label" x="' + fmt(cx) + '" y="' + fmt(cy)
            + '" transform="rotate(' + fmt(-90) + ' ' + fmt(cx) + ' ' + fmt(cy) + ')"'
            + ' text-anchor="middle" font-family="' + esc(FONT.family) + '" font-size="11" fill="'
            + THEME.layerText + '" data-text="layer-label">' + esc(l.label) + '</text>');
        }
      }
      if (l.watermarkBox) {
        const wb = l.watermarkBox;
        const cx = wb.x + wb.w / 2;
        const cy = wb.y + wb.h / 2;
        const opacity = isFiniteNum(l.watermark.opacity) ? l.watermark.opacity : 0.5;
        out.push('<text class="mm-watermark" x="' + fmt(cx) + '" y="' + fmt(cy) + '"'
          + ' transform="rotate(' + fmt(wb.rotate) + ' ' + fmt(cx) + ' ' + fmt(cy) + ')"'
          + ' text-anchor="middle" font-family="' + esc(FONT.family) + '" font-size="' + fmt(wb.size) + '"'
          + ' fill="' + THEME.watermark + '" fill-opacity="' + fmt(opacity) + '"'
          + ' data-watermark="' + esc(l.id) + '" data-box="' + fmt(wb.x) + ' ' + fmt(wb.y) + ' '
          + fmt(wb.w) + ' ' + fmt(wb.h) + '">' + esc(l.watermark.text) + '</text>');
      }
      out.push('</g>');
    });
    out.push('</g>');

    // ---- containers ----
    out.push('<g data-z="containers">');
    containers.forEach((c) => {
      out.push('<g data-container="' + esc(c.id) + '" data-layout="' + esc(c.layout) + '" data-x="'
        + fmt(c.rect.x) + '" data-y="' + fmt(c.rect.y) + '" data-w="' + fmt(c.rect.w) + '" data-h="'
        + fmt(c.rect.h) + '" data-pad="' + fmt(c.pad) + '" data-gap="' + fmt(c.gap) + '">');
      out.push('<rect x="' + fmt(c.rect.x) + '" y="' + fmt(c.rect.y) + '" width="' + fmt(c.rect.w)
        + '" height="' + fmt(c.rect.h) + '" rx="' + RADIUS_ROUND + '" fill="' + THEME.containerFill
        + '" stroke="' + THEME.containerStroke + '" stroke-dasharray="4 4"/>');
      if (c.label) {
        out.push('<text class="mm-container-label" x="' + fmt(c.rect.x + c.pad) + '" y="'
          + fmt(c.rect.y + 14) + '" font-family="' + esc(FONT.family) + '" font-size="11" fill="'
          + THEME.containerText + '" data-text="container-label">' + esc(c.label) + '</text>');
      }
      out.push('</g>');
    });
    out.push('</g>');

    // ---- nodes ----
    out.push('<g data-z="nodes">');
    nd.nodes.forEach((n) => {
      const r = nodeRects.get(n.id);
      const f = fit.get(n.id);
      const inset = f.inset;
      const style = n.style || {};
      const fill = style.fill || THEME.nodeFill;
      const stroke = style.stroke || THEME.nodeStroke;
      const textColor = style.text || THEME.nodeText;
      out.push('<g data-node="' + esc(n.id) + '" data-shape="' + esc(n.type) + '" data-x="' + fmt(r.x)
        + '" data-y="' + fmt(r.y) + '" data-w="' + fmt(r.w) + '" data-h="' + fmt(r.h) + '">');
      out.push(shapeMarkup(n.type, r, fill, stroke));
      // 三段基线：**互不相等且顺序固定**（槽位恒定预留 ⇒ 缺段不塌陷）；
      // MS2 起每段可能是**多行** ⇒ 基线由 `wrap.partBaselines` 逐行给（单行时与 MS1 逐字相同）
      const baseYs = wrap.partBaselines(f.parts, inset.y);
      PARTS.forEach((key) => {
        const part = f.parts[key];
        if (!part || !part.lines.length) return;                 // 该段没有文本 ⇒ 不画（槽位仍占）
        const cls = 'mm-node-' + key;
        part.lines.forEach((line, li) => {
          const y = baseYs[key][li];
          const multi = part.lines.length > 1 ? ' data-line="' + li + '/' + part.lines.length + '"' : '';
          if (key === 'badge') {
            const chipH = part.size + 4;
            out.push('<rect class="mm-badge-chip" x="' + fmt(inset.x) + '" y="' + fmt(y - part.size - 2)
              + '" width="' + fmt(part.width + 10) + '" height="' + fmt(chipH) + '" rx="' + fmt(chipH / 2)
              + '" fill="none" stroke="' + esc(stroke) + '" data-badge-chip="' + esc(n.id) + '"/>');
            out.push('<text class="' + cls + '" x="' + fmt(inset.x + 5) + '" y="' + fmt(y) + '"'
              + ' font-family="' + esc(FONT.family) + '" font-size="' + fmt(part.size) + '" fill="' + esc(textColor)
              + '" data-text="' + key + '" data-font-size="' + fmt(part.size) + '"' + multi
              + '>' + esc(line.text) + '</text>');
            return;
          }
          out.push('<text class="' + cls + '" x="' + fmt(inset.x) + '" y="' + fmt(y) + '"'
            + ' font-family="' + esc(FONT.family) + '" font-size="' + fmt(part.size) + '" fill="' + esc(textColor)
            + '" data-text="' + key + '" data-font-size="' + fmt(part.size) + '"' + multi
            + '>' + esc(line.text) + '</text>');
        });
      });
      out.push('</g>');
    });
    out.push('</g>');

    // ---- edges ----
    out.push('<g data-z="edges">');
    // overpass 的白色描边**先画**（它要在所有线之下、又在底色之上）：只给高优先级线画，
    // 低优先级线在交点处已经断了 4px ⇒ 任何一条线在交叉点都**不被另一条线盖住**。
    if (routed && routed.halos && routed.halos.length) {
      out.push('<g data-haloes="1">');
      routed.halos.forEach((h) => {
        out.push('<line data-halo="1" data-edge="' + esc(h.edge) + '" x1="' + fmt(h.x1) + '" y1="' + fmt(h.y1)
          + '" x2="' + fmt(h.x2) + '" y2="' + fmt(h.y2) + '" stroke="#ffffff" stroke-width="' + HALO_WIDTH
          + '" stroke-linecap="butt"/>');
      });
      out.push('</g>');
    }
    edges.forEach((e) => {
      if (!routed) {
        // **MS1 的那一行，逐字不变**（没有布线 ⇒ 产物与 MS1 一致，这是"同输入同输出"的基线）
        out.push('<line data-edge="' + esc(e.id) + '" data-from-port="' + esc(e.fromPort) + '" data-to-port="'
          + esc(e.toPort) + '" x1="' + fmt(e.x1) + '" y1="' + fmt(e.y1) + '" x2="' + fmt(e.x2) + '" y2="'
          + fmt(e.y2) + '" stroke="' + esc(e.color) + '" stroke-width="1.5"'
          + (e.dash ? ' stroke-dasharray="' + esc(e.dash) + '"' : '') + '/>');
      } else {
        // 布线档：一条边 = 一个分组，**承载三样可复算的东西**：
        //   `data-points`（理想折线，交叉数由它独立复算）、`data-seg`（实际画出的段，缺口可量）、
        //   `data-from/data-to`（判"这个交叉是不是共享端点带来的"）
        const pts = e.points || [];
        const ptsAttr = pts.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ');
        out.push('<g data-edge="' + esc(e.id) + '" data-route="' + esc(e.route || 'orthogonal')
          + '" data-from="' + esc(e.from || '') + '" data-to="' + esc(e.to || '') + '" data-from-port="'
          + esc(e.fromPort) + '" data-to-port="' + esc(e.toPort) + '" data-points="' + ptsAttr
          + '" data-cuts="' + fmt(e.cuts || 0) + '">');
        const runs = (e.runs && e.runs.length) ? e.runs : [[[e.x1, e.y1], [e.x2, e.y2]]];
        runs.forEach((r, ri) => {
          out.push('<line data-edge="' + esc(e.id) + '" data-seg="' + ri + '" x1="' + fmt(r[0][0])
            + '" y1="' + fmt(r[0][1]) + '" x2="' + fmt(r[1][0]) + '" y2="' + fmt(r[1][1])
            + '" stroke="' + esc(e.color) + '" stroke-width="1.5"'
            + (e.dash ? ' stroke-dasharray="' + esc(e.dash) + '"' : '') + '/>');
        });
        out.push('</g>');
      }
      // 箭头尖端 = 折线末点；方向取最后一个有长度的段（MS1 的直线也走这条：方向 = 两端连线）
      const ptsAll = (e.points && e.points.length) ? e.points : [[e.x1, e.y1], [e.x2, e.y2]];
      if (e.end) {
        const tip = ptsAll[ptsAll.length - 1];
        const prev = ptsAll[ptsAll.length - 2] || tip;
        const tri = arrowPolygon(prev[0], prev[1], tip[0], tip[1]);
        if (tri) out.push('<polygon data-arrow="end" data-edge="' + esc(e.id) + '" points="'
          + tri.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ') + '" fill="' + esc(e.color) + '"/>');
      }
      if (e.start) {
        const tip = ptsAll[0];
        const next = ptsAll[1] || tip;
        const tri = arrowPolygon(next[0], next[1], tip[0], tip[1]);   // 反向：起点箭头
        if (tri) out.push('<polygon data-arrow="start" data-edge="' + esc(e.id) + '" points="'
          + tri.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ') + '" fill="' + esc(e.color) + '"/>');
      }
    });
    out.push('</g>');

    // ---- edgeLabels ----
    out.push('<g data-z="edgeLabels">');
    edges.forEach((e) => {
      if (typeof e.label !== 'string' || !e.label) return;
      if (!routed) {
        // MS1 的行为：锚在中点、上移 4px（没有避让，本批才补 `C-F3-14`/`15`）
        const mx = (e.x1 + e.x2) / 2;
        const my = (e.y1 + e.y2) / 2;
        out.push('<text class="mm-edge-label" x="' + fmt(mx) + '" y="' + fmt(my - 4) + '" text-anchor="middle"'
          + ' font-family="' + esc(FONT.family) + '" font-size="10" fill="' + THEME.edgeLabel
          + '" data-text="edge-label" data-edge="' + esc(e.id) + '">' + esc(e.label) + '</text>');
        return;
      }
      const lb = e.routedLabel;
      if (!lb) return;
      // `data-box` = 标签**矩形**（判据 7 用它做碰撞：不压框、不压线、不压别的标签）
      out.push('<text class="mm-edge-label" x="' + fmt(lb.x) + '" y="' + fmt(lb.y + lb.h / 2 - 3) + '" text-anchor="middle"'
        + ' font-family="' + esc(FONT.family) + '" font-size="' + tokens.LABEL_FONT_SIZE + '" fill="' + THEME.edgeLabel
        + '" data-text="edge-label" data-edge="' + esc(e.id) + '" data-box="' + fmt(lb.x - lb.w / 2) + ' '
        + fmt(lb.y - lb.h / 2) + ' ' + fmt(lb.w) + ' ' + fmt(lb.h) + '">' + esc(e.label) + '</text>');
    });
    out.push('</g>');

    // ---- annotations（最上）----
    out.push('<g data-z="annotations">');
    annotations.forEach((a) => {
      out.push('<text class="mm-annotation" data-annotation="' + esc(a.id) + '" data-style="' + esc(a.style)
        + '" x="' + fmt(a.x) + '" y="' + fmt(a.y) + '" font-family="' + esc(FONT.family)
        + '" font-size="10" fill="' + THEME.annotation + '" data-text="annotation">' + esc(a.text) + '</text>');
    });
    out.push('</g>');

    out.push('</svg>');

    const report = {
      ok: true,
      zOrder: Z_ORDER.slice(),
      counts: {
        layers: layers.length, containers: containers.length, nodes: nd.nodes.length,
        edges: edges.length, edgeLabels: edges.filter((e) => typeof e.label === 'string' && e.label).length,
        annotations: annotations.length
      },
      // `C-F1-05`：**溢出计数必须为 0**；这里恒 0 是因为放不下就会抛 `E_TEXT_OVERFLOW`（不裁字）
      overflowCount: 0,
      shrunk: shrunkReport,
      widened: widenedReport,
      watermarks: layers.filter((l) => l.watermarkBox).map((l) => ({
        layer: l.id, x: l.watermarkBox.x, y: l.watermarkBox.y, w: l.watermarkBox.w, h: l.watermarkBox.h
      })),
      measure: { approximate: measurer.approximate, note: measurer.note,
        cache: measurer.stats() },
      // MS2：换行档的读数（哪一段换了几行、用的字号）—— 判据 8 就靠它区分"先换行"与"先缩字号"
      wrapped: wrappedReport,
      // MS2：布线读数（crossings 是**几何数出来的**，判据 3 会另写一份 recount 来比它）
      routing: routed ? {
        enabled: true,
        direction: routed.stats ? (graph.direction === 'TB' ? 'TB' : 'LR') : null,
        crossings: routed.stats.crossings,
        expected: routed.stats.expected,
        unexpected: routed.stats.unexpected,
        unexpectedByKind: {
          interleave: routed.crossings.filter((c) => c.why === 'interleave').length,
          sharedEndpoint: routed.crossings.filter((c) => c.why === 'shared-endpoint').length,
          backEdge: routed.crossings.filter((c) => c.why === 'back-edge').length
        },
        crossingPoints: routed.crossings.map((c) => ({ x: c.x, y: c.y, high: c.high, low: c.low,
          expected: c.expected, why: c.why })),
        overpasses: routed.halos.length,
        lanes: routed.stats.lanes,
        cost: routed.stats.cost,
        repairRounds: routed.stats.repairRounds,
        overlaps: routed.overlaps.length,
        touches: routed.touches.length,
        labels: Object.keys(routed.edges).filter((k) => routed.edges[k].label).map((k) => ({
          edge: k, x: routed.edges[k].label.x, y: routed.edges[k].label.y,
          w: routed.edges[k].label.w, h: routed.edges[k].label.h
        }))
      } : { enabled: false },
      problems: routed ? routed.problems.slice() : [],
      degraded: routed ? routed.degraded.slice() : [],
      // 本批**没做**的东西如实写在报告里（"没做"不许靠读者猜）
      notImplemented: ['route:curve', 'interaction', 'export:png', 'export:pdf']
    };
    return { svg: out.join(''), report: report, layout: baseLayout };
  }

  /** 六种形状的**元素**（`C-F1-01`）。每种的判据都能从属性上量出来：
   *  `rect/round/pill` = `<rect>`（圆角 token 不同）、`diamond` = `<polygon>` 四顶点 = 四边中点、
   *  `cylinder` = 柱体 path + 顶部椭圆弧、`row` = rect + 底部分隔线。 */
  function shapeMarkup(type, r, fill, stroke) {
    const common = ' fill="' + esc(fill) + '" stroke="' + esc(stroke) + '" stroke-width="1.5"';
    if (type === 'diamond') {
      const pts = [
        [r.x + r.w / 2, r.y],
        [r.x + r.w, r.y + r.h / 2],
        [r.x + r.w / 2, r.y + r.h],
        [r.x, r.y + r.h / 2]
      ];
      return '<polygon points="' + pts.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ') + '"' + common + '/>';
    }
    if (type === 'cylinder') {
      const cap = Math.min(r.h * CYLINDER_CAP_RATIO, CYLINDER_CAP_MAX);
      const d = 'M ' + fmt(r.x) + ' ' + fmt(r.y + cap)
        + ' A ' + fmt(r.w / 2) + ' ' + fmt(cap) + ' 0 0 1 ' + fmt(r.x + r.w) + ' ' + fmt(r.y + cap)
        + ' L ' + fmt(r.x + r.w) + ' ' + fmt(r.y + r.h - cap)
        + ' A ' + fmt(r.w / 2) + ' ' + fmt(cap) + ' 0 0 1 ' + fmt(r.x) + ' ' + fmt(r.y + r.h - cap)
        + ' Z';
      return '<path d="' + d + '"' + common + '/>'
        + '<path d="M ' + fmt(r.x) + ' ' + fmt(r.y + cap) + ' A ' + fmt(r.w / 2) + ' ' + fmt(cap)
        + ' 0 0 0 ' + fmt(r.x + r.w) + ' ' + fmt(r.y + cap) + '" fill="none" stroke="' + esc(stroke) + '"/>';
    }
    if (type === 'row') {
      return '<rect x="' + fmt(r.x) + '" y="' + fmt(r.y) + '" width="' + fmt(r.w) + '" height="' + fmt(r.h)
        + '"' + common + '/>'
        + '<line x1="' + fmt(r.x) + '" y1="' + fmt(r.y + r.h) + '" x2="' + fmt(r.x + r.w) + '" y2="'
        + fmt(r.y + r.h) + '" stroke="' + esc(stroke) + '" data-row-divider="1"/>';
    }
    const rx = type === 'round' ? RADIUS_ROUND : (type === 'pill' ? r.h / 2 : 0);
    return '<rect x="' + fmt(r.x) + '" y="' + fmt(r.y) + '" width="' + fmt(r.w) + '" height="' + fmt(r.h)
      + '"' + (rx ? ' rx="' + fmt(rx) + '"' : '') + common + '/>';
  }

  return {
    renderDiagram: renderDiagram,
    normalizeDoc: normalizeDoc,
    layoutOf: layoutOf,
    MMDiagramError: MMDiagramError,
    fmt: fmt,
    esc: esc,
    fitPart: fitPart,
    fontLadder: fontLadder,
    shapeInset: shapeInset,
    requiredInnerHeight: requiredInnerHeight,
    outerSizeFor: outerSizeFor,
    portPoint: portPoint,
    autoPorts: autoPorts,
    arrowPolygon: arrowPolygon,
    resolveEdge: resolveEdge,
    resolveContainers: resolveContainers,
    placeWatermark: placeWatermark,
    Z_ORDER: Z_ORDER,
    FONT: FONT,
    MIN_FONT_SIZE: MIN_FONT_SIZE,
    LINE_GAP: LINE_GAP,
    NODE_PAD: NODE_PAD,
    RADIUS_ROUND: RADIUS_ROUND,
    CONTAINER_PAD: CONTAINER_PAD,
    CONTAINER_GAP: CONTAINER_GAP,
    ARROW_LEN: ARROW_LEN,
    ARROW_HALF: ARROW_HALF,
    THEME: THEME
  };
});
