/* ============================================================
 * tests/bind-sync.test.js — 【R4】`bind-sync` 端到端 + **事件驱动真跑** + 零 token
 * 运行：npx vitest run tests/bind-sync.test.js
 * ------------------------------------------------------------
 * 与 `tests/bindings.test.js` 的分工：那一份只考**纯逻辑**（不碰 CLI）；这一份考**接线**：
 *   ① 默认档不变（未绑定时**逐字节相同**，这是本批的硬判据）；
 *   ② 绑定 → 同步一次 → 增量（改/加/删）；
 *   ③ **事件驱动真跑**：`fs.watch` + 防抖 + 真跑那条 CLI ⇒ 改文件后**在合理时间内**项目里出现新内容；
 *   ④ **零 token**：同步链路上没有任何 LLM / 网络调用（静态 + 运行期两条判据）；
 *   ⑤ 旁路快照不进项目数据（读盘比对字节）；
 *   ⑥ 界面脏 ⇒ 一个字节都不写（`blocked-dirty`）。
 *
 * ## 环境要点（与 tests/w8-dry-run.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 端到端走**进程内** `invokeSync`（受限环境下管道 stdio 会 EPERM 假失败）；
 *   3) `projects/` 真实目录**碰都不碰**：夹具、源文件夹、断言全在临时目录里，最后删干净；
 *   4) 访问埋点关掉（本文件量的是项目目录的字节，不留旁路写入来源）。
 *
 * ## ⚠️ 一条**实测踩到的环境边界**（写在这里，免得下一个人以为测试写得啰嗦）
 *   Node 24 / Windows 上，`fs.watch(dir, {recursive:true})` 的目录**被删除而 watcher 还开着**时，
 *   libuv 会在 `src/win/fs-event.c:72` 抛一个**原生断言**（`!_wcsnicmp(filename, dir, dirlen)`）——
 *   整轮测试进程当场死掉，连一条失败断言都打不出来（本文件第一版就是这样死的）。
 *   ⇒ 测试不变量（**必须守住**）：**watcher 先关、目录后删**；被监听的目录活到 `afterAll` 最后。
 *   ⌛ 这条同时是产品侧的已知边界：用户把正在守护的文件夹**删掉**时，Electron 的主进程有同样的风险。
 *      本批的取舍是**先如实记下来**（`dev/backlog` 的那一条），不在这批里做"监听自愈"——
 *      理由是那需要平台相关的经验数据，而本批的判据是"事件驱动 + 增量 + 只提议"这三条。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ⚠️ 事件驱动那条的用户可见承诺是"**合理时间内**"：本文件写死 5 秒上界。
 *   依据：绑定的防抖（本文件设 200ms）+ `fs.watch` 在本机的投递延迟（Windows 上实测 <200ms）
 *   + 同步一次本身的耗时（纯本地字符串处理，毫秒级）⇒ 5 秒是**上界**，不是期望值。
 *   `MM_BIND_NO_WATCH=1` ⇒ **不挂 watcher**（判别力证明用：那条断言必须变红）。 */
const WATCH_DEADLINE_MS = 5000;
const DEBOUNCE_MS = 200;
const NO_WATCH = process.env.MM_BIND_NO_WATCH === '1';

/* ---- ① 临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bindsync-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const docImport = require('../src/doc-import.js');
const uiState = require('../src/ui-state.js');
const heatSensor = require('../src/heat-sensor.js');

heatSensor.__setEnabledForTest(false);

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const P = 'bproj';
const projFile = () => path.join(SANDBOX, P, P + '.json');
const stateFile = () => path.join(SANDBOX, P, docImport.BINDING_STATE_FILE);
/** 「会变的那个源文件夹」：每次用例重建（**绝不被 watcher 盯** —— 见文件头那条边界） */
const SRC = path.join(SANDBOX, 'src-notes');
/** 「事件驱动专用的源文件夹」：**每个用例各一个**（活到 `afterAll` 最后）。
 *  ⚠️ 为什么两个用例不共用同一个目录：Windows 上"递归 watcher 的目录被删/重建"会触发 libuv 原生断言
 *  （见文件头那条实测边界）⇒ 各用各的，谁也不去动对方被盯着的那个目录 ✓ */
const SRC_WATCH1 = path.join(SANDBOX, 'src-watched-1');
const SRC_WATCH2 = path.join(SANDBOX, 'src-watched-2');

const run = (argv) => invokeSync(argv);
const outOf = (r) => String(r.stdout || '');
const readProject = () => JSON.parse(fs.readFileSync(projFile(), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const exists = (p) => fs.existsSync(p);

/** 递归删目录（**只在没有 watcher 盯它时用**：见文件头那条实测边界） */
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
/** 把一个可能被 watcher 盯着的目录**清空**（逐项删**内容**，**不删目录本身**）——
 *  这是文件头那条边界的正面用法：目录本身活着 ⇒ 原生断言的前提（"目录没了"）不成立 ✓ */
function pruneDir(p) {
  try {
    if (!fs.existsSync(p)) return;
    fs.readdirSync(p).forEach((f) => rmrf(path.join(p, f)));
  } catch (e) { /* ignore */ }
}
function writeTree(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files || {}).forEach((rel) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel], 'utf8');
  });
}

