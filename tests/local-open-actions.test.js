/* ============================================================
 * tests/local-open-actions.test.js — 「本机链接怎么打开」的判据（vitest，**零 Electron / 零 I/O**）
 * ------------------------------------------------------------
 * 用户 2026-10-31 的三条要求（`localPath` 从"目录快捷方式"扩成"本机**文件或目录**"之后）：
 *   W1 左键：**系统默认程序**打开；没有默认关联时**系统自己弹「打开方式」**；已有默认 ⇒ 直接开（不打扰）。
 *   W2 右键：菜单**恰好四项** —— 打开 / 打开方式 / 在文件资源管理器中打开 / 取消链接。
 *   W3 四项**各自真的做那件事**（尤其"打开方式"必须是**系统选择栏**，不是"直接打开"）。
 *
 * 本文件是两个"最容易做假的地方"的机械判据（父批点名的两条）：
 *   ① **"打开方式"被写成"再打开一次"** —— 那种实现不报错、界面无异常，用户要的那一栏却没出现。
 *      ⇒ 本文件把 `openPlan('openAs')` 的产物钉成 `via:'openAs' + spawn.argv 精确 + openPath:false`；
 *        再用**结构判据**钉住 `main.js` 的 openAs 分支**只**起进程、**不**碰 `shell.openPath`。
 *   ② **"在文件资源管理器中打开"对文件也去 `openPath`** —— 那是"打开文件"，不是"定位它"。
 *      ⇒ 文件 ⇒ `showItemInFolder:true` + `openPath:false`；目录 ⇒ 反过来。
 *
 * 另一半是**结构判据**（防"以后有人改回去"）：
 *   · `default` 档（既有调用方的编辑器档，`app:open-file` 是热路径）**直连** `openWithEditor`，
 *     代码里**不出现** `openPlan` / `execOpenPlan`；
 *   · `execOpenPlan` 里**不出现** `plan.via === 'editor'`（那会变成一条没人走、却看起来在用的死支）；
 *   · 四项菜单**只有一份实现**（`renderer/contextmenu.js` 的 `localPathItems`），
 *     节点右键与详情框那条链接的右键**都用它**，且**没有**第五项、旧的那一项也不许并存。
 *
 * ⚠️ 真"弹一次系统对话框"**不在这里验**（也会在跑测试的机器上抢焦点）：
 *    主进程侧那一跳由 `scripts/smoke/16-local-path.js` 用可替换执行器取证（`ctx.openImpl`）。
 *    本文件只保证**动作选择**与**命令长相**错不了 —— 这两样是"假实现"最先破的地方。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OPEN_MODES, openPlan, openAsCommand } from '../src/path-chain.js';

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥注释（结构断言用；只求"代码里有没有"，不求精确语法分析 —— 与 tests/path-chain.test.js 同一做法） */
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FILE = 'C:\\资料\\一 个 文件.aimmtest';
const DIR = 'C:\\资料\\一个目录';

/* ============================================================
 * A 组 · `src/path-chain.js` 的动作选择（纯函数：mode → 用哪个执行器）
 * ============================================================ */
