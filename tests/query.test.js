/* ============================================================
 * tests/query.test.js — 查询/视图纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * 这些函数决定「AI 看到什么」（read --json 的形状、search 命中、stats 计数），
 * 原先埋在 cli/commands/project.js 里，只能靠端到端断言间接覆盖。
 * 下沉到 src/query.js 后可在此直接锁住**对外契约**。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import query from '../src/query.js';

const ROOT = () => ({
  id: 'root', topic: '根', expanded: true, detail: '<p>根的内容</p>',
  tags: ['a'],
  children: [
    {
      id: 'c1', topic: '子一', expanded: false,
      detail: '<p>提到 交换机 与 <b>协议</b></p>',
      tags: ['net', 'a'],
      images: [{ file: 'assets/1.png', caption: '图一' }],
      files: [{ file: 'attachments/x.md', caption: '附件' }],
      links: [{ project: 'p', id: 'root', caption: '回根' }],
      children: [{ id: 'c1a', topic: '孙', children: [] }]
    },
    { id: 'c2', topic: '子二', children: [] }
  ]
});
const wrap = (root) => ({ meta: { name: 'n', version: '1' }, data: root });

describe('query.buildReadView', () => {
  it('默认含 detail / images / files，且 depth 从 0 起', () => {
    const v = query.buildReadView(wrap(ROOT()), {});
    expect(v.nodeCount).toBe(4);
    const c1 = v.nodes.find((n) => n.id === 'c1');
    expect(c1.depth).toBe(1);
    expect(v.nodes[0].depth).toBe(0);
    expect(c1.detail).toContain('交换机');
    expect(c1.images).toHaveLength(1);
    expect(c1.files).toHaveLength(1);
    expect(Array.isArray(v.images)).toBe(true);          // 顶层资源清单
  });

  it('brief 模式省略长文本与资源，并带 brief 标记', () => {
    const v = query.buildReadView(wrap(ROOT()), { brief: true });
    expect(v.brief).toBe(true);
    v.nodes.forEach((n) => {
      expect(n.detail).toBeUndefined();
      expect(n.images).toBeUndefined();
      expect(n.files).toBeUndefined();
    });
    expect(v.images).toBeUndefined();
    // 结构信息仍保留
    const c1 = v.nodes.find((n) => n.id === 'c1');
    expect(c1.topic).toBe('子一');
    expect(c1.tags).toEqual(['net', 'a']);
    expect(c1.links).toHaveLength(1);
  });

  it('children 保持「浅摘要数组」契约（id/topic/子数），不是数字也不是全量嵌套', () => {
    const v = query.buildReadView(wrap(ROOT()), {});
    const root = v.nodes.find((n) => n.id === 'root');
    expect(Array.isArray(root.children)).toBe(true);
    expect(root.children.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(root.children[0]).toEqual({ id: 'c1', topic: '子一', children: 1 });
  });

  it('detail:false / images:false 可单独关闭（brief 之外的选择）', () => {
    const v = query.buildReadView(wrap(ROOT()), { detail: false, images: false });
    expect(v.nodes.find((n) => n.id === 'c1').detail).toBeUndefined();
    expect(v.nodes.find((n) => n.id === 'c1').files).toBeUndefined();
    expect(v.images).toBeUndefined();
    expect(v.brief).toBeUndefined();
  });

  it('空 detail / 空数组字段不产生噪音键', () => {
    const v = query.buildReadView(wrap(ROOT()), {});
    const c2 = v.nodes.find((n) => n.id === 'c2');
    expect('detail' in c2).toBe(true);        // 键在但值为 undefined（保持历史形状）
    expect(c2.detail).toBeUndefined();
    expect(c2.tags).toBeUndefined();
    expect(c2.images).toBeUndefined();
  });
});

describe('query.collectImages', () => {
  it('扁平收集全部图片并标注所属节点', () => {
    const imgs = query.collectImages(ROOT());
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ node: 'c1', topic: '子一', file: 'assets/1.png', caption: '图一' });
  });
});

describe('query.buildNodeList', () => {
  it('扁平节点表含 childCount 与 0 起 depth', () => {
    const nodes = query.buildNodeList(ROOT());
    expect(nodes.map((n) => n.id)).toEqual(['root', 'c1', 'c1a', 'c2']);
    expect(nodes.find((n) => n.id === 'c1').childCount).toBe(1);
    expect(nodes.find((n) => n.id === 'c1').depth).toBe(1);
    expect(nodes[0].expanded).toBe(true);
    expect(nodes.find((n) => n.id === 'c1').expanded).toBe(false);
  });
});

describe('query.getNodeView', () => {
  it('返回真实层级路径（不是 DFS 访问序列）', () => {
    const v = query.getNodeView(ROOT(), 'c1a', {});
    expect(v.path).toEqual(['root', 'c1', 'c1a']);
    expect(v.id).toBe('c1a');
  });

  it('默认不带 detail，显式要求才带', () => {
    expect(query.getNodeView(ROOT(), 'c1', {}).detail).toBeUndefined();
    expect(query.getNodeView(ROOT(), 'c1', { detail: true }).detail).toContain('交换机');
  });

  it('找不到返回 null（由命令层决定报错方式）', () => {
    expect(query.getNodeView(ROOT(), 'nope', {})).toBeNull();
  });

  it('带 tags / files / links', () => {
    const v = query.getNodeView(ROOT(), 'c1', {});
    expect(v.tags).toEqual(['net', 'a']);
    expect(v.files).toHaveLength(1);
    expect(v.links).toHaveLength(1);
  });
});

describe('query.computeStats', () => {
  it('统计节点/深度/资源/标签', () => {
    const s = query.computeStats(ROOT());
    expect(s.nodes).toBe(4);
    expect(s.maxDepth).toBe(3);            // tree.walk 的 depth 从 1 起
    expect(s.images).toBe(1);
    expect(s.files).toBe(1);
    expect(s.links).toBe(1);
    expect(s.detailedNodes).toBe(2);       // root 与 c1 有 detail
    expect(s.taggedNodes).toBe(2);
    expect(s.tags).toBe(2);                // 'a' 去重 + 'net'
  });

  it('空树安全（不抛异常，深度为 0）', () => {
    const s = query.computeStats({ id: 'r', topic: 't' });
    expect(s.nodes).toBe(1);
    expect(s.maxDepth).toBe(1);
  });
});

describe('query.searchNodes', () => {
  it('默认只匹配 topic', () => {
    const r = query.searchNodes(ROOT(), { keyword: '子' });
    expect(r.hits.map((h) => h.id).sort()).toEqual(['c1', 'c2']);
    expect(r.hits[0].matchIn).toBe('topic');
  });

  it('full 模式额外匹配 detail 正文', () => {
    const r = query.searchNodes(ROOT(), { keyword: '交换机', full: true });
    expect(r.hits.map((h) => h.id)).toEqual(['c1']);
    expect(r.hits[0].matchIn).toBe('detail');
    expect(r.hits[0].snippet).toContain('交换机');
  });

  it('detail 匹配是「剥标签后」的纯文本（能跨标签命中）', () => {
    // 正文是 "提到 交换机 与 <b>协议</b>"，若直接对 HTML 匹配，"协议"前有标签
    // 但只要子串仍在就能命中；关键是剥标签后 '交换机 协议' 之间是空格而非标签字符
    const r = query.searchNodes(ROOT(), { keyword: '协议', full: true });
    expect(r.hits.map((h) => h.id)).toEqual(['c1']);
  });

  it('按标签搜索（无关键词）', () => {
    const r = query.searchNodes(ROOT(), { tag: 'net' });
    expect(r.hits.map((h) => h.id)).toEqual(['c1']);
    expect(r.hits[0].matchIn).toBe('tag');
  });

  it('标签与关键词可组合（同时满足）', () => {
    const r = query.searchNodes(ROOT(), { keyword: '子一', tag: 'net' });
    expect(r.hits.map((h) => h.id)).toEqual(['c1']);
    const r2 = query.searchNodes(ROOT(), { keyword: '子二', tag: 'net' });
    expect(r2.hits).toEqual([]);
  });

  it('full 模式匹配图片 caption / 标签 / 链接说明', () => {
    expect(query.searchNodes(ROOT(), { keyword: '图一', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT(), { keyword: 'net', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
    expect(query.searchNodes(ROOT(), { keyword: '回根', full: true }).hits.map((h) => h.id)).toEqual(['c1']);
  });

  it('无命中返回空数组', () => {
    expect(query.searchNodes(ROOT(), { keyword: '不存在的东西' }).hits).toEqual([]);
  });
});

describe('query.treeLines', () => {
  it('按缩进生成树形文本，带展开标记与图片计数', () => {
    const lines = query.treeLines(ROOT());
    expect(lines[0]).toBe('▾ root  根');            // 根节点缩进为 0
    expect(lines[1]).toBe('  ▸ c1  子一  [1图]');   // c1 是 expanded:false
    expect(lines[2]).toBe('    ▾ c1a  孙');
    expect(lines[3]).toBe('  ▾ c2  子二');
  });

  it('expanded:false 的节点用 ▸ 标记', () => {
    const lines = query.treeLines(ROOT());
    expect(lines.find((l) => l.indexOf('c1  ') >= 0)).toContain('▸ c1');
  });
});

/* ============================================================
 * `--skeleton` 档 —— 比 `--brief` 更窄，填的是"有嵌套但只有结构"这个空档
 * ------------------------------------------------------------
 * 为什么会缺这一档：`--brief` 保留 tags/links（导航信息），而 `list --json` 是**扁平**的
 * （没有 children 嵌套）。实测（187 节点的 comnet）：`--brief --compact` 43,964 B →
 * `--skeleton --compact` **29,640 B**（再省 32.6%），且 children 仍在。
 * ============================================================ */
