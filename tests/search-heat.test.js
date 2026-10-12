/* ============================================================
 * tests/search-heat.test.js — 热度条第二件：热度作为**一个封顶向量**进 `search` 排序
 * 运行：npx vitest run tests/search-heat.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条对着 `.review/20261012-热度条/规格与裁决.md` 的一条判据）
 *   ① **封顶可测**：把某节点热度拉满 ⇒ 顺序**真的变了**（不然判据是恒真的空话），
 *      而位移**不超过封顶比例**（两条口径都钉：权重份额 ≤ merged、位移 ≤ `maxJump(n)`）；
 *   ② **人 / AI 两条都真进、且权重不同**：同一节点"人热 AI 冷" vs "人冷 AI 热" ⇒ **顺序不同**；
 *      两条都拉满 ⇒ 合并上限**真的在压**（boost == merged < human + ai）；
 *   ③ **同源**：CLI `search` 与 MCP `search_nodes` 对**同一份数据**逐条同序（MCP 走真子进程）；
 *      外加**结构断言**："热度数值只有一处、排序实现只有一处"；
 *   ④ **取舍**：热度只排序 —— 命中集合（多重集）与 `hitCount` 不因热度改变；`--limit` 的
 *      截断语义照旧（截断可见 + 提高 limit 就能取到低热度的命中，可检索性没被挤掉）；
 *   ⑤ **注入证明**（可重复执行，不是"手改源码跑一次"）：
 *      `merged → 1.0` ⇒ 判据①的位移上限断言**必红**；`ai → 等于 human` ⇒ 判据②**必红**；还原 ⇒ 复绿；
 *   ⑥ **性能**：热度读取只走窄查询 —— 3.8 MB 的日志里只读**尾部一个 chunk**（fs 计数 + readSync
 *      的字节偏移与长度**字节级**取证），而且 `search` 全程零次 `appendFileSync` / `writeFileSync`。
 *
 * 另有一条**有意**钉住的边界（免得被当成缺陷）：命中数 n ≤ 11 时热度**不可能**改变任何顺序
 * （`maxJump(11) === 0`）—— 那是"热度只占总分 ≤ 8%"的直接推论，不是热度没生效。
 *
 * ## ⚠️ 两个环境要点（与 tests/heat.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好（`cli/core.js` 的
 *      `PROJECTS_DIR` 是模块加载时定型的），并**当场自证**重定向生效 —— 否则夹具会建进真实 projects/；
 *   2) 不起子进程（进程内 `invokeSync`），**唯一例外**是判据③那条 MCP 断言（MCP 本身就是转发到
 *      CLI 子进程的，那正是要证明的"同源"路径）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-search-heat-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const heat = require('../src/heat.js');
const heatSensor = require('../src/heat-sensor.js');
const itemIndex = require('../src/item-index.js');
const mcp = require('../scripts/mcp-server.js');

/* ----------------------------------------------------------------------------
 * **夹具自造日志 ⇒ 关掉自动埋点**（理由与 tests/heat.test.js 同一条，逐字见那里）：
 * 本文件的每条判据都假定"日志里只有我写的那些事件"（零写断言、sample.events、
 * 窄读的 readSync 计数…），而第三件起 `search` 会顺手把命中记进同一份日志（产品行为）。
 * 自动埋点自己的判据在 `tests/heat-sensor.test.js`（那里**不**关它）。
 * -------------------------------------------------------------------------- */
heatSensor.__setEnabledForTest(false);

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KW = '闸门';

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 沙箱删不掉不影响判定 */ }
});

/* ---------------- 夹具 ---------------- */

let seq = 0;
const run = (argv) => invokeSync(argv);
/**
 * 访问日志的**真位置**：`<项目根>/.visits/<项目名>.jsonl`（在项目目录**之外**）。
 * 与 tests/heat.test.js 同一条纪律：**只经 `store.visitLogFile` 推路径**，不自己拼 ——
 * 拼错的那一版在日志搬家后整片假红（红的原因是夹具指错地方）。
 */
const store = require('../src/data-store.js').createStore(SANDBOX);
const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const logFile = (name) => store.visitLogFile(name);

/**
 * 造一个项目：root 下 count 个**都含关键词**的节点（`nd-1…nd-count`）。
 * 命中顺序就是 DFS 序 ⇒ 基线顺序 = `nd-1 … nd-count`（这样"位移"才有确定的方向）。
 */
function fixture(count) {
  const name = 'p' + (++seq);
  const children = [];
  for (let i = 1; i <= count; i++) {
    children.push({ id: 'nd-' + i, topic: KW + ' 第 ' + i + ' 个节点', children: [] });
  }
  fs.mkdirSync(path.join(SANDBOX, name), { recursive: true });
  fs.writeFileSync(projFile(name), JSON.stringify({
    meta: { name: name, author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'root', expanded: true, children: children }
  }, null, 2), 'utf8');
  return name;
}

/** 记 n 次访问（走 `visit` 端到端：通道决定谁（人/AI），时间取写入时刻 ⇒ 时序不变量天然成立） */
function visits(name, node, ch, times) {
  for (let i = 0; i < times; i++) {
    const r = run(['visit', name, node, '--channel', ch]);
    expect(r.code, 'visit 失败：' + r.stdout).toBe(0);
  }
}

function searchJson(name, extra) {
  const r = run(['search', name, KW, '--json'].concat(extra || []));
  expect(r.code, 'search 失败：' + r.stdout).toBe(0);
  return JSON.parse(r.stdout);
}

/** 命中 → 稳定键（节点 + 条目）；顺序就在这个数组里 */
const ids = (j) => j.hits.map((h) => h.nodeId + (h.itemId ? '#' + h.itemId : ''));

/** 位置位移：a = 基线顺序、b = 加热度后的顺序 ⇒ 某个命中最多挪了几个位置 */
function displacement(a, b) {
  const pos = new Map(b.map((k, i) => [k, i]));
  let max = 0;
  a.forEach((k, i) => {
    const j = pos.get(k);
    if (j !== undefined) max = Math.max(max, Math.abs(i - j));
  });
  return max;
}

/**
 * 判据①的对照实验：新建一个 count 个命中的项目 ⇒ 基线顺序 ⇒ 把第 `hot` 个节点热度拉满 ⇒ 再取顺序。
 * 每次都新建（日志只追加，热度无法"取消"）。
 */
