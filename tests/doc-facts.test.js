/* ============================================================
 * tests/doc-facts.test.js — 文档真值门禁（G6）的判定逻辑
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * ## 这个文件为什么存在
 * `scripts/doc-facts.js` 原先**在文件末尾无条件执行 `main()`** ⇒ `require` 它会**直接跑主流程**
 * ⇒ **无法被单测引入** ⇒ 本工程门禁里，它的判定逻辑**长期没有单测**。
 * 代价在 2026-09-26 体现过：它的断言正则**要求数字紧邻「断言」**，而中文的自然写法是
 * 「**2 条视觉断言**」（类别词夹在数字与「断言」之间）⇒ **匹配不到** ⇒
 * 把"视觉断言数"写进任何 markdown 都**不进判定** —— **门禁在空转**。
 * 那次是靠**手动的判别力证明**（注入一行错数、看它是否变红）才发现的，不是靠单测。
 *
 * ⇒ 现在给 `doc-facts.js` 加了 `require.main` 守卫并把判定逻辑抽成纯函数 `parseClaims(line)`，
 *    **本文件就是那段逻辑的第一批单测**。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const df = require('../scripts/doc-facts.js');
const verify = require('../scripts/verify.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 临时目录只从这里建（工程口径：`tests/_tmp-cleanup.js` 是唯一入口，创建即登记） */
const tmpDir = () => makeTmp('mm-docfacts-cache-');
afterAll(cleanupAll);

/** 取某一类声明（便于断言） */
const claimsOf = (line, kind) => df.parseClaims(line).filter((c) => c.kind === kind);

