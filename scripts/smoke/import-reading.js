/* ============================================================
 * scripts/smoke/import-reading.js —— 【W13】界面侧导入入口的两份**读数**（纯函数、零 I/O ⇒ 可单测）
 * ------------------------------------------------------------
 * ⚠️ **为什么它住在 `scripts/smoke/` 而不是 `scripts/` 顶层**（这是 G8 文档登记门禁逼出来的一处落点）：
 *   `scripts/docs-registry-check.js` 的范围是"**只查 `src/*.js`、`cli/commands/*.js`、`scripts/*.js`（顶层）**"，
 *   并**显式豁免** `tests/`、`scripts/smoke/`、`scripts/vision/`（理由写在那门禁里：这些目录有**目录级说明**，
 *   文件又都是**自描述命名**）。本批**不许**动 `docs/ARCHITECTURE.md`（另一会话占着），而新建一个顶层
 *   `scripts/*.js` 会因"未入档代码"判红 ✗ ⇒ 落在这里。这里也有**现成的先例**：`scripts/smoke/tear-snapshot.js`
 *   就是"主进程 require 的辅助模块"（不是冒烟域——域的文件名必须 `NN-*.js`，本文件没有数字前缀，
 *   自动发现不会把它当域 ✓）。
 *
 * 为什么这个模块必须单独存在（而不是把这几行塞进 main.js）：`import-md` 与 `import-dir` 的既有预览读数
 * **形状不一样** ——
 *   · `import-md --dry-run`：**只有文本回显**（实测确认：这条命令没有 `--json` 报告）；
 *   · `import-dir --dry-run --json`：有一份结构报告（`nodes` / `skippedDetail` / `resourceRefs.bad` …）。
 * 界面需要的却是**同一个形状**（新增 N / 更新 M / 未转换 K + 逐条点名），否则渲染侧会分叉成两条路 ✗。
 * ⇒ 归一化只放在这一处：主进程调本文件，界面只认下面这一种形状（界面**不认识** CLI 的字段名，
 *   与 `bindOptionArgs` 同一条分工 —— "把界面的话翻成 CLI 的参数/读数"只该有一处）。
 *
 * 两条纪律（都对着本工程最重的损害类别"没做，却看不出没做"）：
 *   ① **不重算，只搬运**：新增/未转换的条数一律取自 CLI 自己的报告或它自己的那一行 ——
 *      本文件不数树、不估、不四舍五入（"界面自己算一份"就是"同一件事两处表达" ✗）；
 *   ② **读不出来就响亮说**：文本里那行没匹配上 ⇒ `added: null`（**不是 0**）+ `unreadable` 一句原话，
 *      由调用方如实显示"这条读数读不到"。把解析失败显示成"新增 0 个节点"正是最重的那一类 ✗。
 *
 * 判别力（本文件的读数凭什么可信）：
 *   · `import-md` 那条文本读数**不是孤证** —— 真导入之后主进程还用 `concurrency` 的差异现算一遍
 *     "这次真的多了哪些节点"（`app:import-apply` 的 `addedKeys`），界面把两个数并列，
 *     域 43 的判据 ① 就是拿它们对拍（对不上必红）；
 *   · 单元侧：`tests/import-reading.test.js`（含"读不出来必须是 null 而不是 0""两类未转换都要点名"）。
 * ============================================================ */
'use strict';

/** `import-md --dry-run` 回显里那一行的形状（**唯一读法**：改口径只改这里 + 它的单测） */
const MD_ADDED_RE = /导入完成，新增\s*(\d+)\s*个节点/;

/** 路径 → 给人看的名字（只取最后一段；路径分隔符两种都认） */
function baseNameOf(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const seg = s.split('/');
  return seg[seg.length - 1] || s;
}

/**
 * `import-md --dry-run` 的一次读数。
 * 成功时回显里必有【导入完成，新增 N 个节点（父节点 X）】；**认不出来就返回 `added:null`**
 * （绝不回落到 0：那是把"读不到"伪装成"没新增"）。
 * @param {string} out CLI 的 stdout 原文
 * @returns {{added:number|null, unreadable:string}}
 */
function readImportMdDryRun(out) {
  const s = String(out || '');
  const m = s.match(MD_ADDED_RE);
  if (!m) return { added: null, unreadable: '回显里没有【导入完成，新增 N 个节点】那一行' };
  return { added: Number(m[1]), unreadable: '' };
}

/**
 * 一批文件的读数 → 界面的那一份预览。
 * `items` 里每项 = `{file, ok, added, unreadable, error}`（`added` 来自 `readImportMdDryRun`）。
 * 「未转换 K」= **没能导入的那些文件**，逐条点名（名字 + CLI 自己的原话）——
 * 而**好的那些照样算进「新增 N」**：一个坏文件不许让整批看起来像失败（部分成功 ✓）。
 * @returns {{kind:'files', added:number, addedUnreadable:number, updated:number,
 *   unconverted:number, unconvertedList:Array<{name:string,path:string,reason:string,how:string}>, updatedNote:string}}
 */
