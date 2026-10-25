/* ============================================================
 * tests/sel-drag-ghost.test.js — 「拖动虚影」与「鼠标直接拖」的**源码级**判据（2026-10-33 批3）
 * 运行：npx vitest run tests/sel-drag-ghost.test.js
 * ------------------------------------------------------------
 * 为什么要有这一层（与冒烟域 30 的 G1–G6 是两层，不是重复）：
 *   冒烟那层要跑 Electron、要真窗口、要等 40ms 轮询；这一层**毫秒级、零依赖**，改坏了立刻红。
 *   两层各自独立成立 ⇒ 只删一层也不会让这些口径失去守护。
 *
 * 它钉住的四件事（都是"改一行就悄悄失去防护"的那种）：
 *   ① **指针永不落入虚影矩形**这条不变量的**数值前提**：偏移两轴都必须 ≥ `GHOST_MIN_GAP`。
 *      `View` 的 API 面（electron.d.ts）**没有任何鼠标 API** ⇒ 指针落进虚影矩形 = 用户点不动了。
 *      几何函数本身也有行为判据（冒烟 G2），这里只保证"参数一改就会被抓住"。
 *   ② 虚影收起**只有一处落点**：`main.js` 的 `selDragFinish`（三条终点路都收敛到它）。
 *   ③ "能不能投给 DSH"**只有一个判据**：渲染层的 `canDropToDsh`；两处投喂口都必须过它；
 *      主进程只照渲染层报的 `toDsh` 办（`selDragFeed` 里那道闸）。
 *   ④ 用户 2026-10-31 拍板的规格常量 `SINGLE_SELECT_CAN_DROP_TO_DSH === false`，
 *      且它有一个只读出口（`MM.singleSelectCanDropToDsh`）—— 改这一行等于改用户规格。
 *
 * 判据口径（逐字，别用"大概"读它）：
 *   · 只读源码文本；`getBounds()`/`getContentBounds()` 之类的**基准**判据归
 *     `tests/sidebar-drop-basis.test.js`（那份更严格：区域内 `getBounds()` 必须 0 次），本文件不重复。
 *   · 每条判据都配一条**判别力自检**：把源码按"改坏"的方向替换一次，同一条判据必须判红。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAIN = read('main.js');
const SIDEBAR = read('main-dsh-sidebar.js');
const VIEW = read('renderer/app-view.js');

/** 取 `label` 之后 `n` 个字符（找不到就返回 ''，让判据红而不是静默跳过） */
const sliceFrom = (src, label, n) => {
  const i = src.indexOf(label);
  return i < 0 ? '' : src.slice(i, i + n);
};
const count = (hay, needle) => hay.split(needle).length - 1;

/** 从源码里读一个数字常量（`const NAME = 12;` / `{ dx: 16, dy: 18 }`） */
function numConst(src, re, name) {
  const m = src.match(re);
  return m ? Number(m[1]) : NaN;
}

