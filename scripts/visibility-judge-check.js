#!/usr/bin/env node
/* ============================================================
 * scripts/visibility-judge-check.js — 可见性判据门禁（门禁编号 V1）
 * ------------------------------------------------------------
 * 真实事故（本门禁存在的唯一理由，2026-10-08）：
 *   用户报「关联视图的圆钮看不见」。查下来界面代码没错 —— 错的是**我们判"看不见"的方法**：
 *   断言用 `getBoundingClientRect()`（以及类名 / `style.display`）判可见，而这几样对
 *   **裁切**与**遮挡**是盲的。实测：同一个圆钮，被父元素 `overflow:hidden` 裁掉时与正常显示时，
 *   `rect` 读数**完全相同**；而同一区域的真帧像素是 **81 px vs 768 px**
 *   （像素判据见 `scripts/vision/frame-stats.js` 的 `scanRegion`）。
 *   ⇒ 这一类断言在"元素还在、只是用户看不到"时**照样绿**。这就是它漏掉的原因 ✗。
 *
 * 门禁要保的那条纪律（一句话）：
 *   **名字里声称"可见/看不见"的断言，必须给出一个能看见像素或能命中元素的判据** ——
 *     · `document.elementFromPoint(x, y)` 命中自身（浏览器自己回答"这一点上是哪个元素"⇒ 抓得住遮挡）；
 *     · 真帧像素判据（`scanRegion` / `isAccentBlue` / `vision/frame-stats`，数像素 ⇒ 抓得住裁切）；
 *     · 或者一条**显式豁免** `判据-豁免: <原因>` —— 只留给"确实只需 rect"的少数情形。
 *   判定清单见 `analyze()` 里的 ①…⑤ 标记（此处刻意不写死条数：写死过一次就会漂，
 *   而"条数声明"的权威副本是 `docs/RULES.md` §2 的门禁行）。
 *
 * 边界（诚实标注，别以为它能包住一切）：
 *   · 它查的是**判据的来源**（有没有真判据 / 有没有声明豁免），查不了**判据用得对不对**
 *     （`elementFromPoint` 也能传错坐标 ⇒ 它照样绿 ✗）—— 那一层只能靠读图与真机复核；
 *   · 它只扫**名字里出现可见性词**的断言。名字里不写这些词、实际却在判界面的断言，它抓不到。
 *     所以"**名字要说清凭什么判**"本身是配套纪律：名字是这门禁的输入 ✗。
 *   · 它**不做重活**：纯文本扫描，不起 Electron、不起服务、不联网（本文件自己的判据都是字符串匹配）。
 *
 * 用法：
 *   node scripts/visibility-judge-check.js           判红/判绿（挂 `npm run verify`）
 *   node scripts/visibility-judge-check.js --list    打印每一条触发断言的分类与判据来源
 *   node scripts/visibility-judge-check.js --debt    打印既有欠账清单（= 第二步的迁移清单）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SMOKE_REL = 'scripts/smoke';
const SMOKE_ABS = path.join(ROOT, SMOKE_REL);

/* ---------------------------------------------------------------
 * ① 触发词：断言**名字**里出现这些词 ⇒ 它就在声称可见性。
 *    词表刻意短而准：长词表会把"数据可见""变更可见性"这类**同词不同义**的断言卷进来，
 *    而假红的下场是这条门禁被人无视（那等于没有）。窄的代价是漏 —— 边界已写在文件头 ✗。
 * --------------------------------------------------------------- */
const VIS_WORDS = ['可见', '不可见', '遮挡', '面板内', '框外', '看得见', '看不见'];

/* ---------------------------------------------------------------
 * ② 真判据：名字声称可见时，断言体里必须出现**至少一个**。
 *    两类缺一不可：命中测试抓遮挡，真帧像素抓裁切（事故里同时被这两种骗过）。
 * --------------------------------------------------------------- */
