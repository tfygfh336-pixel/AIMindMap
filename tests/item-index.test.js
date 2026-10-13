/* ============================================================
 * tests/item-index.test.js — 条目级检索 / 取回 / 预算（S3）单元测试
 * ------------------------------------------------------------
 * 守的口径**全部来自冻结契约** `docs/ITEM-MODEL.md`：
 *   · §3.4 命中形状（{id,topic,nodeId,nodeTopic,itemId,type,itemized,matchIn,snippet,src,verified,score}）
 *     与七个过滤参数、预算报告、`--max-bytes` 截断（AC9/AC10）
 *   · §3.1 条目视图 / §3.3 `get --item` 摘要与 `read --items`（任一缺失 ⇒ 整体失败）
 *   · §7 `qa` 由 items 现场派生（`read --json` 迁移前后逐字节不变）
 *
 * 这些测试**不起子进程、不碰真实 projects/**（除最后一段"只读实测对比"，它只读且缺文件即跳过）——
 * 工程纪律：集成/冒烟会在真实 projects/ 里造数据，那由 I 串行跑（S3 不跑）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import itemIndex from '../src/item-index.js';
import query from '../src/query.js';
import paletteRank from '../src/palette-rank.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(HERE, '..');
const B = (v) => itemIndex.utf8Bytes(typeof v === 'string' ? v : JSON.stringify(v));

const I_A1 = 'i-a1';
const I_A2 = 'i-a2';
const I_A3 = 'i-a3';
const I_A4 = 'i-a4';
const I_B1 = 'i-b1';

/** 合成项目：一个条目化大节点（含四种 type）+ 一个未条目化节点 + 一个带节点级标签的条目化节点 */
const FIX = () => ({
  id: 'root', topic: '根节点', expanded: true, detail: '<p>根的内容</p>',
  children: [
    {
      id: '1c', topic: '①c 关键判据（闸门）',
      items: [
        { id: I_A1, type: 'text', html: '<p>闸门：第一道是选项守门</p>',
          src: 'CHANGELOG.md:713-717', tags: ['门禁'], at: '2026-10-11T04:00:00.000Z',
          by: 'cli:item-add',
          verified: { at: '2026-10-11T05:00:00.000Z', by: 'cli:item-edit', how: '读了 src 指向的源码行' } },
        { id: I_A2, type: 'text', html: '<p>闸门：第二道是写后回读</p>', tags: ['门禁', '检索'] },
        { id: I_A3, type: 'rich', html: '<table><tr><td>闸门</td></tr></table>', src: ['docs/RULES.md:1-9'] },
        { id: I_A4, type: 'qa', qa: { q: '闸门是几道？', a: '两道。', at: '2026-09-01T00:00:00.000Z' } }
      ],
      children: [{ id: '1c-1', topic: '闸门的子节点', children: [] }]
    },
    { id: '2x', topic: '②x 只有节点级标签', tags: ['门禁'],
      items: [{ id: I_B1, type: 'text', html: '<p>普通一条</p>' }], children: [] },
    { id: 'bl', topic: '闸门：未条目化的节点', detail: '<p>这里的闸门写在 detail 里</p>', tags: ['门禁'], children: [] }
  ]
});

/** 深度优先的节点 id 顺序（命中顺序的期望值按它写） */
const ids = (hits) => hits.map((h) => h.nodeId + (h.itemId ? '#' + h.itemId : ''));

