/* ============================================================
 * tests/heat.test.js — 访问热度（人 / AI 两条）：第一件「垂直切片」
 * 运行：npx vitest run tests/heat.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条都对着一个**能红**的判据；编号照 `.review/20261012-热度条/规格与裁决.md`）
 *   ① **排名而非绝对值**：同一节点访问次数 ×10 而名次不变 ⇒ 热度**不变**；名次上推 ⇒ 热度**变**
 *      （还顺带断言：名次动了以后**别的节点**的档位跟着动 —— 热度是名次的函数，不是次数的函数）；
 *   ② **窗口**：31 天前的事件**不计入**（带它 / 不带它的两条读数**逐字节相同**），边界正好 30 天算在内；
 *   ③ **两条分开**：人 / AI 计数互换 ⇒ 两条读数**不同**（证明人榜与 AI 榜各自算，不是同一份的复印）；
 *   ④ **失败响亮（F1）**：坏行 / 认不出的通道 / 时间乱序 / 未来时间戳 ⇒ **报错并非 0 退出、点名位置与原文**，
 *      绝不静默给一个看起来正常的榜；且"写入不受坏行影响、读取必须报错"这一对职责分开成立；
 *   ⑤ **注入证明**：把"名次→档位"的映射换成**直接返回绝对计数** ⇒ 判据①那条断言**必红** ⇒ 还原 ⇒ 复绿。
 *
 * 另有三条实现纪律的机械断言（规格 §二 的硬约束）：
 *   · **写入 O(1)**：记一次访问只发生**一次** `appendFileSync`，`readFileSync`/`readSync`/`writeFileSync` **零次**；
 *     并用"坏前缀逐字节不变 + 文件大小只涨一行"做字节级取证；
 *   · **窄查询**：只读文件**尾部**（`bytesRead` 远小于文件大小），而窄读与全量读给出**逐字节相同**的榜；
 *   · **口径只有一处**：命令层源码里不出现通道名 / 权重数字 / 日志文件名（出现即第二份会漂移的副本），
 *     且注入口 `__setHeatMapperForTest` 在 src/ · cli/ · renderer/ 里**除定义处外**没有别的引用。
 *
 * ## ⚠️ 两个环境要点（改这个文件前先读）
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好
 *      —— `cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的。这里先自证重定向生效，不生效当场红。
 *   2) **不起子进程**：进程内 `invokeSync`（与 tests/item-commands.test.js 同口径）。
 *
 * ## 一处**有意**的边界（写在这里免得被当成缺陷）
 *   时间戳的"未来"容差是 `heat.FUTURE_TOLERANCE_MS`（分钟级）：判据④里用"现在 + 5 分钟"造未来事件，
 *   用"现在 − 31 天"造窗口外事件 —— 两者都不依赖测试的执行时长（没有 sleep、没有真实等待）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-heat-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const registry = require('../cli/registry.js');
const heat = require('../src/heat.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/`（那是最坏的一类错误）。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = heat.DAY_MS;

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 沙箱删不掉不影响判定 */ }
});

/* ---------------- 夹具助手（沙箱内，进程内调用） ---------------- */

let seq = 0;
const run = (argv) => invokeSync(argv);
const logFile = (name) => path.join(SANDBOX, name, heat.FILE_NAME);
const cliFile = (name) => path.join(SANDBOX, name, name + '.json');

/** 建一个项目 + 三个节点（甲/乙/丙）——每次都是新项目名，测试之间互不干扰 */
function newProject() {
  const name = 'p' + (++seq);
  expect(run(['init', name]).code).toBe(0);
  ['node-a', 'node-b', 'node-c'].forEach((id) => {
    expect(run(['add', name, 'root', '--topic', id, '--id', id]).code).toBe(0);
  });
  return name;
}

/**
 * 把 `{通道: {节点: 次数}}` 写成事件（**按时间追加**：这里的顺序就是日志的时序不变量）。
 * 时间从 `baseMs` 起每条 +1 秒 ⇒ 非递减，且都在窗口内（除非调用方自己给窗口外的时间）。
 */
function writeSpec(name, spec, baseMs) {
  const events = [];
  Object.keys(spec).forEach((ch) => {
    Object.keys(spec[ch]).forEach((node) => {
      const n = spec[ch][node];
      for (let i = 0; i < n; i++) events.push({ node: node, ch: ch, atMs: 0 });
    });
  });
  events.forEach((e, i) => { e.atMs = baseMs + i * 1000; });
  const text = events.map((e) => heat.serializeEvent(heat.buildEvent({
    node: e.node, ch: e.ch, at: new Date(e.atMs).toISOString(), by: 'test'
  }))).join('');
  fs.appendFileSync(logFile(name), text, 'utf8');
  return events.length;
}

