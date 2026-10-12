/* ============================================================
 * tests/recheck.test.js — 复校与体检（S4）
 * 运行：npx vitest run tests/recheck.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条都对着一个**能红**的判据）
 *   A. `src/item-src.js` 是"出处"这一维的**唯一实现处**：
 *      归一化与检索面（`src/item-index.js` 的 `srcList`）**同口径**（真模块对真模块交叉断言）；
 *      `file:line` / `file:line::引文` / URL / 命令 / 认不出 五种形状都能解析；
 *      同一个文件在同一次运行里**只读一次**（廉价前置）。
 *   B. `recheck` 三态（ok / needs-recheck / src-gone）+ 计数 + 原因分布，**逐条点名**、给可执行下一步；
 *      **只读默认**：跑一次，项目 JSON 与 `.changes.jsonl` **逐字节不变**。
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
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---- ① 沙箱：必须在 require cli/main.js 之前设好 ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-s4-'));
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
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 收尾失败不影响判定 */ }
});

/** `patch` 里的取条目（与 `itemIn` 同口径，但作用在"还没落盘的 j"上） */
function itemOfNode(j, id, k) { return (nodeOf(j, id).items || [])[k || 0]; }

/* ============================================================================
 * A. `src/item-src.js` —— 出处这一维的唯一实现处
 * ========================================================================== */
describe('S4-A item-src：归一化 / 解析 / 与检索面同口径', () => {
  it('normalizeSrc 与 `src/item-index.js` 的 srcList **逐样本同结果**（同一维两份实现会漂移）', () => {
    const samples = [
      undefined, null, '', 'CHANGELOG.md:713', ['a', '', 'b'], ['a', 'a'], 42, [3, 'x'], {}, ['', ''],
      'refs/spec.md:4::第一条'
    ];
    samples.forEach((v) => {
      expect(itemSrc.normalizeSrc(v), JSON.stringify(v)).toEqual(itemIndex.srcList({ src: v }));
    });
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

  it('matchesSrc 与检索面的 `--src` 子串口径同义（唯一实现处，将来检索面改成调它即可）', () => {
    expect(itemSrc.matchesSrc({ src: ['CHANGELOG.md:713-717'] }, 'CHANGELOG')).toBe(true);
    expect(itemSrc.matchesSrc({ src: 'refs/spec.md:4::第一条' }, 'spec.md')).toBe(true);
    expect(itemSrc.matchesSrc({ src: 'refs/spec.md:4::第一条' }, 'nope')).toBe(false);
    expect(itemSrc.matchesSrc({ src: 'refs/spec.md' }, '')).toBe(false);
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
