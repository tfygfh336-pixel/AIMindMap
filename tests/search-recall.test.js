/* ============================================================
 * tests/search-recall.test.js — 【W4b】扩召回 + 开 `matchIn` 封闭取值表
 * 运行：npx vitest run tests/search-recall.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的
 *          `## W4｜混合检索与"权重怎么处理"` 一节（W4 只做了重排；这一件是它被裁出去的**另一半**：
 *          **扩召回** + 随之要开的 `matchIn` 封闭取值表 —— 那是一次契约变更，见 `docs/ITEM-MODEL.md` §3.4）。
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 *   "换个说法/只写在邻居里"的知识点以前**一条都搜不到**（不是"排在后面"），那正是"AI 只好上网再搜一次"
 *   的处境；实现形态上同时兑现**卖点 6** 的"一份事实一处实现"（能扩召回的路由、深度上界、新取值名
 *   只有 `src/palette-rank.js` 一处）。
 *
 * ## 这个文件守什么
 *   A. **默认档逐字节不变**（本件的承重性质）：不给 `--recall` 时 ① 文本档没有扩召回那一行、
 *      ② `--json` 顶层没有 `explain` 键、③ 输出与"只开 text 一路"的权重档**逐字节相同**、
 *      ④ `--mode <预设>` 与"等价的完整权重名单"逐字节相同（扩召回没有偷偷接进候选集）。
 *   B. **扩召回只在显式档里发生**：关着时 `near` 一条都不出现；`--recall` 一开 ⇒ 命中**集合变大**
 *      （真的扩召回，不是重排），新命中落进契约 §3.4 的**12 键**形状里（开取值表，不是加键）。
 *   C. **上界来自路由表**（现取，不写死）：四节点的链上，`bound` 之内的进来、之外的进不来。
 *   D. **判别力**（可重复执行）：把上界改成 3 ⇒ 链尾进来；改成 1 ⇒ 两跳那条掉出去；
 *      把扩召回"关掉"（融合入口不给这一路名次）⇒ 非字面那一类的期望全部落空；
 *      把默认档改成"默认开" ⇒ 默认档与"只开字面那一路"**不再逐字节相同**（A 组抓的就是它）。
 *   E. **硬过滤正交**：`--tag` 与关键词仍是 AND（扩召回不许把没标签的邻居带回来）；
 *      条目级过滤给了 ⇒ 扩召回不参与（**输出与不开 `--recall` 逐字节相同**，并在 `--explain` 里说明）。
 *   F. **`--explain` 逐路点名新取值**：`explain.recall` 逐路给"接回来几条 / 为什么是 0"，
 *      `explain.hits` 里新命中的 `text` 那一路名次是 `null`（不是字面命中这件事看得见）。
 *   G. **黄金集扩量 + 读前/读后**：`tests/fixtures/hybrid-golden.json` 里 `needs:'recall'` 那一类
 *      问题 —— 读前（去掉 `--recall`）期望**一条都不在结果里**，读后进 topN；两类各自的
 *      hit@1 / hit@3 / MRR **现算**打印（不写死任何数字）。
 *   H. 参数写错**响亮**：裸写 / 不认识的 route / 不能扩召回的路由 / 写两遍 / 不与 mode 同给 ⇒ exit≠0 且报文点名。
 *   I. 一处实现（结构断言）：跳数表只有一处、扩召回没有第二套打分/排序、新取值名只在
 *      路由表与封闭取值表各出现一次（**两处必须一致**，有断言把它们钉在一起）。
 *   J. MCP：`search_nodes` 加 `recall` 参数一层透传（进程内 `mcp.callTool`），**工具数不变**（真值现取）。
 *   K. 端到端沙箱：`AI_MINDMAP_PROJECTS_DIR` 临时目录 + 进程内 `invokeSync`；真实 `projects/` **只读**；
 *      收尾后探针残留 / `it-*` / `imp-probe*` / 访问日志**都为 0**。
 *   L. 交付物闸门：`.review/…/W4b-集成断言原文.js` 可解析、无待填字样、前缀字面量只出现一次。
 *
 * ## 环境要点（与 tests/search-hybrid.test.js / search-fuzzy.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 夹具自己造数据 ⇒ 默认**关掉自动埋点**（`heatSensor.__setEnabledForTest(false)`），跑完还原；
 *   3) 端到端一律**进程内** `invokeSync`（不起子进程；MCP 那条走进程内 `mcp.callTool`，它自己那层
 *      转发生来就是"一层透传"要证的东西）；全程 `--no-heat`；真实 `projects/` 目录**只读**；
 *   4) 临时件与清理都进 `%TEMP%` 沙箱：探针名单只有 `PROBES` 一处，`cleanup()` 一处收尾。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-w4b-recall-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const itemIndex = require('../src/item-index.js');
const paletteRank = require('../src/palette-rank.js');
const heatSensor = require('../src/heat-sensor.js');
const mcp = require('../scripts/mcp-server.js');

heatSensor.__setEnabledForTest(false);      // 夹具自己那份数据必须只有我写的（见文件头 ②）

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 真实 `projects/` 根（**只读**：本文件的每条端到端断言都要它能被证明"一个字节都没动"） */
const REAL_PROJECTS = path.join(ROOT, 'projects');

/* ---------------- 探针前缀表（**唯一一处**；清理只认它） ---------------- */
const PREFIX = 'w4b-';
const PROBES = [
  { name: PREFIX + 'gold', why: '黄金集语料（A/B/C/D/F/G 组：非字面命中那一类 + 上界那条链）' },
  { name: PREFIX + 'filter', why: '硬过滤那几条（E 组：标签 / 条目级过滤 × 扩召回）' }
];
const GOLD = PROBES[0].name;
const FILTER = PROBES[1].name;
/** 清理的唯一入口（`afterAll` 与用例内的 `try/finally` 都走它）——别处不许各写一遍 rmSync。 */
function cleanup(only) {
  const names = only || PROBES.map((p) => p.name);
  names.forEach((name) => {
    try { fs.rmSync(projDir(name), { recursive: true, force: true }); } catch (e) { /* 收尾失败不影响判定 */ }
  });
}
afterAll(() => {
  cleanup();
  heatSensor.__setEnabledForTest(true);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 沙箱删不掉不影响判定 */ }
});

