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

/* ============================================================
 * 分隔线（hr）与表格单元格的 `\|` 转义（2026-10-20 根治）
 * ------------------------------------------------------------
 * 两个缺陷都在**同一个函数**：`src/convert.js` 的 `markdownToHtml()`
 * （**唯一实现处**：渲染层 `renderer/app-core.js` 的 `mdBlock` 直接转调它；
 *   `mdInline`/`topicMarkup` 只做加粗与行内代码，**不解析表格、也不解析分隔线**）。
 *   A 没有 hr 分支：`---` 不命中围栏/表格/标题/列表 ⇒ 落进段落 ⇒ 产出 `<p>---</p>`
 *     —— 界面上是**三个字面短横**（与 `**` 显示成星号同一类坏字）。现场：`卖点讨论/bl-3`。
 *   B 单元格切分不认 `\|`：`` `dmesg \| tail` `` 被当成两格 ⇒ 两个孤立反引号 + 一个字面 `\`
 *     —— 这正是 `NOTE_RESIDUE` 欠账册里 **3 条 / 5 处**的形状
 *     （`comnet::12-mumupmmew2f0` / `comnet::3-4-ebtables-mark-mv6idkjcv0r3` /
 *      `comnet::1-6-21-02-22-03-23-05-mv6idoy0lb9a`）。
 *
 * 判别力（两处各自承重，注入记录在 `.review/20261020-markdown-star-rootfix/hr-pipe/`）：
 *   · 把 A 的 `HR_LINE` 分支删掉 ⇒「目标 A」全红；
 *   · 把 B 的占位保护删掉（退回 `split('|')`）⇒「目标 B」全红。
 * ============================================================ */

