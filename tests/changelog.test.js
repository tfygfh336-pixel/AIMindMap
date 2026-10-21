/* ============================================================
 * tests/changelog.test.js — CHANGELOG 发版变换单元测试（vitest）
 * ------------------------------------------------------------
 * 锁住一个**真实缺陷**：原实现用两次 String.replace 做
 * 「[Unreleased] → [vX.Y.Z]」，把 [Unreleased] 段里那句占位说明
 * 一起带进了新版本段（v0.15.0 实际中招，版本段开头多出一句无意义占位文字）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  releaseChangelog, indexChangelog, splitChangelog, renderArchiveFile, searchArchives, PLACEHOLDER,
  checkChangelogStructure,
  /* 【G-15 下沉 · 2026-10-22】归档检索的**纯核心**：喂"已读出来的归档正文"而不是目录 */
  searchArchiveTexts
} from '../src/changelog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 构造一份典型的 CHANGELOG（含一段真实变更 + 一个历史版本段） */
function mk() {
  return [
    '# CHANGELOG',
    '',
    '> 约定：先记在 [Unreleased]。',
    '',
    '## [Unreleased]',
    '',
    PLACEHOLDER,
    '',
    '### 新增了某功能',
    '',
    '- 细节一',
    '- 细节二',
    '',
    '## [v0.14.0] - 2026-09-15',
    '',
    '### 老功能',
    '',
    '- 老的细节',
    ''
  ].join('\n');
}

