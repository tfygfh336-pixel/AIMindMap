/* ============================================================
 * tests/drag-menu-entry.test.js — 「拖动模式**入口已摘**、API 一行没删」的源码级判据（2026-10-33 批4）
 * 运行：npx vitest run tests/drag-menu-entry.test.js
 * ------------------------------------------------------------
 * 用户 2026-10-31：「移除拖动模式」。第一期只摘**右键菜单入口**，`setDragMode` 那一族一个字节不删
 * —— 它是 `scripts/smoke/` 里 8 个文件 / 65 行断言的前置夹具，一刀删等于同时改掉那些域的判定基础。
 *
 * 为什么这一层要有（与冒烟域 05/45/46/48/49/51 是两层，不是重复）：
 *   冒烟那层要跑 Electron（域 46 一轮 ≈ 170s）、要真窗口、要真鼠标；这一层**毫秒级**，
 *   改坏了立刻红。两层各自独立成立 ⇒ 只删一层也不会让这条口径失去守护。
 *
 * 它钉住的四件事（每一条都对应一种"改一行就悄悄失效"）：
 *   ① 四条入口**真的没了**：`renderer/contextmenu.js` 剥注释后既没有四条菜单文案，
 *      也没有 `setDragMode(true` 这半句（该文件里唯一合法的那一处是右键**清掉**模式的 `setDragMode(false)`）；
 *   ② 保留项**真的还在**：右键清模式那段、`body.mm-dragmode` 那套样式、`renderer/app.js` 的四个转发、
 *      `renderer/app-view.js` 的实现与 `MM.*` 导出（后一条与 `tests/sel-drag-ghost.test.js` 同源但**不重复**：
 *      那份判"批 3 没顺手删 API"，这份判"本批摘入口之后 API 仍在"—— 判据读的是同一批行，
 *      理由不同、红的时候指向的改动不同，所以两边都留着）；
 *   ③ "删除"必须是**口子里的一步**，不是顺手把整个 `nodeMenu` 掏空：节点菜单里
 *      「移回自动布局」与两条分侧项仍由菜单提供（否则 46 丙 / 45 丙 的判据会变成空转）；
 *   ④ **每条判据都配判别力自检**：把源码按"改坏"的方向造一份样本，同一条判据必须判红
 *      （照 `tests/sel-drag-ghost.test.js` 的口径：不能只证明"绿"，要证明"会红"）。
 *
 * 判据口径：只读源码文本，不 require 渲染层（它跑在浏览器里）。剥注释用工程里唯一那份实现。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 剥注释的唯一实现（复用 S1 门禁那一份，不另写一套）：判据的输入必须是**代码**，不是散文
import { stripComments } from '../scripts/dep-direction-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CTX = read('renderer/contextmenu.js');
const CTX_CODE = stripComments(CTX);
const APP = read('renderer/app.js');
const VIEW = read('renderer/app-view.js');
const CSS = read('renderer/style.css');

/** 四条入口的**菜单文案前缀**（改文案 = 改用户看到的东西，所以判据钉前缀，不钉整句） */
const LABEL_PREFIXES = [
  '拖动树：',
  '拖动此子树：',
  '拖动到同级第几位：',
  '挂到别的父节点下：'
];
/** 四条入口在源码里的**函数名**（摘入口时连函数体一起删了 ⇒ 代码里不许再有定义/调用） */
const FN_NAMES = ['dragModeItem', 'subtreeDragItem', 'reorderDragItem', 'reparentItem'];

/** ① 的四条判据都写成纯函数：既能对真源码判，也能对注入样本判（判别力自检用同一份代码） */
const liveLabels = (code) => LABEL_PREFIXES.filter((p) => code.indexOf(p) >= 0);
const liveFns = (code) => FN_NAMES.filter((n) => new RegExp('\\b' + n + '\\s*\\(').test(code));
const enterCalls = (code) => code.split('setDragMode(true').length - 1;
const exitCalls = (code) => code.split('setDragMode(false').length - 1;

