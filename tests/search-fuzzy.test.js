/* ============================================================
 * tests/search-fuzzy.test.js — 【W6】把命令面板那套模糊排序给 AI 侧
 * 运行：npx vitest run tests/search-fuzzy.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 `## W6｜把命令面板那套模糊排序给 AI 侧`
 * 一节，原文两条：
 *   ① **查询词是非连续子序列时 CLI 也能命中**；
 *   ② **同一查询在 UI 与 CLI 得到一致顺序**。
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 * 检索的**召回**（子序列命中）与**可预期顺序**是它的一部分；实现形态上同时兑现**卖点 6**
 * 的那条"一份事实一处实现"（打分/定序只有 `src/palette-rank.js` 一处，命令面板与 AI 侧同吃）。
 *
 * ## 这个文件守什么
 *   A. 判据①：非连续子序列在 **CLI** 也命中（含"那条针**确实不是**子串"的前置条件，
 *      否则这条判据可能被"子串恰好也命中"混过去 = 空转）；不匹配的**仍然**不命中（防止放宽成"全命中"）。
 *   B. 判据②：同一查询下，**命令面板给的节点顺序**与 **CLI 给的顺序**逐条相同
 *      （两侧都调 `rankRows`）；面板多一个**同分命令**也不改节点之间的相对序；
 *      有热度时**命中集合不变**（热度只重排），而 `--no-heat` 档与面板**逐条同序**。
 *   C. "一处实现"的结构把守：`src/item-index.js` 只许**调**那一份打分与定序，
 *      不许再写第二份字面匹配；全仓只有 `src/palette-rank.js` 定义 `fuzzyMatch` / `rankRows`。
 *   D. 判别力（可重复执行，不是"手改源码跑一次"）：把 `rankRows` 改成不排序 ⇒ 判据②必红；
 *      把 `fuzzyMatch` 退化回"只认子串" ⇒ 判据①必红；各自在 `finally` 里还原 ⇒ 复绿。
 *   E. 端到端不变量：只读检索在**项目目录里零字节**；MCP 一层透传**同源**且**没有新增工具**。
 *   F. 交付物闸门：交给整合流粘贴的那段集成断言原文**可解析、无待填字样、无 G9 判定标记冲突**
 *      （本件不跑集成，那一段只能这样先机器验一遍；文件不在就跳过）。
 *
 * ## 环境要点（与 tests/search-heat.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 夹具自己造热度日志 ⇒ 默认**关掉自动埋点**（`heatSensor.__setEnabledForTest(false)`），跑完还原；
 *   3) 端到端一律**进程内** `invokeSync`（不起子进程）；唯一例外是 MCP 那条 ——
 *      "MCP 转发到 CLI 子进程"正是要证明的透传路径；
 *   4) `projects/` 真实目录**只读**；临时件与清理**都进 `%TEMP%` 沙箱**：探针名单只有 `PROBES` 一处，
 *      `cleanup()` 一处收尾（`afterAll` + 需要时 `try/finally`），收尾后再断言**没有残留**。
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
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-w6-fuzzy-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const itemIndex = require('../src/item-index.js');
const paletteRank = require('../src/palette-rank.js');
const heatSensor = require('../src/heat-sensor.js');
const store = require('../src/data-store.js').createStore(SANDBOX);
const mcp = require('../scripts/mcp-server.js');

heatSensor.__setEnabledForTest(false);      // 夹具自己那份热度必须只有我写的事件（见文件头 ②）

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 探针前缀表（**唯一一处**；清理只认它） ---------------- */
const PREFIX = 'w6f-';
const PROBES = [
  { name: PREFIX + 'sub', why: '判据①：非连续子序列命中' },
  { name: PREFIX + 'order', why: '判据②：UI 与 CLI 一致顺序 + 热度只重排' }
];
/** 清理的唯一入口（`afterAll` 与用例内的 `try/finally` 都走它）——别处不许各写一遍 rmSync。
 *  `only` 给了就只清那几个（用例想留别的探针给后面的用例时必须给）。 */
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
const jrun = (argv, msg) => {
  const r = run(argv);
  expect(r.code, (msg || argv.join(' ')) + ' 失败：' + r.stdout).toBe(0);
  return JSON.parse(r.stdout);
};

