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
 *       由两处覆盖：`scripts/cli-integration.js`（条数以 `docs/VERIFY.md` 的「CLI 集成断言」行为**唯一真值出口**
 *       —— 本注释**不写具体数字**：这里原先写「140 条」，而真值早已是 567，漂了 4 倍且无人发现，
 *       正是 `docs/RULES.md` 里「别在注释里写会腐的数字」那条的现场）
 *       与 `.review/20260925-cli进程内改造/equiv-check.js`（22 条只读路径字节比对，历史档，数字封存）。
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

/* ------------------------------------------------------------
 * 单短横线选项：**失败原因必须准**
 *
 * 缺陷取证（实测）：`node cli/mm-cli.js read -x` ⇒ `error: 项目不存在: -x`。
 * 退出码非 0 是响亮的，但**原因错** —— 它把 `-x` 当成了项目名，于是人和 AI 都会去查
 * "项目 -x 为什么不存在"，而真因是"这个选项写错了"。诊断方向一错，弯路就长了。
 * 这一组同时钉住**边界**（不许把正常用法判死）：
 *   · `-h` 是工程既有的短选项（`<命令> -h` 打印该命令用法，exit 0）⇒ 必须保留 ✓
 *   · 被当作**选项值**的 `-x`（`--topic -x`）是正常用法 ⇒ 不许误杀 ✓
 * ------------------------------------------------------------ */
describe('cli/main.js 单短横线选项（失败原因准确性）', () => {
  it('★ `-x` 报"不认识的选项 -x"，并给出长选项约定 —— **不再是"项目不存在: -x"**', () => {
    const r = invokeSync(['read', '-x']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('不认识的选项 -x');
    expect(r.stdout).toContain('长选项');
    // 真因必须**盖过**那个误导性的旧文案
    expect(r.stdout).not.toContain('项目不存在');
    // 出路要有：支持集与用法都得打出来（不知道能写什么时有正规入口）
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('node cli/mm-cli.js read');
  });

  it('`-v` 同样（工程里**没有** `-v` 语义 ⇒ 报不认识，而不是"版本号"或"项目不存在"）', () => {
    const r = invokeSync(['stats', '-v']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('不认识的选项 -v');
  });

  it('`-h` 的既有语义**必须保留**：`<命令> -h` 还是打该命令用法且 exit 0', () => {
    const r = invokeSync(['read', '-h']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('支持的选项');
    expect(r.stdout.startsWith('AI MindMap CLI — read')).toBe(true);
  });

  it('不误杀"以 - 开头的**值**"：`--topic -x` 是正常用法（只看位置参数，不看原始 argv）', () => {
    // 这条**不碰盘**：它在解析阶段就被拦下（缺项目名）之前先要确认没被误判成未知选项。
    // 用一个必然因别的原因失败、但绝对不会报"不认识的选项"的命令来钉住这一点。
    const r = invokeSync(['search', 'no-such-proj-xyz', '--tag', '-x']);
    expect(r.stdout).not.toContain('不认识的选项');
  });

  it('`--key=值` 是官方给出的逃生口：以 - 开头的值这样写不会被当成选项', () => {
    const { parseArgs } = require('../cli/core.js');
    expect(parseArgs(['--topic=-x']).topic).toBe('-x');
    expect(parseArgs(['--topic', '-x']).topic).toBe('-x');   // 空格形式同样吃成值
  });
});
