#!/usr/bin/env node
/* ============================================================
 * vitest-timeout-check.js — 「超时口径只有一处」门禁
 * ------------------------------------------------------------
 * 它守的那件事（台账 `r29` 的下一半，`.review/20261023-欠账稳定性/00-定题.md` §1.6 第 2 步）：
 *   `vitest.config.mjs` 已经把 `testTimeout` / `hookTimeout` 收敛成**整库唯一的 30 s**
 *   （`2026-10-13` 收口，配置 `:16` 原文"整个套件只有一个数字，且只在这里写一次"），
 *   而 `tests/` 里**曾经**还有两处 per-test 的 `, 30000`（`tests/doc-import.test.js:222`/`:245`）
 *   —— 那是**同一事实的第二处表达**：口径一变它们就静默漂移。本批把这两处删掉了，
 *   但**当时没有任何东西守着"不许再出现第二处"**。本文件就是那个东西。
 *
 * ⚠️ 为什么不能用一条 `grep 'timeout:'` 当判据（**这是本门禁存在的全部理由**）：
 *   全仓 `tests/` 里有 5 处 `timeout: <数字>`，它们是**子进程最多活多久**
 *   （`spawnSync` / `execFileSync` 的选项），不是 vitest 等多久 —— 一条宽泛的 grep 会**假红 5 处**：
 *     tests/dsh-embedded-check.test.js:34 · tests/mutate-gates.test.js:146 / :187 ·
 *     tests/search-fuzzy.test.js:422 · tests/search-hybrid.test.js:584
 *   还有第 6 个"看着像"的：`tests/dsh-prefill-wait.test.js:140` 的 `runAfter(..., 5000)`
 *   —— 它连 `timeout:` 都不是（是业务函数的第 7 个位置参数），本门禁**连看都不看**它。
 *   ⇒ 判据必须先做这一层区分：**只认 vitest 自己的调用形态**，其余一律"只报告"。
 *
 * 三档（口径的唯一权威就在下面这三个常量 / 两个函数里）：
 *   ① **在册**（`IN_REGISTER_DEBT` + `IN_REGISTER_MAX`）：允许暂时存在的 per-test 超时，
 *      每条都要写 `why` / `close`，且条数**只减不增**。本批清掉那两处之后 = **0 条 / 上限 0**
 *      （再要加一条就是"放宽判定"，必须同批抬上限并写明为什么）—— 形状同
 *      `scripts/collateral-check.js` 的 `MCP_GAP_DEBT_MAX` / `NOTE_RESIDUE_CAP`。
 *   ② **判红**：三种调用形态，命中即红（都不许在测试文件里出现）：
 *      a. `it(name, fn, <位置参数>)` / `test(name, fn, <位置参数>)` —— 第三个位置参数（vitest 的签名里
 *         它只能是超时毫秒数，所以**只要是第三个位置参数就红**，不去猜它是不是数字）；
 *      b. `it(name, { timeout: N }, fn)` / `describe(name, { timeout: N }, fn)` —— 选项对象里带 `timeout`；
 *      c. `vi.setConfig({ testTimeout: N })` / `{ hookTimeout: N }` —— 运行时改全局口径（第二处改口径的路）。
 *   ③ **只报告**：`timeout:` 出现在**别的**调用里（子进程/外部命令的选项）—— 打印成对象，**永不判红**。
 *      这条档不是"暂时放行"，是"它本来就不归本门禁管"：把它判红就等于把两个维度混成一个旋钮。
 *
 * 另外它还判**配置自身**的单源（定题 §1.6 第 ① 条）：
 *   `vitest.config.mjs` 里 `testTimeout` / `hookTimeout` **各恰好出现一次**（注释里的不算 ——
 *   该文件 `:46` 就有一句注释写着 `it(name, fn, 30000)`，用 grep 数会多数一处）；
 *   `package.json` 里**不许**再出现这两项（那就是第三个地方了）。
 *
 * 判别力（`--selftest`，**内存注入、不写盘**）：11 个夹具，每一对"该红/该绿"都正反各一条 ——
 *   其中最关键的一条是 **`spawnSync(…, { timeout: 60000 }) ⇒ 必须绿（只报告）`**：
 *   那条绿比三条红更能证明判据对（它证明的是"没有假红"，而假判据的典型死法是假红）。
 *   ⚠️ 本文件的 `--selftest` 是**这条门禁自己的单测**（不新增 vitest 用例：那是同一件事的第二处实现）。
 *
 * 用法：
 *   node vitest-timeout-check.js              判红/判绿（exit 0 / 1）
 *   node vitest-timeout-check.js --list       同上，外加在册欠账逐条与"边界"说明
 *   node vitest-timeout-check.js --selftest   判别力自检（内存注入，不读盘、不写盘）
 *   node vitest-timeout-check.js --root=<dir> 把扫描根指向别处（判别力证明用的证明口）
 *
 * ⚠️ 落盘位置（如实记）：本文件的**家**是 `<工程根>/scripts/vitest-timeout-check.js`
 *   （与其它门禁邻居），但本批**不许写 `docs/**`**，而 `scripts/docs-registry-check.js` 第 ⑦ 条（G8）
 *   要求 `scripts/` 下每个文件都是 `docs/ARCHITECTURE.md` 某张表**第一列的主语** ⇒ 放进 `scripts/`
 *   会让 G8 当场变红且本批无权修。故**先落在 `.review/`**、由父代理一条命令搬进 `scripts/` 并登记
 *   （搬的时候本文件不需要改一行：`findRoot()` 是向上找 `vitest.config.mjs`，不是写死层数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/* ===============================================================
 * 0 · 三档口径的**唯一权威**
 * =============================================================== */

