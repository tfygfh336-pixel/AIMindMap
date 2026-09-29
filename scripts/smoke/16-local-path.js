/* ============================================================
 * scripts/smoke/16-local-path.js —— 节点「本机文件夹」链接（localPath）
 * ------------------------------------------------------------
 * 覆盖的能力：从**文件夹结构**建出来的树，每个结构节点挂一条本机目录路径；
 * 界面详情框里显示可点链接，右键菜单也有「📁 打开文件夹」，点击即用系统文件管理器打开该目录。
 *
 * 三条断言对应三个**真实失效模式**：
 *   ① CLI 设了字段，界面却看不见（读视图/渲染没接上 —— 字段存在但功能等于没有）；
 *   ② **界面保存把字段丢掉**：`serializeTree()` 是**手挑字段**的，漏一个就静默丢
 *      （与"保存不丢 assoc"同型，实测踩过一次）；
 *   ③ 点了没反应：路径不存在/盘没挂时，必须**明确报错**，不能静默什么都不做。
 *
 * ⚠️ headless 下 `app:open-file` **不会真的开窗**（主进程带 isSmoke 守卫，只校验并回报
 *    `headless:true`）—— 否则每跑一次 verify 都会在跑验证的机器上弹出文件管理器。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/** 等主进程 IPC + 原子写落盘 */
const settle = 'new Promise(function (res) { setTimeout(res, 300); })';

/** `ctx.runCli` 在 CLI 非 0 退出时抛错；统一兜住，否则"预期内的失败"会把断言炸掉而不是给出判据 */
function cli(ctx, args) {
  try { return { ok: true, out: String(ctx.runCli(args)) }; }
  catch (e) { return { ok: false, out: String((e && e.message) || e) }; }
}

/** 在项目 JSON 里按 id 找节点（直接读盘，判据不经过任何视图层） */
function findNode(file, id) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  let hit = null;
  (function walk(n) { if (!n || hit) return; if (n.id === id) { hit = n; return; } (n.children || []).forEach(walk); })(data.data);
  return hit;
}

const NODE = 'tcp-handshake';   // comnet 里稳定存在的节点（多个分域都在用）

const assertions = [
  {
    name: '本机文件夹：CLI 设了 localPath → 界面详情框出现可点链接',
    run: async (ctx) => {
      // 用**必定存在**的目录：项目自己的目录（不假设这台机器上有 E: 盘）
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const dir = path.dirname(projFile);
      const set = cli(ctx, ['edit', 'comnet', NODE, '--local-path', dir]);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const r = await ctx.exec(`(function () {
        var app = window.MMApp, jm = app.getState().jm;
        app.closeAllFloatDetail(); app.showDetail(jm.get_node('${NODE}'));
        var el = document.querySelector('.fd-localpath-link');
        var n = jm.get_node('${NODE}');
        return { hasEl: !!el, text: el ? el.textContent : '', inData: (n && n.data && n.data.localPath) || '' };
      })()`);
      return {
        ok: set.ok === true && r.hasEl === true && r.text.indexOf(dir) >= 0 && r.inData === dir,
        text: 'CLI 设置=' + set.ok + ' · 详情框有链接=' + r.hasEl + ' · 链接文本含路径=' + (r.text.indexOf(dir) >= 0)
          + ' · 节点 data 里有=' + (r.inData === dir)
      };
    }
  },

  {
    name: '本机文件夹：界面保存后 localPath 不丢（整树写回是手挑字段，漏一个就静默丢）',
    run: async (ctx) => {
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const dir = path.dirname(projFile);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        app.addNode('overview');           // 制造一个真实改动（否则可能走不到写盘）
        var saved = await app.save();
        app.undo();                        // 撤掉探针改动
        return { saved: saved };
      })()`);
      const node = findNode(projFile, NODE);
      const kept = !!node && node.localPath === dir;
      return {
        ok: r.saved === true && kept === true,
        text: '界面 save()=' + r.saved + ' · 盘上该节点的 localPath 仍在=' + kept
          + (kept ? '' : '｜⚠️ 字段被整树写回丢掉了')
      };
    }
  },

  {
    name: '本机文件夹：点开的两种结局 —— 存在⇒ok、不存在⇒明确报错（headless 不弹窗）',
    run: async (ctx) => {
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const dir = path.dirname(projFile);
      const bad = path.join(dir, 'no-such-dir-xyz-12345');
      const good = await ctx.exec(`window.desktop.app.openFile(${JSON.stringify(dir)})`);
      const notGood = await ctx.exec(`window.desktop.app.openFile(${JSON.stringify(bad)})`);
      const noPop = good && good.headless === true;
      // 真的点一次链接（用不存在的路径 ⇒ 不会弹窗）。判据是**"点击确实调用了打开通道、参数是那个路径"**——
      // 比读状态栏稳：状态栏还有别的机制在写（文件监听会发现项目被外部改动并提示，
      // 实测我的"打不开"提示会被它覆盖掉，于是断言假红）。IPC 那两种结局由上面两行独立覆盖。
      const clicked = await ctx.exec(`(async () => {
        var app = window.MMApp, jm = app.getState().jm;
        var n = jm.get_node('${NODE}');
        var backup = n.data.localPath;
        n.data.localPath = ${JSON.stringify(bad)};
        app.closeAllFloatDetail(); app.showDetail(n);
        var el = document.querySelector('.fd-localpath-link');
        if (!el) { n.data.localPath = backup; return { clicked: false, calls: [] }; }
        var calls = [];
        // 挂到 window.MM 上：详情框里的链接调的是**内部命名空间** MM.openLocalPath
        // （window.MMApp.openLocalPath 只是给它包了一层的对外 API —— 替换后者拦不到，
        //  实测踩过：spy 记到 0 次调用，而点击其实发生了）
        var orig = window.MM.openLocalPath;
        window.MM.openLocalPath = function (p) { calls.push(p); return orig(p); };
        el.click();
        // 只触发一次，之后只读轮询（固定的短 sleep 会读到上一轮遗留状态）
        for (var i = 0; i < 20 && !calls.length; i++) await new Promise(function (r) { setTimeout(r, 50); });
        window.MM.openLocalPath = orig;
        n.data.localPath = backup;              // 还原（别把坏路径留在内存里被后续保存写下去）
        app.closeAllFloatDetail();
        return { clicked: true, calls: calls };
      })()`);
      return {
        ok: good.ok === true && noPop === true && notGood.ok === false && clicked.clicked === true
          && clicked.calls.length === 1 && clicked.calls[0] === bad,
        text: '存在的目录 ok=' + good.ok + '（headless=' + good.headless + '，不弹窗）'
          + ' · 不存在的目录 ok=' + notGood.ok + '（err=' + String(notGood.err || '').slice(0, 40) + '）'
          + ' · 点链接调用了打开通道=' + (clicked.calls.length === 1 && clicked.calls[0] === bad)
      };
    }
  }
];

module.exports = assertions;
