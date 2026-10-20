/* ============================================================
 * tests/w8-dry-run.test.js — 【W8】写入类命令统一 `--dry-run`
 * 运行：npx vitest run tests/w8-dry-run.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的
 * `## W8｜写入类命令统一 --dry-run` 一节（**四条判据逐条对应到下面的 describe**）：
 *   ① `--dry-run` 之后盘上**逐字节零变化** ...................... `W8-A`
 *   ② 报告给出**将改的对象与数量** ............................ `W8-B`
 *   ③ ⭐ **报告与真跑结果一致**（dry-run 说的 = 真跑后的实际变化）.. `W8-C`
 *   ④ 至少一条**注入证明**（让 dry-run 偷偷写盘 ⇒ 断言必红）...... 见交付说明（本文件里
 *      的 A1/C1 就是那条注入会打红的断言；注入读数与还原后的 SHA-256 在交付说明里）
 * 另加两组：`W8-D` 把"**一处实现**"变成**静态可查**的契约；`W8-E/F` 守边界与既有机制的关系。
 *
 * 服务哪条卖点：`卖点.md` **卖点 1**（"给 AI 的可写可校知识库：AI 不再每次都去网上检索"）——
 * W8 修的是那句话里"**可校**"的前置：从前最常用的 `add` / `edit` / `move` / `link` … **写完才知道**
 * 改成了什么样（AI 只能"先写、再回读盘上变成了什么"，而写错的代价已经落在数据里）。
 * 现在"**写前就能审**"：报告说得出"将改哪些对象、几个"，而盘上一个字节都没动。
 *
 * ## 环境要点（与 tests/search-all.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 端到端一律**进程内** `invokeSync`（不起子进程 —— 受限环境下管道 stdio 会 EPERM 假失败）；
 *   3) `projects/` 真实目录**只读**：夹具、断言、清理全在 `SANDBOX`（临时目录）里，`afterAll` 删干净；
 *   4) 默认关掉访问埋点（`heatSensor.__setEnabledForTest(false)`）：本文件量的是**项目目录**的字节，
 *      不留任何旁路写入来源。
 *
 * ## 判据③ 为什么能"逐字比对"（这是本文件最硬的一条，先说清它的构造）
 *   真跑的"实际变化"由**唯一写盘出口** `src/data-store.js` 的 `recordChange` 现算，算它的是
 *   `src/concurrency.js` 的 `changedKeys(oldData, newData)`；dry-run 的报告由 `cli/core.js` 的
 *   `planWrite` 现算，算它的是**同一个函数**、输入是同一对（盘上现有数据 → 计划数据）。
 *   ⇒ 两份清单**同源同口径**（都 `.sort()`：`buildEntry` 排一次、`planWrite` 排一次），
 *     所以下面的断言敢用 `toEqual` / 逐字比较，而不是"都非空就行"的弱口径。
 *
 * ## ⚠️ 一条**已知且刻意**的边界（写在这里，免得下一个人以为漏了）
 *   `add` / `clone` / `item-add` 会**现摇新 id**（`idGen` 含时间与随机，见 `src/markdown.js`）
 *   ⇒ dry-run 报告里的 `node:<新id>` 与真跑后的 `node:<另一个新id>` **逐字不同**。
 *   那是 id 生成器的随机性，**不是两条口径**：所以 `W8-C2` 用"按对象类型的计数"（`byKind`）
 *   做逐字比对 —— 报告里"改了什么"中**与随机无关**的那一半必须完全准。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ⚠️ 本文件的用例是真**耗时**的（这是"墙钟"问题，不是断言问题）：
 *   A1 会把 `W8-A` 的 29 条命令**各跑两遍**（dry-run 一遍 + 真跑一遍，`invokeSync`，**进程内、
 *   不起子进程** ✓），每遍前后各来一次**整棵沙箱目录树**快照（`snapAll()`：每个文件读一遍 +
 *   sha256 + stat）⇒ 单这一个用例 ≈ 58 次命令调用 + 4 次整树遍历 ≈ 数百次文件读。
 *   实测：机器空闲时单跑 A1 = 3.5–4.2 s；**全量同池负载下** 2026-10-13 实测 **11129 ms**
 *   （另一次实测到过 **15119 ms** 的真失败报文 `Test timed out in 15000ms` —— 结论是对的、红在墙钟）。
 *   本文件**不再自写一份超时**：全工程的超时口径只有一处 —— `vitest.config.mjs`
 *   （取值理由与全库最慢用例的读数都在那里；本文件 A1 的 11129 ms 就是那张表里的第一条）。
 *   性能该由链上的 `npm run verify` 预算管，单测只管"对不对" ✓ */

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ----
 * 建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记），收尾只此一处（下面的 `afterAll`）。 */