describe('require.main 守卫：可被单测引入，且不跑主流程', () => {
  it('导出判定逻辑 + 快档（`--no-vitest`）的缓存判定，且三档 stale 都能被单独打红', () => {
    expect(typeof df.parseClaims).toBe('function');
    expect(typeof df.scan).toBe('function');
    expect(typeof df.trackedFiles).toBe('function');

    /* ============================================================
     * 快档 `--no-vitest`（2026-10-22）：用例数取缓存，不重跑 vitest
     * ------------------------------------------------------------
     * 为什么这组断言塞在**既有** `it()` 里，而不新开用例：
     *   新增一条 `it()` 会让单测用例数 +1 ⇒ `docs/VERIFY.md` 里那行「N 用例」**当场过期** ⇒
     *   全链变红；而修它要跑 `doc-facts --write` 且要改 `docs/**`，两件事都不在本批边界内。
     *   ⇒ 本批刻意做**计数中性**的加法；要拆成独立用例，请在跑 `--write` 的那一批里做。
     *
     * 这三件纯函数为什么要单测（而不是"随手写写"）：缓存闸门的失效形态**只有一个**——
     * 它悄悄用了过期值而没人发现。所以三条都要能被单独打红：
     *   ① 指纹一致 ⇒ 认；新增 / 删除 / mtime 变 / size 变 ⇒ 四档都**不认**；
     *   ② 报文必须**点名是哪份文件**并把出路写出来（报错即教程）；
     *   ③ 读缓存三档（missing / invalid / ok）必须可区分 —— 读不到不许读成"没有声明"。
     * ============================================================ */
    expect(typeof df.facts).toBe('function');              // 现场真值本体（诊断用；单测别调它 —— 会跑 vitest）
    expect(typeof df.unitFingerprint).toBe('function');
    expect(typeof df.judgeUnitCache).toBe('function');
    expect(typeof df.readUnitCache).toBe('function');
    expect(typeof df.writeUnitCache).toBe('function');
    expect(typeof df.unitCacheStaleMessage).toBe('function');
    // 缓存只许落在工作产物区（`.review/`，已 gitignore）—— 不许污染受管目录或工程根
    expect(df.UNIT_CACHE_REL.startsWith('.review/')).toBe(true);
    expect(df.UNIT_FINGERPRINT_ROOT).toBe('tests');

    // ① 指纹判定：一致 ⇒ 认；四种"被动过"⇒ 都不认
    const a = [{ rel: 'tests/a.test.js', size: 10, mtimeMs: 1.5 }];
    expect(df.judgeUnitCache(a, a.slice()).ok).toBe(true);
    expect(df.judgeUnitCache([], a)).toMatchObject({ ok: false, added: ['tests/a.test.js'] });
    expect(df.judgeUnitCache(a, [])).toMatchObject({ ok: false, removed: ['tests/a.test.js'] });
    // **"人为把缓存时间戳改旧"就是这一档**（缓存过期 ⇒ 必须 fail）
    expect(df.judgeUnitCache([{ rel: 'tests/a.test.js', size: 10, mtimeMs: 1.5 - 60000 }], a))
      .toMatchObject({ ok: false, changed: ['tests/a.test.js'] });
    // mtime 没变但 size 变了，也算被动过（两个字段各管一半，少比一个就会静默放过一整类改动）
    expect(df.judgeUnitCache([{ rel: 'tests/a.test.js', size: 11, mtimeMs: 1.5 }], a).ok).toBe(false);

    // ② 报文点名文件 + 给出出路（"去掉 --no-vitest 现跑一次"）
    const msg = df.unitCacheStaleMessage(df.judgeUnitCache([{ rel: 'tests/a.test.js', size: 10, mtimeMs: -59998.5 }], a),
      { at: '2026-10-22T00:00:00.000Z', count: 3208 });
    expect(msg).toContain('tests/a.test.js');
    expect(msg).toContain('去掉 `--no-vitest` 现跑一次');
    expect(msg).toContain('2026-10-22T00:00:00.000Z');

    // ③ 读缓存三档可区分
    const dir = tmpDir();
    const f = path.join(dir, 'cache.json');
    expect(df.readUnitCache(f).status).toBe('missing');
    require('node:fs').writeFileSync(f, '{ not json', 'utf8');
    expect(df.readUnitCache(f).status).toBe('invalid');
    require('node:fs').writeFileSync(f, JSON.stringify({ version: 1, count: 5, files: [] }), 'utf8');
    expect(df.readUnitCache(f).status).toBe('invalid');    // 没有指纹 ⇒ 判不了过期 ⇒ 一律不认
    require('node:fs').writeFileSync(f, JSON.stringify({ version: 99, count: 5, files: a }), 'utf8');
    expect(df.readUnitCache(f).status).toBe('invalid');    // 结构版本不认识 ⇒ 不猜

    // 写 → 读 → 判定 fresh：缓存"刚写完就过期"是自相矛盾的，必须能自证
    expect(df.writeUnitCache(3208, 'unit-test', f, ROOT).ok).toBe(true);
    const back = df.readUnitCache(f);
    expect(back.status).toBe('ok');
    expect(back.count).toBe(3208);
    expect(back.by).toBe('unit-test');
    expect(back.files.length).toBe(df.unitFingerprint(ROOT).length);  // 指纹面 = `tests/` 整棵树
    expect(df.judgeUnitCache(back.files, df.unitFingerprint(ROOT)).ok).toBe(true);
    // 非法用例数一律拒写（不静默写 0 / null —— 那会让快档"有个数"但那个数是假的）
    expect(df.writeUnitCache(0, 'x', f, ROOT).ok).toBe(false);
    expect(df.writeUnitCache(null, 'x', f, ROOT).ok).toBe(false);
  });
});

describe('parseClaims：**中文自然写法必须被识别**（这正是那次空转的根因）', () => {
  it('类别词夹在数字与「断言」之间 ⇒ 必须识别为视觉断言数', () => {
    const c = claimsOf('本项目共 99 条视觉断言。', 'visionAssertions');
    expect(c.length).toBe(1);
    expect(c[0].value).toBe(99);
    expect(c[0].label).toBe('视觉断言数');
  });

  it('类别词在数字**之后**、「断言」之前 ⇒ 也必须识别（曾经扫不到的形态）', () => {
    // 这句话就是 `docs/ROADMAP.md` 里那个"从 45 漂到 115、从未被门禁管过"的数字的真实形态
    const c = claimsOf('…`window.MMApp` 导出契约不变，45 冒烟断言全通过）', 'smokeAssertions');
    expect(c.length).toBe(1);
    expect(c[0].value).toBe(45);
    expect(c[0].label).toBe('冒烟断言数');
  });

  it('旧的写法（类别词在数字之前）仍然照旧识别', () => {
    const c = claimsOf('冒烟自检覆盖了这些路径，共 115 条断言', 'smokeAssertions');
    expect(c.length).toBe(1);
    expect(c[0].value).toBe(115);
  });

  it('CLI / 集成两种措辞都归到集成断言数', () => {
    expect(claimsOf('共 167 条集成断言', 'cliAssertions').length).toBe(1);
    expect(claimsOf('共 167 条CLI 断言', 'cliAssertions').length).toBe(1);
  });

  it('**一个类别词都没有 ⇒ 不判定**（宁可不测，也不要误报）', () => {
    expect(df.parseClaims('这里随便写了 3 断言，没有类别词')).toEqual([]);
  });

  it('标题行整行跳过（否则章节号会被当成事实）', () => {
    expect(df.parseClaims('#### 1.2 断言')).toEqual([]);
    expect(df.parseClaims('## 3.1 命令')).toEqual([]);
  });

  it('一行里可以同时有多类声明', () => {
    const all = df.parseClaims('45 命令 / 34 工具 / 515 用例 / 167 集成断言 / 115 冒烟断言 / 2 视觉断言');
    const kinds = all.map((c) => c.kind).sort();
    expect(kinds).toEqual(['cliAssertions', 'commands', 'mcpTools', 'smokeAssertions', 'unitTests', 'visionAssertions']);
  });

  it('数字是纯数字（不是字符串）—— 判定依赖数值比较', () => {
    for (const c of df.parseClaims('共 167 条集成断言')) expect(typeof c.value).toBe('number');
  });

  it('正文里的裸数字不会被误判为事实', () => {
    expect(df.parseClaims('这次改动把耗时从 102.1 秒降到 4.2 秒')).toEqual([]);
  });
});

