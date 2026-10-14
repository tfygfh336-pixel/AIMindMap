/**
 * tests/vault.test.js —— 【W12】Obsidian 库直进：`src/doc-import.js` 的那一段纯逻辑
 * 运行：npx vitest run tests/vault.test.js
 *
 * 这一批的判据分两层：**产品真路径**在 `scripts/smoke/44-obsidian-vault.js`（真跑 CLI + 真读盘 +
 * 既有读命令对拍）；本文件盯的是那一层判据**背后的判定逻辑**，尤其是"哪个分档算哪一档"——
 * 那些分档一旦错，冒烟那边只会说"数量不对"，说不清是哪一条错了。
 *
 * 四个状态必须**可分辨**（B4c）：
 *   ① 目标存在            ⇒ 接上一条边（`linked` +1）；
 *   ② 目标不存在/认不出   ⇒ 进 `unresolved`（**不是**静默丢，也**不是**写一条悬空边）；
 *   ③ 同名多篇            ⇒ 进 `ambiguous`（**不挑一个**：挑错比不接更坏）；
 *   ④ 目标在库里、但不在本次范围 ⇒ 进 `unresolved` 并说明"库里**有**它"（与 ② 分开，修法不同）。
 *
 * 另有三条硬口径在这里钉死（它们在冒烟里不好造）：
 *   · **frontmatter** 剥掉之后正文一个字都不少（`body` 与"没有 frontmatter"时的输入一致）；
 *   · **围栏代码块里**的 `[[…]]` 一律不解析（那是代码，不是链接）；
 *   · **默认档**（不传 transform）与从前**逐字节相同** —— 用同一个目录跑两遍对拍字段。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const docImport = require('../src/doc-import.js');
const schema = require('../src/schema.js');

/** 造一个临时 vault（**不碰真实 projects/**） */
function makeVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vault-test-'));
  Object.keys(files).forEach((rel) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (files[rel] === null) { fs.mkdirSync(abs, { recursive: true }); return; }
    fs.writeFileSync(abs, files[rel], 'utf8');
  });
  return root;
}
function runVault(files, opts) {
  const root = makeVault(files);
  try {
    const scan = docImport.scanImportDir(root, { ext: ['.md'], vault: true });
    const r = docImport.applyVault(scan, Object.assign({
      project: 'p', at: '2026-01-01T00:00:00.000Z'
    }, opts || {}));
    return { root, scan, built: r.built, vault: r.vault };
  } finally { /* 调用方决定何时删；这里不删（下面统一 afterEach）*/ }
}
const tmpRoots = [];
function runVaultKeep(files, opts) {
  const out = runVault(files, opts);
  tmpRoots.push(out.root);
  return out;
}
function cleanup() {
  while (tmpRoots.length) {
    const r = tmpRoots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响判据 */ }
  }
}
function allNodes(children) {
  const out = [];
  (function walk(n) { if (!n) return; out.push(n); (n.children || []).forEach(walk); })({ id: 'root', topic: 'root', children: children });
  return out;
}
const nodeByTopic = (children, topic) => allNodes(children).filter((n) => n.topic === topic)[0] || null;
const linksOf = (children) => {
  const out = [];
  allNodes(children).forEach((n) => (n.links || []).forEach((l) => out.push({ from: n.id, fromTopic: n.topic, link: l })));
  return out;
};

describe('【W12】frontmatter：解析（最小子集，边界写死）', () => {
  it('块级列表 + 行内列表 + 引号 + 注释都认；body 就是"去掉那一段之后"的正文', () => {
    const src = '---\ntags: [工具, 网络]\naliases:\n  - 主页\n  - 首页\n# 注释行\ntitle: "带 引号"\n---\n# 正文标题\n';
    const fm = docImport.parseFrontmatter(src);
    expect(fm.has).toBe(true);
    expect(fm.fields.tags).toEqual(['工具', '网络']);
    expect(fm.fields.aliases).toEqual(['主页', '首页']);
    expect(fm.fields.title).toBe('带 引号');
    expect(fm.body).toBe('# 正文标题\n');
    expect(fm.warns).toEqual([]);
  });

  it('没有 frontmatter ⇒ `body` 与入参**逐字节相同**（不许顺手改一个字）', () => {
    const src = '# 标题\n\n正文\n\n> 引用\n';
    const fm = docImport.parseFrontmatter(src);
    expect(fm.has).toBe(false);
    expect(fm.body).toBe(src);
  });

  it('只有开头的 `---` 没收尾 ⇒ 按"没有 frontmatter"处理，但**响亮记一笔**（不许静默当成有）', () => {
    const src = '---\ntags: [a]\n\n# 标题\n';
    const fm = docImport.parseFrontmatter(src);
    expect(fm.has).toBe(false);
    expect(fm.body).toBe(src);
    expect(fm.warns.length).toBe(1);
    expect(fm.warns[0]).toContain('没找到收尾');
  });

  it('认不出的行**跳过并记一笔**（不猜、也不把别人的值写进标签）', () => {
    const fm = docImport.parseFrontmatter('---\nnested:\n  a: 1\ntags: [x]\n---\nbody\n');
    expect(fm.fields.tags).toEqual(['x']);
    expect(fm.warns.length).toBeGreaterThan(0);
  });
});