function measure(count, hotIndex, ch, times) {
  const name = fixture(count);
  const base = ids(searchJson(name));
  visits(name, 'nd-' + hotIndex, ch, times || 1);
  const after = ids(searchJson(name));
  return { name: name, n: base.length, base: base, after: after, moved: displacement(base, after),
    heat: searchJson(name).heat };
}

/** 计数 + 记参数的 fs 代理（`src/heat.js` 与本测试 require 到的是同一个 fs 模块对象 ⇒ 计数有效） */
function spyFs() {
  const keys = ['readFileSync', 'readSync', 'writeFileSync', 'appendFileSync', 'openSync', 'renameSync', 'existsSync'];
  const counters = {};
  const calls = { readFileSync: [], openSync: [], readSync: [], existsSync: [] };
  const orig = {};
  keys.forEach((k) => {
    counters[k] = 0;
    orig[k] = fs[k];
    fs[k] = function () {
      counters[k]++;
      if (k === 'readFileSync' || k === 'openSync' || k === 'existsSync') calls[k].push(String(arguments[0]));
      if (k === 'readSync') calls.readSync.push({ fd: arguments[0], length: arguments[3], position: arguments[4] });
      return orig[k].apply(fs, arguments);
    };
  });
  return {
    counters: counters, calls: calls,
    /** 这些调用里，有几条是冲着**访问日志**去的。
     *  ⚠️ 判据不能写成 `endsWith(heat.FILE_NAME)`：日志现在住在 `<项目根>/.visits/<项目名>.jsonl`
     *  （**项目目录之外**，见 `src/data-store.js` 的 `visitLogFile`），文件名不再叫 `.visits.jsonl`。
     *  口径改成"**路径里带那个点目录**" —— 它同时覆盖了"日志住哪儿"这件事（搬回去就会红）。 */
    ofLog(p) {
      const pick = (arr) => arr.filter((x) => String(x).indexOf(path.sep + '.visits' + path.sep) >= 0);
      return {
        readFileSync: pick(calls.readFileSync), openSync: pick(calls.openSync),
        existsSync: pick(calls.existsSync), file: p
      };
    },
    restore() { keys.forEach((k) => { fs[k] = orig[k]; }); }
  };
}

/** 遍历给定根的源码文件（结构断言用） */
function walkJs(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isFile()) { if (rel.endsWith('.js')) out.push(rel); return out; }
  fs.readdirSync(abs, { withFileTypes: true }).forEach((e) => {
    const r = rel + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkJs(r, out); return; }
    if (e.name.endsWith('.js')) out.push(r);
  });
  return out;
}
/**
 * 结构断言要扫的**生产文件**：可能实现"检索排序"的地方 —— `src/`、`cli/`、`renderer/`、
 * `main.js` / `preload.js`，以及 `scripts/` 顶层（MCP 包装、集成脚本）。
 * ⚠️ `scripts/smoke/**` 是**界面冒烟探针**（不参与检索）：那里 `0.06` 是个坐标步长，
 * 把它算成"第二份权重"是假红 —— 所以递归只对前四个目录做。
 */
const PROD_FILES = ['src', 'cli', 'renderer']
  .reduce((acc, r) => walkJs(r, acc), [])
  .concat(fs.readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => 'scripts/' + e.name))
  .concat(['main.js', 'preload.js'].filter((r) => fs.existsSync(path.join(ROOT, r))));

/* ============================================================================
 * A. 三条上限（人 / AI / 合并）—— 取值、关系、以及"只有一处"
 * ========================================================================== */

