/* ============================================================
 * tests/merge-project.test.js — `src/merge-project.js` 的纯逻辑单测（vitest）
 * ------------------------------------------------------------
 * 为什么这些断言必须在这里（而不是只在集成里）：集成跑一次要真盘上两个项目、走 CLI 子进程，
 * 慢且只能覆盖一两条路径；而本模块的判据有十几条**互斥的拒绝分支**（父节点 / id 撞号 /
 * 已合并过 / 分组 id 被占 / 条目 id 撞号 / 未知字段 / assoc / bindings / 格式版本 / 边核验不过），
 * 每一条都要能单独验，且要能验"拒绝时**一个键都没改**"——只有纯函数层做得到。
 *
 * 断言的口径（与 `docs/ITEM-MODEL.md` / `docs/DATA-FORMAT.md` 对齐）：
 *   · **节点数 = 原 + 源**（分组节点就是源根，只换 id ⇒ 一换一，净增 = 源节点数）；
 *   · 除源根外的 id **逐字带走**（不重签发）、`origin` 逐字带走（不重算）；
 *   · 幂等判定键 = 分组 id 存在 + 该源全部非根 id 都在目标里；
 *   · `--links repoint` **逐条核验**，任一条核验不过 ⇒ 整体拒绝（且目标数据一个字节没动）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import merge from '../src/merge-project.js';

const { mergeProjectData, defaultGroupIdOf, GROUP_PREFIX, LINKS_MODES } = merge;

/** 造一棵最小项目：`{meta, format, data}`（形状与 `projects/<名>/<名>.json` 一致） */
function mkProj(name, rootTopic, spec, opts) {
  const o = opts || {};
  let seq = 0;
  const build = (s) => ({
    id: s.id,
    topic: s.topic,
    expanded: s.expanded === undefined ? false : s.expanded,
    children: (s.children || []).map(build),
    ...(s.origin ? { origin: s.origin } : {}),
    ...(s.links ? { links: s.links } : {}),
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.items ? { items: s.items } : {})
  });
  void seq;
  return {
    meta: { name: rootTopic, version: '0.19.0', formatVersion: o.formatVersion === undefined ? 2 : o.formatVersion },
    format: 'node_tree',
    data: build(spec)
  };
}

const ORIGIN_A = { kind: 'import', src: 'C:/tmp/a.md', sha256: 'a'.repeat(64), at: '2026-10-15T00:00:00.000Z', tool: 'import-md' };

/** 目标：root → x（有 detail、有链接指向 comnet 自己） */
const targetProj = () => mkProj('tgt', 'TGT', {
  id: 'root', topic: 'TGT', expanded: true, children: [
    { id: 'x', topic: 'X 节点', expanded: false, detail: '<p>x</p>', links: [{ project: 'tgt', id: 'root' }] },
    { id: 'y', topic: 'Y 节点', expanded: false }
  ]
});

/** 源：root → (a → a1, b)，a 带 origin，b 有一条指向目标项目的边 */
const sourceProj = (name) => mkProj(name || 'src', 'SRC 书名', {
  id: 'root', topic: 'SRC 书名', expanded: true, children: [
    { id: 'a', topic: 'A 章', expanded: false, origin: ORIGIN_A, children: [{ id: 'a1', topic: 'A1 节', expanded: false }] },
    { id: 'b', topic: 'B 章', expanded: false, links: [{ project: 'tgt', id: 'x', caption: '跨项目边' }] }
  ]
});

/** 同形但 id 都带前缀的源（多源用例要用 —— 否则两个源之间会撞号，那是另一个判据） */
const sourceProjP = (name) => mkProj(name, '书 ' + name, {
  id: 'root', topic: '书 ' + name, expanded: false, children: [
    { id: name + '-a', topic: name + ' A 章', expanded: false, children: [{ id: name + '-a1', topic: name + ' A1 节', expanded: false }] },
    { id: name + '-b', topic: name + ' B 章', expanded: false }
  ]
});

function call(over) {
  return mergeProjectData(Object.assign({
    target: { name: 'tgt', data: targetProj() },
    sources: [{ name: 'src', data: sourceProj() }],
    parentId: 'root',
    linksMode: 'keep'
  }, over || {}));
}

