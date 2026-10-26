/* ============================================================
 * tests/composer-prefill-contract.test.js — ⑨ **写入侧**的契约（COMPOSER_PREFILL_JS）
 * ------------------------------------------------------------
 * 为什么要有这个文件：`main-dsh-sidebar.js` 的 `COMPOSER_PREFILL_JS` 是**注入到 DSH 页面里
 * 执行的源码字符串** ⇒ 它既不进 `src/`、也无法在 node 里直接跑（要 DOM + 真编辑器）。
 * 于是就出现了一个真空地带：改坏了它，vitest 全绿、只有真机上才看得见（本工程已发生过：
 * 2026-10-40 用户截图里 `@` 前缀重复 / 标题粘连 / 叠三份，而当时所有断言都是绿的）。
 *
 * ── 2026-10-42 改口径（**替换 ⇒ 追加**；判据全重写，不是注释掉）────────────────────
 *   用户真机（逐字）：「是块了，但是我先拉了两个过去，然后又选了两个过去，就会覆盖掉第一次的两个」
 *   ⇒ 上一版拿「全选 → delete → 逐行插入」换幂等（"一次投喂恒等于一份"），那正是覆盖的病根。
 *   现在：**不清空**（负判据钉住）、光标移末尾再逐行写、判据换成
 *   「前缀没被动 ∧ 末尾恰好多了这一批 ∧ 这份只多了 1 份 ∧ 没冒出 @」，
 *   幂等改由 `seq` 去重（主进程台账）保证 —— 两者**不是一回事**，别再混成一件。
 *
 * 本文件能证明的（**只有这些，别多算**）：
 *   ① 注入串**语法合法**（new Function 能编译）—— 这已经是真机上"页面执行失败"的常见死因；
 *   ② **追加**的四条不变量在实现里存在（前缀 / 末尾 / 份数 +1 / 无 @），且**清空那一步确实没了**；
 *   ③ **判别力**：把任一条从实现里摘掉或把清空加回去（源码级变异），本文件的判据必须红。
 * 本文件**不能**证明的：真 Lexical 到底怎么吃 `@` 与 `\n`、`insertParagraph` 在真机上是否分段
 *   ⇒ 那由冒烟域 30（真 Chromium）与用户真机拖一次覆盖（见 `.review/20261042-追加语义/` 报告）。
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

/** 只留代码行（注释里提"上一版靠全选清空"是**要留着**的病因说明，不算违规）。 */
function codeOnly(text) {
  return String(text).split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');
}
const CODE_ONLY = codeOnly(CODE);

