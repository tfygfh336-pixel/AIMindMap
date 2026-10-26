/* ============================================================
 * tests/concurrency-graph.test.js — `graph`（图附加层）必须进合并指纹（vitest）
 * ------------------------------------------------------------
 * 存在的唯一理由（上一批 `MS1` 自己点名的缺口 ③）：`src/concurrency.js` 的 `mergeTrees`
 * 输出是 `clone(theirs)`，而 `fingerprint` **不含 `graph`** ⇒
 *   · 两边的图不同，合并不认为有冲突；
 *   · 于是"我这一侧的图"被**静默丢掉**，面板上还显示"合并成功"。
 * MS1 当时的实测读数是"graph 侥幸保住了"—— 那只是因为**对方那侧没动它**，
 * 不是判据在守。这条缺口一旦让全模式并发写 `graph`（`MS4`），就是静默丢一边的图。
 *
 * 五条判据（每条都钉一个可能被"修歪"的方向）：
 *   ① **指纹含 `graph`**：图变了 ⇒ `changedKeys` 里就有 `graph` 键（缺口本体的正面判据）；
 *   ② **该绿**：两边图相同 + 节点有改动 ⇒ 合并成功，结果里的图与两边一致；
 *   ③ **该红**：两边图不同 ⇒ 默认**拒绝**（`ok:false`、不产生数据）并点名图附加层；
 *   ④ **该红（另一档）**：`onConflict:'theirs'` ⇒ 可以取盘上那一版，但**必须报出来**
 *      （`conflicts` 含 `graph`、`lostOn` 点名）—— 否则只是把"静默丢失"换了个位置；
 *   ⑤ **不许假修**：只有我改了图 / 只有我删了整层图 ⇒ 我的改动要生效
 *      （防"只要涉及 graph 就一律取 theirs"这种把冲突判据放松的做法）。
 * 另有一条守"冲突面板看得见图"：`snapshotOf` / `conflictSnapshots` 取得到三侧的值。
 *
 * ⚠️ 判别力（`B4`）：把 `fingerprint` 里 `fp.graph = …` 那行去掉（退回旧行为），
 *    本文件**必须红** —— 注入器与读数见 `.review/20261057-graph守卫/`。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import {
  clone, changedKeys, mergeTrees, describeKeys, snapshotOf, conflictSnapshots
} from '../src/concurrency.js';

/**
 * 一份**契约形状的图**（`docs/DATA-FORMAT.md` §1.6）：层带 / 容器 / 边 / 注释 / 方向 / 网格 / pinned
 * 都齐，这样"图变了"改的是契约里真实存在的字段，而不是随便塞一个键。
 */
const graphOf = (label) => ({
  version: 1,
  profile: 'complex',
  direction: 'LR',
  grid: 8,
  layers: [{
    id: 'l-core', label: label, labelSide: 'top', rect: [0, 0, 600, 300], fill: '#eef4fb',
    watermark: { text: 'CORE', rotate: -90, opacity: 0.3 }
  }],
  containers: [{
    id: 'c-box', label: '盒子', rect: [10, 10, 200, 80], layout: 'stack',
    children: ['x'], padding: 12, gap: 8
  }],
  edges: [{
    id: 'e-xy', from: { node: 'x', port: 'e' }, to: { node: 'y', port: 'w' },
    route: 'straight', style: 'dashed', color: 'blue',
    arrow: { start: false, end: true }, label: '状态'
  }],
  annotations: [{ text: '一句注释', at: [12, 40], style: 'note-blue' }],
  pinned: ['x']
});

/** 最小项目：root 下 x / y；带一层图（与 `tests/concurrency.test.js` 的 `proj()` 同型，另加 graph） */
const proj = () => ({
  meta: { name: 't', formatVersion: 2 },
  format: 'node_tree',
  data: {
    id: 'root', topic: 'R', expanded: true,
    children: [
      { id: 'x', topic: 'X', detail: '<p>x</p>', children: [] },
      { id: 'y', topic: 'Y', children: [] }
    ]
  },
  assoc: [{ id: 'a1', title: '关系', members: [{ project: '本项目', id: 'x' }] }],
  graph: graphOf('Core')
});

const setTopic = (id, topic) => (d) => {
  const walk = (n) => {
    if (n.id === id) { n.topic = topic; return true; }
    return (n.children || []).some(walk);
  };
  walk(d.data);
  return d;
};

