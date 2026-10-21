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
 * 判定：**清单以 `checkRegistry()` 里的标记（形如 `// 圈号`）为准**，本节不抄一份、不写死条数。
 *   （写死过一次：加到第 13 条时只更新了架构文档一处，于是同一个门禁的条数在
 *    **四个地方四种说法**（规则文件 12 / 架构文档 13 / 本注释"三条" / 代码 13）——
 *    这正是本工程反复修的那类病。现有两道防线：`RULES.md` §2 的 G8 行声明的条数由 **G9**
 *    与本文件的标记数机械对齐；本注释只留"看标记"的指路。
 *    ⚠️ 2026-10-19 复核发现的**第三个漂移面**：本注释原先自己抄了一份"①…⑭ 十四个判定 + 判定名清单"，
 *    而代码里已经有到 ⑯ 的标记、清单列了 15 项 —— 三个数字没有一个对得上，且**没有任何门禁抓得到它**
 *    （G9 只认「N 条判定」这种写法）。⇒ 抄清单这件事本身就是漂移源，已整段删掉。
 * 位置：全部判定都在 `checkRegistry()` 里（标记即清单）。
 *   **逐条清单不抄在这里 —— 现场取：`node scripts/docs-registry-check.js --judgments`**。
 *   任一不满足即 exit 1。
 *   （**标记必须唯一** —— 实测曾有两个 ①，导致"数一遍"得到错误的条数。）
 * 2026-09-29 补三处"不严"（复核报来的三处，全部复核属实，另有两处同源）：
 *   · **元信息块要求四行齐备** —— 原先只强制 `层`/`作用`，缺 `不该写`/`更新方式` 也能过，
 *     且渲染登记表时用 `|| '—'` / `|| '手写'` **静默补默认值**，于是"缺两行"被表格掩盖。
 *     现在缺行 = `partial`（与"没有块"分开报），生成模式同样拒绝。
 *   · **层取值表真正判红（新的判定⑭）** —— 原先 `LAYER_ORDER` 只用于排序，非法层被排到末尾就没人管，
 *     而 `REFERENCE`/`SKILL B3` 一直声称"值必须在取值表内"。
 *   · **归档横幅与元信息收集都改成递归** —— 原先只扫一层，`docs/<子目录>/*.md` 既不会被告知要补元信息、
 *     也没法合法进表（手工加进 §5 反而被"表过期"判红）：报错指了一条**走不通的路**。
 *   另两条同源加固：**读失败不再静默 `return`**（采不到真值＝红）；`--list` 有不合格文档时**置失败退出码**
 *   （否则挂进 CI 会假绿）。
 *
 * 用法：
 *   node scripts/docs-registry-check.js         # 门禁（exit 0/1）
 *   node scripts/docs-registry-check.js --list  # 打印当前文档清单与登记状态
 * 挂载点：`npm run verify`（紧跟 G1，快速失败）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
// 受管文档的写盘出口：**原子写 + 并发版本闸门**（比较与报错**只有** `src/data-store.js` 的 `versionGate` 一处）。
// 为什么必须走它：`--write` 是"读全文 → 换掉 §5 那两行标记之间的表 → 写全文"，
// **中间没有指纹比对** ⇒ 两个会话同时生成时，后写者会把先写者的改动整份覆盖掉，且没有任何东西能检出。
// ⚠️ 注意拼接形态：`out` 的是 `md.slice(0, s)` + 新表 + `md.slice(e)` —— **§5 之外的正文全部来自我读到的那份快照**，
//    所以"整文件指纹"正是对的粒度（只比 §5 会漏掉"§1–§4 被整份回退"这一整类丢失，见证据 README §二）。
const { readManagedText, writeManagedText } = require(path.join(__dirname, '..', 'src', 'data-store.js'));

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
  /* ⚠️ `.git` 在**普通仓里是目录**，在 `git worktree` 里是**一个文件**（gitlink，内容一行 `gitdir: …`）。
   * 所以它必须同时在 `TOP_DIRS`（目录形态）和这里（文件形态）—— 否则在 worktree 里会被判「乱放」。
   * 2026-10-21 实测：验证沙箱（`.review/20261021-验证沙箱/`）里 G8 报 `[乱放] .git`，而它是合法 git 产物。 */
  '.git',
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

/* ---------------- 判定：登记与家门（清单与条数以 checkRegistry 的 ①…⑭ 标记为准） ---------------- */

/* ---------------- 判定：根/顶层目录白名单（"其他文件乱放"也抓） ---------------- */

/** 工程根与顶层目录必须落在白名单内。只查两层——第三层以下属实现细节，不 policing。
 *  这一条专治"AI 在工程根随手写 report.md / analysis.json / shot.png / probe.js"。 */
function checkRootLayout(root) {
  const problems = [];
  const rootFiles = new Set(ROOT_FILES.map((f) => f.toLowerCase()));
  const topDirs = new Set(TOP_DIRS.map((d) => d.toLowerCase()));

  /* ⚠️ **必须跟随联结**（2026-10-21 修）。
   * `Dirent.isDirectory()` 对 **junction / symlink 返回 false**（返回 true 的是 `isSymbolicLink()`），
   * 于是"指向目录的链接"会被下面当成**文件**判成「乱放」—— 这是**假红**。
   * 实测现场：`git worktree` 建的验证沙箱里，`node_modules` / `vendor` / `.review` 三个 junction
   * 全部被报 `[乱放] xxx —— 工程根不允许出现这个文件`，而它们都是目录。
   * 同一个 API 陷阱今天已咬过一次（`W26` 批的探针把 junction 读成"没装好"）。
   * 判据：`stat`（会跟随链接）说是目录就算目录；`lstat` 拿不到时才退回 Dirent。 */
  const isDirLike = (dir, e) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
  };

  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const name = e.name;
    const lower = name.toLowerCase();
    if (isDirLike(root, e)) {
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
  // 递归：归档族里若再分子目录，重复段同样要抓（原先只扫一层）
  const walk = (abs, rel) => fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    (e.isDirectory() ? walk(path.join(abs, e.name), rel + '/' + e.name)
      : /\.md$/i.test(e.name) ? [{ file: e.name, rel: rel + '/' + e.name }] : []));
  walk(archDir, 'docs/changelog').forEach(({ file, rel }) => {
    const version = file.replace(/\.md$/i, '');
    const re = new RegExp('^## \\[' + version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'm');
    if (re.test(main)) {
      problems.push({ kind: 'duplicate', rel,
        msg: 'CHANGELOG.md 里仍留着 ## [' + version + '] 段 —— 同一段历史两处副本；'
          + '归档后应从主文件删除（跑一次 release 的滚动，或手动删该段）' });
    }
  });
  return problems;
}

/* ---------------- 第六条判定：交接面的证据指针必须能解析 ----------------
 * 为什么需要：`docs/ROADMAP.md` 的「在飞 / 未收口」小节是**交接面** —— 新接手的 AI 靠它知道
 * "现在做到哪了、下一步做什么"。若它指向的东西已被删或改名，指针就成了**死指针**：
 * 接手者会去找一个不存在的工作目录，或以为那件工作从未发生。
 * 这条只能机械判"指针解不解得开"，判不了"状态写得对不对"、"这串是不是真的那条证据"（那是残差）。
 *
 * **扫描面（2026-10-19 拓宽，实测缺口存档在 `.review/20261019-看板交接面自检/`）**：
 * 原先只查 `.review/` 前缀的反引号 ⇒ 同一张表里另外 31 处反引号**一处都没查**，
 * 其中 3 处是**裸文件名**（`05-残留与未定项.md` 这类）：写的人以为自己在给指针，
 * 而从仓库根解析不出任何东西 —— 读者只能靠猜它属于哪个工作目录。
 * 现在按**形状**决定"这串算不算仓库路径指针"，凡算的一律 `fs.existsSync`：
 * 含 `/` 或以常见文件后缀结尾，且**不是**占位（`< > *`）、**不是**命令行散文（含空格）、
 * **不是**带端口的 host 或 npm 规格（含 `:` / `@`）、**不是**域名形状（`github.com/x/y`）。
 * 不查的那些（函数名 / commit 短哈希 / 版本号 / 命令）本来就**不是路径**，硬查只会制造假红。
 *
 * **同一小节里还有第二件事要核**：状态列的取值必须在**固定词表**内（`HANDOVER_STATUS_VOCAB`）——
 * 词表外的值（实测出现过 `待批准`）把"要不要做"变成自由发挥：读者得自己猜它算不算没做完。
 * 加粗不算区别（`**在飞**` 与 `在飞` 同义）。 */
const HANDOVER_STATUS_VOCAB = ['未开始', '在飞', '外部阻塞', '已收口', '已废弃'];

/** 这一串反引号算不算"**仓库相对**路径指针"（决定要不要去 `fs.existsSync`）。
 *  判**形状**、不判语义 —— 本门禁判不了"这串是不是真的那条证据"。
 *  **能力边界（必须诚实）**：机器本地路径（`%USERPROFILE%\…` / `~/…` / `C:\…` / 以 `/` 或 `\` 开头）
 *  **一律不查** —— 它们指向仓库外，本门禁在任何别的机器上都没有可判的东西。
 *  实测：这条拓宽第一次跑就抓到了本仓自己文档里的 `%USERPROFILE%\.dsh\task-board\ledger-v2.json`
 *  （那是一条**外部真源**的取法说明）—— 那是**判定的假红**，不是文档的错，故按类放行；
 *  放行的这一类由文档自己用「外部真源」写明，不假装查过。 */
