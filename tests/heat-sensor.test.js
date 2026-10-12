/* ============================================================
 * tests/heat-sensor.test.js — 热度条第三件 · C 块：把「AI 的访问」真记下来
 * 运行：npx vitest run tests/heat-sensor.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条对着 `.review/20261012-热度条/规格与裁决.md` 的一条判据）
 *   C① **每条通道跑一次 ⇒ 日志里出现该通道的事件**，且条数符合上限口径
 *       （`get`→`ai-get` 1 条；`read`/`search`→被上限压到 `LOG_MAX_PER_CALL` 条；
 *        `related`→起点 + 邻域；`ask`→只在真答出来时记）；
 *   C② **输出逐字节不变**：同一命令、同一份日志基线 ⇒ 埋点关着与开着，stdout / stderr / 退出码**全同**；
 *       并且**关掉埋点时零写盘**（那条是最干净的"埋点只多写日志、不改行为"的判据）；
 *   C③ **埋点不改命中 / 排序 / 退出码**（A 段顺带查：坏日志那条路一条都不记）；
 *   C④ **注入证明一条**：把某个命令的埋点去掉 ⇒ C①**必红** ⇒ 还原复绿
 *       （这里用"把源码里的那一行挖掉再放回去"来做 —— 与"真去改文件"等效，但不依赖写源码）。
 *   C⑤ 结构：`MM_HEAT_SENSOR` 这个总开关在生产代码里除定义处外没有别的引用（同 `heat-bars` C2）。
 *
 * ## ⚠️ 本文件**不关**埋点（这正是它的意义）
 *   `tests/heat.test.js` / `tests/search-heat.test.js` 关掉它（它们的判据建立在"日志里只有我写的事件"上）；
 *   本文件的判据恰恰是"埋点**该**写"⇒ 开了才对。两处口径互不干扰，各自在文件头写明理由。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---- ① 沙箱（必须在 require cli/main.js 之前设好）---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-heatsensor-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const heat = require('../src/heat.js');
const sensor = require('../src/heat-sensor.js');
const store = require('../src/data-store.js').createStore(SANDBOX);

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (argv) => invokeSync(argv);
const logFile = (name) => store.visitLogFile(name);

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 沙箱删不掉不影响判定 */ }
});

/** 日志里的事件（**只解析成功的行**；坏行会被读方响亮拦下，不在本文件的范围内） */
function events(name) {
  const f = logFile(name);
  if (!fs.existsSync(f)) return [];
  const out = [];
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach((l) => {
    try { out.push(JSON.parse(l)); } catch (e) { /* 夹具故意造的坏行：跳过 */ }
  });
  return out;
}
const channels = (name) => {
  const out = {};
  events(name).forEach((e) => { out[e.ch] = (out[e.ch] || 0) + 1; });
  return out;
};
const logBytes = (name) => (fs.existsSync(logFile(name)) ? fs.statSync(logFile(name)).size : 0);

/** 造一个 N 节点的项目（节点 id 形如 `nd-1`；都命中关键词"闸门"） */
let seq = 0;
function fixture(n, withLink) {
  const name = 'hs' + (++seq);
  run(['init', name]);
  for (let i = 1; i <= n; i++) run(['add', name, 'root', '--topic', '闸门 第' + i, '--id', 'nd-' + i]);
  if (withLink) run(['link', name, 'nd-1', '--to', name, '--id', 'nd-2']);
  return name;
}

/** 传感器开关（返回被换掉的值；调用方负责还原） */
const setSensor = (on) => sensor.__setEnabledForTest(on);

/* ============================================================================
 * A. 每条通道跑一次 ⇒ 该通道的事件出现（且条数符合上限口径）
 * ========================================================================== */
