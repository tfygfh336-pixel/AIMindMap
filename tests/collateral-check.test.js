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

/* ============================================================
 * ①-2 MCP 缺口册（`MCP_GAP_DEBT`）—— **CLI→MCP 的反方向**
 * ------------------------------------------------------------
 * 为什么要有这一组（缺口 `GAP-2`）：门禁原先只守 `MCP → CLI`（派发到的命令必须存在），
 * 反方向只有一行注记「那是人的判断，不是缺陷」⇒ **注记等于没有**（`source-chain` 就这样无声落进来）。
 * 这一组锁三件事：
 *   甲 **册与事实双向镜像**（真仓库上两个差集都空 —— 这才是"只减不增"的机械保证）；
 *   乙 **三方向判别力**（纯函数喂输入：没登记 / 已做了 / 已不是命令，各打一次红）+ 上界；
 *   丙 **真文件上的方向证明**（在内存里改 `mcp-server.js` 的**文本** ⇒ 不动真仓一个字节）。
 * ============================================================ */
describe('S2 ①-2 MCP 缺口册：册与事实双向镜像（真仓库）', () => {
  const registry = require(path.join(ROOT, 'cli', 'registry.js')).list().map((c) => c.name);
  const dispatched = gate.extractMcpCommands(mcpSrc).map((d) => d.cmd);

  it('真仓库：`registry \\ MCP 工具面` == 册上命令集（两个差集都空）', () => {
    const gap = registry.filter((n) => !dispatched.includes(n)).sort();
    const book = gate.MCP_GAP_DEBT.map((e) => e.cmd).sort();
    expect(gap.filter((n) => !book.includes(n))).toEqual([]);   // 缺口没登记 ⇒ 这本册就是注记
    expect(book.filter((n) => !gap.includes(n))).toEqual([]);   // 册上是已做 / 已无 ⇒ 册永不缩
    expect(gap.length).toBeGreaterThan(0);                      // 全做完了就该把册一起删掉
    expect(gate.MCP_GAP_DEBT.length).toBe(gap.length);
  });

  it('条数 == 上界，且上界是**字面量**（不是 `MCP_GAP_DEBT.length` —— 后者会跟着册一起涨）', () => {
    expect(gate.MCP_GAP_DEBT.length).toBeLessThanOrEqual(gate.MCP_GAP_DEBT_MAX);
    expect(gate.MCP_GAP_DEBT_MAX).toBe(gate.MCP_GAP_DEBT.length);
    expect(gateSrc).toMatch(/const MCP_GAP_DEBT_MAX = \d+;/);
  });

  it('每条都有 `why`（一句"为什么不做 MCP"）· 命令名不重复 · 都是真命令', () => {
    gate.MCP_GAP_DEBT.forEach((e) => {
      expect(typeof e.cmd, JSON.stringify(e)).toBe('string');
      expect(String(e.why || '').length, e.cmd).toBeGreaterThan(8);
    });
    expect(new Set(gate.MCP_GAP_DEBT.map((e) => e.cmd)).size).toBe(gate.MCP_GAP_DEBT.length);
    gate.MCP_GAP_DEBT.forEach((e) => expect(registry, e.cmd).toContain(e.cmd));
  });

  it('`CHECKS` 里有 `MCP_GAP`，且连带表有一处 `role: self` 指向它（声明↔实现双向闭包）', () => {
    expect(gate.CHECKS).toContain('MCP_GAP');
    const decl = gate.declaredChecks(gate.COLLATERAL).filter((d) => d.key === 'MCP_GAP');
    expect(decl.length).toBeGreaterThan(0);
  });
});

