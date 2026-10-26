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
const schema = require('../../src/schema.js');     // 契约取值表 + 绑定迁移（`bind-sync` 取用，别抄字面量）
const uiState = require('../../src/ui-state.js');  // 界面脏信号（`bind-sync` 的纪律①：脏就不写）
const docImport = require('../../src/doc-import.js');  // 功能 5a：md/txt/docx → 提纲（三种前端、一个建树入口）
/* 【W5】`cli/core.js`：本文件只用它两样东西 —— `readTagVocabulary`（读 `docs/TAGS.md` §4 的唯一入口）
 * 与 `TAG_FLOOR` / `TAG_FLOOR_FACADE`（§8 判据① 的两个下限）。为什么走 core 而不是自己拼路径：
 * 见下方 `mergeTagCounts` 上面那段"为什么 `docs/TAGS.md` 的读取不放在本文件"。
 * 依赖方向 `cli/commands/* → cli/core.js` 是既有形态（`cli/commands/relations.js` 取 `SKIP_WRITE` 同此）。 */
const core = require('../core.js');
// 条目层的两件**纯**助手（`mintItemId` / `rerender`）从条目命令那一份实现取 —— `import-md` 的
// "前导正文落成首条条目"必须与 `item-*` 六条命令用**同一份** id 铸造与 detail 重建口径（见那里的导出注释）。
const itemCommands = require('./item.js');

/* ============================================================================
 * 【W14】前导正文的**落点规则**（第一个标题之前的正文往哪儿放）
 * ==========================================================================
 * 判据（唯一两处，都在这里读得到，别再各写一份）：
 *   · 父节点**没有** `items` 键 ⇒ v2 语义：`detail` 是**真源** ⇒ 前导**前置**进 detail
 *     （`preamble + '\n' + 原 detail`，原有内容在其后，一个字都不覆盖）。
 *   · 父节点**有** `items` ⇒ 条目化（`docs/ITEM-MODEL.md` §2 的三档表）：`items` 是真源、
 *     `detail` 只是**派生缓存**，必须逐字节等于 `renderDetail(items)` ⇒ 前导只能当**一条条目**：
 *     新增 `{id,type:'rich',html:preamble}` 插到 `items[0]`，再把 `detail` 整块重建。
 *
 * 为什么非这样不可（W14 的实测形状）：条目化父节点上前置拼 `detail` 字符串 ⇒ **写前校验当场判红**
 * （`src/schema.js` 判 `detail === renderDetail(items)`）⇒ 整个导入 `exit 1`，而回显/预览还说
 * "前导正文已并入父节点详情开头"。而它给出的出路（`render-detail`）会把**刚导进来的前导删掉** ✗ ——
 * 一份会丢内容的报错比不报错更贵。
 * ========================================================================== */

/**
 * 把前导正文落成**条目化父节点**的首条条目（"条目化感知落点"）。
 *
 * 三条规则（都在**同一个事务**内完成）：
 *   ① 新条目插到 `items[0]`（前导正文本来就是一段块级 HTML ⇒ `type:'rich'`）；
 *   ② 前导与原有内容之间那个 `\n` 按 `src/item-model.js` 的拼装表落在**后一条**条目的 `_gap` 上
 *      （`_gap` 的语义是"这一条**之前**的空白"，`validateItems` 放行 `_` 起头的内部键）——
 *      **不手拼 detail**（手拼出来的那份与 items 对不上，就是本批要修的缺陷本身）；
 *   ③ `detail` 由 `renderDetail(items)` 整块重建（走 `item-*` 那一份 `rerender`）。
 *
 * 落点与"非条目化父节点"那条路**逐字节等价**：`_gap` 恰好补回那个分隔换行 ⇒ 结果都是
 * `preamble + '\n' + 原内容`（原内容为空时就是 `preamble`，不多一个换行）。
 *
 * 边界（**响亮拒绝、给出路**，绝不静默降级）：父节点虽有 `items` 但当前 `detail` 与
 * `renderDetail(items)` 不一致 ⇒ 拒绝。理由：那条数据里 **items 不是 detail 的完整真源**，继续下去
 * 只能用 renderDetail 重建 `detail` ⇒ 缓存里**多出来的那部分内容会被悄悄抹掉**（静默丢内容是本工程
 * 最重的损害类别）。同样地，`items` 存在但**不是数组**（外部工具写坏的形态）也拒绝。
 * @param {object} ctx 命令上下文（只为 `ctx.error`；本函数自身不做 I/O、不打印）
 * @param {object} projectData 本次 mutate 里的整份项目数据（`mintItemId` 要在**全项目**里查重）
 * @param {object} node 父节点
 * @param {string} html 前导正文（HTML）
 * @param {string} parent 父节点 id（只用于报文里点名）
 * @returns {boolean} `true` = 走了"条目化"这条路（调用方据此选回显文案）
 */
function landPreambleIntoParent(ctx, projectData, node, html, parent) {
  /** 拒绝（**永远抛**，`ctx.error` 的语义就是"打印 error: 行并终止"，见 cli/core.js） */
  const refuse = (why) => {
    ctx.error('父节点 ' + parent + ' 已**条目化**（它有 `items`：真源是 items，`detail` 只是派生缓存，'
      + '见 docs/ITEM-MODEL.md §2）—— 本次导入**无法**把前导正文（第一个标题之前的正文）放进去：'
      + why + '\n**盘上零改动**：这次导入整体未执行，也没有任何内容被丢弃。\n两条真出路：\n'
      + '  · 换一个**没有** items 的父节点：`import-md <项目> <md文件> --parent <别的节点id>`；\n'
      + '  · 或先把前导正文自己加成一条条目 —— `item-add <项目> ' + parent + ' --md "<前导正文>"`，'
      + '再把 md **从第一个标题开始**截掉前导后导入（条目化节点只认 items，不认整块 detail）。');
  };
  const items = node.items;
  // `items` 存在但不是数组：**坏数据**（写前校验同样判红）⇒ 不走"非条目化"那条路，响亮拒绝
  if (!Array.isArray(items)) {
    refuse('它的 `items` 不是数组（收到 ' + (items === null ? 'null' : typeof items)
      + '）。这份数据本身已经是坏的，先修父节点再导（`node cli/mm-cli.js validate <项目>` 会点名）。');
    return false;
  }
  /* 一致性前置检查：`detail` 必须**正是** items 的渲染结果。
   * 判据用 `rerender` 现算（与 item-* 同一份"怎么重建"的实现），不另写一份渲染。 */
  const actualDetail = (typeof node.detail === 'string') ? node.detail : '';
  const probe = { items: items };
  let rebuilt = '';
  try {
    itemCommands.rerender(probe);
    rebuilt = (typeof probe.detail === 'string') ? probe.detail : '';
  } catch (e) {
    refuse('它的 items 无法渲染成 detail（`renderDetail` 报错：' + ((e && e.message) || e) + '）。');
    return false;
  }
  if (actualDetail !== rebuilt) {
    refuse('它的 `detail` 与 `renderDetail(items)` **不一致**（缓存被写坏了）—— 这种状态下 items 不是 '
      + 'detail 的完整真源，重建 detail 就会把缓存里**多出来的内容**抹掉（静默丢内容）。'
      + '先把这份数据修好再来：确认缓存里多出来那部分不要了，就 '
      + '`node cli/mm-cli.js render-detail <项目> ' + parent + '` 重建它。');
    return false;
  }
  // ---- 落点：新增一条条目到 items[0]，再把 detail 整块重建 ----
  const item = { id: itemCommands.mintItemId(projectData), type: 'rich', html: html };
  // ② 那个分隔换行落在**后一条**条目的 `_gap` 上（`_gap` = "这一条**之前**的空白"）；
  //    旧首条没有 `_gap` 时补的也正是 `'\n'` ⇒ 结果与"非条目化"那条路的字节排布一致。
  if (items.length) items[0]._gap = '\n' + (items[0]._gap || '');
  items.unshift(item);
  itemCommands.rerender(node);
  // 形状兜底：items 不合法就当场拦下（此时还没写盘 ⇒ 盘上零改动）
  itemCommands.assertItemsOk(ctx, node);
  return true;
}

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

/**
 * `--json` 的**确定性**版资源报告（`import-md --json` 用；`import-json` 没有资源引用这一列）。
 *
 * 为什么另给一份而不是直接复用 `refReportJson`：那一份是给**人**看的预览（`--dry-run --json`），
 * 里面有三个**逐跑会变或带本机路径**的字段 —— 而 `import-md --json` 的承诺是"两跑逐字节相同"：
 *   · `node`（节点 id）：新节点 id 由 `src/markdown.js` 的 `idGen` 现摇（时间 36 进制 + 随机后缀）；
 *   · `dest`（真导时生成的资源文件名）：命名规则同样含时间戳（`add-image` 那一条）；
 *   · `tried`（试过的候选路径）：是**解析后的绝对路径**。
 * ⇒ 这三个字段不进 `--json`（它们的完整内容仍在文本回档里，`--json` 不是"更少的信息"，是
 * "只给确定性字段"）。计数一列**不重算**：直接取 `refReportJson` 的同一份结果（否则就是第二份口径）。
 */