/** 建一个项目：root 下按给定顺序挂节点（**DFS 序 = 面板 seeing 的顺序**，见 `cli/commands/project.js` 的 list） */
function mkProject(name, nodes) {
  fs.mkdirSync(projDir(name), { recursive: true });
  fs.writeFileSync(projFile(name), JSON.stringify({
    meta: { name: name, author: '', version: '0.18.0', formatVersion: 3 },
    format: 'node_tree',
    data: { id: 'root', topic: 'root', expanded: true, children: nodes.map((n) => ({
      id: n.id, topic: n.topic, children: [] })) }
  }, null, 2), 'utf8');
  return name;
}

const SUB = PROBES[0].name;
const ORDER = PROBES[1].name;

/** 判据①的夹具（**只搜标题**：这些都是未条目化节点 ⇒ 命中面 = topic） */
const SUB_TOPICS = [
  ['nd-1', 'TCP 连接管理'],          // 'tp' / 'tcp' 都能命中
  ['nd-2', 'HTTP 超文本传输协议'],
  ['nd-3', '数据库闸门与门控'],        // '闸控' 是**非连续**子序列（闸…控）
  ['nd-4', '闸控面板'],              // '闸控' 在这里是**子串**（对照：两条路都命中）
  ['nd-5', 'tcp 小写标题'],          // 大小写折叠的对照（数据是小写、针是大写）
  ['nd-6', '无关节点']
];
/** 判据②的夹具：刻意让四个题目的**分数各不相同**（否则"顺序"这条判据可能靠稳定排序蒙对） */
const ORDER_TOPICS = [
  ['nd-1', '闸门一'],               // 前缀命中、短 ⇒ 分最优
  ['nd-2', '闸门数据'],
  ['nd-3', '数据闸门'],             // 中段命中 ⇒ 分最差
  ['nd-4', '闸 门 分开的标题']        // 非连续命中（中间隔了空格）
];

const searchJson = (proj, kw, extra) => jrun(['search', proj, kw, '--json'].concat(extra || []));
const hitIds = (j) => j.hits.map((h) => h.nodeId);
const topicHitIds = (j) => j.hits.filter((h) => h.matchIn === 'topic').map((h) => h.nodeId);
/** 命令面板那一侧：`app-palette.js` 喂给 rankPalette 的候选就是 `list --json` 的节点（DFS 序）+ 命令 */
const uiEntries = (proj, cmds) => jrun(['list', proj, '--json']).nodes
  .map((n) => ({ kind: 'node', id: n.id, label: n.topic }))
  .concat(cmds || []);
const uiNodeOrder = (proj, kw, cmds) => paletteRank
  .rankPalette(uiEntries(proj, cmds), kw, 0)
  .filter((e) => e.kind === 'node')
  .map((e) => e.id);

/* ============================================================================
 * A. 判据①：查询词是**非连续子序列**时 CLI 也能命中
 * ========================================================================== */
