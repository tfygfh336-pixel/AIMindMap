/* ============================================================
 * tests/temp-run-root.test.js —— 冒烟临时目录「唯一化 + 只清自己那一个」的契约
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么要单测：这两条都是**只有并发/中断时才显形**的性质（固定名被另一个会话删掉 ⇒ 假红；
 * 收尾漏一处 ⇒ 每次全链在 `%TEMP%` 留一堆目录），平时怎么跑都是绿的 ⇒ 不写机械判据就没人守。
 * 三块：
 *   ① `planRunRoot` 的四条性质（惰性建目录 / 基名不变 / 每次唯一 / 收尾只删自己）；
 *   ② `sweepStale` 的年龄线（正在跑的那一轮绝不能被扫掉）；
 *   ③ **同模式的全仓扫描**（结构断言）：`os.tmpdir() + 字面量` 当**目录**用的写法，一处都不许再出现。
 *      —— 这条让"下一个人再写一个固定名"当场变红，而不是等并发时再当产品缺陷查一遍。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const trr = require('../scripts/smoke/temp-run-root.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 本测试自己也要"唯一化"：并发跑单测 / 上一次失败留下的目录都不该影响读数（同一条纪律） */
let uniqN = 0;
const uniq = (base) => base + '-t' + process.pid + '-' + Date.now().toString(36) + '-' + (++uniqN);

describe('planRunRoot：惰性 / 基名不变 / 每次唯一 / 只清自己', () => {
  it('**只算路径，不动盘**：域文件在冒烟启动时会被全部 require（含被 SMOKE_ONLY 过滤掉的）', () => {
    const run = trr.planRunRoot('zz-unit-trr-lazy');
    try {
      expect(run.exists(), '只造句柄不许建目录（否则"没跑的域"也会在 %TEMP% 留残留）').toBe(false);
      expect(run.under('aaa'), 'under 也不许建目录').toContain('aaa');
      expect(fs.existsSync(run.root)).toBe(false);
    } finally { run.cleanup(); }
  });

  it('`under(name)` 的**基名原样保留**（域 43/44 的项目名是从目录名推的，不能跟着变）', () => {
    const run = trr.planRunRoot('zz-unit-trr-base');
    try {
      expect(path.basename(run.under('zz-imp-lib'))).toBe('zz-imp-lib');
      expect(path.basename(run.under('zz-w12-plain'))).toBe('zz-w12-plain');
      expect(path.basename(run.under('zz-bind-ui-src'))).toBe('zz-bind-ui-src');
      // 唯一段只在**父目录**上
      expect(path.dirname(run.under('zz-imp-lib'))).toBe(run.root);
    } finally { run.cleanup(); }
  });

  it('两次调用（同一进程、同一毫秒内）⇒ 两个不同的根（否则并发还是会互删）', () => {
    const a = trr.planRunRoot(uniq('zz-unit-trr-uniq'));
    const b = trr.planRunRoot(uniq('zz-unit-trr-uniq2'));
    try {
      expect(a.root).not.toBe(b.root);
      a.reset('x'); b.reset('x');
      fs.writeFileSync(path.join(a.under('x'), 'f.txt'), 'A', 'utf8');
      expect(fs.existsSync(path.join(b.under('x'), 'f.txt')), 'B 不该看见 A 的文件').toBe(false);
      expect(fs.readdirSync(b.under('x')).length).toBe(0);
    } finally { a.cleanup(); b.cleanup(); }
  });

  it('`cleanup()` **只删自己那一个根**（同前缀的别人的目录一个都不碰），且可重复调用', () => {
    const mine = trr.planRunRoot('zz-unit-trr-clean');
    const other = trr.planRunRoot('zz-unit-trr-clean');   // 冒充"另一个会话"
    try {
      mine.reset('d');
      other.reset('d');
      fs.writeFileSync(path.join(other.under('d'), 'keep.txt'), '别人的', 'utf8');
      expect(mine.cleanup()).toBe(true);
      expect(mine.exists()).toBe(false);
      expect(fs.existsSync(other.under('d')), '别人的根必须还在').toBe(true);
      expect(fs.readFileSync(path.join(other.under('d'), 'keep.txt'), 'utf8')).toBe('别人的');
      expect(mine.cleanup(), '重复收尾不许抛').toBe(true);
    } finally { other.cleanup(); }
  });

  it('`reset` 是"建/清空"：第二次调用把上一次的文件清掉（与改动前的 rm+mkdir 同语义）', () => {
    const run = trr.planRunRoot('zz-unit-trr-reset');
    try {
      run.reset('d');
      fs.writeFileSync(path.join(run.under('d'), 'a.md'), '1', 'utf8');
      expect(fs.readdirSync(run.under('d')).length).toBe(1);
      run.reset('d');
      expect(fs.readdirSync(run.under('d')).length).toBe(0);
    } finally { run.cleanup(); }
  });
});

