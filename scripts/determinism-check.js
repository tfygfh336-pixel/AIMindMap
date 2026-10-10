#!/usr/bin/env node
/* ============================================================
 * scripts/determinism-check.js — 确定性产物门禁（门禁编号 S3）
 * ------------------------------------------------------------
 * 它守的那件事（E6 分析稿判据 `A-08` / 缺口 `G-13`）：
 *   「同输入两次产出**逐字节相同**」——`docs/CLI.md` 与 `docs/VERIFY.md` 早就有"重算逐字比对"
 *   （G7）与"登记表与元信息一致"（G8 第 ⑬ 条），但那守的是**过期**（render ≠ 磁盘），
 *   守不住**不确定**（同一个输入两次 render ≠ 同一个输入两次 render）。
 *   本工程真吃过这个形状的假红：把 `.review/` 的工作目录清单渲染进受管文档 ⇒
 *   **新建一个工作目录**就让"生成物已过期"，全链判红 ✗（易变工作区不许成为受判据的输入）。
 *
 * 三类产物（登记表 = `docs/ARCHITECTURE.md` §5.2，本文件实现它，两边双向闭包）：
 *   · **真值比**   —— 必须在同一状态下**连续两次重算逐字节相同**（判定②）。
 *                     取样纪律：是"同一状态连续两次"，**不是**"改动之后第一次"跟别的比
 *                     （预热效应会让第一次给出旧值，拿去比会把真实回归误判成不确定性 ✗）。
 *   · **允许不确定** —— 必须①在生成器里**显式标注**"非确定性、不得当真值"（判定③），
 *                     ②声明的差异来源类在 `NONDET_CLASSES` 的允许列里（逐类写明为什么可以不确定）。
 *   · **欠账**     —— 被当"真值/证据"用、但**判定尚不存在**的那些：登记进 `DEBT`（封闭册：
 *                     在册算欠账、只减不增、修好忘销账判红、册上对象不存在判红）。
 *
 * 判定清单见 `analyze()` 里的 ①…④ 标记（此处刻意不写死条数：写死了就会漂）。
 *
 * 边界（诚实标注）：
 *   · 扰动只覆盖三类已知来源：**时钟**（`Date.now` / `new Date`）、**随机数**（`Math.random`）、
 *     **目录列举顺序/工作产物区**（`readdirSync` 反转 + 假装多了一个工作目录）。
 *     其它来源（宿主名、空闲内存、并发的真实写盘）扫不到 —— 那几类由"留痕产物"的标注承担；
 *   · 真值比产物的**过期**（render ≠ 磁盘）不由本门禁判（那是 G7 / G8 第 ⑬ 条的活，指过去复用 ✓）；
 *     本门禁只判**同一个输入的两次渲染**是否一致 —— 两条判据互补，不是一份东西写两遍；
 *   · `renderVerifyDoc` 的重算用**冻结的 facts 快照**（输入值不参与这条判据：问的是"同一输入两次
 *     是否相同"）。`facts()` 自己的不确定性由 **G7**（与磁盘逐字比对）兜底。
 *
 * 用法：
 *   node scripts/determinism-check.js          判红/判绿（挂 `npm run verify` 的 S3 步）
 *   node scripts/determinism-check.js --list   打印产物登记表 + 差异来源分类表 + 现场读数
 *   node scripts/determinism-check.js --debt   打印欠账册（只减不增；含"为什么是欠账 + 怎么迁"）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORK_DIR = '.review';                 // 工作产物区（可随时整目录删）
const FAKE_WORK = '20261010-门禁探针-假工作目录';   // 扰动用：假装新建了一个工作目录（**不落盘**）

/* ===============================================================
 * 差异来源分类（判定③的判据面）：**逐类写明"为什么可以不确定"**
 *   `allowed` = 这类差异**允许**出现在"允许不确定"的产物里；真值比产物一律不允许。
 * =============================================================== */