const SANDBOX = makeTmp('mm-w8-dry-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const registry = require('../cli/registry.js');
const changes = require('../src/changes.js');
const itemModel = require('../src/item-model.js');
const heatSensor = require('../src/heat-sensor.js');
const mcp = require('../scripts/mcp-server.js');

heatSensor.__setEnabledForTest(false);

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterAll(() => {
  cleanupAll();
});

/* ============================================================================
 * 夹具：三个项目（源 / 链接目标 / 脏项目）
 * ==========================================================================
 * 直接写 JSON（不经命令）⇒ 每个用例都能把夹具**重置到一个已知状态**，与执行顺序无关。
 * ⚠️ 条目化节点的 `detail` 必须**逐字节等于** `renderDetail(items)`（契约 §2，schema 会判红）
 *    ⇒ 这里用**同一个实现**算它（`src/item-model.js`），不手写一份"我以为的形状"。
 * ========================================================================== */
const SRC = 'w8-src';
const DST = 'w8-dst';
const DIRTY = 'w8-dirty';          // 悬空**链接**的脏项目（links-prune 用武之地）
const DIRTYA = 'w8-dirty-assoc';   // 悬空**关联成员**的脏项目（assoc-prune 用武之地）
const IMP = 'w8-imp';          // import-project 预览的新项目名（预览不该把它建出来）

const SRC_ITEMS = [
  { id: 'i-1', type: 'text', html: '<p>一</p>', at: '2026-01-01T00:00:00.000Z', by: 'cli:init' },
  { id: 'i-2', type: 'text', html: '<p>二</p>', at: '2026-01-01T00:00:00.000Z', by: 'cli:init' }
];
const DST_ITEMS = [{ id: 'i-9', type: 'text', html: '<p>九</p>', at: '2026-01-01T00:00:00.000Z', by: 'cli:init' }];

const projDir = (name) => path.join(SANDBOX, name);
const projFile = (name) => path.join(projDir(name), name + '.json');
function writeProject(name, obj) {
  fs.mkdirSync(projDir(name), { recursive: true });
  fs.writeFileSync(projFile(name), JSON.stringify(obj, null, 2), 'utf8');
}
/** 源项目：一个普通节点（带子节点/标签/详情）、一个条目化节点、一个带图附件的节点、一条关联笔记 */
function srcFixture() {
  return {
    meta: { name: 'W8 源项目', author: '', version: '0.18.0', formatVersion: 3 },
    format: 'node_tree',
    data: {
      id: 'root', topic: 'W8 源项目', expanded: true,
      children: [
        { id: 'n-a', topic: '甲', detail: '<p>甲正文</p>', tags: ['t1'], expanded: true,
          // 一条**已存在**的出边（unlink 的 dry-run 要有东西可删；目标 d-1 真的存在 ⇒ 项目本身是绿的）
          links: [{ project: DST, id: 'd-1', caption: '指向目标节点' }],
          children: [{ id: 'n-a1', topic: '甲一', children: [] }] },
        { id: 'n-b', topic: '乙', expanded: true, children: [] },
        { id: 'n-it', topic: '条目化节点', expanded: true, children: [],
          items: SRC_ITEMS, detail: itemModel.renderDetail(SRC_ITEMS) },
        { id: 'n-it2', topic: '条目化节点二', expanded: true, children: [],
          items: DST_ITEMS, detail: itemModel.renderDetail(DST_ITEMS) },
        { id: 'n-img', topic: '带图', expanded: true, children: [],
          images: [{ file: 'assets/a.png', caption: '图一' }],
          files: [{ file: 'attachments/a.md', caption: '附件一' }] }
      ]
    },
    assoc: [{ id: 'a-1', title: '关联一', members: [{ project: SRC, id: 'n-a' }, { project: SRC, id: 'n-b' }] }]
  };
}
function dstFixture() {
  return {
    meta: { name: 'W8 链接目标', author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'W8 链接目标', expanded: true,
      children: [{ id: 'd-1', topic: '目标节点', children: [] }] }
  };
}
/**
 * 两个"脏项目"（各自只有**一类**坏东西）——
 * 为什么必须分开：`validate` 会**同时**判悬空链接与悬空成员 ⇒ 一个项目里塞两类的话，
 * 单独跑 `links-prune` 之后项目**仍然红**，就测不出"报告说会修好 ⇒ 真的修好"这条闭环。
 */
function dirtyLinkFixture() {
  return {
    meta: { name: 'W8 脏项目（悬空链接）', author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'W8 脏项目', expanded: true,
      children: [{ id: 'x-1', topic: '有悬空链接', children: [], links: [{ project: 'w8-nope', id: 'z-9' }] }] }
  };
}
function dirtyAssocFixture() {
  return {
    meta: { name: 'W8 脏项目（悬空成员）', author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: 'W8 脏项目', expanded: true,
      children: [{ id: 'x-1', topic: '有悬空成员的关联', children: [] }] },
    assoc: [{ id: 'x-a1', title: '悬空成员的关联',
      members: [{ project: DIRTYA, id: 'x-1' }, { project: DIRTYA, id: 'x-gone' }] }]
  };
}
function resetFixtures() {
  fs.rmSync(projDir(SRC), { recursive: true, force: true });
  fs.rmSync(projDir(DST), { recursive: true, force: true });
  fs.rmSync(projDir(DIRTY), { recursive: true, force: true });
  fs.rmSync(projDir(DIRTYA), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, '.visits'), { recursive: true, force: true });
  writeProject(SRC, srcFixture());
  writeProject(DST, dstFixture());
  writeProject(DIRTY, dirtyLinkFixture());
  writeProject(DIRTYA, dirtyAssocFixture());
}
resetFixtures();

/* ---------------- 断言小工具 ---------------- */

/** 跑一条命令（进程内同步）：返回 `{ code, out }`（stdout+stderr 合并，与集成脚本同口径） */
function run(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}

/** **整棵沙箱目录树**的快照（每份文件：相对路径 + 字节数 + sha256 前 16 + mtimeMs）—— 判据①的量具 */
function snapAll() {
  const out = [];
  const walk = (d) => {
    fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); return; }
      const buf = fs.readFileSync(abs);
      out.push(path.relative(SANDBOX, abs).split(path.sep).join('/')
        + '|' + buf.length + '|' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
        + '|' + fs.statSync(abs).mtimeMs);
    });
  };
  walk(SANDBOX);
  return out.join('\n');
}

/** 变更日志（读盘真值）：判据③ 的右边那一半 */
const journal = (name) => changes.parseLog(fs.readFileSync(path.join(projDir(name), '.changes.jsonl'), 'utf8')).entries;
const lastChanged = (name) => { const e = journal(name); return e.length ? e[e.length - 1].changed : null; };
const lastEntry = (name) => { const e = journal(name); return e.length ? e[e.length - 1] : null; };

