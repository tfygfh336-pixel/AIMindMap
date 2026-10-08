/* ============================================================
 * scripts/cli-integration.js — CLI 全命令集成回归（headless）
 * ------------------------------------------------------------
 * 用途：AI 每次迭代后跑 `node scripts/cli-integration.js`，
 *       对 registry 里的全部 CLI 命令做端到端回归（`docs-gen` / `release` 除外 ——
 *       这两个会改写文档与版本号，不在测试路径内；临时项目，用完清理）。
 *       命令条数以 `cli/registry.js` 为准（`node cli/mm-cli.js --help` 可数），
 *       这里**不**写死数字：写死的数字必然腐坏（曾写"40 条里的 38 条"）。
 * 设计：每条命令一个"断言"：执行 → 校验输出/副作用 → 计 PASS/FAIL。
 * 退出码：全 PASS=0，任一 FAIL=1。
 * 不依赖键盘鼠标、不依赖 GUI（比冒烟更底层，先于冒烟跑）。
 *
 * **执行方式：进程内调用**（`cli/main.js` 的 `invokeSync`），不再是每条断言起一个 Node 进程。
 *   改前实测 140 条 / 102 s ≈ 0.73 s/条 —— 绝大部分是进程冷启动。进程内调用同时**去掉了
 *   对管道 stdio 的依赖**，而管道 stdio 正是 `docs/VERIFY.md`「本机受限环境注意」记的
 *   那条假失败来源。文件末尾保留 4 条**真子进程**断言做对照，防止两条路径漂移。
 *   ⚠️ 进程内**同步**调用依赖一条不变量：`cli/commands/*` 的命令体**不得出现 await**
 *   （违反时 `invokeSync` 立刻抛错，`tests/cli-sync-invariant.test.js` 静态把守）。
 *
 * ⚠️⚠️ **本文件里"行内斜杠紧跟 ①–⑳"的写法是"判定标记"，参与 G9 门禁的计数**（标记必须唯一）。
 *   新增段落**不要**再起一套这样的编号 —— 撞上已有标记就会被 G9 判红
 *   （`[判定条数不符] 判定标记重复`）。**这条坑在本文件已经踩过三次**（都发生在新增并发断言的段落里，
 *   第三次甚至是"解释这条坑的注释自己又写了一遍标记"），所以写在这里，不只在报错文本里。
 *   要编号就把标记放在别的字符之后（如「（阶段4①）」这种形式），这样**不计入**计数。
 * ============================================================ */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'mm-cli.js');
// 进程内同步入口 —— 见文件头「执行方式」与 `cli/main.js` 顶部关于同步不变量的说明
const { invokeSync } = require(path.join(ROOT, 'cli', 'main.js'));
const PROJ = 'it-probe-' + Date.now().toString(36);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-it-'));
const OUT_JSON = path.join(TMP, 'out.aimap.json');

/* ---------------- 开工前清扫历史残留 ----------------
 * 本脚本在**真实** projects/ 下造探针项目（store 与 CLI 同源，不另设根），
 * 结尾统一 rm。但脚本被中断（Ctrl+C / 超时被杀 / 崩溃）时收尾不执行 ——
 * 残留的 `it-probe-*` 会出现在应用的**项目列表**里，还会被 validate-all 当项目数。
 * （实测残留：it-probe-mucp3f55 让 "全部 2 个项目校验通过" 多算一个假项目。）
 * 只清扫**超过 10 分钟没动过**的：正在并发跑的另一份集成测试持有的是新鲜目录，
 * 不能误删（本工程存在并行 agent 同时跑门禁的常态）。 */
function sweepStaleProbes() {
  const dir = path.join(ROOT, 'projects');
  let removed = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('it-probe-')) continue;
      const p = path.join(dir, e.name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs < 10 * 60 * 1000) continue; // 可能是别人正在跑的
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } catch (err) { /* 单个失败不影响本轮 */ }
    }
  } catch (err) { /* projects/ 不存在：本轮会自己建 */ }
  if (removed) console.log('[清扫] 删除 ' + removed + ' 个历史残留探针项目（上次跑被中断）');
}
sweepStaleProbes();

/** 失败契约违规记录：**每个** run() 都被检查，因此全部断言都顺带验证契约，
 *  而不只是专门写的那一条（这正是"不变量应由一个守门点覆盖"的用法）。 */
const contractViolations = [];

function run(args) {
  const r = invokeSync(args); // 进程内同步调用（免去每条一次 Node 进程冷启动）
  const out = r.stdout + r.stderr; // 与子进程模式一致：两路合并
  // 不变量：**说了 error 就必须非 0 退出**（绝不能"报错却返回成功"）。
  // 反向不成立——validate-all 是"报告型"命令，会以 FAIL 行 + 非 0 退出码表达失败。
  const saidError = /^error:/.test(out.trim());
  const exitBad = r.code !== 0;
  if (saidError && !exitBad) {
    contractViolations.push(args.join(' ') + ' → 输出 error: 但 exit=' + r.code);
  }
  return { code: r.code, out };
}
const ok = (text) => !/^error:/.test(text.trim());

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? ' :: ' + detail : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}

/* ---------------- 用例序列 ---------------- */
// 1. init
let r = run(['init', PROJ, '--title', '集成测试']);
check('init', ok(r.out) && /已创建/.test(r.out), r.out.trim());

// 2. add 三个节点
r = run(['add', PROJ, 'root', '--topic', 'A', '--id', 'a']);
check('add a', ok(r.out) && /a/.test(r.out));
r = run(['add', PROJ, 'a', '--topic', 'B', '--id', 'b']);
check('add b', ok(r.out));
r = run(['add', PROJ, 'b', '--topic', 'C', '--id', 'c']);
check('add c', ok(r.out));

// 3b. add-root：凭空新增顶层主题（不选父节点，直接挂在 root 下）
r = run(['add-root', PROJ, '--topic', '顶层主题X', '--id', 'tx']);
check('add-root 顶层主题', ok(r.out) && /父 root/.test(r.out), r.out.trim());
r = run(['get', PROJ, 'tx']);
check('add-root 节点可读', ok(r.out) && /顶层主题X/.test(r.out), r.out.trim());

// 2.5. theme-layout：设置顶层主题左右分侧 → read 可见 meta.layout → validate 通过
r = run(['add-root', PROJ, '--topic', 'T1', '--id', 't1']);
check('add-root t1', ok(r.out) && /t1/.test(r.out));
r = run(['theme-layout', PROJ, '--left', 'a', '--right', 't1']);
check('theme-layout', ok(r.out) && /已设置主题布局/.test(r.out), r.out.trim());
r = run(['read', PROJ, '--json']);
check('read 含 meta.layout', ok(r.out) && /"layout"[\s\S]*"left"[\s\S]*"a"/.test(r.out));
r = run(['theme-layout', PROJ, '--left', 'not-a-theme']);
check('theme-layout 拒绝非顶层主题', !ok(r.out) && /不是顶层主题/.test(r.out), r.out.trim());
r = run(['theme-layout', PROJ, '--clear']);
check('theme-layout --clear', ok(r.out) && /已设置主题布局/.test(r.out));
r = run(['validate', PROJ]);
check('theme-layout 后 validate', ok(r.out));

// 3. move 防环（历史严重 bug）：移动到自身子孙必须被拒
r = run(['move', PROJ, 'b', 'c']);
check('move 成环被拒', !ok(r.out), r.out.trim());

// 4. move 正常
r = run(['move', PROJ, 'b', 'root']);
check('move 正常', ok(r.out) && /已移动/.test(r.out));

// 5. edit
r = run(['edit', PROJ, 'b', '--topic', 'B2', '--detail', '<p>详情</p>']);
check('edit', ok(r.out));

// 5b. detail 的存储语义是 HTML：--detail 必须原样存（不得被转义或转换）。
//     文档曾错称"detail 为 Markdown 语义"，导致 AI 写 Markdown 后渲染成字面量。
r = run(['edit', PROJ, 'b', '--detail', '<h3>直写</h3><ul><li>要点</li></ul>']);
const rawDetail = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json', '--detail']).out).detail; } catch (e) { return null; }
})();
check('--detail 按 HTML 原样存储（不转义）',
  rawDetail === '<h3>直写</h3><ul><li>要点</li></ul>', JSON.stringify(rawDetail));

// 5c. --detail-md 把 Markdown 转成 HTML 存储（AI 写 Markdown 的推荐路径）
r = run(['edit', PROJ, 'b', '--detail-md', '## 标题\n\n正文 **加粗**\n\n- 项一\n- 项二']);
const convDetail = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json', '--detail']).out).detail; } catch (e) { return null; }
})();
check('--detail-md 转为 HTML 存储',
  ok(r.out) && typeof convDetail === 'string'
  && /<h2>标题<\/h2>/.test(convDetail) && /<strong>加粗<\/strong>/.test(convDetail)
  && /<li>项一<\/li>/.test(convDetail) && !/\*\*/.test(convDetail),
  JSON.stringify(convDetail));

// 5d. --detail 与 --detail-md 互斥（避免"以为是 Markdown 其实是 HTML"的静默歧义）
r = run(['edit', PROJ, 'b', '--detail', '<b>x</b>', '--detail-md', '**y**']);
check('--detail 与 --detail-md 互斥被拒',
  /^error:/.test(r.out.trim()) && /不能同时使用/.test(r.out), r.out.trim().slice(0, 90));

// 5e. 存量 HTML 数据不被破坏：直接写回的 HTML 必须逐字保持
r = run(['edit', PROJ, 'b', '--detail', '<table border="1"><tr><th>维度</th></tr></table>']);
const tblDetail = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json', '--detail']).out).detail; } catch (e) { return null; }
})();
check('HTML 表格等存量结构原样保留',
  tblDetail === '<table border="1"><tr><th>维度</th></tr></table>', JSON.stringify(tblDetail));
run(['edit', PROJ, 'b', '--detail', '<p>详情</p>']);   // 复原为 edit 断言时的值

// 6. clone
r = run(['clone', PROJ, 'b', 'a', '--deep']);
check('clone', ok(r.out) && /已复制/.test(r.out));
// 清理这次 --deep 克隆出的节点（否则它会作为"有内容无引用"的孤儿污染 orphans 断言）
const deepCloneId = (/（新 id ([^）]+)）/.exec(r.out) || [])[1] || null;
if (deepCloneId) run(['remove', PROJ, deepCloneId]);

// 6b. clone 必须完整保留 tags / files（曾静默丢失两者）。
//     本块自给自足：先给 b 装上 tags+附件，检查后立刻复原，避免污染后续断言。
run(['edit', PROJ, 'b', '--tags', '克隆,标签']);
const ATT_FOR_CLONE = path.join(TMP, 'clone-att.md');
fs.writeFileSync(ATT_FOR_CLONE, '# 克隆附件\n', 'utf8');
run(['add-file', PROJ, 'b', '--file', ATT_FOR_CLONE, '--caption', '供 clone 检查的附件']);
const bBefore = (() => {
  try { return JSON.parse(run(['get', PROJ, 'b', '--json']).out); } catch (e) { return null; }
})();
r = run(['clone', PROJ, 'b', 'root']);
const clonedId = (() => {
  const m = /（新 id ([^）]+)）/.exec(r.out);
  return m ? m[1] : null;
})();
const clonedNode = (() => {
  if (!clonedId) return null;
  const g = run(['get', PROJ, clonedId, '--json']);
  try { return JSON.parse(g.out); } catch (e) { return null; }
})();
check('clone 保留 tags 与 files',
  !!bBefore && !!clonedNode
  && JSON.stringify(clonedNode.tags || []) === JSON.stringify(bBefore.tags || [])
  && (clonedNode.tags || []).length === 2
  && Array.isArray(clonedNode.files) && clonedNode.files.length === 1,
  'clonedId=' + clonedId + ' tags=' + JSON.stringify(clonedNode && clonedNode.tags)
  + ' files=' + String(clonedNode && clonedNode.files && clonedNode.files.length));
// 复原 b（删掉克隆节点、临时附件与标签），保证后续 files.length===1 断言不受影响
run(['remove', PROJ, clonedId || 'no-such-id']);
run(['edit', PROJ, 'b', '--clear-tags']);
if (bBefore && bBefore.files && bBefore.files.length) {
  run(['remove-file', PROJ, 'b', bBefore.files[bBefore.files.length - 1].file]);
}
r = run(['get', PROJ, 'b', '--json']);
check('clone 检查后 b 已复原',
  ok(r.out) && !r.out.includes('克隆') && !/"files"/.test(r.out), r.out.slice(0, 120));

// 6c. get 的 path 必须是真实层级路径（曾返回 DFS 访问过的全部节点）
r = run(['add', PROJ, 'root', '--topic', 'L1', '--id', 'p1']);
run(['add', PROJ, 'p1', '--topic', 'L2', '--id', 'p2']);
run(['add', PROJ, 'p2', '--topic', 'L3', '--id', 'p3']);
const deepPath = (() => {
  const g = run(['get', PROJ, 'p3', '--json']);
  try { return JSON.parse(g.out).path; } catch (e) { return null; }
})();
check('get path 为真实层级（root→…→节点）',
  Array.isArray(deepPath) && JSON.stringify(deepPath) === JSON.stringify(['root', 'p1', 'p2', 'p3']),
  JSON.stringify(deepPath));

// 6d. read --brief 必须真的省掉长文本（detail/images）
const fullRead = run(['read', PROJ, '--json']);
const briefRead = run(['read', PROJ, '--json', '--brief']);
const briefHasDetail = /"detail"/.test(briefRead.out);
check('read --brief 省略 detail 且更短',
  ok(briefRead.out) && !briefHasDetail && briefRead.out.length < fullRead.out.length,
  'full=' + fullRead.out.length + 'B brief=' + briefRead.out.length + 'B hasDetail=' + briefHasDetail);
