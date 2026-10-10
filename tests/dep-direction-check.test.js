/* ============================================================
 * tests/dep-direction-check.test.js — 单向依赖门禁（S1）的契约 + **判别力**
 * 运行：npx vitest run tests/dep-direction-check.test.js
 * ------------------------------------------------------------
 * 为什么这些用例长这样（三条都是本工程的老教训）：
 *   ① **门禁本身必须可被单测 require**：末尾无条件执行 `main()` 的门禁一 require 就跑主流程
 *      ⇒ 判定逻辑永远没法单测（实测过一次：require 7189 ms → 12 ms）。这里把守卫钉住 ✓。
 *   ② **输入必须是"代码"，不是散文**：`src/history.js` 的文件头注释里真写着
 *      `require('./history.js')`（用法示例）。不剥注释，门禁就会凭空造一条**自指边**（假红）——
 *      而过严的门禁下场是被关掉。反过来，把判据只写在注释里也骗不过本门禁（skill `B4` 成因②）。
 *   ③ **判别力**：真仓库那一跳也测（下面 `analyze()` 的用例只在**内存里**给文件注入一条反向
 *      require，不落盘 ✗）——"新门禁先证明它会红"这条纪律的可重复版本 ✓。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/dep-direction-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'dep-direction-check.js'), 'utf8');

describe('S1 门禁自身：可被单测引入（零副作用）', () => {
  it('require 之后拿到纯函数，且源码末尾有 require.main 守卫', () => {
    expect(typeof gate.parseEdges).toBe('function');
    expect(typeof gate.findReverseEdges).toBe('function');
    expect(typeof gate.findCycles).toBe('function');
    expect(typeof gate.layerOf).toBe('function');
    expect(gateSrc).toMatch(/if \(require\.main === module\) main\(\);/);
  });

  it('纯函数：同一输入两次结果一致（不打印、不退出）', () => {
    const src = "const a = require('./b.js');\n";
    expect(JSON.stringify(gate.parseEdges(src))).toBe(JSON.stringify(gate.parseEdges(src)));
  });
});

describe('S1 取边：注释与字符串分开对待', () => {
  it('文件头注释里的 require **不算**边（本工程 src/history.js 就是这种形状）', () => {
    const src = [
      '/**',
      " * 用法（Node）：const { UndoStack } = require('./history.js');",
      ' */',
      "const x = require('./convert.js');"
    ].join('\n');
    const edges = gate.parseEdges(src);
    expect(edges.map((e) => e.spec)).toEqual(['./convert.js']);
  });

  it('行注释与块注释里的 require 不算；字符串字面量里的路径**要**算', () => {
    const src = [
      "// require('./no.js')",
      "const s = './yes.js';   // 这是字符串，不是边",
      "const a = require('./yes.js');",
      "/* require('./also-no.js') */"
    ].join('\n');
    expect(gate.parseEdges(src).map((e) => e.spec)).toEqual(['./yes.js']);
  });

  it('import 形式也认；动态 require 单独计数（判不了方向，但要**可见**）', () => {
    const esm = gate.parseEdges("import { a } from './x.js';\n");
    expect(esm[0]).toMatchObject({ spec: './x.js', kind: 'import' });
    const dyn = gate.parseEdges("const f = require(path.join(__dirname, name));\n");
    expect(dyn[0].spec).toBe(null);
    expect(dyn[0].kind).toBe('dynamic');
  });
});

describe('S1 判定：方向、环、图外边', () => {
  it('反向边（src → renderer）必须被抓出，并带两端的层', () => {
    const bad = gate.findReverseEdges([
      { from: 'src/tree-utils.js', to: 'renderer/app-core.js', line: 12 },
      { from: 'cli/main.js', to: 'src/schema.js', line: 7 }
    ]);
    expect(bad.length).toBe(1);
    expect(bad[0].fromLayer.id).toBe('src');
    expect(bad[0].toLayer.id).toBe('renderer');
  });

  it('同层与朝下的边不判红（renderer→main→cli→src 是允许的方向）', () => {
    expect(gate.findReverseEdges([
      { from: 'renderer/app-view.js', to: 'main.js', line: 1 },
      { from: 'main.js', to: 'cli/main.js', line: 1 },
      { from: 'cli/core.js', to: 'src/data-store.js', line: 1 },
      { from: 'src/a.js', to: 'src/b.js', line: 1 }
    ])).toEqual([]);
  });

  it('同层成环要报出来（"依赖图里没有环"是 A-02 的另一半）', () => {
    const cycles = gate.findCycles([
      { from: 'src/a.js', to: 'src/b.js', line: 1 },
      { from: 'src/b.js', to: 'src/a.js', line: 1 }
    ]);
    expect(cycles.length).toBe(1);
    expect(cycles[0][0]).toBe(cycles[0][cycles[0].length - 1]);
  });

  it('指向"分层图之外"的依赖：在册豁免之外一律判红（谁都得有个家）', () => {
    const un = gate.findUnownedTargets([
      { from: 'scripts/x.js', to: 'tests/pdf-fixture.js', line: 1 },
      { from: 'cli/main.js', to: 'package.json', line: 1 },
      { from: 'src/a.js', to: 'somewhere/else.js', line: 3 }
    ], gate.EXEMPT_TARGETS);
    expect(un.length).toBe(1);
    expect(un[0].to).toBe('somewhere/else.js');
  });

  it('分层图自己：rank 越大越靠上，且每层都有名字（改图只改这一处）', () => {
    const ranks = gate.LAYERS.map((l) => l.rank);
    expect(Math.max(...ranks)).toBeGreaterThan(Math.min(...ranks));
    gate.LAYERS.forEach((l) => { expect(l.name.length).toBeGreaterThan(0); expect(l.re).toBeInstanceOf(RegExp); });
    expect(gate.LAYERS.filter((l) => l.id === 'scripts')[0].rank).toBe(gate.LAYERS.filter((l) => l.id === 'main')[0].rank);
  });
});

describe('S1 判别力：真仓库这一跳（**只在内存里注入，不落盘**）', () => {
  it('真实工程现在就是绿的：零反向边、零环、零图外边', () => {
    const r = gate.analyze();
    expect(r.reverse).toEqual([]);
    expect(r.cycles).toEqual([]);
    expect(r.unowned).toEqual([]);
    expect(r.edges.length).toBeGreaterThan(50);
  });

  it('同样的判定换个输入（一条 src → renderer 的反向 require）⇒ 必红', () => {
    const bad = gate.findReverseEdges([
      { from: 'src/tree-utils.js', to: 'renderer/app-core.js', line: 1 }
    ]);
    expect(bad.length).toBe(1);
    expect(bad[0].fromLayer.id).toBe('src');
    expect(bad[0].toLayer.id).toBe('renderer');
  });

  it('扫的是工程真源码：`src/` 里每个文件的相对边都能解析成图内的目标', () => {
    const r = gate.analyze();
    const srcEdges = r.edges.filter((e) => e.from.startsWith('src/'));
    expect(srcEdges.length).toBeGreaterThan(10);
    srcEdges.forEach((e) => expect(gate.layerOf(e.to)).not.toBe(null));
  });
});
