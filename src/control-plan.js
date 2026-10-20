/* ============================================================
 * src/control-plan.js —— 界面控制通道的**视图动作规划器**（功能代号 `AP` · 台账 `W21`）
 * ------------------------------------------------------------
 * 职责只有一个：把一条 `point` 命令（`{mode, project, node}`）规划成
 * **「要在渲染层跑的那段 JS」**，让 `main.js` 那边只剩三行（取 plan → `executeJavaScript` → 回执）。
 *
 * ## 为什么单独一个文件（这条理由比代码本身重要）
 *   这段规划**只给主进程用**（`main.js` 的 `startControlChannel`），**任何 CLI 命令都不用**。
 *   它一开始写在 `src/control.js` 里，结果撞上一条真不变量并被判红（2026-10-20 实测）：
 *   `tests/cli-sync-invariant.test.js` 会沿 `cli/commands/*` 的 `require` 闭包收集文件，并禁掉
 *   `await` / `.then(` / `fs.promises` / `setTimeout` / `process.nextTick` —— 因为
 *   `cli/main.js` 的 `invokeSync` 依赖"命令体同步完成"。而本文件生成的 JS **必须**用
 *   `.then(ok, bad)` 接住 `MM.showRelated()` 的 promise（`related` 档是异步的），于是那个字符串
 *   被闭包扫描抓到（`src/control.js:273 出现 .then()`）。
 *   ⇒ **正确的修法不是把那段字符串改写成扫不出来的样子**（那是绕门禁），而是承认职责边界：
 *   "命令名白名单"（CLI 与界面共用）留在 `src/control.js`；"给渲染层的规划"搬到本文件，
 *   于是它**不在** CLI 的闭包里，那条不变量回到它本来要守的东西上。
 *   `tests/control-point.test.js` 的 F4 把这条边界钉死（`cli/commands/ui.js` 不许 require 本文件）。
 *
 * ## 三条不变量（写在**规划出来的 JS** 里，不是靠注释约定）
 *   ① **不写盘**：只调两个既有的只读渲染层函数（`MM.jumpToNode` / `MM.showRelated`），
 *      不碰 `projects/**`、不触发保存；
 *   ② **不切项目**：界面当前打开的项目与点名的不一致就**响亮拒绝并点名两个项目名** ——
 *      切项目会丢掉界面上未保存的编辑（`renderer/app-audit.js` 里那条真实事故），
 *      而且"AI 悄悄换了人正在看的项目"本身就不可接受；
 *   ③ **失败要能说清是哪一种**：导图页被卸载（`window.MM` 不在）/ 没开项目 / 项目不对 /
 *      节点不在视图里 / 界面版本缺那个函数 —— 各给不同的 reason，绝不给一句"失败了"。
 *
 * ## 注入面（本功能唯一的安全要害）
 *   项目名与节点 id 来自调用方（AI 的字符串），会被嵌进 JS **源码** ⇒ 一律 `JSON.stringify` 转义，
 *   且本模块**绝不**接受"调用方给的 JS"（没有 `--js` / `--eval` 这类口子）。
 *   判据不是"看代码像安全"：`tests/control-point.test.js` 拿一个**假渲染层**在 `vm` 里真跑生成的
 *   JS，喂 `"); global.pwned = 1; //` 这样的 id，断言假渲染层收到的 id 逐字相同、且没有副作用。
 *
 * ## UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3）
 *   本模块**零依赖**（不 require 任何东西）⇒ 浏览器端拿到的是同一份实现；它只在
 *   `Boolean/Promise/String/JSON` 这些双端都存在的东西上工作。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MMControlPlan = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** `point` 认的视图取值（**封闭表**；与 `src/control.js` 的 `POINT_MODES` 是同一份语义，
   *  这里再导出一次只是为了让本模块**零依赖**（不 require control.js ⇒ 也就不会被那条
   *  "CLI 闭包里不许有异步 API" 的扫描牵连到别的文件）。两处一致性由 `tests/control-point.test.js`
   *  的 A3/F4 组机械核对（值必须逐字相同）。 */
  const POINT_MODES = Object.freeze(['note', 'related']);

  /**
   * 把一条 `point` 命令规划成"在渲染层跑的那段 JS"（纯函数、无 IO ⇒ 可单测，`vm` 里能真跑）。
   *
   * @param {{mode?:string, project?:string, node?:string}} cmd
   * @returns {{ok:true, mode:string, project:string, node:string, js:string}|{ok:false, reason:string}}
   */
  function planPointAction(cmd) {
    const c = cmd || {};
    const mode = String(c.mode == null || c.mode === '' ? 'note' : c.mode);
    if (POINT_MODES.indexOf(mode) < 0) {
      return { ok: false, reason: '界面不认识的视图: ' + mode + '（这个版本支持：' + POINT_MODES.join(' / ') + '）' };
    }
    const project = String(c.project == null ? '' : c.project);
    const node = String(c.node == null ? '' : c.node);
    if (!project) return { ok: false, reason: '这条 cmd 必须带 project（视图动作只作用于界面当前打开的那个项目）' };
    if (!node) return { ok: false, reason: '这条 cmd 必须带 node（要指给你看的那篇笔记的节点 id）' };
    // 三个取值全部在这里**串行化一次**（下面那段 JS 里只出现这三个已转义的常量）
    const P = JSON.stringify(project);
    const N = JSON.stringify(node);
    const M = JSON.stringify(mode);
    const js = [
      '(function () {',
      '  try {',
      '    var MM = window.MM;',
      '    if (!MM) return { ok: false, reason: "界面没有加载导图页（window.MM 不在：可能正处于 sidebar-only on 的占位页）—— '
        + '先 sidebar-only off 恢复导图页再重试" };',
      '    var st = MM.getState ? MM.getState() : null;',
      '    var cur = (st && st.project) ? String(st.project.name) : null;',
      '    if (!cur) return { ok: false, reason: "界面还没有打开任何项目" };',
      '    if (cur !== ' + P + ') return { ok: false, reason: "界面当前打开的是「" + cur + "」，不是「" + ' + P
        + ' + "」——这条命令不改项目（切项目会丢界面上的未保存编辑）：请在界面上切到它，或人手动点" };',
      '    var jm = st.jm;',
      '    var ad = MM.adapter;',
      '    var target = (ad && ad.getNode) ? ad.getNode(jm, ' + N + ') : null;',
      '    if (!target) return { ok: false, reason: "节点不在当前视图里: " + ' + N + ' };',
      '    var topic = String(target.topic == null ? "" : target.topic);',
      '    if (' + M + ' === "related") {',
      '      if (!MM.showRelated) return { ok: false, reason: "这个界面版本没有关联视图（MM.showRelated 未加载）" };',
      '      var p = MM.showRelated(' + N + ');',
      '      if (!p || typeof p.then !== "function") return { ok: false, reason: "关联视图没有返回结果（界面版本不对？）" };',
      '      var ok = function (r) {',
      '        if (!r) return { ok: false, reason: "关联视图没有打开（界面拒绝了：窗口桥可能没接上）" };',
      '        return { ok: true, mode: "related", project: cur, node: ' + N + ', topic: topic,',
      '          members: (r.members || []).length, drawn: r.drawn || 0, empty: !!r.empty,',
      '          crossProject: r.crossProject || 0, unrendered: r.unrendered || 0, assocCount: r.assocCount || 0 };',
      '      };',
      '      var bad = function (e) { return { ok: false, reason: "关联视图抛错：" + ((e && e.message) || e) }; };',
      '      return p.then(ok, bad);',
      '    }',
      '    if (!MM.jumpToNode) return { ok: false, reason: "这个界面版本没有跳转实现（MM.jumpToNode 未加载）" };',
      '    MM.jumpToNode(' + N + ');',
      '    var sel = (ad && ad.getSelected) ? ad.getSelected(jm) : null;',
      '    return { ok: true, mode: "note", project: cur, node: ' + N + ', topic: topic,',
      '      selected: !!(sel && String(sel.id) === ' + N + ') };',
      '  } catch (e) {',
      '    return { ok: false, reason: "界面执行出错：" + ((e && e.message) || e) };',
      '  }',
      '})()'
    ].join('\n');
    return { ok: true, mode: mode, project: project, node: node, js: js };
  }

  return { POINT_MODES, planPointAction };
});
