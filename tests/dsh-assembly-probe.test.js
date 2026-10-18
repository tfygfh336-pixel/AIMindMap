/* ============================================================
 * tests/dsh-assembly-probe.test.js — 装配探针的**判定力**
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个探针回答的是「**这个 id 能不能被 profile patch 打到？**」—— 而这件事**看装配文件看不出来**，
 * 只有运行时的**合成结果**能回答。它的判定错一点，结论就反过来 —— 而它**是一份给 AI 读装配面的探针**，
 * 每次调用都会给出结论 ⇒ 判错不是"少一个读数"，是**主动制造错误结论**。
 *
 * 本文件锁住四件事（每条都对应一次实测踩出来的错）：
 *   ① **`disabled` 三态**：`literal-true` / `literal-false` / `expr`（+ `absent`）。
 *      `expr` 必须**逐字保留原文**、**不许猜真假**。旧实现只认字面 `true`
 *      ⇒ 现跑合成树里 **18 行** `disabled: !!js …` 全被读成"启用"（`ui-sidebar-browser` 是代表：
 *      web profile 下它其实是**关**的）。
 *   ② **缩进层级**：`preset-*.config.plugins[]` 的内联行**不是顶层行** ⇒ 不在补丁命中面上。
 *      旧实现不看缩进 ⇒ `persona` 这类被算成顶层，`presetOnlyIds` 打印「（无）」。
 *   ③ **判定只写一处**：行规则（缩进 + 三态）只在 `probe.parseRows` 里；
 *      `scripts/dsh-fixture-freshness.js` 的 `readRows` 是它的薄适配器（本文件断言两者逐行一致）。
 *   ④ **缺证据时不许说「没有」**：读不到 preset 文件 ⇒ `classifyPresetOnly` 返回
 *      `status:'no-preset-files'`，**不是**一个空的"没有独有 id"。
 *
 * **真实基线 dump 回归**：`tests/fixtures/dsh-composed-tree-web.txt` 是**冻结样本**
 * （由 `scripts/dsh-fixture-freshness.js --write` 生成、并被它钉住与运行包一致）。
 * 上游改了装配 ⇒ 这里的数字先红 ⇒ 逼人重生成夹具并**重新确认**这些结论，而不是让探针悄悄换个答案。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const probe = require('../scripts/dsh-assembly-probe.js');
const freshness = require('../scripts/dsh-fixture-freshness.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// **证据随测试走**：基线 dump 放在 `tests/fixtures/`，**不是** `.review/` ——
// 后者是工作产物区、**不参与 C:/D: 同步**，放那儿会让这几条断言在另一个盘上**静默 skip**（实测踩到：
// D 盘上 10 条里 skip 了 4 条而套件仍报"通过"）。工程明令禁止"跳过伪装成一致"。
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'dsh-composed-tree-web.txt');

/** 扁平样本：三态齐全（字面 true / 字面 false / 表达式 / 没写） */
const SAMPLE = [
  '# == @deepseek-ai/dsh-base',
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  disabled: true',
  '- id: token-meter',
  "  name: '@deepseek-ai/dsh-token-meter'",
  '  config:',
  '    ratio: 1',
  '- id: hmr',
  "  name: '@deepseek-ai/cordis-plugin-hmr'",
  "  disabled: false",
  '- id: ui-sidebar-browser',
  "  name: '@deepseek-ai/dsh-client-ui-sidebar-browser'",
  "  disabled: !!js ctx.get('profileContext')?.name !== 'desktop'"
].join('\n');

/** 嵌套样本：preset 声明行（非 group，`config.plugins[]`）+ 顶层 group（`config` 是列表） */
const NESTED = [
  '# == @deepseek-ai/dsh-base',
  '- id: preset-standard',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: standard',
  '    plugins:',
  '      - id: persona',
  "        name: '@deepseek-ai/dsh-persona'",
  '      - id: tool-bash',
  "        name: '@deepseek-ai/dsh-tool-bash'",
  "        disabled: !!js process.platform === 'win32'",
  '- id: tool-goal',
  "  name: '@deepseek-ai/dsh-tool-goal'",
  '  disabled: true',
  '- id: planning',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: plan-mode',
  "      name: '@deepseek-ai/dsh-plan-mode'"
].join('\n');

/** 夹具正文（去掉出处头） */
function fixtureBody() {
  return freshness.splitFixture(fs.readFileSync(BASELINE, 'utf8')).body;
}
const composedFixture = () => probe.parseComposed(fixtureBody());
const rowsById = (c, id) => c.rows.filter((r) => r.id === id);