const REAL_JUDGES = [
  { token: 'elementFromPoint', kind: '命中测试', why: '浏览器回答"这一点上是哪个元素"⇒ 抓得住遮挡' },
  { token: 'scanRegion', kind: '真帧像素', why: 'scanRegion 数真帧像素（scripts/vision/frame-stats.js）' },
  { token: 'isAccentBlue', kind: '真帧像素', why: 'isAccentBlue 数真帧像素（accent 色）' },
  { token: 'frame-stats', kind: '真帧像素', why: 'vision/frame-stats 的像素判据' },
  { token: 'bitmapInfo', kind: '真帧像素', why: 'bitmapInfo 读真帧（尺寸/不透明像素）' }
];

/* ---------------------------------------------------------------
 * ③ 盲判据：这些**单独用**判不出"用户看不看得见"（对裁切/遮挡是盲的）。
 *    它们出现在断言体里 ⇒ 这条断言确实在判"在不在 / 什么样"，也就落进了事故那一类。
 *    （反过来说：体内连盲判据都没有的，多半是"数据/文案语义"的可见 ⇒ 见 ④，不判红。）
 * --------------------------------------------------------------- */
const BLIND_JUDGES = [
  { token: 'getBoundingClientRect', kind: '几何' },
  { token: 'getClientRects', kind: '几何' },
  { token: 'offsetWidth', kind: '几何' },
  { token: 'offsetHeight', kind: '几何' },
  { token: 'offsetParent', kind: '几何' },
  { token: 'clientWidth', kind: '几何' },
  { token: 'clientHeight', kind: '几何' },
  { token: 'classList.contains', kind: '类名' },
  { token: 'className', kind: '类名' },
  { token: 'style.display', kind: '行内样式' },
  { token: 'style.visibility', kind: '行内样式' },
  { token: 'style.opacity', kind: '行内样式' },
  { token: 'getComputedStyle', kind: '计算样式' }
];

/** 显式豁免标记：`判据-豁免: 原因`（注释或字符串里都认 —— 它本来就是给人看的） */
const EXEMPT_RE = /判据-豁免\s*[:：]\s*(\S[^\n]*)/;

/** 断言对象：`name: '…'` 后面紧跟 `run:` 才是断言（避免把注入代码串里的 `name:` 当成断言） */
const NAME_RE = /name:\s*'((?:[^'\\]|\\.)*)'/g;
const RUN_AHEAD_RE = /^[\s\S]{0,400}?\brun\s*:/;

/* ---------------------------------------------------------------
 * ④ 既有欠账清单（**只减不增**）
 *    为什么需要它，而不是直接判红：
 *      · 门禁上线时，仓库里已经有若干条这类断言（多数是**旧域**，与本次事故无关）；
 *      · 第二步（逐条迁移）被"另一个会话正在改同一批文件"挡住了（见 CHANGELOG 的 [Unreleased]）；
 *      · 若直接判红，全链会长期变红 —— 而**长期红的门禁等于没有门禁**（下一个人会把它关掉 ✗）。
 *    所以：在册的算"欠账"（打印出来、计数可见），**不在册的一律判红**（新代码不许再写盲判据）。
 *    防滥用：清单是**封闭**的 —— 欠账已经被修好（断言已有真判据 / 名字已消失）却还留在册上 ⇒ **判红**，
 *    逼人销账；条目本身要写 `why`（为什么当初这么写）与 `fix`（怎么迁），改不动就说明理由 ✗。
 *    ⚠️ 清单只能靠"修好 + 删条目"缩小；**加条目**必须同时给出为什么它只能这么判（否则就是放宽判定 ✗）。
 * --------------------------------------------------------------- */