describe('buildReadView 的 --skeleton 档', () => {
  const mk = (o) => query.buildReadView({ meta: {}, data: ROOT() }, o);

  it('连 tags / links / detail / images 都省掉', () => {
    const v = mk({ skeleton: true });
    expect(v.skeleton).toBe(true);
    expect(v.nodes.some((n) => n.tags !== undefined)).toBe(false);
    expect(v.nodes.some((n) => n.links !== undefined)).toBe(false);
    expect(v.nodes.some((n) => n.detail !== undefined)).toBe(false);
    expect(v.nodes.some((n) => n.images !== undefined)).toBe(false);
    expect(v.images).toBeUndefined();          // 顶层资源清单同样省掉
  });

  it('**标记互斥**：skeleton 时不再声称 brief（否则消费者会以为 tags 只是恰好为空）', () => {
    expect(mk({ skeleton: true }).brief).toBeUndefined();
  });

  it('**保留 children 嵌套** —— 这正是它相对 list --json（扁平）的差别', () => {
    const v = mk({ skeleton: true });
    expect(Array.isArray(v.nodes[0].children)).toBe(true);
    expect(v.nodeCount).toBeGreaterThan(0);
  });

  it('确实比 --brief 更小（收益来自 tags + links）', () => {
    expect(JSON.stringify(mk({ skeleton: true })).length)
      .toBeLessThan(JSON.stringify(mk({ brief: true })).length);
  });
});

