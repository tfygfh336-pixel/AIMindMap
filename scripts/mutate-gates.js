#!/usr/bin/env node
/* ============================================================
 * scripts/mutate-gates.js — 门禁变异体检（最小版）
 * ------------------------------------------------------------
 * 存在理由（来源：`.review/20261013-全网借鉴日报/日报.md` 第 10 条）：
 *   那篇的实测读数是"175 个变异体 78 个漏过"、"删掉四个字就能绕过全部检查"。
 *   也就是说：**门禁到底会不会红**这件事，当时是**靠人手验一次**的，没变成常规动作。
 *   本工具把它变成常规动作：**把合法输入 / 实现变异成多个变体，逐个去撞门禁，看它拦不拦**。
 *   刻意不做那 175 个 —— 每个门禁挑几条**有代表性**的，宁少勿滥。
 *
 * 四条纪律（缺一条这次体检就不算数）：
 *   甲 **只在副本上做破坏**：真仓只读地复制进 %TEMP%，所有变异都落在副本里；真仓一个字节都不动，
 *      副本在 `finally` 里自清。⇒"做变异测试"与"改坏仓库"是两件事。
 *   乙 **红必须是"新红"**：每条变异体先跑一遍**未变异的副本**取基线；只有"期望的原因出现在
 *      变异体输出里、且**基线输出里没有**这个原因"才记"拦下"。镜像与真仓逐字节相同 ⇒ 基线的红
 *      只可能来自真仓自己的存量问题，那不是本工具的读数 ✗（否则会把"门禁本来就红"记成"我拦下了"）。
 *   丙 **不是恒真**：每个门禁都带①一条**无害对照**（只改注释/空白 ⇒ 读数必须逐字不变，否则记"假红"）
 *      与②一条**负对照**（把门禁**钝化**后再注入真违规 ⇒ 必须如实报"没拦下"）。
 *      一条只会喊"拦下了"的工具，与一条不会红的门禁一样没用 ✗。
 *   丁 **采不到 / 归不了因就说不知道**：读不出真值、或基线本来就红着同一个原因 ⇒ 记 **未测**，
 *      既不算拦下也不算漏过（静默跳过会把"没测"读成"通过"）。
 *
 * 判定清单见 `classify()` 的 ①…⑤ 标记（此处刻意不写死条数：写死了就会漂，
 * 而"条数声明"的权威副本是 `docs/RULES.md` §2 的门禁行）。
 *
 * 边界（诚实标注 —— 哪些**测不了**，别以为它包住一切）：
 *   · 只测**这五个门禁**：G9 `rules-consistency` · S1 `dep-direction-check` ·
 *     G6+G7 `doc-facts --check` · V1 `visibility-judge-check` · G8 `docs-registry-check`。
 *     其余（G1/G2/G3/G4/G5/V2/S2/S3）**未测**：它们要么要起 Electron、要么要跑全链，
 *     不在"最小版"里（也不该在一台正被别的流占着的机器上跑）。
 *   · 变体是**手工挑的**（每个门禁三条 + 对照），能回答"这几类破坏拦不拦"，
 *     **回答不了覆盖率**（"所有可能的破坏里拦住了百分之多少"）✗。
 *     G8 是唯一的例外：它的**每条判定逐条各造一条注入**（判定的权威清单由
 *     `node scripts/docs-registry-check.js --judgments` 现场取 —— 本文件不抄那份清单）。
 *     "门禁 × 有没有证明"的汇总表不在这里：住在
 *     `.review/20261016-T4-G8判别力/tools/coverage-table.js`（现算，欠账册与之一致性互校）。
 *   · 它测的是**门禁**，不是产品：产品行为仍靠 G3/G4/G5。
 *   · 门禁若**不支持指向外部输入**，就只能测"能测的那一半"——每个门禁的 `seam` 字段写明
 *     本工具注在哪一层（输入文本 / 一份程序集 / 门禁实现），没测到的部分记"未测"。
 *   · 它**不改任何门禁的判定**：钝化只发生在副本里，真仓的门禁逐字节不变（`--json` 里带
 *     真仓每份门禁脚本的 sha256 前后对照，供复核）。
 *
 * 用法：
 *   node scripts/mutate-gates.js                  # 全量体检（只读真仓；临时件在 %TEMP% 里自清）
 *   node scripts/mutate-gates.js --json           # 只吐 JSON（给机器读 / 给测试读）
 *   node scripts/mutate-gates.js --only=dep-direction,rules-consistency
 *   node scripts/mutate-gates.js --strict         # 有漏过/静默 ⇒ exit 1（默认只报告）
 *   node scripts/mutate-gates.js --out=<file>     # 把 JSON 落盘（默认不落盘；仓库根不留东西）
 *   node scripts/mutate-gates.js --keep           # 保留副本目录（排查用；正常结束自清）
 *
 * 退出码（理由见 `exitCodeFor()`）：
 *   0 = 跑完并报出读数（**默认**：漏过是**读数**不是回归 —— 常年红的门禁下场是被关掉）
 *   1 = **有漏过**（只在 `--strict` 下才取这个码，留给"新门禁上线前必须零漏过"的场景）
 *   2 = 采不到真值 / 环境不齐（复制不出副本、门禁脚本不存在、某个门禁跑不起来）
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MIRROR_PREFIX = 'dsh-mutate-gates-';

/* ⚠️ 为什么下面这些"注入用的依赖边"要在**运行时拼串**，而不是写成字面量（首次跑就被抓到）：
 *   S1 门禁（`scripts/dep-direction-check.js`）的输入是"**剥注释、但保留字符串**的源码文本" ——
 *   保留字符串是它的必需（它要读 `require('…')` 里的路径字面量）；代价是：
 *   **本文件里任何一处 `require('…')` 字面量都会被它当成一条真的依赖边**。
 *   实测：写成字面量时 S1 在真仓报 2 条违规，两条都指向本文件（一条反向边 `→ renderer/`、
 *   一条图外边 `→ tools/`）⇒ 本工具第一次运行就把自己的基线搞红了（而且它如实把那两条判成
 *   "未测/归不了因"，没有记成"我拦下了" ✓）。⇒ 拼串让源码里不留任何可被当成依赖的形态。
 *   （注释里可以照写 `require('…')`：S1 会剥注释 —— 注释里的示例不是实现。） */
const REQ = 'requ' + 'ire';
const EDGE = {
  reverse: REQ + "('../renderer/app-core.js');",
  self: (rel) => REQ + "('./" + path.posix.basename(rel) + "');",
  outside: REQ + "('../tools/mut-probe.js');"
};

/** 副本内容 = 门禁真正会读的那些：显式清单（不复制 node_modules / vendor / build / backups /
 *  projects / .git / .review —— 门禁的扫描面都不含它们，而备份与构建产物是几百 MB 级的重物）。 */
const COPY_DIRS = ['cli', 'docs', 'renderer', 'scripts', 'src', 'tests'];
const COPY_ROOT_FILES = [
  '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'SKILL.md', 'CHANGELOG.md',
  'main.js', 'main-dsh-sidebar.js', 'preload.js', 'electron-builder.yml', 'vitest.config.mjs'
];

/* ===============================================================
 * 副本（唯一允许写的地方）
 * =============================================================== */
function copyInto(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyInto(s, d, null);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function makeMirror() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), MIRROR_PREFIX));
  const root = path.join(home, 'repo');
  fs.mkdirSync(root, { recursive: true });
  for (const d of COPY_DIRS) {
    const abs = path.join(REPO, d);
    if (fs.existsSync(abs)) copyInto(abs, path.join(root, d), d === 'scripts' ? null : null);
  }
  for (const f of COPY_ROOT_FILES) {
    const abs = path.join(REPO, f);
    if (fs.existsSync(abs)) fs.copyFileSync(abs, path.join(root, f));
  }
  return { home, root };
}

/** 副本的可写视图：**写入前先存原始字节**，用完 `restore()` 逐字节还原（只还原被写过的文件）。
 *  这样"每条变异体都是从同一个未变异的副本出发"这件事**由构造保证**，不靠人记得撤销。
 *  ⚠️ **连 mtime 一起还原**（2026-10-16 实测补的口子）：G8 这类门禁会在输出里打印
 *  「最近 N 分钟内被改动的受管文件」这种**告知行**，而 `fs.writeFileSync` 会把 mtime 刷成"现在"
 *  ⇒ 上一条变体还原过的文件会**留在窗口里**，于是后面每条变体（含无害对照）的读数都多出一行差异
 *  ⇒ 无害对照被自己记成"假红"（实测：`docs/changelog` 那条对照就是这样红的）。
 *  "逐字节还原"本来就该连时间戳一起 —— 否则副本并不是"未变异的副本"。
 *  （写回 mtime 用 `fs.utimesSync`；`stat.mtime` 是亚毫秒精度，用 `Date` 回写会取整到毫秒级 ——
 *   这仍足以让"最近 10 分钟"窗口的判定不变。） */