describe('S2 ①-2 MCP 缺口册：三方向 + 上界（纯函数，喂输入就能打红它）', () => {
  const registry = ['read', 'tagged-cmd', 'half-done'];
  const base = { registry: registry, dispatched: ['read'] };

  it('方向①（`GAP-2` 的正题）：registry 里有、MCP 没有、册上也没有 ⇒ 红并**点名**', () => {
    const v = gate.judgeMcpGap(Object.assign({}, base, { ledger: [] }));
    expect(v.problems.length).toBe(2);                       // tagged-cmd + half-done
    expect(v.uncovered.sort()).toEqual(['half-done', 'tagged-cmd']);
    expect(v.problems.map((p) => p.msg).join('\n')).toContain('`tagged-cmd`');
    expect(v.problems[0].msg).toContain('MCP_GAP_DEBT');     // 报文给出两条出路
  });

  it('方向②：册上那条**已经有 MCP 工具** ⇒ 红（"只减不增"的机械保证）', () => {
    const v = gate.judgeMcpGap(Object.assign({}, base, {
      ledger: [{ cmd: 'read', why: '假装这条还没做' }, { cmd: 'tagged-cmd', why: 'x' }, { cmd: 'half-done', why: 'y' }]
    }));
    expect(v.alreadyDone).toEqual(['read']);
    expect(v.problems.map((p) => p.msg).join('\n')).toContain('已经有 MCP 工具');
    expect(v.problems.map((p) => p.msg).join('\n')).toContain('MCP_GAP_DEBT_MAX');   // 销账要同批调小上限
  });

  it('方向② 的另一半：册上钉住**已不是命令**的名字 ⇒ 也红（改名 / 删命令后册会永远对不上）', () => {
    const v = gate.judgeMcpGap(Object.assign({}, base, {
      ledger: [{ cmd: 'renamed-away', why: '这条命令已经改名了' }]
    }));
    expect(v.dangling).toEqual(['renamed-away']);
    expect(v.problems.map((p) => p.msg).join('\n')).toContain('不是 registry 里的命令');
  });

  it('**方向① 反过来读（"从册上删一条、那条确实还没做"）⇒ 一定被点名** —— 这一向判得到', () => {
    const ledger = gate.MCP_GAP_DEBT.filter((e) => e.cmd !== 'source-chain');
    const realRegistry = require(path.join(ROOT, 'cli', 'registry.js')).list().map((c) => c.name);
    const realDispatched = gate.extractMcpCommands(mcpSrc).map((d) => d.cmd);
    const v = gate.judgeMcpGap({ registry: realRegistry, dispatched: realDispatched, ledger: ledger });
    /* ⚠️ 判据写成**相对基线**而不是"恰好等于 ['source-chain']"：真仓此刻可能还有**别的在飞批**
     * 刚落的命令没登记（那正是本门禁要抓的形状）—— 那不该让"删一条 ⇒ 点一条"这条逻辑判成坏的。
     * 所以比的是：比基线**多一条**，且多的那条**就是**被删掉的那条。 */
    const base = gate.judgeMcpGap({ registry: realRegistry, dispatched: realDispatched });
    expect(v.uncovered.length).toBe(base.uncovered.length + 1);
    expect(v.uncovered).toContain('source-chain');
    expect(v.problems.map((p) => p.msg).join('\n')).toContain('`source-chain`');
  });

  it('上界：条数超 `MCP_GAP_DEBT_MAX` ⇒ 红（报文形状照 `WRITE_OUTLET_SITE_CAP`）', () => {
    const ledger = [{ cmd: 'tagged-cmd', why: 'x' }, { cmd: 'half-done', why: 'y' }];
    const v = gate.judgeMcpGap(Object.assign({}, base, { ledger: ledger, max: 1 }));
    expect(v.readings.onBook).toBe(2);
    expect(v.readings.max).toBe(1);
    const msg = v.problems.map((p) => p.msg).join('\n');
    expect(msg).toContain('缺口册涨了');
    expect(msg).toContain('只减不增');
  });

  it('条目本身：缺 `why` / 同名重复 ⇒ 各红一条（没名字的判断 = 注记）', () => {
    const v = gate.judgeMcpGap(Object.assign({}, base, {
      ledger: [{ cmd: 'tagged-cmd' }, { cmd: 'half-done', why: 'y' }, { cmd: 'half-done', why: 'y' }]
    }));
    const msg = v.problems.map((p) => p.msg).join('\n');
    expect(msg).toContain('缺 `why`');
    expect(msg).toContain('出现了两次');
  });

  it('负对照：事实与册完全一致 ⇒ **零问题**（判据不是恒红）', () => {
    const v = gate.judgeMcpGap(Object.assign({}, base, {
      ledger: [{ cmd: 'tagged-cmd', why: 'x' }, { cmd: 'half-done', why: 'y' }]
    }));
    expect(v.problems).toEqual([]);
    expect(v.readings.uncovered).toBe(0);
    expect(v.readings.gap).toBe(2);
  });
});

