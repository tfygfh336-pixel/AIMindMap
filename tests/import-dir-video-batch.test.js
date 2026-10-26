/* ============================================================
 * tests/import-dir-video-batch.test.js —— 【20261043 视频目录导入】两条新性质
 * ------------------------------------------------------------
 * 这一批修的是用户报的那条：把 `E:\markdown\AI产品经理`（7.85 GB / 14989 个文件，
 * 可导入面 143 个文件 / 168 MB）整库导入时被
 *   `这个目录里的可导入文件合计约 167 MB，超过整库导入上限 64 MB`
 * 整个拒掉。四条要求与它们的判据：
 *
 *   U1 **不设目录总量上限** —— 判据在这里：
 *      · 体量超过 64 MB 的目录**能导完**（下面 D1 用稀疏文件造 70 MB，快的）；
 *      · 拒绝线只剩 `--max-files`（D2 钉住"只有文件数会拒"）；
 *      · 旧报文（"超过整库导入上限 64 MB"）**不许再出现**；
 *      · 分批**是行为不是拒绝**（D3/D4：批数 = 顶层子树数，超线只标 `over`）。
 *   U2 **视频分档** —— 判据：
 *      · `.m3u8` = 视频入口：节点 + `localPath`（指向真实文件，**不内嵌不拷贝**）；
 *      · `.ts` / `.key` / `*.m3u8.bak` 在 HLS 包里 ⇒ 单独一类 `video-part` 跳过；
 *      · ★ **`.ts` 绝不按扩展名一刀切**（C2：`src/foo.ts` 不在包里 ⇒ 不是分片）。
 *   U3/U4 **结构 + 链接** —— 判据：目录 → 节点（名字 = 目录名）、文档 → 节点 + 详情、
 *      三者的 `localPath` 都指向真实路径（E 组）。
 *
 * ⚠️ 本文件**只写沙箱**：项目根 `AI_MINDMAP_PROJECTS_DIR` 指向系统临时目录，
 *    夹具也建在临时目录里，用完立刻删。真实 `projects/` 全程零接触。
 * ============================================================ */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vidbatch-proj-'));
const FIXROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vidbatch-fix-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const di = require('../src/doc-import.js');
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const pathChain = require('../src/path-chain.js');