/** 超时口径的唯一真源（相对工程根）。 */
const CONFIG_REL = 'vitest.config.mjs';
/** per-test 超时只允许出现在这个目录里的 `*.test.js`。 */
const TESTS_REL = 'tests';

/** 在册欠账的**条数上界：只减不增**。
 *  本批之前 `.review/20261023-欠账稳定性/00-定题.md` §1.6 只说得出 `tests/doc-import.test.js` 那两处；
 *  本门禁自己扫出**另外两处**（定题没提，见下面册子）⇒ 这两条**不是本批许改的文件**，如实登记。
 *  ⚠️ 要放宽（再加一条在册）必须同批把这个数改大并写下"为什么这一条短期删不掉"——
 *  否则它与"忘了删"分不开（同 `MCP_GAP_DEBT_MAX` 的纪律）。 */
const IN_REGISTER_MAX = 2;

/** 在册欠账（每条：`{ file, line, form, why, close }`）。
 *  · `file` 相对工程根、POSIX 斜杠；`line` 是**登记时**那一行 —— **认领按 `file` + `form` 配对**，
 *    不按行号（行号只用于报文点名）：否则在上面加一行 import，这条就会变成"册子过期"的假红。
 *  · `why` = 一句话的**人判断**（为什么这条短期删不掉）；`close` = 销账动作。
 *  条目历史：`tests/doc-import.test.js:222`/`:245`（`}, 30000)`）**本批删掉了**，所以这里没有它们。 */
const IN_REGISTER_DEBT = [
  { file: 'tests/mutate-gates.test.js', line: 194, form: 'positional',
    why: '**不是"同值副本"，是真的要更久**：`180000` 是全库唯一一处**大于**全局 30 s 的 per-test 口径'
      + '（同一条用例 `:186` 给子进程的 `timeout` 也是 180000）。删了它，vitest 会在 30 s 把测试判死、'
      + '而子进程还允许跑到 180 s ⇒ 变成"父比子短"的假红（负载下 9251 ms 已经离 30 s 只剩 3.2×）。'
      + '要不要收口是**改约定**（把 180 s 这个数搬到 `vitest.config.mjs` 一处 / 或把这条用例内化成进程内）—— '
      + '本批的许改范围不含本文件，故不动。',
    close: '① 首选：把 `mutate-gates.js` 的体检改成进程内调用（同文件 `:34` 已经有 `require` 版）⇒ 这条连同'
      + ' `:186` 的子进程都消失；② 或者：在 `vitest.config.mjs` 里给出"最贵用例"级别的那一档并在注释里写明代价；'
      + '③ 做完其一后，把本条目从册上删掉并把 `IN_REGISTER_MAX` 调小' },
  { file: 'tests/dsh-prefill-wait.test.js', line: 189, form: 'positional',
    why: '`20000` **小于**全局 30 s ⇒ 它不是"同一事实的第二处表达"，而是**故意的收紧**：'
      + '这条用例自己的断言就是 `ms < 6000`（`:188`），20 s 只是"比断言上限再留 3× 余量"的兜底。'
      + '删掉它的后果只是"红得晚 10 s"（票面价），不是行为变化 —— 属**可以删、但本批不许改这个文件**。',
    close: '把 `:189` 的 `, 20000` 删掉（`});`），让它跟全局 30 s 走：本条自己的 `< 6000` 断言会把关，'
      + '红的时间晚 10 s 而已；删完把本条目从册上删掉并把 `IN_REGISTER_MAX` 调小' }
];

/** 判红形态的编号 → 人读名字（报文里用，别在报文里另写一套说法）。 */
const RED_FORMS = {
  positional: 'it/test 的第 3 个位置参数（超时毫秒数）',
  options: 'it/describe 的选项对象里的 `timeout`',
  setConfig: 'vi.setConfig({ testTimeout | hookTimeout })'
};

/** 只报告档的一句话解释（报文里每条都带上，免得下一个人又把它读成"漏判"）。 */
const REPORT_WHY = '子进程/外部命令**最多活多久**，不是 vitest 等多久（两个维度，没有换算关系）';

/* ===============================================================
 * 1 · 文本掩码：注释 / 字符串 / 模板 / 正则（**先做这一层区分，判据才不是假的**）
 * ---------------------------------------------------------------
 * 为什么非要有它：三处假红/假绿都出在"代码与文本长得一样"上 ——
 *   · `vitest.config.mjs:46` 的**注释**里写着 `it(name, fn, 30000)`（照 grep 数会多数一处）；
 *   · 测试里报错报文含 `'timeout: 5'` 这种**字符串**（照 grep 数会多报一处）；
 *   · 函数体里的**正则** `/,/` `\(` 会把"括号配平"算错（判位置参数时就会漏/错判）。
 * 做法：一次扫描给每个字符打一个 kind，再按需掩成空格（**长度与偏移不变** ⇒ 行号、列号、
 *   `slice` 都还能对回原文）。本工程没有现成依赖可借（也不该为一个门禁引依赖）。
 * =============================================================== */