function isRepoPathPointer(ref) {
  if (!ref) return false;
  if (/[\s<>*]/.test(ref)) return false;                             // 命令行散文 / 占位写法
  if (/[:@]/.test(ref)) return false;                                // `host:port` / npm 规格 `pkg@1.2.3`
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\//.test(ref)) return false;  // 域名形状（`github.com/owner/repo`）
  if (/^[%\\/~]/.test(ref)) return false;                            // 机器本地 / 绝对路径：仓库外，不查
  const hasSlash = /[\\/]/.test(ref);
  const hasExt = /\.(md|markdown|html?|mjs|cjs|js|json|jsonl|txt|csv|svg|png|jpe?g|vbs|ps1|ya?ml)$/i.test(ref);
  return hasSlash || hasExt;
}

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

  // ── 甲：路径类指针必须解析得出真实文件 / 目录
  const seen = new Set();
  for (let i = start; i < end; i++) {
    for (const m of lines[i].matchAll(/`([^`]+)`/g)) {
      const raw = m[1].trim();
      // 跳过**占位写法**（`.review/<目录>` / `.review/*`）—— 那是规矩说明，不是真指针。
      // （实测：本判定第一次上线就抓到了自己规矩文字里的 `.review/<目录>`。）
      if (/[<>*]/.test(raw)) continue;
      const ref = raw.replace(/[\\/]+$/, '');           // 去掉结尾斜杠
      if (!isRepoPathPointer(ref)) continue;            // 函数名 / commit / 命令 / 版本号都不查
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (!fs.existsSync(path.join(root, ref.split('/').join(path.sep)))) {
        problems.push({ kind: 'handover', rel: 'docs/ROADMAP.md:' + (i + 1),
          msg: '「在飞 / 未收口」的证据指针指向不存在的路径 ' + ref
            + ' —— 交接面不能有死指针。两条出路：① 删工作目录 / 改文件名时同步改这一条；'
            + '② 裸文件名写成**从仓库根解析得出**的完整路径（例：`.review/<日期>-<主题>/某文件.md`）' });
      }
    }
  }

  // ── 乙：状态列取值必须在固定词表内（加粗不算区别）
  // 边界：本判定**假设该小节里"第一列是状态"的表格只有一张** —— 若哪天在同一个
  // `##` 小节里并排放第二张表（第一列不是状态），它会误判。真到那天再按表头定位。
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!/^\|/.test(line)) continue;
    const cell = (line.split('|')[1] || '').replace(/[*`]/g, '').trim();
    if (!cell) continue;                                 // 表头分隔行 / 空行
    if (/^:?-{2,}/.test(cell)) continue;                 // `|---|` 对齐行
    if (cell === '状态') continue;                       // 表头
    if (HANDOVER_STATUS_VOCAB.includes(cell)) continue;
    problems.push({ kind: 'handover-status', rel: 'docs/ROADMAP.md:' + (i + 1),
      msg: '「在飞 / 未收口」的状态列写了 ' + cell + '，不在固定词表内'
        + '（' + HANDOVER_STATUS_VOCAB.join(' / ') + '）—— 词表外的词让"要不要做"靠猜。'
        + '要新状态就同批改本判定的词表与 `docs/ROADMAP.md` 的口径行，别在现场发明一个' });
  }
  return problems;
}

/* ---------------- 第七条判定：代码文件必须被架构文档提到（文档↔代码对应） ----------------
 * 为什么需要：`docs/ARCHITECTURE.md` 是新接手的 AI 认识代码结构的入口（§2 各层职责表）。
 * 实测缺口（以"接手可达性"为标尺的审计）：`src/` 21 个模块里 **3 个没被提到**
 * （`ui-state.js` / `dsh-capabilities.js` / `dsh-sidebar-skill.js`），`scripts/` 连**章节都没有**
 * —— 连 `verify.js`（验证链的单源）都不在架构文档里。新模块写了代码却不进文档，
 * 接手者就不知道它存在。
 * 范围：**递归扫 `COVERED_DIRS` 里的四个目录**（`src/`、`cli/commands/`、`scripts/`、`renderer/`）
 —— 单源就是这个常量，别在此再抄一份清单。
 ⚠️ `renderer/` 是 **2026-10-20 补进来的**（缺口 `G-16` 的第 ⑥ 处）：此前本判定自述"**代码文件**必须被
 架构文档提到"，而扫描面只有前三项 —— 往 `renderer/` 放一个新文件、什么都不登记，**8 条廉价门禁全绿、
 连一行都没点名它**（实测形状与读数见 `.review/20261020-门禁B/README.md` 变体 F）。
 那批因为"不许写 `docs/**`"没法补登记，只能把判据临时落在 `scripts/collateral-check.js` 的
 `ARTIFACT_BATCH` 里兜住、并在那里写明"正确的家是本判定"；本批把家搬回来了：`renderer/` 进
 `COVERED_DIRS`、§2.1 补齐存量登记、`ARTIFACT_BATCH` 的那条兜底**连同欠账册一起删掉**（一处判定只留一份实现）。
 * 为什么必须递归（实测缺口，2026-10-16 T5 批）：非递归时 `scripts/smoke/` 里绝大多数文件
 * 从未登记，而它们**根本没进过扫描面** ⇒ "豁免"不是一条声明，只是"非递归"这个**副作用**：
 * 谁把 `scripts/mutate-gates.js` 挪进 `scripts/tools/`（或谁把这里改成递归），豁免就**无声消失**。
 * `mutate-gates.js` 当初恰好在 `scripts/` 顶层才被本判定抓到 —— 它是本工程唯一检出过真事故的
 * 门禁（G8）的战功之一 ⇒ 这条判定的豁免必须**显式可读**，不能靠扫描面形状。
 * ⇒ 现在豁免只有一种写法：**`EXEMPT_DIRS`**（逐条带理由）+ `docs/ARCHITECTURE.md` §2.6 一行前缀行。
 * 登记口径（两档，别混）：
 *   - **顶层**文件：架构文档里出现**文件名**即算登记（历史口径，本批**刻意不动** ——
 *     实测 89 个顶层文件里 51 个在文档里只有文件名、没有完整路径，立刻改路径口径要补 51 条登记，
 *     那是把"机制"当成"内容"改）。⚠️ 这条口径的**已知假绿**（本批只核实、未修）：
 *     `arch.includes(文件名)` 是**子串匹配、不是路径** ⇒ 文件名恰好出现在文档别处（哪怕一句散文）
 *     就判"已登记"（读数与复现脚本见 `.review/20261016-T5-G8豁免/`；要收紧另开一批）。
 *   - **子目录**文件：必须按**完整相对路径**入档（`scripts/tools/x.js`）。否则"同名文件换个目录"
 *     会靠顶层那条登记蒙混过关 ⇒ 移个位置就等于免检。规则确实**相同**的目录（有目录级说明 +
 *     自描述命名，逐份登记只增维护面而无收获）整目录登记进 `EXEMPT_DIRS`。
 * 这两档合起来才是"现状零新登记即通过"：递归**不带来任何新增登记欠账**。 */
const COVERED_DIRS = [
  { dir: 'src', what: '共享核心模块' },
  { dir: 'cli/commands', what: 'CLI 命令层' },
  { dir: 'scripts', what: '脚本层' },
  { dir: 'renderer', what: '渲染层模块' }
];

/** **子目录豁免的显式声明 —— 本判定的唯一豁免判据**。`{ dir, why }`，`dir` 按前缀口径（结尾斜杠）。
 *  语义是"**这个目录里的文件不逐份登记**"，不是"这个目录不受管"：它们仍受 G1/G5/V1/V2 等门禁约束，
 *  这里只免掉"逐文件进 §2.6 表"这一条。
 *  ⚠️ 加一条之前先问：这个目录真的**规则相同**吗（一份目录级说明 + 自描述命名就能覆盖全部文件）？
 *  规则不同就该拆目录，而不是加豁免 —— 与 `docs/ARCHITECTURE.md` §5「归档族由前缀行统一覆盖、
 *  不需要逐份登记；例外只开给规则确实不同的目录」是**同一条判断标准**。 */
const EXEMPT_DIRS = [
  { dir: 'scripts/smoke/', why: '冒烟断言域：域号 + 文件名自描述、由 `smoke-assertions.js` 按文件名顺序拼接执行'
    + '（目录级说明在 `docs/ARCHITECTURE.md` §2.6 前缀行）；逐份登记等于把同一份清单抄两遍' },
  { dir: 'scripts/vision/', why: '离屏/读图取证工具：同一套目录级说明 + 自描述命名（§2.6 前缀行），'
    + '判据与证据落在 `.review/`，逐份登记只增维护面而无收获' },
  { dir: 'tests/', why: '单测/集成用例：用例名与它覆盖的对象同名（`X` ↔ `tests/X.test.js`），逐份登记只增维护面；'
    + '本目录**本来也不在 `COVERED_DIRS` 的扫描根里**，登记在此是为了"哪天谁把它加进扫描根/挪进子目录，判定不变"' }
];

/** 递归列出 `relDir` 下全部 `.js`，返回**相对工程根**的 POSIX 路径（已排序）。
 *  读不出来的子目录**不静默吞**：交给上层（不存在的目录由调用方先判存在性）。 */
function listJsFiles(absDir, relDir, out) {
  out = out || [];
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir + '/' + e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listJsFiles(path.join(absDir, e.name), rel, out);
    } else if (/\.js$/i.test(e.name)) out.push(rel);
  }
  return out.sort();
}

/** 是否落在显式豁免的目录里（前缀口径，与 `ARCHIVE_PREFIXES` 同形） */
function isExemptFile(rel) {
  return EXEMPT_DIRS.some(({ dir }) => (rel + '/').startsWith(dir.endsWith('/') ? dir : dir + '/'));
}

/** 从架构文档里抽出**登记行** = 每个表格行的**第一列**（文件列），返回 `{line, cell}`。
 *
 *  为什么要这样抽（2026-10-20 收口的一处假绿）：旧判定是 `arch.includes(文件名)` —— **全文子串**，
 *  于是"某文件没进登记表、但正文某句散文（或**别人那一行的职责列**）提到它名字"就判已登记。
 *  实测形状（`renderer/sanitize.js` 等 4 个）：登记表里没有它，§2.3 有一句"消毒 `sanitize.js`"，
 *  判定照样绿 ⇒ 新接手的 AI 按 §2 认识代码结构时**看不见它**。（那 4 处已由同批补登记修掉；
 *  本条判定以前抓不到它们，是它自己的洞。）
 *  为什么只认**第一列**而不是"任一表格行"：职责列里常常提到**别的**文件名
 *  （例：`dsh-fixture-freshness.js` 那一行的职责写着 `scripts/cli-integration.js`）——
 *  "被别人的职责提了一嘴"与散文提一嘴同型，只是换了个位置。真正的登记 = 这个名字是**那行自己的主语**。
 *  实测读数（收口时）：受判 119 个文件里 **118** 个自己就是某张表的一行主语，唯一例外是
 *  `scripts/mcp-server.js`（只在 §2.5 的标题与 §6 一条任务行的职责列里出现）⇒ 收紧到"第一列"
 *  **不产生假红**，只把这一处真缺口暴露出来（该处已补登记行）。
 *  能力边界：① 判不了"这一行写的内容对不对"（只判"这个名字是不是某行主语"）；
 *  ② 也判不了"它该登记在哪一层"（`§2.1/§2.3/§2.6` 的分层是人的判断，报错里只给三个候选）；
 *  ③ **可以**把名字塞进任何一张无关表格的第一列来骗过本条 —— 那是"故意绕过"，与"忘了登记"不同类。 */