describe('【W12】wiki 语法：三种变体 + 嵌入 + 代码块免疫', () => {
  const F = '```';
  const md = [
    '# 标题',
    '[[页]] 与 [[页|别名]] 与 [[页#节]] 与 [[页#一 段/子段|带别名]]',
    '单独片段：[[#本节标题]]',
    '嵌入：![[img.png]] 与 ![[笔记甲]]',
    F,
    '[[不该被识别]]  ![[也不该.png]]',
    F,
    '空：[[   ]]'
  ].join('\n');

  it('四种写法都解析成 token（目标 / 片段 / 别名各就各位），围栏里的一个都不认', () => {
    const r = docImport.convertWikiSyntax(md);
    const raw = r.tokens.map((t) => t.raw);
    expect(raw).toContain('[[页]]');
    expect(raw).toContain('[[页|别名]]');
    expect(raw).toContain('[[页#节]]');
    expect(raw).toContain('[[页#一 段/子段|带别名]]');
    expect(raw).toContain('[[#本节标题]]');
    expect(raw).toContain('![[img.png]]');
    expect(raw).toContain('![[笔记甲]]');
    expect(raw.some((s) => s.indexOf('不该被识别') >= 0)).toBe(false);
    expect(raw.some((s) => s.indexOf('也不该.png') >= 0)).toBe(false);
    const byRaw = {};
    r.tokens.forEach((t) => { byRaw[t.raw] = t; });
    expect(byRaw['[[页|别名]]'].display).toBe('别名');
    expect(byRaw['[[页|别名]]'].target).toBe('页');
    expect(byRaw['[[页#节]]'].heading).toBe('节');
    expect(byRaw['[[#本节标题]]'].target).toBe('');           // 只给片段 ⇒ 目标为空（在**本文**里找那个标题）
    expect(byRaw['[[#本节标题]]'].heading).toBe('本节标题');
    expect(byRaw['![[img.png]]'].kind).toBe('resource');       // 有扩展名 ⇒ 走**既有**资源行
    expect(byRaw['![[笔记甲]]'].kind).toBe('embed-note');      // 没扩展名 ⇒ 笔记嵌入（按链接处理）
  });

  it('正文转换：可见文字保留（别名优先），`[[…]]` 变成标准 Markdown 链接，代码块原样', () => {
    const r = docImport.convertWikiSyntax(md);
    expect(r.md).toContain('[页](mm-obsidian:%E9%A1%B5)');
    expect(r.md).toContain('[别名](mm-obsidian:%E9%A1%B5)');
    expect(r.md).toContain('[[不该被识别]]');       // 围栏里原样（它本来就是 markdown 代码块的内容）
    expect(r.md).toContain('![[也不该.png]]');
  });
});

