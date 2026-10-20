#!/usr/bin/env node
/* ============================================================
 * scripts/rules-consistency.js — 规则文件自洽门禁（G9）
 * ------------------------------------------------------------
 * 存在的唯一理由：`docs/RULES.md` 是**全部「必须遵守」事项的唯一权威副本**，
 * 它自己却是**手写的**。而本工程已经吃过"同一事实多副本 + 无单源"的亏两次：
 *   · 规则清单曾在 6 个文件里各写一份并漂移（README 列 7 条、SKILL 列 6 条，
 *     两份不一致，且**漂移掉的恰恰是最要命的那条**）—— 见 RULES.md §0 自述；
 *   · 文档数字曾在 6 份副本里互相矛盾 —— 由 G6 治住。
 * 同一个病用同一味药：**单源 + 机器校验**。G6 管"文档里的数字"，G9 管"规则文件自身的自洽"。
 *
 * 本条门禁的判定：**清单见 `analyze()` 里的 ①…⑨ 标记**（此处刻意不写死条数、也不重复枚举 ——
 * 写死过一次：加判定时它成了"同一门禁的又一种条数说法"，而它自己抓不到自己）。
 * 任一不满足即 exit 1；其中前两条各自对应一次**真实事故**：
 *   · 声明的条数 == 表格实际行数。
 *     实测 §3 标题写「共 5 条」，表格却有 6 行（R1/R2/R3/R3a/R4/R5）——
 *     加法做错只是表象，真实后果是**读者以为漏看了或以为多出来的那条不算数**。
 *   · 表格行必须**连续**（不得被空行 / 引用块打断）。
 *     实测 §2 门禁表：G1–G5 在表内，中间插入 4 行引用块后，G6/G7/G8 掉出表格，
 *     **在渲染里变成纯文本段落** —— 三条门禁在权威规则文件里"看起来消失了"。
 *     markdown 表格一被空行打断即结束，这是一种**静默**的结构损坏。
 *   · 编号闭合：仓库文档里引用的 `G\d+` / `R\d+[a-z]?` / `M\d+` 必须都有定义。
 *     防"改了规则表却把引用留成悬挂指针"（与 G8 的"悬挂登记"同型）。
 *   · §2「实现」列点名的脚本必须真实存在。
 *     防"把门禁实现删了/改名了，规则表还指着它"。
 *   · 其他文档对「铁律 / 门禁 / 元规则条数」的转述必须与实际一致。
 *   · 门禁声明的条数必须 == 实现脚本里判定标记的去重个数；标记必须唯一；
 *     实现脚本的文案与其他文档里都不得再写死这个条数（应指向标记）。
 *   · **封闭欠账册（§7）的每一条必须带一条可执行的复核命令**（反引号包住、以 `node ` 开头）。
 *     防的是 §7 自己声明过、却一直没有判定的那种腐坏：**「册上写着它有问题、而它已经没有问题了」**
 *     （实测基线，2026-10-19：那 8 条里只有 1 条带 `node …` 命令 ⇒ 其余各条对下一个人只是散文）。
 *     G9 判不了"这条债还在不在"（那要理解语义），但**能**判"这条还能不能被复核"。
 *   · **封闭欠账册 `在册对象` 里点到的仓库路径必须仍存在**（§7 写着「册上的对象改名 / 删了」
 *     必须当缺陷，同样一直没判定）。只查**能在仓库里定位**的 token：通配 / 带空格 / 非路径词一律不查，
 *     并在输出里逐条打印"本条无路径可查" —— 边界要可见，不能把"没查"读成"查过了没问题"。
 *   · **`docs/ROADMAP.md`「在飞 / 未收口」表的「下一步」列必须非空、且不得只含空话**
 *     （禁词表 = `NEXT_STEP_BANNED`；逐条能力边界见 `scanNextStep()` 的头注释）。
 *     防的是 2026-10-19 诊断出的**主链被打断**：当时「在飞」3 条里 **2 条是"做完没结案"** ⇒
 *     **「下一步」在文档里根本不存在** ⇒ 任何人问一个支线问题，执行者**没有回程票**
 *     （那天 6 个在飞批次里 3 个是支线，主链从工程开发漂到内容整理/资料搜集）。
 *     人写的那半在 `docs/AI-GUIDE.md` §4（「任一批次收口 / 交接报告必须带一行「主链状态」」）；
 *     本条是**机械判的那半** —— 也是那一行文字所承诺的判据。
 *
 * 边界（诚实标注）：G9 只查**自洽**（前后是否一致），查不了**内容对不对** ——
 * 一条铁律是否真的"不可机械化"、一条门禁是否真的防住了它声称的损害，仍靠人判定。
 * 它也不查 CHANGELOG（历史记录里出现已退役的编号是正常的，不是缺陷）。
 * 判定⑦ 只判**复核命令在不在**，**不判它跑不跑得通**（真跑就成了重活，照 skill §G 第 1 条：
 * 门禁里不许起真服务 / 真网络）；判定⑧ 只判**路径在不在**，判不了"这个对象是不是还是那个语义"
 * （例：`src/control.js` 还在、但那个函数已经被搬走 —— 那只能靠人复核，见各条的 `close` 栏）。
 * 判定⑨ 只判**空**与**整格都是禁词**，**判不了"这条动作是否真的可执行"** —— 详见 `scanNextStep()`。
 *
 * ⚠️ **判定⑤认不出「引号里的历史引用」与「真实声明」的区别**。实测：本门禁上线时，
 * `ARCHITECTURE.md` 的 ADR 里为了记录缺陷写了"README 仍写『铁律…共 5 条』"，
 * 结果被它自己判红。这是**判定对、措辞错** —— 引用历史缺陷时请改用不会匹配的措辞
 * （如"把条数写成 5"），不要去弱化判定（放宽正则会让它再也抓不住真声明）。
 *
 * 用法：
 *   node scripts/rules-consistency.js              # 门禁（exit 0/1）
 *   node scripts/rules-consistency.js --judgments  # 打印判定清单（**从源码标记现场取**，不维护第二份）
 *   node scripts/rules-consistency.js --list       # 打印解析结果（编号集合、条数、欠账册、「下一步」列读数）
 * 挂载点：`npm run verify`（纯文本解析，毫秒级；紧随 G8 之后）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RULES = 'docs/RULES.md';

/** 参与"引用闭合"扫描的文档（**不含 CHANGELOG.md**：历史里出现已退役编号是正常的；
 *  `docs/changelog/` 同理不扫 —— 那是滚动归档的历史版本段） */
const SCAN_DOCS = [
  'SKILL.md', 'README.md', 'docs/RULES.md', 'docs/AI-GUIDE.md', 'docs/ARCHITECTURE.md',
  'docs/VERIFY.md', 'docs/EXTENSIONS.md', 'docs/DATA-FORMAT.md', 'docs/ROADMAP.md',
  'docs/INCIDENTS.md'
];

