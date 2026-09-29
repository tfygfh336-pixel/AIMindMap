#!/usr/bin/env node
/* ============================================================
 * scripts/docs-registry-check.js — 文档登记门禁（G8）
 * ------------------------------------------------------------
 * 存在的唯一理由：本工程的文档架构规范写在 `docs/ARCHITECTURE.md` §5
 * 「文档架构（每份文档的作用与边界）」里，但**规范只是一张人读的表**：
 * 没有任何东西阻止后来者新建一份表外文档。实测已发生两次：
 *   · 一份兼有方案与执行记录双性质的表外文档（已于 2026-09-27 从本工程删除）—— 它把
 *     CHANGELOG 已有的事实与手写易腐数字又抄了一份，随后自己漂移自相矛盾
 *     （§2.5 记 1424×835，§3 却称 1680×1050 已落地）；其中本工程的状态与偏离那一部分
 *     已并入 `docs/ARCHITECTURE.md` §4b，其余不再在工程内保留副本
 *     —— 教训留在这里，文档本体不再占工程视野；
 *   · 工程根 `1111111111DOUBAO/*.html`（3 份一次性分析稿）与
 *     `.review/dsh-implementation-contract.md`（工作笔记）—— 文档散落在
 *     未登记的家目录里。
 * 文档冗余不是靠"提醒作者注意"能治的（与 G6 防的数字漂移同一种病：
 * 同一事实多副本 + 无单源），所以按本项目一贯做法**把约定变成门禁**。
 *
 * 判定：**清单以 `checkRegistry()` 里的 ①…⑬ 标记为准**，本节不再写死条数。
 *   （写死过一次：加到第 13 条时只更新了架构文档一处，于是同一个门禁的条数在
 *    **四个地方四种说法**（规则文件 12 / 架构文档 13 / 本注释"三条" / 代码 13）——
 *    这正是本工程反复修的那类病。现有两道防线：`RULES.md` §2 的 G8 行声明的条数由 **G9**
 *    与本文件的标记数机械对齐；本注释只留"看标记"的指路。）
 * 位置：①…⑬ 十三个判定都在 `checkRegistry()` 里（工程根 / 登记 / 家门 / 悬挂 /
 *   根与顶层白名单 / 归档重复 / 交接死指针 / 代码入档 / 归档横幅 / 工作目录状态 /
 *   导航可达 / 契约覆盖 / 章节编号 / 登记表一致性）。任一不满足即 exit 1。
 *   （**标记必须唯一** —— 实测曾有两个 ①，导致"数一遍"得到错误的条数。）
 *
 * 用法：
 *   node scripts/docs-registry-check.js         # 门禁（exit 0/1）
 *   node scripts/docs-registry-check.js --list  # 打印当前文档清单与登记状态
 * 挂载点：`npm run verify`（紧跟 G1，快速失败）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_DOC = 'docs/ARCHITECTURE.md';   // §5 文档架构表 = 唯一登记处

/** 遍历时跳过的目录：依赖 / 构建产物 / 第三方运行包 / 笔记数据 / 临时目录 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'dist-portable', 'vendor', 'backups',
  'projects', '.tmp-img', '.tmp-svg'
]);

/** 文档家门：.md 允许的根（工程根另有白名单），.html 允许的根 */
const DOC_DIRS = ['docs'];           // 文档唯一正门（含 docs/archive/）
const HTML_DIRS = ['renderer'];      // 应用界面 HTML（不是文档）
const ROOT_DOCS = ['SKILL.md', 'README.md', 'CHANGELOG.md'];  // 工程根只允许这三份入口文档

/** 工作产物区（`ARCHITECTURE.md` §5 第 3 条）：放 AI 的分析/汇报/评审稿/探针，
 *  **不是**文档的家 —— 可随时整目录删除，不进 G6 数字扫描（见 doc-facts 的 SKIP），
 *  也不进版本库（见 .gitignore）。这样"必须落盘的东西"有唯一去处，
 *  而不是各自在工程根或任意目录新开一份。 */
const WORK_DIR = '.review';

/** 归档族：规则相同的目录 —— 只增不改、不进 G6 扫描、无需逐份登记（§5 用一行前缀覆盖）。
 *  `docs/archive/` = 历史快照（旧方案/旧审查）；`docs/changelog/` = 滚动归档的历史版本段。 */
const ARCHIVE_PREFIXES = ['docs/archive/', 'docs/changelog/'];

/** 工程根允许出现的文件（其余任何文件一律视为乱放；Windows 大小写不敏感 → 统一小写比较） */
const ROOT_FILES = [
  '.gitignore', 'CHANGELOG.md', 'README.md', 'SKILL.md',
  'electron-builder.yml', 'main.js', 'main-dsh-sidebar.js', 'preload.js',
  'package.json', 'package-lock.json',
  // 测试发现范围（存在理由：`.review/` 会被 vitest 默认收集，放个备份进去就让 npm test 变红）
  'vitest.config.mjs',
  'smoke-shot.png', 'smoke-out.txt',           // 冒烟产物（.gitignore 已忽略）
  'smoke-frame.json',                          // 冒烟取景记录（分辨率/哈希/像素统计；.gitignore 已忽略）
  '启动AI MindMap.vbs'
];

/** 顶层目录白名单（其余任何顶层目录一律视为乱放） */
const TOP_DIRS = [
  '.git', WORK_DIR, 'backups', 'build', 'cli', 'docs', 'node_modules',
  'projects', 'renderer', 'scripts', 'src', 'tests', 'vendor',
  'dist', 'dist-portable', '.tmp-img', '.tmp-svg'
];


/* ---------------- §5 登记表解析 ---------------- */