describe('parseRows：行规则（缩进 + disabled 三态）', () => {
  it('取出 id / name，且 **disabled 分三态**（字面 true / 字面 false / 表达式 / 没写）', () => {
    const rows = probe.parseRows(SAMPLE);
    const byId = (id) => rows.filter((r) => r.id === id)[0];
    expect(rows.map((r) => r.id)).toEqual(['timer', 'compaction-basic', 'token-meter', 'hmr', 'ui-sidebar-browser']);
    expect(byId('timer').disabledState, '没写 disabled ⇒ absent（不是"启用"这个判定）').toBe('absent');
    expect(byId('compaction-basic').disabledState).toBe('literal-true');
    expect(byId('hmr').disabledState, '显式 false 是**字面量**，与表达式不是一回事').toBe('literal-false');
    expect(byId('ui-sidebar-browser').disabledState, '`!!js …` 是**表达式**，运行期才决定').toBe('expr');
    expect(byId('ui-sidebar-browser').disabledRaw, '表达式原文必须逐字保留（含引号）')
      .toBe("!!js ctx.get('profileContext')?.name !== 'desktop'");
  });

  it('**表达式不许被猜成 true/false** —— 判别力：任何"给个明确答案"的写法都会红在这里', () => {
    const rows = probe.parseRows(SAMPLE);
    const expr = rows.filter((r) => r.disabledState === 'expr');
    expect(expr.length).toBe(1);
    expect(expr[0].id).toBe('ui-sidebar-browser');
    // 三态里**没有**布尔语义：谁想 `if (row.disabled)` 都会拿到 undefined
    expect(expr[0].disabled, '不得再暴露布尔 `disabled` 字段（那正是旧实现把表达式读成"启用"的地方）').toBeUndefined();
    expect(['literal-true', 'literal-false', 'expr', 'absent']).toContain(rows[4].disabledState);
  });

  it('`disabled` 值只认**该行自己那一级**（缩进+2）：嵌套行的 disabled 不串到父行', () => {
    const rows = probe.parseRows(NESTED);
    const preset = rows.filter((r) => r.id === 'preset-standard')[0];
    expect(preset.disabledState, 'preset-standard 自己没写 disabled；子行的表达式不能算到它头上').toBe('absent');
    const toolBash = rows.filter((r) => r.id === 'tool-bash')[0];
    expect(toolBash.disabledState).toBe('expr');
    expect(toolBash.disabledRaw).toBe("!!js process.platform === 'win32'");
  });

  it('空输入安全（不抛异常）', () => {
    expect(probe.parseRows('')).toEqual([]);
    expect(probe.parseRows(null)).toEqual([]);
  });
});

describe('parseComposed：命中面 / 层级 / preset 内联归类', () => {
  it('层标签（`# ==` 行）—— 用来分辨某行被哪一层最后写过', () => {
    expect(probe.parseComposed(SAMPLE).layerLabels).toEqual(['@deepseek-ai/dsh-base']);
  });

  it('**缩进层级**：顶层 / 嵌套分开数（判别力：不看缩进 ⇒ 这条红）', () => {
    const c = probe.parseComposed(NESTED);
    expect(c.counts.rows).toBe(6);
    expect(c.topLevel.map((r) => r.id)).toEqual(['preset-standard', 'tool-goal', 'planning']);
    expect(c.nested.map((r) => r.id)).toEqual(['persona', 'tool-bash', 'plan-mode']);
    const persona = c.nested.filter((r) => r.id === 'persona')[0];
    expect(persona.depth).toBe(1);
    expect(persona.indent).toBe(6);
    expect(persona.ancestors).toEqual(['preset-standard']);
  });

  it('**命中面 = 顶层行 + 顶层可达 group 的 config 列表**；preset 的 `config.plugins[]` 不在面上', () => {
    const c = probe.parseComposed(NESTED);
    expect(c.indexOrder.map((r) => r.id), 'group（planning）里的子行**可以**被补丁命中；preset 内联行不行')
      .toEqual(['preset-standard', 'tool-goal', 'planning', 'plan-mode']);
    expect(c.unreachable.map((r) => r.id)).toEqual(['persona', 'tool-bash']);
    expect(c.presetInline.map((r) => r.id)).toEqual(['persona', 'tool-bash']);
    expect(c.presetGroups.length).toBe(1);
    expect(c.presetGroups[0].preset).toBe('preset-standard');
    expect(c.presetGroups[0].ids).toEqual(['persona', 'tool-bash']);
  });

  it('`group: true` 且 `config` **是列表**才算可递归（`isConfigSequence`）；非 group 行即使 config 是列表也不递归', () => {
    const group = probe.parseRows(NESTED).filter((r) => r.id === 'planning')[0];
    expect(probe.isConfigSequence(group)).toBe(true);
    const preset = probe.parseRows(NESTED).filter((r) => r.id === 'preset-standard')[0];
    expect(probe.isConfigSequence(preset), '`config.plugins[]` 是 mapping 里的列表 ⇒ 不是 group 的 config 序列').toBe(false);
    const holder = probe.parseComposed([
      '- id: holder', '  name: x', '  config:', '    - id: child', '      name: y'
    ].join('\n'));
    expect(holder.indexOrder.map((r) => r.id), '形状像 group 但没 `group: true` ⇒ 子行仍在面外').toEqual(['holder']);
  });

  it('三态计数（`absent` 也数，免得"没写"被当成"启用"混进去）', () => {
    const c = probe.parseComposed(NESTED);
    expect(c.counts.disabled).toEqual({ 'literal-true': 1, 'literal-false': 0, expr: 1, absent: 4 });
  });
});

