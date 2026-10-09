/* ============================================================
 * scripts/smoke/23-dsh-only.js —— 「导图页 ✕ = **真关**」这条语义（v0.19）
 * ------------------------------------------------------------
 * 用户语义（README「只改一边，不用全部重启（两条对称能力）」）：
 *   导图页右上角那个 ✕ ⇒ **真的把这一页关掉**：它从内存里被卸载（不是 `display:none` 地活着 ✗）。
 *   落地点：主窗口导航到占位页 `renderer/map-closed.html`；重开 = **重新加载**这一页
 *   + 还原侧栏停靠宽度 + 回到上次打开的项目。
 * 三条断言 = 一条链上的三段（**每段自建前置**：前一段红了也不能让后一段连锁 THREW）：
 *   ① 有未保存编辑 ⇒ **必须先拦**：选「取消」时这一页一根毫毛都不动（脏改动还在）；
 *   ② 选「保存后关闭」⇒ 改动**真落盘**（保存先发生）+ 这一页**真的没了**（`#main`/`MMApp` 都不存在）
 *      + 发往渲染层的菜单项**置灰**（否则点下去毫无反应 ✗）+ 侧栏那一半不受影响；
 *   ③ 重开 ⇒ 重新加载回**同一个项目**与**同一个停靠宽度**；菜单项恢复可用。
 * 判别力（哪条会红）：① 确认框调用计数不是 1（没拦）/ ② `#main` 还在、URL 还是 index.html
 *   （旧"只隐藏"实现，实测会红）、菜单没置灰 / ③ 菜单没恢复、宽度或项目没还原。
 * ⚠️ 本文件注释不要写成行内标记形态（G9 会数）。
 * ============================================================ */
'use strict';

const path = require('path');
const { Menu } = require('electron');
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));   // 与 main.js 同一实例

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前页面的"存在性"事实 —— **不看样式看存在**：真关之后 #main/MMApp 都不该存在 */
const aliveJs = `(function () {
  return {
    url: location.href,
    hasMain: !!document.getElementById('main'),
    hasToolbar: !!document.getElementById('toolbar'),
    hasMMApp: typeof window.MMApp !== 'undefined',
    dshOnly: document.body.className.indexOf('dsh-only') >= 0
  };
})()`;

/** 导图页的实况（只在导图页在时调） */
const stateJs = `(function () {
  var st = window.MMApp.getState();
  return JSON.stringify({ project: st.project.name,
    nodes: Object.keys(st.jm.mind.nodes).length, dirty: window.MMApp.isDirty() });
})()`;

/** 菜单实况：**关闭期间发往渲染层的项必须置灰**（否则就是"点了没反应"✗） */
function menuStats() {
  const menu = Menu.getApplicationMenu();
  const out = { disabled: 0, total: 0, saveDisabled: null, openEnabled: null, closeEnabled: null };
  if (!menu) return out;
  const walk = (items) => items.forEach((it) => {
    if (it.type !== 'separator') { out.total++; if (it.enabled === false) out.disabled++; }
    if (it.submenu) walk(it.submenu.items);
  });
  walk(menu.items);
  const byId = (id) => (menu.getMenuItemById ? menu.getMenuItemById(id) : null);
  const save = byId('map-menu-save'); if (save) out.saveDisabled = save.enabled === false;
  const open = byId('map-menu-open-page'); if (open) out.openEnabled = open.enabled === true;
  const close = byId('map-menu-close-page'); if (close) out.closeEnabled = close.enabled === true;
  return out;
}

/** 自建前置：导图页真的在（可交互）—— 每段自己调，不依赖上一段留下的状态 */
async function ensureMapPage(ctx) {
  sidebar.init(ctx.win);          // 冒烟路径下 main.js 不走正常启动分支，这里补一次（幂等）
  sidebar.show();
  if (sidebar.getStatus().mapPageClosed) {
    await sidebar.openMapPage();
    await sleep(800);
  }
  for (let i = 0; i < 30; i++) {
    const a = await execT(ctx, aliveJs, 4000);
    if (a && a.hasMMApp && a.hasMain) return true;
    await sleep(300);
  }
  return false;
}

