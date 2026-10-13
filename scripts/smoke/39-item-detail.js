/* ============================================================
 * scripts/smoke/39-item-detail.js —— 条目层（v3）在详情框里的呈现 + "保存/撤销不丢条目"
 * ------------------------------------------------------------
 * ## 这个域防的是哪几种损害（每条断言都对应一种，写在这里给接手者）
 *
 * ① **同一事实两处表达 ⇒ 必漂移**（契约 `docs/ITEM-MODEL.md` §2/§12 点名给界面流的那一句）：
 *    `detail` 是 `renderDetail(items)` 的**落盘派生缓存**，渲染路径**不许改**。若界面上再按
 *    `items` 拼一份正文，两份迟早不一样（改条目后正文没跟着变 / 反之）。
 *    ⇒ 断言 ①②把"正文与 CLI 的 `detail` **同源**"钉成机械判据：正文里只允许出现**属性**级的
 *      条目装饰（`data-item-id`/`data-item-no`/`class`）；把它们撤掉之后，正文 DOM 必须
 *      **逐字节等于** CLI `get --json --detail` 的那一份（两侧都过浏览器自己的解析器再比）。
 *
 * ② **未条目化节点被顺带改样**（观感回归）：本轮动了详情框的渲染入口，v2 节点必须**一字不变**。
 *    ⇒ 断言②（含"同一个框先后显示两个节点"这条真机路径：跟随框是**复用**的，不留上一位的痕迹）。
 *
 * ③ **界面保存把整层条目静默抹掉**（本项目列为最重的损害类：节点退回 v2、detail 还在 ⇒
 *    **没有任何门禁会红**，而条目级 id/src/verified/tags 永久丢失）。根因是 `renderer/app-core.js`
 *    的 `serializeTree()` 是**手挑字段**的（qa / localPath / origin 都栽过同一个坑）。
 *    ⇒ 断言⑤⑥（保存后盘上 items 逐字节不变 + 撤销/重做后内存里 items 仍在）+ 断言⑦
 *      （把 schema 允许的节点可选字段全挂在一个探针节点上，保存后**一个都不许少** —— 这条是
 *       "手挑字段清单"这类缺陷的**机械判据**，下一个新字段漏了它就会红）。
 *
 * ④ **条目上的出处/核验/标签看不见**（人这一侧没法判断"这条还成不成立"）：
 *    ⇒ 断言③：有 `src`/`verified`/`tags` 就看得见（连"怎么核的"一起给出），没有就**一个字都不显示**
 *      （不造噪音字段）。
 *
 * ⑤ **点一条没反应 / 复制出来的不是"节点id#条目id" / 复制只在窗口有焦点时才成**：
 *    ⇒ 断言④**用真鼠标**（`ctx.input` = `webContents.sendInputEvent`，走 Chromium 命中测试）
 *      点清单行与复制键，并在**主进程**读**系统剪贴板**验证复制值（不采信渲染层自报）。
 *      两点让这条判据不能被"残留值"或"焦点兜底"喂绿：① 点之前先往剪贴板塞一个**哨兵**；
 *      ② 还要求渲染层报的通道是 `how==='desktop-clipboard'`（= 主进程 `clipboard.writeText` 那条，
 *      **与窗口焦点无关**）—— 只判"值对不对"，退回要求焦点的浏览器通道也能偶尔把值写对 ✗。
 *
 * ## 判别力证明（工程纪律：新断言先注入一次违规、确认变红、再撤销）
 * **已实跑的三条**（报文见交付说明；三条都恢复后复绿）：
 *   · **代码级注入**：把 `renderer/app-core.js` 的 `walk()` 里 `out.items` / `out.detailMode`
 *     两行去掉（模拟"手挑字段又漏一个"）⇒ **断言⑤⑥⑦必红**（13/16，exit 1）：
 *       ⑤ `盘上 items 逐字节不变=false｜⚠️ items 被抹掉了：(盘上没有 items)`
 *       ⑥ `撤销后内存 items 仍是那 0 条且逐字节相同=false`
 *       ⑦ `一次界面保存后：丢掉的字段=detailMode,items`
 *     还原后 sha256 逐字节回到原值（`4A6BFC9E…DBC63`）⇒ 16/16 复绿。
 *   · **剪贴板注入（本批新增，正对断言④那条真判据）**：把 `main.js` 的
 *     `ipcMain.handle('app:clipboard-write')` 里那一行 `clipboard.writeText(value)` 换成空操作
 *     （**注入点就是产品真正会走的那一跳** ✓）⇒ **断言④必红**（报文与 sha256 见交付说明）：
 *     注入态下渲染层会退到要求焦点的浏览器通道（本机实测 `execCommand` 偶尔真能写对值）
 *     ⇒ 只靠"值对不对"仍可能绿，**红来自通道判据**：`走的是主进程那条……=false`。
 *     还原后 sha256 逐字节回到原值 ⇒ 16/16 复绿。
 *   · **环境开关**（只认本域的 key，其它一律忽略 ⇒ 默认空时完全不影响正常跑 ✓）：
 *     `MM_SMOKE_INJECT=39-no-items-ser` —— 在**测试侧**把载荷里的 `items` 摘掉再交给保存
 *     （等价于上一条注入，但不动产品代码）。⚠️ **未核实**：本批没有单跑验证这个开关
 *     （只实跑了上面那条代码级注入）。它保留是为了**下次复核**有个不动产品代码的口子。
 *   · **剪贴板三态的判别力证明（本批新增，两个方向各一次 ✓ 报文见交付说明）**：
 *     `MM_SMOKE_INJECT=39-clip-env-up` ⇒ 把**独立探针**打桩成"环境可用"。
 *     本机系统剪贴板已死（见下面「边界」段），"环境可用"这个前提**只能靠打桩补出来** ——
 *     它配合同一次运行里的代码级注入（`main.js` 的 `app:clipboard-write` 里那行
 *     `clipboard.writeText(value)` 换成空操作）就是 (a) 档：**探针可用 + 我们没写进去 ⇒ 必红**
 *     （报文点名"**环境可用**……但我们没写进去 ⇒ 判红：这是产品回归，不是环境问题"）。
 *     `MM_SMOKE_INJECT=39-clip-env-down` ⇒ 把**独立探针**打桩成"环境不可用" ⇒ 必须走"未验证"档
 *     （**既不红、也不计入通过**）。⚠️ 如实登记：**本机真实态与这一档不可分辨**（本机剪贴板真的
 *     不可用 ⇒ 打不打这个桩结果一样）⇒ 它的判别力证明靠"亮出来的三个数"（通过/总数/未验证）而不是
 *     靠与另一种状态对比（同 `H3` 的说明：判定数 < 状态数时要如实说，别假装有对照）。
 *   · **严格档 `MM_SMOKE_CLIP_STRICT` 的判别力证明（2026-10-13 加，本批实跑 ✓ 读数见交付说明）**：
 *     它补的是上面三态**已知的盲区** —— 环境坏的时候，"我们没写进去"这件事**采不到真值**
 *     ⇒ 产品真回归会被**降级成"未验证"**（在 CI / 受控环境里这等于悄悄放过 ✗）。
 *     开关打开时这一档**按失败计**（进失败计数、进总数、退出码 ≠ 0），**但"未验证"仍如实打印、
 *     仍点名原因**；默认（未设 / `0` / `false`）与加它之前**逐字节相同** ✓。
 *     实跑三组：① 打桩环境不可用 + 严格档 ⇒ **exit 1**，报文含"严格档：未验证按失败计"；
 *     ② 环境可用 + 严格档 ⇒ exit 0（**行为不变**：通过 ✓）；③ 注入"严格档只打印不影响计数"
 *     （`scripts/smoke-assertions.js` 的 `tally()` 里那一行 `if (strict) failed++` 去掉）⇒ ①**必红**
 *     （退出码回到 0 = 这条判据在空转）⇒ 还原后 SHA-256 逐字节相同 ⇒ 复绿。
 *     开关值由 `scripts/smoke-assertions.js` 的 `parseStrictEnv` **一处**解析；非法值当场 exit 1。
 * ⚠️ 本域**没有**提供"让条目归属不贴"的注入开关：`fdDecorateItems` 是闭包内的局部函数，
 *    测试侧替换不了（`MM.*` 上没有那个引用）。要它就得让产品代码读环境变量 —— 那比没有更糟。
 *    所以断言①的归属判据靠的是"逐字节同源 + 三处 id 一致"，而不是"能被人为关掉"。
 *
 * ## 探针与自收尾
 * 探针项目 `smoke-item-39`（前缀 `smoke-item-`，按 §4.1 的派发锚点）建在**冒烟沙箱副本**里
 * （`AI_MINDMAP_PROJECTS_DIR`）⇒ 真实 `projects/` 一个字节都不碰；本域**自己建、自己删**
 * （断言⑧：删干净 + 关框 + 切回原项目），不留脏状态给后续域。
 *
 * ## 边界（别以为它比实际更强 ✓）
 *   · 收尾"看得见"的判据只做到 `elementFromPoint` 命中（V1 门禁要求的真判据之一）；
 *     像素级（`scanRegion`）**没有**做 —— 本域不断言"好不好看/够不够显眼"。
 *   · 断言④的真鼠标走的是 Chromium 真实输入管线，但**不是真实硬件**（高 DPI、系统鼠标加速、
 *     多显示器仍只能真机复核）。
 *   · `formatVersion` 的"不降级"判据要求探针项目是 v3（契约：`{2,3}` 都接受）；探针里直接写成 3，
 *     若某天门禁收紧到"v3 必须全节点条目化"，这条会先红 —— 那时改探针，别改判据。
 *   · ⚠️ **系统剪贴板这一档是"三态"（本批改）**：改前的形状是"主进程读到的系统剪贴板 == 期望值
 *     + 通道必须是 `desktop-clipboard`" ⇒ 本机**稳定红**（主进程 `clipboard.writeText()` 之后回读为空；
 *     单跑复现；同机 `Get-Clipboard` 与 `[System.Windows.Forms.Clipboard]::GetText()` **两个独立 API
 *     也全都失败** ⇒ 那一刻**系统剪贴板本身不可用**，不是产品回归）。这条红连着多批把全链按在 13/14。
 *     现在改成：**先用独立探针判环境，再决定这条读数算不算判据**（形状照第八批"撕裂快照指纹
 *     采不到"那一档）——
 *       ① 探针**可用** + 我们没写进去 ⇒ **判红**（真回归，报文点名"环境可用但我们没写进去"）；
 *       ② 探针**不可用**（环境坏）⇒ 响亮打印"剪贴板本项**未验证**"、**不计入通过/总数、不阻断**
 *          （`main.js` 打 `[smoke]` 响亮行；计数见 `scripts/smoke-assertions.js` 的 `tally()`）；
 *       ③ 探针可用 + 写进去了 **且** 通道是 `desktop-clipboard` ⇒ 通过 ✓。
 *     采得到真值时**照旧判红**（`A5`）—— 这一档**没有**"降级成行为级"的口子；变的只是"环境坏"
 *     不再冒充产品缺陷，也不再静默当通过。探针本身与产品链路**无关**（本进程直接 writeText→readText），
 *     否则产品一回归、探针跟着坏，真回归会被洗成"环境问题" ✗。
 *     边界（**别把这一档读得比实际强**）：探针判的是"此刻这份系统剪贴板能不能当证据来源"，
 *     它**答不了**"另一个应用程序能不能粘出这段文本"（剪贴板格式跨进程互操作、剪贴板历史/同步
 *     是 OS 的事）；那几项只能真机人肉复核。
 *   · ⚠️ **三态本身还有一个盲区，得靠环境开关关掉**：环境坏的时候，"我们没写进去"这件事**采不到真值**
 *     ⇒ **产品真回归会被降级成"未验证"**（上面第 ② 档）⇒ 在 CI / 受控环境里等于**悄悄放过** ✗。
 *     要"宁可红，不许悄悄放过"就开 `MM_SMOKE_CLIP_STRICT=1`（**默认关**；语义、判别力证明与读数
 *     见上面「判别力证明」段；开关只改"算不算失败"，**不改原因** —— 环境坏仍然如实点名 ✓）。
 *     它管的是**所有域**的第三态，不是本域专属（名字里的 `CLIP` 只是来历）。
 *   · 断言④仍然**没有**验的：另一个**应用程序**能不能粘出这段文本（剪贴板格式跨进程互操作、
 *     剪贴板历史/同步是 OS 的事）；这几项只能真机人肉复核。
 *   · ⚠️ **域间耦合是实测坑**（`C4` 的落点）：窄跑 `SMOKE_ONLY=39`（并入 `01-core`）⇒ 15/16；
 *     全量 `npm run smoke` ⇒ 205/212，7 条红**全在本域**，其中 6 条只是 `前置失败：节点不在视图：
 *     si39-a` 的级联（连"items 被抹掉 / formatVersion 降级"那条也是它的**后果** —— 窄跑同一条是绿的，
 *     `盘上 items 逐字节不变=true · formatVersion 3→3`）。对策见 `openProjectReady`：打开项目后用
 *     **哨兵节点验证视图**，不在就硬 reload 重开 ⇒ 本域不依赖任何前置域留下的视图状态。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

// 冒烟共用工具（收尾纪律与用法见 scripts/smoke-assertions.js 顶部）：动了 addNode 就要收模态
const mm = require('../smoke-assertions.js');

/** 主进程的系统剪贴板（断言④用它验证"复制值真的进了剪贴板"，而不是只看自报） */
let electronClipboard = null;
try { electronClipboard = require('electron').clipboard || null; } catch (e) { electronClipboard = null; }