function registrationRows(md) {
  const out = [];
  String(md || '').split(/\r?\n/).forEach((line, i) => {
    if (!/^\s*\|/.test(line)) return;                       // 只认表格行
    const cells = line.split('|');
    if (cells.length < 3) return;                           // `|` 开头的行切出来首尾是空串
    let cell = (cells[1] || '').replace(/\*\*/g, '').replace(/`/g, '');
    cell = cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();   // 去掉 markdown 链接语法，留文字
    if (!cell || /^-+$/.test(cell)) return;                  // 分隔行
    if (cell === '文件' || cell === '文档') return;           // 表头
    out.push({ line: i + 1, cell: cell });
  });
  return out;
}

/** 名字边界匹配：前后都不许是标识符字符（**`.` 也算** —— 否则 `app.js.bak` / `app.jsx` 会把 `app.js`
 *  的登记蒙过去；允许前面是 `/` `` ` `` `|` 空格 —— 路径写法照样命中）。
 *  为什么要边界：不做边界就等于又开了一个"子串匹配"的口子，而子串匹配正是这一条判定旧实现的病根。 */
function nameHit(text, key) {
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Za-z0-9_.\\-])' + esc + '($|[^A-Za-z0-9_.\\-])').test(String(text || ''));
}

function checkModuleCoverage(root) {
  const problems = [];
  const archPath = path.join(root, 'docs', 'ARCHITECTURE.md');
  if (!fs.existsSync(archPath)) return problems;
  const arch = fs.readFileSync(archPath, 'utf8');
  const rows = registrationRows(arch);
  COVERED_DIRS.forEach(({ dir, what }) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    listJsFiles(abs, dir).forEach((rel) => {
      if (isExemptFile(rel)) return;              // 显式豁免 —— 不再靠"非递归"这个副作用
      const inSubdir = rel.slice(dir.length + 1).includes('/');
      // 顶层 = 文件名口径；子目录 = 完整路径口径（防"同名换目录"免检）。
      // 两档都**只在登记行（表格第一列）里找**，不再全文子串匹配（见 `registrationRows` 的注释）。
      const key = inSubdir ? rel : path.posix.basename(rel);
      const registered = rows.some((r) => nameHit(r.cell, key));
      if (registered) return;
      problems.push({ kind: 'module-cover', rel,
        msg: what + '里的这个文件没有被 `docs/ARCHITECTURE.md` 的**登记表行**收进去 —— '
          + '新接手的 AI 靠 §2 认识代码结构，新增文件要同批登记（'
          + (inSubdir
            ? '子目录文件按**完整相对路径**登记进它所属层的那张表（渲染层 §2.1 / 共享核心 §2.3 / 脚本层 §2.6）；'
              + '若整个目录规则确实相同，把它加进 `EXEMPT_DIRS` 并在 §2.6 补一行前缀行'
            : '§2.1 / §2.3 / §2.6 表')
          + '）。⚠️ 只在**散文里提到名字不算入档**（那是本判定以前的假绿来源：'
          + '`arch.includes(文件名)` 是全文子串匹配，一句"消毒 `sanitize.js`"就能让整条判定变绿）' });
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
 * 两类都必须在 `docs/DATA-FORMAT.md` 里出现。
 *
 * ⚠️ 2026-10-25 订正（旧判据在空转，实测）：原先"必须在契约里"判的是
 *   `new RegExp('\\b' + leaf + '\\b').test(整份 DATA-FORMAT.md)` —— 即「**这个词**在文档里出现过」，
 *   而报文说的是「**契约缺字段**」。两者不是一回事：实测把契约表里 `| meta.author |` 或
 *   `| background |` 的**整行删掉**，本门禁仍 exit 0（因为这两个词还在 JSON 示例里出现）。
 *   这与下面 `inSchema` 注释里那句「词出现过 ≠ 被校验」是同一个坑 —— 本判定当年自己踩了它，
 *   而那句警告就写在同一份代码里。
 *   ⇒ 修法是**让每条字段声明它该去哪找**（第三列 `where`），不是把正则收紧：收紧会让
 *     `items` / `detailMode` 立刻变红，而它们的权威契约确实不在 DATA-FORMAT 的契约表里。 */
/* 第三列 `where` = 这条字段的权威契约**在哪一处**（**封闭三档**，别自由发挥 —— 想加第四档时先回答
 * "那一处为什么不可判"，否则它就是给判据开的例外口子）：
 *   'DATA-FORMAT'        ⇒ 在 `docs/DATA-FORMAT.md` 的**契约表行**里找（`|` 切行、取第一列、
 *                          去掉反引号/空白/列表后缀 `[]` 后，与**完整字段名或叶子名逐字相等**）。
 *                          **不是**"这个词在整份文档里出现过" —— 两者不是一回事，见下面判据本体上方的
 *                          2026-10-25 订正说明。
 *   'ITEM-MODEL#<行号>'  ⇒ 在 `docs/ITEM-MODEL.md` 的**表行**里找（同上口径）。`#<行号>` 只作
 *                          **人类定位用**（"去那份文档第 N 行附近那张表看"），判据**按表行扫、不按行号硬编码** ——
 *                          行号会随编辑漂移，钉死它等于让判据变成化石。
 *   'DATA-FORMAT:prose'  ⇒ 该字段**只以散文承载**（那份文档里没有它的表行，是被审过的合法情况）：
 *                          不判表行，改判「该词在 `docs/DATA-FORMAT.md` 出现 ≥1 次」+ **在册豁免**
 *                          （`PROSE_EXEMPT`；上界 `PROSE_EXEMPT_MAX` 只减不增 —— 弱判据不能想加就加，
 *                          否则"把它标成 prose"就成了绕过表行判据的后门）。
 *
 * 为什么必须有第三列（而不是把正则收紧）：收紧正则会立刻让 `items` / `detailMode` 变红，而它们的权威契约
 * 确实不在 DATA-FORMAT 的契约表里（前者在 `ITEM-MODEL.md` §7 的"终态定位 / 冻结点"表，后者只以散文承载）——
 * 那时"让门禁变绿"的唯一办法就是去改那两份文档，而"文档跟着判据改"正是本门禁要防的事。 */
const SCHEMA_FIELDS = [
  ['meta.name', true, 'DATA-FORMAT'], ['meta.formatVersion', true, 'DATA-FORMAT'],
  ['meta.layout', true, 'DATA-FORMAT'], ['meta.rootMode', false, 'DATA-FORMAT'],
  ['meta.author', false, 'DATA-FORMAT'], ['meta.version', false, 'DATA-FORMAT'],
  ['format', true, 'DATA-FORMAT'], ['data', true, 'DATA-FORMAT'], ['assoc', true, 'DATA-FORMAT'],
  ['id', true, 'DATA-FORMAT'], ['topic', true, 'DATA-FORMAT'], ['children', true, 'DATA-FORMAT'],
  ['detail', true, 'DATA-FORMAT'], ['images', true, 'DATA-FORMAT'], ['files', true, 'DATA-FORMAT'],
  ['links', true, 'DATA-FORMAT'], ['tags', true, 'DATA-FORMAT'], ['localPath', true, 'DATA-FORMAT'],
  ['qa', true, 'DATA-FORMAT'], ['origin', true, 'DATA-FORMAT'], ['background', false, 'DATA-FORMAT'],
  // 条目层（v3）：`items` 与 `detailMode` 都是契约字段，但**权威契约不在 DATA-FORMAT 的契约表里**：
  //   `items` 在 `docs/ITEM-MODEL.md` §7「终态定位 / 冻结点」那张表里有 `items[]` 行（DATA-FORMAT 只有散文指针）；
  //   `detailMode` 全文件只有散文（"显式二选一"），没有表行 —— 故标 prose 并在册，不拿它去撞表行判据。
  ['items', true, 'ITEM-MODEL#346'],
  ['detailMode', true, 'DATA-FORMAT:prose'],
];

/** 第三列的**封闭取值**（判据只认这三种；别的值一律判红，不许静默当绿 —— 拼错一个字母就等于没判）。 */
const CONTRACT_WHERE_KINDS = ['DATA-FORMAT', 'ITEM-MODEL', 'DATA-FORMAT:prose'];

/** prose 承载的**在册豁免**：只登记"这一处确实没有表行、且证据是散文"的个案，上界 = 当前条数（只减不增）。
 *  加一条之前先问：它真的**没有**可判的表行吗？（有表行却标 prose = 把强判据换成弱判据 ⇒ 应当直接补表行）
 *  复审时机：每次改动本判定的口径时；审：改本文件的人。 */
const PROSE_EXEMPT = ['detailMode'];
const PROSE_EXEMPT_MAX = 1;

/** 把表格一列的内容规范化成"字段名"：去反引号、去空白、去掉列表后缀 `[]`。
 *  为什么要去 `[]`：`docs/ITEM-MODEL.md` §7 那张表的第一列写的是 `items[]`（字段本体叫 `items`）。
 *  而 `| images[] / files[] |` 这种合并行规范化后仍是 `images[]/files[]`（中间那段不等于任何单字段名），
 *  ⇒ 不会被误认成单字段 —— 否则删掉 `items[]` 那一行时，别的行还能替它变绿。 */
function normContractCell(cell) {
  return String(cell).replace(/`/g, '').replace(/\s+/g, '').replace(/\[\]$/, '');
}

/** 抽出一份文档里的**表行第一列**（判"这个字段有没有契约表行"只用这个，不用全文子串）。
 *  复用 `tableDataRows`：表头行与分隔行由它**结构性地**排除 —— 不再另写一份"什么算表格行"。
 *  为什么特别强调复用：本条判定当年就是被"第二份更宽的判法"（全文正则）骗过去的。 */
function contractTableCells(text) {
  const out = [];
  for (const [line, idxs] of tableDataRows(text)) {
    const cells = String(line).trim().split('|').map((c) => c.trim());
    if (cells.length < 3) continue;                 // 只剩单列的行不算契约表
    const first = normContractCell(cells[1]);
    if (!first) continue;
    (idxs || []).forEach((n) => out.push({ line: n, cell: first }));
  }
  return out;
}

/**
 * 契约覆盖的**判据本体**（纯函数：吃字段清单 + 两份文档文本 + 豁免册 ⇒ 单测能直接喂假输入，两侧都打一遍）。
 *
 * 判据按第三列 `where`（封闭取值见 `CONTRACT_WHERE_KINDS`）分档：
 *   · 表行档：**第一列逐字相等**（完整字段名或叶子名），不是"词在全文出现过"；
 *   · prose 档：至少出现 ≥1 次 **且**在册 —— 弱判据不能想加就加，否则"标成 prose"就绕过表行判定了。
 *
 * @param {object} o
 * @param {Array} o.fields `SCHEMA_FIELDS`（三列；单测可喂假清单）
 * @param {string} o.dfText `docs/DATA-FORMAT.md` 全文
 * @param {string} [o.itemText] `docs/ITEM-MODEL.md` 全文（缺 ⇒ 采不到真值＝红）
 * @param {string[]} [o.proseExempt] prose 豁免册（默认模块里的 `PROSE_EXEMPT`）
 * @param {number} [o.proseMax] 豁免册上界（默认 `PROSE_EXEMPT_MAX`）
 * @returns {{problems: Array, stats: {fields:number, byWhere:object, prose:string[],
 *   proseDangling:string[], proseMax:number, proseExcess:number}}}
 */
function judgeContractCoverage(o) {
  const opt = o || {};
  const fields = Array.isArray(opt.fields) ? opt.fields : SCHEMA_FIELDS;
  const dfText = String(opt.dfText == null ? '' : opt.dfText);
  const itemText = String(opt.itemText == null ? '' : opt.itemText);
  const proseExempt = Array.isArray(opt.proseExempt) ? opt.proseExempt : PROSE_EXEMPT;
  const proseMax = Number.isFinite(opt.proseMax) ? opt.proseMax : PROSE_EXEMPT_MAX;
  const dfCells = contractTableCells(dfText);
  const itemCells = contractTableCells(itemText);
  const problems = [];
  const stats = {
    fields: fields.length,
    byWhere: { 'DATA-FORMAT': 0, 'ITEM-MODEL': 0, 'DATA-FORMAT:prose': 0 },
    prose: [], proseDangling: [], proseMax, proseExcess: 0
  };
  const push = (kind, rel, msg) => problems.push({ kind, rel, msg });
  const tableHit = (cells, f, leaf) => cells.some((c) => c.cell === f || c.cell === leaf);

  fields.forEach((row) => {
    const f = String(row[0]);
    const validated = row[1] === true;
    const where = typeof row[2] === 'string' ? row[2] : '';
    const leaf = f.split('.').pop();
    const why = validated ? '`src/schema.js` 校验它，' : '它是契约声明的字段，';

    if (!where) {
      push('contract-stale', 'scripts/docs-registry-check.js',
        '字段 `' + f + '` 的第三列（`where`）缺失 —— 这条字段**该去哪一处找**没有声明，'
          + '判据就无从判定（不声明 ≠ 放过）。取值为封闭三档：' + CONTRACT_WHERE_KINDS.join(' / ')
          + '，另收 `ITEM-MODEL#<行号>` 这种带人类定位的写法');
      return;
    }

    if (where === 'DATA-FORMAT') {
      if (tableHit(dfCells, f, leaf)) { stats.byWhere['DATA-FORMAT']++; return; }
      push('contract', 'docs/DATA-FORMAT.md',
        '数据契约缺字段 `' + f + '`：' + why + '但 `docs/DATA-FORMAT.md` 的**契约表**里没有它的行 —— '
          + '本判据按**表行第一列逐字比对**，不是"这个词在文档里出现过"（`' + leaf
          + '` 可能只出现在 JSON 示例或散文里，那不算契约）。处置：在 §1/§2 那张字段表的对应位置补一行；'
          + '若它的权威契约确实不在这份文档，把第三列改成它真正所在的那一处');
      return;
    }

    if (where.indexOf('ITEM-MODEL') === 0) {
      // `#<行号>` 只作**人类定位用**：判据按表行扫，**刻意不用**那个行号（行号会随编辑漂移）。
      const lineHint = where.includes('#') ? where.slice(where.indexOf('#') + 1) : '';
      if (!itemCells.length) {
        push('unreadable', 'docs/ITEM-MODEL.md',
          '字段 `' + f + '` 声明契约在 `docs/ITEM-MODEL.md`'
            + (lineHint ? '（约 :' + lineHint + '）' : '') + ' 的表里，但那份文档读不到、或里面没有表 —— '
            + '**采不到真值＝红**（不许静默当绿）');
        return;
      }
      if (tableHit(itemCells, f, leaf)) { stats.byWhere['ITEM-MODEL']++; return; }
      push('contract', 'docs/ITEM-MODEL.md',
        '数据契约缺字段 `' + f + '`：' + why + '但 `docs/ITEM-MODEL.md` **那张表**里没有它的行'
          + (lineHint ? '（`where` 给的人类定位是约 :' + lineHint + '；判据按表行扫，不认行号）' : '')
          + ' —— 补回那一行，或把第三列改成它真正所在的那一处');
      return;
    }

    if (where === 'DATA-FORMAT:prose') {
      stats.prose.push(f);
      if (!new RegExp('\\b' + leaf + '\\b').test(dfText)) {
        push('contract', 'docs/DATA-FORMAT.md',
          '数据契约缺字段 `' + f + '`：它标为「只以散文承载」（第三列 `DATA-FORMAT:prose`），'
            + '但 `docs/DATA-FORMAT.md` 里连这个词都没有 —— prose 档的最低要求是**出现 ≥1 次**');
        return;
      }
      if (proseExempt.indexOf(f) < 0) {
        push('contract-stale', 'scripts/docs-registry-check.js',
          '字段 `' + f + '` 标成「只以散文承载」，但**不在** `PROSE_EXEMPT` 册上 —— prose 是弱判据'
            + '（"词出现过"），不登记就等于给契约表判定开后门。两条路：① 它有表行 ⇒ 第三列改回 '
            + '`DATA-FORMAT` 并补表行；② 确实只以散文承载 ⇒ 同批把它登记进 `PROSE_EXEMPT` 并抬 '
            + '`PROSE_EXEMPT_MAX`（会留在 diff 里 = 一次可见的动作）');
        return;
      }
      stats.byWhere['DATA-FORMAT:prose']++;
      return;
    }

    push('contract-stale', 'scripts/docs-registry-check.js',
      '字段 `' + f + '` 的第三列（`where`）`' + where + '` 不在封闭取值内：'
        + CONTRACT_WHERE_KINDS.join(' / ') + '（或 `ITEM-MODEL#<行号>`）—— '
        + '值不在表内是**配置错误**：拼错一个字母就等于这条字段没人判，而且它会静默绿');
  });

  // prose 豁免册的两个方向：**超上界**判红（弱判据不许悄悄扩张）；**册上已结清**只报告
  // （把登记删掉本身就是合法结清方式，不判红 —— 与 `README_STATUS_DEBT` 的悬挂条同一档）。
  if (proseExempt.length > proseMax) {
    stats.proseExcess = proseExempt.length - proseMax;
    push('contract-stale', 'scripts/docs-registry-check.js',
      'prose 豁免册超上界：现有 ' + proseExempt.length + ' 条 > `PROSE_EXEMPT_MAX` = ' + proseMax
        + ' —— 弱判据的豁免**只减不增**（多一条 = 多一个"不判表行"的字段）');
  }
  stats.proseDangling = proseExempt.filter((n) => stats.prose.indexOf(n) < 0);
  return { problems, stats };
}

/** 判定入口：读文件 → 先在"清单 ↔ schema"上自查，再把"契约位置"交给 `judgeContractCoverage`。
 *  @param {string} root 工程根
 *  @param {object} [statsOut] 可选：把读数（每个 `where` 各判了几条 / prose 那几条是谁）回填给它，
 *    让 `main()` 的通过读数能带上分母与 prose 名单 —— 只报一个 ✓ 会把"没判"读成"判过了"。
 *  @returns {Array} problems */
function checkContractCoverage(root, statsOut) {
  const problems = [];
  const schemaPath = path.join(root, 'src', 'schema.js');
  const dfPath = path.join(root, 'docs', 'DATA-FORMAT.md');
  if (!fs.existsSync(schemaPath) || !fs.existsSync(dfPath)) return problems;
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const df = fs.readFileSync(dfPath, 'utf8');
  const itemPath = path.join(root, 'docs', 'ITEM-MODEL.md');
  // 读不到就算空文本：声明了 `ITEM-MODEL…` 的字段会在判据里判红（采不到真值＝红），不静默跳过。
  const itemText = fs.existsSync(itemPath) ? fs.readFileSync(itemPath, 'utf8') : '';
  /* 节点级字段名单从 `src/schema.js` 取（**唯一一份**：`NODE_FIELD_NAMES` 只列**节点上**的字段）——
   * 不在本文件再抄一份字段名。
   * ⚠️ 2026-10-25 订正一处**错注释**：原文写「非节点级（`meta.*` / `format` / `data` / `assoc`）
   * **不在那份表里**」，读起来像"它们没有契约表行" —— 与实际不符：`docs/DATA-FORMAT.md` §1 的
   * **项目级契约表**里 `meta.*` 六个 + `format` / `data` / `assoc` **都有表行**（本判定现在正是按
   * 表行判的，这 9 条全绿）。正解分两句说：它们**不在 `NODE_FIELD_NAMES` 里**（不是节点字段），
   * 但**各有自己的契约表行**。两件事混成一句，下一个人就会照着写出第二个"只在散文里找"的漏判。 */
  let nodeFields = new Set();
  try { nodeFields = new Set(require(path.join(root, 'src', 'schema.js')).NODE_FIELD_NAMES || []); }
  catch (e) { nodeFields = new Set(); }
  /* 「schema 校验了它」的判据 = schema 真的**读了节点的这个字段**（`node.<名>`），
   * 而不是"这个词在这个文件里出现过"。为什么必须收紧（实测，2026-10-12）：
   * `src/schema.js` 现在同时住着那张**契约字段表**（纯数据：字段名 + 档位 + 一句话），
   * 于是 `background`（只出现在表里、schema 并不校验它）被旧判据当成"已校验"而报红，
   * 报文的建议是"把分类改成 true" —— 那会让清单**说谎**。词出现过 ≠ 被校验。
   * 反向读法也更准：真被校验的字段一定能看到 `node.<名>`（实测 13 个节点级字段全部命中）。 */
  const inSchema = (leaf) => (nodeFields.has(leaf)
    ? new RegExp('\\bnode\\.' + leaf + '\\b').test(schema)
    : new RegExp('\\b' + leaf + '\\b').test(schema));
  SCHEMA_FIELDS.forEach(([f, validated]) => {
    const leaf = f.split('.').pop();
    const present = inSchema(leaf);
    if (validated && !present) {
      problems.push({ kind: 'contract-stale', rel: 'scripts/docs-registry-check.js',
        msg: '字段清单检查表已过期：`' + f + '` 标为"schema 校验"，但 `src/schema.js` 里找不到 —— '
          + 'schema 改过名/删过字段？请同步 SCHEMA_FIELDS 常量（它必须与 schema 一起演进）' });
      return;
    }
    if (!validated && present) {
      problems.push({ kind: 'contract-stale', rel: 'scripts/docs-registry-check.js',
        msg: '字段清单检查表已过期：`' + f + '` 标为"仅契约、不校验"，但它已出现在 `src/schema.js` —— '
          + '请把 SCHEMA_FIELDS 里该条的第二项改成 true（分类要与实现一致）' });
      return;
    }
    // 契约位置的判定**不在这里**：它要按每条声明的第三列去"那一处"找，见 `judgeContractCoverage`。
    // 这里原先做的是 `new RegExp('\\b' + leaf + '\\b').test(df)`（"这个词在整份文档里出现过"），
    // 于是删掉契约表的整行仍绿 —— 订正说明见本判定头注的 2026-10-25 那一段。
  });

  /* ---- 反向：schema 里出现过的字段必须都在清单里 ----
   * 上一条只做「清单 → schema/契约」单向，于是**新字段只要不写进清单就完全不被检查** ——
   * 这正是本工程反复治过的"要求过窄"（判定存在但对新对象不生效）。
   * 实测：`localPath` 加进 schema 后一路绿灯，直到做这次补强才发现它从未被覆盖；
   * `background` 同样长期不在清单里。
   * 口径：`src/schema.js` 里出现的 `node.<标识符>`，每一个都必须在 SCHEMA_FIELDS 里登记。
   * 报错即教程：告诉人"加进 SCHEMA_FIELDS（并确认 DATA-FORMAT 也写了）"。 */
  const fieldIds = new Set(SCHEMA_FIELDS.map(([f]) => f.split('.').pop()));
  const seen = new Set();
  for (const m of schema.matchAll(/\bnode\.([A-Za-z_][A-Za-z0-9_]*)/g)) seen.add(m[1]);
  seen.forEach((f) => {
    if (fieldIds.has(f)) return;
    problems.push({ kind: 'contract-stale', rel: 'scripts/docs-registry-check.js',
      msg: '字段清单检查表漏了新字段 `' + f + '`：它出现在 `src/schema.js`，但不在 `SCHEMA_FIELDS` 里 —— '
        + '不登记就**永远不会被检查**（本条检查是"清单 → 契约"单向的）。'
        + '请把它加进 `SCHEMA_FIELDS`（第二项标 true/false 表示 schema 是否校验它），'
        + '并确认 `docs/DATA-FORMAT.md` 也写了它' });
  });

  /* ---- 契约位置：按每条自己声明的第三列 `where` 去那一处找 ----
   * 这一步是 2026-10-25 换掉的判法：旧实现是"这个词在整份 DATA-FORMAT 里出现过"，
   * 于是**删掉契约表整行仍绿**（实测 `| meta.author |` / `| background |` 各一次）。
   * 新判法只看**表行第一列**（或 prose 档的在册散文），见 `judgeContractCoverage`。 */
  const judged = judgeContractCoverage({ fields: SCHEMA_FIELDS, dfText: df, itemText: itemText,
    proseExempt: PROSE_EXEMPT, proseMax: PROSE_EXEMPT_MAX });
  judged.problems.forEach((p) => problems.push(p));
  if (statsOut && typeof statsOut === 'object') Object.assign(statsOut, judged.stats);
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
  const walk = (abs, rel) => {
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) {
      problems.push({ kind: 'banner', rel,
        msg: '归档目录读不出来（' + (e.code || '?') + '）—— **采不到真值＝红**，不许静默跳过' });
      return;
    }
    for (const e of items) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) { walk(path.join(abs, e.name), r); continue; }     // 递归：子目录里的旧稿也是归档
      if (!/\.(md|html?)$/i.test(e.name)) continue;
      let head;
      try { head = fs.readFileSync(path.join(abs, e.name), 'utf8').split('\n').slice(0, 8).join(' '); }
      catch (err) {
        problems.push({ kind: 'banner', rel: r,
          msg: '归档文档读不出来（' + (err.code || '?') + '）—— **采不到真值＝红**，不许静默跳过' });
        continue;
      }
      if (!BANNER_RE.test(head)) {
        problems.push({ kind: 'banner', rel: r,
          msg: '归档文档开头没有「历史」横幅 —— 它会被 grep 到，接手者可能当成现状；'
            + '请在开头加一行（HTML 用注释）：`> ⚠️ 历史归档（YYYY-MM）：不是现状、勿据此改动`' });
      }
    }
  };
  const dir = path.join(root, 'docs', 'archive');
  if (fs.existsSync(dir)) walk(dir, 'docs/archive');
  return problems;
}

/* ---------------- 第九条判定：工作目录必须声明死活 ----------------
 * 为什么需要：`.review/` 是"可随时整目录删除"的工作产物区，但**没有任何东西告诉接手者
 * 哪些目录还在用**。实测：一个工作目录当天还在被写入（70 个文件），却没有任何状态标记 ——
 * 接手者要么误删在飞工作，要么把陈旧分析当现状。
 * 规则：`.review/` 的**直接子目录**必须有 `README.md` 声明状态（在飞 / 已收口 / 已废弃 / 已完成）；
 * 直接放在 `.review/` 下的散落文件豁免（它们是单文件产物，没有"目录死活"可言）。
 * **工具自建目录豁免**：`.review/vision/` 由 `scripts/vision/record.js` 按需创建，
 * 是"读图留痕"的固定用途存储（用途已在 §2.4 / §4b 写明），不属于"某次任务的临时工作目录"。
 *
 * ── 2026-10-20 收口的一处**规则宽、实现窄**（本判定的旧实现是假的）──
 * 旧实现只判 `fs.existsSync(README.md)`：**任意空文件都能让它变绿**，而规则要的是「**声明状态**」。
 * 实测形状：`.review/` 的受判直接子目录**全部**都有 README ⇒ 本判定全绿，而其中
 * **39 个**通篇不含任何状态词 ⇒ "接手者能不能删"这件事**从来没被判过一次**。
 * ⇒ 现在真的判状态词：`README.md` 正文里必须出现 `WORKDIR_STATUS_VOCAB` 里的一个词。
 * 词表为什么是这四个（**不自创**，两条依据都写在这里）：
 *   · `在飞` / `已收口` / `已废弃` —— **规则原文**就是这三个（本节上面那句，也是报错文案的 `状态：…`）；
 *   · `已完成` —— **实测加进来的**：同一批清点里 16 个目录用它声明状态（其中 7 个除此之外
 *     一个词都没有），它与 `已收口` 同义、同样直接回答"能不能删"。不认它只会把这 7 个
 *     **本来已经声明了状态**的目录推进欠账册 ⇒ 那是假红。
 *   · **刻意不认**的写法（每条都有实测理由，不是漏了）：`收口` 是动词（"全链收口"这类叙述
 *     出现在 75 个目录里），而 `未收口` 也含这两个字 ⇒ 认它会把**反向状态读成正向**；
 *     `未收口` / `已落地` / `已交付` 这类近义散文让下一个接手者靠猜，正是这条规则要消灭的形态
 *     ⇒ 它们进欠账册（销账动作 = 改写成词表里的一行），**不放宽词表去迁就**。
 * 边界（`B8`：判不了的那半也要写清楚）：
 *   · 只判"**有没有**状态词"，判不了"这个词是不是**当前**状态"、"是不是指**本目录**"
 *     （例：README 里写"上一批已收口、本批在飞"，两词都在 ⇒ 通过）。那要读语义，属人工残差。
 *   · 也不判它与 `docs/ROADMAP.md`「在飞 / 未收口」是否**一致** —— 两侧词表不同（那份是表格列
 *     取值 `HANDOVER_STATUS_VOCAB`，本份是 README 正文词），合并会把"写在哪"这件事混掉。
 * 存量怎么办（`B4` 的封闭欠账册，**不许一次全判红**——长期红的门禁下场是被关掉）：
 * `README_STATUS_DEBT` 在册的放过、但**计数必须可见**；不在册的一律判红；
 * **在册却已经声明了状态 ⇒ 判红**（修好忘销账）；条数有上界（只减不增）。 */
const WORK_DIR_EXEMPT = new Set(['vision']);

/** 第⑨条认哪些状态词（**唯一来源** —— 理由见上面那段注释，别在别处再抄一份词表）。 */
const WORKDIR_STATUS_VOCAB = ['在飞', '已收口', '已废弃', '已完成'];

/** 从 README 正文里取出命中的状态词（按词表顺序返回，让输出稳定、可逐字比对）。 */
function readmeStatusWords(text) {
  const t = String(text || '');
  return WORKDIR_STATUS_VOCAB.filter((w) => t.includes(w));
}

/** 欠账的**销账动作**：统一一份（39 条各抄一遍只会多出 39 份会各自漂的副本）。
 *  写在这里而不是每条 entry 里 —— 与 `NEXT_STEP_BANNED` / `EXEMPT_DIRS` 同一处置。
 *  ⚠️ **删目录也算结清**：`.review/` 的规矩就是"可随时整目录删除"，
 *  所以销账册上的目录哪天不存在了，本判定**不判红、只报告**（判红会让"删杂物"这个正确动作变红）。 */
const README_STATUS_DEBT_CLOSE = '在它的 `README.md` 里写一行 `状态：在飞|已收口|已废弃|已完成`，'
  + '或**直接删掉这个已废弃的目录**（删目录也算结清），然后**同批**把这条从本册删掉';

/** **封闭欠账册**：第⑨条"真的判状态词"上线时仓库里已经存在的存量（只减不增）。
 *  为什么要有这本册：一次性全判红 ⇒ 长期红 ⇒ 没人再看门禁（`B4` 明令禁止）。
 *  三条机械判定（与 `DUP_ROW_EXEMPT` / `WRITE_OUTLET_DEBT` / `NONVISUAL_DEBT` 完全一致）：
 *    ① **在册** ⇒ 放过，但**计数在通过行里可见**；
 *    ② **不在册** ⇒ 判红（新目录不许再写不带状态的 README）；
 *    ③ **在册却已声明状态** ⇒ 判红（修好忘销账；`why` 里写了怎么销账）。
 *  第四条是本册**专有**的：账上目录**已不存在** ⇒ 只报告（见 `README_STATUS_DEBT_CLOSE` 的说明）。
 *  ⚠️ 加条目 = 放宽判定，必须同批抬 `README_STATUS_DEBT_MAX` 并在 CHANGELOG 说明为什么。
 *  复审时机：每次改本判定的口径时；审：改本文件的人。 */
const README_STATUS_DEBT = [
  { dir: '20261014-全网借鉴日报',
    why: 'README 通篇不含词表状态词；正文 5.0 KB' },
  { dir: '20261016-R7未核实实测',
    why: 'README 通篇不含词表状态词；正文 25.9 KB' },
  { dir: '20261016-全网借鉴日报',
    why: 'README 通篇不含词表状态词；正文 4.2 KB' },
  { dir: '20261016-改动清单面板',
    why: 'README 通篇不含词表状态词；用的是近义写法 收口/已落地；正文 18.4 KB' },
  { dir: '20261018-文档预览桥-前置取证',
    why: 'README 通篇不含词表状态词；正文 4.7 KB' },
  { dir: '20261018-清扫失败可见',
    why: 'README 通篇不含词表状态词；正文 3.8 KB' },
  { dir: '20261018-陈旧夹具',
    why: 'README 通篇不含词表状态词；正文 2.4 KB' },
  { dir: '20261019-LP节点名格式',
    why: 'README 通篇不含词表状态词；正文 2.5 KB' },
  { dir: '20261019-Markdown残留门禁',
    why: 'README 通篇不含词表状态词；正文 2.9 KB' },
  { dir: '20261019-caps-id-override',
    why: 'README 通篇不含词表状态词；正文 4.0 KB' },
  { dir: '20261019-em坏字销账',
    why: 'README 通篇不含词表状态词；用的是近义写法 收口/未收口；正文 13.6 KB' },
  { dir: '20261019-merge-project',
    why: 'README 通篇不含词表状态词；正文 4.6 KB' },
  { dir: '20261019-preset平面',
    why: 'README 通篇不含词表状态词；正文 8.9 KB' },
  { dir: '20261019-三本书命中率',
    why: 'README 通篇不含词表状态词；正文 37.7 KB' },
  { dir: '20261019-偿三笔债-W1W2W7',
    why: 'README 通篇不含词表状态词；正文 18.2 KB' },
  { dir: '20261019-四本书完整内容',
    why: 'README 通篇不含词表状态词；正文 39.6 KB' },
  { dir: '20261019-域52真渲染复核',
    why: 'README 通篇不含词表状态词；正文 3.4 KB' },
  { dir: '20261019-建49回',
    why: 'README 通篇不含词表状态词；正文 2.5 KB' },
  { dir: '20261019-进程内存原文补全',
    why: 'README 通篇不含词表状态词；正文 43.1 KB' },
  { dir: '20261020-80211真书核对',
    why: 'README 通篇不含词表状态词；正文 32.6 KB' },
  { dir: '20261020-LP-学习链路',
    why: 'README 通篇不含词表状态词；用的是近义写法 已交付；正文 3.6 KB' },
  { dir: '20261020-S2-tag-in-code',
    why: 'README 通篇不含词表状态词；正文 1.8 KB' },
  { dir: '20261020-markdown-star-rootfix',
    why: 'README 通篇不含词表状态词；正文 4.0 KB' },
  { dir: '20261020-内核网络真书核对',
    why: 'README 通篇不含词表状态词；正文 26.8 KB' },
  { dir: '20261020-分隔线残留',
    why: 'README 通篇不含词表状态词；正文 2.8 KB' },
  { dir: '20261020-台账清账',
    why: 'README 通篇不含词表状态词；正文 4.5 KB' },
  { dir: '20261020-收口B',
    why: 'README 通篇不含词表状态词；用的是近义写法 收口；正文 1.0 KB' },
  { dir: '20261020-测试补全',
    why: 'README 通篇不含词表状态词；正文 4.9 KB' },
  { dir: '20261020-词表修正',
    why: 'README 通篇不含词表状态词；正文 5.8 KB' },
  { dir: '20261020-门禁A',
    why: 'README 通篇不含词表状态词；正文 8.1 KB' },
  { dir: '20261020-门禁B',
    why: 'README 通篇不含词表状态词；正文 21.6 KB' },
  { dir: '20261020-阶段2.1-proc-mem',
    why: 'README 通篇不含词表状态词；正文 3.2 KB' },
  { dir: '20261020-阶段2.2-src-fun',
    why: 'README 通篇不含词表状态词；正文 1.0 KB' },
  { dir: '20261020-阶段2.3-wifi7',
    why: 'README 通篇不含词表状态词；用的是近义写法 收口；正文 13.8 KB' },
  { dir: '20261020-阶段2.4-linux-net',
    why: 'README 通篇不含词表状态词；用的是近义写法 已交付；正文 4.6 KB' },
  { dir: '20261020-阶段2.5-topdown',
    why: 'README 通篇不含词表状态词；正文 6.6 KB' },
  { dir: '20261020-阶段2.6-80211',
    why: 'README 通篇不含词表状态词；用的是近义写法 收口；正文 3.8 KB' },
  { dir: 'changelog-size-2026-10-05',
    why: 'README 通篇不含词表状态词；正文 0.7 KB' }
];

/** 欠账条数上界：**只减不增**（写成字面量而不是 `README_STATUS_DEBT.length` ——
 *  后者会算出自己的长度，册子上限就永远不会被触发，等于没有上界）。
 *
 *  ⚠️ **上界必须等于当前条目数**，不能留余量：留 1 格余量就等于"可以悄悄加回 1 条而不触发任何检查"，
 *  而加条目 = 放宽判定 —— 那正是这本封闭册存在的反面。销掉一条就要同批把上界降一格（本行：
 *  2026-10-20 销 `20261020-下沉`（它的 README 已声明 `已收口`）⇒ 39 → **38**）。 */
const README_STATUS_DEBT_MAX = 38;

/** 判定函数（标记在 `checkRegistry()` 里，见那里的 ⑨）。
 *  @param {string} root 工程根
 *  @param {Object} [opts] 依赖注入（给单测用，`B6`：判定逻辑要能被喂输入）
 *  @param {Array} [opts.debt] 欠账册；不给就用模块里的 `README_STATUS_DEBT`（生产路径只走这条）
 *  @param {number} [opts.debtMax] 欠账条数上界；不给就用 `README_STATUS_DEBT_MAX`
 *  @returns {{problems: Array, stats: {dirs:number, declared:number, debt:number, debtStale:number,
 *    exempt:number, debtDangling:string[], debtTotal:number, debtMax:number, vocab:string[]}}}
 *  ⚠️ 返回的是 `{problems, stats}`（以前是裸数组）—— `stats` 就是"在册存量也算看得见"的那一半：
 *  `B8` 要求豁免**计入真值、在门禁输出里可见**，只打印一个 ✓ 会让读者把"没判"读成"判过了"。 */
function checkWorkDirStatus(root, opts) {
  const o = opts || {};
  const sameRoot = !o.rootIsFixture && path.resolve(root) === path.resolve(ROOT);
  // 拿别的根跑（单测 / 变异体检）时**不许**套用真仓那本册：册上写的是真仓的目录名，
  // 套上去会把 fixture 里的同名目录当欠账放过 ⇒ 假绿（与 `NOTE_RESIDUE_DEBT` 同一处置）。
  const debt = Array.isArray(o.debt) ? o.debt : (sameRoot ? README_STATUS_DEBT : []);
  const debtMax = Number.isFinite(o.debtMax) ? o.debtMax : README_STATUS_DEBT_MAX;
  const debtDirs = new Set(debt.map((d) => d.dir));
  const problems = [];
  const stats = { dirs: 0, declared: 0, debt: 0, debtStale: 0, exempt: 0,
    debtDangling: [], debtTotal: debt.length, debtMax: debtMax, vocab: WORKDIR_STATUS_VOCAB.slice() };
  const dir = path.join(root, WORK_DIR);
  if (!fs.existsSync(dir)) return { problems, stats };
  const seen = new Set();
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (!e.isDirectory()) return;
    if (WORK_DIR_EXEMPT.has(e.name)) { stats.exempt++; return; }
    stats.dirs++;
    seen.add(e.name);
    const rel = WORK_DIR + '/' + e.name + '/';
    const readme = path.join(dir, e.name, 'README.md');
    if (!fs.existsSync(readme)) {
      problems.push({ kind: 'workdir', rel: rel,
        msg: '工作目录没有 README.md 声明状态 —— 补三行（主题 / 开始日期 / 状态：'
          + WORKDIR_STATUS_VOCAB.join('|') + '），'
          + '否则接手者无法判断它能否删除，也无法与 `docs/ROADMAP.md` 的「在飞 / 未收口」对上' });
      return;
    }
    let text;
    try { text = fs.readFileSync(readme, 'utf8'); } catch (err) {
      // 读不出 ≠ 通过（`A5`：采不到真值 = 红）
      problems.push({ kind: 'workdir', rel: rel,
        msg: 'README.md 读不出（' + err.message + '）—— 采不到状态就当没声明，不许静默放过' });
      return;
    }
    const words = readmeStatusWords(text);
    if (words.length) {
      if (debtDirs.has(e.name)) {
        // **修好忘销账**：账上还挂着它、它却已经合规 ⇒ 判红，逼人同批销账。
        //（这里的序号用 `1)` 这类写法，不写圈号 —— 圈号是判定标记，写了会被 G9 判"标记重复" ✗）
        stats.debtStale++;
        problems.push({ kind: 'workdir-debt-stale', rel: rel,
          msg: '欠账册还记着这个目录，但它的 README **已经声明了状态**（' + words.join(' / ') + '）—— '
            + '**修好忘销账**：把 `' + e.name + '` 这条从 `README_STATUS_DEBT` 删掉'
            + '（册子只减不增，挂着已结清的条目会让"还剩多少欠账"永远是个假数）。销账动作见 '
            + '`README_STATUS_DEBT_CLOSE`' });
        return;
      }
      stats.declared++;
      return;
    }
    if (debtDirs.has(e.name)) { stats.debt++; return; }             // 在册 ⇒ 放过，计数可见
    // 不在册 ⇒ 判红（这就是"任意空文件都能变绿"被堵掉的那条路）
    problems.push({ kind: 'workdir-status', rel: rel,
      msg: '工作目录的 README.md **没有声明状态**（正文里找不到 ' + WORKDIR_STATUS_VOCAB.join(' / ')
        + ' 中的任何一个词）—— 规则要的不是"有个 README 文件"，而是"接手者能判断它能不能删"。'
        + '补一行 `状态：' + WORKDIR_STATUS_VOCAB.join('|') + '`；'
        + '确实是已存在的存量、本轮修不了 ⇒ 登记进 `scripts/docs-registry-check.js` 的 '
        + '`README_STATUS_DEBT`（带 why，并同批抬上界）' });
  });
  // 账上目录已不存在 ⇒ **只报告**，不判红。理由：`.review/` 的规矩是"可随时整目录删除"，
  //    删掉一个已废弃目录正是通行的结清方式 —— 判红会把"删杂物"这个正确动作变红（假红）。
  //    代价如实说：册子可能一直挂着一批已结清的条目 ⇒ 所以它**在通过行里打印条数**，逼人看见。
  debt.forEach((d) => { if (!seen.has(d.dir)) stats.debtDangling.push(d.dir); });
  // **册子超上界 ⇒ 判红**（与根是不是真仓无关：这是册子自身的记账不变量，读的是"给了几本账/多高上界"）。
  if (debt.length > debtMax) {
    problems.push({ kind: 'workdir', rel: 'scripts/docs-registry-check.js',
      msg: '封闭欠账册超上界：现有 ' + debt.length + ' 条 > `README_STATUS_DEBT_MAX` = ' + debtMax
        + ' —— 加欠账条数 = 放宽判定，必须同批抬上界并在 CHANGELOG 说明为什么' });
  }
  return { problems, stats };
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
/** "未来时间戳"守卫的**容差**（毫秒）。
 *  为什么需要：文件系统的 `mtimeMs` 是**亚毫秒**精度（NTFS 100 ns），而调用方常拿 `Date.now()`
 *  当基准（整毫秒）。刚刚写出来的文件，其 `mtimeMs` 可以**略大于** `now`（实测差 < 1 ms）——
 *  于是它会被下面的守卫当成"未来时间戳"排除掉，报出的是**假红**：
 *  2026-09-30 本工程 `tests/docs-registry.test.js` 偶发失败，
 *  `expected ['SKILL.md'] to include 'docs/ARCHITECTURE.md'`，根因就是这个（657 个用例里只它红）。
 *  这是**修一条真实发生过的偶发假红，不是放宽标准**：真实时钟偏移（分钟级以上）照样被排除，
 *  下面那条"未来 1 小时不算最近改动"的断言仍然成立。 */