/** exec 的**带超时**版：页面可能在执行期被卸载 ⇒ 页面内的 Promise 永远不会 settle，
 *  `executeJavaScript` 于是**永不返回**（实测：注入"省掉拦脏"的违规后整轮冒烟挂到守卫超时 ✗）。
 *  断言要的是"红得有话说"，不是"挂住" ⇒ 超时/异常都当**结构化失败**回报 ✓ */
const execT = (ctx, js, ms) => Promise.race([
  ctx.exec(js).catch((e) => ({ __err: String((e && e.message) || e) })),
  sleep(ms || 8000).then(() => '__exec_timeout__')
]);

/** 在导图页里制造一处**只改内存**的未保存改动（不弹编辑框：直接用 jsMind 加节点 + 压历史） */
const makeDirtyJs = (id) => `(function () {
  var st = window.MMApp.getState();
  var rootId = st.jm.mind.root.id;
  st.jm.add_node(rootId, ${JSON.stringify(id)}, '关闭导图页探针', { detail: '' });
  window.MM.recordHistory();
  return JSON.stringify({ dirty: window.MMApp.isDirty(), rootId: rootId });
})()`;

/** 确认框桩：**记下被问了几次** + 固定回答 —— "没问"本身就是要抓的缺陷 ✓ */
const stubJs = (answer) => `(function () {
  window.__mmConfirmCalls = 0;
  window.MMApp.setConfirmStub(function () { window.__mmConfirmCalls++; return ${answer ? 'true' : 'false'}; });
  return 'stubbed';
})()`;

const callsJs = `String(window.__mmConfirmCalls === undefined ? -1 : window.__mmConfirmCalls)`;

/** 本域内跨段共享的两个期望值（③ 用它判"还原了没有"） */
let expectedProject = null;
let expectedOccupied = null;