describe('A · 打开动作的选择表（OPEN_MODES / openPlan）', () => {
  it('A1 `OPEN_MODES` 是闭环四档，且默认档排在第一（缺省 = 既有行为）', () => {
    expect(OPEN_MODES).toEqual(['default', 'system', 'openAs', 'reveal']);
  });

  it('A2 ★「打开方式」= 起 `rundll32 …OpenAs_RunDLL`，**不是**再打开一次（`openPath` 必须为 false）', () => {
    const p = openPlan('openAs', FILE, false);
    expect(p.ok).toBe(true);
    expect(p.via).toBe('openAs');
    // ⭐ 这三条合起来就是"它不是 shell.openPath"：argv 精确 + 两个别的执行器都没被选
    expect(p.spawn).toEqual({ file: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', FILE] });
    expect(p.openPath).toBe(false);
    expect(p.showItemInFolder).toBe(false);
  });

  it('A3 `openAsCommand` 是命令的唯一构造处：argv 数组形态（不拼命令行字符串）', () => {
    const c = openAsCommand(FILE);
    expect(c.file).toBe('rundll32.exe');
    expect(Array.isArray(c.args)).toBe(true);
    expect(c.args).toEqual(['shell32.dll,OpenAs_RunDLL', FILE]);
    // 含空格/中文的路径**原样**是一个 argv 元素（拼命令行字符串就会在这里出问题）
    expect(c.args[1]).toBe(FILE);
    expect(c.args.join(' ')).not.toContain('"');       // 引号由 spawn 负责，不是我们拼
  });

  it('A4 左键·系统默认程序：文件与目录**都**走 `shell.openPath`（目录 = 文件管理器，既有行为）', () => {
    const f = openPlan('system', FILE, false);
    expect(f).toMatchObject({ ok: true, via: 'openPath', openPath: true, showItemInFolder: false, spawn: null });
    const d = openPlan('system', DIR, true);
    expect(d).toMatchObject({ ok: true, via: 'openPath', openPath: true, showItemInFolder: false, spawn: null });
  });

  it('A5 ★「在文件资源管理器中打开」文件 ⇒ `showItemInFolder`（**选中它**），不许去 `openPath`', () => {
    const p = openPlan('reveal', FILE, false);
    expect(p.ok).toBe(true);
    expect(p.via).toBe('reveal');
    expect(p.showItemInFolder).toBe(true);
    expect(p.openPath).toBe(false);       // ← 反过来（文件也 openPath）就是"打开文件"而不是"定位它" ✗
    expect(p.spawn).toBeNull();
  });

  it('A6 「在文件资源管理器中打开」目录 ⇒ 打开那个目录（`openPath`），不调 `showItemInFolder`', () => {
    const p = openPlan('reveal', DIR, true);
    expect(p).toMatchObject({ ok: true, via: 'openPath', openPath: true, showItemInFolder: false });
  });

  it('A7 没探到类型（`isDir:null`）时 reveal 按**文件**处理（执行前主进程已因 stat 失败响亮报错）', () => {
    expect(openPlan('reveal', FILE, null)).toMatchObject({ via: 'reveal', showItemInFolder: true, openPath: false });
    expect(openPlan('reveal', FILE, undefined).via).toBe('reveal');
  });

  it('A8 缺省 / 空串 ⇒ `default`（既有编辑器档），且它**不选**任何系统执行器', () => {
    [undefined, null, ''].forEach((m) => {
      const p = openPlan(m, FILE, null);
      expect(p).toMatchObject({ ok: true, mode: 'default', via: 'editor',
        openPath: false, showItemInFolder: false, spawn: null });
    });
  });

  it('A9 未知 mode ⇒ **响亮** reject（不静默落回某一档 —— 那等于"以为在用这一档、其实没有"）', () => {
    const p = openPlan('openwith', FILE, false);
    expect(p.ok).toBe(false);
    expect(p.code).toBe('open-bad-mode');
    expect(String(p.reason)).toContain('OPEN_MODES');
    expect(String(p.reason)).toContain('openwith');
  });

  it('A10 目标不是非空字符串 ⇒ reject（不许拿一个空串去起进程/打开）', () => {
    [undefined, null, '', '   ', 123].forEach((t) => {
      const p = openPlan('system', t, false);
      expect(p.ok, String(t)).toBe(false);
      expect(p.code).toBe('open-no-target');
      expect(String(p.reason).length).toBeGreaterThan(0);
    });
  });

  it('A11 纯函数：同一输入恒等输出，且**不改**入参（判据可被反复调用）', () => {
    const a = openPlan('reveal', FILE, false);
    const b = openPlan('reveal', FILE, false);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);                        // 每次一个新对象（调用方随便改，不串台）
    const args = openAsCommand(FILE).args.slice();
    openAsCommand(FILE).args.push('x');
    expect(args).toEqual(['shell32.dll,OpenAs_RunDLL', FILE]);
  });
});

/* ============================================================
 * B 组 · 主进程结构判据（`default` 档逐字等价 / 没有死支 / 三档真的分叉）
 * ============================================================ */
describe('B · `main.js` 的结构判据（默认档直连 / 无 editor 死支 / openAs 只起进程）', () => {
  const mainSrc = stripComments(read('main.js'));
  /** `app:open-file` 这个 handler 的体（从它的 `ipcMain.handle` 到下一个 `ipcMain.handle` 之前） */
  const handlerBody = (() => {
    const at = mainSrc.indexOf("ipcMain.handle('app:open-file'");
    expect(at, 'main.js 里找不到 app:open-file（出口改名了？）').toBeGreaterThan(-1);
    const next = mainSrc.indexOf('ipcMain.handle(', at + 10);
    expect(next, 'app:open-file 后面找不到下一个 handler（结构变了，请更新本判据）').toBeGreaterThan(at);
    return mainSrc.slice(at, next);
  })();
  const count = (s, sub) => s.split(sub).length - 1;

  it('B1 ★ `default` 档**直连** `openWithEditor`：整个 handler 里 `openPlan` / `execOpenPlan` 各只出现一次', () => {
    expect(count(handlerBody, 'pathChain.openPlan(')).toBe(1);
    expect(count(handlerBody, 'execOpenPlan(')).toBe(1);
    // 直连 = 既有实现仍在、且排在那唯一一次 execOpenPlan 之后（= 默认档的收尾）
    expect(count(handlerBody, 'openWithEditor(')).toBe(1);
    expect(handlerBody.indexOf('openWithEditor(')).toBeGreaterThan(handlerBody.indexOf('execOpenPlan('));
  });

  it('B2 ★ 新分支只收**非 default**：statSync / openPlan / execOpenPlan 都在 `wantMode !== \'default\'` 之后', () => {
    const guard = handlerBody.indexOf("wantMode !== 'default'");
    expect(guard, "找不到 `wantMode !== 'default'` 这条守卫").toBeGreaterThan(-1);
    ['fs.statSync(', 'pathChain.openPlan(', 'execOpenPlan('].forEach((token) => {
      const at = handlerBody.indexOf(token);
      expect(at, token + ' 不在 handler 里').toBeGreaterThan(-1);
      expect(at, token + ' 跑到 default 档前面去了（默认档被路由进新分支 ✗）').toBeGreaterThan(guard);
    });
  });

  it('B3 ★ `execOpenPlan` 里**没有** `plan.via === \'editor\'`（死支不许回来）', () => {
    expect(mainSrc.includes("plan.via === 'editor'"), 'execOpenPlan 里又出现了 editor 分支（死支回来 ✗）').toBe(false);
    // 两档显式分支 + reveal 那一支是**收尾的兜底**（它没有 `if (plan.via === 'reveal')`）
    ['openPath', 'openAs'].forEach((v) => {
      expect(mainSrc.includes("plan.via === '" + v + "'"), "execOpenPlan 少了 via === '" + v + "' 这一档").toBe(true);
    });
    expect(mainSrc.includes("exec: 'showItemInFolder'"), 'reveal 那一支没有自己的 exec 标识（等于没说清谁执行的）').toBe(true);
  });

  it('B4 ★ 「打开方式」那一支**只**起进程：`launchDetached(plan.spawn.file, plan.spawn.args, …)`，且这一段不碰 `shell.openPath`', () => {
    expect(mainSrc.includes('launchDetached(plan.spawn.file, plan.spawn.args'), 'openAs 没走 launchDetached(argv 数组形态)').toBe(true);
    const at = mainSrc.indexOf("plan.via === 'openAs'");
    const tail = mainSrc.slice(at, mainSrc.indexOf("const stub = stubOf('reveal')", at));
    expect(tail.length, 'openAs 那一支切不出代码段（结构变了，请更新本判据）').toBeGreaterThan(50);
    expect(tail.includes('launchDetached('), 'openAs 那一支没起进程').toBe(true);
    expect(tail.includes('openPath'), 'openAs 那一支碰到了 openPath（"起不来就偷偷降级成再打开一次" ✗）').toBe(false);
  });

  it('B5 ★ 「在资源管理器里定位」那一支用的是 `showItemInFolder`（不是 openPath）', () => {
    const revealAt = mainSrc.indexOf("const stub = stubOf('reveal')");
    expect(revealAt, "找不到 reveal 的执行段（const stub = stubOf('reveal')）").toBeGreaterThan(-1);
    const tail = mainSrc.slice(revealAt, mainSrc.indexOf('ipcMain.handle(', revealAt));
    expect(tail.includes('shell.showItemInFolder('), 'reveal 那一支没用 showItemInFolder').toBe(true);
    expect(tail.includes('shell.openPath('), 'reveal 那一支用了 openPath（那是"打开文件"，不是"定位它" ✗）').toBe(false);
  });

  it('B6 出口调用账记全了"计划 + 真实执行器"（否则断言只能证明"调了出口"、证不了"调对了档"）', () => {
    ['openMode:', 'via:', 'argv:', 'openPath:', 'showItemInFolder:', 'isDir:', 'exec:']
      .forEach((k) => expect(handlerBody, '账本少了字段 ' + k).toContain(k));
  });

  it('B7 `shell.openPath` 的**返回值**必须原样带回（空串 = 成功，非空串 = 失败原因）', () => {
    // 判据形态是 `ok: !r, err: r || null`：把返回值吞掉（写 ok:true）就会在这里红
    expect(mainSrc).toContain('return { ok: !r, err: r || null, exec: \'openPath\' }');
  });
});

/* ============================================================
 * C 组 · 渲染层结构判据（四项唯一实现 / 恰好四项 / 不许假成功 / 不碰 Electron）
 * ============================================================ */
describe('C · `renderer/` 的结构判据（四项一份、恰好四项、不许假成功）', () => {
  const menu = stripComments(read('renderer/contextmenu.js'));
  const detail = stripComments(read('renderer/app-detail-content.js'));
  const appJs = stripComments(read('renderer/app.js'));

  it('C1 ★ 四项标签**逐字**、顺序即用户说的那个顺序，且**恰好四项**', () => {
    const at = menu.indexOf('function localPathItems(');
    expect(at, 'renderer/contextmenu.js 里没有 localPathItems（四项的唯一实现）').toBeGreaterThan(-1);
    const body = menu.slice(at, menu.indexOf('function nodeMenu(', at));
    const labels = (body.match(/label: '([^']*)'/g) || []).map((s) => s.slice(8, -1));
    expect(labels).toEqual(['打开', '打开方式', '在文件资源管理器中打开', '取消链接']);
    expect(labels.length).toBe(4);              // 多一项（例如"复制路径"）= 用户明确说"只需要"的那条被破 ✗
    expect(body).not.toContain('复制路径');
  });

  it('C2 四项**只有一份实现**：节点右键与详情框那条链接的右键都调 `localPathItems`', () => {
    // 节点右键：走 localPathItems
    expect(menu).toContain('localPathItems(lp, nodeId)');
    // 详情框那条链接的右键：也走它（同一个函数，不是第二份四项）
    expect(detail).toContain('MMContextMenu.localPathItems(lp, node.id)');
    // 旧的「📁 打开文件夹」那一项**已被取代**，不许与四项并存
    expect(menu).not.toContain('打开文件夹');
  });

  it('C3 ①打开 与左键**同一个函数**：`openLocalPath`（渲染层只此一处实现，app.js 只转发）', () => {
    expect(count(detail, 'async function openLocalPath(')).toBe(1);
    expect(detail).toContain('MM.openLocalPath = openLocalPath');
    expect(appJs).toContain('openLocalPath: (p, opts) => MM.openLocalPath(p, opts)');
    // 其余模块只许转发/调用，不许再写一份"打开本机路径"
    ['renderer/app-media.js', 'renderer/contextmenu.js'].forEach((f) => {
      expect(stripComments(read(f))).not.toContain('async function openLocalPath(');
    });
  });

  it('C4 ②打开方式 / ③资源管理器 是**两个不同的 mode**（不是同一个动作换个标签）', () => {
    const at = menu.indexOf('function localPathItems(');
    const body = menu.slice(at, menu.indexOf('function nodeMenu(', at));
    expect(body).toContain("run('openAs')");
    expect(body).toContain("run('reveal')");
    expect(body).not.toContain("run('openAs').action = run('reveal')");
  });

  it('C5 ★ **不许假成功**：请求 openAs/reveal 时若主进程回报的 `via` 不匹配 ⇒ 状态栏响亮报"没接线"', () => {
    // 期望值表（每档"必须由哪个执行器完成"）——`system` 刻意不在表里，见该常量的注释
    expect(detail.includes('LP_EXPECT_VIA'), '找不到 LP_EXPECT_VIA（期望执行器表）').toBe(true);
    expect(detail.includes("openAs: ['openAs']"), "LP_EXPECT_VIA 少了 openAs 那一档").toBe(true);
    expect(detail.includes("reveal: ['reveal', 'openPath']"), "LP_EXPECT_VIA 少了 reveal 那一档").toBe(true);
    // ⭐ 守卫**真的被用上**（只是"常量存在"不算 —— 那正是空转的样子）：
    //    查表取期望 + 拿到主进程回报的 `via` 去比 + 不匹配就 return（不是继续报"已打开"）
    expect(detail.includes('const needVia = LP_EXPECT_VIA[mode] || null;'),
      '守卫没查表（期望值没按 mode 取 ⇒ 这条判据是空转的）').toBe(true);
    expect(detail.includes("if (needVia && needVia.indexOf(r.via || '') < 0) {"),
      '守卫没拿主进程回报的 via 去比（假成功不会被拦）').toBe(true);
    expect(detail.includes('还没接线'), '不匹配时没有响亮文案').toBe(true);
  });

  it('C6 ④取消链接 走**既有保存通道**（`MMApp.save()`），不是自造一份写盘', () => {
    const at = detail.indexOf('async function clearLocalPath(');
    expect(at).toBeGreaterThan(-1);
    const body = detail.slice(at, detail.indexOf('/* —— 本文件定义的东西挂到共享命名空间 —— */', at));
    expect(body).toContain('delete node.data.localPath');
    expect(body).toContain('window.MMApp.save()');
    expect(body).not.toContain('project.save(');        // 不许绕过 MMApp.save 直接打 IPC（那会跳过冲突保护）
  });

  it('C7 渲染层**不直接调 Electron**：`shell.openPath` / `shell.showItemInFolder` / `rundll32` 一个都不许出现', () => {
    ['renderer/contextmenu.js', 'renderer/app-detail-content.js', 'renderer/app.js', 'renderer/app-media.js']
      .forEach((f) => {
        const src = stripComments(read(f));
        expect(src, f + ' 里出现了 shell.openPath（渲染层拿不到 Electron，出现就是假实现）').not.toContain('shell.openPath');
        expect(src, f + ' 里出现了 showItemInFolder').not.toContain('showItemInFolder');
        expect(src, f + ' 里出现了 rundll32（它只许在主进程）').not.toContain('rundll32');
      });
  });

  it('C8 左键缺省 = `system`（系统默认程序）：不传 mode 的调用不许退化成别的档', () => {
    const at = detail.indexOf('async function openLocalPath(');
    const body = detail.slice(at, detail.indexOf('const LP_ACTION_TEXT', at));
    expect(body).toContain("const mode = (opts && opts.mode) || 'system';");
    expect(body).toContain('mode: mode');               // 一路递到 IPC（不许在这里被丢掉）
  });
});

function count(s, sub) { return s.split(sub).length - 1; }