describe('搜索：默认口径 = 搜条目（契约 §3.4）', () => {
  /* ⚠️ 【W6】本组里两处**顺序**期望改过口径（命中集合一处没动）：
   * 改动前"顺序 = 深度优先 + 条目序"，现在"顺序 = 模糊打分升序，同分才按深度优先 + 条目序"
   * （打分与定序的唯一实现在 `src/palette-rank.js`，命令面板同一份）。
   * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 `## W6｜…` 一节。 */
  it('条目正文命中 ⇒ 一条一命中；旧口径（--topic-only）同一节点只命中 1 条', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门' });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('items');
    // ①c 的 4 条条目里 4 条都含「闸门」；再加上 3 条节点级命中（①c 的 topic、1c-1、bl）
    // 顺序 = 模糊分升序（打分只看"命中面那段文本"）：'闸门'(i-a3) < '闸门的子节点'(1c-1)
    //   < '闸门是几道？ 两道。'(i-a4) = '闸门：未条目化的节点'(bl) ← 同分按 DFS+条目序
    //   < '闸门：第一道…'(i-a1) = '闸门：第二道…'(i-a2)（同长同分，按条目序）
    expect(r.hits.filter((h) => h.itemId).map((h) => h.itemId)).toEqual([I_A3, I_A4, I_A1, I_A2]);
    expect(r.hitCount).toBe(7);
    const old = itemIndex.searchItems(FIX(), { keyword: '闸门', topicOnly: true });
    expect(old.mode).toBe('topic-only');
    expect(old.hits.map((h) => h.nodeId)).toEqual(['1c-1', 'bl', '1c']);   // 同上：短串先、中段命中垫底
    // AC9：--topic-only 下同一命中的 itemId 为 null
    expect(old.hits.every((h) => h.itemId === null)).toBe(true);
  });

  it('命中形状逐键（契约 §3.4 逐字）：v2 别名 + 条目级字段', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '第一道' });
    expect(r.hits).toHaveLength(1);
    const h = r.hits[0];
    expect(Object.keys(h).sort()).toEqual([
      'id', 'itemId', 'itemized', 'matchIn', 'nodeId', 'nodeTopic',
      'score', 'snippet', 'src', 'topic', 'type', 'verified'
    ].sort());
    expect(h).toMatchObject({
      id: '1c', topic: '①c 关键判据（闸门）', nodeId: '1c', nodeTopic: '①c 关键判据（闸门）',
      itemId: I_A1, type: 'text', itemized: true, matchIn: 'item', verified: true, score: 1
    });
    expect(h.src).toEqual(['CHANGELOG.md:713-717']);   // 字符串 src 在命中里归一成数组
    expect(h.snippet).toContain('第一道');
  });

  it('未条目化节点：itemId=null、type=null、itemized=false、matchIn=topic', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '未条目化' });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ nodeId: 'bl', itemId: null, type: null, itemized: false, matchIn: 'topic' });
    expect(Object.keys(r.hits[0]).sort()).toEqual([
      'id', 'itemId', 'itemized', 'matchIn', 'nodeId', 'nodeTopic', 'score', 'snippet', 'topic', 'type', 'verified'
    ].sort());
    expect(r.hits[0].verified).toBe(false);
  });

  it('未条目化节点的 detail **不进默认口径**（那是 v2 的 --full 面）', () => {
    expect(itemIndex.searchItems(FIX(), { keyword: '写在 detail 里' }).hits).toEqual([]);
    const full = itemIndex.searchItems(FIX(), { keyword: '写在 detail 里', full: true });
    expect(full.hits).toHaveLength(1);
    expect(full.hits[0]).toMatchObject({ nodeId: 'bl', matchIn: 'detail', itemId: null });
  });

  it('条目顺序 = 模糊分升序、同分保持"深度优先 + 条目序"（打分与定序的唯一实现在 src/palette-rank.js）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门' });
    // ⚠️ 【W6】改前这条断言的是"顺序 = 深度优先 + 条目序"（那时没有模糊排序）。
    // 现在排序键是**共享的那份打分**，DFS+条目序只是**同分时的次序**：
    //   1c#i-a3 (-1.98) → 1c-1 (-1.94) → 1c#i-a4 (-1.90) = bl (-1.90) → 1c#i-a1 = 1c#i-a2 (-1.89)
    //   → 1c (8.11：命中面是「①c 关键判据（闸门）」，关键词在**中段**，分数最差)
    //   （括号里是 `fuzzyScore` 的真值：越靠前的命中面越短 / 命中越靠词首）
    expect(ids(r.hits)).toEqual([
      '1c#' + I_A3, '1c-1', '1c#' + I_A4, 'bl', '1c#' + I_A1, '1c#' + I_A2, '1c'
    ]);
    // 同分那条按原顺序（DFS + 条目序）：i-a4 在 bl 之前、i-a1 在 i-a2 之前 —— 上一条已钉住；
    // 这里再给一份**同分**的对照：同一个节点里两条一样长的条目，顺序只能是条目序
    const tie = itemIndex.searchItems(
      { id: 'root', topic: 'r', children: [{ id: 'n', topic: 'n', items: [
        { id: 'i-1', type: 'text', html: '<p>甲乙</p>' },
        { id: 'i-2', type: 'text', html: '<p>甲丙</p>' }
      ], children: [] }] }, { keyword: '甲' });
    expect(tie.hits.map((h) => h.itemId)).toEqual(['i-1', 'i-2']);
    // 唯一的例外是调用方**显式**给了热度向量（热度条第二件）：那时在**这个基线**上再做封顶加权，
    // 实现只有一处（src/item-index.js 的 orderByHeat），取值也只有一处（src/heat.js 的 SEARCH_RANK）
    // —— 那条路的判据在 tests/search-heat.test.js（含"零热度 ⇒ 逐字不变"的回归）。
  });

  it('matchIn 一律落在封闭取值表里（契约 §3.4）', () => {
    const cases = [
      { keyword: '闸门' }, { keyword: '闸门', topicOnly: true }, { keyword: '闸门', full: true },
      { tag: '门禁' }, { keyword: '图' }
    ];
    cases.forEach((c) => {
      itemIndex.searchItems(FIX(), c).hits.forEach((h) => {
        expect(itemIndex.MATCH_IN).toContain(h.matchIn);
      });
    });
  });

  /* 【W4b】契约 §3.4 的**取值表被打开**了一个口子（扩召回）；写清它到底是"改了什么"：
   * ⭐ **键仍是 12 个**（本件**不是加键**）—— 变的是 `matchIn` 的**取值集合**：
   *    旧 8 个值原样保留，新增的正是"能扩召回的那几路"各自声明的取值（现取路由表，唯二两处不许漂）。 */
  it('【W4b】matchIn 取值表开了新值（扩召回），而命中的**键仍然只有 12 个** —— 开取值表 ≠ 加键', () => {
    const BASE = ['topic', 'item', 'item-tag', 'node-tag', 'caption', 'tag', 'link', 'detail'];
    BASE.forEach((v) => expect(itemIndex.MATCH_IN, '旧取值一个都不许丢：' + v).toContain(v));
    const declared = paletteRank.ROUTES.filter((r) => r.recall).map((r) => r.recallHit);
    expect(declared.length, '路由表里必须至少有一路能扩召回（否则这条断言是空转）').toBeGreaterThan(0);
    expect(itemIndex.MATCH_IN.filter((v) => BASE.indexOf(v) < 0),
      '取值表里多出来的，必须正好是路由表声明的扩召回取值（两处不许漂）').toEqual(declared);

    // 语料：一条字面命中（头名）+ 一个只靠一跳够得着它的邻居（links 边；正文里没有那个关键词）
    const tree = { id: 'root', topic: '根', children: [
      { id: 'n-lead', topic: '闸门与门控', children: [] },
      { id: 'n-nbr', topic: '旁的机制', children: [], links: [{ project: 'p', id: 'n-lead' }] }
    ]};
    const opts = { keyword: '闸门', mode: paletteRank.DEFAULT_MODE, selfProject: 'p' };
    const off = itemIndex.searchItems(tree, opts);
    const on = itemIndex.searchItems(tree, Object.assign({}, opts, { recall: paletteRank.RECALL_ROUTE_IDS[0] }));
    expect(off.hits.map((h) => h.matchIn), '不给 --recall ⇒ 新取值一个都不出现').toEqual(['topic']);
    const nbr = on.hits.filter((h) => h.nodeId === 'n-nbr')[0];
    expect(nbr, '给了 --recall ⇒ 一跳邻居被接回结果里').toBeTruthy();
    expect(nbr.matchIn, '新取值 = 路由表那一行为它声明的那个（不是另起一个名字）').toBe(declared[0]);
    expect(itemIndex.MATCH_IN).toContain(nbr.matchIn);
    // ---- 逐键：与字面命中**同一套键**（少的只是"没有命中面原文"那个可选键）----
    const CONTRACT = ['id', 'topic', 'nodeId', 'nodeTopic', 'itemId', 'type', 'itemized', 'matchIn',
      'snippet', 'src', 'verified', 'score'];
    expect(CONTRACT.length, '契约键数就是 12（本件一个字没动它）').toBe(12);
    Object.keys(nbr).forEach((k) => expect(CONTRACT, '扩召回命中上有契约外的键：' + k).toContain(k));
    CONTRACT.forEach((k) => {
      if (k !== 'src' && k !== 'snippet') expect(Object.keys(nbr), '必有的键：' + k).toContain(k);
    });
    expect(nbr.itemId).toBe(null);
    expect(nbr.type).toBe(null);
    expect(Object.keys(nbr).indexOf('snippet'), '没有命中面原文 ⇒ 不产生噪音键（既有口径）').toBe(-1);
  });

  it('qa 条目的检索面 = q + a（正文由 src/qa.js 渲染，检索面不复制那段逻辑）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '两道' });
    expect(r.hits.map((h) => h.itemId)).toEqual([I_A4]);
    expect(r.hits[0].type).toBe('qa');
  });

  it('snippet 有长度上界，且上界只有一处实现（常量）', () => {
    const long = { id: 'root', topic: 'r', children: [{ id: 'n', topic: 'n',
      items: [{ id: 'i-x', type: 'text', html: '<p>' + '啊'.repeat(400) + '关键词' + '呀'.repeat(400) + '</p>' }],
      children: [] }] };
    const h = itemIndex.searchItems(long, { keyword: '关键词' }).hits[0];
    expect(h.snippet.length).toBeLessThanOrEqual(itemIndex.SNIPPET_MAX);
    expect(h.snippet).toContain('关键词');
  });
});

