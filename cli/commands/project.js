/* ============================================================
 * cli/commands/project.js — 项目与数据命令
 * ------------------------------------------------------------
 * 本文件只做三件事：读参数、调 src/ 的纯逻辑、输出。
 * 视图构造 / 搜索 / 统计 / 打包格式解析都已下沉：
 *   src/query.js   —— read 视图、list、get、search、stats（AI 看到什么）
 *   src/bundle.js  —— aimap v1 打包格式的组装、解析与路径安全校验
 * 这样命令层不再藏"只有端到端才能测到"的逻辑（见 tests/query.test.js、tests/bundle.test.js）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const markdown = require('../../src/markdown.js');
const tree = require('../../src/tree-utils.js');    // 树遍历单源（本文件不再自写 walk）
const query = require('../../src/query.js');       // 视图/搜索/统计纯逻辑
const bundle = require('../../src/bundle.js');     // aimap 打包格式纯逻辑
const exportHtml = require('../../src/export-html.js');   // 静态站点 HTML 生成纯逻辑
const MMConfig = require('../../src/config.js');   // 版本号单源（APP_VERSION）
const docImport = require('../../src/doc-import.js');  // 功能 5a：md/txt/docx → 提纲（三种前端、一个建树入口）

/** 树形打印（缩进由 src/query.js 的 treeLines 生成） */
function printTree(ctx, root) {
  query.treeLines(root).forEach((line) => ctx.out(line));
}

/** 可读视图：实现已下沉到 src/query.js（buildReadView） */
function buildReadView(data, opts) {
  return query.buildReadView(data, opts);
}

/* ---------------- 导入的**来源指纹**闸门（origin；见 src/doc-import.js 与 docs/DATA-FORMAT.md §2.8） ----------------
 * 为什么这一层在命令里而不是 `src/`：`import-project` 要判"这份文档是不是已经导过了"，
 * 就必须读**别的项目**（它自己那个项目还不存在），读盘是命令层的事，`src/` 保持纯逻辑 ✓。
 * 两个方向各一个入口：
 *   · originHitIn(root, want)          —— **本项目内**已有的同来源节点（import-md 用）
 *   · originHitAcrossStore(ctx, want)  —— **全部项目**里已有的同来源节点（import-project 用）
 * 判据本身只有一处（docImport.originMatches：src 与 sha256 **都要**相同）。 */
function originHitIn(root, want) {
  let hit = null;
  tree.walk(root, (n) => { if (!hit && docImport.originMatches(n.origin, want)) hit = n; });
  return hit;
}

/** **全库来源索引**：`originKey → {project, node}`（**一次扫盘**）。
 *  为什么需要它（不是"顺手优化"）：整库导入要按**文件粒度**逐个问"这个文件导过没有"，
 *  而 `originHitAcrossStore` 一次只回答**一个** want —— 逐个文件各扫一遍全库是
 *  O(文件数 × 全库节点数)（200 个文件 × 几千节点）。索引把这件事变成一次扫盘 + N 次查表 ✓。
 *  判据仍然是**同一处**（`docImport.originKey` / `originMatches`），这里只负责"一次扫完"。 */
function originIndexAcrossStore(ctx) {
  const map = new Map();
  ctx.store.list().forEach((p) => {
    let d = null;
    // 读不动的单个项目**不阻断**导入（那是别人的坏数据，不是我的问题）；也不出声 ——
    // 它只会让闸门"少查一处"，而导入本身仍然安全（大不了多一棵树，且有 origin 记着）
    try { d = ctx.store.read(p.name).data; } catch (e) { return; }
    tree.walk(d && d.data, (n) => {
      const k = docImport.originKey(n && n.origin);
      if (k && !map.has(k)) map.set(k, { project: p.name, node: n });   // 先到先得：与"逐项目找第一个"同序 ✓
    });
  });
  return map;
}

/** 单个 want 的查询（`import-project` 用）—— 搭在索引上，两条命令共用同一份扫盘实现 ✓ */
function originHitAcrossStore(ctx, want) {
  const k = docImport.originKey(want);
  if (!k) return null;
  return originIndexAcrossStore(ctx).get(k) || null;
}

/** 重复导入的拒绝报文：**上一次导到哪** + **怎么继续**（与既有"项目已存在: X（换个名字，或先删掉它）"
 *  "节点不存在: X" 同一形状 ✓）。为什么默认拒绝而不是默认放行：见 registry 里 import-md 的说明 ——
 *  节点 id 由时间+随机生成，同一份文档导两次会得到**两棵不相交的树**，事后无法分辨哪棵是哪棵。 */
function duplicateOriginError(where, origin) {
  return '这份文档已经导入过: ' + where + '（' + docImport.describeOrigin(origin) + '）'
    + '—— 同一份来源再导一次会得到**第二棵树**（节点 id 由"时间+随机"生成，内容相同的两棵也不会重合）'
    + '；确实要再来一份：加 --force（若想改的是已有的那一份，请直接 edit 那个节点）';
}