describe('A. 三条上限：人 / AI / 合并（规格 §一.2 §一.3）', () => {
  it('A1 关系成立：0 < ai < human ≤ merged ≤ 10%，且 merged < human + ai（合并上限**真的在压**）', () => {
    const w = heat.SEARCH_RANK;
    expect(w.ai).toBeGreaterThan(0);
    expect(w.human).toBeGreaterThan(w.ai);              // 裁决三：AI 那条权重更低
    expect(w.merged).toBeGreaterThanOrEqual(w.human);
    expect(w.merged).toBeLessThanOrEqual(0.10);         // 规格硬上限：≤10%
    // 取 0.09（= 前两条之和）会让"合并上限"退化成别名 ⇒ 那条判决没人守；这里钉住它 **小于** 和
    expect(w.human + w.ai).toBeGreaterThan(w.merged);
  });

  it('A2 位移上界也在 10% 以内（**推出来的**那条口径，与权重份额是两条独立口径）', () => {
    const c = heat.SEARCH_RANK.merged;
    expect(c / (1 - c)).toBeLessThanOrEqual(0.10);      // 位移的比例上界 = merged/(1-merged)
    // 逐个 n 复核"位置数上界 / (n-1)"：从 n=1 到 2000 都不许超过 10%
    for (let n = 1; n <= 2000; n++) {
      const j = heat.maxJump(n);
      expect(Number.isFinite(j)).toBe(true);
      if (n > 1) expect(j / (n - 1), 'n=' + n).toBeLessThanOrEqual(0.10);
    }
    expect(heat.maxJump(11)).toBe(0);                   // n ≤ 11 时位移上界为 0（见文件头那条边界）
    expect(heat.maxJump(12)).toBeGreaterThanOrEqual(1); // n=12 起才可能出现位移
  });

  it('A3 结构断言：三条数值只在 `src/heat.js` 出现（别处再写一份 ⇒ 必红）', () => {
    const w = heat.SEARCH_RANK;
    const literals = [String(w.human), String(w.ai), String(w.merged)];
    const hits = PROD_FILES.filter((rel) => {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      return literals.some((x) => text.indexOf(x) >= 0);
    });
    expect(hits).toEqual(['src/heat.js']);
    // 数值不许被抄进纯逻辑层 / MCP 层（"别处再写一份"就体现在这三串数字上 ——
    // 纯逻辑层只接受调用方给的 {scale, byNode}，MCP 层只拼 CLI 参数）
    ['src/item-index.js', 'scripts/mcp-server.js'].forEach((rel) => {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      literals.forEach((x) => expect(text.indexOf(x), rel + ' 里出现了 ' + x).toBe(-1));
    });
  });

  it('A4 结构断言：排序实现只有一处（`orderByHeat` 只在 src/item-index.js；`searchBoost(` 只有定义处 + 命令层一个调用点）', () => {
    const countIn = (needle) => PROD_FILES.filter((rel) =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').indexOf(needle) >= 0);
    expect(countIn('function orderByHeat')).toEqual(['src/item-index.js']);
    expect(countIn('orderByHeat(')).toEqual(['src/item-index.js']);
    expect(countIn('function searchBoost(')).toEqual(['src/heat.js']);          // 定义处
    expect(countIn('heat.searchBoost(')).toEqual(['cli/commands/project.js']);  // 唯一调用点
    const calls = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'project.js'), 'utf8').split('heat.searchBoost(').length - 1;
    expect(calls).toBe(1);
    // CLI 与 MCP 走的是**同一条**路：MCP 侧只拼 CLI 参数，没有任何打分
    const mcpText = fs.readFileSync(path.join(ROOT, 'scripts', 'mcp-server.js'), 'utf8');
    expect(mcpText).toContain("case 'search_nodes'");
    expect(mcpText).toContain("['search', argOf('project')]");
  });

  it('A5 注入口 `__setSearchRankForTest` 在生产代码里没有引用（除定义处）—— 不是能被人误触的开关', () => {
    const refs = PROD_FILES.filter((rel) =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').indexOf('__setSearchRankForTest') >= 0);
    expect(refs).toEqual(['src/heat.js']);
    expect(typeof heat.__resetSearchRankForTest).toBe('function');
  });

  it('A6 `searchBoost`：两条榜折成一个封顶加数（人热 / AI 热 / 两条都热三种情形都不同）', () => {
    const mk = (humanBand, aiBand) => ({
      human: humanBand ? [{ node: 'x', heat: humanBand }] : [],
      ai: aiBand ? [{ node: 'x', heat: aiBand }] : []
    });
    const w = heat.SEARCH_RANK;
    const none = heat.searchBoost(mk(0, 0));
    const h = heat.searchBoost(mk(10, 0));
    const a = heat.searchBoost(mk(0, 10));
    const both = heat.searchBoost(mk(10, 10));
    expect(none.byNode.has('x')).toBe(false);                       // 没被访问过 ⇒ 不加分（零访问节点不进榜）
    expect(h.byNode.get('x')).toBeCloseTo(w.human, 10);
    expect(a.byNode.get('x')).toBeCloseTo(w.ai, 10);
    expect(h.byNode.get('x')).toBeGreaterThan(a.byNode.get('x'));   // 两条权重不同（判据②的纯函数版）
    expect(both.byNode.get('x')).toBe(w.merged);                    // 合并上限：真的咬住了
    expect(both.byNode.get('x')).toBeLessThan(w.human + w.ai);      // 且严格小于两条之和
    expect(both.scale).toBe(w.merged);                              // 排序用的份额 = 合并上限（同一处取值）
    expect(both.rankedNodes).toBe(1);
  });

  it('A7 `maxJump` 的推导值可当场复核（ceil(n·c/(1-c)) - 1）', () => {
    const c = heat.SEARCH_RANK.merged;
    [2, 12, 40, 100, 1000].forEach((n) => {
      expect(heat.maxJump(n)).toBe(Math.max(0, Math.ceil(n * c / (1 - c)) - 1));
    });
    expect(heat.maxJump(1)).toBe(0);
    expect(heat.maxJump(0)).toBe(0);
  });
});

/* ============================================================================
 * B. 判据①：封顶可测（拉满 ⇒ 有变化，而位移 ≤ 封顶比例）
 * ========================================================================== */

describe('B. 判据①：热度拉满 ⇒ 顺序变了，但位移不超过封顶比例', () => {
  it('B1 基线：本机没有日志 ⇒ 顺序 = DFS 序，且 `heat.applied=false` / `reason=no-log`（不静默）', () => {
    const name = fixture(40);
    const j = searchJson(name);
    expect(ids(j)).toEqual(j.hits.map((h) => h.nodeId));
    expect(ids(j)).toEqual(Array.from({ length: 40 }, (x, i) => 'nd-' + (i + 1)));
    expect(j.heat.applied).toBe(false);
    expect(j.heat.reason).toBe('no-log');
    expect(j.heat.weights).toEqual({ human: heat.SEARCH_RANK.human, ai: heat.SEARCH_RANK.ai, merged: heat.SEARCH_RANK.merged });
  });

  it('B2 拉满最末一个节点的热度 ⇒ 顺序**真的变了**（否则判据①是恒真的空话）', () => {
    const m = measure(40, 40, 'human-detail', 3);
    expect(m.moved).toBeGreaterThan(0);
    expect(m.after.indexOf('nd-40')).toBeLessThan(m.base.indexOf('nd-40'));   // 它真的往前提了
    expect(m.after[0]).toBe('nd-1');                                          // 而榜首不动（位移只有几个位置）
    expect(m.after.length).toBe(m.n);
    expect(m.heat.applied).toBe(true);
    expect(m.heat.reason).toBe('ok');
    expect(m.heat.hitNodes).toBe(1);
  });

  it('B3 位移上限（两条口径）：位置数 ≤ maxJump(n)，比例 ≤ 10% —— 读数当场打印', () => {
    const m = measure(40, 40, 'human-detail', 3);
    const n = m.n;
    const bound = heat.maxJump(n);
    // 这两条就是"超限即红"的读数：注入 merged=1.0 时下面第二条必红（见 E1）
    expect(m.moved, '位移 ' + m.moved + ' 位置（上界 ' + bound + '）').toBeLessThanOrEqual(bound);
    expect(m.moved / (n - 1), '位移比例 ' + (m.moved / (n - 1)).toFixed(4)).toBeLessThanOrEqual(0.10);
    expect(bound / (n - 1)).toBeLessThanOrEqual(0.10);
  });

  it('B4 两条都拉满 ⇒ 位移不比单条小（合并真的进了排序，且仍在上界内）', () => {
    const h = measure(100, 100, 'human-detail', 1);
    const a = measure(100, 100, 'ai-get', 1);
    const both = fixture(100);
    const base = ids(searchJson(both));
    visits(both, 'nd-100', 'human-detail', 1);
    visits(both, 'nd-100', 'ai-get', 1);
    const after = ids(searchJson(both));
    const moved = displacement(base, after);
    expect(moved).toBeGreaterThanOrEqual(h.moved);
    expect(moved).toBeGreaterThanOrEqual(a.moved);
    expect(moved).toBeLessThanOrEqual(heat.maxJump(100));
    expect(h.moved).toBeGreaterThan(a.moved);            // 人侧权重更高 ⇒ 位移更大（同一条判据的另一面）
  });

  it('B5 边界（**有意**钉住）：n ≤ 11 时热度不可能改变顺序 —— 8% 封顶的直接推论', () => {
    const m = measure(6, 6, 'human-detail', 5);
    expect(heat.maxJump(6)).toBe(0);
    expect(m.moved).toBe(0);
    expect(m.after).toEqual(m.base);                     // 但热度**确实被读到了**（不是没生效）
    expect(m.heat.applied).toBe(true);
    expect(m.heat.rankedNodes).toBe(1);
  });
});

