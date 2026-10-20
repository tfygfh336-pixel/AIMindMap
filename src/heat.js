/* ============================================================
 * src/heat.js — 访问事件日志 + 两条热度（人 / AI）的**派生口径**
 * ------------------------------------------------------------
 * ## 这个模块回答什么
 * 「这个节点最近一个月被**人**看过几次、被 **AI** 用过几次；在所有被访问过的节点里排第几」。
 * 用户 2026-10-12 的四条裁决（原文与硬约束见 `.review/20261012-热度条/规格与裁决.md` §一/§二），
 * 与本件直接相关的三条：**人只算「打开详情框」**、**AI 各通道都计入并按通道加权**、
 * **排名在「窗口内被访问过的节点」这个子集内部做**（零访问节点不进榜、不参与分位）。
 *
 * ## 三层分工
 *   ① **事件日志**（本文件）：一行一条"哪条通道在什么时候访问了哪个节点"，只追加；
 *   ② **派生热度**（本文件）：窗口 + 排名 + 名次→档位 —— 一定是**算出来的**，不许手写；
 *   ③ **进检索排序**（第二件，见下方 `SEARCH_RANK` / `searchBoost`）：本文件出**数值与口径**
 *      （三条上限、名次→档位），`src/item-index.js` 出**排序**（唯一一处重排命中顺序的地方），
 *      命令层只做"读一次 + 传进去"。界面（第三件）只**展示**：画两条热度条的那份读数由
 *      `heatProfile()` 出（一个节点 → `{热度, 名次, 样本量}`），界面**不许自己算分位** ✗；
 *      AI 侧的隐藏维度（标签 / 章节 / 节点树）由 `derivedHeat()` 出 —— 两者都**只吃** `computeHeat`
 *      的结果，所以"热度一变、展示与派生一起变"是构造上成立的。
 *
 * ## 事件是谁写的（两处写点，都只调本文件的 `appendEvent`）
 *   · `visit` 命令 —— **人**的那条通道（界面打开详情框）；
 *   · `cli/core.js` 的 `ctx.recordVisit`（由 `get`/`read`/`search`/`related`/`ask` 调）—— AI 的五条通道。
 *     上限口径在 `src/heat-sensor.js`（唯一一处）。本文件不知道"谁在什么时候记"，只保证写入 O(1)。
 *
 * ## 为什么是 sidecar、而不是项目文件里的字段
 * 同 `src/changes.js` 的理由：项目 JSON 是**当前事实的唯一真源**，把"访问流水"塞进去等于
 * ① 同一事实两处表达（当前状态 vs 流水）⇒ 必然漂移；② 文件无界增长；
 * ③ **每次访问都要重写整份项目文件** —— 而访问是最热的动作。
 * 所以落在 `<项目根>/.visits/<项目名>.jsonl`：一行一条 JSON、**只追加**、不进 `export-json`、
 * 可随时删（删掉后 `heat` 会明说"本机没有访问日志"，**绝不把"采不到"说成"热度 0"**）。
 * ⚠️ **它在项目目录之外**（平级的点目录里）—— 理由三条，逐字见 `src/data-store.js` 的
 * `visitLogFile`：① "读命令在项目目录里零字节"是本工程硬挣来的不变量，日志放里面必然破掉它；
 * ② 访问痕迹是**本机使用痕迹、不是项目内容**；③ 仍按项目分一份，删一个项目就少一份。
 * 路径的**唯一推导处**是 `store.visitLogFile()`（本文件只定文件名与格式）。
 *
 * ## 两条硬约束（规格 §二）怎么满足的
 *   · **写入 O(1) 追加**：`appendEvent` 只有一次 `fs.appendFileSync` —— 不读全量、不重写文件、
 *     不需要锁。**代价（有意）**：写入端因此不做任何"先读后判"（比如校验上一条的时间戳），
 *     于是"日志时序"这条不变量只能由**写入方行为**保证，读方**自检**（见下）。
 *   · **读热度走窄查询**：`readTail` 只读文件的**尾部**（默认 `READ_CHUNK_BYTES`，不够才翻倍）。
 *     这条成立的**前提**是「日志的 `at` 非递减」：写入端只写**写入时刻**（`visit` 命令不接受
 *     调用方给时间）⇒ 天然成立。在前提成立时，窗口（最近一个月）恰好是文件的一段**后缀**
 *     ⇒ **尾部读取是精确的，不是近似**（`tests/heat.test.js` 用"窄读 == 全量读"对拍）。
 *     读区内的乱序会被 `parseEvents` 抓出来并**响亮报错**（F1）。
 *
 * ## 已知边界（诚实标注，别当成保证）
 *   1. **样本少时档位会跳**：`heat` 是「名次在**被访问过的节点**里的十档位置」。窗口内只有
 *      2 个节点被访问时只可能出现 10/5 两档，只有 1 个时恒为 10（它既压过 100% 的样本、
 *      也是唯一的样本）。⇒ 输出**必须**同时给样本量（`sample.nodes`/`sample.events`），
 *      显示层不许假装精确。**它回答的是"在被访问节点里排第几"，不是"占全部节点的分位"**
 *      （零访问节点不进榜、不参与分位）。
 *   2. **手改日志的乱序看不见**：读区内的乱序会报错，但"把一条窗口内的记录塞进文件最前面"
 *      这种手改会让读数**少算**而不报错 —— 日志是**旁路产物**（可随时删），要核对可以不信任它：
 *      `readHeatFile(file, {full:true})` 全量读并校验整个文件的时序（测试里拿它与窄读对拍）。
 *   3. **一张表管一件事**：`CHANNELS` 只定义「**通道之间**的相对强度」与「谁（人/AI）」，
 *      它**不是**检索向量权重（别拿 1.5 / 0.4 去当排序权重）；跨侧的边界是 `SEARCH_RANK`
 *      （裁决三：人上限 / AI 上限 / 合并上限），两者各只有一处定义、互不解释对方。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('fs'), require('./schema.js'));
  else root.MMHeat = factory(null, null);   // 浏览器端：纯逻辑可用，I/O 函数会响亮抛错（见 requireFs）
})(typeof self !== 'undefined' ? self : this, function (fs, schema) {
  'use strict';

  /**
   * 单个项目日志的**文件名**（`<项目根>/.visits/<项目名>.jsonl`，目录在项目目录**之外**）。
   * 带前导点：与本工程既有的点文件同一约定（不进项目目录列举、不进资源扫描、不进导出）。
   */
  const FILE_NAME = '.visits.jsonl';
  /** 条目版本。字段**只增不改**；升版本要有迁移口径（同 `src/changes.js` 的先例） */
  const ENTRY_VERSION = 1;

  /**
   * 窗口 = **最近 30 天**（滚动）。
   *
   * 为什么是滚动 30 天而不是"日历上的上一个月"：日历月在 2 月会缩到 28 天、且"上个月的同一天"
   * 在月末（31 号）根本没有对应日 ⇒ 同一条事件在不同日子**进/出窗口不同**，读数不可复现。
   * 30 天是明确、可机械判定的口径，且"31 天前的事件一定不在窗口内"（判据②）。
   * **改这个数就改这一处**（窗口只有一份定义）。
   */
  const WINDOW_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_MS = WINDOW_DAYS * DAY_MS;

  /** 热度档位数（十档 1–10）。选它的理由见 `heatFromRank`。 */
  const HEAT_BANDS = 10;

  /**
   * 「未来时间戳」的容差。
   *
   * 为什么要容差：写入方与读方是**两次**取时钟（写入时刻 vs 读取时刻），刚刚写下的那条
   * 事件的 `at` 可以略大于读方的 `now`（同一毫秒内、或时钟微调）。把它当"时钟回拨"报错是**假红**。
   * 为什么只给 1 分钟：分钟级以上的未来时间戳不是延迟，是**时钟回拨或手改日志** ⇒ 窗口会失真，
   * 按规格 §二"时间戳异常、时钟回拨 ⇒ 报出来，不许静默当 0"**报错**。
   */
  const FUTURE_TOLERANCE_MS = 60 * 1000;

  /** 窄查询：一次读的尾部字节数（不够按倍翻，直到看见窗口外的行 / 文件头 / 撞上限） */
  const READ_CHUNK_BYTES = 64 * 1024;
  /**
   * 窄查询的上限。撞上它 ⇒ **响亮报错**（不静默给半份读数）：
   * 说明窗口内的事件本身就超过了这个体量，而"不读全量就能给出完整窗口"这条前提已经不成立。
   * 出路：归档 / 删掉 `.visits.jsonl`（旁路产物、可随时删），或调大这个常量。
   */
  const MAX_READ_BYTES = 8 * 1024 * 1024;

  /**
   * ============================================================================
   * **通道权重表** —— 全工程唯一一处（规格 §二「定义只有一处」）
   * ============================================================================
   * 一条访问事件只记「走了哪条通道」（`ch`），**不记权重**：权重是**策略**，会随认识改变；
   * 把策略抄进历史（每一行都带一个 `w`）就是"同一事实两处表达" ⇒ 改了表，旧行仍按旧权重算，
   * 于是工程里同时存在两套口径。这里改成：**读的时候现查这张表** ⇒ 改表即对所有历史生效。
   *
   * 权重是**相对强度**，不是绝对次数：
   *   · 只在**同一侧内部**比较（人榜与 AI 榜各自排名，见 `computeHeat`），所以"1.5"没有"等于
   *     1.5 次人类访问"这种跨侧含义；跨侧的相对权重是**第二件**（检索封顶）决定的。
   *   · 人侧只有一个通道（裁决一：人只算"打开详情框"）⇒ 人侧的加权值与次数恒等。
   *
   * 取值理由（按强度从高到低，这是**有意排的序**，不是随手取数）：
   *   ai-ask        1.5  把该节点当**情境**喂进模型并产出回答（`ask` / `ask-apply`）：内容被
   *                      真正消耗、产出还会落盘 —— AI 侧最强的使用信号 ⇒ 高于基准。
   *   human-detail  1    人**打开详情框**（裁决一里唯一算数的人类动作）。取 1 作基准：
   *                      后面那些小数都是"相对一次人类正视"的强度，本身没有绝对含义。
   *   ai-get        1    按 id **直取单个**节点（`get` / MCP `get_node`）：与"人打开详情框"
   *                      同等强度的"我就要看这一个" ⇒ 与基准同值。
   *   ai-related-hop 0.6 顺着关系**走到**该节点（`related` / `backlinks`，MCP 同名工具）：
   *                      是 AI 主动"从邻居找过来"的动作，比搜索命中更有指向性，
   *                      但不是直接取 ⇒ 介于搜索与直取之间。
   *   ai-search-hit 0.4  搜索**命中并返回**该节点（`search` / MCP `search_nodes`）：命中只是
   *                      候选面，AI 可能一眼跳过 ⇒ 弱信号。比"整页带出"强：它是被关键词捞上来的。
   *   ai-read-view  0.2  整项目/整子树/全列表视图**顺带带出**该节点（`read` / `read --subtree` /
   *                      `list`，MCP `read_project` / `list_nodes`）：一次调用带出几十上百个节点，
   *                      对单个节点的关注度最低 ⇒ 最低档。
   *
   * ⚠️ `label` 只用于显示；`who` 是**派生**字段的唯一来源（`谁`由通道决定，不允许调用方自报 ——
   * 否则会出现"人通道记成 AI"这种没救的数据）。
   */
  const CHANNELS = Object.freeze([
    Object.freeze({
      ch: 'human-detail', who: 'human', weight: 1, label: '打开详情框',
      reason: '裁决一里唯一算数的人类动作（人只算打开详情框）。取 1 作基准，其余是相对它的强度'
    }),
    Object.freeze({
      ch: 'ai-ask', who: 'ai', weight: 1.5, label: 'AI 把它当情境提问（ask）',
      reason: '内容被真正消耗且产出落盘 —— AI 侧最强信号，高于基准'
    }),
    Object.freeze({
      ch: 'ai-get', who: 'ai', weight: 1, label: 'AI 按 id 直取单个节点（get / MCP get_node）',
      reason: '与"人打开详情框"同等强度的"我就要看这一个" ⇒ 与基准同值'
    }),
    Object.freeze({
      ch: 'ai-related-hop', who: 'ai', weight: 0.6, label: 'AI 顺着关系走到它（related / backlinks）',
      reason: '主动从邻居找过来，比搜索命中更有指向性，但不是直接取'
    }),
    Object.freeze({
      ch: 'ai-search-hit', who: 'ai', weight: 0.4, label: 'AI 搜索命中并返回它（search）',
      reason: '命中只是候选面、可能一眼跳过 ⇒ 弱信号；但比整页带出强（它是被关键词捞上来的）'
    }),
    Object.freeze({
      ch: 'ai-read-view', who: 'ai', weight: 0.2, label: 'AI 读整页/整子树顺带带出它（read / list）',
      reason: '一次调用带出几十上百个节点，对单个节点的关注度最低 ⇒ 最低档'
    })
  ]);

  const CHANNEL_MAP = new Map(CHANNELS.map((c) => [c.ch, c]));

  /** 通道 id 清单（稳定顺序 = 上表顺序），供文档/报错/测试引用 */
  const CHANNEL_NAMES = CHANNELS.map((c) => c.ch);

  /** 查一条通道；不认识 ⇒ `null`（**由调用方决定怎么响亮**：写入端与读端都要报错，见文件头） */
  function channelInfo(ch) {
    return CHANNEL_MAP.get(String(ch === undefined || ch === null ? '' : ch)) || null;
  }

  /** 通道表的一行（可读标签），供报错/输出用；不返回冻结的内部对象，免被误改 */
  function channelRow(ch) {
    const c = channelInfo(ch);
    return c ? { ch: c.ch, who: c.who, weight: c.weight, label: c.label } : null;
  }

  /** 「未知通道」的**唯一一处报文**（写入端与读端共用；列出全部合法通道与权重） */
  function unknownChannelError(ch, where) {
    return '未知通道 `' + String(ch === undefined || ch === null ? '' : ch) + '`'
      + (where ? '（' + where + '）' : '') + '。合法通道与权重（唯一一处定义：src/heat.js 的 CHANNELS）：'
      + CHANNELS.map((c) => c.ch + '(' + c.who + ' ' + c.weight + ')').join('、')
      + '。通道 id 不许自创 —— 自创会让这条事件在读数里变成"认不出的通道"，宁可现在报错。';
  }

  /* ============================================================================
   * **检索向量权重（热度条第二件）** —— 全工程唯一一处（规格 §一.2 / §一.3）
   * ============================================================================
   * 热度是 `search` 排序里的**一个封顶向量**：它在"总分"里的**权重份额**有三条上限。
   * 三条上限**只在这里定义一次**（取值与理由写在数字旁边）；`src/item-index.js` 只接受
   * "一个已封顶的加数 + 它占总分的份额"这两个**数**，它不认识这里的任何取值；
   * 命令层（`cli/commands/project.js` 的 `search`）也不写数字，只调 `searchBoost()`。
   *
   * ## 总分怎么构成（这就是"封顶"的可测含义）
   *     总分(命中) = (1 − merged) × 基础分 + 热度项 ，  0 ≤ 热度项 ≤ merged
   *   · **基础分** ∈ (0,1] = 该命中在**既有顺序**（`item-index.js` 的 `entries` 序 = 深度优先 +
   *     条目序，本件之前检索**唯一**的排序依据）里的相对位置。所以"零热度 ⇒ 顺序逐字不变"。
   *   · 于是 **merged 就是热度在总分里的权重份额上限**：基础分那份占 (1−merged) ≥ 92%、
   *     热度那份 ≤ 8%。这不是"实测大概不超过"，是**构造出来的**（两份权重之和 = 1）。
   *
   * ## 三条上限的取值与理由（改任一条都要问用户：这是裁决三明写的边界）
   *   · **human 0.06** —— 人侧上限。人的动作只有一个（`human-detail`，裁决一），信号**干净**：
   *     人看过某节点，不会因此让该节点更容易被自己看到（没有环）。两档里给较高的一档。
   *   · **ai 0.03** —— AI 侧上限 = **人的一半**。裁决三要求"AI 那条权重更低"，理由是**自激环**：
   *     AI 检索命中 ⇒ 记一次 `ai-search-hit` ⇒ 该节点热度升 ⇒ 更容易被检索命中。
   *     压到一半（不是"略低"）有两个用处：① 环增益只有人侧的 1/2；② "两条权重**不相等**"这件事
   *     因此**可机械判别**（同一节点"人热 AI 冷"与"人冷 AI 热"给出**不同**顺序）—— 取同一个数
   *     那条判据就恒真了，等于没有这条边界。
   *   · **merged 0.08** —— 合并上限，**小于 human + ai = 0.09**。为什么不取 0.09：那样它只是前两条
   *     的别名，"合并后仍封顶"这条判决就**没人守**（改它不会有任何读数变化 ⇒ 恒真）。0.08 在
   *     "两条都拉满"时真的会咬住（0.06+0.03=0.09 → 截到 0.08）。为什么不取 0.10（规格的硬上限）：
   *     位移上界是 merged/(1−merged)，0.10 会给出 11.1% > 10%，反而要解释；0.08 给出 8.7%，
   *     让"权重份额 ≤ 10%"与"排序位移 ≤ 10%"两条口径**同时**成立且留有余量。
   *
   * ## 位移上界（`maxJump`，判据①的读数口径）
   *   设 n = 本次命中数、c = merged、d = 两个命中的基础序位置差。一个"热度拉满"的命中要超过
   *   另一个零热度的命中，必须总分更高 ⇒ (1−c)·d/n < c ⇒ d < n·c/(1−c) ⇒ 最多挪
   *     d_max = ceil(n·c/(1−c)) − 1 个位置（同分时按文档序 ⇒ 平手不越位，所以是严格小于）。
   *   c = 0.08、n 很大时 d_max/n → 8.7% ≤ 10% ✓。
   *   ⚠️ 它与"权重份额"是**两条独立的口径**：份额 ≤ merged 是构造出来的，位移 ≤ d_max 是**推出来的**
   *   —— 所以判据①两条都要钉（只钉份额的话，把基础分那份压成 0 也能过）。
   * ========================================================================== */
  const SEARCH_RANK = Object.freeze({
    human: 0.06,
    ai: 0.03,
    merged: 0.08
  });

  /**
   * 当前生效的向量权重。**所有用法都经它**（`searchBoost` / `maxJump`），生产代码永远不换 ——
   * 换它的口子只有一个理由：**判据⑤（注入证明）必须可重复执行**
   * （"把 merged 改成 1.0 ⇒ 判据①必红""把 ai 改成等于 human ⇒ 判据②必红" ⇒ 还原 ⇒ 复绿）。
   * 不给这个口子，那两条证明就只能靠手改源码跑一次，进不了回归。
   */
  let searchRank = SEARCH_RANK;
  function searchRankOf() { return searchRank; }

  /** **只给测试用**：换掉三条上限。返回被换掉的那份，便于还原。 */
  function __setSearchRankForTest(w) {
    const o = w || {};
    if (!Number.isFinite(o.human) || !Number.isFinite(o.ai) || !Number.isFinite(o.merged)) {
      throw new Error('__setSearchRankForTest 需要 {human, ai, merged} 三个数');
    }
    const old = searchRank;
    searchRank = Object.freeze({ human: o.human, ai: o.ai, merged: o.merged });
    return old;
  }
  function __resetSearchRankForTest() { searchRank = SEARCH_RANK; }

  /** 档位 → [0,1] 的分位（档位是 1–10；没被访问过 = 0 ⇒ 分位 0） */
  function bandFraction(band) {
    const b = Number(band);
    if (!Number.isFinite(b) || b <= 0) return 0;
    return Math.min(b, HEAT_BANDS) / HEAT_BANDS;
  }

  /**
   * 把"两条榜"变成**排序加数**（纯函数，不读盘）：`{node → 热度项}` 与它占总分的份额。
   *
   * 三条上限都在这一个函数里落地：
   *   · 人侧最多加 `human × 人侧分位`；
   *   · AI 侧最多加 `ai × AI 侧分位`；
   *   · 两者相加后与 `merged` 取小（"合并后仍封顶"**真的会咬住**）。
   *
   * ⚠️ 输入必须是 `computeHeat` / `readHeatFile` 的 `heat`（**名次→档位**已经算好了）——
   * 这里**不重算名次**（"取值只有一处"：排名口径只在 `computeHeat`）。
   *
   * @param {object} computed `computeHeat` 的返回值（要 `.human` / `.ai` 两条榜）
   * @returns {{scale:number, byNode:Map, weights:object, rankedNodes:number}}
   *   `scale` = 热度项占总分的份额上限（排序公式用的就是它，**不是**常数）
   */
  function searchBoost(computed) {
    const w = searchRankOf();
    const byNode = new Map();
    const add = (list, weight) => {
      (Array.isArray(list) ? list : []).forEach((r) => {
        if (!r || !r.node) return;
        const k = String(r.node);
        byNode.set(k, (byNode.get(k) || 0) + weight * bandFraction(r.heat));
      });
    };
    add(computed && computed.human, w.human);
    add(computed && computed.ai, w.ai);
    byNode.forEach((v, k) => { byNode.set(k, Math.min(round3(v), w.merged)); });
    return {
      scale: w.merged,
      byNode: byNode,
      weights: { human: w.human, ai: w.ai, merged: w.merged },
      rankedNodes: byNode.size
    };
  }

  /**
   * 位移上界：n 个命中时，一个"热度拉满"的命中最多能挪几个位置（推导见上方 `SEARCH_RANK` 注释）。
   * merged ≥ 1 ⇒ 基础分那份被压成 0（顺序完全由热度决定）⇒ **不再有界**，返回 `Infinity`：
   * 这是判据①"超限即红"的读数来源（封顶改成 1.0 时它必然红）。
   */
  function maxJump(n) {
    const c = Number(searchRankOf().merged);
    const total = Number(n);
    if (!Number.isFinite(total) || total <= 1) return 0;
    if (!Number.isFinite(c) || c >= 1) return Infinity;
    if (c <= 0) return 0;
    return Math.max(0, Math.ceil(total * c / (1 - c)) - 1);
  }

  /** UTF-8 字节长度（Node 用 Buffer；浏览器端退化成手工计数 —— 诊断用的偏移量要一致） */
  function byteLength(s) {
    const str = String(s === undefined || s === null ? '' : s);
    if (typeof Buffer !== 'undefined' && Buffer && typeof Buffer.byteLength === 'function') {
      return Buffer.byteLength(str, 'utf8');
    }
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /**
   * 造一条事件。**字段名只在这里定义**（单一真源）。
   *
   * 字段：
   *   · `v`   版本（`ENTRY_VERSION`）
   *   · `at`  ISO 时间。**不给就取写入时刻** —— `visit` 命令就是这么用的：它记的是"这次访问
   *           发生的时刻 = 记录时刻"，**不接受调用方给时间**（一次访问不该出现两个时间）。
   *           显式给 `at` 是给 fixture / 补记用的（读方对乱序会响亮报错，见 `parseEvents`）。
   *   · `node` 节点 id（形状用 `src/schema.js` 的 `ID_RE` —— id 规范只有那一处定义）。
   *           刻意**不校验节点是否存在**：① 记录访问是热路径，读整份项目 JSON 只为校验存在性
   *           会把 O(1) 追加变成 O(项目大小)；② "事件指向的节点后来被删"本来就是事实（访问
   *           确实发生过），读侧会如实标 `missing`；③ 存在性校验会制造一类假失败：界面打开的
   *           瞬间另一路 CLI 删了该节点 ⇒ 一次纯记录动作报错。
   *   · `ch`  通道（**决定 `who` 与权重**，调用方不许自报"我是人/AI"）
   *   · `by`  可选：哪条外壳写的（`<外壳>:<命令>`，与 `.changes.jsonl` 的 `writer` 同口径）
   */
  function buildEvent(o) {
    const e = o || {};
    const ch = e.ch === undefined || e.ch === null ? '' : String(e.ch).trim();
    const c = channelInfo(ch);
    if (!c) throw new Error(unknownChannelError(ch, '写入端'));
    const node = e.node === undefined || e.node === null ? '' : String(e.node).trim();
    if (!node) throw new Error('节点 id 不能为空（一条访问事件必须点名"访问了哪个节点"）');
    const idRe = (schema && schema.ID_RE) || /^[a-z0-9][a-z0-9-]*$/;
    if (!idRe.test(node)) {
      throw new Error('节点 id 不合规范（小写字母/数字/连字符，如 my-node）: ' + node
        + '。规范只有一处定义（src/schema.js 的 ID_RE）—— 这里照它校验，别放宽。');
    }
    const at = (e.at === undefined || e.at === null || String(e.at) === '')
      ? new Date().toISOString() : String(e.at);
    if (!Number.isFinite(Date.parse(at))) {
      throw new Error('`at` 不是可解析的时间: ' + JSON.stringify(at) + '（应为 ISO 时间，如 2026-10-12T10:00:00.000Z）');
    }
    const entry = { v: ENTRY_VERSION, at: at, node: node, ch: c.ch };
    const by = e.by === undefined || e.by === null ? '' : String(e.by).trim();
    if (by) entry.by = by;
    return entry;
  }

  function serializeEvent(entry) { return JSON.stringify(entry) + '\n'; }

  /** 形状判据（**只判形状**，不判时间是否可解析、通道是否认得 —— 那两条各自有更响亮的报文） */
  function looksLikeEvent(o) {
    return !!o && typeof o === 'object'
      && typeof o.v === 'number' && o.v >= 1
      && typeof o.at === 'string' && o.at !== ''
      && typeof o.node === 'string' && o.node !== ''
      && typeof o.ch === 'string' && o.ch !== '';
  }

  /** 诊断用的原文片段（坏行报文里点名它 —— 只说"第 N 行坏了"不够，得让人一眼认出是哪一行） */
  function snippet(s, max) {
    const str = String(s);
    const cap = max || 160;
    return str.length > cap ? str.slice(0, cap) + '…' : str;
  }

  /**
   * 解析日志文本。**坏行/未知通道/乱序都不静默丢**：逐条记下位置（行号、字节偏移、读区内序号）
   * 与原因，由调用方（`readHeatFile` 的 `assertClean`）**响亮报错**。
   *
   * 为什么位置要给**字节偏移**：窄查询只读了文件尾部，此时"第几行"是**读区内的行号**，
   * 与文件的真实行号不是一个东西（想说真行号就得把前半段也读一遍 = 破坏窄查询），
   * 所以：读到文件头（`opts.line` 给了基准）时报真行号，否则**只报字节偏移**并注明"读区第 M 行"。
   *
   * @param {string} text 日志文本（可以是尾部切片）
   * @param {{offset?:number, line?:number}} [opts] `offset` = 这段文本第一个字节在文件中的偏移；
   *        `line` = 这段文本第一行在文件中的行号（只在从文件头读时知道）
   */
  function parseEvents(text, opts) {
    const o = opts || {};
    const out = { events: [], badLines: [], unknownChannels: [], outOfOrder: [], lines: 0 };
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) return out;
    const bomLen = s.charCodeAt(0) === 0xfeff ? 1 : 0;
    const body = bomLen ? s.slice(1) : s;
    const baseLine = (typeof o.line === 'number' && o.line > 0) ? o.line : null;
    // BOM 只在"从文件头读"时出现（窄读从行首之后开始）⇒ 它占的 3 字节要把偏移量推后
    let offset = (Number(o.offset) || 0) + (bomLen ? byteLength('\uFEFF') : 0);
    const parts = body.split('\n');
    let prev = null;
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      const here = offset;
      offset += byteLength(raw) + 1;              // + '\n'（最后一行没有换行符时多算 1 字节：只影响诊断）
      const lineNo = baseLine === null ? null : baseLine + i;
      const trimmed = raw.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      out.lines++;
      const loc = { line: lineNo, offset: here, inTail: i + 1 };
      let obj;
      try { obj = JSON.parse(trimmed); }
      catch (err) {
        out.badLines.push(Object.assign({}, loc, {
          raw: snippet(trimmed), reason: '不是合法 JSON（' + ((err && err.message) || err) + '）'
        }));
        continue;
      }
      if (!looksLikeEvent(obj)) {
        out.badLines.push(Object.assign({}, loc, {
          raw: snippet(trimmed), reason: '形状不对（需要 v:数 / at:非空串 / node:非空串 / ch:非空串）'
        }));
        continue;
      }
      const atMs = Date.parse(obj.at);
      if (!Number.isFinite(atMs)) {
        out.badLines.push(Object.assign({}, loc, {
          raw: snippet(trimmed), reason: 'at 不是可解析的时间（时钟/落盘异常）: ' + JSON.stringify(obj.at)
        }));
        continue;
      }
      if (!channelInfo(obj.ch)) {
        out.unknownChannels.push(Object.assign({}, loc, {
          ch: String(obj.ch), raw: snippet(trimmed),
          reason: '认不出的通道 ch=' + JSON.stringify(String(obj.ch))
        }));
        continue;
      }
      const ev = {
        v: obj.v, at: obj.at, atMs: atMs, node: String(obj.node), ch: String(obj.ch),
        by: obj.by === undefined || obj.by === null ? '' : String(obj.by),
        line: lineNo, offset: here, inTail: i + 1
      };
      if (prev && atMs < prev.atMs) {
        // 乱序 ⇒ 窄查询的前提被破坏（窗口不再是文件的一段后缀）⇒ 拒绝给出可能不完整的读数
        out.outOfOrder.push(Object.assign({}, loc, {
          at: obj.at, prevAt: prev.at, prevLine: prev.line, prevOffset: prev.offset, raw: snippet(trimmed),
          reason: '时间乱序：本条 at=' + obj.at + ' 早于上一条 at=' + prev.at
        }));
      }
      out.events.push(ev);
      prev = ev;
    }
    return out;
  }

  /** 加权值定标到 3 位：权重是小数（0.2/0.4/0.6），浮点累加会冒出 0.8999999999999999 这类噪音 */
  function round3(x) { return Math.round(Number(x) * 1000) / 1000; }

  /**
   * ============================================================================
   * **名次 → 热度档位**（全工程唯一一处映射；默认实现）
   * ============================================================================
   * 选「十档 1–10」而不是 0–1 分位，理由三条：
   *   ① **显示层是"热度条"**：十个格子天然可画、可比；而 0.67 会被读成"精确的 67%"——
   *      在我们的样本量下那是**假装精确**（规格 §五明写不许）；
   *   ② **档位把"样本少"的抖动显式化**：窗口内只有 3 个被访问节点时，只会出现 10/7/4 三档 ——
   *      一眼看出"档位是粗的"；分位会照样给出 1.00/0.67/0.33 这三个看起来很细的数；
   *   ③ **机械判据友好**：判据①要问"名次不变 ⇒ 读数不变"，整数档位上的相等是干净的。
   *
   * 口径（**只由名次决定，与次数的绝对值无关**）：设窗口内被访问过的节点数为 `n`，
   * 某节点的**竞争名次**为 `r`（并列取**最好**名次：`r = 1 + 严格多于它的节点数`），则
   *     heat = min(10, max(1, ceil(10 × (n − r + 1) / n)))
   * 即"该名次**压过或并列**的节点占比"的十档取整 —— `heat/10 ≈ 分位`，所以读数可解释：
   * 10 = 窗口内最高（n=1 时唯一节点也是 10：它压过 100% 的样本）。
   *
   * 边界（必须知道）：
   *   · **并列 ⇒ 同档**（并列不吃名次，也不按 id 抢位）；
   *   · **n < 10 时档位稀疏**：n=2 只有 10/5，n=3 只有 10/7/4；最低档 1 只在 n ≥ 10 时才会出现。
   *     这是"子集内排名 + 少量样本"的固有性质，不是缺陷 —— 但输出**必须**同时给样本量；
   *   · 它与"次数 ×10 但名次不变"无关（那种情况读数**必须不变**，判据①）。
   */
  function heatFromRank(rank, n) {
    const total = Number(n);
    const r = Number(rank);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (!Number.isFinite(r) || r <= 0) return 0;
    const frac = (total - r + 1) / total;                 // 压过或并列的样本占比 ∈ (0,1]
    return Math.min(HEAT_BANDS, Math.max(1, Math.ceil(HEAT_BANDS * frac)));
  }

  /**
   * 映射的**唯一入口**（`computeHeat` 只调它）。`__setHeatMapperForTest` 换的是它，
   * 生产代码永远不换 —— 这个口子存在的唯一理由是**判据⑤（注入证明）必须可重复执行**：
   *   "把'名次→热度'的映射改成直接返回绝对计数 ⇒ 判据①必红 ⇒ 还原 ⇒ 复绿"。
   * 不给这个口子，那条证明就只能靠手改源码跑一次（无法进回归）。
   */
  function rankToHeat(info) {
    return heatMapper(info);
  }
  function defaultHeatMapper(info) {
    const i = info || {};
    return heatFromRank(i.rank, i.n);
  }
  let heatMapper = defaultHeatMapper;

  /** **只给测试用**：换掉名次→档位的映射（见 `rankToHeat`）。返回被换掉的那个实现，便于还原。 */
  function __setHeatMapperForTest(fn) {
    if (typeof fn !== 'function') throw new Error('__setHeatMapperForTest 需要一个函数 `({node,count,rank,n,side}) => heat`');
    const old = heatMapper;
    heatMapper = fn;
    return old;
  }
  function __resetHeatMapperForTest() { heatMapper = defaultHeatMapper; }

  /**
   * 把一侧的记录排成榜：**按加权值降序**（人的通道权重恒为 1 ⇒ 等价于按次数降序），
   * 同值按节点 id 升序（**只为确定性**，不影响名次：并列取同一名次）。
   * 人侧同样走"加权值"这条路，哪怕今天它恒等于次数 —— 免得以后加人侧通道时漏改一处。
   *
   * ⚠️ **先定标（`round3`）再排名**，不是"排完再定标"：权重是小数，浮点累加会出现
   * `0.2×3 = 0.6000000000000001 > 0.6 = 1×0.6` 这种**显示相同、排名不同**的假差异 ——
   * 那会让"两条读数"里出现无法解释的名次。定标到 3 位后再比，显示值与排名依据**是同一个数**。
   */
  function rankSide(records, side) {
    const arr = records.map((r) => Object.assign({}, r, { weighted: round3(r.weighted) }));
    arr.sort((a, b) => {
      if (b.weighted !== a.weighted) return b.weighted - a.weighted;
      return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
    });
    const n = arr.length;
    arr.forEach((r, i) => {
      // 竞争名次：与上一条同值 ⇒ 同名次（并列取最好名次）
      r.rank = (i > 0 && arr[i - 1].weighted === r.weighted) ? arr[i - 1].rank : i + 1;
      r.heat = rankToHeat({ node: r.node, count: r.weighted, visits: r.visits, rank: r.rank, n: n, side: side });
    });
    return arr;
  }

  /**
   * **纯计算**：一列事件 → 两条榜（本模块的核心，不读盘、不读时钟 —— `now` 由调用方给）。
   *
   * 窗口口径：`from ≤ at ≤ now + FUTURE_TOLERANCE_MS`（容差只吸收写入/读取两次取时钟的微小差；
   * 超容差的未来事件在 `readHeatFile` 里**报错**，不到这里来）。
   * 零访问节点**不在**这两条榜里（裁决四）：榜 = "窗口内被访问过的节点"这个子集。
   *
   * @param {Array} events `parseEvents` 出来的事件（或同形状对象）
   * @param {{now?:number}} [opts] `now` = 窗口基准（毫秒）。不给就取当前时刻。
   */
  function computeHeat(events, opts) {
    const o = opts || {};
    const now = Number.isFinite(o.now) ? Number(o.now) : Date.now();
    const from = now - WINDOW_MS;
    const list = Array.isArray(events) ? events : [];
    const inWindow = [];
    let dropped = 0;
    list.forEach((e) => {
      const t = Number.isFinite(e && e.atMs) ? e.atMs : Date.parse(e && e.at);
      if (!Number.isFinite(t)) {
        // 不该发生：调用方应先过 parseEvents（那里会点名坏行）。宁可响亮，也不静默少算。
        throw new Error('computeHeat 收到一条时间不可解析的事件（先用 parseEvents 校验）: '
          + JSON.stringify(e && e.at));
      }
      if (t >= from && t <= now + FUTURE_TOLERANCE_MS) inWindow.push({ e: e, t: t });
      else dropped++;
    });

    const humanMap = new Map();
    const aiMap = new Map();
    const chanMap = new Map();
    let humanEvents = 0;
    let aiEvents = 0;
    inWindow.forEach((x) => {
      const e = x.e;
      const c = channelInfo(e.ch);
      if (!c) throw new Error(unknownChannelError(e.ch, '读数'));
      const map = c.who === 'human' ? humanMap : aiMap;
      const rec = map.get(e.node) || { node: e.node, visits: 0, weighted: 0 };
      rec.visits++;
      rec.weighted += c.weight;
      map.set(e.node, rec);
      if (c.who === 'human') humanEvents++; else aiEvents++;
      const cr = chanMap.get(c.ch) || { channel: c.ch, who: c.who, weight: c.weight, events: 0 };
      cr.events++;
      chanMap.set(c.ch, cr);
    });

    const human = rankSide([...humanMap.values()], 'human');
    const ai = rankSide([...aiMap.values()], 'ai');
    const nodes = new Set([...humanMap.keys(), ...aiMap.keys()]);
    const byChannel = [...chanMap.values()].sort((a, b) =>
      (b.events - a.events) || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
    const weights = {};
    CHANNELS.forEach((c) => { weights[c.ch] = { who: c.who, weight: c.weight }; });

    return {
      window: {
        days: WINDOW_DAYS, ms: WINDOW_MS,
        from: new Date(from).toISOString(), to: new Date(now).toISOString()
      },
      /**
       * ⚠️ `dropped` = **本次收到的事件**里被窗口排除的条数。窄查询只读了尾部 ⇒ 它只代表**读区内**那部分，
       * 不是全量（调用方必须把 `log.windowComplete` 一起摆出来，见 `cli/commands/heat.js` 的措辞）。
       * 它**不影响**两条榜（榜只看窗口内的事件）—— 所以"窄读 == 全量读"这条对拍只比榜，不比它。
       */
      sample: {
        events: inWindow.length, dropped: dropped, nodes: nodes.size,
        humanEvents: humanEvents, aiEvents: aiEvents
      },
      human: human,
      ai: ai,
      byChannel: byChannel,
      weights: weights
    };
  }

  /* ============================================================================
   * **单节点的热度读数**（界面两条热度条 / `search` 回显的唯一来源）
   * ============================================================================
   * 为什么要它：界面要画两条十格热度条，就必须拿到"这个节点在人榜 / AI 榜上的
   * `{热度, 名次, 事件数, 加权值}` 与**窗口内样本量**。若让界面自己去 `human`/`ai` 两个数组里
   * 找、自己算分位 —— 那就是第二份口径（改了 `heatFromRank` 界面不跟着变 ⇒ 迟早漂移 ✗）。
   * 所以：**只有这一处**把"两条榜"折成"一个节点的读数"，界面/命令层只做展示。
   *
   * 关键取舍（诚实标注）：**没被访问过 ≠ 热度 0**。零访问节点不在榜上（裁决四），
   * 所以这里如实返回 `listed:false` + `heat:0` + 原因 `never-visited-in-window`，
   * 由显示层说清"是没采到，还是采到了但为 0"—— 不许静默画一根空条当成"热度 0"。
   */
  const NO_VISIT_REASON = 'never-visited-in-window';

  function heatProfile(computed, nodeId) {
    const id = String(nodeId === undefined || nodeId === null ? '' : nodeId).trim();
    const c = computed || {};
    const pick = (list) => {
      const arr = Array.isArray(list) ? list : [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] && String(arr[i].node) === id) return arr[i];
      }
      return null;
    };
    const h = pick(c.human);
    const a = pick(c.ai);
    const one = (row, who) => {
      if (!row) {
        return {
          listed: false, heat: 0, bandMax: HEAT_BANDS, bands: 0, rank: null,
          visits: 0, weighted: 0, who: who, reason: NO_VISIT_REASON
        };
      }
      return {
        listed: true, heat: row.heat, bandMax: HEAT_BANDS,
        // `bands` = 热度条要填几格 —— **派生的**（bandFraction 是同一处口径），界面不自己乘除
        bands: Math.round(bandFraction(row.heat) * HEAT_BANDS),
        rank: row.rank, visits: row.visits, weighted: round3(row.weighted), who: who
      };
    };
    const human = one(h, 'human');
    const ai = one(a, 'ai');
    const s = c.sample || {};
    const listed = human.listed || ai.listed;
    return {
      node: id,
      listed: listed,
      reason: listed ? 'listed' : NO_VISIT_REASON,
      window: c.window || { days: WINDOW_DAYS },
      sample: {
        windowDays: WINDOW_DAYS,
        events: Number(s.events) || 0,            // 窗口内事件总数（两条榜的样本面）
        nodes: Number(s.nodes) || 0,              // 窗口内**被访问过**的节点数 = 排名子集的样本量
        humanEvents: Number(s.humanEvents) || 0,
        aiEvents: Number(s.aiEvents) || 0
      },
      human: human,
      ai: ai
    };
  }

  /**
   * ============================================================================
   * **AI 侧隐藏热度维度**（标签 / 章节 / 节点树）—— 热度条第三件 · B 块
   * ============================================================================
   * ## 一条硬要求：**必须由节点热度派生，绝不许各记一套** ✗
   * 本函数不读盘、不碰日志、**不认识任何事件** —— 它只吃 `computeHeat()` 已经算好的两条榜，
   * 所以"改节点热度 ⇒ 派生值跟着变"是**构造上成立**的，不是靠自觉。判据（注入证明）：
   * 把 `__setHeatMapperForTest` 换成"档位 = 绝对次数"⇒ 节点档位变 ⇒ 本函数的档位/平均档位**必变**。
   *
   * ## 三个维度各自怎么分组（口径只在这里，别处不许再分一次）
   *   · **标签 tags**    —— 节点自己的 `tags[]`（正交维度：一个节点可以挂多个标签）；
   *   · **章节 sections** —— 该节点在树里的**每一级祖先**（root 的子树就是章节，逐级下钻到它自己）。
   *                        这回答"这一章整体热不热"，而不只是"这一节"；
   *   · **节点树 trees**  —— 该节点所属的**顶层主题**（root 的第一个孩子，逐级返回、直到顶层）。
   *                        它是"整棵树"的热度 = 章节的最粗一档，保留它是因为
   *                        「整棵树 vs 某一章」是两个不同的决策（要不要先读这棵树）。
   *   ⚠️ **root 自己不算章节、也不算一棵树**：它是"整个项目"，不是某一章 / 某一棵。
   *      把它算进去会让每一维都挂上一个恒热的超集（`root` 永远 = 全项目最热），读起来像噪音。
   *
   * ## 聚合方式（与节点热度**同一套排名口径**，不另发明一个平均分）
   *   一个维度的热度 = **它名下最热的那个节点**的热度档位；维度之间按这个"最强成员"的**名次**排名，
   *   再走 `heatFromRank` 折成十档（与节点榜同一个映射函数、同一个档位数）。
   *   为什么取**最强成员**而不是成员平均：① 平均档位会造出"看起来有权威的 6.3"这种数
   *   —— 而档位是**序数**，平均它没有意义（本工程反复治"假装精确"）；② 取最强 ⇒
   *   "这个标签下有东西正在被读"这件事不会被一堆冷节点稀释掉；③ 口径与节点榜同源（都只由名次决定）。
   *   成员明细照样给（`hot` / `avgHeat`），让调用方能看见"是不是只有一个节点在扛"。
   *
   * ## 样本量如实暴露（不许假装精确）
   *   每一维都同时给 `nodes`（成员数）/ `visited`（其中窗口内被访问过的）/ `events`（相关事件数）。
   *   少样本的那一类（例如"整个标签下只有 1 个节点被访问过"）档位会很高——`visited` 就是那条证据。
   *
   * ## 只给 AI
   *   本函数只被 `heat --json`（CLI）调用 —— **渲染层一行都不调**（界面只画节点自己的两条热度条）。
   *
   * ⚠️ 桶内**热力**排序与节点榜**同名次同序**：榜的顺序（加权值降序、同值按 id 升序）直接复用，
   *    不重新排序 ⇒ 不会出现"维度里说 A 比 B 热、榜单说反了"这种自相矛盾。
   *
   * @param {object} computed `computeHeat` 的返回值
   * @param {object} root 节点树根（给不出 ⇒ 只有 tags 维度）
   * @param {{top?:number}} [opts] `top` = 每维最多列几个成员（默认取 `DIM_TOP`），**只影响显示**
   */
  const DIM_TOP = 10;

  function derivedHeat(computed, root, opts) {
    const o = opts || {};
    const top = (typeof o.top === 'number' && o.top > 0) ? o.top : DIM_TOP;
    const b = treeBuckets(root);
    const ownChain = b.ownChainOf;

    const side = (list, who) => {
      // 桶 → 成员（按榜序 append ⇒ 桶内顺序天然是"热力序"）
      const mk = () => new Map();
      const mkNode = (id) => ({ tagBuckets: new Map(), secBuckets: new Map(), treeBuckets: new Map(), id: id });
      const index = new Map();   // nodeId → { 三个桶 → Map(维度键 → 成员数组) }
      const bucketOf = (id) => {
        if (!index.has(id)) index.set(id, mkNode(id));
        return index.get(id);
      };
      (Array.isArray(list) ? list : []).forEach((row) => {
        if (!row || !row.node) return;
        const id = String(row.node);
        const st = bucketOf(id);
        const push = (map, key, label) => {
          if (key === null || key === undefined || key === '') return;
          const k = String(key);
          if (!map.has(k)) map.set(k, { key: k, label: label === undefined ? k : label, members: [] });
          map.get(k).members.push(row);
        };
        // ① 标签
        const info = b.info.get(id);
        ((info && info.tags) || []).forEach((t) => push(st.tagBuckets, t, t));
        // ② 章节：每一级祖先（含自己）。**root 除外**（它是"整个项目"，不是某一章）。
        //    不在树里（节点已删 / 树没给）⇒ 用节点自己兜底 —— "访问了一个后来被删的节点"照样能被
        //    看见（不许静默丢，F1 的同一精神）；而"这个节点在树里但就是 root"什么都不记（它不属于任何章节）
        const chain = ownChain(id);
        (b.info.has(id) ? chain : [id]).forEach((aid) => {
          const ai = b.info.get(aid);
          push(st.secBuckets, aid, (ai && ai.topic) || aid);
        });
        // ③ 节点树：所属顶层主题（**root 不属于任何一棵树** ⇒ topOf 返回 null）
        const t = b.topOf(id);
        if (t) push(st.treeBuckets, t, (b.info.get(t) || {}).topic || t);
      });

      // 把"全部桶"收进一张表。**含没有任何榜上节点的桶**（`visited:0`）—— 遍历的是**节点树**，
      // 不是榜单：所以"冷标签 / 冷章节"照样能被看见（同时它们不进排名：bestRank=null ⇒ heat=0）。
      const all = { tags: mk(), sections: mk(), trees: mk() };
      const seeBucket = (dim, key, label) => {
        if (key === null || key === undefined || key === '') return;
        const k = String(key);
        if (!all[dim].has(k)) all[dim].set(k, { key: k, label: label === undefined ? k : label, members: [] });
      };
      b.info.forEach((info, id) => {
        info.tags.forEach((t) => seeBucket('tags', t, t));
        const chain = ownChain(id);
        (b.info.has(id) ? chain : [id]).forEach((aid) => {
          seeBucket('sections', aid, (b.info.get(aid) || {}).topic || aid);
        });
        const t = b.topOf(id);
        if (t) seeBucket('trees', t, (b.info.get(t) || {}).topic || t);
      });
      // 榜上但**不在树里**的（节点已删 / 换了项目）：标签照样认，章节/树认不出 ⇒ 只并入标签维度
      index.forEach((st, id) => {
        st.tagBuckets.forEach((bucket, key) => seeBucket('tags', key, bucket.label));
      });
      // 成员回填：桶里放榜上的行（按榜序 ⇒ 桶内顺序 = 热力序，与节点榜同名次同序 ✓）
      index.forEach((st) => {
        st.tagBuckets.forEach((bucket, key) => { if (all.tags.has(key)) all.tags.get(key).members = bucket.members; });
        st.secBuckets.forEach((bucket, key) => { if (all.sections.has(key)) all.sections.get(key).members = bucket.members; });
        st.treeBuckets.forEach((bucket, key) => { if (all.trees.has(key)) all.trees.get(key).members = bucket.members; });
      });

      const build = (dim) => {
        const rows = [...all[dim].values()].map((bucket) => {
          const members = bucket.members;
          const best = members.length ? members[0] : null;      // 榜序 ⇒ 首项就是最强成员
          const sum = members.reduce((s, m) => s + (Number(m.heat) || 0), 0);
          return {
            key: bucket.key, label: bucket.label,
            heatMax: best ? best.heat : 0, bestNode: best ? best.node : null,
            bestRank: best ? best.rank : null,
            avgHeat: members.length ? round3(sum / members.length) : 0,
            nodes: totalMembers(dim, bucket.key, b),
            visited: members.length,
            events: members.reduce((s, m) => s + (Number(m.visits) || 0), 0),
            hot: members.slice(0, top).map((m) => ({ node: m.node, heat: m.heat, rank: m.rank, visits: m.visits }))
          };
        });
        // 维度之间排名：最强成员的名次（并列取最好名次）；`bestRank` 为空（没人被访问）排最后
        rows.sort((x, y) => {
          const rx = x.bestRank === null ? Infinity : x.bestRank;
          const ry = y.bestRank === null ? Infinity : y.bestRank;
          if (rx !== ry) return rx - ry;
          return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
        });
        const n = rows.length;
        rows.forEach((row, i) => {
          if (row.bestRank === null) {
            // 这一维里一个节点都没被访问过 —— 不给档位（**0 = 不在榜**，与节点榜同一语义）
            row.heat = 0;
            row.rank = null;
            return;
          }
          const rank = (i > 0 && rows[i - 1].bestRank === row.bestRank) ? rows[i - 1].rank : i + 1;
          row.rank = rank;
          row.heat = heatFromRank(rank, n);
        });
        return rows;
      };

      const out = { who: who, tags: build('tags'), sections: build('sections'), trees: build('trees') };
      out.sample = {
        nodes: (Array.isArray(list) ? list : []).length,
        tags: out.tags.length, sections: out.sections.length, trees: out.trees.length
      };
      return out;
    };

    return { human: side(computed && computed.human, 'human'), ai: side(computed && computed.ai, 'ai') };
  }

  /**
   * 一个桶的**成员总数**（= 该维度下共有几个节点；榜上只出现被访问过的那些 ⇒ 两个数都要给）。
   * 口径必须与建桶时**逐字一致**（同一套 `ownChain` / `topOf`）—— 否则 `visited` 可能大于 `nodes`。
   */
  function totalMembers(dim, key, b) {
    let n = 0;
    b.info.forEach((info, id) => {
      if (dim === 'tags') { if (info.tags.indexOf(key) >= 0) n++; return; }
      if (dim === 'sections') { if (b.ownChainOf(id).indexOf(key) >= 0) n++; return; }
      if (b.topOf(id) === key) n++;
    });
    return n;
  }

  /**
   * 从节点树里取"分组判据"（**只算一次**：标签 / 祖先链 / 顶层主题三个查询共用一张索引）。
   * 树没给（`root` 为空）⇒ 三个查询都返回空 ⇒ 只剩标签维度（诚实降级，不假装知道章节）。
   */
  function treeBuckets(root) {
    const info = new Map();     // id → { topic, tags, parent }
    const childrenOf = new Map();
    const rootId = (root && root.id) ? String(root.id) : null;
    if (root && typeof root === 'object') {
      (function walk(n, parent) {
        if (!n || !n.id) return;
        const id = String(n.id);
        info.set(id, { topic: n.topic, tags: Array.isArray(n.tags) ? n.tags.slice() : [], parent: parent });
        childrenOf.set(id, (n.children || []).filter((c) => c && c.id).map((c) => String(c.id)));
        (n.children || []).forEach((c) => walk(c, id));
      })(root, null);
    }
    const cache = new Map();
    /** 节点 → 祖先链（含自己，从 root 起）。取不到（已删/不在树里）⇒ [] */
    function chainOf(id) {
      if (cache.has(id)) return cache.get(id);
      const out = [];
      let cur = id;
      let guard = 0;
      while (cur && info.has(cur) && guard++ < 100000) {
        out.unshift(cur);
        cur = info.get(cur).parent;
      }
      cache.set(id, out);
      return out;
    }
    /** 顶层主题 = 祖先链的**第二个**（第一个是 root）。root 自己不属于任何一棵树 ⇒ null */
    function topOf(id) {
      const chain = chainOf(id);
      if (chain.length >= 2) return chain[1];
      return null;
    }
    /** 章节口径的祖先链：`chainOf` 去掉 root（**章节不是"整个项目"**） */
    function ownChainOf(id) {
      return chainOf(id).filter((x) => x !== rootId);
    }
    return {
      rootId: rootId, info: info, childrenOf: childrenOf,
      parentOf: (id) => (info.get(id) || {}).parent || null,
      chainOf: chainOf, ownChainOf: ownChainOf, topOf: topOf
    };
  }

  /* ---------------- I/O：写入（O(1) 追加） ---------------- */

  function requireFs() {
    if (!fs) {
      throw new Error('heat.js 的 I/O 部分需要 Node 环境（浏览器端请走 CLI / IPC —— 本工程写操作只经 CLI）');
    }
    return fs;
  }

  /**
   * **记一次访问事件 = 追加一行**（本模块唯一的写入动作）。
   *
   * 为什么只有一次 `appendFileSync`：规格 §二 的硬要求是"只追加一行、不读全量、不重写文件"。
   * 这里刻意**不做**任何"先读后判"（不校验上一条的时间戳、不裁剪窗口、不加锁）：做了就回到
   * O(文件大小)，而访问是最热的动作。代价写明：**日志时序只能由写入方行为保证**
   * （`visit` 命令只写"写入时刻"），读方靠 `parseEvents` 自检乱序并报错。
   *
   * 文件不存在 ⇒ `appendFileSync` 直接建；目录不存在 ⇒ 抛错（项目目录本来就该在，
   * 静默创建目录会把"项目名写错"变成一次看不到的写入）。
   *
   * @param {string} file 日志文件的**绝对路径**（由 `store.visitLogFile` 推导，别处不许自己拼）
   * @param {object} fields 见 `buildEvent`
   * @returns {{entry:object, line:string, bytes:number}}
   */
  function appendEvent(file, fields) {
    const io = requireFs();
    if (!file) throw new Error('appendEvent 需要一个日志文件路径');
    const entry = buildEvent(fields);
    const line = serializeEvent(entry);
    io.appendFileSync(file, line, 'utf8');
    return { entry: entry, line: line, bytes: byteLength(line) };
  }

  /* ---------------- I/O：读取（窄查询） ---------------- */

  /**
   * 读文件的**尾部**（窄查询），返回 `{text, bytesRead, fileSize, fromOffset, complete}`。
   *
   * `complete:true` = 这次读**覆盖到了文件头**（拿到的是全量）；否则 `fromOffset` 之前的内容
   * 没读（故意）。停下来的判据：读区里已经出现"窗口外"的行 —— 在「`at` 非递减」的前提下，
   * 它之前的所有行都在更早的时间 ⇒ 窗口信息已经完整。
   *
   * 为什么要"翻倍重试"：单行可能比一个 chunk 还长（一条 JSON 行不该有那么长，但**别假设**），
   * 那样切片会落在行中间。所以 `start > 0` 时丢掉**第一段不完整的行**；若整块都没有换行，
   * 就翻倍再读。撞 `maxBytes` ⇒ **响亮报错**（不静默给半份读数）。
   */
  function readTail(file, opts) {
    const io = requireFs();
    const o = opts || {};
    const windowStart = Number.isFinite(o.windowStart) ? o.windowStart : -Infinity;
    const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_READ_BYTES;
    let chunk = Number(o.chunk) > 0 ? Number(o.chunk) : READ_CHUNK_BYTES;
    const fd = io.openSync(file, 'r');
    try {
      const fileSize = io.fstatSync(fd).size;
      let bytesRead = 0;
      for (;;) {
        const start = Math.max(0, fileSize - chunk);
        const want = fileSize - start;
        const buf = Buffer.allocUnsafe(Math.max(1, want));
        const n = io.readSync(fd, buf, 0, want, start);
        bytesRead += n;
        const slice = buf.subarray(0, n);
        let text;
        let fromOffset = start;
        if (start > 0) {
          const nl = slice.indexOf(0x0a);                 // '\n'
          if (nl < 0) {
            if (chunk >= maxBytes) {
              throw new Error('访问日志尾部读取失败：' + file + ' 里有一个超过 ' + maxBytes
                + ' 字节的"行"（没有任何换行符）—— 拒绝在不知道边界的情况下给出读数。'
                + '出路：修掉那一行（日志是每行一条 JSON），或删掉该日志（旁路产物、可随时删）。');
            }
            chunk = chunk * 2;
            continue;
          }
          text = slice.subarray(nl + 1).toString('utf8');
          fromOffset = start + nl + 1;
        } else {
          text = slice.toString('utf8');
        }
        const result = { text: text, bytesRead: bytesRead, fileSize: fileSize, fromOffset: fromOffset, complete: start === 0 };
        if (start === 0) return result;
        const parsed = parseEvents(text, { offset: fromOffset });
        let earliest = null;
        parsed.events.forEach((e) => { if (earliest === null || e.atMs < earliest) earliest = e.atMs; });
        // 读区里已经有窗口外的行 ⇒ 窗口信息完整（前提：at 非递减）；乱序会在 assertClean 里报错
        if (earliest !== null && earliest < windowStart) return result;
        if (chunk >= maxBytes) {
          throw new Error('访问日志的窗口读不完：为了拿到完整窗口需要读超过 ' + maxBytes + ' 字节（文件 '
            + fileSize + ' 字节）—— **拒绝给出可能不完整的读数**。'
            + '出路：归档 / 删掉 `' + FILE_NAME + '`（旁路产物、可随时删），或调大 src/heat.js 的 MAX_READ_BYTES。');
        }
        chunk = chunk * 2;
      }
    } finally {
      try { io.closeSync(fd); } catch (e) { /* 关不上不是本次读数的问题 */ }
    }
  }

  /** 一行诊断的**唯一一处**格式化（坏行 / 未知通道 / 乱序共用；点名位置 + 原文） */
  function fmtIssue(it) {
    const where = it.line === null || it.line === undefined
      ? '文件偏移 ' + it.offset + ' 字节（读区第 ' + it.inTail + ' 行）'
      : '第 ' + it.line + ' 行（文件偏移 ' + it.offset + ' 字节）';
    return where + '：' + it.reason;
  }

  /**
   * **失败响亮**（F1）的唯一判定处：坏行、未知通道、乱序、未来时间戳 ⇒ 抛错，并点名。
   * 「少了一条」与「本来就没有」必须能分辨 —— 所以**绝不静默当 0**。
   */
  function assertClean(parsed, ctxInfo) {
    const where = ctxInfo && ctxInfo.file ? ctxInfo.file : '';
    const problems = [];
    if (parsed.badLines.length) {
      problems.push({ kind: '坏行', items: parsed.badLines, advice: '按行修掉（每行一条 JSON；字段 v/at/node/ch）' });
    }
    if (parsed.unknownChannels.length) {
      problems.push({
        kind: '认不出的通道', items: parsed.unknownChannels,
        advice: '这些行里的 `ch` 不在 src/heat.js 的 CHANNELS 里（通道表只有那一处）—— '
          + '不许自行加权，要么把通道补进表（那要同批改文档与测试），要么删掉那几行'
      });
    }
    if (parsed.outOfOrder.length) {
      problems.push({
        kind: '时间乱序', items: parsed.outOfOrder,
        advice: '日志按**追加顺序**即时间顺序（读方的窄查询就靠这条不变量：窗口 = 文件的一段后缀）。'
          + '乱序会把窗口内的事件埋进文件前半段 ⇒ 读数**少算**。请按时间重排，或删掉该日志（旁路产物）'
      });
    }
    if (problems.length) {
      const head = '访问日志读不出来：' + where;
      const body = problems.map((p) => '  · ' + p.kind + '（' + p.items.length + ' 处）'
        + p.items.slice(0, 5).map((it) => '\n      - ' + fmtIssue(it) + (it.raw ? '\n        原文：`' + it.raw + '`' : '')).join('')
        + (p.items.length > 5 ? '\n      - …另有 ' + (p.items.length - 5) + ' 处' : '')
        + '\n      → ' + p.advice).join('\n');
      throw new Error(head + '\n' + body + '\n'
        + '⚠ 这**不等于**"这些节点没被访问过" —— 读数不可信，所以这里报错而不是给一个看起来正常的榜。');
    }
  }

  /**
   * **纯核心**：日志文本 → 两条榜（G-15 下沉，2026-10-20）。
   *
   * 拆分前这一整套判据（解析 → 响亮校验 → 未来时间戳 → 算榜）住在 `readHeatFile` 里，
   * 而那函数还要 `fs.existsSync` / `readTail` ⇒ 探针判它"需盘"，于是
   * **"坏行必须报错"这类纯文本判据也得先造一个日志文件**（`tests/heat.test.js` 为此
   * 建了一个 `SANDBOX`）。现在把它整段搬出来：喂一段**字符串**就能测。
   *
   * 判据与报文**一个字都没改**（`assertClean` 仍是唯一的失败判定处）；
   * `now` 与同文件其它函数一样可注入（不传才取现在）—— 同一个 idiom，不另发明。
   *
   * @param {string} text 日志文本（可以只是尾部一段切片）
   * @param {{now?:number, file?:string, offset?:number, line?:number|null}} [opts]
   *   `offset` / `line` 用于定位诊断（见 `parseEvents`）；`file` 只进报文。
   * @returns {{heat:object, lines:number, events:number}}
   * @throws {Error} 坏行 / 未知通道 / 时间乱序 / 未来时间戳（**绝不静默当 0**）
   */
  function heatFromLogText(text, opts) {
    const o = opts || {};
    const now = Number.isFinite(o.now) ? Number(o.now) : Date.now();
    const parsed = parseEvents(text, { offset: o.offset, line: o.line });
    assertClean(parsed, { file: o.file });
    const future = parsed.events.filter((e) => e.atMs - now > FUTURE_TOLERANCE_MS);
    if (future.length) {
      throw new Error('访问日志里有 ' + future.length + ' 条**未来时间戳**（比现在晚超过 '
        + Math.round(FUTURE_TOLERANCE_MS / 1000) + ' 秒）—— 时钟回拨或日志被手改过：\n'
        + future.slice(0, 5).map((e) => '  · ' + fmtIssue({ line: e.line, offset: e.offset, inTail: e.inTail, reason: 'at=' + e.at })).join('\n')
        + '\n窗口口径按"现在"倒推一个月，未来事件会让窗口失真 ⇒ **报错，不静默计入/丢弃**。'
        + '出路：修掉这几行的时间，或删掉该日志（旁路产物、可随时删）。');
    }
    return { heat: computeHeat(parsed.events, { now: now }), lines: parsed.lines, events: parsed.events.length };
  }

  /**
   * **命令层用的唯一入口**：读日志（窄查询默认 / `full:true` 全量）→ 响亮校验 → 算出两条榜。
   *
   * G-15 下沉后它只剩 I/O：找到文件、取文本、把文本交给 `heatFromLogText`（纯核心）。
   *
   * @param {string} file 日志文件的**绝对路径**
   * @param {{now?:number, full?:boolean, chunk?:number, maxBytes?:number}} [opts]
   * @returns {{file:string, exists:boolean, now:number, heat?:object, log?:object, dropped?}}
   *          `exists:false` = 本机没有这份日志（**不是**"热度为 0"：调用方必须把这句话说出来）
   */
  function readHeatFile(file, opts) {
    const io = requireFs();
    const o = opts || {};
    const now = Number.isFinite(o.now) ? Number(o.now) : Date.now();
    if (!file) throw new Error('readHeatFile 需要一个日志文件路径');
    if (!io.existsSync(file)) return { file: file, exists: false, now: now };
    const windowStart = now - WINDOW_MS;
    let tail;
    if (o.full) {
      const text = io.readFileSync(file, 'utf8');
      tail = { text: text, bytesRead: byteLength(text), fileSize: byteLength(text), fromOffset: 0, complete: true, full: true };
    } else {
      tail = readTail(file, { windowStart: windowStart, chunk: o.chunk, maxBytes: o.maxBytes });
    }
    const core = heatFromLogText(tail.text, {
      now: now, file: file, offset: tail.fromOffset, line: tail.complete ? 1 : null
    });
    return {
      file: file, exists: true, now: now, heat: core.heat,
      log: {
        bytesRead: tail.bytesRead, fileBytes: tail.fileSize, fromOffset: tail.fromOffset,
        complete: tail.complete, full: !!o.full, lines: core.lines, events: core.events
      }
    };
  }

  return {
    FILE_NAME, ENTRY_VERSION, WINDOW_DAYS, WINDOW_MS, DAY_MS, HEAT_BANDS, FUTURE_TOLERANCE_MS,
    READ_CHUNK_BYTES, MAX_READ_BYTES,
    CHANNELS, CHANNEL_NAMES, channelInfo, channelRow, unknownChannelError,
    // 检索向量（第二件）：三条上限 + "两条榜 → 排序加数" + 位移上界（取值与推导都在上面那一处）
    SEARCH_RANK, searchRankOf, searchBoost, maxJump, bandFraction,
    buildEvent, serializeEvent, looksLikeEvent, parseEvents,
    heatFromRank, rankToHeat,
    heatProfile, NO_VISIT_REASON, DIM_TOP, derivedHeat,
    computeHeat, appendEvent, readTail, readHeatFile,
    // G-15 下沉：`readHeatFile` 的**纯核心** —— 喂一段日志文本就够（不读盘），
    // 判据与报文与拆分前逐字节相同（`assertClean` 仍是唯一的失败判定处）。
    heatFromLogText,
    __setHeatMapperForTest, __resetHeatMapperForTest,
    __setSearchRankForTest, __resetSearchRankForTest
  };
});
