/* ============================================================
 * tests/concurrency.test.js — 并发编辑的"可安全重放"核心（vitest）
 * ------------------------------------------------------------
 * 存在的唯一理由：`src/concurrency.js` 决定"并发时能不能自动合并"，而这件事
 * **猜错的方向是静默丢数据**（本工程最重的损害类别）。所以核心结论各锁一条断言：
 *
 *   - 指纹粒度：改一个节点只脏它自己；结构改动脏 `children:<父>`；assoc 按条目
 *   - **不相交 ⇒ 自动合并，且两边的改动都在**（"多路同时编辑"的正面判据）
 *   - **相交 ⇒ 指名拒绝，且盘上一字不动**（"绝不静默覆盖"的反面判据）
 *   - `replayable:false` ⇒ 冲突不重放；重放时 `fn` 抛错 ⇒ 报"并发重放失败"并保留原因
 *   - 连续被插队超上限 ⇒ 报明"连续 N 次"，盘上未变
 *   - **最后一段用真 `createStore` 跑同一场景**：证明这里的假 io 与生产语义一致
 *     （只在假对象上通过的测试等于没测）
 *
 * ⚠️ **竞争窗口怎么造**（第一版测试就栽在这里，值得留给后来者）：
 *   `withReplay` 是「读 → 改 → 写」，读发生在**写之前**。所以"先让别处写一次、再调用
 *   withReplay"**构不成竞争** —— 它自己那次 read 会读到别人的改动，于是第一次写就成功。
 *   真窗口是**「我读之后、我写之前」**。故这里的假 io 用 `interleave` 钩子，
 *   在**第一次写盘之前**插入"别人的一次写"，用真 store 的那段也用同样的手法。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  VERSION_CONFLICT, REPLAY_CONFLICT,
  changedKeys, intersection, withReplay, clone, mergeTrees, describeKeys,
  inheritAssoc, snapshotOf, conflictSnapshots, valueToText, diffRows
} from '../src/concurrency.js';
import { createStore } from '../src/data-store.js';

/** 与 src/data-store.js 的 versionOfText 同口径（sha1 前 16 位） */
const vtext = (t) => crypto.createHash('sha1').update(t, 'utf8').digest('hex').slice(0, 16);

/** 一个最小项目：root 下 x / y 两个节点，外加一条 assoc */
const proj = () => ({
  meta: { name: 't', formatVersion: 2 },
  format: 'node_tree',
  data: {
    id: 'root', topic: 'R', expanded: true,
    children: [
      { id: 'x', topic: 'X', detail: '<p>x</p>', children: [] },
      { id: 'y', topic: 'Y', children: [] }
    ]
  },
  assoc: [{ id: 'a1', title: '关系', members: [{ project: '本项目', id: 'x' }] }]
});

/**
 * 内存版 io：写前比版本的语义**照抄** src/data-store.js。
 * @param {object} initial 初始数据
 * @param {{interleave?: (data)=>data, everyWrite?: boolean}} [opts]
 *        `interleave`：在**写盘之前**把"别人的一次写"作用到盘上 —— 用来制造真实竞争窗口。
 *        `everyWrite:true` 时每次写都插一次（测"连续被插队"）。
 */
function memStore(initial, opts) {
  const o = opts || {};
  let disk = JSON.stringify(initial, null, 2);
  let used = false;
  return {
    read: () => ({ data: JSON.parse(disk), version: vtext(disk) }),
    write(data, wopts) {
      if (o.interleave && (o.everyWrite || !used)) {
        used = true;
        disk = JSON.stringify(o.interleave(JSON.parse(disk)), null, 2);
      }
      if (wopts && wopts.expectVersion !== undefined && wopts.expectVersion !== null) {
        const actual = vtext(disk);
        if (actual !== wopts.expectVersion) {
          const e = new Error('并发写入冲突（fake）');
          e.code = VERSION_CONFLICT;
          throw e;
        }
      }
      disk = JSON.stringify(data, null, 2);
    },
    _disk: () => disk
  };
}

