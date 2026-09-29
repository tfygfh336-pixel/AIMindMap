/* ============================================================
 * tests/markdown.test.js — Markdown ⇄ 节点树 单元测试（vitest）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { markdownToTree, treeToMarkdown, idGen } from '../src/markdown.js';

describe('markdownToTree', () => {
  it('heading 层级 → 节点树', () => {
    const r = markdownToTree('# 一级\n## 二级\n### 三级\n', 'root');
    const top = r.data.children[0];
    expect(top.topic).toBe('一级');
    expect(top.children[0].topic).toBe('二级');
    expect(top.children[0].children[0].topic).toBe('三级');
    expect(r.addedCount).toBe(3);
  });

  it('非标题行并入最近标题的 detail', () => {
    const r = markdownToTree('# 标题\n这是详情第一行\n第二行\n', 'root');
    const n = r.data.children[0];
    expect(n.detail).toContain('这是详情第一行');
    expect(n.detail).toContain('第二行');
  });

  it('跳级用占位节点兜底不损坏结构', () => {
    const r = markdownToTree('### 三级直接出现\n', 'root');
    // 三级标题 → 缺一二级的中间用占位节点
    expect(r.data.children[0].children[0].children[0].topic).toBe('三级直接出现');
  });

  it('idGen 生成合法且唯一 id', () => {
    const a = idGen('TCP 三次握手');
    expect(/^[a-z0-9-]+$/.test(a)).toBe(true);
    expect(idGen('TCP 三次握手')).not.toBe(a);
  });
});

describe('treeToMarkdown', () => {
  const tree = {
    id: 'root', topic: '根', children: [
      { id: 'a', topic: '甲', detail: '<p>甲详情</p>', children: [
        { id: 'b', topic: '乙', children: [] }
      ] }
    ]
  };

  it('heading 格式导出', () => {
    const md = treeToMarkdown(tree, { format: 'heading' });
    expect(md).toContain('# 根');
    expect(md).toContain('## 甲');
    expect(md).toContain('### 乙');
  });

  it('list 格式导出', () => {
    const md = treeToMarkdown(tree, { format: 'list' });
    expect(md).toContain('- 甲');
    expect(md).toContain('- 乙');
  });

  it('withDetail 追加引用块', () => {
    const md = treeToMarkdown(tree, { format: 'heading', withDetail: true });
    expect(md).toContain('> 甲详情');
  });

  it('导出 → 导入 roundtrip 保留层级', () => {
    const md = treeToMarkdown(tree, { format: 'heading' });
    const r = markdownToTree(md, 'root');
    // 导出的根节点(# 根)作为 parent 的直接孩子；层级为 根→甲→乙
    expect(r.data.children[0].topic).toBe('根');
    expect(r.data.children[0].children[0].topic).toBe('甲');
    expect(r.data.children[0].children[0].children[0].topic).toBe('乙');
  });

  it('list 格式导出 → 导入：层级完整还原（缩进 2 空格/级）', () => {
    const md = treeToMarkdown(tree, { format: 'list' });
    expect(md).toContain('- 根');
    const r = markdownToTree(md, 'root');
    expect(r.data.children[0].topic).toBe('根');
    expect(r.data.children[0].children[0].topic).toBe('甲');
    expect(r.data.children[0].children[0].children[0].topic).toBe('乙');
  });

  it('withDetail 导出 → 导入：detail 还原为 HTML（而非字面 "> " 文本）', () => {
    const md = treeToMarkdown(tree, { format: 'heading', withDetail: true });
    const r = markdownToTree(md, 'root');
    const jia = r.data.children[0].children[0];
    expect(jia.topic).toBe('甲');
    expect(jia.detail).toContain('<p>甲详情</p>');
    expect(jia.detail).not.toContain('&gt;');
  });

  it('withDetail 导出 → 导入：表格往返不丢结构', () => {
    const t = {
      id: 'root', topic: '根', children: [
        { id: 'a', topic: '甲', detail: '<h3>对比</h3><table><tr><th>维度</th><th>电路</th></tr><tr><td>资源</td><td>独占</td></tr></table>', children: [] }
      ]
    };
    const md = treeToMarkdown(t, { format: 'heading', withDetail: true });
    const r = markdownToTree(md, 'root');
    const detail = r.data.children[0].children[0].detail;
    expect(detail).toContain('<h3>对比</h3>');
    expect(detail).toContain('<th>维度</th>');
    expect(detail).toContain('<td>独占</td>');
  });

  it('withResources 导出 → 导入：图片与附件回到节点上', () => {
    const t = {
      id: 'root', topic: '根', children: [
        {
          id: 'a', topic: '甲',
          images: [{ file: 'assets/x.png', caption: '示意图' }],
          files: [{ file: 'attachments/d.md', caption: '资料' }],
          children: []
        }
      ]
    };
    const md = treeToMarkdown(t, { format: 'heading', withResources: true });
    const r = markdownToTree(md, 'root');
    const jia = r.data.children[0].children[0];
    expect(jia.images).toEqual([{ file: 'assets/x.png', caption: '示意图' }]);
    expect(jia.files).toEqual([{ file: 'attachments/d.md', caption: '资料' }]);
  });

  it('正文也落成 HTML detail（保证 detail 始终为 HTML）', () => {
    const r = markdownToTree('## 甲\n**加粗**的内容\n', 'root');
    const jia = r.data.children[0].children[0];
    expect(jia.detail).toContain('<strong>加粗</strong>');
  });

  it('list 格式里的 detail 引用块同样能还原', () => {
    const t = { id: 'root', topic: '根', children: [{ id: 'a', topic: '甲', detail: '<p>甲详情</p>', children: [] }] };
    const md = treeToMarkdown(t, { format: 'list', withDetail: true });
    const r = markdownToTree(md, 'root');
    expect(r.data.children[0].children[0].detail).toContain('<p>甲详情</p>');
  });

  it('回归：heading 格式超过 6 层不丢节点（曾产出 #######，导入认不出）', () => {
    // 缺陷：`'#'.repeat(level)` 对第 7 层生成 7 个井号，而 H_RE 只认 1–6 →
    // 该节点被降级成父节点 detail 里的一行字面井号，即**静默丢节点**
    // （实测 8 层树往返后只剩 L1..L6）。
    let node = { id: 'L8', topic: 'L8', children: [] };
    for (let i = 7; i >= 1; i--) node = { id: 'L' + i, topic: 'L' + i, children: [node] };
    const out = treeToMarkdown(node, { format: 'heading' });
    const headings = out.split('\n').filter((l) => /^#{1,6}\s/.test(l));
    expect(headings).toHaveLength(8);                  // 8 层都成为标题行
    expect(out).not.toMatch(/^#{7,}\s/m);              // 不出现 7 个以上井号
    const back = markdownToTree(out, 'root');
    const count = (function c(x) { return 1 + (x.children || []).reduce((a, y) => a + c(y), 0); })(back.data);
    expect(count).toBeGreaterThanOrEqual(8);           // 不再丢 L7/L8
  });
});
