#!/usr/bin/env node
/* ============================================================
 * scripts/smoke-state-check.js — 冒烟"域内自收尾"门禁（门禁编号 V2）
 * ------------------------------------------------------------
 * 真实事故（本门禁存在的唯一理由，2026-10-10）：
 *   用户要求"让你重新测试是为了修 bug，不是降低产品要求"，于是按域过滤重跑冒烟
 *   （`SMOKE_ONLY='16,36,37'`）⇒ **12/23**，报文 `点不到 comp-net …→DIV.dialog-box`
 *   与 `命中测试命中圆钮=false（命中=overlay）`。
 *   查下来：域 16 的 `app.addNode('overview')` **顺手打开了**「编辑节点」模态（产品行为，没错），
 *   而 `undo()` 只撤节点、**撤不掉那个框**；"每域隔离"只还原**项目数据文件 + 重开项目**，
 *   DOM 模态不在其中 ⇒ 那个框**跨域存活**、盖住画布 ⇒ 域 36/37 整片假红，
 *   而那两个文件**一行都没改过** ✗。全量跑当时还绿，只是因为后面的域**各自顺手**擦了桌子。
 *
 * 门禁要保的那条纪律（一句话）：
 *   **冒烟断言里凡是"打开会留下浮层/模态"的动作，同一段断言体里必须给出关闭动作**
 *   （或写一条显式豁免 `收尾-豁免: <原因>`，留给"它确实会在别处被关掉且已有运行时判据兜底"的情形）。
 *   关闭动作一律用**共用入口**：`require('../smoke-assertions.js').closeDialogs(ctx)`
 *   （渲染层侧的唯一实现在 `renderer/app-actions.js` 的 `closeAllDialogs`）。
 *
 * 为什么不能只靠运行时判据（`main.js` 的"域开始的干净前置"）：那一层**只在下一个域真的跑**时才触发 ——
 *   单独跑一个漏收尾的域（`SMOKE_ONLY=16`）时它什么都不会说。两层分工：
 *     · 运行时判据 = 兜底（真的漏了，谁也跑不了假绿）；
 *     · 本静态门禁 = 早红（没跑就知道哪一条没写收尾，且**判据本身可单测**）。
 *
 * 判定清单见 `findExemptions()` / `judgeSegments()` / `summarize()` 里的 ①…③ 标记
 *   （此处刻意不写死条数：写死了就会漂）。
 *
 * 放行口径三档（照 `testing-for-ai` B8 与 `docs-for-ai` A5 —— **跳过必须与通过可区分，
 *   放行理由必须打印在门禁输出里**；对账批 `G-20` 剩下的那半补的就是这一档）：
 *   ① 判红 —— 没写豁免又确实违规 ⇒ `exit 1`，点名"哪个域、哪一段、第几行、打开了什么"；
 *   ② 只报告 —— 本文**没有**这一档（不做"打印理由却不判红"）；
 *   ③ 跳过 —— 写了 `收尾-豁免: <原因>` ⇒ 不再判这个域，但**必须让人看得见**：每一行打印
 *      `[豁免] <文件>:<行>　<原因>`、并给一行计数；因为豁免是**整份文件级**的（见下面"边界"），
 *      命中时还要额外告警"本域其余判据一并失效 + 这一行放过了几条问题"。
 *      条数上界 = `EXEMPT_CAP`（**只减不增**）；上限值与现读数由本文件自己打印，
 *      `docs/RULES.md` **不抄这个数**（抄一份就会漂，那边只写"去哪取"）。
 *
 * 边界（诚实标注，别以为它能包住一切）：
 *   · 它查的是**有没有收尾动作**，查不了"收尾动作到底关没关掉那个东西"
 *     （`closeDialogs` 也可能因为选择器写错而关不掉）—— 那一层靠运行时判据与真机复核；
 *   · 它按**调用点所在的那一段**看（每个 `{ name, run }` 入口为一段）。跨段共享的关闭动作
 *     会被判红 —— 那是有意的：合并成一段、或写明豁免，都比"靠后面的段顺手关"安全 ✗；
 *   · **豁免是整份文件级的**：`analyzeSource()` 一旦在该文件里读到一行 `收尾-豁免:`，
 *     就对**这份文件**整体返回空 ⇒ 该域其余判据一起失效。这是**能力边界**（收窄成"只豁免那一段"
 *     是产品行为变更，得单独证明"不会把原本该红的放过"），所以本门禁**不藏它**：
 *     命中即在输出里逐条打印原因、告警"本域其余判据一并失效"、报出"这一行放过了几条问题"，
 *     并用 `EXEMPT_CAP` 把总条数限死 ✗；
 *   · 它**不做重活**：纯文本扫描，不起 Electron、不起服务（判据都是字符串匹配）。
 *
 * 用法：
 *   node scripts/smoke-state-check.js          判红/判绿（挂 `npm run verify` 的 V2 步）
 *   node scripts/smoke-state-check.js --list   逐域打印判定（问题 / 豁免的段、行与原因）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SMOKE_REL = 'scripts/smoke';
const SMOKE_ABS = path.join(ROOT, SMOKE_REL);

/* ---------------------------------------------------------------
 * ① 打开动作：调了这些 API 就会**在画布上留下东西**（模态/浮层/面板），而
 *    "每域隔离"收不掉它们（它只还原项目数据文件 + 重开项目）。
 *    词表短而准：只列**已实测**会留下浮层的那些；`showDetail`（浮动详情框）不在列 ——
 *    它是另一类状态，且各域普遍用 `closeAllFloatDetail` 自理，纳进来只会制造噪音 ✗。
 * --------------------------------------------------------------- */
