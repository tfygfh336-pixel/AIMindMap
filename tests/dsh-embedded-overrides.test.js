/* ============================================================
 * tests/dsh-embedded-overrides.test.js —— 内置 DSH「本地覆盖」渲染器单测（vitest）
 * ------------------------------------------------------------
 * 为什么必须有这一条：台账 A3 那次"手工改 `cordis.patch.yml`"之所以成为**唯一不可复现**的
 * 数据侧改动，就是因为**没有任何东西会去核「现网值 == 我声明的值」** ✗。渲染器正是那个
 * "可重放"机制 —— 它一坏，本地覆盖就重新退化成"没人知道曾经改过什么"。
 * 所以这里锁三件事：
 *   ① 真能改对（值落到正确条目、正确位置）；
 *   ② **连跑两次 sha256 不变**（幂等）—— 否则每跑一次就写下一个 diff，把"现状"变成噪声；
 *   ③ 白名单外 / 取值不一致时**非 0 退出**（判不了或不该做，都不许静默放过）。
 *
 * ⚠️ 全部在 `os.tmpdir()` 的**假 dsh-home** 上跑：真实的 `%APPDATA%\AI MindMap` 是用户
 * **正在用**的实例，测试写坏它的 patch 文件 = 侧栏起不来 ✗。故每个用例都显式传
 * `--home <临时目录>`，脚本里没有任何一步会回落到默认 home ✓。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dsh-embedded-overrides.js');
/** 内置 DSH 运行包（动 preset 声明时要读它自带的 presets/*.patch.yml 当参照物） */
const RUNTIME = path.join(ROOT, 'vendor', 'dsh');
const require_ = (await import('node:module')).createRequire(import.meta.url);
const ov = require_(SCRIPT);

/** DSH 的 `!!js` 是自定义标签：中性化成普通标量后 js-yaml 才能验证"结构是否合法" ✓ */
const neutralizeJsTag = (text) => text.replace(/!!js /g, '');

/** 运行包自带的某个内置 preset 的 plugins 行 id 序列（当"不许手抄漂移"的参照物） */
function builtinPluginIds(cloneFrom) {
  const f = path.join(RUNTIME, 'app', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', cloneFrom + '.patch.yml');
  const doc = yaml.load(neutralizeJsTag(fs.readFileSync(f, 'utf8')));
  const row = doc.flatMap((d) => (d && d.insert) || []).find((r) => r && String(r.id || '').startsWith('preset-'));
  return row.config.plugins.map((p) => p.id);
}

let home = null;
let patch = null;

/** 假 patch 文件：条目形状照抄真实的 `profiles/web/cordis.patch.yml`（一个 YAML 数组，
 *  条目 = `- id: <id>` + `config:` + 若干键；含一个**折行**的 rulesFile 值 ✓）。 */
const fixtureLines = () => [
  '# 假 patch（照抄真实文件结构：顶层 YAML 数组 + id 定位）',
  '- id: permission-rules',
  '  config:',
  "    rulesFile: 'C:\\Users\\someone\\AppData\\Roaming\\AI",
  "      MindMap\\dsh-home\\profiles\\web\\config\\rules.yaml'",
  '    badFilePolicy: fail',
  '',
  '- id: permission',
  '  config:',
  '    presets:',
  '      read-only:',
  '        sandbox: read-only',
  '    defaultPreset: full-access-review',
  '',
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-official',
  '    model: deepseek-flash',
  '    reasoningEffort: high',
  ''
];

const writeOverrides = (obj) => fs.writeFileSync(path.join(home, '.embedded-overrides.json'), JSON.stringify(obj, null, 2), 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readPatch = () => fs.readFileSync(patch, 'utf8');

/** 跑脚本；返回 { status, out } —— **不抛异常**（非 0 退出本身是被断言的观测值 ✓） */
function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--home', home], { encoding: 'utf8' });
  if (r.error) throw new Error('spawn 本身失败（脚本没跑起来）：' + r.error.message);
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

beforeEach(() => {
  // `<tmp>/dsh-home` 的形状要与真实实例一致：patch 在 profiles/web 下
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-embedded-ov-'));
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.writeFileSync(patch, fixtureLines().join('\n'), 'utf8');
});

afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ } });

describe('render：把陈述式 overrides 渲染进 patch', () => {
  it('值落到 correct 条目，check 随后退出 0', () => {
    writeOverrides({ 'permission.defaultPreset': 'workspace-write' });
    const r = run('render');
    expect(r.status).toBe(0);
    expect(readPatch()).toContain('    defaultPreset: workspace-write');
    expect(readPatch()).not.toContain('defaultPreset: full-access-review');
    // 只改该改的那一行：别的条目原样不动
    expect(readPatch()).toContain('    reasoningEffort: high');

    const c = run('check');
    expect(c.status).toBe(0);
    expect(c.out).toContain('permission.defaultPreset = workspace-write');
  });

  it('yamlScalar：安全字符集内**不加引号**，含反斜杠的路径**必须加**（否则 YAML 里 \\ 有歧义）', () => {
    writeOverrides({ 'agent-default-model.provider': 'turing/gpt-6-astra' });
    expect(run('render').status).toBe(0);
    expect(readPatch()).toContain('    provider: turing/gpt-6-astra');        // `[A-Za-z0-9._-/]` 全部命中 ⇒ 裸写
    expect(readPatch()).not.toContain("provider: 'turing");                  // 加引号也能解析，但会让幂等比对多一层噪声

    writeOverrides({ 'permission-rules.rulesFile': 'C:\\rules.yaml' });
    expect(run('render').status).toBe(0);
    expect(readPatch()).toContain("    rulesFile: 'C:\\rules.yaml'");         // 含 `\` ⇒ 必须引
  });

  it('折行值被换成一行，**续行残留要删掉**（真实 rulesFile 就是折行写的）', () => {
    writeOverrides({ 'permission-rules.rulesFile': 'D:\\new\\rules.yaml' });
    expect(run('render').status).toBe(0);
    const t = readPatch();
    expect(t).toContain("    rulesFile: 'D:\\new\\rules.yaml'");
    expect(t).not.toContain('MindMap\\dsh-home');               // 旧的续行必须没了
    expect(t.match(/rulesFile:/g)).toHaveLength(1);             // 也不能变成两行
    expect(run('check').status).toBe(0);
  });
});

describe('幂等：连跑两次文件 sha256 不变', () => {
  it('第二次 render 不写盘、不产生新备份，且打印"无需改动"', () => {
    writeOverrides({ 'permission.defaultPreset': 'workspace-write' });
    expect(run('render').status).toBe(0);
    const first = sha(patch);
    const baksAfterFirst = fs.readdirSync(path.dirname(patch)).filter((f) => f.includes('.bak-')).length;

    const r2 = run('render');
    expect(r2.status).toBe(0);
    expect(sha(patch)).toBe(first);
    expect(r2.out).toContain('无需改动');
    expect(fs.readdirSync(path.dirname(patch)).filter((f) => f.includes('.bak-')).length).toBe(baksAfterFirst);
  });

  it('--dry-run 只报告不写盘（现网与 overrides 不一致时文件哈希不变）', () => {
    writeOverrides({ 'permission.defaultPreset': 'workspace-write' });
    const before = sha(patch);
    const r = run('render', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.out).toContain('[dry-run]');
    expect(sha(patch)).toBe(before);
    expect(fs.readdirSync(path.dirname(patch)).filter((f) => f.includes('.bak-'))).toHaveLength(0);
  });
});

describe('白名单外 / 结构不合法 ⇒ 非 0 退出（不许猜、不许静默）', () => {
  it('白名单外的条目 id', () => {
    writeOverrides({ 'ui-theme.preference': 'dark' });
    const r = run('render');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/不支持的 patch 条目 id/);
  });

  it('白名单条目里不允许改的键（presets 是 permission 的合法键，但不在支持范围）', () => {
    writeOverrides({ 'permission.presets': 'x' });
    const r = run('render');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/条目不支持改这个键/);
  });

  it('键不是 "<id>.<键路径>" 形式', () => {
    writeOverrides({ permission: 'x' });
    expect(run('render').status).not.toBe(0);
  });

  it('patch 里没有这个条目（不凭空新增 ✗）', () => {
    writeOverrides({ 'auto-review.maxReviewsPerTurn': 60 });
    const r = run('render');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/patch 里没有条目/);
  });

  it('overrides 不是合法 JSON', () => {
    fs.writeFileSync(path.join(home, '.embedded-overrides.json'), '{ 坏 ', 'utf8');
    expect(run('render').status).not.toBe(0);
  });
});

