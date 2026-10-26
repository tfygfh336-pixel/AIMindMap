/* ============================================================
 * tests/bindings-content-diff.test.js — 【20261059】"内容没变就不许算 modified"
 * 运行：npx vitest run tests/bindings-content-diff.test.js
 * ------------------------------------------------------------
 * 缺陷出处（本批实测，读数见 `.review/20261059-mtime与lastSync/probe-两个缺陷.log`）：
 *   `bindingFileDiff` 旧判据只比 `mtimeMs / size` ⇒ **同内容再写一次**（mtime 变、size 不变）被判成
 *   `modified` ⇒ 整轮真跑：读文件、重跑转换、把那棵子树的**节点 id 全换掉**（指向它内部节点的
 *   跨项目链接/选中态一起断），绑定记录的 `lastSyncAt` 也被白推一格。
 *
 * ## 这个文件守的六条（每条都带**该红**的注入，注入实跑记录见 .review 的 inject-*.log）
 *   ①-a 同内容只改 mtime ⇒ **不算 modified**、树**一个字节不动**、快照只把 stat 刷新
 *        （该红：退回只比 mtime/size ⇒ 本组第一条当场红）
 *   ①-b **真改内容** ⇒ 仍算 modified 且子树真的被换掉
 *        （该红：把内容比对写反成"永远说没变" ⇒ 本条当场红 —— 这是最容易被做假的那条反例）
 *   ①-b′ size 不变、字节变了（等长不同内容）⇒ 必须靠内容指纹认出来（只比 size 会漏）
 *   ①-c  **口径**：size 变了但"归一后内容"相同（CRLF↔LF、加/去 BOM）⇒ 判**没变**（不重写）。
 *        理由：建树吃的是 `normalizeOutline` 之后的文本，那两种写法建出来的树**逐节点相同**。
 *   ①-d  非文本（UTF-8 解码有损）⇒ 指纹退回**原始字节**：换一个字节必须算 change（不许被"都解码成
 *        替换字符"糊成没变）
 *   ①-e  没有基线（老快照 / 读不了）⇒ **保守**判 modified（一次），并且这一轮就把基线补上 ⇒ 下一轮只改
 *        mtime 就不再是 modified
 *   ①-f  成本取舍的可观测面：**快路径确实一个字节都没读**（证明方式见那条用例 —— 把内容换成等长不同
 *        字节、并把 mtime 钉回去 ⇒ 仍判 unchanged）。这是"mtime/size 只能当快速否定"的代价，如实登记。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const di = require('../src/doc-import.js');
const schema = require('../src/schema.js');

let TMP = null;
let SRC = null;

function mkSrc(files) {
  TMP = makeTmp('mm-binddiff-');
  SRC = path.join(TMP, 'notes');
  fs.mkdirSync(SRC, { recursive: true });
  Object.keys(files || {}).forEach((rel) => {
    const p = path.join(SRC, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel], 'utf8');
  });
  return SRC;
}
beforeEach(() => { mkSrc({}); });
afterEach(() => { TMP = null; SRC = null; });
afterAll(cleanupAll);

const BINDING = (over) => Object.assign({
  id: 'wb-1', dir: SRC, mode: 'flat', include: ['*.md'],
  ignore: schema.BINDING_IGNORE_DEFAULT.slice(), deletions: schema.BINDING_DELETIONS, debounceMs: 800
}, over || {});

const emptyProject = () => ({
  meta: { name: 'p', author: '', version: '0.0.0', formatVersion: 2 },
  format: 'node_tree', bindings: [BINDING()],
  data: { id: 'root', topic: 'p', expanded: true, children: [] }
});

/** 一轮同步（与 `cli/commands/project.js` 的 `bind-sync` 走同一串纯函数；`genId` 固定 ⇒ 产物可逐字节比） */
function syncOnce(data, snap, at) {
  const binding = BINDING();
  const scan = di.scanImportDir(binding.dir, { ext: di.BINDING_EXT_DEFAULT });
  const list = di.listBindingFiles(binding.dir, binding);
  const plan = di.planBindingSync({
    projectData: data, binding: binding, snapshot: snap, scan: scan, list: list,
    genId: di.uniqueIdGen(), parent: 'root', at: at
  });
  const applied = (plan.added.length || plan.modified.length || plan.containers.length)
    ? di.applyBindingPlan(data, plan) : { added: 0, modified: 0, created: 0, dropped: [] };
  const keep = Object.keys(snap.files || {}).filter((rel) => !plan.added.some((x) => x.rel === rel)
    && !plan.modified.some((x) => x.rel === rel)
    && !plan.unconverted.some((x) => x.rel === rel)
    && !plan.pending.some((x) => x.rel === rel));
  return { plan: plan, applied: applied, snap: di.snapshotAfterBindingPlan(snap, plan, plan.at, keep) };
}

