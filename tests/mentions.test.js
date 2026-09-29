/* ============================================================
 * tests/mentions.test.js — 「未链接提及」纯逻辑单元测试（vitest）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { findMentions, findCrossMentions, flattenWithParents, usableTopic } from '../src/mentions.js';

/** 构造：root → a → a1，另加 b。a 的正文提到"数字签名"与"交换机" */
function mkTree() {
  return {
    id: 'root', topic: '根', detail: '',
    children: [
      {
        id: 'a', topic: '网络安全', detail: '<p>本节讲数字签名与交换机的配置。</p>',
        children: [{ id: 'a1', topic: '补充', detail: '' }]
      },
      { id: 'b', topic: '数字签名', detail: '<p>签名算法</p>' },
      { id: 'c', topic: '交换机', detail: '<p>二层转发</p>' }
    ]
  };
}

describe('mentions.findMentions', () => {
  it('找出正文提到但未链接的节点', () => {
    const r = findMentions(mkTree(), { selfProject: 'p' });
    const pairs = r.items.map((x) => x.from + '->' + x.to).sort();
    expect(pairs).toEqual(['a->b', 'a->c']);
    expect(r.items[0].snippet).toContain('数字签名');
    expect(r.sources).toBe(1);
  });

  it('每项都带 direction: same（与跨项目的 out/in 形状统一）', () => {
    const r = findMentions(mkTree(), { selfProject: 'p' });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((x) => x.direction === 'same')).toBe(true);
  });

  it('已声明 links 的目标不再报为漏链', () => {
    const t = mkTree();
    t.children[0].links = [{ project: 'p', id: 'b' }];   // a 已链接 b
    const r = findMentions(t, { selfProject: 'p' });
    expect(r.items.map((x) => x.to)).toEqual(['c']);
  });

  it('不传 selfProject 时退化为按 id 比对（保守，不误报）', () => {
    const t = mkTree();
    t.children[0].links = [{ project: 'other', id: 'b' }];
    const r = findMentions(t, {});                       // 无 selfProject
    expect(r.items.map((x) => x.to)).not.toContain('b');
  });

  it('默认排除"结构上已相邻"（祖先/后代），避免冗余噪音', () => {
    const t = {
      id: 'root', topic: '微服务架构', detail: '<p>微服务架构概览</p>',   // 提到自身主题
      children: [{ id: 'k', topic: '服务发现', detail: '<p>也属于微服务架构</p>' }]
    };
    // k 的正文提到父节点主题 → 父子关系已由树表达，默认不报
    const def = findMentions(t, { selfProject: 'p' });
    expect(def.items.map((x) => x.from + '->' + x.to)).not.toContain('k->root');
    expect(def.structuralSkipped).toBeGreaterThan(0);
    // 显式要求时才报
    const withS = findMentions(t, { selfProject: 'p', includeStructural: true, minTopicLength: 3 });
    expect(withS.items.map((x) => x.from + '->' + x.to)).toContain('k->root');
  });

  it('默认排除章节号式主题作为目标（目录式正文会产生同质洪流）', () => {
    // 注意：目标必须是"提及者的兄弟"而非子孙 —— 子孙会被"结构相邻"过滤掉，
    // 那样就无法单独验证"章节号排除"这一项（测试设计陷阱）。
    const t = {
      id: 'root', topic: '根目录', detail: '',
      children: [
        { id: 'a', topic: '甲章', detail: '<p>详见 3.1 概述 一节</p>' },
        { id: 'n1', topic: '3.1 概述', detail: '' },
        { id: 'n2', topic: '概述方法', detail: '' }
      ]
    };
    const r = findMentions(t, { selfProject: 'p' });
    expect(r.items.map((x) => x.to)).not.toContain('n1');   // 章节号主题被排除
    // 不排除时会计入
    const r2 = findMentions(t, { selfProject: 'p', excludeChapterNumbered: false });
    expect(r2.items.map((x) => x.to)).toContain('n1');
  });

  it('尊重 minTopicLength（短主题误报率高）', () => {
    const t = {
      id: 'root', topic: '根目录', detail: '',
      children: [
        { id: 'a', topic: '甲章', detail: '<p>这里出现了 交换机 三个字，也出现了 AB</p>' },
        { id: 'x', topic: '交换机', detail: '' },
        { id: 'y', topic: 'AB', detail: '' }
      ]
    };
    const r = findMentions(t, { selfProject: 'p', minTopicLength: 3 });
    expect(r.items.map((x) => x.to)).toEqual(['x']);        // AB 因过短被排除
  });

  it('同源同目标重复提及只报一次', () => {
    const t = {
      id: 'root', topic: '根目录', detail: '',
      children: [
        { id: 'a', topic: '甲章', detail: '<p>交换机 交换机 交换机</p>' },
        { id: 'c', topic: '交换机', detail: '' }
      ]
    };
    const r = findMentions(t, { selfProject: 'p' });
    expect(r.items.filter((x) => x.from === 'a' && x.to === 'c')).toHaveLength(1);
  });

  it('limit 截断并置 truncated 标志', () => {
    const t = {
      id: 'root', topic: '根', detail: '',
      children: [
        { id: 'a', topic: '甲', detail: '<p>交换机 与 路由器</p>' },
        { id: 'c', topic: '交换机', detail: '' },
        { id: 'd', topic: '路由器', detail: '' }
      ]
    };
    const r = findMentions(t, { selfProject: 'p', limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('无 detail 的节点不产生命中；节点不与自己比较', () => {
    const t = { id: 'root', topic: '自身主题名称', detail: '', children: [] };
    const r = findMentions(t, { selfProject: 'p' });
    expect(r.items).toEqual([]);
  });

  it('空/异常输入安全', () => {
    expect(findMentions(null, {}).items).toEqual([]);
    expect(findMentions({ id: 'r', topic: 'x' }, {}).items).toEqual([]);
    expect(findMentions({ id: 'r', topic: 'x', detail: null }, {}).items).toEqual([]);
  });
});

describe('mentions 辅助函数', () => {
  it('flattenWithParents 记录父指针（结构相邻判定依赖它）', () => {
    const { nodes, parentOf } = flattenWithParents(mkTree());
    expect(nodes.map((n) => n.id)).toEqual(['root', 'a', 'a1', 'b', 'c']);
    expect(parentOf.a).toBe('root');
    expect(parentOf.a1).toBe('a');
    expect(parentOf.root).toBeUndefined();
  });

  it('usableTopic 的边界', () => {
    expect(usableTopic('交换机', 3, true)).toBe(true);
    expect(usableTopic('AB', 3, true)).toBe(false);
    expect(usableTopic('  ', 1, true)).toBe(false);
    expect(usableTopic('3.1 概述', 2, true)).toBe(false);
    expect(usableTopic('2. 应用层', 2, true)).toBe(false);      // N. 标题 也算章号
    expect(usableTopic('3.1 概述', 2, false)).toBe(true);
    expect(usableTopic(null, 1, true)).toBe(false);
  });

  it('章节号判据不误伤"数字开头但非章节号"的真实主题', () => {
    // 回归：原正则 `/^\d+(\.\d+)*[\s.、]/` 把下面这些真实主题也剔出了候选池
    // （实测 comnet 的「802.11 体系结构与 AP」「802.11 帧结构」被永久排除）。
    // 判据收紧为「1–2 位数字 + 点」，依据是真实数据里章号一律是 N. 或 N.M。
    expect(usableTopic('802.11 体系结构与 AP', 3, true)).toBe(true);
    expect(usableTopic('802.11 帧结构', 3, true)).toBe(true);
    expect(usableTopic('2024 年度总结', 3, true)).toBe(true);
    expect(usableTopic('2 层交换', 3, true)).toBe(true);
    expect(usableTopic('4G/5G 中的移动管理', 3, true)).toBe(true);
    expect(usableTopic('5G 的关键技术', 3, true)).toBe(true);
    // 而真正的章号仍被排除
    expect(usableTopic('7.1 概述', 3, true)).toBe(false);
    expect(usableTopic('1. 计算机网络和因特网', 3, true)).toBe(false);
  });
});

/* —— 跨项目「未链接提及」（docs/ROADMAP.md 的 mentions 跨项目扫描）—— */
describe('mentions.findCrossMentions', () => {
  // 注意夹具设计：**提及者的主题必须与被提及的主题不同**。
  // 第一版把 other/o2 也命名为「被提及者」，于是"它提到了自己的主题名"被自指守卫
  // 正确拦下，测试却显示 in 方向为 0 —— 是夹具自相矛盾，不是实现错。
  const projs = () => [
    { name: 'self', data: { data: { id: 'root', topic: '根', children: [
      { id: 's1', topic: '自节点', detail: '<p>参见 远节点 的说明</p>' },
      { id: 's2', topic: '被提及者', detail: '<p>自项目里的被提及者</p>' }
    ] } } },
    { name: 'other', data: { data: { id: 'root', topic: '根二', children: [
      { id: 'o1', topic: '远节点', detail: '<p>远节点的细节</p>' },
      { id: 'o2', topic: '外部笔记', detail: '<p>外部也提到了 被提及者 这个词</p>' }
    ] } } }
  ];

  it('out：本项目正文提到其他项目的节点', () => {
    const r = findCrossMentions(projs(), 'self', {});
    const out = r.items.filter((x) => x.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      fromProject: 'self', from: 's1', toProject: 'other', to: 'o1', toTopic: '远节点'
    });
    expect(out[0].snippet).toContain('远节点');
  });

  it('in：其他项目正文提到本项目的节点', () => {
    const r = findCrossMentions(projs(), 'self', {});
    const inn = r.items.filter((x) => x.direction === 'in');
    expect(inn).toHaveLength(1);
    expect(inn[0]).toMatchObject({
      fromProject: 'other', from: 'o2', toProject: 'self', to: 's2', toTopic: '被提及者'
    });
  });

  it('outCount / inCount 与 items 一致', () => {
    const r = findCrossMentions(projs(), 'self', {});
    expect(r.outCount).toBe(r.items.filter((x) => x.direction === 'out').length);
    expect(r.inCount).toBe(r.items.filter((x) => x.direction === 'in').length);
  });

  it('已声明的跨项目链接不再报为漏链', () => {
    const p = projs();
    p[0].data.data.children[0].links = [{ project: 'other', id: 'o1' }];   // s1 已链到 other/o1
    const r = findCrossMentions(p, 'self', {});
    expect(r.items.filter((x) => x.direction === 'out')).toEqual([]);
  });

  it('本项目内已有的同 id 链接不会掩盖跨项目漏链（必须拼 project 比对）', () => {
    const p = projs();
    // s1 链到的是**本项目**的 o1（不存在也无妨），不是 other/o1 —— 故仍应报 out
    p[0].data.data.children[0].links = [{ project: 'self', id: 'o1' }];
    const r = findCrossMentions(p, 'self', {});
    expect(r.items.filter((x) => x.direction === 'out').map((x) => x.to)).toEqual(['o1']);
  });

  it('同名跨项目：**照报并标 ambiguous**（不猜，交人判断），不做一刀切排除', () => {
    // 构造同名节点：self/s1 与 other/o1 都叫「同名主题」。
    // 正文出现这个名字有两种解释：(a) 自指、(b) 确实在指对方。仅凭名字无法区分。
    //
    // 曾用 `tn.topic === src.topic` 一刀切排除 —— 结果把"两个项目各有一个同名概念节点、
    // 正文互相引用"这种**最该发现的**跨项目关系双向误杀（实测 items 为空）。
    // 正确行为是本模块对外承诺的：照报所有候选，并给每条打上 ambiguous:true。
    const p = [
      { name: 'self', data: { data: { id: 'root', topic: '根', children: [
        { id: 's1', topic: '同名主题', detail: '<p>这段讲的是 同名主题</p>' }
      ] } } },
      { name: 'other', data: { data: { id: 'root', topic: '根二', children: [
        { id: 'o1', topic: '同名主题', detail: '<p>别处也有个 同名主题</p>' }
      ] } } }
    ];
    const r = findCrossMentions(p, 'self', {});
    const outItems = r.items.filter((x) => x.direction === 'out');
    expect(outItems.length).toBeGreaterThan(0);
    expect(outItems.every((x) => x.ambiguous === true)).toBe(true);
    expect(r.ambiguousTopics).toContain('同名主题');
    // 且 in 方向同样能报出（双向都不被误杀）
    expect(r.items.filter((x) => x.direction === 'in').length).toBeGreaterThan(0);
  });

  it('同名跨项目互指：out 与 in 双向都能报出（回归：曾双向全空）', () => {
    const p = [
      { name: 'A', data: { data: { id: 'ra', topic: '根A', children: [
        { id: 'a1', topic: 'TCP 三次握手', detail: '<p>见 B 项目的 TCP 三次握手</p>' }
      ] } } },
      { name: 'B', data: { data: { id: 'rb', topic: '根B', children: [
        { id: 'b1', topic: 'TCP 三次握手', detail: '<p>见 A 项目的 TCP 三次握手</p>' }
      ] } } }
    ];
    const r = findCrossMentions(p, 'A', {});
    expect(r.outCount).toBe(1);
    expect(r.inCount).toBe(1);
  });

  it('来源项目内另有同名节点时也必须标 ambiguous（否则提示会误导）', () => {
    // other/o1 正文写「参见 被提及者」，而 **other 自己**也有一个叫「被提及者」的 o2。
    // 只按"目标池"计数会漏标 → 面板会以"无歧义"的口吻建议从外部补链接，属误导。
    const p = [
      { name: 'self', data: { data: { id: 'r', topic: '根', children: [
        { id: 's1', topic: '被提及者', detail: '' }
      ] } } },
      { name: 'other', data: { data: { id: 'r2', topic: '根2', children: [
        { id: 'o1', topic: '引用者', detail: '<p>参见 被提及者</p>' },
        { id: 'o2', topic: '被提及者', detail: '' }
      ] } } }
    ];
    const r = findCrossMentions(p, 'self', {});
    const inn = r.items.filter((x) => x.direction === 'in');
    expect(inn.length).toBe(1);
    expect(inn[0].ambiguous).toBe(true);
    expect(r.ambiguousTopics).toContain('被提及者');
  });

  it('同名歧义：目标池里多个同主题节点 → 照报但标记 ambiguous 并汇总', () => {
    const p = [
      { name: 'self', data: { data: { id: 'root', topic: '根', children: [
        { id: 's1', topic: '自节点', detail: '<p>提到 重现主题 一次</p>' }
      ] } } },
      { name: 'other', data: { data: { id: 'root', topic: '根二', children: [
        { id: 'a1', topic: '重现主题', detail: '' },
        { id: 'a2', topic: '重现主题', detail: '' }
      ] } } }
    ];
    const r = findCrossMentions(p, 'self', {});
    const out = r.items.filter((x) => x.direction === 'out');
    expect(out).toHaveLength(2);                                  // 不猜：两个候选都报
    expect(out.every((x) => x.ambiguous === true)).toBe(true);
    expect(r.ambiguousTopics).toContain('重现主题');
  });

  it('主题唯一时 ambiguous 为 false，汇总为空', () => {
    const r = findCrossMentions(projs(), 'self', {});
    expect(r.items.every((x) => x.ambiguous === false)).toBe(true);
    expect(r.ambiguousTopics).toEqual([]);
  });

  it('sources 统计去重后的来源节点数', () => {
    const r = findCrossMentions(projs(), 'self', {});
    expect(r.sources).toBe(2);   // self/s1 与 other/o2
  });

  it('limit 截断并置 truncated', () => {
    const r = findCrossMentions(projs(), 'self', { limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('指定的项目不存在时返回空结构（不抛异常）', () => {
    const r = findCrossMentions(projs(), 'no-such-project', {});
    expect(r.items).toEqual([]);
    expect(r.outCount).toBe(0);
    expect(r.inCount).toBe(0);
  });

  it('空项目列表安全', () => {
    expect(findCrossMentions([], 'self', {}).items).toEqual([]);
    expect(findCrossMentions(null, 'self', {}).items).toEqual([]);
  });

  it('尊重 minTopicLength（短主题不作为跨项目目标）', () => {
    const p = [
      { name: 'self', data: { data: { id: 'root', topic: '根', children: [
        { id: 's1', topic: '自节点', detail: '<p>短词 XY 出现在这里</p>' }
      ] } } },
      { name: 'other', data: { data: { id: 'root', topic: '根二', children: [
        { id: 'o1', topic: 'XY', detail: '' }
      ] } } }
    ];
    expect(findCrossMentions(p, 'self', { minTopicLength: 3 }).items).toEqual([]);
    expect(findCrossMentions(p, 'self', { minTopicLength: 2 }).items).toHaveLength(1);
  });
});