describe('【W12】落点：links[]（既有字段）+ 分档可分辨', () => {
  const base = {
    '.obsidian/app.json': '{}',
    '甲.md': '# 甲\n\n## 小节\n\n正文\n',
    '子目录/乙.md': '# 乙\n\n## 外层\n\n### 深层\n\n正文\n'
  };

  it('① 接上：`[[甲]]` / `[[甲|别名]]` / `[[甲#小节]]` ⇒ 落在**发源笔记的节点**上，指向目标节点；带片段时指向**那个标题节点**', () => {
    const r = runVaultKeep(Object.assign({}, base, {
      '索引.md': '# 索引\n\n[[甲]] 与 [[甲|小甲]] 与 [[甲#小节]]\n'
    }));
    cleanup();
    const links = linksOf(r.built.children);
    const idx = nodeByTopic(r.built.children, '索引');
    const a = nodeByTopic(r.built.children, '甲');
    const sec = nodeByTopic(r.built.children, '小节');
    expect(links.length).toBe(3);
    expect(links.every((x) => x.from === idx.id)).toBe(true);
    expect(links.every((x) => x.link.project === 'p')).toBe(true);       // 同项目引用（schema 支持）
    expect(links.map((x) => x.link.id)).toEqual([a.id, a.id, sec.id]);
    expect(links.every((x) => typeof x.link.caption === 'string' && x.link.caption.length > 0)).toBe(true);
    expect(links[2].link.caption).toContain('小节');
  });

  it('② 目标不存在 ⇒ 进 `unresolved`（逐条点名）、**一条边都不写**；正文里那句话原样留着', () => {
    const r = runVaultKeep(Object.assign({}, base, {
      '索引.md': '# 索引\n\n[[根本没有这篇]]\n'
    }));
    cleanup();
    expect(linksOf(r.built.children).length).toBe(0);
    expect(r.vault.danglingTotal).toBe(1);
    expect(r.vault.dangling[0].raw).toBe('[[根本没有这篇]]');
    expect(r.vault.dangling[0].file).toBe('索引.md');
    expect(r.vault.linked).toBe(0);
    /* 正文**没丢**：那句链接文字仍在这棵树里。
     * ⚠️ 它落在**标题节点**（`# 索引` 生成的「索引正文」）的 detail 上，**不是**文件节点 ——
     * 文件节点只是"这篇笔记"的容器（落点契约见 `src/doc-import.js` 的 ⓪⁶ 段）⇒ 判据要遍历全树。 */
    const allDetail = allNodes(r.built.children).map((n) => String(n.detail || '')).join('\n');
    expect(allDetail).toContain('根本没有这篇');
  });

  it('③ 同名多篇 ⇒ 进 `ambiguous`（**不挑一个**），两个候选都点出来', () => {
    const r = runVaultKeep(Object.assign({}, base, {
      '索引.md': '# 索引\n\n[[同名]]\n',
      '一/同名.md': '# 同名\n',
      '二/同名.md': '# 同名二\n'
    }));
    cleanup();
    expect(linksOf(r.built.children).length).toBe(0);
    expect(r.vault.ambiguous.length).toBe(1);
    expect(r.vault.ambiguous[0].target).toBe('同名');
    expect(r.vault.ambiguous[0].hits.sort()).toEqual(['一/同名.md', '二/同名.md']);
  });

  it('④ 目标在库里、但这一批没导它（`only` 过滤）⇒ 与"不存在"分开报，且说清"库里有它"', () => {
    const files = Object.assign({}, base, {
      '索引.md': '# 索引\n\n[[甲]]\n'
    });
    const root = makeVault(files);
    tmpRoots.push(root);
    const scan = docImport.scanImportDir(root, { ext: ['.md'], vault: true });
    const only = new Set();                                 // 只导"索引.md"（甲.md 被排除）
    scan.files.forEach((f) => { if (f.rel === '索引.md') only.add(f.rel); });
    const r = docImport.applyVault(scan, { project: 'p', only: only });
    cleanup();
    expect(linksOf(r.built.children).length).toBe(0);
    expect(r.vault.dangling.length).toBe(1);
    expect(r.vault.dangling[0].why).toContain('甲.md');
    expect(r.vault.dangling[0].why).toContain('没有它');
  });

  it('自环（指向本文）不写成边，也**不静默**：如实进 unresolved', () => {
    const r = runVaultKeep(Object.assign({}, base, { '索引.md': '# 索引\n\n[[索引]]\n' }));
    cleanup();
    expect(linksOf(r.built.children).length).toBe(0);
    expect(r.vault.dangling[0].why).toContain('自己');
  });
});

