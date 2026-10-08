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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dsh-embedded-overrides.js');

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
