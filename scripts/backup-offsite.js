#!/usr/bin/env node
/**
 * scripts/backup-offsite.js — 「异地备份」工具（W22）
 *
 * 为什么需要（问题不是"能不能 push 到 GitHub"）：
 *   `W22` 台账原话是「推送到 GitHub（异地备份）」。但 GitHub 只是**手段**，出网被策略拦是
 *   环境事实（`CONNECT tunnel failed, response 403`），不是本工程能修的缺陷。
 *   真正缺的东西是：**本机之外的第二个位置有一份可验证、可恢复的副本**。
 *   而工程现有的兜底备份 `D:/backup/ai-mind-map` 与工程**在同一块物理盘**上
 *   （实测：`C:` 与 `D:` 都是 Disk #0 的分区）⇒ 那块盘坏了，工程与备份一起没。
 *
 * 备份什么（三样东西完全不同，不能混为一谈）：
 *   ① `notes`   `projects/`      —— 笔记数据。**`.gitignore` 明写它不入库** ⇒ 没有历史、git 回滚不了
 *                                  ⇒ 它才是异地备份的重点。
 *   ② `code`    整仓 git          —— 打包成**一个 `git bundle` 文件**（单文件、可离线 `git clone`）。
 *                                  273 条提交都在里面；异地那份不需要 git 服务器。
 *   ③ `review`  `.review/`       —— 工作产物（分析稿/截图证据）。按契约"可随时整目录删除"，
 *                                  但它承载 ROADMAP 的证据指针 ⇒ 默认一起备，可 `--no-review` 关掉。
 *
 * 怎么做到「幂等 + 增量」（不是每次都搬全量）：
 *   **内容寻址**。每个文件按 sha256 落到 `blobs/<前2位>/<sha256>`；同一内容只写一次。
 *   快照只写一份清单（路径 → sha256），不复制字节 ⇒ 第二次跑、内容没变时**新增 0 字节**。
 *   （读数在每次运行的汇总行里：`新增块 … / 复用块 …`）
 *
 * 怎么做到「可复算的验证」：
 *   写完立刻**把每个块读回来重算 sha256** 与清单对拍；另有独立入口
 *   `--verify <快照id>` 事后复核任意一份快照。
 *
 * 怎么回答「哪个项目哪个节点变了」：
 *   每份快照额外落一份 `nodes.json`（项目名 → {节点 id: {标题, 父 id}}），
 *   与上一份快照对拍即可报出 **新增 / 删除 / 改标题** 的节点，带祖先路径。
 *   —— 这就是"笔记没有 git 历史"这件事的正面处理：笔记不需要进 git，
 *   但它们有了**带节点级差异的快照序列**。
 *
 * ⚠️ 只读源：本脚本对 `projects/` 只做 `readFileSync`，**一个字节都不写**。
 * ⚠️ 不碰 `.gitignore`：笔记版本化走本工具的"快照序列"，不走 git（那是用户的契约决定）。
 *
 * 用法：
 *   node scripts/backup-offsite.js                       # 备份到默认远端（Y:）
 *   node scripts/backup-offsite.js --target Y:\path      # 指定落点
 *   node scripts/backup-offsite.js --no-review           # 只备 notes + code
 *   node scripts/backup-offsite.js --verify              # 复核最新快照
 *   node scripts/backup-offsite.js --verify 20261020-101500
 *   node scripts/backup-offsite.js --list                # 列快照
 *   node scripts/backup-offsite.js --restore D:\tmp\r    # 从最新快照恢复到目录
 *   node scripts/backup-offsite.js --json                # 机器可读读数
 *
 * 退出码：0 = 成功且自检通过 · 1 = 失败（不可写 / 对拍不一致 / 恢复失败）· 2 = 采不到真值
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 写盘出口：**唯一**原子写实现在 `src/data-store.js`（tmp → fsync → rename）。
// ⚠️ 本工具第一版自己写了一份 `tmp + rename`，被门禁 S2（`collateral-check.js` 的「自造第二份原子写」）
// 当场抓到 —— 那正是这条门禁存在的理由（W11 / I-5 两批已经踩过，这是第三次）。
// 依赖方向 scripts(3) → src(1) 合法（见 `scripts/dep-direction-check.js` 的 LAYERS）。
const { writeFileAtomic } = require('../src/data-store.js');

const ROOT = path.resolve(__dirname, '..');

/** 默认落点：网络盘（另一台主机，真「异地」）。换机器/换环境时用 `--target` 覆盖。 */
const DEFAULT_TARGET = 'Y:\\mm-offsite\\ai-mind-map';

