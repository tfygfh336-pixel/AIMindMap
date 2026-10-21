/* ============================================================
 * tests/import-fence-count.test.js — 导入三缺陷（20261022）· **缺陷 1**
 *   「这一行算不算标题」**只有一处判据**（围栏感知）⇒ `--dry-run` 报的标题数 == 真建节点数
 * 运行：npx vitest run tests/import-fence-count.test.js
 * ------------------------------------------------------------
 * 修的是什么（`W15` 批实测，`.review/20261020-W15-import/README.md` 的表里有原文读数）：
 *   一份带围栏代码块的经验笔记，`import-project … --dry-run` 自报 **216 个标题**，
 *   同一份文件真建 **72 个节点**（差 144）—— 多出来的全是围栏里的 `#` 注释。
 *   根因是**同一件事两处实现**：`src/doc-import.js` 的 `finishOutline` 用朴素正则
 *   `/^(#{1,6})\s+\S/` 逐行数，而建树的 `src/markdown.js` 的 `markdownToTree` 是**围栏感知**的。
 *   ⇒ 违反 `architecture-for-ai` 的 `A1`（单一逻辑源）。
 *
 * 修法与**本文件守的是什么**：
 *   把"逐行的围栏状态"抽成 `src/markdown.js` 的 `outlineLines()`（**唯一实现**），
 *   `markdownToTree` / `outlineHeadingLines` / `countOutlineHeadings` 全部消费它；
 *   `finishOutline` 现在**一行正则都没有**。本文件把"两处口径不会重新分叉"钉成断言：
 *     A 组：围栏判定本身（围栏内 / 未闭合 / 空标题 / 7 个井号 / 缩进）—— 判据的**边界**；
 *     B 组：**单源判据** —— `outlineHeadingLines(md).length` 与 `markdownToTree` 建出来的节点数
 *            在"没有缺层"的提纲上**逐数相同**；缺层时的差**必须是占位节点那几条**（不是别的差）；
 *     C 组：`finishOutline` 的 `stats` 与 `countOutlineHeadings` **逐字段相同**（谁再抄一份正则就红）；
 *     D 组：**W15 形状的回归钉**（72 个真标题 + 144 条围栏注释）—— 换个朴素正则这条必红 216。
 *
 * 判别力（"修前红"的证据，见 `.review/20261022-import-fixes/README.md`）：
 *   D 组在**改前**的实现下读数是 216（不是 72）⇒ 必红；`.review/20261022-import-fixes/probe-before.out.json`
 *   里 `d1.diff = 144` 就是那条真实读数（同一份源文件、同一个判据）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const markdown = require('../src/markdown.js');
const docImport = require('../src/doc-import.js');

/** 确定性 id 生成器（同一份提纲两次建树得到**同一份**结构 —— 与 idGen 的随机性无关） */
function detGen() {
  let n = 0;
  return (seed) => { n += 1; return 'n-' + n + '-' + String(seed || '').replace(/\s+/g, '-'); };
}

/** 建树并回报"节点数 + 占位节点那几个"（占位 = 缺层时 `markdownToTree` 补的「（层级N）」） */
function build(md) {
  const r = markdown.markdownToTree(md, 'root', detGen());
  const placeholders = [];
  (function walk(x) {
    for (const c of (x.children || [])) {
      if (/^（层级\d+）$/.test(String(c.topic || ''))) placeholders.push(c.topic);
      walk(c);
    }
  })(r.data);
  return { added: r.addedCount, placeholders: placeholders };
}

const FENCE_MD = [
  '# 甲',
  '## 甲-1',
  '```sh',
  '# 不是标题（shell 注释）',
  '# 也不是',
  'ls -l',
  '```',
  '# 乙',
  '## 乙-1',
  ''
].join('\n');

/* ============================================================================
 * A 组：围栏判定的边界（每一档都对着 `markdownToTree` 的既有行为，不许"顺手改进"）
 * ========================================================================== */
