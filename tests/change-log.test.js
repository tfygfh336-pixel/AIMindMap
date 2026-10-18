/* ============================================================
 * tests/change-log.test.js — 「AI 改了哪些文件」清单的单元测试（vitest，**零 Electron、零 git**）
 * ------------------------------------------------------------
 * 锁住 `src/change-log.js` 的事实。四条纪律（决定这些用例怎么写）：
 *   ① **期望值手算写死**，不调产品同一个函数去推期望（本工程踩过"两侧同源 ⇒ 恒等 ⇒ 抓不住语义"的坑）。
 *   ② **每个用例对准一条可破的不变式**，并在注释里写明"改哪一行会让它红"（判别力）。
 *   ③ **git 输出用真形状的夹具**：那些夹具逐字来自实测（`.review/20261018-改动清单/git-shapes.txt`，
 *      git 2.55），不是凭记忆编的 —— 尤其"改名占两段"和"没有 HEAD 时 exit 128"这两条。
 *      ⚠️ 本文件**不起 git 子进程**：单测要确定性，真 git 的端到端读数在
 *      `.review/20261018-改动清单/tools/probe-change-log.js`（独立非链探针）与冒烟域 22 里。
 *   ④ 另加**结构断言**（判据 ②）：文件名只在 `src/change-log.js` 出现一次、
 *      本模块里没有第二套写盘原语（`fs.writeFileSync` / `fs.appendFile` 一次都不许有）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FILE_NAME, ENTRY_VERSION, MAX_RECORDS, SAMPLE_MIN_INTERVAL_MS,
  STATUS_TEXT, GIT_ARGV,
  normStatus, parseStatusZ, parseNumstatZ, countLines, mergeRows,
  buildRecord, serializeRecord, parseLog, recordKey, latestPerPath, compact,
  planAppend, summarize, createStore
} from '../src/change-log.js';
import { writeFileAtomic } from '../src/data-store.js';

const ROOT = path.resolve(__dirname, '..');

/* ============================ ① 解析：真形状夹具 ============================ */

describe('解析 ① `git status --porcelain=v1 -z` —— 改名占两个字段', () => {
  it('普通条目 / 未跟踪 / 已删除 各有各的状态码', () => {
    const r = parseStatusZ(' M a.txt\0?? new.txt\0D  gone.txt\0');
    expect(r.bad).toEqual([]);
    expect(r.rows.map((x) => [x.code, x.path, x.status])).toEqual([
      [' M', 'a.txt', 'M'],
      ['??', 'new.txt', '?'],
      ['D ', 'gone.txt', 'D']
    ]);
  });

  it('改名条目：旧路径**不是**第二个被改的文件（少一个字段就会凭空多一条）', () => {
    // 实测原文：["R  c.txt","b.txt",""]
    const r = parseStatusZ('R  c.txt\0b.txt\0');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toMatchObject({ status: 'R', path: 'c.txt', oldPath: 'b.txt' });
    // 判别力：把 parseStatusZ 里那句 `i++` 删掉 ⇒ 这里会变成 2 条（多出一个 path='b.txt'）
    expect(r.rows.map((x) => x.path)).toEqual(['c.txt']);
  });

  it('冲突族统一记 U（UU / AA / DD 都不许混进 M）', () => {
    const r = parseStatusZ('UU both.txt\0AA newboth.txt\0DD goneboth.txt\0');
    expect(r.rows.map((x) => x.status)).toEqual(['U', 'U', 'U']);
  });

  it('坏字段进 bad[]，不静默丢（"少了一条"与"本来就没有"必须能分辨）', () => {
    const r = parseStatusZ('XY\0 M ok.txt\0');
    expect(r.rows.map((x) => x.path)).toEqual(['ok.txt']);
    expect(r.bad.length).toBe(1);
    expect(r.bad[0].raw).toBe('XY');
  });

  it('空输入 ⇒ 0 条（"采不到"不在这里表达，由 readSnapshot 的 source 表达）', () => {
    expect(parseStatusZ('').rows).toEqual([]);
    expect(parseStatusZ(undefined).rows).toEqual([]);
  });
});