/** 运行时信号：`.gitignore` 里逐条写明"本机进程状态 / 使用痕迹，不是笔记数据"。
 *  备份的是**数据**，不是"这台机器此刻的状态" ⇒ 默认排除，并在读数里报出排除了几个。
 *
 *  ⚠️ 锚定的坑（本工具自己踩过）：路径是 `path.relative()` 出来的**相对**路径，
 *  顶层点目录写作 `.visits/x.jsonl` —— **前面没有分隔符**。
 *  第一版写成 `/[\\/]projects[\\/]\.visits[\\/]/` ⇒ 顶层那 10 个文件**一个都没被排除**，
 *  而读数上只是"排除了 4 个"（那 4 个是 `.ui-state.json`，因为 `$` 锚不需要前导分隔符）。
 *  是恢复演练的 sha256 对拍把它抓出来的（源里还在变 ⇒ 2 个文件对不上）。
 *  现在三条都用 `(^|[\\/])` 锚定。 */
const VOLATILE = [
  /(^|[\\/])\.ui-state\.json$/,           // 「界面有未保存编辑」的本机进程状态
  /(^|[\\/])\.visits[\\/]/,               // 访问事件日志（热度条的原始素材，本机使用痕迹）
  /(^|[\\/])\.writers[\\/]/,              // 「真实数据零写入」守卫的批登记台账
  /\.tmp$/,                               // 脚本中间产物
  /(^|[\\/])~\$/,                         // Office 锁文件
];

/** 刻意**保留**的点文件（它们承载信息，不是运行时信号）：
 *  `**​/.changes.jsonl` = 变更日志（笔记没有 git 历史，这份是本机唯一的变更叙事）。 */
const VOLATILE_KEEP = [/(^|[\\/])\.changes\.jsonl$/];

const DATA_EXT_SKIP = new Set([]);

/* ---------------------------------------------------------------- 小工具 */

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  return sha256Buf(fs.readFileSync(p));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function tsId(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(2) + ' MB';
}

/** 递归列文件（**排序** ⇒ 同一状态两次跑得到同一清单，不给快照塞随机的目录顺序） */
function walk(root, filter) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;        // 符号链接/设备文件不备份
      const r = rel(p);
      if (filter && !filter(r, p)) continue;
      out.push(r);
    }
  }
  out.sort();
  return out;
}

function isVolatile(r) {
  return VOLATILE.some((re) => re.test(r));
}

/* ---------------------------------------------------------------- git bundle */

/** 用一个 bundle 文件承载整仓历史（`--all` ⇒ 全部分支+tag）。
 *  为什么不是 `git push`：出网被策略拦（403），且 `git push` 在本机被策略层直接拒绝；
 *  而 bundle 是**单文件**，落盘到任何位置都能被 `git clone` 读回 —— 不需要服务器。 */
function makeGitBundle(destDir) {
  ensureDir(destDir);
  const out = path.join(destDir, 'repo.bundle');
  const r = spawnSync('git', ['bundle', 'create', out, '--all'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
  });
  if (r.error) return { ok: false, why: r.error.code || r.error.message };
  if (r.status !== 0) {
    return { ok: false, why: (r.stderr || '').trim().split('\n').slice(-3).join(' / ') || ('exit ' + r.status) };
  }
  if (!fs.existsSync(out)) return { ok: false, why: 'bundle 未生成' };
  const st = fs.statSync(out);
  const head = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return {
    ok: true,
    bytes: st.size,
    commits: parseInt((head.stdout || '0').trim(), 10) || null,
    sha256: sha256File(out),
  };
}

/* ---------------------------------------------------------------- 笔记节点索引 */

/** 项目 JSON 的树根是 `meta` / `format` / `data` / `assoc` —— 树在 **`data`** 上（不是 `nodes`）。 */
function nodeIndexOfProject(jsonPath) {
  const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const idx = {};
  if (!doc || !doc.data) return idx;
  const stack = [{ n: doc.data, parent: null }];
  while (stack.length) {
    const { n, parent } = stack.pop();
    if (!n || typeof n !== 'object') continue;
    const id = String(n.id);
    idx[id] = { t: typeof n.topic === 'string' ? n.topic : '', p: parent };
    if (Array.isArray(n.children)) {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push({ n: n.children[i], parent: id });
    }
  }
  return idx;
}

