/* ============================================================
 * tests/collateral-check.test.js — 连带清单门禁（S2）的契约 + **判别力**
 * 运行：npx vitest run tests/collateral-check.test.js
 * ------------------------------------------------------------
 * 为什么这些用例长这样：
 *   ① **门禁本身必须可被单测 require**（末尾 `require.main` 守卫），判定逻辑要能单独喂输入。
 *   ② **表是单源**：下面直接拿真表检查"每一处连带都有身份"（有守卫的门禁必须挂在链上／
 *      残差必须显式标 null），这样"表里写了没人守"这件事**在单测里就能看见**。
 *   ③ **判别力**：注入式漏项（MCP 指向一条不存在的命令 / 域没登记进索引）在**内存里**做，
 *      真仓库那份文件不动 ✗ —— 这是"新门禁先证明它会红"的可重复版本。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/collateral-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'collateral-check.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'mcp-server.js'), 'utf8');
const entrySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke-assertions.js'), 'utf8');

describe('S2 门禁自身：可被单测引入（零副作用）', () => {
  it('require 之后拿到纯函数，且末尾有 require.main 守卫', () => {
    expect(typeof gate.extractMcpCommands).toBe('function');
    expect(typeof gate.missingFromIndex).toBe('function');
    expect(typeof gate.declaredChecks).toBe('function');
    expect(gateSrc).toMatch(/if \(require\.main === module\) main\(\);/);
  });

  it('纯函数：同一输入两次结果一致', () => {
    const src = "case 'x': return runCli(['read', 'a', '--json']);\n";
    expect(JSON.stringify(gate.extractMcpCommands(src))).toBe(JSON.stringify(gate.extractMcpCommands(src)));
  });
});

describe('S2 取事实：MCP 派发命令 / 冒烟域索引', () => {
  it('两种派发形状都能取到：`runCli([\'cmd\'…])` 与 `const c = [\'cmd\'…]`', () => {
    const src = [
      "case 'projects': return runCli(['projects', '--json']);",
      "case 'read_project': { const c = ['read', argOf('project'), '--json']; return runCli(c); }",
      "case 'dup': { const c = ['read', 'x']; return runCli(c); }"
    ].join('\n');
    expect(gate.extractMcpCommands(src).map((d) => d.cmd)).toEqual(['projects', 'read']);
  });

  it('真仓库：MCP 派发到的命令**全部**能在 registry 里找到（现状就是绿的）', () => {
    const cmds = gate.extractMcpCommands(mcpSrc).map((d) => d.cmd);
    const registry = require(path.join(ROOT, 'cli', 'registry.js')).list().map((c) => c.name);
    expect(cmds.length).toBeGreaterThan(30);
    expect(cmds.filter((c) => !registry.includes(c))).toEqual([]);
  });

  it('判别力（内存注入）：把一条派发命令改成不存在的名字 ⇒ 必被点名', () => {
    const injected = mcpSrc.replace("const c = ['read', ", "const c = ['read-renamed', ");
    expect(injected).not.toBe(mcpSrc);                      // 注入点真的命中了（防"注入打空"）
    const cmds = gate.extractMcpCommands(injected).map((d) => d.cmd);
    const registry = require(path.join(ROOT, 'cli', 'registry.js')).list().map((c) => c.name);
    expect(cmds.filter((c) => !registry.includes(c))).toEqual(['read-renamed']);
  });

  it('真仓库：冒烟域**全部**登记在入口索引里（存量 11 处已补）', () => {
    const domains = gate.smokeDomains(path.join(ROOT, 'scripts', 'smoke'));
    expect(domains.length).toBeGreaterThan(30);
    expect(gate.missingFromIndex(domains, entrySrc)).toEqual([]);
  });

  it('判别力（内存注入）：抹掉索引里的一行 ⇒ 那个域必被点名', () => {
    const injected = entrySrc.replace(' *   35-rel-edit.js', ' *   (已抹掉)');
    expect(injected).not.toBe(entrySrc);
    const domains = gate.smokeDomains(path.join(ROOT, 'scripts', 'smoke'));
    expect(gate.missingFromIndex(domains, injected)).toEqual(['35-rel-edit.js']);
  });
});

describe('S2 表自身：每一处连带都有身份（有守卫 / 是本门禁 / 显式残差）', () => {
  it('每一处的 `role` 只有四种取值，且与它的字段自洽（gate / check 不许缺）', () => {
    const roles = ['body', 'gate', 'self', 'residual'];
    const bad = [];
    gate.COLLATERAL.forEach((row) => row.places.forEach((p) => {
      if (roles.indexOf(p.role) < 0) { bad.push(p.at + '（role 非法: ' + p.role + '）'); return; }
      if (p.role === 'gate' && !p.gate) bad.push(p.at + '（role=gate 却没写门禁号）');
      if (p.role === 'self' && !p.check) bad.push(p.at + '（role=self 却没写 check 键）');
    }));
    expect(bad).toEqual([]);
  });

  it('`role: gate` 指的门禁必须真的挂在链上（"指过去复用"不许指向不存在的东西）', () => {
    const mounted = gate.mountedGates();
    expect(Array.isArray(mounted)).toBe(true);
    const bad = gate.referencedGates(gate.COLLATERAL)
      .filter((r) => !mounted.includes(r.gate)).map((r) => r.at + '（' + r.gate + ' 未挂链）');
    expect(bad).toEqual([]);
  });

  it('显式残差必须自报"残差"（不许把没守卫的那几处写成有人守）', () => {
    const residuals = [];
    gate.COLLATERAL.forEach((row) => row.places.forEach((p) => { if (p.role === 'residual') residuals.push(p); }));
    expect(residuals.length).toBeGreaterThan(0);
    residuals.forEach((p) => expect(p.note, p.at).toContain('残差'));
  });

  it('双向闭包：表里声明的 S2 断言键 == 本门禁实现的 CHECKS（两个差集都要空）', () => {
    const declared = gate.declaredChecks(gate.COLLATERAL).map((d) => d.key);
    expect([...new Set(declared)].sort()).toEqual(gate.CHECKS.slice().sort());
  });

  it('每一个"改动类型"至少写一处连带（空行 = 一张没用的表）', () => {
    gate.COLLATERAL.forEach((row) => expect(row.places.length, row.when).toBeGreaterThan(0));
  });

  it('真仓库整体：**上线就是绿的**（甲档：存量已补齐；挂链后这条应全绿）', () => {
    const r = gate.analyze();
    expect(r.problems).toEqual([]);
  });
});

/* ============================================================
 * ⑤ 写盘出口（`WRITE_OUTLET`）—— 受管资产的字节只允许从一个函数落盘
 * ------------------------------------------------------------
 * 三道：① 路径求值器本身能判什么/判不了什么（B4：纯函数要能单独喂输入）；
 *       ② 判定在**真仓库**上是绿的且读数**分档平衡**（受管 + 非受管 + 判不了 == 总数）；
 *       ③ 判别力：**内存注入**（不动真仓）⇒ 必须点名。完整注入证明见
 *          `.review/20261016-写盘出口审计/tools/inject-and-restore.js`（含三条真实事故形状）。
 * ============================================================ */
