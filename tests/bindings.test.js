/* ============================================================
 * tests/bindings.test.js — 【R4】绑定工作区文件夹：数据契约 + 增量同步的纯逻辑
 * 运行：npx vitest run tests/bindings.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/R4-绑定工作区文件夹-需求与设计.md`
 *   §三（数据契约）· §四（同步语义表）· §六（四条待拍板的默认）· 第八节（R4.1 四条铁律）
 *
 * 本文件守四组：
 *   `A` **数据契约**：`bindings` 的形状 / 缺省 = 未绑定 / 迁移只补空数组 / 取值表单源；
 *   `B` **增量**：新增 / 修改 / 删除 / 改名 四种变化各自的语义（**删除只提议**）；
 *   `C` **旁路快照**：快照可丢可重建、序列化确定、丢了不会重复建节点；
 *   `D` **不许静默**：转不了的文件必须**点名**（R4.1 铁律②的落点）。
 *
 * ## 环境要点（与 tests/w8-dry-run.test.js 同口径）
 *   沙箱 = 临时目录；本文件对 `projects/` **只读**（其实连读都不读）——
 *   纯逻辑测试（不碰 CLI）与端到端测试（`tests/bind-sync.test.js`）分开：
 *   这一份只 import `src/`，**不设** `AI_MINDMAP_PROJECTS_DIR`（没有写盘路径）。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const di = require('../src/doc-import.js');
const schema = require('../src/schema.js');

/* ---------------- 夹具：一个临时"源文件夹" + 一棵空树 ---------------- */
let TMP = null;
let SRC = null;

function mkSrc(files) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bind-'));
  SRC = path.join(TMP, 'notes');
  fs.mkdirSync(SRC, { recursive: true });
  Object.keys(files || {}).forEach((rel) => {
    const p = path.join(SRC, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel], 'utf8');
  });
  return SRC;
}

beforeEach(() => { mkSrc({}); });
afterEach(() => {
  try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 沙箱删不掉不影响判定 */ }
  TMP = null; SRC = null;
});

const BINDING = (over) => Object.assign({
  id: 'wb-1', dir: SRC, mode: 'flat', include: ['*.md'],
  ignore: schema.BINDING_IGNORE_DEFAULT.slice(), deletions: schema.BINDING_DELETIONS, debounceMs: 800
}, over || {});

function emptyProject(bindings) {
  return {
    meta: { name: 'p', author: '', version: '0.0.0', formatVersion: 2 },
    format: 'node_tree',
    bindings: bindings,
    data: { id: 'root', topic: 'p', expanded: true, children: [] }
  };
}

/** 跑一轮同步（与 `cli/commands/project.js` 的 `bind-sync` 走**同一串**纯函数） */
function syncOnce(data, binding, snap, opts) {
  const o = opts || {};
  const genId = o.genId || di.uniqueIdGen();
  const scan = di.scanImportDir(binding.dir, { ext: di.BINDING_EXT_DEFAULT });
  const list = di.listBindingFiles(binding.dir, binding);
  const plan = di.planBindingSync({
    projectData: data, binding: binding, snapshot: snap, scan: scan, list: list,
    genId: genId, parent: o.parent || 'root', at: o.at || '2026-10-13T00:00:00.000Z'
  });
  // 「人确认过的删除」= 计划上的一个**入参**（引擎里那条唯一出口读它；命令层就是这么喂的）
  if (o.confirmedNodeIds) plan.confirmedNodeIds = o.confirmedNodeIds;
  const applied = di.applyBindingPlan(data, plan);
  const keep = Object.keys(snap.files || {}).filter((rel) => !plan.added.some((x) => x.rel === rel)
    && !plan.modified.some((x) => x.rel === rel)
    && !plan.unconverted.some((x) => x.rel === rel)
    && !plan.pending.some((x) => x.rel === rel));
  return { plan: plan, applied: applied, snap: di.snapshotAfterBindingPlan(snap, plan, plan.at, keep) };
}

/** 把一棵树 JSON 里「某个 id 的节点**连同它的子树**」摘掉（判"其它节点逐字节不变"的精确基准） */
function stripNode(treeJson, nodeId) {
  const cut = (n) => {
    if (!n || typeof n !== 'object') return n;
    const kids = Array.isArray(n.children) ? n.children.filter((c) => c && c.id !== nodeId) : n.children;
    return Object.assign({}, n, { children: (kids || []).map(cut) });
  };
  return JSON.stringify(cut(JSON.parse(treeJson)));
}

