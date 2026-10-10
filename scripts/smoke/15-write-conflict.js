/* ============================================================
 * scripts/smoke/15-write-conflict.js —— 多路同时编辑（GUI 侧：合并 / 冲突）
 * ------------------------------------------------------------
 * 覆盖的是 main.js `project:save` 顶部注释里**已实测过**的事故类别：
 *   「AI/CLI 在界面打开期间新写的笔记，渲染层根本没见过 → 写回时被抹掉」
 *
 * **阶段 1 时**这里的判据是"外部写入后保存必须被**拒绝**"（只拦不合）。
 * **阶段 2 起**改成更强的判据：**两边改的对象不相交 ⇒ 自动合并，双方的改动都要在**；
 * 只有**撞在同一个对象上**才拒绝 —— 而拒绝时也必须**盘上一字不动**。
 * 为什么判据要升级：旧判据把"拒绝"当成功，于是**用户全部未保存的改动一起丢掉**（只剩重开一条路）；
 * 新判据直接问"数据有没有丢、有没有人白做"。
 *
 * 判据刻意**不依赖 DOM 文案**，而用实质事实（读盘比对）：
 *   · 合并成功 ⇒ `save()` 返回 true，且**盘上同时存在**外部写的节点与界面的改动；
 *   · 冲突     ⇒ `save()` 返回 false，且盘上文件**逐字节等于**外部写入者刚写的那一份。
 * 另外两条是护栏：**假阳性守卫**（无并发写时必须能存，否则闸门是废件）
 * 与**可恢复守卫**（重开项目后必须能存，否则闸门把项目永久卡死）。
 * ============================================================ */
'use strict';

const fs = require('fs');

// 冒烟共用工具（收尾纪律与用法见 scripts/smoke-assertions.js 顶部）：动了 addNode 就要收模态
const mm = require('../smoke-assertions.js');

const PROBE_ID = 'cc-probe-1';        // 外部写入者加在**根**下的节点（与界面的改动不同父 ⇒ 不相交）
const PROBE_ID2 = 'cc-probe-2';       // 外部写入者加在 **overview** 下的节点（与界面的改动同父 ⇒ 相交）
const PROBE_TOPIC = '并发闸门探针';

/** 等主进程 IPC + 原子写落盘（与 13-ui-state.js 同一手法） */
const settle = 'new Promise(function (res) { setTimeout(res, 300); })';

/** `ctx.runCli` 在 CLI **非 0 退出**时会抛错（harness 行为）。这里统一兜住并返回 {ok, out}，
 *  否则"节点已被删掉"这种**预期内**的失败会把整条断言炸掉而不是给出判据。 */
function cli(ctx, args) {
  try { return { ok: true, out: String(ctx.runCli(args)) }; }
  catch (e) { return { ok: false, out: String((e && e.message) || e) }; }
}

const readProj = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

/** 某节点的直接子节点数（用于确认"界面的改动确实落盘了"） */
function childCount(proj, id) {
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (n.id === id) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(proj.data);
  return hit ? (hit.children || []).length : -1;
}

/** 造一个 schema 合法的探针节点（形状从现有节点克隆） */
function makeProbe(proj, id, topic) {
  const template = (Array.isArray(proj.data.children) && proj.data.children[0]) || proj.data;
  const probe = JSON.parse(JSON.stringify(template));
  probe.id = id;
  probe.topic = topic;
  probe.children = [];
  return probe;
}