/** 直接往日志里塞**原文**（造坏行 / 造非法状态用；这是"手改日志"那条路，读方必须响亮报错） */
function writeRaw(name, text) { fs.appendFileSync(logFile(name), text, 'utf8'); }

function heatJson(name, extra) {
  const r = run(['heat', name, '--json'].concat(extra || []));
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}
const row = (list, node) => list.filter((x) => x.node === node)[0] || null;

/* ============================================================================
 * A. 通道权重表 —— 唯一一处定义（规格：一处实现 + 写清取值与理由）
 * ========================================================================== */

describe('A. 通道权重表（人 / AI 分列、按通道加权，且只有一处定义）', () => {
  it('A1 人侧只有一条通道：`human-detail`（= 打开详情框，裁决一）；AI 侧五条，各有理由', () => {
    const human = heat.CHANNELS.filter((c) => c.who === 'human');
    expect(human.map((c) => c.ch)).toEqual(['human-detail']);
    expect(human[0].weight).toBe(1);                 // 基准：其余权重是相对它的强度
    expect(heat.CHANNELS.filter((c) => c.who === 'ai').length).toBe(5);
    heat.CHANNELS.forEach((c) => {
      expect(c.reason && c.reason.length).toBeGreaterThan(10);   // 每条都必须写清理由
      expect(Number.isFinite(c.weight)).toBe(true);
      expect(c.weight).toBeGreaterThan(0);
      expect(['human', 'ai']).toContain(c.who);
    });
  });

  it('A2 强度次序是**有意排的**（ask > 直取 > 顺着关系 > 搜索命中 > 整页带出）', () => {
    const w = (ch) => heat.channelInfo(ch).weight;
    expect(w('ai-ask')).toBeGreaterThan(w('ai-get'));
    expect(w('ai-get')).toBeGreaterThan(w('ai-related-hop'));
    expect(w('ai-related-hop')).toBeGreaterThan(w('ai-search-hit'));
    expect(w('ai-search-hit')).toBeGreaterThan(w('ai-read-view'));
  });

  it('A3 「谁（人/AI）」由通道决定：写入端不许自报 —— 通道不认识就**响亮拒绝**（不静默记一条猜的）', () => {
    expect(() => heat.buildEvent({ node: 'node-a', ch: 'ai-telepathy' }))
      .toThrow(/未知通道/);
    // 报文要能照着改：列出全部合法通道与权重
    try { heat.buildEvent({ node: 'node-a', ch: '' }); } catch (e) {
      heat.CHANNEL_NAMES.forEach((ch) => expect(e.message).toContain(ch));
    }
    expect(heat.channelInfo('human-detail').who).toBe('human');
    expect(heat.channelInfo('ai-read-view').who).toBe('ai');
  });

  it('A4 通道加权真的改变 AI 榜：同一条数、不同通道 ⇒ 加权值不同（且排序按加权值）', () => {
    const now = Date.now();
    const mk = (evs) => evs.map((e, i) => ({
      at: new Date(now - 1000 + i).toISOString(), atMs: now - 1000 + i, node: e.node, ch: e.ch
    }));
    // 4 条低位通道 vs 2 条高位通道：加权值 0.4×4 = 1.6 < 1.5×2 = 3.0 ⇒ 后者排前面
    const h = heat.computeHeat(mk([
      { node: 'node-a', ch: 'ai-search-hit' }, { node: 'node-a', ch: 'ai-search-hit' },
      { node: 'node-a', ch: 'ai-search-hit' }, { node: 'node-a', ch: 'ai-search-hit' },
      { node: 'node-b', ch: 'ai-ask' }, { node: 'node-b', ch: 'ai-ask' }
    ]), { now: now });
    expect(row(h.ai, 'node-b').visits).toBe(2);
    expect(row(h.ai, 'node-b').weighted).toBe(3);
    expect(row(h.ai, 'node-a').visits).toBe(4);
    expect(row(h.ai, 'node-a').weighted).toBe(1.6);
    expect(h.ai[0].node).toBe('node-b');            // 加权值高的排前面（不是"事件条数高的"）
    expect(h.ai[0].rank).toBe(1);
  });

  it('A5 浮点定标：加权值**先定标再排名** —— 显示相同的两个数不许给出不同名次', () => {
    const now = Date.now();
    // 0.2 × 3 = 0.6000000000000001（浮点），而 0.6 × 1 = 0.6 —— 若不先定标，两者会判成不相等，
    // 于是"两条读数"里出现两个都显示 0.6 却名次不同的节点（说不清的名次）。
    const evs = [
      { node: 'node-a', ch: 'ai-read-view' }, { node: 'node-a', ch: 'ai-read-view' }, { node: 'node-a', ch: 'ai-read-view' },
      { node: 'node-b', ch: 'ai-related-hop' }
    ].map((e, i) => ({ at: new Date(now - 500 + i).toISOString(), atMs: now - 500 + i, node: e.node, ch: e.ch }));
    const h = heat.computeHeat(evs, { now: now });
    expect(h.ai.map((x) => x.weighted)).toEqual([0.6, 0.6]);
    expect(h.ai.map((x) => x.rank)).toEqual([1, 1]);       // 真并列 ⇒ 同名次、同档
    expect(h.ai.map((x) => x.heat)).toEqual([10, 10]);
  });
});

