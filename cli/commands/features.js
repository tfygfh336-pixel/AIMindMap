/* ============================================================
 * cli/commands/features.js — `features` 只读命令（I-1；`W18` §四）
 * ------------------------------------------------------------
 * ## 一句话
 * 「这个功能叫什么、现在什么状态、靠哪条命令承载」—— 把 `docs/FEATURES.md` §3 的**名册**变成
 * 一条可检索的命令，三套名字（代号 `SC` / 中文名 `来源链` / 命令名 `source-chain`）**一处互查**。
 *
 * ## 为什么要有它（`W18` 的量化依据，不是感觉）
 * `W18` 量了「12 个真实问题各要读多少」：`Q1`「某功能处于什么状态」= **79 行 / 29 518 B**、
 * `Q7`「某功能代号是什么」= **32 行 / 19 993 B**，两个都**没有命令能答**。而按代号搜历史得到的
 * 是**反向**结论：`changelog --grep source-chain` = **0 命中**、`--grep 来源链` = **1 命中**
 * （`GAP-4`：代号 / 中文名 / 命令名三套名字无互查）。
 *
 * ## 数据从哪来（**不新增数据源**）
 * 只读 `docs/FEATURES.md` 的 §3 名册表 + `cli/registry.js` 的命令清单，**每次现算** —— 本文件
 * 不落任何生成物、不写盘（不在 `WRITE_COMMANDS` / `DRY_RUN_COMMANDS` 里，也不记热度 ⇒
 * `--json` 两跑逐字节相同）。判决与抽取的**唯一实现**在 `src/features-roster.js`（纯函数，可单测）；
 * 本文件只做"读文件 → 调它 → 排输出"。
 *
 * ## 两个差集（本命令最有价值的输出，**不省**）
 *   差集①：名册按"命令调用形态"提到、`registry` 里**没有** ⇒ 要么文档写错，要么命令没登记。
 *   差集②：`registry` 里有、名册**任何一行都没提** ⇒ `GAP-4` 的另一半："从命令名回不到功能名"。
 *   ⚠️ 两个差集的判据不同、且**必须不同**：差集①的候选不能拿 registry 当锚（否则恒为空），
 *      差集②必须拿 registry 当锚（否则会漏）。逐条理由见 `src/features-roster.js` 文件头。
 *
 * ## 0 命中怎么办
 *   **响亮说出来**（哪三处、扫描面是哪十几行、下一步去哪），**不静默返回空**。
 *   退出码仍为 0 —— 与本工程 `--grep` 家族的既有口径一致（`changelog --grep` / `dsh-caps --grep`
 *   在 0 命中时都是 exit 0 + 响亮报文）；"答不了"的是 `--code`（精确取一行），它 exit 1。
 *   `--json` 下 `hits` 是空数组、`searchedIn` 列着三处 ⇒ 机器判据不靠退出码也能读到。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const roster = require('../../src/features-roster.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_REL = 'docs/FEATURES.md';
const DOC_FILE = path.join(ROOT, 'docs', 'FEATURES.md');

/* ---------------- 文本档的等宽排版（中文占 2 列） ----------------
 * 为什么要自己算宽度：`String.padEnd` 按**码点数**补齐，而「持续跟踪」4 个中文占 8 列 ⇒
 * 用 padEnd 排出来的表在中文名那一列**必然错位**（人读第一眼就废）。这里只做一件事：按显示宽度补齐。
 * 范围取东亚宽字符的常见区段（CJK / 全角标点 / 韩文 / 兼容表意字）—— 够本册用，不追求全 Unicode。 */
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/;
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}
function padEndW(s, width) {
  const text = String(s);
  const w = displayWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

/** 读真源。**读不到就答不了** —— 不许渲染一份空名册（那会让"没功能"与"读不到"长得一样）。 */
function readDoc(ctx) {
  try {
    return fs.readFileSync(DOC_FILE, 'utf8');
  } catch (e) {
    ctx.error('读不出 ' + DOC_REL + '（' + (e.code || '?') + '）：这份册子是"功能名字的唯一权威"，'
      + '读不到就答不了 —— 不返回空名册（空名册会被读成"一个功能都没有"）');
    return '';
  }
}

/** §3 的短标签（文本档用）：`3. 名册（唯一权威表）` → `§3「名册（唯一权威表）」`。
 *  为什么不直接拼 `§` + 原文：那样印出来是「§3. 名册…」，编号与真正的 §3 记号叠在一起读着别扭。 */
function sectionLabel(model) {
  const raw = String(model.sectionTitle || '');
  const m = raw.match(/^(\d+)\s*[.、]\s*(.*)$/);
  return m ? ('§' + m[1] + '「' + m[2] + '」') : ('§' + raw);
}

/** 三处检索面的**举例**（从数据里现取，不写死 —— 写死的例子会随改名漂移） */
function surfaceExamples(model) {
  const ex = {};
  const first = model.rows[0] || {};
  ex.code = first.code || '—';
  ex.name = first.name || '—';
  const withCmd = model.rows.filter((r) => r.commands && r.commands.length)[0];
  ex.commands = withCmd ? withCmd.commands[0] : '—';
  return ex;
}

/** 0 命中时那句响亮的话（文本档与 `--json` 共用**同一份**三处清单） */
function zeroHitLines(model, word) {
  const ex = surfaceExamples(model);
  const CIRCLE = ['①', '②', '③', '④', '⑤'];
  return [
    'features --grep「' + word + '」— 命中 0 / ' + model.rows.length + ' 行。',
    '三处都搜过了（联合、子串、大小写不敏感）：'
      + roster.SEARCH_SURFACES.map((s, i) => (CIRCLE[i] || (i + 1) + '.') + ' ' + s.label
        + '（如 ' + ex[s.key] + '）').join('　') + '。',
    '扫描面 = ' + DOC_REL + ' ' + sectionLabel(model) + ' 的 ' + model.rows.length
      + ' 行 —— 不含 §0/§1/§4/§5 的散文与说明表（那几处提到一个词不等于"这个功能叫这个名字"）。',
    '下一步：查命令用法 → docs/CLI.md（生成物）；查"做没做" → docs/ROADMAP.md「在飞」；'
      + '查历史 → changelog --grep <词>；只按别名/近似写法找 → features --code <2 位代号>。'
  ];
}

/** 每行的 JSON 形态（**键序固定**：故意写成一个字面量而不是拼装，键序一眼可读） */
function hitJson(row, word) {
  return {
    code: row.code,
    name: row.name,
    status: row.status,
    statusDetail: row.statusDetail,
    ledger: row.ledger,
    commands: row.commands.slice(),
    summary: row.summary,
    line: row.line,
    matchedIn: word === null ? null : roster.matchSurfaces(row, word)
  };
}

module.exports = {
  features(ctx) {
    const a = ctx.args;
    // 裸开关（`--grep` 后面没给词）**响亮拒绝** —— 静默当成"没有关键词"会退化成"全都列出来"
    if (a.grep === true) {
      ctx.error('--grep 需要一个关键词：features --grep <词>（在代号 / 中文名 / CLI 命令名 三处联合搜）');
    }
    if (a.code === true) {
      ctx.error('--code 需要一个代号：features --code DM（2 位大写字母；`features` 不带参数会列出在册的全部代号）');
    }
    const grep = (a.grep === undefined) ? null : String(a.grep);
    const code = (a.code === undefined) ? null : String(a.code);
    if (grep !== null && code !== null) {
      ctx.error('--grep 与 --code 互斥：一个是三处联合检索、一个是按代号精确取一行 —— 分开跑两次'
        + '（两个条件一起给没有确定的语义，不猜）。');
    }
    if (grep !== null && String(grep).trim() === '') {
      ctx.error('--grep 的关键词是空的：给一个非空的词（代号 / 中文名 / 命令名的一部分都行）。');
    }
    if (code !== null && String(code).trim() === '') {
      ctx.error('--code 的代号是空的：给一个 2 位代号（如 DM）—— 不带参数跑 `features` 可列出全部代号。');
    }

    // registry 在**函数内**取：`cli/registry.js` 顶层就 `require` 各命令文件（`loadFile`），
    // 命令文件在顶层再 require 回去会拿到一个尚未填好的 exports（与 `release.js` 的 docsGen 同一处理）
    const registry = require('../registry.js');
    const list = registry.list();
    const names = list.map((c) => c.name);
    const aliases = {};
    list.forEach((c) => (c.aliases || []).forEach((x) => { aliases[x] = c.name; }));

    const model = roster.buildModel({ md: readDoc(ctx), names, aliases });
    if (!model.ok) {
      ctx.error('`' + DOC_REL + '` §3 的名册表形状与判据不符，答不了（不静默给一份半对的名册）：\n  · '
        + model.problems.join('\n  · '));
    }

    // 选行：`--code` 精确取一行（取不到 ⇒ exit 1，这是"答不了"）；`--grep` 三处联合；无参 = 全部
    let hits = model.rows;
    if (code !== null) {
      const row = roster.findByCode(model.rows, code);
      if (!row) {
        ctx.error('没有代号 ' + code + '（大小写都试过了）。在册的 ' + model.rows.length + ' 个代号：'
          + model.rows.map((r) => r.code).join(' / ')
          + '\n（按名字或命令名找代号用 `features --grep <词>`；这条命令是精确取行，取不到就非 0 退出 —— '
          + '与 `--grep` 的 0 命中 exit 0 是**两种**语义。）');
      }
      hits = [row];
    } else if (grep !== null) {
      hits = roster.searchRows(model.rows, grep);
    }

    /* ---------------- JSON 档：键序固定、无时间戳、无随机 ---------------- */
    if (a.json) {
      ctx.outJson({
        command: 'features',
        source: DOC_REL,
        section: model.sectionTitle,
        scan: {
          rows: model.rows.length,
          sectionLine: model.sectionLine,
          headerLine: model.headerLine,
          columns: model.columns
        },
        searchedIn: roster.SEARCH_SURFACES.map((s) => ({ key: s.key, label: s.label })),
        query: { grep, code },
        hitCount: hits.length,
        hits: hits.map((r) => hitJson(r, grep)),
        // 读数只放**计数**，清单只在 `diff` 里出现一次（同一份清单两处表达 = 迟早漂移）
        commands: {
          registryTotal: model.registryTotal,
          mentionedByRoster: model.mentionedCount
        },
        diff: {
          docNotInRegistry: model.docOnly.map((d) => ({ name: d.name, codes: d.codes.slice() })),
          registryNotInRoster: model.unmentioned.slice()
        }
      });
      return;
    }

    /* ---------------- 文本档 ---------------- */
    // `--code`：一行一份完整答卷（Q1「现在什么状态」/ Q7「代号指什么」都在这七行里）
    if (code !== null) {
      // 防御：取不到行时上面已经抛错（走不到这里）；万一走到，也**不许**静默返回空输出
      if (!hits.length) ctx.error('内部不一致：`--code ' + code + '` 没有取到行（本不该发生，请当作缺陷报出来）');
      const r = hits[0];
      ctx.out('代号: ' + r.code);
      ctx.out('中文名: ' + r.name);
      ctx.out('实现状态: ' + r.status);
      if (r.statusDetail) ctx.out('状态旁注: ' + r.statusDetail);
      ctx.out('承载命令: ' + (r.commands.length ? r.commands.join(', ') : '（这一行没点任何 registry 命令）'));
      ctx.out('台账: ' + (r.ledger || '—'));
      ctx.out('一句话: ' + r.summary);
      ctx.out('出处: ' + DOC_REL + ':' + r.line + '（整行 ' + r.carrier.length + ' 字符的「承载」列，要原文按这个行号读）');
      return;
    }

    // 无参 / `--grep`：同一张表（`--grep` 多一列「命中处」，那正是三向互查的可见读数）
    const grepMode = grep !== null;
    if (grepMode && !hits.length) {
      zeroHitLines(model, grep).forEach((line) => ctx.out(line));
      return;
    }
    if (grepMode) {
      ctx.out('features --grep「' + grep + '」— 命中 ' + hits.length + ' / ' + model.rows.length
        + ' 行；三处联合搜：' + roster.SEARCH_SURFACES.map((s) => s.label).join(' / '));
    } else {
      ctx.out('产品功能名册 — ' + DOC_REL + ' ' + sectionLabel(model) + '（' + model.rows.length
        + ' 行；代号 ↔ 中文名 ↔ 承载命令）');
    }
    const head = ['代号', '中文名', '实现状态'];
    if (grepMode) head.push('命中处');
    head.push('台账', '承载命令（本行提到的 registry 命令）');
    const body = hits.map((r) => {
      const cells = [r.code, r.name, r.status];
      if (grepMode) {
        cells.push(roster.matchSurfaces(r, grep)
          .map((k) => roster.SEARCH_SURFACES.filter((s) => s.key === k)[0].label).join('/'));
      }
      cells.push(r.ledger || '—');
      cells.push(r.commands.length ? r.commands.join(', ') : '—');
      return cells;
    });
    const widths = head.map((h, i) => Math.max(displayWidth(h), ...body.map((row) => displayWidth(row[i]))));
    const render = (cells) => '  ' + cells.map((c, i) => (i === cells.length - 1 ? String(c) : padEndW(c, widths[i] + 2))).join('');
    ctx.out(render(head));
    body.forEach((cells) => ctx.out(render(cells)));
    if (grepMode) {
      ctx.out('');
      ctx.out('（命中处 = 在**哪一处**命中：代号 / 中文名 / 该行提到的 CLI 命令名 —— 三处联合搜，'
        + '所以「' + roster.SEARCH_SURFACES.map((s) => s.label).join('」「') + '」都能找到同一行。）');
      return;
    }

    // 两个差集：本命令最有价值的输出，**逐条/全量**给出，不截断
    ctx.out('');
    ctx.out('差集① 名册按"命令调用形态"提到、registry 里没有：' + model.docOnly.length + ' 条'
      + (model.docOnly.length
        ? ' —— ' + model.docOnly.map((d) => '`' + d.name + '`（' + d.codes.join('、') + ' 行）').join('；')
        : ' ✓ 两边对得上（名册里每一处「命令 + 选项/占位」写法都在 `cli/registry.js` 里登记过）'));
    ctx.out('差集② registry 有、名册任何一行都没提：' + model.unmentioned.length + ' / ' + model.registryTotal
      + ' 条 —— ' + (model.unmentioned.length ? model.unmentioned.join(' ') : '（无）'));
    ctx.out('（差集② = "一条命令回不到任何功能代号"，`GAP-4` 的另一半。判据与能力边界见 '
      + '`src/features-roster.js` 文件头；要机器可读加 --json。）');
  }
};