/** 「**必须**声明条数」的二级章节 —— **靠名字定位，不靠章节号**（编号会动，名字是这一节的唯一标志；
 *  与 §7 的 `LEDGER_HEADING_RE`、⑨ 的 `IN_FLIGHT_HEADING_RE` 同一个纪律）。
 *
 *  为什么需要这张表（实测缺陷，`.review/20261020-声明对齐/`）：
 *  判定 ① 只在**有人写了**「共 N 条」时才生效 —— 于是**把那句声明删掉、表格一行不动**，
 *  就等于**静默关掉**这条判定。实测三个实验：§4 删一行 ⇒ exit 1（判定有效）；
 *  补回 ⇒ exit 0；**删掉标题里的「共 16 条」（表仍 16 行）⇒ exit 0**（后门）。
 *  ⇒ 所以「章节在、就必须写条数声明」这一条本身也得判。同一条纪律本工程已写过两遍：
 *  `doc-facts.js` 第一屏步骤数（`stepCountProblem`：**字样缺失也判红**）、本文件判定 ⑨
 *  （找不到标题 ⇒ 按红处理，照 skill `B8`：适用条件不得由被检查方自己决定）。
 *
 *  为什么只收 §4：§3 的条数在**别处**另有 ⑤（转述一致性）守，§7 另有 ⑦ / ⑧ 守它的复核面；
 *  而 §4（约定与架构决策）原先**一条判定都没有** —— 删一行它不红，删整节也没人看得见。
 *  这张表**只收"必须有声明"的章节**，不收条数（条数由表格现数，本文件不写第二份）。 */
const COUNT_REQUIRED_SECTIONS = [
  { id: 'section-4', name: '§4 约定与架构决策', re: /^##\s+\d+\.\s*.*约定与架构决策/ }
];

/** 解析出「共 N 条」这类条数声明。返回 {section, claimed, line}[]（只取真的声明了的）。 */
function parseCountClaims(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s+(\d+)\./.exec(lines[i]);
    if (!h) continue;
    const m = /共\s*(\d+)\s*条/.exec(lines[i]);
    if (!m) continue;
    out.push({ section: h[1], claimed: parseInt(m[1], 10), line: i + 1, heading: lines[i] });
  }
  return out;
}

/** 取 startIdx 之后的**第一张 markdown 表**（极大连续 `|` 行块）。
 *  返回 {start, end, total, rows}，rows = 去掉表头与分隔行后的行数；没有表则 null。 */
function firstTableAfter(lines, startIdx) {
  let s = -1;
  for (let i = startIdx; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) { s = i; break; }
    if (/^##\s/.test(lines[i])) return null;   // 撞到下一个二级标题：本段没有表
  }
  if (s < 0) return null;
  let e = s;
  while (e + 1 < lines.length && /^\s*\|/.test(lines[e + 1])) e++;
  const total = e - s + 1;
  const hasHeader = total >= 3 && /^\s*\|[\s:|-]+\|\s*$/.test(lines[s + 1]);
  return { start: s, end: e, total, rows: hasHeader ? total - 2 : total };
}

/** 找出所有「ID 行」（表格里的 `| **G1** |` / `| **R3a** |` / `| **M1 准入** |`），
 *  并按连续性分组，报出**被打断**的位置。 */
const ID_ROW_RE = /^\s*\|\s*\*\*([GRM]\d+[a-z]?)\b/;

function findIdRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ID_ROW_RE.exec(lines[i]);
    if (m) rows.push({ id: m[1], line: i + 1, idx: i });
  }
  return rows;
}

/** 找出某个行号所属的二级章节（最近的前一个 `## N.` 标题）。 */
function sectionOf(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = /^##\s+(\d+)\./.exec(lines[i]);
    if (m) return { section: m[1], line: i + 1 };
  }
  return { section: null, line: 0 };
}

/** 把 ID 行按"相邻行号差 1"切成连续块；块数 > 1 即说明表格被空行/引用块打断过。 */
function splitBlocks(rows) {
  const blocks = [];
  for (const r of rows) {
    const last = blocks[blocks.length - 1];
    if (last && r.idx === last[last.length - 1].idx + 1) last.push(r);
    else blocks.push([r]);
  }
  return blocks;
}

/** 收集文档里引用的编号。形如 G8 / R3a / M1（词边界），去重。
 *  **lookbehind 只排除单词字符** —— 不能连 `*` 和反引号一起排除：
 *  `**G8**` 与 `` `G5` `` 恰是本工程最常用的引用写法，排除掉会让本判定近乎失效。
 *  同时 `Group2`（G 后非数字）与 `R2D2`（后缀超一个字母）不会被误抓。 */
function collectReferences(text) {
  const found = new Map(); // id -> 首次出现行号
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/(?<!\w)([GRM]\d+[a-z]?)(?!\w)/g)) {
      if (!found.has(m[1])) found.set(m[1], i + 1);
    }
  }
  return found;
}

/** 「转述声明」：别的文档里对「铁律 / 门禁 / 元规则」条数的复述。
 *  真实事故：`README.md` §九 写「铁律（无法机械化，共 5 条）」，而 `docs/RULES.md` 实际 6 条 ——
 *  正是 RULES.md §0 自述的那类病（同一事实多副本、无单源）在**条数**上的复发。 */
const RESTATE_RE = /(铁律|门禁|元规则)[^）)\n]{0,24}?共\s*(\d+)\s*条/g;

/** 「判定条数声明」：门禁行里写「（N 条判定）」，而**实际条数由实现脚本现场数出来**。
 *  为什么需要（真实事故）：某门禁加到第 13 条判定时，只更新了架构文档一处 ——
 *  于是同一个门禁的条数在四处有四个说法（规则文件 12 且只列 11 项 / 架构文档 13 /
 *  脚本头注释"三条" / 代码实际 13）。而 `RESTATE_RE` 要求「共 N 条」字样，**抓不到「（N 条判定）」**。
 *  现在改成：声明的数字必须等于实现脚本里 ①–⑳ 标记的**去重个数** —— 数字与标记两边都得对得上，
 *  而且标记**不许重复**（实测：脚本里有两个 ①，导致"数一遍"得到 14）。
 *  ⚠️ 声明式的写法必须容忍 markdown 强调（加粗 / 空格都不影响识别）——
 *  实测：把声明写成加粗之后，旧正则**静默失配**，整个计数比对被悄悄停用，而门禁照样全绿。
 *  这类"改动把守卫关掉了却没人发现"正是本工程的头号病，故单测里锁了一条加粗声明的用例。 */
const DECLARED_COUNT_RE = /（\s*(?:\*\*)?\s*(\d+)\s*条判定/;
const JUDGMENT_MARKER_RE = /\/\/\s*([①-⑳])/g;

/** 数出某个脚本里"判定标记"的去重个数与重复项 */
function collectJudgmentMarkers(absPath) {
  let text = '';
  try { text = fs.readFileSync(absPath, 'utf8'); } catch (e) { return null; }
  const seen = [];
  const dup = [];
  for (const m of text.matchAll(JUDGMENT_MARKER_RE)) {
    if (seen.includes(m[1])) { if (!dup.includes(m[1])) dup.push(m[1]); }
    else seen.push(m[1]);
  }
  return { uniq: seen.length, dup: dup, marks: seen };
}

/** **现场取**判定清单（`--judgments` 用）：只认行首注释里的圈码标记行（形如"两斜线 + ①"），标题取标记后的一小段。
 *  为什么从源码现场取、而不是维护一份清单：清单抄一份就是第二份会漂的副本 —— 本工程为此吃过两次亏
 *  （一处写「共 5 条」表却 6 行；另一处四处三个说法）。标记与条数的**权威仍是**
 *  `docs/RULES.md` §2 的门禁行（由判定⑥ 对齐），这里只是"同一份实现的另一种读法"。
 *  同形工具：G8 的 `node scripts/docs-registry-check.js --judgments`。 */
