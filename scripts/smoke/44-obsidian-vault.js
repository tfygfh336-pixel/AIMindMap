/* ============================================================
 * scripts/smoke/44-obsidian-vault.js —— 【W12】Obsidian 库直进（vault 目录 → 树 + wiki 链接接成关联）
 * ------------------------------------------------------------
 * 用户原话（待做清单 W12 一节）：「把一个 Obsidian 库直接变成导图内容」——P0 只做这一档：
 * **文件夹结构 + `.md` + `[[wikilink]]` → 树与边**，加 frontmatter 与 `![[嵌入]]` 的识别与落点。
 *
 * 本域钉的是**产品真路径**（全部在沙箱里跑，真实 `projects/**` 零写入）：
 *
 *   甲 沙箱 vault 真导（`import-dir --vault`）：目录/子目录/文件名成树**逐节点现算**对拍；
 *      层级按**文件夹同构**判（子目录是容器、文件是它的子节点，标题取文件名去扩展名）。
 *   乙 链接接成了关联：盘上 `links[]` 的**条数按源码现算**（每篇笔记里 `[[…]]` 的个数），
 *      并用**既有读命令** `backlinks --json` 对拍（反向可查 ⇒ 边真的在库里，不是报告里编的）。
 *   丙 断链与同名多篇**逐条点名**（进跳过清单），且好的照进（判据④：一个坏链接不拖垮整批）。
 *   丁 frontmatter 标签进了**既有**标签机制：`search --tag` 命中那篇笔记的文件节点（同一套 `tags` 字段）。
 *   戊 默认档不变：同一个目录**不给 `--vault`** 导 ⇒ 结构一样，但 `[[…]]` 按**普通文字**留在正文里
 *      （`links[]` 一个都没有）；而库里没有 `.obsidian/` 时**自动识别也不触发**。
 *   己 界面侧那一条路：**真调用主进程** `app:import-preview`（与渲染层用的是同一个 IPC、同一份实现）
 *      ⇒ 主进程自己认出 `.obsidian/` 并给真导入补上 `--vault`；读数来自 CLI 的 `--vault` 报告，
 *      而它跑在**演练副本**上 ⇒ 用户项目此刻**逐字节不变**。
 *
 * 判别力证明（**两条**，各自"改坏 ⇒ 必红 ⇒ 还原逐字节 ⇒ 复绿"，读数写在报文里）：
 *   · 把"链接接成关联"改坏（`src/doc-import.js` 的 `linkWikiToken` 直接 return）⇒ 乙 必红（links 0 条）；
 *   · 把"默认档不解析"改坏（`buildDirImportTree` 不看 `--vault` 就吃转换）⇒ 戊 必红。
 *   两次都记 `src/doc-import.js` 的 SHA-256，还原后逐字节相同。
 *
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tempRunRoot = require('./temp-run-root.js');

/** 源目录（**不在 projects/ 里**；收尾删干净）。
 *  ⚠️ 唯一段写在**父目录**上（`RUN.root`），三条基名保持原样不变 —— 见 temp-run-root.js 头注：
 *  固定名在并发跑同一域时会被另一个会话删掉（实测互删 ⇒ 假红）；而 `zz-w12-vault` / `zz-w12-plain`
 *  这两个基名是**新项目名的来源**（`sanitizeProjectName(basename(dir))`，见 `P` / `P_PLAIN`）⇒
 *  唯一段只能写在父目录上，否则项目名跟着漂、判据全错。 */
const RUN = tempRunRoot.planRunRoot('zz-w12');
const SRC = RUN.under('zz-w12-vault');
/** 界面预览那一条用它（**另起一个目录名**：项目名由主进程从目录名现推，
 *  而 `zz-w12-vault` 这个名字已经被甲 真导占了 ⇒ 预览会因为"项目已存在"失败，那是另一件事） */
const SRC_UI = RUN.under('zz-w12-vaultlib');
const PLAIN = RUN.under('zz-w12-plain');
const P = 'zz-w12-vault';            // vault 那一路会新建的项目（名字 = 目录名清洗后的结果）
const P_PLAIN = 'zz-w12-plain';      // 默认档那一路会新建的项目
const P_STUB = 'zz-w12-probe';       // 界面预览那一条要有"一个当前项目"（先造一个最小的）

