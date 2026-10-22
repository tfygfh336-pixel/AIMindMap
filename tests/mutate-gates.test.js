/* ============================================================
 * tests/mutate-gates.test.js — 变异体检工具（`scripts/mutate-gates.js`）自己的判别力
 * 运行：npx vitest run tests/mutate-gates.test.js
 * ------------------------------------------------------------
 * ## 这个文件为什么存在
 * 变异体检工具最危险的失效方式与门禁同形：**它永远说"拦下了"**。
 * 一个只会喊"拦下了"的工具，会让人以为门禁防线是完整的 —— 比没有这个工具更坏 ✗。
 * 所以本文件不测"工具能跑"，而是钉死**两件相反的事**：
 *   · 真变异 ⇒ 必须**拦下**（工具不得漏报）；
 *   · 门禁被钝化 / 只改注释 ⇒ 必须**如实报"没拦下" / 读数不变**（工具不得乱报）。
 * 两者一起才说明它的判定**跟着事实走**，而不是恒真。
 *
 * ## 三层断言（为什么这么分层）
 *   ① **纯函数层**（毫秒级）：`classify()` 的口径 —— 尤其是"**无害变异不计漏过**"这条；
 *      `exitCodeFor()` 的退出码语义；`summarize()` 的账必须现算且封闭。
 *   ② **目录层**（毫秒级 + 一次 `--judgments` 子进程）：在册门禁都在册、每个都有 真变异 + 无害对照 + 负对照；
 *      G8 另有一条**判定级**覆盖用例（15 条判定各有注入，判定清单从门禁自己的 `--judgments` 现场取）。
 *      少了任何一类 ⇒ 判红（防止"覆盖被悄悄删掉"这种静默失效）。
 *      另有一组**产品级**（`F3` `pdf-thresholds`）的结构断言：4 条真变异各改一个不同阈值、1 条负对照、
 *      ≥1 条无害对照、**不许是常量值断言**、必须有 `exec` + `fingerprint`。
 *   ③ **集成层**（**约 7 s**，真起子进程跑一次体检）：这是唯一能证明"它真的按事实判"的一层。
 *      刻意只跑 `--only=dep-direction` 这一个门禁：全量体检比它贵一个数量级（G8 那一条自己的判定级变体就占掉一大截），
 *      会把 `npm test` 的成本推高一截，而"工具会不会乱报"这一条与"跑了几个门禁"无关 ✗。
 *      **产品级那一条也刻意不在这里跑**：`pdf-thresholds` 一次要跑 7 遍 vitest（≈12–15 s），
 *      塞进 `npm test` 会把 `scripts/verify.js` 的 G3 预算（整链最紧的一段，值以 `STEPS` 为准）顶穿
 *      ⇒ 那是给全链造一个新红源。它的正确性由 ② 的结构断言 + 单跑读数（`--only=pdf-thresholds`）保证。
 *      （全量体检仍是一条命令：`node scripts/mutate-gates.js`，见 `.review/20261013-门禁变异测试/README.md` 与
 *       `.review/20261016-T4-G8判别力/README.md`。）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mg = require('../scripts/mutate-gates.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'scripts', 'mutate-gates.js');

/* ---------------------------------------------------------------
 * ① 纯函数层：判定口径
 * --------------------------------------------------------------- */