function findNode(root, id) {
  let hit = null;
  (function w(n) { if (n.id === id) hit = n; (n.children || []).forEach(w); })(root);
  return hit;
}
function allNodes(root) {
  const out = [];
  (function w(n) { out.push(n); (n.children || []).forEach(w); })(root);
  return out;
}

describe('merge-project · 基本形态（分组节点 = 源根，只换 id）', () => {
  it('节点数 = 原 + 源（分组节点一换一，净增 = 源节点数）', () => {
    const r = call();
    expect(r.ok).toBe(true);
    expect(allNodes(r.data.data).length).toBe(2 + 1 + 4);   // 目标 3 + 源 4
    expect(r.totals.targetNodesBefore).toBe(3);
    expect(r.totals.targetNodesAfter).toBe(7);
    expect(r.totals.addedNodes).toBe(4);
    expect(r.totals.sourceNodes).toBe(4);
  });

  it('分组节点 id 是确定性的 `merge-<源项目名>`，topic/expanded 就是源根的', () => {
    const r = call();
    const g = findNode(r.data.data, 'merge-src');
    expect(g).toBeTruthy();
    expect(g.topic).toBe('SRC 书名');
    expect(g.expanded).toBe(true);
    expect(r.groups[0].groupId).toBe(GROUP_PREFIX + 'src');
    expect(defaultGroupIdOf('src')).toBe(GROUP_PREFIX + 'src');
  });

  it('除源根外的 id **逐字带走**（不重签发）', () => {
    const r = call();
    ['a', 'a1', 'b'].forEach((id) => expect(findNode(r.data.data, id), id).toBeTruthy());
  });

  it('origin 逐字原样带走（src/sha256/at/tool 全部相同，不重算）', () => {
    const r = call();
    const a = findNode(r.data.data, 'a');
    expect(a.origin).toEqual(ORIGIN_A);
    expect(r.totals.originNodes).toBe(1);
  });

  it('原目标里的节点与它们的字段一个字节没动', () => {
    const before = targetProj();
    const r = call({ target: { name: 'tgt', data: before } });
    const x = findNode(r.data.data, 'x');
    expect(x.detail).toBe('<p>x</p>');
    expect(x.links).toEqual([{ project: 'tgt', id: 'root' }]);
    expect(findNode(r.data.data, 'y')).toBeTruthy();
  });

  it('分组的子节点顺序 = 源根的 children 顺序（逐条）', () => {
    const r = call();
    expect(findNode(r.data.data, 'merge-src').children.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('--parent 指定中间节点时挂到它下面（不是 root）', () => {
    const r = call({ parentId: 'x' });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'x').children.map((c) => c.id)).toEqual(['merge-src']);
    expect(findNode(r.data.data, 'root').children.map((c) => c.id)).toEqual(['x', 'y']);
  });

  it('多源：每个源一个分组节点，顺序 = 命令行顺序', () => {
    const r = call({
      sources: [{ name: 's1', data: sourceProjP('s1') }, { name: 's2', data: sourceProjP('s2') }]
    });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'root').children.map((c) => c.id)).toEqual(['x', 'y', 'merge-s1', 'merge-s2']);
    expect(r.totals.addedNodes).toBe(8);
  });

  it('--group-id 自定分组 id（单源）', () => {
    const r = call({ groupIdOf: () => 'my-group' });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'my-group')).toBeTruthy();
  });

  it('源项目只有根（没有子节点）：不报错，分组为空', () => {
    const empty = mkProj('e', '空源', { id: 'root', topic: '空源', expanded: true, children: [] });
    const r = call({ sources: [{ name: 'e', data: empty }] });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'merge-e').children).toEqual([]);
    expect(r.totals.addedNodes).toBe(1);
  });
});

