/* ============================================================
 * tests/changed-plan.test.js — 「改动面 → 必跑集」映射的纯函数契约
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么这个映射值得有单测：它是**唯一会"少跑东西"的地方** —— 映射写错，
 * 表现是"验证通过了"，而实际上该跑的那一步压根没跑（本工程最重的损害类别：静默 ✗）。
 * 所以这里锁的不是"能省多少"，而是**保守性**：
 *   ① 认不出的路径一律全量；
 *   ② 只有"G5 的唯一来源是已知冒烟域"时才收窄冒烟；
 *   ③ 干净工作树一步都不跑（不许跑几件卫生门禁假装验证过）；
 *   ④ 测试/冒烟域改动必须带上 G6（用例数/断言数会变，忘了 facts:write 要红）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
/** 本模块的全部导出（新增的「改动面（--for）」那一半也在这里 —— 一处实现） */
const cc = require('../scripts/changed-plan.js');
const { planForFiles, describePlan, FULL_STEPS } = cc;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** verify.js 的源码：接线检查用（它的 main() 跑起来就是整条链，没法在单测里调） */
const verifySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');

/** 便捷断言：某类改动 ⇒ 预期步骤集合 */
const plan = (...files) => planForFiles(files);

describe('映射：已知范围内的改动只跑相关步骤', () => {
  it('只改文档 ⇒ 卫生八件 + G3 + G6（**G3 必须带上**：不带时 G6 会自跑 vitest，耗时一样但单测没跑）', () => {
    const p = plan('docs/ARCHITECTURE.md', 'CHANGELOG.md', 'README.md');
    expect(p.full).toBe(false);
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G3', 'G6']);
    expect(p.steps).not.toContain('G5');
    expect(p.smokeOnly).toBe(null);
  });

  it('只改单测 ⇒ 卫生八件 + G3 + G6（用例数变 ⇒ G6 必须看）', () => {
    const p = plan('tests/schema.test.js');
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G3', 'G6']);
  });

  it('只改一个冒烟域 ⇒ 卫生八件 + G5（**收窄到该域**）+ G6', () => {
    const p = plan('scripts/smoke/22-sidebar-gap.js');
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G6', 'G5']);
    expect(p.smokeOnly).toEqual(['22']);
  });

  it('改两个冒烟域 ⇒ 收窄到这两个（去重 + 排序，输出稳定）', () => {
    const p = plan('scripts/smoke/24-sidebar-close.js', 'scripts/smoke/09-save-persistence.js', 'scripts/smoke/09-save-persistence.js');
    expect(p.smokeOnly).toEqual(['09', '24']);
  });

  it('文档 + 单测混着改 ⇒ 取并集（保守：宁多跑）', () => {
    const p = plan('docs/RULES.md', 'tests/truth-floor.test.js');
    expect(p.steps).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G3', 'G6']);
  });

  it('backslash 路径与前后空格照样识别（git 在 Windows 上给的是 /，但别赌）', () => {
    expect(plan('docs\\RULES.md').full).toBe(false);
    expect(plan('  tests/x.test.js  ').full).toBe(false);
  });
});

describe('保守性：认不出的一律全量（这是这个模块唯一允许"多跑"的方向）', () => {
  const MUST_BE_FULL = [
    'renderer/app-view.js',                 // 渲染层：直接影响 G5
    'main.js', 'main-dsh-sidebar.js', 'preload.js',
    'src/schema.js', 'src/data-store.js',   // 数据层：CLI 与界面共用
    'cli/mm-cli.js', 'scripts/mcp-server.js',
    'scripts/verify.js', 'scripts/doc-facts.js',   // 门禁自己
    'scripts/changed-plan.js',              // 本模块自己（改了就全量 —— 别让"改映射"绕过验证）
    'scripts/smoke-flags.js',               // 冒烟公共件（不是"域文件"）
    'scripts/smoke/util.js',                // 域目录里的**非域文件** ⇒ 全量 ✓（关键保守性）
    'package.json', 'vitest.config.js',
    'some/unknown/path.txt'
    /* ⚠️ 2026-10-17（T1 批）**反转的一条旧事实**：这里原先还有
     *    `'projects/comnet/comnet.json',   // 真实数据`
     *  它当时是**对的**（那会儿 `projects/**` 命不中任何规则 ⇒ 兜底全量 ⇒ 至少不会漏）。
     *  但实测暴露了它的代价：**用户只是用了软件**（界面上改一个节点、AI 用 CLI 写一条笔记）就让
     *  `--changed` 从"9 步/十几秒"变成"14 步/二十几分钟"，而且**输出上完全看不出原因** ⇒ 落进
     *  `testing-for-ai` A3b 点名的"把全链绑到每一次提交"，也撞 `docs/RULES.md` 的 **R3a**
     *  （编辑笔记 ≠ 功能迭代，禁止跑 verify 全链）。
     *  ⇒ 现在它归「运行副产物」档（`RULES` 的第一条，见下面那个 describe），**不再是无主文件**。
     *  按 `testing-for-ai` B4 成因④（测试替旧事实站岗）：改事实的同批必须找出并**反转**它 —— 这就是。 */
  ];
  for (const f of MUST_BE_FULL) {
    it(f + ' ⇒ 全量', () => {
      const p = plan(f);
      expect(p.full).toBe(true);
      expect(p.steps).toEqual(FULL_STEPS);
      expect(p.smokeOnly).toBe(null);
    });
  }

  it('已知 + 未知混着 ⇒ 全量（未知那条说了算）', () => {
    const p = plan('docs/RULES.md', 'renderer/app.js');
    expect(p.full).toBe(true);
    expect(p.byRule.some((g) => g.rule.includes('兜底'))).toBe(true);
  });
});

