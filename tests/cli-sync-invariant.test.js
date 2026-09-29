/* ============================================================
 * tests/cli-sync-invariant.test.js — 「CLI 命令必须同步完成」的静态守卫
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 守的是什么：`cli/main.js` 的 **`invokeSync`** 是同进程内**同步**执行一条 CLI 命令的入口，
 *   `scripts/cli-integration.js` 的 144 条断言全部走它（这是把该脚本从 102 s 压到 5 s 的
 *   关键）。它能成立，只因为一条**隐式不变量**：
 *     `cli/commands/*.js` 与它们依赖的模块，命令体里**不含 await**（也没有 .then() /
 *     fs.promises / setTimeout 等异步 API）。
 *   JS 里 async 函数体在遇到第一个 await 前是**同步执行**的，所以这些 async 命令实际上
 *   同步完成、返回一个**已 resolve** 的 Promise。
 *
 * 为什么必须有这个测试：不变量一旦被破坏，`invokeSync` 会抛错（不会静默降级），但错误发生在
 *   **运行时**、在集成测试跑到一半时。静态守卫把同样的发现提前到**改代码的当下**，
 *   并直接指出是哪个文件哪一行 —— 这就是元规则 M1 说的「做门禁」而非「写进铁律」。
 *   两道防线（静态 + 运行时）都在，且都不静默。
 *
 * 边界（诚实标注）：本测试只扫**代码**，会剥掉块注释与行注释后再匹配，避免文档里提到
 *   `await` 造成假红；但它不做真正的语法解析 —— 若把 `await` 藏进字符串字面量再 eval，
 *   它抓不到（那种写法在本工程不存在，也不该出现）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 剥掉块注释与整行行注释，避免文档里提到 await 造成假红。
 *  刻意不解析字符串字面量：那需要真语法分析，收益不抵复杂度（见文件头「边界」）。 */
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

/** 从入口集合出发，沿 `require('相对路径')` 收集依赖闭包（工程内文件）。 */
function collectFiles(entries) {
  const seen = new Set();
  const queue = entries.slice();
  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const target = path.resolve(path.dirname(abs), m[1]);
      for (const cand of [target, target + '.js', path.join(target, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { queue.push(cand); break; }
      }
    }
  }
  return [...seen];
}

const ENTRIES = [
  ...fs.readdirSync(path.join(ROOT, 'cli', 'commands')).map((f) => path.join(ROOT, 'cli', 'commands', f)),
  path.join(ROOT, 'cli', 'core.js'),
  path.join(ROOT, 'cli', 'registry.js')
];

/** 会被判红的异步信号。`await` 用词边界匹配，避免匹配到 `awaited` 之类的标识符。 */
const FORBIDDEN = [
  { re: /(?<![\w.$])await\s/, label: 'await' },
  { re: /\.then\s*\(/, label: '.then()' },
  { re: /fs\.promises/, label: 'fs.promises' },
  { re: /(?<![\w.$])setTimeout\s*\(/, label: 'setTimeout()' },
  { re: /process\.nextTick\s*\(/, label: 'process.nextTick()' }
];

describe('CLI 同步不变量（invokeSync 的前提）', () => {
  const files = collectFiles(ENTRIES);

  it('依赖闭包确实非空（守卫本身有效）', () => {
    // 若这条失败，后面的"无违规"就是假绿 —— 守卫先证明自己扫到了东西
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith(path.join('cli', 'commands', 'project.js')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('src', 'data-store.js')))).toBe(true);
  });

  it('命令体与其依赖闭包内不含任何异步 API', () => {
    const violations = [];
    for (const abs of files) {
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      code.split('\n').forEach((line, i) => {
        for (const { re, label } of FORBIDDEN) {
          if (re.test(line)) {
            violations.push(path.relative(ROOT, abs) + ':' + (i + 1) + ' 出现 ' + label + ' → ' + line.trim());
          }
        }
      });
    }
    // 失败信息要能直接指出改哪儿；同时给出修正方向
    expect(violations, 'CLI 命令必须保持同步完成（cli/main.js invokeSync 依赖它）。\n'
      + '若确实需要异步，请把调用方改为 await cli/main.js 的 invoke()，不要动这条不变量。\n'
      + violations.join('\n')).toEqual([]);
  });
});
