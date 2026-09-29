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

/* ------------------------------------------------------------
 * 围栏代码块必须**整段原样**进 detail（不能当结构解析）
 *
 * 真实事故（2026-09-29，导入 day3/day4 的笔记与案例程序时暴露）：
 *   `markdownToTree` 原先在**每个空行**都 flushSeg ⇒ 跨空行的围栏被切成多段、
 *   各段独立送进 markdownToHtml ⇒ 只有第一段在 <pre><code> 里，其余变成 <p>/<li>；
 *   缩进被 trim 掉，` * 中文注释` 变成列表项，`# 终端 A：…` 这种 shell 注释
 *   **被当成标题新建了 8 个假节点**。
 *   量化：day4 那篇笔记 47 个代码块里只有 8 个完整；Makefile 源 7 行 → detail 只剩 1 行。
 *   属"静默损坏"类（不报错，只是内容悄悄变质），比抛异常危险得多。
 * 这组断言把三种形态钉死：空行、井号注释行、列表/强调符号。
 * ------------------------------------------------------------ */
describe('markdown · 围栏代码块不被当结构解析（回归）', () => {
  const F = '```';
  const code = [
    '#include <stdio.h>',
    '',                        // ← 空行：旧实现在这里切断围栏
    '/* 说明',
    ' * 这一行以「空格+星号」开头（Markdown 会当列表项）',
    ' */',
    'int main(void) {',
    '    printf("hi");',       // ← 4 空格缩进：旧实现被 trim 掉
    '',                        // ← 第二个空行
    '    return 0;',
    '}'
  ];
  const md = ['# demo.c', '', F + 'c'].concat(code, [F, '', '结尾正文']).join('\n');

  it('空行不切断围栏：整段代码只进一个节点的 detail，且逐字符保留', () => {
    const r = markdownToTree(md, 'root');
    const topics = [];
    (function w(n) { if (!n) return; if (n.topic) topics.push(n.topic); (n.children || []).forEach(w); })(r.data);
    expect(topics).toEqual(['demo.c']);                    // 只生成 1 个节点（旧实现会多出节点）
    const node = r.data.children[0];
    expect(node.detail).toContain('#include &lt;stdio.h&gt;');
    expect(node.detail).toContain('\n\n/* 说明');           // 空行保留
    expect(node.detail).toContain('    printf(&quot;hi&quot;);');  // 缩进保留
    expect(node.detail).toContain(' * 这一行以「空格+星号」开头');
    expect(node.detail).not.toContain('<li>');              // 「 * 」没被当列表
    expect(node.detail).not.toContain('<em>');              // 没被当强调
    expect(node.detail).toContain('<pre><code>');
  });

  it('围栏内以「# 」（井号+空格）开头的行**不能**变成节点标题', () => {
    const bash = ['#!/bin/bash', '', '# 终端 A：启动服务', 'echo start', '', '# 终端 B：连接', 'echo connect'];
    const m = ['# 导言', '', F + 'bash'].concat(bash, [F, '']).join('\n');
    const r = markdownToTree(m, 'root');
    const topics = [];
    (function w(n) { if (!n) return; if (n.topic) topics.push(n.topic); (n.children || []).forEach(w); })(r.data);
    expect(topics).toEqual(['导言']);                       // 旧实现会多出「终端 A：启动服务」等假节点
    const root = r.data.children[0];
    expect(root.detail).toContain('# 终端 A：启动服务');
    expect(root.detail).toContain('# 终端 B：连接');
    expect(root.detail).not.toContain('<pre><code></code></pre>');   // 不留空壳代码块
  });

  it('未闭合的围栏也不丢内容（EOF 时整段收进 detail）', () => {
    const m = ['# x', '', F, 'line-1', '', 'line-2'].join('\n');
    const r = markdownToTree(m, 'root');
    const node = r.data.children[0];
    expect(node.detail).toContain('line-1');
    expect(node.detail).toContain('line-2');
  });
});
