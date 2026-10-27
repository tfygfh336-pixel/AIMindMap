/* ============================================================
 * scripts/smoke/16-local-path.js —— 节点「本机链接」（localPath：**文件或目录**）
 * ------------------------------------------------------------
 * 覆盖的能力：从**文件夹结构**建出来的树，每个结构节点挂一条本机路径；
 * 界面详情框里显示可点链接，右键出**恰好四项**（打开 / 打开方式 /
 * 在文件资源管理器中打开 / 取消链接），每项各自真的做那件事。
 *
 * 断言对应这些**真实失效模式**：
 *   ① CLI 设了字段，界面却看不见（读视图/渲染没接上 —— 字段存在但功能等于没有）；
 *   ② **界面保存把字段丢掉**：`serializeTree()` 是**手挑字段**的，漏一个就静默丢
 *      （与"保存不丢 assoc"同型，实测踩过一次）；
 *   ③ 点了没反应：路径不存在/盘没挂时，必须**明确报错**，不能静默什么都不做；
 *   ④ **左键退化成"编辑器官线"**：用户要的是系统默认程序（没有默认关联时系统自己弹
 *      「打开方式」）⇒ 账里必须是 `openMode:'system'` / `via:'openPath'`；
 *   ⑤ **右键不是恰好四项**（多一项就破了用户说的"只需要"）；
 *   ⑥ ★**「打开方式」被写成"再打开一次"**（最像成功、又最假的那一种）；
 *   ⑦ ★**「在文件资源管理器中打开」对文件也去 `openPath`**（那是"打开文件"，不是"定位它"）；
 *   ⑧ **「取消链接」只清界面不清数据**（下次重开又回来）；
 *   ⑨ **`shell.openPath` 的失败原因被吞掉**（打不开被说成打开了）；
 *   ⑩ ★**判据自己读"全局可变的状态栏快照"**（`#status-text` 点完 sleep 一小段读一次）——
 *      本域两条断言曾经就这么写，于是**读到的都是上一条消息**：这一跳是异步的（实测不可见窗口下
 *      `click ⇒ 主进程收到 +428ms`，同一次唤醒后第二次为 0ms），而文件监听还会在我们上报之后
 *      36ms 用一句灰色提示把状态栏盖掉 ⇒ 那种判据**既能假红也能假绿**。
 *      现在一律**按写入取**（见下面 `REC_ARM` / `clickAndWait` 那段），判"留在屏幕上的最后一句"。
 *
 * ⚠️ headless 下**绝不真的开窗/弹系统对话框**（主进程带 isSmoke 守卫）—— 否则每跑一次
 *    verify 都会在跑验证的机器上弹出文件管理器。而"到底执行了哪个动作"由
 *    **可替换执行器**（`ctx.openImpl`）取证 ⇒ 判据比"没报错"强得多。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/** 等主进程 IPC + 原子写落盘 */
const settle = 'new Promise(function (res) { setTimeout(res, 300); })';

/** 轮询间隔（**只用于"按条件等"的间隔**，绝不用它当"等够久"的判据 ——
 *  本域两条假红的成因就是"点完 sleep(300) 读一次全局快照"，见下面「状态栏写入录音机」那段）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ================= 主进程侧的**可替换执行器**（本批的取证设备） =================
 * 只在 `--smoke` 生效（`main.js` 的 `OPEN_IMPL` / `ctx.openImpl`）：换掉之后
 * "到底哪个动作真的执行了 / 拿到什么 argv / 返回什么"都成为**主进程侧的事实**，
 * 而**不会真的弹系统对话框或文件管理器**（headless 纪律：那会在跑验证的这台机器上抢焦点）。
 * ⚠️ 它们**不是**在测"Electron 能不能开文件"（那件事由系统负责），而是测
 *   "**我们请求的档位**与**真正执行的执行器**是不是同一个" —— 这正是本批最容易做假的地方：
 *   「打开方式」若被写成"再打开一次"，`spawn` 一次都不会被调、`openPath` 反而会被调 ⇒ 当场红。
 * 每个断言结束时必须 `resetImpl(ctx)`（放在 finally 里），否则会污染后面的断言。
 */
function openPathSpy(ctx, ret) {
  const calls = [];
  if (!ctx.openImpl) return { calls: calls };
  ctx.openImpl.set('openPath', (p) => { calls.push(p); return Promise.resolve(ret); });
  return { calls: calls };
}
function spawnSpy(ctx) {
  const calls = [];
  if (!ctx.openImpl) return { calls: calls };
  ctx.openImpl.set('spawn', (file, args, opts) => {
    calls.push({ file: file, args: (args || []).slice(), opts: opts });
    return { on: function () {}, unref: function () {} };   // launchDetached 只需要这两个
  });
  return { calls: calls };
}
function revealSpy(ctx) {
  const calls = [];
  if (!ctx.openImpl) return { calls: calls };
  ctx.openImpl.set('reveal', (p) => { calls.push(p); });
  return { calls: calls };
}
function resetImpl(ctx) { if (ctx.openImpl) ctx.openImpl.reset(); }

/* ================= 「状态栏写入」录音机（本域判失败上报的**唯一**取数方式） =================
 * 为什么不能用"点完 sleep 300ms 读一次 `#status-text`"（本域曾这么写，两条断言因此假红）：
 *   ① **这一跳是异步的**：实测同一台机器上，按住 `Date.now()` 量到的墙钟是
 *      `click ⇒ requestOpen 进入 0ms ⇒ 主进程收到 +428ms ⇒ 回渲染层再 +1ms`
 *      （**冒烟窗口不可见** ⇒ 渲染层被唤醒后的第一次 IPC 要等这一次唤醒；
 *        紧接着的第二次点同一个链接是 **0ms** —— 所以不是"链慢"，是"探针窗口冷"）。
 *      外加 `#status-text` 上还有**别的写者**：文件监听在 36ms 后就会把它盖成
 *      「已收到外部变更通知…无需处理」（`renderer/app-actions.js` 的 `noteExternalChange`）。
 *   ② 于是"读一次全局快照"这种判据**既能假红也能假绿**：读早了读到的是**上一条**消息
 *      （假红：断言像在说"返回值被吞了"，其实只是读到了别人上一条），
 *      读巧了读到上一条恰好含目标串又变成**假绿**。本域实测就是"每条读到上一条"。
 * ⇒ 改成**按写入取**：装上录音机 → 点 → 等到"本次这一条"落定 → 取回全部写入。
 *   录音机记的是 `MM.setStatus` 的**每一次**调用，并在**真正写进 DOM 之后**回读
 *   `#status-text`（`dom` 字段）—— 于是"用户看到的那一行"也是判据的一部分，
 *   而不是一句"函数被调过"的自我安慰。
 * ⚠️ 只在本域的断言里装/卸（`finally` 里必卸），不改成产品代码、不新开 IPC。
 * ⚠️ 这些串是喂给渲染层执行的，**不许出现反引号**（会提前终止本文件的模板串 ⇒ require 期 SyntaxError）。
 */