describe('干净工作树与摘要输出', () => {
  it('没有改动 ⇒ 一步都不跑，且理由说清"没有验证任何东西"', () => {
    const p = planForFiles([]);
    expect(p.steps).toEqual([]);
    expect(p.full).toBe(false);
    expect(p.reason).toContain('没有验证任何东西');
  });

  it('describePlan 打出计划与理由（人看一眼就知道为什么选了这些）', () => {
    const lines = describePlan(plan('scripts/smoke/13-ui-state.js'));
    expect(lines.join('\n')).toContain('计划：');
    expect(lines.join('\n')).toContain('冒烟收窄到域：13');
    expect(lines.join('\n')).toContain('个文件');
  });
});

/* ============================================================================
 * 「运行副产物」档（T1 批，2026-10-17）：**不是源码、不是越界、也不许触发兜底全量**
 * ----------------------------------------------------------------------------
 * 实测依据：`projects/**`（用户的项目数据）原先命不中任何规则 ⇒ 兜底全量 ⇒
 * **用户只是用了软件**就让 `--changed` 付全链的价（`docs/RULES.md` 的 R3a 明确不许这么干）。
 * 这一档的判据（三条同时成立才算）：① 正常使用就会变；② 可重新生成 / 本身就是数据；③ 不改源码行为。
 * ========================================================================== */
describe('运行副产物档：不算越界、不触发兜底全量', () => {
  const BP = ['projects/comnet/comnet.json', 'projects/x/assets/a.png',
    'dist/x.exe', 'build/y', 'a/b.tmp', '.tmp-img/z.png', 'smoke-shot.png', 'smoke-frame.json', 'x/y.log'];

  for (const f of BP) {
    it(f + ' ⇒ 不是全量，只跑数据校验（G2）', () => {
      const p = plan(f);
      expect(p.full).toBe(false);
      expect(p.steps).toContain('G2');
      expect(p.steps).not.toContain('G5');        // 副产物不改源码行为 ⇒ 冒烟不为它跑
      expect(p.byproducts.map((x) => x.path)).toEqual([f]);
      expect(p.byproducts[0].label).toBeTruthy();  // 点名它是哪一类（"不许静默放过"）
    });
  }

  it('**全是副产物** ⇒ reason 直说"运行副产物"，不写成含糊的"都在已知范围内"', () => {
    const p = plan('projects/comnet/comnet.json');
    expect(p.full).toBe(false);
    expect(p.reason).toContain('运行副产物');
    expect(p.reason).toContain('不是越界');
    expect(describePlan(p).join('\n')).toContain('**不是越界、也不是无人认领**');
  });

  it('副产物 + 源码混着 ⇒ **源码那条说了算**（保守性不因这一档而松）', () => {
    const p = plan('projects/comnet/comnet.json', 'src/schema.js');
    expect(p.full).toBe(true);
    const q = plan('projects/comnet/comnet.json', 'docs/RULES.md');
    expect(q.full).toBe(false);
    expect(q.steps).toContain('G3');              // 文档那一条的价还在
    expect(q.steps).toContain('G2');              // 副产物那一条的价也在
  });

  it('判别力：**把副产物那条规则拿掉** ⇒ 同一批文件退回兜底全量（说明这一档真在起作用）', () => {
    const files = ['projects/comnet/comnet.json'];
    const withOut = planForFiles(files, { rules: cc.RULES.filter((r) => r.byproduct !== true) });
    expect(withOut.full).toBe(true);
    expect(planForFiles(files).full).toBe(false);
  });

  it('`--for byproduct`（SURFACES 那一面）与 RULES 那条**同一档**：steps 都是 BYPRODUCT_STEPS', () => {
    const s = cc.SURFACES.filter((x) => x.id === 'byproduct')[0];
    expect(s).toBeTruthy();
    expect(s.steps).toEqual(cc.BYPRODUCT_STEPS);
    const p = cc.planForSurface('byproduct');
    expect(p.steps).toContain('G2');
    expect(p.steps).not.toContain('G5');
  });
});

/* ============================================================================
 * 「批次越界检查」（T1 批）：本批声明面 × 实际改动清单
 * ----------------------------------------------------------------------------
 * `architecture-for-ai` E1 的**另一半**：一条命令能不能列出「本批声明的面之外」被改动的文件？
 * 判据 = 「改动文件里有没有**既不属于本次声明面、也不是运行副产物**的」。
 * 四个身份互斥（副产物 / 本批 / 别批在飞 / 无人认领），**只有"无人认领"会让判定变红**。
 * 判别力证明（B4）：正反两向都钉死 —— 面外源码 ⇒ **必红**；只改 `projects/**` ⇒ **不许红**。
 * ========================================================================== */
