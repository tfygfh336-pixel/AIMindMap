/* ============================================================
 * tests/encoding-check.test.js — G1「编码完整性」的判别力锁
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么门禁还要配测试：G1 是 verify 的**首步**、守的是"全损事故"那一类损害，
 * 而它此前是本工程十来个门禁脚本里**唯一既没有 `require.main` 守卫、也没有单测**的那个
 * （它若写错了，只会永远通过 —— 而"文件看起来没问题"正是它要制造的那份假象）。
 * 范式照抄 `tests/rules-consistency.test.js`（对 G9 做的是同一件事）。
 *
 * 本文件锁四件事：
 *   ① 三条编码判据（BOM / U+FFFD / 经典乱码）各能被**单独的**违规打红 —— 而不是"有一条红就都红"；
 *   ② **行尾是两条判定，方向相反**：④ 只判 **index（提交面）**，⑤ 判 **工作树（签出面）的方向**。
 *      2026-10-18 的订正（"只判 index"）在 2026-10-21 被**扩成两条**：只守 ④ 时，"今天全链全绿"
 *      与"新克隆必红"能同时成立（新克隆里 400+ 个文本全是 CRLF，而 index 一个 CR 都没有）。
 *      ⇒ ④ 的用例保持"工作树 CRLF 不算 ④ 违规"不变；**⑤ 的三档**（判红 / 只报告 / 跳过）
 *      与本册上界在下面同一批用例里钉住（**不新增 `it()`**：用例计数被 G6 的真值钉着）。
 *   ③ **扫描面不得静默**：白名单外还有文本文件时，"未扫描"那行必须把它**点名**；
 *      "若纳入会红几个"必须由判据本身（`scanText`）算，不许另立一套口径。
 *   ④ **本批的决定要用测试钉住**：`.log` 不许进白名单 —— 它不是"漏了"，
 *      而是被 `.gitignore` 定性为运行转储（全仓 101 个历史转储会因此永久红）。
 *      没有这条用例，将来一句"顺手补全一点"就能把这个决定推翻掉。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ec = require('../scripts/encoding-check.js');

/** 拼一条 `git ls-files --eol -z` 记录（格式与实际输出一致：三列 + 填充 + `\t` + 路径） */
const rec = (i, w, p) => 'i/' + i + '    w/' + w + '  attr/                 \t' + p;
const listing = (...recs) => recs.join('\0') + '\0';

describe('G1 编码判据（逐条注入 ⇒ 必须各自命中）', () => {
  it('干净的 UTF-8：三条全不命中', () => {
    const r = ec.scanText(Buffer.from('普通的中文文本\n第二行\n', 'utf8'));
    expect(r.bom).toBe(false);
    expect(r.fffd).toBe(false);
    expect(r.mojibake).toEqual([]);
  });

  it('UTF-8 BOM（EF BB BF）⇒ 只命中 bom', () => {
    const r = ec.scanText(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('中文', 'utf8')]));
    expect(r.bom).toBe(true);
    expect(r.fffd).toBe(false);
    expect(r.mojibake).toEqual([]);
  });

  it('无法按 UTF-8 解码的字节（0xFF）⇒ 只命中 fffd', () => {
    const r = ec.scanText(Buffer.concat([Buffer.from('中文', 'utf8'), Buffer.from([0xFF, 0xFE, 0x41])]));
    expect(r.bom).toBe(false);
    expect(r.fffd).toBe(true);
    expect(r.mojibake).toEqual([]);
  });

  it('经典乱码特征（GBK 解码残留 / 未初始化内存）⇒ 只命中 mojibake', () => {
    const gbk = String.fromCharCode(0x9539, 0x65A4, 0x62F7);
    const mem = String.fromCharCode(0x70EB, 0x70EB, 0x70EB);
    expect(ec.scanText(Buffer.from(gbk, 'utf8')).mojibake.length).toBe(1);
    expect(ec.scanText(Buffer.from(mem, 'utf8')).mojibake.length).toBe(1);
  });

  it('★ 门禁要能抓到自己的输入：本文件自身与 encoding-check.js 都必须是干净的', () => {
    // 这条反向锁住"源码里不许出现乱码字面量"——乱码特征一律用码点构造
    for (const rel of ['scripts/encoding-check.js', 'tests/encoding-check.test.js']) {
      const buf = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', rel));
      const r = ec.scanText(buf);
      expect({ rel: rel, ...r }).toEqual({ rel: rel, bom: false, fffd: false, mojibake: [] });
    }
  });
});

