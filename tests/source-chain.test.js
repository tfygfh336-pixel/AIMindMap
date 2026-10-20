/* ============================================================
 * tests/source-chain.test.js — 「经验来源链（`SC`）」纯逻辑单测（vitest）
 * ------------------------------------------------------------
 * 覆盖 `src/source-chain.js` 的全部判据：
 *   ① 出处边的识别（**只有 `出自：`**，`前置：`/`来源：`/`同义：` 都不算）
 *   ② 近失写法（`出自:` / `出自 ：`）**报出来但不计入**
 *   ③ 多跳（干净链 / 菱形分支 / 跨项目）
 *   ④ 环：自环 / 2-环 / 3-环 / **多条环**（不许撞到第一个就停）
 *   ⑤ 上限（MAX_CHAINS / MAX_HOPS）**响亮失败**，不静默截断
 *   ⑥ 深度界：截断时 `truncated:true`
 *   ⑦ 读数：`otherPrefixes`（不预设词表）/ `nearMiss`
 *   ⑧ 确定性：同一输入两跑结果 deepEqual
 *   ⑨ 与 `learn-path` 的**前缀分工**（各自只认自己那一档）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import {
  SOURCE_PREFIXES, MAX_DEPTH, MAX_HOPS, MAX_CHAINS, CAPTION_MAX, NO_PREFIX_BUCKET,
  isSourceCaption, sourceNearMiss, prefixOf, clipCaption, nodeKey, walk,
  cycleMessage, tooManyMessage
} from '../src/source-chain.js';
import { isPrereqCaption } from '../src/learn-path.js';

/**
 * 用一张"邻接表"造 `edgesOf`：`{ 'p:n': [ {project,id,topic,caption} ] }`。
 * 缺省 topic = id（便于断言），未登记的键返回 `[]`。
 */
function mkEdges(map) {
  return (project, id) => map[project + ':' + id] || [];
}
function e(project, id, caption) {
  return { project: project, id: id, topic: id, caption: caption };
}

describe('source-chain 取值表与判据', () => {
  it('A1 出处前缀只有一种：`出自：`（词表里 `前置：` 另带两个写法，`出自` 没有半角变体）', () => {
    expect(SOURCE_PREFIXES).toEqual(['出自：']);
  });

  it('A2 isSourceCaption：`出自：` 算；紧贴开头是判据（先 trim，与 isPrereqCaption 同口径）', () => {
    expect(isSourceCaption('出自：IEEE 802.11-2020 §10.3')).toBe(true);
    expect(isSourceCaption('  出自：前面有两个空格')).toBe(true);
    expect(isSourceCaption('出自：')).toBe(true);
  });

  it('A3 isSourceCaption：另外四种类型前缀与词表外写法**都不算**', () => {
    ['前置：x', '前置:x', 'prereq: x', '对照：x', '补充：x', '同义：x', '来源：x', '互为补充', '', undefined, null, 42]
      .forEach((c) => expect(isSourceCaption(c)).toBe(false));
  });

  it('A4 近失写法：以「出自」开头但不是「出自：」⇒ 报出来', () => {
    expect(sourceNearMiss('出自:半角冒号')).toBe('出自:半角冒号');
    expect(sourceNearMiss('出自 ：冒号前有空格')).toBe('出自 ：冒号前有空格');
    expect(sourceNearMiss('  出自:缩进也算')).toBe('出自:缩进也算');
    expect(sourceNearMiss('出自')).toBe('出自');
  });

  it('A5 近失写法：合法出处边与无关 caption 都不进近失表', () => {
    expect(sourceNearMiss('出自：合法')).toBe('');
    expect(sourceNearMiss('前置：不是我的事')).toBe('');
    expect(sourceNearMiss('互为补充，见第 3 章')).toBe('');
    expect(sourceNearMiss('')).toBe('');
  });

  it('A6 前缀桶的冒号原样保留（`出自:` 与 `出自：` 不混桶）', () => {
    expect(prefixOf('出自：x')).toBe('出自：');
    expect(prefixOf('出自:x')).toBe('出自:');
    expect(prefixOf('前置：x')).toBe('前置：');
    expect(prefixOf('来源：x')).toBe('来源：');
    expect(prefixOf('prereq: x')).toBe('prereq:');            // 英文写法 6 字也在桶内（PREFIX_MAX_CHARS=8）
    expect(prefixOf('没有冒号的自由文本')).toBe(NO_PREFIX_BUCKET);
    expect(prefixOf('')).toBe(NO_PREFIX_BUCKET);
    // 冒号前一整句 ⇒ 不收（不猜），进无前缀桶
    expect(prefixOf('一二三四五六七八九：x')).toBe(NO_PREFIX_BUCKET);
  });

  it('A7 clipCaption 截断必带省略号（不冒充原文）', () => {
    const long = '出'.repeat(CAPTION_MAX + 10);
    const got = clipCaption(long);
    expect(got.length).toBe(CAPTION_MAX + 1);
    expect(got.endsWith('…')).toBe(true);
    expect(clipCaption('短')).toBe('短');
  });

  it('A8 nodeKey 用不可出现的分隔符（项目名与 id 都不会含 \\u0000）', () => {
    expect(nodeKey('p', 'n')).toBe('p\u0000n');
    expect(nodeKey('p', 'n')).not.toBe(nodeKey('p\u0000n', ''));
  });
});

