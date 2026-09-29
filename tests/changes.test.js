/* ============================================================
 * tests/changes.test.js — 变更日志（阶段 3：事前避让）的判定逻辑
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * ## 这个文件为什么存在
 * `changes` 是"可见性"功能：它告诉会话"你要动的对象最近被谁碰过"。
 * 于是它**最坏的失效形态不是报错，而是安静地说"没有变更"** —— 会话会据此放心写下去，
 * 撞上并发改动，白做一轮（正是本工程最重的损害类别"静默"在可见性上的翻版）。
 * 本文件锁住三件事：
 *   ① "答不了"（锚点不在窗口内 / 没有日志）必须与"没有变更"**可分辨**；
 *   ② 条目里必须真的带**变更键**（`changedKeys` 返回 Set —— 曾因按数组处理而每次都记成空，
 *      实测踩过：日志全部显示"（无对象变化）"）；
 *   ③ 有界窗口的裁剪行为（rev 单调递增，不受裁剪影响）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const changes = require('../src/changes.js');
const concurrency = require('../src/concurrency.js');
const { createStore } = require('../src/data-store.js');

const proj = (topic) => ({
  meta: { name: 'p', formatVersion: 2 }, format: 'node_tree',
  data: { id: 'root', topic: 'R', children: [{ id: 'x', topic: topic }] }
});

describe('changes · 追加与解析', () => {
  it('rev 从 1 开始单调递增（从日志自身推导，不依赖项目文件里的字段）', () => {
    let text = '';
    const a = changes.appendLog(text, { writer: 'cli:add', changed: ['node:x'] }, 10);
    expect(a.entry.rev).toBe(1);
    const b = changes.appendLog(a.text, { writer: 'cli:edit', changed: ['node:y'] }, 10);
    expect(b.entry.rev).toBe(2);
    expect(changes.parseLog(b.text).entries.map((e) => e.rev)).toEqual([1, 2]);
  });

  it('坏行不静默丢：记下行号，且好行照常解析', () => {
    const text = changes.serializeEntry(changes.buildEntry({ rev: 1, changed: [] })) + '{坏行\n';
    const p = changes.parseLog(text);
    expect(p.entries.length).toBe(1);
    expect(p.badLines).toEqual([2]);
  });

  it('日志文本为空 / null 都不抛', () => {
    expect(changes.parseLog('').entries).toEqual([]);
    expect(changes.parseLog(null).entries).toEqual([]);
  });

  it('有界窗口：超出 max 时裁掉最老的，rev 继续递增（不重排、不回头）', () => {
    let text = '';
    for (let i = 0; i < 5; i++) text = changes.appendLog(text, { rev: undefined, changed: ['node:' + i] }, 3).text;
    const p = changes.parseLog(text);
    expect(p.entries.map((e) => e.rev)).toEqual([3, 4, 5]);   // 只留最近 3 条
  });
});

describe('changes · since：三种结局必须可分辨', () => {
  const entries = [
    changes.buildEntry({ rev: 1, changed: ['node:a'], version: 'aaaa1111' }),
    changes.buildEntry({ rev: 2, changed: ['node:b'], version: 'bbbb2222' }),
    changes.buildEntry({ rev: 3, changed: ['node:c'], version: 'cccc3333' })
  ];

  it('锚点在窗口内 ⇒ 给出其后的变更', () => {
    const r = changes.since(entries, '1');
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.changed[0])).toEqual(['node:b', 'node:c']);
  });

  it('锚点用**版本指纹**也行（前缀匹配，便于用 read/changes 给的那 16 位）', () => {
    expect(changes.since(entries, 'bbbb2222').entries.map((e) => e.rev)).toEqual([3]);
  });

  it('锚点就是最新版 ⇒ ok 且**空列表**（这才是"确实没有变更"）', () => {
    const r = changes.since(entries, '3');
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it('**锚点不在窗口内 ⇒ ok:false**（绝不能返回空列表冒充"没有变更"）', () => {
    const r = changes.since(entries, '99');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('anchor-not-found');
    expect(r.window).toEqual({ from: 1, to: 3, count: 3 });
  });

  it('**没有日志 ⇒ ok:false / no-log**（同样的道理：答不了 ≠ 没有变更）', () => {
    expect(changes.since([], '1').ok).toBe(false);
    expect(changes.since([], '1').reason).toBe('no-log');
  });

  it('不给锚点 ⇒ 全部（这是"看现状"，不是"答某个问题"）', () => {
    expect(changes.since(entries, undefined).entries.length).toBe(3);
  });
});

describe('changes · 与真实 store 联动（记账必须记到**真的变了什么**）', () => {
  it('一次真实写入后，日志里那条必须带上真实变更键 —— 不能是空数组', () => {
    const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-chg-'));
    try {
      const store = createStore(root, () => {});
      store.write('p', proj('v1'), { writer: 'cli:init' });          // 新建 ⇒ created
      const afterCreate = changes.parseLog(fs.readFileSync(store.changeLogFile('p'), 'utf8')).entries;
      expect(afterCreate.length).toBe(1);
      expect(afterCreate[0].created).toBe(true);
      expect(afterCreate[0].changed).toEqual([]);                     // 新建没有"改了什么"

      store.write('p', proj('v2'), { writer: 'cli:edit' });          // 改一个节点
      const all = changes.parseLog(fs.readFileSync(store.changeLogFile('p'), 'utf8')).entries;
      expect(all.length).toBe(2);
      expect(all[1].created).toBe(false);
      // 🔴 这条就是那个实测踩过的坑：`changedKeys` 返回 Set，按数组处理会得到空数组
      expect(all[1].changed).toContain('node:x');
      expect(all[1].changed.length).toBeGreaterThan(0);
      expect(all[1].writer).toBe('cli:edit');
      expect(all[1].version).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('用真 store 读出来的锚点能被 since 认出来（端到端一圈）', () => {
    const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-chg-'));
    try {
      const store = createStore(root, () => {});
      const v1 = store.write('p', proj('v1'), { writer: 'cli:init' }).version;
      store.write('p', proj('v2'), { writer: 'cli:edit' });
      const entries = changes.parseLog(fs.readFileSync(store.changeLogFile('p'), 'utf8')).entries;
      const r = changes.since(entries, v1);
      expect(r.ok).toBe(true);
      expect(r.entries.length).toBe(1);
      expect(r.entries[0].writer).toBe('cli:edit');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('groupByObject：按对象归并（"我要动的那个对象被谁碰过"）', () => {
    const entries = [
      changes.buildEntry({ rev: 1, writer: 'w1', changed: ['node:a', 'children:root'] }),
      changes.buildEntry({ rev: 2, writer: 'w2', changed: ['node:a'] })
    ];
    const g = changes.groupByObject(entries);
    expect(g.get('node:a').map((x) => x.writer)).toEqual(['w1', 'w2']);
    expect(g.get('children:root').length).toBe(1);
  });

  it('内存里没有它的条目时 describeKeys 回落成 id（已删节点也要能报出来）', () => {
    const d = concurrency.describeKeys(proj('v1'), ['node:gone', 'children:gone']);
    expect(d.join(' ')).toContain('gone');
  });
});