const idsOf = (data) => {
  const out = [];
  (function walk(n) { if (!n) return; out.push(n.id + ':' + n.topic); (n.children || []).forEach(walk); })(data.data);
  return out;
};
/** 把 mtime 显式推到 +2s（不靠墙钟精度 —— 同一毫秒内写两次可能得到同一个 mtimeMs） */
function bumpMtime(abs) {
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(abs, t, t);
  return fs.statSync(abs);
}
const CONTENT = '# 甲\n\n正文一行\n\n## 乙\n\n- 丙\n';

/* ============================================================================
 * ①-a 同内容只改 mtime
 * ========================================================================== */
describe('①-a 同内容只改 mtime ⇒ 不算 modified、树一个字节不动', () => {
  it('diff 层：modified 为空、unchanged=1、被点名进 refreshed；快照里的 stat 刷新（下一轮走快路径）', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, CONTENT, 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    expect(r1.plan.added.map((x) => x.rel)).toEqual(['a.md']);
    expect(r1.snap.files['a.md'].contentSha, '新增文件要当场建内容基线').toMatch(/^[0-9a-f]{64}$/);

    const before = fs.readFileSync(A);                       // Buffer（判"内容真的没变"的基准）
    fs.writeFileSync(A, CONTENT, 'utf8');                    // 同内容再写一次
    const st2 = bumpMtime(A);
    expect(fs.readFileSync(A).equals(before), '夹具前提：字节没变').toBe(true);

    const list2 = di.listBindingFiles(SRC, BINDING());
    const diff = di.bindingFileDiff(r1.snap, list2);
    expect(diff.modified, '同内容只改 mtime 不许算 modified').toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toBe(1);
    expect(diff.refreshed).toEqual(['a.md']);
    expect(diff.contentSha['a.md'], '指纹没变（同内容）').toBe(r1.snap.files['a.md'].contentSha);

    const r2 = syncOnce(data, r1.snap, '2026-10-30T00:01:00.000Z');
    expect(r2.plan.modified, '子树不许被重写').toEqual([]);
    expect(r2.plan.added).toEqual([]);
    expect(r2.plan.readFiles, '没变的文件**一个字节都不读**（增量的唯一机器可读读数）').toBe(0);
    expect(di.bindingPlanChangesTree(r2.plan), '这一轮不会动树 ⇒ 命令层一次盘都不写').toBe(false);
    expect(r2.applied.added + r2.applied.modified).toBe(0);
    // 快照把 stat 换成扫描那一刻的读数（否则下一轮又得读一遍去核对内容）
    expect(r2.snap.files['a.md'].mtimeMs).toBe(st2.mtimeMs);
    expect(r2.snap.files['a.md'].size).toBe(st2.size);
    expect(r2.snap.files['a.md'].contentSha).toBe(r1.snap.files['a.md'].contentSha);
    expect(r2.snap.files['a.md'].nodeId, '节点 id 不许换').toBe(r1.snap.files['a.md'].nodeId);
  });

  it('整轮层：树里节点 id / 标题逐项不变，绑定记录的 lastSyncAt 不被白推', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, CONTENT, 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    const ids1 = idsOf(data);
    const json1 = JSON.stringify(data);
    const stamp1 = data.bindings[0].lastSyncAt;

    fs.writeFileSync(A, CONTENT, 'utf8');
    bumpMtime(A);
    const r2 = syncOnce(data, r1.snap, '2026-10-30T00:01:00.000Z');
    expect(idsOf(data), '节点 id 逐项不变（旧实现这里整棵子树的 id 全换）').toEqual(ids1);
    expect(JSON.stringify(data), '项目数据逐字节不变').toBe(json1);
    expect(data.bindings[0].lastSyncAt, '「上次同步」不许被白推一格').toBe(stamp1);
    expect(r2.plan.unchanged).toBe(1);
  });
});