function mergeFilePreviews(items) {
  const list = Array.isArray(items) ? items : [];
  let added = 0;
  let unreadable = 0;
  const bad = [];
  list.forEach((it) => {
    if (!it) return;
    if (!it.ok) {
      bad.push({ name: baseNameOf(it.file), path: String(it.file || ''),
        reason: it.error || '这一条没有成功', how: '没能导入（这条命令报了错）' });
      return;
    }
    if (it.added === null || it.added === undefined) { unreadable += 1; return; }
    added += Number(it.added) || 0;
  });
  return {
    kind: 'files', added: added, addedUnreadable: unreadable, updated: 0,
    unconverted: bad.length, unconvertedList: bad,
    updatedNote: '导入只**新增**节点：它不改你已有的任何节点（所以「更新」恒为 0）'
  };
}

/**
 * `import-dir --dry-run --json` 的报告 → **同一种**预览形状（界面只有一条渲染路径 ✓）。
 * 「未转换 K」取**两类**都算（两类都必须逐条点名，缺一类就是"悄悄少报"）：
 *   ① `skippedDetail` —— 没进树的条目（空目录 / 不支持的扩展名 / 无读权限 / 符号链接 …）；
 *   ② `resourceRefs.bad` —— 图片/附件引用没能落成项目内文件的那几条（内容按正文保留，**没有丢**）。
 * @param {object} report CLI 的 `--json` 报告（原样；本函数只搬运）
 */
function dirPreviewOf(report) {
  const r = report || {};
  const list = [];
  const skipped = Array.isArray(r.skippedDetail) ? r.skippedDetail : [];
  skipped.forEach((s) => {
    const label = (s && s.label) || (s && s.reason) || '跳过';
    const msg = s && s.message;
    list.push({ name: (s && s.rel) || '', path: (s && s.rel) || '',
      reason: label + (msg ? '：' + msg : ''), how: '没进树（跳过，逐条点名）' });
  });
  const rr = r.resourceRefs || {};
  const badRefs = Array.isArray(rr.bad) ? rr.bad : [];
  badRefs.forEach((b) => {
    list.push({ name: ((b && b.file) || '') + ' · ' + ((b && b.ref) || ''),
      path: (b && b.file) || '',
      reason: (b && (b.reason || b.status)) || '引用没能落成项目内文件',
      how: '引用按正文保留（内容没丢，只是没挂进 images/files）' });
  });
  const skippedTotal = Number(r.skippedCount) || 0;
  const badRefTotal = Number(rr.badTotal === undefined ? badRefs.length : rr.badTotal) || 0;
  /* 【W12】Obsidian 库那一路：报告里带着 `vault`（CLI 那一侧算的）⇒ 原样搬运一份**给人看的**读数。
   *  界面**不重算**任何一条（断链数 / 接上的边数都取自 CLI 自己的累加器）✓。没开 vault ⇒ `null`。 */
  const v = r.vault && r.vault.enabled ? r.vault : null;
  const vault = v ? {
    auto: v.auto === true,
    files: Number(v.files) || 0,
    linkTotal: Number(v.linkTotal) || 0,
    linked: Number(v.linked) || 0,
    headingLinks: Number(v.headingLinks) || 0,
    aliasLinks: Number(v.aliasLinks) || 0,
    embedLinks: Number(v.embedLinks) || 0,
    danglingTotal: Number(v.danglingTotal) || 0,
    taggedFiles: Number(v.taggedFiles) || 0,
    frontmatterFiles: Number(v.frontmatterFiles) || 0,
    tags: Array.isArray(v.tags) ? v.tags.slice(0, 50) : [],
    aliases: Array.isArray(v.aliases) ? v.aliases.slice(0, 50) : [],
    resourceTotal: Number(v.resourceTotal) || 0,
    skippedDirs: Array.isArray(v.skippedDirs) ? v.skippedDirs.slice() : [],
    // 逐条点名的那几类：界面照 CLI 的原话列出来（**一条都不自己编**）
    dangling: (Array.isArray(v.dangling) ? v.dangling : []).map((d) => ({
      file: d.file, raw: d.raw, target: d.target, why: d.why
    })),
    ambiguous: (Array.isArray(v.ambiguous) ? v.ambiguous : []).map((d) => ({
      file: d.file, raw: d.raw, hits: d.hits
    })),
    embedNotes: (Array.isArray(v.embedNotes) ? v.embedNotes : []).map((d) => ({
      file: d.file, raw: d.raw, target: d.target
    })),
    resourceUnresolved: (Array.isArray(v.resourceUnresolved) ? v.resourceUnresolved : []).map((d) => ({
      file: d.file, raw: d.raw, status: d.status, reason: d.reason
    })),
    notes: Array.isArray(v.notes) ? v.notes.slice() : []
  } : null;
  return {
    kind: 'dir',
    added: Number(r.nodes) || 0,
    addedUnreadable: 0,
    updated: 0,
    unconverted: skippedTotal + badRefTotal,
    unconvertedList: list,
    wouldRefuse: r.wouldRefuse === true,
    refuseReason: r.refuseReason || '',
    files: Number(r.files) || 0,
    containers: Number(r.containers) || 0,
    skippedCount: skippedTotal,
    badRefCount: badRefTotal,
    vault: vault,
    updatedNote: '整库导入会**新建一个项目**：不改任何已有项目（所以「更新」恒为 0）'
  };
}

module.exports = {
  readImportMdDryRun: readImportMdDryRun,
  mergeFilePreviews: mergeFilePreviews,
  dirPreviewOf: dirPreviewOf,
  MD_ADDED_RE: MD_ADDED_RE
};
