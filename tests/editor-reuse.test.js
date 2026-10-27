/* ============================================================
 * tests/editor-reuse.test.js — 「一份实现」的**结构锁**（`W11 a–e` 的 `b「允许完整编辑」`）
 * ------------------------------------------------------------
 * 为什么需要它：本批把 `renderer/editor.js` 重构成**宿主注入的模块**（`MM.Editor.create(host)`），
 * 让主窗与草稿图窗（`DM`）调**同一份**实现。但"一份实现"这件事**没有任何运行时判据**能守住：
 *   · 有人在草稿页再写一套对话框 ⇒ 冒烟域的 7 条断言**照旧全绿**（草稿页的按钮也点得动），
 *     而两套编辑从此各漂各的 —— 这正是本工程十年里反复吃的那类亏；
 *   · 有人把项目语义（保存 / 撤销栈 / 关联剪枝）搬进模块 ⇒ 草稿窗开始假装自己能写盘；
 *   · 有人删掉 `renderer/editor.js` 里那五个**老入口名** ⇒ `app-actions.js` / `contextmenu.js`
 *     的调用点静默失效（它们写的是 `window.MMEditor && window.MMEditor.xxx`，缺一个就不做事）。
 * ⇒ 这里用**源码级**判据把上面三件事钉住（照 `tests/smoke-tiers.test.js` / `tests/smoke-tally.test.js`
 *   的先例：`renderer/*.js` 是 IIFE，node 里 require 不了，所以只能读源码断言）。
 *
 * ⚠️ 能力边界（如实标注）：这些断言判的是**结构**（谁依赖谁、名字还在不在），
 *    判不出"行为对不对"。行为由冒烟域 `scripts/smoke/56-草稿图编辑.js` 真跑（7 条，两个来源对拍）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const editorSrc = read('renderer/editor.js');
const draftSrc = read('renderer/draft-map.js');
const draftHtml = read('renderer/draft-map.html');
const actionsSrc = read('renderer/app-actions.js');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');

/** 去掉注释再判"代码里有没有"：注释里为了解释而提到的东西不该算成依赖。
 *  只做**最小**处理（行注释 + 块注释），不引依赖、不改字节位置以外的任何东西。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const editorCode = stripComments(editorSrc);
const draftCode = stripComments(draftSrc);
const actionsCode = stripComments(actionsSrc);

/* ------------------------------------------------------------------ */
describe('一份实现：编辑器是模块，草稿页调它而不是另写一套', () => {
  it('`renderer/editor.js` 发布的是工厂 `MM.Editor.create`（不再是一个自己跑起来的 IIFE）', () => {
    expect(editorSrc).toMatch(/MM\.Editor\s*=\s*\{\s*create:\s*create/);
    expect(editorCode).toMatch(/function create\(host\)/);
  });

  it('草稿页调**同一个**模块（`MM.Editor.create(`），且不给它伪造 MMApp', () => {
    expect(draftCode).toMatch(/MM\.Editor\.create\(/);
    // 草稿窗没有主窗单例：拿它当依赖就等于把两个窗口焊死（本批重构要拆的就是这个）
    expect(draftCode).not.toMatch(/window\.MMApp/);
  });

  it('编辑对话框的字段 id 只在 `editor.js`（与主窗静态骨架 `index.html`）里出现 —— 没有第二套骨架', () => {
    const ids = ['edit-topic', 'edit-tags', 'edit-detail', 'edit-expanded', 'edit-ok', 'edit-cancel'];
    const owners = [];
    for (const rel of ['renderer/editor.js', 'renderer/draft-map.js', 'renderer/draft-map.html', 'renderer/index.html']) {
      const src = read(rel);
      if (ids.some((id) => src.indexOf('"' + id + '"') >= 0 || src.indexOf("'" + id + "'") >= 0)) owners.push(rel);
    }
    expect(owners.sort()).toEqual(['renderer/editor.js', 'renderer/index.html']);
  });

  it('草稿页**不自己造**编辑对话框（没有 `<div id="edit-dialog"` 这类骨架）', () => {
    expect(draftHtml).not.toMatch(/id="edit-dialog"/);
    expect(draftCode).not.toMatch(/id="edit-dialog"/);
  });
});

/* ------------------------------------------------------------------ */
describe('主窗那五个老入口名还在（app-actions / contextmenu 的调用点是 `window.MMEditor.xxx`）', () => {
  const names = ['editNode', 'openImageDialog', 'openFileDialog', 'pickAndImportMd', 'pickExportMd'];
  it.each(names)('`MMEditor.%s` 仍在模块的导出面上', (name) => {
    expect(editorCode).toMatch(new RegExp('\\n\\s*' + name + '\\s*:'));   // api 对象里那一行
  });

  it('调用点没有被删（`app-actions.js` / `contextmenu.js` 里仍有对应调用）', () => {
    const cm = read('renderer/contextmenu.js');
    expect(actionsSrc).toMatch(/MMEditor/);
    expect(cm).toMatch(/MMEditor\.openImageDialog/);
    expect(cm).toMatch(/MMEditor\.openFileDialog/);
  });
});

/* ------------------------------------------------------------------ */
describe('能力分层是显式的：模块不替宿主决定"能不能写盘"', () => {
  it('能力位是**白名单表**且默认关（`CAPS` + `!!(h.capabilities && …)`）', () => {
    expect(editorSrc).toMatch(/const CAPS = \[/);
    expect(editorSrc).toMatch(/caps\[k\] = !!\(h\.capabilities && h\.capabilities\[k\]\)/);
    // 两层：结构四操作 + 需要主窗的四类，一个都不许少
    for (const k of ['editTopic', 'editDetail', 'addChild', 'addSibling', 'deleteNode', 'moveNode',
      'undoRedo', 'save', 'assets', 'markdown', 'crossProject', 'overlays']) {
      expect(editorSrc, '能力位 ' + k + ' 不在 CAPS 表里').toMatch(new RegExp("'" + k + "'"));
    }
  });

  it('没有的能力**点名理由**（`CAP_NOTES`），不许静默什么都不做', () => {
    expect(editorSrc).toMatch(/const CAP_NOTES = \{/);
    expect(editorCode).toMatch(/function refuse\(cap\)/);
    // 草稿窗的四条理由必须写着"为什么"（这四句就是定题 §3 的 D2/D3/D4/D7）
    expect(editorSrc).toMatch(/草稿不落盘 ⇒ 图片\/附件会变断链/);
    expect(editorSrc).toMatch(/草稿没有撤销栈/);
    expect(editorSrc).toMatch(/草稿没有家项目/);
  });

  it('模块里**没有**项目语义（保存 / 撤销栈 / 关联剪枝 / 脏标记一律经宿主）', () => {
    // 这三样是主窗独有：模块自己调它们 = 草稿窗开始假装能写盘
    expect(editorCode).not.toMatch(/project\.save/);
    expect(editorCode).not.toMatch(/assocPrune/);
    expect(editorCode).not.toMatch(/isDirty/);
    // 保存只能经 `host.onSave()` 这一条
    expect(editorCode).toMatch(/if \(typeof h\.onSave === 'function'\) h\.onSave\(\)/);
  });

  it('草稿页给的能力位就是它真的能做的那些（写死在这里，改它要同批改冒烟 56）', () => {
    const caps = /capabilities:\s*\{([\s\S]*?)\}/.exec(draftCode);
    expect(caps, '草稿页没有 capabilities 块').toBeTruthy();
    const body = caps[1];
    for (const k of ['editTopic: true', 'editDetail: true', 'addChild: true', 'addSibling: true',
      'deleteNode: true', 'moveNode: true']) {
      expect(body.replace(/\s+/g, ' '), '缺少 ' + k).toContain(k);
    }
    for (const k of ['save: false', 'undoRedo: false', 'assets: false', 'markdown: false',
      'crossProject: false', 'overlays: false', 'editTags: false', 'editExpanded: false']) {
      expect(body.replace(/\s+/g, ' '), '应当关掉 ' + k).toContain(k);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('宿主接口真的接上了（不然模块拿到的是空钩子 = 静默失效）', () => {
  it('主窗宿主由 `app-actions.js` 提供，并带**撤销栈**与**删除预检**两个钩子', () => {
    expect(actionsSrc).toMatch(/MM\.mainEditorHost = function mainEditorHost\(\)/);
    expect(actionsSrc).toMatch(/onCommit:\s*\(kind\)/);
    expect(actionsSrc).toMatch(/beforeDelete:\s*\(node\)\s*=>\s*deletePrecheck\(node\)/);
    // 记栈的判据：只有 add / delete / move 进撤销栈（改标题/正文**不进** —— 这是改前的语义）
    expect(actionsCode).toMatch(/kind === 'add' \|\| kind === 'delete' \|\| kind === 'move'/);
  });

  it('主窗的结构操作**转发**到模块（不再自己写一份 add/delete）', () => {
    for (const fn of ['addNode', 'addSiblingNode', 'editNode', 'deleteNode']) {
      const body = new RegExp('function ' + fn + '\\([^)]*\\) \\{[\\s\\S]{0,400}?\\n  \\}').exec(actionsCode);
      expect(body, '`' + fn + '` 的函数体没找到').toBeTruthy();
      expect(body[0], '`' + fn + '` 没有转发到 window.MMEditor（还在自己实现一份？）')
        .toMatch(/e\.addChild\(|e\.addSibling\(|e\.editNode\(|e\.deleteNode\(/);
    }
  });

  it('草稿页把"改动收口"接成 `draft:update`（权威副本在主进程，不在页面）', () => {
    expect(draftCode).toMatch(/onCommit:\s*\(\)\s*=>\s*\{\s*pushTree\(\)/);
    expect(draftCode).toMatch(/d\.update\(tree\)/);
    // 串行化：连点两下不能出现"先发后到把新内容盖回旧内容"
    expect(draftCode).toMatch(/pushChain = pushChain\.then/);
  });

  it('`main.js` 的 `draft:update` 真的重跑 normalize 并按新内容重挂指纹', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\('draft:update'/);
    const block = /ipcMain\.handle\('draft:update'[\s\S]{0,1600}?\n  \}\);/.exec(mainSrc);
    expect(block, '`draft:update` 的实现块没找到').toBeTruthy();
    expect(block[0]).toMatch(/draftMap\.normalize\(tree\)/);
    expect(block[0]).toMatch(/DRAFT\.byFp\.delete\(oldFp\)/);
    expect(block[0]).toMatch(/DRAFT\.byFp\.set\(fp, ent\)/);
    // 关窗时按**对象身份**摘（残留条目会让 `ctx.draft.list()` 数出"窗还在"）
    expect(mainSrc).toMatch(/for \(const \[k, v\] of Array\.from\(DRAFT\.byFp\.entries\(\)\)/);
  });

  it('`preload.js` 只暴露一条"交回树"的通道，且没有"保存到盘"的口子', () => {
    expect(preloadSrc).toMatch(/update:\s*\(tree\) => ipcRenderer\.invoke\('draft:update', tree\)/);
    // 台账硬要求：草稿不落盘 ⇒ 这一层**不许**有 save 一类方法
    const draftBlock = /draft:\s*\{[\s\S]*?\n  \}/.exec(preloadSrc);
    expect(draftBlock, '`draft:` 块没找到').toBeTruthy();
    expect(draftBlock[0]).not.toMatch(/save/i);
  });
});

/* ------------------------------------------------------------------ */
describe('新域 56 的登记面（domain 56 一旦漏登记，断言就"哪一档都不跑"）', () => {
  it('域文件存在，且已在断言入口索引里（`collateral-check` 的 smoke-index 判据）', () => {
    const file = '56-草稿图编辑.js';
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'smoke', file))).toBe(true);
    expect(read('scripts/smoke-assertions.js')).toContain(file);
  });

  it('分层表（TIERS）与改动面表（SURFACES.renderer）都登记了 56', () => {
    const smoke = require('../scripts/smoke-assertions.js');
    const plan = require('../scripts/changed-plan.js');
    expect(smoke.tierOf('56')).toBeTruthy();
    const renderer = plan.SURFACES.filter((s) => s.id === 'renderer')[0];
    expect(renderer.domains).toContain('56');
  });

  /* 【2026-10-27 UI 优化批】7 → **9**：本批给域 56 补了两条**新**断言（只增不删）——
   *   ①「草稿窗编辑框的『保存』始终在可见区内」（撑高正文造溢出 ⇒ 滚到顶/滚到底都不出框，含 elementFromPoint 命中测试）
   *   ②「草稿窗：报错 200ms 后仍在屏幕上」（写一句灰色例行提示后 `#err-toast` 仍留着报错原文）
   * 为什么这两条必须落在域 56 而不是别处：它们判的正是**草稿窗**（按内容定大小、实测 805×251 视口）
   * 那两个既有缺陷 —— 保存按钮在视口外、报错被下一句灰字盖掉。改完实跑 9 条全绿（见
   * `.review/20261062-UI优化/对照.md`）。⇒ 数量改动要同批改这里的真值，别让它悄悄漂。 */
  it('本域的 9 条断言都真的存在（数量变动要同批改文档真值）', () => {
    const list = require('../scripts/smoke/56-草稿图编辑.js');
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(9);
    list.forEach((a) => {
      expect(typeof a.name).toBe('string');
      expect(typeof a.run).toBe('function');
    });
  });
});