module.exports = {
  projects(ctx) {
    const list = ctx.store.list();
    if (ctx.args.json) { ctx.outJson(list); return; }
    list.forEach((p) => ctx.out(p.name + (p.meta && p.meta.name ? '  （' + p.meta.name + '）' : '')));
  },

  read(ctx) {
    const { data } = ctx.read();
    const js = !!ctx.args.json;

    // ---- 文本模式的静默陷阱：以前 --detail / --images 被**无声丢弃** ----
    // 文本模式只输出结构树，它给不出详情与资源清单。静默忽略的后果不是"少给了点东西"，
    // 而是让人得出**错误的结论**：「这个项目没有详情」。所以这里明确报错并给出替代路径。
    // （`--brief` 不在此列：文本模式本来就是结构视图，它没有做出任何给不出的承诺。）
    if (!js) {
      const phantom = [];
      if (ctx.args.detail !== undefined) phantom.push('--detail');
      if (ctx.args.images !== undefined) phantom.push('--images');
      if (phantom.length) {
        ctx.error(phantom.join(' / ') + ' 只在 --json 视图里有效；文本模式只输出结构树。'
          + '要详情：read ' + ctx.projectName + ' --json（--json 默认就含详情，无需 --detail）｜'
          + '要结构：read ' + ctx.projectName + ' --json --brief｜'
          + '要最省：read ' + ctx.projectName + ' --json --brief --compact');
      }
    }

    // ---- --subtree <id>：只读某一棵子树（定位到分支后的定点作业）----
    // 实测收益：全项目 --json 149 KB，而某棵大子树只要 24 KB（--brief --compact）⇒ 约 −84%。
    if (ctx.args.subtree === true) {
      ctx.error('--subtree 需要一个节点 id：read <项目> --subtree <id>');
    }
    const subId = ctx.args.subtree === undefined ? null : String(ctx.args.subtree);
    let view = data;
    if (subId !== null) {
      const node = tree.find(data.data, subId);
      if (!node) ctx.error('--subtree 指向的节点不存在: ' + subId);
      // 子树当成根来建视图：buildReadView 的 depth 从 0 起，于是子树内部层级自洽
      view = { meta: data.meta, data: node };
    }

    if (js) {
      ctx.outJson(buildReadView(view, ctx.args));
      return;
    }
    ctx.out('# ' + (data.meta.name || ctx.projectName) + (subId !== null ? '  ▸ ' + subId : ''));
    printTree(ctx, view.data);
  },

  list(ctx) {
    const { data } = ctx.read();
    if (ctx.args.json) {
      ctx.outJson({ project: ctx.projectName, nodes: query.buildNodeList(data.data) });
      return;
    }
    printTree(ctx, data.data);
  },

  get(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    const { data } = ctx.read();               // 只读一次，保证 path 与 node 同一快照
    // path 由 tree-utils.pathTo 计算（曾内联手写 DFS 且缺回溯 pop，
    // 导致返回「DFS 访问过的全部节点」——查 s-3-1 会得到 27 项而非 4 项）
    const out = query.getNodeView(data.data, id, ctx.args);
    if (!out) ctx.error('节点不存在: ' + id);
    if (ctx.args.json) ctx.outJson(out);
    else ctx.out(JSON.stringify(out, null, 2));
  },

  search(ctx) {
    const kw = ctx.args._[1];
    const tag = ctx.args.tag;
    if (!kw && !tag) ctx.error('缺少关键词（或用 --tag 按标签搜索）');
    const { hits } = query.searchNodes(ctx.root, { keyword: kw, tag, full: !!ctx.args.full });
    if (ctx.args.json) ctx.outJson({ keyword: kw, tag, hits });
    else hits.forEach((h) => ctx.out(h.id + '  ' + h.topic + (h.matchIn && h.matchIn !== 'topic' ? '  [' + h.matchIn + ']' : '') + (h.snippet ? '  …' + h.snippet + '…' : '')));
  },

  stats(ctx) {
    const { data } = ctx.read();
    // files / tags 此前缺失，导致 AI 用 stats 判断"该项目有没有附件/标签"时永远得到 0。
    const s = Object.assign({ project: ctx.projectName }, query.computeStats(data.data));
    if (ctx.args.json) ctx.outJson(s);
    else Object.keys(s).forEach((k) => ctx.out(k + ': ' + s[k]));
  },

  init(ctx) {
    const name = ctx.projectName;
    if (!name) ctx.error('缺少项目名');
    if (fs.existsSync(path.join(ctx.PROJECTS_DIR, name, name + '.json'))) ctx.error('项目已存在: ' + name);
    const title = ctx.args.title || name;
    const data = {
      // 版本号单源：src/config.js 的 APP_VERSION（历史上此处硬编码 '0.13.0'）
      meta: { name: title, author: '', version: MMConfig.APP_VERSION, formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: title, expanded: true, children: [] }
    };
    ctx.write(data);
    ctx.out('已创建项目: ' + name);
  },

  /** 功能 5a：**大文档 → 新项目 + 新树**（md/txt/docx/pdf）。
   *  与 `import-md` 的区别：那个把节点**追加到已有项目**的某个父节点下；这个**从零建项目**。
   *  · 转换只做一次并捕获进闭包（同 import-md 的理由：fn 里禁止 I/O、并发重放不该重生成 id）；
   *  · **一次 ctx.write** 落盘 ⇒ 中途失败不会留下半个项目 ✓；
   *  · 文档的 1 级标题变成**顶层主题**（"一个文件里几本书 ⇒ 几棵树"在 5a 这一级就成立 ✓）；
   *  · PDF：有书签走书签、**无书签走文字层**（P0 ✓）；两样都没有 ⇒ 转换阶段就**响亮拒绝** ✓；
   *  · `--dry-run` 只报格式/规模/前几个标题，**不写盘**（可机械验证，也是使用者预览的第一入口 ✓）。 */
  importProject(ctx) {
    const name = ctx.projectName;
    if (!name) ctx.error('缺少项目名');
    const file = ctx.args._[1];
    if (!file) ctx.error('用法: import-project <新项目名> <文件.md|.txt|.docx|.pdf> [--title 标题] [--dry-run] [--force]');
    // 入参闸门（见 src/doc-import.js 的 ⓪）：目录 / 路径不存在 / 没权限 / 不是普通文件，
    // 各自**原因准确 + 带出路**。原先目录会露出 Node 原始的 `EISDIR: illegal operation on a
    // directory, read` —— 既没说"这是目录不是文件"，也没给出路，而"想导整库"的人最容易撞到它 ✗
    const bad = docImport.describeImportSourceProblem(file);
    if (bad) ctx.error(bad.message);
    if (fs.existsSync(path.join(ctx.PROJECTS_DIR, name, name + '.json'))) ctx.error('项目已存在: ' + name + '（换个名字，或先删掉它）');

    let conv;
    try { conv = docImport.docToOutline(file); }
    catch (e) { ctx.error(e.message); return; }

    const built = markdown.markdownToTree(conv.md, 'root');
    const themes = ((built.data && built.data.children) || []);
    const title = ctx.args.title
      || (themes[0] && themes[0].topic)
      || path.basename(file).replace(/\.[^.]+$/, '');
    // PDF 的来源标注（书签 / 文字层）与如实报告 —— 使用者必须看得见这棵树是怎么来的 ✓ 不静默 ✗
    const srcLabel = conv.source === 'text' ? 'pdf·文字层' : conv.source === 'outline' ? 'pdf·书签' : conv.format;
    const notes = Array.isArray(conv.notes) ? conv.notes : [];
    const printNotes = (out) => notes.forEach((n) => out('  · ' + n));

    // 来源指纹：**在预览之前**就算好 —— dry-run 与真导用同一个判据，不各算一套 ✓
    const origin = docImport.makeOrigin({ file: file, md: conv.md, tool: 'import-project' });
    const dup = originHitAcrossStore(ctx, origin);
    // `--force` 的分工（取舍写明）：默认**拒绝**重复，因为"同一份文档悄悄导两次"是不可察觉的污染
    //（第二棵树长得和第一棵不一样，事后无法分辨）；`--force` 是给"我真的要第二份"的显式出口。
    const refused = !!dup && !ctx.args.force;

    if (ctx.args.dryRun) {
      const heads = conv.md.split('\n').filter((l) => /^#{1,6}\s+\S/.test(l)).slice(0, 8);
      const out = {
        ok: true, dryRun: true, project: name, file: file, format: conv.format,
        pdfSource: conv.source || null,
        title: title, stats: conv.stats, themes: themes.length, nodes: built.addedCount || 0,
        notes: notes,
        // 来源指纹与"会不会被拒"也一并预览 —— 否则预览说"能导"、真导被拒，是最烦人的那种落差 ✗
        origin: origin,
        duplicate: dup ? { project: dup.project, id: dup.node.id, topic: dup.node.topic } : null,
        wouldRefuse: refused,
        forced: !!ctx.args.force,
        topHeadings: heads.map((l) => l.replace(/^(#+)\s+/, (m, g) => '#'.repeat(g.length) + ' '))
      };
      if (ctx.args.json) { ctx.outJson(out); return; }
      ctx.out('（--dry-run：只预览，**没有写盘** ✓）');
      ctx.out('格式: ' + srcLabel + ' ｜ 提纲 ' + conv.stats.lines + ' 行 / ' + conv.stats.headings + ' 个标题'
        + ' ｜ 层级分布 ' + JSON.stringify(conv.stats.levelCounts));
      ctx.out('将创建项目「' + name + '」（标题：' + title + '）：' + themes.length + ' 个顶层主题 / '
        + (built.addedCount || 0) + ' 个节点');
      if (conv.source) ctx.out('来源: ' + (conv.source === 'text' ? '文字层（这份 PDF 没有书签 ✓ 已自动回退）' : 'PDF 书签'));
      ctx.out('来源指纹: ' + docImport.describeOrigin(origin));
      if (dup) {
        ctx.out('⚠ 这份文档已经导入过：项目 ' + dup.project + ' 的节点 ' + dup.node.id
          + (ctx.args.force ? '（已给 --force ⇒ 仍会再建一棵）' : '（真导会被拒；真要再建一棵加 --force）'));
      }
      printNotes(ctx.out);
      ctx.out('前几个顶层主题：');
      themes.slice(0, 10).forEach((t) => ctx.out('  · ' + t.topic));
      return;
    }

    // ---- 幂等闸门（本批核心）：同一 src + 同一 sha256 二次导入 ⇒ 拒绝并**指名**上次导到哪 ----
    if (refused) ctx.error(duplicateOriginError('项目 ' + dup.project + ' 的节点 ' + dup.node.id, dup.node.origin));

    const data = {
      meta: { name: title, author: '', version: MMConfig.APP_VERSION, formatVersion: 2 },
      format: 'node_tree',
      // origin 挂在**这棵树的根**上：一次导入只留一个来源痕（不是每个节点都抄一遍 ⇒ 文件不膨胀）。
      // 它记的是"这棵树从哪一份文档、哪一次导入来"，是"这份文件导过没有"的唯一判据 ✓
      data: { id: 'root', topic: title, expanded: true, origin: origin, children: themes }
    };
    ctx.write(data);   // 一次写入（原子）⇒ 不会留下半个项目 ✓
    ctx.out('已从 ' + path.basename(file) + '（' + srcLabel + '）创建项目「' + name + '」：'
      + themes.length + ' 个顶层主题 / ' + (built.addedCount || 0) + ' 个节点'
      + (ctx.args.force && dup ? '（--force：这是同一个来源的第 2 份）' : ''));
    ctx.out('来源指纹: ' + docImport.describeOrigin(origin));
    printNotes(ctx.out);
    ctx.out('打开：node cli/mm-cli.js read ' + name + ' --brief');
  },

  /**
   * 批 5：**整库导入** —— 一个**目录** → 新项目 + 一棵"与文件夹同构"的树。
   *
   * 与 `import-project` 的区别（两者都是"从零建项目"）：
   *   · `import-project`：**一个文件** → 一棵树（文件里的 1 级标题成为顶层主题）；
   *   · `import-dir`：**一个目录** → 一棵**与文件夹同构**的树 —— **每一级子目录 = 一个容器节点**，
   *     每个文件 = 该容器下的一个文件节点（标题取**文件名去扩展名**），文档自己的标题在它下面。
   *     取舍与理由写在 `src/doc-import.js` 的 ⓪‴ 段（那里是唯一权威，本处不复述）。
   *
   * 硬约束（照本工程既有规矩）：
   *   · **建树只有一条路**：`docToOutline`（文件 → 提纲）+ `markdownToTree`（提纲 → 子树）；
   *     本命令只做"走参数 → 调 src/ 纯逻辑 → 输出"，一行格式解析都不写 ✗；
   *   · **一次 `ctx.write`**：整棵树先在内存里建好 ⇒ 中途失败不留半个项目 ✓；
   *   · **闸门一律在写盘之前**：入参 / 体量 / 文件数 / 幂等 四道，全在先 ✓；
   *   · `--dry-run` **绝不写盘**，并如实报告"会不会被拒"（预览说能导、真导被拒是最烦人的落差 ✗）。
   */
  importDir(ctx) {
    const name = ctx.projectName;
    if (!name) ctx.error('缺少项目名');
    const dir = ctx.args._[1];
    if (!dir) ctx.error('用法: import-dir <新项目名> <目录> [--title 标题] [--ext md,txt] '
      + '[--max-files N] [--dry-run] [--force]');
    // ① 入参闸门：整库导入要的是**目录**（给成文件 / 不存在 / 没权限 ⇒ 各自原因准确 + 给出路）
    const bad = docImport.describeImportDirProblem(dir);
    if (bad) ctx.error(bad.message);
    if (fs.existsSync(path.join(ctx.PROJECTS_DIR, name, name + '.json'))) {
      ctx.error('项目已存在: ' + name + '（换个名字，或先删掉它）');
    }
    // ② 范围与上限：**读任何文件之前**就定下来（`--ext` 非法值是当场报错，不静默退成默认 ✗）
    const extRes = ctx.args.ext === undefined
      ? { ok: true, ext: docImport.IMPORT_EXT_DEFAULT.slice() }
      : docImport.normalizeExtList(ctx.args.ext);
    if (!extRes.ok) ctx.error('--ext ' + extRes.reason);
    const maxFiles = ctx.intOption('maxFiles', { min: 1, max: 100000, def: docImport.MAX_IMPORT_FILES_DEFAULT });
    // ③ 扫描（**只读**：走查目录、逐类计数跳过、算总量；不读文件内容、不写盘、不建树）
    const scan = docImport.scanImportDir(dir, { ext: extRes.ext });
    if (!scan.totals.files) ctx.error(docImport.describeNoImportableFiles(scan.root, scan));
    const overFiles = scan.totals.files > maxFiles;
    const overSize = !overFiles && scan.totals.bytes > docImport.MAX_SOURCE_BYTES;
    const limitMsg = overFiles
      ? docImport.describeTooManyFiles(scan.totals.files, maxFiles, scan.root)
      : overSize ? docImport.describeDirOversize(scan.root, scan.totals.bytes, docImport.MAX_SOURCE_BYTES) : null;

    // ④ 转换 + 建树（**整棵树在内存里建好**）。超限时**不转换** —— 反正马上要拒，
    //    没必要把几十 MB 读进内存（那正是体量闸门要防的事 ✗）
    const built = limitMsg ? null : docImport.buildDirImportTree(scan, { tool: 'import-dir' });
    const skipped = (scan.skipped || []).concat(built ? built.skipped : []);
    const counts = docImport.groupSkips(skipped);
    // 扫得到文件、但**一个都没转换成功**（全是坏文件/全空）⇒ 与"目录里没有可导入的文件"同一处理：
    // 响亮拒绝，绝不建一个空项目 ✗
    if (built && !built.files) {
      ctx.error(docImport.describeNoImportableFiles(scan.root,
        Object.assign({}, scan, { skipped: skipped, counts: counts })));
    }
    const byFormat = { md: 0, txt: 0, docx: 0, pdf: 0 };
    if (built) built.entries.forEach((e) => { if (byFormat[e.format] !== undefined) byFormat[e.format]++; });
    const manifest = docImport.makeDirOrigin({ dir: scan.root, entries: built ? built.entries : [] });
    // ⑤ 幂等闸门（写盘之前，两档一起看）：
    //    · **整库级**：项目根上那份**目录清单指纹** ⇒ 同一个目录重复导**整体拒绝**（推荐的那档：
    //      "重复导入不可察觉的污染"；按文件粒度跳过会在每一条上都要人自己判断，反而更容易漏）；
    //    · **文件级**：任一文件已被**别的命令/别的项目**导过（同 src + 同 sha256）⇒ 也拒绝并指名。
    const index = built ? originIndexAcrossStore(ctx) : null;
    const dup = (built && index.get(docImport.originKey(manifest))) || null;
    const collisions = [];
    if (built) {
      built.entries.forEach((e) => {
        const hit = index.get(docImport.originKey(e.origin));
        if (hit) collisions.push({ rel: e.rel, project: hit.project, id: hit.node.id, topic: hit.node.topic });
      });
    }
    const forced = !!ctx.args.force;
    const refused = !!(dup || collisions.length) && !forced;

    const title = ctx.args.title || path.basename(scan.root) || name;
    const dirRef = docImport.sourceRef(scan.root);
    // 顶层一览（**从扫描结果算**，与"这次有没有转换"无关 ⇒ 超限预览也给得出）
    const topLevel = [];
    const countIn = (node) => node.files.length + node.dirs.reduce((n, d) => n + countIn(d), 0);
    scan.tree.dirs.forEach((d) => topLevel.push({ topic: d.name, kind: 'dir', files: countIn(d) }));
    scan.tree.files.forEach((f) => topLevel.push({
      topic: f.name.replace(/\.[^.]+$/, ''), kind: 'file', files: 1
    }));
    const containers = built ? built.containers : scan.containers;
    const filesImported = built ? built.files : scan.totals.files;
    const nodes = built ? built.nodes : null;

    /** 逐类跳过计数（**报告的一部分，不许省** ✗）—— 两种输出格式共用同一份数据 */
    const printSkips = (out) => {
      const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      if (!keys.length) { out('跳过 0 项'); return; }
      out('跳过 ' + skipped.length + ' 项（按原因分组）：'
        + keys.map((k) => (docImport.SKIP_SHORT[k] || k) + ' ' + counts[k]).join(' / '));
      skipped.slice(0, 20).forEach((s) => out('  · ' + s.rel + ' —— '
        + (docImport.SKIP_LABEL[s.reason] || s.reason) + (s.message ? '：' + s.message : '')));
      if (skipped.length > 20) out('  · …另有 ' + (skipped.length - 20) + ' 项（`--json` 里有全部）');
      const more = Object.keys(scan.otherImportableExt).sort();
      if (more.length) {
        out('  ⚠ 另有可导入但被 `--ext` 排除的文件：'
          + more.map((e) => e + ' ' + scan.otherImportableExt[e] + ' 个').join(' / ')
          + ' ⇒ 想一起导就加 `--ext '
          + scan.ext.concat(more).map((e) => e.replace(/^\./, '')).join(',') + '`');
      }
    };
    const printLimit = (out) => {
      if (!limitMsg) return;
      out('⚠ 总量超限：' + (overFiles ? '可导入文件 ' + scan.totals.files + ' 个 > 上限 ' + maxFiles + ' 个'
        : '合计 ' + Math.round(scan.totals.bytes / 1048576 * 100) / 100 + ' MB > 上限 ' + docImport.MAX_SOURCE_MB + ' MB'));
    };
    const topBrief = '顶层 ' + scan.tree.dirs.length + ' 个目录 / ' + scan.tree.files.length + ' 个文件'
      + (topLevel.length ? '：' + topLevel.slice(0, 12).map((t) => t.topic + (t.kind === 'dir' ? '/' : '')).join(' ') : '');

    const report = {
      ok: true, dryRun: !!ctx.args.dryRun, project: name, dir: dir, dirRef: dirRef, title: title,
      ext: scan.ext, maxFiles: maxFiles,
      containers: containers, files: filesImported, nodes: nodes,
      formats: byFormat, topLevel: topLevel,
      skippedCount: skipped.length, skippedByReason: counts, skippedDetail: skipped.slice(0, 200),
      size: {
        bytes: scan.totals.bytes, mb: Math.round(scan.totals.bytes / 1048576 * 100) / 100,
        limitMB: docImport.MAX_SOURCE_MB, over: scan.totals.bytes > docImport.MAX_SOURCE_BYTES
      },
      fileCount: { count: scan.totals.files, limit: maxFiles, over: overFiles },
      origin: manifest,
      entries: built ? built.entries.map((e) => ({
        rel: e.rel, id: e.id, topic: e.topic, sha256: e.sha256, format: e.format
      })) : [],
      duplicate: dup ? { project: dup.project, id: dup.node.id, topic: dup.node.topic } : null,
      collisions: collisions.slice(0, 50),
      converted: !!built,
      wouldRefuse: refused || !!limitMsg,
      refuseReason: limitMsg ? (overFiles ? 'over-max-files' : 'over-size')
        : (dup ? 'duplicate-dir' : (collisions.length ? 'duplicate-file' : null)),
      forced: forced
    };

    if (ctx.args.dryRun) {
      if (ctx.args.json) { ctx.outJson(report); return; }
      ctx.out('（--dry-run：只预览，**没有写盘** ✓ —— 预览会**真的读一遍**这些文件来算来源指纹，'
        + '与真导用同一份判据，不各算一套）');
      ctx.out('整库导入：' + dirRef + '  →  新项目「' + name + '」（标题：' + title + '）');
      ctx.out('范围：' + scan.ext.join(' / ') + '（`--ext` 可覆盖）│ 文件数上限 ' + maxFiles
        + '（`--max-files` 可覆盖）│ 体量上限 ' + docImport.MAX_SOURCE_MB + ' MB（与单文件共用一份常量）');
      ctx.out('将建：' + containers + ' 个容器节点（目录）'
        + (built ? ' / ' + filesImported + ' 个文件子树 / 合计 ' + nodes + ' 个节点'
          : ' / ' + scan.totals.files + ' 个文件候选（**超限 ⇒ 没有转换**）'));
      ctx.out('体量：' + report.size.mb + ' MB（' + scan.totals.bytes + ' 字节）'
        + (report.size.over ? ' —— ⚠ **超限**' : ' —— 未超限 ✓'));
      ctx.out('格式分布：' + Object.keys(byFormat).filter((k) => byFormat[k]).map((k) => k + ' ' + byFormat[k]).join(' / ')
        + (Object.keys(byFormat).some((k) => byFormat[k]) ? '' : '（还没转换）'));
      printLimit(ctx.out);
      printSkips(ctx.out);
      ctx.out(topBrief);
      ctx.out('来源指纹：' + docImport.describeOrigin(manifest));
      if (dup) {
        ctx.out('⚠ 这个目录已经导入过：项目 ' + dup.project + ' 的节点 ' + dup.node.id
          + (forced ? '（已给 --force ⇒ 仍会再建一棵）' : '（真导会被拒；真要再建一棵加 --force）'));
      }
      if (collisions.length) {
        ctx.out('⚠ 其中 ' + collisions.length + ' 个文件已经导入过：'
          + collisions.slice(0, 5).map((c) => c.rel + ' → 项目 ' + c.project + ' 的节点 ' + c.id).join('；')
          + (collisions.length > 5 ? ' 等' : '') + (forced ? '' : '（真导会被拒）'));
      }
      return;
    }

    // ---- 真导：闸门全部在写盘之前 ----
    if (limitMsg) { ctx.error(limitMsg); return; }
    if (refused) {
      const head = dup
        ? duplicateOriginError('项目 ' + dup.project + ' 的节点 ' + dup.node.id, dup.node.origin) : '';
      const coll = collisions.length
        ? '这个目录里有 ' + collisions.length + ' 个文件已经被导入过：'
          + collisions.slice(0, 5).map((c) => c.rel + ' → 项目 ' + c.project + ' 的节点 ' + c.id).join('；')
          + (collisions.length > 5 ? ' 等' : '')
          + '。**同一个文件再导一次**会得到第二棵不相交的子树（节点 id 由"时间+随机"生成，内容相同的两棵也不会重合）'
          + '；确实想要第二份：加 --force（若想改的是已有的那一份，请直接 edit 那些节点）' : '';
      ctx.error([head, coll].filter(Boolean).join(' '));
      return;
    }

    const data = {
      meta: { name: title, author: '', version: MMConfig.APP_VERSION, formatVersion: 2 },
      format: 'node_tree',
      // origin 挂在树的根上 = 这一份**目录清单指纹**（"这个目录导过没有"的唯一判据）；
      // 每个文件节点另带自己的 origin（"这个文件导过没有"）—— 两个粒度各留一条痕 ✓
      data: { id: 'root', topic: title, expanded: true, origin: manifest, children: built.children }
    };
    ctx.write(data);   // 一次写入（原子）⇒ 不会留下半个项目 ✓
    if (ctx.args.json) { ctx.outJson(report); return; }
    ctx.out('已整库导入 ' + dirRef + ' → 项目「' + name + '」：' + containers + ' 个容器节点 / 导入了 '
      + filesImported + ' 个文件 / 合计 ' + nodes + ' 个节点'
      + (forced && (dup || collisions.length) ? '（--force：这是同一个来源的第 2 份）' : ''));
    printSkips(ctx.out);
    ctx.out('来源指纹：' + docImport.describeOrigin(manifest));
    ctx.out('打开：node cli/mm-cli.js read ' + name + ' --brief');
  },

  importMd(ctx) {
    const file = ctx.args._[1];
    if (!file) ctx.error('缺少 Markdown 文件路径');
    // 入参闸门（同 import-project，同一份实现）：目录 ⇒ 明确说"这是目录不是文件" + 给出路 ✓
    const bad = docImport.describeImportSourceProblem(file);
    if (bad) ctx.error(bad.message);
    const tooBig = docImport.describeOversizeSource(file);
    if (tooBig) ctx.error(tooBig.message);
    // ⚠️ 读到手的原文**必须先过 `normalizeOutline`**（CRLF→LF + 剥 BOM）再拿去建树与算指纹 ——
    // 与 `import-project`（docToOutline 里同一处调用）**共用同一份规范化**。
    // 不这么做的实测后果（2026-10-10 取证）：带 BOM 的 md（Windows 上编出来的极常见）
    // 经本命令导入后**整个第一个标题被静默吃掉** ——
    //   `# 第一本书 / 正文一 / # 第二本书 / 正文二` ⇒ 树里只剩「第二本书」（新增 1 个节点）；
    //   同一份内容去掉 BOM ⇒ 两个标题都在 ✓。
    // 根因：`markdown.js` 的 `detectMode` 要求「首行是 `#`」，而 BOM 让首行匹配不上 ⇒
    // 第一个 `#` 标题被当成正文（后面每个标题正常）⇒ 丢的恰好是**第一棵子树**，
    // 而命令照样打印"导入完成" ⇒ 正是本工程最忌讳的"静默给出错误结果" ✗。
    // `import-project` 没有这个缺陷（它走 docToOutline，那里第 356 行就剥了 BOM）——
    // 也就是说同一份 BOM 文件经两条导入路径会得到**两棵不同的树**，这本身就是个缺陷。
    const raw = fs.readFileSync(file, 'utf8');
    const md = docImport.normalizeOutline(raw);
    const parent = ctx.args.parent || 'root';
    // 预读一次：让"父节点不存在"这条错误**先于**转换与写入报出来（保持原有报错顺序）
    const pre = ctx.read();
    if (!ctx.tree.find(pre.data.data, parent)) ctx.error('父节点不存在: ' + parent);
    // 来源指纹 + 幂等闸门：只看**本项目**（这条命令是追加到已有项目，看不到别处；要看全库用
    // import-project —— 它按同一判据扫全部项目）。判据只在 docImport.originMatches 一处 ✓
    // 指纹算的是**规范化后**的正文（两侧一致）：BOM/CRLF 不改变指纹 ⇒ "同一份内容"不会被误判成两份 ✓
    const origin = docImport.makeOrigin({ file: file, md: md, tool: 'import-md' });
    const dup = originHitIn(pre.data.data, origin);
    if (dup && !ctx.args.force) ctx.error(duplicateOriginError('本项目 ' + ctx.projectName + ' 的节点 ' + dup.id, dup.origin));
    // **转换只做一次**并捕获进闭包：fn 里禁止 I/O，且并发重放不该重新生成一遍节点 id。
    // 这使本命令的并发语义与 `add`（同一种"往某父节点下加内容"）完全一致：
    // 别人改的是**别的对象**时自动叠到最新版，撞同一个父节点时才拒绝。
    const r = markdown.markdownToTree(md, parent);
    const added = r.data.children || [];
    // 来源痕挂在**这次导入产生的每棵子树的根**上（= `added` 的每一项）：
    // 条数 = 一次导入里的顶层主题数，而不是节点数 ⇒ 代价极低，但"这份文件导过没有"一眼可查 ✓
    added.forEach((n) => { if (n && typeof n === 'object') n.origin = origin; });
    ctx.mutate((cur) => {
      const parentNode = ctx.tree.find(cur.data, parent);
      // 读之后父节点被别人删了（罕见）⇒ 报错而不是凭空造一个父节点出来
      if (!parentNode) throw new Error('父节点在并发改动后已不存在: ' + parent);
      parentNode.children = (parentNode.children || []).concat(added);
      return cur;
    });
    ctx.out('导入完成，新增 ' + r.addedCount + ' 个节点（父节点 ' + parent + '）'
      + (ctx.args.force && dup ? '（--force：这是同一个来源的第 2 份）' : ''));
    ctx.out('来源指纹: ' + docImport.describeOrigin(origin));
  },

  exportMd(ctx) {
    const dir = ctx.args._[1];
    if (!dir) ctx.error('缺少输出目录路径（导出为文件夹：md + 图片 + 附件）');
    const { data } = ctx.read();
    const outDir = path.resolve(dir);
    fs.mkdirSync(outDir, { recursive: true });
    // 1) 复制项目资源（assets/ 图片 + attachments/ 附件）→ 输出目录
    const copyTree = (src, dst) => {
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(dst, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach((e) => {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) copyTree(s, d);
        else fs.copyFileSync(s, d);
      });
    };
    copyTree(path.join(ctx.PROJECTS_DIR, ctx.projectName, 'assets'), path.join(outDir, 'assets'));
    copyTree(path.join(ctx.PROJECTS_DIR, ctx.projectName, 'attachments'), path.join(outDir, 'attachments'));
    // 2) 生成 Markdown（相对路径链接图片与附件）
    const md = markdown.treeToMarkdown(data.data, {
      format: ctx.args.format === 'list' ? 'list' : 'heading',
      withDetail: !!ctx.args.withDetail,
      withResources: true
    });
    const mdFile = path.join(outDir, ctx.projectName + '.md');
    fs.writeFileSync(mdFile, md, 'utf8');
    const nodes = tree.count(data.data);
    ctx.out('已导出文件夹: ' + outDir + '（' + ctx.projectName + '.md，' + nodes + ' 节点，含 assets/ 与 attachments/）');
  },

  /**
   * 静态导出：项目 → 可分享/可部署的静态站点（index.html + assets/ + attachments/）。
   *
   * 与 export-md / export-json 的分工：
   *   export-md    → 给编辑器/AI 读的 Markdown
   *   export-json  → 单文件无损备份与跨机迁移（aimap v1）
   *   export-html  → 给**人看**的只读站点（本命令）
   * HTML 生成是纯逻辑（src/export-html.js，有单测）；本命令只负责复制资源与落盘。
   */
  exportHtml(ctx) {
    const dir = ctx.args._[1];
    if (!dir) ctx.error('缺少输出目录路径（生成 index.html + assets/ 的静态站点）');
    const { data } = ctx.read();
    const outDir = path.resolve(dir);
    fs.mkdirSync(outDir, { recursive: true });

    const html = exportHtml.buildIndexHtml(data, { projectName: ctx.projectName });
    fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

    // 复制图片与附件（保持相对路径结构；index.html 里的链接即这些相对路径）
    const refs = exportHtml.collectAssets(data);
    const missing = [];
    let copied = 0;
    refs.forEach((rel) => {
      const src = path.join(ctx.PROJECTS_DIR, ctx.projectName, rel);
      if (!fs.existsSync(src)) { missing.push(rel); return; }
      const dst = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied++;
    });

    const nodes = tree.count(data.data);
    ctx.out('已导出静态站点: ' + outDir + '（index.html，' + nodes + ' 节点，'
      + copied + ' 个资源'
      + (missing.length ? '；缺失资源 ' + missing.length + ' 个: ' + missing.slice(0, 5).join(', ') : '')
      + '）');
  },

  /* ================= JSON 打包（aimap v1：单文件，图片+附件 base64 内嵌） ================= */
  exportJson(ctx) {
    const file = ctx.args._[1];
    if (!file) ctx.error('缺少输出文件路径');
    const { data } = ctx.read();
    // 收集节点引用的图片与附件 → base64 内嵌；键为相对路径（assets/x.png / attachments/x.md）
    const assets = {};
    const missing = [];
    bundle.collectResourceRefs(data.data).forEach((ref) => {
      const p = path.join(ctx.PROJECTS_DIR, ctx.projectName, ref.file);
      if (fs.existsSync(p)) assets[ref.file] = fs.readFileSync(p).toString('base64');
      else missing.push(ref.file);
    });
    const pack = bundle.buildBundle(data, assets);
    fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8');
    const nodes = tree.count(data.data);
    ctx.out('已导出 ' + ctx.projectName + ' → ' + file + '（' + nodes + ' 节点，' + Object.keys(assets).length + ' 个资源内嵌（图片+附件）'
      + (missing.length ? '；缺失资源: ' + missing.join(', ') : '') + '）');
  },

  importJson(ctx) {
    const file = ctx.args._[0];
    if (!file) ctx.error('缺少 aimap JSON 文件路径');
    if (!fs.existsSync(file)) ctx.error('文件不存在: ' + file);
    // 结构解析（含 BOM 剥离）已下沉到 src/bundle.js，规则可被单测锁住
    const parsed = bundle.parseBundle(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) ctx.error(parsed.error);
    const pack = parsed.bundle;
    const name = String(ctx.args.name || pack.meta.name).trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) ctx.error('非法项目名: ' + name);
    // 数据校验闸门（与保存同源）。
    // selfProject = name 是**恢复备份的关键**：备份里的链接/关联成员多半指向这个项目自己
    // （同项目链接也带显式 project 字段），而恢复时它在磁盘上恰恰**不存在** ——
    // 不告诉校验器"这份数据就是 name 项目"，就会把整个备份判成悬挂链接而拒绝导入。
    // 实测：删除项目后导入它自己的备份 → "悬挂链接: 项目不存在 p1"，备份形同废纸。
    const v = ctx.schema.validateProject(
      { meta: pack.meta, format: pack.format || 'node_tree', data: pack.data, assoc: pack.assoc },
      ctx.PROJECTS_DIR, name);
    if (!v.ok) ctx.error('数据校验失败: ' + v.errors.join('; '));
    const targetDir = path.join(ctx.PROJECTS_DIR, name);
    if (fs.existsSync(path.join(targetDir, name + '.json'))) {
      ctx.error('项目已存在: ' + name + '（可用 --name 指定新项目名）');
    }
    // 解包资源（防路径穿越：资源路径必须解析在项目目录**内部**）
    if (pack.assets && typeof pack.assets === 'object') {
      const keys = Object.keys(pack.assets);
      keys.forEach((k) => {
        if (!bundle.isSafeRelPath(targetDir, k)) ctx.error('非法资源路径: ' + k);
      });
      keys.forEach((k) => {
        const p = path.resolve(targetDir, k);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // 资源同样原子落盘（避免半截文件被后续引用）
        ctx.store.writeFileAtomic(p, Buffer.from(pack.assets[k], 'base64'));
      });
    }
    // 项目 JSON 是「提交点」，最后写：走 store.write（校验闸门 + 原子写）
    const outData = { meta: pack.meta, format: pack.format || 'node_tree', data: pack.data };
    // 关联笔记是项目级集合，不属于节点树 —— 漏掉它会让"无损备份"静默丢数据
    if (Array.isArray(pack.assoc) && pack.assoc.length) outData.assoc = pack.assoc;
    // 走 store.write（不经 ctx.write）：这是"用这个文件新建一个项目"，与既有数据没有
    // "读→改→写"关系，所以**不该**参与并发合并（也没有 expectVersion 可声明）。
    // 但**要把"谁在写"传下去** —— 否则变更日志里这条会显示成 `unknown`（实测发现的漏洞）。
    ctx.store.write(name, outData, { writer: ctx.writer });
    let nodes = 0, imgs = 0, files = 0;
    tree.walk(pack.data, (n) => {
      nodes++;
      imgs += (n.images || []).length;
      files += (n.files || []).length;
    });
    ctx.out('已导入: ' + name + '（' + nodes + ' 节点，' + imgs + ' 个图片引用，' + files + ' 个附件引用，'
      + (pack.assets ? Object.keys(pack.assets).length : 0) + ' 个资源解包）');
  },

  /** 主题布局：meta.layout = { left: [主题id], right: [主题id] }，决定顶层主题在导图中的左右分侧。
   *  不写侧 = 该主题保持 jsMind 默认（右侧）。渲染层据此刻画 direction。 */
  themeLayout(ctx) {
    const left = ctx.args.left;
    const right = ctx.args.right;
    if (!left && !right && !ctx.args.clear) ctx.error('缺少 --left 或 --right（--clear 清除布局）');
    const { data } = ctx.read();
    const kidSet = new Set((data.data.children || []).map((c) => c.id));
    const parse = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
    const layout = {};
    if (left) {
      const ids = parse(left);
      ids.forEach((id) => { if (!kidSet.has(id)) ctx.error('不是顶层主题: ' + id); });
      layout.left = ids;
    }
    if (right) {
      const ids = parse(right);
      ids.forEach((id) => { if (!kidSet.has(id)) ctx.error('不是顶层主题: ' + id); });
      layout.right = ids;
    }
    if (layout.left && layout.right) {
      const dup = layout.left.filter((id) => layout.right.includes(id));
      if (dup.length) ctx.error('同一主题不能同时出现在左右两侧: ' + dup.join(','));
    }
    // 布局对象在 fn 外算好（校验也用预读的顶层主题列表 ⇒ 报错顺序不变）；
    // 写入走 `ctx.mutate`：别人改的是**节点**（与 meta 不相交）时不再整体失败。
    let written = null;
    ctx.mutate((cur) => {
      if (ctx.args.clear) {
        if (cur.meta) delete cur.meta.layout;
      } else {
        cur.meta = cur.meta || { name: ctx.projectName, version: MMConfig.APP_VERSION, formatVersion: 2 };
        cur.meta.layout = layout;
      }
      written = JSON.parse(JSON.stringify((cur.meta && cur.meta.layout) || {}));
      return cur;
    });
    ctx.out('已设置主题布局: ' + JSON.stringify(written || {}));
  },

  validate(ctx) {
    const target = ctx.projectName;
    if (!target) ctx.error('缺少项目名或 JSON 文件路径');
    // 项目名 或 文件路径（含 .tmp 等任意扩展名——主进程保存前校验临时文件依赖此）
    const file = fs.existsSync(target)
      ? target
      : path.join(ctx.PROJECTS_DIR, target, target + '.json');
    if (!fs.existsSync(file)) ctx.error('找不到项目: ' + target);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 自项目推断：主进程保存前校验的是 `projects/<项目>/<项目>.json.<pid>.validate`
    // 这类**同目录临时文件**（见 main.js），父目录名就是项目名。据此让"同项目成员"
    // 以这份待写数据为准 —— 否则界面删掉被引用的节点后，第一次保存会因为闸门看的是
    // 磁盘旧态而放行，第二次保存才突然被拒（实测），用户完全看不懂。
    // 不在项目根内的文件（如 import 的临时包）推断不出项目名，退回纯读盘校验。
    const absFile = path.resolve(file);
    const absRoot = path.resolve(ctx.PROJECTS_DIR);
    const selfProject = absFile.indexOf(absRoot + path.sep) === 0
      ? path.basename(path.dirname(absFile)) : null;
    const v = ctx.schema.validateProject(data, ctx.PROJECTS_DIR, selfProject);
    if (ctx.args.json) ctx.outJson({ ok: v.ok, errors: v.errors });
    else if (v.ok) ctx.out('校验通过: ' + target);
    else ctx.out('error: 校验失败: ' + v.errors.join('; '));
    // --json 分支此前**不设退出码** —— 于是 validate --json 遇到坏数据也返回 0，
    // 与文本分支行为不一致。退出码必须由"校验结果"决定，与输出格式无关。
    if (!v.ok) process.exitCode = 1;
  },

  validateAll(ctx) {
    const list = ctx.store.list();
    let bad = 0;
    list.forEach((p) => {
      const data = JSON.parse(fs.readFileSync(p.file, 'utf8'));
      const v = ctx.schema.validateProject(data, ctx.PROJECTS_DIR, p.name);
      if (!v.ok) { bad++; ctx.out('FAIL ' + p.name + ': ' + v.errors.join('; ')); }
      else ctx.out('OK   ' + p.name);
    });
    ctx.out(bad ? bad + ' 个项目校验失败' : '全部 ' + list.length + ' 个项目校验通过');
    if (bad) process.exitCode = 1;
  },

  /**
   * 界面未保存编辑查询（写前协调信号）。
   *
   * 与 `validate` 的关系：这是**事前**协调（"现在动笔会不会和人的未保存编辑打架"），
   * validate 是**事后**闸门（"我写的数据合法吗"）。两者都要，缺事前协调就会出现
   * "AI 写完、人一保存把 AI 的改动覆盖掉"的白做工（L3 冲突规则见 README）。
   *
   * 不带项目名 → 汇总所有有状态文件的（AI 在不确定当前是哪个项目时先跑这个）。
   */
  uiState(ctx) {
    const uiState = require('../../src/ui-state.js');
    const read = (name) => uiState.readProjectState(fs, path, ctx.PROJECTS_DIR, name);
    if (ctx.projectName) {
      const s = read(ctx.projectName);
      if (ctx.args.json) { ctx.outJson(s); return; }
      ctx.out(ctx.projectName + ': ' + (s.dirty ? 'DIRTY（有未保存编辑）' : 'clean')
        + ' · ' + s.note);
      return;
    }
    const names = ctx.store.list().map((p) => p.name);
    const all = names.map(read);
    if (ctx.args.json) { ctx.outJson({ projects: all }); return; }
    if (!all.length) { ctx.out('（没有项目）'); return; }
    all.forEach((s) => ctx.out((s.dirty ? 'DIRTY ' : 'clean ') + s.project + ' · ' + s.note));
    const dirty = all.filter((s) => s.dirty).map((s) => s.project);
    ctx.out(dirty.length
      ? '⚠ 有未保存编辑的项目: ' + dirty.join(', ') + ' —— 先请用户在界面里保存（或确认丢弃）再写入'
      : '全部项目界面均无未保存编辑 —— 可以安全写入');
  }
};
