/* ============================================================
 * tests/tear-snapshot.test.js —— 冒烟「撕裂快照」判据（scripts/smoke/tear-snapshot.js）
 * 运行：npx vitest run tests/tear-snapshot.test.js
 * ------------------------------------------------------------
 * 为什么要有这个文件：这条判据原先**内联在 `main.js` 里**（要 Electron 才能加载 ⇒ 从来没有单测），
 * 而它的**采样时机**恰好出过一次假红（记在 scripts/smoke/tear-snapshot.js 头注：副本侧
 * `comnet/.ui-state.json` 是应用启动后**自己写的**，晚采样就会把它读成"拷贝与真实不一致"）。
 * 抽出来之后，三件事都能被机械钉住：
 *   ① 口径（比什么）：只比 `.json`、以**副本侧**收集到的清单为准、读不出来的算"真实缺失"；
 *   ② 判别力：源在拷贝后被动过 ⇒ **必须红**（判据不是恒绿的空转件）；
 *   ③ 时机：**采样点必须在拷贝刚完成那一刻** —— 用"晚采样会误报"这一条把这个前提钉住
 *      （改前那条假红的形态，谁把调用点挪回去，谁就在这里读到为什么不行 ✗）。
 * 边界：本文件只测纯函数；`main.js` 里"调用点紧跟 cpSync"这件事由源码级接线检查兜底
 *      （见文件末尾那条 `main.js` 接线断言 —— 它读源码文本，不要 Electron）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tear = require('../scripts/smoke/tear-snapshot.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tear-'));

const REAL = path.join(WORK, 'real');
const COPY = path.join(WORK, 'copy');

/** 造一棵与真实 `projects/` 同形的树：嵌套项目目录 + 一个**点文件**（`.ui-state.json` 必须参与比对） */
function mkTree(root, tag) {
  fs.mkdirSync(path.join(root, 'comnet', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, '卖点讨论'), { recursive: true });
  fs.writeFileSync(path.join(root, 'comnet', 'comnet.json'), JSON.stringify({ tag: tag, n: 1 }), 'utf8');
  fs.writeFileSync(path.join(root, 'comnet', '.ui-state.json'),
    JSON.stringify({ schemaVersion: 1, project: 'comnet', dirty: false, uiPid: 1234 }), 'utf8');
  fs.writeFileSync(path.join(root, '卖点讨论', '卖点讨论.json'), JSON.stringify({ tag: tag }), 'utf8');
  fs.writeFileSync(path.join(root, 'comnet', 'assets', 'a.png'), Buffer.from([1, 2, 3]));
}

beforeAll(() => {
  mkTree(REAL, 'real');
  fs.cpSync(REAL, COPY, { recursive: true });
});
afterAll(() => {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
});

describe('口径：只比 .json（含点文件）、以副本清单为准、读不出来算"真实缺失"', () => {
  it('点文件 `.ui-state.json` 也在比对清单里；`.png` 不在（与 main.js 原实现同一条规则）', () => {
    const rels = tear.collectJsonFiles(COPY);
    expect(rels).toEqual(['comnet/.ui-state.json', 'comnet/comnet.json', '卖点讨论/卖点讨论.json']);
    expect(rels.some((r) => r.endsWith('.png')), '.png 不参与（图片不承载引用完整性）').toBe(false);
    expect(tear.isCompared('.ui-state.json'), '点文件要参与：它正是那次假红的主角').toBe(true);
  });

  it('递归收集的相对路径用 `/` 分隔（读数跨平台可读）', () => {
    tear.collectJsonFiles(COPY).forEach((r) => expect(r.indexOf('\\')).toBe(-1));
  });
});

describe('正向：逐字节拷贝 ⇒ 一致、无差异（判据不制造噪音）', () => {
  it('同一份内容拷出来的副本：一致 3 / 不一致 0 / 真实缺失 0', () => {
    const r = tear.compareTrees(REAL, COPY);
    expect(r).toMatchObject({ same: 3, diff: 0, only: 0 });
    expect(r.diffs).toEqual([]);
  });
});

