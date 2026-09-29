/* ============================================================
 * tests/dsh-package.test.js — 运行包解析/校验/安装/回滚/锁 单元测试
 * ------------------------------------------------------------
 * 测试策略：临时目录里手工搭最小 manifest 结构（不引入真实 200MB 包），
 * 覆盖：结构校验 / 哈希校验（篡改即红）/ 路径逃逸与保留名 / active 原子状态 /
 * resolve 降级禁止 / 安装幂等 / 回滚 / 运行锁与维护锁互斥。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../src/dsh-package.js');

let tmp;
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const wf = (p, content) => { mkdir(path.dirname(p)); fs.writeFileSync(p, content); return p; };
const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');

/** 搭一个最小合法运行包：manifest + entries 指到的文件全部存在且哈希正确 */
function buildPackage(root, { id, extraFile, dshVersion } = {}) {
  mkdir(root);
  wf(path.join(root, 'node', 'node.exe'), 'FAKE-NODE-EXE');
  wf(path.join(root, 'app', 'lib', 'bin.js'), 'FAKE-DSH-BIN');
  wf(path.join(root, 'tools', 'pnpm', 'bin', 'pnpm.cjs'), 'FAKE-PNPM');
  wf(path.join(root, 'bin', 'pnpm.cmd'), 'FAKE-SHIM');
  const files = {};
  const collect = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p, r);
      else {
        const content = fs.readFileSync(p);
        files[r] = { size: content.length, sha256: sha(content) };
      }
    }
  };
  collect(root, '');
  if (extraFile) {
    wf(path.join(root, extraFile), 'EXTRA');
    files[extraFile] = { size: 5, sha256: sha('EXTRA') };
  }
  const manifest = {
    schemaVersion: 1,
    id: id || 'dsh-0.1.5-rc.1-win32-x64-test12',
    dshVersion: dshVersion || '0.1.5-rc.1',
    pnpmVersion: '10.15.1',
    nodeVersion: '24.19.0',
    platform: process.platform,
    arch: process.arch,
    createdAt: new Date().toISOString(),
    entries: { node: 'node/node.exe', dsh: 'app/lib/bin.js', pnpm: 'tools/pnpm/bin/pnpm.cjs', bin: 'bin' },
    files,
    totalBytes: 100
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pkg-test-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

describe('validateRuntime', () => {
  it('合法包通过校验并返回绝对路径', () => {
    const root = path.join(tmp, 'pkg');
    buildPackage(root);
    const r = pkg.validateRuntime(root);
    expect(r.root).toBe(path.resolve(root));
    expect(r.node.endsWith(path.join('node', 'node.exe'))).toBe(true);
    expect(r.dsh.endsWith(path.join('app', 'lib', 'bin.js'))).toBe(true);
    expect(r.pnpm.endsWith(path.join('pnpm.cjs'))).toBe(true);
  });

  it('文件被篡改 → 校验失败（大小或 sha256 不符）', () => {
    const root = path.join(tmp, 'pkg');
    buildPackage(root);
    fs.writeFileSync(path.join(root, 'app', 'lib', 'bin.js'), 'TAMPERED');
    expect(() => pkg.validateRuntime(root)).toThrowError(/不符/);
  });

  it('文件缺失 → ENOTFOUND', () => {
    const root = path.join(tmp, 'pkg');
    buildPackage(root);
    fs.rmSync(path.join(root, 'tools', 'pnpm', 'bin', 'pnpm.cjs'));
    expect(() => pkg.validateRuntime(root)).toThrowError(/entries\.pnpm 不存在/);
  });

  it('清单里出现未登记文件 → 不影响校验（manifest 只保证已登记文件准确）', () => {
    const root = path.join(tmp, 'pkg');
    buildPackage(root);
    wf(path.join(root, 'stray.txt'), 'STRAY');
    expect(() => pkg.validateRuntime(root)).not.toThrow();
  });

  it('平台不符 → EINVAL', () => {
    const root = path.join(tmp, 'pkg');
    const m = buildPackage(root);
    m.platform = 'linux';
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m));
    expect(() => pkg.validateRuntime(root)).toThrowError(/平台不符/);
  });

  it('manifest 缺字段 → ECORRUPT', () => {
    const root = path.join(tmp, 'pkg');
    const m = buildPackage(root);
    delete m.entries.pnpm;
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m));
    expect(() => pkg.validateRuntime(root)).toThrowError(/entries 缺: pnpm/);
  });

  it('--skip-hashes 跳过哈希（但 entries 存在性仍查）', () => {
    const root = path.join(tmp, 'pkg');
    buildPackage(root);
    fs.writeFileSync(path.join(root, 'node', 'node.exe'), 'CHANGED-BUT-SKIPPED');
    expect(() => pkg.validateRuntime(root, { verifyHashes: false })).not.toThrow();
  });
});