describe('S2 ①-2 MCP 缺口册：真文件上的方向证明（**内存注入文本**，真仓一字节不动）', () => {
  const registry = require(path.join(ROOT, 'cli', 'registry.js')).list().map((c) => c.name);

  it('给册上一条命令**真加派发**（`runCli([\'source-chain\'…])`）⇒ 必报"已经有 MCP 工具了"', () => {
    const injected = mcpSrc.replace("case 'projects': return runCli(['projects', '--json']);",
      "case 'projects': return runCli(['projects', '--json']);\n"
      + "    case 'source_chain': return runCli(['source-chain', argOf('project'), argOf('id'), '--json']);");
    expect(injected).not.toBe(mcpSrc);                        // 注入点真的命中了（防"注入打空"）
    const v = gate.judgeMcpGap({
      registry: registry, dispatched: gate.extractMcpCommands(injected).map((d) => d.cmd)
    });
    expect(v.alreadyDone).toEqual(['source-chain']);
  });

  it('把一条派发**抽掉** ⇒ 方向① 必红并点名它（这条命令此前不在册，正是"新命令无声落进来"）', () => {
    const injected = mcpSrc.replace("case 'projects': return runCli(['projects', '--json']);", '');
    expect(injected).not.toBe(mcpSrc);
    const v = gate.judgeMcpGap({
      registry: registry, dispatched: gate.extractMcpCommands(injected).map((d) => d.cmd)
    });
    expect(v.uncovered).toContain('projects');               // 相对基线：真仓别的缺口不干扰这一条
    expect(v.problems.map((p) => p.msg).join('\n')).toContain('`projects`');
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

/* ============================================================
 * ⑥ 笔记正文残留（`NOTE_RESIDUE`）—— `detail` 里不许留 Markdown 定界符
 * ------------------------------------------------------------
 * 为什么有这一段：`detail` 的语义是 **innerHTML**（`docs/DATA-FORMAT.md` §2.4），
 * 写进去的 `**粗体**` / 反引号会**原样显示**，而 `validate-all` 只校结构、**全绿**。
 * 上一批只补了「标签开闭」那一半（`.review/20261019-PDF正文核对/check-html.mjs`），
 * **Markdown 残留一直没有任何机器门禁**（`ada00407` 实测一批里数十处）。
 * 三档一起测（`B8`）：判红 / 只报告 / 跳过；**"含 `*` 就判红"是刻意不做的**（`int *p;` 必须绿）。
 * 完整注入证明（含逐字节还原）见 `.review/20261019-Markdown残留门禁/proof-inject.mjs`。
 * ============================================================ */
describe('S2 ⑥ 笔记正文残留：判据是纯函数（可单独喂输入）', () => {
  const hitsOf = (html) => gate.scanDetailResidue(html).hits;
  const failOf = (html) => hitsOf(html).filter((h) => h.tier === 'fail');
  const reportOf = (html) => hitsOf(html).filter((h) => h.tier === 'report');

  it('判红档：成对 `**粗体**` / 成对反引号 / 围栏 / `[字](链)` / 行首 `#` —— 各一条', () => {
    expect(failOf('<p>这里 **粗体** 了</p>').map((h) => h.rule)).toEqual(['bold-pair']);
    expect(failOf('<p>这里 `dmesg | tail` 了</p>').map((h) => h.rule)).toEqual(['code-span']);
    // 围栏只报 `fence` 一条（三个反引号不许同时被 code-span 再报一遍）
    expect(failOf('<p>围栏：```js</p>').map((h) => h.rule)).toEqual(['fence']);
    expect(failOf('<p>看 [设计稿](docs/x.md) 去</p>').map((h) => h.rule)).toEqual(['link']);
    expect(failOf('# 一、标题\n正文').map((h) => h.rule)).toEqual(['heading-raw']);
  });

  it('**不假红**：`int *p;` / `a*b` / `*.js` / `2*a*b` 里的 `*` 都不进判红档', () => {
    // 这条是本判据的核心边界：`int *p;` 只有**一个** `*`（不成对）⇒ 判据看不见它
    expect(failOf('<p>C 指针 int *p; 与 char **pp;</p>')).toEqual([]);
    expect(failOf('<p>乘法 a*b、通配 *.js、正则 a*?b</p>')).toEqual([]);
    // `2*a*b` 成对但**无法与乘号分辨** ⇒ 只报告，绝不判红
    expect(failOf('<p>公式 2*a*b 与 3*x*y</p>')).toEqual([]);
    expect(reportOf('<p>公式 2*a*b</p>').map((h) => h.rule)).toContain('italic-pair');
    // Python dunder 与"成对下划线"同形 ⇒ 只报告
    expect(failOf('<p>入口 __main__ 与 __init__</p>')).toEqual([]);
    expect(reportOf('<p>入口 __main__ 与 __init__</p>').map((h) => h.rule)).toContain('underline-pair');
  });

  it('跳过档：`<code>` / `<pre>` / 注释里的残留是**内容**，不计入任何一档', () => {
    const r = gate.scanDetailResidue('<p><code>**这不是残留**</code></p>'
      + '<pre><code>`也不是`</code></pre><!-- **更不是** -->');
    expect(r.hits).toEqual([]);
    // `<pre><code>…</code></pre>` 里那个 code 被 pre 段整段吃掉（嵌套只算最外层一段）⇒ code=1
    expect(r.masked.code).toBe(1);
    expect(r.masked.pre).toBe(1);
    expect(r.masked.comment).toBe(1);
  });

  it('掩掉区块**保留换行**（行号与列号不许漂：报错要能直接定位）', () => {
    const html = '<pre><code>a\nb\nc</code></pre>\n<p>**坏在这里**</p>';
    const h = gate.scanDetailResidue(html).hits.filter((x) => x.tier === 'fail');
    expect(h.length).toBe(1);
    expect(h[0].line).toBe(4);                       // 掩掉的三行仍在 ⇒ 行号是原文的行号
  });

  it('同一输入两次结果一致（纯函数，没有隐藏状态）', () => {
    const html = '<p>**a** `b` [c](d) 2*x*y</p>';
    expect(JSON.stringify(gate.scanDetailResidue(html).hits))
      .toBe(JSON.stringify(gate.scanDetailResidue(html).hits));
  });

  it('判据表本身：tier 只有 fail / report 两档，且每条都写了 why（放行理由要能打印）', () => {
    gate.NOTE_RESIDUE_RULES.forEach((r) => {
      expect(['fail', 'report'], r.id).toContain(r.tier);
      expect(r.why, r.id).toBeTruthy();
      expect(Boolean(r.re) || Boolean(r.scan), r.id).toBe(true);
    });
  });

  it('`判定档` 至少容得下三档（`B4c`）：通过 / 判红 / 只报告 —— 不许把"有意保留"与"真缺陷"压成一个数', () => {
    expect(Object.keys(gate.NOTE_RESIDUE_TIERS).sort()).toEqual(['fail', 'report', 'skip']);
  });
});

describe('S2 ⑥ 笔记正文残留：真仓库读数与封闭欠账册', () => {
  const r = gate.analyzeNoteResidue(path.join(ROOT, 'projects'));

  it('真仓库：判定 ⑥ 是绿的（存量逐条在册，没有计划外残留）', () => {
    expect(r.problems).toEqual([]);
  });

  it('读数分档平衡：判红命中 == 在册覆盖 + 计划外（在册的必须逐处对得上）', () => {
    expect(r.readings.failHits).toBeGreaterThanOrEqual(r.readings.exemptHits);
    expect(r.readings.exemptHits).toBeLessThanOrEqual(gate.NOTE_RESIDUE_HIT_CAP);
    // 绿的前提：**每一处判红命中都在册**
    expect(r.readings.failHits).toBe(r.readings.exemptHits);
  });

  it('欠账册**封闭**：条数 ≤ cap · 每条 project/node/rules/why/close 齐 · 规则 id 必须是判红档的', () => {
    expect(gate.NOTE_RESIDUE_DEBT.length).toBeLessThanOrEqual(gate.NOTE_RESIDUE_CAP);
    const failIds = gate.NOTE_RESIDUE_RULES.filter((x) => x.tier === 'fail').map((x) => x.id);
    gate.NOTE_RESIDUE_DEBT.forEach((e) => {
      expect(e.project, JSON.stringify(e)).toBeTruthy();
      expect(e.node, JSON.stringify(e)).toBeTruthy();
      expect(e.why, e.project + '::' + e.node).toBeTruthy();
      expect(e.close, e.project + '::' + e.node).toBeTruthy();
      expect(Object.keys(e.rules).length, e.project + '::' + e.node).toBeGreaterThan(0);
      Object.keys(e.rules).forEach((id) => expect(failIds, id).toContain(id));
    });
  });

  it('**面上界与册逐处对齐**：册上处数之和 == `NOTE_RESIDUE_HIT_CAP`（改册就要同批改 cap）', () => {
    const sum = gate.NOTE_RESIDUE_DEBT.reduce((s, e) => s
      + Object.keys(e.rules).reduce((t, id) => t + e.rules[id], 0), 0);
    expect(sum).toBe(gate.NOTE_RESIDUE_HIT_CAP);
    expect(gate.NOTE_RESIDUE_CAP).toBe(gate.NOTE_RESIDUE_DEBT.length);
  });
});

describe('S2 ⑥ 笔记正文残留：判别力（**临时夹具**，不碰 projects/**）', () => {
  const os = require('node:os');
  const fsx = require('node:fs');
  const proj = (nodes) => ({ version: 3, data: { id: 'root', topic: 'r', children: nodes } });

  /** 在系统临时目录造一个"扫描根"（`E2`：整段 try/finally 收尾，失败也清） */
  function withFixture(files, fn) {
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'mm-note-residue-'));
    try {
      Object.keys(files).forEach((name) => {
        fsx.mkdirSync(path.join(dir, name), { recursive: true });
        fsx.writeFileSync(path.join(dir, name, name + '.json'), JSON.stringify(files[name]), 'utf8');
      });
      return fn(dir);
    } finally {
      fsx.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('干净夹具 ⇒ 绿；注入 `**粗体**` ⇒ **必红并点名项目/节点/规则**', () => {
    withFixture({ 'fx': proj([{ id: 'n1', topic: 't', detail: '<p>干净</p>' }]) }, (dir) => {
      expect(gate.analyzeNoteResidue(dir, null).problems).toEqual([]);
      fsx.writeFileSync(path.join(dir, 'fx', 'fx.json'),
        JSON.stringify(proj([{ id: 'n1', topic: 't', detail: '<p>坏了 **粗体**</p>' }])), 'utf8');
      const bad = gate.analyzeNoteResidue(dir, null).problems;
      expect(bad.length).toBe(1);
      expect(bad[0].kind).toBe('note-residue');
      expect(bad[0].msg).toContain('`fx`');
      expect(bad[0].msg).toContain('n1');
      expect(bad[0].msg).toContain('bold-pair');
      expect(bad[0].msg).toContain('--detail-md');            // 必须给出唯一修法
    });
  });

  it('注入 `int *p;` ⇒ **仍绿**（不假红；这是本判据最重要的一条边界）', () => {
    withFixture({ 'fx': proj([{ id: 'n1', detail: '<p>int *p; 与 char **pp; 与 a*b</p>' }]) }, (dir) => {
      const res = gate.analyzeNoteResidue(dir, null);
      expect(res.problems).toEqual([]);
      expect(res.readings.failHits).toBe(0);
    });
  });

  it('欠账册四条机械判定各自能红：悬挂 / 已偿未销账 / 处数偏大 / 处数变多（新增）', () => {
    const html = '<p>**a** **b**</p>';                       // 2 处 bold-pair
    /* 夹具册不参与生产 cap：清零后 NOTE_RESIDUE_CAP 是 0，这里显式给足额度 */
    const CAP_FOR_FIXTURE = { capDebt: 99, capHits: 99 };
    withFixture({ 'fx': proj([{ id: 'n1', detail: html }]) }, (dir) => {
      const book = (rules, node) => [{ project: 'fx', node: node || 'n1', rules: rules, why: 'w', close: 'c' }];
      expect(gate.analyzeNoteResidue(dir, book({ 'bold-pair': 2 }), CAP_FOR_FIXTURE).problems).toEqual([]);   // 恰好对上 ⇒ 绿
      // ① 已偿未销账
      const paid = gate.analyzeNoteResidue(dir, book({ 'bold-pair': 2, 'code-span': 1 }), CAP_FOR_FIXTURE).problems;
      expect(paid.map((p) => p.kind)).toEqual(['ledger']);
      expect(paid[0].msg).toContain('已偿');
      // ② 处数偏大（部分修好没改册）
      const less = gate.analyzeNoteResidue(dir, book({ 'bold-pair': 5 }), CAP_FOR_FIXTURE).problems;
      expect(less.map((p) => p.kind)).toEqual(['ledger']);
      expect(less[0].msg).toContain('偏大');
      // ③ 处数变多 ⇒ 是**新增残留**，不许用旧条目吞
      const more = gate.analyzeNoteResidue(dir, book({ 'bold-pair': 1 }), CAP_FOR_FIXTURE).problems;
      expect(more.map((p) => p.kind)).toEqual(['note-residue']);
      expect(more[0].msg).toContain('比在册的多');
      // ④ 悬挂登记（册上的节点在数据里已不存在）
      const dangling = gate.analyzeNoteResidue(dir, book({ 'bold-pair': 2 }, 'n-gone'), CAP_FOR_FIXTURE).problems;
      expect(dangling.map((p) => p.kind)).toContain('ledger');
      expect(dangling.map((p) => p.msg).join('\n')).toContain('悬挂');
    });
  });

  it('扫描根不存在 ⇒ **采不到真值 = 红**（`A5`，不许静默当绿）', () => {
    const res = gate.analyzeNoteResidue(path.join(ROOT, '.review', '不存在的扫描根-zz'), null);
    expect(res.problems.length).toBe(1);
    expect(res.problems[0].msg).toContain('采不到真值');
  });

  it('读不出的项目文件 ⇒ **未验证档**：打印、不参与计数、不阻断（`A5` 第三条路）', () => {
    withFixture({ 'fx': proj([{ id: 'n1', detail: '<p>干净</p>' }]) }, (dir) => {
      fsx.mkdirSync(path.join(dir, 'broken'), { recursive: true });
      fsx.writeFileSync(path.join(dir, 'broken', 'broken.json'), '{ 这不是 JSON', 'utf8');
      const res = gate.analyzeNoteResidue(dir, null);
      expect(res.problems).toEqual([]);                       // 不阻断
      expect(res.readings.unverified).toBe(1);                 // 但**出现在读数里**
      expect(res.readings.unverifiedFiles[0]).toContain('broken');
      expect(res.readings.projects).toBe(1);                   // 不参与计数
      expect(res.notes.join('\n')).toContain('未验证 1 个');
    });
  });
});

/* ============================================================
 * ⑥ 的第 6 条规则 `tag-in-code`：**「标记已经被转换器吃掉」的痕迹**
 * ------------------------------------------------------------
 * 为什么加它（第 2 次实证，两次都有现场）：
 *   ①–⑤ 抓的是**源头的标记**（`**` / 反引号 / 围栏 / `[]()` / 行首 `#`）；
 *   `*` 被 `markdownToHtml` 吃成 `<em>` 之后**形状完全合法** ⇒ 以前任何门禁都抓不到。
 *   现场一：批 `b3a53636`，`2R*8` → `2R<em>8</em>`（人工发现改成 `2R×8`）；
 *   现场二：批 `02d26501`，`<code>linux-netfilter-tc-<em></code>` 与 `<code>qos-</em></code>`
 *   —— 两个通配 `*` 跨 code 边界配对，把 `<code>` 劈成两半。该批原话：「该坏字任何门禁都抓不到」。
 * 完整注入证明（%TEMP% 副本 + 原始 Buffer 逐字节还原 + 三记）见
 *   `.review/20261020-S2-tag-in-code/proof/`（基线绿 / 两注入必红 / 两对照必绿）。
 * ============================================================ */
describe('S2 ⑥ 第 6 条 `tag-in-code`：强调标签跑进代码区（窄判据）', () => {
  const hitsOf = (html) => gate.scanDetailResidue(html).hits;
  const failOf = (html) => hitsOf(html).filter((h) => h.tier === 'fail');
  const reportOf = (html) => hitsOf(html).filter((h) => h.tier === 'report');

  it('**四种形状全判红**：开闭都在里 / 开在里闭在外 / 开在外闭在里 / 只开没闭', () => {
    // ① 全长在里（`<code>siginfo_t*, void*</code>` 那一类：两个指针星号在同一 code 区内配对）
    expect(failOf('<p><code>handler(int, siginfo_t<em>, void</em>)</code></p>').map((h) => h.rule))
      .toEqual(['tag-in-code', 'tag-in-code']);
    // ② 开在里、闭在外（`02d26501` 现场的一半）
    expect(failOf('<p><code>linux-netfilter-tc-<em></code> 与 <code>qos-</em></code></p>')
      .map((h) => h.rule)).toEqual(['tag-in-code', 'tag-in-code']);
    // ③ 开在外、闭在里（同一现场的另一半；也覆盖"`<strong>` 只开没闭"）
    expect(failOf('<p><code>qos-</em></code></p>').map((h) => h.rule)).toEqual(['tag-in-code']);
    expect(failOf('<p>扫 <code>fixtures/<strong></code> 一字未动</p>').map((h) => h.rule)).toEqual(['tag-in-code']);
    // ④ `<pre>` 与 `<code>` 同权：`<pre>` 里的内容也是字面代码
    expect(failOf('<pre>grep -r x <em>' + '</pre>').map((h) => h.rule)).toEqual(['tag-in-code']);
  });

  it('**不假红（主边界）**：正文里的 `<em>` / `<strong>` 永不判红 —— 全库实测 13,700 处', () => {
    expect(failOf('<p>正文里的 <em>强调</em> 与 <strong>加粗</strong> 都合法</p>')).toEqual([]);
    // 强调**包在 code 外面**是合法写法（要强调一段代码就这么写）⇒ 必须绿
    expect(failOf('<p><em><code>rm -rf x</code></em></p>')).toEqual([]);
    expect(failOf('<p><strong><code>make</code></strong></p>')).toEqual([]);
  });

  it('**不假红（第二条边界）**：代码区里的 `*` 是字面量（上一批实测的"跳过档"）', () => {
    // 真实现场里的合法写法：指针 / 通配 / 乘号放在 <code> 里，没有 <em>
    expect(failOf('<p>结构体 <code>struct Qdisc *q</code> 是字面指针</p>')).toEqual([]);
    expect(failOf('<p>扫 <code>src/*.js</code> 的 require（通配是字面量）</p>')).toEqual([]);
    expect(failOf('<p>算一下 <code>8*4096</code></p>')).toEqual([]);
  });

  it('**`&lt;em&gt;` 转义后的字面量不算标签**（这是"代码里本来就有尖括号"的边界）', () => {
    expect(failOf('<p><code>&lt;em&gt;标签&lt;/em&gt; 是字面量</code></p>')).toEqual([]);
    expect(failOf('<p><code>if (a &lt; b &amp;&amp; c &gt; d) x()</code></p>')).toEqual([]);
  });

  it('**多个 `<code>` 逐个配对，绝不把 A 的开标签和 B 的闭标签配成一对**', () => {
    // A 段里成对、B 段干净 ⇒ 只报 A 段那 2 处，B 段的 `<em>` 前面的闭标签不能被算给 A
    const html = '<p><code>a <em>b</em></code> · <code>c</code> · <em>正文强调</em></p>';
    const h = failOf(html);
    expect(h.length).toBe(2);
    expect(h.map((x) => x.rule)).toEqual(['tag-in-code', 'tag-in-code']);
    // 两处都必须落在 A 段（列号 < A 段结束的位置），不许窜到正文那个 `<em>` 上
    expect(h.every((x) => x.col < 34)).toBe(true);
  });

  it('只报告档：代码区里的 `<b>` / `<i>` / `<span>`… —— 转换器不产这些，推不出来源 ⇒ 不判红', () => {
    expect(failOf('<p><code><b>x</b></code></p>')).toEqual([]);
    expect(reportOf('<p><code><b>x</b></code></p>').map((h) => h.rule))
      .toEqual(['other-inline-in-code', 'other-inline-in-code']);
    expect(reportOf('<p><code><span class="k">int</span></code></p>').map((h) => h.rule))
      .toEqual(['other-inline-in-code', 'other-inline-in-code']);
    // 放行理由必须写在判据表里（`B8`：只报告档要能打印为什么放行）
    const rule = gate.NOTE_RESIDUE_RULES.find((x) => x.id === 'other-inline-in-code');
    expect(rule.tier).toBe('report');
    expect(rule.why).toContain('转换器');
  });

  it('跳过档**逐项计数**：正文强调的处数单独统计（不许把"没判"说成"过了"）', () => {
    const r = gate.scanDetailResidue('<p><em>a</em> <strong>b</strong> 与 <code>struct X *p</code></p>');
    expect(r.hits).toEqual([]);
    // 按**开标签**计 = 强调元素的个数（`<em>a</em>` 只算 1 处，不是 2 个标签）；放行但**计数**
    expect(r.masked.emphasisOutside).toBe(2);
    expect(r.masked.codeOpens).toBe(1);                // 1 个代码区被逐段扫过
    // 注释里的不算（等长抹掉 ⇒ 行列号不漂，这也是既有口径）
    const c = gate.scanDetailResidue('<p>x</p><!-- <code>a <em>b</em></code> -->');
    expect(c.hits).toEqual([]);
    expect(c.masked.emphasisOutside).toBe(0);
  });

  it('同一输入两次结果一致（纯函数，没有隐藏状态）', () => {
    const html = '<p><code>a <em>b</code> <em>正文</em></p>';
    expect(JSON.stringify(gate.scanDetailResidue(html).hits))
      .toBe(JSON.stringify(gate.scanDetailResidue(html).hits));
  });

  it('判据表：第 6 条在册、是判红档、且**只认两个强调标签**（窄在哪要能读出来）', () => {
    const rule = gate.NOTE_RESIDUE_RULES.find((x) => x.id === 'tag-in-code');
    expect(rule, '判据表里没有 tag-in-code').toBeTruthy();
    expect(rule.tier).toBe('fail');
    expect(rule.why).toContain('<code>');              // 理由里必须点明"代码区里没有强调的正当用途"
    expect([...gate.NOTE_EMPHASIS_TAGS].sort()).toEqual(['em', 'strong']);   // 只有转换器会产的这两个
    expect([...gate.NOTE_CODE_TAGS].sort()).toEqual(['code', 'pre']);
    // 「见 `<em>` 就红」是**刻意不做**的：判红色标签集合里不许混进 `<b>` / `<i>` / `<span>`
    [...gate.NOTE_OTHER_INLINE_TAGS].forEach((t) => expect(gate.NOTE_EMPHASIS_TAGS.has(t)).toBe(false));
  });

  it('读数契约：`masked` 里新增的两个计数不许缺（闸门输出会打印它们）', () => {
    const r = gate.scanDetailResidue('<p><code>a</code><em>b</em></p>');
    expect(r.masked).toHaveProperty('codeOpens');
    expect(r.masked).toHaveProperty('emphasisOutside');
    expect(r.masked).toHaveProperty('pre');
    expect(r.masked).toHaveProperty('code');
    expect(r.masked).toHaveProperty('comment');
  });
});

/* ------------------------------------------------------------
 * 转换器 ↔ 门禁的**闭环**（2026-10-20 根治后补，批 `markdown-star-rootfix`）
 * ------------------------------------------------------------
 * `tag-in-code` 抓的是「`*` 已经被 `markdownToHtml` 吃掉」的产物。这条闭环把两端接上：
 *   **凡转换器自己产出的 detail，喂回 `tag-in-code` 必须零命中** —— 代码区里的 `*` 一个都不许丢。
 * 判别力：把 `src/convert.js` 里 `inline()` 的占位保护去掉 ⇒ 本块必红
 *   （实测产物 `<code>src/<em>.js</code>` / `<code>siginfo_t<em>, void</em></code>` 正是存量那 16 处的形状）。
 * ============================================================ */
describe('转换器产物 × 第 6 条 `tag-in-code`：闭环（新写的数据不许再被判红）', () => {
  const convert = require('../src/convert.js');

  it('含 `*` 的代码区经 markdownToHtml 之后，`tag-in-code` 零命中', () => {
    const mds = [
      '`src/*.js` 与 `lib/*.js`',
      '`handler(int, siginfo_t*, void*)`',
      '`linux-netfilter-tc-*` 与 `qos-*`',
      '## 标题 `src/*.js` 与 `lib/*.js`\n\n- 项 `a*b*c`'
    ];
    for (const md of mds) {
      const html = convert.markdownToHtml(md);
      expect(html).not.toContain('<em>');                      // 一个 `*` 都没被吃
      expect(gate.scanDetailResidue(html).hits, '「' + md + '」⇒ ' + html).toEqual([]);
    }
  });

  it('混写的字面 `<code>` 按契约被转义成**字面文本** ⇒ `*` 一个不少，且判红档零命中', () => {
    const html = convert.markdownToHtml('<code>handler(int, siginfo_t*, void*)</code>');
    expect(html).toBe('<p>&lt;code&gt;handler(int, siginfo_t*, void*)&lt;/code&gt;</p>');
    const r = gate.scanDetailResidue(html);
    expect(r.hits.filter((h) => h.tier === 'fail')).toEqual([]);   // 一个 `<em>`/`<strong>` 都不产
    // 但**如实记一笔**：转义之后那段 `*…*` 落入正文，与真强调同形 ⇒ 门禁只能在**只报告档**点名它
    expect(r.hits.map((h) => h.rule)).toEqual(['italic-pair']);
  });

  it('正文强调仍然照常产出 `<em>`（门禁只判"代码区里"，不会因此假红）', () => {
    const html = convert.markdownToHtml('正文 **粗** 与 `src/*.js` 与 *斜*');
    expect(html).toBe('<p>正文 <strong>粗</strong> 与 <code>src/*.js</code> 与 <em>斜</em></p>');
    const r = gate.scanDetailResidue(html);
    expect(r.hits).toEqual([]);
    expect(r.masked.emphasisOutside).toBe(2);                  // 正文 2 个强调元素被计数放行
  });
});

describe('S2 ⑥ 第 6 条 `tag-in-code`：判别力（临时夹具，真仓 projects/ 一个字节不动）', () => {
  const os = require('node:os');
  const fsx = require('node:fs');
  const proj = (nodes) => ({ version: 3, data: { id: 'root', topic: 'r', children: nodes } });

  function withFixture(files, fn) {
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'mm-note-residue-tag-'));
    try {
      Object.keys(files).forEach((name) => {
        fsx.mkdirSync(path.join(dir, name), { recursive: true });
        fsx.writeFileSync(path.join(dir, name, name + '.json'), JSON.stringify(files[name]), 'utf8');
      });
      return fn(dir);
    } finally {
      fsx.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('注入 `<code>…-<em></code>` ⇒ **必红**并点名项目 / 节点 / 规则 / 片段（两个现场都要红）', () => {
    withFixture({ fx: proj([{ id: 'n1', topic: 't', detail: '<p>干净</p>' }]) }, (dir) => {
      expect(gate.analyzeNoteResidue(dir, null).problems).toEqual([]);
      fsx.writeFileSync(path.join(dir, 'fx', 'fx.json'),
        JSON.stringify(proj([{ id: 'n1', topic: 't',
          detail: '<p><code>linux-netfilter-tc-<em></code> 与 <code>qos-</em></code></p>' }])), 'utf8');
      const bad = gate.analyzeNoteResidue(dir, null).problems;
      expect(bad.length).toBe(2);                     // 开标签、闭标签各一处
      bad.forEach((p) => {
        expect(p.kind).toBe('note-residue');
        expect(p.msg).toContain('`fx`');              // 项目
        expect(p.msg).toContain('n1');                // 节点
        expect(p.msg).toContain('tag-in-code');       // 规则名
        expect(p.msg).toContain('--detail-md');       // 必须给出唯一修法
      });
      expect(bad[0].msg).toContain('linux-netfilter-tc-<em>');   // 片段（能直接定位）
      expect(bad[1].msg).toContain('qos-</em>');
    });
  });

  it('同一份夹具里写 `<code>struct Qdisc *q</code>` 与正文 `<em>强调</em>` ⇒ **读数一个字不变**', () => {
    const clean = '<p>结构体 <code>struct Qdisc *q</code> 与正文 <em>强调</em></p>';
    withFixture({ fx: proj([{ id: 'n1', topic: 't', detail: clean }]) }, (dir) => {
      const res = gate.analyzeNoteResidue(dir, null);
      expect(res.problems).toEqual([]);
      expect(res.readings.failHits).toBe(0);
      expect(res.readings.reportHits).toBe(0);
      expect(res.readings.inCodeFail).toBe(0);
      // 跳过档的读数**必须照样报出来**（放行也要有数）
      expect(res.readings.masked.codeOpens).toBe(1);
      expect(res.readings.masked.emphasisOutside).toBe(1);     // 按开标签计：1 个强调元素
      expect(res.notes.join('\n')).toContain('命中强调标签 0 处');
    });
  });
});