/** 树里全部节点（扁平） */
function allNodes(data) {
  const out = [];
  (function walk(n) { if (!n) return; out.push(n); (n.children || []).forEach(walk); })(data.data);
  return out;
}
const topicsOf = (data) => allNodes(data).map((n) => n.topic);

/* ============================================================================
 * A 数据契约（bindings：形状 / 缺省 / 迁移 / 取值表单源）
 * ========================================================================== */
describe('A 数据契约：bindings（缺省 = 未绑定；删除策略只有 propose-only）', () => {
  it('A1 没有 bindings 键 ⇒ 校验通过、语义就是"未绑定"（老项目照旧可读可写）', () => {
    const p = emptyProject(undefined);
    delete p.bindings;
    const v = schema.validateProject(p);
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
    // 迁移会补空数组（`changed:true`），但**入参一个字节都不动**（纯函数）
    const raw = JSON.stringify(p);
    const m = schema.migrateBindings(p);
    expect(m.changed).toBe(true);
    expect(m.data.bindings).toEqual([]);
    expect(JSON.stringify(p)).toBe(raw);
    // 补完之后：校验照旧通过，且**再迁一次**是幂等的（`changed:false` / `data` 原样返回）
    expect(schema.validateProject(m.data).ok).toBe(true);
    const again = schema.migrateBindings(m.data);
    expect(again.changed).toBe(false);
    expect(again.data).toBe(m.data);
    expect(again.note).toContain('已有 bindings 数组');
  });

  it('A2 **迁移只补空数组**：缺键 ⇒ changed:true + 既有数据逐字节未动；已有值 ⇒ 一个字节都不碰', () => {
    const p = emptyProject(undefined);
    delete p.bindings;
    const before = JSON.stringify(p);
    const m = schema.migrateBindings(p);
    expect(m.changed).toBe(true);
    expect(m.data.bindings).toEqual([]);
    expect(JSON.stringify(p)).toBe(before);              // 入参**没被改**（纯函数）
    // 已经是数组（含非空）⇒ 原样返回，连对象都不重建
    const p2 = emptyProject([BINDING()]);
    const m2 = schema.migrateBindings(p2);
    expect(m2.changed).toBe(false);
    expect(m2.data).toBe(p2);
    // 有键但值是坏形状 ⇒ **不替它收拾**（交给校验判红），迁移一个字节都不动
    const p3 = emptyProject(null);
    const m3 = schema.migrateBindings(p3);
    expect(m3.changed).toBe(false);
    expect(m3.data.bindings).toBe(null);
    expect(schema.validateProject(p3).ok).toBe(false);
  });

  it('A3 合法绑定通过；`deletions` 只认 propose-only（判据把它固化成契约）', () => {
    const p = emptyProject([BINDING()]);
    const v = schema.validateProject(p);
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
    const bad = emptyProject([BINDING({ deletions: 'auto' })]);
    const vb = schema.validateProject(bad);
    expect(vb.ok).toBe(false);
    expect(vb.errors.join('\n')).toContain('propose-only');
  });

  it('A4 形状判红逐条点名：mode / id / dir / debounceMs / status / include 元素', () => {
    const cases = [
      [{ mode: 'tree' }, 'mode'],
      [{ id: 'WB 1' }, 'id'],
      [{ id: 'wb-1', dir: '  ' }, 'dir'],
      [{ debounceMs: 5 }, 'debounceMs'],
      [{ debounceMs: 999999 }, 'debounceMs'],
      [{ status: 'running' }, 'status'],
      [{ include: ['*.md', ''] }, 'include'],
      [{ lastSyncAt: 5 }, 'lastSyncAt']
    ];
    cases.forEach(([over, needle]) => {
      const v = schema.validateProject(emptyProject([BINDING(over)]));
      expect(v.ok).toBe(false);
      expect(v.errors.join('\n'), JSON.stringify(over)).toContain(needle);
    });
    // 重复 id：快照按 id 分文件 ⇒ 必须唯一
    const dup = emptyProject([BINDING(), BINDING()]);
    const vd = schema.validateProject(dup);
    expect(vd.ok).toBe(false);
    expect(vd.errors.join('\n')).toContain('重复');
  });

  it('A5 取值表**只有一处**（src/schema.js）：doc-import 不许再写一份字面量', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'doc-import.js'), 'utf8');
    // 去注释（注释里会**引用**这些字面量解释口径，那是说明书不是第二份取值）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
    expect(code).toContain("require('./schema.js')");
    expect(code).toContain('schemaSpec.BINDING_MODES');
    expect(code).toContain('schemaSpec.BINDING_MODE_DEFAULT');
    // 取值表里的字面量不许在**代码**里再出现一次（第二份必然与校验漂移）
    expect(code.indexOf("'propose-only'")).toBe(-1);
    expect(code.indexOf("'watching'")).toBe(-1);
    expect(code.match(/'flat'/g) || []).toHaveLength(0);
    expect(schema.BINDING_MODES).toEqual(['flat', 'mirror']);
    expect(schema.BINDING_DELETIONS).toBe('propose-only');
    expect(schema.BINDING_DEBOUNCE_DEFAULT).toBe(800);
    expect(schema.BINDING_IGNORE_DEFAULT).toContain('node_modules');
    expect(schema.BINDING_IGNORE_DEFAULT).toContain('.git');
    expect(schema.BINDING_IGNORE_DEFAULT).toContain('.review');
  });

  it('A6 `isBindingActive`：缺省/ watching ⇒ 守护；paused / blocked ⇒ 不守护（解释只有一处）', () => {
    expect(schema.isBindingActive({ id: 'x' })).toBe(true);
    expect(schema.isBindingActive({ id: 'x', status: 'watching' })).toBe(true);
    expect(schema.isBindingActive({ id: 'x', status: 'paused' })).toBe(false);
    expect(schema.isBindingActive({ id: 'x', status: 'blocked' })).toBe(false);
  });
});

