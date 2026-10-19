/* ============================================================
 * src/dsh-capabilities.js — DSH 能力边界（纯逻辑：解析装配清单 + 合成模型）
 * ------------------------------------------------------------
 * 为什么存在：`docs/EXTENSIONS.md` 写着「**AI 就是扩展机制**：长尾需求由 AI 组合现有原子能力
 * 动态完成」。这条哲学成立的前提是**知道原子能力有哪些** —— 否则会去为"其实已经有"的能力
 * 写新命令、装新插件、引新依赖。**这是唯一直接防"新增成本"的机制。**
 *
 * 已发生的真实误判：外部复核报告把 DSH 已经具备的 3 项能力判为"不具备"
 * （见 `10-信息文档` §5.5：能力表 12 行错 4 行）。成因是**取证来源是 README，而不是运行时装配**。
 *
 * ⇒ 本模块只读**两个机械来源**，两者都不可被文字误导：
 *   ① **装配文件**（`cordis.patch.yml` / `presets/*.patch.yml`）—— 到底挂了什么；
 *   ② **磁盘包目录**（`node_modules/@deepseek-ai/`）—— 发行包里到底有什么。
 *
 * 由此得到三轴事实，缺一不可（**混淆任意两轴都会得出错误结论**）：
 *
 *   | 磁盘 | 被挂载 | 正确结论 |
 *   |------|--------|---------|
 *   | ✓ | ✓ 启用 | **当前可用** |
 *   | ✓ | 只在某层 `disabled: true` | **该层不用，但别处可能重挂**（见下） |
 *   | ✓ | `disabled` 是**表达式** | **未知**（运行期决定；本模块不求值、不猜） |
 *   | ✓ | 未被任何层挂载 | **存在但当前装配未启用**（可 profile 切换或 patch 挂载） |
 *   | ✗ | — | **不具备** |
 *
 * **最容易误判的两条规则（本模块存在的核心理由）**：
 *   1. host 平面（base / web）里 `disabled: true` **≠ 不可用** —— agent preset 会把同一 id 重挂；
 *   2. 装配文件里**没有** ≠ **不具备** —— 包可能就躺在磁盘上（例：`dsh-schedule`、
 *      `dsh-mcp-client` 在这 13 个装配文件里一个都没出现，但包都在磁盘上）。
 *
 * ============================================================
 * ⚠️ **本模块声明自己的能力面（这一节是本文件最要紧的一节）**
 * ============================================================
 * 实现约束：**不引 YAML 解析**（工程零新依赖）。这条**不是**因为"装配面是扁平的" ——
 * 实测它**是嵌套的**（现算读数：13 个装配文件共 375 行 `- id:`，其中只有 40 行在文件顶层，
 * 230 行在 `- insert:` 列表里、105 行在某个 entry 的 `config.plugins[]` 列表里）。
 * ⇒ **把嵌套当噪声、只认顶层行，会漏掉 89% 的能力面** —— 那不是"语义正确"，是反向误判。
 *
 * 按行解析真正依赖的是**另外两条前提**（两条都由 `tests/dsh-capabilities.test.js`
 * 用**真实文件**断言，前提一旦失效那里先红）：
 *   ① **每个 `name:` / `disabled:` / `group:` / `config:` 键都落在它自己那一行 +2 缩进**。
 *      —— 按"任意缩进"读会**张冠李戴**（把 `config:` 里的 `name:` 当成这一行的包名）。
 *   ② **每个 `- id:` 行的容器只可能是本模块声明的三类之一**（见 `CONTAINERS`）：
 *      · `root`   = 文件顶层列表（patch 行：只给 id 不给 name ⇒ 按 id 覆盖上游同名行）；
 *      · `insert` = `- insert:` 列表的子项（patch 要插入的新条目）；
 *      · `config-list` = **接条目列表的插件**的 `config.plugins[]` 子项 —— 只有
 *        `cordis:group`（合成分组）与 `@deepseek-ai/dsh-agent-preset`（preset 声明）这两个
 *        `name` 的 config 列表是**条目**，其余插件的 config 列表是**数据**。
 *   凡落不到这三类的行 ⇒ **不进能力面**，且**在报告里逐个点名**（`undeclared`，不许静默丢）。
 *
 * **`disabled` 不是布尔**（现算：52 字面 `true` / 0 字面 `false` / 26 表达式 / 297 未声明）⇒
 * 一律三态 `literal-true` / `literal-false` / `expr`，见 `disabledStateOf`。
 * `expr`（`disabled: !!js …`）**不求值、不猜**：`disabled` 为 `null`（**未知**），报告里单独点名，
 * 既不计入 disabled、也**不**当作启用。运行期口径的唯一来源是运行期自己
 * （出处见 `scripts/dsh-assembly-probe.js` 文件头「它明确不回答什么」）。
 *
 * ------------------------------------------------------------
 * ⚠️ **第三条前提（2026-10-19 补，原本是个静默缺口）**：**纯 id 覆盖行也要落到包上**
 * ------------------------------------------------------------
 * 有一类行**只有 id、没有 `name`**：`- id: compaction-basic` + `disabled: true`
 * （patch 语义：按 id 覆盖上游那一行）。**原实现只按「带 `name:` 的行」归属包**
 * ⇒ 这类行的 `disabled` **一行都没进 `packages[].layers`**（不是读成 `false`，是**整条记录消失**）。
 * 实测：13 个装配文件里这样的行 **40 行**（其中 **33 行**自己声明了 `disabled`），
 * 全在 host 层 —— `dsh-web-app` 一层就 **24 行**。后果不是"少几个数"：
 * `dsh-compaction-basic` / `dsh-agent-instructions` 在 **`dsh-web-app` 层 `disabled: true`**
 * 这件事在输出里**完全看不到**，而读这个报告的人（AI 或人）会据此认为"该能力在 host 层是启用的"
 * —— 它其实被关着，只是 preset 又把它挂回来了。**这正是本模块存在理由的反面。**
 *
 * 现在按**装配序列**归属（`assemblySequenceOf`）：纯 id 行没有包名 ⇒ 沿
 * `dsh-base` → 载体包 → 本层 找到**该 id 的 `name:` 声明行**，那个声明行的包就是它该落的包。
 * **推导唯一性（现算，不是假设）**：216 个有 `name` 声明的 id，**没有一个**被 ≥2 个不同包声明过；
 * 40 行纯 id 行在三种口径（只看本层之前 / 整层 / 全仓 13 文件不分层序）下**读数完全相同**（40/40 唯一）。
 * ⇒ 真实装配面上这条推导**唯一**，不需要猜。
 * **但"现在唯一"不等于"永远唯一"**：`packageOfRow` 在 `no-declaration` / `ambiguous` 两种情形下
 * **返回 `pkg:null` 并给出全部候选**，`buildModel` 记进 `idUnresolved`、报告里**逐行点名**，
 * **不猜一个候选**（与 `expr` 三态同一条纪律）。若要它变红，删掉的是 `idUnresolved` 的**渲染**，
 * 不是这条判断。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDshCapabilities = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** `- id:` 起一行。`(\s*)` 是这一行的缩进 —— 后面所有键都按它算"自己那一级"。 */
  const ROW_RE = /^(\s*)- id:\s*(\S.*?)\s*$/;
  /** `- insert:` 是一个**列表容器**（不是 entry）。 */
  const INSERT_RE = /^(\s*)- insert:\s*$/;
  /** 该行自己那一级的块键（有值的不算：`config:` 无值才是块键）。 */
  const KEY_RE = /^(\s*)([A-Za-z_][\w.-]*):\s*$/;
  /** 同一行的键（`name` / `disabled` / `group` / `config` / `inject`），按缩进判归属。 */
  const OWN_KEY_RE = /^(\s*)(name|disabled|group|config|inject):\s*(.*?)\s*$/;

  /**
   * 本模块声明的三类容器（**判据写在代码里，不写在散文里**）。
   * `undeclared` 不在其中 —— 那种行不进能力面，且在报告里被点名。
   */
  const CONTAINERS = ['root', 'insert', 'config-list'];

  /**
   * `config.plugins[]` 真是**条目列表**的插件名。其余插件的 `config` 列表是**数据**，
   * 把里面的 `- id:` 当挂载会多算（`undeclared` 挡的就是这一类）。
   */
  const ENTRY_LIST_HOLDERS = ['cordis:group', '@deepseek-ai/dsh-agent-preset'];

  /** `disabled` 原值 → 三态（纯函数；`null` = 没写这个键 → `absent`）。与探针同一口径。 */
  function disabledStateOf(raw) {
    if (raw === null || raw === undefined) return 'absent';
    const s = String(raw).trim();
    if (s === 'true') return 'literal-true';
    if (s === 'false') return 'literal-false';
    return 'expr';
  }

  /** 三态 → 报告文案（**expr 只说"运行期决定"，绝不给真假**） */
  function disabledLabel(state) {
    switch (state) {
      case 'literal-true': return 'disabled（字面 true）';
      case 'literal-false': return '启用（字面 false）';
      case 'expr': return '**未知**（表达式，运行期决定）';
      default: return '启用（未声明 ⇒ 默认启用）';
    }
  }

  /**
   * 解析一个装配文件里的「挂载行」。**按行解析，但按缩进算归属**。
   * 每行是 `- id: <id>`，其后的 `name:` / `disabled:` / `group:` 只认**该行自己那一级**
   * （缩进 = 行缩进 + 2）。`name` 可以为 null —— 那表示这一行**按 id 覆盖**上游同名行（patch 语义）；
   * **它该落到哪个包不由本函数决定**，见 `packageOfRow`（沿装配序列找同 id 的 `name:` 声明行）。
   * @param {string} text
   * @returns {Array<{id:string, line:number, indent:number, depth:number, container:string,
   *   inFace:boolean, name:string|null, group:boolean,
   *   disabled:boolean|null, disabledState:'literal-true'|'literal-false'|'expr'|'absent',
   *   disabledRaw:string|null}>}
   *   `depth` = **祖先 entry 数**（`- insert:` 列表的子项 depth=0，不是 1）；
   *   `container` ∈ `root` / `insert` / `config-list` / `undeclared`；
   *   `disabled` = `true`（字面 true）/ `false`（字面 false 或未声明）/ `null`（表达式 ⇒ **未知**）。
   */
  function parseMountRows(text) {
    const lines = String(text === undefined || text === null ? '' : text).split('\n');
    const rows = [];
    const stack = [];   // 打开的容器块：[{indent, kind:'entry'|'insert'|'key', key, row}]
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 空行与整行注释**不是结构**：它们不关任何块（否则一个行内空行就把容器栈清空 —— 实测踩过）
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed === '' || trimmed.replace(/^\s+/, '').charAt(0) === '#') continue;
      const indent = /^\s*/.exec(line)[0].length;
      const m = ROW_RE.exec(line);
      // 先把"缩进 >= 本行"的块全部关掉 —— 归属只看**还在打开**的容器
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

      if (m) {
        const top = stack.length ? stack[stack.length - 1] : null;
        let container;
        if (!top) container = indent === 0 ? 'root' : 'undeclared';
        else if (top.kind === 'insert') container = 'insert';
        else if (top.kind === 'key') {
          // 最近的祖先 entry 决定"这个 config 列表装的是条目还是数据"
          let holder = null;
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].kind === 'entry') { holder = stack[s].row.name; break; }
          }
          container = (holder !== null && ENTRY_LIST_HOLDERS.indexOf(holder) >= 0)
            ? 'config-list' : 'undeclared';
        } else container = 'undeclared';   // 直接在另一 entry 的键下面 ⇒ 不是条目

        const depth = stack.filter((s) => s.kind === 'entry').length;
        cur = {
          id: m[2].replace(/^['"]|['"]$/g, ''),
          line: i + 1, indent, depth,
          container, inFace: CONTAINERS.indexOf(container) >= 0,
          name: null, group: false,
          disabled: false, disabledState: 'absent', disabledRaw: null
        };
        rows.push(cur);
        stack.push({ indent, kind: 'entry', key: null, row: cur });
        continue;
      }

      if (INSERT_RE.test(line)) { stack.push({ indent, kind: 'insert', key: '- insert', row: null }); continue; }
      const k = KEY_RE.exec(line);
      if (k) { stack.push({ indent, kind: 'key', key: k[2], row: null }); continue; }
      if (/^\s*- \S/.test(line)) { stack.push({ indent, kind: 'key', key: '(其它列表项)', row: null }); continue; }

      if (!cur) continue;
      const own = cur.indent + 2;                       // ★ 只认该行自己那一级
      const o = OWN_KEY_RE.exec(line);
      if (!o || o[1].length !== own) continue;          // 更深 / 更浅的键都不属于这一行
      if (o[2] === 'name' && cur.name === null) { cur.name = o[3].replace(/^['"]|['"]$/g, ''); continue; }
      if (o[2] === 'disabled' && cur.disabledRaw === null) {
        cur.disabledRaw = o[3];
        cur.disabledState = disabledStateOf(o[3]);
        cur.disabled = cur.disabledState === 'literal-true' ? true
          : cur.disabledState === 'literal-false' ? false : null;   // expr ⇒ null（未知）
        continue;
      }
      if (o[2] === 'group' && o[3] === 'true') cur.group = true;
    }
    return rows;
  }

  /**
   * 归一化包名。实测两个来源的写法不同，**不归一化就会全错**：
   *   · 装配文件里写全名：`@deepseek-ai/dsh-tool-goal`
   *   · 磁盘目录只叫短名：`dsh-tool-goal`（因为都在 `node_modules/@deepseek-ai/` 下）
   * 子路径导出（`@deepseek-ai/dsh-headless/startup`）取第一段。
   */
  function shortName(name) {
    return String(name).replace(/^@deepseek-ai\//, '').split('/')[0];
  }

  /** 同层内多行同一包时的合并：**启用 > 未知 > 禁用**（有一行启用 ⇒ 这个包在该层可用） */
  function mergeDisabled(a, b) {
    if (a === false || b === false) return false;
    if (a === null || b === null) return null;
    return true;
  }

  /**
   * preset 层名 `preset:<载体>/<名字>` ⇒ **载体包**短名；不是 preset 层 ⇒ `null`。
   * 载体 = 那个「把 preset 文件一起发出来」的包（实测只有 `dsh-web-app`）。
   * ⚠️ 这条正则**全工程只在这里一处**：`cli/commands/release.js` 的 `findRemounts` 用它取载体包，
   * 不再自己写一遍 `/^preset:([^/]+)\//`（H1：同一个推导不许有两个实现）。
   */
  function presetCarrierOf(layerName) {
    const m = /^preset:([^/]+)\//.exec(String(layerName));
    return m ? m[1] : null;
  }

  /**
   * 装配序列：一条 patch 链上「后声明者覆盖先声明者」的顺序。
   * **纯 id 覆盖行**（`- id: X` + `disabled: …`，**不带 `name`**）就是靠它找到自己该落到哪个包 ——
   * 它自己没有包名，只能沿序列找到**该 id 的 `name:` 声明行**。
   *   · host 层 `L`：`dsh-base` → `L`（`L` 就是 `dsh-base` 时只有它自己）
   *   · preset 层 `preset:<载体>/<名字>`：`dsh-base` → `<载体>` → 本层
   * `dsh-base` 打头是装配事实（每套 bundle 都以它为核心、overlay 层按 id 覆盖它），
   * 而不是按层名排序猜出来的 —— 见 `tests/dsh-capabilities.test.js` 对真实文件那条序列断言。
   * ⚠️ **本层自己永远在序列里**（同一份 patch 文件内的 `- id:` 行可以互相按 id 覆盖；实测"只看本行之前"
   * 与"整层都算"在真实 13 个装配文件上**读数完全相同**，取更简单的整层口径）。
   * @param {{layer:string, kind:string, carrier?:string}} layer
   * @returns {string[]} 层名序列（由先到后，含本层）
   */
  function assemblySequenceOf(layer) {
    const name = String(layer.layer);
    let carrier = null;
    if (layer.kind === 'preset') carrier = presetCarrierOf(name) || layer.carrier || null;
    else carrier = name;
    const seq = ['dsh-base'];
    if (carrier && carrier !== 'dsh-base') seq.push(carrier);
    if (seq.indexOf(name) < 0) seq.push(name);
    return seq;
  }

  /**
   * `id → 该 id 的**声明行**` 索引。只收**带 `name` 且不是合成分组**的行 ——
   * 那才是真正"把一个包挂上去"的行；纯 id 覆盖行靠它反查归属。
   * @returns {Map<string, Array<{layer:string, line:number, name:string, pkg:string}>>}
   */
  function buildDeclarationIndex(layers) {
    const idx = new Map();
    for (const l of layers || []) {
      for (const r of parseMountRows(l.text)) {
        if (!r.inFace || !r.name || r.name.indexOf(':') >= 0) continue;
        if (!idx.has(r.id)) idx.set(r.id, []);
        idx.get(r.id).push({ layer: String(l.layer), line: r.line, name: r.name, pkg: shortName(r.name) });
      }
    }
    return idx;
  }

  /**
   * 一行 `- id:` 该落到哪个包 —— **这个判断只在本模块一处**（`buildModel` 唯一的归属入口）。
   * @param {object} row parseMountRows 的一行（须 `inFace`）
   * @param {string[]} seq 该行所属层的 `assemblySequenceOf`
   * @param {Map} declIndex `buildDeclarationIndex` 的产物
   * @returns {{pkg:string|null, how:'name'|'id-override'|'group'|'no-declaration'|'ambiguous',
   *   candidates:Array<{layer:string, line:number, name:string, pkg:string}>}}
   *   `how='name'` ⇒ 行自带包名（**不查索引**）；`'group'` ⇒ 合成分组，不是包；
   *   `'id-override'` ⇒ 纯 id 覆盖行在序列里找到**唯一**声明；`'no-declaration'` / `'ambiguous'`
   *   ⇒ **解析不出唯一的包，`pkg=null`（不许猜）**，由 `buildModel` 记进 `idUnresolved` 并逐个点名。
   */
  function packageOfRow(row, seq, declIndex) {
    if (row.name) {
      if (row.name.indexOf(':') >= 0) return { pkg: null, how: 'group', candidates: [] };
      return { pkg: shortName(row.name), how: 'name', candidates: [] };
    }
    const all = (declIndex && declIndex.get(row.id)) || [];
    // 只认**落在本层装配序列里**的声明：另一个并行的 host bundle 里同名 id 的声明与本行无关
    const cands = all.filter((c) => seq.indexOf(c.layer) >= 0);
    const pkgs = [];
    for (const c of cands) if (pkgs.indexOf(c.pkg) < 0) pkgs.push(c.pkg);
    if (pkgs.length === 1) return { pkg: pkgs[0], how: 'id-override', candidates: cands };
    return { pkg: null, how: pkgs.length ? 'ambiguous' : 'no-declaration', candidates: cands };
  }

  /**
   * 合成能力边界模型。
   * @param {{layers:Array<{layer:string, kind:string, text:string, carrier?:string}>, diskPackages:string[]}} input
   *   `kind`: `host`（host bundle，并列的几套）或 `preset`（agent 平面）
   */
  function buildModel(input) {
    const layers = [];
    const packageLayers = new Map(); // 短名 → [{layer, disabled}]
    const groups = [];               // 形如 `cordis:group` 的**合成分组**，不是包（去重记）
    const undeclared = [];           // 容器落不到声明三类的行 —— **不在能力面内**，逐个点名
    const exprRows = [];             // `disabled` 是表达式的行 —— 启用状态**未知**
    const idUnresolved = [];         // 纯 id 覆盖行**解析不到唯一的包** ⇒ 不许猜，逐个点名
    const containers = {};           // 容器分类计数（现算，供报告印出"面到底长什么样"）
    for (const c of CONTAINERS.concat(['undeclared'])) containers[c] = 0;
    const declIndex = buildDeclarationIndex(input.layers);

    for (const l of input.layers || []) {
      const rows = parseMountRows(l.text);
      const inFace = rows.filter((r) => r.inFace);
      const outside = rows.filter((r) => !r.inFace);
      const named = inFace.filter((r) => r.name);
      const seq = assemblySequenceOf(l);
      const stat = {
        layer: l.layer,
        kind: l.kind,
        rows: inFace.length,
        withName: named.length,
        overridesById: inFace.length - named.length, // 只给 id 不给 name ⇒ 覆盖上游同名行
        disabled: inFace.filter((r) => r.disabledState === 'literal-true').length,
        disabledExpr: inFace.filter((r) => r.disabledState === 'expr').length,
        /** 按 id 覆盖行里**成功落到某个包**的行数（≤ `overridesById`；差额 = `idUnresolved` 里属于本层的） */
        resolvedById: 0,
        /** 不在能力面内的行数（容器没落在声明三类里）—— 非 0 就是"判定可能不完整" */
        undeclared: outside.length
      };
      layers.push(stat);
      for (const r of rows) containers[r.container] += 1;
      for (const r of outside) undeclared.push({ layer: l.layer, id: r.id, line: r.line, container: r.container });
      for (const r of inFace) {
        if (r.disabledState === 'expr') exprRows.push({ layer: l.layer, id: r.id, line: r.line, raw: r.disabledRaw });
      }
      for (const r of inFace) {
        const res = packageOfRow(r, seq, declIndex);
        if (res.how === 'group') {                       // 合成分组（`cordis:group`），非包
          if (groups.indexOf(r.name) < 0) groups.push(r.name);
          continue;
        }
        if (!res.pkg) {                                  // **解析不出唯一的包 ⇒ 不猜**，点名
          idUnresolved.push({
            layer: l.layer, id: r.id, line: r.line, reason: res.how,
            disabledState: r.disabledState, candidates: res.candidates
          });
          continue;
        }
        const viaId = res.how === 'id-override';
        if (viaId) stat.resolvedById += 1;
        if (!packageLayers.has(res.pkg)) packageLayers.set(res.pkg, []);
        // 同一层内同一包可能多行（不同 id），去重按"层 + 启用状态"记（三态合并）
        const list = packageLayers.get(res.pkg);
        const hit = list.filter((x) => x.layer === l.layer)[0];
        if (!hit) {
          // 纯 id 覆盖行**没写 `disabled`** ⇒ 它不是一次"挂载"、也不声明启用：只登记"碰过这一层"。
          // ⚠️ 不能把它当 `disabled: false` 参与合并 —— 那会把同层另一行的 `disabled: true` 静默抹成"启用"。
          list.push({ layer: l.layer, disabled: viaId && r.disabledState === 'absent' ? false : r.disabled });
        } else if (!viaId || r.disabledState !== 'absent') {
          hit.disabled = mergeDisabled(hit.disabled, r.disabled);
        }
      }
    }
    const disk = (input.diskPackages || []).slice().sort();
    const diskSet = new Set(disk);
    const mounted = [...packageLayers.keys()].sort();
    const idOverrideRows = layers.reduce((a, l) => a + l.overridesById, 0);
    return {
      layers,
      diskCount: disk.length,
      mounted,
      /** 在磁盘上、但**没有被任何装配层挂载** —— "存在但当前未启用" */
      unmounted: disk.filter((p) => !packageLayers.has(p)),
      /** 被挂载了、但**不在磁盘包目录**里（装配点名了不存在的包 ⇒ 值得警惕） */
      missingOnDisk: mounted.filter((p) => !diskSet.has(p)),
      groups,
      packageLayers,
      /** 容器分类计数：`{root, insert, 'config-list', undeclared}`（现算，不是声明） */
      containers,
      /** 容器落不到声明三类的行 —— **不在能力面内**，`renderReport` 逐个点名 */
      undeclared,
      /** `disabled` 是表达式的行 —— 启用状态**未知**，`renderReport` 逐个点名 */
      exprRows,
      /** 纯 id 覆盖行（`- id: X` 不带 `name`）总数，以及其中**进了包归属**的行数 */
      idOverrideRows,
      idResolvedRows: layers.reduce((a, l) => a + l.resolvedById, 0),
      /** 纯 id 覆盖行里**解析不到唯一的包**的（无声明 / 多候选）—— **不猜**，`renderReport` 逐个点名 */
      idUnresolved
    };
  }

  /** 一个包在各层的状态：`启用` / `disabled` / `未知(expr)` / `未出现` */
  function statusOf(model, pkg) {
    const hits = model.packageLayers.get(pkg);
    return {
      pkg,
      onDisk: model.unmounted.indexOf(pkg) >= 0 || !!hits,
      layers: hits || []
    };
  }

  const pad = (s, n) => String(s).padEnd(n);

  /** 层内一个包的启用状态 → 报告文案（`--grep` 与逐层表共用一处口径） */
  function stateLabel(disabled) {
    if (disabled === true) return '(disabled)';
    if (disabled === null) return '(**未知**:表达式,运行期决定)';
    return '';
  }

  /**
   * 渲染文本报告。
   * @param {object} model buildModel 的产物
   * @param {{grep?:string, unmounted?:boolean, layer?:string}} [opts]
   */
  function renderReport(model, opts) {
    const o = opts || {};
    const out = [];
    const rowsTotal = CONTAINERS.concat(['undeclared']).reduce((a, c) => a + model.containers[c], 0);
    out.push('DSH 能力边界（来源：vendor/dsh 的装配清单 + 磁盘包目录，均为机械读取）');
    out.push('');
    out.push('⚠️ 四条容易误判的规则：');
    out.push('   1. host 平面里 disabled: true **≠ 不可用** —— agent preset 会把同一 id 重挂');
    out.push('   2. 装配文件里**没有** ≠ **不具备** —— 包可能就在磁盘上（未挂载：可换 profile 或 patch 挂载）');
    out.push('   3. 磁盘上**有** ≠ 当前可用 —— 未被挂载的包在当前 profile 里不生效');
    const hosts = model.layers.filter((l) => l.kind === 'host');
    out.push('   4. **host bundle 是并列的、不是叠加的** —— 本机有 ' + hosts.length + ' 套（见下表 kind=host）。'
      + '`--profile X` 选其中一套；**在 web 平面看不到某能力，不等于不能做那件事** —— 它可能走另一套 bundle');
    out.push('');
    // ---- 观察面：装配面**不是扁平的**，这里把现算的形状印出来（别让人以为只有顶层行） ----
    out.push('观察面（现算：' + rowsTotal + ' 行 `- id:`）—— 本模块声明只看这三类容器：');
    out.push('   顶层列表 root        ' + String(model.containers.root).padStart(5)
      + '   （patch 行：只给 id 不给 name ⇒ 按 id 覆盖上游同名行）');
    out.push('   `- insert:` 列表     ' + String(model.containers.insert).padStart(5) + '   （patch 要插入的新条目）');
    out.push('   分组/preset 的 config.plugins[] ' + String(model.containers['config-list']).padStart(3)
      + '   （`cordis:group` 与 `@deepseek-ai/dsh-agent-preset` 的条目列表）');
    out.push('   ⇒ 装配面**是嵌套的**：只有第一部分在文件顶层，其余都在列表里；'
      + '把嵌套当噪声会漏掉绝大部分能力面。');
    if (model.undeclared.length) {
      out.push('');
      out.push('⚠️ **有 ' + model.undeclared.length + ' 行的容器落不到上面三类里 ⇒ 这些行不在能力面内，'
        + '本报告的挂载集不含它们 —— 判定可能不完整**（逐个点名）：');
      for (const u of model.undeclared) {
        out.push('   · ' + u.layer + ':' + u.line + '  ' + u.id + '（容器 ' + u.container + '）');
      }
      out.push('   ⇒ 若它们其实是条目，请扩 `CONTAINERS` / `ENTRY_LIST_HOLDERS`（`src/dsh-capabilities.js`），');
      out.push('     不要把这条警告改小。');
    } else {
      out.push('   落不到这三类的行：**0**（本次装配面全在声明面内 —— 这条是现算，不是承诺）');
    }
    out.push('');
    out.push('装配层（host bundle 与 agent preset 是两种东西，分开看）：');
    out.push('   类别   层                                  行数  有 name  按 id 覆盖  其中已落包  disabled  表达式');
    for (const l of model.layers) {
      out.push('   ' + pad(l.kind, 7) + pad(l.layer, 36) + pad(l.rows, 6) + pad(l.withName, 9)
        + pad(l.overridesById, 11) + pad(l.resolvedById, 12) + pad(l.disabled, 10) + l.disabledExpr);
    }
    // ---- 纯 id 覆盖行：**不带 name** 的 `- id: X` + `disabled:` 靠装配序列找到包 ----
    // 不给这段读数，`packages[].layers` 的 per-layer 禁用状态就会**静默缺一块**：
    // 那类行（实测 `dsh-web-app/cordis.patch.yml` 有 24 行）原先**一行都没落到包上**。
    if (model.idOverrideRows) {
      out.push('');
      out.push('按 id 覆盖行（`- id: X` 但**不带 `name`**）：' + model.idOverrideRows + ' 行，其中 '
        + model.idResolvedRows + ' 行已按装配序列落到包（序列：`dsh-base` → 载体包 → 本层）');
      if (model.idResolvedRows === model.idOverrideRows) {
        out.push('   ⇒ **全部落包**（这类行的 `disabled` 不再从 per-layer 面上消失）—— 这条是现算，不是承诺');
      }
    }
    if (model.idUnresolved.length) {
      out.push('');
      out.push('⚠️ **有 ' + model.idUnresolved.length + ' 行按 id 覆盖**（不带 `name`）**解析不到唯一的包** ⇒ '
        + '这些行的 `disabled` **没有**计入任何包的 per-layer 状态，**本模块不猜**（逐个点名）：');
      for (const u of model.idUnresolved) {
        const why = u.reason === 'ambiguous'
          ? '多候选：' + u.candidates.map((c) => c.pkg + '（' + c.layer + ':' + c.line + '）').join(' / ')
          : '装配序列里找不到该 id 的 `name:` 声明行';
        out.push('   · ' + u.layer + ':' + u.line + '  ' + u.id + '（`disabled` ' + u.disabledState + '）—— ' + why);
      }
      out.push('   ⇒ 这些行**确实可能改到某个包的启用状态**；要修就补上"该 id 由哪个包声明"这件事，');
      out.push('     不要把这条警告改小，也不要改成"猜一个候选"。');
    }
    out.push('');
    out.push('磁盘上的 @deepseek-ai 包：' + model.diskCount + ' 个'
      + '（已挂载 ' + model.mounted.length + ' / 未挂载 ' + model.unmounted.length + '）');
    if (model.groups.length) {
      out.push('   （另有 ' + model.groups.length + ' 处**合成分组**而非包，已排除在包统计外：'
        + model.groups.join(', ') + '）');
    }
    if (model.missingOnDisk.length) {
      out.push('   ⚠️ 装配点名但磁盘上没有的包（' + model.missingOnDisk.length + '）：'
        + model.missingOnDisk.join(', '));
    }
    if (model.exprRows.length) {
      out.push('');
      out.push('⚠️ `disabled` 是**表达式**的行（' + model.exprRows.length + ' 行）—— 本模块**不求值、不猜**：');
      out.push('   这些 id 的"当前是否启用"在本报告里是**未知**：既不计入 disabled、也**不**当作启用。');
      out.push('   要运行期答案只能问运行期自己（出处见 `scripts/dsh-assembly-probe.js` 文件头）');
      out.push('   「它明确不回答什么」那一节 —— 那里也不求值，只报运行期口径在哪取。');
      const byLayer = {};
      for (const e of model.exprRows) (byLayer[e.layer] = byLayer[e.layer] || []).push(e);
      for (const layer of Object.keys(byLayer)) {
        out.push('   · ' + layer + '：' + byLayer[layer].map((e) => e.id + '（行 ' + e.line + '）').join(', '));
      }
    }

    if (o.grep) {
      const kw = String(o.grep).toLowerCase();
      const hits = [];
      out.push('');
      out.push('按关键词「' + o.grep + '」查（**两侧都查**：装配文件 + 磁盘包目录）：');
      for (const p of model.mounted) {
        if (p.toLowerCase().indexOf(kw) < 0) continue;
        const ls = model.packageLayers.get(p)
          .map((x) => x.layer + stateLabel(x.disabled)).join(', ');
        hits.push('   ' + pad(p, 44) + '挂载于 ' + ls);
      }
      for (const p of model.unmounted) {
        if (p.toLowerCase().indexOf(kw) < 0) continue;
        hits.push('   ' + pad(p, 44) + '**磁盘上有，未被任何装配挂载**');
      }
      out.push(hits.length ? hits.join('\n') : '   （两层都没有匹配）');
      return out.join('\n');
    }

    if (o.unmounted) {
      out.push('');
      out.push('磁盘上有、但未被任何装配挂载的包（' + model.unmounted.length + ' 个）——');
      out.push('这些**存在于发行包**，只是当前 profile 没启用（可 profile 切换或 patch 挂载）：');
      for (const p of model.unmounted) out.push('   ' + p);
      return out.join('\n');
    }

    out.push('');
    out.push('提示：');
    out.push('   --grep <关键词>   查某个能力在不在、挂在哪层（两侧都查：装配 + 磁盘）');
    out.push('   --unmounted       列出"磁盘上有、但当前未挂载"的全部包');
    out.push('   --json            结构化输出（供程序消费；`layers[].undeclared` / `[].disabledExpr` 也在里面）');
    return out.join('\n');
  }

  return {
    parseMountRows, buildModel, statusOf, renderReport, shortName,
    disabledStateOf, disabledLabel, stateLabel, mergeDisabled, CONTAINERS, ENTRY_LIST_HOLDERS,
    // 纯 id 覆盖行的归属判断（H1：全工程的「一行该落到哪个包」只此一处）
    assemblySequenceOf, buildDeclarationIndex, packageOfRow, presetCarrierOf
  };
});