/* ============================================================================
 * C. 判据②：人 / AI 两条都真进，且权重不同
 * ========================================================================== */

describe('C. 判据②：人热 AI 冷 vs 人冷 AI 热 ⇒ 排序不同', () => {
  it('C1 同一节点：人热 AI 冷 与 人冷 AI 热 给出**不同**顺序（两条都真进）', () => {
    const humanHot = measure(100, 100, 'human-detail', 1);
    const aiHot = measure(100, 100, 'ai-get', 1);
    expect(humanHot.moved).toBeGreaterThan(0);
    expect(aiHot.moved).toBeGreaterThan(0);
    expect(humanHot.after).not.toEqual(aiHot.after);     // ← "权重不同"的可判别形态
    expect(humanHot.moved).toBeGreaterThan(aiHot.moved); // 人热挪得更远 = 人侧权重更低不了
    // 两条榜本身也确实是分开算的（同一节点只会出现在其中一条榜上）
    const jh = searchJson(humanHot.name);
    const ja = searchJson(aiHot.name);
    expect(jh.heat.rankedNodes).toBe(1);
    expect(ja.heat.rankedNodes).toBe(1);
  });

  it('C2 冷热对调（同一项目的两种通道）⇒ 顺序跟着反过来', () => {
    const p = fixture(100);
    const other = 'nd-50';
    visits(p, other, 'human-detail', 1);                 // nd-50 人热
    const first = ids(searchJson(p));
    const p2 = fixture(100);
    visits(p2, other, 'ai-get', 1);                      // 同样的位置，改成 AI 热
    const second = ids(searchJson(p2));
    expect(first).not.toEqual(second);
    expect(displacement(first, second)).toBeGreaterThan(0);
  });
});

/* ============================================================================
 * D. 判据③：同源（CLI search 与 MCP search_nodes 逐条同序）
 * ========================================================================== */

describe('D. 判据③：CLI 与 MCP 同源（同一份数据 ⇒ 同一排序）', () => {
  it('D1 CLI `search` 与 MCP `search_nodes`：命中逐条同序、hitCount/mode/weights 一致', () => {
    const p = fixture(40);
    visits(p, 'nd-40', 'human-detail', 2);
    visits(p, 'nd-1', 'ai-get', 1);
    const cli = searchJson(p);
    // MCP 那条路 = 真子进程跑同一个 CLI（scripts/mcp-server.js 的 search_nodes 只拼参数）
    const mcpCall = mcp.callTool('search_nodes', { project: p, keyword: KW });
    expect(mcpCall.ok, mcpCall.text).toBe(true);
    const viaMcp = JSON.parse(String(mcpCall.text).trim());
    expect(ids(viaMcp)).toEqual(ids(cli));
    expect(viaMcp.hitCount).toBe(cli.hitCount);
    expect(viaMcp.mode).toBe(cli.mode);
    expect(viaMcp.heat.weights).toEqual(cli.heat.weights);   // 两边用的是同一处取值
    expect(viaMcp.heat.applied).toBe(true);
    expect(cli.heat.applied).toBe(true);
  });

  it('D2 同源性不靠"两边各写一份"：MCP 侧不含任何打分/上限数值', () => {
    const mcpText = fs.readFileSync(path.join(ROOT, 'scripts', 'mcp-server.js'), 'utf8');
    [String(heat.SEARCH_RANK.human), String(heat.SEARCH_RANK.ai), String(heat.SEARCH_RANK.merged), 'byNode', 'maxJump']
      .forEach((needle) => expect(mcpText.indexOf(needle), 'MCP 里出现了 ' + needle).toBe(-1));
  });
});

/* ============================================================================
 * E. 判据⑤：注入证明（可重复执行；手改源码那一版的报文见本批交付说明）
 * ========================================================================== */

describe('E. 判据⑤：注入 ⇒ 必红；还原 ⇒ 复绿', () => {
  it('E1 把合并上限改成 1.0 ⇒ 判据①的位移上限断言**必红**（基础分那份被压成 0 ⇒ 顺序全由热度决定）', () => {
    expect(heat.SEARCH_RANK.merged).toBeLessThan(1);
    heat.__setSearchRankForTest(Object.assign({}, heat.SEARCH_RANK, { merged: 1 }));
    let failure = null;
    let moved = null;
    try {
      const m = measure(40, 40, 'human-detail', 1);
      moved = m.moved;
      expect(m.moved / (m.n - 1)).toBeLessThanOrEqual(0.10);   // ← 这一行**应当**失败
    } catch (err) {
      failure = err;
    } finally {
      heat.__resetSearchRankForTest();
    }
    expect(moved, '注入后位移应远大于封顶比例（实测：' + moved + '/' + 39 + '）').toBeGreaterThan(3);
    expect(failure, '注入 merged=1.0 后那条断言必须红').toBeTruthy();
    expect(String(failure.message)).toContain('0.1');          // ← 就是那条"位移 ≤ 10%"的断言
    expect(String(failure.message)).toContain('less than or equal');
    expect(heat.searchRankOf().merged).toBe(heat.SEARCH_RANK.merged);   // 还原
    // 复绿：同一实验在默认权重下重新跑一遍
    const again = measure(40, 40, 'human-detail', 1);
    expect(again.moved / (again.n - 1)).toBeLessThanOrEqual(0.10);
  });

  it('E2 把 AI 权重改成与人相同 ⇒ 判据②那条"两序不同"**必红**', () => {
    expect(heat.SEARCH_RANK.ai).not.toBe(heat.SEARCH_RANK.human);
    heat.__setSearchRankForTest(Object.assign({}, heat.SEARCH_RANK, { ai: heat.SEARCH_RANK.human }));
    let failure = null;
    let same = null;
    try {
      const humanHot = measure(100, 100, 'human-detail', 1);
      const aiHot = measure(100, 100, 'ai-get', 1);
      same = humanHot.after.join() === aiHot.after.join();
      expect(humanHot.after).not.toEqual(aiHot.after);          // ← 这一行**应当**失败
    } catch (err) {
      failure = err;
    } finally {
      heat.__resetSearchRankForTest();
    }
    expect(same, '注入后两种顺序应当变成同一个（实测 same=' + same + '）').toBe(true);
    expect(failure, '注入 ai=human 后那条断言必须红').toBeTruthy();
    expect(heat.searchRankOf().ai).toBe(heat.SEARCH_RANK.ai);   // 还原
    const h2 = measure(100, 100, 'human-detail', 1);
    const a2 = measure(100, 100, 'ai-get', 1);
    expect(h2.after).not.toEqual(a2.after);                     // 复绿
  });

  it('E3 `__setSearchRankForTest` 的参数闸门：给不全三个数 ⇒ 响亮拒绝（不静默改一半）', () => {
    expect(() => heat.__setSearchRankForTest({ human: 0.06 })).toThrow(/三个数/);
    expect(heat.searchRankOf().merged).toBe(heat.SEARCH_RANK.merged);
  });
});

