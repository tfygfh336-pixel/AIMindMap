/* ============================================================
 * src/changelog.js — CHANGELOG 的发版变换（纯逻辑，Node 侧）
 * ------------------------------------------------------------
 * 从 cli/commands/release.js 抽出。抽出的理由是一个**真实缺陷**：
 * 原实现用两次 `String.replace` 做「[Unreleased] → [vX.Y.Z]」，结果把
 * `[Unreleased]` 段里那句占位说明
 *   （新变更先记在这里，发版时移入下方版本段）
 * **一起带进了新版本段**，于是版本段开头多出一句毫无意义的占位文字
 * （v0.15.0 实际中招）。两次 replace 的写法无法区分"标题后的占位行"与"真正的变更内容"。
 *
 * 现改为按**段落边界**处理：定位 `## [Unreleased]` 标题，取其到下一个 `## [` 之间的正文，
 * 剥掉段首占位行，再用它构造版本段。纯函数，可单测（tests/changelog.test.js）。
 * ============================================================ */
'use strict';

/** 空 [Unreleased] 段的占位说明（唯一真源，release 与校验都用它） */
const PLACEHOLDER = '（新变更先记在这里，发版时移入下方版本段）';

const HEAD_RE = /^## \[Unreleased\][^\n]*$/m;
const NEXT_SECTION_RE = /^## \[/m;

/**
 * 把 `[Unreleased]` 段变为 `[v<next>]` 段，并在顶部重建一个空的 `[Unreleased]` 段。
 * @param text        CHANGELOG 全文
 * @param nextVersion 形如 '0.15.0'
 * @param dateStr     形如 '2026-09-16'
 * @returns 变换后的全文（不写盘）
 * @throws Error 当缺少 [Unreleased] 段、或该段没有任何变更内容时
 */