/** 把某个节点的 topic 改掉（找不到就报错 —— 与真实命令的语义一致） */
const setTopic = (id, topic) => (data) => {
  const find = (n) => {
    if (!n) return null;
    if (n.id === id) return n;
    for (const c of n.children || []) { const r = find(c); if (r) return r; }
    return null;
  };
  const node = find(data.data);
  if (!node) throw new Error('节点不存在: ' + id);
  node.topic = topic;
  return data;
};
/** 往某个父节点下加子节点 */
const addUnder = (parentId, childId) => (data) => {
  const find = (n) => {
    if (!n) return null;
    if (n.id === parentId) return n;
    for (const c of n.children || []) { const r = find(c); if (r) return r; }
    return null;
  };
  const p = find(data.data);
  if (!p) throw new Error('父节点不存在: ' + parentId);
  p.children = (p.children || []).concat({ id: childId, topic: childId, children: [] });
  return data;
};

describe('concurrency · 指纹粒度', () => {
  it('改一个节点的字段 → 只脏它自己（别的节点与 meta/assoc 都不脏）', () => {
    const a = proj();
    const b = clone(a);
    b.data.children[0].detail = '<p>改过</p>';
    expect(Array.from(changedKeys(a, b))).toEqual(['node:x']);
  });

  it('改子节点列表（加节点）→ 脏 children:<父> 与新增节点自身', () => {
    const a = proj();
    const b = clone(a);
    b.data.children.push({ id: 'z', topic: 'Z', children: [] });
    const k = changedKeys(a, b);
    expect(k.has('children:root')).toBe(true);
    expect(k.has('node:z')).toBe(true);
    expect(k.has('node:x')).toBe(false);
  });

  it('**兄弟顺序也算改动**（树序有意义）', () => {
    const a = proj();
    const b = clone(a);
    b.data.children = [b.data.children[1], b.data.children[0]]; // x、y 换位
    expect(changedKeys(a, b).has('children:root')).toBe(true);
  });

  it('assoc 按**条目**脏，不看数组顺序', () => {
    const a = proj();
    const b = clone(a);
    b.assoc[0].title = '改过';
    expect(Array.from(changedKeys(a, b))).toEqual(['assoc:a1']);

    const c = clone(a);
    c.assoc.push({ id: 'a2', title: '新增', members: [] });
    const k = changedKeys(a, c);
    expect(k.has('assoc:a2')).toBe(true);
    expect(k.has('assoc:a1')).toBe(false);
  });

  it('改 meta → 只脏 meta', () => {
    const a = proj();
    const b = clone(a);
    b.meta.name = '改过';
    expect(Array.from(changedKeys(a, b))).toEqual(['meta']);
  });

  it('两个不同节点的改动**不相交**；同一节点则相交', () => {
    const a = proj();
    expect(intersection(changedKeys(a, setTopic('x', 'X2')(clone(a))),
      changedKeys(a, setTopic('y', 'Y2')(clone(a))))).toEqual([]);
    expect(intersection(changedKeys(a, setTopic('x', 'X2')(clone(a))),
      changedKeys(a, setTopic('x', 'X3')(clone(a))))).toEqual(['node:x']);
  });
});

