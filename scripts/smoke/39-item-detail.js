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
 * ⑤ **点一条没反应 / 复制出来的不是"节点id#条目id"**：
 *    ⇒ 断言④**用真鼠标**（`ctx.input` = `webContents.sendInputEvent`，走 Chromium 命中测试）
 *      点清单行与复制键，并在主进程读**系统剪贴板**验证复制值（两侧同一个值，不靠自报）。
 *
 * ## 判别力证明（工程纪律：新断言先注入一次违规、确认变红、再撤销）
 * **已实跑的两条**（报文见交付说明；两条都恢复后复绿）：
 *   · **代码级注入**：把 `renderer/app-core.js` 的 `walk()` 里 `out.items` / `out.detailMode`
 *     两行去掉（模拟"手挑字段又漏一个"）⇒ **断言⑤⑥⑦必红**（13/16，exit 1）：
 *       ⑤ `盘上 items 逐字节不变=false｜⚠️ items 被抹掉了：(盘上没有 items)`
 *       ⑥ `撤销后内存 items 仍是那 0 条且逐字节相同=false`
 *       ⑦ `一次界面保存后：丢掉的字段=detailMode,items`
 *     还原后 sha256 逐字节回到原值（`4A6BFC9E…DBC63`）⇒ 16/16 复绿。
 *   · **环境开关**（只认本域的 key，其它一律忽略 ⇒ 默认空时完全不影响正常跑 ✓）：
 *     `MM_SMOKE_INJECT=39-no-items-ser` —— 在**测试侧**把载荷里的 `items` 摘掉再交给保存
 *     （等价于上一条注入，但不动产品代码）。⚠️ **未核实**：本批没有单跑验证这个开关
 *     （只实跑了上面那条代码级注入）。它保留是为了**下次复核**有个不动产品代码的口子。
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
 *   · ⚠️ **系统剪贴板这一档在本探针环境里不可达 ＝ 未验证**（实测）：离屏窗口按纪律**隐藏且不抢焦点**，
 *     而 Chromium 的两条剪贴板通道（`navigator.clipboard` / `execCommand('copy')`）**都要求文档有焦点**
 *     ⇒ 实测形状是"渲染层自报 `ok:true, how:'execCommand'`，主进程读系统剪贴板为空"。
 *     断言④因此**分两级判**：① 系统剪贴板真的等于期望值 ⇒ 首选判据通过；② 只有同时拿到"确实走了
 *     剪贴板通道 + 待写文本正确 + `document.hasFocus()===false` + navigator 那一路被拒"四样证据，
 *     才降级为**行为级**判据并如实打印"不可达 ＝ 未验证"；③ 证据不齐 ⇒ **判红**（不许留一条
 *     "自报成功"的假绿）。**唯一的补法**：真机（有焦点）上复核一次"复制真的进了系统剪贴板"。
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
   * ========================================================================== */
  {
    name: 'smoke-item-39 真鼠标点条目：选中态落在那一行与正文那一段上；点 ⧉ 后**系统剪贴板**里就是 节点id#条目id'
      + '（防"点了没反应 / 复制值不对"）',
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
      // 真鼠标点"清单第 1 行"
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
      // 真鼠标点"复制键"⇒ 主进程读系统剪贴板（不靠自报）
      await ctx.input.click(geo.copyPt);
      await ctx.input.settle();
      let clip = null, clipErr = '';
      try {
        // ⚠️ Electron 44 的 `clipboard.readText()` 返回的是 Promise（实测：直接 String() 会得到
        //    "[object Promise]"）⇒ 同步/异步两种形状都接住，别把"读到 Promise"当成读到内容。
        const v = electronClipboard ? electronClipboard.readText() : null;
        clip = (v && typeof v.then === 'function') ? String(await v) : (v === null ? null : String(v));
      } catch (e) { clipErr = String((e && e.message) || e); }
      const shownState = await execJson(ctx, `(function () {
        return JSON.stringify(window.MM.fdItemsState(window.MM.fdPrimaryNodeBox()));
      })()`);
      const hitOk = geo.rowHit === true && geo.copyHit === true;
      // 剪贴板这一档**分两级判**（A5「采不到真值 = 红」的落法：不许把 UNKNOWN 当 PASS，也不许拿
      // "渲染层自报成功"当证据）：
      //   ① 首选判据：主进程读到的**系统剪贴板**就是期望值 ⇒ 真的写进去了 ✓；
      //   ② 只有拿到**可复现的不可达证据**才允许降级为行为级判据 —— 证据 = 渲染层确实走了剪贴板
      //      通道、待写文本正确，且**窗口无焦点**、`navigator.clipboard` 被拒（Chromium 的两条剪贴板
      //      通道都要焦点，而冒烟窗口按纪律隐藏且不抢焦点 ⇒ 这一档在本探针环境里采不到真值）。
      //   ③ 既没写进剪贴板、也拿不到不可达证据 ⇒ **判红**（不许留一条"自报成功"的假绿）。
      const lc = shownState.lastCopy || {};
      const clipOk = clip !== null && clip === expectCopy;
      const unreachable = lc.ok === true && lc.value === expectCopy && lc.focus === false
        && /navigator\.clipboard/.test(String(lc.why || ''));
      const ok = hitOk && afterRow.ok && afterRow.selected === firstId && afterRow.ownExists === true
        && afterRow.rowActive === true && afterRow.ownActive === true && afterRow.otherActive === 1
        && geo.copyValue === expectCopy
        && (clipOk || unreachable);
      return {
        ok: ok,
        text: '命中测试（V1 判据）：行命中=' + geo.rowHit + ' 复制键命中=' + geo.copyHit
          + ' ｜ 几何 行=' + JSON.stringify(geo.geom.row) + ' 复制键=' + JSON.stringify(geo.geom.copy)
          + ' 面板=' + JSON.stringify(geo.geom.panel)
          + ' ｜ 真点行 ⇒ 选中=' + (afterRow.selected || '(无)') + '（应 ' + firstId + '）'
          + ' 行高亮=' + afterRow.rowActive + ' 正文那一段高亮=' + afterRow.ownActive
          + ' 高亮行数=' + afterRow.otherActive + '（应 1，不能串到别的条）'
          + ' ｜ 行上的复制值=' + JSON.stringify(geo.copyValue) + '（应 ' + expectCopy + '）'
          + ' ｜ 真点 ⧉ ⇒ 系统剪贴板=' + JSON.stringify(clip) + (clipErr ? '（读剪贴板出错：' + clipErr + '）' : '')
          + ' · 渲染层 lastCopy=' + JSON.stringify(lc)
          + (clipOk
            ? ' ⇒ **真的写进系统剪贴板** ✓'
            : (unreachable
              ? ' ⇒ 系统剪贴板这一档在本探针里**不可达**（无焦点窗口 + navigator.clipboard 被拒）＝'
                + ' **未验证**，判据降级为行为级（通道 + 待写文本 + 无焦点证据三样齐）'
              : ' ⇒ 既没写进系统剪贴板、也拿不到"不可达"的证据 ⇒ 判红'))
          + ' ｜ 真输入事件数=' + ctx.input.sentCount()
          + (hitOk ? '' : '｜⚠️ 取景/命中没通过 ⇒ 这一条的读数不构成判据')
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