/* ============================================================================
 * ①-b 真改内容 ⇒ 仍算 modified（**必测的反例**：防"永远返回没变"）
 * ========================================================================== */
describe('①-b 真改内容 ⇒ 仍算 modified（反例：把内容比对写反成"永远没变"本条当场红）', () => {
  it('改一个字 ⇒ modified=1、读文件、子树就地换掉（节点 id 变）', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, CONTENT, 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    const ids1 = idsOf(data);
    const nodeId1 = r1.snap.files['a.md'].nodeId;

    fs.writeFileSync(A, CONTENT.replace('正文一行', '正文两行'), 'utf8');
    const list2 = di.listBindingFiles(SRC, BINDING());
    const diff = di.bindingFileDiff(r1.snap, list2);
    expect(diff.modified).toEqual(['a.md']);
    expect(diff.unchanged).toBe(0);
    expect(diff.contentSha['a.md']).not.toBe(r1.snap.files['a.md'].contentSha);

    const r2 = syncOnce(data, r1.snap, '2026-10-30T00:01:00.000Z');
    expect(r2.plan.modified.map((x) => x.rel)).toEqual(['a.md']);
    expect(r2.plan.readFiles).toBe(1);
    expect(r2.applied.modified).toBe(1);
    expect(r2.plan.modified[0].nodeId).toBe(nodeId1);
    expect(idsOf(data), '内容真变了 ⇒ 子树真的被换掉（id 换新）').not.toEqual(ids1);
    expect(JSON.stringify(data)).toContain('正文两行');
  });

  it('①-b′ size 不变、字节变了 ⇒ 靠内容指纹认出来（只比 size 会漏）', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, 'aaaa\n', 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    fs.writeFileSync(A, 'bbbb\n', 'utf8');                 // 等长、不同内容
    const st = fs.statSync(A);
    expect(st.size).toBe(r1.snap.files['a.md'].size);      // 夹具前提：size 真的没变
    const diff = di.bindingFileDiff(r1.snap, di.listBindingFiles(SRC, BINDING()));
    expect(diff.modified).toEqual(['a.md']);
    expect(diff.unchanged).toBe(0);
  });
});

/* ============================================================================
 * ①-c 口径：size 变了但归一后内容相同
 * ========================================================================== */
describe('①-c 口径：CRLF↔LF / BOM ⇒ 判**没变**（不重写）；理由写在这里', () => {
  it('LF → CRLF（size 变了、归一后逐字相同）⇒ 不算 modified', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, 'line1\nline2\n', 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    const ids1 = idsOf(data);
    fs.writeFileSync(A, 'line1\r\nline2\r\n', 'utf8');
    bumpMtime(A);
    expect(fs.statSync(A).size, '夹具前提：size 真的变了').toBe(r1.snap.files['a.md'].size + 2);
    const diff = di.bindingFileDiff(r1.snap, di.listBindingFiles(SRC, BINDING()));
    // 口径：建树吃的是 normalizeOutline 之后的文本 ⇒ 这两种写法建出来的树**逐节点相同** ⇒ 不重写。
    expect(di.normalizeOutline('line1\nline2\n')).toBe(di.normalizeOutline('line1\r\nline2\r\n'));
    expect(diff.modified).toEqual([]);
    expect(diff.refreshed).toEqual(['a.md']);
    const r2 = syncOnce(data, r1.snap, '2026-10-30T00:01:00.000Z');
    expect(idsOf(data)).toEqual(ids1);
  });

  it('加一个 BOM 也一样（归一后相同 ⇒ 不算 modified）；而去掉正文一个字必须算', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, 'line1\nline2\n', 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    fs.writeFileSync(A, '\uFEFFline1\nline2\n', 'utf8');
    bumpMtime(A);
    expect(di.bindingFileDiff(r1.snap, di.listBindingFiles(SRC, BINDING())).modified).toEqual([]);
    // 反方向：正文少一个字 ⇒ 必须算 change（不许"归一"把真改动吃掉）
    fs.writeFileSync(A, '\uFEFFline1\nline\n', 'utf8');
    bumpMtime(A);
    expect(di.bindingFileDiff(r1.snap, di.listBindingFiles(SRC, BINDING())).modified).toEqual(['a.md']);
  });
});