/* ============================================================================
 * B 增量：新增 / 修改 / 删除（只提议）/ 改名（新增 + 提议删旧）
 * ========================================================================== */
describe('B 增量同步：三种变化各自的语义（删除**绝不自动删**）', () => {
  it('B1 第一次同步：3 个 md ⇒ 3 个文件节点（每个下面挂着它自己的标题子树）', () => {
    mkSrc({ 'a.md': '# 甲书\n\n甲正文\n', 'b.md': '# 乙书\n\n乙正文\n', 'c.md': '# 丙书\n\n丙正文\n' });
    const data = emptyProject([BINDING()]);
    const r = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC));
    expect(r.plan.added).toHaveLength(3);
    expect(r.plan.modified).toHaveLength(0);
    expect(r.applied.added).toBe(3);
    expect(topicsOf(data)).toEqual(['p', 'a', '甲书', 'b', '乙书', 'c', '丙书']);
    // 每个文件节点都带 origin（文件级"这份导过没有"的判据；`import-dir` 同一口径）
    const fileNodes = allNodes(data).filter((n) => n.origin);
    expect(fileNodes).toHaveLength(3);
    expect(fileNodes.every((n) => n.origin.tool === 'bind-sync')).toBe(true);
    expect(fileNodes.every((n) => /^[0-9a-f]{64}$/.test(n.origin.sha256))).toBe(true);
  });

  it('B2 什么都没改 ⇒ **零变化**（一个文件都不读、一个字节都不写）', () => {
    mkSrc({ 'a.md': '# 甲书\n' });
    const data = emptyProject([BINDING()]);
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap = syncOnce(data, BINDING(), snap).snap;
    const treeBefore = JSON.stringify(data);
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.added).toHaveLength(0);
    expect(r.plan.modified).toHaveLength(0);
    expect(r.plan.unchanged).toBe(1);
    // ⭐ **增量性唯一可机器判定的读数**：这一轮**读了 0 个文件**（没变的文件一个字节都不读）。
    //    为什么必须看这个数而不是只看"树没变"：把 `only` 去掉（每次全量重建）之后**树也一个字不差**
    //    ⇒ 只比树是判不出增量的（判别力证明见交付说明的注入 iii）。
    expect(r.plan.readFiles, '没有变化的那一轮不该读任何文件').toBe(0);
    expect(di.bindingPlanChangesTree(r.plan)).toBe(false);      // ⇒ 命令会一次盘都不写
    expect(JSON.stringify(data)).toBe(treeBefore);
  });

  it('B2b 改一个文件 ⇒ 这一轮**只读它一个**（增量的正面读数）', () => {
    mkSrc({ 'a.md': '# 甲书\n', 'b.md': '# 乙书\n', 'c.md': '# 丙书\n' });
    const data = emptyProject([BINDING()]);
    let snap = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC)).snap;
    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书（改过）\n', 'utf8');
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.readFiles).toBe(1);
    expect(r.plan.added.concat(r.plan.modified).map((x) => x.rel)).toEqual(['b.md']);
    expect(r.plan.unchanged).toBe(2);
  });

  it('B3 改一个文件 ⇒ **只有它**对应的节点更新（其它节点逐字节不变）', () => {
    mkSrc({ 'a.md': '# 甲书\n', 'b.md': '# 乙书\n' });
    const data = emptyProject([BINDING()]);
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap = syncOnce(data, BINDING(), snap).snap;
    const before = allNodes(data).map((n) => JSON.stringify(n));
    const aNodeBefore = allNodes(data).filter((n) => n.topic === 'a')[0];
    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书（改过）\n\n新正文\n', 'utf8');
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.modified.map((m) => m.rel)).toEqual(['b.md']);
    expect(r.plan.added).toHaveLength(0);
    expect(r.applied.modified).toBe(1);
    expect(topicsOf(data)).toContain('乙书（改过）');
    expect(topicsOf(data)).not.toContain('乙书');
    // 没改的那个节点**逐字节不变**，而且位置也没动（就地替换，不追加）
    const aNodeAfter = allNodes(data).filter((n) => n.topic === 'a')[0];
    expect(JSON.stringify(aNodeAfter)).toBe(JSON.stringify(aNodeBefore));
    expect(allNodes(data).indexOf(aNodeAfter)).toBe(1);
    void before;
  });

  it('B4 加一个文件 ⇒ **只新增一个**（不改别的）', () => {
    mkSrc({ 'a.md': '# 甲书\n' });
    const data = emptyProject([BINDING()]);
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap = syncOnce(data, BINDING(), snap).snap;
    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙书\n', 'utf8');
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.added.map((x) => x.rel)).toEqual(['b.md']);
    expect(r.plan.modified).toHaveLength(0);
    expect(r.applied.added).toBe(1);
    expect(topicsOf(data)).toEqual(['p', 'a', '甲书', 'b', '乙书']);
  });

  it('B5 删一个文件 ⇒ **盘上节点一个都不少** + 恰好 1 条待确认提议（再跑一次不重复报）', () => {
    mkSrc({ 'a.md': '# 甲书\n', 'b.md': '# 乙书\n' });
    const data = emptyProject([BINDING()]);
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap = syncOnce(data, BINDING(), snap).snap;
    const nodesBefore = allNodes(data).length;
    const treeBefore = JSON.stringify(data.data);
    fs.unlinkSync(path.join(SRC, 'b.md'));
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.pending.map((p) => p.rel)).toEqual(['b.md']);
    expect(r.applied.added).toBe(0);
    expect(r.applied.modified).toBe(0);
    // ⚠️ 这一条是**本功能最核心的承诺**：删除只提议，树里一个节点都不动
    expect(allNodes(data).length).toBe(nodesBefore);
    expect(JSON.stringify(data.data)).toBe(treeBefore);
    expect(r.snap.pendingDeletions.map((p) => p.rel)).toEqual(['b.md']);
    expect(r.snap.pendingDeletions[0].nodeId).toBeTruthy();      // 提议里点名"是哪个节点"
    // 再跑一次：同一条提议**不重复报**（提案是清单，不是流水）
    const r2 = syncOnce(data, BINDING(), r.snap);
    expect(r2.plan.pending).toHaveLength(0);
    expect(r2.snap.pendingDeletions).toHaveLength(1);
    expect(allNodes(data).length).toBe(nodesBefore);
  });

  it('B6 改名 ⇒ 按"新增 + 提议删旧"处理（新节点出现、旧节点仍在、一条提议）', () => {
    mkSrc({ 'a.md': '# 甲书\n' });
    const data = emptyProject([BINDING()]);
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap = syncOnce(data, BINDING(), snap).snap;
    fs.renameSync(path.join(SRC, 'a.md'), path.join(SRC, 'a2.md'));
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.added.map((x) => x.rel)).toEqual(['a2.md']);
    expect(r.plan.pending.map((p) => p.rel)).toEqual(['a.md']);
    expect(topicsOf(data)).toEqual(['p', 'a', '甲书', 'a2', '甲书']);   // 旧节点**还在**
    expect(r.snap.pendingDeletions).toHaveLength(1);
  });

  it('B7 移出 include / 加进 ignore ⇒ **不算删除**（那是人明确的动作，不是"文件没了"）', () => {
    mkSrc({ 'a.md': '# 甲书\n', 'b.md': '# 乙书\n' });
    const data = emptyProject([BINDING({ include: ['*.md'] })]);
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap = syncOnce(data, BINDING({ include: ['*.md'] }), snap).snap;
    // 把 b.md 移出 include ⇒ 不该报"待确认删除"
    const r = syncOnce(data, BINDING({ include: ['a.md'] }), snap);
    expect(r.plan.pending).toHaveLength(0);
    expect(allNodes(data).filter((n) => n.topic === 'b')).toHaveLength(1);   // 节点仍在
    // 它**留在快照里**（回来时按"修改"处理，不会因为离开过视野而多建一个节点）
    expect(Object.keys(r.snap.files)).toContain('b.md');
    const back = syncOnce(data, BINDING({ include: ['*.md'] }), r.snap);
    expect(back.plan.added).toHaveLength(0);
    expect(allNodes(data).filter((n) => n.topic === 'b')).toHaveLength(1);
  });

  it('B8 `mirror` 形态：按目录建容器节点，**同一目录恒同 id**（不会每同步一次多一层）', () => {
    mkSrc({ 'ch1/a.md': '# 甲书\n', 'ch1/b.md': '# 乙书\n', 'ch2/c.md': '# 丙书\n' });
    const b = BINDING({ mode: 'mirror' });
    const data = emptyProject([b]);
    const genId = di.uniqueIdGen();
    let snap = di.emptyBindingSnapshot('wb-1', SRC);
    let r = syncOnce(data, b, snap, { genId: genId });
    snap = r.snap;
    expect(r.plan.containers.map((c) => c.key).sort()).toEqual(['ch1', 'ch2']);
    expect(topicsOf(data)).toContain('ch1');
    expect(topicsOf(data)).toContain('ch2');
    const ch1Id = allNodes(data).filter((n) => n.topic === 'ch1')[0].id;
    // 再改一个文件 ⇒ 容器**复用**（不新建、不多一层）
    fs.writeFileSync(path.join(SRC, 'ch1', 'a.md'), '# 甲书（改过）\n', 'utf8');
    const r2 = syncOnce(data, b, snap, { genId: genId });
    expect(r2.plan.containers).toHaveLength(0);
    expect(allNodes(data).filter((n) => n.topic === 'ch1')).toHaveLength(1);
    expect(allNodes(data).filter((n) => n.topic === 'ch1')[0].id).toBe(ch1Id);
    expect(topicsOf(data)).toContain('甲书（改过）');
  });
});