describe('scan：判别力（用"错的真值"应当抓到；这正是 G6 的机制）', () => {
  it('**没有一条声明能逃过比对**（真值设成不可能的值时，命中数 == 语料里的声明数）', () => {
    // 为什么这么断言（而不是"命中数 > 0"）：
    // 这条测试原先要求"语料里必须有声明"，但本工程的 ADR「易腐事实不手写」要求其他文档**不要**
    // 再抄这些数字（一律指向 VERIFY.md）—— 于是语料里的散文声明会越来越少，最后归零。
    // 那时"命中数 > 0"就会**假红**（门禁其实工作正常，只是没东西可比）。
    // 真正的不变量是：**凡语料里存在的声明，都不得逃过比对**。语料为空时它平凡成立，
    // 语料里有人重新抄了数字时它立刻有意义。
    const bogus = {
      commands: -1, mcpTools: -1, unitTests: -1,
      cliAssertions: -1, smokeAssertions: -1, visionAssertions: -1
    };
    const parsed = df.trackedFiles()
      .flatMap((f) => require('node:fs').readFileSync(f, 'utf8').split(/\r?\n/))
      .reduce((n, line) => n + df.parseClaims(line).length, 0);
    const hits = df.scan(bogus);
    expect(hits.length).toBe(parsed);
    // 命中的标签必须是这几类之一（证明归类发生在判定里，而不是"什么都匹配"）
    for (const l of new Set(hits.map((h) => h.label))) {
      expect(['CLI 命令数', 'MCP 工具数', '单测用例数', 'CLI 集成断言数', '冒烟断言数', '视觉断言数']).toContain(l);
    }
  });

  it('真值为 null（采不到）⇒ **不判定**，不产生条目（"采不到真值=红"由调用方负责）', () => {
    expect(df.scan({ commands: null, mcpTools: null, unitTests: null, cliAssertions: null, smokeAssertions: null, visionAssertions: null })).toEqual([]);
  });

  it('受管文档排除了 CHANGELOG 与归档族（它们记的是历史值）', () => {
    const rels = df.trackedFiles().map((f) => f.replace(/\\/g, '/'));
    expect(rels.some((r) => r.endsWith('/CHANGELOG.md') || r === 'CHANGELOG.md')).toBe(false);
    expect(rels.some((r) => r.includes('/docs/archive/'))).toBe(false);
    expect(rels.some((r) => r.includes('/docs/changelog/'))).toBe(false);
    // 但必须扫到真正该扫的（否则"零命中"是假的）
    expect(rels.some((r) => r.endsWith('/docs/RULES.md'))).toBe(true);
  });
});

/* ============================================================
 * findSizeClaim —— 「体量/行数类易腐数字」那一类（RULES §4 的约定，G6 落地）
 * ------------------------------------------------------------
 * 为什么要有它：那条约定立了但**没有门禁**，实测过期 5 处（"CHANGELOG 已 230+ KB" ×4、
 * 主文件"280 KB" ×1）。判据是"数字要么可当场复核，要么明确是历史" —— 两者都不满足即红。
 * ============================================================ */
