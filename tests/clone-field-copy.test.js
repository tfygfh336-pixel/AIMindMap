/* ============================================================
 * tests/clone-field-copy.test.js — 节点复制的**字段保真**与它的**机械判据**
 * 运行：npx vitest run tests/clone-field-copy.test.js
 * ------------------------------------------------------------
 * 守的是什么（一次真实缺陷 + 一条门禁）：
 *   `clone` 的深拷贝曾是**手挑字段**（`cli/commands/edit.js` 的局部 `deepCopy`）：
 *     它漏掉 `items` / `detailMode` / `localPath` / `origin` ⇒
 *     · 复制一个**条目化**节点 ⇒ 副本上 `items` 消失（整层条目没了，退回 v2），而 `detail` 还在；
 *     · 复制带 `localPath` / `origin` 的节点 ⇒ 副本上两者消失；
 *     · `validate` 副本**照样通过**（exit 0）⇒ **没有任何门禁会红**，且写盘后不可逆。
 *   这是本工程**第五次**栽在同一形态上（前四次：`qa` / `localPath` / `origin` /
 *   界面的 `items`+`detailMode`）。故本文件两件事一起做：
 *     甲）**行为**：复制必须逐字段保真（并钉住"只在有值时写 ⇒ 旧形状逐字节不变"）；
 *     乙）**判据**：`src/schema.js` 里的加注分析器**必须能红**（合成注入 4 档 + 真实源码读一遍），
 *          `scripts/cli-integration.js` 里那条断言就是靠它判的 —— 判据不会红的门禁等于不存在。
 *
 * ⚠️ 两个环境要点（与 `tests/link-item.test.js` 同一口径，改这个文件前先读）：
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 `require cli/main.js`
 *      **之前**设好 —— `cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的。故本文件先自证
 *      重定向生效，不生效就**当场红**。
 *   2) **不起子进程**：本工程记过"受限环境（企业 EDR/沙箱）下管道 stdio 会 EPERM 假失败"，
 *      故端到端用进程内 `invokeSync`（不起 Node 子进程）。
 *
 * 判别力（本文件自己也要能被注入）：把 `cloneNode` 的字段表里 `items` 那两处删掉 ⇒
 *   `analyzeCloneFieldCopy(真实源码).ok` 变 false（`缺失=items`）⇒ ② 组必红；
 *   把加注改成"表说 A、代码做 B" ⇒ `drift` 非空 ⇒ 同样必红（合成注入用例已覆盖这两种）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-clone-'));
process.env.AI_MINDMAP_PROJECTS_DIR = TMP_ROOT;
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const editCmd = require('../cli/commands/edit.js');
const { NODE_FIELD_NAMES, NODE_FIELDS_OPTIONAL, analyzeCloneFieldCopy } = require('../src/schema.js');

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(TMP_ROOT)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + TMP_ROOT + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const P = 'it-clone-fields';
const projFile = () => path.join(TMP_ROOT, P, P + '.json');
const readDisk = () => JSON.parse(fs.readFileSync(projFile(), 'utf8'));
const walkAll = (fn) => {
  (function w(n) { if (!n) return; fn(n); (n.children || []).forEach(w); })(readDisk().data);
};
const nodeOnDisk = (id) => { let hit = null; walkAll((n) => { if (n.id === id) hit = n; }); return hit; };
const run = (...args) => {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
};
const EDIT_SRC = () => fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'edit.js'), 'utf8');

/** 一个"字段齐全"的源节点（含 `_` 起头的条目内部键 —— 需求明写要**原样搬运**） */
const FULL_NODE = () => ({
  id: 'full', topic: '字段齐全', expanded: false,
  detail: '<p>正文</p>', background: '#fff3c4',
  tags: ['甲', '乙'],
  images: [{ file: 'assets/a.png', caption: '图' }],
  files: [{ file: 'attachments/b.pdf', caption: '附件' }],
  links: [{ project: 'other', id: 'x', caption: '边' }],
  qa: [{ q: '问', a: '答', at: '2026-10-12T00:00:00.000Z' }],
  localPath: 'E:\\资料\\M1',
  origin: { kind: 'import', src: 'docA.md', sha256: 'a'.repeat(64), at: '2026-10-12T00:00:00.000Z' },
  items: [{ id: 'i-aaa', type: 'text', html: '<p>条目甲</p>', _container: { open: '<ul>', close: '</ul>' }, _groupStart: true }],
  detailMode: 'rich',
  children: [{ id: 'full-kid', topic: '子', children: [] }]
});