describe('concurrency · withReplay', () => {
  it('无人竞争 → 一次写入，merged=false', () => {
    const io = memStore(proj());
    const r = withReplay(io, setTopic('x', 'X2'));
    expect(r.attempts).toBe(1);
    expect(r.merged).toBe(false);
    expect(JSON.parse(io._disk()).data.children[0].topic).toBe('X2');
  });

  it('**核心：不相交 ⇒ 自动合并，且两边改动都在**', () => {
    // 竞争窗口：我读之后、我第一次写之前，别人把 y 改了
    const io = memStore(proj(), { interleave: setTopic('y', 'Y-别人') });
    const r = withReplay(io, setTopic('x', 'X-我'));
    expect(r.merged).toBe(true);
    expect(r.attempts).toBe(2);

    const after = JSON.parse(io._disk());
    expect(after.data.children[0].topic).toBe('X-我');     // 我的改动在
    expect(after.data.children[1].topic).toBe('Y-别人');   // 别人的**也**在
  });

  it('**核心：相交 ⇒ 指名拒绝，且盘上一字不动**', () => {
    const theirsObj = setTopic('x', 'X-别人')(proj());       // 竞争后盘上应有的内容（确定性期望值）
    const io = memStore(proj(), { interleave: setTopic('x', 'X-别人') });
    let err = null;
    try { withReplay(io, setTopic('x', 'X-我')); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe(REPLAY_CONFLICT);
    expect(err.conflicts).toEqual(['node:x']);              // **指名**，不是"有冲突"
    expect(io._disk()).toBe(JSON.stringify(theirsObj, null, 2)); // 我们一个字节都没写
  });

  it('报错必须可行动（报错即教程）：给出"重新读取"的处置', () => {
    const io = memStore(proj(), { interleave: setTopic('x', 'X-别人') });
    let err = null;
    try { withReplay(io, setTopic('x', 'X-我')); } catch (e) { err = e; }
    expect(err.message).toContain('node:x');
    expect(err.message).toContain('重新读取');
    expect(err.message).toContain('写入已中止');
  });

  it('同一父节点下同时加子节点 ⇒ 相交（顺序会歧义），拒绝', () => {
    const io = memStore(proj(), { interleave: addUnder('root', 'z1') });
    let err = null;
    try { withReplay(io, addUnder('root', 'z2')); } catch (e) { err = e; }
    expect(err && err.code).toBe(REPLAY_CONFLICT);
    expect(err.conflicts).toEqual(['children:root']);
  });

  it('往**不同父节点**加子节点 ⇒ 不相交，自动合并', () => {
    const base = proj();
    base.data.children[0].children = [{ id: 'x1', topic: 'x1', children: [] }];
    const io = memStore(base, { interleave: addUnder('x', 'x2') });
    const r = withReplay(io, addUnder('y', 'y1'));
    expect(r.merged).toBe(true);
    const after = JSON.parse(io._disk());
    expect(after.data.children[0].children.map((c) => c.id)).toEqual(['x1', 'x2']); // 别人的在
    expect(after.data.children[1].children.map((c) => c.id)).toEqual(['y1']);       // 我的在
  });

  it('replayable:false ⇒ 冲突时**不重放**，抛原始版本冲突', () => {
    const io = memStore(proj(), { interleave: setTopic('y', 'Y2') });
    let err = null;
    try { withReplay(io, setTopic('x', 'X2'), { replayable: false }); } catch (e) { err = e; }
    expect(err && err.code).toBe(VERSION_CONFLICT);         // 不是 REPLAY_CONFLICT
  });

  it('重放时 fn 抛错（对方删了它依赖的对象）⇒ 报"并发重放失败"并保留原因', () => {
    const delX = (d) => { d.data.children = d.data.children.filter((c) => c.id !== 'x'); return d; };
    const io = memStore(proj(), { interleave: delX });
    let err = null;
    try { withReplay(io, setTopic('x', 'X2')); } catch (e) { err = e; }
    expect(err && err.code).toBe(REPLAY_CONFLICT);
    expect(err.message).toContain('并发重放失败');
    expect(String(err.cause && err.cause.message)).toContain('节点不存在');
  });

  it('连续被插队超过上限 ⇒ 报明"连续 N 次"，我们一个字节没写', () => {
    let n = 0;
    const io = memStore(proj(), {
      everyWrite: true,
      interleave: (d) => { n++; d.data.children[1].topic = 'Y' + n; return d; }
    });
    let err = null;
    try { withReplay(io, setTopic('x', 'X2'), { maxAttempts: 2 }); } catch (e) { err = e; }
    expect(err && err.code).toBe(REPLAY_CONFLICT);
    expect(err.message).toContain('连续');
    expect(JSON.parse(io._disk()).data.children[0].topic).toBe('X'); // 我的改动没落盘
  });
});

describe('concurrency · mergeTrees（GUI 侧三方合并）', () => {
  const withAssoc = () => proj();

  it('不相交 ⇒ 合并成功，两边改动都在', () => {
    const base = proj();
    const mine = addUnder('x', 'x2')(clone(base));      // 界面：往 x 下加节点
    const theirs = setTopic('y', 'Y-AI')(clone(base));  // 外部：改 y
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect(r.data.data.children[0].children.map((c) => c.id)).toEqual(['x2']);  // 我的在
    expect(r.data.data.children[1].topic).toBe('Y-AI');                        // 对方的也在
  });

  it('同一对象 ⇒ 默认拒绝，并给出**人能读的对象名**', () => {
    const base = proj();
    const mine = setTopic('x', 'X-界面')(clone(base));
    const theirs = setTopic('x', 'X-AI')(clone(base));
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(['node:x']);
    expect(r.detail.join('')).toContain('X');            // 报的是节点名，不是内部 key
  });

  it('**onConflict:"theirs" ⇒ 冲突对象取盘上版本，但非冲突对象的改动仍然保留**', () => {
    const base = proj();
    const mine0 = setTopic('x', 'X-界面')(clone(base));
    const mine = addUnder('y', 'y9')(mine0);             // 界面同时还在 y 下加了节点（与对方不冲突）
    const theirs = setTopic('x', 'X-AI')(clone(base));
    const r = mergeTrees(base, mine, theirs, { onConflict: 'theirs' });
    expect(r.ok).toBe(true);
    expect(r.data.data.children[0].topic).toBe('X-AI');                        // 冲突对象：盘上赢
    expect(r.data.data.children[1].children.map((c) => c.id)).toEqual(['y9']); // 我的其余改动保住了
    expect(r.lostOn.join('')).toContain('X');                                  // 明确告知丢了哪些
  });

  it('**渲染层载荷不含 assoc ⇒ 不能算成"把关联笔记删光了"**', () => {
    const base = withAssoc();
    const mine = setTopic('x', 'X-界面')(clone(base));
    delete mine.assoc;                                    // 真实形态：serializeTree 不产 assoc
    const theirs = setTopic('y', 'Y-AI')(clone(base));
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect((r.data.assoc || []).map((a) => a.id)).toEqual(['a1']);   // 关联仍在
  });

  it('我删掉的节点，合并后仍然不在（不会被"以对方为底"复活）', () => {
    const base = proj();
    const mine = clone(base);
    mine.data.children = mine.data.children.filter((c) => c.id !== 'y');   // 界面删了 y
    const theirs = setTopic('x', 'X-AI')(clone(base));                      // 外部只改了 x
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect(r.data.data.children.map((c) => c.id)).toEqual(['x']);            // y 没了（我的删除生效）
    expect(r.data.data.children[0].topic).toBe('X-AI');                     // x 用对方的
  });

  it('我删的节点被对方改了 ⇒ 相交，拒绝（这种必须人决定）', () => {
    const base = proj();
    const mine = clone(base);
    mine.data.children = mine.data.children.filter((c) => c.id !== 'y');
    const theirs = setTopic('y', 'Y-AI')(clone(base));
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(false);
    // 相交集合只有 `node:y` —— 对方那份**没有**动 root 的子列表，所以 `children:root` 不在交集里。
    // 这已足够拦住：我删的正是他改的那个对象。（我第一版断言多写了 children:root，是断言错、不是实现错。）
    expect(r.conflicts).toEqual(['node:y']);
  });

  it('assoc 逐条目：我改一条、对方改另一条 ⇒ 都保留', () => {
    const base = proj();
    base.assoc.push({ id: 'a2', title: '第二条', members: [] });
    const mine = clone(base); mine.assoc[0].title = '我改的';
    const theirs = clone(base); theirs.assoc[1].title = '对方改的';
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect(r.data.assoc.map((a) => a.title)).toEqual(['我改的', '对方改的']);
  });

  it('describeKeys 把内部键翻译成对象名', () => {
    const d = describeKeys(proj(), ['node:x', 'children:root', 'assoc:a1', 'meta']);
    expect(d.join(' ')).toContain('X');
    expect(d.join(' ')).toContain('子节点列表');
    expect(d.join(' ')).toContain('关系');
    expect(d.join(' ')).toContain('元信息');
  });
});

describe('concurrency · 与真实 store 对齐（假 io 不能只在自己身上通过）', () => {
  let root;
  let store;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cc-'));
    store = createStore(root);
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

  it('真 store：不相交 ⇒ 自动合并；相交 ⇒ 指名拒绝且盘上不动；写入回传新版本', () => {
    store.write('demo', proj());
    const file = path.join(root, 'demo', 'demo.json');

    // 用**真 store** 造竞争窗口：在被测那次写之前，让"另一个写者"先真写一次
    const makeIo = (otherFn) => {
      let used = false;
      return {
        read: () => store.read('demo'),
        write: (data, opts) => {
          if (otherFn && !used) {
            used = true;
            const b = store.read('demo');
            store.write('demo', otherFn(clone(b.data)), { expectVersion: b.version });
          }
          return store.write('demo', data, opts);
        }
      };
    };

    // ① 不相交：别人改 y，我改 x
    const r1 = withReplay(makeIo(setTopic('y', 'Y-别人')), setTopic('x', 'X-我'));
    expect(r1.merged).toBe(true);
    let after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.data.children[0].topic).toBe('X-我');
    expect(after.data.children[1].topic).toBe('Y-别人');

    // ② 相交：两人都改 x
    let err = null;
    try { withReplay(makeIo(setTopic('x', 'X-别人2')), setTopic('x', 'X-我2')); } catch (e) { err = e; }
    expect(err && err.code).toBe(REPLAY_CONFLICT);
    expect(err.conflicts).toEqual(['node:x']);
    after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.data.children[0].topic).toBe('X-别人2');   // 盘上是别人的那一版（我的没写进去）

    // ③ store.write 回传新版本指纹（供 ctx 在同一条命令里连续写不误报）
    const cur = store.read('demo');
    const w = store.write('demo', clone(cur.data), { expectVersion: cur.version });
    expect(w.version).toBe(vtext(fs.readFileSync(file, 'utf8')));
  });
});