describe('source-chain 与 learn-path 的前缀分工（各自只认自己那一档）', () => {
  it('B1 `出自：` 不被 isPrereqCaption 认成前置', () => {
    expect(isPrereqCaption('出自：IEEE 802.11-2020')).toBe(false);
  });

  it('B2 `前置：` 不被 isSourceCaption 认成出处（两张表**故意不是同一张**）', () => {
    expect(isSourceCaption('前置：三次握手')).toBe(false);
    expect(isSourceCaption('prereq: read first')).toBe(false);
  });
});

describe('source-chain 多跳', () => {
  it('C1 干净链 A 出自 B 出自 C：一条 3 跳的链、hopCount=2', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B')],
      'p:b': [e('p', 'c', '出自：C')]
    });
    const r = walk({ start: { project: 'p', id: 'a', topic: 'A' }, edgesOf: edges });
    expect(r.ok).toBe(true);
    expect(r.chains.length).toBe(1);
    expect(r.chains[0].map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(r.chains[0][0].caption).toBe(null);
    expect(r.chains[0][1].caption).toBe('出自：B');
    expect(r.chains[0][2].caption).toBe('出自：C');
    expect(r.hopCount).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('C2 跨项目照 `links[].project` 走（链可以横跨项目）', () => {
    const edges = mkEdges({
      'p:a': [e('q', 'x', '出自：另一个项目的资料')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.chains[0].map((h) => h.project + ':' + h.id)).toEqual(['p:a', 'q:x']);
  });

  it('C3 菱形分支 ⇒ 两条链，各自成行', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B'), e('p', 'c', '出自：C')],
      'p:b': [e('p', 'd', '出自：D')],
      'p:c': [e('p', 'd', '出自：D')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(true);
    expect(r.chains.map((c) => c.map((h) => h.id).join('')).sort()).toEqual(['abd', 'acd']);
    expect(r.hopCount).toBe(4);
  });

  it('C4 没有出处边 ⇒ 一条 1 跳的链（起点自己），不是"空结果"', () => {
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: mkEdges({}) });
    expect(r.ok).toBe(true);
    expect(r.chains.length).toBe(1);
    expect(r.chains[0].length).toBe(1);
    expect(r.hopCount).toBe(0);
  });

  it('C5 目标节点解析不到时 topic=null（如实标，不吞）', () => {
    const edges = mkEdges({ 'p:a': [{ project: 'p', id: 'gone', topic: null, caption: '出自：找不到' }] });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.chains[0][1].topic).toBe(null);
  });

  it('C6 深度界：到了 --depth 就截止，并如实置 truncated=true', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B')],
      'p:b': [e('p', 'c', '出自：C')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges, maxDepth: 1 });
    expect(r.ok).toBe(true);
    expect(r.chains[0].map((h) => h.id)).toEqual(['a', 'b']);
    expect(r.truncated).toBe(true);
  });

  it('C7 刚好走到叶子时不置 truncated（深度界不是"一律截断"）', () => {
    const edges = mkEdges({ 'p:a': [e('p', 'b', '出自：B')] });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges, maxDepth: 1 });
    expect(r.truncated).toBe(false);
    expect(r.chains[0].map((h) => h.id)).toEqual(['a', 'b']);
  });
});