describe('classifyPresetOnly：缺证据时不许说「没有」', () => {
  const PRESET_STD = [
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '          - id: ghost',
    "            name: '@deepseek-ai/dsh-never-mounts'"
  ].join('\n');

  it('**一个 preset 文件都没读到 ⇒ status=no-preset-files**（旧实现静默打成「（无）」）', () => {
    const r = probe.classifyPresetOnly([], probe.parseComposed(NESTED));
    expect(r.status).toBe('no-preset-files');
    expect(r.unreachable, '缺证据时的空数组**不能**被读成"没有独有 id"').toEqual([]);
  });

  it('preset 文件顶层 id（`preset-standard`）在命中面上 ⇒ patchable；**嵌套声明的**（`persona`）⇒ unreachable', () => {
    const c = probe.parseComposed(NESTED);
    const r = probe.classifyPresetOnly([{ file: 'std.patch.yml', rel: 'std.patch.yml', text: PRESET_STD }], c);
    expect(r.status).toBe('ok');
    expect(r.files).toEqual(['std.patch.yml']);
    expect(r.topLevelIds, '`- insert:` 不是 id 行 ⇒ 它下面的 preset-standard 仍是**顶层**').toEqual(['preset-standard']);
    expect(r.nestedIds).toEqual(['ghost', 'persona']);
    expect(r.patchable).toEqual(['preset-standard']);
    expect(r.unreachable).toEqual(['ghost', 'persona']);
    expect(r.notInTreeAtAll, '合成树里连嵌套都没有的才算"完全没有"').toEqual(['ghost']);
  });
});