const assertions = [
  {
    name: '并发：只有内存改动、无人并发写 → 保存正常（不误报）',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const dirty = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.addNode('overview');
        var d = app.isDirty();
        var saved = await app.save();
        return { d: d, saved: saved, clean: !app.isDirty() };
      })()`);
      // 收尾：`addNode` 顺手开的「编辑节点」模态必须当场关掉（跨域存活会盖住后面的真输入域；
      // 共用工具见 scripts/smoke-assertions.js 的「收尾纪律」）
      const closed = await mm.closeDialogs(ctx);
      return {
        ok: dirty.d === true && dirty.saved === true && dirty.clean === true,
        text: '内存脏=' + dirty.d + ' → save()=' + dirty.saved + ' → 保存后干净=' + dirty.clean
          + '（无并发写时必须能存，否则闸门是废件）｜ 收尾关掉的模态=' + closed.n
      };
    }
  },

  {
    name: '并发合并：外部改了**别的对象** → 保存自动合并（两边改动都在）',
    run: async (ctx) => {
      // 1) 界面加载项目：主进程据此记下"渲染层这份是从哪一版、什么内容读来的"
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const projFile = await ctx.exec('window.MMApp.getState().project.file');

      // 2) 界面里做一个未保存的改动：往 overview 下加子节点（改的是 children:overview）
      await ctx.exec(`(function () { window.MMApp.addNode('overview'); return window.MMApp.isDirty(); })()`);
      const before = readProj(projFile);
      const overviewBefore = childCount(before, 'overview');

      // 3) 模拟**外部写入者**（另一个进程自己跑 CLI，主进程毫不知情）：往**根**下加节点。
      //    为什么不用 `ctx.runCli` 造这一步：它走 main.js 自己的 `runCli`，会被
      //    `refreshVersionIfOwnWrite` 正确地认作"**代渲染层**写盘"，因而不是"外部写入"。
      //    直接改文件对闸门而言效果完全相同：文件版本变了，而 `versionAtRead` / `baseAtRead` 没变。
      const proj = readProj(projFile);
      proj.data.children = (proj.data.children || []).concat([makeProbe(proj, PROBE_ID, PROBE_TOPIC)]);
      fs.writeFileSync(projFile, JSON.stringify(proj, null, 2), 'utf8');

      // 4) 界面保存 ⇒ 应当**自动合并**（不是拒绝）
      const saved = await ctx.exec('(async () => await window.MMApp.save())()');

      // 5) 实质判据：外部写的节点**和**界面的改动，两者都必须落盘
      const after = readProj(projFile);
      const overviewAfter = childCount(after, 'overview');
      const probeThere = cli(ctx, ['get', 'comnet', PROBE_ID, '--json']).ok === true;
      const mineThere = overviewAfter === overviewBefore + 1;
      // 收尾（同第 1 条）：`addNode` 开的「编辑节点」模态关掉，别让它跨域存活
      const closed = await mm.closeDialogs(ctx);

      return {
        ok: saved === true && probeThere === true && mineThere === true,
        text: 'save()=' + saved + ' · 外部节点仍在=' + probeThere + ' · 界面改动也落盘=' + mineThere
          + '（overview 子节点 ' + overviewBefore + '→' + overviewAfter + '）'
          + ' ｜ 收尾关掉的模态=' + closed.n
          + (saved === false ? '｜⚠️ 仍被一律拒绝：用户的改动全丢了' : '')
      };
    }
  },

  {
    name: '并发冲突：外部改了**同一对象** → 拒绝且盘上一字不动；再用「磁盘版本」能存（其余改动保住）',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const projFile = await ctx.exec('window.MMApp.getState().project.file');

      // 界面：① 往 overview 下加子节点（与外部**同对象**）② 往 root 下加子节点（**另一个对象**，不该受牵连）
      await ctx.exec(`(function () {
        window.MMApp.addNode('overview');   // 会与外部撞车
        window.MMApp.addNode('root');       // 与外部不相交
        return window.MMApp.isDirty();
      })()`);
      const before = readProj(projFile);
      const overviewBefore = childCount(before, 'overview');
      const rootBefore = childCount(before, 'root');

      // 外部：往 overview 下加探针（同一个父 ⇒ children:overview 相交）
      const proj = readProj(projFile);
      let overview = null;
      (function walk(n) { if (!n || overview) return; if (n.id === 'overview') { overview = n; return; } (n.children || []).forEach(walk); })(proj.data);
      if (!overview) return { ok: false, text: '前置失败：comnet 里没有 overview 节点，本断言无法构造同对象冲突' };
      overview.children = (overview.children || []).concat([makeProbe(proj, PROBE_ID2, PROBE_TOPIC + '（同对象）')]);
      const written = JSON.stringify(proj, null, 2);
      fs.writeFileSync(projFile, written, 'utf8');

      // ① 界面保存 ⇒ 必须被拦（同一对象，顺序会歧义，不能自动决定）
      const saved = await ctx.exec('(async () => await window.MMApp.save())()');
      const untouched = fs.readFileSync(projFile, 'utf8') === written;   // 我们一个字节都没写

      // ② 用「磁盘上的版本」重试 ⇒ 应当成功：冲突对象取盘上那份，**我别的改动照常落盘**
      const resolved = await ctx.exec('(async () => await window.MMApp.resolveConflict("theirs"))()');
      const after = readProj(projFile);
      const overviewAfter = childCount(after, 'overview');
      const rootAfter = childCount(after, 'root');
      const theirsWon = overviewAfter === overviewBefore + 1;   // 只有外部那个探针（我的被丢弃）
      const mineKept = rootAfter === rootBefore + 1;            // 我加在 root 下的节点保住了
      const probeThere = cli(ctx, ['get', 'comnet', PROBE_ID2, '--json']).ok === true;
      // 收尾（同第 1 条）：本断言用了两次 `addNode`（各开一个模态）
      const closed2 = await mm.closeDialogs(ctx);

      return {
        ok: saved === false && untouched === true && resolved === true && theirsWon === true
          && mineKept === true && probeThere === true,
        text: '首次 save()=' + saved + '（应 false）· 盘上逐字节未变=' + untouched
          + ' ｜ resolveConflict("theirs")=' + resolved + '（应 true）· 冲突对象取盘上=' + theirsWon
          + '（overview ' + overviewBefore + '→' + overviewAfter + '）· 我的其他改动保住=' + mineKept
          + '（root ' + rootBefore + '→' + rootAfter + '）· 收尾关掉的模态=' + closed2.n
          + (saved === true ? '｜⚠️ 同一对象被自动决定了 —— 那是"最后写者赢"，会静默丢数据' : '')
      };
    }
  },

  {
    name: '变更可见性：界面保存也会记进变更日志（GUI 那条写路径与 CLI 共用同一份记账）',
    run: async (ctx) => {
      // 为什么单独测这一条：GUI 的保存**不走 `store.write`**（它自己跑 validate 探针 +
      // writeFileAtomic），所以它的记账是**另一个调用点**。不测就等于"两个出口只验了一个"。
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const saved = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.addNode('overview');
        return await app.save();
      })()`);
      const log = JSON.parse(cli(ctx, ['changes', 'comnet', '--json']).out);
      const last = (log.changes || [])[(log.changes || []).length - 1] || null;
      const isGui = !!last && /^gui/.test(String(last.writer));
      const named = !!last && !last.created && Array.isArray(last.changed) && last.changed.length > 0;
      // 收尾（同第 1 条）：这条也用了 `addNode`
      const closed3 = await mm.closeDialogs(ctx);
      return {
        ok: saved === true && isGui === true && named === true,
        text: 'save()=' + saved + ' · 日志最后一条写入者=' + (last ? last.writer : '（无）')
          + '（应 gui…）· 记下了改动的对象=' + (last ? last.changed.join(',') : '（无）')
          + ' ｜ 收尾关掉的模态=' + closed3.n
      };
    }
  },

  {
    name: '并发：重新打开项目后恢复可保存（闸门不会把项目永久卡死）',
    run: async (ctx) => {
      // 清掉上面留下的探针与内存改动
      await ctx.exec('(function () { window.MMApp.undo(); return true; })()');
      cli(ctx, ['remove', 'comnet', PROBE_ID]);
      cli(ctx, ['remove', 'comnet', PROBE_ID2]);

      // 重新打开 = 重新读盘 ⇒ 主进程记下的版本与基线都刷新为当前盘上那一版
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const again = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.addNode('overview');
        var saved = await app.save();
        app.undo();                 // 清掉探针改动，不留状态给后续分域
        return { saved: saved };
      })()`);

      const gone = cli(ctx, ['get', 'comnet', PROBE_ID, '--json']);
      const gone2 = cli(ctx, ['get', 'comnet', PROBE_ID2, '--json']);
      const removed = gone.ok === false && gone2.ok === false;
      // 收尾（同第 1 条）：这条也用了 `addNode`
      const closed4 = await mm.closeDialogs(ctx);

      return {
        ok: again.saved === true && removed === true,
        text: '重新打开后 save()=' + again.saved + '（应 true，证明闸门可恢复）｜探针已清理=' + removed
          + ' ｜ 收尾关掉的模态=' + closed4.n
      };
    }
  }
];

module.exports = assertions;
