/* ============================================================
 * tests/contents-concepts.test.js — 【W16 / 功能代号 `CC`「概念目录」】纯逻辑单测
 * ------------------------------------------------------------
 * 守的是什么（都在 `src/mentions.js` 里，本文件只喂数据、只断言，不起进程、不碰盘）：
 *   ① **"什么算一个概念"的四条判据**（概念名 / 承载体 / 聚合 / count 口径）——
 *      这是本功能唯一的"自由裁量"所在，所以每条都得有一份可执行的期望值；
 *   ② **「概念索引」生成物**的形状：确定性 id、回指落点的 links、caption 不带类型前缀；
 *   ③ **自指守卫**（实测过的缺陷回归）：生成物不能被算成概念，否则
 *      "跑没跑过 `--apply`"会改变**只读**命令的读数，且第二次 `--apply` 永远不幂等；
 *   ④ **幂等判定** `sameIndexBranch`：只比生成物那四样，用户在分支上手加的字段不算变化。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../src/mentions.js');

/** 叶子节点（`children: []` 是契约必填项） */
const leaf = (id, topic, extra) => Object.assign({ id, topic, children: [] }, extra || {});
/** 容器节点 */
const box = (id, topic, children, extra) => Object.assign({ id, topic, children: children || [] }, extra || {});

describe('W16-A 概念名判据（conceptNameOf）：章节号前缀怎么剥、哪些绝不剥', () => {
  it('A1 章节号前缀被剥掉：`第N章` / `N.` / `N.M` / `N.M.K` 四种写法', () => {
    expect(M.conceptNameOf('第1章 收包与发包')).toBe('收包与发包');
    expect(M.conceptNameOf('第 3 章 内核')).toBe('内核');
    expect(M.conceptNameOf('13. IPv4 数据报格式')).toBe('IPv4 数据报格式');
    expect(M.conceptNameOf('1.1 收包')).toBe('收包');
    expect(M.conceptNameOf('6.4.4 虚拟局域网 VLAN')).toBe('虚拟局域网 VLAN');
  });

  it('A2 反例：`802.11` / `2024 年度总结` / `2 层交换` **不许**被当成章节号吃掉'
    + '（三条都是 `mentions` 收紧 `usableTopic` 时的实测误伤样例）', () => {
    expect(M.conceptNameOf('802.11 体系结构与 AP')).toBe('802.11 体系结构与 AP');
    expect(M.conceptNameOf('2024 年度总结')).toBe('2024 年度总结');
    expect(M.conceptNameOf('2 层交换')).toBe('2 层交换');
  });

  it('A3 区间式章节号（`7.5–7.7 …`）剥两遍也剥得干净；纯章号标题（`第3章`）保留原名'
    + '（去完为空 ⇒ 不能说"这个概念叫空字符串"）', () => {
    expect(M.conceptNameOf('7.5–7.7 移动管理：原理、移动 IP 与蜂窝实践')).toBe('移动管理：原理、移动 IP 与蜂窝实践');
    expect(M.conceptNameOf('第3章')).toBe('第3章');
  });

  it('A4 标题里的 HTML 实体与多余空白按 `convert.stripHtml` 同一口径清洗（与 mentions 的比较面一致）', () => {
    expect(M.conceptNameOf('1.1  &lt;sk_buff&gt;  与   NAPI')).toBe('<sk_buff> 与 NAPI');
  });
});

describe('W16-B 承载体判据（isConceptCarrier）：只有"空分组容器"不算概念', () => {
  it('B1 四种任一即可算：有正文 / 有标签 / 有链接 / 是叶子', () => {
    expect(M.isConceptCarrier(leaf('a', '甲', { detail: '<p>正文</p>' }))).toBe(true);
    expect(M.isConceptCarrier(box('b', '乙', [leaf('c', '丙')], { tags: ['路由选择'] }))).toBe(true);
    expect(M.isConceptCarrier(box('d', '丁', [leaf('e', '戊')], { links: [{ project: 'p', id: 'x' }] }))).toBe(true);
    expect(M.isConceptCarrier(leaf('f', '己'))).toBe(true);
  });

  it('B2 唯一的排除情形：无正文 + 无标签 + 无链接 + 有子节点（纯结构分组）', () => {
    expect(M.isConceptCarrier(box('g', '概念容器', [leaf('h', '子')]))).toBe(false);
    // 空白正文（只有标签壳与空格）等同"无正文"——不能因为 detail 是个非空字符串就算有内容
    expect(M.isConceptCarrier(box('i', '壳', [leaf('j', '子')], { detail: '<p> </p>&nbsp;' }))).toBe(false);
  });
});

