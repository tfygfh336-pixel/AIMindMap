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

  it('真仓库：MCP 派发到的 45 条命令**全部**能在 registry 里找到（现状就是绿的）', () => {
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

  it('真仓库：37 个冒烟域**全部**登记在入口索引里（存量 11 处已补）', () => {
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
    expect(declared.slice().sort()).toEqual(gate.CHECKS.slice().sort());
  });

  it('每一个"改动类型"至少写一处连带（空行 = 一张没用的表）', () => {
    gate.COLLATERAL.forEach((row) => expect(row.places.length, row.when).toBeGreaterThan(0));
  });

  it('真仓库整体：**上线就是绿的**（甲档：存量已补齐；挂链后这条应全绿）', () => {
    const r = gate.analyze();
    expect(r.problems).toEqual([]);
  });
});