describe('七个过滤参数（契约 §3.4，各至少一条断言）', () => {
  it('--tag：条目级 → item-tag；节点级（条目化）→ node-tag；未条目化节点照 v2 报 tag', () => {
    const r = itemIndex.searchItems(FIX(), { tag: '门禁' });
    expect(ids(r.hits)).toEqual(['1c#' + I_A1, '1c#' + I_A2, '2x#' + I_B1, 'bl']);
    expect(r.hits.map((h) => h.matchIn)).toEqual(['item-tag', 'item-tag', 'node-tag', 'tag']);
  });

  it('--tag 与关键词是 AND（v2 口径）', () => {
    expect(ids(itemIndex.searchItems(FIX(), { keyword: '第二道', tag: '门禁' }).hits)).toEqual(['1c#' + I_A2]);
    expect(itemIndex.searchItems(FIX(), { keyword: '第二道', tag: '不存在的标签' }).hits).toEqual([]);
  });

  it('--src：字符串与数组两种 src 都能按子串命中；命中一律只到条目', () => {
    expect(ids(itemIndex.searchItems(FIX(), { keyword: '闸门', src: 'CHANGELOG' }).hits)).toEqual(['1c#' + I_A1]);
    expect(ids(itemIndex.searchItems(FIX(), { keyword: '闸门', src: 'RULES' }).hits)).toEqual(['1c#' + I_A3]);
    // 「条目级过滤给了 ⇒ 只返回条目级命中」：bl / 1c-1 的节点级命中不返回
    expect(itemIndex.searchItems(FIX(), { keyword: '闸门', src: 'RULES' }).hits.some((h) => h.itemId === null)).toBe(false);
  });

  /* 「空 needle」这条边界 —— **两层分工**（第五批收口：`--src` 的匹配与"有没有给过滤"收成一处，
   * 逐字契约见 `src/item-index.js` 的 `srcMatches()` 注释）：
   *   · 匹配函数（`srcMatches`）的契约是 **needle 非空**；
   *   · "这一维过滤没过滤"由**过滤层**（`passItemFilters` 开头的 `if (f.src)`）回答 —— 判的是
   *     "**参数出现没出现**"，**不是**它的真值 ⇒ 空串 = **这条过滤不存在**（不是"过滤器是空串"）。
   * 期望值**写死**在下面（不是"跑一遍看它返回啥"）：判别力已实测 —— 把 `if (f.src)` 改成
   * `if (f.src !== undefined)` ⇒ 第一条断言**必红**；还原后文件 SHA-256 逐字节相同 ⇒ 复绿。 */
  it('空 needle 不是过滤条件：过滤层说"没给过滤"，匹配函数说"不命中"', () => {
    const item = { id: 'i-x', type: 'text', html: '<p>正文</p>', src: 'refs/spec.md:4::第一条' };
    // ① 过滤层：`src: ''` ⇒ **这条过滤不存在** ⇒ 任何条目都通过（= 写死的期望值）
    expect(itemIndex.passItemFilters(item, { type: null, verified: false, src: '', since: null })).toBe(true);
    // 成对的一条（防空转：只断言 true 的判据恒真）：给了非空 needle 且不命中 ⇒ false
    expect(itemIndex.passItemFilters(item, { type: null, verified: false, src: 'no-such-needle', since: null })).toBe(false);
    expect(itemIndex.passItemFilters(item, { type: null, verified: false, src: 'spec.md', since: null })).toBe(true);
    // ② 匹配函数自己的读数：契约外输入（空 needle）兜底成"**不命中**"——
    //    它是"没命中"，**不是**"没给过滤"；后者只由①那一层回答（两个读数不许互换）
    expect(itemIndex.srcMatches(item, '')).toBe(false);
    expect(itemIndex.srcMatches(item, 'spec.md')).toBe(true);
    expect(itemIndex.srcMatches(item, 'no-such-needle')).toBe(false);
    expect(itemIndex.srcMatches({ src: ['CHANGELOG.md:713-717'] }, 'CHANGELOG')).toBe(true);   // 数组形状照旧
    expect(itemIndex.srcMatches({}, 'CHANGELOG')).toBe(false);                                // 没有 src ⇒ 不命中
  });

  it('`--src` 的子串匹配只有一个实现：`passItemFilters` 只许调 `srcMatches`，不许自己再写一遍', () => {
    const text = fs.readFileSync(path.join(ROOT_DIR, 'src', 'item-index.js'), 'utf8');
    const bodyOf = (name) => {
      const m = new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}').exec(text);
      return m && m[1];
    };
    const pf = bodyOf('passItemFilters');
    // 锚点找不到 = 这条判据测不了任何东西 ⇒ 判红（绝不把"定位失败"当通过）
    expect(pf, 'src/item-index.js 里必须能找到 `function passItemFilters(item, f) { … }`').toBeTruthy();
    expect(pf).toContain('srcMatches(');       // 正：真的走那一处实现
    expect(pf).not.toContain('indexOf');       // 反：没有自己那份子串判定
    const sm = bodyOf('srcMatches');
    expect(sm, 'src/item-index.js 里必须能找到 `function srcMatches(itemOrSrc, needle) { … }`').toBeTruthy();
    expect(sm).toContain('indexOf');           // 唯一实现处就是它（`src/item-src.js` 的 matchesSrc 是薄转发）
  });

  it('--verified：只要已核条目（缺失 = 未核）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门', verified: true });
    expect(ids(r.hits)).toEqual(['1c#' + I_A1]);
    expect(r.hits[0].verified).toBe(true);
  });

  it('--type：只要该 type（含 qa / rich）', () => {
    expect(ids(itemIndex.searchItems(FIX(), { keyword: '闸门', type: 'qa' }).hits)).toEqual(['1c#' + I_A4]);
    expect(ids(itemIndex.searchItems(FIX(), { keyword: '闸门', type: 'rich' }).hits)).toEqual(['1c#' + I_A3]);
    expect(itemIndex.searchItems(FIX(), { keyword: '闸门', type: 'text' }).hits.map((h) => h.itemId)).toEqual([I_A1, I_A2]);
  });

  it('--since：at >= ISO；没有 at 的条目不返回；未条目化节点不返回（契约明文）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门', since: '2026-10-01' });
    expect(ids(r.hits)).toEqual(['1c#' + I_A1]);
    // bl 的 topic 含「闸门」，但 --since 下不返回未条目化的节点命中
    expect(r.hits.some((h) => h.nodeId === 'bl')).toBe(false);
    expect(itemIndex.searchItems(FIX(), { keyword: '闸门', since: '2030-01-01' }).hits).toEqual([]);
  });

  it('过滤条件写错 ⇒ 当场报错（不静默变成"0 命中"）', () => {
    const bad1 = itemIndex.searchItems(FIX(), { keyword: '闸门', verified: 'nonsense' });
    expect(bad1.ok).toBe(false);
    expect(bad1.message).toContain('--verified 只能是 true 或 false');
    const bad2 = itemIndex.searchItems(FIX(), { keyword: '闸门', type: 'fact' });
    expect(bad2.ok).toBe(false);
    expect(bad2.message).toBe('--type 只能是 text / rich / qa 之一（收到 "fact"）');
    const bad3 = itemIndex.searchItems(FIX(), { keyword: '闸门', since: '昨天' });
    expect(bad3.ok).toBe(false);
    expect(bad3.message).toContain('--since 需要一个能解析的时间');
    expect(bad3.hits).toEqual([]);
  });

  it('--topic-only × 条目级过滤 ⇒ 拒绝（两种口径不混，同 read --items × --brief 的纪律）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门', topicOnly: true, type: 'qa' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('--topic-only 与 --type 不能同给');
  });

  it('既没关键词也没 --tag ⇒ 报错（不是"0 命中"）', () => {
    const r = itemIndex.searchItems(FIX(), {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('缺少关键词');
  });
});

