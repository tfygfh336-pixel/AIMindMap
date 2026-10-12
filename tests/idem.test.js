/* ============================================================
 * tests/idem.test.js — 写管道流（S7）：**重试安全**（幂等）
 * 运行：npx vitest run tests/idem.test.js
 * ------------------------------------------------------------
 * ## 这个文件为什么存在（三条已实测的缺陷）
 *   ① `add` 重试会造重复：`src/markdown.js` 的 `idGen` 含**时间 + 随机**，不带 `--id`
 *      时零判重 ⇒ 同一条命令跑两遍 = 两个同名节点，而调用方看到的是两次"已添加"；
 *   ② 没有统一的幂等键 ⇒ **重试 = 重复生效**（网络重发 / 脚本重跑 / AI 拿不准再敲一遍）；
 *   ③ `.changes.jsonl` 里没有"这是第几次重试"的位置 ⇒ 事后连"重复过"都看不出来。
 *
 * ## 守什么（每条都对着一个**能红**的判据）
 *   A. 同 `--idem` 重放两次 ⇒ 项目文件**逐字节不变** + 回显含「幂等命中」；
 *   B. `add` 同父同题重放 ⇒ **默认拒绝并点名那一条**（不是静默跳过、不是造第二份）；
 *   C. 一次 `apply` 改 N 条 ⇒ `.changes.jsonl` **只多 1 条**（一个 rev、一次原子写）；
 *   D. 中途第 k 条非法 ⇒ **整体不动**（盘上逐字节不变）且**点名第 k 条**（注入证明）；
 *   E. 键落进日志的**可选字段** `idem`（照 `origin` 先例：不升 formatVersion）；
 *   F. `assoc-add` 同款语义去重。
 * 另外锁住几个"边界不能退化"的点：dry-run 不查不记键、只读命令带 `--idem` 响亮拒绝、
 * 键不能跨命令复用、`--force` 是本工程既有的必填选项（`add` 用它放行有意重复）。
 *
 * ## 为什么在**临时目录**里跑（而不是真实 projects/）
 * 本文件把 `AI_MINDMAP_PROJECTS_DIR` 指向 `os.tmpdir()` 下的沙箱 ⇒
 *   · 不与真实笔记数据、也不与并行跑门禁的其它流互踩（集成脚本在真实 `projects/` 里造探针，
 *     本文件**不碰那条路**）；
 *   · 可以放心断言"盘上逐字节不变"这类**强判据**（临时目录里没有别人写）。
 * ⚠️ 顺序不能换：`cli/core.js` 在**模块加载时**读这个环境变量 ⇒ 必须先设它、再**动态** require
 *   CLI（静态 `import` 会被提升到文件顶部执行，那时 env 还没设 ⇒ 全部落到真实 projects/ 上 ✗）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** 本项目（沙箱）名 —— 全文件只在它上面写；`afterAll` 会整目录清掉 */
const P = 's7-idem-probe';
/** 跨项目作用域断言用的第二个项目 */
const P2 = 's7-idem-probe-2';
/** 每个用例自己的 ops 文件目录（与项目目录同一沙箱根，别写进工程） */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-idem-'));
const OPS_DIR = path.join(SANDBOX, 'ops');
fs.mkdirSync(OPS_DIR, { recursive: true });

let invokeSync = null;
let changes = null;
let registry = null;

const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const logFile = (name) => path.join(SANDBOX, name, '.changes.jsonl');
const readBytes = (p) => fs.readFileSync(p);                       // Buffer：**逐字节**判据
const readText = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p).replace(/^\uFEFF/, ''));
const journal = (name) => changes.parseLog(readText(logFile(name))).entries;

/** 跑一条命令（进程内同步；命令体必须同步完成，见 tests/cli-sync-invariant.test.js） */
function cli(args) {
  const r = invokeSync(args);
  return { code: r.code, out: r.stdout + r.stderr };
}