describe('① classify()：期望 vs 实测 ⇒ 六档判定（口径必须先说清，再谈读数）', () => {
  const base = { exit: 0, out: '== 门禁 ==\n✓ 通过' };
  const mk = (expect, reason, exit, out) => [
    { expect, reason },
    { exit, out }
  ];

  it('真变异 · 期望"拦下"：原因出现且退出码非 0 ⇒ 拦下', () => {
    const [v, m] = mk('caught', /\[S1-反向\]/, 1, '✗ 反向依赖 1 条：\n   [S1-反向] src/a.js:9 → renderer/b.js');
    expect(mg.classify(v, base, m)).toBe('caught');
  });

  it('真变异 · 期望"拦下"：原因**没**出现 ⇒ 漏过（这是本工具存在的理由，也是它必须会说的那句话）', () => {
    const [v, m] = mk('caught', /\[S1-反向\]/, 0, '✓ 依赖方向成立');
    expect(mg.classify(v, base, m)).toBe('escaped');
  });

  it('真变异 · 打印了违规却 exit 0 ⇒ 记"静默"，**不许**记成拦下', () => {
    const [v, m] = mk('caught', /\[S1-反向\]/, 0, '✗ 反向依赖 1 条：\n   [S1-反向] a → b');
    expect(mg.classify(v, base, m)).toBe('silent');
  });

  it('基线本来就红着同一个原因 ⇒ 记"未测"（归不了因），不许记成"我拦下了"', () => {
    const dirty = { exit: 1, out: '✗ 反向依赖 2 条\n   [S1-反向] x → y' };
    const [v, m] = mk('caught', /\[S1-反向\]/, 1, '✗ 反向依赖 2 条\n   [S1-反向] x → y');
    expect(mg.classify(v, dirty, m)).toBe('untested');
  });

  it('无害对照（只改注释/空白）：读数逐字不变 ⇒ 符合预期 —— **不计漏过、也不计拦下**', () => {
    const [v, m] = mk('unchanged', null, 0, '== 门禁 ==\n✓ 通过');
    expect(mg.classify(v, base, m)).toBe('asExpected');
    // 逐字比较要容忍行尾空白与 CRLF（否则 Windows 上会把"没变"读成"变了" ⇒ 假红）
    const [v2, m2] = mk('unchanged', null, 0, '== 门禁 ==\r\n✓ 通过   ');
    expect(mg.classify(v2, base, m2)).toBe('asExpected');
  });

  it('无害对照却让门禁变红 ⇒ 记"假红"（工具乱报，而不是"拦住了一次")', () => {
    const [v, m] = mk('unchanged', null, 1, '✗ 反向依赖 1 条');
    expect(mg.classify(v, base, m)).toBe('falseAlarm');
  });

  it('负对照（门禁已被钝化）：期望"没拦下" ⇒ 符合预期；若仍报"拦下" ⇒ 假红（工具在瞎报）', () => {
    const [v, ok] = mk('escape', /\[S1-反向\]/, 0, '✓ 依赖方向成立');
    expect(mg.classify(v, base, ok)).toBe('asExpected');
    const [v2, bad] = mk('escape', /\[S1-反向\]/, 1, '✗ 反向依赖 1 条\n   [S1-反向] a → b');
    expect(mg.classify(v2, base, bad)).toBe('falseAlarm');
  });
});

describe('① exitCodeFor()：退出码语义（默认只报告，--strict 才判红）', () => {
  const rep = (s) => Object.assign({ envError: null, summary: { escaped: 0, silent: 0 } }, s);
  it('跑完并报出读数 ⇒ 0（**有漏过也是 0**：漏过是读数不是回归，常年红的下场是被关掉）', () => {
    expect(mg.exitCodeFor(rep({ summary: { escaped: 3, silent: 0 } }), { strict: false })).toBe(0);
  });
  it('--strict + 有漏过 ⇒ 1（留给"新门禁上线前必须零漏过"）', () => {
    expect(mg.exitCodeFor(rep({ summary: { escaped: 1, silent: 0 } }), { strict: true })).toBe(1);
    expect(mg.exitCodeFor(rep({ summary: { escaped: 0, silent: 0 } }), { strict: true })).toBe(0);
  });
  it('--strict + 有静默（打印了违规却 exit 0）⇒ 1：与漏过同判', () => {
    expect(mg.exitCodeFor(rep({ summary: { escaped: 0, silent: 2 } }), { strict: true })).toBe(1);
  });
  it('采不到真值 / 环境不齐 ⇒ 2（与"跑完"必须可区分）', () => {
    expect(mg.exitCodeFor(rep({ envError: '门禁跑不起来' }), { strict: true })).toBe(2);
    expect(mg.exitCodeFor(rep({ envError: '门禁跑不起来' }), { strict: false })).toBe(2);
  });
});

describe('① summarize()：汇总读数必须现算且封闭', () => {
  it('N = 拦下 + 漏过 + 符合预期 + 假红 + 未测 + 静默（账不平就判红）', () => {
    const vs = [
      { verdict: 'caught' }, { verdict: 'caught' }, { verdict: 'escaped' },
      { verdict: 'asExpected' }, { verdict: 'falseAlarm' }, { verdict: 'untested' }, { verdict: 'silent' }
    ];
    const s = mg.summarize(vs);
    expect(s.total).toBe(7);
    expect(s.caught).toBe(2);
    expect(s.escaped).toBe(1);
    expect(s.arithmeticOk).toBe(true);
    // 现算：换个输入，读数必须跟着变（写死的数字过不了这一条）
    expect(mg.summarize([{ verdict: 'caught' }]).total).toBe(1);
    expect(mg.summarize([{ verdict: 'caught' }]).escaped).toBe(0);
  });
});

