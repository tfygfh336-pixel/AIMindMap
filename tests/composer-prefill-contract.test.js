/* ============================================================
 * tests/composer-prefill-contract.test.js — ⑨ **写入侧**的契约（COMPOSER_PREFILL_JS）
 * ------------------------------------------------------------
 * 为什么要有这个文件：`main-dsh-sidebar.js` 的 `COMPOSER_PREFILL_JS` 是**注入到 DSH 页面里
 * 执行的源码字符串** ⇒ 它既不进 `src/`、也无法在 node 里直接跑（要 DOM + 真编辑器）。
 * 于是就出现了一个真空地带：改坏了它，vitest 全绿、只有真机上才看得见（本工程已发生过：
 * 2026-10-40 用户截图里 `@` 前缀重复 / 标题粘连 / 叠三份，而当时所有断言都是绿的）。
 *
 * 本文件能证明的（**只有这些，别多算**）：
 *   ① 注入串**语法合法**（new Function 能编译）—— 这已经是真机上"页面执行失败"的常见死因；
 *   ② 三条不变量**在实现里存在**：逐行 insertText、行间 insertParagraph、
 *      清空走 selectAll → **等一帧** → delete；判据同时含 `copies===1` / 行数 / 无 `@`；
 *   ③ **判别力**：把任一条从实现里摘掉（源码级变异），本文件的判据必须红。
 * 本文件**不能**证明的：真 Lexical 到底怎么吃 `@` 与 `\n`、`selectAll` 在真机上是否生效
 *   ⇒ 那只能由用户重启应用后拖一次（见 `.review/20261040-@触发与换行/` 报告）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SIDEBAR = readFileSync(path.join(ROOT, 'main-dsh-sidebar.js'), 'utf8');
const require = createRequire(import.meta.url);
const sc = require('../src/sidebar-context.js');

/** 从 `main-dsh-sidebar.js` 里把模板字面量**按真值**取出来。
 *  ⚠️ 必须过一遍 eval：源码里写的是 `\\n`，模板求值后才是注入到页面里的 `\n`。
 *  用正则或直接切原文去断言，检的就不是真跑的那一份（差一个反斜杠，判据全跑偏）。 */
function prefillTemplate() {
  const START = 'const COMPOSER_PREFILL_JS = `';
  const s = SIDEBAR.indexOf(START);
  expect(s, 'main-dsh-sidebar.js 里找不到 COMPOSER_PREFILL_JS').toBeGreaterThan(-1);
  const bodyStart = s + START.length;
  const e = SIDEBAR.indexOf('`;', bodyStart);
  expect(e, 'COMPOSER_PREFILL_JS 的模板字面量没有收尾（体里混进了反引号？）').toBeGreaterThan(bodyStart);
  return SIDEBAR.slice(bodyStart, e);
}

const TEMPLATE = prefillTemplate();
// eslint-disable-next-line no-eval
const CODE = eval('`' + TEMPLATE + '`');