function buildNodeIndex() {
  const dir = path.join(ROOT, 'projects');
  const out = {};
  let dirs = [];
  try { dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { return out; }
  for (const name of dirs.sort()) {
    if (name.startsWith('.')) continue;
    const jp = path.join(dir, name, name + '.json');
    if (!fs.existsSync(jp)) continue;
    try { out[name] = nodeIndexOfProject(jp); } catch (e) { out[name] = { __error: String(e.message) }; }
  }
  return out;
}

/** 从 `{id: {t, p}}` 还原一条祖先路径（人读用：`父 / 子 / 孙`） */
function nodePath(idx, id, maxDepth) {
  const parts = [];
  let cur = id;
  let guard = 0;
  while (cur != null && guard++ < (maxDepth || 40)) {
    const e = idx[cur];
    if (!e) break;
    parts.unshift(e.t || ('#' + cur));
    cur = e.p;
  }
  return parts.join(' / ');
}

/* ---------------------------------------------------------------- 差异 */

function diffNodeIndexes(prev, next) {
  const out = [];
  const names = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const name of [...names].sort()) {
    const a = prev[name] || {};
    const b = next[name] || {};
    const added = [];
    const removed = [];
    const renamed = [];
    for (const id of Object.keys(b)) {
      if (id === '__error') continue;
      if (!(id in a)) added.push({ id, topic: b[id].t, path: nodePath(b, id) });
      else if ((a[id].t || '') !== (b[id].t || '')) {
        renamed.push({ id, from: a[id].t, to: b[id].t, path: nodePath(b, id) });
      }
    }
    for (const id of Object.keys(a)) {
      if (id === '__error') continue;
      if (!(id in b)) removed.push({ id, topic: a[id].t, path: nodePath(a, id) });
    }
    if (added.length || removed.length || renamed.length) {
      out.push({ project: name, added, removed, renamed });
    }
  }
  return out;
}