function listJudgments(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\/\/\s*([①-⑳])\s*(.*)$/.exec(line);
    if (!m) continue;
    // 标题 = 标记后的第一小句（到 `；` / `。` 为止），去掉 markdown 强调与行内代码
    const raw = m[2].split(/[；;。]/)[0].replace(/[*`]/g, '').trim();
    out.push({ mark: m[1], title: raw.slice(0, 80) });
  }
  return out;
}

/** 从 §2 表里抽出"实现"列点名的仓库内脚本路径（含 `/` 且以 .js 结尾；跳过含 * 的） */
function collectImplScripts(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ID_ROW_RE.test(lines[i]) || !/^\s*\|\s*\*\*G\d+/.test(lines[i])) continue;
    for (const m of lines[i].matchAll(/`([^`]+)`/g)) {
      const tok = m[1].trim();
      if (tok.includes('*')) continue;                 // 通配（如 scripts/smoke/NN-*.js）
      if (!tok.includes('/') || !/\.js$/.test(tok)) continue;
      out.push({ token: tok, line: i + 1 });
    }
  }
  return out;
}

/* ---------------- 封闭欠账册（§7）的**复核面**：判定 ⑦ / ⑧ 的常量与解析 ---------------- */

/** §7 的定位靠**标题里的"封闭欠账册"**（不靠章节号：编号会动，名字是这一节的唯一标志）。 */
const LEDGER_HEADING_RE = /^##\s+\d+\.\s*.*封闭欠账册/;

/** 「在册对象」里允许出现、但**不在本仓库**的路径 token（第三方包内 / 机器本地路径）。
 *  **必须登记在门禁侧**，不许由被检查的那一行自己说一句"这个别查"来决定要不要查（照 skill `B8`）：
 *  每条要写 `reason`；条数有上界 `LEDGER_NON_REPO_CAP`（只减不增）；复审时机 = 每次动 §7 的条目时。
 *  ⚠️ 收这条的理由是**实测**（本批基线读数）：`W8` 的「在册对象」写的是 `dsh-browser-plus` **包内**的
 *  `docs/tool-reference.md` —— 直接当仓库路径查会得到**假红**。那一类只配进这张表；
 *  **不许**为了消掉假红去放宽判定本身（放宽 = 以后真有仓库路径被删也不报了）。 */
const LEDGER_NON_REPO_PATHS = [
  { token: 'docs/tool-reference.md', reason: '在 `dsh-browser-plus` **第三方包内**（相对包根；本仓库没有这个文件）' }
];
const LEDGER_NON_REPO_CAP = 1;

/** 取反引号包住的 token（行内代码），按出现顺序。用 charCode 拼出反引号：**注释里写反引号会把 markdown 写坏**。 */
const TICK = String.fromCharCode(96);
function collectTickedTokens(text) {
  const s = String(text || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== TICK) continue;
    const j = s.indexOf(TICK, i + 1);
    if (j < 0) break;
    out.push(s.slice(i + 1, j));
    i = j;
  }
  return out;
}

/** 把 `| a | b |` 拆成 ['a','b']（去掉行首/行尾的空串再 trim）。 */
function parseCells(line) {
  const parts = String(line).split('|');
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((c) => c.trim());
}

/** 像"仓库内路径"的 token：含 `/`，或以常见扩展名结尾。
 *  **排除**：通配（含 `*`）、带空格（那是"路径 + 参数"，如 `scripts/x.js --list`）、带协议头。
 *  实测误报面（都真的出现过）：`ok / swept / failed / errors`（散文里的斜杠）、`:78-87`（行号区间）、
 *  `writeJsonAtomic`（标识符）、`%TEMP%`（机器路径）。 */