describe('W16-C 概念清单（conceptCatalog）：聚合、顺序、count、作用域、自指守卫', () => {
  /**
   * 夹具（每个节点都承载了某一条判据）：
   *   root
   *     ├ 第1章 收包与发包（有正文）
   *     │   ├ 收包路径（有正文；正文提到 NAPI 轮询 ⇒ mentions）
   *     │   └ NAPI 轮询（有正文）
   *     └ 第2章 深入（有正文）
   *         ├ 2.1 收包路径（与上面同名 ⇒ 合并）
   *         ├ 概念容器（**纯容器**：无正文/无标签/无链接 + 有子节点 ⇒ 不算概念）
   *         │   └ 子概念甲（叶子 ⇒ 算）
   *         └ 提到收包的一节（正文提到 收包路径 与 NAPI 轮询）
   */
  const tree = null;   // 见下方 `fixture()`（保留一行说明：夹具是**每次调用现造一份**，避免用例之间互相污染）
  function fixture() {
    return {
      id: 'root',
      topic: '探针书',
      children: [
        box('ch1', '第1章 收包与发包', [
          leaf('s11', '收包路径', { detail: '<ul><li>收包路径 与 NAPI</li></ul>' }),
          leaf('s12', 'NAPI 轮询', { detail: '<ul><li>NAPI 轮询</li></ul>' })
        ], { detail: '<p>本章讲收包</p>' }),
        box('ch2', '第2章 深入', [
          leaf('s21', '2.1 收包路径', { detail: '<ul><li>再次讲收包路径</li></ul>' }),
          box('s22', '概念容器', [leaf('s221', '子概念甲', { detail: '<p>甲</p>' })]),
          leaf('s23', '提到收包的一节', { detail: '<ul><li>见 收包路径 与 NAPI 轮询</li></ul>' })
        ], { detail: '<p>重复概念与正文提及的例子</p>' })
      ]
    };
  }

  it('C1 聚合：`收包路径` 与 `2.1 收包路径` 合成一个概念，ids 按出现顺序，path/pathNames 指第一次出现',
    () => {
      const c = M.conceptCatalog(fixture(), { selfProject: 'p' });
      const dupe = c.items.filter((x) => x.name === '收包路径');
      expect(dupe).toHaveLength(1);
      expect(dupe[0].ids).toEqual(['s11', 's21']);
      expect(dupe[0].firstId).toBe('s11');
      expect(dupe[0].path).toEqual(['root', 'ch1', 's11']);
      expect(dupe[0].pathNames).toEqual(['探针书', '第1章 收包与发包', '收包路径']);
      expect(c.duplicates).toBe(1);
    });

  it('C2 count = 落点数 + 正文提及数（后半取 findMentions，同一份命中计算）', () => {
    const c = M.conceptCatalog(fixture(), { selfProject: 'p' });
    const by = new Map(c.items.map((x) => [x.name, x]));
    // 收包路径：2 个落点 + 2 处提及（s21 正文一处、s23 正文一处）
    expect(by.get('收包路径').nodes).toBe(2);
    expect(by.get('收包路径').mentions).toBe(2);
    expect(by.get('收包路径').count).toBe(4);
    // NAPI 轮询：1 个落点 + 1 处提及（s23 正文；s11 正文提到但 s11 与它同父 = 结构相邻 ⇒ 按
    // mentions 的既有口径**跳过** —— 这一条同时证明"结构相邻不算提及"的口径被继承下来了）
    expect(by.get('NAPI 轮询').nodes).toBe(1);
    expect(by.get('NAPI 轮询').mentions).toBe(1);
    expect(by.get('NAPI 轮询').count).toBe(2);
    expect(c.mentions).toBe(by.get('收包路径').mentions + by.get('NAPI 轮询').mentions);
  });

  it('C3 顺序 = 概念第一次出现的位置（不是按 count 排序：这是"目录"，不是排行榜）', () => {
    const c = M.conceptCatalog(fixture(), { selfProject: 'p' });
    expect(c.items.map((x) => x.name)).toEqual([
      '收包与发包', '收包路径', 'NAPI 轮询', '深入', '子概念甲', '提到收包的一节'
    ]);
  });

  it('C4 纯分组容器不算概念，但它的子节点算；作用域根自身也不算（它是容器/锚点）', () => {
    const c = M.conceptCatalog(fixture(), { selfProject: 'p' });
    const names = c.items.map((x) => x.name);
    expect(names).not.toContain('概念容器');
    expect(names).toContain('子概念甲');
    expect(names).not.toContain('探针书');       // root 的 topic 不入列
    expect(c.scanned).toBe(8);                    // root 之外的 8 个节点（`scanned` = 扫到的节点数）
    expect(c.carriers).toBe(7);                   // 只有 `概念容器` 不承载
  });

  it('C5 `--min-count` 等价物：只留 count ≥ N 的概念（且 `concepts` 仍是全量读数）', () => {
    const c = M.conceptCatalog(fixture(), { selfProject: 'p', minCount: 2 });
    expect(c.concepts).toBe(6);
    expect(c.shown).toBe(2);
    expect(c.items.map((x) => x.name)).toEqual(['收包路径', 'NAPI 轮询']);
    expect(c.items.every((x) => x.count >= 2)).toBe(true);
  });

  it('C6 作用域与层数：`depth: 1` 只算顶层子节点；`scopeRoot` 换成某子节点即"只扫它的子树"', () => {
    const shallow = M.conceptCatalog(fixture(), { selfProject: 'p', depth: 1 });
    expect(shallow.items.map((x) => x.name)).toEqual(['收包与发包', '深入']);
    expect(shallow.mentions).toBe(0);            // 深层的正文不在扫描面内（落点池与提及面同一个剪枝）
    const sub = M.conceptCatalog(M.conceptHits(fixture(), 0)[0].node, { selfProject: 'p' });
    expect(sub.items.map((x) => x.name)).toEqual(['收包路径', 'NAPI 轮询']);
  });

  it('C7 自指守卫（实测缺陷回归）：树里已经有「概念索引」生成物时，读数与没有它时**逐字段相同**'
    + '（不摘掉的话，索引会把自己算成一个概念、每个概念还会多出"生成物"这个落点）', () => {
    const clean = fixture();
    const before = M.conceptCatalog(clean, { selfProject: 'p' });
    const polluted = fixture();
    polluted.children.push(M.indexBranch(before.items, { project: 'p' }));
    const after = M.conceptCatalog(polluted, { selfProject: 'p' });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.items.map((x) => x.name)).not.toContain('概念索引');
    // ② 生成物**不在首位**（挂在子节点下）时同样要被摘掉
    const deep = fixture();
    deep.children[1].children.push(M.indexBranch(before.items, { project: 'p' }));
    expect(JSON.stringify(M.conceptCatalog(deep, { selfProject: 'p' }))).toBe(JSON.stringify(before));
  });

  it('C8 只有"主题同名但内容不像生成物"的用户节点**不**被摘掉（宁可多算一个概念，也不吃用户的节点）', () => {
    const t = fixture();
    t.children.push(leaf('mine', '概念索引', { detail: '<p>我自己写的索引说明</p>' }));
    const c = M.conceptCatalog(t, { selfProject: 'p' });
    expect(c.items.map((x) => x.name)).toContain('概念索引');
  });
});