describe('G1 行尾：④ 只判 index（提交面）；⑤ 判工作树的**方向**（在册的只报告）', () => {
  it('i/lf + w/lf ⇒ 无违规', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'lf', 'src/a.js')));
    expect(r.bad).toEqual([]);
    expect(r.text).toEqual(['src/a.js']);
    expect(r.binary).toEqual([]);
  });

  it('★★ i/lf + w/crlf ⇒ **④ 无违规**；⑤ 里在册 ⇒ 只报告、不在册 ⇒ 判红', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'crlf', 'renderer/app-ask.js')));
    expect(r.bad).toEqual([]);
    expect(r.text).toEqual(['renderer/app-ask.js']);
    // ⑤：同一条 CR 读数，**在册**时是"只报告档"（red 空、debt 一条，理由原样交出去）
    const rows = [{ rel: 'renderer/app-ask.js', cr: 1041 }];
    const onBook = ec.judgeWorktreeEol(rows, {
      debt: [{ path: 'renderer/app-ask.js', why: '签出产物', cr: 1041 }],
      max: 1, mode: 'transition', known: new Set(['renderer/app-ask.js'])
    });
    expect(onBook.red).toEqual([]);
    expect(onBook.debt.length).toBe(1);
    expect(onBook.debt[0].why).toBe('签出产物');
    // ⑤：**从册上拿掉**就判红（这是"只报告"与"没能力判"的分界 —— 不红的那一档必须能变红）
    const offBook = ec.judgeWorktreeEol(rows, {
      debt: [], max: 0, mode: 'transition', known: new Set(['renderer/app-ask.js'])
    });
    expect(offBook.red).toEqual([{ rel: 'renderer/app-ask.js', cr: 1041, ext: '.js' }]);

    // ⑤ 的**在册册**：形状（path / why / cr，照 `WRITE_OUTLET_DEBT`）+ 上限**只减不增**。
    // 「把一条欠账拆成两条换额度」是这个上限唯一防得住的姿势 ⇒ 多一条必须**自己报超额**。
    for (const e of ec.WORKTREE_CR_DEBT) {
      expect(typeof e.path).toBe('string');
      expect(e.path.length).toBeGreaterThan(0);
      expect(typeof e.why).toBe('string');
      expect(e.why.length).toBeGreaterThan(0);
      expect(typeof e.cr).toBe('number');
      expect(e.cr).toBeGreaterThan(0);
    }
    // 上界写成字面量（不是 `.length`）：今天正好用满 ⇒ 再多一条就没有额度
    expect(ec.WORKTREE_CR_DEBT.length).toBe(ec.WORKTREE_CR_DEBT_MAX);
    const bookRows = ec.WORKTREE_CR_DEBT.map((e) => ({ rel: e.path, cr: e.cr }));
    const book = new Set(ec.WORKTREE_CR_DEBT.map((e) => e.path));
    const base = { max: ec.WORKTREE_CR_DEBT_MAX, mode: 'transition', known: book };
    const ok = ec.judgeWorktreeEol(bookRows, Object.assign({ debt: ec.WORKTREE_CR_DEBT }, base));
    expect(ok.red).toEqual([]);
    expect(ok.debt.length).toBe(2);             // 2 条在册且都含 CR ⇒ 全在"只报告"档
    expect(ok.capMismatch).toBe(null);          // 唯一合法状态：上限 == 在册条数
    // ① 册涨到 3 条而不抬上限 ⇒ **超额**（拆细换额度当场被抓）
    const split = ec.WORKTREE_CR_DEBT.concat([{ path: 'renderer/app-view.js', why: '拆细换额度试算', cr: 1 }]);
    const over = ec.judgeWorktreeEol(bookRows, Object.assign({ debt: split }, base));
    expect(over.capMismatch).not.toBe(null);
    expect(over.capMismatch.kind).toBe('over');
    expect(over.capMismatch.debtCount).toBe(3);
    expect(over.capMismatch.cap).toBe(2);
    expect(over.red).toEqual([]);               // 这条红**只**来自额度（不是靠"未在册的 CR"顺带红）
    // 同批把上界抬到 3 ⇒ 复绿（抬上界 = 一次显式提交，不是顺手改个数字）
    expect(ec.judgeWorktreeEol(bookRows, Object.assign({ debt: split }, base, { max: 3 })).capMismatch).toBe(null);
    // ② 只抬上界、册不动 ⇒ **富余额度**（先把口子开好、下一批再往里塞，同样判红）
    const slack = ec.judgeWorktreeEol(bookRows, Object.assign({ debt: ec.WORKTREE_CR_DEBT }, base, { max: 3 }));
    expect(slack.capMismatch).not.toBe(null);
    expect(slack.capMismatch.kind).toBe('slack');
    expect(slack.capMismatch.debtCount).toBe(2);
    expect(slack.capMismatch.cap).toBe(3);
    // 终态（有 catch-all 的 eol=lf）：签出方向已定死 ⇒ 上界压到只剩脚本宿主那几条 ⇒ 那 1 条必须销账
    const term = ec.judgeWorktreeEol(bookRows, Object.assign({ debt: ec.WORKTREE_CR_DEBT }, base, { mode: 'terminal' }));
    expect(term.capMismatch).not.toBe(null);
    expect(term.capMismatch.kind).toBe('over');
    expect(term.capMismatch.cap).toBe(1);       // 只有"启动AI MindMap.vbs"这一类允许留
    expect(term.capMismatch.mustDelist.length).toBe(1);
  });

  it('★ i/lf + w/mixed ⇒ **④ 无违规**；⑤ 里它一样按"有没有 CR"判（不在册即红）', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'mixed', 'scripts/smoke/09-save-persistence.js')));
    expect(r.bad).toEqual([]);
    const wt = ec.judgeWorktreeEol([{ rel: 'scripts/smoke/09-save-persistence.js', cr: 2 }], {
      debt: [], max: 0, mode: 'transition', known: new Set(['scripts/smoke/09-save-persistence.js'])
    });
    expect(wt.red.length).toBe(1);              // 孤立 CR 也算（判据只看 cr > 0，不看它是怎么来的）
  });

  it('★★ i/crlf ⇒ 违规（提交进仓库的文本必须是 LF）', () => {
    const r = ec.parseEolListing(listing(rec('crlf', 'crlf', 'docs/x.md')));
    expect(r.bad).toEqual([{ rel: 'docs/x.md', index: 'crlf' }]);
  });

  it('i/mixed ⇒ 违规（index 里也不许混）', () => {
    const r = ec.parseEolListing(listing(rec('mixed', 'lf', 'docs/y.md')));
    expect(r.bad.length).toBe(1);
  });

  it('i/-text（git 判为二进制）⇒ 不进文本面、也不算违规；⑤ 里进**跳过档**', () => {
    const r = ec.parseEolListing(listing(rec('-text', '-text', 'renderer/logo.png')));
    expect(r.bad).toEqual([]);
    expect(r.text).toEqual([]);
    expect(r.binary).toEqual(['renderer/logo.png']);
    const wt = ec.judgeWorktreeEol([], { debt: [], max: 0, mode: 'transition', binary: ['renderer/logo.png'] });
    expect(wt.skipBinary).toEqual(['renderer/logo.png']);   // 跳过档：打印对象，但既不判红也不判绿
    expect(wt.red).toEqual([]);
  });

  it('非 ASCII 路径必须原样解析（实测坑：默认输出会 C-quote 成 "\\345\\220..."，故实现用 -z）', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'crlf', '启动AI MindMap.vbs')));
    expect(r.text).toEqual(['启动AI MindMap.vbs']);
    expect(r.bad).toEqual([]);
    // ⑤：`.vbs` 在册 ⇒ 只报告（册上那条的 why 说清它是脚本宿主）；**不在册**的 `.vbs` ⇒ 跳过档
    const registered = ec.judgeWorktreeEol([{ rel: '启动AI MindMap.vbs', cr: 9 }], {
      debt: [{ path: '启动AI MindMap.vbs', why: '脚本宿主按 CRLF 存', cr: 9 }],
      max: 1, mode: 'transition', known: new Set(['启动AI MindMap.vbs'])
    });
    expect(registered.red).toEqual([]);
    expect(registered.debt.length).toBe(1);
    const unregistered = ec.judgeWorktreeEol([{ rel: '新脚本.vbs', cr: 3 }], {
      debt: [], max: 0, mode: 'transition', known: new Set(['新脚本.vbs'])
    });
    expect(unregistered.red).toEqual([]);
    expect(unregistered.skipScript.map((x) => x.rel)).toEqual(['新脚本.vbs']);
  });

  it('空输出 / 末尾多余 NUL / 缺 tab 的坏行都不许抛，也不许造出假条目；⑤ 的属性文件解析同样不猜', () => {
    expect(ec.parseEolListing('').bad).toEqual([]);
    expect(ec.parseEolListing('\0\0').files.size).toBe(0);
    expect(ec.parseEolListing('i/lf w/lf attr/ 没有制表符').files.size).toBe(0);
    // ⑤ 的形态判据：没有文件 / 有文件但**没有 catch-all 的 eol=lf** ⇒ 都算过渡态（不猜终态）
    expect(ec.parseAttrMode(null).mode).toBe('transition');
    expect(ec.parseAttrMode(null).reason).toBe('no-file');
    expect(ec.parseAttrMode('*.md text eol=lf\n*.js text eol=lf\n').mode).toBe('transition');
    expect(ec.parseAttrMode('*.md text eol=lf\n').reason).toBe('no-catch-all');
    // 只有 catch-all 那一行同时给了 text 与 eol=lf 才算终态（它才推得出"工作树必须全 LF"）
    expect(ec.parseAttrMode('# 注释\n* text=auto eol=lf\n*.vbs text eol=crlf\n').mode).toBe('terminal');
  });
});

