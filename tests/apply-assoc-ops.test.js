/* ============================================================
 * tests/apply-assoc-ops.test.js — `apply` 的 **assoc-\* 两种 op** 端到端
 * 运行：npx vitest run tests/apply-assoc-ops.test.js
 * ------------------------------------------------------------
 * ## 为什么单开这个文件（本工程最贵的一课：**没有断言的路 = 不存在**）
 * `apply --ops-file` 的 op 表里，`add` / `edit` / `move` / `clone` 都有断言（W8 那批），
 * 而 **`assoc-add` / `assoc-edit` 两种 op 零覆盖**。后果不是"少测了"，是**两条真缺陷活到 HEAD**：
 *
 *   ① 预检调 `nodeExistsIn` —— 那是 `cli/commands/assoc.js` 里的函数，**没有导出**，
 *      `cli/commands/edit.js` 也没有定义 ⇒ 一跑到第 1 条 assoc-* op 就 `ReferenceError`。
 *      实测报文（**修前**，真跑 `node cli/mm-cli.js apply comnet --ops-file <含 assoc-add>`）：
 *        `error: ops 文件里第 1 条操作（assoc-add）：nodeExistsIn is not defined（…）——**整体未执行**，盘上零改动。`（exit 1）
 *      同族的第二个名字是 `assocKeyOf`（只在 `assoc-add` 那条 op 的**执行期**才走到 ⇒ 被前一个挡住、更隐蔽）。
 *   ② 更贵的一条：**回执说成功、盘上没写**。`assoc` 是项目 JSON 的**顶层**集合（与 `data` 平级），
 *      而 `apply` 从前只把 `work.data` 搬回原对象 ⇒ 两种 assoc-* op 的改动被**整份丢掉**，
 *      而 stdout 照旧打印「已应用 assoc-add：新增关联 …」、exit 0。调用方看到的是成功，
 *      拿到的是一件没生效的事 —— 比报错贵得多（它不会被重试）。
 *
 * 所以本文件不满足于"exit 0"，它是**两个方向**都钉：
 *   · 正路：`assoc-add` / `assoc-edit`（含**跨项目成员**那条分支）dry-run 与真跑都成功，
 *     并且**读回来**（`assoc-list --json`）确认真的落盘了 —— 「回执说已应用 ⇒ 盘上必须真的变了」
 *     是本文件贯穿的一条通则（E 组把它推广到**每一个** op）。
 *   · 反路：成员 id 不存在 ⇒ **必须被拒**且**点名那个 id**（不是静默跳过、不是内部错误）。
 *
 * ## 环境要点（与 tests/w8-dry-run.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 端到端一律**进程内** `invokeSync`（不起子进程 —— 受限环境下管道 stdio 会 EPERM 假失败）；
 *   3) 真实 `projects/` **只读**：夹具全在 `SANDBOX`（临时目录）里，`afterAll` 删干净；
 *   4) 关掉访问埋点（`heatSensor.__setEnabledForTest(false)`）：本文件量的是项目目录的字节，
 *      不留任何旁路写入来源；
 *   5) ops 文件写在**沙箱之外**的另一个临时目录（`OPSDIR`）—— 否则"写 ops 文件"这一步
 *      自己就会改沙箱里的字节，把"零写入"那几条断言搅成假红。
 *
 * ## 断言纪律
 *   · **不写死任何计数**：条数/个数一律从夹具与 ops 对象**现算**（`fixture.assoc.length` 这种），
 *     不出现"应该是 2 条"这类常量；
 *   · **op 清单也是现算的**（E1）：从"不认识的 op"那句拒绝报文里解析出允许集
 *     （`OPS` 表没有导出，报文是它唯一的对外投影）⇒ 将来加一个 op 而没加对应断言，
 *     本文件会**自己红**并要求补一行（覆盖度不会悄悄漏）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/* ---- ① 临时沙箱（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-apply-assoc-'));
const OPSDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-apply-assoc-ops-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const heatSensor = require('../src/heat-sensor.js');

heatSensor.__setEnabledForTest(false);

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterAll(() => {
  [SANDBOX, OPSDIR].forEach((d) => {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 删不掉不影响判定 */ }
  });
});

