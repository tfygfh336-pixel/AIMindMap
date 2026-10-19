/* ============================================================
 * tests/item-model.test.js — 条目层模型（S1）：往返契约 / 形状校验 / G2 判据 / 并发粒度
 * 运行：npx vitest run tests/item-model.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条都对着一个**能红**的判据）
 *   A. **往返契约**（迁移的准入门槛）：`renderDetail(parseDetail(detail)) === detail` **逐字节**；
 *      `renderDetail([]) === ''`；落盘再读回来（JSON 掉了对象引用）仍能逐字节回放；渲染幂等；
 *      空 detail 与"缺 detail"等价；**不可回放的输入返回 `null` 哨兵**（而不是"尽力而为改一下"）。
 *   B. `validateItems`：形状逐条点名（封闭 type 表 / `qa` 与 `html` 互斥 / `verified` 三字段 /
 *      未知字段 / 节点内 id 重复 / 非数组）。
 *   C. **G2 的条目层判据**（判定全在 `src/schema.js`，契约 §2/§9）：
 *      `meta.formatVersion` 2|3 都接受；`items` ↔ `detail` 逐字节一致（**判红必须给修法 `render-detail`**）；
 *      `items` ⇄ `detailMode` / `qa[]` 互斥；条目 id **全项目唯一**；
 *      **注入证明**：改一个 `items` 元素 ⇒ 必红，撤销 ⇒ 复绿（没红过的不算门禁）。
 *   D. **并发粒度**（契约 §8，本流实现）：`node:` 在条目化节点上排除 `detail` 与 `items`；
 *      **不同条目互不相交**（这是"多会话同时补条目"能自动合并的唯一理由）/ **同一条相交且报得出可读名**；
 *      `item-move` **可见**（键改名）；`mergeTrees` 逐条目挑来源 + 合并后**当场重建** `detail`。
 *
 * ## 环境纪律（改这个文件前先读）
 *   1) **只读 + 内存**：本文件不写任何项目（写盘证据在 tests/migrate-items.test.js）；
 *   2) `AI_MINDMAP_PROJECTS_DIR` 仍然先重定向到临时目录并**当场自证** —— 万一将来这里加了写操作，
 *      它写的是沙箱而不是真实 `projects/`（本工程最忌"夹具写进真实项目"）；
 *   3) **不起子进程**（受限环境下管道 stdio 会 EPERM 假失败；与 tests/cli-options.test.js 同口径）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 沙箱（必须在 require cli/core.js 之前设好：它的 PROJECTS_DIR 是模块加载时定型的） ----
 * 建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记），收尾只此一处（下面的 `afterAll`）。 */
const SANDBOX = makeTmp('mm-s1-model-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const M = require('../src/item-model.js');
const S = require('../src/schema.js');
const cc = require('../src/concurrency.js');
const core = require('../cli/core.js');

/* 重定向必须**当场**生效（本文件不写盘，但这条自证是"夹具不会落到真实 projects/"的机械保证） */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行');
}

afterAll(() => {
  cleanupAll();
});

/** 全项目唯一的条目 id 集合（`newItemId()` 只产候选，唯一性由调用方查 —— 契约 §5.1） */
const idsOf = (items) => items.map((x) => x.id);

/* ============================================================================
 * A. 往返契约（迁移的准入门槛）
 * ========================================================================== */