/**
 * 读**系统剪贴板**（主进程侧）。
 * ⚠️ Electron 44 的 `clipboard.readText()` 返回的是 Promise（实测：直接 String() 会得到
 * "[object Promise]"）⇒ 同步/异步两种形状都接住，别把"读到 Promise"当成读到内容。
 * 采不到真值一律 `ok:false`（**不许**用 '' 冒充"读到空" —— 那条路径会把"读不到"静默判成"内容不对"）。
 */
async function readClip() {
  if (!electronClipboard || typeof electronClipboard.readText !== 'function') {
    return { ok: false, text: null, error: '本进程拿不到 electron.clipboard' };
  }
  try {
    const v = electronClipboard.readText();
    const t = (v && typeof v.then === 'function') ? await v : v;
    return { ok: true, text: (t === null || t === undefined) ? null : String(t), error: '' };
  } catch (e) { return { ok: false, text: null, error: String((e && e.message) || e) }; }
}

/** 写**系统剪贴板**（主进程侧）：哨兵与"还原原值"用它；失败返回 false（不静默） */
function writeClip(s) {
  try {
    if (!electronClipboard || typeof electronClipboard.writeText !== 'function') return false;
    electronClipboard.writeText(String(s === null || s === undefined ? '' : s));
    return true;
  } catch (e) { return false; }
}

/* ============================================================================
 * 系统剪贴板的**环境可用性探针**（断言④的第一跳；**独立于产品那条链路** ✓）
 * ----------------------------------------------------------------------------
 * ## 为什么需要它（本机实测，2026-10-12）
 * 断言④原先的判据是"真点 ⧉ ⇒ 主进程读到的系统剪贴板 == 期望值 + 通道是 `desktop-clipboard`"，
 * 它在本机**稳定红**：主进程 `clipboard.writeText()` 之后回读为空；单跑复现；而同机
 * `Get-Clipboard` 与 `[System.Windows.Forms.Clipboard]::GetText()`（**两个互不相干的 API**）
 * 也全都失败（`Requested Clipboard operation did not succeed`）⇒ 那一刻**系统剪贴板本身不可用**。
 * 这条红连着多批把全链按在 13/14，而它**既不是产品缺陷、也不该静默当通过** ✗。
 *
 * ## 三态（照第八批"撕裂快照指纹采不到"那一档的形状：采不到真值 ⇒ 响亮的"本项未验证"）
 *   · 探针**可用** + 我们的写没进去 ⇒ **判红**（真回归；报文点名"环境可用但我们没写进去"）；
 *   · 探针**不可用** ⇒ 响亮打印"剪贴板本项**未验证**"、**不参与通过/失败计数、不阻断**
 *     （计数在 `scripts/smoke-assertions.js` 的 `tally()`；`main.js` 打 `[smoke]` 响亮行）；
 *   · 探针可用 + 我们写进去了 **且** 通道是 `desktop-clipboard` ⇒ **通过** ✓。
 *
 * ## 两条硬要求（把探针做坏，这条判据就退化成假的）
 *   ① **必须是独立链路**：探针用**本进程（主进程）自己的** `electron.clipboard` 直接
 *      `writeText(唯一值)` → `readText()` 回读，**绝不走**产品那条 `preload → IPC app:clipboard-write`
 *      —— 拿产品那条链当探针，等于探针与判据共用同一个失效源：产品一回归，探针跟着坏，
 *      判据就会把**真回归**洗成"环境问题" ✗。
 *   ② **它自己也有判别力证明入口**（`MM_SMOKE_INJECT=39-clip-env-up|39-clip-env-down`，默认空 ⇒
 *      完全不生效）：本机系统剪贴板已死 ⇒ "环境可用"这个前提**在本机无法真实取得**，
 *      只能靠打桩补出来做判别力证明 (a)；打桩成"不可用"做 (b)。
 *
 * ⚠️ 探针会**覆盖调用方原来的剪贴板内容** ⇒ 调用方必须**先**读原值（`readClip`）、判完还回去。
 * @returns {Promise<{available:boolean, measured:boolean, how:string, reason:string}>}
 *   `measured:false` = 这一档是**打桩**出来的（判别力证明用），不是真跑的往返。
 * ========================================================================== */