describe('A. 判据①：非连续子序列在 CLI 也能命中（不是"只有面板能"）', () => {
  mkProject(SUB, SUB_TOPICS.map(([id, topic]) => ({ id: id, topic: topic })));

  it('A1 前置条件 + 命中：`TC连` **不是**任何题目的子串（大小写折叠后也不是），却照样命中', () => {
    /* 判别力前提：若这个关键词本来就是子串，那"A 也命中"可能只是子串匹配的功劳 ⇒ 空转。
     * ⚠️ 折叠大小写后再判（`tp` 那种针不行：'HTTP' 里有 'TP' —— 它是**大小写折叠后的子串**，
     * 拿它当"非连续"的例子会自欺）。这条前置断言红了，说明夹具不再能证明"非连续"这件事。 */
    SUB_TOPICS.forEach(([id, topic]) => {
      expect(topic.toLowerCase().indexOf('tc连') < 0, '夹具前提：' + id + ' 的标题里不含子串 `TC连`')
        .toBe(true);
    });
    expect(itemIndex.faceMatch('TC连', 'TCP 连接管理')).not.toBeNull();   // 谓词本身（唯一实现）
    const j = searchJson(SUB, 'TC连', ['--no-heat']);
    expect(hitIds(j)).toEqual(['nd-1']);                     // 只有它同时含 T/C/连
    expect(j.hits[0].matchIn).toBe('topic');
    expect(j.hits[0].snippet).toContain('TCP 连接管理');
    /* 哪一行坏了会让它红：把 `searchItems` 的关键词判定改回 `indexOf(kw) >= 0`
     * （或把 `faceMatch` 换成子串谓词）⇒ 这里**一条都返回不了** ⇒ 红。 */
  });

  it('A2 中文跨字：`闸控` 命中 `数据库闸门与门控`（非连续）**并且**命中 `闸控面板`（子串）', () => {
    expect('数据库闸门与门控'.indexOf('闸控'), '夹具前提：这不是子串').toBe(-1);
    expect('闸控面板'.indexOf('闸控') >= 0, '夹具前提：这一条是子串').toBe(true);
    expect(hitIds(searchJson(SUB, '闸控', ['--no-heat'])), '两条不同来路的命中都在（子串是子序列的特例）')
      .toEqual(['nd-4', 'nd-3']);
    /* 顺序也一并钉住：nd-4（前缀命中、4 字）优于 nd-3（中段命中、8 字）。
     * 坏了会红的那一行：`rankRows` 不再按分数升序（A2 的顺序期望 + 下面的注入用例一起抓）。 */
  });

  it('A3 大小写不敏感：小写针命中大写数据、混合大小写针命中纯小写数据', () => {
    // 两条都要**先证明"大小写敏感的话它就不该命中"**，否则"不敏感"这句话是空话
    expect(SUB_TOPICS.filter(([id]) => id === 'nd-1')[0][1].indexOf('tcp 连接'), '大小写敏感时不该命中')
      .toBe(-1);
    expect(SUB_TOPICS.filter(([id]) => id === 'nd-5')[0][1].indexOf('Tcp 小写'), '大小写敏感时不该命中')
      .toBe(-1);
    expect(hitIds(searchJson(SUB, 'tcp 连接', ['--no-heat'])), '数据是「TCP 连接管理」、针是小写').toEqual(['nd-1']);
    expect(hitIds(searchJson(SUB, 'Tcp 小写', ['--no-heat'])), '数据是「tcp 小写标题」、针是混合大小写').toEqual(['nd-5']);
    /* 坏了会红的那一行：`fuzzyMatch` 里去掉 `.toLowerCase()` 两处（大小写折叠是它的一部分）。 */
  });

  it('A4 不匹配的仍然不命中（不许为了"能命中"放宽成"全命中"）', () => {
    SUB_TOPICS.forEach(([id, topic]) => {
      expect(topic.toLowerCase().indexOf('z') < 0 || topic.toLowerCase().indexOf('z' + 'q') < 0).toBe(true);
    });
    const j = searchJson(SUB, 'zzq', ['--no-heat']);
    expect(j.hits).toEqual([]);
    expect(j.hitCount).toBe(0);
    // 文字档也要**说话**（零结果是明确的，不是空输出）
    const t = run(['search', SUB, 'zzq', '--no-heat']);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('命中 0 条');
    // 反例再选一个"字符都在、但顺序不对"的针：'门空'（门…空）在夹具里没有
    expect(searchJson(SUB, '门空', ['--no-heat']).hitCount).toBe(0);
    /* 坏了会红的那一行：`fuzzyMatch` 把"找不到字符就 return null"改成"随便返回一个分数"。 */
  });

  it('A5 模糊命中的 snippet 取的是**命中首字符**的位置（不是"找不到位置就取头部"）', () => {
    const j = searchJson(SUB, '闸控', ['--no-heat']);
    const nd4 = j.hits.filter((h) => h.nodeId === 'nd-4')[0];
    const nd3 = j.hits.filter((h) => h.nodeId === 'nd-3')[0];
    expect(nd4.snippet).toBe('闸控面板');
    expect(nd3.snippet).toContain('闸门与门控');        // 窗口从「闸」开始，而不是另一段
    expect(nd3.score, 'score 的口径没变：模糊命中的出现次数回落到 1（不是排序分）').toBe(1);
    /* 坏了会红的那一行：`addHit(hitOf(..., { snippet: clip(face.text, face.start) }))` 里
     * 把 `face.start` 换回 `-1`（那会让模糊命中的窗口退回"正文头部"，这里立刻红）。 */
  });
});