describe('W16-D 「概念索引」生成物（indexBranch）：确定性、回指、caption 不带类型前缀', () => {
  const items = () => M.conceptCatalog((function () {
    return {
      id: 'root', topic: 'T',
      children: [leaf('a', '甲', { detail: '<p>甲</p>' }), leaf('b', '乙', { detail: '<p>乙</p>' })]
    };
  })(), { selfProject: 'p' }).items;

  it('D1 确定性：同一份清单生成**逐字节相同**的 JSON（id 里没有时间/随机 —— 幂等的前提）', () => {
    const b1 = M.indexBranch(items(), { project: 'p' });
    const b2 = M.indexBranch(items(), { project: 'p' });
    expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
    expect(b1.id).toBe(M.CONCEPT_INDEX_ID);
    expect(b1.topic).toBe(M.CONCEPT_INDEX_TOPIC);
    expect(b1.children).toHaveLength(2);
    b1.children.forEach((c) => expect(c.id).toMatch(/^contents-[0-9a-f]{8}$/));
  });

  it('D2 每个概念一个子节点，links 回指它的落点（同项目），顺序 = 概念顺序', () => {
    const c = M.conceptCatalog({
      id: 'root', topic: 'T',
      children: [leaf('a', '甲', { detail: '<p>甲</p>' }), leaf('b', '2.1 甲', { detail: '<p>甲又来了</p>' })]
    }, { selfProject: 'p' });
    expect(c.items).toHaveLength(1);                        // 同名合并成一个概念
    const b = M.indexBranch(c.items, { project: 'p' });
    expect(b.children).toHaveLength(1);
    expect(b.children[0].links).toEqual([
      { project: 'p', id: 'a', caption: '概念索引条目，落点 #1「甲」' },
      { project: 'p', id: 'b', caption: '概念索引条目，落点 #2「2.1 甲」' }
    ]);
  });

  it('D3 caption **不带任何类型前缀**（docs/TAGS.md §11 的类型只有 5 种；'
    + '索引条目不是其中任何一种 ⇒ 走该节规则 2 的自由文本，且不许以「前置」二字开头）', () => {
    const b = M.indexBranch(items(), { project: 'p' });
    const banned = ['前置：', '前置:', 'prereq:', '对照：', '补充：', '出自：', '同义：'];
    b.children.forEach((c) => c.links.forEach((l) => {
      banned.forEach((pre) => expect(l.caption.indexOf(pre)).toBe(-1));
      expect(l.caption.startsWith('前置')).toBe(false);
    }));
  });

  it('D4 学习链路不受影响：生成物里的 caption 一条都不会被 `isPrereqCaption` 认成前置', () => {
    const lp = require('../src/learn-path.js');
    const b = M.indexBranch(items(), { project: 'p' });
    b.children.forEach((c) => c.links.forEach((l) => expect(lp.isPrereqCaption(l.caption)).toBe(false)));
  });

  it('D5 作用域后缀：根作用域 id 最简（`contents-index` / `contents-<hash>`），'
    + '非根作用域带后缀 ⇒ 两支索引**不会撞 id**（实测缺陷：`--parent` 生成第二支时 `重复 id` 直接红）',
    () => {
      const rootScope = M.indexBranch(items(), { project: 'p', scopeId: 'root' });
      const subScope = M.indexBranch(items(), { project: 'p', scopeId: 'ch-9' });
      expect(rootScope.id).toBe(M.CONCEPT_INDEX_ID);
      expect(rootScope.children[0].id).toMatch(/^contents-[0-9a-f]{8}$/);
      expect(subScope.id).toMatch(/^contents-index-[0-9a-f]{8}$/);
      expect(subScope.id).not.toBe(rootScope.id);
      const rootIds = new Set(rootScope.children.map((c) => c.id).concat([rootScope.id]));
      subScope.children.concat([subScope]).forEach((n) => expect(rootIds.has(n.id)).toBe(false));
      // 同一个作用域两次生成仍然逐字节相同（幂等的前提）
      expect(JSON.stringify(M.indexBranch(items(), { project: 'p', scopeId: 'ch-9' }))).toBe(JSON.stringify(subScope));
      // 两个作用域的生成物都必须被"生成物识别"认出来（否则它们会跑进概念池，见 C7）
      expect(M.isConceptIndexNode(rootScope)).toBe(true);
      expect(M.isConceptIndexNode(subScope)).toBe(true);
    });
});