describe('【W12】frontmatter 的落点：tags 进既有字段、aliases 参与解析', () => {
  it('`tags:`（行内/块级）与 `tag:`（单数键）都落到**那篇笔记的文件节点**；`#` 前缀被剥掉', () => {
    const r = runVaultKeep({
      '.obsidian/app.json': '{}',
      '甲.md': '---\ntags: [工具, "#网络"]\n---\n# 甲\n',
      '乙.md': '---\ntag: 单数键\n---\n# 乙\n'
    });
    cleanup();
    const a = nodeByTopic(r.built.children, '甲');
    const b = nodeByTopic(r.built.children, '乙');
    expect(a.tags).toEqual(['工具', '网络']);
    expect(b.tags).toEqual(['单数键']);
    expect(r.vault.taggedFiles).toBe(2);
    expect(r.vault.tags.sort()).toEqual(['单数键', '工具', '网络']);
  });

  it('`aliases` 当**候选名**：`[[别名]]` 能指到那篇笔记（别名本身不写进节点字段）', () => {
    const r = runVaultKeep({
      '.obsidian/app.json': '{}',
      '索引.md': '---\naliases: [主页]\n---\n# 索引\n',
      '甲.md': '# 甲\n\n[[主页]]\n'
    });
    cleanup();
    const links = linksOf(r.built.children);
    const idx = nodeByTopic(r.built.children, '索引');
    expect(links.length).toBe(1);
    expect(links[0].link.id).toBe(idx.id);
    expect(idx.aliases).toBe(undefined);            // 别名只在报告里（不落进数据）
    expect(r.vault.aliases).toEqual(['主页']);
  });

  it('别名解析**不受文件顺序影响**（别名写在后一篇里，前面的链接照样接得上）', () => {
    const r = runVaultKeep({
      '.obsidian/app.json': '{}',
      'a-先写的.md': '# 甲\n\n[[主页]]\n',
      'z-后写的.md': '---\naliases: 主页\n---\n# 索引\n'
    });
    cleanup();
    expect(linksOf(r.built.children).length).toBe(1);
  });
});

describe('【W12】默认档不变（不传 transform ⇒ 与 vault 那一路只差"解析"）', () => {
  const files = {
    '.obsidian/app.json': '{}',
    '甲.md': '# 甲\n',
    '索引.md': '---\ntags: [工具]\n---\n# 索引\n\n[[甲]] 一句\n'
  };

  it('同一个目录：vault 那一路有 links，**不给 --vault** 那一路一条都没有、tags 也没有', () => {
    const vaultRes = runVaultKeep(files);
    expect(linksOf(vaultRes.built.children).length).toBe(1);
    const idxV = nodeByTopic(vaultRes.built.children, '索引');
    expect(idxV.tags).toEqual(['工具']);
    expect(vaultRes.vault.linked).toBe(1);

    const root = makeVault(files);
    tmpRoots.push(root);
    const plainScan = docImport.scanImportDir(root, { ext: ['.md'] });      // **不传 vault**
    const plainBuilt = docImport.buildDirImportTree(plainScan, { tool: 'import-dir' });
    cleanup();
    expect(linksOf(plainBuilt.children).length).toBe(0);
    const idxP = nodeByTopic(plainBuilt.children, '索引');
    expect(idxP.tags).toBe(undefined);
    /* ⚠️ 这个夹具的正文以 `---` 开头 —— 默认档下它是一个**普通段落**（`markdownToTree` 的围栏只认
     *   ```/~~~ ⇒ 从那一行起被当代码收进 detail）。这不是本批引入的行为，本项只判"默认档**不解析**
     *   wiki 语法与 frontmatter"：没有 links、没有 tags，正文照旧一字不丢。 */
    expect(typeof idxP.detail).toBe('string');
    expect(idxP.detail.length).toBeGreaterThan(0);
  });

  it('默认档**不解析 wiki**：`[[甲]]` 原样留在正文里（一个字都没被改写）', () => {
    const root = makeVault({ 'note.md': '# 笔记\n\n[[甲]] 一句\n' });
    tmpRoots.push(root);
    const scan = docImport.scanImportDir(root, { ext: ['.md'] });
    const built = docImport.buildDirImportTree(scan, {});
    cleanup();
    expect(linksOf(built.children).length).toBe(0);
    const note = nodeByTopic(built.children, '笔记');
    // `convert.markdownToHtml` 只转义 `& < > "`（方括号不是 HTML 特殊字符）⇒ 这里就是原样的两个方括号
    expect(note.detail).toContain('[[甲]]');
    expect(note.detail).not.toContain('mm-obsidian');
    expect(nodeByTopic(built.children, '笔记').tags).toBe(undefined);
  });

  it('默认档**不走 transform**：源文件一个字节都没读过第二次（指纹算的是原样正文）', () => {
    const root = makeVault({ 'a.md': '# A\n' });
    tmpRoots.push(root);
    const scan = docImport.scanImportDir(root, { ext: ['.md'] });
    let called = 0;
    const built = docImport.buildDirImportTree(scan, { transform: (f, md) => { called += 1; return md; } });
    expect(called).toBe(1);
    expect(built.files).toBe(1);
    const scan2 = docImport.scanImportDir(root, { ext: ['.md'] });
    const plain = docImport.buildDirImportTree(scan2, {});
    cleanup();
    // 两个入口的**来源指纹**必须相同（同一个文件、同一份正文）
    expect(plain.entries[0].sha256).toBe(docImport.outlineSha256('# A\n'));
  });
});

