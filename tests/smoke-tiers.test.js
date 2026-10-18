/* ============================================================
 * tests/smoke-tiers.test.js — G5 **分层表** + **逐域耗时台账**的判别力锁
 * ------------------------------------------------------------
 * 为什么需要它（两件都是"没做，却看不出没做"的形态）：
 *   ① **分层表**（`scripts/smoke-assertions.js` 的 `TIERS`）决定"哪一档含哪些域"，而分层是
 *      `scripts/verify.js` 少跑 deep 域的唯一依据。表一旦与 `scripts/smoke/` 的域清单分叉
 *      （新加一个域没登记 / 登记了一个不存在的域号 / 同一个域登记两次），后果不是报错，
 *      而是**某个新域的断言从此只在 deep 档跑、或者哪一档都不跑** —— 从输出上看不出来。
 *      ⇒ 这里用**现算**（目录列举）比对，并把三种分叉都**注入**一遍证明会红（`B4`）。
 *   ② **逐域耗时台账**（`createTiming` / `summarizeTiming` / `formatTimingLines`）是"G5 为什么这么贵"
 *      的唯一读数来源，也是铁律 R6 的机械化那一半（"加断言先量成本"）。纯函数必须单测 ——
 *      否则它会安静地算错一张表，而所有人照着那张表决定要不要拆。
 *
 * 另有一条**接线**检查：`main.js` 真的用上了这个台账（函数写好了没人调 = 空转门禁 ✓ 本工程真吃过）。
 * 照 `tests/smoke-tally.test.js` 的做法做**源码级**检查（main.js 是 Electron 主进程入口，不许 require）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const smoke = require('../scripts/smoke-assertions.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const smokeDirFiles = fs.readdirSync(path.join(ROOT, 'scripts', 'smoke'))
  .filter((n) => /^\d+-.+\.js$/.test(n)).sort();

/* ------------------------------------------------------------------
 * ① 真表：必须覆盖 `scripts/smoke/` 的**全部**域，且每个域恰好一档
 * ------------------------------------------------------------------ */
describe('分层表（TIERS）：现算覆盖 + 三处口径', () => {
  it('每个域都登记了分层，且恰好一档（域数现算自目录，不写死）', () => {
    const s = smoke.tierSummary();
    expect(s.errors, '分层表与 scripts/smoke/ 的域清单分叉（逐条见 errors）').toEqual([]);
    expect(s.ok).toBe(true);
    expect(s.all.domains, '分层表的域数必须 == 目录里的域文件数').toBe(smokeDirFiles.length);
    expect(s.core.domains).toBeGreaterThan(0);
    expect(s.deep.domains).toBeGreaterThan(0);
    expect(s.core.domains + s.deep.domains, '一个域只能属于一档').toBe(s.all.domains);
    // 断言数也现算：core + deep == 冒烟断言真值（`smoke.length`，与 docs/VERIFY.md 同一口径）
    expect(s.core.assertions + s.deep.assertions).toBe(smoke.length);
    expect(s.all.assertions).toBe(smoke.length);
  });

  it('core 档是"每轮都跑"的那一档：它必须便宜（≤ 全部域耗时的一半）且清单非空', () => {
    const s = smoke.tierSummary();
    // 便宜这件事由**实测台账**判（不是由本测试猜）：core 的断言条数不该是"大头"，
    // 否则"分层"只是把名字换了。这里只用断言数做一个粗判据（细判据是 G5_FAST_BUDGET_MS）。
    expect(s.core.assertions).toBeGreaterThan(20);
    expect(s.core.assertions, 'core 档不该装下全部断言（那样分层就没省任何东西）').toBeLessThan(s.all.assertions);
    expect(s.core.only.length).toBe(s.core.domains);
    // SMOKE_ONLY 只认**域号前缀**（见 scripts/smoke-select.js）：表里必须是两位数字，不是文件名
    s.core.only.forEach((d) => expect(d, 'core 档的选择串必须是域号（如 01），不是文件名').toMatch(/^\d{2}$/));
  });

  it('tierOf 认文件名、域名与数字三种写法（改名不用改表）', () => {    const s = smoke.tierSummary();
    const anyCore = s.core.only[0];
    const anyDeep = smokeDirFiles.map((f) => f.slice(0, f.indexOf('-')))
      .filter((d) => s.core.only.indexOf(d) < 0)[0];
    expect(anyDeep, '至少有一个域在 deep 档').toBeTruthy();
    expect(smoke.tierOf(anyCore)).toBe('core');
    expect(smoke.tierOf(Number(anyCore))).toBe('core');
    expect(smoke.tierOf(anyDeep + '-whatever.js')).toBe('deep');
    expect(smoke.tierOf('99-nope.js'), '没登记的域必须返回 null（调用方据此判红）').toBe(null);
  });

  it('名单是**字面量常量**：源码里只有它自己的定义，没有任何改写（否则它就是"可变的"）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke-assertions.js'), 'utf8');
    expect(src).toMatch(/const TIERS = \[/);
    const assigns = src.match(/\bTIERS\s*=/g) || [];
    expect(assigns.length, '`TIERS` 只许有一处赋值（就是它的定义）；别处再赋值 = 名单会被现算改写')
      .toBe(1);
    expect(src.match(/\bTIERS\s*\.\s*(push|splice|pop|shift|unshift|sort|reverse|fill|copyWithin)\s*\(/),
      '`TIERS` 被原地改写过（push/splice/sort…）：名单必须钉死').toBe(null);
  });
});

