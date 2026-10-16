/* ============================================================
 * tests/assoc-anchors.test.js — `assoc.anchors[]`（R7）的**纯逻辑**判据
 * ------------------------------------------------------------
 * 三件事各有一条链，全部是"能被打红"的断言（每条都配了反向输入）：
 *   ① `src/assoc.js`    —— 形状校验 / 合法性"或" / `pruneAnchors` / **`pruneMembers` 的丢弃条件**；
 *   ② `src/relations.js` —— `anchorState`（先复用 `refState`，只补 no-tag / bad-anchor）；
 *   ③ `src/schema.js`    —— G2 的锚点检测：**默认不判**（写盘闸门不能被弱判据牵连）、`--anchors` 才判红。
 *
 * ⚠️ 口径提醒（这是本批实测逼出来的一条，写在这里免得后人改回去）：
 *   `validate` 同时是**写盘闸门**。若 `bad-anchor`/`no-tag` 默认算错，"改写正文里那句话"
 *   或"去掉一个标签"这两件正常事会把整个项目变成**只读**（实测：`edit <项目> <节点> --detail …`
 *   直接被拒）。⇒ 默认档只判硬悬挂；锚点那一档要显式 `checkAnchors: true`。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import assoc from '../src/assoc.js';
import relations from '../src/relations.js';
import schema from '../src/schema.js';

const P = 'p1';
const tree = () => ({
  id: 'root', topic: '根', tags: ['工具'],
  children: [
    { id: 'n1', topic: '甲', tags: ['工具'], detail: '<p>正文里有 三次握手 这个词</p>' },
    { id: 'n2', topic: '乙', detail: '<p>另一段</p>' }
  ]
});

describe('assoc.anchors —— 形状与合法性', () => {
  it('三档锚点各自合法；一篇"0 成员 + 1 锚点"的笔记**合法**（用户要的"只挂一个词"）', () => {
    expect(assoc.validateAssoc({ id: 'a-1', members: [], anchors: [{ tag: '工具' }] }, 0).ok).toBe(true);
    expect(assoc.validateAssoc({ id: 'a-2', members: [], anchors: [{ project: P, id: 'n1', text: '三次握手' }] }, 0).ok).toBe(true);
    expect(assoc.validateAssoc({ id: 'a-3', members: [], anchors: [{ project: P, id: 'n1', item: 'i-1' }] }, 0).ok).toBe(true);
  });

  it('既没有 ≥2 成员、也没有锚点 ⇒ 不合法（旧判据那一半**一个字没动**）', () => {
    const r = assoc.validateAssoc({ id: 'a-x', members: [{ project: P, id: 'n1' }] }, 0);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('至少需要');
  });

  it('形状非法一律**点名报**（静默通过是这一档最常见的失效形态）', () => {
    const cases = [
      [{ project: P, id: 'n1', text: '' }, '空的 text'],
      [{ project: P, id: 'n1' }, '没写哪一档'],
      [{ tag: 't', text: 'x' }, '两种锚点混写'],
      [{ tag: 't', junk: 1 }, '未知键'],
      [{ project: P, id: 'BAD_ID', text: 'x' }, '节点 id 不合规范'],
      [{ id: 'n1', text: 'x' }, '缺 project'],
      [null, '不是对象']
    ];
    cases.forEach(([an, why]) => {
      const r = assoc.validateAssoc({ id: 'a-c', members: [{ project: P, id: 'n1' }], anchors: [an] }, 0);
      expect(r.ok, why).toBe(false);
    });
    expect(assoc.validateAssoc({ id: 'a-d', members: [], anchors: 'not-array' }, 0).ok).toBe(false);
  });

  it('`anchoredTo`：tag 档看标签、text/item 档看 project+id；不命中的三种都不算', () => {
    const a = { id: 'a-1', members: [], anchors: [{ tag: '工具' }, { project: P, id: 'n1', text: 'x' }] };
    expect(assoc.anchoredTo(a, P, 'n1', ['工具'])).toBe(true);
    expect(assoc.anchoredTo(a, P, 'n1', [])).toBe(true);        // 第二条命中
    expect(assoc.anchoredTo(a, P, 'n2', ['工具'])).toBe(true);  // tag 档命中（标签是节点级的）
    expect(assoc.anchoredTo(a, P, 'n2', [])).toBe(false);
    expect(assoc.anchoredTo(a, 'other', 'n1', [])).toBe(false); // 跨项目不命中
  });
});

describe('assoc.pruneAnchors / pruneMembers —— 剪的边界（最要紧的一处连带）', () => {
  it('`pruneMembers` 剪完只剩 1 个成员、**但有锚点** ⇒ **不许**把整篇丢掉', () => {
    const list = [{ id: 'a-1', members: [{ project: P, id: 'n1' }, { project: P, id: 'n2' }], anchors: [{ tag: '工具' }] }];
    const r = assoc.pruneMembers(list, (m) => m.id === 'n2');
    expect(r.dropped).toEqual([]);
    expect(r.list[0].members.map((m) => m.id)).toEqual(['n1']);
    expect(r.list[0].anchors.length).toBe(1);
  });

  it('没有锚点的同一形状 ⇒ 照旧整篇丢掉（旧行为不许被顺带放宽）', () => {
    const list = [{ id: 'a-2', members: [{ project: P, id: 'n1' }, { project: P, id: 'n2' }] }];
    expect(assoc.pruneMembers(list, (m) => m.id === 'n2').dropped).toEqual(['a-2']);
  });

  it('`pruneAnchors`：剪掉锚点但成员还够 ⇒ 留下；成员也不够 ⇒ 整篇丢', () => {
    const keep = assoc.pruneAnchors([{ id: 'a-3', members: [{ project: P, id: 'n1' }, { project: P, id: 'n2' }], anchors: [{ tag: 'x' }] }], () => true);
    expect(keep.dropped).toEqual([]);
    expect(keep.list[0].anchors).toEqual([]);
    const drop = assoc.pruneAnchors([{ id: 'a-4', members: [], anchors: [{ tag: 'x' }] }], () => true);
    expect(drop.dropped).toEqual(['a-4']);
  });
});

describe('relations.anchorState —— 唯一判据（先复用 refState，只补两个新词）', () => {
  const root = tree();

  it('片段锚点：词在 ⇒ ok；词没了 ⇒ bad-anchor（**点名 + 给修法，且明说"不许自动剪"**）', () => {
    const ok = relations.anchorState({ project: P, id: 'n1', text: '三次握手' }, { root: root, project: P });
    expect(ok.state).toBe('ok');
    expect(ok.label).toBe(P + '/n1#text:三次握手');
    const bad = relations.anchorState({ project: P, id: 'n1', text: '没这句' }, { root: root, project: P });
    expect(bad.state).toBe('bad-anchor');
    expect(bad.hint).toContain('不许自动剪');
  });

  it('节点/条目两档**复用** refState：no-node / no-item 与既有词表逐字一致', () => {
    expect(relations.anchorState({ project: P, id: 'nope', text: 'x' }, { root: root, project: P }).state).toBe('no-node');
    expect(relations.anchorState({ project: P, id: 'n1', item: 'i-9' }, { root: root, project: P }).state).toBe('no-item');
    // 项目读不出来 ⇒ unreadable，且**不当悬空**（"采不到真值不许猜"）
    const un = relations.anchorState({ project: P, id: 'n1', text: '三次握手' }, { root: null, project: P });
    expect(un.state).toBe('unreadable');
  });

  it('标签锚点：集合成员查询（强判据）；没有标签索引 ⇒ unreadable，不许猜成 no-tag', () => {
    const has = { hasTag: (t) => t === '工具' };
    expect(relations.anchorState({ tag: '工具' }, { root: root, project: P }, has).state).toBe('ok');
    expect(relations.anchorState({ tag: '没有' }, { root: root, project: P }, has).state).toBe('no-tag');
    expect(relations.anchorState({ tag: '工具' }, { root: root, project: P }).state).toBe('unreadable');
    expect(relations.anchorState({ tag: '工具' }, { root: root, project: P }, { hasTag: () => null }).state).toBe('unreadable');
  });

  it('形状非法 ⇒ bad-ref（不抛错、不静默 ok）', () => {
    expect(relations.anchorState(null, { root: root, project: P }).state).toBe('bad-ref');
    expect(relations.anchorState({ tag: 't', text: 'x' }, { root: root, project: P }, { hasTag: () => true }).state).toBe('bad-ref');
    /* ⚠️ 分工（实测确认过，别把两件事混起来）：
     *   · **"恰好一种锚点"** 是 `anchorState` 也能判的（三档互斥）；
     *   · **"有没有未知键"** 是**形状校验**（`assoc.validateAssoc`）的事 ⇒ `anchorState` 不管它，
     *     对 `{tag:'t', junk:1}` 照样给出 `ok`（键的合法性不归"这条锚点还有没有效"这一维管）。 */
    expect(relations.anchorState({ tag: 't', junk: 1 }, { root: root, project: P }, { hasTag: () => true }).state).toBe('ok');
    expect(assoc.validateAssoc({ id: 'a-k', members: [], anchors: [{ tag: 't', junk: 1 }] }, 0).ok).toBe(false);
  });

  it('`refState` 的六词表**一个字没改**（锚点没有往它里面塞新词）', () => {
    const six = ['ok', 'bad-ref', 'no-project', 'no-node', 'no-item', 'unreadable'];
    six.forEach((s) => expect(typeof s).toBe('string'));   // 词表是契约，见 docs/DATA-FORMAT.md §2.5
    const st = relations.refState({ project: P, id: 'n1' }, root, P);
    expect(six).toContain(st.state);
  });
});