/* ============================================================================
 * `sweepStale` 的三件事：
 *   ① 年龄线（正在跑的那一轮绝不能被扫掉）；
 *   ② **时间基准可注入**（`nowMs`）⇒ "30 分钟"这条常量不绑定滚动运行时数据（`B1b` 的形态被拆掉）；
 *   ③ ⭐ **答案空间必须能区分三态**（`B4b`/`B4c`）：`0 个陈旧项` / `N 个已清扫` /
 *      **`清扫失败（带 error）`** —— 且"失败"那一态必须**能被判红**。
 *      改动前的缺陷（2026-10-18 实测）：`readdirSync` 抛错时 `sweepStale` 提前
 *      `return {swept:0, error}`，而断言只看 `out.swept` ⇒ "清扫整条路坏了"与"没有陈旧项"
 *      被压成**同一个 0**；同类压平还有两处：`rmSync` 失败曾计入 `kept`（"新鲜所以留着"与
 *      "删不掉所以还在"同一个数）、`statSync` 失败曾 `continue`（那个条目凭空消失）。
 *
 * ⚠️ **扫描面为什么不用真 `os.tmpdir()`**（2026-10-18 实测）：本机 `%TEMP%` 有 **28 692** 个条目
 * （还在涨），而它是**全机所有进程共用**的 ⇒ 别人的临时目录增删都落在这条判据的输入里；
 * 一次 `readdirSync` 实测 p50 ≈ 30 ms。判据要的是"清扫这三件事做对没有"，
 * 不是"同机别人的 %TEMP% 稳不稳" ⇒ 用 `os` 桩把扫描面收成**本测试自己那一个沙箱根**：
 * 真磁盘、真 mtime、真前缀，只是目录里只有我自己那三条。
 * **年龄线 / 三态 / 只删自己那一个 —— 判据一条都没放宽。**
 * "真实 `%TEMP%` 上扫得动"这一条单列在最后一个用例（环境面，允许一次**可见**重试）。
 * ========================================================================== */
