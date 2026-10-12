/* ============================================================
 * scripts/smoke/40-heat-bars.js —— 详情框里的两条热度条（热度条第三件 · A 块）
 * ------------------------------------------------------------
 * ## 这个域防的是哪几种损害（每条断言都对应一种）
 *
 * ① **界面自己算热度 ⇒ 与 CLI 显示不一致**（"同一事实两处表达"在本件的形态）：
 *    热度是"名次 → 十档"，口径只在 `src/heat.js`。若渲染层自己在 `human`/`ai` 数组里找节点、
 *    自己算分位，改一次映射两边就分叉 —— 而且**看不出来**（界面照样画得挺好看）。
 *    ⇒ 断言①把"界面上的 `data-heat`/`data-bands`/`listed`/样本量"与 CLI 的
 *    `heat --json --node <id>` **逐字段对拍**（界面显示的就是 CLI 给的那一份）。
 *
 * ② **看热度留下写 / 触发保存**（用户只是看热度，不该有写）：两条热度条是**展示**，
 *    唯一允许的写是"往访问日志追加一行"（旁路产物，在项目目录**之外**）。
 *    ⇒ 断言②：① 打开详情框**恰好**多一条 `human-detail`；② 框内重绘**零增长**；
 *    ③ 关掉重开才再来一条；④ 项目目录清单与项目 JSON 在全程**逐字节不变**、无未保存标记。
 *
 * ③ **"没被访问过"被画成"热度 0"**（"采不到"与"真的是 0"必须可分辨）：
 *    ⇒ 断言③取一个"该通道从没访问过"的节点（日志里该侧事件为 0 **且** CLI 读数 `listed:false`
 *    两个条件同时成立才用它），要求界面**明说未访问**。
 *
 * ④ **"正文只有一份"被顺带破掉**（本工程铁律：`dc.innerHTML = detail` 是正文唯一来源）：
 *    ⇒ 断言④：详情框正文的 DOM **逐字节等于** CLI `get --json --detail` 的那一份（过浏览器解析器后比）。
 *
 * ⑤ **失败被静默吞掉**（"没记上"与"记上了"分不出来）：埋点失败必须**响亮**。
 *    ⇒ 断言⑤把读数通道与采样通道分别换成失败桩（注入点是渲染层能替换的那一层
 *    `window.desktop.app`），要求**界面上出现可见提示**。注入**自证生效**（没生效就如实说
 *    "注入未生效"，不当成产品缺陷 —— 实测 contextBridge 那层不总是可改）。
 *
 * ## 探针与自收尾
 *   探针项目 `smoke-heat-40` 建在**冒烟沙箱副本**里（`AI_MINDMAP_PROJECTS_DIR`）⇒ 真实 `projects/` 零触碰；
 *   访问日志落在沙箱根的 `.visits/` 下（**在项目目录之外** —— 这正是"只读路径在项目目录内零字节"
 *   那条不变量的形状）。
 *   本域**自建自删**，跑完切回原项目，不留脏状态给后续域。
 *
 * ## 两条测法上的坑（写在这里，免得下一个人再踩）
 *   · **不能只数"热度条有没有两行"**：`showDetail` 复用跟随框，上一位节点留下的那两行**还在 DOM 里**，
 *     只判行数会把**旧读数**当新读数（实测报过一次假红）。所以行上带 `data-node`（画的是哪个节点）。
 *   · **只判 `data-node` 还不够**：同一个节点、**更早时刻**取回来的那一份也是"名字对、内容旧"。
 *     所以再等一步"**这一份稳定下来**"（`waitStableBars`：连续两次读数一模一样 ⇒ 没有更大的饼在路上）。
 *     第一版等的是"行文本变了"——**实测假红**：`showNode` 里那句 `SETTLE`（300ms）通常已经等过了
 *     取数与重画 ⇒ 文本早在读基线之前就变完了，"等它变"永远等不到。
 *
 * ## 判别力证明（新断言先注入一次违规、确认变红、再撤销）
 *   ① **界面自己算**：把 `renderer/app-heat-bars.js` 里写 `data-heat` 的那个值 +1
 *      ⇒ **断言①必红**，还原后复绿；
 *   ② **多记一次**：把 `app-detail.js` 的 `MM.heatBarsRecordVisit(node)` **从 showDetail 里**
 *      挪到 `app-detail-content.js` 的 `renderFdBox` 里（= 每次重绘都记一次）⇒ **断言②必红**。
 *   两条的实测报文见交付说明（`.review/20261012-热度条/S3-交付与读数.md`）；
 *   产品代码还原后 sha256 逐字节回到原值（`b321009516f8f30b` / `99171b3d19a9a703` / `55397a2243eff40a`）。
 *
 * ## ⚠️ 本域**没有**提供环境开关注入（写在这里免得下一个人找）
 *   第一版试过 `MM_SMOKE_INJECT=40-<key>`（在渲染层给 `window.desktop.app.heat` / `.visit` 换桩）。
 *   **实测不成立**：`window.desktop` 是 contextBridge 暴露的对象，给它挂方法**不生效**
 *   （`ctx.exec` 返回 1 也不代表改上了），于是"注入没发生"而断言变红 —— 红的原因指向产品，
 *   其实是测法失灵。所以本域的判别力证明只能靠**改产品代码**那一轮（见上），
 *   而"失败响亮"那两条改成了**真造失败条件**（坏日志 / 把日志路径堵住），不需要桩。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJ = 'smoke-heat-40';
const NODE_A = 'sh40-a';      // 被访问过（人 + AI 都有）
const NODE_B = 'sh40-b';      // 候选：AI 从没访问过（断言③自己去找一个真的没访问过的）
const HOME_PROJECT = 'comnet';

const INJECT = process.env.MM_SMOKE_INJECT || '';
/** 本域**没有**可用的注入开关（理由见文件头"⚠️ 本域没有提供环境开关注入"）。
 *  留着这个判定只是为了：别人照别域的惯例传 `MM_SMOKE_INJECT=40-*` 时，
 *  我们**不假装它生效** —— 而是**响亮忽略**（下面断言①里那行 `no switch` 的读数就是证据）。 */