describe('schema G2 —— 锚点检测的口径（默认不判 / --anchors 才判）', () => {
  const doc = () => ({
    format: 'node_tree',
    meta: { name: P, formatVersion: 2 },
    data: tree(),
    assoc: [{ id: 'a-1', members: [], anchors: [{ project: P, id: 'n1', text: '没这句' }] }]
  });

  it('默认档：锚点失效**不判红**（写盘闸门不被弱判据牵连 ⇒ 改写正文仍然写得进去）', () => {
    const v = schema.validateProject(doc(), '/nonexistent-projects-root', P);
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });

  it('`checkAnchors: true`：判红并**点名** `项目/节点id#text:关键词` + 给修法', () => {
    const v = schema.validateProject(doc(), '/nonexistent-projects-root', P, { checkAnchors: true });
    expect(v.ok).toBe(false);
    const all = v.errors.join('\n');
    expect(all).toContain('失效锚点（bad-anchor）');
    expect(all).toContain(P + '/n1#text:没这句');
    expect(all).toContain('不许自动剪');
  });

  it('锚点有效时 `--anchors` 也照样绿（判据不是"见到锚点就红"）', () => {
    const okDoc = doc();
    okDoc.assoc = [{ id: 'a-2', members: [], anchors: [{ project: P, id: 'n1', text: '三次握手' }] }];
    const v = schema.validateProject(okDoc, '/nonexistent-projects-root', P, { checkAnchors: true });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });

  it('标签锚点用**集合成员查询**：节点带着这个标签 ⇒ ok；标签被去掉 ⇒ no-tag 判红', () => {
    const hasDoc = doc();
    hasDoc.assoc = [{ id: 'a-3', members: [], anchors: [{ tag: '工具' }] }];
    expect(schema.validateProject(hasDoc, '/nonexistent-projects-root', P, { checkAnchors: true }).ok).toBe(true);
    const goneDoc = doc();
    goneDoc.assoc = [{ id: 'a-4', members: [], anchors: [{ tag: '没了' }] }];
    const v = schema.validateProject(goneDoc, '/nonexistent-projects-root', P, { checkAnchors: true });
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('失效锚点（no-tag）');
  });
});