/** 截取 `## 5. …` 段（到下一个 `## ` 之前）；表 = 该段内以 | 开头的行 */
function section5(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*5[.、\s]/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

/** 从 §5 表抽取登记的文档路径 → { exact:Set, prefixes:string[] } */
function parseRegistryTable(md) {
  const sec = section5(md);
  const exact = new Set();
  const prefixes = [];
  if (!sec) return { exact, prefixes, found: false };
  sec.forEach((line) => {
    if (!/^\s*\|/.test(line)) return;                    // 只看表格行
    const spans = line.match(/`[^`]+`/g) || [];
    spans.forEach((raw) => {
      const p = raw.slice(1, -1).replace(/\*\*/g, '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
      if (/\/\*$/.test(p)) prefixes.push(p.slice(0, -1));           // 形如 docs/archive/*
      else if (/\.(md|html)$/i.test(p)) {
        // 只有"像路径"的才算登记项：带斜杠的路径，或工程根的三份入口文档。
        // 否则 §5 里的**占位写法**（如 `vX.Y.Z.md`）会被误判成"悬挂登记"——
        // 实测已发生过一次（本门禁当场抓到）。
        if (p.includes('/') || ROOT_DOCS.includes(p)) exact.add(p);
      }
    });
  });
  return { exact, prefixes, found: true };
}

/** 某路径是否被登记表覆盖（精确 / 前缀 glob） */
function isRegistered(reg, rel) {
  if (reg.exact.has(rel)) return true;
  return reg.prefixes.some((pre) => rel.startsWith(pre));
}

/* ---------------- 文件遍历 ---------------- */

/** 收集工程内全部 .md / .html（跳过 SKIP_DIRS），返回相对 `base`（默认 dir）的 POSIX 路径 */
function collectDocs(dir, out, base) {
  out = out || [];
  if (base === undefined) base = dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectDocs(path.join(dir, e.name), out, base);
    } else if (/\.(md|html?)$/i.test(e.name)) {
      out.push(path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

/* ---------------- 判定：登记与家门（清单与条数以 checkRegistry 的 ①…⑬ 标记为准） ---------------- */

/* ---------------- 判定：根/顶层目录白名单（"其他文件乱放"也抓） ---------------- */

/** 工程根与顶层目录必须落在白名单内。只查两层——第三层以下属实现细节，不 policing。
 *  这一条专治"AI 在工程根随手写 report.md / analysis.json / shot.png / probe.js"。 */
function checkRootLayout(root) {
  const problems = [];
  const rootFiles = new Set(ROOT_FILES.map((f) => f.toLowerCase()));
  const topDirs = new Set(TOP_DIRS.map((d) => d.toLowerCase()));

  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const name = e.name;
    const lower = name.toLowerCase();
    if (e.isDirectory()) {
      if (!topDirs.has(lower)) {
        problems.push({ kind: 'junk', rel: name + '/',
          msg: '顶层目录不在白名单内 —— 工作产物请放 ' + WORK_DIR + '/，成品登记进 docs/，其余移出工程' });
      }
      continue;
    }
    if (!rootFiles.has(lower)) {
      // .md/.html 已由「家门」规则判定（工程根只允许三份入口文档），这里不重复报
      if (/\.(md|html?)$/i.test(name)) continue;
      problems.push({ kind: 'junk', rel: name,
        msg: '工程根不允许出现这个文件 —— 工作产物放 ' + WORK_DIR + '/，文档登记进 docs/，其余移出工程' });
    }
  }
  return problems;
}

/* ---------------- 第五条判定：归档族与主文件不得重复版本段 ----------------
 * 为什么需要：`CHANGELOG.md` 与 `docs/changelog/` **都不进 G6 扫描**（都算历史），
 * 于是"同一段历史同时躺在两边"这种**同一事实多副本**恰好落在两边都不扫的盲区里 ——
 * 实测已发生过一次：滚动归档后，12 个旧版本段被并发写入的 salvage 脚本又并回了主文件。
 * 重复是可机械判定的，所以在这里抓。 */
function checkArchiveNoDuplicate(root) {
  const problems = [];
  const mainPath = path.join(root, 'CHANGELOG.md');
  const archDir = path.join(root, 'docs', 'changelog');
  if (!fs.existsSync(mainPath) || !fs.existsSync(archDir)) return problems;
  const main = fs.readFileSync(mainPath, 'utf8');
  fs.readdirSync(archDir).filter((f) => /\.md$/i.test(f)).forEach((f) => {
    const version = f.replace(/\.md$/i, '');
    const re = new RegExp('^## \\[' + version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'm');
    if (re.test(main)) {
      problems.push({ kind: 'duplicate', rel: 'docs/changelog/' + f,
        msg: 'CHANGELOG.md 里仍留着 ## [' + version + '] 段 —— 同一段历史两处副本；'
          + '归档后应从主文件删除（跑一次 release 的滚动，或手动删该段）' });
    }
  });
  return problems;
}

/* ---------------- 第六条判定：交接面的"在飞"证据指针必须存在 ----------------
 * 为什么需要：`docs/ROADMAP.md` 的「在飞 / 未收口」小节是**交接面** —— 新接手的 AI 靠它知道
 * "现在做到哪了、下一步做什么"。若它指向的 `.review/<目录>` 已被删或改名，指针就成了**死指针**：
 * 接手者会去找一个不存在的工作目录，或以为那件工作从未发生。
 * 这条只能机械判"目录在不在"，判不了"状态写得对不对"（那是 R5 的残差）。 */
function checkHandoverPointers(root) {
  const problems = [];
  const p = path.join(root, 'docs', 'ROADMAP.md');
  if (!fs.existsSync(p)) return problems;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^##\s.*在飞\s*\/\s*未收口/.test(l));
  if (start < 0) return problems;                       // 没有该小节 → 不判（不强制存在）
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const seen = new Set();
  for (let i = start; i < end; i++) {
    for (const m of lines[i].matchAll(/`(\.review\/[^`\s]+)`/g)) {
      const ref = m[1].replace(/[\\/]+$/, '');          // 去掉结尾斜杠
      // 跳过**占位写法**（`.review/<目录>` / `.review/*`）—— 那是规矩说明，不是真指针。
      // （实测：本判定第一次上线就抓到了自己规矩文字里的 `.review/<目录>`。）
      if (/[<>*]/.test(ref)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (!fs.existsSync(path.join(root, ref))) {
        problems.push({ kind: 'handover', rel: 'docs/ROADMAP.md:' + (i + 1),
          msg: '「在飞 / 未收口」的证据指针指向不存在的目录 ' + ref
            + ' —— 交接面不能有死指针（删工作目录时同步更新该小节）' });
      }
    }
  }
  return problems;
}

/* ---------------- 第七条判定：代码文件必须被架构文档提到（文档↔代码对应） ----------------
 * 为什么需要：`docs/ARCHITECTURE.md` 是新接手的 AI 认识代码结构的入口（§2 各层职责表）。
 * 实测缺口（以"接手可达性"为标尺的审计）：`src/` 21 个模块里 **3 个没被提到**
 * （`ui-state.js` / `dsh-capabilities.js` / `dsh-sidebar-skill.js`），`scripts/` 连**章节都没有**
 * —— 连 `verify.js`（验证链的单源）都不在架构文档里。新模块写了代码却不进文档，
 * 接手者就不知道它存在。
 * 范围刻意收窄：**只查 `src/*.js`、`cli/commands/*.js`、`scripts/*.js`（顶层）**。
 * 豁免 `tests/`、`scripts/smoke/`、`scripts/vision/` —— 它们有目录级说明 + 自描述命名，
 * 逐文件登记只增维护面而无收获。 */
const COVERED_DIRS = [
  { dir: 'src', what: '共享核心模块' },
  { dir: 'cli/commands', what: 'CLI 命令层' },
  { dir: 'scripts', what: '脚本层' }
];

function checkModuleCoverage(root) {
  const problems = [];
  const archPath = path.join(root, 'docs', 'ARCHITECTURE.md');
  if (!fs.existsSync(archPath)) return problems;
  const arch = fs.readFileSync(archPath, 'utf8');
  COVERED_DIRS.forEach(({ dir, what }) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs).filter((f) => /\.js$/i.test(f)).sort().forEach((f) => {
      // 用文件名匹配（架构文档里以 `文件.js` 形式出现）
      if (arch.includes(f)) return;
      problems.push({ kind: 'module-cover', rel: dir + '/' + f,
        msg: what + '里的这个文件没有被 `docs/ARCHITECTURE.md` 提到 —— '
          + '新接手的 AI 靠 §2 认识代码结构，新增文件要同批登记（§2.3 / §2.6 表）' });
    });
  });
  return problems;
}

/* ---------------- 第十一条判定：数据契约必须覆盖 schema 校验的字段 ----------------
 * 为什么需要：`docs/DATA-FORMAT.md` 自述目标是"任何第三方工具只读本文档就能写出正确的
 * 解析器与生成器"。**零上下文的接手演练实测**：`meta.layout`（CLI `theme-layout` 写入、
 * `src/schema.js` 校验、`docs/CLI.md` 有说明）**在契约里根本没有** —— 照着契约改的 AI 会漏掉它。
 * 设计取舍：清单**显式写在常量里**（而不是从源码正则抽），因为"哪些字段属于契约"是人的判断；
 * 用第二个参数标明**它是否由 schema 校验**，两类各自自查：
 *   - 校验型（true）：必须出现在 `src/schema.js`，否则说明 schema 改了名/删了它而清单没跟上；
 *   - 仅契约型（false）：**不应**出现在 schema（如 `meta.rootMode` / `meta.author` / `meta.version`
 *     是"写进契约但当前不校验"的字段）—— 若某天 schema 开始校验它，这条会提醒把分类改过来。
 * 两类都必须在 `docs/DATA-FORMAT.md` 里出现。 */
const SCHEMA_FIELDS = [
  ['meta.name', true], ['meta.formatVersion', true], ['meta.layout', true],
  ['meta.rootMode', false], ['meta.author', false], ['meta.version', false],
  ['format', true], ['data', true], ['assoc', true],
  ['id', true], ['topic', true], ['children', true], ['detail', true],
  ['images', true], ['files', true], ['links', true], ['tags', true]
];

function checkContractCoverage(root) {
  const problems = [];
  const schemaPath = path.join(root, 'src', 'schema.js');
  const dfPath = path.join(root, 'docs', 'DATA-FORMAT.md');
  if (!fs.existsSync(schemaPath) || !fs.existsSync(dfPath)) return problems;
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const df = fs.readFileSync(dfPath, 'utf8');
  SCHEMA_FIELDS.forEach(([f, validated]) => {
    const leaf = f.split('.').pop();
    const inSchema = new RegExp('\\b' + leaf + '\\b').test(schema);
    if (validated && !inSchema) {
      problems.push({ kind: 'contract-stale', rel: 'scripts/docs-registry-check.js',
        msg: '字段清单检查表已过期：`' + f + '` 标为"schema 校验"，但 `src/schema.js` 里找不到 —— '
          + 'schema 改过名/删过字段？请同步 SCHEMA_FIELDS 常量（它必须与 schema 一起演进）' });
      return;
    }
    if (!validated && inSchema) {
      problems.push({ kind: 'contract-stale', rel: 'scripts/docs-registry-check.js',
        msg: '字段清单检查表已过期：`' + f + '` 标为"仅契约、不校验"，但它已出现在 `src/schema.js` —— '
          + '请把 SCHEMA_FIELDS 里该条的第二项改成 true（分类要与实现一致）' });
      return;
    }
    if (!new RegExp('\\b' + leaf + '\\b').test(df)) {
      problems.push({ kind: 'contract', rel: 'docs/DATA-FORMAT.md',
        msg: '数据契约缺字段 `' + f + '`：' + (validated ? '`src/schema.js` 校验它，' : '它是契约声明的字段，')
          + '但 `docs/DATA-FORMAT.md` 没写 —— 契约自述"只读本文档就能写出正确解析器"，'
          + '缺字段会让接手者漏掉它（`meta.layout` 就是这么漏掉的）' });
    }
  });
  return problems;
}

/* ---------------- 第十二条判定：受管文档的章节编号必须连续 ----------------
 * 为什么需要：**接手演练实测** `docs/DATA-FORMAT.md` 的二级编号是 2.1 2.2 2.3 **2.5** 2.6 2.7
 * （缺 2.4）。断号本身不致命，但它是"有人删/挪过章节而没人复查"的可见痕迹 ——
 * 读者会去找一个不存在的节，或以为内容丢了。可机械判定，所以设为门禁。
 * 口径：**同一层级内必须连续**；顶层允许从 0 或 1 开始（本工程两种都有）；
 * 允许"无编号章节"（如 ROADMAP 用语义标题）；只查 `docs/*.md`（跳过生成物）。 */
const NUMBERING_SKIP = new Set(['CLI.md', 'VERIFY.md']);   // 生成物：结构由生成器决定

function checkSectionNumbering(root) {
  const problems = [];
  const dir = path.join(root, 'docs');
  if (!fs.existsSync(dir)) return problems;
  fs.readdirSync(dir).filter((f) => /\.md$/.test(f) && !NUMBERING_SKIP.has(f)).forEach((f) => {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    const tops = [];
    const subs = [];
    lines.forEach((l, i) => {
      let m = /^##\s+(\d+)\./.exec(l);
      if (m) { tops.push([Number(m[1]), i + 1]); return; }
      m = /^###\s+(\d+)\.(\d+)/.exec(l);
      if (m) subs.push([Number(m[1]), Number(m[2]), i + 1]);
    });
    const report = (msg, line) => problems.push({ kind: 'numbering', rel: 'docs/' + f + ':' + line, msg: msg });
    for (let i = 1; i < tops.length; i++) {
      if (tops[i][0] !== tops[i - 1][0] + 1) {
        report('顶级章节编号断号：' + tops[i - 1][0] + ' → ' + tops[i][0]
          + '（读者会去找不存在的第 ' + (tops[i - 1][0] + 1) + ' 节；补写或重排编号）', tops[i][1]);
      }
    }
    for (let i = 1; i < subs.length; i++) {
      const [pa, ca] = subs[i - 1];
      const [pb, cb] = subs[i];
      if (pb === pa && cb !== ca + 1) {
        report('二级章节编号断号：' + pa + '.' + ca + ' → ' + pb + '.' + cb + '（同上）', subs[i][2]);
      }
    }
  });
  return problems;
}

/* ---------------- 第八条判定：归档文档必须自带「历史」横幅 ----------------
 * 为什么需要：归档不是"藏起来"，而是**仍然会被 grep 到** —— 新接手的 AI 搜一个关键词命中旧稿，
 * 若旧稿开头没有任何标记，它会当成现状。实测：`docs/archive/` 6 份里 4 份没有任何横幅
 * （3 个 HTML 分析稿 + 1 份实施契约），而 `docs/changelog/` 14 份都有（由生成器写）。
 * 只查**前 8 行**：横幅必须在开头才起作用。 */
const BANNER_RE = /勿作现状引用|历史快照|历史归档|ARCHIVED/;

/* ---------------- 交接提示（**不算违规**）：[Unreleased] 有内容而在飞为空 ----------------
 * 接手演练实测：新会话按 `SKILL.md` → `ROADMAP.md`「在飞 / 未收口」这条路线读，
 * 会以为"最新在飞"是那条已收口的条目，而真正最新的工作躺在 `CHANGELOG [Unreleased]` 里。
 * 二者本来就分工不同（已完成未发版 vs 未完成），所以**不是缺陷**；
 * 但当 [Unreleased] 有内容而在飞为空时，接手者最容易只读一边 —— 故打印一行提示。 */
function handoverNotice(root) {
  const rmPath = path.join(root, 'docs', 'ROADMAP.md');
  const clPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(rmPath) || !fs.existsSync(clPath)) return null;
  const lines = fs.readFileSync(rmPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^##\s.*在飞\s*\/\s*未收口/.test(l));
  let rows = 0;
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
    // 状态列可以是 `在飞` / **在飞** / `已收口` / `未开始` / `外部阻塞`（加粗不算区别）
    rows = lines.slice(start, end).filter((l) => /^\|\s*\**\s*(在飞|已收口|未开始|外部阻塞|已废弃)\**\s*\|/.test(l)).length;
  }
  if (rows > 0) return null;
  const un = fs.readFileSync(clPath, 'utf8').split(/^## \[v/m)[0];   // [Unreleased] 段
  const entries = (un.match(/^### /gm) || []).length;
  return entries > 0
    ? '`CHANGELOG [Unreleased]` 里有 ' + entries + ' 条已完成未发版的变更，而「在飞 / 未收口」为空 —— '
      + '接手者只看 ROADMAP 会漏掉它们（"最近改了什么"看 [Unreleased]，"什么没做完"看在飞小节）。'
    : null;
}

function checkArchiveBanners(root) {
  const problems = [];
  const dir = path.join(root, 'docs', 'archive');
  if (!fs.existsSync(dir)) return problems;
  fs.readdirSync(dir).filter((f) => /\.(md|html?)$/i.test(f)).forEach((f) => {
    let head = '';
    try { head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 8).join(' '); }
    catch (e) { return; }
    if (!BANNER_RE.test(head)) {
      problems.push({ kind: 'banner', rel: 'docs/archive/' + f,
        msg: '归档文档开头没有「历史」横幅 —— 它会被 grep 到，接手者可能当成现状；'
          + '请在开头加一行（HTML 用注释）：`> ⚠️ 历史归档（YYYY-MM）：不是现状、勿据此改动`' });
    }
  });
  return problems;
}

/* ---------------- 第九条判定：工作目录必须声明死活 ----------------
 * 为什么需要：`.review/` 是"可随时整目录删除"的工作产物区，但**没有任何东西告诉接手者
 * 哪些目录还在用**。实测：一个工作目录当天还在被写入（70 个文件），却没有任何状态标记 ——
 * 接手者要么误删在飞工作，要么把陈旧分析当现状。
 * 规则：`.review/` 的**直接子目录**必须有 `README.md` 声明状态（在飞 / 已收口 / 已废弃）；
 * 直接放在 `.review/` 下的散落文件豁免（它们是单文件产物，没有"目录死活"可言）。
 * **工具自建目录豁免**：`.review/vision/` 由 `scripts/vision/record.js` 按需创建，
 * 是"读图留痕"的固定用途存储（用途已在 §2.4 / §4b 写明），不属于"某次任务的临时工作目录"。 */
const WORK_DIR_EXEMPT = new Set(['vision']);

function checkWorkDirStatus(root) {
  const problems = [];
  const dir = path.join(root, WORK_DIR);
  if (!fs.existsSync(dir)) return problems;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (!e.isDirectory()) return;
    if (WORK_DIR_EXEMPT.has(e.name)) return;
    if (!fs.existsSync(path.join(dir, e.name, 'README.md'))) {
      problems.push({ kind: 'workdir', rel: WORK_DIR + '/' + e.name + '/',
        msg: '工作目录没有 README.md 声明状态 —— 补三行（主题 / 开始日期 / 状态：在飞|已收口|已废弃），'
          + '否则接手者无法判断它能否删除，也无法与 `docs/ROADMAP.md` 的「在飞 / 未收口」对上' });
    }
  });
  return problems;
}