const OPENERS = [
  { token: 'addNode(', leaves: '「编辑节点」模态（app-actions.js 的 addNode 末尾调 MMEditor.editNode）' },
  { token: 'addSiblingNode(', leaves: '「编辑节点」模态（同上）' },
  { token: 'addTopic(', leaves: '「编辑节点」模态（同上）' },
  { token: 'MMEditor.editNode', leaves: '「编辑节点」模态' },
  { token: 'openFilePreview', leaves: '文件预览浮层（#file-preview）' },
  { token: 'openLightbox', leaves: '图片灯箱（#lightbox）' },
  { token: 'openAudit', leaves: '关系审计面板（#audit-panel）' },
  { token: 'openPalette', leaves: '命令面板（#palette）' },
  { token: 'openAssocEditor', leaves: '关联笔记编辑框（#assoc-dialog）' },
  { token: 'openImageDialog', leaves: '图片对话框（#image-dialog）' },
  { token: 'openFileDialog', leaves: '附件对话框（#file-dialog）' }
];

/* ---------------------------------------------------------------
 * ② 收尾动作：这些出现即算"给了收尾"。
 *    第一项是**共用入口**（推荐）；其余是产品自己已有的关闭口 —— 它们都在
 *    `window.MMApp.closeAllDialogs` 内部被调用（见 renderer/app-actions.js），
 *    所以写哪一个都是"走产品自己的路"，只是共用入口最不容易漏 ✗。
 * --------------------------------------------------------------- */
const CLOSERS = [
  { token: 'closeDialogs', kind: '共用入口 closeDialogs(ctx)' },
  { token: 'closeAllDialogs', kind: 'MMApp.closeAllDialogs' },
  { token: 'closeFilePreview', kind: 'MM.closeFilePreview' },
  { token: 'fp-close', kind: '点预览的 ✕（#fp-close）' },
  { token: 'closeLightbox', kind: 'MM.closeLightbox' },
  { token: 'closeAudit', kind: 'MMApp.closeAudit' },
  { token: 'closePalette', kind: 'MMApp.closePalette' },
  { token: 'closeAssocEditor', kind: 'MM.closeAssocEditor' },
  { token: 'closeEditDialog', kind: 'editor.js closeEditDialog（用户点取消那条路）' },
  { token: 'edit-cancel', kind: '点 #edit-cancel（走产品自己的取消路径）' }
];