const NONDET_CLASSES = [
  { kind: '时间戳', allowed: true, why: '留痕的价值就在"什么时候绿的" —— 拿掉时间戳，它就不能回答'
    + '接手者的第一个问题（这份记录还新鲜吗）' },
  { kind: '耗时', allowed: true, why: '它是**趋势**基线（"比上次慢 15%"就是靠它），不是真值；'
    + '真值请现场取（`node scripts/doc-facts.js`）' },
  { kind: '随机名', allowed: true, why: '本工程用它做临时文件名与探针项目名（`it-probe-*`），用后即删、'
    + '不参与任何比对' },
  { kind: '路径', allowed: true, why: '`host` / 工程绝对路径随机器变 —— 写进去是为了回答'
    + '"这份记录是哪台机器跑的"，不是真值' },
  { kind: '渲染取景', allowed: true, why: '截图帧的像素统计（unique/mean/variance）随 GPU 合成与字体'
    + '栅格化微变 —— 它是**这一次运行的证据**，不当基线比' },
  { kind: '顺序', allowed: false, why: '"同一输入两次产出顺序不同"**不是不确定，是缺陷**：'
    + '真值产物会抖（本工程实测：把工作目录清单渲染进受管文档 ⇒ 新建一个工作目录就让全链判红 ✗）'
    + ' ⇒ 顺序必须显式 `sort()`，不许依赖 `readdirSync` 的返回次序' }
];
const ALLOWED_CLASSES = NONDET_CLASSES.filter((c) => c.allowed).map((c) => c.kind);

/* ===============================================================
 * 产物登记表（**实现面**；声明面 = `docs/ARCHITECTURE.md` §5.2，两边双向闭包校验）
 *   kind: 'truth'    ⇒ 必须有 `render`（判定②）
 *         'volatile' ⇒ 必须有 `generator` + `classes`（判定③）
 * =============================================================== */
const ARTIFACTS = {
  'cli-md': {
    kind: 'truth',
    file: 'docs/CLI.md',
    render: () => require(path.join(ROOT, 'cli', 'commands', 'release.js')).renderCliDoc()
  },
  'verify-md': {
    kind: 'truth',
    file: 'docs/VERIFY.md',
    // 输入用**冻结快照**：本条判据问的是"同一输入两次渲染是否逐字节相同"，输入值不参与。
    // （为什么不用真 `facts()`：它会在没有接力值时**自己跑一遍 vitest** —— 门禁里不许做重活 ✗；
    //   真值本身的正确性由 G7 与磁盘逐字比对兜底 ✓）
    render: () => require(path.join(ROOT, 'scripts', 'doc-facts.js')).renderVerifyDoc(FACTS_FIXTURE)
  },
  'registry-table': {
    kind: 'truth',
    file: 'docs/ARCHITECTURE.md',
    render: () => {
      const g = require(path.join(ROOT, 'scripts', 'docs-registry-check.js'));
      return g.renderRegistryTable(g.collectDocHeaders(ROOT));
    }
  },
  'last-verify': {
    kind: 'volatile',
    file: '.review/last-verify.json',
    generator: 'scripts/verify.js',
    classes: ['时间戳', '耗时', '路径']
  },
  'verify-history': {
    kind: 'volatile',
    file: '.review/verify-history.jsonl',
    generator: 'scripts/verify.js',
    classes: ['时间戳', '耗时', '路径']
  },
  'verify-tests': {
    kind: 'volatile',
    file: '.review/verify-tests.json',
    generator: 'scripts/verify.js',
    classes: ['耗时', '路径']
  },
  'smoke-frame': {
    kind: 'volatile',
    file: 'smoke-frame.json',
    generator: 'main.js',
    classes: ['渲染取景']
  }
};

/** 冻结的 facts 快照（字段与 `doc-facts.js` 的 `facts()` 同形；值取当前真值的字面量，只用于渲染） */
const FACTS_FIXTURE = {
  commands: 55, mcpTools: 45, unitTests: 1034, unitFiles: 55,
  cliAssertions: 310, smokeAssertions: 204, visionAssertions: 2,
  version: '0.18.0', configVersion: '0.18.0', lockVersion: '0.18.0', lockRootVersion: '0.18.0'
};