check('read 默认仍含 detail（brief 不应影响默认口径）',
  ok(fullRead.out) && /"detail"/.test(fullRead.out), 'full len=' + fullRead.out.length);
run(['remove', PROJ, 'p1']);   // 清理 6c 的临时子树

// 7. read / list / get / search / stats
r = run(['read', PROJ, '--json']);
check('read --json', ok(r.out) && r.out.includes('nodeCount'));
r = run(['list', PROJ]);
check('list', ok(r.out) && r.out.includes('B2'));
r = run(['get', PROJ, 'b', '--json', '--detail']);
check('get', ok(r.out) && r.out.includes('详情'));
r = run(['search', PROJ, 'B2']);
check('search', ok(r.out) && r.out.includes('b'));
r = run(['stats', PROJ]);
check('stats', ok(r.out) && /nodes/.test(r.out));

// 8. link / links / unlink
r = run(['link', PROJ, 'a', '--to', 'comnet', '--id', 'dns', '--caption', '关联DNS']);
const linkOk = ok(r.out) && /已添加链接/.test(r.out);
check('link', linkOk, r.out.trim());

// 8b. orphans：关系审计。必须把"无引用但有内容"与"纯结构无内容"分开报 ——
//     前者是真正该处理的（漏挂链接），后者是正常结构，混在一起会淹没信号。
const orph = (() => {
  try { return JSON.parse(run(['orphans', PROJ, '--json']).out); } catch (e) { return null; }
})();
check('orphans 输出结构与分类字段',
  !!orph && typeof orph.orphans === 'number' && typeof orph.contentOrphans === 'number'
  && typeof orph.structural === 'number' && Array.isArray(orph.items)
  && orph.orphans === orph.contentOrphans + orph.structural,
  JSON.stringify(orph && { orphans: orph.orphans, content: orph.contentOrphans, structural: orph.structural }));
// a 已 link 到 comnet/dns → 不应被判为孤儿；b 无任何链接且有 detail → 应计入 contentOrphans
const orphIds = (() => {
  try { return JSON.parse(run(['orphans', PROJ, '--json', '--content-only', '--limit', '500']).out).items.map((x) => x.id); }
  catch (e) { return []; }
})();
check('orphans 正确区分有引用 / 无引用',
  orphIds.indexOf('a') < 0 && orphIds.indexOf('b') >= 0,
  'contentOrphans=' + JSON.stringify(orphIds));
// 有出边的节点不得被判为孤儿。注意 orphans 默认只把「有内容」的无引用节点计入
// contentOrphans，故先给 a 一个 detail 再验证；验证后清掉，避免影响后续断言。
run(['edit', PROJ, 'a', '--detail', '<p>a 的内容</p>']);
const orphAfterUnlink = (() => {
  run(['unlink', PROJ, 'a', '--to', 'comnet', '--id', 'dns']);
  try { return JSON.parse(run(['orphans', PROJ, '--json', '--content-only', '--limit', '500']).out).items.map((x) => x.id); }
  catch (e) { return []; }
})();
check('orphans 在移除出边后把该节点计入',
  orphAfterUnlink.indexOf('a') >= 0, 'afterUnlink=' + JSON.stringify(orphAfterUnlink));
run(['link', PROJ, 'a', '--to', 'comnet', '--id', 'dns', '--caption', '关联DNS']);   // 复原出边
run(['edit', PROJ, 'a', '--clear-detail']);                                          // 复原 detail
r = run(['links', PROJ]);
check('links', ok(r.out) && r.out.includes('comnet/dns'));
r = run(['unlink', PROJ, 'a', '--to', 'comnet', '--id', 'dns']);
check('unlink', ok(r.out) && /已移除/.test(r.out));

// 8c. mentions：未链接提及。构造一个专属子树来验证，互不干扰：
//     m1 的正文提到兄弟 m2（该报）、提到自己的子节点 m1c（结构相邻，不该报）、
//     且 m1 已链接 m3（已声明关系，不该报）。
run(['add', PROJ, 'root', '--topic', '提及宿主', '--id', 'mh']);
run(['add', PROJ, 'mh', '--topic', '提及者', '--id', 'm1']);
run(['add', PROJ, 'mh', '--topic', '被提及目标', '--id', 'm2']);
run(['add', PROJ, 'mh', '--topic', '已链接目标', '--id', 'm3']);
run(['add', PROJ, 'm1', '--topic', '自己的子节点', '--id', 'm1c']);
run(['add', PROJ, 'mh', '--topic', '自己的子节点', '--id', 'dup-topic-probe']);   // 同名干扰项
run(['edit', PROJ, 'm1', '--detail-md', '正文里提到了 被提及目标，也提到了 已链接目标，还提到了 自己的子节点。']);
run(['link', PROJ, 'm1', '--to', PROJ, '--id', 'm3']);                            // 已声明关系
const mt = (() => {
  try { return JSON.parse(run(['mentions', PROJ, '--json', '--limit', '500']).out); } catch (e) { return null; }
})();
const mtTo = (mt && mt.items ? mt.items.filter((x) => x.from === 'm1').map((x) => x.to) : []);
check('mentions 找出正文提到但未链接的节点',
  !!mt && mtTo.indexOf('m2') >= 0, 'from m1 -> ' + JSON.stringify(mtTo));
check('mentions 不报已声明 links 的目标', mtTo.indexOf('m3') < 0, JSON.stringify(mtTo));
check('mentions 默认过滤"结构上已相邻"（提到子孙不报）', mtTo.indexOf('m1c') < 0, JSON.stringify(mtTo));
check('mentions 的结构过滤可被 --include-structural 关闭', (() => {
  try {
    const all = JSON.parse(run(['mentions', PROJ, '--json', '--include-structural', '--limit', '500']).out);
    return all.items.some((x) => x.from === 'm1' && x.to === 'm1c');
  } catch (e) { return false; }
})());
check('mentions 的汇总字段自洽（raw ≥ 实际报告数，且计数为非负）',
  !!mt && mt.rawHits >= mt.mentions && mt.mentions === mt.items.length
  && mt.structuralSkipped >= 0 && mt.sources >= 0,
  JSON.stringify(mt && { rawHits: mt.rawHits, mentions: mt.mentions, skipped: mt.structuralSkipped, sources: mt.sources }));
// 清理专属子树，避免污染后续断言（尤其 orphans 的计数）
run(['remove', PROJ, 'mh']);


// 8.5 Obsidian 融合：标签 / 全文搜索 / 反向链接 / 相关知识点
r = run(['edit', PROJ, 'b', '--tags', '协议,核心']);
check('edit --tags', ok(r.out) && /已更新/.test(r.out), r.out.trim());
r = run(['get', PROJ, 'b', '--json']);
check('get 含 tags', ok(r.out) && r.out.includes('协议'));
r = run(['search', PROJ, '--tag', '协议', '--json']);
check('search --tag 命中', ok(r.out) && /"id": "b"/.test(r.out), r.out.trim());
r = run(['search', PROJ, '详情', '--full', '--json']);
check('search --full 命中 detail', ok(r.out) && /"matchIn": "detail"/.test(r.out), r.out.trim());
r = run(['search', PROJ, '详情', '--json']);
check('search 默认仅标题不命中 detail', ok(r.out) && /"hits": \[\]/.test(r.out), r.out.trim());
r = run(['edit', PROJ, 'b', '--clear-tags']);
check('edit --clear-tags', ok(r.out) && /已更新/.test(r.out));
r = run(['get', PROJ, 'b', '--json']);
check('clear-tags 后无 tags', ok(r.out) && !r.out.includes('协议'));
r = run(['edit', PROJ, 'b', '--tags', '协议,核心']);
// 同项目链接 → 反向链接 + 相关知识点
r = run(['link', PROJ, 'b', '--to', PROJ, '--id', 'a', '--caption', '关联A']);
check('link 同项目', ok(r.out) && /已添加链接/.test(r.out), r.out.trim());
r = run(['backlinks', PROJ, 'a', '--json']);
check('backlinks within', ok(r.out) && /"node": "b"/.test(r.out), r.out.trim());
r = run(['related', PROJ, 'b', '--json']);
const relJson = (() => { try { return JSON.parse(r.out); } catch (e) { return null; } })();
check('related 并入出边（我引用谁）',
  !!(relJson && Array.isArray(relJson.items)
    && relJson.items.some((x) => x.node === 'a' && x.dir === 'out' && x.project === PROJ)), r.out.slice(0, 160));
check('related 默认 depth=1（不展开两跳）',
  !!relJson && relJson.depth === 1 && relJson.depth2Count === 0
  && relJson.items.every((x) => x.depth === 1 && x.via === null),
  'depth=' + (relJson && relJson.depth) + ' d2=' + (relJson && relJson.depth2Count));

// 8.6 related --depth 2。
// 图的设计很关键：**必须造出真正的链**才能测两跳。第一版写成 a 的星形
// （b→a→c），从 a 出发一跳就把邻居收完，二跳恒为 0 —— 实现正确、测试图错了。
// 第二版又踩了一坑：复用了 p3，但 p1 子树在 L176 已被 remove，link 目标不存在 →
// link 静默失败 → 断言再次假失败。故此处用**本块自建、用后即删**的专属节点，
// 并对"链确实建成了"加前置断言（先证明前提，再断言结论）。
run(['add', PROJ, 'root', '--topic', '链尾', '--id', 'rel-tail']);
const linkA = run(['link', PROJ, 'a', '--to', PROJ, '--id', 'c', '--caption', 'a→c']);
const linkB = run(['link', PROJ, 'c', '--to', PROJ, '--id', 'rel-tail', '--caption', 'c→链尾']);
check('depth 2 的前置条件：a→c 与 c→链尾 两条链接确实建成',
  ok(linkA.out) && /已添加链接/.test(linkA.out) && ok(linkB.out) && /已添加链接/.test(linkB.out),
  linkA.out.trim() + ' | ' + linkB.out.trim());
const rel1 = (() => { try { return JSON.parse(run(['related', PROJ, 'a', '--json']).out); } catch (e) { return null; } })();
const rel2 = (() => { try { return JSON.parse(run(['related', PROJ, 'a', '--json', '--depth', '2']).out); } catch (e) { return null; } })();
const rel2far = (rel2 && rel2.items.filter((x) => x.depth === 2)) || [];
check('related --depth 2 把邻域扩到两跳（经由一跳邻居到达「链尾」）',
  rel2far.length >= 1 && rel2far.some((x) => x.node === 'rel-tail'),
  'd1=' + (rel2 && rel2.depth1Count) + ' d2=' + (rel2 && rel2.depth2Count)
  + ' far=' + rel2far.map((x) => x.node + '<-' + (x.via && x.via.node)).join(','));
check('depth 2 的二跳项带 via 指明经由谁（方向需靠 via 解读）',
  rel2far.length >= 1 && rel2far.every((x) => x.via && x.via.node && x.via.topic)
  && rel2far.some((x) => x.via.node === 'c'),
  JSON.stringify(rel2far[0] || null));
check('depth 2 不绕回自身',
  !!(rel2 && !rel2.items.some((x) => x.node === 'a')), 'items=' + (rel2 && rel2.items.map((x) => x.node).join(',')));
check('depth 2 的分层计数自洽',
  !!(rel2 && rel2.depth1Count + rel2.depth2Count === rel2.items.length),
  rel2 && (rel2.depth1Count + ' + ' + rel2.depth2Count + ' = ' + rel2.items.length));
check('depth 2 下 outCount/inCount 仍只统计一跳（直接引用数语义不变）',
  !!(rel1 && rel2 && rel2.outCount === rel1.outCount && rel2.inCount === rel1.inCount),
  'd1: ' + (rel1 && rel1.outCount) + '/' + (rel1 && rel1.inCount) + '  d2: ' + (rel2 && rel2.outCount) + '/' + (rel2 && rel2.inCount));
check('depth 非 1/2 的值退化为 1（不做无界展开）',
  (() => { try { const j = JSON.parse(run(['related', PROJ, 'a', '--json', '--depth', '9']).out); return j.depth === 1 && j.depth2Count === 0; } catch (e) { return false; } })());
run(['unlink', PROJ, 'a', '--to', PROJ, '--id', 'c']);
run(['unlink', PROJ, 'c', '--to', PROJ, '--id', 'rel-tail']);
run(['remove', PROJ, 'rel-tail']);   // 用后即删，不给后续断言留状态

/* ---------------- 8.8 内置 AI 通道（功能 1 后端）：ask（**只测 dry-run**） ----------------
 * 为什么只测 dry-run：真跑一次要**烧真实额度 + 依赖网络**（实测一次解释 ~24s）——
 * 那类验证属于"人工/可选"的层级（本工程的分层纪律：门禁里不做重活 ✗），
 * 而 dry-run 恰好把最该机械核对的东西留下来了：**将发给 AI 的提示词**。
 * 其中"情境被补齐"必须真判：路径为空这种缺陷（第一版 `pathTo` 返回 id 数组被当对象用过 ✗）
 * 在真跑时**看不出来**（模型照样能答），只有断言提示词里"路径不是空的"才抓得住 ✓ */