describe('G1 扫描面：边界不许静默', () => {
  it('binary / utf16 / text 三档按头部可靠区分', () => {
    expect(ec.sniffKind(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01]))).toBe('binary');
    expect(ec.sniffKind(Buffer.from([0xFF, 0xFE, 0x41, 0x00]))).toBe('utf16');
    expect(ec.sniffKind(Buffer.from([0xFE, 0xFF, 0x00, 0x41]))).toBe('utf16');
    expect(ec.sniffKind(Buffer.from('普通文本', 'utf8'))).toBe('text');
  });

  it('聚合必须把"会红几个"按 utf16 / 其余分开记（这正是"为什么不扩白名单"的证据）', () => {
    const agg = ec.aggregateSkipped([
      { ext: '.log', kind: 'utf16', red: true },
      { ext: '.log', kind: 'text', red: true },
      { ext: '.log', kind: 'text', red: false },
      { ext: '.png', kind: 'binary', red: false }
    ]);
    expect(agg.total).toBe(4);
    expect(agg.textLike).toBe(3);          // 二进制不算文本类
    expect(agg.red).toBe(2);
    expect(agg.redUtf16).toBe(1);
    expect(agg.textExts.map((x) => x[0])).toEqual(['.log']);   // 只有文本类扩展名进"点名"列表
  });

  it('★ 有文本类未扫描文件时，那一行必须点名扩展名（不许只报个总数就完了）', () => {
    const agg = ec.aggregateSkipped([
      { ext: '.log', kind: 'text', red: false },
      { ext: '.jsonl', kind: 'text', red: false }
    ]);
    const line = ec.describeSkipped(agg);
    expect(line).toContain('.log');
    expect(line).toContain('.jsonl');
    expect(line).toContain('未扫描');
  });

  it('★ 会红数量 > 0 时必须写明"若纳入会立刻红 N 个"（把决定的依据印在输出里）', () => {
    const agg = ec.aggregateSkipped([{ ext: '.log', kind: 'utf16', red: true }]);
    expect(ec.describeSkipped(agg)).toContain('立刻红 1 个');
  });

  it('全部覆盖时不许留空话（要说 0 个）', () => {
    expect(ec.describeSkipped(ec.aggregateSkipped([]))).toContain('0 个');
  });
});

