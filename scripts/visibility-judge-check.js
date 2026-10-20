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
 *   判定清单见 `analyze()` 里的 ①…⑦ 标记（此处刻意不写死条数：写死过一次就会漂，
 *   而"条数声明"的权威副本是 `docs/RULES.md` §2 的门禁行）。
 *
 * ## 2026-10-20：两条"能把守卫**静默关掉**"的缝已收口（`G-19` 那一批只钉未修，本批修）
 *   两条缝的取证与修前/修后读数在 `.review/20261020-门禁A/`（`probe-v1-seams.js` 的 JSON 读数）。
 *
 *   **缝 (a) — 空豁免标记仍生效，而且会吞掉下一行代码当原因。**
 *     修前：`EXEMPT_RE = /判据-豁免\s*[:：]\s*(\S[^\n]*)/` —— 那两处 `\s*` **能跨行**，
 *     于是 `// 判据-豁免:` 后面不写字时，正则把**下一行代码**（实测是
 *     `const r = await ctx.exec('…getBoundingClientRect()…');`）当成"豁免原因"捕获，
 *     verdict 直接变 `exempt` ⇒ 一条只有 rect 的可见性断言被放行、**exit 0**。
 *     对照（`V2` `scripts/smoke-state-check.js` 的 `findExemptions`）：它**按行**喂正则，
 *     所以 `\s*` 跨不过去 ⇒ 冒号后必须**同行**有非空白字符才算豁免。
 *     修后：`EXEMPT_RE` 里的 `\s*` **全部**收成 `[ \t]*`（不许跨行），口径与 `V2` 一致：
 *     **豁免原因不能为空**；写空的标记**不算豁免**，该断言按它自己的判据照常受判
 *     （只有盲判据 ⇒ 判红；连判据都没有 ⇒ 见缝 (b) ⇒ 也判红）。
 *     另加 `EMPTY_EXEMPT_RE` 专门认"写空的标记本身"，好让报文**明说**"原因不能为空"，
 *     而不是让人对着一句"体内只有 getBoundingClientRect"猜自己做错了什么（`R1d` 响亮）。
 *
 *   **缝 (b) — `nonvisual` 档只报告、不判红。**
 *     修前：`analyze()` 的 `ok` 表达式是
 *     `problems.length === 0 && staleDebt.length === 0 && scansOk && floorOk` —— **不含 nonVisual**；
 *     而 `'nonvisual'` 分支只 `nonVisual.push(row)` 就 `continue`。⇒ 把一条合规断言体内的
 *     **盲判据一起删干净**（rect/类名/行内样式全删、名字里的"可见"保留），它就从
 *     `'blind'`（判红）滑进 `'nonvisual'`（只报告）⇒ **守卫被静默降级成一条提示**。
 *     修后：**名字宣称可见、体内既无真判据也无盲判据 ⇒ 判红**（这比"用了盲判据"更可疑：
 *     连假装都没装 ✓）。既有 6 条已在 `NONVISUAL_DEBT`（封闭在册，逐条写明为什么是
 *     "数据/文案语义的可见"，欠账只减不增、修好忘销账照样判红）。
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
 *    ⚠️ 2026-10-20 改：**体内连盲判据都没有的，不再"多半是数据语义"就放过** ——
 *    "名字宣称可见但既无真判据也无盲判据"落到 `'nonvisual'` 档，**现在判红**
 *    （详见文件头「缝 (b)」与 ⑥ `NONVISUAL_DEBT`）。修前它只报告 ⇒ 把 rect 删干净
 *    就能把守卫从红降级成提示，那是**可静默关掉**的路 ✗。
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

/** 显式豁免标记：`判据-豁免: 原因`（注释或字符串里都认 —— 它本来就是给人看的）。
 *
 *  ⚠️ **原因不许为空，且必须与冒号同一行**（2026-10-20 修；与 `V2` 的 `收尾-豁免:` 口径一致）：
 *    修前正则里的 `\s*` **能跨行**，`// 判据-豁免:` 后面不写字时会把**下一行代码**当原因吞掉
 *    ⇒ 一条只有 rect 的可见性断言被放行（实测读数见 `.review/20261020-门禁A/probe-v1-seams.json`）。
 *    现在冒号后只吃 `[ \t]*`（不许换行），再要求一个非空白字符 ⇒ 空原因 = **不算豁免**。
 *    `(?!\*\/)` 是给块注释收尾用的：`/* 判据-豁免: *\/` 里的 `*\/` 不算"原因"。 */