/* ---------------- 第十条判定：受管文档必须能从 SKILL.md 找到（导航可达） ----------------
 * 为什么需要：新接手的 AI 的**第一屏**是 `SKILL.md`（skill 正文）。若某份受管文档在 §5 登了记、
 * 却从 SKILL.md 导航里找不到，接手者就**不知道它存在** —— 对"AI 独立接手"来说等于没有这份文档。
 * 只查 `SKILL.md`（**不查 README**）：README 的文档地图已按 §5 的精神**降级为指针**
 * （"清单只有一处权威"），它不再承担"列全"的责任，因此不能拿它做判定依据。
 * 判据是**集合级**（文档有没有被提到），不是措辞级 —— 各文档怎么描述允许不同。 */
function checkNavCoverage(root, reg) {
  const problems = [];
  const p = path.join(root, 'SKILL.md');
  if (!fs.existsSync(p) || !reg || !reg.exact) return problems;
  const nav = fs.readFileSync(p, 'utf8');
  [...reg.exact].sort().forEach((rel) => {
    const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    // 接受两种写法：完整相对路径（docs/X.md）或文件名（X.md）
    if (nav.includes(rel) || nav.includes(base)) return;
    problems.push({ kind: 'nav-cover', rel: rel,
      msg: '这份文档在 §5 登记了，但 `SKILL.md` 导航里找不到它 —— 新接手的 AI 的第一屏是 SKILL.md，'
        + '找不到就等于不知道它存在；请在导航表里加一行（或说明它为何不需要 AI 直达）' });
  });
  return problems;
}

