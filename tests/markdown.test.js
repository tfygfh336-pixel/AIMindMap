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

/* 【W14】第一个标题**之前**的正文不许丢 —— 原实现里 `markdownToTree` 遇到"还没有任何节点"的正文行
 * 直接跳过（`if (!cur) continue`）⇒ **静默丢内容**（待做清单 W14，A 档）。
 * 现在改为按段收进 `preamble` 交回调用方，由调用方落到"本次导入的父/文件节点"的 detail 开头。 */
describe('【W14】第一个标题之前的正文（前导正文）', () => {
  it('有标题时：前导正文进 preamble，且**不**混进任何子节点', () => {
    const r = markdownToTree('前言第一行\n\n前言第二段\n\n# 标题\n正文\n', 'root');
    expect(r.preamble).toContain('前言第一行');
    expect(r.preamble).toContain('前言第二段');
    expect(r.data.children.length).toBe(1);
    expect(r.data.children[0].topic).toBe('标题');
    expect(r.data.children[0].detail || '').not.toContain('前言第一行');
  });

  it('整篇没有标题时：preamble = 全篇正文（调用方的"无标题兜底"仍走自己那条路）', () => {
    const r = markdownToTree('只有一段正文\n\n还有一段\n', 'root');
    expect(r.data.children.length).toBe(0);
    expect(r.preamble).toContain('只有一段正文');
    expect(r.preamble).toContain('还有一段');
  });

  it('前导区里的围栏代码：井号不被当标题，且一行不丢', () => {
    const r = markdownToTree('前言\n\n```\n# 这行的井号是代码，不是标题\n```\n\n# 真标题\n', 'root');
    expect(r.preamble).toContain('前言');
    expect(r.preamble).toContain('# 这行的井号是代码，不是标题');
    expect(r.data.children.length).toBe(1);
    expect(r.data.children[0].topic).toBe('真标题');
  });

  it('没有前导正文时 preamble 是空串（不产生空 detail）', () => {
    const r = markdownToTree('# 只有标题\n正文\n', 'root');
    expect(r.preamble).toBe('');
  });

  it('前导区里的图片/附件引用按**正文**处理（不挂进 images/files）—— 坏引用属 W19 的口径', () => {
    const r = markdownToTree('![图：x](assets/a.png)\n\n# 标题\n', 'root');
    expect(r.preamble).toContain('assets/a.png');
    expect(r.data.children[0].images || []).toEqual([]);
    expect(r.data.children[0].files || []).toEqual([]);
  });
});

/* 【W20】中文标题的 id 唯一性。
 * 根因：`idGen` 把 seed 里非 [a-z0-9] 的字符全部抹掉 ⇒ **中文标题共用同一个 base**（`n`），
 * 只靠短随机后缀区分 ⇒ 标题一多就**概率性撞号**，一撞就"以 id 重复整体导入失败"，而人完全看不出原因。
 * 出口：`markdownToTree(md, parent, genId)` 第三参就是注入点 —— `import-project`/`import-md` 现在
 * 与 `import-dir` 一样接 `uniqueIdGen()`（"见过就再摇一次"），三条路同一处修法。
 * ⚠️ 证据性质说明：**"还原旧实现 ⇒ 必红"对这条不成立**（撞号是概率事件，400 个标题时仍有小概率全不撞），
 * 所以本条的证明走两条路：① **唯一性由构造保证**（接上生成器后必然不重）；② **判别力**（生成器退化成常量 ⇒ 断言必须抓住）。 */
describe('【W20】条目/节点 id 的唯一性（中文标题）', () => {
  it('根因：两个不同的中文标题共用同一个 id base（只差随机后缀）', () => {
    const a = idGen('中文标题甲');
    const b = idGen('中文标题乙');
    expect(a.split('-')[0]).toBe(b.split('-')[0]);   // 同为 'n' ⇒ 这就是撞号的根因
  });

  it('接上"唯一性有保障"的生成器后：200 个中文标题一次建树，**一个都不重**（构造保证，不是概率）', () => {
    const seen = new Set();
    const unique = (seed) => {
      let id = idGen(seed);
      while (seen.has(id)) id = idGen(seed);         // 与 `src/doc-import.js` 的 uniqueIdGen 同一策略
      seen.add(id);
      return id;
    };
    const md = Array.from({ length: 200 }, (_, i) => '# 中文标题' + i).join('\n');
    const r = markdownToTree(md, 'root', unique);
    const ids = r.data.children.map((c) => c.id);
    expect(ids.length).toBe(200);
    expect(new Set(ids).size).toBe(200);             // 一个都不重
  });

  it('判别力：生成器若退化成常量 ⇒ 断言必须抓得住（说明上一条不是空跑）', () => {
    const md = Array.from({ length: 200 }, (_, i) => '# 中文标题' + i).join('\n');
    const dup = markdownToTree(md, 'root', () => 'dup');
    const dupIds = dup.data.children.map((c) => c.id);
    expect(dupIds.length).toBe(200);
    expect(new Set(dupIds).size).toBe(1);            // 全塌成一个 ⇒ 断言确实在看"唯一性"这件事
  });
});