describe('G1 扫描面的决定：.log 不许进白名单（本批的决定，用测试钉住）', () => {
  it('TEXT_EXT 里不许有 .log —— 全仓 .log 全是未跟踪运行转储，纳入即永久红 101 个', () => {
    expect(ec.TEXT_EXT).not.toContain('.log');
  });

  it('TEXT_EXT 里不许有二进制扩展名（PNG 字节不构成合法 UTF-8 ⇒ 必然误判成"损坏"）', () => {
    for (const bin of ['.png', '.pdf', '.jpg', '.ico', '.zip']) expect(ec.TEXT_EXT).not.toContain(bin);
  });

  it('受管文本不看扩展名：既然按 git 判，白名单里就不该再靠"补一个扩展名"来补覆盖', () => {
    // .vbs 是真实受管资产（用户启动器），但它由"git 判为文本的跟踪文件"这一条覆盖，不在白名单里
    expect(ec.TEXT_EXT).not.toContain('.vbs');
    // ⑤ 的**跳过档**是**语义**名单（Windows 脚本宿主按 CRLF 存），不是"白名单"的补丁
    expect(ec.WORKTREE_EOL_SKIP_EXT).toContain('.vbs');
    expect(ec.WORKTREE_EOL_SKIP_EXT).toContain('.bat');
    expect(ec.WORKTREE_EOL_SKIP_EXT).toContain('.cmd');
  });
});