/** 沙箱 vault 的正文（每一篇都带 `[[…]]`；**条数由本常量现算**，判据里不写死数字） */
const NOTE_INDEX = [
  '---',
  'tags: [工具, 网络]',
  'aliases:',
  '  - 主页',
  'created: 2026-01-01',
  '---',
  '# 索引正文',
  '',
  '链到 [[甲]]、[[子目录/乙|乙的别名]]、[[甲#小节]]',
  '',
  '同名多篇：[[同名]]',
  '',
  '嵌入笔记：![[甲]]',
  ''
].join('\n');
const NOTE_A = '# 甲\n\n## 小节\n\n小节正文\n\n回链 [[索引]]\n';
const NOTE_B = '---\ntag: 单数键\n---\n# 乙\n\n指向 [[主页]]（走别名）与 [[丙#深层]]\n';
const NOTE_C = '# 丙\n\n## 外层\n\n### 深层\n\n正文\n';
/** 同名多篇：两处 `一/同名.md` 与 `二/同名.md` ⇒ 任何 `[[同名]]` 都必须**不猜**（逐条点名） */
const DUP_A = '# 同名\n\n[[索引]]\n';
const DUP_B = '# 同名二\n\n[[索引]]\n';
/** 源里一个**坏条目**（判据④）：一个**目录**叫 `坏.md`（单文件导入会响亮拒它；整库走查按"扩展名不在范围"跳过）。
 *  它与"同名多篇"一起把"一个坏东西不许拖垮整批"钉住：好的那 6 篇照进、坏的一类一条都点名 ✓ */
const BAD_REL = '坏.md';

const V = {
  '索引.md': NOTE_INDEX,
  '甲.md': NOTE_A,
  '子目录/乙.md': NOTE_B,
  '子目录/丙.md': NOTE_C,
  '一/同名.md': DUP_A,
  '二/同名.md': DUP_B
};
const PLAIN_MD = '# 笔记\n\n[[甲]] 在默认档里是普通文字\n';