describe('changelog.releaseChangelog', () => {
  it('把 [Unreleased] 变成版本段，并在顶部重建空的 [Unreleased]', () => {
    const out = releaseChangelog(mk(), '0.15.0', '2026-09-16');
    expect(out).toContain('## [Unreleased]');
    expect(out).toContain('## [v0.15.0] - 2026-09-16');
    // [Unreleased] 必须排在 [v0.15.0] 之前
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [v0.15.0]'));
    // 历史版本段仍在，且在最后
    expect(out.indexOf('## [v0.15.0]')).toBeLessThan(out.indexOf('## [v0.14.0]'));
  });

  it('回归：占位行**不会**被带进新版本段（v0.15.0 曾中招的缺陷）', () => {
    const out = releaseChangelog(mk(), '0.15.0', '2026-09-16');
    // 全文只应出现一次占位行
    expect(out.split(PLACEHOLDER).length - 1).toBe(1);
    // 且它必须位于 [Unreleased] 与第一个版本段标题之间
    const phAt = out.indexOf(PLACEHOLDER);
    const unreleasedAt = out.indexOf('## [Unreleased]');
    const versionAt = out.indexOf('## [v0.15.0]');
    expect(phAt).toBeGreaterThan(unreleasedAt);
    expect(phAt).toBeLessThan(versionAt);
  });

  it('版本段正文与顺序被完整保留', () => {
    const out = releaseChangelog(mk(), '0.15.0', '2026-09-16');
    const versionAt = out.indexOf('## [v0.15.0]');
    const nextVerAt = out.indexOf('## [v0.14.0]');
    const section = out.slice(versionAt, nextVerAt);
    expect(section).toContain('### 新增了某功能');
    expect(section).toContain('- 细节一');
    expect(section).toContain('- 细节二');
    expect(section).not.toContain(PLACEHOLDER);
  });

  it('历史版本段内容一字不动', () => {
    const out = releaseChangelog(mk(), '0.15.0', '2026-09-16');
    expect(out.slice(out.indexOf('## [v0.14.0]'))).toContain('- 老的细节');
  });

  it('标题与前言保持不动', () => {
    const out = releaseChangelog(mk(), '0.15.0', '2026-09-16');
    expect(out.startsWith('# CHANGELOG\n\n> 约定：先记在 [Unreleased]。\n\n')).toBe(true);
  });

  it('缺少 [Unreleased] 段时抛错', () => {
    expect(() => releaseChangelog('# C\n\n## [v1.0.0] - 2020-01-01\n\n### x\n', '1.0.1', '2026-09-16'))
      .toThrow(/缺少 \[Unreleased\] 段/);
  });

  it('[Unreleased] 无内容时拒绝发版（避免产生空版本段）', () => {
    const empty = '# C\n\n## [Unreleased]\n\n' + PLACEHOLDER + '\n\n## [v1.0.0] - 2020-01-01\n\n### x\n';
    expect(() => releaseChangelog(empty, '1.0.1', '2026-09-16')).toThrow(/没有任何变更内容/);
  });

  it('没有占位行的旧格式也能正常发版', () => {
    const old = '# C\n\n## [Unreleased]\n\n### 变更\n\n- a\n\n## [v1.0.0] - 2020-01-01\n\n### y\n';
    const out = releaseChangelog(old, '1.0.1', '2026-09-16');
    expect(out).toContain('## [v1.0.1] - 2026-09-16');
    expect(out.split(PLACEHOLDER).length - 1).toBe(1);   // 新占位行被补上
  });

  it('[Unreleased] 是文件最后一个段（其后无历史版本）也能工作', () => {
    const only = '# C\n\n## [Unreleased]\n\n### 变更\n\n- a\n';
    const out = releaseChangelog(only, '0.1.0', '2026-09-16');
    expect(out).toContain('## [Unreleased]');
    expect(out).toContain('## [v0.1.0] - 2026-09-16');
    expect(out).toContain('- a');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('回归：文件末尾无换行时**绝不产出损坏文档**（曾把前言复制进版本段）', () => {
    // 复现过的缺陷：headEnd 用 indexOf('\n')+1，无尾换行时得 0 →
    // 正文从文件开头算起 → 前言被整段复制进版本段，且**不抛错**（静默损坏）。
    // 修正后：该输入（[Unreleased] 无任何变更内容）被正确拒绝。
    const noNewline = '# C\n\n## [Unreleased]';
    expect(() => releaseChangelog(noNewline, '1.0.0', '2026-01-01')).toThrow(/没有任何变更内容/);
  });

  it('回归：无尾换行但有变更内容时正常发版，且前言只出现一次', () => {
    const noNewline = '# C\n\n## [Unreleased]\n\n### 变更\n\n- a';
    const out = releaseChangelog(noNewline, '1.0.0', '2026-01-01');
    expect(out.split('# C').length - 1).toBe(1);                 // 前言未被复制
    expect(out.split('## [Unreleased]').length - 1).toBe(1);
    expect(out).toContain('## [v1.0.0] - 2026-01-01');
    expect(out).toContain('- a');
  });

  it('可连续发版两次（第二次处理第一次留下的空 [Unreleased]）', () => {
    const first = releaseChangelog(mk(), '0.15.0', '2026-09-16');
    // 模拟：发版后又记录了一条变更
    const withNew = first.replace(
      '## [Unreleased]\n\n' + PLACEHOLDER,
      '## [Unreleased]\n\n' + PLACEHOLDER + '\n\n### 修了个 bug\n\n- 细节'
    );
    const second = releaseChangelog(withNew, '0.15.1', '2026-09-17');
    expect(second).toContain('## [v0.15.1] - 2026-09-17');
    expect(second).toContain('## [v0.15.0] - 2026-09-16');
    expect(second.split(PLACEHOLDER).length - 1).toBe(1);
    expect(second.indexOf('## [v0.15.1]')).toBeLessThan(second.indexOf('## [v0.15.0]'));
  });

  it('空/异常输入：空串抛缺段错误，不崩', () => {
    expect(() => releaseChangelog('', '1.0.0', '2026-09-16')).toThrow(/缺少 \[Unreleased\] 段/);
    expect(() => releaseChangelog(null, '1.0.0', '2026-09-16')).toThrow(/缺少 \[Unreleased\] 段/);
  });

  it('历史版本段里残留占位行 → 拒绝发版，且报错点出最可能原因与定位命令（实测踩过）', () => {
    // v0.15.0 那次"占位行被带进版本段"缺陷的残留物：老段里留着一行占位行。
    // 重建 [Unreleased] 后总数变 2 ⇒ 不变量拦下 —— 关键是报错要能直接指路，否则要花十分钟定位。
    const dirty = '# C\n\n## [Unreleased]\n\n' + PLACEHOLDER + '\n\n### 本轮\n\n- a\n\n'
      + '## [v0.15.0] - 2026-09-16\n\n### 老段\n\n- b\n\n' + PLACEHOLDER + '\n';
    let msg = '';
    try { releaseChangelog(dirty, '0.16.0', '2026-09-26'); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/占位行出现 2 次/);
    expect(msg).toMatch(/已发版本段里残留了占位行/);
    expect(msg).toMatch(/changelog --grep/);
  });
});

/* ============================================================
 * 滚动归档 —— 发版时把超出保留窗口的历史版本段移出主文件（docs/changelog/）
 * ------------------------------------------------------------
 * 为什么要有测试：滚动只作用于"已发版本段"，一旦把 [Unreleased] 也滚走，
 * 当前工作区就丢了 —— 这是不可逆的损害，必须用断言钉死。
 * ============================================================ */
describe('changelog 滚动归档', () => {
  /** 造一份含 n 个已发版本段的 CHANGELOG（新→旧） */
  function mkReleased(n) {
    const out = ['# CHANGELOG', '', '## [Unreleased]', '', PLACEHOLDER, '', '### 本轮变更', '', '- 细节', ''];
    for (let i = 0; i < n; i++) {
      out.push('## [v0.' + (15 - i) + '.0] - 2026-09-' + String(16 - i).padStart(2, '0'), '');
      out.push('### v0.' + (15 - i) + ' 的变更', '', '- 第 ' + (i + 1) + ' 版的细节', '');
    }
    return out.join('\n');
  }

  it('保留窗口：主文件留下最新 keep 个版本段，更老的进 archived', () => {
    const { main, archived } = splitChangelog(mkReleased(5), 3);
    expect(archived.map((a) => a.version)).toEqual(['v0.12.0', 'v0.11.0']);
    expect(main).toContain('## [v0.15.0] - 2026-09-16');
    expect(main).toContain('## [v0.13.0] - 2026-09-14');
    expect(main).not.toContain('## [v0.12.0]');
  });

  it('[Unreleased] 永不被归档（主文件必须仍含且仅含一个）', () => {
    const { main, archived } = splitChangelog(mkReleased(6), 0);
    expect(archived).toHaveLength(6);
    expect((main.match(/^## \[Unreleased\]/gm) || []).length).toBe(1);
    expect(main).toContain(PLACEHOLDER);
    expect(archived.some((a) => /Unreleased/.test(a.version))).toBe(false);
  });

  it('keep=0 时主文件只剩 [Unreleased] 段', () => {
    const { main } = splitChangelog(mkReleased(2), 0);
    expect(main).not.toContain('## [v0.15.0]');
    expect(main).toContain('## [Unreleased]');
  });

  it('归档段内容完整、且不含下一段的标题（边界正确）', () => {
    const { archived } = splitChangelog(mkReleased(5), 3);
    expect(archived[0].version).toBe('v0.12.0');
    expect(archived[0].date).toBe('2026-09-13');
    expect(archived[0].body).toContain('### v0.12 的变更');
    expect(archived[0].body).not.toContain('## [v0.11.0]');
  });

  it('低于窗口时不归档，主文件原样返回', () => {
    const src = mkReleased(2);
    const { main, archived } = splitChangelog(src, 3);
    expect(archived).toEqual([]);
    expect(main).toBe(src);
  });

  it('无已发版本段（只有 [Unreleased]）时不归档、不报错', () => {
    const src = '# C\n\n## [Unreleased]\n\n' + PLACEHOLDER + '\n';
    expect(splitChangelog(src, 3).archived).toEqual([]);
  });

  it('renderArchiveFile：标明版本/日期/保留窗口，并指向主文件与检索命令', () => {
    const { archived } = splitChangelog(mkReleased(5), 3);
    const f = renderArchiveFile(archived[0], 3);
    expect(f).toContain('# CHANGELOG 归档 · v0.12.0（2026-09-13）');
    expect(f).toContain('保留窗口 = 主文件留下最近 3 个已发版本段');
    expect(f).toContain('见 `CHANGELOG.md`');
    expect(f).toContain('changelog --grep');
    expect(f).toContain('## [v0.12.0] - 2026-09-13');   // 段标题被保留
  });

  it('发版 → 滚动 的流水线：占位行仍恰好一次，且新旧版本段各就各位', () => {
    const released = releaseChangelog(mkReleased(0), '0.16.0', '2026-09-26');
    const later = released.replace('### 本轮变更', '### v0.16 的变更');
    const { main, archived } = splitChangelog(later + '\n## [v0.0.9] - 2026-09-01\n\n### 远古\n\n- x\n', 1);
    expect(main.split(PLACEHOLDER).length - 1).toBe(1);
    expect(main).toContain('## [v0.16.0] - 2026-09-26');
    expect(archived.map((a) => a.version)).toContain('v0.0.9');
  });
});

/* ============================================================
 * indexChangelog —— `changelog` 命令的纯逻辑（CHANGELOG 窄查询索引）
 * ------------------------------------------------------------
 * 索引的职责是「告诉你东西在哪、有多大」，不是「复述内容」。
 * 这里锁住三件实际会写错的事：
 *   1. **段的尺寸必须含其下全部条目** —— 第一版写成"到下一个边界"，
 *      于是 `[Unreleased]` 只剩下标题行 + 占位行，实测打印 "2 行 / 17 B"；
 *   2. **行号分区必须精确铺满全文**（前言 + 各段 = 总行数），
 *      否则 `--full` 按行号切片会错位、静默给出别的条目的正文；
 *   3. **不拿条目标题里的日期当索引键** —— 真实 CHANGELOG 里 90 条有 22 条格式各异
 *      （`（v0.16.6，2026-09-24）` / `（2026-09-15 晚）` / 完全无日期），靠它必漏。
 * ============================================================ */
describe('indexChangelog', () => {
  it('段的尺寸包含其下全部条目（不是只剩标题行）', () => {
    const idx = indexChangelog(mk());
    const un = idx.sections.find((s) => s.version === 'Unreleased');
    expect(un.entries.length).toBe(1);
    expect(un.lines).toBeGreaterThan(un.entries[0].lines); // 段比它唯一的条目大
  });

  it('行号分区精确铺满全文：前言 + 各段行数 = 总行数', () => {
    const src = mk();
    const idx = indexChangelog(src);
    const sum = idx.preamble.lines + idx.sections.reduce((n, s) => n + s.lines, 0);
    expect(sum).toBe(idx.totalLines);
    // 末尾换行不算一行（否则与编辑器行号、Get-Content .Count 差 1）
    const expected = src.endsWith('\n') ? src.split('\n').length - 1 : src.split('\n').length;
    expect(idx.totalLines).toBe(expected);
  });

  it('每块的 startLine 是 1 起行号，且真的落在该块的标题行上', () => {
    const src = mk();
    const idx = indexChangelog(src);
    const blocks = [];
    for (const s of idx.sections) { blocks.push(s); for (const e of s.entries) blocks.push(e); }
    expect(blocks.length).toBeGreaterThan(2);
    for (const b of blocks) {
      expect(/^(## \[|### )/.test(src.split('\n')[b.startLine - 1])).toBe(true);
    }
  });

  it('段标题：版本段解析出日期，[Unreleased] 的日期为 null', () => {
    const idx = indexChangelog(mk());
    expect(idx.sections.find((s) => s.version === 'Unreleased').date).toBe(null);
    expect(idx.sections.find((s) => s.version === 'v0.14.0').date).toBe('2026-09-15');
  });

  it('条目标题日期格式各异也不影响索引（不拿日期当键）', () => {
    const src = [
      '## [Unreleased]', '',
      '### 甲（v0.16.6，2026-09-24）', '', '- x', '',
      '### 乙（2026-09-15 晚）', '', '- y', '',
      '### 丙（无日期）', '', '- z', ''
    ].join('\n');
    const idx = indexChangelog(src);
    expect(idx.sections[0].entries.map((e) => e.heading))
      .toEqual(['甲（v0.16.6，2026-09-24）', '乙（2026-09-15 晚）', '丙（无日期）']);
    expect(idx.sections[0].entries.map((e) => e.startLine)).toEqual([3, 7, 11]);
  });

  it('字节数是 UTF-8 字节，不是字符数（中文按 3 字节）', () => {
    const src = '## [Unreleased]\n\n### 中文标题\n';
    const idx = indexChangelog(src);
    expect(idx.totalBytes).toBe(Buffer.byteLength(src, 'utf8'));
    expect(idx.totalBytes).toBeGreaterThan(src.length);
  });

  it('空/异常输入不崩，且返回结构完整', () => {
    for (const bad of ['', null, undefined, 'no headings here']) {
      const idx = indexChangelog(bad);
      expect(Array.isArray(idx.sections)).toBe(true);
      expect(typeof idx.totalLines).toBe('number');
      expect(typeof idx.totalBytes).toBe('number');
      expect(idx.preamble.lines).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ============================================================
 * searchArchives —— 归档检索（"查历史"的承诺要真正兑现）
 * ------------------------------------------------------------
 * 真实缺陷：滚动归档后 `changelog --grep` 只搜主文件，归档里的历史查不到 ——
 * 实测关键词「history.js 下沉」只在 docs/changelog/v0.12.0.md 里，命令报 0 命中。
 * ============================================================ */
describe('changelog 归档检索', () => {
  function tmpArchives(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cl-arch-'));
    Object.entries(files).forEach(([name, body]) => fs.writeFileSync(path.join(dir, name), body, 'utf8'));
    return [dir, () => fs.rmSync(dir, { recursive: true, force: true })];
  }

  it('命中归档文件并给出文件/版本/日期/行号/所属条目标题', () => {
    const [dir, clean] = tmpArchives({
      'v0.12.0.md': '# CHANGELOG 归档 · v0.12.0（2026-09-14）\n\n> 说明行\n\n## [v0.12.0] - 2026-09-14\n\n'
        + '### 架构与发版\n\n- **history.js 下沉**：撤销栈移到 src/history.js\n'
    });
    try {
      const r = searchArchives(dir, 'history.js 下沉');
      expect(r.totalHits).toBe(1);
      expect(r.files[0].file).toBe('v0.12.0.md');
      expect(r.files[0].version).toBe('v0.12.0');
      expect(r.files[0].date).toBe('2026-09-14');
      expect(r.files[0].hits[0].line).toBe(9);
      // 行号必须**指回原文那一行**（不是偏移量算错却看着像对）
      const line = fs.readFileSync(path.join(dir, 'v0.12.0.md'), 'utf8').split('\n')[r.files[0].hits[0].line - 1];
      expect(line).toContain('history.js 下沉');
      expect(r.files[0].hits[0].heading).toBe('架构与发版');
    } finally { clean(); }
  });

  it('大小写不敏感；多文件命中各自成组', () => {
    const [dir, clean] = tmpArchives({
      'v0.1.0.md': '## [v0.1.0] - 2026-09-11\n\n### A\n\n- Gate 门禁在空转\n',
      'v0.2.0.md': '## [v0.2.0] - 2026-09-12\n\n### B\n\n- gate 又一次\n'
    });
    try {
      const r = searchArchives(dir, 'GATE');
      expect(r.totalHits).toBe(2);
      expect(r.files.map((f) => f.version)).toEqual(['v0.1.0', 'v0.2.0']);
    } finally { clean(); }
  });

  it('无关键词 / 目录不存在 / 无命中：都返回空结构且不抛错', () => {
    const [dir, clean] = tmpArchives({ 'v0.1.0.md': '## [v0.1.0] - 2026-09-11\n\n- x\n' });
    try {
      expect(searchArchives(dir, '').totalHits).toBe(0);
      expect(searchArchives(dir, null).totalHits).toBe(0);
      expect(searchArchives(path.join(dir, '不存在'), 'x').totalHits).toBe(0);
      expect(searchArchives(dir, 'zzz').files).toEqual([]);
    } finally { clean(); }
  });

  it('perFile 上限生效（防输出爆炸）', () => {
    const many = Array.from({ length: 30 }, (_, i) => '- 命中关键词 第' + i + '行').join('\n');
    const [dir, clean] = tmpArchives({ 'v0.1.0.md': '## [v0.1.0] - 2026-09-11\n\n### 多\n\n' + many + '\n' });
    try {
      expect(searchArchives(dir, '命中关键词', 5).files[0].hits.length).toBe(5);
      expect(searchArchives(dir, '命中关键词').files[0].hits.length).toBe(20);
    } finally { clean(); }
  });

  it('对真实工程的归档目录：搜「history.js 下沉」必须命中（回归本缺陷）', () => {
    const dir = path.join(ROOT, 'docs', 'changelog');
    if (!fs.existsSync(dir)) return;                       // 尚无归档则不判
    const r = searchArchives(dir, 'history.js 下沉');
    expect(r.totalHits).toBeGreaterThan(0);
  });
});

/* ============================================================
 * checkChangelogStructure —— CHANGELOG.md 的「文件自身结构完整性」门禁
 * ------------------------------------------------------------
 * 为什么这组必须存在（不是"顺手多写几条"）：
 * 2026-10-19 **一天之内** CHANGELOG.md 被工程外的一次性脚本弄坏三次，**没有一道判据拦住**：
 *   事故 1/2（批 `94fcd4d1`）：裸 `fs.writeFileSync` 整份覆写撞并发会话 ⇒ **两个 `# CHANGELOG` 头**（938,727 B）；
 *   事故 3（批 `f8fd853e`）：`before.slice(0, cut)` 拼接点少加了两个字符 ⇒ **文件头
 *                 （registry 块 + `## [Unreleased]` 行）被整段截掉**。
 * 本文件上半部分那些用例为什么放过它们（父代理已查证）—— 刻意不写条数，那类数字每次补测都在变：
 *   · 它们测的是 `src/changelog.js` 的**变换逻辑**（"把 [Unreleased] 变成版本段"等），
 *     喂的是**合成输入** ⇒ **从不检查磁盘上那一份文件的结构**；
 *   · 写盘出口判据扫的是**仓库源码**里的 `fs.writeFileSync` 调用点 ⇒ 三次都来自**工程外**脚本，扫描面覆盖不到。
 * ⇒ 没有任何判据在问"这个文件现在还好吗"。下面这组就是那个问题。
 *
 * **判别力怎么证的**：把磁盘上那份真实文本读进内存，在**字符串上**注入破坏，再喂给纯函数
 * ⇒ **真仓 `CHANGELOG.md` 一个字节都不写**（本组除了"读一次原文"，没有任何 fs 写调用）。
 * 五个注入各必红并**点名是哪一条判据**，外加一条"原样 ⇒ 必须绿"的反证（防判据乱红）。
 * 最后一条**如实钉住能力边界**：内容被悄悄改掉时它仍然绿 —— 它只验结构。
 * ============================================================ */
describe('checkChangelogStructure（CHANGELOG.md 文件自身结构完整性）', () => {
  const CL = path.join(ROOT, 'CHANGELOG.md');
  /** 磁盘上那份真实文本（**只读**；所有注入都发生在返回的字符串上，不落盘） */
  const real = () => fs.readFileSync(CL, 'utf8');
  const codes = (r) => r.problems.map((p) => p.code);

  it('采得到真值：磁盘上的 CHANGELOG.md 必须存在且不是空壳（取不到就是红，不是跳过）', () => {
    expect(fs.existsSync(CL)).toBe(true);
    expect(real().length).toBeGreaterThan(1000);
  });

  it('反证：原样文本 ⇒ 必须绿（判据不许乱红）', () => {
    const r = checkChangelogStructure(real());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('注入①：把整份文件拼两遍（两个 `# CHANGELOG` 头）⇒ 必红，点名 H1_COUNT', () => {
    // 事故 1/2 的形状：并发会话各自覆写 ⇒ 后落盘的那份没带上对方，两份被拼在一起
    const src = real();
    const doubled = src + '\n' + src;
    const r = checkChangelogStructure(doubled);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('H1_COUNT');
    const p = r.problems.find((x) => x.code === 'H1_COUNT');
    expect(p.message).toMatch(/出现 2 次/);
    expect(p.message).toMatch(/拼接/);
    // 只认"行首"而不认子串的证据：这份被拼坏的文件里子串出现 12 次，判据报的是 2 次
    // （真文件里子串就有 6 次，5 次在别批的散文里讲这个指标 ⇒ `includes` 写法对原样文件也会红）
    expect(doubled.split('# CHANGELOG').length - 1).toBeGreaterThan(2);
  });

  it('注入②：删掉 `## [Unreleased]` 那一行 ⇒ 必红，点名 UNRELEASED_COUNT', () => {
    const src = real();
    const broken = src.replace(/^## \[Unreleased\][^\n]*\n/m, '');
    expect(broken).not.toBe(src);                        // 注入真的生效（防"没改就判红"的假证明）
    const r = checkChangelogStructure(broken);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['UNRELEASED_COUNT']);       // 只这一条：不许连坐其余判据
    expect(r.problems[0].message).toMatch(/出现 0 次/);
  });

  it('注入③：截掉头部前言（registry 块 + 约定块）⇒ 必红，点名 PREAMBLE_NO_REGISTRY', () => {
    // 事故 3 的形状（文件头被整段截掉）。这里**保留**标题与 `## [Unreleased]` 行，
    // 好让这条注入单独考验"前言区"这一条判据 —— 连标题一起截掉的真实形状另有一条（③b）。
    const src = real();
    const at = src.search(/^## \[Unreleased\]/m);
    expect(at).toBeGreaterThan(0);
    const broken = src.slice(0, src.indexOf('\n') + 1) + '\n' + src.slice(at);
    expect(broken.length).toBeLessThan(src.length);       // 前言真的被截掉了
    const r = checkChangelogStructure(broken);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['PREAMBLE_NO_REGISTRY']);
    expect(r.problems[0].message).toMatch(/registry 元信息块/);
    expect(r.problems[0].message).toMatch(/头部被整段截掉/);
  });

  it('注入③b：连 `# CHANGELOG` 标题一起整段截掉（事故 3 的真实形状）⇒ 必红，H1_COUNT=0 且前言为空', () => {
    const src = real();
    const at = src.search(/^## \[Unreleased\]/m);
    const r = checkChangelogStructure(src.slice(at));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('H1_COUNT');               // 0 次 = 标题没了
    expect(r.problems.find((x) => x.code === 'H1_COUNT').message).toMatch(/出现 0 次/);
    expect(codes(r)).toContain('PREAMBLE_EMPTY');
  });

  it('注入④：复制一个同名 `###` 段 ⇒ 必红，点名 DUP_ENTRY_NAME', () => {
    const src = real();
    const m = /^### (.+?)\s*$/m.exec(src);
    expect(m).toBeTruthy();
    const broken = src + '\n' + m[0] + '\n\n- 注入的重复段正文\n';
    const r = checkChangelogStructure(broken);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['DUP_ENTRY_NAME']);
    expect(r.problems[0].message).toMatch(/× 2/);         // 真的数出"出现了两次"，不是"好像重复"
  });

  it('注入⑤：复制一个同名 `## [` 段 ⇒ 必红，点名 DUP_SECTION_NAME', () => {
    const src = real();
    const m = /^## \[(v[^\]]+)\][^\n]*$/m.exec(src);
    expect(m).toBeTruthy();
    // 只复制**段标题**（正文换成别的）⇒ 单独考验"段名不许重复"这一条，不被 ④ 的 `###` 重名连坐。
    // 整段连正文一起复制的真实情形会同时踩 ④ 与 ⑤ —— 两条都红正是想要的。
    const broken = src + '\n' + m[0] + '\n\n### 注入的重复段正文\n\n- 无\n';
    const r = checkChangelogStructure(broken);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['DUP_SECTION_NAME']);
    expect(r.problems[0].message).toMatch(/段名不许重复/);
  });

  it('能力边界（如实钉住）：内容被悄悄改掉 ⇒ **仍然绿** —— 本判据只验结构，不验内容', () => {
    // 这条守的**不是一个功能，而是一条边界**（`testing-for-ai` B8：已知边界要写进文档）。
    // 为什么必须钉住：不钉住的话，下一个人会以为"有这道门禁 ⇒ CHANGELOG 不会被改坏了"，
    // 而反例就摆在这里 —— 把 `[Unreleased]` 里第一条 `- ` 的正文整行换掉，结构仍然完整，判据仍然绿。
    // 抓内容级损坏需要"内容基线"（某个哈希/计数），本工程没有这份基线；
    // 要做就得先决定基线怎么维护（每次合法改动都要重算一次），那是另一件事。
    const src = real();
    const broken = src.replace(/^- .*$/m, '- 这一行的内容被悄悄改掉了（结构完全不变）');
    expect(broken).not.toBe(src);
    const r = checkChangelogStructure(broken);
    expect(r.ok).toBe(true);                              // ← 边界：判据看不见内容变化
    expect(r.problems).toEqual([]);
  });
});

/* ============================================================
 * G-15 下沉（2026-10-22）：归档检索的**纯核心** `searchArchiveTexts`
 * ------------------------------------------------------------
 * 为什么加这一组：上面「changelog 归档检索」那组测的是**同一个命中判据**，但它的入口是
 * `searchArchives(dir, …)` ⇒ 每条用例都得先 `mkdtemp` + 写 `.md` 文件（`tmpArchives()`）。
 * 判据（行号 / 所属 `###` 标题 / 每文件上限 / 版本与日期）本身与盘无关 —— 下沉后喂数组即可。
 * 本组 4 条里 **3 条零 `mkdtemp`**；第 2 条故意用一次盘，为的是证明"薄壳与纯核心是**同一份判据**"
 * （那一半本来就是盘，绕开它就是自欺）—— 条数可现场核。
 *
 * ⚠️ 上面那组**一条断言都没改**：它是端到端真值（含"行号指回原文那一行"那条），
 * 本组只补"薄壳与纯核心是同一份判据"以及纯核心自己的边界 —— 不是替代，也不重复判。
 * ============================================================ */
describe('G-15 下沉：`searchArchiveTexts`（喂文本就够，不必先造文件系统）', () => {
  const V012 = 'v0.12.0.md';
  const BODY = '# CHANGELOG 归档 · v0.12.0（2026-09-14）\n\n> 说明行\n\n## [v0.12.0] - 2026-09-14\n\n'
    + '### 架构与发版\n\n- **history.js 下沉**：撤销栈移到 src/history.js\n';

  it('★ 命中行号 / 所属条目标题 / 版本 / 日期：**喂一段文本**就给全（修前要先造目录再读回来）', () => {
    const r = searchArchiveTexts([{ file: V012, text: BODY, path: 'D:/docs/changelog/v0.12.0.md' }],
      'history.js 下沉');
    expect(r.totalHits).toBe(1);
    expect(r.files[0].file).toBe(V012);
    expect(r.files[0].version).toBe('v0.12.0');
    expect(r.files[0].date).toBe('2026-09-14');
    expect(r.files[0].hits[0].line).toBe(9);
    expect(r.files[0].hits[0].heading).toBe('架构与发版');
    // 行号**指回喂进来的那段文本**那一行（不是偏移量算错却看着像对）
    expect(BODY.split('\n')[r.files[0].hits[0].line - 1]).toContain('history.js 下沉');
    expect(r.files[0].path, '薄壳给的绝对路径原样带出（纯核心不自己拼路径）')
      .toBe('D:/docs/changelog/v0.12.0.md');
  });

  it('★ 与薄壳**同一份判据**：同一份内容，`searchArchives`（读盘）与纯核心的结果逐字段相同', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-g15-cl-'));
    try {
      fs.writeFileSync(path.join(dir, V012), BODY, 'utf8');
      const viaDisk = searchArchives(dir, 'history.js 下沉');
      const viaText = searchArchiveTexts([{ file: V012, text: BODY }], 'history.js 下沉');
      // path 一项只有薄壳能给出（它知道目录）；其余字段必须逐字段相同
      expect(JSON.stringify(viaText.files.map((f) => ({ ...f, path: null }))))
        .toBe(JSON.stringify(viaDisk.files.map((f) => ({ ...f, path: null }))));
      expect(viaText.totalHits).toBe(viaDisk.totalHits);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('大小写不敏感；每文件上限生效（防输出爆炸）；无命中不留半条结果', () => {
    const many = Array.from({ length: 30 }, (_, i) => '- 命中关键词 第' + i + '行').join('\n');
    const body = '## [v0.1.0] - 2026-09-11\n\n### 多\n\n' + many + '\n';
    expect(searchArchiveTexts([{ file: 'v0.1.0.md', text: '## [v0.1.0]\n\n- 门禁 Gate\n' }], 'GATE')
      .totalHits).toBe(1);
    expect(searchArchiveTexts([{ file: 'v0.1.0.md', text: body }], '命中关键词', 5).files[0].hits.length)
      .toBe(5);
    expect(searchArchiveTexts([{ file: 'v0.1.0.md', text: body }], '命中关键词').files[0].hits.length)
      .toBe(20);
    expect(searchArchiveTexts([{ file: 'v0.1.0.md', text: body }], 'zzz-没有这个').files).toEqual([]);
  });

  it('空关键词 / 非 `.md` / 坏条目 ⇒ 都返回空结构且不抛（边界不许静默造出假命中）', () => {
    const one = [{ file: 'v0.1.0.md', text: '## [v0.1.0]\n\n- x\n' }];
    expect(searchArchiveTexts(one, '').totalHits).toBe(0);
    expect(searchArchiveTexts(one, null).totalHits).toBe(0);
    expect(searchArchiveTexts(one, '   ').totalHits).toBe(0);
    expect(searchArchiveTexts([], 'x').totalHits).toBe(0);
    expect(searchArchiveTexts(null, 'x').totalHits).toBe(0);
    expect(searchArchiveTexts([{ file: 'notes.txt', text: '- x\n' }], 'x').totalHits).toBe(0);
    expect(searchArchiveTexts([null, { text: '- x\n' }], 'x').totalHits).toBe(0);
    // 正文缺失按空串处理（不抛、也不当成命中）
    expect(searchArchiveTexts([{ file: 'v0.1.0.md' }], 'x').totalHits).toBe(0);
  });
});