const DEBT = [
  /* ⚠️ **空** —— 2026-10-09 七条在册欠账**已逐条迁完**（第一步门禁落地 → 第二步逐条迁移收口）。
   *  为什么保留这个空数组而不删掉机制：清单是**封闭**的 —— "在册算欠账、不在册一律判红、
   *  修好忘销账也判红"这套判定（`analyze()` 的 ④）靠的就是它与 `staleDebt` 的对照。
   *  删掉数组 = 把"新代码不许再写盲判据"这条判定一起删掉 ✗。
   *
   *  迁移记录（每一步的"原判据 → 新判据"，权威副本在 git 历史与 `docs/CHANGELOG.md`）：
   *   · `05-pan-lock.js` 拖动树连线 —— 两级 rect → 每条线两端 9×9px 窗口数真帧线像素；
   *   · `08-audit-palette.js` 审计面板"关闭后不再遮挡" —— `style.display` → `elementFromPoint`
   *     不再命中面板层 + 同一小块真帧 mean 变亮；
   *   · `12-dsh-drag.js` 保存按钮"可见可点" —— rect + `flexWrap` → `elementFromPoint` 命中自身
   *     + 真帧非背景像素 + **真输入** `ctx.input.click`（capture 阶段拦下 click 只记目标，不真触发 save）；
   *   · `12-dsh-drag.js` "可见子节点" —— **改名消歧**（数据语义的"展开集合"，不是界面可见）：名字改成
   *     "其展开中的子节点" ⇒ 不再是本门禁的触发项（硬套像素反而是错的判据）；
   *   · `34-user-paths.js` 用户路径① 圆钮 —— `BTN_JS` 纯几何 → 加 `elementFromPoint` 命中圆心
   *     + 真帧非背景像素 ≥ `thresholds.paint.minHitsRoundBtn`；
   *   · `34-user-paths.js` "圆钮完整落在面板内" —— 纯 rect 包含 → `elementFromPoint` 命中自身
   *     + 真帧像素（被面板裁掉则像素骤降）；
   *   · `35-rel-edit.js` 关联信息编辑条 —— 三句 rect 比较 → 中心 + 四角 `elementFromPoint` 命中条自身
   *     + 每个被框节点顶缘中点的命中不得落进条 + 真帧像素。
   *  每条迁移都做过**判别力证明**（注入违规 ⇒ 必红 ⇒ 撤销 ⇒ 逐字节还原），报文见 CHANGELOG。
   *
   *  ⚠️ 新增条目**仍是禁区**：清单只能靠"修好 + 删条目"缩小；加条目必须同时给出
   *  "为什么它只能这么判"（否则就是放宽判定 ✗，见下面 ④ 的设计说明）。 */
];

/* ---------------------------------------------------------------
 * ⑤ 触发数下限（防绕道）
 *    把 name 里的"可见/看不见"删掉，就能让本门禁闭嘴 —— 那是绕过而不是修复 ✗。
 *    所以触发数低于下限即判红并要求复核。它是**下限**不是目标：合理改名/删域让数字下降时，
 *    同批下调本数字并在 CHANGELOG 说明；**不许**为了让它变绿去删名字里的词 ✗。
 * --------------------------------------------------------------- */
const MIN_TRIGGERED = 6;

/* =============================== 纯函数 =============================== */

/**
 * 去掉注释（**保留字符串/模板里的内容**）。
 *
 * 为什么要"保留字符串里的内容"：真判据常常写在**注入的 JS 串**里
 * （`ctx.exec(\`…document.elementFromPoint(cx, cy)…\`)`），把它们一起删掉就再也判不出真判据 ✗。
 * 为什么必须去注释：注释里提到 `elementFromPoint` 不代表用了它 —— 判据要是**代码**。
 * ⚠️ 实测踩到（门禁第一版空转）：域 37 那条合规断言的**名字里**写着 "elementFromPoint 命中"
 *   （"名字要说清凭什么判"本身就是配套纪律 ✓），于是抹掉代码里的判据后门禁**照样绿** ✗。
 *   所以除了去注释，还要把 `name: '…'` 这个字符串本身抹掉。
 */
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { if (i + 1 < src.length) { out += src[i + 1]; i++; } continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/** 判据视图：去注释 + 抹掉断言名那个字符串（名字里提到某个 API 不算用它 ✗） */
function judgeView(src) {
  return stripComments(src).replace(/(\bname\s*:\s*)'((?:[^'\\]|\\.)*)'/g, "$1''");
}

