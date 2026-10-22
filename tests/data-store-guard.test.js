/* ============================================================
 * tests/data-store-guard.test.js — 数据安全闸门（写前上限 / 写后回读 / 报文订正）
 * ------------------------------------------------------------
 * 这一批修的是**实测**发生过的一次数据销毁（不是假想的边界）：
 *   · `.review/20261034-规模化阈值/logs/06-bigfile-guard.json` 记着三件事：
 *     ① `fs.readFileSync(p,'utf8')` 在 540 MB 抛（500 MB 读得回来）⇒ 项目 JSON 的物理天花板 ≈ 512 MB；
 *     ② 越过它之后，**不带 expectVersion 的 `store.write` 照样"成功"**，把 540 MB 旧文件覆盖成
 *        **215 字节**，而变更日志记 `created:true, changed:[]`；
 *     ③ 带 expectVersion 时报 `VERSION_CONFLICT …（盘上 已不存在）` —— **文件明明在，报文说不在**。
 *
 * 三条判据（缺一条不算修）：
 *   A. **写前**：payload 字节数 > 声明上限 ⇒ `WRITE_TOO_LARGE`，**一个字节都不写**（sha256 前后对照）；
 *   B. **写后**：回读核对（字节 + parse）不一致 ⇒ `WRITE_VERIFY_FAILED`，且**旧文件保留**
 *      —— 这条才是核心：A 只挡住"写之前就知道太大"，挡不住"写到一半出事"
 *      （磁盘满 / 进程被杀 / 只写半截时 `fs.writeFileSync` **不一定会抛**）；
 *   C. **报文**：文件真的不存在 ⇒ 保持原话；**存在但读不回来** ⇒ 必须说"存在但无法读取"。
 *
 * 该绿的两条也在这里（防"修好一处、误伤一片"）：
 *   D. 正常写入的字节与 `JSON.stringify(data,null,2)` **逐字节相同**（格式没变、内容没变）；
 *   E. `expectVersion` 的既有语义不变（匹配则写 / 过期则拒且带 `VERSION_CONFLICT` / 声称过而文件
 *      不存在则报"已不存在"）—— `src/concurrency.js` 的自动重放只认那个码，语义一变它就静默失效。
 *
 * 隔离：每个用例一个 `%TEMP%` 沙箱根（`makeTmp`），**不碰真 `projects/`**。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';
import {
  createStore, versionOfText, verifyOnDisk, inspectOnDisk,
  MAX_PROJECT_FILE_MB, WRITE_TOO_LARGE, WRITE_VERIFY_FAILED, TARGET_UNREADABLE
} from '../src/data-store.js';

let root;
let store;

const sample = (topic) => ({
  meta: { name: 't', formatVersion: 2 },
  format: 'node_tree',
  data: { id: 'root', topic: topic || 'R', expanded: true, children: [] }
});

/** 文件字节的 sha256（"真的没被动过"的唯一判据：比大小挡不住同长度的改写） */
const shaOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tmpLeftovers = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')) : [];
const projFile = (name) => path.join(root, name, name + '.json');
const changeLogOf = (name) => path.join(root, name, '.changes.jsonl');

beforeEach(() => {
  root = makeTmp('mm-guard-');
  store = createStore(root);   // 不传 validate：本文件只测存储层本身
});

afterEach(() => {
  vi.restoreAllMocks();
  root = null;
});

afterAll(cleanupAll);

/* ============================================================
 * A · 写前上限 —— 超限响亮失败，且**一个字节都不写**
 * ============================================================ */