describe('S2 ⑤ 写盘出口：路径求值器（纯函数）', () => {
  const ctxOf = (file) => ({
    bindings: new Map(),
    returns: new Map(),
    dir: path.dirname(path.join(ROOT, file)),
    file: path.join(ROOT, file),
    depth: 0,
    seen: new Set()
  });

  it('字面量 / path.join / __dirname / 模板串 / `+` 拼接都能求值', () => {
    const c = ctxOf('scripts/x.js');
    expect(gate.evalPathExpr("'docs/VERIFY.md'", c)).toBe('docs/VERIFY.md');
    expect(gate.evalPathExpr('`docs/${"CLI"}.md`', c)).toBe('docs/CLI.md');
    expect(gate.evalPathExpr("path.join('a', 'b', 'c.md')", c)).toBe('a/b/c.md');
    expect(gate.evalPathExpr("__dirname + '/../docs/RULES.md'", c).replace(/\\/g, '/'))
      .toBe(path.join(ROOT, 'docs', 'RULES.md').replace(/\\/g, '/'));
  });

  it('**判不了就 null**（不猜）：函数参数 / os.tmpdir() / argv 一律 null', () => {
    const c = ctxOf('scripts/x.js');
    expect(gate.evalPathExpr('someParam', c)).toBe(null);
    expect(gate.evalPathExpr("path.join(os.tmpdir(), 'x')", c)).toBe(null);
    expect(gate.evalPathExpr("process.argv[2]", c)).toBe(null);
  });

  it('同文件零参函数的 return 会被追一跳（`doc-facts.js` 那种真实形状）', () => {
    const c = ctxOf('scripts/doc-facts.js');
    c.returns = new Map([['verifyDocPath', "path.join(__dirname, '..', 'docs', 'VERIFY.md')"]]);
    expect(gate.evalPathExpr('verifyDocPath()', c).replace(/\\/g, '/'))
      .toBe(path.join(ROOT, 'docs', 'VERIFY.md').replace(/\\/g, '/'));
  });

  it('绑定按**作用域**挑，不是"全文件取最后一处"（T3 实测张冠李戴过）', () => {
    const src = [
      'function a() {',
      "  const p = path.join(ROOT, 'docs', 'RULES.md');",
      '  write(p);',
      '}',
      'function b() {',
      "  const p = path.join(ROOT, '.review', 'x.json');",
      '  write(p);',
      '}'
    ].join('\n');
    const list = gate.collectBindingList(src);
    const blocks = gate.collectFunctionBlocks(src);
    const atA = src.indexOf('write(p);');
    const atB = src.lastIndexOf('write(p);');
    expect(gate.bindingsAt(list, blocks, atA).get('p')).toContain('RULES.md');
    expect(gate.bindingsAt(list, blocks, atB).get('p')).toContain('.review');
  });
});

