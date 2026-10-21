/* ============================================================
 * src/import-grade.js — 「导入分档（Import Grade，产品代号 `IG`）」的**判据唯一实现处**
 * ------------------------------------------------------------
 * UMD 纯逻辑：**零 I/O、零时钟、零随机、零 Electron**（Node 侧命令与单测共用一份；
 * 浏览器侧没有消费者，但双端加载必须成立 —— 见 `docs/ARCHITECTURE.md` §2.3 / §8.4）。
 *
 * ## 它回答什么（台账 `W15`）
 * 「**这一次导入，产物是不是源文的确定性函数**」—— 也就是**保真不保真**。
 * 把源文件重新跑一遍导入器（`docToOutline` → `markdownToTree`），得到"这份源文**本该**长成的那棵树" Y；
 * 把盘上 `origin` 子树里**实际**长成的树 X 与 Y 按标题序列对齐：
 *
 *     clean      标题序列逐条全等（含重数） ⇒ 这一段完全由转换器决定，不需要复核
 *     rewritten  有节点在 Y 里找不到           ⇒ 存在一个**非保真**的编辑动作，逐条点名
 *     grown      |X| > |Y|                     ⇒ 导入后又长了节点，**本次导入的产物边界不可分**，不出分
 *     src-gone   源文件不在盘上                ⇒ 判不了（`origin.src` 是绝对路径，换机器必断）
 *     unreadable 源文件读不了/解析不了         ⇒ 判不了，带原因
 *     unknown-tool `origin.tool` 缺失          ⇒ 连"origin 节点自己算不算产物"都不确定，不猜
 *
 * ## 为什么不用"语义相似度"
 * 相似度要一个阈值，而阈值**没有判据**（写 0.8 与 0.6 一样随意）。"标题是不是源文里的那一条"
 * 有唯一答案。本工程 2026-10-19 已用同一条理由否掉过"多久算旧"那类假硬门禁（`docs/ROADMAP.md` §在飞 的开头）。
 *
 * ## 为什么判据必须是"重放"，不是"自己数标题"
 * 建树那条路（`src/markdown.js` 的 `markdownToTree`）是**围栏感知**的：``` 里的 `#` 不是标题；
 * 而 `src/doc-import.js` 的 `finishOutline` 统计 `stats.headings` 用的是**朴素正则**（不看围栏）。
 * 实测：同一批 38 份源文件，用朴素分母算 recall **0.7957**，用围栏感知算 **0.9712** ——
 * 差的不是数据，是判据写错了。所以本模块**只吃重放结果**，一个标题正则都不写。
 *
 * ## 精度口径（与 `docs/FEATURES.md` 的 `IG` 行同一份）
 *     E = 重放得到的标题序列（保序、**保重**、围栏感知）
 *     A = 实际节点的 topic 序列（保序、保重）
 *     precision = |多重集交(E, A)| / |A|        ← 落成的节点里有多少是源文的标题
 *     recall    = |多重集交(E, A)| / |E|        ← 源文的标题里有多少真落成了节点
 *   **grown 档不出分**：那时"本次导入的产物"根本没有边界，任何分数都是发明出来的。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./markdown.js'));
  } else {
    root.MMImportGrade = factory(root.MMMarkdown || null);
  }
})(typeof self !== 'undefined' ? self : this, function (markdown) {
  'use strict';

  /* ==========================================================================
   * 0. 取值表与常量（**唯一一处**）
   * ======================================================================== */

  /** 六档**封闭**取值。新增一档必须同批改 `docs/FEATURES.md` 的 `IG` 行与三处读数口径。 */
  const KLASS = Object.freeze([
    'clean', 'rewritten', 'grown', 'src-gone', 'unreadable', 'unknown-tool'
  ]);

  /** **出分**的档（只有这两档的 precision / recall 有意义）。 */
  const JUDGEABLE = Object.freeze(['clean', 'rewritten']);

  /**
   * `markdownToTree` 在"层级跳跃"处插的**占位节点**（`src/markdown.js` 的 `openNode`：
   * 缺层时塞一个 `topic:'（层级N）'` 的节点）。它是**节点**但不是**标题** ⇒
   * 两边都剔掉，并把剔了几个**如实报出来**（`placeholders`）——
   * 既不静默丢，也不让它把"层级跳跃的文件"误判成 `rewritten`。
   */
  const PLACEHOLDER_RE = /^（层级\d+）$/;

  /** 每行点名条数上限。超了置 `namesTruncated:true` 并给总数 —— **静默截断的点名会被当成完整的点名**。 */
  const MAX_NAMES = 20;

  /**
   * **探针项目**前缀（测试脚本造起来、跑完自己删的临时项目）。
   * ⚠️ 这份清单是**有意的第二份**：真值在 `scripts/cli-integration.js` 的 `PROBE_PREFIX`，
   * 而 `cli/` **不许** require `scripts/`（`docs/RULES.md` 的 S1 单向依赖）⇒ 只能抄。
   * 抄了就一定会漂 ⇒ `tests/import-grade.test.js` 里有一条**直接读那个源文件、把两张表逐条对齐**的用例，
   * 漂了就红。（同一条纪律的既有先例：`cli/core.js` 的 `WRITE_COMMANDS` 与命令实现的同步。）
   */
  const PROBE_PREFIX_LIST = Object.freeze([
    'it-probe-', 'it-broken-', 'it-k8-', 'it-w14-', 'it-w19-', 'it-w20-', 'imp-probe-'
  ]);
  /** `it-s<N>-` 那一家（`it-s1-` … `it-s9-`）单独一条正则，别在列表里造 9 个常量。 */
  const PROBE_SERIES_RE = /^it-s[1-9]-/;

  /** 库级模式的默认扫描上限（防"库里有几千个项目"把一次读数变成一次跑盘）。撞到就**响亮报**，不静默截断。 */
  const MAX_SOURCES = 5000;

  /* ==========================================================================
   * 1. 小工具（纯函数）
   * ======================================================================== */

  /** 四舍五入到 4 位小数（读数的口径：够分辨，又不会因为浮点尾数抖动而两跑不同）。 */
  function round4(x) {
    return Math.round(x * 1e4) / 1e4;
  }

  /** 是不是占位节点（`（层级N）`）。 */
  function isPlaceholder(topic) {
    return PLACEHOLDER_RE.test(String(topic === undefined || topic === null ? '' : topic).trim());
  }

  /** 是不是探针项目名（测试脚本造的临时项目）。 */
  function isProbeProject(name) {
    const n = String(name === undefined || name === null ? '' : name);
    if (!n) return false;
    if (PROBE_SERIES_RE.test(n)) return true;
    for (let i = 0; i < PROBE_PREFIX_LIST.length; i++) {
      if (n.indexOf(PROBE_PREFIX_LIST[i]) === 0) return true;
    }
    return false;
  }

  /** 多重集交集大小：同一个标题出现两次，就要求两边各有两个才对得上。 */
  function multisetIntersect(a, b) {
    const cnt = new Map();
    for (let i = 0; i < b.length; i++) cnt.set(b[i], (cnt.get(b[i]) || 0) + 1);
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      const c = cnt.get(a[i]) || 0;
      if (c > 0) { n++; cnt.set(a[i], c - 1); }
    }
    return n;
  }

  /** 去掉占位节点，并如实报出剔了几个。 */
  function stripPlaceholders(list) {
    const src = Array.isArray(list) ? list : [];
    const topics = [];
    let removed = 0;
    for (let i = 0; i < src.length; i++) {
      const t = String(src[i] === undefined || src[i] === null ? '' : src[i]).trim();
      if (isPlaceholder(t)) { removed++; continue; }
      topics.push(t);
    }
    return { topics: topics, removed: removed };
  }

  /* ==========================================================================
   * 2. 重放：源文 → "本该长成的那棵树"的**标题序列**
   * ======================================================================== */

  /**
   * 把一份**已经规范化过的提纲 md** 重放成树，取前序标题序列。
   *
   * 调用方（`cli/commands/import-grade.js`）负责先用 `src/doc-import.js` 的 `docToOutline(file)`
   * 把文件变成 md（那一步才读盘、才认 docx/pdf）—— 本函数**不碰盘**，所以能单测、能在浏览器端跑。
   *
   * @param {string} md 规范化后的提纲 Markdown
   * @returns {{topics: string[], placeholders: number}}
   */
  function replayTopics(md) {
    if (!markdown || typeof markdown.markdownToTree !== 'function') {
      throw new Error('replayTopics 需要 src/markdown.js（浏览器端请先加载它；本工程的产品入口是 Node 侧的 CLI）');
    }
    // id 生成器传**确定性桩**：节点 id 由 `Date.now()` + 随机数生成是既有事实（`src/markdown.js` 的 idGen），
    // 判据不碰 id，重放也不该让它影响任何东西。
    const built = markdown.markdownToTree(String(md === undefined || md === null ? '' : md), '__replay__', function () {
      return '__replay__';
    });
    const kids = (built && built.data && built.data.children) || [];
    const out = [];
    // ⚠️ 从 `built.data.children` 开始遍历，**不要套一个 `topic:''` 的包装节点**：
    //    那条空串会被算成一条标题 ⇒ E 恒比 A 多 1 ⇒ **所有文件都被判 rewritten**。
    //    （本批的探针第一版就是这么错的，读数 E=15/A=14，差的那条正是空串。）
    (function walk(list) {
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (!n || typeof n !== 'object') continue;
        out.push(String(n.topic === undefined || n.topic === null ? '' : n.topic).trim());
        if (Array.isArray(n.children) && n.children.length) walk(n.children);
      }
    })(kids);
    const stripped = stripPlaceholders(out);
    return { topics: stripped.topics, placeholders: stripped.removed };
  }

  /* ==========================================================================
   * 3. 实际产物：`origin` 子树 → 标题序列
   * ======================================================================== */

  /**
   * **`origin` 节点自己算不算"这次导入的产物"** —— 判据依赖 `origin.tool`（`docs/DATA-FORMAT.md` §2.8）：
   *   · `import-md`            → 挂在**每个 1 级标题子树根**上，那个根**就是**源文的标题 ⇒ **算**
   *   · `import-project`       → 挂在**项目根**（标题是人给的）⇒ **不算**
   *   · `import-dir`/`bind-sync` → 挂在**文件节点**（标题 = 文件名去扩展名）与项目根 ⇒ **不算**
   *   · 工具不认识（含缺失）    → **不猜**（返回 null，由调用方落 `unknown-tool`）
   *
   * @param {string|null} tool
   * @returns {boolean|null} true / false / null(=不知道)
   */
  function originNodeCountsAsProduct(tool) {
    const t = String(tool === undefined || tool === null ? '' : tool).trim();
    if (!t) return null;
    if (t === 'import-md') return true;
    if (t === 'import-project' || t === 'import-dir' || t === 'bind-sync') return false;
    return null;
  }

  /**
   * 取一条 `origin` 节点所代表的**实际产物**的标题序列（前序）。
   *
   * @param {object} node 挂了 `origin` 的那个节点
   * @param {string|null} tool `origin.tool`（调用方给，免得本函数去猜）
   * @returns {{topics: string[], placeholders: number, includeSelf: (boolean|null)}}
   */
  function topicsOfOrigin(node, tool) {
    const includeSelf = originNodeCountsAsProduct(tool);
    const out = [];
    (function walk(n, isSelf) {
      if (!n || typeof n !== 'object') return;
      if (!isSelf || includeSelf) out.push(String(n.topic === undefined || n.topic === null ? '' : n.topic).trim());
      const kids = Array.isArray(n.children) ? n.children : [];
      for (let i = 0; i < kids.length; i++) walk(kids[i], false);
    })(node, true);
    const stripped = stripPlaceholders(out);
    return { topics: stripped.topics, placeholders: stripped.removed, includeSelf: includeSelf };
  }

  /* ==========================================================================
   * 4. 判一档（**分级与打分只有这一处**）
   * ======================================================================== */

  /**
   * 判一份"源文件 ↔ 实际子树"对。
   *
   * @param {{project:string, src:string, tool:string|null,
   *          srcState?:('ok'|'src-gone'|'unreadable'), reason?:string,
   *          replayTopics:string[], actualTopics:string[], placeholders?:number}} o
   * @returns {object} 一行读数（键序固定 ⇒ `--json` 两跑逐字节相同）
   */
  function gradeOne(o) {
    const it = o || {};
    const row = {
      project: String(it.project === undefined || it.project === null ? '' : it.project),
      src: String(it.src === undefined || it.src === null ? '' : it.src),
      tool: it.tool === undefined || it.tool === null ? null : String(it.tool),
      klass: 'clean',
      E: null,
      A: null,
      matched: null,
      precision: null,
      recall: null,
      placeholders: Number(it.placeholders) || 0,
      extraInTree: [],
      missingInTree: [],
      namesTruncated: false,
      reason: null
    };

    const state = it.srcState || 'ok';
    if (state === 'src-gone') {
      row.klass = 'src-gone';
      // 原因照传（调用方知道是哪个路径不在盘上）；不传就**如实写 null**，不编一句"源文件丢失" ——
      row.reason = it.reason ? String(it.reason) : null;
      return row;
    }
    if (state === 'unreadable') { row.klass = 'unreadable'; row.reason = it.reason ? String(it.reason) : '读不了'; return row; }
    if (originNodeCountsAsProduct(row.tool) === null) { row.klass = 'unknown-tool'; return row; }

    const Y = Array.isArray(it.replayTopics) ? it.replayTopics : [];
    const X = Array.isArray(it.actualTopics) ? it.actualTopics : [];
    const inter = multisetIntersect(Y, X);
    const E = Y.length;
    const A = X.length;

    row.E = E;
    row.A = A;
    row.matched = inter;
    if (A > E) row.klass = 'grown';
    else if (inter === A && inter === E) row.klass = 'clean';
    else row.klass = 'rewritten';

    if (row.klass !== 'grown') {
      row.precision = A ? round4(inter / A) : null;
      row.recall = E ? round4(inter / E) : null;
    }

    // 逐条点名（两档分开：树上多出来的 / 源文里没落成的）—— 点不了名的读数没法复核
    const yCount = new Map();
    for (let i = 0; i < Y.length; i++) yCount.set(Y[i], (yCount.get(Y[i]) || 0) + 1);
    const xCount = new Map();
    for (let i = 0; i < X.length; i++) xCount.set(X[i], (xCount.get(X[i]) || 0) + 1);
    const extra = [];
    for (let i = 0; i < X.length; i++) {
      const c = yCount.get(X[i]) || 0;
      if (c > 0) { yCount.set(X[i], c - 1); continue; }
      if (extra.indexOf(X[i]) < 0) extra.push(X[i]);
    }
    const missing = [];
    for (let i = 0; i < Y.length; i++) {
      const c = xCount.get(Y[i]) || 0;
      if (c > 0) { xCount.set(Y[i], c - 1); continue; }
      if (missing.indexOf(Y[i]) < 0) missing.push(Y[i]);
    }
    const truncate = (arr) => (arr.length > MAX_NAMES ? arr.slice(0, MAX_NAMES) : arr);
    row.extraInTree = truncate(extra);
    row.missingInTree = truncate(missing);
    row.namesTruncated = extra.length > MAX_NAMES || missing.length > MAX_NAMES;
    return row;
  }

  /** 一行是不是出分的档。 */
  function isJudgeable(klass) {
    return JUDGEABLE.indexOf(klass) >= 0;
  }

  /* ==========================================================================
   * 5. 汇总（库级读数）
   * ======================================================================== */

  /**
   * 把若干行汇总成一份库级读数。
   * **精度按"可判的那些行"做微平均**（不是各行平均 —— 两份 10 节点的文件与一份 200 节点的文件权重不同）。
   * 没有可判行时 `precision / recall` 都是 `null`（**不写 0**：0 是"全错"，null 是"没得判"，两件事）。
   */
  function summarize(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const totals = {
      sources: list.length,
      judgeable: 0,
      clean: 0,
      rewritten: 0,
      grown: 0,
      srcGone: 0,
      unreadable: 0,
      unknownTool: 0,
      placeholders: 0,
      E: 0,
      A: 0,
      matched: 0
    };
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.klass === 'clean') totals.clean++;
      else if (r.klass === 'rewritten') totals.rewritten++;
      else if (r.klass === 'grown') totals.grown++;
      else if (r.klass === 'src-gone') totals.srcGone++;
      else if (r.klass === 'unreadable') totals.unreadable++;
      else if (r.klass === 'unknown-tool') totals.unknownTool++;
      totals.placeholders += Number(r.placeholders) || 0;
      if (isJudgeable(r.klass)) {
        totals.judgeable++;
        totals.E += Number(r.E) || 0;
        totals.A += Number(r.A) || 0;
        totals.matched += Number(r.matched) || 0;
      }
    }
    return {
      totals: totals,
      precision: totals.A ? round4(totals.matched / totals.A) : null,
      recall: totals.E ? round4(totals.matched / totals.E) : null
    };
  }

  /* ==========================================================================
   * 6. 导出（键序固定：`--json` 的对象字面量顺序就是输出顺序）
   * ======================================================================== */

  return {
    KLASS: KLASS,
    JUDGEABLE: JUDGEABLE,
    MAX_NAMES: MAX_NAMES,
    MAX_SOURCES: MAX_SOURCES,
    PLACEHOLDER_RE: PLACEHOLDER_RE,
    PROBE_PREFIX_LIST: PROBE_PREFIX_LIST,
    isPlaceholder: isPlaceholder,
    isProbeProject: isProbeProject,
    isJudgeable: isJudgeable,
    multisetIntersect: multisetIntersect,
    stripPlaceholders: stripPlaceholders,
    replayTopics: replayTopics,
    originNodeCountsAsProduct: originNodeCountsAsProduct,
    topicsOfOrigin: topicsOfOrigin,
    gradeOne: gradeOne,
    summarize: summarize
  };
});