/* ---------------- 夹具工具 ---------------- */
const run = (argv) => invokeSync(argv);
const projDir = (name) => path.join(SANDBOX, name);
const projFile = (name) => path.join(projDir(name), name + '.json');
const searchArgs = (name, q, extra) => ['search', name, q, '--no-heat', '--json'].concat(extra || []);
/** 跑一次检索并解析（`--json`）——失败**当场点名**，别让 JSON.parse 的错掩盖真原因 */
function search(name, q, extra) {
  const argv = searchArgs(name, q, extra);
  const r = run(argv);
  expect(r.code, argv.join(' ') + ' 失败：' + r.stdout).toBe(0);
  return JSON.parse(r.stdout);
}
const idsOf = (json) => json.hits.map((h) => h.nodeId);
/** 【W4b】扩召回那一路的 id（**从路由表现取**：本文件不写死路由名，将来多一路也只多跑一路） */
const RECALL_IDS = paletteRank.RECALL_ROUTE_IDS.slice();
/** 某一行的跳数上界（现取；本文件不写死"2 跳"这种数字） */
const boundOf = (rid) => (paletteRank.ROUTES.filter((r) => r.id === rid)[0] || {}).bound;
/** 某一行的 `matchIn` 取值名（现取） */
const hitValueOf = (rid) => (paletteRank.ROUTES.filter((r) => r.id === rid)[0] || {}).recallHit;
const firstRecall = RECALL_IDS[0];
/** 一条问题"去掉 --recall"的那份 args（读前档：**只差扩召回这一件事**） */
function withoutRecall(args) {
  const a = (args || []).slice();
  const i = a.indexOf('--recall');
  if (i >= 0) a.splice(i, 2);
  return a;
}

/* ---------------- 语料：黄金集（fixture 是**真值**，本文件只负责跑它） ---------------- */
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'hybrid-golden.json'), 'utf8'));
/** 按 fixture 造一个项目（`imported:true` ⇒ 节点带 `origin`；`links` 补上本项目的 `project`） */
function corpusOf(name) {
  const nodes = GOLDEN.corpus.nodes.map((n) => {
    const out = { id: n.id, topic: n.topic, children: [] };
    if (n.tags) out.tags = n.tags;
    if (n.imported) out.origin = { kind: 'import', src: 'w4-fixture.pdf', sha256: 'a'.repeat(64), at: '2026-10-05T00:00:00Z' };
    if (n.items) out.items = n.items.map((it) => {
      const o = { id: it.id, type: 'text', html: '<p>' + it.text + '</p>' };
      if (it.at) o.at = it.at;
      if (it.tags) o.tags = it.tags;
      if (it.verified) o.verified = it.verified;
      return o;
    });
    if (n.links) out.links = n.links.map((l) => Object.assign({ project: name }, l));
    return out;
  });
  return {
    file: {
      meta: { name: name, author: '', version: GOLDEN.corpus.version, formatVersion: GOLDEN.corpus.formatVersion },
      format: 'node_tree',
      data: { id: 'root', topic: 'root', expanded: true, children: nodes },
      assoc: GOLDEN.corpus.assoc.map((a) => ({ id: a.id, title: a.title, note: a.note,
        members: a.members.map((id) => ({ project: name, id: id })) }))
    }
  };
}
function mkGolden() {
  const dir = projDir(GOLD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projFile(GOLD), JSON.stringify(corpusOf(GOLD).file, null, 2), 'utf8');
  return GOLD;
}
/** E 组的小语料：头名带标签、邻居不带 ⇒ 用来看"扩召回不许绕过标签闸门" */
function mkFilter() {
  const dir = projDir(FILTER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projFile(FILTER), JSON.stringify({
    meta: { name: FILTER, author: '', version: '0.18.0', formatVersion: 3 },
    format: 'node_tree',
    data: { id: 'root', topic: 'root', expanded: true, children: [
      { id: 'nd-lead', topic: '闸门标签演示', tags: ['demo'], children: [] },
      { id: 'nd-nbr-free', topic: '没有标签的邻居', children: [], links: [{ project: FILTER, id: 'nd-lead' }] },
      { id: 'nd-nbr-tagged', topic: '带标签的邻居', tags: ['demo'], children: [],
        links: [{ project: FILTER, id: 'nd-lead' }] },
      { id: 'nd-item-filtered', topic: '条目过滤演示', children: [], links: [{ project: FILTER, id: 'nd-lead' }] }
    ] }
  }, null, 2), 'utf8');
  return FILTER;
}
const RE_KW = '闸门';
const RE_ARGS = ['--mode', paletteRank.DEFAULT_MODE, '--recall', firstRecall];

/* ============================================================================
 * A. 判据：**默认档逐字节不变**（本件的承重性质）
 * ========================================================================== */