function releaseChangelog(text, nextVersion, dateStr) {
  const src = String(text === undefined || text === null ? '' : text);
  const m = HEAD_RE.exec(src);
  if (!m) throw new Error('CHANGELOG.md 缺少 [Unreleased] 段');

  const headStart = m.index;
  // 标题行之后的位置。**不能用 `indexOf('\n', headStart)`**：若 [Unreleased] 是文件
  // 最后一行且**无换行结尾**，indexOf 返回 -1、+1 得 0 → headEnd=0 → "正文"变成从
  // 文件开头算起 → 前言被整段复制进版本段，且不抛错（静默产出损坏文档）。
  const afterHeading = headStart + m[0].length;
  const nl = src.indexOf('\n', afterHeading);
  const headEnd = nl < 0 ? src.length : nl + 1;
  const rest = src.slice(headEnd);
  const nextRel = rest.search(NEXT_SECTION_RE);
  const bodyEnd = nextRel < 0 ? src.length : headEnd + nextRel;

  let body = src.slice(headEnd, bodyEnd);
  // 剥掉段首的占位行 —— 这正是原先被带进版本段的那句
  body = body.replace(new RegExp('^\\s*' + PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*\\n'), '');
  body = body.replace(/^\s+/, '').replace(/\s+$/, '');

  // 没有实际内容就拒绝发版：空版本段是几乎必然的失误（宁可不做，也不留下空记录）
  if (body === '') {
    throw new Error('[Unreleased] 段没有任何变更内容，拒绝发版（请先记录本次变更）');
  }

  const before = src.slice(0, headStart);
  const after = src.slice(bodyEnd).replace(/^\s+/, '');
  const out = before
    + '## [Unreleased]\n\n' + PLACEHOLDER + '\n\n'
    + '## [v' + nextVersion + '] - ' + dateStr + '\n\n'
    + body + '\n'
    + (after ? '\n' + after : '');

  // 后置不变量：占位行必须恰好出现一次（防回归）。
  // 实测踩过一次：**历史版本段里残留了占位行**（v0.15.0 那次"占位行被带进版本段"缺陷的残留物），
  // 于是重建 [Unreleased] 之后总数变成 2 —— 报错必须点出这个可能原因，否则要花十分钟定位。
  const phCount = out.split(PLACEHOLDER).length - 1;
  if (phCount !== 1) {
    throw new Error('发版后 CHANGELOG 的占位行出现 ' + phCount + ' 次（应为 1 次），已中止。'
      + '最可能的原因：**某个已发版本段里残留了占位行**（历史缺陷的残留物）—— '
      + '用 `node cli/mm-cli.js changelog --grep 发版时移入下方版本段 --full` 定位并删掉那一行后重试');
  }
  return out;
}

/* ---------------- 索引（只读窄查询用，`changelog` 命令的纯逻辑） ----------------
 * 存在理由：CHANGELOG 只增不减（虽有滚动归档兜住长期膨胀），而「上个迭代改了什么」是最常被问的问题，
 * 且 git 侧没有替代入口（工程内 git 零提交，没有 log/blame 可查）。
 * **本文件的注释刻意不写体量与行数**：那类数字每次迭代都在变，写死必然过期（见 RULES §4 约定）。
 *
 * **索引按需从正文现算，不落任何生成物** —— 这是刻意的选择：CHANGELOG 每次变更都要动（R2），
 * 若做成"生成文件 + 过期门禁"，就等于给**最频繁的那个动作**新增一道强制步骤，
 * 在我们正要消灭迭代成本的时候反过来加成本。现算则永不漂移，
 * 并且守住「一份事实只写一处」：正文是唯一真源，索引只是视图。 */

/** UTF-8 字节数（Node 有 Buffer；浏览器端退化为 TextEncoder）。 */
function utf8Bytes(s) {
  if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(s, 'utf8');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length;
}

const SECTION_RE = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const ENTRY_RE = /^### (.+?)\s*$/;

/**
 * 给 CHANGELOG 建索引（纯函数，不读盘不写盘）。
 *
 * 只认两种边界：`## [版本]` 段 与 `### 标题` 条目 —— 这就是本文件的既有写法。
 *
 * **刻意不解析条目标题里的日期**：实测 90 条里有 22 条格式各异
 * （`（v0.16.6，2026-09-24）`、`（2026-09-15 晚）`、甚至完全无日期），拿它当索引键必然漏。
 * 日期只从**段标题**取（15 个版本段格式统一为 `- YYYY-MM-DD`）；条目只报**行号与行数**，
 * 由读者按需打开。索引的职责是"告诉你东西在哪、有多大"，不是"复述内容"。
 *
 * @param {string} text CHANGELOG 全文
 * @returns {{totalLines:number, totalBytes:number,
 *            preamble:{lines:number, bytes:number},
 *            sections:Array<{version:string, date:string|null, heading:string,
 *                            startLine:number, lines:number, bytes:number,
 *                            entries:Array<{heading:string, startLine:number, lines:number, bytes:number}>}>}}
 *          `startLine` 为 **1 起**行号（与 `read` 工具、grep 的输出一致）
 */
function indexChangelog(text) {
  const src = String(text === undefined || text === null ? '' : text);
  const raw = src.split('\n');
  // 末尾换行不算一行 —— 否则与 `Get-Content | .Count`、编辑器行号都差 1
  const lines = raw.length && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;

  // 每行的字符起点，用于**精确**切出行范围的字节数（末行无换行时兜底为全文长）
  const offsets = new Array(lines.length + 1);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) { offsets[i] = pos; pos += lines[i].length + 1; }
  offsets[lines.length] = src.length;
  const bytesOf = (a, b) => utf8Bytes(src.slice(offsets[a], offsets[b]));

  // 第一遍：收集边界
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const sm = SECTION_RE.exec(lines[i]);
    if (sm) {
      marks.push({ kind: 'section', line: i, version: sm[1], date: sm[2] || null, heading: lines[i] });
      continue;
    }
    const em = ENTRY_RE.exec(lines[i]);
    if (em) marks.push({ kind: 'entry', line: i, heading: em[1] });
  }

  // 第二遍：每块的范围 = 自身行到下一个边界（无则到文件末）。
  // 段的 lines/bytes **包含**其下全部条目 —— 因为那才是"这一版有多大"。
  const sections = [];
  let cur = null;
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    if (m.kind === 'section') {
      // 段的终点是**下一个段**（含其下全部条目）—— 那才是「这一版有多大」。
      // 若按"到下一个边界"算，段就只剩标题行 + 占位行（实测会得到 "2 行 / 17 B"）。
      let end = lines.length;
      for (let j = k + 1; j < marks.length; j++) {
        if (marks[j].kind === 'section') { end = marks[j].line; break; }
      }
      cur = {
        version: m.version, date: m.date, heading: m.heading,
        startLine: m.line + 1, lines: end - m.line, bytes: bytesOf(m.line, end),
        entries: []
      };
      sections.push(cur);
    } else if (cur) {
      // 条目的终点是下一个**任意**边界（下一个条目或下一个段），无则到文件末
      const end = (k + 1 < marks.length) ? marks[k + 1].line : lines.length;
      cur.entries.push({
        heading: m.heading,
        startLine: m.line + 1, lines: end - m.line, bytes: bytesOf(m.line, end)
      });
    }
    // （段标题之前出现的 ### 属前言区，不进索引）
  }

  const preambleEnd = marks.length ? marks[0].line : lines.length;
  return {
    totalLines: lines.length,
    totalBytes: utf8Bytes(src),
    preamble: { lines: preambleEnd, bytes: bytesOf(0, preambleEnd) },
    sections
  };
}

