/* ============================================================
 * tests/search-all.test.js — 【W1】`search-all` 跨项目检索
 * 运行：npx vitest run tests/search-all.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 `## W1｜search-all 跨项目检索 ⭐` 一节。
 * 本文件当前 **26 用例**（以实跑为准：`npx vitest run tests/search-all.test.js` ⇒ 26 passed；
 * 这份文件是那个数字的**唯一出处** —— 别处别再复述，改判据时同批改本行）。
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 * 它是那句话的**技术前提**（从前 `search` 必须点名单个项目，"整库当一库用"就无从谈起）。
 *
 * ## 这个文件守什么（每条对着 W1 那节的一条判据）
 *   ① **两个项目各放一个关键词 ⇒ 一次调用同时命中两侧**，每条结果带项目名；
 *      并且**项目内的分片与 `search <该项目>` 逐条同序**（顺序 = 项目名升序 × 项目内既有顺序，
 *      **不做跨项目重排** —— 排序的唯一实现是 `src/item-index.js` 的 `orderByHeat`）；
 *   ② **无命中 ⇒ 明确的"零结果"**（不是空输出；空库也一样要说话）；
 *   ③ **越限要响亮报错**：命中总数上限 / 扫描耗时上限各一条端到端 + 判定本身（`scanGate`）的边界；
 *      ⚠ 它与 `--limit` 的"截断"是**两件事**（后者是调用方预算：截断可见 + 给续取方式，不是错误）；
 *   ④ `--scope` 能把范围收回来（点名不存在的项目 / 裸写 ⇒ 响亮报错，不静默当"全库"）；
 *   ⑤ **MCP 同名工具一层透传**（不给 `project` ⇒ 全库档），且**不新增工具**（仍是 51 个）；
 *   ⑥ **既有不变量**：读命令在**项目目录里零字节**（埋点写的是项目目录**之外**的 `.visits/`），
 *      且命中**按项目**分别记进各自的榜（不是"全记到某一个项目头上"）；
 *   ⑦ 不许静默少扫：某个项目读不出来 / 它的热度日志坏了 ⇒ 整体失败并**点名那个项目**（给出路）。
 *
 * ## 环境要点（与 tests/search-heat.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 夹具的日志由本文件自己写 ⇒ 默认**关掉自动埋点**（`heatSensor.__setEnabledForTest(false)`），
 *      只有"埋点按项目分账"那一条把它打开（跑完立刻关回去）；
 *   3) 端到端一律**进程内** `invokeSync`（不起子进程）。唯一例外是判据⑤那条 MCP 断言 ——
 *      MCP 本身就是"转发到 CLI 子进程"，那正是要证明的透传路径；
 *   4) `projects/` 真实目录**只读**：夹具与断言都在 `SANDBOX`（临时目录）里。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ----
 * 建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记），收尾只此一处（见下面的 `afterAll`）。 */
const SANDBOX = makeTmp('mm-search-all-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const itemIndex = require('../src/item-index.js');
const heatSensor = require('../src/heat-sensor.js');
const store = require('../src/data-store.js').createStore(SANDBOX);
const projectMod = require('../cli/commands/project.js');
const mcp = require('../scripts/mcp-server.js');

heatSensor.__setEnabledForTest(false);

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const PROD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 收尾只此一处：删掉**所有**登记过的临时根（含将来新加的）——形态见 `tests/_tmp-cleanup.js`。
 * 旧实现只删 `SANDBOX` 一个变量、且把失败吞掉 ⇒ "建了却没被引用"的目录会静默留下。 */
afterAll(cleanupAll);

/* ---------------- 夹具 ---------------- */

const run = (argv) => invokeSync(argv);
const projDir = (name) => path.join(SANDBOX, name);
const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const logFile = (name) => store.visitLogFile(name);

/** 建一个项目：root 下按给定顺序挂节点（命中顺序 = DFS 序 ⇒ 顺序类断言才有确定的方向） */
function mkProject(name, nodes) {
  fs.mkdirSync(projDir(name), { recursive: true });
  fs.writeFileSync(projFile(name), JSON.stringify({
    meta: { name: name, author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'root', expanded: true, children: nodes.map((n) => ({
      id: n.id, topic: n.topic, children: [] })) }
  }, null, 2), 'utf8');
  return name;
}

/** 含关键词的 n 个节点（标题里带 KW ⇒ 命中 matchIn=topic，一条节点一个命中） */
const kwNodes = (kw, n) => Array.from({ length: n }, (x, i) => ({ id: 'nd-' + (i + 1), topic: kw + ' 第 ' + (i + 1) + ' 个' }));

const jrun = (argv, msg) => {
  const r = run(argv);
  expect(r.code, (msg || argv.join(' ')) + ' 失败：' + r.stdout).toBe(0);
  return JSON.parse(r.stdout);
};
const searchAll = (kw, extra) => jrun(['search-all', kw, '--json'].concat(extra || []));
const searchOne = (p, kw, extra) => jrun(['search', p, kw, '--json'].concat(extra || []));

/** 命中 → 稳定键（项目 + 节点） */
const keysOf = (j) => j.hits.map((h) => h.project + '/' + h.nodeId + (h.itemId ? '#' + h.itemId : ''));

/** 目录树快照（含每个文件的 sha256 + mtime）：用来钉"项目目录里零字节" */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); return; }
      const buf = fs.readFileSync(abs);
      out.push(path.relative(dir, abs).split(path.sep).join('/')
        + '|' + buf.length + '|' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
        + '|' + fs.statSync(abs).mtimeMs);
    });
  };
  walk(dir);
  return out;
}

