/* ============================================================
 * tests/links.test.js — 链接剪枝纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * 这个模块的存在理由是可验证的事实（均已实测）：
 *   · 链接可以指向**别的项目**；对方删掉节点后，本项目的链接悬空
 *   · 悬挂链接会让 validate 判红，而 validate 是写盘闸门
 *     → 被判红的项目**所有**写操作都被挡住，界面又没有"删链接"入口
 *   所以"能剪链接"是"能从死锁里自救"的前提，本文件锁住剪枝语义。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import links from '../src/links.js';

const { targetKey, pruneLinks, allLinks, inbound } = links;

/** 造一棵小树：root → (a, b)，a 上有两条链接，b 上有一条 */
const mkTree = () => ({
  id: 'root', topic: 'R', children: [
    {
      id: 'a', topic: 'A', links: [
        { project: 'P', id: 'x', caption: '甲' },
        { project: 'Q', id: 'y' }
      ]
    },
    { id: 'b', topic: 'B', links: [{ project: 'P', id: 'z' }] }
  ]
});

describe('links.targetKey', () => {
  it('给出 项目/节点id', () => {
    expect(targetKey({ project: 'P', id: 'x' })).toBe('P/x');
  });
  it('字段缺失时返回空串（不炸）', () => {
    expect(targetKey(null)).toBe('');
    expect(targetKey({ project: 'P' })).toBe('');
  });
});

describe('links.pruneLinks', () => {
  it('按谓词删掉命中的链接，返回删除明细', () => {
    const t = mkTree();
    const r = pruneLinks(t, (l) => l.project === 'P' && l.id === 'x');
    expect(r.changed).toBe(true);
    expect(r.removed).toEqual([{ node: 'a', target: 'P/x', caption: '甲' }]);
    expect(t.children[0].links.map(targetKey)).toEqual(['Q/y']);
  });

  it('未命中的链接原样保留（含 caption）', () => {
    const t = mkTree();
    pruneLinks(t, (l) => l.id === 'x');
    expect(t.children[1].links).toEqual([{ project: 'P', id: 'z' }]);
  });

  it('删空就把 links 键去掉（不留空数组噪音）', () => {
    const t = mkTree();
    pruneLinks(t, () => true);
    expect('links' in t.children[0]).toBe(false);
    expect('links' in t.children[1]).toBe(false);
  });

  it('返回受影响的源节点 id（去重前的列表，供调用方报告）', () => {
    const t = mkTree();
    const r = pruneLinks(t, () => true);
    expect(r.nodes.sort()).toEqual(['a', 'b']);
    expect(r.removed.map((x) => x.target).sort()).toEqual(['P/x', 'P/z', 'Q/y']);
  });

  it('没有命中时 changed=false（调用方据此跳过写盘）', () => {
    const t = mkTree();
    const r = pruneLinks(t, () => false);
    expect(r.changed).toBe(false);
    expect(r.removed).toEqual([]);
    expect(allLinks(t)).toHaveLength(3);
  });

  it('谓词能拿到源节点（可只清理某个来源）', () => {
    const t = mkTree();
    const r = pruneLinks(t, (l, n) => n.id === 'b');
    expect(r.removed).toEqual([{ node: 'b', target: 'P/z' }]);
    expect(allLinks(t)).toHaveLength(2);
  });

  it('容错：空树 / 无 links / 谓词非函数都不炸', () => {
    expect(pruneLinks(null, () => true).changed).toBe(false);
    expect(pruneLinks({ id: 'root', topic: 'R' }, () => true).changed).toBe(false);
    expect(pruneLinks(mkTree()).changed).toBe(false);
  });

  it('深层节点也会被遍历到', () => {
    const t = { id: 'root', topic: 'R', children: [{ id: 'm', topic: 'M', children: [{ id: 'deep', topic: 'D', links: [{ project: 'P', id: 'x' }] }] }] };
    const r = pruneLinks(t, () => true);
    expect(r.removed).toEqual([{ node: 'deep', target: 'P/x' }]);
  });
});

describe('links.allLinks / inbound', () => {
  it('allLinks 带出源节点与链接', () => {
    const all = allLinks(mkTree());
    expect(all).toHaveLength(3);
    expect(all[0].node).toBe('a');
    expect(all[0].link.project).toBe('P');
  });

  it('inbound 只取指向指定目标且项目一致的链接', () => {
    const t = mkTree();
    expect(inbound(t, 'P', 'x').map((x) => x.node)).toEqual(['a']);
    // 项目不同则不算（同 id 跨项目必须区分开）
    expect(inbound(t, 'Q', 'x')).toEqual([]);
    expect(inbound(t, 'P', 'nope')).toEqual([]);
  });
});