describe('S1-A 往返契约：renderDetail(parseDetail(detail)) === detail（逐字节）', () => {
  /** 真实数据里出现过的形状（真实项目 659 个有 detail 的节点都是这几类的组合） */
  const DETAILS = [
    '<p>只有一段</p>',
    '<h3>标题</h3>\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n<p>收尾</p>',
    '<ul>\n  <li>甲</li>\n    <li>乙</li>\n</ul>',
    '<ul><li>甲</li></ul><ul><li>乙</li></ul>',
    '<p>a<br>b</p>\n<ul><li>甲</li></ul>',
    '<table>\n<tr><td>表</td></tr>\n</table>\n<ul><li>li 在表后面</li></ul>',
    '<ul><li>甲</li></ul>\n<p>尾</p>\n     ',
    '<ul class="x">\n<li>带属性</li>\n</ul>',
    '<blockquote><p>引文</p></blockquote>',
    '<ul><li>甲</li></ul><!-- 注释 -->'
  ];

  it('十种真实形状逐字节回放；且**落盘再读回来**（JSON 不保留对象引用）仍逐字节', () => {
    DETAILS.forEach((d) => {
      const items = M.parseDetail(d, { at: '2026-10-11T04:00:00.000Z', by: 'cli:migrate' });
      expect(items, '解析结果不该是 null：' + JSON.stringify(d)).not.toBeNull();
      expect(M.renderDetail(items), '直接回放：' + JSON.stringify(d)).toBe(d);
      // 落盘再读回来：同一组条目会拿到两个**不同但相等**的容器对象 ⇒ 判组不能靠对象引用
      expect(M.renderDetail(JSON.parse(JSON.stringify(items))), '落盘再回放：' + JSON.stringify(d)).toBe(d);
    });
  });

  it('渲染幂等：同一份 items 渲染两次逐字节相同；空数组 ⇒ 空串（契约 §2）', () => {
    const items = M.parseDetail('<p>甲</p>\n<ul><li>乙</li></ul>');
    expect(M.renderDetail(items)).toBe(M.renderDetail(items));
    expect(M.renderDetail([])).toBe('');
    expect(M.renderDetail(null)).toBe('');
  });

  it('空 detail 与"缺 detail"等价：全空白/空串/null/undefined ⇒ []（不是 null）', () => {
    ['', '   ', '\n\t '].forEach((d) => expect(M.parseDetail(d)).toEqual([]));
    expect(M.parseDetail(null)).toEqual([]);
    expect(M.parseDetail(undefined)).toEqual([]);
  });

  it('不可回放 ⇒ **null 哨兵**（根层裸文本 / 缺闭合标签 / 交叉嵌套）：迁移必须跳过它们', () => {
    [
      '<ul>\n<li>甲</li>\n</ul>\n裸文本在根层\n<p>尾</p>',   // 根层裸文本：没有条目能承载它
      '<p><strong>前言</strong>\n<ul>\n<li>甲</li>\n</ul>',    // 同上的另一种形态
      '<ul><li>甲</li>',                                       // 缺闭合标签
      '<b><i>甲</b></i>'                                       // 交叉嵌套
    ].forEach((d) => {
      expect(M.parseDetail(d), '应当被判不可回放：' + JSON.stringify(d)).toBeNull();
    });
  });

  it('parseDetail 的类型守卫：非字符串**响亮抛错**（调用方 bug ≠ "这段内容不可切分"）', () => {
    expect(() => M.parseDetail({})).toThrow(/字符串/);
    expect(() => M.parseDetail(42)).toThrow(/字符串/);
  });

  it('条目 id：形状合法、节点内不重复（生成器只产候选，唯一性由调用方在全项目查）', () => {
    const items = M.parseDetail(DETAILS[1]);
    const ids = idsOf(items);
    expect(ids.length).toBeGreaterThan(1);
    ids.forEach((id) => expect(M.ID_RE.test(id), 'id 形状：' + id).toBe(true));
    expect(new Set(ids).size).toBe(ids.length);
    // 形状助手：容器信息是**解析期事实**（并发合并逐条挑来源时要用它判"这组结构有没有变"）
    expect(M.itemsWithContainers(items).length).toBeGreaterThan(0);
  });

  it('type 的指派口径：`<li>` ⇒ text，其余顶层块 ⇒ rich（契约 §1/§5.1）', () => {
    const items = M.parseDetail('<h3>标题</h3>\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n<p>收尾</p>');
    expect(items.map((x) => x.type)).toEqual(['rich', 'text', 'text', 'rich']);
    expect(items.map((x) => x.html)).toEqual(['<h3>标题</h3>', '<li>甲</li>', '<li>乙</li>', '<p>收尾</p>']);
  });

  it('opts.at / opts.by 写进每一条；不给就不写（契约 §1：at 可选，"迁移写迁移时刻"）', () => {
    const withOpts = M.parseDetail('<p>甲</p>', { at: '2026-10-11T04:00:00.000Z', by: 'cli:migrate' });
    expect(withOpts[0].at).toBe('2026-10-11T04:00:00.000Z');
    expect(withOpts[0].by).toBe('cli:migrate');
    const bare = M.parseDetail('<p>甲</p>');
    expect(bare[0].at).toBeUndefined();
    expect(bare[0].by).toBeUndefined();
  });
});

/* ============================================================================
 * B. validateItems（形状；只看得到**一个节点**）
 * ========================================================================== */
