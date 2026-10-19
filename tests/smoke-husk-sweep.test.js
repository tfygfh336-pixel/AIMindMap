/* ============================================================
 * tests/smoke-husk-sweep.test.js —— W5「`%TEMP%` 死壳清扫」的**判据本身**要被单测钉住
 * ------------------------------------------------------------
 * 为什么必须有这个文件：这段判定原先内联在 `main.js` 的 `sweepSmokeHusks()` 里，而 `main.js`
 *   **要 Electron 才能加载** ⇒ 它**从来没有单测**，于是"只调非递归 `rmdirSync` ⇒ 非空壳物理上
 *   永远删不掉"这件事**一直为绿**（现算：35 壳 / 非空 34 / 1,113 文件 / 226.6 MB）。
 *
 * 守的四件事（缺一件就退化成"看起来在守"）：
 *   ① **递归真的能删**：`idle` 档 + 非空壳 ⇒ 清掉（含嵌套子目录）。这一条同时是"改前一定删不掉"
 *      那半边的对照 —— 判别力证明的做法见 `.review/20261019-W5空壳清扫/inject-proof.js`（注入
 *      "退回非递归 `rmdirSync`" ⇒ 本文件**必红**，FAIL 原文点名"非空壳没删掉 N 个"）。
 *   ② **护栏没被删**：有活实例登记（pid 活着）时，一个 5 分钟大的非空壳**必须留着** ——
 *      它可能就是"正在跑的那一轮"。这是旧非递归当年提供的保护，现在由登记提供，**不许丢**。
 *   ③ **判不了就保守**：登记目录读不出来 / 自己的登记没建上 ⇒ 只认 3600s 年龄线。
 *   ④ **删不掉才报**：`EPERM` 与"删了还在"都必须落进 `failed` 并点名，不许静默。
 * 外加两条**结构断言**（去注释后的代码，`B4` 成因②：判据不许只活在注释里）：
 *   · 模块与 `main.js` 里不许再出现 `rmdirSync`（= W5 的病本身）；
 *   · `main.js` 的 mkdtemp 前缀、模块的 `HUSK_PREFIX`、`cli-integration.js` 的登记前缀三者关系固定。
 *
 * ⚠️ 全部在 `os.tmpdir()` 下的**沙箱目录**里跑（名字带 pid + 随机）：绝不扫真实 `%TEMP%`
 *   —— 真实读数由 `.review/20261019-W5空壳清扫/clean-real-temp.js` 那份**显式**驱动去取。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsReal from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const sweep = require(path.join(ROOT, 'scripts', 'smoke', 'husk-sweep.js'));

const HUSK = sweep.HUSK_PREFIX;                       // 'ai-mind-map-smoke-'
const MIN = 60 * 1000;

/* ---------------- 沙箱与工具 ---------------- */
let SBX; let TMPD; let LIVED;
beforeEach(() => {
  SBX = fsReal.mkdtempSync(path.join(os.tmpdir(), 'mm-husk-unit-' + process.pid + '-' + Math.random().toString(36).slice(2, 7) + '-'));
  TMPD = path.join(SBX, 'tmp');
  LIVED = path.join(SBX, 'live');
  fsReal.mkdirSync(TMPD, { recursive: true });
});
afterEach(() => {
  try { fsReal.rmSync(SBX, { recursive: true, force: true }); } catch (e) { /* 沙箱清不掉不影响判据 */ }
});

/** 造一个"死壳"：`nested` 决定里面剩什么。`ageMs` 决定 mtime 往回拨多久。 */
function seedHusk(name, opts) {
  const o = opts || {};
  const dir = path.join(TMPD, name);
  fsReal.mkdirSync(dir, { recursive: true });
  if (o.shape === 'project') {                       // 实测 34 个非空壳的主形状：整个项目副本还在
    fsReal.mkdirSync(path.join(dir, 'comnet', 'assets'), { recursive: true });
    fsReal.writeFileSync(path.join(dir, 'comnet', 'comnet.json'), '{"nodes":[1,2,3]}', 'utf8');
    fsReal.writeFileSync(path.join(dir, 'comnet', 'assets', 'a.bin'), Buffer.alloc(2048, 7));
  } else if (o.shape === 'empty-visit') {            // 实测 5 个是这个形状：只剩一个**空**子目录
    fsReal.mkdirSync(path.join(dir, '.visits'), { recursive: true });
  } else if (o.shape === 'file') {
    fsReal.writeFileSync(path.join(dir, 'x.txt'), 'hi', 'utf8');
  }
  const t = new Date(Date.now() - (o.ageMs === undefined ? 5 * MIN : o.ageMs));
  fsReal.utimesSync(dir, t, t);                      // mtime 往回拨（判定只看 mtime）
  return dir;
}