function looksLikeRepoPath(tok) {
  const t = String(tok || '').trim();
  if (!t || t.includes('*') || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  const bare = t.replace(/:\d+(-\d+)?$/, '');
  return /[/\\]/.test(bare) || /\.(js|json|txt|md|css|html|vbs)$/i.test(bare);
}

/** 扫 §7 封闭欠账册：逐行解析 ID / 在册对象 / 复核命令，并对「在册对象」里的仓库路径做**存在性**检查。
 *  返回 { rows, problems, checkedSites, checkedRows, exempt, unchecked }；problems 由 analyze() 的 ⑧ 收口。
 *  纯函数（只读 fs.existsSync，不写盘、不打印），便于单测。 */
function scanLedger(lines, opts) {
  const o = opts || {};
  const nonRepo = o.nonRepoPaths || LEDGER_NON_REPO_PATHS;
  const cap = typeof o.nonRepoCap === 'number' ? o.nonRepoCap : LEDGER_NON_REPO_CAP;

  const rows = [];
  const problems = [];
  const unchecked = [];
  let checkedSites = 0;
  let checkedRows = 0;
  let exempt = 0;

  const h = lines.findIndex((l) => LEDGER_HEADING_RE.test(l));
  const tbl = h >= 0 ? firstTableAfter(lines, h + 1) : null;
  if (tbl) {
    for (let i = tbl.start + 2; i <= tbl.end; i++) {
      const cells = parseCells(lines[i]);
      const id = (cells[0] || '').replace(/\*/g, '').trim();
      if (!/^[A-Za-z]+\d+$/.test(id)) continue;          // 只认形如 `**W3**` 的数据行
      const toks = collectTickedTokens(lines[i]);
      rows.push({ id, line: i + 1, cells, cmds: toks.filter((t) => /^node\s+\S/.test(t.trim())) });
    }
  }

  // （承 ⑧）在册对象的路径存在性（+ 在册豁免的封闭性）
  const used = new Set();
  for (const r of rows) {
    const cand = collectTickedTokens(r.cells[1] || '').filter(looksLikeRepoPath);
    let sites = 0;
    const exemptToks = [];
    for (const raw of cand) {
      const tok = raw.replace(/:\d+(-\d+)?$/, '');
      const ex = nonRepo.find((e) => e.token === tok);
      if (ex) { used.add(tok); exempt++; exemptToks.push(tok); continue; }
      sites++;
      checkedSites++;
      if (!fs.existsSync(path.join(ROOT, tok))) {
        problems.push({ kind: 'ledger-path', rel: RULES + ':' + r.line,
          msg: '欠账 ' + r.id + ' 的「在册对象」点到 `' + tok + '`，但本仓库里没有这个文件 —— '
            + '册上的对象已经改名/删了，却还挂在册上（' + RULES + ' §7 明写这必须当缺陷处理）。'
            + '收口：销账（并把标题的上界减一），或把这一格改成现在的路径' });
      }
    }
    if (sites) checkedRows++;
    else if (exemptToks.length) unchecked.push({ id: r.id, why: 'exempt', tokens: exemptToks });
    else unchecked.push({ id: r.id, why: 'none', tokens: [] });
  }

  // 豁免自己的封闭性：必须有原因 · 有上界 · **册上已经用不到的那条要删掉**（只减不增）
  if (nonRepo.length > cap) {
    problems.push({ kind: 'ledger-path', rel: 'scripts/rules-consistency.js',
      msg: '「在册非仓库路径」豁免有 ' + nonRepo.length + ' 处 > 上界 ' + cap
        + ' —— 豁免只减不增；要加必须同批抬上界并写明理由（抬上界是一次显式提交，不是顺手改个数字）' });
  }
  for (const e of nonRepo) {
    if (!String(e.reason || '').trim()) {
      problems.push({ kind: 'ledger-path', rel: 'scripts/rules-consistency.js',
        msg: '豁免 `' + e.token + '` 没写 reason —— 不带原因的豁免迟早变成"谁都不敢删的黑洞"' });
    }
    if (!used.has(e.token)) {
      problems.push({ kind: 'ledger-path', rel: 'scripts/rules-consistency.js',
        msg: '豁免 `' + e.token + '` 在 ' + RULES + ' §7 的「在册对象」里已经找不到了 —— 这条豁免该删'
          + '（豁免只减不增；留着它等于给将来某个同名 token 预先开好口子）' });
    }
  }

  return { rows, problems, checkedSites, checkedRows, exempt, unchecked };
}

/* ---------------- 判定 ⑨ 的常量与解析：`docs/ROADMAP.md`「在飞」表的「下一步」列 ----------------
 * 见文件头注释的判定清单与那一条的边界说明。这里只补两件**实现级**的东西：
 *   · 禁词**一处实现**（`NEXT_STEP_BANNED`）—— 文档与报告里只许写"禁词表在门禁里"，不许各抄一份
 *     （抄一份就是第二份会漂的副本，本工程已经为此吃过两次亏）；
 *   · **列位置不写死**：按表头文字找「下一步」列（实测这张表加过「证据」列，列序变过）。
 */

/** 「在飞」小节的标题形状 —— 与 G8 判定⑥**同一个形状**（靠名字定位，不靠章节号：编号会动）。 */
const IN_FLIGHT_HEADING_RE = /^##\s.*在飞\s*\/\s*未收口/;
const NEXT_STEP_REL = 'docs/ROADMAP.md';
const NEXT_STEP_COLUMN = '下一步';
const NEXT_STEP_THEME_COLUMN = '主题';

/** 「下一步」里的**空话禁词**（**一处实现**；文档只许引用本表，不许再抄一份）。
 *  收词判据 = 这句话**不告诉你下一步做什么**，而它经常被用来代替"下一步"。
 *  实测来源：用户 2026-10-19 的诊断里点名了前三个；其余几个是同一次盘点里出现过的同型说法。
 *  ⚠️ 这张表是**判红**的依据，不是"语义词典"：判的是"整格是不是只剩这些词"，不是"句子里有没有"。 */
const NEXT_STEP_BANNED = ['继续推进', '视情况', '看情况', '待定', '按需', '后续再说', 'TODO', '再说'];

/** 只剩这些**占位符**的单元格按"空"处理（占位符不是动作）。 */
const NEXT_STEP_PLACEHOLDERS = ['-', '—', '–', '——', '…', '...'];

/** 把「下一步」单元格切成"词块"：去掉 markdown 强调 / 行内代码标记，按标点与空白切分。
 *  纯函数（无 IO），便于单测。**切分只为回答"整格是不是全是禁词"**，不承担语义判断。
 *  ⚠️ 反引号在这里按"标记"剥掉，所以 `node cli/mm-cli.js …` 这类命令会**保留内容**（它含 `/` 与空格，
 *  切成多块，块块非禁词）⇒ 具体动作必然放行 —— 这是刻意的窄口径（宁可漏过，不可乱红）。 */
function splitNextStepCell(cell) {
  const s = String(cell == null ? '' : cell).replace(/[*`]/g, '');
  return s.split(/[\s\u3000·、，,。；;：:！!？?（）()\[\]【】<>|/]+/).filter(Boolean);
}

/** 判一个「下一步」单元格 ⇒ `{verdict, tokens, banned}`。
 *  `verdict` 三态：`pass` / `empty`（空或只有占位符）/ `banned`（词块**全部**是禁词）。
 *  纯函数。**只在 "banned" 上判红** —— 禁词出现在**更长的句子**里（例：`继续推进 §7 的裁决`）走 `pass`，
 *  由 main() 打一行"只报告"提示（照 skill `B8`：判不准的那一档要打印理由，不许伪装成判过）。 */
function classifyNextStepCell(cell) {
  const raw = String(cell == null ? '' : cell).replace(/[*`]/g, '').trim();
  const tokens = splitNextStepCell(cell);
  const banned = tokens.filter((t) => NEXT_STEP_BANNED.some((w) => t.toLowerCase() === w.toLowerCase()));
  if (!raw || NEXT_STEP_PLACEHOLDERS.includes(raw) || !tokens.length) {
    return { verdict: 'empty', tokens, banned };
  }
  if (banned.length === tokens.length) return { verdict: 'banned', tokens, banned };
  return { verdict: 'pass', tokens, banned };
}

/** 扫 `docs/ROADMAP.md`「在飞 / 未收口」表，逐行判「下一步」列。
 *
 *  **能力边界（三档，必须与门禁输出一致；照 skill `B8`）**：
 *   · **判红**：① 单元格**为空**（或只有占位符 `-` / `—` / `…`）；
 *             ② 单元格切出的**词块全部**落在 `NEXT_STEP_BANNED` 里（例：下一步 = `继续推进`）；
 *             ③ 采不到真值：**小节 / 表格 / 「下一步」列**缺一即红（删掉标题或那一列就能让本条静默失效，
 *                照 skill `B8`「适用条件不得由被检查方自己决定」）。
 *   · **只报告（不判红）**：禁词**出现在更长的句子里**（例：`继续推进 §7 的裁决`）—— 本判据数的是
 *             "整格是不是空话"，不做语义判断，故只打印一行提示（打印在输出里，见 main()）。
 *   · **跳过（不判红，但**当场打印跳过了什么、在哪、多少**）**：本节表里 **0 条数据行**
 *             （"发版时本小节必须清空或移入版本段"是 `docs/ROADMAP.md` 头部的明文规矩，那时整列没有对象）。
 *             **跳过与"通过"分开打印、分开计数** —— 不声明地跳过比假红更坏（照 skill `A5` / `B8`）。
 *
 *  ⚠️ **本判据挡不住"写得像动作但是空话"**：它只认"空"与"整格都是禁词"。
 *    例：`看 ROADMAP 的下一步` / `推进主链` / `按计划做` / `把这件事做完` 全都**会放行**。
 *    判断"一条动作是否真的可执行"需要理解语义 —— 按本工程 M1（无据不做假硬门禁）**刻意不做**：
 *    语义判据会造长期假红，最后连真红也没人看。
 *    它也**判不了"无 / 无需后续"这类断言式的空**（`已收口` 行里这是正常写法）—— 那是内容对错，属人工残差。
 *
 *  **反绕过**：**不按 `状态` 列筛行** —— 若 `状态=已收口` 能跳过检查，被检查方自己就能把守卫关掉。
 *
 *  返回 `{ found, hasTable, columnIndex, rows, problems, skip }`：
 *  `rows[] = {line, label, cell, verdict, tokens, banned}`（`label` = 该行「主题」列，供点名用）。
 *  纯函数（只读传入的文本；不打印、不退出），便于单测、`--list` 与 main() 复用。 */
function scanNextStep(roadmapText) {
  const out = { found: false, hasTable: false, columnIndex: -1, rows: [], problems: [], skip: null };
  if (roadmapText == null) { out.skip = { why: 'no-text' }; return out; }
  const lines = String(roadmapText).split('\n');
  const head = lines.findIndex((l) => IN_FLIGHT_HEADING_RE.test(l));
  if (head < 0) {
    out.problems.push({ kind: 'next-step', rel: NEXT_STEP_REL,
      msg: '找不到标题形如「## … 在飞 / 未收口」的小节 —— 删掉或改名这个标题就能让判定 ⑨ 静默失效，'
        + '故按红处理（照 skill `B8`：适用条件不得由被检查方自己决定）。'
        + '收起：把标题改回来（形如 `## 在飞 / 未收口（**交接面** …）`）' });
    return out;
  }
  out.found = true;
  const tbl = firstTableAfter(lines, head + 1);
  if (!tbl) {
    out.problems.push({ kind: 'next-step', rel: NEXT_STEP_REL + ':' + (head + 1),
      msg: '「在飞 / 未收口」小节里没有表格 —— 交接面没有表就无从判「下一步」；'
        + '删掉表同样能让本条静默失效，故按红处理。收起：发版清空也请**保留表头**（0 条数据行是"跳过"档）' });
    return out;
  }
  out.hasTable = true;
  const strip = (c) => String(c == null ? '' : c).replace(/[*`]/g, '').trim();
  const headerCells = parseCells(lines[tbl.start]);
  const col = headerCells.findIndex((c) => strip(c) === NEXT_STEP_COLUMN);
  const themeCol = headerCells.findIndex((c) => strip(c) === NEXT_STEP_THEME_COLUMN);
  if (col < 0) {
    out.problems.push({ kind: 'next-step', rel: NEXT_STEP_REL + ':' + (tbl.start + 1),
      msg: '表头里没有「' + NEXT_STEP_COLUMN + '」列（现有表头：' + headerCells.join(' / ') + '）—— '
        + '删掉或改名这一列就能让本条静默失效，故按红处理。收起：表头保留一格写作「' + NEXT_STEP_COLUMN + '」' });
    return out;
  }
  out.columnIndex = col;
  for (let i = tbl.start + 2; i <= tbl.end; i++) {
    const cells = parseCells(lines[i]);
    const cell = cells[col] == null ? '' : cells[col];
    const c = classifyNextStepCell(cell);
    const rawLabel = strip(themeCol >= 0 ? cells[themeCol] : '');
    const label = rawLabel ? rawLabel.slice(0, 48) : '第 ' + (i + 1) + ' 行';
    out.rows.push({ line: i + 1, label, cell: String(cell).trim(), verdict: c.verdict, tokens: c.tokens, banned: c.banned });
    if (c.verdict === 'empty') {
      out.problems.push({ kind: 'next-step', rel: NEXT_STEP_REL + ':' + (i + 1),
        msg: '「' + label + '」这一行的「' + NEXT_STEP_COLUMN + '」是空的 —— 在飞的事没有"下一步"'
          + '就等于把回程票丢了（2026-10-19 主链被打断就是这个形状：3 条在飞里 2 条做完没结案、'
          + '「下一步」在文档里根本不存在）。收起：写一条**可执行命令或可指派动作**'
          + '（例：`node cli/mm-cli.js visit --help`），或把这一条从「在飞」挪进版本段' });
    } else if (c.verdict === 'banned') {
      out.problems.push({ kind: 'next-step', rel: NEXT_STEP_REL + ':' + (i + 1),
        msg: '「' + label + '」这一行的「' + NEXT_STEP_COLUMN + '」只写了空话（' + c.banned.join('、') + '）—— '
          + '它看起来像动作，但谁也不知道下一步做什么。禁词表在 `scripts/rules-consistency.js` 的 `NEXT_STEP_BANNED`。'
          + '收起：换成可执行命令或可指派动作；'
          + '⚠️ 本判据只判"整格是不是空话"，**判不了"这条动作是否真的可执行"**（见 `scanNextStep` 的边界注释）' });
    }
  }
  if (!out.rows.length) out.skip = { why: 'no-rows' };
  return out;
}

/** 纯函数形式的判定（清单见 `analyze()` 的 ①…⑨ 标记）；返回 problems[]（不打印、不退出），便于单测。 */
function analyze(rulesText, docTexts) {
  const lines = String(rulesText || '').split('\n');
  const problems = [];

  // ① 声明的条数 == 表格实际行数
  for (const c of parseCountClaims(lines)) {
    const t = firstTableAfter(lines, c.line);
    if (!t) {
      problems.push({ kind: 'count', rel: RULES + ':' + c.line,
        msg: '§' + c.section + ' 声明了「共 ' + c.claimed + ' 条」，但该段之后没有找到表格' });
      continue;
    }
    if (t.rows !== c.claimed) {
      problems.push({ kind: 'count', rel: RULES + ':' + c.line,
        msg: '§' + c.section + ' 标题声明「共 ' + c.claimed + ' 条」，表格实际 ' + t.rows
          + ' 行（表头在 ' + (t.start + 1) + ' 行）—— 声明数与实际数必须一致' });
    }
  }

  // （承 ①）「必须声明条数」的章节：**章节在，就必须写「共 N 条」**。
  //   否则把声明删掉就等于让判定 ① 静默失效（实测后门，见 `COUNT_REQUIRED_SECTIONS` 的注释）。
  //   章节**不在**本文件里 ⇒ 此处**不判**（交给 main() 的真门禁：采不到真值 = 红）——
  //   单测常只喂一段合成文本，在这里判红会把"喂片段"变成假红（与 ⑨ 的 `docTexts` 处理同一条纪律）。
  const claimLines = new Set(parseCountClaims(lines).map((c) => c.line));
  for (const sec of COUNT_REQUIRED_SECTIONS) {
    const idx = lines.findIndex((l) => sec.re.test(l));
    if (idx < 0) continue;
    if (claimLines.has(idx + 1)) continue;
    problems.push({ kind: 'count', rel: RULES + ':' + (idx + 1),
      msg: sec.name + ' 的标题里**没有**「共 N 条」声明 —— 把声明删掉（表格一行不动）就等于**静默关掉**'
        + '判定 ①，而这一节原本因此整节无人守（实测：删掉声明后本门禁 exit 0）。'
        + '门禁不能允许被检查方自己关掉判定（照 skill `B8`）。收起：把「共 N 条」写回标题，N = 该节表格的数据行数' });
  }

  // ② 表格结构：**按章节分组**后检查连续性
  //    不能拿"全部 ID 行"一起比相邻 —— §2 的 G 表、§3 的 R 表、§5 的 M 表本来就是三张
  //    不同的表，跨章节的间隔不是缺陷（第一版就是这么误报的，实测 2 处假红）。
  //    本门禁据此定下一条约定：**一个二级章节里只允许一张 ID 表**。
  const idRows = findIdRows(lines);
  const bySection = new Map();
  for (const r of idRows) {
    const sec = sectionOf(lines, r.idx);
    const key = sec.section === null ? '(无所属章节)' : '§' + sec.section;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(r);
  }
  for (const [key, rows] of bySection) {
    const first = rows[0];
    // 首行上方两行必须是「表头 + 分隔行」
    if (first.idx < 2
      || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[first.idx - 1])
      || !/^\s*\|/.test(lines[first.idx - 2])) {
      problems.push({ kind: 'table', rel: RULES + ':' + first.line,
        msg: key + ' 的 ID 行 ' + first.id + ' 上方不是「表头 + 分隔行」—— '
          + '这张表缺表头，或该行已掉出表格（会被渲染成纯文本，等于静默消失）' });
    }
    for (let k = 1; k < rows.length; k++) {
      const prev = rows[k - 1];
      const cur = rows[k];
      if (cur.idx - prev.idx > 1) {
        const between = lines.slice(prev.idx + 1, cur.idx);
        const why = between.some((l) => /^\s*>/.test(l)) ? '引用块'
          : between.some((l) => l.trim() === '') ? '空行' : '非表格行';
        problems.push({ kind: 'table', rel: RULES + ':' + (prev.line + 1),
          msg: key + ' 的表格在 ' + prev.id + '（' + prev.line + ' 行）与 ' + cur.id
            + '（' + cur.line + ' 行）之间被' + why + '打断（' + between.length + ' 行）—— '
            + 'markdown 表格一断即结束，' + cur.id + ' 及之后的行会掉出表格' });
      }
    }
  }

  // ③ 编号闭合：引用的 G/R/M 必须在 RULES.md 里有定义
  const defined = new Set(idRows.map((r) => r.id));
  for (const [rel, text] of Object.entries(docTexts)) {
    for (const [id, line] of collectReferences(text)) {
      if (!defined.has(id)) {
        problems.push({ kind: 'ref', rel: rel + ':' + line,
          msg: '引用了 ' + id + '，但 ' + RULES + ' 里没有定义它 —— 悬挂引用（改了规则表却忘了改引用？）' });
      }
    }
  }

  // ④ §2「实现」列点名的脚本必须存在
  for (const s of collectImplScripts(lines)) {
    if (!fs.existsSync(path.join(ROOT, s.token))) {
      problems.push({ kind: 'impl', rel: RULES + ':' + s.line,
        msg: '实现列点名 `' + s.token + '`，但该文件不存在 —— 门禁被删/改名后规则表没跟着改' });
    }
  }

  // ⑤ 其他文档对「铁律 / 门禁 / 元规则条数」的转述必须与实际一致
  //    （RULES.md 自己的声明由判定①按章节校验，这里跳过它以免同一问题报两遍）
  const counts = {
    门禁: idRows.filter((r) => r.id[0] === 'G').length,
    铁律: idRows.filter((r) => r.id[0] === 'R').length,
    元规则: idRows.filter((r) => r.id[0] === 'M').length
  };
  for (const [rel, text] of Object.entries(docTexts)) {
    if (rel === RULES) continue;
    const tl = String(text).split('\n');
    for (let i = 0; i < tl.length; i++) {
      for (const m of tl[i].matchAll(RESTATE_RE)) {
        const label = m[1];
        const claimed = parseInt(m[2], 10);
        if (counts[label] !== claimed) {
          problems.push({ kind: 'restate', rel: rel + ':' + (i + 1),
            msg: '称「' + label + '…共 ' + claimed + ' 条」，但 ' + RULES + ' 里实际有 '
              + counts[label] + ' 条 —— 转述的条数必须与实际一致' });
        }
      }
    }
  }

  // ⑥ 门禁声明的「（N 条判定）」必须 == 实现脚本里 ①–⑳ 标记的去重个数；标记不许重复；
  //    并且**除本门禁行外，任何地方都不得再写「N 条判定」**（复述即第二份会漂移的副本）。
  //    注意：只抓**总数声明**（形如"（N 条判定）"、"含 G8 的 N 条判定"），
  //    **不抓两类误报**（两轮实测各踩一次）：
  //      - 序数标签："第 N 条判定"指的是某一条，不是总数 ⇒ 先把序数剥离再判
  //        （写 `(?<!第)` 不够：中文里"第 7 条"中间有空格）；
  //      - 汉语"一"的动宾搭配："加一条""多一条"里的一不是数量 ⇒ 汉语数词只认 ≥ 二。
  const JUDGMENT_COUNT_RE = /(?:[0-9]+|[二三四五六七八九十]+)\s*条判定/;
  const ORDINAL_JUDGMENT_RE = /第\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*条判定/g;
  const restatesJudgmentCount = (line) => JUDGMENT_COUNT_RE.test(String(line).replace(ORDINAL_JUDGMENT_RE, ''));

  // （承 ⑥）对 §2 点名的**所有**实现脚本：标记必须唯一 + 注释里不得写死条数。
  //    ⚠️ 这一层是第二轮复核指出的"后门"补丁：早期版本只扫"**声明了数字条数**的门禁行"，
  //    于是 G9 自己那行（写作「N 条判定」，没有数字）整段被跳过 —— 门禁给自己留了后门，
  //    它的实现文件里同时存在"标记重复"与"注释写死条数"两种它本该消灭的病。
  const allImplScripts = [...new Set(collectImplScripts(lines).map((s) => s.token))]
    .filter((rel) => !/^tests\//.test(rel) && !/\.test\.js$/.test(rel));   // 测试文件不是"判定清单的载体"
  for (const rel of allImplScripts) {
    const info = collectJudgmentMarkers(path.join(ROOT, rel));
    if (!info) continue;                                // 文件不存在 → 由判定④报
    if (info.dup.length) {
      problems.push({ kind: 'gate-count', rel: rel,
        msg: '判定标记重复：' + info.dup.map((d) => '`' + d + '`').join('、')
          + ' 各出现多次 —— 标记必须唯一，否则"数一遍"会得到偏大的数。'
          + '实测同一形状踩过三次：脚本里出现两个 `①`（数出 14）；`⑥` 与 `⑥b` 被算成两个 ⑥；'
          + '连"解释误报的注释"里也各写了一遍标记。续写或举例请用「（承 ⑥）」这类写法（不计入），'
          + '或把枚举搬进不参与计数的位置' });
    }
    const st = String(fs.readFileSync(path.join(ROOT, rel), 'utf8')).split('\n');
    for (let k = 0; k < st.length; k++) {
      if (!restatesJudgmentCount(st[k])) continue;
      problems.push({ kind: 'gate-count', rel: rel + ':' + (k + 1),
        msg: '实现脚本的注释/文案里写死了判定条数 —— 条数只有一个权威（本文件 §2 的门禁行），'
          + '请改成"清单见 ①…⑳ 标记"，否则加一条判定就会出现又一种说法'
          + '（实测：本门禁自己的头注释曾写死条数，正是它要消灭的那种病；'
          + '连"解释这条判定"的注释里也不该出现那个数字）' });
    }
  }

  // （承 ⑥）门禁行**声明了数字**时，数字必须 == 实现脚本的标记数
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|\s*\*\*G\d+/.test(lines[i])) continue;
    const dm = DECLARED_COUNT_RE.exec(lines[i]);
    if (!dm) continue;                                  // 没声明数字的门禁行跳过数字比对（标记检查已在上面的 ⑥-甲 覆盖）
    const declared = Number(dm[1]);
    const id = (/^\s*\|\s*\*\*(G\d+)/.exec(lines[i]) || [])[1];
    const scripts = [];
    for (const m of lines[i].matchAll(/`([^`]+)`/g)) {
      const tok = m[1].trim();
      if (tok.includes('*') || !tok.includes('/') || !/\.js$/.test(tok)) continue;
      // 只认**实现脚本**：测试文件（`tests/*.test.js`）不是"判定清单的载体"，
      // 它没有 ①…⑳ 标记，纳入比对会得到 0 条而误报（实测：第一版就把 tests/*.test.js 算进来了）。
      if (/^tests\//.test(tok) || /\.test\.js$/.test(tok)) continue;
      scripts.push(tok);
    }
    if (!scripts.length) {
      problems.push({ kind: 'gate-count', rel: RULES + ':' + (i + 1),
        msg: id + ' 声明了「' + declared + ' 条判定」，但实现列没有点名任何脚本 —— '
          + '条数必须能与实现现场对齐，否则它只是一个手写数字' });
      continue;
    }
    for (const rel of scripts) {
      const info = collectJudgmentMarkers(path.join(ROOT, rel));
      if (!info) continue;
      if (declared !== info.uniq) {
        problems.push({ kind: 'gate-count', rel: RULES + ':' + (i + 1),
          msg: id + ' 声明「' + declared + ' 条判定」，但 `' + rel + '` 里实际有 ' + info.uniq
            + ' 条（标记 ' + info.marks.join('') + '）—— 加/删判定后两处必须同批更新'
            + '（脚本头注释也不要写死条数，改为指向标记）' });
      }
    }
  }

  // （续 ⑥）其他文档里也不得复述判定条数（应改为指针）—— 实测：路线图曾复述该条数，而实际条数已变
  for (const [rel, text] of Object.entries(docTexts)) {
    if (rel === RULES) continue;
    const tl = String(text).split('\n');
    for (let i = 0; i < tl.length; i++) {
      if (!restatesJudgmentCount(tl[i])) continue;
      problems.push({ kind: 'gate-count', rel: rel + ':' + (i + 1),
        msg: '这里复述了门禁的判定条数 —— 条数只有一处权威（' + RULES + ' §2 的门禁行，且由本门禁与实现标记对齐）；'
          + '此处应改为指针（"判定清单见 ' + RULES + ' §2"），否则它会漂' });
    }
  }

  // ⑦ 封闭欠账册：**每一条必须带一条可执行的复核命令**（反引号包住、以 `node ` 开头）。
  //    实测缺口（2026-10-19 基线读数）：§7 那 8 条里只有 1 条带 `node …` 命令 ——
  //    而 §7 自己写着「册上写着它有问题、而它已经没有问题了」必须当缺陷处理，却**一直没有判定**。
  //    边界：只判**有没有**这条命令，**不判它跑不跑得通**（真跑是重活，照 skill §G 第 1 条）。
  //    ⚠️ 这里**不加可选参数**（签名保持 `(rulesText, docTexts)`）：`scripts/mutate-gates.js` 的
  //    负对照是按这一行的**逐字**锚点把本门禁钝化的 —— 签名一动，那条负对照会静默变成空转。
  //    需要换一套在册豁免 / 上界来做单测的，直接调 `scanLedger(lines, opts)`（它自己带 opts）。
  const ledger = scanLedger(lines);
  if (!ledger.rows.length) {
    problems.push({ kind: 'ledger-cmd', rel: RULES,
      msg: '找不到「封闭欠账册」（`## N. …封闭欠账册` 这一节的表格里 0 条）—— '
        + '门禁不能自称"已校验册上条目"：采不到真值 = 红（照 skill `G4`）' });
  }
  for (const r of ledger.rows) {
    if (r.cmds.length) continue;
    problems.push({ kind: 'ledger-cmd', rel: RULES + ':' + r.line,
      msg: '欠账 ' + r.id + ' 没有可执行的复核命令 —— 每一条都必须用反引号包住一条 `node …` 命令'
        + '（例：`node scripts/collateral-check.js`）。否则"这条债还成不成立"对下一个接手的人只是一句散文，'
        + '而 §7 的判据正是「还了必须销账、销账必须有据」' });
  }

  // ⑧ 「在册对象」里点到的**仓库路径**必须仍存在（§7：「册上的对象改名 / 删了」必须当缺陷）。
  //    只查能在仓库里定位的 token；查不到的**不判红**，但由 main() 打印"本条无路径可查"（边界可见）。
  problems.push(...ledger.problems);

  // ⑨ `docs/ROADMAP.md`「在飞 / 未收口」表的「下一步」列：**非空**且**不得只含空话**。
  //    逐条能力边界（判红 / 只报告 / 跳过）与"挡不住什么"见 `scanNextStep()` 的头注释。
  //    ⚠️ 与 ⑦ 同一个纪律：**`analyze()` 的签名不许动**（`mutate-gates.js` 的负对照按这一行的
  //    逐字签名锚点把本门禁钝化的 —— 签名一动那条负对照会静默变成空转）。
  //    所以 ⑨ 的输入从 `docTexts` 取（`docs/ROADMAP.md` 本来就在 `SCAN_DOCS` 里）；
  //    单测常只喂部分文档（`analyze(src, {})`）⇒ 缺这一份时记"跳过"、**不判红**；
  //    而**真门禁**由 main() 把"读不到 ROADMAP"单独判红（采不到真值 = 红，照 skill `G4`）。
  problems.push(...scanNextStep(docTexts && docTexts[NEXT_STEP_REL]).problems);

  return problems;
}

/* ---------------- 入口 ---------------- */

function readDoc(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function collectDocTexts() {
  const out = {};
  for (const rel of SCAN_DOCS) {
    const t = readDoc(rel);
    if (t !== null) out[rel] = t;
  }
  return out;
}

function main() {
  const rulesText = readDoc(RULES);
  if (rulesText === null) {
    console.error('找不到 ' + RULES + '（规则唯一权威副本）');
    process.exit(1);
  }
  const lines = rulesText.split('\n');
  const idRows = findIdRows(lines);
  const gates = idRows.filter((r) => r.id[0] === 'G').map((r) => r.id);
  const rules = idRows.filter((r) => r.id[0] === 'R').map((r) => r.id);
  const metas = idRows.filter((r) => r.id[0] === 'M').map((r) => r.id);

  const listMode = process.argv.includes('--list');
  const judgmentsMode = process.argv.includes('--judgments');
  if (listMode || judgmentsMode) {
    if (judgmentsMode) {
      console.log('规则文件自洽门禁（G9）—— 判定清单（**从源码的判定标记行现场取**，不维护第二份清单）');
      const js = listJudgments(__filename);
      for (const j of js) console.log('  ' + j.mark + ' ' + j.title);
      console.log('  共 ' + js.length + ' 条（条数与标记的权威 = ' + RULES + ' §2 的 G9 行，由判定⑥ 与这里对齐）');
      return;
    }
    console.log('规则文件自洽门禁（G9）—— 解析结果');
    console.log('  门禁 G : ' + gates.join(', '));
    console.log('  铁律 R : ' + rules.join(', '));
    console.log('  元规则 M: ' + metas.join(', '));
    for (const c of parseCountClaims(lines)) {
      const t = firstTableAfter(lines, c.line);
      console.log('  §' + c.section + ' 声明 ' + c.claimed + ' 条 / 表 ' + (t ? t.rows : '无表') + ' 行');
    }
    const lr0 = scanLedger(lines);
    console.log('  封闭欠账册: ' + lr0.rows.map((r) => r.id).join(', ')
      + '（' + lr0.rows.length + ' 条；有 `node …` 复核命令 '
      + lr0.rows.filter((r) => r.cmds.length).length + ' 条）');
    const ns0 = scanNextStep(readDoc(NEXT_STEP_REL));
    console.log('  「' + NEXT_STEP_COLUMN + '」列（' + NEXT_STEP_REL + '）: '
      + ns0.rows.length + ' 行数据 · 列位置 #' + (ns0.columnIndex + 1)
      + (ns0.skip ? ' · 跳过（' + ns0.skip.why + '）' : ''));
    for (const r of ns0.rows) {
      console.log('    ' + r.line + ' 行 [' + r.verdict + '] ' + r.label
        + (r.banned.length ? '（含禁词：' + r.banned.join('、') + '）' : ''));
    }
    return;
  }

  const docTexts = collectDocTexts();
  const problems = analyze(rulesText, docTexts);
  // 采不到真值 = 红（照 skill `G4`）：`analyze()` 对"没给 ROADMAP"记跳过（单测常只喂部分文档），
  // 但**真门禁**里读不到这份文件就必须红 —— 否则删掉/改坏文件名的效果是"判定静默消失"。
  if (!docTexts[NEXT_STEP_REL]) {
    problems.push({ kind: 'next-step', rel: NEXT_STEP_REL,
      msg: '读不到 ' + NEXT_STEP_REL + ' ⇒ 判定 ⑨ 无从判起。门禁不能自称"已校验下一步列"'
        + '（采不到真值 = 红，照 skill `G4`）。收起：恢复这份文件，或把文件名改动同步到 `SCAN_DOCS`' });
  }
  // （承 ①）同上一条纪律：`COUNT_REQUIRED_SECTIONS` 里的章节在**真仓**里必须存在 ——
  //   删掉/改掉该节标题的效果，同样是"判定静默消失"。`analyze()` 对"章节不在"记放行（单测喂片段），
  //   **真门禁**在这里把它判红（采不到真值 = 红）。
  for (const sec of COUNT_REQUIRED_SECTIONS) {
    if (lines.some((l) => sec.re.test(l))) continue;
    problems.push({ kind: 'count', rel: RULES,
      msg: '找不到标题形如「## N. …' + sec.name.replace(/^§\d+\s*/, '') + '」的小节 —— 删掉或改名这一节'
        + '就能让判定 ① 对整节静默失效，故按红处理（照 skill `B8`）。'
        + '收起：把这一节的标题改回来（名字含「约定与架构决策」即可，章节号随它）' });
  }
  console.log('== 规则文件自洽门禁（G9）==');
  console.log('   ' + RULES + '：门禁 ' + gates.length + ' 个 / 铁律 ' + rules.length
    + ' 条 / 元规则 ' + metas.length + ' 条');

  if (problems.length) {
    console.log('');
    for (const p of problems) {
      const tag = p.kind === 'count' ? '条数不符'
        : p.kind === 'table' ? '表格结构'
          : p.kind === 'ref' ? '悬挂引用'
            : p.kind === 'restate' ? '转述条数'
              : p.kind === 'ledger-cmd' ? '欠账缺复核命令'
                : p.kind === 'ledger-path' ? '欠账对象已不在'
                  : p.kind === 'next-step' ? '下一步为空/空话'
                    : p.kind === 'gate-count' ? '判定条数不符' : '实现缺失';
      console.log('   [' + tag + '] ' + p.rel + ' —— ' + p.msg);
    }
    console.error('\n规则文件自洽门禁失败（' + problems.length + ' 处）');
    process.exit(1);
  }
  console.log('✓ 声明的条数与表格行数一致');
  console.log('✓ 表格结构完整（ID 行连续、表头在位）');
  console.log('✓ 编号引用闭合（文档里出现的 G/R/M 都有定义）');
  console.log('✓ 实现列点名的脚本都存在');
  console.log('✓ 门禁声明的「N 条判定」与实现脚本的标记数一致（且标记唯一）');
  const lr = scanLedger(lines);
  console.log('✓ 封闭欠账册 ' + lr.rows.length + ' 条：每条都带一条可执行的复核命令（`node …`）');
  console.log('✓ 封闭欠账册「在册对象」：仓库路径存在性检查 ' + lr.checkedRows + '/' + lr.rows.length
    + ' 条可查（共 ' + lr.checkedSites + ' 处）· 在册非仓库路径豁免 ' + lr.exempt
    + ' 处 / 上界 ' + LEDGER_NON_REPO_CAP);
  for (const u of lr.unchecked) {
    console.log('   · ' + u.id + ' 本条无路径可查'
      + (u.why === 'exempt'
        ? '（在册对象只点到非本仓库路径：' + u.tokens.join('、') + ' —— 已在门禁侧登记豁免）'
        : '（在册对象里没有能定位到仓库的路径 token）'));
  }

  // （承 ⑨）的读数（**放行理由要打印出来**，照 skill `B8`：接手者要能分清"它真的过了"与"它没能力判"）
  const ns = scanNextStep(docTexts[NEXT_STEP_REL]);
  if (ns.skip && ns.skip.why === 'no-rows') {
    console.log('⤼ 跳过：「在飞 / 未收口」表里 **0 条数据行**'
      + '（"发版时本小节必须清空或移入版本段"是 `' + NEXT_STEP_REL + '` 头部的明文规矩）—— '
      + '跳过的对象 = **整列、0 行**；跳过 ≠ 通过（本条不计入上面那些 ✓）');
  } else if (ns.rows.length) {
    const passed = ns.rows.filter((r) => r.verdict === 'pass');
    console.log('✓ 「在飞」表的「' + NEXT_STEP_COLUMN + '」列：' + passed.length + '/' + ns.rows.length
      + ' 行非空且不是空话（按表头文字定位该列 #' + (ns.columnIndex + 1) + '，**列序不写死**）');
    for (const r of ns.rows) {
      if (r.verdict !== 'pass') continue;
      const bannedNote = r.banned.length
        ? '；⚠️ 含禁词 ' + r.banned.join('、') + ' 但句中还有别的内容 ⇒ **只报告、不判红**（本判据不做语义判断）'
        : '';
      console.log('   · ' + r.line + ' 行「' + r.label + '」放行：词块 ' + r.tokens.length + ' 个，起头「'
        + r.tokens.slice(0, 3).join(' ') + '」' + bannedNote);
    }
    console.log('   ⚠️ 能力边界：只判「空」与「整格都是禁词」，**挡不住"写得像动作但是空话"**'
      + '（如"按计划推进"会放行）—— 判"动作是否真可执行"要理解语义，按 M1 刻意不做');
  }
  console.log('\n规则文件自洽门禁通过');
}

module.exports = {
  parseCountClaims, firstTableAfter, findIdRows, splitBlocks, sectionOf,
  collectReferences, collectImplScripts, analyze, RULES, SCAN_DOCS,
  COUNT_REQUIRED_SECTIONS,
  collectJudgmentMarkers, DECLARED_COUNT_RE, JUDGMENT_MARKER_RE, listJudgments,
  scanLedger, collectTickedTokens, parseCells, looksLikeRepoPath,
  LEDGER_NON_REPO_PATHS, LEDGER_NON_REPO_CAP, LEDGER_HEADING_RE,
  scanNextStep, classifyNextStepCell, splitNextStepCell,
  NEXT_STEP_BANNED, NEXT_STEP_PLACEHOLDERS, NEXT_STEP_REL, IN_FLIGHT_HEADING_RE
};

if (require.main === module) main();