describe('预算报告与 --max-bytes 上界（契约 §3.4 / AC10）', () => {
  it('budget 四项 + bytes 就是 hits 的 UTF-8 字节数（口径逐字节对账）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门' });
    expect(Object.keys(r.budget).sort()).toEqual(['bytes', 'estTokens', 'limit', 'maxBytes'].sort());
    expect(r.budget.bytes).toBe(B(r.hits));
    expect(r.budget.estTokens).toBe(Math.ceil(r.budget.bytes / itemIndex.BYTES_PER_TOKEN));
    expect(r.budget.limit).toBe(itemIndex.DEFAULT_LIMIT);        // 缺省有界
    expect(r.budget.maxBytes).toBe(itemIndex.DEFAULT_MAX_BYTES);
    expect(r.truncated).toBe(false);
    expect('resume' in r.budget).toBe(false);                    // 没截断就不产生这个噪音键
  });

  it('--limit 截断：hitCount 仍是全量命中数，hits 才是本次返回（不许静默少给）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门', limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.hitCount).toBe(7);
    expect(r.truncated).toBe(true);
    expect(r.budget.limit).toBe(2);
    expect(r.budget.resume).toContain('续取方式');
  });

  it('--max-bytes 很小时：truncated + 实际返回字节 ≤ 上界（AC10，不写死数字）', () => {
    const all = itemIndex.searchItems(FIX(), { keyword: '闸门' });
    const one = B([all.hits[0]]);
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门', maxBytes: one + 8 });
    expect(r.truncated).toBe(true);
    expect(r.budget.bytes).toBeLessThanOrEqual(r.budget.maxBytes);
    expect(r.hits.length).toBeLessThan(all.hits.length);
    expect(r.hitCount).toBe(7);                                  // 截断不影响"全量命中数"
  });

  it('一条都装不下 ⇒ 空数组 + truncated（下界常量保证 budget.bytes 仍 ≤ 上界）', () => {
    const r = itemIndex.searchItems(FIX(), { keyword: '闸门', maxBytes: itemIndex.MIN_MAX_BYTES });
    expect(r.hits).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.budget.bytes).toBeLessThanOrEqual(r.budget.maxBytes);
  });

  it('常量自洽：缺省值都在允许区间内（命令层用它们做 ctx.intOption 的 min/max）', () => {
    expect(itemIndex.DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(itemIndex.DEFAULT_LIMIT).toBeLessThanOrEqual(itemIndex.LIMIT_MAX);
    expect(itemIndex.MIN_MAX_BYTES).toBeGreaterThan(B([]));      // 至少装得下空的 hits 数组
    expect(itemIndex.DEFAULT_MAX_BYTES).toBeGreaterThanOrEqual(itemIndex.MIN_MAX_BYTES);
    expect(itemIndex.DEFAULT_MAX_BYTES).toBeLessThanOrEqual(itemIndex.MAX_BYTES_MAX);
  });
});