describe('A. 默认档：不给 --recall 时输出与从前逐字节相同', () => {
  it('A1 文本档没有扩召回那一行；`--json` 顶层没有 `explain` 键；命中仍是 12 键里那几个', () => {
    mkGolden();
    const text = run(['search', GOLD, '共享内存', '--no-heat']);
    expect(text.code, text.stdout).toBe(0);
    expect(text.stdout, '默认档不许出现扩召回的读数').not.toContain('扩召回');
    expect(text.stdout, '默认档不许出现混合检索那段').not.toContain('混合检索');
    const json = search(GOLD, '共享内存', []);
    expect(Object.keys(json), 'explain 只在要的时候出现').not.toContain('explain');
    // 命中形状（契约 §3.4）：**本件开的只是取值表**，键一个都不许加/改名 —— 这里是"键在契约里"的那一半
    const CONTRACT = ['id', 'topic', 'nodeId', 'nodeTopic', 'itemId', 'type', 'itemized', 'matchIn',
      'snippet', 'src', 'verified', 'score'];
    json.hits.forEach((h) => {
      Object.keys(h).forEach((k) => {
        expect(CONTRACT, '命中上一个契约外的键都不许有：' + k).toContain(k);
      });
      CONTRACT.forEach((k) => { if (k !== 'src' && k !== 'snippet') expect(Object.keys(h)).toContain(k); });
      expect(h.matchIn, '默认档里一个新取值都不该出现').not.toBe(hitValueOf(firstRecall));
    });
  });

  it('A2 默认档 == "只开 text 一路"的权重档（逐字节相同），且**与 balanced 档不同**', () => {
    mkGolden();
    // 用黄金集那套语料（它有几条辅助路真的会动顺序的数据）：只在几条题目的小语料上比，
    // "默认被改成开启"这种改法**抓不到** —— 那种语料下几条辅助路本来就不改变顺序（W4 实测踩过）。
    const onlyText = paletteRank.ROUTE_IDS.map((r) => r + '=' + (r === 'text' ? 1 : 0)).join(',');
    const def = run(searchArgs(GOLD, '共享内存', []));
    const w = run(searchArgs(GOLD, '共享内存', ['--weights', onlyText]));
    const bal = run(searchArgs(GOLD, '共享内存', ['--mode', paletteRank.DEFAULT_MODE]));
    expect(def.code, def.stdout).toBe(0);
    expect(w.code, w.stdout).toBe(0);
    expect(bal.code, bal.stdout).toBe(0);
    expect(w.stdout, '只开 text 一路 ⇒ 与默认档逐字节相同').toBe(def.stdout);
    expect(bal.stdout, '预设有辅助路时顺序必须与默认档不同 —— 否则"默认档没被改"这件事无法被这条判据看见')
      .not.toBe(def.stdout);
  });

  it('A3 `--mode <预设>` 与"等价的完整权重名单"逐字节相同（扩召回没有偷偷接进候选集）', () => {
    mkGolden();
    const m = paletteRank.DEFAULT_MODE;
    const same = paletteRank.ROUTE_IDS.map((r) => r + '=' + paletteRank.MODES[m][r]).join(',');
    const a = run(searchArgs(GOLD, '构建缓存', ['--mode', m]));
    const b = run(searchArgs(GOLD, '构建缓存', ['--weights', same]));
    expect(a.code, a.stdout).toBe(0);
    expect(b.code, b.stdout).toBe(0);
    expect(b.stdout, '同一套权重、两种写法 ⇒ 逐字节相同（与扩召回无关）').toBe(a.stdout);
    // ⭐ 判别力：这一条必须真的**看得见**扩召回 —— 开了它之后同一套权重下命中集合会变
    const c = run(searchArgs(GOLD, '构建缓存', ['--mode', m, '--recall', firstRecall]));
    expect(c.stdout, '开关一动，结果必须真的不同（否则下面所有"扩召回在干活"的断言都是空转）')
      .not.toBe(a.stdout);
  });
});

/* ============================================================================
 * B. 扩召回只在**显式档**里发生；打开后是真的"扩召回"
 * ========================================================================== */
describe('B. 扩召回：显式开、候选集真的变大、新命中在 12 键契约里', () => {
  it('B1 关着时一个新取值都不出现；开着时新取值出现，且两档的**命中集合**是"只增"关系', () => {
    mkGolden();
    const off = search(GOLD, '构建缓存', ['--mode', paletteRank.DEFAULT_MODE]);
    expect(off.hits.map((h) => h.matchIn), '关着时只可能是字面那一档的取值')
      .not.toContain(hitValueOf(firstRecall));
    const on = search(GOLD, '构建缓存', RE_ARGS);
    const near = on.hits.filter((h) => h.matchIn === hitValueOf(firstRecall));
    expect(near.length, '开了扩召回必须真的接回来新候选').toBeGreaterThan(0);
    expect(on.hitCount, '扩召回 = 候选集变大（不是重排）').toBeGreaterThan(off.hitCount);
    const before = idsOf(off);
    const after = idsOf(on);
    before.forEach((id) => expect(after, '原来的命中一个都不许丢：' + id).toContain(id));
    near.forEach((h) => {
      expect(before, '这些节点在关着时本来就搜不到（这正是"非字面命中"的意思）：' + h.nodeId)
        .not.toContain(h.nodeId);
      expect(h.itemId, '扩召回回来的是**节点级**命中（没有"命中在哪一段正文"这回事）').toBe(null);
      expect(h.type).toBe(null);
      expect(h.score, 'score 仍是"子串出现次数"口径，取不到就回落 1').toBeGreaterThanOrEqual(1);
      expect(h.verified).toBe(false);
    });
  });

  it('B2 新命中落在契约的 12 键里（**开取值表 ≠ 加键**）：键集与既有命中同一套', () => {
    mkGolden();
    const json = search(GOLD, '构建缓存', RE_ARGS);
    const literal = json.hits.filter((h) => h.matchIn !== hitValueOf(firstRecall))[0];
    const near = json.hits.filter((h) => h.matchIn === hitValueOf(firstRecall))[0];
    expect(literal, '这一批里必须有字面命中做对照').toBeTruthy();
    expect(near, '这一批里必须有扩召回命中').toBeTruthy();
    // 12 键是**可选键也齐备时**的全集；某一档少一个可选键（snippet 取不到）是既有口径，不算加/减键
    const CONTRACT = ['id', 'topic', 'nodeId', 'nodeTopic', 'itemId', 'type', 'itemized', 'matchIn',
      'snippet', 'src', 'verified', 'score'];
    Object.keys(literal).forEach((k) => expect(CONTRACT).toContain(k));
    Object.keys(near).forEach((k) => expect(CONTRACT, '扩召回命中上有契约外的键：' + k).toContain(k));
    expect(CONTRACT.length, '契约键数就是 12（本件一个字没动这一条）').toBe(12);
    // 新值**在封闭取值表里**（表与实现不许漂 —— 另一半在 tests/item-index.test.js 的逐键用例里）
    expect(itemIndex.MATCH_IN).toContain(hitValueOf(firstRecall));
    json.hits.forEach((h) => expect(itemIndex.MATCH_IN, '命中取值必须在封闭表里').toContain(h.matchIn));
  });

  it('B3 只给 `--recall`（不给 --mode / --weights）= 两种口径不混 ⇒ 响亮报错、不静默替你挑预设', () => {
    mkGolden();
    const r = run(searchArgs(GOLD, '构建缓存', ['--recall', firstRecall]));
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim().startsWith('error: ')).toBe(true);
    expect(r.stdout).toContain('--recall');
    expect(r.stdout).toContain('--mode');
    expect(r.stdout, '不许静默退化成"0 命中"或默认档').not.toContain('"hits"');
  });

  it('B4 `search-all` 与 `search` 同一处解析：同一句错话报文逐字同源', () => {
    mkGolden();
    const one = run(searchArgs(GOLD, '构建缓存', ['--recall', firstRecall]));
    const all = run(['search-all', '构建缓存', '--no-heat', '--recall', firstRecall]);
    expect(one.code).not.toBe(0);
    expect(all.code).not.toBe(0);
    expect(all.stdout).toBe(one.stdout);
  });
});

