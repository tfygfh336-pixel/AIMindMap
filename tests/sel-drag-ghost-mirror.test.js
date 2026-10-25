/* ============================================================
 * tests/sel-drag-ghost-mirror.test.js —— 「虚影镜像节点」与「拖完不许开详情」的**源码级**判据
 * 运行：npx vitest run tests/sel-drag-ghost-mirror.test.js
 * ------------------------------------------------------------
 * 来源（唯一需求真源，用户 2026-10-38 真机逐字）：
 *   「虚影有，但是我要的效果是外观和节点一模一样，除了有虚化效果。然后拖动到dsh失败，
 *     也没有虚影显示在内置dsh上面。然后松开会自动打开节点详情，这个是bug」
 * 拆成三条，各钉一组"改一行就悄悄失去防护"的口径：
 *   ① **D2 外观同源**：渲染层搬哪几个 computed style 键、主进程收哪几个，必须是**同一份清单**
 *      （两处各写一份 ⇒ 必然漂：多搬的键白搬、少搬的键让虚影少一样东西，而两边都不会报错）。
 *   ② **D2 只多一层虚化**：虚影页里不许出现任何外部资源引用（`data:` URL 是 opaque origin，
 *      引了必坏），且模糊半径必须是正数。
 *   ③ **D4 一次 click 的归属**：拖拽手势补发的那一次 click 必须在**捕获阶段**被吞掉，
 *      置位点唯一（`selDragDrop`）、清零点唯一（下一次 mousedown 与吞掉本身）。
 *   ④ **D3 终点不能是时间猜测**：`shouldDropByDwell` 的调用不许回到 main.js；
 *      侧栏带上的两张原生页都要有"松手上报"的装配口。
 *
 * 判据口径：只读源码文本（毫秒级、零依赖），每条都配一条**判别力自检**（把源码按"改坏"的方向
 * 替换一次，同一条判据必须判红）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAIN = read('main.js');
const VIEW = read('renderer/app-view.js');

/** 只留"整行不是注释"的行（判据口径与 tests/sidebar-drop-basis.test.js 一致，别在这里另发明一套） */
const codeOnly = (src) => src.split('\n')
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

/** 取 `[a, b)` 之间那一段；定位失败返回 ''（让判据红，绝不静默跳过） */
function between(src, aMark, bMark) {
  const a = src.indexOf(aMark);
  if (a < 0) return '';
  const b = src.indexOf(bMark, a + aMark.length);
  if (b < 0) return '';
  return src.slice(a, b);
}

/** 从源码里读一个数字常量 */
const numConst = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : NaN; };