/* ============================================================================
 * 夹具：三个项目
 * ==========================================================================
 * 直接写 JSON（不经命令）⇒ 每个用例都把夹具**重置到已知状态**，与执行顺序无关。
 *   · PROJ  主体项目：三个节点 + **一条既有**关联（`assoc-edit` 要有东西可改）；
 *   · OTHER 跨项目成员的落点（`assoc-edit` 的跨项目分支是唯一走盘上判定的那一条）；
 *   · EMPTY 没有 `assoc` 键的项目 —— `assoc-list --json` 的**负例**（"没有关联"不是错误）。
 * ========================================================================== */
const PROJ = 'apply-assoc-src';
const OTHER = 'apply-assoc-other';
const EMPTY = 'apply-assoc-empty';

const BASE_ASSOC = {
  id: 'a-seed',
  title: '既有关联',
  members: [{ project: PROJ, id: 'n-a' }, { project: PROJ, id: 'n-b' }]
};

const projDir = (name) => path.join(SANDBOX, name);
const projFile = (name) => path.join(projDir(name), name + '.json');

function writeProject(name, obj) {
  fs.mkdirSync(projDir(name), { recursive: true });
  fs.writeFileSync(projFile(name), JSON.stringify(obj, null, 2), 'utf8');
}

/** 主体项目的夹具（返回对象 ⇒ 用例可以就着它**现算**期望值） */
function projFixture() {
  return {
    meta: { name: 'Apply-assoc 主体', author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: {
      id: 'root', topic: 'Apply-assoc 主体', expanded: true,
      children: [
        { id: 'n-a', topic: '甲', expanded: true, children: [] },
        { id: 'n-b', topic: '乙', expanded: true, children: [] },
        { id: 'n-c', topic: '丙', expanded: true, children: [] }
      ]
    },
    assoc: [JSON.parse(JSON.stringify(BASE_ASSOC))]
  };
}
function otherFixture() {
  return {
    meta: { name: 'Apply-assoc 邻项目', author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'Apply-assoc 邻项目', expanded: true,
      children: [{ id: 'o-1', topic: '邻一', expanded: true, children: [] }] }
  };
}
function emptyFixture() {
  return {
    meta: { name: 'Apply-assoc 空项目', author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'Apply-assoc 空项目', expanded: true, children: [] }
  };
}
function resetFixtures() {
  [PROJ, OTHER, EMPTY].forEach((n) => fs.rmSync(projDir(n), { recursive: true, force: true }));
  fs.rmSync(path.join(SANDBOX, '.visits'), { recursive: true, force: true });
  writeProject(PROJ, projFixture());
  writeProject(OTHER, otherFixture());
  writeProject(EMPTY, emptyFixture());
}
resetFixtures();

/* ---------------- 断言小工具 ---------------- */

/** 跑一条命令（进程内同步）：`{ code, out }`（stdout+stderr 合并，与集成脚本同口径） */
function run(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}

/** 把一份 ops 写进**沙箱之外**的临时目录，返回路径（`--ops-file` 要的是文件路径） */
let opsSeq = 0;
function opsFile(ops) {
  const f = path.join(OPSDIR, 'ops-' + (++opsSeq) + '.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, ops: ops }, null, 2), 'utf8');
  return f;
}

/** 整棵沙箱目录树的快照（相对路径 + 字节数 + sha256）—— "盘上零变化"的量具 */
function snapAll() {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); return; }
      const buf = fs.readFileSync(abs);
      out.push(path.relative(SANDBOX, abs).split(path.sep).join('/')
        + '|' + buf.length + '|' + require('node:crypto').createHash('sha256').update(buf).digest('hex'));
    });
  };
  walk(SANDBOX);
  return out.join('\n');
}