/* ============================================================================
 * F. 判据④：热度只排序 —— 不改变"命中/不命中"，也不吃掉可检索性
 * ========================================================================== */

describe('F. 判据④：热度不改变命中集合，`--limit` 语义不变', () => {
  it('F1 命中集合（多重集）与 hitCount 不因热度改变；零热度节点照样在结果里', () => {
    const p = fixture(40);
    const before = searchJson(p);
    visits(p, 'nd-40', 'human-detail', 3);
    const after = searchJson(p);
    expect(after.hitCount).toBe(before.hitCount);
    expect(after.hits.length).toBe(before.hits.length);
    expect([...ids(after)].sort()).toEqual([...ids(before)].sort());   // 只是重排，不增删
    expect(after.hits.map((h) => h.matchIn)).toEqual(before.hits.map((h) => h.matchIn));
    expect(ids(after)).toContain('nd-1');                              // 零热度命中仍在
    expect(after.heat.hitNodes).toBe(1);
  });

  it('F2 `--limit` 截断语义照旧：截断可见（truncated + hitCount 全量），提高 limit 就能取到低热度的命中', () => {
    const p = fixture(40);
    visits(p, 'nd-40', 'human-detail', 3);
    const one = searchJson(p, ['--limit', '1']);
    expect(one.hits).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect(one.hitCount).toBe(40);                       // 截断不影响"全量命中数"
    expect(one.budget.resume).toContain('续取方式');
    expect(ids(one)).toEqual(ids(searchJson(p)).slice(0, 1));   // 顺序确定性 ⇒ 截断就是取前缀
    const all = searchJson(p, ['--limit', '40']);
    expect(all.truncated).toBe(false);
    expect(ids(all)).toContain('nd-1');
    expect(ids(all)).toContain('nd-39');
    // 逐级提高 limit：并集 = 全部命中（没有任何命中被热度挤到取不到）
    const seen = new Set();
    for (let k = 1; k <= 40; k++) ids(searchJson(p, ['--limit', String(k)])).forEach((x) => seen.add(x));
    expect([...seen].sort()).toEqual([...ids(all)].sort());
  });

  it('F3 `--topic-only` / `--tag` 等口径下同样只排序：不给 heat 的调用方逐字不变', () => {
    const p = fixture(6);
    visits(p, 'nd-6', 'human-detail', 3);
    const withHeat = run(['search', p, KW, '--topic-only', '--json']);
    expect(withHeat.code).toBe(0);
    const j = JSON.parse(withHeat.stdout);
    expect(j.mode).toBe('topic-only');
    expect(j.heat.applied).toBe(true);
    // 同一份数据、同一个查询，**不传 heat** 的纯逻辑层读数 = 既有 DFS 序（既有调用方的行为不变）
    const root = JSON.parse(fs.readFileSync(projFile(p), 'utf8')).data;
    const plain = itemIndex.searchItems(root, { keyword: KW, topicOnly: true });
    expect(plain.hits.map((h) => h.nodeId)).toEqual(['nd-1', 'nd-2', 'nd-3', 'nd-4', 'nd-5', 'nd-6']);
  });
});

/* ============================================================================
 * G. 判据⑥：热度读取走窄查询（fs 计数 + 字节级取证）
 * ========================================================================== */