/* ============================================================================
 * C. 上界来自**路由表**（现取，不写死数字）+ D. 判别力（可重复执行的注入）
 * ========================================================================== */
describe('C/D. 上界只看路由表那一行的 `bound`（改它 ⇒ 进出的候选跟着变）', () => {
  /** 这条链（fixture 里造的）：nd-cache → nd-ccache → nd-2hop → nd-3hop */
  const CHAIN = ['nd-ccache', 'nd-2hop', 'nd-3hop'];
  const hopOf = (nodeId) => CHAIN.indexOf(nodeId) + 1;

  it('C1 `bound` 之内的进来、之外的进不来（往返两边都断言 ⇒ 不是空转）', () => {
    mkGolden();
    const json = search(GOLD, '构建缓存', RE_ARGS);
    const got = idsOf(json);
    const bound = boundOf(firstRecall);
    expect(typeof bound, '路由表那一行必须给出上界').toBe('number');
    CHAIN.forEach((id) => {
      if (hopOf(id) <= bound) expect(got, hopOf(id) + ' 跳在上界 ' + bound + ' 之内 ⇒ 该进来').toContain(id);
      else expect(got, hopOf(id) + ' 跳超出上界 ' + bound + ' ⇒ 不许进来').not.toContain(id);
    });
  });

  it('D1 把 `bound` 改成 3 ⇒ 链尾进来；改成 1 ⇒ 两跳那条掉出去；还原 ⇒ 复绿（判据④的形态）', () => {
    mkGolden();
    const real = paletteRank.ROUTES;
    const withBound = (v) => real.map((r) => (r.id === firstRecall ? Object.assign({}, r, { bound: v }) : r));
    const got = () => idsOf(search(GOLD, '构建缓存', RE_ARGS));
    let at3 = null;
    let at1 = null;
    try {
      paletteRank.ROUTES = withBound(3);
      at3 = got();
      paletteRank.ROUTES = withBound(1);
      at1 = got();
    } finally {
      paletteRank.ROUTES = real;             // ⚠️ 还原（哪怕上面抛了）
    }
    expect(at3, '上界 3 ⇒ 三跳那条必须进来（否则"上界真的在读路由表"这件事没被证明）').toContain('nd-3hop');
    expect(at1, '上界 1 ⇒ 两跳那条必须掉出去').not.toContain('nd-2hop');
    expect(at1).not.toContain('nd-3hop');
    expect(got(), '还原后必须复绿（用真值再算一次）').toEqual(idsOf(search(GOLD, '构建缓存', RE_ARGS)));
  });

  it('D2 把扩召回整段关掉（解析结果里 `recall.on=false`，等于下面那段不执行）⇒ 非字面那一类全部落空', () => {
    /* ⚠️ 为什么不用"在融合入口删掉这一路的名次"来注入（第一版就是那么写的，实测**不红**）：
     * 候选一旦被接进结果，`trust` 那一路照样会给他们名次 ⇒ 它们还排在前面，只是顺序不同。
     * "扩召回关掉"的**准确**形态是"候选集不扩大"，所以注入打在**候选集**这一层。
     * （手改源码那一版的报文见交付说明：把 `searchItems` 里扩召回那段改成不执行。） */
    const real = paletteRank.hybridSpecOf;
    const recallQs = GOLDEN.queries.filter((q) => q.needs === 'recall');
    expect(recallQs.length, 'fixture 里必须标出这一类问题').toBeGreaterThan(0);
    let broken = null;
    try {
      paletteRank.hybridSpecOf = (opts) => {
        const spec = real(opts);
        if (spec.ok) spec.spec = Object.assign({}, spec.spec, { recall: { on: false, routes: [] } });
        return spec;
      };
      broken = recallQs.map((q) => {
        const j = search(GOLD, q.q, q.args);
        const at = idsOf(j).indexOf(q.expect);
        return at < 0 ? Infinity : at + 1;
      });
    } finally {
      paletteRank.hybridSpecOf = real;               // ⚠️ 还原（哪怕上面抛了）
    }
    recallQs.forEach((q, i) => {
      expect(broken[i], q.expect + ' 在"扩召回关掉"下必须**一条都不在结果里**，实测 '
        + (Number.isFinite(broken[i]) ? '第 ' + broken[i] + ' 名' : '不在结果里')).toBe(Infinity);
    });
    // 复绿
    recallQs.forEach((q) => {
      const j = search(GOLD, q.q, q.args);
      const at = idsOf(j).indexOf(q.expect);
      expect(at < 0 ? Infinity : at + 1, q.expect + ' 还原后必须回到 topN 内').toBeLessThanOrEqual(q.topN);
    });
  });

  it('D3 把默认档改成"默认开"（不给参数也启用扩召回）⇒ 默认档与"只开字面那一路"不再逐字节相同', () => {
    const real = paletteRank.hybridSpecOf;
    const onlyText = paletteRank.ROUTE_IDS.map((r) => r + '=' + (r === 'text' ? 1 : 0)).join(',');
    let defOut = null;
    let wOut = null;
    try {
      paletteRank.hybridSpecOf = (opts) => {
        const o = opts || {};
        if (o.mode === undefined && o.weights === undefined && o.recall === undefined) {
          // 注入：**不给任何开关**也把这一层打开（就是 A2 那条断言要抓的改法）
          return { ok: true, spec: { enabled: true, mode: paletteRank.DEFAULT_MODE,
            weights: paletteRank.MODES[paletteRank.DEFAULT_MODE], k: paletteRank.rrfKOf(),
            recall: { on: true, routes: [firstRecall] } } };
        }
        return real(opts);
      };
      defOut = run(searchArgs(GOLD, '构建缓存', [])).stdout;
      wOut = run(searchArgs(GOLD, '构建缓存', ['--weights', onlyText])).stdout;
    } finally {
      paletteRank.hybridSpecOf = real;
    }
    expect(defOut, '注入后默认档必须**不再**逐字节相同 —— A2 抓的就是这一条').not.toBe(wOut);
    expect(JSON.parse(defOut).hits.some((h) => h.matchIn === hitValueOf(firstRecall)),
      '注入的默认档确实把扩召回带进来了（不是"变了但不知道为什么"）').toBe(true);
  });
});