describe('layerPackages：请求的 bundle ≠ 真挂上的层', () => {
  it('从层标签取包名，并剥掉 `, patched by …`', () => {
    expect(probe.layerPackages([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-web-app'
    ])).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
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
    expect(d.removed).toEqual(['x']);
    expect(d.added).toEqual([]);
  });

  it('空 diff 表示补丁没改任何一行', () => {
    const d = probe.diffLines('a\nb', 'a\nb');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe('真实基线 dump 的回归断言（上游若改了装配，这里先红）', () => {
  it('**基线证据必须存在且自述出处** —— 缺它就红，绝不静默 skip（否则真回归会被"通过"掩盖）', () => {
    expect(fs.existsSync(BASELINE), '缺 ' + BASELINE + '：这几条回归断言没有真值就不能假装通过').toBe(true);
    const raw = fs.readFileSync(BASELINE, 'utf8');
    const { header, body } = freshness.splitFixture(raw);
    expect(header, '出处头必须声明这是**冻结样本**、不是当前装配面').toMatch(/冻结样本/);
    expect(header, '出处头必须写明重新生成命令（唯一合法写者）')
      .toMatch(/dsh-fixture-freshness\.js --write/);
    expect(header, '出处头必须写明它是哪一版运行包的样本').toMatch(/- id: |@deepseek-ai\/dsh \d/);
    expect(freshness.BODY_START_RE.test(body.split('\n')[0]), '正文第一行应是 `# ==` 层标签').toBe(true);
  });

  it('**`!!js` 行是 `expr`（18 行）、字面 true 是 41 行、带 disabled 的共 59 行** —— 三个数对不上就是有人把表达式读成了布尔', () => {
    const c = composedFixture();
    const withDisabled = c.rows.filter((r) => r.disabledState !== 'absent');
    expect(withDisabled.length).toBe(59);
    expect(c.counts.disabled['literal-true']).toBe(41);
    expect(c.counts.disabled.expr, '现跑合成树里 `disabled: !!js …` 的**行数**（旧实现把这 18 行读成"启用"）').toBe(18);
    // 结构不变量：所有"非 absent"的行都必须落在三态里，且 expr = 总数 − 字面 true（本树没有字面 false）
    expect(c.counts.disabled['literal-false']).toBe(0);
    expect(c.counts.disabled.expr + c.counts.disabled['literal-true']).toBe(withDisabled.length);
    // 每一行 expr 都必须保留原文（"去猜"的第一步就是丢掉原文）
    for (const r of withDisabled.filter((x) => x.disabledState === 'expr')) {
      expect(r.disabledRaw, r.id + ' 的表达式原文不能为空').toMatch(/^!!js\s+\S/);
    }
  });

  it('**`ui-sidebar-browser` 是顶层行、`disabled` 是表达式**（旧探针说它是"启用行"，而 web profile 下它其实是关的）', () => {
    const c = composedFixture();
    const hit = rowsById(c, 'ui-sidebar-browser');
    expect(hit.length, '顶层应恰好一行').toBe(1);
    expect(hit[0].depth).toBe(0);
    expect(hit[0].disabledState, '它是**表达式**（`!== \'desktop\'`），不是字面量').toBe('expr');
    expect(hit[0].disabledRaw).toMatch(/!!js.*profileContext/);
    expect(c.indexedIds.has('ui-sidebar-browser'), '它在命中面上（补丁打得到这一行）').toBe(true);
  });

  it('**`compaction-basic` 顶层那行是 `literal-true` 死行**，另外 3 行同名在 preset 里（打不到）', () => {
    const c = composedFixture();
    const all = rowsById(c, 'compaction-basic');
    expect(all.length, '同名多行正是"补丁命中错的那一行"的前提').toBe(4);
    const top = all.filter((r) => r.depth === 0);
    expect(top.length, '顶层应恰好一行').toBe(1);
    expect(top[0].disabledState).toBe('literal-true');
    expect(top[0].name).toBe('@deepseek-ai/dsh-compaction-basic');
    expect(all.filter((r) => r.depth > 0).length).toBe(3);
    expect(all.filter((r) => r.depth > 0).every((r) => r.disabledState === 'absent'), 'preset 里那 3 行自己没写 disabled')
      .toBe(true);
    // 补丁命中的是**最后索引者**；嵌套行不在索引面上 ⇒ 命中的是顶层那行
    const target = c.indexOrder.filter((r) => r.id === 'compaction-basic').pop();
    expect(target.line).toBe(top[0].line);
  });

  it('**`persona` 只在嵌套层**（preset 的 `plugins:` 里）⇒ 顶层没有、不在命中面上', () => {
    const c = composedFixture();
    const all = rowsById(c, 'persona');
    expect(all.length, '夹具里应能找到 persona（每个 preset 一份）').toBe(4);
    expect(all.filter((r) => r.depth === 0).length, 'persona **不得**是顶层行').toBe(0);
    expect(all.every((r) => r.depth > 0 && r.indent > 0)).toBe(true);
    expect(c.presetInline.filter((r) => r.id === 'persona').length).toBe(4);
    expect(c.indexedIds.has('persona'), '不在命中面上 ⇒ 按 id 打补丁改不到它').toBe(false);
  });

  it('**层级结构：287 行 = 顶层 182 + 嵌套 105**，且这 105 行全是 preset 内联行', () => {
    const c = composedFixture();
    expect(c.counts.rows).toBe(287);
    expect(c.counts.topLevel).toBe(182);
    expect(c.counts.nested).toBe(105);
    expect(c.counts.topLevel + c.counts.nested).toBe(c.counts.rows);
    expect(c.presetInline.length).toBe(105);
    expect(c.unreachable.length).toBe(105);
    expect(c.indexOrder.length).toBe(182);
    expect(c.presetGroups.map((g) => g.preset).sort()).toEqual(['preset-cordis', 'preset-minimal', 'preset-ptc', 'preset-standard']);
    expect(c.presetGroups.reduce((n, g) => n + g.rows.length, 0)).toBe(105);
  });

  it('**判定只写一处**：`freshness.readRows` 与 `probe.parseRows` 逐行一致（id / 缩进 / disabled 原文）', () => {
    const body = fixtureBody();
    const a = probe.parseRows(body).map((r) => [r.id, r.indent, r.disabledRaw]);
    const b = freshness.readRows(body).map((r) => [r.id, r.indent, r.disabled]);
    expect(a).toEqual(b);
  });

  it('层标签能区分"base 层"与"被 web-app 补过的 base 层"', () => {
    const c = composedFixture();
    expect(c.layerLabels.some((l) => /patched by @deepseek-ai\/dsh-web-app/.test(l))).toBe(true);
    expect(probe.layerPackages(c.layerLabels).sort()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  });
});