/* ============================================================================
 * B. 名次 → 档位（唯一一处映射）
 * ========================================================================== */

describe('B. 名次 → 档位（十档 1–10，只由名次决定）', () => {
  it('B1 档位只由 (名次, 样本量) 决定 —— 与次数的绝对值无关', () => {
    expect(heat.heatFromRank(1, 5)).toBe(10);
    expect(heat.heatFromRank(2, 5)).toBe(8);
    expect(heat.heatFromRank(5, 5)).toBe(2);
    // 同一个名次、同一个样本量 ⇒ 恒定（映射里没有第二个变量）
    [1, 2, 3, 10].forEach((r) => expect(heat.heatFromRank(r, 10)).toBe(heat.heatFromRank(r, 10)));
  });

  it('B2 单调不增 + 值域 [1,10] + 榜首恒 10（含 n=1 的边界：唯一节点也是榜首）', () => {
    for (let n = 1; n <= 40; n++) {
      expect(heat.heatFromRank(1, n)).toBe(10);
      for (let r = 1; r <= n; r++) {
        const v = heat.heatFromRank(r, n);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(heat.HEAT_BANDS);
        if (r < n) expect(v).toBeGreaterThanOrEqual(heat.heatFromRank(r + 1, n));
      }
    }
  });

  it('B3 样本少时档位会跳（n=1/2/3 的实际档位集）—— 这是"不许假装精确"的实现依据', () => {
    expect([1].map((r) => heat.heatFromRank(r, 1))).toEqual([10]);
    expect([1, 2].map((r) => heat.heatFromRank(r, 2))).toEqual([10, 5]);
    expect([1, 2, 3].map((r) => heat.heatFromRank(r, 3))).toEqual([10, 7, 4]);
  });

  it('B4 并列取**同一名次** ⇒ 同一档（并列不吃名次、也不按 id 抢位）', () => {
    const now = Date.now();
    const evs = ['node-a', 'node-b'].map((node, i) => ({
      at: new Date(now - 500 + i).toISOString(), atMs: now - 500 + i, node: node, ch: 'human-detail'
    }));
    const h = heat.computeHeat(evs, { now: now });
    expect(h.human.map((x) => x.rank)).toEqual([1, 1]);
    expect(h.human.map((x) => x.heat)).toEqual([10, 10]);
  });
});

/* ============================================================================
 * C. 窗口（纯计算：边界精确到毫秒）
 * ========================================================================== */

describe('C. 窗口 = 最近 30 天（滚动；只有这一处定义）', () => {
  it('C1 恰好 30 天前算在窗口内；早 1 毫秒就不算；未来 30 秒（容差内）算', () => {
    const now = Date.now();
    const mk = (t) => ({ at: new Date(t).toISOString(), atMs: t, node: 'node-a', ch: 'ai-get' });
    const h = heat.computeHeat([
      mk(now - heat.WINDOW_MS),            // 边界：在内
      mk(now - heat.WINDOW_MS - 1),        // 边界外 1 毫秒
      mk(now + 30 * 1000)                  // 写入/读取两次取时钟的微小差：在内
    ], { now: now });
    expect(h.sample.events).toBe(2);
    expect(h.sample.dropped).toBe(1);
    expect(heat.WINDOW_DAYS * DAY).toBe(heat.WINDOW_MS);
  });
});

/* ============================================================================
 * D. 判据① —— 排名而非绝对值（端到端：写日志 → heat 读）
 * ========================================================================== */