async function clipboardEnvProbe() {
  if (MY_KEY('clip-env-down')) {
    return { available: false, measured: false,
      how: '（注入：探针被打桩成"不可用"）',
      reason: '注入 MM_SMOKE_INJECT=39-clip-env-down（判别力证明 (b)）' };
  }
  if (MY_KEY('clip-env-up')) {
    return { available: true, measured: false,
      how: '（注入：探针被打桩成"可用"）',
      reason: '注入 MM_SMOKE_INJECT=39-clip-env-up（判别力证明 (a)：本机系统剪贴板已死，'
        + '"环境可用"这个前提只能这样补出来）' };
  }
  if (!electronClipboard || typeof electronClipboard.writeText !== 'function'
    || typeof electronClipboard.readText !== 'function') {
    return { available: false, measured: true, how: '主进程拿不到 electron.clipboard 的 writeText/readText',
      reason: '本进程拿不到 electron.clipboard（readText/writeText 缺失）' };
  }
  const token = '⛔smoke39-env-probe-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  try {
    electronClipboard.writeText(token);
  } catch (e) {
    return { available: false, measured: true, how: '写探针值时抛错',
      reason: '探针 writeText 抛错：' + String((e && e.message) || e) };
  }
  const back = await readClip();
  if (!back.ok) {
    return { available: false, measured: true, how: '探针写完之后读剪贴板出错',
      reason: '探针 readText 出错：' + back.error };
  }
  if (back.text !== token) {
    return { available: false, measured: true, how: '写-读往返不成立（写进去的值回读不出来）',
      reason: '探针写 ' + JSON.stringify(token) + ' 后回读得到 ' + JSON.stringify(back.text)
        + '（**写-读往返不成立** ⇒ 此刻系统剪贴板不能作为证据来源）' };
  }
  return { available: true, measured: true,
    how: '主进程直接 writeText→readText 往返成立（唯一值原样回读）', reason: '' };
}

/* ---------------- 探针常量（前缀 smoke-item- 按派发附页 §4.1） ---------------- */
const PROJ = 'smoke-item-39';
const NODE_ITEMIZED = 'si39-a';     // 条目化：detail 是一个 <ul>（两条 li 共享外壳）+ 一条追加条目
const NODE_V2 = 'si39-b';           // 未条目化（v2 观感回归判据的对照组）
const NODE_RICH = 'si39-c';         // 全可选字段（手挑字段清单完整性的活体样本）
const HOME_PROJECT = 'comnet';      // 本域跑完切回它（后续域/视觉断言按"当前项目"取景）

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓） */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT === '39-' + k;

/* ---------------- 探针项目的读写（都在冒烟沙箱副本里 ✓） ---------------- */

function probeDir() {
  return path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', PROJ);
}
function probeFile() { return path.join(probeDir(), PROJ + '.json'); }
function readProbe() { return JSON.parse(fs.readFileSync(probeFile(), 'utf8').replace(/^\uFEFF/, '')); }
function writeProbe(obj) { fs.writeFileSync(probeFile(), JSON.stringify(obj, null, 2), 'utf8'); }
function probeExists() { try { return fs.existsSync(probeFile()); } catch (e) { return false; } }

/** 自建自删：删不掉如实返回 false（绝不静默当成功） */
function removeProbe() {
  try {
    fs.rmSync(probeDir(), { recursive: true, force: true });
    return !fs.existsSync(probeDir());
  } catch (e) { return false; }
}

function findNode(proj, id) {
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (n.id === id) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(proj.data);
  return hit;
}

/* ---------------- CLI / 渲染层的小工具 ---------------- */

/** `ctx.runCli` 在 CLI 非 0 退出时抛错（harness 行为）⇒ 统一兜住，返回 {ok, out} */
function cli(ctx, args) {
  try { return { ok: true, out: String(ctx.runCli(args)) }; }
  catch (e) { return { ok: false, out: String((e && e.message) || e) }; }
}
function cliJson(ctx, args) {
  const r = cli(ctx, args);
  try { return JSON.parse(r.out); } catch (e) { return null; }
}

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: '渲染层返回值不是 JSON：' + String(raw).slice(0, 200) }; }
}

/** 等主进程 IPC + 原子写落地（与既有域同一手法） */
const SETTLE = 'new Promise(function (res) { setTimeout(res, 250); })';

/* ---------------- 铺场：探针项目（自建；崩溃残留先自愈） ---------------- */

let probeBuilt = null;

function ensureProbe(ctx) {
  if (!probeBuilt) probeBuilt = buildProbe(ctx);
  return probeBuilt;
}

/** 探针没建起来 ⇒ 每条断言都要**响亮地说"这是前置失败"**（不许静默变成"没有条目可看"） */
function probeFail(probe) {
  return (probe && probe.broken) ? { ok: false, text: '前置失败：' + probe.broken } : null;
}

function buildProbe(ctx) {
  const steps = [];
  // 自愈：上一次跑崩在半路留下的探针先删掉（否则 init 会因已存在而失败）
  steps.push('清理旧探针=' + removeProbe());
  steps.push(cli(ctx, ['init', PROJ]).out.trim() || '（init 无输出）');
  // 甲：**先给一个列表 detail，再 item-add** ⇒ 自动条目化：两条 <li> 共享一个 <ul> 外壳。
  //     这是"正文里每条各自成段"最容易认错的地方（外壳里的 li 各属一条，外壳本身不属于任何一条）。
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '甲·条目化',
    '--id', NODE_ITEMIZED, '--detail', '<ul><li>乙一</li><li>乙二</li></ul>']).out.trim());
  steps.push(cli(ctx, ['item-add', PROJ, NODE_ITEMIZED, '--html', '<p>丙条目（带出处与标签）</p>',
    '--src', 'docs/ITEM-MODEL.md:90', '--tags', '门禁,检索']).out.trim());
  // 乙：未条目化的 v2 节点
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '丁·未条目化',
    '--id', NODE_V2, '--detail', '<p>老的 v2 正文</p>']).out.trim());
  // 丙：全可选字段节点（detailMode / qa / origin / tags / localPath / background）
  // ⚠️ `add` **不收 `--tags`**（那是 `edit` 的选项）⇒ 分两步：先建节点，再改字段。
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '戊·全字段', '--id', NODE_RICH,
    '--detail', '<p>富文本正文</p>', '--local-path', 'D:\\probe\\folder']).out.trim());
  steps.push(cli(ctx, ['edit', PROJ, NODE_RICH, '--tags', 'a,b']).out.trim());
  // 第三条条目写上核验记录（三字段全必填：at/by/how）
  const view = cliJson(ctx, ['get', PROJ, NODE_ITEMIZED, '--json']);
  const items = (view && view.items) || [];
  const third = items.length ? items[items.length - 1].itemId : null;
  if (third) {
    steps.push(cli(ctx, ['item-edit', PROJ, NODE_ITEMIZED, third,
      '--verified', '--how', '读了源码行']).out.trim());
  }
  // CLI 还没有入口的那几个字段（qa / origin / background / detailMode）+ 把项目标成 v3：
  // 它们是"schema 允许的节点字段"清单的活体样本 —— **界面保存后一个都不许少**（断言⑦）。
  const proj = readProbe();
  const rich = findNode(proj, NODE_RICH);
  if (!rich) {
    // 响亮失败：探针没建起来 ⇒ 后面每条断言都必须说清"是前置失败"，不许静默变成"没有条目可看"
    return { steps: steps, itemId3: null, view: view, broken: '探针节点 ' + NODE_RICH + ' 没建起来（CLI 输出见上）' };
  }
  rich.detailMode = 'rich';
  rich.qa = [{ q: '问一句', a: '答一句', at: '2026-10-12T00:00:00.000Z' }];
  rich.origin = {
    kind: 'import', src: 'probe.md', sha256: '0'.repeat(64),
    at: '2026-10-12T00:00:00.000Z', tool: 'import-project'
  };
  rich.background = '#fff7e6';
  proj.meta.formatVersion = 3;
  writeProbe(proj);
  steps.push('已补 qa/origin/background/detailMode + formatVersion=3');
  // 供断言⑦对比的"**建好那一刻**的字段快照"：前面的断言会合法地保存/改动盘（例如断言⑤那次保存），
  // 若拿"断言开始时"的盘做基线，注入态下会把"上一条保存已经抹掉了"错报成"前置就没挂齐"（实测踩到）。
  const FIELD_LIST = ['detail', 'detailMode', 'tags', 'localPath', 'qa', 'origin', 'background'];
  const richNow = findNode(proj, NODE_RICH);
  const itemizedNow = findNode(proj, NODE_ITEMIZED);
  const fields = {};
  FIELD_LIST.forEach((f) => { fields[f] = JSON.stringify(richNow[f]); });
  fields.items = JSON.stringify(itemizedNow.items);
  const missingAtBuild = FIELD_LIST.filter((f) => richNow[f] === undefined)
    .concat(Array.isArray(itemizedNow.items) ? [] : ['items']);
  return {
    steps: steps, itemId3: third, view: view, fields: fields,
    fieldList: FIELD_LIST, missingAtBuild: missingAtBuild
  };
}