/* ------------------------------------------------------------------
 * ② 判别力证明：三种分叉**必须**判红
 * ------------------------------------------------------------------ */
describe('分层表自检的判别力：三种分叉都要红（喂坏表）', () => {
  const good = {
    files: ['01-a.js', '02-b.js', '03-c.js'],
    groups: [
      { file: '01-a.js', assertions: [{}, {}] },
      { file: '02-b.js', assertions: [{}] },
      { file: '03-c.js', assertions: [{}] }
    ],
    tiers: [
      { tier: 'core', domains: ['01'] },
      { tier: 'deep', domains: ['02', '03'] }
    ]
  };

  it('好表 ⇒ ok:true（先证明这套输入本身是"对的"，否则后面的红是假信号）', () => {
    const s = smoke.tierSummary(good);
    expect(s.errors).toEqual([]);
    expect(s.ok).toBe(true);
    expect(s.core.assertions).toBe(2);
    expect(s.deep.assertions).toBe(2);
  });

  it('漏登记一个域（新域忘了归面）⇒ 红，并**点名**是哪个域', () => {
    const s = smoke.tierSummary(Object.assign({}, good, {
      tiers: [{ tier: 'core', domains: ['01'] }, { tier: 'deep', domains: ['02'] }]
    }));
    expect(s.ok).toBe(false);
    expect(s.errors.join('\n')).toContain('03-c.js');
    expect(s.errors.join('\n')).toContain('没有登记分层');
  });

  it('同一个域登记两档 ⇒ 红（两档都会跑它，或都不跑它，两种都不是设计意图）', () => {
    const s = smoke.tierSummary(Object.assign({}, good, {
      tiers: [{ tier: 'core', domains: ['01', '02'] }, { tier: 'deep', domains: ['02', '03'] }]
    }));
    expect(s.ok).toBe(false);
    expect(s.errors.join('\n')).toContain('登记了两次');
  });

  it('悬挂登记（表里写了一个不存在的域号）⇒ 红', () => {
    const s = smoke.tierSummary(Object.assign({}, good, {
      tiers: [{ tier: 'core', domains: ['01', '07'] }, { tier: 'deep', domains: ['02', '03'] }]
    }));
    expect(s.ok).toBe(false);
    expect(s.errors.join('\n')).toContain('悬挂登记');
  });
});

/* ------------------------------------------------------------------
 * ③ 逐域耗时台账：台账 → 排行 → 文本（全纯函数）
 * ------------------------------------------------------------------ */