describe('D. 判据①：热度是**名次**的函数，不是次数的函数（端到端）', () => {
  it('D1 次数 ×10 而名次不变 ⇒ 热度**不变**；名次上推 ⇒ 热度**变**（并带动别人的档位）', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 20, 'node-b': 15, 'node-c': 1 } }, Date.now() - 6 * 60 * 60 * 1000);

    const r1 = heatJson(p);
    expect(r1.human.map((x) => [x.node, x.visits, x.rank, x.heat])).toEqual([
      ['node-a', 20, 1, 10], ['node-b', 15, 2, 7], ['node-c', 1, 3, 4]
    ]);

    // （i）node-c 的**绝对次数** ×10（1 → 10），但仍然少于 node-b(15) ⇒ 名次不变 ⇒ 热度不变
    writeSpec(p, { 'human-detail': { 'node-c': 9 } }, Date.now() - 3 * 60 * 60 * 1000);
    const r2 = heatJson(p);
    expect(row(r2.human, 'node-c').visits).toBe(10);
    expect(row(r2.human, 'node-c').rank).toBe(3);
    expect(row(r2.human, 'node-c').heat).toBe(4);            // ← 与 r1 相同（判据①的一半）
    expect(r2.human.map((x) => x.heat)).toEqual(r1.human.map((x) => x.heat));

    // （ii）再 ×10（10 → 100）⇒ 名次上推（3 → 1）⇒ 热度**变**，且别人跟着下沉一档
    writeSpec(p, { 'human-detail': { 'node-c': 90 } }, Date.now() - 2 * 60 * 60 * 1000);
    const r3 = heatJson(p);
    expect(row(r3.human, 'node-c').visits).toBe(100);
    expect(row(r3.human, 'node-c').rank).toBe(1);
    expect(row(r3.human, 'node-c').heat).toBe(10);           // ← 变了（判据①的另一半）
    expect(row(r3.human, 'node-a').rank).toBe(2);
    expect(row(r3.human, 'node-a').heat).toBe(7);
    expect(row(r3.human, 'node-b').heat).toBe(4);
  });
});

/* ============================================================================
 * E. 判据② —— 窗口（端到端：31 天前的事件不计入）
 * ========================================================================== */

describe('E. 判据②：31 天前的事件不计入（读数回到不含它的值）', () => {
  it('E1 带它 / 不带它，两条榜**逐字节相同**（它确实没被算进去）', () => {
    const p1 = newProject();
    writeSpec(p1, { 'human-detail': { 'node-a': 2, 'node-b': 1 } }, Date.now() - 2 * 60 * 60 * 1000);

    const p2 = newProject();
    const oldAt = Date.now() - 31 * DAY;                     // 31 天前：窗口外
    writeSpec(p2, { 'human-detail': { 'node-c': 1 } }, oldAt);
    writeSpec(p2, { 'human-detail': { 'node-a': 2, 'node-b': 1 } }, Date.now() - 2 * 60 * 60 * 1000);

    const r1 = heatJson(p1);
    const r2 = heatJson(p2);
    expect(JSON.stringify(r2.human)).toBe(JSON.stringify(r1.human));    // ← 判据②
    expect(JSON.stringify(r2.ai)).toBe(JSON.stringify(r1.ai));
    expect(r2.sample.events).toBe(3);                        // 3 条在窗口内
    expect(r2.sample.dropped).toBe(1);                       // 那一条窗口外的被丢弃（如实报数）
    expect(row(r2.human, 'node-c')).toBeNull();              // 窗口外访问的节点**不进榜**

    const text = run(['heat', p2]).stdout;
    expect(text).toContain('窗口外丢弃 1 条');
  });
});

/* ============================================================================
 * F. 判据③ —— 人 / AI 两条分开
 * ========================================================================== */

describe('F. 判据③：人 / AI 两条各自算（计数互换 ⇒ 两条读数都变）', () => {
  it('F1 同一节点人 vs AI 的榜首不同 ⇒ 两条读数不同；把人 / AI 计数互换 ⇒ 两条都反过来', () => {
    const p1 = newProject();
    writeSpec(p1, { 'human-detail': { 'node-a': 3, 'node-b': 1 }, 'ai-get': { 'node-a': 1, 'node-b': 3 } },
      Date.now() - 3 * 60 * 60 * 1000);
    const r1 = heatJson(p1);
    expect(r1.human[0].node).toBe('node-a');
    expect(r1.ai[0].node).toBe('node-b');
    expect(JSON.stringify(r1.human)).not.toBe(JSON.stringify(r1.ai));   // 两条真的分开

    const p2 = newProject();                                  // ← 计数互换
    writeSpec(p2, { 'human-detail': { 'node-a': 1, 'node-b': 3 }, 'ai-get': { 'node-a': 3, 'node-b': 1 } },
      Date.now() - 3 * 60 * 60 * 1000);
    const r2 = heatJson(p2);
    expect(r2.human[0].node).toBe('node-b');
    expect(r2.ai[0].node).toBe('node-a');
    expect(JSON.stringify(r2.human)).not.toBe(JSON.stringify(r1.human));
    expect(JSON.stringify(r2.ai)).not.toBe(JSON.stringify(r1.ai));
  });
});

/* ============================================================================
 * G. 判据④ —— 失败响亮（F1）
 * ========================================================================== */