describe('解析 ② `git diff --numstat -z -M HEAD` —— 改名是空 path 再跟两段', () => {
  it('普通记录：`add\\tdel\\tpath`，二进制是 `-\\t-`', () => {
    // 实测原文：["2\t0\ta.txt", "-\t-\tbin.dat", ""]
    const r = parseNumstatZ('2\t0\ta.txt\0-\t-\tbin.dat\0');
    expect(r.bad).toEqual([]);
    expect(r.rows[0]).toMatchObject({ path: 'a.txt', add: 2, del: 0, binary: false });
    // 二进制**不许**说成 0 行：add/del 是 null + binary:true（"拿不到行数"≠"没改行"）
    expect(r.rows[1]).toMatchObject({ path: 'bin.dat', add: null, del: null, binary: true });
  });

  it('改名记录：path 为空 ⇒ 后面两段是旧路径、新路径', () => {
    // 实测原文：["0\t0\t","b.txt","c.txt",""]
    const r = parseNumstatZ('0\t0\t\0b.txt\0c.txt\0');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toMatchObject({ path: 'c.txt', oldPath: 'b.txt', add: 0, del: 0 });
  });

  it('文件名里自带 tab 不被当分隔符（只按前两个 tab 切）', () => {
    const r = parseNumstatZ('1\t2\ta\tb.txt\0');
    expect(r.rows[0].path).toBe('a\tb.txt');
    expect(r.rows[0]).toMatchObject({ add: 1, del: 2 });
  });

  it('畸形成分进 bad[]，不静默丢', () => {
    const r = parseNumstatZ('garbage\0');
    expect(r.rows).toEqual([]);
    expect(r.bad.length).toBe(1);
  });
});

describe('解析 ③ 行数：末尾换行不多算一行', () => {
  it('空串 0 行 / 无结尾换行 1 行 / 带结尾换行也是 1 行 / 三行就是 3 行', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\nc\n')).toBe(3);
    expect(countLines('a\r\nb\r\n')).toBe(2);   // CRLF 只数 LF
  });
});

describe('合成 ④ mergeRows：git 覆盖的走 numstat，不覆盖的走盘上行数，拿不到的留空', () => {
  const statusText = ' M a.txt\0?? new.txt\0 M big.log\0';
  const numstatText = '3\t1\ta.txt\0';

  it('三条路径各自的行数来源标得出来（src 字段 = "这个数怎么数出来的"）', () => {
    const m = mergeRows({
      statusText: statusText, numstatText: numstatText, numstatOk: true,
      lineCounts: { 'new.txt': 4 }, countSkipped: ['big.log']
    });
    expect(m.rows.map((r) => [r.path, r.add, r.del, r.src])).toEqual([
      ['a.txt', 3, 1, 'numstat'],
      ['big.log', null, null, 'none'],
      ['new.txt', 4, 0, 'file-lines']
    ]);
    expect(m.rows[1].skipped).toBe(true);
  });

  it('numstatOk=false（没有 HEAD）⇒ 全部走行数档，并**如实说**口径变了', () => {
    const m = mergeRows({
      statusText: '?? a.txt\0', numstatText: '', numstatOk: false,
      lineCounts: { 'a.txt': 7 }
    });
    expect(m.rows[0]).toMatchObject({ path: 'a.txt', add: 7, del: 0, src: 'file-lines' });
  });

  it('numstat 里有、status 里没有 ⇒ 补进清单并记一笔（不许静默）', () => {
    const m = mergeRows({ statusText: '', numstatText: '1\t0\tghost.txt\0', numstatOk: true });
    expect(m.rows.map((r) => r.path)).toEqual(['ghost.txt']);
    expect(m.notes.join('')).toContain('ghost.txt');
  });

  it('**未跟踪的二进制**：行数留空，不许按 utf8 数出一个捏造的数字（探针实测踩到的真缺陷）', () => {
    // 为什么单列一条：`git diff --numstat` 不管未跟踪文件 ⇒ 我们自己去数；
    //   拿 utf8 去数一个含 NUL 的文件会得到"1 行"这种凭空数字，清单里就冒充了一次改动量。
    const m = mergeRows({
      statusText: '?? bin.dat\0', numstatText: '', numstatOk: true,
      binaryPaths: ['bin.dat']
    });
    expect(m.rows[0]).toMatchObject({ path: 'bin.dat', add: null, del: null, binary: true, src: 'binary' });
    // 判别力：把 mergeRows 里 `binaries.has(...)` 那段删掉 ⇒ 这里会退化成 src='none'（或按行数档给 1）
    expect(m.rows[0].src).not.toBe('file-lines');
  });
});

