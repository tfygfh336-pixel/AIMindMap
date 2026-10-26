/* ============================================================
 * tests/export-png-single-path.test.js — 「导出导图 PNG 只有一份实现」的静态判据
 * ------------------------------------------------------------
 * 为什么要有这个文件（本工程反复栽过的坑）：同一个功能两份实现，改一处只改一边。
 * 这次就是它 —— 2026-10-26 用户原话「导出当前导图为 png 功能也有问题，**它是直接截图窗口而不是
 * 渲染导图**」：菜单项 `exportImageDialog` 与 `--export-image` 当时各写了一份
 * `expand_to_depth(999)` + `capturePage()`，两条入口一起错。
 *
 * 本文件钉的是**代码形状**（runtime 行为由冒烟域 57 在真 Chromium 里验）：
 *   ① `exportMapPng` 只有**一处**定义（唯一实现）；
 *   ② 菜单项与 `--export-image` 都**调它**，且**自己不再**展开全树/不再自己截图；
 *   ③ 全文件里服务导出的 `capturePage` 只有一处（`captureRetry`）——
 *      `runExportWindow` 那处是**整窗合成**（另一个功能：要看见原生侧栏），不在本判据的排除面之外；
 *   ④ 90 s 守卫的报文在**代码行**里恰一处（注释里提它是"文档"，不算第二份实现）。
 *
 * 判别力（改哪一处会红，逐条对应上面的判据）：
 *   · 把 `exportMapPng` 复制成第二份（如给菜单项再写一个 `exportMapPng2`）⇒ ① 红
 *   · 菜单项里重新写 `captureRetry(win)` 或 `jm.expand_to_depth(999)` ⇒ ② 红
 *   · 新增第三处 `capturePage(` ⇒ ③ 红
 *   · 把 `EXPORT-IMAGE GUARD TIMEOUT` 删掉或复制多份 ⇒ ④ 红
 * 本文件**不能**证明的：PNG 里到底有没有整棵树（那是冒烟域 57 的像素/尺寸判据）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAIN = readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/** 从 main.js 里按**花括号配对**取一个函数体（不用正则，避免被字符串里的花括号带偏）。
 *  ⚠️ 先跳过**参数表的括号**：`async function runExportImage(win, { project, out })` 的
 *  第一个 `{` 是解构参数，不是函数体 —— 上一版就取到了 `{ project, out }`（判据当场假红）。 */
function fnBody(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(MAIN);
  if (!m) return null;
  // 参数表：从 m[0] 末尾的 `(` 起按括号配对走过去
  let p = m.index + m[0].length - 1;
  let pdepth = 0;
  for (; p < MAIN.length; p++) {
    if (MAIN[p] === '(') pdepth++;
    else if (MAIN[p] === ')') {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  const i = MAIN.indexOf('{', p + 1);
  if (i < 0) return null;
  let depth = 0;
  for (let k = i; k < MAIN.length; k++) {
    const c = MAIN[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return MAIN.slice(i, k + 1);
    }
  }
  return null;
}

/** 只数**代码行**（注释里写报文名是文档，不是实现） */
function codeLines(text) {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

describe('导出导图 PNG：只有一份实现（菜单项与 --export-image 共用）', () => {
  it('① 唯一实现：exportMapPng 在全仓 main.js 里只有一处定义', () => {
    const defs = (MAIN.match(/async\s+function\s+exportMapPng\s*\(/g) || []).length;
    expect(defs).toBe(1);
    const body = fnBody('exportMapPng');
    expect(body, '找不到 exportMapPng 的函数体').toBeTruthy();
    // 它自己就是"量 + 切片 + 截图 + 拼"的唯一现场
    expect(body).toContain('exportMeasureScript');
    expect(body).toContain('captureRetry');
  });

  it('② 两个入口都调它：菜单项与 --export-image 外壳里没有各自的展开/截图', () => {
    const menu = fnBody('exportImageDialog');
    const cli = fnBody('runExportImage');
    expect(menu, '找不到 exportImageDialog 的函数体').toBeTruthy();
    expect(cli, '找不到 runExportImage 的函数体').toBeTruthy();
    expect(menu).toContain('exportMapPng');
    expect(cli).toContain('exportMapPng');
    for (const [name, body] of [['exportImageDialog', menu], ['runExportImage', cli]]) {
      expect(body, name + ' 里又自己展开了全树（应在唯一实现里）').not.toContain('expand_to_depth');
      expect(body, name + ' 里又自己截图了（应在唯一实现里）').not.toContain('captureRetry');
      expect(body, name + ' 里又自己截图了（应在唯一实现里）').not.toContain('capturePage');
    }
  });

  it('③ 服务导出的 capturePage 只有一处（captureRetry），整窗合成那处是另一个功能', () => {
    // 只看**代码行**：注释里解释"capturePage 为什么只截可视区域"是文档，不是第三个实现
    const calls = codeLines(MAIN).filter((l) => /capturePage\s*\(/.test(l)).length;
    // 两处：captureRetry（导出/冒烟共用的重试包装）与 runExportWindow（整窗合成，要看见原生侧栏）
    expect(calls, 'main.js 里 capturePage( 的调用点数量变了 —— 导出路径是不是又多了一份？').toBe(2);
    expect(fnBody('captureRetry')).toContain('capturePage');
    expect(fnBody('runExportWindow')).toContain('capturePage');
  });

  it('④ 90 s 守卫的报文仍在代码里、且恰一处（注释里提到它不算）', () => {
    const hits = codeLines(MAIN).filter((l) => l.indexOf('EXPORT-IMAGE GUARD TIMEOUT') >= 0);
    expect(hits.length).toBe(1);
    const body = fnBody('exportMapPng');
    expect(body, '守卫报文跑到唯一实现之外了').toContain('EXPORT-IMAGE GUARD TIMEOUT');
    // 离屏入口仍然"超时即退出"，菜单入口不退出（用户的进程不能被一次导出关掉）
    expect(MAIN).toMatch(/onGuardTimeout:\s*\(\)\s*=>\s*app\.exit\(1\)/);
  });
});