/* ---------------- 渲染层动作 ---------------- */

/** 打开探针项目（脏就先存，避免"切换项目"的确认框把冒烟卡住）—— 单次尝试，见 `openProjectReady` */
async function openProbeOnce(ctx) {
  const r = await execJson(ctx, `(async function () {
    var app = window.MMApp, want = ${JSON.stringify(PROJ)};
    if (!app) return JSON.stringify({ ok: false, text: '没有 MMApp' });
    var st = app.getState();
    if (st.project && st.project.name === want) return JSON.stringify({ ok: true, text: '已在探针项目' });
    if (app.isDirty && app.isDirty()) { await app.save(); }
    var r2 = await app.openProject(want);
    var now = (app.getState().project || {}).name;
    return JSON.stringify({ ok: r2 !== false && now === want, text: 'openProject=' + r2 + ' 当前=' + now });
  })()`);
  await ctx.exec(SETTLE);
  return r;
}

/** 探针节点在不在视图里（自愈用的哨兵：只看"有没有"，不看呈现细节） */
async function probeInView(ctx) {
  const r = await execJson(ctx, `(function () {
    var st = window.MMApp.getState();
    var n = st.jm ? window.MM.adapter.getNode(st.jm, ${JSON.stringify(NODE_ITEMIZED)}) : null;
    return JSON.stringify({ ok: !!n, text: (st.project || {}).name || '' });
  })()`);
  return !!(r && r.ok);
}

/** 硬 reload 渲染层，并轮询等它重新可用（reload 期间 `exec` 会抛，必须容错 —— 与 21/22 域同一手法） */
async function hardReload(ctx) {
  try { ctx.win.webContents.reload(); } catch (e) { /* 能不能用下面靠轮询判 */ }
  for (let i = 0; i < 60; i++) {
    await ctx.exec('new Promise(function (r) { setTimeout(r, 100); })');
    try {
      const r = await execJson(ctx, 'JSON.stringify({ ok: !!(window.MMApp && window.MMApp.getState'
        + ' && window.MMApp.getState().jm) })');
      if (r && r.ok) return true;
    } catch (e) { /* reload 中 */ }
  }
  return false;
}

/**
 * 打开探针项目，并**验证探针节点真的在视图里**；不在就硬 reload 一次再开 —— 域间耦合自愈。
 *
 * ⚠️ 为什么非做这一步不可（**实测反例**，也是本域改前"窄跑绿、全量红"的根因）：
 *   · 窄跑 `SMOKE_ONLY=39`（并入 `01-core`）⇒ **15/16**，本域只有第 ④ 条红；
 *   · 全量 `npm run smoke` ⇒ **205/212**，7 条红**全在本域**，其中 6 条只是同一句级联
 *     `前置失败：节点不在视图：si39-a`（连"items 被抹掉 / formatVersion 降级"那条也只是
 *     "视图里根本没有这个节点"的**后果**：窄跑同一条是绿的）。
 *   ⇒ 前置域留下的视图状态会让"项目打开了（`state.project.name` 已是探针项目）但树里没有本域节点"。
 *     按 `C4`（验证期间有并发写/多域同跑时**症状会分散**、别把偶发归因于被测对象）的教训：
 *     本域**不许**依赖任何前置域留下的视图状态 ⇒ 哨兵不在就 reload 重开，仍不在才如实报红。
 */
async function openProjectReady(ctx) {
  const first = await openProbeOnce(ctx);
  if (!first.ok) return first;
  if (await probeInView(ctx)) return first;
  await hardReload(ctx);
  const second = await openProbeOnce(ctx);
  if (!second.ok) return second;
  return (await probeInView(ctx))
    ? second
    : { ok: false, text: '视图里没有探针节点 ' + NODE_ITEMIZED + '（reload 后仍没有；' + second.text + '）' };
}

/** 显示某节点的详情框（渲染层内部路径：showDetail —— 与"点节点"落到的是同一个函数） */
async function showNode(ctx, nodeId) {
  const r = await execJson(ctx, `(function () {
    var MM = window.MM, app = window.MMApp;
    var st = app.getState();
    if (!st.jm) return JSON.stringify({ ok: false, text: '没有打开的导图' });
    var n = MM.adapter.getNode(st.jm, ${JSON.stringify(nodeId)});
    if (!n) return JSON.stringify({ ok: false, text: '节点不在视图：' + ${JSON.stringify(nodeId)} });
    MM.showDetail(n);
    return JSON.stringify({ ok: true, text: '详情框已打开' });
  })()`);
  await ctx.exec(SETTLE);
  return r;
}

/** 让"清单行 + 复制键"落进面板可见区，并做命中测试（V1 判据：rect 只判几何，命中才算点得到） */
async function ensureClickable(ctx) {
  await ctx.exec(`(function () {
    var MM = window.MM;
    if (MM.setViewScale) MM.setViewScale(0.7);
    if (MM.centerOnRoot) MM.centerOnRoot();
    return 1;
  })()`);
  await ctx.exec(SETTLE);
  return execJson(ctx, `(function () {
    var box = window.MM.fdPrimaryNodeBox();
    if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
    var panel = window.MM.fdPanel ? window.MM.fdPanel() : null;
    var pr = panel ? panel.getBoundingClientRect() : null;
    var row = box.el.querySelector('.fd-item-row[data-item-id]');
    var copy = row ? row.querySelector('.fd-item-copy') : null;
    if (!row || !copy) return JSON.stringify({ ok: false, text: '清单行/复制键不存在' });
    var rr = row.getBoundingClientRect(), cr = copy.getBoundingClientRect();
    var mid = function (r) { return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    var hitSelf = function (p, el) {
      var h = document.elementFromPoint(p.x, p.y);
      return !!(h && (h === el || el.contains(h)));
    };
    var rp = mid(rr), cp = mid(cr);
    var inPanel = function (r) {
      return !!pr && r.width > 2 && r.height > 2
        && r.top > pr.top + 1 && r.bottom < pr.bottom - 1 && r.left > pr.left + 1 && r.right < pr.right - 1;
    };
    return JSON.stringify({
      ok: true, rowPt: rp, copyPt: cp, rowIn: inPanel(rr), copyIn: inPanel(cr),
      rowHit: hitSelf(rp, row), copyHit: hitSelf(cp, copy),
      rowId: row.getAttribute('data-item-id'),
      copyValue: row.getAttribute('data-copy'),
      geom: { row: [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)],
              copy: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)],
              panel: pr ? [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)] : null }
    });
  })()`);
}