describe('S2 ⑤ 写盘出口：真仓库读数与判据', () => {
  const r = gate.analyzeWriteOutlet(ROOT);

  it('真仓库：判定 ⑤ 是绿的（存量逐条在册，没有计划外违规）', () => {
    expect(r.problems.filter((p) => p.kind === 'write-outlet' || p.kind === 'ledger')).toEqual([]);
  });

  it('读数**分档平衡**：写调用点总数 == 受管 + 非受管 + 判不了（不许有"没归类"的黑洞）', () => {
    const rd = r.readings;
    expect(rd.writeSites).toBe(rd.managedSites + rd.unmanagedSites + rd.unresolvedSites);
    expect(rd.writeSites).toBeGreaterThan(50);
  });

  it('欠账册**封闭**：条数 ≤ cap · 每条 why/close 齐 · kind/verdict 都是枚举值', () => {
    expect(gate.WRITE_OUTLET_DEBT.length).toBeLessThanOrEqual(gate.WRITE_OUTLET_CAP);
    gate.WRITE_OUTLET_DEBT.forEach((e) => {
      expect(e.why, e.at).toBeTruthy();
      expect(e.close, e.at).toBeTruthy();
      expect(['file', 'site', 'self-atomic']).toContain(e.kind);
      expect(['keep', 'debt']).toContain(e.verdict);
      if (e.kind === 'site') {
        // 逐调用点豁免必须**真的写了签名与处数** —— 否则它就退化成一条整文件豁免（那要写成 file）
        expect(Array.isArray(e.sites), e.at).toBe(true);
        expect(e.sites.length, e.at).toBeGreaterThan(0);
        e.sites.forEach((x) => {
          expect(x.sig, e.at).toBeTruthy();
          expect(x.what, e.at + ' / ' + x.sig).toBeTruthy();
          expect(Number.isInteger(x.n === undefined ? 1 : x.n), e.at + ' / ' + x.sig).toBe(true);
        });
      }
    });
    // 上限只减不增：写死成"当前条数"，多一条就必须同批抬 cap 并说明为什么
    // 2026-10-19：9 → 8（偿掉 `src/dsh-package.js` 的自造 tmp+rename 后销账，同批降 cap）
    //            本批**没动**条数 —— `main.js` 是 1 条 `file` 改成 1 条 `site`（7 处签名），
    //            条目数不变而**面**不变（82），变的是"第 8 处会不会红"。
    expect(gate.WRITE_OUTLET_CAP).toBe(8);
    // 面（= 被豁免覆盖的写调用点数）单独一条 cap：**拆细条目换不来额度**
    expect(gate.WRITE_OUTLET_SITE_CAP).toBe(82);
  });

  it('豁免面读数：被覆盖的写调用点数 ≤ siteCap，且**每一处都在册**（没有计划外的豁免）', () => {
    expect(r.readings.exemptSites).toBeLessThanOrEqual(gate.WRITE_OUTLET_SITE_CAP);
    // 分子与分档自洽：豁免面不可能超过（受管 + 判不了）—— 非受管那 5 处没人豁免它
    expect(r.readings.exemptSites).toBeLessThanOrEqual(r.readings.managedSites + r.readings.unresolvedSites);
    expect(r.readings.fileExemptFiles).toBe(5);
    expect(r.readings.siteExemptFiles).toBe(1);
    expect(r.exemptSites).toBe(r.readings.exemptSites);
  });

  it('出口本体**不在**自造名单里（它是出口），且出口之外的每一个都在册', () => {
    expect(r.selfAtomic).not.toContain(gate.WO_OUTLET_FILE);       // 出口本体刻意排除
    expect(r.selfAtomic.length).toBeGreaterThan(0);
    // 自查：真仓里凡是出现 tmp+rename 签名的非出口文件，都必须在册（否则 analyzeWriteOutlet 会报 write-outlet）
    const want = gate.woScanTargets(ROOT).filter((rel) => rel !== gate.WO_OUTLET_FILE
      && gate.hasSelfAtomicSignature(gate.blankQuoted(fs.readFileSync(path.join(ROOT, rel), 'utf8'),
        { comments: true, strings: true })));
    expect(want.sort()).toEqual(r.selfAtomic.slice().sort());
    want.forEach((x) => {
      expect(gate.WRITE_OUTLET_DEBT.some((e) => e.at === x && e.kind === 'self-atomic'), x).toBe(true);
    });
  });
});

