/* ============================================================
 * src/diagram/index.js — 图渲染内核的**唯一入口**（MS1 渲染 + MS2 布局布线）
 * ------------------------------------------------------------
 * 消费者只 `require('./src/diagram/index.js')`，不要逐个文件 require：
 *   · 文件名是会变的实现细节（`schema` / `measure` / `wrap` / `layout` / `route` / `render-svg`
 *     是模块拆分，不是接口）；
 *   · 不变量跨模块成立（形状 / 三段 / z-order / 溢出为 0 / 穿框为 0 / 交叉逐点 overpass）——
 *     入口是"这套东西一起才算数"的落点。
 *
 * 两个渲染入口，**区别只有一件事**：坐标从哪来。
 *   · `render(doc, opts)`     —— **手写坐标**（MS1 基线）：节点带 `rect`，边缺省直连，
 *                                产物与 MS1 **逐字节相同**。传 `opts.routing:'orthogonal'`
 *                                或数据里写 `route:'orthogonal'` 时，在**给定坐标**上绕线。
 *   · `renderAuto(doc, opts)` —— **自动布局 + 正交布线**（MS2 主入口）：节点不必带 `rect`，
 *                                坐标由 `layout.autoLayout` 给（Sugiyama 四步），
 *                                边由 `route.routeAll` 绕（A* + lane + overpass + 标签避让）。
 *
 * 显式意图优先（外部证据 archify 的"用布局判断代替通用自动布局"，我们的用法见
 * `layout.js` 头注释）：`graph.pinned[]` 里且带 `rect` 的节点**位置不被自动布局覆盖**，
 * `report.layout.explicit[]` 逐条点名。将来要接"作者给布局意图"，只换布局策略，不动布线。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./schema.js'), require('./measure.js'), require('./render-svg.js'),
      require('./tokens.js'), require('./wrap.js'), require('./layout.js'), require('./route.js'),
      require('./export-svg.js'), require('./profiles.js')
    );
  } else {
    root.MMDiagram = factory(root.MMDiagramSchema, root.MMDiagramMeasure, root.MMDiagramRender,
      root.MMDiagramTokens, root.MMDiagramWrap, root.MMDiagramLayout, root.MMDiagramRoute,
      root.MMDiagramExport, root.MMDiagramProfiles);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, measure, render, tokens, wrap, layout, route, exporter, profiles) {
  'use strict';

  /** 本内核的接口版本（**不是** `graph.version`、也不是 `meta.formatVersion`）：
   *  形状变了就升它；消费者可以据此判"我按哪一版写的调用"。
   *  MS1 → MS2：新增 `renderAuto` / `layout` / `route` / `recountCrossings` 与一批 token（向后兼容）。 */
  const API_VERSION = 2;

  /**
   * 自动布局 + 正交布线 + 渲染（MS2 主入口）。
   *
   * @param {object} doc `{ graph, nodes }`；节点**可以不带 `rect`**（带了且被 `graph.pinned` 钉住时才生效）
   * @param {object} [opts]
   * @param {Function} [opts.measureText] 注入真测量（与 `render` 同一个口）
   * @param {object} [opts.gap] `{ node, rank }` 覆盖间距（数据里 `graph.gap` 优先）
   * @param {string|number} [opts.direction] 覆盖 `graph.direction`
   * @param {object} [opts.routePenalty] 覆盖 A* 的四项代价（判"调高拐弯惩罚 ⇒ 折点数不增"用）
   * @returns {{svg:string, report:object, layout:object}}
   */
  function renderAuto(doc, opts) {
    const o = Object.assign({}, opts || {});
    const measurer = measure.createMeasurer({ measureText: o.measureText });
    const lay = layout.autoLayout(doc, { measurer: measurer, gap: o.gap, contentMaxW: o.contentMaxW });

    // 把布局算出的 rect 写进**副本**（不改调用方的数据：渲染不许碰数据，`C-I-04` 的延伸）
    const src = doc && typeof doc === 'object' ? doc : {};
    const graphIn = src.graph && typeof src.graph === 'object' ? Object.assign({}, src.graph) : {};
    if (typeof o.direction === 'string') graphIn.direction = o.direction;
    const nodesIn = Array.isArray(src.nodes) ? src.nodes : [];
    const docForRender = {
      graph: graphIn,
      nodes: nodesIn.map((n) => {
        const id = n && n.id;
        const r = lay.rects[id];
        if (!r) return n;
        return Object.assign({}, n, { rect: [r.x, r.y, r.w, r.h] });
      })
    };

    const res = render.renderDiagram(docForRender, Object.assign({}, o, {
      layout: function () { return lay.rects; },
      routing: 'orthogonal',
      // 去环结果要传给布线：交叉的"预期/非预期"分类靠它（判据 2 的口径见 `route.js`）
      reversedEdgeIds: lay.report.reversed
    }));
    res.report.layout = lay.report;
    res.report.notImplemented = res.report.notImplemented.filter((x) => x !== 'layout:auto');
    return res;
  }

  /** 只算布局，不渲染（判据 6"rank 不变"直接读它，不必从 SVG 里反推） */
  function layoutOfDoc(doc, opts) {    const o = opts || {};
    const measurer = measure.createMeasurer({ measureText: o.measureText });
    return layout.autoLayout(doc, { measurer: measurer, gap: o.gap, contentMaxW: o.contentMaxW });
  }

  /** 只算布线，不渲染（判"穿框/通道/交叉"的单元级入口；参数见 `route.routeAll`） */
  function routeEdges(input, opts) {
    const o = opts || {};
    const measurer = measure.createMeasurer({ measureText: o.measureText });
    return route.routeAll(Object.assign({}, input, { measurer: measurer }));
  }

  return {
    API_VERSION: API_VERSION,
    // ---- 渲染（两个入口；区别只有"坐标从哪来"）----
    render: render.renderDiagram,
    renderAuto: renderAuto,
    /** 布局接口的**默认实现**（= 直接用 JSON 里的 `rect`）；自动布局是 `layoutOfDoc` */
    layoutOf: render.layoutOf,
    /** 单条边的几何定稿（**纯函数**：判据可以直接喂一条非法 route 验"响亮拒绝"那条守门） */
    resolveEdge: render.resolveEdge,
    layoutOfDoc: layoutOfDoc,
    routeEdges: routeEdges,
    // ---- 导出（**只有 SVG 这一档**；PNG/PDF 的能力清单如实给 `ok:false` + 缺什么）----
    exportSVG: exporter.exportSVG,
    /** 自动布局那一档的导出：与 `exportSVG` **共用同一份交付自检**（两条坐标来源不许两套口径） */
    exportAuto: function (doc, opts) { return exporter.exportOf(renderAuto(doc, opts)); },
    exportOf: exporter.exportOf,
    exportCapabilities: exporter.exportCapabilities,
    checkStandalone: exporter.checkStandalone,
    utf8Bytes: exporter.utf8Bytes,
    // ---- 主题（`C-F6-01`…`C-F6-04`）：两套 token、对比度、语义类解析 ----
    THEMES: tokens.THEMES,
    THEME_NAMES: tokens.THEME_NAMES,
    THEME_PAIRS: tokens.THEME_PAIRS,
    SEMANTIC_CLASSES: tokens.SEMANTIC_CLASSES,
    SEMANTIC_COLORS: tokens.SEMANTIC_COLORS,
    contrastRatio: tokens.contrastRatio,
    contrastReport: tokens.contrastReport,
    themeKeyDiff: tokens.themeKeyDiff,
    resolveSemantic: tokens.resolveSemantic,
    // ---- 剖面（MS4 的纯逻辑那一半）：能力集合展开 + 控件面契约 ----
    PROFILES: profiles.PROFILES,
    PROFILES_REQUIRED: profiles.REQUIRED,
    PROFILES_MARKS: profiles.MARKS,
    expandProfile: profiles.expandProfile,
    profileSupports: profiles.supports,
    profileMark: profiles.markOf,
    controlsFor: profiles.controlsFor,
    profileIssues: profiles.profileIssues,
    profileCapabilities: profiles.allCapabilities,
    capabilityCount: profiles.capabilityCount,
    ProfileError: profiles.ProfileError,
    // ---- 校验（`src/schema.js` 也用这一份，判据不分叉）----
    validateGraph: schema.validateGraph,
    validateGraphRefs: schema.validateGraphRefs,
    // ---- 文本测量（缺省是**确定**的近似器；可注入真 measureText）----
    createMeasurer: measure.createMeasurer,
    approxMeasureText: measure.approxMeasureText,
    APPROX_NOTE: measure.APPROX_NOTE,
    // ---- 换行（`C-F1-03`：判据要自己复算断点，所以这条是公开的纯函数）----
    wrapText: wrap.wrapText,
    segmentsOf: wrap.segmentsOf,
    fitPartInBox: wrap.fitPartInBox,
    measureNodeBox: wrap.measureNodeBox,
    partBaselines: wrap.partBaselines,
    // ---- 布局/布线的纯函数（判据用它们**独立**复算，不读渲染器的中间变量）----
    removeCycles: layout.removeCycles,
    assignRanks: layout.assignRanks,
    orderLayers: layout.orderLayers,
    totalCrossings: layout.totalCrossings,
    alignSubAxis: layout.alignSubAxis,
    simplifyPolyline: route.simplify,
    // ---- 曲线（`C-F3-05`）：控制点算式与采样都是公开的纯函数（判据按同一式子复算）----
    curveControl: route.curveControl,
    flattenCubic: route.flattenCubic,
    cubicAt: route.cubicAt,
    SIDE_NORMAL: route.SIDE_NORMAL,
    // ---- 容器框的语义（框架 ≠ 障碍）：判据要能直接喂折线验"沿边框跑" ---- 
    frameBorderRuns: route.frameBorderRuns,
    borderOverlap: route.borderOverlap,
    overpassOf: route.overpassOf,
    CURVE_MIN_K: tokens.CURVE_MIN_K,
    CURVE_K_DIV: tokens.CURVE_K_DIV,
    CURVE_SAMPLES: tokens.CURVE_SAMPLES,
    // ---- 报错类型（调用方按 `code` 判，不按文案判）----
    MMDiagramError: render.MMDiagramError,
    ERROR_CODES: tokens.ERROR_CODES,
    // ---- 取值表（文档与测试从这里取，别抄字面量）----
    SHAPES: schema.SHAPES,
    PORTS: schema.PORTS,
    EDGE_ROUTES: schema.EDGE_ROUTES,
    ROUTE_IMPLEMENTED: schema.ROUTE_IMPLEMENTED,
    GRAPH_FIELDS: schema.GRAPH_FIELDS,
    GAP_FIELDS: schema.GAP_FIELDS,
    Z_ORDER: render.Z_ORDER,
    FONT: render.FONT,
    MIN_FONT_SIZE: render.MIN_FONT_SIZE,
    LINE_GAP: render.LINE_GAP,
    LINE_LEAD: tokens.LINE_LEAD,
    MAX_LINES: tokens.MAX_LINES,
    PARTS: tokens.PARTS,
    CONTAINER_PAD: render.CONTAINER_PAD,
    CONTAINER_GAP: render.CONTAINER_GAP,
    // ---- MS2 的 token（判据里"同通道 ≥ 8px""断开 4px""白描 4px"都从这里取）----
    LANE_GAP: tokens.LANE_GAP,
    FANOUT_GAP: tokens.FANOUT_GAP,
    GAP_HALF: tokens.GAP_HALF,
    HALO_WIDTH: tokens.HALO_WIDTH,
    LABEL_FONT_SIZE: tokens.LABEL_FONT_SIZE,
    LABEL_HEIGHT: tokens.LABEL_HEIGHT,
    LABEL_PATH_CLEARANCE: tokens.LABEL_PATH_CLEARANCE,
    NODE_GAP_DEFAULT: tokens.NODE_GAP_DEFAULT,
    RANK_GAP_DEFAULT: tokens.RANK_GAP_DEFAULT,
    BEND_PENALTY: tokens.BEND_PENALTY,
    CROSS_PENALTY: tokens.CROSS_PENALTY,
    HUG_PENALTY: tokens.HUG_PENALTY,
    /** 形状的"文字可用区"（判据要**独立复算**溢出时用它，别自己再写一份 inset 公式） */
    shapeInset: render.shapeInset
  };
});