describe('逐域耗时台账：口径与排行', () => {
  const mk = () => {
    const t = smoke.createTiming();
    t.beginDomain('01-core.js', 0);
    t.endBoundary(100);
    t.addAssertion('01-core.js', 300);
    t.addAssertion('01-core.js', 200);
    t.beginDomain('46-节点级拖动.js', 0);
    t.endBoundary(50);
    t.addAssertion('46-节点级拖动.js', 5000);
    t.end();
    return t.rows();
  };

  it('域耗时 = 断言体 + 域边界那一跳（两块都要记，边界不是断言的开销）', () => {
    const rows = mk();
    const a = rows.filter((r) => r.domain === '01-core.js')[0];
    expect(a.assertions).toBe(2);
    expect(a.assertMs).toBe(500);
    expect(a.boundaryMs).toBe(100);
    expect(a.totalMs).toBe(600);
    const b = rows.filter((r) => r.domain === '46-节点级拖动.js')[0];
    expect(b.totalMs).toBe(5050);
  });

  it('THREW 的断言也进账（最贵的域恰好是抛错的那个时不许漏）', () => {
    const t = smoke.createTiming();
    t.beginDomain('01-core.js', 0);
    t.addAssertion('01-core.js', 900);   // 断言体抛错前已经花了 900ms
    t.end();
    expect(t.rows()[0].assertMs).toBe(900);
    expect(t.rows()[0].assertions).toBe(1);
  });

  it('排行按耗时降序、占比以"域耗时之和"为分母、`topN` 只影响 top 不影响 rank', () => {
    const s = smoke.summarizeTiming(mk(), { topN: 1 });
    expect(s.rank.map((r) => r.domain)).toEqual(['46-节点级拖动.js', '01-core.js']);
    expect(s.rank[0].share).toBeCloseTo(5050 / 5650, 6);
    expect(s.top.length).toBe(1);
    expect(s.topMs).toBe(5050);
    expect(s.domainMs).toBe(5650);
    expect(s.assertions).toBe(3);
    expect(s.boundaryMs).toBe(150);
  });

  it('读数相同 ⇒ 名次稳定（按域名字典序），否则"排行"自己就不可复现', () => {
    const rows = [
      { domain: 'b.js', assertions: 1, assertMs: 100, boundaryMs: 0 },
      { domain: 'a.js', assertions: 1, assertMs: 100, boundaryMs: 0 }
    ];
    expect(smoke.summarizeTiming(rows).rank.map((r) => r.domain)).toEqual(['a.js', 'b.js']);
  });

  it('**分层表不随耗时漂**（`B1b`：门禁常量不绑滚动读数）—— 改读数也不许换档', () => {
    /* 为什么这条必须**能被打红**：分档一旦由"实测耗时"现算，同一份代码跑两次读数不同就可能换档，
     * 而档位决定"这一轮验证了什么" ⇒ 输入相同、结论不同，S3 与预算守卫都会跟着抖。
     * 判据：喂一份**把 core 域做慢 100 倍、把 deep 域做快 100 倍**的台账 ⇒
     *   ① `tierOf` 的答案一个字都不变；② `tierSummary()` 的读数一个字都不变。 */
    const slowCore = { domain: '05-pan-lock.js', assertions: 19, assertMs: 14.7 * 1000 * 100, boundaryMs: 0 };
    const fastDeep = { domain: '46-节点级拖动.js', assertions: 8, assertMs: 100, boundaryMs: 0 };
    const before = smoke.tierSummary();
    const s = smoke.summarizeTiming([slowCore, fastDeep]);
    expect(s.rank[0].domain, '台账里当然会显示 05 变成最贵 —— 这正是"读数变了"').toBe('05-pan-lock.js');
    expect(smoke.tierOf('05-pan-lock.js'), '但**分层不许跟着变**（名单是钉死的）').toBe('core');
    expect(smoke.tierOf('46-节点级拖动.js')).toBe('deep');
    const after = smoke.tierSummary();
    expect(after.core.only).toEqual(before.core.only);
    expect(after.core.assertions).toBe(before.core.assertions);
    expect(after.deep.domains).toBe(before.deep.domains);
    // 分层表也不接受任何"读数/耗时"输入（喂进去也不影响结论）
    expect(smoke.tierSummary({ timing: [slowCore, fastDeep] }).core.only).toEqual(before.core.only);
  });

  it('空台账 ⇒ 说"没有读数"，**不许**说"很快"（假绿比没读数更坏）', () => {
    const lines = smoke.formatTimingLines(smoke.summarizeTiming([]));
    const text = lines.join('\n');
    expect(text).toContain('没有读数');
    expect(text).not.toContain('0.0s');
  });

  it('文本渲染：带 tierOf 时多一列分层，且每行都能看出耗时与占比', () => {
    const s = smoke.summarizeTiming(mk());
    const lines = smoke.formatTimingLines(s, { tierOf: smoke.tierOf });
    expect(lines[0]).toContain('逐域耗时排行');
    expect(lines[1]).toContain('分层');
    expect(lines.join('\n')).toContain('46-节点级拖动.js');
    expect(lines.join('\n')).toContain('deep');
    expect(lines[lines.length - 1]).toContain('不含');
  });
});

/* ------------------------------------------------------------------
 * ④ 接线：main.js 真的用上了（不是"写好了没人调"）
 * ------------------------------------------------------------------ */
describe('接线：main.js 里的 G5 台账与分层标记', () => {
  it('台账三个动作都在 main.js 里（建账 / 每域边界 / 每条断言 / 收口）', () => {
    expect(mainSrc).toContain('createTiming(');
    expect(mainSrc).toContain('.beginDomain(a.__domain');
    expect(mainSrc).toContain('.endBoundary(Date.now() - boundaryAt)');
    expect(mainSrc).toContain('addAssertion(');
    expect(mainSrc).toContain('formatTimingLines(');
  });

  it('逐域排行每次都打印（A4：不打印就等于没人会发现某一步悄悄变慢）', () => {
    expect(mainSrc).toContain('G5 时间构成');
    expect(mainSrc).toContain('summarizeTiming(');
    // 机器可读的台账只在**显式给路径**时才写（默认不新增写盘路径）
    expect(mainSrc).toContain('MM_SMOKE_TIMING_OUT');
  });

  it('台账**只量不改判**：它不参与退出码（退出码那两处里不许出现 timing）', () => {
    const exitLines = mainSrc.split(/\r?\n/).filter((l) => /app\.exit\(/.test(l));
    expect(exitLines.length).toBeGreaterThan(0);
    exitLines.forEach((l) => {
      expect(l).not.toContain('timing');
      expect(l).not.toContain('summary');
    });
  });
});
