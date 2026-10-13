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
const itemIndex = require('../../src/item-index.js');   // 条目层的长度/预算常量与视图（契约 §3.4：常量只在 src/item-index.js）
const heat = require('../../src/heat.js');         // 热度向量：三条上限 + 名次→档位 + 窄查询（口径只在 src/heat.js）
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

/* ---------------- 【W19】资源引用的落地与报告（三条导入路共用同一份） ----------------
 * 分工：`src/markdown.js` 的 `resolveImportRefs` 只回答"这条引用解析成什么样、要不要复制、复制成什么"；
 * **怎么说给人听**是命令层的事（与 origin 的 `describeOrigin` 同一个分工）。
 * 三条命令（import-md / import-project / import-dir）在下方各有一处调用 —— 解析与落地**只有那一份实现** ✓。
 * `import-dir` 的**口径**（`onMissing:'detail'`：坏引用按正文保留、不阻断，但逐条点名）与理由写在
 * `src/doc-import.js` 的 ⓪⁗ 契约段（那里是唯一权威，本处不复述）。 */

/** 传给 `resolveImportRefs` 的**项目侧**参数（与"相对谁解析"无关的那一半）。
 *  为什么单列一层：三条命令都要 `projectDir` + 两个**惰性**目录函数，而基准目录有两种来源
 *  （单文件命令给文件、整库导入给"该文件所在目录"）—— 拼路径的地方只留这一处，不各写一套 ✓。 */
function refResolveOptsAt(ctx, name, baseDir) {
  return {
    baseDir: baseDir,                                 // 相对引用的基准目录（单文件 = 该文件所在目录）
    projectDir: ctx.store.projectDir(name),
    assetDir: () => ctx.store.assetDir(name),
    attachmentDir: () => ctx.store.attachmentDir(name)
  };
}

/** 传给 `resolveImportRefs` 的公共参数（两条单文件命令的差别只有"往哪个项目里落"）。
 *  ⚠️ `assetDir` / `attachmentDir` 传**函数**：它们内部会 `mkdirSync`，惰性调用才能保证
 *  "拒绝了/只是预览"时**一个目录都不建**（项目内目录的单源在 `src/data-store.js`，这里不拼路径）。 */
function refResolveOpts(ctx, name, file) {
  return refResolveOptsAt(ctx, name, path.dirname(path.resolve(file)));
}

/** 【批6】整库导入的资源引用口径（`dirRefReportJson` 的报告字段与 `resolveDirImportRefs` 的实参
 *  **共用这一个字面量** —— 否则会出现"报告说按正文保留、实际传的却是拒绝"这种两头各说一套 ✗）。
 *  为什么整库选 `detail` 而单文件命令选 `refuse`：见 `src/doc-import.js` 的 ⓪⁗ 契约段（唯一权威）。 */
const DIR_REF_ON_MISSING = 'detail';

/** 【批6】整库导入的资源引用：**逐文件**调同一个 `resolveImportRefs`（唯一实现，与上面两条命令同一个函数）。
 *  两个差别，都写得出理由：
 *   · **逐文件**而不是整棵一次：引用是相对**该 md 文件**解析的，每个文件各有一个 `baseDir`
 *     （`buildDirImportTree` 的 `refTargets` 就是为此交出来的落点清单）；
 *   · 口径固定 `onMissing:'detail'`：整库不该为一条坏引用全灭 —— 坏引用逐条点名 + 按正文保留，
 *     理由与代价写在 `src/doc-import.js` 的 ⓪⁗ 契约段（唯一权威，本处不复述）。
 *  ⚠️ 调用点必须在**闸门之后**：被拒（超限 / 重复导入）时**一个资源文件都不复制** ✓。 */
function resolveDirImportRefs(ctx, name, built, dryRun) {
  if (!built) return [];
  return (built.refTargets || []).map((t) => {
    const rep = markdown.resolveImportRefs(t.node, Object.assign(
      { onMissing: DIR_REF_ON_MISSING, dryRun: !!dryRun }, refResolveOptsAt(ctx, name, t.baseDir)));
    /* ⚠️ 不变量：口径写死成 `detail` ⇒ 这里**不可能**拿到 `ok:false`。
     * 为什么必须当场拦（而不是"反正不会发生"）：`ok:false` 时那个函数**什么都不改**（不复制、不摘引用、
     * 不降级成正文）⇒ 若照旧往下走，报告会说"已按正文保留"（**假话**），而盘上留下的恰好是悬空引用 ✗。
     * 真拿到 ⇒ 要么口径被改成了 `refuse`、要么换了实现：**响亮拒绝**并指回契约段，绝不静默写脏。 */
    if (!rep.ok) {
      ctx.error('整库导入的资源引用口径必须是 ' + DIR_REF_ON_MISSING + '（坏引用按正文保留 + 逐条点名、'
        + '不阻断整库），但 ' + t.rel + ' 的引用解析返回了拒绝（ok:false）⇒ **拒绝写盘**'
        + '（项目文件一个字都不写；坏引用一条都不会被静默写进去）。'
        + '这是内部不变量被破坏：口径与理由见 src/doc-import.js 的 ⓪⁗ 契约段 —— '
        + '"拒绝整份导入"是**单文件**命令的口径，整库导入不该为一条坏引用全灭。');
    }
    return { rel: t.rel, rep: rep };
  });
}

/** 一条坏引用的说明（**哪个节点、哪一条引用、原样路径、为什么没解析到**）——报告与拒绝报文共用。 */
function refIssueLine(r) {
  return '节点「' + r.nodeTopic + '」（' + markdown.KIND_LABEL[r.kind] + '）' + r.raw + ' —— ' + r.reason
    + ((r.candidates || []).length ? '；按序试过：' + r.candidates.join('、') : '');
}

/** 坏引用的**拒绝报文（报错即教程）**：逐条点名 + 给出路 + 说清"一个字都没写"。
 *  为什么默认**拒绝整份导入**（而不是跳过那一条）：跳过 = 那条引用连同它的正文一起消失
 *  （"用户 md 里有、项目里没有"，且难以事后发现）；拒绝则是**干净**的 —— 判据在规划阶段就停，
 *  不复制、不建目录、不写盘，修好再导一次即可，没有任何半成品留在盘上 ✓（响亮 > 静默）。
 *  出路必须具体到命令：光说"文件不存在"等于把问题丢回给调用方（本工程最忌讳的那种报错）。 */
function refBlockedError(report, file) {
  const missing = report.blocked.filter((r) => r.status === 'missing');
  const badExt = report.blocked.filter((r) => r.status === 'bad-ext');
  const lines = [
    '这份文档（' + path.basename(file) + '）里有 ' + report.blocked.length + ' 条资源引用落不到项目里，'
      + '导入**没有写盘**（不会多出一条指向不存在文件的坏引用；项目文件逐字节没动）：',
    report.blocked.map((r) => '  · ' + refIssueLine(r)).join('\n')
  ];
  const dir = path.dirname(path.resolve(file));
  if (missing.length) {
    lines.push('出路（任一）：');
    lines.push('  ① 把文件放到 md 同目录的 assets/（图片）或 attachments/（附件）下 —— 文件名与引用一致'
      + '（' + path.join(dir, 'assets') + ' 或 ' + path.join(dir, 'attachments') + '），再导一次（最省事）；');
    lines.push('  ② 先挂上再导：node cli/mm-cli.js add-image <项目> <节点id> --file <绝对路径> --caption "说明"'
      + '（附件用 add-file），然后把 md 里那几行删掉或改成正文；');
    lines.push('  ③ 那几行本来就不需要：改成远程链接（https://… —— 本工程**不复制**外链，按正文保留、'
      + '不阻断导入）或直接删掉，再导一次。');
  }
  if (badExt.length) {
    lines.push('出路：图片格式只支持 ' + markdown.IMAGE_EXT_TEXT + '（与 add-image 同一条规则）'
      + '—— 先转成 png/webp 再导；或用 add-file 当附件挂（附件不限格式）。');
  }
  lines.push('（--force 不能绕过这道闸：它只用来允许"同一份来源再导一次"。这道闸在**复制与写入之前**，'
    + '所以拒绝时既没有半份项目、也没有多出来的资源文件。）');
  return lines.join('\n');
}