/* ===============================================================
 * 欠账册（**封闭**：在册算欠账 / 只减不增 / 修好忘销账判红 / 册上对象不存在判红）
 *   ⚠️ 上线时的档位是**乙档**（判定尚不存在 ⇒ 有在册欠账），不是"一次修干净"✗。
 *   上界：`DEBT_MAX`（只减不增）。复审时机：每次动"冒烟取景链路"（`main.js` 的截图段）时。
 *   审：门禁拥有者（改本文件的人）
 * =============================================================== */
const DEBT_MAX = 1;
const DEBT = [
  {
    id: 'frame-two-shot',
    what: '冒烟截图的「同一状态连续两帧逐字节相同」没有判定',
    used_as: '`scripts/vision/record.js` 把读图结论**绑到它的 sha256** 上（不一致就拒绝写）'
      + '⇒ 它被当**证据真值**用',
    why: '哈希被记录、被绑定，却从没被用来证明"同一状态两次相同" —— 任何人把状态栏的时间串'
      + '放回截图范围，全链照样绿（skill `C2` 正是这条实测：清掉时间串后两次运行才逐字节相同）',
    classes: '未知 —— 这正是欠账要回答的问题：要跑一次"连续两帧"才知道差在哪一类',
    how: '在 `main.js` 的冒烟取景段对**同一状态连续取两帧**比 `sha256`；不等即红，并按'
      + '`NONDET_CLASSES` 打印差异来源分类（尺寸 / 统计量 / 前 N 字节）',
    witness: { file: 'main.js', mustContain: 'smoke-shot.png' },
    paidWhen: { marker: '取景-连续两帧', why: '仓库里出现这个判据标记 ⇒ 欠账已还，必须从册上销掉'
      + '（否则判红，逼人销账）' },
    greenWhen: '需要一次真冒烟（G5，含 Electron）取连续两帧：两帧一致 ⇒ 直接销账；不一致 ⇒ 按差异'
      + '来源逐类消除（先清时间/耗时，再查过渡动画与字体栅格化），**可能不止一轮**'
  }
];

/* ===============================================================
 * ① 扰动（纯内存，**不落盘**）
 *    三种已知来源各一套补丁，跑完立刻还原；任何异常都在 finally 里还原。
 * =============================================================== */
/** 目录列举补丁：`order` 只**反转**（暴露"没 sort"的实现）；`workarea` 只**加一个假工作目录**。
 *  ⚠️ 两个维度必须**分开**：早期版本把"反转"与"加假目录"写成了同一个补丁 ⇒ 基准渲染也被扰动，
 *     于是 workarea 与 order 两维都成了空转（base 与扰动完全相同）✗ —— 正是 skill 说的"门禁空转"。 */