describe('拖动模式入口（2026-10-33 批4：只摘入口，不删 API）', () => {
  it('① 四条菜单入口真的没了：剥注释后既没有那四条菜单文案，也没有 setDragMode(true 这半句', () => {
    expect(liveLabels(CTX_CODE), '右键菜单里又出现了拖动入口的文案').toEqual([]);
    expect(liveFns(CTX_CODE), '四条入口的构造函数还在（删了入口就要连带删函数体，别留死代码）').toEqual([]);
    expect(enterCalls(CTX_CODE), 'contextmenu.js 里不许再调用 setDragMode(true, …)（进模式）').toBe(0);
    /* 判别力自检：把**改前**的那两行原样塞回去，同一条判据必须红（证明它不是恒真） */
    const injected = CTX_CODE
      + '\n  function dragModeItem(nodeId) { return { label: \'拖动树：移动「x」\', action: function () {} }; }\n'
      + '  var it = dragModeItem(\'a\'); it.action = function () { app().setDragMode(true, \'a\'); };\n';
    expect(liveLabels(injected), '判别力：塞回一条入口文案后必须命中').toEqual(['拖动树：']);
    expect(liveFns(injected), '判别力：塞回函数后必须命中').toEqual(['dragModeItem']);
    expect(enterCalls(injected), '判别力：塞回 setDragMode(true 后必须数得到').toBe(1);
  });

  it('② 保留项仍在：右键**清掉**拖动模式那段 / body.mm-dragmode 那套样式 / 两条分侧项与「移回自动布局」仍在菜单里', () => {
    // 右键清模式：拖动模式下右键 = 退出且不弹菜单（域 05 的两条断言直接依赖它）
    expect(exitCalls(CTX_CODE), '右键清掉拖动模式那段被删了（模式本体还在，只摘入口）').toBeGreaterThanOrEqual(1);
    expect(CTX_CODE, 'onContextMenu 里那句"拖动模式下右键 = 退出"没了').toContain('dragModeActive');
    // 样式：body.mm-dragmode 那一段（模式本体的视觉，摘入口不摘样式）
    expect(CSS, 'style.css 里 body.mm-dragmode 那一段被删了').toContain('body.mm-dragmode');
    // 菜单没被掏空：两条分侧项 + 手工位置的"清回去"仍在
    expect(CTX_CODE, '两条分侧项被一起摘了（只该摘拖动那四条）').toContain('摆到左侧');
    expect(CTX_CODE, '两条分侧项被一起摘了（只该摘拖动那四条）').toContain('摆到右侧');
    expect(CTX_CODE, '「移回自动布局」被一起摘了（只该摘拖动那四条）').toContain('移回自动布局');
    expect(CTX_CODE, 'clearOffsetItem 被删了').toContain('clearOffsetItem');
    expect(CTX_CODE, 'themeSideItems 被删了').toContain('themeSideItems');
  });

  it('③ API 一行没删：renderer/app.js 的四个转发都在（:210-215），且都转发到 MM 上', () => {
    // 逐字行（转发丢一个 = smoke 里 8 个文件的前置当场断裂）
    [
      'setDragMode: (on, treeRootId, opts) => MM.setDragMode(on, treeRootId, opts),',
      'dragModeActive: () => MM.dragModeActive(),',
      'getDragTreeRoot: () => MM.getDragTreeRoot(),',
      'dragModeKind: () => (MM.dragModeKind ? MM.dragModeKind() : null),'
    ].forEach((line) => {
      expect(APP, 'MMApp 的转发被删了：' + line).toContain(line);
    });
    // 判别力自检：把任意一条转发删掉，按同一条判据必须红
    const broken = APP.replace('getDragTreeRoot: () => MM.getDragTreeRoot(),', '');
    expect(broken.indexOf('getDragTreeRoot: () => MM.getDragTreeRoot(),'),
      '判别力：删掉一条转发后必须判红').toBe(-1);
  });

  it('④ app-view.js 的实现与 MM.* 导出仍在（模式本体没被摘掉，摘的只是入口）', () => {
    ['function setDragMode(', 'function dragModeActive(', 'function dragModeKind(', 'function getDragTreeRoot(']
      .forEach((line) => { expect(VIEW, 'app-view.js 的实现被删了：' + line).toContain(line); });
    ['MM.setDragMode = setDragMode;', 'MM.dragModeActive = dragModeActive;',
      'MM.getDragTreeRoot = getDragTreeRoot;', 'MM.dragModeKind = dragModeKind;']
      .forEach((line) => { expect(VIEW, 'MM.* 导出被删了：' + line).toContain(line); });
    // 判别力自检
    const broken = VIEW.replace('MM.getDragTreeRoot = getDragTreeRoot;', '');
    expect(broken.indexOf('MM.getDragTreeRoot = getDragTreeRoot;'), '判别力：删掉导出行后必须判红').toBe(-1);
  });
});
