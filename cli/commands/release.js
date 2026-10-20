/* ============================================================
 * cli/commands/release.js — 工程命令：docs-gen / changelog / release
 * ------------------------------------------------------------
 * docs-gen ：从 registry 重生成 docs/CLI.md（唯一文档源 = registry）
 * changelog：CHANGELOG **只读**窄查询（索引 / 关键词检索正文），不写盘、不落生成物
 * release  ：发版流程
 *   1) 读 CHANGELOG.md，把 [Unreleased] 段重命名为 vX.Y.Z
 *   2) 重建空的 [Unreleased] 段
 *   3) 更新 package.json / src/config.js / package-lock.json 版本
 *   4) 更新 README.md 版本锁（"当前版本：x.y.z" 与 build 路径）
 * 版本号计算已下沉到 src/version.js（纯函数，单测覆盖；顺带修正 --minor 不归零 patch）。
 * 约定：每次功能变更必须同步更新 CHANGELOG + README（双文档）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const version = require('../../src/version.js');
const changelogLib = require('../../src/changelog.js');
const dshCaps = require('../../src/dsh-capabilities.js');
const store = require('../../src/data-store.js');

const ROOT = path.resolve(__dirname, '..', '..');

/** 读一份**受管文档**，返回 `{file, text, version}` —— 关键是那个 `version`：
 *  它必须从**读的那一刻**带到**写的那一刻**，读写之间的任何别处写入才会被发现。
 *
 *  为什么不是"只读文本"（原先的形态）：`release` 是"读全部 → 改 → 整份覆写"，
 *  中间那段里别的会话可能已经改过 CHANGELOG（本工程常态：CHANGELOG 常驻"半暂存"状态）。
 *  只读文本时，那次改动会被**整份覆写静默抹掉**，而 CHANGELOG 是**只增**的历史资产 —— 丢的是历史。
 *  `opts.optional` ⇒ 文件不存在时不抛（生成物 `docs/CLI.md`、滚动归档新文件这两处需要）。 */
function read(rel, opts) { return store.readManagedText(path.join(ROOT, rel), opts); }

/** 写回受管文档：**本文件里唯一的写盘出口**。
 *
 *  它做三件事，且**三件都不许在这里重写**：
 *    ① 原子写（临时文件 + fsync + rename）→ `store.writeFileAtomic`（`docs/INCIDENTS.md` 派生禁令第 5 条）；
 *    ② 版本比对 → `store.versionGate`（与 `store.write` **同一份**比较逻辑；A1：只共用原语而各写一份比较不算共用）；
 *    ③ 冲突时**报出两侧指纹**并中止 → 同上。
 *  ⚠️ 这里不许出现第二段 `if (version !== …) throw`，也不许退回裸 `fs.writeFileSync`
 *     （那正是本批修掉的形态：实现违反了工程的自家禁令）。 */
function write(handle, content) {
  return store.writeManagedText(handle, content, {
    label: '受管文件「' + path.relative(ROOT, handle.file).split(path.sep).join('/') + '」',
    hint: '请重新读取该文件后再改（CHANGELOG.md 是只增的历史资产，整份覆写会丢历史）'
  });
}

/** agent 平面（preset）装配层的**发现**：`@deepseek-ai/<包>/presets/*.patch.yml`。
 *
 *  ⚠️ 这里曾是一个**恒空**的发现路径（`385767e` 实测，2026-10-19 修）：
 *    旧代码写死 `@deepseek-ai/dsh-agent-presets/presets/<name>/agent.cordis.yml` —— 两处都错：
 *      ① 包名：`dsh-agent-presets` 在发行包里**不存在**（`existsSync` = false）；
 *      ② 文件名：真实形态是**平铺的 `presets/<preset>.patch.yml`**，连子目录都没有。
 *    ⇒ `if (existsSync(...))` 恒假、**静默跳过** ⇒ `kind:'preset'` 层一次都没出现过。
 *    代价不是"少一层"：`src/dsh-capabilities.js` 的核心叙事「host 行 `disabled: true` **≠ 不可用**
 *    —— preset 会把同一 id 重挂」在读的人眼里**无法观察、无法核对**。所以：
 *    · 扫面改成 `@deepseek-ai/<包>/presets/` 下所有 `.patch.yml`（**不写死包名**，将来多一个载体也会自动进入）；
 *    · **找不到不静默** —— 返回读数，由 `dshCaps` 响亮报（见 `presetPlaneProblem`）。
 *
 *  ⚠️ 只认 **depth-1** 的包目录：`@deepseek-ai/libreoffice-kit-win32-x64/program/presets` 也存在，
 *    那是 LibreOffice 自带的、与 DSH agent preset 无关（实测读数：depth-1 命中的只有 `dsh-web-app`）。
 *
 *  @param {string} nm `.../node_modules/@deepseek-ai` 的绝对路径
 *  @returns {{layers:Array<{layer:string,kind:string,text:string}>, packages:string[],
 *    files:Array<{pkg:string,file:string}>, emptyDirs:string[], noDeclare:string[], scanned:number}}
 *    `packages` = 带 `presets/` 的包（**去重**，实测 1 个）；
 *    `files` = 真正读进来的 preset 文件（实测 4 个 ⇒ preset 层数应当 = 4）；
 *    `emptyDirs` = 有 `presets/` 却一个 `*.patch.yml` 都没有的包（**点名，不静默**）；
 *    `noDeclare` = 文件里**没有** `@deepseek-ai/dsh-agent-preset` 声明的（那不是 preset 段，值得警惕）。
 */