/** 读回盘上的项目对象（真值，不经任何命令） */
const readProj = (name) => JSON.parse(fs.readFileSync(projFile(name), 'utf8'));
/** 盘上的 assoc 集合（没有该键 ⇒ 空数组；**不**把 undefined 当"0 条"以外的意思） */
const assocOnDisk = (name) => {
  const o = readProj(name);
  return Array.isArray(o.assoc) ? o.assoc : [];
};

/** `assoc-list --json` 的命令面读数（解析失败 ⇒ 由调用方断言，这里如实抛出） */
function assocListJson(name, extra) {
  const r = run(['assoc-list', name, '--json'].concat(extra || []));
  return { code: r.code, out: r.out, json: r.code === 0 ? JSON.parse(r.out) : null };
}

/* ============================================================================
 * A 正路：assoc-add / assoc-edit 两种 op —— dry-run 与真跑都要成功，且**真的落盘**
 * ========================================================================== */
describe('A 正路：apply 的 assoc-add / assoc-edit 两种 op', () => {
  it('A1 `assoc-add` op：dry-run 先成功且盘上零变化，真跑成功且关联**真的在盘上**（`assoc-list --json` 读回来对数）', () => {
    resetFixtures();
    const title = '批新增的关联';
    const newId = 'a-op-add';
    const members = 'n-a,n-c';                       // 两个都真实存在 ⇒ 这条 op 合法
    const addOps = [{ op: 'assoc-add', members: members, title: title, id: newId }];
    const f = opsFile(addOps);

    // ---- dry-run：报告说得出"将要新增关联 …"，而盘上一个字节都没动 ----
    const before = snapAll();
    const dry = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
    expect(dry.code, 'dry-run 必须成功（修前这里是 exit 1 且报 `nodeExistsIn is not defined`）：' + dry.out).toBe(0);
    expect(dry.out).toContain(newId);
    expect(snapAll(), 'dry-run 之后盘上必须逐字节零变化').toBe(before);
    expect(assocOnDisk(PROJ).length, 'dry-run 不许把关联写进去').toBe(projFixture().assoc.length);

    // ---- 真跑：exit 0 + 关联真的落盘（这条断言就是"回执说已应用 ⇒ 盘上必须真的变了"）----
    const real = run(['apply', PROJ, '--ops-file', f]);
    expect(real.code, '真跑必须成功：' + real.out).toBe(0);
    expect(real.out).toContain('已应用 assoc-add');

    const disk = assocOnDisk(PROJ);
    const seed = projFixture().assoc.length;
    expect(disk.length, '真跑之后盘上的关联条数必须是"既有 + 本次 assoc-add op 数"（两边都现算）')
      .toBe(seed + addOps.length);
    const added = disk.filter((a) => a.id === newId)[0];
    expect(added, '新增的那一条必须能在盘上按 id 找到').toBeTruthy();
    expect(added.title).toBe(title);
    expect(added.members.length, '成员个数必须与 ops 里声明的一致（现算）').toBe(members.split(',').length);

    // ---- 命令面读回来对同一份真值（不是只看落盘 JSON 的形状）----
    const l = assocListJson(PROJ);
    expect(l.code, 'assoc-list --json 必须 exit 0：' + l.out).toBe(0);
    expect(l.json.count, '`count` 与 `items` 必须自洽').toBe(l.json.items.length);
    expect(l.json.count, '命令面看到的条数 = 盘上的条数').toBe(disk.length);
    expect(l.json.items.map((it) => it.id)).toContain(newId);
  });

  it('A2 `assoc-edit` op（本项目成员）：改后的标题与成员**都在盘上**（读回来逐字比对 ops 里写的）', () => {
    resetFixtures();
    const newTitle = '改过的标题（A2）';
    const members = 'n-a,n-c,n-b';
    const f = opsFile([{ op: 'assoc-edit', id: BASE_ASSOC.id, title: newTitle, members: members }]);

    const before = snapAll();
    const dry = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
    expect(dry.code, dry.out).toBe(0);
    expect(snapAll(), 'dry-run 之后盘上必须逐字节零变化').toBe(before);

    const real = run(['apply', PROJ, '--ops-file', f]);
    expect(real.code, real.out).toBe(0);
    const disk = assocOnDisk(PROJ).filter((a) => a.id === BASE_ASSOC.id)[0];
    expect(disk, '被改的那条关联必须还在（改成员不是删了重建）').toBeTruthy();
    expect(disk.title).toBe(newTitle);
    expect(disk.members.length, '成员个数必须按 ops 现算').toBe(members.split(',').length);

    const l = assocListJson(PROJ);
    expect(l.code, l.out).toBe(0);
    const seen = l.json.items.filter((it) => it.id === BASE_ASSOC.id)[0];
    expect(seen.title, '命令面读到的标题必须与 ops 里写的一致').toBe(newTitle);
  });

  it('A3 `assoc-edit` op（**跨项目成员**）：走盘上存在性判定的那一条分支（修前正是它报 `nodeExistsIn is not defined`）', () => {
    resetFixtures();
    const newTitle = '跨项目成员的关联';
    const f = opsFile([{ op: 'assoc-edit', id: BASE_ASSOC.id, title: newTitle,
      members: 'n-a,' + OTHER + '/o-1' }]);

    const before = snapAll();
    const dry = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
    expect(dry.code, '跨项目成员这一支修前必红（nodeExistsIn is not defined）：' + dry.out).toBe(0);
    expect(snapAll(), 'dry-run 之后盘上必须逐字节零变化').toBe(before);

    const real = run(['apply', PROJ, '--ops-file', f]);
    expect(real.code, real.out).toBe(0);
    const disk = assocOnDisk(PROJ).filter((a) => a.id === BASE_ASSOC.id)[0];
    expect(disk.title).toBe(newTitle);
    const cross = disk.members.filter((m) => m.project === OTHER)[0];
    expect(cross, '跨项目成员必须按 ops 写的那样落盘（项目名 + 节点 id 都不许被改写）').toBeTruthy();
    expect(cross.id).toBe('o-1');
  });

  it('A4 同一批里**前后引用**：第 1 条 assoc-add 建的 id 由第 2 条 assoc-edit 改（一个事务里两条都成）', () => {
    resetFixtures();
    const chainId = 'a-op-chain';
    const chainOps = [
      { op: 'assoc-add', members: 'n-b,n-c', title: '链上第一篇', id: chainId },
      { op: 'assoc-edit', id: chainId, title: '链上第一篇（改过）' }
    ];
    const f = opsFile(chainOps);
    const real = run(['apply', PROJ, '--ops-file', f]);
    expect(real.code, real.out).toBe(0);
    const disk = assocOnDisk(PROJ).filter((a) => a.id === chainId)[0];
    expect(disk, '批内前一条 op 建的关联必须真的在盘上').toBeTruthy();
    expect(disk.title, '后一条 op 的改动必须落在同一条上（不是新建第二条）').toBe('链上第一篇（改过）');
    // 「同 id 不许重复」的期望条数也现算：本次 ops 里建这个 id 的 assoc-add 有几条，盘上就该有几条
    const chainAdds = chainOps.filter((o) => o.op === 'assoc-add' && o.id === chainId).length;
    expect(assocOnDisk(PROJ).filter((a) => a.id === chainId).length, '同 id 不许重复').toBe(chainAdds);
  });
});