function diffFileManifests(prev, next) {
  const a = prev || {};
  const b = next || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const p of Object.keys(b)) {
    if (!(p in a)) added.push(p);
    else if (a[p].sha256 !== b[p].sha256) changed.push(p);
  }
  for (const p of Object.keys(a)) if (!(p in b)) removed.push(p);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function renderDiffMd(prevId, curId, fileDiff, nodeDiff, stats) {
  const L = [];
  L.push('# 差异说明（' + curId + (prevId ? '  vs  ' + prevId : '  vs  基线=无') + '）');
  L.push('');
  if (!prevId) {
    L.push('这是该落点上的**第一份快照**，没有上一份可对拍。');
    L.push('');
    L.push('本份内容：' + stats.fileCount + ' 个文件 / ' + mb(stats.bytes) + '；'
      + Object.keys(stats.nodeIndex || {}).length + ' 个项目 / '
      + Object.values(stats.nodeIndex || {}).reduce((s, v) => s + Object.keys(v).length, 0) + ' 个节点。');
    return L.join('\n') + '\n';
  }
  L.push('## 一、文件级');
  L.push('');
  L.push('- 新增 ' + fileDiff.added.length + ' 个');
  L.push('- 删除 ' + fileDiff.removed.length + ' 个');
  L.push('- 内容变化 ' + fileDiff.changed.length + ' 个');
  L.push('');
  const listOf = (arr, cap) => arr.slice(0, cap || 40).map((p) => '  - `' + p + '`').join('\n');
  if (fileDiff.added.length) L.push('新增：\n' + listOf(fileDiff.added));
  if (fileDiff.removed.length) L.push('删除：\n' + listOf(fileDiff.removed));
  if (fileDiff.changed.length) L.push('变化：\n' + listOf(fileDiff.changed));
  L.push('');
  L.push('## 二、节点级（「哪个项目哪个节点变了」）');
  L.push('');
  if (!nodeDiff.length) {
    L.push('**没有任何节点变化** —— 笔记数据与上一份快照逐节点相同。');
  } else {
    for (const d of nodeDiff) {
      L.push('### ' + d.project);
      L.push('');
      if (d.added.length) {
        L.push('- 新增节点 ' + d.added.length + ' 个：');
        for (const n of d.added.slice(0, 20)) L.push('  - `' + n.id + '` 「' + n.topic + '」　路径：' + n.path);
      }
      if (d.removed.length) {
        L.push('- 删除节点 ' + d.removed.length + ' 个：');
        for (const n of d.removed.slice(0, 20)) L.push('  - `' + n.id + '` 「' + n.topic + '」　路径：' + n.path);
      }
      if (d.renamed.length) {
        L.push('- 改标题 ' + d.renamed.length + ' 个：');
        for (const n of d.renamed.slice(0, 20)) L.push('  - `' + n.id + '` 「' + n.from + '」→「' + n.to + '」');
      }
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

/* ---------------------------------------------------------------- 落点布局 */

function layout(target) {
  return {
    root: target,
    blobs: path.join(target, 'blobs'),
    snapshots: path.join(target, 'snapshots'),
    indexPath: path.join(target, 'index.json'),
    latestPath: path.join(target, 'LATEST.txt'),
    readmePath: path.join(target, 'README-RESTORE.md'),
  };
}

function readIndex(L) {
  try { return JSON.parse(fs.readFileSync(L.indexPath, 'utf8')); } catch (e) { return { version: 1, snapshots: [] }; }
}

function readLatestId(L) {
  try { return fs.readFileSync(L.latestPath, 'utf8').trim(); } catch (e) { return null; }
}

function loadManifest(L, snapshotId) {
  const p = path.join(L.snapshots, snapshotId, 'MANIFEST.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ---------------------------------------------------------------- 命令：backup */

function cmdBackup(opts) {
  const target = opts.target || DEFAULT_TARGET;
  const L = layout(target);
  const started = Date.now();

  // 0. 落点可写？
  try {
    ensureDir(L.snapshots);
    ensureDir(L.blobs);
    const probe = path.join(L.root, '.write-probe.' + process.pid);
    writeFileAtomic(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    fail('落点不可写：' + target + ' —— ' + (e.code || e.message));
    return 1;
  }

  // 1. 收集源文件
  const sources = [];
  const notes = walk(path.join(ROOT, 'projects'), (r) => !isVolatile(r));
  for (const r of notes) sources.push({ rel: r, tier: 'notes' });
  // 读数要诚实：被排除的运行时信号有几个（不静默跳过）
  const allNotes = walk(path.join(ROOT, 'projects'), null);
  const volatileSkipped = allNotes.length - notes.length;

  const reviewRoot = path.join(ROOT, '.review');
  const reviewFiles = opts.review
    ? walk(reviewRoot, (r) => !isVolatile(r) && !/\.tmp$/.test(r))
    : [];
  for (const r of reviewFiles) sources.push({ rel: r, tier: 'review' });

  if (!notes.length) {
    fail('projects/ 下没读到任何文件 —— 采不到真值，不出快照');
    return 2;
  }

  // 2. 内容寻址：逐文件算 sha256，只写缺失的块
  const index = readIndex(L);
  const prevId = readLatestId(L);
  const prevManifest = prevId ? safeLoadManifest(L, prevId) : null;

  let newBlobs = 0;
  let newBlobBytes = 0;
  let reusedBlobs = 0;
  let scannedBytes = 0;
  const newShas = new Set();   // 本次新写的块 ⇒ 写完立刻验它们（复用块在它被写下的那次已验过）
  const manifest = {};
  const tierStats = { notes: { n: 0, b: 0 }, review: { n: 0, b: 0 }, code: { n: 0, b: 0 } };

  for (const s of sources) {
    const abs = path.join(ROOT, s.rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { continue; }   // 并发删除/占用 ⇒ 跳过并计入下方
    scannedBytes += buf.length;
    const h = sha256Buf(buf);
    const blobDir = path.join(L.blobs, h.slice(0, 2));
    const blobPath = path.join(blobDir, h);
    let existed = false;
    try { existed = fs.statSync(blobPath).isFile(); } catch (e) { existed = false; }
    if (!existed) {
      ensureDir(blobDir);
      writeFileAtomic(blobPath, buf);   // 唯一原子写出口（自带 tmp → fsync → rename）
      newShas.add(h);
      newBlobs += 1;
      newBlobBytes += buf.length;
    } else {
      reusedBlobs += 1;
    }
    manifest[s.rel] = { sha256: h, size: buf.length, tier: s.tier };
    tierStats[s.tier].n += 1;
    tierStats[s.tier].b += buf.length;
  }

  // 3. 代码：git bundle（单文件，可离线 clone）
  const tmpDir = path.join(L.root, '.tmp-bundle-' + process.pid);
  const bundle = makeGitBundle(tmpDir);
  let bundleRec = null;
  if (bundle.ok) {
    const h = bundle.sha256;
    const blobDir = path.join(L.blobs, h.slice(0, 2));
    const blobPath = path.join(blobDir, h);
    const dest = path.join(tmpDir, 'repo.bundle');
    let existed = false;
    try { existed = fs.statSync(blobPath).isFile(); } catch (e) { existed = false; }
    if (!existed) {
      ensureDir(blobDir);
      writeFileAtomic(blobPath, fs.readFileSync(dest));
      newShas.add(h);
      newBlobs += 1;
      newBlobBytes += bundle.bytes;
    } else {
      reusedBlobs += 1;
    }
    bundleRec = { sha256: h, size: bundle.bytes, commits: bundle.commits };
    manifest['git/repo.bundle'] = { sha256: h, size: bundle.bytes, tier: 'code' };
    tierStats.code.n += 1;
    tierStats.code.b += bundle.bytes;
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  // 4. 节点索引 + 快照
  const nodeIndex = buildNodeIndex();
  const snapshotId = tsId(new Date());
  const snapDir = path.join(L.snapshots, snapshotId);
  ensureDir(snapDir);

  const nodeCount = Object.values(nodeIndex).reduce((s, v) => s + Object.keys(v).filter((k) => k !== '__error').length, 0);
  const totalBytes = Object.values(manifest).reduce((s, v) => s + v.size, 0);

  writeFileAtomic(path.join(snapDir, 'MANIFEST.json'),
    JSON.stringify({ snapshotId, createdAt: new Date().toISOString(), root: ROOT, files: manifest }, null, 2));
  writeFileAtomic(path.join(snapDir, 'nodes.json'), JSON.stringify(nodeIndex, null, 2));

  const prevNodeIndex = prevId ? safeLoadNodes(L, prevId) : null;
  const nodeDiff = prevNodeIndex ? diffNodeIndexes(prevNodeIndex, nodeIndex) : [];
  const fileDiff = prevManifest
    ? diffFileManifests(prevManifest.files || {}, manifest)
    : { added: [], removed: [], changed: [] };

  writeFileAtomic(path.join(snapDir, 'DIFF.json'),
    JSON.stringify({ prevId, fileDiff, nodeDiff }, null, 2));
  writeFileAtomic(path.join(snapDir, 'DIFF.md'),
    renderDiffMd(prevId, snapshotId, fileDiff, nodeDiff,
      { fileCount: Object.keys(manifest).length, bytes: totalBytes, nodeIndex }));

  // 5. 自验证：把**本次新写的**块读回来重算 sha256（可复算的验证，不靠"我写过了"）。
  //    全量复核是独立入口 `--verify`（事后任何时候都能把整份快照重算一遍）。
  const verifyRes = verifyManifest(L, manifest, opts.fullVerify ? null : newShas);

  // 6. 索引与指针
  index.snapshots = (index.snapshots || []).filter((s) => s.id !== snapshotId);
  index.snapshots.push({
    id: snapshotId,
    createdAt: new Date().toISOString(),
    files: Object.keys(manifest).length,
    bytes: totalBytes,
    nodes: nodeCount,
    projects: Object.keys(nodeIndex).length,
    newBlobs,
    reusedBlobs,
    tiers: {
      notes: tierStats.notes,
      review: tierStats.review,
      code: tierStats.code,
    },
    verify: verifyRes.ok,
  });
  index.snapshots.sort((a, b) => a.id.localeCompare(b.id));
  writeFileAtomic(L.indexPath, JSON.stringify(index, null, 2));
  writeFileAtomic(L.latestPath, snapshotId + '\n');
  writeFileAtomic(L.readmePath, renderRestoreReadme(L, index));

  // 7. 读数
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const out = {
    ok: verifyRes.ok,
    target,
    snapshotId,
    prevId,
    files: Object.keys(manifest).length,
    bytes: totalBytes,
    projects: Object.keys(nodeIndex).length,
    nodes: nodeCount,
    tiers: tierStats,
    bundle: bundleRec,
    newBlobs,
    newBlobBytes,
    reusedBlobs,
    volatileSkipped,
    newBlobMB: mb(newBlobBytes),
    scannedMB: mb(scannedBytes),
    verify: { ok: verifyRes.ok, checked: verifyRes.checked, skipped: verifyRes.skipped, bad: verifyRes.bad },
    nodeDiff: nodeDiff.map((d) => ({ project: d.project, added: d.added.length, removed: d.removed.length, renamed: d.renamed.length })),
    fileDiff: { added: fileDiff.added.length, removed: fileDiff.removed.length, changed: fileDiff.changed.length },
    seconds: elapsed,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    const lines = [];
    lines.push('=== 异地备份：' + target + ' ===');
    lines.push('快照：' + snapshotId + (prevId ? '（上一份：' + prevId + '）' : '（该落点第一份）'));
    lines.push('内容：' + out.files + ' 个文件 / ' + mb(out.bytes));
    lines.push('  notes  ' + tierStats.notes.n + ' 文件 / ' + mb(tierStats.notes.b)
      + '（另排除 ' + volatileSkipped + ' 个运行时信号：.ui-state.json / .visits / .writers —— 不是笔记数据）');
    lines.push('  review ' + tierStats.review.n + ' 文件 / ' + mb(tierStats.review.b)
      + (opts.review ? '' : '（--no-review：本次不含）'));
    lines.push('  code   ' + (bundleRec
      ? 'git bundle ' + mb(bundleRec.size) + ' / ' + bundleRec.commits + ' 条提交'
      : '未生成（' + (bundle.why || '未知原因') + '）'));
    lines.push('笔记：' + out.projects + ' 个项目 / ' + out.nodes + ' 个节点');
    lines.push('增量：新增块 ' + newBlobs + ' 个 / ' + mb(newBlobBytes)
      + '；复用块 ' + reusedBlobs + ' 个（未重复搬）');
    lines.push('自检：' + (verifyRes.ok ? '通过' : '失败')
      + '（回读**本次新写的** ' + verifyRes.checked + ' 个块重算 sha256，坏 ' + verifyRes.bad + ' 个'
      + '；复用 ' + verifyRes.skipped + ' 个块在写下那次已验，全量复核用 `--verify`）');
    if (nodeDiff.length) {
      lines.push('节点级差异：');
      for (const d of out.nodeDiff) {
        lines.push('  ' + d.project + '：新增 ' + d.added + ' / 删除 ' + d.removed + ' / 改标题 ' + d.renamed);
      }
    } else if (prevId) {
      lines.push('节点级差异：无（笔记与上一份快照逐节点相同）');
    }
    lines.push('耗时：' + elapsed + ' s');
    process.stdout.write(lines.join('\n') + '\n');
  }
  return verifyRes.ok ? 0 : 1;
}

function safeLoadManifest(L, id) {
  try { return loadManifest(L, id); } catch (e) { return null; }
}
function safeLoadNodes(L, id) {
  try { return JSON.parse(fs.readFileSync(path.join(L.snapshots, id, 'nodes.json'), 'utf8')); } catch (e) { return null; }
}

/* ---------------------------------------------------------------- 验证 */

/** 逐个块读回、重算 sha256、与清单对拍。**判据是字节**，不是"文件存在"。
 *  `onlyShas`：只校验这批块（备份刚写完时只验**本次新写的** —— 复用块在它被写下的那次已经验过；
 *  全量复核是独立入口 `--verify`，那是"事后任何时候都能重算一遍"的口子）。 */
function verifyManifest(L, files, onlyShas) {
  let checked = 0;
  let skipped = 0;
  const bad = [];
  for (const [r, rec] of Object.entries(files)) {
    if (onlyShas && !onlyShas.has(rec.sha256)) { skipped += 1; continue; }
    const blobPath = path.join(L.blobs, rec.sha256.slice(0, 2), rec.sha256);
    let h = null;
    try { h = sha256File(blobPath); } catch (e) { bad.push({ rel: r, why: '读不到块(' + (e.code || e.message) + ')' }); continue; }
    checked += 1;
    if (h !== rec.sha256) bad.push({ rel: r, why: 'sha256 不符（盘上 ' + h.slice(0, 12) + ' ≠ 清单 ' + rec.sha256.slice(0, 12) + '）' });
  }
  return { ok: bad.length === 0, checked, skipped, bad: bad.length, badList: bad };
}

function cmdVerify(opts) {
  const target = opts.target || DEFAULT_TARGET;
  const L = layout(target);
  const id = opts.verifyId || readLatestId(L);
  if (!id) { fail('落点上没有快照（LATEST.txt 不存在）：' + target); return 2; }
  const man = safeLoadManifest(L, id);
  if (!man) { fail('读不到快照清单：' + id); return 2; }
  const res = verifyManifest(L, man.files || {});
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: res.ok, snapshotId: id, checked: res.checked, bad: res.bad, badList: res.badList }, null, 2) + '\n');
  } else {
    const lines = [];
    lines.push('=== 复核快照 ' + id + ' @ ' + target + ' ===');
    lines.push('文件数：' + Object.keys(man.files || {}).length + '；回读重算：' + res.checked + ' 个块');
    lines.push('结果：' + (res.ok ? '全部 sha256 与清单一致 ✓' : '有 ' + res.bad + ' 处不一致 ✗'));
    for (const b of res.badList.slice(0, 20)) lines.push('  - ' + b.rel + '：' + b.why);
    lines.push('样本（前 5 个块的现算值）：');
    let n = 0;
    for (const [r, rec] of Object.entries(man.files || {})) {
      if (n++ >= 5) break;
      let h = '(读不到)';
      try { h = sha256File(path.join(L.blobs, rec.sha256.slice(0, 2), rec.sha256)); } catch (e) { /* 保持 */ }
      lines.push('  ' + rec.sha256 + '  ' + r + (h === rec.sha256 ? '  ✓' : '  ✗'));
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
  return res.ok ? 0 : 1;
}

/* ---------------------------------------------------------------- 列表 / 恢复 */

function cmdList(opts) {
  const target = opts.target || DEFAULT_TARGET;
  const L = layout(target);
  const index = readIndex(L);
  if (!index.snapshots || !index.snapshots.length) {
    process.stdout.write('（该落点上还没有快照：' + target + '）\n');
    return 0;
  }
  const lines = [];
  lines.push('=== 快照索引 @ ' + target + ' ===');
  for (const s of index.snapshots) {
    lines.push(s.id + '  ' + String(s.files).padStart(5) + ' 文件  '
      + String(s.bytes).padStart(10) + ' B  ' + s.projects + ' 项目 / ' + s.nodes + ' 节点'
      + '  新增块 ' + s.newBlobs + '  复用 ' + s.reusedBlobs
      + '  自检 ' + (s.verify ? 'OK' : 'FAIL')
      + (s.id === readLatestId(L) ? '   ← LATEST' : ''));
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function cmdRestore(opts) {
  const target = opts.target || DEFAULT_TARGET;
  const L = layout(target);
  const dest = opts.restoreTo;
  if (!dest) { fail('--restore 需要目标目录'); return 1; }
  const id = opts.restoreId || readLatestId(L);
  if (!id) { fail('落点上没有快照'); return 2; }
  const man = safeLoadManifest(L, id);
  if (!man) { fail('读不到快照清单：' + id); return 2; }
  let n = 0;
  let verified = 0;
  const bad = [];
  for (const [r, rec] of Object.entries(man.files || {})) {
    const blobPath = path.join(L.blobs, rec.sha256.slice(0, 2), rec.sha256);
    const outPath = path.join(dest, r.split('/').join(path.sep));
    try {
      const buf = fs.readFileSync(blobPath);
      // **先验后写**：块坏了就不冒充"恢复成功"（恢复出来的东西必须是能验过的东西）
      if (sha256Buf(buf) !== rec.sha256) { bad.push(r + '：块 sha256 不符，拒绝写出'); continue; }
      verified += 1;
      ensureDir(path.dirname(outPath));
      writeFileAtomic(outPath, buf);
      n += 1;
    } catch (e) {
      bad.push(r + '：' + (e.code || e.message));
    }
  }
  process.stdout.write('=== 从快照 ' + id + ' 恢复到 ' + dest + ' ===\n');
  process.stdout.write('逐块校验通过 ' + verified + ' 个；写出 ' + n + ' 个文件'
    + (bad.length ? '，失败 ' + bad.length + ' 个' : '，全部成功') + '\n');
  for (const b of bad.slice(0, 10)) process.stdout.write('  - ' + b + '\n');
  return bad.length === 0 ? 0 : 1;
}

/* ---------------------------------------------------------------- 恢复说明（写到落点） */

function renderRestoreReadme(L, index) {
  return [
    '# 离线恢复说明（AI MindMap 异地备份）',
    '',
    '本目录由 `node scripts/backup-offsite.js` 生成。它**不依赖 git 服务器、不依赖网络**：',
    '只要有这个目录，就能把工程与笔记原样恢复出来。',
    '',
    '## 目录结构',
    '',
    '```',
    'blobs/<xx>/<sha256>            内容寻址块（同一内容只存一份）',
    'snapshots/<id>/MANIFEST.json   该快照的文件清单：路径 → sha256/size/tier',
    'snapshots/<id>/nodes.json      该快照的笔记节点索引：项目 → {节点id: {标题, 父id}}',
    'snapshots/<id>/DIFF.md         与上一份快照的差异（文件级 + **节点级**）',
    'LATEST.txt                     最新快照 id',
    'index.json                     全部快照的索引',
    '```',
    '',
    '## 恢复',
    '',
    '```bash',
    '# 1) 先把 blobs/ 与 snapshots/ 拷到本机任意目录，然后：',
    'node scripts/backup-offsite.js --target <本目录> --list        # 看有哪些快照',
    'node scripts/backup-offsite.js --target <本目录> --verify      # 先验：块是否都还在、sha256 是否对得上',
    'node scripts/backup-offsite.js --target <本目录> --restore D:\\restore-out   # 恢复到指定目录',
    '```',
    '',
    '恢复出来的目录里：`projects/` 就是全部笔记数据，`git/repo.bundle` 可以用',
    '`git clone repo.bundle <新目录>` 还原整仓历史。',
    '',
    '## 为什么笔记在 git 之外还有这里',
    '',
    '`.gitignore` 明写 `projects/` **不入库**（用户 2026-10-19 裁定）⇒ 笔记没有 git 历史、',
    '`git` 回滚不了。这里的快照序列就是它的历史：每份快照都有节点级索引，',
    '`DIFF.md` 能回答"**哪个项目的哪个节点变了**"。',
    '',
    '## 当前快照数：' + ((index.snapshots || []).length) + '',
    '',
  ].join('\n');
}

/* ---------------------------------------------------------------- 入口 */

function fail(msg) {
  process.stderr.write('error: ' + msg + '\n');
}

function parseArgs(argv) {
  const o = { review: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = argv[++i];
    else if (a === '--mirror') o.mirror = argv[++i];
    else if (a === '--no-review') o.review = false;
    else if (a === '--review') o.review = true;
    else if (a === '--full-verify') o.fullVerify = true;
    else if (a === '--json') o.json = true;
    else if (a === '--list') o.list = true;
    else if (a === '--verify') {
      o.verify = true;
      const nx = argv[i + 1];
      if (nx && !nx.startsWith('--')) { o.verifyId = nx; i++; }
    } else if (a === '--restore') { o.restore = true; o.restoreTo = argv[++i]; }
    else if (a === '--snapshot') o.restoreId = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) { fail('未知参数：' + a); o.bad = true; }
  }
  return o;
}

const USAGE = [
  '用法：node scripts/backup-offsite.js [选项]',
  '',
  '  --target <dir>       落点（默认 ' + DEFAULT_TARGET + '）',
  '  --no-review          不备 .review/（只备 notes + code）',
  '  --full-verify        写完把**整份快照**的所有块都回读重算（慢；默认只验本次新写的）',
  '  --verify [快照id]     复核快照（默认最新）：逐块回读重算 sha256',
  '  --list               列出落点上的所有快照',
  '  --restore <dir>      从快照恢复（默认最新）',
  '  --snapshot <id>      配合 --restore 指定快照',
  '  --json               机器可读读数',
  '',
  '退出码：0 = 成功 · 1 = 失败 · 2 = 采不到真值',
].join('\n');

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (opts.bad) { process.stdout.write(USAGE + '\n'); return 1; }
  if (opts.list) return cmdList(opts);
  if (opts.verify) return cmdVerify(opts);
  if (opts.restore) return cmdRestore(opts);
  return cmdBackup(opts);
}

if (require.main === module) {
  let code = 1;
  try { code = main(); } catch (e) {
    fail(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : String(e));
    code = 1;
  }
  process.exit(code);
}

module.exports = { buildNodeIndex, diffNodeIndexes, verifyManifest, nodeIndexOfProject, nodePath };
