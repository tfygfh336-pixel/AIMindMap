/* ============================================================
 * tests/import-md-landing.test.js — 【W14】前导正文的**落点规则**（import-md）
 * 运行：npx vitest run tests/import-md-landing.test.js
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md` 的 W14 一行 + 本批工单的 D1/D2。
 *
 * ## 修的是什么（两个真症状，都不是"不好看"）
 *   ① **D1（硬失败）**：`import-md --parent <已条目化的节点>` 且 md 有前导正文（第一个标题**之前**
 *      的正文）时，旧实现把前导**字符串拼进父节点 `detail`** ⇒ `detail` 不再等于
 *      `renderDetail(items)` ⇒ 写前校验判红 ⇒ **整个导入 exit 1**（连标题子树一起没导进去）。
 *      而它给出的出路是 `render-detail` —— 照做会把**刚导进来的前导删掉** ✗。
 *   ② **D2（预览说谎）**：同一条用例 `--dry-run` **exit 0** 并回显"前导正文…已并入父节点 …
 *      的**详情开头**"。因为 dry-run 在任何写盘之前短路，跑不到写前校验 ⇒ 预览与真跑**分叉**。
 *      这条是 W8 的通用性质（registry 里 `import-dir` 的"预览与真导必须同一份判据"就是它）。
 *
 * ## 本文件钉住的判据（每条都能红）
 *   A. **D1 修好**：条目化父节点能正常导入；前导成为**首条条目**（`items[0]`），原有条目**顺序不变**
 *      地排在它后面；`detail` 是 `renderDetail(items)` 的逐字节重建；回显**点名**落点。
 *   B. **一个字符都不许丢**：从夹具切出第一个 `^#{1,6} ` 之前的原文，**去标签 + 归一化空白**后与
 *      **落盘文本**逐字相等（不是 `toContain` 探针短语）。夹具带哨兵段：中英标点 + `**加粗**` +
 *      ``` 围栏（围栏里还有一行 `# …`）+ 图片行。剥壳规则与切点**在下面显式声明**（见 `expectPreambleText`）。
 *   C. **落点与"非条目化父节点"那条路等价**：分隔换行按 `renderDetail` 的拼装表落在后一条的 `_gap`
 *      上 ⇒ 结果都是 `前导 + '\n' + 原内容`；父节点非条目化时 `items` 键**一个都不许出现**。
 *   D. **负例（§54 的既有负例）**：md 开头就是标题 ⇒ **不产生空 detail、不产生空条目**（父节点是
 *      条目化节点时也一样 —— 只在真有前导时才动 `items`）。
 *   E. **单一真源（§54 的 occ 判据）**：同一段前导正文不许复制到**多个节点**。非条目化父节点上
 *      `occ === 1`（与 §54 逐字同口径）；条目化父节点上它按契约必须是**一个节点**里的
 *      `items[0].html` + 该节点 `detail` 的派生副本（`docs/ITEM-MODEL.md` §2 规定二者逐字节相等
 *      ⇒ 出现 2 次是同一条数据的两种表示，不是漂移）。
 *   F. **边界响亮拒绝 + 给出路**：父节点有 `items` 但它的 `detail` 已与 `renderDetail(items)` 不一致
 *      （数据被写坏）⇒ 拒绝，报文点名「父节点已**条目化**」并给出**真出路**（换父节点 / 先 item-add
 *      再导 / 先 render-detail 修好父节点），**盘上零改动**；且报文里**不许**出现"删掉刚导入的内容"
 *      那条误导（旧报文的 `render-detail` 就是它）。
 *   G. **D2 同判（import-md 这一路）**：真跑与预览各跑一个**同构项目**（同一套命令逐字建成）⇒
 *      两次读数必须同判；本文件钉的是"预览说成 ⇒ 真跑必成"这一半（另一半"真跑必失败 ⇒ 预览必失败"
 *      钉在 tests/w8-dry-run.test.js 的 W8-G，用**同一份判据**的通用形态）。
 *   H. **MCP 也是同一路**：`import_markdown` 透传到 `import-md` ⇒ 同一条用例经 MCP 也必须成功
 *      （MCP 侧不另写一份落点规则）。
 *
 * ## 判别力证明（"修前红"的两次真实读数，见交付说明）
 *   · D1/D2 这两组断言**修前本来就是红的**，不需要造注入：HEAD（fa884f3）上同一条命令
 *     真跑 `exit 1`（`校验失败: [n-…] detail 与 items 不一致…`）、`--dry-run` 却 `exit 0` 并回显
 *     "已并入父节点 …的**详情开头**"。本文件 A/B/G 三组在那种实现下必红。
 *   · B 组的**注入证明**（还原 `src/markdown.js` 里前导的收集）由 `tests/markdown.test.js` 的
 *     5 条同族断言承担（同一处注入点）；本文件 B 组是它在**端到端**上的同一条判据。
 *   · 本文件另带一条**自带判别力**的构造（见 describe D1 的第 3 条断言）：把前导**手拼**进
 *     条目化父节点的 `detail`（= 旧实现的做法）写盘 ⇒ `node cli/mm-cli.js add …` 必红。
 *     它证明"那道判红的闸真的在拦"，而不是"本文件刚好没触发它"。
 *
 * ## 环境要点（改这个文件前先读）
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js`
 *      **之前**设好（`cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的），并在下面**当场自证**。
 *   2) **不起子进程**：端到端一律进程内 `invokeSync`（MCP 那一拍走 `mcp.callTool`，它自己那层
 *      按脚本既有方式起 CLI 子进程，见 scripts/mcp-server.js 的 runCli）。
 *   3) 夹具与沙箱都在 `os.tmpdir()` 下的临时目录里，`afterAll` 清干净（项目根与夹具目录分开：
 *      夹具目录**不在**项目根里，免得被 `projects` 扫到）。
 *
 * 服务哪条卖点：`卖点.md` **卖点 4**（"导入即可用"：把现成文档变成可用的知识树）——
 * 本条修的是"**有正文的文档导不进已经条目化的节点**"这个硬失败；顺带守住 **卖点 1**
 * （"给 AI 的可写可校知识库"）里"**可校**"的那一半：预览与真跑必须同判。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ----
 * 两个根都走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记），收尾只此一处（下面的 `afterAll`）。 */