/* ============================================================
 * 只读差异视图（v0.20「让 AI 的编辑看得见」）
 * ------------------------------------------------------------
 * 这一组只回答"界面上能不能**读到内容**"：
 *   · `snapshotOf` 取的是**某一方**的某个指纹键（不摊平错、不张冠李戴）；
 *   · `conflictSnapshots` 只给被点名的对象（**不许把整棵树塞过去**）；
 *   · `diffRows` 是两处面板（外部改动预览 / 冲突面板）**唯一**的行构造 ——
 *     一侧没有那个对象时如实说"这一侧没有"，截断要如实回报。
 * ⚠️ 判据**按内容写**（值/键/标记），不锁措辞：措辞会改，改措辞不该红。
 * ============================================================ */
describe('只读差异视图（snapshotOf / conflictSnapshots / diffRows）', () => {
  const base = proj();
  const mine = clone(base);
  mine.data.children[0].topic = 'X-我';                  // 我改了 x
  const theirs = clone(base);
  theirs.data.children.push({ id: 'z', topic: 'Z-别人', children: [] });   // 别人加了 z（不相交）
  const clash = clone(base);
  clash.data.children[0].topic = 'X-别人';                // 别人也改 x（相交）

  it('snapshotOf：按键取某一方的值；节点不带 children（与指纹口径同一份摊平）', () => {
    expect(snapshotOf(mine, 'node:x').topic).toBe('X-我');
    expect(snapshotOf(theirs, 'node:x').topic).toBe('X');
    expect(snapshotOf(theirs, 'node:x').children).toBeUndefined();
    expect(snapshotOf(base, 'node:不存在')).toBeUndefined();
    expect(snapshotOf(base, 'assoc:a1')).toMatchObject({ id: 'a1' });
    expect(snapshotOf(base, 'meta').name).toBe('t');
  });

  it('conflictSnapshots：只给被点名的对象（**不是**整棵树），三方各一份', () => {
    const snaps = conflictSnapshots(base, mine, theirs, ['node:x']);
    expect(Object.keys(snaps.base)).toEqual(['node:x']);
    expect(Object.keys(snaps.mine)).toEqual(['node:x']);
    expect(snaps.mine['node:x'].topic).toBe('X-我');
    expect(snaps.theirs['node:x'].topic).toBe('X');
    // 没被点名的对象一个都不出现（防"预览"变成整棵树的第二份副本）
    expect(snaps.base.data).toBeUndefined();
    expect(Object.keys(conflictSnapshots(base, mine, theirs, [])).length).toBe(3);
  });

  it('diffRows：两侧都是**内容**（不是对象名）；一侧没有该对象时如实标记', () => {
    const rows = diffRows(
      [{ label: '我的', data: mine }, { label: '盘上', data: theirs }],
      ['node:x', 'node:z']);
    const rx = rows.filter((r) => r.key === 'node:x')[0];
    expect(rx.sides.map((s) => s.label)).toEqual(['我的', '盘上']);
    expect(rx.sides[0].text).toContain('X-我');
    expect(rx.sides[1].text).toContain('"X"');
    const rz = rows.filter((r) => r.key === 'node:z')[0];
    expect(rz.sides[0].missing).toBe(true);            // 我这边没有 ⇒ 如实说
    expect(rz.sides[1].missing).toBe(false);
    expect(rz.sides[1].text).toContain('Z-别人');
    expect(rx.label.length).toBeGreaterThan(0);         // 对象名走 describeKeys（同一套）
  });

  it('diffRows：支持 `values` 表（保存冲突那条路主进程只递冲突对象，不还原整棵树）+ labels', () => {
    const snaps = conflictSnapshots(base, mine, clash, ['node:x']);
    const rows = diffRows([
      { label: '我的', values: snaps.mine },
      { label: '盘上', values: snaps.theirs },
      { label: '基线', values: snaps.base }
    ], ['node:x'], { labels: { 'node:x': '节点「X」（主进程给的名字）' } });
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe('节点「X」（主进程给的名字）');
    expect(rows[0].sides.length).toBe(3);
    expect(rows[0].sides[0].text).toContain('X-我');
    expect(rows[0].sides[1].text).toContain('X-别人');
    expect(rows[0].sides[2].text).toContain('"X"');
    // 空 values 表也不许崩（那一侧就是"没有"）
    const only = diffRows([{ label: '我的', values: {} }], ['node:x']);
    expect(only[0].sides[0].missing).toBe(true);
  });

  it('valueToText：有界 + 截断**如实回报**（静默截断 = 静默骗人）', () => {
    const long = 'x'.repeat(50);
    const t = valueToText(long, 10);
    expect(t.truncated).toBe(true);                    // 结构化事实（不靠措辞）
    expect(t.text.startsWith('x'.repeat(10))).toBe(true);   // 上限生效
    expect(t.text).toContain('50');                    // 原长如实报出（别让人以为内容就这么多）
    expect(valueToText('short', 10)).toMatchObject({ truncated: false, missing: false });
    expect(valueToText(undefined).missing).toBe(true);
  });

  it('inheritAssoc：载荷缺 assoc ⇒ 当"界面没意见"（与 mergeTrees 同一实现）', () => {
    const b = { meta: {}, format: 'node_tree', data: { id: 'root' }, assoc: [{ id: 'a1' }] };
    const m = { meta: {}, format: 'node_tree', data: { id: 'root' } };
    expect(inheritAssoc(m, b).assoc).toEqual([{ id: 'a1' }]);
    // 明确给了空数组 ⇒ 那是"界面真的没有关联笔记"，**不许**回填（否则删掉的条目会被复活）
    const z = { meta: {}, format: 'node_tree', data: { id: 'root' }, assoc: [] };
    expect(inheritAssoc(z, b).assoc).toEqual([]);
  });
});