describe('路径安全', () => {
  it('保留名路径被拒（CON）', () => {
    expect(() => pkg.assertSafeRel('node/CON')).toThrowError(/保留名/);
  });
  it('.. 逃逸被拒', () => {
    expect(() => pkg.assertSafeRel('../outside')).toThrowError(/\.\./);
  });
  it('反斜杠 / 绝对路径被拒', () => {
    expect(() => pkg.assertSafeRel('a\\b')).toThrowError();
    expect(() => pkg.assertSafeRel('C:/x')).toThrowError();
    expect(() => pkg.assertSafeRel('/x')).toThrowError();
  });
  it('safeJoin 解析结果不得逃逸 root', () => {
    const root = path.join(tmp, 'pkg');
    buildPackage(root);
    expect(() => pkg.safeJoin(root, '../evil')).toThrow();
    expect(pkg.safeJoin(root, 'app/lib/bin.js')).toBe(path.resolve(root, 'app/lib/bin.js'));
  });
});

describe('resolveRuntime（选择运行包）', () => {
  it('无 active.json → 用 bundled', () => {
    const bundled = path.join(tmp, 'bundled');
    buildPackage(bundled);
    const ud = path.join(tmp, 'ud');
    const r = pkg.resolveRuntime({ bundledRoot: bundled, userDataPath: ud });
    expect(r.source).toBe('bundled');
  });

  it('active 指向 installed → 用 installed', () => {
    const bundled = path.join(tmp, 'bundled');
    buildPackage(bundled, { id: 'dsh-bundled' });
    const ud = path.join(tmp, 'ud');
    const inst = path.join(ud, 'dsh-runtimes', 'dsh-installed');
    const m = buildPackage(inst, { id: 'dsh-installed' });
    pkg.writeActiveAtomic(ud, { schemaVersion: 1, current: m.id, previous: null, updatedAt: new Date().toISOString() });
    const r = pkg.resolveRuntime({ bundledRoot: bundled, userDataPath: ud });
    expect(r.source).toBe('installed');
    expect(r.manifest.id).toBe('dsh-installed');
  });

  it('active 指向的 installed 目录缺失 → 报错，绝不静默降级 bundled', () => {
    const bundled = path.join(tmp, 'bundled');
    buildPackage(bundled);
    const ud = path.join(tmp, 'ud');
    mkdir(path.join(ud, 'dsh-runtimes'));
    pkg.writeActiveAtomic(ud, { schemaVersion: 1, current: 'dsh-gone', previous: null, updatedAt: new Date().toISOString() });
    expect(() => pkg.resolveRuntime({ bundledRoot: bundled, userDataPath: ud }))
      .toThrowError(/manifest\.json 不存在/);
  });

  it('active.json 损坏 → 报错不降级', () => {
    const bundled = path.join(tmp, 'bundled');
    buildPackage(bundled);
    const ud = path.join(tmp, 'ud');
    mkdir(path.join(ud, 'dsh-runtimes'));
    fs.writeFileSync(pkg.activePath(ud), '{broken json');
    expect(() => pkg.resolveRuntime({ bundledRoot: bundled, userDataPath: ud }))
      .toThrowError(/无法解析/);
  });
});

