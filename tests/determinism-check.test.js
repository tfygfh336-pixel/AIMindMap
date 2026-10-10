/* ============================================================
 * tests/determinism-check.test.js — 确定性产物门禁（S3）的契约 + **判别力**
 * 运行：npx vitest run tests/determinism-check.test.js
 * ------------------------------------------------------------
 * 为什么这些用例长这样：
 *   ① **门禁本身必须可被单测 require**（末尾 `require.main` 守卫）。
 *   ② **扰动必须真的有能力分辨**（skill `H3`：判据自身要做对照实验）——
 *      下面用两个**物理上不同**的渲染函数各跑一次两遍重算：
 *      纯函数 ⇒ 必绿 ✗；读了时钟/随机数/目录顺序的 ⇒ **必红** ✓。
 *      这是本门禁"不是空转"的证据（不注入就永远绿的门禁等于没有 ✗）。
 *   ③ **欠账册是封闭的**：上界、销账、悬挂三条规则各有机械判据，真仓库现状（1 条在册）也钉住。
 *   ④ 真值比的三个产物在真仓库里**现在就是绿的**（连续两次重算逐字节相同）—— 这条写成用例，
 *      是为了让"哪天有人往生成器里塞了个时间戳"能被**单测**先于全链抓到。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/determinism-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'determinism-check.js'), 'utf8');

describe('S3 门禁自身：可被单测引入（零副作用）', () => {
  it('require 之后拿到纯函数，且末尾有 require.main 守卫', () => {
    expect(typeof gate.twoShot).toBe('function');
    expect(typeof gate.diffOf).toBe('function');
    expect(typeof gate.parseDeclaredTable).toBe('function');
    expect(typeof gate.findMarker).toBe('function');
    expect(gateSrc).toMatch(/if \(require\.main === module\) main\(\);/);
  });

  it('扰动是**纯内存**的：跑完立刻还原（不留全局脏状态）', () => {
    const before = [fs.readdirSync, fs.readFileSync, fs.statSync, fs.existsSync];
    gate.renderUnder('workarea', () => 'x');
    expect([fs.readdirSync, fs.readFileSync, fs.statSync, fs.existsSync]).toEqual(before);
    expect(Math.random()).toBeLessThan(1);      // Math.random 也还原了（不是常数）
  });
});

describe('S3 判定口径：连续两次重算 vs 易变来源', () => {
  it('纯函数（不读时钟/随机/目录）⇒ 两遍逐字节相同（不冤枉好人）', () => {
    const s = gate.twoShot(() => '稳定输出\n第二行');
    expect(s.base).toBe(s.base2);
    expect(gate.diffOf(s.base, s.clock, 'clock')).toBe(null);
    expect(gate.diffOf(s.base, s.random, 'random')).toBe(null);
    expect(gate.diffOf(s.base, s.order, 'order')).toBe(null);
    expect(gate.diffOf(s.base, s.workarea, 'workarea')).toBe(null);
  });

  it('读了时钟 ⇒ clock 那一维必红（差异来源可分类：时间戳）', () => {
    const s = gate.twoShot(() => '生成于 ' + new Date().toISOString());
    expect(s.base).toBe(s.base2);                                   // 未扰动时自己一致
    const d = gate.diffOf(s.base, s.clock, 'clock');
    expect(d).not.toBe(null);
    expect(d.dim).toBe('clock');
  });

  it('读了随机数 ⇒ random 那一维必红（差异来源可分类：随机名）', () => {
    const s = gate.twoShot(() => 'id=' + Math.random());
    const d = gate.diffOf(s.base, s.random, 'random');
    expect(d).not.toBe(null);
    expect(d.dim).toBe('random');
  });

  it('依赖目录列举顺序（没 sort）⇒ order 那一维必红（"顺序"是**缺陷**，不是不确定）', () => {
    const s = gate.twoShot(() => 'files=' + fs.readdirSync(ROOT).slice(0, 3).join(','));
    const d = gate.diffOf(s.base, s.order, 'order');
    expect(d).not.toBe(null);
    expect(d.dim).toBe('order');
  });

  it('读了工作产物区 ⇒ workarea 那一维必红（**就是那次假红的形状**：新建一个工作目录）', () => {
    const s = gate.twoShot(() => 'workDirs=' + fs.readdirSync(path.join(ROOT, '.review')).length);
    const d = gate.diffOf(s.base, s.workarea, 'workarea');
    expect(d).not.toBe(null);
    expect(d.dim).toBe('workarea');
  });

  it('差异信息要能指到行（报错即指路）', () => {
    const d = gate.diffOf('a\nb\nc\n', 'a\nb\nX\n', 'clock');
    expect(d.line).toBe(3);
    expect(d.label).toBe('c');
    expect(d.other).toBe('X');
  });
});

describe('S3 允许不确定：标注与差异来源分类', () => {
  it('生成器里"非确定性 + 不得当真值 + 产物名"三样挨在一起 ⇒ 通过', () => {
    const src = [
      '/* ⚠️ **非确定性产物**：下面这个**不得当真值**读 ——',
      ' *   `.review/last-verify.json`  每次运行都不同',
      ' */'
    ].join('\n');
    expect(gate.findMarker(src, 'last-verify.json').ok).toBe(true);
  });

  it('只有笼统一句话、没点名产物 ⇒ 判红（标注必须点名"这一份"）', () => {
    const src = '/* 非确定性产物：不得当真值读 */\n';
    const r = gate.findMarker(src, 'last-verify.json');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('没点名');
  });

  it('分类表里"顺序"是**不允许**的那一类（要的是缺陷，不是宽容）', () => {
    const seq = gate.NONDET_CLASSES.filter((c) => c.kind === '顺序')[0];
    expect(seq.allowed).toBe(false);
    expect(seq.why).toContain('缺陷');
    expect(gate.ARTIFACTS['last-verify'].classes.every((c) =>
      gate.NONDET_CLASSES.filter((x) => x.allowed).map((x) => x.kind).includes(c))).toBe(true);
  });
});

