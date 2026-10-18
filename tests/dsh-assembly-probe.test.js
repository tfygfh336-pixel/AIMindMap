/* ============================================================
 * tests/dsh-assembly-probe.test.js — 装配探针的纯逻辑
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个探针回答的是「**这个 id 能不能被 profile patch 打到？**」—— 而这件事**看装配文件看不出来**，
 * 只有运行时的**合成结果**能回答。它的解析错一点，结论就反过来。
 *
 * 本文件锁住三件事：
 *   ① 行解析（`- id:` + 其后 `name:` / `disabled:`）—— 与 `src/dsh-capabilities.js` 同一套规则；
 *   ② 逐行 diff（"补丁到底改了什么"的唯一硬证据）；
 *   ③ **用真实保存的基线 dump 回归**（那份 dump 是**冻结样本**、由
 *      `scripts/dsh-fixture-freshness.js --write` 生成，见它自己的出处头）：
 *      · `compaction-basic` 必须是顶层 `disabled: true`（死行）；
 *      · `persona` **不得是顶层行**（它只在 preset 的 `plugins:` 里 ⇒ 补丁打不到）；
 *      · 本卡点名的 `ui-sidebar-terminal` / `ui-sidebar-browser` 必须在（旧夹具里两条都**没有**）。
 *      这些一旦被上游改掉，测试先红 —— 而不是让探针给出反向结论。
 * ⚠️ **探针自身的两个已知读数缺陷**（本文件不修，另立卡；断言已绕开它们）：
 *      · `DISABLED_RE` 只认字面 `disabled: true` ⇒ `disabled: !!js …` 的行被读成 enabled
 *        （示例：`ui-sidebar-browser` 在 web profile 下其实是**关掉**的）；
 *      · `parseComposed` 不看缩进 ⇒ preset 的内联行（如 `persona`）被当成顶层行。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const probe = require('../scripts/dsh-assembly-probe.js');
// **缩进口径的解析器只有一个**（本文件不另抄一份）：`readRows` 只看「id 行自己那一级（缩进+2）」的
// `disabled:` —— 合成树里 `preset-*.config.plugins[]` 的嵌套行也有 `disabled:`，按"任意一条"读会张冠李戴。
const freshness = require('../scripts/dsh-fixture-freshness.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// **证据随测试走**：基线 dump 放在 `tests/fixtures/`，**不是** `.review/` ——
// 后者是工作产物区、**不参与 C:/D: 同步**，放那儿会让这几条断言在另一个盘上**静默 skip**（实测踩到：
// D 盘上 10 条里 skip 了 4 条而套件仍报"通过"）。工程明令禁止"跳过伪装成一致"。
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'dsh-composed-tree-web.txt');

const SAMPLE = [
  '# == @deepseek-ai/dsh-base',
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  disabled: true',
  '# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
  '- id: token-meter',
  "  name: '@deepseek-ai/dsh-token-meter'",
  '  config:',
  '    ratio: 1'
].join('\n');

describe('parseComposed：解析合成树', () => {
  it('取出 id / name / disabled，并统计 disabled 数', () => {
    const c = probe.parseComposed(SAMPLE);
    expect(c.rows.map((r) => r.id)).toEqual(['timer', 'compaction-basic', 'token-meter']);
    expect(c.rows[0].disabled).toBe(false);
    expect(c.rows[1].disabled).toBe(true);
    expect(c.disabledCount).toBe(1);
  });

  it('收集层标签（`# ==` 行），用于分辨某行被哪一层最后写过', () => {
    expect(probe.parseComposed(SAMPLE).layerLabels).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app'
    ]);
  });

  it('空输入安全（不抛异常）', () => {
    expect(probe.parseComposed('').rows).toEqual([]);
    expect(probe.parseComposed(null).rows).toEqual([]);
  });
});

describe('diffLines：补丁生效范围的证据', () => {
  it('只报真正新增/消失的行（同内容多行用计数处理）', () => {
    const d = probe.diffLines('a\nb\nc', 'a\nb\nc\nd\ne');
    expect(d.added.sort()).toEqual(['d', 'e']);
    expect(d.removed).toEqual([]);
  });

  it('同值行重复出现时不误报（计数而非集合）', () => {
    const d = probe.diffLines('x\nx\ny', 'x\ny');
    expect(d.removed).toEqual(['x']);   // 只少了一行 x
    expect(d.added).toEqual([]);
  });

  it('空 diff 表示补丁没改任何一行', () => {
    const d = probe.diffLines('a\nb', 'a\nb');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe('真实基线 dump 的回归断言（上游若改了装配，这里先红）', () => {
  /* ⚠️ 2026-10-18（陈旧夹具批）重写这组断言的原因 —— **夹具本身落后了两代**：
   * 它一直是**冻结样本**，却自称"内置实例 web 装配面"。实测（`scripts/dsh-fixture-freshness.js`）：
   * 旧夹具 152 行 vs 运行包现跑合成树 287 行，**缺 49 个 id**（含 `ui-sidebar-terminal` /
   * `ui-sidebar-browser` 这两个"侧栏入口"），**还有 3 个反向残留**（`agent-presets` /
   * `code-runtime` / `workflow-worker-thread` 运行包里已经没有了）。
   * ⇒ "照夹具数入口"必错。现在夹具由 `dsh-fixture-freshness.js --write` 现生成、与运行包门禁钉住，
   *   并且**自带出处头**说明它是什么、不是什么。
   * ⚠️ 另有一处**已知**缺陷（不在本文件修，另立卡）：`probe.parseComposed` 不分缩进，
   *   于是把 `preset-*.config.plugins[]` 里的嵌套行（如 `persona`）也算成顶层行。
   *   所以下面凡涉及"顶层/嵌套"的断言，一律走 `freshness.readRows`（缩进口径）。 */
  it('**基线证据必须存在且自述出处** —— 缺它就红，绝不静默 skip（否则真回归会被"通过"掩盖）', () => {
    expect(fs.existsSync(BASELINE), '缺 ' + BASELINE + '：这几条回归断言没有真值就不能假装通过').toBe(true);
    const raw = fs.readFileSync(BASELINE, 'utf8');
    const { header, body } = freshness.splitFixture(raw);
    // 出处头：任一条缺失都意味着"有人手改过夹具"或"生成器被改坏了"
    expect(header, '出处头必须声明这是**冻结样本**、不是当前装配面').toMatch(/冻结样本/);
    expect(header, '出处头必须写明重新生成命令（唯一合法写者）')
      .toMatch(/dsh-fixture-freshness\.js --write/);
    expect(header, '出处头必须写明它是哪一版运行包的样本').toMatch(/- id: |@deepseek-ai\/dsh \d/);
    // 正文确实从层标签开始 —— 否则 parseComposed 会把出处头当配置读
    expect(freshness.BODY_START_RE.test(body.split('\n')[0]), '正文第一行应是 `# ==` 层标签').toBe(true);
  });

  it('**compaction-basic 是顶层 `disabled: true` 死行** —— P3-2 那条陷阱的前提', () => {
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    const row = c.rows.find((r) => r.id === 'compaction-basic');
    expect(row, 'compaction-basic 应出现在合成树里').toBeTruthy();
    expect(row.disabled, '它必须是 disabled —— 否则"补丁打在死行上"这个结论就不成立了').toBe(true);
    expect(row.name).toBe('@deepseek-ai/dsh-compaction-basic');
    // 缩进口径再确认一次：它必须是**顶层**行（嵌套的那些在 preset 里，属另一类死行）
    const top = freshness.readRows(freshness.splitFixture(fs.readFileSync(BASELINE, 'utf8')).body)
      .filter((r) => r.id === 'compaction-basic' && r.indent === 0);
    expect(top.length, '顶层应恰好有一行 compaction-basic').toBe(1);
    expect(top[0].disabled).toBe('true');
  });

  it('**persona 只在嵌套层**（preset 的 `plugins:` 里），顶层没有 —— 补丁打不到它', () => {
    const rows = freshness.readRows(freshness.splitFixture(fs.readFileSync(BASELINE, 'utf8')).body);
    // 旧的断言是"persona 完全不在合成树里"。上游现在把 preset 内联展开了 ⇒ 它**在**，
    // 但**不是 host 行**：它只作为 `preset-*.config.plugins[]` 的嵌套项出现（缩进 > 0）。
    // 这一条与"补丁打不到"等价 —— profile patch 只按顶层 id 命中，嵌套行不在命中面上。
    expect(rows.some((r) => r.id === 'persona'), '夹具里应当能找到 persona（作为 preset 内联项）').toBe(true);
    const topLevel = rows.filter((r) => r.id === 'persona' && r.indent === 0);
    expect(topLevel.length, 'persona **不得**是顶层行 —— 它属于 preset 的 isolate realm').toBe(0);
    expect(rows.filter((r) => r.id === 'persona').every((r) => r.indent > 0)).toBe(true);
  });

  it('**本卡点名的四条侧栏行都在**，且 `!!js` 形式的 disabled 被如实记下（含 disabled 计数口径）', () => {
    const rows = freshness.readRows(freshness.splitFixture(fs.readFileSync(BASELINE, 'utf8')).body);
    const at = (id) => rows.filter((r) => r.id === id && r.indent === 0);
    // 旧夹具**一条都没有** terminal / browser ⇒ 照它数侧栏入口必错（这就是本卡存在的理由）
    expect(at('ui-sidebar-terminal').length, 'ui-sidebar-terminal 必须在顶层（旧夹具里 grep 0 命中）').toBe(1);
    expect(at('ui-sidebar-terminal')[0].disabled, 'terminal 是启用行（无 disabled）').toBe(null);
    expect(at('ui-sidebar-browser').length, 'ui-sidebar-browser 必须在顶层（旧夹具里 grep 0 命中）').toBe(1);
    expect(at('ui-sidebar-browser')[0].disabled, 'browser 的 disabled 是 **JS 表达式**，不是字面 true')
      .toMatch(/!!js.*profileContext/);
    expect(at('ui-sidebar-files').length, 'ui-sidebar-files 在顶层').toBe(1);
    expect(at('ui-sidebar-documentpreview').length, 'ui-sidebar-documentpreview 在顶层').toBe(1);

    // disabled 计数：生产解析器只认**字面 true**，所以"带 disabled 的行"必须由缩进口径数 ——
    // 两者不相等是**正常的**，相等反而说明 `!!js` 那些行被漏读了。
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    expect(c.disabledCount, '字面 disabled 的行数要够多（实测 41 行）').toBeGreaterThan(10);
    const anyDisabled = rows.filter((r) => r.disabled !== null);
    expect(anyDisabled.length, '带 disabled（含 !!js）的行数应多于字面 true 的').toBeGreaterThan(c.disabledCount);
    expect(anyDisabled.filter((r) => !/^true$/.test(r.disabled)).length,
      '`!!js` 形式的 disabled 必须有代表（否则读不出"表达式关掉的行"这一整类）').toBeGreaterThan(0);
  });

  it('层标签能区分"base 层"与"被 web-app 补过的 base 层"', () => {
    const c = probe.parseComposed(fs.readFileSync(BASELINE, 'utf8'));
    expect(c.layerLabels.some((l) => /patched by @deepseek-ai\/dsh-web-app/.test(l))).toBe(true);
  });
});