describe('W16-E 幂等判定（sameIndexBranch）：只比生成物那四样', () => {
  it('E1 同一份输入两次生成的支 === 相同', () => {
    const c = M.conceptCatalog({ id: 'root', topic: 'T', children: [leaf('a', '甲', { detail: '<p>甲</p>' })] }, { selfProject: 'p' });
    const b1 = M.indexBranch(c.items, { project: 'p' });
    const b2 = M.indexBranch(c.items, { project: 'p' });
    expect(M.sameIndexBranch(b1, b2)).toBe(true);
  });

  it('E2 用户在那一支上手加的字段（`expanded` / `localPath`）**不算变化**'
    + '（第二次 --apply 必须认出"已经是最新的"⇒ 一个字节都不写）', () => {
    const c = M.conceptCatalog({ id: 'root', topic: 'T', children: [leaf('a', '甲', { detail: '<p>甲</p>' })] }, { selfProject: 'p' });
    const b1 = M.indexBranch(c.items, { project: 'p' });
    const b2 = M.indexBranch(c.items, { project: 'p' });
    b2.expanded = true;
    b2.localPath = 'D:\\tmp';
    expect(M.sameIndexBranch(b1, b2)).toBe(true);
  });

  it('E3 生成物真变了就得认出来：detail 变 / 少一个子节点 / links 变 都 ⇒ false', () => {
    const c = M.conceptCatalog({ id: 'root', topic: 'T', children: [leaf('a', '甲', { detail: '<p>甲</p>' })] }, { selfProject: 'p' });
    const b1 = M.indexBranch(c.items, { project: 'p' });
    const mut = (fn) => { const x = JSON.parse(JSON.stringify(b1)); fn(x); return x; };
    expect(M.sameIndexBranch(b1, mut((x) => { x.children[0].detail = x.children[0].detail + '!'; }))).toBe(false);
    expect(M.sameIndexBranch(b1, mut((x) => { x.children = []; }))).toBe(false);
    expect(M.sameIndexBranch(b1, mut((x) => { x.children[0].links[0].id = 'zzz'; }))).toBe(false);
  });
});