describe('取回字节上界：一次 search + get --item（验收②；针在 ①c 那种 16k 节点上）', () => {
  /** ①c 的复刻：一个约 1.6 万字符（≈4.8 万字节）的节点 + 24 条条目 */
  function bigNode() {
    const items = [];
    for (let i = 0; i < 24; i++) {
      items.push({
        id: 'i-big-' + i, type: 'text',
        html: '<li>第' + i + '条 ' + '啊'.repeat(700) + '目标条目' + i + '</li>'
      });
    }
    return { id: 'root', topic: '根', children: [{ id: '1c', topic: '①c 关键判据', items, children: [] }] };
  }

  it('命中片段 + 一条正文的字节数远小于整节点正文（不许把整块 detail 拖回来）', () => {
    const root = bigNode();
    const node = root.children[0];
    const whole = B(node.items.map((it) => it.html).join(''));      // 改前：只能整块读
    const r = itemIndex.searchItems(root, { keyword: '目标条目7' });
    /* ⚠️ 【W6】命中口径改了：`目标条目7` 现在**也**命中 `目标条目17`（7 是 17 的子序列）——
     * 这正是 W6 要的行为（与命令面板同一个谓词），不是缺陷。这条用例测的是**字节**，
     * 所以命中面按新口径**如实钉住**（而不是把断言放松成"至少一条"）。 */
    expect(r.hits.map((h) => h.itemId)).toEqual(['i-big-7', 'i-big-17']);
    const item = itemIndex.getItemView(root, '1c', 'i-big-7');
    expect(item.ok).toBe(true);
    const after = B(r.hits) + B(item.view);
    // 上界由模型推导（不是魔数）：**每条命中**的 snippet 上界 × UTF-8 最坏 3 字节/字 + 结构开销，
    // 再加单条正文
    const bound = (itemIndex.SNIPPET_MAX * 3 + 400) * r.hits.length + B(item.view.html);
    expect(after).toBeLessThan(bound);
    expect(after).toBeLessThan(whole / 10);
  });

  it('get --item 只带那一条：不带同节点其它条目的正文', () => {
    const root = bigNode();
    const v = itemIndex.getItemView(root, '1c', 'i-big-3').view;
    const s = JSON.stringify(v);
    expect(s).toContain('目标条目3');
    expect(s).not.toContain('目标条目4');
  });
});