/* ============================================================================
 * C 旁路快照：序列化确定 / 可以丢 / 丢了不重复建节点
 * ========================================================================== */
describe('C 旁路快照（不进项目数据；可丢、可重建）', () => {
  it('C1 序列化**逐字节确定**：同一状态两次序列化相同；键按相对路径排序', () => {
    mkSrc({ 'b.md': '# 乙\n', 'a.md': '# 甲\n' });
    const data = emptyProject([BINDING()]);
    const r = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC));
    const t1 = di.serializeBindingSnapshot(r.snap);
    const t2 = di.serializeBindingSnapshot(r.snap);
    expect(t1).toBe(t2);
    const keys = Object.keys(JSON.parse(t1).files);
    expect(keys).toEqual(keys.slice().sort());
    expect(JSON.parse(t1).schemaVersion).toBe(di.BINDING_STATE_VERSION);
    // 反序列化回来判据一致
    const parsed = di.parseBindingSnapshot(t1);
    expect(di.normalizeBindingSnapshot(parsed, 'wb-1', SRC).rebuilt).toBe(true);
  });

  it('C2 坏/旧/缺快照 ⇒ **不用它**并如实给出原因（不是静默当成"没变化"）', () => {
    expect(di.normalizeBindingSnapshot(null, 'wb-1', SRC).rebuilt).toBe(false);
    expect(di.normalizeBindingSnapshot(null, 'wb-1', SRC).why).toContain('第一次同步');
    const bad = di.normalizeBindingSnapshot({ schemaVersion: 99 }, 'wb-1', SRC);
    expect(bad.rebuilt).toBe(false);
    expect(bad.why).toContain('schemaVersion');
    expect(bad.snap.files).toEqual({});
    expect(di.parseBindingSnapshot('{ 不是 json')).toBe(null);
    expect(di.parseBindingSnapshot('')).toBe(null);
  });

  it('C3 快照**丢了**也不重复建节点：`bindingSnapshotOf` 从树里的 origin 现算', () => {
    mkSrc({ 'ch/a.md': '# 甲书\n' });
    const b = BINDING({ mode: 'mirror' });
    const data = emptyProject([b]);
    const r = syncOnce(data, b, di.emptyBindingSnapshot('wb-1', SRC));
    const rebuilt = di.bindingSnapshotOf(data, SRC);
    expect(Array.from(rebuilt.keys())).toEqual(['ch/a.md']);
    expect(rebuilt.get('ch/a.md').nodeId).toBe(r.plan.added[0].subtree.id);
    expect(rebuilt.get('ch/a.md').sha256).toBe(r.plan.added[0].subtree.origin.sha256);
    void r;
  });

  it('C4 项目数据**不含快照**：同步前后 `data` 上没有任何 mtime/快照字段（旁路的意义）', () => {
    mkSrc({ 'a.md': '# 甲书\n' });
    const data = emptyProject([BINDING()]);
    syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC));
    const text = JSON.stringify(data);
    expect(text).not.toContain('mtimeMs');
    expect(text).not.toContain('pendingDeletions');
    expect(text).not.toContain('lastScan');
    // 绑定记录上只允许出现"人看得懂的那几个键"（快照字段一个都不许漏进来：
    // 快照里那些 mtime/大小/指纹是**旁路**的，`lastSyncAt` 才是项目数据该有的那一个时刻）
    const b = data.bindings[0];
    expect(Object.keys(b).sort()).toEqual(
      ['debounceMs', 'deletions', 'dir', 'id', 'ignore', 'include', 'lastSyncAt', 'mode'].sort());
  });
});