const EXEMPT_RE = /判据-豁免[ \t]*[:：][ \t]*(?!\*\/)(\S[^\n]*)/;

/** 认"写空的豁免标记**本身**"——**不判它豁免**，只用来在报红时说清"原因不能为空"（`R1d`）。
 *  含 `*\/` 收尾的形态（`/* 判据-豁免: *\/`）也算空。 */
const EMPTY_EXEMPT_RE = /判据-豁免[ \t]*[:：][ \t]*(?:\*\/)?[ \t]*(?=[\r\n]|$)/;

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
 * ⑥ "无判据"欠账册（`NONVISUAL_DEBT`）—— **缝 (b) 的收口**
 *    为什么要这张册子，而不是直接把 `'nonvisual'` 全判红：
 *      · 名字里的"可见"有三个**同词不同义**：① 用户看得见（像素/遮挡）；② 数据/文案语义的
 *        "可见"（"写后重读可见" "变更可见性"）；③ 存在性（"真在 DOM 里"）。②③ 的判据天生
 *        不是像素，全判红会制造**假红** —— 而假红的门禁下场是被关掉 ✗（下面 ④ 同理）；
 *      · 但"名字宣称可见、体内**既无真判据也无盲判据**"**不能只报告**：把一条合规断言里的
 *        rect 删干净、名字保留"可见"，它就从判红滑进只报告 ⇒ **守卫可被静默关掉** ✗。
 *    所以口径与 `DEBT` **完全一致**（封闭册）：
 *      · 在册 ⇒ 进 `nonVisual`（打印、计数可见，不判红）；
 *      · **不在册 ⇒ 判红**（新代码不许再写"连假装都没装"的可见性断言）；
 *      · 册上有、但那条断言**已经有判据 / 名字里没词了 / 被删了** ⇒ **判红**，逼人销账。
 *    本批 6 条全部逐条裁决过（`why` 写清为什么是数据语义，`todo` 写清怎么销账），
 *    其中 `52-详情渲染.js` 那条**如实记成"待裁决欠账"**（它的名字是界面宣称、判据却只有存在性）。
 *    ⚠️ 加条目必须在 `why` 里说明"为什么它是数据/文案语义"，抄一句"历史原因"不算说明。
 * --------------------------------------------------------------- */
