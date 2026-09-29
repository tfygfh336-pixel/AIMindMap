/* ============================================================
 * tests/cli-main.test.js — cli/main.js 的 invoke() 契约（vitest，ESM 语法）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 守的不变量（改 cli/main.js 或 cli/mm-cli.js 时必须仍然成立）：
 *   1. 返回 `{ code, stdout, stderr }`；失败时 stdout 以 `error: ` 开头（失败契约）；
 *   2. **不调用 process.exit** —— 否则连带杀死宿主（MCP / Electron 主进程 / 测试进程）；
 *   3. **process.exitCode 必须隔离** —— 上一次调用置的 1 不得污染下一次。
 *      这条不是洁癖：工程有过"真值算不出来就跳过、却照样报通过"的先例
 *      （见 docs/RULES.md §2 关于 G6 的记述），全局态泄漏属于同一类静默失真；
 *   4. **stream 必须复原** —— invoke 之后 process.stdout.write 还得是原来那个函数。
 *
 * 注意：这些断言**不起子进程** —— 受限环境（企业 EDR / 沙箱）下管道 stdio 会
 *       EPERM 假失败（见 docs/VERIFY.md「本机受限环境注意」）。跨进程的**逐字节等价**
 *       由两处覆盖：`scripts/cli-integration.js`（140 条，经 spawnSync 调新入口）
 *       与 `.review/20260925-cli进程内改造/equiv-check.js`（22 条只读路径字节比对）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { invoke, invokeSync, usage } = require('../cli/main.js');

describe('cli/main.js invoke()', () => {
  it('--help：code 0，stdout 是使用说明，stderr 为空', async () => {
    const r = await invoke(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('AI MindMap CLI v')).toBe(true);
    expect(r.stdout).toContain('命令:');
    expect(r.stderr).toBe('');
  });

  it('无参数等价于 --help（同一渲染点）', async () => {
    const a = await invoke([]);
    const b = await invoke(['--help']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('usage() 与 invoke(["--help"]) 输出一致 —— 防止两处各渲染一份', async () => {
    const r = await invoke(['--help']);
    expect(r.stdout).toBe(usage() + '\n');
  });

  it('未知命令：code 1 且 stdout 以 error: 开头（失败契约）', async () => {
    const r = await invoke(['no-such-command-xyz']);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
  });

  it('命令内抛错被兜住：不向调用方抛出，而是转成 code 1 + error: 前缀', async () => {
    const r = await invoke(['get']); // 缺项目名 → 命令内 throw
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
  });

  it('process.exitCode 隔离：前一次失败不污染后一次成功', async () => {
    const before = process.exitCode;
    const bad = await invoke(['no-such-command-xyz']);
    expect(bad.code).toBe(1);
    const good = await invoke(['--help']);
    expect(good.code).toBe(0); // ← 若 exitCode 未隔离，这里会读到上一次的残留
    expect(process.exitCode).toBe(before); // 也不得改动调用方自己的 exitCode
  });

  it('连续多次调用互不影响（重复调用同一命令结果稳定）', async () => {
    const first = await invoke(['--help']);
    await invoke(['no-such-command-xyz']);
    const again = await invoke(['--help']);
    expect(again.code).toBe(first.code);
    expect(again.stdout).toBe(first.stdout);
  });

  it('stdout / stderr 的 write 在调用后被复原', async () => {
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    await invoke(['--help']);
    expect(process.stdout.write).toBe(origOut);
    expect(process.stderr.write).toBe(origErr);
  });

  it('失败路径后 stream 同样被复原（异常分支不漏 restore）', async () => {
    const origOut = process.stdout.write;
    await invoke(['get']);
    expect(process.stdout.write).toBe(origOut);
  });
});

describe('cli/main.js invokeSync()（同步入口，供直线式断言序列）', () => {
  it('同步返回结果对象（不是 Promise）—— 这是它能替换 spawnSync 的前提', () => {
    const r = invokeSync(['--help']);
    expect(r).not.toBeInstanceOf(Promise);
    expect(typeof r.code).toBe('number');
    expect(typeof r.stdout).toBe('string');
    expect(r.code).toBe(0);
  });

  it('与异步 invoke() 结果完全一致（两条入口同源）', async () => {
    const a = invokeSync(['--help']);
    const b = await invoke(['--help']);
    expect(a.code).toBe(b.code);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stderr).toBe(b.stderr);
  });

  it('失败路径同样给 code 1 + error: 前缀', () => {
    const bad = invokeSync(['no-such-command-xyz']);
    expect(bad.code).toBe(1);
    expect(bad.stdout.startsWith('error: ')).toBe(true);
  });

  it('process.exitCode 隔离：前一次失败不污染后一次成功', () => {
    const before = process.exitCode;
    expect(invokeSync(['no-such-command-xyz']).code).toBe(1);
    expect(invokeSync(['--help']).code).toBe(0); // ← 未隔离则读到残留的 1
    expect(process.exitCode).toBe(before);
  });

  it('连续多次同步调用结果稳定', () => {
    const first = invokeSync(['--help']);
    invokeSync(['no-such-command-xyz']);
    const again = invokeSync(['--help']);
    expect(again.stdout).toBe(first.stdout);
  });
});