/** 显式豁免标记（与 V1 的 `判据-豁免:` 同一形状）：写了它就不再判这一段的收尾。
 *  只留给"确实会在别处被关掉、且**已经有运行时判据兜底**"的情形 —— 豁免必须写原因。
 *  ⚠️ 这是**唯一实现**：`.test()` 判"有没有"、`.exec()` 取原因文案，两处不各写一条正则
 *  （旧版那个 `/收尾-豁免:\s*\S/` 与这里的 `.test()` 语义相同：冒号后必须有一个非空白字符）。 */
const EXEMPT = /收尾-豁免:\s*(\S[^\n]*)/;

/* ---------------------------------------------------------------
 * ③ 豁免条数上界（**只减不增** —— 照 V1 的封闭欠账册形态）
 *    为什么需要：豁免是**整份文件级**的（见文件头"边界"）⇒ 一行 `收尾-豁免:` 能让一整个域闭嘴，
 *    而"闭嘴"本身在旧输出里**看不出来**。打印解决了"看得见"，上界解决"不能随手加"。
 *    为什么是现在的值而不是 0：0 会让这条**跳过档**永远不可达（写一行即红 ⇒ 它退化成判红档），
 *    而 `docs/RULES.md` 的 ③ 档与 V1 的 `判据-豁免:` 都明确允许"例外存在"。
 *    改这个数 = 改门禁侧的登记（同批在 `CHANGELOG.md` 留一笔）；**冒烟文件里写一行不算登记** ✗。
 *    ⚠️ 它与现读数一起由本文件打印，`docs/RULES.md` 不抄（抄一份就会漂）。
 * --------------------------------------------------------------- */
const EXEMPT_CAP = 1;

/** 从源码里切出"段"：每个 `{ name: …, run: … }` 的断言入口。
 *  纯文本切分（不做语法分析）：从 `name:` 行开始，到下一个同层 `name:` 或文件末为止。
 *  为什么不用 AST：本工程**零必需运行时依赖**（唯一的例外是 PDF 解析用的 `pdfjs-dist`，与此处无关），
 *  而这里要的只是"这一段里有没有那个词" ✓ */