/**
 * 等"点了复制键"这一跳落地：轮询渲染层的 `lastCopy`，直到它就是**这一轮**的读数（值 == 期望值）。
 *
 * 为什么不能只 `ctx.input.settle()`：剪贴板现在由**主进程**写（`app:clipboard-write`）⇒ 点击到
 * 落盘多一次 IPC 往返；旧的 `execCommand` 路径是渲染层**同步**动作。只用固定时长等待，就会变成
 * **偶发**红/绿 —— 判据必须确定性 ✓。轮询只用来**同步**（等到渲染层给出这一轮的读数），
 * **判据仍是**"主进程读到的系统剪贴板内容"（见断言④：`lastCopy` 只提供"走的是哪条通道"这一项）。
 * 超时返回 null ⇒ 调用方按"没拿到读数"处理（不许当成功）。
 */
async function waitCopyLanded(ctx, expect, tries) {
  const MAXT = tries || 24;
  for (let i = 0; i < MAXT; i++) {
    const st = await execJson(ctx, `(function () {
      var b = window.MM.fdPrimaryNodeBox();
      return JSON.stringify((b && b.fdItems && b.fdItems.lastCopy) || null);
    })()`);
    if (st && st.value === expect) return st;
    await ctx.exec('new Promise(function (r) { setTimeout(r, 50); })');
  }
  return null;
}

/** 一次"真实的界面改动 + 保存"（走 serializeTree 整树写回；返回值里带"真的写了盘"的证据） */
async function editAndSave(ctx, parentId) {
  const r = await execJson(ctx, `(async function () {
    var app = window.MMApp, jm = app.getState().jm;
    var before = jm.get_node(${JSON.stringify(parentId)}).children.length;
    app.addNode(${JSON.stringify(parentId)});
    var after = jm.get_node(${JSON.stringify(parentId)}).children.length;
    var saved = await app.save();
    return JSON.stringify({ ok: true, before: before, after: after, saved: saved, dirty: app.isDirty() });
  })()`);
  const closed = await mm.closeDialogs(ctx);   // addNode 顺手开的「编辑节点」模态必须当场关掉
  return { r: r, closed: closed };
}