describe('S1-B validateItems：形状逐条点名（节点内；全项目唯一性归 schema）', () => {
  const okItem = (over) => Object.assign({ id: 'i-a1', type: 'text', html: '<p>甲</p>' }, over || {});

  it('合法 items（含可选字段齐全的条目、qa 条目）⇒ 空数组', () => {
    expect(M.validateItems([])).toEqual([]);
    expect(M.validateItems([
      okItem({
        src: ['CHANGELOG.md:713-717'], tags: ['门禁'], at: '2026-10-11T04:00:00.000Z', by: 'cli:item-add',
        verified: { at: '2026-10-11T04:00:00.000Z', by: 'cli:item-edit', how: '读了 src 指向的源码行' },
        supersededBy: 'i-b2'
      }),
      { id: 'i-q1', type: 'qa', qa: { q: '', a: '答', at: '2026-10-11T04:00:00.000Z' } }
    ])).toEqual([]);
  });

  it('type 是**封闭表**：预留值（fact / decision / todo）判红并点名取值表', () => {
    const e = M.validateItems([okItem({ type: 'fact' })]).join('\n');
    expect(e).toContain('i-a1');
    expect(e).toContain('type 取值非法');
    expect(e).toContain('text / rich / qa');
  });

  it('type=qa 与 html **互斥**；缺 qa 判红；qa.a / qa.at 必填（q 允许空串）', () => {
    expect(M.validateItems([{ id: 'i-q', type: 'qa', html: '<p>x</p>', qa: { a: '答', at: 'x' } }]).join('\n'))
      .toContain('互斥');
    expect(M.validateItems([{ id: 'i-q', type: 'qa' }]).join('\n')).toContain('.qa 必填');
    expect(M.validateItems([{ id: 'i-q', type: 'qa', qa: { q: '', a: '', at: 'x' } }]).join('\n'))
      .toContain('.qa.a 必须是非空字符串');
    expect(M.validateItems([{ id: 'i-q', type: 'qa', qa: { q: '', a: '答', at: '' } }]).join('\n'))
      .toContain('.qa.at');
  });

  it('verified 缺失 = 未核（合法）；给了就必须三字段全有，且**不许写 null**', () => {
    expect(M.validateItems([okItem()])).toEqual([]);
    expect(M.validateItems([okItem({ verified: { at: 'x', by: 'y' } })]).join('\n')).toContain('verified.how 必填');
    expect(M.validateItems([okItem({ verified: null })]).join('\n')).toContain('verified 必须是');
    expect(M.validateItems([okItem({ verified: {} })]).join('\n')).toContain('verified.at 必填');
  });

  it('取值表封闭：未知字段判红；`_` 起头的内部字段放行（解析期事实）', () => {
    expect(M.validateItems([okItem({ weight: 3 })]).join('\n')).toContain('不是契约字段');
    expect(M.validateItems([okItem({ _container: { open: '<ul>', close: '</ul>' } })])).toEqual([]);
  });

  it('节点内 id 重复 / 非数组 / 同一对象出现两次 ⇒ 各自点名', () => {
    expect(M.validateItems([okItem(), okItem()]).join('\n')).toContain('与前面重复');
    expect(M.validateItems('不是数组').join('\n')).toContain('必须是数组');
    const shared = okItem();
    expect(M.validateItems([shared, shared]).join('\n')).toContain('同一个对象');
  });
});

/* ============================================================================
 * C. G2：src/schema.js 的条目层判据（含注入证明）
 * ========================================================================== */
