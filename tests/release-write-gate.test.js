/* ============================================================
 * tests/release-write-gate.test.js — 整文件受管文档的写闸门（T3）
 * ------------------------------------------------------------
 * 为什么有这个文件：
 *   `cli/commands/release.js` 原先对 `CHANGELOG.md` 是**裸写**（一个纯 `fs.writeFileSync`，
 *   既没有原子写、也没有版本检查），而 `docs/INCIDENTS.md` 的派生禁令第 5 条**明文禁止裸写**
 *   ⇒ 实现违反了工程的自家规则。`CHANGELOG.md` 还是"触碰频次第 2 高"的共享资产、且**只增**：
 *   整份覆写丢掉的是历史。
 *
 * 本文件锁四件事（每件都能被打红，见 .review/20261016-T3-CHANGELOG写闸门/README.md 的判别力证明）：
 *   ① **并发可检出**：读后 / 写前盘上被别人改过 ⇒ 拒写，并**报出两侧指纹**，且磁盘一字不动；
 *   ② **文件被删**也算冲突（不是"当新建文件放行"）；
 *   ③ **单写者路径逐字节不变**：写出的字节与旧实现 `fs.writeFileSync(p, s, 'utf8')` 完全相同；
 *   ④ **唯一比较实现**：`versionGate` 是全仓唯一的冲突比较/报错处，`store.write` 与
 *      `writeManagedText` 都调它；`release.js` 剥注释后**一处裸写都没有**。
 *
 * 判定档（照 testing-for-ai B4c 先写清"能判几种"）：`{ 通过, 真缺陷 }`
 *   —— 本文件不设"跳过"档：闸门行为是确定性的，采不到就是红。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readManagedText, writeManagedText, versionGate, versionOfText, writeFileAtomic
} from '../src/data-store.js';

const ROOT = path.resolve(__dirname, '..');

let dir;
let file;

/** 取原始 Buffer 的三记读数（sha256 / 字节数 / CR 数）—— 回滚与"逐字节不变"共用同一把尺子 */
const fingerprintOf = (buf) => ({
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  bytes: buf.length,
  cr: (buf.toString('latin1').match(/\r/g) || []).length
});