describe('G. 判据④：日志出问题 ⇒ 报错并非 0 退出、点名，**绝不静默当 0**', () => {
  it('G1 坏行：非 0 退出 + 点名"第几行 / 字节偏移 / 原文"，且不打印任何看起来正常的榜', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 1 } }, Date.now() - 60 * 1000);
    writeRaw(p, '{"v":1,"at":"2026-10-11T00:00:00.000Z","node":"node-b","ch":\n');   // 第 2 行：截断的 JSON

    const r = run(['heat', p]);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
    expect(r.stdout).toContain('坏行');
    expect(r.stdout).toContain('第 2 行');                    // ← 点名位置
    expect(r.stdout).toContain('ch');                          // ← 原文片段
    expect(r.stdout).toContain('不等于');                      // ← "采不到 ≠ 热度 0"
    expect(r.stdout).not.toContain('人榜');                    // ← 没有给出任何"看起来正常"的读数
  });

  it('G2 认不出的通道：点名那条通道（不许自行加权、也不许当 0）', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 1 } }, Date.now() - 60 * 1000);
    writeRaw(p, heat.serializeEvent({ v: 1, at: new Date().toISOString(), node: 'node-b', ch: 'ai-telepathy' }));

    const r = run(['heat', p, '--json']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('认不出的通道');
    expect(r.stdout).toContain('ai-telepathy');
  });

  it('G3 时间乱序：报错并给出"前一条 / 本条"两个时间（窄查询的前提被破坏了）', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 1 } }, Date.now() - 60 * 1000);
    writeRaw(p, heat.serializeEvent({
      v: 1, at: new Date(Date.now() - 5 * DAY).toISOString(), node: 'node-b', ch: 'human-detail'
    }));

    const r = run(['heat', p]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('时间乱序');
    expect(r.stdout).toContain('node-b');
  });

  it('G4 未来时间戳（时钟回拨 / 手改日志）：报错并点名那条 at', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 1 } }, Date.now() - 60 * 1000);
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    writeRaw(p, heat.serializeEvent({ v: 1, at: future, node: 'node-b', ch: 'human-detail' }));

    const r = run(['heat', p]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('未来时间戳');
    expect(r.stdout).toContain(future);
  });

  it('G5 写入与读取的职责分开：日志坏了照样能**追加**（O(1) 不读日志），但**读**必须报错', () => {
    const p = newProject();
    writeRaw(p, '这一行根本不是 JSON\n');
    const w = run(['visit', p, 'node-a', '--channel', 'ai-get']);
    expect(w.code).toBe(0);                                   // 写入不读日志 ⇒ 不受坏行影响
    expect(fs.readFileSync(logFile(p), 'utf8').split('\n').filter(Boolean).length).toBe(2);
    const r = run(['heat', p]);
    expect(r.code).toBe(1);                                   // 读必须响亮
    expect(r.stdout).toContain('坏行');
  });

  it('G6 本机没有日志：**不报错**，但必须明说"没有访问日志（≠ 热度为 0）"', () => {
    const p = newProject();
    const r = run(['heat', p, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.hasLog).toBe(false);
    expect(j.note).toContain('不等于');
  });
});

/* ============================================================================
 * H. 写入 O(1)（规格 §二 硬要求）—— 机械取证
 * ========================================================================== */

/** 计数用的 fs 代理：`src/heat.js` 与本测试 require 到的是**同一个** fs 模块对象 ⇒ 计数有效 */
function spyFs() {
  const keys = ['readFileSync', 'readSync', 'writeFileSync', 'appendFileSync', 'openSync', 'renameSync'];
  const counters = {};
  const orig = {};
  keys.forEach((k) => {
    counters[k] = 0;
    orig[k] = fs[k];
    fs[k] = function () { counters[k]++; return orig[k].apply(fs, arguments); };
  });
  return {
    counters: counters,
    restore() { keys.forEach((k) => { fs[k] = orig[k]; }); }
  };
}

