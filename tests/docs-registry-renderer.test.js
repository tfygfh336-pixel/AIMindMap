/* ============================================================
 * tests/docs-registry-renderer.test.js — G8 第 ⑦ 条的 `renderer/` 覆盖面（缺口 `G-16` 的第 ⑥ 处）
 * 运行：npx vitest run tests/docs-registry-renderer.test.js
 * ------------------------------------------------------------
 * 为什么单独一份（而不是塞回 `tests/docs-registry.test.js`）：
 *   2026-10-20（门禁B2）把 `renderer` 加进了 G8 ⑦ 的 `COVERED_DIRS`，并把 `scripts/collateral-check.js`
 *   里那条**临时兜底**（`ARTIFACT_BATCH` 自建的登记断言 + 封闭欠账册）删掉。
 *   删之前/之后的判别力读数在 `.review/20261020-门禁B2/proof-g8-renderer.js`（真子进程、真 exit code）；
 *   本文件是它的**常驻版** —— 一次性读数不会说话，回归得有常驻断言守（与
 *   `tests/docs-registry.test.js` 里那两条"移位不变"的常驻证明同一个理由）。
 *
 * 它守的两件事：
 *   ① **判别力两方向都动**：`renderer/` 下新文件**没进**架构文档 ⇒ 必红且**点名那个文件**；
 *      同一批登记 ⇒ 绿。只证明"会红"的话，恒红的实现也能过（`B4`）。
 *   ② **真仓读数不许退回去**：真 `renderer/*.js` 每一件都在 `docs/ARCHITECTURE.md` 里 —— 谁哪天
 *      把 §2.1 那两行删了、或把 `renderer` 从 `COVERED_DIRS` 里摘了，这条立刻红。
 *
 * 为什么只调 `checkModuleCoverage()` 而不跑 `checkRegistry()` 全量：那是**纯函数 + 可注入根**（`B6`），
 *   夹具里不必凑齐 §5 登记表 / §1.2 稳定性表 / 元信息块那一整套 —— 那些与本判定无关，
 *   凑不齐只会造与本用例无关的假红。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const checker = require('../scripts/docs-registry-check.js');
const { checkModuleCoverage } = checker;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* 夹具目录带 pid（`E5`）：并发跑不会互相删，收尾只清自己那一个。 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-g8-renderer-' + process.pid + '-'));
afterAll(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

/** 造一个最小根：只要 `docs/ARCHITECTURE.md` + 指定目录下的 .js（判定只读这两样） */
function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(HOME, 'r-'));
  Object.entries(files).forEach(([rel, body]) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  });
  return dir;
}
const ARCH = (rows) => '# 架构\n\n### 2.1 渲染层（renderer/）\n\n| 模块 | 职责 |\n|------|------|\n'
  + rows.join('');
const row = (f) => '| `' + f + '` | x |\n';
const mods = (names) => names.reduce((o, n) => Object.assign(o, { ['renderer/' + n]: "'use strict';\n" }), {});

describe('G8 ⑦ 覆盖 `renderer/`：不登记 ⇒ 红且点名', () => {
  it('★ 方向一：往 renderer/ 放一个新文件、什么都不登记 ⇒ module-cover 并点名它', () => {
    const root = makeRoot(Object.assign({ 'docs/ARCHITECTURE.md': ARCH([]) }, mods(['app-new.js'])));
    const problems = checkModuleCoverage(root);
    expect(problems.length, JSON.stringify(problems)).toBe(1);
    expect(problems[0].kind).toBe('module-cover');
    expect(problems[0].rel).toBe('renderer/app-new.js');
    // 报错即教程：报文要说清"登记到哪"（渲染层是 §2.1）
    expect(problems[0].msg).toMatch(/§2\.1/);
    expect(problems[0].msg).toMatch(/渲染层模块/);
  });

  it('★ 方向二：同一批把它登记进 §2.1 ⇒ 绿（否则"红"可能只是恒红）', () => {
    const root = makeRoot(Object.assign({ 'docs/ARCHITECTURE.md': ARCH([row('app-new.js')]) },
      mods(['app-new.js'])));
    expect(checkModuleCoverage(root)).toEqual([]);
  });

  it('判别力：登记的是**另一个**文件名（`app-new2.js`）不算数 —— 顶层口径是整串 basename', () => {
    const root = makeRoot(Object.assign({ 'docs/ARCHITECTURE.md': ARCH([row('app-new2.js')]) },
      mods(['app-new.js'])));
    expect(checkModuleCoverage(root).map((p) => p.rel)).toEqual(['renderer/app-new.js']);
  });

  it('只登记一件不够：同目录另一件仍会被点名（不是"目录级放过"）', () => {
    const root = makeRoot(Object.assign({ 'docs/ARCHITECTURE.md': ARCH([row('app-a.js')]) },
      mods(['app-a.js', 'app-b.js'])));
    expect(checkModuleCoverage(root).map((p) => p.rel)).toEqual(['renderer/app-b.js']);
  });

  it('子目录里的 renderer 文件按**完整相对路径**登记才算（换目录不能沿用顶层那条）', () => {
    const root = makeRoot(Object.assign({ 'docs/ARCHITECTURE.md': ARCH([row('helper.js')]) },
      { 'renderer/tools/helper.js': "'use strict';\n" }));
    expect(checkModuleCoverage(root).map((p) => p.rel)).toEqual(['renderer/tools/helper.js']);
  });

  it('边界（诚实标注）：`renderer/vendor/**` 不扫（它在 `SKIP_DIRS` 里 —— 第三方代码不逐份入档）', () => {
    const root = makeRoot(Object.assign({ 'docs/ARCHITECTURE.md': ARCH([]) },
      { 'renderer/vendor/jsmind.js': "'use strict';\n" }));
    expect(checkModuleCoverage(root)).toEqual([]);
  });
});

describe('G8 ⑦ 的真仓读数（防"扫描面被悄悄摘掉 / §2.1 那几行被删"）', () => {
  it('真仓 `renderer/*.js` 每一件都在 `docs/ARCHITECTURE.md` 里（现读）', () => {
    expect(checkModuleCoverage(ROOT), '真仓有 renderer 模块没进架构文档').toEqual([]);
  });

  it('真仓那 2 件历史欠账确实登记在 §2.1（不是靠别处散文蒙过判定）', () => {
    const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    // 只在 §2.1 那一段里找 —— 判定本身是全文子串匹配（已知假绿），这条把"真登记"钉在表里
    const sec = arch.slice(arch.indexOf('### 2.1'), arch.indexOf('### 2.2'));
    ['app-bindings.js', 'app-md.js'].forEach((f) => {
      expect(sec, '§2.1 渲染层模块表里缺 `' + f + '`').toContain('`' + f + '`');
    });
  });
});