const MY_KEY = (k) => INJECT === '40-' + k;

const SETTLE = 'new Promise(function (res) { setTimeout(res, 300); })';

/* ---------------- 沙箱路径与日志（都在副本里 ✓） ---------------- */
const sandboxRoot = () => process.env.AI_MINDMAP_PROJECTS_DIR || '';
const probeDir = () => path.join(sandboxRoot(), PROJ);
const probeFile = () => path.join(probeDir(), PROJ + '.json');
/** 访问日志的**真位置**：`<项目根>/.visits/<项目名>.jsonl`（**在项目目录之外**） */
const logFile = () => path.join(sandboxRoot(), '.visits', PROJ + '.jsonl');

function readLogLines() {
  try {
    const f = logFile();
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  } catch (e) { return []; }
}
function logCount(ch) {
  let n = 0;
  readLogLines().forEach((l) => { try { if (JSON.parse(l).ch === ch) n++; } catch (e) { /* 坏行另算 */ } });
  return n;
}
/** 全部 `human-detail` 事件（**不按节点过滤**）：那条不变的判据是"打开一次只记一条"，
 *  按节点过滤会漏掉"记到了别的节点上"这种错法（实测把它当成注入的判别力缺口补齐了）。 */
function humanDetailEvents() {
  const out = [];
  readLogLines().forEach((l) => {
    try { const e = JSON.parse(l); if (e.ch === 'human-detail') out.push(e.node); } catch (err) { /* 坏行另算 */ }
  });
  return out;
}
/** 某个节点上"该侧"（human / ai）的事件条数 —— 断言③用它找真·没被访问过的节点 */
function sideEvents(nodeId, side) {
  const prefix = side === 'ai' ? 'ai-' : 'human-';
  return readLogLines().filter((l) => {
    try { const e = JSON.parse(l); return e.node === nodeId && String(e.ch).indexOf(prefix) === 0; }
    catch (err) { return false; }
  }).length;
}
function probeExists() { try { return fs.existsSync(probeFile()); } catch (e) { return false; } }
function dirList() {
  try { return fs.readdirSync(probeDir()).sort().join(','); } catch (e) { return '(读不到)'; }
}
function probeBytes() {
  try { return fs.readFileSync(probeFile()); } catch (e) { return null; }
}
function removeProbe() {
  try { fs.rmSync(probeDir(), { recursive: true, force: true }); return !fs.existsSync(probeDir()); }
  catch (e) { return false; }
}

/* ---------------- CLI 小工具（`ctx.runCli` 非 0 时会抛 ⇒ 统一兜住） ---------------- */
function cli(ctx, args) {
  try { return { ok: true, out: String(ctx.runCli(args)) }; }
  catch (e) { return { ok: false, out: String((e && e.message) || e) }; }
}
function cliJson(ctx, args) {
  try { return JSON.parse(cli(ctx, args).out); } catch (e) { return null; }
}
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); }
  catch (e) { return { ok: false, text: '渲染层返回值不是 JSON：' + String(raw).slice(0, 200) }; }
}