describe('A. 五条通道：每条命令跑一次就该出现该通道的事件', () => {
  it('A1 `get` ⇒ `ai-get` 恰好 1 条（按 id 直取单个节点）', () => {
    const p = fixture(3);
    expect(channels(p)['ai-get'] || 0).toBe(0);                 // 前置：还没记过
    const r = run(['get', p, 'nd-2', '--json']);
    expect(r.code).toBe(0);
    const evs = events(p);
    expect(evs.length).toBe(1);
    expect(evs[0].ch).toBe('ai-get');
    expect(evs[0].node).toBe('nd-2');
    expect(evs[0].by).toBe('cli:get');                          // "谁记的"与变更日志同口径
    expect(heat.channelInfo(evs[0].ch).who).toBe('ai');         // 谁（人/AI）由通道决定
  });

  it('A2 `read` ⇒ `ai-read-view`：**被上限压到 LOG_MAX_PER_CALL 条**（一次读整页带出几十个节点）', () => {
    const p = fixture(30);
    const r = run(['read', p, '--json', '--brief']);
    expect(r.code).toBe(0);
    const evs = events(p);
    expect(evs.length).toBe(sensor.LOG_MAX_PER_CALL);            // ← 上限口径（唯一一处：src/heat-sensor.js）
    expect(evs.every((e) => e.ch === 'ai-read-view')).toBe(true);
    // 取的是**返回顺序的前缀** ⇒ 树的前 N 个节点（root 也算一个：它确实被返回了）
    const firstN = JSON.parse(r.stdout).nodes.slice(0, sensor.LOG_MAX_PER_CALL).map((n) => n.id);
    expect(evs.map((e) => e.node)).toEqual(firstN);
    // 反面前置：这次真的**返回了** 31 个节点（root + 30）⇒ 上面那条"上限"不是空话
    expect(JSON.parse(r.stdout).nodeCount).toBe(31);
  });

  it('A3 `read --subtree` ⇒ 只记那棵子树里的节点（"返回了什么"就记什么）', () => {
    const p = fixture(6);
    run(['add', p, 'nd-1', '--topic', '闸门 子甲', '--id', 'nd-1-1']);
    run(['read', p, '--json', '--subtree', 'nd-1']);
    const evs = events(p);
    expect(evs.every((e) => e.ch === 'ai-read-view')).toBe(true);
    expect(evs.map((e) => e.node).sort()).toEqual(['nd-1', 'nd-1-1']);
  });

  it('A4 `search` ⇒ `ai-search-hit`：记的是**本次返回的命中**（含 --limit 截断后的那几条）', () => {
    const p = fixture(12);
    const r = run(['search', p, '闸门', '--json', '--limit', '3']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.hits.length).toBe(3);
    expect(j.truncated).toBe(true);
    const evs = events(p);
    expect(evs.length).toBe(3);                                  // 只记返回了的那 3 条
    expect(evs.map((e) => e.node)).toEqual(j.hits.map((h) => h.nodeId));
    expect(evs.every((e) => e.ch === 'ai-search-hit')).toBe(true);
  });

  it('A5 `search` 超过上限 ⇒ 只记前 LOG_MAX_PER_CALL 条（日志不被读路径灌爆）', () => {
    const p = fixture(40);
    const r = run(['search', p, '闸门', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.hits.length).toBeGreaterThan(sensor.LOG_MAX_PER_CALL);
    const evs = events(p);
    expect(evs.length).toBe(sensor.LOG_MAX_PER_CALL);
    expect(evs.map((e) => e.node)).toEqual(j.hits.slice(0, sensor.LOG_MAX_PER_CALL).map((h) => h.nodeId));
  });

  it('A6 `related` ⇒ `ai-related-hop`：起点 + 邻域里的节点（真的返回了哪些就记哪些）', () => {
    const p = fixture(5, true);
    const r = run(['related', p, 'nd-1', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.items.length).toBeGreaterThan(0);                   // 前置：真有邻域
    const evs = events(p);
    expect(evs.every((e) => e.ch === 'ai-related-hop')).toBe(true);
    const want = [j.target.id].concat(j.items.map((x) => x.node));
    expect(evs.map((e) => e.node).sort()).toEqual(want.slice().sort());
  });

  it('A7 `ask --dry-run` ⇒ **一条都不记**（没调模型、没有内容被消耗）', () => {
    const p = fixture(3);
    const r = run(['ask', p, 'nd-1', '--kind', 'explain', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--dry-run');
    expect(events(p).length).toBe(0);                            // ← dry-run 不是访问
  });

  it('A8 只读命令的坏日志路径**一条都不记**（不给半份结果的同一精神）', () => {
    const p = fixture(3);
    fs.appendFileSync(logFile(p), '{"v":1,"at":"懒得写了"\n', 'utf8');
    const before = logBytes(p);
    const r = run(['search', p, '闸门']);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('坏行');
    expect(logBytes(p)).toBe(before);                            // 报错路径**不追加**（一个字都没写）
    const r2 = run(['read', p, '--json', '--brief']);
    expect(r2.code).toBe(0);
    // `read` 不看热度 ⇒ 它照样记（坏日志不影响它自己的读数正确性；写是 O(1) 追加、不读历史）。
    // 这条夹具只有 3 个节点 + root ⇒ 记 4 条（**没到上限**，所以这里就是"返回了几个记几个"）。
    expect(channels(p)['ai-read-view']).toBe(4);
    // 而"坏行"仍在日志里（埋点只追加，不动既有字节）
    expect(fs.readFileSync(logFile(p), 'utf8')).toContain('懒得写了');
  });

  it('A9 同一节点在一次调用里重复出现 ⇒ 只记一次（一次 read 里的重复 id 不算两次访问）', () => {
    const p = fixture(4);
    const r = sensor.recordVisit(logFile(p), 'ai-get', ['nd-1', 'nd-1', 'nd-1', 'nd-2'], { by: 'test' });
    expect(r.recorded).toBe(2);
    expect(events(p).map((e) => e.node)).toEqual(['nd-1', 'nd-2']);
  });

  it('A10 认不出的通道 ⇒ **不猜**（如实 dropped + 报错文本，不写任何事件）', () => {
    const p = fixture(2);
    const r = sensor.recordVisit(logFile(p), 'ai-telepathy', ['nd-1'], { by: 'test' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-channel');
    expect(r.recorded).toBe(0);
    expect(r.errors.join(' ')).toContain('ai-telepathy');
    expect(r.errors.join(' ')).toContain('CHANNELS');            // 报文与写入端同源
    expect(events(p).length).toBe(0);
  });

  it('A11 一份日志只追加：坏前缀**逐字节不变**（埋点走的是 appendEvent，不重写文件）', () => {
    const p = fixture(3);
    const poison = '{"v":1,"at":"懒得写了"\n';
    fs.appendFileSync(logFile(p), poison, 'utf8');
    const before = fs.readFileSync(logFile(p));
    run(['get', p, 'nd-1', '--json']);
    const after = fs.readFileSync(logFile(p));
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);   // ← 前缀一个字节没动
  });
});

/* ============================================================================
 * B. 判据②：输出逐字节不变 + 关掉埋点零写盘
 * ========================================================================== */
describe('B. 埋点不改输出：同一命令、同一日志基线 ⇒ OFF / ON 逐字节相同', () => {
  const CASES = [
    [['search', '闸门', '--json', '--no-heat']],
    [['search', '闸门', '--no-heat']],
    [['search', '闸门', '--json']],          // 带热度那档（日志基线相同 ⇒ 排序也相同）
    [['read', '--json']],
    [['read', '--json', '--brief', '--compact']],
    [['read']],
    [['get', 'nd-3', '--json']],
    [['get', 'nd-3']],
    [['related', 'nd-1', '--json']],
    [['related', 'nd-1']]
  ];

  it('B1 十条命令逐字节相同（stdout + stderr + 退出码），且**关掉埋点时零写盘**', () => {
    const p = fixture(12, true);
    // 先热一下：让日志非空（这样 `search` 的热度那档也有真实读数）
    for (let i = 0; i < 3; i++) run(['visit', p, 'nd-7', '--channel', 'human-detail']);
    run(['visit', p, 'nd-2', '--channel', 'ai-get']);

    const rows = CASES.map((c) => {
      const argv = c[0].map((x) => (x === 'nd-3' || x === 'nd-1' || x === '闸门' ? x : x));
      const full = [argv[0], p].concat(argv.slice(1));
      // OFF 跑两次：先钉"这条命令自身是确定性的"（否则 OFF/ON 的差别说不清是谁造成的）
      setSensor(false);
      const a1 = run(full);
      const offGrew = (() => { const n = logBytes(p); return n; })();
      const a2 = run(full);
      const wroteWhenOff = logBytes(p) - offGrew;
      setSensor(true);
      const b = run(full);
      setSensor(false);
      return {
        cmd: full.join(' '),
        deterministic: a1.stdout === a2.stdout && a1.stderr === a2.stderr && a1.code === a2.code,
        identical: a1.stdout === b.stdout && a1.stderr === b.stderr && a1.code === b.code,
        wroteWhenOff: wroteWhenOff
      };
    });
    setSensor(true);
    rows.forEach((r) => console.log('[B1] ' + r.cmd + ' ｜ 自身确定=' + r.deterministic
      + ' ｜ OFF/ON 相同=' + r.identical + ' ｜ 关掉时写盘 ' + r.wroteWhenOff + ' B'));
    expect(rows.filter((r) => !r.deterministic)).toEqual([]);
    expect(rows.filter((r) => !r.identical)).toEqual([]);
    expect(rows.filter((r) => r.wroteWhenOff !== 0)).toEqual([]);
  });
});

/* ============================================================================
 * C. 判据④：注入证明（去掉一条埋点 ⇒ A 段必红 ⇒ 还原复绿）
 * ========================================================================== */
describe('C. 注入证明：这条判据有判别力（不是恒真）', () => {
  /** 生产文件里埋点的**调用点**（每条命令一处；改这个文件前先看清单） */
  const CALLS = [
    { file: 'cli/commands/project.js', what: "ctx.recordVisit('ai-get'", chan: 'ai-get' },
    { file: 'cli/commands/project.js', what: "ctx.recordVisit('ai-read-view'", chan: 'ai-read-view' },
    { file: 'cli/commands/project.js', what: "ctx.recordVisit('ai-search-hit'", chan: 'ai-search-hit' },
    { file: 'cli/commands/relations.js', what: "ctx.recordVisit('ai-related-hop'", chan: 'ai-related-hop' },
    { file: 'cli/commands/dsh-ask.js', what: "ctx.recordVisit('ai-ask'", chan: 'ai-ask' }
  ];

  it('C1 五条通道的调用点都真的在源码里（少一处 ⇒ 红）', () => {
    CALLS.forEach((c) => {
      const src = fs.readFileSync(path.join(ROOT, c.file), 'utf8');
      expect(src.indexOf(c.what), c.file + ' 里缺 ' + c.what).toBeGreaterThan(-1);
    });
  });

  it('C2 【注入】把 `ai-get` 的埋点按同一手法"去掉" ⇒ 那一条通道事件为 0（判据必红）；还原 ⇒ 复绿', () => {
    const p = fixture(3);
    // —— 基线（正常源码）：`get` 记 1 条 ——
    run(['get', p, 'nd-1', '--json']);
    expect(channels(p)['ai-get']).toBe(1);
    // —— 注入：把那一行**从内存里的服务实现上摘掉**（不改文件；等价于注释掉它）——
    const real = sensor.recordVisit;
    const injected = function (file, ch, ids, opts) {
      if (ch === 'ai-get') return { ok: true, reason: 'injected-off', channel: ch, recorded: 0, dropped: 0, errors: [] };
      return real(file, ch, ids, opts);
    };
    // 覆盖的是**模块导出**（生产代码经 `require('../src/heat-sensor.js')` 取它 ⇒ 注入真的生效）
    sensor.recordVisit = injected;
    let injectedCount = null;
    try {
      run(['get', p, 'nd-2', '--json']);
      injectedCount = channels(p)['ai-get'];
    } finally {
      sensor.recordVisit = real;
    }
    expect(injectedCount).toBe(1);          // ← 注入后**没有新增**（红线读数）
    run(['get', p, 'nd-3', '--json']);      // 还原 ⇒ 复绿
    expect(channels(p)['ai-get']).toBe(2);
  });
});

/* ============================================================================
 * D. 结构：总开关只给测试用
 * ========================================================================== */
describe('D. 结构断言', () => {
  it('D1 `MM_HEAT_SENSOR` 在生产代码里除定义处外没有别的引用（开关不是能被人误触的常设口子）', () => {
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      if (fs.statSync(abs).isFile()) return rel.endsWith('.js') ? [rel] : [];
      let out = [];
      fs.readdirSync(abs, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory()) { if (e.name !== 'node_modules') out = out.concat(walk(rel + '/' + e.name)); return; }
        if (e.name.endsWith('.js')) out.push(rel + '/' + e.name);
      });
      return out;
    };
    const files = [].concat(walk('src'), walk('cli'), walk('renderer'), walk('scripts'))
      .concat(['main.js', 'preload.js']);
    const hits = [];
    files.forEach((f) => {
      if (f === 'src/heat-sensor.js') return;                    // ← 唯一允许的定义处
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (src.indexOf('MM_HEAT_SENSOR') >= 0) hits.push(f);
    });
    expect(hits).toEqual([]);
  });

  it('D2 上限口径只有一处：命令层里不出现那个数字（`LOG_MAX_PER_CALL` 只在 src/heat-sensor.js）', () => {
    ['cli/commands/project.js', 'cli/commands/relations.js', 'cli/commands/dsh-ask.js', 'cli/commands/heat.js']
      .forEach((f) => {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        expect(src.indexOf('LOG_MAX_PER_CALL'), f + ' 里不该出现上限常量').toBe(-1);
        expect(src.indexOf('LOG_MAX_IDS'), f + ' 里不该出现上限常量').toBe(-1);
      });
  });

  it('D3 `ctx.recordVisit` 的失败口径：写不进去就如实 `dropped` + `errors`，**不抛**（不掐死读路径）', () => {
    const p = fixture(2);
    // 用一个**目录**当日志路径 ⇒ 追加必然失败（模拟"日志写不进去"）
    const dirAsFile = path.join(SANDBOX, 'not-a-file-dir');
    fs.mkdirSync(dirAsFile, { recursive: true });
    const r = sensor.recordVisit(dirAsFile, 'ai-get', ['nd-1'], { by: 'test' });
    expect(r.ok).toBe(false);
    expect(r.recorded).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(' ')).toContain('写入失败');
    // 而**读路径不受影响**：同一个进程里正常记录照样成功
    expect(sensor.recordVisit(logFile(p), 'ai-get', ['nd-1'], { by: 'test' }).recorded).toBe(1);
  });
});