describe('get --item / read --items（契约 §3.1 / §3.3）', () => {
  it('条目视图：键顺序与空值策略（text 条目带 html、qa 条目带 qa 且**不带** html）', () => {
    const root = FIX();
    const v = itemIndex.getItemView(root, '1c', I_A1).view;
    expect(Object.keys(v)).toEqual([
      'nodeId', 'nodeTopic', 'path', 'itemId', 'type', 'html', 'src', 'tags', 'at', 'by', 'verified'
    ]);
    expect(v.path).toEqual(['root', '1c']);
    expect(v.src).toEqual(['CHANGELOG.md:713-717']);
    expect(v.verified).toEqual({ at: '2026-10-11T05:00:00.000Z', by: 'cli:item-edit', how: '读了 src 指向的源码行' });
    const q = itemIndex.getItemView(root, '1c', I_A4).view;
    expect(Object.keys(q)).toEqual(['nodeId', 'nodeTopic', 'path', 'itemId', 'type', 'qa']);
    expect(q.html).toBeUndefined();
    expect(q.qa).toEqual({ q: '闸门是几道？', a: '两道。', at: '2026-09-01T00:00:00.000Z' });
  });

  it('条目不在该节点 ⇒ 指名它实际属于哪个节点（契约 §3.3 必错情形）', () => {
    const r = itemIndex.getItemView(FIX(), '2x', I_A1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('item-elsewhere');
    expect(r.message).toContain('2x');
    expect(r.message).toContain(I_A1);
    expect(r.message).toContain('①c 关键判据（闸门）');
  });

  it('节点不存在 / 条目不存在 / 节点未条目化：三种报文都能照着改', () => {
    expect(itemIndex.getItemView(FIX(), 'nope', I_A1).message).toBe('节点不存在: nope');
    const gone = itemIndex.getItemView(FIX(), '1c', 'i-nope');
    expect(gone.message).toContain('条目不存在: i-nope');
    expect(gone.message).toContain('共 4 条');
    expect(itemIndex.getItemView(FIX(), 'bl', 'i-nope').message).toContain('未条目化');
  });

  it('read --items：按给定顺序取回，带 meta/project/itemCount', () => {
    const data = { meta: { name: '合成', formatVersion: 3 }, data: FIX() };
    const r = itemIndex.readItemsView(data, I_A4 + ',' + I_A1, { project: '合成' });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.view)).toEqual(['meta', 'project', 'itemCount', 'items']);
    expect(r.view.itemCount).toBe(2);
    expect(r.view.items.map((x) => x.itemId)).toEqual([I_A4, I_A1]);
    expect(r.view.meta).toEqual({ name: '合成', formatVersion: 3 });
  });

  it('read --items：**任一 id 缺失 ⇒ 整体失败**并逐个点名（不给半份）', () => {
    const r = itemIndex.readItemsView({ meta: {}, data: FIX() }, I_A1 + ',i-nope1,i-nope2', {});
    expect(r.ok).toBe(false);
    expect(r.view).toBeUndefined();
    expect(r.missing).toEqual(['i-nope1', 'i-nope2']);
    expect(r.message).toContain('i-nope1');
    expect(r.message).toContain('i-nope2');
  });

  it('read --items × --brief / --skeleton / --subtree ⇒ 拒绝（两种口径不混）', () => {
    const data = { meta: {}, data: FIX() };
    expect(itemIndex.readItemsView(data, I_A1, { brief: true }).message).toContain('--brief');
    expect(itemIndex.readItemsView(data, I_A1, { skeleton: true }).message).toContain('--skeleton');
    expect(itemIndex.readItemsView(data, I_A1, { subtree: '1c' }).message).toContain('--subtree');
    expect(itemIndex.readItemsView(data, '', {}).message).toContain('--items 需要一个或多个条目 id');
  });

  it('read --items 的重复 id 只取一次（重复写同一个 id ≠ 要两份），顺序不变', () => {
    const r = itemIndex.readItemsView({ meta: {}, data: FIX() }, I_A2 + ' ' + I_A2 + ',' + I_A1, {});
    expect(r.view.items.map((x) => x.itemId)).toEqual([I_A2, I_A1]);
  });
});

describe('qa 派生化与读视图（契约 §7；read 的字节形状不许变）', () => {
  it('read 视图：条目化节点的 qa 由 items 现场派生（形状与 v2 逐字段相同）', () => {
    const view = query.buildReadView({ meta: { name: 'n' }, data: FIX() }, {});
    const n = view.nodes.filter((x) => x.id === '1c')[0];
    expect(n.qa).toEqual([{ q: '闸门是几道？', a: '两道。', at: '2026-09-01T00:00:00.000Z' }]);
    expect(JSON.stringify(n.qa)).toBe(JSON.stringify([FIX().children[0].items[3].qa]));  // 逐字节
  });

  it('read 视图**不加 items**（read 的字节形状承诺：只允许 formatVersion 2→3 的差异）', () => {
    const view = query.buildReadView({ meta: { name: 'n' }, data: FIX() }, {});
    view.nodes.forEach((n) => expect('items' in n).toBe(false));
  });

  it('未条目化节点照旧读 node.qa；没有 qa 面就不产生这个键', () => {
    const data = { meta: {}, data: { id: 'root', topic: 'r', qa: [{ q: 'q', a: 'a', at: 't' }],
      children: [{ id: 'k', topic: 'k', children: [] }] } };
    const view = query.buildReadView(data, {});
    expect(view.nodes[0].qa).toEqual([{ q: 'q', a: 'a', at: 't' }]);
    // 判据是**序列化后没有这个键**（视图对象里那些字段一律是显式 undefined，见 buildReadView）
    expect(view.nodes[1].qa).toBeUndefined();
    expect(JSON.stringify(view.nodes[1]).indexOf('"qa"')).toBe(-1);
  });

  it('get 视图：条目化节点额外带 items **摘要**（verified 是布尔、bytes 是检索面纯文本字节）', () => {
    const v = query.getNodeView(FIX(), '1c', {});
    expect(v.items).toHaveLength(4);
    expect(Object.keys(v.items[0])).toEqual(['itemId', 'type', 'src', 'verified', 'at', 'bytes']);
    expect(v.items[0].verified).toBe(true);
    expect(v.items[0].bytes).toBe(itemIndex.utf8Bytes(itemIndex.itemText(FIX().children[0].items[0])));
    expect(v.items[0]).not.toHaveProperty('html');          // 摘要不含正文
    expect(v.qa).toEqual([{ q: '闸门是几道？', a: '两道。', at: '2026-09-01T00:00:00.000Z' }]);
    expect(JSON.stringify(v)).not.toContain('第一道是选项守门');   // 正文一条都没带出来
  });

  it('未条目化节点不带 items 摘要键（0 条也不带：空数组不产生噪音键）', () => {
    expect('items' in query.getNodeView(FIX(), 'bl', {})).toBe(false);
    const empty = { id: 'r', topic: 'r', children: [{ id: 'z', topic: 'z', items: [], children: [] }] };
    expect('items' in query.getNodeView(empty, 'z', {})).toBe(false);
  });
});

