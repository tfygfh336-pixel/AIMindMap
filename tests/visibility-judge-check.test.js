/* ============================================================
 * tests/visibility-judge-check.test.js — 可见性判据门禁（V1）的契约 + **判别力**
 * 运行：npx vitest run tests/visibility-judge-check.test.js
 * ------------------------------------------------------------
 * 为什么这些用例长这样（三条都是本工程的老教训）：
 *   ① **门禁本身必须可被单测 require**：`require` 它会跑主流程的门禁，判定逻辑就永远没法单测 ——
 *      本工程有过一次实测（require 7189 ms → 12 ms），这里把"末尾有 require.main 守卫"钉住 ✓。
 *   ② **判别力要留在测试里，而不只是写在交付说明里**：下面有一条用例直接把**真实仓库里那条合规断言**的
 *      `elementFromPoint` 抹掉（只在内存里抹，不落盘 ✗），断言门禁**必须红** —— 这就是"新门禁先证明它会红"
 *      那条纪律的可重复版本 ✓。
 *   ③ **防假红**：名字里不含可见性词的断言一律不触发（否则门禁会天天喊狼来了，下场是被关掉）；
 *      名字含词但体内只有文案判据（"写后重读可见"这类数据语义）也不判红 —— 只能提示。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/visibility-judge-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'visibility-judge-check.js'), 'utf8');

/** 造一个冒烟域文件（形状与真实断言一致：module.exports = [{ name, run }]） */
function fixture(nameLine, bodyLines, opts) {
  const o = opts || {};
  const lines = (o.head || []).concat([
    'module.exports = [',
    '  {',
    "    name: '" + nameLine + "',",
    '    run: async (ctx) => {'
  ], bodyLines, ['    }', '  }', '];']);
  return [{ rel: o.rel || 'scripts/smoke/99-fixture.js', src: lines.join('\n') + '\n' }];
}

/** 只有几何判据的断言（事故里那一类） */
const RECT_BODY = [
  '      const r = await ctx.exec("document.querySelector(\'#a\').getBoundingClientRect().width");',
  '      return { ok: Number(r) > 8, text: "w=" + r };'
];