/* ============================================================================
 * B. 判据②：同一查询在 UI 与 CLI 得到一致顺序
 * ========================================================================== */
describe('B. 判据②：同一查询 UI 与 CLI 一致顺序（两侧同吃 rankRows）', () => {
  mkProject(ORDER, ORDER_TOPICS.map(([id, topic]) => ({ id: id, topic: topic })));
  const KW = '闸门';

  it('B1 命令面板给的节点顺序 == CLI 给的顺序（逐条相同），且**不是** DFS 序（否则判据空转）', () => {
    const ui = uiNodeOrder(ORDER, KW);
    const cli = topicHitIds(searchJson(ORDER, KW, ['--no-heat']));
    expect(ui.length, '夹具前提：四条都要命中（否则"顺序"无从谈起）').toBe(ORDER_TOPICS.length);
    expect(cli, 'CLI 的顺序必须与面板**逐条相同**').toEqual(ui);
    expect(cli, '判别力前提：这份顺序不能恰好就是 DFS 序（不然排序没生效也看不出来）')
      .not.toEqual(ORDER_TOPICS.map(([id]) => id));
    /* 坏了会红的两行（任选其一）：
     *   · `src/item-index.js` 不再调 `paletteRank.rankRows`（CLI 回到 DFS 序 ⇒ 第二条 toEqual 红）；
     *   · `src/palette-rank.js` 的 `rankRows` 不再按分数升序（两侧一起错，但第三条 not.toEqual 红）。 */
  });

  it('B2 面板多一个**同分命令**也不改节点之间的相对序（那一条 tieBreak 是面板专有的）', () => {
    const withCmd = uiNodeOrder(ORDER, KW, [{ kind: 'cmd', label: '闸门一' }]);   // 与 nd-1 同分
    expect(withCmd).toEqual(uiNodeOrder(ORDER, KW));
    const ranked = paletteRank.rankPalette(uiEntries(ORDER, [{ kind: 'cmd', label: '闸门一' }]), KW, 0);
    const posCmd = ranked.findIndex((e) => e.kind === 'cmd');
    const posNode = ranked.findIndex((e) => e.kind === 'node' && e.label === '闸门一');
    expect(posCmd, '同分时命令在前 —— 这条规则只属于面板').toBeLessThan(posNode);
    expect(posCmd, '同分的那一对必须紧挨着（不是"命令被挪到很前面"）').toBe(posNode - 1);
    /* 坏了会红的那两行：
     *   · 把 `rankPalette` 的 `tieBreak` 去掉（命令不再优先）⇒ 第一条 sort 断言红；
     *   · 把那份 tieBreak 挪进 `rankRows`（检索也跟着改序）⇒ 上面那条 `withCmd` 去重断言红。 */
  });

  it('B3 有热度时：命中集合不变（热度只重排），而 `--no-heat` 档与面板逐条同序', () => {
    // 给"最差的那一条"（nd-3，DFS 序里在中间）加热度：热度若真生效，它可能被往前挪
    const v = run(['visit', ORDER, 'nd-3', '--channel', 'human-detail']);
    expect(v.code, v.stdout).toBe(0);
    const hot = searchJson(ORDER, KW);
    const noHeat = searchJson(ORDER, KW, ['--no-heat']);
    expect(hot.hits.map((h) => h.nodeId).sort(), '热度只排序 ⇒ 命中多重集不变')
      .toEqual(noHeat.hits.map((h) => h.nodeId).sort());
    expect(hot.hitCount).toBe(noHeat.hitCount);
    expect(topicHitIds(noHeat), '零热度档 = 面板顺序（这条是"一致顺序"的可断言形态）')
      .toEqual(uiNodeOrder(ORDER, KW));
    // 热度那一档如实自报"这次排序被热度推动过"（不是静默）
    expect(hot.heat.applied).toBe(true);
    /* 坏了会红的那一行：`searchItems` 把 `orderByHeat` 删掉（`hot.heat.applied` 就没人算了 ⇒
     * `--json` 的 heat 会缺；或在 orderByHeat 里对入参做增删 ⇒ 多重集断言红）。 */
  });
});