/* ============================================================================
 * D 不许静默：转不了的必须点名（R4.1 铁律②）
 * ========================================================================== */
describe('D 转不了的文件：逐条点名，不静默跳过，也不拖垮同批里别的文件', () => {
  it('D1 空文件 ⇒ 进"未转换"清单并点名（且**不进快照** ⇒ 下次还会再试）', () => {
    mkSrc({ 'ok.md': '# 好的\n', 'empty.md': '' });
    const data = emptyProject([BINDING()]);
    const r = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC));
    expect(r.plan.added.map((x) => x.rel)).toEqual(['ok.md']);       // 好的照导（部分成功 ✓）
    expect(r.plan.unconverted.map((u) => u.rel)).toEqual(['empty.md']);
    expect(r.plan.unconverted[0].reason).toBe('empty-file');
    expect(r.plan.unconverted[0].label).toBeTruthy();                // 有人话的短名
    expect(Object.keys(r.snap.files)).toEqual(['ok.md']);            // 未转换的**不进快照**
    expect(r.snap.unconverted.map((u) => u.rel)).toEqual(['empty.md']);
    // 下一次：它还会被再试一次（不是"试过就永远不管"）
    fs.writeFileSync(path.join(SRC, 'empty.md'), '# 现在有内容了\n', 'utf8');
    const r2 = syncOnce(data, BINDING(), r.snap);
    expect(r2.plan.added.map((x) => x.rel)).toEqual(['empty.md']);
    expect(r2.snap.unconverted).toHaveLength(0);
  });

  it('D2 不支持的扩展名**不进范围**（逐类计数，可点名）—— 不是"坏文件"', () => {
    mkSrc({ 'a.md': '# 甲\n', 'b.png': 'not really a png' });
    const list = di.listBindingFiles(SRC, BINDING({ include: [] }));
    expect(list.files.map((f) => f.rel)).toEqual(['a.md']);          // png 在扫描阶段就被跳过
    const png = list.skipped.filter((s) => s.rel === 'b.png')[0];
    expect(png.reason).toBe('unsupported-ext');
    expect(png.label).toBeTruthy();
  });
});