describe('判别力：判据真的会红（不是恒绿的替代指标）', () => {
  /** 每条用例各用一份独立副本，避免互相污染 */
  function freshCopy(label) {
    const dir = path.join(WORK, label);
    fs.cpSync(REAL, dir, { recursive: true });
    return dir;
  }

  it('源在拷贝后被写过（= 撕裂快照）⇒ 不一致 1、点名那个文件、两侧指纹不同', () => {
    const dir = freshCopy('c1');
    fs.writeFileSync(path.join(dir, 'comnet', 'comnet.json'), JSON.stringify({ tag: 'source-changed', n: 2 }), 'utf8');
    const r = tear.compareTrees(dir, COPY);       // 左侧当"真实"，右侧是"拷贝那一刻"的副本
    expect(r.diff, '源变了却报 0 ⇒ 这条判据是空转件 ✗').toBe(1);
    expect(r.diffs[0].rel).toBe('comnet/comnet.json');
    expect(r.diffs[0].real).not.toBe(r.diffs[0].copy);
    expect(r.same).toBe(2);
  });

  it('副本里多出一个真实侧没有的 `.json` ⇒ "真实缺失" 1（口径与改前的 `only` 相同，不静默算作"一致"）', () => {
    const dir = freshCopy('c2');
    fs.writeFileSync(path.join(dir, 'comnet', 'extra-probe.json'), '{}', 'utf8');
    const r = tear.compareTrees(REAL, dir);
    expect(r).toMatchObject({ only: 1, diff: 0, same: 3 });
    expect(r.files, '清单以**副本侧**为准（原实现同一条）').toContain('comnet/extra-probe.json');
  });

  /* ⚠️ 这一条钉的是**改前那条假红的形态**（别删）：晚一步采样，副本自己的合法写入就会被读成
   * "与真实不一致"。它同时是"调用点必须紧跟 cpSync"这个前提的判别力证明。 */
  it('采样点偏晚（副本已被应用自己写过）⇒ 会读出"不一致" —— 改前假红的形态就在这里', () => {
    const dir = freshCopy('c3');
    // 应用启动后落下的界面状态（真实实现里 `uiPid` = 冒烟进程自己的 pid，`updatedAt` = 当时时刻）
    fs.writeFileSync(path.join(dir, 'comnet', '.ui-state.json'),
      JSON.stringify({ schemaVersion: 1, project: 'comnet', dirty: false, uiPid: 19340, updatedAt: '2026-10-12T07:37:20.967Z' }), 'utf8');
    const late = tear.compareTrees(REAL, dir);
    expect(late.diff, '晚采样会红 —— 这正是改前那条假红').toBe(1);
    expect(late.diffs[0].rel).toBe('comnet/.ui-state.json');
    // 同一份目录，只要**在副本被写之前**采（= 紧跟 cpSync 的调用点），读数就是干净的
    const fresh = path.join(WORK, 'c3-fresh');
    fs.cpSync(REAL, fresh, { recursive: true });
    expect(tear.compareTrees(REAL, fresh)).toMatchObject({ diff: 0, only: 0 });
  });
});

describe('健壮性：采不到真值不静默', () => {
  it('真实目录不存在 ⇒ 全部计成"真实缺失"（不是 0/0/0 的假绿）', () => {
    const r = tear.compareTrees(path.join(WORK, 'no-such-real'), COPY);
    expect(r).toMatchObject({ same: 0, diff: 0, only: 3 });
  });

  it('副本目录不存在 ⇒ 清单为空、读数为 0（调用点自己决定要不要报"没走拷贝路径"）', () => {
    const r = tear.compareTrees(REAL, path.join(WORK, 'no-such-copy'));
    expect(r).toMatchObject({ same: 0, diff: 0, only: 0 });
    expect(r.files).toEqual([]);
  });
});

/* ============================================================================
 * 接线（源码级，不需要 Electron）：采样点必须**紧跟 cpSync**
 * ==========================================================================
 * 判据本身正确，但若调用点挪回 runSmoke（did-finish-load + 500ms），假红就会回来 ——
 * 而纯函数单测**看不见**调用点。这条断言读 `main.js` 的文本，把"可复现证据 → 修复"这一跳钉住。 */
describe('接线：main.js 在 cpSync 之后**立刻**采样（晚一步就会重演那条假红）', () => {
  const src = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');

  it('`compareTrees(` 的调用出现在 `cpSync(` 之后，且二者之间只有一个 try 头（不许夹别的写操作）', () => {
    const cp = src.indexOf('fs.cpSync(REAL_PROJECTS_DIR, SMOKE_PROJECTS_DIR');
    const cmp = src.indexOf('compareTrees(REAL_PROJECTS_DIR, SMOKE_PROJECTS_DIR)');
    expect(cp, 'main.js 里应当还有那句 cpSync').toBeGreaterThan(-1);
    expect(cmp, 'main.js 应当调 scripts/smoke/tear-snapshot.js 的 compareTrees').toBeGreaterThan(cp);
    const between = src.slice(cp, cmp);
    // 采样点与拷贝之间不许出现任何写盘动作（那会重新制造"采的不是拷贝那一刻"的坑）
    ['writeFileSync', 'copyFileSync', 'rmSync', 'mkdirSync'].forEach((bad) => {
      expect(between.indexOf(bad), 'cpSync 与采样之间不许有 ' + bad).toBe(-1);
    });
    expect(between.split('\n').length, '两者之间不该夹着一大段代码').toBeLessThan(6);
  });

  it('采样点在 runSmoke 之前（模块加载期）发生：它不在 `async function runSmoke` 之后', () => {
    const cmp = src.indexOf('compareTrees(REAL_PROJECTS_DIR, SMOKE_PROJECTS_DIR)');
    const runSmoke = src.indexOf('async function runSmoke(win)');
    expect(runSmoke).toBeGreaterThan(-1);
    expect(cmp, '采样必须在 runSmoke 之前（否则就是改前那条假红的时机）').toBeLessThan(runSmoke);
  });
});
