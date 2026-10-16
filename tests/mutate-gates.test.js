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
 *   ② **目录层**（毫秒级）：四个门禁都在册、每个都有 真变异 + 无害对照 + 负对照。
 *      少了任何一类 ⇒ 判红（防止"覆盖被悄悄删掉"这种静默失效）。
 *   ③ **集成层**（**约 7 s**，真起子进程跑一次体检）：这是唯一能证明"它真的按事实判"的一层。
 *      刻意只跑 `--only=dep-direction` 这一个门禁：全量四门禁约 17 s，会把 `npm test`
 *      的成本推高一截，而"工具会不会乱报"这一条与"跑了几个门禁"无关 ✗。
 *      （全量体检仍是一条命令：`node scripts/mutate-gates.js`，见 `.review/20261013-门禁变异测试/README.md`。）
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
describe('② 变体目录：四个门禁都在册，每个都带"真变异 + 无害对照 + 负对照"', () => {
  it('四个门禁（G9 / S1 / G6+G7 / V1）一个不少，且都写明了"注在哪一层"', () => {
    const ids = mg.GATES.map((g) => g.id).sort();
    expect(ids).toEqual(['dep-direction', 'doc-facts', 'rules-consistency', 'visibility-judge']);
    mg.GATES.forEach((g) => {
      expect(g.seam, g.id + ' 缺 seam（必须写清：变异注在输入文本 / 程序集 / 门禁实现的哪一层）').toBeTruthy();
      expect(g.code, g.id + ' 没写门禁编号').toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, g.script)), g.id + ' 的 script 不存在：' + g.script).toBe(true);
    });
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

  it('临时副本自清：%TEMP% 里不留 dsh-mutate-gates-* 目录', () => {
    const left = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith(mg.MIRROR_PREFIX));
    expect(left, '副本没自清：' + left.join(', ')).toEqual([]);
  });

  it('未做的部分在报告里可见（未验证不许伪装成已通过）', () => {
    expect(report.knownGaps.length).toBeGreaterThanOrEqual(2);
    expect(report.knownGaps.join(' ')).toMatch(/未测/);
  });
});
