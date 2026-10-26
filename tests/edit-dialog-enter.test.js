/* ============================================================
 * tests/edit-dialog-enter.test.js —— 「编辑节点」对话框里 **Enter 的语义**（单位判据）
 * ------------------------------------------------------------
 * 为什么有这份（用户 2026-10-26 原话：「编辑节点详情功能有问题，不能输入，你的测试形同虚设」）：
 *   真因是 `renderer/editor.js` 的 `onKey` 里那条"只要编辑框开着，任何 Enter 都提交并关框"。
 *   在 `#edit-detail`（`<textarea rows=8>`，装的是多行 HTML）里按 Enter ⇒ 框直接关掉并保存
 *   ⇒ **多行正文永远打不出来**；中文输入法"选词上屏"那一下也是 Enter（组合期）⇒ 每上屏一个
 *   字都可能关框 ⇒ 用户看到的就是"打不进去字"。
 *
 * 判据分两层（缺一层都会退化成"看着绿"）：
 *   ① **行为**：把 `renderer/editor.js` 里那个 `enterSubmits(e)` 函数体**原样抠出来**
 *      （`new Function` 求值，不复制一份逻辑 —— 复制出来的第二份必然漂）喂各种事件对象，
 *      逐条判它该真/该假。这一层能抓住"守卫被删掉/条件写反"。
 *   ② **结构**：`onKey` 里那个 Enter 分支**必须**经过 `enterSubmits`（否则有人把守卫写在
 *      别处、或者绕开它直接 `saveEditDialog()`，① 全绿而产品照样坏）。
 *
 * ⚠️ 边界（如实标注）：本文件**不**验"真键盘能不能打进格子" ——
 *    那要靠真输入（`webContents.sendInputEvent`），在冒烟域
 *    `scripts/smoke/04-detail-box.js`（主窗，4 条）与 `scripts/smoke/56-草稿图编辑.js`（草稿窗）。
 *    本文件只锁"键盘事件到了处理器之后，产品怎么解释它"。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const editorSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'editor.js'), 'utf8');

/** 从源码里抠出 `function <名字>(<参数>) { ... }` 的**整段函数文本**（按花括号配对，不靠正则猜）。
 *  为什么要配对而不是正则：函数体里有对象字面量、模板串、`{}` 里的注释 —— 正则一定会在某天出错。
 *  为什么抠而不是复制一份：复制出来的第二份会与产品漂开，而"漂开的判据"正是本工程反复治的病。 */
function extractFunction(src, name) {
  const head = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = head.exec(src);
  if (!m) throw new Error('源码里找不到函数 ' + name + '()');
  let i = src.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) throw new Error(name + '() 没有函数体');
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  throw new Error(name + '() 的花括号没配对');
}

const enterSubmitsSrc = extractFunction(editorSrc, 'enterSubmits');
// eslint-disable-next-line no-new-func
const enterSubmits = new Function('return (' + enterSubmitsSrc + ')')();

/** 造一个"像 DOM 事件"的最小对象（只带产品真正读到的三个字段） */
const ev = (o) => Object.assign({ key: 'Enter' }, o || {});

describe('Enter 在编辑对话框里 = 提交？—— 产品那个 enterSubmits() 的真实行为', () => {
  it('单行输入（标题 / 标签）里 Enter **仍然提交**（既有语义，不许一刀切改掉）', () => {
    expect(enterSubmits(ev({ target: { tagName: 'INPUT' } }))).toBe(true);
    // tagName 大小写不该让判据失效（HTML 里是大写，但 XML/老代码里可能不是）
    expect(enterSubmits(ev({ target: { tagName: 'input' } }))).toBe(true);
    expect(enterSubmits(ev({ target: { tagName: 'DIV' } }))).toBe(true);
    expect(enterSubmits(ev({}))).toBe(true);
  });

  it('**多行控件（TEXTAREA）里 Enter 不提交** —— 正文格必须是换行（这就是用户说的「不能输入」）', () => {
    expect(enterSubmits(ev({ target: { tagName: 'TEXTAREA' } }))).toBe(false);
    expect(enterSubmits(ev({ target: { tagName: 'textarea' } }))).toBe(false);
  });

  it('**输入法组合期的 Enter 不提交** —— 中文选词上屏那一下也是 Enter（`isComposing`）', () => {
    expect(enterSubmits(ev({ isComposing: true, target: { tagName: 'INPUT' } }))).toBe(false);
    // 有些平台只剩 keyCode 229（Chromium 的 IME 哨兵）：只判 isComposing 会漏
    expect(enterSubmits(ev({ keyCode: 229, target: { tagName: 'INPUT' } }))).toBe(false);
  });

  it('反例（防判据空转）：不是 Enter 语义的时刻也能正常判 → 普通 Enter 在单行格里为 true', () => {
    expect(enterSubmits(ev({ isComposing: false, keyCode: 13, target: { tagName: 'INPUT' } }))).toBe(true);
    expect(enterSubmits(null)).toBe(false);   // 防御：没有事件对象时不许抛
  });
});

describe('结构锁：onKey 的 Enter 分支**必须**经过 enterSubmits（否则行为判据会变成空转）', () => {
  it('`onKey` 里那句 Enter 提交带着 `enterSubmits(e)` 这个守卫', () => {
    const onKeySrc = extractFunction(editorSrc, 'onKey');
    expect(onKeySrc).toMatch(/e\.key === 'Enter'/);
    expect(onKeySrc).toMatch(/enterSubmits\(e\)/);
    // 并且**同一行**既判 Enter 又判守卫：拆成两个 if 也能成立，但那样容易在某次改动里丢掉一半
    const line = onKeySrc.split('\n').find((l) => l.indexOf("e.key === 'Enter'") >= 0) || '';
    expect(line).toMatch(/enterSubmits\(e\)/);
    expect(line).toMatch(/saveEditDialog\(\)/);
  });

  it('`enterSubmits` 自己就摆在 `renderer/editor.js` 里（不是从别处借来的两份实现之一）', () => {
    expect(editorSrc).toMatch(/function\s+enterSubmits\s*\(e\)/);
    // 全仓只许一份：别的文件里出现同名定义 ⇒ 立刻红（"两份实现"是本工程反复治的病）
    const files = ['renderer/draft-map.js', 'renderer/app-actions.js', 'renderer/app-view.js', 'main.js'];
    for (const rel of files) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) continue;
      expect(fs.readFileSync(p, 'utf8')).not.toMatch(/function\s+enterSubmits\s*\(/);
    }
  });
});
