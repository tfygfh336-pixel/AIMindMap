/* ============================================================
 * tests/smoke-state-check.test.js — 冒烟"域内自收尾"门禁（V2）的契约 + **判别力**
 * 运行：npx vitest run tests/smoke-state-check.test.js
 * ------------------------------------------------------------
 * 为什么这些用例长这样（三条都是本工程的老教训）：
 *   ① **门禁本身必须可被单测 require**：末尾无条件执行 `main()` 的门禁，一 require 就跑主流程
 *      ⇒ 判定逻辑永远没法单测（本工程实测过一次：require 7189 ms → 12 ms）。这里把守卫钉住 ✓。
 *   ② **判别力留在测试里，而不只是写在交付说明里**：下面有一条用例直接把**真实仓库里那条合规断言**
 *      的 `closeDialogs` 抹掉（只在内存里抹，不落盘 ✗），断言门禁**必须红** —— 这是"新门禁先证明
 *      它会红"那条纪律的可重复版本 ✓。
 *   ③ **防假红**：域内"接力"（后面的断言读前一条留下的画面）是**常态**，不能判红 ——
 *      判红的只有"**域跑完时还有东西开着**"这一种。本工程有过真实教训：一条过严的门禁
 *      会被人直接关掉，那等于没有 ✗。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gate = require('../scripts/smoke-state-check.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke-state-check.js'), 'utf8');

/** 造一个冒烟域文件（形状与真实断言一致：module.exports = [{ name, run }]） */
function fixture(assertions) {
  const lines = ['module.exports = ['];
  assertions.forEach((a) => {
    lines.push('  {');
    lines.push("    name: '" + a.name + "',");
    lines.push('    run: async (ctx) => {');
    a.body.forEach((b) => lines.push('      ' + b));
    lines.push('    }');
    lines.push('  },');
  });
  lines.push('];');
  return lines.join('\n') + '\n';
}

describe('V2 门禁自身：可被单测引入（零副作用）', () => {
  it('require 之后拿到纯函数，且源码末尾有 require.main 守卫', () => {
    expect(typeof gate.analyzeSource).toBe('function');
    expect(typeof gate.segmentAssertions).toBe('function');
    expect(typeof gate.scanAll).toBe('function');
    expect(gateSrc).toMatch(/if \(require\.main === module\) main\(\);/);
  });

  it('分析函数是纯函数：同一输入两次结果一致（不打印、不退出）', () => {
    const src = fixture([{ name: '甲', body: ["app.addNode('root');"] }]);
    const a = gate.analyzeSource(src);
    const b = gate.analyzeSource(src);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBe(1);
  });
});

