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
 * 本条门禁的判定：**清单见 `analyze()` 里的 ①…⑥ 标记**（此处刻意不写死条数、也不重复枚举 ——
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
 *
 * 边界（诚实标注）：G9 只查**自洽**（前后是否一致），查不了**内容对不对** ——
 * 一条铁律是否真的"不可机械化"、一条门禁是否真的防住了它声称的损害，仍靠人判定。
 * 它也不查 CHANGELOG（历史记录里出现已退役的编号是正常的，不是缺陷）。
 *
 * ⚠️ **判定⑤认不出「引号里的历史引用」与「真实声明」的区别**。实测：本门禁上线时，
 * `ARCHITECTURE.md` 的 ADR 里为了记录缺陷写了"README 仍写『铁律…共 5 条』"，
 * 结果被它自己判红。这是**判定对、措辞错** —— 引用历史缺陷时请改用不会匹配的措辞
 * （如"把条数写成 5"），不要去弱化判定（放宽正则会让它再也抓不住真声明）。
 *
 * 用法：
 *   node scripts/rules-consistency.js          # 门禁（exit 0/1）
 *   node scripts/rules-consistency.js --list   # 打印解析结果（编号集合、条数、打断点）
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

/** 纯函数形式的判定（清单见 `analyze()` 的 ①…⑥ 标记）；返回 problems[]（不打印、不退出），便于单测。 */
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
  if (listMode) {
    console.log('规则文件自洽门禁（G9）—— 解析结果');
    console.log('  门禁 G : ' + gates.join(', '));
    console.log('  铁律 R : ' + rules.join(', '));
    console.log('  元规则 M: ' + metas.join(', '));
    for (const c of parseCountClaims(lines)) {
      const t = firstTableAfter(lines, c.line);
      console.log('  §' + c.section + ' 声明 ' + c.claimed + ' 条 / 表 ' + (t ? t.rows : '无表') + ' 行');
    }
    return;
  }

  const problems = analyze(rulesText, collectDocTexts());
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
  console.log('\n规则文件自洽门禁通过');
}

module.exports = {
  parseCountClaims, firstTableAfter, findIdRows, splitBlocks, sectionOf,
  collectReferences, collectImplScripts, analyze, RULES, SCAN_DOCS,
  collectJudgmentMarkers, DECLARED_COUNT_RE, JUDGMENT_MARKER_RE
};

if (require.main === module) main();