const REGEX_PREV_CHARS = '([{=,:;!&|?+-*%^~<>';
const REGEX_PREV_WORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await'];

function isWordChar(ch) { return /[A-Za-z0-9_$]/.test(String(ch || '')); }

/** 从 `i`（引号位置）扫到配对引号之后；跨行未闭合就停在行尾（不让一个坏引号吃掉整个文件）。 */
function scanQuoted(text, i) {
  const q = text.charAt(i);
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text.charAt(j);
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === '\n') return j;
    j += 1;
  }
  return n;
}

/** 从 `i`（`/` 位置）扫正则字面量；判定失败（跨行 / 没有闭合）返回 `i + 1`（当除号）。 */
function scanRegex(text, i) {
  const n = text.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = text.charAt(j);
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j += 1;
      while (j < n && /[a-z]/i.test(text.charAt(j))) j += 1;   // flags
      return j;
    } else if (c === '\n') return i + 1;
    j += 1;
  }
  return i + 1;
}

/** 从 `i`（反引号位置）扫模板字面量，`${…}` 内部当代码（对象/字符串/嵌套模板都可能出现）。 */
function scanTemplate(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text.charAt(j);
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && text.charAt(j + 1) === '{') { j = scanBraced(text, j + 1); continue; }
    j += 1;
  }
  return n;
}

/** 从 `i`（`{` 位置）扫到配对的 `}` 之后。 */
function scanBraced(text, i) {
  const n = text.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = text.charAt(j);
    if (c === '\\') { j += 2; continue; }
    if (c === '"' || c === "'") { j = scanQuoted(text, j); continue; }
    if (c === '`') { j = scanTemplate(text, j); continue; }
    if (c === '/') {
      if (text.charAt(j + 1) === '/') { const k = text.indexOf('\n', j); j = k < 0 ? n : k; continue; }
      if (text.charAt(j + 1) === '*') { const k = text.indexOf('*/', j + 2); j = k < 0 ? n : k + 2; continue; }
      const e = scanRegex(text, j);
      if (e > j + 1) { j = e; continue; }
    }
    if (c === '{') { depth += 1; j += 1; continue; }
    if (c === '}') { depth -= 1; j += 1; if (depth === 0) return j; continue; }
    j += 1;
  }
  return n;
}

/** 给定 `/` 的位置，判它是**正则开头**还是除号（经典启发：看前一个有效字符/关键字）。 */
function regexAllowedAt(text, kind, i) {
  let p = i - 1;
  while (p >= 0 && (kind[p] === 'comment' || /\s/.test(text.charAt(p)))) p -= 1;
  if (p < 0) return true;
  const ch = text.charAt(p);
  if (REGEX_PREV_CHARS.indexOf(ch) >= 0) return true;
  if (!isWordChar(ch)) return false;
  let s = p;
  while (s >= 0 && isWordChar(text.charAt(s))) s -= 1;
  const word = text.slice(s + 1, p + 1);
  return REGEX_PREV_WORDS.indexOf(word) >= 0;
}

/** 给每个字符打 kind：`code` / `comment` / `string` / `tpl` / `regex`。 */
function classify(text) {
  const n = text.length;
  const kind = new Array(n).fill('code');
  const mark = (from, to, k) => { for (let x = from; x < to && x < n; x += 1) kind[x] = k; };
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    const nx = text.charAt(i + 1);
    if (c === '/' && nx === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      mark(i, j, 'comment'); i = j; continue;
    }
    if (c === '/' && nx === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      mark(i, j, 'comment'); i = j; continue;
    }
    if (c === '"' || c === "'") { const j = scanQuoted(text, i); mark(i, j, 'string'); i = j; continue; }
    if (c === '`') { const j = scanTemplate(text, i); mark(i, j, 'tpl'); i = j; continue; }
    if (c === '/' && regexAllowedAt(text, kind, i)) {
      const j = scanRegex(text, i);
      if (j > i + 1) { mark(i, j, 'regex'); i = j; continue; }
    }
    i += 1;
  }
  return kind;
}

/** 按 kind 掩成空格（**长度不变**）。`bodies:true` 连字符串/模板/正则的内容一起掩掉。 */
function applyMask(text, kind, bodies) {
  const n = text.length;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const k = kind[i];
    const blank = k === 'comment' || (bodies && (k === 'string' || k === 'tpl' || k === 'regex'));
    const ch = text.charAt(i);
    out += blank && ch !== '\n' && ch !== '\r' ? ' ' : ch;
  }
  return out;
}