/** 写一个 ops 文件，返回**绝对路径**（相对路径会按 cwd 解析 —— 测试里给绝对路径最稳） */
function opsFile(name, content) {
  const p = path.join(OPS_DIR, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return p;
}

/** 取某节点（读盘真值，不走 CLI 的包装视图） */
function nodeOf(name, id) {
  const d = readJson(projFile(name));
  const found = (function walk(n) {
    if (!n) return null;
    if (n.id === id) return n;
    for (const c of (n.children || [])) { const r = walk(c); if (r) return r; }
    return null;
  })(d.data);
  return found;
}

/**
 * 「逐字节不变」的**唯一**写法：先跑一遍固定键，再拿**同一份**数据跑第二遍。
 * 为什么单独一个 helper：A 与 D 两条验收都靠它，复制两份判据等于留一个漂移口。
 */
function replayTwice(argsBuilder) {
  const p = projFile(P);
  const before = readBytes(p);
  const first = cli(argsBuilder('k'));
  const mid = readBytes(p);
  const second = cli(argsBuilder('k'));
  const after = readBytes(p);
  return { first, mid, second, before, after, p };
}

beforeAll(async () => {
  process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;      // ⚠️ 必须在 require CLI 之前
  const main = await import('../cli/main.js');
  invokeSync = main.invokeSync;
  changes = require('../src/changes.js');
  registry = require('../cli/registry.js');
  expect(invokeSync).toBeTypeOf('function');
  expect(cli(['init', P, '--title', 'S7 幂等探针']).code).toBe(0);
  expect(cli(['init', P2, '--title', 'S7 幂等探针 2']).code).toBe(0);
  // 固定几个供后续断言使用的节点（都带 `--id` ⇒ 后续引用它们的 id 是确定的）
  ['k1', 'k2', 'k3'].forEach((id) => {
    expect(cli(['add', P, 'root', '--topic', id, '--id', id]).code).toBe(0);
  });
});

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 收尾失败不影响判定 */ }
});

/* ============================================================================
 * A. 同 --idem 重放 ⇒ 数据逐字节不变 + 回显「幂等命中」
 * ========================================================================== */
