/* ============================================================
 * src/palette-rank.js — 模糊检索的**打分与定序核心**（UMD 纯逻辑，无 DOM）
 * ------------------------------------------------------------
 * 从 renderer/app-palette.js 抽出：**排序是纯计算**，不该和 DOM 焊在一起。
 * 抽出的直接动因是一次真实缺陷：空查询时 `fuzzy('', x)` 对所有项都返回 0，
 * 节点因额外加权排满前 50 名，命令被 `slice(0,50)` 全部截掉 —— 面板打开后
 * 一个命令都看不到。该缺陷由冒烟断言发现（"含命令=false"），
 * 修好后这里用单测锁死，不依赖 Electron 即可回归。
 *
 * ## 【W6】本模块是"**什么算命中、谁排在前面**"这一件事的**唯一实现处**
 * 命令面板（`renderer/app-palette.js` / `app-related.js`）与 **AI 侧检索**
 * （`src/item-index.js` 的 `searchItems`，即 CLI `search` / `search-all` 与 MCP `search_nodes`）
 * 都调这里的 `fuzzyMatch` + `rankRows`：
 *   · 判据①"查询词是**非连续子序列**时 CLI 也能命中"靠 `fuzzyMatch`（两边同一个谓词）；
 *   · 判据②"同一查询在 UI 与 CLI 得到**一致顺序**"靠 `rankRows`（两边同一条定序规则：
 *     分数升序 → 同分保持各自入参顺序）。
 * 两边的**差异**只有"候选集与喂什么文本"，写在这里免得后人以为是一套：
 *   · 命令面板：候选 = 命令 + 节点，文本 = `entry.label`（标题）；空查询时**命令在前**、
 *     末尾按 `limit` 截断（那是面板的显示口径，不是排序口径，故由 `rankPalette` 传 `tieBreak`/`limit`）；
 *   · AI 侧检索：候选 = 命中，文本 = **命中面的原文**（标题 / 正文 / 条目正文 / 图片说明 / 链接说明），
 *     没有"命令"这种东西 ⇒ 不给 `tieBreak`；纯 `--tag`（无关键词）时**不排序**（没有可打分的东西）。
 * 打分口径一个字都不许在别处再写一份 —— `tests/search-fuzzy.test.js` 有结构断言把守。
 *
 * ## 【W4】本模块同时是"**多路排序信号怎么合成一个顺序**"这一件事的唯一实现处
 * 混合检索（清单 W4）分两层：**硬过滤**（正交、无权重，判定在 `src/item-index.js`）与
 * **排序信号**（各自独立成一路，本模块）。融合用 **RRF**：`Σ_r w_r / (k + rank_r)` ——
 * 只用名次 ⇒ 不含量纲、不需要归一化、不必知道某一路的分数值域（各路分数本来就互不可比）。
 * 路由表 `ROUTES` / 预设权重 `MODES` / 平滑常数 `RRF_K` / 解析与 `fuse()` **都只有这一份**；
 * `src/item-index.js` 只负责"把每路的**名次**算出来喂进来"（它不写第二份融合与权重）。
 * ⚠️ **热度不在这张表里**：它有自己的封顶口径（`src/heat.js` 的 `SEARCH_RANK`）与自己的位置
 * （**最后一道**封顶重排，`src/item-index.js` 的 `orderByHeat`）—— 两者是两条独立的裁决，
 * 混起来会让"热度 ≤10%"那条变成"一路而已"。细节与理由见下面 `ROUTES` / `MODES` 那一段。
 *
 * ## 【W4b】本模块还是"**哪几路能把非字面命中接回来**"的唯一实现处
 * 扩召回（清单 W4 被裁出去的另一半）**不改变**上面那套"怎么排"：它只回答"候选集从哪来"。
 * 三件事写在这里，别处再写一份就会漂：
 *   · **哪几路能扩召回**：`ROUTES` 那一行的 `recall`（现取 `RECALL_ROUTE_IDS`）；
 *   · **接回来的命中报什么 `matchIn` 取值**：同一行的 `recallHit`（现取；`src/item-index.js` 的
 *     封闭取值表 `MATCH_IN` 必须含它 —— `tests/item-index.test.js` 有一条"表与实现不许漂"的断言）；
 *   · **深度上界**：同一行的 `bound`（与"图距离"这一路**同一个数**：能进来的是"名次表里本来就有、
 *     只是从前没有候选位"的那批节点）。
 * `--recall` 的解析（取值合法性、写错的报文）也只有这里的 `parseRecall` 一份。
 *
 * 面板自己的排序规则（有明确的理由，不是随手写的）：
 *   1. 空查询 → **命令在前、节点在后**：还没打字时人最可能想"执行一个动作"，
 *      而 131 个节点里盲找没有意义。两组各自保持原顺序。
 *   2. 有查询 → 模糊分升序（越小越优）；同分时命令优先，再次按原顺序。
 *      "同分命令优先"是因为命令名短、更像是精确想找的东西。
 *   3. limit 截断（默认 50），避免一次渲染上千项。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMPaletteRank = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_LIMIT = 50;
  const WORD_HEAD = /[\s\-/_.:：、]/;   // 命中这些字符之后的字符算"词首"，加分

  /**
   * 子序列模糊匹配 —— **全工程唯一的打分实现**（命令面板与 AI 侧检索都从这里拿）。
   *
   * **返回 null 表示不匹配**（而不是返回 -1）。这一点是必须的：
   * 词首加分会让**合法命中得到负分**（例：'tcp' 命中 'tcp 连接管理' 得 -1.92，
   * 因为首字符命中就 -2）。曾用 `>= 0` 当"是否命中"的判据，
   * 结果是**以关键词开头的节点反被丢掉**（分数为负），而关键词出现在中段的却保留 ——
   * 完全反直觉。该缺陷由 tests/palette-rank.test.js 发现（冒烟断言没抓到）。
   *
   * 别把"子串"和"子序列"当两套口径：**任何子串都是子序列** ⇒ 只留这一个谓词就够
   * （旧实现里那些 `indexOf(kw) >= 0` 是它的特例，不是第二条判据）。
   *
   * @returns {{score:number, start:number}|null}
   *   `score` 越小越优，**可为负**；`start` = 贪婪对齐里**首字符**落在 hay 的下标
   *   （取片段窗口用；空 needle ⇒ `start = -1`，意思是"没有位置"，与"从头部取"同义）；
   *   不匹配 ⇒ null；空 needle ⇒ `{score: 0, start: -1}`（于是"空查询一行不丢、一分不差"）。
   */
  function fuzzyMatch(needle, hay) {
    const n = String(needle === undefined || needle === null ? '' : needle).toLowerCase();
    const h = String(hay === undefined || hay === null ? '' : hay).toLowerCase();
    if (!n) return { score: 0, start: -1 };
    let hi = 0;
    let score = 0;
    let last = -1;
    let start = -1;
    for (let i = 0; i < n.length; i++) {
      const idx = h.indexOf(n[i], hi);
      if (idx < 0) return null;
      if (i === 0) start = idx;
      score += idx - (last + 1);                    // 跳过的字符越少越优
      if (idx === 0 || WORD_HEAD.test(h[idx - 1])) score -= 2;   // 词首命中加分
      last = idx;
      hi = idx + 1;
    }
    return { score: score + h.length * 0.01, start: start };      // 同分时短串优先
  }

  /** 只要分数的那一档（`fuzzyScore('', x) === 0` 的老口径逐字保留：空查询一切同分） */
  function fuzzyScore(needle, hay) {
    const m = fuzzyMatch(needle, hay);
    return m === null ? null : m.score;
  }

  /** 命令优先于节点（空查询与同分两种情况都用它） */
  function kindRank(entry) {
    return entry && entry.kind === 'cmd' ? 0 : 1;
  }

  /**
   * **用上面那一份打分定序**（唯一实现处）：分数升序 → `tieBreak` → 保持入参顺序（稳定）。
   * 不匹配的行被丢掉（那是"命中判定"的另一半，与打分同一个谓词 —— 两边不许各判一次）。
   *
   * 为什么"同分保持入参顺序"写在这里而不靠 `Array.prototype.sort` 的稳定性：
   * 排序规则要对**两个消费者**同时成立（面板的 `label` 序 / 检索的 DFS+条目序），
   * 显式带在比较器里，谁改都不需要靠"引擎恰好稳定"这条隐性前提。
   *
   * ⚠️ 本函数**不 trim** `query`：needle 原样交给 `fuzzyMatch`。
   * 要 trim 是**调用方**的事（`rankPalette` 就是这么做的：输入框里敲的空格不该算查询词），
   * 而检索侧**不能** trim —— 命令层拿到的关键词若带空格，trim 之后"命中判定"与"定序"
   * 用的就不是同一个 needle，会**静默丢命中**（判了命中却又在排序时被丢掉）。
   *
   * @param {Array} rows 待排序的行（原样返回同一批对象引用，不克隆）
   * @param {string} query 查询词（**原样**，见上）
   * @param {function} textOf `(row, index) => string`：这一行拿哪段文本参与打分
   * @param {function} [tieBreak] `(a, b) => number`：同分时的二级定序（默认 0 = 保持原序）
   * @returns {Array} 命中的行（按上面的规则排序）
   */
  function rankRows(rows, query, textOf, tieBreak) {
    const list = Array.isArray(rows) ? rows : [];
    const text = typeof textOf === 'function' ? textOf : (r) => (r && r.label);
    const scored = [];
    list.forEach((row, index) => {
      const m = fuzzyMatch(query, text(row, index));
      if (m === null) return;            // null = 不匹配（分数可为负，不能用 >=0 判定）
      scored.push({ row: row, score: m.score, index: index });
    });
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (typeof tieBreak === 'function') {
        const k = tieBreak(a.row, b.row);
        if (k) return k;
      }
      return a.index - b.index;          // 保持原顺序（稳定）
    });
    return scored.map((x) => x.row);
  }

  /* ============================================================================
   * 【W4】混合检索：**多路排序信号 → 一个顺序**（融合与权重只有这一处）
   * ----------------------------------------------------------------------------
   * 清单出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 `## W4｜混合检索与"权重怎么处理"`。
   * 分两层，**别把两层搅在一起**（这正是"权重怎么处理"的答案）：
   *   ① **硬过滤**（正交、无权重）：`--scope` / `--tag` / `--since` / `--type` / `--verified` / `--src`
   *      —— 判定在 `src/item-index.js`（`passItemFilters` 等），**不进**下面的权重表；
   *   ② **排序信号**（各自独立成一路，本段）：每路只出**名次**，由 `fuse()` 合成一个顺序。
   * 融合方式是 **RRF（倒数排名融合）**：`总分(d) = Σ_r w_r / (k + rank_r(d))`。
   * 选它的理由：**只吃名次** ⇒ 不含量纲、不需要归一化、不必知道某一路分数值域 ——
   * 各路的"分"本来就互不可比（模糊分可为负、热度是份额、图距离是跳数），
   * 硬把它们相加就是"两把尺子加起来"，也就必然要藏一堆魔数与归一化系数 ✗。
   *
   * ⚠️ **与热度（H1）的分界**：热度**不在**这张路由表里 —— 它有自己的封顶口径
   * （`src/heat.js` 的 `SEARCH_RANK`：人 / AI 两条、合并 ≤ 8%）与自己的位置（**最后一道**重排，
   * `src/item-index.js` 的 `orderByHeat`）。把它塞进 RRF 会让"≤10%"那条裁决变成"一路而已" ✗。
   *
   * 三条性质（判据靠它们，`tests/search-hybrid.test.js` 钉着）：
   *   ① **只启用 `text` 一路 ⇒ 顺序逐字不变**（RRF 对名次严格单调 ⇒ 与不做融合同序）；
   *   ② **权重是相对的**（整份乘 3 不改顺序）——"不含量纲"的可测形态；
   *   ③ **某一路恒空**（一路都不给名次）不是错误：如实记 `ranked: 0`，
   *      但必须在 `--explain` 里看得见（不许静默少一路 ✗）。
   * ========================================================================== */

  /**
   * 排序信号表（**唯一一份**：路由 id、人看的名字、取自哪一处真值、装了没有）。
   * 加一路就必须在这里加一行 —— 权重解析、`--explain`、登记表描述都从它现取，
   * 别处再写一份 id 清单就会漏（病根同 `src/heat.js` 的 `CHANNELS`）。
   */
  const ROUTES = Object.freeze([
    Object.freeze({ id: 'text', label: '字面匹配',
      source: '本模块的 rankRows（命令面板同一份打分）', installed: true,
      recall: false }),
    Object.freeze({ id: 'graph', label: '图距离',
      source: 'node.links 与 assoc.members 的跳数（项目内、无向）', installed: true,
      // 这一路自己的**深度上界**（跳数；唯一一处，`src/item-index.js` 的 graphHopsFrom 从这里现取）：
      // 一跳 = 与最佳命中直接相关的知识点，两跳 = "经由一个中介"。三跳起与字面匹配的关系就只剩
      // "同在一个库里"，而且名次越靠后 RRF 贡献越小 ⇒ 让它继续扩只有成本没有信号。
      // 【W4b】这个 `bound` 同时是**扩召回**的深度上界（同一件事只有这一个数：能进来的是"名次表里
      // 本来就有、只是从前没有候选位"的那批节点 —— 上界不一样就会出现"排得上名次却进不了候选集"）。
      bound: 2,
      boundWhy: '一跳=直接相关，两跳=经由一个中介；三跳起关系只剩"同在一个库里"',
      /* 【W4b】这一路**能扩召回**（`recall: true`）+ 它接回来的命中报哪个 `matchIn` 取值。
       * 为什么只有它：另外几路（trust / time / semantic）都只对**已经进来的候选**打分，它们
       * 手上没有"一条新候选"这个概念；而这一路手上有那张跳数表（`graphHopsFrom`），
       * 表里的近邻本来就已经排好了顺序 —— 扩召回只是把"从前被丢掉的那半张表"接回来。 */
      recall: true, recallHit: 'near' }),
    Object.freeze({ id: 'trust', label: '来源可信度',
      source: 'item.verified（已核）/ node.origin（导入而来，见 src/schema.js）', installed: true,
      recall: false }),
    Object.freeze({ id: 'time', label: '时效',
      source: 'item.at（**只取既有真值**；W2 落地后由 W2 扩来源）', installed: true,
      recall: false }),
    Object.freeze({ id: 'semantic', label: '语义近似',
      source: 'W3（向量 / 语义）——**未安装**，权重收下但不产生名次',
      installed: false, recall: false,
      why: 'W3 未落地：本工程零必需运行时依赖，语义那一路是可选组件（清单 W3 一节）' })
  ]);
  const ROUTE_IDS = Object.freeze(ROUTES.map((r) => r.id));

  /**
   * 【W4b】**能扩召回**的路由（`ROUTES` 里 `recall: true` 的；唯一一处）。
   * `--recall` 的取值合法性、命令登记表的描述、`--explain` 的读数全部从它现取 ——
   * 别处再写一份"哪几路能扩召回"就会漏（病根同 `ROUTES` 本身）。
   */
  const RECALL_ROUTE_IDS = Object.freeze(ROUTES.filter((r) => r.recall).map((r) => r.id));

  /**
   * RRF 的平滑常数 `k`（唯一一处）。取值 **60**：照 RRF 原论文（Cormack 等，2009）的默认。
   * 它只决定"名次差有多要紧"（k 越小，第 1 名对第 2 名的优势越大：k=0 时是 2 倍、
   * k=60 时是 61:60）—— **与任何一路的量纲无关**，改它不动单路顺序，只动多路的交叉。
   * 所以它不是一个"调出来的阈值"：本件不靠它区分好坏，只在 `--explain` 里如实报出来。
   * 换它的口子（`__setRrfKForTest`）只有判据"注入 ⇒ 必红 ⇒ 还原 ⇒ 复绿"用。
   */
  const RRF_K = 60;
  let rrfK = RRF_K;
  function rrfKOf() { return rrfK; }
  /** **只给测试用**：换掉 k（返回被换掉的那个值，便于还原）。 */
  function __setRrfKForTest(v) {
    if (!Number.isFinite(v) || v < 0) throw new Error('__setRrfKForTest 需要一个 ≥ 0 的数');
    const old = rrfK;
    rrfK = Number(v);
    return old;
  }
  function __resetRrfKForTest() { rrfK = RRF_K; }

  /**
   * 预设权重（**唯一一处**；每个值后面的理由就是"为什么这么拍"）。
   * 读法：`w_r` 是那一路的**相对**话语权（只比大小，没有单位）。
   *
   * ⚠️ **量级提醒（改这里的数之前先读）**：RRF **只吃名次** ⇒ 名次相邻的两条，文本那一路的贡献差
   * 只有 `1/(k+r) − 1/(k+r+1) ≈ 1/(k+1)²`，而辅助路把"第 1 名"与"第 m 名"拉开的幅度是
   * `w·(1/(k+1) − 1/(k+m))`。两式一比就能看出：**`w < 1` 的辅助路翻不动相邻名次**，
   * 只有当它的名次差**很大**（例如"已核"那条在 trust 里第 1、对比那条第 9）时才翻得动；
   * 而 `w ≈ 1` 及以上就能与字面**平权**地重排。⇒ 下面这些 0.5 / 0.2 **不是"很轻"**：
   * 几条辅助路一致时，它们会真的改变前几名的次序（黄金集 `tests/fixtures/hybrid-golden.json`
   * 就是拿来量这件事的，`_note` 里记着实测事实）。要"辅助路只做微调"就自己给更小的权重
   * （`--weights text=1,graph=.05,…`）。**别凭感觉调**：改完跑黄金集看前后对比数字。
   */
  const MODES = Object.freeze({
    /** 均衡档（默认）：字面匹配当基准 = 1；图距离给一半（"就近的相关知识点"补一半相关性）；
     *  可信度与时效各 0.2 —— 它们是**微调**，抢不走字面匹配的位子。 */
    balanced: Object.freeze({ text: 1, graph: 0.5, trust: 0.2, time: 0.2, semantic: 0 }),
    /** 近期档：时间与字面同权（"最近发生的"与"最相关的"并列），图距离压到 0.2。 */
    recent: Object.freeze({ text: 1, graph: 0.2, trust: 0.1, time: 1, semantic: 0 }),
    /** 概念档：图距离 > 字面（"换个说法找同一个概念"），字面降为 0.5；时间关掉
     *  （概念相似与新旧无关，留着它只会把新条目顶上来）。 */
    conceptual: Object.freeze({ text: 0.5, graph: 1, trust: 0.2, time: 0, semantic: 0 })
  });
  const DEFAULT_MODE = 'balanced';

  /**
   * `--mode <预设>` 的解析（纯函数 ⇒ 可单测；**响亮**：写错就报，不悄悄退回默认档）。
   * @returns {{ok:true, mode:string} | {ok:false, message:string}}
   */
  function parseMode(v) {
    const names = Object.keys(MODES);
    if (v === true || v === undefined || v === null || String(v).trim() === '') {
      return { ok: false, message: '--mode 需要一个预设名：' + names.join(' | ')
        + '（均衡 | 近期 | 概念；不给 --mode 与 --weights 时混合检索**不启用**，顺序与从前逐字相同）' };
    }
    const m = String(v).trim();
    if (names.indexOf(m) < 0) {
      return { ok: false, message: '--mode 不认识 `' + m + '`：可选 ' + names.join(' | ')
        + '（预设权重表在 src/palette-rank.js 的 MODES，唯一一处）' };
    }
    return { ok: true, mode: m };
  }

  /**
   * `--weights text=1,graph=.5,time=.2` 的解析（纯函数 ⇒ 可单测）。
   *
   * **口径：给了 `--weights`，它就是那一批路由的完整名单** —— 没提到的路由权重 = 0
   * （并在 `--explain` 的逐路读数里如实报 0）。为什么不"在预设上逐路覆盖"：
   * 那样同一句话在不同的人脑子里是两个意思（"我说的权重" vs "它实际用的权重"），
   * 而这正是本工程一直在消灭的那种静默。要"只改一路"就把整份写出来。
   *
   * 四条响亮（都不许静默退化）：不认识的 route 名 / 不是数的值 / 负数 / 同一个 route 写两遍。
   */
  function parseWeights(v) {
    if (v === true || v === undefined || v === null || String(v).trim() === '') {
      return { ok: false, message: '--weights 需要一个 `路由=权重` 的列表（逗号分隔，如 `--weights text=1,graph=.5`）。'
        + '本件支持的路由：' + ROUTE_IDS.join(' / ') + '（表在 src/palette-rank.js 的 ROUTES）' };
    }
    const weights = {};
    const parts = String(v).split(',');
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (!seg) continue;
      const eq = seg.indexOf('=');
      if (eq < 0) {
        return { ok: false, message: '--weights 的 `' + seg + '` 少了 `=`：要写成 `路由=权重`（如 `text=1`）' };
      }
      const key = seg.slice(0, eq).trim();
      const raw = seg.slice(eq + 1).trim();
      if (ROUTE_IDS.indexOf(key) < 0) {
        return { ok: false, message: '--weights 里不认识的 route `' + key + '`：本件支持 '
          + ROUTE_IDS.join(' / ') + '（表在 src/palette-rank.js 的 ROUTES，唯一一处）' };
      }
      if (Object.prototype.hasOwnProperty.call(weights, key)) {
        return { ok: false, message: '--weights 里 `' + key + '` 写了两次 —— 哪个说了算？删掉一个'
          + '（别让"后写的赢"这种隐性规则决定检索顺序）' };
      }
      const num = Number(raw);
      if (!raw.length || !Number.isFinite(num)) {
        return { ok: false, message: '--weights 里 `' + key + '` 的权重不是数：`' + raw + '`' };
      }
      if (num < 0) {
        return { ok: false, message: '--weights 里 `' + key + '` 是负数（' + raw + '）——本件没有"反向排序"这条口径；'
          + '不要某一路就写 0' };
      }
      weights[key] = num;
    }
    const given = Object.keys(weights);
    if (!given.length) {
      return { ok: false, message: '--weights 里一个 `路由=权重` 都没有（给的是 `' + String(v) + '`）' };
    }
    // 完整名单语义：没提到的路由补 0（**报在明面上**，不是"沿用预设"）
    ROUTE_IDS.forEach((id) => { if (!Object.prototype.hasOwnProperty.call(weights, id)) weights[id] = 0; });
    return { ok: true, weights: weights };
  }

  /**
   * 【W4b】`--recall <路由[,路由]>` 的解析（纯函数 ⇒ 可单测；**响亮**：写错就报，不悄悄退回默认档）。
   *
   * 口径（三条，理由都写在报文里，免得读的人猜）：
   *   · 取值只能是 `ROUTES` 里标了 `recall: true` 的路由（现取 `RECALL_ROUTE_IDS`）；
   *   · 认得出但**不能**扩召回的路由（trust / time / semantic）**不静默忽略**：它们是"排序信号"，
   *     只在既有候选内部定序，手上没有"一条新候选"这件事 ⇒ 点名说清，并给出能用的那几路；
   *   · 同一个路由写两遍 ⇒ 报错（同 `parseWeights` 的纪律：别让"后写的赢"决定候选集）。
   *
   * @returns {{ok:true, routes:string[]} | {ok:false, message:string}}
   */
  function parseRecall(v) {
    const can = RECALL_ROUTE_IDS.join(' / ');
    if (v === true || v === undefined || v === null || String(v).trim() === '') {
      return { ok: false, message: '--recall 需要一个（或几个）**能扩召回的路由**名：' + can
        + '（只有把"非字面命中"接回来的那几路才配点名它；它们各自的上界取自 src/palette-rank.js 的 ROUTES）' };
    }
    const routes = [];
    const parts = String(v).split(',');
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i].trim();
      if (!key) continue;
      if (ROUTE_IDS.indexOf(key) < 0) {
        return { ok: false, message: '--recall 里不认识的 route `' + key + '`：路由表里有 '
          + ROUTE_IDS.join(' / ') + '，其中**能扩召回**的只有 ' + can
          + '（表在 src/palette-rank.js 的 ROUTES，唯一一处）' };
      }
      if (RECALL_ROUTE_IDS.indexOf(key) < 0) {
        return { ok: false, message: '`' + key + '` 这一路**不能扩召回**：它只在**既有候选内部**定序'
          + '（手上没有"一条新候选"这件事）⇒ 点它没有意义，也不会被静默忽略。'
          + '能扩召回的是 ' + can + '（判据在 src/palette-rank.js 的 ROUTES 那一行）' };
      }
      if (routes.indexOf(key) >= 0) {
        return { ok: false, message: '--recall 里 `' + key + '` 写了两次 —— 哪个说了算？删掉一个'
          + '（它决定**候选集**，不是"重一点/轻一点"那种事）' };
      }
      routes.push(key);
    }
    if (!routes.length) {
      return { ok: false, message: '--recall 里一个路由名都没有（给的是 `' + String(v) + '`）：可选 ' + can };
    }
    return { ok: true, routes: routes };
  }

  /**
   * 把调用方给的 `{mode, weights}` 归一成**一份生效配置**（唯一一处：CLI / MCP / 测试都走它）。
   * 两种写法都给了 ⇒ `--weights` 就是完整名单（见 `parseWeights` 的口径），`--mode` 只用来
   * 在 `--explain` 里说明"这批权重出自哪一档"这件事……**不**——那会让同一个参数有两种作用。
   * 所以：两个都给 ⇒ **报错**（两种口径不混），与 `--topic-only` × 条目级过滤同一条纪律。
   *
   * 【W4b】这里多收一个 `recall`（= `--recall <路由>` 的原文），并把它归一成 `spec.recall`。
   * 为什么扩召回**要求同时给 `--mode` / `--weights`**：它改变的是**候选集**，而"新接回来的候选
   * 与既有候选怎么排到同一个顺序"是这一层（RRF）的事。只给 `--recall` 就等于要这里**偷偷挑一个
   * 默认预设**去排——那正是 W4 一直在消灭的那种静默（"我没给权重，但它在替我用一套"）。
   * ⇒ 明说：要扩召回就同时说要怎么排（`--mode balanced --recall graph`）。
   */
  function hybridSpecOf(opts) {
    const o = opts || {};
    const hasMode = o.mode !== undefined && o.mode !== null && o.mode !== false;
    const hasWeights = o.weights !== undefined && o.weights !== null && o.weights !== false;
    const hasRecall = o.recall !== undefined && o.recall !== null && o.recall !== false;
    const rc = hasRecall ? parseRecall(o.recall) : null;
    if (rc && !rc.ok) return { ok: false, message: rc.message };
    if (hasMode && hasWeights) {
      return { ok: false, message: '--mode 与 --weights 不能同给：前者是**预设**、后者是**完整权重名单**，'
        + '两个都给就等于两种口径（选一个：要预设写 --mode，要自己定就整份写 --weights）' };
    }
    if (!hasMode && !hasWeights && !hasRecall) {
      return { ok: true, spec: { enabled: false, mode: null, weights: null, k: rrfKOf(),
        recall: { on: false, routes: [] } } };
    }
    if (hasRecall && !hasMode && !hasWeights) {
      return { ok: false, message: '--recall 要配合 --mode 或 --weights 一起给：它改变的是**候选集**'
        + '（多接回几条），而"这批候选怎么排"是**融合那一层**的事 —— 只给 --recall 就等于替你偷偷挑一个'
        + '默认预设，那是隐性口径。比如：`--mode ' + DEFAULT_MODE + ' --recall ' + rc.routes.join(',') + '`'
        + '（不给 --mode / --weights 时混合检索整层是关的：输出与从前逐字节相同）' };
    }
    const recall = rc ? { on: true, routes: rc.routes } : { on: false, routes: [] };
    if (hasMode) {
      const m = parseMode(o.mode);
      if (!m.ok) return { ok: false, message: m.message };
      return { ok: true, spec: { enabled: true, mode: m.mode, weights: MODES[m.mode], k: rrfKOf(), recall: recall } };
    }
    const w = parseWeights(o.weights);
    if (!w.ok) return { ok: false, message: w.message };
    return { ok: true, spec: { enabled: true, mode: null, weights: w.weights, k: rrfKOf(), recall: recall } };
  }

  /**
   * **融合**（RRF，唯一实现处）：入参是"每路自己的名次"，出参是"一个顺序"。
   *
   * @param {object} orderings `{ 路由id: number[] }` —— 每路一个**候选下标数组**，最好的在前。
   *        某一路可以**少给或不给**（= 那一路没给这些候选名次）；下标重复只认**第一次**（名次唯一）。
   * @param {object} weights `{ 路由id: number }`（缺的当 0；≤0 或非数 = 那一路不参与）
   * @param {number} n 候选总数
   * @returns {{order:number[], totals:number[], routes:Array}}
   *   `order` = 融合后的候选下标；`totals[i]` = 第 i 个候选的总分（只用于 `--explain` 与对比）；
   *   `routes[]` = 逐路的 `{id, weight, ranked, ranks:Map<下标,名次>}`（`--explain` 的读数来源）。
   *
   * 同分时的二级键是 **`text` 路的名次**（候选集本来就由它定义，见 `src/item-index.js`），
   * 再不行才按输入顺序 —— 不依赖 `Array.prototype.sort` 的稳定性（与 `rankRows` 同一纪律）。
   */
  function fuse(orderings, weights, n) {
    const total = Number(n) > 0 ? Math.floor(Number(n)) : 0;
    const w = weights || {};
    const src = orderings || {};
    const totals = [];
    for (let i = 0; i < total; i++) totals.push(0);
    const k = rrfKOf();
    const routes = ROUTES.map((r) => {
      const weight = Number(w[r.id]);
      const wv = (Number.isFinite(weight) && weight > 0) ? weight : 0;
      const list = Array.isArray(src[r.id]) ? src[r.id] : [];
      const ranks = new Map();
      for (let i = 0; i < list.length; i++) {
        const idx = list[i];
        if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
        if (!ranks.has(idx)) ranks.set(idx, i + 1);
      }
      if (wv > 0) {
        ranks.forEach((rank, idx) => { totals[idx] += wv / (k + rank); });
      }
      return { id: r.id, weight: wv, ranked: ranks.size, ranks: ranks };
    });
    const textRow = routes.filter((x) => x.id === 'text')[0];
    const baseline = (i) => (textRow && textRow.ranks.has(i)) ? textRow.ranks.get(i) : Number.MAX_SAFE_INTEGER;
    const order = [];
    for (let i = 0; i < total; i++) order.push(i);
    order.sort((a, b) => (totals[b] - totals[a]) || (baseline(a) - baseline(b)) || (a - b));
    return { order: order, totals: totals, routes: routes };
  }

  /** 某一条候选的**逐路贡献**（`--explain` 的机器可读形态）：只读 `fuse()` 的产物，不重算名次/权重。 */
  function contributionsOf(fused, index) {
    const k = rrfKOf();
    return ((fused && fused.routes) || []).map((r) => {
      const rank = r.ranks.has(index) ? r.ranks.get(index) : null;
      const add = (rank === null || !(r.weight > 0)) ? 0 : r.weight / (k + rank);
      return { route: r.id, rank: rank, weight: r.weight, add: add };
    });
  }

  /**
   * 排序并截断**命令面板的候选列表**（面板专用的那一层：命令优先 + limit）。
   * 打分与定序一律走 `rankRows`（与 AI 侧检索同一份实现）—— 这里只多两件面板自己的事：
   * 同分时命令优先（`tieBreak`）、末尾截断（`limit`）。
   *
   * @param entries [{kind:'cmd'|'node', label, ...}] 其余字段原样透传
   * @param query   用户输入（**这里会 trim**：输入框里的空白不算查询词）
   * @param limit   0/负值表示不限；缺省 50
   * @returns 排序后的 entries（同一批对象引用，未克隆）
   */
  function rankPalette(entries, query, limit) {
    const q = String(query === undefined || query === null ? '' : query).trim();
    const lim = limit === undefined ? DEFAULT_LIMIT : Number(limit);
    const ordered = rankRows(entries, q, (e) => e && e.label, (a, b) => kindRank(a) - kindRank(b));
    return lim > 0 ? ordered.slice(0, lim) : ordered;
  }

  return {
    fuzzyMatch: fuzzyMatch, fuzzyScore: fuzzyScore, rankRows: rankRows, rankPalette: rankPalette,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    // 【W4】混合检索的**路由表 / 权重与预设 / RRF 融合**（唯一实现处；数字与理由都在上面那一段）
    ROUTES: ROUTES, ROUTE_IDS: ROUTE_IDS, RRF_K: RRF_K, rrfKOf: rrfKOf, MODES: MODES,
    DEFAULT_MODE: DEFAULT_MODE,
    parseMode: parseMode, parseWeights: parseWeights, hybridSpecOf: hybridSpecOf,
    // 【W4b】**扩召回**：能扩召回的路由（`ROUTES` 里标了 `recall` 的那几行，唯一一处）与它的解析
    RECALL_ROUTE_IDS: RECALL_ROUTE_IDS, parseRecall: parseRecall,
    fuse: fuse, contributionsOf: contributionsOf,
    // 只给测试：k 的注入口（照 `src/heat.js` 里那个"只给测试换数值"的先例：判据可重复执行，
    // 不必手改源码跑一次）。生产代码永不调它；名字与那个先例也不同 —— 免得撞红
    // `tests/search-heat.test.js` 那条"注入口名字只许出现在一处"的结构断言。
    __setRrfKForTest: __setRrfKForTest, __resetRrfKForTest: __resetRrfKForTest
  };
});