describe('S1-C G2（src/schema.js）：formatVersion / items↔detail / 互斥 / 全项目唯一', () => {
  const DETAIL = '<h3>标题</h3>\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>';
  /** 一个最小项目：root 下一个条目化节点 x（items 与 detail **一致**） */
  const project = (over) => {
    const items = M.parseDetail(DETAIL, { at: '2026-10-11T04:00:00.000Z', by: 'cli:migrate' });
    const node = Object.assign({
      id: 'x', topic: 'X', items: items, detail: M.renderDetail(items), children: []
    }, over || {});
    return {
      meta: { name: 't', formatVersion: 3 }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [node] }
    };
  };
  const errs = (p) => S.validateProject(p).errors;

  it('meta.formatVersion：2 与 3 都接受（回退能成立的硬前提），别的值判红并说清允许范围', () => {
    expect(errs(project()).filter((e) => /formatVersion/.test(e))).toEqual([]);
    [2, 3].forEach((v) => {
      const p = project(); p.meta.formatVersion = v;
      expect(errs(p).filter((e) => /formatVersion/.test(e)), 'formatVersion=' + v).toEqual([]);
    });
    const bad = project(); bad.meta.formatVersion = 4;
    const msg = errs(bad).join('\n');
    expect(msg).toContain('meta.formatVersion 必须是 2 或 3');
  });

  it('items ↔ detail 一致 ⇒ 绿；**注入不一致** ⇒ 必红、点名节点、且给修法 `render-detail`', () => {
    expect(errs(project())).toEqual([]);
    // ---- 注入证明（契约 §9：判别力证明 —— 没红过的不算门禁）----
    const bad = project();
    bad.data.children[0].items[1].html = '<li>甲（被人手改过）</li>';       // 只动 items，不动 detail
    const msg = errs(bad).join('\n');
    expect(msg).toContain('[x]');                                          // 点名节点
    expect(msg).toContain('detail 与 items 不一致');
    expect(msg).toContain('render-detail');                                // 判红必须给修法
    // ---- 撤销 ⇒ 复绿（同一条判据既能红也能绿）----
    bad.data.children[0].items[1].html = '<li>甲</li>';
    expect(errs(bad)).toEqual([]);
  });

  it('"缺 detail" 与 "空串" 等价：删空条目的节点必须过闸门（契约 §2）', () => {
    const empty = project({ items: [], detail: undefined });
    expect(errs(empty)).toEqual([]);
    const emptyStr = project({ items: [], detail: '' });
    expect(errs(emptyStr)).toEqual([]);
    // 反过来：items 非空而 detail 缺 ⇒ 红（缺 ≡ 空串 ≠ renderDetail(items)）
    const missing = project({ detail: undefined });
    expect(errs(missing).join('\n')).toContain('detail 与 items 不一致');
  });

  it('互斥表（§2）：items + detailMode ⇒ 红；items + qa[] ⇒ 红；`rich` 节点无 items ⇒ 绿', () => {
    const both = project({ detailMode: 'rich' });
    expect(errs(both).join('\n')).toContain('不得有 detailMode');
    const withQa = project({ qa: [{ q: '问', a: '答', at: '2026-10-11T04:00:00.000Z' }] });
    expect(errs(withQa).join('\n')).toContain('不得有 qa[]');
    expect(errs(withQa).join('\n')).toContain('migrate items');
    const richOnly = project({ items: undefined, detail: '<p>整块富文本</p>', detailMode: 'rich' });
    expect(errs(richOnly)).toEqual([]);
    const badMode = project({ items: undefined, detail: '<p>x</p>', detailMode: 'html' });
    expect(errs(badMode).join('\n')).toContain('detailMode 的唯一合法取值是');
  });

  it('条目 id 必须**全项目唯一**（supersededBy / links[].item 只带条目 id）—— 跨节点撞号判红', () => {
    const p = project();
    const dupId = p.data.children[0].items[0].id;
    p.data.children[0].children = [{
      id: 'y', topic: 'Y', items: [{ id: dupId, type: 'text', html: '<p>另一条</p>' }],
      detail: '<p>另一条</p>', children: []
    }];
    const msg = errs(p).join('\n');
    expect(msg).toContain('重复条目 id: ' + dupId);
    expect(msg).toContain('[y]');                        // 点名**后来那个**节点，并说明先出现在哪
    expect(msg).toContain('全项目唯一');
  });

  it('items 不是数组 ⇒ 红（形状问题不静默放过）', () => {
    const p = project({ items: { a: 1 } });
    expect(errs(p).join('\n')).toContain('items 必须是数组');
  });

  it('v2 老数据（无 items / 无 detailMode）行为与从前**完全一致**：不因条目层改动而变红', () => {
    const v2 = {
      meta: { name: 't', formatVersion: 2 }, format: 'node_tree',
      data: {
        id: 'root', topic: 'R', detail: '<ul><li>老数据</li></ul>',
        children: [{ id: 'x', topic: 'X', detail: '<p>老数据 2</p>', qa: [{ q: '问', a: '答', at: 'x' }], children: [] }]
      }
    };
    expect(errs(v2)).toEqual([]);
  });

  it('混合合法：同项目里有的节点条目化、有的没有（迁移可分批的前提，契约 §2）', () => {
    const p = project();
    p.data.children.push({ id: 'v2node', topic: '仍然是 v2', detail: '<ul><li>还没迁</li></ul>', children: [] });
    expect(errs(p)).toEqual([]);
  });
});

