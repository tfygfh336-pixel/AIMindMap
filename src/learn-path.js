/* ============================================================
 * src/learn-path.js — 「学习链路（Learning Path，产品代号 LP）」的**判据与排序唯一实现处**
 * ------------------------------------------------------------
 * UMD 纯逻辑：**零 I/O、零时钟、零随机、零 Electron**（Node 侧命令与 node 单测共用一份）。
 * 读盘 / 校验 / 落盘全在 `cli/commands/learn-path.js`；本文件只吃"已经在内存里的项目数据"。
 *
 * ## 一句话
 * 把若干本已入库的书（或若干份资料/经验）排成**一条有序的学习链路**，并且对每一步都能回答
 * "**它为什么排在这**" —— 而且这个"为什么"必须能被**复算打红**，不能是话术。
 *
 * ## 设计定稿在 `.review/20261020-LP-学习链路/设计.md`（本文件的每条判据都在那份稿里）
 * 本文件把那份设计落成代码，**不重新设计**。三个最容易走偏的地方，先把结论抄在这里：
 *
 *   ① **"有序"从哪来**（设计 §3.7）—— 四层依据，**方向只来自前两层**：
 *      · **T1 骨架（authoritative）**：书内 DFS 前序（章 → 节）。书的 `children` 数组顺序是
 *        数据里**唯一有序的表达**（`docs/DATA-FORMAT.md` §2.1），所以骨架**永远是树序**，
 *        章号只用于显示与读数（章号与树序冲突时**只报不改**，见 `spineErrors`）。
 *      · **T2 显式（authoritative）**：`links[].caption` 以 `前置：`/`前置:`/`prereq:` 开头
 *        ⇒ 有向前置（"目标应当在当前节点之前学"）。**当前真数据 0 条**（如实上报）。
 *      · **T3 导航（weak）**：术语共现。共现是**对称的 ⇒ 只能选"下一步"，绝不能宣布前置**。
 *        把它当方向 = 把无向当有向 = 编造顺序（本工程最重的损害类别）。
 *      · **T4 兜底（mechanical）**：`--order` → 书序 → 书内序（这两档已是**全序**）。**在产物里标明**
 *        `confidence:'mechanical'` —— 不把机械序伪装成推断。
 *
 *   ② **成环**（设计 §3.8）—— 图只有 T1/T2 两种边 ⇒ T3/T4 **不可能**造环。
 *      有环时 **不用"随便断一条边"**：返回 `{ok:false, code:'cycle'}` + 每一条环上边（含 `at`/`kind`），
 *      由命令层**响亮拒绝**。**一条边都不静默丢**。
 *
 *   ③ **跳级**（设计 §3.9）—— 落成能算的判据："这一步引用了**路径外**的知识点"：
 *      `linked-outside-path`（目标项目不在本次输入）/ `linked-later`（在输入里但排在后面）/
 *      `linked-not-a-unit`（目标节点没有 detail ⇒ 不是学习单元）。**如实报，不阻断生成。**
 *
 * ## AI 预算（设计 §1.2）—— **单位 = 调用次数**，机验 = 调用日志的条数
 *   计数**不是**另一个变量，而是 `ai.log.length`：适配器每调一次必须往日志追加一行 ⇒
 *   "少报调用次数"这条路被结构性堵死。本版 `maxCalls = 0`（一次也不调），硬闸门已开：
 *   超了 ⇒ `{ok:false, code:'ai-budget'}` ⇒ 命令层 exit 1（不是警告）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMLearnPath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==========================================================================
   * 0. 取值表（**唯一一处**；命令层与文档一律从这里现取，不许各抄一份）
   * ======================================================================== */

  /**
   * 每一步"为什么排在这"的**封闭取值表**（顺序 = 强度降序）。
   * `confidence`：
   *   `authoritative` —— 数据里本来就有的方向（书序 / 人显式标注）；
   *   `weak`          —— 无向相关度（只导航，不宣布前置）；
   *   `mechanical`    —— 没有任何依据时的确定性兜底。**必须标出来**，不许冒充推断。
   */
  const WHY_KINDS = Object.freeze([
    Object.freeze({ kind: 'chapter-order', confidence: 'authoritative', desc: '本书内：上一步就是它在书里的前一个单元（章序骨架 T1）' }),
    Object.freeze({ kind: 'explicit-prereq', confidence: 'authoritative', desc: '它有 caption 以「前置：」开头的显式前置边，且这些前置此刻全部已学（T2）' }),
    Object.freeze({ kind: 'term-affinity', confidence: 'weak', desc: '与上一步共享术语，且在全部就绪候选里共享最多（T3，无向 ⇒ 只导航）' }),
    Object.freeze({ kind: 'mechanical', confidence: 'mechanical', desc: '上面三条都不适用 ⇒ 确定性兜底序（T4）；这不是学出来的顺序' })
  ]);
  const WHY_KIND_NAMES = Object.freeze(WHY_KINDS.map(function (w) { return w.kind; }));
  function confidenceOf(kind) {
    const hit = WHY_KINDS.filter(function (w) { return w.kind === kind; })[0];
    return hit ? hit.confidence : 'mechanical';
  }

  /**
   * 显式前置的 **caption 前缀约定**（唯一一处；`docs/DATA-FORMAT.md` §2.5 同步）。
   * 只认**前缀**：一句"这里的前置知识见…"绝不能算边（否则每本书都会长出伪前置）。
   */
  const PREREQ_PREFIXES = Object.freeze(['前置：', '前置:', 'prereq:']);

  /** 「依据类型」在产物里的**机器可读行**的版本号（解析器与生成器共用） */
  const WHY_TOKEN_VERSION = 'v1';
  const WHY_TOKEN_PREFIX = 'lp-why:';

  /** 术语抽取的封顶与门槛（数字都是判据的一部分，改它们必须重跑单测的黄金读数） */
  const TERM = Object.freeze({
    MIN_CJK: 2,          // 中文术语最短 2 字（1 字全是噪声）
    MAX_CJK: 12,         // 最长 12 字（再长是句子，不是术语）
    MIN_LATIN: 3,        // 英文/标识符最短 3 字符（`ip`/`ss` 这类命令名太泛）
    MAX_LATIN: 40,
    /**
     * 每个单元**最多留多少个术语**。⚠️ 截断发生在 **df 算完之后**、按
     * 「df 升序 → 名字升序」（= 最**有区分度**的先留），不是抽取时就按字典序砍。
     * 为什么（实测踩过）：抽取时按字典序截断到 120 会把 `s`–`z` 开头的术语系统性丢掉
     * —— 一个**字母表偏向**，而且它看起来完全像"这本书就是不谈 sk_buff"。
     */
    MAX_PER_UNIT: 200,
    /** 抽取阶段的硬上限（防病态节点把内存撑爆；正常单元远低于它） */
    HARD_CAP: 2000,
    /**
     * IDF 权重的定点标度：`weight(term) = round(SCALE * ln(N / df))`。
     * 取整 ⇒ **整数比较**（判据 1 的确定性不依赖浮点求和顺序）；`df === N` 的术语权重恒为 0
     * ⇒ 模板噪声自动失效，**不靠我手写停用词去追**（手写清单永远追不完，而且它是猜的）。
     */
    IDF_SCALE: 10000
  });

  /**
   * **停用词**（判据的一部分：它们不承载概念，留着只会让"共享术语"变成噪声）。
   * 三组各有来由，不是随手加的（每组的取证是 `.review/20261020-LP-学习链路/实测/`）：
   *   · `TEMPLATE`：7 本书 detail 里的**模板标签**（`<strong>书名</strong>` / `本章导读` 这类），
   *     实测 143 个 `<strong>` 词里有近百个属于这一组 —— 它们在**每一本书里都出现**，
   *     留着会让"每两本书都高相关"，把导航信号淹掉；
   *   · `SHELL`：命令行碎片（`cat`/`ip`/`ss`/`tc`/`grep`/`show`/`dev`…）。它们是**观测手段**，
   *     不是被学的概念；两本书都用 `cat /proc/…` 不代表两章该挨着；
   *   · `PROJECTS`：项目名自指（`comnet` / `book-*`）—— 正文里到处在点名项目，
   *     留着就会让"这本书引用别处"变成术语命中。
   */
  const STOP_TERMS = Object.freeze({
    TEMPLATE: Object.freeze([
      '书名', '作者', '本书的形态', '本项目的形态', '不是原文复刻', '节点四要素图例', '来源标注图例',
      '是什么', '怎么运作', '关键点与位置', '本章导读', '本章要点', '相关命令', '源码怎么解', '源码对应',
      '一句话总结', '一句话人话总结', '关键函数', '关键操作', '高频坑', '关键点', '关键帧', '适用读者',
      '待核对', '未核实', '未入库', '未取到', '待与实体书核对', '本地文件', '本地', '目录页', '正文解析待做',
      '与comnet的关联', '与其他项目的关联', '关联项目', '章节结构的诚实说明', '置信度约定', '主线', '学习法',
      '协议怎么解', '内核怎么解', '问题', '为什么', '是什么问题', '未按书的真实章节编号组织', '按主题组织',
      '按主题建树', '仍缺正文', '本版不含', '本部分最大缺口', '一个对应节点都没有', '待读', '待核',
      '虚拟载波监听', '组内', '合并', '对半分裂', '共享的', '和内核栈', '物理连续', '虚拟地址连续', '主内存',
      '内核区', '缓冲区', '只读', '中断', '页表', '物理页', '线性地址', '物理地址', '函数指针数组',
      '尾部反向扫描', '再挂进自己的页表', '旧页计数减一', '库层 malloc', '内存里的', '门描述符',
      '未被屏蔽的信号位图', '伪造一次中断返回现场', '挂载根文件系统', '编译期手工填好', '手工静态写死的',
      '置位的', '被手动清零', '地址线', '中断控制器重映射',
      // ── **本书项目自己的模板标签**（7 本书共用同一套写法，所以它们在每一本书里都出现 ⇒
      //    IDF 抓不住它们：df 只有 7，相对于 545 个单元显得"稀有"，权重反而很高）。
      //    这一档只能靠名单（它们是**人为约定**的写法，不是自然语言）。逐条都来自实测：
      //    `实测/lp-proto-*.json` 的 `sharedTerms` 里排在最前面的就是它们。
      '全书概览与使用说明', '与 comnet 的关联', '与其他项目的关联', '关联项目',
      '关键帧', '字段', '参数', '未链接', '时间线', '待读与待核', '未做与待核', '项目关联'
    ]),
    SHELL: Object.freeze([
      'cat', 'etc', 'proc', 'sys', 'dev', 'show', 'set', 'get', 'list', 'all', 'more', 'less', 'type',
      'the', 'and', 'for', 'with', 'not', 'you', 'can', 'are', 'was', 'has', 'have', 'this', 'that',
      'grep', 'awk', 'sed', 'echo', 'tail', 'head', 'wc', 'ls', 'cd', 'sudo', 'null', 'true', 'false',
      'struct', 'const', 'void', 'static', 'return', 'int', 'char', 'unsigned', 'sizeof', 'define',
      'include', 'stdio', 'stdlib', 'main', 'argc', 'argv', 'errno', 'printf',
      // ── 数据格式的**字段名**（它们在 detail 里被大量写成 `<code>links</code>` 这类形态）——
      //    "两个节点都提到 links 字段"不是概念相关，是模板相关。实测：它们是 7 本书里
      //    overview 节点之间的最高频共享词，不剔掉会让"每本书的概览都互相高度相关"。
      'detail', 'markdown', 'links', 'link', 'chapter', 'section', 'topic', 'tags', 'items', 'item',
      'node', 'nodes', 'json', 'html', 'css', 'file', 'files', 'image', 'images', 'caption', 'source',
      'root', 'meta', 'revision', 'commit', 'merge', 'tree', 'diff', 'log',
      // ── 书籍**元信息**（书名/版次/ISBN/格式/页码）—— 这些是"这本书是什么"，
      //    不是"这本书在讲什么"。页码 `p11`/`p15` 另有形状判据（见 `isNoiseTerm`）。
      'pdf', 'isbn', 'edition', 'epub', 'docx', 'txt', 'url', 'uri', 'html5', 'a4', 'ko', 'book',
      // ── 其它实测的**泛词**：出现在几乎每本书里，但"两本书都提到它"没有信息量。
      //    `命令`（观测手段）、`alias`（shell 内建）、`outline`（导入工具的概念）、
      //    `review`（正文里引用的 `.review/` 路径碎片）。
      '命令', 'alias', 'outline', 'review', 'toc'
    ]),
    PROJECTS: Object.freeze([
      'comnet', 'book', 'wifi', 'wlan', 'linux', 'html', 'http', 'https', 'www', 'amp', 'nbsp', 'quot'
    ])
  });

  /** 单元数上限：**越限响亮拒绝**，不截断（截断 = 静默少给半条链路）。理由与实测见设计 §6.6 */
  const MAX_UNITS = 2000;

  /**
   * AI 预算（**唯一一处**）。单位 = **调用次数**（不是字符数，理由见设计 §1.2）。
   *
   * `maxCalls(units, books)`：
   *   · 本版（`PROGRAM_ONLY = true`）恒为 **0** —— v1 是纯程序侧切片，一次也不调模型；
   *   · 接上 AI 之后：`ceil(units / CHUNK_UNITS)` 次（一次批处理 CHUNK_UNITS 个单元）。
   * 之所以现在就把公式写进来：判据要在**没有 AI 的时候**也是可判的（`calls === 0` 能打红），
   * 而且接 AI 那天**判据一行都不用改**。
   */
  const AI_BUDGET = Object.freeze({
    unit: 'calls',
    PROGRAM_ONLY: true,
    CHUNK_UNITS: 40,
    maxCalls: function (units, books) {
      if (AI_BUDGET.PROGRAM_ONLY) return 0;
      const u = Math.max(0, Number(units) || 0);
      return Math.ceil(u / AI_BUDGET.CHUNK_UNITS) + (Math.max(0, Number(books) || 0) > 0 ? 1 : 0);
    }
  });

  /* ==========================================================================
   * 1. 文本 → 术语（**确定性**：同一段文本恒等得到同一份术语表）
   * ======================================================================== */

  const ENTITIES = Object.freeze({
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&middot;': '·'
  });

  /** HTML → 纯文本（**只用于抽术语**，产出不参与任何数据写回）。不依赖 DOM、不用正则平衡标签。 */
  function plainTextOf(html) {
    let s = String(html === undefined || html === null ? '' : html);
    s = s.replace(/<[^>]*>/g, ' ');
    Object.keys(ENTITIES).forEach(function (k) { s = s.split(k).join(ENTITIES[k]); });
    s = s.replace(/&#\d+;/g, ' ');
    return s;
  }

  /** 术语归一（**唯一一处**）：去首尾空白、抹掉尾部空括号、压空白。英文一律小写（大小写不是概念差别） */
  function normTerm(raw) {
    let s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[（(]\s*[)）]\s*$/, '');
    s = s.replace(/[，,。；;：:、]+$/, '');
    s = s.trim();
    if (!s) return '';
    // 纯英文/标识符：统一小写（`sk_buff` / `SK_BUFF` 是同一个术语）
    if (/^[\x20-\x7e]+$/.test(s)) s = s.toLowerCase();
    return s;
  }

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const STOP_ALL = Object.freeze(
    STOP_TERMS.TEMPLATE.concat(STOP_TERMS.SHELL, STOP_TERMS.PROJECTS).map(function (t) { return String(t).toLowerCase(); })
  );
  const STOP_SET = (function () { const m = Object.create(null); STOP_ALL.forEach(function (t) { m[t] = 1; }); return m; })();

  function isStopTerm(t) { return !!STOP_SET[String(t).toLowerCase()]; }

  /**
   * **按形状判噪声**（与停用词表互补：表管"认识的"，这里管"形状就不像概念"的）。
   * 每条都有实测来由（`.review/20261020-LP-学习链路/实测/`）：7 本书的 `<code>` 与正文里
   * 出现最多却不承载概念的东西是**页码引用**（`p11`/`p15`）、**协议/地址**（`https`/`www`）、
   * **纯数字与版本号**（`2.2`/`802.11` 里读出来的残片）。
   */
  function isNoiseTerm(t) {
    const s = String(t);
    if (/^p\d{1,4}([–\-~]\d{1,4})?$/.test(s)) return true;     // 页码
    if (/^(https?|ftp|www|href|src|nbsp|amp|quot|middot)$/.test(s)) return true;
    if (/^[0-9]+(\.[0-9]+)*$/.test(s)) return true;             // 纯数字 / 版本号
    if (/^[_.:;,\-+*#<>=&/\\()]+$/.test(s)) return true;         // 纯符号
    if (/^[a-z]$/.test(s)) return true;
    /* 章节**标签**（`第1章` / `第一章`）—— 它是话题位置，不是话题本身。实测它一度是
     * cross-book 的最高频共享词之一（每本书都有"第1章"）。 */
    if (/^第[0-9〇一二三四五六七八九十百千]{1,6}[章节部篇]$/.test(s)) return true;
    /* 图书分类号（实测 `TP434100`，来自 CIP 书目页）—— 纯形状，不是概念 */
    if (/^[a-z]{2}\d{4,}$/.test(s)) return true;
    /* **文件名**（实测 `toc-linux-kernel-net-transcribed.txt`）—— 那是工程的产物名 */
    if (/\.(txt|md|json|js|mjs|c|h|cpp|py|sh|html|htm)$/.test(s)) return true;
    /* 生成的**节点 id** 漏进正文（实测：`extk4kvu7jhd9f` 出现在 wifi7 的 detail 里，
     * 于是"两个节点的 id 共享前缀"变成了术语命中）。形状判据：够长 + 纯字母数字 + 含数字 +
     * 不含 `_`/`-`（真标识符几乎都带下划线，如 `sk_buff`/`napi_gro_receive`）。 */
    if (s.length >= 12 && /^[a-z0-9]+$/.test(s) && /[0-9]/.test(s)) return true;
    return false;
  }

  /**
   * 一个节点的**术语表**（去重 + 字典序 ⇒ 同输入恒等输出）。
   *
   * 三个来源（每个都有实测依据，见设计 §3.3）：
   *   ① `<code>…</code>` —— **作者自己标出来的术语**（实测 7 本书 1439 处）。最强的锚点。
   *   ② 正文里的英文/标识符 token（`sk_buff`/`dst_entry`/`napi_struct`…）。
   *   ③ `<strong>` 里**含中文**的短语（作者强调的概念）+ `topic` 的中文片段。
   *
   * ⚠️ `<strong>` 里**不含中文**的整段不进（实测那一档大半是 `TCP` 这类已在 ② 命中的重复）。
   * ⚠️ **本函数不做长度截断**：截断要等 df 算完之后按区分度做（见 `trimTermsByDf`），
   *    在抽取阶段按字典序砍会引入字母表偏向（TERM.MAX_PER_UNIT 的注释里有实测说明）。
   *
   * @param {object} node 节点
   * @param {string[]} [extras] **本次输入的项目名**等"语料级噪声词"（小写后比对；
   *        正文里到处在点名项目，留着就会让"这本书引用别处"变成术语命中）
   * @returns {string[]} 字典序去重后的术语
   */
  function extractTerms(node, extras) {
    const n = node || {};
    const detail = String(n.detail === undefined || n.detail === null ? '' : n.detail);
    const topic = String(n.topic === undefined || n.topic === null ? '' : n.topic);
    const bag = Object.create(null);
    const extraSet = Object.create(null);
    (Array.isArray(extras) ? extras : []).forEach(function (x) { extraSet[String(x).toLowerCase()] = 1; });

    function add(raw) {
      const t = normTerm(raw);
      if (!t) return;
      if (t.length > 60) return;
      if (isStopTerm(t)) return;
      if (isNoiseTerm(t)) return;
      if (extraSet[t.toLowerCase()]) return;
      // 项目名的前缀段（`book-linux-proc-mem` 的 `book` 之类）已由停用词表覆盖，这里再兜一层：
      if (/^book[-_]/.test(t)) return;
      if (CJK_RE.test(t)) {
        const chars = t.replace(/\s+/g, '');
        if (chars.length < TERM.MIN_CJK || chars.length > TERM.MAX_CJK) return;
      } else {
        if (t.length < TERM.MIN_LATIN || t.length > TERM.MAX_LATIN) return;
        if (!/^[a-z0-9_.:/(),\-+*#<>=&]+$/.test(t)) return;
      }
      bag[t] = 1;
    }

    // ① <code>…</code>
    let m;
    const reCode = /<code>([\s\S]{1,80}?)<\/code>/g;
    while ((m = reCode.exec(detail))) {
      plainTextOf(m[1]).split(/[\s，,、;；|/]+/).forEach(add);
    }
    // ② 正文里的英文/标识符 token
    const plain = plainTextOf(detail);
    const reLatin = /[A-Za-z][A-Za-z0-9_.\-]{2,39}/g;
    while ((m = reLatin.exec(plain))) add(m[0]);
    // ③ <strong> 里的中文短语（`关键帧/字段/参数` 这种**斜杠并列**先拆开再逐段判 ——
    //    整串既不是术语，也不等于它任何一段，留着只会绕过停用词表）
    const reStrong = /<strong>([\s\S]{1,60}?)<\/strong>/g;
    while ((m = reStrong.exec(detail))) {
      const t = plainTextOf(m[1]).trim();
      if (CJK_RE.test(t)) t.split(/\/+/).forEach(add);
    }
    // ④ topic 的中文片段（标题本身就是对这个知识点的命名）
    if (CJK_RE.test(topic)) {
      plainTextOf(topic).split(/[\s，,、;；:：|·「」【】（）()【】\[\]/]+/).forEach(function (seg) {
        if (CJK_RE.test(seg) && seg.length >= TERM.MIN_CJK && seg.length <= TERM.MAX_CJK) add(seg);
      });
    }

    const keys = Object.keys(bag).sort();                          // 字典序 ⇒ 确定性
    return keys.length > TERM.HARD_CAP ? keys.slice(0, TERM.HARD_CAP) : keys;
  }

  /**
   * **IDF 权重**（唯一一处公式）：`weight = round(SCALE * ln(N / df))`，`df === N` ⇒ 0。
   * 取整 ⇒ 相关度是**整数比较**（判据 1 的确定性不依赖浮点求和顺序）。
   * 一句人话：**越常见的术语越不值钱**，所以模板噪声自动失效，不必靠手写停用词去追。
   */
  function idfWeight(df, unitCount) {
    const n = Math.max(1, Number(unitCount) || 1);
    const d = Math.max(1, Number(df) || 1);
    if (d >= n) return 0;
    return Math.round(TERM.IDF_SCALE * Math.log(n / d));
  }

  /**
   * 算全语料的 `df`（出现过该术语的**单元**数），并**按区分度截断**每个单元的术语表。
   * 排序键：`df` 升序（越稀有越先留）→ 名字升序（确定性）。返回 `{df, unitCount}`。
   */
  function trimTermsByDf(units) {
    const df = Object.create(null);
    units.forEach(function (u) {
      (u.terms || []).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    const n = units.length;
    units.forEach(function (u) {
      const terms = u.terms || [];
      if (terms.length <= TERM.MAX_PER_UNIT) return;
      u.terms = terms.slice().sort(function (a, b) {
        const da = df[a] || 0;
        const db = df[b] || 0;
        if (da !== db) return da - db;
        return a < b ? -1 : (a > b ? 1 : 0);
      }).slice(0, TERM.MAX_PER_UNIT).sort();                        // 截完再按字典序（确定性）
    });
    return { df: df, unitCount: n };
  }

  /* ==========================================================================
   * 2. 章号（**只用于显示与读数**，绝不用于排序 —— 排序永远是树序）
   * ======================================================================== */

  const CN_DIGIT = Object.freeze({
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 百: 100, 千: 1000
  });

  /** 中文数字 → 整数（支持"十/十三/二十三/一百零八"这类常见写法；认不出 ⇒ null，**不猜**） */
  function cnToInt(s) {
    const str = String(s);
    if (!str) return null;
    let total = 0;
    let cur = 0;
    let seen = false;
    for (let i = 0; i < str.length; i++) {
      const d = CN_DIGIT[str[i]];
      if (d === undefined) return null;
      seen = true;
      if (d >= 10) {
        total += (cur === 0 ? 1 : cur) * d;
        cur = 0;
      } else {
        cur = cur * 10 + d;
      }
    }
    if (!seen) return null;
    return total + cur;
  }

  /**
   * 从主题里读章号。**读不出就是 `null`**（`第1部分 …` / `主线总览` / `与其他项目的关联地图` 都是这一档）——
   * 不猜、不按位置补，因为章号只用于**显示与冲突读数**，猜错只会制造假读数。
   * @returns {{no:(number|null), range:(number[]|null)}}
   */
  function parseChapterNo(topic) {
    const t = String(topic === undefined || topic === null ? '' : topic);
    // `第10–14章` / `第10-14章` / `第10~14章`（区间取**下限**做题面章号，同时记下区间）
    let m = /第\s*([0-9]{1,4})\s*[–\-~～至]\s*([0-9]{1,4})\s*章/.exec(t);
    if (m) return { no: Number(m[1]), range: [Number(m[1]), Number(m[2])] };
    m = /第\s*([0-9]{1,4})\s*章/.exec(t);
    if (m) return { no: Number(m[1]), range: null };
    m = /第\s*([零〇一二两三四五六七八九十百千]{1,6})\s*章/.exec(t);
    if (m) { const n = cnToInt(m[1]); return { no: (n === null ? null : n), range: null }; }
    return { no: null, range: null };
  }

  /* ==========================================================================
   * 3. 输入 → 学习单元（unit）与书（book）
   * ======================================================================== */

  function keyOf(project, nodeId) { return String(project) + '\u0000' + String(nodeId); }

  function hasDetail(n) {
    return typeof n.detail === 'string' && n.detail.replace(/\s+/g, '') !== '';
  }

  /**
   * 把若干项目摊成"有序的单元序列"（**书内 DFS 前序**，含父先于子 = 章导读在小节之前）。
   *
   * 学习单元 = **有 detail 的节点**（`detail` 非空且非纯空白）。理由：没有正文的节点是**容器**
   * （`AI 结构节点——分组用，本身不含独立正文`，7 本书里这类节点自己的 detail 里就写着这句），
   * 把它当"要学的知识"会让链路里塞满空壳。
   *
   * @param {Array<{name:string, title?:string, data:object}>} projects 已读进内存的项目数据
   * @param {{order?:string[]}} [opts] `order` = 显式书序（未列出的按项目名升序接在后面）
   * @returns {{ok:boolean, code?:string, message?:string, books?:Array, units?:Array, unitByKey?:object, skipped?:Array}}
   */
  function collectUnits(projects, opts) {
    const o = opts || {};
    const list = Array.isArray(projects) ? projects.slice() : [];
    if (!list.length) return { ok: false, code: 'no-input', message: '一个项目都没给' };

    // 书序（T4 的一档，也是"同分时谁优先"的确定性约束）：--order 给的名字在前，其余按项目名升序
    const order = Array.isArray(o.order) ? o.order.map(String) : [];
    const rank = Object.create(null);
    order.forEach(function (name, i) { if (rank[name] === undefined) rank[name] = i; });
    const rest = list.map(function (p) { return String(p.name); })
      .filter(function (n) { return rank[n] === undefined; }).sort();
    rest.forEach(function (n, i) { rank[n] = order.length + i; });

    const books = [];
    const units = [];
    const unitByKey = Object.create(null);
    const skipped = [];
    let spineErrors = 0;
    /** 语料级噪声词 = **本次输入的项目名**（正文里到处在点名项目 ⇒ 让 `book-linux-net` 变成术语
     *  就会把"这本书提到那本书"当成概念相关）。 */
    const corpusExtras = list.map(function (p) { return String(p.name); });

    list.forEach(function (proj) {
      const name = String(proj.name);
      const doc = proj.data || {};
      const treeRoot = doc.data || {};
      const nodeByKey = Object.create(null);
      const book = {
        project: name,
        title: String((doc.meta && doc.meta.name) || treeRoot.topic || name),
        rank: rank[name],
        units: 0,
        spineErrors: [],
        chapterNos: []
      };
      let spineIndex = 0;
      let lastChapterNo = null;

      // 顶层主题（= 书的一章 / 一个主题）。章号只读顶层祖先的 topic
      (treeRoot.children || []).forEach(function (top, topIndex) {
        const ch = parseChapterNo(top && top.topic);
        const chapter = {
          title: String((top && top.topic) || ''),
          topIndex: topIndex,
          no: ch.no,
          range: ch.range
        };
        book.chapterNos.push(chapter.no);
        (function walk(node, depth) {
          if (!node || typeof node !== 'object') return;
          nodeByKey[String(node.id)] = node;
          if (hasDetail(node)) {
            const u = {
              key: keyOf(name, node.id),
              project: name,
              nodeId: String(node.id),
              topic: String(node.topic === undefined || node.topic === null ? '' : node.topic),
              depth: depth,
              chapter: chapter,
              spineIndex: spineIndex++,
              bookRank: rank[name],
              terms: extractTerms(node, corpusExtras)
            };
            units.push(u);
            unitByKey[u.key] = u;
          }
          // 同级小节号的**树序冲突**读数（只报不改，与章号那条同一条纪律）
          checkSiblingOrder(node, book);
          (node.children || []).forEach(function (c) { walk(c, depth + 1); });
        })(top, 1);
        // 章号与树序的**冲突读数**（只报不改：树序是有序表达，章号不是）
        const no = chapter.no;
        if (no !== null) {
          if (lastChapterNo !== null && no < lastChapterNo) {
            book.spineErrors.push({
              kind: 'chapter-no-descends',
              at: 'topIndex=' + topIndex + ' node=' + String((top && top.id) || ''),
              detail: '章号 ' + no + ' 排在章号 ' + lastChapterNo + ' 之后（树序与章号冲突；'
                + '排序仍按树序，此处只如实报出）'
            });
            spineErrors++;
          }
          lastChapterNo = no;
        }
      });
      book.units = spineIndex;
      books.push(book);
    });

    // 书名去重（同一个项目给两次是调用方搞错了：不静默去重，直接拒绝）
    const seen = Object.create(null);
    const dup = [];
    books.forEach(function (b) { if (seen[b.project]) dup.push(b.project); seen[b.project] = 1; });
    if (dup.length) {
      return { ok: false, code: 'duplicate-project', message: '项目重复给了：' + dup.join('、') + '（每个项目只能出现一次）' };
    }
    if (!units.length) {
      return {
        ok: false, code: 'no-units',
        message: '这批项目里一个学习单元都没有（判据：节点有非空 detail）。'
          + 'LP 的输入契约是"树结构 + detail 正文"，没有正文就没有可排序的内容。'
      };
    }
    if (units.length > MAX_UNITS) {
      return {
        ok: false, code: 'too-many-units',
        message: '学习单元 ' + units.length + ' 个，超过上限 ' + MAX_UNITS
          + '（导航打分是 O(n²) 量级，大输入会慢到不可用）。出路：用 --limit 截断，或分批生成'
      };
    }

    books.sort(function (a, b) { return a.rank - b.rank; });
    // 每本书的单元总数（人话渲染用）：算一次写进 unit，别处**只读**（重算就是第二份口径）
    const totals = Object.create(null);
    units.forEach(function (u) { totals[u.project] = (totals[u.project] || 0) + 1; });
    units.forEach(function (u) { u.__spineTotal = totals[u.project]; });
    // 术语的 df 与区分度截断（**必须在全部单元收齐之后**：df 是全语料的事实）
    const tf = trimTermsByDf(units);
    return {
      ok: true, books: books, units: units, unitByKey: unitByKey,
      skipped: skipped, spineErrors: spineErrors,
      termDf: tf.df, unitCount: tf.unitCount
    };
  }

  /**
   * 同级小节号的树序冲突读数（`1.2.3` 排在 `1.2.1` 之前这类）。
   * **只报不改**，与 `chapter-no-descends` 同一条纪律：树序是数据里唯一有序的表达，
   * 我们不能替作者重排（重排就不是"这本书的顺序"了，而且会把读者领到另一条路上却不说）。
   */
  function checkSiblingOrder(node, book) {
    const kids = Array.isArray(node.children) ? node.children : [];
    if (kids.length < 2) return;
    let last = null;
    kids.forEach(function (k) {
      const sn = sectionNo(k && k.topic);
      if (sn === null) return;
      if (last !== null && sn.n < last.n) {
        book.spineErrors.push({
          kind: 'section-no-descends',
          at: 'parent=' + String(node.id) + ' child=' + String((k && k.id) || ''),
          detail: '小节「' + sn.label + '」排在「' + last.label + '」之后（树序与节号冲突；'
            + '排序仍按树序，此处只如实报出）'
        });
      }
      last = sn;
    });
  }

  /** 从主题里读"小节号"（`1.2.3 xxx` ⇒ `{n: 可比较整数, label: '1.2.3'}`；读不出 ⇒ null，不猜） */
  function sectionNo(topic) {
    const m = /^\s*([0-9]{1,2}(?:\.[0-9]{1,3}){1,3})/.exec(String(topic === undefined || topic === null ? '' : topic));
    if (!m) return null;
    let n = 0;
    m[1].split('.').forEach(function (seg) { n = n * 1000 + Number(seg); });
    return { n: n, label: m[1] };
  }

  /* ==========================================================================
   * 4. 图：T1 骨架边 + T2 显式前置边（**只有这两种边**）
   * ======================================================================== */

  function isPrereqCaption(caption) {
    const s = String(caption === undefined || caption === null ? '' : caption).trim();
    for (let i = 0; i < PREREQ_PREFIXES.length; i++) {
      if (s.indexOf(PREREQ_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /**
   * 建图。边只有两种：
   *   · `kind:'spine'`    —— 同一本书内相邻单元（u_i → u_{i+1}），来自 T1；
   *   · `kind:'explicit'` —— `links[]` 的 caption 以「前置：」开头（目标 → 本节点），来自 T2。
   *
   * ⚠️ **未解析的显式前置**（目标节点在那个项目里不存在 / 存在但没有 detail ⇒ 不是学习单元）
   * 一律进 `unresolvedEdges` **点名**，**不静默丢** —— 静默丢边 = 用户以为约束生效了、其实没生效。
   *
   * @param {object} collected `collectUnits()` 的产物
   * @param {{projects?:Array}} [opts] `projects` = 原始项目数据（用来查 links 与目标节点）
   * @returns {{ok:boolean, code?:string, message?:string, edges:Array, explicitEdges:Array,
   *            unresolvedEdges:Array, adj:object, indeg:object}}
   */
  function buildGraph(collected, opts) {
    const o = opts || {};
    const units = collected.units || [];
    const unitByKey = collected.unitByKey || {};
    const projectNames = Object.create(null);
    (o.projects || []).forEach(function (p) { projectNames[String(p.name)] = p.data || {}; });

    const edges = [];
    const adj = Object.create(null);
    const indeg = Object.create(null);
    units.forEach(function (u) { adj[u.key] = []; indeg[u.key] = 0; });

    function addEdge(fromKey, toKey, meta) {
      if (!adj[fromKey] || !adj[toKey]) return false;
      if (fromKey === toKey) return false;
      // 同一条边（同 from/to/kind/at）只记一次（幂等；`links` 里重复声明是同一条约束）
      const dup = edges.some(function (e) {
        return e.from === fromKey && e.to === toKey && e.kind === meta.kind && e.at === meta.at;
      });
      if (dup) return false;
      const e = { from: fromKey, to: toKey, kind: meta.kind, at: String(meta.at || ''), caption: String(meta.caption || '') };
      edges.push(e);
      adj[fromKey].push(e);
      indeg[toKey] += 1;
      return true;
    }

    // T1：书内相邻单元（顺序 = spineIndex，与 units 的产出顺序一致）
    const byBook = Object.create(null);
    units.forEach(function (u) {
      const arr = byBook[u.project] || (byBook[u.project] = []);
      arr.push(u);
    });
    Object.keys(byBook).forEach(function (name) {
      const arr = byBook[name].slice().sort(function (a, b) { return a.spineIndex - b.spineIndex; });
      for (let i = 1; i < arr.length; i++) {
        addEdge(arr[i - 1].key, arr[i].key, { kind: 'spine', at: name });
      }
    });

    // T2：显式前置（caption 前缀约定）
    const explicitEdges = [];
    const unresolvedEdges = [];
    units.forEach(function (u) {
      const doc = projectNames[u.project];
      if (!doc || !doc.data) return;
      const node = findNodeIn(doc.data, u.nodeId);
      const links = node && Array.isArray(node.links) ? node.links : [];
      links.forEach(function (link, li) {
        if (!link || typeof link !== 'object') return;
        if (!isPrereqCaption(link.caption)) return;
        const targetProject = String(link.project === undefined ? '' : link.project);
        const targetId = String(link.id === undefined ? '' : link.id);
        const at = u.project + '/' + u.nodeId + '#links[' + li + ']';
        const targetKey = keyOf(targetProject, targetId);
        if (!unitByKey[targetKey]) {
          const targetDoc = projectNames[targetProject];
          let why = 'target-project-missing';
          if (targetDoc) {
            const tNode = findNodeIn(targetDoc.data, targetId);
            why = tNode ? 'target-not-a-unit' : 'target-node-missing';
          }
          unresolvedEdges.push({
            at: at, project: u.project, nodeId: u.nodeId, targetProject: targetProject, targetId: targetId,
            code: why,
            detail: why === 'target-not-a-unit'
              ? '显式前置指向的节点没有 detail ⇒ 它不是学习单元，这条前置**没有生效**'
              : (why === 'target-node-missing'
                ? '显式前置指向的节点在目标项目里不存在，这条前置**没有生效**'
                : '显式前置指向的项目不在本次输入里，这条前置**没有生效**')
          });
          return;
        }
        const rec = { from: targetKey, to: u.key, kind: 'explicit', at: at, caption: String(link.caption || '') };
        if (addEdge(targetKey, u.key, rec)) explicitEdges.push(rec);
      });
    });

    return { ok: true, edges: edges, explicitEdges: explicitEdges, unresolvedEdges: unresolvedEdges, adj: adj, indeg: indeg };
  }

  function findNodeIn(root, id) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (String(n.id) === String(id)) return n;
      const kids = n.children || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return null;
  }

  /* ==========================================================================
   * 5. 拓扑排序（Kahn + 确定性优先队列）+ 环点名
   * ======================================================================== */

  /**
   * 找出**所有**强连通分量（Tarjan，迭代实现 ⇒ 栈不会随图规模溢出）。
   * 出环时用它回答"哪几条边成环"：SCC 内部的全部边就是**可能落在环上的边**，
   * 并与自环一起逐条列出（**不静默丢边**、也不猜"该断哪一条"）。
   */
  function stronglyConnected(keys, adj) {
    const index = Object.create(null);
    const low = Object.create(null);
    const onStack = Object.create(null);
    const stack = [];
    const out = [];
    let counter = 0;

    keys.forEach(function (start) {
      if (index[start] !== undefined) return;
      const work = [{ v: start, i: 0 }];
      index[start] = low[start] = counter++;
      stack.push(start); onStack[start] = 1;
      while (work.length) {
        const frame = work[work.length - 1];
        const v = frame.v;
        const edges = adj[v] || [];
        if (frame.i < edges.length) {
          const w = edges[frame.i++].to;
          if (index[w] === undefined) {
            index[w] = low[w] = counter++;
            stack.push(w); onStack[w] = 1;
            work.push({ v: w, i: 0 });
          } else if (onStack[w]) {
            if (index[w] < low[v]) low[v] = index[w];
          }
        } else {
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1].v;
            if (low[v] < low[parent]) low[parent] = low[v];
          }
          if (low[v] === index[v]) {
            const comp = [];
            let w;
            do { w = stack.pop(); onStack[w] = 0; comp.push(w); } while (w !== v && stack.length);
            out.push(comp);
          }
        }
      }
    });
    return out;
  }

  /**
   * 排序。**确定性**靠的是全序比较器（书序 → 书内序 —— 已是全序，没有 nodeId 兜底），没有一处读时钟/随机。
   *
   * 优先键（从大到小）：
   *   ① `affinity(prev, u)` —— 与**上一步**共享术语的 **IDF 加权和**（T3：只导航，不宣布前置）
   *   ② `bookRank`         —— 书序（T4 的确定性约束）
   *   ③ `spineIndex`       —— 书内序（与 ② 合起来已经是**全序**，不需要再加 nodeId 兜底）
   *
   * @returns {{ok:boolean, code?:string, message?:string, order?:Array, steps?:Array,
   *            cycles?:Array, acyclic?:boolean}}
   */
  function topoOrder(graph, collected, opts) {
    const o = opts || {};
    const limit = (o.limit === undefined || o.limit === null) ? null : Number(o.limit);
    const units = collected.units || [];
    const unitByKey = collected.unitByKey || {};
    const termDf = collected.termDf || Object.create(null);
    const unitCount = collected.unitCount || units.length;
    const adj = graph.adj;
    const indeg = Object.create(null);
    Object.keys(graph.indeg).forEach(function (k) { indeg[k] = graph.indeg[k]; });

    const prevByKey = Object.create(null);
    graph.edges.forEach(function (e) {
      const arr = prevByKey[e.to] || (prevByKey[e.to] = []);
      arr.push(e);
    });

    const ready = units.filter(function (u) { return indeg[u.key] === 0; })
      .map(function (u) { return u.key; });
    const remaining = Object.create(null);
    units.forEach(function (u) { remaining[u.key] = 1; });

    /** 与上一步的**加权**相关度（整数；`df === N` 的术语权重为 0 ⇒ 模板噪声自动失效） */
    function affinityOf(prev, cand) {
      if (!prev) return 0;
      const b = cand.terms || [];
      if (!b.length || !(prev.terms || []).length) return 0;
      const set = new Set(b);
      let sum = 0;
      (prev.terms || []).forEach(function (t) {
        if (set.has(t)) sum += idfWeight(termDf[t] || 1, unitCount);
      });
      return sum;
    }
    /** 共享术语（按权重降序 → 名字升序），人读与复算都用它 */
    function sharedTerms(prev, cand) {
      if (!prev) return [];
      const set = new Set(cand.terms || []);
      return (prev.terms || []).filter(function (t) { return set.has(t); })
        .map(function (t) { return { term: t, weight: idfWeight(termDf[t] || 1, unitCount), df: termDf[t] || 1 }; })
        .sort(function (x, y) {
          if (y.weight !== x.weight) return y.weight - x.weight;
          return x.term < y.term ? -1 : (x.term > y.term ? 1 : 0);
        });
    }

    const order = [];
    let prev = null;
    while (ready.length && (limit === null || order.length < limit)) {
      let bestIdx = 0;
      let bestAff = -1;
      for (let i = 0; i < ready.length; i++) {
        const cand = unitByKey[ready[i]];
        const aff = affinityOf(prev, cand);
        if (i === 0) { bestIdx = 0; bestAff = aff; continue; }
        const cur = unitByKey[ready[bestIdx]];
        let better;
        if (aff !== bestAff) better = aff > bestAff;
        else if (cand.bookRank !== cur.bookRank) better = cand.bookRank < cur.bookRank;
        else better = cand.spineIndex < cur.spineIndex;
        /* ↑ 这三档就是**全序**，不需要再加 nodeId 兜底：`(bookRank, spineIndex)` 唯一
         *   —— 同一本书里 `spineIndex` 逐个递增；`bookRank` 按项目名唯一（重复项目在
         *   `collectUnits` 里就被拒绝了）⇒ 任意两个单元必有一档分出高低。
         *   ⚠️ 这一行原来还挂过 `cand.nodeId < cur.nodeId` 的兜底，**实测打不掉**：把它改成
         *   `false` 之后单测**全绿**（它永远走不到）⇒ 是死代码。按本工程的口径
         *   （"永远打不出来的分支 = 让人以为守住了"，见 `src/path-chain.js` 的同一条注释）删掉，
         *   改由单测里那条"全序"用例**钉住唯一性**。 */
        if (better) { bestIdx = i; bestAff = aff; }
      }
      const key = ready.splice(bestIdx, 1)[0];
      const u = unitByKey[key];
      delete remaining[key];
      order.push(u);

      const step = { unit: u, prev: prev, affinity: bestAff, shared: sharedTerms(prev, u), prereqs: prevByKey[key] || [] };      u.__step = step;
      (adj[key] || []).forEach(function (e) { indeg[e.to] -= 1; if (indeg[e.to] === 0) ready.push(e.to); });
      prev = u;
    }

    // 有环：剩下的节点全是"入度永远归不了零"的 ⇒ 点名每一类成环的边
    /* ⚠️ **必须先分清"排不完"的两种原因**（踩过：`--limit 5` 一度被报成"成环 540 个单元"）：
     *   · `--limit` 到点了 ⇒ 剩下的是**故意的截断**，不是环；
     *   · 就绪集空了但还有节点 ⇒ 那才是**入度归不了零**的环。
     * 分不清的后果很严重：调用方看到"成环"会去改数据，而数据本来就是好的。 */
    const stoppedByLimit = (limit !== null && order.length >= limit && ready.length > 0);
    const left = stoppedByLimit ? [] : Object.keys(remaining);
    if (left.length) {
      const comps = stronglyConnected(Object.keys(indeg), adj).filter(function (c) { return c.length > 1; });
      const selfLoops = graph.edges.filter(function (e) { return e.from === e.to; });
      const cycleEdges = [];
      comps.forEach(function (comp) {
        const set = Object.create(null);
        comp.forEach(function (k) { set[k] = 1; });
        graph.edges.forEach(function (e) {
          if (set[e.from] && set[e.to]) cycleEdges.push({ from: e.from, to: e.to, kind: e.kind, at: e.at, caption: e.caption });
        });
      });
      selfLoops.forEach(function (e) {
        cycleEdges.push({ from: e.from, to: e.to, kind: e.kind, at: e.at, caption: e.caption });
      });
      const cycles = comps.map(function (comp) {
        return {
          members: comp.slice().sort(),
          edges: graph.edges.filter(function (e) {
            const set = Object.create(null);
            comp.forEach(function (k) { set[k] = 1; });
            return set[e.from] && set[e.to];
          })
        };
      });
      const lines = cycleEdges.map(function (e) {
        return '  · ' + e.kind + ' 边：' + labelOf(e.from) + ' → ' + labelOf(e.to) + '（声明处 '
          + (e.at || '—') + (e.caption ? '；caption=' + JSON.stringify(e.caption) : '') + '）';
      });
      return {
        ok: false, code: 'cycle', acyclic: false, cycles: cycles,
        message: '链路成环（拓扑排序排不完：' + left.length + ' 个单元卡在环上）—— **一条边都没有被丢掉**，'
          + '下面逐条点名成环的边，请改掉其中一条的来源：\n' + lines.join('\n')
          + '\n出路：把那条 `links[].caption` 的「前置：」前缀去掉（它本就是"互为补充"而不是前置），'
          + '或改指另一个真正在前的节点。'
      };
    }

    function labelOf(k) {
      const u = unitByKey[k];
      return u ? (u.project + '/' + u.nodeId + '「' + u.topic + '」') : String(k);
    }

    // steps：每步的"为什么排在这"（与 `whyTokenOf()` 同一份原料 ⇒ 不可能漂移）
    const steps = order.map(function (u, i) {
      const st = u.__step;
      const why = whyOf(st, i);
      delete u.__step;
      return {
        seq: i + 1,
        project: u.project,
        nodeId: u.nodeId,
        topic: u.topic,
        chapter: u.chapter.title,
        chapterNo: u.chapter.no,
        chapterRange: u.chapter.range,
        depth: u.depth,
        spineIndex: u.spineIndex,
        termCount: (u.terms || []).length,
        why: why
      };
    });

    return { ok: true, acyclic: true, cycles: [], order: order, steps: steps, truncated: !!(limit !== null && limit < units.length) };
  }

  /**
   * 一步的**依据**（唯一实现处）。三段合成：
   *   ① `kind`/`confidence` —— 按强度选出**最强的那一条依据**（取值为 `WHY_KINDS` 的封闭表）；
   *   ② `evidence` —— 支撑它的**可复算事实**（章序位置 / 共享术语数 + 术语名 / 已满足的显式前置）；
   *   ③ 人话 `text` —— 由 ①② 渲染，不另取数据（所以不可能与它们漂移）。
   */
  function whyOf(st, i) {
    const u = st.unit;
    const prev = st.prev;
    const isSpineNext = !!(prev && prev.project === u.project && u.spineIndex === prev.spineIndex + 1);
    const explicit = (st.prereqs || []).filter(function (e) { return e.kind === 'explicit'; });
    const shared = st.shared || [];
    const evidence = {
      spine: '本书（' + u.project + '）第 ' + (u.spineIndex + 1) + ' 个单元'
        + (prev ? '；上一步是 ' + prev.project + '/' + prev.nodeId : '；这是链路第一步'),
      chapter: u.chapter.title + (u.chapter.no === null ? '（顶层主题无章号）' : '（章号 ' + u.chapter.no + '）'),
      overlap: shared.length,
      affinity: st.affinity,
      sharedTerms: shared.slice(0, 6).map(function (x) { return x.term; }),
      sharedTermWeights: shared.slice(0, 6).map(function (x) { return { term: x.term, df: x.df, weight: x.weight }; }),
      prereqs: explicit.map(function (e) { return { from: e.from, at: e.at }; })
    };
    let kind = 'mechanical';
    let text = '';
    if (isSpineNext) {
      kind = 'chapter-order';
      text = '本书内章序：它是 ' + prev.nodeId + '「' + prev.topic + '」在书里的下一个单元（本书第 '
        + (u.spineIndex + 1) + ' / ' + String(u.__spineTotal || (u.spineIndex + 1)) + ' 个单元）';
    } else if (explicit.length) {
      kind = 'explicit-prereq';
      text = '它有 ' + explicit.length + ' 条显式前置（caption 以「前置：」开头），此刻全部已学过';
    } else if (st.affinity > 0) {
      kind = 'term-affinity';
      text = '与上一步共享 ' + shared.length + ' 个术语（' + shared.slice(0, 3).map(function (x) { return x.term; }).join('、')
        + '），IDF 加权相关度 ' + st.affinity + ' —— 在全部就绪候选里最高。'
        + '**这是相关度导航，不是前置关系**（共现是对称的，推不出方向）';
    } else {
      kind = 'mechanical';
      text = '没有更强的依据：按确定性兜底序（书序 → 书内序）排在这 —— **这是机械序，不是学出来的顺序**';
    }
    return { kind: kind, confidence: confidenceOf(kind), text: text, evidence: evidence, prev: prev ? (prev.project + '/' + prev.nodeId) : null };
  }

  /* ==========================================================================
   * 6. 跳级 / 前置未覆盖（**能算的判据**，见设计 §3.9）
   * ======================================================================== */

  function computeGaps(collected, graph, steps, opts) {
    const o = opts || {};
    const unitByKey = collected.unitByKey || {};
    const projectNames = Object.create(null);
    (o.projects || []).forEach(function (p) { projectNames[String(p.name)] = p.data || {}; });
    const posOf = Object.create(null);
    steps.forEach(function (s, i) { posOf[keyOf(s.project, s.nodeId)] = i; });

    const items = [];
    const byKind = Object.create(null);
    const recorded = Object.create(null);                              // 「同一条边只记一次」的账
    (collected.units || []).forEach(function (u) {
      const doc = projectNames[u.project];
      if (!doc || !doc.data) return;
      const node = findNodeIn(doc.data, u.nodeId);
      const links = node && Array.isArray(node.links) ? node.links : [];
      const here = posOf[u.key];
      if (here === undefined) return;                                   // 没进链路（--limit 截断）⇒ 不判
      links.forEach(function (link) {
        if (!link || typeof link !== 'object') return;
        const proj = String(link.project === undefined ? '' : link.project);
        const id = String(link.id === undefined ? '' : link.id);
        const k = keyOf(proj, id) + '\u0001' + u.key;
        if (recorded[k]) return;
        recorded[k] = 1;
        const at = u.project + '/' + u.nodeId;
        if (!projectNames[proj]) {
          byKind['linked-outside-path'] = (byKind['linked-outside-path'] || 0) + 1;
          items.push({ kind: 'linked-outside-path', step: here + 1, at: at, target: proj + '/' + id,
            detail: '这一步引用了**路径外**的项目「' + proj + '」里的知识点 ⇒ 那条前置不在本次链路里' });
          return;
        }
        const tKey = keyOf(proj, id);
        if (!unitByKey[tKey]) {
          const tNode = findNodeIn(projectNames[proj].data, id);
          if (!tNode) return;                                            // 目标节点不存在：由 G2 的悬挂检测负责，这里不重复报
          byKind['linked-not-a-unit'] = (byKind['linked-not-a-unit'] || 0) + 1;
          items.push({ kind: 'linked-not-a-unit', step: here + 1, at: at, target: proj + '/' + id,
            detail: '引用的目标节点没有正文（不是学习单元）⇒ 它不会出现在链路里' });
          return;
        }
        const tPos = posOf[tKey];
        if (tPos === undefined || tPos > here) {
          byKind['linked-later'] = (byKind['linked-later'] || 0) + 1;
          items.push({ kind: 'linked-later', step: here + 1, at: at, target: proj + '/' + id,
            detail: tPos === undefined
              ? '引用的目标单元没进本次链路（被 --limit 截断在后面）'
              : '引用的目标单元排在链路第 ' + (tPos + 1) + ' 步（**在本步之后**）⇒ 前置未覆盖' });
        }
      });
    });
    items.sort(function (a, b) {
      if (a.step !== b.step) return a.step - b.step;
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return a.target < b.target ? -1 : (a.target > b.target ? 1 : 0);
    });
    const samples = items.slice(0, (o.sampleLimit === undefined ? 20 : o.sampleLimit));
    return { count: items.length, byKind: byKind, samples: samples, items: items };
  }

  /* ==========================================================================
   * 7. 机器可读的「依据行」（生成器与解析器**同一处实现** ⇒ 产物与报告不可能漂移）
   * ======================================================================== */

  /**
   * `why` → 一行扁平的 `lp-why:v1|kind=…|…`
   * 为什么要有它：产物（项目 JSON 里的 `detail`，HTML）要能被**人**读，也要能被**机器**反查。
   * 把"机器可读"做成 detail 里一行 `<code>`，就能对一个**已经生成的产物项目**做判据 3 的复核
   * （不必重新生成、也不必回去看 `--json` 报告）。
   */
  function whyTokenOf(why) {
    const w = why || {};
    const ev = w.evidence || {};
    const parts = [
      WHY_TOKEN_PREFIX + WHY_TOKEN_VERSION,
      'kind=' + String(w.kind || ''),
      'conf=' + String(w.confidence || ''),
      'overlap=' + String(ev.overlap === undefined ? 0 : ev.overlap),
      'spine=' + String(ev.spine === undefined ? '' : ev.spine).replace(/\|/g, '/'),
      'prev=' + String(w.prev === null || w.prev === undefined ? '' : w.prev),
      'terms=' + (Array.isArray(ev.sharedTerms) ? ev.sharedTerms.join(',') : '')
    ];
    return parts.join('|');
  }

  /** 解析 `whyTokenOf()` 的产物（不认识的行 ⇒ `null`；**不猜**） */
  function parseWhyToken(text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    const i = s.indexOf(WHY_TOKEN_PREFIX + WHY_TOKEN_VERSION);
    if (i < 0) return null;
    const body = s.slice(i);
    const out = { version: WHY_TOKEN_VERSION };
    body.split('|').slice(1).forEach(function (seg) {
      const eq = seg.indexOf('=');
      if (eq < 0) return;
      out[seg.slice(0, eq)] = seg.slice(eq + 1);
    });
    out.overlap = Number(out.overlap || 0);
    out.terms = out.terms ? String(out.terms).split(',').filter(Boolean) : [];
    return out;
  }

  /* ==========================================================================
   * 8. 总入口：**纯函数**（不读盘、不写盘、不读时钟）
   * ======================================================================== */

  /**
   * @param {Array<{name:string, data:object}>} projects 已读进内存的项目
   * @param {{order?:string[], limit?:number, ai?:object}} [opts]
   *   `ai` —— **接口位**（本版一次也不调）：形状 `{ call({kind, units}) → {text} }`；
   *            给了它也只会在 `AI_BUDGET.PROGRAM_ONLY === false` 时才被调用，且每次调用**必须**
   *            往 `ai.log` 追加一行（计数 = 日志长度，见文件头）。
   */
  function planPath(projects, opts) {
    const o = opts || {};
    const collected = collectUnits(projects, { order: o.order });
    if (!collected.ok) return collected;

    const graph = buildGraph(collected, { projects: projects });
    if (!graph.ok) return graph;

    const topo = topoOrder(graph, collected, { limit: o.limit });
    if (!topo.ok) return topo;

    const gaps = computeGaps(collected, graph, topo.steps, { projects: projects, sampleLimit: 20 });

    // ---- AI 预算：硬闸门（本版 maxCalls = 0 ⇒ 只要日志里有一行就拒绝） ----
    const aiLog = Array.isArray(o.aiLog) ? o.aiLog : [];
    const maxCalls = AI_BUDGET.maxCalls(collected.units.length, collected.books.length);
    if (aiLog.length > maxCalls) {
      return {
        ok: false, code: 'ai-budget',
        message: 'AI 调用 **' + aiLog.length + ' 次**，超过上界 ' + maxCalls + '（单位 = 调用次数；'
          + '上界公式见 src/learn-path.js 的 AI_BUDGET.maxCalls）。第 ' + (maxCalls + 1) + ' 次调用：'
          + JSON.stringify(aiLog[maxCalls] || {}) + ' —— 计数来自**调用日志的条数**，不是自报计数器。'
      };
    }

    // 确定性指纹：把 steps 的"判据相关字段"规范化后拼一串（命令层用 sha256 落读数）
    const canonical = topo.steps.map(function (s) {
      return [s.seq, s.project, s.nodeId, s.why.kind, s.why.evidence.overlap, s.why.prev || ''].join('\u0001');
    }).join('\u0002');

    return {
      ok: true,
      books: collected.books,
      units: {
        total: collected.units.length,
        books: collected.books.length,
        spineErrors: collected.spineErrors
      },
      graph: {
        nodes: collected.units.length,
        edges: graph.edges.length,
        spineEdges: graph.edges.filter(function (e) { return e.kind === 'spine'; }).length,
        explicitEdges: graph.explicitEdges,
        unresolvedEdges: graph.unresolvedEdges,
        acyclic: true,
        cycles: []
      },
      steps: topo.steps,
      truncated: !!topo.truncated,
      gaps: { count: gaps.count, byKind: gaps.byKind, samples: gaps.samples },
      ai: { calls: aiLog.length, maxCalls: maxCalls, unit: AI_BUDGET.unit, adapter: o.ai ? 'injected' : 'none', log: aiLog },
      determinism: { canonical: canonical }
    };
  }

  return {
    // 取值表（唯一一处）
    WHY_KINDS: WHY_KINDS, WHY_KIND_NAMES: WHY_KIND_NAMES, confidenceOf: confidenceOf,
    PREREQ_PREFIXES: PREREQ_PREFIXES,
    WHY_TOKEN_VERSION: WHY_TOKEN_VERSION, WHY_TOKEN_PREFIX: WHY_TOKEN_PREFIX,
    TERM: TERM, STOP_TERMS: STOP_TERMS, MAX_UNITS: MAX_UNITS, AI_BUDGET: AI_BUDGET,
    // 文本与术语
    plainTextOf: plainTextOf, normTerm: normTerm, extractTerms: extractTerms, isStopTerm: isStopTerm,
    isNoiseTerm: isNoiseTerm, idfWeight: idfWeight, trimTermsByDf: trimTermsByDf,
    // 章号
    parseChapterNo: parseChapterNo, cnToInt: cnToInt,
    // 单元 / 图 / 排序
    collectUnits: collectUnits, buildGraph: buildGraph, topoOrder: topoOrder,
    isPrereqCaption: isPrereqCaption, findNodeIn: findNodeIn,
    whyOf: whyOf, computeGaps: computeGaps,
    // 依据行
    whyTokenOf: whyTokenOf, parseWhyToken: parseWhyToken,
    // 总入口
    planPath: planPath,
    keyOf: keyOf
  };
});