function readdirPatch(real, kind) {
  return function patchedReadDir(p, opts) {
    let out = real.apply(fs, arguments);
    if (!Array.isArray(out)) return out;
    const abs = path.resolve(String(p));
    if (kind === 'order') return out.slice().reverse();
    if (kind === 'workarea' && abs === path.join(ROOT, WORK_DIR)) {
      return out.concat([opts && opts.withFileTypes
        ? { name: FAKE_WORK, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
        : FAKE_WORK]);
    }
    return out;
  };
}

const FAKE_README = ['# ' + FAKE_WORK, '', '主题: 门禁探针（不落盘）', '开始日期: 2026-10-10',
  '状态: 已收口', ''].join('\n');

/** 各维度用的固定随机数：**基准也要固定** —— 否则 base 自己就抖，
 *  那样报出来的是"基线不稳"，分不清是哪一维的问题。
 *  `random` 维换一个种子：任何读 `Math.random()` 的实现都会现形 ✓ */
const RANDOM_SEED = { base: 0.13579, clock: 0.13579, order: 0.13579, workarea: 0.13579, random: 0.246813579 };

/** 冻结的"现在"：**所有维度都把时钟钉在一个常数上**（base 与 base2 才会真的逐字节相同），
 *  `clock` 维再整体推进一天 ⇒ 读时钟的实现只会在这一维现形（差异来源才分得清）。
 *  为什么不让 base 用真实时钟：真实时钟每毫秒都在动 ⇒ "基线不稳"会把**所有**读时钟的实现
 *  都报成"基线不稳"，而真正的病灶（掺了时间戳）被这层噪音盖住 ✗（实测踩到）。 */
const FROZEN_NOW = Date.parse('2026-01-01T00:00:00.000Z');
const CLOCK_SHIFT = { base: 0, clock: 86400000, random: 0, order: 0, workarea: 0 };

/** 在给定扰动下跑一次 render（返回字符串）；异常也当结果返回，便于分类。
 *  每个维度**只打自己那一类补丁**（base = 不打任何补丁，只固定随机数）——
 *  维度分开，差异来源才能被分类（"错在哪一类"是可执行的报错，而不是一句"不确定"）。 */
function renderUnder(kind, render) {
  const real = {
    readdir: fs.readdirSync, readFile: fs.readFileSync, exists: fs.existsSync,
    stat: fs.statSync, lstat: fs.lstatSync, Date: global.Date, random: Math.random
  };
  const fakeAbs = path.join(ROOT, WORK_DIR, FAKE_WORK);
  try {
    // 所有维度都固定随机数（base 也固定）：基准必须本身是确定的
    Math.random = () => (RANDOM_SEED[kind] === undefined ? RANDOM_SEED.base : RANDOM_SEED[kind]);
    if (kind === 'order' || kind === 'workarea') fs.readdirSync = readdirPatch(real.readdir, kind);
    if (kind === 'workarea') {
      const dir = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      const under = (p) => path.resolve(String(p)).toLowerCase().startsWith(fakeAbs.toLowerCase());
      // ⚠️ 这几个补丁必须是 `function`（不能用箭头函数）：下面要用各自的 `arguments`
      // 原样转发给真实现 —— 箭头函数没有自己的 `arguments`，会把外层 `renderUnder(kind, …)`
      // 的参数当路径用（实测踩到：`open '…/workarea'` 的假报错）✗
      fs.existsSync = function (p) { return under(p) ? true : real.exists.apply(fs, arguments); };
      fs.statSync = function (p) {
        return under(p)
          ? { isDirectory: () => true, isFile: () => false, mtimeMs: 0, size: 0, dir }
          : real.stat.apply(fs, arguments);
      };
      fs.lstatSync = function (p) {
        return under(p)
          ? { isDirectory: () => true, isFile: () => false, mtimeMs: 0, size: 0, dir }
          : real.lstat.apply(fs, arguments);
      };
      fs.readFileSync = function (p) {
        return path.resolve(String(p)).toLowerCase() === path.join(fakeAbs, 'README.md').toLowerCase()
          ? FAKE_README : real.readFile.apply(fs, arguments);
      };
    }
    // 所有维度都把时钟**冻结**（base 也冻结 ⇒ base 与 base2 才可能逐字节相同）；
    // `clock` 维再整体推进一天。读时钟的实现只会在 clock 那一维现形 ✓
    {
      const RealDate = real.Date;
      const at = FROZEN_NOW + (CLOCK_SHIFT[kind] || 0);
      class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(at); else super(...a); }
        static now() { return at; }
      }
      global.Date = FrozenDate;
    }
    return String(render());
  } catch (e) {
    return '(渲染抛异常: ' + (e && e.message) + ')';
  } finally {
    fs.readdirSync = real.readdir; fs.readFileSync = real.readFile; fs.existsSync = real.exists;
    fs.statSync = real.stat; fs.lstatSync = real.lstat;
    global.Date = real.Date; Math.random = real.random;
  }
}

/** 同一状态**连续两次**渲染：base 与 base 自己比（必须先相等，否则连基线都不稳） */
function twoShot(render) {
  const base = renderUnder('base', render);
  const base2 = renderUnder('base', render);
  return {
    base, base2,
    clock: renderUnder('clock', render),
    random: renderUnder('random', render),
    order: renderUnder('order', render),
    workarea: renderUnder('workarea', render)
  };
}