/* ============================================================================
 * ①-d 非文本：指纹退回原始字节
 * ========================================================================== */
describe('①-d 非文本（UTF-8 解码有损）⇒ 指纹用原始字节，换一个字节必须算 change', () => {
  it('一份带非法 UTF-8 字节的 .md：改动一个字节 ⇒ modified（不许被替换字符糊成"没变"）', () => {
    const A = path.join(SRC, 'a.md');
    // 0xFF 0xFE 不是合法 UTF-8 序列 ⇒ 解码会得到替换字符（有损）⇒ 走原始字节指纹那一档
    fs.writeFileSync(A, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    const base = r1.snap.files['a.md'].contentSha;
    expect(base, '非文本也要有基线').toMatch(/^[0-9a-f]{64}$/);
    // 同一路径上把 0xff 换成 0xfe：解码后**都是替换字符**（正文看起来一样），但字节不同
    fs.writeFileSync(A, Buffer.from([0x23, 0x20, 0xfe, 0xfe, 0x0a]));
    bumpMtime(A);
    const diff = di.bindingFileDiff(r1.snap, di.listBindingFiles(SRC, BINDING()));
    expect(diff.modified, '字节变了就必须算 modified（否则真实改动会被静默吞掉）').toEqual(['a.md']);
    expect(diff.contentSha['a.md']).not.toBe(base);
  });

  it('bindingContentDigest：文本走"归一后文本"的 sha256，非文本走"原始字节"的 sha256', () => {
    const md = path.join(SRC, 't.md');
    fs.writeFileSync(md, 'a\r\nb\r\n', 'utf8');
    const d1 = di.bindingContentDigest(md);
    fs.writeFileSync(md, 'a\nb\n', 'utf8');
    expect(di.bindingContentDigest(md), '换行风格不影响指纹').toBe(d1);
    const bin = path.join(SRC, 'b.bin');
    const buf = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    fs.writeFileSync(bin, buf);
    expect(di.bindingContentDigest(bin)).toBe(crypto.createHash('sha256').update(buf).digest('hex'));
    expect(di.bindingContentDigest(path.join(SRC, '没有这个文件.md')), '读不了 ⇒ 空串（调用方保守处理）').toBe('');
  });
});

/* ============================================================================
 * ①-e 没有基线 ⇒ 保守判 modified，并把基线补上
 * ========================================================================== */
describe('①-e 老快照（没有 contentSha）⇒ 保守判 modified 一次，这一轮就把基线补上', () => {
  it('第一次"只改 mtime"仍是 modified（坦白代价）；之后同内容再写就不算了', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, CONTENT, 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    // 模拟老版本快照：字段全在、就是没有 contentSha
    const legacy = JSON.parse(JSON.stringify(r1.snap));
    delete legacy.files['a.md'].contentSha;
    expect(legacy.files['a.md'].contentSha).toBe(undefined);

    fs.writeFileSync(A, CONTENT, 'utf8');
    bumpMtime(A);
    const d1 = di.bindingFileDiff(legacy, di.listBindingFiles(SRC, BINDING()));
    expect(d1.modified, '没有基线时**保守**判 modified（宁可多跑一轮，不许漏改动）').toEqual(['a.md']);
    expect(d1.contentSha['a.md']).toMatch(/^[0-9a-f]{64}$/);

    const r2 = syncOnce(data, legacy, '2026-10-30T00:01:00.000Z');
    expect(r2.snap.files['a.md'].contentSha, '这一轮把基线补上了').toBe(d1.contentSha['a.md']);
    // 再有"同内容只改 mtime"⇒ 不再 modified
    fs.writeFileSync(A, CONTENT, 'utf8');
    bumpMtime(A);
    expect(di.bindingFileDiff(r2.snap, di.listBindingFiles(SRC, BINDING())).modified).toEqual([]);
  });

  it('读不了的文件（路径不存在）⇒ 证明不了没变 ⇒ 判 modified（不静默当没变）', () => {
    const list = { files: [{ rel: 'ghost.md', abs: path.join(SRC, '没有这个文件.md'), size: 10, mtimeMs: 1, include: true, ignore: false }] };
    const snap = di.emptyBindingSnapshot('wb-1', SRC);
    snap.files['ghost.md'] = { mtimeMs: 0, size: 10, contentSha: 'deadbeef' };
    expect(di.bindingFileDiff(snap, list).modified).toEqual(['ghost.md']);
  });
});

