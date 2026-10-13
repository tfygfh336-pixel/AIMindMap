/* ============================================================
 * tests/search-hybrid.test.js — 【W4】混合检索与"权重怎么处理"
 * 运行：npx vitest run tests/search-hybrid.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的
 *          `## W4｜混合检索与"权重怎么处理"` 一节，原文四条：
 *   ① `--explain` 可见每路贡献；② 黄金集能一键跑；③ 改权重有前后对比；
 *   ④ 注入"某一路恒空" ⇒ 对应断言语义红。
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 *   "一次检索要按相关性之外的第二维（图距离 / 可信度 / 时效）再排一次"与"归因可见"是它的一部分；
 *   实现形态上同时兑现**卖点 6** 的"一份事实一处实现"（路由表 / 预设权重 / `k` / RRF 融合只有
 *   `src/palette-rank.js` 一处，`src/item-index.js` 只把每路的名次算出来喂进去）。
 *
 * ## 这个文件守什么
 *   A. 默认档**逐字节不变**（本件的承重性质）：不给 `--mode` / `--weights` 时
 *      ① 文本档里没有 W4 的任何行；② `--json` 顶层没有 `explain` 键；
 *      ③ 输出与"只开 text 一路"的自定义权重档**逐字节相同**（RRF 对名次严格单调）；
 *      ④ 顺序与"原来那条路"（`src/palette-rank.js` 的 `rankRows`）算出来的一致。
 *      ⚠️ "与改动前逐字节相同"的**跨版本**实证（用 `git archive HEAD` 拉一份改动前的仓跑同一批输入
 *      ⇒ `cmp` 逐字节相同）在交付说明里贴了真实报文；那是一次性迁移证据，不放在常驻测试里
 *      （本件一提交，HEAD 就等于本件 ⇒ 那条对比会变成恒真）。
 *   B. 判据①：`--explain` 逐路 + 逐条可见（含"未安装 / 恒空"那几路与原因）；
 *      `explain.hits` 与 `hits` 逐条同长同序；命中对象**一个键都不加**（12 键契约）。
 *   C. 判据④ + 判据②：**黄金集**（`tests/fixtures/hybrid-golden.json`，18 条真实问题 + 期望命中）
 *      逐档跑 ⇒ 每条问题在**它自己的 args** 下期望命中必须进 topN；
 *      同一张表按档位现算 hit@1 / hit@3 / MRR 并打印前后对比（判据③的读数）。
 *   D. 判据③：改权重**真的会改变结果**（不是"参数收了但没人用"）：balanced ≠ 基线，
 *      且 balanced ≠ conceptual（顺序不同）—— 两条都是**现算**，不写死任何期望顺序。
 *      ⭐ 判别力：图距离那一路**恒空**（在融合入口把这一路的名次删掉）⇒ 黄金集里依赖它的两条必红。
 *   E. 参数写错**响亮**：不认识的 route / 不是数 / 负数 / 同一个 route 两次 / 裸写 / 双给 ⇒ exit≠0
 *      且报文点名（不静默退化成"0 命中"或默认档）。
 *   F. 一处实现（结构断言）：融合 / 权重表 / `k` / 路由表只有 `src/palette-rank.js` 定义；
 *      `src/item-index.js` / `cli/**` 里没有第二份 RRF 公式与权重数字；热度仍在它自己那一处
 *      （`src/heat.js` 的 SEARCH_RANK）且不在路由表里。
 *   G. 端到端不变量：`search` / `search-all` 在项目目录里**零字节**；`search-all` 的项目内分片与
 *      单项目档逐条同序；MCP `search_nodes` 一层透传同源，**工具数不变**（真值从 `docs/VERIFY.md` 现取）；
 *      收尾后 `it-*` / `imp-probe*` 残留 0。
 *   H. 交付物闸门：`.review/…/W4-集成断言原文.js` 可解析、无待填字样、无 G9 判定标记冲突。
 *
 * ## 环境要点（与 tests/search-fuzzy.test.js / search-heat.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 夹具自己造数据 ⇒ 默认**关掉自动埋点**（`heatSensor.__setEnabledForTest(false)`），跑完还原；
 *   3) 端到端一律**进程内** `invokeSync`（不起子进程）；唯一例外是 MCP 那条（要证明的就是那条透传路径）；
 *      全程 `--no-heat`（本件与热度无关，别让本机日志参与）；`projects/` 真实目录**只读**；
 *   4) 临时件与清理都进 `%TEMP%` 沙箱：探针名单只有 `PROBES` 一处，`cleanup()` 一处收尾，
 *      收尾后再断言**没有残留**。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-w4-hybrid-'));
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

/* ---------------- 探针前缀表（**唯一一处**；清理只认它） ---------------- */
const PREFIX = 'w4h-';
const PROBES = [
  { name: PREFIX + 'gold', why: '黄金集语料（判据②③④：多档对比 + 依赖图距离那两条）' },
  { name: PREFIX + 'order', why: '默认档逐字节不变 + 一处实现那几条（小语料）' }
];
const GOLD = PROBES[0].name;
const ORDER = PROBES[1].name;
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