describe('索引与"不落盘"（工程纪律）', () => {
  it('buildIndexes 一次建、多次用：传与不传结果逐字节相同', () => {
    const root = FIX();
    const idx = itemIndex.buildIndexes(root);
    const a = itemIndex.searchItems(root, { keyword: '闸门' });
    const b = itemIndex.searchItems(root, { keyword: '闸门', indexes: idx });
    expect(JSON.stringify(b.hits)).toBe(JSON.stringify(a.hits));
    // 三张表都在内存里；itemById 是**项目级**反查（§5.1：条目 id 全项目唯一）
    expect(Object.keys(idx.itemById).sort()).toEqual([I_A1, I_A2, I_A3, I_A4, I_B1]);
    expect(idx.itemById[I_A1].path).toEqual(['root', '1c']);
    expect(idx.byNodeId['2x'].itemized).toBe(true);
  });

  it('**不落盘**：模块里没有任何文件系统访问（只读查询不生成索引文件）', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'item-index.js'), 'utf8');
    ["require('fs')", 'require("fs")', "require('node:fs')", 'writeFile', 'createWriteStream',
      'mkdirSync', 'readdirSync', 'copyFileSync'].forEach((bad) => {
      expect(src.indexOf(bad)).toBe(-1);
    });
  });
});