/* ============================================================================
 * D. 并发粒度（契约 §8）—— 三个新指纹键的判据
 * ========================================================================== */
describe('S1-D 并发粒度（契约 §8）：条目升为独立指纹键', () => {
  const DETAIL = '<p>甲</p>\n<p>乙</p>';
  /** 一个条目化节点 x（两条条目），外加一个**未条目化**的节点 z */
  const base = () => {
    const items = M.parseDetail(DETAIL, { at: '2026-10-11T04:00:00.000Z', by: 'cli:migrate' });
    return {
      meta: { name: 't', formatVersion: 3 }, format: 'node_tree',
      data: {
        id: 'root', topic: 'R', children: [
          { id: 'x', topic: 'X', items: items, detail: M.renderDetail(items), children: [] },
          { id: 'z', topic: 'Z', detail: '<p>老样子</p>', children: [] }
        ]
      }
    };
  };
  /** 改某条条目的正文，并把派生缓存重渲染成"正确的那一份"（与写命令的后置条件一致） */
  const editItem = (p, idxOrId, html) => {
    const node = p.data.children[0];
    const it = (typeof idxOrId === 'number')
      ? node.items[idxOrId] : node.items.filter((x) => x.id === idxOrId)[0];
    it.html = html;
    node.detail = M.renderDetail(node.items);
    return p;
  };
  const keys = (a, b) => Array.from(cc.changedKeys(a, b));

  it('改**不同条目** ⇒ 改动键不相交（这就是"两个会话同时补条目"能自动合并的全部理由）', () => {
    const b = base();
    const i0 = b.data.children[0].items[0].id, i1 = b.data.children[0].items[1].id;
    const mine = editItem(cc.clone(b), 0, '<p>甲-我改</p>');
    const theirs = editItem(cc.clone(b), i1, '<p>乙-对方改</p>');
    expect(keys(b, mine)).toEqual(['item:x#' + i0]);          // 只脏那一条（detail 被排除、items 顺序没变）
    expect(keys(b, theirs)).toEqual(['item:x#' + i1]);
    expect(cc.intersection(cc.changedKeys(b, mine), cc.changedKeys(b, theirs))).toEqual([]);
  });

  it('改**同一条** ⇒ 相交，且 `describeKeys` 报得出**可读名**（节点 topic + 条目 id + 一小段正文）', () => {
    const b = base();
    const i0 = b.data.children[0].items[0].id;
    const mine = editItem(cc.clone(b), 0, '<p>甲-我改</p>');
    const theirs = editItem(cc.clone(b), 0, '<p>甲-对方改</p>');
    const inter = cc.intersection(cc.changedKeys(b, mine), cc.changedKeys(b, theirs));
    expect(inter).toEqual(['item:x#' + i0]);
    const names = cc.describeKeys(theirs, inter).join(' ');
    expect(names).toContain('节点「X」');                       // 不是裸键
    expect(names).toContain(i0);
  });

  it('条目**顺序**算改动（`items:` 键）：重排 ⇒ 只脏顺序键（单条内容一个都没动）', () => {
    const b = base();
    const mine = cc.clone(b);
    const node = mine.data.children[0];
    node.items = [node.items[1], node.items[0]];
    node.detail = M.renderDetail(node.items);
    expect(keys(b, mine)).toEqual(['items:x']);
    expect(cc.describeKeys(mine, ['items:x']).join(' ')).toContain('条目顺序');
  });

  it('`item-move` **可见**：条目 id 进键时带上节点 id（旧键消失 + 新键出现）', () => {
    const b = base();
    const moved = cc.clone(b);
    const node = moved.data.children[0];
    const it = node.items.splice(0, 1)[0];
    node.detail = M.renderDetail(node.items);
    moved.data.children[1].items = [it];
    moved.data.children[1].detail = M.renderDetail([it]);
    const k = keys(b, moved);
    expect(k).toContain('items:x');
    expect(k).toContain('item:x#' + it.id);                    // 源键消失也算改动
    expect(k).toContain('item:z#' + it.id);                    // 目标键出现 —— 只用条目 id 的话这里什么都看不到
  });

  it('非条目化节点照旧：改 detail ⇒ 只脏 `node:`（v2 语义一个字节都没变）', () => {
    const b = base();
    const mine = cc.clone(b);
    mine.data.children[1].detail = '<p>改过</p>';
    expect(keys(b, mine)).toEqual(['node:z']);
  });

  it('条目化节点上改**非条目字段**（topic）⇒ 仍只脏 `node:`（detail/items 不掺进来）', () => {
    const b = base();
    const mine = cc.clone(b);
    mine.data.children[0].topic = 'X-改名';
    expect(keys(b, mine)).toEqual(['node:x']);
  });

  it('flattenProject 摊平出"按节点取条目表（id → 条目）"与有序 id 表', () => {
    const F = cc.flattenProject(base());
    expect(Array.from(F.items.get('x').keys())).toEqual(F.itemIds.get('x'));
    expect(F.itemIds.has('z')).toBe(false);                    // 未条目化的节点没有条目表
    expect(F.itemIds.get('x').length).toBe(2);
  });

  it('mergeTrees 逐条目挑来源：我改 i1、对方改 i2 ⇒ 两条都在，且 detail 被**当场重建**', () => {
    const b = base();
    const i0 = b.data.children[0].items[0].id, i1 = b.data.children[0].items[1].id;
    const mine = editItem(cc.clone(b), 0, '<p>甲-我改</p>');
    const theirs = editItem(cc.clone(b), 1, '<p>乙-对方改</p>');
    const r = cc.mergeTrees(b, mine, theirs);
    expect(r.ok).toBe(true);
    const node = r.data.data.children[0];
    expect(node.items.map((x) => x.id)).toEqual([i0, i1]);
    expect(node.items.map((x) => x.html)).toEqual(['<p>甲-我改</p>', '<p>乙-对方改</p>']);
    expect(node.detail).toBe(M.renderDetail(node.items));      // 派生缓存是重建出来的，不是谁的旧值
  });

  it('mergeTrees 丢弃**两侧**的 detail：items 没变而 detail 是坏的 ⇒ 合并结果不算它赢', () => {
    const b = base();
    const mine = cc.clone(b);
    mine.data.children[0].detail = '<p>被写坏的派生缓存</p>';   // items 没动 ⇒ 指纹上看不出（detail 被排除）
    const theirs = cc.clone(b);
    const r = cc.mergeTrees(b, mine, theirs, { onConflict: 'theirs' });
    expect(r.ok).toBe(true);
    const node = r.data.data.children[0];
    expect(node.detail).not.toBe('<p>被写坏的派生缓存</p>');
    expect(node.detail).toBe(M.renderDetail(node.items));      // 只有重建这一种结局
  });

  it('mergeTrees 撞同一条 ⇒ 指名拒绝，报文里出现那条的可读名（不产生数据）', () => {
    const b = base();
    const i0 = b.data.children[0].items[0].id;
    const mine = editItem(cc.clone(b), 0, '<p>甲-界面</p>');
    const theirs = editItem(cc.clone(b), 0, '<p>甲-AI</p>');
    const r = cc.mergeTrees(b, mine, theirs);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(['item:x#' + i0]);
    const msg = r.detail.join(' ');
    expect(msg).toContain('节点「X」');
    expect(msg).toContain(i0);
  });

  it('合并条目化节点需要 renderDetail：没有它 ⇒ **响亮拒绝**（绝不静默写一份不一致的 detail）', () => {
    const b = base();
    const mine = editItem(cc.clone(b), 0, '<p>甲-我改</p>');
    const theirs = editItem(cc.clone(b), 1, '<p>乙-对方改</p>');
    const ccPath = require.resolve('../src/concurrency.js');
    const imPath = require.resolve('../src/item-model.js');
    const imReal = require.cache[imPath].exports;
    try {
      require.cache[imPath].exports = {};         // 模拟"浏览器侧没加载 src/item-model.js"
      delete require.cache[ccPath];
      const ccNoRenderer = require(ccPath);
      expect(() => ccNoRenderer.mergeTrees(b, mine, theirs)).toThrow(/renderDetail/);
    } finally {
      require.cache[imPath].exports = imReal;
      delete require.cache[ccPath];
      require(ccPath);                            // 还原模块缓存（后续用例用的是原来那份）
    }
  });

  it('describeKeys：两个新分支都翻成人话（`items:` / `item:`），未知键原样返回', () => {
    const d = describeAll(cc.describeKeys(base(), ['items:x', 'item:x#i-不存在', 'node:zzz', 'meta']));
    expect(d).toContain('节点「X」的条目顺序');
    expect(d).toContain('节点「X」的条目「i-不存在」');            // 条目不在（并发删了）也报得出节点
    expect(d).toContain('meta');
  });

  function describeAll(list) { return list.join(' | '); }
});