describe('installRuntime / rollbackRuntime', () => {
  it('导入新包 → 复制到 runtimes/<id> 并切 active；dsh-home 不被触碰', () => {
    const bundled = path.join(tmp, 'bundled');
    buildPackage(bundled, { id: 'dsh-bundled' });
    const ud = path.join(tmp, 'ud');
    // 预置用户数据（会话/插件），安装绝不能动它
    const home = path.join(ud, 'dsh-home', 'sessions');
    wf(path.join(home, 's1.jsonl'), 'SESSION-DATA');
    const src = path.join(tmp, 'newpkg');
    const m = buildPackage(src, { id: 'dsh-new', dshVersion: '0.2.0' });

    const r = pkg.installRuntime(src, ud);
    expect(r.id).toBe('dsh-new');
    expect(fs.existsSync(path.join(ud, 'dsh-runtimes', 'dsh-new', 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(home, 's1.jsonl'), 'utf8')).toBe('SESSION-DATA');
    const a = pkg.readActive(ud);
    expect(a.current).toBe('dsh-new');
    expect(a.previous).toBe(null);
  });

  it('重复导入同一包 → 幂等（不报错，active 仍指向它）', () => {
    const ud = path.join(tmp, 'ud');
    const src = path.join(tmp, 'newpkg');
    buildPackage(src, { id: 'dsh-new' });
    pkg.installRuntime(src, ud);
    const r2 = pkg.installRuntime(src, ud);
    expect(r2.id).toBe('dsh-new');
    expect(pkg.readActive(ud).current).toBe('dsh-new');
  });

  it('导入的包损坏（哈希不符）→ 拒绝，不产生半截目录状态', () => {
    const ud = path.join(tmp, 'ud');
    const src = path.join(tmp, 'badpkg');
    buildPackage(src, { id: 'dsh-bad' });
    fs.writeFileSync(path.join(src, 'node', 'node.exe'), 'TAMPERED');
    expect(() => pkg.installRuntime(src, ud)).toThrowError(/不符/);
    expect(fs.existsSync(path.join(ud, 'dsh-runtimes', 'dsh-bad'))).toBe(false);
    // active 从未被写：读它会因文件不存在而返回 null（null = 没有 active，不是降级）
    expect(pkg.readActive(ud)).toBe(null);
  });

  it('回滚 → active 回 bundled，previous 记录旧值', () => {
    const ud = path.join(tmp, 'ud');
    const src = path.join(tmp, 'newpkg');
    buildPackage(src, { id: 'dsh-new' });
    pkg.installRuntime(src, ud);
    const a = pkg.rollbackRuntime(ud);
    expect(a.current).toBe('bundled');
    expect(a.previous).toBe('dsh-new');
  });

  it('当前已是 bundled → 回滚报错', () => {
    const ud = path.join(tmp, 'ud');
    expect(() => pkg.rollbackRuntime(ud)).toThrowError(/无从回滚/);
    mkdir(path.join(ud, 'dsh-runtimes'));
    pkg.writeActiveAtomic(ud, { schemaVersion: 1, current: 'bundled', previous: null, updatedAt: new Date().toISOString() });
    expect(() => pkg.rollbackRuntime(ud)).toThrowError(/没有可回滚项/);
  });
});

describe('运行锁与维护锁互斥', () => {
  it('先取运行锁 → 维护被拒（ELOCKED）；释放后可维护', () => {
    const ud = path.join(tmp, 'ud');
    const run = pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run');
    expect(() => pkg.acquireRuntimeLock(ud, { op: 'install' }, 'guard')).toThrowError(/服务运行中/);
    run.release();
    expect(fs.existsSync(path.join(ud, 'dsh-runtime.lock'))).toBe(false);
    const g = pkg.acquireRuntimeLock(ud, { op: 'install' }, 'guard');
    g.release();
  });

  it('陈旧运行锁（持有进程已死）→ 可接管，不永久阻塞', () => {
    const ud = path.join(tmp, 'ud');
    fs.mkdirSync(ud, { recursive: true });
    // 手工放一个死 pid 的锁（不可能是本测试进程）
    fs.writeFileSync(path.join(ud, 'dsh-runtime.lock'),
      JSON.stringify({ token: 'dead', pid: 999999999, kind: 'run', owner: {}, since: new Date().toISOString() }));
    const lock = pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run'); // 应接管而非 ELOCKED
    expect(lock.token).not.toBe('dead');
    lock.release();
    expect(fs.existsSync(path.join(ud, 'dsh-runtime.lock'))).toBe(false);
  });

  it('活跃运行锁（持有进程是本进程）→ 拒绝（ELOCKED）', () => {
    const ud = path.join(tmp, 'ud');
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'dsh-runtime.lock'),
      JSON.stringify({ token: 'live', pid: process.pid, kind: 'run', owner: {}, since: new Date().toISOString() }));
    expect(() => pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run')).toThrowError(/运行中/);
  });

  it('坏 JSON 锁文件 → 按陈旧处理可接管（不永久阻塞）', () => {
    const ud = path.join(tmp, 'ud');
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'dsh-runtime.lock'), '{broken');
    const lock = pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run');
    expect(lock.file).toContain('dsh-runtime.lock');
    lock.release();
  });

  it('先取维护锁 → 启动被拒；双向互斥', () => {
    const ud = path.join(tmp, 'ud');
    const g = pkg.acquireRuntimeLock(ud, { op: 'install' }, 'guard');
    expect(() => pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run')).toThrowError(/维护进行中/);
    g.release();
    expect(() => pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run')).not.toThrow();
  });

  it('release 只删自己的锁（token 不符不动）', () => {
    const ud = path.join(tmp, 'ud');
    const a = pkg.acquireRuntimeLock(ud, { op: 'a' }, 'run');
    // 模拟另一进程强写了 lock 文件（token 变了）
    fs.writeFileSync(path.join(ud, 'dsh-runtime.lock'), JSON.stringify({ token: 'other', owner: {} }));
    a.release();
    expect(fs.existsSync(path.join(ud, 'dsh-runtime.lock'))).toBe(true); // 不该被 a 删掉
  });

  it('安装时若服务运行中（运行锁在）→ 拒绝', () => {
    const ud = path.join(tmp, 'ud');
    const run = pkg.acquireRuntimeLock(ud, { op: 'service' }, 'run');
    const src = path.join(tmp, 'newpkg');
    buildPackage(src, { id: 'dsh-new' });
    expect(() => pkg.installRuntime(src, ud)).toThrowError(/服务运行中/);
    run.release();
    expect(() => pkg.installRuntime(src, ud)).not.toThrow();
  });
});