function refReportStable(rep) {
  const j = refReportJson(rep);
  if (!j) return null;
  return {
    total: j.total, copy: j.copy, inProject: j.inProject, remote: j.remote,
    missing: j.missing, badExt: j.badExt,
    // 逐条仍然点名（写盘后要能对回"哪条引用落成了什么"），只去掉会变的三列
    refs: (rep.refs || []).map((r) => ({ topic: r.nodeTopic, kind: r.kind, ref: r.raw, status: r.status }))
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

/* ---------------- 【W5】标签清单（`tags`）的命令层零件 ----------------
 * 为什么零件在命令层、纯逻辑在 `src/`：这里要**读盘**（`ctx.store` 扫项目），而 `src/query.js` 的
 * `computeTagCounts` 是"不读盘、不认识项目名"的纯函数（与 `computeStats` 同一个分工）。
 * **数标签只有一处实现**：逐项目计数全走 `query.computeTagCounts`，这里只做跨项目合并 ——
 * 不许再写一遍遍历（否则"根节点算不算""重复标签算几次"迟早两处各说一套，那是最贵的病）。
 *
 * ⚠️ **`docs/TAGS.md` 的读取刻意不放在本文件**（在 `cli/core.js` 的 `readTagVocabulary`）：
 * 本文件有 3 处**目标判不了**的存量裸写（`mdFile` / `index.html` / `file`），而 S2 ⑤ 的写盘出口门禁
 * 判定 ④ 的规则是"文件里出现受管资产名字面量 + 有判不了的裸写 ⇒ 可能在写受管资产"——
 * 一在这里 `path.join(…, 'docs', 'TAGS.md')`，这 3 处存量会当场变红，而豁免面 siteCap 82
 * **只减不增**（`scripts/collateral-check.js` 的 `WRITE_OUTLET_SITE_CAP`）⇒ 只能让"读受管文本"
 * 留在本来就归它管的那一层（`cli/core.js` 已经持有 `PROJECTS_DIR` 这个工程级路径事实）。
 */

/**
 * 跨项目合并一份标签清单（`tags` 的骨架）。
 *
 * 口径（判据，可复算）：
 *   · 扫描顺序 = 传入的 `names` 顺序（调用方已按**项目名升序**排好 ⇒ 与文件系统序无关）；
 *   · 每个项目的节点数/带标签节点数/逐标签计数**全部来自** `query.computeTagCounts`（唯一实现）；
 *   · `projectsOf(t) = [{project, nodes}]` 按项目名升序（确定序）；
 *   · `tags[]` 按 `nodes` **降序**、同数按标签名**码点升序**（显示口径；两跑逐字节相同）；
 *   · 读不动的项目：`strict`（点名项目时）⇒ 报错；否则登记进 `unreadable[]` 并继续
 *     —— 与 `health` 的库级模式同一条纪律（读数命令不该被一个坏文件挡住，但也绝不静默）。
 *
 * @returns {{projects:string[], nodes:number, taggedNodes:number, untaggedNodes:number,
 *            tagCount:number, tags:Array, unreadable:Array}}
 */
function mergeTagCounts(ctx, names, strict) {
  const unreadable = [];
  const scanned = [];
  const merged = new Map();           // tag → { nodes, byProject: Map<project, nodes> }
  let nodes = 0;
  let taggedNodes = 0;

  names.forEach((name) => {
    let data = null;
    try { data = ctx.store.read(name).data; }
    catch (e) {
      const why = (e && e.message) || String(e);
      if (strict) ctx.error('项目读不了：' + name + '（' + why + '）—— 点名的项目读不动就不给读数'
        + '（半份清单比没有清单更容易被当真）。');
      unreadable.push({ project: name, error: why });
      return;
    }
    const one = query.computeTagCounts(data && data.data);
    nodes += one.nodes;
    taggedNodes += one.taggedNodes;
    one.counts.forEach((c) => {
      const cur = merged.get(c.tag) || { nodes: 0, byProject: new Map() };
      cur.nodes += c.nodes;
      cur.byProject.set(name, (cur.byProject.get(name) || 0) + c.nodes);
      merged.set(c.tag, cur);
    });
    scanned.push(name);
  });

  const tags = Array.from(merged.keys()).map((tag) => {
    const cur = merged.get(tag);
    const byProject = Array.from(cur.byProject.keys()).sort(query.compareStrings)
      .map((p) => ({ project: p, nodes: cur.byProject.get(p) }));
    return { tag: tag, nodes: cur.nodes, projects: byProject };
  });
  // 显示口径：节点数降序 → 标签名升序（**不用 localeCompare**：那按环境 locale 定序，
  // 而 `--json` 承诺两跑 sha256 相同）
  tags.sort((a, b) => (b.nodes - a.nodes) || query.compareStrings(a.tag, b.tag));

  return {
    projects: scanned,
    nodes: nodes,
    taggedNodes: taggedNodes,
    untaggedNodes: nodes - taggedNodes,
    tagCount: tags.length,
    tags: tags,
    unreadable: unreadable
  };
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
      src: o.src, verified: o.verified, type: o.type, since: o.since, now: o.now,
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
   * 给了就要报"这一路接回来几条、接回来的命中报什么 `matchIn`、门槛是多少"。
   * 一条都没接回来时必须说**为什么**（没有那份数据 / 这一批不需要扩）—— 少一个开关 / 少一路都要看得见。
   * 【W3-do】门槛的人话**只有一处**（`src/palette-rank.js` 的 `boundText`）：`graph` 是"上界 2 跳"、
   * `expand` 是"最短公共片段 ≥ 2 字" —— 在这里各拼一份就会渲染成"上界 undefined 跳"。
   * 读的是 `explain.recall.routes[].boundText`（`recallReport` 已把那一份带出来）。 */
  const rec = ex.recall;
  if (rec) {
    const asked = rec.routes.filter((r) => r.asked);
    const meter = (r) => (r.boundText !== undefined ? r.boundText
      : (Number(r.bound) > 0 ? '上界 ' + r.bound + ' 跳' : ''));
    ctx.out(rec.on
      ? '  · 扩召回（--recall ' + rec.asked.join(',') + '）：'
        + asked.map((r) => '路 `' + r.id + '` 接回 ' + r.added + ' 条新候选'
          + '（它们报 matchIn=' + r.hitValue + '，' + meter(r) + ' = 路由表那一行声明的门槛）').join('；')
      : '  · 扩召回：**未启用**（不给 --recall 时它不参与，候选集与从前逐字节相同）；能扩召回的路：'
        + rec.routes.map((r) => r.id + '（报 ' + r.hitValue + '，' + meter(r) + '）').join(' / '));
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
      /* 【`TL`/`W2`】`--now`：相对 `--since 7d` 的唯一起点。**原样透传**给纯逻辑层判（缺它 ⇒ 那边当场红），
       * 命令层不自己判"给了没给" —— 那不是第二份条件表，那会变成第二个报文。 */
      now: ctx.args.now,
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
      now: ctx.args.now,
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
      now: ctx.args.now,
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

  /**
   * 【W5】`tags` —— **标签清单**（只读）：有哪些标签、各多少个节点、分布在哪几个项目。
   *
   * ## 为什么需要它（台账原话，不是我的发明）
   * `.review/20261010-卖点与功能-常驻讨论/待做清单.md:126` 逐字：
   *   「**W5a 跨项目标签聚合**：列出**全部标签 + 计数** ✓（现在 `stats` 只给标签总数 ✗）、
   *     某标签下的**跨项目节点清单** ✓。」
   * 后半句已经兑现（`search-all --tag`，见 `docs/FEATURES.md` §5 第 108 行的既有裁决：
   * "其聚合那半已由 `CS` 承载"）；**前半句没有出口** —— `stats` 只给 `tags: <个数>`，
   * 而 `search --tag` **要求你先知道标签名**。于是"这库里到底有哪些标签"是个死结：
   * 不认识它，标签这一维就只剩"点一个已知标签"。
   *
   * ## 明确不做（逐条都有可复算的理由，见 `.review/20261020-W5-tag-relations/00-定题.md` §2/§5.3）
   *   · **标签之间的共现图**：7 本书 432 个带标签节点里 87.3% 只带 1 个标签；真实共现只有 38 对、
   *     最强一对 5 个节点、94.9% 的标签对从不同时出现 ⇒ 印出来是把"默认状态"当异常报告。
   *     而且共现统计**已有归属**（`待做清单.md:150` 把"同类 = 共现统计"写进 `W10`）。
   *   · **孤岛（只出现在 1 个节点上的标签）**：`docs/TAGS.md` §2 第 4 条 + §8 判据①（≥5 落点）
   *     已经保证它**恒为空**（实测 7 本书 0 个）⇒ 永远输出空表的判据不是判据。
   *   · **标签树 / 上位 / 下位**：`docs/TAGS.md` §3 已把标签钉成"**平的**、不带前缀"（5 条理由）。
   *   · **某标签下的节点清单**：已有 `search-all --tag`，重做就是第二份实现。
   *   · **写盘**（改标签 / 批量迁移）：那是标签治理（`TC`/`W10`）的活。
   *
   * ## 三条契约判据（只在 `--vocab` 下给）
   *   ① **闭集**：出现的标签是不是 `docs/TAGS.md` §4 那个词表里的（`tags[].inVocab`）；
   *   ② **落点下限**：`docs/TAGS.md` §2 第 6 条 + §8 判据①（≥5 落点；某本书的门面特性 ≥3 ——
   *      "门面特性"按 §4 该行有没有那四个字**机械识别**，§8 原文就是"脚本按这四个字识别"）；
   *   ③ **反向缺口**：§4 里有、本次扫描面里 **0 落点**的标签（词表空转）。
   *   ②与③**不重叠**：0 落点只进③，`0 < 落点 < 下限` 才进②（同一件事不报两遍）。
   *
   * ## ⚠️ `--vocab` 为什么必须点名项目（本命令唯一一条"反直觉"的规矩）
   *   `docs/TAGS.md` 的标题写的是「**7 本书共用**词表」—— 词表**有适用范围**，而"哪几个项目属于
   *   那 7 本"**在盘上没有机器可读的声明**：`comnet` 就有另一套标签（`协议`/`机制`/`概念`…），
   *   那**不是越界**，是**不受这份词表约束**。
   *   ⇒ 本命令**不替调用方认定适用范围**：
   *     · 不给项目名 = **全库** = 一个"清单"问题，不是一个"合规"问题 ⇒ 拒绝给判据（exit 1 + 出路）；
   *     · **点名项目 = 调用方声明"这几本适用那份词表"** ⇒ 才给三条判据。
   *   这条同时挡掉一个静默陷阱：全库跑判据会把 `comnet` 那 12 个自有标签打成"不在词表内"，
   *   而它们本来就不该被这个词表管。
   *
   * ## 确定性与只读
   *   · **只读**：不写项目、不写变更日志、不进 `WRITE_COMMANDS`（`--idem` 会被 dispatch 拒绝）；
   *   · 扫描顺序 = 项目名**码点升序**；`tags[]` = 节点数降序 → 标签名码点升序；项目内分布同理
   *     ⇒ `--json` **两跑逐字节相同**（无时间戳、无随机、无 locale 依存的排序）。
   */
  tags(ctx) {
    // ---- ① `--vocab` 的形态闸门（纯布尔；带 `=` 的写法与 `contents --apply` 同一条口径）----
    if (typeof ctx.args.vocab === 'string') {
      ctx.error('`--vocab` 是**纯布尔**开关，不接受 `=` 赋值（收到 `--vocab=' + ctx.args.vocab + '`）。'
        + '去掉值即可：`tags <项目…> --vocab`。');
    }
    const wantVocab = !!ctx.args.vocab;

    // ---- ② 扫描面：点名 ⇒ 只扫这些；不点名 ⇒ 全库（项目名升序 = 确定序）----
    const all = storeProjectNames(ctx);
    if (!all.length) {
      ctx.error('库里一个项目都没有（`projects/` 下没有 <名字>/<名字>.json）—— 先 `init <项目>`。');
    }
    const named = [];
    (Array.isArray(ctx.args._) ? ctx.args._ : []).forEach((x) => {
      const n = (typeof x === 'string') ? x.trim() : '';
      if (n && named.indexOf(n) < 0) named.push(n);
    });
    let names = all;
    if (named.length) {
      const missing = named.filter((n) => all.indexOf(n) < 0);
      if (missing.length) {
        ctx.error('点名的项目不在库里：' + missing.join(' / ')
          + ' · 库里现有 ' + all.length + ' 个：' + all.join(' / ')
          + ' · 名字要写目录名（`projects/` 下那一层），不是 meta.name；'
          + '全库清单请直接 `tags`（不给项目名）');
      }
      names = named.slice().sort(compareProjectNames);
    }

    // ---- ③ `--vocab` 的适用范围闸门（理由见函数头那一节）----
    if (wantVocab && !named.length) {
      ctx.error('`--vocab` 必须**点名项目**（例：`tags ' + all[0] + ' --vocab`）：'
        + '`docs/TAGS.md` 的标题是「**7 本书共用**词表」—— 词表**有适用范围**，而"哪几个项目属于'
        + '那 7 本"在盘上没有机器可读的声明（`comnet` 就有另一套标签，不受这份词表约束）。'
        + '⇒ 不给项目名 = 全库 = 一个**清单**问题、不是一个**合规**问题，本命令不替你认定适用范围。'
        + '要判词表，就把适用的那几本**点名**出来。');
    }

    // ---- ④ 扫盘（逐项目计数走 `src/query.js` 的唯一实现；本层只合并）----
    const scan = mergeTagCounts(ctx, names, named.length > 0);

    // ---- ⑤ 词表核对（懒解析：不给 `--vocab` 就一个字节都不读词表）----
    let vocab = null;
    let vocabSet = null;
    let outOfVocab = [];
    if (wantVocab) {
      const v = core.readTagVocabulary();
      if (!v.ok) ctx.error(v.message);
      vocabSet = new Set(v.items.map((it) => it.tag));
      const nodesOf = new Map(scan.tags.map((t) => [t.tag, t.nodes]));
      const unused = [];        // §4 有、扫描面 0 落点（文档序 ⇒ 读出来还看得出分组）
      const belowFloor = [];    // 0 < 落点 < 下限
      v.items.forEach((it) => {
        const n = nodesOf.get(it.tag) || 0;
        if (n === 0) { unused.push(it.tag); return; }
        const floor = it.facade ? core.TAG_FLOOR_FACADE : core.TAG_FLOOR;
        if (n < floor) belowFloor.push({ tag: it.tag, nodes: n, floor: floor });
      });
      outOfVocab = scan.tags.filter((t) => !vocabSet.has(t.tag)).map((t) => t.tag);
      vocab = { source: 'docs/TAGS.md §4', count: v.items.length, unused: unused, belowFloor: belowFloor };
    }

    // ---- ⑥ 输出（JSON 键序写死；`inVocab`/`unreadable`/`vocab` 只在真有内容时出现）----
    const tagsOut = scan.tags.map((t) => {
      const o = { tag: t.tag, nodes: t.nodes, projects: t.projects };
      if (vocabSet) o.inVocab = vocabSet.has(t.tag);
      return o;
    });
    if (ctx.args.json) {
      const payload = {
        ok: true,
        mode: named.length ? 'named' : 'library',
        projects: scan.projects,
        nodes: scan.nodes,
        taggedNodes: scan.taggedNodes,
        untaggedNodes: scan.untaggedNodes,
        tagCount: scan.tagCount,
        tags: tagsOut
      };
      if (scan.unreadable.length) payload.unreadable = scan.unreadable;
      if (vocab) payload.vocab = vocab;
      ctx.outJson(payload);
      return;
    }

    // ---- 文本档 ----
    // 「读不动的项目」必须排在**读数之前**：不然人家先读到一堆数字、最后才知道它们不完整。
    if (scan.unreadable.length) {
      ctx.out('⚠ 读不动、本次**没扫到**的项目 ' + scan.unreadable.length + ' 个（下面的读数里不含它们）：');
      scan.unreadable.forEach((u) => ctx.out('  · ' + u.project + '：' + u.error));
      ctx.out('');
    }
    ctx.out('标签清单 · ' + (named.length ? '点名的 ' + scan.projects.length + ' 个项目'
      : '全库 ' + scan.projects.length + ' 个项目')
      + ' / ' + scan.nodes + ' 个节点（带标签 ' + scan.taggedNodes
      + ' · 无标签 ' + scan.untaggedNodes + '）｜ 不同标签 ' + scan.tagCount + ' 个');
    if (!scan.tagCount) {
      ctx.out('  （这批项目里一个标签都没有 —— 不是命令坏了：本命令数的是 `node.tags`，空就是空。'
        + '要打标签见 `edit --tags` / `item-add --tags`，词表见 `docs/TAGS.md`。）');
    }
    scan.tags.forEach((t) => {
      ctx.out('  ' + t.nodes + ' 个节点 · ' + t.tag + ' · '
        + t.projects.map((p) => p.project + ' ' + p.nodes).join(' / '));
    });

    if (vocab) {
      ctx.out('');
      ctx.out('词表核对（来源 docs/TAGS.md §4，共 ' + vocab.count + ' 个标签；'
        + '扫描面 = 你点名的 ' + scan.projects.length + ' 个项目）');
      ctx.out('  · 不在词表内的标签：' + (outOfVocab.length
        ? outOfVocab.length + ' 个 — ' + outOfVocab.join(' / ') : '0 个'));
      ctx.out('  · 落点低于下限：' + (vocab.belowFloor.length
        ? vocab.belowFloor.map((b) => b.tag + '（' + b.nodes + ' < ' + b.floor + '）').join(' / ') : '0 个')
        + '（下限 ≥' + core.TAG_FLOOR + '；§4 里写明「门面特性」的行 ≥' + core.TAG_FLOOR_FACADE + '）');
      ctx.out('  · 词表里有但 0 落点：' + (vocab.unused.length
        ? vocab.unused.length + ' 个 — ' + vocab.unused.join(' / ') : '0 个'));
      ctx.out('  ⚠ 「不在词表内」只对你**点名的那几个项目**成立：`docs/TAGS.md` 的标题是'
        + '「7 本书共用词表」，别把不受它约束的项目（如 `comnet`）一起点进来再报违规。');
    }
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
      // 「哪几行是标题」只有**一处**判据（`src/markdown.js` 的 `outlineHeadingLines`，
      // 围栏感知、与建树同源）。从前这里又写了一遍朴素正则 `/^#{1,6}\s+\S/` ⇒ 围栏里的 `#`
      // 会被当成"前几个顶层主题"列出来（同一件事的第三份口径，本批一并收掉）。
      const heads = markdown.outlineHeadingLines(conv.md).slice(0, 8).map((h) => h.line);
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
        topHeadings: heads
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
      + '[--max-files N] [--vault|--no-vault] [--dry-run] [--force]');
    // ① 入参闸门：整库导入要的是**目录**（给成文件 / 不存在 / 没权限 ⇒ 各自原因准确 + 给出路）
    const bad = docImport.describeImportDirProblem(dir);
    if (bad) ctx.error(bad.message);
    if (fs.existsSync(path.join(ctx.PROJECTS_DIR, name, name + '.json'))) {
      ctx.error('项目已存在: ' + name + '（换个名字，或先删掉它）');
    }
    /* 【W12】Obsidian 库直进：`--vault`（或目录里真有 `.obsidian/`）⇒ 多走一段 wiki 解析。
     * ⚠️ **`--no-vault` 是那条"逐字节不变"的出口**：库目录里也有只想拿结构的时候（第三方插件导出的
     *    库、别人给的库），而没有它的话"自动识别"会把这类需求逼进死角。给了它就**只走**既有的
     *    `buildDirImportTree` 那条链（与从前**逐字节相同**，`vaultReport` 为 null）。
     * 为什么做成"自动识别 + 两条显式开关"都认：想导一个库的人**不会**先去查有没有这个开关
     *    （W13 那条教训：最自然的第一反应是**拖目录**），而显式 `--vault` 让"这个目录不是标准库结构、
     *    但里面写着 `[[…]]`"这种情形也走得通 ✓ */
    const noVault = !!ctx.args.noVault;
    const explicitVault = !!ctx.args.vault && !noVault;
    const autoVault = !explicitVault && !noVault && docImport.isVaultDir(dir);
    const vault = explicitVault || autoVault;
    // ② 范围与上限：**读任何文件之前**就定下来（`--ext` 非法值是当场报错，不静默退成默认 ✗）
    const extRes = ctx.args.ext === undefined
      ? { ok: true, ext: docImport.IMPORT_EXT_DEFAULT.slice() }
      : docImport.normalizeExtList(ctx.args.ext);
    if (!extRes.ok) ctx.error('--ext ' + extRes.reason);
    // ③ 扫描（**只读**：走查目录、逐类计数跳过、算总量；不读文件内容、不写盘、不建树）
    const scan = docImport.scanImportDir(dir, { ext: extRes.ext, vault: vault });
    if (!scan.totals.files) ctx.error(docImport.describeNoImportableFiles(scan.root, scan));
    /* 【20261043】闸门只剩**文件数**这一道（`--max-files`，管"人还能不能核对"）。
     * 目录**总量不再是一道拒绝线**：以前拿单文件的 64 MB 去卡整个目录（"合计约 167 MB 超过上限 64 MB"），
     * 那是量错了维度 —— 占内存的是**节点对象**（与标题数成正比），源文件内容是逐文件转换、每轮即弃的。
     * 实测反例：用户的课程目录 7.85 GB / 14989 个文件，可导入面其实只有 143 个文件 / 168 MB / 约 150 个节点。
     * ⇒ 现在超过"单批线"只**分批**（`docImport.planImportBatches` / ⓪⁸），拒绝线只有 `--max-files`。 */
    const maxFiles = ctx.intOption('maxFiles', { min: 1, max: 100000, def: docImport.MAX_IMPORT_FILES_DEFAULT });
    const overFiles = scan.totals.files > maxFiles;
    const overBatch = scan.totals.bytes > docImport.MAX_IMPORT_BATCH_BYTES;
    const batchNote = overBatch
      ? docImport.describeDirOversize(scan.root, scan.totals.bytes, docImport.MAX_IMPORT_BATCH_BYTES) : null;
    const limitMsg = overFiles
      ? docImport.describeTooManyFiles(scan.totals.files, maxFiles, scan.root) : null;
    /* 分批计划（纯函数：只吃扫描清单）—— 预览要用它报"分几批"，真导再用**同一份**去建树
     * （算两遍会漂移：报告说 6 批、实际按 7 批建，是最难查的那类 ✗）。 */
    const plan = docImport.planImportBatches(scan);

    // ④ 转换 + 建树：**逐批转换**（一批 = 一棵完整顶层子树，见 ⓪⁸），最后**一次原子写**。
    //    为什么不是"每批写一次盘"：项目是一个 JSON，N 次写 = N 次全量重读（O(N²)），
    //    而且会把"失败不留半个项目"降级成"半份项目"。理由与实测见 ⓪⁸。 */
    /* 【W12】vault 那一路走 `applyVault`（**同一个 `buildDirImportTree`**，只是带了正文转换与 wiki 解析）：
     * 资源引用的落点也一并交给它 —— 它内部调的是**同一个** `resolveDirImportRefs`（唯一实现），
     * 只是位置挪到"wiki 解析之后"（`![[图]]` 是 wiki 语法，得先变成资源行才轮到既有那一步）✓ */
    const vaultRes = (limitMsg || !vault) ? null : docImport.applyVault(scan, {
      project: name,
      tool: 'import-dir',
      baseDirOf: (e) => (e && e.abs ? path.dirname(e.abs) : scan.root),
      /* ⚠️ `resolveDirImportRefs` 收的是 `{refTargets:[…]}`、回的是**按文件分组的数组**；这里只要
       * "这一个文件的那一份"（`rows[0].rep`）—— 交回数组会让下游把 `rep.refs` 读成 undefined（实测踩到）。 */
      resolveRefs: (baseDir, node) => {
        const rows = resolveDirImportRefs(ctx, name,
          { refTargets: [{ rel: '', baseDir: baseDir, node: node }] }, !!ctx.dryRun);
        return rows.length ? rows[0].rep : null;
      }
    });
    /* 进度行只在**非 `--json`** 时打（`--json` 的 stdout 必须是那份 JSON，多一行就解析不了 ✗）。
     * 为什么必须有：真导一个 7.8 GB 的目录要几十分钟，中间一声不响 = 使用者以为又"莫名退出"了。 */
    const showProgress = !ctx.args.json && !vaultRes;
    if (showProgress && !limitMsg) {
      ctx.out('分批转换：' + plan.length + ' 批 / ' + scan.totals.files + ' 个文件 / '
        + (scan.totals.bytes / 1048576).toFixed(2) + ' MB'
        + (overBatch ? '（超过单批 ' + docImport.MAX_IMPORT_BATCH_MB + ' MB ⇒ 按顶层子树分批，**不拒绝**）' : ''));
    }
    const built = vaultRes ? vaultRes.built : (limitMsg ? null : docImport.buildDirImportTreeBatched(scan, {
      tool: 'import-dir',
      plan: plan,
      onBatch: (info, i, total) => {
        if (!showProgress) return;
        ctx.out('  批 ' + (i + 1) + '/' + total + '：' + info.name + ' —— ' + info.files + ' 个文件 → '
          + info.nodes + ' 个节点（' + (info.bytes / 1048576).toFixed(2) + ' MB / ' + info.ms + ' ms）'
          + (info.over ? '　⚠ 超过单批线 ' + docImport.MAX_IMPORT_BATCH_MB + ' MB：**不拆也不拒绝**（见 ⓪⁸）' : ''));
      },
      onFile: (info) => {
        if (!showProgress || info.index % 25 !== 0) return;
        ctx.out('    …已处理 ' + info.index + '/' + scan.totals.files + ' 个文件：' + info.rel);
      }
    }));
    const vaultReport = vaultRes ? vaultRes.vault : null;
    /* vault 报告里两类"没接上"的条目要并入**同一份**跳过清单（"逐条点名"只走这一条渲染路，
     * 免得同一个地方出现两套 ✗）。⚠️ 资源那一类**不在这里列**：它已经由既有 `printDirRefReport`
     * 逐条点名（`resourceRefs.bad` 与它同源）⇒ 再列一遍就是同一件事说两遍（实测踩到重复行）。 */
    const vaultIssues = vaultReport ? [
      ...vaultReport.dangling.map((u) => ({ rel: u.file, reason: 'vault-dangling',
        message: '「' + (u.raw || '') + '」' + (u.why ? ' —— ' + u.why : '') })),
      ...vaultReport.ambiguous.map((u) => ({ rel: u.file, reason: 'vault-ambiguous',
        message: '「' + (u.raw || '') + '」同名多篇：' + (u.hits || []).join('、') + ' ⇒ 不猜，没有写这条边' }))
    ] : [];
    const skipped = (scan.skipped || []).concat(built ? built.skipped : []).concat(vaultIssues);
    const counts = docImport.groupSkips(skipped);
    // 扫得到文件、但**一个都没转换成功**（全是坏文件/全空）⇒ 与"目录里没有可导入的文件"同一处理：
    // 响亮拒绝，绝不建一个空项目 ✗
    if (built && !built.files) {
      ctx.error(docImport.describeNoImportableFiles(scan.root,
        Object.assign({}, scan, { skipped: skipped, counts: counts })));
    }
    const byFormat = { md: 0, txt: 0, docx: 0, pdf: 0, video: 0 };
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
      if (limitMsg) {
        out('⚠ 文件数超限：可导入文件 ' + scan.totals.files + ' 个 > 上限 ' + maxFiles + ' 个（`--max-files` 可放开）');
        if (vaultRefusalNote) out('　' + vaultRefusalNote);
        return;
      }
      // 【20261043】**目录总量不是拒绝线**：超过单批线只打印"会自动分批"这一条（措辞在 src 里，一处）
      if (batchNote) out('ℹ ' + batchNote);
      /* 【20261052】vault 那一路**不按批切**（`applyVault` 一次建完：全库索引要先建好才轮到解析链接）。
       * 不说这一句的后果：读者看到"自动分批"会以为它按批走，而它的内存曲线是**一整批**的。
       * 只在 vault 档追加 ⇒ `--no-vault` 的输出与从前逐字节相同 ✓ */
      if (batchNote && vault) {
        out('　⚠ `--vault` 那一路是**一次建完**（链接要在全库索引建好之后才解析）⇒ 它不按上面的批切，'
          + '体量很大时内存占用会高于默认档。');
      }
    };
    const topBrief = '顶层 ' + scan.tree.dirs.length + ' 个目录 / ' + scan.tree.files.length + ' 个文件'
      + (topLevel.length ? '：' + topLevel.slice(0, 12).map((t) => t.topic + (t.kind === 'dir' ? '/' : '')).join(' ') : '');

    /* 【W12】vault 报告的回显（**逐条点名**：断链 / 同名多篇 / 附件没落成都在 `printSkips` 里列过了，
     * 这里给读数与"哪些选项在起作用"）。读数一律**现算**（来自 `applyVault` 的同一份累加器，
     * 不在这里重数一遍 —— 第二处计数必然与落盘的边漂移 ✗）。 */
    const printVault = (out) => {
      if (!vaultReport) return;
      out('Obsidian 直进（--vault' + (autoVault ? '，自动识别到 .obsidian/' : '') + '）：'
        + vaultReport.files + ' 篇笔记 ｜ wiki 链接 ' + vaultReport.linkTotal + ' 条：'
        + '接成关联 ' + vaultReport.linked + ' 条（其中落标题 ' + vaultReport.headingLinks
        + ' / 带别名 ' + vaultReport.aliasLinks + ' / 笔记嵌入按链接处理 ' + vaultReport.embedLinks + '）'
        + ' ｜ 断链与认不出的 ' + vaultReport.danglingTotal + ' 条'
        + '（详见下面的跳过清单，**一条悬空链接都没写**）');
      out('frontmatter：' + vaultReport.frontmatterFiles + ' 篇有 ｜ 带标签 ' + vaultReport.taggedFiles
        + ' 篇 ｜ 标签 ' + (vaultReport.tags.length ? vaultReport.tags.join(' / ') : '（无）')
        + ' ｜ 别名 ' + (vaultReport.aliases.length ? vaultReport.aliases.join(' / ') : '（无）')
        + '（标签落到**那种笔记的文件节点**的 tags 上，键与其它命令同一处 ✓）');
      out('附件/图片嵌入：' + vaultReport.resourceTotal + ' 条'
        + (vaultReport.skippedDirs.length
          ? ' ｜ 附件目录 ' + vaultReport.skippedDirs.join(' / ') + ' 按 P0 边界没有导入（附件本身属 P1）' : ''));
      vaultReport.notes.forEach((n) => out('  ⚠ ' + n));
      /* 落点**逐条可读**（`--json` 里有全部；文本档给前若干条 —— 与 `printSkips` 的上限口径一致） */
      vaultReport.links.slice(0, 20).forEach((l) => out('  · ' + l.file + ' → ' + l.toTopic
        + '（' + l.to + '）' + (l.kind === 'heading' ? ' 落「' + l.chain + '」' : '')));
      if (vaultReport.links.length > 20) out('  · …另有 ' + (vaultReport.links.length - 20) + ' 条（`--json` 里有全部）');
    };

    /* 【20261043】视频分档的读数（⓪⁹）：**入口**与**分片**分开说 —— 这是用户要的那条判据
     * （"因为它是视频分片/密钥/索引而跳过"必须能看见，不许混进"扩展名不支持"）。 */
    const printVideo = (out) => {
      const v = scan.video || { entries: 0, parts: 0 };
      if (!v.entries && !v.parts) return;
      out('视频：' + v.entries + ' 个播放列表（.m3u8）按**入口节点**处理 —— 节点字段 `localPath` 指向本机那份文件'
        + '（点开交给系统默认程序；**不内嵌、不拷贝**）'
        + (v.parts ? '；另 ' + v.parts + ' 个分片/密钥/索引按"没有意义"跳过'
          + '（清单里的 `视频分片/密钥/索引` 一类）' : ''));
      if (built && (built.videos || built.localPathSkipped)) {
        out('     树里落成 ' + built.videos + ' 个视频节点'
          + (built.localPathSkipped
            ? '（⚠ ' + built.localPathSkipped + ' 个节点的路径超过 ' + docImport.LOCAL_PATH_MAX
              + ' 字符 ⇒ 没有写 `localPath`，见 `docs/DATA-FORMAT.md` §2.5）' : ''));
      }
    };

    /** 【W12】vault 那一路的引用读数 → `printDirRefReport` 认的那份形状（`[{rel, rep}]`）。
     *  `applyVault` 交回来的是 `Map<rel, rep>`；这里只做**搬运**（不重新解析、也不重新复制 ——
     *  落地那一步已经在 `applyVault` 里真的做过了，调的是同一个 `resolveImportRefs`）。 */
    const vaultDirRefs = () => Array.from(vaultRes.refs.entries())
      .map(([rel, rep]) => ({ rel: rel || name, rep: rep }));

    /* 【20261052】"**实际**建了几批"只能问 `built` —— 而 `built.batches` **只有分批那条链才有**
     * （`buildDirImportTreeBatched`）。vault 那一路是 `applyVault` → `buildDirImportTree` 的
     * **一次建完** ⇒ 它的 `built` 里**没有** `batches`。
     * ⚠️ 这里曾经直接读 `built.batches.length` ⇒ 抛 `TypeError: Cannot read properties of undefined
     * (reading 'length')` ⇒ 整条命令在 `ctx.write` **之前**就死掉 ⇒ 项目一个字节都没落地，
     * 而下游（冒烟域 44 的 5 条断言）只看到"读项目 JSON ⇒ ENOENT"——**失败没有出口**，
     * 于是这个缺陷潜伏了整整一个批次（域 44 单跑 9/14 才暴露）。实测读数见
     * `.review/20261052-vault不落盘/`：同一次运行里 `--no-vault` 走分批链 ⇒ 有 `batches` ⇒ 绿。
     * 口径：没有 `batches` 的那条链就是**一批**（如实报，不假装分了批）；`built` 为 null 时
     * （`--dry-run` 预览 / 文件数超限被挡）退回 `plan` —— 那是"会怎么分"的预览，两种输出共用这一份。 */
    const builtBatches = (built && Array.isArray(built.batches) && built.batches.length)
      ? built.batches
      : (built ? [{
        name: '（整个目录：一次建完，不分批）', files: built.files, nodes: built.nodes,
        bytes: scan.totals.bytes, over: overBatch
      }] : null);
    /* 【20261052】被拒时必须**说清连带没做的事**：vault 那一路的 wiki 解析 / frontmatter 标签 /
     * 附件落点全在**建树之后** ⇒ 建树没发生，它们一步都没执行（报告里的 `vault` 也是 null）。
     * 从前被拒只报一句"文件数超限"，读者会以为"少导了一部分"，而真相是**整批没导**。 */
    const vaultRefusalNote = vault
      ? '（`--vault` 那一路**整批都没导**：wiki 解析 / frontmatter 标签 / 附件落点都在建树之后，一步没执行）'
      : '';
    /* 【20261052】"分批数"只有一个来源：**建过就问 `built`，没建才退回计划**（预览）。
     * 预览文本里那句"本次 N 批"也用它 —— 否则 vault 档会出现"报告 count=1、正文说 4 批"的自相矛盾。 */
    const batchCount = built ? builtBatches.length : plan.length;

    const report = {
      ok: true, dryRun: !!ctx.dryRun, project: name, dir: dir, dirRef: dirRef, title: title,
      ext: scan.ext, maxFiles: maxFiles,
      containers: containers, files: filesImported, nodes: nodes,
      formats: byFormat, topLevel: topLevel,
      skippedCount: skipped.length, skippedByReason: counts, skippedDetail: skipped.slice(0, 200),
      size: {
        bytes: scan.totals.bytes, mb: Math.round(scan.totals.bytes / 1048576 * 100) / 100,
        /* 【20261043】`over` 现在读作"**超过单批线 ⇒ 会分批**"（**不是**超限拒绝：目录总量没有上限）。
         * 字段名沿用 `over` 是为了不动 `--json` 的既有形状（`size.over` 一直是"这一项会不会绊住导入"）。 */
        batchMB: docImport.MAX_IMPORT_BATCH_MB, over: overBatch
      },
      /* 分批读数（⓪⁸）：`count` = **实际**建了几批（建过 ⇒ 从 `built` 读；没建 ⇒ 退回计划里的分批数，
       * 那是预览）；`batches` 逐批给名字/文件数/体量/节点数（`ms` 不进 JSON —— 它会逐跑变 ✗）。
       * vault 那一路是**一次建完** ⇒ `count` = 1、那一批的名字写明"一次建完，不分批"（见 `builtBatches` 那段）。
       * ⚠️ 字段形状与前一样（`name/files/nodes/bytes/over`），**没有**为 vault 新增字段 ——
       * 默认档的 `--json` 因此与从前逐字节相同 ✓ */
      batching: {
        batchMB: docImport.MAX_IMPORT_BATCH_MB, batchFiles: docImport.MAX_IMPORT_BATCH_FILES,
        count: batchCount, over: overBatch,
        batches: (built ? builtBatches : plan.map((b) => ({
          name: b.name || '（根下的文件）', files: b.files, nodes: null, bytes: b.bytes, over: !!b.over
        }))).map((b) => ({ name: b.name, files: b.files, nodes: (b.nodes === undefined ? null : b.nodes),
          bytes: b.bytes, over: !!b.over }))
      },
      /* 视频分档（⓪⁹）：`entries` = 当"入口节点"导入的播放列表数；`parts` = 按"没有意义"跳过的分片/密钥/索引数。
       * 两个数**分开报**就是用户要的那条读数（"因为它是分片而跳过"必须看得见，不许混进"扩展名不支持"）。 */
      video: { entries: scan.video ? scan.video.entries : 0, parts: scan.video ? scan.video.parts : 0,
        nodes: built ? built.videos : 0, localPathSkipped: built ? built.localPathSkipped : 0 },
      fileCount: { count: scan.totals.files, limit: maxFiles, over: overFiles },
      origin: manifest,
      entries: built ? built.entries.map((e) => ({
        rel: e.rel, id: e.id, topic: e.topic, sha256: e.sha256, format: e.format
      })) : [],
      duplicate: dup ? { project: dup.project, id: dup.node.id, topic: dup.node.topic } : null,
      collisions: collisions.slice(0, 50),
      converted: !!built,
      wouldRefuse: refused || !!limitMsg,
      refuseReason: limitMsg ? 'over-max-files'
        : (dup ? 'duplicate-dir' : (collisions.length ? 'duplicate-file' : null)),
      forced: forced,
      // 【W12】vault 那一路的读数（没开 ⇒ `null`：**默认档报告与从前逐字节相同** ✓）
      vault: vaultReport
        ? {
          enabled: true, auto: autoVault,
          files: vaultReport.files, linkTotal: vaultReport.linkTotal, linked: vaultReport.linked,
          headingLinks: vaultReport.headingLinks, aliasLinks: vaultReport.aliasLinks,
          embedLinks: vaultReport.embedLinks, danglingTotal: vaultReport.danglingTotal,
          resourceTotal: vaultReport.resourceTotal,
          frontmatterFiles: vaultReport.frontmatterFiles, taggedFiles: vaultReport.taggedFiles,
          tags: vaultReport.tags, aliases: vaultReport.aliases,
          skippedDirs: vaultReport.skippedDirs,
          links: vaultReport.links.slice(0, 200),
          // "没接上"那一档：**只读那一个数组**（`dangling`）—— 它同时是 `danglingTotal` 的来源，
          // 两处同源 ⇒ 报告里"说几条"与"列出几条"永远一致（曾经写成两个字段 ⇒ 一个报数、一个列条目）
          dangling: vaultReport.dangling.slice(0, 200),
          ambiguous: vaultReport.ambiguous.slice(0, 200),
          embedNotes: vaultReport.embedNotes.slice(0, 200),
          resourceUnresolved: vaultReport.resourceUnresolved.slice(0, 200),
          notes: vaultReport.notes
        }
        : null
    };

    if (ctx.dryRun) {
      /* 【批6】资源引用也一并**预览**：`dryRun` ⇒ 只规划（不复制文件、不建目录、不改树），
       * 走的是与真导**同一个函数、同一份判据** ⇒ 不会出现"预览说会落、真导没落"的落差 ✓
       * ⚠️【W12】vault 那一路的引用**已经在 `applyVault` 里规划过了**（它必须早于"把新节点当目标"的解析，
       *   见那里第①遍的说明）⇒ 这里直接取那份读数，**不再算第二遍**（算两遍必然漂移 ✗）。 */
      const dirRefs = vaultRes ? vaultDirRefs()
        : resolveDirImportRefs(ctx, name, built, true);
      report.resourceRefs = dirRefReportJson(dirRefs);
      if (ctx.args.json) { ctx.outJson(report); return; }
      ctx.out('（--dry-run：只预览，**没有写盘** ✓ —— 预览会**真的读一遍**这些文件来算来源指纹，'
        + '与真导用同一份判据，不各算一套）');
      ctx.out('整库导入：' + dirRef + '  →  新项目「' + name + '」（标题：' + title + '）');
      ctx.out('范围：' + scan.ext.join(' / ') + '（`--ext` 可覆盖）│ 文件数上限 ' + maxFiles
        + '（`--max-files` 可覆盖）│ **目录总量没有上限**（超过单批 ' + docImport.MAX_IMPORT_BATCH_MB
        + ' MB 只按顶层子树分批：本次 ' + batchCount + ' 批）');
      ctx.out('将建：' + containers + ' 个容器节点（目录）'
        + (built ? ' / ' + filesImported + ' 个文件子树 / 合计 ' + nodes + ' 个节点'
          : ' / ' + scan.totals.files + ' 个文件候选（**文件数超限 ⇒ 没有转换**）'));
      ctx.out('体量：' + report.size.mb + ' MB（' + scan.totals.bytes + ' 字节）'
        + (report.size.over ? ' —— 超过单批线 ⇒ **自动分批，不拒绝**' : ' —— 一批就装得下 ✓'));
      ctx.out('格式分布：' + Object.keys(byFormat).filter((k) => byFormat[k]).map((k) => k + ' ' + byFormat[k]).join(' / ')
        + (Object.keys(byFormat).some((k) => byFormat[k]) ? '' : '（还没转换）'));
      printLimit(ctx.out);
      printVault(ctx.out);
      printSkips(ctx.out);
      printVideo(ctx.out);
      if (built) printDirRefReport(ctx.out, dirRefs, true);
      else ctx.out('资源引用：（文件数超限 ⇒ 没有转换，本次不解析引用）');
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
    /* 【20261052】拒绝时**逐条说清没做的事**（`limitMsg` 自己已经说了原因与三条出路）：
     * vault 那一路的解析/标签/附件落点都在**建树之后** ⇒ 建树没发生，它们一步没执行。 */
    if (limitMsg) { ctx.error(limitMsg + (vaultRefusalNote ? ' ' + vaultRefusalNote : '')); return; }
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
     * 坏引用（`onMissing:'detail'`）不阻断：摘出 `images/files` + 按正文并入详情 + 逐条点名（见 `printDirRefReport`）。
     * ⚠️【W12】vault 那一路的引用**已经在 `applyVault` 里真的落过地**（复制 + 改写成项目内相对路径，
     *   同一个 `resolveImportRefs`）⇒ 这里取那份读数，**不重复复制一遍**（复制两遍会多出一份乱名文件 ✗）。 */
    const dirRefs = vaultRes ? vaultDirRefs()
      : resolveDirImportRefs(ctx, name, built, false);
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
    printVault(ctx.out);
    printSkips(ctx.out);
    printVideo(ctx.out);
    // 【20261043】分批读数：一批一行（上面已打进度），收口时报总数（**目录总量没有上限**）
    // 【20261052】读 `builtBatches` 而不是 `built.batches`：后者只有分批那条链才有（vault 那一路没有）。
    if (built && builtBatches.length > 1) {
      ctx.out('分批：' + builtBatches.length + ' 批已全部转换（目录总量**没有上限**；写盘仍是**一次原子写** ⇒ '
        + '不会留下半个项目）');
    }
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
    // 【W14】前导正文的落点（判据见 `landPreambleIntoParent` 上方的"落点规则"整段）：
    // 条目化父节点 ⇒ 落成**首条条目**；非条目化父节点 ⇒ **逐字节沿用既有行为**（前置进 detail）。
    // 同一批 mutate 内完成 ⇒ 与节点树的那批改动同版本、同一条日志 ✓
    // `preambleLanded` 只是给回显用（并发重放时赋值幂等；报告不在 fn 里打印 ⇒ 不会重复）
    let preambleLanded = null;
    ctx.mutate((cur) => {
      const parentNode = ctx.tree.find(cur.data, parent);
      // 读之后父节点被别人删了（罕见）⇒ 报错而不是凭空造一个父节点出来
      if (!parentNode) throw new Error('父节点在并发改动后已不存在: ' + parent);
      if (r.preamble) {
        if (parentNode.items === undefined) {
          parentNode.detail = parentNode.detail ? r.preamble + '\n' + parentNode.detail : r.preamble;
          preambleLanded = 'detail';
        } else {
          landPreambleIntoParent(ctx, cur.data, parentNode, r.preamble, parent);
          preambleLanded = 'items';
        }
      }
      parentNode.children = (parentNode.children || []).concat(added);
      return cur;
    });
    /* 【20261022】`--json`：**机器可判的一份**（与上面的文本回档**同一份读数**，不另算一遍）。
     * 三条硬口径（照本工程既有先例：`tags --json` / `health --json` / `docs-gen --json`）：
     *   · **确定性**：键序固定、**无时间戳**（`origin.at` 不进）、**无耗时**、**无绝对路径**
     *     （`source` 只给 `name` + `sha256`，不给 `origin.src` —— 跨盘时它是绝对路径）；
     *   · **不出现会逐跑变的东西**：节点 id（`idGen` 含时间+随机）、资源新文件名（命名含时间戳）、
     *     试过的候选路径（绝对路径）⇒ 资源报告走 `refReportStable`（只给计数 + 逐条 ref 状态）；
     *   · `--dry-run` 时由中央短路（`cli/core.js` 的 `outJson`）追加 `dryRun:true` + `plan`，**本命令不重复报**。
     * 两跑逐字节相同是判据（`.review/20261022-import-fixes/` 的 probe-accept.js 在 %TEMP% 副本上量）。 */
    if (ctx.args.json) {
      ctx.outJson({
        ok: true,
        command: 'import-md',
        project: ctx.projectName,
        parent: parent,
        nodes: r.addedCount,
        themes: added.length,
        preamble: { landed: preambleLanded, chars: r.preamble ? r.preamble.length : 0 },
        // 来源指纹：`name` 是文件名（不含目录 ⇒ 不含绝对路径），`sha256` 是**规范化后的提纲**内容指纹
        source: { name: path.basename(String(file)), sha256: origin.sha256, tool: origin.tool },
        resourceRefs: refReportStable(refs)
      });
      return;
    }
    ctx.out('导入完成，新增 ' + r.addedCount + ' 个节点（父节点 ' + parent + '）'
      + (ctx.args.force && dup ? '（--force：这是同一个来源的第 2 份）' : ''));
    // 落点如实报告（前导正文去哪了）—— 静默落盘与静默丢弃一样不可查。
    // ⚠️ 非条目化那条**一个字都不许改**（跨版本逐字节不变是承重性质）。
    if (r.preamble) {
      if (preambleLanded === 'items') {
        ctx.out('前导正文（第一个标题之前的正文，' + r.preamble.length + ' 字符 HTML）已作为**首条条目**'
          + '并入父节点 ' + parent + ' 的 items（`detail` 已按 renderDetail(items) 重建）');
      } else {
        ctx.out('前导正文（第一个标题之前的正文，' + r.preamble.length + ' 字符 HTML）已并入父节点 '
          + parent + ' 的**详情开头**');
      }
    }
    ctx.out('来源指纹: ' + docImport.describeOrigin(origin));
    // 【W19】资源回显（如实报告）：复制了什么、哪条已在项目内、哪条远程引用被按正文保留
    // 【W8】`dry` 档由 `ctx.dryRun` 决定（同一份报告函数：措辞从"已复制"变成"将复制" + 末尾预览说明）
    printRefReport(ctx.out, refs, ctx.dryRun);
  },

  /**
   * 【R4】**绑定工作区文件夹** —— `bind-sync <项目>` 一条命令管四件事：
   *   · 无 `--bind`（默认）⇒ **同步一次**：把绑定目录里**变过**的文件增量同步进树；
   *   · `--bind --dir <目录>` ⇒ 新建一条绑定（写进项目 JSON 的 `bindings[]`）；
   *   · `--pause` / `--resume` ⇒ 暂停 / 继续（**暂停只影响"要不要同步"，已导入的节点一个都不动**）；
   *   · `--unbind` ⇒ 解绑（同上：节点保留；只删掉那份旁路快照）；
   *   · `--list` ⇒ 只看状态（守护中/已暂停、上次同步时间、待确认 N 条、未转换 N 条）。
   *
   * ## 复用哪条既有管线（**一处实现**，本函数不写第二套导入）
   *   文件 → 提纲 → 子树：`src/doc-import.js` 的 `buildDirImportTree`（它内部再走 `docToOutline`
   *   + `markdown.markdownToTree` —— 与 `import-md` / `import-dir` **同一条链**，见那里 ⓪‴ 的取舍说明）。
   *   资源引用（图片/附件）：`resolveDirImportRefs` → `markdown.resolveImportRefs`
   *   （与三条导入命令**同一个函数、同一份 `onMissing:'detail'` 口径**）。
   *   写盘：`ctx.mutate(fn)` ⇒ 版本闸门 + 并发重放 + 写盘前校验 + `--dry-run` 中央短路，**全都不另写一份**。
   *
   * ## 三条不许动摇的纪律（都对着一次真实教训）
   *   ① **界面脏就不写**：`ui-state` 说界面有未保存编辑 ⇒ 本轮**一个字节都不写**，如实报 `blocked-dirty`
   *      （不是静默跳过：回显里点名原因 + 下一轮会自己再来）。否则"界面正脏时同步一次"会让用户
   *      保存时撞上 MERGE_CONFLICT，而他并不知道是守护进程刚刚动过盘 ✗。
   *   ② **删除只提议**：盘上的文件没了 ⇒ 树里节点**一个都不动**，只往旁路快照的 `pendingDeletions`
   *      记一条（`applyBindingPlan` 里根本没有删节点的分支）。改名 = 新增 + 提议删旧 ✓。
   *   ③ **转不了的点名**：读不了/空文件逐条进"未转换"清单（文件相对路径 + 原因 + 原文），
   *      既不静默跳过，也不让它拖垮同一批里别的文件（部分成功 ✓）。
   *
   * ## 旁路快照（**不进项目数据**）
   *   `<项目目录>/.bindings.json`（点文件，与 `.ui-state.json` 同族；可随时删）。
   *   为什么必须旁路：它**每扫一次就会变**（mtime/大小/指纹）⇒ 放进项目 JSON 等于守护进程
   *   每隔几秒就把用户数据搅脏一次 ✗。它丢了也能补（`bindingSnapshotOf` 从 tree 里的 `origin` 现算）。
   */
  bindSync(ctx) {
    const name = ctx.projectName;
    if (!name) ctx.error('缺少项目名');
    const args = ctx.args;
    const json = !!args.json;
    const now = new Date().toISOString();

    /* ---- 0) `--watch-dirs`：**只读**：报出"该盯哪些目录"（主进程的守护用它，不自己解析项目 JSON）----
     * 为什么不让主进程直接读 `projects/<名>/<名>.json` 里的 `bindings`：那等于在主进程里再实现一份
     * "绑定是什么"（取值表、暂停语义、状态解释），而它们**只有一处**（`src/schema.js` + 本命令）。
     * 这里给一行一个目录（tab 分隔：id / dir / debounceMs），主进程照着 `fs.watch` 即可。 */
    if (args.watchDirs) {
      const r0 = ctx.read();
      const list = Array.isArray(r0.data.bindings) ? r0.data.bindings : [];
      const rows = list.map((b) => ({
        id: b && b.id, dir: b && b.dir,
        active: schema.isBindingActive(b),
        debounceMs: (b && typeof b.debounceMs === 'number') ? b.debounceMs : schema.BINDING_DEBOUNCE_DEFAULT,
        mode: (b && b.mode) || schema.BINDING_MODE_DEFAULT
      }));
      const active = rows.filter((r) => r.active && r.dir);
      if (json) {
        ctx.outJson({ project: ctx.projectName, ok: true, active: active.length, total: rows.length, bindings: rows });
        ctx.setIdemResult(JSON.stringify(rows));
        return;
      }
      active.forEach((r) => ctx.out([r.id, r.dir, String(r.debounceMs), r.mode].join('\t')));
      ctx.setIdemResult(active.map((r) => r.dir).join('\n'));
      return;
    }

    // ---- 取值表与身份判据**只从 src/ 取**（唯一一处：取值 + 校验同住 src/schema.js）----
    const bSpec = schema;
    const stateFile = (project) => path.join(ctx.PROJECTS_DIR, project, docImport.BINDING_STATE_FILE);
    const readSnapshot = (project, bindingId, dir) => {
      let raw = null;
      let unreadable = null;
      const file = stateFile(project);
      /* ⚠️ 「文件不在」与「文件在、但读不出来」是**两件事**，本批把它们分开（原来都退化成"还没有快照"✗）：
       * 前者是正常状态（第一次同步），后者意味着**提议读不到** —— 确认流必须在后者上 fail closed，
       * 而不是把一份坏快照解释成"没有任何提议"然后照常往下走。 */
      if (fs.existsSync(file)) {
        try { raw = docImport.parseBindingSnapshot(fs.readFileSync(file, 'utf8')); }
        catch (e) { unreadable = '旁路快照读不出来：' + String((e && e.message) || e); }
        if (!unreadable && raw === null) {
          unreadable = '旁路快照里没有可读的内容（空文件，或不是 JSON 对象）';
        }
      }
      const st = docImport.normalizeBindingSnapshot(raw, bindingId, dir);
      // 形状不对（版本不认识 / 不是对象）同样是"读不到这份提议" ⇒ 如实说，不假装"第一次同步"
      if (!unreadable && raw !== null && st.rebuilt === false) unreadable = st.why;
      return { snap: st.snap, rebuilt: st.rebuilt, why: st.why, unreadable: unreadable };
    };
    const writeSnapshot = (project, snap) => {
      // 原子写（与项目数据同一个出口的纪律：中断只留临时文件，不留半截）
      ctx.store.writeFileAtomic(stateFile(project), docImport.serializeBindingSnapshot(snap));
    };

    // ---- 1) 绑定是**项目数据**里的事实：先读一次 ----
    const snapshotRead = ctx.read();                  // 记版本供写盘闸门用（ctx.read 的副作用就是它）
    const before = snapshotRead.data;
    const all = Array.isArray(before.bindings) ? before.bindings : [];
    const migrations = [];
    if (before.bindings === undefined) {
      // 老项目没有这个键：`migrateBindings` 只补空数组（**既有数据一个字节都不动**）
      const m = bSpec.migrateBindings(before);
      migrations.push(m.note);
    }

    /* ---- 2) 控制动作：绑定 / 解绑 / 暂停 / 继续（都只改项目 JSON 里的那一条）---- */
    const control = { kind: null, note: '' };
    const wantDir = (args.dir === undefined || args.dir === true) ? null : String(args.dir);
    const pickBinding = (list) => {
      const want = (args.binding === undefined || args.binding === true) ? null : String(args.binding);
      if (want) return list.filter((b) => b && b.id === want)[0] || null;
      return list.length === 1 ? list[0] : (list[0] || null);   // 多条时必须点名（下面会拦）
    };
    if (args.bind) {
      if (!wantDir) ctx.error('--bind 需要一个目录：bind-sync <项目> --bind --dir "<本机目录绝对路径>" '
        + '[--mode flat|mirror] [--include "*.md"] [--ignore "node_modules,.git,.review"] [--debounce 800]');
      if (/[\r\n]/.test(wantDir)) ctx.error('--dir 不能含换行');
      const mode = (args.mode === undefined || args.mode === true) ? bSpec.BINDING_MODE_DEFAULT : String(args.mode);
      if (bSpec.BINDING_MODES.indexOf(mode) < 0) {
        ctx.error('--mode 只认 ' + bSpec.BINDING_MODES.join(' / ') + '（收到 ' + JSON.stringify(mode) + '）：'
          + 'flat = 所有文件挂在根下；mirror = 目录结构与文件夹同构（同 import-dir）');
      }
      const inc = (args.include === undefined || args.include === true) ? null : String(args.include);
      const ign = (args.ignore === undefined || args.ignore === true) ? null : String(args.ignore);
      const debounce = ctx.intOption('debounce', {
        min: bSpec.BINDING_DEBOUNCE_MIN, max: bSpec.BINDING_DEBOUNCE_MAX, def: bSpec.BINDING_DEBOUNCE_DEFAULT
      });
      const extRes = (args.ext === undefined || args.ext === true)
        ? { ok: true, ext: docImport.BINDING_EXT_DEFAULT.slice() }
        : docImport.normalizeExtList(args.ext);
      if (!extRes.ok) ctx.error('--ext ' + extRes.reason);
      // 目录**必须真的在**（写进项目数据之前先探一次；之后每轮失败都由扫描/巡检如实报）
      const probe = docImport.describeImportDirProblem(wantDir);
      if (probe) ctx.error(probe.message);
      const id = (args.id === undefined || args.id === true) ? ('wb-' + ctx.store.projectDir(name).length + '-' + all.length) : String(args.id);
      if (!bSpec.ID_RE.test(id)) {
        ctx.error('绑定 id 不合规范（小写字母/数字/连字符）: ' + JSON.stringify(id) + '（可用 --id 指定）');
      }
      if (all.some((b) => b && b.id === id)) ctx.error('这个项目里已经有绑定 id ' + id + '（换个 --id，或先 --unbind）');
      const rec = {
        id: id,
        dir: path.resolve(wantDir),
        mode: mode,
        include: inc ? inc.split(',').map((s) => s.trim()).filter(Boolean) : null,
        ignore: ign ? ign.split(',').map((s) => s.trim()).filter(Boolean) : bSpec.BINDING_IGNORE_DEFAULT.slice(),
        deletions: bSpec.BINDING_DELETIONS,
        debounceMs: debounce,
        status: bSpec.BINDING_STATUS_DEFAULT
      };
      if (!rec.include) delete rec.include;           // 缺省 = 全收（写进数据的键越少越好）
      control.kind = 'bind';
      control.record = rec;
      control.note = '新建绑定 ' + id + ' → ' + rec.dir + '（形态 ' + rec.mode + '）';
    } else if (args.unbind || args.pause || args.resume) {
      const target = pickBinding(all);
      if (!target) {
        ctx.error('这个项目没有绑定' + (args.binding ? ' ' + String(args.binding) : '')
          + '（先 `bind-sync <项目> --bind --dir <目录>` 建一条；`--list` 看现状）');
      }
      if (!args.binding && all.length > 1) {
        ctx.error('这个项目有 ' + all.length + ' 条绑定 —— 这个动作要指名一条：--binding <id>'
          + '（现有：' + all.map((b) => b.id).join(' / ') + '）');
      }
      control.kind = args.unbind ? 'unbind' : (args.pause ? 'pause' : 'resume');
      control.id = target.id;
    }

    /* ---- 3) 同步一次（`--list` / `--bind` / `--unbind` / `--pause` 之外的那条主路）----
     * ⚠️ `--bind` **不在这一轮同步**：那一条绑定刚写进数据，而这里的 `before` 是**写之前**读到的那份
     *（`applyBindingPlan` 会以"项目缺少 bindings 数组"中止）。绑定与同步分成两次调用是**有意的**：
     * 选目录那一步（界面第④步）只想"绑上"，同步由第一次事件或 `--resume` 立刻带起来。
     * `--pause` 同理不同步（人刚说不许动它）。 */
    const doSync = !args.list && !args.bind && !args.unbind && !args.pause;
    const results = [];
    let pendingSnapshotWrites = [];                   // 真跑之后才落盘的旁路快照（dry-run 一个字节都不写）

    /* ---- 3.5) 【R4 排期第⑥步】确认删除提议：**把读得到的提议喂给引擎那一条既有出口** ✓ ----
     * 这一节里**一行删除逻辑都没有**，它只做三件事：读提议 ⇒ 把节点 id 交给 `plan.confirmedNodeIds`
     * ⇒ 把"删掉了哪几个"如实报出来。摘节点在 `src/doc-import.js` 的 `applyBindingPlan` 第 0 段
     * （**唯一出口**：id 必须出现在提议的并集里，手写一个 id 进来删不掉东西）。
     * 为什么是"一次确认全部"而不是逐条：引擎的出口吃的是**这一轮的一张集合**，而"逐条确认"要求
     * 快照里能存一份"半清空的提议"——那就是**第二份删除状态**（第二条删除路 ✗）。逐条的要求用
     * "确认前**逐条点名**"来满足（名字 + 来源文件 + 来源节点 id，界面与回显各一份、同一份数据）。
     * 三条 fail-closed（读不到就**不猜**，此刻盘上一个节点都不动）：
     *   ① 目录读不到（盘没挂/目录被删）⇒ **不确认**（读不到今天的盘面，没法判断那些文件是不是真的没了）；
     *   ② 快照读不出来（文件在、内容坏了/版本不认识）⇒ **不确认**（提议就存在那里，读不到 ≠ 没有）；
     *   ③ 提议里 `nodeId` 为空的 ⇒ **不确认那一条**，单独点名（它本来就没有节点可摘）。 */
    const wantConfirm = !!args.confirmDeletions;
    if (wantConfirm && (args.bind || args.unbind || args.pause || args.resume || args.list || args.watchDirs)) {
      ctx.error('--confirm-deletions 要单独跑一轮：它不能与 --bind / --unbind / --pause / --resume / --list '
        + '/ --watch-dirs 同时用（一边改绑定状态一边删节点，事后没人说得清数据是被哪一半动的）');
    }

    if (doSync && all.length === 0 && control.kind !== 'bind') {
      const empty = {
        ok: true, project: name, status: 'no-binding', bindings: 0, sync: [],
        note: '这个项目还没有绑定工作区文件夹 —— `bind-sync <项目> --bind --dir "<目录>"` 建一条'
      };
      if (json) { ctx.outJson(empty); ctx.setIdemResult(JSON.stringify(empty)); return; }
      ctx.out('这个项目还没有绑定工作区文件夹。');
      ctx.out('绑定一条：node cli/mm-cli.js bind-sync ' + name + ' --bind --dir "<本机目录>"');
      ctx.setIdemResult('no-binding');
      return;
    }

    /* 界面脏就不写（纪律①）：**读**的信号是主进程写的 `.ui-state.json`，
     * 判据只有一处（`src/ui-state.js` 的 `interpret`：界面进程不在了 ⇒ 旧的 dirty 只是残影）。 */
    let uiDirty = false;
    let uiNote = '';
    try {
      const st = uiState.readProjectState(fs, path, ctx.PROJECTS_DIR, name);
      uiDirty = !!st.dirty;
      uiNote = st.note || '';
    } catch (e) { uiDirty = false; }

    /* 确认删除要**指名一条**（与 --pause/--unbind 同一条纪律）：删节点是人的决定，
     * 不该因为"这个项目恰好有两条绑定"就一次动两棵树。（界面在 >1 条时也把这一处置灰 ✓） */
    let targets = control.kind === 'bind' ? [] : (control.kind === 'unbind' ? [] : all);
    if (wantConfirm) {
      const want = (args.binding === undefined || args.binding === true) ? null : String(args.binding);
      if (want) targets = all.filter((b) => b && b.id === want);
      else if (all.length > 1) {
        ctx.error('这个项目有 ' + all.length + ' 条绑定 —— 确认删除要指名一条：--binding <id>'
          + '（现有：' + all.map((b) => (b && b.id) || '?').join(' / ') + '）；'
          + '没指名就一条都不确认（一个节点都不删）');
      }
    }
    const errors = [];
    targets.forEach((binding) => {
      if (!binding || !binding.dir) return;
      const startedAt = now;
      const st = readSnapshot(name, binding.id, binding.dir);
      const snap = st.snap;
      const dirOk = fs.existsSync(binding.dir);
      let scan = null, list = null, plan = null;
      if (dirOk) {
        try {
          scan = docImport.scanImportDir(binding.dir, { ext: binding.ext && binding.ext.length ? binding.ext : docImport.BINDING_EXT_DEFAULT });
          list = docImport.listBindingFiles(binding.dir, binding);
          plan = docImport.planBindingSync({
            projectData: before, binding: binding, snapshot: snap, scan: scan, list: list,
            parent: 'root', at: startedAt, genId: docImport.uniqueIdGen()
          });
        } catch (e) {
          errors.push({ binding: binding.id, error: String((e && e.message) || e) });
          return;
        }
      }
      /* 提议的**并集**（引擎算的**那一份** `plan.pendingAll`）：确认流与回显都只读它 ⇒
       * "待确认删 K"的 K 与"逐条点名"的清单永远出自同一份数据，谁也不再自己拼。
       * 目录读不到时没有计划 ⇒ 回落到快照里那份（那正是"提议存哪儿"的地方，如实读它、也如实说它读不到）。 */
      const union = Array.isArray(plan && plan.pendingAll) ? plan.pendingAll
        : (snap.pendingDeletions || []).map((x) => ({
          rel: docImport.toRelSlash(x.rel), nodeId: x.nodeId || null, topic: x.topic || null,
          at: x.at || null, revived: false
        }));
      const pendingListOf = (u) => u.map((x) => ({
        rel: x.rel, nodeId: x.nodeId || null, topic: x.topic || null, revived: !!x.revived
      }));
      const unconverted = plan ? plan.unconverted : (snap.unconverted || []);
      const row = {
        binding: binding.id, dir: binding.dir, mode: binding.mode || bSpec.BINDING_MODE_DEFAULT,
        status: 'no-change', dirMissing: !dirOk,
        scanned: plan ? plan.scanned : 0, kept: plan ? plan.kept : 0,
        added: plan ? plan.added.length : 0, modified: plan ? plan.modified.length : 0,
        containers: plan ? plan.containers.length : 0,
        // 这两个数取**提议的并集**（本轮新提议 ∪ 快照里的旧提议），不取盘上那份快照：
        // 快照是**在下面第 5 步才落盘**的，这里去读盘上的它，报出来的是**上一轮**的读数
        //（实测踩到：删了一个文件，`pending` 报 1 而 `bindings[0].pending` 报 0，两处自相矛盾 ✗）；
        // 而只取"本轮新提议"会漏掉**已经记进快照**的那几条（实测踩到，本批修：
        //  删一个文件之后再自动同步一次，界面上的"待确认删 K"会变成 0，而提议还在 ✗✗）。
        pending: union.length, pendingBefore: union.length, unconverted: unconverted.length,
        /* 「认回来」的那些文件（引擎的 `plan.reconnected`，逐条点名）：快照丢了的下一轮、
         * 或者"提议删过的文件又回来"的那一轮，它们**没有**新建同名节点，而是就地更新了原节点。
         * 这条读数是"没有重复建节点"的可机器判定面 —— 只看 added/modified 是看不出来的。 */
        reconnected: plan ? plan.reconnected.length : 0,
        reconnectedList: plan ? plan.reconnected.map((x) => ({
          rel: x.rel, nodeId: x.nodeId, from: x.from, proposalWithdrawn: !!x.proposalWithdrawn
        })) : [],
        // 逐条点名的那份清单（铁律②：未转换的**不许**只有一个数字）—— `--json` 里也有它
        unconvertedList: unconverted.map((u) => ({
          rel: u.rel, reason: u.reason, label: u.label || null, message: u.message || null
        })),
        pendingList: pendingListOf(union),
        unchanged: plan ? plan.unchanged : 0,
        changedKeys: [], snapshotRebuilt: st.rebuilt === false ? st.why : null,
        // 旁路快照在盘上、但读不出来 ⇒ **响亮**（不许静默退回"没有提议"）
        snapshotUnreadable: st.unreadable || null
      };
      if (!dirOk) {
        row.status = 'dir-missing';
        row.note = '绑定的目录现在读不到（删了？盘没挂？）—— **盘上零改动**，既不同步也不把节点当"已删除"';
        if (wantConfirm) {
          row.confirmError = 'dir-missing';
          row.note = '**不能确认删除**：绑定的目录现在读不到 ⇒ 读不到今天的盘面，就没法判断这些文件'
            + '是不是真的没了 ⇒ 这一轮**一个节点都没删**（提议原样保留）。盘没挂/目录恢复之后再来一次。';
          errors.push({ binding: binding.id, error: row.note });
        }
        results.push(row);
        return;
      }
      if (uiDirty) {
        row.status = 'blocked-dirty';
        row.note = '界面有未保存编辑 ⇒ 本轮**一个字节都没写**（否则你保存时会撞冲突）。' + uiNote
          + (wantConfirm ? ' ⚠️ 这一轮**确认没有生效**：提议还在，节点一个都没删。' : '');
        results.push(row);
        return;
      }
      /* ---- 确认：把并集里点名的那几个 id 交给引擎唯一的出口（命令层不删任何东西）---- */
      if (wantConfirm) {
        if (st.unreadable) {
          row.confirmError = 'snapshot-unreadable';
          row.note = '**不能确认删除**：' + st.unreadable + ' ⇒ 提议读不到就不许当成"没有提议"'
            + ' ⇒ 这一轮**一个节点都没删**。两条出路：① 修好/恢复那份旁路快照（`'
            + docImport.BINDING_STATE_FILE + '`）再确认；② 确实不要这些提议了 ⇒ 用 '
            + '`--forget-snapshot` 把快照丢掉重来（⚠️ 那会重读一遍全部文件、按树里的 `origin` 接回各文件的节点'
            + '（接不回的才当新增），**代价是**丢掉这些"待确认"的提议（K 归 0），不自动做 ✗）。';
          errors.push({ binding: binding.id, error: row.note });
          results.push(row);
          return;
        }
        const ids = union.map((p) => p.nodeId).filter(Boolean);
        const noNode = union.filter((p) => !p.nodeId);
        plan.confirmedNodeIds = ids;                                  // ← 唯一出口的唯一入参
        row.confirmed = {
          requested: true, declared: ids.length, dropped: 0,
          noNode: noNode.map((p) => p.rel), list: pendingListOf(union)
        };
        if (!ids.length) {
          row.note = '没有待确认的删除提议' + (noNode.length ? ('（有 ' + noNode.length + ' 条提议读不到对应的节点）') : '')
            + ' ⇒ 这一轮**一个节点都没删**（未确认之前，盘上一个节点都不动）';
        }
      }
      if (!plan || !docImport.bindingPlanChangesTree(plan)) {
        row.status = 'no-change';
        if (!row.note && unconverted.length) row.note = '有 ' + unconverted.length + ' 个文件没转成节点（见下），本次没有别的变化';
        results.push(row);
        return;
      }
      // 资源引用（图片/附件）：**同一份实现**（`resolveDirImportRefs` → `markdown.resolveImportRefs`）
      const refs = resolveDirImportRefs(ctx, name, plan, !!ctx.dryRun);
      const refSummary = dirRefReportJson(refs);
      let applied = null;
      try {
        const r = ctx.mutate((cur) => {
          const a = docImport.applyBindingPlan(cur, plan);
          applied = a;
          return cur;
        }, { replayable: true });
        row.attempts = r.attempts;
        row.merged = r.merged;
      } catch (e) {
        errors.push({ binding: binding.id, error: String((e && e.message) || e),
          replayConflicts: e && e.conflicts ? e.conflicts : null });
        return;
      }
      const keep = Object.keys(snap.files || {}).filter((rel) => !plan.added.some((x) => x.rel === rel)
        && !plan.modified.some((x) => x.rel === rel)
        && !plan.unconverted.some((x) => x.rel === rel)
        && !plan.pending.some((x) => x.rel === rel));
      const next = docImport.snapshotAfterBindingPlan(snap, plan, startedAt, keep);
      pendingSnapshotWrites.push({ binding: binding.id, snap: next });
      /* 这一轮真写过盘 ⇒ "还剩几条待确认"取**这一轮之后**那份快照的读数（界面上的 K 立刻回 0，
       * 与盘上那份快照是同一个数）。没写盘的那几条早退分支不重算：那时"还是原来那些"。 */
      row.pending = (next.pendingDeletions || []).length;
      row.pendingList = pendingListOf((next.pendingDeletions || []).map((x) => ({
        rel: docImport.toRelSlash(x.rel), nodeId: x.nodeId || null, topic: x.topic || null, revived: false
      })));
      const dropped = applied && Array.isArray(applied.dropped) ? applied.dropped : [];
      if (row.confirmed) row.confirmed.dropped = dropped.length;
      row.dropped = dropped.length;
      const touched = !!(applied && (applied.added || applied.modified || applied.created));
      // 只确认、没有别的变化 ⇒ 这一轮不是"同步"（别让"上次同步"和"本次 +N 改 M"被一次确认推进）
      row.status = touched ? 'synced' : (dropped.length ? 'confirmed' : 'no-change');
      row.applied = applied ? { added: applied.added, modified: applied.modified, created: applied.created } : null;
      row.refs = refSummary;
      results.push(row);
    });

    /* ---- 4) 写回：控制动作（绑定/解绑/暂停）走 `ctx.mutate`；同步的写入已在上面各条里完成 ---- */
    const hasControl = control.kind === 'bind' || control.kind === 'unbind' || control.kind === 'pause'
      || control.kind === 'resume';
    if (hasControl) {
      try {
        ctx.mutate((cur) => {
          const list = Array.isArray(cur.bindings) ? cur.bindings.slice() : [];
          if (control.kind === 'bind') list.push(control.record);
          else {
            const i = list.findIndex((b) => b && b.id === control.id);
            if (i < 0) return cur;                       // 并发已解绑 ⇒ 幂等：什么都不做
            if (control.kind === 'unbind') list.splice(i, 1);
            else {
              const nx = Object.assign({}, list[i]);
              if (control.kind === 'pause') nx.status = 'paused';
              else delete nx.status;                     // resume ⇒ 回到缺省（守护中）
              list[i] = nx;
            }
          }
          cur.bindings = list;
          return cur;
        }, { replayable: true });
      } catch (e) {
        ctx.error('绑定状态写入失败：' + ((e && e.message) || e));
      }
    }

    /* ---- 5) 旁路快照：**真跑且写成功后**才落盘（`--dry-run` 一个字节都不写）----
     * ⚠️ 这里**故意**不用 `if (!ctx.dryRun) {` 那种"包住一大段"的写法：W8 有一条静态判据
     *   （`tests/w8-dry-run.test.js` 的 D5）**明令**命令层不许出现 `if (!ctx.dryRun) {` ——
     *   理由是"写盘前分流"会变成第二处 dry-run 判定。中央短路管不到**物理副作用**（这里是写旁路文件），
     *   而本文件别处（`import-md` 的资源复制）用的是 `dryRun` 入参，同一种做法：
     *   把这个布尔**取成一个具名值**再分流，判定点仍然只有 `ctx.dryRun` 那一处 ✓ */
    const dryRun = !!ctx.dryRun;
    if (String(dryRun) !== 'true') {
      if (control.kind === 'unbind' && control.id) {
        try { if (fs.existsSync(stateFile(name))) fs.unlinkSync(stateFile(name)); } catch (e) { /* 旁路产物：删不掉不影响数据 */ }
      }
      if (args.forgetSnapshot) {
        try { if (fs.existsSync(stateFile(name))) fs.unlinkSync(stateFile(name)); } catch (e) { /* 同上 */ }
      }
      pendingSnapshotWrites.forEach((w) => {
        try { writeSnapshot(name, w.snap); }
        catch (e) {
          // 快照写不进去 ⇒ 数据已写入但记账失败：**必须说出来**（否则下一轮会把同一批文件再同步一遍，
          // 于是"多出一批节点"这件事会以"莫名其妙变多了"的形状出现，而没人知道原因）
          ctx.out('⚠ 同步已完成，但**旁路快照写不进去**：' + ((e && e.message) || e)
            + '（下一次同步可能把同一批文件再同步一遍 —— 请检查项目目录是否可写）');
        }
      });
    }

    /* ---- 6) 回显（文本与 --json **同一份数据**）---- */
    const afterStatus = (() => {
      let now2 = before;
      try { now2 = ctx.store.read(name).data; } catch (e) { /* 读不回来就用读之前那份 */ }
      const list = Array.isArray(now2.bindings) ? now2.bindings : [];
      return list.map((b) => {
        const snapR = readSnapshot(name, b.id, b.dir);
        const s = docImport.bindingStatusOf(snapR.snap, b);
        s.status = b.status === undefined ? bSpec.BINDING_STATUS_DEFAULT : b.status;
        s.active = bSpec.isBindingActive(b);
        s.lastSyncAt = b.lastSyncAt || s.lastSyncAt;
        s.note = b.note || null;
        s.mode = b.mode || bSpec.BINDING_MODE_DEFAULT;
        // 同一轮里**有报告可用**就用报告的读数（那是本轮真算出来的）；没有才回落到旁路快照
        const row = results.filter((r) => r.binding === b.id)[0];
        if (row) {
          s.pending = row.pending;
          s.unconverted = row.unconverted;
          s.pendingList = row.pendingList;
        }
        return s;
      });
    })();
    const statuses = results.map((r) => r.status);
    const declaredTotal = results.reduce((n, r) => n + ((r.confirmed && r.confirmed.declared) || 0), 0);
    const droppedTotal = results.reduce((n, r) => n + (r.dropped || 0), 0);
    const overall = errors.length ? 'error'
      : statuses.some((s) => s === 'blocked-dirty') ? 'blocked-dirty'
        : statuses.some((s) => s === 'dir-missing') ? 'dir-missing'
          : (control.kind === 'unbind' ? 'unbound'
            : (control.kind === 'pause' ? 'paused' : (control.kind === 'resume' ? 'resumed'
              : (control.kind === 'bind' ? 'bound'
                : (statuses.some((s) => s === 'synced') ? 'synced'
                  : (statuses.some((s) => s === 'confirmed') ? 'confirmed'
                    : (wantConfirm ? 'no-pending' : 'no-change')))))));
    const report = {
      ok: errors.length === 0,
      project: name,
      status: overall,
      control: control.kind ? { kind: control.kind, id: control.id || (control.record && control.record.id), note: control.note } : null,
      migrations: migrations,
      sync: results,
      // 逐条点名（不合并去重：同一个相对路径在两个绑定下出现，那是**两件事**，合并会少报）
      unconverted: results.reduce((acc, r) => acc.concat(r.unconvertedList || []), []),
      pending: results.reduce((n, r) => n + r.pending, 0),
      /* 确认那一轮的读数（**"删了几个"是这里唯一一处给的**）：`declared` = 人点名确认的条数、
       * `dropped` = 真从树里摘掉的节点数（两者不等时**照实分别报**，不粉饰）。 */
      deletions: wantConfirm ? {
        requested: true, dryRun: !!ctx.dryRun,
        declared: declaredTotal, dropped: droppedTotal,
        remaining: results.reduce((n, r) => n + r.pending, 0),
        rows: results.map((r) => ({ binding: r.binding, declared: (r.confirmed && r.confirmed.declared) || 0,
          dropped: r.dropped || 0, noNode: (r.confirmed && r.confirmed.noNode) || [],
          error: r.confirmError || null })),
        list: results.reduce((acc, r) => acc.concat((r.confirmed && r.confirmed.list) || []), [])
      } : null,
      bindings: afterStatus
    };
    if (json) {
      ctx.outJson(report);
      ctx.setIdemResult(JSON.stringify(report));
      if (errors.length) ctx.error(errors.map((e) => '绑定 ' + e.binding + '：' + e.error).join('\n'));
      return;
    }
    const lines = [];
    if (control.kind) {
      lines.push(control.note || ('绑定动作：' + control.kind + (control.id ? ' ' + control.id : '')));
    }
    migrations.forEach((m) => lines.push('迁移：' + m));
    /* 确认那一轮：**先逐条点名**（名字 + 来源文件 + 来源节点），再说清删了几个、还剩几个。
     * 为什么点名必须在这里也有一份（不止界面）：命令行是这条路唯一的**真值面**（界面与它对拍），
     * 也让人事后能从日志里看出"当时确认的到底是哪几个节点"。 */
    if (wantConfirm && report.deletions) {
      const d = report.deletions;
      const refused = d.rows.filter((r) => r.error);
      if (refused.length) {
        /* ⚠️ 这一档**不许**印成"删掉了 0 个" —— 那读起来像"确认执行了、只是没东西可删"，
         * 而真相是"确认**没有执行**"（读不到提议 ⇒ fail closed）。两句必须不同。 */
        lines.push('【确认删除·未执行】读不到提议 / 目录读不到 ⇒ **一个节点都没删**（fail closed）：');
        refused.forEach((r) => lines.push('  · 绑定 ' + r.binding + '：' + r.error));
      } else if (d.dryRun) {
        lines.push('【确认删除·预览】点了名要删 ' + d.declared + ' 条（`--dry-run` ⇒ 盘上零改动、提议原样保留）');
      } else if (!d.declared) {
        /* 没有可确认的提议 ⇒ 也**不许**印成"删掉了 0 个"（那读起来像"确认执行了"）：
         * 真相是"这一轮没有任何东西可确认"，而盘上一个节点都没动（幂等空转，不是错误）。 */
        lines.push('【确认删除·没有待确认的提议】一个节点都没删（提议清单是空的；'
          + '未确认之前，盘上一个节点都不动）。空转是幂等的：再点一次也是这个结果。');
      } else {
        lines.push('【确认删除】按你的确认删掉了 ' + d.dropped + ' 个节点（只删被确认的那些；盘上文件一个都没动）');
      }
      if (d.list.length && !refused.length) {
        lines.push('  逐条点名（' + d.list.length + ' 条提议，名字 / 来源文件 / 来源节点）：');
        d.list.forEach((x) => {
          lines.push('  · 「' + (x.topic || '(无标题)') + '」 ← ' + x.rel
            + '（节点 ' + (x.nodeId || '**读不到**') + '）'
            + (x.revived ? ' ⚠️ 这个文件**又出现了**：引擎按"新增"处理 ⇒ 树里现在同一个文件有两个节点；'
              + '确认之后旧的那个被摘掉，又回到一个' : ''));
        });
      }
      const noNodeAll = d.rows.reduce((acc, r) => acc.concat(r.noNode || []), []);
      if (noNodeAll.length) {
        lines.push('  ⚠️ 有 ' + noNodeAll.length + ' 条提议**读不到对应的节点**（' + noNodeAll.join('、')
          + '）⇒ 这几条**没有被确认**（没有节点可摘），它们仍然留着等你判断盘上那一份出了什么事');
      }
      if (!refused.length) {
        lines.push('  提议：' + d.declared + ' 条被确认 ⇒ 还剩 ' + d.remaining + ' 条待确认（K=' + report.pending
          + '，清空的那些不会再被提出来）');
      }
    }
    results.forEach((r) => {
      lines.push('绑定 ' + r.binding + '（' + r.dir + '，形态 ' + r.mode + '）：' + r.status);
      if (r.status === 'no-change') {
        lines.push('  没变化（范围内 ' + r.scanned + ' 个文件，其中没变的 ' + r.unchanged + ' 个）'
          + (r.note ? ' —— ' + r.note : ''));
      } else if (r.status === 'synced') {
        lines.push('  本次：新增 ' + r.added + ' 个文件 / 更新 ' + r.modified + ' 个 / 新增目录节点 ' + r.containers
          + ' 个（范围内 ' + r.scanned + ' 个文件，没变的 ' + r.unchanged + ' 个）');
        if (r.refs && r.refs.total) {
          lines.push('  资源引用：共 ' + r.refs.total + ' 条（复制 ' + r.refs.copy + ' / 已在项目内 '
            + r.refs.inProject + ' / 非本地 ' + r.refs.remote + ' / 坏引用 ' + r.refs.missingPlusBadExt + '）');
        }
        if (r.merged) lines.push('  （写入期间检测到并发改动：已按不相交判定自动重放，双方改动都保留）');
      } else {
        lines.push('  ' + (r.note || ''));
      }
      if (r.status !== 'no-change' || !r.note) {
        /* 「认回来」的逐条点名（与 `added/modified` 分开说：它们是**就地更新**，不是新节点）*/
        if (r.reconnected) {
          const withdrawn = (r.reconnectedList || []).filter((x) => x.proposalWithdrawn).length;
          lines.push('  ♻ ' + r.reconnected + ' 个文件**接回了原节点**（就地更新，没有新建同名节点）：'
            + r.reconnectedList.map((x) => x.rel + (x.from === 'pending' ? '（提议点名过）' : '（树里的 origin）')).join('、')
            + (withdrawn ? '；其中 ' + withdrawn + ' 条"待确认删除"提议随之**撤回**'
              + '（文件回来了 ⇒ 那条提议不再成立；未确认之前盘上一个节点都没少）' : ''));
        }
        // 提议的读数（**并集**）：K 与"逐条点名"永远出自同一份数据（见上面 report.deletions 的说明）
        if (r.pending) {
          lines.push('  ⏳ 待确认删除 ' + r.pending + ' 条（盘上的文件没了 ⇒ **树里一个节点都没动**，'
            + '只记了提议，等你确认；改名按"新增 + 提议删旧"处理）：'
            + (r.pendingList || []).map((x) => '「' + (x.topic || '(无标题)') + '」← ' + x.rel).join('、'));
        } else if (!wantConfirm) {
          lines.push('  ⏳ 待确认删除 0 条（**未确认之前，盘上一个节点都不动**）');
        }
      }
      if (r.snapshotUnreadable) {
        lines.push('  ⚠️ **旁路快照读不出来**：' + r.snapshotUnreadable
          + ' ⇒ 这一轮的"待确认"读数不可信（提议读不到 ≠ 没有提议）；删除确认在这个状态下**会拒绝执行**。');
        /* 快照没了 ⇒ "哪个文件对应哪个节点"改由**树里各文件节点的 `origin` 现算**（同一份记账，
         * 只不过那份是数据本身）。这条读数就是"丢了快照也不会重复建节点"的证据面。 */
        lines.push('     · 本轮"文件 → 节点"的对应关系由树里的 `origin` 现算：' + r.reconnected
          + ' 个文件接回了原节点（就地更新），' + r.added + ' 个当新增 —— **没有**因为丢了快照就重复建节点 ✓');
      }
    });
    const unconvertedAll = report.unconverted;
    if (unconvertedAll.length) {
      lines.push('未转换 ' + unconvertedAll.length + ' 个文件（**没有静默跳过**；它们在下次同步里会再试）：');
      unconvertedAll.slice(0, 20).forEach((u) => {
        lines.push('  · ' + u.rel + ' —— ' + (u.label || u.reason || '')
          + (u.message ? '：' + String(u.message).split('\n')[0].slice(0, 160) : ''));
      });
      if (unconvertedAll.length > 20) lines.push('  · …另有 ' + (unconvertedAll.length - 20) + ' 个（`--json` 里有全部）');
    }
    if (pendingSnapshotWrites.length) {
      lines.push('旁路快照已更新：' + pendingSnapshotWrites.map((w) => w.binding).join(' / ')
        + '（`' + docImport.BINDING_STATE_FILE + '`，**不在项目数据里** —— 守护进程不会因此把项目 JSON 搅脏）');
    }
    if (results.length) {
      lines.push('声明：同步链路上**没有任何 LLM / 网络调用**（纯本地文件事件 + 字符串处理 ⇒ 零 token）');
    }
    if (errors.length) {
      lines.push('错误：');
      errors.forEach((e) => lines.push('  · 绑定 ' + e.binding + '：' + e.error));
    }
    const text = lines.join('\n');
    ctx.out(text);
    ctx.setIdemResult(text);
    if (errors.length) ctx.error(errors.map((e) => '绑定 ' + e.binding + '：' + e.error).join('\n'));
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
    /* 口径（唯一定义在 `export-md` 的 registry desc + `src/markdown.js` 文件头那段注释）：
     * `export-md` 是**读向**导出 —— 给编辑器/人/AI 读，**不保证** `import-md` 往返等价。
     * 因此 v3 之后加上的四样**恒导出**、不受 `--with-detail` 控制：
     *   items[]（→ 节点下的 `1.` 子列表，行尾括注 已核/未核 · 出处 · 条目标签）、tags、localPath，
     *   以及条目上的 verified（未核也显示）。`--with-detail` 只决定 `detail` 导不导。
     * 有 `items` 的节点**不导 detail**（它逐字节等于 `renderDetail(items)`，见 docs/ITEM-MODEL.md §2）。 */
    const withDetail = !!ctx.args.withDetail;
    const md = markdown.treeToMarkdown(data.data, {
      format: ctx.args.format === 'list' ? 'list' : 'heading',
      withDetail: withDetail,
      withResources: true
    });
    const mdFile = path.join(outDir, ctx.projectName + '.md');
    fs.writeFileSync(mdFile, md, 'utf8');
    const nodes = tree.count(data.data);
    ctx.out('已导出文件夹: ' + outDir + '（' + ctx.projectName + '.md，' + nodes + ' 节点，含 assets/ 与 attachments/）');
    /* 这一行是"不静默丢"的可见面：读者必须知道**这一档导了什么、没导什么**。
     * 缺省档不导 `detail` 是既有语义（`--with-detail`），但条目化之后它会被误读成
     * "v2 节点没内容"或"导出把正文丢了"，所以在这里说明。 */
    ctx.out('  读向口径：items / tags / verified / localPath 恒导出（`--with-detail` 只管 detail）'
      + (withDetail ? '' : '；本档**未导** detail（节点正文）'));
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
    // `rawText` 留着给 `--json` 的内容指纹用（同一份读入，不读第二遍盘）
    const rawText = fs.readFileSync(file, 'utf8');
    const parsed = bundle.parseBundle(rawText);
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
    /* 【20261022】`--json`：与上一行文本**同一份读数**（同一批 `nodes/imgs/files/assets` 计数，
     * 不另算一遍）。三条硬口径同 `import-md --json`：键序固定、无时间戳、无耗时、无绝对路径
     * （`source` 只给文件名 `name` + 内容指纹 `sha256`，不给入参路径 —— 它可能是绝对路径）。
     * 指纹走 `docImport.outlineSha256`：与 `origin.sha256` **同一处实现**（同一份 CRLF/BOM 规范化），
     * 不在这里另 require 一个 hash 库、也不另写一遍规范化。 */
    if (ctx.args.json) {
      ctx.outJson({
        ok: true,
        command: 'import-json',
        project: name,
        nodes: nodes,
        images: imgs,
        files: files,
        assets: pack.assets ? Object.keys(pack.assets).length : 0,
        assoc: Array.isArray(pack.assoc) ? pack.assoc.length : 0,
        source: { name: path.basename(String(file)), sha256: docImport.outlineSha256(rawText) }
      });
      return;
    }
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

  /**
   * 【20261048】**视频摘要**：三条路（字幕解析 / ffmpeg 解码 / 两者结合）+ 两档（coarse|detailed）
   * + **自动检测**（说清凭什么选它）。
   *
   * ⚠️ **这是本工程唯一一个不写 `projects/` 的命令**：位置参数是**文件系统路径**（目录或一份 `.m3u8`），
   *    不是项目名。所以它没有 `ctx.read()` / `ctx.write()` / `ctx.mutate()` —— 想把它接进项目的人先读这句：
   *    视频摘要的产物**不落盘**（要留就由调用方自己把 `--json` 的结果写进笔记）。
   *
   * 本函数**只做三件事**（判据一律不在这里，否则就会出现第二份会漂的答案）：
   *   ① 探 —— `src/video-summary-probe.js`（副作用面：探字幕 / 探 ffmpeg / 读播放列表，全部可注入）；
   *   ② 出计划 —— `src/video-summary.js` 的 `planStrategy`（**唯一决策处**：选路 + 档位 + 拒绝）；
   *   ③ 按计划取素材并合成 —— `collectSubtitleTexts`（**只有详细档才会调**）+ `buildSummary`（自带结构自查）。
   *
   * 三条不许犯的错（改这个命令之前先读）：
   *   · **`--method` 显式指定却回退到别的路** ⇒ 用户明确选了方法，回退等于骗他（拒绝由 `planStrategy` 出）；
   *   · **`--level detailed` 在"无字幕 + 无 ffmpeg"时拿文件名硬凑** ⇒ `planStrategy` 直接
   *     `{ok:false, code:'no-content-source'}`，连合成都不进；
   *   · **粗档偷读字幕/偷解码** ⇒ 计划里根本没有那两步，而且 `checkSummary` 会判红（结构判据）。
   */
  videoSummary(ctx) {
    const vs = require('../../src/video-summary.js');
    const probe = require('../../src/video-summary-probe.js');
    const target = ctx.projectName;                     // = 第一个位置参数（路径，不是项目名）
    if (!target) {
      ctx.error('缺少目标：给一个目录或一份 `.m3u8` 的路径。'
        + '（本命令**不读 projects/**，位置参数是文件系统路径：`video-summary E:\\课程目录 --json`）');
    }
    const method = ctx.args.method === undefined ? vs.DEFAULT_METHOD : String(ctx.args.method);
    const level = ctx.args.level === undefined ? vs.DEFAULT_LEVEL : String(ctx.args.level);

    // ---- ① 探（只读；分片/密钥一个都不碰）----
    const facts = probe.probeVideo(target);
    if (!facts.ok) ctx.error(facts.message);

    // ---- ② 计划（选路 + 档位；不可用/做不到 ⇒ 响亮拒绝，**绝不回退**）----
    const plan = vs.planStrategy(facts, { method: method, level: level });
    if (!plan.ok) ctx.error(plan.message);

    // ---- ③ 素材：**只有计划里有 read-subtitle 这一步**才去读字幕正文（粗档拿不到内容）----
    const material = { facts: facts };
    const wantsSubtitle = (plan.steps || []).some((s) => s.kind === 'read-subtitle');
    if (wantsSubtitle) {
      const got = probe.collectSubtitleTexts(facts);
      material.subtitleTexts = got.texts;
      if (got.gaps && got.gaps.length) facts.gaps = (facts.gaps || []).concat(got.gaps);
    }
    const built = vs.buildSummary(plan, material);
    if (!built.ok) ctx.error(built.message);

    const sum = built.summary;
    if (ctx.args.json) {
      ctx.outJson({
        ok: true,
        command: 'video-summary',
        /* 对外承诺的机器可读那一半：本命令**不写 `projects/`**（见函数头第一句）。
         * 写成常量而不是"算出来"，因为它是**契约**而不是读数 —— 哪天有人给它加了写盘，
         * 这一行会立刻变成假话，而 `tests/video-summary.test.js` 的 H7 会红（跑前跑后项目列表逐字相同）。 */
        noWrite: true,
        target: facts.target,
        kind: facts.kind,
        level: sum.level,
        method: sum.method,
        why: sum.why,
        degraded: sum.degraded === true,
        degradedFrom: sum.degradedFrom || null,
        degradedTo: sum.degradedTo || null,
        degradedWhy: sum.degradedWhy || null,
        caps: plan.caps,
        plan: {
          method: plan.method, level: plan.level, decodes: plan.decodes === true,
          steps: (plan.steps || []).map((s) => ({ kind: s.kind, what: s.what }))
        },
        summary: sum,
        contract: built.contract,
        gaps: facts.gaps || [],
        warnings: built.warnings || []
      });
      return;
    }

    // ---- 文本档（人读的那一份；每一行都是**读数**，不是套话）----
    const caps = plan.caps;
    ctx.out('视频摘要 · ' + (sum.level === 'detailed' ? 'detailed（详细档）' : 'coarse（粗档）'));
    ctx.out('目标：' + facts.target);
    ctx.out('视频：' + sum.playlistCount + ' 份播放列表 · 合计 ' + sum.durationText
      + ' · 分片 ' + sum.segments + ' 个' + (sum.encrypted ? ' · AES 加密（EXT-X-KEY）' : ' · 未加密')
      + '（时长 = `#EXTINF` 之和，**不需要 ffmpeg** 就算得出）');
    ctx.out('字幕：' + caps.subtitleCount + ' 份'
      + (caps.subtitleFiles && caps.subtitleFiles.length ? '（' + caps.subtitleFiles.slice(0, 3).join('、') + '）' : '（.vtt / .srt）'));
    ctx.out('可用：ffmpeg ' + (caps.hasFfmpeg ? caps.ffmpegPath : '未安装（PATH 上找不到）')
      + ' · ASR ' + (caps.hasAsr ? caps.asrName : '没接')
      + ' · 视觉模型 ' + (caps.hasVision ? caps.visionName : '没接'));
    ctx.out('选路：' + method + ' ⇒ ' + plan.method);
    ctx.out('为什么：' + sum.why);
    if (sum.degraded) ctx.out('降级：' + sum.degradedFrom + ' ⇒ ' + sum.degradedTo + ' —— ' + sum.degradedWhy);
    if (sum.structure && sum.structure.length) {
      ctx.out('层级（课程 / 课时）：');
      sum.structure.forEach((s) => {
        ctx.out('  ' + '  '.repeat(s.depth) + s.name + '（' + s.videos + ' 份 / '
          + vs.formatStamp(s.seconds) + (s.encryptedAny ? ' / 加密' : '') + '）');
      });
    }
    if (sum.level === 'detailed') {
      ctx.out('逐段要点（' + sum.segCount + ' 段 / ' + sum.cues + ' 句 / ' + sum.chars + ' 字，'
        + '**抽取式**：要点是字幕原句，不是生成摘要）：');
      (sum.highlights || []).forEach((h) => {
        ctx.out('  ' + h.atText + '–' + h.endText + '  ' + h.text);
      });
      ctx.out('关键概念/术语（单条字幕里反复出现的片段；一条只出现一次的不算）：'
        + ((sum.terms || []).length
          ? (sum.terms || []).map((t) => t.term + '(' + t.segments + ' 段)').join(' · ')
          : '（没有重复出现的片段 —— 这次不编术语）'));
      ctx.out('层级（一图读懂用的那一份）：');
      (sum.outline || []).forEach((o) => {
        ctx.out('  ' + '  '.repeat(o.level) + (o.level === 0 ? '● ' : '- ') + o.title
          + (o.atText ? '  [' + o.atText + ']' : ''));
      });
    } else {
      ctx.out('主题：' + sum.topic + '（一句话主题 = 播放列表/目录名，本档**没有读任何内容**）');
      ctx.out('提示：本档只读播放列表文本（**不解码、不抽帧、不起进程、不读字幕正文**）；'
        + '要逐段要点：`--level detailed`（需要字幕或 ffmpeg）');
    }
    if ((facts.gaps || []).length) {
      ctx.out('⚠ 没读成的（逐条点名，不静默）：');
      (facts.gaps || []).slice(0, 10).forEach((g) => {
        ctx.out('  · ' + (g.rel || '?') + ' —— ' + g.reason + (g.message ? '：' + g.message : ''));
      });
    }
    if ((built.warnings || []).length) {
      ctx.out('⚠ 字幕里解析不了的行（不静默丢）：');
      (built.warnings || []).slice(0, 10).forEach((w) => {
        ctx.out('  · ' + (w.src ? w.src + ' ' : '') + '第 ' + (w.line === undefined ? '?' : w.line)
          + ' 行 ' + w.kind + (w.raw ? '：' + w.raw : ''));
      });
    }
    ctx.out('（本命令不写 `projects/`：产物只在这次输出里）');
  },

  validate(ctx) {
    const target = ctx.projectName;
    if (!target) ctx.error('缺少项目名或 JSON 文件路径');
    // 项目名 或 文件路径（含 .tmp 等任意扩展名 —— 历史上主进程保存前的校验临时文件就长这样，
    // 现在那条路改成了进程内校验，但"任意扩展名的文件路径"这个容忍度照旧：别人递一个临时文件进来
    // 也必须能验，别因为扩展名把它当成项目名）。
    const file = fs.existsSync(target)
      ? target
      : path.join(ctx.PROJECTS_DIR, target, target + '.json');
    if (!fs.existsSync(file)) ctx.error('找不到项目: ' + target);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 自项目推断：**项目根内**的文件按"父目录名就是项目名"推断（例如有人手工递一份
    // `projects/<项目>/<项目>.json.<pid>.<ts>.validate` 这种同目录临时文件）。据此让"同项目成员"
    // 以这份待写数据为准 —— 否则删掉被引用的节点后，第一次校验会因为闸门看的是
    // 磁盘旧态而放行，第二次才突然被拒（实测），用户完全看不懂。
    // 不在项目根内的文件（如 import 的临时包）推断不出项目名，退回纯读盘校验。
    // ⚠️ 所以想"把临时探针挪出 `projects/<项目>/`"的人注意：`os.tmpdir()` 里没有这个父目录名 ⇒
    // `selfProject` 变 null ⇒ 上面那条语义**静默失效**（实测：删掉仍被 assoc 引用的节点后保存被放行）。
    // GUI 的保存闸门因此改成**进程内**校验并**显式传项目名**（`src/data-store.js` 的
    // `createProjectValidator`），别再退回"临时文件 + 本命令"那条路。
    const absFile = path.resolve(file);
    const absRoot = path.resolve(ctx.PROJECTS_DIR);
    const selfProject = absFile.indexOf(absRoot + path.sep) === 0
      ? path.basename(path.dirname(absFile)) : null;
    /* `--anchors`：**显式**把"笔记锚点失效"这一档也算进校验（R7）。
     * 默认**不判**——因为 `validate` 同时是**写盘闸门**，而锚点失效（`bad-anchor`/`no-tag`）
     * 是**弱判据**：改写正文里那句话、去掉一个标签都是正常事，若默认判红，整个项目会瞬间
     * 变成**只读**（实测形态：`edit <项目> <节点> --detail …` 直接 `校验失败: … 失效锚点(bad-anchor)`）。
     * ⇒ 口径：默认档只判"硬悬挂"；`validate --anchors` 显式判锚点（点名 + 给修法）；
     *   `assoc-prune [--dry-run]` **总是报告**；界面侧画坏引用态。三段都不静默。 */
    const v = ctx.schema.validateProject(data, ctx.PROJECTS_DIR, selfProject,
      { checkAnchors: ctx.args.anchors === true });
    /* `warnings[]`（本批新增）：**不判红但必须可见**的那一档（未知顶层键 / 节点上的未知字段）。
     * 为什么两条腿都要：`validate` 同时是给**人**和给 **AI** 用的 ——
     *   人看文本模式的 `⚠ 警告:` 行；AI 读 `--json` 的 `warnings[]`。
     * 只打 stderr / 只打文本，都等于"AI 那条腿看不见"（那会重演"校验通过 = 字段被支持"的误判）。
     * ⚠️ 输出形状只**增**一个键（`ok` / `errors` 语义一字未改）⇒ 既有消费者的判据不受影响；
     *   两跑的字节稳定性也要保住：空数组照样输出（不是"有时有、有时没"）。 */
    const warnings = Array.isArray(v.warnings) ? v.warnings : [];
    if (ctx.args.json) ctx.outJson({ ok: v.ok, errors: v.errors, warnings: warnings });
    else if (v.ok) {
      ctx.out('校验通过: ' + target);
      warnings.forEach((w) => ctx.out('⚠ 警告: ' + w));
    } else ctx.out('error: 校验失败: ' + v.errors.join('; '));
    // --json 分支此前**不设退出码** —— 于是 validate --json 遇到坏数据也返回 0，
    // 与文本分支行为不一致。退出码必须由"校验结果"决定，与输出格式无关。
    if (!v.ok) process.exitCode = 1;
  },

  validateAll(ctx) {
    const list = ctx.store.list();
    let bad = 0;
    let warned = 0;
    list.forEach((p) => {
      const data = JSON.parse(fs.readFileSync(p.file, 'utf8'));
      const v = ctx.schema.validateProject(data, ctx.PROJECTS_DIR, p.name);
      if (!v.ok) { bad++; ctx.out('FAIL ' + p.name + ': ' + v.errors.join('; ')); }
      else {
        ctx.out('OK   ' + p.name);
        // 与 `validate` 同一条口径：警告不判红，但**逐条点名**（真实数据里通常没有 ⇒ 输出逐字节不变）
        const ws = Array.isArray(v.warnings) ? v.warnings : [];
        if (ws.length) { warned++; ws.forEach((w) => ctx.out('WARN ' + p.name + ': ' + w)); }
      }
    });
    ctx.out(bad ? bad + ' 个项目校验失败' : '全部 ' + list.length + ' 个项目校验通过'
      + (warned ? '（' + warned + ' 个项目有警告，见上面的 WARN 行）' : ''));
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