/* ============================ ② 追加计划：去重 / 冲销 / 有界窗口 ============================ */

describe('planAppend ⑤ 只追加、不重复、不编造', () => {
  const meta = { at: '2026-10-18T10:00:00.000Z', root: 'D:/ws', head: 'abc1234', trigger: 'refresh' };

  it('空日志 + 两条行 ⇒ 两条记录，seq 从 1 起', () => {
    const p = planAppend('', [{ path: 'a.txt', status: 'M', add: 3, del: 1, src: 'numstat' }], meta);
    expect(p.added).toBe(1);
    expect(p.records[0]).toMatchObject({ seq: 1, path: 'a.txt', add: 3, del: 1, head: 'abc1234', root: 'D:/ws' });
    expect(p.records[0].v).toBe(ENTRY_VERSION);
  });

  it('同样的行再采一次 ⇒ **零新增、字节不变**（重复采样不许刷屏）', () => {
    const rows = [{ path: 'a.txt', status: 'M', add: 3, del: 1, src: 'numstat' }];
    const p1 = planAppend('', rows, meta);
    const p2 = planAppend(p1.nextText, rows, meta);
    expect(p2.added).toBe(0);
    expect(p2.reverted).toBe(0);
    expect(p2.nextText).toBe(p1.nextText);
    // 判别力：把 `recordKey(prev) === recordKey(r)` 那句判断删掉 ⇒ 这里会变成 1（重复记一条）
  });

  it('行数变了 ⇒ 追加第三条（同一文件不同状态各记一条，历史不覆盖）', () => {
    const p1 = planAppend('', [{ path: 'a.txt', status: 'M', add: 3, del: 1, src: 'numstat' }], meta);
    const p2 = planAppend(p1.nextText, [{ path: 'a.txt', status: 'M', add: 9, del: 1, src: 'numstat' }], meta);
    expect(p2.added).toBe(1);
    expect(p2.records[0]).toMatchObject({ seq: 2, add: 9 });
    const back = parseLog(p2.nextText);
    expect(back.records.length).toBe(2);
    expect(back.badLines).toEqual([]);
  });

  it('改了又改回去 ⇒ 追加一条冲销记录（否则永远挂在清单上 = 把"没改"说成"改了"）', () => {
    const p1 = planAppend('', [{ path: 'a.txt', status: 'M', add: 3, del: 1, src: 'numstat' }], meta);
    const p2 = planAppend(p1.nextText, [], meta);
    expect(p2.reverted).toBe(1);
    expect(p2.records[0]).toMatchObject({ kind: 'revert', status: '=', path: 'a.txt', add: 0, del: 0 });
    const sum = summarize(parseLog(p2.nextText).records);
    expect(sum.rows).toEqual([]);                 // 冲销之后清单里真的没有了
    expect(sum.totals.files).toBe(0);
  });

  it('冲销记录不重复追加（已经是 = 的路径不再记）', () => {
    const p1 = planAppend('', [{ path: 'a.txt', status: 'M', add: 1, del: 0, src: 'numstat' }], meta);
    const p2 = planAppend(p1.nextText, [], meta);
    const p3 = planAppend(p2.nextText, [], meta);
    expect(p3.reverted).toBe(0);
    expect(p3.nextText).toBe(p2.nextText);
  });
});