const assertions = [

  /* ==========================================================================
   * ① 条目化节点：逐条呈现 + 正文与 CLI 的 detail 同源
   * ========================================================================== */
  {
    name: 'smoke-item-39 条目化节点：详情框逐条列出（条数/序号/归属），正文与 CLI 的 detail 逐字节同源'
      + '（防"界面另拼一份正文"与"逐条看不见"）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      const view = cliJson(ctx, ['get', PROJ, NODE_ITEMIZED, '--json', '--detail']);
      if (!view || !Array.isArray(view.items) || view.items.length !== 3 || typeof view.detail !== 'string') {
        return { ok: false, text: '前置失败：CLI 读不到 3 条条目 —— ' + JSON.stringify(view && view.items) };
      }
      const ids = view.items.map((x) => x.itemId);
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_ITEMIZED);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
        var st = window.MM.fdItemsState(box);
        var dc = box.el.querySelector('.fd-detail-content');
        var base = document.createElement('div');
        base.innerHTML = ${JSON.stringify(view.detail)};
        // 条目层**只许加属性**：把属性级装饰撤掉之后，正文必须逐字节等于 CLI 的 detail
        var clone = dc.cloneNode(true);
        var list = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
        list.forEach(function (el) {
          if (!el.getAttribute || !el.classList) return;
          el.removeAttribute('data-item-id');
          el.removeAttribute('data-item-no');
          el.classList.remove('fd-item');
          el.classList.remove('fd-item-active');
          if (el.classList.length === 0) el.removeAttribute('class');
        });
        var head = box.el.querySelector('.fd-items-count');
        return JSON.stringify({
          ok: true, st: st,
          textSame: dc.textContent === base.textContent,
          htmlSame: clone.innerHTML === base.innerHTML,
          headText: head ? head.textContent : '',
          cliHtml: base.innerHTML, stripped: clone.innerHTML
        });
      })()`);
      if (!r.ok) return { ok: false, text: '渲染层读数失败：' + r.text };
      const st = r.st || {};
      const seqOk = JSON.stringify(st.ids) === JSON.stringify(ids)
        && JSON.stringify(st.rowIds) === JSON.stringify(ids)
        && JSON.stringify(st.contentIds) === JSON.stringify(ids);
      const ok = st.itemized === true && st.count === 3 && st.rows === 3 && st.aligned === true
        && st.decorated === 3 && seqOk && r.textSame === true && r.htmlSame === true
        && /3\s*条/.test(String(r.headText || ''));
      return {
        ok: ok,
        text: '清单=' + st.rows + ' 行（应 3）· 表头=' + JSON.stringify(r.headText)
          + ' · 正文归属=' + st.decorated + ' 条（应 3）· 清单/正文/CLI 三处 id 一致=' + seqOk
          + ' · 正文文本同源=' + r.textSame + ' · 撤掉条目装饰后正文逐字节==CLI detail=' + r.htmlSame
          + (st.aligned ? '' : ' · ⚠️ 归属对不上：' + st.reason)
          + (r.htmlSame ? '' : ' · 差异=' + JSON.stringify({ cli: r.cliHtml, stripped: r.stripped }).slice(0, 240))
      };
    }
  },

  /* ==========================================================================
   * ② 未条目化节点：逐字一致 + 同一个框复用后不留痕迹
   * ========================================================================== */
  {
    name: 'smoke-item-39 未条目化节点：正文逐字节等于 CLI 的 detail，且**复用同一个详情框**后不留任何条目痕迹'
      + '（防"v2 节点观感被顺带改掉"）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      const viewA = cliJson(ctx, ['get', PROJ, NODE_ITEMIZED, '--json', '--detail']);
      const viewB = cliJson(ctx, ['get', PROJ, NODE_V2, '--json', '--detail']);
      if (!viewB || typeof viewB.detail !== 'string') return { ok: false, text: '前置失败：读不到未条目化节点的 detail' };
      if (!viewA || !Array.isArray(viewA.items)) return { ok: false, text: '前置失败：读不到条目化节点' };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shownA = await showNode(ctx, NODE_ITEMIZED);      // 先把"跟随框"用成条目化的
      if (!shownA.ok) return { ok: false, text: '前置失败：' + shownA.text };
      const r = await execJson(ctx, `(function () {
        var MM = window.MM, app = window.MMApp;
        var boxA = MM.fdPrimaryNodeBox();
        if (!boxA) return JSON.stringify({ ok: false, text: '没有详情框' });
        var boxIdA = boxA.el.dataset.boxId;
        var panelA = boxA.el.querySelectorAll('.fd-item-row').length;
        var n = MM.adapter.getNode(app.getState().jm, ${JSON.stringify(NODE_V2)});
        if (!n) return JSON.stringify({ ok: false, text: '未条目化节点不在视图' });
        MM.showDetail(n);                                     // 真机路径：跟随框被复用
        var box = MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var base = document.createElement('div');
        base.innerHTML = ${JSON.stringify(viewB.detail)};
        return JSON.stringify({
          ok: true,
          sameBox: box.el.dataset.boxId === boxIdA,
          panelA: panelA,
          panelCount: box.el.querySelectorAll('.fd-items').length,
          rowCount: box.el.querySelectorAll('.fd-item-row').length,
          attrCount: box.el.querySelectorAll('[data-item-id]').length,
          noCount: dc.querySelectorAll('[data-item-no]').length,
          htmlSame: dc.innerHTML === base.innerHTML,
          itemState: MM.fdItemsState(box),
          text: '同一个框=' + (box.el.dataset.boxId === boxIdA) + ' 复用前清单行=' + panelA
        });
      })()`);
      if (!r.ok) return { ok: false, text: '渲染层读数失败：' + r.text };
      const ok = r.sameBox === true && r.panelA === 3 && r.panelCount === 0 && r.rowCount === 0
        && r.attrCount === 0 && r.noCount === 0 && r.htmlSame === true
        && r.itemState && r.itemState.itemized === false;
      return {
        ok: ok,
        text: '先在同一个框里显示条目化节点（清单 ' + r.panelA + ' 行）⇒ 再显示未条目化节点：'
          + '同一个框=' + r.sameBox + ' · 清单容器=' + r.panelCount + '（应 0）· 清单行=' + r.rowCount
          + '（应 0）· 正文里的条目归属属性=' + r.attrCount + '（应 0）· data-item-no=' + r.noCount + '（应 0）'
          + ' · 正文逐字节==CLI detail=' + r.htmlSame + ' · 读数 itemized='
          + (r.itemState && r.itemState.itemized)
      };
    }
  },

  /* ==========================================================================
   * ③ 条目级 src / verified / 标签：有就看得见，没有就不显示
   * ========================================================================== */
  {
    name: 'smoke-item-39 条目级的出处/核验/标签：**有才显示**（含"怎么核的"），没有就不显示噪音字段'
      + '（防"人这一侧看不出这条还成不成立"）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      const view = cliJson(ctx, ['get', PROJ, NODE_ITEMIZED, '--json', '--detail']);
      if (!view || !Array.isArray(view.items) || view.items.length !== 3) {
        return { ok: false, text: '前置失败：CLI 读不到 3 条条目' };
      }
      const marked = view.items[view.items.length - 1].itemId;    // 带 src/tags/verified 的那一条
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_ITEMIZED);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
        var rows = Array.prototype.slice.call(box.el.querySelectorAll('.fd-item-row'));
        var rowsOf = function (sel) {
          return rows.filter(function (row) { return !!row.querySelector(sel); })
            .map(function (row) { return row.getAttribute('data-item-id'); });
        };
        var srcRows = rowsOf('.fd-item-src'), tagRows = rowsOf('.fd-item-tags'), verRows = rowsOf('.fd-item-verified');
        var verEl = box.el.querySelector('.fd-item-verified');
        var srcEl = box.el.querySelector('.fd-item-src');
        var tagEl = box.el.querySelector('.fd-item-tags');
        var st = window.MM.fdItemsState(box);
        return JSON.stringify({
          ok: true, rows: rows.length,
          srcRows: srcRows, tagRows: tagRows, verRows: verRows,
          srcText: srcEl ? srcEl.textContent : '', verTitle: verEl ? verEl.title : '',
          tagText: tagEl ? tagEl.textContent : '',
          marks: st.marks, aligned: st.aligned
        });
      })()`);
      if (!r.ok) return { ok: false, text: '渲染层读数失败：' + r.text };
      const only = (arr, id) => arr.length === 1 && arr[0] === id;
      const ok = r.rows === 3 && only(r.srcRows, marked) && only(r.tagRows, marked) && only(r.verRows, marked)
        && /docs\/ITEM-MODEL\.md:90/.test(String(r.srcText))
        && /门禁/.test(String(r.tagText)) && /检索/.test(String(r.tagText))
        && /读了源码行/.test(String(r.verTitle))            // "怎么核的"看得见
        && r.marks && r.marks.src === 1 && r.marks.tags === 1 && r.marks.verified === 1;
      return {
        ok: ok,
        text: '3 行清单里带出处的行=' + JSON.stringify(r.srcRows) + '（应只有 ' + marked + '）'
          + ' · 带标签的行=' + JSON.stringify(r.tagRows) + ' · 带核验的行=' + JSON.stringify(r.verRows)
          + ' · 出处文本=' + JSON.stringify(String(r.srcText).slice(0, 40))
          + ' · 标签文本=' + JSON.stringify(String(r.tagText).slice(0, 30))
          + ' · 核验 title=' + JSON.stringify(String(r.verTitle).slice(0, 60))
          + ' · 三类标记计数=' + JSON.stringify(r.marks) + '（各应 1 —— 另外两条不带任何标记）'
      };
    }
  },

  /* ==========================================================================
   * ④ 真鼠标：点一条 ⇒ 选中/高亮正确；点复制键 ⇒ 系统剪贴板里就是 节点id#条目id
   * ⚠️ 这一条是**三态**：环境可用性先由**独立探针**判定 —— 探针不可用 ⇒ 剪贴板那一档"未验证"
   *    （不计入通过/总数、不阻断）；而"命中 / 选中 / 复制值同源"这几档**任何环境下都是判据** ✓
   * ========================================================================== */
  {
    name: 'smoke-item-39 真鼠标点条目：选中态落在那一行与正文那一段上；点 ⧉ 后**主进程读到的系统剪贴板**'
      + '里就是 节点id#条目id（点前先塞哨兵排除残留值；且必须走主进程那条 = 不依赖窗口焦点）。'
      + '⚠️ 环境可用性先由**独立探针**判：探针不可用 ⇒ 剪贴板这一档**未验证**（不计入/不阻断），'
      + '环境无关的那几档照旧判'
      + '（防"点了没反应 / 复制值不对 / 只在有焦点时才复制得了 / 环境坏了被当成产品缺陷"）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      if (!ctx.input) return { ok: false, text: '真输入底座不存在（ctx.input 缺失）⇒ 本条的判据无法机械取得，判红' };
      const view = cliJson(ctx, ['get', PROJ, NODE_ITEMIZED, '--json', '--detail']);
      if (!view || !Array.isArray(view.items) || view.items.length !== 3) {
        return { ok: false, text: '前置失败：CLI 读不到 3 条条目' };
      }
      const firstId = view.items[0].itemId;
      const expectCopy = NODE_ITEMIZED + '#' + firstId;
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_ITEMIZED);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const geo = await ensureClickable(ctx);
      if (!geo.ok) return { ok: false, text: '取景失败：' + geo.text };
      // 真鼠标点"清单第 1 行"（**环境无关**的那一半：命中 + 选中态 ⇒ 任何环境下都按判据判 ✓）
      await ctx.input.click(geo.rowPt);
      await ctx.input.settle();
      const afterRow = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var st = window.MM.fdItemsState(box);
        var row = box.el.querySelector('.fd-item-row[data-item-id="${firstId}"]');
        var own = box.el.querySelector('.fd-detail-content [data-item-id="${firstId}"]');
        return JSON.stringify({
          ok: true, selected: st.selected,
          rowActive: !!(row && row.classList.contains('fd-item-active')),
          otherActive: box.el.querySelectorAll('.fd-item-row.fd-item-active').length,
          ownActive: !!(own && own.classList.contains('fd-item-active')),
          ownExists: !!own
        });
      })()`);
      /* —— 剪贴板这一档：**先问环境，再决定这条读数算不算判据**（三态，见 `clipboardEnvProbe` 头注）——
       * 五步，缺一条判据就会退化成假绿：
       *   ① **独立环境探针**（`clipboardEnvProbe`：本进程直接 writeText→readText 往返，
       *      **不走**产品那条 preload → IPC `app:clipboard-write`）—— 它说"不可用"时这一档**没有真值
       *      可判** ⇒ 响亮"本项未验证"、既不判绿也不判红、不计入总数（环境问题不许冒充产品缺陷，
       *      也不许静默当通过 ✗）；
       *   ② 点之前先往系统剪贴板塞一个**哨兵**（本次唯一值）：没有它就分不清"这次点击真的写进去了"
       *      与"剪贴板里本来就躺着同一个值"（残留 / 上一轮的复制）⇒ 判据会被残留值喂绿 ✗；
       *   ③ 真鼠标点 ⧉（`ctx.input` = `webContents.sendInputEvent`，走 Chromium 真实输入管线）；
       *   ④ 在**主进程**读系统剪贴板比对 —— 不采信渲染层的 `lastCopy` 自报（"execCommand 自报成功、
       *      主进程读到空/读到旧值"正是旧实现那个坑的来源；本机 2026-10-12 实测同一形态：
       *      `how:"execCommand", ok:true` 而系统剪贴板是空串）。
       * 期望值 = 行上的 `data-copy` = `fdCopyValue()` 的那一份（三处同源：见 fdCopyValue 的注释）。
       * ⚠️ **顺序不可交换**：`clipBefore`（原值）必须在**探针之前**读（探针自己会覆盖剪贴板）；
       *    哨兵必须写在**探针之后**（否则被探针的探测值覆盖掉）。判完一律把原值还回去 ✓。 */
      const clipBefore = await readClip();          // 原值：判完**还回去**（冒烟不该把人剪贴板留在测试值上）
      const env = await clipboardEnvProbe();        // ① 独立探针（这一步会覆盖剪贴板）
      const sentinel = '⛔smoke39-不是这条-' + Date.now();
      const seeded = env.available ? writeClip(sentinel) : false;
      let landed = null;
      let clip = { ok: false, text: null, error: '（还没读到剪贴板）' };
      let restored = false;
      try {
        await ctx.input.click(geo.copyPt);         // ③ 真鼠标点 ⧉（两档都点：环境坏也要把这一跳的读数如实记下来）
        await ctx.input.settle();
        // 等这一跳落地：旧的 `execCommand` 是渲染层**同步**动作，而现在剪贴板由**主进程**写
        // ⇒ 多一次 IPC 往返，只等固定时长会变成**偶发**红/绿（判据必须确定性 ✓）。
        landed = await waitCopyLanded(ctx, expectCopy);
        clip = await readClip();
      } finally {
        // ⚠️ 原值必须在 `finally` 里还 —— **探针自己就覆盖了剪贴板**，中途抛错也要还回去，
        //    否则冒烟会把用户剪贴板留在我们的探测值/测试值上（那是真打扰，且不可逆 ✗）。
        restored = (clipBefore.ok && clipBefore.text !== null) ? writeClip(clipBefore.text) : false;
      }
      const lc = landed || {};
      const hitOk = geo.rowHit === true && geo.copyHit === true;
      const rowOk = afterRow.ok && afterRow.selected === firstId && afterRow.ownExists === true
        && afterRow.rowActive === true && afterRow.ownActive === true && afterRow.otherActive === 1;
      // **环境无关**的那几档（命中 / 选中 / 复制值三处同源）：任何环境下都按判据判 ✓
      const baseOk = hitOk && rowOk && geo.copyValue === expectCopy;
      const baseText = '命中测试（V1 判据）：行命中=' + geo.rowHit + ' 复制键命中=' + geo.copyHit
        + ' ｜ 几何 行=' + JSON.stringify(geo.geom.row) + ' 复制键=' + JSON.stringify(geo.geom.copy)
        + ' 面板=' + JSON.stringify(geo.geom.panel)
        + ' ｜ 真点行 ⇒ 选中=' + (afterRow.selected || '(无)') + '（应 ' + firstId + '）'
        + ' 行高亮=' + afterRow.rowActive + ' 正文那一段高亮=' + afterRow.ownActive
        + ' 高亮行数=' + afterRow.otherActive + '（应 1，不能串到别的条）'
        + ' ｜ 行上的复制值=' + JSON.stringify(geo.copyValue) + '（应 ' + expectCopy + '）'
        + ' ｜ 环境判定（**独立探针**，与产品那条链无关）=' + (env.available ? '**可用**' : '**不可用**')
        + '（探针读数：' + env.how + (env.measured ? '·真跑' : '·**打桩**') + '）'
        + (env.reason ? '｜' + env.reason : '')
        + ' ｜ 真输入事件数=' + ctx.input.sentCount();

      /* —— 档② 环境不可用 ⇒ 剪贴板本项**未验证**（不计入"通过/总数"、不阻断）——
       * ⚠️ 但"环境无关"的那一半（命中 / 选中 / 复制值同源）**照旧是判据**：它可以也应该判红 ——
       *    否则"环境坏了"就成了把真缺陷一起洗白的大伞 ✗（`unverified` 只在 baseOk 为真时才给）。 */
      if (!env.available) {
        const rawText = ' ｜ 点 ⧉ 之后（**仅供参考，本档不构成任何判据**）：主进程读到的剪贴板='
          + JSON.stringify(clip.text) + '（读得到=' + clip.ok + (clip.ok ? '' : '，错=' + clip.error) + '）'
          + ' · 渲染层自报 lastCopy=' + JSON.stringify(lc)
          + '（⚠️ 自报成功 ≠ 真的写进系统剪贴板 —— 本机实测过 `how:"execCommand", ok:true` 而剪贴板是空串）'
          + ' · 判完还原原值=' + restored;
        return {
          ok: baseOk,
          unverified: baseOk
            ? ('剪贴板本项**未验证**（环境：系统剪贴板不可用 —— 独立探针也失败：' + (env.reason || env.how)
              + '）⇒ **不参与"通过/失败"计数、不阻断**（照第八批"撕裂快照指纹采不到"那一档的形状：'
              + '采不到真值不许判红冒充产品缺陷，也不许静默当通过 ✗）')
            : null,
          text: baseText + rawText
            + (baseOk
              ? ' ⇒ 环境不可用（**独立探针**也失败：写-读往返不成立）⇒ 剪贴板这一档**本项未验证**：'
                + '既不判绿、也不判红、不计入总数 ✓'
              : ' ⇒ ⚠️ 环境虽坏，但**环境无关**的那几档（命中 / 选中 / 复制值同源）本身没通过 ⇒ **判红**'
                + '（不许拿"环境问题"当真缺陷的挡箭牌 ✗）')
        };
      }

      /* —— 档①③ 环境可用 ⇒ 照旧按真判据判（这一档的红才是"我们没写进去"）——
       * 判据两条**都要**（A5「采不到真值 = 红」的落法：不许把 UNKNOWN 当 PASS）：
       *   ① 硬判据：主进程读到的**系统剪贴板**就是期望值（且哨兵证明它是这次点击写进去的）；
       *   ② 通道判据：渲染层报的是走了**主进程那条**（`how==='desktop-clipboard'`）—— 只判 ① 的话，
       *      退回"要求焦点"的浏览器通道也能把值写对（实测在本机 execCommand 偶尔真能写）
       *      ⇒ 那会让"焦点依赖"重新有资格冒充成功，正是要消灭的东西。两条都要才判绿 ✓。 */
      const clipOk = clip.ok && clip.text === expectCopy;
      const viaDesktop = lc.how === 'desktop-clipboard' && lc.ok === true;
      const ok = baseOk && clipOk && viaDesktop;
      return {
        ok: ok,
        text: baseText
          + ' ｜ 点之前先塞哨兵=' + JSON.stringify(sentinel) + '（写入=' + seeded + '）'
          + ' ⇒ 真点 ⧉ 后**主进程读系统剪贴板**=' + JSON.stringify(clip.text) + '（应 ' + expectCopy + '）'
          + ' · 与期望值相等=' + clipOk
          + (clip.ok ? '' : '｜⚠️ **采不到真值**（读剪贴板出错：' + clip.error + '）')
          + ' · 渲染层 lastCopy=' + JSON.stringify(lc)
          + ' · 走的是主进程那条（how=desktop-clipboard）=' + viaDesktop
          + ' · 判完还原原值=' + restored + (restored ? '' : '（原值读不到/写不回 ⇒ 本次测试值留在了剪贴板上）')
          + (baseOk ? '' : '｜⚠️ 取景/命中/选中没通过 ⇒ 这一条的读数不构成判据')
          + (clipOk && viaDesktop
            ? ' ⇒ **真的写进系统剪贴板，且不依赖窗口焦点** ✓'
            : (clipOk
              ? ' ⇒ ⚠️ 值对了但**不是**走主进程那条（how=' + JSON.stringify(lc.how) + '）⇒ 判红：'
                + '这一档又落回"要求焦点"的浏览器通道了'
              : ' ⇒ **环境可用**（独立探针的写-读往返成立）但我们没写进去 ⇒ **判红**：这是产品回归，'
                + '不是环境问题 ✗'))
      };
    }
  },

  /* ==========================================================================
   * ⑤ 界面保存不丢 items（+ formatVersion 不被降级）
   * ========================================================================== */
  {
    name: 'smoke-item-39 界面保存不丢条目层：盘上 items 逐字节不变 + meta.formatVersion 不被降级到 2'
      + '（防"整树写回的手挑字段把条目层静默抹掉"）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      if (MY_KEY('no-items-ser')) {
        // 注入：模拟"serializeTree 漏了 items"（在渲染层把载荷里的 items 摘掉再接手保存）
        await ctx.exec(`(function () {
          var MM = window.MM;
          var orig = MM.serializeTree;
          MM.serializeTree = function () {
            var d = orig();
            (function walk(n) { if (!n) return; if (n.items) delete n.items; (n.children || []).forEach(walk); })(d && d.data);
            return d;
          };
          window.__s5OrigSer = orig;
          return 1;
        })()`);
      }
      const before = readProbe();
      const nodeBefore = findNode(before, NODE_ITEMIZED);
      if (!nodeBefore || !Array.isArray(nodeBefore.items)) return { ok: false, text: '前置失败：探针节点没有 items' };
      const itemsBefore = JSON.stringify(nodeBefore.items);
      const fvBefore = before.meta.formatVersion;
      const kidsBefore = (findNode(before, 'root').children || []).length;
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const es = await editAndSave(ctx, 'root');
      const after = readProbe();
      const nodeAfter = findNode(after, NODE_ITEMIZED);
      // ⚠️ `JSON.stringify(undefined)` 返回的是 **undefined**（不是字符串）⇒ 注入态下这里曾把断言
      //    变成 "THREW: Cannot read properties of undefined"（红得看不出原因）—— 判据必须能读。
      const itemsAfter = (nodeAfter && nodeAfter.items !== undefined)
        ? JSON.stringify(nodeAfter.items) : '(盘上没有 items)';
      const fvAfter = after.meta.formatVersion;
      const kidsAfter = (findNode(after, 'root').children || []).length;
      if (MY_KEY('no-items-ser')) {
        await ctx.exec(`(function () { if (window.__s5OrigSer) { window.MM.serializeTree = window.__s5OrigSer; window.__s5OrigSer = null; } return 1; })()`);
      }
      const wrote = kidsAfter === kidsBefore + 1;       // 证明这次保存**真的写了盘**（否则断言会空转）
      return {
        ok: es.r.saved === true && wrote && itemsBefore !== 'undefined'
          && itemsAfter === itemsBefore && fvAfter === fvBefore,
        text: 'save()=' + es.r.saved + ' · 真写了盘=' + wrote + '（root 子节点 ' + kidsBefore + '→' + kidsAfter + '）'
          + ' · 盘上 items 逐字节不变=' + (itemsAfter === itemsBefore)
          + ' · formatVersion ' + JSON.stringify(fvBefore) + '→' + JSON.stringify(fvAfter) + '（不许降级）'
          + ' · 收尾关掉的模态=' + es.closed.n
          + (itemsAfter === itemsBefore ? '' : '｜⚠️ items 被抹掉了：' + String(itemsAfter).slice(0, 160))
      };
    }
  },

  /* ==========================================================================
   * ⑥ 真 Ctrl+Z / 重做：内存里的条目层仍在（快照链路也走 serializeTree）
   * ========================================================================== */
  {
    name: 'smoke-item-39 真 Ctrl+Z 撤销后，节点内存里的 items 仍在（快照/撤销链路同样走 serializeTree'
      + ' —— 防"Ctrl+Z 顺手把条目层丢掉"）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      if (!ctx.input) return { ok: false, text: '真输入底座不存在（ctx.input 缺失）⇒ 本条的判据无法机械取得，判红' };
      const view = cliJson(ctx, ['get', PROJ, NODE_ITEMIZED, '--json']);
      const ids = ((view && view.items) || []).map((x) => x.itemId);
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_ITEMIZED);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const before = await execJson(ctx, `(function () {
        var MM = window.MM, app = window.MMApp, jm = app.getState().jm;
        var n = MM.adapter.getNode(jm, ${JSON.stringify(NODE_ITEMIZED)});
        return JSON.stringify({ ok: true,
          items: (n && n.data && n.data.items) || null,
          kids: jm.get_node('root').children.length });
      })()`);
      const es = await editAndSave(ctx, 'root');            // 一次真实改动（撤销的靶子）
      await ctx.input.pressKey('Z', ['control']);           // 真键盘：Ctrl+Z（editor.js 的 keydown 接住）
      await ctx.input.settle();
      const after = await execJson(ctx, `(function () {
        var MM = window.MM, app = window.MMApp, jm = app.getState().jm;
        var n = MM.adapter.getNode(jm, ${JSON.stringify(NODE_ITEMIZED)});
        return JSON.stringify({ ok: true,
          items: (n && n.data && n.data.items) || null,
          ids: ((n && n.data && n.data.items) || []).map(function (x) { return x.id; }),
          kids: jm.get_node('root').children.length });
      })()`);
      const undoHappened = after.kids === es.r.before && es.r.after === es.r.before + 1;
      const itemsKept = Array.isArray(before.items) && before.items.length === 3
        && JSON.stringify(after.items) === JSON.stringify(before.items)
        && JSON.stringify(after.ids) === JSON.stringify(ids);
      return {
        ok: itemsKept && undoHappened && es.r.saved === true,
        text: '真 Ctrl+Z：root 子节点 ' + es.r.after + '→' + after.kids + '（撤销前应=' + es.r.before + '）'
          + ' ⇒ 撤销生效=' + undoHappened
          + ' · 撤销后内存 items 仍是那 ' + (before.items ? before.items.length : 0) + ' 条且逐字节相同=' + itemsKept
          + ' · 与 CLI 的条目 id 序列一致=' + (JSON.stringify(after.ids) === JSON.stringify(ids))
          + ' ｜ 真输入事件数=' + ctx.input.sentCount()
          + (undoHappened ? '' : '｜⚠️ 真 Ctrl+Z 没生效 ⇒ 这条不构成判据（不是产品结论）')
      };
    }
  },

  /* ==========================================================================
   * ⑦ 手挑字段清单的机械判据：保存后 schema 允许的节点可选字段一个都不少
   * ========================================================================== */
  {
    name: 'smoke-item-39 手挑字段清单判据：GUI 保存后，schema 允许的节点可选字段（detail/detailMode/tags/'
      + 'localPath/qa/origin/background/**items**）一个都不少（防"手挑字段清单"再漏下一个新字段）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      const FIELDS = probe.fieldList || ['detail', 'detailMode', 'tags', 'localPath', 'qa', 'origin', 'background'];
      const snap = probe.fields || {};
      const missingBefore = probe.missingAtBuild || [];
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const es = await editAndSave(ctx, 'root');
      const after = readProbe();
      const richAfter = findNode(after, NODE_RICH);
      const itemizedAfter = findNode(after, NODE_ITEMIZED);
      const itemizedItems = (itemizedAfter && itemizedAfter.items !== undefined)
        ? JSON.stringify(itemizedAfter.items) : '(盘上没有 items)';
      const lost = FIELDS.filter((f) => JSON.stringify(richAfter[f]) !== snap[f]);
      if (itemizedItems !== snap.items) lost.push('items');
      return {
        ok: es.r.saved === true && missingBefore.length === 0 && lost.length === 0,
        text: '探针节点上挂齐的字段=' + FIELDS.concat(['items']).length + ' 个（**建好那一刻**齐备='
          + (missingBefore.length === 0)
          + (missingBefore.length ? '，缺：' + missingBefore.join(',') : '')
          + '）⇒ 一次界面保存后：丢掉的字段=' + (lost.length ? lost.join(',') : '（无）')
          + ' · save()=' + es.r.saved + ' · 收尾关掉的模态=' + es.closed.n
      };
    }
  },

  /* ==========================================================================
   * ⑧ 自收尾：删探针项目 + 关框 + 切回原项目（域不留脏状态）
   * ========================================================================== */
  {
    name: 'smoke-item-39 自收尾：探针项目自己删掉、详情框关掉、界面切回原项目（不留脏状态给后续域）',
    run: async (ctx) => {
      const probe = await ensureProbe(ctx);
      const bad = probeFail(probe);
      if (bad) return bad;
      const r = await execJson(ctx, `(async function () {
        var app = window.MMApp, MM = window.MM;
        if (app.closeAllFloatDetail) app.closeAllFloatDetail();
        var home = ${JSON.stringify(HOME_PROJECT)};
        var st = app.getState();
        if (st.project && st.project.name !== home) {
          if (app.isDirty && app.isDirty()) { await app.save(); }
          await app.openProject(home);
        }
        var now = (app.getState().project || {}).name;
        return JSON.stringify({
          hasJm: !!app.getState().jm, boxes: document.querySelectorAll('.float-detail').length,
          cur: now, back: now === home
        });
      })()`);
      await ctx.exec(SETTLE);
      const removed = removeProbe();
      const closed = await mm.closeDialogs(ctx);
      const gone = !probeExists();
      return {
        ok: r.hasJm === true && r.back === true && r.boxes === 0 && removed === true && gone === true,
        text: '收尾前当前项目=' + JSON.stringify(r.cur) + '（应 ' + HOME_PROJECT + '）· 详情框残留=' + r.boxes
          + ' · 探针项目已删=' + removed + '（复核不存在=' + gone + '）'
          + ' · 关掉的模态=' + closed.n
      };
    }
  }
];

module.exports = assertions;