/* ============================================================================
 * E. 硬过滤正交：扩召回不许绕过 --tag / 条目级过滤
 * ========================================================================== */
describe('E. 硬过滤是正交的：扩召回不许把"过滤掉的东西"带回来', () => {
  it('E1 `--tag` 与关键词仍是 AND：没标签的邻居进不来，带标签的照旧进来', () => {
    mkFilter();
    const json = search(FILTER, RE_KW, RE_ARGS.concat(['--tag', 'demo']));
    const got = idsOf(json);
    expect(got, '头名自己带这个标签').toContain('nd-lead');
    expect(got, '带标签的邻居该被扩召回带回来').toContain('nd-nbr-tagged');
    expect(got, '没标签的邻居**不许**被带回来（硬过滤不许被绕过）').not.toContain('nd-nbr-free');
    // 对照组：不给标签时那个邻居就进得来（否则上面那条是空转）
    const plain = search(FILTER, RE_KW, RE_ARGS);
    expect(idsOf(plain), '不给标签时它本来就该被带回来').toContain('nd-nbr-free');
  });

  it('E2 条目级过滤给了 ⇒ 扩召回不参与：输出与不开 `--recall` **逐字节相同**（并在读数里说明原因）', () => {
    mkFilter();
    const a = run(searchArgs(FILTER, RE_KW, ['--mode', paletteRank.DEFAULT_MODE, '--src', 'x']));
    const b = run(searchArgs(FILTER, RE_KW, RE_ARGS.concat(['--src', 'x'])));
    expect(a.code, a.stdout).toBe(0);
    expect(JSON.stringify(JSON.parse(a.stdout).hits), '给了条目级过滤 ⇒ 只允许条目命中')
      .toBe(JSON.stringify(JSON.parse(b.stdout).hits));
    expect(b.stdout, '逐字节相同（扩召回整段不参与）').toBe(a.stdout);
    const ex = search(FILTER, RE_KW, RE_ARGS.concat(['--src', 'x', '--explain'])).explain;
    const asked = ex.recall.routes.filter((r) => r.asked);
    expect(asked.length, '点名的路由必须在读数里').toBeGreaterThan(0);
    expect(asked.every((r) => r.added === 0 && /条目级过滤/.test(String(r.note))),
      '一条都没接回来时必须**说明为什么**（原因里点名那几维条目级过滤）').toBe(true);
  });
});

/* ============================================================================
 * F. `--explain` 逐路点名新取值
 * ========================================================================== */
describe('F. 判据①的形态：`--explain` 逐路点名"新取值是哪一路接回来的"', () => {
  it('F1 `explain.recall` 的形状：逐路在（含没点名的），`added` 与命中里的条数**现算相符**', () => {
    mkGolden();
    const on = search(GOLD, '构建缓存', RE_ARGS.concat(['--explain']));
    const rec = on.explain.recall;
    expect(rec.on).toBe(true);
    expect(rec.asked).toEqual([firstRecall]);
    expect(rec.routes.map((r) => r.id)).toEqual(RECALL_IDS);
    rec.routes.forEach((r) => {
      expect(typeof r.hitValue, r.id + ' 要报它接回来的命中报哪个取值').toBe('string');
      expect(typeof r.bound, r.id + ' 要报上界').toBe('number');
      expect(typeof r.asked).toBe('boolean');
      expect(typeof r.added).toBe('number');
      if (r.asked && r.added === 0) expect(typeof r.note, '接回来 0 条就必须说明原因').toBe('string');
    });
    const asked = rec.routes.filter((r) => r.asked);
    const nearCount = on.hits.filter((h) => h.matchIn === asked[0].hitValue).length;
    expect(asked[0].added, 'added 就是这一批里它接回来的命中数（现算，不写死）').toBe(nearCount);
    // 关着的时候**照样**逐路在（`asked:false` + 说明"只定序、不扩召回"）—— 少一个开关也要看得见
    const off = search(GOLD, '构建缓存', ['--mode', paletteRank.DEFAULT_MODE, '--explain']);
    expect(off.explain.recall.on).toBe(false);
    expect(off.explain.recall.routes.map((r) => r.id)).toEqual(RECALL_IDS);
    off.explain.recall.routes.forEach((r) => {
      expect(r.asked).toBe(false);
      expect(r.added).toBe(0);
      expect(typeof r.note).toBe('string');
    });
  });

  it('F2 新命中的逐路读数：`text` 那一路名次是 `null`（"不是字面命中"看得见），扩召回那一路有整数名次', () => {
    mkGolden();
    const json = search(GOLD, '构建缓存', RE_ARGS.concat(['--explain']));
    expect(json.explain.hits.length).toBe(json.hits.length);
    json.hits.forEach((h, i) => {
      const row = json.explain.hits[i];
      expect(row.nodeId, 'explain.hits 与 hits 逐条同序').toBe(h.nodeId);
      const text = row.parts.filter((p) => p.route === 'text')[0];
      const near = row.parts.filter((p) => p.route === firstRecall)[0];
      if (h.matchIn === hitValueOf(firstRecall)) {
        expect(text.rank, '扩召回命中在字面那一路**没有名次**（它就是被这一路带进来的）').toBe(null);
        expect(Number.isInteger(near.rank) && near.rank >= 1, '带它进来的那一路必须有 1 起的整数名次').toBe(true);
      } else {
        expect(text.rank, '字面命中在字面那一路必须有名次').not.toBe(null);
      }
    });
  });

  it('F3 `--explain` 只多给读数、不改排序（有/无 --explain 逐条同序，含扩召回那一档）', () => {
    mkGolden();
    const a = idsOf(search(GOLD, '构建缓存', RE_ARGS));
    const b = idsOf(search(GOLD, '构建缓存', RE_ARGS.concat(['--explain'])));
    expect(b).toEqual(a);
  });

  it('F4 把扩召回那一路的权重给 0 ⇒ 候选照旧接回来，但读数必须点名"它排在末尾"（不许静默）', () => {
    mkGolden();
    const json = search(GOLD, '构建缓存',
      ['--weights', 'text=1,' + firstRecall + '=0', '--recall', firstRecall, '--explain']);
    const rec = json.explain.recall.routes.filter((r) => r.asked)[0];
    expect(rec.added, '扩召回与权重是两件事：权重 0 也照旧接回来').toBeGreaterThan(0);
    const row = json.explain.routes.filter((r) => r.id === firstRecall)[0];
    expect(row.weight).toBe(0);
    expect(String(row.note), '权重 0 的读数里必须说清"接回来的候选排在末尾"').toContain('权重是 0');
  });
});

