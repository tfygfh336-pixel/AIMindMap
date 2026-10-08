/* ============================================================
 * tests/dsh-embedded-check.test.js —— 内置 DSH 升级后自检（只读）单测
 * ------------------------------------------------------------
 * 为什么要锁它：这 10 项是本工程唯一能机械回答"内置实例现在是什么样"的东西
 * （内置实例的状态**不在 git 里**），而它的失效方式**全是静默的** —— 掉一个字段，
 * 整项就退化成 UNKNOWN，但输出看上去仍像"跑完了" ✗。真实踩过三次，都锁在这里：
 *   ① 第 3/4 项按 `receipt.bundles` / `receipt.files` 取真值，而**回执根本没有这些字段**
 *      ⇒ 两项恒 UNKNOWN。真值在回执指向的 `packageDir\manifest.json` 的 `files{}` ✓；
 *   ② 第 4 项若改读 `manifest.units[].files[].size` —— 那是**源机**尺寸（28 个 `.bin` 垫片
 *      在 staging 阶段被改写过，实测差 868 字节）⇒ 会红得莫名其妙 ✗；
 *   ③ 第 10 项取 `d.target || d.rel`，真回执的字段是 **`path`** ⇒ 恒取到 undefined ⇒
 *      **恒 PASS 的空转绿** ✗；再叠上"按子串匹配"，191 个名字里带 `task-board`/`sessions`
 *      的正常插件文件都会被判成污染 ✗。
 * 口径本身也要有守卫：`--json` 必须输出**合法 JSON 数组**（子进程输出不许混进 stdout ✗）、
 * `UNKNOWN` 不许被当成通过 ✗、有 FAIL 时退出码必须非 0 ✓。
 *
 * ⚠️ 全程 `--home <临时目录>`：真实 `%APPDATA%\AI MindMap` 是用户**正在用**的实例，
 * 本文件不读也不写它（连 mtime 都不比对）✓。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(ROOT, 'scripts', 'dsh-embedded-check.js');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 跑自检并解析 `--json`；**解析失败就是失败**（stdout 混进子进程输出正是要抓的那个 bug） */
function runCheck(home) {
  const r = spawnSync(process.execPath, [CHECK, '--home', home, '--json'], { encoding: 'utf8', timeout: 60000 });
  if (r.error) throw new Error('spawn 本身失败（脚本没跑起来）：' + r.error.message);
  let items;
  try {
    items = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error('--json 的输出不是合法 JSON（stdout 被别的东西污染了）：' + e.message
      + '\n--- stdout 前 200 字符 ---\n' + String(r.stdout || '').slice(0, 200));
  }
  return { status: r.status, items, by: new Map(items.map((i) => [i.no, i])), stderr: r.stderr || '' };
}

const len = (s) => Buffer.byteLength(s);

/**
 * 造一个"升级后应当全绿"的假实例：`<tmp>/dsh-home` + `<tmp>/dsh-migrate`（回执 + 投递包）。
 * 结构与字段名**逐字照真实的** `receipt-migrate-45242730bc15.json` 与它指向的 `manifest.json`
 * —— 那些字段名正是本文件要锁的东西。
 */
