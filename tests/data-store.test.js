/* ============================================================
 * tests/data-store.test.js — 项目存取层单元测试（vitest）
 * ------------------------------------------------------------
 * 覆盖（本工程两次文件系统事故后的数据安全底线）：
 *   - write → read 往返（落点 projects/<n>/<n>.json）
 *   - **写入中途失败时目标文件保持完整**（原子写的真正保证；对旧的裸
 *     writeFileSync 实现会失败 —— 这是本文件唯一具备鉴别力的原子性断言）
 *   - 校验闸门在写盘之前生效（失败时不触碰磁盘、不留 .tmp）
 *   - 正常写入不残留临时文件
 *   - read / list 容忍 UTF-8 BOM
 *   - list 只列「目录内存在同名 json」的项目
 *   - assetDir / attachmentDir 自动创建
 *   - writeFileAtomic 支持二进制（import-json 解包资源用）
 *   - 非法项目名（路径穿越）被拒
 *   - **并发版本闸门**：expectVersion 过期时拒写且磁盘一字不动（见文件末段）
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';
import { createStore, versionOf, versionOfText } from '../src/data-store.js';

let root;
let store;

const sample = (topic) => ({
  meta: { name: 't', formatVersion: 2 },
  format: 'node_tree',
  data: { id: 'root', topic: topic || 'R', expanded: true, children: [] }
});

/** 目录内残留的临时文件（原子写的清理是否彻底） */
const tmpLeftovers = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')) : [];

beforeEach(() => {
  /* 每个用例一个**独立**沙箱根：建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记）。
   * ⚠️ 旧实现是"裸 mkdtemp + afterEach 删**当前值**"——只要有一个用例在体里另建目录，
   *   那个目录就没人引用、也没人删（`tests/bindings.test.js` 的病就是这个形状：当时一次漏 21 个；
 *   该文件现为 28 用例 ⇒ 一次登记 49 个目录 = 28 × `beforeEach` + 21 × 用例体内）。 */
  root = makeTmp('mm-ds-');
  store = createStore(root); // 不传 validate：本文件只测存储层本身
});

afterEach(() => {
  vi.restoreAllMocks();
  /* 收尾**不在这里**：删盘唯一入口是文件末尾的 `afterAll(cleanupAll)`（`afterEach` 只清引用）。
   * 理由：`afterEach` 只能删它看得见的那个变量，删不到"建了却没被引用"的目录 —— 那正是漏盘的形状。 */
  root = null;
});

/* 收尾**只此一处**：删掉所有登记过的沙箱根（本文件每个用例一个）。形态见 `tests/_tmp-cleanup.js`。 */
afterAll(cleanupAll);