describe('数据安全 A · 写前上限（MAX_PROJECT_FILE_MB）', () => {
  it('上限是一个**导出的数字常量**（判据读它，不抄一份）', () => {
    // 为什么只判形状不判具体值：具体值由 `scripts/collateral-check.js` 的 `CAPPED_LITERALS`
    // （`kind:'pin'`）钉在册上 —— 那里才判"改了会不会没人看见"。这里只要它可用。
    expect(typeof MAX_PROJECT_FILE_MB).toBe('number');
    expect(Number.isInteger(MAX_PROJECT_FILE_MB)).toBe(true);
    expect(MAX_PROJECT_FILE_MB).toBeGreaterThan(0);
  });

  it('★ 超限 ⇒ WRITE_TOO_LARGE、盘上原文件 sha256 不变、无 .tmp、变更日志没多一行', () => {
    store.write('big', sample('原始内容，一个字节都不许动'));
    const file = projFile('big');
    const shaBefore = shaOf(file);
    const sizeBefore = fs.statSync(file).size;
    const logBefore = fs.existsSync(changeLogOf('big')) ? fs.readFileSync(changeLogOf('big'), 'utf8') : null;

    // payload 比上限**多 1 MB**（只多不少 ⇒ 判据必须命中；多太多只是白烧内存）
    const tooBig = {
      meta: { name: 'big', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'R', expanded: true, children: [],
        detail: 'A'.repeat(MAX_PROJECT_FILE_MB * 1024 * 1024 + 1024 * 1024) }
    };

    let err = null;
    try { store.write('big', tooBig); } catch (e) { err = e; }
    expect(err, '超限写入必须响亮失败，绝不许"成功"').toBeTruthy();
    expect(err.code).toBe(WRITE_TOO_LARGE);
    // 报文要说清"当前多大 / 上限多大 / 出路"——只说"太大"等于没说
    expect(err.message).toContain('超过声明上限 ' + MAX_PROJECT_FILE_MB + ' MB');
    expect(err.message).toContain('一个字节都没写');
    expect(err.message).toMatch(/出路/);

    // 盘上那一份**一个字节都没动**（sha256 对照；只比大小挡不住同长度改写）
    expect(shaOf(file)).toBe(shaBefore);
    expect(fs.statSync(file).size).toBe(sizeBefore);
    expect(tmpLeftovers(path.join(root, 'big'))).toEqual([]);
    // 变更日志也没有多出一行（"没写盘"要在**所有**产物上都成立，不只是项目文件）
    const logAfter = fs.existsSync(changeLogOf('big')) ? fs.readFileSync(changeLogOf('big'), 'utf8') : null;
    expect(logAfter).toBe(logBefore);
  });
});

/* ============================================================
 * B · 写后回读核对 —— 写到一半出事也必须响亮失败、且旧文件保留
 * ============================================================ */