describe('⑨ 写入侧契约：逐行 + 换行 + 替换（源码级判据）', () => {
  it('注入串必须是**合法 JS**（语法错 = 真机上"页面执行失败"，而 vitest 抓不到）', () => {
    expect(CODE.indexOf('(async function (text)')).toBe(0);
    // 必须在 async 函数里：清空后要等一帧（`await`）
    expect(CODE).toContain('await frame()');
    expect(() => new Function('return ' + CODE)).not.toThrow();
  });

  it('**逐行**写入：每行一次 insertText，行间 insertParagraph（一次灌整段是被禁的）', () => {
    expect(CODE, '没有逐行循环').toMatch(/for \(var li = 0; li < wantLines\.length; li\+\+\)/);
    expect(CODE, '没有按行取文本').toContain('insertLine(wantLines[li])');
    expect(CODE, '行间没有 insertParagraph').toContain("execCommand('insertParagraph'");
    /* 负判据：整段一次 insertText 就是上一版的写法（真机上换行不成分段） */
    const ONE_SHOT = /execCommand\('insertText', false, (?:ALL|text)\)/;
    expect(ONE_SHOT.test(CODE), '又出现"一次 insertText 灌整段"了（换行不会成分段）').toBe(false);
    /* ★ 判别力：把逐行循环换成一次灌整段 ⇒ 上面那条负判据必须命中 */
    const mutated = CODE.replace(/for \(var li = 0; li < wantLines\.length; li\+\+\) \{[\s\S]*?\n    \}/,
      "execCommand('insertText', false, ALL);");
    expect(mutated, '变异没落地 ⇒ 这条判据是空转的').not.toBe(CODE);
    expect(ONE_SHOT.test(mutated)).toBe(true);
  });

  it('**替换**语义：清空走 selectAll → delete，而且 delete 之前要**等一帧**', () => {
    expect(CODE).toContain('clearDraft');
    expect(CODE, '清空没用 delete 命令').toContain("execCommand('delete'");
    expect(CODE, '清空没有"全选"').toContain("execCommand('selectAll'");
    /* 顺序与"等一帧"：selectAll → frame → delete（Lexical 的模型选区是 selectionchange 异步同步的） */
    const iSel = CODE.indexOf("steps.push('selectAll:' + how)");
    const iFrame = CODE.indexOf('await frame();', iSel);
    const iDel = CODE.indexOf("steps.push('delete:' + del)", iSel);
    expect(iSel, '找不到 selectAll 那一步').toBeGreaterThan(-1);
    expect(iDel, '找不到 delete 那一步').toBeGreaterThan(iSel);
    expect(iFrame, 'selectAll 与 delete 之间没有等一帧 ⇒ 真机上会退化成追加').toBeGreaterThan(iSel);
    expect(iFrame).toBeLessThan(iDel);
    expect(CODE, '清空之后没有回读确认').toContain("if (!norm(readBack()))");
    /* ★ 判别力：把"等一帧"删掉（上一版的写法）⇒ 这条判据必须红 */
    const mutated = CODE.replace('      await frame();\n      var del = false;', '      var del = false;');
    expect(mutated, '变异没落地 ⇒ 这条判据是空转的').not.toBe(CODE);
    expect(mutated.indexOf('await frame();', mutated.indexOf("steps.push('selectAll:' + how)")))
      .toBeGreaterThan(mutated.indexOf("steps.push('delete:' + del)"));
  });

  it('判据不是恒真：`ok` 必须同时含 逐字相等 / copies===1 / 行数 / 无 @', () => {
    const JUDGE = 'var ok = verbatim && copies === 1 && linesOk && noAt;';
    expect(CODE).toContain(JUDGE);
    expect(CODE, '回读与原文比对不在判据里').toContain('same(readBack(), text)');
    expect(CODE.split(JUDGE).length - 1, '判据串出现了多份（第二份副本会漂）').toBe(1);
    /* ★ 判别力：摘掉行数/无 @ 那一项 ⇒ 判据串不再成立 */
    const mutated = CODE.replace(' && linesOk && noAt', '');
    expect(mutated).not.toContain(JUDGE);
    expect(mutated).toContain('var ok = verbatim && copies === 1;');
  });

  it('分档齐全：not-found / focus-failed / readback-mismatch / rejected / duplicated / **mangled**', () => {
    for (const b of ['not-found', 'focus-failed', 'readback-mismatch', 'rejected', 'duplicated', 'mangled']) {
      expect(CODE, '缺失败分档 ' + b).toContain(b);
    }
    /* mangled 的两种成因都要在判据里：行数不符（标题粘连）与 @ 冒出来 */
    expect(CODE).toContain('!linesOk || !noAt');
    /* mangled 的原因必须贴回读前 80 字（用户能把状态栏原话贴回来） */
    expect(CODE).toMatch(/回读前 80 字/);
  });

  it('`@` 的第二道闸：含 `@` 的文案 ⇒ mangled + **一个字都不写**', () => {
    expect(CODE, '没有 @ 的拒绝闸').toContain("ALL.indexOf('@') >= 0");
    const guard = CODE.slice(CODE.indexOf("ALL.indexOf('@')"), CODE.indexOf('var SEL ='));
    expect(guard.length, '找不到拒绝闸到选器之间那一段').toBeGreaterThan(80);
    expect(guard, '拒绝时要报 mangled').toContain("bucket: 'mangled'");
    expect(guard, '拒绝时不许做任何写操作（steps 只有一条 refused）').toContain("steps: ['refused:at-char']");
    expect(guard, '拒绝闸里不许出现任何写入命令').not.toContain('execCommand');
    /* ★ 判别力：把这道闸摘掉 ⇒ 上面那条 contains 立刻不成立 */
    expect(CODE.replace("ALL.indexOf('@') >= 0", 'false')).not.toContain("ALL.indexOf('@') >= 0");
  });

  it('接线：产品文案（src/sidebar-context.js）喂进来时，行数 == 节点数、且没有 @', () => {
    const nodes = [{ topic: '全书概览与使用说明' }, { topic: '第一章 无线网络导论' }];
    const text = sc.buildSidebarText('book-80211-guide', nodes);
    expect(text.indexOf('@')).toBe(-1);
    const lines = text.split('\n');
    expect(lines.length).toBe(nodes.length);                 // 2 个节点 ⇒ 恰好 2 行
    expect(lines.every((ln) => sc.isSafeUnit(ln))).toBe(true);
    /* 注入串那一侧用的就是这个切法（CODE 已求值 ⇒ 这里要的是真换行的转义写法） */
    expect(CODE).toContain("var wantLines = ALL.split('\\n');");
    expect(CODE, '行数判据里也要按换行切').toContain("return t.split('\\n').length;");
  });
});