const REC_ARM = `(function () {
  if (!window.__lpRecOrig) { window.__lpRecOrig = window.MM.setStatus; window.__lpRecInstalled = true; }
  if (window.__lpRecInstalled) {
    window.MM.setStatus = function (t, e) {
      var out = window.__lpRecOrig(t, e);                 // 先真的写进 DOM
      var el = document.querySelector('#status-text');
      window.__lpRec.push({ t: String(t), err: !!e, dom: el ? String(el.textContent) : '' });
      return out;
    };
  }
  window.__lpRec = [];
  return true;
})()`;

/** 卸掉录音机并取回记录（`[{t, err, dom}]`） */
const REC_TAKE = `(function () {
  var rec = (window.__lpRec || []).slice();
  if (window.__lpRecOrig) window.MM.setStatus = window.__lpRecOrig;
  window.__lpRecOrig = null; window.__lpRecInstalled = false; window.__lpRec = [];
  return rec;
})()`;

/** 点一次 `.fd-localpath-link`，并**等到本次这一条上报落定**（按写入等，不按固定 sleep 等）。
 *  `marker` = 只有本次动作才会出现在状态栏里的串（用一个**本次独有的路径**最稳）：
 *  文件监听那条提示、上一条遗留提示都不含它 ⇒ 等到的一定是**这一跳**写的那一行。 */
function clickAndWait(want, marker) {
  return `(async () => {
    var app = window.MMApp, jm = app.getState().jm;
    var n = jm.get_node('${NODE}');
    var backup = (n.data && n.data.localPath) || '';
    n.data.localPath = ${JSON.stringify(want)};
    app.closeAllFloatDetail(); app.showDetail(n);
    /* 顺手把主进程**回给渲染层的那个对象**取下来（"原样带回"要判在这一层）：
     * MM.requestOpen 是渲染层唯一拿到它的地方（preload 是 contextBridge 冻结对象，包不上） */
    var origRO = window.MM.requestOpen, got = null;
    window.MM.requestOpen = function (p, o) {
      var q = origRO(p, o);
      if (q && q.then) q.then(function (res) { got = res; }, function () {});
      return q;
    };
    var el = document.querySelector('.fd-localpath-link');
    var threw = '';
    try { if (el) el.click(); } catch (e) { threw = String((e && e.message) || e); }
    var hit = function () {
      return (window.__lpRec || []).some(function (w) {
        return w.err && w.t.indexOf(${JSON.stringify(marker)}) >= 0;
      });
    };
    for (var i = 0; i < 80 && !hit(); i++) await new Promise(function (res) { setTimeout(res, 50); });
    await new Promise(function (res) { setTimeout(res, 150); });   // 让同一次上报的第二句也落定
    window.MM.requestOpen = origRO;
    n.data.localPath = backup;
    app.closeAllFloatDetail();
    return { clicked: !!el, threw: threw, got: got };
  })()`;
}

/** 「把失败说成成功」的那句话（`renderer/app-detail-content.js` 的 LP_ACTION_TEXT.system）。
 *  判据是**它一次都不许出现**在这一次上报里 —— 那正是本域两条断言要防的事。 */
const SUCCESS_PHRASE = '已交系统默认程序打开';
/** 两种错因各自的**专属**文案（不许互相串味，也不许共用一句） */
const CAUSE_MISSING = '不在了';
const CAUSE_NOASSOC = '没有默认关联';