function buildInstance(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-embedded-check-'));
  const home = path.join(root, 'dsh-home');
  const profile = path.join(home, 'profiles', 'web');
  const opId = 'migrate-test00000000';
  const pkgDir = path.join(root, 'dsh-migrate', 'packages', opId);
  fs.mkdirSync(path.join(profile, 'node_modules', 'pkg-a'), { recursive: true });
  fs.mkdirSync(path.join(home, '.agent-presets', 'test-preset'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'payload', 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-presets', 'test-preset', 'preset.yml'), 'name: test-preset\n');

  // 载荷：写进 dsh-home 的这一份；投递包清单按它的**原始**字节数记账（本自检核的就是"两者还一样吗"）
  const payload = {
    'profiles/web/node_modules/pkg-a/index.js': 'module.exports = 1;\n',
    'profiles/web/node_modules/pkg-a/package.json': '{ "name": "pkg-a", "version": "1.0.0" }\n'
  };
  for (const [rel, text] of Object.entries(payload)) fs.writeFileSync(path.join(home, rel), text, 'utf8');
  if (opts.dirtiesPayload) fs.appendFileSync(path.join(home, 'profiles/web/node_modules/pkg-a/index.js'), '// 后来被改过\n');

  // bundles：投递包副本（源侧声明）与现网（合并结果）各一份
  const bundles = ['@deepseek-ai/dsh-base', 'dsh-plugin'];
  fs.writeFileSync(path.join(profile, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: bundles.concat(opts.extraBundles || []) } } }, null, 2), 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'payload', 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles } } }, null, 2), 'utf8');

  const files = {};
  for (const [rel, text] of Object.entries(payload)) files['payload/' + rel] = { size: len(text), sha256: sha256(text) };
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, opId, createdAt: '2026-09-30T08:21:43.371Z', stage: 'S2-payload-layer',
    source: { home: 'C:\\fake\\.dsh', profile: 'web' },
    dest: { userData: root, dshHome: home },
    // ⚠️ 判别力注入：units 的 size 故意比真实文件**小 868 字节**（真实回执里就是这个差值 ——
    //    `.bin\*` 垫片在 staging 阶段被改写过，units 记的是**源机**尺寸）⇒ 若代码改去读 units，
    //    第 4 项会 FAIL，而它本该 PASS ✓
    units: [{ id: 'profile:node_modules', action: 'copy-tree-payload',
      files: Object.keys(payload).map((rel) => ({ rel, size: len(payload[rel]) - 868 })) }],
    files,
    totalBytes: Object.values(files).reduce((s, f) => s + f.size, 0),
    gates: { I1: { ok: true }, I2: { ok: true } }
  }, null, 2), 'utf8');

  // deployed[]：真实形状只有 { path, action }（**没有** kind ✗）
  const deployed = Object.keys(payload).map((rel) => ({ path: rel, action: 'created' }))
    .concat([{ path: 'profiles/web/package.json', action: 'overwritten' }])
    // 名字里带状态目录字样、但首段是 profiles 的正常插件文件（实测真实回执里有 191 条这类）
    .concat([{ path: 'profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/client.js', action: 'created' },
      { path: 'profiles/web/node_modules/.bin/dsh-cost-meter-repair-sessions.cmd', action: 'created' }])
    .concat((opts.extraDeployed || []).map((p) => ({ path: p, action: 'created' })));
  fs.writeFileSync(path.join(root, 'dsh-migrate', 'receipt-' + opId + '.json'), JSON.stringify({
    schemaVersion: 1, opId, at: '2026-09-30T08:22:31.491Z',
    packageDir: pkgDir, backupDir: path.join(root, 'dsh-migrate', 'backup-test'), dshHome: home,
    source: { home: 'C:\\fake\\.dsh', profile: 'web' },
    deployed, conflicts: [], rewrites: [], refNames: [], externalRefs: [], gates: {}, nextSteps: []
  }, null, 2), 'utf8');

  return { root, home, profile, pkgDir, payload };
}

const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ } };

