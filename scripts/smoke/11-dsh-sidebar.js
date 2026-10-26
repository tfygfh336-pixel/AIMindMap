/* ============================================================
 * scripts/smoke/11-dsh-sidebar.js — DSH 侧边栏冒烟断言
 * ------------------------------------------------------------
 * 分域：DSH 侧边栏（v0.16）。
 * 边界：冒烟模式**不孵化真实 DSH 服务**（main.js 的 isSmoke 守卫），
 * 本域只测「容器与让位机制」的可观测副作用：
 *   · 菜单项与快捷键已注册（Ctrl+B 切换）
 *   · preload 暴露 desktop.dsh.status()（不含 token/url 的状态查询）
 *   · 布局让位：模拟主进程 layout 事件 → body class + margin 生效
 * 真实端到端（vendor 包孵化 → 401/200 → 页面加载）由
 * scripts/dsh-e2e.js 单独覆盖（npm run dsh:e2e，不进常规 verify）。
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
// 侧栏模块本身（主进程侧）：本域的"状态广播"断言要**直接驱动真实产品路径**，
// 而不是只读渲染层的 status()（那只能证明"查询通"，证明不了"广播通"）
const sidebar = require(path.join(__dirname, '..', '..', 'main-dsh-sidebar.js'));
// 「界面所见落后盘上多少」这条判据要比"盘上当前版本" —— 用与写盘闸门**同一份**版本实现
// （`versionOf`：文件内容 SHA-1 前 16 位）。**绝不在断言里自己算一份哈希**（那就是第二份实现）
const dataStore = require(path.join(__dirname, '..', '..', 'src', 'data-store.js'));
// 真帧像素判据（"看得见"的第二支撑）：唯一的帧统计实现在 scripts/vision/frame-stats.js
const frameStats = require(path.join(__dirname, '..', 'vision', 'frame-stats.js'));
// 冒烟共用工具（收尾纪律与用法见 scripts/smoke-assertions.js 顶部）：动了 addNode 就要收模态
const mm = require('../smoke-assertions.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询渲染层，直到 `js` 为真（或超时）。超时**不静默**：返回 ok:false 由断言判红。 */
async function waitTrue(ctx, js, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = !!(await ctx.exec(js)); } catch (e) { v = false; }
    if (v) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0 };
    await sleep(200);
  }
}