/* ============================================================================
 * ⓪ 库是空的（**必须排在第一个**：本文件后面的用例都会往沙箱里建项目）
 * ========================================================================== */
describe('⓪ 空库：`search-all` 也要说话（不是空输出）', () => {
  it('0 库里一个项目都没有 ⇒ exit 0 + **明确零结果**（且点名"库是空的"），JSON 里 scanned=[]', () => {
    // 前置条件断言：这条用例的前提就是"还没有人建过项目"—— 有人把夹具挪到它前面 ⇒ 这条必红
    // （比"静默地测了别的东西"好：前提不成立必须是红的）
    expect(store.list().length, '本文件第一条用例要求沙箱是空的').toBe(0);
    const r = run(['search-all', '什么都搜不到']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);          // ← "空输出"必红
    expect(r.stdout).toContain('命中 0 条');
    expect(r.stdout).toContain('一个项目都没有');
    const j = searchAll('什么都搜不到');
    expect(j.hits).toEqual([]);
    expect(j.hitCount).toBe(0);
    expect(j.scanned).toEqual([]);
    expect(j.skipped).toEqual([]);
  });
});

/* ============================================================================
 * ① 两个项目各放一个关键词 ⇒ 一次调用同时命中两侧，每条带项目名
 * ========================================================================== */
describe('① 一次调用同时命中两侧 + 每条带项目名 + 分片与单项目同序', () => {
  const KW = 'w1跨项目词';
  const A = 't1-alpha';
  const B = 't1-beta';

  it('1.1 两个项目各有命中 ⇒ 两条都在、每条带 project；分片与 `search <该项目>` 逐条同序', () => {
    mkProject(A, kwNodes(KW, 3).concat([{ id: 'na-x', topic: '无关 甲' }]));
    mkProject(B, kwNodes(KW, 2).concat([{ id: 'nb-x', topic: '无关 乙' }]));

    const all = searchAll(KW);
    // 命中集合：两侧都在（各 3 / 2 条，逐条带 project）
    expect(all.hits.filter((h) => h.project === A)).toHaveLength(3);
    expect(all.hits.filter((h) => h.project === B)).toHaveLength(2);
    expect(all.hits.every((h) => typeof h.project === 'string' && h.project)).toBe(true);
    expect(all.hitCount).toBe(5);
    expect(all.scanned).toEqual([A, B]);                        // 扫描序 = 项目名升序（确定序）
    expect(all.scope).toEqual([A, B]);

    /* **顺序**：合并结果必须**逐条等于**"按项目名升序，把每个项目自己的 search 拼起来" ——
     * 这一条同时钉死三件事：① 项目内顺序与单项目 search 一致；② 没有跨项目重排（第二份排序实现必红）；
     * ③ 命中对象除多一个 `project` 外与 search 逐字段相同（含 id/topic/matchIn/snippet/score）。 */
    const expectHits = [A, B].reduce((acc, p) => acc.concat(
      searchOne(p, KW).hits.map((h) => Object.assign({ project: p }, h))), []);
    expect(JSON.stringify(all.hits)).toBe(JSON.stringify(expectHits));
    expect(keysOf(all)).toEqual([
      A + '/nd-1', A + '/nd-2', A + '/nd-3', B + '/nd-1', B + '/nd-2'
    ]);
  });

  it('1.2 文本档：每条命中写成 `项目/节点`，汇总行说清"扫了几个项目"与顺序口径', () => {
    const r = run(['search-all', KW]);
    expect(r.code, r.stdout).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain(A + '/nd-1');                    // ← 项目前缀（否则人看不出命中在哪）
    expect(lines[1]).toContain(A + '/nd-2');
    expect(lines[3]).toContain(B + '/nd-1');
    const summary = lines.filter((l) => l.indexOf('命中 ') === 0)[0] || '';
    expect(summary).toContain('命中 5 条');
    expect(summary).toContain('顺序 = 项目名升序 × 项目内既有顺序');
  });

  it('1.3 条目层同样成立：两个项目的**条目**命中都带回，且带条目 id', () => {
    const C = 't1-gamma';
    const D = 't1-delta';
    mkProject(C, [{ id: 'nc-1', topic: '容器丙' }]);
    mkProject(D, [{ id: 'nd-1', topic: '容器丁' }]);
    const kw = 'w1条目词';
    // 条目 id 由命令签发（`i-…`）⇒ 从回显里取真值，别在这里猜一个
    const itemIdOf = (out) => (/(i-[a-z0-9-]+)/.exec(out) || [])[1];
    const ids = [C, D].map((p, i) => {
      const r = run(['item-add', p, i === 0 ? 'nc-1' : 'nd-1', '--md', kw + ' 正文' + i]);
      expect(r.code, r.stdout).toBe(0);
      const id = itemIdOf(r.stdout);
      expect(id, 'item-add 回显必须点名条目 id：' + r.stdout).toBeTruthy();
      return id;
    });
    const all = searchAll(kw);
    // 顺序 = 项目名升序（`t1-delta` < `t1-gamma`），与 1.1 同一条口径
    expect(all.hits.map((h) => h.project + '/' + h.nodeId + '#' + h.itemId))
      .toEqual([D + '/nd-1#' + ids[1], C + '/nc-1#' + ids[0]]);
    expect(all.hits.every((h) => h.itemized === true && h.matchIn === 'item')).toBe(true);
  });
});

