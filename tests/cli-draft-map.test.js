/* ============================================================
 * tests/cli-draft-map.test.js — `draft-map`（功能代号 `DM` · 台账 `W11`）的命令面契约
 * ------------------------------------------------------------
 * 守在**到达界面控制通道之前**的那一段（这几条失败路径一个字节都不往通道目录写）：
 *   ① `--help` 给得出用法（`--file` / `--source` / `--json` 都在）；
 *   ② 没给 `--file` ⇒ code 1 + 报用法；
 *   ③ `--file` 指向不存在的文件 ⇒ code 1 + 指名那个**解析后的绝对路径**（相对路径按 cwd 解析）；
 *   ④ 文件在、但不是合法 JSON ⇒ code 1；
 *   ⑤ 顶层不是对象（是数组）⇒ code 1；
 *   ⑥ 根节点没有 topic ⇒ code 1（草稿根必须有标题：窗口标题与并入后的新节点都靠它）。
 *
 * ⚠️ **本文件刻意不测"成功路径"**：那要求一个**真在运行**的界面，而"没有回执 = 没生效"那条语义
 * 由 `sidebar-only` / `dsh-prefill` 同一族共用（并且由冒烟域 55 在**真窗口**上端到端判）。
 * 在这里造一个假界面只会造出第二个实现，测的就不再是产品。
 * 同理：成功路径在 CI/别人机器上会因为"本机恰好开着应用"而真的弹出草稿窗、并且要等 2.5s
 * ⇒ **有副作用且慢**，不进单测。
 *
 * 为什么用 `invoke`（进程内）而不是起子进程：本机受限环境下管道 stdio 会 EPERM 假失败
 * （`docs/VERIFY.md` 的「本机受限环境注意」；`tests/cli-main.test.js` 顶部同一条纪律）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { invoke } = require('../cli/main.js');

describe('draft-map 命令面（到达控制通道之前就拒绝的几条）', () => {
  it('--help：code 0，用法里能看见 --file / --source / --json', async () => {
    const r = await invoke(['draft-map', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('draft-map');
    expect(r.stdout).toContain('--file');
    expect(r.stdout).toContain('--source');
    expect(r.stdout).toContain('--json');
    // 用法里必须说清它**不写盘**（这是本功能唯一的卖点，写漏了等于没承诺）
    expect(r.stdout).toContain('不落 projects/');
  });

  it('没给 --file ⇒ code 1，且给出用法（不是"界面没响应"这种假原因）', async () => {
    const r = await invoke(['draft-map']);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
    expect(r.stdout).toContain('用法');
    expect(r.stdout).toContain('--file');
  });

  it('--file 指向不存在的文件 ⇒ code 1 并点名**解析后的绝对路径**', async () => {
    const missing = 'no-such-draft-tree-' + Date.now() + '.json';
    const r = await invoke(['draft-map', '--file', missing]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('文件不存在');
    // 相对路径按 cwd 解析 ⇒ 报错里是绝对路径（人照着能直接去找）
    expect(r.stdout).toContain(path.resolve(missing));
  });

  it('文件在但不是合法 JSON ⇒ code 1', async () => {
    const f = path.join(os.tmpdir(), 'mm-draft-bad-' + Date.now() + '.json');
    fs.writeFileSync(f, '{ this is not json', 'utf8');
    try {
      const r = await invoke(['draft-map', '--file', f]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('不是合法 JSON');
    } finally {
      try { fs.unlinkSync(f); } catch (e) { /* 清不掉不影响结论 */ }
    }
  });

  it('顶层是数组 ⇒ code 1（草稿必须是一棵树，不是一个列表）', async () => {
    const f = path.join(os.tmpdir(), 'mm-draft-arr-' + Date.now() + '.json');
    fs.writeFileSync(f, JSON.stringify([{ topic: 'a' }, { topic: 'b' }]), 'utf8');
    try {
      const r = await invoke(['draft-map', '--file', f]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('顶层必须是一个对象');
    } finally {
      try { fs.unlinkSync(f); } catch (e) { /* 同上 */ }
    }
  });

  it('根节点没有 topic ⇒ code 1 并说明为什么必须有', async () => {
    const f = path.join(os.tmpdir(), 'mm-draft-notopic-' + Date.now() + '.json');
    fs.writeFileSync(f, JSON.stringify({ children: [{ topic: 'a' }] }), 'utf8');
    try {
      const r = await invoke(['draft-map', '--file', f]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('没有 topic');
    } finally {
      try { fs.unlinkSync(f); } catch (e) { /* 同上 */ }
    }
  });

  it('内联 JSON 也算 --file（给脚本与 AI 省一次落盘）：坏内容照样拒绝', async () => {
    const r = await invoke(['draft-map', '--file', '{"children":[{"topic":"x"}]}']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('没有 topic');
  });
});