/* ---------------- 并发改动检测（**不是判红，是告知**） ----------------
 * 为什么需要：本工程**同时会有多个 AI 会话在改**（实测被回退过两次：导航分组、CHANGELOG 段）。
 * 数据层有"并发写入即版本闸门"（ADR），但**文档层什么都没有** —— 而文档层恰恰是 AI 会话的主战场。
 * 为什么不做锁：AI 场景下锁容易死锁 / 误杀（会话异常退出后锁没人释放），而损害等级是"可发现、可重做"
 * （M1 判定 ⇒ 约定 + 检测，而不是门禁）。这里只把"最近有谁在动"摆到台面上，让人自己决定要不要继续。
 * 判据：受管文件（文档 + 脚本 + 核心代码）里，最近 N 分钟内有改动的数量。 */
const WATCH_GLOBS = [
  'SKILL.md', 'README.md', 'CHANGELOG.md', 'docs', 'scripts', 'src', 'cli', 'renderer', 'tests'
];
const RECENT_WINDOW_MIN = 10;

function recentlyChanged(root, minutes, nowMs) {
  const win = (Number.isFinite(minutes) ? minutes : RECENT_WINDOW_MIN) * 60000;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const hits = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      if (/[\\/](node_modules|\.git|build|dist|dist-portable|backups|vendor)$/.test(p)) return;
      let items = [];
      try { items = fs.readdirSync(p); } catch (e) { return; }
      items.forEach((n) => walk(path.join(p, n)));
      return;
    }
    if (!/\.(md|js|json|yml|html|css)$/i.test(p)) return;
    if (now - st.mtimeMs > win) return;
    if (st.mtimeMs > now) return;          // 未来时间戳（时钟偏移）不算"最近改动"
    if (/[\\/]\.review[\\/]/.test(p) || /[\\/]docs[\\/](archive|changelog)[\\/]/.test(p)) return;
    hits.push(path.relative(root, p).replace(/\\/g, '/'));
  };
  WATCH_GLOBS.forEach((g) => walk(path.join(root, g)));
  return hits.sort();
}