/** 造一条活实例登记（空目录锁，内容全在名字里） */
function seedClaim(name) { fsReal.mkdirSync(path.join(LIVED, name), { recursive: true }); return name; }

/** 包一层真 fs，只覆盖某个方法（比手写内存 fs 更接近真实，也不容易漏方法） */
function wrapFs(overrides) {
  const f = Object.create(fsReal);
  for (const k of Object.keys(overrides || {})) f[k] = overrides[k];
  return f;
}

const namesInTmp = () => fsReal.readdirSync(TMPD).filter((n) => n.indexOf(HUSK) === 0).sort();

/** 剥注释（`B4` 成因②：结构断言的输入必须是**代码**，不是散文） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ============================================================ */
describe('① idle 档：递归真的能删（W5 的缺口本体）', () => {
  it('★ 非空壳（整个项目副本还在）被发现即清 —— 连嵌套子目录一起走', () => {
    seedHusk(HUSK + 'PROJ', { shape: 'project', ageMs: 5 * MIN });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED });
    const left = namesInTmp();
    // ⚠️ 这条断言的报文就是判别力证明里那条 FAIL 原文（注入"退回非递归 rmdirSync" ⇒ 必红）
    expect(left, '非空壳没删掉 ' + left.length + ' 个：清后仍在 ' + JSON.stringify(left)
      + '；failed=' + JSON.stringify(out.failed)).toEqual([]);
    expect(out.swept.length).toBe(1);
    expect(out.swept[0].bytes).toBeGreaterThan(2000);        // 字节读数不是 0（清掉的确实是那个非空壳）
    expect(out.failed).toEqual([]);
    expect(out.mode).toBe('idle');
    expect(fsReal.existsSync(path.join(TMPD, HUSK + 'PROJ'))).toBe(false);
  });

  it('只剩一个**空子目录**的壳也清（实测 35 个里有 5 个是这个形状，非递归 rmdirSync 一样删不掉）', () => {
    seedHusk(HUSK + 'VISIT', { shape: 'empty-visit', ageMs: 5 * MIN });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED });
    expect(namesInTmp(), '空壳没删掉 ' + namesInTmp().length + ' 个').toEqual([]);
    expect(out.swept.length).toBe(1);
  });

  it('多个壳一次清干净，且字节总数与盘上一致（读数不是编的）', () => {
    const a = seedHusk(HUSK + 'A', { shape: 'project', ageMs: 10 * MIN });
    const b = seedHusk(HUSK + 'B', { shape: 'file', ageMs: 10 * MIN });
    const want = fsReal.statSync(path.join(a, 'comnet', 'comnet.json')).size
      + fsReal.statSync(path.join(a, 'comnet', 'assets', 'a.bin')).size
      + fsReal.statSync(path.join(b, 'x.txt')).size;
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED });
    expect(out.swept.length).toBe(2);
    expect(out.sweptBytes).toBe(want);
    expect(namesInTmp()).toEqual([]);
  });
});