describe('check：不一致必须非 0（它是自检第 6 项的真值来源）', () => {
  it('现网 != overrides ⇒ 非 0，且报出"期望 / 实际"两侧', () => {
    writeOverrides({ 'permission.defaultPreset': 'workspace-write' });
    const r = run('check');                                   // 还没 render，文件里仍是 full-access-review
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/期望 workspace-write，实际 full-access-review/);
  });

  it('overrides 为空 ⇒ 退出 0，但明说"没有本地覆盖要核对"（不是静默绿）', () => {
    const r = run('check');
    expect(r.status).toBe(0);
    expect(r.out).toContain('没有本地覆盖要核对');
  });

  it('patch 文件缺失 ⇒ 非 0（判不了，不是通过 ✗）', () => {
    writeOverrides({ 'permission.defaultPreset': 'workspace-write' });
    fs.rmSync(patch);
    expect(run('check').status).not.toBe(0);
  });
});

/* ============================================================================
 * ② agent preset 声明（2026-10-08 新增：aimindmap 模式）
 * 需求背景见 .review/20261008-DSH深度集成调研/07-功能6-DSH模式与人设.md：
 * 「模式」= `@deepseek-ai/dsh-agent-preset` 的一条**声明**，plugins 是该模式 agent 的
 * 全部能力（人设/工具/技能/plan-mode/压缩/委派）。**清单从运行包自带的 preset 生成，
 * 不手抄进本仓库** —— 手抄一份就是又一份会随内置 DSH 升级漂移的副本（台账 R8 那类）。
 * ========================================================================= */
describe('preset 生成：清单必须与运行包自带的逐行对齐（不手抄 ⇒ 不漂移）', () => {
  it('结构：insert 一条 preset 行，id/name/config 齐备，plugins 与 standard 同序同 id', () => {
    const block = ov.buildPresetBlock('aimindmap', { cloneFrom: 'standard' });
    const doc = yaml.load(neutralizeJsTag(block.join('\n')));
    const row = doc[0].insert[0];
    expect(row.id).toBe('preset-aimindmap');
    expect(row.name).toBe('@deepseek-ai/dsh-agent-preset');
    expect(row.config.id).toBe('aimindmap');
    expect(typeof row.config.order).toBe('number');
    expect(row.config.plugins.map((p) => p.id)).toEqual(builtinPluginIds('standard'));
    expect(row.config.plugins.length).toBeGreaterThan(15);   // "能干活"的 agent 不会只有几条
  });

  it('人设进了 persona.prefix（不是空壳），且保留宿主的 {{cwd}} 占位符', () => {
    const doc = yaml.load(neutralizeJsTag(ov.buildPresetBlock('aimindmap', { cloneFrom: 'standard' }).join('\n')));
    const persona = doc[0].insert[0].config.plugins.find((p) => p.id === 'persona');
    expect(persona.name).toBe('@deepseek-ai/dsh-persona');
    expect(persona.config.prefix).toBe(ov.PRESETS.aimindmap.persona);
    expect(persona.config.prefix.length).toBeGreaterThan(80);
    expect(persona.config.suffix).toContain('{{cwd}}');
  });

  it('幂等：applyPresetBlocks 连应用两次只留一个块，且在文件末尾', () => {
    const base = fixtureLines();
    const ovd = { $presets: { aimindmap: { cloneFrom: 'standard' } } };
    const once = ov.applyPresetBlocks(base.slice(), ovd).lines;
    const twice = ov.applyPresetBlocks(once.slice(), ovd).lines;
    expect(twice.filter((l) => l.trim() === ov.BANNER_BEGIN).length).toBe(1);
    expect(twice.join('\n')).toBe(once.join('\n'));
    expect(twice[twice.length - 2].trim()).toBe(ov.BANNER_END);
  });

  it('没声明 $presets ⇒ 不留痕（不生成空块）', () => {
    const base = fixtureLines();
    expect(ov.applyPresetBlocks(base.slice(), {}).lines.join('\n')).toBe(base.join('\n'));
  });

  it('makeDefault: true ⇒ 额外覆盖注册表那一行（按 id 覆盖，config 只有 default 一个键）', () => {
    const block = ov.buildPresetBlock('aimindmap', { cloneFrom: 'standard', makeDefault: true });
    const doc = yaml.load(neutralizeJsTag(block.join('\n')));
    const registry = doc.find((d) => d && d.id === 'agent-preset-registry');
    expect(registry).toBeTruthy();
    expect(registry.config).toEqual({ default: 'aimindmap' });   // 整份 config（该行只有这一个键）
    // 声明本体也在同一个块里 ⇒ 一次 render 原子地"加模式 + 设默认" ✓
    expect(doc.some((d) => d && d.insert && d.insert[0].id === 'preset-aimindmap')).toBe(true);
  });

  it('不给 makeDefault ⇒ **不碰**注册表（别顺手改别人的默认模式）', () => {
    const doc = yaml.load(neutralizeJsTag(ov.buildPresetBlock('aimindmap', { cloneFrom: 'standard' }).join('\n')));
    expect(doc.some((d) => d && d.id === 'agent-preset-registry')).toBe(false);
  });

  it('makeDefault 必须是布尔（白名单纪律：不许猜、不许"真值字符串")', () => {
    expect(() => ov.validate({ $presets: { aimindmap: { cloneFrom: 'standard', makeDefault: 'true' } } })).toThrow();
    expect(() => ov.validate({ $presets: { aimindmap: { cloneFrom: 'standard', makeDefault: true } } })).not.toThrow();
  });
});