describe('V2 判定口径：域末必须干净；域内接力允许；豁免要有原因', () => {
  it('★ 开了模态却不给收尾 ⇒ 判红，且报出"开了什么"', () => {
    const src = fixture([{ name: '开了就不管', body: ["app.addNode('overview');", 'return { ok: true };'] }]);
    const p = gate.analyzeSource(src);
    expect(p.length).toBe(1);
    expect(p[0].seg).toBe('开了就不管');
    expect(p[0].opens.join(' ')).toContain('addNode');
  });

  it('★ 域内接力**不**判红：前一条开、后一条关（域末是干净的）', () => {
    const src = fixture([
      { name: '第一步：打开面板', body: ['await app.openAudit();', 'return { ok: true };'] },
      { name: '第二步：读数', body: ['var t = document.body.textContent;', 'return { ok: true };'] },
      { name: '第三步：关掉它', body: ['await mm.closeDialogs(ctx);', 'return { ok: true };'] }
    ]);
    expect(gate.analyzeSource(src)).toEqual([]);
  });

  it('★ 域内接力但**没有**人收尾 ⇒ 判红（这正是当年漏掉的那种）', () => {
    const src = fixture([
      { name: '第一步：打开面板', body: ['await app.openAudit();'] },
      { name: '第二步：读数', body: ['var t = document.body.textContent;'] }
    ]);
    const p = gate.analyzeSource(src);
    expect(p.length).toBe(1);
    expect(p[0].seg).toBe('第一步：打开面板');
  });

  it('收尾在**中间**、之后又开了一次 ⇒ 仍判红（"后来那次没关"）', () => {
    const src = fixture([
      { name: '甲', body: ['window.MMApp.addNode("root");', 'await mm.closeDialogs(ctx);'] },
      { name: '乙', body: ['window.MM.openFilePreview(node, rel);'] }
    ]);
    const p = gate.analyzeSource(src);
    expect(p.length).toBe(1);
    expect(p[0].opens.join(' ')).toContain('openFilePreview');
  });

  it('产品自己的关闭口也算收尾（`MM.closeFilePreview` / 点 `#fp-close` / 点 `#edit-cancel`）', () => {
    expect(gate.analyzeSource(fixture([{ name: '甲', body: ['window.MM.openFilePreview(n, r);', 'window.MM.closeFilePreview();'] }]))).toEqual([]);
    expect(gate.analyzeSource(fixture([{ name: '甲', body: ['window.MM.openFilePreview(n, r);', 'document.querySelector("#fp-close").click();'] }]))).toEqual([]);
    expect(gate.analyzeSource(fixture([{ name: '甲', body: ["window.MMApp.addNode('root');", 'document.getElementById("edit-cancel").click();'] }]))).toEqual([]);
  });

  it('显式豁免必须**带原因**（`收尾-豁免: <原因>`）；写空的豁免标记不算', () => {
    const ok = fixture([{ name: '甲', body: ['window.MM.openLightbox(src);', '// 收尾-豁免: 下一步就是断言灯箱本身，域末由乙关'] }]);
    expect(gate.analyzeSource(ok)).toEqual([]);
    const bad = fixture([{ name: '甲', body: ['window.MM.openLightbox(src);', '// 收尾-豁免:'] }]);
    expect(gate.analyzeSource(bad).length).toBe(1);
  });

  it('防假红：不开任何浮层的域一律不判（否则门禁会天天喊狼来了，下场是被关掉）', () => {
    const src = fixture([{ name: '纯数据断言', body: ['app.undo();', 'var n = app.getState().jm.mind.nodes;'] }]);
    expect(gate.analyzeSource(src)).toEqual([]);
  });

  it('段切分认得真实形状：每个 `name:` 起一段（含中文名与多行体）', () => {
    const src = fixture([
      { name: '甲（中文，带括号）', body: ['app.addNode("a");'] },
      { name: '乙', body: ['app.addNode("b");'] }
    ]);
    const segs = gate.segmentAssertions(src);
    expect(segs.length).toBe(2);
    expect(segs[0].name).toBe('甲（中文，带括号）');
    expect(segs[1].name).toBe('乙');
  });
});

describe('V2 判别力：真实仓库里那条合规断言被抹掉收尾 ⇒ 门禁必红', () => {
  it('从磁盘读 scripts/smoke/17-ui-polish.js，只在内存里抹掉 closeDialogs ⇒ 必红；原文件不动', () => {
    const rel = 'scripts/smoke/17-ui-polish.js';
    const abs = path.join(ROOT, rel);
    const src = fs.readFileSync(abs, 'utf8');
    expect(gate.analyzeSource(src)).toEqual([]);                  // 现在它是干净的
    const tampered = src.replace('await mm.closeDialogs(ctx)', 'const closed = { n: 0 }');
    expect(tampered).not.toBe(src);                               // 注入确实改到了东西（否则这条判据是空的）
    const p = gate.analyzeSource(tampered);
    expect(p.length).toBe(1);                                     // 必红
    expect(p[0].opens.join(' ')).toContain('openFilePreview');
    expect(fs.readFileSync(abs, 'utf8')).toBe(src);               // 磁盘未被改动（逐字节）
  });

  it('真实仓库当前合规（若谁再写了"开了不关"，npm test 同样变红）', () => {
    const bad = gate.scanAll().filter((r) => r.problems.length);
    expect(bad.map((b) => b.file)).toEqual([]);
  });
});