/* ============================================================ */
describe('② 护栏：有活实例在跑时，不许误删"可能就是正在跑的那一轮"', () => {
  it('★ 有活登记（pid 活着）+ 5 分钟大的非空壳 ⇒ **不动**，并把理由打出来', () => {
    seedHusk(HUSK + 'LIVE', { shape: 'project', ageMs: 5 * MIN });
    seedClaim(sweep.claimNameFor(4242, Date.now(), 'aaaaaa'));
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, isAlive: (pid) => pid === 4242 });
    expect(out.mode).toBe('busy');
    expect(out.swept).toEqual([]);                                   // 一个都没删
    expect(out.held.length).toBe(1);
    expect(out.held[0].why).toBe('busy');
    expect(namesInTmp()).toEqual([HUSK + 'LIVE']);                   // 还在盘上，内容也还在
    expect(fsReal.existsSync(path.join(TMPD, HUSK + 'LIVE', 'comnet', 'comnet.json'))).toBe(true);
    expect(sweep.message(out)).toContain('busy 1');                  // 理由必须进打印（B8：只报数字等于没说明）
  });

  it('有活登记时，超过 3600s 的壳**照样清**（年龄线没被护栏吃掉）', () => {
    seedHusk(HUSK + 'OLD', { shape: 'project', ageMs: 2 * 60 * MIN });
    seedClaim(sweep.claimNameFor(4242, Date.now(), 'bbbbbb'));
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, isAlive: (pid) => pid === 4242 });
    expect(out.mode).toBe('busy');
    expect(out.swept.length).toBe(1);
    expect(namesInTmp()).toEqual([]);
  });

  it('年龄线取值的读数：3600s 必须**远大于**一轮 full 冒烟（1004.6s / 预算 1300s）', () => {
    expect(sweep.SAFE_AGE_MS).toBe(60 * 60 * 1000);
    expect(sweep.SAFE_AGE_MS).toBeGreaterThan(1300 * 1000);          // 3.58× 实测 / 2.77× 预算
    expect(sweep.SELF_FRESH_MS).toBeLessThan(sweep.SAFE_AGE_MS);     // 两档不是同一个数（否则"发现即清"永远等一小时）
  });
});

/* ============================================================ */
describe('③ 判不了就保守（活性读不出来 ⇒ 只认 3600s）', () => {
  it('登记目录读不出来 ⇒ mode=unknown、ok=false，5 分钟大的壳不动、2 小时大的照样清', () => {
    seedHusk(HUSK + 'FRESH', { shape: 'file', ageMs: 5 * MIN });
    seedHusk(HUSK + 'STALE', { shape: 'file', ageMs: 3 * 60 * MIN });
    const fake = wrapFs({
      readdirSync(p, o) {
        if (path.resolve(p) === path.resolve(LIVED)) { const e = new Error('io'); e.code = 'EIO'; throw e; }
        return fsReal.readdirSync(p, o);
      }
    });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, fs: fake });
    expect(out.mode).toBe('unknown');
    expect(out.ok).toBe(false);                                       // "判不了"不许伪装成"全过"
    expect(out.held.map((h) => h.name)).toEqual([HUSK + 'FRESH']);
    expect(out.swept.map((s) => s.name)).toEqual([HUSK + 'STALE']);
  });

  it('自己的登记没建上（claimOk:false）⇒ 不许进 idle 档（我们可能也看不见别人的登记）', () => {
    seedHusk(HUSK + 'FRESH2', { shape: 'file', ageMs: 5 * MIN });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, claimOk: false });
    expect(out.mode).toBe('unknown');
    expect(out.swept).toEqual([]);
    expect(namesInTmp()).toEqual([HUSK + 'FRESH2']);
  });

  it('idle 档 + 只有 5 秒大的壳 ⇒ 不动（自身新鲜期 60s，防"建好目录还没拷项目"那个窗口）', () => {
    seedHusk(HUSK + 'JUSTBORN', { shape: 'file', ageMs: 5 * 1000 });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED });
    expect(out.mode).toBe('idle');
    expect(out.swept).toEqual([]);
    expect(out.held[0].why).toBe('self-fresh');
    expect(namesInTmp()).toEqual([HUSK + 'JUSTBORN']);
  });
});