/** 从 `from` 起扫一条语句（跳过字符串/模板，遇顶层 `;` 停）—— 用来把同文件里的 JS 片段常量整段摘出来 */
function sliceStatement(src, from) {
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';') return src.slice(from, i);
  }
  return src.slice(from);
}

/** 取同文件内某个 `const/let/var NAME = …` 的**源码片段**（找不到返回 null） */
function constSource(src, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*(?:const|let|var)\\s+' + name.replace(/[$]/g, '\\$') + '\\s*=');
  const m = re.exec(src);
  return m ? sliceStatement(src, m.index + m[0].length) : null;
}

/**
 * 把断言体里引用到的**同文件 JS 片段常量**展开进来（最多 3 层）。
 *
 * 为什么必须做这件事（真实案例，不是理论）：域 34 的圆钮断言体里只有 `BTN_JS` 一个名字，
 * 真正的判据（`getBoundingClientRect` / `offsetParent`）全写在文件顶部那个常量里。
 * 只扫断言体 ⇒ 判成"没有判据" ⇒ **事故现场那句断言反而逃过门禁** ✗。
 * 展开的边界：只展开**同文件**里 `const NAME = …` 声明的片段；跨文件（如公共工具）不展开 ⇒
 * 那类断言会落到"欠账/新违规"，由人来看 —— 宁可多报，不可漏报。
 */
function expandSnippets(region, src) {
  let out = region;
  const seen = new Set();
  for (let depth = 0; depth < 3; depth++) {
    const ids = new Set();
    for (const m of out.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)/g)) ids.add(m[1]);
    let grew = false;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const s = constSource(src, id);
      if (!s) continue;
      // 已在本区域内声明的（体内局部变量）不重复展开
      if (new RegExp('(?:const|let|var)\\s+' + id + '\\s*=').test(region)) continue;
      out += '\n' + s;
      grew = true;
    }
    if (!grew) break;
  }
  return out;
}

/** 名字是否在声称可见性 */
function visibilityWordsIn(name) {
  return VIS_WORDS.filter((w) => name.indexOf(w) >= 0);
}

/**
 * 把一段源码里**所有真判据的字面量**抹掉（⇒ 那条断言只剩盲判据）。
 *
 * 为什么是"全部"而不是"抹掉 `document.elementFromPoint`"（**实测踩到，2026-10-09**）：
 *   门禁上线时仓库里**只有一条**合规断言（域 37），抹掉它唯一的判据就是一次有效注入 ✓。
 *   逐条迁移完成后有 **7 条**合规断言，且其中 6 条**同时**用了命中测试与真帧像素
 *   （两类判据缺一不可，见 H2 的教训）⇒ 只抹 `elementFromPoint` 时，它仍靠 `scanRegion`
 *   合规、门禁**照样绿** —— 那不是门禁在空转，而是**注入选错了对象** ✗
 *   （教训：判别力证明失败时先问"我注入的到底是不是那条判据"，别急着改判定）。
 *   判据清单**不另写一份**：直接由上面那个 `REAL_JUDGES` 数组生成 ⇒ 门禁加一类真判据时，
 *   这条注入自动跟着覆盖，不会再出现"注入漏了新判据"这种空转 ✓。
 */
function zeroRealJudges(src) {
  let out = src;
  for (const j of REAL_JUDGES) out = out.split(j.token).join('判据已抹掉');
  return out;
}

/** 找出文件里的断言（`name: '…'` 且后面紧跟 `run:`），返回 {name, line, regionStart, start} */
function findAssertions(src) {
  const hits = [];
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(src))) {
    const ahead = src.slice(m.index + m[0].length, NAME_RE.lastIndex + 400);
    if (!RUN_AHEAD_RE.test(ahead)) continue;           // 不是断言对象（多半是注入代码串里的 name:）
    hits.push({ name: m[1], start: m.index, line: src.slice(0, m.index).split('\n').length });
  }
  hits.forEach((h, i) => {
    h.end = (i + 1 < hits.length) ? hits[i + 1].start : src.length;
    h.regionStart = backwardRegionStart(src, h.start);
  });
  return hits;
}