describe('compact ⑥ 有界窗口**但每个文件的最新一条必须活着**', () => {
  it('超窗口时裁掉最老的，条数压到上限', () => {
    const recs = [];
    for (let i = 1; i <= 10; i++) recs.push(buildRecord({ seq: i, path: 'a.txt', status: 'M', add: i, del: 0, at: '2026-10-18T10:00:0' + (i % 10) + '.000Z' }));
    const c = compact(recs, 4);
    expect(c.records.length).toBe(4);
    expect(c.records.map((r) => r.seq)).toEqual([7, 8, 9, 10]);
    expect(c.dropped).toBe(6);
  });

  it('老文件的唯一一条被裁到窗口之外时**必须捞回来**（不然它会从清单里凭空消失）', () => {
    // old.txt 只有第 1 条；之后 9 条全是 a.txt
    const recs = [buildRecord({ seq: 1, path: 'old.txt', status: 'M', add: 5, del: 0, at: '2026-10-18T09:00:00.000Z' })];
    for (let i = 2; i <= 10; i++) recs.push(buildRecord({ seq: i, path: 'a.txt', status: 'M', add: i, del: 0, at: '2026-10-18T10:00:00.000Z' }));
    const c = compact(recs, 4);
    expect(c.records.map((r) => r.seq)).toContain(1);
    const sum = summarize(c.records);
    expect(sum.rows.map((r) => r.path).sort()).toEqual(['a.txt', 'old.txt']);
    // 判别力：把 compact 里 `latestPerPath(list).forEach(keep.add)` 删掉 ⇒ old.txt 从这里消失
  });
});

/* ============================ ③ 摘要 ============================ */