describe('findSizeClaim：体量/行数类数字必须有版本锚或历史标记', () => {
  it('裸写 KB/MB ⇒ 命中（会被读成现状）', () => {
    expect(df.findSizeClaim('CHANGELOG 已 230+ KB，其中 Unreleased 不小')).toBeTruthy();
    expect(df.findSizeClaim('运行包 vendor/dsh（323MB，捆绑 Node）')).toBeTruthy();
  });

  it('裸写三位数以上「N 行」⇒ 命中；两位数行数不算（多是普通叙述）', () => {
    expect(df.findSizeClaim('拆分 renderer/app.js（1340 行 → 入口 + 模块）')).toBeTruthy();
    expect(df.findSizeClaim('只改了 30 行代码')).toBeNull();
  });

  it('带版本锚 ⇒ 放行（历史值绑定到了某个版本）', () => {
    expect(df.findSizeClaim('v0.13.0 实测产出 AIMindMap-0.13.0-setup.exe（NSIS，约 106MB）')).toBeNull();
  });

  it('带历史标记（快照 / 原记 / 当时 / 曾）⇒ 放行', () => {
    expect(df.findSizeClaim('（**拆分当时的快照**：1340 行 → 入口 + 9 个模块）')).toBeNull();
    expect(df.findSizeClaim('渲染层已拆分（`renderer/app.js` 曾是 1340 行单文件）')).toBeNull();
    expect(df.findSizeClaim('原记「7 个模块 / 最大 281 行」')).toBeNull();
  });

  it('不误伤小数与版本号的一部分（负向后顾）', () => {
    expect(df.findSizeClaim('0.13 MB 的增量不算声明')).toBeNull();   // 小数：不匹配
    expect(df.findSizeClaim('见 §3.1 节的说明')).toBeNull();
  });
});

/* ============================================================
 * findFutureVersion —— 「高于发布版本的 vX.Y.Z」（接手演练实测出的交接面歧义）
 * ------------------------------------------------------------
 * 实测：README 写「（v0.16.6 起）」、ARCHITECTURE 的 ADR 写「（v0.16.2）」，而 package.json = 0.16.1。
 * 演练者原话："我无法判断这是笔误还是另一套命名空间"。
 * 约定：`vX.Y.Z` 只表示发布版本；内部迭代写成「v0.16 系列」/「迭代 N」。
 * ============================================================ */
describe('findFutureVersion：高于发布版本的版本号必须被点出来', () => {
  it('高于当前版本 ⇒ 命中（无论出现在标题还是表格里）', () => {
    expect(df.findFutureVersion('### DSH 侧边栏的三条操作语义（v0.16.6 起）', '0.16.1')).toBeTruthy();
    expect(df.findFutureVersion('| **服务驻留**（v0.16.2） | 说明 |', '0.16.1')).toBeTruthy();
  });

  it('等于或低于当前版本 ⇒ 放行（正常的历史引用）', () => {
    expect(df.findFutureVersion('v0.16.1 已发布', '0.16.1')).toBeNull();
    expect(df.findFutureVersion('v0.15.0 的一次性清空', '0.16.1')).toBeNull();
  });

  it('说未来版本时带「计划/拟/目标/预计」字样 ⇒ 放行（那是在描述规划）', () => {
    expect(df.findFutureVersion('计划在 v0.17.0 支持多窗口', '0.16.1')).toBeNull();
    expect(df.findFutureVersion('预计 v0.17.0 落地', '0.16.1')).toBeNull();
    expect(df.findFutureVersion('目标 v1.0.0 支持协作', '0.16.1')).toBeNull();
  });

  it('真实工程里不再有高于发布版本的编号（回归本缺陷）', () => {
    const v = require('../package.json').version;     // 本文件没有 import fs，用同一 require 读
    expect(df.scanFutureVersions(v)).toEqual([]);
  });
});

/* ------------------------------------------------------------
 * 用例数解析：**必须取总数，不能取 passed**
 *
 * 真实事故（2026-09-29）：`npm run facts:write` 正赶上 2 个测试红 ⇒ 摘要行是
 * `Tests  2 failed | 590 passed (592)`，旧实现取 `passed` ⇒ 把 **590** 写进 `docs/VERIFY.md` 当"真值"。
 * 而 G6 是"文档 vs 本脚本现算"自比自 ⇒ **这个错永远不会有门禁报红**。
 * ⇒ 这组断言就是它唯一的守护。
 * ------------------------------------------------------------ */