/* 项目根重定向必须**当场**生效：否则夹具会建进真实 projects/。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const fixtures = [];
/** 造一个探针目录（`spec` = { 相对路径: 内容 }; 值 `null` ⇒ 建空目录; 值 `{sparse:字节}` ⇒ 稀疏文件） */
function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(FIXROOT, 't-'));
  fixtures.push(root);
  Object.keys(spec).forEach((rel) => {
    const p = path.join(root, rel);
    const v = spec[rel];
    if (v === null) { fs.mkdirSync(p, { recursive: true }); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (v && typeof v === 'object' && v.sparse) {
      fs.writeFileSync(p, v.head || 'x', 'utf8');
      fs.truncateSync(p, v.sparse);
      return;
    }
    fs.writeFileSync(p, v, 'utf8');
  });
  return root;
}
function run(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: String(r.stdout || ''), err: String(r.stderr || ''), stdout: String(r.stdout || '') };
}
function jsonOf(r) { try { return JSON.parse(r.stdout); } catch (e) { return null; } }

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(FIXROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ============================================================================
 * A · 判据本体（纯函数）：分片怎么判、包怎么认
 * ========================================================================== */
describe('A · 视频分档的**纯判据**（`video-part` 两侧都成立才算）', () => {
  it('A1 扩展名/包名的识别：`.m3u8` 是入口、`<名字>.m3u8/` 是 HLS 包（大小写不敏感）', () => {
    expect(di.isVideoEntryName('index.m3u8')).toBe(true);
    expect(di.isVideoEntryName('INDEX.M3U8')).toBe(true);
    expect(di.isVideoEntryName('a.m3u')).toBe(true);
    expect(di.isVideoEntryName('a.ts')).toBe(false);
    expect(di.isVideoBundleName('学习中心.m3u8')).toBe(true);
    expect(di.isVideoBundleName('学习中心')).toBe(false);
  });

  it('A2 ★ **两侧判据**：名字像分片 **且** 在 HLS 包里 ⇒ 才算分片；缺一侧都不算', () => {
    // 两侧都成立 ⇒ 分片（HLS 包里的 .ts / .key / 播放列表备份）
    expect(di.classifyVideoPart('课时/学习中心.m3u8/index/0.ts', true)).toBe('video-part');
    expect(di.classifyVideoPart('课时/学习中心.m3u8/extk0/A.key', true)).toBe('video-part');
    expect(di.classifyVideoPart('课时/学习中心.m3u8/index.m3u8.bak', true)).toBe('video-part');
    // ★ 只成立"名字像"（不在包里）⇒ **绝不**当分片：工程里真的 TypeScript 源码走原规则
    expect(di.classifyVideoPart('src/foo.ts', false)).toBe(null);
    expect(di.classifyVideoPart('a.key', false)).toBe(null);
    expect(di.classifyVideoPart('notes.md.bak', false)).toBe(null);
    // 播放列表自己是**入口**，永远不是分片（哪怕在包里）
    expect(di.classifyVideoPart('学习中心.m3u8/index.m3u8', true)).toBe(null);
    // 包里但扩展名与视频无关 ⇒ 不是分片（笔记/图不受牵连）
    expect(di.classifyVideoPart('课时/学习中心.m3u8/notes.md', true)).toBe(null);
  });

  it('A3 播放列表的"大概事实"：分片数 / 时长（`#EXTINF` 累加）/ 是否加密 —— 纯函数、确定', () => {
    const f = di.videoPlaylistFacts('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="a.key"\n'
      + '#EXTINF:10.0,\n0.ts\n#EXTINF:12.5,\n1.ts\n#EXTINF:8.5,\n2.ts\n#EXT-X-ENDLIST\n');
    expect(f.segments).toBe(3);
    expect(f.seconds).toBe(31);
    expect(f.encrypted).toBe(true);
    expect(di.videoPlaylistFacts('#EXTM3U\n#EXTINF:5,\n0.ts\n').encrypted).toBe(false);
    expect(di.videoPlaylistFacts('').segments).toBe(0);
    // 详情里必须有那三件事（"大概的节点详情"：分片/时长/加密），且不含绝对路径
    const md = di.videoDetailMd(f, 'index.m3u8');
    expect(md).toContain('分片 3 个');
    expect(md).toContain('0:31');
    expect(md).toContain('EXT-X-KEY');
    expect(md).not.toMatch(/[A-Z]:\\/);
  });

  it('A4 `localPath` 长度上限三处**同一口径**（src/doc-import.js · src/path-chain.js · src/schema.js）', () => {
    // 这条断言就是"三份 500 不许漂"的机械判据（改一处忘了另一处 ⇒ 这里红）
    expect(di.LOCAL_PATH_MAX).toBe(500);
    expect(pathChain.LOCAL_PATH_MAX).toBe(500);
    const schemaSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'schema.js'), 'utf8');
    expect(schemaSrc).toContain('node.localPath.length > ' + di.LOCAL_PATH_MAX);
  });
});

/* ============================================================================
 * B · 扫描：HLS 包里的分片记 `video-part`，包外的 `.ts` 记 `unsupported-ext`
 * ========================================================================== */