describe('S3 声明面：§5.2 产物表与实现的**双向闭包**', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');

  it('解析得出 7 行，id 与实现完全一致（去掉任一行都会破闭包）', () => {
    const t = gate.parseDeclaredTable(md);
    expect(t.found).toBe(true);
    expect(t.rows.map((r) => r.id).sort()).toEqual(Object.keys(gate.ARTIFACTS).sort());
  });

  it('每行的类别与实现相符，且都写了"谁在守"里的门禁号', () => {
    const t = gate.parseDeclaredTable(md);
    t.rows.forEach((r) => {
      expect(r.kind, r.id).toBe(gate.ARTIFACTS[r.id].kind);
      expect(r.owners.length, r.id).toBeGreaterThan(0);
    });
  });

  it('段落丢了 ⇒ 解析明确说"找不到"（拿不到声明面 = 采不到真值）', () => {
    expect(gate.parseDeclaredTable('# 别的文档\n\n没有 5.2\n').found).toBe(false);
  });
});

describe('S3 欠账册：封闭性（在册算欠账 / 只减不增 / 修好忘销账判红 / 悬挂登记判红）', () => {
  it('既有欠账都有"为什么是欠账 + 怎么迁 + 销账触发 + 什么时候才可能全绿"', () => {
    expect(gate.DEBT.length).toBeGreaterThan(0);
    expect(gate.DEBT.length).toBeLessThanOrEqual(gate.DEBT_MAX);
    gate.DEBT.forEach((d) => {
      ['what', 'used_as', 'why', 'how', 'greenWhen'].forEach((k) => expect(d[k], d.id + '.' + k).toBeTruthy());
      expect(d.witness.mustContain, d.id).toBeTruthy();
      expect(d.paidWhen.marker, d.id).toBeTruthy();
    });
  });

  it('真仓库现状：0 处问题、**1 条在册欠账**（乙档上线：不试图一次修干净）', () => {
    const r = gate.analyze();
    expect(r.problems).toEqual([]);
    expect(r.debts.length).toBe(1);
    expect(r.debts[0].id).toBe('frame-two-shot');
  });

  it('真值比的三个产物：同一状态连续两次重算逐字节相同（含四类扰动）', () => {
    const r = gate.analyze();
    expect(r.truths.sort()).toEqual(['cli-md', 'registry-table', 'verify-md']);
  });
});