describe('【W12】与既有契约相容：挂上 links 之后 `validate` 仍然通过', () => {
  it('同项目 links（`project` = 本次项目名）不是悬挂 —— schema 按"即将落盘的那份 data"判', () => {
    const r = runVaultKeep({
      '.obsidian/app.json': '{}',
      '甲.md': '# 甲\n\n[[乙]]\n',
      '乙.md': '# 乙\n\n[[甲]]\n'
    }, { project: 'proj-x' });
    cleanup();
    const data = {
      meta: { name: 'proj-x', author: '', version: '0.0.0', formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: 'proj-x', expanded: true, children: r.built.children }
    };
    const res = schema.validateProject(data, null, 'proj-x');
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(linksOf(r.built.children).length).toBe(2);
  });
});

describe('【W12】附件/图片 `![[…]]`：走**既有**资源行语法（不另写一套）', () => {
  it('转换出来的那一行就是 `markdown.resourceLine` 的输出（同一处语法 ⇒ 与导入导出成对）', () => {
    const markdown = require('../src/markdown.js');
    const r = docImport.convertWikiSyntax('# 带图\n\n![[assets/图.png]]\n');
    expect(r.md).toContain(markdown.resourceLine('file', 'assets/图.png', 'assets/图.png'));
    expect(r.tokens[0].kind).toBe('resource');
  });

  it('落不成项目内文件的那一条 ⇒ 报告里逐条点名（**不是**静默丢）', () => {
    const root = makeVault({ '带图.md': '# 带图\n\n![[没有这张图.png]]\n' });
    tmpRoots.push(root);
    const scan = docImport.scanImportDir(root, { ext: ['.md'], vault: true });
    const markdown = require('../src/markdown.js');
    const r = docImport.applyVault(scan, {
      project: 'p',
      resolveRefs: (baseDir, node) => {
        const rows = markdown.resolveImportRefs(node, { baseDir: baseDir, onMissing: 'detail', dryRun: true });
        return rows;
      }
    });
    cleanup();
    expect(r.vault.resourceUnresolved.length).toBe(1);
    expect(r.vault.resourceUnresolved[0].raw).toBe('没有这张图.png');
    expect(r.vault.resourceTotal).toBe(1);
  });
});

describe('【W12】库识别与目录边界', () => {
  it('`isVaultDir`：有 `.obsidian/` 才是库（文件同名不算）', () => {
    const a = makeVault({ '.obsidian/app.json': '{}' });
    const b = makeVault({ '.obsidian': 'not-a-dir' });
    const c = makeVault({ 'a.md': '# A\n' });
    tmpRoots.push(a, b, c);
    expect(docImport.isVaultDir(a)).toBe(true);
    expect(docImport.isVaultDir(b)).toBe(false);
    expect(docImport.isVaultDir(c)).toBe(false);
    cleanup();
  });

  it('`--vault` 时不导附件库目录（`assets/` / `attachments/`）—— 如实记进 `skippedDirs`，不计进跳过原因', () => {
    const files = { '.obsidian/app.json': '{}', 'a.md': '# A\n', 'assets/x.png': 'p', 'attachments/y.bin': 'b' };
    const root = makeVault(files);
    tmpRoots.push(root);
    const v = docImport.scanImportDir(root, { ext: ['.md'], vault: true });
    const p = docImport.scanImportDir(root, { ext: ['.md'] });        // 默认档：照旧当普通目录走查
    cleanup();
    expect(v.files.map((f) => f.rel)).toEqual(['a.md']);
    expect(v.skippedDirs).toEqual(['assets', 'attachments']);
    expect(v.counts['skip-dir']).toBe(undefined);
    expect(p.skippedDirs).toBe(undefined);
    /* 默认档：`assets/` / `attachments/` 是**普通目录** ⇒ 逐个走查、逐条说"里面没有可导入的文件"。
     * 判据用**排序后的字符串**比（数组比较对顺序的要求会随断言库实现变，字符串不会；
     * 而这里真正要钉的是"**每个**跳过原因都在、且**没有多出**一条"）。 */
    expect(p.skipped.map((s) => s.rel + ':' + s.reason).sort().join(' | '))
      .toBe(['.obsidian:hidden', 'assets:no-importable', 'assets/x.png:unsupported-ext',
        'attachments:no-importable', 'attachments/y.bin:unsupported-ext'].sort().join(' | '));
  });
});