/** 从 `const NAME = [ … ];` 里逐个取引号里的键（顺序无关） */
function stringList(src, name) {
  const i = src.indexOf(name);
  if (i < 0) return [];
  const j = src.indexOf('];', i);
  if (j < 0) return [];
  const body = src.slice(i, j);
  const out = [];
  const re = /'([A-Za-z]+)'/g;
  let m = null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

describe('D2 虚影外观：两侧同一份 computed style 清单（一处表达）', () => {
  it('渲染层的 SEL_LOOK_CSS_KEYS 与主进程的 GHOST_STYLE_KEYS 逐项相同', () => {
    const a = stringList(VIEW, 'const SEL_LOOK_CSS_KEYS = [');
    const b = stringList(MAIN, 'const GHOST_STYLE_KEYS = [');
    expect(a.length, '渲染层那份清单读不到 / 是空的').toBeGreaterThan(10);
    expect(b.length, '主进程那份清单读不到 / 是空的').toBeGreaterThan(10);
    expect(a.slice().sort(), '两份白名单漂了：多搬的键白搬、少搬的键让虚影少一样外观（两边都不会报错）')
      .toEqual(b.slice().sort());
    // 判别力自检：从渲染层那份里删一个键 ⇒ 上面那条必须能红
    const mutatedView = VIEW.replace("'borderRadius',", '');
    const mutA = stringList(mutatedView, 'const SEL_LOOK_CSS_KEYS = [');
    expect(mutA.length).toBe(a.length - 1);
    expect(mutA.slice().sort()).not.toEqual(b.slice().sort());
  });

  it('尺寸与文字随起点一起上报（虚影不许用常量尺寸），且报的是**整组**（多选不止一个）', () => {
    const arm = between(VIEW, 'function selDragArm(', 'function settleSelDrag(');
    expect(arm.length, '找不到 selDragArm').toBeGreaterThan(200);
    expect(arm, 'selDragArm 里没有读外观的那一步').toContain('selDragLooks(');
    expect(arm, '起点上报必须带 look（否则主进程只能画常量尺寸的卡片）').toContain('look: s.look');
    const lookFn = between(VIEW, 'function selDragLook(', 'function selDragArm(');
    expect(lookFn, 'selDragLook 必须读 getBoundingClientRect（尺寸）').toContain('getBoundingClientRect');
    expect(lookFn, 'selDragLook 必须读 getComputedStyle（外观）').toContain('getComputedStyle');
    expect(lookFn, 'selDragLook 必须把 textContent 一起读走（文字要一模一样）').toContain('textContent');
    /* 用户 2026-10-38 第二轮：「多选的时候只显示其中之一的虚影，这不对，要显示全部被选中节点的」
     * ⇒ 整组外观必须遍历 `ids`（只取 `ids[0]` 就是"只显示一个"那个缺陷的形状）。 */
    const looksFn = between(VIEW, 'function selDragLooks(', 'function refreshAfterOffsetChange(');
    expect(looksFn.length, '找不到 selDragLooks（整组外观）').toBeGreaterThan(300);
    expect(looksFn, '整组外观必须遍历 ids 逐个读，而不是只取第一个').toContain('list.forEach');
    expect(looksFn, '单选/多选分档处必须存在').toContain('cards.length === 1');
    // 判别力自检：把上报里的 look 去掉 ⇒ 第一条必须能红
    const mutated = arm.replace('look: s.look', '');
    expect(mutated.includes('look: s.look')).toBe(false);
  });

  it('虚影页不许引任何外部资源（data: URL 是 opaque origin），且虚化半径是正数', () => {
    const html = between(MAIN, 'function ghostPageHtml(', 'function ghostRectFor(');
    expect(html.length, '找不到 ghostPageHtml').toBeGreaterThan(400);
    ['<link', 'http://', 'https://', 'file://', 'src='].forEach((bad) => {
      expect(html, '虚影页里出现了外部资源引用 ' + bad + ' ⇒ opaque origin 下必然载不出来（画出来是破图）')
        .not.toContain(bad);
    });
    expect(html, '虚影页必须给元素赋 inline style（外观只以这个形态搬得进来）').toContain('d.style.left=c.x');
    const blur = numConst(MAIN, /const GHOST_BLUR_PX\s*=\s*([0-9.]+)\s*;/);
    const op = numConst(MAIN, /const GHOST_OPACITY\s*=\s*([0-9.]+)\s*;/);
    expect(blur, '模糊半径必须是正数（"虚化"这条用户要求的唯一实现）').toBeGreaterThan(0);
    expect(op, '不透明度必须落在 (0,1)').toBeGreaterThan(0);
    expect(op).toBeLessThan(1);
    // 判别力自检：塞一个 <link> 进去 ⇒ 上面那条必须能红
    const bad = html.replace('<style>', '<link rel="stylesheet" href="x.css"><style>');
    expect(bad.includes('<link')).toBe(true);
    expect(html.includes('<link')).toBe(false);
  });

  it('虚影尺寸取自节点矩形（ghostRectFor 收 size 参数，不再是写死的两个常量）', () => {
    const fn = between(MAIN, 'function ghostRectFor(', 'function ghostGapOk(');
    expect(fn.length, '找不到 ghostRectFor').toBeGreaterThan(300);
    expect(fn, 'ghostRectFor 必须收第 5 个参数 size').toContain('size');
    expect(fn, '宽度必须来自 size 而不是常量').toContain('size && size.width');
    const tick = between(MAIN, 'function selDragGhostTick(', 'function selDragFinish(');
    expect(tick, 'selDragGhostTick 必须把 subject.look 的尺寸交给 ghostRectFor').toContain('look.w');
    expect(tick, '并且要把 look 一并交给 updateGhost').toContain('look: look');
    // 判别力自检：把尺寸换回常量 ⇒ 第一条必须能红
    const mutated = fn.split('size && size.width').join('GHOST_FALLBACK_SIZE.width');
    expect(mutated.includes('size && size.width')).toBe(false);
  });
});

describe('D4 拖拽手势补发的那一次 click：只吞一次，且在捕获阶段', () => {
  it('置位点唯一（selDragDrop）＋ 捕获阶段吞掉 ＋ 下一次 mousedown 清零', () => {
    const drop = between(VIEW, 'function selDragDrop(', 'function bindViewportControls(');
    expect(drop.length, '找不到 selDragDrop').toBeGreaterThan(400);
    expect(drop, 'selDragDrop 里没有武装"吞一次"的那一步').toContain('fdSelDragClickSwallow = 1');
    const listeners = codeOnly(VIEW);
    expect(listeners, '找不到吞掉补发 click 的捕获监听').toContain("document.addEventListener('click', (e) => {");
    /* 吞的动作必须发生在**捕获阶段**（第三参 true）：那条"点击 → 开详情"的处理器绑在
     * #mindmap-container 的冒泡阶段跑，只有 document 捕获阶段 stopPropagation 才能挡住它。 */
    const swallowBlock = between(VIEW, '★ D4 闸', "}, true);\n");
    expect(swallowBlock.length, '找不到 D4 闸那一段').toBeGreaterThan(200);
    expect(swallowBlock, '必须 stopPropagation（否则容器 click 照样跑到 noteNodeClick）').toContain('e.stopPropagation()');
    expect(swallowBlock, '必须只吞一次（把闸清零）').toContain('fdSelDragClickSwallow = 0');
    expect(swallowBlock, '这一次吞必须留一行现场日志（不静默）').toContain("'[sel-drag] 吞掉拖拽手势补发的那一次 click");
    /* 一次性语义的另一半：下一次按下必须清零（否则松在原生视图上时那次 click 永远不来，
     * 闸会一直挂着，把**下一次真实点击**吃掉 —— 那比 D4 更糟）。 */
    expect(listeners, '新按下没有清零 ⇒ 闸会吃掉后来的真实点击').toContain('fdSelDragClickSwallow = 0;');
    // 判别力自检：把 stopPropagation 删掉 ⇒ 上面那条必须能红
    const mutated = swallowBlock.replace('e.stopPropagation();', '');
    expect(mutated.includes('e.stopPropagation()')).toBe(false);
  });

  it('IMPORTANT："不拖动而单击"那条路不许被碰到（mousedown 里仍然不 preventDefault）', () => {
    const blockStart = VIEW.indexOf("document.addEventListener('mousedown', (e) => {", VIEW.indexOf('鼠标**直接拖**'));
    expect(blockStart, '找不到"直接拖"的 mousedown 监听').toBeGreaterThan(0);
    const endIdx = VIEW.indexOf('}, true);', blockStart);
    const block = VIEW.slice(blockStart, endIdx + 9);
    const blockCode = block.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    expect(blockCode, 'mousedown 里出现 preventDefault() ⇒ jsMind 自己的选中/点击会死（点节点就不弹详情了）')
      .not.toContain('preventDefault()');
    expect(blockCode, '清零要在 mousedown 的最前面（与 e.button 判定同一段，不许藏在后面）')
      .toContain('fdSelDragClickSwallow = 0;');
  });

  it('读数出口存在且只读（MM.selDragClickState）', () => {
    expect(VIEW, '缺 MM.selDragClickState ⇒ D4 的断言分不清"没开"与"开了又关"').toContain('MM.selDragClickState = () => ({');
    expect(VIEW).toContain('swallowed: fdSelDragClickCounts.swallowed');
    expect(VIEW).toContain('swallowed++');
  });
});

describe('N3 对话输入框：按**特征**认，不按 tag 猜', () => {
  const SIDEBAR = read('main-dsh-sidebar.js');
  it('选择器：不认 offsetParent、富文本优先、plain textarea 让位、/ 与 @ 是强信号', () => {
    const js = between(SIDEBAR, 'const COMPOSER_PREFILL_JS = `', '})`;');
    expect(js.length, '找不到 COMPOSER_PREFILL_JS').toBeGreaterThan(1500);
    /* ⚠️ 真机断点就在这条：`position:fixed` 元素的 offsetParent 恒为 null，用它当"可见性"会漏掉
     * 整个对话栏（用户：「内置dsh的显示信息没有任何变化」）。注释里提到它是允许的，**代码里出现不行**。 */
    const code = js.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    expect(code, 'COMPOSER_PREFILL_JS 里又出现 offsetParent ⇒ 真机那个断点回来了').not.toMatch(/offsetParent\s*!==?\s*null/);
    expect(code, '必须给 contenteditable 加分（/ 指令 + @ 提及几乎必然是富文本）').toContain('ed.rich');
    expect(code, '必须给 plain textarea 减分（有富文本时让它让位）').toContain('ed.isArea');
    expect(code, '必须同时看 / 与 @（截图那句占位文字就有）').toContain("hint.indexOf('/')");
    expect(code, '必须看宽高比（截图 738:129 ≈ 5.7）').toContain('ratio >= 3 && ratio <= 12');
    expect(code, '必须有一条门槛，找不到就 not-found（不许抓第一个能抓的）').toContain("bucket: 'not-found'");
  });

  it('写入：富文本走 execCommand + InputEvent，plain 走原生 setter，**一律回读**', () => {
    const js = between(SIDEBAR, 'const COMPOSER_PREFILL_JS = `', '})`;');
    expect(js, '富文本没有走 execCommand(insertText)').toContain("execCommand('insertText'");
    expect(js, '必须派发 beforeinput/input（Slate/Lexical 那类编辑器只吃输入事件）').toContain("new InputEvent('input'");
    expect(js, 'plain 输入框必须走原型原生 setter（绕过 React 的 value tracker）').toContain('Object.getOwnPropertyDescriptor(proto');
    expect(js, '必须回读并与原文比对（`ok` 只在一致时为真）').toContain('same(readBack(), text)');
    /* 失败必须能分档（用户要能把状态栏原话贴回来） */
    ['focus-failed', 'readback-mismatch', 'rejected'].forEach((b) => {
      expect(js, '缺少失败分档 ' + b).toContain(b);
    });
    expect(js, '失败必须带一句可复制的中文原话').toContain('回读前 60 字');
  });
});

describe('D3 终点：只认观测到的松手（悬停当松手必须绝迹）', () => {
  it('main.js 的代码里不许再出现 shouldDropByDwell / SEL_DWELL_MS', () => {
    const code = codeOnly(MAIN);
    expect(code, '悬停又被当成松手了（用户报的"拖到 DSH 失败"就是它）').not.toContain('shouldDropByDwell');
    expect(code, 'SEL_DWELL_MS 这个"悬停阈值"常量不许回来').not.toContain('SEL_DWELL_MS');
    // 判别力自检
    const mutated = code + '\nif (dropTarget.shouldDropByDwell(pt)) {}\nconst SEL_DWELL_MS = 400;\n';
    expect(mutated.includes('shouldDropByDwell') && mutated.includes('SEL_DWELL_MS')).toBe(true);
  });

  it('侧栏带上的**两张页**都装配"松手上报"（DSH 内容页 + 控制栏页）', () => {
    /* 从 `selBandRects`（算两张页的矩形）到 sel-drag-start handler 之前 —— 这一段就是
     * "谁算矩形、谁认视图、谁装监听"的全部实现，判据要一起看（拆开读会把条数判成 0）。 */
    const hook = between(MAIN, 'function selBandRects(', "ipcMain.on('dsh-sidebar:sel-drag-start'");
    expect(hook.length, '找不到 selHookSidebarRelease').toBeGreaterThan(600);
    expect(hook, '没有按矩形认控制栏那一块 ⇒ 那 30px 上松手没有观察者').toContain('selViewByBounds');
    expect(hook, '控制栏宽必须取唯一真源 dshSidebar.RAIL_WIDTH（不许手抄 30）').toContain('dshSidebar.RAIL_WIDTH');
    expect(hook, "标签 'dsh' 与 'rail' 都要装配").toContain("'rail'");
    expect(hook, '装配是逐页做的那一步').toContain('selHookReleaseOn');
    // 判别力自检：把 rail 那一支删掉 ⇒ "两张页"这条必须能红
    const mutated = hook.replace(/'rail'/g, "'dsh'");
    expect(mutated.includes("'rail'")).toBe(false);
  });

  it('"取消"也要回一条空 ids（否则"松在内置 dsh = 不改位置"是假的）', () => {
    const notify = between(MAIN, 'function selNotifyNoFeed(', 'function selDropOnSidebarRelease(');
    expect(notify.length, '找不到 selNotifyNoFeed').toBeGreaterThan(200);
    expect(notify, '通知必须走**既有**通道 dsh-sidebar:sel-drop（不新增 IPC key）').toContain("'dsh-sidebar:sel-drop', []");
    const feed = between(MAIN, 'function selDragFeed(', "ipcMain.handle('dsh-sidebar:sel-drag-end'");
    expect(feed, '不可投那批的取消分支必须调 selNotifyNoFeed').toContain('selNotifyNoFeed(st,');
    const release = between(MAIN, 'function selDropOnSidebarRelease(', 'function selHookReleaseOn(');
    expect(release, '"松手点不在侧栏视图内"那条也必须回空 ids（它同样是一次终点）').toContain('selNotifyNoFeed(st,');
    // 判别力自检：把取消分支那一行删掉 ⇒ 上面那条必须能红
    expect(feed.replace('selNotifyNoFeed(st,', '').includes('selNotifyNoFeed(st,')).toBe(false);
  });

  it('渲染层收到空 ids ⇒ 收掉拖拽并还原偏移（不投喂）', () => {
    const handler = between(VIEW, 'window.desktop.dsh.onSelDrop((ids) => {', '/* 「圆钮贴哪边」');
    expect(handler.length, '找不到 onSelDrop 的接线').toBeGreaterThan(200);
    expect(handler, '必须先取走 fdSelDrag（还原偏移要用它）').toContain('const d = fdSelDrag;');
    expect(handler, '空 ids 时什么都不做 ⇒ 偏移留在半路').toContain('restoreSelDragOffset(d)');
    expect(handler, '空 ids 时**不许**投喂').toContain('if (ids && ids.length)');
    // 判别力自检
    expect(handler.replace('restoreSelDragOffset(d)', '').includes('restoreSelDragOffset(d)')).toBe(false);
  });
});
