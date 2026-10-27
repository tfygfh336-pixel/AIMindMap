/* ============================================================
 * src/diagram/schema.js — `graph`（项目级可选附加层）的**形状契约**
 * ------------------------------------------------------------
 * 为什么有这份文件（设计 `docs/DIAGRAM-MODES.md` §6.3/§6.4、本批前置缺陷 ①）：
 *   沙箱实测过一条：干净项目 `validate` exit 0 → 顶层加 `graph` **仍 0** → 节点上加 `rect` **仍 0**。
 *   ⇒ 【"校验通过"不能证明"字段被支持"】。于是 `graph` 一旦落盘就是"没有契约的结构"，
 *   而 `renderer/app-core.js` 的 `serializeTree` 是**手挑字段白名单** ⇒ 界面上不存在的东西
 *   下一次保存就消失。这条链子的第一环就是本文件：**先把形状判起来**。
 *
 * 本文件的判定分层（与 `src/schema.js` 的分工，别混）：
 *   · 这里只判 **`graph` 自身**：字段是谁、取值是不是那一档、引用是不是指向存在的 id；
 *   · **顶层/节点**的未知键判据在 `src/schema.js`（它才知道项目契约里有哪些顶层键与节点字段）。
 *
 * ⚠️ 两条口径（改之前先读，否则会把"没做"变成"悄悄不做"）：
 *   ① **`graph` 内部未知键 = 错误**（不是警告）。理由：`graph` 是本工程**新造**的一层，
 *      盘上还没有任何存量数据 ⇒ 判红零成本；而它的坏形态恰恰是"写了 `crossing` 却没人实现"
 *      —— 那会让图上少一层语义而**没有任何东西红**。顶层/节点上的未知键不同，见 `src/schema.js`
 *      （那里判警告：那些地方可能已经有别人写的历史键，判红会把昨天合法的项目变成不可写）。
 *   ② **`route` 只接受本批实现了的取值时才渲染**：`orthogonal` / `curve` 在形状上是合法取值
 *      （设计矩阵里它们存在），但 MS1 **没有**它们 ⇒ 由渲染内核**响亮拒绝**（`E_ROUTE_UNSUPPORTED`）。
 *      本文件**不**把它们判红：那会把"还没做"说成"数据非法"，两种坏法不同类。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDiagramSchema = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 取值表（**唯一一处**：校验、渲染、文档、测试都从这里取，别抄字面量）
   * ------------------------------------------------------------------ */

  /** 六种形状（设计 `C-F1-01`）。`row` = 容器内的表行。 */
  const SHAPES = Object.freeze(['rect', 'round', 'diamond', 'pill', 'cylinder', 'row']);
  /** 端口锚点（`C-F3-02`）。顺序是**定序用**的：自动选边代价相等时按 `n<e<s<w` 取。 */
  const PORTS = Object.freeze(['n', 'e', 's', 'w']);
  /** 三种路由（`C-F3-04`/`05`/`06`）。**三档都实现了**（`curve` 是 MS3 补上的）。 */
  const EDGE_ROUTES = Object.freeze(['straight', 'orthogonal', 'curve']);
  /** **已实现的路由**。`route` 缺省 = 本表第一项（直连）。
   *
   *  ⚠️ 一处**有据的不一致**，写在这里免得被读成"漏了"：
   *   ① 设计 `C-F3-06` 说 orthogonal 是默认。本内核的缺省仍是 `straight` —— 因为 MS1 的
   *      **手写坐标**数据（盘上已有的那些 JSON）没写 `route`，改缺省会让它们当场变产物
   *      （`C-F9-02` 的逐字节基线就跑了）。**走了自动布局（`renderAuto`）时缺省才是 orthogonal**
   *      —— 那才是 `C-F3-06` 说的场景（"正交布线是自动布局的默认路由"）。
   *   ② `curve`（`C-F3-05`）2026-10-26 补上：控制点由两端端口法向导出
   *      （`route.curveControl`，判据按同一式子逐值复算），**不再**抛 `E_ROUTE_UNSUPPORTED`。
   *      未实现的取值仍然**响亮拒绝**（`E_ROUTE_UNSUPPORTED`），不会静默画成直线。 */
  const ROUTE_IMPLEMENTED = Object.freeze(['straight', 'orthogonal', 'curve']);
  /** 线型三档（`C-F3-12`）；`dasharray` 是**确定值**，不许临时算 */
  const EDGE_STYLES = Object.freeze(['solid', 'dashed', 'dotted']);
  const DASH_TOKEN = Object.freeze({ solid: '', dashed: '5 4', dotted: '1 3' });
  /** 主方向（`C-F4-02`）—— 本批只作数据保留，不做布局（布局是 MS2） */
  const DIRECTIONS = Object.freeze(['LR', 'TB']);
  /** 五个剖面（设计 §3.1）。本文件只判取值，不判"这个剖面允许哪些能力"（那是 MS4） */
  const PROFILES = Object.freeze(['complex', 'mindmap', 'path', 'logic', 'module']);
  /** `graph.version`：**只有 1**。它≠`meta.formatVersion`（后者是 v2/v3 的分界，动不得，见设计 §6.4 第 4 条） */
  const GRAPH_VERSION = 1;
  /** 层带标签朝向（`C-F2-05`） */
  const LABEL_SIDES = Object.freeze(['left', 'top']);
  /** 容器布局（`C-F2-02`/`C-F2-03`） */
  const CONTAINER_LAYOUTS = Object.freeze(['stack', 'free']);

  /** 节点 id / 层带 id / 容器 id / 边 id 的**同一套**规范（小写字母/数字/连字符）。
   *  ⚠️ 与 `src/schema.js` 的 `ID_RE` **必须逐字相同** —— 由 `tests/diagram-schema.test.js`
   *  直接读那份源码逐字对拍（两处各写一份就会漂；漂了的表现是"同一 id 在节点上合法、在边上非法"）。 */
  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  /** `graph` 允许的键（**封闭**：多一个就报错，见文件头口径①）
   *  MS2 加了 `gap`（**布局可选字段**：节点间距 / 层间距；`C-F4-03` 的承载）。 */
  const GRAPH_FIELDS = Object.freeze(['version', 'profile', 'direction', 'grid', 'gap',
    'layers', 'containers', 'edges', 'annotations', 'pinned']);
  /** `graph.gap` 允许的键（两个轴各一个数；缺省见 `tokens.NODE_GAP_DEFAULT` / `RANK_GAP_DEFAULT`） */
  const GAP_FIELDS = Object.freeze(['node', 'rank']);
  const LAYER_FIELDS = Object.freeze(['id', 'label', 'labelSide', 'rect', 'fill', 'watermark']);
  const WATERMARK_FIELDS = Object.freeze(['text', 'rotate', 'opacity']);
  const CONTAINER_FIELDS = Object.freeze(['id', 'label', 'rect', 'layout', 'children', 'padding', 'gap']);
  const EDGE_FIELDS = Object.freeze(['id', 'from', 'to', 'route', 'style', 'color', 'arrow', 'label']);
  const ENDPOINT_FIELDS = Object.freeze(['node', 'port']);
  const ARROW_FIELDS = Object.freeze(['start', 'end']);
  const ANNOTATION_FIELDS = Object.freeze(['id', 'text', 'at', 'style']);

  /** 最大值（只挡"明显异常数据"，不做业务判断）：沿用 offset 那一档的量级护栏 */
  const LIMITS = Object.freeze({
    rectAbs: 1e6,        // 单个坐标分量的绝对值上界
    sizeMax: 1e5,        // 宽/高的上界
    gridMin: 1,
    gridMax: 256,
    paddingMax: 200,
    gapMax: 400,
    gapNodeMax: 400,     // `graph.gap.node`（层内节点间距）上界
    gapRankMax: 800,     // `graph.gap.rank`（层间距）上界
    items: { layers: 64, containers: 256, edges: 2048, annotations: 512, pinned: 4096 }  // 逐类上限（防坏数据把渲染拖死）
  });

  /** 一条错误进数组的**唯一一处**（与 `src/schema.js` 的 `makeCollector` 同形：
   *  `graph.<路径>` 前缀只在这里拼，报文才不可能两处各长一样） */
  function makeCollector() {
    const errors = [];
    const err = (msg) => { errors.push(msg); };
    return { errors: errors, err: err };
  }

  /** 未知键**排序后**报告（对象键序不稳定 ⇒ 报文会随插入序漂，`C-F9-02` 要求逐字节稳） */
  function unknownKeys(obj, allowed) {
    const known = new Set(allowed);
    return Object.keys(obj).filter((k) => !known.has(k)).sort();
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function isNonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }

  /** 一句"合法取值是什么"（报错即教程：不写"取值非法"四个字就完事） */
  function allowedText(list) { return list.map((x) => JSON.stringify(x)).join(' / '); }

  /**
   * `rect: [x, y, w, h]` 的形状校验（**一处实现，层带/容器/节点共用**）。
   * @param {*} v 候选值
   * @param {string} at 报错用的键路径
   * @param {Function} err 收错函数
   * @param {object} [o] `{positive:true}` ⇒ 宽高必须 > 0（层带/容器要求）；缺省允许 0
   */
  function validateRect(v, at, err, o) {
    const opt = o || {};
    if (!Array.isArray(v) || v.length !== 4) { err(at + ' 必须是 [x, y, w, h] 四元数组'); return; }
    const names = ['x', 'y', 'w', 'h'];
    for (let i = 0; i < 4; i++) {
      const n = v[i];
      const label = at + '[' + i + ']（' + names[i] + '）';
      if (!isFiniteNum(n)) { err(label + ' 必须是有限数字'); continue; }
      if (Math.abs(n) > LIMITS.rectAbs) err(label + ' 超出允许范围（±' + LIMITS.rectAbs + '）: ' + n);
      if (opt.positive && i >= 2 && !(n > 0)) err(label + ' 必须 > 0（收到 ' + n + '）');
    }
  }

  /** 一个 id 字段的形状校验（层带/容器/边/节点引用**同一套**规范） */
  function validateId(v, at, err) {
    if (typeof v !== 'string' || !v) { err(at + ' 必须是非空字符串（小写字母/数字/连字符，如 l-core）'); return; }
    if (!ID_RE.test(v)) err(at + ' 含非法字符（小写字母/数字/连字符）: ' + v);
  }

  /** 数组项上限（坏数据不该把渲染拖死；超限**响亮**说不出来，不静默截断） */
  function checkCount(name, arr, err) {
    const max = LIMITS.items[name];
    if (max && arr.length > max) {
      err('graph.' + name + ' 条数 ' + arr.length + ' 超过上限 ' + max
        + '（本批只挡"明显异常数据"；确实要画这么多请先说清场景，别让它静默变慢）');
    }
  }

  /* ------------------------------------------------------------------
   * 层带（`C-F2-04`/`05`/`06`）
   * ------------------------------------------------------------------ */
  function validateLayer(layer, i, err) {
    const at = 'graph.layers[' + i + ']';
    if (!isPlainObject(layer)) { err(at + ' 必须是对象'); return; }
    unknownKeys(layer, LAYER_FIELDS).forEach((k) => {
      err(at + ' 有未知字段 ' + JSON.stringify(k) + '（层带只认 ' + allowedText(LAYER_FIELDS)
        + '；未知字段**不会**被渲染，留着它就是静默丢数据）');
    });
    validateId(layer.id, at + '.id', err);
    if (layer.label !== undefined && typeof layer.label !== 'string') err(at + '.label 必须是字符串');
    if (layer.labelSide !== undefined && LABEL_SIDES.indexOf(layer.labelSide) < 0) {
      err(at + '.labelSide 必须是 ' + allowedText(LABEL_SIDES) + '（收到 ' + JSON.stringify(layer.labelSide) + '）');
    }
    if (layer.rect === undefined) err(at + '.rect 必填（层带是**背景分区**，没有 rect 就没有分区）');
    else validateRect(layer.rect, at + '.rect', err, { positive: true });
    if (layer.fill !== undefined) {
      if (!isNonEmptyStr(layer.fill)) err(at + '.fill 必须是非空字符串（色值或 classDef token）');
      else if (/[\r\n]/.test(layer.fill)) err(at + '.fill 不能含换行');
    }
    if (layer.watermark !== undefined) validateWatermark(layer.watermark, at + '.watermark', err);
  }

  function validateWatermark(wm, at, err) {
    if (!isPlainObject(wm)) { err(at + ' 必须是对象 {text, rotate, opacity}'); return; }
    unknownKeys(wm, WATERMARK_FIELDS).forEach((k) => {
      err(at + ' 有未知字段 ' + JSON.stringify(k) + '（水印只认 ' + allowedText(WATERMARK_FIELDS) + '）');
    });
    if (!isNonEmptyStr(wm.text)) err(at + '.text 必须是非空字符串');
    if (wm.rotate !== undefined) {
      if (!isFiniteNum(wm.rotate) || Math.abs(wm.rotate) > 360) {
        err(at + '.rotate 必须是 ±360 内的数字（-90 = 竖排从下往上，0 = 横排）: ' + JSON.stringify(wm.rotate));
      }
    }
    if (wm.opacity !== undefined) {
      if (!isFiniteNum(wm.opacity) || wm.opacity < 0 || wm.opacity > 1) {
        err(at + '.opacity 必须是 0–1 的数字（水印是"压淡的背景字"，1 就不是水印了）: ' + JSON.stringify(wm.opacity));
      }
    }
  }

  /* ------------------------------------------------------------------
   * 容器（`C-F2-01`/`02`/`03`）
   * ------------------------------------------------------------------ */
  function validateContainer(c, i, err) {
    const at = 'graph.containers[' + i + ']';
    if (!isPlainObject(c)) { err(at + ' 必须是对象'); return; }
    unknownKeys(c, CONTAINER_FIELDS).forEach((k) => {
      err(at + ' 有未知字段 ' + JSON.stringify(k) + '（容器只认 ' + allowedText(CONTAINER_FIELDS) + '）');
    });
    validateId(c.id, at + '.id', err);
    if (c.label !== undefined && typeof c.label !== 'string') err(at + '.label 必须是字符串');
    if (c.rect === undefined) err(at + '.rect 必填（`stack` 只用来取 x/w 与内边距；高度由子项算出）');
    else validateRect(c.rect, at + '.rect', err, { positive: true });
    if (c.layout === undefined) err(at + '.layout 必填（' + allowedText(CONTAINER_LAYOUTS) + '）—— '
      + '缺省值会让"这个框是自动排的还是手摆的"变成猜');
    else if (CONTAINER_LAYOUTS.indexOf(c.layout) < 0) {
      err(at + '.layout 必须是 ' + allowedText(CONTAINER_LAYOUTS) + '（收到 ' + JSON.stringify(c.layout) + '）');
    }
    if (!Array.isArray(c.children) || !c.children.length) {
      err(at + '.children 必须是非空数组（容器框住哪些节点 —— 引用只按 id，与 links/assoc 同型）');
    } else {
      const seen = new Set();
      c.children.forEach((id, j) => {
        validateId(id, at + '.children[' + j + ']', err);
        if (seen.has(id)) err(at + '.children 里 ' + id + ' 重复（同一个节点只能在一个容器里出现一次）');
        seen.add(id);
      });
    }
    ['padding', 'gap'].forEach((k) => {
      if (c[k] === undefined) return;
      if (!isFiniteNum(c[k]) || c[k] < 0) { err(at + '.' + k + ' 必须是 ≥ 0 的数字'); return; }
      if (c[k] > LIMITS[k === 'padding' ? 'paddingMax' : 'gapMax']) {
        err(at + '.' + k + ' 超出允许范围（0–' + LIMITS[k === 'padding' ? 'paddingMax' : 'gapMax'] + '）: ' + c[k]);
      }
    });
  }

  /* ------------------------------------------------------------------
   * 边（`C-F3-*`）
   * ------------------------------------------------------------------ */
  function validateEndpoint(ep, at, err) {
    if (!isPlainObject(ep)) { err(at + ' 必须是 {node, port} 对象'); return; }
    unknownKeys(ep, ENDPOINT_FIELDS).forEach((k) => {
      err(at + ' 有未知字段 ' + JSON.stringify(k) + '（端点只认 ' + allowedText(ENDPOINT_FIELDS) + '）');
    });
    validateId(ep.node, at + '.node', err);
    if (ep.port !== undefined && PORTS.indexOf(ep.port) < 0) {
      err(at + '.port 必须是 ' + allowedText(PORTS) + '（收到 ' + JSON.stringify(ep.port)
        + '；不给端口 ⇒ 渲染层按"代价最小的边"自动选，见 C-F3-03）');
    }
  }

  function validateEdge(e, i, err) {
    const at = 'graph.edges[' + i + ']';
    if (!isPlainObject(e)) { err(at + ' 必须是对象'); return; }
    unknownKeys(e, EDGE_FIELDS).forEach((k) => {
      err(at + ' 有未知字段 ' + JSON.stringify(k) + '（边只认 ' + allowedText(EDGE_FIELDS)
        + '；设计草案里的 `crossing` 属 MS2 的交叉处理，本批**没有实现** ⇒ 不许写成静默透传的键）');
    });
    validateId(e.id, at + '.id', err);
    if (e.from === undefined) err(at + '.from 必填'); else validateEndpoint(e.from, at + '.from', err);
    if (e.to === undefined) err(at + '.to 必填'); else validateEndpoint(e.to, at + '.to', err);
    if (e.route !== undefined && EDGE_ROUTES.indexOf(e.route) < 0) {
      err(at + '.route 必须是 ' + allowedText(EDGE_ROUTES) + '（收到 ' + JSON.stringify(e.route) + '）');
    }
    if (e.style !== undefined && EDGE_STYLES.indexOf(e.style) < 0) {
      err(at + '.style 必须是 ' + allowedText(EDGE_STYLES) + '（收到 ' + JSON.stringify(e.style) + '）');
    }
    if (e.color !== undefined && !isNonEmptyStr(e.color)) err(at + '.color 必须是非空字符串（语义色 token 或色值）');
    if (e.label !== undefined && typeof e.label !== 'string') err(at + '.label 必须是字符串');
    if (e.arrow !== undefined) {
      if (!isPlainObject(e.arrow)) { err(at + '.arrow 必须是 {start, end} 对象'); return; }
      unknownKeys(e.arrow, ARROW_FIELDS).forEach((k) => {
        err(at + '.arrow 有未知字段 ' + JSON.stringify(k) + '（只认 start / end —— 两端**独立**）');
      });
      ARROW_FIELDS.forEach((k) => {
        if (e.arrow[k] !== undefined && typeof e.arrow[k] !== 'boolean') err(at + '.arrow.' + k + ' 必须是布尔');
      });
    }
  }

  /* ------------------------------------------------------------------
   * 注释（`annotations`：画在最上层）
   * ------------------------------------------------------------------ */
  function validateAnnotation(a, i, err) {
    const at = 'graph.annotations[' + i + ']';
    if (!isPlainObject(a)) { err(at + ' 必须是对象'); return; }
    unknownKeys(a, ANNOTATION_FIELDS).forEach((k) => {
      err(at + ' 有未知字段 ' + JSON.stringify(k) + '（注释只认 ' + allowedText(ANNOTATION_FIELDS) + '）');
    });
    if (a.id !== undefined) validateId(a.id, at + '.id', err);
    if (!isNonEmptyStr(a.text)) err(at + '.text 必须是非空字符串');
    if (!Array.isArray(a.at) || a.at.length !== 2 || !isFiniteNum(a.at[0]) || !isFiniteNum(a.at[1])) {
      err(at + '.at 必须是 [x, y] 两个有限数字（注释的位置是手写的，不做自动排）');
    }
    if (a.style !== undefined && !isNonEmptyStr(a.style)) err(at + '.style 必须是非空字符串（样式 token）');
  }

  /**
   * **`graph` 的形状校验**（纯函数：不读盘、不看时钟、不碰 DOM）。
   *
   * 它判什么：字段是谁、取值在不在那一档、条数上界、`pinned` 去重。
   * 它**不判**什么（各自有主，别在这里补）：
   *   · 引用是否存在（`edges[].from.node` / `containers[].children[]` / `pinned[]` 指向的节点在不在）
   *     ⇒ `validateGraphRefs`（要 id 全集，由 `src/schema.js` 从树上给）；
   *   · 路由有没有实现 ⇒ **渲染内核**（`E_ROUTE_UNSUPPORTED`）；这里判红会把"还没做"说成"数据非法"。
   *
   * @param {*} graph 候选 `graph` 值
   * @returns {{ok:boolean, errors:string[]}}
   */
  function validateGraph(graph) {
    const c = makeCollector();
    const err = c.err;
    if (!isPlainObject(graph)) {
      err('graph 必须是对象（项目级可选附加层；缺省 = 无附加结构 —— 别写成 null/数组）');
      return { ok: false, errors: c.errors };
    }
    unknownKeys(graph, GRAPH_FIELDS).forEach((k) => {
      err('graph 有未知字段 ' + JSON.stringify(k) + '（只认 ' + allowedText(GRAPH_FIELDS)
        + '）。⚠️ 未知字段在**任何渲染路径**里都不会出现 —— 留着它 = 写进盘、画不出来、没有东西红');
    });
    if (graph.version !== undefined && graph.version !== GRAPH_VERSION) {
      err('graph.version 只接受 ' + GRAPH_VERSION + '（收到 ' + JSON.stringify(graph.version)
        + '）—— 它是 graph 自己的版本号，**不是** meta.formatVersion（后者动不得，见设计 §6.4 第 4 条）');
    }
    if (graph.profile !== undefined && PROFILES.indexOf(graph.profile) < 0) {
      err('graph.profile 必须是 ' + allowedText(PROFILES) + '（收到 ' + JSON.stringify(graph.profile) + '）');
    }
    if (graph.direction !== undefined && DIRECTIONS.indexOf(graph.direction) < 0) {
      err('graph.direction 必须是 ' + allowedText(DIRECTIONS) + '（收到 ' + JSON.stringify(graph.direction) + '）');
    }
    if (graph.grid !== undefined) {
      if (!isFiniteNum(graph.grid) || graph.grid < LIMITS.gridMin || graph.grid > LIMITS.gridMax) {
        err('graph.grid 必须是 ' + LIMITS.gridMin + '–' + LIMITS.gridMax + ' 的数字（吸附网格；8 = 默认档）: '
          + JSON.stringify(graph.grid));
      }
    }
    if (graph.gap !== undefined) {
      if (!isPlainObject(graph.gap)) {
        err('graph.gap 必须是对象 { node, rank }（布局可选字段：节点间距 / 层间距；缺省 = 24 / 48）');
      } else {
        unknownKeys(graph.gap, GAP_FIELDS).forEach((k) => {
          err('graph.gap 有未知字段 ' + JSON.stringify(k) + '（只认 ' + allowedText(GAP_FIELDS) + '）');
        });
        if (graph.gap.node !== undefined
          && (!isFiniteNum(graph.gap.node) || graph.gap.node < 0 || graph.gap.node > LIMITS.gapNodeMax)) {
          err('graph.gap.node 必须是 0–' + LIMITS.gapNodeMax + ' 的数字（层内节点间距，单位 px）: '
            + JSON.stringify(graph.gap.node));
        }
        if (graph.gap.rank !== undefined
          && (!isFiniteNum(graph.gap.rank) || graph.gap.rank < 0 || graph.gap.rank > LIMITS.gapRankMax)) {
          err('graph.gap.rank 必须是 0–' + LIMITS.gapRankMax + ' 的数字（层间距，单位 px）: '
            + JSON.stringify(graph.gap.rank));
        }
      }
    }
    const arrays = ['layers', 'containers', 'edges', 'annotations', 'pinned'];
    arrays.forEach((k) => {
      if (graph[k] !== undefined && !Array.isArray(graph[k])) err('graph.' + k + ' 必须是数组');
    });
    if (Array.isArray(graph.layers)) {
      checkCount('layers', graph.layers, err);
      const seen = new Set();
      graph.layers.forEach((l, i) => {
        validateLayer(l, i, err);
        if (l && typeof l.id === 'string') {
          if (seen.has(l.id)) err('graph.layers[' + i + '].id 重复: ' + l.id + '（层带 id 在项目内必须唯一）');
          seen.add(l.id);
        }
      });
    }
    if (Array.isArray(graph.containers)) {
      checkCount('containers', graph.containers, err);
      const seen = new Set();
      graph.containers.forEach((cn, i) => {
        validateContainer(cn, i, err);
        if (cn && typeof cn.id === 'string') {
          if (seen.has(cn.id)) err('graph.containers[' + i + '].id 重复: ' + cn.id + '（容器 id 在项目内必须唯一）');
          seen.add(cn.id);
        }
      });
    }
    if (Array.isArray(graph.edges)) {
      checkCount('edges', graph.edges, err);
      const seen = new Set();
      graph.edges.forEach((e, i) => {
        validateEdge(e, i, err);
        if (e && typeof e.id === 'string') {
          if (seen.has(e.id)) err('graph.edges[' + i + '].id 重复: ' + e.id + '（边 id 在项目内必须唯一 —— 路径高亮按它定位）');
          seen.add(e.id);
        }
      });
    }
    if (Array.isArray(graph.annotations)) {
      checkCount('annotations', graph.annotations, err);
      graph.annotations.forEach((a, i) => validateAnnotation(a, i, err));
    }
    if (Array.isArray(graph.pinned)) {
      checkCount('pinned', graph.pinned, err);
      const seen = new Set();
      graph.pinned.forEach((id, i) => {
        validateId(id, 'graph.pinned[' + i + ']', err);
        if (typeof id === 'string') {
          if (seen.has(id)) err('graph.pinned[' + i + '] 重复: ' + id + '（钉住是集合语义）');
          seen.add(id);
        }
      });
    }
    return { ok: c.errors.length === 0, errors: c.errors };
  }

  /**
   * **引用存在性**（设计 §6.3："与 `links[]` 的悬挂检测**同型**：指向不存在的节点 ⇒ `validate` 判红"）。
   *
   * 为什么要单独一个函数：`graph` 的引用目标在**节点树**上，而 `graph` 自己不带树。
   * 由 `src/schema.js` 把 id 全集算好递进来 ⇒ 本函数仍然纯（可单测，不用造整棵项目树）。
   *
   * @param {object} graph 已过形状校验（这里只判"在不在"）
   * @param {Iterable<string>|Set<string>} nodeIds 全项目节点 id 集合
   * @returns {{ok:boolean, errors:string[]}}
   */
  function validateGraphRefs(graph, nodeIds) {
    const c = makeCollector();
    const err = c.err;
    if (!isPlainObject(graph)) return { ok: true, errors: c.errors };   // 没有 graph = 没有引用可判
    const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds || []);
    const has = (id) => typeof id === 'string' && ids.has(id);
    const missing = (at, id) => {
      err(at + ' 指向不存在的节点 ' + JSON.stringify(id)
        + '（graph 的引用只按 id；悬挂 = 图上少一条线/一个框，而没有任何东西红 —— 所以这里判红）');
    };
    if (Array.isArray(graph.containers)) {
      graph.containers.forEach((cn, i) => {
        if (!isPlainObject(cn) || !Array.isArray(cn.children)) return;
        cn.children.forEach((id, j) => { if (!has(id)) missing('graph.containers[' + i + '].children[' + j + ']', id); });
      });
    }
    if (Array.isArray(graph.edges)) {
      graph.edges.forEach((e, i) => {
        if (!isPlainObject(e)) return;
        ['from', 'to'].forEach((end) => {
          const ep = e[end];
          if (isPlainObject(ep) && !has(ep.node)) missing('graph.edges[' + i + '].' + end + '.node', ep.node);
        });
      });
    }
    if (Array.isArray(graph.pinned)) {
      graph.pinned.forEach((id, i) => { if (!has(id)) missing('graph.pinned[' + i + ']', id); });
    }
    return { ok: c.errors.length === 0, errors: c.errors };
  }

  return {
    SHAPES, PORTS, EDGE_ROUTES, ROUTE_IMPLEMENTED, EDGE_STYLES, DASH_TOKEN, DIRECTIONS, PROFILES,
    GRAPH_VERSION, LABEL_SIDES, CONTAINER_LAYOUTS, ID_RE, LIMITS,
    GRAPH_FIELDS, GAP_FIELDS, LAYER_FIELDS, WATERMARK_FIELDS, CONTAINER_FIELDS, EDGE_FIELDS,
    ENDPOINT_FIELDS, ARROW_FIELDS, ANNOTATION_FIELDS,
    validateGraph, validateGraphRefs, validateRect, unknownKeys
  };
});