describe('S2 ⑤ 写盘出口：判别力（**内存注入**，不动真仓）', () => {
  it('往一份干净源码里注入一处裸写受管资产 ⇒ 必被点名（并解析出真实路径）', () => {
    const src = "const fs = require('fs');\n"
      + "function probe() {\n"
      + "  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'RULES.md'), 'x', 'utf8');\n"
      + '}\n';
    const sites = gate.scanWriteSites('scripts/zz-probe.js', src, ROOT);
    expect(sites.length).toBe(1);
    expect(sites[0].through).toBe(false);
    const rel = path.relative(ROOT, sites[0].resolved).replace(/\\/g, '/');
    expect(rel).toBe('docs/RULES.md');
    expect(gate.woManagedFamily(rel).id).toBe('doc');
  });

  it('**出口调用根本不算写调用点**（`writeManagedText` / `writeFileAtomic` 是唯一出口）', () => {
    const src = "const fs = require('fs');\n"
      + 'function probe(h, t) {\n'
      + '  writeManagedText(h, t);\n'
      + '  return writeFileAtomic(path.join(__dirname, "..", "docs", "RULES.md"), t);\n'
      + '}\n';
    expect(gate.scanWriteSites('scripts/zz-probe.js', src, ROOT)).toEqual([]);
    // 反向：把同一处换成裸写 ⇒ 必须算作写调用点（否则上面那条"空数组"毫无意义）
    const bare = src.replace('return writeFileAtomic(', 'return fs.writeFileSync(');
    expect(gate.scanWriteSites('scripts/zz-probe.js', bare, ROOT).length).toBe(1);
  });

  it('**报文里的示例写法不算实现**（字符串里的 `fs.writeFileSync(` 不许把自己判红）', () => {
    // 这条是本批自己踩的坑：失败报文里写了「同时有 `fs.writeFileSync(` 与 `fs.renameSync(`」⇒ 自判红
    const src = "const msg = '里同时有 `fs.writeFileSync(` 与 `fs.renameSync(`';\n";
    expect(gate.hasSelfAtomicSignature(src)).toBe(true);                       // 原始文本里有（所以必须抹）
    expect(gate.hasSelfAtomicSignature(gate.blankQuoted(src, { comments: true, strings: true }))).toBe(false);
  });

  it('**正则字面量里的引号不许把状态机带跑偏**（曾导致真违规静默漏过）', () => {
    const src = "const s = String(t).replace(/[\\u001b]/g, '');\n"
      + "fs.writeFileSync(path.join(__dirname, '..', 'docs', 'VERIFY.md'), s, 'utf8');\n";
    const sites = gate.scanWriteSites('scripts/zz-probe.js', src, ROOT);
    expect(sites.length).toBe(1);
    expect(String(sites[0].resolved).replace(/\\/g, '/')).toContain('docs/VERIFY.md');
  });
});

