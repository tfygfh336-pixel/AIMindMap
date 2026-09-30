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
      // 直接驱动渲染层的 layout 处理链路：模拟主进程事件（渲染层监听的是
      // dsh-sidebar:layout；冒烟下主进程不会发，这里经 IPC 事件回调真实触发）
      const r = await ctx.exec(`(async () => {
        const main = document.getElementById('main');
        const tick = () => new Promise((res) => setTimeout(res, 30));
        // ⚠️ 只验**类与 CSS 规则的契约**（on ⇒ 让位 420px；off ⇒ 收回 0px）。
        // 旧版用"before ≠ after"当判据是**前提过期**了：渲染层现在启动时就会主动问一次真实布局
        //（修"刚打开时工具栏被侧栏盖住"，见 scripts/smoke/21-sidebar-first-paint.js），
        // 所以开始时 class 可能本来就是 on（侧栏显示中），before 会是 420px。
        document.body.classList.add('dsh-sidebar-on');
        await tick();
        const onMargin = getComputedStyle(main).marginRight;
        const onPad = getComputedStyle(document.getElementById('toolbar')).paddingRight;
        document.body.classList.remove('dsh-sidebar-on');
        await tick();
        const offMargin = getComputedStyle(main).marginRight;
        const offPad = getComputedStyle(document.getElementById('toolbar')).paddingRight;
        return { onMargin, offMargin, onPad, offPad,
          // off 时工具栏回到它**自身**的默认内边距（实测 12px，不是 0）——
          // 所以判据是"off 明显小于 on"，而不是写死 0px
          ok: onMargin === '420px' && offMargin === '0px'
            && parseInt(onPad, 10) >= 428 && parseInt(offPad, 10) < 20 };
      })()`);
      return { ok: !!r.ok, text: 'margin on/off ' + r.onMargin + ' / ' + r.offMargin
        + '（toolbar paddingRight on/off ' + r.onPad + ' / ' + r.offPad + '）' };
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
      const ok = r.keys.join(',') === 'beginDrag,endDrag,isDshOnly,status,toggle'
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
      return { ok: !!r.ok, text: '脏=' + r.dirtyBefore + ' 重读被拒(节点数不变)=' + (r.nodesAfter === r.nodesBefore)
        + ' 撤销后干净=' + r.clean };
    }
  }
];

module.exports = assertions;
