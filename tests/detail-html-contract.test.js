/* ============================================================
 * tests/detail-html-contract.test.js — `R7-0` 三件的**结构断言**（与"真帧/真鼠标"那一半配成对）
 * 运行：npx vitest run tests/detail-html-contract.test.js
 * ------------------------------------------------------------
 * 本文件守的是三件**契约**，每件都配一条冒烟真判据（`scripts/smoke/47-detail-html-links.js`）：
 *
 *  ① **`detail` 的渲染契约 = HTML 优先**（`docs/DATA-FORMAT.md` §2.4.1）：
 *     正文的**唯一**落点是 `renderer/app-detail-content.js` 的 `dc.innerHTML = detail`。
 *     ✗✗ 一旦有人把它改成"一律走 `markdownToHtml`"（`src/convert.js`：**先整体转义**再套行内语法），
 *     既有 HTML 节点的标签会**显示成一堆字面量** —— 既有语料的规模**现算**：
 *     `node scripts/detail-census.js comnet`（**不许把数写死**：同一份文件工作区与 git HEAD
 *     就是两个真值，实测 2026-10-16 工作区 753 个含 detail 节点 / git HEAD 450 个；
 *     工程文档里一度出现的 "133" 是错的 —— 见 `.review/20261016-R7设计核查/`），
 *     ⇒ 那是**一次性砸掉这些节点的呈现**，本工程最重的损害类。
 *     ⇒ 断言（剥注释后按**实现形状**扫）：该模块里**零** `markdownToHtml` / `mdBlock` / `mdInline`
 *     调用，且"detail 注入 innerHTML"那一跳必须在。
 *
 *  ② **笔记链接配色是单源的**（`docs/DATA-FORMAT.md` §2.4.2）：
 *     约定色（琥珀）+ **显式 `text-decoration: none`**（UA 默认就是下划线，只改色等于只解决一半），
 *     且**普通链接保持浏览器默认**（`renderer/style.css` 里不许出现给裸 `a` 定样式的规则 ——
 *     一旦加了，"普通链接 = UA 蓝 + 常驻下划线"这条约定就被顺带改掉了，而没人会注意到）。
 *
 *  ③ **"点开一条站内链接"只有一处实现**（`renderer/app-actions.js` 的 `MM.followNodeRef`）：
 *     同项目 ⇒ 选中 + 展开祖先链 + **滚到目标节点**（已在视口内则不动视野）、**不切项目**；
 *     跨项目 ⇒ 既有 `switchProject`。
 *     ★历史事故（`docs/RULES.md` 的 R5 行）：同项目链接**一律**走 `switchProject`，而它开头就
 *     `name === state.project.name → return` ⇒ **点了毫无反应**，实测 `comnet` **47 条全是死链**。
 *     当时的处置是删掉那一行；于是"同项目要能跳"变成各调用点**各抄一份**（媒体/关联两处同形），
 *     且都**没有**把目标带进视野 ⇒ 目标在视野外时点一下仍然像没反应 ✗。本文件把"只有一处实现、
 *     两个链接面都不许自己写分支"钉成结构断言。
 *
 * 判别力（**判据自己先被注入打红**，逐条都在下面的用例里，含"注入后必须变红"的期望）：
 *   · 把 `dc.innerHTML = detail` 换成"转义后再注入"（等价于走 markdownToHtml 的后果）⇒ ① 必红；
 *   · 删掉 `.fd-notelink` 的 `text-decoration: none`（或在别处再写一遍色值）⇒ ② 必红；
 *   · 把某个链接面改回"同项目就 selectNode / 否则 switchProject"手抄分支 ⇒ ③ 必红。
 *   ⚠️ 这三条是**合成注入**（在字符串上注入，不动仓库文件）；真机判别力证明（改产品代码那一轮 +
 *   逐字节还原 + SHA-256）由冒烟域 47 在交付说明里给出 —— 两者分工：这里守"形状"，那边守"画面"。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 剥注释（块 + 行）——**扫描面必须先剥注释**：注释里写一句示例调用**不是实现**
 *  （本工程实测踩过：一条判据把注释里的示例当成"第二份实现"判红，修的人照着注释改又被判一次 ✗）。
 *  代价如实说：剥注释会漏掉"只在注释里复制了一份实现"这种退化情形（价值低 ✓）。 */