/* ============================================================================
 * C. "一处实现"的结构把守（不是靠人自觉）
 * ========================================================================== */
describe('C. 打分与定序只有一处实现（结构断言）', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /**
   * 去注释（**照 `scripts/dep-direction-check.js` 的同一条理由**：门禁的输入必须是**代码**，
   * 不是散文 —— 本文件下面的断言要在 `src/item-index.js` 里找"还有没有第二份字面匹配"，
   * 而那个文件的注释里**故意**写着旧写法（`n.topic.indexOf(kw) >= 0`）当反面教材）。
   */
  function stripComments(src) {
    const text = String(src);
    let out = '';
    let i = 0;
    let state = 'code';
    while (i < text.length) {
      const c = text[i];
      const c2 = text[i + 1];
      if (state === 'code') {
        if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
        if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
        if (c === "'" || c === '"' || c === '`') { state = c === "'" ? 'sq' : (c === '"' ? 'dq' : 'tpl'); out += c; i++; continue; }
        out += c; i++; continue;
      }
      if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
      if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; } if (c === '\n') out += c; i++; continue; }
      out += c;
      if (c === '\\') { if (i + 1 < text.length) { out += text[i + 1]; i += 2; continue; } i++; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
      i++;
    }
    return out;
  }

  it('C1 `src/item-index.js` 只许**调**那一份打分/定序，不许再写第二份字面匹配', () => {
    const src = read('src/item-index.js');
    const code = stripComments(src);                 // 注释里的旧写法不当判据（见上）
    expect(src, '必须真的走共享谓词').toContain('paletteRank.fuzzyMatch(');
    expect(src, '必须真的走共享定序').toContain('paletteRank.rankRows(');
    // 关键词面的"第二份匹配"：这两种写法（旧实现）一旦**回到代码里**就红
    expect(code, '不许再对 topic 自己 indexOf 判命中').not.toContain('n.topic.indexOf');
    expect(code, '不许再对条目正文自己 indexOf 判命中').not.toContain('rec.text.indexOf');
    // `srcMatches`（`--src` 那一维）是**另一条**边界，它的 indexOf 是合法的 —— 别把它误当命中判定
    expect(code).toContain('function srcMatches(');
  });

  it('C2 全仓（src / cli / renderer）只有 `src/palette-rank.js` 定义 fuzzyMatch 与 rankRows', () => {
    const scan = ['src', 'cli', 'renderer'];
    const hitsOf = (needle) => {
      const out = [];
      scan.forEach((dir) => {
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
          const abs = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'vendor') walk(abs); return; }
          if (!/\.(js|mjs)$/.test(e.name)) return;
          if (fs.readFileSync(abs, 'utf8').indexOf(needle) >= 0) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        });
        walk(path.join(ROOT, dir));
      });
      return out.sort();
    };
    expect(hitsOf('function fuzzyMatch('), '打分的定义处只能是它').toEqual(['src/palette-rank.js']);
    expect(hitsOf('function rankRows('), '定序的定义处也只能是它').toEqual(['src/palette-rank.js']);
  });

  it('C3 界面那一侧仍然吃的是同一份（没有为了这事在渲染层另起一套）', () => {
    expect(read('renderer/app-palette.js')).toContain('MMPaletteRank.rankPalette');
    expect(read('renderer/app-related.js')).toContain('MMPaletteRank.rankPalette');
    // 面板只多两件自己的事：同分命令优先 + limit 截断（都在 rankPalette 里，不在 rankRows 里）
    const pr = read('src/palette-rank.js');
    expect(pr).toContain('function rankPalette(');
    expect(pr.indexOf('kindRank(a) - kindRank(b)'), 'tieBreak 只在 rankPalette 的调用点').toBeGreaterThan(-1);
  });
});

