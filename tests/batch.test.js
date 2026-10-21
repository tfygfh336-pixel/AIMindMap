/* ============================================================
 * tests/batch.test.js — `batch`：一次进程跑多条命令
 * 运行：node node_modules/vitest/vitest.mjs run tests/batch.test.js
 * ------------------------------------------------------------
 * ## 这个文件守的第一件事**不是**性能，是**语义**
 *
 * `batch` 把 N 条命令塞进一次调用。真正会害人的不是"少个省不了"，而是"失败时盘上处于什么状态"
 * —— 那是调用方**敢不敢用**的分界线。本文件把它钉成断言（A 组）：
 *
 *   **第 3 条失败时，前 2 条保留**（逐条独立生效，**不整体回滚**）。
 *
 * 为什么选这一档（理由同时写在 `cli/commands/batch.js` 文件头与 `cli/registry.js` 的登记处）：
 *   ① `apply --ops-file` 已经是原子事务原语（一个 rev / 一次原子写 / 全成或全不动）；
 *      让 `batch` 再实现一套原子语义 = 同一语义两处实现。
 *   ② `batch` 要跑**任意**命令，含只读的 `search`/`get` —— 对读操作"回滚"没有意义。
 *   ③ 回滚只能靠"快照 `projects/**` 再恢复"，而本机**同时有界面与别的 agent 在写** ⇒
 *      恢复快照会**覆盖别人的写**。那是正确性风险，不是性能特性。
 *
 * ## 守什么（每条都对着一个**能红**的判据）
 *   A. **失败语义**：第 3 条必失败 ⇒ 盘上第 1、2 条的改动**在**、退出码 1、回执点名第 3 条；
 *      且 `continueOnError:true` 时后面的照跑、总数对齐、退出码仍 1。
 *   B. **单跑 vs 批内跑，产物逐字节相同**（同一条路径的唯一硬判据）—— 含成功档与失败档两种。
 *   C. **批量化不是后门**：批里带未知选项 / 未知命令 / 缺必填参数，一律照单独执行那样被拒。
 *   D. **`--json` 两跑逐字节相同**（键序固定、无时间戳、无耗时字段）。
 *   E. **payload 校验**：非数组 / 空数组 / 非字符串项 / `calls` 为空 / 批里套批 / `--` 一律响亮拒绝。
 *   F. **归属守门**：`batch` 自己不收 `--dry-run` / `--idem`（理由见命令文件头），要干跑写在 payload 里。
 *   G. **dryRun 注入只给认这个开关的命令**（在 `search` 上注入 `--dry-run` 会让整批因"干跑"而失败，
 *      而那个失败与被测的改动毫无关系）。
 *
 * ## 为什么在**临时目录**里跑
 * 与 `tests/idem.test.js` 同一条纪律：`AI_MINDMAP_PROJECTS_DIR` 指向 `os.tmpdir()` 沙箱 ⇒
 * 不与真实笔记、也不与并行跑门禁的其它流互踩，且可以放心断言"盘上逐字节不变"这类**强判据**。
 * ⚠️ 顺序不能换：`cli/core.js` 在**模块加载时**读这个环境变量 ⇒ 必须先设 env、再**动态** require CLI
 *   （静态 `import` 会被提升到文件顶部，那时 env 还没设 ⇒ 全部落到真实 `projects/` 上 ✗）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/** 沙箱项目名（全文件只在它上面写；`afterAll` 整目录清掉） */
const P = 'w25-batch-probe';
/** payload 文件目录：与项目目录同一沙箱根，**别写进工程** */
const SANDBOX = makeTmp('mm-batch-');
const CALLS_DIR = path.join(SANDBOX, 'calls');
fs.mkdirSync(CALLS_DIR, { recursive: true });

let invokeSync = null;

const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const readBytes = (p) => fs.readFileSync(p);                 // Buffer：**逐字节**判据
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

/** 跑一条命令（进程内同步；命令体必须同步完成，见 tests/cli-sync-invariant.test.js） */
function cli(args) {
  const r = invokeSync(args);
  return { code: r.code, out: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr };
}