/* ---------------------------------------------------------------
 * ② 目录层：覆盖不许被悄悄删
 * --------------------------------------------------------------- */
describe('② 变体目录：在册门禁一个不少，每个都带"真变异 + 无害对照 + 负对照"', () => {
  it('每个在册门禁都在 GATES 里（清单是**枚举**，不是计数 —— 加门禁时这里必须跟着加），且都写明了"注在哪一层"', () => {
    const ids = mg.GATES.map((g) => g.id).sort();
    expect(ids).toEqual(['collateral-check', 'dep-direction', 'doc-facts', 'docs-registry',
      'pdf-thresholds', 'rules-consistency', 'smoke-state', 'visibility-judge']);
    mg.GATES.forEach((g) => {
      expect(g.seam, g.id + ' 缺 seam（必须写清：变异注在输入文本 / 程序集 / 门禁实现的哪一层）').toBeTruthy();
      expect(g.code, g.id + ' 没写门禁编号').toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, g.script)), g.id + ' 的 script 不存在：' + g.script).toBe(true);
    });
  });

  it('G8 的**判定覆盖不许被悄悄删**：15 条判定各有注入变异体（清单用 `--judgments` 现场取，不写死条数）', () => {
    const g8 = mg.GATES.find((g) => g.code === 'G8');
    expect(g8, 'GATES 里没有 G8 条目').toBeTruthy();
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'scripts', 'docs-registry-check.js'), '--judgments'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    expect(r.status, '门禁自己列不出判定清单：' + String(r.stderr || '').slice(-300)).toBe(0);
    // 判定编号的权威来源是门禁自己的输出（`  ① 标题` 这种行），本测试不抄一份清单
    const marks = [...new Set((String(r.stdout).match(/^\s+([①-⑳])\s/gm) || []).map((s) => s.trim()))];
    expect(marks.length, '门禁的 --judgments 一条判定都没列出').toBeGreaterThan(5);
    const covered = new Set(g8.variants.filter((v) => v.expect === 'caught').map((v) => v.judgment).filter(Boolean));
    const missing = marks.filter((m) => !covered.has(m));
    expect(missing, '这些判定没有任何"注入 ⇒ 必红"的变异体：' + missing.join(' ')).toEqual([]);
    // 反向：挂的编号必须在门禁自己的清单里（防"自己编一个判定号"混过覆盖检查）
    const unknown = [...covered].filter((m) => !marks.includes(m));
    expect(unknown, '变异体挂了门禁清单里没有的判定号：' + unknown.join(' ')).toEqual([]);
  });

  it('每个门禁 ≥2 条真变异（每条都得写明期望原因），且都带 无害对照 + 负对照', () => {
    mg.GATES.forEach((g) => {
      const mutants = g.variants.filter((v) => v.expect === 'caught');
      const harmless = g.variants.filter((v) => v.expect === 'unchanged');
      const neg = g.variants.filter((v) => v.expect === 'escape');
      expect(mutants.length, g.id + ' 的真变异少于 2 条').toBeGreaterThanOrEqual(2);
      // doc-facts 刻意留两条：一条"只改注释/空白"，一条"写的是**真值**的同款声明"（值敏感对照）
      expect(harmless.length, g.id + ' 缺无害对照（没有它就没法证明工具不乱报）').toBeGreaterThanOrEqual(1);
      expect(neg.length, g.id + ' 缺负对照（没有它就没法证明工具会报"没拦下"）').toBe(1);
      g.variants.forEach((v) => {
        expect(v.name, g.id + '/' + v.id + ' 没写人读的说明').toBeTruthy();
        expect(v.kind, g.id + '/' + v.id + ' 没写变体类别').toBeTruthy();
        expect(typeof v.apply, g.id + '/' + v.id + ' 没有 apply（那它就不是变体）').toBe('function');
        if (v.expect !== 'unchanged') expect(v.reason instanceof RegExp, g.id + '/' + v.id + ' 没写期望原因').toBe(true);
      });
    });
  });

  /* ---- 产品级那条（`F3` `pdf-thresholds`）：结构断言，便宜且能防"变体被悄悄删" ----
   * ⚠️ 这里**刻意不做集成跑**（不在 ③ 里加 `--only=pdf-thresholds`）：
   *   它一次要跑 7 遍 vitest（基线 + 6 条变体，实测 ≈12–15 s），而 `scripts/verify.js` 的 G3
   *   （`npm test`）那一步是整链预算最紧的一段（预算值以 `STEPS` 为准，本批现读 69 s）——
   *   塞进 `npm test` 就是给全链造一个新红源 ✗。单跑：`node scripts/mutate-gates.js --only=pdf-thresholds`。 */
  const F3 = () => {
    const g = mg.GATES.find((x) => x.id === 'pdf-thresholds');
    expect(g, 'GATES 里没有 pdf-thresholds（产品级靶子被删了？）').toBeTruthy();
    return g;
  };

  it('产品级：4 个阈值各一条真变异（`caught` 恰好 4 条），每条都写明是哪个阈值、且 reason 是 RegExp', () => {
    // 阈值名单**只有一处**（`scripts/mutate-gates.js` 的 `PDF_THRESHOLDS`）⇒ 这里不抄第二份
    const names = mg.PDF_THRESHOLDS;
    expect(Array.isArray(names) && names.length === 4, 'PDF_THRESHOLDS 必须是 4 个阈值').toBe(true);
    const mutants = F3().variants.filter((v) => v.expect === 'caught');
    expect(mutants.length, '产品级真变异必须恰好 4 条（4 个阈值各一条）').toBe(4);
    const hit = mutants.map((v) => names.filter((n) => String(v.name).includes(n)));
    mutants.forEach((v, i) => {
      expect(v.reason instanceof RegExp, v.id + ' 的 reason 必须是 RegExp（classify 拿它做 reason.test）').toBe(true);
      expect(hit[i].length, v.id + ' 的 name 里没写明改的是哪个阈值：' + v.name).toBe(1);
    });
    // 4 条各改**不同**的阈值（防"四条都改同一个"凑数）
    expect(new Set(hit.map((h) => h[0])).size, '4 条真变异里有重复的阈值：' + hit.map((h) => h[0]).join('、')).toBe(4);
  });

  it('产品级：负对照恰好 1 条、无害对照 ≥1 条（两侧都在 —— 会红、且不把"没变"读成红）', () => {
    const g = F3();
    expect(g.variants.filter((v) => v.expect === 'escape').length, '产品级缺负对照（没有它就没法证明"工具会报没拦下"）').toBe(1);
    expect(g.variants.filter((v) => v.expect === 'unchanged').length, '产品级缺无害对照').toBeGreaterThanOrEqual(1);
  });

  it('产品级变体**不许是常量值断言**（假修法：往测试里加 `expect(CONSTANTS.X).toBe(1.15)` 也能"变红"）', () => {
    F3().variants.forEach((v) => {
      // 判据只看**变体本身的代码形态**：它要是去断言"那个数字等于那个数字"，
      // 证明的是常量没被改名，**不是**"改阈值会让行为错" ⇒ 判红。
      const src = String(v.apply) + '\n' + String(v.reason || '');
      expect(src, v.id + ' 里出现了 `CONSTANTS`（常量值断言的形态）').not.toMatch(/CONSTANTS/);
      expect(src, v.id + ' 里出现了 `.toBe(<数字>)`（直接断言那个数字的形态）').not.toMatch(/\.toBe\(\s*\d/);
    });
  });

  it('产品级必须有 `exec` 与 `fingerprint`（缺任一条 ⇒ 它那条"红"不是从单测来的）', () => {
    const g = F3();
    expect(g.exec, '没有 exec ⇒ 它没在跑产品单测，那条"红"可能来自别处').toBeTruthy();
    expect(typeof g.exec.file, 'exec.file 必须是可执行文件（node）').toBe('string');
    // ⚠️ Windows 上直接 spawn 一个 `.mjs` 是 **EFTYPE**（2026-10-22 实测）⇒ 形状只能是
    //   `node <真仓>/node_modules/vitest/vitest.mjs run …`：file = node，脚本路径在 args[0]。
    expect(g.exec.file, 'exec.file 必须是 node（直接 spawn vitest.mjs 在 Windows 上 EFTYPE）').toBe(process.execPath);
    expect(Array.isArray(g.exec.args), 'exec.args 必须是数组').toBe(true);
    expect(String(g.exec.args[0]).replace(/\\/g, '/'), 'exec.args[0] 必须指向真仓的 vitest.mjs：' + g.exec.args[0])
      .toMatch(/node_modules\/vitest\/vitest\.mjs$/);
    expect(fs.existsSync(g.exec.args[0]), 'exec.args[0] 不存在（真仓的 vitest 被搬走了？）：' + g.exec.args[0]).toBe(true);
    expect(typeof g.fingerprint, '没有 fingerprint ⇒ 读数不可比（无害对照拿不到"不含耗时"的稳定文本）').toBe('function');
    // 报告必须落在**副本**里：落真仓根会多一个陌生顶层目录 ⇒ G8 判红（`--reporter=json` 不带 outputFile 时
    // 会落到 `<cwd>/.vitest/json/output.json`）
    expect(g.exec.args.join(' '), 'exec.args 里没有 --outputFile=<mirror>… ⇒ 报告会落到 <cwd>/.vitest/').toMatch(/--outputFile=<mirror>/);
    // 它自己的判据文件也要进 `repoUnchanged`（负对照会同时改它）
    expect(g.watch || [], 'watch 里必须有它的判据文件：' + mg.PDF_TEST).toContain(mg.PDF_TEST);
  });
});