function discoverPresetLayers(nm) {
  const layers = [];
  const packages = [];
  const files = [];
  const emptyDirs = [];
  const noDeclare = [];
  const names = fs.readdirSync(nm).sort();
  let scanned = 0;
  for (const name of names) {
    let isDir = false;
    try { isDir = fs.statSync(path.join(nm, name)).isDirectory(); } catch (e) { isDir = false; }
    if (!isDir) continue;
    scanned++;
    const dir = path.join(nm, name, 'presets');
    if (!fs.existsSync(dir)) continue;
    packages.push(name);
    let found = [];
    try { found = fs.readdirSync(dir).filter((f) => /\.patch\.yml$/.test(f)).sort(); } catch (e) { found = []; }
    if (!found.length) { emptyDirs.push(name); continue; }
    for (const f of found) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (text.indexOf('@deepseek-ai/dsh-agent-preset') < 0) noDeclare.push(name + '/presets/' + f);
      files.push({ pkg: name, file: f });
      // 层名带载体包：不同包将来可能有同名 preset，只写 `preset:<file>` 会撞名
      layers.push({ layer: 'preset:' + name + '/' + f.replace(/\.patch\.yml$/, ''), kind: 'preset', text });
    }
  }
  return { layers, packages, files, emptyDirs, noDeclare, scanned };
}

/** preset 平面**为空**时的报错文案（有内容 ⇒ 返回 `null`）。**纯函数**，供单测直接钉住。
 *  为什么单独抽出来：这条判据的全部意义是"空的时候必须红" —— 埋在命令体里就没法被单测引入
 *  （`B6`：门禁/判据要可被单测引入，`require` 零副作用）。 */
function presetPlaneProblem(scan) {
  if (scan && scan.layers && scan.layers.length) return null;   // 有层 ⇒ 不是"空"
  return 'preset 平面为空：在 ' + (scan && scan.scanned ? scan.scanned + ' 个包里' : '运行包里')
    + '没有一个 `<包>/presets/*.patch.yml`'
    + '\n（真实形态：`@deepseek-ai/dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` —— 平铺文件、无子目录；'
    + '\n 历史缺陷：这里曾写死 `dsh-agent-presets/presets/<name>/agent.cordis.yml`，该包在发行包里不存在 ⇒ 恒空 ⇒ 静默跳过）'
    + '\n⇒ 这份报告将支撑不住「host 行 disabled:true ≠ 不可用，preset 会重挂」那条叙事，'
    + '\n  故**不出**一份 preset 平面为空的报告：先查 vendor 运行包的 `@deepseek-ai/*/presets/` 在哪。';
}

/** 找出「host 平面按 id 算 = `disabled: true`，但某个 preset 又把它挂回来」的实例 —— **两处行号**。
 *  这就是 `dsh-capabilities.js` 那条叙事**可观察**的落点：不给实例，那句话就只是一句话。
 *
 *  ⚠️ **它为什么还在 `release.js`（而不是被 `packages[].layers` 替掉）—— 实测，不是偏好**：
 *    · 本函数判的是 **per-id**（同一个 `- id:` 的**两处行号**），而 `packages[].layers` 是 **per-(包, 层)**；
 *      实测同一批数据：id 级 **20** 个实例、包级只有 **18** 个 —— 差的那 2 个不是误差，
 *      是 `tool-subagent` / `tool-subagent-fork`（同一个包 `dsh-tool-subagent`）与
 *      `tool-subagent-control` / `tool-subagent-list-agents`（同一个包 `dsh-tool-subagent-control`）
 *      被包级合并了。而"重挂"的证据恰恰是**同一 id 的两处行号**，包级给不出。
 *    · 包级还判不出「preset 侧自己也是禁用 / 未知」这一档（实测 `dsh-plugin-manager` /
 *      `dsh-tool-bash` / `dsh-tool-pwsh` / `dsh-tool-ralph` 这 4 个包就在这档里）——
 *      它们不是实例，包级看到的是"host 禁用 + preset 也出现"，会误当成实例。
 *    · ⇒ **保留**。但**共用的推导一件都不许在这文件里另写一份**（H1）：
 *      「装配序列」与「preset 层的载体包」两个推导都从 `src/dsh-capabilities.js` 取
 *      （`assemblySequenceOf` / `presetCarrierOf`）、行解析用它的 `parseMountRows`。
 *      2026-10-19 本文件曾自己写着 `const base = 'dsh-base'` + `/^preset:([^/]+)\//` 两处副本，已删。
 *
 *  口径（写在代码里，别写在散文里）：
 *   · **按 id** 配对，不按包名 —— 实测真实装配里大量禁用写成 `- id: X` + `disabled: true`
 *     （**不给 name**，按 id 覆盖上游同名行，patch 语义）；只按包名配对会把这类**全漏掉**
 *     （实测：按包名 2 个实例、按 id 24 个）。
 *   · 有效状态只沿**一条**装配序列算：`dsh-base` → preset 自己那个包。host bundle 是**并列**的
 *     （acp-app / headless / sdk-app … 是彼此替代的另一套），混着算会把另一套的禁用当成本套的（**假实例**）。
 *   · 只有**声明了** `disabled` 的行才改状态：未声明 ≠ 重置成启用（patch 合并语义）。
 *   · `disabled: !!js …`（`expr`）**不算**实例：它的真假运行期才知道，本模块不求值、不猜。
 *   · **preset 那一行自己也不能是禁用**：两边都 `disabled: true` 不是"重挂"而是"两边都关"（实测有这一档，
 *     例如 `tool-ralph`）—— 只按 id 配对会把它算进去，那是**假阳性**（本批自查抓到并修掉）。
 *  @returns {Array<{id:string, pkg:string|null, host:{layer:string,line:number,state:string},
 *    presets:Array<{layer:string,line:number}>}>}
 */
