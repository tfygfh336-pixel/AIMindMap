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
   *  MS1 → MS2：新增 `renderAuto` / `layout` / `route` / `recountCrossings` 与一批 token（向后兼容）。
   *  MS2 → 收口批（API_VERSION 3）：`render` / `renderAuto` 现在都过 §4.2 的**形状取值收窄**
   *    （缺省 `degrade`，报告 `report.profileShapes`）；新增 `relationsOf`（关系层几何）。
   *    两者对**不带 `graph.profile`** 的输入都是空操作 ⇒ MS1/MS2 的逐字节基线不变。 */
  const API_VERSION = 3;

  /**
   * **§4.2 取值收窄的落地**（本批的新入口；`render` / `renderAuto` 都先过它）。
   *
   * 它只做一件纯逻辑的事：按剖面把节点的 `type` 收窄到**该剖面允许的画法形状**，
   * 并把"谁被换了、从什么换成什么"逐条交出去。**不改数据**（返回的是副本）。
   *
   * 三种处置（`opts.shapePolicy`）：
   *   · `'degrade'`（**缺省**）：不在允许集 ⇒ 降到语义最近且允许的那一型，报告里**逐条点名**
   *     `W_SHAPE_NARROWED`。为什么缺省是它：用户要的是"**每种模式只提供它需要的功能**"，
   *     不是"画出来但嘴上提醒" ⇒ 收窄要真的落到画法上。
   *   · `'report'`：**画法不动**，但把每个越界节点逐条记进 `report.profileShapes.outOfProfile[]`
   *     与 `report.degraded[]`（`W_SHAPE_OUT_OF_PROFILE`）。给"想看见全部、但要知道越界"的调用方留着。
   *   · `'reject'`：不在允许集 ⇒ 抛 `E_PROFILE_SHAPE`（稳定码 + `allowed` + `fixes`）。
   *     给"宁可画不出也不许换画法"的调用方（导出门禁、AI 生成前的自检）用。
   *   · 例外：剖面把 `C-F1-01` 判 ✗（`mindmap` / `path`）⇒ **无论 policy 都抛** ——
   *     那不是"收窄到了别的形状"，是"这个剖面没有形状这条能力"，降级等于把它画出来。
   *
   * @param {object} doc `{graph, nodes}`
   * @param {object} [opts]
   * @returns {{doc:object, report:object}} `report` 形状见函数体
   *   （`profile/policy/allowed/narrowed[]/outOfProfile[]/degraded[]`）
   * @throws {MMDiagramError} `E_SHAPE_POLICY`（policy 取值非法）/ `E_PROFILE_SHAPE`（拒绝档或空允许集）
   */
  function applyProfileShapes(doc, opts) {
    const o = opts || {};
    const src = doc && typeof doc === 'object' ? doc : {};
    const graphIn = src.graph && typeof src.graph === 'object' ? src.graph : {};
    const profile = typeof o.profile === 'string' ? o.profile
      : (typeof graphIn.profile === 'string' ? graphIn.profile : null);
    const policy = o.shapePolicy === undefined ? 'degrade' : o.shapePolicy;
    if (profiles.SHAPE_POLICIES.indexOf(policy) < 0) {
      throw new render.MMDiagramError('E_SHAPE_POLICY',
        'opts.shapePolicy 只能是 ' + profiles.SHAPE_POLICIES.join(' / ') + '（收到 '
        + JSON.stringify(o.shapePolicy) + '）—— 未知处置**不静默当降级**：那会让"写错了"看起来像"选了严格档"',
        { object: { shapePolicy: o.shapePolicy }, allowed: profiles.SHAPE_POLICIES.slice() });
    }
    const report = { profile: profile, policy: policy, allowed: [], narrowed: [], outOfProfile: [],
      degraded: [] };
    if (!profile) return { doc: src, report: report };          // 没有剖面 = 与从前逐字节相同（MS1 基线）
    const allowed = profiles.shapesFor(profile);
    report.allowed = allowed;
    const nodesIn = Array.isArray(src.nodes) ? src.nodes : [];
    let touched = false;
    const nodesOut = nodesIn.map((n) => {
      if (!n || typeof n !== 'object') return n;
      const one = profiles.narrowShape(profile, n.type);
      if (one.rejected) {
        throw new render.MMDiagramError('E_PROFILE_SHAPE',
          '节点 ' + JSON.stringify(n.id) + ' 带 type = ' + JSON.stringify(n.type) + '，而剖面 ' + profile
          + ' 把 `C-F1-01` 判 ✗ ⇒ 这个剖面**没有形状这条能力**（设计 §3.2/§3.3）。'
          + '这不是"收窄到另一个形状"，所以不降级：换一个允许形状的剖面，或把这份数据交给树渲染器',
          { object: { node: n.id, type: n.type, profile: profile }, allowed: [],
            fixes: ['换到 ' + profiles.PROFILES.filter(function (p) { return profiles.shapesFor(p).length; }).join(' / '),
              '改用树渲染器（这个剖面的 `C-F3-01` 也是 ✗，本来就不该走本内核）'] });
      }
      if (!one.narrowed) return n;
      if (policy === 'reject') {
        throw new render.MMDiagramError('E_PROFILE_SHAPE',
          '节点 ' + JSON.stringify(n.id) + ' 的 type = ' + JSON.stringify(n.type) + ' 不在剖面 ' + profile
          + ' 的允许集 [' + allowed.join(' / ') + '] 里（设计 §4.2 的取值收窄）。'
          + '当前 `shapePolicy: "reject"` ⇒ **拒绝而不换画法**',
          { object: { node: n.id, type: n.type, profile: profile }, allowed: allowed.slice(),
            fixes: ['把该节点改成 ' + allowed.join(' / ') + ' 之一',
              '传 shapePolicy: "degrade"（按 §4.2 降级，报告里点名）',
              '换到 complex / module 剖面（它们六型全给）'] });
      }
      if (policy === 'report') {
        // 画法不动，但**不许静默**：逐条点名（这条通路给"画布先保持现状、只求可判"的调用方）
        report.outOfProfile.push({ id: n.id, from: one.from, allowed: allowed.slice() });
        report.degraded.push('W_SHAPE_OUT_OF_PROFILE: 节点 ' + n.id + ' 的 type ' + one.from
          + ' 不在剖面 ' + profile + ' 的允许集 [' + allowed.join(' / ') + '] 里'
          + '（设计 §4.2）；当前 `shapePolicy: "report"` ⇒ **画法未改，只登记**');
        return n;
      }
      touched = true;
      report.narrowed.push({ id: n.id, from: one.from, to: one.to });
      report.degraded.push('W_SHAPE_NARROWED: 节点 ' + n.id + ' 的 type ' + one.from + ' → ' + one.to
        + '（剖面 ' + profile + ' 只允许 ' + allowed.join(' / ') + '，设计 §4.2）');
      return Object.assign({}, n, { type: one.to });
    });
    if (!touched) return { doc: src, report: report };          // 一格都没换 ⇒ 原对象原样回去（逐字节稳）
    const docOut = Object.assign({}, src, { nodes: nodesOut });
    return { doc: docOut, report: report };
  }

  /** 把收窄读数并入 `res.report`（**渲染报告是唯一出口**：调用方不必再算一遍） */
  function mergeShapeReport(res, shape) {
    if (!res || !res.report) return res;
    res.report.profileShapes = shape.report;
    // 降级条目直接进 `degraded`（与其它降级同一条通路：`report.degraded` 是"降级过什么"的唯一家）
    if (shape.report.degraded.length) res.report.degraded = res.report.degraded.concat(shape.report.degraded);
    return res;
  }

  /**
   * 自动布局 + 正交布线 + 渲染（MS2 主入口）。
   *
   * @param {object} doc `{ graph, nodes }`；节点**可以不带 `rect`**（带了且被 `graph.pinned` 钉住时才生效）
   * @param {object} [opts]
   * @param {Function} [opts.measureText] 注入真测量（与 `render` 同一个口）
   * @param {object} [opts.gap] `{ node, rank }` 覆盖间距（数据里 `graph.gap` 优先）
   * @param {string|number} [opts.direction] 覆盖 `graph.direction`
   * @param {object} [opts.routePenalty] 覆盖 A* 的四项代价（判"调高拐弯惩罚 ⇒ 折点数不增"用）
   * @param {string} [opts.shapePolicy] `degrade`（缺省）/ `reject`；见 `applyProfileShapes`
   * @returns {{svg:string, report:object, layout:object}}
   */
  function renderAuto(doc, opts) {
    const o = Object.assign({}, opts || {});
    const shape = applyProfileShapes(doc, o);                   // §4.2 收窄**必须在布局之前**（型影响内接区与换行）
    const docIn = shape.doc;
    const measurer = measure.createMeasurer({ measureText: o.measureText });
    const lay = layout.autoLayout(docIn, { measurer: measurer, gap: o.gap, contentMaxW: o.contentMaxW,
      offsets: o.offsets });

    // 把布局算出的 rect 写进**副本**（不改调用方的数据：渲染不许碰数据，`C-I-04` 的延伸）
    const src = docIn && typeof docIn === 'object' ? docIn : {};
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
    mergeShapeReport(res, shape);
    return res;
  }

  /**
   * **手写坐标**入口（MS1 基线）＋ §4.2 收窄。
   * 与 `renderAuto` 的唯一区别是"坐标从哪来"；收窄/报告/错误码完全同一套。
   */
  function renderWithProfile(doc, opts) {
    const o = Object.assign({}, opts || {});
    const shape = applyProfileShapes(doc, o);
    const res = render.renderDiagram(shape.doc, o);
    mergeShapeReport(res, shape);
    return res;
  }

  /** 只算布局，不渲染（判据 6"rank 不变"直接读它，不必从 SVG 里反推） */
  function layoutOfDoc(doc, opts) {    const o = opts || {};
    const measurer = measure.createMeasurer({ measureText: o.measureText });
    return layout.autoLayout(doc, { measurer: measurer, gap: o.gap, contentMaxW: o.contentMaxW,
      offsets: o.offsets });
  }

  /* ==================================================================
   * 关系层几何（丙：**端点规则只此一份**）
   * ==================================================================
   * 背景（`.review/20261068-图能力收尾/` 的读数）：关系层（关联笔记 / 相关知识点那些线）
   * 原先是**节点中心到中心**画的（`M ra.cx,ra.cy L rb.cx,rb.cy`），而图渲染器的边端点是
   * **节点边界上的端口点**（`route.autoPorts` + `route.portPoint`）。两套规则 ⇒
   * "端点落在节点矩形边界上（±1px）"这条判据在关系层上恒不成立（偏差 = 中心到边界沿线距离）。
   *
   * 本函数把**端点规则统一成图渲染器那一套**，并且**与坐标系无关**：
   * 它只吃"节点 id → 矩形"这一张表 —— 谁在哪个坐标系里，谁自己给矩形。于是
   *   · 关系层（jsMind 逻辑坐标）与图渲染层（SVG 坐标系）**各给自己的矩形**，
   *     算出来的端点都**落在各自的节点边界上**；
   *   · 不需要任何"坐标系换算"，也就不存在"两套坐标对不上"这件事。
   *
   * @param {object} input `{ nodes:[{id, rect:[x,y,w,h]|{x,y,w,h}}], relations:[{from,to,kind?,label?}] }`
   * @returns {{lines:Array, report:object}} `lines[i] = {id, from, to, kind, label, points, d}`
   * @throws {MMDiagramError} `E_RELATION_REF`（端点指向不存在的节点 / 形状不合法）—— **不静默丢线**
   */
  function relationsOf(input) {
    const src = input && typeof input === 'object' ? input : {};
    const rects = new Map();
    const badRects = [];
    (Array.isArray(src.nodes) ? src.nodes : []).forEach((n, i) => {
      if (!n || typeof n.id !== 'string' || !n.id) { badRects.push('nodes[' + i + '] 没有 id'); return; }
      const r = n.rect;
      const box = Array.isArray(r)
        ? { x: r[0], y: r[1], w: r[2], h: r[3] }
        : (r && typeof r === 'object' ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
      if (!box || !['x', 'y', 'w', 'h'].every((k) => typeof box[k] === 'number' && Number.isFinite(box[k]))) {
        badRects.push('nodes[' + i + ']（' + n.id + '）的 rect 不是四个有限数'); return;
      }
      rects.set(n.id, box);
    });
    if (badRects.length) {
      throw new render.MMDiagramError('E_RELATION_REF',
        '关系层几何：节点矩形不合法（' + badRects.length + ' 条）：' + badRects.join('；'),
        { object: { nodes: badRects }, fixes: ['给每个节点 rect: [x, y, w, h]'] });
    }
    const rels = Array.isArray(src.relations) ? src.relations : [];
    const lines = [];
    const skipped = [];
    const endpoints = [];
    rels.forEach((r, i) => {
      const at = 'relations[' + i + ']';
      if (!r || typeof r !== 'object') {
        throw new render.MMDiagramError('E_RELATION_REF', at + ' 必须是对象 {from, to}',
          { object: { index: i } });
      }
      if (typeof r.from !== 'string' || typeof r.to !== 'string' || !rects.has(r.from) || !rects.has(r.to)) {
        // 端点不在图上（折叠 / 跨项目）：**不静默丢** —— 交回去由调用方决定怎么告知用户
        skipped.push({ at: at, from: r.from, to: r.to,
          why: (!rects.has(r.from) ? 'from 不在图上' : 'to 不在图上') });
        return;
      }
      if (r.from === r.to) {                          // 自关系：一条零长线没有几何，如实登记
        skipped.push({ at: at, from: r.from, to: r.to, why: '自关系（from === to）没有可画的线段' });
        return;
      }
      const a = rects.get(r.from);
      const b = rects.get(r.to);
      const ports = route.autoPorts({ rect: a }, { rect: b });
      const pa = route.portPoint({ rect: a }, ports.from);
      const pb = route.portPoint({ rect: b }, ports.to);
      const line = {
        id: 'rel:' + String(lines.length).padStart(3, '0'),
        from: r.from, to: r.to,
        kind: typeof r.kind === 'string' ? r.kind : 'link',
        label: typeof r.label === 'string' ? r.label : undefined,
        fromPort: ports.from, toPort: ports.to,
        points: [[pa.x, pa.y], [pb.x, pb.y]],
        d: 'M' + pa.x + ',' + pa.y + ' L' + pb.x + ',' + pb.y
      };
      lines.push(line);
      endpoints.push({ id: line.id, from: r.from, to: r.to,
        a: { x: pa.x, y: pa.y }, b: { x: pb.x, y: pb.y },
        devPx: { from: boundaryDev(a, pa), to: boundaryDev(b, pb) } });
    });

    /* "不出现线飞到画布外"：画布 = **所有节点矩形的并集**（关系层没有别的边界可用）。
     * 端点落在节点边界上 ⇒ 必然在并集内；这里**现算**一份读数，而不是"论证它必然为 0"。 */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rects.forEach((r) => {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    });
    const canvas = Number.isFinite(minX)
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : { x: 0, y: 0, w: 0, h: 0 };
    let outCount = 0;
    let outMaxPx = 0;
    const outPts = [];
    lines.forEach((l) => {
      l.points.forEach((p) => {
        const dx = Math.max(0, Math.max(canvas.x - p[0], p[0] - (canvas.x + canvas.w)));
        const dy = Math.max(0, Math.max(canvas.y - p[1], p[1] - (canvas.y + canvas.h)));
        const out = Math.hypot(dx, dy);
        if (out > 0) {
          outCount++;
          outMaxPx = Math.max(outMaxPx, out);
          outPts.push({ id: l.id, x: p[0], y: p[1], outPx: out });
        }
      });
    });
    const maxDev = endpoints.reduce((m, e) => Math.max(m, e.devPx.from, e.devPx.to), 0);
    return {
      lines: lines,
      report: {
        count: lines.length,
        skipped: skipped,
        endpoints: endpoints,
        maxDevPx: maxDev,
        onBoundary: maxDev <= 1,                       // 判据"端点落在节点矩形边界上（±1px）"
        canvas: canvas,
        outOfCanvas: { count: outCount, maxPx: outMaxPx, points: outPts },
        rule: 'route.autoPorts + route.portPoint（与图渲染器的直连边同一套端点规则）'
      }
    };
  }

  /** 点到矩形边界的距离：在边界上 ⇒ 0；点在内部 ⇒ 到最近一条边的距离；在外部 ⇒ 到矩形的距离。
   *  `relationsOf` 的判据（±1px）就是读它 —— 判据与实现共用一份算式，但**算式本身可独立复算**。 */
  function boundaryDev(rect, p) {
    const eps = 1e-9;
    const inX = p.x >= rect.x - eps && p.x <= rect.x + rect.w + eps;
    const inY = p.y >= rect.y - eps && p.y <= rect.y + rect.h + eps;
    if (!inX || !inY) {
      const dx = Math.max(rect.x - p.x, p.x - (rect.x + rect.w), 0);
      const dy = Math.max(rect.y - p.y, p.y - (rect.y + rect.h), 0);
      return Math.hypot(dx, dy);
    }
    return Math.min(
      Math.abs(p.x - rect.x), Math.abs(p.x - (rect.x + rect.w)),
      Math.abs(p.y - rect.y), Math.abs(p.y - (rect.y + rect.h))
    );
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
    render: renderWithProfile,
    renderAuto: renderAuto,
    /** §4.2 取值收窄的**纯逻辑**入口（判据可以直接喂形状 / 只看报告，不必起渲染） */
    applyProfileShapes: applyProfileShapes,
    shapesForProfile: profiles.shapesFor,
    narrowShapeForProfile: profiles.narrowShape,
    PROFILE_SHAPES: profiles.SHAPES_BY_PROFILE,
    PROFILE_SHAPE_FALLBACK: profiles.SHAPE_FALLBACK,
    SHAPE_POLICIES: profiles.SHAPE_POLICIES,
    // ---- 关系层几何（丙：端点规则与图渲染器同一套，且与坐标系无关）----
    relationsOf: relationsOf,
    boundaryDev: boundaryDev,
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