/* 真实源码必须在**行为**上把每个契约字段都搬过去（与下面的静态判据互为对照） */
const mintSeq = (prefix) => { let i = 0; return () => prefix + (++i); };
/** 两条路径要比 id 时用：每次调用给一个**从头开始**的生成器 ⇒ 两边 id 序列一致，才能逐字节比 */
const freshMint = (prefix) => mintSeq(prefix);

/* ============================================================
 * 甲组 · 行为：字段保真 + 旧形状零差
 * ============================================================ */
describe('甲组 · cloneNode 逐字段保真', () => {
  it('契约里的**每一个**字段名都出现在副本上（漏一个即失败，报文点名缺哪个）', () => {
    const src = FULL_NODE();
    const copy = editCmd.cloneNode(src, mintSeq('c'), true, (oldId) => oldId + '-new');
    const missing = NODE_FIELD_NAMES.filter((f) => !(f in copy));
    expect(missing, '漏掉的字段（漏一个 = 克隆时静默抹掉）：' + missing.join(',')).toEqual([]);
  });

  it('每个字段的值逐字节等于源（items 例外：**内容**相同、`id` 换新，见 §5.1 唯一性）', () => {
    const src = FULL_NODE();
    const copy = editCmd.cloneNode(src, mintSeq('c'), true, (oldId) => oldId + '-new');
    expect(copy.id).not.toBe(src.id);
    expect(copy.topic).toBe(src.topic);
    expect(copy.expanded).toBe(false);
    expect(copy.detail).toBe(src.detail);
    expect(copy.background).toBe(src.background);
    ['tags', 'images', 'files', 'links', 'qa'].forEach((f) => {
      expect(JSON.stringify(copy[f]), f + ' 必须逐字节搬过去').toBe(JSON.stringify(src[f]));
    });
    expect(copy.localPath).toBe(src.localPath);
    expect(JSON.stringify(copy.origin)).toBe(JSON.stringify(src.origin));
    expect(copy.detailMode).toBe('rich');
    // 条目：内容照搬（含 `_container` / `_groupStart` 这类下划线键），只有 id 换新
    const norm = (arr) => JSON.stringify(arr.map((it) => { const o = Object.assign({}, it); delete o.id; return o; }));
    expect(norm(copy.items)).toBe(norm(src.items));
    expect(copy.items[0].id).toBe('i-aaa-new');
    expect(copy.items[0]._container).toEqual({ open: '<ul>', close: '</ul>' });
    expect(copy.items[0]._groupStart).toBe(true);
    // 深拷贝（不是同一份引用）：改副本不得动到源
    copy.items[0].html = '<p>改过了</p>';
    copy.tags.push('丙');
    expect(src.items[0].html).toBe('<p>条目甲</p>');
    expect(src.tags).toEqual(['甲', '乙']);
  });

  it('空数组 `items: []` 也照搬（"有它即条目化"，丢了它就把节点从 v3 打回 v2）', () => {
    const src = { id: 'e', topic: '空条目化', items: [], children: [] };
    const copy = editCmd.cloneNode(src, mintSeq('c'), false, (oldId) => oldId + '-new');
    expect(Array.isArray(copy.items)).toBe(true);
    expect(copy.items.length).toBe(0);
  });

  it('节点有 items 却**没给** mintItem ⇒ 响亮抛错（绝不静默照搬旧 id 去撞闸门）', () => {
    const src = { id: 'q', topic: 'x', items: [{ id: 'i-1', type: 'text', html: '<p>a</p>' }], children: [] };
    expect(() => editCmd.cloneNode(src, mintSeq('c'), false)).toThrowError(/mintItem/);
  });

  it('`--deep` 递归：子树里每个节点都走同一份字段表（老实现只对根生效也会静默漏）', () => {
    const src = {
      id: 'root-x', topic: '根', children: [
        { id: 'kid', topic: '子', items: [{ id: 'i-k', type: 'text', html: '<p>k</p>' }], localPath: 'E:\\k', children: [] }
      ]
    };
    const copy = editCmd.cloneNode(src, mintSeq('c'), true, (oldId) => oldId + '-new');
    expect(copy.children[0].localPath).toBe('E:\\k');
    expect(copy.children[0].items[0].id).toBe('i-k-new');
    expect(copy.children[0].items[0].html).toBe('<p>k</p>');
  });

  it('旧形状零差：不含新字段的节点，克隆结果与 **HEAD 版实现**逐字节相同、且不多一个键', () => {
    /* HEAD 的局部 deepCopy（`git show HEAD:cli/commands/edit.js` 的 461-474 行）逐字重放。
       这份"老实现"刻意留在测试里：它是"只增字段"这条性质的反面参照物。 */
    const oldImpl = (n, mint, deep) => {
      const node = { id: mint(n.id), topic: n.topic, expanded: n.expanded !== false, children: [] };
      if (n.detail !== undefined) node.detail = n.detail;
      if (n.background !== undefined) node.background = n.background;
      if (Array.isArray(n.tags) && n.tags.length) node.tags = n.tags.slice();
      if (Array.isArray(n.images) && n.images.length) node.images = JSON.parse(JSON.stringify(n.images));
      if (Array.isArray(n.files) && n.files.length) node.files = JSON.parse(JSON.stringify(n.files));
      if (Array.isArray(n.links) && n.links.length) node.links = JSON.parse(JSON.stringify(n.links));
      if (Array.isArray(n.qa) && n.qa.length) node.qa = JSON.parse(JSON.stringify(n.qa));
      if (Array.isArray(n.tags) && n.tags.length) node.tags = n.tags.slice();
      if (deep) node.children = (n.children || []).map((c) => oldImpl(c, mint, true));
      return node;
    };
    const oldShape = {
      id: 'o', topic: '旧形状', expanded: true,
      detail: '<p>v2 正文</p>', tags: ['甲'], background: '#eee',
      children: [{ id: 'o-kid', topic: '旧子', children: [] }]
    };
    const nowCopy = editCmd.cloneNode(oldShape, freshMint('c'), true, (oldId) => oldId + '-new');
    const oldCopy = oldImpl(oldShape, freshMint('c'), true);
    expect(JSON.stringify(nowCopy)).toBe(JSON.stringify(oldCopy));
    // 再钉一遍"没有凭空多出来的键"（items/detailMode/localPath/origin 一个都不许出现）
    const extra = ['items', 'detailMode', 'localPath', 'origin'].filter((f) => f in nowCopy);
    expect(extra, '旧形状副本上不该多出这些键：' + extra.join(',')).toEqual([]);
    expect(Object.keys(nowCopy)).toEqual(['id', 'topic', 'expanded', 'children', 'detail', 'background', 'tags']);
    expect(Object.keys(nowCopy.children[0])).toEqual(['id', 'topic', 'expanded', 'children']);
  });

  it('缺值不产生键：`undefined` 的字段在副本上**不存在**（不是存在但为 undefined）', () => {
    const src = { id: 'u', topic: '缺值', detail: undefined, localPath: undefined, origin: undefined, items: undefined, children: [] };
    const copy = editCmd.cloneNode(src, mintSeq('c'), false, (oldId) => oldId + '-new');
    ['detail', 'background', 'localPath', 'origin', 'items', 'detailMode', 'qa', 'tags'].forEach((f) => {
      expect(f in copy, f + ' 不该产生键').toBe(false);
    });
    expect(Object.keys(copy)).toEqual(['id', 'topic', 'expanded', 'children']);
  });
});