module.exports = [
  {
    name: '导图页 ✕ 真关①：有未保存编辑时**先拦**（选「取消」⇒ 这一页原封不动、脏改动一个不丢）',
    run: async (ctx) => {
      const ok0 = await ensureMapPage(ctx);
      const base = JSON.parse(await ctx.exec(stateJs));
      const dirty = JSON.parse(await ctx.exec(makeDirtyJs('probe-close-1')));
      const dirtyState = JSON.parse(await ctx.exec(stateJs));   // 造脏之后的实况（节点数/脏标记都取自它）
      await ctx.exec(stubJs(false));                        // 「取消」
      const rawR = await execT(ctx,
        `Promise.resolve(window.MMApp.closeMapPage()).then(function (r) { return JSON.stringify({ ok: !!r }); })`, 8000);
      // 超时 / 无返回 = 这一页在"拦"之前就被卸载了（**那正是本条要抓的违规**）⇒ 如实记成结构化失败 ✓
      const r = (typeof rawR === 'string' && rawR.charAt(0) === '{') ? JSON.parse(rawR)
        : { ok: 'no-return:' + String(rawR) };
      const after = await execT(ctx, aliveJs, 4000);
      const calls = await execT(ctx, callsJs, 4000);
      const stRaw = await execT(ctx, stateJs, 4000);
      const st = (typeof stRaw === 'string' && stRaw.charAt(0) === '{') ? JSON.parse(stRaw) : null;
      const status = sidebar.getStatus();
      // 收尾：撤销这处内存改动（也让下一段从"干净"开始）
      await execT(ctx, `(function () { window.MMApp.undo(); window.MMApp.setConfirmStub(null); return 'clean'; })()`, 4000);

      const aliveOk = !!(after && after.hasMMApp === true && after.hasMain === true);
      const ok = ok0 && base.dirty === false && dirty.dirty === true
        && r.ok === false                                  // 取消 ⇒ 不卸页（返回失败）
        && calls === '1'                                   // **真的问过**（-1/0 = 没拦 ⇒ 红）
        && aliveOk                                         // 这一页还在（旧"隐藏"实现也满足这里）
        && !!st && st.dirty === true && st.nodes === dirtyState.nodes   // 脏改动一个没丢
        && status.mapPageClosed === false;
      return {
        ok: !!ok,
        text: '脏前=' + base.dirty + ' 造脏后=' + dirty.dirty + ' ⇒ 确认框被问=' + calls + ' 次'
          + ' 返回 ok=' + JSON.stringify(r.ok) + '｜这一页还在：MMApp=' + (after && after.hasMMApp)
          + ' #main=' + (after && after.hasMain)
          + '｜脏改动还在：dirty=' + (st && st.dirty) + ' 节点数=' + dirtyState.nodes + '→' + (st && st.nodes)
          + '｜mapPageClosed=' + status.mapPageClosed
      };
    }
  },

  {
    name: '导图页 ✕ 真关②：选「保存后关闭」⇒ 改动真落盘 + 这一页从内存里**真的没了**（#main/MMApp 不存在）+ 菜单置灰',
    run: async (ctx) => {
      const ok0 = await ensureMapPage(ctx);
      sidebar.setWidth(512);                              // 一个**可区分**的停靠宽度，③ 校验还原
      await sleep(250);
      const before = JSON.parse(await ctx.exec(stateJs));
      expectedProject = before.project;
      expectedOccupied = sidebar.occupiedWidth();          // 关之前的实际占宽（控制栏 + 内容）
      const urlBefore = ctx.win.webContents.getURL();
      const pidBefore = ctx.win.webContents.getOSProcessId();
      const viewEpochBefore = sidebar.getStatus().viewEpoch;

      await ctx.exec(makeDirtyJs('probe-close-2'));
      await ctx.exec(stubJs(true));                        // 「保存后关闭」
      // 触发真关：**不 await** —— 这一页马上被卸载，它的 Promise 不会回来了（卸载正是被测行为）
      await ctx.exec(`(function () { window.MMApp.closeMapPage(); return 'fired'; })()`);
      let st = sidebar.getStatus();
      for (let i = 0; i < 40 && !(st.mapPageClosed && /map-closed\.html$/.test(ctx.win.webContents.getURL())); i++) {
        await sleep(250);
        st = sidebar.getStatus();
      }
      const urlAfter = ctx.win.webContents.getURL();
      const pidAfter = ctx.win.webContents.getOSProcessId();   // 仅作**取证记录**（Chromium 可能复用进程 ⇒ 不当判据）
      let page = null;
      const pageRaw = await execT(ctx, aliveJs, 5000);
      if (pageRaw && typeof pageRaw === 'object') page = pageRaw;
      else page = { err: String(pageRaw) };
      const menu = menuStats();
      const disk = String(ctx.runCli(['read', before.project, '--json']) || '');
      const sb = sidebar.getStatus();

      const ok = ok0
        && st.mapPageClosed === true
        && /map-closed\.html$/.test(urlAfter) && !/index\.html$/.test(urlAfter)
        && page && page.hasMain === false && page.hasToolbar === false && page.hasMMApp === false
        && disk.indexOf('probe-close-2') >= 0              // **保存先发生**且真落盘（没保存就卸页 = 丢改动 ✗）
        // 菜单：发往渲染层的项必须置灰（实测清单长度 16 + "关闭导图页"自己 + "重新加载"要启用）
        && menu.disabled >= 17 && menu.saveDisabled === true
        && menu.openEnabled === true && menu.closeEnabled === false
        // 侧栏那一半**完全不受影响**（这条需求的全部意义就是"侧栏留着"）
        && sb.hasView === true && sb.viewEpoch === viewEpochBefore;
      return {
        ok: !!ok,
        text: '【页】' + urlBefore.replace(/^.*[\\/]/, '') + ' → ' + urlAfter.replace(/^.*[\\/]/, '')
          + '｜#main=' + (page && page.hasMain) + ' MMApp=' + (page && page.hasMMApp)
          + '（真卸载 ⇒ 两者都不存在）｜渲染进程 id ' + pidBefore + '→' + pidAfter + '（仅取证）'
          + '｜【盘】探针在盘上=' + (disk.indexOf('probe-close-2') >= 0)
          + '｜【菜单】禁用 ' + menu.disabled + '/' + menu.total + ' 项（保存置灰=' + menu.saveDisabled
          + '，重新加载可点=' + menu.openEnabled + '）'
          + '｜【侧栏】hasView=' + sb.hasView + ' epoch=' + sb.viewEpoch + '（关导图页不该动它）'
          + '｜mapPageClosed=' + st.mapPageClosed
      };
    }
  },

  {
    name: '导图页 ✕ 真关③：重开 = 重新加载 + 回到上次的项目与停靠宽度 + 菜单恢复可用',
    run: async (ctx) => {
      if (!sidebar.getStatus().mapPageClosed) {
        const r0 = await sidebar.closeMapPage({ confirmed: true });
        if (!r0 || !r0.ok) return { ok: false, text: '前置失败：进不了"导图页已关闭"（' + ((r0 && r0.reason) || '?') + '）' };
        await sleep(600);
      }
      if (!expectedProject || !expectedOccupied) {
        // ② 没跑成 ⇒ 没有可校验的"上次项目/宽度"。**如实报前置缺失**（不假装通过：采不到真值 ≠ 通过），
        // 并退到能取到的那两种判据上（项目取自 lastProject、宽度只校验"回到停靠态"）。
        expectedProject = sidebar.getStatus().lastProject;
        expectedOccupied = null;
      }
      if (!expectedProject) return { ok: false, text: '前置缺失：主进程没记下"上次项目"（lastProject=null）⇒ 无法校验"回到同一个项目"' };

      const beforeOpen = menuStats();
      const r = await sidebar.openMapPage();
      let st = null;
      for (let i = 0; i < 40; i++) {
        const raw = await execT(ctx, `(function () { try {
            var s = window.MMApp && window.MMApp.getState && window.MMApp.getState();
            return s && s.project ? JSON.stringify({ project: s.project.name,
              nodes: Object.keys(s.jm.mind.nodes).length }) : 'null';
          } catch (e) { return 'err:' + ((e && e.message) || e); } })()`, 4000);
        if (typeof raw === 'string' && raw !== 'null' && raw.charAt(0) === '{') { st = JSON.parse(raw); break; }
        await sleep(300);
      }
      let alive = { hasMMApp: false, hasMain: false };
      const aliveRaw = await execT(ctx, aliveJs, 5000);
      if (aliveRaw && typeof aliveRaw === 'object') alive = aliveRaw;
      const menu = menuStats();
      const occupied = sidebar.occupiedWidth();
      const vb = sidebar.viewBounds();
      const win = ctx.win.getContentBounds();
      // 宽度判据两种口径（② 跑成 ⇒ 用最强的"与关之前逐像素相同"）：
      const widthOk = (expectedOccupied !== null)
        ? Math.abs(occupied - expectedOccupied) <= 2
        : !!(vb && Math.abs(vb.width - sidebar.getStatus().width) <= 2 && vb.width < win.width);
      const widthHow = (expectedOccupied !== null) ? '与关之前相同'
        : '只校验"回到停靠态"（② 未跑成 ⇒ 降级，不冒充强判据）';
      // 收尾：把探针从盘上删掉（经 CLI），并等界面同步回来（**尽力而为**，不当作判据）
      try {
        ctx.runCli(['remove', expectedProject, 'probe-close-2']);
        ctx.runCli(['remove', expectedProject, 'probe-close-1']);
      } catch (e) { /* ignore */ }
      sidebar.setWidth(420);            // 冒烟别把用户的偏好留在 512（默认宽度）

      const ok = r.ok === true && alive.hasMMApp === true && alive.hasMain === true
        && st && st.project === expectedProject                       // **回到上次的项目**
        && widthOk                                                    // **还原停靠宽度**
        && sidebar.getStatus().mapPageClosed === false
        // 菜单恢复：**唯一**该灰着的是"重新加载思维导图页"（导图页已经在，没什么可加载的 ✓）
        && menu.disabled === 1 && menu.saveDisabled === false
        && menu.closeEnabled === true && menu.openEnabled === false
        && beforeOpen.disabled >= 17;                                 // 关着的时候确实是灰的（成对判据）
      return {
        ok: !!ok,
        text: '【重开】ok=' + r.ok + '｜页面回来：MMApp=' + alive.hasMMApp + ' #main=' + alive.hasMain
          + '｜项目=' + (st && st.project) + '（期望 ' + expectedProject + '）'
          + '｜占宽 ' + occupied + '（关之前 ' + expectedOccupied + '；判据=' + widthHow + '）'
          + '｜【菜单】关着时禁用 ' + beforeOpen.disabled + ' → 重开后 ' + menu.disabled
          + '（只剩"重新加载"该灰着=' + (menu.openEnabled === false) + '；保存可点='
          + (menu.saveDisabled === false) + '，关闭导图页可点=' + menu.closeEnabled + '）'
          + '｜mapPageClosed=' + sidebar.getStatus().mapPageClosed
      };
    }
  }
];