/* ---------------- 登记表由"文档头部元信息"生成（T5） ----------------
 * 为什么改：§5 登记表是**唯一权威**，却一直是**手写**的 —— 加一份文档要改"别处的表格"，
 * 而那个表格的解析已经出过两次脆弱问题（占位符被当成登记项、表格被空行打断）。
 * 现在改为：**每份受管文档在自己的头部声明元信息**（自描述），登记表由这些声明**生成**；
 * G8 逐字比对（与 G7 对 CLI.md / VERIFY.md 的做法一致）—— 手改表格或改元信息忘了重生成，都会判红。
 * 放置规则：元信息块必须在**文件前 25 行**内（frontmatter 之后、H1 之后都算）。
 * 归档族不逐份声明：它们由**前缀行**覆盖（那两行写在生成器的常量里）。 */
const REG_BEGIN = '<!-- BEGIN:registry-table';
const REG_END = '<!-- END:registry-table -->';
const HEADER_KEYS = { '层': 'layer', '作用': 'purpose', '不该写': 'notWrite', '更新方式': 'update' };
const LAYER_ORDER = ['入口', '治理', '契约', '设计', '记录', '归档'];

/** 从文档正文里解析 `<!-- registry ... -->` 元信息块（前 25 行内查找） */
function parseDocHeader(text) {
  const head = text.split(/\r?\n/).slice(0, 25).join('\n');
  const m = /<!--\s*registry([\s\S]*?)-->/.exec(head);
  if (!m) return null;
  const meta = {};
  m[1].split(/\r?\n/).forEach((l) => {
    const mm = /^\s*([^:：]+)[:：]\s*(.+?)\s*$/.exec(l);
    if (!mm) return;
    const key = HEADER_KEYS[mm[1].trim()];
    if (key) meta[key] = mm[2];
  });
  return (meta.layer && meta.purpose) ? meta : null;
}

/** 收集受管文档（docs/*.md + 根三份入口文档）的元信息 */
function collectDocHeaders(root) {
  const out = [];
  const rels = [];
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) {
    fs.readdirSync(docsDir).filter((f) => /\.md$/.test(f)).forEach((f) => rels.push('docs/' + f));
  }
  ROOT_DOCS.forEach((f) => rels.push(f));
  rels.sort().forEach((rel) => {
    let text = '';
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { return; }
    out.push({ rel, meta: parseDocHeader(text) });
  });
  return out;
}