describe('sweepStale：年龄线 + 时间基准注入 + **三态**（清扫失败不许压成 0）', () => {
  let SBX = '';
  const sbxOs = { tmpdir: () => SBX };
  const planSbx = (prefix, tag) => trr.planRunRoot(prefix, { os: sbxOs, tag: tag });
  const sweepSbx = (prefix, more) => trr.sweepStale(prefix, Object.assign({ os: sbxOs }, more || {}));
  /** 每条用例起手净（上一条的残留不许变成这一条的输入） */
  function resetSbx() {
    for (const n of fs.readdirSync(SBX)) fs.rmSync(path.join(SBX, n), { recursive: true, force: true });
  }
  /** 注入一只"某个方法一定抛错"的 fs（只改那一个方法，其余走真的）—— 三态的判别力就在这里 */
  function fsThatThrows(method, message, code) {
    return new Proxy(fs, {
      get(t, k) {
        if (k === method) {
          return () => { const e = new Error(message); e.code = code || 'EINJECTED'; throw e; };
        }
        return t[k];
      }
    });
  }

  beforeAll(() => { SBX = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-unit-trr-sbx-' + process.pid + '-')); });
  afterAll(() => { try { fs.rmSync(SBX, { recursive: true, force: true }); } catch (e) { /* 收尾失败不掩盖主判据 */ } });

  it('① 新鲜的不动、陈旧的清掉、别的前缀一个都不碰（`nowMs` 注入 ⇒ 与"现在几点"无关）', () => {
    resetSbx();
    const prefix = uniq('zz-unit-trr-sweep');
    const NOW = Date.now();                                   // **同一个基准**喂给"造年龄"和"判定"
    const fresh = planSbx(prefix, 'fresh');
    const stale = planSbx(prefix, 'stale');
    const alien = planSbx(uniq('zz-unit-trr-alien'), 'stale');
    try {
      fresh.reset('d'); stale.reset('d'); alien.reset('d');
      const old = NOW - 60 * 60 * 1000;                        // 1 小时前（年龄线 30 分钟）
      fs.utimesSync(fresh.root, NOW / 1000, NOW / 1000);       // ⭐ 新鲜那条的 mtime 也**钉住**
      fs.utimesSync(stale.root, old / 1000, old / 1000);
      fs.utimesSync(alien.root, old / 1000, old / 1000);
      const out = sweepSbx(prefix, { nowMs: NOW });
      /* 两个差值被钉成 0ms / 3 600 000ms，阈值 1 800 000ms ⇒ **这一轮跑 10 分钟也不会翻** */
      expect([out.ok, out.swept, out.kept, out.failed]).toEqual([true, 1, 1, 0]);
      expect(fresh.exists(), '新鲜的要留着（它可能正在跑）').toBe(true);
      expect(stale.exists()).toBe(false);
      expect(alien.exists(), '别的前缀不归它管').toBe(true);
    } finally { fresh.cleanup(); stale.cleanup(); alien.cleanup(); }
  });

  it('② 年龄线可以注入（负阈值 ⇒ 连"刚建"的也算陈旧）；mtime **显式钉住**，不靠墙钟精度', () => {
    resetSbx();
    const prefix = uniq('zz-unit-trr-sweep2');
    const run = planSbx(prefix, 'x');
    const NOW = Date.now();
    try {
      run.reset('d');
      /* ⚠️ 这里第一次写错了，实测**当场翻红 1/10**（`expected [ true, +0 ] to deeply equal [ true, 1 ]`）：
       * 原来只写 `maxAgeMs: -1` + `nowMs: Date.now()`，等于把判据押在
       * **"文件 mtime ≤ Date.now() + 1 ms"** 上 —— 而 Windows 的文件时间戳与 `Date.now()` 的
       * 计时器精度不是同一个源，mtime 可以比 `Date.now()` **大十几毫秒** ⇒ `now - mtime = -16 < -1`
       * ⇒ 刚建的那个被算成"新鲜"⇒ `swept:0`。
       * ⇒ 这正是本批要消灭的那一类（判据绑在**不受控的时钟精度**上），修法是把 mtime **也钉住**：
       *   把它的时间设到 `NOW - 1000 ms`，于是差值恒为 1000 ms ≫ 1 ms 容差。 */
      const old = NOW - 1000;
      fs.utimesSync(run.root, old / 1000, old / 1000);
      const out = sweepSbx(prefix, { maxAgeMs: -1, nowMs: NOW });   // 负年龄线 ⇒ 连"1 秒前"的也算陈旧
      expect([out.ok, out.swept, out.kept]).toEqual([true, 1, 0]);
      expect(run.exists()).toBe(false);
    } finally { run.cleanup(); }
  });

  it('③ **三态可区分**：`0 个陈旧项` / `N 个已清扫` / `清扫失败（带 error）`（失败态必须能被判红）', () => {
    resetSbx();
    const NOW = Date.now();
    /* 态①：没有陈旧项 */
    const t0 = sweepSbx(uniq('zz-unit-trr-none'), { nowMs: NOW });
    expect([t0.ok, t0.swept, t0.kept, t0.failed, t0.error], '态① 没有陈旧项')
      .toEqual([true, 0, 0, 0, '']);
    /* 态②：有一个陈旧项 ⇒ N 个已清扫 */
    const p2 = uniq('zz-unit-trr-state2');
    const r2 = planSbx(p2, 'stale');
    let t2;
    try {
      r2.reset('d');
      fs.utimesSync(r2.root, (NOW - 3600000) / 1000, (NOW - 3600000) / 1000);
      t2 = sweepSbx(p2, { nowMs: NOW });
      expect([t2.ok, t2.swept, t2.error], '态② 已清扫 1 个').toEqual([true, 1, '']);
    } finally { r2.cleanup(); }
    /* 态③：清扫这条路整个读不出来 ⇒ 必须**自己说**失败（不许只在 swept 里留个 0） */
    const t3 = trr.sweepStale(uniq('zz-unit-trr-state3'),
      { os: sbxOs, fs: fsThatThrows('readdirSync', 'EPERM: injected readdir', 'EPERM'), nowMs: NOW });
    expect(t3.ok, '态③ 清扫失败必须显式 ok:false').toBe(false);
    expect(t3.error, '失败原因要原话带出来').toContain('injected readdir');
    expect(t3.swept).toBe(0);
    /* **可区分** = 三态在"判据实际读的那几个字段"上两两不同 */
    const sig = (x) => JSON.stringify([x.ok, x.swept, x.error]);
    expect(new Set([sig(t0), sig(t2), sig(t3)]).size, '三态必须两两不同（否则答案空间又塌了）').toBe(3);
  });

  it('④ 逐条目失败**单列**（删不掉 ≤ 不许并进 kept；读不到年龄 ≤ 不许凭空消失）', () => {
    resetSbx();
    const NOW = Date.now();
    /* ④a 删不掉（EPERM/EBUSY 在 Windows 上是常态）：kept 必须是 0，失败进 failed */
    const p = uniq('zz-unit-trr-badrm');
    const run = planSbx(p, 'stale');
    try {
      run.reset('d');
      fs.utimesSync(run.root, (NOW - 3600000) / 1000, (NOW - 3600000) / 1000);
      const out = trr.sweepStale(p, { os: sbxOs, fs: fsThatThrows('rmSync', 'EBUSY: injected rm', 'EBUSY'), nowMs: NOW });
      expect(out.ok).toBe(false);
      expect(out.swept).toBe(0);
      expect(out.kept, '删不掉**不算**"新鲜所以留着"').toBe(0);
      expect(out.failed).toBe(1);
      expect(out.errors[0].op).toBe('rm');
      expect(run.exists(), '它确实还在（不粉饰）').toBe(true);
    } finally { run.cleanup(); }
    /* ④b 读不到年龄：既不进 swept 也不进 kept，**必须在 failed 里点名**（改动前是静默 continue） */
    resetSbx();
    const p2 = uniq('zz-unit-trr-badstat');
    const run2 = planSbx(p2, 'stale');
    try {
      run2.reset('d');
      const out2 = trr.sweepStale(p2, { os: sbxOs, fs: fsThatThrows('statSync', 'EPERM: injected stat', 'EPERM'), nowMs: NOW });
      expect([out2.ok, out2.swept, out2.kept, out2.failed]).toEqual([false, 0, 0, 1]);
      expect(out2.errors[0].op).toBe('stat');
    } finally { run2.cleanup(); }
  });

  it('⑤ **真实 `%TEMP%` 上扫得动**（环境面：同机负载 / 别人的临时目录都可能影响它 ⇒ 允许一次**可见**重试，不静默）', () => {
    const prefix = uniq('zz-unit-trr-real');          // 空前缀 ⇒ 一条都不该被扫到
    let out = trr.sweepStale(prefix);
    if (out.ok !== true) {
      console.warn('[sweepStale] 第 1 次在真实 %TEMP% 上失败（error=' + out.error
        + (out.errors && out.errors.length ? ' 逐条=' + JSON.stringify(out.errors) : '')
        + '）⇒ **可见重试一次**（静默重试是不许的）');
      out = trr.sweepStale(prefix);
    }
    expect(out.ok, '真实 %TEMP% 读不出来：error=' + out.error + ' 逐条=' + JSON.stringify(out.errors)).toBe(true);
    expect(out.swept).toBe(0);
  });
});

/* ============================================================================
 * 同模式的全仓扫描（结构断言）：把"固定名临时目录"这种写法**堵死在源头**。
 * 照 skill B4b 的同族纪律：① 扫描面写成共享常量；② **先剥注释**再扫；③ needle 是**字符串形态**
 * （这里要抓的就是那个字面量本身）；④ 在册豁免必须登记在**门禁侧**（本表），被检查方自己写一行不算。
 * ========================================================================== */
const SCAN_DIR = path.join(ROOT, 'scripts', 'smoke');     // ① 扫描面（一处）
/** 当**文件**用的固定名是允许的（截图落盘就是有意用固定名：人眼复核要看同一个名字） */
const FILE_EXT_RE = /\.(png|jpe?g|txt|json|jsonl|log|md|pdf|bin|csv)$/i;
/** 同一表达式里带唯一化标记 ⇒ 合格 */
const UNIQUE_RE = /process\.pid|Date\.now|STAMP|mkdtemp|Math\.random|runTag|runTag\(\)|tempRunRoot\.|planRunRoot/;
const FIXED_TMP_RE = /path\.join\(\s*os\.tmpdir\(\s*\)\s*,\s*(['"`])([^'"`]+)\1\s*\)/g;
/** 门禁侧的豁免表（只减不增；每条必须写**为什么**、并在变更日志里留一笔） */
const EXEMPT = [];

/** 剥注释（②）：逐字符走，跳过字符串 / 模板串 / 正则字面量的粗判 —— 避免把注释里的示例当实现 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '"' || c === '\'' || c === '`') {
      const q = c; out += c; i++;
      while (i < n) { out += src[i]; if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 扫描一个文件（纯函数：输入 {file, src}，输出违规清单 —— 判别力证明直接喂坏源码） */
function scanSource(file, src) {
  const lines = stripComments(src).split(/\r?\n/);
  const bad = [];
  lines.forEach((line, idx) => {
    FIXED_TMP_RE.lastIndex = 0;
    let m;
    while ((m = FIXED_TMP_RE.exec(line))) {
      const name = m[2];
      if (FILE_EXT_RE.test(name)) continue;                   // 文件类：允许（截图落盘等）
      if (UNIQUE_RE.test(line)) continue;                      // 同一行带唯一化标记：允许
      const ex = EXEMPT.find((e) => e.file === file && e.name === name);
      if (ex) continue;                                        // 在册豁免（门禁侧登记）
      bad.push({ file, line: idx + 1, name, text: line.trim().slice(0, 120) });
    }
  });
  return bad;
}

describe('同模式扫描：scripts/smoke/ 里不许再有固定名的临时**目录**', () => {
  const files = fs.readdirSync(SCAN_DIR).filter((f) => f.endsWith('.js')).sort();

  it('真仓扫出来 0 条违规（扫描面现算，不写死文件数）', () => {
    expect(files.length, '扫描面不该是空的（否则这条判据在空转）').toBeGreaterThan(40);
    const all = [];
    files.forEach((f) => all.push(...scanSource(f, fs.readFileSync(path.join(SCAN_DIR, f), 'utf8'))));
    expect(all.map((b) => b.file + ':' + b.line + ' ' + b.name)).toEqual([]);
  });

  it('**判别力**：注入一条固定名目录 ⇒ 必红（这就是本批要堵死的那种写法）', () => {
    const bad = scanSource('scripts/smoke/99-injected.js',
      "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\n"
      + "const SRC_DIR = path.join(os.tmpdir(), 'zz-bind-ui-src');\n"
      + "fs.rmSync(SRC_DIR, { recursive: true, force: true });\n");
    expect(bad.length).toBe(1);
    expect(bad[0].name).toBe('zz-bind-ui-src');
    expect(bad[0].line).toBe(4);
  });

  it('判别力之二：加一个唯一段（父目录带 pid/时刻）⇒ 同一写法就合格了', () => {
    const good = scanSource('scripts/smoke/99-injected.js',
      "const SRC_DIR = path.join(os.tmpdir(), 'zz-bind-ui-src-' + process.pid + '-' + Date.now());\n");
    expect(good).toEqual([]);
  });

  it('判别力之三：**文件**类固定名（截图落盘）不算违规 —— 但要认出它是文件', () => {
    expect(scanSource('x.js', "const f = path.join(os.tmpdir(), 'mm-ui-5-sidebar.png');\n")).toEqual([]);
    expect(scanSource('x.js', "const f = path.join(os.tmpdir(), 'mm-ui-5-sidebar');\n").length).toBe(1);
  });

  it('剥注释生效：注释里那句示例调用**不是实现**（B4b 的实测教训）', () => {
    const src = "// 反例：const d = path.join(os.tmpdir(), 'zz-fixed-dir');\n"
      + "/* 也别写成 path.join(os.tmpdir(), 'zz-fixed-dir2') */\n"
      + "const ok = 1;\n";
    expect(scanSource('x.js', src)).toEqual([]);
  });
});