/** 成功导入时的资源回显（**如实报告**）：数字汇总 + 逐条（复制成了什么 / 哪条去了详情）。 */
function printRefReport(out, rep, dry) {
  if (!rep) return;
  if (!rep.refs.length) {
    if (dry) out('资源引用：这份文档里没有图片/附件引用（无）');
    return;
  }
  const parts = [];
  if (rep.copied.length) parts.push((dry ? '将复制 ' : '已复制 ') + rep.copied.length + ' 个文件进项目');
  if (rep.inProject.length) parts.push('已在项目内 ' + rep.inProject.length + ' 条（未复制）');
  if (rep.remote.length) parts.push('非本地引用 ' + rep.remote.length + ' 条（按正文保留）');
  if (rep.dropped.length) parts.push('坏引用 ' + rep.dropped.length + ' 条（按正文保留）');
  if (rep.blocked.length) {
    parts.push('坏引用 ' + rep.blocked.length + ' 条'
      + (rep.onMissing === 'detail' ? '（按正文保留）' : '（**会拒绝整份导入**）'));
  }
  out('资源引用（共 ' + rep.refs.length + ' 条）：' + parts.join('；'));
  rep.refs.forEach((r) => {
    const head = '  · 节点「' + r.nodeTopic + '」（' + markdown.KIND_LABEL[r.kind] + '）' + r.raw;
    if (r.status === 'copy') {
      out(head + ' → ' + (r.dest || markdown.RESOURCE_DIR[r.kind] + '/（真导时生成新文件名）'));
    } else if (r.status === 'in-project') {
      out(head + ' —— 已在项目内，未复制' + (r.file !== r.raw ? '（写法规范化为 ' + r.file + '）' : ''));
    } else if (r.status === 'remote') {
      out(head + ' —— ' + r.reason
        + (dry ? '；真导时**按正文**并入该节点详情' : '；**已按正文**并入该节点详情（未挂进 images/files）'));
    } else {
      out('  · ' + refIssueLine(r) + (dry ? '（真导会被拒绝）' : '；已按正文并入该节点详情'));
    }
  });
  if (dry) out('（以上是**预览**：--dry-run 不复制文件、不建目录、不改任何数据 ✓）');
}

/** 预览用的资源报告（机器可判：`import-project --dry-run --json`）—— 与真导同一份判据。 */
function refReportJson(rep) {
  if (!rep) return null;
  return {
    total: rep.refs.length,
    copy: rep.copied.length,
    inProject: rep.inProject.length,
    remote: rep.remote.length,
    missing: rep.blocked.filter((r) => r.status === 'missing').length,
    badExt: rep.blocked.filter((r) => r.status === 'bad-ext').length,
    blocked: rep.blocked.map((r) => ({
      node: r.nodeId, topic: r.nodeTopic, kind: r.kind, ref: r.raw,
      status: r.status, reason: r.reason, tried: r.candidates
    })),
    items: rep.refs.map((r) => ({ node: r.nodeId, kind: r.kind, ref: r.raw, status: r.status, dest: r.dest }))
  };
}

/* ---------------- 【批6】整库导入的资源报告与回显（按**文件**分组，逐条点名） ----------------
 * 为什么另给一份而不是复用上面两个：那两个是"**一份**文档"的视图（总数 + 一张清单）。
 * 整库导入是 N 份文档 ⇒ 每条都必须回答"**这是哪个文件里的引用**"，否则报告指不回源文件 ✗。
 * 口径（计数与状态名）与单文件那份完全一致：都取自 `resolveImportRefs` 的同一个结果对象。 */

/** 机器可判的聚合报告（`import-dir --json`，与真导/预览同一份数据） */
function dirRefReportJson(reps) {
  const items = [], bad = [];
  (reps || []).forEach((r) => {
    r.rep.refs.forEach((x) => {
      items.push({ file: r.rel, node: x.nodeId, topic: x.nodeTopic, kind: x.kind,
        ref: x.raw, status: x.status, dest: x.dest });
      // 坏引用（解析不到 / 图片格式不受支持）单独一列：报告要能**逐条定位**到文件与试过的路径
      if (x.status === 'missing' || x.status === 'bad-ext') {
        bad.push({ file: r.rel, node: x.nodeId, topic: x.nodeTopic, kind: x.kind,
          ref: x.raw, status: x.status, reason: x.reason, tried: x.candidates });
      }
    });
  });
  const count = (st) => items.filter((i) => i.status === st).length;
  return {
    onMissing: DIR_REF_ON_MISSING,             // 口径本身也要看得见（与实参共用同一个字面量 ✓）
    files: (reps || []).filter((r) => r.rep.refs.length).length,
    total: items.length,
    copy: count('copy'), inProject: count('in-project'), remote: count('remote'),
    missing: count('missing'), badExt: count('bad-ext'),
    // ⚠️ 这两个数组有上限（一份大库的清单可以很长）⇒ **把总数一并给出**：
    //    截断必须**看得见**（`itemsTotal > items.length` 就是"被截了"），不许静默少几条 ✗
    badTotal: bad.length, itemsTotal: items.length,
    bad: bad.slice(0, 200), items: items.slice(0, 400)
  };
}

/** 整库导入的资源回显（**如实报告**）：汇总一行 + 逐条点名（每条前面带上是哪个文件）。
 *  取舍：**坏引用一律全部列出**（它要人去修，藏起来等于把它变成下一次的意外），
 *  已正常落地的那些最多列 20 条（剩下的在 `--json` 里，避免一份大库刷屏）。 */
function printDirRefReport(out, reps, dry) {
  const list = reps || [];
  const total = list.reduce((n, r) => n + r.rep.refs.length, 0);
  if (!total) {
    if (dry) out('资源引用：这个目录里没有图片/附件引用（无）');
    return;
  }
  const nOf = (k) => list.reduce((n, r) => n + r.rep[k].length, 0);
  const parts = [];
  if (nOf('copied')) parts.push((dry ? '将复制 ' : '已复制 ') + nOf('copied') + ' 个文件进项目');
  if (nOf('inProject')) parts.push('已在项目内 ' + nOf('inProject') + ' 条（未复制）');
  if (nOf('remote')) parts.push('非本地引用 ' + nOf('remote') + ' 条（按正文保留）');
  if (nOf('dropped')) parts.push('坏引用 ' + nOf('dropped') + ' 条（**不阻断**，按正文保留）');
  out('资源引用（共 ' + total + ' 条，来自 ' + list.filter((r) => r.rep.refs.length).length + ' 个文件）：'
    + parts.join('；'));
  const ok = [], issue = [];
  list.forEach((r) => r.rep.refs.forEach((x) => {
    const head = r.rel + ' · 节点「' + x.nodeTopic + '」（' + markdown.KIND_LABEL[x.kind] + '）' + x.raw;
    if (x.status === 'copy') {
      // 真导时 `dest` 一定已生成（复制是同一个函数做的）；dry-run 时还没有新文件名 ⇒ 只说清"复制进哪一类目录"
      ok.push('  · ' + head + ' → ' + (x.dest
        || (dry ? markdown.RESOURCE_DIR[x.kind] + '/…（真导时生成新文件名）'
          : markdown.RESOURCE_DIR[x.kind] + '/?（复制却没给出新文件名 —— 不该发生，请报告）')));
    } else if (x.status === 'in-project') {
      ok.push('  · ' + head + ' —— 已在项目内，未复制'
        + (x.file !== x.raw ? '（写法规范化为 ' + x.file + '）' : ''));
    } else if (x.status === 'remote') {
      issue.push('  · ' + head + ' —— ' + x.reason + '；'
        + (dry ? '真导时**按正文**并入该节点详情' : '**已按正文**并入该节点详情（未挂进 images/files）'));
    } else {
      // 坏引用：复用单文件那份的 `refIssueLine`（哪个节点 / 原样路径 / 为什么 / 按序试过哪些路径）
      issue.push('  · ' + r.rel + ' · ' + refIssueLine(x)
        + (dry ? '（真导时**按正文**并入该节点详情，不阻断）' : '；已按正文并入该节点详情'));
    }
  }));
  issue.forEach((l) => out(l));
  if (issue.length) {
    out('  ⚠ 上面 ' + issue.length + ' 条**没有**落成项目内引用（也就不会有悬空引用）：'
      + '内容都在，只是变成了正文。要把图片/附件找回来：把它指向的文件放到那个 md **同目录**的 '
      + 'assets/（图片）或 attachments/（附件）下 —— 文件名与引用一致 —— 再导一次。');
  }
  ok.slice(0, 20).forEach((l) => out(l));
  if (ok.length > 20) out('  · …另有 ' + (ok.length - 20) + ' 条已正常落地的引用（`--json` 里有全部）');
  if (dry) out('（以上是**预览**：--dry-run 不复制文件、不建目录、不改任何数据 ✓）');
}

/* ---------------- 【W1】跨项目检索（`search-all`）的两块命令层零件 ----------------
 * 为什么在命令层而不是 `src/`：这里要**读盘**（`ctx.store.list()` / `store.read` / 热度日志路径），
 * 而 `src/item-index.js` 的三条纪律里明写"不读盘、不认识项目名"（命中对象的 `project` 由命令层附加，
 * 与 `src/query.js` 的 computeStats 先例同一个分工）。
 * 判定与数值**一处都不在这里**：匹配/命中形状/预算/上限/热度权重全在上游那一份实现里 ✓
 *   · 匹配与命中形状：`src/item-index.js` 的 `searchItems`（**唯一实现**，本文件不再写第二套匹配）
 *   · 排序：先由 `src/palette-rank.js` 的 `rankRows` 定**基线**（【W6】模糊分升序，命令面板同一份），
 *     再由 `orderByHeat` 做**封顶的温度微调** —— 两个都在 `searchItems` 内部完成，
 *     本命令**不做跨项目重排**（理由见 `searchAll` 的注释）
 *   · 两条硬上限与扫描闸门：`itemIndex.scanGate`（数字与报文都在那里）
 */