/** 判据②③④的语料：黄金集那份 + 一条**只靠图距离才对**的问题（下面的 X 组用它看"一路恒空"） */
function mkGolden() {
  const dir = projDir(GOLD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projFile(GOLD), JSON.stringify(corpusOf(GOLD).file, null, 2), 'utf8');
  return GOLD;
}

/** 小语料（默认档不变 / 一处实现那几条用；节点顺序刻意与"想要的顺序"不同，防判据空转） */
function mkOrder() {
  const dir = projDir(ORDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projFile(ORDER), JSON.stringify({
    meta: { name: ORDER, author: '', version: '0.18.0', formatVersion: 3 },
    format: 'node_tree',
    data: { id: 'root', topic: 'root', expanded: true, children: [
      { id: 'nd-3', topic: '数据库闸门与门控', children: [] },
      { id: 'nd-1', topic: 'TCP 连接管理', children: [] },
      { id: 'nd-2', topic: '闸控面板', children: [] }
    ] }
  }, null, 2), 'utf8');
  return ORDER;
}

/* ============================================================================
 * A. 判据：**默认档逐字节不变**（本件的承重性质）
 * ========================================================================== */
describe('A. 默认档：不给 --mode / --weights 时输出与从前逐字节相同', () => {
  it('A1 文本档没有 W4 的任何行；`--json` 顶层没有 `explain` 键；命中仍是 12 键', () => {
    mkOrder();
    const text = run(['search', ORDER, '闸门', '--no-heat']);
    expect(text.code, text.stdout).toBe(0);
    expect(text.stdout, '默认档不许出现混合检索那段').not.toContain('混合检索');
    expect(text.stdout, '默认档不许出现 `--explain` 的逐条行').not.toContain('总分');
    const json = search(ORDER, '闸门', []);
    expect(Object.keys(json), 'explain 只在要的时候出现').not.toContain('explain');
    // 命中形状（契约 §3.4）：**只增不改** —— 本件一个新键都不许加，12 键里也不许改名。
    // ⚠️ 不用"逐键全等"：可选键（如 `src`）**没有值时不出现**，那是既有口径（`hitOf` 只在有值时才挂）。
    const CONTRACT = ['id', 'topic', 'nodeId', 'nodeTopic', 'itemId', 'type', 'itemized', 'matchIn',
      'snippet', 'src', 'verified', 'score'];
    json.hits.forEach((h) => {
      Object.keys(h).forEach((k) => {
        expect(CONTRACT, '命中上一个契约外的键都不许有：' + k).toContain(k);
      });
      CONTRACT.forEach((k) => { if (k !== 'src') expect(Object.keys(h), '必有的键：' + k).toContain(k); });
    });
    expect(CONTRACT.indexOf('explain'), 'explain 不是命中上的键（它是顶层平行数组）').toBe(-1);
  });

  it('A2 默认档 == "只开 text 一路"的自定义权重档（逐字节相同），且**与 balanced 档不同**', () => {
    mkGolden();
    // 用黄金集那套语料（它有几条辅助路真的会动顺序的数据）：只在 A 组那种三条题目的小语料上比，
    // "默认被改成开启"这种改法**抓不到** —— 那种语料下几条辅助路本来就不改变顺序（实测踩过）。
    const onlyText = paletteRank.ROUTE_IDS.map((r) => r + '=' + (r === 'text' ? 1 : 0)).join(',');
    const def = run(searchArgs(GOLD, '共享内存', []));
    const w = run(searchArgs(GOLD, '共享内存', ['--weights', onlyText]));
    const bal = run(searchArgs(GOLD, '共享内存', ['--mode', paletteRank.DEFAULT_MODE]));
    expect(def.code, def.stdout).toBe(0);
    expect(w.code, w.stdout).toBe(0);
    expect(bal.code, bal.stdout).toBe(0);
    expect(w.stdout, '只开 text 一路 ⇒ 顺序与默认档逐字节相同').toBe(def.stdout);
    // ⭐ 这一半是**判别力**：没有它，"把默认档改成开启"（注入证明里那一种改法）会让上面那条**恒真**
    expect(bal.stdout, '预设有辅助路时顺序必须与默认档不同 —— 否则"默认档没被改"这件事无法被这条判据看见')
      .not.toBe(def.stdout);
  });

  it('A3 默认档的顺序 == `rankRows` 算出来的顺序（原来那条路没被换掉）', () => {
    const json = search(ORDER, '闸门', []);
    // 独立复算：候选是那三条题目，喂给打分/定序的唯一实现处（与命令面板同一份）
    const rows = [
      { id: 'nd-3', label: '数据库闸门与门控' },
      { id: 'nd-1', label: 'TCP 连接管理' },
      { id: 'nd-2', label: '闸控面板' }
    ];
    const expectOrder = paletteRank.rankRows(rows, '闸门', (r) => r.label).map((r) => r.id);
    expect(idsOf(json), '默认档 = 那一份模糊打分升序（W6 判据② 的基线）').toEqual(expectOrder);
  });
});