/* ============================================================================
 * B 反路：`nodeExistsIn` 存在的意义 —— 成员 id 不存在 ⇒ 必须被拒 + 点名那个 id
 * ==========================================================================
 * 三条都要，缺一不可：
 *   ① **被拒**（exit ≠ 0）—— 不许"静默跳过这条 op、别的照做"（那会让 ops 的语义变成玄学）；
 *   ② **报文点名那个 id**（含项目名）—— 调用方要能一眼看出是哪一条错了；
 *   ③ **不是内部错误**（`is not defined` / `TypeError` 这类）—— 那是缺陷的形态，不是数据的结论；
 *   ④ 整份 ops **零执行**（盘上逐字节不变，含没有部分生效）。
 * ========================================================================== */
describe('B 反路：成员不存在 ⇒ 被拒并点名（不是静默跳过、也不是内部错误）', () => {
  /** 一条反路用例：ops ⇒ 断言上列四条 */
  function expectRefused(ops, mustMention) {
    resetFixtures();
    const f = opsFile(ops);
    const before = snapAll();
    const r = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
    expect(r.code, '成员不存在必须被拒（exit ≠ 0）：' + r.out).not.toBe(0);
    mustMention.forEach((s) => {
      expect(r.out, '报文必须点名 ' + s + '：' + r.out).toContain(s);
    });
    // ③ 不是内部错误：缺陷形态与数据结论必须可分辨
    ['is not defined', 'TypeError', 'undefined is not'].forEach((bad) => {
      expect(r.out.indexOf(bad), '不许把内部错误当成"数据不合法"报出来（收到 ' + bad + '）：' + r.out).toBe(-1);
    });
    // ④ 整体未执行：dry-run 与真跑都不许动盘
    const real = run(['apply', PROJ, '--ops-file', f]);
    expect(real.code, '真跑同样必须被拒：' + real.out).not.toBe(0);
    expect(snapAll(), '被拒的 ops 必须零执行（盘上逐字节不变）').toBe(before);
    expect(assocOnDisk(PROJ).length, '被拒之后关联条数不许变（现算）').toBe(projFixture().assoc.length);
  }

  it('B1 本项目里不存在的成员 id ⇒ 拒绝并点名「本项目/那个 id」', () => {
    expectRefused([{ op: 'assoc-add', members: 'n-a,n-gone', title: '缺成员的关联', id: 'a-op-bad' }],
      ['n-gone', PROJ]);
  });

  it('B2 跨项目里不存在的成员 id（assoc-edit 的跨项目分支）⇒ 同样拒绝并点名', () => {
    expectRefused([{ op: 'assoc-edit', id: BASE_ASSOC.id,
      members: 'n-a,' + OTHER + '/o-gone' }], ['o-gone', OTHER]);
  });

  it('B3 成员所在**项目**就不存在 ⇒ 报文说的是"项目不存在"，不是含糊的"成员不存在"', () => {
    resetFixtures();
    const f = opsFile([{ op: 'assoc-add', members: 'n-a,nope-proj/x-1', title: 'x', id: 'a-op-bad2' }]);
    const r = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain('nope-proj');
    expect(r.out).toContain('项目不存在');
  });
});