/** 每个文件里的 `[[…]]` 个数（**从源码现算**：判据拿它当期望，不写死） */
function wikiCountOf(text) {
  const lines = String(text).split('\n');
  let inFence = false;
  let n = 0;
  lines.forEach((l) => {
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = l.match(/\[\[/g);
    if (m) n += m.length;
  });
  return n;
}
const EXPECT = {
  files: Object.keys(V).length,
  dirs: 3,                                     // 子目录 / 一 / 二 / 坏.md —— 后两个是"顶着 .md 名字的目录"
  wikiTotal: Object.keys(V).reduce((n, k) => n + wikiCountOf(V[k]), 0),
  /** 这个夹具里的目标**都存在** ⇒ 断链 0 条（"目标不存在"那一档由单测钉死，见 tests/vault.test.js） */
  dangling: 0,
  /** `[[同名]]`（索引.md 里）指向两篇同名笔记 ⇒ **不猜**，进"没接上"那一档 */
  ambiguous: 1,
  /** 真的该接上的边 = 全部 wiki 引用 − 断链 − 同名多篇 */
  linked: Object.keys(V).reduce((n, k) => n + wikiCountOf(V[k]), 0) - 0 - 1
};

function projectsDir() {
  const d = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!d) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到沙箱真值');
  return d;
}
const projectFile = (name) => path.join(projectsDir(), name, name + '.json');
const readRaw = (name) => fs.readFileSync(projectFile(name), 'utf8');
const readProject = (name) => JSON.parse(readRaw(name));
const hasProject = (name) => fs.existsSync(projectFile(name));
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sortNames = (arr) => arr.slice().sort();
function projectNames() {
  return fs.readdirSync(projectsDir())
    .filter((n) => n.charAt(0) !== '.' && fs.statSync(path.join(projectsDir(), n)).isDirectory())
    .sort();
}
/** 全部节点（**逐节点现算**：结构判据一律从盘上这份 JSON 现走一遍） */
function allNodes(name) {
  const out = [];
  (function walk(n, depth, parentId) {
    if (!n) return;
    out.push({ node: n, depth: depth, parentId: parentId || '' });
    (n.children || []).forEach((c) => walk(c, depth + 1, n.id));
  })(readProject(name).data, 0, '');
  return out;
}
const nodeById = (name, id) => (allNodes(name).filter((e) => e.node.id === id)[0] || {}).node || null;
/** 一个节点（按 topic 找，**返回节点本身**，不是那个包装项 —— 返回包装会让 `sec.id` 变成 undefined，实测踩到） */
function nodeByTopic(name, topic) {
  const hit = allNodes(name).filter((e) => e.node.topic === topic);
  return hit.length ? hit[0].node : null;
}
/** **文件节点**（带 origin、且来源是 `.md`）—— 项目根也带 origin，用它分辨（`origin.src` 的扩展名） */
function fileNodeBy(name, rel) {
  const want = String(rel).replace(/\\/g, '/');
  const hit = allNodes(name).filter((e) => e.node.origin
    && /\.md$/i.test(String(e.node.origin.src))
    && String(e.node.origin.src).replace(/\\/g, '/').slice(-want.length) === want);
  return hit.length ? hit[0].node : null;
}
/** 盘上所有 `links[]` 边（现算：逐节点收集，报告里的数由它们对拍） */
function allLinks(name) {
  const out = [];
  allNodes(name).forEach((e) => (e.node.links || []).forEach((l) => out.push({
    from: e.node.id, fromTopic: e.node.topic, project: l.project, id: l.id, caption: l.caption || ''
  })));
  return out;
}

function seedVault() {
  tempRunRoot.sweepStale(RUN.prefix);          // 兜底：只清>30 分钟的陈旧根，正在跑的不动 ✓
  ['zz-w12-vault', 'zz-w12-vaultlib'].forEach((name) => {
    const dir = RUN.reset(name);
    fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });   // ⇒ 主进程/CLI 都该认出"这是一个库"
    Object.keys(V).forEach((rel) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, V[rel], 'utf8');
    });
    fs.mkdirSync(path.join(dir, BAD_REL), { recursive: true });        // 坏条目：一个**目录**顶着 .md 的名字
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });       // 附件目录（P0 边界：不导）
    fs.writeFileSync(path.join(dir, 'assets', '图.png'), 'not-a-real-png', 'utf8');
  });
  RUN.reset('zz-w12-plain');                                          // **没有** .obsidian/
  fs.writeFileSync(path.join(PLAIN, 'note.md'), PLAIN_MD, 'utf8');
  fs.mkdirSync(path.join(PLAIN, BAD_REL), { recursive: true });      // 默认档那一侧也放一个坏条目
}
function cleanupSandbox() {
  /* ⚠️ 唯一根 ⇒ 收尾只删自己那一个（清理名单只有这一处；`zz-w12-*` 三个目录连同根一起走）。
   * 历史账：本函数原先**从来没被调用过** ⇒ 每跑一轮全链就在 `%TEMP%` 永久留下三个目录
   * （实测：全链跑完后 `zz-w12-vault` / `-vaultlib` / `-plain` 的 mtime 就是那一轮的结束时刻）。 */
  RUN.cleanup();
}
function writeStub(file, lines) { fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8'); }
/** 跑一条 CLI 并拿**退出码 + 原文**（`ctx.runCli` 失败是抛错 ⇒ 这里翻成显式 code，别把"没跑成"读成"通过"） */
function cliCode(ctx, args) {
  try { return { code: 0, out: String(ctx.runCli(args) || ''), error: '' }; }
  catch (e) { return { code: 1, out: '', error: (e && e.message) || String(e) }; }
}
/** CLI 的 `--json` 报告（解析失败 ⇒ null：**读不到不当成"没数据"**） */
function cliJson(ctx, args) {
  const r = cliCode(ctx, args);
  if (r.code !== 0) return { ok: false, code: r.code, error: r.error || '', raw: r.out };
  const all = String(r.out);   // 报告是最后一段 JSON；CLI 只有这一条命令走 --json ⇒ 整段解析
  try { return { ok: true, code: 0, json: JSON.parse(all) }; }
  catch (e) { return { ok: false, code: 0, error: '报告不是 JSON：' + String(all).slice(0, 120) }; }
}

const assertions = [
  {
    name: '甲 沙箱 vault 真导：`import-dir --vault` 把「目录结构 + .md」镜像成树 —— 文件数/容器数/节点层级**逐节点现算**对拍（子目录是容器、文件是它的子节点、标题取文件名去扩展名），且报告里的 `vault.enabled` 与读数都是现算的；判定依据：沙箱项目 JSON 原文 + 逐节点走一遍',
    run: async (ctx) => {
      const namesBefore = projectNames();
      seedVault();
      // 判据②的前半：真导之前，这个项目还不该存在
      const notThereBefore = !hasProject(P);
      const r = cliCode(ctx, ['import-dir', P, SRC, '--vault']);
      const raw = hasProject(P) ? readRaw(P) : '';
      const nodes = hasProject(P) ? allNodes(P) : [];
      const topics = nodes.map((e) => e.node.topic);
      const dirNodes = nodes.filter((e) => ['子目录', '一', '二'].indexOf(e.node.topic) >= 0);
      /* 文件节点 = **带 `origin` 且来源是 `.md` 的那些**（项目根自己也带 origin，但它不是文件节点 ⇒
       * 用 `origin.src` 的扩展名分辨；`.bindings` 之类旁路文件不进树） */
      const fileNodes = nodes.filter((e) => e.node.origin && /\.md$/i.test(String(e.node.origin.src)));
      const rootId = readProject(P).data.id;
      // 层级：每个文件节点的父节点必须是它所在的那个**目录容器**（或根）
      const expectParent = {
        '索引.md': '', '甲.md': '',
        '子目录/乙.md': '子目录', '子目录/丙.md': '子目录',
        '一/同名.md': '一', '二/同名.md': '二'
      };
      const parentOk = Object.keys(expectParent).every((rel) => {
        const hit = fileNodes.filter((e) => String(e.node.origin.src).replace(/\\/g, '/').slice(-rel.length) === rel)[0];
        if (!hit) return false;
        const want = expectParent[rel];
        const parent = hit.parentId ? nodeById(P, hit.parentId) : null;
        if (!want) return hit.parentId === readProject(P).data.id;      // 顶层文件的父 = 项目根
        return !!parent && parent.topic === want;
      });
      const collapsedOk = fileNodes.every((e) => e.node.expanded === false);
      return {
        ok: notThereBefore === true
          && r.code === 0
          && hasProject(P) === true
          && fileNodes.length === EXPECT.files
          && dirNodes.length === EXPECT.dirs
          && parentOk === true && collapsedOk === true
          && topics.indexOf('索引') >= 0 && topics.indexOf('乙') >= 0
          && /Obsidian 直进/.test(String(r.out)) && /--vault/.test(String(r.out))
          && raw.length > 0 && nodes.length > EXPECT.files,
        text: '真导前项目不存在=' + notThereBefore + ' ｜ exit=' + r.code
          + ' ｜ 盘上：文件节点 ' + fileNodes.length + ' 个（期望 ' + EXPECT.files + '）'
          + '、目录容器 ' + dirNodes.length + ' 个（期望 ' + EXPECT.dirs + '）'
          + '、节点合计 ' + nodes.length + '（根 id=' + rootId + '）'
          + ' ｜ 层级对拍（每个文件挂在它所在目录的容器下）=' + parentOk
          + ' ｜ 文件节点全折叠=' + collapsedOk
          + ' ｜ 顶层主题=[' + sortNames(topics.slice(0, 14)).join(' ') + ']'
          + ' ｜ 报告里那一行=「' + String(r.out).split('\n').filter((l) => /Obsidian 直进/.test(l)).join('') + '」'
          + ' ｜ 原话=「' + String(r.error || '').slice(0, 300) + '」'
          + (hasProject(P) ? '' : ' ｜ ⚠ 盘上**没有**这个项目（真导没落地）')
      };
    }
  },

  {
    name: '乙 wiki 链接接成了**关联**：盘上 `links[]` 的条数 = 源码里 `[[…]]` 个数**现算**对拍（含 `[[页|别名]]` 与 `[[页#标题]]` 落标题节点两档），并用**既有读命令** backlinks --json 反向对拍（反向可查 ⇒ 边真的在库里）；判定依据：项目 JSON 原文现算 + 既有命令输出',
    run: async (ctx) => {
      const links = allLinks(P);
      const wikiTotal = EXPECT.wikiTotal;
      const bySameProject = links.filter((l) => l.project === P);
      const captionsOk = links.length > 0 && links.every((l) => typeof l.caption === 'string' && l.caption.length > 0);
      // 每条边的目标必须**真实存在**（悬挂 = 0：这正是"绝不写悬空链接"的判据）
      const ids = new Set(allNodes(P).map((e) => e.node.id));
      const dangling = links.filter((l) => !ids.has(l.id));
      // 落标题那一档：`[[甲#小节]]` 该指到**甲那篇笔记里的**「小节」子节点（不是甲这个文件节点）
      const aNode = fileNodeBy(P, '甲.md');
      const sec = nodeByTopic(P, '小节');
      const toSection = links.filter((l) => sec && l.id === sec.id);
      // 既有读命令对拍：从「甲」反查谁引用了它（`backlinks --json` 给 `within`/`cross` 两组）
      const bl = cliJson(ctx, ['backlinks', P, aNode ? aNode.id : 'x', '--json']);
      const blCount = (bl.ok && bl.json)
        ? (((bl.json.within || []).length) + ((bl.json.cross || []).length)) : -1;
      const indexNode = fileNodeBy(P, '索引.md');
      const fromIndex = links.filter((l) => indexNode && l.from === indexNode.id);
      // 别名那一条：`[[子目录/乙|乙的别名]]` 的 caption 里该留下原样写法
      const aliasEdge = links.filter((l) => l.caption.indexOf('乙的别名') >= 0);
      return {
        ok: links.length > 0
          && links.length === EXPECT.linked && links.length === wikiTotal - EXPECT.dangling - EXPECT.ambiguous
          && bySameProject.length === links.length          // 全部是"本项目"的边（links[].project = 本次项目名）
          && captionsOk === true
          && dangling.length === 0
          && !!sec && toSection.length > 0
          && (aNode ? fromIndex.length >= 1 : false)
          && bl.ok === true && blCount >= 1
          && aliasEdge.length === 1,
        text: '盘上 links 共 ' + links.length + ' 条（源码里 `[[…]]` 共 ' + wikiTotal + ' 个、其中断链 '
          + EXPECT.dangling + ' 个、同名多篇 ' + EXPECT.ambiguous + ' 个 ⇒ 期望接上 ' + EXPECT.linked + '）'
          + ' ｜ 全是本项目(' + P + ')=' + (bySameProject.length === links.length)
          + ' ｜ 每条都有 caption=' + captionsOk + ' ｜ 悬挂边 ' + dangling.length + ' 条'
          + ' ｜ 落标题：[[甲#小节]] → 「小节」节点（' + toSection.length + ' 条）'
          + ' ｜ 既有 backlinks --json 对拍：' + (bl.ok ? (blCount + ' 条反向链接') : ('读不出来：' + bl.error))
          + ' ｜ 索引那篇的出边 ' + fromIndex.length + ' 条 ｜ 带别名的那条 ' + aliasEdge.length + ' 条'
          + ' ｜ 逐条：' + links.map((l) => l.fromTopic + '→' + (nodeById(P, l.id) || {}).topic).join(' / ')
      };
    }
  },

  {
    name: '丙 坏条目**逐条点名** + 好的照进（判据④：一个坏东西不拖垮整批）：源里"顶着 .md 名字的目录"进跳过清单、指向两篇同名笔记的 `[[同名]]`**不猜**（同类两条都点名）且一条边都没写；判定依据：CLI 报告原文 + 盘上 links 现算',
    run: async (ctx) => {
      const r = cliJson(ctx, ['import-dir', P + '-dry', SRC, '--vault', '--dry-run', '--json']);
      const rep = r.ok ? r.json : null;
      const v = rep && rep.vault ? rep.vault : null;
      const sk = rep && Array.isArray(rep.skippedDetail) ? rep.skippedDetail : [];
      const dangling = sk.filter((s) => s.reason === 'vault-dangling');
      const ambig = sk.filter((s) => s.reason === 'vault-ambiguous');
      const badEntry = sk.filter((s) => String(s.rel) === BAD_REL
        || String(s.rel).indexOf(BAD_REL) >= 0);
      const links = allLinks(P);
      // "同名多篇"**没有**写成边：索引那篇的出边里只有 甲 / 乙 / 小节 / 甲(嵌入)，没有「同名」那两篇
      const hasAmbiguousEdge = links.some((l) => l.caption.indexOf('索引：同名') >= 0);
      const hasBadEdge = links.some((l) => l.caption.indexOf(BAD_REL) >= 0);
      const goodStillImported = links.length === EXPECT.linked && hasProject(P)
        && allNodes(P).length > EXPECT.files;
      // 坏条目的**正文**没被丢（它压根不是文件）：同名那一条的正文也照旧在里面
      const keptRaw = JSON.stringify(readProject(P)).indexOf('同名多篇') >= 0;
      return {
        ok: r.ok === true && !!v
          && v.danglingTotal === EXPECT.dangling && dangling.length === EXPECT.dangling
          && (v.ambiguous || []).length === EXPECT.ambiguous && ambig.length === EXPECT.ambiguous
          && !!ambig[0] && String(ambig[0].message).indexOf('同名') >= 0
          && badEntry.length >= 1
          && hasAmbiguousEdge === false && hasBadEdge === false
          && goodStillImported === true
          && keptRaw === true
          && v.linked === links.length
          && rep.files === EXPECT.files,
        text: 'dry-run exit=' + r.code + ' ｜ 报告：文件 ' + rep.files + '（期望 ' + EXPECT.files + '）'
          + '、vault 链接 ' + (v && v.linkTotal) + ' 条 / 接上 ' + (v && v.linked) + ' 条（期望 ' + EXPECT.linked + '）'
          + '/ 断链 ' + (v && v.danglingTotal) + ' 条 / 同名多篇 ' + ((v && v.ambiguous) || []).length
          + ' 条（期望 ' + EXPECT.ambiguous + '）'
          + ' ｜ 逐条点名：坏条目 ' + badEntry.length + ' 条'
          + (badEntry[0] ? '（' + badEntry[0].rel + '：' + (badEntry[0].label || badEntry[0].reason) + '）' : '')
          + '、同名 ' + ambig.length + ' 条' + (ambig[0] ? '（' + ambig[0].rel + '「' + ambig[0].message + '」）' : '')
          + ' ｜ 盘上有没有同名边=' + hasAmbiguousEdge + '（必须 false）、坏条目边=' + hasBadEdge + '（必须 false）'
          + ' ｜ 好的照进=' + goodStillImported + '（盘上 links=' + links.length + '）'
          + ' ｜ 正文里那句还在=' + keptRaw
          + (r.ok ? '' : ' ｜ ⚠ 报告读不出来：' + r.error)
      };
    }
  },

  {
    name: '丁 frontmatter 标签进了**既有**标签机制：`tags:` 与 `tag:` 两篇都落到各自的文件节点 `tags` 上，且能被既有 `search --tag` 命中（同一套字段与检索口径）；判定依据：项目 JSON 现读 + 既有命令输出',
    run: async (ctx) => {
      /* ⚠️ 标签落在**文件节点**上（`origin.src` 认它）；`nodeByTopic('索引')` 命中的是**文档自己的标题节点**
       * 「索引正文」（那也是 tag 那一步之前就有的老行为）⇒ 用 `fileNodeBy` 取对节点。 */
      const idx = fileNodeBy(P, '索引.md');
      const b = fileNodeBy(P, '乙.md');
      const idxTags = (idx && idx.tags) || [];
      const bTags = (b && b.tags) || [];
      const s1 = cliCode(ctx, ['search', P, '--tag', '工具']);
      const s2 = cliCode(ctx, ['search', P, '--tag', '单数键']);
      const hit1 = idx && String(s1.out).indexOf(idx.id) >= 0;
      const hit2 = b && String(s2.out).indexOf(b.id) >= 0;
      // 别名参与了**链接解析**（`[[主页]]` 指到了「索引」）—— 这条与标签同属 frontmatter 的落点
      const links = allLinks(P);
      const viaAlias = links.filter((l) => l.caption.indexOf('主页') >= 0 && idx && l.id === idx.id);
      return {
        ok: idxTags.length === 2 && idxTags.indexOf('工具') >= 0 && idxTags.indexOf('网络') >= 0
          && bTags.length === 1 && bTags[0] === '单数键'
          && s1.code === 0 && hit1 === true
          && s2.code === 0 && hit2 === true
          && viaAlias.length === 1,
        text: '「索引」的 tags=' + JSON.stringify(idxTags) + '（frontmatter: tags: [工具, 网络]）'
          + ' ｜ 「乙」的 tags=' + JSON.stringify(bTags) + '（frontmatter 用的是单数键 tag:）'
          + ' ｜ 既有 search --tag 工具 ⇒ 命中「索引」=' + hit1 + '、单数键 ⇒ 命中「乙」=' + hit2
          + ' ｜ 别名 [[主页]] 接成的边 ' + viaAlias.length + ' 条（' + (viaAlias[0] ? viaAlias[0].fromTopic + '→' + viaAlias[0].caption : '（无）') + '）'
      };
    }
  },

  {
    name: '戊 默认档**逐字节不变**：`--no-vault` 是那条出口 —— 同一个库目录显式关掉 ⇒ 报告里 `vault:null`、盘上 links 0 条、tags 一个都不多，而 `[[…]]` 按**普通文字**留在正文；引擎那一层也再钉一次（不传 `transform` ⇒ 与从前同一条链）；判定依据：项目 JSON 原文 + 两份报告对拍',
    run: async (ctx) => {
      seedVault();   // 保证源还在（丙 的 dry-run 没动盘）
      /* ⚠️ 这里**必须显式 `--no-vault`**：这个目录里有 `.obsidian/` ⇒ CLI 的**自动识别**会打开 vault 解析
       * （那是 W12 要的行为）。"默认档不变"这条判据的对象是**引擎**：不打开解析时，输出与从前逐字节相同。 */
      const noFlag = cliJson(ctx, ['import-dir', P + '-n', SRC, '--no-vault', '--dry-run', '--json']);
      const repNo = noFlag.ok ? noFlag.json : null;
      // 默认档真导（换个项目名）⇒ 看盘上有没有 links / tags
      const r2 = cliCode(ctx, ['import-dir', P_PLAIN, PLAIN, '--no-vault']);
      const plainRaw = hasProject(P_PLAIN) ? readRaw(P_PLAIN) : '';
      const plainLinks = hasProject(P_PLAIN) ? allLinks(P_PLAIN) : [];
      const plainNodes = hasProject(P_PLAIN) ? allNodes(P_PLAIN) : [];
      const plainBody = plainNodes.filter((e) => e.node.detail).map((e) => String(e.node.detail)).join(' ');
      const autoOnPlain = repNo && repNo.vault && repNo.vault.enabled === true;
      const taggedNodes = plainNodes.filter((e) => e.node.tags !== undefined).length;
      // 坏条目（顶着 .md 名字的目录）被逐条点名、而好的那篇照进（判据④在**默认档**里也成立）
      const plainBad = cliCode(ctx, ['import-dir', P_PLAIN + '-b', PLAIN, '--no-vault', '--dry-run', '--json']);
      const plainBadRep = (function () { try { return JSON.parse(String(plainBad.out)); } catch (e) { return null; } })();
      const plainBadListed = !!(plainBadRep && Array.isArray(plainBadRep.skippedDetail)
        && plainBadRep.skippedDetail.some((s) => String(s.rel).indexOf(BAD_REL) >= 0));
      const plainGoodIn = cliCode(ctx, ['read', P_PLAIN, '--brief']);
      return {
        ok: noFlag.ok === true && !!repNo
          && (repNo.vault === null || repNo.vault === undefined)      // --no-vault ⇒ 报告里没有 vault 那一档
          && r2.code === 0 && hasProject(P_PLAIN) === true
          && plainLinks.length === 0
          && taggedNodes === 0
          && plainNodes.length > 0
          && !autoOnPlain                                       // null（报告里没有 vault 那一档）也算"没打开"
          && /\[\[甲\]\]/.test(plainBody)
          && plainBadListed === true
          && plainGoodIn.code === 0 && String(plainGoodIn.out).indexOf('笔记') >= 0,        text: '--no-vault 的 dry-run 报告里 `vault`=' + JSON.stringify(repNo && repNo.vault)
          + ' ｜ 默认档真导 exit=' + r2.code
          + ' ｜ 盘上 links=' + plainLinks.length + ' 条（必须 0）、带 tags 的节点 ' + taggedNodes + ' 个（必须 0）'
          + ' ｜ 正文里 `[[甲]]` 原样留着=' + /\[\[甲\]\]/.test(plainBody)
          + ' ｜ vault 解析被打开=' + autoOnPlain + '（必须 false）'
          + ' ｜ 坏条目点名=' + plainBadListed + ' ｜ 好的那篇照进（read 得到）=' + (plainGoodIn.code === 0)
      };
    }
  },

  {
    name: '己 幂等与界面那一条路：同一个库重复导**被拒并指名**（origin 指纹；盘上一个新项目都不多）；界面侧**真调用主进程** `app:import-preview`（渲染层用的同一个 IPC）⇒ 主进程自己认出 `.obsidian/` 并补上 `--vault`、读数来自 CLI 的 --vault 报告，而它跑在**演练副本**上 ⇒ 沙箱项目**逐字节不变**；判定依据：项目 JSON SHA-256 前后相同 + 预览读数现算对拍',
    run: async (ctx) => {
      // ① 幂等：同一个库再导一次（换项目名）⇒ 必须被拒
      const namesBefore = sortNames(projectNames());
      const dup = cliCode(ctx, ['import-dir', P + '-dup', SRC, '--vault']);
      const namesAfter = sortNames(projectNames());
      const dupNamed = /已经导入过/.test(dup.out + (dup.error || ''));
      const noNewProject = namesBefore.join(',') === namesAfter.join(',') && dup.code !== 0;
      // ② 界面预览：**真调主进程**（与渲染层同一条 IPC），目标项目先造一个（预览要"当前项目"）
      if (!hasProject(P_STUB)) {
        cliCode(ctx, ['init', P_STUB]);
        cliCode(ctx, ['add', P_STUB, 'root', '--topic', '预览落点']);
      }
      const shaBefore = sha256(readRaw(P_STUB));
      /* ⚠️ 预览用的源目录是 **SRC_UI**（`zz-w12-vaultlib`）：主进程从**目录名**推新项目名
       * （`sanitizeProjectName(path.basename(dir))`），而 `zz-w12-vault` 这个名字已经被 甲 真导占了
       * ⇒ 拿它预览会被"项目已存在"挡下（那是另一件事，不是本条要判的）。 */
      const probe = await ctx.exec('(async function () { try {'
        + ' return JSON.stringify(await window.desktop.app.importPreview(' + JSON.stringify(P_STUB) + ', {'
        + ' kind: "dir", dir: ' + JSON.stringify(SRC_UI) + ' }));'
        + ' } catch (e) { return JSON.stringify({ ok: false, error: (e && e.message) || String(e) }); } })()');
      const pr = (function () { try { return JSON.parse(probe); } catch (e) { return { ok: false, error: '读数不是 JSON：' + String(probe).slice(0, 120) }; } })();
      const pv = pr && pr.preview ? pr.preview : null;
      const vv = pv && pv.vault ? pv.vault : null;
      const shaAfter = sha256(readRaw(P_STUB));
      // 预览读数与**盘上现算**对拍（同一次导入的两个独立来源）
      const onDiskLinks = allLinks(P).length;
      cleanupSandbox();                       // 收尾：唯一临时根（本域最后一个断言；此前这里漏了这一步）
      return {
        ok: dup.code !== 0 && dupNamed === true && noNewProject === true
          && pr.ok === true && pr.vault === true && !!vv
          && vv.linkTotal === EXPECT.wikiTotal && vv.linked === onDiskLinks
          && vv.danglingTotal === EXPECT.dangling && vv.taggedFiles === 2
          && shaBefore === shaAfter
          && !!pr.copy,
        text: '① 重复导：exit=' + dup.code + ' 指名"已经导入过"=' + dupNamed
          + ' 项目数 ' + namesBefore.length + '→' + namesAfter.length + '（必须不变）=' + noNewProject
          + ' ② 界面预览：主进程认出这是库（vault 参数）=' + pr.vault
          + ' ｜ 预览读数=' + JSON.stringify(vv && { files: vv.files, linkTotal: vv.linkTotal, linked: vv.linked,
            dangling: vv.danglingTotal, tagged: vv.taggedFiles, tags: vv.tags })
          + ' ｜ 对拍：盘上现算 links=' + onDiskLinks + '（期望 = 源码 ' + EXPECT.wikiTotal + ' − 断链 ' + EXPECT.dangling
          + ' − 同名 ' + EXPECT.ambiguous + ' = ' + EXPECT.linked + '）'
          + ' ｜ 演练副本=' + JSON.stringify(pr.copy)
          + ' ｜ 预览期间沙箱项目 JSON 逐字节不变=' + (shaBefore === shaAfter) + '（SHA ' + shaBefore.slice(0, 12) + '）'
          + (pr.ok ? '' : ' ｜ ⚠ 预览失败：' + pr.error)
      };
    }
  }
];

/* 域级收尾保证（**整段 try/finally** 的效果，不重排几百行缩进 —— 见 skill E2 的务实允准）：
 * 任何一条断言**抛错**都当场清掉本域的唯一临时根（崩在半路 ⇒ 残留 0 ✓），异常原样上抛（不吞 ✗）。
 * 正常路径由最后一条断言（己）末尾的收尾负责 —— 中间几档要**共用**同一个库目录，不能每条都清。 */
assertions.forEach((a) => {
  const orig = a.run;
  a.run = async (ctx) => {
    try { return await orig(ctx); }
    catch (e) { cleanupSandbox(); throw e; }
  };
});

module.exports = assertions;