describe('越界判定：三档 + 四种身份（正反两向的判别力）', () => {
  const { planBoundary, describeBoundary, matchClaim } = cc;

  it('没声明面 ⇒ `skipped`（**未验证，不是通过** —— 与 ok 必须可区分）', () => {
    const r = planBoundary(['src/a.js'], {});
    expect(r.status).toBe('skipped');
    expect(r.ok).toBe(false);                 // ★ 关键：skipped 绝不许被读成 ok
    expect(describeBoundary(r).join('\n')).toContain('本次没判');
    expect(describeBoundary(r).join('\n')).toContain('未验证');
  });

  it('采不到改动清单（git 失败）⇒ `skipped`，理由说"采不到真值 ≠ 通过"', () => {
    const r = planBoundary(null, { claimed: ['src/'] });
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('采不到真值');
  });

  it('工作树干净 ⇒ `skipped`，且说"这不算通过，只是没有输入"', () => {
    const r = planBoundary([], { claimed: ['src/'] });
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('不算通过');
  });

  it('**面外有源码级文件 ⇒ 必红**（本判据"会红"的证明）', () => {
    const r = planBoundary(['docs/x.md', 'src/zz-probe.js'], { claimed: ['docs/'] });
    expect(r.status).toBe('violation');
    expect(r.unclaimed).toEqual(['src/zz-probe.js']);
    expect(describeBoundary(r).join('\n')).toContain('✗ src/zz-probe.js');
  });

  it('**只改了 `projects/**` ⇒ 不许红**（反方向：用户用了软件不该被判越界）', () => {
    const r = planBoundary(['projects/comnet/comnet.json'], { claimed: ['scripts/changed-plan.js'] });
    expect(r.status).toBe('ok');
    expect(r.unclaimed).toEqual([]);
    expect(r.byproduct.map((x) => x.path)).toEqual(['projects/comnet/comnet.json']);
    const t = describeBoundary(r).join('\n');
    expect(t).toContain('✓ 无越界');
    expect(t).toContain('**不算越界**');
  });

  it('**别批已登记 ⇒ 不许红**（多批并发不制造假红）', () => {
    const r = planBoundary(['src/a.js', 'docs/x.md'],
      { claimed: ['docs/'], claims: [{ id: 'T9', files: ['src/a.js'] }] });
    expect(r.status).toBe('ok');
    expect(r.other.map((x) => x.batch)).toEqual(['T9']);
  });

  it('**别批没登记 ⇒ 会红**（三种身份不是"有就放过"；也说明 claim 登记不是装饰）', () => {
    const r = planBoundary(['src/a.js', 'docs/x.md'], { claimed: ['docs/'] });
    expect(r.status).toBe('violation');
    expect(r.unclaimed).toEqual(['src/a.js']);
  });

  it('身份的四种取值**互斥且穷尽**：每个改动文件恰好落进一格（计数现算）', () => {
    const r = planBoundary(
      ['docs/x.md', 'src/mine.js', 'src/other.js', 'projects/p/p.json', 'root-new.txt'],
      { claimed: ['docs/', 'src/mine.js'], claims: [{ id: 'T9', files: ['src/other.js'] }] });
    expect(r.counts.files).toBe(5);
    expect(r.counts.mine + r.counts.byproduct + r.counts.other + r.counts.unclaimed).toBe(r.counts.files);
    expect(r.mine).toEqual(['docs/x.md', 'src/mine.js']);
    expect(r.unclaimed).toEqual(['root-new.txt']);   // 工程根新文件：不是副产物 ⇒ 仍算无主
  });

  it('声明面三种写法都认：`dir/` 前缀 · 精确文件 · glob（`**` 跨目录、`*` 不跨）', () => {
    expect(matchClaim('docs/RULES.md', 'docs/')).toBe(true);
    expect(matchClaim('docs/RULES.md', 'docs/RULES.md')).toBe(true);
    expect(matchClaim('tests/a/b.test.js', 'tests/')).toBe(true);
    expect(matchClaim('tests/x.test.js', 'tests/*.test.js')).toBe(true);
    expect(matchClaim('tests/sub/x.test.js', 'tests/*.test.js')).toBe(false);   // `*` 不跨目录
    expect(matchClaim('renderer/a/b.js', 'renderer/**')).toBe(true);            // `**` 跨目录
    expect(matchClaim('src/a.js', 'docs/')).toBe(false);
    expect(matchClaim('docs', 'docs/')).toBe(true);                             // 前缀也认目录本身
  });

  it('打印必须三档可分（`B8`：只报"跑了什么"会把"没判"读成"过了"）', () => {
    const t = (r) => describeBoundary(r).join('\n');
    expect(t(planBoundary(['a'], {}))).toContain('本次没判');
    expect(t(planBoundary(['projects/p/p.json'], { claimed: ['x/'] }))).toContain('✓ 无越界');
    expect(t(planBoundary(['src/a.js'], { claimed: ['x/'] }))).toContain('✗');
    const first = (r) => describeBoundary(r)[0];
    expect(first(planBoundary(['a'], {})))
      .not.toBe(first(planBoundary(['projects/p/p.json'], { claimed: ['x/'] })));
  });
});