describe('⑨ 写入侧契约：追加（不是替换）+ 逐行 + 换行（源码级判据）', () => {
  it('注入串必须是**合法 JS**（语法错 = 真机上"页面执行失败"，而 vitest 抓不到）', () => {
    expect(CODE.indexOf('(async function (text)')).toBe(0);
    // 必须在 async 函数里：移光标之后要等一帧（`await`）
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
    const mutated = CODE.replace(/for \(var li = 0; li < wantLines\.length; li\+\+\) \{[\s\S]*?\n  \}/,
      "execCommand('insertText', false, ALL);");
    expect(mutated, '变异没落地 ⇒ 这条判据是空转的').not.toBe(CODE);
    expect(ONE_SHOT.test(mutated)).toBe(true);
  });

  it('**追加**语义：清空那一步**必须没有**（全选 / delete 一条都不许留），且写前先把光标移到末尾', () => {
    /* ★ 这是本批的核心负判据：上一版的"替换"就是靠这两条命令完成的 */
    expect(CODE_ONLY, '又出现 execCommand(selectAll) ⇒ 清空回来了（那会覆盖第一批）')
      .not.toContain("execCommand('selectAll'");
    expect(CODE_ONLY, '又出现 execCommand(delete) ⇒ 清空回来了（那会覆盖第一批）')
      .not.toContain("execCommand('delete'");
    expect(CODE, '没有"移到末尾"这一步').toContain('function caretToEnd(');
    expect(CODE, '写之前没有调用 caretToEnd').toContain('caret = caretToEnd();');
    /* 顺序：caretToEnd → 等一帧 → 读基线 → 写（Lexical 的模型选区是异步同步的） */
    const iCaret = CODE.indexOf('caret = caretToEnd();');
    const iFrame = CODE.indexOf('await frame();', iCaret);
    const iBase = CODE.indexOf('beforeN = norm(readBack());', iCaret);
    const iWrite = CODE.indexOf('insertLine(wantLines[li])', iCaret);
    expect(iFrame, '移光标之后没有等一帧 ⇒ 真机写到的还是旧光标处').toBeGreaterThan(iCaret);
    expect(iBase, '没有读"写前基线" ⇒ 追加判据无从成立').toBeGreaterThan(iFrame);
    expect(iWrite).toBeGreaterThan(iBase);
    /* 追加到**非空**框要先补一个分段，否则两批会粘成一行 */
    expect(CODE, '追加到非空框时没有补分段（两批会粘成一行）')
      .toContain("if (beforeN !== '') { sep = 'para:' + paraBreak(); await frame(); }");
    /* ★ 判别力：把"清空"注入回去 ⇒ 上面两条负判据必须红 */
    const mutated = CODE.replace('caret = caretToEnd();',
      "caret = caretToEnd(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);");
    expect(mutated).not.toBe(CODE);
    expect(codeOnly(mutated)).toContain("execCommand('selectAll'");
    expect(codeOnly(mutated)).toContain("execCommand('delete'");
  });

  it('判据不是恒真：`ok` 必须是「前缀 ∧ 末尾 ∧ 行数 ∧ 份数+1 ∧ 无 @」五样同时成立', () => {
    const JUDGE = 'var ok = prefixKept && addedOk && (addedLines === wantN) && copiesOk && noAt;';
    expect(CODE).toContain(JUDGE);
    expect(CODE.split(JUDGE).length - 1, '判据串出现了多份（第二份副本会漂）').toBe(1);
    /* 三句来源都在（不是凭空冒出三个变量） */
    expect(CODE, '没有"前缀没被动"这一句').toContain('var prefixKept = afterN.indexOf(beforeN) === 0;');
    expect(CODE, '没有"末尾恰好多了这一批"这一句').toContain('var addedOk = prefixKept && (norm(added) === norm(ALL));');
    expect(CODE, '没有"份数恰好 +1"这一句').toContain('var copiesOk = (copiesAfter === copiesBefore + 1);');
    /* ⚠️ 旧口径必须绝迹：`copies === 1` 在追加语义下必然假红 */
    expect(CODE_ONLY, '旧口径 copies === 1 又回来了（追加语义下它必然假红）')
      .not.toContain('copies === 1');
    /* ★ 判别力：摘掉"份数 +1" ⇒ 判据串不再成立 */
    const mutated = CODE.replace(' && copiesOk', '');
    expect(mutated).not.toContain(JUDGE);
    expect(mutated).toContain('var ok = prefixKept && addedOk && (addedLines === wantN) && noAt;');
  });

  it('分档齐全，且**新增 `clobbered` / `misplaced`**（被清空 vs 插偏，两种红灯必须分开）：not-found / focus-failed / readback-mismatch / rejected / duplicated / mangled / clobbered / misplaced', () => {
    for (const b of ['not-found', 'focus-failed', 'readback-mismatch', 'rejected', 'duplicated', 'mangled', 'clobbered', 'misplaced']) {
      expect(CODE, '缺失败分档 ' + b).toContain(b);
    }
    /* mangled 的两种成因都要在判据里：新增行数不符（标题粘连）与 @ 冒出来 */
    expect(CODE).toContain('!noAt');
    expect(CODE).toContain('addedLines !== wantN');
    /* 两种红灯必须能分开：旧内容"还在但插偏" ⇒ misplaced；"找不到了" ⇒ clobbered。
     * 合成一个会让下一个人按错方向修（一个要"别清空"，一个要"光标没移对"）。 */
    expect(CODE).toContain("(beforeStillThere ? 'misplaced' : 'clobbered')");
    expect(CODE, '没有独立读"旧内容还在不在"').toContain("var beforeStillThere = (beforeN === '') || (afterN.indexOf(beforeN) >= 0);");
    /* 原因必须贴回读前 80 字（用户能把状态栏原话贴回来） */
    expect(CODE).toMatch(/回读前 80 字/);
    expect(CODE, 'readback-mismatch 那一句必须贴回读前 60 字').toMatch(/回读前 60 字/);
  });

  it('回执带**追加读数**：写前长度 / 新增那段 / 前后份数（真机出问题一行读数就能定位）', () => {
    const receipt = CODE.slice(CODE.indexOf('return JSON.stringify({ ok: ok, bucket: bucket'), CODE.length);
    for (const k of ['beforeLen', 'added', 'addedLines', 'copiesBefore', 'copiesAfter', 'caret', 'sep', 'prefixKept']) {
      expect(receipt, '回执里缺读数 ' + k).toContain(k);
    }
  });

  it('`@` 的第二道闸（**本批必须留着**）：含 `@` 的文案 ⇒ mangled + **一个字都不写**', () => {
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