/* ============================================================================
 * C `assoc-list --json`：只读命令的出口契约（exit 0 + 一份可解析 JSON）
 * ==========================================================================
 * 有读者报告这条命令"输出到 `"node": null` 就中断、exit 非 0"。在**同一份数据**上
 * （真实 `projects/comnet`，只读跑）复核：exit 0、完整可解析 —— 那是**观察侧**的现象，
 * 不是这条命令的缺陷。既然"读命令不许半途而废"这句话没有断言守着，就在这里钉住：
 * 正例（有关联）与**负例**（没有 `assoc` 键的项目）都必须 exit 0 且 JSON 可解析。
 * ========================================================================== */
describe('C `assoc-list --json`：exit 0 + 一份可解析 JSON（正例与负例都要）', () => {
  it('C1 有关联的项目：JSON 可解析，`count` 与 `items` 自洽且等于盘上的条数（现算）', () => {
    resetFixtures();
    const disk = assocOnDisk(PROJ);
    const l = assocListJson(PROJ);
    expect(l.code, 'assoc-list --json 必须 exit 0：' + l.out).toBe(0);
    expect(l.json.project).toBe(PROJ);
    expect(l.json.count, '`count` 与 `items` 必须自洽').toBe(l.json.items.length);
    expect(l.json.count, '命令面读数 = 盘上真值').toBe(disk.length);
    l.json.items.forEach((it) => {
      expect(typeof it.id).toBe('string');
      expect(Array.isArray(it.members)).toBe(true);
    });
  });

  it('C2 负例：**没有 `assoc` 键**的项目 ⇒ 照旧 exit 0 且 JSON 可解析（"没有关联"是事实，不是错误）', () => {
    resetFixtures();
    const disk = assocOnDisk(EMPTY);                      // 夹具里就没有 assoc ⇒ 现算（不写字面量）
    expect(disk.length, '夹具自证：这个项目确实一条关联都没有').toBe((emptyFixture().assoc || []).length);
    const l = assocListJson(EMPTY);
    expect(l.code, '空关联项目必须 exit 0（不许把"没有"当错误）：' + l.out).toBe(0);
    expect(l.json.count, '`count` 与 `items` 必须自洽').toBe(l.json.items.length);
    expect(l.json.count, '命令面读数 = 盘上真值').toBe(disk.length);
  });

  it('C3 `--raw` 档同样 exit 0、可解析，且 `raw` 与视图条目**一一对应**（同一条命令的两半不许漂）', () => {
    resetFixtures();
    const l = assocListJson(PROJ, ['--raw']);
    expect(l.code, l.out).toBe(0);
    expect(Array.isArray(l.json.raw), '--raw 必须给出原始实体数组').toBe(true);
    expect(l.json.raw.length, '`raw` 与 `items` 必须条数相同（现算）').toBe(l.json.items.length);
    expect(l.json.raw.map((a) => a.id), '两条出口必须指的是同一批实体').toEqual(l.json.items.map((it) => it.id));
  });
});