/* ============================================================
 * 子树视图 —— `read --subtree <id> --json` 依赖的契约
 * ------------------------------------------------------------
 * 实现上并没有新函数：`cli/commands/project.js` 把找到的节点当成根，
 * 直接喂给 `buildReadView`。所以这里锁的是"**喂一棵子树进去，视图仍然自洽**"：
 * depth 必须从这个子树的根重新从 0 起（而不是继承它在全树里的深度），
 * nodeCount 必须只数子树。契约若被改坏，`--subtree` 会静默给出错误层级。
 * ============================================================ */
describe('buildReadView 喂子树（read --subtree 的契约）', () => {
  const subView = () => {
    const full = ROOT();
    const c1 = full.children.find((n) => n.id === 'c1');
    return query.buildReadView({ meta: { name: 'x' }, data: c1 }, {});
  };

  it('depth 从这里的新根重新从 0 起（不继承全树里的深度）', () => {
    const v = subView();
    expect(v.nodes[0].id).toBe('c1');
    expect(v.nodes[0].depth).toBe(0);           // 全树里它是 1
    expect(v.nodes[1].depth).toBe(1);           // c1a：全树里是 2
  });

  it('nodeCount 只数子树，不是全树', () => {
    // 注意：buildReadView 收的是**项目对象**（{meta, data}），不是裸节点 —— 少包一层就会数出 0
    const full = query.buildReadView({ meta: {}, data: ROOT() }, {});
    const v = subView();
    expect(full.nodeCount).toBeGreaterThan(v.nodeCount);
    expect(v.nodeCount).toBe(v.nodes.length);
  });

  it('meta 仍然带出来（子树视图仍要能自报是哪个项目）', () => {
    expect(subView().meta).toEqual({ name: 'x' });
  });
});

/* ------------------------------------------------------------
 * localPath 必须**可见**：字段存下来但读视图不带，等于功能只做了一半 ——
 * AI 永远看不见"这个节点对应哪个真目录"，也就没法据此去读源文件。
 * 三档口径与 tags/links 一致：完整 / brief 带，skeleton（最窄那档）省。
 * ------------------------------------------------------------ */