const addUnder = (id, childId) => (d) => {
  const walk = (n) => {
    if (n.id === id) { n.children = (n.children || []).concat([{ id: childId, topic: childId, children: [] }]); return true; }
    return (n.children || []).some(walk);
  };
  walk(d.data);
  return d;
};

describe('concurrency · graph 必须在合并指纹里（缺口③）', () => {
  it('① 指纹含 graph：图变了 ⇒ changedKeys 里就有 graph 键', () => {
    const base = proj();
    const changed = clone(base);
    changed.graph.layers[0].label = 'Core-2';
    expect([...changedKeys(base, changed)]).toEqual(['graph']);
    // 反向：图没变时不该凭空多出 graph 键（否则"两边都没动图"也会被算成冲突）
    const same = clone(base);
    expect(changedKeys(base, same).has('graph')).toBe(false);
  });

  it('② 该绿：两边 graph 相同 + 节点有改动 ⇒ 合并成功，结果里的图与两边一致', () => {
    const base = proj();
    const mine = addUnder('x', 'x2')(clone(base));      // 界面：往 x 下加节点（不碰图）
    const theirs = setTopic('y', 'Y-AI')(clone(base));  // 对方：改 y（不碰图）
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.data.graph).toEqual(base.graph);           // 与两边逐字段相同
    expect(r.data.graph).toEqual(mine.graph);
    expect(r.data.graph).toEqual(theirs.graph);
  });

  it('③ 该红：两边 graph 不同 ⇒ 默认拒绝（不产生数据）并点名图附加层', () => {
    const base = proj();
    const mine = clone(base);
    mine.graph.layers[0].label = 'Core-界面';           // 我动了层带标签
    const theirs = clone(base);
    theirs.graph.direction = 'TB';                      // 对方动了方向
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(false);                           // 相交 ⇒ 拒绝，一个字都不产生
    expect(r.conflicts).toEqual(['graph']);
    expect(r.data).toBeUndefined();                     // 拒绝档**不产出数据**（写盘无从发生）
    expect(r.detail.join('')).toContain('图附加层');     // 报错点名对象，不是内部 key
  });

  it('④ 该红（另一档）：onConflict:"theirs" 可以取盘上那一版，但**必须报出来**', () => {
    const base = proj();
    const mine = clone(base);
    mine.graph.layers[0].label = 'Core-界面';
    const theirs = clone(base);
    theirs.graph.direction = 'TB';
    const r = mergeTrees(base, mine, theirs, { onConflict: 'theirs' });
    expect(r.ok).toBe(true);
    expect(r.data.graph.direction).toBe('TB');          // 明确选了盘上那一版
    expect(r.conflicts).toEqual(['graph']);             // 但冲突**仍然被列出来**
    expect(r.lostOn.join('')).toContain('图附加层');     // 并且告知丢了哪一项
  });

  it('⑤ 不许假修：只有我改了图 ⇒ 我的图保住（对方改的是节点）', () => {
    const base = proj();
    const mine = clone(base);
    mine.graph.pinned = ['x', 'y'];                     // 我钉了两个节点
    const theirs = setTopic('y', 'Y-AI')(clone(base));  // 对方只改节点
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect(r.data.graph.pinned).toEqual(['x', 'y']);    // 我的改动不被 clone(theirs) 抹掉
    expect(r.data.data.children[1].topic).toBe('Y-AI'); // 对方的改动也在
  });

  it('⑤b 我删掉整层 graph ⇒ 合并结果也没有 graph 键（删除不被"以对方为底"复活）', () => {
    const base = proj();
    const mine = clone(base);
    delete mine.graph;                                  // 界面把整层图删了
    const theirs = setTopic('y', 'Y-AI')(clone(base));
    const r = mergeTrees(base, mine, theirs);
    expect(r.ok).toBe(true);
    expect('graph' in r.data).toBe(false);
  });

  it('⑥ 冲突面板看得见图：snapshotOf / conflictSnapshots 取得到三侧的值', () => {
    const base = proj();
    const mine = clone(base);
    mine.graph.direction = 'TB';
    const theirs = clone(base);
    theirs.graph.grid = 16;
    expect(snapshotOf(base, 'graph')).toEqual(base.graph);
    expect(snapshotOf(mine, 'graph').direction).toBe('TB');
    const snaps = conflictSnapshots(base, mine, theirs, ['graph']);
    expect(snaps.base.graph).toEqual(base.graph);
    expect(snaps.mine.graph.direction).toBe('TB');
    expect(snaps.theirs.graph.grid).toBe(16);
    expect(describeKeys(theirs, ['graph']).join('')).toContain('图附加层');
  });
});