const SANDBOX = makeTmp('mm-w14-land-');
const FIXDIR = makeTmp('mm-w14-landfix-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const itemModel = require('../src/item-model.js');
const mcp = require('../scripts/mcp-server.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/`。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

afterAll(() => {
  cleanupAll();
});

/* ============================================================================
 * 夹具（逐字节固定；带哨兵段）
 * ========================================================================== */
const MD_NOLEAD = '# 一级标题\n一级正文\n\n## 二级标题\n二级正文\n';
const MD_LEAD = [
  '哨兵甲：中文、英文；标点（全角）与半角, . !? 混排。Sentinel-Alpha-2026。',
  '**加粗哨兵**与普通文字相邻。',
  '',
  '```js',
  '# 这行的井号是代码，不是标题',
  "const sentinel = 'SENTINEL-CODE-7f3a';",
  '```',
  '',
  '![图：哨兵](assets/a.png)',
  '',
  '# 主题甲',
  '甲正文',
  ''
].join('\n');

const FIX_NOLEAD = path.join(FIXDIR, 'nolead.md');
const FIX_LEAD = path.join(FIXDIR, 'lead.md');
fs.writeFileSync(FIX_NOLEAD, MD_NOLEAD, 'utf8');
fs.writeFileSync(FIX_LEAD, MD_LEAD, 'utf8');

/**
 * "一个字符都不许丢"的**左边**：从夹具切出第一个 `^#{1,6} ` 之前的原文，再按下面**声明的**规则
 * 变成纯文本。切点与剥壳规则都写在这里，不隐式猜：
 *   · 切点 = 第一个**不在围栏内**的 `^#{1,6} ` 行（围栏里的 `#` 本来就不是标题 —— 夹具里那行
 *     `# 这行的井号是代码，不是标题` 正是用来钉这一点的；口径与 `src/markdown.js` 的建树主循环一致）；
 *   · 剥壳①：围栏**定界行**（```…）是语法不是正文（围栏**里面**的行是正文，一个字都不许少）；
 *   · 剥壳②：图片行 `![alt](src)` 不给正文贡献文本（`<img>` 的 alt 落在属性里，没有文本内容）；
 *   · 剥壳③：`**加粗**` 的强调标记剥离（`<strong>x</strong>` 的文本就是 x）。
 * 之后归一化空白（换行/缩进折叠成单空格）——**空白单独声明为不参与**这条判据。
 */
function expectPreambleText(md) {
  const kept = [];
  let fenced = false;
  let stopped = false;
  md.split('\n').forEach((line) => {
    if (stopped) return;
    const t = line.trim();
    if (/^```/.test(t)) { fenced = !fenced; return; }
    if (!fenced && /^#{1,6} /.test(t)) { stopped = true; return; }
    if (/^!\[/.test(t)) return;
    kept.push(line);
  });
  return kept.join('\n').replace(/\*\*/g, '');
}
/** 落盘文本：**剥标签（替换成空串，不是空格）+ 解实体** + 归一化空白 */
function landedText(html) {
  return String(html == null ? '' : html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/gi, '&');
}
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const EXPECT_PREAMBLE = norm(expectPreambleText(MD_LEAD));

/* ============================================================================
 * 工具
 * ========================================================================== */
const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const readProject = (name) => JSON.parse(fs.readFileSync(projFile(name), 'utf8'));
const bytesOf = (name) => fs.readFileSync(projFile(name));
/** 跑一条命令（进程内同步）：返回 `{ code, out }`（stdout + stderr，与集成脚本同口径） */
function run(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}
/** `get <项目> <节点> --json --detail` —— **不带 `--detail` 时 detail 根本不出现**，必须是这条读口 */
function getView(name, id) {
  const r = run(['get', name, id, '--json', '--detail']);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.out);
}
function findNode(root, topic) {
  let hit = null;
  (function walk(n) { if (hit) return; if (n.topic === topic) { hit = n; return; } (n.children || []).forEach(walk); })(root);
  return hit;
}
/** 每次用例都从**同一个已知起点**开始：新建项目 → 导一棵不带前导的树 → 把那个节点条目化 */
function projectWithItemizedParent(name) {
  run(['init', name, '--title', 'W14 夹具项目']);
  run(['import-md', name, FIX_NOLEAD, '--parent', 'root']);
  const id = findNode(readProject(name).data, '一级标题').id;
  const add = run(['item-add', name, id, '--md', '原有详情：导之前就在。']);
  expect(add.code, add.out).toBe(0);
  return id;
}

/* ============================================================================
 * A/B/C/E：D1 修好 + 一个字符都不许丢 + 落点规则
 * ========================================================================== */
describe('【W14】D1：import-md 撞"已条目化的父节点"——能导，且前导落成首条条目', () => {
  const P = 'w14-itemized';
  it('A1 真跑 exit 0；前导成为 items[0]（rich），原有条目顺序不变地跟在后面', () => {
    const pid = projectWithItemizedParent(P);
    const before = findNode(readProject(P).data, '一级标题');
    const oldItems = before.items.map((it) => it.id);
    const r = run(['import-md', P, FIX_LEAD, '--parent', pid]);
    expect(r.code, '真跑必须成功（修前是 exit 1：detail 与 items 不一致）: ' + r.out).toBe(0);
    expect(r.out).not.toContain('校验失败');

    const after = findNode(readProject(P).data, '一级标题');
    expect(after.items.length).toBe(oldItems.length + 1);
    expect(after.items[0].type).toBe('rich');
    expect(landedText(after.items[0].html)).toContain('哨兵甲');
    expect(after.items.slice(1).map((it) => it.id)).toEqual(oldItems);      // 顺序不变
    // 落点是**开头**：detail 逐字节以 items[0].html 开头
    expect(after.detail.indexOf(after.items[0].html)).toBe(0);
    // 子节点照旧加在那批条目后面（前导落点不影响子树）
    expect(findNode(readProject(P).data, '主题甲')).toBeTruthy();
    // 回显点名落点（不静默落盘）
    expect(r.out).toMatch(/前导正文/);
    expect(r.out).toMatch(/首条条目/);
    expect(r.out).toMatch(new RegExp(pid));
  });

  it('A2 落盘不变量：detail 逐字节等于 renderDetail(items)（写前校验的那条判据）', () => {
    projectWithItemizedParent('w14-itemized2');
    const r = run(['import-md', 'w14-itemized2', FIX_LEAD, '--parent',
      findNode(readProject('w14-itemized2').data, '一级标题').id]);
    expect(r.code, r.out).toBe(0);
    const node = findNode(readProject('w14-itemized2').data, '一级标题');
    expect(node.detail).toBe(itemModel.renderDetail(node.items));
    // 走 CLI 读口读回来的是同一份（`get --json --detail`）
    const view = getView('w14-itemized2', node.id);
    expect(view.detail).toBe(itemModel.renderDetail(node.items));
    expect(view.items.length).toBe(node.items.length);
  });

  it('A3 判别力（自带）：把前导**手拼**进条目化父节点的 detail（旧实现的做法）⇒ 写前校验必红', () => {
    const P3 = 'w14-handconcat';
    const pid = projectWithItemizedParent(P3);
    // 旧实现写下去的就是这个形状：detail 前置了前导，items 一个没动
    const obj = readProject(P3);
    const node = findNode(obj.data, '一级标题');
    node.detail = '<p>手拼的前导正文</p>\n' + node.detail;
    fs.writeFileSync(projFile(P3), JSON.stringify(obj, null, 2), 'utf8');
    const r = run(['add', P3, 'root', '--topic', '任意一次写操作']);
    expect(r.code, '这份数据必须被判红（这正是修前 import-md 失败的那道闸）').toBe(1);
    expect(r.out).toContain('校验失败');
    expect(r.out).toMatch(/detail 与 items 不一致/);
  });

  it('B1 【一个字符都不许丢】落盘前导文本与夹具前导原文**归一化后逐字相等**', () => {
    const P4 = 'w14-sentinel';
    const pid = projectWithItemizedParent(P4);
    const topicsBefore = (findNode(readProject(P4).data, '一级标题').children || []).map((c) => c.topic);
    const r = run(['import-md', P4, FIX_LEAD, '--parent', pid]);
    expect(r.code, r.out).toBe(0);
    const node = findNode(readProject(P4).data, '一级标题');
    // ⭐ 这条判据的**全部内容**：落盘文本 == 夹具里第一个标题之前的原文（归一化空白后逐字相等）
    const got = norm(landedText(node.items[0].html));
    expect(got, '左=' + JSON.stringify(EXPECT_PREAMBLE) + '\n右=' + JSON.stringify(got)).toBe(EXPECT_PREAMBLE);
    // 哨兵里的三类构造逐条钉住（不是探针短语，是"这段必须在、且还原成这个样子"）
    expect(got).toContain('半角, . !?');                       // 中英标点混排
    expect(got).toContain('加粗哨兵');                          // **加粗** 的文本
    expect(got).not.toContain('**');                           // …强调标记不许留在文本里
    expect(got).toContain('# 这行的井号是代码，不是标题');        // 围栏里的 `#` 是正文
    expect(got).toContain("const sentinel = 'SENTINEL-CODE-7f3a';");
    // 围栏里那行 `#` **不许**变成子节点：这次导入只多出「主题甲」一个顶层主题
    const topicsAfter = (findNode(readProject(P4).data, '一级标题').children || []).map((c) => c.topic);
    expect(topicsAfter).toEqual(topicsBefore.concat(['主题甲']));
    expect(findNode(readProject(P4).data, '这行的井号是代码，不是标题')).toBeFalsy();
  });

  it('C1 落点与"非条目化父节点"那条路**等价**：都是 `前导 + \\n + 原内容`', () => {
    const PA = 'w14-plainparent';
    run(['init', PA, '--title', 'W14 普通父节点']);
    run(['add', PA, 'root', '--id', 'p-plain', '--topic', '普通父节点', '--detail', '<p>原有详情</p>']);
    const r = run(['import-md', PA, FIX_LEAD, '--parent', 'p-plain']);
    expect(r.code, r.out).toBe(0);
    const plain = findNode(readProject(PA).data, '普通父节点');
    expect(plain.items, '非条目化父节点上不许出现 items 键').toBeUndefined();
    expect(plain.detail.endsWith('\n<p>原有详情</p>')).toBe(true);

    const PI = 'w14-itemized3';
    const iid = projectWithItemizedParent(PI);
    const before = findNode(readProject(PI).data, '一级标题');
    const oldDetail = before.detail;
    const r2 = run(['import-md', PI, FIX_LEAD, '--parent', iid]);
    expect(r2.code, r2.out).toBe(0);
    const node = findNode(readProject(PI).data, '一级标题');
    // 前导那一段的**字节**与非条目化路完全一致：`plain.detail` 去掉尾部旧内容 == 前导 HTML
    expect(node.detail).toBe(node.items[0].html + '\n' + oldDetail);
    expect(plain.detail).toBe(node.items[0].html + '\n<p>原有详情</p>');
  });

  it('E1 【单一真源】前导只落一个节点：非条目化父节点 occ===1；条目化父节点也只在**同一节点**里', () => {
    const PS = 'w14-occ';
    const pid = projectWithItemizedParent(PS);
    expect(run(['import-md', PS, FIX_LEAD, '--parent', pid]).code).toBe(0);
    /* 扫描面声明：**项目 JSON 文件全文**（不剥注释、不剥字符串 —— JSON 里没有注释，字符串就是数据本身）。
     * 条目化节点上前导按契约有两处表示：`items[0].html` 与它的派生缓存 `detail`（二者逐字节相等）。 */
    const nodes = [];
    (function walk(n) {
      let c = (String(n.detail || '').match(/哨兵甲/g) || []).length;
      (Array.isArray(n.items) ? n.items : []).forEach((it) => { c += (String(it.html || '').match(/哨兵甲/g) || []).length; });
      if (c) nodes.push({ id: n.id, count: c });
      (n.children || []).forEach(walk);
    })(readProject(PS).data);
    expect(nodes.length, '同一段前导正文不许出现在两个节点里：' + JSON.stringify(nodes)).toBe(1);
    expect(nodes[0].count).toBe(2);                      // items 正文 + detail 派生副本（同一节点内）

    const PP = 'w14-occ-plain';
    run(['init', PP, '--title', 'W14 occ 普通']);
    run(['add', PP, 'root', '--id', 'p-plain', '--topic', '普通父节点']);
    expect(run(['import-md', PP, FIX_LEAD, '--parent', 'p-plain']).code).toBe(0);
    // §54 的 occ===1：非条目化父节点上**字面**只出现一次（没有 items ⇒ 没有派生副本）
    const raw = fs.readFileSync(projFile(PP), 'utf8');
    expect((raw.match(/哨兵甲/g) || []).length, '非条目化路：落盘文件里只许出现一处').toBe(1);
  });

  it('D1 【负例】md 开头就是标题 ⇒ 不产生空 detail、不产生空条目（条目化父节点上同理）', () => {
    const PN = 'w14-none';
    const pid = projectWithItemizedParent(PN);
    const beforeNode = findNode(readProject(PN).data, '一级标题');
    const beforeItems = beforeNode.items.length;
    const beforeDetail = beforeNode.detail;
    const beforeBytes = bytesOf(PN);
    const r = run(['import-md', PN, FIX_NOLEAD, '--parent', pid, '--force']);
    expect(r.code, r.out).toBe(0);
    const node = findNode(readProject(PN).data, '一级标题');
    expect(node.items.length, '没有前导 ⇒ 一条条目都不该多').toBe(beforeItems);
    expect(node.detail, '父节点 detail 一个字节都不该动').toBe(beforeDetail);
    expect(bytesOf(PN).equals(beforeBytes), '对照组：子节点是真加了（不是"什么都没做"）').toBe(false);
    // 非条目化父节点：不制造空 detail 键
    const PR = 'w14-none-root';
    run(['init', PR, '--title', 'W14 负例']);
    run(['import-md', PR, FIX_NOLEAD, '--parent', 'root']);
    const r2 = run(['import-md', PR, FIX_NOLEAD, '--parent', 'root', '--force']);
    expect(r2.code, r2.out).toBe(0);
    const rootView = getView(PR, 'root');
    expect(rootView.detail, '开头就是标题 ⇒ 不产生空 detail 字段').toBeUndefined();
    expect(rootView.items).toBeUndefined();
  });
});

/* ============================================================================
 * F：边界 —— 响亮拒绝 + 两条真出路（不许静默降级、不许把人引向"删掉刚导的内容"）
 * ========================================================================== */
describe('【W14】边界：父节点已条目化但数据是坏的 ⇒ 响亮拒绝 + 给真出路，盘上零改动', () => {
  /** 造一个"有 items、但 detail 与 renderDetail(items) 不一致"的项目（外部工具写坏的形态） */
  function brokenItemizedParent(name, items) {
    const obj = {
      meta: { name: 'W14 坏父节点', author: '', version: '0.0.0-test', formatVersion: 2 },
      format: 'node_tree',
      data: {
        id: 'root', topic: 'W14 坏父节点', expanded: true,
        children: [{
          id: 'n-broken', topic: '坏掉的条目化父节点', expanded: true, children: [],
          items: items, detail: '<p>派生缓存与 items 对不上</p>'
        }]
      }
    };
    fs.mkdirSync(path.join(SANDBOX, name), { recursive: true });
    fs.writeFileSync(projFile(name), JSON.stringify(obj, null, 2), 'utf8');
    return 'n-broken';
  }

  it('F1 detail 与 items 不一致 ⇒ exit 1、点名"父节点已条目化"、给出两条真出路、盘上逐字节不变', () => {
    const P = 'w14-broken';
    const id = brokenItemizedParent(P, [{ id: 'i-x', type: 'text', html: '<p>真源</p>', at: '2026-01-01T00:00:00.000Z', by: 'test' }]);
    const before = bytesOf(P);
    const r = run(['import-md', P, FIX_LEAD, '--parent', id]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('已**条目化**');
    expect(r.out).toContain('item-add');                       // 出路之一：先自己把前导加成条目
    expect(r.out).toContain('--parent');                       // 出路之二：换父节点
    expect(r.out).toMatch(/盘上零改动/);
    expect(bytesOf(P).equals(before), '拒绝必须是干净的：盘上一个字节都不许动').toBe(true);
    // 旧报文把人引向"render-detail 修一下" —— 照做会把**刚导进来的前导**删掉；新报文只在
    // "父节点本来就已经坏了"这一档才提它，且说清代价（抹掉缓存里多出来的内容）
    expect(r.out).toMatch(/缓存被写坏了/);
  });

  it('F2 items 存在但不是数组（坏数据）⇒ 同样响亮拒绝，不静默走"非条目化"那条路', () => {
    const P = 'w14-broken2';
    const id = brokenItemizedParent(P, undefined);
    const obj = readProject(P);
    findNode(obj.data, '坏掉的条目化父节点').items = { not: 'an array' };
    fs.writeFileSync(projFile(P), JSON.stringify(obj, null, 2), 'utf8');
    const before = bytesOf(P);
    const r = run(['import-md', P, FIX_LEAD, '--parent', id]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('已**条目化**');
    expect(r.out).toMatch(/items` 不是数组/);
    expect(bytesOf(P).equals(before)).toBe(true);
  });

  it('F3 拒绝的**同一份判据**也管住 --dry-run（D2 性质在拒绝档上的形态）', () => {
    const P = 'w14-broken3';
    const id = brokenItemizedParent(P, [{ id: 'i-y', type: 'text', html: '<p>真源</p>', at: '2026-01-01T00:00:00.000Z', by: 'test' }]);
    const real = run(['import-md', P, FIX_LEAD, '--parent', id]);
    const dry = run(['import-md', P, FIX_LEAD, '--parent', id, '--dry-run']);
    expect(real.code, real.out).toBe(1);
    expect(dry.code, '预览必须也失败（修前这里 exit 0 并回显"已并入父节点详情开头"）: ' + dry.out).toBe(1);
    expect(dry.out.startsWith('error: ')).toBe(true);
    expect(dry.out).toContain('已**条目化**');
  });
});

/* ============================================================================
 * G：D2 —— 预览与真跑**同判**（"预览说成 ⇒ 真跑必成"这一半）
 * ========================================================================== */
describe('【W14】D2：--dry-run 与真跑同判（同一条用例，两个同构项目）', () => {
  it('G1 预览 exit 0 且计划说得清"改了 items"；真跑 exit 0 且日志里的类型计数与计划一致', () => {
    const REAL = 'w14-g-real';
    const DRY = 'w14-g-dry';
    const rid = projectWithItemizedParent(REAL);
    const did = projectWithItemizedParent(DRY);
    // 两个项目同构（节点 id 与时间戳是随机/时钟产物 ⇒ 只比结构）
    const shape = (s) => s.replace(/"(n|i)-[a-z0-9]+"/g, '"ID"').replace(/"\d{4}-\d\d-\d\dT[^"]*"/g, '"AT"')
      .replace(/"src":"[^"]*"/g, '"src":"SRC"');
    expect(shape(JSON.stringify(readProject(REAL)))).toBe(shape(JSON.stringify(readProject(DRY))));

    const dry = run(['import-md', DRY, FIX_LEAD, '--parent', did, '--dry-run']);
    expect(dry.code, dry.out).toBe(0);
    const real = run(['import-md', REAL, FIX_LEAD, '--parent', rid]);
    expect(real.code, real.out).toBe(0);
    expect(dry.code, '预览与真跑必须同判（修前：真跑 1 / 预览 0）').toBe(real.code);

    // 计划里的**类型计数**与真跑后变更日志里的类型计数逐字相等（W8 判据③的既有口径）
    const kindsOf = (keys) => {
      const o = {};
      keys.forEach((k) => { const kind = k.indexOf(':') < 0 ? k : k.slice(0, k.indexOf(':')); o[kind] = (o[kind] || 0) + 1; });
      return o;
    };
    const planLine = dry.out.split('\n').filter((l) => l.indexOf('这次写盘将改动') >= 0)[0] || '';
    const planKeys = (/(?:：)(.+)$/.exec(planLine.replace(core.DRY_RUN_TAG.trim() + ' ', '')) || [])[1];
    const planKinds = kindsOf(planKeys ? planKeys.split('、').map((s) => s.trim()).filter(Boolean) : []);
    const entries = fs.readFileSync(path.join(SANDBOX, REAL, '.changes.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const realKinds = kindsOf((entries[entries.length - 1] || {}).changed || []);
    expect(planKinds).toEqual(realKinds);
    expect(planKinds.item, '条目增删必须在计划里看得见（旧实现只报 children/node）').toBeGreaterThan(0);
    expect(planKinds.items).toBeGreaterThan(0);
  });
});

/* ============================================================================
 * H：MCP 是同一路（不另写落点规则）
 * ========================================================================== */
describe('【W14】MCP：import_markdown 透传到 import-md（同一条落点规则）', () => {
  it('H1 经 MCP 导入到条目化父节点也成功，且前导同样落在 items[0]', () => {
    const P = 'w14-mcp';
    const pid = projectWithItemizedParent(P);
    const r = mcp.callTool('import_markdown', { project: P, file: FIX_LEAD, parent: pid });
    expect(r.ok, 'MCP 这条路不许失败: ' + JSON.stringify(r)).toBe(true);
    expect(r.text).not.toMatch(/校验失败/);
    const node = findNode(readProject(P).data, '一级标题');
    expect(node.items[0].type).toBe('rich');
    expect(norm(landedText(node.items[0].html))).toBe(EXPECT_PREAMBLE);
    expect(node.detail).toBe(itemModel.renderDetail(node.items));
  });
});