const FUTURE_TOLERANCE_MS = 2000;

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
    // 只比 now **大一点点**（< 容差）不算"未来"：那是 mtime 亚毫秒精度 / 写入延迟造成的，
    // 不是时钟偏移（详见 FUTURE_TOLERANCE_MS 的注释）。
    if (st.mtimeMs - now > FUTURE_TOLERANCE_MS) return;
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
/** 层的**取值表**（判定⑭）：新增一个层要**同批**改这里 + `SKILL.md` B3 的取值表那一行。
 *  值不在表内 = **配置错误**，不是文档错误。 */
const LAYER_ORDER = ['入口', '治理', '契约', '设计', '记录', '归档'];
/** 元信息块**必须齐备**的几行：缺任何一行都不算合格（注释与报错一直声称"四行"，此前只强制了前两行） */
const REQUIRED_HEADER_KEYS = ['层', '作用', '不该写', '更新方式'];

/** 解析文档正文里的 `<!-- registry ... -->` 元信息块（前 25 行内查找）。
 *  返回 null = **没有块**；否则 `{ meta, missing }` —— `missing` 是缺哪几行，
 *  这样报错能说准（"缺 不该写/更新方式" ≠ "没有元信息块"）。 */
function parseHeaderBlock(text) {
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
  return { meta, missing: REQUIRED_HEADER_KEYS.filter((k) => !meta[HEADER_KEYS[k]]) };
}