/** 渲染 §5 登记表（纯函数式：输入元信息 → markdown 表格） */
function renderRegistryTable(entries) {
  const rows = entries.filter((e) => e.meta).sort((a, b) => {
    const la = LAYER_ORDER.indexOf(a.meta.layer);
    const lb = LAYER_ORDER.indexOf(b.meta.layer);
    if (la !== lb) return (la < 0 ? 99 : la) - (lb < 0 ? 99 : lb);
    return a.rel.localeCompare(b.rel);
  });
  const lines = [
    '| 层 | 文档 | 作用（存在的唯一理由） | 不该写什么 | 更新方式 |',
    '|----|------|---------------------|-----------|---------|'
  ];
  rows.forEach((e) => {
    lines.push('| ' + [e.meta.layer, '`' + e.rel + '`', e.meta.purpose,
      e.meta.notWrite || '—', e.meta.update || '手写'].join(' | ') + ' |');
  });
  // 归档族：规则相同 ⇒ 由前缀行统一覆盖，不逐份声明（§5 准入第 3 条）
  lines.push('| 归档 | `docs/archive/*` | 历史快照（回溯用） | —（**勿作现状引用**） | 只增不改（必须带历史横幅） |');
  lines.push('| 归档 | `docs/changelog/*` | **滚动归档的历史版本段**（`vX.Y.Z.md`，`release` 自动滚出，保留窗口 3） | —（**勿作现状引用**） | 只增不改；查历史用 `mm-cli changelog --grep` |');
  return lines.join('\n');
}

/** 把生成好的表写回 §5（`--write` 模式）；返回是否成功 */
function writeRegistryTable(root) {
  const archPath = path.join(root, REGISTRY_DOC);
  const md = fs.readFileSync(archPath, 'utf8');
  const entries = collectDocHeaders(root);
  const missing = entries.filter((e) => !e.meta).map((e) => e.rel);
  if (missing.length) {
    console.error('✗ 这些受管文档缺少 `<!-- registry ... -->` 元信息块，无法生成登记表：');
    missing.forEach((m) => console.error('   ' + m));
    console.error('  → 在文件前 25 行内补：层 / 作用 / 不该写 / 更新方式（照抄 §5 表里它原来那一行）。');
    return false;
  }
  const table = renderRegistryTable(entries);
  const s = md.indexOf(REG_BEGIN);
  const e = md.indexOf(REG_END);
  if (s < 0 || e < 0 || e < s) {
    console.error('✗ ' + REGISTRY_DOC + ' 里找不到登记表标记（应成对出现）：' + REG_BEGIN + ' … ' + REG_END);
    return false;
  }
  const head = md.slice(0, md.indexOf('\n', s) + 1);
  const out = md.slice(0, s) + head.slice(head.indexOf(REG_BEGIN)) + '\n' + table + '\n' + md.slice(e);
  fs.writeFileSync(archPath, out, 'utf8');
  console.log('已生成 ' + REGISTRY_DOC + ' §5 登记表（来源：' + entries.filter((x) => x.meta).length
    + ' 份文档的头部元信息 + 2 行归档族前缀）');
  return true;
}

/** 检查：元信息齐全 + 登记表与元信息一致（逐字） */
function checkRegistryTable(root, md) {
  const problems = [];
  const entries = collectDocHeaders(root);
  // 自适应门：**只有在"已经采用头部元信息"的工程里才判**（判定标志 = 至少一份文档带元信息块）。
  // 为什么需要：单测 fixture / 早期工程没有这套元信息，硬判会把它们全部变成红；
  // 而真工程里"元信息块被删光"这种情况由下面的 no-header 逐份报出来（不会静默放过）。
  if (!entries.some((e) => e.meta)) return problems;
  entries.filter((e) => !e.meta).forEach((e) => {
    problems.push({ kind: 'no-header', rel: e.rel,
      msg: '受管文档缺少头部元信息块 `<!-- registry 层/作用/不该写/更新方式 -->` —— '
        + '登记表由这些声明生成，缺了它这份文档就没法进表（加完跑 `npm run docs:registry`）' });
  });
  const s = md.indexOf(REG_BEGIN);
  const e = md.indexOf(REG_END);
  if (s < 0 || e < 0 || e < s) {
    problems.push({ kind: 'registry', rel: REGISTRY_DOC,
      msg: '§5 里缺少登记表标记（应成对出现）：' + REG_BEGIN + ' … ' + REG_END });
    return problems;
  }
  const startLine = md.indexOf('\n', s) + 1;
  // 两侧都做首尾空白归一：BEGIN 注释与表格之间允许有一个空行（生成器就是这么写的）
  const actual = md.slice(startLine, e).replace(/^\s+/, '').replace(/\s+$/, '');
  const want = renderRegistryTable(entries).replace(/^\s+/, '').replace(/\s+$/, '');
  if (actual !== want) {
    const a = actual.split('\n');
    const w = want.split('\n');
    let at = 0;
    while (at < a.length && at < w.length && a[at] === w[at]) at++;
    problems.push({ kind: 'registry-stale', rel: REGISTRY_DOC,
      msg: '§5 登记表与各文档头部元信息不一致（第 ' + (at + 1) + ' 行起）—— 手改表格，或改了元信息没重生成。'
        + ' 磁盘: ' + String(a[at] === undefined ? '(表结束)' : a[at]).slice(0, 70)
        + ' ／ 应为: ' + String(w[at] === undefined ? '(表结束)' : w[at]).slice(0, 70)
        + ' → 跑 `npm run docs:registry`' });
  }
  return problems;
}