/* 驻留语义的关键一环（v0.16.6）：锁的 pid 必须跟着**服务**走，而不是孵化者。
 * 反例（修复前）：主界面正常退出后服务仍在跑，而锁里是主界面的死 pid ——
 * 后来者按"陈旧锁"接管，`npm run dsh:maint -- import` 就会在一个活着的服务
 * 脚下换掉运行包（服务跑旧包、新界面接管它，状态自相矛盾）。 */
describe('retargetRuntimeLock（锁改指服务进程）', () => {
  it('改指后：锁里 pid = 服务 pid，并留档 launcherPid；token/owner 不变', () => {
    const ud = path.join(tmp, 'ud');
    const lock = pkg.acquireRuntimeLock(ud, { op: 'sidebar' }, 'run');
    const ok = pkg.retargetRuntimeLock(lock, process.pid + 1);
    expect(ok).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(ud, 'dsh-runtime.lock'), 'utf8'));
    expect(raw.pid).toBe(process.pid + 1);
    expect(raw.holder).toBe('service');
    expect(raw.launcherPid).toBe(process.pid);
    expect(raw.token).toBe(lock.token);
    expect(raw.owner).toEqual({ op: 'sidebar' });
    lock.release();
  });

  it('改指后维护仍被拒（锁随服务活着而活着）—— 这是修复的核心目的', () => {
    const ud = path.join(tmp, 'ud');
    const lock = pkg.acquireRuntimeLock(ud, { op: 'sidebar' }, 'run');
    pkg.retargetRuntimeLock(lock, process.pid); // 用一个"活着的" pid 冒充驻留服务
    expect(() => pkg.acquireRuntimeLock(ud, { op: 'install' }, 'guard')).toThrowError(/服务运行中/);
    lock.release();
    expect(fs.existsSync(path.join(ud, 'dsh-runtime.lock'))).toBe(false);
  });

  it('锁已被接管（token 不符）→ 不改写，返回 false（不动别人的锁）', () => {
    const ud = path.join(tmp, 'ud');
    const lock = pkg.acquireRuntimeLock(ud, { op: 'sidebar' }, 'run');
    fs.writeFileSync(path.join(ud, 'dsh-runtime.lock'),
      JSON.stringify({ token: 'other', pid: 4242, kind: 'run', owner: {} }));
    expect(pkg.retargetRuntimeLock(lock, process.pid)).toBe(false);
    const raw = JSON.parse(fs.readFileSync(path.join(ud, 'dsh-runtime.lock'), 'utf8'));
    expect(raw.pid).toBe(4242); // 没被改
  });

  it('参数不全（无 lock / 无 pid）→ false，不抛', () => {
    expect(pkg.retargetRuntimeLock(null, 123)).toBe(false);
    const ud = path.join(tmp, 'ud');
    const lock = pkg.acquireRuntimeLock(ud, { op: 'sidebar' }, 'run');
    expect(pkg.retargetRuntimeLock(lock, 0)).toBe(false);
    lock.release();
  });
});