/* ============================================================================
 * D 结构断言：共享实现**只有一份**（防"修好这一处、别处又抄一份"）
 * ==========================================================================
 * 本文件修的是"函数体存在、调用点存在、但两者之间**没有连线**"这类缺陷。
 * 最省事的假修法是：在 `edit.js` 里把函数体**复制一份** ⇒ 当下全绿，然后两份必然漂。
 * 所以这里把"只许有一份实现 + 调用方必须 require 那一份"变成**机械可查**的：
 *
 * ⚠️ 扫描面**如实声明**（这条断言的边界，别当成"全仓已覆盖"）：
 *   · 只看 `cli/**` 与 `src/**` 下的 `.js`（**不含** `tests/` —— 本文件自己就在 tests/ 里，
 *     它必然要提到这两个名字；把自己算进去是**自指**，会永远假红）；
 *   · 只看**代码**：先剥块注释 / 行注释，再剥字符串与模板串（否则注释里的一句说明
 *     "从前叫 nodeExistsIn" 就会被当成第二份实现 —— 实测过这种假红）；
 *   · 被搜的字面量**由拼接构造**（`'function ' + 'nodeExists' + 'In'`）—— 免得本文件
 *     自己的源码成为命中源（双保险：扫描面已排除 tests/，这里再加一道）。
 * ========================================================================== */