export function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/* ================= ① detail = HTML 优先 ================= */

/** **扫描面**与被钉的对象一起声明（缺了它就不是合格的结构断言）：
 *  正文渲染的唯一实现文件。新增第二个渲染点时**必须**改这里，而不是在断言里临时拼路径。 */
export const DETAIL_RENDER_MODULES = ['renderer/app-detail-content.js'];

/** 会**转义裸 HTML** 的那一族（`src/convert.js` 的 markdownToHtml 与它的两个渲染口）——
 *  正文渲染路径里出现任何一个都等于"把既有 HTML 节点砸成字面标签"的风险回来了。 */
const MD_CONVERTER_NEEDLES = ['markdownToHtml', 'mdBlock', 'mdInline'];

/**
 * 判据：正文渲染模块**把 detail 裸注入 `innerHTML`**，且**不碰** Markdown 转换器。
 * ⚠️ "裸注入"是**契约的字面形态**（`docs/DATA-FORMAT.md` §2.4.1）：`detail` 作为**值**直接交给
 * `innerHTML`，不改、不转、不拼。**改了这一跳就等于改了渲染契约** —— 那必须**同批**改这条断言、
 * 在变更日志里说明"为什么不再需要裸注入"（`R7` 主体的消毒/路径选择属于这种改动），
 * 而不是让它静静地松掉 ✗。
 * @param {string} src 源码（本函数自己剥注释）
 * @returns {{ok:boolean, hits:string[], hasHtmlInjection:boolean, reason:string}}
 */
export function checkDetailHtmlContract(src) {
  const code = stripComments(src);
  const hits = MD_CONVERTER_NEEDLES.filter((n) => code.indexOf(n) >= 0);
  const hasHtmlInjection = /innerHTML\s*=\s*detail\b/.test(code);
  const ok = hits.length === 0 && hasHtmlInjection;
  return {
    ok: ok, hits: hits, hasHtmlInjection: hasHtmlInjection,
    reason: ok ? '' : (hits.length
      ? '正文渲染模块里出现了 Markdown 转换器调用：' + hits.join(', ')
        + '（它会把裸 HTML 转义 ⇒ 既有 HTML 节点的标签会变成一堆字面量。'
        + '受影响规模**现算**：跑 node scripts/detail-census.js comnet，别写死数）'
      : '找不到"把 detail **裸注入** innerHTML"那一跳（正文的 HTML 优先路径不见了 —— '
        + '若这是有意的契约升级，请同批更新本断言并说明理由）')
  };
}