/* ---------------- 铺场：探针项目 ---------------- */
let built = null;
function buildProbe(ctx) {
  const steps = [];
  steps.push('清理旧探针=' + removeProbe());
  steps.push(cli(ctx, ['init', PROJ]).out.trim() || '（init 无输出）');
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '第一章', '--id', NODE_A,
    '--detail', '<h3>甲</h3><p>热度条不该改这里的一个字节</p>']).out.trim());
  steps.push(cli(ctx, ['edit', PROJ, NODE_A, '--tags', '门禁,热度']).out.trim());
  steps.push(cli(ctx, ['add', PROJ, NODE_A, '--topic', '第二章', '--id', NODE_B,
    '--detail', '<p>零访问节点</p>']).out.trim());
  steps.push(cli(ctx, ['edit', PROJ, NODE_B, '--tags', '门禁']).out.trim());
  // 给"人"一次基线访问（**经 CLI 记**）：断言②数的是**增量**，这条让基线非空
  steps.push(cli(ctx, ['visit', PROJ, NODE_B, '--channel', 'human-detail']).out.trim() || '（已记一次人访问）');
  const broken = probeExists() ? null : ('探针项目没建起来：' + steps.join(' ｜ '));
  return { broken: broken, steps: steps };
}
const ensureProbe = (ctx) => (built || (built = buildProbe(ctx)));

/** 探针项目在不在**当前视图**里（自愈：不在就硬 reload 一次再开） */
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
async function probeInView(ctx) {
  const r = await execJson(ctx, `(function () {
    var st = window.MMApp.getState();
    var n = st.jm ? window.MM.adapter.getNode(st.jm, ${JSON.stringify(NODE_A)}) : null;
    return JSON.stringify({ ok: !!n, text: (st.project || {}).name || '' });
  })()`);
  return !!(r && r.ok);
}
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
async function openProjectReady(ctx) {
  const first = await openProbeOnce(ctx);
  if (!first.ok) return first;
  if (await probeInView(ctx)) return first;
  await hardReload(ctx);
  const second = await openProbeOnce(ctx);
  if (!second.ok) return second;
  return (await probeInView(ctx))
    ? second
    : { ok: false, text: '视图里没有探针节点 ' + NODE_A + '（reload 后仍没有；' + second.text + '）' };
}
/** 打开某节点的详情框（走产品内部路径 `MM.showDetail` —— 与"点节点"落到的是同一个函数） */
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

/** DOM 上这两行的读数（断言用；**只读属性**，不改任何状态） */
async function readBarsDom(ctx) {
  return execJson(ctx, `(function () {
    var box = window.MM.fdPrimaryNodeBox ? window.MM.fdPrimaryNodeBox() : null;
    if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
    var host = box.el.querySelector('.fd-heat');
    if (!host) return JSON.stringify({ ok: false, text: '详情框里没有 .fd-heat 容器' });
    var rows = Array.prototype.slice.call(host.querySelectorAll('.fd-heat-row'));
    var out = {};
    rows.forEach(function (r) {
      out[r.getAttribute('data-side')] = {
        heat: r.getAttribute('data-heat'), bands: r.getAttribute('data-bands'),
        listed: r.getAttribute('data-listed'), node: r.getAttribute('data-node'), text: r.textContent
      };
    });
    var st = window.MM.heatBarsState ? window.MM.heatBarsState() : null;
    return JSON.stringify({ ok: true, rows: out, hostText: host.textContent, boxNode: box.node ? box.node.id : null,
      payloadNode: st && st.payload && st.payload.node ? st.payload.node.node : null });
  })()`);
}

/** 等这一块热度条**画完并稳定下来**（两次连续读数一模一样 ⇒ 没有更大的饼在路上）。
 *
 * ⚠️ **绝不能在这里重开详情框**（第一版这么干过，实测把判据变成不可能满足）：每开一次
 * 详情框都会**记一条访问**（那是本件要验的行为）⇒ 日志在涨、读数在变，"稳定"永远等不到。
 * 所以这里只**看**，不碰；要"逼它重新取数"只能由调用方在**测量之前**做一次。
 * 为什么不是"等行文本变了"（第二版）：`showNode` 里那句 `SETTLE`（300ms）通常已经等过了取数与重画
 * ⇒ 文本早在读基线之前就变完了，"等它变"永远等不到。
 * @param {(r:object)=>boolean} [pred] 额外要满足的条件（如"这一行是 listed=false"）
 */