function makeMirrorApi(root) {
  const saved = new Map();
  const savedDirs = new Set();
  const abs = (rel) => path.join(root, rel.split('/').join(path.sep));
  const save = (rel) => {
    if (saved.has(rel)) return;
    const p = abs(rel);
    if (!fs.existsSync(p)) { saved.set(rel, null); return; }
    const st = fs.statSync(p);
    saved.set(rel, { buf: fs.readFileSync(p), atime: st.atime, mtime: st.mtime });
  };
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
  const write = (rel, text) => { save(rel); fs.writeFileSync(abs(rel), text, 'utf8'); };
  /** 造目录：G8 第 ⑨ 条（"工作目录必须声明死活"）的靶子就是一个**没有 README 的目录**。
   *  与 `write()` 同一口径 —— 造之前先记"它原来不存在"，`restore()` 里递归删掉。
   *  为什么不直接在变体里 `fs.mkdirSync`：那会把目录**留到后面每条变体**里（⑨ 的红会污染
   *  后面的无害对照 ⇒ 记成"假红"），于是"每条变体都从未变异的副本出发"不再是构造保证 ✗。 */
  const mkdir = (rel) => {
    const p = abs(rel);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); savedDirs.add(p); }
    return rel;
  };
  const edit = (rel, fn) => {
    const before = read(rel);
    const after = fn(before);
    if (after === before) throw new Error('变异没有改变 ' + rel + '（靶点没找对：期望的片段不存在）');
    write(rel, after);
    return { rel, deltaBytes: after.length - before.length };
  };
  const append = (rel, text) => edit(rel, (s) => (s.endsWith('\n') ? s : s + '\n') + text + '\n');
  const restore = () => {
    for (const [rel, rec] of saved) {
      const p = abs(rel);
      if (rec === null) { fs.rmSync(p, { force: true }); continue; }
      fs.writeFileSync(p, rec.buf);
      try { fs.utimesSync(p, rec.atime, rec.mtime); } catch (e) { /* 时间戳还原失败不该吞掉还原本身 */ }
    }
    saved.clear();
    for (const p of savedDirs) fs.rmSync(p, { recursive: true, force: true });
    savedDirs.clear();
  };
  return { root, read, write, mkdir, edit, append, restore, savedFiles: () => [...saved.keys()] };
}

/* ===============================================================
 * 跑门禁（真子进程、真 exit code）
 * =============================================================== */