describe('D 结构断言：实现只有一份，且调用方是 require 来的', () => {
  /** 剥注释（保留字符串）+ 可选再剥字符串/模板（保留换行以保行号）
   *  ⚠️ 两档**必须分开**（实测踩到过）：查"定义形态"要剥字符串（免得一句散文被当成实现），
   *     而查 `require('./assoc.js')` 这种**路径字面量**恰恰要**留着字符串**
   *     （与 `scripts/dep-direction-check.js` 的 stripComments 同一条理由：读的是字面量）。 */
  function strip(src, keepStrings) {
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
        if (c === "'" || c === '"' || c === '`') {
          state = c === "'" ? 'sq' : (c === '"' ? 'dq' : 'tpl');
          out += keepStrings ? c : ' '; i++; continue;
        }
        out += c; i++; continue;
      }
      if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
      if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; } if (c === '\n') out += c; i++; continue; }
      // 字符串内部
      if (c === '\\') { if (c === '\n') out += '\n'; if (keepStrings) out += c + (c2 === undefined ? '' : c2); i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code'; out += keepStrings ? c : ' '; i++; continue;
      }
      if (keepStrings) out += c; else if (c === '\n') out += c;
      i++;
    }
    return out;
  }
  /** 只剥注释（留着字符串）：查路径字面量用它 */
  const stripComments = (src) => strip(src, true);
  /** 剥注释 + 剥字符串：查裸标识符用它 */
  const stripNonCode = (src) => strip(src, false);
  /** 扫描面：cli/** 与 src/** 的 .js（声明见上面的注释） */
  function scanFiles() {
    const out = [];
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      fs.readdirSync(abs, { withFileTypes: true }).forEach((e) => {
        const r = rel + '/' + e.name;
        if (e.isDirectory()) { walk(r); return; }
        if (e.name.endsWith('.js')) out.push(r);
      });
    };
    ['cli', 'src'].forEach(walk);
    return out.sort();
  }
  /** 哪些文件里出现了"定义形态"（`function <名字>` 或 `const <名字> =`） */
  const definersOf = (name) => {
    const asFunction = 'function ' + name;                     // 拼接构造，别在本文件里写死整串
    const asConst = 'const ' + name;
    return scanFiles().filter((rel) => {
      const code = stripNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      return code.indexOf(asFunction) >= 0 || code.indexOf(asConst) >= 0;
    });
  };

  it('D1 「成员是否存在」这个判定只有一份实现（cli/commands/assoc.js），别处不许抄第二份', () => {
    const name = 'nodeExists' + 'In';                          // 拼接：本文件源码不成为命中源
    const definers = definersOf(name);
    expect(definers, '实现必须恰好一处（多处 = 有副本，迟早与正本漂）').toEqual(['cli/commands/assoc.js']);
  });

  it('D2 「同一篇关联」的指纹只有一份实现（cli/commands/assoc.js），别处不许抄第二份', () => {
    const name = 'assocKey' + 'Of';
    expect(definersOf(name), '指纹的口径只许有一份').toEqual(['cli/commands/assoc.js']);
  });

  it('D3 调用方（`apply` 的 op 表）必须是**正规 require** 那一份：edit.js 里有 `require(\'./assoc.js\')`，且调用点带模块前缀', () => {
    // 查 require 的路径字面量 ⇒ 这边**留着字符串**（只剥注释），否则字面量本身会被剥掉（实测踩到过）
    const withStrings = stripComments(fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'edit.js'), 'utf8'));
    const code = stripNonCode(fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'edit.js'), 'utf8'));
    expect(withStrings.indexOf("require('./assoc.js')"), 'edit.js 必须 require 同目录的 assoc.js（共享那一份实现）').toBeGreaterThan(-1);
    // 调用点必须经模块前缀（裸名字就是"又一处未定义的引用"—— 本文件修的就是这个）
    const bare = name => new RegExp('(^|[^\\w$.])' + name + '\\s*\\(');
    expect(bare('nodeExists' + 'In').test(code), 'edit.js 里不许出现**裸**调用（裸名字 = 未定义引用）').toBe(false);
    expect(bare('assocKey' + 'Of').test(code), 'edit.js 里不许出现**裸**调用').toBe(false);
    expect(code.indexOf('.nodeExists' + 'In('), '至少要有一处经模块前缀的真实调用').toBeGreaterThan(-1);
    expect(code.indexOf('.assocKey' + 'Of('), '至少要有一处经模块前缀的真实调用').toBeGreaterThan(-1);
  });
});

/* ============================================================================
 * E 一网打尽：**每一个** op 都要满足"回执说已应用 ⇒ 盘上必须真的变了"
 * ==========================================================================
 * 这是本文件发现第二条缺陷的那条通则（它当时就藏在这里）。两种错都能被它抓住：
 *   · op 半途 ReferenceError（预检/执行期未定义符号）⇒ exit ≠ 0 或报文含内部错误；
 *   · op 悄悄改在一个**不会被写回的**对象上（assoc 那次）⇒ exit 0、回执照旧说"已应用"、
 *     而盘上一个字节都没变。
 * op 清单**现算**：`OPS` 表没有导出，但"不认识的 op"那句拒绝报文是它的对外投影 ⇒ 解析它。
 * 新加一个 op 而这里没加对应 payload ⇒ E1 自己红（覆盖度不会悄悄漏）。
 * ========================================================================== */