function checkRegistry(root, registryMd) {
  const reg = parseRegistryTable(registryMd);
  const problems = [];
  if (!reg.found) {
    problems.push({ kind: 'registry', rel: REGISTRY_DOC,
      msg: '找不到 §5「文档架构」段——登记表是文档准入的唯一依据，缺了它门禁无法判定' });
    return { problems, reg, docs: [] };
  }

  const docs = collectDocs(root).map((rel) => {
    const isRoot = !rel.includes('/');
    const inDocs = rel.startsWith('docs/');
    // 归档族：docs/archive/（历史快照）与 docs/changelog/（滚动归档的历史版本段）。
    // 两者的规则相同 —— 只增不改、不进 G6 扫描、无需逐份登记（§5 用前缀行覆盖）。
    const inArchive = ARCHIVE_PREFIXES.some((pre) => rel.startsWith(pre));
    const inRenderer = rel.startsWith('renderer/');
    const inWork = rel === WORK_DIR || rel.startsWith(WORK_DIR + '/');
    const isHtml = /\.html?$/i.test(rel);
    let verdict = 'ok';
    let msg = '';

    if (inWork) {
      verdict = 'ok';                                   // 工作产物区：任意文件，可随时删
    } else if (isRoot && !isHtml) {
      // ① 登记与家门：工程根只允许入口文档、`docs/` 下的 .md 必须登记（同属"有没有家"这一条）
      if (!ROOT_DOCS.includes(rel)) {
        verdict = 'stray';
        msg = '工程根只允许 ' + ROOT_DOCS.join(' / ') + ' —— 这份文档没有家';
      } else if (!isRegistered(reg, rel)) {
        verdict = 'unregistered';
        msg = '入口文档未在 §5 表登记';
      }
    } else if (inArchive) {
      verdict = 'ok';                                   // 归档区：只增不改，任意历史快照
    } else if (inDocs) {
      // （续 ①）docs/ 下的 .md 必须登记 —— 与上面的工程根分支同属判定①
      if (!isRegistered(reg, rel)) {
        verdict = 'unregistered';
        msg = '表外文档：§5 未登记（登记 / 归档 / 改为指针，三选一）';
      }
    } else if (isHtml && inRenderer) {
      verdict = 'ok';                                   // 应用界面 HTML，不是文档
    } else {
      // ② 家门：其余位置一律非法
      verdict = 'stray';
      msg = '文档只能住在 docs/（或 renderer/ 的应用 HTML）；一次性产物放 ' + WORK_DIR + '/';
    }
    return { rel, verdict, msg, isHtml };
  });

  docs.forEach((d) => {
    if (d.verdict !== 'ok') problems.push({ kind: d.verdict, rel: d.rel, msg: d.msg });
  });

  // ③ 无悬挂：表里声明的文档必须存在
  reg.exact.forEach((declared) => {
    if (!fs.existsSync(path.join(root, declared))) {
      problems.push({ kind: 'dangling', rel: declared,
        msg: '§5 表声明了这份文档，但磁盘上不存在（拆文档时忘改表）' });
    }
  });
  reg.prefixes.forEach((pre) => {
    if (!fs.existsSync(path.join(root, pre))) {
      problems.push({ kind: 'dangling', rel: pre + '*',
        msg: '§5 表声明了该目录，但磁盘上不存在' });
    }
  });

  // ④ 根/顶层白名单：抓"其他文件乱放"（不只 md/html）
  checkRootLayout(root).forEach((p) => problems.push(p));

  // ⑤ 归档族与主文件不得重复版本段（两边都不进 G6 扫描 ⇒ 只能在这里抓）
  checkArchiveNoDuplicate(root).forEach((p) => problems.push(p));

  // ⑥ 交接面的"在飞"证据指针必须存在（死指针 = 接手者白找一场）
  checkHandoverPointers(root).forEach((p) => problems.push(p));

  // ⑦ 代码文件必须被架构文档提到（文档↔代码对应：接手者靠 §2 认识代码结构）
  checkModuleCoverage(root).forEach((p) => problems.push(p));

  // ⑧ 归档文档必须自带「历史」横幅（归档仍会被 grep 到）
  checkArchiveBanners(root).forEach((p) => problems.push(p));

  // ⑨ 工作目录必须声明死活（在飞 / 已收口 / 已废弃）
  checkWorkDirStatus(root).forEach((p) => problems.push(p));

  // ⑩ 受管文档必须能从 SKILL.md 导航找到（第一屏可达 = 接手者知道它存在）
  checkNavCoverage(root, reg).forEach((p) => problems.push(p));

  // ⑪ 数据契约必须覆盖 schema 校验的字段（契约缺字段 = 接手者照着契约改就漏）
  checkContractCoverage(root).forEach((p) => problems.push(p));

  // ⑫ 受管文档的章节编号必须连续（断号 = 有人删/挪过章节而没人复查）
  checkSectionNumbering(root).forEach((p) => problems.push(p));

  // ⑬ 登记表必须与"各文档头部元信息"一致（表是生成的，不是手写的）
  checkRegistryTable(root, registryMd).forEach((p) => problems.push(p));

  return { problems, reg, docs };
}

/* ---------------- CLI ---------------- */