/** 从 `name:` 往回吃到注释/`{`/空行为止 —— 让"写在断言上方的 `判据-豁免:` 注释"落在本条里 */
function backwardRegionStart(src, nameIdx) {
  const head = src.slice(0, nameIdx);
  const lines = head.split('\n');
  let i = lines.length - 1;                            // 最后一行是 name: 那一行的前半
  while (i >= 0) {
    const t = lines[i].trim();
    const ok = t === '' || t === '{' || t === '},' || t === '}' || t === '[' || t === '];'
      || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    if (!ok) break;
    i--;
  }
  return lines.slice(0, i + 1).join('\n').length;
}

/**
 * 判一条断言：返回 {judges, real, exempt, blind, verdict}
 * verdict ∈ 'ok'（有真判据）| 'exempt'（显式豁免）| 'blind'（只有盲判据 ⇒ 违规候选）| 'nonvisual'（体内没有可视判据）
 *
 * 两个视图分开看，是这道门禁能不能真判出东西的关键：
 *   · `code` —— 去注释 + 去名字串 + 展开同文件 JS 片段常量 ⇒ 判"有没有真判据 / 有没有盲判据"；
 *   · `raw`  —— 原样（含注释）⇒ 只用来认 `判据-豁免:` 标记（它本来就是写给人看的一句话 ✓）。
 */
function judgeAssertion(rawRegion, srcRaw) {
  const code = expandSnippets(judgeView(rawRegion), judgeView(srcRaw));
  const judges = REAL_JUDGES.filter((j) => code.indexOf(j.token) >= 0);
  const blind = BLIND_JUDGES.filter((j) => code.indexOf(j.token) >= 0);
  const ex = EXEMPT_RE.exec(rawRegion);
  const exempt = ex ? ex[1].trim() : null;
  if (judges.length) return { judges, real: judges, exempt, blind, verdict: 'ok' };
  if (exempt) return { judges, real: [], exempt, blind, verdict: 'exempt' };
  if (blind.length) return { judges, real: [], exempt: null, blind, verdict: 'blind' };
  return { judges, real: [], exempt: null, blind, verdict: 'nonvisual' };
}

/** 判定①…⑤ 的纯函数形态：吃 `[{rel, src}]`，吐清单（不打印、不退出 ⇒ 可被单测 require）
 *  `opts.minTriggered` 只给单测改（小样例凑不满下限；生产路径一律用 MIN_TRIGGERED ✗） */
function analyze(files, debt, opts) {
  const debtIn = debt || DEBT;
  const minTriggered = (opts && typeof opts.minTriggered === 'number') ? opts.minTriggered : MIN_TRIGGERED;
  const judged = [];      // 有真判据（或显式豁免）
  const debts = [];       // 在册欠账（还违规）
  const problems = [];    // 不在册的违规 ⇒ 判红
  const nonVisual = [];   // 名字含词、体内没有任何可视判据（多为数据/文案语义）⇒ 只提示
  let assertions = 0, triggered = 0;

  const used = new Set();

  for (const f of files) {
    for (const a of findAssertions(f.src)) {
      assertions++;
      const words = visibilityWordsIn(a.name);
      if (!words.length) continue;
      triggered++;
      const rawRegion = f.src.slice(a.regionStart, a.end);
      const j = judgeAssertion(rawRegion, f.src);
      const row = {
        rel: f.rel, line: a.line, name: a.name, words, verdict: j.verdict,
        via: (j.real.length ? j.real : []).map((x) => x.token),
        viaKind: (j.real.length ? j.real : []).map((x) => x.kind + '：' + x.why),
        exempt: j.exempt,
        blind: j.blind.map((x) => x.token + '（' + x.kind + '）')
      };
      if (j.verdict === 'ok' || j.verdict === 'exempt') { judged.push(row); continue; }
      if (j.verdict === 'nonvisual') { nonVisual.push(row); continue; }
      // 'blind' ⇒ 违规候选：看它在不在既有欠账册里
      const hit = debtIn.find((d) => d.rel === f.rel && d.name === a.name);
      if (hit) { used.add(hit); debts.push(Object.assign({ why: hit.why, fix: hit.fix }, row)); }
      else problems.push(row);
    }
  }

  // 欠账册的封闭性：册上有、但**已经不是违规**（修好了 / 名字没了）⇒ 判红，逼人销账
  const staleDebt = debtIn.filter((d) => !used.has(d))
    .map((d) => ({ rel: d.rel, name: d.name, why: d.why, fix: d.fix }));

  const scansOk = files.length > 0 && assertions > 0;
  const floorOk = triggered >= minTriggered;
  return {
    ok: problems.length === 0 && staleDebt.length === 0 && scansOk && floorOk,
    files: files.length, assertions, triggered, minTriggered,
    scansOk, floorOk, judged, debts, problems, nonVisual, staleDebt
  };
}