describe('merge-project · 边（links[]）', () => {
  it('--links keep（默认）：一个字节都不改，并如实报计数', () => {
    const r = call();
    const b = findNode(r.data.data, 'b');
    expect(b.links).toEqual([{ project: 'tgt', id: 'x', caption: '跨项目边' }]);
    expect(r.totals.linksMode).toBe('keep');
    expect(r.totals.links.toTarget).toBe(1);
    expect(r.totals.links.repointed).toBe(0);
  });

  it('--links repoint：指向本次合并源的边改指目标项目内的同 id', () => {
    const src = sourceProj('src');
    /* 让 b 的边指向**另一个也在本次合并里的源** */
    src.data.children[1].links = [{ project: 's2', id: 'c1', caption: '跨源边' }];
    const s2 = mkProj('s2', 'S2', { id: 'root', topic: 'S2', expanded: false, children: [{ id: 'c1', topic: 'C1', expanded: false }] });
    const r = call({ sources: [{ name: 'src', data: src }, { name: 's2', data: s2 }], linksMode: 'repoint' });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'b').links).toEqual([{ project: 'tgt', id: 'c1', caption: '跨源边' }]);
    expect(r.totals.links.repointed).toBe(1);
    expect(r.totals.links.repointedByProject).toEqual({ s2: 1 });
  });

  it('--links repoint：指向"该源的根"的边改指那个源的分组节点', () => {
    const src = sourceProj('src');
    src.data.children[1].links = [{ project: 's2', id: 'root' }];
    const s2 = mkProj('s2', 'S2', { id: 'root', topic: 'S2', expanded: false, children: [] });
    const r = call({ sources: [{ name: 'src', data: src }, { name: 's2', data: s2 }], linksMode: 'repoint' });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'b').links).toEqual([{ project: 'tgt', id: 'merge-s2' }]);
  });

  it('--links repoint：核验不过（那个源里没这个 id）⇒ **整体拒绝并点名**，目标数据一个字节没动', () => {
    const src = sourceProj('src');
    src.data.children[1].links = [{ project: 's2', id: 'no-such-node' }];
    const s2 = mkProj('s2', 'S2', { id: 'root', topic: 'S2', expanded: false, children: [] });
    const tgt = targetProj();
    const snapshot = JSON.stringify(tgt);
    const r = call({ target: { name: 'tgt', data: tgt }, sources: [{ name: 'src', data: src }, { name: 's2', data: s2 }], linksMode: 'repoint' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('unprovable-link');
    expect(r.message).toMatch(/no-such-node/);
    expect(r.message).toMatch(/绝不按序号猜|不猜/);
    expect(JSON.stringify(tgt)).toBe(snapshot);       // ← 拒绝时盘面（内存数据）零改动
  });

  it('--links 非法取值 ⇒ 拒绝并列两个取值', () => {
    const r = call({ linksMode: 'nonsense' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad-links-mode');
    expect(r.message).toMatch(/keep/);
    expect(r.message).toMatch(/repoint/);
    expect(LINKS_MODES).toEqual(['keep', 'repoint']);
  });

  it('指向本次合并之外的第三方的边：原样保留并单独计数', () => {
    const src = sourceProj('src');
    src.data.children[1].links = [{ project: 'other', id: 'z' }];
    const r = call({ sources: [{ name: 'src', data: src }] });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'b').links).toEqual([{ project: 'other', id: 'z' }]);
    expect(r.totals.links.toOutside).toBe(1);
    expect(r.totals.links.outsideProjects).toEqual({ other: 1 });
  });
});