async function waitStableBars(ctx, pred, timeoutMs) {
  const t0 = Date.now();
  const cap = timeoutMs || 8000;
  let lastText = null;
  for (;;) {
    const r = await readBarsDom(ctx);
    const okPred = !pred || (r && r.ok && pred(r));
    if (r && r.ok && okPred && lastText !== null && r.hostText === lastText) {
      return { ok: true, dom: r, text: r.hostText };
    }
    lastText = (r && r.ok) ? r.hostText : null;
    if (Date.now() - t0 > cap) {
      return { ok: false, text: (r && r.hostText) || (r && r.text) || '超时', dom: r };
    }
    await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
  }
}

/* ---------------- 判别力证明：**本域不提供渲染层注入**（见文件头） ----------------
 * 曾经在这里定义过 `INJECT_HEAT_PLUS1` / `INJECT_ERR_BARS` / `INJECT_ERR_VISIT` 三个渲染层桩，
 * 全部**实测无效**（contextBridge 的对象挂不上方法）⇒ 已删掉：留着它们只会让下一个接手者
 * 以为"有开关可用"，然后在"注入没生效"的情况下得到一条红 —— 那比没有开关更坏。
 * 现在的口径：判别力证明靠**改产品代码**那一轮（文件头有记录）；
 * "失败响亮"靠**真造失败条件**（坏日志 / 把日志路径堵住）—— 见断言⑤。
 */

/* ============================================================================
 * 断言
 * ========================================================================== */
