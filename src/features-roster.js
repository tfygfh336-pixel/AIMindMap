/* ============================================================
 * src/features-roster.js — `features` 命令的**纯逻辑**（零 I/O、双端可加载）
 * ------------------------------------------------------------
 * ## 它回答什么
 * 「这个功能叫什么、现在什么状态、靠哪条命令承载」——**三套名字的互查**：
 * 代号（`SC`）↔ 中文名（`来源链`）↔ CLI 命令名（`source-chain`）。
 * 真源**只有一处**：`docs/FEATURES.md` §3 的「名册（唯一权威表）」。本模块**不复制**那张表，
 * 只在每次调用时把它解析出来现算 —— 抄一份进代码就是第二份副本，必然漂移（本工程的第一条病）。
 * 为什么要有这条命令：`W18` 量过——答「某功能什么状态」要读 79 行 / 29 518 B、答「代号是什么」要读
 * 32 行 / 19 993 B；而按**代号**搜历史会得到"没发生过"的结论（实测 `changelog --grep source-chain`
 * = 0 命中、`--grep 来源链` = 1 命中 —— `GAP-4`）。
 *
 * ## 两条判据（本文件的技术核心；都要**可复算**，不许靠人眼）
 * **判据 A · 承接提及**（锚是 registry）：某条 registry 命令名在这一行里出现过吗 ——
 *   名字**边界匹配**（前后都不许是 `A-Za-z0-9_.-:/[` 之一）。
 *   · 为什么必须有边界：这些形状**形似命令名却不是那个命令**，实测都在 §3 的行里出现过——
 *     `search-all` 里的 `search`、`assoc-add` 里的 `add`、`links[]` 里的 `links`、
 *     `draft-map.html` 里的 `draft-map`、`menu:import-dir` 里的 `import-dir`、`不落 projects/` 里的
 *     `projects`、`search_nodes` 里的 `search`。边界集少一个字符，§3 就会凭空多出若干条"命令名"。
 *   · 锚是 registry ⇒ 这条判据**不会漏**（registry 里每条命令都被拿去找一遍），代价是它答不了
 *     "文档提到一个 registry 里没有的命令吗"—— 那件事归判据 B。
 *
 * **判据 B · 调用形态**（**不依赖 registry**，用来算差集①）：反引号 span 的首词是 kebab-case，
 *   且该 span 里首词之后的首个非空字符是 `--` / `<` / `[` 之一（即它在**当命令用**、后面跟着选项或占位）。
 *   · 为什么不用"全部反引号首词"：实测 §3 里那种写法会多出 **11 条噪声** —— `node`（来自
 *     `node cli/mm-cli.js …`，12 行都有）、`electron`、`at`、`children`、`time`、`semantic`、`comnet`、
 *     `path`、`project`、`note`、`if`、`b` —— 全是运行时名 / 字段名 / 取值 / 代码片段。
 *   · **能力边界（如实）**：单个词的反引号 span（如 `backlinks`）无法与字段名区分 ⇒ **不作**判据 B 的
 *     候选。所以差集①只会**少报**、不会误报 —— 方向是保守的（宁可漏，不可报假）。
 *     这类提及仍会被判据 A 认出来（锚是 registry），不影响"这行提到哪些命令"的完整性。
 *
 * ## 结构性判定（形状不对就**答不了**，不静默给半对的结果）
 *   §3 这一节在不在 · 表头在不在 · 每行列数 == 表头列数 · 代号唯一 · 中文名唯一。
 *   四条都破不了才出报告：这四条一旦破了，"代号 ↔ 中文名"这个对应本身就不成立，
 *   而调用方（AI）拿到的会是"看着像完整的名册"，比报错危险得多。
 *
 * ## 为什么 `--json` 两跑逐字节相同
 *   本模块**不读时钟、不读环境、不读目录顺序**：行序 = 文件顺序，命令名 / 代号 / 差集一律**码点序**
 *   （`sort()` 默认口径，不用 locale），输出对象由命令层按固定键序拼 ⇒ 同输入必同字节。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMFeaturesRoster = factory();          // 浏览器端：纯逻辑，无 I/O 依赖
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** §3 这一节的标题行（`## 3. 名册（唯一权威表）`）。编号与点之间没有空格，用 `3\.` 收口 */
  const SECTION_RE = /^##\s*3\./;
  /** 表头行：以「代号」开头的那一行（`| 代号 | 中文名 | …`） */
  const HEADER_RE = /^\|\s*代号\s*\|/;
  /** 表格行 / 分隔行（`|---|---|`） */
  const ROW_RE = /^\s*\|/;
  const SEP_RE = /^\s*\|[\s|:-]+\|\s*$/;
  /** 像命令名的形状：小写开头，kebab-case */
  const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  /** 判据 B：首词之后的首个非空字符必须是这三种之一（选项 / 占位 / 可选参数） */
  const INVOCATION_REST_RE = /^(--|<|\[)/;
  /**
   * 名字边界（**两侧都不许是这些字符**）：`.` 挡 `a.js` 这类文件名尾巴、`-` 挡 `search-all` 里的
   * `search` 与 `add-file` 里的 `add`、`_` 挡 `search_nodes`、`:` 挡 `menu:import-dir`、
   * `/` 挡 `projects/` 这个目录、`[` 挡 `links[]` 这个字段。
   */
  const BOUNDARY_CLASS = '[^A-Za-z0-9_.\\-:/\\[]';
  /** 表头 7 列的名字（顺序即表格列序；改名要同批改这里与文档） */
  const COLUMNS = ['code', 'name', 'summary', 'carrier', 'status', 'why', 'note'];
  /** `实现状态` 的**闭集**（`docs/FEATURES.md` §2 第 4 条：只有这三种取值）。
   *  ⚠️ 顺序有意义：`未实现（部分）` 必须在 `未实现` **之前**判，否则前缀匹配会把"部分"吃掉。 */
  const STATUS_VALUES = ['未实现（部分）', '已实现', '未实现'];

  /** 去掉 markdown 的强调标记（`**x**` → `x`）与记号（反引号），只留文字 */
  function plain(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\*\*/g, '').replace(/`/g, '').trim();
  }

  /**
   * 按 `|` 切一格表格行的**单元格**，但**不切转义竖线**（`\|`）。
   * 为什么必须处理：§3 的 `AP` 行里写着 `[--mode note\|related]` —— 直接 `split('|')` 会多切一格，
   * 于是第 5 列（`实现状态`）读到的是承载列的后半截，**整行看起来还"像对的"**（实测：16 行里
   * 只有这一行会被切坏，而坏的方式是静默的）。
   */
  function splitCells(line) {
    return String(line).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  }

  /** 名字边界匹配（判据 A）。转义后拼正则 —— 命令名只含字母数字与连字符，不需要更宽的转义 */
  function nameHit(text, key) {
    const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|' + BOUNDARY_CLASS + ')' + esc + '($|' + BOUNDARY_CLASS + ')').test(String(text || ''));
  }

  /** 判据 B：从一行原文里抽出"调用形态"的命令名候选（去重，保持出现顺序） */
  function invocationNames(line) {
    const out = [];
    const text = String(line || '');
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const span = m[1].trim();
      const parts = span.split(/\s+/);
      if (parts.length < 2) continue;                       // 单词 span ⇒ 判不了，不作候选（见文件头「能力边界」）
      const first = parts[0];
      if (!KEBAB_RE.test(first)) continue;
      const rest = span.slice(first.length).trim();
      if (!INVOCATION_REST_RE.test(rest)) continue;          // `node cli/mm-cli.js …` / `electron .` 在这一步被排除
      if (out.indexOf(first) < 0) out.push(first);
    }
    return out;
  }

  /** 把 `实现状态` 单元格切成「闭集里那个取值 + 剩下的旁注」。
   *  例：`已实现（**单级那一半本来就绿**：…）` ⇒ `{status:'已实现', statusDetail:'（单级那一半本来就绿：…）'}`。
   *  不静默归一：不认识的值原样当 status 返回（会在输出里露出来，而不是被悄悄改成"未实现"）。 */
  function splitStatus(cell) {
    const text = plain(cell);
    for (const v of STATUS_VALUES) {
      if (text.indexOf(v) === 0) return { status: v, statusDetail: text.slice(v.length).trim() };
    }
    return { status: text, statusDetail: '' };
  }

  /** 从「备注」列抽台账编号（`台账 \`W17\``）；没有就给 null（`CT`/`LP` 两行确实没有台账号） */
  function ledgerOf(cell) {
    const m = String(cell || '').match(/台账\s*`([WKV]\d+)`/);
    return m ? m[1] : null;
  }

  /**
   * 解析 `docs/FEATURES.md` 的 §3 名册表。
   * @returns {{ok:true, sectionLine:number, sectionTitle:string, headerLine:number, columns:string[],
   *   rows:Array<{line:number, cells:string[], code:string, name:string, summary:string, carrier:string,
   *   status:string, statusDetail:string, why:string, note:string, ledger:string|null}>}
   *   | {ok:false, problems:string[]}}   `line` 一律 **1 起**（与编辑器/`read` 工具一致）
   */
  function parseRoster(md) {
    const text = String(md === undefined || md === null ? '' : md);
    const lines = text.split(/\r?\n/);
    const problems = [];
    const sectionLine = lines.findIndex((l) => SECTION_RE.test(l));
    if (sectionLine < 0) {
      return { ok: false, problems: ['找不到 `## 3.` 这一节 —— 名册是"代号 ↔ 中文名 ↔ 承载命令"的唯一同现处，'
        + '这一节没了就等于没有名字的权威（`docs/FEATURES.md` §3）'] };
    }
    let headerLine = -1;
    for (let i = sectionLine + 1; i < lines.length; i++) {
      if (HEADER_RE.test(lines[i])) { headerLine = i; break; }
      if (/^##\s/.test(lines[i])) break;                    // 出了这一节还没找到 ⇒ 表被删/被改写
    }
    if (headerLine < 0) {
      return { ok: false, problems: ['§3 里找不到以「代号」开头的表头行（`| 代号 | 中文名 | …`）'
        + ' —— 表被删了或被改成别的写法，本命令的真值就在这张表里，解析不到等于没判'] };
    }
    const header = splitCells(lines[headerLine]);
    if (header.length !== COLUMNS.length) {
      return { ok: false, problems: ['§3 的表头有 ' + header.length + ' 列，判据预期 ' + COLUMNS.length
        + ' 列（' + COLUMNS.join(' / ') + '）—— 列变了就要同批改 `src/features-roster.js` 的 `COLUMNS`'] };
    }
    const rows = [];
    for (let i = headerLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!ROW_RE.test(line)) break;                        // 表格到此为止（空行 / 下一节）
      if (SEP_RE.test(line)) continue;                      // `|---|` 分隔行
      const cells = splitCells(line);
      if (cells.length !== header.length) {
        problems.push('L' + (i + 1) + ' 这一行切出 ' + cells.length + ' 格，表头是 ' + header.length
          + ' 格（含 `\\|` 转义竖线也照样算一格）—— 列错位时"状态"会读到别的列，静默地读错');
        continue;
      }
      const st = splitStatus(cells[4]);
      rows.push({
        line: i + 1,
        cells,
        code: plain(cells[0]),
        name: plain(cells[1]),
        summary: plain(cells[2]),
        carrier: cells[3],
        status: st.status,
        statusDetail: st.statusDetail,
        why: plain(cells[5]),
        note: plain(cells[6]),
        ledger: ledgerOf(cells[6])
      });
    }
    if (!rows.length) problems.push('§3 的表里一行数据都没有（只有表头）—— 没有名册可列，不静默返回空');
    const dup = (get) => {
      const seen = new Set();
      const out = [];
      rows.forEach((r) => { const v = get(r); if (v === '') return; if (seen.has(v)) out.push(v); seen.add(v); });
      return out;
    };
    const dupCodes = dup((r) => r.code);
    const dupNames = dup((r) => r.name);
    if (dupCodes.length) problems.push('代号重复：' + dupCodes.join('、') + '（代号是"机器指一件事"的锚，重复即歧义）');
    if (dupNames.length) problems.push('中文名重复：' + dupNames.join('、') + '（§2 第 2 条：彼此必须可区分）');
    if (problems.length) return { ok: false, problems };
    return {
      ok: true,
      sectionLine: sectionLine + 1,
      sectionTitle: String(lines[sectionLine]).replace(/^##\s*/, '').trim(),
      headerLine: headerLine + 1,
      columns: header.map((c) => plain(c)),
      rows
    };
  }

  /**
   * 把名册 + registry 合成**一份可查询的模型**。
   * @param {{md:string, names:string[], aliases?:Object<string,string>}} opts
   *   `names` = registry 的**正式命令名**（`registry.list().map(c => c.name)`）；
   *   `aliases` = 旧写法 → 正式名（命中别名时归一到正式名，否则同一件事会有两个名字）。
   * @returns 解析失败时 `{ok:false, problems}`；成功时：
   *   `rows[]`（每行加了 `commands` / `invocation`）、`docOnly[]`（差集①）、`unmentioned[]`（差集②）、
   *   `registryTotal` / `mentionedCount`
   */
  function buildModel(opts) {
    const o = opts || {};
    const parsed = parseRoster(o.md);
    if (!parsed.ok) return { ok: false, problems: parsed.problems };
    const names = (o.names || []).slice();
    const aliases = o.aliases || {};
    const aliasList = Object.keys(aliases).sort();
    const canonical = (n) => aliases[n] || n;

    const mentioned = new Set();
    const docOnlyMap = new Map();
    const rows = parsed.rows.map((r) => {
      const raw = r.cells.join(' | ');
      // 判据 A：registry 的每条命令名（含别名）在这行里有没有出现
      const hit = [];
      names.forEach((n) => { if (nameHit(raw, n) && hit.indexOf(n) < 0) hit.push(n); });
      aliasList.forEach((a) => {
        const c = canonical(a);                             // 别名命中也归一成正式名：同一件事不许两个名字
        if (nameHit(raw, a) && hit.indexOf(c) < 0) hit.push(c);
      });
      // 判据 B：调用形态候选（与 registry 无关，用来算差集①）
      const inv = invocationNames(raw);
      inv.forEach((n) => {
        if (names.indexOf(n) >= 0) return;
        if (!docOnlyMap.has(n)) docOnlyMap.set(n, []);
        if (docOnlyMap.get(n).indexOf(r.code) < 0) docOnlyMap.get(n).push(r.code);
      });
      hit.sort();
      hit.forEach((n) => mentioned.add(n));
      return Object.assign({}, r, { commands: hit, invocation: inv });
    });

    // 差集①：名册的"调用形态"提到、registry 里没有（码点序；行号按名册顺序）
    const docOnly = Array.from(docOnlyMap.keys()).sort().map((name) => ({ name, codes: docOnlyMap.get(name) }));
    // 差集②：registry 有、名册里**任何一行**都没提到（码点序）
    const unmentioned = names.filter((n) => !mentioned.has(n)).sort();
    return {
      ok: true,
      sectionLine: parsed.sectionLine,
      sectionTitle: parsed.sectionTitle,
      headerLine: parsed.headerLine,
      columns: parsed.columns,
      rows,
      docOnly,
      unmentioned,
      registryTotal: names.length,
      mentionedCount: names.length - unmentioned.length
    };
  }

  /** 联合检索的**三处**（唯一一处定义；`--grep` 的报文与 `--json` 的 `searchedIn` 都读它）。
   *  ⚠️ 只搜这三处，**不搜** `一句话` / `备注` / `为什么这么叫` —— 那三列里出现一个词
   *  不等于"这个功能叫这个名字"（搜 `at` 会命中一大片）。 */
  const SEARCH_SURFACES = [
    { key: 'code', label: '代号' },
    { key: 'name', label: '中文名' },
    { key: 'commands', label: '该行提到的 CLI 命令名' }
  ];

  /** 一行在哪个面上命中了（给文本档的「命中处」列；也是"三向互查判别力"的可见读数） */
  function matchSurfaces(row, word) {
    const w = String(word === undefined || word === null ? '' : word).toLowerCase();
    const out = [];
    if (String(row.code).toLowerCase().indexOf(w) >= 0) out.push(SEARCH_SURFACES[0].key);
    if (String(row.name).toLowerCase().indexOf(w) >= 0) out.push(SEARCH_SURFACES[1].key);
    if ((row.commands || []).some((c) => String(c).toLowerCase().indexOf(w) >= 0)) out.push(SEARCH_SURFACES[2].key);
    return out;
  }

  /** `--grep`：三处**联合**子串检索（大小写不敏感；中文不受影响）。空词 ⇒ 不命中任何行（由命令层拦成报错） */
  function searchRows(rows, word) {
    if (word === undefined || word === null || String(word) === '') return [];
    return (rows || []).filter((r) => matchSurfaces(r, word).length > 0);
  }

  /** `--code`：按代号精确取一行（大小写不敏感 —— `dm` 与 `DM` 指同一件事，别让调用方猜大小写） */
  function findByCode(rows, code) {
    const want = String(code === undefined || code === null ? '' : code).trim().toLowerCase();
    if (!want) return null;
    return (rows || []).filter((r) => String(r.code).toLowerCase() === want)[0] || null;
  }

  return {
    parseRoster,
    buildModel,
    nameHit,
    invocationNames,
    splitCells,
    splitStatus,
    ledgerOf,
    SEARCH_SURFACES,
    matchSurfaces,
    searchRows,
    findByCode,
    COLUMNS,
    STATUS_VALUES
  };
});