beforeEach(() => {
  disarm();
  rmrf(path.join(SANDBOX, P));
  pruneDir(SRC);                                  // SRC 从不被 watcher 盯，但同一条纪律：清内容、不删目录
  writeTree(SRC, {});
  const r = run(['init', P, '--title', 'R4 端到端']);
  expect(r.code, outOf(r) + r.stderr).toBe(0);
});

let armed = [];
let armedTimers = [];
/** 收摊：先清定时器、再关 watcher、**再让原生层把关闭落地**。
 *  ⚠️ 最后那一步不是洁癖：`w.close()` 是异步落地的，紧接着删目录时 libuv 仍可能处理到一个
 *  指向"已删目录"的事件 ⇒ 原生断言（文件头那条）⇒ **整轮测试的进程当场死**。
 *  实测：单独跑本文件永远是绿的，**跑全量**（多文件并行）时才会崩 —— 所以这条必须在。 */
function disarm() {
  armedTimers.forEach((t) => clearTimeout(t));
  armedTimers = [];
  armed.forEach((w) => { try { w.close(); } catch (e) { /* ignore */ } });
  armed = [];
  const until = Date.now() + 60;
  while (Date.now() < until) { /* spin：等原生关闭落地 */ }
}
afterEach(() => { disarm(); });
afterAll(() => {
  disarm();                                 // ⚠️ 先关 watcher（判据：watcher 先关、目录后删）
  rmrf(SANDBOX);
});

/** **复刻主进程守护的那三步**（`main.js` 的 `bindWatchersFor` + `runBindSyncFor`）：
 *    挂 `fs.watch(dir,{recursive:true})` → 防抖（毫秒数来自绑定记录）→ **真跑那条 CLI**。
 *  ⚠️ 诚实边界：这里**不是** import 主进程那段代码（`main.js` 要 electron 才能加载，单测加载不了），
 *     而是照它的三步接线复刻。判据的分量在于：**真挂 watcher、真等防抖、真跑 CLI** ⇒
 *     "改文件后导图里出现新内容"这件事真的发生过；而 `MM_BIND_NO_WATCH=1` 时这条链会红 ✓。 */
function arm(files, onBatch) {
  disarm();
  if (NO_WATCH) return;
  files.forEach((f) => {
    let timer = null;
    /* ⚠️ **先把路径规范化**（与 `main.js` 的 `bindWatchersFor` 同一处修法，理由见文件头）：
     *   Windows 上把 8.3 短名路径（`os.tmpdir()` 给的就是 `C:\Users\JUNNAN~1.TAN\…`）
     *   交给 `fs.watch(dir,{recursive:true})` ⇒ libuv 原生断言、进程当场死。
     *   `realpathSync.native` 把短名摊成长名 ⇒ 断言不成立 ✓ */
    let watchDir = f.dir;
    try { watchDir = fs.realpathSync.native(f.dir); } catch (e) { /* 用原路径 */ }
    const w = fs.watch(watchDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onBatch(f); }, f.debounceMs);
      armedTimers.push(timer);
    });
    armed.push(w);
  });
  /* 让 libuv 把那几个句柄**真正建好**再返回：`fs.watch` 的注册是异步落地的，
   * 紧接着就改文件的话，前几个事件可能落在"监听还没生效"的缝里（那会让判据偶发假红）。 */
  const until = Date.now() + 80;
  while (Date.now() < until) { /* spin：与 `src/data-store.js` 的 renameWithRetry 同一手法 */ }
}

