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
 *   ② **行尾判据只判 index，不判工作树**。这条是本批（2026-10-18）订正的核心：
 *      `core.autocrlf=true`（system 级）+ 仓内无 `.gitattributes` ⇒ 工作树必然是混合的，
 *      拿工作树行尾当判据就是在判一个**由 git 配置决定的东西**。故有专门的反向用例锁住它。
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

describe('G1 行尾判据：只判 index，不判工作树', () => {
  it('i/lf + w/lf ⇒ 无违规', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'lf', 'src/a.js')));
    expect(r.bad).toEqual([]);
    expect(r.text).toEqual(['src/a.js']);
    expect(r.binary).toEqual([]);
  });

  it('★★ i/lf + w/crlf ⇒ **无违规**（工作树 CRLF 是 core.autocrlf 的产物，不是缺陷）', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'crlf', 'renderer/app-ask.js')));
    expect(r.bad).toEqual([]);
    expect(r.text).toEqual(['renderer/app-ask.js']);
  });

  it('★ i/lf + w/mixed ⇒ **无违规**（同上：工作树混合也不判）', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'mixed', 'scripts/smoke/09-save-persistence.js')));
    expect(r.bad).toEqual([]);
  });

  it('★★ i/crlf ⇒ 违规（提交进仓库的文本必须是 LF）', () => {
    const r = ec.parseEolListing(listing(rec('crlf', 'crlf', 'docs/x.md')));
    expect(r.bad).toEqual([{ rel: 'docs/x.md', index: 'crlf' }]);
  });

  it('i/mixed ⇒ 违规（index 里也不许混）', () => {
    const r = ec.parseEolListing(listing(rec('mixed', 'lf', 'docs/y.md')));
    expect(r.bad.length).toBe(1);
  });

  it('i/-text（git 判为二进制）⇒ 不进文本面、也不算违规', () => {
    const r = ec.parseEolListing(listing(rec('-text', '-text', 'renderer/logo.png')));
    expect(r.bad).toEqual([]);
    expect(r.text).toEqual([]);
    expect(r.binary).toEqual(['renderer/logo.png']);
  });

  it('非 ASCII 路径必须原样解析（实测坑：默认输出会 C-quote 成 "\\345\\220..."，故实现用 -z）', () => {
    const r = ec.parseEolListing(listing(rec('lf', 'crlf', '启动AI MindMap.vbs')));
    expect(r.text).toEqual(['启动AI MindMap.vbs']);
    expect(r.bad).toEqual([]);
  });

  it('空输出 / 末尾多余 NUL / 缺 tab 的坏行都不许抛，也不许造出假条目', () => {
    expect(ec.parseEolListing('').bad).toEqual([]);
    expect(ec.parseEolListing('\0\0').files.size).toBe(0);
    expect(ec.parseEolListing('i/lf w/lf attr/ 没有制表符').files.size).toBe(0);
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
  });
});