/* ============================================================
 * 判定 ③：出口本体的原子写**不许降级**（2026-10-19 本批补）
 * ------------------------------------------------------------
 * 为什么有这一段：`e0f992c` 的 I3 注入实测 —— 把 `writeFileAtomic`（tmp + fsync + rename）
 * 换成一把**裸写** ⇒ **S2 exit 0**。于是"原子写被换成更弱的东西"这件事**没有任何判据会红**。
 * 三条腿（写 tmp / fsync / rename）**必须各自能单独打红** —— 只测"整体降级"会漏掉"只抽掉一条腿"。
 * ============================================================ */
describe('S2 ⑤ 判定 ③：出口本体的原子写不许降级', () => {
  const dsSrc = fs.readFileSync(path.join(ROOT, gate.WO_OUTLET_FILE), 'utf8');
  const FSYNC_LINE = '      fs.fsyncSync(fd);          // 关键：先落盘，再 rename';

  it('真仓库：`writeFileAtomic` 三条腿都在（现状就是绿的）', () => {
    const v = gate.outletAtomicVerdict(dsSrc);
    expect(v.defs).toBe(1);
    expect(v.param).toBe('file');
    expect(v.write).toBe(true);
    expect(v.fsync).toBe(true);
    expect(v.rename).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('判别力——**整体降级成裸写**（= I3 的形状）⇒ 必红，且点名"直接写目标"', () => {
    const degraded = dsSrc.replace('      fs.writeFileSync(fd, content);\n' + FSYNC_LINE,
      '      fs.writeFileSync(file, content);');
    expect(degraded).not.toBe(dsSrc);              // 注入点真的命中了（防"注入打空"）
    const v = gate.outletAtomicVerdict(degraded);
    expect(v.ok).toBe(false);
    expect(v.direct).toEqual(['file']);
    expect(v.missing).toContain('fsync');
  });

  it('判别力——三条腿**各自单独抽掉**都必红', () => {
    const noFsync = dsSrc.replace(FSYNC_LINE + '\n', '');
    expect(noFsync).not.toBe(dsSrc);
    expect(gate.outletAtomicVerdict(noFsync).missing).toContain('fsync');
    expect(gate.outletAtomicVerdict(noFsync).ok).toBe(false);

    const noRename = dsSrc.replace('      renameWithRetry(tmp, file);',
      '      fs.copyFileSync(tmp, file);\n      fs.unlinkSync(tmp);');
    expect(noRename).not.toBe(dsSrc);
    expect(gate.outletAtomicVerdict(noRename).missing).toContain('rename');
    expect(gate.outletAtomicVerdict(noRename).ok).toBe(false);
  });

  it('**找不到定义 / 出现两份** ⇒ 也红（采不到真值 = 红，A5）', () => {
    expect(gate.outletAtomicVerdict('').defs).toBe(0);
    expect(gate.outletAtomicVerdict('').missing).toContain('def');
    expect(gate.outletAtomicVerdict('').ok).toBe(false);
    const twice = dsSrc + '\nfunction writeFileAtomic(file, content) { fs.writeFileSync(file, content); }\n';
    expect(gate.outletAtomicVerdict(twice).defs).toBe(2);
    expect(gate.outletAtomicVerdict(twice).ok).toBe(false);
  });

  it('**注释里的示例写法不是实现**（剥注释后再扫，B4b）', () => {
    const inComment = '// function writeFileAtomic(file, content) { fs.writeFileSync(file, content); }\n' + dsSrc;
    expect(gate.outletAtomicVerdict(inComment).defs).toBe(1);
    expect(gate.outletAtomicVerdict(inComment).ok).toBe(true);
  });

  it('判红报文点名**缺哪条腿**（不然下一个人不知道该补什么）', () => {
    const noFsync = dsSrc.replace(FSYNC_LINE + '\n', '');
    expect(gate.describeAtomicVerdict(gate.outletAtomicVerdict(noFsync))).toContain('fsync');
  });
});

/* ============================================================
 * 逐调用点豁免（`kind: 'site'`）：**已知 7 处仍豁免，第 8 处判红**
 * ------------------------------------------------------------
 * 为什么改成逐调用点：`main.js` 整文件在册时，判定 ①/④ 对它**整体短路**
 * （实测：把 W1 的探针写回 `projects/` ⇒ exit 0）。按"签名 + 处数"核对之后新增一处必红；
 * 端到端注入证明见 `.review/20261019-S2两盲区/inject-proof.js`（J4 / J5 / J6）。
 * ============================================================ */
describe('S2 ⑤ 逐调用点豁免：匹配口径（纯函数）', () => {
  const fake = [
    { at: 'a.js', kind: 'file', verdict: 'keep', why: 'w', close: 'c' },
    { at: 'b.js', kind: 'site', verdict: 'keep', why: 'w', close: 'c',
      sites: [{ sig: 'out', n: 2, what: 'w' }, { sig: "path.join(ROOT, 'x')", n: 1, what: 'w' }] },
    { at: 'c.js', kind: 'self-atomic', verdict: 'keep', why: 'w', close: 'c' }
  ];
  const m = gate.makeExemptMatcher(fake);

  it('`kind: file` ⇒ 该文件里**所有**签名都豁免', () => {
    expect(m.isExempt('a.js', 'anything')).toBe(true);
    expect(m.isExempt('a.js', undefined)).toBe(true);
  });

  it('`kind: site` ⇒ 只豁免**登记过的签名**，同文件里没登记的照样不豁免', () => {
    expect(m.isExempt('b.js', 'out')).toBe(true);
    expect(m.isExempt('b.js', "path.join(ROOT, 'x')")).toBe(true);
    expect(m.isExempt('b.js', 'out2')).toBe(false);             // ← 新增一处必红
    expect(m.isExempt('b.js', 'res.filePath')).toBe(false);
  });

  it('签名按**折行归一**匹配（调用行换行不必改册）', () => {
    expect(m.isExempt('b.js', "path.join(ROOT,\n      'x')")).toBe(true);
    expect(gate.normSig('  a  +\n b  ')).toBe('a + b');
  });

  it('`self-atomic` / 未在册的文件不产生调用点豁免', () => {
    expect(m.isExempt('c.js', 'out')).toBe(false);
    expect(m.isExempt('zz.js', 'out')).toBe(false);
  });
});

describe('S2 ⑤ 逐调用点豁免：真仓库读数', () => {
  const r2 = gate.analyzeWriteOutlet(ROOT);
  const mainEntry = gate.WRITE_OUTLET_DEBT.find((e) => e.at === 'main.js');

  it('`main.js` 是逐调用点豁免，且册上每一处签名**当前都真的存在**、处数也对得上', () => {
    expect(mainEntry.kind).toBe('site');
    const sites = r2.byFile.get('main.js') || [];
    mainEntry.sites.forEach((x) => {
      const got = sites.filter((s) => gate.normSig(s.target) === gate.normSig(x.sig)).length;
      expect(got, 'main.js 的 sig=' + x.sig).toBe(x.n === undefined ? 1 : x.n);
    });
  });

  it('`main.js` 那 7 处里**只有 1 处**是受管资产裸写（其余 6 处判不了）—— 这是豁免面的构成', () => {
    const mg = r2.sites.filter((s) => s.rel === 'main.js');
    const un = r2.unresolved.filter((s) => s.rel === 'main.js');
    expect(mg.length + un.length).toBe(7);
    expect(mg.length).toBe(1);
    expect(un.length).toBe(6);
  });
});