describe('H. 写入 O(1)：只追加一行，不读全量、不重写文件（机械取证）', () => {
  it('H1 记一次访问 = 1 次 appendFileSync；readFileSync / readSync / writeFileSync / renameSync **零次**', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 1 } }, Date.now() - 60 * 1000);
    const spy = spyFs();
    try {
      const r = heat.appendEvent(logFile(p), { node: 'node-b', ch: 'ai-get', by: 'test' });
      expect(r.bytes).toBe(Buffer.byteLength(r.line, 'utf8'));
    } finally {
      spy.restore();
    }
    expect(spy.counters.appendFileSync).toBe(1);
    expect(spy.counters.readFileSync).toBe(0);
    expect(spy.counters.readSync).toBe(0);
    expect(spy.counters.renameSync).toBe(0);                  // 没有"整份原子重写"
    // `writeFileSync` 会跟着 +1：**实测**（探针，node 24.19.0）Node 的 `appendFileSync` 内部就是
    // `writeFileSync(path, data, {flag:'a'})` —— 所以它证明不了"没重写"。真正判"没重写"的是 H2 的
    // 字节级取证（坏前缀逐字节不变 + 文件只涨一行），以及这里的"零读取"。
    expect(spy.counters.writeFileSync).toBe(1);
  });

  it('H2 字节级：坏前缀**逐字节不变**，文件只涨"一行"的大小（重写 / 读全量都做不到这一点）', () => {
    const p = newProject();
    const poison = '{"v":1,"at":"懒得写了"\n';                 // 既不是合法 JSON，也不是合法形状
    writeRaw(p, poison);
    const before = fs.readFileSync(logFile(p));
    const r = heat.appendEvent(logFile(p), { node: 'node-a', ch: 'ai-ask', by: 'test' });

    const after = fs.readFileSync(logFile(p));
    expect(after.length).toBe(before.length + r.bytes);        // ← 恰好涨一行
    expect(after.subarray(0, before.length).equals(before)).toBe(true);   // ← 前缀逐字节不变

    // 而读它必须报错（写入不校验历史 —— 这是有意的取舍，见 src/heat.js 文件头）
    expect(() => heat.readHeatFile(logFile(p), { now: Date.now() })).toThrow(/坏行/);
  });

  it('H3 端到端：连续 5 次 `visit` ⇒ 日志恰好 5 行、且每行都是合法事件（读得出来）', () => {
    const p = newProject();
    const chs = ['human-detail', 'ai-get', 'ai-ask', 'ai-search-hit', 'ai-read-view'];
    chs.forEach((ch) => expect(run(['visit', p, 'node-a', '--channel', ch]).code).toBe(0));
    const lines = fs.readFileSync(logFile(p), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(5);
    const j = heatJson(p);
    expect(j.sample.events).toBe(5);
    expect(j.sample.humanEvents).toBe(1);
    expect(j.sample.aiEvents).toBe(4);
  });
});

/* ============================================================================
 * I. 窄查询（规格 §二 硬要求）：只读尾部，且与全量读**逐字节一致**
 * ========================================================================== */

