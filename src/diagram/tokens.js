/* ============================================================
 * src/diagram/tokens.js — 图内核的**几何/文本 token 与错误类型**的唯一出处（MS2 引入）
 * ------------------------------------------------------------
 * 为什么要把它们从 `render-svg.js` 里搬出来：MS2 的四个模块（`wrap` / `layout` / `route` /
 * `render-svg`）**共用同一套数**，而"同一个数在两处各写一份"是本工程反复治过的病
 * （改一处、另一处不同步 ⇒ 判据量的是旧值，还看不出来）。
 *   · `wrap.js`      吃：文本 token（字号阶梯 / 段距 / 行距 / 单节点宽度上限）
 *   · `layout.js`    吃：布局 token（节点间距 / 层间距 / 扇出间距 / 通道间距 —— 后两个决定 rank 带宽）
 *   · `route.js`     吃：布线 token（A* 四项代价 / lane 间距 / overpass 的 4px / 标签字号与净空）
 *   · `render-svg.js` 吃：全部（它出 SVG；token 改了，产物跟着改，这是**期望**的耦合方向）
 *
 * 错误类型也在这里：`route.js` / `layout.js` 都要抛"稳定规则码 + 指向的对象 + 可用的修法"
 * 形状的错误（外部证据：archify 的 `validate --json` 给稳定规则码，不让人从自由文本里猜），
 * 而类只能有一个 —— 放在叶子模块里，三个上层模块都引它，不会成环。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDiagramTokens = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 一、文本与框（MS1 的取值原样保留：它们已经被 3749 个用例钉住了）
   * ------------------------------------------------------------------ */

  /** 字号阶梯：三段**各自独立**（`C-F1-02`）。缩小只能发生在这三个阶段内的"逐档下调"。 */
  const FONT = Object.freeze({ family: 'system-ui, sans-serif', title: 14, subtitle: 11, badge: 10 });
  /** 缩字号下限（`C-F1-04`："字号 ≥ 8.5"是**任何情况**下的硬下界） */
  const MIN_FONT_SIZE = 8.5;
  /** 每一档调多少（1px 一档；最后一档直接落到 8.5 ⇒ 阶梯闭合） */
  const FONT_STEP = 1;
  /** 三段之间的**段距**（固定值 ⇒ 缺任一段时其余两段的位置不变，`C-F1-02` 的"不塌陷"） */
  const LINE_GAP = 4;
  /** 同一段内**行与行的行距**（`C-F1-03` 的"行高"由它和字号共同决定）。
   *  为什么与 `LINE_GAP` 分开两个名字：段距是"三段式"的排版结构，行距是"换行"的排版结构，
   *  合成一个数会让"改段距"顺手改掉换行稠密度（那是两件不同的事）。 */
  const LINE_LEAD = 4;
  /** 每段最多几行。**这是"先换行、再缩字号"这条顺序能成立的关键**：
   *  无上界时任何长文本都能靠无限多行塞进任意宽度 ⇒ 缩字号那一档永远不可达（判据在空转）；
   *  有上界时"行数超了 ⇒ 缩字号 ⇒ 行数降下来"是一条真的阶梯。
   *  `badge` = 1：它是 chip（`C-F1-02` 的徽标），换行会把 chip 撑成方块，那已经不是徽标了。 */
  const MAX_LINES = Object.freeze({ title: 3, subtitle: 2, badge: 1 });
  /** 三段的名字（**顺序固定**：槽位、基线、报错都按它走） */
  const PARTS = Object.freeze(['title', 'subtitle', 'badge']);
  /** 每段的基准字号（与 `FONT` 同源，单独一张表方便 `PARTS.forEach` 取） */
  const BASE_SIZE = Object.freeze({ title: FONT.title, subtitle: FONT.subtitle, badge: FONT.badge });

  /** 节点内边距 */
  const NODE_PAD = 8;
  /** 圆角 token（`C-F1-01`）：`round` = 8，`pill` = 高的一半 */
  const RADIUS_ROUND = 8;
  /** 圆柱两端的椭圆高度占比与上限（固定 ⇒ 可复算） */
  const CYLINDER_CAP_RATIO = 0.2;
  const CYLINDER_CAP_MAX = 16;
  /** 单个节点的**外接框宽度上限**（"加宽"这个兜底的界；超了就是文案问题，不是排版问题） */
  const MAX_NODE_W = 2000;
  /** 几何自检最多重排几轮（与 `C-A-07` 的"≤3 轮"同口径） */
  const MAX_FIT_ROUNDS = 3;
  /** 自动布局里"节点正文的最大宽度"：超过它就换行（`C-F1-03`），而不是把节点拉成一长条。 */
  const CONTENT_MAX_W = 200;
  /** 浮点比较容差（只在"放得下吗"这一处用，**不参与输出**） */
  const EPS = 1e-9;

  /* ------------------------------------------------------------------
   * 二、布局（`C-F4-01`…`C-F4-03`）
   * ------------------------------------------------------------------ */

  /** 层内节点间距 / 层间距的**缺省值**（数据里 `graph.gap.node` / `graph.gap.rank` 可覆盖） */
  const NODE_GAP_DEFAULT = 24;
  const RANK_GAP_DEFAULT = 48;
  /** 两个间距的合法上界（与 `schema.js` 的 LIMITS 同源；写在这里，校验读的是同一处） */
  const GAP_NODE_MAX = 400;
  const GAP_RANK_MAX = 800;

  /** 自动布局把**节点尺寸取到 16 的整数倍、坐标取到 8 的整数倍**。
   *  为什么是 16：四个端口（`n/e/s/w`）落在矩形四边中点上，`x + w/2` 与 `y + h/2` 要落在
   *  8px 网格上 ⇒ `w/2`、`h/2` 必须是 8 的倍数 ⇒ 宽高必须是 16 的倍数。
   *  这条不变量是"折点坐标都是 grid 的整数倍"（`C-F3-06`）的**前提**，不是可选的洁癖。 */
  const SIZE_QUANTUM = 16;
  const COORD_QUANTUM = 8;

  /* ------------------------------------------------------------------
   * 三、布线（`C-A-05` / `C-F3-16`…`C-F3-19`）
   * ------------------------------------------------------------------ */

  /** 同一通道内相邻两条线的**中心距下限**（`C-F3-19` 的判据原文就是 8px）。
   *  ⚠️ 这个数是**判据的一部分**：把它改成 4，`tests/diagram-route.test.js` 的"同通道 ≥ 8px"
   *  必须变红 —— 那不是"调参"，那是把判据改坏（见 `.review/20261060-MS2布局布线/inject-red.txt`）。 */
  const LANE_GAP = 8;
  /** 通道两侧各留多少（lane 不许贴着层边界跑：贴边的线在视觉上与节点框粘连） */
  const LANE_MARGIN = 8;
  /** 同一节点同侧多支线的**确定性展开**间距（`C-F3-09` 要求 ≥ 8；取 16 是为了让偶数支也落在
   *  8px 网格上：偏移 = (2k − (n−1)) × 8，永远 8 的整数倍）。 */
  const FANOUT_GAP = 16;
  /** overpass：低优先级线在交叉点两侧各断多少（两段合计 4px，判据原文"断开 4px"） */
  const GAP_HALF = 2;
  /** overpass：高优先级线在交叉处画的白色描边宽度（`C-F3-18`） */
  const HALO_WIDTH = 4;

  /** A* 的**四项代价**（`C-A-05`：长度 + 拐弯 + 交叉 + 贴边）。
   *  单位统一成"一个网格步 = 1"，这样四个数可以直接比较、也可以被报告读出来。 */
  const STEP_COST = 1;
  const BEND_PENALTY = 5;
  const CROSS_PENALTY = 12;
  const HUG_PENALTY = 1;
  /** "贴边"多近算贴边：以网格步计（1 步 = 8px） */
  const HUG_RANGE_CELLS = 1;
  /** 走别人已经走过的同一条通道：贵到基本不会发生（lane 分配是最后一道闸） */
  const OVERLAP_PENALTY = 60;
  /** 网格障碍图的外扩（保证"绕得开"：路径可以在节点外围多绕几圈，而不是被判成无解） */
  const ROUTE_MARGIN = 64;
  /** A* 状态数上界（无解时的保险丝：不许把"没找到路"变成"卡死"） */
  const ROUTE_MAX_STATES = 900000;

  /* ------------------------------------------------------------------
   * 三½、曲线路由（`C-F3-05`）：控制点**由两端端口法向导出**（没有随机、没有拟合）
   * ------------------------------------------------------------------ */

  /** 控制点到端点的距离 = `max(CURVE_MIN_K, |p0−p3| / CURVE_K_DIV)`。
   *  为什么是这个式子：三次贝塞尔在 t=0 处的切向就是 `c1−p0` ⇒ 控制点落在**端口法向**上，
   *  曲线才会"沿着端口方向出、沿着端口方向进"（这正是 `C-F3-05` 的判据原文）。
   *  两个数都是常量 ⇒ 控制点可被判据**逐值复算**（不许"看起来像曲线"就算）。 */
  const CURVE_MIN_K = 16;
  const CURVE_K_DIV = 3;
  /** 曲线采样段数：曲线在判据里要能"量"（交叉/标签/穿框都走折线），
   *  所以给一个**固定**的采样数（固定 ⇒ 同输入同输出；与"画得多顺滑"无关）。 */
  const CURVE_SAMPLES = 16;

  /* ------------------------------------------------------------------
   * 四、边标签（`C-F3-14` / `C-F3-15`）
   * ------------------------------------------------------------------ */

  /** 边标签字号与净空 */  const LABEL_FONT_SIZE = 10;
  /** 标签矩形的高度（字号 + 上下各 2px 的呼吸） */
  const LABEL_HEIGHT = 14;
  /** 标签底边到所属线段的**净空**（0 就是"贴着线"，判据允许的最紧一档） */
  const LABEL_CLEARANCE = 3;
  /** 标签到**别的**线段的最小净空（比"不压线"更严的一档：外部证据里"线路和标签到其他路径的净空"）
   *  ⇒ 候选位打分里它是一档**扣分**而不是"压上了才算错"。 */
  const LABEL_PATH_CLEARANCE = 4;

  /* ------------------------------------------------------------------
   * 五、主题（`C-F6-02` / `C-F6-03`）与语义 classDef（`C-F6-01`）
   * ------------------------------------------------------------------
   * 三条纪律（每一条都有判据盯着，见 `tests/diagram-theme.test.js`）：
   *   ① **两套 token 的键集逐键相同**（缺一个就报错）—— 换皮不是"少一个键就用默认"；
   *   ② 每套都要算得出 **对比度 ≥ 4.5:1**（`THEME_PAIRS` 里逐对现算，不写死"看起来挺清楚"）；
   *   ③ 语义类**十个**，未知语义类 ⇒ 报错并列出合法取值（不静默退化成默认色）。
   * 导出的产物里样式全在**元素属性**上（`fill=` / `stroke=`），没有 `<link>`、没有 `@import`
   * ⇒ `C-F6-04` 的判据是"0 个外链"，不是"我们打算内联"。
   */

  /** 语义 classDef 的十个类（`C-F6-01`；顺序固定 ⇒ 报错文案与产物都可复跑） */
  const SEMANTIC_CLASSES = Object.freeze([
    'link', 'hook', 'mangle', 'nat', 'filter', 'security', 'conntrack', 'decision', 'app', 'proto'
  ]);

  /** 两套 token。**键集必须逐键相同**（缺键由 `themeKeyDiff()` 报出来） */
  const THEMES = Object.freeze({
    light: Object.freeze({
      canvas: '#ffffff',
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
    }),
    dark: Object.freeze({
      canvas: '#0b1220',
      nodeFill: '#1a2233',
      nodeStroke: '#7d8ca6',
      nodeText: '#e8eef7',
      containerFill: 'none',
      containerStroke: '#6b7a91',
      containerText: '#b9c4d4',
      layerFill: '#131c2b',
      layerText: '#b9c4d4',
      watermark: '#6b7a91',
      edge: '#94a3b8',
      edgeLabel: '#cbd5e1',
      annotation: '#f0c674'
    })
  });

  /** 语义类 → 每套主题的取值（`C-F6-01`：十个类各解析到一个 token） */
  const SEMANTIC_COLORS = Object.freeze({
    light: Object.freeze({
      link: '#1f6feb', hook: '#8250df', mangle: '#bc4c00', nat: '#1a7f37', filter: '#0a7ea4',
      security: '#cf222e', conntrack: '#7d4e00', decision: '#6639ba', app: '#0b7285', proto: '#57606a'
    }),
    dark: Object.freeze({
      link: '#6cb6ff', hook: '#d2a8ff', mangle: '#ffa657', nat: '#56d364', filter: '#56d4dd',
      security: '#ff7b72', conntrack: '#e3b341', decision: '#bc8cff', app: '#4dd0c8', proto: '#adbac7'
    })
  });

  /** 判"正文可读"用的 (前景, 背景) 对（`C-F6-02` / `C-F6-03` 的 4.5:1 逐对现算）。
   *  ⚠️ 水印不在里面：它是**装饰**（本来就带 opacity < 1），把它算进"正文对比度"是把判据用错地方。 */
  const THEME_PAIRS = Object.freeze([
    ['nodeText', 'nodeFill'],
    ['nodeText', 'canvas'],
    ['edgeLabel', 'canvas'],
    ['containerText', 'canvas'],
    ['layerText', 'layerFill'],
    ['annotation', 'canvas']
  ]);

  /** 主题名（`opts.theme` 的合法取值；缺省 light ⇒ 既有产物逐字节不变） */
  const THEME_NAMES = Object.freeze(['light', 'dark']);

  /** sRGB 相对亮度（WCAG 2.x） */
  function relativeLuminance(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return NaN;
    const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    // 断点取 sRGB 标准里那个四位小数的分界（WCAG 文档的旧近似与它差 < 0.001）
    const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  /** 对比度（前景 vs 背景）；任一不是 `#rrggbb` 或背景是 `none` ⇒ NaN（调用方必须显式处理） */
  function contrastRatio(fg, bg) {
    const a = relativeLuminance(fg);
    const b = relativeLuminance(bg);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** 两套 token 的键集差异（空数组 = 逐键相同，`C-F6-03` 的判据） */
  function themeKeyDiff() {
    const a = Object.keys(THEMES.light).sort();
    const b = Object.keys(THEMES.dark).sort();
    return {
      missingInDark: a.filter((k) => b.indexOf(k) < 0),
      missingInLight: b.filter((k) => a.indexOf(k) < 0),
      keys: a.length
    };
  }

  /** 逐对算对比度（`C-F6-02`/`03` 的读数；低于 `min` 的那些会被判据点名） */
  function contrastReport(themeName, min) {
    const t = THEMES[themeName] || THEMES.light;
    const floor = isNum(min) ? min : 4.5;
    return THEME_PAIRS.map((p) => {
      const ratio = contrastRatio(t[p[0]], t[p[1]]);
      return { theme: themeName, fg: p[0], bg: p[1], ratio: ratio, ok: ratio >= floor };
    });
  }

  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  /**
   * 语义名 → 颜色。`C-F6-01` 的判据："十个语义类各能解析到一个 token；未知语义类 ⇒ 报错并
   * 列出合法取值（**不静默退化成默认色**）"。
   * ⚠️ 同时接受字面 `#rrggbb`（后向兼容：既有数据的 `color` 是十六进制直写，不是语义类）——
   * 但**其余字符串一律报错**，不猜。
   */
  function resolveSemantic(name, themeName) {
    const theme = THEMES[themeName] ? themeName : 'light';
    if (typeof name !== 'string' || !name) {
      throw new MMDiagramError('E_THEME_CLASS',
        '颜色取值必须是语义类（' + SEMANTIC_CLASSES.join(' / ') + '）或 #rrggbb（收到 '
        + JSON.stringify(name) + '）—— 不静默退化成默认色',
        { object: { color: name }, allowed: SEMANTIC_CLASSES.slice() });
    }
    if (/^#[0-9a-fA-F]{6}$/.test(name)) return name;
    const hit = SEMANTIC_COLORS[theme][name];
    if (hit) return hit;
    throw new MMDiagramError('E_THEME_CLASS',
      '未知语义类 ' + JSON.stringify(name) + '：合法取值是 ' + SEMANTIC_CLASSES.join(' / ')
      + '，或直接给 #rrggbb —— 本内核**不**把未知语义退化成默认色（那会让"写错了"看起来像"生效了"）',
      { object: { color: name }, allowed: SEMANTIC_CLASSES.slice(), theme: theme });
  }

  /* ------------------------------------------------------------------
   * 六、错误类型（**唯一**；调用方按 `code` 判，不按文案判）
   * ------------------------------------------------------------------ */

  /** 稳定规则码（新增拒绝路径**必须**在这里登记：码是给机器判的，文案是给人读的） */
  const ERROR_CODES = Object.freeze([
    'E_DOC', 'E_NODE', 'E_GRAPH', 'E_GRAPH_REF',
    'E_ROUTE_UNSUPPORTED', 'E_TEXT_OVERFLOW', 'E_TEXT_FIT_ROUNDS',
    'E_LAYER_OVERLAP', 'E_WATERMARK_NO_ROOM',
    'E_ROUTE_FAILED', 'E_ROUTE_MARGIN', 'E_LANE_OVERFLOW',
    'E_LABEL_NO_ROOM', 'E_LAYOUT_CYCLE', 'E_LAYOUT_CROWDED',
    'E_ROUTE_ON_BORDER', 'E_PIN_CROWDED', 'E_THEME_CLASS', 'E_THEME_UNKNOWN',
    // 收口批新增的三条拒绝路径（§4.2 形状收窄 / 关系层几何）：
    //   `E_PROFILE_SHAPE` = 形状不在该剖面允许集里（`reject` 档）或该剖面根本没有形状能力
    //   `E_SHAPE_POLICY`  = `opts.shapePolicy` 取值非法（未知处置**不静默当降级**）
    //   `E_RELATION_REF`  = 关系层端点指向不存在的节点 / 矩形不合法（**不静默丢线**）
    'E_PROFILE_SHAPE', 'E_SHAPE_POLICY', 'E_RELATION_REF',
    // `pinned` 的坐标缺失（既没有 `rect` 也没有 `opts.offsets`）：降级＋点名，不是静默忽略
    'E_PIN_NO_COORD'
  ]);

  class MMDiagramError extends Error {
    /**
     * @param {string} code 稳定规则码（见 `ERROR_CODES`）
     * @param {string} message 给人读的话（必须包含"是什么 / 在哪 / 怎么办"三件事）
     * @param {object} [detail] 给机器判的读数；`object` 指向被拒的对象，`fixes` 列出可用修法
     */
    constructor(code, message, detail) {
      super(message);
      this.name = 'MMDiagramError';
      this.code = code;
      this.detail = detail || {};
    }
  }

  return {
    // 文本与框
    FONT, MIN_FONT_SIZE, FONT_STEP, LINE_GAP, LINE_LEAD, MAX_LINES, PARTS, BASE_SIZE,
    NODE_PAD, RADIUS_ROUND, CYLINDER_CAP_RATIO, CYLINDER_CAP_MAX, MAX_NODE_W, MAX_FIT_ROUNDS,
    CONTENT_MAX_W, EPS,
    // 布局
    NODE_GAP_DEFAULT, RANK_GAP_DEFAULT, GAP_NODE_MAX, GAP_RANK_MAX, SIZE_QUANTUM, COORD_QUANTUM,
    // 布线
    LANE_GAP, LANE_MARGIN, FANOUT_GAP, GAP_HALF, HALO_WIDTH,
    // 曲线（`C-F3-05`）
    CURVE_MIN_K, CURVE_K_DIV, CURVE_SAMPLES,
    STEP_COST, BEND_PENALTY, CROSS_PENALTY, HUG_PENALTY, HUG_RANGE_CELLS, OVERLAP_PENALTY,
    ROUTE_MARGIN, ROUTE_MAX_STATES,
    // 标签
    LABEL_FONT_SIZE, LABEL_HEIGHT, LABEL_CLEARANCE, LABEL_PATH_CLEARANCE,
    // 主题与语义色（`C-F6-01`…`C-F6-04`）
    THEMES, THEME_PAIRS, THEME_NAMES, SEMANTIC_CLASSES, SEMANTIC_COLORS,
    relativeLuminance, contrastRatio, themeKeyDiff, contrastReport, resolveSemantic,
    // 错误
    ERROR_CODES, MMDiagramError
  };
});