function segmentAssertions(src) {
  const lines = String(src).split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*name:\s*['"`]/.test(l)) starts.push(i); });
  if (!starts.length) return [{ name: '(整份文件)', from: 0, to: lines.length - 1 }];
  return starts.map((s, i) => ({
    name: (lines[s].match(/name:\s*(['"`])([\s\S]*?)\1/) || [])[2] || ('(第 ' + (s + 1) + ' 行起)'),
    from: s,
    to: (i + 1 < starts.length ? starts[i + 1] - 1 : lines.length - 1)
  }));
}

/**
 * **③-甲 跳过档的读数（纯函数）**：把文件里每一行显式豁免抽成 `{ line, reason }`。
 *
 * 为什么需要它（真实事故，2026-10-19 对账批 `G-20` 实测）：
 *   同一处"打开命令面板却不收尾"，加一行 `收尾-豁免:` ⇒ `exit 0`，而成功行与**未变异副本
 *   逐字相同**，理由一个字都没打印 ⇒ **跳过档与通过档在输出上不可区分**，等于这道门禁不存在 ✗。
 *   所以豁免不再只是"一个正则的副作用"，而是**可枚举、可打印、可计数**的读数。
 *
 * 口径与旧版**完全一致**：只认注释行（`// …` / ` * …`）里的标记 —— 写在代码行里的不算
 * （它是给人看的说明，不是代码）。返回空数组 ⇒ 这个文件照常受判 ✓。
 */
function findExemptions(src) {
  const out = [];
  String(src).split(/\r?\n/).forEach((l, i) => {
    if (!/^\s*(?:\*|\/\/)/.test(l)) return;
    const m = EXEMPT.exec(l);
    if (m) out.push({ line: i + 1, reason: m[1].trim() });
  });
  return out;
}

/* ---------------------------------------------------------------
 * ③-乙 判定（纯函数，便于单测）：给定"一个域文件的源码"，返回问题清单。
 *    口径（**域内接力是允许的，域末必须干净**）：
 *      · 域内断言是**有顺序**的（`{name, run}` 数组），后面的断言读前一条留下的画面是**常态**
 *        （实测：域 08 前四条读的就是第一条打开的审计面板 ⇒ 逐段要求"自己开自己关"会制造一堆
 *        无意义的改动与假红）；
 *      · 真正会**泄漏到下一个域**的只有一种：**域跑完时还有东西开着**。
 *    所以判据是：**最后一个"打开且此后再没关过"的动作，之后必须有收尾动作，或写一条豁免**。
 *    （域内的运行时判据另有一道兜底：main.js 的"域开始的干净前置"——有残留 ⇒ 下一个域判红并点名 ✓）
 *
 *    ⚠️ 分工：本函数**只管判定**，不管豁免。豁免那一跳在 `analyzeSource()` ——
 *    因为 `mutate-gates` 的负对照靠"把 `analyzeSource()` 钝化"来证明本门禁会红：
 *    判定体单独抽出来以后，钝化 `analyzeSource()` 仍然会挡住全部读数 ✓。
 */
function judgeSegments(src) {
  const text = String(src);
  const lines = text.split(/\r?\n/);
  const segs = segmentAssertions(text);
  let dirty = null;   // { seg, from, opens:Set }
  segs.forEach((seg) => {
    const body = lines.slice(seg.from, seg.to + 1).join('\n');
    const opens = OPENERS.filter((o) => body.indexOf(o.token) >= 0);
    if (opens.length) {
      if (!dirty) dirty = { seg: seg.name, from: seg.from + 1, opens: new Set() };
      opens.forEach((o) => dirty.opens.add(o.token + ' → ' + o.leaves));
    }
    if (CLOSERS.some((c) => body.indexOf(c.token) >= 0)) dirty = null;   // 这一条里有收尾 ⇒ 回到干净
  });
  if (!dirty) return [];
  return [{ seg: dirty.seg, from: dirty.from, opens: [...dirty.opens] }];
}

/**
 * 门禁的判定入口（纯函数）：整份文件级豁免 ⇒ 空清单；否则照 ③-乙 判。
 *
 * ⚠️ 豁免那一跳**必须留在这个函数里**（别下移到 `judgeSegments()`）：
 * `scripts/mutate-gates.js` 的 `V2-neg` 会把本函数钝化成 `return []` 来证明"门禁真的会红"，
 * 那条负对照锚定的就是下面这两行源码文本。抽走豁免这一跳、或改动这两行的形状，
 * 负对照就会变成"变异没改到东西"⇒ 恒报拦下 ⇒ 那半边证明失效 ✗。
 */
function analyzeSource(src) {
  const text = String(src);
  if (findExemptions(text).length) return [];   // ③-甲：整份文件级豁免（能力边界，输出里明说）
  return judgeSegments(text);
}

/** 扫全部冒烟域文件（只认 `NN-名字.js`，与 smoke-assertions 同一发现规则）
 *  每行带回三样读数：`problems`（判红用）、`exemptions`（跳过档的逐条理由）、
 *  `suppressed`（**只用于告警**：这条豁免让哪些"本来会被判的问题"不再报出 ——
 *  没有它，读者只能看到"豁免 1 条"，看不到"它到底放过了什么" ✗）。 */
function scanAll(dir) {
  const abs = dir || SMOKE_ABS;
  const out = [];
  fs.readdirSync(abs).filter((f) => /^\d+-.+\.js$/.test(f)).sort().forEach((f) => {
    let src;
    try { src = fs.readFileSync(path.join(abs, f), 'utf8'); }
    catch (e) {
      out.push({
        file: f, exemptions: [], suppressed: [],
        problems: [{ seg: '(整份文件)', from: 0, opens: ['读不出来：' + (e.code || e.message)] }]
      });
      return;
    }
    const exemptions = findExemptions(src);
    out.push({
      file: f,
      problems: analyzeSource(src),
      exemptions: exemptions,
      // 爆炸半径只在**真有豁免**时才算（无豁免时它与 problems 逐字相同，没必要算两遍）
      suppressed: exemptions.length ? judgeSegments(src) : []
    });
  });
  return out;
}

/**
 * ③-丙 汇总（纯函数）：把 `scanAll()` 的行折算成"门禁读数"，供打印与判定共用一份。
 *
 * 为什么单独拎出来：计数、上界比对、逐条清单如果各算一遍，三处迟早不一致
 * （本工程的老病：同一个数在四个地方有四个说法）。这里一次算完，`main()` 只负责打印。
 *
 * @param {Array<{file:string, problems:Array, exemptions:Array, suppressed:Array}>} rows
 * @param {number} [cap] 豁免条数上界（默认 `EXEMPT_CAP`；**只给单测改**，生产路径一律用默认值）
 */
function summarize(rows, cap) {
  const capN = typeof cap === 'number' ? cap : EXEMPT_CAP;
  const exempt = [];
  rows.forEach((r) => (r.exemptions || []).forEach((x) => {
    exempt.push({ file: r.file, line: x.line, reason: x.reason });
  }));
  const bad = rows.filter((r) => (r.problems || []).length);
  const exemptFiles = [...new Set(exempt.map((x) => x.file))];
  return {
    files: rows.length,
    bad: bad,
    problems: bad.reduce((n, r) => n + r.problems.length, 0),
    exempt: exempt,
    exemptTotal: exempt.length,
    exemptFiles: exemptFiles,
    cap: capN,
    overCap: exempt.length > capN,
    /* **每一个**被豁免的文件都占一行（哪怕它当前"放过了 0 条问题"）——
     * 因为"整份文件级豁免 ⇒ 本域其余判据一并失效"这件事与"此刻有没有踩到"无关：
     * 只报"有问题的"那些，会让一个**看起来干净**的域悄悄脱离判据、而输出里看不出来 ✗。 */
    suppressed: exemptFiles.map((f) => ({
      file: f,
      problems: (rows.find((r) => r.file === f) || {}).suppressed || []
    }))
  };
}

function main() {
  const rows = scanAll();
  const r = summarize(rows);

  console.log('== 冒烟域内自收尾门禁（V2）==');
  console.log('  扫描 ' + r.files + ' 个冒烟域文件：');
  console.log('    · 判据生效（有收尾 / 无打开动作）：' + (r.files - r.exemptFiles.length) + ' 个文件');
  console.log('    · 显式豁免（`收尾-豁免:`）：' + r.exemptTotal + ' 条（上界 ' + r.cap + ' · 只减不增）');
  console.log('    · 未收尾：' + r.problems + ' 条');

  if (process.argv.includes('--list')) {
    console.log('');
    console.log('  ── 逐域（--list）──');
    rows.forEach((row) => {
      if (!row.problems.length) {
        console.log('  ✓ ' + row.file + '（' + (row.exemptions.length
          ? '整份文件豁免' + row.exemptions.map((x) => '第 ' + x.line + ' 行').join('、')
          : '无打开动作，或有收尾') + '）');
        return;
      }
      row.problems.forEach((p) => console.log('  ✗ ' + row.file + ' :: ' + p.seg
        + '（第 ' + p.from + ' 行起）打开了 ' + p.opens.join('、') + ' —— 这一段里没有收尾动作'));
    });
  }

  /* ★ 跳过档必须**看得见**：逐条打印放行理由（形态照抄 V1 的 `[豁免] <文件>:<行>　<原因>`）。
   *   不打印的后果是实测过的：同一处违规，加不加豁免那一行，输出**逐字相同** ⇒
   *   跳过伪装成一致 = 这道门禁对那个域不存在（`docs-for-ai` A5 / 对账批 `G-20` 取证）。 */
  r.exempt.forEach((x) => {
    console.log('[豁免]   ' + SMOKE_REL + '/' + x.file + ':' + x.line + '　' + x.reason);
  });
  /* ★ 能力边界必须**明说**：豁免是整份文件级的 —— 一行让整个域一起失效。
   *   只打印原因是不够的：读者会以为"豁免了那一条"，而真相是"这个域没人管了" ✗。
   *   也**只在放过 0 条时同样要打印**：否则一个此刻看起来干净的域会悄悄脱离判据、输出里看不出来。 */
  r.suppressed.forEach((s) => {
    console.log('  ⚠️ ' + SMOKE_REL + '/' + s.file + ' 有**整份文件级豁免** ⇒ 本域其余判据一并失效：'
      + '这一行放过了 ' + s.problems.length + ' 条问题'
      + (s.problems.length ? '（段：' + [...new Set(s.problems.map((p) => p.seg))].join('、') + '）'
        : '（该域此刻没有会被判红的问题 —— 但判据已经不在了）'));
  });

  let bad = false;

  if (r.overCap) {
    bad = true;
    console.error('✗ 显式豁免 ' + r.exemptTotal + ' 条，超过上界 ' + r.cap + ' 条（上界只减不增）—— '
      + '多出来的 ' + (r.exemptTotal - r.cap) + ' 条不受本门禁承认');
    console.error('   修法（二选一）：① 首选 —— 把豁免改回真实的收尾动作（豁免是例外，不是可攒的额度）；'
      + '② 确需保留 ⇒ 在本文件的 `EXEMPT_CAP` 里登记新上界，并在 `CHANGELOG.md` 留一笔'
      + '（**登记只写在门禁侧**：在冒烟文件里写一行**不算**登记）');
  }
  if (r.bad.length) {
    bad = true;
    console.error('✗ ' + r.bad.length + ' 个冒烟域文件里，有断言打开了浮层/模态却没写收尾：');
    r.bad.forEach((row) => row.problems.forEach((p) => {
      console.error('   [未收尾] ' + SMOKE_REL + '/' + row.file + ' :: ' + p.seg + '（第 ' + p.from + ' 行起）');
      console.error('             打开的：' + p.opens.join('；'));
    }));
    console.error('   → 两种修法（二选一）：');
    console.error('     ① 在同一段里给收尾：const mm = require(\'../smoke-assertions.js\');'
      + ' const closed = await mm.closeDialogs(ctx);（并把 closed.n 写进报文）');
    console.error('     ② 若它确实会在别处被关掉，且已有运行时判据兜底：在段内写一行 `收尾-豁免: <原因>`'
      + '（⚠️ 它豁免的是**整份文件**，且总条数受上界 ' + r.cap + ' 条限住）');
    console.error('   为什么必须收尾：模态跨域存活会盖住后面域的画布 —— 实测域 16 一处漏关'
      + ' ⇒ 域 36/37 连锁红 11 条（而那两个文件一行都没改过 ✗）');
  }

  if (bad) process.exit(1);

  console.log('✓ ' + r.files + ' 个冒烟域文件：凡"会留下浮层"的动作都在同一段里给了收尾'
    + (r.exemptTotal ? '（另有 ' + r.exemptTotal + ' 条显式豁免，已在上方逐条打印）' : '（显式豁免 0 条）'));
  console.log('  （对应的运行时兜底：main.js 的"域开始的干净前置"——域开始时有残留 ⇒ 该域判红并点名 ✓）');
}

module.exports = {
  analyzeSource, judgeSegments, findExemptions, summarize,
  segmentAssertions, scanAll, OPENERS, CLOSERS, EXEMPT, EXEMPT_CAP,
  SMOKE_REL, SMOKE_ABS
};

if (require.main === module) main();