describe('I. 读热度走窄查询：只读尾部，而结果与全量读逐字节相同', () => {
  it('I1 大日志（窗口外前缀 ~3.8 MB）⇒ 只读了 64 KB 量级；窄读与全量读的两条榜**完全一致**', () => {
    const p = newProject();
    // 窗口外前缀：40 天前的 40000 条事件（~95 字节/行 ≈ 3.8 MB）
    const oldLine = heat.serializeEvent(heat.buildEvent({
      node: 'node-a', ch: 'ai-read-view', at: new Date(Date.now() - 40 * DAY).toISOString(), by: 'test'
    }));
    fs.appendFileSync(logFile(p), oldLine.repeat(40000), 'utf8');
    writeSpec(p, { 'human-detail': { 'node-a': 2, 'node-b': 1 }, 'ai-ask': { 'node-b': 1 } }, Date.now() - 60 * 1000);

    const now = Date.now();
    const narrow = heat.readHeatFile(logFile(p), { now: now });
    const full = heat.readHeatFile(logFile(p), { now: now, full: true });

    expect(narrow.log.fileBytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(narrow.log.complete).toBe(false);                  // ← 真的只读了尾部
    expect(narrow.log.bytesRead).toBeLessThan(narrow.log.fileBytes / 8);
    expect(full.log.complete).toBe(true);
    // **两条榜**逐字节相同（精确，不是近似）：窗口/样本/排名/档位/通道贡献全都一样
    expect(JSON.stringify(narrow.heat.human)).toBe(JSON.stringify(full.heat.human));
    expect(JSON.stringify(narrow.heat.ai)).toBe(JSON.stringify(full.heat.ai));
    expect(narrow.heat.sample.events).toBe(4);
    expect(narrow.heat.sample.nodes).toBe(2);
    // ⚠️ 唯一的差异是 `dropped`：它统计的是"**本次读到**的事件里被窗口排除的条数" ——
    //    窄读只读到尾部约 690 条旧的，全量读读到 40000 条。这不是读数不一致，而是**读区范围**不同；
    //    所以 `log.windowComplete` 必须一起给出来（本文件 G6/H3 与命令输出都靠它说清边界）。
    expect(narrow.heat.sample.dropped).toBeLessThan(full.heat.sample.dropped);
    expect(full.heat.sample.dropped).toBe(40000);
  });

  it('I2 窗口读不完（上限被踩到）⇒ **响亮报错**，不给半份读数', () => {
    const p = newProject();
    // 全在窗口内的一大段（~190 KB），而 maxBytes 压到 4 KB ⇒ 读不完
    writeSpec(p, { 'human-detail': { 'node-a': 2000 } }, Date.now() - 60 * 60 * 1000);
    expect(() => heat.readHeatFile(logFile(p), { now: Date.now(), maxBytes: 4096 }))
      .toThrow(/窗口读不完|MAX_READ_BYTES/);
  });
});

/* ============================================================================
 * J. 判据⑤ —— 注入证明（映射改成"直接返回绝对计数" ⇒ 判据①必红）
 * ========================================================================== */

describe('J. 判据⑤：注入证明（这条判据有判别力，不是恒真）', () => {
  it('J1 换成"档位 = 绝对次数" ⇒ 判据①那条断言**必红**；还原 ⇒ 复绿', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 20, 'node-b': 15, 'node-c': 1 } }, Date.now() - 6 * 60 * 60 * 1000);
    writeSpec(p, { 'human-detail': { 'node-c': 9 } }, Date.now() - 3 * 60 * 60 * 1000);   // c: 1 → 10（名次不变）

    const before = heatJson(p);
    const c1 = row(before.human, 'node-c');
    expect([c1.visits, c1.rank, c1.heat]).toEqual([10, 3, 4]);

    /* ---- 注入：把"名次→档位"换成直接返回绝对计数（等价于"热度 = 绝对值"这个错误口径） ---- */
    heat.__setHeatMapperForTest((info) => info.count);
    let failure = null;
    try {
      const injected = heatJson(p);
      expect(row(injected.human, 'node-c').heat).toBe(c1.heat);   // ← 这一行**应当**失败
    } catch (err) {
      failure = err;
    } finally {
      heat.__resetHeatMapperForTest();
    }
    expect(failure).not.toBeNull();                                // 真的红了（判据有判别力）
    expect(String(failure && failure.message)).toMatch(/expected 10 to be 4|expected .* to be 4/);

    /* ---- 还原 ⇒ 复绿 ---- */
    const after = heatJson(p);
    expect(JSON.stringify(after.human)).toBe(JSON.stringify(before.human));
    expect(row(after.human, 'node-c').heat).toBe(4);
  });

  it('J2 注入口在**生产代码**里没有引用（除定义处）—— 它不是一条能被人误触的开关', () => {
    const hits = [];
    const walk = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        if (!/\.js$/.test(e.name)) return;
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        if (rel === 'src/heat.js') return;                         // 定义处
        if (fs.readFileSync(abs, 'utf8').includes('__setHeatMapperForTest')) hits.push(rel);
      });
    };
    ['src', 'cli', 'renderer'].forEach((d) => {
      if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    });
    expect(hits).toEqual([]);
  });
});

/* ============================================================================
 * K. 端到端读数形状：样本量如实暴露 / 已删节点如实标出 / 截断不影响名次
 * ========================================================================== */