describe('B · 扫描的分档（`video-part` 单独一类 + `.ts` 的歧义两侧各判一次）', () => {
  const spec = {
    '课程/第一节/学习中心.m3u8/index.m3u8': '#EXTM3U\n#EXTINF:10.0,\nindex/0.ts\n',
    '课程/第一节/学习中心.m3u8/index/0.ts': 'x',
    '课程/第一节/学习中心.m3u8/index/1.ts': 'x',
    '课程/第一节/学习中心.m3u8/index.m3u8.bak': '#EXTM3U\n',
    '课程/第一节/学习中心.m3u8/extk0/A.key': 'k',
    '课程/第一节/课程简介.txt': '第一节简介\n',
    '资料/源码.ts': 'export const a = 1;\n'
  };

  it('B1 ★ 包内 `.ts`/`.key`/`.bak` ⇒ `video-part`（计 6 项：2 个分片 + 1 个密钥 + 1 个备份 + 2 个只剩分片的子目录）', () => {
    const root = makeTree(spec);
    const scan = di.scanImportDir(root, {});
    /* 逐条：`index/0.ts` `index/1.ts` `index.m3u8.bak` `extk0/A.key` = 4 个文件，
     * 加上 `index/` 与 `extk0/` 这两个"里面只有分片"的子目录 ⇒ 6 条 video-part。
     * ⚠️ 子目录记 video-part 而不是 `no-importable`：后者会说成"这个目录里没有可导入的文件"，
     *    而真相是"这里只有分片"（原因必须准确，否则人去找一个不存在的格式问题 ✗）。 */
    expect(scan.counts['video-part']).toBe(6);
    // 分类**不混进**"扩展名不支持"
    expect(scan.counts['unsupported-ext']).toBe(1);            // 只有 资料/源码.ts
    expect(scan.skipped.filter((s) => s.reason === 'video-part').map((s) => s.rel).sort()).toEqual([
      '课程/第一节/学习中心.m3u8/extk0',
      '课程/第一节/学习中心.m3u8/extk0/A.key',
      // ⚠️ 排序按 UTF-16 码位：`index` 是 `index.m3u8.bak` 的前缀 ⇒ 短的在前；
      //    而 `.`(0x2E) < `/`(0x2F) ⇒ `index.m3u8.bak` 又在 `index/0.ts` 之前
      '课程/第一节/学习中心.m3u8/index',
      '课程/第一节/学习中心.m3u8/index.m3u8.bak',
      '课程/第一节/学习中心.m3u8/index/0.ts',
      '课程/第一节/学习中心.m3u8/index/1.ts'
    ]);
    // 可导入面 = 播放列表 + 简介（`.ts` 源码不是可导入格式，但**也不是分片**）
    expect(scan.files.map((f) => f.rel).sort()).toEqual([
      '课程/第一节/学习中心.m3u8/index.m3u8',
      '课程/第一节/课程简介.txt'
    ]);
    expect(scan.video.entries).toBe(1);
    expect(scan.video.parts).toBe(6);
    // 每一类跳过都必须有"为什么"
    expect(di.SKIP_LABEL['video-part']).toBeTruthy();
    expect(di.SKIP_SHORT['video-part']).toBeTruthy();
  });

  it('B2 ★ 同一个 `.ts` 在包里是分片、在包外不是 —— 同一个文件名的**两种上下文**结论不同', () => {
    const root = makeTree({
      'a/学习中心.m3u8/index/0.ts': 'x',
      'b/源码/0.ts': 'x'
    });
    const scan = di.scanImportDir(root, {});
    const partRel = scan.skipped.filter((s) => s.reason === 'video-part').map((s) => s.rel).sort();
    const unsupRel = scan.skipped.filter((s) => s.reason === 'unsupported-ext').map((s) => s.rel).sort();
    // 包里那一份：分片本身 + 它所在的 `index/` + **整个 HLS 包目录**（包里一个可导文件都没有 ⇒ 也算 video-part）
    expect(partRel).toEqual([
      'a/学习中心.m3u8', 'a/学习中心.m3u8/index', 'a/学习中心.m3u8/index/0.ts'
    ]);
    // 包外那一份：普通的不支持扩展名（**不是**分片）—— `.ts` 的歧义两侧各判一次
    expect(unsupRel).toEqual(['b/源码/0.ts']);
    expect(partRel).not.toContain('b/源码/0.ts');
  });

  it('B3 包里除播放列表外**一个可导文件都没有**的子目录（`index/`、`extk0/`）记 `video-part`，不记 `no-importable`', () => {
    const root = makeTree({
      '学习中心.m3u8/index.m3u8': '#EXTM3U\n',
      '学习中心.m3u8/index/0.ts': 'x',
      '学习中心.m3u8/extk0/A.key': 'k'
    });
    const scan = di.scanImportDir(root, {});
    // 2 个文件（0.ts / A.key）+ 2 个子目录（index/ extrak0/ 全空于可导面）都算 video-part
    expect(scan.counts['video-part']).toBe(4);
    expect(scan.counts['no-importable']).toBeUndefined();
    expect(scan.counts['empty-dir']).toBeUndefined();
  });
});