/* ============================================================================
 * D. 判别力：注入 ⇒ 必红 ⇒ 还原 ⇒ 复绿（可重复执行；文件级注入的实测报文见交付说明）
 * ========================================================================== */
describe('D. 注入证明（改坏那一处实现 ⇒ 对应判据必红；还原 ⇒ 复绿）', () => {
  it('D1 把 `rankRows` 改成"原样返回不排序" ⇒ 判据②必红；还原 ⇒ 复绿', () => {
    const ui = uiNodeOrder(ORDER, '闸门');
    const real = paletteRank.rankRows;
    let broken = null;
    try {
      paletteRank.rankRows = (rows) => (Array.isArray(rows) ? rows.slice() : []);
      broken = topicHitIds(searchJson(ORDER, '闸门', ['--no-heat']));
    } finally {
      paletteRank.rankRows = real;                     // ⚠️ 还原（哪怕上面抛了）
    }
    expect(broken, '注入后顺序回到 DFS ⇒ 与面板顺序**不再相同**（这就是判据②的判别力）').not.toEqual(ui);
    expect(broken).toEqual(ORDER_TOPICS.map(([id]) => id));            // 注入的形态确实是"没排序"
    expect(topicHitIds(searchJson(ORDER, '闸门', ['--no-heat']))).toEqual(ui);   // 复绿
  });

  it('D2 把 `fuzzyMatch` 退化回"只认子串" ⇒ 判据①必红；还原 ⇒ 复绿', () => {
    const real = paletteRank.fuzzyMatch;
    let broken = null;
    try {
      paletteRank.fuzzyMatch = (needle, hay) => {
        const n = String(needle === undefined || needle === null ? '' : needle);
        const h = String(hay === undefined || hay === null ? '' : hay);
        if (!n) return { score: 0, start: -1 };
        const i = h.toLowerCase().indexOf(n.toLowerCase());
        return i < 0 ? null : { score: i, start: i };
      };
      broken = hitIds(searchJson(SUB, 'TC连', ['--no-heat']));
    } finally {
      paletteRank.fuzzyMatch = real;
    }
    expect(broken, '退化后 `TC连` 一条都命中不了（它本来就不是子串）').toEqual([]);
    expect(hitIds(searchJson(SUB, 'TC连', ['--no-heat']))).toEqual(['nd-1']);   // 复绿
  });
});

/* ============================================================================
 * E. 端到端不变量：只读检索零字节；MCP 同源且没新增工具
 * ========================================================================== */