const askDry = run(['ask', PROJ, 'a', '--kind', 'explain', '--dry-run', '--json']);
const askDryJ = (() => { try { return JSON.parse(askDry.out); } catch (e) { return null; } })();
check('ask --dry-run：不调用模型（无 key 也能跑），并给出完整提示词与命令行',
  !!(askDryJ && askDryJ.ok && askDryJ.dryRun && askDryJ.prompt && askDryJ.command
    // 判**形状**不判个数（思考强度 patch 会让参数变多 ✓）：最后一个参数必须是提示词原文，
    // 且必须出现 `headless` 子命令（有 patch 时还要有 --patch）
    && askDryJ.command.args[askDryJ.command.args.length - 1] === askDryJ.prompt
    && askDryJ.command.args.indexOf('headless') > 0
    && (askDryJ.command.args.indexOf('--patch') < 0 || askDryJ.command.args.indexOf('--patch') < askDryJ.command.args.length - 1)),
  askDryJ ? ('提示词 ' + askDryJ.prompt.length + ' 字，命令行参数 ' + askDryJ.command.args.length + ' 个') : askDry.out.trim().slice(0, 160));
check('ask 的提示词**自动补齐了情境**：项目 / 树中路径 / 正文三者都不能空',
  !!(askDryJ && /· 项目：\S/.test(askDryJ.prompt) && /· 在树中的路径：\S/.test(askDryJ.prompt)
    && /· 节点正文/.test(askDryJ.prompt)),
  askDryJ ? (askDryJ.prompt.match(/· 在树中的路径：[^\n]*/) || ['(没有路径行)'])[0].slice(0, 80) : '—');
check('ask --kind ask 不给 --question ⇒ 非 0 且报错（不许发一个没有问题的"问题"）',
  (() => { const r = run(['ask', PROJ, 'a', '--kind', 'ask', '--dry-run']); return r.status !== 0 && /需要 --question/.test(r.err + r.out); })());
check('ask 节点不存在 ⇒ 非 0 且点名原因',
  (() => { const r = run(['ask', PROJ, 'no-such-node', '--dry-run']); return r.status !== 0 && /节点不存在/.test(r.err + r.out); })());

// 9.1.1 功能 5a 入口③：**项目级**提问（消息栏那条）—— 节点可选，情境里要告诉 AI"你能动手"
const askProj = run(['ask', PROJ, '--question', '把 D:\\某处\\一本书.md 导入成新项目', '--dry-run', '--json']);
const askProjJ = (() => { try { return JSON.parse(askProj.out); } catch (e) { return null; } })();
check('ask **项目级**（不给节点）：可用，且情境里说清"项目级 + 你能动手 + 具体命令"',
  !!(askProjJ && askProjJ.ok && /项目级/.test(askProjJ.prompt) && /可以动手/.test(askProjJ.prompt)
    && /import-project/.test(askProjJ.prompt) && /把 D:\\某处\\一本书\.md 导入成新项目/.test(askProjJ.prompt)),
  askProjJ ? ('提示词 ' + askProjJ.prompt.length + ' 字') : askProj.out.trim().slice(0, 140));
check('ask 项目级但**不给问题** ⇒ 非 0 且说明原因（不许发一个空问题出去）',
  (() => { const r = run(['ask', PROJ, '--dry-run']); return r.status !== 0 && /项目级提问要带/.test(r.err + r.out); })());

/* 9.1.3 多节点上下文（用户反馈④"把所有被框选的都给 AI 看"）：`--nodes a,b,c` ⇒ 情境逐个列出 ✓
 * 全离线（--dry-run）✓；节点不存在必须**响亮报错**（不许悄悄少给一个 ✗） */
const multiIds = (() => {
  const r = run(['list', PROJ, '--json']);
  try {
    const arr = JSON.parse(r.out);
    const flat = [];
    (function walk(ns) { (ns || []).forEach((n) => { flat.push(n.id); walk(n.children); }); })(Array.isArray(arr) ? arr : arr.nodes);
    return flat.slice(0, 3);
  } catch (e) { return []; }
})();
const askMulti = (() => {
  try { return JSON.parse(run(['ask', PROJ, '--nodes', multiIds.join(','), '--kind', 'explain', '--dry-run', '--json']).out); } catch (e) { return null; }
})();
check('ask 多节点（--nodes a,b,c）：情境里**逐个列出**并说明"放在一起看"（不是只答第一个 ✓）',
  !!(askMulti && askMulti.ok && multiIds.length >= 2
    && /多节点/.test(askMulti.prompt) && /选了 \*\*\d+ 个节点\*\*/.test(askMulti.prompt)
    && multiIds.every((id) => askMulti.prompt.indexOf(id) >= 0)
    && /【节点 1】/.test(askMulti.prompt) && /【节点 2】/.test(askMulti.prompt)),
  askMulti ? ('节点 ' + multiIds.join(',') + ' ⇒ 提示词 ' + askMulti.prompt.length + ' 字') : '—');
check('ask 多节点：其中有不存在的节点 ⇒ 非 0 且点名（不静默少给一个 ✗）',
  (() => { const r = run(['ask', PROJ, '--nodes', (multiIds[0] || 'x') + ',no-such-node', '--kind', 'explain', '--dry-run']); return r.status !== 0 && /节点不存在/.test(r.err + r.out); })());

/* 9.1.2 思考强度（用户反馈③"太慢"）：解释默认 low；显式 --effort 生效；patch 必须**三项写全**
 *（实测教训：patch 是整行替换，只写 reasoningEffort 会把 provider/model 抹掉 ✗）。
 * 这一段**全离线**（--dry-run + dump-config），不烧额度 ✓ */
const effLo = (() => { try { return JSON.parse(run(['ask', PROJ, 'a', '--kind', 'explain', '--dry-run', '--json']).out); } catch (e) { return null; } })();
check('ask 思考强度：解释**默认 low**（自动提速 ✓），且 patch 里 provider/model/reasoningEffort 三项齐全',
  !!(effLo && effLo.effort === 'low' && /provider:\s*\S/.test(effLo.effortPatch || '')
    && /model:\s*\S/.test(effLo.effortPatch || '') && /reasoningEffort:\s*low/.test(effLo.effortPatch || '')),
  effLo ? ('effort=' + effLo.effort + ' patch=' + String(effLo.effortPatch).split('\n').filter((l) => /provider:|model:|reasoningEffort:/.test(l)).join(' / ')) : '—');
const effHi = (() => { try { return JSON.parse(run(['ask', PROJ, 'a', '--kind', 'ask', '--question', 'x', '--effort', 'xhigh', '--dry-run', '--json']).out); } catch (e) { return null; } })();
check('ask 思考强度：显式 --effort xhigh 生效（对话栏那个下拉发的就是这个 ✓）',
  !!(effHi && effHi.effort === 'xhigh' && /reasoningEffort:\s*xhigh/.test(effHi.effortPatch || '')),
  effHi ? ('effort=' + effHi.effort) : '—');
check('ask 思考强度：未知取值 ⇒ 非 0 且列出可用值（不猜、不静默退回默认 ✗）',
  (() => { const r = run(['ask', PROJ, 'a', '--kind', 'explain', '--effort', 'turbo', '--dry-run']); return r.status !== 0 && /未知的思考强度/.test(r.err + r.out) && /low \/ medium/.test(r.err + r.out); })());

// 8.7 mentions --cross：跨项目「未链接提及」两个方向。
// 用一个**临时第二项目**做对端，绝不触碰 comnet（真实数据）。
const XPROJ = PROJ + '-x';
const XP_DIR = path.join(ROOT, 'projects', XPROJ);
run(['init', XPROJ, '--title', '跨项目探针']);
run(['add', XPROJ, 'root', '--topic', '外部专有主题', '--id', 'x1']);
run(['add', XPROJ, 'root', '--topic', '朝内提及者', '--id', 'x2']);
run(['add', PROJ, 'root', '--topic', '朝外提及者', '--id', 'cross-out']);
run(['edit', PROJ, 'cross-out', '--detail-md', '正文里提到了 外部专有主题 这个词']);
run(['edit', XPROJ, 'x2', '--detail-md', '这里提到了 朝外提及者 这个词']);
const cxJson = (() => {
  try { return JSON.parse(run(['mentions', PROJ, '--json', '--cross', '--limit', '500']).out); }
  catch (e) { return null; }
})();
const cxItems = (cxJson && cxJson.items) || [];
check('mentions --cross 报出 out 方向（本项目正文提到外部节点）',
  cxItems.some((x) => x.direction === 'out' && x.fromProject === PROJ && x.from === 'cross-out'
    && x.toProject === XPROJ && x.to === 'x1'),
  JSON.stringify(cxItems.filter((x) => x.direction === 'out').slice(0, 3)));
check('mentions --cross 报出 in 方向（外部正文提到本项目节点）',
  cxItems.some((x) => x.direction === 'in' && x.fromProject === XPROJ && x.from === 'x2'
    && x.toProject === PROJ && x.to === 'cross-out'),
  JSON.stringify(cxItems.filter((x) => x.direction === 'in').slice(0, 3)));
check('mentions --cross 的 outCount/inCount 与 items 一致',
  !!cxJson && cxJson.crossOut === cxItems.filter((x) => x.direction === 'out').length
  && cxJson.crossIn === cxItems.filter((x) => x.direction === 'in').length
  && cxJson.mentions === cxItems.length,
  cxJson && ('out=' + cxJson.crossOut + ' in=' + cxJson.crossIn + ' total=' + cxJson.mentions));
// direction 契约（src/mentions.js，单测已锁定）：本项目内项 = 'same'，跨项目 = 'out'/'in'。
// （曾断言"每项都是 out|in"，与该契约自相矛盾 —— 本项目内项被报成"缺 direction"，
//   实则带着 'same'。此处按契约逐项核对，并让三个计数字段与 items 互相印证。）
check('mentions --cross 的 items 每项都带 direction（本项目内项为 same，跨项目为 out/in）',
  cxItems.length > 0
  && cxItems.every((x) => x.direction === 'out' || x.direction === 'in' || x.direction === 'same')
  && cxItems.filter((x) => x.direction === 'same').length === cxJson.sameProject
  && cxItems.filter((x) => x.direction === 'out').length === cxJson.crossOut
  && cxItems.filter((x) => x.direction === 'in').length === cxJson.crossIn,
  '缺 direction 的项数=' + cxItems.filter((x) => !x.direction).length
  + ' same=' + cxItems.filter((x) => x.direction === 'same').length
  + ' out=' + cxItems.filter((x) => x.direction === 'out').length
  + ' in=' + cxItems.filter((x) => x.direction === 'in').length);
check('mentions 不加 --cross 时不报跨项目项',
  (() => {
    try {
      const j = JSON.parse(run(['mentions', PROJ, '--json', '--limit', '500']).out);
      return j.items.every((x) => x.toProject === undefined) && j.crossOut === 0 && j.crossIn === 0;
    } catch (e) { return false; }
  })());
// 已声明的跨项目链接后不应再报（跨项目也必须拼 project 比对）
run(['link', PROJ, 'cross-out', '--to', XPROJ, '--id', 'x1']);
check('--cross 下已声明的跨项目链接不再报为漏链',
  (() => {
    try {
      const j = JSON.parse(run(['mentions', PROJ, '--json', '--cross', '--limit', '500']).out);
      return !j.items.some((x) => x.direction === 'out' && x.toProject === XPROJ && x.to === 'x1');
    } catch (e) { return false; }
  })());
run(['unlink', PROJ, 'cross-out', '--to', XPROJ, '--id', 'x1']);
run(['remove', PROJ, 'cross-out']);

// 9. import-md
const MD = path.join(TMP, 'in.md');
fs.writeFileSync(MD, '# 主题\n## 子题\n正文并入详情\n', 'utf8');
r = run(['import-md', PROJ, MD]);
check('import-md', ok(r.out) && /导入完成/.test(r.out), r.out.trim());

/* 9.1 功能 5a：大文档 → **新项目 + 新树**（md / txt / docx 三种前端走同一个建树入口）
 * ⚠️ 数据落在哪：本夹具**故意在真实 `projects/` 下**造探针项目（见文件头 42 行的说明：
 *   store 与 CLI 同源，不另设根）——**不是**沙箱副本 ✗。所以清理必须用 `ROOT/projects/<名字>`，
 *   写成临时目录就会留下垃圾（我第一版就这么错的：下次运行变成"项目已存在"的假红 ✗）。
 * 重点核对三件：① 一个文件里的多个 1 级标题 ⇒ **多个顶层主题**（"几本书 ⇒ 几棵树"）；
 *              ② 真的能读回来且过校验（不是只写了个文件）；③ 认不出的格式要**响亮拒绝**。 */
const IMP_A = path.join(ROOT, 'projects', 'imp-probe-a');
// 先清后建（幂等）：跑红/中断/注入实验**都会**留下探针，清了才不会变成下一次的假红 ✓。
// 按**前缀**清（不只清 a）：判别力证明那次注入让 dry-run 真写盘 ⇒ 多留了一个 imp-probe-b，
// 于是下一轮这里变成"项目已存在"的假红 ✗（自己踩的，记在注释里免得再犯）。
try {
  for (const e of fs.readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })) {
    if (e.isDirectory() && e.name.indexOf('imp-probe-') === 0) {
      fs.rmSync(path.join(ROOT, 'projects', e.name), { recursive: true, force: true });
    }
  }
} catch (err) { /* projects/ 不存在：后面会自己建 */ }
const BIGMD = path.join(TMP, 'big.md');
fs.writeFileSync(BIGMD, '# 计算机网络（自顶向下方法）\n\n## 第 1 章 概述\n内容\n\n# 数据结构与算法\n\n## 第 1 章 绪论\n内容\n', 'utf8');
const d1 = run(['import-project', 'imp-probe-a', BIGMD, '--dry-run', '--json']);
const d1j = (() => { try { return JSON.parse(d1.out); } catch (e) { return null; } })();
check('import-project --dry-run（md）：不写盘，且报告"2 个顶层主题"（一个文件里两本书 ⇒ 两棵树）',
  !!(d1j && d1j.ok && d1j.dryRun && d1j.themes === 2 && d1j.format === 'md'
    && !fs.existsSync(path.join(TMP, 'imp-probe-a', 'imp-probe-a.json'))),
  d1j ? ('格式=' + d1j.format + ' 顶层主题=' + d1j.themes + ' 节点=' + d1j.nodes + ' 写盘=' + fs.existsSync(path.join(TMP, 'imp-probe-a'))) : d1.out.trim().slice(0, 140));