/* ============================================================================
 * G. 黄金集扩量 + 读前/读后（hit@1 / hit@3 / MRR **现算**）
 * ========================================================================== */
describe('G. 黄金集：「非字面命中」这一类 + 读前/读后读数', () => {
  const RECALL_QS = GOLDEN.queries.filter((q) => q.needs === 'recall');
  const LITERAL_QS = GOLDEN.queries.filter((q) => q.needs === undefined);
  /** 每条问题自己的档（没写就按默认预设 —— 从 `DEFAULT_MODE` 现取，不写死预设名） */
  const argsOf = (qq) => qq.args || ['--mode', paletteRank.DEFAULT_MODE];
  const rankUnder = (qq, extra) => {
    const json = search(GOLD, qq.q, extra);
    const at = idsOf(json).indexOf(qq.expect);
    return at < 0 ? Infinity : at + 1;
  };
  /** 一组问题的三个读数（**现算**，不写死任何数；`n` 也在里面） */
  function metrics(list, flagsOf) {
    let h1 = 0;
    let h3 = 0;
    let mrr = 0;
    list.forEach((qq) => {
      const r = rankUnder(qq, flagsOf(qq));
      if (r === 1) h1 += 1;
      if (r <= 3) h3 += 1;
      if (Number.isFinite(r)) mrr += 1 / r;
    });
    const n = list.length || 1;
    return { hit1: h1, hit3: h3, mrr: Math.round((mrr / n) * 1000) / 1000, n: list.length };
  }

  it('G1 这一类问题**读前一条都搜不到**（不是"排在后面"）、读后进 topN —— 逐条打印名次', () => {
    mkGolden();
    expect(RECALL_QS.length, 'fixture 里必须有 needs:recall 这一类').toBeGreaterThan(0);
    const lines = [];
    const bad = [];
    RECALL_QS.forEach((qq, i) => {
      const before = rankUnder(qq, withoutRecall(argsOf(qq)));
      const after = rankUnder(qq, argsOf(qq));
      lines.push('  ' + String(i + 1).padStart(2) + '. 「' + qq.q + '」expect=' + qq.expect
        + ' 读前=' + (Number.isFinite(before) ? '第 ' + before + ' 名' : '不在结果里')
        + ' 读后=' + (Number.isFinite(after) ? '第 ' + after + ' 名' : '不在结果里')
        + '（要求 ≤ ' + qq.topN + '）' + (qq.dependsOn ? '  dependsOn=' + qq.dependsOn : ''));
      if (Number.isFinite(before)) bad.push('读前不该搜得到：' + lines[lines.length - 1]);
      if (!(after <= qq.topN)) bad.push('读后没进 topN：' + lines[lines.length - 1]);
    });
    console.log('\n[W4b 黄金集 · 非字面命中这一类] ' + RECALL_QS.length + ' 条：\n' + lines.join('\n'));
    expect(bad, '这一类问题的判据（读前=不在结果里 / 读后=进 topN）').toEqual([]);
  });

  it('G2 读前/读后对比表：两类各自的 hit@1 / hit@3 / MRR（现算打印）+ 只增不许变差', () => {
    const table = [
      { label: '非字面这一类（读前 = 去掉 --recall）', m: metrics(RECALL_QS, (qq) => withoutRecall(argsOf(qq))) },
      { label: '非字面这一类（读后 = 它自己的档）', m: metrics(RECALL_QS, (qq) => argsOf(qq)) },
      { label: '字面那一类（读前 = 它自己的档）', m: metrics(LITERAL_QS, (qq) => argsOf(qq)) },
      { label: '字面那一类（读后 = 再加 --recall）', m: metrics(LITERAL_QS, (qq) => argsOf(qq).concat(['--recall', firstRecall])) }
    ];
    console.log('\n[W4b 黄金集] 读前 / 读后（hit@1 / hit@3 / MRR；' + GOLDEN.queries.length
      + ' 条问题里 ' + RECALL_QS.length + ' 条是非字面这一类）：\n'
      + table.map((t) => '  ' + t.label.padEnd(38) + ' hit@1 ' + String(t.m.hit1).padStart(2) + '/' + t.m.n
        + '   hit@3 ' + String(t.m.hit3).padStart(2) + '/' + t.m.n + '   MRR ' + t.m.mrr).join('\n'));
    const [off, on, litBefore, litAfter] = table.map((t) => t.m);
    expect(off.hit3, '读前：这一类一条都不该进前三（它们是"非字面命中"）').toBe(0);
    expect(off.mrr).toBe(0);
    expect(on.hit3, '读后：这一类全部进前三').toBe(on.n);
    expect(on.mrr, '读后 MRR 必须真的上来').toBeGreaterThan(off.mrr);
    expect(litAfter.hit1 >= litBefore.hit1 && litAfter.hit3 >= litBefore.hit3 && litAfter.mrr >= litBefore.mrr,
      '扩召回不许把**字面那一类**弄坏（读后的三个读数都不许比读前差）').toBe(true);
  });

  it('G3 扩量是"只加新的"：原有那些问题一条都没有 recall 标记，且每条都自带真值四件', () => {
    expect(RECALL_QS.length + LITERAL_QS.length).toBe(GOLDEN.queries.length);
    LITERAL_QS.forEach((q) => {
      expect(q.needs, '原有问题不许被改成扩召回那一类').toBe(undefined);
    });
    RECALL_QS.forEach((q) => expect(q.dependsOn, '这一类必须声明它依赖扩召回那一档').toBe('recall'));
    GOLDEN.queries.forEach((q) => {
      ['q', 'expect', 'topN', 'why'].forEach((k) => {
        expect(q[k], '每条问题都要有 ' + k).toBeTruthy();
      });
      if (q.args) {
        const n = q.args.length;
        expect(n % 2, 'args 必须是成对的开关+取值').toBe(0);
      }
    });
  });
});

/* ============================================================================
 * H. 参数写错响亮（不静默退化）
 * ========================================================================== */