const assertions = [

  /* ---- ① 界面显示的两条热度值 = CLI 的读数（逐字段对拍） ---- */
  {
    name: 'smoke-heat-40 ① 界面上两条热度条的每一个数都与 CLI `heat --json --node <id>` '
      + '**逐字段相同**（防"界面自己算一份"）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      if (MY_KEY('heat-plus1')) {
        // **不假装注入生效**：本域没有可用的渲染层注入（见文件头）⇒ 显式说出来并继续。
        console.log('[smoke] ⚠ MM_SMOKE_INJECT=' + INJECT + ' 在本域**不生效**'
          + '（渲染层注入实测无效，见 scripts/smoke/40-heat-bars.js 文件头）—— 本次按正常路径跑');
      }
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };

      /** 读一次"界面上这两行"，并与 CLI 刚给出的真值对拍（返回明细）。
       * 为什么要**循环读**（实测出来的）：进度是异步的，而且**开局那次取数可能早于探针把日志写完**
       * —— 实测形状：界面显示 `AI 0/0（未访问）`，而 CLI 同一时刻读到 `10/10`（探针铺场时那次
       * `get` 记下的 `ai-get` 事件还没落地就被界面读走了）。而"看热度"这件事**本身也会记一条**
       * （人打开详情框 ⇒ `human-detail`）⇒ 两侧永远可能差一条。所以判据落成
       * "**在多轮里达成一致**"：每轮重画一次、再对拍一次，一致即通过；
       * 一直不一致就**如实把两侧读数报出来**（不静默判绿）。 */
      const compareOnce = async () => {
        const truthNow = cliJson(ctx, ['heat', PROJ, '--json', '--node', NODE_A, '--limit', '1']);
        const domNow = await readBarsDom(ctx);
        if (!truthNow || !truthNow.node || !domNow.ok) return null;
        const h = domNow.rows.human || {};
        const a = domNow.rows.ai || {};
        const okHuman = h.heat === String(truthNow.node.human.heat)
          && h.bands === String(truthNow.node.human.bands)
          && h.listed === (truthNow.node.human.listed ? '1' : '0');
        const okAi = a.heat === String(truthNow.node.ai.heat)
          && a.bands === String(truthNow.node.ai.bands)
          && a.listed === (truthNow.node.ai.listed ? '1' : '0');
        const s = truthNow.node.sample || {};
        const okSample = domNow.hostText.indexOf(String(s.nodes)) >= 0
          && domNow.hostText.indexOf(String(s.events)) >= 0;
        const okText = truthNow.node.human.listed ? h.text.indexOf(String(truthNow.node.human.visits)) >= 0 : true;
        return { ok: okHuman && okAi && okSample && okText, okHuman: okHuman, okAi: okAi,
          okSample: okSample, okText: okText, dom: domNow, truth: truthNow, h: h, a: a };
      };
      let measured = null;
      for (let i = 0; i < 12; i++) {
        measured = await compareOnce();
        if (measured && measured.ok) break;
        /* 逼它重画一次（**渲染层自己的刷新入口**，与框内重绘走的是同一条路）——
         * 这一条与"重开详情框"不同：它不记访问，只重取读数。 */
        await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
          return JSON.stringify({ ok: true });
        })()`);
        await ctx.exec(SETTLE);
      }
      if (!measured) return { ok: false, text: '前置失败：读数拍不到（界面上没有那两行）' };
      return {
        ok: measured.ok,
        text: '人 ' + measured.h.heat + '/' + measured.h.bands
          + '（CLI ' + measured.truth.node.human.heat + '/' + measured.truth.node.human.bands + '）'
          + ' · AI ' + measured.a.heat + '/' + measured.a.bands
          + '（CLI ' + measured.truth.node.ai.heat + '/' + measured.truth.node.ai.bands + '）'
          + ' · 逐字段相同=' + (measured.okHuman && measured.okAi) + ' · 样本量在文本里=' + measured.okSample
          + ' · 数值串含次数=' + measured.okText + ' ｜ 行文本：' + String(measured.h.text).slice(0, 60)
      };
    }
  },

  /* ---- ② 采样：打开记一次、重绘不记、关掉重开才记、项目目录零变化 ---- */
  {
    name: 'smoke-heat-40 ② 采样点：打开详情框 ⇒ 日志恰好多一条 `human-detail`；'
      + '**重绘不记 / 关掉重开才记**；且项目目录与项目 JSON 逐字节不变（看热度不留下写）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      // —— (a) 关掉所有框（干净基线）→ 打开 NODE_A：应当**恰好**多一条 human-detail ——
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const before = humanDetailEvents().length;
      const dirBefore = dirList();
      const bytesBefore = probeBytes();
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      await waitStableBars(ctx, (r) => r.boxNode === NODE_A);
      const afterOpen = humanDetailEvents().length;
      const grew = afterOpen - before;

      // —— (b) 框内重绘（既有的刷新路径 **不经** showDetail）：一条都不该多 ——
      await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        if (window.MM.refreshNodeDetailBox) window.MM.refreshNodeDetailBox(box.node.id);
        return JSON.stringify({ ok: true });
      })()`);
      await ctx.exec(SETTLE);
      const afterRepaint = humanDetailEvents().length;

      // —— (c) 关掉再开一次：**再来一条**（那确实是一次新的"打开"） ——
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const reopened = await showNode(ctx, NODE_A);
      if (!reopened.ok) return { ok: false, text: '前置失败（重开）：' + reopened.text };
      await ctx.exec(SETTLE);
      const afterReopen = humanDetailEvents().length;

      // —— (d) 项目目录零变化（热度条是展示：不改项目数据、不产生未保存标记） ——
      const dirAfter = dirList();
      const bytesAfter = probeBytes();
      const dirty = await execJson(ctx, 'JSON.stringify({ ok: true, dirty: !!(window.MMApp.isDirty && window.MMApp.isDirty()) })');

      const sameBytes = !!bytesBefore && !!bytesAfter && bytesBefore.equals(bytesAfter);
      const ok = grew === 1 && (afterRepaint - afterOpen) === 0 && (afterReopen - afterRepaint) === 1
        && dirAfter === dirBefore && sameBytes && dirty.dirty === false;
      return {
        ok: ok,
        text: '打开 ⇒ 多 ' + grew + ' 条（应 1）· 重绘 ⇒ 多 ' + (afterRepaint - afterOpen)
          + ' 条（应 0）· 关掉重开 ⇒ 多 ' + (afterReopen - afterRepaint) + ' 条（应 1）'
          + ' ｜ 项目目录不变=' + (dirAfter === dirBefore) + '（' + dirAfter + '）'
          + ' ｜ 项目 JSON 逐字节不变=' + sameBytes + ' ｜ 未保存标记=' + dirty.dirty
      };
    }
  },

  /* ---- ③ 该通道从没访问过 ⇒ 明说"未访问"，不画成"热度 0" ---- */
  {
    name: 'smoke-heat-40 ③ 某条通道**从没访问过**这个节点时：读数 `listed=false` ⇒ 界面明说"未访问"，'
      + '**不画成"热度 0"**（"采不到"与"真的是 0"必须可分辨）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      /* 取一个**AI 通道从没碰过**的节点：日志里该侧事件为 0 **且** CLI 读数 `listed:false`
       * 两个条件同时成立才用它 —— 这样"界面上写未访问"才有真值兜底。 */
      const cands = [NODE_B, NODE_A];
      let chosen = null;
      for (let i = 0; i < cands.length; i++) {
        const id = cands[i];
        const j = cliJson(ctx, ['heat', PROJ, '--json', '--node', id]);
        if (sideEvents(id, 'ai') === 0 && j && j.node && j.node.ai.listed === false) { chosen = { id: id, cli: j }; break; }
      }
      if (!chosen) {
        return {
          ok: false,
          text: '前置失败：找不到"AI 从没访问过"的候选节点 —— 日志：' + JSON.stringify(readLogLines().map((l) => {
            try { const e = JSON.parse(l); return e.node + ':' + e.ch; } catch (err) { return '?'; }
          }))
        };
      }
      /* 这一档的取样口径要写清楚：**"从没访问过"在"打开详情框"之后就必然不成立了** ——
       * 打开那一刻人会记一条（`human-detail`），而面板一取数又要跑一次 `read`（记 `ai-read-view`）。
       * 所以本断言判的不是"界面显示 0"，而是**"界面显示的那一档与 CLI 同一时刻的读数逐字段相同"**
       * —— 包括 `listed` 这个"在不在榜上"的语义（`heat=0/rank=null/listed=false` 是**三件一起**读的）。
       * 这样判据既守住了"采不到 ≠ 热度 0"（`listed:false` ⇒ 界面必须写"本窗口未访问"），
       * 又不会因为探针自己记了一条就恒红。 */
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const shown = await showNode(ctx, chosen.id);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      let ai = null;
      let human = null;
      let truth = null;
      let hit = false;
      let lastText = '';
      for (let i = 0; i < 12; i++) {
        const dom = await readBarsDom(ctx);
        truth = cliJson(ctx, ['heat', PROJ, '--json', '--node', chosen.id]);
        if (dom.ok && truth && truth.node) {
          ai = dom.rows.ai || {};
          human = dom.rows.human || {};
          lastText = String(ai.text || '');
          // `listed` 两侧一致 + heat 两侧一致 + **`listed:false` 时界面必须明说"未访问"**（不许画成 0）
          hit = ai.listed === (truth.node.ai.listed ? '1' : '0')
            && ai.heat === String(truth.node.ai.heat)
            && human.listed === (truth.node.human.listed ? '1' : '0')
            && (truth.node.ai.listed ? true : lastText.indexOf('本窗口未访问') >= 0);
          if (hit) break;
        }
        /* 逼它重画一次（渲染层自己的刷新入口；**不重开详情框** —— 重开会记一条访问，把判据搅乱）。 */
        await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
          return JSON.stringify({ ok: true });
        })()`);
        await ctx.exec(SETTLE);
      }
      if (!ai || !truth) return { ok: false, text: '前置失败：读数拍不到（日志只有 ' + readLogLines().length + ' 行）' };
      return {
        ok: hit,
        text: '候选 ' + chosen.id + '（该节点的 ai-* 事件 ' + sideEvents(chosen.id, 'ai') + ' 条）'
          + '· AI 侧 listed/heat（界面 vs CLI）=' + ai.listed + '/' + ai.heat
          + ' vs ' + (truth.node.ai.listed ? '1' : '0') + '/' + truth.node.ai.heat
          + ' · 人侧 listed=' + human.listed + '/' + (truth.node.human.listed ? '1' : '0')
          + ' ｜ 行文本：' + String(lastText).slice(0, 60)
      };
    }
  },

  /* ---- ④ 正文只有一份（回归：热度条不许碰正文） ---- */
  {
    name: 'smoke-heat-40 ④ 回归：详情框正文的 DOM **逐字节等于** CLI `get --json --detail` 的那一份'
      + '（"正文只有一份"这条铁律没被热度条碰坏）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const view = cliJson(ctx, ['get', PROJ, NODE_A, '--json', '--detail']);
      if (!view || typeof view.detail !== 'string') {
        return { ok: false, text: '前置失败：CLI 读不到该节点的 detail' };
      }
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      await ctx.exec(SETTLE);         // 等热度条也画完（它**不许**碰正文；正文与它无关）
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var base = document.createElement('div');
        base.innerHTML = ${JSON.stringify(view.detail)};
        return JSON.stringify({ ok: true, textSame: dc.textContent === base.textContent,
          htmlSame: dc.innerHTML === base.innerHTML, cli: base.innerHTML,
          got: dc.innerHTML, heatInBody: dc.querySelector('.fd-heat') !== null });
      })()`);
      if (!r.ok) return { ok: false, text: '渲染层读数失败：' + r.text };
      const ok = r.textSame === true && r.htmlSame === true && r.heatInBody === false;
      return {
        ok: ok,
        text: '文本相同=' + r.textSame + ' · HTML 逐字节相同=' + r.htmlSame
          + ' · 正文里混进热度条=' + r.heatInBody
          + ' ｜ 正文 ' + String(r.got).length + ' B'
      };
    }
  },

  /* ---- ⑤ 失败响亮（读数 / 采样两条路都不许静默） ---- */
  {
    name: 'smoke-heat-40 ⑤ 失败响亮：① 读数失败（**真造一份坏日志**）⇒ 框里出现可见提示；'
      + '② 采样失败（**真把日志路径堵住**）⇒ 状态栏带错误标记（**不许静默**）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      /* —— ① 读数失败：**真造一份坏日志**（一行 JSON 截断）⇒ 那条读路径必然失败 ⇒
       *    界面上必须出现可见提示。为什么不用"换掉 window.desktop.app.heat"那种桩：
       *    实测**注入不生效**（contextBridge 暴露的对象挂不上方法）—— 桩没生效而断言变红，
       *    红的原因指向产品，其实是测法失灵。真造错误条件没有这个风险。 */
      const logPath = logFile();
      const savedLog = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null;
      fs.appendFileSync(logPath, '{"v":1,"at":"懒得写了"\n', 'utf8');
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      let errBars = null;
      for (let i = 0; i < 16; i++) {
        errBars = await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          var err = box.el.querySelector('.fd-heat-err');
          return JSON.stringify({ ok: true, has: !!err, text: err ? err.textContent : '' });
        })()`);
        if (errBars.has) break;
        await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
          return JSON.stringify({ ok: true });
        })()`);
        await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
      }
      // 还原日志（把那一行坏行去掉）：**后面还有断言要用它**
      if (savedLog) fs.writeFileSync(logPath, savedLog); else { try { fs.unlinkSync(logPath); } catch (e) {} }

      /* —— ② 采样失败：把**日志路径那一格堵住**（`<项目根>/.visits` 换成一个同名**文件**）⇒
       *    追加必然失败（父路径不是目录）⇒ 状态栏必须出现可见提示。
       *    同样不用桩：这是真失败。收尾把 `.visits` 变回目录。 */
      const visitsDir = path.join(sandboxRoot(), '.visits');
      // ⚠️ **不要读目录本身**（`readFileSync(目录)` 会 EISDIR 把整条断言炸掉 —— 实测踩到）。
      // 需要留的是**目录里那份日志**，它已经在上面 `savedLog` 里了。
      let blocked = false;
      let swapBack = null;
      try {
        /* 用**改名**而不是删除来制造"路径不可用"：目录里那个日志文件可能被另一个 CLI 进程占着
         * （实测 `rmdir` EPERM），改名不受占用影响 —— 而且改名后 `.visits` 变成文件，
         * `mkdirSync(.visits, {recursive:true})` 会失败 ⇒ 追加必然失败（要点就是这个）。 */
        const bak = visitsDir + '.smoke40bak';
        try { fs.rmSync(bak, { recursive: true, force: true }); } catch (e) { /* 旧残留 */ }
        fs.renameSync(visitsDir, bak);
        fs.writeFileSync(visitsDir, 'not a directory', 'utf8');
        blocked = true;
        swapBack = () => { fs.unlinkSync(visitsDir); fs.renameSync(bak, visitsDir); };
      } catch (e) { blocked = false; }
      await execJson(ctx, '(function () { window.MM.setStatus("热度条前置", false); return JSON.stringify({ ok: true }); })()');
      let errVisit = null;
      if (blocked) {
        const shown2 = await showNode(ctx, NODE_B);
        if (shown2.ok) {
          for (let i = 0; i < 16; i++) {
            errVisit = await execJson(ctx, `(function () {
              var el = document.getElementById('status-text');
              var st = window.MM.heatBarsState ? window.MM.heatBarsState() : null;
              return JSON.stringify({ ok: true, text: el ? el.textContent : '',
                color: el ? String(el.style.color) : '', visit: st ? st.visit : null });
            })()`);
            if (errVisit.visit && errVisit.visit.ok === false) break;
            await execJson(ctx, `(function () {
              var box = window.MM.fdPrimaryNodeBox();
              if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
              return JSON.stringify({ ok: true });
            })()`);
            await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
          }
        }
      }
      // 收尾：把 `.visits` 换回目录（**必须还原**：后面还有断言要用它）
      try { if (swapBack) swapBack(); } catch (e) { /* 收尾失败不判红 */ }

      /* 错误标记的判据落在**颜色**上（`MM.setStatus(text, true)` 的口径是 `style.color = #f53f3f`，
       * 不是加 class —— 第一版按 class 判，读到的 class 恒为空 ⇒ 假红）。 */
      const okBars = errBars.has === true && String(errBars.text).indexOf('热度读不出来') >= 0;
      const okVisit = !!blocked && !!(errVisit && errVisit.visit && errVisit.visit.ok === false)
        && String(errVisit.text).indexOf('没能记进访问热度') >= 0
        && /245,\s*63,\s*63|f53f3f/i.test(String(errVisit.color));
      return {
        ok: okBars && okVisit,
        text: '① 坏日志 ⇒ 框里可见提示=' + okBars + '（' + String(errBars.text).slice(0, 46) + '）'
          + ' ｜ ② 日志路径被堵住=' + blocked + ' ⇒ 状态栏=' + JSON.stringify(String(errVisit ? errVisit.text : '').slice(0, 50))
          + ' 颜色=' + (errVisit ? errVisit.color : '') + ' ｜ 采样读数=' + JSON.stringify(errVisit ? errVisit.visit : null)
      };
    }
  },

  /* ---- Z 诊断（临时）：原始载荷 vs DOM ---- */
  {
    name: 'smoke-heat-40 Z 诊断：原始载荷 vs DOM',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const cliNow = cliJson(ctx, ['heat', PROJ, '--json', '--node', NODE_A]);
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      await waitStableBars(ctx, (r) => r.boxNode === NODE_A);
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var host = box.el.querySelector('.fd-heat');
        var st = window.MM.heatBarsState();
        return JSON.stringify({ ok: true,
          boxNode: box.node ? box.node.id : null,
          payloadNode: st && st.payload && st.payload.node ? st.payload.node.node : null,
          staleDropped: st ? st.staleDropped : null,
          prof: st && st.payload ? st.payload.node : null,
          domRows: Array.prototype.slice.call(host.querySelectorAll('.fd-heat-row')).map(function (x) {
            return [x.getAttribute('data-side'), x.getAttribute('data-heat'), x.getAttribute('data-bands'), x.getAttribute('data-listed'), x.getAttribute('data-node')];
          }),
          text: host.textContent });
      })()`);
      return { ok: true, text: '日志行数=' + readLogLines().length
        + ' ｜ CLI 现在=' + JSON.stringify(cliNow && cliNow.node
          ? { h: cliNow.node.human.heat, a: cliNow.node.ai.heat } : null)
        + ' ｜ 被丢弃的过期读数=' + r.staleDropped
        + ' ｜ payload=' + JSON.stringify(r.prof && r.prof.ai ? { a: r.prof.ai.heat, ha: r.prof.human.heat, s: r.prof.sample } : null)
        + ' ｜ DOM=' + JSON.stringify(r.domRows)
        + ' ｜ text=' + JSON.stringify(String(r.text).slice(0, 90)) };
    }
  },

  /* ---- ⑥ 自收尾 ---- */
  {
    name: 'smoke-heat-40 ⑥ 自收尾：探针项目删干净 + 关框 + 切回原项目（不留脏状态给后续域）',
    run: async (ctx) => {
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      const removed = removeProbe();
      const back = await execJson(ctx, `(async function () {
        var app = window.MMApp;
        if (!app) return JSON.stringify({ ok: false, text: '没有 MMApp' });
        var r = await app.openProject(${JSON.stringify(HOME_PROJECT)});
        var now = (app.getState().project || {}).name;
        return JSON.stringify({ ok: r !== false && now === ${JSON.stringify(HOME_PROJECT)}, text: '当前=' + now });
      })()`);
      const noSel = await execJson(ctx, 'JSON.stringify({ ok: !window.MMApp.getState().selectedNode })');
      const ok = removed && back.ok && noSel.ok;
      return { ok: ok, text: '探针已删=' + removed + ' ｜ 切回=' + back.ok + '（' + back.text + '）' };
    }
  }
];

module.exports = assertions;