r = run(['import-project', 'imp-probe-a', BIGMD]);
check('import-project 真写：项目落地 + 标题取第一个顶层主题', ok(r.out) && /已从 big\.md/.test(r.out) && /2 个顶层主题/.test(r.out), r.out.trim());
const rd = run(['read', 'imp-probe-a', '--brief']);
check('import-project 写出来的项目**能读回来**且顶层主题两棵',
  ok(rd.out) && /计算机网络（自顶向下方法）/.test(rd.out) && /数据结构与算法/.test(rd.out),
  rd.out.split('\n').slice(0, 3).join(' | ').slice(0, 120));
check('import-project 写出来的项目**过校验**（不是只写了个文件）',
  ok(run(['validate', 'imp-probe-a']).out) || ok(run(['validate-all']).out), '');
fs.rmSync(IMP_A, { recursive: true, force: true });
check('import-project 收尾：探针项目已清掉（不给下一次运行留"项目已存在"的假红）', !fs.existsSync(IMP_A), '');

const BIGTXT = path.join(TMP, 'big.txt');
fs.writeFileSync(BIGTXT, '第一章 绪论\n\n这一章介绍结构，句子较长。\n\n1.1 研究背景\n\n背景说明，带逗号与句号。\n\n第二章 方法\n\n正文。\n', 'utf8');
const d2 = (() => { try { return JSON.parse(run(['import-project', 'imp-probe-b', BIGTXT, '--dry-run', '--json']).out); } catch (e) { return null; } })();
check('import-project（txt）：启发式把"第X章"识别为 1 级 ⇒ 两个顶层主题，正文行原样保留',
  !!(d2 && d2.themes === 2 && d2.stats.levelCounts['1'] === 2 && d2.stats.levelCounts['2'] === 1),
  d2 ? ('顶层主题=' + d2.themes + ' 层级=' + JSON.stringify(d2.stats.levelCounts)) : '—');

const BIGBAD = path.join(TMP, 'big.pdf');
fs.writeFileSync(BIGBAD, '%PDF-1.4\n', 'utf8');
check('import-project 遇到 .pdf ⇒ **响亮拒绝**并指向 5b（不许当文本读进去 ✗）',
  (() => { const r3 = run(['import-project', 'imp-probe-c', BIGBAD]); return r3.status !== 0 && /暂不支持 \.pdf/.test(r3.err + r3.out) && /5b/.test(r3.err + r3.out); })());
check('import-project 项目名已存在 ⇒ 非 0 且点名（不许覆盖已有项目）',
  (() => { const r4 = run(['import-project', PROJ, BIGMD]); return r4.status !== 0 && /项目已存在/.test(r4.err + r4.out); })());

// 10. add-file 附件 → export-md 文件夹导出（md + 附件复制 + 相对链接）
const ATT = path.join(TMP, 'note.md');
fs.writeFileSync(ATT, '# 附件笔记\n', 'utf8');
r = run(['add-file', PROJ, 'b', '--file', ATT, '--caption', '附件说明']);
check('add-file', ok(r.out) && /已添加附件/.test(r.out), r.out.trim());
r = run(['files', PROJ, '--json']);
let filesList = [];
try { filesList = JSON.parse(r.out).files || []; } catch (e) {}
check('files', ok(r.out) && filesList.length === 1, r.out.trim());
const fRel = filesList.length ? filesList[0].file : null;
const EXPORT_DIR = path.join(TMP, 'export');
r = run(['export-md', PROJ, EXPORT_DIR, '--with-detail']);
const mdOut = path.join(EXPORT_DIR, PROJ + '.md');
const mdOutText = fs.existsSync(mdOut) ? fs.readFileSync(mdOut, 'utf8') : '';
check('export-md 文件夹',
  ok(r.out) && fs.existsSync(mdOut) && mdOutText.includes('主题')
  && (!fRel || (fs.existsSync(path.join(EXPORT_DIR, 'attachments', path.basename(fRel))) && mdOutText.includes('attachments/'))),
  r.out.trim());

// 11. export-json / import-json roundtrip（图片+附件解包）
r = run(['export-json', PROJ, OUT_JSON]);
const exportJsonOk = ok(r.out) && /已导出/.test(r.out);
check('export-json', exportJsonOk, r.out.trim());
const PROJ2 = PROJ + '-copy';
r = run(['import-json', OUT_JSON, '--name', PROJ2]);
check('import-json', ok(r.out) && /已导入/.test(r.out), r.out.trim());
r = run(['validate', PROJ2]);
check('import 后 validate', ok(r.out));
r = run(['files', PROJ2, '--json']);
let files2 = [];
try { files2 = JSON.parse(r.out).files || []; } catch (e) {}
check('import 后附件保留', ok(r.out) && files2.length === 1, r.out.trim());
if (fRel) {
  check('import 后附件文件解包', fs.existsSync(path.join(ROOT, 'projects', PROJ2, fRel)), fRel);
}

// 11.5 export-html：静态站点（index.html + 资源复制）
const SITE = path.join(TMP, 'site');
r = run(['export-html', PROJ, SITE]);
check('export-html 生成静态站点', ok(r.out) && /已导出静态站点/.test(r.out), r.out.trim());
const siteIndex = path.join(SITE, 'index.html');
check('export-html 产出 index.html',
  fs.existsSync(siteIndex) && fs.readFileSync(siteIndex, 'utf8').indexOf('<!doctype html>') === 0,
  fs.existsSync(siteIndex) ? fs.statSync(siteIndex).size + ' 字节' : '不存在');
const siteHtml = fs.existsSync(siteIndex) ? fs.readFileSync(siteIndex, 'utf8') : '';
check('export-html 内嵌模型含全部节点',
  (() => {
    const m = /<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(siteHtml);
    if (!m) return false;
    try {
      const model = JSON.parse(m[1]);
      const live = JSON.parse(run(['list', PROJ, '--json']).out).nodes.length;
      return model.nodes.length === live;
    } catch (e) { return false; }
  })());
// 资源必须真的复制到位：模型里引用的每个图片/附件路径都要在输出目录里存在，
// 否则分享出去的站点会出现"图挂了"。这条比"命令没报错"有意义得多。
check('export-html 把模型引用的全部资源复制到输出目录',
  (() => {
    const m = /<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(siteHtml);
    if (!m) return false;
    let model;
    try { model = JSON.parse(m[1]); } catch (e) { return false; }
    const refs = [];
    model.nodes.forEach((n) => {
      (n.images || []).forEach((i) => refs.push(i.file));
      (n.files || []).forEach((f) => refs.push(f.file));
    });
    if (!refs.length) return true;                       // 本项目无资源则无需复制
    const missing = refs.filter((rel) => !fs.existsSync(path.join(SITE, rel)));
    return missing.length === 0;
  })(), '缺失=' + (() => {
    try {
      const model = JSON.parse(/<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(siteHtml)[1]);
      const refs = [];
      model.nodes.forEach((n) => { (n.images || []).forEach((i) => refs.push(i.file)); (n.files || []).forEach((f) => refs.push(f.file)); });
      return refs.filter((rel) => !fs.existsSync(path.join(SITE, rel))).join(',') || '无';
    } catch (e) { return 'n/a'; }
  })());