describe('--json 的形状：机器侧能直接读', () => {
  let r, tmp;
  beforeAll(() => { tmp = buildInstance(); r = runCheck(tmp.home); });
  afterAll(() => rm(tmp.root));

  it('是合法 JSON 数组、10 项、编号 1..10 不重不漏', () => {
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.items).toHaveLength(10);
    // 顺序不做要求（第 7 项与第 4 项共用一次遍历、紧跟在第 4 项后面 ✓），只要求编号齐全且唯一
    expect([...new Set(r.items.map((i) => i.no))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('每项都有 no/name/state/detail，state ∈ {PASS,FAIL,UNKNOWN}，且 detail 里没有占位符', () => {
    for (const it of r.items) {
      expect(Object.keys(it).sort()).toEqual(['detail', 'name', 'no', 'state']);
      expect(['PASS', 'FAIL', 'UNKNOWN']).toContain(it.state);
      expect(typeof it.name).toBe('string');
      expect(it.name.length).toBeGreaterThan(0);
      expect(typeof it.detail).toBe('string');
      expect(it.detail.length).toBeGreaterThan(0);
      expect(it.detail).not.toMatch(/undefined|\[object/);
    }
  });

  it('全绿时退出码 0（第 6 项无 overrides ⇒ UNKNOWN 不算红）', () => {
    expect(r.status, '假实例本该全绿；实际红的是：' + JSON.stringify(r.items.filter((i) => i.state === 'FAIL'))).toBe(0);
  });
});

describe('真实字段名：第 3/4/5/10 项按回执 + 投递包清单判定', () => {
  let r, tmp;
  beforeAll(() => { tmp = buildInstance(); r = runCheck(tmp.home); });
  afterAll(() => rm(tmp.root));

  it('第 3 项 PASS：现网 bundles 与**投递包副本**逐字一致（回执里没有 bundles 字段 ✗）', () => {
    expect(r.by.get(3).state).toBe('PASS');
    expect(r.by.get(3).detail).toContain('逐字一致');
  });

  it('第 4 项 PASS：文件数/字节取自 manifest.files{}，**不是** units[].files[].size', () => {
    expect(r.by.get(4).state).toBe('PASS');
    expect(r.by.get(4).detail).toContain('逐字节');
    expect(r.by.get(4).detail).toContain('manifest.files');       // 真值来源要写在明细里（可追溯）
    // 2 个文件 / 76 字节：与 units 里那组"故意写错"的值不同 ⇒ 证明读的是 files{} ✓
    expect(r.by.get(4).detail).toContain('2 文件');
  });

  it('第 5 项按「被声明」判：只有遗留目录、没有 $presets ⇒ UNKNOWN（**不再**把"文件在位"当模式可用）', () => {
    // 判据更正（2026-10-08）：内核已不再读 `.agent-presets/`（"Nothing reads that directory
    // any more"）⇒ 旧判据核对的是一份不影响生效的副本。这里锁三件：
    //   ① 没有声明 ⇒ UNKNOWN（判不了就说判不了，不是 PASS ✗）；
    //   ② 遗留目录仍被**如实报告**（信息，不是判分依据）；
    //   ③ 报告里说清它不影响生效 —— 免得下一个人又把"文件在"当"模式可用"。
    expect(r.by.get(5).state).toBe('UNKNOWN');
    expect(r.by.get(5).detail).toContain('没有 $presets');
    expect(r.by.get(5).detail).toContain('test-preset');
    expect(r.by.get(5).detail).toContain('内核已不读');
  });

  it('第 10 项 PASS：deployed[] 按 `path` + **首段**判 —— 名字里带 task-board/sessions 的插件文件不算污染', () => {
    expect(r.by.get(10).state).toBe('PASS');
    expect(r.by.get(10).detail).toContain('首段为状态目录');
  });

  it('第 9 项恒为 UNKNOWN —— 判不了的东西不许写成 PASS', () => {
    expect(r.by.get(9).state).toBe('UNKNOWN');
    expect(r.by.get(9).state).not.toBe('PASS');
  });
});

describe('缺文件的 home：不崩，且不许静默放过', () => {
  let r, tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-embedded-empty-'));
    fs.mkdirSync(path.join(tmp, 'dsh-home', '.agent-presets', 'test-preset'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dsh-home', '.agent-presets', 'test-preset', 'preset.yml'), 'name: test-preset\n');
    r = runCheck(path.join(tmp, 'dsh-home'));
  });
  afterAll(() => rm(tmp));

  it('没有 profile/package.json ⇒ 第 3 项 FAIL（不是崩，也不是 UNKNOWN 糊过去）', () => {
    expect(r.by.get(3).state).toBe('FAIL');
    expect(r.by.get(3).detail).toMatch(/读不到|找不到/);
  });

  it('没有 node_modules ⇒ 第 4 项 FAIL、第 7 项 UNKNOWN', () => {
    expect(r.by.get(4).state).toBe('FAIL');
    expect(r.by.get(7).state).toBe('UNKNOWN');
  });

  it('没有回执 ⇒ 第 10 项 UNKNOWN（**不是 PASS**：判不了就必须说判不了 ✗）', () => {
    expect(r.by.get(10).state).toBe('UNKNOWN');
    expect(r.by.get(10).state).not.toBe('PASS');
  });

  it('有 FAIL ⇒ 退出码非 0', () => {
    expect(r.status).not.toBe(0);
  });
});

describe('判别力：坏掉之后必须变红（三个故障同装一个实例，省掉重复起进程 ✓）', () => {
  let r, tmp;
  beforeAll(() => {
    // 同一份 fixture 里同时埋三处：① 载荷被动过；② 目的侧多出一个 bundle；③ 真搬了状态目录
    tmp = buildInstance({ dirtiesPayload: true, extraBundles: ['dest-only-plugin'], extraDeployed: ['task-board/board.json'] });
    r = runCheck(tmp.home);
  });
  afterAll(() => rm(tmp.root));

  it('载荷被动过 ⇒ 第 4 项 FAIL，并同时报出"期望 / 实际"两侧', () => {
    expect(r.by.get(4).state).toBe('FAIL');
    expect(r.by.get(4).detail).toMatch(/期望 2 文件/);
    expect(r.by.get(4).detail).toMatch(/实际 2 文件/);
    expect(r.by.get(4).detail).toContain('manifest.files');   // 红了也要能追溯真值来源 ✓
  });

  it('目的侧多出的 bundle **不算错**：第 3 项仍 PASS（合并语义 = 目的侧优先 + 源缺项追加）', () => {
    expect(r.by.get(3).state).toBe('PASS');
    expect(r.by.get(3).detail).toContain('顺序不变');
  });

  it('回执里真的搬了状态目录 ⇒ 第 10 项 FAIL（首段判据的判别力）', () => {
    expect(r.by.get(10).state).toBe('FAIL');
    expect(r.by.get(10).detail).toContain('task-board/board.json');
  });

  it('任一 FAIL ⇒ 退出码非 0', () => {
    expect(r.status).not.toBe(0);
  });
});

describe('第 5 项「模式声明」的判别力（2026-10-08 新判据）', () => {
  /** 给夹具补上 overrides 与 patch：第 5 项判的就是"声明 ↔ patch 行"这一对 */
  const withDecl = (tmp, presets, patchLines) => {
    fs.writeFileSync(path.join(tmp.home, '.embedded-overrides.json'),
      JSON.stringify({ $presets: presets }), 'utf8');
    if (patchLines) {
      fs.writeFileSync(path.join(tmp.home, 'profiles', 'web', 'cordis.patch.yml'), patchLines.join('\n'), 'utf8');
    }
  };

  it('声明了、patch 里也有对应的 preset 行 ⇒ PASS', () => {
    const tmp = buildInstance();
    withDecl(tmp, { mymode: { cloneFrom: 'standard' } }, ['- id: permission', '  config:', '    defaultPreset: x', '', '  - id: preset-mymode', '    name: "@deepseek-ai/dsh-agent-preset"']);
    const r = runCheck(tmp.home);
    expect(r.by.get(5).state).toBe('PASS');
    expect(r.by.get(5).detail).toContain('mymode');
    rm(tmp.root);
  });

  it('声明了、但 patch 里**没有**那一行 ⇒ FAIL（这才是要抓的失败形态：以为加了、其实没生效）', () => {
    const tmp = buildInstance();
    withDecl(tmp, { mymode: { cloneFrom: 'standard' } }, ['- id: permission', '  config:', '    defaultPreset: x']);
    const r = runCheck(tmp.home);
    expect(r.by.get(5).state).toBe('FAIL');
    expect(r.by.get(5).detail).toContain('patch 里没有对应行');
    rm(tmp.root);
  });

  it('声明了、但 patch 文件根本不存在 ⇒ FAIL（不是崩、也不是 UNKNOWN 糊过去）', () => {
    const tmp = buildInstance();
    withDecl(tmp, { mymode: { cloneFrom: 'standard' } }, null);
    const r = runCheck(tmp.home);
    expect(r.by.get(5).state).toBe('FAIL');
    expect(r.by.get(5).detail).toContain('找不到 patch 文件');
    rm(tmp.root);
  });
});
