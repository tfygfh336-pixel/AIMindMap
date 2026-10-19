/* ============================================================
 * tests/recheck.test.js — 复校与体检（S4）
 * 运行：npx vitest run tests/recheck.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条都对着一个**能红**的判据）
 *   A. `src/item-src.js` 是"出处"这一维的**唯一实现处**：
 *      归一化**只有一处实现**（唯一实现在 `src/item-index.js` 的 `srcList`，`normalizeSrc` 只是
 *      薄适配）—— 那组断言守的是**这一处实现的形状**，不再是"两份实现互证"（第四批收口，见用例注释）；
 *      **子串匹配（`--src`）同样只有一处实现**（唯一实现在 `src/item-index.js` 的 `srcMatches`，
 *      `matchesSrc` 只是**薄转发**；空 needle 那条边界与两层分工见 `srcMatches` 的契约注释）
 *      —— 第五批收口，改前两处**已经漂**（一个是"不命中"、一个是"整段跳过"）；
 *      `file:line` / `file:line::引文` / URL / 命令 / 认不出 五种形状都能解析；
 *      同一个文件在同一次运行里**只读一次**（廉价前置）。
 *   B. `recheck` 三态（ok / needs-recheck / src-gone）+ 计数 + 原因分布，**逐条点名**、给可执行下一步；
 *      **只读默认**：跑一次，项目 JSON 与 `.changes.jsonl` **逐字节不变**；
 *      `--src` 的过滤口径与检索面**同一条**（**空 needle 不是过滤条件**）：`--src=`（显式空串）与
 *      不给 `--src` 的 `--json` **逐字节相同**、回显 `filteredBySrc: null`（【批7】口径收准；
 *      收准前回显 `""`，与 `search` 面同一个输入两种口径）。
 *   C. **注入证明（改一个源文件）**：同一条目 `ok` → 改源文件 ⇒ `needs-recheck`（file-changed）→
 *      再让引文消失 ⇒ `src-gone`（quote-missing）。
 *   D. `recheck --write-verified`：默认**零写盘**；`--how` 必填；`--dry-run` 不写；
 *      写回只动 `verified`（`detail` 逐字节不变）；`.changes.jsonl` **只多 1 条**；
 *      出处失效的条目默认拒写、`--force` 才放行。
 *   E. `health`：条目化/总数、`items ↔ detail` 不一致（**逐节点点名**）、悬挂引用、`qa` 残留、
 *      迁移"跳过"的**五档**与原因分布；**确定性**（两次 `--json` 逐字节相同）、不写盘、
 *      不打印运行时刻（`lastVerifiedAt` 取自数据）。
 *   F. MCP 条目层扩参（本轮追加件）：新参数**逐个**在工具描述里点名对应的 CLI 参数，
 *      且那个参数真的被那条 CLI 命令接受；六个新工具都在；派发命令都存在。
 *
 * ## ⚠️ 两个环境要点
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js`
 *      **之前**设好（`cli/core.js` 的 `PROJECTS_DIR` 是模块加载时定型的）。本文件在加载时先自证。
 *   2) **不起子进程、不跑全链**（进程内 `invokeSync`，与 tests/item-commands.test.js 同口径）：
 *      工程纪律 —— 集成与冒烟由整合流**串行**跑，本流只跑这一份。
 *
 * ## ⚠️ 依赖整合流（不在本流的文件所有权里 —— 见交付说明）
 *   · `cli/registry.js` 的两条 register 由**整合流**落盘（本文件只交原文）。为了让本文件
 *     **今天就能真跑**，这里在 import 时按交付原文**自注册一次**（`register()` 是 registry 的
 *     公开 API，**不改 registry.js 一个字节**）；整合流落盘之后这步自动跳过（`registry.get` 已存在），
 *     且两处原文逐字相同（`REGISTER_LINES` 是唯一来源）。
 *   · `cli/core.js` 的 `WRITE_COMMANDS` 要加 `recheck`（它带 `--write-verified` 时会写 `verified`）。
 *     落地之前 D7 按设计走"响亮拒绝"那条分支 —— **不是代码问题**，报文里会直接说清。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/** A 组的**结构断言**要读这个文件的源码（归一化的谓词必须只有一处） */
const SRC_ITEM_SRC = fileURLToPath(new URL('../src/item-src.js', import.meta.url));

/* ---- ① 沙箱：必须在 require cli/main.js 之前设好 ----
 * 建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记），收尾只此一处（下面的 `afterAll`）。 */