/** 写一份 payload 文件，返回**绝对路径**（测试里给绝对路径最稳） */
let seq = 0;
function callsFile(content) {
  const p = path.join(CALLS_DIR, 'c' + (++seq) + '.json');
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return p;
}

/** 取某节点（读盘真值，不走 CLI 的包装视图） */
function nodeOf(name, id) {
  const d = readJson(projFile(name));
  return (function walk(n) {
    if (!n) return null;
    if (n.id === id) return n;
    for (const c of (n.children || [])) { const r = walk(c); if (r) return r; }
    return null;
  })(d.data);
}

/** 跑一批 `--json`，返回解析后的对象 + 原始 stdout（逐字节判据要用原文） */
function runBatch(payload, extraArgs) {
  const p = callsFile(payload);
  const r = cli(['batch', '--calls-file', p, '--json'].concat(extraArgs || []));
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) { json = null; }
  return { code: r.code, raw: r.stdout, json: json, out: r.out };
}

beforeAll(async () => {
  process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;      // ⚠️ 必须在 require CLI 之前
  const main = await import('../cli/main.js');
  invokeSync = main.invokeSync;
  expect(invokeSync).toBeTypeOf('function');
  expect(cli(['init', P, '--title', 'W25 batch 探针']).code).toBe(0);
  // 固定 id ⇒ 后续断言引用确定
  ['b1', 'b2', 'b3', 'b4'].forEach((id) => {
    expect(cli(['add', P, 'root', '--topic', id, '--id', id]).code).toBe(0);
  });
});

afterAll(() => {
  cleanupAll();
});

/* ============================================================================
 * A. 失败语义：**前 N 条保留，不整体回滚**（本命令最承重的一条）
 * ========================================================================== */
describe('W25-A 失败语义：第 3 条失败 ⇒ 前 2 条保留（逐条独立生效）', () => {
  it('前 2 条的改动在盘上、第 3 条没生效、退出码 1、回执点名第 3 条', () => {
    // 第 3 条必失败：b3 的**父节点不存在**（`edit` 对不存在的 id 会响亮报「节点不存在」）
    const r = runBatch({
      version: 1,
      calls: [
        ['edit', P, 'b1', '--tags', 'w25-a-1'],
        ['edit', P, 'b2', '--tags', 'w25-a-2'],
        ['edit', P, 'nope-b3', '--tags', 'w25-a-3']
      ]
    });
    expect(r.code).toBe(1);                              // 退出码是首选判据
    expect(r.json).not.toBeNull();                       // --json 仍是一份可解析的 JSON
    expect(r.json.results.length).toBe(3);
    expect(r.json.results[0].code).toBe(0);
    expect(r.json.results[1].code).toBe(0);
    expect(r.json.results[2].code).toBe(1);
    expect(r.json.summary).toEqual({ total: 3, ok: 2, failed: 1, stoppedAtIndex: 2 });

    // ★ 盘面事实：前两条**真的写进去了**（不是"回执说成功"）
    expect(nodeOf(P, 'b1').tags).toEqual(['w25-a-1']);
    expect(nodeOf(P, 'b2').tags).toEqual(['w25-a-2']);
    // 第 3 条的失败原因被原样带回来（调用方据此修，而不是去猜）
    expect(r.json.results[2].stdout).toContain('节点不存在');
  });

  it('默认**遇错即停**：第 3 条之后的那条根本没跑（results 长度就是证据）', () => {
    const r = runBatch({
      version: 1,
      calls: [
        ['edit', P, 'b1', '--tags', 'w25-stop-ok'],
        ['edit', P, 'nope-x', '--tags', 'boom'],
        ['edit', P, 'b4', '--tags', 'w25-stop-never']     // 这一条**不该被执行**
      ]
    });
    expect(r.code).toBe(1);
    expect(r.json.results.length).toBe(2);               // ← 停在第 2 条，第 3 条没进 results
    expect(r.json.summary.total).toBe(2);
    expect(r.json.summary.stoppedAtIndex).toBe(1);
    // 第 3 条**真的没跑**：b4 上没有那个标签（"没进 results" 与 "没执行" 是两件事，两件都要验）
    expect(nodeOf(P, 'b4').tags || []).not.toContain('w25-stop-never');
  });

  it('continueOnError:true ⇒ 后面的照跑，退出码仍是 1（"跑完了" ≠ "成功了"）', () => {
    const r = runBatch({
      version: 1,
      continueOnError: true,
      calls: [
        ['edit', P, 'b1', '--tags', 'w25-cont-1'],
        ['edit', P, 'nope-y', '--tags', 'boom'],
        ['edit', P, 'b4', '--tags', 'w25-cont-3']
      ]
    });
    expect(r.code).toBe(1);                              // 有失败 ⇒ 非 0，与"跑没跑完"无关
    expect(r.json.results.length).toBe(3);               // 三条都跑过
    expect(r.json.summary).toEqual({ total: 3, ok: 2, failed: 1, stoppedAtIndex: null });
    expect(nodeOf(P, 'b4').tags).toEqual(['w25-cont-3']); // 第 3 条**跑到了**（与前一条用例形成对照）
  });

  it('全成功 ⇒ 退出码 0（否则"非 0"就不能当判据了）', () => {
    const r = runBatch({
      version: 1,
      calls: [['edit', P, 'b1', '--tags', 'w25-all-ok'], ['get', P, 'b1', '--json']]
    });
    expect(r.code).toBe(0);
    expect(r.json.summary).toEqual({ total: 2, ok: 2, failed: 0, stoppedAtIndex: null });
  });

  it('空批次里的"前 N 条一条都没生效"也要能分辨：首条就失败 ⇒ ok:0', () => {
    const r = runBatch({ version: 1, calls: [['edit', P, 'nope-first', '--tags', 'x']] });
    expect(r.code).toBe(1);
    expect(r.json.summary.ok).toBe(0);                   // 调用方据此知道"盘上什么都没变"
  });
});