/* ===============================================================
 * 2 · 调用点解析（位置参数 / 选项对象）
 * =============================================================== */
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** 取 `openIdx` 那个 `(` 的**顶层实参**（`code` 必须已把注释掩掉；`kind` 与原文同长）。 */
function topLevelArgs(code, kind, openIdx) {
  const n = code.length;
  const args = [];
  let i = openIdx + 1;
  let start = i;
  let depth = 0;
  while (i < n) {
    const c = code.charAt(i);
    if (c === '"' || c === "'") { i = scanQuoted(code, i); continue; }
    if (c === '`') { i = scanTemplate(code, i); continue; }
    if (c === '/' && regexAllowedAt(code, kind, i)) {
      const e = scanRegex(code, i);
      if (e > i + 1) { i = e; continue; }
      i += 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') { depth += 1; i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        const raw = code.slice(start, i).trim();
        if (raw || args.length) args.push({ text: raw, start: start, end: i });
        return { args: args, close: i };
      }
      depth -= 1; i += 1; continue;
    }
    if (c === ',' && depth === 0) {
      args.push({ text: code.slice(start, i).trim(), start: start, end: i });
      start = i + 1; i += 1; continue;
    }
    i += 1;
  }
  return { args: args, close: n };
}

/** 对象字面量（**整个实参就是一个 `{…}`**）顶层出现过的键名。 */
function objectTopLevelKeys(raw) {
  const t = String(raw || '');
  if (t.trim().charAt(0) !== '{') return [];
  const kind = classify(t);
  const code = applyMask(t, kind, false);
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const c = code.charAt(i);
    if (c === '"' || c === "'") { i = scanQuoted(code, i); continue; }
    if (c === '`') { i = scanTemplate(code, i); continue; }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth -= 1; i += 1; if (depth <= 0) break; continue; }
    if (depth === 1 && isWordChar(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(code.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length; continue; }
    }
    i += 1;
  }
  return keys;
}

/** 从一个偏移往前找**包住它的那次调用**的名字（`spawnSync` / `execFileSync` / …）。 */
function enclosingCallName(code, kind, idx) {
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (code.charAt(i) !== '(') continue;
    let s = i - 1;
    while (s >= 0 && /\s/.test(code.charAt(s))) s -= 1;
    let e = s;
    while (e >= 0 && /[\w$.]/.test(code.charAt(e))) e -= 1;
    const name = code.slice(e + 1, s + 1);
    if (!name) continue;
    const call = topLevelArgs(code, kind, i);
    if (call.close > idx) return name;
  }
  return '';
}

/** `timeout:` 的值（尽量短、用于报文）。 */
function valueAfterColon(text, idx) {
  const colon = text.indexOf(':', idx);
  if (colon < 0) return '';
  const rest = text.slice(colon + 1, colon + 80);
  const m = /^\s*([^,}\n)]+)/.exec(rest);
  return m ? m[1].trim() : '';
}

/* ===============================================================
 * 3 · 三档判定（纯函数：吃**文本** ⇒ 三个清单）
 * =============================================================== */