/** 逐字节比对：返回 null（相同）或差异描述 { at, line, label, dim } */
function diffOf(a, b, dim) {
  if (a === b) return null;
  const al = String(a).split('\n');
  const bl = String(b).split('\n');
  let at = 0;
  while (at < al.length && at < bl.length && al[at] === bl[at]) at++;
  return {
    dim,
    line: at + 1,
    label: String(al[at] === undefined ? '(文件结束)' : al[at]).slice(0, 100),
    other: String(bl[at] === undefined ? '(文件结束)' : bl[at]).slice(0, 100)
  };
}

/* ===============================================================
 * ② 声明面：`docs/ARCHITECTURE.md` §5.2 的产物表（解析 markdown 表）
 * =============================================================== */
const DECL_DOC = 'docs/ARCHITECTURE.md';
const SECTION_RE = /^###\s*5\.2\s/;

/** 解析 §5.2 的表：返回 [{ id, kind（真值比/允许不确定）, owner:[门禁号] }] */
function parseDeclaredTable(md) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => SECTION_RE.test(l));
  if (start < 0) return { found: false, rows: [] };
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###\s/.test(lines[i]) || /^##\s/.test(lines[i])) break;
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const id = m[1];
    if (id === 'id') continue;                       // 表头
    rows.push({
      id,
      kind: m[2].trim() === '真值比' ? 'truth' : m[2].trim() === '允许不确定' ? 'volatile' : '(未知类别: ' + m[2].trim() + ')',
      rawKind: m[2].trim(),
      owners: (m[4].match(/`([GVS]\d+)`/g) || []).map((s) => s.replace(/`/g, '')),
      line: i + 1
    });
  }
  return { found: true, rows };
}

/* ===============================================================
 * ③ 自述是生成物的文件（判定④的"同类违规"面）：跑了它才算"被当真值用"
 *    口径 = **头部 30 行内**说自己"勿手改 / 本文件…自动生成"（本工程这两个措辞是既有约定）。
 *    ⚠️ 第一版把"自动生成"单独当信号 ⇒ 误抓 `docs/EXTENSIONS.md`（它写的是"命令完整用法见
 *       `docs/CLI.md`（自动生成）" —— 说的是**别的文件**）⇒ 判据要绑定"**这一份**自己"。
 *    边界：自述写在 30 行之外的生成物扫不到（如实写明，不假装查过）。
 * =============================================================== */
const GEN_HINT_RE = /请勿手改|勿手改|本文件[^\n]{0,24}自动生成/;

function selfDeclaredGenerated() {
  const out = [];
  const scan = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const txt = fs.readFileSync(abs, 'utf8');
    const head = txt.split(/\r?\n/).slice(0, 30).join('\n');
    if (GEN_HINT_RE.test(head)) out.push({ rel, why: '文件头部自述是生成物（"勿手改 / 自动生成"）' });
  };
  ['README.md', 'SKILL.md', 'CHANGELOG.md'].forEach(scan);
  const docsDir = path.join(ROOT, 'docs');
  if (fs.existsSync(docsDir)) {
    fs.readdirSync(docsDir).filter((f) => /\.md$/.test(f)).forEach((f) => scan('docs/' + f));
  }
  return out;
}

/** 自述生成物的文件 → 它对应表里的哪个产物（`docs/CLI.md` 这类按文件名匹配） */
function generatedUnregistered(declaredRows) {
  const files = selfDeclaredGenerated().map((g) => g.rel);
  const known = new Set(Object.keys(ARTIFACTS).map((k) => ARTIFACTS[k].file));
  return files.filter((f) => !known.has(f)).map((f) => ({
    rel: f,
    why: '它自述是生成物，却不在 §5.2 的产物表里 ⇒ **没人验"两次一致"**（这正是本门禁要堵的那一口）'
  }));
}

/* ===============================================================
 * ④ 判定（读磁盘 → 问题清单）
 * =============================================================== */
function analyze() {
  const problems = [];
  const notes = [];
  const declared = parseDeclaredTable(fs.readFileSync(path.join(ROOT, DECL_DOC), 'utf8'));
  if (!declared.found) {
    problems.push({ kind: 'decl', msg: '`' + DECL_DOC + '` 里找不到 §5.2 产物表 —— '
      + '判定没有声明面（本门禁的"声明的对象集合"就来自那张表）' });
  }

  // ① 双向闭包：声明 ⊆ 实现 且 实现 ⊆ 声明；类别相符
  const implIds = Object.keys(ARTIFACTS);
  const declIds = declared.rows.map((r) => r.id);
  declIds.filter((id) => !implIds.includes(id)).forEach((id) => {
    problems.push({ kind: 'decl', msg: '§5.2 声明了产物 `' + id + '`，但本文件没有实现它的判定'
      + '（声明了没人守 = 空头承诺）' });
  });
  implIds.filter((id) => !declIds.includes(id)).forEach((id) => {
    problems.push({ kind: 'decl', msg: '本文件实现了产物 `' + id + '` 的判定，但 §5.2 的表里没有它'
      + '（表漏了一行：接手者不知道这个产物受管）' });
  });
  declared.rows.forEach((r) => {
    if (!ARTIFACTS[r.id]) return;
    if (r.kind !== ARTIFACTS[r.id].kind) {
      problems.push({ kind: 'decl', msg: '§5.2 里 `' + r.id + '` 的类别写的是「' + r.rawKind
        + '」，实现里是「' + ARTIFACTS[r.id].kind + '」—— 两边必须一致' });
    }
    if (!r.owners.length) {
      problems.push({ kind: 'decl', msg: '§5.2 里 `' + r.id + '` 没写"谁在守"（`G7` / `G8` / `S3` 至少一个）' });
    }
    r.owners.forEach((g) => {
      if (g === 'S3') return;                        // 本门禁自己
      const mounted = mountedGates();
      if (!mounted || !mounted.includes(g)) {
        problems.push({ kind: 'decl', msg: '§5.2 把 `' + r.id + '` 指给门禁 `' + g + '`，但它没挂在链上' });
      }
    });
  });
  notes.push('产物表：声明 ' + declIds.length + ' 行 / 实现 ' + implIds.length + ' 个；'
    + '类别 真值比 ' + declIds.filter((id, i) => declared.rows[i].kind === 'truth').length
    + ' · 允许不确定 ' + declIds.filter((id, i) => declared.rows[i].kind === 'volatile').length);

  // ② 真值比产物：同一状态**连续两次**重算逐字节相同（三种已知扰动分开判 ⇒ 差异来源可分类）
  const shots = {};
  const truths = implIds.filter((id) => ARTIFACTS[id].kind === 'truth');
  const unregistered = generatedUnregistered(declared.rows);
  unregistered.forEach((u) => {
    problems.push({ kind: 'unregistered', msg: '自述是生成物但没进表：`' + u.rel + '` —— ' + u.why
      + '（要么把它登记进 §5.2 并给判定，要么把头部那句"勿手改"去掉）' });
  });
  truths.forEach((id) => {
    const a = ARTIFACTS[id];
    const s = twoShot(a.render);
    shots[id] = { file: a.file };
    if (s.base !== s.base2) {
      problems.push({ kind: 'truth', id, msg: '真值比产物 `' + a.file
        + '`：**两次未扰动的重算自己都不一致** ⇒ 基线不稳，先查它（差异第 ' + diffOf(s.base, s.base2, 'base').line + ' 行）' });
      return;
    }
    const dims = [['clock', '时间戳'], ['random', '随机名'], ['order', '顺序'], ['workarea', '工作区（路径/清单）']];
    dims.forEach(([dim, label]) => {
      const d = diffOf(s.base, s[dim], dim);
      if (!d) return;
      problems.push({
        kind: 'truth',
        id,
        msg: '真值比产物 `' + a.file + '`：重算**掺进了易变来源「' + label + '」** —— 同一输入两次不一致'
          + '（第 ' + d.line + ' 行）\n       基准: ' + d.label + '\n       扰动: ' + d.other
      });
    });
  });

  // ③ 允许不确定产物：生成器里的显式标注 + 差异来源类必须在允许列
  implIds.filter((id) => ARTIFACTS[id].kind === 'volatile').forEach((id) => {
    const a = ARTIFACTS[id];
    const genAbs = path.join(ROOT, a.generator);
    if (!fs.existsSync(genAbs)) {
      problems.push({ kind: 'volatile', id, msg: '允许不确定产物 `' + a.file
        + '`：声明的生成器 `' + a.generator + '` 不存在 ⇒ 采不到真值 = 红' });
      return;
    }
    const hit = findMarker(fs.readFileSync(genAbs, 'utf8'), path.basename(a.file));
    if (!hit.ok) {
      problems.push({ kind: 'volatile', id, msg: '允许不确定产物 `' + a.file + '`：生成器 `'
        + a.generator + '` 里' + hit.why
        + ' —— 要求：同一段注释里同时出现「非确定性」「不得当真值」与产物文件名（±10 行内）' });
    }
    const bad = (a.classes || []).filter((c) => !ALLOWED_CLASSES.includes(c));
    if (bad.length) {
      problems.push({ kind: 'volatile', id, msg: '允许不确定产物 `' + a.file + '`：声明的差异来源类 '
        + bad.join(' / ') + ' **不在允许列**（不允许：'
        + NONDET_CLASSES.filter((c) => !c.allowed).map((c) => c.kind + '（' + c.why + '）').join('；') + '）' });
    }
  });

  // ④ 欠账册封闭性：在册算欠账 / 超上界 / 修好忘销账 / 悬挂登记
  const debts = [];
  const repoText = (rel) => (fs.existsSync(path.join(ROOT, rel))
    ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : null);
  DEBT.forEach((d) => {
    const w = repoText(d.witness.file);
    if (w === null || w.indexOf(d.witness.mustContain) < 0) {
      problems.push({ kind: 'debt-stale', msg: '欠账 `' + d.id + '`：册上那条的**对象在仓库里已经不存在**'
        + '（`' + d.witness.file + '` 里找不到 `' + d.witness.mustContain + '`）⇒ 悬挂登记，判红' });
      return;
    }
    const all = ['main.js', 'scripts/verify.js', 'scripts/vision/record.js', 'scripts/vision/frame-stats.js']
      .map(repoText).filter((t) => t !== null).join('\n');
    if (all.indexOf(d.paidWhen.marker) >= 0) {
      problems.push({ kind: 'debt-stale', msg: '欠账 `' + d.id + '`：' + d.paidWhen.why });
      return;
    }
    debts.push(d);
  });
  if (DEBT.length > DEBT_MAX) {
    problems.push({ kind: 'debt', msg: '在册欠账 ' + DEBT.length + ' 条 > 上界 ' + DEBT_MAX
      + '（**只减不增**：新欠账要么当场修，要么说明为什么必须扩上界）' });
  }
  notes.push('在册欠账：' + debts.length + ' 条（上界 ' + DEBT_MAX + '，只减不增）');

  return { problems, notes, declared, debts, shots, truths, unregistered };
}