/**
 * 从**给人看的报告**里抠出"将改动的对象键清单"与"个数"（顺带证明它可机械解析）。
 * 报告形状（`cli/core.js` 的 `planWrite` 唯一一处生成）：
 *   `[dry-run 未写盘] 这次写盘将改动 3 个对象（children 2 · node 1）：children:n-b、children:root、node:n-b`
 *   `[dry-run 未写盘] 这次跑真命令会**新建**项目（…）`
 * @returns {{count:number, keys:string[], created:boolean, byKind:Object}|null}
 */
function planOf(out) {
  const lines = String(out).split('\n');
  const created = lines.filter((l) => l.indexOf('会**新建**项目') >= 0).length > 0;
  const line = lines.filter((l) => l.indexOf('这次写盘将改动') >= 0)[0];
  if (!line && !created) return null;
  if (created) return { count: 0, keys: [], created: true, byKind: {} };
  const m = /这次写盘将改动 (\d+) 个对象(?:（([^）]*)）)?(?:：(.+))?$/.exec(line.replace(core.DRY_RUN_TAG, ''));
  if (!m) return null;
  const keys = m[3] ? m[3].split('、').map((s) => s.trim()).filter(Boolean) : [];
  const byKind = {};
  keys.forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); byKind[kind] = (byKind[kind] || 0) + 1; });
  return { count: Number(m[1]), keys: keys, created: false, byKind: byKind };
}

/** 真跑日志末条 `changed` 的**类型计数**（与 `planOf` 的 `byKind` 同一套归一） */
function changedKinds(changed) {
  const byKind = {};
  (changed || []).forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); byKind[kind] = (byKind[kind] || 0) + 1; });
  return byKind;
}

/* ============================================================================
 * W8-A 判据①：`--dry-run` 之后盘上**逐字节零变化**
 * ========================================================================== */
