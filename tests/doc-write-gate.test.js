/* ============================================================
 * tests/doc-write-gate.test.js — 文档登记面两条整文件写路径的版本闸门（T2）
 * ------------------------------------------------------------
 * 为什么有这个文件：
 *   T3（`a65352c`）把"读全文 → 改 → 写全文"的闸门做成了 `src/data-store.js` 里**唯一**的一处
 *   （`versionGate` + `readManagedText` / `writeManagedText`），但**两条最主要的整文件重写路径**
 *   当时仍在裸写、中间没有指纹比对：
 *     · `scripts/doc-facts.js` 的 `--write` → 整份重写 `docs/VERIFY.md`；
 *     · `scripts/docs-registry-check.js` 的 `--write` → 读全文后换掉 §5 那张表再写全文。
 *   ⇒ 并发时后写者整份覆盖先写者，**没有任何东西能检出**（2026-10 那次 `docs/ARCHITECTURE.md`
 *     三行被两批各改一次冲掉，机器侧根因就是这个）。
 *
 * 本文件锁七件事（每条都能被打红，见 `.review/20261016-T2-登记面写闸门/README.md` §三）：
 *   ① 落点①：读后 / 写前盘上被改 ⇒ 拒写 + **报出两侧完整指纹** + 磁盘一字不动 + 不留 .tmp；
 *   ② 落点①：读后文件被删也算冲突（不许"当新建文件"静默放行）；
 *   ③ 落点②：同上（`writeRegistryTable` 必须真的过闸门，而不是"生成逻辑正确"而已）；
 *   ④ 落点②：**§5 之外**（§1–§4）的并发改动也会被检出 —— 这正是"整文件指纹"这个口径的判别力证明：
 *      只比 §5 会漏掉"§1–§4 被整份回退"这一整类丢失；
 *   ⑤ 单写者路径**逐字节不变**：两个落点写出的字节与**旧实现**的参照产物三记全等（H3）；
 *   ⑥ 闸门**不能被静默绕过**：`writeVerifyDoc` 不传句柄 ⇒ 抛（不是悄悄退回裸写）；
 *   ⑦ 结构断言：两个脚本剥注释后**一处裸写都没有**，且**没有第二份冲突比较**（A1：比较只有一处）。
 *
 * 判定档（照 testing-for-ai B4c）：`{ 通过, 真缺陷 }` —— 本文件不设"跳过"档。
 * 注入方式说明（④ 用的 `fs.readFileSync` 一次性桩）：它只做一件事 ——
 *   **在"本函数自己那次读"返回之后、任何人再读之前，把文件改成别人的版本**，
 *   即判据原文"读后、写前盘上被改"。没有这个缝，"并发"在单测里无法确定性复现。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const df = require('../scripts/doc-facts.js');
const rc = require('../scripts/docs-registry-check.js');
const { versionOfText } = require('../src/data-store.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 三记（sha256 / 字节数 / CR 数）—— 与 `.review/20261016-T2-登记面写闸门/tools/fingerprint.js` 同一把尺子 */
const fpOf = (p) => {
  const buf = fs.readFileSync(p);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    cr: (buf.toString('latin1').match(/\r/g) || []).length
  };
};

/** 剥注释（结构断言的输入必须是去注释后的代码 —— 注释里的示例写法不是实现） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `renderVerifyDoc` 需要的最小 facts（只影响渲染，不参与真值校验） */
const FACTS = {
  commands: 69, mcpTools: 51, unitTests: 2074, unitFiles: 98,
  cliAssertions: 535, smokeAssertions: 321, visionAssertions: 2, version: '0.18.0'
};

/** 头部元信息块（四行齐备 ⇒ `state = 'ok'`） */
const hdr = (layer, purpose, notWrite, update) => [
  '<!-- registry（数据源）', '层: ' + layer, '作用: ' + purpose,
  '不该写: ' + notWrite, '更新方式: ' + update, '-->', ''
].join('\n');