check('export-html 页面脚本语法可编译（否则站点白屏）',
  (() => {
    const all = [...siteHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    if (!all.length) return false;
    try { new Function(all[all.length - 1][1]); return true; } catch (e) { return false; }
  })());
// 注意：CSP 的指令**顺序**不固定，故逐项独立检查，不要用一个假设顺序的大正则
//（第一版就是那么写的，结果因 img-src 排在 connect-src 之前而误报失败）。
check('export-html 带 CSP（阻断远程加载/回传，同时放行本地图片与内联脚本）',
  (() => {
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(siteHtml);
    if (!m) return false;
    const csp = m[1];
    return ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'",
      "img-src 'self' data:", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'"]
      .every((tok) => csp.indexOf(tok) >= 0);
  })(), (() => {
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(siteHtml);
    return m ? m[1].slice(0, 90) : '未找到 CSP';
  })());

// 12. assets / add-image / remove-image
const PNG = path.join(TMP, 't.png');
fs.writeFileSync(PNG, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')); // 最小 png 头
r = run(['add-image', PROJ, 'b', '--file', PNG, '--caption', '测试图']);
const addImgOk = ok(r.out) && /已添加图片/.test(r.out);
check('add-image', addImgOk, r.out.trim());
r = run(['assets', PROJ, '--json']);
check('assets', ok(r.out) && r.out.includes('测试图'));
const imgFile = (() => { try { return JSON.parse(r.out).images[0].file; } catch (e) { return null; } })();
if (imgFile) {
  r = run(['remove-image', PROJ, 'b', imgFile]);
  check('remove-image', ok(r.out) && /已移除/.test(r.out));
} else check('remove-image', false, '未取到图片路径');

// 13. remove-file
if (fRel) {
  r = run(['remove-file', PROJ, 'b', fRel]);
  check('remove-file', ok(r.out) && /已移除/.test(r.out), r.out.trim());
} else check('remove-file', false, '未取到附件路径');

// 14. validate / validate-all
r = run(['validate', PROJ]);
check('validate', ok(r.out));
r = run(['validate-all']);
check('validate-all', ok(r.out));

// 15. projects
r = run(['projects']);
check('projects', ok(r.out) && r.out.includes(PROJ));

// 16. 路径穿越防御：import-json 拒绝 ../ 资源路径
const EVIL = path.join(TMP, 'evil.json');
fs.writeFileSync(EVIL, JSON.stringify({ aimapVersion: 1, meta: { name: 'evil' }, format: 'node_tree', data: { id: 'root', topic: 'x', children: [] }, assets: { '../../evil.txt': 'aGk=' } }));
r = run(['import-json', EVIL, '--name', 'evil-probe']);
check('路径穿越被拒', !ok(r.out) && /非法资源路径/.test(r.out), r.out.trim());

// 17. 环数据 validate 拒绝（构造内存环 JSON 时 stringify 会抛错，这里验证 CLI 对坏 JSON 的容错）
fs.writeFileSync(EVIL, '{"broken"');
r = run(['import-json', EVIL]);
check('坏 JSON 被拒', !ok(r.out));

// 18. 失败契约：退出码必须是可靠判据（此前失败也返回 0，只能靠匹配 error: 前缀）
r = run(['get', PROJ, 'no-such-node-id']);
check('失败命令返回非 0 退出码', !ok(r.out) && r.code !== 0 && /^error:/.test(r.out.trim()),
  'exit=' + r.code + ' out=' + r.out.trim().slice(0, 60));
r = run(['projects']);
check('成功命令返回 0 退出码', ok(r.out) && r.code === 0, 'exit=' + r.code);
r = run(['no-such-command']);
check('未知命令返回非 0 退出码', !ok(r.out) && r.code !== 0, 'exit=' + r.code);
// 坏数据上 validate --json 也必须非 0（此前 --json 分支不设退出码，是真实的不一致）
const BADVAL = path.join(TMP, 'bad-validate.json');
fs.writeFileSync(BADVAL, JSON.stringify({ format: 'node_tree', data: { id: 'root', topic: 'x', children: [] } }));
r = run(['validate', BADVAL, '--json']);
let badJson = null;
try { badJson = JSON.parse(r.out); } catch (e) {}
check('validate --json 坏数据：JSON 报告 + 非 0 退出码',
  !!badJson && badJson.ok === false && r.code !== 0, 'exit=' + r.code + ' ok=' + (badJson && badJson.ok));
// 全局不变量：本次全部命令调用中，没有一次"报错却返回成功"
check('失败契约全局一致（error: 前缀 ⇒ 非 0 退出码）',
  contractViolations.length === 0, contractViolations.join('; ') || '本次调用的每条命令均一致');

// 19. 关联笔记（N 元实体）：assoc-add / list / edit / remove
//     它的存在理由是把"若干节点的关联"当成一个对象（而不是散在 links 上）——
//     故这里重点验证：多方成员、可从任一成员检索、编辑后落盘为 HTML、删除干净。
r = run(['assoc-add', PROJ, '--members', 'a,b', '--title', '甲乙关联', '--note-md', '**重点**：甲先于乙', '--id', 'as-it-1']);
check('assoc-add 新增关联', ok(r.out) && /已新增关联/.test(r.out), r.out.trim());
const asList = (() => {
  try { return JSON.parse(run(['assoc-list', PROJ, '--json']).out); } catch (e) { return null; }
})();
check('assoc-list 返回结构与解析后的成员标题',
  !!asList && asList.count === 1 && asList.items[0].members.length === 2
  && asList.items[0].members.every((m) => !!m.topic) && asList.items[0].hasNote === true,
  JSON.stringify(asList && { count: asList.count, members: asList.items[0].members.map((m) => m.label) }));
check('assoc-add --note-md 落盘为 HTML（与 detail 同约定）',
  !!asList && /<strong>重点<\/strong>/.test(asList.items[0].note), (asList && asList.items[0].note || '').slice(0, 80));
// 多者的关键性质：**任一成员**都能检索到同一篇关联
check('assoc-list --node 从任一成员都能找到（N 元的实际意义）',
  (() => {
    const a = JSON.parse(run(['assoc-list', PROJ, '--node', 'a', '--json']).out);
    const b = JSON.parse(run(['assoc-list', PROJ, '--node', 'b', '--json']).out);
    const none = JSON.parse(run(['assoc-list', PROJ, '--node', 'root', '--json']).out);
    return a.count === 1 && b.count === 1 && none.count === 0;
  })());
// --raw 只给契约字段（渲染层据此同步内存；多了派生字段就会污染数据文件）
check('assoc-list --raw 的实体只含契约字段',
  (() => {
    const j = JSON.parse(run(['assoc-list', PROJ, '--json', '--raw']).out);
    const raw = (j.raw || [])[0] || {};
    const extra = Object.keys(raw).filter((k) => ['id', 'title', 'members', 'note'].indexOf(k) < 0);
    const mExtra = raw.members && raw.members[0] ? Object.keys(raw.members[0]).filter((k) => ['project', 'id'].indexOf(k) < 0) : [];
    return extra.length === 0 && mExtra.length === 0;
  })());
r = run(['assoc-edit', PROJ, 'as-it-1', '--members', 'a,b,c', '--title', '甲乙丙关联']);
check('assoc-edit 改成员与标题', ok(r.out) && /已更新关联/.test(r.out), r.out.trim());
check('assoc-edit 后成员变为 3 方',
  (() => { const j = JSON.parse(run(['assoc-list', PROJ, '--json']).out); return j.items[0].members.length === 3; })());
r = run(['assoc-edit', PROJ, 'as-it-1', '--clear-note']);
check('assoc-edit --clear-note 清空笔记',
  ok(r.out) && (() => { const j = JSON.parse(run(['assoc-list', PROJ, '--json']).out); return j.items[0].hasNote === false; })());
// 错误分支
r = run(['assoc-add', PROJ, '--members', 'a']);
check('assoc-add 单成员被拒（关联至少两方）', !ok(r.out) && /至少需要 2 个/.test(r.out), r.out.trim());
r = run(['assoc-add', PROJ, '--members', 'a,ghost-node']);
check('assoc-add 成员不存在被拒（不造悬挂关联）', !ok(r.out) && /节点不存在/.test(r.out), r.out.trim());
r = run(['assoc-add', PROJ, '--members', 'a,BAD_ID']);
check('assoc-add 成员 id 不合规范被拒', !ok(r.out) && /不合规范/.test(r.out), r.out.trim());
r = run(['assoc-edit', PROJ, 'as-it-1', '--note', '<p>x</p>', '--note-md', 'y']);
check('assoc-edit 的 --note 与 --note-md 互斥', !ok(r.out) && /不能同时使用/.test(r.out), r.out.trim());
r = run(['assoc-remove', PROJ, 'no-such-assoc']);
check('assoc-remove 不存在的关联被拒', !ok(r.out) && /关联不存在/.test(r.out), r.out.trim());
// 数据契约：validate 通过（assoc 合法时），并在**悬挂成员**上报错
check('带 assoc 的项目 validate 通过', ok(run(['validate', PROJ]).out));
r = run(['assoc-remove', PROJ, 'as-it-1']);
check('assoc-remove 移除成功', ok(r.out) && /已移除关联/.test(r.out), r.out.trim());
check('删空后项目里不再留 assoc 键（与旧格式完全一致，无空数组噪音）',
  (() => {
    const f = path.join(ROOT, 'projects', PROJ, PROJ + '.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return d.assoc === undefined;
  })());
// export-json / import-json 必须带上 assoc（文档承诺它是无损备份路径）
run(['assoc-add', PROJ, '--members', 'a,b', '--note-md', '往返探针', '--id', 'as-rt']);
const OUT_JSON2 = path.join(TMP, 'assoc-out.aimap.json');
r = run(['export-json', PROJ, OUT_JSON2]);
check('export-json 导出的包里含 assoc',
  ok(r.out) && (() => { const b = JSON.parse(fs.readFileSync(OUT_JSON2, 'utf8')); return Array.isArray(b.assoc) && b.assoc.length === 1; })());
const PROJ3 = PROJ + '-assoc';
r = run(['import-json', OUT_JSON2, '--name', PROJ3]);
check('import-json 还原 assoc（无损往返）',
  ok(r.out) && (() => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects', PROJ3, PROJ3 + '.json'), 'utf8'));
    return Array.isArray(d.assoc) && d.assoc.length === 1 && /往返探针/.test(d.assoc[0].note);
  })(), r.out.trim());
check('导入后 validate 通过（assoc 成员在新项目里仍可解析）', ok(run(['validate', PROJ3]).out));
// 悬挂关联成员：手工塞一个指向不存在节点的成员，validate 必须报错
check('悬挂关联成员被 validate 拒绝', (() => {
  const f = path.join(ROOT, 'projects', PROJ3, PROJ3 + '.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.assoc[0].members[0].id = 'gone-node';
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
  const out = run(['validate', PROJ3]);
  return !ok(out.out) && /悬挂关联成员/.test(out.out);
})());

/* ---------------- 20. 关联笔记 ×「删节点」：悬挂成员的清理与备份恢复 ----------------
 * 这一节的三个漏洞都是**实测**出来的，共同点是"闸门读的是磁盘旧态"或"没有清理路径"：
 *   ① 删掉被关联引用的节点后，validate 判红 → 其后该项目**所有**写命令都被挡住
 *      （project:save 也是校验闸门）→ 项目被锁死，而界面没有改成员的入口。
 *   ② 恢复备份：删除项目后导入它自己的备份，会因为备份里指向**本项目**的链接被判
 *      "项目不存在"而拒绝 → 备份形同废纸。
 *   ③ 界面的保存闸门校验的是"待写数据"的临时文件，必须按**待写数据**判同项目成员，
 *      否则第一次保存放行、第二次才突然被拒（用户完全看不懂）。
 */
const PROJ4 = PROJ + '-prune';
const PROJ5 = PROJ + '-restore';
const projJson = (name) => path.join(ROOT, 'projects', name, name + '.json');
const readProj = (name) => JSON.parse(fs.readFileSync(projJson(name), 'utf8'));

run(['init', PROJ4, '--title', '清理探针']);
['a', 'b', 'c'].forEach((id) => run(['add', PROJ4, 'root', '--topic', id.toUpperCase(), '--id', id]));
run(['assoc-add', PROJ4, '--members', 'a,b,c', '--id', 'as-prune', '--title', '三元']);
run(['assoc-add', PROJ4, '--members', 'a,b', '--id', 'as-drop', '--title', '两元']);

// ① 删被引用的节点：默认拒执行（不是警告后照删 —— 照删就会把项目锁死）
r = run(['remove', PROJ4, 'a']);
check('删被关联引用的节点默认被拒，且给出两条出路',
  !ok(r.out) && /关联笔记引用/.test(r.out) && /--clean-assoc/.test(r.out) && /assoc-prune/.test(r.out),
  r.out.trim().split('\n')[0]);
check('被拒后**什么都没写**（节点仍在，未造出悬挂成员）',
  readProj(PROJ4).data.children.some((n) => n.id === 'a') && ok(run(['validate', PROJ4]).out));

// --clean-assoc：同步剪掉引用；只剩一个成员的关联整篇删除
r = run(['remove', PROJ4, 'a', '--clean-assoc']);
check('remove --clean-assoc 同步清理被引用的成员',
  ok(r.out) && /已同步清理关联/.test(r.out) && /已删除/.test(r.out), r.out.trim().replace(/\n/g, ' | '));
check('三元关联少一个成员仍保留（N 元语义）',
  (() => { const a = readProj(PROJ4).assoc || []; return a.length === 1 && a[0].id === 'as-prune' && a[0].members.length === 2; })());
check('清理后 validate 立刻通过（项目不会被锁死）', ok(run(['validate', PROJ4]).out));

// assoc-prune --dry-run：只报告不写盘
r = run(['assoc-prune', PROJ4, '--nodes', 'b', '--dry-run']);
check('assoc-prune --dry-run 只报告不写盘',
  ok(r.out) && /dry-run/.test(r.out) && (readProj(PROJ4).assoc[0].members.length === 2), r.out.trim().replace(/\n/g, ' | '));

// assoc-prune 自动模式：找出"确认不存在"的成员并清掉
(() => {
  const d = readProj(PROJ4);
  d.assoc[0].members.push({ project: PROJ4, id: 'ghost-node' });
  fs.writeFileSync(projJson(PROJ4), JSON.stringify(d, null, 2));
})();
check('注入悬挂成员后 validate 判红（前置条件成立）', !ok(run(['validate', PROJ4]).out));
r = run(['assoc-prune', PROJ4]);
check('assoc-prune 自动清理悬挂成员并恢复校验绿',
  ok(r.out) && /发现悬挂成员/.test(r.out) && /已清理/.test(r.out) && ok(run(['validate', PROJ4]).out),
  r.out.trim().replace(/\n/g, ' | '));

// "采不到真值 = 红"：成员所在项目**读不出来**时不许猜成"不存在"而去清理
const BROKEN_PROJ = 'it-broken-' + Date.now().toString(36);
fs.mkdirSync(path.join(ROOT, 'projects', BROKEN_PROJ), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'projects', BROKEN_PROJ, BROKEN_PROJ + '.json'), '{ 这不是合法 JSON', 'utf8');
(() => {
  const d = readProj(PROJ4);
  d.assoc[0].members.push({ project: BROKEN_PROJ, id: 'x' });
  fs.writeFileSync(projJson(PROJ4), JSON.stringify(d, null, 2));
})();
r = run(['assoc-prune', PROJ4, '--dry-run']);
check('项目读不出来时不当作悬空清理，而是明确警告（不猜真值）',
  ok(r.out) && /读不出来/.test(r.out) && /没有悬挂成员/.test(r.out)
  && readProj(PROJ4).assoc[0].members.some((m) => m.project === BROKEN_PROJ),
  r.out.trim().replace(/\n/g, ' | '));

// ② 备份恢复：删除项目后导入它自己的备份必须成功（同项目链接/关联按**待写数据**判）
run(['init', PROJ5, '--title', '恢复探针']);
['n1', 'n2'].forEach((id) => run(['add', PROJ5, 'root', '--topic', id.toUpperCase(), '--id', id]));
run(['link', PROJ5, 'n1', '--to', PROJ5, '--id', 'n2', '--caption', '同项目链接']);
run(['assoc-add', PROJ5, '--members', 'n1,n2', '--id', 'as-rt2', '--title', '往返']);
const OUT5 = path.join(TMP, 'restore.aimap.json');
run(['export-json', PROJ5, OUT5]);
check('备份包内含同项目链接与 assoc（前置条件成立）', (() => {
  const b = JSON.parse(fs.readFileSync(OUT5, 'utf8'));
  return Array.isArray(b.assoc) && b.assoc.length === 1 && JSON.stringify(b).indexOf('"caption":"同项目链接"') >= 0;
})());
fs.rmSync(path.join(ROOT, 'projects', PROJ5), { recursive: true, force: true });
r = run(['import-json', OUT5, '--name', PROJ5]);
check('删除项目后能导入它自己的备份（修复"备份无法恢复"）',
  ok(r.out) && /已导入/.test(r.out), r.out.trim());
check('恢复后同项目链接与 assoc 都还在，且 validate 通过',
  (() => {
    const d = readProj(PROJ5);
    const flat = [];
    (function w(n) { if (!n) return; flat.push(n); (n.children || []).forEach(w); })(d.data);
    const n1 = flat.find((x) => x.id === 'n1');
    return !!(n1 && n1.links && n1.links.length === 1) && (d.assoc || []).length === 1 && ok(run(['validate', PROJ5]).out);
  })());
// 但**真**悬挂仍必须被拒（放宽 selfProject 不能放过真错误）
check('导入含真悬挂链接的备份仍被拒绝', (() => {
  const b = JSON.parse(fs.readFileSync(OUT5, 'utf8'));
  b.data.children[0].links.push({ project: PROJ5, id: 'ghost', caption: '坏' });
  const bad = path.join(TMP, 'restore-bad.aimap.json');
  fs.writeFileSync(bad, JSON.stringify(b, null, 2));
  const out = run(['import-json', bad, '--name', PROJ5 + '-bad']);
  return !ok(out.out) && /悬挂链接/.test(out.out);
})());

// ③ 界面保存闸门：校验的是"待写数据"的临时文件 → 必须按待写数据判同项目成员
//    模拟 main.js 的 project:save：先落临时文件，再 `validate <临时文件>`。
check('保存闸门按**待写数据**判悬挂成员（界面删节点后第一次保存就会被拦）', (() => {
  const d = readProj(PROJ5);
  // 待写数据里删掉 n2（磁盘上仍在，正是"闸门慢一步"的场景）
  d.data.children = d.data.children.filter((n) => n.id !== 'n2');
  const probe = projJson(PROJ5) + '.99999.validate';
  fs.writeFileSync(probe, JSON.stringify(d, null, 2));
  const out = run(['validate', probe]);
  fs.unlinkSync(probe);
  return !ok(out.out) && /悬挂关联成员/.test(out.out);
})());
// 同一个磁盘文件（节点还在）仍然校验通过 —— 证明差异来自"按待写数据判"，不是误报
check('对照：未删节点的磁盘文件仍校验通过（差异确实来自按待写数据判）', ok(run(['validate', PROJ5]).out));

// MCP 侧不能有"AI 修不了"的缺口：remove_node 要能带 clean_assoc，且必须有 assoc_prune
check('MCP 暴露 assoc_prune（AI 删节点后能自救）且 remove_node 支持 clean_assoc', (() => {
  const { TOOLS } = require(path.join(ROOT, 'scripts', 'mcp-server.js'));
  const prune = TOOLS.find((t) => t.name === 'assoc_prune');
  const rm = TOOLS.find((t) => t.name === 'remove_node');
  return !!prune && !!rm && !!rm.inputSchema.properties.clean_assoc
    && (rm.inputSchema.properties.clean_assoc.type === 'boolean');
})());

/* ---------------- 21. 链接 ×「删节点」：同项目清理与跨项目锁死自救 ----------------
 * 与 20 节同源的问题：**链接可以指向别的项目**，所以删节点会让"别人家"的项目悬空。
 * 而 validate 是写盘闸门 → 被判红的项目**所有**写操作都被挡住，界面又没有删链接入口。
 * 故 links-prune 是"能不能自救"的关键；本节把两条路都钉住。
 */
const PROJ6 = PROJ + '-link';
const PROJ7 = PROJ + '-link2';
run(['init', PROJ6, '--title', '链接探针甲']);
run(['init', PROJ7, '--title', '链接探针乙']);
['x', 'y', 'z'].forEach((id) => run(['add', PROJ6, 'root', '--topic', id.toUpperCase(), '--id', id]));
run(['add', PROJ7, 'root', '--topic', 'W', '--id', 'w']);
run(['link', PROJ6, 'x', '--to', PROJ6, '--id', 'z', '--caption', '同项目']);
run(['link', PROJ6, 'y', '--to', PROJ7, '--id', 'w', '--caption', '跨项目']);

// 同项目：删被链接指向的节点，默认拒执行并指出 --clean-links
r = run(['remove', PROJ6, 'z']);
check('删被链接指向的节点默认被拒，并给出 --clean-links',
  !ok(r.out) && /链接指向它/.test(r.out) && /--clean-links/.test(r.out), r.out.trim().split('\n')[0]);
check('被拒后什么都没写（节点仍在，链接未变）',
  readProj(PROJ6).data.children.some((n) => n.id === 'z') && ok(run(['validate', PROJ6]).out));
r = run(['remove', PROJ6, 'z', '--clean-links']);
check('remove --clean-links 同步清理指向它的链接',
  ok(r.out) && /已同步清理链接/.test(r.out) && ok(run(['validate', PROJ6]).out), r.out.trim().replace(/\n/g, ' | '));
check('清理后那个节点上不再留 links 键（无空数组噪音）', (() => {
  const flat = [];
  (function w(n) { if (!n) return; flat.push(n); (n.children || []).forEach(w); })(readProj(PROJ6).data);
  const x = flat.find((n) => n.id === 'x');
  return x && x.links === undefined;
})());

// 跨项目：对方删掉被指向的节点 → 本项目悬空被锁 → **用 links-prune 自救**
run(['remove', PROJ7, 'w']);
check('跨项目目标被删后，本项目 validate 判红（前置条件成立）',
  !ok(run(['validate', PROJ6]).out) && /悬挂链接/.test(run(['validate', PROJ6]).out));
check('此时本项目的写操作被闸门挡住（这就是"锁死"）',
  !ok(run(['add', PROJ6, 'root', '--topic', '新', '--id', 'new1']).out));
r = run(['links-prune', PROJ6, '--dry-run']);
check('links-prune --dry-run 报告悬空链接但不写盘',
  ok(r.out) && /发现悬挂链接/.test(r.out) && /dry-run/.test(r.out) && !ok(run(['validate', PROJ6]).out),
  r.out.trim().replace(/\n/g, ' | '));
r = run(['links-prune', PROJ6]);
check('links-prune 清掉悬空链接，项目解锁',
  ok(r.out) && /已删除链接/.test(r.out) && ok(run(['validate', PROJ6]).out), r.out.trim().replace(/\n/g, ' | '));
check('解锁后写操作恢复正常（自救成功）',
  ok(run(['add', PROJ6, 'root', '--topic', '新', '--id', 'new1']).out));
check('links-prune --nodes 只清指向指定节点的链接', (() => {
  run(['link', PROJ6, 'x', '--to', PROJ6, '--id', 'y', '--caption', '同项目2']);
  const out = run(['links-prune', PROJ6, '--nodes', 'y', '--dry-run']);
  return ok(out.out) && /指向本项目这些节点的链接/.test(out.out) && /x → /.test(out.out);
})());

/* ---------------- 工程命令：changelog（CHANGELOG 只读窄查询） ----------------
 * 逐条**展开写**（同下方端到端对照的理由：doc-facts 是静态计数 check( 调用点）。 */
const CL_BEFORE = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const clIdx = run(['changelog']);
check('changelog 给出段/条目索引', ok(clIdx.out)
  && /CHANGELOG 索引/.test(clIdx.out) && /## \[Unreleased\]/.test(clIdx.out) && /## \[v/.test(clIdx.out),
  clIdx.out.split('\n')[0]);

check('changelog --json 结构完整且行号分区铺满全文', (() => {
  const j = run(['changelog', '--json']);
  if (!ok(j.out)) return false;
  try {
    const v = JSON.parse(j.out);
    const sum = v.groups.reduce((n, g) => n + g.entries.reduce((m, e) => m + e.lines, 0), 0);
    // 索引模式（无关键词）**索引模式列出全部段**（含空的 [Unreleased]，显示 0 条目），
    // 所以 groups === sections 必须严格成立 —— 这条断言同时守住"段没被漏列"。
    return v.totalLines > 0 && v.totalBytes > 0 && v.sections > 1 && v.entries > 0
      && Array.isArray(v.groups) && v.groups.length === v.sections && sum > 0;
  } catch (e) { return false; }
})(), run(['changelog', '--json']).out.length + 'B');

check('changelog --grep 能命中且确实做了收窄', (() => {
  const j = run(['changelog', '--grep', '门禁', '--json']);
  if (!ok(j.out)) return false;
  try {
    const v = JSON.parse(j.out);
    return v.matched > 0 && v.matched < v.entries; // 命中少于全部 = 真的在筛
  } catch (e) { return false; }
})(), run(['changelog', '--grep', '门禁']).out.split('\n')[0]);

check('changelog --grep 无命中不是错误（退出码 0 + matched 0）', (() => {
  const x = run(['changelog', '--grep', 'zzz绝不存在的词zzz', '--json']);
  if (x.code !== 0) return false;
  try { return JSON.parse(x.out).matched === 0; } catch (e) { return false; }
})());

/* 归档检索：滚动归档把老版本段移出主文件后，**检索必须同时覆盖 docs/changelog/** ——
 * 否则"已归档的历史查不到"，用起来就像历史丢了（实测踩过：关键词只在 v0.12.0 归档里，命令报 0 命中）。
 * 这两条断言直接读归档目录现取一个词，不硬编码版本号/关键词，因此不会随发版过期。 */
check('changelog --grep 也能命中**已归档**的版本段（不是只搜主文件）', (() => {
  const dir = path.join(ROOT, 'docs', 'changelog');
  if (!fs.existsSync(dir)) return true;                       // 尚无归档时跳过（不该失败）
  const files = fs.readdirSync(dir).filter((f) => /\.md$/.test(f));
  if (!files.length) return true;
  // 探针取词：从归档正文里挑一条**足够长**的行，取中段切片。
  // 不按前缀过滤（早期版本的正文行可能全部以 `-` 开头，过滤后会取不到探针而假红）；
  // 取到后先用纯函数自证"这个词确实在归档里"，取不到就跳过 —— 断言只验证 CLI 的接线。
  const chlogLib = require(path.join(ROOT, 'src', 'changelog.js'));
  const raw = fs.readFileSync(path.join(dir, files.sort()[0]), 'utf8').split('\n')
    .map((l) => l.replace(/^[\s>#|\-*]+/, '').trim())
    .filter((l) => l.length >= 24 && !/^\[/.test(l));
  const longest = raw.sort((a, b) => b.length - a.length)[0] || '';
  const probe = longest.slice(4, 4 + 16);
  if (!probe || chlogLib.searchArchives(dir, probe).totalHits === 0) return true;   // 取不到可靠探针 → 跳过
  const x = run(['changelog', '--grep', probe, '--json']);
  if (x.code !== 0) return false;
  try {
    const v = JSON.parse(x.out);
    return v.archived && v.archived.totalHits > 0 && v.archived.files.length > 0
      && v.archived.files[0].hits[0].line > 0;
  } catch (e) { return false; }
})(), '归档命中应 > 0 且带行号');

check('changelog 检索输出**分别**给出主文件与归档的命中数（不让人误以为历史丢了）', (() => {
  const x = run(['changelog', '--grep', '归档']);
  return ok(x.out) && /主文件命中\s*\d+\s*条目/.test(x.out) && /归档命中\s*\d+\s*处/.test(x.out);
})(), '应形如「主文件命中 N 条目；归档命中 M 处」');

check('changelog --limit 限制条目数', (() => {
  const x = run(['changelog', '--limit', '2']);
  return ok(x.out) && (x.out.match(/^\s+L\d/gm) || []).length === 2;
})(), '条目行数应为 2');

check('changelog --full 真的带回正文（长度显著大于索引）', (() => {
  const idxOnly = run(['changelog', '--grep', '门禁']).out.length;
  const withBody = run(['changelog', '--grep', '门禁', '--full']).out;
  return ok(withBody) && withBody.length > idxOnly * 2;
})());

check('changelog 是只读命令：跑完 CHANGELOG.md 逐字节未变',
  fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8') === CL_BEFORE,
  '跑完上述 6 条查询后逐字节比对 CHANGELOG.md（查询命令不得改它）');

/* ---------------- 工程命令：dsh-caps（DSH 能力边界，**只读**） ----------------
 * 逐条展开写（同下方理由：doc-facts 静态统计 check( 调用点）。
 * 本机有 vendor/dsh 时断言"能正确读出能力边界"；**没有时断言"它响亮报错"** ——
 * 两条都是契约，避免"没有 vendor 就给一份空报告"这种静默失败。 */
const DSH_NM = path.join(ROOT, 'vendor', 'dsh', 'app', 'node_modules', '@deepseek-ai');
const hasDshVendor = fs.existsSync(DSH_NM);
const dcOut = run(['dsh-caps']);

check('dsh-caps：机械读出多层装配，并显式列出易误判规则（有 vendor 时）/ 响亮报错（无 vendor 时）',
  hasDshVendor
    ? (ok(dcOut.out) && /容易误判的规则/.test(dcOut.out) && /host bundle 是并列的/.test(dcOut.out)
      && /装配层/.test(dcOut.out))
    : (dcOut.code !== 0 && /找不到 DSH 运行时包目录/.test(dcOut.out)),
  hasDshVendor ? dcOut.out.split('\n')[0] : '本机无 vendor/dsh：应响亮报错，而不是给一份空报告');

check('dsh-caps --json：结构完整，且三轴计数自洽（已挂载 + 未挂载 == 磁盘总数）',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--json']);
    if (!ok(r.out)) return false;
    try {
      const j = JSON.parse(r.out);
      return j.layers.length >= 2 && j.diskCount > 100 && j.mountedCount > 0 && j.unmountedCount > 0
        && j.mountedCount + j.unmountedCount === j.diskCount
        && Array.isArray(j.packages) && j.packages.length === j.mountedCount;
    } catch (e) { return false; }
  })() : true);

check('dsh-caps --grep：**从"装配 + 磁盘"两轴回答** —— 这是本命令存在的理由',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--grep', 'headless']);
    return ok(r.out) && /两侧都查/.test(r.out) && /dsh-headless/.test(r.out);
  })() : true, '查 headless 应能说出它在磁盘的哪套 bundle 里');

check('dsh-caps --grep 无命中时如实说"两层都没有匹配"，而不是给空输出',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--grep', 'zzz绝不存在的能力zzz']);
    return ok(r.out) && /两层都没有匹配/.test(r.out);
  })() : true);