/** 判一份测试文本的**判红**与**只报告**两档（在册那一档在 `applyRegister()` 里扣掉）。 */
function judgeTestText(text, file) {
  const kind = classify(text);
  const code = applyMask(text, kind, false);      // 注释掩掉、字符串保留（配平要用）
  const tokenMasked = applyMask(text, kind, true); // 字符串/正则也掩掉（找 token/键时别命中文本里的字样）
  const red = [];
  const report = [];

  const pushRed = (form, idx, detail, source, from, to) => {
    red.push({ file: file, line: lineOf(text, idx), form: form, detail: detail,
      range: [typeof from === 'number' ? from : idx, typeof to === 'number' ? to : idx],
      source: String(source || '').slice(0, 120) });
  };

  // ① `it` / `test` / `describe`（含 `.skip` / `.only` / `.each` … 这类成员链）
  const declRe = /(^|[^\w$.])(it|test|describe)(\s*\.\s*[A-Za-z_$][\w$]*)?\s*\(/g;
  let m;
  while ((m = declRe.exec(tokenMasked))) {
    const callee = m[2];
    const member = String(m[3] || '').replace(/\s+/g, '');
    const openIdx = m.index + m[0].length - 1;
    let call = topLevelArgs(code, kind, openIdx);
    // `.each(table)` / `.for(table)`：真正的声明在紧随其后的那次调用里
    if (member === '.each' || member === '.for') {
      let p = call.close + 1;
      while (p < code.length && /\s/.test(code.charAt(p))) p += 1;
      if (code.charAt(p) === '(') call = topLevelArgs(code, kind, p);
    }
    // a. 第 3 个位置参数（vitest 的签名里它只能是超时毫秒数）——
    //    ⚠️ 例外：`it(name, { …options… }, fn)` 这一形状里第 3 个位置是**函数**，不是超时
    //    （那一条由下面的 b 档按选项里的 `timeout` 判）⇒ 第 2 个实参是对象字面量时不判位置参数。
    const secondIsObject = call.args.length >= 2 && String(call.args[1].text).trim().charAt(0) === '{';
    if (callee !== 'describe' && !secondIsObject && call.args.length >= 3) {
      const third = call.args[2];
      const head = call.args[0] || { start: openIdx, end: openIdx + 1 };
      pushRed('positional', third.start, '第 3 个位置参数 = `' + third.text + '`',
        code.slice(head.start, Math.min(head.end, head.start + 60)), third.start, third.end);
    }
    // b. 选项对象里的 `timeout`（第 2 个实参；`{}` 形状本身不判红，只有带 timeout 才红）
    for (let k = 1; k < call.args.length; k += 1) {
      const keys = objectTopLevelKeys(call.args[k].text);
      if (keys.indexOf('timeout') >= 0) {
        const head = call.args[0] || { start: openIdx, end: openIdx + 1 };
        pushRed('options', call.args[k].start,
          '选项对象里带 `timeout` —— `' + call.args[k].text.replace(/\s+/g, ' ').slice(0, 80) + '`',
          code.slice(head.start, Math.min(head.end, head.start + 60)),
          call.args[k].start, call.args[k].end);
      }
    }
  }

  // ② `vi.setConfig({ testTimeout | hookTimeout })` —— 第二处改全局口径的路
  const setCfgRe = /(^|[^\w$.])vi\s*\.\s*setConfig\s*\(/g;
  while ((m = setCfgRe.exec(tokenMasked))) {
    const openIdx = m.index + m[0].length - 1;
    const call = topLevelArgs(code, kind, openIdx);
    call.args.forEach((a) => {
      const keys = objectTopLevelKeys(a.text);
      ['testTimeout', 'hookTimeout'].forEach((k) => {
        if (keys.indexOf(k) >= 0) {
          pushRed('setConfig', a.start, '`vi.setConfig` 里设了 `' + k + '`',
            code.slice(a.start, Math.min(a.end, a.start + 80)).replace(/\s+/g, ' '),
            a.start, a.end);
        }
      });
    });
  }

  // ③ 只报告：`timeout:` 出现在**别处**（不在上面那些判红位置里）
  const timeoutRe = /(^|[^\w$.])timeout\s*:/g;
  while ((m = timeoutRe.exec(tokenMasked))) {
    const idx = m.index + m[1].length;
    if (red.some((r) => idx >= r.range[0] && idx <= r.range[1])) continue;   // 判红那一档已报过
    const callName = enclosingCallName(code, kind, idx) || '（未识别出调用名）';
    const value = valueAfterColon(text, idx);
    report.push({ file: file, line: lineOf(text, idx), call: callName,
      value: value, why: REPORT_WHY });
  }
  return { red: red, report: report };
}

/** 把"在册"那一档扣掉：在册里没登记的判红 = 真红；登记了但已经不在 = 册子过期（也红）。
 *  ⚠️ 认领口径 = **`file` + `form`**（一条在册认领同文件同形态的**一处**），**不看行号**：
 *  行号会随"上面加一行 import"整体平移，按行号认领会把无关改动判成"册子过期"（那是假红机器）。 */
function applyRegister(reds, ledger) {
  const problems = [];
  const onBook = [];
  const pool = reds.slice();
  ledger.forEach((e) => {
    const i = pool.findIndex((r) => r.file === e.file && r.form === e.form);
    if (i >= 0) { onBook.push({ red: pool[i], entry: e }); pool.splice(i, 1); }
    else {
      problems.push({ kind: 'stale-ledger', file: e.file, line: e.line, form: e.form,
        msg: '在册欠账 `' + e.file + '`（' + (RED_FORMS[e.form] || e.form)
          + '，登记时在第 ' + e.line + ' 行）**已经不在代码里了** —— 请把它从 `IN_REGISTER_DEBT` 删掉'
          + '并把 `IN_REGISTER_MAX` 调小：册子只减不增，不销账它就永远不会缩' });
    }
  });
  if (onBook.length > IN_REGISTER_MAX) {
    problems.push({ kind: 'register-cap', msg: '在册的 per-test 超时涨了：现有 ' + onBook.length
      + ' 条 > 上限 ' + IN_REGISTER_MAX + '（`IN_REGISTER_MAX` 只减不增）' });
  }
  onBook.forEach((x) => {
    if (!x.entry.why) problems.push({ kind: 'register-why', msg: '在册条目 `' + x.entry.file
      + '` 缺 `why`（"为什么短期删不掉"必须写下来，否则这就是第二处会静默漂移的表达）' });
    if (!x.entry.close) problems.push({ kind: 'register-why', msg: '在册条目 `' + x.entry.file
      + '` 缺 `close`（销账动作 —— 不写销账方式，这条就永远不会被还掉）' });
  });
  return { red: pool, onBook: onBook, problems: problems };
}

/* ===============================================================
 * 4 · 配置自身的单源（`testTimeout` / `hookTimeout` 各恰好一次）
 * =============================================================== */
function judgeConfigText(text, rel) {
  const problems = [];
  const kind = classify(text);
  const masked = applyMask(text, kind, true);     // 注释与字符串都掩掉：注释里写着也不算配置项
  const count = (key) => (masked.match(new RegExp('(^|[^\\w$.])' + key + '\\s*:', 'g')) || []).length;
  const t = count('testTimeout');
  const h = count('hookTimeout');
  if (t !== 1) {
    problems.push({ kind: 'config', rel: rel, msg: '`testTimeout` 在 ' + rel + ' 里出现了 **' + t
      + ' 次**（要求恰好 1 次）—— 整个套件的超时口径只许有一处：'
      + (t === 0 ? '连这一处都没有 ⇒ 又回到"各文件各写一份"的状态' : '多出来的那一处就是第二份会漂移的表达') });
  }
  if (h !== 1) {
    problems.push({ kind: 'config', rel: rel, msg: '`hookTimeout` 在 ' + rel + ' 里出现了 **' + h
      + ' 次**（要求恰好 1 次）—— 与 `testTimeout` 是同一份口径（都是"多久不出结果算卡住"），一起动' });
  }
  return { problems: problems, readings: { testTimeout: t, hookTimeout: h } };
}

/* ===============================================================
 * 5 · 读盘：配置 + `tests/` 下的 `*.test.js`（递归）
 * =============================================================== */
function findRoot(start) {
  let d = path.resolve(start);
  for (let k = 0; k < 6; k += 1) {
    if (fs.existsSync(path.join(d, CONFIG_REL)) && fs.existsSync(path.join(d, TESTS_REL))) return d;
    const up = path.resolve(d, '..');
    if (up === d) break;
    d = up;
  }
  return null;
}

function listTestFiles(root) {
  const out = [];
  const walk = (absDir, relDir) => {
    fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .forEach((e) => {
        const abs = path.join(absDir, e.name);
        const rel = relDir ? relDir + '/' + e.name : e.name;
        if (e.isDirectory()) walk(abs, rel);
        else if (/\.test\.js$/i.test(e.name)) out.push(rel);
      });
  };
  const absTests = path.join(root, TESTS_REL);
  if (fs.existsSync(absTests)) walk(absTests, '');
  return out;
}

function analyze(root) {
  const problems = [];
  const notes = [];
  const cfgRel = CONFIG_REL;
  const cfgAbs = path.join(root, cfgRel);
  let cfgReadings = { testTimeout: 0, hookTimeout: 0 };
  if (!fs.existsSync(cfgAbs)) {
    problems.push({ kind: 'config', rel: cfgRel, msg: '找不到 ' + cfgRel
      + '（超时口径的唯一真源）—— 没有它，"只有一处"这句话无从判起' });
  } else {
    const j = judgeConfigText(fs.readFileSync(cfgAbs, 'utf8'), cfgRel);
    cfgReadings = j.readings;
    j.problems.forEach((p) => problems.push(p));
  }
  // 第三处：`package.json` 里再写一段 vitest 配置
  const pkgAbs = path.join(root, 'package.json');
  if (fs.existsSync(pkgAbs)) {
    const pkg = fs.readFileSync(pkgAbs, 'utf8');
    ['testTimeout', 'hookTimeout'].forEach((k) => {
      if (new RegExp('"' + k + '"\\s*:').test(pkg)) {
        problems.push({ kind: 'config', rel: 'package.json', msg: '`package.json` 里也写了 `' + k
          + '` —— 超时口径只许在 ' + cfgRel + ' 一处（这就是第三处表达）' });
      }
    });
  }

  const files = listTestFiles(root);
  let redAll = [];
  let reportAll = [];
  files.forEach((rel) => {
    const text = fs.readFileSync(path.join(root, TESTS_REL, rel), 'utf8');
    const r = judgeTestText(text, TESTS_REL + '/' + rel);
    redAll = redAll.concat(r.red);
    reportAll = reportAll.concat(r.report);
  });

  const applied = applyRegister(redAll, IN_REGISTER_DEBT);
  applied.problems.forEach((p) => problems.push(p));
  if (applied.red.length) {
    applied.red.forEach((r) => {
      problems.push({ kind: 'per-test', file: r.file, line: r.line, form: r.form,
        msg: '`' + r.file + ':' + r.line + '` 出现 per-test 超时（' + (RED_FORMS[r.form] || r.form)
          + '）：' + r.detail + ' ⇒ 这是**同一事实的第二处表达**（口径唯一位于 ' + cfgRel + '）。'
          + '出路：① 删掉它，让它跟 ' + cfgRel + ' 走（本工程的既定口径，见该文件 `:16` "只有一个数字"）；'
          + '② 真要更久 ⇒ 改 ' + cfgRel + ' 那**一处**（那是改约定，会出现在 diff 里）；'
          + '③ 短期确实删不掉 ⇒ 登记进 `IN_REGISTER_DEBT` 并**同批**抬 `IN_REGISTER_MAX`（会留下痕迹）' });
    });
  }

  const readings = {
    testFiles: files.length,
    configTestTimeout: cfgReadings.testTimeout,
    configHookTimeout: cfgReadings.hookTimeout,
    red: applied.red.length,
    onBook: applied.onBook.length,
    registerMax: IN_REGISTER_MAX,
    report: reportAll.length
  };
  notes.push('配置口径：' + cfgRel + ' 的 `testTimeout` ×' + cfgReadings.testTimeout
    + ' · `hookTimeout` ×' + cfgReadings.hookTimeout + '（各恰好 1 次 = 唯一真源）');
  notes.push('在册：' + applied.onBook.length + ' 条 / 上限 ' + IN_REGISTER_MAX + '（只减不增）');
  notes.push('判红：' + applied.red.length + ' 条（' + 'it/test/describe 的位置参数或选项、vi.setConfig'
    + '）——**不许**出现');
  notes.push('只报告：' + reportAll.length + ' 条子进程/外部命令的 `timeout:`（**不判红**：'
    + REPORT_WHY + '）');
  return { problems: problems, notes: notes, readings: readings, red: applied.red,
    onBook: applied.onBook, report: reportAll, files: files };
}

/* ===============================================================
 * 6 · 判别力自检（`--selftest`，内存注入、不写盘）
 * ---------------------------------------------------------------
 * 每条夹具都写明**期望**；实际判定与期望不一致 ⇒ exit 1。绿色那一半（"不判红"）
 * 与红色那一半一样重要 —— 本门禁的典型死法是**假红**（把子进程选项当 vitest 超时）。
 * =============================================================== */
const SELFTEST_CASES = [
  { name: '① it(name, fn, 5000) ⇒ 判红（位置参数）', text: "it('x', () => {}, 5000);\n",
    expect: { red: 1, report: 0 } },
  { name: '② test(name, fn, 30000)（换行写法）⇒ 判红', text: "test('y', function () {\n  expect(1).toBe(1);\n}, 30000);\n",
    expect: { red: 1, report: 0 } },
  { name: '③ it(name, { timeout: 5000 }, fn) ⇒ 判红（选项）', text: "it('x', { timeout: 5000, retry: 1 }, () => {});\n",
    expect: { red: 1, report: 0 } },
  { name: '④ describe(name, { timeout }, fn) ⇒ 判红（选项）', text: "describe('d', { timeout: 30000 }, () => {});\n",
    expect: { red: 1, report: 0 } },
  { name: '⑤ vi.setConfig({ testTimeout }) ⇒ 判红（第二处改口径的路）',
    text: "vi.setConfig({ testTimeout: 30000 });\n", expect: { red: 1, report: 0 } },
  { name: '⑥ spawnSync(…, { timeout: 60000 }) ⇒ **必须不判红**（只报告 1 条）',
    text: "const r = spawnSync(process.execPath, [S], { encoding: 'utf8', timeout: 60000 });\n",
    expect: { red: 0, report: 1 } },
  { name: '⑦ execFileSync(…, { cwd, encoding, timeout: 180000, maxBuffer }) ⇒ 不判红',
    text: "execFileSync(process.execPath, [S], {\n  cwd: ROOT,\n  encoding: 'utf8',\n  maxBuffer: 64 * 1024 * 1024, timeout: 180000\n});\n",
    expect: { red: 0, report: 1 } },
  { name: '⑧ it.each(table)(name, fn) ⇒ 不判红（只有 2 个位置参数）',
    text: "it.each([[1], [2]])('%s', (_l, n) => { expect(n).toBeTruthy(); });\n",
    expect: { red: 0, report: 0 } },
  { name: '⑨ 注释里写着 it(name, fn, 30000) ⇒ 不判红（不是代码）',
    text: "// 以前这里写的是 it('x', fn, 30000)，已收口\nit('x', () => {});\n",
    expect: { red: 0, report: 0 } },
  { name: '⑩ 字符串里含 "timeout: 60000" ⇒ 不判红、也不报告（不是代码）',
    text: "expect(msg).toContain('timeout: 60000');\n", expect: { red: 0, report: 0 } },
  { name: '⑪ 函数体里的正则含括号/逗号 ⇒ 不误判位置参数',
    text: "it('x', () => { expect(() => f()).toThrow(/a(b,c)/); expect(1).toBe(1); });\n",
    expect: { red: 0, report: 0 } },
  { name: '⑫ runAfter(…, 5000)（业务函数位置参数）⇒ 不看：不判红、也不报告',
    text: "const r = runAfter(a, b, c, '/x', null, 'dsh-prefill', 5000);\n",
    expect: { red: 0, report: 0 } },
  { name: '⑬ 配置里 testTimeout 出现两次 ⇒ 判红', config: 'testTimeout: 30000,\nhookTimeout: 30000,\ntestTimeout: 5000\n',
    expect: { configProblems: 1 } },
  { name: '⑭ 配置里只有一次（另一处写在注释里）⇒ 通过',
    config: '// 从前 testTimeout: 15000，现收口为：\ntestTimeout: 30000,\nhookTimeout: 30000\n',
    expect: { configProblems: 0 } },
  { name: '⑮ 配置里两处都缺 ⇒ 判红（没有真源比多处表达更糟）', config: 'exports default {};\n',
    expect: { configProblems: 2 } },
  /* 在册（`applyRegister`）的两向：认领**不看行号**（否则加一行 import 就假红）、
   * 册上那条**已经不在** ⇒ 判红（否则册子只增不减）。 */
  { name: '⑯ 在册条目行号漂了 5 行 ⇒ 仍认领（**不判红、不算过期**）',
    register: { text: "it('x', () => {}, 20000);\n",
      ledger: [{ file: '<selftest>', line: 6, form: 'positional', why: 'w', close: 'c' }] },
    expect: { red: 0, problems: 0 } },
  { name: '⑰ 册上那条已经不在代码里 ⇒ 判红（`stale-ledger`，册子只增不减是病）',
    register: { text: "it('x', () => {});\n",
      ledger: [{ file: '<selftest>', line: 6, form: 'positional', why: 'w', close: 'c' }] },
    expect: { red: 0, problems: 1 } },
  { name: '⑱ 在册条目缺 `why` / `close` ⇒ 判红（判断必须写下来）',
    register: { text: "it('x', () => {}, 20000);\n",
      ledger: [{ file: '<selftest>', line: 1, form: 'positional' }] },
    expect: { red: 0, problems: 2 } }
];

function selftest() {
  const lines = [];
  let bad = 0;
  lines.push('=== vitest-timeout-check --selftest（内存注入，不读盘、不写盘）===');
  SELFTEST_CASES.forEach((c) => {
    let ok = true;
    let got = '';
    if (c.config !== undefined) {
      const j = judgeConfigText(c.config, '<selftest>');
      got = 'configProblems=' + j.problems.length;
      ok = j.problems.length === c.expect.configProblems;
    } else if (c.register !== undefined) {
      const j0 = judgeTestText(c.register.text, '<selftest>');
      const j = applyRegister(j0.red, c.register.ledger);
      got = 'red=' + j.red.length + ' problems=' + j.problems.length;
      ok = j.red.length === c.expect.red && j.problems.length === c.expect.problems;
    } else {
      const j = judgeTestText(c.text, '<selftest>');
      got = 'red=' + j.red.length + ' report=' + j.report.length;
      ok = j.red.length === c.expect.red && j.report.length === c.expect.report;
    }
    if (!ok) bad += 1;
    lines.push((ok ? '  ✓ ' : '  ✗ ') + c.name + '  →  ' + got
      + (ok ? '' : '（期望 red=' + c.expect.red + ' report=' + c.expect.report
        + ' configProblems=' + c.expect.configProblems + ' problems=' + c.expect.problems + '）'));
  });
  lines.push(bad ? ('✗ 判别力自检失败：' + bad + ' 条夹具与期望不符') : '✓ 判别力自检通过：' + SELFTEST_CASES.length + ' 条夹具全部与期望一致');
  return { code: bad ? 1 : 0, lines: lines };
}

/* ===============================================================
 * 7 · 入口
 * =============================================================== */
function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.indexOf('--selftest') >= 0) {
    const st = selftest();
    st.lines.forEach((l) => console.log(l));
    return st.code;
  }
  const rootArg = args.find((a) => a.indexOf('--root=') === 0);
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : findRoot(__dirname);
  if (!root) {
    console.log('✗ 找不到工程根（向上 6 层都没有 ' + CONFIG_REL + ' + ' + TESTS_REL + '/）');
    return 1;
  }
  const list = args.indexOf('--list') >= 0;
  const r = analyze(root);
  console.log('=== vitest-timeout-check（守「超时口径只有一处」）===');
  console.log('根：' + root);
  r.notes.forEach((n) => console.log('  · ' + n));
  if (r.report.length) {
    console.log('只报告（逐条打印对象：它们**不是** vitest 的等待上限，永远不判红）:');
    r.report.forEach((o, i) => {
      console.log('  ' + (i + 1) + ') { file: \'' + o.file + '\', line: ' + o.line + ', call: \'' + o.call
        + '\', value: \'' + o.value + '\', why: \'' + o.why + '\' }');
    });
  }
  if (list) {
    console.log('在册欠账（`IN_REGISTER_DEBT`，上限 ' + IN_REGISTER_MAX + '）:');
    if (!IN_REGISTER_DEBT.length) console.log('  （空 —— 最后两条 tests/doc-import.test.js:222/:245 已在本批删掉）');
    IN_REGISTER_DEBT.forEach((e) => console.log('  · ' + e.file + ':' + e.line + '  form=' + e.form
      + '\n      why: ' + e.why + '\n      close: ' + e.close));
    console.log('边界（如实标注）:');
    console.log('  · 扫的是 `' + TESTS_REL + '/**/*.test.js`（vitest 只收集这一档）；'
      + '`tests/` 下的夹具/辅助模块不在判红面内；');
    console.log('  · 钩子（beforeAll/beforeEach…）的 per-hook 超时**不在**这三档里：'
      + '它们归 `hookTimeout` 那一份口径，今天全仓 0 处；要覆盖它先扩 `RED_FORMS` 并补 selftest 夹具；');
    console.log('  · `it(name, fn, SOME_CONST)`（非常量实参）同样判红 —— 位置参数只可能是超时，不去猜它是不是数字；');
    console.log('  · 判不了"某个用例该不该更慢"（那是人改 config 时的判断），只判"有没有第二处表达"。');
  }
  if (r.problems.length) {
    console.log('✗ 判红：' + r.problems.length + ' 条');
    r.problems.forEach((p, i) => console.log('  ' + (i + 1) + ') [' + p.kind + '] ' + p.msg));
    return 1;
  }
  console.log('✓ 通过：' + CONFIG_REL + ' 是超时口径的唯一真源（testTimeout ×1 · hookTimeout ×1），'
    + TESTS_REL + '/ 里 0 条 per-test 超时');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  IN_REGISTER_DEBT, IN_REGISTER_MAX, RED_FORMS, REPORT_WHY,
  classify, applyMask, topLevelArgs, objectTopLevelKeys, judgeTestText, judgeConfigText,
  applyRegister, analyze, selftest, main, findRoot, listTestFiles
};