describe('数据安全 B · 写后回读核对（verifyOnDisk）', () => {
  it('★ 写成功但只落了半截（fs.writeFileSync **不抛错**）⇒ WRITE_VERIFY_FAILED，旧文件不变', () => {
    store.write('half', sample('旧版本，必须活下来'));
    const file = projFile('half');
    const shaBefore = shaOf(file);
    const logBefore = fs.readFileSync(changeLogOf('half'), 'utf8');

    // 注入"只写了半截、但**没有抛错**"：这才是致命形状 ——
    // 旧实现在这里会 `fsync` + `rename`，把半截文件堂而皇之换上目标位（且命令回 0）。
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, content, opts) => {
      const half = typeof content === 'string' ? content.slice(0, Math.floor(content.length / 2)) : content;
      real.call(fs, target, half, opts);
      // ⚠️ 故意不抛：模拟磁盘满/被杀之后"写少了一半却没人报"的那种文件系统行为
    });

    let err = null;
    try { store.write('half', sample('新数据，体量更大一些以便截断可观测')); } catch (e) { err = e; }
    spy.mockRestore();

    expect(err, '半截写入必须被回读核对抓住，绝不许静默换上目标位').toBeTruthy();
    expect(err.code).toBe(WRITE_VERIFY_FAILED);
    expect(err.message).toMatch(/写后核对失败/);
    expect(err.message).toMatch(/大小不符|字节数/);
    // **旧文件保留**（换名前核对 ⇒ 目标位连一瞬都没被动过）
    expect(shaOf(file)).toBe(shaBefore);
    expect(tmpLeftovers(path.join(root, 'half'))).toEqual([]);
    // 变更日志也不能记一条"写成功"（记了就等于又撒了一次谎）
    expect(fs.readFileSync(changeLogOf('half'), 'utf8')).toBe(logBefore);
  });

  it('★ 长度一样、字节不同（只比长度会漏）⇒ 仍然 WRITE_VERIFY_FAILED', () => {
    store.write('same', sample('旧内容'));
    const file = projFile('same');
    const shaBefore = shaOf(file);

    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, content, opts) => {
      // ⚠️ 长度必须按**字节**算：本用例的 JSON 里有中文，一个字符 3 字节 ——
      // 按字符数造"等长垃圾"会造出一个更短的文件，于是判据落在"大小不符"那一档、测不到这一档。
      const n = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), 'utf8');
      const garbage = Buffer.alloc(n, 0x58);            // 'X' × n 字节：**长度完全一样**
      real.call(fs, target, garbage, opts);
    });

    let err = null;
    try { store.write('same', sample('新内容')); } catch (e) { err = e; }
    spy.mockRestore();

    expect(err).toBeTruthy();
    expect(err.code).toBe(WRITE_VERIFY_FAILED);
    expect(err.message).toMatch(/不一致/);
    expect(shaOf(file)).toBe(shaBefore);
    expect(tmpLeftovers(path.join(root, 'same'))).toEqual([]);
  });

  it('换名之后才发现不一致（stage=target）⇒ 报文要求保留回滚材料，且不删任何东西', () => {
    const file = path.join(root, 'target-stage.json');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, 'GOOD-BUT-NOT-WHAT-WE-THINK\n', 'utf8');

    let err = null;
    try {
      verifyOnDisk(file, 'EXPECTED-CONTENT\n', { label: '项目「t-stage」', parse: false, stage: 'target' });
    } catch (e) { err = e; }

    expect(err.code).toBe(WRITE_VERIFY_FAILED);
    // 换名之后：盘上可能已经是坏的那份 ⇒ 报文必须点名"别删回滚材料"
    expect(err.message).toMatch(/回滚材料/);
    expect(err.message).toMatch(/不要删/);
    // 而且它自己**没有**删掉任何东西（判据只报，不动现场）
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('GOOD-BUT-NOT-WHAT-WE-THINK\n');
  });

  it('★ 换名**之后**盘上那份才坏（目标位被外部改写）⇒ 写后回读必须自己抓住', () => {
    /* 为什么这条非有不可（判别力实测）：把 `store.write` 里**写后**那次 `verifyOnDisk` 拔掉，
     * 上面两条仍然全绿 —— 因为换名前的核对先把它们挡住了。也就是说没有本用例，
     * "写完再看一眼目标文件"这条守卫**没有任何判据**（跑 `repro/40-mutation.js` 可复现）。
     * 它防的是"rename 成功了、但盘上那份字节不是我们写的那份"（杀毒/备份/同步盘改写、
     * 文件系统或硬件撒谎）—— 那一档只有**看最终产物**才发现得了。 */
    store.write('renamed', sample('旧内容，会被这次写入换掉'));
    const file = projFile('renamed');
    const logBefore = fs.readFileSync(changeLogOf('renamed'), 'utf8');

    const realRename = fs.renameSync;
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      realRename.call(fs, from, to);                 // 换名本身是成功的
      const buf = fs.readFileSync(to);
      buf[buf.length - 1] = 0x20;                    // 尾字节换成空格：**长度不变**
      realWrite.call(fs, to, buf);                   // 模拟"换名之后字节被外部改掉"
    });

    let err = null;
    try { store.write('renamed', sample('新内容，会在目标位上被改坏')); } catch (e) { err = e; }
    spy.mockRestore();

    expect(err, '目标位的字节坏了却没报 ⇒ 又回到静默毁数据').toBeTruthy();
    expect(err.code).toBe(WRITE_VERIFY_FAILED);
    expect(err.message).toMatch(/不一致/);           // 长度一样，靠逐字节比才抓得到
    // 这一档没法回滚（旧文件已经被换掉了）⇒ 报文必须点名"保留回滚材料"
    expect(err.message).toMatch(/回滚材料/);
    expect(fs.existsSync(file)).toBe(true);          // 现场**不许**被清理掉
    // 也绝不许给这次写入记一条"成功"
    expect(fs.readFileSync(changeLogOf('renamed'), 'utf8')).toBe(logBefore);
  });

  it('verifyOnDisk 的三种失败各自点名原因（大小 / 字节 / parse），不合并成一句"失败"', () => {
    const file = path.join(root, 'v.json');
    fs.writeFileSync(file, 'abc', 'utf8');

    // ① 大小不符
    let e1 = null;
    try { verifyOnDisk(file, 'abcdef', { parse: false }); } catch (e) { e1 = e; }
    expect(e1.code).toBe(WRITE_VERIFY_FAILED);
    expect(e1.message).toMatch(/大小不符/);

    // ② 长度相同但字节不同（带出第一个不同的字节位置：不给人猜的余地）
    let e2 = null;
    try { verifyOnDisk(file, 'abd', { parse: false }); } catch (e) { e2 = e; }
    expect(e2.code).toBe(WRITE_VERIFY_FAILED);
    expect(e2.message).toMatch(/不一致/);
    expect(e2.message).toMatch(/第 3 字节/);

    // ③ 字节对得上、但解析不了（"写对了字节"不等于"写对了内容"）
    let e3 = null;
    try { verifyOnDisk(file, 'abc', { parse: true }); } catch (e) { e3 = e; }
    expect(e3.code).toBe(WRITE_VERIFY_FAILED);
    expect(e3.message).toMatch(/解析失败/);
  });
});