/* ============================================================================
 * B. 单跑 vs 批内跑：**产物逐字节相同**（"同一条路径"的唯一硬判据）
 * ========================================================================== */
describe('W25-B 单跑 vs 批内跑：stdout 逐字节相同', () => {
  it('成功档：批里那一条的 stdout === 单独跑一次的 stdout', () => {
    const argv = ['get', P, 'b1', '--json'];
    const solo = cli(argv);
    expect(solo.code).toBe(0);
    const r = runBatch({ version: 1, calls: [argv] });
    expect(r.json.results[0].stdout).toBe(solo.stdout);   // ★ 逐字节，不是"长度相同"
    expect(r.json.results[0].stderr).toBe(solo.stderr);
  });

  it('失败档：批里那一条的退出码与 stdout 也与单独跑一致（错误文本不许被改写）', () => {
    const argv = ['edit', P, 'nope-bytes', '--tags', 'x'];
    const solo = cli(argv);
    expect(solo.code).toBe(1);
    const r = runBatch({ version: 1, calls: [argv] });
    expect(r.json.results[0].code).toBe(solo.code);
    expect(r.json.results[0].stdout).toBe(solo.stdout);
  });

  it('多条连跑时，每一条的 stdout 都等于它单独跑的那一次', () => {
    const list = [
      ['get', P, 'b2', '--json'],
      ['list', P, '--json'],
      ['search', P, 'b3', '--json', '--no-heat']
    ];
    const solos = list.map((a) => cli(a).stdout);
    const r = runBatch({ version: 1, calls: list });
    expect(r.code).toBe(0);
    expect(r.json.results.map((x) => x.stdout)).toEqual(solos);
  });
});

/* ============================================================================
 * C. 批量化不是后门：单独执行会被拒的，批里照样被拒
 * ========================================================================== */
