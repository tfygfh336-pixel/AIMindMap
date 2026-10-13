/**
 * tests/import-reading.test.js —— 【W13】界面侧导入的两份**读数**（`scripts/smoke/import-reading.js`）
 * 运行：npx vitest run tests/import-reading.test.js
 *
 * 这个文件盯的是"读数不许骗人"这一条：界面要显示的「新增 N / 更新 M / 未转换 K（逐条点名）」
 * 全部来自 CLI 自己的读数，而两条命令的读数**形状不一样**（`import-md` 只有文本、`import-dir` 有
 * 结构报告）⇒ 归一化那一处一旦把"读不到"当成 0、或把两类未转换只报一类，界面就会**少报而看不出少报**。
 * 三个状态必须**可分辨**（B4c）：
 *   ① 读到了 N         ⇒ `added` 是那个数；
 *   ② 这一条没成功     ⇒ 进「未转换」并**带 CLI 的原话**；
 *   ③ 成功但读不出数   ⇒ `addedUnreadable` 单独计数（**绝不回落成 0**）。
 *
 * 夹具全部是**实测原文**（2026-10-13 在临时沙箱里跑 `import-md --dry-run` / `import-dir --dry-run --json`
 * 抄下来的形状），不是照文档编的 —— 照文档编的夹具会跟真实回显一起漂。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* ⚠️ 落点是 `scripts/smoke/`（不是 `scripts/` 顶层）：G8 文档登记门禁只查顶层脚本并**显式豁免** `scripts/smoke/`，
 * 而本批不许动 `docs/ARCHITECTURE.md` —— 理由与先例写在被测文件顶上 */
const reading = require('../scripts/smoke/import-reading.js');

/* ---------------- 夹具①：`import-md --dry-run` 的成功回显（实测原文，只把 id/路径截短） ---------------- */
const MD_DRY_OK = [
  '[dry-run 未写盘] 这次写盘将改动 5 个对象（children 3 · node 2）：children:n-a、children:n-b、children:root、node:n-a、node:n-b',
  '[dry-run 未写盘] 上面这份清单就是真跑后 .changes.jsonl 里那条 `changed`；本次**一个字节都没写**（项目文件与变更日志都逐字节未动 ✓）',
  '[dry-run 未写盘] 导入完成，新增 2 个节点（父节点 root）',
  '[dry-run 未写盘] 来源指纹: 来源 C:/tmp/a.md ｜ 指纹 d426eaad2355… ｜ 2026-10-13T21:30:13.876Z ｜ import-md',
  '[dry-run 未写盘] 资源引用：这份文档里没有图片/附件引用（无）',
  ''
].join('\n');

/* 夹具②：`import-md` 拿到**目录**时的实错误（实测原文首行） */
const MD_DRY_ERR = 'error: 这是一个**目录**，不是文件: C:\\tmp\\bad.md。**单文件**导入（一个文件 → 一棵树）用 '
  + '`import-project` / `import-md`；要把**整个文件夹的结构**镜像成一棵树，用**整库导入** `import-dir` ✓。\n';

/* 夹具③：`import-dir --dry-run --json` 的报告（实测字段与取值） */
const DIR_REPORT = {
  ok: true, dryRun: true, project: 'zz-lib', dir: 'C:\\tmp\\src', title: '书库',
  containers: 1, files: 2, nodes: 5,
  skippedCount: 1, skippedByReason: { 'empty-dir': 1 },
  skippedDetail: [{ rel: 'bad.md', reason: 'empty-dir', label: '空目录', message: null }],
  wouldRefuse: false, refuseReason: null, converted: true,
  resourceRefs: { onMissing: 'detail', files: 1, total: 2, copy: 1, inProject: 0, remote: 0,
    missing: 1, badExt: 0, badTotal: 1, itemsTotal: 2,
    bad: [{ file: 'a.md', node: 'n-1', topic: '甲', kind: 'image', ref: 'assets/x.png',
      status: 'missing', reason: '找不到这个文件', tried: ['assets/x.png'] }],
    items: [] }
};

describe('【W13】import-md --dry-run 的文本读数', () => {
  it('成功回显 ⇒ 读出新增的节点数（2）', () => {
    const r = reading.readImportMdDryRun(MD_DRY_OK);
    expect(r.added).toBe(2);
    expect(r.unreadable).toBe('');
  });

  it('★ 读不出来必须是 null（**不是 0**）+ 一句原话 —— "读不到"不许伪装成"没新增"', () => {
    const r = reading.readImportMdDryRun(MD_DRY_ERR);
    expect(r.added).toBeNull();
    expect(r.unreadable).toContain('导入完成');
    // 同一条纪律：完全空的回显也一样
    expect(reading.readImportMdDryRun('').added).toBeNull();
    expect(reading.readImportMdDryRun(undefined).added).toBeNull();
  });

  it('★ 判别力：把读数口径改成"认不出来就当 0" ⇒ 上面那条必红（本用例是它的对照面）', () => {
    // 这一条是"注入对照"：0 与 null 在 JS 里都假，但语义完全不同 ⇒ 断言必须能分辨
    const broken = reading.readImportMdDryRun(MD_DRY_ERR);
    expect(broken.added === 0).toBe(false);
  });
});