describe('source-chain 环检测（响亮拒绝 + 逐条点名）', () => {
  it('D1 自环：A 出自 A ⇒ code=cycle', () => {
    const edges = mkEdges({ 'p:a': [e('p', 'a', '出自：自己')] });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cycle');
    expect(r.cycles.length).toBe(1);
    expect(r.cycles[0].from.id).toBe('a');
    expect(r.cycles[0].to.id).toBe('a');
  });

  it('D2 2-环：A⇄B ⇒ 一条环上边被点名', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B')],
      'p:b': [e('p', 'a', '出自：A')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cycle');
    expect(r.cycles.map((c) => c.from.id + '->' + c.to.id)).toEqual(['b->a']);
    expect(r.cycles[0].path).toEqual(['p:a', 'p:b', 'p:a']);
  });

  it('D3 3-环：A→B→C→A ⇒ 点名那条 c→a，并给出完整路径', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B')],
      'p:b': [e('p', 'c', '出自：C')],
      'p:c': [e('p', 'a', '出自：A')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cycle');
    expect(r.cycles.length).toBe(1);
    expect(r.cycles[0].from.id).toBe('c');
    expect(r.cycles[0].to.id).toBe('a');
    expect(r.cycles[0].path).toEqual(['p:a', 'p:b', 'p:c', 'p:a']);
  });

  it('D4 **多条环**都要报（撞到第一个就停会让调用方修一轮又撞下一个）', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B'), e('p', 'c', '出自：C')],
      'p:b': [e('p', 'a', '出自：A')],
      'p:c': [e('p', 'a', '出自：A')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cycle');
    expect(r.cycles.map((c) => c.from.id + '->' + c.to.id).sort()).toEqual(['b->a', 'c->a']);
  });

  it('D5 环与正常分支并存：不因为有环就把正常那条链吞掉，但结论仍是红', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B'), e('p', 'z', '出自：Z')],
      'p:b': [e('p', 'a', '出自：A')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cycle');
    expect(r.cycles.length).toBe(1);
  });

  it('D6 环**不是**"每节点只入表一次"式的静默去重：两条不同分支上出现同一节点不算环', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B'), e('p', 'c', '出自：C')],
      'p:b': [e('p', 'd', '出自：D')],
      'p:c': [e('p', 'd', '出自：D')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.ok).toBe(true);
    expect(r.chains.length).toBe(2);
  });

  it('D7 cycleMessage 逐条点名、给出路、明说"一条边都没有被丢掉"', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B 的原文')],
      'p:b': [e('p', 'a', '出自：A 的原文')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    const msg = cycleMessage(r.cycles);
    expect(msg).toMatch(/出处链成环/);
    expect(msg).toMatch(/共 1 条/);
    expect(msg).toMatch(/p:b\s+--出自:-->\s+p:a/);
    expect(msg).toMatch(/路径：p:a\s+→\s+p:b\s+→\s+p:a/);
    expect(msg).toMatch(/一条边都没有被丢掉/);
    expect(msg).toMatch(/出路/);
    expect(msg).toMatch(/docs\/TAGS\.md/);
  });
});