describe('E 一网打尽：每个 op 的「回执=事实」通则', () => {
  /** 每个 op 的一条合法 payload（相对夹具状态；每个用例前会 resetFixtures） */
  const PAYLOADS = {
    'add': { op: 'add', parent: 'root', topic: '批新增节点', id: 'n-op-add' },
    'add-root': { op: 'add-root', topic: '批新增顶层', id: 'n-op-top' },
    'edit': { op: 'edit', id: 'n-a', topic: '甲（批改）' },
    'move': { op: 'move', id: 'n-c', parent: 'n-b' },
    'clone': { op: 'clone', id: 'n-a', parent: 'n-b' },
    'assoc-add': { op: 'assoc-add', members: 'n-a,n-c', title: '批新增关联', id: 'a-op-new' },
    'assoc-edit': { op: 'assoc-edit', id: BASE_ASSOC.id, title: '批改关联标题' }
  };

  /** 从"不认识的 op"那句拒绝报文里现算出允许集 */
  function allowedOps() {
    resetFixtures();
    const f = opsFile([{ op: 'z-not-an-op-z' }]);
    const r = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
    expect(r.code, '未知 op 必须被拒：' + r.out).not.toBe(0);
    const m = /只允许\*\*数据面\*\*操作：([^。]+)。/.exec(r.out);
    expect(m, '拒绝报文里必须列得出允许的 op 清单（它是 OPS 表唯一的对外投影）：' + r.out).toBeTruthy();
    return m[1].split('/').map((s) => s.trim()).filter(Boolean);
  }

  it('E1 覆盖度自检：报文里列出的**每一个** op 都必须在本文件有一行 payload（新加 op ⇒ 这里红）', () => {
    const ops = allowedOps();
    expect(ops.length, '允许集不该是空的').toBeGreaterThan(0);
    const missing = ops.filter((o) => !PAYLOADS[o]);
    expect(missing, '这些 op 没有断言 payload —— 请在上面的 PAYLOADS 里各补一行（别让覆盖度悄悄漏）').toEqual([]);
  });

  it('E2 逐 op：dry-run exit 0 且盘上零变化；真跑 exit 0 且**盘上真的变了**（回执不许说谎）', () => {
    const bad = [];
    allowedOps().forEach((op) => {
      const payload = PAYLOADS[op];
      if (!payload) { bad.push(op + ' → 没有 payload（见 E1）'); return; }
      resetFixtures();
      const f = opsFile([payload]);

      const before = snapAll();
      const dry = run(['apply', PROJ, '--ops-file', f, '--dry-run']);
      if (dry.code !== 0) bad.push(op + ' → dry-run exit ' + dry.code + '：' + dry.out);
      if (snapAll() !== before) bad.push(op + ' → dry-run 动了盘');
      if (dry.out.indexOf('is not defined') >= 0) bad.push(op + ' → dry-run 报内部错误：' + dry.out);

      const markBefore = fs.readFileSync(projFile(PROJ), 'utf8');
      const real = run(['apply', PROJ, '--ops-file', f]);
      if (real.code !== 0) { bad.push(op + ' → 真跑 exit ' + real.code + '：' + real.out); return; }
      if (real.out.indexOf('is not defined') >= 0) { bad.push(op + ' → 真跑报内部错误：' + real.out); return; }
      // ⭐ 通则：回执说"已应用" ⇒ 项目文件的字节必须真的变了
      //    （assoc-* 那两条 op 从前就是在这里"说了没做"：exit 0、stdout 说已应用、盘上没写）
      if (fs.readFileSync(projFile(PROJ), 'utf8') === markBefore) {
        bad.push(op + ' → 回执说"已应用 ' + op + '"，但项目文件**逐字节没变**（静默成功）');
      }
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