describe('v2 口径兼容（复刻 tests/query.test.js 的 searchNodes 断言）', () => {
  /* 为什么在这里复刻一份：S3 把 `query.searchNodes` 的实现整体换成了条目级检索，
   * 而它原来钉在 `tests/query.test.js` 里 —— 那个文件**不归 S3 改**（改了就是越界）。
   * 这一组断言与那份逐条等价，用来证明"默认口径改了，v2 的既有行为没变"：
   *   · 未条目化节点的 topic 命中照旧、matchIn 照旧（含 v2 的 'detail'/'tag'）
   *   · --full 的额外面（detail / 图片 caption / 节点标签 / 链接说明）照旧
   *   · --tag 与关键词仍是 AND
   * ⇒ I 可以决定把它们并回 `tests/query.test.js`（那时这一组就该删掉，别留两份）。 */
  const ROOT2 = () => ({
    id: 'root', topic: '根', expanded: true, detail: '<p>根的内容</p>', tags: ['a'],
    children: [
      {
        id: 'c1', topic: '子一', expanded: false,
        detail: '<p>提到 交换机 与 <b>协议</b></p>', tags: ['net', 'a'],
        images: [{ file: 'assets/1.png', caption: '图一' }],
        links: [{ project: 'p', id: 'root', caption: '回根' }],
        children: [{ id: 'c1a', topic: '孙', children: [] }]
      },
      { id: 'c2', topic: '子二', children: [] }
    ]
  });

  it('默认只匹配 topic；--full 额外匹配 detail / caption / 标签 / 链接说明', () => {
    const r = query.searchNodes(ROOT2(), { keyword: '子' });
    expect(r.hits.map((h) => h.id).sort()).toEqual(['c1', 'c2']);
    expect(r.hits[0].matchIn).toBe('topic');

    const full = query.searchNodes(ROOT2(), { keyword: '交换机', full: true });
    expect(full.hits.map((h) => h.id)).toEqual(['c1']);
    expect(full.hits[0].matchIn).toBe('detail');
    expect(full.hits[0].snippet).toContain('交换机');

    expect(query.searchNodes(ROOT2(), { keyword: '协议', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT2(), { keyword: '图一', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT2(), { keyword: 'net', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT2(), { keyword: '回根', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT2(), { keyword: '不存在的东西' }).hits).toEqual([]);
  });

  it('--tag 单独用照旧报 tag；与关键词组合是 AND', () => {
    const r = query.searchNodes(ROOT2(), { tag: 'net' });
    expect(r.hits.map((h) => h.id)).toEqual(['c1']);
    expect(r.hits[0].matchIn).toBe('tag');
    expect(query.searchNodes(ROOT2(), { keyword: '子一', tag: 'net' }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT2(), { keyword: '子二', tag: 'net' }).hits).toEqual([]);
  });
});

describe('交付物闸门：§49 集成断言原文可解析、无判定标记冲突、条数对得上', () => {
  /* 为什么需要这一组：S3 不跑集成（纪律），那一段断言是**交给 I 粘贴**的 ⇒ 粘贴前唯一能
   * 机器验的就是"它能不能被解析、条数是不是我报的那个数、有没有踩 G9 的判定标记坑"。
   * 原文是工作产物（`.review/` 可随时删）⇒ 文件不在了这一组就跳过，不会变成常驻空转。 */
  const SRC = path.join(ROOT_DIR, '.review', '20261010-卖点与功能-常驻讨论', 'S3-§49-断言原文.js');
  const has = fs.existsSync(SRC);
  const text = has ? fs.readFileSync(SRC, 'utf8') : '';

  it.skipIf(!has)('语法可解析（粘贴进 scripts/cli-integration.js 不会红在语法上）', () => {
    expect(() => new Function(text)).not.toThrow();
  });

  it.skipIf(!has)('不含 G9 判定标记形态（`// ` 紧跟圈号 —— 本文件已踩过三次）', () => {
    expect(text.match(/\/\/\s*[①-⑳]/g)).toBeNull();
  });

  it.skipIf(!has)('断言条数 = 交付里报的那个数（27 条），且探针一律带 it-s3- 前缀', () => {
    expect((text.match(/check\(/g) || []).length).toBe(27);
    const probeNames = ['it-s3-v2-', 'it-s3-items-', 'it-s3-n1', 'it-s3-n2', 'it-s3-i1', 'it-s3-a1'];
    probeNames.forEach((p) => expect(text.indexOf(p)).toBeGreaterThan(-1));
  });
});

/* ============================================================
 * 真实数据只读实测对比（验收③：①c 那条 16864 字符的节点里定位一条）
 * ------------------------------------------------------------
 * 说明（**如实**）：真实项目此刻还是 v2（S1 的 `migrate items` 未落地、节点上没有 items），
 * 所以这里用**测试内的 <li> 切分**模拟条目 —— 它测的是**字节口径**（定位一条要花多少字节），
 * 不是 `parseDetail` 的语义。S1 合并后这一段可改成直接读 items 复跑。
 * 只读：本段不写任何文件；项目文件不在（换机器/被清掉）就跳过。
 * ============================================================ */
describe('实测对比：在 ①c 那种长节点里定位一条（只读，缺文件即跳过）', () => {
  const PROJ = path.join(ROOT_DIR, 'projects', '卖点讨论', '卖点讨论.json');
  const has = fs.existsSync(PROJ);

  it.skipIf(!has)('定位一条 `闸门` 的字节数：改后 ≪ 改前（整块 detail）', () => {
    const data = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
    const nodes = [];
    (function walk(n) { if (!n) return; nodes.push(n); (n.children || []).forEach(walk); })(data.data);
    // 派发词里的「①c 那条 16864 字符的节点」：先按标题找 ①c，再退回"detail 最长的那个"
    const byTopic = nodes.filter((n) => (n.topic || '').indexOf('①c') >= 0 && String(n.detail || '').length > 1000)[0];
    const target = byTopic || nodes.slice().sort((a, b) =>
      String(b.detail || '').length - String(a.detail || '').length)[0];
    const detail = target.detail || '';
    const li = detail.match(/<li>[\s\S]*?<\/li>/g) || [detail];
    const items = li.map((html, i) => ({ id: 'i-m-' + i, type: 'text', html }));
    const root = { id: 'root', topic: 'root',
      children: [{ id: target.id, topic: target.topic, detail: detail, items: items, children: [] }] };

    const hitKeyword = (li.filter((h) => h.indexOf('闸门') >= 0)[0] ? '闸门' : (target.topic || '').slice(0, 4));
    const r = itemIndex.searchItems(root, { keyword: hitKeyword });
    const first = r.hits.filter((h) => h.itemId)[0];
    expect(first).toBeTruthy();                                  // 词必须能在条目里命中，否则这段测不出东西
    const got = itemIndex.getItemView(root, target.id, first.itemId);
    expect(got.ok).toBe(true);

    // 改前：要"定位/取回这一条"只能整块读 —— ① 直接读 detail，② 走 get --json（含 detail）
    const before = itemIndex.utf8Bytes(detail);
    const bNodeView = itemIndex.utf8Bytes(JSON.stringify(query.getNodeView(root, target.id, { detail: true })));
    // 改后：一次 search（命中片段）+ get --item（只取那一条正文）
    const bHit = itemIndex.utf8Bytes(JSON.stringify(first));
    const bItem = itemIndex.utf8Bytes(JSON.stringify(got.view));
    const after = bHit + bItem;
    console.log('[S3 实测] 节点 ' + target.id + '「' + target.topic + '」：detail ' + detail.length + ' 字符 / '
      + before + ' B；本地 <li> 切出 ' + items.length + ' 条；关键词「' + hitKeyword + '」命中 ' + r.hitCount
      + ' 条（该节点 ' + r.hits.filter((h) => h.nodeId === target.id && h.itemId).length + ' 条）'
      + '；改后 = search 单条 ' + bHit + ' B + get --item ' + bItem + ' B = ' + after + ' B'
      + '；改前 = 整块 detail ' + before + ' B / 整节点 get --json ' + bNodeView + ' B'
      + '；倍数 = ' + (before / after).toFixed(1) + 'x（对整节点 ' + (bNodeView / after).toFixed(1) + 'x）');

    expect(after).toBeLessThan(before / 2);       // 「改后 ≪ 改前」的下界（实测倍数记在交付里）
    expect(after).toBeLessThan(bNodeView / 2);
    expect(r.budget.bytes).toBeLessThanOrEqual(r.budget.maxBytes);
  });
});