describe('G. 判据⑥：`search` 读热度只读日志尾部（不扫全量、不写盘）', () => {
  it('G1 3.8 MB 日志：只读了尾部一个 chunk，且窄读与全量读给出**同一个**热度', () => {
    const p = fixture(40);
    const oldLine = heat.serializeEvent(heat.buildEvent({
      node: 'nd-1', ch: 'ai-read-view', at: new Date(Date.now() - 40 * heat.DAY_MS).toISOString(), by: 'test'
    }));
    fs.appendFileSync(logFile(p), oldLine.repeat(40000), 'utf8');     // 窗口外前缀 ~3.8 MB
    visits(p, 'nd-40', 'human-detail', 3);                            // 窗口内：尾部几条

    const j = searchJson(p);
    expect(j.heat.log.fileBytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(j.heat.log.windowComplete).toBe(false);                    // ← 真的只读了尾部
    expect(j.heat.log.bytesRead).toBeLessThan(j.heat.log.fileBytes / 8);
    // 窄读与全量读算出来的**排序**必须一致（窄读是精确的，不是近似）
    const now = Date.now();
    const narrow = heat.searchBoost(heat.readHeatFile(logFile(p), { now: now }).heat);
    const full = heat.searchBoost(heat.readHeatFile(logFile(p), { now: now, full: true }).heat);
    expect([...narrow.byNode.keys()]).toEqual([...full.byNode.keys()]);
    expect(narrow.byNode.get('nd-40')).toBe(full.byNode.get('nd-40'));
    expect(j.heat.rankedNodes).toBe(full.rankedNodes);
  });

  it('G2 fs 计数 + 字节级：日志只 open 一次、readSync 一次，且偏移落在文件尾部；全程零写', () => {
    const p = fixture(40);
    const oldLine = heat.serializeEvent(heat.buildEvent({
      node: 'nd-1', ch: 'ai-read-view', at: new Date(Date.now() - 40 * heat.DAY_MS).toISOString(), by: 'test'
    }));
    fs.appendFileSync(logFile(p), oldLine.repeat(40000), 'utf8');
    visits(p, 'nd-40', 'human-detail', 3);
    const fileSize = fs.statSync(logFile(p)).size;

    const spy = spyFs();
    let j = null;
    try {
      j = searchJson(p);
    } finally {
      spy.restore();
    }
    const logCalls = spy.ofLog(p);
    expect(logCalls.readFileSync).toEqual([]);                        // 从不整份读日志
    expect(logCalls.openSync).toEqual([logFile(p)]);                  // 只开一次
    expect(spy.calls.readSync.length).toBe(1);                        // 只读一次
    expect(spy.calls.readSync[0].length).toBe(heat.READ_CHUNK_BYTES); // 读长度 = 一个 chunk
    expect(spy.calls.readSync[0].position).toBe(fileSize - heat.READ_CHUNK_BYTES);   // 偏移 = 文件尾部那一段
    expect(spy.counters.appendFileSync).toBe(0);                      // search 是只读路径
    expect(spy.counters.writeFileSync).toBe(0);
    expect(spy.counters.renameSync).toBe(0);
    expect(j.heat.applied).toBe(true);
  });

  it('G3 本机没有日志 ⇒ 只探测一次、零读零开（"没有日志"这条路的成本钉住）', () => {
    const p = fixture(40);
    const spy = spyFs();
    try {
      searchJson(p);
    } finally {
      spy.restore();
    }
    expect(spy.ofLog(p).existsSync).toEqual([logFile(p)]);            // 只探测一次
    expect(spy.ofLog(p).openSync).toEqual([]);
    expect(spy.calls.readSync.length).toBe(0);
    expect(spy.counters.readFileSync).toBeGreaterThan(0);             // 项目 JSON 照读（与热度无关）
  });
});

/* ============================================================================
 * H. 失败响亮（F1）：日志坏了 ⇒ 检索**必须失败并点名**，不许给一份看起来正常的结果
 * ========================================================================== */

describe('H. 日志坏了 ⇒ `search` 响亮报错（不静默当 0、不给半份读数）', () => {
  it('H1 坏行：非 0 退出 + 点名（行号/字节偏移 + 原文），且**一条命中都不打印**', () => {
    const p = fixture(6);
    visits(p, 'nd-6', 'human-detail', 1);
    const poison = '{"v":1,"at":"懒得写了"\n';
    fs.appendFileSync(logFile(p), poison, 'utf8');
    const r = run(['search', p, KW]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('坏行');
    expect(r.stdout).toContain('字节');
    expect(r.stdout).toContain('懒得写了');
    expect(r.stdout).not.toContain('nd-1');                           // 不给任何看起来正常的命中
    expect(r.stdout).toContain('不等于');                             // "采不到 ≠ 热度 0"
    // 职责分开：同一份坏日志下 `visit` 照常能写（写入是 O(1) 追加，不读历史）
    expect(run(['visit', p, 'nd-5', '--channel', 'ai-get']).code).toBe(0);
  });

  it('H2 认不出的通道：报错并点名那条通道（不许自行加权、也不许当 0）', () => {
    const p = fixture(6);
    fs.appendFileSync(logFile(p), heat.serializeEvent({ v: 1, at: new Date().toISOString(), node: 'nd-1', ch: 'ai-telepathy' }), 'utf8');
    const r = run(['search', p, KW]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('ai-telepathy');
    // 命中的输出行一律以节点 id 开头 ⇒ 一行都不许出现（报错时只给诊断，不给半份结果）
    expect(r.stdout.split('\n').filter((l) => /^\s*nd-\d/.test(l))).toEqual([]);
  });
});

/* ============================================================================
 * I. 零热度 ⇒ 与从前**逐字相同**（回归保护：这条向量必须能"完全不起作用"）
 * ========================================================================== */

describe('I. 零热度 / 空日志 / 命中的节点都没热度 ⇒ 顺序与不传 heat 逐字相同', () => {
  it('I1 空日志（文件在、0 条事件）⇒ 顺序不变，且如实说 reason=log-empty', () => {
    const p = fixture(40);
    fs.writeFileSync(logFile(p), '', 'utf8');
    const j = searchJson(p);
    expect(ids(j)).toEqual(Array.from({ length: 40 }, (x, i) => 'nd-' + (i + 1)));
    expect(j.heat.applied).toBe(false);
    expect(j.heat.reason).toBe('log-empty');
  });

  it('I2 热度都在别的节点上 ⇒ 顺序不变，如实说 reason=no-hit', () => {
    const p = fixture(40);
    visits(p, 'nd-40', 'human-detail', 2);
    const r = run(['search', p, 'root', '--json']);                    // root 命中的那一条没有热度
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.heat.rankedNodes).toBe(1);
    expect(j.heat.applied).toBe(false);
    expect(j.heat.reason).toBe('no-hit');
  });

  it('I3 纯逻辑层：不传 heat 与传一个"全零"的 heat ⇒ 逐字节相同的顺序', () => {
    const p = fixture(40);
    visits(p, 'nd-40', 'human-detail', 2);
    const root = JSON.parse(fs.readFileSync(projFile(p), 'utf8')).data;
    const plain = itemIndex.searchItems(root, { keyword: KW });
    const zero = itemIndex.searchItems(root, { keyword: KW, heat: { scale: heat.SEARCH_RANK.merged, byNode: new Map() } });
    expect(JSON.stringify(zero.hits)).toBe(JSON.stringify(plain.hits));
    // 而真的加热度 ⇒ 顺序变了（同一入口，证明上面那条不是"没生效"）
    const hot = itemIndex.searchItems(root, { keyword: KW,
      heat: heat.searchBoost(heat.readHeatFile(logFile(p), { now: Date.now() }).heat) });
    expect(JSON.stringify(hot.hits)).not.toBe(JSON.stringify(plain.hits));
    expect(hot.hitCount).toBe(plain.hitCount);
  });

  it('I4 `orderByHeat` 的契约：不传 / 单条命中 ⇒ 原样返回同一个数组（不产生副本）', () => {
    const hits = [{ nodeId: 'a' }, { nodeId: 'b' }];
    expect(itemIndex.orderByHeat(hits, null)).toBe(hits);
    expect(itemIndex.orderByHeat(hits, { scale: 0.08, byNode: new Map() })).not.toBe(hits);
    const one = [{ nodeId: 'a' }];
    expect(itemIndex.orderByHeat(one, { scale: 0.08, byNode: new Map([['a', 0.08]]) })).toBe(one);
  });
});

/* ============================================================================
 * J. `--no-heat`：**显式**逃生门（旁路坏掉不掐死主干），而**默认档不许变软**
 * ----------------------------------------------------------------------------
 * 分界（用户 2026-10-12 拍板）：
 *   · 默认：日志坏 ⇒ **响亮失败**（F1：不许静默按 0 排 —— 那会假装正常）；
 *   · 同时给一条**显式**退路：`--no-heat` = 不读日志、不排序 ⇒ 与"零热度档"逐字相同。
 * 两者都不让步 ⇒ J2 就是那条**判别力**：谁把默认改成静默降级，J2 必红。
 * ========================================================================== */

describe('J. `--no-heat` 逃生门：有出口，但默认档照旧响亮失败', () => {
  const POISON = '{"v":1,"at":"懒得写了"\n';                       // 手改日志：既不是合法 JSON 也不是合法形状
  const poisoned = (n) => {
    const p = fixture(n);
    visits(p, 'nd-' + n, 'human-detail', 2);                        // 有真热度（默认档本来会**重排**）
    fs.appendFileSync(logFile(p), POISON, 'utf8');
    return p;
  };
  const DFS = (n) => Array.from({ length: n }, (x, i) => 'nd-' + (i + 1));

  it('J1 坏日志 + `--no-heat` ⇒ exit 0 且有命中（顺序回到零热度档），reason 如实说"被 --no-heat 显式关闭"', () => {
    const p = poisoned(40);
    const r = run(['search', p, KW, '--no-heat']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout.split('\n').filter((l) => /^\s*nd-\d/.test(l)).length).toBe(40);
    const j = JSON.parse(run(['search', p, KW, '--no-heat', '--json']).stdout);
    expect(ids(j)).toEqual(DFS(40));                                // 就是既有 DFS 序（没排序）
    expect(j.hitCount).toBe(40);
    expect(j.heat.applied).toBe(false);
    expect(j.heat.reason).toBe('被 --no-heat 显式关闭');
    expect(j.heat.log).toBe(null);                                  // 连日志块都不给（它没读）
  });

  it('J2 【判别力】坏日志 + **不带** `--no-heat` ⇒ 仍然 exit≠0、点名，且报错里点名那条出口', () => {
    const p = poisoned(40);
    const r = run(['search', p, KW]);
    expect(r.code).not.toBe(0);                                     // ← 谁把默认改成静默降级，这一行必红
    expect(r.stdout).toContain('坏行');
    expect(r.stdout).toContain('懒得写了');
    expect(r.stdout).toContain('不等于');                            // "采不到 ≠ 热度 0"
    expect(r.stdout).toContain('--no-heat');                        // 出口必须在**报错里**就能看见
    expect(r.stdout.split('\n').filter((l) => /^\s*nd-\d/.test(l))).toEqual([]);   // 不给半份结果
    // 而同一份坏日志下 `--no-heat` 立刻可用（两条合起来 = "有出口，但默认不软"）
    expect(run(['search', p, KW, '--no-heat']).code).toBe(0);
  });

  it('J3 `--no-heat` 与"从来没有过热度的项目"**逐字相同**（文本档 + 命中数组 + hitCount）', () => {
    const p = poisoned(40);
    const viaFlag = run(['search', p, KW, '--no-heat']);
    const viaFlagJson = searchJson(p, ['--no-heat']);
    fs.rmSync(logFile(p), { force: true });                         // 把旁路删掉 = 零热度档
    const zero = run(['search', p, KW]);
    const zeroJson = searchJson(p);
    expect(viaFlag.code).toBe(0);
    expect(zero.code).toBe(0);
    expect(viaFlag.stdout).toBe(zero.stdout);                       // ← 文本档逐字节相同
    expect(JSON.stringify(viaFlagJson.hits)).toBe(JSON.stringify(zeroJson.hits));
    expect(viaFlagJson.hitCount).toBe(zeroJson.hitCount);
    expect(viaFlagJson.budget).toEqual(zeroJson.budget);
    expect(zeroJson.heat.reason).toBe('no-log');                    // 零热度档是"没采到"，不是同一条理由
    expect(viaFlagJson.heat.reason).toBe('被 --no-heat 显式关闭');
  });

  it('J4 `--no-heat` 真的**不碰日志**（不读盘 ⇒ 日志坏了也能用；比"读了再忽略"更省）', () => {
    const p = poisoned(40);
    const spy = spyFs();
    try {
      expect(run(['search', p, KW, '--no-heat']).code).toBe(0);
    } finally {
      spy.restore();
    }
    expect(spy.ofLog(p).existsSync).toEqual([]);                    // 连探测都没有
    expect(spy.ofLog(p).openSync).toEqual([]);
    expect(spy.ofLog(p).readFileSync).toEqual([]);
    expect(spy.calls.readSync.length).toBe(0);
    expect(spy.counters.appendFileSync).toBe(0);                    // 只读路径，全程零写
    expect(spy.counters.writeFileSync).toBe(0);
  });

  it('J5 它是**布尔开关**（照 --verified 先例）：`=nonsense` 当场报错，`=false` 退回默认档', () => {
    const p = poisoned(40);
    const bad = run(['search', p, KW, '--no-heat=nonsense']);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toContain('--no-heat');                      // 报错点名用户敲的那个选项
    expect(bad.stdout).toContain('true 或 false');
    // `--no-heat=false` = 明说"不关掉" ⇒ 回到默认档 ⇒ 坏日志照旧响亮失败（不许被 `=false` 静默当成 true）
    const off = run(['search', p, KW, '--no-heat=false']);
    expect(off.code).not.toBe(0);
    expect(off.stdout).toContain('坏行');
    // `--no-heat=true` 与裸写等价
    const on = run(['search', p, KW, '--no-heat=true']);
    expect(on.code).toBe(0);
    expect(on.stdout).toBe(run(['search', p, KW, '--no-heat']).stdout);
  });

  it('J6 日志**没坏**时 `--no-heat` 也等于零热度档（有热度、但这次不排序）', () => {
    const p = fixture(40);
    const before = ids(searchJson(p));                              // 无日志基线
    visits(p, 'nd-40', 'human-detail', 3);
    const withHeat = searchJson(p);
    const offJson = searchJson(p, ['--no-heat']);
    expect(ids(withHeat)).not.toEqual(before);                      // 默认档确实重排了
    expect(ids(offJson)).toEqual(before);                           // 关掉 ⇒ 回到基线（逐条相同）
    expect(offJson.hitCount).toBe(withHeat.hitCount);
    expect(offJson.heat.applied).toBe(false);
  });
});

/* ============================================================================
 * K. MCP `no_heat`：把逃生门通到**报错的人**手上（用户 2026-10-12 拍板）
 * ----------------------------------------------------------------------------
 * 为什么必须接：CLI 的坏日志报文里点名"加 `--no-heat` 先检索" —— 走 MCP 的调用方（AI）
 * 若传不进这个开关，那条出路就是**指不到东西的死指针** ✗（收报错的人用不了它）。
 * 纪律照旧：MCP 侧**只加这一个参数**，不复制任何热度取值/上限（三串数字仍只在 src/heat.js），
 * 也**不许**把默认档弄软（不给 `no_heat` 时坏日志照旧响亮失败）。
 * ========================================================================== */

describe('K. MCP `search_nodes` 的 `no_heat`：逃生门可达，默认档不变软', () => {
  const POISON = '{"v":1,"at":"懒得写了"\n';
  const mcpSearch = (args) => mcp.callTool('search_nodes', args);
  const searchNodesTool = () => mcp.TOOLS.filter((t) => t.name === 'search_nodes')[0];
  const poisoned = (n) => {
    const p = fixture(n);
    visits(p, 'nd-' + n, 'human-detail', 2);
    fs.appendFileSync(logFile(p), POISON, 'utf8');
    return p;
  };
  const DFS = (n) => Array.from({ length: n }, (x, i) => 'nd-' + (i + 1));

  it('K1 【判据①】坏日志 + MCP `no_heat:true`（**真调用**）⇒ 调用成功 + 拿到 40 条命中（顺序=DFS）', () => {
    const p = poisoned(40);
    const r = mcpSearch({ project: p, keyword: KW, no_heat: true });
    expect(r.ok, r.text).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(ids(j)).toEqual(DFS(40));
    expect(j.hitCount).toBe(40);
    expect(j.heat.reason).toBe('被 --no-heat 显式关闭');
    expect(j.heat.log).toBe(null);
  });

  it('K2 【判据②】坏日志 + MCP **不给** `no_heat` ⇒ 仍然响亮失败，并把出路带回给调用方', () => {
    const p = poisoned(40);
    const r = mcpSearch({ project: p, keyword: KW });
    expect(r.ok).toBe(false);                                       // ← 谁把 MCP 侧默认弄软，这一行必红
    expect(String(r.text)).toContain('坏行');
    expect(String(r.text)).toContain('--no-heat');                  // 出路随报错一起回到调用方手里
    // `no_heat:false` 也是"不关掉"（严格 === true 才加开关）⇒ 同样响亮失败
    const off = mcpSearch({ project: p, keyword: KW, no_heat: false });
    expect(off.ok).toBe(false);
    expect(String(off.text)).toContain('坏行');
  });

  it('K3 【判据③】结构与同源：MCP 只多这一个参数（不复制热度取值），且与 CLI 的 `--no-heat` 逐条同序', () => {
    const mcpText = fs.readFileSync(path.join(ROOT, 'scripts', 'mcp-server.js'), 'utf8');
    // ① 参数在 schema 里（布尔），且直通 CLI 的**同名开关**就一个调用点
    expect(searchNodesTool().inputSchema.properties.no_heat.type).toBe('boolean');
    expect(searchNodesTool().inputSchema.properties.no_heat.description).toContain('--no-heat');
    expect(mcpText.split("c.push('--no-heat')").length - 1).toBe(1);
    // ② 没有新增工具（只是给既有工具加参数）：名字唯一、search_nodes 只有一个条目
    const names = mcp.TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === 'search_nodes')).toHaveLength(1);
    expect(mcp.TOOLS.filter((t) => t.inputSchema.properties && t.inputSchema.properties.no_heat)
      .map((t) => t.name)).toEqual(['search_nodes']);               // 这个参数只属于这一条工具
    // ③ 三串数值/上限名一个都不许出现在 MCP 侧（取值只有 src/heat.js 一处）
    [String(heat.SEARCH_RANK.human), String(heat.SEARCH_RANK.ai), String(heat.SEARCH_RANK.merged), 'byNode', 'maxJump']
      .forEach((x) => expect(mcpText.indexOf(x), 'MCP 里出现了 ' + x).toBe(-1));
    // ④ 同源：MCP 与 CLI 的逃生门给出**同一份命中**（同一个开关、同一处排序实现）
    const p = poisoned(40);
    const viaMcp = JSON.parse(String(mcpSearch({ project: p, keyword: KW, no_heat: true }).text).trim());
    const viaCli = searchJson(p, ['--no-heat']);
    expect(JSON.stringify(viaMcp.hits)).toBe(JSON.stringify(viaCli.hits));
    expect(viaMcp.hitCount).toBe(viaCli.hitCount);
    expect(viaMcp.heat.reason).toBe(viaCli.heat.reason);
  });

  it('K4 日志没坏时 MCP 不给 `no_heat` ⇒ 照常命中（既有消费者逐字不变，参数是纯增量）', () => {
    const p = fixture(40);
    visits(p, 'nd-40', 'human-detail', 3);
    const r = mcpSearch({ project: p, keyword: KW });
    expect(r.ok, r.text).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(j.hitCount).toBe(40);
    expect(j.heat.applied).toBe(true);                              // 默认档照旧用热度排序
    expect(ids(j)).toEqual(ids(searchJson(p)));
  });
});