/* ---------------- 滚动归档（发版时把过老的版本段移出主文件） ----------------
 * 存在理由：CHANGELOG 只增不减 ⇒ 主文件必然越长越大，而它每次变更都要被 AI 读到（R2）。
 * （体量不在此写死：它会变；要当前值跑 `node cli/mm-cli.js changelog` 或 `node scripts/doc-facts.js`。）
 *
 * 策略：**只滚动"已发版本段"**，[Unreleased] 永不归档（它是当前工作区）。
 * 保留窗口 KEEP_RELEASED_SECTIONS 个最新版本段留在主文件里（够回答"最近几版改了什么"），
 * 更老的段整段移入 `docs/changelog/<版本>.md`：与 `docs/archive/` 同族 ——
 * **只增不改、不参与"当前事实"扫描（G6）、无需逐份登记（G8 前缀放行）**。
 * 触发点只有一处：`release` 命令内部（发版顺手滚），不新增需要人记住的步骤。
 * ============================================================ */

/** 主文件里保留的已发版本段数量（滚动窗口）。 */
const KEEP_RELEASED_SECTIONS = 3;

const RELEASED_HEAD_RE = /^## \[(v[^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

/** 解析全部**已发版本段**（`## [vX.Y.Z] - 日期`，不含 `[Unreleased]`），按文件顺序（新→旧）。 */
function parseReleasedSections(text) {
  const src = String(text === undefined || text === null ? '' : text);
  const lines = src.split('\n');
  const marks = [];
  lines.forEach((ln, i) => {
    const m = RELEASED_HEAD_RE.exec(ln);
    if (m) marks.push({ line: i, version: m[1], date: m[2] || null, heading: ln });
  });
  return marks.map((mk, k) => {
    const end = (k + 1 < marks.length) ? marks[k + 1].line : lines.length;
    return {
      line: mk.line,
      version: mk.version,
      date: mk.date,
      heading: mk.heading,
      body: lines.slice(mk.line + 1, end).join('\n').replace(/\s+$/, '')
    };
  });
}

/**
 * 把 CHANGELOG 拆成「主文件」与「应归档的版本段」。
 * @param text      CHANGELOG 全文
 * @param keepCount 主文件保留的已发版本段数量（默认 KEEP_RELEASED_SECTIONS）；0 = 全滚
 * @returns {{main:string, archived:Array<{version,date,heading,body}>}}
 */
