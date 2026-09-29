/* ============================================================
 * tests/palette-rank.test.js — 命令面板排序纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * 重点锁住一个真实缺陷的回归：**空查询时命令必须可见**。
 * 原先面板打开后一个命令都看不到（节点挤满前 50 名、命令被截断），
 * 由冒烟断言发现；这里用单测固化，不需要 Electron 即可回归。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { fuzzyScore, rankPalette, DEFAULT_LIMIT } from '../src/palette-rank.js';

const NODES = [
  { kind: 'node', id: 'a', label: 'TCP 连接管理' },
  { kind: 'node', id: 'b', label: 'HTTP/HTTPS' },
  { kind: 'node', id: 'c', label: 'DNS 域名系统' }
];
const CMDS = [
  { kind: 'cmd', label: '展开全部' },
  { kind: 'cmd', label: '关系审计（孤立 / 漏链接）' }
];
const ALL = NODES.concat(CMDS);

describe('palette-rank.fuzzyScore', () => {
  it('空查询返回 0（所有项同分）', () => {
    expect(fuzzyScore('', '任意')).toBe(0);
    expect(fuzzyScore(null, '任意')).toBe(0);
  });

  it('子序列命中即算，不要求连续', () => {
    expect(fuzzyScore('tcp', 'TCP 连接管理')).not.toBeNull();
    expect(fuzzyScore('http', 'HTTP/HTTPS')).not.toBeNull();
    expect(fuzzyScore('tp', 'TCP 连接管理')).not.toBeNull();    // 跳过 c，仍是子序列
    expect(fuzzyScore('t管', 'TCP 连接管理')).not.toBeNull();   // 跨中文也算
  });

  it('不匹配返回 null（而不是负数）', () => {
    expect(fuzzyScore('zzz', 'TCP 连接管理')).toBeNull();
    expect(fuzzyScore('tcp', 'DNS')).toBeNull();
  });

  it('合法命中可以是负分 —— 故不能用 >=0 判定是否命中', () => {
    // 首字符即命中会拿 -2 的词首加分，于是"以关键词开头"的项得负分。
    // 这正是曾经把最相关结果丢掉的原因，必须锁住。
    const s = fuzzyScore('tcp', 'tcp 连接管理');
    expect(s).not.toBeNull();
    expect(s).toBeLessThan(0);
  });

  it('大小写不敏感', () => {
    expect(fuzzyScore('TCP', 'tcp 连接')).toBe(fuzzyScore('tcp', 'tcp 连接'));
  });

  it('连续命中优于跳跃命中', () => {
    expect(fuzzyScore('tcp', 'tcp 连接')).toBeLessThan(fuzzyScore('tcp', 't 连 c 接 p'));
  });

  it('词首命中优于词中命中', () => {
    expect(fuzzyScore('h', 'HTTP/HTTPS')).toBeLessThan(fuzzyScore('h', 'xHTTP'));
  });
});

describe('palette-rank.rankPalette', () => {
  it('空查询时命令排在节点之前（这是被修复的真实缺陷）', () => {
    const r = rankPalette(ALL, '', 500);
    expect(r.slice(0, 2).every((x) => x.kind === 'cmd')).toBe(true);
    expect(r.filter((x) => x.kind === 'cmd')).toHaveLength(2);
    expect(r.filter((x) => x.kind === 'node')).toHaveLength(3);
    // 首次出现节点的位置必须在所有命令之后
    expect(r.findIndex((x) => x.kind === 'node')).toBeGreaterThan(r.map((x) => x.kind).lastIndexOf('cmd'));
  });

  it('回归：默认 limit=50 时命令不被大量节点挤出（旧实现会全部丢失）', () => {
    const many = [];
    for (let i = 0; i < 200; i++) many.push({ kind: 'node', id: 'n' + i, label: '节点 ' + i });
    const r = rankPalette(many.concat(CMDS), '');
    expect(r.some((x) => x.kind === 'cmd')).toBe(true);
    expect(r.length).toBe(DEFAULT_LIMIT);
    expect(r.slice(0, CMDS.length).every((x) => x.kind === 'cmd')).toBe(true);
  });

  it('有查询时按分数升序，且最相关项排第一', () => {
    const r = rankPalette(ALL, 'TCP', 500);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].label).toContain('TCP');
  });

  it('回归：以关键词开头的节点不会被丢掉（负分也是命中）', () => {
    const entries = [
      { kind: 'node', label: 'TCP 连接管理' },   // 负分
      { kind: 'node', label: '见 TCP 一节' }     // 正分
    ];
    const r = rankPalette(entries, 'TCP');
    expect(r).toHaveLength(2);                                   // 两个都在
    expect(r[0].label).toBe('TCP 连接管理');                     // 且开头的排前面
  });

  it('有查询时过滤掉不匹配项', () => {
    const r = rankPalette(ALL, 'TCP', 500);
    expect(r.every((x) => /tcp/i.test(x.label))).toBe(true);
    expect(r.some((x) => x.label === 'DNS 域名系统')).toBe(false);
  });

  it('同分时命令优先于节点（有查询）', () => {
    const entries = [
      { kind: 'node', label: '审计' },
      { kind: 'cmd', label: '审计' }
    ];
    const r = rankPalette(entries, '审计');
    expect(r[0].kind).toBe('cmd');
  });

  it('同组内保持原顺序（稳定排序）', () => {
    const entries = [
      { kind: 'node', id: '1', label: '甲' },
      { kind: 'node', id: '2', label: '乙' },
      { kind: 'node', id: '3', label: '丙' }
    ];
    expect(rankPalette(entries, '').map((x) => x.id)).toEqual(['1', '2', '3']);
  });

  it('无匹配返回空数组', () => {
    expect(rankPalette(ALL, '绝不可能存在的字符串')).toEqual([]);
  });

  it('limit 生效；limit<=0 表示不限', () => {
    expect(rankPalette(ALL, '', 2)).toHaveLength(2);
    expect(rankPalette(ALL, '', 0)).toHaveLength(ALL.length);
    expect(rankPalette(ALL, '', -1)).toHaveLength(ALL.length);
  });

  it('空/异常输入安全', () => {
    expect(rankPalette([], '', 50)).toEqual([]);
    expect(rankPalette(null, '', 50)).toEqual([]);
    expect(rankPalette(ALL, undefined, 500).length).toBe(ALL.length);
    expect(rankPalette([{}], '', 500)).toHaveLength(1);   // 缺 label 不抛异常
  });

  it('原样透传额外字段（run 等由调用方持有）', () => {
    const run = () => 'x';
    const r = rankPalette([{ kind: 'cmd', label: '命令', run: run, extra: 1 }], '命令');
    expect(r[0].run).toBe(run);
    expect(r[0].extra).toBe(1);
  });
});