/* =============================== I/O =============================== */

/** 读冒烟域文件（只读 `NN-名字.js` 这一种命名，与 `scripts/smoke-assertions.js` 的自动发现一致） */
function loadSmokeFiles(dir) {
  const abs = dir || SMOKE_ABS;
  return fs.readdirSync(abs)
    .filter((f) => /^\d+-.+\.js$/.test(f))
    .sort()
    .map((f) => ({ rel: SMOKE_REL + '/' + f, src: fs.readFileSync(path.join(abs, f), 'utf8') }));
}

/* =============================== CLI =============================== */

/* =============================== 判别力自检 =============================== */

/**
 * `--selftest`：**不碰任何文件**（全程只在内存里注入），证明这道门禁真的会红。
 *
 * 为什么要有它（而不是"当初手验过一次"）：本工程的门禁死过一次 —— 注入违规后**exit 0 没变红**，
 * 因为它要求的字面量在中文自然写法里压根匹配不上（"2 条视觉断言"，类别词夹在数字与"断言"之间）。
 * 一个没红过的门禁等于不存在 ✗。这条自检把"它会红"变成**每次都能重放**的事实 ✓。
 * 做法（与 `scripts/vision/frame-stats.js --selftest` 同一路子）：
 *   ① 拿**仓库里真实的**断言字节，把样板断言用到的真判据字面量**全部**抹掉（判据来源由
 *      `REAL_JUDGES` 生成，见 `zeroRealJudges` 的说明）⇒ 必须红；
 *   ② 让一条真实断言只留 rect（把它的名字也算进去，检验"名字里提到判据不算判据"）⇒ 必须红；
 *   ③ 用原始字节重算 ⇒ 必须复绿（证明①②只是内存里的注入，没有污染真输入 ✗）。
 */
function selftest() {
  const real = loadSmokeFiles();
  const base = analyze(real);
  const sample = base.judged.find((x) => x.verdict === 'ok' && x.via.length);
  const out = { ok: true, steps: [] };
  const step = (name, ok, detail) => {
    out.steps.push({ name: name, ok: ok, detail: detail });
    if (!ok) out.ok = false;
  };

  step('基线：仓库现状没有新违规、没有悬挂欠账',
    base.problems.length === 0 && base.staleDebt.length === 0,
    '触发 ' + base.triggered + ' 条 / 有真判据 ' + base.judged.filter((x) => x.verdict === 'ok').length
      + ' 条 / 在册欠账 ' + base.debts.length + ' 条 / 新违规 ' + base.problems.length + ' 条');

  step('基线：存在一条"有真判据"的样板断言（否则自检没法注入）', !!sample,
    sample ? sample.rel + ':' + sample.line + '　' + sample.name : '没找到样板断言 ✗');

  if (sample) {
    const idx = real.findIndex((f) => f.rel === sample.rel);
    const stripped = real.map((f, i) => (i === idx ? { rel: f.rel, src: zeroRealJudges(f.src) } : f));
    const r1 = analyze(stripped);
    step('注入 1：抹掉样板断言用到的**全部**真判据（' + sample.via.join('、') + '）⇒ 必须判红',
      r1.problems.some((p) => p.name === sample.name),
      r1.problems.length ? '报红 ' + r1.problems.length + ' 条：' + r1.problems[0].rel + ':' + r1.problems[0].line
        + '　' + r1.problems[0].name.slice(0, 40) + '…' : '没红 ✗（门禁在空转，或注入选错了对象）');
  }

  step('注入 2：一条"名字里写着 elementFromPoint、代码里只有 rect"的断言 ⇒ 必须判红', (function () {
    const src = [
      'module.exports = [',
      '  {',
      "    name: '圆钮**完整落在面板内**（elementFromPoint 命中 + 真帧像素）',",
      '    run: async (ctx) => {',
      "      const w = await ctx.exec('document.querySelector(\".a\").getBoundingClientRect().width');",
      '      return { ok: Number(w) > 8 };',
      '    }',
      '  }',
      '];',
      ''
    ].join('\n');
    const r2 = analyze([{ rel: 'scripts/smoke/99-selftest-probe.js', src }], [], { minTriggered: 1 });
    return r2.problems.length === 1;
  })(), '名字里的字面量不算判据（实测踩到过这条空转 ✗）');

  step('撤销：用原始字节重算 ⇒ 必须复绿（注入只在内存里，真输入没被改过 ✗）',
    analyze(real).problems.length === 0, '真输入仍然 0 违规 ✓');

  return out;
}