/* ============================================================================
 * ①-f 成本取舍的可观测面：快路径真的没读内容
 * ========================================================================== */
describe('①-f 成本取舍：stat 没变就**不读内容**（代价如实登记）', () => {
  it('把内容换成等长不同字节、同时让 stat 看起来没变 ⇒ 仍判 unchanged（= 证明快路径没读文件）', () => {
    const A = path.join(SRC, 'a.md');
    fs.writeFileSync(A, 'aaaa\n', 'utf8');
    const data = emptyProject();
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    const st = fs.statSync(A);
    fs.writeFileSync(A, 'bbbb\n', 'utf8');                 // 等长、不同内容
    fs.utimesSync(A, new Date(st.atimeMs), new Date(st.mtimeMs));   // 尽量把 mtime 钉回去
    const now = fs.statSync(A);
    expect(now.size).toBe(st.size);
    /* 快照条目取**现读的** stat：`utimesSync` 只到毫秒、钉不回 100ns 那一档，
     * 而"保留 mtime 的写入"（`rsync -t` / 某些同步工具 / 整秒取整的文件系统）在判据眼里就是
     * "**这个 stat 下原来记的是另一份内容**" —— 下面这份快照正好是这个形状。 */
    const snap = JSON.parse(JSON.stringify(r1.snap));
    snap.files['a.md'].mtimeMs = now.mtimeMs;
    snap.files['a.md'].size = now.size;
    const diff = di.bindingFileDiff(snap, di.listBindingFiles(SRC, BINDING()));
    /* ⚠️ 这条断言**故意**要说的是"快路径没读内容"：内容其实已经变了，判 unchanged 就只可能因为
     *    第一级判据（mtime+size 都没变 ⇒ 肯定没变）根本没去读它。这是"mtime/size 只能当快速否定"的
     *    **代价**：保留 mtime 的写入会被漏掉 —— 如实登记，不假装能查出来。 */
    expect(diff.unchanged).toBe(1);
    expect(diff.modified).toEqual([]);
    // 反面对照：只要把 mtime 动一下，就走慢路径把内容核对出来
    bumpMtime(A);
    const diff2 = di.bindingFileDiff(snap, di.listBindingFiles(SRC, BINDING()));
    expect(diff2.modified, 'stat 一变就走内容核对 ⇒ 这时才看得见真改动').toEqual(['a.md']);
  });
});

/* ============================================================================
 * 快照形状：contentSha 必须能落盘 + 能读回来（否则每一轮都要重算/保守）
 * ========================================================================== */
describe('快照形状：contentSha 进序列化、读回来还在，且不影响确定性', () => {
  it('serialize → parse → normalize 之后 contentSha 原样（含 null）', () => {
    const data = emptyProject();
    fs.writeFileSync(path.join(SRC, 'a.md'), CONTENT, 'utf8');
    const r1 = syncOnce(data, di.emptyBindingSnapshot('wb-1', SRC), '2026-10-30T00:00:00.000Z');
    const text = di.serializeBindingSnapshot(r1.snap);
    expect(text).toContain('"contentSha"');
    const back = di.parseBindingSnapshot(text);
    const norm = di.normalizeBindingSnapshot(back, 'wb-1', SRC).snap;
    expect(norm.files['a.md'].contentSha).toBe(r1.snap.files['a.md'].contentSha);
    // 确定性：同一份快照序列化两次逐字节相同；键序稳定
    expect(di.serializeBindingSnapshot(r1.snap)).toBe(text);
    expect(di.serializeBindingSnapshot(norm)).toBe(text);
  });
});