describe('S7-A 同 --idem 重放：不重复执行 + 数据逐字节不变', () => {
  it('两遍数据逐字节相同、第二遍含「幂等命中」、节点数不变', () => {
    const r = replayTwice((k) => ['add', P, 'root', '--topic', '幂等测试节点', '--detail-md', '正文', '--idem', k]);
    expect(r.first.code).toBe(0);
    expect(r.first.out).toContain('已添加');
    expect(r.second.code).toBe(0);                       // 命中不是失败（重试方按成功处理）
    expect(r.second.out).toContain('幂等命中');
    // "没真的再跑一遍"的判据用**盘面事实**：回执只出现一次、盘上只有一个同名节点、日志没有多一条。
    // （不能用 `not.toContain('已添加')` —— 命中的回放**本来就该复述首次那行**"已添加: …"，见下一条 ✓）
    expect((r.second.out.match(/已添加/g) || []).length).toBe((r.first.out.match(/已添加/g) || []).length);
    const same = (readJson(r.p).data.children || []).filter((c) => c.topic === '幂等测试节点');
    expect(same.length).toBe(1);
    expect(r.mid.equals(r.before)).toBe(false);          // 第一遍确实写了盘（否则"不变"是假绿）
    expect(r.after.equals(r.mid)).toBe(true);            // 第二遍**逐字节不动**
    expect(r.p).toBe(projFile(P));
  });

  it('重放时给出的是**首次结果**（含首次那个随机 id），不是新造一个', () => {
    const first = cli(['add', P, 'root', '--topic', '首次结果节点', '--idem', 'k-first']);
    const m = /已添加: (\S+)（父 root）/.exec(first.out);
    expect(first.code).toBe(0);
    expect(m).not.toBeNull();
    const firstId = m[1];
    const afterFirst = readBytes(projFile(P));           // 第一次之后的**盘面快照**
    const second = cli(['add', P, 'root', '--topic', '首次结果节点', '--idem', 'k-first']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('幂等命中');
    expect(second.out).toContain(firstId);               // **首次那个 id** 被复述回来
    expect((second.out.match(/已添加/g) || []).length).toBe(1);   // 只有回放的那一行，没有第二次执行
    expect(readBytes(projFile(P)).equals(afterFirst)).toBe(true); // 数据面**逐字节**没有被第二遍动过
  });

  it('**不同的键 = 不同的一次操作**：键换了就不会短路（但语义去重仍会拦住真重复）', () => {
    // 这两段要一起看：`--idem` 变了 ⇒ 命令**真的执行**（不是复用上一次的结果）；而语义去重
    // 是另一道独立的闸 —— 内容一模一样时它照样拦（两道闸各管一件事，都不许互相顶替）。
    const a = cli(['add', P, 'root', '--topic', '两个键', '--detail-md', '正文甲', '--idem', 'k-a']);
    const b = cli(['add', P, 'root', '--topic', '两个键', '--detail-md', '正文甲', '--idem', 'k-b']);
    expect(a.code).toBe(0);
    expect(b.code).not.toBe(0);                          // 换键**没有**短路 ⇒ 走到了去重闸
    expect(b.out).not.toContain('幂等命中');
    expect(b.out).toContain('已存在同父同题同内容的节点');
    const c = cli(['add', P, 'root', '--topic', '两个键', '--detail-md', '正文乙', '--idem', 'k-c']);
    expect(c.code).toBe(0);                              // 换了内容 ⇒ 是另一次真实的意图
    const ids = (readJson(projFile(P)).data.children || [])
      .filter((x) => x.topic === '两个键').map((x) => x.id);
    expect(ids.length).toBe(2);                          // 只有两次真的落地
  });

  it('键**按项目**各判：同一个键在另一个项目里照常执行（不是全局"用过了"）', () => {
    const a = cli(['add', P, 'root', '--topic', '作用域', '--idem', 'k-scope']);
    const b = cli(['add', P2, 'root', '--topic', '作用域', '--idem', 'k-scope']);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(b.out).toContain('已添加');
    expect(b.out).not.toContain('幂等命中');
  });

  it('--dry-run 不查也不记键（dry-run 不写盘 ⇒ 不算"生效"，不能把后续真跑吞掉）', () => {
    const dry = cli(['apply', P, '--ops-file', opsFile('dry.json', {
      ops: [{ op: 'edit', id: 'k1', topic: 'dry-run 后的标题' }]
    }), '--dry-run', '--idem', 'k-dry']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('没有写盘');
    expect(nodeOf(P, 'k1').topic).toBe('k1');            // 盘上没变
    const real = cli(['apply', P, '--ops-file', opsFile('dry2.json', {
      ops: [{ op: 'edit', id: 'k1', topic: '真跑后的标题' }]
    }), '--idem', 'k-dry']);                             // **同一个键**：若 dry-run 记了键，这里会被跳过
    expect(real.code).toBe(0);
    expect(real.out).not.toContain('幂等命中');
    expect(nodeOf(P, 'k1').topic).toBe('真跑后的标题');
  });
});

/* ============================================================================
 * B. add 语义去重：默认拒绝 + **点名那一条** + --force 放行
 * ========================================================================== */
describe('S7-B add 同父同题同内容 ⇒ 默认拒绝并指出那条', () => {
  it('重放 ⇒ 非 0 退出、指出已存在的 id/路径、盘上**一个节点都没多**', () => {
    const add = () => cli(['add', P, 'k1', '--topic', '去重节点', '--detail-md', '同一段正文']);
    const before = readBytes(projFile(P));
    const first = add();
    expect(first.code).toBe(0);
    const m = /已添加: (\S+)（父 k1）/.exec(first.out);
    expect(m).not.toBeNull();
    const firstId = m[1];
    const mid = readBytes(projFile(P));
    const second = add();                                // **逐字重放**（连 id 都不给 ⇒ 本来会造第二份）
    const after = readBytes(projFile(P));
    expect(second.code).not.toBe(0);
    expect(second.out).toContain('已存在同父同题同内容的节点');
    expect(second.out).toContain(firstId);               // **点名**是那一条
    expect(second.out).toContain('路径');                // 还给出路径（能直接找到它）
    expect(after.equals(mid)).toBe(true);                // 拒绝 = 盘上零改动
    expect(mid.equals(before)).toBe(false);              // 第一次确实写了（否则上面那条无意义）
    expect((nodeOf(P, 'k1').children || []).filter((c) => c.topic === '去重节点').length).toBe(1);
  });

  it('--force 放行有意重复（那是显式意图，不是手滑）', () => {
    const forced = cli(['add', P, 'k1', '--topic', '去重节点', '--detail-md', '同一段正文', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('有意重复');
    expect((nodeOf(P, 'k1').children || []).filter((c) => c.topic === '去重节点').length).toBe(2);
  });

  it('判据是**三项**（父 + 标题 + 内容）：换标题或换内容都照常放行', () => {
    const t = cli(['add', P, 'k1', '--topic', '去重节点-改了标题', '--detail-md', '同一段正文']);
    const d = cli(['add', P, 'k1', '--topic', '去重节点', '--detail-md', '另一段正文']);
    expect(t.code).toBe(0);
    expect(d.code).toBe(0);
    expect(t.out).not.toContain('已存在同父');
    expect(d.out).not.toContain('已存在同父');
  });

  it('连 add-root（顶层主题）也守同一条判据', () => {
    const a = cli(['add-root', P, '--topic', '顶层去重']);
    const b = cli(['add-root', P, '--topic', '顶层去重']);
    expect(a.code).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.out).toContain('已存在同父同题同内容的顶层主题');   // 与 add 同一句判词（同一实现）
  });
});

/* ============================================================================
 * C. apply：一批改动 = 一次事务（一个 rev / 一次原子写 / **一条日志**）
 * ========================================================================== */
describe('S7-C 一次 apply 改 N 条 ⇒ .changes.jsonl 只多 1 条', () => {
  it('3 条 edit 一次做完：日志 +1、rev +1、三条都真的改了', () => {
    const n0 = journal(P).length;
    const r = cli(['apply', P, '--ops-file', opsFile('c1.json', {
      version: 1,
      ops: [
        { op: 'edit', id: 'k1', topic: 'C-改1' },
        { op: 'edit', id: 'k2', topic: 'C-改2' },
        { op: 'edit', id: 'k3', topic: 'C-改3' }
      ]
    })]);
    const j = journal(P);
    expect(r.code).toBe(0);
    expect(r.out).toContain('apply 完成：3 条操作');
    expect(nodeOf(P, 'k1').topic).toBe('C-改1');
    expect(nodeOf(P, 'k2').topic).toBe('C-改2');
    expect(nodeOf(P, 'k3').topic).toBe('C-改3');
    expect(j.length).toBe(n0 + 1);                       // ← **只多 1 条**（不是 3 条）
    expect(j[j.length - 1].writer).toBe('cli:apply');
    expect(j[j.length - 1].changed).toEqual(expect.arrayContaining(['node:k1', 'node:k2', 'node:k3']));
  });

  it('一次 apply 里的 add 产出**可复现**的 id（同一份 ops 重跑得同一份数据形态）', () => {
    const ops = { ops: [{ op: 'add', parent: 'k2', topic: 'repro node', detailMd: '正文' }] };
    const r = cli(['apply', P, '--ops-file', opsFile('c2.json', ops), '--idem', 'k-repro']);
    expect(r.code).toBe(0);
    const kid = (nodeOf(P, 'k2').children || []).find((c) => c.topic === 'repro node');
    expect(kid).toBeTruthy();
    // 确定性 id（不是"时间戳 + 随机"）：`(标题, 本条 op 序号)` 决定 ⇒ 同一份 ops 永远同一个 id。
    // 这正是"重跑同一份 ops 得同一份数据"的前提（时间/随机会让每次重跑都是另一份数据 ✗）。
    expect(kid.id).toBe('repro-node-1');
    const again = cli(['apply', P, '--ops-file', opsFile('c2.json', ops), '--idem', 'k-repro']);
    expect(again.out).toContain('幂等命中');             // 同键 ⇒ 不重复执行
  });

  it('--dry-run 连 mutate 都不进：盘上逐字节不变、日志也不多一条', () => {
    const before = readBytes(projFile(P));
    const n0 = journal(P).length;
    const r = cli(['apply', P, '--ops-file', opsFile('c3.json', {
      ops: [{ op: 'edit', id: 'k1', topic: 'dry 不该落盘' }]
    }), '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--dry-run');
    expect(readBytes(projFile(P)).equals(before)).toBe(true);
    expect(journal(P).length).toBe(n0);
  });
});

/* ============================================================================
 * D. 注入证明：中途第 k 条非法 ⇒ 整体不动 + 点名第 k 条
 * ========================================================================== */
describe('S7-D 第 k 条非法 ⇒ 全成或全不动（注入证明）', () => {
  it('第 3 条引用不存在的节点 ⇒ 盘上逐字节不变 + 点名「第 4 条」', () => {
    const before = readBytes(projFile(P));
    const n0 = journal(P).length;
    const r = cli(['apply', P, '--ops-file', opsFile('d1.json', {
      version: 1,
      ops: [
        { op: 'edit', id: 'k1', topic: '不该生效-1' },
        { op: 'edit', id: 'k2', topic: '不该生效-2' },
        { op: 'edit', id: 'k3', topic: '不该生效-3' },
        { op: 'edit', id: 'no-such-node-xyz', topic: '第4条非法' }   // ← 人为造的第 4 条
      ]
    })]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('第 4 条操作');              // **指名第 k 条**
    expect(r.out).toContain('no-such-node-xyz');
    expect(r.out).toContain('整体未执行');
    expect(readBytes(projFile(P)).equals(before)).toBe(true);   // 前 3 条**一条都没落**
    expect(nodeOf(P, 'k1').topic).not.toBe('不该生效-1');
    expect(nodeOf(P, 'k2').topic).not.toBe('不该生效-2');
    expect(nodeOf(P, 'k3').topic).not.toBe('不该生效-3');
    expect(journal(P).length).toBe(n0);                  // 连一条"部分成功"的日志都没有
  });

  it('执行期才看得出的非法（移动到自己子树）同样整体不动', () => {
    const before = readBytes(projFile(P));
    const r = cli(['apply', P, '--ops-file', opsFile('d2.json', {
      ops: [
        { op: 'edit', id: 'k1', topic: '会被回滚' },
        { op: 'move', id: 'k1', parent: 'k1' }           // 移到自身 ⇒ tree.moveNode 返回 false
      ]
    })]);
    expect(r.code).not.toBe(0);
    expect(readBytes(projFile(P)).equals(before)).toBe(true);
    expect(nodeOf(P, 'k1').topic).not.toBe('会被回滚');
  });

  it('非法 op / 缺 op 字段 / 空 ops：都响亮拒绝并指出第几条，且零改动', () => {
    const before = readBytes(projFile(P));
    const cases = [
      [{ ops: [{ op: 'edit', id: 'k1', topic: 'x' }, { op: 'remove-lookalike', id: 'k1' }] }, '第 2 条操作'],
      [{ ops: [{ op: 'edit', id: 'k1', topic: 'x' }, { id: 'k1', topic: 'y' }] }, '第 2 条操作'],
      [{ ops: [] }, 'ops 是空的'],
      ['{ 不是 JSON', '不是合法 JSON']
    ];
    cases.forEach(([raw, needle]) => {
      const r = cli(['apply', P, '--ops-file', opsFile('d3-' + Math.random().toString(36).slice(2) + '.json', raw)]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(needle);
      expect(readBytes(projFile(P)).equals(before)).toBe(true);
    });
  });

  it('需要外部副作用 / 连带清理的 op 一律**不在**事务里（removed 的两条要点名指出去处）', () => {
    const r = cli(['apply', P, '--ops-file', opsFile('d4.json', {
      ops: [{ op: 'remove', id: 'k1' }]
    })]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('不认识的 op');
    expect(r.out).toContain('remove');                   // 点名可用命令
    expect(nodeOf(P, 'k1')).toBeTruthy();                // 没被删
  });
});

/* ============================================================================
 * E. 键落进日志的**可选字段**：idem（不升 formatVersion）
 * ========================================================================== */
describe('S7-E 幂等键的落点：.changes.jsonl 的可选字段 idem', () => {
  it('给了键 ⇒ 那条记录带 idem；不给 ⇒ 字段缺席（老写入路径落盘字节不变）', () => {
    cli(['edit', P, 'k2', '--topic', 'E-不带键']);
    const noKey = journal(P)[journal(P).length - 1];
    expect(noKey.idem).toBeUndefined();
    expect('idem' in noKey).toBe(false);

    cli(['edit', P, 'k2', '--topic', 'E-带键', '--idem', 'k-journal']);
    const withKey = journal(P)[journal(P).length - 1];
    expect(withKey.idem).toBe('k-journal');
    expect(withKey.out).toContain('已更新');             // 首次回显也记下了（重放要靠它复述）
  });

  it('键是**旁路产物**：项目 JSON 不变、formatVersion 不升、条目版本号还是 1', () => {
    const d = readJson(projFile(P));
    expect(d.meta.formatVersion).toBe(2);                // 数据格式一个字没动
    const e = journal(P).find((x) => x.idem === 'k-journal');
    expect(e.v).toBe(1);                                 // ENTRY_VERSION 没升（可选字段的先例：origin）
    // 键**不在**项目数据里（在项目 JSON 全文里搜不到这个键）
    expect(readText(projFile(P)).includes('k-journal')).toBe(false);
  });

  it('同一个键换个命令 ⇒ 响亮拒绝（假命中比报错危险得多）', () => {
    // ⚠️ 这里必须换一个**真的会走守卫的命令**（`move`，不是另一个 `edit`）—— 键的作用域是
    //    「项目 × 命令」，所以同命令同键本来就该命中（那是正常重放，不是冲突）。
    const r = cli(['move', P, 'k1', 'k2', '--idem', 'k-journal']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('已经用在命令');
    expect(r.out).toContain('edit');                     // 点名首次那个命令
    const k1 = nodeOf(P, 'k1');
    expect(k1).toBeTruthy();                             // 没有真的被移走
    expect((nodeOf(P, 'k2').children || []).some((c) => c.id === 'k1')).toBe(false);
  });

  it('只读命令带 --idem ⇒ 响亮拒绝（别让 AI 以为"带了键就重试安全"）', () => {
    const r = cli(['read', P, '--idem', 'k-read']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--idem 只对');
    // 合法的只读调用照旧（守门只针对这个选项）
    expect(cli(['read', P]).code).toBe(0);
  });

  it('裸写 --idem（没有键）⇒ 响亮拒绝，不当成 true', () => {
    const r = cli(['edit', P, 'k2', '--topic', '裸键', '--idem']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--idem 需要一个');
  });
});

/* ============================================================================
 * F. assoc-add 同款语义去重
 * ========================================================================== */
describe('S7-F assoc-add 语义去重（成员集合 + 标题 + 正文）', () => {
  it('同成员同标题重放 ⇒ 默认拒绝并点名那篇；成员换顺序算**同一篇**', () => {
    const before = readBytes(projFile(P));
    const a = cli(['assoc-add', P, '--members', 'k1,k2', '--title', '同款关联', '--note-md', '同一段笔记']);
    expect(a.code).toBe(0);
    const m = /已新增关联 (\S+)：/.exec(a.out);
    expect(m).not.toBeNull();
    const firstId = m[1];
    const mid = readBytes(projFile(P));
    const b = cli(['assoc-add', P, '--members', 'k2,k1', '--title', '同款关联', '--note-md', '同一段笔记']);
    const after = readBytes(projFile(P));
    expect(b.code).not.toBe(0);
    expect(b.out).toContain('已存在成员/标题/正文完全相同的关联笔记');
    expect(b.out).toContain(firstId);
    expect(after.equals(mid)).toBe(true);                // 零改动
    expect(mid.equals(before)).toBe(false);              // 第一次确实写了
    expect((readJson(projFile(P)).assoc || []).filter((x) => x.title === '同款关联').length).toBe(1);
  });

  it('--force 放行；换个标题就照常新增', () => {
    const forced = cli(['assoc-add', P, '--members', 'k1,k2', '--title', '同款关联', '--note-md', '同一段笔记', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('有意重复');
    const other = cli(['assoc-add', P, '--members', 'k1,k2', '--title', '另一个标题', '--note-md', '同一段笔记']);
    expect(other.code).toBe(0);
    expect(other.out).not.toContain('已存在');
  });
});

/* ============================================================================
 * G. 守卫自身有效（防止"绿得没意义"）
 * ========================================================================== */
describe('S7-G 守卫自检', () => {
  it('apply 已登记在 registry 里（否则本文件的 apply 断言全是假绿）', () => {
    expect(registry.get('apply')).toBeTruthy();
    // ⚠️ `--idem` 是**横切开关键**（`core.GLOBAL_OPTIONS`，与 `--json` 同待遇）⇒ 它**不在**任何命令的
    //    `options` 里也能用；`apply` 自己必须声明的是 opsFile / dryRun。
    expect(registry.allowedOptions('apply')).toEqual(expect.arrayContaining(['opsFile', 'dryRun']));
  });

  it('横切开关键：--idem 在写命令上被放行、在只读命令上被响亮拒绝（且不靠各命令手写声明）', () => {
    const core = require('../cli/core.js');
    expect(core.GLOBAL_OPTIONS).toContain('idem');
    expect(core.unknownOptions(['--idem', 'k'], ['topic'])).toEqual([]);        // 放行：不再报未知选项
    expect(core.unknownOptions(['--bogus', 'x'], ['topic'])).toHaveLength(1);   // 其他未知选项照旧判红
  });

  it('cli/core.js 的写命令清单与 registry 里的命令名一一对得上（防手写清单漂移）', async () => {
    const core = require('../cli/core.js');
    const names = new Set(registry.list().map((c) => c.name));
    const missing = core.WRITE_COMMANDS.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  it('沙箱真的生效：写命令落在临时目录，**没有**碰到工程里的 projects/', async () => {
    const projectDir = path.resolve(require('../cli/core.js').PROJECTS_DIR);
    expect(projectDir).toBe(path.resolve(SANDBOX));
    expect(projectDir).not.toContain(path.join('ai-mind-map', 'projects'));
  });
});