/* ============================================================ */
describe('④ 边界：只碰自己的前缀，永远不碰自己', () => {
  it('自拍（selfName）与非本前缀目录都不动', () => {
    const mine = seedHusk(HUSK + 'SELF', { shape: 'file', ageMs: 60 * MIN });
    const other = path.join(TMPD, 'mm-other-tool');                  // 别人的目录：同在前缀之外
    fsReal.mkdirSync(other, { recursive: true });
    fsReal.writeFileSync(path.join(other, 'k.txt'), 'keep', 'utf8');
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, selfName: HUSK + 'SELF' });
    expect(out.swept).toEqual([]);
    expect(fsReal.existsSync(mine)).toBe(true);
    expect(fsReal.existsSync(path.join(other, 'k.txt'))).toBe(true);
  });

  it('★ 自己的沙箱（1 小时大，早已越过年龄线）也不动 —— 而且不算"暂不动"的噪声读数', () => {
    // 这条正是 2026-10-19 第一次全链 G5 抓到的缺陷形状：接线把**登记名**当成 selfName 传进来，
    // 于是自己那份沙箱每轮都被算成 `self-fresh` 暂不动（60s 窗口侥幸挡住，越过就是"删自己在用的沙箱"）。
    const mine = seedHusk(HUSK + 'SELFOLD', { shape: 'project', ageMs: 60 * MIN });
    const claim = sweep.claimNameFor(4242, Date.now(), 'cccccc');
    seedClaim(claim);                                                 // 自己的登记也在盘上
    const out = sweep.sweepHusks({
      tmpDir: TMPD, liveDir: LIVED, isAlive: (pid) => pid === 4242,
      selfName: HUSK + 'SELFOLD', selfClaimName: claim
    });
    expect(out.swept, '自己的沙箱被当成死壳删掉了').toEqual([]);
    expect(out.held, '自己的沙箱不该进"暂不动"（那是别人的壳才该有的读数）').toEqual([]);
    expect(out.mode, '自己的登记被当成了"别的实例"').toBe('idle');
    expect(namesInTmp()).toEqual([HUSK + 'SELFOLD']);
    expect(fsReal.existsSync(mine)).toBe(true);
  });
});

/* ============================================================ */
describe('⑤ 删不掉才报（不许静默）', () => {
  it('rmSync 抛 EPERM ⇒ 落进 failed 并点名 name/code，message() 里也看得见', () => {
    seedHusk(HUSK + 'LOCKED', { shape: 'file', ageMs: 5 * MIN });
    const fake = wrapFs({
      rmSync(p, o) {
        if (path.basename(p).indexOf(HUSK) === 0) { const e = new Error('eperm'); e.code = 'EPERM'; throw e; }
        return fsReal.rmSync(p, o);
      }
    });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, fs: fake });
    expect(out.failed.length).toBe(1);
    expect(out.failed[0]).toMatchObject({ name: HUSK + 'LOCKED', code: 'EPERM' });
    expect(out.ok).toBe(false);
    expect(out.swept).toEqual([]);
    expect(sweep.message(out)).toContain('删不掉 1 个');
    expect(sweep.message(out)).toContain('EPERM');
  });

  it('rmSync 不抛但目录还在 ⇒ 记 STILL_EXISTS（一样算删不掉）', () => {
    seedHusk(HUSK + 'GHOST', { shape: 'file', ageMs: 5 * MIN });
    const fake = wrapFs({
      rmSync() { /* 假装成功 */ },
      existsSync(p) { if (path.basename(p).indexOf(HUSK) === 0) return true; return fsReal.existsSync(p); }
    });
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, fs: fake });
    expect(out.failed.map((f) => f.code)).toEqual(['STILL_EXISTS']);
    expect(out.ok).toBe(false);
  });
});