check('dsh-caps --grep 缺参数 → 非 0 退出 + 明确提示怎么用', (() => {
  const r = run(['dsh-caps', '--grep']);
  return r.code !== 0 && /需要一个关键词/.test(r.out);
})());

check('dsh-caps --unmounted：列出"磁盘上有但当前未挂载"的包（防"以为不具备"）',
  hasDshVendor ? (() => {
    const r = run(['dsh-caps', '--unmounted']);
    return ok(r.out) && /未被任何装配挂载/.test(r.out) && r.out.split('\n').length > 5;
  })() : true);

/* ---------------- 窄读模式：--brief / --compact / --subtree ----------------
 * 逐条展开写（同下方理由：doc-facts 静态统计 check( 调用点）。 */
run(['add', PROJ, 'root', '--topic', '窄读探针', '--id', 'narrow-probe']);
run(['add', PROJ, 'narrow-probe', '--topic', '窄读子节点', '--id', 'narrow-probe-child']);

const nrFull = run(['read', PROJ, '--json']);
const nrCompact = run(['read', PROJ, '--json', '--compact']);
const nrBrief = run(['read', PROJ, '--json', '--brief']);
const nrBriefCompact = run(['read', PROJ, '--json', '--brief', '--compact']);

check('窄读 --compact：仍是合法 JSON，且确实更短（省的是缩进与换行）', (() => {
  if (!ok(nrCompact.out)) return false;
  try { JSON.parse(nrCompact.out); } catch (e) { return false; }
  return nrCompact.out.length < nrFull.out.length;
})(), nrFull.out.length + ' 字符 → ' + nrCompact.out.length + ' 字符');