/* ============================================================================
 * E 删除提议的**确认流**（设计排期第⑥步）
 *   · 确认前：**盘上一个节点都不许少**（跑多少轮都一样，逐字节）
 *   · 确认：只走引擎那**一条**既有出口（`plan.confirmedNodeIds`）⇒ 只摘**被确认的那些**
 *   · 提议的并集（`plan.pendingAll`）是"待确认删 K"与"逐条点名"的**同一份**数据源
 * ========================================================================== */
describe('E 删除提议的确认流（未确认一个都不少；确认只摘被确认的）', () => {
  it('E1 提议的并集 `pendingAll`：本轮新提议 ∪ 快照里的旧提议，**跨轮次不消失**（本批修掉的那条缺陷）', () => {
    mkSrc({ 'a.md': '# 甲\n', 'b.md': '# 乙\n' });
    const data = emptyProject([BINDING()]);
    let snap = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC)).snap;
    fs.unlinkSync(path.join(SRC, 'b.md'));
    const r1 = syncOnce(data, BINDING(), snap);
    expect(r1.plan.pending.map((p) => p.rel)).toEqual(['b.md']);
    expect(r1.plan.pendingAll.map((p) => p.rel)).toEqual(['b.md']);
    snap = r1.snap;
    // 让树**再真变一次**（加一个文件）⇒ 快照才落盘，提议从此只活在快照里
    fs.writeFileSync(path.join(SRC, 'c.md'), '# 丙\n', 'utf8');
    const r2 = syncOnce(data, BINDING(), snap);
    expect(r2.plan.pending, '这一轮没有**新**提议').toHaveLength(0);
    expect(r2.snap.pendingDeletions.map((p) => p.rel)).toEqual(['b.md']);
    snap = r2.snap;
    // ⭐ 缺陷形状（本批实测并修掉）：只读"本轮新提议"的读数在这里是 **0**
    //   ⇒ 界面会显示"待确认删 0"、清单为空，而提议其实还在（确认流也就无从谈起）
    const r3 = syncOnce(data, BINDING(), snap);
    expect(r3.plan.pending).toHaveLength(0);
    expect(r3.plan.pendingAll.map((p) => p.rel), '并集必须仍然看得见这条提议').toEqual(['b.md']);
    expect(r3.plan.pendingAll[0].nodeId).toBeTruthy();               // 点名"是哪个节点"（确认要用它）
    expect(r3.plan.pendingAll[0].topic).toBe('b');                   // 名字（界面上的那一行）
    expect(r3.plan.pendingAll[0].revived).toBe(false);               // 文件没回来
  });

  it('E2 确认前：跑多少轮都不许少一个节点（逐字节），提议一直在', () => {
    mkSrc({ 'a.md': '# 甲\n', 'b.md': '# 乙\n', 'c.md': '# 丙\n' });
    const data = emptyProject([BINDING()]);
    let snap = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC)).snap;
    const treeBefore = JSON.stringify(data.data);
    const nBefore = allNodes(data).length;
    fs.unlinkSync(path.join(SRC, 'b.md'));
    let last = null;
    for (let i = 0; i < 3; i++) {                                    // 连跑三轮"什么都不做"
      last = syncOnce(data, BINDING(), snap);
      snap = last.snap;
      expect(JSON.stringify(data.data), '第 ' + (i + 1) + ' 轮之后树必须逐字节不变').toBe(treeBefore);
      expect(allNodes(data).length).toBe(nBefore);
    }
    expect(last.plan.pendingAll.map((p) => p.rel)).toEqual(['b.md']);
  });

  it('E3 确认 ⇒ 只摘**被确认的那一个**节点（其它节点逐字节不变）；提议随之清空、不再反弹', () => {
    mkSrc({ 'a.md': '# 甲\n', 'b.md': '# 乙\n', 'c.md': '# 丙\n' });
    const data = emptyProject([BINDING()]);
    let snap = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC)).snap;
    const treeBefore = JSON.stringify(data.data);
    fs.unlinkSync(path.join(SRC, 'b.md'));
    let r = syncOnce(data, BINDING(), snap);
    snap = r.snap;
    r = syncOnce(data, BINDING(), snap);                             // 一轮"没变化"（提议只活在快照里）
    snap = r.snap;
    const victim = r.plan.pendingAll[0];
    expect(victim.nodeId).toBeTruthy();
    // 这一轮的**唯一**变化就是"人确认了那一条" ⇒ 计划必须算"会改树"（否则命令在摘节点前就 return ✗）
    expect(di.bindingPlanChangesTree(r.plan), '只确认也要算会改树').toBe(false);
    const rc = syncOnce(data, BINDING(), snap, { confirmedNodeIds: [victim.nodeId] });
    expect(rc.plan.confirmedNodeIds).toEqual([victim.nodeId]);
    expect(di.bindingPlanChangesTree(rc.plan), '带确认的那一轮必须算会改树').toBe(true);
    expect(rc.applied.dropped, '恰好摘掉被确认的那一个').toEqual([victim.nodeId]);
    // 精确判据：把「被确认的那个节点连同它的子树」从 before 里摘掉 == 现在这棵树（其它一个字节都没动）
    expect(JSON.stringify(data.data)).toBe(stripNode(treeBefore, victim.nodeId));
    expect(rc.snap.pendingDeletions, '提议清空').toHaveLength(0);
    // 再跑一轮：提议不会重新冒出来（K 回 0 之后不反弹）
    const after = syncOnce(data, BINDING(), rc.snap);
    expect(after.plan.pendingAll).toHaveLength(0);
    expect(di.bindingStatusOf(after.snap, BINDING()).pending).toBe(0);
  });

  it('E4 手写一个**不在提议里**的 id ⇒ 删不掉任何东西（唯一出口的闸门：id 必须出自提议）', () => {
    mkSrc({ 'a.md': '# 甲\n', 'b.md': '# 乙\n' });
    const data = emptyProject([BINDING()]);
    let snap = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC)).snap;
    const treeBefore = JSON.stringify(data.data);
    const realId = allNodes(data).filter((n) => n.topic === 'a')[0].id;   // 真节点、但**没被提议过**
    const r = syncOnce(data, BINDING(), snap, { confirmedNodeIds: [realId, 'made-up-id'] });
    expect(r.applied.dropped).toEqual([]);
    expect(JSON.stringify(data.data), '一个字节都不许动').toBe(treeBefore);
    expect(di.bindingPlanChangesTree(r.plan), '没有任何真提议可摘 ⇒ 这一轮不该写盘').toBe(false);
  });

  it('E5 边界①：提议删过的文件**又出现** ⇒ 引擎按"新增"（两个同名节点）+ `revived` 如实标注；确认后回到一个', () => {
    mkSrc({ 'a.md': '# 甲\n', 'b.md': '# 乙\n' });
    const data = emptyProject([BINDING()]);
    let snap = syncOnce(data, BINDING(), di.emptyBindingSnapshot('wb-1', SRC)).snap;
    fs.unlinkSync(path.join(SRC, 'b.md'));
    snap = syncOnce(data, BINDING(), snap).snap;                     // 提议：b.md
    fs.writeFileSync(path.join(SRC, 'b.md'), '# 乙回来了\n', 'utf8');  // 文件又回来了
    const r = syncOnce(data, BINDING(), snap);
    expect(r.plan.added.map((x) => x.rel), '引擎按**新增**处理（既定语义，本批不动它）').toEqual(['b.md']);
    expect(allNodes(data).filter((n) => n.topic === 'b'), '⇒ 同一个文件两个节点（如实记在判据里）').toHaveLength(2);
    expect(r.plan.pendingAll.map((p) => p.rel)).toEqual(['b.md']);
    expect(r.plan.pendingAll[0].revived, '确认流据此把后果说清楚').toBe(true);
    // 确认那一条旧提议 ⇒ 摘掉**旧的**那个节点 ⇒ 又回到"一个文件一个节点"
    const rc = syncOnce(data, BINDING(), r.snap, { confirmedNodeIds: [r.plan.pendingAll[0].nodeId] });
    expect(rc.applied.dropped).toHaveLength(1);
    expect(allNodes(data).filter((n) => n.topic === 'b')).toHaveLength(1);
    expect(topicsOf(data)).toContain('乙回来了');
    expect(rc.snap.pendingDeletions).toHaveLength(0);
  });
});