describe('H. `--recall` 写错 ⇒ 响亮报错、报文点名', () => {
  mkGolden();                                   // ⚠️ 必须先建夹具：没有它，"项目不存在"也能让 exit≠0 ⇒ 判据会空转
  const M = ['--mode', paletteRank.DEFAULT_MODE];
  const bad = [
    { argv: ['--recall'], at: '裸写（没有路由名）', said: ['--recall'] },
    { argv: ['--recall', 'nope'].concat(M), at: '不认识的 route', said: ['--recall', 'nope'] },
    { argv: ['--recall', 'trust'].concat(M), at: '认得出但不能扩召回的路由',
      said: ['trust', '不能扩召回'] },
    { argv: ['--recall', firstRecall + ',' + firstRecall].concat(M), at: '同一个路由写两遍',
      said: [firstRecall] },
    { argv: ['--recall', ''].concat(M), at: '空串（= 没给名单）', said: ['--recall'] }
  ];
  bad.forEach((b) => {
    it('H ' + b.at + '：`' + b.argv.join(' ') + '` ⇒ exit≠0，报文点名这个参数', () => {
      const r = run(searchArgs(GOLD, '构建缓存', b.argv));
      expect(r.code, '这些必须退出码非 0').not.toBe(0);
      expect(r.stdout.trim().startsWith('error: '), '必须走"响亮报错"这条路：' + r.stdout).toBe(true);
      b.said.forEach((s) => expect(r.stdout, '报文里要点名：' + s).toContain(s));
      expect(r.stdout, '不许静默退化成 0 命中或默认档').not.toContain('"hits"');
    });
  });
});

/* ============================================================================
 * I. 一处实现（结构断言）
 * ========================================================================== */
describe('I. 扩召回的"一处实现"（结构断言）', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /** 扫 src / cli / scripts（含子目录，跳过 vendor / node_modules）：返回含 needle 的文件（仓库相对路径） */
  function hitsOf(needle) {
    const out = [];
    ['src', 'cli', 'scripts'].forEach((dir) => {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(abs); return; }
        if (!/\.(js|mjs)$/.test(e.name)) return;
        if (fs.readFileSync(abs, 'utf8').indexOf(needle) >= 0) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
      });
      walk(path.join(ROOT, dir));
    });
    return out.sort();
  }

  it('I1 跳数表只有一处实现（扩召回与"图距离"这一路共用它）；能扩召回的路由表也只有一处', () => {
    expect(hitsOf('function graphHopsFrom('), '跳数表只能有一处实现').toEqual(['src/item-index.js']);
    expect(hitsOf('const RECALL_ROUTE_IDS ='), '能扩召回的路由表只能有一处').toEqual(['src/palette-rank.js']);
    expect(hitsOf('function parseRecall('), '`--recall` 的解析只能有一处').toEqual(['src/palette-rank.js']);
    // 扩召回没有第二套打分/排序：命中构造与融合在 item-index 里各只有一个调用点
    const src = read('src/item-index.js');
    expect(src.split('paletteRank.fuse(').length - 1, '融合只有一个调用点').toBe(1);
    expect(src.split('paletteRank.fuzzyMatch(').length - 1, '命中谓词只有一个入口').toBe(1);
    expect(src.split('addHit(').length - 1, '命中入列只有一个口子（faceTexts/facts 的同步靠它）').toBeGreaterThan(1);
    expect(src.includes('recallHit'), '新取值名**不写死**在 item-index 里：从路由表现取').toBe(true);
  });

  it('I2 新取值名的**字面量**只在两处：路由表（声明它）与封闭取值表（收下它）—— 且两处必须一致', () => {
    const places = hitsOf("'near'");
    expect(places, '取值名的字面量只该出现在两处（tests/ 不在扫描面内）')
      .toEqual(['src/item-index.js', 'src/palette-rank.js']);
    // ⭐ 表与实现不许漂：每一路声明的取值都必须在封闭取值表里（去掉表里那一个 ⇒ 这条必红）
    const declared = paletteRank.ROUTES.filter((r) => r.recall).map((r) => r.recallHit);
    expect(declared.length).toBeGreaterThan(0);
    declared.forEach((v) => expect(itemIndex.MATCH_IN, '封闭取值表里必须有：' + v).toContain(v));
    // 封闭表里不许有重复（重复的取值说明有人在两处各加了一次）
    expect(new Set(itemIndex.MATCH_IN).size).toBe(itemIndex.MATCH_IN.length);
  });

  it('I3 命令层与 MCP 层**不写死**取值名 / 上界：都从路由表现取', () => {
    ['cli/registry.js', 'scripts/mcp-server.js'].forEach((rel) => {
      const text = read(rel);
      expect(text.includes("'near'"), rel + ' 里出现了取值名字面量（应从 ROUTES 现取）').toBe(false);
      expect(text.includes('RECALL_ROUTE_IDS'), rel + ' 必须从路由表现取可扩召回的路由').toBe(true);
    });
  });
});

/* ============================================================================
 * J. MCP：`search_nodes` 加参数一层透传，工具数不变
 * ========================================================================== */
describe('J. MCP `search_nodes` 的 `recall` 参数（只加参数）', () => {
  it('J1 与 CLI **逐条同序**、`explain.recall` 同源；工具数 = 真值出口现取的那个数', () => {
    mkGolden();
    const viaMcp = JSON.parse(String(mcp.callTool('search_nodes', {
      project: GOLD, keyword: '构建缓存', no_heat: true, mode: paletteRank.DEFAULT_MODE,
      recall: firstRecall, explain: true
    }).text).trim());
    const viaCli = search(GOLD, '构建缓存', RE_ARGS.concat(['--explain']));
    expect(idsOf(viaMcp), 'MCP 与 CLI 逐条同序（MCP 侧没有第二份扩召回）').toEqual(idsOf(viaCli));
    expect(viaMcp.explain.recall.routes.map((r) => r.id + ':' + r.added + ':' + r.hitValue))
      .toEqual(viaCli.explain.recall.routes.map((r) => r.id + ':' + r.added + ':' + r.hitValue));
    // 工具数 = **真值出口**（docs/VERIFY.md 那一行）现取 —— 不在测试里写死任何计数
    const tools = mcp.TOOLS || [];
    const verify = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
    const m = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verify);
    expect(m, 'docs/VERIFY.md 里必须有「MCP 工具数」那一行').toBeTruthy();
    expect(tools.length, '本件只加参数、不新增工具').toBe(Number(m[1]));
    const props = Object.keys(tools.filter((t) => t.name === 'search_nodes')[0].inputSchema.properties);
    expect(props, 'search_nodes 要有 recall 参数').toContain('recall');
    ['project', 'scope', 'keyword', 'full', 'tag', 'item_level', 'no_heat', 'src', 'verified', 'type', 'since',
      'limit', 'max_bytes', 'mode', 'weights', 'explain'].forEach((k) => {
      expect(props, '既有参数一个都不许少：' + k).toContain(k);
    });
  });
});

