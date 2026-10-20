/* ============================================================
 * tests/docs-gen-check.test.js — `docs-gen --check`（任务 `I-5`）的判据
 * ------------------------------------------------------------
 * 守的**不是**"这条命令能跑"，而是三件机不可失的事：
 *
 *   ① **写盘档与比对档共用同一个生成函数** —— 这是本批的承重条件。
 *      判据不是"两段代码碰巧输出一样"，而是**函数引用相等**（`genProducts()[0].render === renderCliDoc`）：
 *      两个方向都只调它，所以"比对用的生成器"与"写盘用的生成器"**不可能各自漂移**
 *      （一旦漂移就是第二份真值，而 `G6`/`G7` 的整个存在理由就是"一份事实只写一处"）。
 *
 *   ② **差异行号的口径**（纯函数夹具）：1 起、第一个不等处、一方结束指"下一行"。
 *      这个数会被人顺着去改文件，算错一位就把人引到无关的行上。
 *
 *   ③ **零写盘**与**可复现**：`--check` 跑前跑后 `docs/CLI.md` 的 sha256 必须相同；
 *      `--json` 两跑必须逐字节相同（键序固定、无时间戳 —— 工程 `G-11` 先例）。
 *
 * ⚠️ 本文件里"与真仓状态有关"的断言（③）**不假定树是新鲜的**：`--check` 允许 exit 1
 * （那说明生成物真的过期了，是**被测命令的正确行为**，不是本测试的失败）。它判的是
 * "**不管结论如何，一个字节都没被写**" —— 那才是本文件该钉的性质。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const releaseCmd = require('../cli/commands/release.js');
const { invokeSync } = require('../cli/main.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_MD = path.join(ROOT, 'docs', 'CLI.md');

/** 盘上那份生成物的指纹（判"一个字节都没写"的唯一判据面） */
function shaOfFile(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

describe('docs-gen 的产物表：写盘档与比对档共用同一个生成函数', () => {
  it('`docs/CLI.md` 那一项的 render **就是** `renderCliDoc`（函数引用相等，不是同名第二份实现）', () => {
    const products = releaseCmd.genProducts();
    expect(Array.isArray(products)).toBe(true);
    const entry = products.filter((p) => p.file === 'docs/CLI.md')[0];
    expect(entry).toBeTruthy();
    // ★ 本批最重要的一条：=== 比较的是**同一个函数对象**
    expect(entry.render).toBe(releaseCmd.renderCliDoc);
  });

  it('表里每一项都是可用的产物描述：file 是受管生成物路径 / render 可调且返回字符串 / 给了 fix 命令', () => {
    const products = releaseCmd.genProducts();
    expect(products.length).toBeGreaterThan(0);
    products.forEach((p) => {
      // 受管生成物一律落在 docs/ 下（工程根不许放文档 —— 门禁 G8 的判定面）
      expect(p.file).toMatch(/^docs\/[A-Za-z0-9-]+\.md$/);
      expect(typeof p.render).toBe('function');
      expect(typeof p.fix).toBe('string');
      const text = p.render();
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      // 同一次调用两次 render 必须逐字节相同（比对档靠它；不确定的生成物不能当判据）
      expect(p.render()).toBe(text);
    });
  });

  it('表里没有第二份产物在渲染 `docs/CLI.md`（同一份产物只准有一个生成器）', () => {
    const files = releaseCmd.genProducts().map((p) => p.file);
    expect(files.filter((f) => f === 'docs/CLI.md')).toHaveLength(1);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('compareText：第一处差异的行号口径', () => {
  it('逐字相同 ⇒ fresh、行号 0、两侧整行都是 null', () => {
    expect(releaseCmd.compareText('a\nb\n', 'a\nb\n'))
      .toEqual({ fresh: true, firstDiffLine: 0, diskLine: null, wantLine: null });
    // 两份空文本也算相同（split 后都是 [""]）
    expect(releaseCmd.compareText('', '').fresh).toBe(true);
  });

  it('第 N 行不同 ⇒ firstDiffLine = N（**1 起**），并把两侧整行都带出来', () => {
    const disk = 'L1\nL2\nL3\nL4';
    const want = 'L1\nL2\nX3\nL4';
    const r = releaseCmd.compareText(disk, want);
    expect(r.fresh).toBe(false);
    expect(r.firstDiffLine).toBe(3);
    expect(r.diskLine).toBe('L3');
    expect(r.wantLine).toBe('X3');
  });

  it('磁盘那份提前结束 ⇒ 指"较长的下一行"，磁盘侧为 null（报"文件结束"）', () => {
    const r = releaseCmd.compareText('L1\nL2', 'L1\nL2\nL3');
    expect(r.firstDiffLine).toBe(3);
    expect(r.diskLine).toBe(null);
    expect(r.wantLine).toBe('L3');
  });

  it('重算那份提前结束（磁盘多出尾巴）⇒ 同样指下一行，重算侧为 null', () => {
    const r = releaseCmd.compareText('L1\nL2\nL3', 'L1\nL2');
    expect(r.firstDiffLine).toBe(3);
    expect(r.diskLine).toBe('L3');
    expect(r.wantLine).toBe(null);
  });

  it('换行风格差异**算差异**（CRLF vs LF 在第 1 行就不同 —— 比对的是字节同一性，不做归一）', () => {
    const r = releaseCmd.compareText('L1\r\nL2', 'L1\nL2');
    expect(r.fresh).toBe(false);
    expect(r.firstDiffLine).toBe(1);
  });
});

describe('evaluateProduct：三档状态（fresh / stale / missing）', () => {
  const product = { file: 'docs/CLI.md', fix: 'node cli/mm-cli.js docs-gen' };

  it('一致 ⇒ fresh，且两侧 sha256 相同、行数/体量都量出来', () => {
    const row = releaseCmd.evaluateProduct(product, 'a\nb', 'a\nb');
    expect(row.status).toBe('fresh');
    expect(row.firstDiffLine).toBe(0);
    expect(row.diskSha256).toBe(row.wantSha256);
    expect(row.diskLines).toBe(2);
    expect(row.diskBytes).toBe(3);
    expect(row.fix).toBe(product.fix);
  });

  it('不一致 ⇒ stale，行号与两侧整行都在（截断到 100 字，与 G6 的报错同一上限）', () => {
    const row = releaseCmd.evaluateProduct(product, 'a\nB', 'a\nb');
    expect(row.status).toBe('stale');
    expect(row.firstDiffLine).toBe(2);
    expect(row.diskLine).toBe('B');
    expect(row.wantLine).toBe('b');
    expect(row.diskSha256).not.toBe(row.wantSha256);
  });

  it('盘上没有这份产物 ⇒ missing（**不**把"没找到"读成"没问题"），`--json` 里 sha256 为 null', () => {
    const row = releaseCmd.evaluateProduct(product, null, 'a\nb');
    expect(row.status).toBe('missing');
    expect(row.firstDiffLine).toBe(0);
    expect(row.diskSha256).toBe(null);
    expect(row.wantSha256).toHaveLength(64);
  });

  it('键序固定（`--json` 两跑逐字节相同靠它）：前 12 个键的名称与顺序都是契约', () => {
    const row = releaseCmd.evaluateProduct(product, 'a\nb', 'a\nb');
    expect(Object.keys(row).slice(0, 12)).toEqual([
      'file', 'status', 'firstDiffLine', 'diskLines', 'diskBytes', 'diskSha256',
      'wantLines', 'wantBytes', 'wantSha256', 'diskLine', 'wantLine', 'fix'
    ]);
  });
});

describe('docs-gen --check：零写盘 + 可复现（进程内调用，真仓）', () => {
  it('`--check` 一个字节都不写：跑前跑后 `docs/CLI.md` 的 sha256 相同（不管判定结果是 0 还是 1）', () => {
    const before = shaOfFile(CLI_MD);
    const r = invokeSync(['docs-gen', '--check']);
    const after = shaOfFile(CLI_MD);
    expect(after).toBe(before);
    // 判定本身：干净树 = 0；过期 = 1 且必须以 `error:` 开头（失败契约）。
    // 两者都是**正确行为** —— 本测试判的是"无论哪个结论，盘都没被动过"。
    expect(r.code === 0 || r.code === 1).toBe(true);
    if (r.code === 0) expect(r.stdout).toContain('生成物与源一致');
    else expect(r.stdout.startsWith('error: ')).toBe(true);
  });

  it('`--check --json` 两跑逐字节相同，且键序固定 / 无时间戳（工程 `G-11` 先例）', () => {
    const a = invokeSync(['docs-gen', '--check', '--json']);
    const b = invokeSync(['docs-gen', '--check', '--json']);
    expect(a.stdout).toBe(b.stdout);
    const report = JSON.parse(a.stdout);
    expect(Object.keys(report).slice(0, 7))
      .toEqual(['command', 'mode', 'ok', 'wrote', 'productCount', 'mismatchCount', 'products']);
    expect(report.command).toBe('docs-gen');
    expect(report.mode).toBe('check');
    expect(report.wrote).toBe(false);
    // 时间戳 / 绝对路径都不许进报告（否则"两跑相同"立刻不成立）
    expect(a.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(a.stdout).not.toContain(ROOT.replace(/\\/g, '\\\\'));
    expect(report.products[0].file).toBe('docs/CLI.md');
    // ok 与 exit code 必须一致（结构化失败与非 0 退出码是同一件事的两种表达）
    expect(report.ok).toBe(a.code === 0);
  });

  it('`--check=false` ⇒ exit 1 并说清"纯开关 / 去掉开关"（照 --dry-run / --apply 的先例）', () => {
    const r = invokeSync(['docs-gen', '--check=false']);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
    expect(r.stdout).toContain('纯开关');
    expect(r.stdout).toContain('--check');
  });

  it('`--help` 列出 `--check` 与 `--json`（usage ⇄ options 自洽由 cli-options.test.js 把守，这里验可发现性）', () => {
    const r = invokeSync(['docs-gen', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--check');
    expect(r.stdout).toContain('--json');
  });
});