function splitChangelog(text, keepCount) {
  const src = String(text === undefined || text === null ? '' : text);
  const keep = Number.isInteger(keepCount) ? Math.max(0, keepCount) : KEEP_RELEASED_SECTIONS;
  const sections = parseReleasedSections(src);
  const archived = sections.slice(keep);
  if (!archived.length) return { main: src, archived: [] };

  const lines = src.split('\n');
  const cut = archived[0].line;                     // 第一个要归档的段标题所在行
  const main = lines.slice(0, cut).join('\n').replace(/\s+$/, '') + '\n';

  // 后置不变量：主文件必须仍然含且仅含一个 [Unreleased] 段（滚错会把当前工作区滚走）
  const phCount = (main.match(/^## \[Unreleased\]/gm) || []).length;
  if (phCount !== 1) {
    throw new Error('滚动归档后主文件的 [Unreleased] 段出现 ' + phCount + ' 次（应为 1 次），已中止');
  }
  return { main: main, archived: archived };
}

/** 渲染一个归档文件的完整内容（纯函数）。 */
function renderArchiveFile(entry, keepCount) {
  const keep = Number.isInteger(keepCount) ? keepCount : KEEP_RELEASED_SECTIONS;
  return [
    '# CHANGELOG 归档 · ' + entry.version + (entry.date ? '（' + entry.date + '）' : ''),
    '',
    '> 本文件由 `node cli/mm-cli.js release` 从 `CHANGELOG.md` **滚动归档**而来',
    '> （保留窗口 = 主文件留下最近 ' + keep + ' 个已发版本段）。**只增不改**。',
    '> 当前变更与最新版本见 `CHANGELOG.md`；**历史记录不要当作现状引用**。',
    '> 检索历史用 `node cli/mm-cli.js changelog --grep <关键词>`（会同时给出归档目录）。',
    '',
    entry.heading,
    '',
    entry.body,
    ''
  ].join('\n');
}

/* ---------------- 归档检索（让"查历史"的承诺真正兑现） ----------------
 * 存在理由：滚动归档把老版本段移出主文件后，`changelog --grep` **只搜主文件** ——
 * 实测踩到：关键词「history.js 下沉」只存在于 `docs/changelog/v0.12.0.md`，
 * 命令报「命中 0 条目」，用起来就像"历史丢了"（机制看起来坏了）。
 * 所以检索必须**同时**覆盖归档目录：逻辑放这里（可单测），CLI 只负责接线与打印。
 * ============================================================ */

/**
 * 在归档目录里按关键词检索（只读，纯函数式：传入目录，返回结构化命中）。
 * @param dir      归档目录（通常是 `docs/changelog`）
 * @param keyword  关键词（大小写不敏感）；空/未给则返回 `{ files: [], totalHits: 0 }`
 * @param perFile  每个文件最多报几条命中（默认 20，防输出爆炸）
 * @returns {{files:Array<{file,version,date,path,hits:Array<{line,text,heading}>}>, totalHits:number}}
 */
function searchArchives(dir, keyword, perFile) {
  // 惰性引入 fs/path：本模块其余部分是**纯逻辑**（无 IO），
  // 顶层 require 会让它在没有 require 的环境（浏览器）里加载失败 —— 只有这个函数需要读盘。
  const fs = require('fs');
  const pathMod = require('path');
  const out = { files: [], totalHits: 0 };
  const kw = (keyword === undefined || keyword === null) ? '' : String(keyword).trim();
  if (!kw || !fs.existsSync(dir)) return out;
  const cap = Number.isInteger(perFile) && perFile > 0 ? perFile : 20;
  const kwLc = kw.toLowerCase();

  fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort().forEach((f) => {
    const p = pathMod.join(dir, f);
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
    const lines = text.split(/\r?\n/);
    const version = f.replace(/\.md$/i, '');
    const head = lines.find((l) => /^## \[/.test(l)) || '';
    const date = (head.match(/-\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const hits = [];
    let curHeading = head;
    for (let i = 0; i < lines.length; i++) {
      if (/^### /.test(lines[i])) curHeading = lines[i].replace(/^###\s*/, '');
      if (lines[i].toLowerCase().includes(kwLc)) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200), heading: curHeading });
        if (hits.length >= cap) break;
      }
    }
    if (hits.length) {
      out.files.push({ file: f, version: version, date: date, path: p, hits: hits });
      out.totalHits += hits.length;
    }
  });
  return out;
}

module.exports = {
  releaseChangelog,
  indexChangelog,
  parseReleasedSections,
  splitChangelog,
  renderArchiveFile,
  searchArchives,
  PLACEHOLDER,
  KEEP_RELEASED_SECTIONS
};
