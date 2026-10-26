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
   * 四、边标签（`C-F3-14` / `C-F3-15`）
   * ------------------------------------------------------------------ */

  const LABEL_FONT_SIZE = 10;
  /** 标签矩形的高度（字号 + 上下各 2px 的呼吸） */
  const LABEL_HEIGHT = 14;
  /** 标签底边到所属线段的**净空**（0 就是"贴着线"，判据允许的最紧一档） */
  const LABEL_CLEARANCE = 3;
  /** 标签到**别的**线段的最小净空（比"不压线"更严的一档：外部证据里"线路和标签到其他路径的净空"）
   *  ⇒ 候选位打分里它是一档**扣分**而不是"压上了才算错"。 */
  const LABEL_PATH_CLEARANCE = 4;

  /* ------------------------------------------------------------------
   * 五、错误类型（**唯一**；调用方按 `code` 判，不按文案判）
   * ------------------------------------------------------------------ */

  /** 稳定规则码（新增拒绝路径**必须**在这里登记：码是给机器判的，文案是给人读的） */
  const ERROR_CODES = Object.freeze([
    'E_DOC', 'E_NODE', 'E_GRAPH', 'E_GRAPH_REF',
    'E_ROUTE_UNSUPPORTED', 'E_TEXT_OVERFLOW', 'E_TEXT_FIT_ROUNDS',
    'E_LAYER_OVERLAP', 'E_WATERMARK_NO_ROOM',
    'E_ROUTE_FAILED', 'E_ROUTE_MARGIN', 'E_LANE_OVERFLOW',
    'E_LABEL_NO_ROOM', 'E_LAYOUT_CYCLE', 'E_LAYOUT_CROWDED'
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
    STEP_COST, BEND_PENALTY, CROSS_PENALTY, HUG_PENALTY, HUG_RANGE_CELLS, OVERLAP_PENALTY,
    ROUTE_MARGIN, ROUTE_MAX_STATES,
    // 标签
    LABEL_FONT_SIZE, LABEL_HEIGHT, LABEL_CLEARANCE, LABEL_PATH_CLEARANCE,
    // 错误
    ERROR_CODES, MMDiagramError
  };
});