describe('query · localPath 的读视图暴露', () => {
  const withLP = () => ({
    meta: { name: 'x' },
    data: {
      id: 'root', topic: '根',
      children: [{ id: 'a', topic: 'A', localPath: 'E:\\markdown\\M1', children: [] }]
    }
  });

  it('get 的节点视图带 localPath', () => {
    const v = query.getNodeView(withLP().data, 'a', {});
    expect(v.localPath).toBe('E:\\markdown\\M1');
  });

  it('read 的完整视图与 brief 都带', () => {
    const full = query.buildReadView(withLP(), {});
    const brief = query.buildReadView(withLP(), { brief: true });
    expect(full.nodes.find((n) => n.id === 'a').localPath).toBe('E:\\markdown\\M1');
    expect(brief.nodes.find((n) => n.id === 'a').localPath).toBe('E:\\markdown\\M1');
  });

  it('skeleton（最窄档）省掉它 —— 与 tags/links 同档', () => {
    const sk = query.buildReadView(withLP(), { skeleton: true });
    expect(sk.nodes.find((n) => n.id === 'a').localPath).toBeUndefined();
  });

  it('没有这个字段时不产生噪音键', () => {
    const v = query.getNodeView(withLP().data, 'root', {});
    expect('localPath' in v).toBe(false);
  });
});

/* ------------------------------------------------------------
 * origin（来源指纹，见 docs/DATA-FORMAT.md §2.8）的读视图暴露
 *
 * 它要能回答两件事，缺一件这条字段就白加了：
 *   ① "这个节点是从哪份文档导进来的" —— `get --json` 必须**总是**带（幂等判定的输入）；
 *   ② "这个项目里有多少内容是从文件导进来的" —— `stats` 要报得出数（排查用）。
 * 三档口径与 qa 一致：完整 / brief 带，skeleton（最窄那档）省。
 * ------------------------------------------------------------ */
describe('query · origin 的读视图暴露与统计', () => {
  const ORG = { kind: 'import', src: 'docs/a.md', sha256: 'a'.repeat(64), at: 'T', tool: 'import-md' };
  const ORG2 = { kind: 'import', src: 'docs/b.md', sha256: 'b'.repeat(64), at: 'T', tool: 'import-project' };
  const withOrigin = () => ({
    meta: { name: 'x' },
    data: {
      id: 'root', topic: '根', origin: ORG,
      children: [
        { id: 'a', topic: 'A', origin: ORG2, children: [] },
        { id: 'b', topic: 'B', children: [] }          // 无 origin：手写的节点
      ]
    }
  });

  it('get 的节点视图带 origin（**不带 --detail 也带** —— 幂等判定就靠它）', () => {
    const v = query.getNodeView(withOrigin().data, 'a', {});
    expect(v.origin).toEqual(ORG2);
  });

  it('read 的完整视图与 brief 都带；skeleton（最窄档）省掉', () => {
    const full = query.buildReadView(withOrigin(), {});
    const brief = query.buildReadView(withOrigin(), { brief: true });
    expect(full.nodes.find((n) => n.id === 'a').origin).toEqual(ORG2);
    expect(brief.nodes.find((n) => n.id === 'a').origin).toEqual(ORG2);
    const sk = query.buildReadView(withOrigin(), { skeleton: true });
    expect(sk.nodes.find((n) => n.id === 'a').origin).toBeUndefined();
  });

  it('没有这个字段时不产生噪音键（旧数据零变化）', () => {
    const v = query.getNodeView(withOrigin().data, 'b', {});
    expect('origin' in v).toBe(false);
  });

  it('stats 报"有多少节点带来源"与"涉及几份不同来源"（同一次导入只算一个来源）', () => {
    const s = query.computeStats(withOrigin().data);
    expect(s.originNodes).toBe(2);      // root + a
    expect(s.originSources).toBe(2);    // docs/a.md 与 docs/b.md 各一份
    // 同一份来源被 --force 导两次 ⇒ 节点数涨、来源数不涨（一眼能看出那是重复导的）
    const twice = {
      meta: { name: 'x' },
      data: { id: 'root', topic: '根', origin: ORG, children: [{ id: 'a', topic: 'A', origin: ORG, children: [] }] }
    };
    const s2 = query.computeStats(twice.data);
    expect(s2.originNodes).toBe(2);
    expect(s2.originSources).toBe(1);
  });

  it('旧数据（一个 origin 都没有）统计仍是 0，不是 undefined（否则门禁里会变成 NaN 比较）', () => {
    const s = query.computeStats({ id: 'root', topic: 'R', children: [] });
    expect(s.originNodes).toBe(0);
    expect(s.originSources).toBe(0);
  });
});