describe('W25-C 同一条守门路径：单独被拒的，批里也被拒', () => {
  const cases = [
    ['未知选项', ['list', P, '--nope-option']],
    ['未知命令', ['no-such-cmd-xyz']],
    ['缺必填参数', ['get', P]],                      // get 需要 id
    ['别名照旧可用', ['tree', P, '--json']]          // `tree` 是 list 的别名 —— 反面对照：不该被"太严"判死
  ];
  it.each(cases)('%s', (_label, argv) => {
    const solo = cli(argv);
    const r = runBatch({ version: 1, calls: [argv] });
    expect(r.json.results[0].code).toBe(solo.code);
    expect(r.json.results[0].stdout).toBe(solo.stdout);
  });

  it('批里的未知选项报错**点名该选项与支持集**（不是一句"失败了"）', () => {
    const r = runBatch({ version: 1, calls: [['list', P, '--nope-option']] });
    const txt = r.json.results[0].stdout;
    expect(txt).toContain('未知选项');
    expect(txt).toContain('--nope-option');
    expect(txt).toContain('支持的选项');             // 支持集整份打出来
  });
});

/* ============================================================================
 * D. `--json` 两跑逐字节相同（G-11 口径）
 * ========================================================================== */
describe('W25-D --json 两跑逐字节相同', () => {
  it('同一状态跑两次：stdout 完全相同（无时间戳、无耗时字段）', () => {
    const payload = {
      version: 1,
      calls: [
        ['get', P, 'b1', '--json'],
        ['search', P, 'b', '--json', '--no-heat'],
        ['edit', P, 'nope-det', '--tags', 'x']        // 故意带一条失败：失败档也必须确定
      ]
    };
    const a = runBatch(payload);
    const b = runBatch(payload);
    expect(a.raw).toBe(b.raw);
    expect(a.code).toBe(b.code);
    // 反向证明这条判据有力气：输出里确实带内容（不是两次都是空串）
    expect(a.raw.length).toBeGreaterThan(200);
  });
});

/* ============================================================================
 * E. payload 校验：形状错一律**在跑第一条之前**响亮拒绝
 * ========================================================================== */