/* ---------------------------------------------------------------
 * ③ 集成层：真起子进程跑一次（只跑一个门禁，约 7 s）
 * --------------------------------------------------------------- */
describe('③ 集成：真跑一次体检 —— 真变异必须拦下、无害/负对照必须如实（"不是恒真"）', () => {
  let res = null;
  let report = null;

  it('--json --only=dep-direction 能跑起来并吐出一份可解析的读数报告', () => {
    res = spawnSync(process.execPath, [HARNESS, '--json', '--only=dep-direction'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000
    });
    expect(res.error, '体检子进程起不来：' + (res.error && res.error.message)).toBeUndefined();
    expect(res.status, '体检没跑完（stderr 尾部：' + String(res.stderr || '').slice(-400) + '）').toBe(0);
    report = JSON.parse(res.stdout);          // --json 下 stdout 只有 JSON（进度走 stderr）
    expect(report.tool).toBe('scripts/mutate-gates.js');
    expect(report.envError).toBeNull();
  }, 180000);

  it('读数账封闭：N = 拦下 + 漏过 + 符合预期 + 假红 + 未测 + 静默（现算，不写死）', () => {
    const s = report.summary;
    expect(s.arithmeticOk).toBe(true);
    expect(s.total).toBe(s.caught + s.escaped + s.asExpected + s.falseAlarm + s.untested + s.silent);
    expect(s.total).toBeGreaterThanOrEqual(5);          // 3 条真变异 + 2 条对照
  });

  it('真变异全部拦下（漏过 = 0），且每条"拦下"都附上了门禁自己的报文行', () => {
    expect(report.summary.escaped, '有真变异从门禁下钻过去了').toBe(0);
    expect(report.summary.untested, '有变体归不了因（基线红着同一个原因）—— 那说明这次体检没测到它').toBe(0);
    const caught = [];
    report.gates.forEach((g) => g.variants.forEach((v) => { if (v.verdict === 'caught') caught.push({ g, v }); }));
    expect(caught.length).toBeGreaterThanOrEqual(3);
    caught.forEach(({ g, v }) => {
      expect(v.exit, g.code + ' ' + v.id + ' 记成拦下却没判红').not.toBe(0);
      expect(v.evidence, g.code + ' ' + v.id + ' 没有附报文').toBeTruthy();
      expect(v.evidence).toMatch(/\[S1-/);
    });
  });

  it('**无害对照 ⇒ 不计漏过**（本工具的"不是恒真"证明之一：只改注释/空白，读数必须逐字不变）', () => {
    const sc = report.selfCheck;
    expect(sc.harmlessTotal).toBeGreaterThanOrEqual(1);
    expect(sc.harmlessAsExpected, '无害对照被报成了"门禁动了" ✗').toBe(sc.harmlessTotal);
    expect(sc.harmlessFalseAlarm, '无害对照被记成假红 ✗').toBe(0);
    // 逐条复核：无害对照既不许算漏过，也不许算拦下
    report.gates.forEach((g) => g.variants.forEach((v) => {
      if (v.expect !== 'unchanged') return;
      expect(['asExpected'], g.code + ' ' + v.id + ' 无害对照的判定是 ' + v.verdict).toContain(v.verdict);
    }));
  });

  it('负对照 ⇒ 如实报"没拦下"（另一半证明：门禁被钝化后，工具**会**说漏过，不是恒报拦下）', () => {
    const sc = report.selfCheck;
    expect(sc.negTotal).toBeGreaterThanOrEqual(1);
    expect(sc.negAsExpected, '门禁已钝化却仍被记成"拦下" ⇒ 工具在照着自己的期望报 ✗').toBe(sc.negTotal);
    expect(sc.negFalseAlarm).toBe(0);
  });

  it('把真仓的检查写进去：跑完前后四份门禁脚本 + docs/RULES.md 的 sha256 必须一致', () => {
    expect(report.repoUnchanged, '体检动了真仓的文件（这绝不该发生）').toBe(true);
  });

  /* ⚠️ 这一条原来写的是「%TEMP% 里不许有**任何** `dsh-mutate-gates-*`」——
   * 而它**声称**验的是"这一轮的副本自清了"。作用域不对，实测会随机红（`B4b`/`B4c`：判定档数/作用域
   * 与它声称要区分的状态对不上）：
   *   2026-10-18 实测（`.review/20261018-判据间歇红/`，G3 ×10 的 #9）：
   *   `AssertionError: 副本没自清：dsh-mutate-gates-ljNc7u: expected [...] to deeply equal []`，
   *   而跑完立刻查 `%TEMP%` ⇒ **现存 0 个** ⇒ 那个目录当时属于**同机另一个会话并发跑的同一套单测**。
   * ⇒ 拆成两条：**甲 判红**（本轮**自己那一个**镜像已清）· **乙 只报告**（全机残留读数，可见但不判红 ——
   *   "别人留下的会吃盘"仍然是真风险，只是**不该由这条判据替它判红**）。 */
  it('甲 本轮**自己的**那一个镜像目录已自清（作用域 = 本轮，不扫全机）', () => {
    /* 镜像根是子进程 mkdtemp 出来的，只有它的 stderr 知道叫什么：`  副本（可写）：<root>（N 个文件 / …）` */
    const stderr = String(res && res.stderr ? res.stderr : '');
    const m = stderr.match(/副本（可写）：(.+?)（/);
    expect(m, '体检没打印副本路径 ⇒ 这条判据无从判定（不许静默放过）').toBeTruthy();
    const mine = m[1];
    expect(mine.indexOf(mg.MIRROR_PREFIX) >= 0, '取到的路径不是镜像目录：' + mine).toBe(true);
    expect(fs.existsSync(mine), '本轮自己的副本没自清：' + mine).toBe(false);
  });

  it('乙 **只报告不判红**：全机还剩几个 dsh-mutate-gates-*（计数不为 0 时写在成功行里可见）', () => {
    const left = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith(mg.MIRROR_PREFIX));
    let bytes = 0, oldestMin = null;
    left.forEach((d) => {
      const p = path.join(os.tmpdir(), d);
      try { const st = fs.statSync(p); const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
        if (oldestMin === null || ageMin > oldestMin) oldestMin = ageMin; } catch (e) { /* 读不到就不算 */ }
      try { bytes += fs.readdirSync(p).length; } catch (e) { /* 同上 */ }
    });
    /* 读数**始终打印**（成功时也看得见）；不判红 —— 全机残留是别人的/历史的，不是本轮的结论 */
    console.log('[mutate-gates] 全机 `' + mg.MIRROR_PREFIX + '*` 残留读数：' + left.length + ' 个'
      + (left.length ? '（最早 ' + oldestMin + ' 分钟前；顶层条目合计 ' + bytes + ' 条）：' + left.join(', ') : '')
      + ' —— **只报告，不判红**（判红的是「甲」：本轮自己那一个）');
    if (left.length) {
      console.warn('[mutate-gates] ⚠️ 全机还有 ' + left.length + ' 个 ' + mg.MIRROR_PREFIX + '*（最早 '
        + oldestMin + ' 分钟前）—— 大概率是**并发的另一轮**或历史残留；要清就手工删，别让这条判据判红别人');
    }
    /* 恒真断言只用来把读数带进报告（不是判据；判据在「甲」里） */
    expect(typeof left.length, '全机残留读数（只报告）：' + left.length + ' 个').toBe('number');
  });

  it('未做的部分在报告里可见（未验证不许伪装成已通过）', () => {
    expect(report.knownGaps.length).toBeGreaterThanOrEqual(2);
    expect(report.knownGaps.join(' ')).toMatch(/未测/);
  });
});