describe('缺陷 1 · A 围栏判定的边界（`outlineLines` 是唯一判据）', () => {
  it('A1 围栏代码块里的 `#` **不是标题**（这正是 216 vs 72 那 144 条的来源）', () => {
    expect(markdown.countOutlineHeadings(FENCE_MD)).toEqual({ headings: 4, levelCounts: { 1: 2, 2: 2 } });
  });

  it('A2 未闭合的围栏 ⇒ 其后所有行都在围栏内（与建树"整段原样收集"同一结论）', () => {
    const md = '# 甲\n```\n# 乙\n## 丙\n';
    expect(markdown.countOutlineHeadings(md).headings).toBe(1);
  });

  it('A3 空标题（`# ` 之类的空串）**不数** —— 它建不出节点，数它就是虚高', () => {
    const md = '# \n#\t\n## 有标题\n';
    expect(markdown.countOutlineHeadings(md)).toEqual({ headings: 1, levelCounts: { 2: 1 } });
  });

  it('A4 七个井号 `####### x` 不算标题（Markdown 只到 6 级，H_RE 只认 1–6）', () => {
    expect(markdown.countOutlineHeadings('####### 七级\n###### 六级\n').headings).toBe(1);
  });

  it('A5 缩进的 `#` 不算标题（`#` 必须在行首 —— 与 `markdownToTree` 逐字一致）', () => {
    expect(markdown.countOutlineHeadings(' # 缩进的\n# 行首的\n').headings).toBe(1);
  });

  it('A6 围栏判定看的是"**去首尾空白后**以三个反引号开头"的行 ⇒ 缩进的 ``` 也算围栏开（与 `markdownToTree` 逐字一致）', () => {
    // ⚠️ 这条边界容易猜反：`markdownToTree` 一直用 `line.trim()` 判围栏，所以"四空格缩进的代码块"
    //    在**本工程**里也被当成围栏（那条行之后到收尾之前的 `#` 都不算标题）。
    //    这里钉的是**既有行为**，不是"Markdown 标准怎么说"——改它就得同批改建树，别只改一边。
    const md = '    ```\n# 甲\n    ```\n# 乙\n';
    expect(markdown.countOutlineHeadings(md)).toEqual({ headings: 1, levelCounts: { 1: 1 } });
  });
});

/* ============================================================================
 * B 组：**单源判据** —— 数出来的标题数 == 建出来的节点数
 * ========================================================================== */
describe('缺陷 1 · B 单源判据：标题数 == 建树节点数', () => {
  it('B1 带围栏的提纲：4 个标题 ⇒ 建出 4 个节点（差 0）', () => {
    const b = build(FENCE_MD);
    expect(b.placeholders).toEqual([]);
    expect(markdown.outlineHeadingLines(FENCE_MD).length).toBe(4);
    expect(b.added).toBe(4);
  });

  it('B2 多份形态各异的提纲逐一对照（围栏 / 未闭合 / 前导正文 / 引用块 / 纯正文）', () => {
    const fixtures = [
      FENCE_MD,
      '# 甲\n```\n# 乙\n',
      '# 甲\n\n正文\n\n## 乙\n> 引用\n',
      '前导正文\n\n# 甲\n正文\n\n# 乙\n',
      '纯正文，一个标题都没有\n'
    ];
    fixtures.forEach((md, i) => {
      const b = build(md);
      expect(b.placeholders, '第 ' + (i + 1) + ' 份夹具不该有占位节点').toEqual([]);
      expect(markdown.outlineHeadingLines(md).length,
        '第 ' + (i + 1) + ' 份夹具：标题数与节点数必须逐数相同').toBe(b.added);
    });
  });

  it('B2′ 空标题被跳过 ⇒ 后继层级跳档时仍会产生占位节点（**已知且已声明**的那一类差，逐数写在这里）', () => {
    const md = '# \n## 甲\n';          // 1 级是空标题（建不出节点）⇒ `## 甲` 撞上缺层
    const b = build(md);
    expect(markdown.outlineHeadingLines(md).length).toBe(1);
    expect(b.placeholders).toEqual(['（层级2）']);
    expect(b.added).toBe(1 + 1);       // 标题 1 + 占位 1 —— 差**就是**那一条占位节点，不是别的东西
  });

  it('B3 缺层时**唯一的**已知差 = 占位节点（标题数 + 占位数 = 节点数，差必须恰是那几条）', () => {
    const md = '### 直接三级\n';       // 没有 1、2 级 ⇒ 建树会补「（层级2）」「（层级3）」两个占位
    const b = build(md);
    const headings = markdown.outlineHeadingLines(md).length;
    expect(headings).toBe(1);
    expect(b.placeholders).toEqual(['（层级2）', '（层级3）']);
    expect(b.added).toBe(headings + b.placeholders.length);
  });

  it('B4 `outlineHeadingLines` 给的是**原文那一行**（调用方要拿它当"前几个顶层主题"直接打印）', () => {
    const lines = markdown.outlineHeadingLines(FENCE_MD);
    expect(lines.map((h) => h.line)).toEqual(['# 甲', '## 甲-1', '# 乙', '## 乙-1']);
    expect(lines.map((h) => h.level)).toEqual([1, 2, 1, 2]);
    expect(lines.map((h) => h.topic)).toEqual(['甲', '甲-1', '乙', '乙-1']);
  });

  it('B5 列表形态的提纲：`#` 行仍按标题算（形态判定在 `markdownToTree` 里，本判据只管"这一行是不是 `#` 标题"）', () => {
    const md = '- 列表根\n  - 子项\n';
    expect(markdown.countOutlineHeadings(md).headings).toBe(0);
  });
});