check('窄读 --brief：nodeCount 不变，但 detail 与资源清单被省掉（结构仍是全的）', (() => {
  try {
    const a = JSON.parse(nrFull.out);
    const b = JSON.parse(nrBrief.out);
    return b.brief === true && b.nodeCount === a.nodeCount
      && b.nodes.some((n) => n.detail !== undefined) === false
      && a.nodes.some((n) => n.detail !== undefined) === true;
  } catch (e) { return false; }
})(), nrBrief.out.length + ' 字符（全量 ' + nrFull.out.length + ' 字符）');

check('窄读三开关可叠加：brief+compact 比只用 brief 更省',
  ok(nrBriefCompact.out) && nrBriefCompact.out.length < nrBrief.out.length,
  nrBriefCompact.out.length + ' 字符（只用 brief 是 ' + nrBrief.out.length + ' 字符）');

check('窄读 --subtree：只给该子树，根就是它且 depth 从 0 起', (() => {
  const sub = run(['read', PROJ, '--json', '--subtree', 'narrow-probe']);
  if (!ok(sub.out)) return false;
  try {
    const j = JSON.parse(sub.out);
    const all = JSON.parse(nrFull.out);
    return j.nodeCount === 2 && j.nodeCount < all.nodeCount
      && j.nodes[0].id === 'narrow-probe' && j.nodes[0].depth === 0;
  } catch (e) { return false; }
})(), '应为 2 个节点、根 narrow-probe、depth 0 起');

check('窄读 --subtree 指向不存在的节点 → 非 0 退出 + error: 前缀 + 点明原因', (() => {
  const r = run(['read', PROJ, '--subtree', 'no-such-node-xyz']);
  return r.code !== 0 && /^error:/.test(r.out) && /节点不存在/.test(r.out);
})());

check('窄读 --subtree 缺参数 → 非 0 退出 + 明确提示怎么用', (() => {
  const r = run(['read', PROJ, '--subtree']);
  return r.code !== 0 && /^error:/.test(r.out) && /需要一个节点 id/.test(r.out);
})());

check('**文本模式不再静默吞掉 --detail**（以前是无声空操作，会让人以为项目没详情）', (() => {
  const r = run(['read', PROJ, '--detail']);
  return r.code !== 0 && /^error:/.test(r.out) && /只在 --json 视图里有效/.test(r.out);
})(), '应报错并给出替代路径');

check('文本模式同样拒绝 --images（同一陷阱的另一半）', (() => {
  const r = run(['read', PROJ, '--images']);
  return r.code !== 0 && /只在 --json 视图里有效/.test(r.out);
})());

check('向后兼容：--json --detail 仍照常可用（read 的 detail 本来就是默认开的）', (() => {
  const r = run(['read', PROJ, '--json', '--detail']);
  return r.code === 0 && ok(r.out) && r.out.length === nrFull.out.length;
})());

check('窄读 --skeleton：连 tags/links/detail/images 都省，但**保留 children 嵌套**', (() => {
  const sk = run(['read', PROJ, '--json', '--skeleton']);
  if (!ok(sk.out)) return false;
  try {
    const j = JSON.parse(sk.out);
    return j.skeleton === true && j.brief === undefined && j.images === undefined
      && j.nodes.every((n) => n.tags === undefined && n.links === undefined
        && n.detail === undefined && n.images === undefined)
      && Array.isArray(j.nodes[0].children);
  } catch (e) { return false; }
})(), '这是它相对 list --json（扁平）的差别：仍有嵌套');

run(['remove', PROJ, 'narrow-probe']);

/* ---------------- 22. 多路同时编辑（并发：不相交自动合并 / 相交指名拒绝） ----------------
 * 上面所有断言都是"单路"。本段专门跑**两路同时编辑**，而且走**真实的** ctx + 命令函数 + store：
 * 用 `createContext` 造 ctx（命令名不进 ctx —— 见 `cli/main.js` 的 `createContext(rest)`），
 * 再在**「我读之后、我写之前」**这个窗口里注入一次"别人的写"。
 *
 * ⚠️ **窗口为什么要这样造**（第一版探针栽在这里）：`ctx.mutate` 是"读→改→写"，读发生在**写之前**。
 *    所以"先让别处写一次、再跑命令"**构不成竞争** —— 命令自己那次读会读到别人的改动，一次就成功。
 *    真正的竞争窗口只在 mutate 内部，所以唯一的注入点是 `store.write` 这个 io 缝。
 * 判据就是本功能的全部价值：
 *    · 不相交 ⇒ **两边改动都在**；
 *    · 相交   ⇒ **拒绝 + 报出是哪个对象**，且盘上保持别人那一版（绝不静默覆盖）。
 *
 * ⚠️ 下面三个小标题刻意写成「（并发①）」而**不是**"斜杠紧跟 ①"的形式：本文件前面已有一组那样的序号，
 *    而 **G9 判定六把"斜杠紧跟标记"当作实现脚本里的判定标记来计数**（标记必须唯一）⇒ 重复即判红。
 *    这条实测教训就在它的报错文本里。**要加序号，就把标记放在别的字符之后，让它不被计入。**
 */
const { createContext } = require(path.join(ROOT, 'cli', 'core.js'));
const editCmds = require(path.join(ROOT, 'cli', 'commands', 'edit.js'));
const assocCmds = require(path.join(ROOT, 'cli', 'commands', 'assoc.js'));
// 读项目用本文件已有的 `readProj(name)`（不另造一份同样的读取 —— 同一事实一处表达）
const nodeOf = (data, id) => {
  let hit = null;
  (function w(n) { if (!n || hit) return; if (n.id === id) hit = n; (n.children || []).forEach(w); })(data.data);
  return hit;
};
/** 造一次竞争：在**第一次写盘之前**，让"另一个写入者"先真写一次 */
function raceCtx(rest, otherFn) {
  const ctx = createContext(rest);
  const realWrite = ctx.store.write.bind(ctx.store);
  let injected = false;
  ctx.store.write = (name, data, opts) => {
    if (!injected) {
      injected = true;
      const cur = ctx.store.read(name);                          // 别人读到的正是"我读到的那一版"
      realWrite(name, otherFn(JSON.parse(JSON.stringify(cur.data))), { expectVersion: cur.version });
    }
    return realWrite(name, data, opts);
  };
  return ctx;
}

run(['add', PROJ, 'root', '--topic', '并发A', '--id', 'cc-a']);
run(['add', PROJ, 'root', '--topic', '并发B', '--id', 'cc-b']);