/* ============================================================================
 * K. 端到端沙箱：真实 `projects/` 只读 / 零残留 / 零访问日志
 * ========================================================================== */
describe('K. 端到端沙箱不变量', () => {
  /** 目录快照（文件字节 + mtime） */
  function snapshot(dir) {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        out.push(path.relative(dir, abs).split(path.sep).join('/') + '|' + fs.readFileSync(abs).length
          + '|' + fs.statSync(abs).mtimeMs);
      });
    walk(dir);
    return out.join('\n');
  }

  it('K1 沙箱自证 + 扩召回（含 --explain）在项目目录里**零字节** + 真实 `projects/` 只读', () => {
    mkGolden();
    expect(path.resolve(core.PROJECTS_DIR), '沙箱自证：项目根就是临时目录').toBe(path.resolve(SANDBOX));
    expect(path.resolve(SANDBOX).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    const realBefore = snapshot(REAL_PROJECTS);
    const before = snapshot(projDir(GOLD));
    search(GOLD, '构建缓存', RE_ARGS.concat(['--explain']));
    run(['search-all', '构建缓存', '--scope', GOLD, '--no-heat', '--json',
      '--mode', paletteRank.DEFAULT_MODE, '--recall', firstRecall, '--explain']);
    expect(snapshot(projDir(GOLD)), '读命令零字节（埋点写在项目目录**之外**的 .visits/）').toEqual(before);
    expect(snapshot(REAL_PROJECTS), '真实 projects/ 必须一个字节都没动').toEqual(realBefore);
  });

  it('K2 `search-all` 的项目内分片与单项目档**逐条同序**（扩召回逐项目各算各的）', () => {
    mkGolden();
    const all = JSON.parse(run(['search-all', '构建缓存', '--scope', GOLD, '--no-heat', '--json',
      '--mode', paletteRank.DEFAULT_MODE, '--recall', firstRecall]).stdout);
    const one = search(GOLD, '构建缓存', RE_ARGS);
    expect(all.hits.map((h) => h.nodeId + '|' + h.itemId), '逐条同序（含 itemId）')
      .toEqual(one.hits.map((h) => h.nodeId + '|' + h.itemId));
  });

  it('K3 收尾：探针清掉后**没有残留**；探针项目一个访问日志文件都没有（全程 --no-heat）', () => {
    try {
      cleanup();
      PROBES.forEach((p) => {
        expect(fs.existsSync(projDir(p.name)), p.name + ' 应已清掉').toBe(false);
      });
    } finally {
      cleanup();                                   // 幂等：清不掉也不影响判定（afterAll 还会再来一次）
    }
    const leftovers = fs.readdirSync(SANDBOX).filter((n) => /^(it-|imp-probe|w4b-)/.test(n));
    expect(leftovers, '沙箱里不许有探针残留（本件的 w4b-*，以及别的流的 it-*/imp-probe*）').toEqual([]);
    const store = require('../src/data-store.js').createStore(SANDBOX);
    PROBES.forEach((p) => {
      expect(fs.existsSync(store.visitLogFile(p.name)), p.name + ' 不该有访问日志（全程 --no-heat）').toBe(false);
    });
    /* ⚠️ 判据是"**没写过访问日志**"，不是"`.visits/` 目录不存在"：`store.visitLogFile()` 每次调用都会
     * `mkdirSync(recursive)` 建那个目录（路径的唯一推导处也是"让它可写"的唯一处）⇒ 目录在、里面**一个
     * 文件都不该有**（与 W4 的 G4 同一条口径；探针项目已清 ⇒ 残留 0）。
     * 沙箱里除了它不许再有别的东西（探针目录都在 `cleanup()` 里删干净了）。 */
    expect(fs.readdirSync(SANDBOX).filter((n) => n !== '.visits'), '沙箱里不许多出任何东西').toEqual([]);
    const visits = path.join(SANDBOX, '.visits');
    expect(fs.existsSync(visits) ? fs.readdirSync(visits).length : 0,
      'projects/.visits 里的文件数必须是 0').toBe(0);
  });
});

/* ============================================================================
 * L. 交付物闸门：`.review/…/W4b-集成断言原文.js` 可拼贴（拼贴前唯一能机器验的三件事）
 * ========================================================================== */
describe('L. 交付物闸门：`.review/…/W4b-集成断言原文.js`', () => {
  /* 原文是工作产物（`.review/` 可随时删）⇒ 文件不在了这一组就跳过，不会变成常驻空转。 */
  const SRC = path.join(ROOT, '.review', '20261010-卖点与功能-常驻讨论', 'W4b-集成断言原文.js');
  const has = fs.existsSync(SRC);
  const text = has ? fs.readFileSync(SRC, 'utf8') : '';

  it.skipIf(!has)('语法可解析（粘贴进 scripts/cli-integration.js 不会红在语法上）', () => {
    expect(() => new Function('fs', 'path', 'ROOT', 'run', 'check', 'spawnSync', 'require', text)).not.toThrow();
  });

  it.skipIf(!has)('待填字样 0 命中，且不含 G9 判定标记形态', () => {
    expect(text.match(/PLACEHOLDER|TODO|FIXME|XXX/g), '交付文本里不许有待填字样').toBeNull();
    expect(text.match(/\/\/\s*[①-⑳]/g), '`// ` 紧跟圈号会被 G9 当判定标记计数').toBeNull();
  });

  it.skipIf(!has)('前缀只作为一个字面量定义一次（建/清/断言残留都认它）', () => {
    // ⚠️ 前缀自身**拼接构造**：这个文件（测试）也是"数一遍"的人，把字面量原样写进来会让它把自己数成第二处。
    const lit = "'" + 'it-probe-w4b-' + "'";
    let n = 0;
    let at = text.indexOf(lit);
    while (at >= 0) { n += 1; at = text.indexOf(lit, at + lit.length); }
    expect(n, '交付文本里那个前缀字面量只许出现一次').toBe(1);
  });
});