/** 生成器里有没有"这一份不得当真值"的显式标注（标注必须**点名**产物，不许一句笼统话）
 *  口径：同一段注释（±10 行窗口）里同时出现「非确定性」「不得当真值」与产物文件名 ——
 *  这三样**不必挤在同一行**（中文注释换行是常态），但必须挨在一起、且点名的是**这一份**。 */
function findMarker(src, baseName) {
  const lines = String(src).split(/\r?\n/);
  const win = (i) => lines.slice(Math.max(0, i - 10), i + 11);
  const at = [];
  lines.forEach((l, i) => { if (l.indexOf('非确定性') >= 0) at.push(i); });
  if (!at.length) return { ok: false, why: '没有找到「非确定性」的显式标注' };
  const ok = at.some((i) => {
    const w = win(i);
    return w.some((l) => l.indexOf('不得当真值') >= 0) && w.some((l) => l.indexOf(baseName) >= 0);
  });
  if (ok) return { ok: true };
  const named = at.some((i) => win(i).some((l) => l.indexOf(baseName) >= 0));
  return {
    ok: false,
    why: named ? '有标注，但「不得当真值」离得太远（要和「非确定性」在同一段 ±10 行内）'
      : '有「非确定性」这句，但它**没点名** `' + baseName + '`（±10 行内找不到文件名）'
  };
}