describe('门禁自身：可被单测引入（零副作用）', () => {
  it('require 之后拿到纯函数，且源码末尾有 require.main 守卫', () => {
    expect(typeof gate.analyze).toBe('function');
    expect(typeof gate.findAssertions).toBe('function');
    expect(typeof gate.expandSnippets).toBe('function');
    // 守卫是"可被单测"的全部依据：末尾无条件执行 main() ⇒ 一 require 就跑主流程 ⇒ 判定逻辑没法单测
    expect(gateSrc).toMatch(/if \(require\.main === module\) main\(\);/);
  });

  it('分析函数是纯函数：不打印、不退出（同一输入两次结果一致）', () => {
    const files = fixture('圆钮在框外', RECT_BODY);
    const a = gate.analyze(files, [], { minTriggered: 1 });
    const b = gate.analyze(files, [], { minTriggered: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('判定②：声称可见 ⇒ 必须有真判据', () => {
  const name = '圆钮**完整落在面板内**（看不见=没有）';

  it('只有 getBoundingClientRect ⇒ 判红，且报文含 file:line / 断言名 / 原因 / 修法要素', () => {
    const r = gate.analyze(fixture(name, RECT_BODY), [], { minTriggered: 1 });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    const p = r.problems[0];
    expect(p.rel).toBe('scripts/smoke/99-fixture.js');
    expect(p.line).toBe(3);                       // name: 那一行（含它自己的两行 head 之外的行号）
    expect(p.name).toBe(name);
    expect(p.verdict).toBe('blind');
    expect(p.blind.join('')).toContain('getBoundingClientRect');
    expect(p.words).toEqual(['面板内', '看不见']);
  });

  it('名字里提到 `elementFromPoint`、代码里其实没有 ⇒ 仍判红（**实测踩到的空转**：判据要是代码，不是散文）', () => {
    const r = gate.analyze(fixture('圆钮真的看得见（elementFromPoint 命中 + 真帧像素）', RECT_BODY), [], { minTriggered: 1 });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].verdict).toBe('blind');
    expect(gate.judgeView("name: '元素可见（elementFromPoint 命中）'")).not.toContain('elementFromPoint');
  });

  it('注释里提到真判据、代码里没有 ⇒ 仍判红（同上：注释不是判据）', () => {
    const body = ['      // 这里本该用 document.elementFromPoint 判，但先只用 rect'].concat(RECT_BODY);
    const r = gate.analyze(fixture('圆钮**完整落在面板内**', body), [], { minTriggered: 1 });
    expect(r.problems).toHaveLength(1);
    expect(gate.stripComments('// elementFromPoint\nvar a = 1;')).not.toContain('elementFromPoint');
  });

  it('真判据写在注入的 JS 串里（工程里的实际写法）⇒ 算数（去注释不能把字符串一起删掉）', () => {
    const body = ['      const hit = await ctx.exec(`(function () { return document.elementFromPoint(x, y) === btn; })()`);'];
    const r = gate.analyze(fixture('圆钮在框外、看得见', body), [], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.judged.filter((x) => x.verdict === 'ok')).toHaveLength(1);
  });

  it.each([
    ['elementFromPoint', '      const hit = await ctx.exec("document.elementFromPoint(x, y) === btn");'],
    ['scanRegion', '      const n = await ctx.exec("scanRegion(shot, roi)");'],
    ['isAccentBlue', '      const n = await ctx.exec("isAccentBlue(bytes, roi)");'],
    ['frame-stats', "      const s = require('../vision/frame-stats.js');"]
  ])('出现真判据 %s ⇒ 不判红', (_label, body) => {
    const r = gate.analyze(fixture(name, RECT_BODY.concat([body])), [], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.judged.filter((x) => x.verdict === 'ok')).toHaveLength(1);
  });

  it('显式豁免（`判据-豁免: 原因`）⇒ 不判红，且原因被记下来（豁免不是"没有判据"，是"声明了为什么只需 rect"）', () => {
    const files = fixture(name, ['      // 判据-豁免: 这里量的是画布坐标，不是"用户看不看得见"'].concat(RECT_BODY));
    const r = gate.analyze(files, [], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    const ex = r.judged.filter((x) => x.verdict === 'exempt');
    expect(ex).toHaveLength(1);
    expect(ex[0].exempt).toContain('画布坐标');
  });

  it('名字里不含可见性词 ⇒ 一律不触发（防假红：门禁天天喊狼来了就会被关掉）', () => {
    const r = gate.analyze(fixture('节点数=3 且焦点在 #a 上', RECT_BODY), [], { minTriggered: 0 });
    expect(r.triggered).toBe(0);
    expect(r.problems).toEqual([]);
    expect(r.debts).toEqual([]);
  });

  it('名字含词、但体内只有文案判据 ⇒ 归"无可视判据"（多为数据/文案语义），不判红只提示', () => {
    const body = ['      const t = await ctx.exec("document.body.textContent");', '      return { ok: t.includes("x") };'];
    const r = gate.analyze(fixture('变更可见性：界面保存也记进日志', body), [], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.nonVisual).toHaveLength(1);
  });
});

describe('判定④：既有欠账册（只减不增）', () => {
  const name = '圆钮每次都在、都在框外';
  const files = fixture(name, RECT_BODY);
  const row = { rel: 'scripts/smoke/99-fixture.js', name: name, why: '事故现场', fix: '加 elementFromPoint' };

  it('在册的欠账算欠账，不算新违规（但会打印出来）', () => {
    const r = gate.analyze(files, [row], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.debts).toHaveLength(1);
    expect(r.debts[0].fix).toContain('elementFromPoint');
    expect(r.staleDebt).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('欠账已被修好（断言现在有真判据）却还留在册上 ⇒ 判红，逼人销账', () => {
    const fixed = fixture(name, RECT_BODY.concat(['      const h = await ctx.exec("document.elementFromPoint(1,1)");']));
    const r = gate.analyze(fixed, [row], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.staleDebt).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it('册上的条目在仓库里已经不存在（名字改了/文件删了）⇒ 判红（悬挂登记）', () => {
    const r = gate.analyze(fixture('别的断言名', RECT_BODY), [row], { minTriggered: 1 });
    expect(r.staleDebt).toHaveLength(1);
    expect(r.ok).toBe(false);
  });
});

describe('判定①⑤：触发面与防绕道下限', () => {
  it('同文件里的 JS 片段常量要展开（真实形态：域 34 的 BTN_JS）—— 判据写在常量里也必须算数', () => {
    const bttn = 'const BTN_JS = "(function () { var r = b.getBoundingClientRect(); '
      + 'return JSON.stringify({ visible: r.width > 8 && !!b.offsetParent }); })()";';
    const files = fixture('圆钮每次都在、都在框外', [
      '      const s = await execJson(ctx, BTN_JS);',
      '      return { ok: s.visible };'
    ], { head: [bttn, ''] });
    // 只扫断言体 ⇒ 看不见 rect ⇒ 会误判成"没有判据"；展开同文件常量后才判得出"盲判据" ✓
    expect(gate.expandSnippets('const s = await execJson(ctx, BTN_JS);', files[0].src)).toContain('getBoundingClientRect');
    const r = gate.analyze(files, [], { minTriggered: 1 });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].blind.join('')).toContain('getBoundingClientRect');
  });

  it('名字里声称可见的断言少到低于下限 ⇒ 判红（把名字里的词删掉就能让门禁闭嘴 = 绕过 ✗）', () => {
    const files = fixture('圆钮在框外', RECT_BODY);
    const r = gate.analyze(files, [], { minTriggered: 6 });
    expect(r.floorOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('一条断言都扫不到 ⇒ 判红（取不到真值不许当通过）', () => {
    const r = gate.analyze([{ rel: 'scripts/smoke/99-empty.js', src: 'module.exports = [];\n' }], [], { minTriggered: 0 });
    expect(r.scansOk).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe('判别力自检（`--selftest`，不碰任何文件）', () => {
  it('自检通过：基线绿 ⇒ 注入①（抹真判据）必红 ⇒ 注入②（名字提判据、代码只有 rect）必红 ⇒ 撤销复绿', () => {
    const r = gate.selftest();
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true, true]);
    expect(r.ok).toBe(true);
    // 自检必须点名"报红了哪一条"（否则它自己也是个空转的绿灯）
    expect(r.steps[2].detail).toMatch(/报红 \d+ 条/);
  });
});

describe('判别力证明（可重复版）：合规断言被改回"只用 rect" ⇒ 必须红', () => {
  const real = gate.loadSmokeFiles();

  it('现状锚：本仓库此刻 0 条新违规、0 条悬挂欠账', () => {
    const r = gate.analyze(real);
    expect(r.files).toBeGreaterThan(10);
    expect(r.assertions).toBeGreaterThan(100);
    expect(r.problems).toEqual([]);
    expect(r.staleDebt).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('仓库里必须存在"有真判据"的样板断言（否则这条纪律没有活样本）', () => {
    const r = gate.analyze(real);
    expect(r.judged.filter((x) => x.verdict === 'ok').length).toBeGreaterThan(0);
  });

  it('把样板断言的现场判据抹掉（只在内存里抹 ✗）⇒ 门禁必须报红', () => {
    const r0 = gate.analyze(real);
    const sample = r0.judged.find((x) => x.verdict === 'ok' && x.via.length);
    expect(sample, '需要一个合规样板（有真判据的断言）').toBeTruthy();
    const idx = real.findIndex((f) => f.rel === sample.rel);
    expect(idx).toBeGreaterThanOrEqual(0);
    // 抹的是这条断言**用到的全部真判据**（由门禁自己的 REAL_JUDGES 生成，不在这里另写一份清单）。
    // ⚠️ 曾经只抹 `document.elementFromPoint`：那在"仓库里只有域 37 一条合规断言"时是有效注入，
    //    但逐条迁移后有 7 条合规断言、其中 6 条**同时**靠命中测试 + 真帧像素 ⇒ 只抹一类时
    //    它仍合规、门禁照样绿 —— 那是**注入选错了对象**，不是门禁空转 ✗（教训如实留在注释里）。
    const injected = real.map((f, i) => (i === idx ? { rel: f.rel, src: gate.zeroRealJudges(f.src) } : f));
    expect(injected[idx].src).not.toBe(real[idx].src);
    const r = gate.analyze(injected);
    expect(r.problems.map((p) => p.name)).toContain(sample.name);   // 名字逐字不变 ✓
    expect(r.ok).toBe(false);
    // 原文件没被动过：真实输入的那一份仍然绿 ✓
    expect(gate.analyze(real).problems).toEqual([]);
  });
});