/* ============================================================
 * C · 报文订正 —— 「存在但无法读取」不许说成「已不存在」
 * ============================================================ */
describe('报文订正 C · 盘上文件存在但读不回来', () => {
  /** 造一份"存在、但字节不构成合法 UTF-8"的项目文件（**不用 mock**：这是真实的一档） */
  function makeUnreadableBytes(name) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.json');
    // 0xC3 0x28 不是合法的 UTF-8 序列 ⇒ 按 utf8 读回来会变成 U+FFFD（3 字节）+ '('
    // ⇒ 解出的字符串字节数 ≠ 文件字节数 ⇒ `inspectOnDisk` 判 unreadable（大小不符）
    fs.writeFileSync(file, Buffer.from([0x41, 0xC3, 0x28, 0x42]));
    return file;
  }

  it('★ 存在但读不回来 ⇒ 报文是「存在但无法读取」，**且不说"已不存在"**，且不覆盖', () => {
    const file = makeUnreadableBytes('bad');
    const shaBefore = shaOf(file);

    let err = null;
    try { store.write('bad', sample('新数据'), { expectVersion: 'deadbeefdeadbeef' }); } catch (e) { err = e; }

    expect(err).toBeTruthy();
    expect(err.code).toBe(TARGET_UNREADABLE);
    expect(err.message).toContain('存在但无法读取');   // 必须说的话
    expect(err.message).not.toContain('已不存在');      // 不许说的话（文件明明在）
    expect(err.message).toContain('大小 4 字节');       // 说清"多大"（4 = 那份文件的真实大小）
    expect(err.message).toContain('大小不符');          // 说清"为什么"（原因也要给）

    expect(shaOf(file)).toBe(shaBefore);               // 一个字节都没动
    expect(tmpLeftovers(path.join(root, 'bad'))).toEqual([]);
  });

  it('★ 同一个形状，**不带 expectVersion** 也必须拒绝（这才是数据销毁的那条路）', () => {
    const file = makeUnreadableBytes('bad2');
    const shaBefore = shaOf(file);

    let err = null;
    try { store.write('bad2', sample('新数据')); } catch (e) { err = e; }

    expect(err, '没声明版本不等于"盘上没有东西"：读不回来就不许覆盖').toBeTruthy();
    expect(err.code).toBe(TARGET_UNREADABLE);
    expect(err.message).not.toContain('已不存在');
    expect(shaOf(file)).toBe(shaBefore);   // 540 MB 笔记被换成 215 字节的那个形状，在这里被挡住
  });

  it('读回时抛错（模拟超过 readFileSync 的字符串上限）⇒ 同样的话术 + 带上大小与原因', () => {
    store.write('huge', sample('旧'));
    const file = projFile('huge');
    const shaBefore = shaOf(file);
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (String(p).endsWith('huge.json')) {
        throw new Error('Cannot create a string longer than 0x1fffffe8 characters');
      }
      return real.call(fs, p, ...rest);
    });

    let err = null;
    try { store.write('huge', sample('新'), { expectVersion: 'deadbeefdeadbeef' }); } catch (e) { err = e; }
    spy.mockRestore();

    expect(err).toBeTruthy();
    expect(err.code).toBe(TARGET_UNREADABLE);
    expect(err.message).toContain('存在但无法读取');
    expect(err.message).toContain('Cannot create a string longer than 0x1fffffe8 characters');
    expect(err.message).not.toContain('已不存在');
    expect(shaOf(file)).toBe(shaBefore);
  });

  it('文件**真的不存在** ⇒ 保持原话「已不存在」（该说的话不许被改掉）', () => {
    store.write('gone', sample('x'));
    const v = store.read('gone').version;
    fs.rmSync(path.join(root, 'gone'), { recursive: true, force: true });

    let err = null;
    try { store.write('gone', sample('y'), { expectVersion: v }); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.message).toMatch(/已不存在/);
    expect(fs.existsSync(projFile('gone'))).toBe(false);   // 也没被偷偷建出来
  });

  it('read 对"存在但读不回来"的项目说实话（不是"项目不存在"）', () => {
    makeUnreadableBytes('bad3');
    let err = null;
    try { store.read('bad3'); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toContain('存在但无法读取');
    expect(err.message).not.toContain('项目不存在');
  });

  it('read 对"能读回来但解析不了"的项目单列一档（存在但无法解析）', () => {
    const dir = path.join(root, 'badjson');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'badjson.json'), '{"a": 1,,,}', 'utf8');
    let err = null;
    try { store.read('badjson'); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toContain('存在但无法解析');
    expect(err.message).toContain('解析失败');
    expect(err.message).not.toContain('项目不存在');
  });

  it('inspectOnDisk 三档：absent / unreadable / ok 各自可分辨', () => {
    expect(inspectOnDisk(path.join(root, 'nope', 'nope.json')).state).toBe('absent');
    const bad = makeUnreadableBytes('trip');
    expect(inspectOnDisk(bad).state).toBe('unreadable');
    store.write('trip2', sample('ok'));
    const ok = inspectOnDisk(projFile('trip2'));
    expect(ok.state).toBe('ok');
    expect(ok.version).toBe(versionOfText(ok.text));
    expect(ok.bytes).toBe(fs.statSync(projFile('trip2')).size);
  });
});