describe('merge-project · 拒绝分支（每一条都点名 + 目标数据零改动）', () => {
  function expectRefuse(over, code, needle) {
    const tgt = targetProj();
    const snapshot = JSON.stringify(tgt);
    const r = call(Object.assign({ target: { name: 'tgt', data: tgt } }, over || {}));
    expect(r.ok, '应该拒绝，实际成功').toBe(false);
    expect(r.code).toBe(code);
    if (needle) expect(r.message).toMatch(needle);
    expect(JSON.stringify(tgt), '拒绝时目标数据必须一个字节没动').toBe(snapshot);
    return r;
  }

  it('父节点不存在', () => {
    expectRefuse({ parentId: 'no-such' }, 'no-parent', /父节点不存在: no-such/);
  });

  it('源 = 目标', () => {
    expectRefuse({ sources: [{ name: 'tgt', data: targetProj() }] }, 'self-merge', /不能是目标项目本身/);
  });

  it('源项目重复给了', () => {
    expectRefuse({ sources: [{ name: 'src', data: sourceProj() }, { name: 'src', data: sourceProj() }] },
      'dup-source', /重复/);
  });

  it('没有源项目', () => {
    expectRefuse({ sources: [] }, 'no-source');
  });

  it('id 撞号 ⇒ 点名 id + 两边主题', () => {
    /* 源里两个节点：`x` 与目标撞、`k` 不撞 ⇒ 这才是"撞号"而不是"已经合并过"（全撞是另一档） */
    const src = mkProj('src', 'SRC', {
      id: 'root', topic: 'SRC', expanded: false, children: [
        { id: 'x', topic: '源里的 X', expanded: false },
        { id: 'k', topic: '源里独有', expanded: false }
      ]
    });
    const r = expectRefuse({ sources: [{ name: 'src', data: src }] }, 'id-collision', /id 撞号/);
    expect(r.message).toMatch(/`x`/);
    expect(r.message).toMatch(/源里的 X/);
    expect(r.message).toMatch(/X 节点/);              // 目标里那个 x 的 topic
    expect(r.message).toMatch(/不替你重签发 id/);
  });

  it('同一批两个源之间撞号 ⇒ 拒绝并点名', () => {
    const s1 = sourceProj('s1');
    const s2 = mkProj('s2', 'S2', { id: 'root', topic: 'S2', expanded: false, children: [{ id: 'a', topic: '另一个 a', expanded: false }, { id: 's2-only', topic: 's2 独有', expanded: false }] });
    expectRefuse({ sources: [{ name: 's1', data: s1 }, { name: 's2', data: s2 }] }, 'batch-collision', /`a`/);
  });

  it('幂等：同一份源合并两次 ⇒ 指名上一次落到哪个分组节点', () => {
    const r1 = call();
    expect(r1.ok).toBe(true);
    const r2 = call({ target: { name: 'tgt', data: r1.data } });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('already-merged');
    expect(r2.message).toMatch(/merge-src/);
    expect(r2.message).toMatch(/没有 --force/);
  });

  it('幂等：分组节点被删掉但节点还在 ⇒ 仍拒绝（报"全都在目标里"）', () => {
    const r1 = call();
    const data = r1.data;
    /* 手工把分组节点摘掉，只留它的子节点（模拟"上一次合并的分组被删、内容还在"） */
    const root = data.data;
    const g = findNode(root, 'merge-src');
    root.children = root.children.filter((c) => c.id !== 'merge-src').concat(g.children);
    const r2 = call({ target: { name: 'tgt', data: data } });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('already-merged');
    expect(r2.message).toMatch(/分组节点 merge-src 已不在/);
  });

  it('分组 id 已被占用（但不是上一次合并的残留）⇒ 拒绝并给出路', () => {
    const tgt = targetProj();
    tgt.data.children.push({ id: 'merge-src', topic: '撞名的容器', expanded: false, children: [] });
    const r = mergeProjectData({ target: { name: 'tgt', data: tgt }, sources: [{ name: 'src', data: sourceProj() }], parentId: 'root' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('group-id-taken');
    expect(r.message).toMatch(/merge-src/);
    expect(r.message).toMatch(/--group-id/);
  });

  it('分组 id 不合 id 规范（非 ASCII 项目名）⇒ 拒绝并指 --group-id', () => {
    expectRefuse({ sources: [{ name: '卖点讨论', data: mkProj('卖点讨论', '卖点', { id: 'root', topic: '卖点', expanded: false, children: [] }) }] },
      'bad-group-id', /--group-id/);
  });

  it('条目 id 撞号 ⇒ 拒绝（条目 id 必须全项目唯一）', () => {
    const tgt = targetProj();
    tgt.data.children[0].items = [{ id: 'i-1', type: 'text', html: '<p>x</p>' }];
    const src = sourceProj('src');
    src.data.children[1].items = [{ id: 'i-1', type: 'text', html: '<p>y</p>' }];
    const r = mergeProjectData({ target: { name: 'tgt', data: tgt }, sources: [{ name: 'src', data: src }], parentId: 'root' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('item-id-collision');
    expect(r.message).toMatch(/i-1/);
  });

  it('条目**不撞号**时原样搬运（items 一条不少）', () => {
    const src = sourceProj('src');
    src.data.children[1].items = [{ id: 'i-9', type: 'text', html: '<p>y</p>' }];
    const r = call({ sources: [{ name: 'src', data: src }] });
    expect(r.ok).toBe(true);
    expect(findNode(r.data.data, 'b').items).toEqual([{ id: 'i-9', type: 'text', html: '<p>y</p>' }]);
    expect(r.totals.items).toBe(1);
  });

  it('节点上有未知字段 ⇒ 拒绝并点名那个字段', () => {
    const src = sourceProj('src');
    src.data.children[1].weirdField = 1;
    expectRefuse({ sources: [{ name: 'src', data: src }] }, 'unknown-field', /weirdField/);
  });

  it('源项目有 data.assoc ⇒ 拒绝并点名条数（不静默丢）', () => {
    const src = sourceProj('src');
    src.assoc = [{ id: 'a-1', members: [{ project: 'src', id: 'a' }, { project: 'src', id: 'b' }] }];
    expectRefuse({ sources: [{ name: 'src', data: src }] }, 'source-has-assoc', /data\.assoc/);
  });

  it('源项目有 data.bindings ⇒ 拒绝并点名（活的守护配置不复制）', () => {
    const src = sourceProj('src');
    /* `bindings` 在**项目 JSON 顶层**（`bind-sync --bind` 写的就是它），不在节点树上 */
    src.bindings = [{ id: 'b-1', dir: 'D:/x', mode: 'flat' }];
    expectRefuse({ sources: [{ name: 'src', data: src }] }, 'source-has-bindings', /data\.bindings/);
  });

  it('formatVersion 两边不同 ⇒ 拒绝并给出路', () => {
    const src = sourceProj('src');
    src.meta.formatVersion = 3;
    expectRefuse({ sources: [{ name: 'src', data: src }] }, 'format-version-mismatch', /migrate items/);
  });

  it('一次多源里有一个不过 ⇒ 整条命令拒绝（全成或全不动）', () => {
    const s1 = sourceProj('s1');
    const s2 = sourceProj('s2');
    s2.assoc = [{ id: 'a-1', members: [] }];
    expectRefuse({ sources: [{ name: 's1', data: s1 }, { name: 's2', data: s2 }] }, 'source-has-assoc');
  });

  it('缺 schema（浏览器分支）⇒ 响亮拒绝而不是降级', () => {
    /* 直接构造不了（模块加载时就注入了 schema）⇒ 用入参错误那一档反证"入参闸门存在" */
    const r = mergeProjectData({ });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad-target');
  });
});

describe('merge-project · 结构性不变量', () => {
  it('两次独立调用（同输入）得到**逐字节相同**的结果（确定性：id 一个都不现摇）', () => {
    const a = call();
    const b = call();
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
    expect(JSON.stringify(a.totals)).toBe(JSON.stringify(b.totals));
  });

  it('源项目数据在合并后**一个字节没变**（合并只读源）', () => {
    const src = sourceProj('src');
    const snap = JSON.stringify(src);
    const r = call({ sources: [{ name: 'src', data: src }] });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(src)).toBe(snap);
  });

  it('`MERGE` 的读数自洽：toTarget + toMerged + toOutside + noProject = 合并子树内的边总数', () => {
    const r = call();
    const l = r.totals.links;
    const inSubtree = allNodes(findNode(r.data.data, 'merge-src'))
      .reduce((n, x) => n + (Array.isArray(x.links) ? x.links.length : 0), 0);
    expect(l.toTarget + l.toMerged + l.toOutside + l.noProject).toBe(inSubtree);
  });

  it('目标项目的 `meta` / `format` / 顶层 `assoc` 一个字节没动', () => {
    const tgt = targetProj();
    tgt.assoc = [{ id: 'a-t', members: [{ project: 'tgt', id: 'x' }, { project: 'tgt', id: 'y' }] }];
    const metaSnap = JSON.stringify(tgt.meta);
    const assocSnap = JSON.stringify(tgt.assoc);
    const r = call({ target: { name: 'tgt', data: tgt } });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.data.meta)).toBe(metaSnap);
    expect(JSON.stringify(r.data.assoc)).toBe(assocSnap);
  });
});