describe('【W13】一批文件的预览读数（部分成功）', () => {
  const items = [
    { file: 'C:\\tmp\\a.md', ok: true, added: 2, unreadable: '', error: '' },
    { file: 'C:\\tmp\\b.md', ok: true, added: 1, unreadable: '', error: '' },
    { file: 'C:\\tmp\\bad.md', ok: false, added: 0, unreadable: '', error: '这是一个**目录**，不是文件: C:\\tmp\\bad.md' }
  ];

  it('★ 一个坏文件混在里面 ⇒ 好的照进（新增 3），坏的**逐条点名**（带 CLI 原话）', () => {
    const p = reading.mergeFilePreviews(items);
    expect(p.added).toBe(3);                 // 好的三个节点一个都不少（坏文件拖不垮整批）
    expect(p.updated).toBe(0);
    expect(p.unconverted).toBe(1);
    expect(p.unconvertedList.length).toBe(1);
    expect(p.unconvertedList[0].name).toBe('bad.md');
    expect(p.unconvertedList[0].reason).toContain('这是一个**目录**，不是文件');
    expect(p.unconvertedList[0].how).toContain('没能导入');
  });

  it('★ 三个状态可分辨：读到了 N / 没成功 / 成功但读不出数（第三个单独计数，不进"新增"）', () => {
    const mixed = items.concat([{ file: 'C:\\tmp\\c.md', ok: true, added: null, unreadable: '回显里没有那一行', error: '' }]);
    const p = reading.mergeFilePreviews(mixed);
    expect(p.added).toBe(3);
    expect(p.unconverted).toBe(1);
    expect(p.addedUnreadable).toBe(1);
  });

  it('★ 判别力：把"坏文件拖垮整批"做出来（坏的那条让 added 归零）⇒ 上面那条必红', () => {
    // 复刻"改坏之后"会算成什么：整批中止 ⇒ added 只剩 0
    const aborted = reading.mergeFilePreviews([{ file: 'C:\\tmp\\bad.md', ok: false, added: 0, error: '目录' }]);
    expect(aborted.added).toBe(0);
    expect(aborted.added).not.toBe(reading.mergeFilePreviews(items).added);
  });
});

describe('【W13】import-dir 报告的读数（与文件那一条**同一个形状**）', () => {
  it('新增 = 报告里的 nodes；两类未转换**都要点名**（没进树的 + 引用没落地的）', () => {
    const p = reading.dirPreviewOf(DIR_REPORT);
    expect(p.kind).toBe('dir');
    expect(p.added).toBe(5);
    expect(p.updated).toBe(0);
    expect(p.unconverted).toBe(2);           // 1 个跳过 + 1 条坏引用
    const names = p.unconvertedList.map((x) => x.name).join(' | ');
    expect(names).toContain('bad.md');       // 没进树的那个
    expect(names).toContain('assets/x.png'); // 引用没落地的那个
    expect(p.unconvertedList[0].reason).toContain('空目录');
    expect(p.unconvertedList[1].reason).toContain('找不到这个文件');
    expect(p.unconvertedList[1].how).toContain('按正文保留');   // "内容没丢"要说清
  });

  it('★ 判别力：只报一类未转换（漏掉坏引用）⇒ 上面那条必红', () => {
    const onlySkipped = { skippedCount: DIR_REPORT.skippedCount, badRefCount: 0 };
    expect(onlySkipped.skippedCount + onlySkipped.badRefCount).not.toBe(reading.dirPreviewOf(DIR_REPORT).unconverted);
  });

  it('"会不会被拒"如实透出来（界面据此在**写盘之前**拦住，不静默试一次）', () => {
    const refused = Object.assign({}, DIR_REPORT, { wouldRefuse: true, refuseReason: 'duplicate-dir' });
    const p = reading.dirPreviewOf(refused);
    expect(p.wouldRefuse).toBe(true);
    expect(p.refuseReason).toBe('duplicate-dir');
    expect(reading.dirPreviewOf(DIR_REPORT).wouldRefuse).toBe(false);
  });

  it('报告缺字段（坏数据）⇒ 一个数都不许凭空造：0 就是 0，列表为空就为空', () => {
    const p = reading.dirPreviewOf({});
    expect(p.added).toBe(0);
    expect(p.unconverted).toBe(0);
    expect(p.unconvertedList).toEqual([]);
  });
});