/* ============================================================ */
describe('⑥ 活实例登记：pid 判活 + 僵尸当死清掉', () => {
  it('pid 已死 / 名字拆不出 pid 的登记 ⇒ 当死清掉，不许把清扫永久锁成 busy', () => {
    seedHusk(HUSK + 'FRESH3', { shape: 'file', ageMs: 5 * MIN });
    seedClaim(sweep.claimNameFor(999999, Date.now(), 'dead01'));     // 一个绝不会存在的 pid
    seedClaim('smoke-garbage');                                       // 拆不出 pid ⇒ 当死
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, isAlive: () => false });
    expect(out.mode).toBe('idle');
    expect(out.reaped).toBe(2);
    expect(fsReal.readdirSync(LIVED)).toEqual([]);                    // 僵尸真被清掉了
    expect(out.swept.map((s) => s.name)).toEqual([HUSK + 'FRESH3']);  // 于是自愈没被永久锁死
  });

  it('登记超龄（> 3600s）⇒ 当僵尸（pid 复用 / 挂死），不阻塞', () => {
    seedClaim(sweep.claimNameFor(4242, Date.now() - 2 * 60 * MIN, 'old777'));
    const out = sweep.sweepHusks({ tmpDir: TMPD, liveDir: LIVED, isAlive: () => true });
    expect(out.mode).toBe('idle');
    expect(out.reaped).toBe(1);
  });

  it('makeClaim 建的是**空目录**、名字里有 pid 与开工时刻，release 后消失', () => {
    const c = sweep.makeClaim({ liveDir: LIVED, pid: 4321, now: () => 1700000000000, rand: 'zzz' });
    expect(c.ok).toBe(true);
    expect(c.name).toBe('smoke-4321-' + (1700000000000).toString(36) + '-zzz');
    expect(fsReal.readdirSync(path.join(LIVED, c.name))).toEqual([]);   // 空目录：内容全在名字里
    c.release();
    expect(fsReal.existsSync(path.join(LIVED, c.name))).toBe(false);
  });

  it('登记前缀与 cli-integration 的 `run-` 不撞（撞了会让 G4 退回保守 ⇒ G2 假红）', () => {
    expect(sweep.CLAIM_PREFIX).toBe('smoke-');
    const cliSrc = stripComments(fsReal.readFileSync(path.join(ROOT, 'scripts', 'cli-integration.js'), 'utf8'));
    expect(cliSrc).toContain("'run-' + process.pid");
    expect(cliSrc).toContain("f.indexOf('run-')");
    expect(sweep.CLAIM_PREFIX).not.toContain('run-');
  });
});

/* ============================================================ */
describe('⑦ 结构断言：W5 的病不许回来（去注释后的代码）', () => {
  const modSrc = () => stripComments(fsReal.readFileSync(path.join(ROOT, 'scripts', 'smoke', 'husk-sweep.js'), 'utf8'));
  const mainSrc = () => stripComments(fsReal.readFileSync(path.join(ROOT, 'main.js'), 'utf8'));

  it('★ 模块与 main.js 里都不许再出现 rmdirSync（= 非空壳删不掉的根因）', () => {
    expect(modSrc()).not.toContain('rmdirSync');
    expect(mainSrc()).not.toContain('rmdirSync');
  });

  it('模块的删除调用必须是**递归**的（recursive + force），否则"非空"又成了删不动的前提', () => {
    const s = modSrc();
    expect(s).toContain('rmSync(p, { recursive: true, force: true');
  });

  it('main.js 只接线不实现：必须是 require 模块 + 打印 message（清扫逻辑只有一份）', () => {
    const s = mainSrc();
    expect(s).toContain("require('./scripts/smoke/husk-sweep.js')");
    expect(s).toContain('huskSweep.message(');
    expect(s).not.toContain('husks.kept');            // 旧的三档读数（非空残留没动）已不存在
  });

  it('★ main.js 的接线：selfName 必须是**沙箱目录名**、登记名走 selfClaimName（混用会删自己在用的沙箱）', () => {
    const s = mainSrc();
    expect(s, 'selfName 必须传 path.basename(SMOKE_PROJECTS_DIR)（= 自己的沙箱目录名）')
      .toContain('selfName: path.basename(SMOKE_PROJECTS_DIR)');
    expect(s, '登记名必须单独走 selfClaimName').toContain('selfClaimName: smokeClaim.name');
    expect(s, '混用形状（把登记名当 selfName）不许再出现').not.toContain('selfName: smokeClaim.name');
  });

  it('前缀一致性：main.js 的 mkdtemp 前缀 === 模块的 HUSK_PREFIX（否则清扫扫不到自己的壳）', () => {
    const s = mainSrc();
    const m = s.match(/mkdtempSync\(path\.join\(os\.tmpdir\(\), '([^']+)'\)\)/);
    expect(m, 'main.js 里没找到 mkdtempSync 的沙箱前缀').toBeTruthy();
    expect(m[1]).toBe(sweep.HUSK_PREFIX);
  });
});