/* ============================================================
 * D · 该绿：正常写入逐字节不变（修好一处不许误伤一片）
 * ============================================================ */
describe('该绿 D · 正常写入逐字节不变', () => {
  it('落盘字节 **恰好等于** JSON.stringify(data, null, 2)（格式与内容都没变）', () => {
    const data = sample('逐字节');
    const r = store.write('plain', data);
    const expected = JSON.stringify(data, null, 2);
    expect(fs.readFileSync(r.file, 'utf8')).toBe(expected);
    expect(Buffer.compare(fs.readFileSync(r.file), Buffer.from(expected, 'utf8'))).toBe(0);
    expect(r.version).toBe(versionOfText(expected));
  });

  it('同一份数据重复写 ⇒ 字节完全相同（回读核对没有副作用、没有多余空白/换行）', () => {
    const data = sample('幂等');
    store.write('idem', data);
    const sha1 = shaOf(projFile('idem'));
    store.write('idem', data);
    const sha2 = shaOf(projFile('idem'));
    expect(sha2).toBe(sha1);
    expect(tmpLeftovers(path.join(root, 'idem'))).toEqual([]);
  });

  it('正常写入仍然记一条变更日志（回读核对不许把记账吞掉）', () => {
    store.write('log', sample('v1'));
    store.write('log', sample('v2'));
    const lines = fs.readFileSync(changeLogOf('log'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).changed).toContain('node:root');
  });
});

/* ============================================================
 * E · 该绿：expectVersion 的既有语义不变
 * ============================================================ */
describe('该绿 E · expectVersion 语义不变', () => {
  it('匹配 ⇒ 写入；过期 ⇒ 拒绝且**带 VERSION_CONFLICT 码**（自动重放只认这个码）', () => {
    store.write('ver', sample('第一版'));
    const v = store.read('ver').version;
    store.write('ver', sample('别人写的'));

    let err = null;
    try { store.write('ver', sample('我的旧数据'), { expectVersion: v }); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.expectVersion).toBe(v);
    expect(typeof err.actualVersion).toBe('string');

    // 新读到的版本可以写
    const fresh = store.read('ver').version;
    store.write('ver', sample('第二版'), { expectVersion: fresh });
    expect(store.read('ver').data.data.topic).toBe('第二版');
  });

  it('不传 expectVersion 仍然放行（老行为：新建项目 / 命令层没读过就写）', () => {
    expect(() => store.write('new', sample('新项目'))).not.toThrow();
    expect(store.read('new').data.data.topic).toBe('新项目');
    store.write('new', sample('覆盖'));
    expect(store.read('new').data.data.topic).toBe('覆盖');
  });
});