const SANDBOX = makeTmp('mm-s4-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const registry = require('../cli/registry.js');
const itemSrc = require('../src/item-src.js');
const itemIndex = require('../src/item-index.js');
const itemModel = require('../src/item-model.js');
const recheckCmd = require('../cli/commands/recheck.js');
const healthCmd = require('../cli/commands/health.js');
const collateral = require('../scripts/collateral-check.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/`。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* ============================================================================
 * ② 交付给整合流的 registry 原文（**唯一来源**：既是注册用的常量，也是交付②的内容）
 * ==========================================================================
 * ⚠️ 用法串与 `options` 必须一一对上（`tests/cli-options.test.js` 机械核对）。
 * ========================================================================== */
const REGISTER_LINES = [
  {
    name: 'recheck',
    usage: 'recheck <项目> [--src 子串] [--only i-a,i-b] [--limit n] [--root 目录] [--json] '
      + '[--write-verified --how "怎么核的"] [--dry-run]',
    options: ['src', 'only', 'limit', 'root', 'json', 'writeVerified', 'how', 'dryRun'],
    desc: '**条目复校**：逐条点名哪些条目需要复核（出处失效 / 引文找不到 / 行号漂移 / 核验后源文件改过 / '
      + '没核过 / 无出处 / 引用悬挂），并给出**可执行的下一步**。只读是默认；确认后用 '
      + '`--write-verified --how "…"` 写回 `verified{at,by,how}`（出处判不过的条目默认不写，先修再核）。'
      + '三类 = ok / needs-recheck / src-gone（判据与出处维在 `src/item-src.js`）',
    fn: recheckCmd.recheck
  },
  {
    name: 'health',
    usage: 'health [<项目>] [--project 项目名] [--all] [--root 目录] [--json]',
    options: ['project', 'all', 'root', 'json'],
    desc: '**条目层体检（真值出口，读数不是门禁）**：条目化节点数/总数、条目数（按 type）、无出处/未核/'
      + '需复核/出处失效/最后核验时间、`items ↔ detail` 不一致的节点（逐节点点名 + 修法）、'
      + '悬挂引用、`qa` 残留、迁移"跳过"的节点与原因分布。不给项目名 = 整个库。'
      + '**确定**：同状态两次运行逐字节相同（契约 docs/ITEM-MODEL.md §10 AC14）',
    fn: healthCmd.health
  }
];

/* 整合流未落盘时按原文自注册（用 registry 的公开 API，不改 registry.js）；
 * 整合流落盘之后 `registry.get` 已有 ⇒ 跳过。两处原文的 `usage` / `options` / `desc` **逐字相同**
 * （唯一差别只可能是 `fn` 的取法：registry 里写 `loadFile('recheck').recheck`，这里直接引用模块
 * —— 与 S2 那六条同一形态），所以不会漂移。 */
REGISTER_LINES.forEach((e) => { if (!registry.get(e.name)) registry.register(e); });

/* ============================================================================
 * ③ 夹具与工具
 * ========================================================================== */
const P = 'it-s4-probe';        // 只读断言：三类 / 计数 / 原因分布
const F = 'it-s4-flow';         // 注入证明：改源文件 ⇒ needs-recheck ⇒ src-gone
const W = 'it-s4-write';        // 写回：--write-verified / --only / --force / --dry-run
const H = 'it-s4-health';       // 体检：不一致 / 残留 / 悬挂 / 迁移五档

const REFS = path.join(SANDBOX, 'refs');
const SPEC = path.join(REFS, 'spec.md');
const OTHER = path.join(REFS, 'other.md');
const FLOW = path.join(REFS, 'flow.md');

const SPEC_TEXT = ['# 规格', '', '## 甲', '- 第一条', '- 第二条', ''].join('\n');
const OTHER_TEXT = ['# 另一个', '- 甲', ''].join('\n');
const FLOW_TEXT = ['# 流程', '- 甲', ''].join('\n');

const OLD = '2020-01-01T00:00:00.000Z';    // 夹具里的"核验时刻"（**过去**，好让 mtime 能比它新）
const MAXAT = '2026-01-01T00:00:00.000Z';  // 用来钉住"最后核验时间 = 数据里的最大值"

const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const readBytes = (name) => fs.readFileSync(projFile(name));                  // Buffer：逐字节判据
const readJson = (name) => JSON.parse(fs.readFileSync(projFile(name), 'utf8').replace(/^\uFEFF/, ''));
const journalFile = (name) => path.join(SANDBOX, name, '.changes.jsonl');
const journalText = (name) => { try { return fs.readFileSync(journalFile(name), 'utf8'); } catch (e) { return ''; } };

/** 跑一条命令（进程内同步）：返回 { code, out }（stdout+stderr 合并，与集成脚本同口径） */
function run(...args) {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}
/** 跑一条 `--json` 命令：**输出必须是一份可解析 JSON**（契约 §3 通用约定） */
function runJson(...args) {
  const r = run(...args);
  return { code: r.code, out: r.out, json: JSON.parse(r.out) };
}
/** 直接改盘上的项目 JSON（**夹具**用：造 verified 的旧时刻 / 悬挂 / 残留在真命令里造不出来） */
function patch(name, fn) {
  const j = readJson(name);
  fn(j);
  fs.writeFileSync(projFile(name), JSON.stringify(j, null, 2), 'utf8');
}
function nodeOf(j, id) {
  let hit = null;
  (function walk(n) { if (!n || hit) return; if (n.id === id) { hit = n; return; } (n.children || []).forEach(walk); })(j.data);
  return hit;
}
const nodeIn = (name, id) => nodeOf(readJson(name), id);
const itemsIn = (name, id) => (nodeIn(name, id) || {}).items || [];
const itemIn = (name, id, k) => itemsIn(name, id)[k || 0];
const itemIdIn = (name, id, k) => (itemIn(name, id, k) || {}).id;

/** `refs/*.md` 的 mtime 钉到过去（好让"核验之后源又改过"这个判据可复现，不依赖运行时刻） */
function pinOld(file) {
  const t = new Date('2019-01-01T00:00:00.000Z');
  fs.utimesSync(file, t, t);
}

/* ---- P 的条目设计（nodeId, src, verifiedAt）---- */
const P_ITEMS = [
  { node: 'n-ok', src: 'refs/spec.md:4::第一条', ver: OLD },          // 就绪
  { node: 'n-quote', src: 'refs/spec.md:4::第1条', ver: OLD },        // 引文不在文件里 ⇒ src-gone
  { node: 'n-gone', src: 'refs/gone.md:1', ver: OLD },                // 文件不存在 ⇒ src-gone
  { node: 'n-stale', src: 'refs/other.md:2::甲', ver: OLD },          // other.md mtime 比 OLD 新 ⇒ file-changed
  { node: 'n-line', src: 'refs/spec.md:999', ver: OLD },              // 行号越界（无引文）
  { node: 'n-unver', src: 'refs/spec.md:4::第一条', ver: null },      // 出处对得上，但没核过
  { node: 'n-nosrc', src: null, ver: null },                          // 无出处、没核过
  { node: 'n-nosrcver', src: null, ver: MAXAT },                      // 无出处，但核过 ⇒ ok
  { node: 'n-url', src: 'https://example.com/a', ver: OLD },          // URL 不可机核
  { node: 'n-cmd', src: 'npm run verify', ver: OLD },                 // 命令型不可机核
  { node: 'n-unk', src: '「待做清单」A 档第一条', ver: OLD },           // 形状认不出
  { node: 'n-sup', src: 'refs/spec.md:4::第一条', ver: OLD, supersededBy: 'i-missing-xyz' }
];

beforeAll(() => {
  /* ---- 出处文件（**都在沙箱里**：绝不拿真实仓库当夹具）---- */
  fs.mkdirSync(REFS, { recursive: true });
  fs.writeFileSync(SPEC, SPEC_TEXT, 'utf8');
  fs.writeFileSync(OTHER, OTHER_TEXT, 'utf8');
  fs.writeFileSync(FLOW, FLOW_TEXT, 'utf8');
  pinOld(SPEC);
  pinOld(FLOW);                       // OTHER 故意保持"刚写过"（mtime 比 OLD 新 ⇒ stale 那一档）

  /* ---- P：只读断言用 ---- */
  expect(run('init', P, '--title', 'S4 复校探针').code).toBe(0);
  P_ITEMS.forEach((def) => {
    expect(run('add', P, 'root', '--id', def.node, '--topic', '节点 ' + def.node).code).toBe(0);
    const args = ['item-add', P, def.node, '--html', '<p>内容 ' + def.node + '</p>'];
    if (def.src !== null) args.push('--src', def.src);
    expect(run.apply(null, args).code).toBe(0);
  });
  patch(P, (j) => {
    P_ITEMS.forEach((def) => {
      const it = itemOfNode(j, def.node);
      if (def.src === null) delete it.src; else it.src = def.src;
      if (def.ver) it.verified = { at: def.ver, by: 'test:fixture', how: '夹具' };
      else delete it.verified;
      if (def.supersededBy) it.supersededBy = def.supersededBy;
    });
  });

  /* ---- F：注入证明用（单条，源文件从这里开始是"核验之后没动过"的）---- */
  expect(run('init', F, '--title', 'S4 过渡探针').code).toBe(0);
  expect(run('add', F, 'root', '--id', 'f-one', '--topic', '过渡').code).toBe(0);
  expect(run('item-add', F, 'f-one', '--html', '<p>甲</p>', '--src', 'refs/flow.md:2::甲').code).toBe(0);
  patch(F, (j) => { itemOfNode(j, 'f-one').verified = { at: OLD, by: 'test:fixture', how: '夹具' }; });

  /* ---- W：写回用 ---- */
  expect(run('init', W, '--title', 'S4 写回探针').code).toBe(0);
  [['w-ok', 'refs/spec.md:4::第一条'], ['w-gone', 'refs/gone.md:1'],
    ['w-bad', 'refs/spec.md:4::第1条'], ['w-nosrc', null]].forEach((pair) => {
    expect(run('add', W, 'root', '--id', pair[0], '--topic', pair[0]).code).toBe(0);
    const args = ['item-add', W, pair[0], '--html', '<p>' + pair[0] + '</p>'];
    if (pair[1]) args.push('--src', pair[1]);
    expect(run.apply(null, args).code).toBe(0);
  });

  /* ---- H：体检用（不一致 / 残留 / 悬挂 / 迁移五档）---- */
  expect(run('init', H, '--title', 'S4 体检探针').code).toBe(0);
  ['h-ok', 'h-bad', 'h-qa', 'h-dm'].forEach((id) => {
    expect(run('add', H, 'root', '--id', id, '--topic', id).code).toBe(0);
    expect(run('item-add', H, id, '--html', '<p>' + id + '</p>').code).toBe(0);
  });
  ['h-v2qa', 'h-eli', 'h-skip', 'h-nolist', 'h-empty', 'h-dangle'].forEach((id) => {
    expect(run('add', H, 'root', '--id', id, '--topic', id).code).toBe(0);
  });
  patch(H, (j) => {
    nodeOf(j, 'h-bad').detail = '<p>被别人改过</p>';                 // items ↔ detail 不一致
    nodeOf(j, 'h-qa').qa = [{ q: '', a: '答', at: OLD }];            // 条目化节点上的 qa 残留
    nodeOf(j, 'h-dm').detailMode = 'rich';                           // 条目化节点上的 detailMode
    nodeOf(j, 'h-v2qa').qa = [{ q: '', a: '答2', at: OLD }];         // v2 节点上的 qa[]：**不是**残留
    nodeOf(j, 'h-eli').detail = '<ul><li>甲</li></ul>';              // 可迁移
    nodeOf(j, 'h-skip').detail = '<ul><li>甲</ul>';                  // 在范围内但回放不了 ⇒ 跳过
    nodeOf(j, 'h-nolist').detail = '<p>纯段落</p>';                   // 不在范围（无 <li>）
    nodeOf(j, 'h-dangle').links = [{ project: H, id: 'h-ok', item: 'i-nope' }];
    j.assoc = [{ id: 'a1', title: '关联甲', members: [{ project: H, id: 'h-ok', item: 'i-nope2' }] }];
  });
});

afterAll(() => {
  cleanupAll();
});

/** `patch` 里的取条目（与 `itemIn` 同口径，但作用在"还没落盘的 j"上） */
function itemOfNode(j, id, k) { return (nodeOf(j, id).items || [])[k || 0]; }

/* ============================================================================
 * A. `src/item-src.js` —— 出处这一维的唯一实现处
 * ========================================================================== */
describe('S4-A item-src：归一化 / 解析 / 与检索面同口径', () => {
  /* ⚠️ 这一组**改过口径**（第四批："出处"这一维的两份同口径实现收成一处）：
   *   · 改前：`item-src.normalizeSrc` 与 `item-index.srcList` 是**两份实现**（各写一遍
   *     "只留非空字符串"的谓词）⇒ 这里做**真模块对真模块的交叉断言**，守的是"两份实现一致"；
   *   · 现在：归一化收成**一处实现**（唯一实现在 `src/item-index.js` 的 `srcList()`，
   *     `normalizeSrc` 是它的薄适配）⇒ 再"比对两份实现"就是同一个函数对自己，**恒真 = 空转**。
   *   · 故改成守**这一处实现的形状**：逐样本的期望值**写死在用例里**（谁改了归一化口径 ——
   *     开始去重 / 开始把非字符串转成字符串 / 开始 trim / 开始折叠空串数组 —— 立刻红），
   *     外加一条**结构断言**：适配层不许把那套谓词再抄一遍（抄回去就红）。
   *   判别力（两条都不是空转，**已各自注入实测**）：
   *     ① 把 `srcList` 的谓词放松成 `s.length >= 0`（不再剔空串）⇒ 第一组必红
   *        （实测 1 failed / 35 passed，红的正是这个用例）；还原后文件 SHA-256 逐字节还原；
   *     ② 在 `normalizeSrc` 里加一句 `Array.isArray(v);`（**行为不变**，只是这一侧又出现了那套谓词）
   *        ⇒ 第二组必红（实测 1 failed / 35 passed）；还原后 SHA-256 逐字节还原。 */
  it('归一化只有一个实现：`srcList` 的形状逐样本钉死，`normalizeSrc` 只许调它', () => {
    const samples = [
      [undefined, []],                    // 没有 src 键
      [null, []],
      ['', []],                           // 空串不是出处
      ['CHANGELOG.md:713', ['CHANGELOG.md:713']],        // 单串 ⇒ 单元素数组（形状统一）
      [['a', '', 'b'], ['a', 'b']],                      // 保序；空串剔掉
      [['a', 'a'], ['a', 'a']],                          // **不去重**（重复是数据的事）
      [42, []],                                          // 非字符串 ⇒ 剔掉，**不**变成 '42'
      [[3, 'x'], ['x']],                                 // 数组里混非字符串：只留字符串
      [{}, []],
      [['', ''], []],
      ['refs/spec.md:4::第一条', ['refs/spec.md:4::第一条']]   // 引文扩展形式逐字保留（不切、不 trim）
    ];
    samples.forEach(([v, want]) => {
      expect(itemSrc.normalizeSrc(v), 'normalizeSrc ' + JSON.stringify(v)).toEqual(want);
      expect(itemIndex.srcList({ src: v }), 'srcList ' + JSON.stringify(v)).toEqual(want);
    });
  });

  it('`normalizeSrc` 是 `srcList` 的**薄适配**：归一化的谓词不许在这一侧再写一份', () => {
    const text = fs.readFileSync(SRC_ITEM_SRC, 'utf8');
    const body = /function normalizeSrc\(v\)\s*\{([\s\S]*?)\n\}/.exec(text);
    // 锚点找不到 = 这条判据测不了任何东西 ⇒ 判红（绝不把"定位失败"当通过）
    expect(body, 'src/item-src.js 里必须能找到 `function normalizeSrc(v) { … }`').toBeTruthy();
    expect(body[1]).toContain('itemIndex.srcList(');           // 正：真的走那一处实现
    expect(body[1]).not.toMatch(/Array\.isArray\(v\)/);        // 反：没有自己那份归一化谓词
  });

  it('parseRef：契约 §1 的三种形状 + 引文扩展 + 认不出的形状', () => {
    const a = itemSrc.parseRef('CHANGELOG.md:713-717');
    expect([a.kind, a.file, a.line, a.to, a.quote]).toEqual(['file', 'CHANGELOG.md', 713, 717, null]);
    const b = itemSrc.parseRef('docs/ITEM-MODEL.md:66::逐字节相等');
    expect([b.kind, b.file, b.line, b.quote]).toEqual(['file', 'docs/ITEM-MODEL.md', 66, '逐字节相等']);
    const c = itemSrc.parseRef('C:\\work\\x.md:3');                 // 带盘符的绝对路径也要切对
    expect([c.kind, c.file, c.line, c.absolute]).toEqual(['file', 'C:\\work\\x.md', 3, true]);
    const d = itemSrc.parseRef('README.md');
    expect([d.kind, d.file, d.line]).toEqual(['file', 'README.md', null]);
    expect(itemSrc.parseRef('https://example.com/a').kind).toBe('url');
    expect(itemSrc.parseRef('npm run verify').kind).toBe('command');
    expect(itemSrc.parseRef('「待做清单」A 档第一条').kind).toBe('unknown');
  });

  /* ⚠️ 这一组**改过口径**（第五批："空 needle"这一维收成一处实现 + 两层分工）：
   *   · 改前：本侧 `matchesSrc` 与 `item-index.passItemFilters` 里那行
   *     `list.some(s => s.indexOf(f.src) >= 0)` 是**两份同口径实现**，而且**已经漂** ——
   *     空 needle 这边判 `false`（不命中）、那边整段跳过（= 没给过滤）⇒ 同一个输入两种裁断；
   *   · 现在：匹配的唯一实现在 `src/item-index.js` 的 `srcMatches()`，本侧的 `matchesSrc`
   *     是它的**薄转发**（方向：本模块 Node-only → 那边 UMD 双端，与 `normalizeSrc` 同一条理由）。
   *     契约逐字见 `srcMatches()` 的注释：**空 needle 不是过滤条件 —— 判断"有没有过滤"归过滤层；
   *     匹配函数的契约是 needle 非空**。
   *   · 下面四条期望值是**收口前的原读数**（一条不动 ⇒ 证明"行为没变"），
   *     另加"同一个函数"的逐样本对照 + 一条结构断言（这一侧不许再有自己那份子串判定）。
   *   判别力：把过滤层那句 `if (f.src)` 改成 `if (f.src !== undefined)` ⇒
   *   `tests/item-index.test.js` 里写死的那条期望值**必红**（实测读数见交付）。 */
  it('`matchesSrc(x, \'\') === false`（空 needle 不是命中），且它是 `itemIndex.srcMatches` 的薄转发', () => {
    expect(itemSrc.matchesSrc({ src: ['CHANGELOG.md:713-717'] }, 'CHANGELOG')).toBe(true);
    expect(itemSrc.matchesSrc({ src: 'refs/spec.md:4::第一条' }, 'spec.md')).toBe(true);
    expect(itemSrc.matchesSrc({ src: 'refs/spec.md:4::第一条' }, 'nope')).toBe(false);
    expect(itemSrc.matchesSrc({ src: 'refs/spec.md' }, '')).toBe(false);
    // 薄转发 ⇒ 同一批样本（含空 needle / 数组形状 / 没有 src）必须与**唯一实现**逐条同读数
    [
      [{ src: ['CHANGELOG.md:713-717'] }, 'CHANGELOG'],
      [{ src: 'refs/spec.md:4::第一条' }, 'spec.md'],
      [{ src: 'refs/spec.md:4::第一条' }, 'nope'],
      [{ src: 'refs/spec.md' }, ''],
      [{ src: null }, 'x'],
      [{}, 'x'],
      [['a', '', 'b'], 'b']
    ].forEach((pair) => {
      expect(itemSrc.matchesSrc(pair[0], pair[1]), JSON.stringify(pair)).toBe(itemIndex.srcMatches(pair[0], pair[1]));
    });
    // 结构断言：这一侧**不许**再有自己那份子串判定（抄回去就红）
    const body = /function matchesSrc\(itemOrSrc, needle\)\s*\{([\s\S]*?)\n\}/.exec(fs.readFileSync(SRC_ITEM_SRC, 'utf8'));
    expect(body, 'src/item-src.js 里必须能找到 `function matchesSrc(itemOrSrc, needle) { … }`').toBeTruthy();
    expect(body[1]).toContain('itemIndex.srcMatches(');     // 正：真的走那一处实现
    expect(body[1]).not.toContain('indexOf');               // 反：没有自己那份匹配谓词
  });

  /* 端到端（真的过 CLI 与命令层）：`search <项目> <关键词> --src=` 的读数**写死**在这里。
   * 裁决口径（第五批）：空 needle 不是过滤条件 ⇒ `--src=` = **没给过滤**。
   * 为什么必须端到端一条：`--src` 在**两处**被读（检索面 `search` / 复校面 `recheck`），
   * 而且"给没给条目级过滤"还连带决定"要不要返回节点级命中"（`item-index` 的 `onlyItems`）——
   * 只有真走一遍 CLI，才钉得住"空串既不变成 0 命中、也不变成'空串过滤器'"。 */
  it('端到端：`search <项目> 关键词 --src=` = 没给过滤（条目面与节点面都不是"空串过滤器"）', () => {
    const nodes = (j) => j.hits.map((h) => h.nodeId);
    const all = runJson('search', P, '内容', '--json').json;                  // 条目面：12 条条目正文都含「内容」
    const empty = runJson('search', P, '内容', '--src=', '--json').json;
    expect(all.hitCount).toBe(P_ITEMS.length);                               // 写死的期望：12
    expect(empty.hitCount).toBe(P_ITEMS.length);                             // `--src=` ⇒ 一条不少（不是 0 命中）
    expect(nodes(empty)).toEqual(nodes(all));                                // 逐条同序
    const filtered = runJson('search', P, '内容', '--src', 'spec.md', '--json').json;
    expect(filtered.hitCount).toBe(5);                                       // 对照：非空 needle 真的在过滤
    expect(empty.hitCount).not.toBe(filtered.hitCount);
    expect(runJson('search', P, '内容', '--src', 'no-such-needle', '--json').json.hitCount).toBe(0);
    // 节点面：`--src` 一旦算"给了"就只返回条目级命中 ⇒ 空串**不算给了**，节点命中照旧在
    const nodeAll = runJson('search', P, '节点', '--json').json;
    const nodeEmpty = runJson('search', P, '节点', '--src=', '--json').json;
    expect(nodeAll.hits.every((h) => h.itemId === null)).toBe(true);
    expect(nodeAll.hitCount).toBe(P_ITEMS.length);
    expect(nodeEmpty.hitCount).toBe(nodeAll.hitCount);
    expect(runJson('search', P, '节点', '--src', 'spec.md', '--json').json.hitCount).toBe(0);
  });

  it('judge() 是三态字符串；inspect() 给逐条 ref + reasons（同一份裁决，两处不漂移）', () => {
    const cache = itemSrc.createCache();
    const okItem = itemIn(P, 'n-ok');
    expect(itemSrc.judge(okItem, SANDBOX, { cache: cache })).toBe('ok');
    expect(itemSrc.judge(itemIn(P, 'n-quote'), SANDBOX, { cache: cache })).toBe('src-gone');
    expect(itemSrc.judge(itemIn(P, 'n-unver'), SANDBOX, { cache: cache })).toBe('needs-recheck');
    const insp = itemSrc.inspect(itemIn(P, 'n-quote'), SANDBOX, { cache: cache });
    expect(insp.verdict).toBe(itemSrc.judge(itemIn(P, 'n-quote'), SANDBOX, { cache: cache }));
    expect(insp.refs[0].code).toBe('quote-missing');
    expect(insp.reasons.map((r) => r.code)).toContain('quote-missing');
  });

  it('同一个文件在同一次运行里**只读一次**（"文件级指纹做廉价前置"的落地形态）', () => {
    const cache = itemSrc.createCache();
    const items = [itemIn(P, 'n-ok'), itemIn(P, 'n-unver'), itemIn(P, 'n-sup')];   // 三条都指 refs/spec.md
    items.forEach((it) => itemSrc.judge(it, SANDBOX, { cache: cache }));
    expect(cache.reads).toBe(1);
    expect(cache.files.size).toBe(1);
  });
});

/* ============================================================================
 * B. recheck：三类 + 计数 + 只读
 * ========================================================================== */
describe('S4-B recheck：三类 / 计数 / 只读（不写盘）', () => {
  it('**只读**：跑一次（文本 + --json），项目 JSON 与 .changes.jsonl **逐字节不变**', () => {
    const beforeFile = readBytes(P);
    const beforeLog = journalText(P);
    const t = run('recheck', P, '--root', SANDBOX);
    expect(t.code).toBe(0);
    expect(t.out).toContain('复校 ' + P);
    const j = runJson('recheck', P, '--root', SANDBOX, '--json');
    expect(j.code).toBe(0);
    expect(readBytes(P).equals(beforeFile)).toBe(true);
    expect(journalText(P)).toBe(beforeLog);          // 只读命令连变更日志都不动（工程纪律）
  });

  it('三类 + 计数（判据写在 criteria 里；每个数字都能对着裁决表核）', () => {
    const j = runJson('recheck', P, '--root', SANDBOX, '--json').json;
    expect(j.counts).toMatchObject({
      items: 12, ok: 2, needsRecheck: 8, srcGone: 2, noSrc: 2, unverified: 2, stale: 1,
      superseded: 1, dangling: 1, itemizedNodes: 12, nodes: 13
    });
    expect(j.byVerdict.ok.map((e) => e.itemId).sort())
      .toEqual([itemIdIn(P, 'n-ok'), itemIdIn(P, 'n-nosrcver')].sort());
    expect(j.byVerdict.srcGone.map((e) => e.nodeId).sort()).toEqual(['n-gone', 'n-quote']);
    expect(typeof j.criteria['needs-recheck']).toBe('string');    // 读数带判据，不许只给数字
  });

  it('原因分布**逐码点名**（closed 取值表；0 的键也在，顺序固定 ⇒ 确定性）', () => {
    const j = runJson('recheck', P, '--root', SANDBOX, '--json').json;
    expect(j.reasonCounts).toMatchObject({
      'src-gone': 1, 'quote-missing': 1, 'line-out-of-range': 1, 'file-changed': 1,
      'unverifiable-url': 1, 'unverifiable-command': 1, 'unrecognized-src': 1,
      'no-src': 2, unverified: 2, 'superseded-unknown': 1
    });
    expect(Object.keys(j.reasonCounts)).toEqual(itemSrc.REASONS.slice());
  });

  it('逐条点名 + **可执行的下一步**（一条也不能只说"要复核"）', () => {
    const j = runJson('recheck', P, '--root', SANDBOX, '--json').json;
    j.byVerdict.needsRecheck.forEach((e) => {
      expect(e.nextSteps.length, e.itemId + ' 没有下一步').toBeGreaterThan(0);
      expect(e.nextSteps.join(' ')).toMatch(/`?(recheck|item-edit|item-remove|links-prune|assoc-prune)/);
    });
    const txt = run('recheck', P, '--root', SANDBOX).out;
    ['n-gone', 'n-quote', 'n-sup'].forEach((nodeId) => expect(txt).toContain(nodeId));
    expect(txt).toContain('下一步（可执行）');
  });

  it('`--src <子串>`：只列出处含该子串的条目（计数与清单同源）', () => {
    const j = runJson('recheck', P, '--root', SANDBOX, '--src', 'refs/spec.md', '--json').json;
    const all = [].concat(j.byVerdict.ok, j.byVerdict.needsRecheck, j.byVerdict.srcGone);
    expect(all.length).toBeGreaterThan(0);
    all.forEach((e) => expect(e.src.join(' ')).toContain('refs/spec.md'));
    expect(j.listed.filteredBySrc).toBe('refs/spec.md');
  });

  /* 【批7】`--src=`（**显式空串**）这一档的口径收准：与"没给过滤"**同义**。
   * 权威契约句在 `src/item-index.js` 的 `srcMatches()` 注释里：**空 needle 不是过滤条件 ——
   * 判断"有没有过滤"归过滤层**（检索面 `passItemFilters` 开头的 `if (f.src)` 判的就是"给了没有"）。
   * 收准前：`filteredBySrc` 回显 `""` ⇒ 同一个输入在 `search` 面是"没给过滤"、在 `recheck` 面回显成
   * "给了一个空过滤器"（**两处口径漂移**）；现在两处同读数。判定与理由写在
   * `cli/commands/recheck.js` 的 `srcFilter` 那一段上（动作现场）。
   * 判别力（**已注入实测**）：把 `recheck.js` 那行改回
   * `(…=== undefined || …=== true) ? null : String(…)` ⇒ 本用例**必红**，且注入下量的读数是：
   * 两份 `--json` **只差 1 个字段**（`listed.filteredBySrc`：`null` → `""`），**文本面仍逐字节相同**
   * （⇒ 这条口径只在机器可判的那一面看得出来，正是 `--json` 要把它收准的理由）。还原后 SHA-256 还原。 */
  it('`--src=`（显式空串）= **没给过滤**：与不给 `--src` 的 `--json` 逐字节相同', () => {
    const noSrc = runJson('recheck', P, '--root', SANDBOX, '--json');
    const empty = runJson('recheck', P, '--root', SANDBOX, '--src=', '--json');
    expect(empty.code, empty.out).toBe(0);
    expect(empty.json.listed.filteredBySrc, 'null = 没给过滤（不是"空串过滤器"）').toBe(null);
    expect(empty.out, '`--src=` 与不给 `--src` 的 --json 输出逐字节相同').toBe(noSrc.out);
    // 文本面同样逐字节相同：两个输出面都不许留下"空串过滤器"的痕迹
    expect(run('recheck', P, '--root', SANDBOX, '--src=').out)
      .toBe(run('recheck', P, '--root', SANDBOX).out);
    // 对照（防空转：只断言 null 的判据会在"永远 null"下恒真）：非空 needle **真的在过滤**
    const filtered = runJson('recheck', P, '--root', SANDBOX, '--src', 'refs/spec.md', '--json');
    expect(filtered.json.listed.filteredBySrc).toBe('refs/spec.md');
    expect(filtered.out).not.toBe(empty.out);
    // 裸写 `--src`（没有值）解析成 `true` ⇒ 同"没给过滤"（不是"拿 true 去 indexOf"）
    expect(runJson('recheck', P, '--root', SANDBOX, '--src', '--json').json.listed.filteredBySrc).toBe(null);
    /* 边界**只认字面空串、不 trim** —— 这条口径在两个面上都要成立（注释里的断言不许只是推断）：
     * 空白串 `'  '` 是**真值** ⇒ 两个面都按"**给了过滤**"走（检索面真去匹配 ⇒ 0 命中；
     * 复校面回显 `'  '`、清单空）。想统一成"按宽度判空"就得**连检索面一起改**，
     * 不许只在一个面上 trim（那正是第五批收掉的那类"同一个输入两种口径"）。 */
    expect(runJson('search', P, '内容', '--src', '  ', '--json').json.hitCount, '检索面：空白串算给了过滤（0 命中）').toBe(0);
    const ws = runJson('recheck', P, '--root', SANDBOX, '--src', '  ', '--json');
    expect(ws.json.listed.filteredBySrc, '复校面：空白串算给了过滤（原样回显，不 trim 成 null）').toBe('  ');
    expect([].concat(ws.json.byVerdict.ok, ws.json.byVerdict.needsRecheck, ws.json.byVerdict.srcGone))
      .toEqual([]);
  });

  it('`--only i-a,i-b`：只列点名的条目；点名不存在的 id ⇒ 响亮拒绝（exit 1 + 指名）', () => {
    const a = itemIdIn(P, 'n-ok');
    const b = itemIdIn(P, 'n-gone');
    const j = runJson('recheck', P, '--root', SANDBOX, '--only', a + ',' + b, '--json').json;
    const ids = [].concat(j.byVerdict.ok, j.byVerdict.needsRecheck, j.byVerdict.srcGone).map((e) => e.itemId);
    expect(ids.sort()).toEqual([a, b].sort());
    const bad = run('recheck', P, '--root', SANDBOX, '--only', 'i-does-not-exist');
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('i-does-not-exist');
  });

  it('非法选项值：`--limit abc` 当场报错并给允许范围（不静默退化成默认值）', () => {
    const r = run('recheck', P, '--root', SANDBOX, '--limit', 'abc');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--limit');
    expect(r.out).toMatch(/整数/);
  });
});

/* ============================================================================
 * C. 注入证明：改一个源文件 ⇒ needs-recheck；引文消失 ⇒ src-gone
 * ========================================================================== */
describe('S4-C 注入证明：源文件变了，条目自己会说出来', () => {
  it('ok →（改源文件）→ needs-recheck（file-changed）→（引文没了）→ src-gone（quote-missing）', () => {
    const item = itemIn(F, 'f-one');
    const v1 = itemSrc.judge(item, SANDBOX, { cache: itemSrc.createCache() });
    expect(v1).toBe('ok');                                   // 源文件 mtime 早于核验时刻 ⇒ 就绪

    fs.appendFileSync(FLOW, '- 追加一行\n', 'utf8');          // ① **改一个源文件**
    const v2 = itemSrc.judge(item, SANDBOX, { cache: itemSrc.createCache() });
    expect(v2).toBe('needs-recheck');                        // ② 变成"要复核"
    const j2 = runJson('recheck', F, '--root', SANDBOX, '--json').json;
    const e2 = j2.byVerdict.needsRecheck[0];
    expect(e2.reasons.map((r) => r.code)).toContain('file-changed');
    expect(j2.counts.stale).toBe(1);
    expect(j2.byVerdict.ok.length).toBe(0);

    fs.writeFileSync(FLOW, '# 流程\n- 乙\n', 'utf8');          // ③ 引文"甲"整条没了（连子串也找不着）
    const v3 = itemSrc.judge(item, SANDBOX, { cache: itemSrc.createCache() });
    expect(v3).toBe('src-gone');
    const j3 = runJson('recheck', F, '--root', SANDBOX, '--json').json;
    expect(j3.byVerdict.srcGone[0].reasons.map((r) => r.code)).toContain('quote-missing');
  });
});

/* ============================================================================
 * D. 写回：--write-verified
 * ========================================================================== */
describe('S4-D recheck --write-verified：显式、可判、不静默', () => {
  it('`--write-verified` 不给 `--how` ⇒ 拒绝；`--how` 不给 `--write-verified` ⇒ 也拒绝（零写盘）', () => {
    const before = readBytes(W);
    const a = run('recheck', W, '--root', SANDBOX, '--write-verified');
    expect(a.code).not.toBe(0);
    expect(a.out).toContain('--how');
    const b = run('recheck', W, '--root', SANDBOX, '--how', '随便写的');
    expect(b.code).not.toBe(0);
    expect(b.out).toContain('--write-verified');
    expect(readBytes(W).equals(before)).toBe(true);
  });

  it('`--dry-run`：出计划、**不写盘**', () => {
    const before = readBytes(W);
    const r = run('recheck', W, '--root', SANDBOX, '--write-verified', '--how', '读了源文件', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('不写盘');
    expect(r.out).toContain('w-ok');
    expect(readBytes(W).equals(before)).toBe(true);
  });

  it('真写：只写"出处这一维判得过"的条目（w-ok），被排除的**逐条点名 + 原因**', () => {
    const before = readBytes(W);
    const logBefore = journalText(W).split('\n').filter(Boolean).length;
    const detailsBefore = ['w-ok', 'w-gone', 'w-bad', 'w-nosrc']
      .map((id) => JSON.stringify((nodeIn(W, id) || {}).detail));
    const j = runJson('recheck', W, '--root', SANDBOX, '--write-verified', '--how', '读了 src 指向的源码行',
      '--json').json;
    expect(j.written).toBe(1);
    expect(j.itemIds).toEqual([itemIdIn(W, 'w-ok')]);
    expect(j.notWritten.itemIds.sort()).toEqual([itemIdIn(W, 'w-gone'), itemIdIn(W, 'w-bad'),
      itemIdIn(W, 'w-nosrc')].sort());
    expect(j.notWritten.reasonCounts['src-gone']).toBe(1);        // w-gone：文件没了
    expect(j.notWritten.reasonCounts['quote-missing']).toBe(1);   // w-bad：文件在，引文不在
    expect(j.notWritten.reasonCounts['no-src']).toBe(1);          // w-nosrc：没有出处（要 --only 点名）

    const it = itemIn(W, 'w-ok');
    expect(it.verified.how).toBe('读了 src 指向的源码行');
    expect(it.verified.by).toBe('cli:recheck');                   // 与 .changes.jsonl 的 writer 同源
    expect(Number.isFinite(Date.parse(it.verified.at))).toBe(true);
    expect(it.by).toBe('cli:recheck');

    // **只动 verified**：detail 是派生缓存，核验记录不该改渲染产物
    const detailsAfter = ['w-ok', 'w-gone', 'w-bad', 'w-nosrc']
      .map((id) => JSON.stringify((nodeIn(W, id) || {}).detail));
    expect(detailsAfter).toEqual(detailsBefore);
    // `.changes.jsonl` **只多 1 条**（一次原子写、一条日志）
    expect(journalText(W).split('\n').filter(Boolean).length).toBe(logBefore + 1);
    expect(readBytes(W).equals(before)).toBe(false);
  });

  it('写后复查：w-ok 转「已就绪」；`--only` 点名无出处的条目也能写（我逐条负责）', () => {
    const after = runJson('recheck', W, '--root', SANDBOX, '--json').json;
    expect(after.byVerdict.ok.map((e) => e.itemId)).toEqual([itemIdIn(W, 'w-ok')]);
    const r = runJson('recheck', W, '--root', SANDBOX, '--only', itemIdIn(W, 'w-nosrc'),
      '--write-verified', '--how', '我按别的方式核了', '--json').json;
    expect(r.written).toBe(1);
    expect(r.targetsRule).toContain('--only');
    const again = runJson('recheck', W, '--root', SANDBOX, '--json').json;
    expect(again.byVerdict.ok.length).toBe(2);
    expect(itemIn(W, 'w-nosrc').verified.how).toBe('我按别的方式核了');
  });

  it('出处**已失效**的条目：默认拒写（那是假话），`--force` 才放行且仍报 src-gone', () => {
    const id = itemIdIn(W, 'w-gone');
    const refused = run('recheck', W, '--root', SANDBOX, '--only', id, '--write-verified', '--how', '核了');
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('--force');
    expect(itemIn(W, 'w-gone').verified).toBeUndefined();
    const forced = runJson('recheck', W, '--root', SANDBOX, '--only', id, '--write-verified',
      '--how', '源码确实不在本机，按别的凭据核了', '--force', '--json').json;
    expect(forced.written).toBe(1);
    const after = runJson('recheck', W, '--root', SANDBOX, '--json').json;
    expect(after.byVerdict.srcGone.map((e) => e.itemId)).toContain(id);   // 强写不改判定
  });

  it('`--idem` 重放 ⇒ 不重复执行（WRITE_COMMANDS 落地后自动生效；落地前按设计响亮拒绝）', () => {
    const id = itemIdIn(W, 'w-ok');
    const registered = core.WRITE_COMMANDS.indexOf('recheck') >= 0;
    const a = run('recheck', W, '--root', SANDBOX, '--only', id, '--write-verified',
      '--how', '第一次', '--idem', 'it-s4-idem-1');
    if (!registered) {
      // 整合流还没把 `recheck` 加进 WRITE_COMMANDS ⇒ 幂等键按设计被**响亮拒绝**（不是本流代码问题）
      expect(a.code).not.toBe(0);
      expect(a.out).toContain('--idem 只对**写命令**有意义');
      expect(a.out).toContain('WRITE_COMMANDS');
      return;
    }
    expect(a.code).toBe(0);
    const afterFirst = readBytes(W);
    const b = run('recheck', W, '--root', SANDBOX, '--only', id, '--write-verified',
      '--how', '第一次', '--idem', 'it-s4-idem-1');
    expect(b.code).toBe(0);
    expect(b.out).toContain('幂等命中');
    expect(readBytes(W).equals(afterFirst)).toBe(true);          // 重放：盘上逐字节不变
  });
});

/* ============================================================================
 * E. health：读数 / 确定性 / 逐节点点名 / 迁移五档
 * ========================================================================== */
describe('S4-E health：条目层体检（读数不是门禁）', () => {
  const json = () => runJson('health', H, '--root', SANDBOX, '--json').json;

  it('**确定性**：同状态两次 `--json` 逐字节相同；且不带运行时刻（读数取自数据）', () => {
    const a = run('health', H, '--root', SANDBOX, '--json');
    const b = run('health', H, '--root', SANDBOX, '--json');
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
    const j = JSON.parse(a.out);
    expect(j.items.lastVerifiedAt).toBe(null);        // H 的条目都没 verified ⇒ 不能编一个 now 出来
    expect(Object.keys(j)).not.toContain('generatedAt');
    expect(Object.keys(j)).not.toContain('at');
  });

  it('条目化节点数 / 总节点数 / 条目数（按 type）+ 无出处·未核·需复核·出处失效', () => {
    const j = json();
    expect(j.nodes).toMatchObject({ total: 11, itemized: 4, rich: 0, v2: 7 });
    expect(j.items.total).toBe(4);
    expect(j.items.byType).toEqual({ text: 4, rich: 0, qa: 0 });
    expect(j.items.noSrc).toBe(4);
    expect(j.items.unverified).toBe(4);
    expect(j.items.needsRecheck).toBe(4);
    expect(j.items.srcGone).toBe(0);
  });

  it('`items ↔ detail` 不一致：**逐节点点名** + 修法（`render-detail`）', () => {
    const j = json();
    expect(j.inconsistent.count).toBe(1);
    expect(j.inconsistent.nodes[0].nodeId).toBe('h-bad');
    expect(j.inconsistent.nodes[0].fix).toContain('render-detail');
    const txt = run('health', H, '--root', SANDBOX).out;
    expect(txt).toContain('h-bad');
    expect(txt).toContain('render-detail');
  });

  it('`qa` 残留与 `detailMode` 残留：只算**条目化节点**上的（v2 节点的 qa[] 是兼容，不是残留）', () => {
    const j = json();
    expect(j.qaResidue.count).toBe(1);
    expect(j.qaResidue.nodes.map((x) => x.nodeId)).toEqual(['h-qa']);
    expect(j.detailModeResidue.count).toBe(1);
    expect(j.detailModeResidue.nodes.map((x) => x.nodeId)).toEqual(['h-dm']);
    expect(j.qaResidue.nodes.map((x) => x.nodeId)).not.toContain('h-v2qa');
  });

  it('悬挂引用（条目级）：`links[].item` 与 `assoc.members[].item` 逐处点名', () => {
    const j = json();
    expect(j.dangling.count).toBe(2);
    expect(j.dangling.list.map((d) => d.kind).sort()).toEqual(['assoc', 'link']);
    j.dangling.list.forEach((d) => {
      expect(d.reason).toBe('item-missing');
      expect(d.detail).toContain('条目不存在');
    });
  });

  it('迁移（契约 §6）：**五档分开**，跳过项逐节点点名 + 原因分布', () => {
    const j = json();
    expect(j.migration).toMatchObject({ itemized: 4, eligible: 2, noContent: 3, outOfScope: 1 });
    expect(j.migration.skipped.map((s) => s.nodeId)).toEqual(['h-skip']);
    expect(j.migration.skipped[0].reason).toBe('not-lossless');
    expect(j.migration.reasonCounts).toMatchObject({ 'not-lossless': 1, 'not-lossless-roundtrip': 0 });
    expect(j.migration.skipped[0].action).toContain('整节点跳过');
    const txt = run('health', H, '--root', SANDBOX).out;
    expect(txt).toContain('h-skip');
    expect(txt).toContain('跳过 1');
  });

  it('**判别力**（注入）：把 renderDetail 换成"回放不回去"的实现 ⇒ 那一档**必红**', () => {
    // 真模型：h-skip 是唯一的跳过项，且没有 not-lossless-roundtrip
    expect(json().migration.reasonCounts['not-lossless-roundtrip']).toBe(0);
    // 注入：渲染多吐一段注释 ⇒ 逐字节回放不再成立 ⇒ "回放门槛"必须把它算进跳过
    const lossy = Object.assign({}, itemModel, {
      renderDetail: (items) => '<!-- 注入 -->' + itemModel.renderDetail(items)
    });
    const r = healthCmd.readingOf(readJson(H), { project: H, root: SANDBOX, model: lossy });
    expect(r.migration.reasonCounts['not-lossless-roundtrip']).toBeGreaterThan(0);
    expect(r.migration.eligible).toBe(0);            // 全被门槛拦下 ⇒ 这一档真的在拦
  });

  it('库级：不给项目名 = 整个库（按名字排序 + 合计自洽）；`--all` 与项目名同给 ⇒ 拒绝', () => {
    const j = runJson('health', '--root', SANDBOX, '--json').json;
    expect(j.scope).toBe('library');
    expect(j.projects.map((p) => p.project)).toEqual([F, H, P, W]);       // 排序 ⇒ 确定性
    const sum = (f) => j.projects.reduce((n, p) => n + f(p), 0);
    expect(j.total.items).toBe(sum((p) => p.items.total));
    expect(j.total.inconsistent).toBe(sum((p) => p.inconsistent.count));
    expect(j.total.migrationSkipped).toBe(sum((p) => p.migration.skipped.length));
    expect(j.total.projects).toBe(4);
    const bad = run('health', '--all', H, '--root', SANDBOX);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('吃掉');            // 裸 `--all X` 会把项目名吃掉 ⇒ 响亮拒绝
    expect(bad.out).toContain('要指定项目就');
    const clash = run('health', H, '--project', P, '--root', SANDBOX);
    expect(clash.code).not.toBe(0);
    expect(clash.out).toContain('二选一');
  });

  it('**是读数不是门禁**：有红项时仍 exit 0（该拦写由 G2 的 validate-all 判）', () => {
    const r = run('health', H, '--root', SANDBOX);
    expect(r.code).toBe(0);
    expect(r.out).toContain('读数不是门禁');
    const before = readBytes(H);
    expect(readBytes(H).equals(before)).toBe(true);        // 并且**不写盘**
  });

  it('库级遇到**读不了的项目**：如实登记进 unreadable 并响亮提示（不因此让整个读数消失）', () => {
    const broken = 'it-s4-broken';
    const dir = path.join(SANDBOX, broken);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, broken + '.json'), '{ 这不是 JSON', 'utf8');
    try {
      const r = runJson('health', '--root', SANDBOX, '--json');
      expect(r.code).toBe(0);
      expect(r.json.unreadable.map((u) => u.project)).toEqual([broken]);
      expect(r.json.projects.map((p) => p.project)).not.toContain(broken);   // **不计入合计**
      const t = run('health', '--root', SANDBOX);
      expect(t.code).toBe(0);
      expect(t.out).toContain(broken);
      expect(t.out).toContain('读不了的项目');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 收尾 */ }
    }
  });
});

/* ============================================================================
 * F. MCP 条目层扩参（本轮追加件：只增参数、不改既有参数语义与返回形状）
 * ========================================================================== */
describe('S4-F MCP：条目层扩参 + 六个新工具（只透传，参数名 ↔ CLI 一一对应）', () => {
  const mcp = require('../scripts/mcp-server.js');
  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mcp-server.js'), 'utf8');
  const tool = (name) => mcp.TOOLS.filter((t) => t.name === name)[0];
  const props = (name) => (tool(name).inputSchema.properties || {});
  const descOf = (name, key) => String(props(name)[key].description || '');

  /** 描述里点到的 CLI 参数（`--xxx`） */
  const flagsIn = (text) => (String(text).match(/--[a-z][a-z0-9-]*/g) || []);

  it('`search_nodes` 增补的 8 个条目层参数：描述里点名对应的 CLI 参数，且那条命令真的接受它', () => {
    ['item_level', 'tag', 'src', 'verified', 'type', 'since', 'limit', 'max_bytes']
      .forEach((key) => {
        expect(props('search_nodes')[key], 'search_nodes 缺 ' + key).toBeTruthy();
      });
    const expectFlag = {
      item_level: '--topic-only', src: '--src', verified: '--verified', type: '--type',
      since: '--since', limit: '--limit', max_bytes: '--max-bytes'
    };
    Object.keys(expectFlag).forEach((key) => {
      const flags = flagsIn(descOf('search_nodes', key));
      expect(flags, key + ' 的描述里没点名 CLI 参数').toContain(expectFlag[key]);
      const camel = core.optionKey(expectFlag[key]);
      expect(registry.allowedOptions('search').indexOf(camel), 'search 不接受 ' + expectFlag[key])
        .toBeGreaterThan(-1);
    });
    // `tag` 是**既有**参数（只增语义，不改形状）：它现在同时管条目级与节点级标签
    expect(descOf('search_nodes', 'tag')).toMatch(/条目/);
  });

  it('`get_node` 加 `item`：按条目取回一条（对应 `get --item`），不给它时行为与从前完全一致', () => {
    expect(descOf('get_node', 'item')).toContain('--item');
    expect(registry.allowedOptions('get').indexOf('item')).toBeGreaterThan(-1);
    expect(tool('get_node').inputSchema.required).toEqual(['project', 'id']);    // 必填项不变
  });

  it('六个新工具：名字、必填项、以及"我是哪条 CLI 命令的透传"都写清了', () => {
    const six = {
      item_add: 'item-add', item_edit: 'item-edit', item_remove: 'item-remove',
      item_move: 'item-move', item_order: 'item-order', render_detail: 'render-detail'
    };
    Object.keys(six).forEach((name) => {
      const t = tool(name);
      expect(t, '缺工具 ' + name).toBeTruthy();
      expect(t.description).toContain(six[name]);
      expect(t.inputSchema.required).toContain('project');
    });
    expect(tool('item_add').inputSchema.required).toContain('id');
    expect(tool('item_edit').inputSchema.required).toContain('item_id');
    expect(tool('item_order').inputSchema.required).toContain('ids');
    expect(tool('render_detail').inputSchema.required).toEqual(['project']);
  });

  it('派发到的命令**全部**存在（复用连带门禁的扫描实现，别在测试里另写一份正则）', () => {
    const cmds = collateral.extractMcpCommands(mcpSrc).map((d) => d.cmd);
    const names = registry.list().map((c) => c.name);
    expect(cmds.filter((c) => names.indexOf(c) < 0)).toEqual([]);
    ['item-add', 'item-edit', 'item-remove', 'item-move', 'item-order', 'render-detail']
      .forEach((c) => expect(cmds).toContain(c));
  });

  it('工具数：45 → 51（+ 六个条目层工具；改参数不计入工具数）', () => {
    // 写死一个数字是**故意**的：它是交付里"工具数 N→M"的判据（docs/VERIFY.md 由整合流跑
    // `doc-facts --write` 同步；这里钉住"确实是 +6"，而不是"没变"）
    expect(mcp.TOOLS.length).toBe(51);
    expect(new Set(mcp.TOOLS.map((t) => t.name)).size).toBe(51);   // 名字不重
  });

  it('不复制业务逻辑：MCP 侧只有 `runCli([...])` 的拼参数，没有第二条判定路径', () => {
    expect(mcpSrc).toContain('function runCli(');
    // 六个新工具都走 runCli（`case 'x': { const c = [...]` 或 `return runCli([...])` 两种形状）
    const c = mcpSrc.indexOf("case 'item_add'");
    expect(c).toBeGreaterThan(-1);
    expect(mcpSrc.slice(c, mcpSrc.indexOf("case 'item_edit'"))).toContain('runCli(');
  });
});