function findRemounts(layers) {
  const byLayer = new Map();
  for (const l of layers || []) byLayer.set(l.layer, l);
  // 序列起点由模块的 `assemblySequenceOf` 给出（H1：本文件**不再**写 `'dsh-base'` 字面量）。
  // 起点不在 ⇒ 无从算"有效状态"：返回空，而不是拿别的层当下限凭空算一遍。
  const anyPreset = (layers || []).filter((l) => l.kind === 'preset')[0];
  const seqRoot = anyPreset ? dshCaps.assemblySequenceOf(anyPreset)[0] : null;
  if (!seqRoot || !byLayer.has(seqRoot)) return [];
  /** 一个层里 `id → {state, line}`（只收 inFace 的行；`expr` 单独记，最终不算实例） */
  const rowsOf = (layerName) => {
    const l = byLayer.get(layerName);
    if (!l) return null;
    const map = new Map();
    for (const r of dshCaps.parseMountRows(l.text)) {
      if (!r.inFace) continue;
      const cur = map.get(r.id) || { state: 'absent', line: 0, name: null, setBy: 0 };
      if (r.name) cur.name = r.name;
      if (r.disabledState !== 'absent') { cur.state = r.disabledState; cur.line = r.line; cur.setBy = r.line; }
      map.set(r.id, cur);
    }
    return map;
  };
  const out = [];
  for (const l of layers || []) {
    if (l.kind !== 'preset') continue;
    // ⚠️ 装配序列与载体包**都从模块取**（同一判断不许两个实现）：seq 由先到后、含本层
    const seq = dshCaps.assemblySequenceOf(l);
    const pkg = dshCaps.presetCarrierOf(l.layer);
    // 有效状态：沿序列依次叠加（同一 id 后声明者覆盖先声明者），本层自己不算"host 侧"
    const eff = new Map();
    for (const ln of seq) {
      if (ln === l.layer) continue;
      const src = rowsOf(ln);
      if (!src) continue;
      for (const [id, v] of src) {
        const cur = eff.get(id) || { state: 'absent', line: 0, layer: '', name: null };
        if (v.name) cur.name = v.name;
        if (v.state !== 'absent') { cur.state = v.state; cur.line = v.line; cur.layer = ln; }
        eff.set(id, cur);
      }
    }
    for (const r of dshCaps.parseMountRows(l.text)) {
      if (!r.inFace || !r.id) continue;
      const e = eff.get(r.id);
      if (!e || e.state !== 'literal-true') continue;   // host 侧必须按 id 算 = 字面 true
      // ⚠️ **preset 这一行自己也不能是禁用**，否则那不是"重挂"、是"两边都关" ⇒ 假阳性。
      //    实测反例（本批自查抓到）：`tool-ralph` 的 host `dsh-base:446-448` 是 `disabled: true`，
      //    而 `presets/standard.patch.yml:125-127` **也**是 `disabled: true` —— 只按 id 配对会把它算成实例。
      //    这一类（preset 侧自己也禁用，或 preset 侧是 `!!js` 表达式 ⇒ 未知）实测共 6 个 id。
      if (r.disabledState === 'literal-true') continue;
      if (r.disabledState === 'expr') continue;         // preset 侧未知 ⇒ 不当证据（不求值、不猜）
      const prev = out.filter((x) => x.id === r.id && x.host.layer === e.layer && x.host.line === e.line)[0];
      const entry = { id: r.id, pkg, host: { layer: e.layer, line: e.line, state: e.state },
        presets: [{ layer: l.layer, line: r.line }] };
      if (prev) prev.presets.push(entry.presets[0]);
      else out.push(entry);
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** 渲染 docs/CLI.md 的完整内容（纯函数，不写盘）。
 *  抽出来的唯一理由：让「生成物是否已过期」可以被机械检查 ——
 *  scripts/doc-facts.js 用同一函数重渲染并与磁盘上的 CLI.md 逐字比对，
 *  一旦有人改了 registry 却忘记跑 docs-gen，verify 直接变红（原来只靠自觉）。 */
function renderCliDoc() {
  const registry = require('../registry.js');
  const cmds = registry.list();
  const lines = [];
  /** 本文件的头部元信息（§5 登记表的数据源；与 docs/*.md 里的同格式） */
  const REGISTRY_HEADER_CLI = [
    '<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）',
    '层: 契约',
    '作用: 命令参考',
    '不该写: —（**勿手改**）',
    '更新方式: `docs-gen` 生成（G7 校验）',
    '-->'
  ];
  lines.push('# CLI 参考（AI MindMap）');
  lines.push('');
  // 「文档头部元信息」由**生成器**产出（T5）：§5 登记表从各文档的这块元信息生成，
  // 生成物也必须自带，否则每次 docs-gen 都会把它抹掉、G8 立刻报「文档无元信息」。
  lines.push(...REGISTRY_HEADER_CLI);
  lines.push('');
  lines.push('> 本文件由 `node cli/mm-cli.js docs-gen` 从 cli/registry.js 自动生成。');
  lines.push('> **新增命令时修改 registry.js 后重跑 docs-gen**，勿手改本文件。');
  lines.push('');
  lines.push('## 通用');
  lines.push('');
  lines.push('- 入口：`node cli/mm-cli.js <command> [args...]`');
  lines.push('- `--json`：以 JSON 输出（供 AI / MCP 解析）');
  lines.push('- **失败：退出码非 0**（首选判据；脚本/CI 看这个），同时 stdout 输出 `error: <原因>`（文本辅助判据）');
  lines.push('- `validate` / `validate-all` 例外：输出结构化报告（`FAIL <项目>: …` 或 `--json` 的 `{ok,errors}`），同样以非 0 退出码表达失败');
  // 【I-5】`docs-gen --check --json` 也是这一档：结构化失败 + 非 0 退出码，stdout 仍是一份可解析 JSON。
  // 写进生成物的理由：它是**对调用方的承诺**（怎么读失败），不该只活在源码注释里。
  lines.push('- `docs-gen --check` 同这一档：**只比对、绝不写盘**；`--json` 给 `{ok,mismatchCount,products[]}`（键序固定、'
    + '无时间戳 ⇒ 同一状态两跑逐字节相同），失败也以**非 0 退出码**表达，stdout 仍是**一份**可解析 JSON');
  lines.push('- 项目名 = `projects/<name>/<name>.json` 的目录名');
  lines.push('');
  lines.push('## 命令一览');
  lines.push('');
  lines.push('| 命令 | 说明 |');
  lines.push('|------|------|');
  cmds.forEach((c) => {
    lines.push('| `' + c.name + '` | ' + (c.usage || c.desc) + ' |');
  });
  lines.push('');
  lines.push('## 详细用法');
  lines.push('');
  cmds.forEach((c) => {
    lines.push('### ' + c.name);
    lines.push('');
    lines.push((c.desc || '') + '');
    lines.push('');
    lines.push('```');
    lines.push('node cli/mm-cli.js ' + c.usage);
    lines.push('```');
    lines.push('');
  });
  return lines.join('\n');
}

/* ================================================================================
 * `docs-gen` 的**产物表** —— 「写盘用的生成器」与「比对用的生成器」之间**唯一**的连接点
 * --------------------------------------------------------------------------------
 * 本批（任务 `I-5`）的承重条件就在这张表上，不在别处：
 *   写盘档（`docs-gen`）与比对档（`docs-gen --check`）**都只遍历这张表、只调 `p.render()`**，
 *   而且 `render` 存的是**函数引用**（`renderCliDoc`），不是"同名的第二个实现"、也不是
 *   "两段代码碰巧输出一样" ⇒ 两个方向**不可能各自漂移**。
 *   漂移的后果不是风格问题：那等于"比对用的生成器"与"写盘用的生成器"各是一份真值，
 *   而 `G6`/`G7` 的整个存在理由就是"一份事实只写一处"。
 *   这条性质由 `tests/docs-gen-check.test.js` 直接钉住（`genProducts()[0].render === renderCliDoc`）。
 *
 * ## 为什么今天表里**只有一份**（实测，不是遗漏）
 * 本仓被当真值比、且由生成器产出的产物共 **3** 份（声明面 = `docs/ARCHITECTURE.md` §5.2，
 * 实现面 = `scripts/determinism-check.js` 的 `ARTIFACTS`）。逐个查过 `docs-gen` 的写盘点，
 * **只有 1 份**属于它：
 *   · `docs/CLI.md`（`cli-md`）       生成器 `renderCliDoc()`                     ← 本表
 *   · `docs/VERIFY.md`（`verify-md`） 生成器 `scripts/doc-facts.js --write`
 *     （它要现算 facts，**其中包含一次 vitest** ⇒ 放进来就不可能做到"廉价"）
 *   · `docs/ARCHITECTURE.md` 的 §5 登记表（`registry-table`）生成器 `scripts/docs-registry-check.js --write`
 * 后两份还各有**架构上的硬约束**：`cli/` **不许** require `scripts/`（`S1` 单向依赖：
 * `scripts` rank 3 > `cli`）⇒ 那两份的渲染函数本来就搬不进本命令。
 * ⇒ 那两份的新鲜度归 `G7`（`VERIFY.md`）与 `G8` 第 ⑬ 条（§5 表）；**本命令不假装覆盖它们** ——
 *   否则报错里的 fix 指针会骗人（"`docs-gen` 修不了它"）。
 *   将来加第二份产物时**只改这张表**：两个方向同时获得它，两边都不用改。
 * ================================================================================ */
function genProducts() {
  return [{
    file: 'docs/CLI.md',
    /** ⚠️ **函数引用**（不是同名的第二个实现）：写盘档与比对档都走它 —— 本表的承重条件 */
    render: renderCliDoc,
    /** 生成物过期时给调用方的那条命令（报错里原样打印：报错即教程） */
    fix: 'node cli/mm-cli.js docs-gen',
    /** 回显里"生成了几条"—— 从 registry **现取**，不在这里写死数字 */
    note: function () { return require('../registry.js').list().length + ' 条命令'; }
  }];
}

/** 一份文本的 sha256（报告里的**指纹**：同一状态两跑必须相同；不含路径、不含时间）。 */
function sha256Of(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * **纯函数**（无 IO ⇒ 可单测）：两份文本的**第一处差异**。
 *
 * 口径与 `G6` 的 `scripts/doc-facts.js::checkGeneratedDocs` **同一条**（按 `\n` 切分、逐行比、
 * 第一个不相等处即差异行）⇒ `docs-gen --check` 与 `doc-facts --check` 报出来的"第几行"是
 * **同一个数**，不会互相打脸（两份实现各算一套行号，是最容易悄悄分叉的那种"看起来一致"）。
 *
 * @returns {{fresh:boolean, firstDiffLine:number, diskLine:(string|null), wantLine:(string|null)}}
 *   `firstDiffLine` 是 **1 起**行号，`0` = 逐字相同；差异处一方已结束 ⇒ 该侧为 `null`（报"文件结束"）。
 */
function compareText(diskText, wantText) {
  const got = String(diskText === undefined || diskText === null ? '' : diskText).split('\n');
  const want = String(wantText === undefined || wantText === null ? '' : wantText).split('\n');
  let at = 0;
  while (at < got.length && at < want.length && got[at] === want[at]) at++;
  if (at === got.length && at === want.length) {
    return { fresh: true, firstDiffLine: 0, diskLine: null, wantLine: null };
  }
  return {
    fresh: false,
    firstDiffLine: at + 1,
    diskLine: got[at] === undefined ? null : got[at],
    wantLine: want[at] === undefined ? null : want[at]
  };
}

/**
 * **纯函数**（文本由调用方给 ⇒ 单测可用夹具，不必去改真仓）：一份产物的读数。
 *
 * 三档 `status`（`B8`：档数不得少于它要区分的状态数）：
 *   `fresh`（逐字相同）/ `stale`（有差异）/ `missing`（盘上没有这份产物）。
 * `firstDiffLine` 只在 `stale` 档是 1 起行号，其余为 `0`（0 = 没有行级差异可比，别读成"第 0 行"）。
 *
 * ⚠️ **键序是契约**（`--json` 两跑逐字节相同靠它）：新增字段请**追加在末尾**，别插在中间。
 * @param {{file:string, fix:string}} p 产物表里的一项
 * @param {string|null} diskText 盘上的文本（`null` = 文件不存在，与 `readManagedText` 的 `optional` 同口径）
 * @param {string} wantText 重算出来的全文
 */
function evaluateProduct(p, diskText, wantText) {
  const want = String(wantText);
  const row = {
    file: p.file,
    status: 'missing',
    firstDiffLine: 0,
    diskLines: 0,
    diskBytes: 0,
    diskSha256: null,
    wantLines: want.split('\n').length,
    wantBytes: Buffer.byteLength(want, 'utf8'),
    wantSha256: sha256Of(want),
    diskLine: null,
    wantLine: null,
    fix: p.fix
  };
  if (diskText === null || diskText === undefined) return row;
  const disk = String(diskText);
  const cmp = compareText(disk, want);
  row.status = cmp.fresh ? 'fresh' : 'stale';
  row.firstDiffLine = cmp.firstDiffLine;
  row.diskLines = disk.split('\n').length;
  row.diskBytes = Buffer.byteLength(disk, 'utf8');
  row.diskSha256 = sha256Of(disk);
  // 差异处的两侧整行（截 100 字，与 G6 的报错同一上限）：给人看的定位线索，也是 `--json` 的取证面
  row.diskLine = cmp.diskLine === null ? null : cmp.diskLine.slice(0, 100);
  row.wantLine = cmp.wantLine === null ? null : cmp.wantLine.slice(0, 100);
  return row;
}

/** `--json` 的报告（**键序固定**：字面量顺序即输出顺序；无时间戳、无绝对路径）。 */
function buildReport(mode, rows) {
  const bad = rows.filter((r) => r.status !== 'fresh').length;
  return {
    command: 'docs-gen',
    mode: mode,                 // 'check'（只比对）/ 'write'（已重生成）
    ok: bad === 0,
    wrote: mode === 'write',
    productCount: rows.length,
    mismatchCount: bad,
    products: rows
  };
}

/** 一份"不一致"的产物 → 报错形状**照 `G6`**（点名文件 + 第几行起 + 两侧整行 + fix 命令）。
 *  为什么照抄这个形状：两份入口（`G6` 与 `docs-gen --check`）报同一件事时，读的人不必学两套。 */
function staleMessage(row) {
  if (row.status === 'missing') {
    return '生成物缺失：' + row.file + '（请运行 `' + row.fix + '`）';
  }
  return '生成物已过期：' + row.file + '（第 ' + row.firstDiffLine + ' 行起不一致）'
    + '\n    磁盘: ' + String(row.diskLine === null ? '(文件结束)' : row.diskLine)
    + '\n    应为: ' + String(row.wantLine === null ? '(文件结束)' : row.wantLine)
    + '\n    → 运行 `' + row.fix + '` 重生成';
}

module.exports = {
  // 纯函数（无 I/O 的那部分）导出给单测：`tests/dsh-caps-preset-plane.test.js` 直接用
  // 真实 `vendor/dsh` 与**独立磁盘扫描**两条读数钉住 preset 平面的层数（照 `B6`：判据要可被单测引入）。
  discoverPresetLayers,
  presetPlaneProblem,
  findRemounts,
  // `docs-gen` 的产物表与比对判定（**纯函数/表**）：`tests/docs-gen-check.test.js` 用它钉住
  // 「写盘档与比对档共用**同一个**渲染函数」这条承重性质，以及"差异行号"的口径。
  genProducts,
  compareText,
  evaluateProduct,
  docsGen(ctx) {
    const products = genProducts();
    const rawCheck = ctx.args.check;
    /* `--check` 是**纯开关**（不带值）：`--check=false` 这类两态写法一律**响亮拒绝** ——
     * 与 `--dry-run` / `--apply` 同一条纪律。理由在两种猜法上都成立：猜"开"会把一次
     * **想写盘**的调用悄悄变成只比对（文档没更新，而调用方以为更新了）；猜"关"会把只比对
     * 变成写盘（本批最不该发生的事）。⇒ 唯一的正解是**不猜**。 */
    if (rawCheck !== undefined && rawCheck !== true) {
      ctx.error('--check 是**纯开关**（不带值）：写法 `docs-gen --check`。'
        + '要写盘就把这个开关去掉（`--check=false` 这类两态写法本工程一律**响亮拒绝**，'
        + '理由与 `--dry-run=false` 同一条：猜"开"会让一次想写盘的调用变成只比对，'
        + '猜"关"会让只比对变成写盘）。收到 ' + JSON.stringify(rawCheck));
    }
    const check = rawCheck === true;

    // ---- 比对档（`--check`）：**只读盘 + 重算，一个字节都不写** ----------------------------
    if (check) {
      const rows = products.map((p) => evaluateProduct(p, read(p.file, { optional: true }).text, p.render()));
      if (ctx.args.json) {
        ctx.outJson(buildReport('check', rows));
        // 与 `validate --json` **同一档**：结构化失败 + 非 0 退出码（stdout 仍是一份可解析 JSON）。
        if (rows.some((r) => r.status !== 'fresh')) process.exitCode = 1;
        return;
      }
      const bad = rows.filter((r) => r.status !== 'fresh');
      // 一致的那几份照样点名（"比过了"要看得见，别让"没报错"当唯一证据）
      rows.filter((r) => r.status === 'fresh').forEach((r) => {
        ctx.out('✓ 生成物与源一致：' + r.file + '（' + r.diskLines + ' 行 / ' + r.diskBytes + ' B）');
      });
      if (!bad.length) {
        ctx.out('✓ ' + rows.length + ' 份生成物全部一致 —— 本档**只比对、未写盘**'
          + '（要重生成请运行 `docs-gen`）');
        return;
      }
      // 不一致 ⇒ 全部点名（"逐个比"不是"报第一份就收工"），报错形状照 G6，exit 1
      ctx.error(bad.map(staleMessage).join('\n'));
    }

    // ---- 写盘档（默认）：同一张表、同一个渲染函数 -----------------------------------------
    // 先把 **all** 内容算出来再写：中途 render 抛出时盘上仍是完整一致的一份，不会留半更新状态。
    const rendered = products.map((p) => ({ p: p, want: p.render() }));
    rendered.forEach((it) => {
      fs.mkdirSync(path.dirname(path.join(ROOT, it.p.file)), { recursive: true });
      // 生成物也是受管资产 ⇒ 同样过闸门。读一次只为拿到"我读到的是哪一版"：
      // 生成与写回之间若有人手改过它，宁可拒绝并报出两侧指纹，也不静默抹掉。
      // `optional:true`：首次生成时文件还不存在（version=null ⇒ 闸门放行，与从前一致）。
      write(read(it.p.file, { optional: true }), it.want);
    });
    // 写后自检：写下去的内容必须与重算逐字相同（不同 = 写没生效或被别处改掉 ⇒ 响亮失败，
    // 而不是打印一句"已重生成"就完事 —— 那句回显必须是**量出来的**）。
    const rows = rendered.map((it) => evaluateProduct(it.p, read(it.p.file, { optional: true }).text, it.want));
    const bad = rows.filter((r) => r.status !== 'fresh');
    if (bad.length) ctx.error('写盘后自检失败（内容与重算不一致）：\n' + bad.map(staleMessage).join('\n'));

    if (ctx.args.json) {
      ctx.outJson(buildReport('write', rows));
      return;
    }
    rows.forEach((r, i) => {
      const p = rendered[i].p;
      ctx.out('已重生成 ' + r.file + '（' + r.diskLines + ' 行 / ' + r.diskBytes + ' B'
        + (typeof p.note === 'function' ? ' · ' + p.note() : '') + '）');
    });
  },

  // 供 scripts/doc-facts.js 做「生成物是否过期」检查（非命令）
  renderCliDoc,

  /** CHANGELOG 窄查询（**只读，不写盘**）：给出段/条目索引，或按关键词检索正文。
   *  为什么需要：见 src/changelog.js 的 indexChangelog 注释 —— CHANGELOG 只增不减、必然越来越长，
   *  而「上轮改了什么」是最常被问的问题，且 git 侧无替代入口。
   *  索引从正文**现算**，不落生成物 ⇒ 永不漂移，也不需要额外维护步骤。 */
  changelog(ctx) {
    const text = read('CHANGELOG.md').text;
    const idx = changelogLib.indexChangelog(text);
    const srcLines = text.split('\n');
    const kw = (ctx.args.grep === undefined || ctx.args.grep === true) ? null : String(ctx.args.grep);
    const full = !!ctx.args.full;
    // --limit：非法值当场报错（`--limit abc` 以前会被 `parseInt(...) || 0` 静默变成"限 0 条" = 空索引）
    const limit = ctx.intOption('limit', { min: 0, def: null });
    const kwLc = kw === null ? null : kw.toLowerCase();
    const totalEntries = idx.sections.reduce((n, s) => n + s.entries.length, 0);

    /** 取条目的正文（1 起行号 + 行数） */
    const bodyOf = (e) => srcLines.slice(e.startLine - 1, e.startLine - 1 + e.lines).join('\n');

    // 选取命中条目（无关键词 = 全选）
    const groups = [];
    let matched = 0;
    for (const sec of idx.sections) {
      const hit = sec.entries.filter((e) => kwLc === null
        || e.heading.toLowerCase().includes(kwLc)
        || bodyOf(e).toLowerCase().includes(kwLc));
      // 索引模式（无关键词）：**空段也要列**（例如刚发版后的 `[Unreleased]` 只剩占位行）——
      // 否则"本文件现在有哪些段"看不全；检索模式：无命中不列（收窄才有意义）。
      if (!hit.length && kwLc !== null) continue;
      groups.push({ sec, entries: hit });
      matched += hit.length;
    }
    // --limit：按文件顺序（新在前）截断
    if (limit !== null) {
      let left = limit;
      const trimmed = [];
      for (const g of groups) {
        if (left <= 0) break;
        const take = g.entries.slice(0, left);
        left -= take.length;
        trimmed.push({ sec: g.sec, entries: take });
      }
      groups.length = 0;
      for (const g of trimmed) groups.push(g);
    }

    // 归档检索：**主文件 + docs/changelog/ 一起搜**。
    // 补这个缺口的理由见 src/changelog.js 的 searchArchives 注释：
    // 只搜主文件时，已归档的历史查不到，用起来就像"历史丢了"。
    const archDir = path.join(ROOT, 'docs', 'changelog');
    const arch = changelogLib.searchArchives(archDir, kw);

    if (ctx.args.json) {
      ctx.outJson({
        totalLines: idx.totalLines,
        totalBytes: idx.totalBytes,
        sections: idx.sections.length,
        entries: totalEntries,
        grep: kw,
        matched,
        groups: groups.map((g) => ({
          version: g.sec.version,
          date: g.sec.date,
          heading: g.sec.heading,
          entries: g.entries.map((e) => ({ heading: e.heading, startLine: e.startLine, lines: e.lines, bytes: e.bytes }))
        })),
        archived: {
          totalHits: arch.totalHits,
          files: arch.files.map((a) => ({
            file: a.file, version: a.version, date: a.date,
            hits: a.hits.map((h) => ({ line: h.line, heading: h.heading, text: h.text }))
          }))
        }
      });
      return;
    }

    ctx.out(kw === null
      ? 'CHANGELOG 索引 — ' + idx.totalLines + ' 行 / ' + idx.totalBytes + ' B ｜ '
        + idx.sections.length + ' 段 / ' + totalEntries + ' 条目'
      : 'CHANGELOG 检索「' + kw + '」— 主文件命中 ' + matched + ' 条目 / ' + groups.length + ' 段'
        + '；归档命中 ' + arch.totalHits + ' 处 / ' + arch.files.length + ' 份'
        + (limit !== null ? '（--limit ' + limit + '）' : ''));
    if (!full) ctx.out('（--grep 关键词 检索（含归档）· 加 --full 连正文一起给 · --limit n 限条数）');
    // 归档命中逐条列出（这是"查得到历史"的关键：主文件查不到的，在这里给出行号）
    arch.files.forEach((a) => {
      ctx.out('');
      ctx.out('[归档 ' + a.version + (a.date ? ' · ' + a.date : '') + ']  docs/changelog/' + a.file
        + '  —  ' + a.hits.length + ' 处命中');
      a.hits.forEach((h) => {
        ctx.out('  L' + String(h.line).padEnd(5) + '〔' + h.heading.slice(0, 40) + '〕 ' + h.text);
      });
    });
    // 更老的版本段已滚动归档：主文件里查不到时，别以为"没发生过"，去归档目录找
    try {
      const files = fs.existsSync(archDir) ? fs.readdirSync(archDir).filter((f) => /\.md$/.test(f)) : [];
      if (files.length) {
        ctx.out('');
        ctx.out('已归档的历史版本段：docs/changelog/（' + files.length + ' 份，'
          + files.sort().join(' / ') + '）');
      }
    } catch (e) { /* 归档目录不可读不影响查询 */ }
    ctx.out('');

    for (const g of groups) {
      ctx.out(g.sec.heading + '  —  ' + g.sec.lines + ' 行 / ' + g.sec.bytes + ' B');
      for (const e of g.entries) {
        ctx.out('  L' + String(e.startLine).padEnd(5) + String(e.lines).padStart(5) + '行  '
          + String(e.bytes).padStart(7) + ' B  ' + e.heading);
        if (full) {
          ctx.out('');
          ctx.out(bodyOf(e).replace(/\s+$/, ''));
          ctx.out('');
        }
      }
      ctx.out('');
    }
  },

  /** DSH 能力边界（**只读**）：从 `vendor/dsh` 的装配清单 + 磁盘包目录**机械读取**。
   *  为什么需要：防止为"其实已经有"的能力写新命令 / 装新插件（见 `src/dsh-capabilities.js` 顶部）。
   *  两条最容易误判的规则也在那里：host 平面 `disabled: true` **≠ 不可用**；
   *  装配文件里**没有** ≠ **不具备**（包可能就在磁盘上）。 */
  dshCaps(ctx) {
    const nm = path.join(ROOT, 'vendor', 'dsh', 'app', 'node_modules', '@deepseek-ai');
    if (!fs.existsSync(nm)) {
      ctx.error('找不到 DSH 运行时包目录：' + nm
        + '\n（`vendor/dsh` 是桌面侧栏用的本地运行包、被 git 忽略；本命令依赖它，属已知边界）');
    }
    const a = ctx.args;
    if (a.grep === true) ctx.error('--grep 需要一个关键词：dsh-caps --grep 关键词');

    // ---- host 平面：凡带 cordis.patch.yml 的包（实测 **9 套并列 bundle**：dsh-base / dsh-web-app /
    //      dsh-headless / dsh-acp-app / dsh-sdk-app / dsh-sdk-minimal / dsh-experimental-* …）----
    // 自动发现而非硬编码路径 —— 将来多一个 host bundle 会自动进入统计，不会被静默漏掉。
    // （旧注释写"实测为 dsh-base 与 dsh-web-app"，早已与实测不符 —— 那是"声称与实际不是一回事"，
    //  2026-10-19 一并改准。）
    const layers = [];
    for (const name of fs.readdirSync(nm).sort()) {
      const p = path.join(nm, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) layers.push({ layer: name, kind: 'host', text: fs.readFileSync(p, 'utf8') });
    }
    // ---- agent 平面：`@deepseek-ai/*/presets/*.patch.yml`（见 `discoverPresetLayers` 头部的事故记录）----
    const presetScan = discoverPresetLayers(nm);
    layers.push(...presetScan.layers);
    // **不许静默跳过**：preset 平面为空 ⇒ 这份报告撑不住它自己的核心叙事 ⇒ 响亮报错，不出空报告
    const planeProblem = presetPlaneProblem(presetScan);
    if (planeProblem) ctx.error(planeProblem);
    if (presetScan.emptyDirs.length) {
      // 有 `presets/` 但一个 `*.patch.yml` 都没有 —— 按纪律点名（别让它静默消失）
      ctx.out('⚠️ 以下包的 `presets/` 目录里没有 `*.patch.yml`（不计入 preset 平面）：'
        + presetScan.emptyDirs.join(', '));
    }
    if (presetScan.noDeclare.length) {
      ctx.out('⚠️ 以下 preset 文件里**没有** `@deepseek-ai/dsh-agent-preset` 声明 —— 它可能不是 preset 段，'
        + '却是按"preset"计数的：' + presetScan.noDeclare.join(', '));
    }
    if (!layers.length) {
      ctx.error('在 ' + nm + ' 下没找到任何装配文件（cordis.patch.yml / presets/*.patch.yml）');
    }

    const diskPackages = fs.readdirSync(nm).filter((n) => {
      try { return fs.statSync(path.join(nm, n)).isDirectory(); } catch (e) { return false; }
    });
    const model = dshCaps.buildModel({ layers, diskPackages });
    const remounts = findRemounts(layers);

    if (a.json) {
      // Map 不能直接 stringify ⇒ 转成「包 → 各层状态」的数组
      ctx.outJson({
        layers: model.layers,
        // preset 平面的**发现读数**（层数 = 实测文件数；层数 0 ⇒ 上面已经报错退出，走不到这里）
        presets: {
          packages: presetScan.packages,
          files: presetScan.files.map((x) => x.pkg + '/presets/' + x.file),
          layerCount: presetScan.layers.length,
          emptyDirs: presetScan.emptyDirs
        },
        // 「host disabled:true 但 preset 重挂」的实例 —— 这就是 dsh-capabilities 那条叙事的可核对落点
        remountCount: remounts.length,
        remounts,
        diskCount: model.diskCount,
        mountedCount: model.mounted.length,
        unmountedCount: model.unmounted.length,
        missingOnDisk: model.missingOnDisk,
        unmounted: model.unmounted,
        packages: model.mounted.map((p) => ({ pkg: p, layers: model.packageLayers.get(p) }))
      });
      return;
    }
    ctx.out(dshCaps.renderReport(model, {
      grep: a.grep === undefined ? null : String(a.grep),
      unmounted: !!a.unmounted
    }));
    // 叙事 → 可观察：把「host 行 disabled:true，但 preset 把同一 id 挂回来」的实例连同**两处行号**印出来。
    // 不给实例，`renderReport` 顶部那条规则就只是一句话（本批修的正是"声称能做到、实测看不到"）。
    if (!a.grep && !a.unmounted) {
      ctx.out('');
      ctx.out('「host `disabled: true` 但 preset 重挂」的实例（' + remounts.length + ' 个；'
        + '口径：按 **id**、沿 `dsh-base → 载体包` 一条序列算有效状态；'
        + 'preset 那一行**自己也得是启用的**（两边都禁用不算重挂）；`expr` 不算）');
      if (!remounts.length) {
        ctx.out('   **0 个** —— 本运行包上这条叙事**不成立**（preset 平面有 ' + presetScan.layers.length
          + ' 层，但没有任何 id 是"host 禁用 + preset 挂回且自己是启用的"）⇒ 别把它当事实用，先查凭据。');
      }
      for (const r of remounts.slice(0, 12)) {
        ctx.out('   · ' + r.id + ' ⟶ host ' + r.host.layer + ':' + r.host.line
          + '（`- id:` 行，紧随 `disabled: true`）'
          + ' ／ preset ' + r.presets.map((p) => p.layer.replace(/^preset:/, '') + ':' + p.line).join(', '));
      }
      if (remounts.length > 12) {
        ctx.out('   …（共 ' + remounts.length + ' 个，`--json` 的 `remounts` 给全量）');
      }
    }
  },

  release(ctx) {
    const pkgH = read('package.json');
    const pkg = JSON.parse(pkgH.text);
    let next = ctx.args._[0];
    if (!next) {
      // 递增逻辑在 src/version.js（纯函数）：低位一律归零。
      // 历史缺陷：--minor 只加 minor 不归零 patch（0.14.3 → 0.15.3），
      // 且没有 --major。现由 bump() 统一处理并被单测锁住。
      const kind = ctx.args.major ? 'major' : (ctx.args.minor ? 'minor' : 'patch');
      next = version.bump(pkg.version || '0.0.0', kind);
      if (!next) ctx.error('package.json 的 version 非法，无法自增: ' + pkg.version);
    }
    if (!version.isValid(next)) ctx.error('版本号格式: x.y.z');
    // 防回退：把 0.15.0 发到已存在的 0.16.0 会让版本号倒退
    const cmp = version.compare(next, pkg.version || '0.0.0');
    if (cmp !== null && cmp <= 0) {
      ctx.error('新版本号必须大于当前版本 ' + pkg.version + '（否则版本倒退）');
    }

    // 1) CHANGELOG：[Unreleased] → [vX.Y.Z]（变换在 src/changelog.js，纯函数、有单测）
    //    ⚠️ `clH` 是**读的那一刻**的句柄：写回时把它的 version 交给闸门。这是本命令最关键的一处 ——
    //    CHANGELOG 只增不减，整份覆写丢掉的是历史。
    const clH = read('CHANGELOG.md');
    let changelog = clH.text;
    try {
      changelog = changelogLib.releaseChangelog(changelog, next, new Date().toISOString().slice(0, 10));
    } catch (err) {
      ctx.error((err && err.message) || err);
    }
    // 1b) 滚动归档：主文件只留最近 KEEP_RELEASED_SECTIONS 个已发版本段，
    //     更老的整段移入 docs/changelog/<版本>.md（只增不改，G6 不扫、G8 前缀放行）。
    //     放在发版流程里 ⇒ 不新增需要人记住的步骤（滚动的唯一触发点）。
    let archivedCount = 0;
    try {
      const split = changelogLib.splitChangelog(changelog, changelogLib.KEEP_RELEASED_SECTIONS);
      split.archived.forEach((a) => {
        const rel = 'docs/changelog/' + a.version + '.md';
        fs.mkdirSync(path.join(ROOT, 'docs', 'changelog'), { recursive: true });
        // optional：归档文件通常还不存在（version=null ⇒ 闸门放行）；已存在时则真的比对，
        // 免得同一版本段被两次发版写成不同内容而没人发现。
        write(read(rel, { optional: true }), changelogLib.renderArchiveFile(a, changelogLib.KEEP_RELEASED_SECTIONS));
        archivedCount++;
      });
      changelog = split.main;
    } catch (err) {
      ctx.error('滚动归档失败：' + ((err && err.message) || err));
    }
    write(clH, changelog);

    // 2) package.json version + src/config.js APP_VERSION + package-lock.json
    //    版本号单源：这三处必须一致，否则运行时（渲染层/CLI init 写 meta.version）
    //    与打包产物版本会互相矛盾。
    pkg.version = next;
    write(pkgH, JSON.stringify(pkg, null, 2) + '\n');

    const cfgH = read('src/config.js');
    const cfgNext = cfgH.text.replace(/APP_VERSION:\s*'[^']*'/, "APP_VERSION: '" + next + "'");
    if (cfgNext === cfgH.text) ctx.error('src/config.js 未找到 APP_VERSION 字段，无法同步版本号');
    write(cfgH, cfgNext);

    // package-lock.json 的顶层与 packages[""] 两处 version
    let lockH = null;
    let lock = null;
    try { lockH = read('package-lock.json'); lock = JSON.parse(lockH.text); } catch (e) { lock = null; lockH = null; }
    if (lock) {
      lock.version = next;
      if (lock.packages && lock.packages['']) lock.packages[''].version = next;
      write(lockH, JSON.stringify(lock, null, 2) + '\n');
    }

    // 3) README 版本锁
    const readmeH = read('README.md');
    let readme = readmeH.text;
    readme = readme.replace(/当前版本：[\d.]+/g, '当前版本：' + next);
    readme = readme.replace(/AIMindMap-[\d.]+-setup\.exe/g, 'AIMindMap-' + next + '-setup.exe');
    write(readmeH, readme);

    ctx.out('已发版 v' + next
      + '（CHANGELOG 段落 + package.json + src/config.js + package-lock.json + README 版本锁）'
      + (archivedCount ? '；已滚动归档 ' + archivedCount + ' 个历史版本段 → docs/changelog/' : ''));
    // 交接面提醒：按 §5 准入第 5 条，「在飞 / 未收口」小节在发版时必须清空或移入版本段。
    // 这里只**提醒**（不代改）—— 该小节是给下一个接手的 AI 看的，清空前要人/AI 判断哪些还没收口。
    try {
      const rm = read('docs/ROADMAP.md').text;
      const seg = rm.split(/^##\s/m).find((s) => /在飞\s*\/\s*未收口/.test(s.split('\n')[0] || ''));
      const rows = seg ? (seg.match(/^\|\s*(在飞|已收口)\s*\|/gm) || []).length : 0;
      if (rows > 0) {
        ctx.out('⚠️ 交接面提醒：`docs/ROADMAP.md`「在飞 / 未收口」还有 ' + rows
          + ' 条记录 —— 按 §5 准入第 5 条，发版时应清空或移入版本段（把已收口的删掉，在飞的留给下一位）。');
      }
    } catch (e) { /* ROADMAP 不可读不影响发版 */ }
  }
};