/** 等一个条件成立（每 25ms 看一次）；超时返回 `ok:false`。上界 = `WATCH_DEADLINE_MS` */
function waitFor(fn, deadlineMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      let ok = false;
      try { ok = !!fn(); } catch (e) { ok = false; }
      if (ok) { resolve({ ok: true, ms: Date.now() - t0 }); return; }
      if (Date.now() - t0 > (deadlineMs || WATCH_DEADLINE_MS)) { resolve({ ok: false, ms: Date.now() - t0 }); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/* ============================================================================
 * F 默认档不变（未绑定 ⇒ 与本批之前逐字节相同）
 * ========================================================================== */
describe('F 默认档不变：没有绑定时的可观测输出与"从前的"逐字节相同', () => {
  it('F1 未绑定的项目：`bind-sync` 说清"还没绑定"，且**盘上零改动**', () => {
    writeTree(SRC, { 'a.md': '# 甲\n' });
    const before = sha(projFile());
    const r = run(['bind-sync', P]);
    expect(r.code, outOf(r)).toBe(0);
    expect(outOf(r)).toContain('还没有绑定');
    expect(sha(projFile())).toBe(before);
    expect(exists(stateFile())).toBe(false);            // 旁路快照也不该出现
    // `--watch-dirs` 在没有绑定时输出空（主进程据此**一个 watcher 都不挂**）
    const w = run(['bind-sync', P, '--watch-dirs']);
    expect(w.code).toBe(0);
    expect(outOf(w).trim()).toBe('');
  });

  it('F2 未绑定时的读/写/导入/校验**逐字节不变**，且项目 JSON 里不该凭空多出 bindings 键', () => {
    writeTree(SRC, { 'a.md': '# 甲\n' });
    const h0 = sha(projFile());
    expect(run(['read', P, '--brief']).code).toBe(0);
    expect(run(['list', P]).code).toBe(0);
    expect(run(['validate', P]).code).toBe(0);
    expect(run(['validate-all']).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    expect(sha(projFile())).toBe(h0);
    expect('bindings' in readProject()).toBe(false);
  });
});

/* ============================================================================
 * G 绑定 → 同步一次 → 增量（走真 CLI）
 * ========================================================================== */
describe('G 绑定与增量（真 CLI）', () => {
  it('G1 `--bind` 写进项目数据（`bindings[]`），且**不在同一轮同步**（绑定与同步是两步）', () => {
    writeTree(SRC, { 'a.md': '# 甲\n', 'b.md': '# 乙\n', 'c.md': '# 丙\n' });
    const r = run(['bind-sync', P, '--bind', '--dir', SRC, '--mode', 'flat', '--debounce', String(DEBOUNCE_MS)]);
    expect(r.code, outOf(r)).toBe(0);
    const d = readProject();
    expect(Array.isArray(d.bindings)).toBe(true);
    expect(d.bindings).toHaveLength(1);
    expect(d.bindings[0].dir).toBe(SRC);
    // 契约字面量（从 src/schema.js 现取，不在测试里手抄一份）
    expect(d.bindings[0].deletions).toBe(require('../src/schema.js').BINDING_DELETIONS);
    expect(d.bindings[0].lastSyncAt).toBeUndefined();     // 还没同步过
    expect(outOf(r)).toContain('新建绑定');
    expect(exists(stateFile())).toBe(false);
  });

  it('G2 `--bind` 之后同步一次：3 个 md ⇒ 3 个文件节点（逐节点现算）', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n', 'c.md': '# 丙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    const r = run(['bind-sync', P]);
    expect(r.code, outOf(r)).toBe(0);
    expect(outOf(r)).toContain('新增 3 个文件');
    const topics = [];
    (function walk(n) { if (!n) return; topics.push(n.topic); (n.children || []).forEach(walk); })(readProject().data);
    expect(topics).toEqual(['R4 端到端', 'a', '甲书', 'b', '乙书', 'c', '丙书']);
  });

  it('G3 改一个 ⇒ 只更新一个；加一个 ⇒ 只新增一个；删一个 ⇒ 节点一个不少 + 1 条提议', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n', 'c.md': '# 丙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    const countNodes = () => {
      let n = 0;
      (function walk(x) { if (!x) return; n++; (x.children || []).forEach(walk); })(readProject().data);
      return n;
    };
    const n0 = countNodes();

    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书（改过）\n\n新正文\n', 'utf8');
    const r1 = run(['bind-sync', P]);
    expect(outOf(r1), outOf(r1)).toContain('新增 0 个文件 / 更新 1 个');
    expect(countNodes()).toBe(n0);                        // 改内容不增节点

    fs.writeFileSync(path.join(SRC, 'd.md'), '# 丁书\n', 'utf8');
    const r2 = run(['bind-sync', P]);
    expect(outOf(r2)).toContain('新增 1 个文件 / 更新 0 个');
    expect(countNodes()).toBe(n0 + 2);                    // d + 丁书

    // 删一个 ⇒ **节点一个不少**（本功能最核心的承诺）
    const n1 = countNodes();
    const treeBefore = JSON.stringify(readProject().data);
    fs.unlinkSync(path.join(SRC, 'c.md'));
    const r3 = run(['bind-sync', P, '--json']);
    const j = JSON.parse(outOf(r3));
    expect(j.pending, outOf(r3)).toBe(1);
    expect(j.sync[0].pending).toBe(1);
    expect(j.sync[0].pendingList.map((x) => x.rel)).toEqual(['c.md']);
    expect(j.bindings[0].pending).toBe(1);
    expect(countNodes()).toBe(n1);
    expect(JSON.stringify(readProject().data)).toBe(treeBefore);
    // 再看文本档：同一条提议仍然看得见（**节点一个都不少**）
    expect(outOf(run(['bind-sync', P]))).toContain('待确认删除 1 条');
    expect(countNodes()).toBe(n1);
  });

  it('G4 `--pause` / `--resume` / `--unbind`：都只影响"要不要同步"，已导入的节点一个都不动', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    const tree = JSON.stringify(readProject().data);
    expect(run(['bind-sync', P, '--pause']).code).toBe(0);
    expect(readProject().bindings[0].status).toBe('paused');
    expect(JSON.stringify(readProject().data)).toBe(tree);
    expect(outOf(run(['bind-sync', P, '--watch-dirs'])).trim()).toBe('');     // 暂停 ⇒ 不挂 watcher
    expect(run(['bind-sync', P, '--resume']).code).toBe(0);
    expect(readProject().bindings[0].status).toBeUndefined();                // 复位成缺省（守护中）
    expect(outOf(run(['bind-sync', P, '--watch-dirs'])).trim().length).toBeGreaterThan(0);
    expect(run(['bind-sync', P, '--unbind']).code).toBe(0);
    expect(readProject().bindings).toEqual([]);
    expect(JSON.stringify(readProject().data)).toBe(tree);                   // 节点仍在
    expect(exists(stateFile())).toBe(false);                                 // 旁路快照随解绑删掉
  });

  it('G5 `--dry-run`：数据面与**旁路快照**都一个字节不写', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    const h = sha(projFile());
    const s = fs.readFileSync(stateFile(), 'utf8');
    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书\n', 'utf8');
    const r = run(['bind-sync', P, '--dry-run']);
    expect(r.code, outOf(r)).toBe(0);
    expect(outOf(r)).toContain('dry-run');
    expect(sha(projFile())).toBe(h);
    expect(fs.readFileSync(stateFile(), 'utf8')).toBe(s);
    // 真跑一次之后：b 同步进来（证明刚才只是**没写**，不是"没算"）
    expect(run(['bind-sync', P]).code).toBe(0);
    expect(sha(projFile())).not.toBe(h);
  });

  it('G6 `--confirm-deletions` 确认流：确认前一个节点都不少 ⇒ 确认只摘**被确认的那个** ⇒ 提议清零、K 回 0、再确认是幂等空转', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n', 'c.md': '# 丙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    fs.writeFileSync(path.join(SRC, 'd.md'), '# 丁书\n', 'utf8');      // 先让树真变一次
    expect(run(['bind-sync', P]).code).toBe(0);

    const countNodes = () => {
      let n = 0;
      (function walk(x) { if (!x) return; n++; (x.children || []).forEach(walk); })(readProject().data);
      return n;
    };
    /* 把某个 id 的节点**连同子树**从一份树 JSON 里摘掉（判"其它节点逐字节不变"的精确基准） */
    const strip = (treeJson, id) => {
      const cut = (n) => {
        if (!n || typeof n !== 'object') return n;
        const kids = Array.isArray(n.children) ? n.children.filter((c) => c && c.id !== id) : n.children;
        return Object.assign({}, n, { children: (kids || []).map(cut) });
      };
      return JSON.stringify(cut(JSON.parse(treeJson)));
    };

    const nodesBefore = countNodes();
    const treeBefore = JSON.stringify(readProject().data);
    fs.unlinkSync(path.join(SRC, 'c.md'));                              // 盘上真删一个文件
    expect(run(['bind-sync', P]).code).toBe(0);

    /* ① 提议看得见 + **盘上一个节点都不少**（连跑两轮"什么都不做"也一样） */
    const p1 = JSON.parse(outOf(run(['bind-sync', P, '--json'])));
    expect(p1.pending, outOf(run(['bind-sync', P]))).toBe(1);
    expect(p1.sync[0].pendingList.map((x) => x.rel)).toEqual(['c.md']);
    expect(p1.sync[0].pendingList[0].nodeId).toBeTruthy();             // 逐条点名的三样：名字/文件/节点
    expect(p1.sync[0].pendingList[0].topic).toBe('c');
    expect(run(['bind-sync', P]).code).toBe(0);
    const p2 = JSON.parse(outOf(run(['bind-sync', P, '--json'])));
    expect(p2.pending, '第二轮（没有任何新变化）提议仍要看得到').toBe(1);
    expect(countNodes()).toBe(nodesBefore);
    expect(JSON.stringify(readProject().data)).toBe(treeBefore);

    /* ② `--dry-run` 的确认只是**预览**：说清要删几个，盘上一个字节不写 */
    const hBefore = sha(projFile());
    const prev = JSON.parse(outOf(run(['bind-sync', P, '--confirm-deletions', '--dry-run', '--json'])));
    expect(prev.deletions.declared).toBe(1);
    expect(prev.deletions.dryRun).toBe(true);
    expect(prev.deletions.list.map((x) => x.rel)).toEqual(['c.md']);
    expect(sha(projFile()), '预览必须零写入').toBe(hBefore);
    expect(countNodes()).toBe(nodesBefore);

    /* ③ 真确认：只摘被确认的那一个（其余逐字节不变）+ 提议清零 + K 回 0 */
    const victim = prev.deletions.list[0];
    const r3 = run(['bind-sync', P, '--confirm-deletions', '--json']);
    const j3 = JSON.parse(outOf(r3));
    expect(r3.code, outOf(r3)).toBe(0);
    expect(j3.status).toBe('confirmed');
    expect(j3.deletions.declared).toBe(1);
    expect(j3.deletions.dropped).toBe(1);
    expect(j3.deletions.remaining).toBe(0);
    expect(j3.pending).toBe(0);
    expect(j3.bindings[0].pending).toBe(0);
    expect(JSON.stringify(readProject().data), '只摘被确认的那一个（其余逐字节不变）').toBe(strip(treeBefore, victim.nodeId));
    expect(countNodes()).toBe(nodesBefore - 2);                        // 文件节点 + 它的标题子树
    const snapAfter = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    expect(snapAfter.pendingDeletions, '提议清空').toEqual([]);
    // 文本档也点名说清"删掉了几个"（人看的播报面）
    const t3 = outOf(run(['bind-sync', P, '--confirm-deletions']));
    expect(t3).toContain('没有待确认的提议');                            // 这一轮已经没有提议了 ⇒ 走"没得确认"那一档
    expect(t3).not.toContain('删掉了 0 个');                             // 不许把"没得确认"印成"确认执行了"

    /* ④ 再确认一次 = **幂等空转**（不是错误、也不写盘） */
    const h4 = sha(projFile());
    const r4 = run(['bind-sync', P, '--confirm-deletions', '--json']);
    const j4 = JSON.parse(outOf(r4));
    expect(r4.code).toBe(0);
    expect(j4.status).toBe('no-pending');
    expect(j4.deletions.dropped).toBe(0);
    expect(sha(projFile()), '没有提议时一次盘都不写').toBe(h4);
  });

  it('G7 确认流 fail closed：旁路快照读不出来 ⇒ **响亮拒绝**、一个节点都不删、盘上一个字节不写', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    fs.writeFileSync(path.join(SRC, 'd.md'), '# 丁书\n', 'utf8');
    expect(run(['bind-sync', P]).code).toBe(0);
    fs.unlinkSync(path.join(SRC, 'b.md'));
    expect(run(['bind-sync', P]).code).toBe(0);                        // 这时快照里/本轮里应有 1 条提议

    const treeBefore = JSON.stringify(readProject().data);
    fs.writeFileSync(stateFile(), '{ 这不是 JSON', 'utf8');             // 快照**在**、但读不出来
    const h = sha(projFile());
    const r = run(['bind-sync', P, '--confirm-deletions']);
    expect(r.code, '读不到提议 ⇒ 必须非 0（fail closed）').not.toBe(0);
    const txt = outOf(r) + String(r.stderr || '');
    expect(txt).toContain('未执行');
    expect(txt, '不许把拒绝印成"删掉了 0 个"').not.toContain('删掉了 0 个');
    expect(txt).toContain('旁路快照');
    expect(sha(projFile()), '拒绝时盘上一个字节都不写').toBe(h);
    expect(JSON.stringify(readProject().data)).toBe(treeBefore);
    /* 普通同步（非确认）照旧跑，但**响亮**说快照读不出来（HEAD 上是静默的：实测同一场景
     *   —— 坏快照 + 普通同步 ⇒ 节点 5→9 —— HEAD 报文里连"旁路快照"四个字都没有 ✗，上一批补上）。
     * ⚠️ 【账②】上一批**只把它说响**、没有改语义（"快照读不出来 ⇒ 那份'哪个文件对应哪个节点'的
     *   记账就没了 ⇒ 全部文件当**新增** ⇒ 多出一批同名节点"）。本批把**语义**也改到位：
     *   计划改用树里各文件节点的 `origin` 现算那份对应关系（`planBindingSnapshotOf` → `knownNodeOf`）
     *   ⇒ 快照丢了/坏了的那一轮，文件**就地更新**它原来的节点，**节点数一个都不多** ✓
     *   （这句话的落点就是下面这条 `toBe(nodesBefore)`；旧断言只要求"不减少"，那对"重复建节点"是盲的）。 */
    const nodesBefore = (() => {
      let n = 0;
      (function walk(x) { if (!x) return; n++; (x.children || []).forEach(walk); })(readProject().data);
      return n;
    })();
    const plain = run(['bind-sync', P]);                                // 文本档：两句话都要看得见
    expect(plain.code).toBe(0);
    expect(outOf(plain), 'HEAD 静默、上一批起必须点名').toContain('旁路快照读不出来');
    expect(outOf(plain), '本轮"认回来"的读数要看得见').toMatch(/接回了原节点/);
    const nodesAfter = (() => {
      let n = 0;
      (function walk(x) { if (!x) return; n++; (x.children || []).forEach(walk); })(readProject().data);
      return n;
    })();
    expect(nodesAfter, '快照读不出来的那一轮：**节点数不变**（既不减、也不重复建）').toBe(nodesBefore);
    // 同一个文件的节点在树里只许有一个（重名 = 重复建节点的可见后果）
    const topics = [];
    (function walk(x) { if (!x) return; topics.push(x.topic); (x.children || []).forEach(walk); })(readProject().data);
    ['a', 'b'].forEach((t) => expect(topics.filter((y) => y === t), '同名节点只能有一个：' + t).toHaveLength(1));
  });

  it('G8 【账②】`--forget-snapshot`（人为丢掉旁路快照）⇒ 一轮同步后**节点数不变**、盘上零删除', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n', 'c.md': '# 丙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    const countNodes = () => {
      let n = 0;
      (function walk(x) { if (!x) return; n++; (x.children || []).forEach(walk); })(readProject().data);
      return n;
    };
    const n0 = countNodes();
    const filesBefore = fs.readdirSync(SRC).sort();
    expect(run(['bind-sync', P, '--forget-snapshot']).code).toBe(0);
    expect(exists(stateFile()), '快照真的没了').toBe(false);
    const r = run(['bind-sync', P, '--json']);
    expect(r.code, outOf(r)).toBe(0);
    const j = JSON.parse(outOf(r));
    expect(j.sync[0].added, '一个都不许当新增').toBe(0);
    expect(j.sync[0].reconnected, '三个文件全部接回原节点').toBe(3);
    expect(j.sync[0].reconnectedList.every((x) => x.from === 'origin')).toBe(true);
    expect(countNodes(), '节点数不变（HEAD 上这里会翻倍）').toBe(n0);
    expect(fs.readdirSync(SRC).sort(), '源目录一个文件都没少（**盘上零删除**）').toEqual(filesBefore);
    // 快照重建之后：下一轮没有变化
    const again = JSON.parse(outOf(run(['bind-sync', P, '--json'])));
    expect(again.sync[0].status).toBe('no-change');
    expect(countNodes()).toBe(n0);
  });

  it('G9 【账③】删→提议→把文件放回 ⇒ 节点数回到原样、提议撤回、**没有第二个同名节点**', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    const countNodes = () => {
      let n = 0;
      (function walk(x) { if (!x) return; n++; (x.children || []).forEach(walk); })(readProject().data);
      return n;
    };
    const topicsOf = () => {
      const out = [];
      (function walk(x) { if (!x) return; out.push(x.topic); (x.children || []).forEach(walk); })(readProject().data);
      return out;
    };
    const n0 = countNodes();
    fs.unlinkSync(path.join(SRC, 'b.md'));                              // 盘上真删一个
    const p1 = JSON.parse(outOf(run(['bind-sync', P, '--json'])));
    expect(p1.pending, '① 提议看得见；**节点一个都不少**').toBe(1);
    expect(countNodes()).toBe(n0);
    /* ⚠️ 关键半步（照 G6/域 42 壬 的做法）：**只提议的那一轮不改树 ⇒ 旁路快照根本不落盘**
     *   （命令在 `bindingPlanChangesTree` 为假时早退）⇒ 那条提议此刻只活在**本轮报告**里。
     *   本用例要烤的是"提议**存进快照**之后文件再回来"那一条路，所以先让树真变一次
     *   （改 a.md 的内容⇒ 快照落盘，b.md 从 `files` 里移走、提议进 `pendingDeletions`）。 */
    fs.writeFileSync(path.join(SRC, 'a.md'), '# 甲书（改过）\n', 'utf8');
    expect(run(['bind-sync', P]).code).toBe(0);
    const persisted = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    expect(persisted.pendingDeletions.map((p) => p.rel), '提议已进快照').toEqual(['b.md']);
    expect(Object.keys(persisted.files)).toEqual(['a.md']);
    expect(countNodes()).toBe(n0);

    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书\n', 'utf8');        // 同一个文件放回（内容一样）
    const r = run(['bind-sync', P, '--json']);
    expect(r.code, outOf(r)).toBe(0);
    const j = JSON.parse(outOf(r));
    expect(j.sync[0].reconnected, '② 认得出它 ⇒ 接回原节点').toBe(1);
    expect(j.sync[0].reconnectedList, '点名"是提议那条把它接回来的"')
      .toEqual([{ rel: 'b.md', nodeId: persisted.pendingDeletions[0].nodeId, from: 'pending', proposalWithdrawn: true }]);
    expect(j.sync[0].added, '不许当新增').toBe(0);
    expect(j.pending, '④ K 回到 0（未确认的提议不再指向它）').toBe(0);
    expect(countNodes(), '⑤ 节点数回到原样').toBe(n0);
    expect(topicsOf().filter((t) => t === 'b'), '⑥ 不与既有节点重名').toHaveLength(1);
    const snap = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    expect(snap.pendingDeletions).toEqual([]);
    // 文本档也把这件事说出来（人看的播报面：**不许静默**地少一条提议）
    expect(outOf(run(['bind-sync', P]))).toMatch(/接回原节点|待确认删除 0 条/);
  });
});