/** 剥掉注释（**结构断言的输入必须是去注释后的代码** —— testing-for-ai B4b：
 *  注释里的示例写法不是实现，把注释算进扫描会让判据判出假红） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wgate-'));
  file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, '# CHANGELOG\n\n## [Unreleased]\n- 原有的一行\n', 'utf8');
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('整文件受管文档写闸门（store.readManagedText / writeManagedText）', () => {
  it('① 读后 / 写前盘上被改 ⇒ 拒写 + 报出两侧指纹 + 磁盘一字不动', () => {
    const handle = readManagedText(file);                 // 「我读到的是这一版」
    const mine = handle.version;
    expect(mine).toMatch(/^[0-9a-f]{16}$/);

    // ---- 别人在"读后、写前"改了盘上（本工程常态：CHANGELOG 常驻半暂存状态）----
    const theirsText = '# CHANGELOG\n\n## [Unreleased]\n- 别的会话刚加的一行\n';
    fs.writeFileSync(file, theirsText, 'utf8');
    const before = fingerprintOf(fs.readFileSync(file));

    // ---- 我的整份覆写必须被拒 ----
    let err = null;
    try {
      writeManagedText(handle, '# CHANGELOG\n\n## [Unreleased]\n- 我的一行\n');
    } catch (e) { err = e; }
    expect(err, '读后盘上被改却不拒写 ⇒ 那次改动会被静默抹掉').not.toBeNull();

    // 错误码是判据（文案会漂；调用方只认码 —— 与 src/concurrency.js 的自动重放同一约定）
    expect(err.code).toBe('VERSION_CONFLICT');
    // 两侧**完整**指纹在错误对象上
    expect(err.expectVersion).toBe(mine);
    expect(err.actualVersion).toBe(versionOfText(theirsText));
    expect(err.actualVersion).not.toBe(err.expectVersion);
    // 报文里**报出两侧指纹**（不静默、不只说"有冲突"）
    expect(err.message).toContain('并发写入冲突');
    expect(err.message).toContain(String(mine).slice(0, 8));
    expect(err.message).toContain(String(err.actualVersion).slice(0, 8));
    expect(err.message).toContain('受管文件');
    // 磁盘一字不动（三记）
    expect(fingerprintOf(fs.readFileSync(file))).toEqual(before);
    // 也不许留下 .tmp 残留
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('② 读后被删除也拒写（不许"当新建文件"静默放行）', () => {
    const handle = readManagedText(file);
    fs.unlinkSync(file);
    let err = null;
    try { writeManagedText(handle, 'x\n'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.message).toContain('已不存在');
    expect(err.actualVersion).toBe(null);
    // 拒写 ⇒ 一个字节都不该被创建
    expect(fs.existsSync(file)).toBe(false);
  });

  it('③ 单写者路径：写出的字节与旧实现 fs.writeFileSync(p, s, \'utf8\') 完全相同', () => {
    // 覆盖三种容易踩的行尾/编码形态：纯 LF（本工程绝大多数）、纯 CRLF（renderer/app-view.js 那种）、
    // 中文 + 结尾无换行（JSON.stringify 之前的形态）
    const samples = [
      '# CHANGELOG\n\n## [Unreleased]\n- 中文一行\n',
      '# CHANGELOG\r\n\r\n## [Unreleased]\r\n- 中文一行\r\n',
      '{"version":"0.18.0","desc":"中文"}'
    ];
    for (const content of samples) {
      const handle = readManagedText(file);               // 单写者：读后没有别人改
      const r = writeManagedText(handle, content);
      expect(r.version).toBe(versionOfText(content));

      const refFile = path.join(dir, 'ref.txt');
      fs.writeFileSync(refFile, content, 'utf8');          // 旧实现的**参照产物**
      const got = fingerprintOf(fs.readFileSync(file));
      const want = fingerprintOf(fs.readFileSync(refFile));
      expect(got, '闸门改动了写出的字节 ⇒ 违反 H3（不给最高频动作加新成本：无并发时输出必须逐字节相同）')
        .toEqual(want);
      fs.unlinkSync(refFile);
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('④ 新建文件放行（optional 读 ⇒ version=null ⇒ 闸门不设卡）', () => {
    const fresh = path.join(dir, 'docs', 'CLI.md');
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    const h = readManagedText(fresh, { optional: true });
    expect(h.version).toBe(null);
    expect(h.text).toBe(null);
    const r = writeManagedText(h, 'generated\n');
    expect(r.version).toBe(versionOfText('generated\n'));
    expect(fs.readFileSync(fresh, 'utf8')).toBe('generated\n');
  });

  it('⑤ 默认读不到就抛（受管文档读不到是真问题，不许静默当空文件）', () => {
    expect(() => readManagedText(path.join(dir, 'nope.md'))).toThrow();
  });

  it('⑥ versionGate 自身：无 expectVersion 一律放行；有则严格比对', () => {
    expect(() => versionGate({ label: 'x', hint: 'y' })).not.toThrow();
    expect(() => versionGate({ label: 'x', hint: 'y', expectVersion: null, actualVersion: 'abc' })).not.toThrow();
    expect(() => versionGate({ label: 'x', hint: 'y', expectVersion: 'abc', actualVersion: 'abc' })).not.toThrow();
    expect(() => versionGate({ label: 'x', hint: 'y', expectVersion: 'abc', actualVersion: 'abd' })).toThrow(/并发写入冲突/);
  });
});

describe('结构断言：写盘出口唯一 + 比较逻辑只一份（A1 / D1 / D2）', () => {
  /** 扫描面（**共享常量**，不在断言里临时拼；照 testing-for-ai B4b 的结构断言要求） */
  const SCAN_SURFACES = ['src', 'cli'];

  const codeFilesUnder = (rel) => {
    const abs = path.join(ROOT, rel);
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (/\.js$/.test(e.name)) out.push(p);
      }
    })(abs);
    return out;
  };

  it('release.js 剥注释后**一处裸写都没有**，且写路径只经 store.writeManagedText', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'release.js'), 'utf8'));
    const bare = [...src.matchAll(/fs\.(writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(/g)];
    expect(bare.map((m) => m[0]), 'release.js 里还有裸写 ⇒ 违反 docs/INCIDENTS.md 派生禁令第 5 条')
      .toEqual([]);
    expect(src).toContain('store.writeManagedText(');
    // 也不许自己再写一份比较（那会让闸门变成两处表达）
    expect(src).not.toMatch(/actualVersion\s*[!=]==?/);
  });

  it('版本冲突的**比较与报错**在全仓（src/ · cli/）只有一处，且在 versionGate 里', () => {
    const cmpRe = /[\w.]*actualVersion\s*[!=]==?\s*[\w.]*expectVersion|[\w.]*expectVersion\s*[!=]==?\s*[\w.]*actualVersion/;
    const codeRe = /err\.code\s*=\s*VERSION_CONFLICT/g;
    const cmpHits = [];
    const codeHits = [];
    for (const rel of SCAN_SURFACES) {
      for (const f of codeFilesUnder(rel)) {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        if (cmpRe.test(src)) cmpHits.push(path.relative(ROOT, f).split(path.sep).join('/'));
        if (codeRe.test(src)) codeHits.push(path.relative(ROOT, f).split(path.sep).join('/'));
      }
    }
    expect(cmpHits, '同一件"盘上还是不是我读到的那一版"在不止一处被比较 ⇒ A1：只共用原语而各写一份比较不算共用')
      .toEqual(['src/data-store.js']);
    expect(codeHits, 'VERSION_CONFLICT 在不止一处被构造 ⇒ 报错实现不唯一')
      .toEqual(['src/data-store.js']);

    // 且必须**确实落在 versionGate 的函数体里**（不是散在别处恰好匹配上）
    const ds = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'data-store.js'), 'utf8'));
    const start = ds.indexOf('function versionGate(');
    expect(start).toBeGreaterThan(-1);
    const body = ds.slice(start, ds.indexOf('\n  }', start));
    expect(body).toMatch(/actualVersion\s*===\s*g\.expectVersion|g\.actualVersion\s*===\s*g\.expectVersion/);
    expect(body).toContain('err.code = VERSION_CONFLICT');
  });

  it('两条写路径都调同一个 versionGate（store.write 与 writeManagedText）', () => {
    const ds = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'data-store.js'), 'utf8'));
    const sliceOf = (sig, endSig) => {
      const a = ds.indexOf(sig);
      expect(a, '找不到 ' + sig).toBeGreaterThan(-1);
      const b = ds.indexOf(endSig, a);
      expect(b, '找不到 ' + endSig).toBeGreaterThan(a);
      return ds.slice(a, b);
    };
    const storeWrite = sliceOf('write(name, data, opts) {', 'assetDir(name) {');
    const managed = sliceOf('function writeManagedText(', 'function createStore(');
    expect(storeWrite, 'store.write 没走统一闸门').toContain('versionGate(');
    expect(managed, 'writeManagedText 没走统一闸门').toContain('versionGate(');
    // 整文件档也必须走原子写（禁令第 5 条的"写盘必须原子"那一半）
    expect(managed).toContain('writeFileAtomic(');
  });

  it('release.js 自己没有第二份原子写实现（tmp + rename 只许在 data-store 一处）', () => {
    const rel = 'cli/commands/release.js';
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    expect(src).not.toMatch(/fs\.renameSync\s*\(/);
    expect(src).not.toMatch(/\.tmp['"]/);
  });

  it('只报告：全仓还有几处自造的 tmp+rename（T3 的账，**只核实不改**）', () => {
    /* 判定档 = { 通过, 真缺陷 } —— 但这里的"通过"只表示**本批没有新增**，
     * 不表示"全仓已经只剩一处"。存量按 testing-for-ai B4 的欠账册口径**只报告、不判红**
     * （一次性全红的下场是门禁被关掉）；清单写在 .review/20261016-T3-CHANGELOG写闸门/README.md。
     *
     * ⚠️ 2026-10-16（写盘出口审计批）：`KNOWN_DEBT` 这份**手抄的**清单已删掉 ——
     * 它是"同一件事的第二处表达"（A3），而 S2 门禁的判定 ⑤（`WRITE_OUTLET`）已经把它做成了
     * **封闭欠账册**（`scripts/collateral-check.js` 的 `WRITE_OUTLET_DEBT`，带 why / close / cap，
     * 且**挂在 verify 链上**）。这里改为**引用那一份**，不维护副本。 */
    const outlet = require('../scripts/collateral-check.js');
    const KNOWN_DEBT = outlet.WRITE_OUTLET_DEBT
      .filter((e) => e.kind === 'self-atomic' && e.verdict === 'keep')
      .map((e) => e.at);
    const hits = [];
    for (const rel of SCAN_SURFACES) {
      for (const f of codeFilesUnder(rel)) {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        if (/fs\.renameSync\s*\(/.test(src)) hits.push(path.relative(ROOT, f).split(path.sep).join('/'));
      }
    }
    // 判红条件只有一条：出现**新的**自造实现（既不是统一闸门、也不在门禁侧的封闭欠账册里）
    const unexpected = hits.filter((f) => f !== 'src/data-store.js'
      && !outlet.WRITE_OUTLET_DEBT.some((e) => e.at === f && e.kind === 'self-atomic'));
    expect(unexpected, '新增了第二份原子写实现 ⇒ 违反 D1/D3（写盘出口只有一个函数）').toEqual([]);
    // 只报告读数（不参与判定）
    console.log('[只报告] 自造 tmp+rename 的文件：' + JSON.stringify(hits)
      + '（其中 src/data-store.js = 统一闸门本身；' + JSON.stringify(KNOWN_DEBT)
      + ' = 门禁欠账册里标了"有据降级"的存量）');
  });
});