const NONVISUAL_DEBT = [
  {
    rel: 'scripts/smoke/08-audit-palette.js',
    name: '命令面板：空查询时**只列命令**（节点不混入；命令必须在截断前可见 ✓）',
    why: '名字里的"可见"指**没有被 slice(0,50) 截断**（旧实现里 131 个节点占满前 50 名、命令全被截掉），'
      + '判据是 `#palette .palette-item` 的**项数与前 N 项的类别**（全是 DOM/数据读数）⇒ 数据语义，不是像素可见。',
    todo: '若哪天要判"命令真的在屏幕上、没被浮层盖住"，另加一条 elementFromPoint/scanRegion 的断言，'
      + '而不是把这条改成像素判据（它是"不被截断"的回归断言，换个判据就测不到那件事）。'
  },
  {
    rel: 'scripts/smoke/09-save-persistence.js',
    name: '保存：工具栏按钮存在且能把内存改动落盘（写后重读可见）',
    why: '名字里的"写后重读可见"指**重新读盘 / 重开项目还能看到那个改动**，判据是落盘后的数据比对'
      + '（`isDirty()` 归零 + 重读节点），与"屏幕上看得见"无关 ⇒ 数据语义。',
    todo: '无需迁判据；名字里的"可见"换成"可重读"会更不容易被误读，但那要改 `scripts/smoke/**.js`（本批禁区）。'
  },
  {
    rel: 'scripts/smoke/15-write-conflict.js',
    name: '变更可见性：界面保存也会记进变更日志（GUI 那条写路径与 CLI 共用同一份记账）',
    why: '名字里的"变更可见性"是**变更日志这个功能的名字**（`changes` 命令的台账），判据是'
      + '`log.changes` 最后一条的 `writer` / `changed` 字段 ⇒ 数据语义，不是界面可见。',
    todo: '同名歧义已在域 12 处理过一次（改名消歧）；这条同样可以改名，但要动 `scripts/smoke/**.js`。'
  },
  {
    rel: 'scripts/smoke/26-ai-ask.js',
    name: 'AI 问答：「问问AI」⇒ 输入行可用；问一句 ⇒ 流水里有"我的问题"与回答（桩标记可见）',
    why: '名字里的"桩标记可见"指**问答流水里那两段文本存在**（问题与回答都进了 DOM / 文本），'
      + '判据是 `.ask-input` 与流水文本的字符串包含 ⇒ 文本语义；浮层会不会被盖住由域 34/37 的命中测试覆盖。',
    todo: '若这条还要判"用户真看得见那个浮窗"，得另加一条像素 / 命中测试断言。'
  },
  {
    rel: 'scripts/smoke/38-ai-落盘.js',
    name: 'AI 落盘①：点「写入本节点详情」⇒ **盘上真的多了 qa 记录与详情**（不是只弹了个提示），来源标记可见',
    why: '名字里的"来源标记可见"指**盘上与状态条里出现了 `🤖 AI 问答` 这个标记**（区分'
      + '"真的落盘了"与"只弹了个提示"），判据是 detail 文本 + 状态条文案 ⇒ 数据语义。',
    todo: '同上：界面可见性不在这条的职责里。'
  },
  {
    rel: 'scripts/smoke/52-详情渲染.js',
    name: 'smoke-52 隔离判据（bug①：可见占位必须真的到用户眼前）：detail 里**只有一张被拦图**、',
    why: '⚠️ **这一条最可疑，如实记在册上**：名字写"可见占位必须真的到用户眼前"，而判据只有'
      + '"`.fd-img-blocked` 真在 DOM 里 + 文本含拦下" ⇒ 严格说是**界面宣称 + 存在性判据**。'
      + '它在册而不是判红，是因为本批**不许改** `scripts/smoke/**.js`（改名 / 加判据都要动那个文件）。',
    todo: '待裁决（下一批）：要么把名字收成"占位真进 DOM"（名字与判据对齐），要么给这条补 '
      + 'elementFromPoint / scanRegion 的像素判据。**在那之前它是欠账，不是合规**。'
  }
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
 * 判一条断言：返回 {judges, real, exempt, blind, emptyMark, verdict}
 * verdict ∈ 'ok'（有真判据）| 'exempt'（显式豁免，原因非空）| 'blind'（只有盲判据 ⇒ 违规候选）
 *         | 'nonvisual'（体内既无真判据也无盲判据 ⇒ 名字在宣称可见、**连假装都没装**）
 *
 * 两个视图分开看，是这道门禁能不能真判出东西的关键：
 *   · `code` —— 去注释 + 去名字串 + 展开同文件 JS 片段常量 ⇒ 判"有没有真判据 / 有没有盲判据"；
 *   · `raw`  —— 原样（含注释）⇒ 只用来认 `判据-豁免:` 标记（它本来就是写给人看的一句话 ✓）。
 *
 * ⑦ **写空的豁免标记不算豁免**（与 `V2` 的 `收尾-豁免:` 口径一致；口径由 `EXEMPT_RE` 的
 *   `[ \t]*` 保证 —— 它跨不过换行）。`emptyMark` 只为报文服务：让人看到"你写了标记但没写原因"，
 *   而不是对着一句"体内只有 getBoundingClientRect"猜自己做错了什么。
 */
function judgeAssertion(rawRegion, srcRaw) {
  const code = expandSnippets(judgeView(rawRegion), judgeView(srcRaw));
  const judges = REAL_JUDGES.filter((j) => code.indexOf(j.token) >= 0);
  const blind = BLIND_JUDGES.filter((j) => code.indexOf(j.token) >= 0);
  const ex = EXEMPT_RE.exec(rawRegion);
  const exempt = ex ? ex[1].trim() : null;
  const emptyMark = !exempt && EMPTY_EXEMPT_RE.test(rawRegion);
  if (judges.length) return { judges, real: judges, exempt, blind, emptyMark, verdict: 'ok' };
  if (exempt) return { judges, real: [], exempt, blind, emptyMark, verdict: 'exempt' };
  if (blind.length) return { judges, real: [], exempt: null, blind, emptyMark, verdict: 'blind' };
  return { judges, real: [], exempt: null, blind, emptyMark, verdict: 'nonvisual' };
}

/** 判定①…⑦ 的纯函数形态：吃 `[{rel, src}]`，吐清单（不打印、不退出 ⇒ 可被单测 require）
 *
 *  **册子怎么选**（这条约定必须写清，否则夹具会被生产册判成"悬挂欠账"）：
 *    · `debt` 传 `null`/不传 ⇒ 走生产册（`DEBT` + `NONVISUAL_DEBT`）—— 生产路径只走这一条；
 *    · `debt` **显式传数组**（含 `[]`）⇒ 视为"夹具驱动"，两本册都置空，
 *      要测在册行为请用 `opts.nonVisualDebt` / `debt` 自己给一份；
 *    · `opts.minTriggered` / `opts.nonVisualDebt` 只给单测改（小样例凑不满下限、也碰不到生产册；
 *      生产路径一律用 `MIN_TRIGGERED` 与 `NONVISUAL_DEBT` ✗）。 */
function analyze(files, debt, opts) {
  const fixtureDriven = debt != null;                 // 显式给了 debt ⇒ 这是夹具，不套生产册
  const debtIn = debt || DEBT;
  const minTriggered = (opts && typeof opts.minTriggered === 'number') ? opts.minTriggered : MIN_TRIGGERED;
  const nonVisualDebtIn = (opts && Array.isArray(opts.nonVisualDebt)) ? opts.nonVisualDebt
    : (fixtureDriven ? [] : NONVISUAL_DEBT);
  const judged = [];      // 有真判据（或显式豁免）
  const debts = [];       // 在册欠账（`DEBT`，只有盲判据）
  const problems = [];    // 不在册的违规 ⇒ 判红（`blind` 与 `nonvisual` 两类都进这里）
  const nonVisual = [];   // 在册的"无判据"欠账（`NONVISUAL_DEBT`）：计数可见、不判红
  const emptyMarks = [];  // 写了 `判据-豁免:` 却没写原因的断言（不算豁免，只用来点名）
  let assertions = 0, triggered = 0;

  const used = new Set();
  const usedNv = new Set();

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
        emptyMark: !!j.emptyMark,
        blind: j.blind.map((x) => x.token + '（' + x.kind + '）')
      };
      if (row.emptyMark) emptyMarks.push(row);
      if (j.verdict === 'ok' || j.verdict === 'exempt') { judged.push(row); continue; }
      /* ⚠️ 缝 (b) 的收口点（2026-10-20）：`'nonvisual'` **不再**"只报告就放过"。
       *   修前这一档的动作只有两件：把这一行推进 `nonVisual` 数组、然后 `continue` ——
       *   那个数组**不参与 `ok` 判定** ⇒ 把一条合规断言里的盲判据删干净、名字保留"可见"，
       *   就从判红滑进只报告。**原文不在此处抄一遍**：`tests/visibility-judge.test.js`
       *   有一条用例断言那段原文"不在了"，抄进来会让它自己判红（实测踩到过一次）。
       *   现在：在封闭册上 ⇒ 进 `nonVisual`（打印 + 计数，欠账可见）；
       *         不在册 ⇒ 进 `problems` ⇒ **判红**（连假装都没装的可见性宣称）。 */
      if (j.verdict === 'nonvisual') {
        const nvHit = nonVisualDebtIn.find((d) => d.rel === f.rel && d.name === a.name);
        if (nvHit) {
          usedNv.add(nvHit);
          nonVisual.push(Object.assign({ why: nvHit.why, fix: nvHit.todo }, row));
        } else problems.push(row);
        continue;
      }
      // 'blind' ⇒ 违规候选：看它在不在既有欠账册里
      const hit = debtIn.find((d) => d.rel === f.rel && d.name === a.name);
      if (hit) { used.add(hit); debts.push(Object.assign({ why: hit.why, fix: hit.fix }, row)); }
      else problems.push(row);
    }
  }

  // 两本册的封闭性：册上有、但**已经不是那个违规**（修好了 / 名字没了）⇒ 判红，逼人销账
  const staleDebt = debtIn.filter((d) => !used.has(d))
    .map((d) => ({ rel: d.rel, name: d.name, why: d.why, fix: d.fix, book: 'DEBT' }))
    .concat(nonVisualDebtIn.filter((d) => !usedNv.has(d))
      .map((d) => ({ rel: d.rel, name: d.name, why: d.why, fix: d.todo, book: 'NONVISUAL_DEBT' })));

  const scansOk = files.length > 0 && assertions > 0;
  const floorOk = triggered >= minTriggered;
  return {
    /* ⚠️ 这条 `ok` 表达式是**判定②③的最终口径**：`problems` 里现在**同时**装着
     * `blind`（只有盲判据）与 `nonvisual`（连判据都没有）两类 ⇒ `nonVisual` 不再能绕过它。
     * 修前 `'nonvisual'` 只进一个不参与 `ok` 的数组 ⇒ **守卫可被静默关掉**（缝 (b)）。 */
    ok: problems.length === 0 && staleDebt.length === 0 && scansOk && floorOk,
    files: files.length, assertions, triggered, minTriggered,
    scansOk, floorOk, judged, debts, problems, nonVisual, emptyMarks, staleDebt,
    nonVisualDebtCount: nonVisualDebtIn.length
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

  /* ---- 2026-10-20：两条"可静默关掉守卫"的缝，各给一条注入证明（每次跑 `--selftest` 都重放）----
   * 为什么要专门加这两步：这两条缝的**共同特征**是"改了源码但门禁照样 exit 0" ——
   * 只靠"现在仓库是绿的"证明不了它们已经收口，必须有"注入 ⇒ 必红"的读数。 */
  step('注入 3（缝 a）：`判据-豁免:` 后**不写原因**、断言只有 rect ⇒ 必须判红（不算豁免）', (function () {
    const src = [
      'module.exports = [',
      '  {',
      "    name: '圆钮可见',",
      '    run: async (ctx) => {',
      '      // 判据-豁免: ',
      "      const r = await ctx.exec('el.getBoundingClientRect()');",
      '      return { ok: r.width > 8 };',
      '    }',
      '  }',
      '];',
      ''
    ].join('\n');
    const r3 = analyze([{ rel: 'scripts/smoke/99-selftest-probe.js', src }], [], { minTriggered: 1 });
    return r3.problems.length === 1 && r3.judged.length === 0;
  })(), '修前：那个空标记会吞掉下一行代码当原因 ⇒ verdict=exempt ⇒ 照样绿 ✗（与 V2 的 `收尾-豁免:` 口径不一致）');

  step('注入 4（缝 b）：抹掉真判据 **且体内连盲判据都没有** ⇒ 必须判红（不再降级成"只报告"）', (function () {
    const src = [
      'module.exports = [',
      '  {',
      "    name: '圆钮可见',",
      '    run: async (ctx) => {',
      "      const hit = await ctx.exec('document.elementFromPoint(cx, cy).id');",
      '      return { ok: hit === "n1" };',
      '    }',
      '  }',
      '];',
      ''
    ].join('\n');
    const r4 = analyze([{ rel: 'scripts/smoke/99-selftest-probe.js', src: zeroRealJudges(src) }], [], { minTriggered: 1 });
    return r4.problems.length === 1 && r4.problems[0].verdict === 'nonvisual';
  })(), '修前：它落进 `nonvisual`（只报告）而 `ok` 表达式看不见那个数组 ⇒ 把 rect 删干净就能静默关掉守卫 ✗');

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
    console.log('== 欠账清单（两本封闭册：`DEBT` 盲判据欠账 / `NONVISUAL_DEBT` 无判据欠账；只减不增）==');
    if (!r.debts.length && !r.nonVisual.length && !r.staleDebt.length) console.log('  （空 —— 已全部迁完 ✓）');
    for (const d of r.debts) {
      console.log('  · [DEBT] ' + d.rel + ':' + d.line + '　' + d.name);
      console.log('      现在用的判据：' + d.blind.join('、'));
      console.log('      为什么是欠账：' + d.why);
      console.log('      怎么迁：' + d.fix);
    }
    for (const d of r.nonVisual) {
      console.log('  · [NONVISUAL_DEBT] ' + d.rel + ':' + d.line + '　' + d.name);
      console.log('      体内**既无真判据也无盲判据**（名字在宣称可见，连假装都没装）');
      console.log('      为什么仍算数据语义：' + d.why);
      console.log('      怎么销账：' + d.fix);
    }
    for (const d of r.staleDebt) {
      console.log('  ⚠ 已在册但**已不构成违规**（销账未清 ⇒ 判红）：[' + d.book + '] ' + d.rel + '　' + d.name);
    }
    console.log('');
    console.log('  在册 ' + (r.debts.length + r.nonVisual.length) + ' 条（DEBT ' + r.debts.length
      + ' + NONVISUAL_DEBT ' + r.nonVisual.length + '）；触发 ' + r.triggered + ' 条；'
      + '有真判据 ' + r.judged.length + ' 条');
    process.exitCode = r.staleDebt.length ? 1 : 0;
    return;
  }

  console.log('== 可见性判据门禁（V1）==');
  console.log('  扫描 ' + r.files + ' 个冒烟域文件、' + r.assertions + ' 条断言；'
    + '名字声称可见性的 ' + r.triggered + ' 条（下限 ' + r.minTriggered + '）');
  console.log('    · 有真判据（命中测试 / 真帧像素）：' + r.judged.filter((x) => x.verdict === 'ok').length + ' 条');
  console.log('    · 显式豁免（`判据-豁免:`，原因非空才算）：' + r.judged.filter((x) => x.verdict === 'exempt').length + ' 条');
  console.log('    · 既有欠账（在册，只减不增）：' + r.debts.length + ' 条');
  console.log('    · 新违规：' + r.problems.length + ' 条'
    + (r.problems.length ? '（只有盲判据 ' + r.problems.filter((p) => p.verdict === 'blind').length
      + ' / 连判据都没有 ' + r.problems.filter((p) => p.verdict !== 'blind').length + '）' : ''));
  console.log('    · 名字含词、体内**既无真判据也无盲判据**：' + r.nonVisual.length + ' 条在册（只报告，只减不增；'
    + '册上 ' + r.nonVisualDebtCount + ' 条 —— 不在册的**判红**，见 2026-10-20 的缝 (b)）');
  if (r.emptyMarks.length) {
    /* 空标记**逐个点名**：它可能落在任何一档（有真判据 / 有豁免 / 已判红 / 在册），
     * 只说"N 条"而不说是哪几条，读者就得自己去猜 —— 那正好是这条缝当初能藏住的原因 ✗。 */
    console.log('    · 写空的豁免标记（`判据-豁免:` 后无原因 ⇒ **不算豁免**，口径同 V2 的 `收尾-豁免:`）：'
      + r.emptyMarks.length + ' 条');
    r.emptyMarks.forEach((m) => console.log('        ⚠ ' + m.rel + ':' + m.line + '　' + m.name
      + '（按它自己的判据判定：' + m.verdict + '）'));
  }

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
    show('[无判据·在册]', r.nonVisual);
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
  /* ⚠️ 两类违规的报文分开写（`R1d`：拒绝要响亮、要点名**这一条为什么错**）：
   *   · `blind`      —— 有判据，但对裁切与遮挡是盲的（事故那一类）；
   *   · `nonvisual`  —— **连判据都没有**，比上一类更可疑：名字在宣称可见，什么都没装。
   *   修前 `nonvisual` 落在"只报告"档 ⇒ 删干净盲判据就能把守卫静默关掉（缝 (b)）。 */
  const blindProblems = r.problems.filter((p) => p.verdict === 'blind');
  const noJudgeProblems = r.problems.filter((p) => p.verdict !== 'blind');
  const emptyMarkNote = (p) => {
    if (!p.emptyMark) return '';
    return '\n      ⚠ 它上面那行 `判据-豁免:` **后面没有写原因** ⇒ 不算豁免（豁免原因不能为空；'
      + '口径与 V2 的 `收尾-豁免:` 一致：原因必须与冒号同行、非空白）';
  };
  if (blindProblems.length) {
    bad = true;
    console.error('✗ 有 ' + blindProblems.length + ' 条断言在名字里声称"可见/看不见"，判据却是对裁切与遮挡是盲的：');
    for (const p of blindProblems) {
      console.error('  ✗ ' + p.rel + ':' + p.line + '　' + p.name);
      console.error('      原因：体内只有 ' + (p.blind.join('、') || '（无）')
        + ' —— 这些读不出"用户看不看得见"（实测：被父元素 overflow:hidden 裁掉时 rect 读数与正常显示**完全相同**）'
        + emptyMarkNote(p));
      console.error('      修法：二选一 —— ① 加真判据：对元素中心做 `document.elementFromPoint` 断言命中自身'
        + '（抓遮挡），或对它的矩形做 `scanRegion` 数像素并给阈值（抓裁切，见 scripts/vision/frame-stats.js）；'
        + '② 若这条确实只需 rect，在断言上方写一行 `判据-豁免: <原因>`（**原因不能为空**）。');
      console.error('      （"可点"那半可以用真输入 `ctx.input.*` 单独判 —— 但它不判可见，可见那半仍需像素或命中测试）');
    }
  }
  if (noJudgeProblems.length) {
    bad = true;
    console.error('✗ 有 ' + noJudgeProblems.length + ' 条断言在名字里声称"可见/看不见"，体内却'
      + '**既没有真判据、也没有盲判据** —— 这比"只用了 rect"更可疑：连假装都没装：');
    for (const p of noJudgeProblems) {
      console.error('  ✗ ' + p.rel + ':' + p.line + '　' + p.name);
      console.error('      原因：体内找不到任何可视判据（`判据-豁免:` 不算判据，写空的标记也不算）'
        + emptyMarkNote(p));
      console.error('      修法：三选一 —— ① 加真判据（`elementFromPoint` 命中自身 / `scanRegion` 数真帧像素）；'
        + '② 名字里**别声称可见**（若它判的是数据/文案语义，改名就是正确答案 —— 名字是本门禁的输入）；'
        + '③ 确属数据语义、又暂时不能改名 ⇒ 在 `scripts/visibility-judge-check.js` 的 `NONVISUAL_DEBT` 里'
        + '登记（逐条写 `why` + `todo`，**只减不增**，并在 CHANGELOG 留一笔）。'
        + '⚠️ 不许把守卫"关掉"：这一档以前是只报告、不判红，2026-10-20 起判红 ✗');
    }
  }
  if (r.staleDebt.length) {
    bad = true;
    console.error('✗ 欠账册里有 ' + r.staleDebt.length + ' 条**已经不是那个违规**了（销账未清 ⇒ 判红，欠账只减不增）：');
    for (const d of r.staleDebt) {
      console.error('  ✗ [' + d.book + '] ' + d.rel + '　' + d.name);
      console.error('      修法：删掉 scripts/visibility-judge-check.js 里 ' + d.book + ' 的这条（它已经修好了 / '
        + '名字变了 / 断言被删了 ⇒ 请把册上的名字改成现状，或直接销账）');
    }
  }

  if (bad) {
    console.error('\nvisibility-judge-check 失败（可见性判据门禁 V1）');
    console.error('欠账与修法一览：`node scripts/visibility-judge-check.js --debt`');
    process.exit(1);
  }
  console.log('  ✓ 声称可见性的断言都给了真判据（或有显式豁免、或在封闭欠账册上）；'
    + '在册欠账 ' + r.debts.length + ' + ' + r.nonVisual.length + ' 条（未新增）');
  console.log('\nvisibility-judge-check 通过');
}

module.exports = {
  VIS_WORDS, REAL_JUDGES, BLIND_JUDGES, EXEMPT_RE, EMPTY_EXEMPT_RE, DEBT, NONVISUAL_DEBT, MIN_TRIGGERED,
  SMOKE_REL, SMOKE_ABS,
  sliceStatement, constSource, expandSnippets, visibilityWordsIn,
  stripComments, judgeView,
  findAssertions, backwardRegionStart, judgeAssertion, analyze, loadSmokeFiles, selftest,
  zeroRealJudges
};

if (require.main === module) main();