describe('E. 端到端不变量', () => {
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

  it('E1 检索（含模糊命中）在**项目目录里零字节**；沙箱自证；收尾后没有残留', () => {
    expect(path.resolve(core.PROJECTS_DIR), '沙箱自证：项目根就是临时目录').toBe(path.resolve(SANDBOX));
    expect(path.resolve(SANDBOX).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    const before = snapshot(projDir(SUB));
    searchJson(SUB, 'TC连', ['--no-heat']);
    run(['search-all', 'TC连', '--scope', SUB, '--no-heat', '--json']);
    expect(snapshot(projDir(SUB)), '读命令零字节（埋点写在项目目录**之外**的 .visits/）').toEqual(before);
    // 前缀表一处：清理后逐个点名确认**没有残留**（只清本用例用过的那个；ORDER 留给后面的用例）
    try {
      cleanup([SUB]);
      expect(fs.existsSync(projDir(SUB))).toBe(false);
      expect(fs.existsSync(projFile(SUB))).toBe(false);
    } finally {
      cleanup([SUB]);                             // 幂等：清不掉也不影响判定（afterAll 还会再来一次）
    }
  });

  it('E2 MCP `search_nodes` 一层透传：模糊命中也同源同序，且**没有新增工具**', () => {
    const srv = path.join(ROOT, 'scripts', 'mcp-server.js');
    const reqs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_nodes',
        arguments: { project: ORDER, keyword: '闸门', no_heat: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' }
    ];
    const sp = spawnSync(process.execPath, [srv], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      input: reqs.map((x) => JSON.stringify(x)).join('\n') + '\n'
    });
    const replies = String(sp.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
    const call = replies.filter((x) => x && x.id === 2)[0] || null;
    const list = replies.filter((x) => x && x.id === 3)[0] || null;
    const viaMcp = JSON.parse(call.result.content[0].text);
    const viaCli = searchJson(ORDER, '闸门', ['--no-heat']);
    expect(viaMcp.hits.map((h) => h.nodeId), 'MCP 与 CLI 逐条同序（MCP 侧没有第二份打分）')
      .toEqual(viaCli.hits.map((h) => h.nodeId));
    expect(hitIds(viaMcp).length, '模糊命中经 MCP 也到得了').toBe(ORDER_TOPICS.length);
    const tools = (list && list.result && list.result.tools) || [];
    expect(tools.filter((t) => t.name === 'search_nodes'), '同名工具只有一个，没被复制成第二个').toHaveLength(1);
    // 工具数 = **真值出口**（`docs/VERIFY.md` 生成物里那一行）现取 —— 不在测试里写死任何计数
    const verify = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
    const m = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verify);
    expect(m, 'docs/VERIFY.md 里必须有「MCP 工具数」那一行（否则这条判据测不了任何东西）').toBeTruthy();
    expect(tools.length, '工具数必须等于真值出口报的那个数（本件不新增工具）').toBe(Number(m[1]));
    // 参数面也没动：这条判据的"新参数"提示词不该出现在 search_nodes 的 schema 里
    const props = Object.keys(tools.filter((t) => t.name === 'search_nodes')[0].inputSchema.properties);
    expect(props.filter((k) => /fuzzy|subsequence|rank/i.test(k)), '没有为它新增参数').toEqual([]);
  });
});

/* ============================================================================
 * F. 交付物闸门：集成断言原文可解析、无待填字样、无判定标记冲突（拼贴前唯一能机器验的三件事）
 * ========================================================================== */
describe('F. 交付物闸门：`.review/…/W6-集成断言原文.js` 可拼贴', () => {
  /* 为什么需要这一组：本件不跑集成（放行窗口串行跑），那段断言是**交给整合流粘贴**的 ⇒
   * 粘贴前唯一能机器验的就是"它能不能被解析、有没有留待填字样、有没有踩 G9 的判定标记坑"。
   * 原文是工作产物（`.review/` 可随时删）⇒ 文件不在了这一组就跳过，不会变成常驻空转。 */
  const SRC = path.join(ROOT, '.review', '20261010-卖点与功能-常驻讨论', 'W6-集成断言原文.js');
  const has = fs.existsSync(SRC);
  const text = has ? fs.readFileSync(SRC, 'utf8') : '';

  it.skipIf(!has)('语法可解析（粘贴进 scripts/cli-integration.js 不会红在语法上）', () => {
    expect(() => new Function('fs', 'path', 'ROOT', 'run', 'check', 'spawnSync', 'require', text)).not.toThrow();
  });

  it.skipIf(!has)('待填字样 0 命中（上一批就栽在占位符上），且不含 G9 判定标记形态', () => {
    expect(text.match(/PLACEHOLDER|TODO|FIXME|XXX/g), '交付文本里不许有待填字样').toBeNull();
    expect(text.match(/\/\/\s*[①-⑳]/g), '`// ` 紧跟圈号会被 G9 当判定标记计数').toBeNull();
  });

  it.skipIf(!has)('探针前缀只作为一个字面量定义一次（前缀表一处：建/清/断言残留都认它）', () => {
    expect((text.match(/'it-probe-w6-/g) || []).length).toBe(1);
  });
});