/* ============================================================================
 * H 事件驱动真跑（fs.watch + 防抖 + 真同步）+ 零 token
 * ========================================================================== */
describe('H 事件驱动（真挂 fs.watch、真等防抖、真跑 CLI）', () => {
  it('H1 改一个 md ⇒ **在 ' + WATCH_DEADLINE_MS + 'ms 内**项目 JSON 里出现新内容', async () => {
    pruneDir(SRC_WATCH1);                  // **清空内容、不删目录**（它会被 watcher 盯：见文件头）
    writeTree(SRC_WATCH1, { 'a.md': '# 甲书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC_WATCH1, '--debounce', String(DEBOUNCE_MS)]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    expect(JSON.stringify(readProject())).toContain('甲书');

    const batches = [];
    arm([{ dir: SRC_WATCH1, debounceMs: DEBOUNCE_MS }], () => {
      const r = run(['bind-sync', P]);
      batches.push({ code: r.code, out: outOf(r) });
    });
    // 改文件 —— 这是"人的动作"，也是这条链的触发源
    fs.writeFileSync(path.join(SRC_WATCH1, 'a.md'), '# 甲书（事件驱动改过）\n\n新正文\n', 'utf8');
    const waited = await waitFor(() => JSON.stringify(readProject()).includes('甲书（事件驱动改过）'));
    expect(waited.ok, '事件驱动没在 ' + WATCH_DEADLINE_MS + 'ms 内把改动同步进项目'
      + '（batches=' + JSON.stringify(batches) + '）').toBe(true);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].code).toBe(0);
    expect(waited.ms).toBeLessThan(WATCH_DEADLINE_MS);      // 上界读数（"合理时间"是什么量级）
  });

  it('H2 新增一个文件走事件驱动 ⇒ 只多出一个文件节点', async () => {
    pruneDir(SRC_WATCH2);
    writeTree(SRC_WATCH2, { 'a.md': '# 甲书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC_WATCH2, '--debounce', String(DEBOUNCE_MS)]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    let called = 0;
    arm([{ dir: SRC_WATCH2, debounceMs: DEBOUNCE_MS }], () => { called++; run(['bind-sync', P]); });
    fs.writeFileSync(path.join(SRC_WATCH2, 'e.md'), '# 戊书\n', 'utf8');
    const waited = await waitFor(() => JSON.stringify(readProject()).includes('戊书'));
    expect(waited.ok, '事件驱动没把新文件同步进来（called=' + called + '）').toBe(true);
    const fileNodes = [];
    (function walk(n) { if (!n) return; if (n.origin) fileNodes.push(n.topic); (n.children || []).forEach(walk); })(readProject().data);
    expect(fileNodes.sort()).toEqual(['a', 'e']);
  });

  it('H3 **零 token**：同步链路上没有 LLM / 网络调用（静态 + 运行期两条判据）', () => {
    /* 判据① **静态**：整条链路（入口 → 命令 → 共享核心）的 import 里没有网络/LLM 模块。
     * 链路按**依赖闭包**取样（不是"我觉得"）：命令层 `cli/commands/project.js` → 共享核心
     * `src/doc-import.js` / `src/markdown.js` / `src/convert.js` / `src/schema.js` / `src/ui-state.js`
     * + 写管道 `cli/core.js`。 */
    const chain = ['src/doc-import.js', 'src/markdown.js', 'src/convert.js', 'src/schema.js',
      'src/ui-state.js', 'cli/commands/project.js', 'cli/core.js'];
    const banned = [
      /require\(['"](https?|net|tls|dns|node:http|node:https|node:net|node:dgram|ws|axios|node-fetch)['"]\)/,
      /require\(['"][^'"]*dsh-ask[^'"]*['"]\)/,          // 向内嵌 DSH 提问的模块（唯一会调 LLM 的地方）
      /spawn(?:Sync)?\(\s*[^)]*\bdsh\b/                  // 起 dsh 子进程（= 花 token 的那条路）
    ];
    const hits = [];
    chain.forEach((rel) => {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) { hits.push(rel + '（文件不存在 ⇒ 判据失效，不许当通过）'); return; }
      const txt = fs.readFileSync(p, 'utf8');
      banned.forEach((re) => { if (re.test(txt)) hits.push(rel + ' → ' + re); });
    });
    expect(hits, hits.join('\n')).toEqual([]);
    // 反向自证：这条判据**真的能红** —— 拿一个确实会调 LLM 的模块喂给它，必须命中
    const probe = fs.readFileSync(path.join(ROOT, 'src', 'dsh-ask.js'), 'utf8');
    expect(banned.some((re) => re.test(probe)), '判据①是空转的（拿 dsh-ask.js 都命中不了）').toBe(true);

    /* 判据② **运行期**：一次真同步里**没有起任何子进程**（LLM 只能经进程/网络到达）。
     * 做法：把 `child_process` 的四个出口在**本次调用期间**换成会记账的桩，先**自证桩是活的**
     * （用 `runCli` 那条真会起子进程的路径试一次 ⇒ 必须有记录），再断言同步链路上一次都没碰它们。
     * ⚠️ 诚实边界：这条证的是"**命令体**不起子进程"（`invokeSync` 是进程内调用，本来就不会起）；
     *    真要花 token 的路只有"经子进程/网络到 LLM"，而网络那一半由判据①的 import 白名单兜。 */
    writeTree(SRC, { 'a.md': '# 甲书\n', 'b.md': '# 乙书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    /* 这一条**不必**先同步一轮（增量本身由 G3/H2 逐条量）：
     * 这里要的是"**一次真的搬运**发生在桩还活着的时候" ⇒ 两个文件都当新增最省事、也最稳。
     * 所以本项目此刻**没有**旁路快照（`--bind` 不同步）⇒ 这次会真读两个文件、真写项目 JSON。 */
    const cp = require('node:child_process');
    const orig = { spawn: cp.spawn, spawnSync: cp.spawnSync, exec: cp.exec, execFileSync: cp.execFileSync };
    const called = [];
    cp.spawn = () => { called.push('spawn'); return { on() {} }; };
    cp.spawnSync = () => { called.push('spawnSync'); return { status: 0, stdout: '', stderr: '' }; };
    cp.exec = () => { called.push('exec'); };
    cp.execFileSync = () => { called.push('execFileSync'); return ''; };
    let r = null;
    let probeCalled = null;
    try {
      // 自证：**桩是活的**（直接经同一个属性调一次 —— 这正是"同步链路会走的那条路"本身）
      require('node:child_process').spawnSync('noop');
      probeCalled = called.slice();
      called.length = 0;
      r = run(['bind-sync', P]);
      // ⚠️ 顺序有意义：**先看同步输出**（它是最有诊断价值的那条），再谈子进程桩
      expect(outOf(r), '同步输出').toContain('新增 2 个文件');
    } finally {
      cp.spawn = orig.spawn; cp.spawnSync = orig.spawnSync; cp.exec = orig.exec; cp.execFileSync = orig.execFileSync;
    }
    expect(probeCalled, '代理桩没生效（判据②是空转的）').toEqual(['spawnSync']);
    expect(r.code, outOf(r)).toBe(0);
    expect(called, '同步链路上起了子进程：' + called.join(',')).toEqual([]);
  });
});

/* ============================================================================
 * I 旁路快照不进项目数据 + 界面脏就不写
 * ========================================================================== */
describe('I 旁路快照 / 界面脏', () => {
  it('I1 「没有变化」的那一轮 ⇒ 项目文件**逐字节不变**（快照在旁路，不搅数据）', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    const h = sha(projFile());
    for (let i = 0; i < 3; i++) expect(run(['bind-sync', P]).code).toBe(0);
    expect(sha(projFile())).toBe(h);
    expect(exists(stateFile())).toBe(true);               // 快照确实存在（旁路）
    const snap = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    expect(Object.keys(snap.files)).toEqual(['a.md']);
    expect(snap.files['a.md'].nodeId).toBeTruthy();       // "哪个文件对应哪个节点"在这里
    expect(snap.files['a.md'].mtimeMs).toBeGreaterThan(0);
    // 项目 JSON 里**一处**快照字段都找不到（`sha256` 不在此列：它是节点 `origin` 的内容指纹，
    // 那是 §2.8 早就有的公开契约字段，不是快照泄漏）
    const pj = fs.readFileSync(projFile(), 'utf8');
    ['mtimeMs', 'pendingDeletions', 'unconverted', 'schemaVersion', 'lastScan'].forEach((k) => expect(pj).not.toContain(k));
  });

  it('I2 界面有未保存编辑 ⇒ **一个字节都不写**（`blocked-dirty`），并如实说明原因', () => {
    writeTree(SRC, { 'a.md': '# 甲书\n' });
    expect(run(['bind-sync', P, '--bind', '--dir', SRC]).code).toBe(0);
    expect(run(['bind-sync', P]).code).toBe(0);
    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书\n', 'utf8');
    const h = sha(projFile());
    const s = fs.readFileSync(stateFile(), 'utf8');
    // 造"界面正在跑且脏"的信号（**用那个模块自己的序列化**，不手写形状）
    const st = path.join(SANDBOX, P, uiState.FILE_NAME);
    fs.writeFileSync(st, uiState.serializeState({ project: P, dirty: true, uiPid: process.pid }), 'utf8');
    const j = JSON.parse(outOf(run(['bind-sync', P, '--json'])));
    expect(j.status).toBe('blocked-dirty');
    expect(j.sync[0].status).toBe('blocked-dirty');
    expect(j.sync[0].note).toContain('未保存编辑');
    expect(sha(projFile())).toBe(h);
    expect(fs.readFileSync(stateFile(), 'utf8')).toBe(s);
    // 界面不脏之后（同一条路再跑一次）⇒ 正常同步
    fs.writeFileSync(st, uiState.serializeState({ project: P, dirty: false, uiPid: process.pid }), 'utf8');
    const r2 = run(['bind-sync', P]);
    expect(r2.code, outOf(r2)).toBe(0);
    expect(sha(projFile())).not.toBe(h);
    expect(JSON.stringify(readProject())).toContain('乙书');
  });
});