function mountedGates() {
  try { return require(path.join(ROOT, 'scripts', 'verify.js')).STEPS.map((s) => s.gate); }
  catch (e) { return null; }
}

function main() {
  if (process.argv.includes('--debt')) {
    console.log('== 欠账册（**封闭**：在册算欠账 / 只减不增 / 修好忘销账判红 / 册上对象不存在判红）==');
    if (!DEBT.length) console.log('  （空 —— 已全部还清 ✓）');
    DEBT.forEach((d) => {
      console.log('  ▸ ' + d.id + '：' + d.what);
      console.log('      被当真值用的地方：' + d.used_as);
      console.log('      为什么是欠账：' + d.why);
      console.log('      差异来源分类：' + d.classes);
      console.log('      怎么迁：' + d.how);
      console.log('      册上对象：`' + d.witness.file + '` 里仍有 `' + d.witness.mustContain + '`');
      console.log('      销账触发：' + d.paidWhen.why);
      console.log('      什么时候才可能全绿：' + d.greenWhen);
    });
    console.log('  在册合计 ' + DEBT.length + ' 条 / 上界 ' + DEBT_MAX + '（只减不增）');
    return;
  }

  if (process.argv.includes('--list')) {
    console.log('== 产物登记表（声明面 = `' + DECL_DOC + '` §5.2；实现面 = 本文件 ARTIFACTS）==');
    Object.keys(ARTIFACTS).forEach((id) => {
      const a = ARTIFACTS[id];
      console.log('  ' + id.padEnd(15) + (a.kind === 'truth' ? '真值比    ' : '允许不确定')
        + a.file + (a.kind === 'volatile' ? '   生成器 ' + a.generator + ' · 差异来源 ' + a.classes.join('/') : ''));
    });
    console.log('');
    console.log('== 差异来源分类（哪几类允许、哪一类不允许）==');
    NONDET_CLASSES.forEach((c) => console.log('  ' + (c.allowed ? '允许  ' : '**不允许** ')
      + c.kind + '：' + c.why));
    console.log('');
    const r = analyze();
    r.notes.forEach((n) => console.log('  · ' + n));
    console.log('  · 自述是生成物却没进表的文件：' + r.unregistered.length + ' 个'
      + (r.unregistered.length ? '（' + r.unregistered.map((u) => u.rel).join(' / ') + '）' : ''));
    console.log('  欠账明细：`node scripts/determinism-check.js --debt`');
    return;
  }

  const r = analyze();
  console.log('== 确定性产物门禁（S3）==');
  r.notes.forEach((n) => console.log('  · ' + n));
  if (!r.problems.length) {
    console.log('✓ 确定性产物成立：' + r.truths.length + ' 个真值比产物在"同一状态连续两次重算"下逐字节相同'
      + '（含时钟 / 随机 / 顺序 / 工作区四类扰动），'
      + (Object.keys(ARTIFACTS).length - r.truths.length)
      + ' 个允许不确定产物都有显式标注与差异来源分类');
    console.log('  在册欠账 ' + r.debts.length + ' 条（上界 ' + DEBT_MAX + '）：'
      + r.debts.map((d) => d.id).join(' / ') + ' —— 明细见 `node scripts/determinism-check.js --debt`');
    return;
  }
  console.log('✗ 确定性产物有 ' + r.problems.length + ' 处问题：');
  r.problems.forEach((p) => console.log('   [' + p.kind + '] ' + p.msg));
  console.log('   → 修法：真值比产物**不许**读时钟 / 随机数 / 目录列举顺序 / 工作产物区'
    + '（顺序一律显式 sort；当前值一律现场取，不要写进产物）；');
  console.log('     允许不确定的产物，要在**生成器里**点名标注"非确定性、不得当真值"，'
    + '并说明差异属于哪一类（判据面：`--list` 的分类表）。');
  process.exit(1);
}

module.exports = {
  NONDET_CLASSES, ARTIFACTS, DEBT, DEBT_MAX, FACTS_FIXTURE,
  parseDeclaredTable, selfDeclaredGenerated, generatedUnregistered,
  renderUnder, twoShot, diffOf, findMarker, analyze, mountedGates
};

if (require.main === module) main();