/** 判别力证明开关（见下方「残留模态」段；默认空 ⇒ 正常跑完全不受影响 ✓） */
const INJECT = process.env.MM_SMOKE_INJECT || '';

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
        /* ⚠️ addNode **顺手打开**「编辑节点」模态（app-actions.js 的 addNode 末尾调 MMEditor.editNode）；
         * ⚠️ 本模板串里**不许出现反引号**（会提前终止 JS 模板串 ⇒ require 期就 SyntaxError，
         *    整轮冒烟变成 SMOKE LOAD ERROR 一条断言都不跑 —— 本工程在别处踩过同一个坑，见
         *    testing-for-ai 的 E5③；这里就是踩它踩出来的）。
         * 它**不在**「每域隔离」的还原范围内（隔离只还原项目数据文件 + 重开项目，DOM 模态不在其中）
         * ⇒ undo() 撤得掉节点、撤不掉那个框 ⇒ 它会**跨域存活**。
         * 实测代价（2026-10-10，SMOKE_ONLY='16,36,37'）：域 36/37 是真鼠标输入 + elementFromPoint
         * 命中测试，编辑框盖住画布 ⇒ 11 条断言连锁红（报文 "点不到 comp-net …→DIV.dialog-box"），
         * 而那两个文件**一行都没改过** ✗。全量跑之所以还绿，只是因为后面的域**顺手**替本域擦了桌子
         * （12-dsh-drag.js 的 strays、27-import-doc.js 的 edit-cancel）—— 运气不是隔离 ✗。
         * 所以在这里按**用户关框的那条路**收尾（点「取消」⇒ editor.js 的 closeEditDialog；
         * 与 27-import-doc.js / 03-edit-search.js 同一做法），并把结果写进报文（不许静默 ✓）。
         *
         * 判别力证明：MM_SMOKE_INJECT=16-leave-modal npm run smoke（配 SMOKE_ONLY='16,36,37'）
         * ⇒ 本域**故意不关**它 ⇒ 框架在每个域开跑前的干净前置会收掉它，并按**框架级判据**
         * 让域 36 直接红 + 点名"由 16-local-path.js 留下" ⇒ 证明那条判据真的能抓住跨域污染 ✓ */
        var leave = ${JSON.stringify(INJECT.indexOf('16-leave-modal') >= 0)};
        if (!leave) {
          var cancel = document.getElementById('edit-cancel');
          if (cancel) cancel.click();
        }
        var dlg0 = document.getElementById('edit-dialog');
        var dialogClosed = !dlg0 || dlg0.style.display === 'none';
        var saved = await app.save();
        app.undo();                        // 撤掉探针改动
        return { saved: saved, dialogClosed: dialogClosed };
      })()`);
      const node = findNode(projFile, NODE);
      const kept = !!node && node.localPath === dir;
      return {
        ok: r.saved === true && kept === true && r.dialogClosed === true,
        text: '界面 save()=' + r.saved + ' · 盘上该节点的 localPath 仍在=' + kept
          + (kept ? '' : '｜⚠️ 字段被整树写回丢掉了')
          + ' · 「编辑节点」模态已关=' + r.dialogClosed
          + (r.dialogClosed ? '' : '（⚠️ addNode 顺手开的框没关 ⇒ 会跨域存活、盖住后面的真输入域 ✗）')
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
  },

  /* ==========================================================================
   * 【文件链接的打开语义批】以下 9 条对应用户 2026-10-31 的三条要求
   *   W1 左键 = 系统默认程序（有默认直接开、没默认系统自己弹「打开方式」、不存在要响亮）
   *   W2 右键 = **恰好四项**（打开 / 打开方式 / 在文件资源管理器中打开 / 取消链接）
   *   W3 四项**各自真的做那件事** —— 尤其"打开方式"**不是**"再打开一次"、
   *      "在资源管理器里打开"对**文件**走 `showItemInFolder`（定位），不是 `openPath`（打开）
   *   外加 ①打开 与左键"同一条实现"的对拍、以及 ④取消链接 **落盘**后读盘确认。
   *
   * ⚠️ 本域**不会真的弹系统对话框 / 文件管理器**（headless 纪律：那会在这台机器上抢焦点）。
   *   "到底执行了哪个动作"用主进程侧的**可替换执行器**取证（`ctx.openImpl`，只在 `--smoke` 生效）：
   *   换掉 `spawn` / `openPath` / `reveal` 之后，**谁被调用、拿到什么 argv、返回什么**都成为事实。
   *   ⇒ 于是"打开方式被写成再打开一次"这种假实现会当场红（`spawn` 一次没被调、`openPath` 被调了），
   *     "把 shell.openPath 的失败原因吞掉"也会当场红（状态栏里没有那个串）。
   * ======================================================================== */
  {
    name: '本机链接：左键点**文件**链接 ⇒ 系统默认程序那一档（账里 via=openPath；有默认关联时不打扰）',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl（执行器不可换）⇒ 判红，不当通过' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const spy = openPathSpy(ctx, '');          // 空串 = 系统说"开了"（有默认关联那条路）
      try {
        ctx.openFileLogClear();
        await ctx.exec(REC_ARM);
        const r = await ctx.exec(`(async () => {
          var app = window.MMApp, jm = app.getState().jm;
          var n = jm.get_node('${NODE}');
          window.__lpBackup = (n.data && n.data.localPath) || '';
          n.data.localPath = ${JSON.stringify(projFile)};
          app.closeAllFloatDetail(); app.showDetail(n);
          var el = document.querySelector('.fd-localpath-link');
          var threw = '';
          try { if (el) el.click(); } catch (e) { threw = String((e && e.message) || e); }
          /* 按**写入**等这一跳落定（marker = 本次路径），不按固定 sleep 读全局快照：
           * 实测不可见探针窗的首次 IPC 要 ~428ms，满载更久 ⇒ "点完读一次"必然读到上一条
           * （本文件顶部那段就是这两条假红的病历）。 */
          var hit = function () {
            return (window.__lpRec || []).some(function (w) { return w.t.indexOf(${JSON.stringify(projFile)}) >= 0; });
          };
          for (var i = 0; i < 80 && !hit(); i++) await new Promise(function (res) { setTimeout(res, 50); });
          await new Promise(function (res) { setTimeout(res, 150); });
          n.data.localPath = window.__lpBackup;
          app.closeAllFloatDetail();
          return { clicked: !!el, threw: threw };
        })()`);
        const rec = await ctx.exec(REC_TAKE);
        const led = ctx.openFileLog();
        const last = led[led.length - 1] || {};
        /* 判**这一次**写的东西（录音机从装上的那一刻开始记 ⇒ 不可能是上一条的残留）：
         * 最后那一句必须说"已交系统默认程序打开"且真的写进 DOM，且一次都没说"打不开"。 */
        const mine = rec.filter((w) => w.t.indexOf(projFile) >= 0);
        const finalW = mine.length ? mine[mine.length - 1] : null;
        const saysOpened = !!finalW && finalW.err === false && finalW.t.indexOf(SUCCESS_PHRASE) >= 0;
        const onScreen = saysOpened && finalW.dom.indexOf(SUCCESS_PHRASE) >= 0;
        const saidCannot = rec.filter((w) => w.t.indexOf('打不开') >= 0);
        const ok = r.clicked === true && r.threw === '' && spy.calls.length === 1 && spy.calls[0] === projFile
          && last.openMode === 'system' && last.via === 'openPath' && last.openPath === true
          && last.showItemInFolder === false && last.isDir === false
          && saysOpened === true && onScreen === true && saidCannot.length === 0;
        return {
          ok: ok,
          text: '点了链接=' + r.clicked + ' · 系统那一跳被调了 ' + spy.calls.length + ' 次（参数='
            + JSON.stringify(String(spy.calls[0] || '').slice(-24)) + '）'
            + ' · 出口账 openMode=' + JSON.stringify(last.openMode) + ' via=' + JSON.stringify(last.via)
            + ' openPath=' + last.openPath + ' showItemInFolder=' + last.showItemInFolder + ' isDir=' + last.isDir
            + ' · 状态栏（**本次写入的最后一句**，判据是 saysOpened/onScreen）=' + JSON.stringify(String(finalW ? finalW.t : '(无)').slice(0, 70))
        };
      } finally {
        /* 录音机装上就必须卸掉（即使中途抛错）—— 它活到后面的域就是跨域污染 */
        try { await ctx.exec(REC_TAKE); } catch (e) { /* 页面没了/已卸过：不影响本条的判定 */ }
        resetImpl(ctx);
      }
    }
  },

  {
    name: '本机链接：左键·**没有默认关联**时 shell.openPath 的失败原因必须被带出来（吞掉即假绿）',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl ⇒ 判红' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const WHY = '没有默认关联：请在「打开方式」里挑一个程序';
      const spy = openPathSpy(ctx, WHY);        // 非空串 = 打不开的原因（Windows 会弹选择栏）
      try {
        ctx.openFileLogClear();
        await ctx.exec(REC_ARM);
        const r = await ctx.exec(clickAndWait(projFile, projFile));
        const rec = await ctx.exec(REC_TAKE);
        const led = ctx.openFileLog();
        const last = led[led.length - 1] || {};
        const got = r.got || {};
        /* 只认**报错样式**的写入（`isErr === true`）：成功那一档是灰色提示，混进来就不是"响亮" */
        const errWrites = rec.filter((w) => w.err === true);
        /* 判的是**留在屏幕上的那一句**（本次动作写的最后一条），不是"这三条里随便有一条对"。
         * 实测差别是真的：渲染层会先写一条「打不开：<原因>｜<完整路径>」、再写最终那句；
         * 若只要求"某一条完整"，最终那句把路径切短了也照样绿 ⇒ 用户看到的仍是被切过的 ✗ */
        const cand = errWrites.filter((w) => w.t.indexOf(projFile) >= 0 || w.t.indexOf(WHY) >= 0);
        const finalErr = cand.length ? cand[cand.length - 1] : null;
        const carrying = errWrites.filter((w) => w.t.indexOf(WHY) >= 0);
        const saysWhy = !!finalErr && finalErr.t.indexOf(WHY) >= 0;              // 最后那句说的是这个原因
        const onScreen = saysWhy && finalErr.dom.indexOf(WHY) >= 0;              // 且真的写进了 DOM
        const withPath = saysWhy && finalErr.t.indexOf(projFile) >= 0;           // 且路径完整、没被切
        const successSaid = rec.filter((w) => w.t.indexOf(SUCCESS_PHRASE) >= 0);
        const wrongCause = carrying.filter((w) => w.t.indexOf(CAUSE_MISSING) >= 0);
        const ok = r.clicked === true && spy.calls.length === 1 && spy.calls[0] === projFile
          && last.openMode === 'system' && last.via === 'openPath' && last.openPath === true
          && last.showItemInFolder === false && last.isDir === false && last.exec === 'openPath'
          /* ①**原样带回**：逐字相等（不是"含有点像"）—— 吞掉 ⇒ null / '未知原因' ⇒ 红 */
          && got.ok === false && String(got.err) === WHY
          /* ②状态栏真的响亮了（判在"写入 + 写进 DOM"上，不判全局快照 ⇒ 不会读到上一条） */
          && carrying.length >= 1 && saysWhy === true && onScreen === true && withPath === true
          /* ③**不许把失败说成成功**，④**不许把这一种错因说成另一种** */
          && successSaid.length === 0 && wrongCause.length === 0;
        return {
          ok: ok,
          text: '系统那一跳被调了 ' + spy.calls.length + ' 次 · 执行器=' + JSON.stringify(last.exec)
            + ' · 渲染层收到的 err=' + JSON.stringify(String(got.err == null ? '(无)' : got.err))
            + ' · 报错样式的写入 ' + errWrites.length + ' 条，其中带原因 ' + carrying.length + ' 条'
            + ' · **最后那一句**说原因=' + saysWhy + '（真的写进 DOM=' + onScreen
            + ' · 带完整路径=' + withPath + '）'
            + ' · 最后那句（**这里只截断显示**，判据以上面的布尔为准）='
            + JSON.stringify(String(finalErr ? finalErr.t : '(无)').slice(0, 80))
            + ' · 说了"已交系统默认程序打开"的写入=' + successSaid.length + '（必须 0）'
            + ' · 把这一种说成"文件不在了"的=' + wrongCause.length + '（必须 0）'
            + (rec.some((w) => w.t.indexOf('外部变更通知') >= 0)
              ? '（注：文件监听那条提示不参与判定 —— 它不是报错样式、也不含本次路径）' : '')
        };
      } finally {
        /* 装上就必须卸掉，**即使中途抛错** —— 否则录音机会活到后面的域（已卸过时再卸是无害的） */
        try { await ctx.exec(REC_TAKE); } catch (e) { /* 页面没了/已卸过：不影响本条的判定 */ }
        resetImpl(ctx);
      }
    }
  },

  {
    name: '本机链接：左键·路径**不存在** ⇒ 响亮报"文件不在了"、不崩、也不真的去打开',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl ⇒ 判红' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const gone = path.join(path.dirname(projFile), 'no-such-file-xyz-16.aimmtest');
      const openSpy = openPathSpy(ctx, '');
      const spawn = spawnSpy(ctx);
      try {
        ctx.openFileLogClear();
        await ctx.exec(REC_ARM);
        const r = await ctx.exec(clickAndWait(gone, gone));
        const rec = await ctx.exec(REC_TAKE);
        const led = ctx.openFileLog();
        const last = led[led.length - 1] || {};
        const got = r.got || {};
        const errWrites = rec.filter((w) => w.err === true);
        /* 判**留在屏幕上的那一句**（见上面 ① 里对"最终那句"的说明）：
         * 只看和本次这一跳有关的写入（含本次路径或"不在了"），取最后一条。 */
        const cand = errWrites.filter((w) => w.t.indexOf(gone) >= 0 || w.t.indexOf(CAUSE_MISSING) >= 0);
        const finalErr = cand.length ? cand[cand.length - 1] : null;
        const loud = !!finalErr && finalErr.t.indexOf(CAUSE_MISSING) >= 0;   // 说的是"不在了"
        const onScreen = loud && finalErr.dom.indexOf(CAUSE_MISSING) >= 0;   // 真的写进了 DOM
        /* **完整路径**：最后那一句里出现了本次的完整路径（判"用户能不能读全"，不判行文格式 ——
         * 只要求"出现一次"，不要求"出现两次"：后者是当前文案的排版巧合，
         * 绑上去等于给未来的文案改法安排一次假红 ✗） */
        const withPath = loud && finalErr.t.indexOf(gone) >= 0;
        const wrongCause = errWrites.filter((w) => w.t.indexOf(gone) >= 0 && w.t.indexOf(CAUSE_NOASSOC) >= 0);
        const successSaid = rec.filter((w) => w.t.indexOf(SUCCESS_PHRASE) >= 0);
        const ok = r.clicked === true && r.threw === ''
          && last.exec === 'none:stat-failed' && openSpy.calls.length === 0 && spawn.calls.length === 0
          /* ① 回值里带的是**这个完整路径**（不是截断过的、也不是别的错因） */
          && got.ok === false && String(got.err).indexOf(gone) >= 0
          /* ② 状态栏响亮：**说清了是"不在了"**，还带着完整路径（不是"没有默认关联"那句） */
          && loud === true && onScreen === true && withPath === true
          /* ③④ 两种错因**不许共用一句文案**：不得出现"没有默认关联"，也不得出现成功文案 */
          && wrongCause.length === 0 && successSaid.length === 0;
        return {
          ok: ok,
          text: '点了链接=' + r.clicked + ' · 抛错=' + JSON.stringify(r.threw)
            + ' · 渲染层收到的 err=' + JSON.stringify(String(got.err == null ? '(无)' : got.err))
            + ' · 报错样式的写入 ' + errWrites.length + ' 条'
            + ' · **最后那一句**说"不在了"=' + loud + '（真的写进 DOM=' + onScreen
            + ' · 完整路径=' + withPath + '）'
            + ' · 最后那句（**这里只截断显示**，判据以上面的布尔为准）='
            + JSON.stringify(String(finalErr ? finalErr.t : '(无)').slice(0, 90))
            + ' · 说成"没有默认关联"的=' + wrongCause.length + '（必须 0）'
            + ' · 说了"已交系统默认程序打开"的=' + successSaid.length + '（必须 0）'
            + ' · 执行器=' + JSON.stringify(last.exec) + ' · 真的去打开的次数=' + openSpy.calls.length
            + ' · 起进程次数=' + spawn.calls.length
        };
      } finally {
        /* 同上：录音机必须卸掉（已卸过时再卸是无害的） */
        try { await ctx.exec(REC_TAKE); } catch (e) { /* 页面没了/已卸过：不影响本条的判定 */ }
        resetImpl(ctx);
      }
    }
  },

  {
    /* 【2026-10-27 UI 优化】报错**不许**被下一句灰色提示盖掉。
     * 由来（实测，本文件开头 ① 段的注释也记着同一件事）：`#status-text` 上**有好几个写者**
     * ——文件监听 36ms 后就会把它盖成一句例行提示；而 `MM.setStatus(err)` 原来只写
     * `textContent + color` 两样，**没有任何持久化** ⇒ 报错的实际寿命只有"到下一次写入"，
     * 父批实测 **35ms**。而 `#status-text` 还固定 280px + ellipsis（长报文只剩前 ~23 汉字）。
     *
     * 修法：加**第二个载体** `#err-toast`（`index.html` 里有长注释说明它为什么不在工具栏、
     * 为什么让位给原生侧栏）。它不是替换 —— 状态栏照旧报"最近一次动作"，所以下面同时判两件事：
     *   ① 写一句**灰色**例行提示后，等 250ms，`#err-toast` 仍然可见且**仍含报错原文**；
     *   ② `#status-text` 确实被那句灰字更新了（证明"没被盖"不是因为没人写灰字 ——
     *      否则本断言会在"灰字根本没来"的情况下假绿）。
     * 判别力注入：把 `app-core.js` 里 `showErrToast(msg)` 那一行删掉 ⇒ ① 必红。 */
    name: '【UI 优化】报错 200ms 后仍在屏幕上：再写一句灰色例行提示，`#err-toast` 仍留着报错原文'
      + '（状态栏照旧报最新动作 —— 两个载体，不是替换）',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl ⇒ 判红' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const gone = path.join(path.dirname(projFile), 'no-such-file-ui-toast-16.aimmtest');
      const openSpy = openPathSpy(ctx, '');
      const readToast = `(function () {
        var b = document.getElementById('err-toast');
        var t = document.getElementById('err-toast-text');
        var s = document.getElementById('status-text');
        return { has: !!b, hidden: !b || b.hidden,
          toast: t ? String(t.textContent) : '',
          status: s ? String(s.textContent) : '',
          statusColor: (s && s.style && s.style.color) ? s.style.color : '' };
      })()`;
      try {
        ctx.openFileLogClear();
        await ctx.exec(REC_ARM);
        await ctx.exec(clickAndWait(gone, gone));
        const first = await ctx.exec(readToast);
        // ── 这一手正是"把报错盖掉"：再写一句**不报错**的例行提示 ──
        await ctx.exec("(function () { window.MM.setStatus('例行提示：本句来自 UI 优化批的探针'); return 1; })()");
        await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
        const after = await ctx.exec(readToast);
        await ctx.exec(REC_TAKE);
        const toastHadErr = !!first && first.hidden === false && String(first.toast).indexOf(CAUSE_MISSING) >= 0;
        const toastStillThere = !!after && after.hidden === false
          && String(after.toast).indexOf(CAUSE_MISSING) >= 0
          && String(after.toast) === String(first.toast);
        const statusMovedOn = !!after && String(after.status).indexOf('例行提示') >= 0;
        const ok = toastHadErr && toastStillThere && statusMovedOn && openSpy.calls.length === 0;
        return {
          ok,
          text: '点了不存在的路径 ⇒ 错误条出现并含「' + CAUSE_MISSING + '」=' + toastHadErr
            + '（隐藏=' + (first && first.hidden) + ' 原文=' + JSON.stringify(String(first && first.toast).slice(0, 46)) + '）'
            + ' ｜ 再写一句灰色例行提示 + 等 250ms ⇒ 错误条仍在=' + toastStillThere
            + '（隐藏=' + (after && after.hidden) + ' 原文=' + JSON.stringify(String(after && after.toast).slice(0, 46)) + '）'
            + ' ｜ 状态栏已变成那句灰字=' + statusMovedOn
            + '（' + JSON.stringify(String(after && after.status).slice(0, 30)) + '，color=' + (after && after.statusColor) + '）'
            + ' ｜ 真的去打开的次数=' + openSpy.calls.length
        };
      } finally {
        try { await ctx.exec('(function () { if (window.MM.hideErrToast) window.MM.hideErrToast(); return 1; })()'); } catch (e) { /* 页面没了：不影响判定 */ }
        try { await ctx.exec(REC_TAKE); } catch (e) { /* 已卸过 */ }
        resetImpl(ctx);
      }
    }
  },

  {
    name: '本机链接：右键那条链接 ⇒ 菜单**恰好四项**（打开 / 打开方式 / 在文件资源管理器中打开 / 取消链接）',
    run: async (ctx) => {
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const r = await ctx.exec(`(function () {
        var app = window.MMApp, jm = app.getState().jm;
        var n = jm.get_node('${NODE}');
        window.__lpBackup = (n.data && n.data.localPath) || '';
        n.data.localPath = ${JSON.stringify(projFile)};
        app.closeAllFloatDetail(); app.showDetail(n);
        var el = document.querySelector('.fd-localpath-link');
        if (!el) { n.data.localPath = window.__lpBackup; return { ok: false, why: '没有 .fd-localpath-link' }; }
        var b = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          clientX: Math.round(b.left + 3), clientY: Math.round(b.top + 3) }));
        var menu = document.getElementById('ctx-menu');
        var items = menu ? Array.prototype.slice.call(menu.querySelectorAll('.ctx-item')) : [];
        var labels = items.map(function (x) { return x.textContent; });
        window.MMContextMenu.closeMenu();
        n.data.localPath = window.__lpBackup;
        app.closeAllFloatDetail();
        return { ok: true, labels: labels, count: labels.length };
      })()`);
      const WANT = ['打开', '打开方式', '在文件资源管理器中打开', '取消链接'];
      const same = r.ok === true && r.count === 4
        && WANT.every((w, i) => r.labels[i] === w);
      return {
        ok: same,
        text: '菜单项数=' + r.count + '（要求**恰好 4**）标签=' + JSON.stringify(r.labels)
          + (same ? '' : '｜⚠️ 期望 ' + JSON.stringify(WANT) + '（顺序也要一致；多一项 = 用户说的"只需要"被破 ✗）')
      };
    }
  },

  {
    name: '本机链接：节点右键里那四项**连续出现且顺序一致**（旧的那一项已被取代，不是并列第五项）',
    run: async (ctx) => {
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const r = await ctx.exec(`(function () {
        var app = window.MMApp, jm = app.getState().jm;
        if (app.clearSelection) app.clearSelection();
        var n = jm.get_node('${NODE}');
        window.__lpBackup = (n.data && n.data.localPath) || '';
        n.data.localPath = ${JSON.stringify(projFile)};
        var el = document.querySelector('jmnode[nodeid="' + n.id + '"]');
        if (!el) { n.data.localPath = window.__lpBackup; return { ok: false, why: '找不到节点 DOM' }; }
        var b = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2) }));
        var menu = document.getElementById('ctx-menu');
        var items = menu ? Array.prototype.slice.call(menu.querySelectorAll('.ctx-item')) : [];
        var labels = items.map(function (x) { return x.textContent; });
        window.MMContextMenu.closeMenu();
        n.data.localPath = window.__lpBackup;
        return { ok: true, labels: labels };
      })()`);
      const WANT = ['打开', '打开方式', '在文件资源管理器中打开', '取消链接'];
      const at = r.ok === true ? r.labels.indexOf('打开') : -1;
      const seg = at >= 0 ? r.labels.slice(at, at + WANT.length) : [];
      const same = at >= 0 && WANT.every((w, i) => seg[i] === w);
      const stale = Array.isArray(r.labels) && r.labels.some((s) => String(s).indexOf('打开文件夹') >= 0);
      return {
        ok: same && !stale,
        text: '四项从第 ' + (at + 1) + ' 项开始：' + JSON.stringify(seg) + ' · 旧「打开文件夹」还在=' + stale
          + '（节点菜单里还有别的项是对的 —— 判的是那四项**连续且成组**）'
      };
    }
  },

  {
    name: '★本机链接：「打开方式」**真的起** `rundll32 shell32.dll,OpenAs_RunDLL <路径>`（不是再打开一次）',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl ⇒ 判红' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const spawn = spawnSpy(ctx);
      const openSpy = openPathSpy(ctx, '');      // 若走成"再打开一次"，这里会被调到
      try {
        ctx.openFileLogClear();
        const r = await ctx.exec(`(async () => {
          var app = window.MMApp, jm = app.getState().jm;
          var n = jm.get_node('${NODE}');
          window.__lpBackup = (n.data && n.data.localPath) || '';
          n.data.localPath = ${JSON.stringify(projFile)};
          app.closeAllFloatDetail(); app.showDetail(n);
          var el = document.querySelector('.fd-localpath-link');
          if (!el) { n.data.localPath = window.__lpBackup; return { ok: false, why: '没有链接' }; }
          var b = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: Math.round(b.left + 3), clientY: Math.round(b.top + 3) }));
          var menu = document.getElementById('ctx-menu');
          var items = menu ? Array.prototype.slice.call(menu.querySelectorAll('.ctx-item')) : [];
          var hit = null;
          for (var i = 0; i < items.length; i++) if (items[i].textContent === '打开方式') { hit = items[i]; break; }
          if (hit) hit.click();
          /* 起进程是异步的，且不可见探针窗的首次 IPC 实测可到 428ms（满载更久）
           * ⇒ 不在页面里死等 1500ms，改在主进程侧**按条件**等（见下面那段轮询）。 */
          n.data.localPath = window.__lpBackup;
          app.closeAllFloatDetail();
          return { ok: true, clicked: !!hit };
        })()`);
        /* 按**条件**等这一跳落定：出口账出现 openAs **并且** spawn 真的被调过（起进程比记账晚），
         * 判据本身一个字没改 —— 改的只是"等多久"从"猜 1500ms"变成"等到条件成立（上限 4s）"。 */
        let led = ctx.openFileLog();
        let last = led[led.length - 1] || {};
        for (let i = 0; i < 80; i++) {
          /* exec 是**最后一个**写进账里的字段（`launchDetached` 过了早期失败观察窗才回来）
  * ⇒ 等到它也落定，否则会读到 exec='' 的中间态（实测过：判据当场假红）。 */
  if (last.openMode === 'openAs' && last.exec === 'openAs' && spawn.calls.length > 0) break;
          await sleep(50);
          led = ctx.openFileLog();
          last = led[led.length - 1] || {};
        }
        await sleep(120);
        led = ctx.openFileLog();
        last = led[led.length - 1] || {};
        const call = spawn.calls[0] || {};
        const argvOk = spawn.calls.length === 1
          && call.file === 'rundll32.exe'
          && Array.isArray(call.args) && call.args.length === 2
          && call.args[0] === 'shell32.dll,OpenAs_RunDLL'
          && call.args[1] === projFile
          && call.opts && call.opts.detached === true && call.opts.stdio === 'ignore';
        const ledgerOk = last.openMode === 'openAs' && last.via === 'openAs'
          && last.openPath === false && last.exec === 'openAs'
          && Array.isArray(last.argv) && last.argv[1] === projFile;
        const notReopen = openSpy.calls.length === 0;
        return {
          ok: r.clicked === true && argvOk && ledgerOk && notReopen,
          text: '点了「打开方式」=' + r.clicked + ' · 起的进程=' + JSON.stringify(spawn.calls.map(function (c) {
            return String(c.file) + ' ' + (c.args || []).join(' ');
          }))
            + ' · 出口账 via=' + JSON.stringify(last.via) + ' openPath=' + last.openPath
            + ' 执行器=' + JSON.stringify(last.exec)
            + ' · 顺手调了 openPath 的次数=' + openSpy.calls.length + '（必须 0：那是"再打开一次" ✗）'
            + ' · 状态栏（只作取证，非判据）=' + JSON.stringify(String(r.status || '(页面里没再读它)').slice(0, 70))
        };
      } finally { resetImpl(ctx); }
    }
  },

  {
    name: '★本机链接：「在文件资源管理器中打开」文件走 showItemInFolder（定位）、目录走 openPath（打开目录）',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl ⇒ 判红' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const dir = path.dirname(projFile);
      const reveal = revealSpy(ctx);
      const openSpy = openPathSpy(ctx, '');
      const clickRevealWith = async (p) => {
        const out = await ctx.exec(`(async () => {
          var app = window.MMApp, jm = app.getState().jm;
          var n = jm.get_node('${NODE}');
          window.__lpBackup = (n.data && n.data.localPath) || '';
          n.data.localPath = ${JSON.stringify(p)};
          app.closeAllFloatDetail(); app.showDetail(n);
          var el = document.querySelector('.fd-localpath-link');
          if (!el) { n.data.localPath = window.__lpBackup; return { ok: false }; }
          var b = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: Math.round(b.left + 3), clientY: Math.round(b.top + 3) }));
          var menu = document.getElementById('ctx-menu');
          var items = menu ? Array.prototype.slice.call(menu.querySelectorAll('.ctx-item')) : [];
          var hit = null;
          for (var i = 0; i < items.length; i++) {
            if (items[i].textContent === '在文件资源管理器中打开') { hit = items[i]; break; }
          }
          if (hit) hit.click();
          await new Promise(function (res) { setTimeout(res, 260); });
          n.data.localPath = window.__lpBackup;
          app.closeAllFloatDetail();
          return { ok: true, clicked: !!hit };
        })()`);
        return out;
      };
      try {
        ctx.openFileLogClear();
        const f = await clickRevealWith(projFile);
        const ledF = ctx.openFileLog();
        const fileLed = ledF[ledF.length - 1] || {};
        const fileOk = f.clicked === true && reveal.calls.length === 1 && reveal.calls[0] === projFile
          && openSpy.calls.length === 0
          && fileLed.showItemInFolder === true && fileLed.openPath === false
          && fileLed.via === 'reveal' && fileLed.isDir === false;

        const d = await clickRevealWith(dir);
        const ledD = ctx.openFileLog();
        const dirLed = ledD[ledD.length - 1] || {};
        const dirOk = d.clicked === true && openSpy.calls.length === 1 && openSpy.calls[0] === dir
          && reveal.calls.length === 1                       // 目录**不许**再加一次"定位"
          && dirLed.openPath === true && dirLed.showItemInFolder === false
          && dirLed.via === 'openPath' && dirLed.isDir === true;
        return {
          ok: fileOk && dirOk,
          text: '文件：showItemInFolder 调用 ' + reveal.calls.length + ' 次（参数='
            + JSON.stringify(String(reveal.calls[0] || '').slice(-24)) + '）· openPath ' + (fileOk ? '0 次 ✓' : '被调了 ✗')
            + ' · 账 via=' + JSON.stringify(fileLed.via) + '（showItemInFolder=' + fileLed.showItemInFolder
            + ' openPath=' + fileLed.openPath + '）⇒ ' + fileOk
            + ' ｜ 目录：openPath 调用 ' + openSpy.calls.length + ' 次（参数='
            + JSON.stringify(String(openSpy.calls[0] || '').slice(-24)) + '）· 账 via=' + JSON.stringify(dirLed.via)
            + '（openPath=' + dirLed.openPath + ' showItemInFolder=' + dirLed.showItemInFolder + '）⇒ ' + dirOk
            + '｜"文件也去 openPath"就是拿"打开文件"冒充"定位它" ✗'
        };
      } finally { resetImpl(ctx); }
    }
  },

  {
    name: '本机链接：①打开 与左键**同一条实现**（同一路径、同一 mode、出口账逐字段相同）',
    run: async (ctx) => {
      if (!ctx.openImpl) return { ok: false, text: '采不到真值：冒烟底座没有 ctx.openImpl ⇒ 判红' };
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const spy = openPathSpy(ctx, '');
      try {
        // 甲：左键点链接
        ctx.openFileLogClear();
        await ctx.exec(`(async () => {
          var app = window.MMApp, jm = app.getState().jm;
          var n = jm.get_node('${NODE}');
          window.__lpBackup = (n.data && n.data.localPath) || '';
          n.data.localPath = ${JSON.stringify(projFile)};
          app.closeAllFloatDetail(); app.showDetail(n);
          var el = document.querySelector('.fd-localpath-link');
          if (el) el.click();
          await new Promise(function (res) { setTimeout(res, 300); });
          n.data.localPath = window.__lpBackup;
          app.closeAllFloatDetail();
        })()`);
        const a = (ctx.openFileLog() || []).slice(-1)[0] || {};
        // 乙：右键 → 「打开」
        ctx.openFileLogClear();
        await ctx.exec(`(async () => {
          var app = window.MMApp, jm = app.getState().jm;
          var n = jm.get_node('${NODE}');
          window.__lpBackup = (n.data && n.data.localPath) || '';
          n.data.localPath = ${JSON.stringify(projFile)};
          app.closeAllFloatDetail(); app.showDetail(n);
          var el = document.querySelector('.fd-localpath-link');
          if (!el) { n.data.localPath = window.__lpBackup; return; }
          var b = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: Math.round(b.left + 3), clientY: Math.round(b.top + 3) }));
          var menu = document.getElementById('ctx-menu');
          var items = menu ? Array.prototype.slice.call(menu.querySelectorAll('.ctx-item')) : [];
          var hit = null;
          for (var i = 0; i < items.length; i++) if (items[i].textContent === '打开') { hit = items[i]; break; }
          if (hit) hit.click();
          await new Promise(function (res) { setTimeout(res, 300); });
          n.data.localPath = window.__lpBackup;
          app.closeAllFloatDetail();
        })()`);
        const b = (ctx.openFileLog() || []).slice(-1)[0] || {};
        const keys = ['abs', 'kind', 'openMode', 'via', 'openPath', 'showItemInFolder', 'isDir', 'exec'];
        const same = keys.every((k) => a[k] === b[k]);
        return {
          ok: spy.calls.length === 2 && spy.calls[0] === spy.calls[1] && same
            && a.via === 'openPath' && b.via === 'openPath',
          text: '左键: ' + JSON.stringify({ mode: a.openMode, via: a.via, exec: a.exec })
            + ' ｜ 右键①: ' + JSON.stringify({ mode: b.openMode, via: b.via, exec: b.exec })
            + ' · 同一路径被同一执行器接了 ' + spy.calls.length + ' 次 · 逐字段相同=' + same
            + (same ? '' : '｜⚠️ 两处不是同一条实现（同一件事有两份 ✗）')
        };
      } finally { resetImpl(ctx); }
    }
  },

  {
    name: '本机链接：④取消链接 ⇒ `localPath` 从**数据**里没了（落盘后读盘确认）+ 界面那条链接消失',
    run: async (ctx) => {
      // ① 用 CLI 把字段写进去（既有写通道），② 界面重开项目读到它，③ 点「取消链接」，
      // ④ **读盘**确认字段真的没了（只清界面不清数据 = 下次重开又回来 ✗）
      const projFile = await ctx.exec('window.MMApp.getState().project.file');
      const dir = path.dirname(projFile);
      const set = cli(ctx, ['edit', 'comnet', NODE, '--local-path', dir]);
      await ctx.exec('window.MMApp.openProject("comnet")');
      await ctx.exec(settle);
      const before = findNode(projFile, NODE);
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp, jm = app.getState().jm;
        app.closeAllFloatDetail(); app.showDetail(jm.get_node('${NODE}'));
        var el = document.querySelector('.fd-localpath-link');
        if (!el) return { ok: false, why: '没有链接（前置没成立）' };
        var b = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          clientX: Math.round(b.left + 3), clientY: Math.round(b.top + 3) }));
        var menu = document.getElementById('ctx-menu');
        var items = menu ? Array.prototype.slice.call(menu.querySelectorAll('.ctx-item')) : [];
        var hit = null;
        for (var i = 0; i < items.length; i++) if (items[i].textContent === '取消链接') { hit = items[i]; break; }
        if (hit) hit.click();
        await new Promise(function (res) { setTimeout(res, 900); });   // 内含一次 save()（既有写通道）
        var still = document.querySelector('.fd-localpath-link');
        var n = jm.get_node('${NODE}');
        var st = document.querySelector('#status-text');
        return { ok: true, clicked: !!hit, linkGone: !still,
          inData: (n && n.data && n.data.localPath) || '', status: st ? st.textContent : '' };
      })()`);
      const after = findNode(projFile, NODE);
      const onDiskGone = !!after && after.localPath === undefined;
      return {
        ok: set.ok === true && !!before && before.localPath === dir && r.clicked === true
          && r.linkGone === true && r.inData === '' && onDiskGone === true,
        text: 'CLI 先设=' + set.ok + '（盘上原有=' + JSON.stringify(before && before.localPath) + '）'
          + ' · 点了「取消链接」=' + r.clicked
          + ' · 界面那条链接消失=' + r.linkGone + ' · 内存里字段=' + JSON.stringify(r.inData)
          + ' · **盘上字段已删=' + onDiskGone + '**'
          + (onDiskGone ? '' : '｜⚠️ 只清了界面/内存，数据里还在 ⇒ 下次重开又回来 ✗')
          + ' · 状态栏=' + JSON.stringify(String(r.status).slice(0, 60))
      };
    }
  }
];

module.exports = assertions;
