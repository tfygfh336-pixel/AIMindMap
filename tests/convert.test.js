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

/* ============================================================
 * 代码区里的 `*` 不许被强调解析吃掉（2026-10-20 根治，`src/convert.js` 的 `inline()`）
 * ------------------------------------------------------------
 * 病因（宿主原话）：`inline()` 以前是**顺序裸跑** —— 反引号先变成 `<code>…</code>`，`*` → `<em>`
 * 的替换**随后**在整行上按"两个星号配一对"扫，**不认识 code 边界** ⇒ 同一行的两个 `*`
 * （通配符 / C 指针星号 / 乘号）跨 code 区配对，把 `<code>` 劈成两半：
 *    · `src/*.js` × 2  ⇒ `<code>src/<em>.js</code>` + `<code>lib/</em>.js</code>`
 *    · `siginfo_t*, void*` ⇒ `siginfo_t<em>, void</em>` —— **`siginfo_t*` 少了 `*` 就不是那个类型**
 * 修法：代码区先**占位保护**、跑完强调再**还原**（不是"遇到 `<code>` 就跳过"的正则）。
 *
 * 本块两组用例，职责相反、缺一不可：
 *   ① 反证组 —— **合法正文强调的渲染结果一个字节都不许变**（精确等值，不是 `toContain`）；
 *   ② 目标组 —— 代码区里的 `*` / `**` 原样保留，且绝不再出现"强调标签跑进 `<code>`"的形状。
 * 判别力：把 `inline()` 里的 `stashCode`/`restoreCode` 去掉 ⇒ ②组**全红**（实测见
 * `.review/20261020-markdown-star-rootfix/proof/`）。
 * ============================================================ */

describe('代码区占位保护：`*` 不被强调解析吃掉', () => {
  /* —— ① 反证组：正文强调**逐字**不变（改前改后必须完全相同） —— */

  it('反证：正文加粗 / 斜体 / 行内代码 的渲染逐字不变', () => {
    expect(markdownToHtml('正文 **粗体** 结束')).toBe('<p>正文 <strong>粗体</strong> 结束</p>');
    expect(markdownToHtml('正文 *斜体* 结束')).toBe('<p>正文 <em>斜体</em> 结束</p>');
    expect(markdownToHtml('正文 `code` 结束')).toBe('<p>正文 <code>code</code> 结束</p>');
    expect(markdownToHtml('**粗体** 与 *斜体* 和 `code` 混排'))
      .toBe('<p><strong>粗体</strong> 与 <em>斜体</em> 和 <code>code</code> 混排</p>');
  });

  it('反证：强调跨过一段行内代码仍然成立（占位符不挡合法的跨段强调）', () => {
    expect(markdownToHtml('**粗 `x` 体**')).toBe('<p><strong>粗 <code>x</code> 体</strong></p>');
    expect(markdownToHtml('[x `y`](https://e.com)')).toBe('<p><a href="https://e.com">x <code>y</code></a></p>');
  });

  it('反证：标题 / 列表 / 表格里的正文强调不变', () => {
    expect(markdownToHtml('## 标题 **加粗**')).toBe('<h2>标题 <strong>加粗</strong></h2>');
    expect(markdownToHtml('- 列表 *斜体*')).toBe('<ul><li>列表 <em>斜体</em></li></ul>');
    expect(markdownToHtml('| 表头 | b |\n| --- | --- |\n| **粗** | *斜* |'))
      .toBe('<table><tr><th>表头</th><th>b</th></tr><tr><td><strong>粗</strong></td><td><em>斜</em></td></tr></table>');
  });

  /* —— ② 目标组：代码区里的 `*` 原样保留 —— */

  it('目标：`src/*.js` 与 `lib/*.js` 各在自己的 code 里，不许跨段配对', () => {
    expect(markdownToHtml('`src/*.js` 与 `lib/*.js`'))
      .toBe('<p><code>src/*.js</code> 与 <code>lib/*.js</code></p>');
    expect(markdownToHtml('`src/*.js` 与 `lib/*.js`')).not.toContain('<em>');
  });

  it('目标：`siginfo_t*, void*` 一个 `*` 都不许少（少了就不是那个类型）', () => {
    expect(markdownToHtml('`handler(int, siginfo_t*, void*)`'))
      .toBe('<p><code>handler(int, siginfo_t*, void*)</code></p>');
    expect(markdownToHtml('`linux-netfilter-tc-*` 与 `qos-*`'))
      .toBe('<p><code>linux-netfilter-tc-*</code> 与 <code>qos-*</code></p>');
  });

  it('目标：代码里的 `**…**` / `*x*` 是字面量，不许变成 <strong> / <em>', () => {
    expect(markdownToHtml('`a*b*c`')).toBe('<p><code>a*b*c</code></p>');
    expect(markdownToHtml('`**不加粗**`')).toBe('<p><code>**不加粗**</code></p>');
  });

  it('目标：Markdown 里混写的字面 `<code>`/`<pre>` 区同样受保护（它已被转义成字面文本）', () => {
    expect(markdownToHtml('<code>handler(int, siginfo_t*, void*)</code>'))
      .toBe('<p>&lt;code&gt;handler(int, siginfo_t*, void*)&lt;/code&gt;</p>');
  });

  it('目标：标题 / 列表里的代码区同样不被吃（`inline()` 是唯一实现处）', () => {
    expect(markdownToHtml('## 标题 `src/*.js` 与 `lib/*.js`'))
      .toBe('<h2>标题 <code>src/*.js</code> 与 <code>lib/*.js</code></h2>');
    expect(markdownToHtml('- 列表 `src/*.js` 与 `lib/*.js`'))
      .toBe('<ul><li>列表 <code>src/*.js</code> 与 <code>lib/*.js</code></li></ul>');
  });

  it('目标：围栏代码块里的 `*` 一直是对的（回归钉子，别在改 `inline()` 时碰坏它）', () => {
    expect(markdownToHtml('```\nRADIO_* / siginfo_t* / src/*.js\n```'))
      .toBe('<pre><code>RADIO_* / siginfo_t* / src/*.js</code></pre>');
  });

  /* —— ③ 占位符自身的两条硬性质：不可能冲突 / 产物确定性 —— */

  it('占位符不可能与正文冲突：正文里真的出现哨兵字符时也不串（哨兵自动撑长）', () => {
    const sentinelish = 'A\u0001MM\u0002B';
    const html = markdownToHtml(sentinelish + ' `src/*.js` 与 `lib/*.js`');
    expect(html).toContain('<code>src/*.js</code> 与 <code>lib/*.js</code>');
    expect(html).toContain(sentinelish);                 // 正文原样，没被当成占位符吃掉
    expect(html.replace(sentinelish, '')).not.toMatch(/[\u0001\u0002]/);   // 除了正文自带的那一处，不泄漏哨兵
  });

  it('产物确定性：同一份输入连跑两次逐字节相同（占位符不许用随机数）', () => {
    const md = '## 小节 `src/*.js`\n\n正文 **粗** 与 `RADIO_*` 以及 `lib/*.js`\n\n- 项 `a*b`\n- 项 **b**';
    expect(markdownToHtml(md)).toBe(markdownToHtml(md));
    expect(markdownToHtml(md)).not.toMatch(/[\u0001\u0002]/);
  });
});