/**
 * 造一个**只为 `writeRegistryTable` 服务**的最小假工程：
 * 四份受管文档（三份根文档 + ARCHITECTURE.md 自己）都带齐元信息 ⇒ `collectDocHeaders()` 全 `ok`，
 * 于是生成模式不会在"头部不合格"那道闸门就返回 false（那样本文件就测不到写闸门了）。
 * ARCHITECTURE.md 里 §5 之外刻意留了一段可辨认的正文（`§3 正文`），用来证明拼接不会动它。
 */
function fakeRoot(archBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-t2-gate-'));
  const files = {
    'SKILL.md': '# s\n\n' + hdr('入口', '触发与导航', '规则全表', '手写'),
    'README.md': '# r\n\n' + hdr('入口', '产品门面', '模块表', '手写'),
    'CHANGELOG.md': '# c\n\n' + hdr('记录', '变更轨迹', '—', '每次变更必写'),
    'docs/ARCHITECTURE.md': archBody
  };
  Object.entries(files).forEach(([rel, body]) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  });
  return [root, () => fs.rmSync(root, { recursive: true, force: true })];
}

/** 假工程里 ARCHITECTURE.md 的全文：§5 之外有一段普通正文，§5 里是**过期**的表（等生成器换掉） */
function archDoc(outsideLine) {
  return [
    '# 架构设计（ARCHITECTURE）',
    '',
    hdr('设计', '分层决策', '具体数字', '手写').replace(/\n+$/, ''),
    '',
    '## 3. 分层',
    '',
    outsideLine || '§3 正文：这条不在 §5 里。',
    '',
    '## 5. 文档架构',
    '',
    rc.REG_BEGIN + '（勿手改）-->',
    '',
    '| 层 | 文档 | 作用（旧表，等着被重生成） |',
    '|----|------|------------------|',
    '',
    rc.REG_END,
    '',
    '## 6. 演进指引',
    '',
    '这条也在 §5 之外。',
    ''
  ].join('\n');
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-t2-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

/** 收集一次调用的 console.error 文本（"不许静默"本身也要被断言，而不是靠肉眼看日志） */
function captureErr(fn) {
  const lines = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((m) => lines.push(String(m)));
  try { return { out: fn(), text: lines.join('\n') }; }
  finally { spy.mockRestore(); }
}

/* ============================================================
 * 落点 ①：scripts/doc-facts.js --write → docs/VERIFY.md
 * ============================================================ */
describe('落点① `doc-facts --write`（整份重写 docs/VERIFY.md）', () => {
  it('① 读后 / 写前盘上被改 ⇒ 拒写 + 报出两侧完整指纹 + 磁盘一字不动', () => {
    const file = path.join(dir, 'VERIFY.md');
    fs.writeFileSync(file, '# 我读到的那一版\n', 'utf8');
    const handle = df.readVerifyDocHandle(file);            // 「我读到的是这一版」
    expect(handle.text).toBe('# 我读到的那一版\n');
    expect(handle.version).toMatch(/^[0-9a-f]{16}$/);

    // ---- 别人在"读后、写前"改了盘上（本工程常态：另一个会话也在跑生成器）----
    const theirs = '# 别的会话刚生成的一版\n';
    fs.writeFileSync(file, theirs, 'utf8');
    const before = fpOf(file);

    const r = captureErr(() => df.writeVerifyDoc(FACTS, handle));

    expect(r.out, '读后盘上被改却照样写 ⇒ 那次改动会被静默抹掉').toBe(false);
    // 报文里**报出两侧完整指纹**（不静默、不只说"有冲突"）
    expect(r.text).toContain('并发写入冲突');
    expect(r.text).toContain('读到的版本');
    expect(r.text).toContain(handle.version);                       // 我读到的（完整 16 位）
    expect(r.text).toContain(versionOfText(theirs));                // 盘上现在的（完整 16 位）
    expect(r.text).toContain('npm run facts:write');                // 出路（F1：不是死指针）
    // 磁盘一字不动（三记），也不留 .tmp 残留
    expect(fpOf(file)).toEqual(before);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('② 读后文件被删也拒写（不许"当新建文件"静默放行）', () => {
    const file = path.join(dir, 'VERIFY.md');
    fs.writeFileSync(file, '# 原来有一份\n', 'utf8');
    const handle = df.readVerifyDocHandle(file);
    fs.unlinkSync(file);
    const r = captureErr(() => df.writeVerifyDoc(FACTS, handle));
    expect(r.out).toBe(false);
    expect(r.text).toContain('并发写入冲突');
    expect(r.text).toContain('已不存在');
    expect(r.text).toContain(String(handle.version));
    expect(fs.existsSync(file), '拒写 ⇒ 一个字节都不该被创建').toBe(false);
  });

  it('③ 首次生成（文件还不存在）放行 —— optional 读 ⇒ version=null ⇒ 闸门不设卡', () => {
    const file = path.join(dir, 'docs', 'VERIFY.md');
    const handle = df.readVerifyDocHandle(file);
    expect(handle.version).toBe(null);
    expect(handle.text).toBe(null);
    const log = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => log.push(String(m)));
    try { expect(df.writeVerifyDoc(FACTS, handle)).toBe(true); } finally { spy.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).toBe(df.renderVerifyDoc(FACTS));
    expect(log.join('\n')).toContain('已生成 docs/VERIFY.md');
  });

  it('④ 单写者路径**逐字节不变**：写出的字节 ≡ 旧实现 `fs.writeFileSync(p, s, "utf8")` 的参照产物', () => {
    const file = path.join(dir, 'VERIFY.md');
    fs.writeFileSync(file, '# 上一版\n', 'utf8');
    const handle = df.readVerifyDocHandle(file);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(df.writeVerifyDoc(FACTS, handle)).toBe(true); } finally { spy.mockRestore(); }

    // 旧实现的**参照产物**（同一个渲染函数 + 同一个编码写下去）
    const ref = path.join(dir, 'ref.txt');
    fs.writeFileSync(ref, df.renderVerifyDoc(FACTS), 'utf8');
    expect(fpOf(file), '闸门改动了写出的字节 ⇒ 违反 H3').toEqual(fpOf(ref));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('⑤ 闸门不许被静默绕过：不传句柄 ⇒ 抛（不是悄悄退回裸写）', () => {
    expect(() => df.writeVerifyDoc(FACTS)).toThrow(/句柄/);
    expect(() => df.writeVerifyDoc(FACTS, { file: path.join(dir, 'x.md') })).toThrow(/句柄/);
    expect(() => df.writeVerifyDoc(FACTS, null)).toThrow(/句柄/);
  });
});

/* ============================================================
 * 落点 ②：scripts/docs-registry-check.js --write → docs/ARCHITECTURE.md 的 §5
 * ============================================================ */
describe('落点② `docs:registry --write`（重写 §5 登记表，拼回整份文件）', () => {
  it('⑥ 读后 / 写前盘上被改 ⇒ 拒写 + 报出两侧完整指纹 + 磁盘一字不动', () => {
    const [root, clean] = fakeRoot(archDoc());
    try {
      const archPath = path.join(root, 'docs', 'ARCHITECTURE.md');
      const original = fs.readFileSync(archPath, 'utf8');
      const theirs = original.replace('这条也在 §5 之外。', '别的会话在表之外加的改动。');
      expect(theirs).not.toBe(original);

      // ---- 缝：`writeRegistryTable` 自己那次读返回**快照**，随后盘上立刻变成别人的版本 ----
      const real = fs.readFileSync;
      let first = true;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (first && String(p) === archPath) {
          first = false;
          fs.writeFileSync(archPath, theirs, 'utf8');       // "读后、写前盘上被改"
          return original;
        }
        return real.apply(fs, [p, ...rest]);
      });
      let r;
      try { r = captureErr(() => rc.writeRegistryTable(root)); }
      finally { spy.mockRestore(); }

      expect(r.out, '读后盘上被改却照样写 ⇒ §5 之外的改动会被整份回退').toBe(false);
      expect(r.text).toContain('并发写入冲突');
      expect(r.text).toContain('读到的版本');
      expect(r.text).toContain(versionOfText(original));
      expect(r.text).toContain(versionOfText(theirs));
      expect(r.text).toContain('npm run docs:registry');
      // 磁盘一字不动：别人的版本**还在**（没被我的快照回退）
      expect(fs.readFileSync(archPath, 'utf8')).toBe(theirs);
      expect(fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally { clean(); }
  });

  it('⑦ §5 **之外**（§3）的并发改动也会被检出 —— 整文件指纹的判别力（只比 §5 会漏）', () => {
    const [root, clean] = fakeRoot(archDoc('§3 正文：这条不在 §5 里。'));
    try {
      const archPath = path.join(root, 'docs', 'ARCHITECTURE.md');
      const original = fs.readFileSync(archPath, 'utf8');
      // 只改 §5 **之外**一行（§5 表格区域一个字节都没动）
      const theirs = original.replace('§3 正文：这条不在 §5 里。', '§3 正文：别的会话改的这一行。');
      expect(theirs).not.toBe(original);
      // §5 区间（BEGIN … END）在别人的版本里逐字节相同 ⇒ "只比 §5"的闸门在这里会**放行**
      const s = theirs.indexOf(rc.REG_BEGIN);
      const e = theirs.indexOf(rc.REG_END);
      expect(original.slice(0, s)).not.toBe(theirs.slice(0, s));   // §5 之前不同
      expect(original.slice(e)).toBe(theirs.slice(e));             // §5 之后相同

      const real = fs.readFileSync;
      let first = true;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (first && String(p) === archPath) {
          first = false;
          fs.writeFileSync(archPath, theirs, 'utf8');
          return original;
        }
        return real.apply(fs, [p, ...rest]);
      });
      let r;
      try { r = captureErr(() => rc.writeRegistryTable(root)); }
      finally { spy.mockRestore(); }

      expect(r.out, '§5 之外的改动被静默回退 ⇒ 这就是 2026-10 那次"三行被冲掉"的同一形态').toBe(false);
      expect(r.text).toContain('并发写入冲突');
      // 别人的那一行**还在**（没有被我的快照回退）
      expect(fs.readFileSync(archPath, 'utf8')).toContain('§3 正文：别的会话改的这一行。');
    } finally { clean(); }
  });

  it('⑧ 单写者路径**逐字节不变**：写出的字节 ≡ 旧实现的拼接表达式（§5 之外逐字节不动）', () => {
    const [root, clean] = fakeRoot(archDoc());
    try {
      const archPath = path.join(root, 'docs', 'ARCHITECTURE.md');
      const mdOld = fs.readFileSync(archPath, 'utf8');

      // ---- 旧实现的参照：同一份快照 + 同一个渲染函数 + 同一个拼接表达式 ----
      const entries = rc.collectDocHeaders(root);
      const table = rc.renderRegistryTable(entries);
      const s = mdOld.indexOf(rc.REG_BEGIN);
      const e = mdOld.indexOf(rc.REG_END);
      const head = mdOld.slice(0, mdOld.indexOf('\n', s) + 1);
      const want = mdOld.slice(0, s) + head.slice(head.indexOf(rc.REG_BEGIN)) + '\n' + table + '\n' + mdOld.slice(e);

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try { expect(rc.writeRegistryTable(root)).toBe(true); } finally { spy.mockRestore(); }

      expect(fs.readFileSync(archPath, 'utf8'), '闸门改动了写出的字节 ⇒ 违反 H3').toBe(want);
      // §5 之外的正文逐字保留（不是"差不多"）
      expect(fs.readFileSync(archPath, 'utf8')).toContain('§3 正文：这条不在 §5 里。');
      expect(fs.readFileSync(archPath, 'utf8')).toContain('这条也在 §5 之外。');
      // 第二遍是固定点（生成器幂等 —— 否则 --check 的逐字比对永远红）
      const once = fs.readFileSync(archPath, 'utf8');
      const spy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
      try { expect(rc.writeRegistryTable(root)).toBe(true); } finally { spy2.mockRestore(); }
      expect(fs.readFileSync(archPath, 'utf8')).toBe(once);
    } finally { clean(); }
  });
});

/* ============================================================
 * 结构断言：两条写路径走的是**同一个闸门**（A1 / D1 / D2）
 * ============================================================ */
describe('结构断言：scripts/ 里没有第二份裸写、也没有第二份冲突比较', () => {
  const T2_FILES = ['scripts/doc-facts.js', 'scripts/docs-registry-check.js'];

  it('⑨ 两个落点剥注释后**一处裸写都没有**，且写回只经 `writeManagedText`', () => {
    T2_FILES.forEach((rel) => {
      const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const bare = [...src.matchAll(/fs\.(writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(/g)];
      expect(bare.map((m) => m[0]), rel + ' 里还有裸写 ⇒ 违反 docs/INCIDENTS.md 派生禁令第 5 条').toEqual([]);
      expect(src, rel + ' 的写回没有走统一闸门').toContain('writeManagedText(');
      // 读也必须带回版本（否则 writeManagedText 拿到的是一个假句柄）
      expect(src, rel + ' 没有把读到的版本带到写的那一刻').toMatch(/readManagedText\(|readVerifyDocHandle\(/);
    });
  });

  it('⑩ 冲突的**比较与报错**仍然只在 `src/data-store.js` 一处（scripts/ 不许各写一份）', () => {
    const cmpRe = /actualVersion\s*[!=]==?\s*[\w.]*expectVersion|expectVersion\s*[!=]==?\s*[\w.]*actualVersion/;
    const constructRe = /\bcode\s*=\s*VERSION_CONFLICT/;
    const hits = T2_FILES.filter((rel) => {
      const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      return cmpRe.test(src) || constructRe.test(src);
    });
    expect(hits, '同一件"盘上还是不是我读到的那一版"被第二处比较 ⇒ A1：只共用原语不算共用').toEqual([]);
    // 落点只**读**错误码（调用方只认码，不认文案 —— 与 src/concurrency.js 的自动重放同一约定）
    const dfSrc = stripComments(fs.readFileSync(path.join(ROOT, 'scripts', 'doc-facts.js'), 'utf8'));
    expect(dfSrc).toContain("err.code === 'VERSION_CONFLICT'");
  });

  it('⑪ `--write` 的**先读**在 `facts()` 之前（否则就是恒等放行的假闸门）', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'scripts', 'doc-facts.js'), 'utf8'));
    const at = src.indexOf('function main()');
    expect(at).toBeGreaterThan(-1);
    const mainBody = src.slice(at, src.indexOf('\nfunction ', at + 10));
    const readAt = mainBody.indexOf('readVerifyDocHandle()');
    const factsAt = mainBody.indexOf('facts()');
    expect(readAt, 'main() 里找不到先读').toBeGreaterThan(-1);
    expect(factsAt).toBeGreaterThan(-1);
    expect(readAt, '句柄在 facts() **之后**才读 ⇒ 读与写之间几乎没有间隔 ⇒ 假闸门').toBeLessThan(factsAt);
    // 拒绝必须变成**非 0 退出码**（"报出来了但照样绿"等于没报）—— 两个落点的 `--write` 入口都要这一条
    expect(mainBody, 'main() 没有把写档的拒绝翻成非 0 退出码')
      .toMatch(/if \(!writeVerifyDoc\(v, writeHandle\)\)\s*process\.exitCode\s*=\s*1/);
    const rcSrc = stripComments(fs.readFileSync(path.join(ROOT, 'scripts', 'docs-registry-check.js'), 'utf8'));
    const rcAt = rcSrc.indexOf('function main()');
    expect(rcAt).toBeGreaterThan(-1);
    const rcBody = rcSrc.slice(rcAt, rcSrc.indexOf('\nfunction ', rcAt + 10));
    expect(rcBody, '落点② 的 main() 没有把写档的拒绝翻成非 0 退出码')
      .toMatch(/if \(!writeRegistryTable\(ROOT\)\)\s*process\.exitCode\s*=\s*1/);
  });
});
