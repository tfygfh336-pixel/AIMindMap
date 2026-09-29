/* ============================================================
 * tests/convert.test.js — HTML ⇄ Markdown 单元测试（vitest）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml, detailToMarkdown, stripHtml } from '../src/convert.js';

describe('convert', () => {
  it('htmlToMarkdown 语义化转换', () => {
    const md = htmlToMarkdown('<h2>标题</h2><p>正文 <strong>加粗</strong> 和 <code>code</code></p><ul><li>项1</li></ul>');
    expect(md).toContain('## 标题');
    expect(md).toContain('**加粗**');
    expect(md).toContain('`code`');
    expect(md).toContain('- 项1');
  });

  it('markdownToHtml 逆转换', () => {
    const html = markdownToHtml('## 标题\n- 项1\n`c` **b**');
    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('<li>项1</li>');
    expect(html).toContain('<code>c</code>');
    expect(html).toContain('<strong>b</strong>');
  });

  it('detailToMarkdown 生成引用块', () => {
    const q = detailToMarkdown('<p>第一行</p><p>第二行</p>');
    expect(q.split('\n').every((l) => l.startsWith('> '))).toBe(true);
  });

  it('表格往返：HTML → GFM → HTML', () => {
    const md = htmlToMarkdown('<table><tr><th>维度</th><th>电路交换</th></tr><tr><td>资源</td><td>独占</td></tr></table>');
    expect(md).toContain('| 维度 | 电路交换 |');
    const html = markdownToHtml(md);
    expect(html).toContain('<th>维度</th>');
    expect(html).toContain('<td>独占</td>');
  });

  it('块级元素不被再包一层 <p>', () => {
    const html = markdownToHtml('## 标题\n正文');
    expect(html).toContain('<h2>标题</h2>');
    expect(html).not.toContain('<p><h2>');
  });

  it('引用块前缀被剥离，不会残留字面 ">"', () => {
    const html = markdownToHtml('> 第一行\n> 第二行');
    expect(html).toContain('<p>第一行</p>');
    expect(html).not.toContain('&gt;');
  });

  it('markdownToHtml 转义裸 HTML（防注入）', () => {
    const html = markdownToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('空输入安全返回空串', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(markdownToHtml(null)).toBe('');
    expect(detailToMarkdown('')).toBe('');
  });

  /* —— --detail-md 依赖的语义契约（存储为 HTML，Markdown 只在输入边界） —— */

  it('markdownToHtml 产出渲染层可直接 innerHTML 的 HTML', () => {
    // 存储格式是 HTML（renderer 用 innerHTML 注入），故 --detail-md 的产物必须是真标签
    const html = markdownToHtml('## 标题\n\n正文 **加粗**\n\n- 项一\n- 项二');
    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('项一');
    expect(html).not.toContain('**');   // 不得残留 Markdown 字面量
    expect(html).not.toContain('##');
  });

  it('markdownToHtml 保留表格（Markdown 表格 → HTML table）', () => {
    const html = markdownToHtml('| 维度 | 电路交换 |\n| --- | --- |\n| 资源 | 独占 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>维度</th>');
    expect(html).toContain('<td>独占</td>');
  });

  it('markdownToHtml 不吞掉 Markdown 里的比较符号与反斜杠文本', () => {
    const html = markdownToHtml('a < b 且 c > d');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
  });

  /* —— stripHtml：全文搜索与「未链接提及」共用，顺序细节必须锁住 —— */

  it('stripHtml 剥标签并把标签位置换成空格（不粘连相邻词）', () => {
    // 若替换为空串，"交换机"与"协议"会粘成"交换机协议"，破坏后续子串匹配边界
    expect(stripHtml('<b>交换机</b>协议')).toBe('交换机 协议');
  });

  it('stripHtml 先剥标签后解实体（顺序反了会丢字面内容）', () => {
    // &lt;b&gt; 是用户真实写下的字面文本，不能被当成标签剥掉
    expect(stripHtml('&lt;b&gt;字面标签&lt;/b&gt;')).toBe('<b>字面标签</b>');
  });

  it('stripHtml 的 &amp; 必须最后解（否则 &amp;lt; 会二次解码）', () => {
    expect(stripHtml('&amp;lt;')).toBe('&lt;');   // 只解一层，结果是字面 "&lt;"
    expect(stripHtml('A &amp; B')).toBe('A & B');
  });

  it('stripHtml 丢弃 script/style 内容并折叠空白', () => {
    expect(stripHtml('<p>前</p><script>var x=1;</script><style>.a{}</style><p>后</p>')).toBe('前 后');
    expect(stripHtml('多   个\n\n空白')).toBe('多 个 空白');
  });

  it('stripHtml 空值安全', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});