function main() {
  if (process.argv.includes('--selftest')) {
    console.log('== visibility-judge-check --selftest（判别力自检：不碰任何文件）==');
    const r = selftest();
    for (const s of r.steps) console.log('  ' + (s.ok ? '✓' : '✗') + ' ' + s.name + '\n      ' + s.detail);
    console.log(r.ok ? '\n自检通过：注入 ⇒ 必红；撤销 ⇒ 必绿 ✓'
      : '\n自检失败：这道门禁现在证明不了自己会红 ✗');
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const listMode = process.argv.includes('--list');
  const debtMode = process.argv.includes('--debt');
  const r = analyze(loadSmokeFiles());

  if (debtMode) {
    console.log('== 既有欠账清单（第二步迁移用；只减不增）==');
    if (!r.debts.length && !r.staleDebt.length) console.log('  （空 —— 已全部迁完 ✓）');
    for (const d of r.debts) {
      console.log('  · ' + d.rel + ':' + d.line + '　' + d.name);
      console.log('      现在用的判据：' + d.blind.join('、'));
      console.log('      为什么是欠账：' + d.why);
      console.log('      怎么迁：' + d.fix);
    }
    for (const d of r.staleDebt) {
      console.log('  ⚠ 已在册但**已不构成违规**（销账未清 ⇒ 判红）：' + d.rel + '　' + d.name);
    }
    console.log('');
    console.log('  在册 ' + r.debts.length + ' 条；触发 ' + r.triggered + ' 条；'
      + '有真判据 ' + r.judged.length + ' 条');
    process.exitCode = r.staleDebt.length ? 1 : 0;
    return;
  }

  console.log('== 可见性判据门禁（V1）==');
  console.log('  扫描 ' + r.files + ' 个冒烟域文件、' + r.assertions + ' 条断言；'
    + '名字声称可见性的 ' + r.triggered + ' 条（下限 ' + r.minTriggered + '）');
  console.log('    · 有真判据（命中测试 / 真帧像素）：' + r.judged.filter((x) => x.verdict === 'ok').length + ' 条');
  console.log('    · 显式豁免（`判据-豁免:`）：' + r.judged.filter((x) => x.verdict === 'exempt').length + ' 条');
  console.log('    · 既有欠账（在册，只减不增）：' + r.debts.length + ' 条');
  console.log('    · 新违规：' + r.problems.length + ' 条');
  console.log('    · 名字含词但体内没有可视判据（多为数据/文案语义）：' + r.nonVisual.length + ' 条');

  if (listMode) {
    console.log('');
    console.log('  ── 逐条（--list）──');
    const show = (tag, rows) => rows.forEach((x) => {
      console.log('  ' + tag + ' ' + x.rel + ':' + x.line + '　' + x.name);
      if (x.via.length) console.log('        真判据：' + x.via.join('、'));
      if (x.exempt) console.log('        豁免：' + x.exempt);
      if (x.blind && x.blind.length) console.log('        盲判据：' + x.blind.join('、'));
      if (x.words) console.log('        触发词：' + x.words.join('、'));
    });
    show('[真判据]', r.judged.filter((x) => x.verdict === 'ok'));
    show('[豁免]  ', r.judged.filter((x) => x.verdict === 'exempt'));
    show('[欠账]  ', r.debts);
    show('[违规]  ', r.problems);
    show('[无判据]', r.nonVisual);
  }

  let bad = false;

  if (!r.scansOk) {
    bad = true;
    console.error('✗ 一个断言都没扫到（' + SMOKE_REL + '/NN-*.js）—— 取不到真值，拒绝通过');
  }
  if (r.scansOk && !r.floorOk) {
    bad = true;
    console.error('✗ 名字里声称可见性的断言只剩 ' + r.triggered + ' 条（下限 ' + r.minTriggered + '）—— '
      + '要么是本门禁的输入被绕过了（把名字里的词删掉就能让它闭嘴 ✗），要么是真的清理过：'
      + '请复核后同批下调 MIN_TRIGGERED 并在 CHANGELOG 说明');
  }
  if (r.problems.length) {
    bad = true;
    console.error('✗ 有 ' + r.problems.length + ' 条断言在名字里声称"可见/看不见"，判据却是对裁切与遮挡是盲的：');
    for (const p of r.problems) {
      console.error('  ✗ ' + p.rel + ':' + p.line + '　' + p.name);
      console.error('      原因：体内只有 ' + (p.blind.join('、') || '（无）')
        + ' —— 这些读不出"用户看不看得见"（实测：被父元素 overflow:hidden 裁掉时 rect 读数与正常显示**完全相同**）');
      console.error('      修法：二选一 —— ① 加真判据：对元素中心做 `document.elementFromPoint` 断言命中自身'
        + '（抓遮挡），或对它的矩形做 `scanRegion` 数像素并给阈值（抓裁切，见 scripts/vision/frame-stats.js）；'
        + '② 若这条确实只需 rect，在断言上方写一行 `判据-豁免: <原因>`。');
      console.error('      （"可点"那半可以用真输入 `ctx.input.*` 单独判 —— 但它不判可见，可见那半仍需像素或命中测试）');
    }
  }
  if (r.staleDebt.length) {
    bad = true;
    console.error('✗ 既有欠账册里有 ' + r.staleDebt.length + ' 条**已经不是违规**了（销账未清 ⇒ 判红，欠账只减不增）：');
    for (const d of r.staleDebt) {
      console.error('  ✗ ' + d.rel + '　' + d.name);
      console.error('      修法：删掉 ' + 'scripts/visibility-judge-check.js' + ' 里 DEBT 的这条（它已经修好了，'
        + '或者那条断言的名字/位置变了 ⇒ 请把册上的名字改成现状）');
    }
  }

  if (bad) {
    console.error('\nvisibility-judge-check 失败（可见性判据门禁 V1）');
    console.error('欠账与修法一览：`node scripts/visibility-judge-check.js --debt`');
    process.exit(1);
  }
  console.log('  ✓ 声称可见性的断言都给了真判据（或有显式豁免）；在册欠账 ' + r.debts.length + ' 条（未新增）');
  console.log('\nvisibility-judge-check 通过');
}

module.exports = {
  VIS_WORDS, REAL_JUDGES, BLIND_JUDGES, EXEMPT_RE, DEBT, MIN_TRIGGERED,
  SMOKE_REL, SMOKE_ABS,
  sliceStatement, constSource, expandSnippets, visibilityWordsIn,
  stripComments, judgeView,
  findAssertions, backwardRegionStart, judgeAssertion, analyze, loadSmokeFiles, selftest,
  zeroRealJudges
};

if (require.main === module) main();
