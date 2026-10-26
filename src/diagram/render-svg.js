/* ============================================================
 * src/diagram/render-svg.js — **MS1 渲染内核**：手写坐标的 JSON → SVG 字符串
 * ------------------------------------------------------------
 * 边界（父批 §一 的"明令不做"，做了就是越界）：
 *   ❌ 自动布局（Sugiyama / rank）  ❌ 正交布线 / 通道 / 交叉 / overpass
 *   ❌ 交互（缩放/平移/hover/高亮）  ❌ 导出 PNG/PDF（本模块只产 SVG 字符串）
 *   ❌ 任何 I/O（不读盘、不写盘、不碰进程、不碰 DOM）—— 吃 JSON、吐字符串
 *   ✅ 但**留接口**：`orthogonal` / `curve` **响亮拒绝**（`E_ROUTE_UNSUPPORTED`），
 *      而不是静默画成直线；布局走 `layoutOf(doc)` 的默认实现（= 直接用 JSON 里的 `rect`），
 *      MS2 换布局算法时只换它，渲染与判据不动。
 *
 * 判据出处（设计 `docs/DIAGRAM-MODES.md` §2 的编号，改渲染前先对一遍）：
 *   `C-F1-01` 六形状 · `C-F1-02` 三段式 · `C-F1-04` 缩字号（下限 8.5）·
 *   `C-F1-05`【必备】文本永不溢出 · `C-F2-01`…`C-F2-06` 容器/层带 · `C-F3-02` 端口锚点 ·
 *   `C-F3-04` 路由 straight · `C-F3-07`/`C-F3-08` 箭头两端独立 · `C-F9-02` SVG 结构稳定
 *
 * 三条**可量**的判据口径（"看起来像一张图"不算证据，父批 §七 第 1 条）：
 *   ① **z-order 判的是 SVG 里元素的顺序**（6 个 `g[data-z]` 逐字）：
 *      `layers, containers, nodes, edges, edgeLabels, annotations`；
 *   ② **容器 stack 的高度是算式**：子项高之和 + padding×2 + gap×（n−1），不是"看着差不多"；
 *   ③ **溢出前后的读取值**：每个文本元素都带 `data-font-size`，节点只要放过缩字号/加宽，
 *      报告里就有 `shrunk[] / widened[]` 的**前后读数**；溢出计数恒为 0（否则**响亮报错**）。
 *
 * 确定性（`C-F9-02` / `C-F4-04`）：零时钟、零随机、零 `Map` 迭代顺序依赖（一律按数据数组序；
 * 而且节点顺序被打乱时坐标不变 —— 坐标来自**按 id 的查表**，不来自"第几个"）。
 * 数字一律经 `fmt()` 归一（3 位小数、去尾零、`-0` 归一成 `0`）⇒ 同一份 JSON 两跑逐字节相同。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./measure.js'), require('./schema.js'));
  } else {
    root.MMDiagramRender = factory(root.MMDiagramMeasure, root.MMDiagramSchema);
  }
})(typeof self !== 'undefined' ? self : this, function (measure, diagramSchema) {
  'use strict';

  /* ==================================================================
   * 取值表（**唯一一处**：几何 token、字号阶梯、z-order 都只在这里定义）
   * ================================================================== */

  /** z-order **逐字**（父批 §一 第 7 条给的就是这一串，别改写法）。
   *  判据：SVG 里这 6 个 `g[data-z]` 的**元素顺序**必须与它逐字相同。 */
  const Z_ORDER = Object.freeze(['layers', 'containers', 'nodes', 'edges', 'edgeLabels', 'annotations']);

  /** 字号阶梯：三段**各自独立**（`C-F1-02`）。缩小只能发生在这三个阶段内的"逐档下调"。 */
  const FONT = Object.freeze({ family: 'system-ui, sans-serif', title: 14, subtitle: 11, badge: 10 });
  /** 缩字号下限（`C-F1-04`："字号 ≥ 8.5"是**任何情况**下的硬下界） */
  const MIN_FONT_SIZE = 8.5;
  /** 每一档调多少（1px 一档；最后一档直接落到 8.5 ⇒ 阶梯闭合） */
  const FONT_STEP = 1;
  /** 三段的行间距（固定值 ⇒ 缺任一段时其余两段的位置**不变**，`C-F1-02` 的"不塌陷"） */
  const LINE_GAP = 4;

  /** 节点内边距 */
  const NODE_PAD = 8;
  /** 圆角 token（`C-F1-01`："圆角半径按类型取固定 token"）：`round` = 8，`pill` = 高的一半 */
  const RADIUS_ROUND = 8;
  /** 圆柱两端的椭圆高度占比与上限（固定 ⇒ 可复算） */
  const CYLINDER_CAP_RATIO = 0.2;
  const CYLINDER_CAP_MAX = 16;
  /** 容器内边距与子项间距的缺省值（数据可覆盖；写在这里是为了"缺省也是确定的"） */
  const CONTAINER_PAD = 12;
  const CONTAINER_GAP = 8;
  /** 箭头三角（末端指向路径末点）：长度与半宽 */
  const ARROW_LEN = 10;
  const ARROW_HALF = 4.5;
  /** 画布外扩（viewBox 用；固定值 ⇒ 同输入同 viewBox） */
  const CANVAS_MARGIN = 16;
  /** 浮点比较容差（只在"放得下吗"这一处用，**不参与输出**） */
  const EPS = 1e-9;
  /** 几何自检最多重排几轮（与 `C-A-07` 的"≤3 轮"同口径：轮数是个可判的数） */
  const MAX_FIT_ROUNDS = 3;
  /** 单个节点的**外接框宽度上限**。为什么要有它：没有上限时"加宽节点"这个兜底**永远成功**
   *  ⇒ `E_TEXT_OVERFLOW`（父批 §一 第 9 条要求的"再不行就响亮报错"）就成了**不可达的死路**，
   *  而"写了却不可达"正是本工程反复治的"判据在空转"。2000px 是个可判的数：一个节点宽到 2000
   *  已经不是"一张图里的一个框"了 —— 到这里就该让人改数据，而不是让渲染器默默画一条两里长的框。 */
  const MAX_NODE_W = 2000;

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

  /** 报错的**唯一**类型（带 `code`：调用方按码判，不按文案判 —— 与工程的错误码口径一致） */
  class MMDiagramError extends Error {
    constructor(code, message, detail) {
      super(message);
      this.name = 'MMDiagramError';
      this.code = code;
      this.detail = detail || {};
    }
  }

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

  /** 字号阶梯：从 base 逐档下调，**最后一档恒为 8.5**（不是"刚好碰到"）。 */
  function fontLadder(base) {
    const out = [];
    for (let s = base; s > MIN_FONT_SIZE + EPS; s -= FONT_STEP) out.push(Math.round(s * 10) / 10);
    if (Math.abs(out[out.length - 1] - MIN_FONT_SIZE) > EPS) out.push(MIN_FONT_SIZE);
    return out;
  }

  /**
   * 单段文本的"塞进 maxW"求解（`C-F1-04` 的阶梯 + `C-F1-05` 的判据都在这里）。
   * 返回 `overflow`（>0 = 已经在最小字号下仍放不下 ⇒ 调用方必须加宽或响亮报错）。
   */
  function fitPart(text, baseSize, maxW, measurer) {
    const ladder = fontLadder(baseSize);
    for (let i = 0; i < ladder.length; i++) {
      const size = ladder[i];
      const w = measurer.widthOf(text, size, FONT.family);
      if (w <= maxW + EPS) return { size: size, width: w, shrunk: size !== baseSize, overflow: 0 };
    }
    const w = measurer.widthOf(text, MIN_FONT_SIZE, FONT.family);
    return { size: MIN_FONT_SIZE, width: w, shrunk: MIN_FONT_SIZE !== baseSize, overflow: w - maxW };
  }

  /* ==================================================================
   * 形状几何（`C-F1-01`）：**六种**，圆角 token 固定，内接文本区一并算出来
   * ================================================================== */

  /**
   * 形状的"文字可用区"（inset）。
   * 为什么要按形状算而不是一律 `rect − padding`：`diamond` 的内接矩形只有一半宽高、
   * `cylinder` 的两端是椭圆盖 ⇒ 用同一个 padding 会让字压在斜边/弧上（"看着没出框"但**出了形**）。
   */
  function shapeInset(rect, type) {
    const x = rect.x;
    const y = rect.y;
    const w = rect.w;
    const h = rect.h;
    if (type === 'diamond') {
      // 菱形（四个顶点 = 四边中点）的最大内接轴对齐矩形 = 半宽 × 半高，居中
      return { x: x + w / 4, y: y + h / 4, w: w / 2, h: h / 2, kind: 'diamond' };
    }
    if (type === 'cylinder') {
      const cap = Math.min(h * CYLINDER_CAP_RATIO, CYLINDER_CAP_MAX);
      return { x: x + NODE_PAD, y: y + cap, w: w - 2 * NODE_PAD, h: h - 2 * cap, cap: cap, kind: 'cylinder' };
    }
    if (type === 'row') {
      // 表行：左右到底（表行本来就是"框到框"），上下留半个 padding
      return { x: x + NODE_PAD, y: y + NODE_PAD / 2, w: w - 2 * NODE_PAD, h: h - NODE_PAD, kind: 'row' };
    }
    return { x: x + NODE_PAD, y: y + NODE_PAD, w: w - 2 * NODE_PAD, h: h - 2 * NODE_PAD, kind: type };
  }

  /** 三段式需要的最小内接高度（**三段槽位恒定预留** ⇒ 缺一段时其他段不塌陷，`C-F1-02`） */
  function requiredInnerHeight() {
    return FONT.title + LINE_GAP + FONT.subtitle + LINE_GAP + FONT.badge;
  }

  /** 内接尺寸 → 外形尺寸（缩字号/加宽之后要把"要多大内接框"翻回"要多大外形框"）。
   *  ⚠️ `cylinder` 必须**解出来**而不是迭代试：cap 随 h 变化 ⇒ 迭代会撞上"每轮都差一点点"，
   *  于是 `MAX_FIT_ROUNDS` 用完还差 —— 那是把算式问题伪装成不收敛。闭式解：
   *  h·(1−2·ratio) ≥ innerH（cap 未到上限时）或 h = innerH + 2·capMax（cap 封顶后）。 */
  function outerSizeFor(type, innerW, innerH) {
    if (type === 'diamond') return { w: innerW * 2, h: innerH * 2 };
    if (type === 'cylinder') {
      const hUncapped = innerH / (1 - 2 * CYLINDER_CAP_RATIO);
      const capCapH = CYLINDER_CAP_MAX / CYLINDER_CAP_RATIO;       // cap 刚好封顶时的高度（16 / 0.2 = 80）
      return { w: innerW + 2 * NODE_PAD, h: hUncapped <= capCapH ? hUncapped : innerH + 2 * CYLINDER_CAP_MAX };
    }
    if (type === 'row') return { w: innerW + 2 * NODE_PAD, h: innerH + NODE_PAD };
    return { w: innerW + 2 * NODE_PAD, h: innerH + 2 * NODE_PAD };
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
   * 给一个节点定稿：先按声明 rect 试排 → 放不下就缩字号（下限 8.5）→ 还不行就**加宽/加高**
   * → 仍不行 **响亮报错**（`E_TEXT_OVERFLOW`）。**任何情况下不裁字、不叠字**。
   * @returns {{rect:object, inset:object, parts:object, widened:boolean, shrunk:Array}}
   */
  function fitNode(node, measurer) {
    let rect = { x: node.rect.x, y: node.rect.y, w: node.rect.w, h: node.rect.h };
    let widened = false;
    let shrunk = [];
    let parts = null;
    let inset = null;

    for (let round = 0; round <= MAX_FIT_ROUNDS; round++) {
      inset = shapeInset(rect, node.type);
      // 宽高都不许为负（形状内接区可能被声明得比 padding 还小 ⇒ 那不是"排版问题"，是数据问题）
      const availW = Math.max(0, inset.w);
      const fitted = {};
      const roundShrunk = [];
      let overflowW = 0;
      ['title', 'subtitle', 'badge'].forEach((key) => {
        const text = node[key];
        if (typeof text !== 'string' || !text) return;          // 缺省 ⇒ 不画，但槽位仍预留
        const base = key === 'title' ? FONT.title : (key === 'subtitle' ? FONT.subtitle : FONT.badge);
        const r = fitPart(text, base, availW, measurer);
        fitted[key] = r;
        if (r.overflow > overflowW) overflowW = r.overflow;
        if (r.shrunk && r.overflow <= 0) roundShrunk.push({ part: key, from: base, to: r.size });
      });
      // 高度：三段槽位恒定预留 ⇒ 内接高不够就长高（这是"不裁字"的另一半）
      const needH = requiredInnerHeight();
      const needW = overflowW > 0 ? availW + overflowW : availW;
      const outer = outerSizeFor(node.type, Math.max(needW, 1), Math.max(needH, 1));
      if (outer.w > MAX_NODE_W + EPS) {
        // 加宽这个兜底也有上界：到这儿就是"文案太长"，不是"排版放不下" —— 响亮说不出来路
        throw new MMDiagramError('E_TEXT_OVERFLOW',
          '节点 ' + node.id + ' 的文本在最小字号 ' + MIN_FONT_SIZE + 'px 下需要 ' + fmt(outer.w)
          + 'px 宽，超过单节点上限 ' + MAX_NODE_W + 'px —— 本内核**不裁字、也不无限加宽**：'
          + '缩短文案，或把它拆成多个节点（裁决见 tests/diagram-render.test.js 的溢出用例）',
          { node: node.id, part: 'width', width: outer.w, maxNodeW: MAX_NODE_W, minFont: MIN_FONT_SIZE });
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
      // 终局自检（渲染后那一道）：宽放得下 + 高放得下。两条都过才算"没溢出"（`C-F1-05`）
      let bad = null;
      ['title', 'subtitle', 'badge'].forEach((key) => {
        const r = fitted[key];
        if (!r || bad) return;
        if (r.width > Math.max(0, inset.w) + EPS) bad = { part: key, width: r.width, avail: inset.w };
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
          { node: node.id, part: bad.part, width: bad.width, avail: bad.avail, minFont: MIN_FONT_SIZE });
      }
      return { rect: rect, inset: inset, parts: fitted, widened: widened, shrunk: shrunk };
    }
    throw new MMDiagramError('E_TEXT_FIT_ROUNDS',
      '节点 ' + node.id + ' 在 ' + MAX_FIT_ROUNDS + ' 轮重排后仍未定稿（排版不收敛 ⇒ 不写出一份"看着对"的图）',
      { node: node.id });
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

  /** 端口坐标（未给自定义坐标时按矩形四边中点；给定 `ports` 时用声明值，±0.5px 判据就靠它） */
  function portPoint(node, port) {
    const custom = node.ports && node.ports[port];
    if (custom) return { x: custom[0], y: custom[1] };
    const r = node.rect;
    if (port === 'n') return { x: r.x + r.w / 2, y: r.y };
    if (port === 's') return { x: r.x + r.w / 2, y: r.y + r.h };
    if (port === 'e') return { x: r.x + r.w, y: r.y + r.h / 2 };
    return { x: r.x, y: r.y + r.h / 2 };                             // 'w'
  }

  /** 自动选边（`C-F3-03`）：4×4 个端口组合里取代价（欧氏距离）最小的一对；
   *  相等时按 `n<e<s<w` **定序**（先到先得 ⇒ 同输入同结果，不靠对象键序）。
   *
   *  `fixedFrom` / `fixedTo`：**一端已经指定了端口**时，另一端只在剩下的 4 个里挑
   *  —— 不能拿"两端都自动"的那一对去替换用户指定端（那样指定的端口会被静默改掉）。
   */
  function autoPorts(fromNode, toNode, fixedFrom, fixedTo) {
    const order = diagramSchema.PORTS;
    const fromCand = fixedFrom ? [fixedFrom] : order;
    const toCand = fixedTo ? [fixedTo] : order;
    let best = null;
    fromCand.forEach((pf) => {
      toCand.forEach((pt) => {
        const a = portPoint(fromNode, pf);
        const b = portPoint(toNode, pt);
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || d < best.d - EPS) best = { pf: pf, pt: pt, d: d };
      });
    });
    return { from: best.pf, to: best.pt };
  }

  /** 箭头三角（**不用 `<marker>`**：marker 要写 `url(#id)`，而"0 个外链"的判据里 `url(` 是被扫的
   *  —— 内部引用虽然不算外链，但让判据需要"分辨两种 url(" 是给自己找麻烦。多边形没有这个问题） */
  function arrowPolygon(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < EPS) return null;                                     // 零长边不画箭头（也不编一个方向）
    const ux = dx / len;
    const uy = dy / len;
    const bx = x2 - ux * ARROW_LEN;
    const by = y2 - uy * ARROW_LEN;
    const px = -uy * ARROW_HALF;
    const py = ux * ARROW_HALF;
    return [[x2, y2], [bx + px, by + py], [bx - px, by - py]];
  }

  /**
   * 一条边的几何（**只实现 `straight`**；`orthogonal`/`curve` **响亮拒绝**）。
   * ⚠️ 这是本批第二条红线（父批 §七 第 2 条）：静默画成直线 = 把"没做"说成"做了"，
   *    用户会在真机上发现线全是斜的。
   */
  function resolveEdge(edge, views) {
    const route = edge.route === undefined ? diagramSchema.ROUTE_IMPLEMENTED[0] : edge.route;
    if (diagramSchema.ROUTE_IMPLEMENTED.indexOf(route) < 0) {
      throw new MMDiagramError('E_ROUTE_UNSUPPORTED',
        '边 ' + edge.id + ' 的 route = ' + JSON.stringify(route) + '：**本批（MS1）未实现**'
        + '（只实现了 ' + diagramSchema.ROUTE_IMPLEMENTED.join(' / ') + '）。'
        + '按设计 §7.2 这三档路由属 MS2；本内核**不会**把它静默画成直线 —— '
        + '要么把数据改成 "straight"，要么等 MS2',
        { edge: edge.id, route: route, implemented: diagramSchema.ROUTE_IMPLEMENTED.slice() });
    }
    const fromNode = views.get(edge.from.node);
    const toNode = views.get(edge.to.node);
    const ports = (edge.from.port && edge.to.port)
      ? { from: edge.from.port, to: edge.to.port }
      : autoPorts(fromNode, toNode, edge.from.port, edge.to.port);
    const fromPort = edge.from.port || ports.from;
    const toPort = edge.to.port || ports.to;
    const a = portPoint(fromNode, fromPort);
    const b = portPoint(toNode, toPort);
    const arrow = edge.arrow || {};
    const start = arrow.start === true;
    const end = arrow.end === undefined ? true : arrow.end === true;   // 缺省：末端有箭头、起点没有（`C-F3-07`）
    const style = edge.style === undefined ? 'solid' : edge.style;
    return {
      id: edge.id, fromPort: fromPort, toPort: toPort,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      start: start, end: end, style: style,
      dash: diagramSchema.DASH_TOKEN[style] || '',
      color: edge.color || THEME.edge,
      label: edge.label
    };
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
    nd.nodes.forEach((n) => {
      const before = nodeRects.get(n.id);
      const f = fitNode(Object.assign({}, n, { rect: before }), measurer);
      nodeRects.set(n.id, f.rect);
      fit.set(n.id, f);
      if (f.widened) {
        widenedReport.push({ id: n.id, from: { w: before.w, h: before.h }, to: { w: f.rect.w, h: f.rect.h } });
      }
      f.shrunk.forEach((s) => shrunkReport.push({ id: n.id, part: s.part, from: s.from, to: s.to }));
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

    /* ---- ⑥ 边：只 straight；端口 + 两端独立箭头 ---- */
    const edgesIn = Array.isArray(graph.edges) ? graph.edges : [];
    // 端口坐标要吃**容器摆过之后**的 rect ⇒ `views` 里装的就是最终 rect（上面 ④ 造的）
    const edges = edgesIn.map((e) => resolveEdge(e, views));

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
    edges.forEach((e) => eat({ x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2),
      w: Math.abs(e.x2 - e.x1), h: Math.abs(e.y2 - e.y1) }));
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
      const sizes = {
        title: (f.parts.title && f.parts.title.size) || FONT.title,
        subtitle: (f.parts.subtitle && f.parts.subtitle.size) || FONT.subtitle,
        badge: (f.parts.badge && f.parts.badge.size) || FONT.badge
      };
      // 三段基线：**互不相等且顺序固定**（槽位恒定预留 ⇒ 缺段不塌陷）
      const yTitle = inset.y + sizes.title;
      const ySub = yTitle + LINE_GAP + sizes.subtitle;
      const yBadge = ySub + LINE_GAP + sizes.badge;
      if (f.parts.title) {
        out.push('<text class="mm-node-title" x="' + fmt(inset.x) + '" y="' + fmt(yTitle) + '"'
          + ' font-family="' + esc(FONT.family) + '" font-size="' + fmt(sizes.title) + '" fill="' + esc(textColor)
          + '" data-text="title" data-font-size="' + fmt(sizes.title) + '">' + esc(n.title) + '</text>');
      }
      if (f.parts.subtitle) {
        out.push('<text class="mm-node-subtitle" x="' + fmt(inset.x) + '" y="' + fmt(ySub) + '"'
          + ' font-family="' + esc(FONT.family) + '" font-size="' + fmt(sizes.subtitle) + '" fill="' + esc(textColor)
          + '" data-text="subtitle" data-font-size="' + fmt(sizes.subtitle) + '">' + esc(n.subtitle) + '</text>');
      }
      if (f.parts.badge) {
        const bw = f.parts.badge.width;
        const chipH = sizes.badge + 4;
        out.push('<rect class="mm-badge-chip" x="' + fmt(inset.x) + '" y="' + fmt(yBadge - sizes.badge - 2)
          + '" width="' + fmt(bw + 10) + '" height="' + fmt(chipH) + '" rx="' + fmt(chipH / 2)
          + '" fill="none" stroke="' + esc(stroke) + '" data-badge-chip="' + esc(n.id) + '"/>');
        out.push('<text class="mm-node-badge" x="' + fmt(inset.x + 5) + '" y="' + fmt(yBadge) + '"'
          + ' font-family="' + esc(FONT.family) + '" font-size="' + fmt(sizes.badge) + '" fill="' + esc(textColor)
          + '" data-text="badge" data-font-size="' + fmt(sizes.badge) + '">' + esc(n.badge) + '</text>');
      }
      out.push('</g>');
    });
    out.push('</g>');

    // ---- edges ----
    out.push('<g data-z="edges">');
    edges.forEach((e) => {
      out.push('<line data-edge="' + esc(e.id) + '" data-from-port="' + esc(e.fromPort) + '" data-to-port="'
        + esc(e.toPort) + '" x1="' + fmt(e.x1) + '" y1="' + fmt(e.y1) + '" x2="' + fmt(e.x2) + '" y2="'
        + fmt(e.y2) + '" stroke="' + esc(e.color) + '" stroke-width="1.5"'
        + (e.dash ? ' stroke-dasharray="' + esc(e.dash) + '"' : '') + '/>');
      if (e.end) {
        const tri = arrowPolygon(e.x1, e.y1, e.x2, e.y2);
        if (tri) out.push('<polygon data-arrow="end" data-edge="' + esc(e.id) + '" points="'
          + tri.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ') + '" fill="' + esc(e.color) + '"/>');
      }
      if (e.start) {
        const tri = arrowPolygon(e.x2, e.y2, e.x1, e.y1);   // 反向：起点箭头
        if (tri) out.push('<polygon data-arrow="start" data-edge="' + esc(e.id) + '" points="'
          + tri.map((p) => fmt(p[0]) + ',' + fmt(p[1])).join(' ') + '" fill="' + esc(e.color) + '"/>');
      }
    });
    out.push('</g>');

    // ---- edgeLabels ----
    out.push('<g data-z="edgeLabels">');
    edges.forEach((e) => {
      if (typeof e.label !== 'string' || !e.label) return;
      const mx = (e.x1 + e.x2) / 2;
      const my = (e.y1 + e.y2) / 2;
      out.push('<text class="mm-edge-label" x="' + fmt(mx) + '" y="' + fmt(my - 4) + '" text-anchor="middle"'
        + ' font-family="' + esc(FONT.family) + '" font-size="10" fill="' + THEME.edgeLabel
        + '" data-text="edge-label" data-edge="' + esc(e.id) + '">' + esc(e.label) + '</text>');
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
      problems: [],
      degraded: [],
      // 本批**没做**的东西如实写在报告里（"没做"不许靠读者猜）
      notImplemented: ['route:curve', 'route:orthogonal', 'layout:auto', 'interaction', 'export:png', 'export:pdf']
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