describe('source-chain 上限（不许静默截断）', () => {
  it('E1 链条数上限：菱形 8 层 ⇒ 2^8=256 条 > MAX_CHAINS ⇒ code=too-many（reason=chains）', () => {
    const edges = {};
    const N = 8;                                  // 8 层分叉 ⇒ 2^8 条叶路径
    for (let i = 0; i <= N; i++) {
      const ids = (i === 0) ? ['a0'] : ['a' + i, 'b' + i];
      ids.forEach((id) => {
        edges['p:' + id] = (i === N)
          ? []
          : ['a' + (i + 1), 'b' + (i + 1)].map((t) => e('p', t, '出自：' + t));
      });
    }
    const r = walk({ start: { project: 'p', id: 'a0' }, edgesOf: mkEdges(edges) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('too-many');
    expect(r.reason).toBe('chains');
    expect(r.chains).toBeGreaterThan(MAX_CHAINS);
  });

  it('E2 边条数上限：宽图（100 条分支 × 6 跳 = 600 边）⇒ code=too-many（reason=hops）', () => {
    // ⚠️ 不能拿"一条几百跳的长链"来测：`maxDepth` 会被夹到 `MAX_DEPTH`（100），
    //    先在深度界截止 —— 那样测到的是 truncated，不是 MAX_HOPS（本用例第一版就踩了这个坑）。
    const edges = { 'p:start': [] };
    for (let j = 0; j < 100; j++) {
      edges['p:start'].push(e('p', 'c' + j + '-1', '出自：分支 ' + j));
      for (let k = 1; k < 6; k++) {
        edges['p:c' + j + '-' + k] = [e('p', 'c' + j + '-' + (k + 1), '出自：下一跳')];
      }
      edges['p:c' + j + '-6'] = [];
    }
    const r = walk({ start: { project: 'p', id: 'start' }, edgesOf: mkEdges(edges) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('too-many');
    expect(r.reason).toBe('hops');
    expect(r.hops).toBeGreaterThan(MAX_HOPS);
  });

  it('E3 tooManyMessage 说清是哪一档、给缩小范围的办法、明说"不会静默截断"', () => {
    const m1 = tooManyMessage({ reason: 'chains', chains: 201, hops: 10 });
    expect(m1).toMatch(/条数.*超过上限/);
    expect(m1).toMatch(/不会静默截断/);
    expect(m1).toMatch(/缩小范围的办法/);
    const m2 = tooManyMessage({ reason: 'hops', chains: 1, hops: 501 });
    expect(m2).toMatch(/边的\*\*条数\*\*超过上限/);
  });

  it('E4 MAX_DEPTH 是深度的硬上限（传更大会被夹到 MAX_DEPTH）', () => {
    const edges = mkEdges({ 'p:a': [e('p', 'b', '出自：B')] });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges, maxDepth: MAX_DEPTH * 10 });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(false);
  });
});

describe('source-chain 读数面（otherPrefixes / nearMiss）', () => {
  it('F1 没跟的边按前缀进桶（不预设词表）；`来源：` 与 `出自:` 各成桶', () => {
    const edges = mkEdges({
      'p:a': [
        e('p', 'b', '出自：B'),
        e('p', 'c', '前置：C'),
        e('p', 'd', '来源：D'),
        e('p', 'f', '出自:D 的半角写法'),
        e('p', 'g', '互为补充的自由文本')
      ]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.otherPrefixes).toEqual({ '前置：': 1, '来源：': 1, '出自:': 1, [NO_PREFIX_BUCKET]: 1 });
    expect(r.chains[0][1].id).toBe('b');       // 只有出处边进链
    expect(r.hopCount).toBe(1);
  });

  it('F2 nearMiss 只收"像出处但不是"的那一条，并给出 why', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'b', '出自：B'), e('p', 'c', '出自:C 半角'), e('p', 'd', '前置：D')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.nearMiss.length).toBe(1);
    expect(r.nearMiss[0].node).toBe('p:a');
    expect(r.nearMiss[0].caption).toBe('出自:C 半角');
    expect(r.nearMiss[0].why).toMatch(/静默失效/);
  });

  it('F3 nearMiss 按（节点, caption）码点序排（键序固定 ⇒ `--json` 可复现）', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'x', '出自:z 这一条'), e('p', 'y', '出自:a 那一条')]
    });
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(r.nearMiss.map((x) => x.caption)).toEqual(['出自:a 那一条', '出自:z 这一条']);
  });
});

describe('source-chain 确定性与健壮性', () => {
  it('G1 同一输入两跑结果完全相同（无随机、无时钟、排序稳定）', () => {
    const edges = mkEdges({
      'p:a': [e('p', 'c', '出自：C'), e('p', 'b', '出自：B')],
      'p:b': [e('p', 'd', '出自：D')],
      'p:c': [e('p', 'd', '出自：D')]
    });
    const mk = () => walk({ start: { project: 'p', id: 'a' }, edgesOf: edges });
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });

  it('G2 脏输入不炸：edgesOf 返回非数组 / 元素缺字段 / caption 不是字符串', () => {
    const cases = [
      () => undefined,
      () => null,
      () => 'not-an-array',
      () => [null, 1, {}, { project: 'p' }, { id: 'x' }, { project: 'p', id: 'b', caption: 42 }]
    ];
    cases.forEach((fn) => {
      const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: fn });
      expect(r.ok).toBe(true);
      expect(Array.isArray(r.chains)).toBe(true);
    });
  });

  it('G3 start / edgesOf 缺失 ⇒ 显式抛错（不静默返回空结果）', () => {
    expect(() => walk({ edgesOf: () => [] })).toThrow(/start/);
    expect(() => walk({ start: { project: 'p', id: 'a' } })).toThrow(/edgesOf/);
  });

  it('G4 起点 topic 缺省为 null（命令层没解析到时如实标）', () => {
    const r = walk({ start: { project: 'p', id: 'a' }, edgesOf: mkEdges({}) });
    expect(r.chains[0][0].topic).toBe(null);
  });
});