describe('K. 端到端读数：如实暴露样本量，不假装精确', () => {
  it('K1 `heat --json` 的形状：窗口 / 样本 / 两条榜 / 通道贡献 / 权重表都在，权重与模块表一致', () => {
    const p = newProject();
    writeSpec(p, {
      'human-detail': { 'node-a': 2, 'node-b': 1 },
      'ai-get': { 'node-a': 1 }, 'ai-ask': { 'node-c': 1 }
    }, Date.now() - 3 * 60 * 60 * 1000);
    const j = heatJson(p);

    expect(j.project).toBe(p);
    expect(j.hasLog).toBe(true);
    expect(j.window.days).toBe(heat.WINDOW_DAYS);
    expect(j.sample).toEqual({ events: 5, dropped: 0, nodes: 3, humanEvents: 3, aiEvents: 2 });
    // 两条榜各自 n=2（人：a=2/b=1；AI：c 加权 1.5/a 加权 1）⇒ 只用到 10/5 两档
    expect(j.bands).toEqual([10, 5]);

    // 权重表逐项与模块一致（命令层没有第二份数字）
    heat.CHANNELS.forEach((c) => {
      expect(j.weights[c.ch]).toEqual({ who: c.who, weight: c.weight });
    });
    // 通道贡献 × 权重 == 节点的加权值（可核算）
    const w = (ch) => j.weights[ch].weight;
    const a = row(j.ai, 'node-a');
    expect(a.visits).toBe(1);
    expect(a.weighted).toBe(w('ai-get'));
    const c = row(j.ai, 'node-c');
    expect(c.weighted).toBe(w('ai-ask'));
  });

  it('K2 已删/不存在的节点：如实标出 `missing`（访问确实发生过，不假装它还在、也不静默丢掉）', () => {
    const p = newProject();
    expect(run(['visit', p, 'ghost-node', '--channel', 'ai-get']).code).toBe(0);   // 有意不校验存在性
    const j = heatJson(p);
    const g = row(j.ai, 'ghost-node');
    expect(g).not.toBeNull();
    expect(g.missing).toBe(true);
    expect(g.topic).toBeNull();
    const text = run(['heat', p]).stdout;
    expect(text).toContain('节点已不存在');
  });

  it('K3 `--limit` 只截断**显示**：热度仍按全量排名算（名次与档位不因截断而变）', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 5, 'node-b': 3, 'node-c': 1 } }, Date.now() - 60 * 60 * 1000);
    const full = heatJson(p);
    const ltd = heatJson(p, ['--limit', '1']);
    expect(ltd.human.length).toBe(1);
    expect(ltd.limit).toMatchObject({ limit: 1, totalHuman: 3, shownHuman: 1 });
    expect(JSON.stringify(ltd.human[0])).toBe(JSON.stringify(full.human[0]));
    const text = run(['heat', p, '--limit', '1']).stdout;
    expect(text).toContain('只截断显示');
    expect(text).toContain('热度 10/10');
  });

  it('K4 坏参数/坏用法一律响亮：`--limit abc`、`visit` 不给 `--channel`、`visit` 带 `--at`（有意不支持）', () => {
    const p = newProject();
    expect(run(['heat', p, '--limit', 'abc']).code).toBe(1);
    const noCh = run(['visit', p, 'node-a']);
    expect(noCh.code).toBe(1);
    expect(noCh.stdout).toContain('--channel');
    expect(noCh.stdout).toContain('human-detail');            // 报错即教程：列出合法通道
    const withAt = run(['visit', p, 'node-a', '--channel', 'ai-get', '--at', '2020-01-01T00:00:00.000Z']);
    expect(withAt.code).toBe(1);
    expect(withAt.stdout).toContain('--at');                  // 一次访问不该有两个时间
  });

  it('K5 项目不存在：`heat` / `visit` 都报"项目不存在"，不是给一份空榜', () => {
    const a = run(['heat', 'no-such-project-heat-xyz']);
    expect(a.code).toBe(1);
    expect(a.stdout).toContain('项目不存在');
    const b = run(['visit', 'no-such-project-heat-xyz', 'node-a', '--channel', 'ai-get']);
    expect(b.code).toBe(1);
    expect(b.stdout).toContain('项目不存在');
  });
});

/* ============================================================================
 * L. 口径只有一处 + 登记（改这几条时先想清楚"是不是又抄了一份"）
 * ========================================================================== */

describe('L. 定义只有一处（命令层不抄口径）', () => {
  it('L1 `cli/commands/heat.js` 里不出现通道名 / 权重数字 / 日志文件名 —— 出现即第二份会漂移的副本', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'heat.js'), 'utf8');
    expect(src).not.toContain(heat.FILE_NAME);
    heat.CHANNEL_NAMES.forEach((ch) => expect(src).not.toContain(ch));
    ['1.5', '0.6', '0.4', '0.2'].forEach((num) => {
      expect(src.includes(num)).toBe(false);
    });
    expect(src).toContain('CHANNELS');                        // 要打印就**现取**表（不是抄表）
  });

  it('L2 两条命令都在 registry 里，且用法串里的选项与声明一一对上', () => {
    const visit = registry.get('visit');
    const heatCmd = registry.get('heat');
    expect(visit && typeof visit.fn).toBe('function');
    expect(heatCmd && typeof heatCmd.fn).toBe('function');
    [visit, heatCmd].forEach((c) => {
      const tokens = [...c.usage.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]);
      expect(tokens.map((t) => core.optionKey(t)).sort()).toEqual(c.options.slice().sort());
    });
    expect(visit.usage.startsWith('visit <项目> <节点id> --channel')).toBe(true);
    expect(heatCmd.usage.startsWith('heat <项目>')).toBe(true);
  });

  it('L3 日志是**旁路产物**：不进项目 JSON（项目文件里没有任何访问流水）', () => {
    const p = newProject();
    writeSpec(p, { 'human-detail': { 'node-a': 3 } }, Date.now() - 60 * 1000);
    const data = JSON.parse(fs.readFileSync(cliFile(p), 'utf8'));
    expect(JSON.stringify(data)).not.toContain('human-detail');
    expect(JSON.stringify(data)).not.toContain('visits');
    // 而真相在 sidecar 里（同 `.changes.jsonl` 的规矩：点文件、一行一条、可随手删）
    expect(fs.existsSync(logFile(p))).toBe(true);
    expect(heat.FILE_NAME.startsWith('.')).toBe(true);
  });
});