function main() {
  const regPath = path.join(ROOT, REGISTRY_DOC);
  if (!fs.existsSync(regPath)) {
    console.error('✗ 登记表文件缺失：' + REGISTRY_DOC);
    process.exit(1);
  }
  // `--write`：从各文档头部元信息**生成** §5 登记表（里程碑 T5）。
  // 与 `doc-facts --write` 同一模式：生成物由源重算，检查时再逐字比对。
  if (process.argv.includes('--write')) {
    process.exit(writeRegistryTable(ROOT) ? 0 : 1);
  }
  const registryMd = fs.readFileSync(regPath, 'utf8');
  const { problems, reg, docs } = checkRegistry(ROOT, registryMd);

  // `--judgments`：把本门禁的判定清单**现场列出来**（从 `checkRegistry()` 的 ①…⑬ 标记与标题提取）。
  // 为什么需要：`docs/RULES.md` §2 不再逐条复制这份清单（复制过，结果"声明 13 条、只列 12 项"）——
  // 改为指路到这条命令，清单永远与实现同步。
  if (process.argv.includes('--judgments')) {
    const self = fs.readFileSync(__filename, 'utf8').split('\n');
    const seen = new Set();
    self.forEach((l) => {
      const m = /^\s*\/\/\s*([①-⑳])\s*(.+)$/.exec(l);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      console.log('  ' + m[1] + ' ' + m[2].replace(/^[（(]?[a-z][）)]?\s*/i, '').trim().slice(0, 80));
    });
    console.log('  合计 ' + seen.size + ' 条判定（本清单由实现现场生成，`docs/RULES.md` §2 只声明条数）');
    return;
  }

  if (process.argv.includes('--list')) {
    console.log('文档清单（登记处：' + REGISTRY_DOC + ' §5）');
    console.log('─────────────────────────────────────────────');
    docs.forEach((d) => console.log('  ' + (d.verdict === 'ok' ? '✓' : '✗') + ' ' + d.rel + (d.msg ? '  ← ' + d.msg : '')));
    return;
  }

  console.log('== 文档登记门禁（G8）==');
  console.log(problems.length
    ? '✗ 文档体系完整性有问题（' + problems.length + ' 处）：'
    : '✓ 登记与家门均合规（' + docs.length + ' 份 .md/.html 有家，根与顶层目录白名单干净）');
  problems.forEach((p) => {
    const tag = p.kind === 'unregistered' ? '表外文档'
      : p.kind === 'stray' ? '家目录非法'
        : p.kind === 'dangling' ? '悬挂登记'
          : p.kind === 'junk' ? '乱放'
            : p.kind === 'duplicate' ? '历史重复'
              : p.kind === 'handover' ? '交接死指针'
                : p.kind === 'module-cover' ? '代码未入档'
                  : p.kind === 'banner' ? '归档缺横幅'
                    : p.kind === 'workdir' ? '工作目录无状态'
                      : p.kind === 'nav-cover' ? '导航不可达'
                        : p.kind === 'contract' ? '契约缺字段'
                          : p.kind === 'contract-stale' ? '检查表过期'
                            : p.kind === 'numbering' ? '章节断号'
                              : p.kind === 'no-header' ? '文档无元信息'
                                : p.kind === 'registry-stale' ? '登记表过期' : '登记表缺失';
    console.log('   [' + tag + '] ' + (p.rel ? p.rel + ' —— ' : '') + p.msg);
  });

  if (problems.length) {
    console.log('   → 三条路（见 SKILL.md 顶部「落盘规矩」与 ' + REGISTRY_DOC + ' §5）：'
      + '① 工作产物 → ' + WORK_DIR + '/（可随时删）；'
      + '② 要长期存在的文档 → docs/ 且先在 §5 表登记；'
      + '③ 一次性旧稿 → docs/archive/；其余移出工程。');
    console.error('\n文档登记门禁失败');
    process.exit(1);
  }
  console.log('✓ 根与顶层目录白名单干净（' + ROOT_FILES.length + ' 个根文件 + ' + TOP_DIRS.length + ' 个顶层目录）');
  console.log('✓ 登记表无悬挂条目（' + reg.exact.size + ' 份声明的文档都存在）');
  console.log('✓ 归档族与主文件无重复版本段（docs/changelog/ vs CHANGELOG.md）');
  console.log('✓ 交接面「在飞 / 未收口」的证据指针都存在（docs/ROADMAP.md）');
  console.log('✓ 代码文件都在架构文档里登记过（src/ · cli/commands/ · scripts/）');
  console.log('✓ 归档文档都带「历史」横幅（docs/archive/）');
  console.log('✓ 工作目录都声明了死活（.review/*/README.md）');
  console.log('✓ 受管文档都能从 SKILL.md 导航找到（第一屏可达）');
  console.log('✓ 数据契约覆盖了 schema 校验的字段（docs/DATA-FORMAT.md）');
  console.log('✓ 受管文档的章节编号连续（无断号）');
  console.log('✓ §5 登记表与各文档头部元信息一致（表是生成的，勿手改）');

  // ---- 交接提示（不算违规，只提示） ----
  const notice = handoverNotice(ROOT);
  if (notice) console.log('ℹ️ 交接提示：' + notice);
  // ---- 上次全链结果（告知：接手者最先想知道的一件事；值只住在 .review/last-verify.json） ----
  try {
    const lv = JSON.parse(fs.readFileSync(path.join(ROOT, '.review', 'last-verify.json'), 'utf8'));
    console.log('ℹ️ 上次全链：' + String(lv.finishedAt).replace('T', ' ').slice(0, 16) + '  '
      + (lv.ok ? '✅ 通过' : '❌ 失败于 ' + (lv.failedGate || '?')) + '（v' + lv.version + '）');
  } catch (e) {
    console.log('ℹ️ 上次全链：无记录（`.review/` 被清理过，或本机还没跑过 `npm run verify`）');
  }
  // ---- 并发改动检测（不算违规，只告知） ----
  const recent = recentlyChanged(ROOT, RECENT_WINDOW_MIN);
  if (recent.length) {
    console.log('ℹ️ 最近 ' + RECENT_WINDOW_MIN + ' 分钟内被改动的受管文件（' + recent.length + ' 个）——'
      + '**可能有另一个会话正在写**：' + recent.slice(0, 6).join('、')
      + (recent.length > 6 ? ' 等' : '')
      + '；改动前请先重读文件（过期快照的编辑会被工具拒绝，这是保护不是故障）。');
  }
  // 数据目录（projects/）里的"契约未声明的项"：G8 刻意跳过数据目录（那是用户数据），
  // 但**列出来**能防止"数据目录里躺着没人知道来历的文件"（实测曾有 build.js 躺在里面）。
  try {
    const projDir = path.join(ROOT, 'projects');
    if (fs.existsSync(projDir)) {
      const odd = [];
      for (const d of fs.readdirSync(projDir)) {
        const p = path.join(projDir, d);
        if (!fs.statSync(p).isDirectory()) continue;
        for (const x of fs.readdirSync(p)) {
          if (/\.json$/.test(x) || x === 'assets' || x === 'attachments') continue;
          odd.push('projects/' + d + '/' + x);
        }
      }
      if (odd.length) {
        console.log('ℹ️ 数据目录里有契约未声明的项（' + odd.length + ' 个）：' + odd.slice(0, 5).join('、')
          + ' —— `docs/DATA-FORMAT.md` §5 只声明 `<name>.json` / `assets/` / `attachments/`；'
          + '请确认它们的来历（工作产物请移到 `.review/`）。');
      }
    }
  } catch (e) { /* 数据目录不可读不影响门禁 */ }
  console.log('\n文档登记门禁通过');
}

module.exports = {
  parseRegistryTable, isRegistered, collectDocs, checkRegistry, checkRootLayout,
  checkArchiveNoDuplicate, checkHandoverPointers, checkModuleCoverage,
  checkArchiveBanners, checkWorkDirStatus, checkNavCoverage,
  checkContractCoverage, checkSectionNumbering, handoverNotice, recentlyChanged,
  parseDocHeader, collectDocHeaders, renderRegistryTable, checkRegistryTable, writeRegistryTable,
  section5, ROOT_DOCS, ROOT_FILES, TOP_DIRS, WORK_DIR, BANNER_RE, SCHEMA_FIELDS, RECENT_WINDOW_MIN,
  REG_BEGIN, REG_END
};

if (require.main === module) main();