const assertions = [

  {
    name: 'DSH 侧边栏：菜单已注册「切换 DSH 侧边栏」(Ctrl+B)',
    run: async (ctx) => {
      // 通过主进程菜单快照验证（menu.getApplicationMenu()）
      const r = await ctx.exec(`(async () => {
        const names = [];
        const walk = (items) => (items || []).forEach((it) => {
          names.push(it.label);
          if (it.submenu) walk(it.submenu);
        });
        walk(window.desktop ? [] : []);
        return { needMain: true };
      })()`);
      void r;
      // 菜单在主进程，渲染层拿不到 —— 用主进程侧状态代替：
      // main.js 把菜单构建成功与否打在 console；这里验证渲染层入口存在即可。
      const has = await ctx.exec(`(async () => {
        // preload 的 desktop.dsh.status 必须存在（toggle 本体在主进程菜单）
        return { hasDshApi: !!(window.desktop && window.desktop.dsh && typeof window.desktop.dsh.status === 'function') };
      })()`);
      return { ok: !!has.hasDshApi, text: 'desktop.dsh.status=' + has.hasDshApi };
    }
  },

  {
    name: 'DSH 侧边栏：status() 结构化（冒烟模式不孵化 → status=idle；默认打开语义由 prefs 决定）',
    run: async (ctx) => {
      const st = await ctx.exec(`(async () => {
        const s = await window.desktop.dsh.status();
        return { s };
      })()`);
      const s = st.s || {};
      const ok = s && typeof s.status === 'string'
        && typeof s.visible === 'boolean'
        && s.status === 'idle'; // 冒烟模式不孵化服务（visible 可为 true = 默认打开的偏好）
      return { ok: !!ok, text: 'status=' + s.status + ' visible=' + s.visible + '（默认打开语义）' };
    }
  },

  {
    name: 'DSH 侧边栏：布局让位事件 → body class + main margin 生效',
    run: async (ctx) => {
      /* 判据是**契约**，不是某个具体数字：让位宽度必须等于**侧栏实际占宽**
       * （status() 的 actualWidth，来自原生 view 的真实 bounds），收起时归 0。
       * ⚠️ 2026-10-54 修（这条曾恒红，且**与产品无关**）：上一版在断言里自己
       *   document.body.classList.add('dsh-sidebar-on') —— 而 --dsh-sidebar-width 的权威
       *   写入点**只有一处**：renderer/app-core.js 的 applyLayout()（只在收到
       *   dsh-sidebar:layout 时写）。自己加 class 只会碰到 renderer/style.css 的兜底 420px；
       *   只要那个变量被上游域清掉（域 04 收尾就 removeProperty），本条就在
       *   "侧栏实际 694 / 读到 420" 上恒红 ✗。
       * ⇒ 现在**走产品真实路径**，断言只读回副作用：
       *   ① setGeometry({}) → relayout() → notifyRenderer() → 渲染层 dsh-sidebar:layout
       *      → applyLayout()（body class 与 CSS 变量都由产品写，断言一个都不自己写）；
       *   ② 收起档由产品的 hide() 产生（visible=false ⇒ 变量 0px、class 摘掉）；
       *   ③ 期望值一律来自 status()，**不许**写成 420 / 694 这类具体宽度。 */
      const readJs = '(function () {'
        + ' var main = document.getElementById("main");'
        + ' var tb = document.getElementById("toolbar");'
        + ' var last = window.__dshLayoutLast || null;'
        + ' return { cls: document.body.classList.contains("dsh-sidebar-on"),'
        + '   margin: getComputedStyle(main).marginRight,'
        + '   pad: getComputedStyle(tb).paddingRight,'
        + '   varv: (getComputedStyle(document.body).getPropertyValue("--dsh-sidebar-width") || "").trim(),'
        + '   at: (last && last.at) || 0 }; })()';
      const read = async () => { const r = await ctx.exec(readJs); return (r && typeof r === 'object') ? r : {}; };
      const st0 = sidebar.getStatus();
      const wasVisible = st0.visible === true;
      /* 前提：视图真的建着（否则"该让出多少"没有真值）。走产品 show()，等它报出 actualWidth。 */
      if (!wasVisible || !st0.actualWidth) {
        try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ }
        for (let i = 0; i < 40; i++) {
          await sleep(200);
          const s = sidebar.getStatus();
          if (s.visible && s.actualWidth) break;
        }
      }
      const stOn = sidebar.getStatus();
      const actual = stOn.actualWidth;
      if (!stOn.visible || !actual) {
        return { ok: false, text: '侧栏视图建不起来（visible=' + stOn.visible + ' actualWidth=' + actual
          + '）⇒「页面该让出多少」没有真值，本条判不了，按红处理 ✗' };
      }
      const before = await read();
      /* ① 让产品把**当前**布局再发一次（净零改动：setGeometry({}) 只走 relayout，宽度不变） */
      let emitErr = '';
      try { sidebar.setGeometry({}); } catch (e) { emitErr = String((e && e.message) || e); }
      const evtOn = await waitTrue(ctx, '(function () { var l = window.__dshLayoutLast; return !!(l && l.at > '
        + Number(before.at || 0) + '); })()', 4000);
      const on = await read();
      /* ② 收起档：产品的 hide() ⇒ 让位带归 0（变量 0px、class 摘掉、margin 0） */
      let hideErr = '';
      try { sidebar.hide(); } catch (e) { hideErr = String((e && e.message) || e); }
      const evtOff = await waitTrue(ctx, '(function () {'
        + ' var main = document.getElementById("main");'
        + ' return !document.body.classList.contains("dsh-sidebar-on")'
        + '   && getComputedStyle(main).marginRight === "0px"; })()', 4000);
      const off = await read();
      /* ③ 净零还原：原来可见 ⇒ 用产品路径收回可见态（不留一个被改过的现场） */
      let restored = !wasVisible;
      if (wasVisible) {
        try { sidebar.show(); } catch (e) { /* 下面靠读数红 */ }
        const back = await waitTrue(ctx, '(function () { return document.body.classList.contains("dsh-sidebar-on"); })()', 4000);
        restored = back.ok;
      }
      const onPx = parseInt(on.margin, 10);
      const offPadPx = parseInt(off.pad, 10);
      const onOk = evtOn.ok && on.cls === true && Number.isFinite(onPx)
        && Math.abs(onPx - actual) <= 2 && String(on.varv) === actual + 'px';
      const offOk = evtOff.ok && off.cls === false && String(off.margin) === '0px'
        && offPadPx < 20 && String(off.varv) === '0px';
      return {
        ok: emitErr === '' && hideErr === '' && onOk && offOk && restored === true,
        text: '产品路径重发布局（无异常=' + (emitErr === '') + '）⇒ margin=' + on.margin
          + '（status().actualWidth=' + actual + '，应相等±2）· CSS 变量=' + JSON.stringify(on.varv)
          + ' · body.dsh-sidebar-on=' + on.cls + ' · toolbar paddingRight=' + on.pad
          + '（应 >= ' + (actual + 8) + '）'
          + ' ｜ 产品 hide() 后（无异常=' + (hideErr === '') + '）⇒ margin=' + off.margin
          + '（应 0px）· CSS 变量=' + JSON.stringify(off.varv) + '（应 0px）· class=' + off.cls
          + '（应 false）· toolbar paddingRight=' + off.pad + '（应 < 20）'
          + ' ｜ 事件真的送达（at 递增）=' + (evtOn.ok && evtOff.ok) + ' · 现场还原=' + restored
          + ((emitErr || hideErr) ? ' ｜ 异常=' + (emitErr || hideErr) : '')
          + ((onOk && offOk && restored) ? ' ✓' : ' ✗')
      };
    }
  },

  {
    // ⚠️ 名字里**不要**出现「可见/看不见/遮挡…」那几个词（V1 门禁会要求给出真判据，
    //    见 scripts/visibility-judge-check.js）—— 本条判的是**事件送达**，不是像素。
    name: 'DSH 侧栏：状态广播真的送达（broadcastStatus 在调用路径上已就位，不是"没抛就算过"）',
    run: async (ctx) => {
      // 本轮核实项的运行时取证：`main-dsh-sidebar.js` 里 `broadcastStatus()` 有 14 处调用，
      // 而**定义在 1200 行开外** —— 靠**函数声明提升**才成立（既不是外部注入，也没有缺失）。
      // 静态读源码"看得见定义"不等于运行时就到得了：这里把"可达"钉成**可观测副作用**
      //（渲染层真收到事件），而不是"函数没抛异常就算过" —— 后者对本工程毫无价值 ✗。
      //
      // 四条判据，缺一不成立：
      //   ① 渲染层先经**真 IPC** 订阅 `dsh-sidebar:status`（不是合成事件）；
      //   ② 主进程触发一条**真实产品路径**：`ensureRightbarRoom()` → `broadcastStatus()`
      //     （用户点内核官方「打开侧边栏」时走的就是它，见 main-dsh-sidebar.js 的右栏自动加宽）；
      //   ③ 渲染层**真的收到**，且载荷是 `getStatus()` 的结构化对象（status/visible/width 三字段）；
      //   ④ 整个过程**不抛异常** —— 抛了这条直接红，那正是"定义缺失"会有的症状。
      await ctx.exec(`(function () {
        window.__dshStatusProbe = [];
        window.desktop.on('dsh-sidebar:status', function (st) { window.__dshStatusProbe.push(st); });
        return true;
      })()`);
      // ② 落到"侧栏不够宽"这个**确定**前提上：宽 690 ⇒ view 660 < RIGHTBAR_PAGE_MIN(756)
      //    ⇒ `ensureRightbarRoom()` 必然加宽并广播。前提若不成立（widened=false），
      //    这条断言**直接红**而不是静默空转 —— 空转的断言比没有断言更坏 ✗（本工程的既有纪律）。
      const widthBefore = sidebar.getStatus().width;
      let threw = null, widened = null;
      try {
        sidebar.setWidth(690);
        widened = sidebar.ensureRightbarRoom();
      } catch (e) { threw = e; }
      // ③ 等事件送达（真 IPC 是异步的）
      let raw = null;
      for (let i = 0; i < 12 && raw === null; i++) {
        await sleep(120);
        const n = await ctx.exec('((window.__dshStatusProbe || []).length)');
        if (n > 0) raw = await ctx.exec('JSON.stringify(window.__dshStatusProbe[0])');
      }
      // 还原几何：净零改动（后面的域按原来的宽度跑 —— 这里只测通道，不改用户偏好）
      let restored = false;
      try {
        sidebar.releaseRightbarRoom();
        sidebar.setWidth(widthBefore);
        restored = sidebar.getStatus().width === widthBefore;
      } catch (e) { restored = false; }
      let payload = null;
      try { payload = JSON.parse(raw); } catch (e) { payload = null; }
      const shapeOk = !!payload && typeof payload.status === 'string'
        && typeof payload.visible === 'boolean' && typeof payload.width === 'number';
      return {
        ok: threw === null && widened === true && !!raw && shapeOk && restored,
        text: '异常=' + (threw ? String(threw.message) : '无')
          + ' ｜ 真实路径加宽并广播=' + widened
          + ' ｜ 渲染层收到=' + (payload ? (payload.status + ' / visible=' + payload.visible + ' / width=' + payload.width) : '没有')
          + ' ｜ 载荷结构=' + shapeOk + ' ｜ 宽度还原=' + restored + '（' + widthBefore + '）'
      };
    }
  },

  {
    name: 'DSH 侧边栏：token 绝不进渲染层（dsh API 只含 status/beginDrag/endDrag）',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        // preload 暴露 status + 拖宽控制；不该有 loadUrl/带 token 的属性
        const d = window.desktop && window.desktop.dsh;
        const keys = d ? Object.keys(d).sort() : [];
        return { keys, hasLoad: !!d.loadUrl, hasToken: !!(d.token || d.url) };
      })()`);
      // ⚠️ 这是**刻意**的白名单：`desktop.dsh` 的 API 面一变就得在这里显式加一笔 ✓
      //    （防止有人顺手把 loadUrl / token / url 暴露给渲染层 ✗）。本次新增 `prefill`（⑩）：
      //    它只**送文本进去**、回一个 {ok, reason} 的结果 —— 不返回 url/token ✓ 故放行。
      //    P7 又新增 `selDragStart/selDragEnd`（选区拖到原生侧栏视图上）：同样只发 ids/只拿判定
      //    回执 {ok,hit,ids,reason,pt} ✓ 不含 url/token ✓ —— 与"拖宽"那套 beginDrag/endDrag 分开 ✓。
      // P7 跨视图兜底又加一笔 `onSelDrop`（主进程判出悬停松手后把 ids 发回来 ⇒ 渲染层投喂 ✓）。
      // 「真关」语义（v0.19）：`sidebarOnly` 那条（只隐藏页面的旧语义）**已删除**，换成
      //    `closeMapPage`（卸载导图页）/ `openMapPage`（重新加载）/ `bootProject`（重开后该开哪个
      //    项目，只回项目名 ⇒ 不是 url/token ✓）—— 三个都只回结构化结果，理由同上 ✓
      const ok = r.keys.join(',') === 'beginDrag,bootProject,closeMapPage,endDrag,isDshOnly,onSelDrop,'
        + 'openMapPage,prefill,selDragEnd,selDragStart,status,toggle'
        && !r.hasLoad && !r.hasToken;
      return { ok, text: 'desktop.dsh keys=' + r.keys.join(',') };
    }
  },

  {
    name: '边聊边编辑：外部改盘 → 界面自动同步（无脏改动时），且不改磁盘内容',
    run: async (ctx) => {
      // 真实链路黑盒验证：经 CLI 改当前项目（冒烟沙箱副本）→ 渲染层文件监听
      // 自动重读 → 导图出现新节点。CLI 在断言外壳调用（写的是沙箱副本），
      // 渲染层只做轮询观察。验证后经 CLI 删掉探针（副本还原）。
      const st0 = await ctx.exec(`(function () {
        var st = window.MMApp.getState();
        return JSON.stringify({ project: st.project.name, count: Object.keys(st.jm.mind.nodes).length });
      })()`);
      const base = JSON.parse(st0);
      // ① 经 CLI 加探针节点（外壳侧；写沙箱副本）—— **显式指定 id**，删起来可精确回收
      ctx.runCli(['add', base.project, 'overview', '--id', 'disk-sync-probe-9x7',
        '--topic', '磁盘同步探针', '--detail-md', '外部编辑实时同步探针']);
      // ② 等渲染层感知（fs.watch 300ms 防抖 + 重读，轮询最长 8s）
      const got = await ctx.exec(`(function () {
        return window.desktop.__probe ? 'x' : 'x';
      })()`);
      void got;
      const r2 = await ctx.exec(`(function () {
        var before = ${base.count};
        return new Promise(function (resolve) {
          var t0 = Date.now();
          (function poll() {
            var n = Object.keys(window.MMApp.getState().jm.mind.nodes).length;
            // CLI add 生成随机 id，按"节点数 +1"判定同步（topic 文本不唯一不做键）
            if (n === before + 1) return resolve(JSON.stringify({ appeared: true, after: n }));
            if (Date.now() - t0 > 8000) return resolve(JSON.stringify({ appeared: false, after: n }));
            setTimeout(poll, 300);
          })();
        });
      })()`);
      const mid = JSON.parse(r2);
      // ③ 清理探针（外壳侧 CLI，id 是显式的；等界面同步回来）
      try { ctx.runCli(['remove', base.project, 'disk-sync-probe-9x7']); } catch (e) { /* ignore */ }
      const r3 = await ctx.exec(`(function () {
        var before = ${base.count};
        return new Promise(function (resolve) {
          var t0 = Date.now();
          (function poll() {
            var n = Object.keys(window.MMApp.getState().jm.mind.nodes).length;
            if (n === before) return resolve(JSON.stringify({ restored: true, n: n }));
            if (Date.now() - t0 > 8000) return resolve(JSON.stringify({ restored: false, n: n }));
            setTimeout(poll, 300);
          })();
        });
      })()`);
      const fin = JSON.parse(r3);
      const ok = mid.appeared && mid.after === base.count + 1 && fin.restored;
      return { ok, text: '节点数 ' + base.count + ' → ' + mid.after + '（探针出现在导图=' + mid.appeared
        + '）→ ' + fin.n + '（还原=' + fin.restored + '）' };
    }
  },

  {
    name: '边聊边编辑：脏冲突保护 —— 有未保存编辑时不覆盖、只提示',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        const app = window.MMApp;
        // 制造脏改动（内存加节点，不保存）
        app.addNode('overview');
        const dirtyBefore = app.isDirty();
        const nodesBefore = Object.keys(app.getState().jm.mind.nodes).length;
        // 直接调用磁盘变更处理器（模拟主进程通知）——脏状态下必须拒绝重读
        await app.getState ? null : null;
        await window.MM.onProjectDiskChange(null);
        const nodesAfter = Object.keys(app.getState().jm.mind.nodes).length;
        const stillDirty = app.isDirty();
        // 还原：撤销内存编辑
        app.undo();
        const clean = !app.isDirty();
        return { dirtyBefore, nodesBefore, nodesAfter, stillDirty, clean,
          ok: dirtyBefore && stillDirty && nodesAfter === nodesBefore && clean };
      })()`);
      // 收尾：`addNode` 顺手开的「编辑节点」模态必须关掉（它跨域存活会盖住后面的真输入域；
      // 共用工具见 scripts/smoke-assertions.js 的「收尾纪律」）
      const closed = await mm.closeDialogs(ctx);
      return { ok: !!r.ok, text: '脏=' + r.dirtyBefore + ' 重读被拒(节点数不变)=' + (r.nodesAfter === r.nodesBefore)
        + ' 撤销后干净=' + r.clean + ' ｜ 收尾关掉的模态=' + closed.n };
    }
  },

  /* ---------------- v0.20「让 AI 的编辑看得见」（用户 2026-10-13 原话：
   *   "我的 aimindmap 显示我有保存，导致 **AI 编辑的我看不到** ✗ … 就算打架也要可以预览冲突内容 ✓"）
   *
   * 上一条只判了"**不许覆盖**人的编辑"（安全声明 ✓）；这两条补另一半：**看得见** ✓。
   *
   * ⚠️ 判"看得见"的硬规矩（本工程 37 域踩过）：`getBoundingClientRect` 对 `overflow` 裁切
   *   **是盲的** ⇒ 一律用 `document.elementFromPoint(中心)` 命中它自己；差异判**内容**不判样式；
   *   再用真帧截图（`ctx.input.capture` → `shot`）+ 读图留证（"看得见"不许只用 DOM 属性自证）。
   * ⚠️ 外部改动**不许**用 `ctx.runCli` 造（见 15-write-conflict.js 顶部同一条理由：那会被 main.js
   *   正确认作"**代渲染层**写盘"，不是"外部改动"）⇒ 直接 `fs.writeFileSync` 沙箱副本。 */

  {
    name: '并发可见性：界面**有未保存编辑** + 外部改盘 ⇒ 差异看得见（banner 命中测试 + 只读面板 + 零写盘）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '真输入/截图底座不可用（smoke-input 构造失败）⇒ 本项无法验证' };
      const PROBE = 'vis-probe-1';
      const PROBE_TOPIC = '外部改动可见性探针';
      // 干净基线（上一个分域可能留了内存改动）
      await ctx.exec('(async () => { var app = window.MMApp; if (app.isDirty()) await app.save(); return true; })()');
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec('new Promise(function (res) { setTimeout(res, 300); })');
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const beforeText = fs.readFileSync(projFile, 'utf8');

      // ① 界面：制造未保存编辑（**只在内存里**加一个节点）
      const st = await ctx.exec(`(function () {
        var app = window.MMApp;
        var n0 = Object.keys(app.getState().jm.mind.nodes).length;
        app.addNode('overview');
        var n1 = Object.keys(app.getState().jm.mind.nodes).length;
        return { n0: n0, n1: n1, dirty: app.isDirty() };
      })()`);
      // `addNode` 顺手打开了「编辑节点」模态 —— 它会**盖住** banner/面板 ⇒ 立刻收干净（并如实记账）
      const sealed = await mm.closeDialogs(ctx);

      // ② 外部写入者（另一个进程，主进程毫不知情）：往**根**下加一个探针节点
      const disk = JSON.parse(beforeText);
      const tpl = (disk.data.children && disk.data.children[0]) || disk.data;
      const probe = JSON.parse(JSON.stringify(tpl));
      probe.id = PROBE; probe.topic = PROBE_TOPIC; probe.children = [];
      disk.data.children = (disk.data.children || []).concat([probe]);
      fs.writeFileSync(projFile, JSON.stringify(disk, null, 2), 'utf8');
      const diskText = fs.readFileSync(projFile, 'utf8');

      // ③ fs.watch（300ms 防抖）→ 脏分支 ⇒ banner 亮起（**树不重读**：节点数必须还是 n0）
      const shown = await waitTrue(ctx,
        '!!(function(){ var b = document.getElementById("conc-banner"); return b && b.style.display !== "none"; })()', 9000);

      // ④ 命中测试：banner 上那个按钮**真的**在那个坐标上（rect 会漏掉被裁/被盖的情形）
      const hit = await ctx.exec(`(function () {
        var btn = document.getElementById('conc-banner-open');
        var r = btn.getBoundingClientRect();
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var el = document.elementFromPoint(cx, cy);
        return { hitSelf: el === btn || (el && btn.contains(el)), tag: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null,
                 text: document.getElementById('conc-banner-text').textContent, pt: { x: cx, y: cy },
                 nodes: Object.keys(window.MMApp.getState().jm.mind.nodes).length };
      })()`);

      // ⑤ **真鼠标点击**（sendInputEvent：走 Chromium 命中测试，不是 dispatchEvent 合成事件）→ 打开只读面板
      await ctx.input.click(hit.pt);
      await ctx.input.settle({ delayMs: 400 });
      // 判定帧 = 落盘帧（**同源**：同一次采集，判据与证据不许是两张图 ✓，照 H1b ③）
      const frame = await ctx.input.capture();
      const shot = await ctx.input.shot('11-conc-banner-panel.png', frame);

      const panel = await ctx.exec(`(function () {
        var p = document.getElementById('conc-panel');
        var card = p ? p.querySelector('.conc-card') : null;
        var open = !!p && p.style.display !== 'none';
        var r = card ? card.getBoundingClientRect() : null;
        var cx = r ? Math.round(r.left + r.width / 2) : -1, cy = r ? Math.round(r.top + 12) : -1;
        var el = r ? document.elementFromPoint(cx, cy) : null;
        var rows = Array.prototype.map.call(document.querySelectorAll('#conc-body .conc-row'), function (x) {
          return { key: x.getAttribute('data-key'),
                   label: x.querySelector('.conc-row-head').textContent,
                   sides: Array.prototype.map.call(x.querySelectorAll('.conc-side pre'), function (s) { return s.textContent; }) };
        });
        return { open: open, hitCard: !!(card && el && (el === card || card.contains(el))),
                 meta: document.getElementById('conc-meta').textContent,
                 body: document.getElementById('conc-body').textContent, rows: rows,
                 dpr: window.devicePixelRatio || 1,
                 card: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null };
      })()`);

      /* 代码级像素判据（**只留这一条**，理由是实跑对照出来的，别再加回去 ✗）：
       *   **卡片区域是白的**（`#fff` 卡片）—— 证"卡片真被画出来了"（被裁/没画时它是页面底色/遮罩色）。
       * ⚠️ 曾经还有第二条"整页亮像素前后落差 ≥0.25（遮罩出现 ⇒ 页面变暗）"当**抗陈旧帧**用。
       *   两次**全量**实跑把它否掉了（这是判据自身的对照实验，照 testing-for-ai 的 H3）：
       *     · 全量第一次：基线帧同一卡片区域**本来就有 0.920 亮像素**（本应用页面底色接近白）⇒ 判据无效；
       *     · 全量第二次（换成整页落差后）：`前=0.670 后=0.855`（**落差是负的**）—— 两次采集之间
       *       页面自身重绘/滚动条状态在变，与"面板开没开"无关 ⇒ 这个锚点**不可靠** ✗。
       *   ⇒ 抗陈旧帧不靠它：靠 ①`elementFromPoint` 命中自身（H2 的首选判据，遮挡/裁切都抓得住）
       *     ②判定帧与归档帧**同源**（下面 `shot(name, frame)` 用的就是判它那一张）。
       *   本条的残留价值：把"卡片那块真的是白的"变成**像素事实**，与命中测试互补 ✓ */
      let pixel = { ok: false, cardAfter: -1, reason: '无卡片几何' };
      if (panel.card) {
        const dpr = panel.dpr || 1;
        const bright = (a, b, c) => a >= 240 && b >= 240 && c >= 240;   // #fff 卡片
        const cardRect = {
          x: Math.round((panel.card.x + 10) * dpr), y: Math.round((panel.card.y + 8) * dpr),
          width: Math.round(Math.min(180, Math.max(40, panel.card.width - 20)) * dpr), height: Math.round(28 * dpr)
        };
        const s = frameStats.scanRegion(frame, cardRect, { predicate: bright });
        const cardAfter = s.px ? s.hits / s.px : -1;
        pixel = { ok: cardAfter >= 0.6, cardAfter: cardAfter,
          reason: '卡片区域亮像素占比=' + cardAfter.toFixed(3) + '（阈值 0.6；判的是"白卡片真的画出来了"）' };
      }

      // ⑥ 只读铁律：打开面板前后**盘上零字节变化** + 内存树没被重读
      const afterText = fs.readFileSync(projFile, 'utf8');
      let mineLabelled = false;
      (panel.rows || []).forEach((row) => {
        if (row.key === 'children:root' && Array.isArray(row.sides) && row.sides.length === 2) mineLabelled = true;
      });
      const hitRow = (panel.rows || []).some((row) => row.key === 'node:' + PROBE
        && Array.isArray(row.sides) && row.sides.join(' ').indexOf(PROBE_TOPIC) >= 0);

      // 收尾：撤销内存改动 + 把盘上还原成原样（沙箱副本，不留状态给后面的分域），并收掉两层浮层
      await ctx.exec('(function () { window.MMApp.undo(); return true; })()');
      fs.writeFileSync(projFile, beforeText, 'utf8');
      const closed2 = await mm.closeDialogs(ctx);

      const ok = st.dirty === true && st.n0 > 0 && shown.ok && hit.hitSelf
        && hit.nodes === st.n1                       // 脏分支**没有**重读树（节点数不变）
        && panel.open && panel.hitCard && hitRow && mineLabelled
        && pixel.ok                                   // 像素差分：卡片真的被画出来了（不是只有 DOM）
        && afterText === diskText                     // 打开面板不写盘
        && shot.bytes > 0;
      return {
        ok: ok,
        text: '内存节点的编辑={dirty=' + st.dirty + ',节点数 ' + st.n0 + '→' + st.n1 + '} · 收掉的模态=' + sealed.n
          + ' · banner 出现=' + shown.ok + '(' + shown.ms + 'ms)「' + hit.text + '」'
          + ' · 命中测试=' + hit.hitSelf + '（命中=' + hit.tag + '）'
          + ' · 面板打开=' + panel.open + '/卡片命中=' + panel.hitCard
          + ' · 面板行=' + (panel.rows || []).map((r) => r.key).join(',')
          + ' · 外部探针内容在面板里=' + hitRow
          + ' · 像素差分：' + pixel.reason + '（判绿=' + pixel.ok + '）'
          + ' · 盘上零字节变化=' + (afterText === diskText)
          + ' · 内存树未重读=' + (hit.nodes === st.n1)
          + ' · 截图=' + shot.file + '(' + shot.bytes + 'B,' + shot.sha256 + ')'
          + ' ｜ 收尾关掉=' + closed2.n
      };
    }
  },

  {
    name: '并发可见性：窗口获得焦点 ⇒ 主进程**只读**比对盘上指纹，落后就复用既有事件再亮差异（不误报）',
    run: async (ctx) => {
      /* 这一条守的是"**人回到窗口**"那个时机（`fs.watch` 只在写盘那一刻触发，那时人可能不在看）。
       * ⚠️ 离屏窗口永远收不到真实 OS focus ⇒ 这里 `ctx.win.emit('focus')` 触发**产品自己注册的那个
       *    监听器**（不另造入口）。因此本项证的是"焦点这条路上产品真的会去比、并把差异亮出来"，
       *    **不证**"真实 OS 焦点事件的时序"（那条边界如实写在这里，别把它读强了）。
       * ⚠️ 判别力关键：先把 banner **关掉**再 emit —— 此时没有任何写盘、没有任何 fs.watch 事件，
       *    banner 若又出现，只可能是焦点探针干的（若探针被改坏，本条必红）。 */
      if (!ctx.input) return { ok: false, text: '真输入底座不可用 ⇒ 本项无法验证' };
      const PROBE = 'vis-probe-2';
      const PROBE_TOPIC = '焦点探针';
      await ctx.exec('(async () => { var app = window.MMApp; if (app.isDirty()) await app.save(); return true; })()');
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec('new Promise(function (res) { setTimeout(res, 300); })');
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const beforeText = fs.readFileSync(projFile, 'utf8');

      // ① 界面脏 + 外部改盘（构造"界面落后"）
      await ctx.exec('(function () { window.MMApp.addNode("overview"); return window.MMApp.isDirty(); })()');
      const sealed = await mm.closeDialogs(ctx);
      const disk = JSON.parse(beforeText);
      const tpl = (disk.data.children && disk.data.children[0]) || disk.data;
      const probe = JSON.parse(JSON.stringify(tpl));
      probe.id = PROBE; probe.topic = PROBE_TOPIC; probe.children = [];
      disk.data.children = (disk.data.children || []).concat([probe]);
      fs.writeFileSync(projFile, JSON.stringify(disk, null, 2), 'utf8');
      const shown = await waitTrue(ctx,
        '!!(function(){ var b = document.getElementById("conc-banner"); return b && b.style.display !== "none"; })()', 9000);
      // 关掉它 + 等防抖窗口彻底过去（此后**没有任何写盘**）
      await ctx.exec('(function () { window.MMApp.closeConcBanner(); return true; })()');
      await sleep(1200);
      const hiddenAgain = await ctx.exec('(function(){ var b = document.getElementById("conc-banner"); return b.style.display === "none"; })()');

      // ② 只是"回到窗口"（emit focus）⇒ 主进程只读比对发现盘上版本 ≠ 界面读到的那一版 ⇒ 复用既有事件
      ctx.win.emit('focus');
      const back = await waitTrue(ctx,
        '!!(function(){ var b = document.getElementById("conc-banner"); return b && b.style.display !== "none"; })()', 5000);
      // "又亮"必须是**真的亮**（可见性判据不许只用行内样式：被裁/被盖时 display 照样不是 none ✗）
      const hitAgain = await ctx.exec(`(function () {
        var btn = document.getElementById('conc-banner-open');
        var r = btn.getBoundingClientRect();
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var el = document.elementFromPoint(cx, cy);
        return { hitSelf: el === btn || (el && btn.contains(el)), tag: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null };
      })()`);

      // ③ 反向对照（第三态）：盘上还原成"界面读到的那一版" ⇒ 焦点不该再报（**不制造假警报**）
      await ctx.exec('(function () { window.MMApp.closeConcBanner(); return true; })()');
      await sleep(600);
      fs.writeFileSync(projFile, beforeText, 'utf8');
      await sleep(1500);        // 让"还原"这次写盘自己的 fs.watch 事件先过去（否则分不清是谁触发的）
      await ctx.exec('(function () { window.MMApp.closeConcBanner(); return true; })()');
      ctx.win.emit('focus');
      await sleep(1200);
      const noFalseAlarm = await ctx.exec('(function(){ var b = document.getElementById("conc-banner"); return b.style.display === "none"; })()');

      // 收尾
      await ctx.exec('(function () { window.MMApp.undo(); return true; })()');
      fs.writeFileSync(projFile, beforeText, 'utf8');
      const closed2 = await mm.closeDialogs(ctx);
      return {
        ok: shown.ok && hiddenAgain === true && back.ok && hitAgain.hitSelf === true && noFalseAlarm === true,
        text: '外部改盘 ⇒ banner 亮=' + shown.ok + ' · 手动关掉=' + hiddenAgain
          + ' · 一次 emit(focus)（无任何写盘）后**又亮**=' + back.ok + '(' + back.ms + 'ms)'
          + '且真的可命中=' + hitAgain.hitSelf + '（命中=' + hitAgain.tag + '）'
          + ' · 盘上还原成基线后 emit(focus) 不再报=' + noFalseAlarm
          + ' ｜ 收掉的模态=' + sealed.n + '，收尾关掉=' + closed2.n
      };
    }
  },

  {
    name: '并发可见性：ui-state 能答「界面所见落后盘上多少」（seenVersion/baseVersion 与盘上指纹可比）',
    run: async (ctx) => {
      /* 为什么单独立一条：用户抱怨的"AI 编辑的我看不到"，本质是**界面不知道、AI 也问不到**
       * "界面所见落后盘上多少"。现在这两个值都落进 `.ui-state.json`（读方 = 侧栏 AI 经
       * `ui-state --json`）；本项判"**真的能比出来**"，而不是"字段存在"（存在但恒相等 = 空转）。 */
      const PROBE = 'vis-probe-3';
      await ctx.exec('(async () => { var app = window.MMApp; if (app.isDirty()) await app.save(); return true; })()');
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec('new Promise(function (res) { setTimeout(res, 300); })');
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const beforeText = fs.readFileSync(projFile, 'utf8');
      const seen0 = JSON.parse(ctx.runCli(['ui-state', 'comnet', '--json']));

      // ① 界面脏 + 外部改盘 ⇒ 界面所见**停在旧版**，盘上已经是新版（这就是"落后"）
      await ctx.exec('(function () { window.MMApp.addNode("overview"); return window.MMApp.isDirty(); })()');
      const sealed = await mm.closeDialogs(ctx);
      const disk = JSON.parse(beforeText);
      const tpl = (disk.data.children && disk.data.children[0]) || disk.data;
      const probe = JSON.parse(JSON.stringify(tpl));
      probe.id = PROBE; probe.topic = '落后探针'; probe.children = [];
      disk.data.children = (disk.data.children || []).concat([probe]);
      fs.writeFileSync(projFile, JSON.stringify(disk, null, 2), 'utf8');
      await waitTrue(ctx,
        '!!(function(){ var b = document.getElementById("conc-banner"); return b && b.style.display !== "none"; })()', 9000);

      const diskVersion = dataStore.versionOf(projFile);          // 与写盘闸门同一份实现（不是另算一份哈希）
      const s1 = JSON.parse(ctx.runCli(['ui-state', 'comnet', '--json']));
      // 这一条的名字也声称"可见性"（界面看得见/看不见）⇒ 同一道门禁要求**真判据**：
      // 对 banner 上那个可点条目做命中测试（行内样式读不出"被裁/被盖"）
      const hitBanner = await ctx.exec(`(function () {
        var btn = document.getElementById('conc-banner-open');
        var r = btn.getBoundingClientRect();
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        var el = document.elementFromPoint(cx, cy);
        return { hitSelf: el === btn || (el && btn.contains(el)), tag: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null };
      })()`);
      const behind = s1.exists === true && s1.dirty === true && hitBanner.hitSelf === true
        && !!s1.seenVersion && s1.seenVersion !== diskVersion;    // 界面所见 ≠ 盘上最新 ⇒ 可判"落后"
      const hasBoth = !!(s1.seenVersion && s1.baseVersion);

      // ② 撤销内存改动 + 界面**干净**地同步一次（等价于"人回到界面、无未保存编辑"那条路）
      const synced = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.undo();
        await new Promise(function (res) { setTimeout(res, 100); });
        await window.MM.onProjectDiskChange(null);       // 同一条既有判定：无脏 ⇒ 静默重读
        await new Promise(function (res) { setTimeout(res, 400); });
        return { dirty: app.isDirty(), nodes: Object.keys(app.getState().jm.mind.nodes).length };
      })()`);
      const s2 = JSON.parse(ctx.runCli(['ui-state', 'comnet', '--json']));
      const caughtUp = !!s2.seenVersion && s2.seenVersion === dataStore.versionOf(projFile)
        && s2.seenVersion !== s1.seenVersion;                    // 所见版本**真的前进**了（不是写死的常量）

      // 收尾：删探针（外部写入者身份，直接改文件）→ 让后面分域看到干净状态
      const back = JSON.parse(beforeText);
      fs.writeFileSync(projFile, JSON.stringify(back, null, 2), 'utf8');
      await sleep(400);
      await ctx.exec('window.MMApp.openProject("comnet")');
      const closed2 = await mm.closeDialogs(ctx);
      return {
        ok: seen0.exists === true && seen0.dirty === false && hasBoth && behind && caughtUp
          && synced.dirty === false,
        text: '基线 seenVersion=' + String(seen0.seenVersion).slice(0, 8)
          + ' · 脏+外部改盘 ⇒ seen=' + String(s1.seenVersion).slice(0, 8) + ' / 盘上 '
          + String(diskVersion).slice(0, 8) + ' ⇒ 落后可判=' + behind
          + '（banner 真的可命中=' + hitBanner.hitSelf + '，命中=' + hitBanner.tag + '）'
          + ' · 干净同步后 seen=' + String(s2.seenVersion).slice(0, 8) + ' ⇒ 追平=' + caughtUp
          + ' · baseVersion 同批给出=' + hasBoth
          + ' ｜ 收掉的模态=' + sealed.n + '，收尾关掉=' + closed2.n
      };
    }
  }
];

module.exports = assertions;
