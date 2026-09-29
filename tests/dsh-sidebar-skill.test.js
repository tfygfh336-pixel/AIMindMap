import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const skill = require('../src/dsh-sidebar-skill.js');

describe('buildSidebarSkillContent（侧栏 AI 指针 skill）', () => {
  const root = 'C:\\fake\\ai-mind-map';
  const built = skill.buildSidebarSkillContent(root);

  it('目录名与文件名符合 DSH skill 发现布局（skills/<name>/SKILL.md）', () => {
    expect(built.dirName).toBe('ai-mind-map');
    expect(built.fileName).toBe('SKILL.md');
  });

  it('frontmatter 含 name 与 description（parseSkillFile 的硬要求）', () => {
    expect(built.content).toMatch(/^---\n/);
    expect(built.content).toContain('name: "ai-mind-map"');
    expect(built.content).toMatch(/description: "/);
  });

  it('内容指向工程真源与 CLI 绝对路径', () => {
    expect(built.content).toContain(root);
    expect(built.content).toContain(path.join(root, 'cli', 'mm-cli.js'));
  });

  it('边界写死：validate-only、禁止 verify、禁改代码（编辑/迭代分流）', () => {
    expect(built.content).toContain('validate <项目>');
    expect(built.content).toContain('不要跑 `npm run verify`');
    expect(built.content).toContain('不要改应用代码');
  });

  it('写前协调约定在内容里（**可执行**通道：ui-state CLI，不是够不到的 IPC）', () => {
    // 回归：这里曾写 `dsh-sidebar:ui-dirty` IPC —— 侧栏 view 无 preload、preload.js
    // 也没暴露给主 renderer，那是条零调用方的死通道，AI 根本调不到（R5 脱钩）。
    expect(built.content).toContain('ui-state --json');
    expect(built.content).toContain('写前协调');
    expect(built.content).not.toContain('dsh-sidebar:ui-dirty');
  });

  it('告知实时同步契约（界面自动感知磁盘变化）', () => {
    expect(built.content).toContain('自动感知磁盘变化');
  });

  it('无残留占位符', () => {
    expect(built.content).not.toMatch(/\{[/\*]|undefined|\[object/);
  });
});