/** 项目名比较：**升序**（`store.list()` 是 readdir 序，跟着文件系统漂 ✗ ⇒ 扫描顺序必须自己定死） */
function compareProjectNames(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/** 库里全部项目名（升序 = **确定序**，与"哪个项目先被扫到"这件事绑死 ⇒ 输出可复现） */
function storeProjectNames(ctx) {
  return ctx.store.list().map((p) => p.name).sort(compareProjectNames);
}

/**
 * `--scope a,b` → 要扫的项目名列表（**唯一实现处**，纯函数 ⇒ 可单测）。
 *
 * 三条口径（都为了"不静默"）：
 *   ① 逗号分隔、trim、丢空串；重复项按**第一次出现**算（`--scope a,a` 不扫两遍）；
 *   ② 给了 `--scope` 却**一个名字都没有**（裸写 / 空串 / 只有逗号）⇒ **报错**，
 *      绝不"当成全库"—— 那是"参数写错了却拿到全量结果"的静默 ✗；
 *   ③ 名单里有库里**不存在**的项目 ⇒ 报错并**逐个点名** + 列出库里现有什么（"我怎么写才对"）。
 * 没给 `--scope` ⇒ 全库（全部名字）。
 * ⚠️ 返回的名单**一律升序**（= 扫描顺序）：这样"顺序 = 项目名升序"这条承诺**与调用方给的顺序无关**，
 *    由本函数自己成立（调用方少排一次也不会悄悄改变输出顺序）。
 *
 * @param {*} raw `ctx.args.scope`（`true` = 裸写；`string` = 用户给的值；`undefined` = 没给）
 * @param {string[]} all 库里全部项目名
 * @returns {{ok:true, names:string[], scoped:boolean} | {ok:false, message:string}}
 */
function scopeList(raw, all) {
  const names = (Array.isArray(all) ? all.slice() : []).sort(compareProjectNames);
  if (raw === undefined || raw === null) return { ok: true, names: names, scoped: false };
  if (raw === true || String(raw).trim() === '') {
    return { ok: false, message: '--scope 需要一个项目名列表（逗号分隔，如 `--scope 项目甲,项目乙`）'
      + '；想扫全库就别给 --scope。' };
  }
  const want = [];
  String(raw).split(',').forEach((x) => {
    const n = x.trim();
    if (n && want.indexOf(n) < 0) want.push(n);
  });
  if (!want.length) {
    return { ok: false, message: '--scope 里一个项目名都没有（给的是 `' + String(raw) + '`）—— '
      + '它要么写成 `--scope 项目甲,项目乙`，要么整个去掉（去掉 = 扫全库）。' };
  }
  const missing = want.filter((n) => names.indexOf(n) < 0);
  if (missing.length) {
    return { ok: false, message: '--scope 点名的项目不在库里：' + missing.join(' / ')
      + '。库里现有 ' + names.length + ' 个项目：' + (names.length ? names.join(' / ') : '（一个都没有）')
      + ' —— 名字要写目录名（`projects/` 下那一层），不是 meta.name。' };
  }
  return { ok: true, names: want.slice().sort(compareProjectNames), scoped: true };
}

/**
 * **全库扫描**（`searchAll` 的骨架；单列出来是为了让命令体只剩"参数 → 输出"这一段）。
 *
 * 契约（判据靠它们，见 `.review/20261010-卖点与功能-常驻讨论/待做清单.md` W1 一节）：
 *   · 逐个项目调**同一个** `searchItems`（匹配、过滤、**【W6】模糊定序**、预算口径全在那一处）⇒ 每个项目的
 *     分片与 `search <项目> <关键词>` **逐条同序**（含它自己的热度榜）；
 *   · **不做跨项目重排**：合并顺序 = 项目名升序 × 项目内既有顺序。理由两条：① 项目内顺序由
 *     `src/palette-rank.js` 的 `rankRows`（字面匹配的基线）+ `src/item-index.js` 的 `orderByHeat`
 *     （热度的封顶微调）定出来，跨项目比分数会是**第二份排序实现** ✗；② nodeId 只在
 *     项目内唯一，跨项目按 nodeId 取热度会串项目（p1 的 `nd-1` 与 p2 的 `nd-1` 会互相冒充）。
 *   · 命中对象**加一个 `project` 字段**（其余字段逐字来自 `searchItems`，不改名不改义）；
 *   · 两条硬上限每扫完一个项目判一次 ⇒ 越限**响亮报错**（`ctx.error` ⇒ 退出码 1 + stdout 以
 *     `error: ` 开头），**不返回半份结果**；
 *   · **读不动的单个项目：跳过，但必须看得见**（`skipped[]` + 文本档点名 + 汇总行写"跳过 N 个"）——
 *     为什么不是"整体失败"：那是**别人项目**的坏数据（与 `originIndexAcrossStore` 面对"读不动的项目"
 *     同一个处境），为一个无关文件让整库检索不可用并不划算；但**也绝不静默**：调用方（AI）
 *     必须能看出"这次命中里没有它的内容"（否则它会把 `hitCount` 当成整库的全部 ✗）。
 *
 * @returns {{hits:Array, hitCount:number, scanned:string[], skipped:Array, mode:string, heatOf:Array, heatInfo:object}}
 */
function scanAll(ctx, opts) {
  const o = opts || {};
  const nh = o.noHeat;
  const scanned = [];
  const skipped = [];
  const hits = [];
  const heatOf = [];
  const explainOf = [];                        // 【W4】逐项目的 `--explain` 读数（合并与截断在命令层）
  let hitCount = 0;
  let weights = null;                          // 任一项目取到的热度权重表（各项目同一个常量表；取到就用它）
  const t0 = Date.now();                       // ← 唯一读时钟的地方（判定本身在 itemIndex.scanGate，纯函数）

  for (let i = 0; i < o.names.length; i++) {
    const name = o.names[i];
    let root = null;
    try {
      root = ctx.store.read(name).data;
    } catch (err) {
      const why = String((err && err.message) || err);
      // 坏了就跳过 —— 但记进 `skipped`，由输出层**逐个点名**（"少扫一个项目"这件事必须可见）
      skipped.push({ project: name, reason: why });
      continue;
    }
    // ---- 热度：**逐项目**读它自己那份日志 ----
    // 读法/坏日志判定与 `search` **共用 `readHeatBoostFor`**（连报文与三条出路都只有那一份）。
    // 日志坏了 ⇒ 与 `search` 同一条纪律（F1：不许静默当 0）：一起失败，并点名**是哪个项目**。
    const heatOne = readHeatBoostFor(ctx, name, !!nh);
    const heatRead = heatOne.read;
    const boost = heatOne.boost;
    if (heatOne.weights) weights = heatOne.weights;

    const r = itemIndex.searchItems(root && root.data, {
      keyword: o.keyword, tag: o.tag, full: o.full, topicOnly: o.topicOnly,
      src: o.src, verified: o.verified, type: o.type, since: o.since,
      // 本次**不卡调用方预算**（预算在合并之后一次算）：给"上限+1"与不设字节上限，
      // 于是每个项目的 `hits` 是完整的、`hitCount` 更是截断前的真值 ⇒ 上游超限绝不会被这里藏住 ✓
      limit: itemIndex.SCAN_MAX_HITS + 1, maxBytes: Number.MAX_SAFE_INTEGER,
      heat: boost,
      // 【W4】混合检索**逐个项目各算各的**（与热度同一形状）：每路的名次都是项目内的
      // ⇒ 每个项目的分片与 `search <该项目> --mode/--weights …` 逐条同序（判据靠它）。
      // `selfProject` 只用于判"这条 links 边是不是本项目的"；`assoc` 是图距离的另一半边。
      // 【W4b】`--recall` 同一条路各算各的：扩召回的邻域是**项目内**的（nodeId 只在项目内唯一、
      // 跨项目节点也不在候选集里）⇒ 每个项目接回来的候选与单项目档逐条相同。
      mode: o.hybridMode, weights: o.weights, explain: o.explain, recall: o.recall,
      selfProject: name, assoc: root && root.assoc
    });
    // 参数错（缺关键词 / --verified 写错 / --topic-only 与条目级过滤同给…）在这一层按项目重复出现，
    // 报文本身就点名了问题 ⇒ 点名项目后一起抛出（第一条就停，不会刷屏）
    if (!r.ok) ctx.error('项目「' + name + '」：' + r.message);

    r.hits.forEach((h) => hits.push(Object.assign({ project: name }, h)));
    // 【W4】`explain.hits` 与这个项目的 `r.hits` **逐条同序同长** ⇒ 直接按同一顺序并进来，
    // 合并后的对齐关系就是构造保证（预算截断只砍尾巴，见 `mergeExplain`）。
    if (o.explain && r.explain) explainOf.push({ project: name, explain: r.explain });
    hitCount += r.hitCount;
    scanned.push(name);
    const hotHits = boost ? r.hits.filter((h) => boost.byNode.has(h.nodeId)).length : 0;
    heatOf.push({
      project: name,
      applied: !!(boost && hotHits > 0),
      reason: nh ? '被 --no-heat 显式关闭'
        : !heatRead.exists ? 'no-log'
          : (!boost.rankedNodes ? 'log-empty' : (hotHits ? 'ok' : 'no-hit')),
      rankedNodes: boost ? boost.rankedNodes : 0,
      hitNodes: hotHits,
      log: (heatRead && heatRead.exists) ? {
        bytesRead: heatRead.log.bytesRead, fileBytes: heatRead.log.fileBytes,
        windowComplete: heatRead.log.complete
      } : null
    });

    // ---- 两条硬上限：**每扫完一个项目判一次** ⇒ 越限当场停、不返回半份（判据③）----
    const gate = itemIndex.scanGate({ hits: hitCount, projects: scanned.length, elapsedMs: Date.now() - t0, project: name });
    if (!gate.ok) ctx.error(gate.message);
  }

  return {
    hits: hits, hitCount: hitCount, scanned: scanned, skipped: skipped, heatOf: heatOf,
    explainOf: explainOf,
    mode: o.mode,
    heatInfo: {
      applied: heatOf.some((h) => h.applied),
      reason: nh ? '被 --no-heat 显式关闭'
        : heatOf.every((h) => h.reason === 'no-log') ? 'no-log'
          : (!heatOf.some((h) => h.rankedNodes > 0) ? 'log-empty'
            : (heatOf.some((h) => h.reason === 'ok') ? 'ok' : 'no-hit')),
      // 权重表只从 `src/heat.js` 现取（本文件一个热度数字都不写）
      weights: o.weights || heat.searchRankOf(),
      windowDays: heat.WINDOW_DAYS,
      rankedNodes: heatOf.reduce((n, h) => n + h.rankedNodes, 0),
      hitNodes: heatOf.reduce((n, h) => n + h.hitNodes, 0),
      perProject: heatOf
    }
  };
}

/**
 * 读**一个项目**的热度榜，并折成排序向量（`search` 与 `search-all` **共用的唯一一处**）。
 *
 * 为什么必须共用：`src/heat.js` 的 `searchBoost(` 在命令层只许有**一个调用点**
 * （`tests/search-heat.test.js` 的 A4 机械钉着它）—— 那是"排序只由热度**重排**、不由第二处打分"
 * 的结构保证；而"坏日志 ⇒ 响亮失败 + 三条出路"的报文同理（两处各写一遍迟早变成两种行为）。
 *
 * 口径（与从前逐字一致，只是搬进了这里）：
 *   · `noHeat = true` ⇒ **完全不碰**（不读、不排序）—— 这就是 `--no-heat` 的语义，返回全空；
 *   · 读失败（坏行 / 未知通道 / 乱序 / 未来时间戳）⇒ **响亮报错**并点名**是哪个项目**的日志，
 *     报文末尾给三条出路（含 `--no-heat`）—— 只说"坏了"不够，调用方得知道还能怎么拿到结果；
 *   · 本机没有日志 ⇒ 不是"热度为 0"，而是"本机没有采到数据"（`no-log`），如实带回。
 *
 * @param {object} ctx
 * @param {string} name 项目名（`store.visitLogFile` 是日志路径的**唯一推导处**，这里不拼路径）
 * @param {boolean} noHeat `--no-heat` 的取值
 * @returns {{read:object|null, boost:object|null, weights:object|null}}
 *   `read` = `heat.readHeatFile` 的原样结果（没日志时 `exists:false`）；`boost` = `heat.searchBoost` 产物
 */
function readHeatBoostFor(ctx, name, noHeat) {
  if (noHeat) return { read: null, boost: null, weights: null };
  let read = null;
  try {
    read = heat.readHeatFile(ctx.store.visitLogFile(name), { now: Date.now() });
  } catch (err) {
    ctx.error('项目「' + name + '」的热度日志读不了：' + String((err && err.message) || err)
      + '\n出路三条（任选）：① 加 `--no-heat` **先检索**（跳过热度日志：不读、不写、不排序，'
      + '排序回到"零热度档"，与从来没有过热度的项目逐字相同）；② 修掉上面点名的那几行；'
      + '③ 删掉该日志（旁路产物、可随时删）。');
  }
  const boost = read.exists ? heat.searchBoost(read.heat) : null;
  return { read: read, boost: boost, weights: boost ? boost.weights : null };
}

/**
 * 【W4】`--explain` 的**文本档打印**（`search` 与 `search-all` 共用这一处）。
 *
 * 它必须回答清单 W4 那句"**这条命中由哪几路贡献、各自什么排名**"——所以三段都有：
 *   ① 这一批按什么权重、什么 `k` 融合（`k` 与权重都从纯逻辑层现取，命令层一个数字都不写）；
 *   ② **逐路**读数（含"没出力"的那几路与原因：未安装 / 恒空 / 没启用）—— 少了哪一路必须看得见 ✗；
 *   ③ **逐条**命中的各路名次与贡献（总分只是读数，不是判据）。
 * ⚠️ 命中对象本身一个键都不加（契约 §3.4 的 12 键）：`explain.hits` 是与 `hits` **平行**的数组。
 */
function printExplain(ctx, ex) {
  const num = (x) => Number(Number(x).toFixed(6));   // 只用于回显：别让 0.01639344262295082 这类噪音漏进读数
  ctx.out(ex.enabled
    ? '混合检索：' + (ex.mode ? '预设 `' + ex.mode + '`' : '自定义权重') + '（RRF：总分 = Σ 权重/(k+名次)，'
      + 'k = ' + ex.k + '；k 与权重表的唯一一处是 src/palette-rank.js）'
    : '混合检索**未启用**（不给 --mode / --weights 时它就是关的，顺序与从前逐字相同）：'
      + '下面只有"字面匹配"这一路的读数');
  ex.routes.forEach((r) => {
    ctx.out('  · 路 `' + r.id + '`（' + r.label + '）权重 ' + num(r.weight)
      + '｜有名次 ' + r.ranked + ' 条' + (r.note ? '｜' + r.note : ''));
  });
  const idle = ex.routes.filter((r) => !r.installed || (r.weight > 0 && r.ranked === 0));
  if (idle.length) {
    ctx.out('  ⚠ 有 ' + idle.length + ' 路**没出力**：'
      + idle.map((r) => r.id + '（' + (r.note || '权重 0') + '）').join('；')
      + ' —— 这是**能力 / 数据边界**，不等于"这一维没有问题"（口径见 docs/EXTENSIONS.md §1.2 的 W4 一段）');
  }
  /* 【W4b】扩召回读数（**逐路点名**）：没给 `--recall` 时也要说清"这几路能扩召回、这次没点名它们"；
   * 给了就要报"这一路接回来几条、接回来的命中报什么 `matchIn`、上界几跳"。
   * 一条都没接回来时必须说**为什么**（没有那份数据 / 这一批不需要扩）—— 少一个开关 / 少一路都要看得见。 */
  const rec = ex.recall;
  if (rec) {
    const asked = rec.routes.filter((r) => r.asked);
    ctx.out(rec.on
      ? '  · 扩召回（--recall ' + rec.asked.join(',') + '）：'
        + asked.map((r) => '路 `' + r.id + '` 接回 ' + r.added + ' 条新候选'
          + '（它们报 matchIn=' + r.hitValue + '，上界 ' + r.bound + ' 跳 = 路由表那一行的 bound）').join('；')
      : '  · 扩召回：**未启用**（不给 --recall 时它不参与，候选集与从前逐字节相同）；能扩召回的路：'
        + rec.routes.map((r) => r.id + '（报 ' + r.hitValue + '，上界 ' + r.bound + ' 跳）').join(' / '));
    asked.forEach((r) => { if (r.note) ctx.out('    ⚠ 路 `' + r.id + '` 一条都没接回来：' + r.note); });
  }
  ex.hits.forEach((h, i) => {
    const known = h.parts.filter((p) => p.rank !== null);
    ctx.out('  ' + (i + 1) + '. ' + h.nodeId + (h.itemId ? '#' + h.itemId : '')
      + '  总分 ' + num(h.total) + '  ← '
      + (known.length
        ? known.map((p) => p.route + ' #' + p.rank + '×' + num(p.weight) + '=' + num(p.add)).join(' + ')
        : '没有任何一路给它名次'));
  });
}

/**
 * 【W4】把逐项目的 `explain` 合并成**一份**（`search-all` 用）：`hits` 截到与预算后的命中同长，
 * 每条读数补上 `project`（跨项目结果里"哪个项目"是必须的，与命中对象上补 `project` 同一口径）。
 * 为什么能直接切前缀：`budgeted` 的截断只会**砍尾巴**（先按 limit 切、再逐条回退）⇒
 * "合并顺序与命中顺序逐条对齐"是构造保证，不是巧合并肩。
 */
function mergeExplain(ofEach, shown) {
  const used = ofEach.filter((x) => x && x.explain);
  if (!used.length) return null;
  const first = used[0].explain;
  const hits = [];
  used.forEach((x) => {
    x.explain.hits.forEach((h) => hits.push(Object.assign({ project: x.project }, h)));
  });
  // 逐路读数：名次是**项目内**的 ⇒ 跨项目那一栏给"合计 + 逐项目分账"（别把不同项目的名次相加当名次）
  const routes = first.routes.map((r) => {
    let ranked = 0;
    let weight = r.weight;
    const perProject = used.map((x) => {
      const row = x.explain.routes.filter((y) => y.id === r.id)[0] || {};
      ranked += Number(row.ranked) || 0;
      if (row.weight !== undefined && row.weight !== null) weight = row.weight;
      return { project: x.project, ranked: row.ranked || 0, note: row.note || null };
    });
    return Object.assign({}, r, { ranked: ranked, perProject: perProject });
  });
  /* 【W4b】扩召回的读数同样是**逐项目各算各的**（邻域是项目内的）⇒ `added` 给"合计 + 逐项目分账"
   * （与上面 `routes[].ranked` 同一形状、同一条理由：不同项目的跳数/名次不能相加）。 */
  const rec = first.recall ? {
    on: first.recall.on,
    asked: first.recall.asked,
    routes: first.recall.routes.map((r) => {
      let added = 0;
      const perProject = used.map((x) => {
        const rows = (x.explain.recall && x.explain.recall.routes) || [];
        const row = rows.filter((y) => y.id === r.id)[0] || {};
        added += Number(row.added) || 0;
        return { project: x.project, added: row.added || 0, note: row.note || null };
      });
      return Object.assign({}, r, { added: added, perProject: perProject });
    })
  } : null;
  return {
    enabled: first.enabled, mode: first.mode, k: first.k, weights: first.weights,
    routes: routes, recall: rec, hits: hits.slice(0, shown)
  };
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

    // ---- --items：条目层（v3）的另一种口径——只取这几条正文（`docs/ITEM-MODEL.md` §3.3）----
    // 判定与报文都在 src/item-index.js（任一 id 缺失 ⇒ 整体失败并逐个点名；与 --brief/--skeleton/--subtree
    // 互斥）—— 命令层只负责把它接到 ctx 的输出上，别在这里再写一份判定。
    if (ctx.args.items !== undefined) {
      const r = query.readItemsView(data, ctx.args.items, {
        project: ctx.projectName, brief: ctx.args.brief, skeleton: ctx.args.skeleton, subtree: ctx.args.subtree
      });
      if (!r.ok) ctx.error(r.message);
      if (js) { ctx.outJson(r.view); return; }
      r.view.items.forEach((it, i) => {
        if (i) ctx.out('');
        ctx.out(it.nodeId + '#' + it.itemId + '  ' + it.nodeTopic + '  [' + it.type + ']');
        ctx.out(it.html !== undefined ? it.html : JSON.stringify(it.qa));
      });
      return;
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

    // ---- 埋点（热度条第三件 · C）：一次 `read` 整页 / 整子树**顺带带出**这些节点 ⇒ 通道
    //      `ai-read-view`（权重最低的一档，理由见 src/heat.js 的 CHANNELS）。
    //      ⚠️ 位置：两条输出路（`--json` 与文本档）都要覆盖 ⇒ **先算视图、再记、最后打印**；
    //      而 `ctx.recordVisit` 一个字节都不往 stdout 写 ⇒ 输出逐字节不变（判据②）。
    //      上限口径（每次调用最多记几行、取返回顺序的前缀）只有一处：src/heat-sensor.js。
    const readView = buildReadView(view, ctx.args);
    ctx.recordVisit('ai-read-view', (readView.nodes || []).map((n) => n.id));
    if (js) {
      ctx.outJson(readView);
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
    // ---- --item：条目层（v3）的定点取回（`docs/ITEM-MODEL.md` §3.1）----
    // 报文由 src/item-index.js 定（"条目不在该节点 ⇒ 点名它实际属于哪个节点"）—— 单源，别另写一套。
    if (ctx.args.item !== undefined) {
      const r = query.getItemView(data.data, id, ctx.args.item);
      if (!r.ok) ctx.error(r.message);
      if (ctx.args.json) ctx.outJson(r.view);
      else ctx.out(JSON.stringify(r.view, null, 2));
      return;
    }
    // path 由 tree-utils.pathTo 计算（曾内联手写 DFS 且缺回溯 pop，
    // 导致返回「DFS 访问过的全部节点」——查 s-3-1 会得到 27 项而非 4 项）
    const out = query.getNodeView(data.data, id, ctx.args);
    if (!out) ctx.error('节点不存在: ' + id);
    // ---- 埋点（热度条第三件 · C）：按 id 直取单个节点 ⇒ 通道 `ai-get`（与"人打开详情框"同等强度）
    //      ⚠️ `--item` 那条分支**不记**：取一条**条目**是"读这一条内容"，不是"访问这个节点"
    //      （条目级热度本件不做 ⇒ 不假装有）。未知通道 / 写失败一律响亮，见 cli/main.js。
    ctx.recordVisit('ai-get', [id]);
    if (ctx.args.json) ctx.outJson(out);
    else ctx.out(JSON.stringify(out, null, 2));
  },

  search(ctx) {
    // 整数形态的合法性由 core 的统一实现挡（含允许范围），**取值范围**来自 src/item-index.js 的常量
    const limit = ctx.intOption('limit', { min: 1, max: itemIndex.LIMIT_MAX, def: itemIndex.DEFAULT_LIMIT });
    const maxBytes = ctx.intOption('maxBytes', { min: itemIndex.MIN_MAX_BYTES, max: itemIndex.MAX_BYTES_MAX, def: itemIndex.DEFAULT_MAX_BYTES });

    /* ---- 热度向量（热度条第二件）----
     * 三条上限（人 / AI / 合并）与"名次→档位"全在 `src/heat.js`（唯一一处）——**这里不写任何数值**，
     * 只做两件事：① **读**（窄查询：只读日志尾部，见 heat.js 的 readTail）；② 交给纯逻辑层排序。
     * · 日志坏了 / 有认不出的通道 / 时间乱序 / 未来时间戳 ⇒ `readHeatFile` **响亮报错**（F1：
     *   不许静默当 0）⇒ 本命令一起失败并点名，**并在报文末尾给出三条出路**（含 `--no-heat`）。
     * · 本机没有日志 ⇒ 这次排序**不参考热度**：不是"热度为 0"，而是"本机没有采到数据"——
     *   所以 `heat.reason` 会如实说 `no-log`（`--json` 里永远给，不静默）。
     * ⚠️ MCP 的 `search_nodes` **不另写一份**：它转发到本命令 ⇒ 两边同源（判据③）。 */
    // `--no-heat`：**显式**跳过热度日志 —— 语义是「本次调用**完全不碰热度日志**」：
    // **不读**（不排序，排到零热度档）**且不写**（埋点也一起关掉）。
    // · 为什么"不写"这一半是必须的（用户 2026-10-12 裁决②）：坏日志下这条出路的意义正是
    //   "一个字节都别动它" —— 读了会响亮失败、写了（追加一条）会把坏日志**搅得更坏**
    //   （再垫一行读不出来的东西进去），而调用方要的是"先拿到结果" ✓。
    // · 它**不是**"默认降级"：默认档照旧响亮失败（F1），关掉这件事必须由调用方**说出口**
    //   （`--json` 里如实写 `heat.reason`）。
    const nh = itemIndex.parseFlag(ctx.args.noHeat);   // 布尔开关照 --verified 先例：只认 true/false/裸写
    if (!nh.ok) ctx.error('--no-heat ' + nh.reason);
    // 读榜与折成排序向量：**与 `search-all` 共用这一处**（见 `readHeatBoostFor`：坏日志的报文与三条出路
    // 也只有一份 —— 两处各写一遍必然漂移成两种行为）
    const heatOfOne = readHeatBoostFor(ctx, ctx.projectName, nh.value);
    const heatRead = heatOfOne.read;                   // 原本那份 `readHeatFile` 结果（--no-heat 时是 null）
    const boost = heatOfOne.boost;

    /* ---- 【W4】混合检索的两样数据 ----
     * ① 本项目名（只用来判"node.links 里的这条边是不是本项目的" —— 跨项目节点不在候选集里，
     *    算了也用不上，而且 nodeId 只在项目内唯一）；
     * ② 项目文件里的 `assoc` 集合（图距离那一半的边）。
     * 两者都从**这一次** `ctx.read()` 里取（与 `ctx.root` 是同一个 `data.data`，不读第二次）。
     * ⚠️ 三个开关（`--mode` / `--weights` / `--explain`）**原样**交给纯逻辑层：解析、权重表、
     *    路由表、融合都在 `src/palette-rank.js` / `src/item-index.js` 那两处，命令层不复制一份条件表
     *    （所以 `--weights` 写错的报文与 `--verified` 写错同源）。 */
    const { data } = ctx.read();
    const r = query.searchNodes(data.data, {
      keyword: ctx.args._[1], tag: ctx.args.tag, full: !!ctx.args.full, topicOnly: !!ctx.args.topicOnly,
      src: ctx.args.src, verified: ctx.args.verified, type: ctx.args.type, since: ctx.args.since,
      limit: limit, maxBytes: maxBytes,
      heat: boost,
      mode: ctx.args.mode, weights: ctx.args.weights, explain: !!ctx.args.explain,
      // 【W4b】扩召回：`--recall <路由>` 原样交给纯逻辑层（取值合法性、上界、新取值名都在
      // `src/palette-rank.js` 一处；命令层不复制一份条件表 —— `recall` 写错的报文与 `--weights` 同源）
      recall: ctx.args.recall,
      selfProject: ctx.projectName, assoc: data.assoc
    });
    // 缺关键词 / 非法 --verified,--type,--since / --topic-only 与条目级过滤同给 ⇒ 都由纯逻辑层给出完整报文
    if (!r.ok) ctx.error(r.message);
    /* ---- 埋点（热度条第三件 · C）：搜索**命中并返回**的节点 ⇒ 通道 `ai-search-hit`。
     * 口径三条（写在这里，因为"哪一刻算一次访问"只有本命令知道）：
     *   ① 记的是**本次真的返回了的**命中（`r.hits`，已过 --limit / --max-bytes 预算），
     *      不是全量命中面 —— "返回了"才是访问，"差点返回"不是；
     *   ② 顺序 = 返回顺序（结果里排前面的更可能被真读）⇒ 上限截断时留下的是**前缀**；
     *   ③ **在 `readHeatFile` 之后调**（代码位置就是这条）：本命令的热度已经读完了，
     *      所以这次记的命中不会反过来抬升**本次**排序（否则每次 search 都会自激一次）。
     * ⚠️ `--no-heat` ⇒ **一条都不记**（"别碰热度"是双向的：不读也不写，见上面那段裁决）；
     *    日志坏了那一支在**上面**已经 ctx.error 退出了 ⇒ 报错路径一条都不记（与"不给半份结果"同一精神）。 */
    if (!nh.value) ctx.recordVisit('ai-search-hit', r.hits.map((h) => h.nodeId));
    // 本次**返回的**命中里带热度的条数（只有它才可能与顺序有关；没带就是"这次排序没被热度推动"）
    const hotHits = boost ? r.hits.filter((h) => boost.byNode.has(h.nodeId)).length : 0;
    const heatInfo = {
      applied: !!(boost && hotHits > 0),
      reason: nh.value ? '被 --no-heat 显式关闭'
        : !heatRead.exists ? 'no-log'
          : (!boost.rankedNodes ? 'log-empty' : (hotHits ? 'ok' : 'no-hit')),
      weights: boost ? boost.weights : heat.searchRankOf(),
      windowDays: heat.WINDOW_DAYS,
      rankedNodes: boost ? boost.rankedNodes : 0,
      hitNodes: hotHits,
      log: (heatRead && heatRead.exists) ? {
        bytesRead: heatRead.log.bytesRead, fileBytes: heatRead.log.fileBytes,
        windowComplete: heatRead.log.complete
      } : null
    };
    if (ctx.args.json) {
      const payload = { project: ctx.projectName, keyword: ctx.args._[1] || null, hits: r.hits,
        hitCount: r.hitCount, truncated: r.truncated, mode: r.mode, budget: r.budget, heat: heatInfo };
      // 【W4】`explain` **只在要的时候出现**（既有消费者的 JSON 面一个键都不多）
      if (r.explain) payload.explain = r.explain;
      ctx.outJson(payload);
      return;
    }
    r.hits.forEach((h) => ctx.out(h.nodeId + (h.itemId ? '#' + h.itemId : '') + '  ' + h.nodeTopic
      + (h.matchIn && h.matchIn !== 'topic' ? '  [' + h.matchIn + ']' : '')
      + (h.snippet ? '  …' + h.snippet + '…' : '')));
    ctx.out('命中 ' + r.hitCount + ' 条' + (r.truncated ? '（本次返回 ' + r.hits.length + ' 条，已截断）' : '')
      + '｜预算 ' + r.budget.bytes + ' B ≈ ' + r.budget.estTokens + ' token（--limit ' + r.budget.limit
      + ' / --max-bytes ' + r.budget.maxBytes + '，口径 ' + r.mode + '）');
    // 用了热度才多说一行（没有日志时本命令的输出与从前逐字相同）—— 有日志就**必须**说，
    // 否则"排序为什么是这个顺序"在文本档里看不出来。
    if (boost && boost.rankedNodes) {
      // 百分数只用于回显：`0.07*100 = 7.000000000000001` 这类噪音不许漏到读数里
      const pc = (x) => Number((Number(x) * 100).toFixed(6));
      ctx.out('热度：人 / AI 两条榜已并入排序（封顶占总分 ' + pc(heatInfo.weights.merged) + '%'
        + ' · 人上限 ' + pc(heatInfo.weights.human) + '% / AI 上限 ' + pc(heatInfo.weights.ai) + '%'
        + ' · 窗口最近 ' + heat.WINDOW_DAYS + ' 天 · 榜上 ' + boost.rankedNodes + ' 个节点）；'
        + '本次返回到的命中里 ' + hotHits + ' 个带热度。口径见 src/heat.js 的 SEARCH_RANK（唯一一处）');
    }
    if (r.truncated && r.budget.resume) ctx.out(r.budget.resume);
    // 【W4】`--explain`：放在**最后**（顺序、热度、预算都说完之后）—— 读它的人先看结果、再看归因
    if (r.explain) printExplain(ctx, r.explain);
  },

  /**
   * 【W1】`search-all` —— **一次检索扫全库**（跨项目），每条命中带 `project`。
   *
   * 为什么它值（`卖点.md` 卖点 1）：卖点 1 那句"**AI 不必每次上网搜**"的技术前提就是它 ——
   * 从前 `search` 必须点名**单个**项目，"整库当一库用"便无从谈起（跨项目只能靠 `mentions --cross` /
   * `backlinks` 这类专门命令）。它是"经验库"被人/AI 当作**一个**知识库检索的入口。
   *
   * 形状（**复用 `search` 那一套，不另起**）：
   *   · 关键词、标签、过滤、**【W6】模糊命中与定序**、命中形状、预算口径 = 逐个 项目 调同一个
   *     `itemIndex.searchItems`（命中判定与顺序的唯一实现在 `src/palette-rank.js`）；
   *   · 热度 = 逐项目读**它自己**那份日志（`heat.readHeatFile` + `heat.searchBoost`），
   *     在那条基线上由 `orderByHeat` 在 `searchItems` 内部做封顶微调 ⇒
   *     每个项目的分片与 `search <该项目>` 逐条同序；
   *   · **不做跨项目重排**（理由写在 `scanAll` 的契约段：那是第二份排序实现 ✗，且 nodeId 项目内唯一）；
   *   · `--no-heat` 与 `search` **同一个开关、同一处语义**（完全不碰热度日志：不读、不写、不排序）。
   *
   * 三条"不许静默"（判据③，见待做清单 W1 一节）：
   *   ① 两条硬上限（`itemIndex.scanGate`：命中总数 / 扫描耗时）越限 ⇒ **报错**，不是截断；
   *   ② `--limit` / `--max-bytes` 截断 ⇒ 如实说（`truncated` + 续取方式）—— 它不是错误，是调用方的预算；
   *   ③ 某个项目的**热度日志坏了** ⇒ **整体失败并点名那个项目**（与 `search` 同一条纪律：不许静默按 0 排，
   *      出路是 `--no-heat`）；某个项目的**数据读不出来** ⇒ **跳过它，但在 `skipped` 与文本档里逐个点名**
   *      （理由见 `scanAll` 的契约段：那是别人项目的坏数据，不该让整库检索不可用；但**绝不当它不存在**）。
   */
  searchAll(ctx) {
    const limit = ctx.intOption('limit', { min: 1, max: itemIndex.LIMIT_MAX, def: itemIndex.DEFAULT_LIMIT });
    const maxBytes = ctx.intOption('maxBytes', { min: itemIndex.MIN_MAX_BYTES, max: itemIndex.MAX_BYTES_MAX, def: itemIndex.DEFAULT_MAX_BYTES });
    const js = !!ctx.args.json;

    const nh = itemIndex.parseFlag(ctx.args.noHeat);
    if (!nh.ok) ctx.error('--no-heat ' + nh.reason);

    // ---- 参数闸门**前置**（在碰任何盘之前的唯一一次判定）----
    // 为什么拿一棵空树跑一次同一个 `searchItems`：① 缺关键词 / --verified 写错 / --topic-only 与
    // 条目级过滤同给 —— 这些**纯参数**错的判定与报文只有那一处实现，命令层不再复制一份条件表 ✗；
    // ② `mode` 也从那一处拿（不在命令层重写 'items' / 'topic-only' 的映射，否则就是第二份口径）。
    const probe = itemIndex.searchItems({ id: '', topic: '', children: [] }, {
      keyword: ctx.args._[0], tag: ctx.args.tag, full: !!ctx.args.full, topicOnly: !!ctx.args.topicOnly,
      src: ctx.args.src, verified: ctx.args.verified, type: ctx.args.type, since: ctx.args.since,
      // 【W4】混合检索的参数闸门也在那一处：`--mode` / `--weights` 写错的报文与 `search` 逐字同源
      // 【W4b】`--recall` 同走这一个闸门（"必须与 --mode/--weights 同给"、取值合法性都只有那一份）
      mode: ctx.args.mode, weights: ctx.args.weights, recall: ctx.args.recall
    });
    if (!probe.ok) ctx.error(probe.message);

    // ---- 范围：库里的项目（名字升序 = 确定序）+ `--scope` 收窄 ----
    const names = storeProjectNames(ctx);
    const sc = scopeList(ctx.args.scope, names);
    if (!sc.ok) ctx.error(sc.message);

    const scan = scanAll(ctx, {
      names: sc.names, keyword: ctx.args._[0],
      tag: ctx.args.tag, full: !!ctx.args.full, topicOnly: !!ctx.args.topicOnly,
      src: ctx.args.src, verified: ctx.args.verified, type: ctx.args.type, since: ctx.args.since,
      noHeat: nh.value, mode: probe.mode,
      // 【W4】混合检索：逐个项目各自融合（`--mode` / `--weights` / `--explain` 与 `search` 同名同义）
      // 【W4b】扩召回也逐个项目各自算（`--recall` 与 `search` 同名同义；邻域是项目内的）
      hybridMode: ctx.args.mode, weights: ctx.args.weights, recall: ctx.args.recall, explain: !!ctx.args.explain
    });

    // ---- 卡预算（**合并之后**一次算；实现与 `searchItems` 共用同一个 `budgeted`）----
    const b = itemIndex.budgeted(scan.hits, limit, maxBytes);

    /* ---- 埋点（热度条第三件 · C）：按**项目**分组记 `ai-search-hit`。
     * 口径与 `search` 一致且只有这一处：记的是**本次真的返回了的**命中（已过 --limit/--max-bytes），
     * 顺序 = 返回顺序；`--no-heat` ⇒ 一条都不记（"别碰热度"是双向的）。
     * ⚠️ 与 `search` 的差别只有一个、且是必须的：命中跨项目 ⇒ 逐个项目记进**它自己**那份日志
     * （p1 的命中记进 p1 的榜；`store.visitLogFile` 仍是路径的唯一推导处）。
     * ⚠️ 位置：在**两条硬上限的闸门之后**（越限时一条都不记）：报错路径与"不给半份结果"同一精神。 */
    if (!nh.value) {
      const byProject = new Map();
      b.hits.forEach((h) => {
        if (!byProject.has(h.project)) byProject.set(h.project, []);
        byProject.get(h.project).push(h.nodeId);
      });
      byProject.forEach((ids, pname) => ctx.recordVisit('ai-search-hit', ids, { project: pname }));
    }

    const heatInfo = scan.heatInfo;
    const scopeShown = sc.names;
    // 【W4】`--explain`：逐项目读数合一（`hits` 截到与预算后的命中**逐条对齐**）
    const ex = ctx.args.explain ? mergeExplain(scan.explainOf, b.hits.length) : null;
    if (js) {
      const payload = {
        keyword: ctx.args._[0] === undefined ? null : ctx.args._[0], tag: ctx.args.tag || null,
        scoped: sc.scoped, scope: scopeShown, scanned: scan.scanned, skipped: scan.skipped,
        hits: b.hits, hitCount: scan.hitCount, truncated: b.truncated, mode: scan.mode,
        budget: b.budget, heat: heatInfo
      };
      if (ex) payload.explain = ex;             // 只在要的时候出现（既有 JSON 面一个键都不多）
      ctx.outJson(payload);
      return;
    }

    b.hits.forEach((h) => ctx.out(h.project + '/' + h.nodeId + (h.itemId ? '#' + h.itemId : '')
      + '  ' + h.nodeTopic
      + (h.matchIn && h.matchIn !== 'topic' ? '  [' + h.matchIn + ']' : '')
      + (h.snippet ? '  …' + h.snippet + '…' : '')));
    // ---- 汇总行：**零结果也必须有一行**（判据②：不是空输出）----
    // 一页里最多列 12 个项目名（库很大时那行会长到看不清）；更多就明说全名单在 --json 里 —— 列表被省掉这件事本身可见 ✓
    const shown = scan.scanned.length > 12
      ? scan.scanned.slice(0, 12).join(' / ') + ' …（还有 ' + (scan.scanned.length - 12) + ' 个，完整名单在 --json 的 scanned）'
      : scan.scanned.join(' / ');
    // 跳过的项目**必须出现在汇总行里**（否则"命中 N 条"会被读成整库的全部 ✗）
    const skipNote = scan.skipped.length ? '（⚠ 另有 ' + scan.skipped.length + ' 个项目没扫成，见下）' : '';
    if (scan.hitCount === 0) {
      ctx.out('命中 0 条 —— 这是**明确的零结果**（不是空输出）：关键词「' + (ctx.args._[0] || '') + '」'
        + (ctx.args.tag ? '标签「' + ctx.args.tag + '」' : '')
        + '在扫过的 ' + scan.scanned.length + ' 个项目里都没有命中' + skipNote
        + (scan.scanned.length ? '（' + shown + '）' : '——**库里一个项目都没有**（`projects/` 下还没有 `<项目>/<项目>.json`）')
        + '。换个关键词 / 去掉 --tag / 用 `search <项目> <关键词>` 到单个项目里再确认一次。');
    } else {
      ctx.out('命中 ' + scan.hitCount + ' 条' + (b.truncated ? '（本次返回 ' + b.hits.length + ' 条，已截断）' : '')
        + '｜扫了 ' + scan.scanned.length + ' 个项目' + skipNote + '：' + shown
        + '｜预算 ' + b.budget.bytes + ' B ≈ ' + b.budget.estTokens + ' token（--limit ' + b.budget.limit
        + ' / --max-bytes ' + b.budget.maxBytes + '，口径 ' + scan.mode + '，顺序 = 项目名升序 × 项目内既有顺序）');
    }
    scan.skipped.forEach((s) => ctx.out('⚠ 跳过项目「' + s.project + '」：' + s.reason
      + ' —— 它的内容**不在**上面的命中里；修它（`node cli/mm-cli.js validate ' + s.project + '`）'
      + '或加 `--scope` 明确排除。'));
    if (heatInfo.rankedNodes) {
      const pc = (x) => Number((Number(x) * 100).toFixed(6));
      const per = heatInfo.perProject.filter((h) => h.rankedNodes).map((h) => h.project + ' ' + h.rankedNodes + ' 个');
      ctx.out('热度：人 / AI 两条榜已并入排序（**逐项目各算各的榜** —— 不同项目的热度不会互相比较）；'
        + '封顶占总分 ' + pc(heatInfo.weights.merged) + '%（人上限 ' + pc(heatInfo.weights.human) + '%'
        + ' / AI 上限 ' + pc(heatInfo.weights.ai) + '% · 窗口最近 ' + heat.WINDOW_DAYS + ' 天）；'
        + '榜上有节点的是：' + per.join(' / ') + '；本次返回到的命中里 ' + heatInfo.hitNodes + ' 个带热度。'
        + '口径见 src/heat.js 的 SEARCH_RANK（唯一一处）');
    }
    // 截断时给续取方式（与 `search` 同一份建议文本 —— 口径只有 src/item-index.js 一处）
    if (b.truncated && b.budget.resume) ctx.out(b.budget.resume);
    // 【W4】`--explain`：逐项目读数的合并（与 `search` 同一份打印实现 `printExplain`）
    if (ex) printExplain(ctx, ex);
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
   *  · `--dry-run` 只报格式/规模/前几个标题，**不写盘**（可机械验证，也是使用者预览的第一入口 ✓）。
   *  · 【W19】md 里的图片/附件引用**落到项目里**（复制进 assets/ / attachments/ + 引用写项目内相对路径，
   *    命名与格式规则与 `add-image` 同一条）；解析不到源文件 ⇒ **拒绝整份导入**并逐条点名 + 给出路
   *    （判据在复制与写入**之前**：拒绝时不留半份项目、不多一个资源文件，见 `refBlockedError`）。 */
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

    // 【W20】用**唯一性有保障**的 id 生成器（不是裸 `idGen`）：中文标题经 `idGen` 会被压成同一个 base，
    // 只靠短随机后缀区分 ⇒ 中文标题多时**概率性撞号**，一撞就"以 id 重复整体导入失败"且人看不出原因。
    // `uniqueIdGen()`（`src/doc-import.js`）是"见过就再摇一次"的兜底 —— `import-dir` 早已用它，
    // 这里把**同一处修法**接过来 ⇒ 三条导入路行为一致 ✓
    const built = markdown.markdownToTree(conv.md, 'root', docImport.uniqueIdGen());
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

    /* 【W19】资源引用：dry-run **只规划**（不复制、不建目录、不改树），真导才落地 ——
     * 两侧是同一个函数、同一个 `ok` ⇒ 不会出现"预览说能导、真导被拒"（见 registry 里 import-dir 的
     * 同类约定：预览与真导必须同一份判据）。 */
    const refPlan = ctx.dryRun
      ? markdown.resolveImportRefs(themes, Object.assign({ dryRun: true }, refResolveOpts(ctx, name, file)))
      : null;
    const refBlocked = !!(refPlan && !refPlan.ok);

    if (ctx.dryRun) {
      const heads = conv.md.split('\n').filter((l) => /^#{1,6}\s+\S/.test(l)).slice(0, 8);
      const out = {
        ok: true, dryRun: true, project: name, file: file, format: conv.format,
        pdfSource: conv.source || null,
        title: title, stats: conv.stats, themes: themes.length, nodes: built.addedCount || 0,
        notes: notes,
        // 资源引用也一并预览（哪条会复制、哪条是远程、哪条落不到项目里 ⇒ 会不会被拒）
        resourceRefs: refReportJson(refPlan),
        // 来源指纹与"会不会被拒"也一并预览 —— 否则预览说"能导"、真导被拒，是最烦人的那种落差 ✗
        origin: origin,
        duplicate: dup ? { project: dup.project, id: dup.node.id, topic: dup.node.topic } : null,
        wouldRefuse: refused || refBlocked,
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
      printRefReport(ctx.out, refPlan, true);
      ctx.out('前几个顶层主题：');
      themes.slice(0, 10).forEach((t) => ctx.out('  · ' + t.topic));
      return;
    }

    // ---- 幂等闸门（本批核心）：同一 src + 同一 sha256 二次导入 ⇒ 拒绝并**指名**上次导到哪 ----
    if (refused) ctx.error(duplicateOriginError('项目 ' + dup.project + ' 的节点 ' + dup.node.id, dup.node.origin));

    /* 【W19】资源引用落地：解析 → 规划 → 复制 → 把 `images[].file` / `files[].file` 改写成
     * **项目内相对路径**（复制这一步的命名/格式规则与 `add-image` 同一条，见 src/markdown.js）。
     * 坏引用 ⇒ **拒绝整份导入**且此时**一个文件都还没复制、一个目录都还没建**（规划先行）✓。 */
    const refs = markdown.resolveImportRefs(themes, refResolveOpts(ctx, name, file));
    if (!refs.ok) ctx.error(refBlockedError(refs, file));

    const data = {
      meta: { name: title, author: '', version: MMConfig.APP_VERSION, formatVersion: 2 },
      format: 'node_tree',
      // origin 挂在**这棵树的根**上：一次导入只留一个来源痕（不是每个节点都抄一遍 ⇒ 文件不膨胀）。
      // 它记的是"这棵树从哪一份文档、哪一次导入来"，是"这份文件导过没有"的唯一判据 ✓
      data: Object.assign(
        { id: 'root', topic: title, expanded: true, origin: origin, children: themes },
        // 【W14】第一个标题**之前**的正文（前导正文）落到**项目根节点**的 detail —— 不再静默丢；
        // 落点选根节点：它就是"这份文档"在这棵树里的代表（与 import-dir 落"文件节点"同一条规则）。
        built.preamble ? { detail: built.preamble } : {}
      )
    };
    ctx.write(data);   // 一次写入（原子）⇒ 不会留下半个项目 ✓
    ctx.out('已从 ' + path.basename(file) + '（' + srcLabel + '）创建项目「' + name + '」：'
      + themes.length + ' 个顶层主题 / ' + (built.addedCount || 0) + ' 个节点'
      + (ctx.args.force && dup ? '（--force：这是同一个来源的第 2 份）' : ''));
    // 落点必须**如实报告**（前导正文去哪了）：静默落盘与静默丢弃一样不可查
    if (built.preamble) {
      ctx.out('前导正文（第一个标题之前的正文，' + built.preamble.length + ' 字符 HTML）已并入**根节点 root 的详情开头**');
    }
    ctx.out('来源指纹: ' + docImport.describeOrigin(origin));
    printNotes(ctx.out);
    // 【W19】资源回显（如实报告）：复制了什么、哪条已在项目内、哪条远程引用被按正文保留
    printRefReport(ctx.out, refs);
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
   *   · 【批6】文档里的图片/附件引用**逐文件落地**（`resolveDirImportRefs` → `markdown.resolveImportRefs`
   *     唯一实现，命名与规则同 `add-image`）；**口径是 `onMissing:'detail'`**：坏引用逐条点名 +
   *     按正文保留 + **不阻断**（整库不该为一条坏引用全灭）—— 为什么与单文件命令不同，
   *     写在 `src/doc-import.js` 的 ⓪⁗ 契约段（唯一权威，本处不复述）。
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
      ok: true, dryRun: !!ctx.dryRun, project: name, dir: dir, dirRef: dirRef, title: title,
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

    if (ctx.dryRun) {
      /* 【批6】资源引用也一并**预览**：`dryRun` ⇒ 只规划（不复制文件、不建目录、不改树），
       * 走的是与真导**同一个函数、同一份判据** ⇒ 不会出现"预览说会落、真导没落"的落差 ✓ */
      const dirRefs = resolveDirImportRefs(ctx, name, built, true);
      report.resourceRefs = dirRefReportJson(dirRefs);
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
      if (built) printDirRefReport(ctx.out, dirRefs, true);
      else ctx.out('资源引用：（超限 ⇒ 没有转换，本次不解析引用）');
      if (built && built.preambles) {
        ctx.out('前导正文：' + built.preambles + ' 个文件的"第一个标题之前的正文"已并入各自**文件节点的详情开头**');
      }
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

    /* 【批6】资源引用落地：**逐文件**调同一个 `resolveImportRefs`（唯一实现；口径与理由见
     * `src/doc-import.js` 的 ⓪⁗ 契约段）。位置在**闸门之后** —— 被拒（超限/重复导入）时
     * **一个资源文件都不复制**，与单文件命令"拒绝是干净的"同一条底线 ✓。
     * 坏引用（`onMissing:'detail'`）不阻断：摘出 `images/files` + 按正文并入详情 + 逐条点名（见 `printDirRefReport`）。 */
    const dirRefs = resolveDirImportRefs(ctx, name, built, false);
    report.resourceRefs = dirRefReportJson(dirRefs);

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
    // 【批6】资源回显（如实报告）：复制了什么、哪条已在项目内、哪条远程/坏引用被按正文保留
    printDirRefReport(ctx.out, dirRefs, false);
    if (built && built.preambles) {
      ctx.out('前导正文：' + built.preambles + ' 个文件的"第一个标题之前的正文"已并入各自**文件节点的详情开头**');
    }
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
    // 【W20】同 `import-project`：这里也接**唯一性有保障**的生成器（三条导入路同一处修法）
    const r = markdown.markdownToTree(md, parent, docImport.uniqueIdGen());
    const added = r.data.children || [];
    // 来源痕挂在**这次导入产生的每棵子树的根**上（= `added` 的每一项）：
    // 条数 = 一次导入里的顶层主题数，而不是节点数 ⇒ 代价极低，但"这份文件导过没有"一眼可查 ✓
    added.forEach((n) => { if (n && typeof n === 'object') n.origin = origin; });
    /* 【W19】资源引用落地（与 `import-project` **同一个函数**）：解析 → 规划 → 复制 →
     * 把 `images[].file` / `files[].file` 从"md 里的原样字符串"改写成**项目内相对路径**。
     * 两条顺序硬约束（都对着既有教训）：
     *   ① **判据不通过就 `ctx.error`**，此时复制一个字节都还没发生（规划先行）⇒ 不会留半份资源；
     *   ② 复制在 `ctx.mutate` **之外**（同 `cli/commands/assets.js` 的做法）：那个 fn 可能被并发重放，
     *      放里面会复制出第二份孤儿文件 —— 改好的 `added` 已经捕获进闭包，重放看到的就是同一份 ✓
     * 【W8】`--dry-run`：**资源复制也要一起关掉**（`dryRun` 传进同一个解析函数 —— 它内部
     *   `if (o.dryRun) return` 那条路就是"规划齐全、一个文件都不复制"，与 import-project 预览同一份实现）。
     *   不关的后果：`import-md … --dry-run` 会往 assets/ 里真复制，而报告说着"一个字节都没写" ✗。 */
    const refs = markdown.resolveImportRefs(added, Object.assign(
      { dryRun: ctx.dryRun }, refResolveOpts(ctx, ctx.projectName, file)));
    if (!refs.ok) ctx.error(refBlockedError(refs, file));
    ctx.mutate((cur) => {
      const parentNode = ctx.tree.find(cur.data, parent);
      // 读之后父节点被别人删了（罕见）⇒ 报错而不是凭空造一个父节点出来
      if (!parentNode) throw new Error('父节点在并发改动后已不存在: ' + parent);
      // 【W14】第一个标题**之前**的正文落在**父节点 detail 的开头**（在原有 detail 之前）——
      // 同一批 mutate 内完成 ⇒ 与节点树的那批改动同版本、同一条日志 ✓
      if (r.preamble) {
        parentNode.detail = parentNode.detail ? r.preamble + '\n' + parentNode.detail : r.preamble;
      }
      parentNode.children = (parentNode.children || []).concat(added);
      return cur;
    });
    ctx.out('导入完成，新增 ' + r.addedCount + ' 个节点（父节点 ' + parent + '）'
      + (ctx.args.force && dup ? '（--force：这是同一个来源的第 2 份）' : ''));
    // 落点如实报告（前导正文去哪了）—— 静默落盘与静默丢弃一样不可查
    if (r.preamble) {
      ctx.out('前导正文（第一个标题之前的正文，' + r.preamble.length + ' 字符 HTML）已并入父节点 '
        + parent + ' 的**详情开头**');
    }
    ctx.out('来源指纹: ' + docImport.describeOrigin(origin));
    // 【W19】资源回显（如实报告）：复制了什么、哪条已在项目内、哪条远程引用被按正文保留
    // 【W8】`dry` 档由 `ctx.dryRun` 决定（同一份报告函数：措辞从"已复制"变成"将复制" + 末尾预览说明）
    printRefReport(ctx.out, refs, ctx.dryRun);
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
  },

  /* ---- 【W1】导出的**纯助手**（不是命令）：`--scope` 的范围解算 ---------------
   * 为什么导出：这条判定有三种"不许静默"的形状（裸写 / 空名单 / 点名了不存在的项目），
   * 而它们都能被**直接**钉死（不必靠端到端造出那些参数组合）。`__` 前缀 = 测试专用入口，
   * 与 `src/heat.js` 里那个 `__set…ForTest` 注入口同一约定；命令面只经 `search-all` 用它。 */
  __scopeList: scopeList
};