/* ============================================================================
 * C · 建树：视频节点（入口 + localPath + 详情）+ 目录/文档节点的 localPath
 * ========================================================================== */
describe('C · 建树（U3 结构 + U4 通过链接指向文件）', () => {
  const shape = (n) => n.topic + ((n.children || []).length ? '(' + n.children.map(shape).join(' ') + ')' : '');

  it('C1 ★ 视频包折叠成一个**视频节点**：标题取包名去 `.m3u8`、`localPath` 指向真实播放列表、详情有分片/时长', () => {
    const root = makeTree({
      '课程/第一节/学习中心.m3u8/index.m3u8':
        '#EXTM3U\n#EXTINF:10.0,\nindex/0.ts\n#EXTINF:20.0,\nindex/1.ts\n',
      '课程/第一节/学习中心.m3u8/index/0.ts': 'x',
      '课程/第一节/学习中心.m3u8/index/1.ts': 'x'
    });
    const built = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
    // 结构：课程 → 第一节 → 学习中心（**没有**多画一层 `学习中心.m3u8` 容器）
    expect(built.children.map(shape)).toEqual(['课程(第一节(学习中心))']);
    const video = built.children[0].children[0].children[0];
    expect(video.topic).toBe('学习中心');
    expect(video.children).toEqual([]);
    const playlist = path.join(root, '课程', '第一节', '学习中心.m3u8', 'index.m3u8');
    expect(video.localPath).toBe(playlist);
    expect(fs.existsSync(video.localPath)).toBe(true);          // 导入时的事实，可以校验存在性
    expect(video.detail).toContain('分片 2 个');
    expect(video.detail).toContain('0:30');
    expect(built.videos).toBe(1);
    expect(built.files).toBe(1);                                // 视频算"导入了 1 个文件"
    expect(built.entries[0].format).toBe('video');
    expect(/^[0-9a-f]{64}$/.test(built.entries[0].sha256)).toBe(true);   // 来源指纹照样有
  });

  it('C2 ★ 目录节点与文档节点也带 `localPath`（U4：通过链接指向文件，不是新造字段）', () => {
    const root = makeTree({
      '书/第一章.md': '# 章标题\n正文\n',
      '书/简介.txt': '简介正文\n'
    });
    const built = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
    const dirNode = built.children[0];
    expect(dirNode.topic).toBe('书');
    expect(dirNode.localPath).toBe(path.join(root, '书'));
    expect(fs.existsSync(dirNode.localPath)).toBe(true);
    dirNode.children.forEach((n) => {
      expect(typeof n.localPath).toBe('string');
      expect(fs.existsSync(n.localPath)).toBe(true);
    });
    // 内容照样进了树（localPath 只是入口，不是替代品）
    expect(dirNode.children.length).toBe(2);
  });

  it('C3 视频节点的**来源指纹**让它也进幂等闸门（同一个播放列表不许导两次）', () => {
    const root = makeTree({ '学习中心.m3u8/index.m3u8': '#EXTM3U\n#EXTINF:1,\n0.ts\n' });
    const b1 = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T' });
    const b2 = di.buildDirImportTree(di.scanImportDir(root, {}), { at: 'T2' });
    expect(di.originMatches(b1.entries[0].origin, b2.entries[0].origin)).toBe(true);
  });
});

/* ============================================================================
 * D · 分批（U1 的实现形状）——含"退回整棵树先建好必红"的那条判据
 * ========================================================================== */