describe('data-store', () => {
  it('write → read 往返（落点 projects/<n>/<n>.json）', () => {
    const r = store.write('demo', sample('你好'));
    expect(r.file).toBe(path.join(root, 'demo', 'demo.json'));
    expect(fs.existsSync(r.file)).toBe(true);
    expect(store.read('demo').data.data.topic).toBe('你好');
    // 落盘内容是可读 JSON（缩进 2）且与写入口径一致
    expect(JSON.parse(fs.readFileSync(r.file, 'utf8')).meta.name).toBe('t');
  });

  it('写入中途失败：目标文件保持完整、临时文件被清理（原子写核心保证）', () => {
    store.write('demo', sample('原始内容'));
    const dir = path.join(root, 'demo');
    const file = path.join(dir, 'demo.json');
    const before = fs.readFileSync(file, 'utf8');

    // 模拟「写到一半断电 / 磁盘写满 / 进程被杀」：
    // 让底层 writeFileSync 先落一半内容，再抛错。
    // 旧实现（裸 writeFileSync 直写目标文件）会在此把 demo.json 截断 → 本断言失败；
    // 新实现写的是同目录临时文件，目标文件始终未被触碰 → 通过。
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, content, opts) => {
      const half = typeof content === 'string' ? content.slice(0, Math.floor(content.length / 2)) : content;
      real.call(fs, target, half, opts);
      throw new Error('模拟写入中断（磁盘写满/进程被杀）');
    });

    expect(() => store.write('demo', sample('新数据，体量更大一些以便截断可观测'))).toThrow(/写入中断/);
    spy.mockRestore();

    expect(fs.readFileSync(file, 'utf8')).toBe(before); // 目标文件未被截断
    expect(tmpLeftovers(dir)).toEqual([]);              // 临时文件已清理
  });

  it('校验闸门在写盘之前生效：失败时不触碰磁盘、不留 .tmp', () => {
    store.write('demo', sample('原始内容'));
    const dir = path.join(root, 'demo');
    const file = path.join(dir, 'demo.json');
    const before = fs.readFileSync(file, 'utf8');

    const gate = createStore(root, () => { throw new Error('校验失败'); });
    expect(() => gate.write('demo', sample('坏数据'))).toThrow(/校验失败/);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('正常写入后不留临时文件', () => {
    store.write('demo', sample());
    const files = fs.readdirSync(path.join(root, 'demo'));
    expect(tmpLeftovers(path.join(root, 'demo'))).toEqual([]);
    expect(files).toContain('demo.json');
  });

  it('read 与 list 均容忍 UTF-8 BOM', () => {
    const dir = path.join(root, 'bom');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bom.json'), '\uFEFF' + JSON.stringify(sample('带BOM')), 'utf8');

    expect(store.read('bom').data.data.topic).toBe('带BOM');
    const item = store.list().find((p) => p.name === 'bom');
    expect(item).toBeTruthy();
    expect(item.meta).toBeTruthy(); // 修复前这里会因解析失败退化为 null
  });

  it('list 只列「目录内存在同名 json」的项目', () => {
    store.write('real', sample());
    fs.mkdirSync(path.join(root, 'no-json'), { recursive: true });
    fs.writeFileSync(path.join(root, 'loose.json'), '{}', 'utf8'); // 顶层散落文件不算项目
    expect(store.list().map((p) => p.name)).toEqual(['real']);
  });

  it('assetDir / attachmentDir 自动创建', () => {
    expect(fs.existsSync(store.assetDir('demo'))).toBe(true);
    expect(fs.existsSync(store.attachmentDir('demo'))).toBe(true);
  });

  it('writeFileAtomic 支持二进制内容（import-json 解包图片/附件用）', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const f = path.join(root, 'bin.dat');
    store.writeFileAtomic(f, buf);
    expect(Buffer.compare(fs.readFileSync(f), buf)).toBe(0);
    expect(tmpLeftovers(root)).toEqual([]);
  });

  it('非法项目名（路径穿越）被拒', () => {
    expect(() => store.read('../evil')).toThrow(/非法项目名/);
    expect(() => store.write('..\\evil', sample())).toThrow(/非法项目名/);
    expect(() => store.write('a/b', sample())).toThrow(/非法项目名/);
  });

  it('回归：裸 `..` 与 `.` 被拒（曾会写出到项目根之外）', () => {
    // 缺陷：projectDir 只挡非法字符，`path.join(root,'..')` 会落到项目根**之外**，
    // 于是 store.write('..') 在工程目录里写出 `...json`。可达路径：mm-cli init ..
    expect(() => store.write('..', sample())).toThrow(/非法项目名/);
    expect(() => store.write('.', sample())).toThrow(/非法项目名/);
    expect(() => store.read('..')).toThrow(/非法项目名/);
    // 且确认没有在 rootDir 的父目录留下文件
    const parent = path.dirname(root);
    const stray = fs.readdirSync(parent).filter((f) => /^\.\./.test(f) || f === '...json');
    expect(stray).toEqual([]);
  });

  it('空/非字符串项目名被拒', () => {
    expect(() => store.write('', sample())).toThrow(/非法项目名/);
    expect(() => store.write(null, sample())).toThrow(/非法项目名/);
    expect(() => store.write(undefined, sample())).toThrow(/非法项目名/);
  });
});

/* ============================================================
 * 并发版本闸门 —— 把「静默覆盖别人的写入」变成一次响亮失败
 * ------------------------------------------------------------
 * 防的是**已实测过**的事故类别（见 main.js project:save 顶部注释）：
 *   ① 内存里是某节点的子集时整树写回 → 删掉其他笔记（曾实测 7 篇 → 5 篇）；
 *   ② AI/CLI 在界面打开期间新写的笔记，渲染层没见过 → 写回时被抹掉。
 * assoc 已被单独打补丁（磁盘优先），**节点树没有** —— 本闸门补的就是它。
 *
 * 为什么这里必须有鉴别力强的断言：闸门在正常使用中**几乎不会触发**
 * （CLI 读与写之间只隔几毫秒，GUI 侧所有读路径都走 project:read），
 * 所以"跑一遍没事"根本不能证明它有效。必须直接构造过期版本。
 * ============================================================ */