/** 合格 = 有块 **且四行齐备**。不合格返回 null（缺哪几行由 `parseHeaderBlock().missing` 给出）。 */
function parseDocHeader(text) {
  const b = parseHeaderBlock(text);
  return (b && b.missing.length === 0) ? b.meta : null;
}

/** 收集受管文档（**`docs/` 下递归**，但跳过归档族；+ 根三份入口文档）的元信息与判定状态。
 *  state：`ok` | `partial`（有块但缺行） | `no-header`（没有块） | `missing`（磁盘上没有） | `unreadable`（读不出来）。
 *  为什么递归：原先只扫 `docs/*.md` ⇒ `docs/<子目录>/x.md` **既不会被告知要补元信息、
 *  也没法合法进表**（手工加进 §5 反而会被"表过期"判红）—— 报错指了一条**走不通的路**。
 *  为什么必须跳过归档族：归档不逐份登记（§5 用前缀行覆盖），不跳会把归档里每份文件都判成缺元信息（假红一屏）。
 *  为什么读失败不再静默 `return`：**采不到真值＝红**，静默跳过会被当成"通过"。
 *  注意：`meta` 只在 `ok` 时非空 —— 渲染登记表的 `entries.filter(e => e.meta)` 依赖这一点。 */
function collectDocHeaders(root) {
  const out = [];
  const rels = [];
  const walk = (abs, rel) => {
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of items) {
      const r = rel + '/' + e.name;
      if (ARCHIVE_PREFIXES.some((p) => (r + '/').startsWith(p))) continue;   // 归档族：不逐份要求元信息
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), r); }
      else if (/\.md$/i.test(e.name)) rels.push(r);
    }
  };
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) walk(docsDir, 'docs');
  ROOT_DOCS.forEach((f) => rels.push(f));
  [...new Set(rels)].sort().forEach((rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { out.push({ rel, meta: null, state: 'missing' }); return; }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (e) { out.push({ rel, meta: null, state: 'unreadable', code: e.code || '?' }); return; }
    const b = parseHeaderBlock(text);
    if (!b) out.push({ rel, meta: null, state: 'no-header' });
    else if (b.missing.length) out.push({ rel, meta: null, state: 'partial', gaps: b.missing });
    else out.push({ rel, meta: b.meta, state: 'ok' });
  });
  return out;
}