/* ============================================================
 * 乙组 · 判据：分析器必须会红（判别力证明的**可执行影子**）
 * ============================================================ */
describe('乙组 · 加注分析器（judgment 的单元级判别力）', () => {
  const real = EDIT_SRC();

  it('真实源码读一遍：ok=true、缺=[]、表行数 == 赋值个数（且覆盖全表，忽略两边的书写次序）', () => {
    const r = analyzeCloneFieldCopy(real);
    expect({ ok: r.ok, missing: r.missing, unknown: r.unknown, drift: r.drift })
      .toEqual({ ok: true, missing: [], unknown: [], drift: [] });
    expect(r.parsed).toBe(r.fields);
    expect(r.parsed).toBe(NODE_FIELD_NAMES.length);
    expect(r.seen.slice().sort()).toEqual(NODE_FIELD_NAMES.slice().sort());
  });

  it('★注入①：删掉 `items` 的**赋值**（表还在）⇒ 必红，且 `missing` 点名 items（= 真的会被抹掉）', () => {
    const injected = real.replace(/^.*node\.items = cloneItems.*$/m, '');
    expect(injected).not.toBe(real);                       // 注入确实改到了东西（否则这条用例是空转）
    const r = analyzeCloneFieldCopy(injected);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('items');
  });

  it('★注入②：只删字段表里 `items` 那一行（代码还在）⇒ 仍必红，但归入 `drift`（表在骗人、数据没丢）', () => {
    const injected = real.replace(/^.*\[选\] items .*$/m, '');
    expect(injected).not.toBe(real);
    const r = analyzeCloneFieldCopy(injected);
    expect(r.ok).toBe(false);
    expect(r.drift).toContain('items');
    expect(r.missing, '代码还在写 items ⇒ 不是"丢字段"，两档必须分得开').toEqual([]);
  });

  it('★注入③：写入一个契约外的字段 ⇒ 红（unknown 点名它）', () => {
    const injected = real.replace(/(\n  if \(n\.origin !== undefined\))/, '\n  if (n.knowledge !== undefined) node.knowledge = n.knowledge;$1');
    expect(injected).not.toBe(real);
    const r = analyzeCloneFieldCopy(injected);
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('knowledge');
  });

  it('★注入④：锚点没了（函数改名）⇒ 不许把"定位失败"当成"覆盖齐全"（缺 = 全表）', () => {
    const injected = real.replace(/function cloneNode\(/, 'function copyNode(');
    expect(injected).not.toBe(real);
    const r = analyzeCloneFieldCopy(injected);
    expect(r.ok).toBe(false);
    expect(r.anchors.decl).toBe(0);
    expect(r.missing).toEqual(NODE_FIELD_NAMES);
  });

  it('合成源码：覆盖齐全时 ok；删赋值 ⇒ missing 点名；只删加注 ⇒ drift 点名', () => {
    const table = NODE_FIELD_NAMES.map((f) => '  /* [选] ' + f + '  */').join('\n');
    const code = NODE_FIELD_NAMES.map((f) => '  node.' + f + ' = 1;').join('\n');
    const good = 'function cloneNode(n) {\n' + table + '\n' + code + '\n  return node;\n}';
    expect(analyzeCloneFieldCopy(good).ok).toBe(true);
    const noAssign = good.replace(/^.*node\.tags = 1;.*$/m, '');
    expect(analyzeCloneFieldCopy(noAssign).missing).toEqual(['tags']);
    const noRow = good.replace(/^.*\[选\] tags .*$/m, '');
    const r2 = analyzeCloneFieldCopy(noRow);
    expect(r2.missing).toEqual([]);
    expect(r2.drift).toEqual(['tags']);
  });

  it('共用清单自检：两条判据取的是**同一张表**（契约表非空、required/optional 分档不重叠）', () => {
    expect(NODE_FIELD_NAMES.length).toBeGreaterThan(0);
    expect(NODE_FIELD_NAMES).toEqual(expect.arrayContaining(['id', 'topic', 'expanded', 'children', 'items', 'detailMode', 'localPath', 'origin']));
    const overlap = NODE_FIELDS_OPTIONAL.filter((f) => !NODE_FIELD_NAMES.includes(f));
    expect(overlap, '可选档必须来自同一张表').toEqual([]);
  });
});

/* ============================================================
 * 丙组 · 端到端：走真命令（进程内、沙箱）——字段真的落到盘上
 * ============================================================ */
describe('丙组 · 端到端（沙箱 + invokeSync）：clone / apply 都带全字段', () => {
  beforeAll(() => {
    expect(run('init', P, '--title', '克隆字段保真').code).toBe(0);
    expect(run('add', P, 'root', '--id', 'n1', '--topic', '条目化源节点').code).toBe(0);
    expect(run('item-add', P, 'n1', '--html', '<p>条目甲</p>').code).toBe(0);
    expect(run('edit', P, 'n1', '--local-path', 'E:\\资料\\M1').code).toBe(0);
    /* `origin` / `detailMode` 命令面没有入口（前者由 import 写、后者由迁移写）⇒ 直接写盘造夹具：
       本组要验的正是"字段**在场**时别丢"，命令面怎么造它不影响这条判据。 */
    const d = readDisk();
    const find = (id) => { let h = null; (function w(n) { if (!n) return; if (n.id === id) { h = n; return; } (n.children || []).forEach(w); })(d.data); return h; };
    find('n1').origin = { kind: 'import', src: 'docA.md', sha256: 'b'.repeat(64), at: '2026-10-12T00:00:00.000Z' };
    d.data.children.push({ id: 'n2', topic: '富文本源节点', detailMode: 'rich', detail: '<h3>富文本</h3>', children: [] });
    fs.writeFileSync(projFile(), JSON.stringify(d, null, 2), 'utf8');
  });

  afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); });

  it('clone 一个含 items + localPath + origin 的节点：副本逐字段带过去，且源不动', () => {
    const before = JSON.stringify(nodeOnDisk('n1'));
    const r = run('clone', P, 'n1', 'root');
    expect(r.code, r.out).toBe(0);
    const copy = walkAll((n) => {});
    void copy;
    // 副本 = 与源同题、不同 id 的那一个
    let hit = null;
    walkAll((n) => { if (n.topic === '条目化源节点' && n.id !== 'n1') hit = n; });
    expect(hit, '没找到副本（clone 没落地？）').toBeTruthy();
    expect(Array.isArray(hit.items)).toBe(true);
    expect(hit.items.length).toBe(1);
    expect(hit.items[0].id).not.toBe(nodeOnDisk('n1').items[0].id);
    expect(hit.items[0].html).toBe('<p>条目甲</p>');
    expect(hit.localPath).toBe('E:\\资料\\M1');
    expect(hit.origin.src).toBe('docA.md');
    expect(hit.detail).toBe(nodeOnDisk('n1').detail);        // 派生缓存在，且与源一致
    expect(JSON.stringify(nodeOnDisk('n1'))).toBe(before);   // 源节点一个字节都没动
    expect(run('validate', P).code, '克隆后必须仍然过闸门').toBe(0);
  });

  it('clone 一个富文本（detailMode）节点：`detailMode:"rich"` 带过去', () => {
    expect(run('clone', P, 'n2', 'root').code).toBe(0);
    let hit = null;
    walkAll((n) => { if (n.topic === '富文本源节点' && n.id !== 'n2') hit = n; });
    expect(hit).toBeTruthy();
    expect(hit.detailMode).toBe('rich');
    expect(hit.detail).toBe('<h3>富文本</h3>');
    expect(run('validate', P).code).toBe(0);
  });

  it('`apply` 的 clone op 走**同一份**实现：条目化节点的 items 也带过去（且 id 不重复）', () => {
    const ops = JSON.stringify({ version: 1, ops: [{ op: 'clone', id: 'n1', parent: 'root' }] });
    const r = run('apply', P, '--ops-file', ops);
    expect(r.code, r.out).toBe(0);
    const ids = [];
    walkAll((n) => { (Array.isArray(n.items) ? n.items : []).forEach((it) => ids.push(it.id)); });
    expect(new Set(ids).size, '条目 id 必须全项目唯一（重复即闸门判红）：' + ids.join(',')).toBe(ids.length);
    let hit = null;
    walkAll((n) => { if (n.topic === '条目化源节点' && n.id !== 'n1') hit = n; });
    expect(hit && Array.isArray(hit.items) && hit.items.length).toBeTruthy();
    expect(hit.items[0].html).toBe('<p>条目甲</p>');
    expect(run('validate', P).code).toBe(0);
  });
});
