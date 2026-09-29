/* ============================================================
 * scripts/smoke/13-ui-state.js —— 「写前协调」可执行通道（v0.16.6）
 * ------------------------------------------------------------
 * 覆盖的是**真实链路**：渲染层脏标记变化 → preload `app.uiState` → 主进程原子写
 * `projects/<项目>/.ui-state.json` → 侧栏 AI 用 `cli/mm-cli.js ui-state` 读。
 *
 * 为什么必须有这一条：这条链路的前身是一个"有 handler、零调用方"的 IPC
 * （`dsh-sidebar:ui-dirty`）—— 文档写着"批量编辑前先查 dirty"，实际谁也调不到，
 * 而所有门禁照样全绿（行为级测试测不到"文档承诺能否被执行"）。
 * 所以断言必须**从界面操作走到 CLI 输出**，而不是只测一个函数存在。
 * ============================================================ */
'use strict';

const assertions = [
  {
    name: '写前协调：preload 暴露 app.uiState 通道（渲染层能上报，不再是死通道）',
    run: async (ctx) => {
      const r = await ctx.exec(`(function () {
        var app = window.desktop && window.desktop.app;
        return { has: !!(app && typeof app.uiState === 'function'),
                 keys: app ? Object.keys(app).sort() : [] };
      })()`);
      return { ok: !!r.has, text: 'desktop.app.uiState=' + r.has
        + '（通道存在；旧 dsh-sidebar:ui-dirty 已删除，见 src/ui-state.js）' };
    }
  },

  {
    name: '写前协调：界面加载项目 → 盘上落 clean（CLI 读到 uiRunning=true、dirty=false）',
    run: async (ctx) => {
      // 先保证干净基线：脏就先存盘（上一个分域可能留了内存改动）
      await ctx.exec(`(async () => {
        var app = window.MMApp;
        if (app.isDirty()) await app.save();
        await app.getState() && null;
      })()`);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec('new Promise(function (res) { setTimeout(res, 300); })'); // 等 IPC + 原子写

      const out = ctx.runCli(['ui-state', 'comnet', '--json']);
      const s = JSON.parse(out);
      return {
        ok: s.exists === true && s.uiRunning === true && s.dirty === false,
        text: 'CLI 读到 exists=' + s.exists + ' uiRunning=' + s.uiRunning + ' dirty=' + s.dirty
          + '（渲染层→IPC→磁盘→CLI 全链路）'
      };
    }
  },

  {
    name: '写前协调：内存改动 → CLI 读到 dirty=true；撤销后回到 clean（信号跟着脏标记走）',
    run: async (ctx) => {
      const dirty = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.addNode('overview');            // 只在内存里加，不保存
        var isDirty = app.isDirty();
        await new Promise(function (res) { setTimeout(res, 300); });
        return isDirty;
      })()`);
      const s1 = JSON.parse(ctx.runCli(['ui-state', 'comnet', '--json']));

      const clean = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.undo();                          // 还原，不留探针
        var isClean = !app.isDirty();
        await new Promise(function (res) { setTimeout(res, 300); });
        return isClean;
      })()`);
      const s2 = JSON.parse(ctx.runCli(['ui-state', 'comnet', '--json']));

      return {
        ok: dirty === true && s1.dirty === true && clean === true && s2.dirty === false,
        text: '内存脏=' + dirty + ' → CLI dirty=' + s1.dirty
          + ' ｜ 撤销后干净=' + clean + ' → CLI dirty=' + s2.dirty
      };
    }
  },

  {
    name: '写前协调：信号是点文件，不污染项目列表（AI 不会把它当成一个新项目）',
    run: async (ctx) => {
      const list = JSON.parse(ctx.runCli(['projects', '--json']));
      const names = list.map((p) => p.name);
      const polluted = names.filter((n) => n.indexOf('ui-state') >= 0 || n.charAt(0) === '.');
      const s = JSON.parse(ctx.runCli(['ui-state', '--json']));
      const inSummary = (s.projects || []).some((p) => p.project === 'comnet' && p.exists === true);
      return {
        ok: polluted.length === 0 && inSummary,
        text: '项目列表=' + names.join(',') + '（无点文件污染=' + (polluted.length === 0)
          + '）｜ui-state 汇总含 comnet 状态文件=' + inSummary
      };
    }
  }
];

module.exports = assertions;
