/* ============================================================
 * tests/bundle.test.js — aimap v1 打包格式纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * 打包格式是**对外契约**（用户靠它跨电脑迁移与备份），
 * 且 assets 的键是用户可控字符串 → 路径穿越是真实风险。
 * 原先这些规则埋在 cli/commands/project.js 里，只能靠一条端到端断言覆盖。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import bundle from '../src/bundle.js';

const ROOT = () => ({
  id: 'root', topic: '根',
  images: [{ file: 'assets/a.png', caption: 'A' }],
  files: [{ file: 'attachments/x.md', caption: 'X' }],
  children: [
    { id: 'c1', topic: '子', images: [{ file: 'assets/b.png' }, { file: 'assets/a.png' }],
      files: [{ file: 'attachments/x.md' }], children: [] }
  ]
});

describe('bundle.collectResourceRefs', () => {
  it('收集图片与附件，去重且保持深度优先顺序', () => {
    const refs = bundle.collectResourceRefs(ROOT());
    expect(refs).toEqual([
      { file: 'assets/a.png', kind: 'image' },
      { file: 'attachments/x.md', kind: 'file' },
      { file: 'assets/b.png', kind: 'image' }
    ]);
  });

  it('跳过没有 file 字段的条目', () => {
    const refs = bundle.collectResourceRefs({ id: 'r', topic: 't', images: [{ caption: '无文件' }], files: [{}] });
    expect(refs).toEqual([]);
  });

  it('空树/异常输入安全', () => {
    expect(bundle.collectResourceRefs({ id: 'r', topic: 't' })).toEqual([]);
  });
});

describe('bundle.buildBundle', () => {
  it('产出 aimapVersion 1 的单文件结构', () => {
    const data = { meta: { name: 'p' }, format: 'node_tree', data: ROOT() };
    const b = bundle.buildBundle(data, { 'assets/a.png': 'AAA' });
    expect(b.aimapVersion).toBe(1);
    expect(b.meta).toEqual({ name: 'p' });
    expect(b.format).toBe('node_tree');
    expect(b.data.id).toBe('root');
    expect(b.assets).toEqual({ 'assets/a.png': 'AAA' });
  });
  it('缺省 assets 为空对象（不是 undefined）', () => {
    const b = bundle.buildBundle({ meta: { name: 'p' }, data: ROOT() }, undefined);
    expect(b.assets).toEqual({});
  });
});

describe('bundle.parseBundle', () => {
  const good = JSON.stringify({ aimapVersion: 1, meta: { name: 'p' }, data: { id: 'root', topic: 't' } });

  it('接受合法打包文件', () => {
    const r = bundle.parseBundle(good);
    expect(r.ok).toBe(true);
    expect(r.bundle.meta.name).toBe('p');
  });

  it('容忍 UTF-8 BOM（用户用记事本另存会产生 BOM）', () => {
    const r = bundle.parseBundle('\uFEFF' + good);
    expect(r.ok).toBe(true);
  });

  it('拒绝坏 JSON 并给出可读原因', () => {
    const r = bundle.parseBundle('{"broken"');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('JSON 解析失败');
  });

  it('拒绝错误的 aimapVersion', () => {
    expect(bundle.parseBundle(JSON.stringify({ aimapVersion: 2, meta: { name: 'p' }, data: {} })).ok).toBe(false);
    expect(bundle.parseBundle(JSON.stringify({ meta: { name: 'p' }, data: {} })).ok).toBe(false);
  });

  it('拒绝缺少 meta/data（或 meta.name）的包', () => {
    expect(bundle.parseBundle(JSON.stringify({ aimapVersion: 1, data: {} })).ok).toBe(false);
    expect(bundle.parseBundle(JSON.stringify({ aimapVersion: 1, meta: {}, data: {} })).ok).toBe(false);
  });

  it('拒绝非对象内容', () => {
    expect(bundle.parseBundle('[1,2,3]').ok).toBe(false);
    expect(bundle.parseBundle('"str"').ok).toBe(false);
    expect(bundle.parseBundle('null').ok).toBe(false);
  });

  it('可直接接受已解析对象', () => {
    const r = bundle.parseBundle({ aimapVersion: 1, meta: { name: 'p' }, data: { id: 'root' } });
    expect(r.ok).toBe(true);
  });
});

describe('bundle.isSafeRelPath（路径穿越防御）', () => {
  const base = path.join(os.tmpdir(), 'mm-bundle-base');

  it('允许项目目录内部路径', () => {
    expect(bundle.isSafeRelPath(base, 'assets/a.png')).toBe(true);
    expect(bundle.isSafeRelPath(base, 'attachments/sub/x.md')).toBe(true);
  });

  it('拒绝向上穿越', () => {
    expect(bundle.isSafeRelPath(base, '../evil.txt')).toBe(false);
    expect(bundle.isSafeRelPath(base, 'assets/../../evil.txt')).toBe(false);
    expect(bundle.isSafeRelPath(base, '../../evil.txt')).toBe(false);
  });

  it('拒绝恰好等于 base 本身（无意义且随后会写目录）', () => {
    expect(bundle.isSafeRelPath(base, '.')).toBe(false);
    expect(bundle.isSafeRelPath(base, 'assets/..')).toBe(false);
  });

  it('拒绝绝对路径外泄；绝对但在 base 内则视为安全（判据是「包含关系」）', () => {
    // 判据本质是"解析后是否仍在 base 内"，而不是"是否看起来像相对路径"：
    // 写成绝对路径但落在 base 内并无危害，故接受；落在 base 外必须拒绝。
    expect(bundle.isSafeRelPath(base, path.resolve(base, 'x'))).toBe(true);
    expect(bundle.isSafeRelPath(base, path.resolve(base, '..', 'outside.txt'))).toBe(false);
  });

  it('拒绝空值', () => {
    expect(bundle.isSafeRelPath(base, '')).toBe(false);
    expect(bundle.isSafeRelPath(base, null)).toBe(false);
    expect(bundle.isSafeRelPath(base, undefined)).toBe(false);
  });
});

describe('bundle.resourceUsageCount', () => {
  it('统计每个资源被引用的次数（诊断"同一文件被多处引用"）', () => {
    const counts = bundle.resourceUsageCount(ROOT());
    expect(counts['assets/a.png']).toBe(2);
    expect(counts['assets/b.png']).toBe(1);
    expect(counts['attachments/x.md']).toBe(2);
  });
});