/* ============================================================================
 * C 组：`finishOutline` 的 stats 与唯一判据**逐字段相同**（谁再抄一份正则就红）
 * ========================================================================== */
describe('缺陷 1 · C `finishOutline` 只装结果、不含第二份正则', () => {
  it('C1 stats.headings / stats.levelCounts 与 `countOutlineHeadings` 逐字段相同', () => {
    [FENCE_MD, '# 甲\n```\n# 乙\n', '# 甲\n## 乙\n## 丙\n', ''].forEach((md) => {
      const counted = markdown.countOutlineHeadings(md);
      const out = docImport.finishOutline('md', md);
      expect(out.stats.headings).toBe(counted.headings);
      expect(out.stats.levelCounts).toEqual(counted.levelCounts);
    });
  });

  it('C2 `finishOutline` 的 `stats.lines` / `chars` 仍是"整份提纲"的读数（判据只改了标题那两列）', () => {
    const md = FENCE_MD;
    const out = docImport.finishOutline('md', md);
    expect(out.stats.lines).toBe(md.split('\n').length);
    expect(out.stats.chars).toBe(md.length);
    expect(out.md).toBe(md);
  });
});

/* ============================================================================
 * D 组：W15 形状的回归钉（72 个真标题 + 144 条围栏注释）
 * ========================================================================== */
describe('缺陷 1 · D 回归钉（W15 形状：72 真标题 / 144 条围栏注释）', () => {
  /** 造一份与实测同形的提纲：每节一个真标题 + 两条围栏里的 `#` 注释 ⇒ 72 真 / 144 假 */
  function w15Shape(sections) {
    const out = [];
    for (let i = 1; i <= sections; i++) {
      out.push('# 主题 ' + i);
      out.push('');
      out.push('```sh');
      out.push('# 注释甲 ' + i);
      out.push('# 注释乙 ' + i);
      out.push('echo ' + i);
      out.push('```');
      out.push('');
    }
    return out.join('\n');
  }

  it('D1 72 个真标题 + 144 条围栏注释 ⇒ 标题数 = 72（朴素正则会读成 216）', () => {
    const md = w15Shape(72);
    expect(markdown.countOutlineHeadings(md).headings).toBe(72);
    // 对照：朴素正则在**同一份文本**上读到的是 216（这就是被修掉的那个虚高读数）
    const naive = md.split('\n').filter((l) => /^(#{1,6})\s+\S/.test(l)).length;
    expect(naive).toBe(216);
  });

  it('D2 同一份 72 标题的提纲 ⇒ 标题数 == 建出来的节点数（差 0，不是"差不多"）', () => {
    const md = w15Shape(72);
    const b = build(md);
    expect(b.placeholders).toEqual([]);
    expect(b.added).toBe(72);
    expect(markdown.outlineHeadingLines(md).length).toBe(72);
  });
});