/* ============================================================================
 * B. 判据①：`--explain` 逐路可见（含"没出力"的几路与原因）
 * ========================================================================== */
describe('B. 判据①：`--explain` 可见每路贡献', () => {
  it('B1 逐路读数：路由全集都在（含未安装的 semantic 与恒空的那几路），各自说明原因', () => {
    mkGolden();
    const json = search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']);
    const ex = json.explain;
    expect(ex.enabled).toBe(true);
    expect(ex.k, 'k 从唯一那一处现取（本文件不写这个数）').toBe(paletteRank.rrfKOf());
    expect(ex.routes.map((r) => r.id)).toEqual(paletteRank.ROUTE_IDS.slice());
    ex.routes.forEach((r) => {
      expect(typeof r.weight, r.id + ' 要报权重').toBe('number');
      expect(typeof r.ranked, r.id + ' 要报"这一路给了多少条名次"').toBe('number');
    });
    // 未安装那一档必须**点名**（不许静默少一路）
    const sem = ex.routes.filter((r) => r.id === 'semantic')[0];
    expect(sem.installed).toBe(false);
    expect(sem.note, '未安装要说明为什么').toContain('W3');
    // 逐条：每条的 parts 逐路都在，且名次是 1 起的整数或 null
    expect(ex.hits.length).toBe(json.hits.length);
    ex.hits.forEach((h, i) => {
      expect(h.nodeId, 'explain.hits 与 hits 逐条同序').toBe(json.hits[i].nodeId);
      expect(h.itemId).toBe(json.hits[i].itemId);
      expect(h.parts.map((p) => p.route)).toEqual(paletteRank.ROUTE_IDS.slice());
      h.parts.forEach((p) => {
        if (p.rank !== null) expect(Number.isInteger(p.rank) && p.rank >= 1, '名次从 1 起').toBe(true);
      });
      // 总分 = 各路贡献之和（**现算**，不写死任何数字）
      const sum = h.parts.reduce((a, p) => a + p.add, 0);
      expect(Math.abs(sum - h.total), 'total 就是各路之和').toBeLessThan(1e-12);
    });
  });

  it('B2 `--explain` 只多给读数、**不改排序**（同一档下有/无 --explain 逐条同序）', () => {
    const a = idsOf(search(GOLD, '共享内存', ['--mode', 'balanced']));
    const b = idsOf(search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']));
    expect(b).toEqual(a);
  });

  it('B3 权重为 0 的那一路照样出现在读数里（它"没出力"要看得见，不是那一行不存在）', () => {
    const json = search(GOLD, '共享内存', ['--weights', 'text=1', '--explain']);
    const routes = json.explain.routes;
    expect(routes.map((r) => r.id)).toEqual(paletteRank.ROUTE_IDS.slice());
    routes.filter((r) => r.id !== 'text').forEach((r) => {
      expect(r.weight, '没提到的路由权重按 0（完整名单口径）').toBe(0);
    });
    expect(routes.filter((r) => r.id === 'graph')[0].ranked, '权重 0 也照算名次（读数要完整）')
      .toBeGreaterThan(0);
  });
});

/* ============================================================================
 * C. 判据②③：黄金集一键跑 + 改权重的前后对比（数字**全部现算**）
 * ========================================================================== */
describe('C. 判据②③：黄金集 + 改权重的前后对比', () => {
  /** 这条问题要用的档：**它自己的 args**（fixture 里写全）；没写就按默认预设（`DEFAULT_MODE` 现取） */
  const argsOf = (qq) => qq.args || ['--mode', paletteRank.DEFAULT_MODE];
  /** 每条问题跑一次，返回期望命中的名次（1 起；没命中 = Infinity） */
  function rankOf(qq, extra) {
    const argv = argsOf(qq).concat(extra || []);
    const json = search(GOLD, qq.q, argv);
    const at = idsOf(json).indexOf(qq.expect);
    return at < 0 ? Infinity : at + 1;
  }
  /** 一个档位的三个读数（**现算**：hit@1 / hit@3 / MRR）
   *  `档` 由 `extra` 给 —— 只算那些**没带自己 args** 的问题（自带档的那几条不能改档：两种口径同给会响亮报错）。 */
  function metrics(extra) {
    let h1 = 0;
    let h3 = 0;
    let mrr = 0;
    let n = 0;
    GOLDEN.queries.forEach((qq) => {
      if (qq.args !== undefined) return;
      n += 1;
      const json = search(GOLD, qq.q, extra);
      const at = idsOf(json).indexOf(qq.expect);
      const r = at < 0 ? Infinity : at + 1;
      if (r === 1) h1 += 1;
      if (r <= 3) h3 += 1;
      if (Number.isFinite(r)) mrr += 1 / r;
    });
    return { hit1: h1, hit3: h3, mrr: Math.round((mrr / n) * 1000) / 1000, n: n };
  }

  it('C1 每条问题在**它自己的档**下，期望命中都进了 topN', () => {
    mkGolden();
    const bad = [];
    const lines = [];
    GOLDEN.queries.forEach((qq, i) => {
      const r = rankOf(qq);
      lines.push('  ' + String(i + 1).padStart(2) + '. 「' + qq.q + '」' + (qq.args ? ' ' + qq.args.join(' ') : '')
        + ' → 期望 ' + qq.expect + ' 实测第 ' + (Number.isFinite(r) ? r : '—') + ' 名（要求 ≤ ' + qq.topN + '）');
      if (!(r <= qq.topN)) bad.push(lines[lines.length - 1]);
    });
    // 打印真实读数（判据②"一键跑"的可见形态；失败时也能一眼看出是哪条）
    console.log('\n[W4 黄金集] ' + GOLDEN.queries.length + ' 条问题，逐条名次：\n' + lines.join('\n'));
    expect(bad, '这些问题的期望命中没进 topN（topN 是人工判定的容忍度，别改它去迁就实现）').toEqual([]);
  });

  it('C2 改权重有前后对比：逐档打印 hit@1 / hit@3 / MRR（数字全部现算）', () => {
    const onlyText = paletteRank.ROUTE_IDS.map((r) => r + '=' + (r === 'text' ? 1 : 0)).join(',');
    const table = [
      { label: '基线（只开 text 一路 = 默认档行为）', extra: ['--weights', onlyText] },
      { label: 'balanced（默认预设）', extra: ['--mode', 'balanced'] },
      { label: 'recent', extra: ['--mode', 'recent'] },
      { label: 'conceptual', extra: ['--mode', 'conceptual'] }
    ];
    // ⚠️ 自带 args 的那几条（--tag / 自带 --mode / 自带 --weights / 【W4b】自带 --recall）**不进这张对比表**：
    //    它们的档是问题自己指定的，再叠一个 --mode/--weights 就是"两种口径同给"（那会响亮报错 —— 对的）。
    const rows = table.map((t) => Object.assign({ label: t.label }, metrics(t.extra)));
    console.log('\n[W4 黄金集] 各档读数（hit@1 / hit@3 / MRR，共 ' + rows[0].n
      + ' 条不吃自带档的问题；另有 ' + (GOLDEN.queries.length - rows[0].n)
      + ' 条自带 --tag/--mode/--weights/--recall，'
      + '只在 C1 里按自己的档判）：\n'
      + rows.map((r) => '  ' + r.label.padEnd(34) + ' hit@1 ' + String(r.hit1).padStart(2) + '/' + r.n
        + '   hit@3 ' + String(r.hit3).padStart(2) + '/' + r.n + '   MRR ' + r.mrr).join('\n'));
    // 只断言"这几档**不是同一堆数字**"（判据③的判别力：权重真的被用上了）—— 不写死任何读数
    expect(new Set(rows.map((r) => r.hit1 + '/' + r.hit3 + '/' + r.mrr)).size,
      '四个档位给出完全相同的读数 ⇒ 权重没起作用（参数收了但没人用）').toBeGreaterThan(1);
  });

  it('C3 判据③的另一种形态：balanced 与"只开 text 一路"的顺序**真的不同**（现算，不写死顺序）', () => {
    const onlyText = paletteRank.ROUTE_IDS.map((r) => r + '=' + (r === 'text' ? 1 : 0)).join(',');
    const base = idsOf(search(GOLD, '共享内存', ['--weights', onlyText]));
    const bal = idsOf(search(GOLD, '共享内存', ['--mode', 'balanced']));
    expect(base.slice().sort(), '命中集合不变（融合只重排、不增删）').toEqual(bal.slice().sort());
    expect(bal, 'balanced 档必须真的把顺序改了（否则这一层等于没接上）').not.toEqual(base);
    const con = idsOf(search(GOLD, '共享内存', ['--mode', 'conceptual']));
    expect(con, '两个预设必须给出不同顺序（否则预设表是摆设）').not.toEqual(bal);
  });
});

/* ============================================================================
 * D. 判别力：注入 ⇒ 必红 ⇒ 还原 ⇒ 复绿（可重复执行）
 * ========================================================================== */
describe('D. 注入证明（改坏那一处实现 / 让一路恒空 ⇒ 对应判据必红；还原 ⇒ 复绿）', () => {
  /** 依赖**图距离**那一趟的黄金问题（fixture 里用 `dependsOn` 明写，测试不猜） */
  const GRAPH_DEP = GOLDEN.queries.filter((q) => q.dependsOn === 'graph');
  const onlyText = (qq) => ['--weights', paletteRank.ROUTE_IDS.map((r) => r + '=' + (r === 'text' ? 1 : 0)).join(',')];
  const rankOf = (qq, extra) => {
    const json = search(GOLD, qq.q, extra);
    const at = idsOf(json).indexOf(qq.expect);
    return at < 0 ? Infinity : at + 1;
  };

  it('D0 前置：这几条在**自己的档**下达得到 topN，而**只留字面那一路**时到不了（否则注入证明是空转）', () => {
    mkGolden();
    expect(GRAPH_DEP.length, 'fixture 里必须标出依赖图距离的那几条').toBeGreaterThan(0);
    GRAPH_DEP.forEach((qq) => {
      expect(rankOf(qq, qq.args), qq.expect + ' 在自己的档下该在 topN ' + qq.topN + ' 内')
        .toBeLessThanOrEqual(qq.topN);
      expect(rankOf(qq, onlyText(qq)), '只按字面时它到不了 topN —— 这正是"图距离这一路在干活"的证据')
        .toBeGreaterThan(qq.topN);
    });
  });

  it('D1 ⭐ 让**图距离这一路恒空**（在融合入口把它的名次删掉）⇒ 依赖它的黄金问题必红；还原 ⇒ 复绿', () => {
    const real = paletteRank.fuse;
    let broken = null;
    try {
      paletteRank.fuse = (orderings, weights, n) => {
        const cut = Object.assign({}, orderings);
        delete cut.graph;                          // ← 这一路恒空（模拟"图距离算不出来"）
        return real(cut, weights, n);
      };
      broken = GRAPH_DEP.map((qq) => rankOf(qq, qq.args));
    } finally {
      paletteRank.fuse = real;                     // ⚠️ 还原（哪怕上面抛了）
    }
    GRAPH_DEP.forEach((qq, i) => {
      expect(broken[i] > qq.topN, qq.expect + ' 在"图距离恒空"下必须掉出 topN（判据④），实测第 '
        + (Number.isFinite(broken[i]) ? broken[i] : '—') + ' 名').toBe(true);
    });
    expect(GRAPH_DEP.every((qq) => rankOf(qq, qq.args) <= qq.topN), '还原后必须复绿').toBe(true);
  });

  it('D2 把 **RRF 融合本身**改成"原样返回"（= 这一层不生效）⇒ 黄金集那条依赖融合的必红；还原 ⇒ 复绿', () => {
    const real = paletteRank.fuse;
    const qq = GRAPH_DEP[0];
    let broken = null;
    try {
      paletteRank.fuse = (orderings, weights, n) => {
        const out = real(orderings, weights, n);
        const text = (orderings && Array.isArray(orderings.text)) ? orderings.text : [];
        return Object.assign({}, out, { order: text.length ? text.slice() : out.order });
      };
      broken = rankOf(qq, qq.args);
    } finally {
      paletteRank.fuse = real;
    }
    expect(broken > qq.topN, '融合退化成"按字面顺序" ⇒ 这条必掉出 topN').toBe(true);
    expect(rankOf(qq, qq.args)).toBeLessThanOrEqual(qq.topN);
  });

  it('D3 把 `k` 换成一个极端值 ⇒ 读数是**现取**的（`--explain` 里跟着变）；还原 ⇒ 复绿', () => {
    const real = search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']).explain.k;
    const old = paletteRank.__setRrfKForTest(1);
    try {
      const ex = search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']).explain;
      expect(ex.k, 'k 不是抄在命令层的数字').toBe(1);
      expect(ex.k).not.toBe(real);
    } finally {
      paletteRank.__setRrfKForTest(old);
    }
    expect(search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']).explain.k).toBe(real);
  });
});
/* ============================================================================
 * E. 参数写错响亮（不静默退化）
 * ========================================================================== */
describe('E. `--mode` / `--weights` 写错 ⇒ 响亮报错', () => {
  mkGolden();                                   // ⚠️ 必须先建夹具：没有它，"项目不存在"也能让 exit≠0 ⇒ 判据会空转
  const bad = [
    { argv: ['--weights', 'bogus=1'], at: '不认识的 route', said: ['--weights', 'bogus'] },
    { argv: ['--weights', 'text'], at: '少了 =', said: ['--weights', 'text'] },
    { argv: ['--weights', 'text=abc'], at: '不是数', said: ['--weights', 'text', 'abc'] },
    { argv: ['--weights', 'text=-1'], at: '负数', said: ['--weights', 'text'] },
    { argv: ['--weights', 'text=1,text=2'], at: '同一个 route 写两次', said: ['--weights', 'text'] },
    { argv: ['--weights'], at: '裸写（没有名单）', said: ['--weights'] },
    { argv: ['--mode', 'nope'], at: '不认识的预设', said: ['--mode', 'nope'] },
    { argv: ['--mode'], at: '裸写（没有预设名）', said: ['--mode'] },
    { argv: ['--mode', 'balanced', '--weights', 'text=1'], at: '两个同给（两种口径不混）',
      said: ['--mode', '--weights'] }
  ];
  bad.forEach((b) => {
    it('E ' + b.at + '：`' + b.argv.join(' ') + '` ⇒ exit≠0，报文**点名这个参数**', () => {
      const r = run(searchArgs(GOLD, '共享内存', b.argv));
      expect(r.code, '这些必须退出码非 0').not.toBe(0);
      expect(r.stdout.trim().startsWith('error: '), '必须走"响亮报错"这条路：' + r.stdout).toBe(true);
      // ⭐ 报错必须**因为这一条**（否则"项目不存在 / 夹具没建"这类无关失败也能让上面两条成立 = 空转）
      b.said.forEach((s) => {
        expect(r.stdout, '报文里要点名：' + s).toContain(s);
      });
      expect(r.stdout, '不许静默退化成 0 命中或默认档').not.toContain('"hits"');
    });
  });

  it('E10 `search-all` 与 `search` **同一处解析**（报文逐字同源）', () => {
    const one = run(searchArgs(GOLD, '共享内存', ['--weights', 'bogus=1']));
    const all = run(['search-all', '共享内存', '--no-heat', '--weights', 'bogus=1']);
    expect(one.code).not.toBe(0);
    expect(all.code).not.toBe(0);
    expect(all.stdout).toBe(one.stdout);
    expect(all.stdout, '两边都不是"项目不存在"那类无关失败').toContain('bogus');
  });
});

/* ============================================================================
 * F. 一处实现（结构断言）
 * ========================================================================== */
describe('F. 融合 / 权重 / 路由表只有一处实现（结构断言）', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /** 扫 src / cli / renderer / scripts（含子目录，跳过 vendor）：返回含 needle 的文件（仓库相对路径） */
  function hitsOf(needle) {
    const out = [];
    ['src', 'cli', 'renderer', 'scripts'].forEach((dir) => {
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

  it('F1 RRF 融合与权重表只有 `src/palette-rank.js` 一处', () => {
    expect(hitsOf('function fuse('), '融合的定义处只能是它').toEqual(['src/palette-rank.js']);
    expect(hitsOf('const RRF_K ='), '平滑常数 k 只能定义一处').toEqual(['src/palette-rank.js']);
    expect(hitsOf('const MODES = Object.freeze('), '预设权重表只能定义一处').toEqual(['src/palette-rank.js']);
    expect(hitsOf('const ROUTES = Object.freeze('), '路由表只能定义一处').toEqual(['src/palette-rank.js']);
  });

  it('F2 `src/item-index.js` 只**喂名次**，不写第二份融合/权重/数字', () => {
    const src = read('src/item-index.js');
    expect(src, '必须真的走共享融合').toContain('paletteRank.fuse(');
    expect(src, '必须真的走共享解析').toContain('paletteRank.hybridSpecOf(');
    /* ⚠️ 【W4b】**如实改口径**（不是放宽）：上界从"图距离那一段里现取"变成**同一处 `hopsOf` 里现取** ——
     * 因为扩召回与图距离这一路问的是同一个问题（头名的有界邻域）⇒ 共用同一张跳数表，
     * 两处各算一遍必然出现"排得上名次却进不了候选集"。判据仍然是那两条：
     *   ① 上界必须**从路由表那一行现取**；② 不许把跳数写死在 `src/item-index.js` 里。 */
    expect(src, '图距离 / 扩召回的深度上界必须从路由表现取').toContain('maxHops: row.bound');
    expect(src.includes('maxHops: 2'), '不许把跳数写死在 item-index 里').toBe(false);
    // 它自己一个 RRF 公式都不许有（`/(k + rank)` 那种写法一旦回到这里就红）
    expect(src.includes('/(k + rank)'), 'item-index 里不许出现第二份 RRF 公式').toBe(false);
    expect(src.includes('RRF_K'), 'item-index 里不许出现 k').toBe(false);
    // 预设权重那几个数也不许抄过来
    [['text: 1'], ['graph: 0.5'], ['merge'], ['k: 60']].forEach((bad2) => {
      expect(src.includes(bad2[0]), 'item-index 里不许出现权重的字面副本：' + bad2[0]).toBe(false);
    });
  });

  it('F3 热度仍在自己那一处，且**不在** W4 的路由表里（两条裁决不混）', () => {
    expect(hitsOf('const SEARCH_RANK = Object.freeze('), '热度的三条上限只有 src/heat.js 一处')
      .toEqual(['src/heat.js']);
    expect(paletteRank.ROUTE_IDS.indexOf('heat'), '热度不是 W4 的一路').toBe(-1);
    // 最后一道仍是 orderByHeat（W4 的融合在它**之前**）
    const src = read('src/item-index.js');
    expect(src.indexOf('paletteRank.fuse('), '融合在热度之前').toBeLessThan(src.indexOf('orderByHeat(baseline, o.heat)'));
  });

  it('F4 MCP 侧只加参数：`scripts/mcp-server.js` 里没有第二份权重/k/路由清单', () => {
    const src = read('scripts/mcp-server.js');
    expect(src, '预设表从单源现取').toContain('paletteSpec.MODES');
    expect(src.includes('0.06'), '不许抄热度数字').toBe(false);
    expect(src.includes('= 60'), '不许抄 k').toBe(false);
  });
});

/* ============================================================================
 * G. 端到端不变量：零字节 / search-all 同源 / MCP 工具数不变 / 残留 0
 * ========================================================================== */
describe('G. 端到端不变量', () => {
  /** 目录快照（文件字节 + mtime）：钉"只读检索在项目目录里零字节" */
  function snapshot(dir) {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        const buf = fs.readFileSync(abs);
        out.push(path.relative(dir, abs).split(path.sep).join('/') + '|' + buf.length + '|' + fs.statSync(abs).mtimeMs);
      });
    walk(dir);
    return out;
  }

  it('G1 混合检索（含 --explain）在**项目目录里零字节**；沙箱自证', () => {
    expect(path.resolve(core.PROJECTS_DIR), '沙箱自证：项目根就是临时目录').toBe(path.resolve(SANDBOX));
    expect(path.resolve(SANDBOX).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    const before = snapshot(projDir(GOLD));
    search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']);
    run(['search-all', '共享内存', '--scope', GOLD, '--no-heat', '--mode', 'balanced', '--json']);
    expect(snapshot(projDir(GOLD)), '读命令零字节（埋点写在项目目录**之外**的 .visits/）').toEqual(before);
  });

  it('G2 `search-all` 的项目内分片与单项目档**逐条同序**（融合逐项目各算各的）', () => {
    const all = JSON.parse(run(['search-all', '共享内存', '--scope', GOLD, '--no-heat',
      '--mode', 'balanced', '--json']).stdout);
    const one = search(GOLD, '共享内存', ['--mode', 'balanced']);
    expect(all.hits.map((h) => h.nodeId + '|' + h.itemId), '逐条同序（含 itemId）')
      .toEqual(one.hits.map((h) => h.nodeId + '|' + h.itemId));
    const ex = JSON.parse(run(['search-all', '共享内存', '--scope', GOLD, '--no-heat',
      '--mode', 'balanced', '--explain', '--json']).stdout).explain;
    expect(ex.hits.length, 'explain.hits 与 hits 同长').toBe(
      JSON.parse(run(['search-all', '共享内存', '--scope', GOLD, '--no-heat', '--mode', 'balanced', '--json']).stdout).hits.length);
    expect(ex.hits.map((h) => h.project), '跨项目的每条读数都要点名项目').toEqual(ex.hits.map(() => GOLD));
  });

  it('G3 MCP `search_nodes` 一层透传同源，且**工具数不变**（真值从 docs/VERIFY.md 现取）', () => {
    const srv = path.join(ROOT, 'scripts', 'mcp-server.js');
    const reqs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes',
        arguments: { project: GOLD, keyword: '共享内存', no_heat: true, mode: 'balanced', explain: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' }
    ];
    const sp = spawnSync(process.execPath, [srv], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
    });
    const replies = String(sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
    const viaMcp = JSON.parse(replies.filter((x) => x && x.id === 2)[0].result.content[0].text);
    const viaCli = search(GOLD, '共享内存', ['--mode', 'balanced', '--explain']);
    expect(viaMcp.hits.map((h) => h.nodeId), 'MCP 与 CLI 逐条同序（MCP 侧没有第二份融合）')
      .toEqual(viaCli.hits.map((h) => h.nodeId));
    expect(viaMcp.explain.routes.map((r) => r.id + ':' + r.ranked),
      'explain 也逐路同源').toEqual(viaCli.explain.routes.map((r) => r.id + ':' + r.ranked));
    // 工具数 = **真值出口**（docs/VERIFY.md 生成物里那一行）现取 —— 不在测试里写死任何计数
    const tools = (replies.filter((x) => x && x.id === 3)[0].result.tools) || [];
    const verify = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
    const m = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verify);
    expect(m, 'docs/VERIFY.md 里必须有「MCP 工具数」那一行').toBeTruthy();
    expect(tools.length, '工具数必须等于真值出口报的那个数（本件只加参数、不新增工具）').toBe(Number(m[1]));
    const props = Object.keys(tools.filter((t) => t.name === 'search_nodes')[0].inputSchema.properties);
    ['mode', 'weights', 'explain'].forEach((k) => {
      expect(props, 'search_nodes 要有 ' + k + ' 参数').toContain(k);
    });
    // 参数是**只增**：既有的那批一个都没少
    ['project', 'scope', 'keyword', 'full', 'tag', 'item_level', 'no_heat', 'src', 'verified', 'type', 'since',
      'limit', 'max_bytes'].forEach((k) => expect(props, '既有参数不能少：' + k).toContain(k));
    // 工具定义表本身没被改坏（每个工具仍只对应一个 CLI 调用）——`mcp` 导出可读，顺带钉一下
    expect(Array.isArray(mcp.TOOLS)).toBe(true);
  });

  it('G4 收尾：探针清掉后没有残留；`--no-heat` 全程没写过任何访问日志', () => {
    try {
      cleanup();
      PROBES.forEach((p) => {
        expect(fs.existsSync(projDir(p.name)), p.name + ' 应已清掉').toBe(false);
      });
    } finally {
      cleanup();                                   // 幂等：清不掉也不影响判定（afterAll 还会再来一次）
    }
    const leftovers = fs.readdirSync(SANDBOX).filter((n) => /^(it-|imp-probe)/.test(n));
    expect(leftovers, '沙箱里不许有集成探针残留').toEqual([]);
    /* ⚠️ 判据是"**没写过访问日志**"，不是"`.visits/` 目录不存在"：
     * `store.visitLogFile()` 每次调用都会 `mkdirSync(recursive)` 建那个目录（见 data-store 的说明：
     * 路径的唯一推导处也是"让它可写"的唯一处）⇒ 目录在、但**一个日志文件都不该有**。
     * 本文件全程 `--no-heat` ⇒ 两个探针项目都不许有日志文件。 */
    const store = require('../src/data-store.js').createStore(SANDBOX);
    PROBES.forEach((p) => {
      expect(fs.existsSync(store.visitLogFile(p.name)), p.name + ' 不该有访问日志（全程 --no-heat）').toBe(false);
    });
  });
});

/* ============================================================================
 * H. 交付物闸门：集成断言原文可解析、无待填字样、无判定标记冲突（拼贴前唯一能机器验的三件事）
 * ========================================================================== */
describe('H. 交付物闸门：`.review/…/W4-集成断言原文.js` 可拼贴', () => {
  /* 原文是工作产物（`.review/` 可随时删）⇒ 文件不在了这一组就跳过，不会变成常驻空转。 */
  const SRC = path.join(ROOT, '.review', '20261010-卖点与功能-常驻讨论', 'W4-集成断言原文.js');
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
    const lit = "'" + 'it-probe-w4-' + "'";
    let n = 0;
    let at = text.indexOf(lit);
    while (at >= 0) { n += 1; at = text.indexOf(lit, at + lit.length); }
    expect(n, '交付文本里那个前缀字面量只许出现一次').toBe(1);
  });
});