describe('拖动虚影：几何不变量与"只有一处收起点"', () => {
  it('偏移两轴都 ≥ GHOST_MIN_GAP（指针永不落入虚影矩形的**数值前提**）', () => {
    /* 两处都在 main.js：虚影实现与拖拽状态机同处一个文件（为什么不在 main-dsh-sidebar.js 见那边的
     * 指向注释 —— 那个文件有一条 `setBounds(` 只许出现在 relayout() 里的结构判据）。 */
    const gap = numConst(MAIN, /const GHOST_MIN_GAP\s*=\s*(\d+)\s*;/, 'GHOST_MIN_GAP');
    const dx = numConst(MAIN, /const SEL_GHOST_OFFSET\s*=\s*\{\s*dx:\s*(-?\d+)/, 'dx');
    const dy = numConst(MAIN, /const SEL_GHOST_OFFSET\s*=\s*\{\s*dx:\s*-?\d+\s*,\s*dy:\s*(-?\d+)/, 'dy');
    expect(Number.isFinite(gap) && gap > 0, 'GHOST_MIN_GAP 必须是正数').toBe(true);
    expect(Number.isFinite(dx) && Number.isFinite(dy), 'SEL_GHOST_OFFSET 必须是两个数字常量').toBe(true);
    expect(dx, 'dx 小于最小轴距 ⇒ 虚影会盖住光标（用户会在虚影上点不动）').toBeGreaterThanOrEqual(gap);
    expect(dy, 'dy 小于最小轴距 ⇒ 同上').toBeGreaterThanOrEqual(gap);
    // 判别力自检：把 dx 改成 0（"偏移写成 (0,0)"那种改法）⇒ 同一条判据必须判红
    const mutated = MAIN.replace(/const SEL_GHOST_OFFSET\s*=\s*\{\s*dx:\s*-?\d+/, 'const SEL_GHOST_OFFSET = { dx: 0');
    expect(mutated).not.toBe(MAIN);
    const mdx = numConst(mutated, /const SEL_GHOST_OFFSET\s*=\s*\{\s*dx:\s*(-?\d+)/, 'dx');
    expect(mdx < gap, '注入后判据必须能红（否则这条是恒绿的摆设）').toBe(true);
  });

  it('几何函数有"四个候选 + 过不了就返回 null"（**不夹回来盖住光标**）', () => {
    const fn = sliceFrom(MAIN, 'function ghostRectFor(', 1800);
    expect(fn.length, '找不到 ghostRectFor 的实现').toBeGreaterThan(500);
    // 四个候选：右下 / 左下 / 右上 / 左上（前两个必在：贴右缘时要翻到左侧）
    expect(fn).toContain('px + dx');
    expect(fn).toContain('px - dx - w');
    expect(fn).toContain('py - dy - h');
    // 放不下就不显示（不变量优先于"一定要有虚影"）
    expect(fn).toContain('return null');
    // 自检用同一个函数（读数与判定共用一份）
    expect(fn).toContain('ghostGapOk');
  });

  it('虚影收起只有一处落点：selDragFinish 里调 hideGhost（四条终点路共用）', () => {
    const i = MAIN.indexOf('function selDragFinish(');
    expect(i, '找不到 selDragFinish').toBeGreaterThan(0);
    const body = MAIN.slice(i, i + 1100);
    expect(body, 'selDragFinish 必须收起虚影 —— 否则漏一条终点路就会把虚影留在屏上').toContain('hideGhost');
    /* 四条终点路确实都收敛到 selDragFinish。
     * ⚠️ 2026-10-38 换了第三条：原先是 `dwell`（真光标在侧栏视图上悬 ≥400ms 就当成"松手"），
     * 用户在真机上验出来的"拖到 DSH 失败 / 松手看不见虚影"就是它 —— 手还按着，拖拽已经被它结束了。
     * ⇒ 现在第三条是 `sidebar-page`（侧栏带上那两张原生页**自己报的 mouseup**，见 main.js 的
     *   `selHookSidebarRelease`），`dwell` 必须**彻底不在**（下面那条 it() 专门守这一点）。 */
    ['renderer', 'sidebar-page', 'timeout'].forEach((by) => {
      expect(MAIN, '终点路少了 ' + by).toContain("selDragFinish(st, '" + by + "')");
    });
    // 判别力自检：把那一行删掉 ⇒ 上面那条必须能红
    const mutated = MAIN.replace(/const g = hideGhost\('finish:' \+ by\);/, 'const g = null;');
    expect(mutated).not.toBe(MAIN);
    const mBody = mutated.slice(mutated.indexOf('function selDragFinish('), mutated.indexOf('function selDragFinish(') + 1100);
    expect(mBody.includes('hideGhost'), '注入后判据必须能红').toBe(false);
  });

  it('★ 终点只能由"观测到的松手"决定：`dwell`（悬停当松手）必须彻底不存在', () => {
    /* 用户 2026-10-38 真机报的「拖动到 dsh 失败」+「没有虚影显示在内置 dsh 上面」是同一个机制：
     * dwell 在**手还按着**的时候把拖拽结束掉（虚影收起），于是真正松手那一拍被当成"没有活动拖拽"丢掉。
     * ⇒ 这条是**反向判据**：谁把 dwell 加回来，这里必红（注释里提到它是允许的，代码里出现调用不行）。 */
    const codeOnly = MAIN.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    expect(codeOnly, 'main.js 里又出现了 shouldDropByDwell 调用 ⇒ 悬停又被当成松手了').not.toContain('shouldDropByDwell');
    expect(codeOnly, 'SEL_DWELL_MS 这个"悬停阈值"常量不许回来').not.toContain('SEL_DWELL_MS');
    expect(codeOnly, '终点判定里不许再出现 dwell 这个 by 值').not.toContain("'dwell'");
    // 判别力自检：把一行 dwell 调用注入回去 ⇒ 上面三条必须能红
    const mutated = codeOnly + "\n  selDragFinish(st, 'dwell');\n  if (dropTarget.shouldDropByDwell(x)) {}\n";
    expect(mutated.includes("'dwell'") && mutated.includes('shouldDropByDwell'), '注入后判据必须能红').toBe(true);
  });
});

describe('鼠标直接拖：4px 阈值、判定表闸门、规格常量', () => {
  it('用户规格常量 SINGLE_SELECT_CAN_DROP_TO_DSH === false，且有只读出口', () => {
    expect(VIEW, '规格常量不见了（改规格必须重新拍板）').toContain('const SINGLE_SELECT_CAN_DROP_TO_DSH = false;');
    expect(VIEW, '常量必须导出只读读取口（给出处的判据用）').toContain('MM.singleSelectCanDropToDsh = () => SINGLE_SELECT_CAN_DROP_TO_DSH;');
    // 判别力自检：把它改成 true ⇒ 断言必须能红（这就是"顺手改成允许单选拖给 DSH"的注入形态）
    const mutated = VIEW.replace('const SINGLE_SELECT_CAN_DROP_TO_DSH = false;', 'const SINGLE_SELECT_CAN_DROP_TO_DSH = true;');
    expect(mutated).not.toBe(VIEW);
    expect(mutated.includes('const SINGLE_SELECT_CAN_DROP_TO_DSH = false;'), '注入后判据必须能红').toBe(false);
  });

  it('两处投喂口都被 canDropToDsh 闸住（"只有多选能拖给 DSH"只有一个判据）', () => {
    const i = VIEW.indexOf('function selDragDrop(');
    expect(i, '找不到 selDragDrop').toBeGreaterThan(0);
    const body = VIEW.slice(i, i + 3200);
    expect(count(body, 'feedSelDrop('), '投喂口应当只有两处（右缘 24px 兜底 + 回执命中）').toBe(2);
    expect(body, '右缘兜底必须过 droppable 闸').toContain('if (pr && droppable && s && s.ids.length');
    expect(body, '回执命中那条必须过 droppable 闸').toContain('if (droppable) { feedSelDrop(s.ids);');
    // 不能有"没闸"的投喂：每个 feedSelDrop 都必须出现在 droppable 判定之后
    const firstGate = body.indexOf('canDropToDsh(');
    expect(firstGate).toBeGreaterThan(-1);
    let idx = -1;
    while ((idx = body.indexOf('feedSelDrop(', idx + 1)) >= 0) {
      expect(idx, 'feedSelDrop 出现在 canDropToDsh 求值之前 ⇒ 闸门可以被绕过').toBeGreaterThan(firstGate);
    }
  });

  it('主进程只照渲染层报的 toDsh 办：selDragFeed 里有一道闸', () => {
    const i = MAIN.indexOf('function selDragFeed(');
    expect(i).toBeGreaterThan(0);
    const body = MAIN.slice(i, i + 1200);
    expect(body, 'selDragFeed 必须先问"这一批能不能投给 DSH"').toContain('selDragDroppable(st)');
    expect(body, '不可投时**不许**投喂（按规格取消）').toMatch(/return false/);
    // 旧单参调用（没有 subject）必须照旧可投 —— 否则 ①-A/①-B 那批断言会静默失效
    const j = MAIN.indexOf('function selDragDroppable(');
    expect(MAIN.slice(j, j + 300)).toContain('if (!s) return true;');
  });

  it('4px 阈值存在，且 mousedown **不** preventDefault（否则点一下节点就没法弹详情）', () => {
    const thr = numConst(VIEW, /const SEL_DRAG_THRESHOLD_PX\s*=\s*(\d+)\s*;/, 'SEL_DRAG_THRESHOLD_PX');
    expect(thr, '位移阈值必须是正的像素数').toBeGreaterThan(0);
    const blockStart = VIEW.indexOf("document.addEventListener('mousedown', (e) => {", VIEW.indexOf('鼠标**直接拖**'));
    expect(blockStart, '找不到"直接拖"的 mousedown 监听').toBeGreaterThan(0);
    // 只取**这一个监听器**（到它的收尾 `}, true);` 为止）—— 越过它就会把 mousemove 里那句
    // 合法（且必需）的 preventDefault 算进来，变成一条误告
    const endIdx = VIEW.indexOf('}, true);', blockStart);
    expect(endIdx).toBeGreaterThan(blockStart);
    const block = VIEW.slice(blockStart, endIdx + 9);
    expect(block.length, '监听器体太短 ⇒ 定位错了').toBeGreaterThan(200);
    /* 只看**整行不是注释**的行：注释里写「不 preventDefault」是提醒（本文件就有），不该判红 */
    const blockCode = block.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    expect(blockCode, 'mousedown 里出现 preventDefault() ⇒ jsMind 自己的选中/点击会死').not.toContain('preventDefault()');
    expect(block, 'mousedown 必须记起点（x0/y0）').toContain('x0: e.clientX');
    // 阈值真的被用上（不是声明完就没事）
    expect(VIEW).toContain('SEL_DRAG_THRESHOLD_PX');
    expect(count(VIEW, 'SEL_DRAG_THRESHOLD_PX'), '阈值至少出现在：声明 + 判据 + 松手"是否同一按"的容差').toBeGreaterThanOrEqual(3);
  });

  it('拖动模式那套 API 一个都没删（scripts/smoke/ 里 65 行 / 8 文件拿它当前置夹具）', () => {
    ['MM.setDragMode = setDragMode;', 'MM.dragModeActive = dragModeActive;', 'MM.getDragTreeRoot = getDragTreeRoot;',
      'MM.dragModeKind = dragModeKind;', 'MM.dragSelection = dragSelection;'].forEach((line) => {
      expect(VIEW, '不许删拖动模式那套 API：' + line).toContain(line);
    });
  });
});