describe('summarize ⑦ 界面要显示的那一份（口径逐字写清，绝不冒充"本回合"）', () => {
  const recs = parseLog([
    serializeRecord(buildRecord({ seq: 1, path: 'b.txt', status: '?', add: 10, del: 0, src: 'file-lines', at: '2026-10-18T10:00:00.000Z', head: 'deadbeefcafe', root: 'D:/ws' })),
    serializeRecord(buildRecord({ seq: 2, path: 'a.txt', status: 'M', add: 2, del: 1, src: 'numstat', at: '2026-10-18T10:00:01.000Z', head: 'deadbeefcafe', root: 'D:/ws' })),
    serializeRecord(buildRecord({ seq: 3, path: 'z.txt', status: 'M', add: 1, del: 1, src: 'numstat', at: '2026-10-18T10:00:02.000Z' })),
    serializeRecord(buildRecord({ seq: 4, kind: 'revert', path: 'z.txt', status: '=', add: 0, del: 0, at: '2026-10-18T10:00:03.000Z' }))
  ].join('')).records;

  it('冲销掉的不出现；按改动量从大到小排；合计只数还在的', () => {
    const s = summarize(recs);
    expect(s.rows.map((r) => r.path)).toEqual(['b.txt', 'a.txt']);
    expect(s.totals).toEqual({ files: 2, added: 12, deleted: 1, binary: 0 });
  });

  it('口径必须自带（unit/unitText/来源/追溯 argv）—— 这是唯一能和 kernel 那个数混的地方', () => {
    const s = summarize(recs);
    expect(s.unit).toBe('vs-head-cumulative');
    expect(s.unitText).toContain('累计');
    expect(s.sourceText).toContain('git working tree');
    expect(s.trace.argv).toContain('--numstat');
    // argv 来自 GIT_ARGV 单源（不是这里另写一份字符串）
    expect(s.trace.argv).toContain(GIT_ARGV.status.join(' '));
  });

  it('head 取最新那条有 head 的记录的短形态；时间用人话', () => {
    const s = summarize(recs);
    expect(s.head).toBe('deadbeefcafe');
    expect(s.headShort).toBe('deadbeef');
    expect(s.atText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('空清单 ⇒ 0 条（这是真的"没有改动"，与"采不到"由 source 区分）', () => {
    expect(summarize([]).rows).toEqual([]);
    expect(summarize([]).totals.files).toBe(0);
  });

  it('二进制文件不算行数但要点名', () => {
    const one = parseLog(serializeRecord(buildRecord({ seq: 1, path: 'bin.dat', status: 'A', add: null, del: null, binary: true, at: '2026-10-18T10:00:00.000Z' })).replace(/\n$/, '')).records;
    const s = summarize(one);
    expect(s.totals).toEqual({ files: 1, added: 0, deleted: 0, binary: 1 });
  });
});

/* ============================ ④ 存储：单一写者 / 重启后还在 ============================ */

describe('createStore ⑧ 落盘走唯一出口，重启后还在（新实例读同一份文件）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mm-cl-test-'));
  const file = path.join(dir, FILE_NAME);
  const meta = { at: '2026-10-18T10:00:00.000Z', root: 'D:/ws', head: 'abc1234', trigger: 'smoke' };

  it('首采（文件还不存在）也写一次 —— "采到了、确实没改动"要留痕', () => {
    const st = createStore({ file: file, writeFileAtomic: writeFileAtomic });
    expect(existsSync(file)).toBe(false);
    const r = st.record([], meta);
    expect(r.ok).toBe(true);
    expect(r.written).toBe(true);
    expect(r.missing).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('没有变化就不再写（不动的字节也不动 mtime）', () => {
    const st = createStore({ file: file, writeFileAtomic: writeFileAtomic });
    const before = statSync(file);
    const r = st.record([], meta);
    expect(r.written).toBe(false);
    expect(r.added).toBe(0);
    const after = statSync(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('新记录写进去之后，**换一个 store 实例**（= 进程重启）照样读得到', () => {
    const a = createStore({ file: file, writeFileAtomic: writeFileAtomic });
    a.record([{ path: 'x.js', status: 'M', add: 4, del: 2, src: 'numstat' }], meta);
    // 换实例：不共享任何内存状态（**"重启后还在"的可复核形式就是这一句**）
    const b = createStore({ file: file, writeFileAtomic: writeFileAtomic });
    const s = b.status();
    expect(s.ok).toBe(true);
    expect(s.missing).toBe(false);
    expect(s.reading.rows.map((r) => [r.path, r.add, r.del])).toEqual([['x.js', 4, 2]]);
    // 再从盘上原文本解析一遍，逐字节确认落的是 JSONL（一行一条）
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n').filter(Boolean).length).toBe(1);
    expect(JSON.parse(text.trim())).toMatchObject({ path: 'x.js', add: 4, del: 2, seq: 1 });
  });

  it('读得回、坏行不静默吞（手写一条垃圾行进文件 ⇒ badLines 点出来，好行照读）', () => {
    writeFileSync(file, readFileSync(file, 'utf8') + 'not json\n', 'utf8');
    const st = createStore({ file: file, writeFileAtomic: writeFileAtomic });
    const cur = st.read();
    expect(cur.records.length).toBe(1);
    expect(cur.badLines).toEqual([2]);
  });

  it('没给 file / 没给 writeFileAtomic ⇒ 当场报错（不许悄悄换一条写盘路）', () => {
    expect(() => createStore({ writeFileAtomic: writeFileAtomic })).toThrow(/file/);
    expect(() => createStore({ file: file })).toThrow(/writeFileAtomic/);
  });

  it('清理临时目录（本文件自己收尾，不留垃圾）', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

/* ============================ ⑤ 结构断言（判据 ②：单一写者） ============================ */

describe('结构 ⑨ 单一写者：文件名只出现一处、模块里没有第二套写盘原语', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'change-log.js'), 'utf8');

  it('`change-log.jsonl` 这个字面量**只在本模块**出现（别处必须用 FILE_NAME）', () => {
    const targets = ['main.js', 'preload.js', 'main-dsh-sidebar.js',
      path.join('src', 'data-store.js'), path.join('cli', 'core.js')];
    targets.forEach((rel) => {
      const p = path.join(ROOT, rel);
      let t = '';
      try { t = readFileSync(p, 'utf8'); } catch (e) { return; }
      expect(t.indexOf(FILE_NAME), rel + ' 里出现了第二次文件名').toBeLessThan(0);
    });
    expect(src.indexOf(FILE_NAME) >= 0).toBe(true);
  });

  it('本模块里 `fs.writeFileSync(` / `fs.appendFile(` / 自造 tmp+rename **一次都没有**', () => {
    // 带左括号才算"一次调用"：文件头的注释里**明写了**这条规矩（`fs.writeFileSync` 一次都不许有），
    // 不带上括号的话注释自己会把这条断言判红（本批实测踩到过一次 —— 判据要看代码，不看自述）
    expect(src.indexOf('writeFileSync(')).toBeLessThan(0);
    expect(src.indexOf('appendFile(')).toBeLessThan(0);
    expect(src.indexOf('renameSync(')).toBeLessThan(0);
  });

  it('本模块里对注入的写出口只有 `writeAtomic(` 这一处调用', () => {
    const calls = src.match(/writeAtomic\(/g) || [];
    expect(calls.length).toBe(1);
  });

  it('有界窗口与采样间隔都是常量（没有散落在各处的魔数）', () => {
    expect(MAX_RECORDS).toBe(400);
    expect(SAMPLE_MIN_INTERVAL_MS).toBe(1500);
    // 状态码表覆盖本模块会产出的全部状态（含冲销态 '='）
    ['M', 'A', 'D', 'R', '?', 'U', '='].forEach((k) => {
      expect(typeof STATUS_TEXT[k], '缺少状态码文案：' + k).toBe('string');
    });
  });
});

/* ============================ ⑥ 追溯性（判据 ① 的单测形态） ============================ */

describe('追溯 ⑩ 每条记录的数都能由夹具原文复算出来（不许自己另算一份）', () => {
  it('记录里的 add/del 与 status 输出的路径、numstat 输出的数字逐条对得上', () => {
    const statusText = ' M a.txt\0?? new.txt\0D  gone.txt\0R  c.txt\0b.txt\0';
    const numstatText = '3\t1\ta.txt\0-\t-\tbin.dat\0';
    const m = mergeRows({
      statusText: statusText, numstatText: numstatText, numstatOk: true,
      lineCounts: { 'new.txt': 2, 'c.txt': 0 }
    });
    const p = planAppend('', m.rows, { at: '2026-10-18T10:00:00.000Z', root: 'D:/ws', head: 'h1' });
    const asMap = new Map(p.records.map((r) => [r.path, r]));
    // 手算：a.txt 来自 numstat 的 3/1；new.txt 来自盘上 2 行 ⇒ 2/0；gone.txt 盘上读不到 ⇒ null/null
    expect(asMap.get('a.txt')).toMatchObject({ add: 3, del: 1, src: 'numstat' });
    expect(asMap.get('new.txt')).toMatchObject({ add: 2, del: 0, src: 'file-lines' });
    expect(asMap.get('gone.txt')).toMatchObject({ add: null, del: null, src: 'none' });
    // 改名那条：路径是**新**路径，旧路径留在 oldPath 里
    expect(asMap.get('c.txt')).toMatchObject({ status: 'R', oldPath: 'b.txt' });
    // 清单里没有凭空多出 bin.dat（status 里没有它；补进去也必须有 notes 说明）
    expect(m.notes.join('')).toContain('bin.dat');
  });

  it('记录的出处三件（root / head / trigger）逐条自带 —— 老记录也能自证采自哪一版', () => {
    const p = planAppend('', [{ path: 'a.txt', status: 'M', add: 1, del: 0, src: 'numstat' }],
      { at: '2026-10-18T10:00:00.000Z', root: 'D:/ws', head: 'h1', trigger: 'refresh' });
    expect(p.records[0]).toMatchObject({ root: 'D:/ws', head: 'h1', trigger: 'refresh' });
    // 序列化再解析一轮，字段一个不少（JSONL 往返保真）
    const back = parseLog(serializeRecord(p.records[0])).records[0];
    expect(back).toMatchObject({ root: 'D:/ws', head: 'h1', trigger: 'refresh', add: 1 });
  });

  it('recordKey 把 add/del 的 null 与 0 分得开（"拿不到行数"≠"0 行"）', () => {
    expect(recordKey({ status: 'M', add: null, del: null })).toBe('M|-|-');
    expect(recordKey({ status: 'M', add: 0, del: 0 })).toBe('M|0|0');
    expect(recordKey({ status: 'M', add: null, del: null })).not.toBe(recordKey({ status: 'M', add: 0, del: 0 }));
  });

  it('latestPerPath 只留最新（旧记录仍在日志里，只是不参与"当前状态"）', () => {
    const recs = parseLog([
      serializeRecord(buildRecord({ seq: 1, path: 'a', status: 'M', add: 1, del: 0 })),
      serializeRecord(buildRecord({ seq: 2, path: 'a', status: 'M', add: 2, del: 0 }))
    ].join('')).records;
    expect(recs.length).toBe(2);
    expect(latestPerPath(recs).get('a').seq).toBe(2);
  });
});