describe('D · 分批计划与分批建树（U1：目录总量没有上限，超过单批线只分批）', () => {
  const mkScan = (root) => di.scanImportDir(root, {});
  /** 把一个批计划里所有文件按批序摊平 */
  const flat = (plan) => {
    const out = [];
    plan.forEach((b) => {
      const walk = (n) => { n.files.forEach((f) => out.push(f.rel)); n.dirs.forEach(walk); };
      walk({ files: b.fileList, dirs: b.dirs });
    });
    return out;
  };

  it('D1 ★ 配平 + 可复现 + 顺序：每个可导入文件**恰好**一批，且两跑同一份计划', () => {
    const root = makeTree({
      'a/1.md': '# 一\n', 'a/2.md': '# 二\n', 'a/深/3.md': '# 三\n',
      'b/4.md': '# 四\n',
      'root.md': '# 根\n'
    });
    const scan = mkScan(root);
    const p1 = di.planImportBatches(scan);
    const p2 = di.planImportBatches(scan);
    expect(p1.map((b) => b.name)).toEqual(p2.map((b) => b.name));
    const got = flat(p1);
    expect(got.slice().sort()).toEqual(scan.files.map((f) => f.rel).sort());
    expect(got.length).toBe(scan.files.length);                  // 不丢、不重
    // 粒度 = 顶层条目：2 个顶层目录 + 根下文件（1 批）
    expect(p1.length).toBe(3);
    expect(p1.map((b) => b.name)).toEqual(['a', 'b', '']);       // 目录在前、根下文件在最后
  });

  it('D2 ★ 一批**超过单批线**只标 `over`（不拆批、不丢文件、更不拒绝）', () => {
    const root = makeTree({ 'big/a.m3u8': { sparse: 200 * 1024, head: '#EXTM3U\n' } });
    const scan = mkScan(root);
    const plan = di.planImportBatches(scan, { maxBytes: 1024, maxFiles: 1 });
    expect(plan.length).toBe(1);
    expect(plan[0].over).toBe(true);
    expect(flat(plan)).toEqual(scan.files.map((f) => f.rel));     // 文件还在
  });

  it('D3 ★★ 分批建树 = **每批一次** builder，且每批只拿到自己那批文件（退回"整棵树一次建好"⇒ 这条必红）', () => {
    const root = makeTree({
      'a/1.md': '# 一\n', 'a/2.md': '# 二\n',
      'b/3.md': '# 三\n',
      'c/4.md': '# 四\n'
    });
    const scan = mkScan(root);
    const plan = di.planImportBatches(scan);
    expect(plan.length).toBe(3);
    /* 为什么用注入的 `builder` 而不是 `vi.spyOn`：模块内部直接调 `buildDirImportTree`，
     * spy 拦不到内部引用（实测 calls=0）⇒ 只有注入这一条缝能把这条性质**断言**出来。
     * ⚠️ 这条断言守的正是"别退回整棵树先建好"：那样子调用只会有 1 次。 */
    const calls = [];
    const built = di.buildDirImportTreeBatched(scan, {
      plan: plan, at: 'T',
      builder: (slice, opts) => {
        const rels = [];
        const walk = (n) => { n.files.forEach((f) => rels.push(f.rel)); n.dirs.forEach(walk); };
        walk(slice.tree);
        calls.push(rels.sort());
        return di.buildDirImportTree(slice, opts);
      }
    });
    expect(calls.length).toBe(plan.length);                     // ★ 一批一次
    calls.forEach((rels, i) => expect(rels).toEqual(flat([plan[i]]).sort()));   // ★ 各批只看自己那批
    expect(built.readFiles).toBe(scan.files.length);            // 该读的一个不少
    expect(built.batches.length).toBe(plan.length);
    expect(built.batches.map((b) => b.files)).toEqual(plan.map((b) => b.files));
  });

  it('D4 ★ 分批**不改树**：一批批拼出来的结构与"不分批一次建完"逐字相同（只比主题/层级，不比 id）', () => {
    const root = makeTree({
      'a/1.md': '# 一\n正文\n', 'a/深/2.md': '# 二\n', 'b/3.txt': '无标题正文\n', 'root.md': '# 根\n'
    });
    const scan = mkScan(root);
    const shape = (n) => n.topic + ((n.children || []).length ? '(' + n.children.map(shape).join(' ') + ')' : '');
    const whole = di.buildDirImportTree(scan, { at: 'T' });
    const batched = di.buildDirImportTreeBatched(scan, { at: 'T' });
    expect(batched.children.map(shape)).toEqual(whole.children.map(shape));
    expect(batched.nodes).toBe(whole.nodes);
    expect(batched.containers).toBe(whole.containers);
    expect(batched.files).toBe(whole.files);
  });

  it('D5 批次之间的 **id 不撞**（跨批共用一个生成器；schema 判"全树 id 唯一"）', () => {
    const spec = {};
    for (let i = 0; i < 6; i++) spec['d' + i + '/x.md'] = '# 同名\n';
    const root = makeTree(spec);
    const built = di.buildDirImportTreeBatched(mkScan(root), { at: 'T' });
    const ids = [];
    const walk = (n) => { ids.push(n.id); (n.children || []).forEach(walk); };
    built.children.forEach(walk);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ============================================================================
 * E · CLI 层（in-process `invokeSync`，沙箱项目根）：用户报的那条端到端
 * ========================================================================== */
describe('E · import-dir（CLI）：不再有目录总量上限 + 视频入口节点 + video-part 计数', () => {
  it('E1 ★★ 体量 **超过 64 MB** 的目录**能导完**（用户那条报错的正面判据）+ 旧报文不许再出现', () => {
    /* 用**稀疏**文件造 70 MB：不真占盘、读起来就是 70 MB ⇒ 走的就是"总量超 64 MB"那条路。
     * 选 `.m3u8` 是因为它的正文**不进树**（只留入口节点 + 事实），所以这条判据量的是"闸门"，
     * 不夹带"树有多大"的噪声。 */
    const root = makeTree({
      '课程/视频.m3u8/index.m3u8': { sparse: 70 * 1024 * 1024, head: '#EXTM3U\n#EXTINF:10,\nindex/0.ts\n' },
      '课程/视频.m3u8/index/0.ts': 'x'
    });
    const r = run(['import-dir', 'e1-big', root, '--json']);
    expect(r.code, '报文：' + r.out.slice(0, 400)).toBe(0);
    const rep = jsonOf(r);
    expect(rep).toBeTruthy();
    expect(rep.size.mb).toBeGreaterThan(64);                   // 确实越过了老闸门
    expect(rep.size.over).toBe(true);                          // 读作"超过单批线 ⇒ 会分批"
    expect(rep.wouldRefuse).toBe(false);                       // ★ 没有拒绝
    expect(rep.files).toBe(1);
    expect(r.out).not.toContain('超过整库导入上限');
    // 真落了盘、读得回来，且视频节点带 localPath
    const rr = run(['read', 'e1-big', '--json']);
    const nodes = JSON.parse(rr.stdout).nodes || [];
    const video = nodes.filter((n) => n.localPath && /\.m3u8$/.test(n.localPath))[0];
    expect(video).toBeTruthy();
    expect(fs.existsSync(video.localPath)).toBe(true);
  });

  it('E2 拒绝线只剩**文件数**：`--max-files 1` 面对 2 个可导入文件 ⇒ 非 0 + 说清是文件数（不是体量）', () => {
    const root = makeTree({ 'a/1.md': '# 一\n', 'b/2.md': '# 二\n' });
    const r = run(['import-dir', 'e2-maxfiles', root, '--max-files', '1']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('超过整库导入上限 1 个');
    expect(r.out).toContain('--max-files');
    expect(r.out).not.toContain('MB');                          // 不许再拿体量说事
  });

  it('E3 `--dry-run --json` 报**分几批**（`batching`）+ 视频分档两个数分开报（entries / parts）', () => {
    const root = makeTree({
      '课/第一节/学习中心.m3u8/index.m3u8': '#EXTM3U\n#EXTINF:10,\nindex/0.ts\n',
      '课/第一节/学习中心.m3u8/index/0.ts': 'x',
      '课/第一节/学习中心.m3u8/extk0/A.key': 'k',
      '课/第二节/学习中心.m3u8/index.m3u8': '#EXTM3U\n',
      '资料/笔记.md': '# 笔记\n'
    });
    const r = run(['import-dir', 'e3-plan', root, '--dry-run', '--json']);
    expect(r.code).toBe(0);
    const rep = jsonOf(r);
    expect(rep.batching.count).toBe(2);                         // 「课」「资料」
    expect(rep.batching.batches.map((b) => b.name)).toEqual(['课', '资料']);
    expect(rep.video.entries).toBe(2);                          // 2 个播放列表（当入口）
    expect(rep.video.parts).toBe(4);                            // 0.ts + A.key + 两个只剩分片的子目录
    expect(rep.video.nodes).toBe(2);
    expect(rep.skippedByReason['video-part']).toBe(4);
  });

  it('E4 真导的文本回档里**看得见**分批与视频分档（不许静默）', () => {
    const root = makeTree({
      '课/第一节/学习中心.m3u8/index.m3u8': '#EXTM3U\n#EXTINF:10,\nindex/0.ts\n',
      '课/第一节/学习中心.m3u8/index/0.ts': 'x',
      '资料/笔记.md': '# 笔记\n'
    });
    const r = run(['import-dir', 'e4-text', root]);
    expect(r.code, r.out.slice(0, 300)).toBe(0);
    expect(r.out).toContain('分批转换：2 批');
    expect(r.out).toContain('视频：1 个播放列表');
    expect(r.out).toContain('树里落成 1 个视频节点');
    expect(r.out).toContain('视频分片/密钥/索引');
    expect(r.out).toContain('目录总量**没有上限**');
  });

  it('E5 导完之后 `read --subtree` 能看出目录树形状 + 视频节点的 localPath 指向真实 m3u8', () => {
    const root = makeTree({
      '课/第一节/学习中心.m3u8/index.m3u8': '#EXTM3U\n#EXTINF:10,\nindex/0.ts\n',
      '课/第一节/学习中心.m3u8/index/0.ts': 'x',
      '课/第一节/课程简介.txt': '这一节讲什么\n',
      '资料/笔记.md': '# 笔记标题\n## 小节\n'
    });
    expect(run(['import-dir', 'e5-shape', root]).code).toBe(0);
    const rr = run(['read', 'e5-shape', '--json']);
    const nodes = JSON.parse(rr.stdout).nodes || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const kids = (n) => (n.children || []).map((c) => byId.get(typeof c === 'string' ? c : c.id)).filter(Boolean);
    const shape = (n) => n.topic + (kids(n).length ? '(' + kids(n).map(shape).join(' ') + ')' : '');
    const rootNode = nodes.filter((n) => n.depth === 0)[0];
    /* 形状断言按**片段**比（根节点名 = 夹具目录名，随机；`.txt` 无标题时会多一层"（层级2）"，
     * 那是既有的 txt 启发式，与本批无关）—— 本批要守的是"目录层级没被拍平、视频节点在里面"。 */
    expect(shape(rootNode)).toContain('课(第一节(学习中心 课程简介');
    expect(shape(rootNode)).toContain('资料(笔记(笔记标题(小节))');
    const video = nodes.filter((n) => n.localPath && /\.m3u8$/i.test(n.localPath))[0];
    expect(video.topic).toBe('学习中心');
    expect(Array.isArray(video.children) ? video.children.length : video.children).toBeFalsy();  // 视频节点是叶子
    expect(video.localPath.endsWith(path.join('学习中心.m3u8', 'index.m3u8'))).toBe(true);
    expect(fs.existsSync(video.localPath)).toBe(true);
  });
});