/* ============================================================================
 * ② 无命中 ⇒ 明确的"零结果"
 * ========================================================================== */
describe('② 零结果是**说出来的**（不是空输出）', () => {
  it('2.1 库里非空但关键词谁都不命中 ⇒ exit 0 + 一行明确的"命中 0 条 / 零结果"', () => {
    mkProject('t2-有项目', [{ id: 'n-1', topic: '别的词' }]);
    const r = run(['search-all', '这个词不存在于任何项目']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('命中 0 条');
    expect(r.stdout).toContain('明确的零结果');
    expect(r.stdout).toContain('都没有命中');                    // 说清了"扫过谁、没命中"
    const j = searchAll('这个词不存在于任何项目');
    expect(j.hits).toEqual([]);
    expect(j.hitCount).toBe(0);
    expect(j.scanned.length).toBeGreaterThan(0);               // 扫过了（不是"没跑"）
  });
});

/* ============================================================================
 * ③ 越限 ⇒ 响亮报错（不许静默截断）—— 端到端两条 + 判定本身
 * ========================================================================== */
describe('③ 两条硬上限：越限 ⇒ 报错 + 一条命中都不返回', () => {
  const CAPKW = 'w1上限词';
  const BIG = 'zz-cap-hits';
  /** 只此一处的窄词（给"出路"那条断言用；**不含** CAPKW ⇒ 3.1 的真总数期望值不受它影响） */
  const ESC_TOPIC = 'zz-cap-独一份的词';

  it('3.1 命中总数越限：真造 ' + itemIndex.SCAN_MAX_HITS + '+1 条命中 ⇒ exit 1、**报文里的两个数字逐字等于真值**、不给半份', () => {
    // 上限口径的**唯一实现处**是 src/item-index.js（本测试从它现取数字，不写死一份）
    expect(itemIndex.SCAN_MAX_HITS).toBeGreaterThan(0);
    /* ⚠️ 期望值**现算，不写死**（放行窗口实测的假红：写死 `上限+1` 而全库真总数还含别的项目）：
     * 全库档扫的是**整库** ⇒ 先量出"库里其它项目对这个关键词的命中数"，再加本探针那 `上限+1` 条。 */
    const otherHits = searchAll(CAPKW).hitCount;                  // ← BIG 还没建，量到的就是"别的项目"那部分
    const expectedTotal = itemIndex.SCAN_MAX_HITS + 1 + otherHits;
    mkProject(BIG, kwNodes(CAPKW, itemIndex.SCAN_MAX_HITS + 1)
      .concat([{ id: 'nd-only', topic: ESC_TOPIC }]));
    try {
      const r = run(['search-all', CAPKW, '--json']);
      expect(r.code, '越限必须非 0：' + r.stdout.slice(0, 200)).toBe(1);
      expect(r.stdout.startsWith('error: ')).toBe(true);        // CLI 失败契约（与退出码两重判据）
      expect(r.stdout.trim().split('\n')).toHaveLength(1);      // 就一行报错：**没有任何命中行**
      expect(r.stdout).toContain('一条都不返回');                 // ← "静默截断"必红
      expect(r.stdout).toContain('--scope');                     // 出路随报错一起回去
      // 强口径：报文报出的两个数字 == **本次扫描的真实总数 / 真实上限**（不是"含某个数字"）
      const m = /命中 (\d+) 条 > 上限 (\d+) 条/.exec(r.stdout);
      expect(m, '报文里必须报出"命中 N 条 > 上限 M 条"：' + r.stdout.slice(0, 160)).toBeTruthy();
      expect(Number(m[1]), '报出的命中数必须等于本次真总数（含别的项目的命中）').toBe(expectedTotal);
      expect(Number(m[2]), '报出的上限必须等于唯一实现处给的值').toBe(itemIndex.SCAN_MAX_HITS);
      /* 报错里给的出路**真的管用**（更长关键词 ⇒ 命中面收窄 ⇒ 照常返回）。
       * ⚠️ 【W6】这条路换了写法，理由记在这里：改前用 `CAPKW + ' 第 1 个'` 指望"更长 ⇒ 更窄"，
       * 而 W6 起命中口径 = **非连续子序列** ⇒ `第 1 个` 是 `第 10 个` 的子序列、2001 个节点**全都命中**
       * （那条写法在新口径下已经**不是**出路了）。改成一个**只此一处**的词（`ESC_TOPIC`，不含 CAPKW
       * ⇒ 也顺带证明"3.1 的真总数期望值没被这条夹具改动"），期望值仍是写死的那个节点 id。 */
      const escaped = searchAll(ESC_TOPIC, ['--scope', BIG]);
      expect(escaped.hits.map((h) => h.nodeId), '出路的判据：换一个更窄的词 ⇒ 照常返回，不再越限').toEqual(['nd-only']);
    } finally {
      fs.rmSync(projDir(BIG), { recursive: true, force: true });   // 不留"必然越限"的项目给后面的用例
    }
    expect(store.list().map((p) => p.name)).not.toContain(BIG);
    // 同一查询在项目删掉之后复绿 ⇒ 红的原因确实是那条上限，不是命令坏了
    expect(run(['search-all', CAPKW]).code).toBe(0);
  });

  it('3.2 扫描耗时越限：把时钟推快（确定性）⇒ exit 1、点名 ms 读数与出路', () => {
    mkProject('t3-time', kwNodes('w1耗时词', 2));
    const realNow = Date.now;
    const T0 = realNow();
    let calls = 0;
    // 第一次调用 = 扫描起点；之后每次（判定处）都跳到"上限 + 1 ms"⇒ 耗时读数确定、不靠真的跑慢
    Date.now = () => { calls++; return calls === 1 ? T0 : T0 + itemIndex.SCAN_MAX_MS + 1; };
    let r = null;
    try {
      r = run(['search-all', 'w1耗时词', '--no-heat', '--json']);
    } finally {
      Date.now = realNow;
    }
    expect(calls, '扫描闸门必须读一次时钟（否则耗时上限判不了）').toBeGreaterThan(1);
    expect(r.code, r.stdout.slice(0, 200)).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
    expect(r.stdout).toContain(String(itemIndex.SCAN_MAX_MS));
    expect(r.stdout).toContain('ms > 上限');
    expect(r.stdout).toContain('一条都不返回');
    // 时钟恢复 ⇒ 同一查询复绿（证明红的不是命令本身）
    const ok = searchAll('w1耗时词', ['--no-heat']);
    expect(ok.hits).toHaveLength(2);
  });

  it('3.3 判定本身（`scanGate`，纯函数）：等号放行、越界拦下、报文三件套齐全', () => {
    const H = itemIndex.SCAN_MAX_HITS;
    const M = itemIndex.SCAN_MAX_MS;
    // 边界：**等于上限放行**、**大于上限才拦**（改成 >= ⇒ 这里必红）
    expect(itemIndex.scanGate({ hits: H, projects: 3, elapsedMs: M }).ok).toBe(true);
    expect(itemIndex.scanGate({ hits: H + 1, projects: 3, elapsedMs: M }).ok).toBe(false);
    expect(itemIndex.scanGate({ hits: H, projects: 3, elapsedMs: M + 1 }).ok).toBe(false);
    expect(itemIndex.scanGate({}).ok).toBe(true);               // 空读数 = 还没扫（不当成越限）
    // 两条上限**各自独立**：code 不同（调用方据此分辨"改关键词"还是"改范围"）
    const overHits = itemIndex.scanGate({ hits: H + 1, projects: 2, elapsedMs: 0, project: 'p2' });
    const overMs = itemIndex.scanGate({ hits: 0, projects: 2, elapsedMs: M + 1, project: 'p2' });
    expect(overHits.code).toBe('scan-hits');
    expect(overMs.code).toBe('scan-time');
    // 报文三件套：读数（命中/项目/毫秒）+ 上限值 + 出路
    [overHits, overMs].forEach((x) => {
      expect(x.message).toContain('上限');
      expect(x.message).toContain('p2');
      expect(x.message).toContain('--scope');
      expect(x.message).toContain('--tag');
      expect(x.hits).toBeGreaterThan(-1);
      expect(x.projects).toBe(2);
      expect(typeof x.elapsedMs).toBe('number');
    });
  });

  it('3.4 `--limit` 的截断**不是**错误：如实 truncated + 给续取方式（与上限是两件事）', () => {
    const j = searchAll('w1跨项目词', ['--limit', '1']);
    expect(j.hits).toHaveLength(1);
    expect(j.hitCount).toBe(5);                                  // 全量命中数照旧如实给
    expect(j.truncated).toBe(true);
    expect(typeof j.budget.resume).toBe('string');
    expect(j.budget.resume).toContain('续取方式');
  });
});

/* ============================================================================
 * ④ `--scope` 收窄 + 它的三种"不许静默"
 * ========================================================================== */
describe('④ `--scope`：范围收得回来，写错了要响亮', () => {
  const KW = 'w1范围词';
  const A = 't4-alpha';
  const B = 't4-beta';

  it('4.1 `--scope B` ⇒ 只扫 B（scanned / scope / 命中都只有它）', () => {
    mkProject(A, kwNodes(KW, 1));
    mkProject(B, kwNodes(KW, 2));
    const j = searchAll(KW, ['--scope', B]);
    expect(j.scoped).toBe(true);
    expect(j.scanned).toEqual([B]);
    expect(j.scope).toEqual([B]);
    expect(j.hits.every((h) => h.project === B)).toBe(true);
    expect(j.hitCount).toBe(2);
    // 对照：不加 --scope 时两侧都在（否则"收窄"这句话是空话）
    expect(searchAll(KW).hits.filter((h) => h.project === A)).toHaveLength(1);
  });

  it('4.2 点名的项目不存在 ⇒ exit 1、**逐个点名** + 列出库里现有什么', () => {
    const r = run(['search-all', KW, '--scope', 't4-不存在的项目']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('t4-不存在的项目');
    expect(r.stdout).toContain(A);                               // 列出库里有哪些（"我怎么写才对"）
    expect(r.stdout).toContain('名字要写目录名');
  });

  it('4.3 裸写 `--scope`（没给名单）⇒ exit 1，**不静默当"全库"**', () => {
    const r = run(['search-all', KW, '--scope']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('需要一个项目名列表');
  });

  it('4.4 `__scopeList`（纯函数）：trim / 去重 / 空串 / 升序 / 未知名字逐个点名', () => {
    const all = ['b', 'a', 'c'];
    expect(projectMod.__scopeList(undefined, all)).toEqual({ ok: true, names: ['a', 'b', 'c'], scoped: false });
    expect(projectMod.__scopeList(' c , a ,, c ', all))
      .toEqual({ ok: true, names: ['a', 'c'], scoped: true });    // 去空白、去空串、去重、升序
    expect(projectMod.__scopeList(true, all).ok).toBe(false);
    expect(projectMod.__scopeList(' , ', all).ok).toBe(false);
    const miss = projectMod.__scopeList('a,zz', all);
    expect(miss.ok).toBe(false);
    expect(miss.message).toContain('zz');
    expect(miss.message).toContain('a / b / c');
  });
});

/* ============================================================================
 * ⑤ MCP 同名工具一层透传（不新增工具）
 * ========================================================================== */
describe('⑤ MCP `search_nodes`：不给 project ⇒ 全库档（一层透传，工具数不变）', () => {
  const KW = 'w1多通道词';
  const A = 't5-alpha';
  const B = 't5-beta';

  it('5.1 MCP 不给 `project` ⇒ 真调用（子进程转发同一个 CLI）拿到**两侧**命中，每条带 project', () => {
    mkProject(A, kwNodes(KW, 2));
    mkProject(B, kwNodes(KW, 1));
    const r = mcp.callTool('search_nodes', { keyword: KW, no_heat: true });
    expect(r.ok, String(r.text)).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(j.hits.filter((h) => h.project === A)).toHaveLength(2);
    expect(j.hits.filter((h) => h.project === B)).toHaveLength(1);
    // 全库档 ⇒ 扫的是**库里全部**项目（本文件的沙箱里还有前面用例建的项目）
    expect(j.scanned).toContain(A);
    expect(j.scanned).toContain(B);
    expect(j.scanned.length).toBeGreaterThanOrEqual(2);
    // 与 CLI 逐字同源（同一个命令、同一份实现）
    expect(JSON.stringify(j.hits)).toBe(JSON.stringify(searchAll(KW, ['--no-heat']).hits));
  });

  it('5.2 MCP 的 `scope`（数组）⇒ 只扫点名的那几个（数组 → CLI 的逗号列表）', () => {
    const r = mcp.callTool('search_nodes', { keyword: KW, scope: [B], no_heat: true });
    expect(r.ok, String(r.text)).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(j.scanned).toEqual([B]);
    expect(j.hits.every((h) => h.project === B)).toBe(true);
  });

  it('5.3 给了 `project` ⇒ 行为与从前**逐字相同**（单项目形状：顶层 project 键、hitCount 一致）', () => {
    const r = mcp.callTool('search_nodes', { project: A, keyword: KW, no_heat: true });
    expect(r.ok, String(r.text)).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(j.project).toBe(A);
    expect(j.hits.map((h) => h.nodeId)).toEqual(searchOne(A, KW, ['--no-heat']).hits.map((h) => h.nodeId));
    expect(j.hits.some((h) => h.project !== undefined)).toBe(false);   // 单项目档不加那个字段
  });

  it('5.4 工具数是**真的没变**：本件不新增工具（真值 = 52，W21 的 `ask_apply` 之后）、名字唯一、没有第二个"全库"工具', () => {
    expect(mcp.TOOLS).toHaveLength(52);
    const names = mcp.TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(52);
    expect(names.filter((n) => n === 'search_nodes')).toHaveLength(1);
    // 全库档是**既有工具的一个模式**：schema 里给的是参数，不是新工具
    const tool = mcp.TOOLS.filter((t) => t.name === 'search_nodes')[0];
    expect(tool.inputSchema.properties.scope).toBeTruthy();
    expect(String(tool.inputSchema.properties.scope.description)).toContain('--scope');
    expect(String(tool.inputSchema.properties.project.description)).toContain('search-all');
    // ⚠️ 侧栏/外部 AI 的既有调用（给 project）仍必须能过必填校验那条路 —— 见 5.3
    expect(tool.inputSchema.required).toEqual([]);
  });

  it('5.5 MCP 侧不复制任何上限/权重数值：两串上限名与三串热度值都不在 mcp-server.js 里', () => {
    const src = fs.readFileSync(path.join(PROD_DIR, 'scripts', 'mcp-server.js'), 'utf8');
    ['SCAN_MAX_HITS', 'SCAN_MAX_MS', 'scanGate'].forEach((needle) => {
      expect(src.indexOf(needle), 'MCP 里出现了 ' + needle).toBe(-1);
    });
    // 全库档那条路真的转发到 `search-all`（结构断言与行为断言各一份）
    expect(src).toContain("const c = ['search-all']");
    expect(src).toContain("runCli(c.concat(flags, ['--json']))");
  });
});

/* ============================================================================
 * ⑥ 不变量：项目目录里零字节 + 埋点按项目分账
 * ========================================================================== */
describe('⑥ 读命令的既有不变量：项目目录零字节；埋点记在**项目目录之外**、且**按项目分**', () => {
  const KW = 'w1埋点词';
  const A = 't6-alpha';
  const B = 't6-beta';

  it('6.1 跑一次 `search-all`：项目目录逐字节不变，而 `.visits/` 里**两个项目各自**记到了自己的命中', () => {
    mkProject(A, kwNodes(KW, 2));
    mkProject(B, kwNodes(KW, 1));
    const before = snapshot(projDir(A)).concat(snapshot(projDir(B)));
    const logA0 = fs.existsSync(logFile(A)) ? fs.statSync(logFile(A)).size : 0;
    const logB0 = fs.existsSync(logFile(B)) ? fs.statSync(logFile(B)).size : 0;

    heatSensor.__setEnabledForTest(true);                       // 这一条专门验埋点（跑完立刻关回去）
    let j = null;
    try {
      j = searchAll(KW);                                        // 走 JSON 档（形状断言顺手一起要）
    } finally {
      heatSensor.__setEnabledForTest(false);
    }

    // ① 项目目录**零字节**（含 mtime：连"悄悄摸一下"都不许）
    expect(snapshot(projDir(A)).concat(snapshot(projDir(B)))).toEqual(before);
    // ② 日志在**项目目录之外**长出来了（证明这一跑真的记了，上面那条不是"因为没跑"而恒真）
    expect(fs.statSync(logFile(A)).size).toBeGreaterThan(logA0);
    expect(fs.statSync(logFile(B)).size).toBeGreaterThan(logB0);
    // ③ **按项目分账**：A 的榜里是 A 的命中，B 的榜里是 B 的命中（记混 ⇒ 必红）
    const nodesIn = (name) => fs.readFileSync(logFile(name), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((e) => e.ch === 'ai-search-hit').map((e) => e.node);
    expect(nodesIn(A).sort()).toEqual(['nd-1', 'nd-2']);
    expect(nodesIn(B).sort()).toEqual(['nd-1']);
    expect(j.hits.length).toBe(3);
    // ④ `heat` 读数也是**逐项目**的（不是把三个命中算到一个项目头上）
    const per = j.heat.perProject;
    expect(per.map((x) => x.project)).toEqual(j.scanned);        // 每个扫过的项目各一条读数
    // 本轮读榜单在**埋点之前**（"这次记的命中不许抬升这次排序"）⇒ 本轮读数里它们是 0 热度
    expect(per.filter((x) => x.project === A)[0].hitNodes).toBe(0);
    expect(per.filter((x) => x.project === B)[0].hitNodes).toBe(0);
    expect(j.heat.hitNodes).toBe(0);
    // 而那次记录**真的生效**：紧接着再跑一次，两个项目的榜上都有节点了（热度向量跨项目可用）
    const again = searchAll(KW);
    expect(again.heat.perProject.filter((x) => x.project === A)[0].rankedNodes).toBe(2);
    expect(again.heat.perProject.filter((x) => x.project === B)[0].rankedNodes).toBe(1);
    expect(again.heat.applied).toBe(true);
  });

  it('6.2 `--no-heat` ⇒ **不读不写**（日志一个字节都不动），排序回到零热度档', () => {
    mkProject('t6-gamma', kwNodes('w1静默词', 3));
    const f = logFile('t6-gamma');
    const before = fs.existsSync(f) ? fs.readFileSync(f) : null;
    heatSensor.__setEnabledForTest(true);
    let j = null;
    try {
      j = searchAll('w1静默词', ['--no-heat']);
    } finally {
      heatSensor.__setEnabledForTest(false);
    }
    expect(fs.existsSync(f) ? fs.readFileSync(f) : null).toEqual(before);   // ← 写了就必红
    expect(j.hits.map((h) => h.nodeId)).toEqual(['nd-1', 'nd-2', 'nd-3']);  // 零热度档 = 既有顺序
    expect(j.heat.reason).toBe('被 --no-heat 显式关闭');
    expect(j.heat.perProject.every((x) => x.reason === '被 --no-heat 显式关闭' && x.log === null)).toBe(true);
  });
});

/* ============================================================================
 * ⑦ 不许静默少扫：坏项目 / 坏日志 ⇒ 点名那个项目
 * ========================================================================== */
describe('⑦ coverage 是实话：少扫一个项目必须响亮', () => {
  const KW = 'w1覆盖词';
  const GOOD = 't7-good';
  const BAD = 't7-broken';

  it('7.1 某个项目的 JSON 读不出来 ⇒ **跳过但逐个点名**（`skipped` + 文本档 ⚠ 行 + 汇总行写"没扫成"）', () => {
    mkProject(GOOD, kwNodes(KW, 1));
    mkProject(BAD, kwNodes(KW, 1));
    fs.writeFileSync(projFile(BAD), '{这不是合法 JSON', 'utf8');
    try {
      const j = searchAll(KW);
      // 它**不在**命中里（这不是"忘了扫"，是"扫不成"）——但必须看得见，否则 hitCount 会被当成整库的全部
      expect(j.hits.map((h) => h.project)).toEqual([GOOD]);
      expect(j.scanned).toContain(GOOD);
      expect(j.scanned).not.toContain(BAD);
      expect(j.skipped.map((s) => s.project)).toContain(BAD);
      const skippedWhy = j.skipped.filter((s) => s.project === BAD)[0];
      expect(typeof skippedWhy.reason).toBe('string');
      expect(skippedWhy.reason.length).toBeGreaterThan(0);
      const r = run(['search-all', KW]);
      expect(r.code, r.stdout).toBe(0);                        // ← 整体失败（改回"一个坏项目 ⇒ 全库不可用"）必红
      expect(r.stdout).toContain('⚠ 跳过项目「' + BAD + '」');
      expect(r.stdout).toContain('validate ' + BAD);           // 出路①：修它
      expect(r.stdout).toContain('--scope');                   // 出路②：明确排除
      // ← 汇总行**不许**让它读成"整库的全部"：报出的个数必须 == **本次真的跳过了几个**（个数**现算**，
      //    不写死；写死会在"环境里还有别的坏项目"时假红 —— 放行窗口实测过一次）
      expect(r.stdout, '报出的跳过个数必须等于真个数 ' + j.skipped.length)
        .toContain('另有 ' + j.skipped.length + ' 个项目没扫成');
      // `--scope` 排除它 ⇒ 无跳过（对照：上面那条红不是因为命令坏了）
      const j2 = searchAll(KW, ['--scope', GOOD]);
      expect(j2.skipped).toEqual([]);
    } finally {
      fs.rmSync(projDir(BAD), { recursive: true, force: true });
    }
  });

  it('7.2 某个项目的热度日志坏了 ⇒ exit 1、点名**是哪个项目**+ `坏行`；`--no-heat` ⇒ 先拿到结果', () => {
    const P = 't7-badlog';
    mkProject(P, kwNodes('w1坏日志词', 2));
    fs.writeFileSync(logFile(P), '{"v":1,"at":"懒得写了"\n', 'utf8');
    try {
      const r = run(['search-all', 'w1坏日志词']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(P);                            // ← 点名项目（不点就只能瞎猜）
      expect(r.stdout).toContain('坏行');
      expect(r.stdout).toContain('--no-heat');                  // 出路随报错一起回去
      const j = searchAll('w1坏日志词', ['--no-heat']);
      expect(j.hits.map((h) => h.nodeId)).toEqual(['nd-1', 'nd-2']);
      expect(j.heat.reason).toBe('被 --no-heat 显式关闭');
    } finally {
      fs.rmSync(projDir(P), { recursive: true, force: true });
      try { fs.rmSync(logFile(P), { force: true }); } catch (e) { /* 旁路产物 */ }
    }
  });
});

/* ============================================================================
 * ⑧ 形状与参数闸门
 * ========================================================================== */
describe('⑧ JSON 形状 + 参数闸门前置', () => {
  it('8.1 `--json` 顶层字段齐全（调用方要能分辨"零结果/截断/扫了谁/谁没扫成"）', () => {
    const j = searchAll('w1跨项目词');
    ['keyword', 'tag', 'scoped', 'scope', 'scanned', 'skipped', 'hits', 'hitCount', 'truncated', 'mode', 'budget', 'heat']
      .forEach((k) => expect(Object.prototype.hasOwnProperty.call(j, k), '缺字段 ' + k).toBe(true));
    expect(j.mode).toBe('items');
    expect(j.skipped).toEqual([]);
    expect(j.heat.windowDays).toBeGreaterThan(0);
    expect(j.heat.perProject.length).toBe(j.scanned.length);
  });

  it('8.2 参数写错 ⇒ 在**碰任何项目之前**就报错（报文不带"项目「…」："前缀）', () => {
    // 缺关键词
    let r = run(['search-all']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('缺少关键词');
    expect(r.stdout).not.toContain('项目「');
    // --topic-only 与条目级过滤同给（这条判定的唯一实现在 src/item-index.js）
    r = run(['search-all', 'w1跨项目词', '--topic-only', '--src', 'x']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('--topic-only');
    expect(r.stdout).not.toContain('项目「');                   // ← 逐项目才报 ⇒ 说明闸门被搬到了循环里（红）
  });

  it('8.3 `--tag` 与 `--full` 逐字同义（转发的就是同一个 searchItems）', () => {
    const P = 't8-tag';
    mkProject(P, [{ id: 'nt-1', topic: '打标容器' }]);
    const r = run(['edit', P, 'nt-1', '--tags', 'w1标签']);
    expect(r.code, r.stdout).toBe(0);
    const byTag = jrun(['search-all', '--tag', 'w1标签', '--scope', P, '--json']);
    expect(byTag.hits.map((h) => h.nodeId)).toEqual(['nt-1']);
    // 单项目同参数逐字段相同（除多一个 project）
    const one = jrun(['search', P, '--tag', 'w1标签', '--json']);
    expect(JSON.stringify(byTag.hits)).toBe(JSON.stringify(one.hits.map((h) => Object.assign({ project: P }, h))));
  });

  it('8.4 `--full` 真的多开那一个面：词只出现在**详情**里 ⇒ 不给 `--full` 不命中，给了才命中', () => {
    const P = 't8-full';
    const KW = 'w1详情独有词';
    mkProject(P, [{ id: 'nf-1', topic: '容器戊' }]);
    const r = run(['edit', P, 'nf-1', '--detail-md', '这里写着 ' + KW + '，标题里没有']);
    expect(r.code, r.stdout).toBe(0);
    const scope = ['--scope', P, '--no-heat'];
    expect(searchAll(KW, scope).hits).toEqual([]);                     // ← 默认口径（标题 ∪ 条目正文）不看 detail
    const full = searchAll(KW, scope.concat('--full'));
    expect(full.hits.map((h) => h.nodeId)).toEqual(['nf-1']);
    expect(full.hits[0].project).toBe(P);
    expect(full.hits[0].matchIn).toBe('detail');
    // 与单项目 `search --full` 逐字相同（同一处实现）
    const one = jrun(['search', P, KW, '--full', '--no-heat', '--json']);
    expect(JSON.stringify(full.hits)).toBe(JSON.stringify(one.hits.map((h) => Object.assign({ project: P }, h))));
  });
});