describe('W8-A 判据①：--dry-run 之后盘上逐字节零变化', () => {
  /**
   * 覆盖清单：**每条命令各一条真调用**（argv 与夹具 id 都对得上）。
   * ⚠️ 这张表是"本批新接的开关真的通了"的人工清单；它**不是**支持集的真值
   *    —— 真值是 `cli/core.js` 的 `DRY_RUN_COMMANDS`（下面的 W8-D2 机械核对）。
   */
  const CASES = [
    ['add', SRC, 'root', '--topic', '新增节点'],
    ['add-root', SRC, '--topic', '新顶层主题'],
    ['edit', SRC, 'n-a', '--topic', '甲改'],
    ['move', SRC, 'n-a1', 'n-b'],
    ['remove', SRC, 'n-a1'],
    ['clone', SRC, 'n-a', 'n-b'],
    ['expand-depth', SRC, '--depth', '0'],
    ['link', SRC, 'n-b', '--to', DST, '--id', 'd-1'],
    ['unlink', SRC, 'n-a', '--to', DST, '--id', 'd-1'],
    ['assoc-add', SRC, '--members', 'n-a,n-b', '--title', '新关联'],
    ['assoc-edit', SRC, 'a-1', '--title', '改过的标题'],
    ['assoc-remove', SRC, 'a-1'],
    ['assoc-prune', DIRTYA],
    ['links-prune', DIRTY],
    ['item-add', SRC, 'n-it', '--md', '新增条目'],
    ['item-edit', SRC, 'n-it', 'i-1', '--md', '改过的一'],
    ['item-remove', SRC, 'n-it', 'i-2'],
    ['item-move', SRC, 'n-it', 'i-2', '--to', 'n-it2'],
    ['item-order', SRC, 'n-it', '--ids', 'i-2,i-1'],
    ['render-detail', SRC, 'n-it'],
    ['remove-image', SRC, 'n-img', 'assets/a.png'],
    ['remove-file', SRC, 'n-img', 'attachments/a.md'],
    ['theme-layout', SRC, '--left', 'n-a'],
    ['ask-apply', SRC, 'n-a', '--answer', '答案一'],
    ['init', 'w8-newproj', '--title', '新项目'],
    ['apply', SRC, '--ops-file', '不存在的 ops.json'],       // ④ 已有自备预览：失败也不许写盘
    ['import-project', IMP, '不存在的.md'],                   //    同上（预览/拒绝都不许建项目）
    ['import-dir', IMP, '不存在的目录'],                      //    同上
    ['ask', SRC, 'n-a', '--kind', 'explain']                  //    ask 的 dry-run 不调模型、不写盘
  ];

  it('A1 覆盖清单里每一条命令：dry-run 前后**整棵沙箱逐字节相同**（含 .changes.jsonl、assets/、mtime）',
    () => {
      const failures = [];
      CASES.forEach((argv) => {
        resetFixtures();
        const before = snapAll();
        const r = run(argv.concat(['--dry-run']));
        const after = snapAll();
        if (before !== after) failures.push(argv[0] + ' → 盘上变了');
        // 第二次跑：报告的"改了什么"必须与第一次**同口径**
        // （⚠️ 会现摇新 id 的命令（add / clone / item-add…）第一次与第二次的 id 本来就不同 ⇒
        //   这里比的是**按类型的计数**，那才是与随机无关的那一半；逐字比对在 W8-C 里做）
        const again = run(argv.concat(['--dry-run']));
        const p1 = planOf(r.out);
        const p2 = planOf(again.out);
        const sig = (p) => (p === null ? 'null' : (p.created ? 'created' : p.count + '/' + JSON.stringify(p.byKind)));
        if (sig(p1) !== sig(p2)) failures.push(argv[0] + ' → 第二次报告的读数与第一次不同（' + sig(p1) + ' vs ' + sig(p2) + '）');
        // 报告必须看得见"这是预览"（中央机制会给标记；自备预览的命令（ask / import-*）自己写着）
        if (r.code === 0 && r.out.indexOf('dry-run') < 0) failures.push(argv[0] + ' → 输出里看不出这是 dry-run');
      });
      expect(failures, failures.join('；')).toEqual([]);
    });

  it('A3 没有可写的东西时**不报计划也不写盘**（例：干净项目上的 `links-prune`）—— 空写入连日志都不该多一条',
    () => {
      resetFixtures();
      const before = snapAll();
      const r = run(['links-prune', SRC, '--dry-run']);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('无需清理');
      expect(planOf(r.out), '没有可写的 ⇒ 不该报"将改动 N 个对象"').toBe(null);
      expect(snapAll()).toBe(before);
    });

  it('A2 对照组：`add-image` / `import-md` 真跑**确实会**在盘上多出东西（证明 A1 的零变化是"关掉了副作用"而不是"什么也没做"）',
    () => {
      resetFixtures();
      /** 目录里几个文件（目录不存在 = 0 个 —— dry-run 连目录都不许建） */
      const countFiles = (d) => (fs.existsSync(d) ? fs.readdirSync(d).length : 0);
      const assetsDir = path.join(projDir(SRC), 'assets');
      // 造一个真图片 + 一份带引用的 md（都在 SANDBOX 外的临时目录里，别污染项目根）
      const tmp = makeTmp('mm-w8-assets-');
      const png = path.join(tmp, 'p.png');
      fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
      const mdDir = path.join(tmp, 'doc');
      fs.mkdirSync(path.join(mdDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(mdDir, 'assets', 'r.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
      const md = path.join(mdDir, 'doc.md');
      fs.writeFileSync(md, '# 主题一\n\n正文\n\n![图](assets/r.png)\n', 'utf8');
      try {
        // ① 图片：dry-run **连 assets/ 目录都不建**；真跑复制一个文件（对照组）
        const dryImg = run(['add-image', SRC, 'n-a', '--file', png, '--caption', '图', '--dry-run']);
        expect(dryImg.code, dryImg.out).toBe(0);
        expect(countFiles(assetsDir), 'dry-run 不许复制文件（连目录都不该建）').toBe(0);
        expect(dryImg.out).toContain('未写盘');
        const realImg = run(['add-image', SRC, 'n-a', '--file', png, '--caption', '图']);
        expect(realImg.code, realImg.out).toBe(0);
        expect(countFiles(assetsDir), '真跑必须复制').toBe(1);

        // ② import-md 的资源引用：dry-run 不复制（报告说"将复制"），真跑复制（数目 +1）
        const dryMd = run(['import-md', SRC, md, '--dry-run']);
        expect(dryMd.code, dryMd.out).toBe(0);
        expect(dryMd.out).toContain('不复制');
        expect(dryMd.out).toContain('将复制');
        expect(countFiles(assetsDir), 'dry-run 后资源数不变').toBe(1);
        const realMd = run(['import-md', SRC, md]);
        expect(realMd.code, realMd.out).toBe(0);
        expect(countFiles(assetsDir), '真跑必须复制引用资源').toBe(2);
      } finally {
        // 收尾**不在这里**：这条目录已由 `makeTmp` 登记，删盘唯一入口是 `afterAll(cleanupAll)`。
        void tmp;
      }
    });
});

/* ============================================================================
 * W8-B 判据②：报告给出**将改的对象与数量**
 * ========================================================================== */
describe('W8-B 判据②：报告给出将改的对象与数量', () => {
  it('B1 报告是机器可解析的：个数 == 清单条数，且清单里的每一项都带对象类型前缀', () => {
    resetFixtures();
    const bad = [];
    [['edit', SRC, 'n-a', '--topic', '甲改'],
      ['link', SRC, 'n-b', '--to', DST, '--id', 'd-1'],
      ['assoc-add', SRC, '--members', 'n-a,n-b', '--title', '新关联'],
      ['item-order', SRC, 'n-it', '--ids', 'i-2,i-1']
    ].forEach((argv) => {
      const r = run(argv.concat(['--dry-run']));
      const p = planOf(r.out);
      if (r.code !== 0) { bad.push(argv[0] + ' exit=' + r.code); return; }
      if (!p || !p.count) { bad.push(argv[0] + ' 报告里没有"将改动 N 个对象"'); return; }
      if (p.count !== p.keys.length) bad.push(argv[0] + ' 个数 ' + p.count + ' != 清单 ' + p.keys.length);
      if (p.keys.some((k) => k.indexOf(':') < 0 && ['meta', 'format'].indexOf(k) < 0)) bad.push(argv[0] + ' 清单项缺类型');
    });
    expect(bad, bad.join('；')).toEqual([]);
  });

  it('B2 `--json` 档同样给得出来（`dryRun:true` + `plan`），且与文本档**同一份读数**', () => {
    resetFixtures();
    // 用 `ask-apply`（对象 id 全由调用方点名 ⇒ 两次读数的清单可逐字比；`clone` 会现摇新 id）
    const r = run(['ask-apply', SRC, 'n-a', '--answer', '答案一', '--question', '问题一', '--json', '--dry-run']);
    expect(r.code, r.out).toBe(0);
    const j = JSON.parse(r.out);                       // ← stdout 必须仍是**一份**可解析 JSON
    expect(j.dryRun).toBe(true);
    expect(!!j.plan).toBe(true);
    expect(j.plan.changedCount).toBe(j.plan.changed.length);
    expect(j.plan.changed).toEqual(['node:n-a']);
    expect(j.plan.created).toBe(false);
    // 与文本档逐字同口径：同一命令、同一状态 ⇒ 同一份清单
    resetFixtures();
    const t = run(['ask-apply', SRC, 'n-a', '--answer', '答案一', '--question', '问题一', '--dry-run']);
    expect(planOf(t.out).keys).toEqual(j.plan.changed);
    // 文本档的 JSON 消费者零损失那条：`--compact` 也照样是一份单行 JSON
    resetFixtures();
    const c = run(['ask-apply', SRC, 'n-a', '--answer', '答案一', '--json', '--compact', '--dry-run']);
    expect(c.out.split('\n').length).toBe(1);
    expect(JSON.parse(c.out).plan.changedCount).toBe(1);
  });

  it('B3 派生缓存的边界如实说：`render-detail` 计划报"0 个对象"（`detail` 是 items 的派生缓存，不进变更日志口径），而命令自己的报告说"实际变化 1"',
    () => {
      resetFixtures();
      // 把 detail 改旧（模拟 G2 判红的现场）：真跑会重建它，但**变更日志的口径**里 detail 是派生缓存 ⇒ 0 个对象
      const raw = JSON.parse(fs.readFileSync(projFile(SRC), 'utf8'));
      raw.data.children.filter((n) => n.id === 'n-it')[0].detail = '<p>旧的</p>';
      fs.writeFileSync(projFile(SRC), JSON.stringify(raw, null, 2), 'utf8');
      const r = run(['render-detail', SRC, 'n-it', '--dry-run']);
      const p = planOf(r.out);
      expect(r.code, r.out).toBe(0);
      expect(p.count).toBe(0);
      expect(r.out).toContain('实际变化 1');                    // 命令自己的领域计数照旧如实
      // 真跑：对象面同样是 0，而盘上 detail 真的被重建了（两条读数各说各的维度，都不撒谎）
      const real = run(['render-detail', SRC, 'n-it']);
      expect(real.code, real.out).toBe(0);
      expect(real.out).toContain('实际变化 1');
      expect(lastChanged(SRC)).toEqual([]);
      const after = JSON.parse(fs.readFileSync(projFile(SRC), 'utf8'));
      expect(after.data.children.filter((n) => n.id === 'n-it')[0].detail).toBe(itemModel.renderDetail(SRC_ITEMS));
    });
});

/* ============================================================================
 * W8-C 判据③：报告与真跑结果一致
 * ========================================================================== */
describe('W8-C 判据③：报告与真跑结果一致（dry-run 说的 = 真跑后实际改的）', () => {
  /**
   * 逐字比对的**唯一做法**：夹具重置 → dry-run（拿报告）→ 盘上零变化自证 → 真跑 → 读日志末条 `changed`。
   * @returns {{keys:string[], changed:string[]}} 两边（相等性由调用方断言，便于报出差异）
   */
  function dryThenReal(argv, project) {
    resetFixtures();
    const dry = run(argv.concat(['--dry-run']));
    expect(dry.code, 'dry-run 必须成功：' + dry.out).toBe(0);
    const before = snapAll();
    expect(snapAll(), 'dry-run 后盘上必须零变化').toBe(before);      // ← 注入证明打红的就是这一条
    const p = planOf(dry.out);
    expect(p, '报告必须可解析：' + dry.out).not.toBe(null);
    const real = run(argv);
    expect(real.code, '真跑必须成功：' + real.out).toBe(0);
    const changed = lastChanged(project);
    return { keys: p.keys, count: p.count, byKind: p.byKind, changed: changed };
  }

  /** 逐字一致的那一批：**对象 id 全部由调用方点名**（新 id 一个都不摇 ⇒ 清单可逐字比） */
  const VERBATIM = [
    ['edit', SRC, 'n-a', '--topic', '甲改后的标题'],
    ['edit', SRC, 'n-a', '--tags', 'x,y'],
    ['move', SRC, 'n-a1', 'n-b'],
    ['remove', SRC, 'n-a1'],
    ['expand-depth', SRC, '--depth', '0'],
    ['theme-layout', SRC, '--left', 'n-a'],
    ['link', SRC, 'n-b', '--to', DST, '--id', 'd-1'],
    ['link', SRC, 'n-b', '--to', DST, '--id', 'd-1', '--caption', '说明'],
    ['unlink', SRC, 'n-a', '--to', DST, '--id', 'd-1'],
    ['assoc-add', SRC, '--members', 'n-a,n-b', '--title', '新关联', '--id', 'a-9'],
    ['assoc-edit', SRC, 'a-1', '--title', '改过的标题'],
    ['assoc-remove', SRC, 'a-1'],
    ['item-edit', SRC, 'n-it', 'i-1', '--md', '改过的一'],
    ['item-remove', SRC, 'n-it', 'i-2'],
    ['item-move', SRC, 'n-it', 'i-2', '--to', 'n-it2'],
    ['item-order', SRC, 'n-it', '--ids', 'i-2,i-1'],
    ['remove-image', SRC, 'n-img', 'assets/a.png'],
    ['remove-file', SRC, 'n-img', 'attachments/a.md'],
    ['add', SRC, 'root', '--id', 'n-pinned', '--topic', '钉住 id 的新增'],
    ['add-root', SRC, '--id', 'n-pinned-top', '--topic', '钉住 id 的顶层'],
    ['ask-apply', SRC, 'n-a', '--answer', '答案一', '--question', '问题一']
  ];

  it('C1 逐字一致：**22 条命令**的报告清单 == 真跑后 `.changes.jsonl` 末条的 `changed`（个数也相等）', () => {
    const bad = [];
    VERBATIM.forEach((argv) => {
      const r = dryThenReal(argv, SRC);
      const same = JSON.stringify(r.keys) === JSON.stringify(r.changed);
      if (!same) bad.push(argv[0] + ' → 报告 ' + JSON.stringify(r.keys) + ' ≠ 日志 ' + JSON.stringify(r.changed));
      if (r.count !== r.keys.length) bad.push(argv[0] + ' → 个数与清单不符');
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('C2 清理型（`links-prune` / `assoc-prune`）：报告清单 == 真跑日志的 `changed`，且真跑后项目**复绿**', () => {
    const bad = [];
    // 两类脏各自一个项目（`validate` 会同时判两类 ⇒ 塞一起就测不出"单跑一条即可复绿"）
    [['links-prune', DIRTY], ['assoc-prune', DIRTYA]].forEach((argv) => {
      const r = dryThenReal(argv, argv[1]);
      if (JSON.stringify(r.keys) !== JSON.stringify(r.changed)) {
        bad.push(argv[0] + ' → 报告 ' + JSON.stringify(r.keys) + ' ≠ 日志 ' + JSON.stringify(r.changed));
      }
      // 真跑之后：校验必须转绿（那一类悬空真的被修好了）——"报告说会修好"必须真的修好
      const v = run(['validate', argv[1]]);
      if (v.code !== 0) bad.push(argv[0] + ' → 真跑后 validate 仍红：' + v.out);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('C3 会**现摇新 id** 的那批（`add` 不给 --id / `clone` / `item-add`）：按类型的计数**逐字相等**（清单里的 id 不同是 idGen 的随机性，不是两条口径）',
    () => {
      const bad = [];
      [['add', SRC, 'root', '--topic', '不钉 id 的新增'],
        ['clone', SRC, 'n-a', 'n-b'],
        ['item-add', SRC, 'n-it', '--md', '新条目']
      ].forEach((argv) => {
        const r = dryThenReal(argv, SRC);
        const rk = changedKinds(r.changed);
        if (JSON.stringify(r.byKind) !== JSON.stringify(rk)) {
          bad.push(argv[0] + ' → 报告类型计数 ' + JSON.stringify(r.byKind) + ' ≠ 日志 ' + JSON.stringify(rk));
        }
        if (r.count !== r.changed.length) bad.push(argv[0] + ' → 项数 ' + r.count + ' ≠ 日志 ' + r.changed.length);
      });
      expect(bad, bad.join('\n')).toEqual([]);
    });

  it('C4 新建项目（`init`）：报告说"会新建、没有既有对象被改"，真跑日志**同口径**（`created:true` / `changed:[]`），且 dry-run 不建目录',
    () => {
      const name = 'w8-init-probe';
      fs.rmSync(projDir(name), { recursive: true, force: true });
      const dry = run(['init', name, '--title', '新项目', '--dry-run']);
      expect(dry.code, dry.out).toBe(0);
      expect(fs.existsSync(projDir(name)), 'dry-run 不许建项目目录').toBe(false);
      const p = planOf(dry.out);
      expect(p.created).toBe(true);
      expect(p.keys).toEqual([]);
      const real = run(['init', name, '--title', '新项目']);
      expect(real.code, real.out).toBe(0);
      const e = lastEntry(name);
      expect(e.created).toBe(true);
      expect(e.changed).toEqual([]);
      fs.rmSync(projDir(name), { recursive: true, force: true });
    });

  it('C5 拒绝也一致：语义去重命中时 dry-run 与真跑**同样 exit 1 且同一句话**（"预览说能写、真跑被拒"的落差不存在）',
    () => {
      resetFixtures();
      // 先真跑一次建立"已存在同题同内容"的状态
      expect(run(['add', SRC, 'root', '--id', 'n-dup', '--topic', '重复主题']).code).toBe(0);
      const before = snapAll();
      const dry = run(['add', SRC, 'root', '--topic', '重复主题', '--dry-run']);
      const real = run(['add', SRC, 'root', '--topic', '重复主题']);
      expect(dry.code).toBe(1);
      expect(real.code).toBe(1);
      expect(dry.out).toBe(real.out);                    // 同一句话（dry-run 不是另一条判据）
      expect(snapAll()).toBe(before);                     // 两次都没写盘
    });
});

/* ============================================================================
 * W8-D 一处实现（静态把守：机制只有一份，命令层不许各写一套）
 * ========================================================================== */
describe('W8-D 一处实现（静态可查）', () => {
  const cmdFiles = fs.readdirSync(path.join(ROOT, 'cli', 'commands')).filter((f) => f.endsWith('.js'));
  const readCmd = (f) => fs.readFileSync(path.join(ROOT, 'cli', 'commands', f), 'utf8');

  it('D1 `--dry-run` 的判定只有**一个读取点**：`cli/commands/*.js` 里不出现 `args.dryRun`（统一读 `ctx.dryRun`）', () => {
    const bad = cmdFiles.filter((f) => /args\.dryRun/.test(readCmd(f)));
    expect(bad).toEqual([]);
  });

  it('D2 支持集只有**一处登记**：`core.DRY_RUN_COMMANDS` ⟺ registry 的 `dryRun` 白名单（双向、逐命令）', () => {
    const bad = [];
    registry.list().forEach((c) => {
      const allowed = registry.allowedOptions(c.name).indexOf('dryRun') >= 0;
      const listed = core.DRY_RUN_COMMANDS.indexOf(c.name) >= 0;
      if (allowed !== listed) bad.push(c.name + ' → 白名单=' + allowed + ' 清单=' + listed);
    });
    expect(bad).toEqual([]);
  });

  it('D3 会改盘的命令**都**在支持集里：`WRITE_COMMANDS − {import-json}` ⊆ `DRY_RUN_COMMANDS`，且 `import-json` 单列在不支持表里', () => {
    const missing = core.WRITE_COMMANDS.filter((n) => n !== 'import-json' && core.DRY_RUN_COMMANDS.indexOf(n) < 0);
    expect(missing).toEqual([]);
    expect(Object.keys(core.DRY_RUN_UNSUPPORTED)).toEqual(['import-json']);
    expect(core.DRY_RUN_COMMANDS.indexOf('import-json')).toBe(-1);
  });

  it('D4 "计划"的打印只有一处：非测试文件里只有 `cli/core.js` 定义那个行首标记', () => {
    const hits = [];
    const walk = (d) => {
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.review') return;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        if (!/\.(js|mjs)$/.test(e.name)) return;
        if (/tests[\\/]/.test(abs)) return;
        if (fs.readFileSync(abs, 'utf8').indexOf('DRY_RUN_TAG = ') >= 0) {
          hits.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        }
      });
    };
    walk(ROOT);
    expect(hits).toEqual(['cli/core.js']);
  });

  it('D5 命令层不再各写一份 dry-run 分流：`cli/commands/*.js` 的**有效代码**里不出现 `if (!ctx.dryRun) {` 这种"写盘前分流"', () => {
    /** 去掉注释（注释里会**引用**这段被删掉的旧写法，那是说明书不是代码） */
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
    const bad = cmdFiles.filter((f) => /if \(!\s*ctx\.dryRun\s*\)/.test(stripComments(readCmd(f))));
    expect(bad).toEqual([]);
  });
});

/* ============================================================================
 * W8-E 边界：不认这个开关的命令**响亮拒绝**（不静默忽略）
 * ========================================================================== */
describe('W8-E 边界：不支持的命令响亮拒绝', () => {
  it('E1 只读命令带 `--dry-run` ⇒ exit 1 + 说清"只对会改盘的命令有意义" + 指回清单', () => {
    const r = run(['read', SRC, '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--dry-run 只对**会改盘的命令**有意义');
    expect(r.out).toContain('DRY_RUN_COMMANDS');
  });

  it('E2 `import-json`（会改盘但不支持）⇒ exit 1 + **点名原因与出路**（不是"未知选项"那种含糊）', () => {
    const r = run(['import-json', 'nope.aimap.json', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('import-json');
    expect(r.out).toContain('不可用');
    expect(r.out).toContain('新项目');
    expect(r.out).not.toContain('未知选项');
  });

  it('E3 别名与正式名**同待遇**：`tree --dry-run`（list 的别名）拒绝时报的是正式名 `list`', () => {
    const r = run(['tree', SRC, '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('list 不写盘');
  });

  it('E4 `core.dryRunRefusal` 是**纯函数**（判定可单测、与 main.js 的守门同源）', () => {
    expect(core.dryRunRefusal('add', false)).toBe(null);          // 没带这个开关 ⇒ 不管
    expect(core.dryRunRefusal('add', undefined)).toBe(null);
    expect(core.dryRunRefusal('add', true)).toBe(null);           // 认它 ⇒ 放行
    expect(core.dryRunRefusal('read', true)).toMatch(/只对\*\*会改盘的命令\*\*有意义/);
    expect(core.dryRunRefusal('import-json', true)).toMatch(/不可用/);
  });

  it('E5 **带值**的写法一律响亮拒绝（`--dry-run=false` 想"不干跑"就是**把开关去掉**；两种猜法都危险 ⇒ 不猜）',
    () => {
    // 纯函数层：任何非 `true` 的值都拒
    expect(core.dryRunRefusal('add', 'false')).toMatch(/纯开关/);
    expect(core.dryRunRefusal('add', '')).toMatch(/纯开关/);
    // 端到端：命令体一个字都不该跑（连"项目不存在"这种执行期报错都不该出现）
    const r = run(['edit', SRC, 'n-a', '--topic', 'x', '--dry-run=false']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--dry-run 是**纯开关**');
    expect(r.out).not.toContain('已更新');
    // 对照：不带值的那一次照常走 dry-run（不是"整条命令坏了"）
    const ok = run(['edit', SRC, 'n-a', '--topic', 'x', '--dry-run']);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain(core.DRY_RUN_TAG);
  });
});

/* ============================================================================
 * W8-F 与既有机制的关系（幂等键 / MCP 面）
 * ========================================================================== */
describe('W8-F 与既有机制的关系', () => {
  it('F1 `--dry-run` 不查也不记 `--idem` 键：dry-run 之后**同一个键真跑必须真的执行**（不许把它吞掉）', () => {
    resetFixtures();
    const dry = run(['add', SRC, 'root', '--id', 'n-idem', '--topic', '幂等探针', '--dry-run', '--idem', 'k-w8']);
    expect(dry.code, dry.out).toBe(0);
    const real = run(['add', SRC, 'root', '--id', 'n-idem', '--topic', '幂等探针', '--idem', 'k-w8']);
    expect(real.code, real.out).toBe(0);
    expect(real.out, '真跑不许被当成幂等命中').not.toContain('幂等命中');
    const again = run(['add', SRC, 'root', '--id', 'n-idem', '--topic', '幂等探针', '--idem', 'k-w8']);
    expect(again.out, '第二次真跑才该命中').toContain('幂等命中');
  });

  it('F2 dry-run 不追加变更日志：`changes --json` 的 rev 与 version 前后不变', () => {
    resetFixtures();
    const before = JSON.parse(run(['changes', SRC, '--json']).out);
    run(['edit', SRC, 'n-a', '--topic', '甲改', '--dry-run']);
    const after = JSON.parse(run(['changes', SRC, '--json']).out);
    expect(after.rev).toBe(before.rev);
    expect(after.version).toBe(before.version);
  });

  it('F3 MCP 面：工具数 52、`dry_run` 只挂在写类工具上（30 个）且 `import_json` 没有它', () => {
    // 2026-10-20（W21）：51 → 52 是 `ask_apply`（`ask-apply` 的透传），29 → 30 是它挂上了 `dry_run`
    // —— 它**是写类**（一次 `ctx.mutate`），不挂就等于把"先审再写"那条出路从 MCP 侧抽掉。
    expect(mcp.TOOLS.length).toBe(52);
    expect(new Set(mcp.TOOLS.map((t) => t.name)).size).toBe(52);
    const withFlag = mcp.TOOLS.filter((t) => t.inputSchema.properties && t.inputSchema.properties.dry_run);
    expect(withFlag.length).toBe(30);
    const importJson = mcp.TOOLS.filter((t) => t.name === 'import_json')[0];
    expect(importJson.inputSchema.properties.dry_run).toBe(undefined);
    // 每个带 dry_run 的工具都必须在 CLI 侧**真的**认这个开关（映射不许漂移：schema ⇄ 转发 ⇄ CLI 三处同源）
    const map = mcp.DRY_RUN_TOOL_CMD;
    const bad = withFlag.filter((t) => core.DRY_RUN_COMMANDS.indexOf(map[t.name] || '') < 0).map((t) => t.name);
    expect(bad).toEqual([]);
    expect(Object.keys(map).length, '映射表里的工具数 == 挂 dry_run 参数的工具数').toBe(withFlag.length);
  });
});

/* ============================================================================
 * W8-G 【W14】判据③的**同判**推广：预览与真跑跑**同一份写盘前校验**
 * ==========================================================================
 * W8 原本保证的是"报告里那份**改动清单**与真跑一致"（W8-C）。W14 实测发现另一处更大的落差：
 * `--dry-run` 在**任何写盘动作之前**短路（`cli/core.js` 的两条写路径）⇒ 从前**跑不到**
 * 写盘前校验（`src/data-store.js` 的 `validate` ⇒ `src/schema.js`）⇒ 出现
 * **真跑 exit 1、预览 exit 0 并回显"已并入父节点 …的**详情开头**"**这种"预览说谎"
 * （比报错更贵：调用方会照预览做决定）。
 *
 * 本组钉的两个方向：
 *   ① **真跑必失败 ⇒ 预览必须也失败**，而且**报文逐字相同**（同一份判据、同一份输入）；
 *      并且**不许先报一份计划再失败**（真跑根本不会打印任何"将改动 N 个对象"）。
 *   ② **预览说能成 ⇒ 真跑必能成** —— 这一半用 W14 的真实缺陷钉在
 *      `tests/import-md-landing.test.js` 的 G1（`import-md` 撞"已条目化的父节点"）：
 *      修前真跑 1 / 预览 0，修后两边都是 0；本文件不重复造那条夹具。
 *
 * ⚠️ 覆盖范围**如实登记**（别把它当成"全仓已覆盖"）：走 `ctx.write` / `ctx.mutate` 这两条写路径
 *    的命令都在内（`DRY_RUN_COMMANDS` 的 ①②③ 三类 + `recheck` / `ask-apply` / `init` /
 *    `theme-layout`）；**自带预览、不走这两条路**的四条命令仍不在内 ——
 *    `import-project` / `import-dir`（预览里直接 return）/ `migrate items`（自己走 `ctx.store.write`）/
 *    `apply`（`ctx.dryRun` 分支提前 return）。`ask` 的 dry-run 不写盘，不存在这条性质。
 *    出路（下一批）：让那四条命令的预览**复用同一份校验入口**，而不是各拼一份"我觉得会成"的清单。
 * ========================================================================== */
describe('W8-G 【W14】判据③推广：预览与真跑跑同一份写盘前校验（真跑必失败 ⇒ 预览必失败）', () => {
  /* 脏项目：一个**已条目化**的节点，`detail` 与 `renderDetail(items)` 不一致（写前校验必判红）。
   * 用"外部工具写坏数据"的形态造 —— 这是这类数据唯一真实的来源（本工程自己的写路径都有闸门）。 */
  const SICK = 'w8-sick';
  function writeSickFixture() {
    fs.rmSync(projDir(SICK), { recursive: true, force: true });
    const items = [{ id: 'i-sick', type: 'text', html: '<p>真源是这一条</p>', at: '2026-01-01T00:00:00.000Z', by: 'test' }];
    writeProject(SICK, {
      meta: { name: 'W8 脏项目（detail 与 items 不一致）', author: '', version: '0.18.0', formatVersion: 2 },
      format: 'node_tree',
      data: {
        id: 'root', topic: 'W8 脏项目', expanded: true,
        children: [{ id: 'n-sick', topic: '缓存被写坏的条目化节点', expanded: true, children: [], items: items, detail: '<p>与 items 对不上</p>' }]
      }
    });
  }

  it('G1 真跑必失败（写盘前校验判红）⇒ 同一条 `--dry-run` **必须也失败**，报文**逐字相同**、且不报计划',
    () => {
      writeSickFixture();
      const argv = ['add', SICK, 'root', '--topic', '新主题'];
      const real = run(argv);
      expect(real.code, '对照组：这条真跑必须失败（否则本用例什么都没证明）: ' + real.out).toBe(1);
      expect(real.out).toContain('校验失败');
      expect(real.out).toMatch(/detail 与 items 不一致/);

      const dry = run(argv.concat(['--dry-run']));
      expect(dry.code, '预览必须报出真跑会失败（修前这里是 exit 0）: ' + dry.out).toBe(1);
      expect(dry.out, '同一份判据、同一份输入 ⇒ 报文逐字相同').toBe(real.out);
      expect(planOf(dry.out), '失败的那一次不许先报一份"将改动 N 个对象"（真跑也不会报）').toBe(null);
      expect(dry.out.indexOf('这次写盘将改动')).toBeLessThan(0);
      // 盘上零改动（判据①在失败档上同样成立）
      const before = fs.readFileSync(projFile(SICK), 'utf8');
      run(argv.concat(['--dry-run']));
      expect(fs.readFileSync(projFile(SICK), 'utf8')).toBe(before);
      fs.rmSync(projDir(SICK), { recursive: true, force: true });
    });

  it('G2 对照：**同一个项目**上把那条坏数据修好 ⇒ 真跑与预览都 exit 0，且计划的类型计数与真跑日志一致',
    () => {
      writeSickFixture();
      // 修法就是留档的那一条：按 items 重建 detail（`render-detail`）
      const fix = run(['render-detail', SICK, 'n-sick']);
      expect(fix.code, fix.out).toBe(0);
      const argv = ['add', SICK, 'root', '--topic', '修好之后再试'];
      const dry = run(argv.concat(['--dry-run']));
      expect(dry.code, dry.out).toBe(0);
      const real = run(argv);
      expect(real.code, real.out).toBe(0);
      expect(dry.code).toBe(real.code);
      const entries = journal(SICK);
      const lastKeys = (entries[entries.length - 1] || {}).changed || [];
      const kinds = {};
      lastKeys.forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); kinds[kind] = (kinds[kind] || 0) + 1; });
      expect(planOf(dry.out).byKind).toEqual(kinds);
      fs.rmSync(projDir(SICK), { recursive: true, force: true });
    });
});