/** 把"某份文档头部不合格"翻成一句带指路的话（一次错误一条消息，报错即教程） */
function headerProblemLine(e) {
  if (e.state === 'missing') {
    return '受管文档在磁盘上不存在 —— 要么建它，要么把它从 `ROOT_DOCS` 移除';
  }
  if (e.state === 'unreadable') {
    return '受管文档读不出来（' + e.code + '）—— **采不到真值＝红**，不许静默跳过；检查权限 / 编码 / 是否被误建成目录';
  }
  if (e.state === 'partial') {
    return '头部元信息块**缺 ' + e.gaps.join('、') + '** —— `REQUIRED_HEADER_KEYS` 要求四行齐备；'
      + '补齐后跑 `npm run docs:registry`';
  }
  return '受管文档缺少头部元信息块 `<!-- registry 层/作用/不该写/更新方式 -->` —— '
    + '登记表由这些声明生成，缺了它这份文档就没法进表（加完跑 `npm run docs:registry`）';
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
    // 四行齐备才可能进表（`parseDocHeader` 已强制）⇒ 这里**不再用 `|| '—'` / `|| '手写'` 兜底**：
    // 静默补默认值只会让"缺两行"看起来像合规（实测被这一点掩盖过）。
    lines.push('| ' + [e.meta.layer, '`' + e.rel + '`', e.meta.purpose,
      e.meta.notWrite, e.meta.update].join(' | ') + ' |');
  });
  // 归档族：规则相同 ⇒ 由前缀行统一覆盖，不逐份声明（§5 准入第 3 条）
  lines.push('| 归档 | `docs/archive/*` | 历史快照（回溯用） | —（**勿作现状引用**） | 只增不改（必须带历史横幅） |');
  lines.push('| 归档 | `docs/changelog/*` | **滚动归档的历史版本段**（`vX.Y.Z.md`，`release` 自动滚出，保留窗口 3） | —（**勿作现状引用**） | 只增不改；查历史用 `mm-cli changelog --grep` |');
  return lines.join('\n');
}