describe('① detail 的渲染契约 = HTML 优先（结构断言）', () => {
  it('正文渲染模块：零 Markdown 转换器调用 + 保留 detail→innerHTML 那一跳', () => {
    for (const rel of DETAIL_RENDER_MODULES) {
      const r = checkDetailHtmlContract(read(rel));
      expect(r.ok, rel + '：' + r.reason).toBe(true);
      expect(r.hasHtmlInjection, rel + '：HTML 注入那一跳必须在').toBe(true);
    }
  });

  it('扫的是**剥注释后**的实现（注释里的示例写法不算实现）', () => {
    const fake = '/* 示例：dc.innerHTML = markdownToHtml(detail) 这样写是错的 */\n'
      + 'dc.innerHTML = detail || "";\n';
    expect(checkDetailHtmlContract(fake).ok).toBe(true);
  });

  /* ---- 规模**现算**：不写死数，而是现读真语料，判"既有 detail 确实是 HTML" ----
   * 这一段替代了原先写死的 "133 个含 detail 节点"（错数 + 天生会漂，见文件头 ①）。
   * 取值走 `scripts/detail-census.js --json`（**唯一口径**：节点 = `data` 根对象递归 `children`；
   * "含标签" = 命中白名单标签正则），本文件**不自己再写一份遍历** —— 那就是第二份会漂的实现 ✗。
   * 断言的是**性质**（绝大多数既有 detail 含 HTML 标签 ⇒ "一律走 markdownToHtml" 真的会砸掉用户内容），
   * **不是任何具体数字** ⇒ 并发写入让 comnet 从 450 涨到 753 也不会误红 ✓。
   * 真语料读不到（项目被删/在写/JSON 半截）⇒ 如实**跳过并把原因打出来**，不静默假装通过。 */
  const CENSUS_SCRIPT = 'scripts/detail-census.js';
  const CENSUS_PROJECT = 'comnet';
  const censusProbe = (() => {
    try {
      const out = execFileSync(process.execPath,
        [path.join(ROOT, CENSUS_SCRIPT), '--json', CENSUS_PROJECT],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const row = (JSON.parse(out).rows || [])[0];
      if (!row) return { err: '脚本没给出 ' + CENSUS_PROJECT + ' 的行' };
      return { row: row };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  })();

  it('口径的**唯一实现**在 scripts/detail-census.js（本文件不许再写一份遍历/白名单）', () => {
    const src = read('tests/detail-html-contract.test.js');
    // "按白名单标签正则扫 detail" 这件事只许出现在那个脚本里
    expect(src, '本文件出现了自写的白名单标签正则 —— 请改用 scripts/detail-census.js 的口径')
      .not.toMatch(/h1\|h2\|h3|h\[1-6\]\|p\|br/);
    expect(src).toContain(CENSUS_SCRIPT);
  });

  it.skipIf(!!censusProbe.err)(
    '既有语料：' + CENSUS_PROJECT + ' 的含 detail 节点**绝大多数含 HTML 标签**（规模现算，数字不写死）',
    () => {
      const r = censusProbe.row;
      // 先判"取到的是真语料"：一个 detail 都没有 ⇒ 采不到真值（不是"通过"）
      expect(r.withDetail, CENSUS_PROJECT + ' 一个含 detail 的节点都没有 ⇒ 采不到真值，'
        + '这条不是通过（项目被清空？还是读错了文件？）').toBeGreaterThan(0);
      const ratio = r.tagged / r.withDetail;
      expect(ratio, '含白名单标签的比例只有 ' + (ratio * 100).toFixed(1) + '%（'
        + r.tagged + '/' + r.withDetail + '）⇒ "既有 detail 是 HTML"这条前提不成立了：'
        + '"一律走 markdownToHtml" 不再必然砸掉用户内容，本契约的前提要重新论证')
        .toBeGreaterThan(0.9);
    });
  if (censusProbe.err) {
    // 跳过原因必须可见（静默跳过 = 假绿）
    // eslint-disable-next-line no-console
    console.warn('⚠️ 规模现算这条被跳过：' + censusProbe.err);
  }

  it('判别力：把注入那一跳改成"转义后再注入"（= 走 markdownToHtml 的后果）⇒ 必红', () => {
    const real = read(DETAIL_RENDER_MODULES[0]);
    // 注入点就是产品真正会走的那一跳：唯一渲染点那一行
    const bad = real.replace('dc.innerHTML = detail ||', 'dc.innerHTML = markdownToHtml(detail) ||');
    expect(bad, '注入没打中那一跳（源码形状变了？）——注入打不中就是空转门禁').not.toBe(real);
    const r = checkDetailHtmlContract(bad);
    expect(r.ok).toBe(false);
    expect(r.hits).toContain('markdownToHtml');
  });

  it('判别力：把 detail 注入那一跳整行抹掉（正文不再由 detail 注入）⇒ 必红', () => {
    const real = read(DETAIL_RENDER_MODULES[0]);
    const bad = real.replace(/dc\.innerHTML\s*=\s*detail[^;]*;/, 'dc.textContent = detail;');
    expect(bad).not.toBe(real);
    expect(checkDetailHtmlContract(bad).ok).toBe(false);
  });

  it('判别力：把"裸注入"改成"先转义再注入"（手写转义也算 —— 后果与走 markdownToHtml 一样）⇒ 必红', () => {
    const real = read(DETAIL_RENDER_MODULES[0]);
    const bad = real.replace('dc.innerHTML = detail ||',
      'dc.innerHTML = String(detail).replace(/[<]/g, \'&lt;\') ||');
    expect(bad).not.toBe(real);
    const r = checkDetailHtmlContract(bad);
    expect(r.ok).toBe(false);
    expect(r.hasHtmlInjection).toBe(false);
  });
});

/* ================= ② 笔记链接配色 ================= */

const STYLE = 'renderer/style.css';
/** 约定色（`docs/DATA-FORMAT.md` §2.4.2 与设计稿 §⑪-4.2 的 A 档）——**只有这里写一次**，
 *  产品侧的唯一副本在 `renderer/style.css` 的 `--note-link-ink`（断言：恰好 1 处）。 */
export const NOTE_LINK_INK = '#8a6a00';
const VAR_NAME = '--note-link-ink';

/**
 * 判据：约定色单源 + `.fd-notelink` 显式去下划线 + 普通链接仍是浏览器默认。
 * @param {string} css `renderer/style.css` 全文
 * @returns {{ok:boolean, inkLines:number, inkCount:number, varDefs:number, reasons:string[]}}
 */
export function checkNoteLinkCss(css) {
  const reasons = [];
  const text = String(css);
  const lines = text.split(/\r?\n/);
  const inkLines = lines.filter((l) => l.indexOf(NOTE_LINK_INK) >= 0).length;
  const inkCount = (text.match(new RegExp(NOTE_LINK_INK, 'g')) || []).length;
  // 颜色变量：定义处只许一处（`--note-link-ink:` 后面跟着值）
  const varDefs = (text.match(new RegExp(VAR_NAME + '\\s*:', 'g')) || []).length;
  if (inkLines !== 1 || inkCount !== 1) {
    reasons.push('约定色必须**单源**：本文件里它出现在 ' + inkLines + ' 行 / ' + inkCount + ' 次'
      + '（要求各 1）—— 第二份副本一定会漂');
  }
  if (varDefs !== 1) reasons.push('颜色变量 `' + VAR_NAME + '` 的定义处 = ' + varDefs + ' 处（要求 1）');

  // `.fd-notelink` 的规则块
  const rule = text.match(/\.fd-notelink\s*\{[^}]*\}/);
  if (!rule) reasons.push('找不到 `.fd-notelink { … }` 规则（笔记链接没有专属样式）');
  else {
    if (rule[0].indexOf('var(' + VAR_NAME + ')') < 0) {
      reasons.push('`.fd-notelink` 的 color 必须用 `var(' + VAR_NAME + ')`（不许再写一遍色值）');
    }
    if (!/text-decoration\s*:\s*none/.test(rule[0])) {
      reasons.push('`.fd-notelink` **必须显式写 `text-decoration: none`**'
        + '（UA 默认就是下划线：只改配色等于只解决了一半）');
    }
  }

  // 普通链接 = 浏览器默认：本文件不许给裸 `a` 定样式
  const bareA = /(^|[\s,{}])(a|a:hover|a:visited|a:link|a:active|a:focus)\s*[,{]/;
  const bareMix = /(^|[\s,])(a|a:hover|a:visited|a:link|a:active)\s*[,{]/;
  if (bareA.test(text) || bareMix.test(text)) {
    reasons.push('本文件出现了给裸 `a` 定样式的规则 ⇒ "普通链接 = 浏览器默认蓝 + 常驻下划线"'
      + '这条约定被顺带改掉了（它是判据③的对照组）');
  }
  return { ok: reasons.length === 0, inkLines: inkLines, inkCount: inkCount, varDefs: varDefs, reasons: reasons };
}

describe('② 笔记链接配色约定（单源 + 显式去下划线 + 普通链接不动）', () => {
  it('约定色恰好 1 处、变量恰好 1 个定义、`.fd-notelink` 显式 text-decoration:none、裸 a 无规则', () => {
    const r = checkNoteLinkCss(read(STYLE));
    expect(r.reasons, 'CSS 契约不成立：' + r.reasons.join(' ｜ ')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.inkLines).toBe(1);
    expect(r.inkCount).toBe(1);
  });

  it('判别力：删掉 `text-decoration: none`（只解决一半）⇒ 必红', () => {
    const bad = read(STYLE).replace('.fd-notelink { color: var(--note-link-ink); text-decoration: none; }',
      '.fd-notelink { color: var(--note-link-ink); }');
    expect(bad).not.toBe(read(STYLE));
    const r = checkNoteLinkCss(bad);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('text-decoration');
  });

  it('判别力：在别处再写一遍同一个色值（第二份副本）⇒ 必红', () => {
    const real = read(STYLE);
    const bad = real.replace('.fd-notelink { color: var(--note-link-ink);',
      '.fd-notelink { color: ' + NOTE_LINK_INK + ';');
    expect(bad).not.toBe(real);
    const r = checkNoteLinkCss(bad);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('单源');
  });

  it('判别力：给裸 `a` 加一条颜色规则（普通链接被改样）⇒ 必红', () => {
    const real = read(STYLE);
    const r = checkNoteLinkCss(real + '\na { color: #1664ff; }\n');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('裸 `a`');
  });
});

/* ================= ③ 站内链接跳转只有一处实现 ================= */

const LINK_SURFACES = ['renderer/app-media.js', 'renderer/app-assoc.js'];
const ACTIONS_MODULE = 'renderer/app-actions.js';
const VIEW_MODULE = 'renderer/app-view.js';

/**
 * 判据：一处实现 + 调用面只接线。
 * @param {object} files { [相对路径]: 源码 }
 * @returns {{ok:boolean, reasons:string[], reads:object}}
 */
export function checkNodeRefLinkWiring(files) {
  const reasons = [];
  const acts = stripComments(files[ACTIONS_MODULE] || '');
  const view = stripComments(files[VIEW_MODULE] || '');
  const reads = {};
  const n = (s, re) => (s.match(re) || []).length;

  // 唯一实现：定义恰好一处 + 导出恰好一处
  reads.followDefs = n(acts, /function\s+followNodeRef\s*\(/g);
  reads.followExports = n(acts, /MM\.followNodeRef\s*=/g);
  if (reads.followDefs !== 1) reasons.push('`function followNodeRef(` 在 ' + ACTIONS_MODULE
    + ' 里出现 ' + reads.followDefs + ' 次（要求 1 —— 站内链接跳转只许一处实现）');
  if (reads.followExports !== 1) reasons.push('`MM.followNodeRef =` 出现 ' + reads.followExports + ' 次（要求 1）');
  // 同项目那一支：选中（既有 jumpToNode）+ 滚到目标（既有 centerOnNode），且不许切项目
  reads.sameProjectBranch = /jumpToNode\(id\)/.test(acts) && /MM\.centerOnNode\(/.test(acts);
  if (!reads.sameProjectBranch) reasons.push('`followNodeRef` 里看不到"选中（jumpToNode）+ '
    + '滚到目标（MM.centerOnNode）"这一对（同项目那一支必须两件都做）');
  // 滚动那一处实现：节点级化后 `centerOnRoot` 只是它的一档（否则又成了两处平移算法）
  reads.centerDefs = n(view, /function\s+centerOnNode\s*\(/g);
  reads.centerExport = n(view, /MM\.centerOnNode\s*=/g);
  reads.rootDelegates = /function\s+centerOnRoot\s*\(\s*\)\s*\{[^}]*centerOnNode\(/.test(view);
  if (reads.centerDefs !== 1) reasons.push('`function centerOnNode(` 出现 ' + reads.centerDefs + ' 次（要求 1）');
  if (reads.centerExport !== 1) reasons.push('`MM.centerOnNode =` 出现 ' + reads.centerExport + ' 次（要求 1）');
  if (!reads.rootDelegates) reasons.push('`centerOnRoot()` 必须委托给 `centerOnNode`（同一个实现，'
    + '不许留下第二套平移算法）');
  // 调用面：只接线，不许自己写分支（尤其不许自己调 switchProject）
  LINK_SURFACES.forEach((rel) => {
    const code = stripComments(files[rel] || '');
    const calls = n(code, /MM\.followNodeRef\(/g);
    const sw = n(code, /switchProject\(/g);
    reads[rel] = { calls: calls, switchProject: sw };
    if (calls < 1) reasons.push(rel + ' 没有走 `MM.followNodeRef(`（链接跳转必须只有一处实现）');
    if (sw !== 0) reasons.push(rel + ' 里出现了 ' + sw + ' 处 `switchProject(` —— 调用点又在自己写'
      + '同项目/跨项目分支了（跨项目那一跳只许在 followNodeRef 里）');
  });
  return { ok: reasons.length === 0, reasons: reasons, reads: reads };
}

describe('③ "点开一条站内链接"只有一处实现（同项目不切项目）', () => {
  const files = {};
  [ACTIONS_MODULE, VIEW_MODULE].concat(LINK_SURFACES).forEach((rel) => { files[rel] = read(rel); });

  it('唯一实现 + 两个链接面只接线（结构读数）', () => {
    const r = checkNodeRefLinkWiring(files);
    expect(r.reasons, '接线不成立：' + r.reasons.join(' ｜ ')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('`switchProject` 的同项目早退**还在**（它的语义没被顺手改掉）', () => {
    const code = stripComments(read(ACTIONS_MODULE));
    const head = code.indexOf('function switchProject(');
    expect(head, '找不到 switchProject 的函数头（形状变了？）').toBeGreaterThanOrEqual(0);
    const body = code.slice(head, head + 400);
    expect(body, 'switchProject 开头必须仍是"同项目直接 return"—— 那条早退正是死链的根因，'
      + '要改它得连带处置所有调用点（本条只保证"站内链接不再走它"）')
      .toContain('state.project.name');
    expect(body).toContain('return');
  });

  it('判别力：把链接面改回"同项目 selectNode / 否则 switchProject"手抄分支 ⇒ 必红', () => {
    const bad = Object.assign({}, files);
    bad['renderer/app-media.js'] = files['renderer/app-media.js']
      .replace('if (MM.followNodeRef) { MM.followNodeRef(p, nid); return; }',
        'if (!p || p === state.project.name) { MM.adapter.selectNode(state.jm, nid); }\n'
        + '        else { MM.switchProject(p, nid); }');
    expect(bad['renderer/app-media.js']).not.toBe(files['renderer/app-media.js']);
    const r = checkNodeRefLinkWiring(bad);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('switchProject');
  });

  it('判别力：把 `centerOnRoot` 改成自己再算一套平移（第二套滚动算法）⇒ 必红', () => {
    const bad = Object.assign({}, files);
    bad[VIEW_MODULE] = files[VIEW_MODULE].replace(
      "function centerOnRoot() { return centerOnNode('root', { always: true }); }",
      'function centerOnRoot() { fdView.x += 1; fdView.y += 1; fdApplyView(); }');
    expect(bad[VIEW_MODULE]).not.toBe(files[VIEW_MODULE]);
    const r = checkNodeRefLinkWiring(bad);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('centerOnRoot');
  });
});

/* ================= ④ 契约文档的字样（缺失判红，不是"没写就不检查"） ================= */

describe('④ 两份契约文档必须写明这两条约定（字样缺失判红）', () => {
  it('`docs/DATA-FORMAT.md` 写明 HTML 优先 + 两条守卫 + 笔记链接约定 + 唯一跳转实现', () => {
    const doc = read('docs/DATA-FORMAT.md');
    ['HTML 优先', 'markdownToHtml', '字面量', '.fd-notelink', '--note-link-ink',
      'MM.followNodeRef', 'tests/detail-html-contract', 'scripts/smoke/47']
      .forEach((needle) => {
        expect(doc.indexOf(needle), '`docs/DATA-FORMAT.md` 里找不到字样：' + needle
          + '（把这段话删掉/改写一下就静默关掉了这条守卫 ⇒ 缺失必须判红）').toBeGreaterThanOrEqual(0);
      });
  });

  it('渲染点自己的注释里也写着这条契约（规则要放在动作现场）', () => {
    const code = read(DETAIL_RENDER_MODULES[0]);
    expect(code).toContain('HTML 优先');
    expect(code).toContain('markdownToHtml');
  });
});