function runGate(mirrorRoot, cfg, env) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(mirrorRoot, cfg.script)].concat(cfg.args || []), {
    cwd: mirrorRoot, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
  const out = String(r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
  return {
    exit: r.status === null ? null : r.status,
    out, ms: Date.now() - t,
    spawnError: r.error ? String(r.error.message || r.error) : null
  };
}

function gateEnv(mirrorRoot, pins) {
  const env = Object.assign({}, process.env);
  // 副本里没有 node_modules ⇒ 裸包名（如 MCP SDK）要能解析到真仓的（只读依赖，不是被测对象）
  env.NODE_PATH = path.join(REPO, 'node_modules');
  // doc-facts 没有这个变量就会去跑一次 vitest（副本里没有 vitest ⇒ 采不到真值 ⇒ 假红）。
  // 钉住的值来自副本自己的 `docs/VERIFY.md` 声明（透明：JSON 里记下值与来源）。
  env.AI_MINDMAP_UNIT_TESTS = String(pins.unitTests);
  return env;
}

/** 真值钉子：副本 `docs/VERIFY.md` 里声明的用例数（读不出来就退回"测试文件数"）。 */
function unitTestsPin(mirrorRoot) {
  try {
    const md = fs.readFileSync(path.join(mirrorRoot, 'docs', 'VERIFY.md'), 'utf8');
    const m = /\|\s*单元测试\s*\|\s*(\d+)\s*用例\s*\/\s*(\d+)\s*文件/.exec(md);
    if (m) return { unitTests: Number(m[1]), source: 'docs/VERIFY.md 的声明值（' + m[1] + ' 用例 / ' + m[2] + ' 文件）' };
  } catch (e) { /* 落到下面 */ }
  const n = fs.existsSync(path.join(mirrorRoot, 'tests'))
    ? fs.readdirSync(path.join(mirrorRoot, 'tests')).filter((f) => /\.test\.js$/.test(f)).length : 1;
  return { unitTests: n, source: '读不到 VERIFY.md 的声明值，退回测试文件数 ' + n };
}

/* ===============================================================
 * 判定：期望 vs 实测（清单见 ①…⑤）
 * =============================================================== */
const VERDICT = {
  caught: '拦下', escaped: '漏过', asExpected: '符合预期',
  falseAlarm: '假红', untested: '未测', silent: '静默'
};

const normalize = (s) => String(s).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

function classify(variant, base, mut) {
  // ① 无害对照：期望"读数一个字都不变"
  if (variant.expect === 'unchanged') {
    return (normalize(base.out) === normalize(mut.out) && base.exit === mut.exit) ? 'asExpected' : 'falseAlarm';
  }
  const inBase = variant.reason.test(base.out);
  const inMut = variant.reason.test(mut.out);
  // ② 基线本来就红着这个原因 ⇒ **归不了因**（记未测；不许记成"我拦下了"）
  if (inBase) return 'untested';
  // ③ 负对照：门禁已被钝化，这条破坏**本就不该**被拦下 ⇒ 期望"没拦下"
  if (variant.expect === 'escape') return inMut ? 'falseAlarm' : 'asExpected';
  // ④ 真变异：期望"拦下"（原因出现 + 退出码非 0）
  if (!inMut) return 'escaped';
  // ⑤ 打印了违规却 exit 0 ⇒ 那是"静默"（门禁没判红），不是拦下
  return mut.exit === 0 ? 'silent' : 'caught';
}

/** 退出码语义（纯函数，便于单测）。理由：漏过是**读数**不是回归 —— 门禁本来就有盲区，
 *  把它做成默认红 ⇒ 这条命令会长期红 ⇒ 下场是被关掉（skill `B4` 的实测教训）。
 *  `--strict` 留给"新门禁上线前必须零漏过"。静默（打印了违规却 exit 0）与漏过同判：都是"该红没红"。 */
function exitCodeFor(report, opts) {
  if (report.envError) return 2;
  const s = report.summary || {};
  if ((opts && opts.strict) && ((s.escaped || 0) > 0 || (s.silent || 0) > 0)) return 1;
  return 0;
}

/* ===============================================================
 * 变体目录（四个门禁 · 手工挑）
 *   expect: 'caught'   真变异，期望拦下
 *           'unchanged' 无害对照，期望读数逐字不变
 *           'escape'    负对照（门禁已钝化），期望**没拦下**
 * =============================================================== */
const GATES = [
  /* ---------------------------- G9 ---------------------------- */
  {
    id: 'rules-consistency', code: 'G9', title: '规则文件自洽',
    script: 'scripts/rules-consistency.js', args: [],
    seam: '镜像 CLI 全链（真子进程 + 真 exit code）：输入 = 副本的 docs/RULES.md 与各受管文档；'
      + '门禁自己的判定 ①…⑥ 全在同一进程里跑（本工具不改它的判定，只改它的输入）',
    discover(M) {
      const rc = realModule('scripts/rules-consistency.js');
      const rel = rc.RULES;
      const lines = M.read(rel).split('\n');
      const claim = rc.parseCountClaims(lines)[0] || null;
      const rows = rc.findIdRows(lines);
      // 挑一条"被别的文档引用过"的铁律：删掉它的**定义**才会变成悬挂引用
      const referenced = new Set();
      rc.SCAN_DOCS.forEach((d) => {
        if (d === rel) return;
        let t = null;
        try { t = M.read(d); } catch (e) { return; }
        rc.collectReferences(t).forEach((_line, id) => referenced.add(id));
      });
      const refRow = rows.filter((r) => r.id[0] === 'R' && referenced.has(r.id)).pop() || null;
      const gateRows = rows.filter((r) => r.id[0] === 'G');
      return { rc, rel, claim, refRow, gateRows };
    },
    variants: [
      {
        id: 'G9-1', kind: '改真值', expect: 'caught', reason: /\[条数不符\]/,
        name: '把 docs/RULES.md §3 声明的「共 N 条」+1（声明数与表格行数不一致）',
        apply(M, c) {
          if (!c.claim) throw new Error('RULES.md 里没有「共 N 条」声明，这一条测不了');
          const idx = c.claim.line - 1;
          return M.edit(c.rel, (s) => {
            const ls = s.split('\n');
            ls[idx] = ls[idx].replace(/共\s*\d+\s*条/, '共 ' + (c.claim.claimed + 1) + ' 条');
            return ls.join('\n');
          });
        }
      },
      {
        id: 'G9-2', kind: '注入违规', expect: 'caught', reason: /\[表格结构\]/,
        name: '在 §2 门禁表的两个 ID 行之间插一段引用块（markdown 表格一断即结束 ⇒ 后面的行掉出表格）',
        apply(M, c) {
          const row = c.gateRows[1] || c.gateRows[0];
          if (!row) throw new Error('§2 里找不到 ID 行，这一条测不了');
          return M.edit(c.rel, (s) => {
            const ls = s.split('\n');
            ls.splice(row.idx, 0, '', '> 变异注入：插进表格中间的旁注（真实事故形状：G6/G7/G8 曾这样掉出表格）');
            return ls.join('\n');
          });
        }
      },
      {
        id: 'G9-3', kind: '注入违规', expect: 'caught', reason: /\[悬挂引用\]/,
        name: '删掉一条**被别的文档引用过**的铁律定义行（引用不会跟着消失 ⇒ 悬挂引用）',
        apply(M, c) {
          if (!c.refRow) throw new Error('找不到"被引用过的铁律"，这一条测不了');
          return M.edit(c.rel, (s) => {
            const ls = s.split('\n');
            ls.splice(c.refRow.idx, 1);
            return ls.join('\n');
          });
        }
      },
      {
        id: 'G9-h', kind: '无害对照', expect: 'unchanged',
        name: '只在 RULES.md 末尾追加一行**不含数字与编号**的散文',
        apply: (M, c) => M.append(c.rel, '（变异对照：这一行不含任何数字与编号，门禁读数应与基线逐字相同）')
      },
      {
        id: 'G9-neg', kind: '负对照', expect: 'escape', reason: /\[条数不符\]/,
        name: '先把门禁**钝化**（副本里 analyze() 直接 return []）再注入 G9-1 的破坏 ⇒ 必须报"没拦下"',
        apply(M, c) {
          M.edit('scripts/rules-consistency.js', (s) => s.replace(
            'function analyze(rulesText, docTexts) {\n  const lines = String(rulesText || \'\').split(\'\\n\');',
            'function analyze(rulesText, docTexts) {\n  if (1) return [];   // 负对照：门禁被钝化\n'
            + '  const lines = String(rulesText || \'\').split(\'\\n\');'));
          const idx = c.claim.line - 1;
          return M.edit(c.rel, (s) => {
            const ls = s.split('\n');
            ls[idx] = ls[idx].replace(/共\s*\d+\s*条/, '共 ' + (c.claim.claimed + 1) + ' 条');
            return ls.join('\n');
          });
        }
      }
    ]
  },

  /* ---------------------------- S1 ---------------------------- */
  {
    id: 'dep-direction', code: 'S1', title: '单向依赖（依赖只许朝 rank 小的方向）',
    script: 'scripts/dep-direction-check.js', args: [],
    seam: '镜像 CLI 全链（真子进程 + 真 exit code）：输入 = 副本里的第一方源码文本'
      + '（src/ · renderer/ · cli/ · scripts/ · main*.js · preload.js）',
    discover(M) {
      const files = fs.readdirSync(path.join(M.root, 'src')).filter((f) => /\.js$/.test(f)).sort();
      return { target: 'src/' + files[0], srcFiles: files };
    },
    variants: [
      {
        id: 'S1-1', kind: '注入违规', expect: 'caught', reason: /\[S1-反向\]/,
        name: '在 src/ 的一个模块里加一条**反向** require（src rank 1 → renderer rank 4）',
        apply: (M, c) => M.append(c.target, EDGE.reverse)
      },
      {
        id: 'S1-2', kind: '注入违规', expect: 'caught', reason: /\[S1-环\]/,
        name: '让同一个模块 require 自己（同 rank 自环）',
        apply: (M, c) => M.append(c.target, EDGE.self(c.target))
      },
      {
        id: 'S1-3', kind: '注入违规', expect: 'caught', reason: /\[S1-图外\]/,
        name: '加一条指向"不在分层图内、也没登记豁免"的依赖（谁都得有个家）',
        apply: (M, c) => M.append(c.target, EDGE.outside)
      },
      {
        id: 'S1-h', kind: '无害对照', expect: 'unchanged',
        name: '只在同一个模块里加一行注释（门禁先剥注释再取边 ⇒ 读数应逐字不变）',
        apply: (M, c) => M.append(c.target, '// 变异对照：只加一行注释')
      },
      {
        id: 'S1-neg', kind: '负对照', expect: 'escape', reason: /\[S1-反向\]/,
        name: '先把门禁**钝化**（副本里 findReverseEdges 直接 return []）再加一条反向边 ⇒ 必须报"没拦下"',
        apply: (M, c) => {
          M.edit('scripts/dep-direction-check.js', (s) => s.replace(
            'function findReverseEdges(edges) {\n  const bad = [];',
            'function findReverseEdges(edges) {\n  const bad = [];\n  if (1) return bad;   // 负对照：门禁被钝化'));
          return M.append(c.target, EDGE.reverse);
        }
      }
    ]
  },

  /* -------------------------- G6 / G7 ------------------------- */
  {
    id: 'doc-facts', code: 'G6+G7', title: '文档数字与版本一致性 + 生成物未过期',
    script: 'scripts/doc-facts.js', args: ['--check'],
    seam: '镜像 CLI 全链（真子进程 + 真 exit code）：输入 = 副本里的受管 markdown + 生成物 + 真值来源；'
      + '副本没有 node_modules（裸包名走 NODE_PATH 指向真仓），'
      + '`AI_MINDMAP_UNIT_TESTS` 钉在副本 VERIFY.md 声明值上（否则它会去副本里跑一次 vitest ⇒ 采不到真值）',
    discover(M, baseline) {
      // 真值从**门禁自己的基线输出**里读（`printFacts` 会打出来）—— 不另抄一份口径
      const m = /CLI 命令数\s*:\s*(\d+)/.exec(baseline.out || '');
      return { commandsTruth: m ? Number(m[1]) : null, docRel: 'README.md' };
    },
    variants: [
      {
        id: 'DF-1', kind: '注入违规', expect: 'caught', reason: /\[CLI 命令数\]/,
        name: '往受管文档里写一行**假事实**（把 CLI 命令数写成 真值+1 —— "数字与真值不符"）',
        apply(M, c) {
          if (!c.commandsTruth) throw new Error('基线输出里没读出 CLI 命令数真值，这一条测不了');
          return M.append(c.docRel, '本工程有 ' + (c.commandsTruth + 1) + ' 个 CLI 命令（变异注入：这个数是假的）');
        }
      },
      {
        id: 'DF-2', kind: '注入违规', expect: 'caught', reason: /\[体量数字（KB\/MB）\]/,
        name: '注入一个**没有版本锚/历史标记**的体量数字（会被读成现状）',
        apply: (M, c) => M.append(c.docRel, '镜像体积已达 512 KB（变异注入：没有版本锚）')
      },
      {
        id: 'DF-3', kind: '注入违规', expect: 'caught', reason: /\[未来版本号\]/,
        name: '注入一个**高于发布版本**的 v 形版本号（且同行没有"计划/拟/预计"这类放行词）',
        apply: (M, c) => M.append(c.docRel, '构建号 v99.9.9 出现过（变异注入）')
      },
      {
        id: 'DF-c', kind: '无害对照', expect: 'unchanged',
        name: '往同一个文档写一行**真值正确**的命令数声明（够不着真值的工具会把它判红）',
        apply(M, c) {
          if (!c.commandsTruth) throw new Error('基线输出里没读出 CLI 命令数真值，这一条测不了');
          return M.append(c.docRel, '本工程有 ' + c.commandsTruth + ' 个 CLI 命令（变异对照：这里写的是真值）');
        }
      },
      {
        id: 'DF-h', kind: '无害对照', expect: 'unchanged',
        name: '只在文档末尾追加一行**不含数字**的散文（三张扫描面都该看不见它）',
        apply: (M, c) => M.append(c.docRel, '（变异对照：这一行不含任何数字，门禁读数应与基线逐字相同）')
      },
      {
        id: 'DF-neg', kind: '负对照', expect: 'escape', reason: /\[CLI 命令数\]/,
        name: '先把门禁**钝化**（副本里 scan() 直接 return []）再注入 DF-1 的假事实 ⇒ 必须报"没拦下"',
        apply(M, c) {
          M.edit('scripts/doc-facts.js', (s) => s.replace(
            'function scan(values) {\n  const hits = [];',
            'function scan(values) {\n  const hits = [];\n  if (1) return hits;   // 负对照：门禁被钝化'));
          if (!c.commandsTruth) throw new Error('基线输出里没读出 CLI 命令数真值，这一条测不了');
          return M.append(c.docRel, '本工程有 ' + (c.commandsTruth + 1) + ' 个 CLI 命令（变异注入：这个数是假的）');
        }
      }
    ]
  },

  /* ---------------------------- V1 ---------------------------- */
  {
    id: 'visibility-judge', code: 'V1', title: '可见性判据（名字声称可见 ⇒ 必须有真判据）',
    script: 'scripts/visibility-judge-check.js', args: [],
    seam: '镜像 CLI 全链（真子进程 + 真 exit code）：输入 = 副本里的脚本层源码文本'
      + '（scripts/smoke/NN-*.js）；靶点用门禁自己导出的纯函数 analyze()/REAL_JUDGES 在现场找',
    discover(M) {
      const vj = realModule('scripts/visibility-judge-check.js');
      const entries = vj.loadSmokeFiles(path.join(M.root, 'scripts', 'smoke'));
      const r = vj.analyze(entries);
      const ok = r.judged.filter((x) => x.verdict === 'ok');
      return {
        realJudgeTokens: vj.REAL_JUDGES.map((j) => j.token),
        visWords: vj.VIS_WORDS,
        judgeFile: ok.length ? ok[0].rel : null,
        judgeName: ok.length ? ok[0].name : null,
        anySmoke: entries.length ? entries[0].rel : null,
        baseline: { triggered: r.triggered, judged: ok.length, problems: r.problems.length }
      };
    },
    variants: [
      {
        id: 'V1-1', kind: '注入违规', expect: 'caught', reason: /条断言在名字里声称/,
        name: '把一条**有真判据**的可见性断言的真判据全换成 `getComputedStyle`（名字仍带可见性词 ⇒ 只剩盲判据）',
        apply(M, c) {
          if (!c.judgeFile) throw new Error('副本里找不到"有真判据"的可见性断言，这一条测不了');
          return M.edit(c.judgeFile, (s) => {
            let out = s;
            c.realJudgeTokens.forEach((tok) => { out = out.split(tok).join('getComputedStyle'); });
            return out;
          });
        }
      },
      {
        id: 'V1-2', kind: '注入违规', expect: 'caught', reason: /名字里声称可见性的断言只剩/,
        name: '把冒烟断言**名字**里的可见性词全删掉（"把名字里的词删掉就能让它闭嘴" ⇒ 下限判定必须拦住）',
        apply(M) {
          const dir = path.join(M.root, 'scripts', 'smoke');
          const files = fs.readdirSync(dir).filter((f) => /^\d+-.+\.js$/.test(f));
          const words = realModule('scripts/visibility-judge-check.js').VIS_WORDS;
          let touched = 0;
          files.forEach((f) => {
            const rel = 'scripts/smoke/' + f;
            const before = M.read(rel);
            const after = before.replace(/name:\s*'((?:[^'\\]|\\.)*)'/g, (all, nm) => {
              let n2 = nm;
              words.forEach((w) => { n2 = n2.split(w).join('已改名'); });
              return n2 === nm ? all : "name: '" + n2 + "'";
            });
            if (after !== before) { M.write(rel, after); touched++; }
          });
          if (!touched) throw new Error('冒烟断言名字里没有可见性词，这一条测不了');
          return { rel: 'scripts/smoke/*', touched };
        }
      },
      {
        id: 'V1-3', kind: '注入违规', expect: 'caught', reason: /条断言在名字里声称/,
        name: '注入一条"**名字里写着真实判据、代码里只有 rect**"的断言（判据写在名字里不算判据）',
        apply(M, c) {
          if (!c.anySmoke) throw new Error('副本里没有冒烟域文件，这一条测不了');
          return M.append(c.anySmoke, [
            '{',
            "  name: '变异注入探针：圆钮**完整落在面板内**（elementFromPoint 命中 + 真帧像素）',",
            '  run: async (ctx) => {',
            "    const w = await ctx.exec('JSON.stringify(mutProbeEl.getBoundingClientRect()).length');",
            '    return { ok: Number(w) > 8 };',
            '  }',
            '}'
          ].join('\n'));
        }
      },
      {
        id: 'V1-h', kind: '无害对照', expect: 'unchanged',
        name: '只在冒烟域源码里加一行注释（不含可见性词与判据字样 ⇒ 读数应逐字不变）',
        apply: (M, c) => M.append(c.anySmoke, '// 变异对照：只加一行注释')
      },
      {
        id: 'V1-neg', kind: '负对照', expect: 'escape', reason: /条断言在名字里声称/,
        name: '先把门禁**钝化**（副本里 judgeAssertion 无论怎么判都返回 ok）再注入 V1-1 的破坏 ⇒ 必须报"没拦下"',
        apply(M, c) {
          M.edit('scripts/visibility-judge-check.js', (s) => s.replace(
            "function judgeAssertion(rawRegion, srcRaw) {\n  const code = expandSnippets",
            'function judgeAssertion(rawRegion, srcRaw) {\n'
            + '  if (1) return { judges: [], real: [], exempt: null, blind: [], verdict: \'ok\' };   // 负对照：门禁被钝化\n'
            + '  const code = expandSnippets'));
          if (!c.judgeFile) throw new Error('副本里找不到"有真判据"的可见性断言，这一条测不了');
          return M.edit(c.judgeFile, (s) => {
            let out = s;
            c.realJudgeTokens.forEach((tok) => { out = out.split(tok).join('getComputedStyle'); });
            return out;
          });
        }
      }
    ]
  },

  /* ---------------------------- G8 ----------------------------
   * 为什么给 G8 补这一条（2026-10-16 T4 批）：14 条门禁里当时只有 G9 / S1 / V1（＋与 G6 共用脚本的 G7）
   * 有变异体检，而 G8 **是本工程唯一检出过真事故的门禁** ——
   *   事故③「台账说 L10 已落地，仓库里根本没那个文件」= 本批变体 `G8-3`（判定 ③ 悬挂登记）；
   *   事故④「`mutate-gates.js` 被文档点名却从未提交」  = 本批变体 `G8-7`（判定 ⑦ 代码未入档）。
   * 也就是说：**最有用的一条门禁，此前没人证明过它会红**。本条目把它的每一条判定逐条撞一遍。
   * 判定编号（①…⑮）不在本文件抄一份 —— 权威清单是 `node scripts/docs-registry-check.js --judgments`；
   * 变体只挂"我撞的是哪一号"，缺号由 `tests/mutate-gates.test.js` 的覆盖用例现算。
   * ------------------------------------------------------------ */
  {
    id: 'docs-registry', code: 'G8', title: '文档体系完整性（16 条判定）',
    script: 'scripts/docs-registry-check.js', args: [],
    seam: '镜像 CLI 全链（真子进程 + 真 exit code）：输入 = 副本里的文档 / 源码 / 归档 / 工作目录；'
      + '靶点一律用门禁**自己导出的纯函数**在现场找（`parseRegistryTable` / `collectDocHeaders` / '
      + '`parseStabilityTable` / `REG_END` / `REGISTRY_DOC`），不在本工具里另抄一份判定口径。'
      + '副本刻意不复制 `.review/`（工作产物区，重且天天在动）⇒ `prepareMirror()` 按 `docs/ROADMAP.md`'
      + '「在飞 / 未收口」的指针把**目录存在性**补出来（第 ⑥ 条判的就是它、第 ⑨ 条判"有没有 README"）。'
      + '不补的话基线会因"副本不完整"而红 —— 那是本工具的假红，不是门禁的读数 ✗。',
    /** 副本忠实性（在**取基线之前**跑）：把「在飞 / 未收口」指针指向的 `.review/<目录>` 补成"目录 + README"。
     *  ⚠️ 用裸 `fs` 写、**刻意不走 `M.write()`**：这几份属于**副本构造**，必须活过每一次 `restore()`
     *  否则后面每条变体都在"指针已死"的副本上跑，无害对照会立刻变成假红。 */
    prepareMirror(M) {
      const made = [];
      const rel = 'docs/ROADMAP.md';
      if (!fs.existsSync(path.join(M.root, rel))) return made;
      const lines = M.read(rel).split('\n');
      const start = lines.findIndex((l) => /^##\s.*在飞\s*\/\s*未收口/.test(l));
      if (start < 0) return made;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
      /** 一个目录在副本里补 README（G8 第 ⑨ 条：`.review` 的直接子目录必须有 README 声明死活）。
       *  只给 `.review/<第一段>` 这一层补 —— 与门禁的检查口径一致，不多补。 */
      const ensureTopReadme = (refDir) => {
        const seg = refDir.split('/');
        if (seg[0] !== '.review' || seg.length < 2) return;
        const top = path.join(M.root, seg[0], seg[1]);
        if (!fs.existsSync(top)) { fs.mkdirSync(top, { recursive: true }); made.push(seg[0] + '/' + seg[1] + '/'); }
        const rm = path.join(top, 'README.md');
        if (!fs.existsSync(rm)) {
          fs.writeFileSync(rm, '# 副本存根（变异体检）\n\n真仓里这个工作目录的内容不进副本；'
            + '这里只补**存在性**，因为 G8 第 ⑥/⑨ 条读的正是"目录在不在 / 有没有 README"。\n', 'utf8');
          made.push(seg[0] + '/' + seg[1] + '/README.md');
        }
      };
      const seen = new Set();
      lines.slice(start, end).forEach((l) => {
        for (const m of l.matchAll(/`(\.review\/[^`\s]+)`/g)) {
          const ref = m[1].replace(/[\\/]+$/, '');
          if (/[<>*]/.test(ref) || seen.has(ref)) continue;   // 占位写法不是真指针（与门禁同口径）
          seen.add(ref);
          // 指针可能指向**目录**，也可能指向目录里的**一份文件**（实测两种都有）——
          // 两种都要让 `fs.existsSync(ref)` 成立，但只有"目录"那种要自带 README。
          const asFile = /\.(md|html?|json|jsonl|js|txt|png)$/i.test(ref);
          const abs = path.join(M.root, ref.split('/').join(path.sep));
          if (asFile) {
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            ensureTopReadme(ref.slice(0, ref.lastIndexOf('/')));
            if (!fs.existsSync(abs)) { fs.writeFileSync(abs, '（副本存根：内容不进副本）\n', 'utf8'); made.push(ref); }
          } else {
            if (!fs.existsSync(abs)) { fs.mkdirSync(abs, { recursive: true }); made.push(ref + '/'); }
            ensureTopReadme(ref);
          }
        }
      });
      return made;
    },
    discover(M) {
      const dr = realModule('scripts/docs-registry-check.js');
      const arch = M.read('docs/ARCHITECTURE.md');
      const reg = dr.parseRegistryTable(arch);
      if (!reg.found) throw new Error('副本里找不到 §5 登记表（§5 段缺失）⇒ 判定 ①/③/⑩ 的靶点无从找起');
      const archLines = arch.split('\n');

      // ③（悬挂登记）：在 §5 表**末尾**（END 标记之前）插一行指向不存在文件的登记
      const regEndLine = archLines.findIndex((l) => l.includes(dr.REG_END)) + 1;

      // ⑤（归档重复）：拿一份**已归档**的版本号，把它的段再写回主文件（真事故的形状：两边各活一半）
      let dupVersion = null;
      let archiveDoc = null;
      const archDir = path.join(M.root, 'docs', 'changelog');
      if (fs.existsSync(archDir)) {
        const main = M.read('CHANGELOG.md');
        const vers = fs.readdirSync(archDir).filter((f) => /^v.+\.md$/i.test(f)).sort();
        dupVersion = vers.map((f) => f.replace(/\.md$/i, ''))
          .find((v) => !new RegExp('^## \\[' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'm').test(main))
          || null;
        archiveDoc = vers.length ? 'docs/changelog/' + vers[0] : null;
      }

      // ⑥（交接死指针）：插在「在飞 / 未收口」小节的表格里（小节与表头都在现场找，不写死行号）
      let roadIdx = -1;
      if (fs.existsSync(path.join(M.root, 'docs', 'ROADMAP.md'))) {
        const ls = M.read('docs/ROADMAP.md').split('\n');
        const s0 = ls.findIndex((l) => /^##\s.*在飞\s*\/\s*未收口/.test(l));
        if (s0 >= 0) {
          let e0 = ls.length;
          for (let i = s0 + 1; i < ls.length; i++) if (/^##\s/.test(ls[i])) { e0 = i; break; }
          let sep = -1;
          for (let i = s0; i < e0; i++) if (/^\|\s*:?-{2,}/.test(ls[i])) { sep = i; break; }
          roadIdx = (sep >= 0 ? sep : s0) + 1;
        }
      }

      // ⑦（代码未入档）：文件名必须在架构文档里**查不到** —— 查得到就说明靶点会撞上
      // "文件名子串也算登记"这条已知假绿（T5 记账：`src/editor.js` / `src/s.js` 会假绿），
      // 那时这一条**测不了**，如实记未测，不许拿一个假绿当读数。
      const moduleProbe = 'src/zz-t4-unregistered-probe.js';
      const moduleProbeVisible = arch.includes(path.posix.basename(moduleProbe));
      const archHasArchitecture = arch.includes('ARCHITECTURE.md');

      // ⑩（导航不可达）：挑一份**按文件名在 SKILL.md 里能查到**的登记文档，给它改名
      const skill = M.read('SKILL.md');
      const navDoc = [...reg.exact].filter((x) => x.includes('/') && fs.existsSync(path.join(M.root, x)))
        .map((x) => ({ rel: x, base: x.slice(x.lastIndexOf('/') + 1) }))
        .filter((o) => skill.includes(o.base)
          && [...reg.exact].filter((y) => y.includes(o.base)).length === 1)[0] || null;

      // ⑬ / ⑭（元信息与生成的登记表）：挑一份**有合格元信息**的受管文档
      //（排除 §5 的载体本身：改它的元信息会同时搅动 §5，两个判定会互相顶）
      const headers = dr.collectDocHeaders(M.root)
        .filter((e) => e.state === 'ok' && e.meta && e.rel.startsWith('docs/') && e.rel !== dr.REGISTRY_DOC);
      const headerDoc = headers.length ? headers[0].rel : null;

      // ⑫（章节断号）：挑一份**有编号章节**的 docs/*.md，在末尾插一个跳号章节
      const numDeny = new Set(['ARCHITECTURE.md', 'ROADMAP.md', 'DATA-FORMAT.md', 'EXTENSIONS.md',
        'RULES.md', 'CLI.md', 'VERIFY.md']);
      let numberingDoc = null;
      fs.readdirSync(path.join(M.root, 'docs')).filter((f) => /\.md$/i.test(f) && !numDeny.has(f)).sort()
        .forEach((f) => {
          if (numberingDoc) return;
          const rel = 'docs/' + f;
          const tops = (M.read(rel).match(/^##\s+(\d+)\./gm) || []).map((h) => Number(/^##\s+(\d+)\./.exec(h)[1]));
          if (!tops.length) return;
          numberingDoc = { rel, gap: Math.max.apply(null, tops) + 2 };
        });

      // ⑪a（契约缺字段）：`layout` 是契约里真实存在、且**不由 schema 校验**的那个字段
      //（它正是判定 ⑪ 的出处：`meta.layout` 曾经在契约里根本没写）
      const contractField = 'layout';
      const contractFieldPresent = /\blayout\b/.test(M.read('docs/DATA-FORMAT.md'));

      // ⑮（CLI 稳定性表覆盖）：挑一条**在整份文档里只出现一次**的注册表命令，把它从 §1.2 表里漏掉
      let stabilityCmd = null;
      try {
        const ext = M.read('docs/EXTENSIONS.md');
        const tab = dr.parseStabilityTable(ext);
        stabilityCmd = realModule('cli/registry.js').list().map((c) => c.name)
          .filter((n) => tab && tab.cmds.has(n)
            && (ext.match(new RegExp('`' + n + '`', 'g')) || []).length === 1)[0] || null;
      } catch (e) { stabilityCmd = null; }

      // ⑯（整行重复）：找一条**表格数据行**（不是表头、不是分隔行），靶点用门禁自己的
      // `tableDataRows()` 现场找 —— 本工具不另抄一份"什么算数据行"的口径。
      // 优先挑**两份文档以上都能命中**的那份：`docs/ARCHITECTURE.md`（表格最多，且它就是真实事故的现场）。
      let dupRow = null;
      for (const rel of ['docs/ARCHITECTURE.md', 'docs/DATA-FORMAT.md', 'docs/RULES.md',
        'docs/EXTENSIONS.md', 'docs/VERIFY.md']) {
        if (!fs.existsSync(path.join(M.root, rel))) continue;
        const rows = dr.tableDataRows(M.read(rel));
        for (const [line, idxs] of rows) {
          // 行号 0 基 ⇒ 插到它**后面**；避开表格最后一行（那里插入会贴到下一段之外）
          if (!idxs.length || line.trim().length < 20) continue;
          dupRow = { rel, idx: idxs[0], line };
          break;
        }
        if (dupRow) break;
      }

      return {
        regEndLine, dupVersion, archiveDoc, roadIdx, moduleProbe, moduleProbeVisible, archHasArchitecture,
        navDoc, headerDoc, numberingDoc, contractField, contractFieldPresent, stabilityCmd, dupRow,
        regCount: reg.exact.size, docsScanned: M.read('SKILL.md').length
      };
    },
    variants: [
      {
        id: 'G8-1', judgment: '①', kind: '注入违规', expect: 'caught', reason: /\[表外文档\]/,
        name: '在 `docs/` 下造一份**没进 §5 登记表**的文档（"这份文档没有家"）',
        apply: (M) => M.write('docs/PROBE-T4-UNREGISTERED.md',
          '# 变异注入探针（未登记）\n\n这一份故意不进 §5 登记表。\n')
      },
      {
        id: 'G8-2', judgment: '②', kind: '注入违规', expect: 'caught', reason: /\[家目录非法\]/,
        name: '把一份 .md 放到 `src/` 下（文档只能住在 `docs/` 或 `renderer/` 的应用 HTML）',
        apply: (M) => M.write('src/PROBE-T4-STRAY.md', '# 变异注入探针（放错家门）\n')
      },
      {
        id: 'G8-3', judgment: '③', kind: '注入违规', expect: 'caught', reason: /\[悬挂登记\]/,
        name: '往 §5 表加一行**指向不存在文件**的登记（真实事故③的形状：台账说已落地、仓库里没那个文件）',
        apply(M, c) {
          if (!c.regEndLine) throw new Error('§5 里找不到 END 标记，这一条测不了');
          return M.edit('docs/ARCHITECTURE.md', (s) => {
            const ls = s.split('\n');
            ls.splice(c.regEndLine - 1, 0,
              '| 记录 | `docs/PROBE-T4-GHOST.md` | 变异注入探针（磁盘上不存在） | 无 | 无 |');
            return ls.join('\n');
          });
        }
      },
      {
        id: 'G8-4', judgment: '④', kind: '注入违规', expect: 'caught', reason: /\[乱放\]/,
        name: '往**工程根**扔一个不在白名单里的文件（"AI 在工程根随手写 report"）',
        apply: (M) => M.write('PROBE-T4-STRAY.bin', 'probe\n')
      },
      {
        id: 'G8-5', judgment: '⑤', kind: '注入违规', expect: 'caught', reason: /\[历史重复\]/,
        name: '把一份**已归档**的版本段再写回 `CHANGELOG.md`（同一段历史两处副本；两边都不进 G6 扫描）',
        apply(M, c) {
          if (!c.dupVersion) throw new Error('docs/changelog/ 里找不到"主文件里已经没有它"的版本号，这一条测不了');
          return M.append('CHANGELOG.md',
            '## [' + c.dupVersion + '] 变异注入：这一段同时躺在 docs/changelog/ 与主文件里\n');
        }
      },
      {
        id: 'G8-6', judgment: '⑥', kind: '注入违规', expect: 'caught', reason: /\[交接死指针\]/,
        name: '在「在飞 / 未收口」小节里插一个指向**不存在目录**的证据指针（接手者白找一场）',
        apply(M, c) {
          if (c.roadIdx < 0) throw new Error('docs/ROADMAP.md 里找不到「在飞 / 未收口」小节，这一条测不了');
          return M.edit('docs/ROADMAP.md', (s) => {
            const ls = s.split('\n');
            ls.splice(c.roadIdx, 0, '| **在飞** | 变异注入探针 | 目录不存在 | 无 | `.review/PROBE-T4-GHOST/` |');
            return ls.join('\n');
          });
        }
      },
      {
        id: 'G8-7', judgment: '⑦', kind: '注入违规', expect: 'caught', reason: /\[代码未入档\]/,
        name: '造一个**架构文档里查不到**的 `src/` 模块（新代码不进文档 ⇒ 接手者不知道它存在）',
        apply(M, c) {
          if (c.moduleProbeVisible) {
            throw new Error('探针文件名在架构文档里已经存在（会撞上"文件名子串也算登记"的已知假绿）'
              + '，这一条测不了 —— 要测须另挑一个文档里不出现的名字');
          }
          return M.write(c.moduleProbe, '// 变异注入：一个谁也没登记过的 src 模块\n');
        }
      },
      {
        id: 'G8-8', judgment: '⑧', kind: '注入违规', expect: 'caught', reason: /\[归档缺横幅\]/,
        name: '往 `docs/archive/` 造一份**开头 8 行没有任何历史标记**的旧稿（归档仍会被 grep 到）',
        apply: (M) => M.write('docs/archive/PROBE-T4-NO-BANNER.md',
          '# 变异注入探针：归档但没有横幅\n\n（开头 8 行内不含任何提示词；这份文件会被当成现状引用）\n')
      },
      {
        id: 'G8-9', judgment: '⑨', kind: '注入违规', expect: 'caught', reason: /\[工作目录无状态\]/,
        name: '在 `.review/` 下造一个**没有 README** 的工作目录（接手者无法判断能否删除）',
        apply: (M) => M.mkdir('.review/PROBE-T4-NO-README')
      },
      {
        id: 'G8-10', judgment: '⑩', kind: '注入违规', expect: 'caught', reason: /\[导航不可达\]/,
        name: '把一份受管文档在 `SKILL.md` 导航里的名字改掉（登记了却从第一屏找不到 = 等于没有这份文档）',
        apply(M, c) {
          if (!c.navDoc) throw new Error('找不到"按文件名出现在 SKILL.md 里"的登记文档，这一条测不了');
          const to = c.navDoc.base.replace(/\.md$/i, '-已改名.md');
          return M.edit('SKILL.md', (s) => s.split(c.navDoc.base).join(to));
        }
      },
      {
        id: 'G8-11a', judgment: '⑪', kind: '注入违规', expect: 'caught', reason: /\[契约缺字段\]/,
        name: '把 `docs/DATA-FORMAT.md` 里的字段名 `layout` 全部改名（契约失守：照着契约改就会漏）',
        apply(M, c) {
          if (!c.contractFieldPresent) throw new Error('契约里没有 `layout` 这个词，这一条测不了');
          return M.edit('docs/DATA-FORMAT.md', (s) => {
            const out = s.replace(new RegExp('\\b' + c.contractField + '\\b', 'g'), c.contractField + 'X');
            if (out === s) throw new Error('变异没有生效');
            if (new RegExp('\\b' + c.contractField + '\\b').test(out)) throw new Error('还有残留的字段名，变异不彻底');
            return out;
          });
        }
      },
      {
        id: 'G8-11b', judgment: '⑪', kind: '注入违规', expect: 'caught', reason: /\[检查表过期\]/,
        name: '在副本的 `src/schema.js` 里出现一个**没进 `SCHEMA_FIELDS` 清单**的字段（新字段永远不会被检查）',
        apply: (M) => M.append('src/schema.js',
          '\n// 变异注入：node.probeT4Field —— 本判定读的是**源码文本**，所以这个写法也会被抓到\nvoid 0;\n')
      },
      {
        id: 'G8-12', judgment: '⑫', kind: '注入违规', expect: 'caught', reason: /\[章节断号\]/,
        name: '在一份受管文档末尾插一个**跳号**的一级章节（读者会去找一个不存在的节）',
        apply(M, c) {
          if (!c.numberingDoc) throw new Error('docs/ 里找不到带编号章节的文档，这一条测不了');
          return M.edit(c.numberingDoc.rel, (s) => s.replace(/\s*$/, '')
            + '\n\n## ' + c.numberingDoc.gap + '. 变异注入探针（故意跳号）\n\n（上一节的编号加二）\n');
        }
      },
      {
        id: 'G8-13', judgment: '⑬', kind: '注入违规', expect: 'caught', reason: /\[登记表过期\]/,
        name: '手改一份文档头部元信息的 `作用` 行但不重生成 §5 表（表是生成的，不是手写的）',
        apply(M, c) {
          if (!c.headerDoc) throw new Error('副本里找不到带合格元信息的受管文档，这一条测不了');
          return M.edit(c.headerDoc, (s) => {
            const out = s.replace(/^(\s*作用[:：]\s*).+$/m, '$1变异注入：这句作用被手改了（登记表没重生成）');
            if (out === s) throw new Error('没找到 `作用` 行，这一条测不了');
            return out;
          });
        }
      },
      {
        id: 'G8-14', judgment: '⑭', kind: '注入违规', expect: 'caught', reason: /\[层不在取值表\]/,
        name: '把一份文档元信息的 `层` 改成**取值表里没有的值**（值不在表内 = 配置错误，不是文档错误）',
        apply(M, c) {
          if (!c.headerDoc) throw new Error('副本里找不到带合格元信息的受管文档，这一条测不了');
          return M.edit(c.headerDoc, (s) => {
            const out = s.replace(/^(\s*层[:：]\s*).+$/m, '$1变异注入不存在的层');
            if (out === s) throw new Error('没找到 `层` 行，这一条测不了');
            return out;
          });
        }
      },
      {
        id: 'G8-15', judgment: '⑮', kind: '注入违规', expect: 'caught', reason: /稳定性三级表漏登记/,
        name: '把一条注册表里的命令从 `docs/EXTENSIONS.md` §1.2 的三级表里漏掉（谁都不知道能不能依赖它）',
        apply(M, c) {
          if (!c.stabilityCmd) throw new Error('找不到"只在 §1.2 表里出现一次"的注册表命令，这一条测不了');
          const tok = '`' + c.stabilityCmd + '`';
          return M.edit('docs/EXTENSIONS.md', (s) => {
            const ls = s.split('\n');
            const s0 = ls.findIndex((l) => /^###\s*1\.2\b/.test(l));
            if (s0 < 0) throw new Error('§1.2 段找不到');
            let e0 = ls.length;
            for (let i = s0 + 1; i < ls.length; i++) {
              if (/^###\s/.test(ls[i]) || /^##\s/.test(ls[i])) { e0 = i; break; }
            }
            for (let i = s0; i < e0; i++) {
              if (ls[i].includes(tok)) { ls[i] = ls[i].replace(tok, '`' + c.stabilityCmd + '-已漏掉`'); break; }
            }
            const out = ls.join('\n');
            if (out === s) throw new Error('§1.2 表里没有 ' + tok + '，这一条测不了');
            const tab = realModule('scripts/docs-registry-check.js').parseStabilityTable(out);
            if (tab && tab.cmds.has(c.stabilityCmd)) throw new Error('命令还在表里（变异不彻底）');
            return out;
          });
        }
      },
      {
        id: 'G8-16', judgment: '⑯', kind: '注入违规', expect: 'caught', reason: /\[整行重复\]/,
        name: '把同一条**表格数据行**再写一遍（真实事故的形状：`137ab3e` 的"还原 + 登记"两步叠加，'
          + '实测写出过 3 组、共 −6,882 B，当时全链是绿的）',
        apply(M, c) {
          if (!c.dupRow) throw new Error('副本里找不到可复用的表格数据行，这一条测不了');
          return M.edit(c.dupRow.rel, (s) => {
            const ls = s.split('\n');
            // 行号是 1 基 ⇒ 数组下标 idx-1；把这一行**原样再插一份**到它后面（相邻重复 = 事故的形状）
            const at = c.dupRow.idx - 1;
            if (ls[at] !== c.dupRow.line) throw new Error('靶点行已被别处改动，这一条测不了');
            ls.splice(at + 1, 0, ls[at]);
            return ls.join('\n');
          });
        }
      },
      {
        id: 'G8-h', kind: '无害对照', expect: 'unchanged',
        name: '只在**已归档**版本段的末尾追加一行散文（归档族只增不改 ⇒ 读数应逐字不变）',
        apply(M, c) {
          if (!c.archiveDoc) throw new Error('docs/changelog/ 里没有归档版本段，这一条测不了');
          return M.append(c.archiveDoc, '（变异对照：这一行不含任何数字与版本段标记，门禁读数应与基线逐字相同）');
        }
      },
      {
        id: 'G8-h2', kind: '无害对照', expect: 'unchanged',
        name: '只在 `.review/` 里写一份**非文档**工作产物（工作产物区任意文件都允许 ⇒ 读数应逐字不变）',
        // ⚠️ 刻意用 `.txt` 而不是 `.md`：`collectDocs()` 会把 `.review/*.md` 也算进"有家的文档"，
        // 于是成功行里的份数从 N 变 N+1 —— 那不是"门禁动了"，而是**这条对照本来就会动一个读数**。
        // 选 `.txt` 才能把"工作产物区的豁免"这一件事单独隔出来测。
        apply: (M) => M.write('.review/PROBE-T4-HARMLESS.txt',
          '变异对照：工作产物区的一份稿子，不该动任何判定。\n')
      },
      {
        id: 'G8-neg', judgment: '⑦', kind: '负对照', expect: 'escape', reason: /\[代码未入档\]/,
        name: '先把门禁**钝化**（副本里 `checkModuleCoverage` 直接 return []）再注入 G8-7 的未入档模块 ⇒ 必须报"没拦下"',
        apply(M, c) {
          M.edit('scripts/docs-registry-check.js', (s) => s.replace(
            'function checkModuleCoverage(root) {\n  const problems = [];',
            'function checkModuleCoverage(root) {\n  const problems = [];\n'
            + '  if (1) return problems;   // 负对照：门禁被钝化'));
          return M.write(c.moduleProbe, '// 变异注入：一个谁也没登记过的 src 模块\n');
        }
      }
    ]
  }
];

/** 真仓的门禁模块（`require` 零副作用 —— 每份门禁都带 `require.main === module` 守卫，
 *  所以本工具能借它们的**导出**在现场找靶点，而不是另抄一份口径）。 */
function realModule(rel) { return require(path.join(REPO, rel)); }

/* ===============================================================
 * 主流程
 * =============================================================== */
function sha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); }
  catch (e) { return null; }
}

function firstLine(out, re) {
  if (re) {
    const hit = String(out).split('\n').find((l) => re.test(l));
    if (hit) return hit.trim().slice(0, 150);
  }
  const bad = String(out).split('\n').find((l) => /✗|失败|错误|Error/.test(l));
  return (bad || String(out).split('\n').filter(Boolean).slice(-1)[0] || '').trim().slice(0, 150);
}

function summarize(variants) {
  const s = { total: variants.length, caught: 0, escaped: 0, asExpected: 0, falseAlarm: 0, untested: 0, silent: 0 };
  variants.forEach((v) => { s[v.verdict] = (s[v.verdict] || 0) + 1; });
  s.arithmeticOk = s.total === s.caught + s.escaped + s.asExpected + s.falseAlarm + s.untested + s.silent;
  return s;
}

function buildReport() {
  const args = process.argv.slice(2);
  const opt = {
    json: args.includes('--json'),
    strict: args.includes('--strict'),
    keep: args.includes('--keep'),
    out: (args.find((a) => a.startsWith('--out=')) || '').slice(6) || null,
    only: (args.find((a) => a.startsWith('--only=')) || '').slice(7)
  };
  const log = (s) => { if (!opt.json) process.stdout.write(s + '\n'); else process.stderr.write(s + '\n'); };

  const selected = GATES.filter((g) => !opt.only || opt.only.split(',').map((x) => x.trim()).includes(g.id));
  const report = {
    tool: 'scripts/mutate-gates.js',
    generatedAt: new Date().toISOString(),
    repo: REPO,
    mode: { only: opt.only || '(全部)', strict: !!opt.strict, keep: !!opt.keep },
    envError: null,
    mirror: { dir: '(已自清)', copiedFiles: 0, ms: 0 },
    unitTestsPin: null,
    repoHashesBefore: null, repoHashesAfter: null, repoUnchanged: null,
    gates: [], summary: null, selfCheck: null,
    knownGaps: [
      '只测这五个门禁（G9 / S1 / G6+G7 / V1 / G8）；G1·G2·G3·G4·G5·V2·S2·S3 未测（要起 Electron 或跑全链）',
      '变体是手工挑的三条 + 对照（G8 例外：每条判定各一条）：能回答"这几类破坏拦不拦"，'
        + '除 G8 外回答不了覆盖率',
      '测的是门禁，不是产品行为（产品靠 G3/G4/G5）'
    ]
  };

  if (!selected.length) { report.envError = '--only 没有选中任何门禁'; return report; }

  report.repoHashesBefore = GATES.map((g) => g.script).concat(['docs/RULES.md'])
    .map((rel) => ({ rel, sha: sha256(path.join(REPO, rel)) }));

  let mirror = null;
  try {
    const t0 = Date.now();
    mirror = makeMirror();
    report.mirror.ms = Date.now() - t0;
    report.mirror.copiedFiles = countFiles(mirror.root);
    const M = makeMirrorApi(mirror.root);
    const pin = unitTestsPin(mirror.root);
    report.unitTestsPin = pin;
    const env = gateEnv(mirror.root, pin);
    log('== 门禁变异体检（scripts/mutate-gates.js）==');
    log('  真仓（只读）：' + REPO);
    log('  副本（可写）：' + mirror.root + '（' + report.mirror.copiedFiles + ' 个文件 / '
      + report.mirror.ms + ' ms；结束自清，除非 --keep）');
    log('  真值钉子：AI_MINDMAP_UNIT_TESTS=' + pin.unitTests + '（来源：' + pin.source + '）');
    log('  被判的门禁：' + selected.map((g) => g.code + ' ' + g.id).join(' · '));

    const allVariants = [];
    for (const g of selected) {
      log('');
      log('── ' + g.code + ' ' + g.title + '（' + g.script + '）──');
      log('   注在哪一层：' + g.seam);
      const row = { id: g.id, code: g.code, title: g.title, script: g.script, seam: g.seam, baseline: null, variants: [] };

      // **副本忠实性前置**：必须在**取基线之前**跑。它做的事是"把副本补全到门禁真正会读的样子"
      //（不是注入）—— 若留到 discover()（基线之后）才补，基线会被"副本不完整"染红，
      // 而那正是本工具最不该冒充成读数的东西（照纪律乙：红必须是新红）。
      // 用裸 `fs` 写、不走 `M.write()`：前置件属于**副本**，不该被 `restore()` 撤销。
      if (typeof g.prepareMirror === 'function') {
        try {
          const made = g.prepareMirror(M) || [];
          if (made.length) log('   副本前置（不是注入）：' + made.join('、'));
        } catch (e) {
          report.envError = '副本前置失败：' + g.id + '（' + ((e && e.message) || e) + '）';
          row.baseline = { exit: null, ms: 0, spawnError: report.envError };
          log('   ✗ ' + report.envError);
          report.gates.push(row);
          break;
        }
      }

      const base = runGate(mirror.root, g, env);
      if (base.spawnError || base.exit === null) {
        row.baseline = { exit: base.exit, ms: base.ms, spawnError: base.spawnError };
        report.envError = '门禁跑不起来：' + g.script + '（' + (base.spawnError || '超时/被杀') + '）';
        log('   ✗ 基线都跑不起来：' + report.envError);
        report.gates.push(row);
        break;
      }
      row.baseline = { exit: base.exit, ms: base.ms, head: firstLine(base.out, null) };
      log('   基线（未变异副本）：exit ' + base.exit + ' · ' + base.ms + ' ms'
        + (base.exit === 0 ? ' ✓' : ' ⚠ 基线本来就红（下面每条变体都要与它比"新原因"）')
        + ' ｜ ' + row.baseline.head);

      let ctx = null;
      try { ctx = g.discover ? g.discover(M, base) : {}; }
      catch (e) { ctx = null; report.gates.push(row); log('   ⚠ 靶点探测失败（本门禁全部记未测）：' + (e && e.message)); }
      row.discovered = ctx ? Object.keys(ctx).filter((k) => k !== 'rc') : null;

      for (const v of g.variants) {
        if (ctx === null) {
          const rec = { id: v.id, kind: v.kind, name: v.name, expect: v.expect, verdict: 'untested',
            note: '靶点探测失败（见上）', exit: null, ms: 0, evidence: null };
          row.variants.push(rec); allVariants.push(rec); continue;
        }
        let mut = null, applyError = null;
        try { v.apply(M, ctx); } catch (e) { applyError = (e && e.message) || String(e); }
        if (applyError) {
          const rec = { id: v.id, kind: v.kind, name: v.name, expect: v.expect, verdict: 'untested',
            note: '变异没落下去：' + applyError, exit: null, ms: 0, evidence: null };
          row.variants.push(rec); allVariants.push(rec);
          log('   [未测 ⚠] ' + v.id + ' ' + v.kind + '：' + v.name + '\n            ' + rec.note);
          M.restore();
          continue;
        }
        mut = runGate(mirror.root, g, env);
        const verdict = classify(v, base, mut);
        const rec = {
          id: v.id, kind: v.kind, name: v.name, expect: v.expect, verdict,
          reason: v.reason ? String(v.reason) : null,
          exit: mut.exit, ms: mut.ms,
          evidence: firstLine(mut.out, v.reason || null),
          note: mut.spawnError || null
        };
        row.variants.push(rec); allVariants.push(rec);
        const box = verdict === 'caught' || verdict === 'asExpected' ? '✓'
          : verdict === 'untested' ? '⚠' : '✗';
        log('   [' + VERDICT[verdict] + ' ' + box + '] ' + v.id + ' ' + v.kind + '：' + v.name);
        log('            期望 ' + v.expect + ' ｜ exit ' + mut.exit + '（基线 ' + base.exit + '）· ' + mut.ms + ' ms'
          + ' ｜ ' + (rec.evidence || '(无输出)'));
        M.restore();
      }
      report.gates.push(row);
    }

    report.summary = summarize(allVariants);
    const harmless = allVariants.filter((v) => v.expect === 'unchanged');
    const neg = allVariants.filter((v) => v.expect === 'escape');
    report.selfCheck = {
      harmlessTotal: harmless.length,
      harmlessAsExpected: harmless.filter((v) => v.verdict === 'asExpected').length,
      harmlessFalseAlarm: harmless.filter((v) => v.verdict === 'falseAlarm').length,
      negTotal: neg.length,
      negAsExpected: neg.filter((v) => v.verdict === 'asExpected').length,
      negFalseAlarm: neg.filter((v) => v.verdict === 'falseAlarm').length,
      note: '无害对照（只改注释/空白）必须"读数逐字不变"（否则记假红）；'
        + '负对照（先把门禁钝化再注入真违规）必须"没拦下"（否则记假红）——'
        + '两条一起证明本工具既会报拦下、也会报漏过，不是恒真。'
    };
  } catch (e) {
    report.envError = '体检中途失败：' + ((e && e.stack) || e);
  } finally {
    if (mirror && !opt.keep) {
      try { fs.rmSync(mirror.home, { recursive: true, force: true }); }
      catch (e) { process.stderr.write('⚠ 副本自清失败（请手工删）：' + mirror.home + '\n'); }
    } else if (mirror) {
      report.mirror.dir = mirror.root;
    }
  }

  report.repoHashesAfter = GATES.map((g) => g.script).concat(['docs/RULES.md'])
    .map((rel) => ({ rel, sha: sha256(path.join(REPO, rel)) }));
  report.repoUnchanged = JSON.stringify(report.repoHashesBefore) === JSON.stringify(report.repoHashesAfter);

  const exit = exitCodeFor(report, opt);
  report.exitCode = exit;
  return report;
}

function countFiles(dir) {
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  })(dir);
  return n;
}