describe('preset 生成：CLI 端到端（临时 home）', () => {
  it('render → 幂等 → check 全绿；生成物是合法 YAML、且备份已产生', () => {
    writeOverrides({ $presets: { aimindmap: { cloneFrom: 'standard' } } });
    const r1 = run('render', '--runtime', RUNTIME);
    expect(r1.status).toBe(0);
    expect(r1.out).toContain('$presets: aimindmap');
    const text = readPatch();
    expect(() => yaml.load(neutralizeJsTag(text))).not.toThrow();
    expect(fs.readdirSync(path.dirname(patch)).some((f) => f.includes('.bak-'))).toBe(true);

    const r2 = run('render', '--runtime', RUNTIME);
    expect(r2.status).toBe(0);
    expect(r2.out).toContain('无需改动');
    expect(sha(patch)).toBe(crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex'));
    expect(readPatch()).toBe(text);

    const c = run('check', '--runtime', RUNTIME);
    expect(c.status).toBe(0);
    expect(c.out).toContain('✓ $presets.aimindmap');
  });

  it('check 抓得到"生成块被手改"（不是只看文件在不在）', () => {
    writeOverrides({ $presets: { aimindmap: { cloneFrom: 'standard' } } });
    expect(run('render', '--runtime', RUNTIME).status).toBe(0);
    fs.writeFileSync(patch, readPatch().replace('aimindmap 模式', '被手改了'), 'utf8');
    const c = run('check', '--runtime', RUNTIME);
    expect(c.status).not.toBe(0);
    expect(c.out).toContain('✗ $presets.aimindmap');
  });

  it('运行包路径给错 ⇒ 响亮失败（不静默生成一个空清单的模式）', () => {
    writeOverrides({ $presets: { aimindmap: { cloneFrom: 'standard' } } });
    const r = run('render', '--runtime', path.join(os.tmpdir(), 'no-such-runtime'));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('运行包里没有内置 preset');
  });

  it('$presets 里不认识的 id / 缺 cloneFrom ⇒ 非 0（白名单之外不许猜）', () => {
    writeOverrides({ $presets: { whatever: { cloneFrom: 'standard' } } });
    expect(run('render', '--runtime', RUNTIME).status).not.toBe(0);
    writeOverrides({ $presets: { aimindmap: {} } });
    expect(run('render', '--runtime', RUNTIME).status).not.toBe(0);
  });
});

describe('require 守卫：脚本可被单测加载而不执行 CLI', () => {
  it('require() 只导出函数，不打印用法、不退出', () => {
    expect(typeof ov.buildPresetBlock).toBe('function');
    expect(typeof ov.applyPresetBlocks).toBe('function');
    expect(Object.keys(ov.PRESETS)).toContain('aimindmap');
    expect(ov.BANNER_BEGIN).toContain('生成物');
  });
});