describe('别批在飞登记（`.review/claim-*.json`）的读取', () => {
  const { readClaims } = cc;
  /* ⚠️ 探针目录落在**系统临时目录**、名字带 pid（`E5`：临时物唯一化 + 别放进被扫描的树）。
   * 为什么不放 `.review/` 下：G8 要求 `.review/` 的每个**直接子目录**都有 `README.md`
   * （`docs-registry-check` 的 `checkWorkDirStatus`），而 vitest 是**并行**的 ⇒ 万一有人同时跑
   * `check:docs`，会看见一个没有 README 的临时子目录 ⇒ **假红**（本工程真吃过这类并发假红）。 */
  const os = require('node:os');
  const dir = path.join(os.tmpdir(), 'mm-claim-probe-' + process.pid);

  it('读得懂 ⇒ 计入；**读不懂 ⇒ 响亮列出且不计入**（不许把坏登记当"它认领了这些"）', () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'claim-ok.json'),
        JSON.stringify({ batch: 'T9', files: ['src/a.js', 'tests/'] }), 'utf8');
      fs.writeFileSync(path.join(dir, 'claim-broken.json'), '{ 这不是 JSON', 'utf8');
      fs.writeFileSync(path.join(dir, 'claim-nofiles.json'), JSON.stringify({ batch: 'T8' }), 'utf8');
      const r = readClaims(dir);
      expect(r.claims).toEqual([{ id: 'T9', files: ['src/a.js', 'tests/'] }]);
      expect(r.errors.length).toBe(2);
      expect(r.errors.join('\n')).toContain('不计入');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('目录不存在 = 没有别批登记（正常，不报错）', () => {
    const r = readClaims(path.join(ROOT, '.review', '不存在的目录-' + process.pid));
    expect(r.claims).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('`claim-` 前缀之外的 json 不算登记（名字是判据的一部分）', () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'notaclaim.json'),
        JSON.stringify({ batch: 'T7', files: ['src/b.js'] }), 'utf8');
      expect(readClaims(dir).claims).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ============================================================================
 * 接线检查（源码级）：映射算得对不够，**verify.js 得真的照着做** ——
 * 同上位文件 tests/verify-budget.test.js 守"RULES.md 里声明的门禁必须真挂在链上"的做法。
 * 这两条一旦断了，表现是"看起来跑了部分验证"，实际是**跳过没跑**或**冒充全链结论** ✗
 * ========================================================================= */
describe('接线：verify.js 真的按计划跳过、收窄、分格记录', () => {
  it('收窄冒烟时把 SMOKE_ONLY 传给 G5（走既有机制，不另造一套）', () => {
    expect(verifySrc).toMatch(/plan\.smokeOnly/);
    expect(verifySrc).toMatch(/SMOKE_ONLY:/);
    const at = verifySrc.indexOf('SMOKE_ONLY:');
    expect(verifySrc.slice(Math.max(0, at - 320), at)).toContain("s.gate === 'G5'");
  });

  it('计划外的步骤被跳过，且标出**为什么**跳过（不能只是 ms=0 让人误会成"很快"）', () => {
    expect(verifySrc).toContain("skippedBy: 'changed'");
    expect(verifySrc).toContain('计划外');
  });

  it('部分验证**不覆盖** last-verify.json（那句"上次全链"不能被 4 步的记录改写）', () => {
    // 两处收尾（失败/成功）都必须是"partial ? 另一格 : last-verify"
    const hits = verifySrc.match(/if \(partial\) writeLastVerifyChanged\(run\); else writeLastVerify\(run\);/g) || [];
    expect(hits.length).toBe(2);
    expect(verifySrc).toContain('LAST_VERIFY_CHANGED');
  });

  it('历史记录标 partial，且耗时基线不认它（与"失败/中断不当基线"同一个理由）', () => {
    expect(verifySrc).toContain('partial: run.partial === true');
    expect(verifySrc).toMatch(/r\.partial !== true/);
  });

  it('横幅必须说清"这不是全量真值"（部分验证最危险的用法就是被当成验收）', () => {
    expect(verifySrc).toContain('这不是全量真值');
    expect(verifySrc).toContain('没有验证任何东西');
  });
});

/* ============================================================================
 * `--for <改动面>`（本批新增）：矩阵表 + 自检 + 分叉判定
 * ----------------------------------------------------------------------------
 * 这张表是**唯一会"少跑东西"的地方**（表错 ⇒ 表现是"验证通过了"，而该跑的那一层压根没跑）；
 * 所以这里锁的都是**结构性**判据：域号真实存在 / 每域恰好一个面登记 / 声明跑冒烟 ⇔ 声明了域 /
 * 表的条数**现算**。判别力证明用**注入坏表**（删一项、写悬挂域号、重复登记）—— 每条都必须判红 ✓。
 * ========================================================================== */
describe('改动面矩阵：表与真值必须对得上（自检判红 + 判别力）', () => {
  const { SURFACES, surfaceSelfCheck, surfaceIds, planForSurface, parseForArgs, describeNotRun,
    planDivergence, domainNumbersIn, effectiveSteps, SURFACE_FLOOR, FULL_STEPS } = cc;
  const smokeDir = path.join(ROOT, 'scripts', 'smoke');
  const domainNumbers = domainNumbersIn(smokeDir);

  it('真表 + 真域号 ⇒ 通过；条数**现算**（登记数 == 目录里的域数，两处都不是手抄的）', () => {
    const chk = surfaceSelfCheck(domainNumbers);
    expect(chk.errors).toEqual([]);
    expect(chk.ok).toBe(true);
    expect(chk.stats.domainsInRepo).toBe(domainNumbers.length);
    expect(chk.stats.domainClaims).toBe(domainNumbers.length);
    expect(chk.stats.domainsInRepo).toBeGreaterThan(40);        // 非空转：真扫到了域
  });

  it('`scripts/smoke/` 里除域文件外的东西不算域（`NN-*.js` 才是域）', () => {
    const all = fs.readdirSync(smokeDir).filter((f) => f.endsWith('.js'));
    expect(domainNumbers.length).toBeLessThan(all.length);      // 目录里有非域件（公共件/选择器）
    expect(domainNumbers.every((d) => /^\d+$/.test(d))).toBe(true);
  });

  it('**每个面都自动含"卫生八件 + G3 + G6"**（写不出"少付这一档"的面 —— 结构保证）', () => {
    for (const s of SURFACES) {
      const eff = effectiveSteps(s);
      for (const g of SURFACE_FLOOR) expect(eff, s.id + ' 少了 ' + g).toContain(g);
    }
  });

  it('判别力：**删掉一项登记** ⇒ 判红并点名那个域（新加的域必须同批归到某个面下）', () => {
    const broken = SURFACES.map((s) => (s.id === 'renderer'
      ? Object.assign({}, s, { domains: s.domains.slice(0, -1) }) : s));
    const chk = surfaceSelfCheck(domainNumbers, broken);
    expect(chk.ok).toBe(false);
    expect(chk.errors.join('\n')).toContain('一个面都没登记');
  });

  it('判别力：**写一个不存在的域号** ⇒ 判红并点名它是悬挂登记', () => {
    const broken = SURFACES.map((s) => (s.id === 'main'
      ? Object.assign({}, s, { domains: s.domains.concat(['99']) }) : s));
    const chk = surfaceSelfCheck(domainNumbers, broken);
    expect(chk.ok).toBe(false);
    expect(chk.errors.join('\n')).toContain('悬挂登记');
    expect(chk.errors.join('\n')).toContain('99');
  });

  it('判别力：**同一域被两个面登记** ⇒ 判红（"恰好一次"这条不是为了好看）', () => {
    const broken = SURFACES.map((s) => (s.id === 'main'
      ? Object.assign({}, s, { domains: s.domains.concat(['01']) }) : s));
    const chk = surfaceSelfCheck(domainNumbers, broken);
    expect(chk.ok).toBe(false);
    expect(chk.errors.join('\n')).toContain('被两个面同时登记');
  });

  it('判别力：**声明跑冒烟却不登记域** / **登记了域却不跑冒烟** ⇒ 两条都判红', () => {
    const a = SURFACES.map((s) => (s.id === 'renderer' ? Object.assign({}, s, { domains: [] }) : s));
    expect(surfaceSelfCheck(domainNumbers, a).errors.join('\n')).toContain('却没登记任何域');
    const b = SURFACES.map((s) => (s.id === 'renderer' ? Object.assign({}, s, { steps: [] }) : s));
    expect(surfaceSelfCheck(domainNumbers, b).errors.join('\n')).toContain('却不跑冒烟');
  });

  it('判别力：**domainsAll 又列具体域** / **一个 domainsAll 都没有** ⇒ 两条都判红', () => {
    const a = SURFACES.map((s) => (s.id === 'smoke' ? Object.assign({}, s, { domains: ['01'] }) : s));
    expect(surfaceSelfCheck(domainNumbers, a).errors.join('\n')).toContain('既声明 domainsAll 又列了');
    const b = SURFACES.filter((s) => !s.domainsAll);
    expect(surfaceSelfCheck(domainNumbers, b).errors.join('\n')).toContain('这条能力就不存在了');
  });

  it('判别力：**步骤名打错**（链上不存在的一步）⇒ 判红', () => {
    const a = SURFACES.map((s) => (s.id === 'docs' ? Object.assign({}, s, { steps: ['G99'] }) : s));
    expect(surfaceSelfCheck(domainNumbers, a).errors.join('\n')).toContain('链上不存在的步骤：G99');
  });
});

describe('`--for <面>` 的计划：选哪些步、跑哪些域、没跑什么', () => {
  const { planForSurface, describeNotRun, FULL_STEPS } = cc;

  it('docs / tests / scripts / src：不跑冒烟，且各自带上该带的层', () => {
    const docs = planForSurface('docs');
    expect(docs.steps).not.toContain('G5');
    expect(docs.smokeOnly).toBe(null);
    expect(docs.steps).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G3', 'G6']);
    const src = planForSurface('src');
    expect(src.steps).toContain('G4');
    expect(src.steps).toContain('G2');
    expect(src.steps).not.toContain('G5');
    const scripts = planForSurface('scripts');
    expect(scripts.steps).toContain('G4');
    expect(scripts.steps).not.toContain('G2');
  });

  it('renderer / main / cli：跑冒烟，且只跑表里登记的域（**逐项**对得上）', () => {
    const r = planForSurface('renderer');
    expect(r.steps).toContain('G5');
    expect(r.smokeOnly.slice().sort()).toEqual(
      cc.SURFACES.filter((x) => x.id === 'renderer')[0].domains.slice().sort());
    expect(r.smokeOnly).toContain('42');           // 域 42 归渲染面（本批改的那个域）
    const m = planForSurface('main');
    expect(m.smokeOnly).toContain('07');
    expect(m.smokeOnly).not.toContain('42');
    const c = planForSurface('cli');
    expect(c.smokeOnly).toEqual(['27', '43', '44']);
  });

  it('smoke（冒烟底板）⇒ 跑**全部**域（不收窄：改的是所有域共用的底板）', () => {
    const s = planForSurface('smoke');
    expect(s.steps).toContain('G5');
    expect(s.smokeOnly).toBe(null);
    expect(s.domainsAll).toBe(true);
  });

  it('all ⇒ 全链（与不带开关的默认档同形：steps == FULL_STEPS 且 full=true）', () => {
    const a = planForSurface('all');
    expect(a.full).toBe(true);
    expect(a.steps).toEqual(FULL_STEPS);
    expect(a.smokeOnly).toBe(null);
  });

  it('`--domains` 只能**收窄这一面登记过的**域；给别的面的域 ⇒ 响亮拒绝（不许静默跑别的）', () => {
    const r = planForSurface('renderer', { domains: ['42', '45'] });
    expect(r.smokeOnly).toEqual(['42', '45']);
    expect(() => planForSurface('renderer', { domains: ['07'] })).toThrow(/不在改动面 renderer 的登记里/);
    expect(() => planForSurface('docs', { domains: ['01'] })).toThrow(/不跑冒烟/);
    const s = planForSurface('smoke', { domains: ['42'] });
    expect(s.smokeOnly).toEqual(['42']);
  });

  it('不认识的面 ⇒ 抛错并**列出可选面**（采不到真值 = 红，不许静默退回全量）', () => {
    expect(() => planForSurface('nope')).toThrow(/不认识的改动面/);
    expect(() => planForSurface('nope')).toThrow(/docs/);
  });

  it('**"没跑什么"必须逐条说出来**（只报"跑了什么"会把"没跑"读成"过了"），且点名去哪个面跑它', () => {
    const lines = describeNotRun(planForSurface('docs')).join('\n');
    expect(lines).toContain('没跑什么');
    expect(lines).toContain('G4（要跑它请用');
    expect(lines).toContain('G5（要跑它请用');
    expect(lines).toContain('冒烟（G5）本轮**不跑**');
    const r = describeNotRun(planForSurface('renderer')).join('\n');
    expect(r).toContain('冒烟只跑域');
    expect(r).toContain('其余域本轮一个都不跑');
    expect(r).not.toContain('G7（要跑它请用');         // G7 与 G6 共用一次调用，不算"没跑"
  });

  it('全链 ⇒ 没有"没跑什么"可言（默认档输出一个字节都不多）', () => {
    expect(describeNotRun(planForSurface('all'))).toEqual([]);
    expect(describeNotRun(null)).toEqual([]);
  });
});

describe('`--for` 的参数解析（一处实现：`parseForArgs`）', () => {
  const { parseForArgs } = cc;
  const argv = (...a) => ['node', 'scripts/verify.js'].concat(a);

  it('不带开关 ⇒ mode=full（**默认档**：调用方据此保持 plan=null，一步都不裁）', () => {
    expect(parseForArgs(argv())).toEqual({ mode: 'full', surface: null, domains: null,
      claimed: null, boundaryMode: cc.BOUNDARY_DEFAULT, error: null });
  });
  it('`--claimed` / `--boundary` 只在 `--changed` 档有意义 ⇒ 别的档给了就**响亮拒绝**', () => {
    expect(parseForArgs(argv('--claimed', 'src/')).error).toContain('只能跟着 `--changed`');
    expect(parseForArgs(argv('--for', 'docs', '--boundary=strict')).error).toContain('只能跟着 `--changed`');
  });
  it('`--claimed a,b` ⇒ 解析成去空白的清单；空清单 ⇒ 报错（不许当"没给"）', () => {
    expect(parseForArgs(argv('--changed', '--claimed', ' src/x.js , docs/ ')).claimed)
      .toEqual(['src/x.js', 'docs/']);
    expect(parseForArgs(argv('--changed', '--claimed', '  ')).error).toContain('空清单');
  });
  it('`--boundary` 只认 report / strict；**strict 必须带 `--claimed`**（否则没有声明面可判）', () => {
    expect(parseForArgs(argv('--changed', '--boundary=strict')).error).toContain('必须同时给 `--claimed');
    expect(parseForArgs(argv('--changed', '--claimed', 'src/', '--boundary=strict')).boundaryMode).toBe('strict');
    expect(parseForArgs(argv('--changed', '--claimed', 'src/', '--boundary=nope')).error).toContain('只认');
  });
  it('默认档 = report（依据 = 实测误报率；这条把它钉住，别悄悄改成 strict）', () => {
    expect(cc.BOUNDARY_DEFAULT).toBe('report');
    expect(parseForArgs(argv('--changed')).boundaryMode).toBe('report');
  });
  it('--for docs / --for=docs 两种写法等价', () => {
    expect(parseForArgs(argv('--for', 'docs')).surface).toBe('docs');
    expect(parseForArgs(argv('--for=docs')).surface).toBe('docs');
  });
  it('--for 后面缺值 ⇒ 明确报错（不许当成"没给"静默跑全链）', () => {
    expect(parseForArgs(argv('--for')).error).toContain('要跟一个改动面名');
  });
  it('--changed 与 --for 同时给 ⇒ 报错（两套选择口径不许同时生效）', () => {
    expect(parseForArgs(argv('--changed', '--for', 'docs')).error).toContain('只能给一个');
  });
  it('--domains 单独出现 ⇒ 报错（没有"面"可收窄）', () => {
    expect(parseForArgs(argv('--domains', '42')).error).toContain('只能跟着');
  });
  it('--for smoke --domains 42,45 ⇒ 域号被解析出来（去空白）', () => {
    const p = parseForArgs(argv('--for', 'smoke', '--domains', ' 42 , 45 '));
    expect(p.domains).toEqual(['42', '45']);
    expect(p.error).toBe(null);
  });
  it('--changed 单独给 ⇒ mode=changed（既有档不动）', () => {
    expect(parseForArgs(argv('--changed')).mode).toBe('changed');
    expect(parseForArgs(argv('--changed')).error).toBe(null);
  });
});

describe('表与实跑分叉 ⇒ 判红（运行时核对）', () => {
  const { planDivergence, planForSurface } = cc;
  const run = (gate, skipped) => ({ gate, skipped: !!skipped, code: skipped ? null : 0 });

  it('一致 ⇒ ok（计划内的都跑了、计划外一个都没跑）', () => {
    const p = planForSurface('docs');
    const actual = p.steps.map((g) => run(g, g === 'G7'))
      .concat(cc.FULL_STEPS.filter((g) => p.steps.indexOf(g) < 0).map((g) => run(g, true)));
    expect(planDivergence(p, actual).ok).toBe(true);
  });

  it('**计划内的一步没跑** ⇒ 红（"表说跑、实跑没跑"正是 `--for` 最危险的那种失效）', () => {
    const p = planForSurface('docs');
    const actual = p.steps.map((g) => run(g, g === 'G3'))
      .concat(cc.FULL_STEPS.filter((g) => p.steps.indexOf(g) < 0).map((g) => run(g, true)));
    const d = planDivergence(p, actual);
    expect(d.ok).toBe(false);
    expect(d.errors.join('\n')).toContain('计划内的步骤没跑');
    expect(d.errors.join('\n')).toContain('G3');
  });

  it('**计划外的一步真的跑了** ⇒ 红（少报"跑了什么"等于把计划当成免责声明）', () => {
    const p = planForSurface('docs');
    const actual = p.steps.map((g) => run(g)).concat([run('G5', false),
      ...cc.FULL_STEPS.filter((g) => p.steps.indexOf(g) < 0 && g !== 'G5').map((g) => run(g, true))]);
    const d = planDivergence(p, actual);
    expect(d.ok).toBe(false);
    expect(d.errors.join('\n')).toContain('计划外的步骤真的跑了');
    expect(d.errors.join('\n')).toContain('G5');
  });

  it('计划内的一步**没有结果**（采不到）⇒ 也判红（采不到真值不算通过）', () => {
    const p = planForSurface('docs');
    const actual = p.steps.filter((g) => g !== 'G6').map((g) => run(g, g === 'G7'));
    expect(planDivergence(p, actual).errors.join('\n')).toContain('没有结果');
  });

  it('G7 与 G6 共用一次调用 ⇒ 它是 skipped 的**正常形态**，不算分叉', () => {
    const p = planForSurface('renderer');
    const actual = p.steps.map((g) => run(g, g === 'G7'))
      .concat(cc.FULL_STEPS.filter((g) => p.steps.indexOf(g) < 0).map((g) => run(g, true)));
    expect(planDivergence(p, actual).ok).toBe(true);
  });
});

describe('接线与"一处实现"：verify.js 只照表做事，别再抄一份面表', () => {
  const verifyFile = path.join(ROOT, 'scripts', 'verify.js');
  const verifyText = fs.readFileSync(verifyFile, 'utf8');

  it('自检 / 计划 / 没跑什么 / 分叉判定 四个口都被接上了', () => {
    expect(verifyText).toContain('changedPlan.surfaceSelfCheck(');
    expect(verifyText).toContain('changedPlan.planForSurface(');
    expect(verifyText).toContain('changedPlan.describeNotRun(');
    expect(verifyText).toContain('changedPlan.planDivergence(');
    expect(verifyText).toContain('changedPlan.parseForArgs(');
  });

  it('自检**排在跑任何一步之前**（表坏了当场红，不许先付十几分钟的链）', () => {
    const atCheck = verifyText.indexOf('changedPlan.surfaceSelfCheck(');
    const atLoop = verifyText.indexOf('for (const s of STEPS) {');
    expect(atCheck).toBeGreaterThan(0);
    expect(atCheck).toBeLessThan(atLoop);
  });

  it('`--for all` 走**默认档**那条路（plan 保持 null ⇒ 输出与不带开关逐字节相同）', () => {
    expect(verifyText).toContain('plan = p.full ? null : p;');
  });

  /* ---- 批次越界检查（T1 批）的挂点：**既有门禁面**上，不新开全链步 ---- */
  it('越界判定挂在 `--changed` 档里：判定/打印两个口都接上了', () => {
    expect(verifyText).toContain('changedPlan.planBoundary(');
    expect(verifyText).toContain('changedPlan.describeBoundary(');
    expect(verifyText).toContain('changedPlan.readClaims(');
  });

  it('挂点位置：**在 `--changed` 分支里**、且在 `for (const s of STEPS)` **之前**（别批的改动不配让本批白跑十分钟）', () => {
    const atChanged = verifyText.indexOf("else if (sel.mode === 'changed')");
    /* ⚠️ 从 `atChanged` **往后**找：`evaluateBoundary(` 的**函数定义**在文件前部（≈第 185 行），
     * 先从头 indexOf 会命中定义 ⇒ 这条接线检查会变成恒真的空转（本工程踩过这个形状）。 */
    const atCall = verifyText.indexOf('evaluateBoundary(files, sel)', atChanged);
    const atLoop = verifyText.indexOf('for (const s of STEPS) {');
    expect(atChanged).toBeGreaterThan(0);
    expect(atCall).toBeGreaterThan(atChanged);      // 在 changed 分支**之内**（不在默认全量档里）
    expect(atCall).toBeLessThan(atLoop);            // 早于任何一步 ⇒ 判红不付链的价
    expect(verifyText).toContain("sel.boundaryMode === 'strict'");
  });

  it('**不新开一条全链步**（H3：不给高频动作加新成本）—— STEPS 里没有任何越界门禁的编号', () => {
    const stepsBlock = verifyText.slice(verifyText.indexOf('const STEPS = ['), verifyText.indexOf('const TOTAL_BUDGET_MS'));
    expect(stepsBlock.length).toBeGreaterThan(1000);
    expect(stepsBlock).not.toMatch(/gate:\s*'(B\d|BOUNDARY)/);
    // 默认全量档**不进** changed 分支 ⇒ `npm run verify` 的输出不因这批改变
    expect(verifyText).toContain("const sel = changedPlan.parseForArgs(process.argv);");
  });

  it('面表只有一处实现：`id: \'<面>\', what: …` 这种形态只许出现在 scripts/changed-plan.js', () => {
    // 扫描面（共享常量，一处）+ 行级剥注释（注释里的示例不算实现 —— B4b 的实测教训）
    const SCAN = ['scripts', 'cli', 'src', 'renderer', 'main.js', 'preload.js'];
    /** needle 用**实现形态**（面表那一行的形状）：别的表也有 `id:`，所以不能只认 `id:` 或面名 */
    const ROW_RE = /id: '(docs|tests|scripts|smoke|src|cli|main|renderer|all)', what:/;
    const findCopies = (files) => files.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))                 // 剥注释行
      .some((l) => ROW_RE.test(l)));
    const walk = (rel, out) => {
      const abs = path.join(ROOT, rel);
      const st = fs.statSync(abs);
      if (st.isDirectory()) fs.readdirSync(abs).forEach((n) => walk(rel.replace(/\\/g, '/') + '/' + n, out));
      else if (/\.js$/.test(rel)) out.push(rel);
      return out;
    };
    const files = [].concat(...SCAN.map((rel) => walk(rel, [])));
    expect(files.length, '扫描面不该是空的').toBeGreaterThan(20);
    expect(findCopies(files)).toEqual(['scripts/changed-plan.js']);
    // 判别力：把同一个 needle 放进第二个文件 ⇒ 必红（否则这条判据是空转的）
    /* ⚠️ 2026-10-16 修一条**并发假红**（实测：全链第 9 步 G3 报
     *    `ENOENT: no such file or directory, open 'D:\…\scripts\__copy-probe.js'`）。
     *    成因：这条探针原先把文件写进 **`scripts/`**，而 `tests/w8-dry-run.test.js` 的 D4
     *    会**遍历整棵树逐个 `readFileSync`**（`.js`/`.mjs`）；vitest 是**并行**跑测试文件的
     *    （`--pool=threads`）⇒ walker 可能"列目录时它还在、读时已被 `finally` 删掉"
     *    ⇒ 它红，而**两个文件各自的代码都没错**（链内红 / 单跑绿，正是"顺序·状态依赖"那一类）。
     *    修法（照 `testing-for-ai` E5"临时物必须唯一化、且别放进被扫描的树"）：
     *    探针落到 `.review/` 下的**散落文件**（名字带进程号）—— 它是本工程的**工作产物区**
     *    （`w8-dry-run` 的 walker 显式跳过 `.review`，本文件的 SCAN 面也不含它）⇒
     *    walker 再也看不到它；同时 `findCopies` 仍按"相对 ROOT 的路径"读得到它 ⇒ 判别力不减 ✓。
     *    ⚠️ 用**文件**、不建子目录：G8 要求 `.review/` 的每个**直接子目录**都有 `README.md`
     *    （`docs-registry-check` 的 `checkWorkDirStatus`），而**散落文件是豁免**的
     *    ⇒ 万一这次跑崩了留残，也不会制造一条新的假红 ✓。
     *    收尾仍在 `finally` 里**只清自己那一个文件**（不按通配清别人的 ✗）。 */
    const fakeAbs = path.join(ROOT, '.review', '.changed-plan-probe-' + process.pid + '.js');
    const fakeRel = path.relative(ROOT, fakeAbs).split(path.sep).join('/');
    try {
      fs.writeFileSync(fakeAbs, "const copy = { id: 'renderer', what: '第二份面表' };\n", 'utf8');
      expect(findCopies(['scripts/changed-plan.js', fakeRel]))
        .toEqual(['scripts/changed-plan.js', fakeRel]);
    } finally { fs.rmSync(fakeAbs, { force: true }); }
  });
});