describe('parseVitestCount：取总数，不取 passed', () => {
  it('全绿形态', () => {
    expect(df.parseVitestCount(' Test Files  32 passed (32)\n      Tests  592 passed (592)\n')).toBe(592);
  });

  it('**有失败用例时也必须给出总数**（旧实现给出 590 = passed，写进真值就是错的）', () => {
    const out = ' Test Files  1 failed | 31 passed (32)\n      Tests  2 failed | 590 passed (592)\n';
    expect(df.parseVitestCount(out)).toBe(592);
    expect(df.parseVitestCount(out)).not.toBe(590);
  });

  it('带 ANSI 色码也能解析（vitest 在 TTY 下会着色）', () => {
    expect(df.parseVitestCount('\u001b[32m Tests  592 passed (592)\u001b[39m')).toBe(592);
  });

  it('没有摘要行 ⇒ null（"取不到真值"必须与"取到了"可区分）', () => {
    expect(df.parseVitestCount('')).toBeNull();
    expect(df.parseVitestCount('some unrelated output')).toBeNull();
  });

  it('没有括号的退化形态 ⇒ 退回 passed（不静默给 0）', () => {
    expect(df.parseVitestCount('Tests  7 passed')).toBe(7);
  });
});

/* ------------------------------------------------------------
 * 第一屏（`SKILL.md`）的验证链步骤数 ↔ `scripts/verify.js` 的 `STEPS.length`
 *
 * 真实缺陷（2026-10-10 实测）：第一屏手写"9 条步骤"，而 `STEPS` 现场已经 **11 步**
 * （10-08 九步 → 10-09 加 V1 十步 → 10-10 加 V2 十一步），**漂了两轮没人察**；
 * 它附带的"实跑 8 步"在全仓 grep 不到任何实现。`docs/VERIFY.md` 那处是生成物所以自动准 ——
 * 于是**最需要准确的同一页，恰好是唯一没有守卫的一页**。这组断言就是那条守卫的判别力证明：
 * 只注入"改成别的数字"→ 必红；**把这句话删掉也要红**（否则守卫能被受检方自己关掉 ✗）。
 * ------------------------------------------------------------ */
describe('第一屏步骤数：与 `STEPS.length` 绑死（手写页的机械守卫）', () => {
  it('认出中文自然写法「**步骤数 11 步**」', () => {
    expect(df.parseStepCountClaims('（**步骤数 11 步** —— 由 `STEPS` 现场决定）'))
      .toEqual([{ line: 1, value: 11 }]);
  });

  it('「接手 5 步」**不算**步骤数声明（那是"读几份文档"，混扫会造假红）', () => {
    expect(df.parseStepCountClaims('## 接手 5 步（**第一次进入本工程就按这个顺序走**）')).toEqual([]);
    expect(df.parseStepCountClaims('按这五步走，够你正确使用它')).toEqual([]);
  });

  it('标题行整行跳过（与 parseClaims 同口径）', () => {
    expect(df.parseStepCountClaims('#### 步骤数 9 步')).toEqual([]);
  });

  it('判定：数字不符 ⇒ 报出**行号 + 现值 + 应为**（报错即教程）', () => {
    const msg = df.stepCountProblem([{ line: 45, value: 9 }], 11);
    expect(msg).toContain('第 45 行');
    expect(msg).toContain('9');
    expect(msg).toContain('11');
    expect(df.stepCountProblem([{ line: 45, value: 11 }], 11)).toBe(null);
  });

  it('**声明缺失也判红**（不是"没写就不检查"——否则删掉那句话就把守卫关掉了）', () => {
    expect(df.stepCountProblem([], 11)).toContain('找不到步骤数声明');
  });

  it('**采不到真值（读不到文件）也判红**，不许静默放行', () => {
    expect(df.stepCountProblem(null, 11)).toContain('采不到真值');
  });

  it('真实工程：`SKILL.md` 里的步骤数 == `STEPS.length`（这就是那条判定的现场形态）', () => {
    const scan = df.scanStepCount(require('node:fs').readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8'));
    expect(scan.claims.length, 'SKILL.md 里必须有一处步骤数声明').toBeGreaterThan(0);
    expect(df.stepCountProblem(scan.claims, scan.want)).toBe(null);
    expect(scan.want).toBe(verify.STEPS.length);
  });
});