// （并发①）不相交：我改 cc-a，别人改 cc-b ⇒ 自动合并
{
  const ctx = raceCtx([PROJ, 'cc-a', '--topic', 'A-我'], (d) => { nodeOf(d, 'cc-b').topic = 'B-别人'; return d; });
  let threw = null;
  try { editCmds.edit(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  check('并发：改不同节点 ⇒ 自动合并（两边改动都在）',
    !threw && nodeOf(after, 'cc-a').topic === 'A-我' && nodeOf(after, 'cc-b').topic === 'B-别人',
    threw ? String(threw.message).slice(0, 120)
      : 'cc-a=' + nodeOf(after, 'cc-a').topic + ' · cc-b=' + nodeOf(after, 'cc-b').topic);
}

// （并发②）相交：我改 cc-a，别人也改 cc-a ⇒ 指名拒绝，盘上保持别人那一版
{
  const ctx = raceCtx([PROJ, 'cc-a', '--topic', 'A-我2'], (d) => { nodeOf(d, 'cc-a').topic = 'A-别人'; return d; });
  let threw = null;
  try { editCmds.edit(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const msg = threw ? String(threw.message) : '';
  check('并发：改同一节点 ⇒ 指名拒绝（且不覆盖对方）',
    !!threw && /node:cc-a/.test(msg) && /重新读取/.test(msg) && nodeOf(after, 'cc-a').topic === 'A-别人',
    threw ? msg.replace(/\s+/g, ' ').slice(0, 170) : '没有报错 —— 危险：应当拒绝却写进去了');
}

// （并发③）跨对象类别也不相交：我改 assoc 条目，别人改节点 ⇒ 自动合并
{
  run(['assoc-add', PROJ, '--members', 'cc-a,cc-b', '--id', 'cc-rel', '--title', '并发关系']);
  const ctx = raceCtx([PROJ, 'cc-rel', '--title', '关系-我'], (d) => { nodeOf(d, 'cc-a').topic = 'A-别人2'; return d; });
  let threw = null;
  try { assocCmds.assocEdit(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const it = (after.assoc || []).find((x) => x && x.id === 'cc-rel');
  check('并发：改 assoc 与改节点不相交 ⇒ 自动合并',
    !threw && !!it && it.title === '关系-我' && nodeOf(after, 'cc-a').topic === 'A-别人2',
    threw ? String(threw.message).slice(0, 120)
      : 'assoc=' + (it && it.title) + ' · cc-a=' + nodeOf(after, 'cc-a').topic);
}

// 收回探针数据（顺序：先摘关联，再删节点 —— 否则留下悬挂成员会让删除被闸门挡住）
run(['assoc-remove', PROJ, 'cc-rel']);
run(['remove', PROJ, 'cc-a']);
run(['remove', PROJ, 'cc-b']);

/* ---------------- 23. 变更可见性（changes：多路同时编辑的事前避让） ----------------
 * 记的是"谁、何时、改了哪些对象"，数据来自唯一写盘出口顺带产生的 `.changes.jsonl`。
 * 判据里最要紧的一条是**"答不了"必须与"没有变更"可分辨**：可见性功能最坏的失效形态不是报错，
 * 而是安静地说"没人动过" —— 会话会据此放心写下去，撞上并发改动白做一轮。
 * （`changedKeys` 返回 Set 这个坑就属于这类：实测曾让每条日志都显示"无对象变化"。）
 */
{
  // 锚点必须在**写入之前**取（先写再取锚点，`--since` 当然答"没有变更" —— 我第一版就这么写错了）
  const base = JSON.parse(run(['changes', PROJ, '--json']).out);
  check('changes --json 给出当前 rev 与 version（这是 --since 的锚点来源）',
    typeof base.rev === 'number' && base.rev > 0 && /^[0-9a-f]{8,}$/.test(String(base.version)),
    'rev=' + base.rev + ' version=' + String(base.version).slice(0, 8));

  // 造一次可由日志捕获的写入（新增节点 ⇒ children:<父> + node:<新id>）
  run(['add', PROJ, 'root', '--topic', '变更日志探针', '--id', 'chg-probe']);

  // ★ 这条锁"日志必须记到**真的变了什么**"（`changedKeys` 返回 Set 的坑：按数组处理会每条都空）
  const added = run(['changes', PROJ, '--since', String(base.rev)]).out;
  check('changes --since <rev> 列出其后的写入，并**指名叫出被改的对象**（不是"无对象变化"）',
    ok(added) && /变更日志探针/.test(added) && !/无对象变化/.test(added),
    added.trim().split('\n').slice(1, 3).join(' | '));

  // 写入者身份：这条写入必须记成 `cli:add`（说明"谁在写"落到了日志里）
  check('changes 记下「谁在写」（cli:<命令>）', /cli:add/.test(added), added.trim().split('\n')[1] || '');

  run(['edit', PROJ, 'chg-probe', '--topic', '变更日志探针2']);
  const afterEdit = JSON.parse(run(['changes', PROJ, '--json']).out);
  check('changes：又写一次后 rev 递增（计数单调，不受窗口裁剪影响）',
    afterEdit.rev === base.rev + 2, 'rev ' + base.rev + ' → ' + afterEdit.rev);

  // ★ 最要紧的一条：答不了 ⇒ **报错 + 非 0**，绝不能返回"无变更"
  const bad = run(['changes', PROJ, '--since', 'deadbeefdeadbeef']);
  check('changes --since <窗口外的锚点> ⇒ 报错且非 0（"答不了"≠"没有变更"）',
    !ok(bad.out) && bad.code !== 0 && /不等于"没有变更"/.test(bad.out),
    bad.out.trim().slice(0, 110));

  // 无 `--since` 时缺日志只是"看现状"，明说缺日志即可（不报错）—— 清掉日志验证
  const logFile = path.join(ROOT, 'projects', PROJ, '.changes.jsonl');
  const savedLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : null;
  try {
    if (fs.existsSync(logFile)) fs.rmSync(logFile);
    const noLog = run(['changes', PROJ]);
    check('changes（无 --since）缺日志 ⇒ 明说"答不了"，但不报错',
      ok(noLog.out) && /没有变更日志/.test(noLog.out) && /不等于"没有变更"/.test(noLog.out),
      noLog.out.trim().split('\n').slice(-1)[0].slice(0, 110));
    const sinceNoLog = run(['changes', PROJ, '--since', '1']);
    check('changes --since（缺日志）⇒ 报错且非 0',
      !ok(sinceNoLog.out) && sinceNoLog.code !== 0, sinceNoLog.out.trim().slice(0, 90));
  } finally {
    if (savedLog !== null) fs.writeFileSync(logFile, savedLog, 'utf8');
  }

  run(['remove', PROJ, 'chg-probe']);
}

/* ---------------- 24. 阶段 4：修复类与导入类命令也走 mutate ----------------
 * 判据不止"没报错"：
 *   ① 并发**不相交**时自动合并（我和对方的改动都在）；
 *   ② **重放后的数据仍然过 validate** —— 修复类命令最怕"修好"变成"换个方式坏掉"；
 *   ③ 我与对方撞在**同一对象**上时仍然拒绝（这条由上面的并发段统一覆盖）。
 */
const projectCmds = require(path.join(ROOT, 'cli', 'commands', 'project.js'));
// 错误码常量：**单一来源**（`src/concurrency.js`），断言里不写字符串字面量（文案会改、码才是契约）
const concurrency = require(path.join(ROOT, 'src', 'concurrency.js'));
const allIds = (data) => { const out = []; (function w(n) { if (!n) return; out.push(n.id); (n.children || []).forEach(w); })(data.data); return out; };

// （阶段4①）assoc-prune：造一个悬挂成员（只能直接改盘 —— assoc-add 会拒绝不存在的成员），
//    再让"别人"在窗口期内改**另一个对象**（某个节点的标题）
{
  const d = readProj(PROJ);
  const ids = allIds(d);
  const anchor = ids.filter((x) => x !== 'root')[0];
  d.assoc = (d.assoc || []).concat([{
    id: 'as-gone', title: '悬挂探针',
    members: [{ project: PROJ, id: 'gone-node' }, { project: PROJ, id: anchor }]
  }]);
  fs.writeFileSync(projJson(PROJ), JSON.stringify(d, null, 2), 'utf8');
  check('前置：注入悬挂成员后 validate 判红（修复类命令的前置条件）', run(['validate', PROJ]).code !== 0);

  // ⚠️ raceCtx 收的是**去掉命令名**的 argv（`cli/main.js` 的 `createContext(rest)` 语义）
  // ⚠️ 并发窗口里"别人"必须写**合法**数据 —— 实测发现：项目处于悬挂状态时**任何写入都过不了
  //    校验闸门**（这正是修复类命令的存在意义：坏状态会把所有写命令一起挡住）。
  //    所以修复类命令的真实并发场景只有一个：**另一个修复者**。这里就模拟它：
  //    对方先把悬挂的那条关联整个摘掉（合法写），我这边再重放到已修好的数据上。
  const ctx = raceCtx([PROJ], (dd) => { delete dd.assoc; return dd; });
  const said = [];
  ctx.out = (t) => { said.push(String(t)); };          // 捕获输出（不碰 process.stdout）
  let threw = null;
  try { assocCmds.assocPrune(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const pruned = !(after.assoc || []).some((x) => x.id === 'as-gone');
  const valid = run(['validate', PROJ]).code === 0;
  const honest = /并发期间/.test(said.join('\n'));       // 走了重放路径，且如实说"已被对方清掉"
  check('assoc-prune 并发（另一个修复者）⇒ **不报版本冲突**、如实报告、重放后仍过 validate',
    !threw && pruned && valid && honest,
    threw ? String(threw.message).slice(0, 130)
      : '清理=' + pruned + ' · validate 通过=' + valid + ' · 走了重放路径=' + honest
        + ' · 输出="' + said.join(' / ').slice(0, 60) + '"');
}

// （阶段4②）import-md：最值得接的一条（窗口最宽：读 md + 转节点树 + 追加）
{
  const d = readProj(PROJ);
  const ids = allIds(d);
  const target = ids.filter((x) => x !== 'root')[0];
  const MDCC = path.join(TMP, 'cc-import.md');
  fs.writeFileSync(MDCC, '# 并发导入探针\n- 子一\n- 子二\n', 'utf8');

  // 同样：argv 里没有命令名（首个位置参数就是项目名）
  const ctx = raceCtx([PROJ, MDCC], (dd) => { nodeOf(dd, target).topic = '导入期间对方改的'; return dd; });
  let threw = null;
  try { projectCmds.importMd(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const imported = (function w(n) { if (!n) return null; if (n.topic === '并发导入探针') return n; for (const c of (n.children || [])) { const h = w(c); if (h) return h; } return null; })(after.data);
  const kept = nodeOf(after, target).topic === '导入期间对方改的';
  const valid = run(['validate', PROJ]).code === 0;
  check('import-md 并发不相交 ⇒ 自动合并：导入的节点在 + 对方改动保住 + 仍过 validate',
    !threw && !!imported && kept && valid,
    threw ? String(threw.message).slice(0, 130)
      : '导入节点在=' + !!imported + ' · 对方改动保住=' + kept + ' · validate 通过=' + valid);
}

// （阶段4③）**拒绝路径**：接上 mutate 之后，撞在**同一对象**上仍必须拒绝 ——
// 要证明的不是"能合并"，而是"**没有退化成最后写者赢**"（那才是本工程最重的损害类别）。
// 判据用**错误码**（`REPLAY_CONFLICT`），不匹配文案 —— 文案会改，靠正则匹配会静默失效。
{
  const d = readProj(PROJ);
  const themeId = (d.data.children || [])[0].id;
  const ctx = raceCtx([PROJ, '--left', themeId], (dd) => { dd.meta = dd.meta || {}; dd.meta.name = '对方改的项目名'; return dd; });
  let threw = null;
  try { projectCmds.themeLayout(ctx); } catch (e) { threw = e; }
  const after = readProj(PROJ);
  const refused = !!threw && threw.code === concurrency.REPLAY_CONFLICT;
  const mineNotWritten = !(after.meta && after.meta.layout);          // 我的 layout 没落盘
  const theirsKept = !!after.meta && after.meta.name === '对方改的项目名';
  check('theme-layout 与对方撞同一对象（meta）⇒ 拒绝（REPLAY_CONFLICT）且我的改动未落盘',
    refused && mineNotWritten && theirsKept,
    threw ? 'code=' + threw.code + ' · 我的未落盘=' + mineNotWritten + ' · 对方保住=' + theirsKept
      : '⚠️ 没有报错 —— 危险：同一对象被自动决定了');
}

// （阶段4④）改造动了 `import-md` 的**报错顺序**（预读一次再转换）⇒ 必须仍然"先报父节点不存在、且不写盘"
{
  const MDX = path.join(TMP, 'cc-bad-parent.md');
  fs.writeFileSync(MDX, '# 不该被导入\n', 'utf8');
  const before = fs.readFileSync(projJson(PROJ), 'utf8');
  const r2 = run(['import-md', PROJ, MDX, '--parent', 'no-such-parent']);
  const unchanged = fs.readFileSync(projJson(PROJ), 'utf8') === before;
  check('import-md 父节点不存在 ⇒ 报错且不写盘（改造后报错顺序不变）',
    !ok(r2.out) && /父节点不存在/.test(r2.out) && unchanged, r2.out.trim().slice(0, 90));
}

/* ---------------- 端到端对照：进程内 ≡ 子进程 ----------------
 * 上面全部断言走**进程内** invokeSync。进程内与子进程是两条不同的执行路径，可能漂移
 * （cwd、环境变量、模块加载时机、退出码来源……）⇒ 这里保留少量**真子进程**断言逐步比对：
 * 同一命令、同一 cwd，比较 **stdout 字节 + 退出码**。漂移即红。
 * 放在清理之前：这些命令需要一个真实存在的探针项目。 */
function runSubprocess(args) {
  const sp = spawnSync(process.execPath, [CLI].concat(args), { cwd: ROOT, encoding: 'utf8' });
  return { code: sp.status, out: (sp.stdout || '') + (sp.stderr || '') };
}
/* 以下 4 条**逐条展开写、刻意不用 for 循环**：`scripts/doc-facts.js` 用 `/^\s*check\(/gm`
 * **静态**统计断言数写进 `docs/VERIFY.md`，循环会把 4 条压成 1 个调用点 ⇒
 * 文档数字（141）与运行时打印的 `N/N`（144）不一致。本工程把"文档数字 == 真值"当门禁（G6），
 * 所以这里宁可重复也不循环。想 DRY 它之前，请先看这条注释。 */
{
  const args = ['projects'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：projects', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}
{
  const args = ['read', PROJ, '--json'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：read --json（大输出）', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}
{
  const args = ['get', PROJ, 'no-such-id-xyz', '--json'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：失败路径（不存在的 id）', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}
{
  const args = ['no-such-command-xyz'];
  const a = run(args), b = runSubprocess(args);
  check('进程内 ≡ 子进程：失败路径（未知命令）', a.code === b.code && a.out === b.out,
    'in=' + a.code + '/' + a.out.length + 'B  sub=' + b.code + '/' + b.out.length + 'B');
}

/* ---------------- 44. localPath（节点 ↔ 本机文件夹） ----------------
 * 为什么单开一节：这条能力**真的漏过一次**。当初 `--local-path` 只接进了 `add` / `edit`，
 * 而建树时根节点是用 `add-root` 建的（它是独立实现）—— 结果整棵树唯一的根**没有文件夹链接**，
 * 而根恰恰是最该有链接的那个。所以这里把三个入口全钉一遍，谁再漏一个就判红。
 * （形状校验的边界由 tests/schema.test.js 覆盖：只校验形状、不校验存在性。） */
{
  const HOME = os.homedir();                       // 一定存在的绝对路径（不假设有 E: 盘）
  // 44.1 add --local-path
  r = run(['add', PROJ, 'a', '--topic', '带文件夹的节点', '--id', 'lp-node', '--local-path', HOME]);
  const got1 = run(['get', PROJ, 'lp-node', '--json']);
  let lp1 = null;
  try { lp1 = JSON.parse(got1.out).localPath; } catch (e) { /* 解析失败即为 null，断言会判红 */ }
  check('add --local-path 落盘且读视图可见', ok(r.out) && lp1 === HOME,
    '设置=' + ok(r.out) + ' 读回=' + JSON.stringify(lp1));

  // 44.2 add-root --local-path（曾经漏掉的那个入口）
  r = run(['add-root', PROJ, '--topic', '带文件夹的顶层主题', '--id', 'lp-root', '--local-path', HOME]);
  const got2 = run(['get', PROJ, 'lp-root', '--json']);
  let lp2 = null;
  try { lp2 = JSON.parse(got2.out).localPath; } catch (e) { /* 同上 */ }
  check('add-root --local-path 落盘且读视图可见', ok(r.out) && lp2 === HOME,
    '设置=' + ok(r.out) + ' 读回=' + JSON.stringify(lp2));

  // 44.3 相对路径必须被拒（相对路径会随工作目录漂移，而点击打开的是操作系统）
  r = run(['edit', PROJ, 'lp-node', '--local-path', 'markdown/M1']);
  check('--local-path 拒绝相对路径', r.code !== 0 && /绝对路径/.test(r.out), r.out.trim().slice(0, 80));

  // 44.4 --clear-local-path 能清掉
  r = run(['edit', PROJ, 'lp-node', '--clear-local-path']);
  const got3 = run(['get', PROJ, 'lp-node', '--json']);
  let lp3 = 'unset';
  try { lp3 = JSON.parse(got3.out).localPath; } catch (e) { /* 同上 */ }
  check('--clear-local-path 清得掉', ok(r.out) && lp3 === undefined,
    '清除=' + ok(r.out) + ' 读回=' + JSON.stringify(lp3));
}

/* ---------------- 45. expand-depth（按深度规范化展开状态） ----------------
 * 这条命令存在的理由：展开状态是**数据**（`expanded`），而渲染层已不再无条件展开
 * （见 renderer/app-core.js 的 renderMind）⇒ 历史上"一律 true"的数据需要一次收口。
 * 判据用 `get --json` 读回展开状态（唯一真源是数据文件本身，不经任何视图层）。 */
{
  const P = PROJ;                                  // 复用本套断言的临时项目
  run(['add', P, 'a', '--topic', 'D2', '--id', 'd2']);
  run(['add', P, 'd2', '--topic', 'D3', '--id', 'd3']);
  run(['add', P, 'd3', '--topic', 'D4', '--id', 'd4']);
  const expandedOf = (id) => {
    try { const j = JSON.parse(run(['get', P, id, '--json']).out); return j.expanded !== false; }
    catch (e) { return null; }
  };
  r = run(['expand-depth', P, '--depth', '2']);
  const okMsg = ok(r.out) && /改写 \d+/.test(r.out);
  check('expand-depth 默认前两层展开：浅层 true、深层 false', okMsg && expandedOf('d2') === true && expandedOf('d3') === false,
    'D2=' + expandedOf('d2') + ' D3=' + expandedOf('d3'));

  r = run(['expand-depth', P, '--depth', '0']);
  check('expand-depth --depth 0 全收起', ok(r.out) && expandedOf('d2') === false, 'D2=' + expandedOf('d2'));

  r = run(['expand-depth', P, '--depth', '9']);
  check('expand-depth 给大值 = 全展开（方向可逆，不需要第二条命令）', ok(r.out) && expandedOf('d3') === true, 'D3=' + expandedOf('d3'));

  r = run(['expand-depth', P, '--depth', '-1']);
  check('expand-depth 拒绝负深度', r.code !== 0 && /非负整数/.test(r.out), r.out.trim().slice(0, 60));

  r = run(['expand-depth', P, '--id', 'no-such-node']);
  check('expand-depth 对不存在的子树报错', r.code !== 0 && /节点不存在/.test(r.out), r.out.trim().slice(0, 60));
}

/* ---------------- 清理 ---------------- */
run(['remove', PROJ2, 'root']);
try { fs.rmSync(path.join(ROOT, 'projects', PROJ6), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ7), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ4), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', BROKEN_PROJ), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ5), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ5 + '-bad'), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ3), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(ROOT, 'projects', PROJ2), { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(XP_DIR, { recursive: true, force: true }); } catch (e) {}   // 8.7 的跨项目探针项目
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\n==== ' + passed + '/' + (passed + failed) + ' CLI 集成断言通过 ====');
// 用 exitCode 而不是 process.exit()：后者**立即**终止，可能截断尚未 flush 的 stdout。
// 本脚本的全部断言输出现在走同一条 stdout（进程内调用，不再是每条一个管道），
// 截断会丢掉末尾的汇总行 —— 那正是人/CI 判读结果的第一行。
process.exitCode = failed ? 1 : 0;