describe('W16-F 与 mentions 共用命中计算（同一份 findMentions，不是第二套解析）', () => {
  it('F1 清单里每条概念的 `mentions` 逐条等于 `findMentions` 里 `to` 落在它 ids 里的条数', () => {
    const t = {
      id: 'root', topic: 'T',
      children: [
        leaf('a', '甲概念', { detail: '<p>甲概念</p>' }),
        leaf('b', '乙概念', { detail: '<p>见 甲概念</p>' }),
        box('c', '分组', [
          leaf('d', '丙概念', { detail: '<p>又见 甲概念 与 乙概念</p>' })
        ])
      ]
    };
    const c = M.conceptCatalog(t, { selfProject: 'p' });
    const m = M.findMentions(t, { selfProject: 'p' });
    const toCount = new Map();
    m.items.forEach((it) => toCount.set(it.to, (toCount.get(it.to) || 0) + 1));
    c.items.forEach((it) => {
      let n = 0;
      it.ids.forEach((id) => { n += (toCount.get(id) || 0); });
      expect(it.mentions).toBe(n);
    });
    expect(c.mentions).toBe(c.items.reduce((s, x) => s + x.mentions, 0));
  });

  it('F2 传了 `selfProject` 时"已建链接的不算提及"这条口径被继承（与 mentions 命令完全同参）', () => {
    const t = {
      id: 'root', topic: 'T',
      children: [
        leaf('a', '甲概念', { detail: '<p>甲概念</p>' }),
        leaf('b', '乙概念', { detail: '<p>见 甲概念</p>', links: [{ project: 'p', id: 'a', caption: '相关' }] })
      ]
    };
    const withLinks = M.conceptCatalog(t, { selfProject: 'p' });
    expect(withLinks.items.filter((x) => x.name === '甲概念')[0].mentions).toBe(0);
    // 反证：不给 selfProject 时只比 id（保守口径），同样会认成"已链接" ⇒ 仍是 0
    expect(M.conceptCatalog(t, {}).items.filter((x) => x.name === '甲概念')[0].mentions).toBe(0);
  });
});