/** 把生成好的表写回 §5（`--write` 模式）；返回是否成功 */
function writeRegistryTable(root) {
  const archPath = path.join(root, REGISTRY_DOC);
  // **读全文的同时带回版本**：写回时过同一个闸门（比较仍在 `versionGate`，本文件不新写一份）。
  // 非 `optional`：这份文件是本门禁的载体（`main()` 已先判存在）；读不到就是真问题，
  // 不许静默当空文件（与 `collectDocHeaders` 的 `unreadable ⇒ 红`同一口径）。
  const handle = readManagedText(archPath);
  const md = handle.text;
  const entries = collectDocHeaders(root);
  const bad = entries.filter((e) => e.state !== 'ok');
  if (bad.length) {
    console.error('✗ 有 ' + bad.length + ' 份受管文档头部不合格，**拒绝生成**（生成模式与检查模式必须一致）：');
    bad.forEach((e) => console.error('   [ ' + e.rel + ' ] ' + headerProblemLine(e)));
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
  try {
    writeManagedText(handle, out, {
      // `label` / `hint` 只影响报错文案（比较逻辑不可配）
      label: '登记表「' + REGISTRY_DOC + ' §5」',
      hint: '请重跑 `npm run docs:registry`（它会重新读最新一版再生成）'
    });
  } catch (err) {
    // **绝不允许静默**：报出两侧版本（前 8 位在闸门报文里，这里给完整值）与出路。
    console.error('✗ 拒绝写入 ' + REGISTRY_DOC + ' §5：并发写入冲突 —— 盘上已不是本次读到的那个版本。');
    console.error('    ' + ((err && err.message) || err));
    if (err && err.code === 'VERSION_CONFLICT') {
      console.error('    读到的版本（本次生成开始时）: ' + String(err.expectVersion));
      console.error('    盘上的版本（写回时）:        '
        + (err.actualVersion === null ? '（文件已不存在）' : String(err.actualVersion)));
      console.error('  → 先重读该文件再重跑 `npm run docs:registry`。'
        + '⚠️ 被拒的那次写会把 **§5 之外**（§1–§4）的改动整份回退，所以这不是"重试一下就好"的小事。');
    }
    return false;
  }
  console.log('已生成 ' + REGISTRY_DOC + ' §5 登记表（来源：' + entries.filter((x) => x.meta).length
    + ' 份文档的头部元信息 + 2 行归档族前缀）');
  return true;
}

/** 检查：元信息齐全（**四行齐备**）+ 登记表与元信息一致（逐字）。
 *  `entriesIn` 可选：调用方已算过头部就传进来，免得同一件事解析两遍。 */
function checkRegistryTable(root, md, entriesIn) {
  const problems = [];
  const entries = entriesIn || collectDocHeaders(root);
  // 自适应门：**只有在"已经采用头部元信息"的工程里才判**（判定标志 = 至少一份文档带元信息块）。
  // 为什么需要：单测 fixture / 早期工程没有这套元信息，硬判会把它们全部变成红；
  // 而真工程里"元信息块被删光"这种情况由下面的逐份报出（不会静默放过）。
  if (!entries.some((e) => e.meta)) return problems;
  entries.filter((e) => e.state !== 'ok').forEach((e) => {
    problems.push({ kind: e.state, rel: e.rel, msg: headerProblemLine(e) });
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

  // ⑥ 交接面可核对：证据指针都得解析得到 + 状态列得在固定词表内（死指针 = 接手者白找一场）
  checkHandoverPointers(root).forEach((p) => problems.push(p));

  // ⑦ 代码文件必须被架构文档提到（文档↔代码对应：接手者靠 §2 认识代码结构）
  checkModuleCoverage(root).forEach((p) => problems.push(p));

  // ⑧ 归档文档必须自带「历史」横幅（归档仍会被 grep 到）
  checkArchiveBanners(root).forEach((p) => problems.push(p));

  // ⑨ 工作目录必须声明死活（在飞 / 已收口 / 已废弃 / 已完成）
  const wd = checkWorkDirStatus(root);
  wd.problems.forEach((p) => problems.push(p));
  const workdirStats = wd.stats;

  // ⑩ 受管文档必须能从 SKILL.md 导航找到（第一屏可达 = 接手者知道它存在）
  checkNavCoverage(root, reg).forEach((p) => problems.push(p));

  // ⑪ 数据契约必须覆盖 schema 校验的字段（契约缺字段 = 接手者照着契约改就漏）
  //    `contractStats` 只用于通过读数（分母 + prose 名单）：读数里看不见"判了几条/哪几条走弱判据"，
  //    就等于让人把"没判"读成"判过了"。
  const contractStats = {};
  checkContractCoverage(root, contractStats).forEach((p) => problems.push(p));

  // ⑫ 受管文档的章节编号必须连续（断号 = 有人删/挪过章节而没人复查）
  checkSectionNumbering(root).forEach((p) => problems.push(p));

  // ⑬ 登记表必须与"各文档头部元信息"一致（表是生成的，不是手写的）
  const headerEntries = collectDocHeaders(root);
  checkRegistryTable(root, registryMd, headerEntries).forEach((p) => problems.push(p));

  // ⑭ 层取值表：`层` 必须在 `LAYER_ORDER` 内（原先它只用于排序 —— 非法值排在末尾就没人管，
  // 而文档一直声称"值必须在取值表内"：声称 ≠ 实现，实测被复核抓到）
  checkLayerValues(headerEntries).forEach((p) => problems.push(p));

  // ⑮ 稳定性表覆盖：契约里漏一个对象 = 谁都不知道能不能依赖它
  //（⚠️ 标记只写这一处：判定标题与导出注释里都**不许**再出现 ⑮，否则 G9 判"标记重复"——实测踩到 ✗）
  checkStabilityCoverage(root).forEach((p) => problems.push(p));

  // ⑯ 整行重复：受管 .md 的**表格数据行**不许逐字节重复（同一事实被写了两遍 = "写入两次"的残渣）
  const dupRes = checkDuplicateRows(root, docs);
  dupRes.problems.forEach((p) => problems.push(p));

  return { problems, reg, docs, dupStats: dupRes.stats, workdirStats, contractStats };
}

/** ⑭ 层取值表：`层` 必须在 `LAYER_ORDER` 内（权威在 `SKILL.md` B3）。
 *  为什么需要：原先 `LAYER_ORDER` **只用于排序**（非法层落到末尾），等价于没判；
 *  而 `REFERENCE` §3.1 ⑤ 与 `SKILL.md` B3 都声称"值必须在取值表内"。 */
function checkLayerValues(entries) {
  const problems = [];
  entries.filter((e) => e.meta).forEach((e) => {
    if (LAYER_ORDER.indexOf(e.meta.layer) < 0) {
      problems.push({ kind: 'layer', rel: e.rel,
        msg: '元信息的 `层` 不在取值表内：`' + e.meta.layer + '`；取值表 = ' + LAYER_ORDER.join(' / ')
          + '。值不在表内 = **配置错误**（不是文档错误）：要么改文档的层，'
          + '要么把新层加进 `LAYER_ORDER` —— 新增层要**同批**改 `SKILL.md` B3 的取值表那一行' });
    }
  });
  return problems;
}

/* ---------------- CLI 稳定性表的覆盖（本判定见 `checkRegistry()` 的 ⑮）----------------
 * `cli/registry.js` 的每条命令都要落在 `docs/EXTENSIONS.md` §1.2 稳定性表的一级里。
 * ⚠️ 本段标题**故意不带标记**：判定标记的**唯一来源**是 `checkRegistry()` 里的那一行
 *    —— 同一段里再写一个标记会被 G9 判"标记重复"（实测踩到 ✗）。
 * 缺陷取证（实测清单，2026-10-10）：`docs/EXTENSIONS.md` §1.2 的稳定性三级表里
 *   **一条命令都不在**的有 12 条 —— `import-project`（上一批盘点里唯一被发现的那条）
 *   外加同批清点出来的 `ask`/`ask-apply`/`theme-layout`/`expand-depth`/`ui-state`/
 *   `sidebar-only`/`dsh-sidebar`/`dsh-status`/`dsh-prefill`/`dsh-caps`/`changelog`。
 * 病根：这张表是**手写**的，而"命令有哪些"的真值在 `cli/registry.js` —— 两边没有守望者：
 *   新增命令时忘了改表，**没有任何东西会红**（而这张表恰恰是"外部工具/AI 能依赖哪一级"的契约 ✗）。
 * 与判定 ⑪（数据契约必须覆盖 schema 字段）同型：契约里漏一个对象，接手者就永远不知道它存在。
 * 口径：**覆盖**（每条命令至少落在一级里），不判"放哪一级"—— 那是人的判断（表里写明取舍）。 */
const STABILITY_DOC = 'docs/EXTENSIONS.md';
/** 三级表所在的段：`## 1. 可依赖的稳定接口` 之下的 `### 1.2 CLI 命令…` 到下一个标题。
 *  ⚠️ 标题形态是 `### 1.2 CLI 命令（稳定的自动化入口）` —— 编号与后面的字之间**没有空格**，
 *     所以用 `\b` 收口而不是 `\s`（实测：写成 `1\.2\s` 会找不到这一段 ⇒ 判成"一条都没解析到"⇒ 假红）✗ */
function stabilitySection(md) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s*1\.2\b/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###\s/.test(lines[i]) || /^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

/** 从稳定性表里抽命令名：只认**每个 `|` 行**里的 `` `名字` ``，且名字必须像命令名（小写+连字符）。
 *  为什么要这么窄：1.2 节里还有正文与引用块，它们会提到 `.md` / `sidebar-only on` 这类词 ——
 *  宽口径会把解释性文字当成"登记过了"，于是**漏登记的命令照样绿**（本工程踩过同型坑）✗。
 *  ⚠️ 切分只看**分隔符**，不要拿空白当分隔符：命令名里本来就有 `-`，而表格里用 `</br>` 换行 ——
 *     `backlinks`/`...` 与 `ask-apply` 都曾被切坏 ⇒ 判成"漏登记 12 条"的**假红**（实测踩到）✗
 *  ⚠️ 剔除 `</br>` 之类的 HTML 片段：它们不是命令名，但会混进同一个 token。 */
function parseStabilityTable(md) {
  const sec = stabilitySection(md);
  if (!sec) return null;
  const cmds = new Set();
  const levels = [];
  sec.forEach((line) => {
    if (!/^\s*\|/.test(line)) return;                       // 只认表格行（正文/引用块一律不看）
    const cells = line.split('|');
    if (cells.length < 4) return;                           // 表头分隔行 / 不完整行
    const level = cells[1].replace(/\*\*/g, '').trim();
    if (!level || /^-+$/.test(level)) return;               // `|---|` 分隔行
    levels.push(level);
    // 在每个 `|` 行里直接**逐个匹配反引号里的名字**，不切分、不拼接：
    // 表里同一格内既有可能有说明词（"数据读写类："）也有命令名，靠"切分"必然把说明词粘到命令名上
    // （实测：`read` 因为前面粘了"数据读写类："而判成漏登记 ⇒ 假红 ✗）。
    const cellText = cells.slice(2).join('|').replace(/\*\*/g, '');
    for (const m of cellText.matchAll(/`([^`\n]+)`/g)) {
      const name = m[1].trim();
      if (/^[a-z][a-z0-9-]*$/.test(name)) cmds.add(name);   // 像命令名的才算（`.md` / `sidebar-only on` 不算）
    }
  });
  return { cmds, levels };
}

/** 判定函数（标记在 `checkRegistry()` 里，见那里的 ⑮）：注册表里的每条命令都必须出现在稳定性表的某一级里
 *  （采不到真值 ⇒ 红）。
 *  @param {string} root 工程根（找 `docs/EXTENSIONS.md`）
 *  @param {string[]} [namesIn] 命令真值清单：不给就从本脚本所在工程的 `cli/registry.js` 现场读。
 *         给它是**为了单测能验判定本身**（假工程里没有真注册表）；生产路径永远不传 ✓ */
function checkStabilityCoverage(root, namesIn) {
  const problems = [];
  const docPath = path.join(root, STABILITY_DOC);
  if (!fs.existsSync(docPath)) {
    problems.push({ kind: 'stability', rel: STABILITY_DOC,
      msg: '这份文档不存在 —— 稳定性等级表是"外部工具/AI 能依赖哪一级"的契约，缺了它门禁无法判定（**采不到真值＝红**）' });
    return problems;
  }
  let md = '';
  try { md = fs.readFileSync(docPath, 'utf8'); }
  catch (e) {
    problems.push({ kind: 'stability', rel: STABILITY_DOC,
      msg: '读不出来（' + (e.code || '?') + '）—— **采不到真值＝红**，不许静默跳过' });
    return problems;
  }
  const table = parseStabilityTable(md);
  if (!table || !table.cmds.size) {
    problems.push({ kind: 'stability', rel: STABILITY_DOC,
      msg: '§1.2 的稳定性三级表里**一条命令都没解析到**（表被删/被改成别的写法？）—— '
        + '本判定的真值就在这张表里，解析不到等于没判（**采不到真值＝红**）' });
    return problems;
  }
  // 真值：注册表（`cli/registry.js` 的 list）——**运行时可数**，不是正则近似。
  // ⚠️ 加载路径固定用**本脚本所在工程**（`path.resolve(__dirname,'..')`），不用入参 `root`：
  //    单测里的假工程没有真注册表，用假根去找会 require 到不存在的文件（或更坏：找到别处一份）✗。
  //    需要"换一份命令清单"来验判定的调用方，走下面第三个入参 `namesIn`（依赖注入）——判定逻辑与
  //    "真值从哪来"由此分开，测试不必造一个假 registry.js。
  let names = Array.isArray(namesIn) ? namesIn.slice() : null;
  if (!names) {
    try { names = require(path.join(path.resolve(__dirname, '..'), 'cli', 'registry.js')).list().map((c) => c.name); }
    catch (e) {
      problems.push({ kind: 'stability', rel: 'cli/registry.js',
        msg: '加载注册表失败（' + (e && e.message) + '）—— **采不到真值＝红**，本判定不能自称已校验' });
      return problems;
    }
  }
  if (!names.length) {
    problems.push({ kind: 'stability', rel: 'cli/registry.js',
      msg: '注册表里一条命令都没有（require 副作用没跑完 / 注册被跳过？）—— 这种"真值为空"必须红，'
        + '否则本判定会永远通过（空转）' });
    return problems;
  }
  const missing = names.filter((n) => !table.cmds.has(n));
  if (missing.length) {
    problems.push({ kind: 'stability', rel: STABILITY_DOC,
      msg: '稳定性三级表漏登记 ' + missing.length + ' 条命令：' + missing.join('、')
        + '（注册表共 ' + names.length + ' 条）。这张表是"外部工具/AI 能依赖哪一级"的契约：'
        + '漏登记的命令**谁都不知道能不能依赖**（`import-project` 就长期漏在这里 ✗）。'
        + '处置：在 §1.2 的三级表里给它选一级（会被外部依赖的放「演进中」，工程自用放「内部」）' });
  }
  return problems;
}

/* ---------------- 判定：整行重复（同一事实被写了两遍） ----------------
 * 为什么需要（真实事故，不是"文档洁癖"）：`3edf4a3` 从 `docs/ARCHITECTURE.md` 里清掉过 **3 组逐字节
 * 相同的表格行**（1,744 / 1,062 / 932 字符，共 −6,882 B）。成因是"用 `git cat-file blob` 还原工作树"
 * 与"登记"两步叠加 ⇒ **同一行被写了两次**。而**当时那道全链是绿的**：本门禁此前的各条判定查的是
 * "文件有没有被登记""归档段有没有重复版本"，**没有一条查"同一行登记了几次"** ⇒ 门禁盲区。
 * 而重复行恰恰是"写入两次"的**可见残渣**，也是"一份事实只写一处"被破坏的机械可查形态。
 *
 * 判据形态是**量出来的**，不是拍出来的（范围读数与逐条分类见 `.review/20261016-重复行门禁/`）：
 *   扫描面 = 受管 `.md`（`collectDocs()` 现场取；**排除 `.review/` 工作产物区**）
 *   对象   = **表格数据行**：以 `|` 开头，且既不是分隔行（`|---|`）、也不是表头行
 *            （表头 = 紧跟分隔行的那一行，或一段连续 `|` 块的首行 —— 两档取并集，
 *             因为受管 `.md` 里实测有 6 个表格块没有分隔行，只认"紧跟分隔行"会漏掉它们的表头）
 *   判红   = 同一行在扫描面里出现 **≥2 次**（同一份文档内、或跨文档都算）
 *
 * 为什么**不设长度阈值**（本批最重要的一条读数）：在唯一有样本的语料（`.review/`，463 组）上，
 * 重复表格数据行的长度是 **14 → 995 的连续分布**，T=1 到 T=400 之间每一档都还有几十到几百组
 * ⇒ **没有拐点**，任何长度阈值都是拍的（挑一个"刚好让受管文档变 0"的数，正是"凑绿"✗）。
 * 而受管 `.md`（33 份 / 13,836 行）在**任何**长度阈值下分子都是 0 ⇒ 阈值也不承担判别力。
 * 判别力改由**形态**承担：受管 `.md` 里 47 组"任意行重复"**全部**是表格分隔行 / 表头行 /
 * CHANGELOG 历史小标题 / 归档横幅 / 生成块的同一段注释（正当重复 47/47）⇒ "任意行重复即红"是
 * **必然假红**；换成"表格数据行"后，正当重复被**结构上**排除，不靠白名单（白名单会把门禁变成恒真）。
 *
 * 已知边界（三档一起写，照 docs-for-ai G2）：**判红** = 受管 `.md` 的表格数据行重复；
 * **只报告** = `.review/` 工作产物区整片不扫（那是分析稿，实测 463 组重复；扫它会让"只读仓库 +
 * 只写工作区"的核查任务永远不可能变绿 —— docs-for-ai D1）；
 * **跳过** = 正文里重复的散文 / 清单 / 小标题不判（实测正当重复 100%，与"有意重复"无法区分）。
 *
 * ⚠️ 能力边界（抓结果不抓动作）：本判定抓的是"**重复已经落在盘上**"这个结果，抓不住"谁写了两次"；
 *    非表格形态的重复（散文、清单）在本判定之外 —— 那里没有可用的判据，见上面"跳过"档。 */
const DUP_ROW_TABLE_SEP_RE = /^\|[\s:|-]+$/;

/** 一行是否"表格分隔行"（`|---|` / `|:--|--:|` 这类） */
function isTableSepLine(line) {
  const s = String(line).trim();
  return DUP_ROW_TABLE_SEP_RE.test(s) && s.includes('-');
}

/** 抽出一份文档里的**表格数据行**：返回 Map(整行原文 -> [行号(1 基), …])
 *  @param {string} text 文档全文
 *  判据只看**行本身与它的邻居**，不看它属于哪张表 —— 因此"表格里加一列"不会让本判定失准。 */
function tableDataRows(text) {
  const lines = String(text).split(/\r?\n/);
  const n = lines.length;
  const isPipe = lines.map((l) => l.trim().startsWith('|'));
  const isSep = lines.map((l) => isTableSepLine(l));
  const out = new Map();
  for (let i = 0; i < n; i++) {
    if (!isPipe[i] || isSep[i]) continue;
    // ⚠️ 两档判据都只看**紧邻的物理行**：空行在 Markdown 里就是"表格结束"，
    //    跨过空行去找邻居会把上一张表的数据行当成这张表的表头/数据（实测：跳过空行找邻居，
    //    第二张表的块首行被当成了数据行 —— 单测当场抓到）。
    const followedBySep = i + 1 < n && isSep[i + 1];                   // 表头：紧跟分隔行
    const firstOfBlock = i === 0 || !isPipe[i - 1];                    // 表头：一段连续 `|` 块的首行
    if (followedBySep || firstOfBlock) continue;                       // 表头行不算数据行
    if (!out.has(lines[i])) out.set(lines[i], []);
    out.get(lines[i]).push(i + 1);
  }
  return out;
}

/** 在册豁免 —— **封闭册**：只登记"这一处重复确实是正当的"个案，上界只减不增。
 *  加一条之前先问一句：这两处真的是**两件不同的事实**吗？是 ⇒ 行文本来就该不同（改文不改册）；
 *  不是 ⇒ 删掉一处。**把正当重复一律塞进册里**会让本判定变成恒真（skill B8 明令禁止）。
 *  复审时机：每次改动本判定的口径（形态 / 扫描面）时；审：改本文件的人。 */
const DUP_ROW_EXEMPT_MAX = 0;
const DUP_ROW_EXEMPT = [
  // { rel: 'docs/XXX.md', line: '| 整行原文 |', why: '为什么这处重复是正当的（含"为什么不能改文"）' }
];

/** 判定函数（标记在 `checkRegistry()` 里，见那里的 ⑯）：受管 `.md` 的表格数据行不许逐字节重复。
 *  @param {string} root 工程根
 *  @param {Array|string[]} [docsIn] 扫描面（`collectDocs()` 的结果或纯路径数组）；不给就现场收一遍。
 *  @param {Array} [exemptIn] 豁免册（依赖注入，给单测用）；不给就用模块里的 `DUP_ROW_EXEMPT`。
 *  @param {number} [exemptMaxIn] 豁免条数上界（依赖注入，给单测用）；不给就用 `DUP_ROW_EXEMPT_MAX`。
 *  @returns {{problems: Array, stats: {files:number, rows:number, groups:number, exempt:number, exemptMax:number}}} */
function checkDuplicateRows(root, docsIn, exemptIn, exemptMaxIn) {
  const problems = [];
  const exempt = Array.isArray(exemptIn) ? exemptIn : DUP_ROW_EXEMPT;
  const exemptMax = Number.isFinite(exemptMaxIn) ? exemptMaxIn : DUP_ROW_EXEMPT_MAX;
  const list = (docsIn || collectDocs(root))
    .map((d) => (typeof d === 'string' ? d : d.rel))
    .filter((rel) => /\.md$/i.test(rel))
    .filter((rel) => !(rel === WORK_DIR || rel.startsWith(WORK_DIR + '/')));

  const occ = new Map();     // 整行原文 -> [{rel, idx}]
  let rows = 0;
  list.forEach((rel) => {
    let text = '';
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); }
    catch (e) {
      // **采不到真值＝红**（skill A5）：读不出就不许静默跳过，否则"没判"会被读成"判过了"。
      problems.push({ kind: 'unreadable', rel: rel,
        msg: '读不出来（' + (e.code || '?') + '）—— 本判定无法自称已校验（采不到真值＝红）' });
      return;
    }
    for (const [line, idxs] of tableDataRows(text)) {
      rows += idxs.length;
      if (!occ.has(line)) occ.set(line, []);
      idxs.forEach((idx) => occ.get(line).push({ rel, idx }));
    }
  });

  // 重复本身（豁免先扣掉：只在"被豁免的那一份文档里"扣，不给跨文件重复开后门）
  const isExempt = (h, line) => exempt.some((e) => e && e.rel === h.rel && e.line === line);
  let groups = 0;
  occ.forEach((hits, line) => {
    const kept = hits.filter((h) => !isExempt(h, line));
    if (kept.length < 2) return;
    groups++;
    problems.push({ kind: 'dup-row', rel: [...new Set(kept.map((h) => h.rel))].join(' + '),
      msg: '表格数据行重复 ' + kept.length + ' 次：' + kept.map((h) => h.rel + ':' + h.idx).join('、')
        + ' —— 同一行逐字节写成多份 = **同一事实被写了两遍**（"写入两次"的可见残渣），'
        + '直接破坏「一份事实只写一处」。处置三条（任选其一，说明理由即可）：'
        + '① 删掉多余的那几行（只留一处，最常见）；'
        + '② 若两处讲的确实是不同的事实 ⇒ 把行文改成不同（改文，不要改判据）；'
        + '③ 若确认这处重复是正当的 ⇒ 登记进 `DUP_ROW_EXEMPT`（必须带 why，上界只减不增）'
        + '\n     该行前段：' + JSON.stringify(line.length > 120 ? line.slice(0, 120) + '…' : line) });
  });

  // 封闭册三条：上界只减不增 / 悬挂登记 / 修好忘销账
  if (exempt.length > exemptMax) {
    problems.push({ kind: 'dup-exempt', rel: REGISTRY_DOC,
      msg: '在册豁免 ' + exempt.length + ' 条 > 上界 ' + exemptMax
        + '（**只减不增**）—— 新开豁免要么当场改文，要么说明为什么必须扩上界'
        + '（扩上界是一次独立决定，不许顺手改）' });
  }
  exempt.forEach((e) => {
    if (!e || !e.rel || !e.line) {
      problems.push({ kind: 'dup-exempt', rel: REGISTRY_DOC,
        msg: '豁免条目缺 `rel` / `line` —— 判据无从核对（悬挂登记）' });
      return;
    }
    const hits = (occ.get(e.line) || []).filter((h) => h.rel === e.rel);
    if (hits.length < 2) {
      problems.push({ kind: 'dup-exempt', rel: e.rel,
        msg: '豁免条目在仓库里已经**不再成立**（该行在这份文档里的表格数据行出现 ' + hits.length
          + ' 次 < 2）—— 重复已经修好却忘了销账，或这条豁免指向的行已被改写（悬挂登记）。'
          + '处置：把它从 `DUP_ROW_EXEMPT` 里删掉（这正是"逼人销账"）' });
    }
    if (!e.why) {
      problems.push({ kind: 'dup-exempt', rel: e.rel,
        msg: '豁免条目没写 `why` —— 没有理由的豁免等于把判据关掉（skill B8 明令：豁免必须写原因）' });
    }
  });

  return { problems: problems, stats: {
    files: list.length, rows: rows, groups: groups,
    exempt: exempt.length, exemptMax: exemptMax
  } };
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
    // 用 `exitCode` 而不是 `process.exit()`：退出码完全一样，但不会在 stdout 还有缓冲时把
    // **拒绝理由（含两侧版本）**截断 —— 那正是本文最需要被看见的一屏。
    if (!writeRegistryTable(ROOT)) process.exitCode = 1;
    return;
  }
  const registryMd = fs.readFileSync(regPath, 'utf8');
  const { problems, reg, docs, dupStats, workdirStats, contractStats } = checkRegistry(ROOT, registryMd);

  // `--judgments`：把本门禁的判定清单**现场列出来**（从 `checkRegistry()` 的圈号标记与标题提取）。
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
    // `--list` 是报告模式，但**不能假绿**：有任一问题就以非 0 退出
    //（否则有人把它挂进 CI，看到一屏 ✓ 会以为合规 —— 实测复核报来的"挂 CI 假绿"）。
    if (problems.length) {
      console.log('✗ 有 ' + problems.length + ' 处问题 ⇒ 本模式**同样参与门禁**（退出码 1）；'
        + '跑不带参数的 `docs-registry-check` 看详情与三条路');
      process.exitCode = 1;
    }
    return;
  }

  console.log('== 文档登记门禁（G8）==');
  console.log(problems.length
    ? '✗ 文档体系完整性有问题（' + problems.length + ' 处）：'
    : '✓ 登记与家门均合规（' + docs.length + ' 份 .md/.html 有家，根与顶层目录白名单干净）');
  problems.forEach((p) => {
    const tag = p.kind === 'dup-row' ? '整行重复'
      : p.kind === 'dup-exempt' ? '豁免册不成立'
        : p.kind === 'unregistered' ? '表外文档'
      : p.kind === 'stray' ? '家目录非法'
        : p.kind === 'dangling' ? '悬挂登记'
          : p.kind === 'junk' ? '乱放'
            : p.kind === 'duplicate' ? '历史重复'
              : p.kind === 'handover' ? '交接死指针'
                : p.kind === 'handover-status' ? '交接状态词表'
                : p.kind === 'module-cover' ? '代码未入档'
                  : p.kind === 'banner' ? '归档缺横幅'
                    : p.kind === 'workdir' ? '工作目录无状态'
                      : p.kind === 'workdir-status' ? '工作目录未声明状态词'
                        : p.kind === 'workdir-debt-stale' ? '欠账已结清未销账'
                      : p.kind === 'nav-cover' ? '导航不可达'
                        : p.kind === 'contract' ? '契约缺字段'
                          : p.kind === 'contract-stale' ? '检查表过期'
                            : p.kind === 'numbering' ? '章节断号'
                              : p.kind === 'no-header' ? '文档无元信息'
                                : p.kind === 'partial' ? '元信息缺行'
                                  : p.kind === 'missing' ? '受管文档缺失'
                                    : p.kind === 'unreadable' ? '受管文档读不出'
                                      : p.kind === 'layer' ? '层不在取值表'
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
  console.log('✓ 交接面「在飞 / 未收口」的证据指针都解析得出真实路径 + 状态列都在固定词表内（docs/ROADMAP.md）');
  // 通过读数里的目录清单**从 `COVERED_DIRS` 现场取**，不写死 —— 写死过一次：加 `renderer/` 时
  // 这句仍是 "src/ · cli/commands/ · scripts/"，于是"扫了哪几个目录"当场就成了第二种说法。
  console.log('✓ 代码文件都在架构文档里登记过（' + COVERED_DIRS.map((d) => d.dir + '/').join(' · ') + '）');
  console.log('✓ 归档文档都带「历史」横幅（docs/archive/）');
  // 第⑨条的通过读数**必须带分母 + 在册欠账 + 账上已不存在的条数**：只报一个 ✓，
  // 读者会把"没判"读成"判过了"（skill B8 / A5；本判定恰恰是"看起来在判、其实只判了文件存在"过的那一处）。
  if (workdirStats) {
    console.log('✓ 工作目录的 README 都声明了状态（.review/*/README.md：受判 ' + workdirStats.dirs
      + ' 个目录 · 已声明 ' + workdirStats.declared + ' · 在册欠账 ' + workdirStats.debt
      + '/' + workdirStats.debtMax + ' · 工具自建目录豁免 ' + workdirStats.exempt
      + ' · 词表 ' + workdirStats.vocab.join('|') + '）');
    if (workdirStats.debtDangling.length) {
      console.log('ℹ️ 欠账册上这 ' + workdirStats.debtDangling.length + ' 条目录已不存在（等于已结清）：'
        + workdirStats.debtDangling.slice(0, 5).join('、')
        + (workdirStats.debtDangling.length > 5 ? ' 等' : '')
        + ' —— **请把这几条从 `README_STATUS_DEBT` 删掉**（册子只减不增；'
        + '删目录本身就是 .review/ 的合法结清方式，故这里只报告、不判红）。');
    }
  }
  console.log('✓ 受管文档都能从 SKILL.md 导航找到（第一屏可达）');
  // 通过读数**必须带分母与弱判据名单**：只说"契约覆盖了"会把"按哪一处判的"藏起来，
  // 而 prose 档是弱判据（"词出现过"）—— 是谁在走它，读数里得点名（`skill B8` / `A5`）。
  if (contractStats && contractStats.byWhere) {
    console.log('✓ 数据契约覆盖了 schema 校验的字段（按每条自己声明的第三列判：DATA-FORMAT 表行 '
      + contractStats.byWhere['DATA-FORMAT'] + ' 条 · ITEM-MODEL 表行 '
      + contractStats.byWhere['ITEM-MODEL'] + ' 条 · prose 承载 '
      + contractStats.byWhere['DATA-FORMAT:prose'] + ' 条'
      + (contractStats.prose.length ? '：' + contractStats.prose.join('、') : '')
      + ' · 在册 ' + contractStats.prose.length + '/' + contractStats.proseMax + '）');
    if (contractStats.proseDangling && contractStats.proseDangling.length) {
      console.log('ℹ️ `PROSE_EXEMPT` 册上这几条已不再声明 prose（等于已结清）：'
        + contractStats.proseDangling.join('、') + ' —— 请把它们从册上删掉（册子只减不增）。');
    }
  } else {
    console.log('✓ 数据契约覆盖了 schema 校验的字段（docs/DATA-FORMAT.md）');
  }
  console.log('✓ 受管文档的章节编号连续（无断号）');
  console.log('✓ §5 登记表与各文档头部元信息一致（表是生成的，勿手改）');
  console.log('✓ 受管文档的 `层` 都在取值表内（' + LAYER_ORDER.join(' / ') + '）');
  const stabCount = (() => {
    try {
      const t = parseStabilityTable(fs.readFileSync(path.join(ROOT, STABILITY_DOC), 'utf8'));
      return t ? t.cmds.size : 0;
    } catch (e) { return 0; }
  })();
  console.log('✓ CLI 稳定性表覆盖注册表全部命令（' + STABILITY_DOC + ' §1.2：' + stabCount + ' 条已登记）');
  // 整行重复的**通过读数必须带分母与在册豁免条数**：只报一个 ✓，读者会把"没判"读成"判过了"
  //（skill B8：豁免要计入真值、在输出里可见；A5：通过 / 总数 / 未验证三档都要看得见）。
  if (dupStats) {
    console.log('✓ 受管 .md 的表格数据行无逐字节重复（' + dupStats.files + ' 份 / ' + dupStats.rows
      + ' 行已判；在册豁免 ' + dupStats.exempt + ' 条 / 上界 ' + dupStats.exemptMax + '）');
  }

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
          // 合法名字：`<name>.json`、`.ui-state.json`、`.changes.jsonl`（后两者是运行时协调信号与变更日志，
          // §5 已声明）。原先只放行 /\.json$/，把 `.changes.jsonl` 误报成"契约未声明的项"——
          // 属于检查自己的白名单过期（会让人去查一个早已声明的东西）。
          if (/\.jsonl?$/.test(x) || x === 'assets' || x === 'attachments') continue;
          odd.push('projects/' + d + '/' + x);
        }
      }
      if (odd.length) {
        console.log('ℹ️ 数据目录里有契约未声明的项（' + odd.length + ' 个）：' + odd.slice(0, 5).join('、')
          + ' —— `docs/DATA-FORMAT.md` §5 声明的是 `<name>.json` / `.ui-state.json` / `.changes.jsonl`'
          + ' / `assets/` / `attachments/`；请确认它们的来历（工作产物请移到 `.review/`）。');
      }
    }
  } catch (e) { /* 数据目录不可读不影响门禁 */ }
  console.log('\n文档登记门禁通过');
}

module.exports = {
  parseRegistryTable, isRegistered, collectDocs, checkRegistry, checkRootLayout,
  checkArchiveNoDuplicate, checkHandoverPointers, checkModuleCoverage,
  checkArchiveBanners, checkWorkDirStatus, checkNavCoverage,
  // 第⑦条的登记行解析（导出给单测：`registrationRows` / `nameHit` 是那档"只认表格第一列"的判据）
  registrationRows, nameHit,
  // 第⑨条的词表与封闭欠账册（导出给单测：判别力的四个方向都在 `tests/` 里常驻）
  WORKDIR_STATUS_VOCAB, readmeStatusWords, README_STATUS_DEBT, README_STATUS_DEBT_MAX,
  README_STATUS_DEBT_CLOSE, WORK_DIR_EXEMPT,
  checkContractCoverage, checkSectionNumbering, handoverNotice, recentlyChanged,
  // 契约位置的判定与纯函数（导出给单测：`judgeContractCoverage` 吃文本，两侧方向都能直接打）
  judgeContractCoverage, contractTableCells, normContractCell,
  CONTRACT_WHERE_KINDS, PROSE_EXEMPT, PROSE_EXEMPT_MAX,
  parseHeaderBlock, parseDocHeader, collectDocHeaders, renderRegistryTable, checkRegistryTable,
  writeRegistryTable, headerProblemLine, checkLayerValues,
  // 稳定性表覆盖的判定与纯函数（标记在 checkRegistry 里；`parseStabilityTable` 导出给单测）
  checkStabilityCoverage, parseStabilityTable, stabilitySection, STABILITY_DOC,
  // 整行重复的判定与纯函数（标记在 checkRegistry 里；`tableDataRows` / `isTableSepLine` 导出给单测）
  checkDuplicateRows, tableDataRows, isTableSepLine, DUP_ROW_EXEMPT, DUP_ROW_EXEMPT_MAX,
  section5, ROOT_DOCS, ROOT_FILES, TOP_DIRS, WORK_DIR, BANNER_RE, SCHEMA_FIELDS, RECENT_WINDOW_MIN,
  FUTURE_TOLERANCE_MS,
  REQUIRED_HEADER_KEYS, LAYER_ORDER, REG_BEGIN, REG_END
};

if (require.main === module) main();