describe('分隔线 hr 与表格单元格的 \\| 转义', () => {
  /* —— A 目标：分隔线是**标记**，不是文字 ⇒ <hr>（不算丢内容） —— */

  it('目标 A：`---` ⇒ <hr>（不是 <p>---</p>）', () => {
    expect(markdownToHtml('---')).toBe('<hr>');
    expect(markdownToHtml('---')).not.toContain('<p>---</p>');
  });

  it('目标 A：`***` ⇒ <hr>（不是 <em>，也不是三个字面星号）', () => {
    expect(markdownToHtml('***')).toBe('<hr>');
    expect(markdownToHtml('***')).not.toContain('<em>');
  });

  it('目标 A：`___` / 夹空格的 `- - -` / `* * *` / 更长的 `-----` 都认', () => {
    expect(markdownToHtml('___')).toBe('<hr>');
    expect(markdownToHtml('- - -')).toBe('<hr>');
    expect(markdownToHtml('* * *')).toBe('<hr>');
    expect(markdownToHtml('-----')).toBe('<hr>');
  });

  it('目标 A：夹在正文里的分隔线单独成行', () => {
    expect(markdownToHtml('文本行\n---\n后续文本')).toBe('<p>文本行</p>\n<hr>\n<p>后续文本</p>');
  });

  it('目标 A：`hr` 在渲染层白名单里（否则消毒会把 <hr> 剥掉）', async () => {
    // 本批**没有**改白名单 —— 这条断言把"为什么不用改"钉住（`hr` 本来就在表里）
    const w = await import('../src/html-whitelist.js');
    expect(w.ALLOW_TAGS).toContain('hr');
    expect(w.isAllowedTag('hr')).toBe(true);
  });

  /* —— A 反证：列表不许被吃成分隔线（插错位置就是这两种坏法） —— */

  it('反证 A：`- 项一` / `- 项二` 仍是 <ul><li>（没被吃成分隔线）', () => {
    expect(markdownToHtml('- 项一\n- 项二')).toBe('<ul><li>项一</li><li>项二</li></ul>');
    expect(markdownToHtml('* 项一\n* 项二')).toBe('<ul><li>项一</li><li>项二</li></ul>');
  });

  it('反证 A：只有两个标记仍是列表项、混用符号不是分隔线、`***x***` 不是分隔线', () => {
    expect(markdownToHtml('- -')).toBe('<ul><li>-</li></ul>');            // 两个 `-` ⇒ 列表项
    expect(markdownToHtml('-*-')).toBe('<p>-*-</p>');                     // 混用符号 ⇒ 不是分隔线
    expect(markdownToHtml('***x***')).not.toContain('<hr>');              // 强调+粗体 ⇒ 不是分隔线
    expect(markdownToHtml('***x***')).toContain('<strong>x</strong>');
  });

  /* —— B 目标：`\|` 是**字面竖线**，不是单元格分隔 —— */

  it('目标 B：`` | `dmesg \\| tail` | 说明 | `` ⇒ 该格是 <code>dmesg | tail</code>（一个反引号对）', () => {
    const html = markdownToHtml('| 命令 | 说明 |\n| --- | --- |\n| `dmesg \\| tail` | 看尾部 |');
    expect(html).toBe('<table><tr><th>命令</th><th>说明</th></tr>'
      + '<tr><td><code>dmesg | tail</code></td><td>看尾部</td></tr></table>');
    expect(html).not.toContain('`');      // 不许留孤立反引号（= 欠账册里那 5 处坏字）
    expect(html).not.toContain('\\');     // 不许留字面反斜杠
  });

  it('目标 B：非代码区的转义竖线同样落在**同一格**里', () => {
    expect(markdownToHtml('| a | b |\n| --- | --- |\n| x \\| y | z |'))
      .toBe('<table><tr><th>a</th><th>b</th></tr><tr><td>x | y</td><td>z</td></tr></table>');
  });

  it('目标 B 的边界：`\\\\|` = 字面反斜杠 + **真·单元格分隔**（GFM 口径）', () => {
    expect(markdownToHtml('| a | b |\n| --- | --- |\n| x \\\\| y |'))
      .toBe('<table><tr><th>a</th><th>b</th></tr><tr><td>x \\</td><td>y</td></tr></table>');
  });

  it('目标 B 的边界：三个反斜杠 + 竖线 ⇒ 字面反斜杠 + **字面竖线**（同一格）', () => {
    expect(markdownToHtml('| a | b |\n| --- | --- |\n| x \\\\\\| y |'))
      .toBe('<table><tr><th>a</th><th>b</th></tr><tr><td>x \\| y</td></tr></table>');
  });

  /* —— B 反证：不碰的输入必须逐字节不变 —— */

  it('反证 B：普通表格（无转义）逐字节不变', () => {
    expect(markdownToHtml('| 维度 | 电路交换 |\n| --- | --- |\n| 资源 | 独占 |'))
      .toBe('<table><tr><th>维度</th><th>电路交换</th></tr><tr><td>资源</td><td>独占</td></tr></table>');
    expect(markdownToHtml('| 表头 | b |\n| --- | --- |\n| **粗** | *斜* |'))
      .toBe('<table><tr><th>表头</th><th>b</th></tr><tr><td><strong>粗</strong></td><td><em>斜</em></td></tr></table>');
  });

  it('反证 B：**不紧跟竖线**的反斜杠一个字不动（`C:\\\\temp` 原样出两格）', () => {
    expect(markdownToHtml('| a | b |\n| --- | --- |\n| C:\\\\temp | x |'))
      .toBe('<table><tr><th>a</th><th>b</th></tr><tr><td>C:\\\\temp</td><td>x</td></tr></table>');
  });

  it('反证 B：段落里的 `\\|` 不在本批改动面（非表格文本原样保留）', () => {
    expect(markdownToHtml('a\\|b')).toBe('<p>a\\|b</p>');
  });

  /* —— 占位符的两条硬性质（与 `inline()` 的 `codeSentinel()` 同一口径） —— */

  it('占位符不可能与正文冲突：正文里出现同形哨兵也不串（哨兵自动撑长）', () => {
    const sentinelish = '\u0001CELL\u0002P\u0001CELL\u0002';
    const html = markdownToHtml('| a | b |\n| --- | --- |\n| ' + sentinelish + ' \\| y |');
    expect(html).toContain(sentinelish);                                   // 正文原样，没被当成占位符吃掉
    expect(html).toContain('| y');                                        // 转义竖线仍是字面
    expect(html.replace(sentinelish, '')).not.toMatch(/[\u0001\u0002]/);   // 除正文自带那处，不泄漏占位符
  });

  it('产物确定性：同一份输入连跑两次逐字节相同（占位符零随机、零时钟）', () => {
    const md = '| 命令 | 说明 |\n| --- | --- |\n| `dmesg \\| tail` | 看尾部 |\n\n---\n\n- 项一\n- 项二';
    expect(markdownToHtml(md)).toBe(markdownToHtml(md));
    expect(markdownToHtml(md)).toContain('<hr>');
    expect(markdownToHtml(md)).toContain('<code>dmesg | tail</code>');
  });
});