describe('data-store 并发版本闸门', () => {
  it('read() 返回版本指纹；内容不同则指纹不同，内容相同则指纹相同', () => {
    store.write('v1', sample('A'));
    const a = store.read('v1');
    expect(typeof a.version).toBe('string');
    expect(a.version.length).toBeGreaterThan(0);
    expect(store.read('v1').version).toBe(a.version); // 未改 → 同版本
    store.write('v1', sample('B'));
    expect(store.read('v1').version).not.toBe(a.version); // 改了 → 版本变
  });

  it('内容原地改一个字段 → 指纹也变（size 可能不变，故不能用 size 代替）', () => {
    store.write('v2', sample('AAAA'));
    const before = store.read('v2').version;
    const sizeBefore = fs.statSync(path.join(root, 'v2', 'v2.json')).size;
    store.write('v2', sample('BBBB')); // 同长度、同结构，只换 4 个字符
    const sizeAfter = fs.statSync(path.join(root, 'v2', 'v2.json')).size;
    expect(sizeAfter).toBe(sizeBefore);              // 大小完全相同
    expect(store.read('v2').version).not.toBe(before); // 但指纹必须变
  });

  it('**核心断言**：expectVersion 过期 → 写入被拒，磁盘保持不动', () => {
    store.write('v3', sample('原始'));
    const stale = store.read('v3').version; // 这是"我读到的那一版"
    store.write('v3', sample('别人写的'));  // 别处先写了一次（模拟 AI/CLI）
    const onDisk = fs.readFileSync(path.join(root, 'v3', 'v3.json'), 'utf8');

    expect(() => store.write('v3', sample('我的旧数据'), { expectVersion: stale }))
      .toThrow(/并发写入冲突/);
    // 关键：冲突时**一个字都不能动**（否则等于换了个方式丢数据）
    expect(fs.readFileSync(path.join(root, 'v3', 'v3.json'), 'utf8')).toBe(onDisk);
  });

  it('expectVersion 匹配 → 正常写入（新读到的版本可以写）', () => {
    store.write('v4', sample('第一版'));
    const v = store.read('v4').version;
    store.write('v4', sample('第二版'), { expectVersion: v });
    expect(store.read('v4').data.data.topic).toBe('第二版');
  });

  it('不传 expectVersion → 行为与从前完全一致（向后兼容，命令层未读就写时不报错）', () => {
    store.write('v5', sample('甲'));
    store.write('v5', sample('乙')); // 无条件覆盖，旧行为
    expect(store.read('v5').data.data.topic).toBe('乙');
  });

  it('文件不存在时：没声称版本就放行（新建项目路径）；声称过则报「已不存在」', () => {
    // 新建项目：命令层没读过任何版本 ⇒ readVersion 为 undefined ⇒ 放行
    expect(() => store.write('v6', sample('新'))).not.toThrow();
    expect(store.read('v6').data.data.topic).toBe('新');

    // 反之：调用方声称"我读到过某一版"，但文件已不在 ⇒ 那是冲突（别处删掉了它）。
    // 不能静默新建 —— 否则"删了再被别人的旧内存写回"会静默复活血迹。
    store.write('v6b', sample('x'));
    const v = store.read('v6b').version;
    fs.rmSync(path.join(root, 'v6b'), { recursive: true, force: true });
    let msg = '';
    try { store.write('v6b', sample('y'), { expectVersion: v }); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/已不存在/);
    expect(fs.existsSync(path.join(root, 'v6b', 'v6b.json'))).toBe(false); // 也没被偷偷建出来
  });

  it('冲突错误信息可操作：含项目名与两侧版本号前缀', () => {
    store.write('v7', sample('x'));
    const stale = store.read('v7').version;
    store.write('v7', sample('y'));
    let msg = '';
    try { store.write('v7', sample('z'), { expectVersion: stale }); } catch (e) { msg = e.message; }
    expect(msg).toContain('v7');
    expect(msg).toContain(stale.slice(0, 8));
    expect(msg).toContain('请重新读取');
  });

  it('versionOf / versionOfText 对同一内容给出一致的指纹', () => {
    store.write('v8', sample('一致性'));
    const file = path.join(root, 'v8', 'v8.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(versionOf(file)).toBe(versionOfText(text));
  });
});