describe('W25-E payload 校验（跑第一条之前就拒）', () => {
  const bytes = () => readBytes(projFile(P));

  it('缺 --calls-file ⇒ 退出码 1 并指路', () => {
    const r = cli(['batch']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('--calls-file');
  });

  it('文件不存在 ⇒ 点名路径并给出路', () => {
    const r = cli(['batch', '--calls-file', path.join(CALLS_DIR, 'nope.json')]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('不存在');
  });

  it('不是合法 JSON ⇒ 报错', () => {
    const r = cli(['batch', '--calls-file', callsFile('{not json')]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('不是合法 JSON');
  });

  const badPayloads = [
    ['calls 不是数组', { version: 1, calls: 'nope' }],
    ['calls 是空数组', { version: 1, calls: [] }],
    ['某条不是数组', { version: 1, calls: [['get', P, 'b1'], 'nope'] }],
    ['某条是空数组', { version: 1, calls: [[]] }],
    ['某条里有非字符串', { version: 1, calls: [['get', P, 5]] }],
    ['批里套批', { version: 1, calls: [['batch', '--calls-file', 'x.json']] }],
    ['argv 里有 --', { version: 1, calls: [['get', '--', P, 'b1']] }],
    ['version 不认识', { version: 2, calls: [['get', P, 'b1']] }],
    ['dryRun 不是布尔', { version: 1, dryRun: 'yes', calls: [['get', P, 'b1']] }],
    ['continueOnError 不是布尔', { version: 1, continueOnError: 1, calls: [['get', P, 'b1']] }]
  ];
  it.each(badPayloads)('%s ⇒ 退出码 1 且**盘上逐字节不变**', (_label, payload) => {
    const before = bytes();
    const p = callsFile(payload);
    const r = cli(['batch', '--calls-file', p]);
    expect(r.code).toBe(1);
    expect(r.stdout.trim().startsWith('error:')).toBe(true);   // 文本档失败契约
    expect(bytes().equals(before)).toBe(true);                 // ★ 预检在跑之前 ⇒ 盘上零改动
  });

  it('裸数组形态可用（少一层嵌套就少一次手写错）', () => {
    const r = runBatch([['get', P, 'b1', '--json']]);
    expect(r.code).toBe(0);
    expect(r.json.results.length).toBe(1);
  });

  it('超过条数上界 ⇒ 点名上界并给出路', () => {
    const calls = [];
    for (let i = 0; i < 201; i++) calls.push(['get', P, 'b1', '--json']);
    const r = cli(['batch', '--calls-file', callsFile({ version: 1, calls: calls })]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('最多 200 条');
  });
});

/* ============================================================================
 * F. 归属守门：`batch` 自己不收 --dry-run / --idem
 * ========================================================================== */
describe('W25-F 归属守门：干跑与幂等键都写在 payload 里', () => {
  it('`batch --idem k` ⇒ 响亮拒绝（它不是写命令；批次级幂等键是假承诺）', () => {
    const r = cli(['batch', '--calls-file', callsFile({ version: 1, calls: [['get', P, 'b1']] }), '--idem', 'k']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('--idem');
  });

  it('`batch --dry-run` ⇒ 响亮拒绝（它不在 DRY_RUN_COMMANDS 里，理由是"它是调度器不是写操作"）', () => {
    const r = cli(['batch', '--calls-file', callsFile({ version: 1, calls: [['get', P, 'b1']] }), '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('--dry-run');
  });

  it('payload 里 dryRun:true ⇒ 写命令收到 --dry-run（盘上不变），且**只**注入给认它的命令', () => {
    const before = readBytes(projFile(P));
    const r = runBatch({
      version: 1,
      dryRun: true,
      calls: [
        ['edit', P, 'b1', '--tags', 'w25-dry-should-not-land'],
        ['search', P, 'b', '--json', '--no-heat']      // 只读命令：**不许**被注入 --dry-run
      ]
    });
    expect(r.code).toBe(0);                             // 干跑不是失败
    expect(r.json.dryRun).toBe(true);
    // ★ 写命令真的没写盘
    expect(readBytes(projFile(P)).equals(before)).toBe(true);
    expect(nodeOf(P, 'b1').tags || []).not.toContain('w25-dry-should-not-land');
    // ★ 只读命令没被注入（被注入的话它会被守门拒掉、code 非 0）
    expect(r.json.results[1].code).toBe(0);
    expect(r.json.results[1].argv).toEqual(['search', P, 'b', '--json', '--no-heat']);
    // 写命令的 argv 上看得见注入（机器可判，不必解析中文）
    expect(r.json.results[0].argv).toContain('--dry-run');
  });
});

/* ============================================================================
 * G. 文本档的失败契约：首行必须是 `error:`
 * ========================================================================== */
describe('W25-G 文本档失败：首行 error: + 逐条回执都在', () => {
  it('首行 error:、含"已经生效"的条数、逐条回执行都在', () => {
    const p = callsFile({
      version: 1,
      calls: [
        ['edit', P, 'b2', '--tags', 'w25-text-1'],
        ['edit', P, 'nope-text', '--tags', 'x']
      ]
    });
    const r = cli(['batch', '--calls-file', p]);
    expect(r.code).toBe(1);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0].startsWith('error:')).toBe(true);    // 本工程对文本消费者的失败契约
    expect(r.stdout).toContain('已经生效');              // 不能只报"错了"，要说清盘上处于什么状态
    expect(r.stdout).toContain('[1/2] ok');
    expect(r.stdout).toContain('[2/2] FAIL');
  });

  it('全成功的文本档**不**以 error: 开头（否则调用方会把成功读成失败）', () => {
    const p = callsFile({ version: 1, calls: [['get', P, 'b1', '--json']] });
    const r = cli(['batch', '--calls-file', p]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().startsWith('error:')).toBe(false);
    expect(r.stdout).toContain('batch 完成');
  });
});