function printHuman(report) {
  const s = report.summary;
  console.log('');
  console.log('── 汇总 ──');
  if (s) {
    console.log('  变异体 ' + s.total + ' · 拦下 ' + s.caught + ' · 漏过 ' + s.escaped
      + ' · 符合预期 ' + s.asExpected + ' · 假红 ' + s.falseAlarm + ' · 未测 ' + s.untested
      + ' · 静默 ' + s.silent);
    console.log('  （自检：' + s.total + ' = ' + s.caught + '+' + s.escaped + '+' + s.asExpected + '+'
      + s.falseAlarm + '+' + s.untested + '+' + s.silent + ' '
      + (s.arithmeticOk ? '✓' : '✗ 账不平') + '）');
  }
  const escaped = [];
  report.gates.forEach((g) => g.variants.forEach((v) => { if (v.verdict === 'escaped') escaped.push(g.code + ' ' + v.id); }));
  if (escaped.length) {
    console.log('  ✗ 漏过（破坏没被拦住，点名）：' + escaped.join(' · '));
  } else if (s) {
    console.log('  ✓ 没有漏过');
  }
  const sc = report.selfCheck;
  if (sc) {
    console.log('');
    console.log('── 自证：本工具不是恒真 ──');
    console.log('  无害对照 ' + sc.harmlessTotal + ' 条 ⇒ 读数逐字不变 ' + sc.harmlessAsExpected
      + ' 条 · 假红 ' + sc.harmlessFalseAlarm + ' 条（只改注释/空白被报成"门禁动了"= 乱报 ✗）');
    console.log('  负对照 ' + sc.negTotal + ' 条 ⇒ 如实报"没拦下" ' + sc.negAsExpected
      + ' 条 · 假红 ' + sc.negFalseAlarm + ' 条（门禁被钝化后仍报"拦下"= 乱报 ✗）');
  }
  console.log('');
  console.log('  真仓未改：' + (report.repoUnchanged
    ? '✓ ' + new Set(GATES.map((g) => g.script)).size + ' 份门禁脚本 + docs/RULES.md 的 sha256 前后一致'
    : '✗ 有文件被改动（这不该发生）'));
  console.log('  未测/边界：');
  report.knownGaps.forEach((g) => console.log('    · ' + g));
  console.log('');
  console.log('  退出码 ' + report.exitCode + '：'
    + (report.exitCode === 2 ? '采不到真值/环境不齐'
      : report.exitCode === 1 ? '有漏过（--strict）'
        : '跑完并报出读数（默认只报告；--strict 时"有漏过/静默"才判红）'));
  if (report.envError) console.error('  ✗ ' + report.envError);
}

function main() {
  const report = buildReport();
  const json = process.argv.includes('--json');
  const outArg = (process.argv.slice(2).find((a) => a.startsWith('--out=')) || '').slice(6);
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (outArg) fs.writeFileSync(outArg, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.exitCode = report.exitCode;
    return;
  }
  printHuman(report);
  if (outArg) {
    fs.writeFileSync(outArg, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('  JSON 已落盘：' + outArg);
  }
  process.exitCode = report.exitCode;
}

module.exports = {
  GATES, VERDICT, classify, exitCodeFor, summarize, normalize, firstLine,
  makeMirror, makeMirrorApi, unitTestsPin, realModule, exitMain: main,
  MIRROR_PREFIX
};

if (require.main === module) main();
